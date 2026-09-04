import {
  type MessageMeta,
  POLL_INTERVAL_MS,
  type PendingMessage,
  REALTIME_POLL_INTERVAL_MS,
  deleteSignatureStatement,
  messageSignatureStatement,
} from "@sendself/shared";
import { ApiError, type Auth, api } from "../api/client";
import { decryptFile, decryptJson, decryptName, decryptText } from "../crypto/crypto";
import { type DeviceIdentities, loadIdentities, verifyDeviceSignature } from "../crypto/identity";
import { type Keyring, keyForEpoch } from "../crypto/keyring";
import { loadDeletions } from "../db/deletions";
import { activeSpace, putFile } from "../db/store";
import { reconcileRoster } from "../state/events";
import {
  applyGlobalDeletion,
  applyMessageUpdate,
  getLocalMessage,
  upsertMessage,
} from "../state/messages";
import {
  applyKeyring,
  authHeaders,
  deviceKeyPair,
  keyring,
  session,
  sessionRevoked,
} from "../state/session";
import { showToast } from "../state/ui";
import type { FileRef, LocalMessage } from "../types";
import { requestBackgroundSync, requestImmediateWorkerFlush } from "./background";
import { type OutboxUpdateBroadcast, flushQueuedOutbox } from "./outbox";
import { ensureRealtime, realtimeConnected, startRealtime, stopRealtime } from "./realtime";
import { DeviceKeyMismatchError, adoptPendingKeys, rotateGroupKey } from "./rekey";
import { syncSpaceName } from "./spaceName";

/**
 * The metadata envelope is decrypted for *any* message that carries one, not
 * only for one with a file: it is where the album grouping and the view-once
 * flag live, and a text-only message can have both.
 */
async function decryptMeta(
  key: CryptoKey,
  pendingMessage: PendingMessage,
): Promise<MessageMeta | undefined> {
  if (!pendingMessage.fileMeta || !pendingMessage.fileMetaIv) return undefined;
  return decryptJson<MessageMeta>(
    key,
    pendingMessage.fileMeta,
    pendingMessage.fileMetaIv,
    `meta:${pendingMessage.id}`,
  );
}

/**
 * How many incoming files are fetched at once. Bounded because each download
 * holds its full ciphertext + plaintext (up to 50 MB each) in memory while
 * decrypting.
 */
const MAX_PARALLEL_DOWNLOADS = 4;

/**
 * A decrypt failure is almost always permanent (tampered/poisoned ciphertext
 * fails identically forever), but a handful of retries is cheap insurance
 * against one-off corruption (e.g. a truncated download). Past this budget the
 * message is marked corrupted and ACKED, so a hostile or buggy server can't
 * make us re-download up to 50 MB every poll for 24 h. The counter lives in
 * memory: giving up is persisted through the ack itself (the message stops
 * being pending), so a reload can only ever re-spend the budget, not undo it.
 */
const MAX_DECRYPT_ATTEMPTS = 3;
const decryptAttempts = new Map<string, number>();

/** Record one failed decrypt for `scope`; true when the budget is exhausted. */
function decryptBudgetExhausted(scope: string): boolean {
  const attempts = (decryptAttempts.get(scope) ?? 0) + 1;
  if (attempts >= MAX_DECRYPT_ATTEMPTS) {
    decryptAttempts.delete(scope);
    return true;
  }
  decryptAttempts.set(scope, attempts);
  return false;
}

let timer: ReturnType<typeof setInterval> | null = null;
/** The cadence `timer` is currently running at, so it is only rebuilt on a change. */
let timerInterval = 0;
let running = false;
/** A pinned device key changed: warn once, not on every poll. */
let keyMismatchReported = false;
let outboxAbortController: AbortController | null = null;
const onFocus = (): void => {
  // A backgrounded socket is often killed without a close frame, so coming back
  // is exactly when to check rather than wait for the next ping to time out.
  ensureRealtime();
  void syncNow();
};
const onVisibilityChange = (): void => {
  if (document.visibilityState === "hidden") handOffOutboxToServiceWorker();
};
const onPageHide = (): void => handOffOutboxToServiceWorker();

function handOffOutboxToServiceWorker(): void {
  // Abort fetch + its retry delays, then register Background Sync. Once the
  // page releases the cross-context lock, the service worker resumes the same
  // persisted item (and the rest of the batch) from IndexedDB.
  outboxAbortController?.abort();
  requestImmediateWorkerFlush();
  void requestBackgroundSync();
}

export function startSync(): void {
  stopSync();
  void syncNow();
  setPollInterval(POLL_INTERVAL_MS);
  // Real-time delivery is a *hint*: it collapses latency from seconds to
  // milliseconds and lets the poll slow to a safety net, but the poll is what
  // still guarantees delivery when a notification is dropped or the socket dies
  // quietly.
  try {
    startRealtime(authHeaders(), () => void syncNow());
  } catch {
    // No session yet: polling alone is correct until there is one.
  }
  window.addEventListener("focus", onFocus);
  window.addEventListener("online", onFocus);
  document.addEventListener("visibilitychange", onVisibilityChange);
  window.addEventListener("pagehide", onPageHide);
}

export function stopSync(): void {
  if (timer) clearInterval(timer);
  timer = null;
  timerInterval = 0;
  stopRealtime();
  window.removeEventListener("focus", onFocus);
  window.removeEventListener("online", onFocus);
  document.removeEventListener("visibilitychange", onVisibilityChange);
  window.removeEventListener("pagehide", onPageHide);
  outboxAbortController?.abort();
  outboxAbortController = null;
}

/**
 * Poll at `interval`, rebuilding the timer only when the cadence actually
 * changes — every sync pass calls this, and resetting the interval each time
 * would keep pushing the next tick away.
 */
function setPollInterval(interval: number): void {
  if (timerInterval === interval) return;
  if (timer) clearInterval(timer);
  timerInterval = interval;
  timer = setInterval(() => void syncNow(), interval);
}

/** Run one sync pass, skipping if one is already in flight. */
export async function syncNow(): Promise<void> {
  if (running) return;
  const currentSession = session.value;
  let ring = keyring.value;
  if (!currentSession || !ring) return;
  // The polling timer is already stopped when this flips, but syncNow is also
  // called directly (outbox flush, retries) and must not revive a dead session.
  if (sessionRevoked.value) return;

  running = true;
  try {
    const auth = authHeaders();
    // While the socket is up the poll is only a backstop; when it is down it is
    // the delivery mechanism again.
    setPollInterval(realtimeConnected() ? REALTIME_POLL_INTERVAL_MS : POLL_INTERVAL_MS);

    // Outbox flush is shared with the service worker (sync/outbox.ts); it
    // persists every state change itself, so only the signal needs updating.
    const flushed = await flushOutbox();

    const { messages: pending, keys, rotationPending, spaceName } = await api.pendingMessages(auth);

    // Adopt any rotated key before touching messages: content sent after a
    // rotation is encrypted with an epoch this device may be seeing for the
    // first time right now.
    const before = ring.current;
    ring = await adoptKeys(ring, keys, currentSession.groupId, currentSession.deviceId, auth);

    // A revocation is still owed its rotation. Every device that polls tries,
    // and the server's compare-and-swap picks exactly one winner, so the work
    // is never stranded on the device that happened to press "Revoke".
    if (rotationPending) {
      ring = await completeDueRotation(ring, currentSession.groupId, currentSession.deviceId, auth);
    }

    // A send rejected as `key_rotated` was queued again with its pinned epoch
    // cleared; now that the new key is here, get it out without waiting a tick.
    if (flushed.remaining > 0 && ring.current !== before) await flushOutbox();

    // The space's name is reconciled after the keys, since reading (or
    // re-sealing) it can depend on an epoch this pass has just adopted.
    await syncSpaceName(spaceName, ring);

    // First register every incoming message (decrypt just the metadata) so
    // all bubbles appear at once, then fetch the attachments concurrently
    // instead of one after another.
    const identities = await senderIdentities(pending, currentSession.groupId, auth);
    // What has already been deleted for everyone, so a copy that was in flight
    // when the deletion happened is dropped instead of reappearing.
    const deletions = await loadDeletions();

    const registered: LocalMessage[] = [];
    for (const pendingMessage of pending) {
      try {
        if (pendingMessage.deletesMessageId) {
          await applyIncomingDeletion(pendingMessage, identities, currentSession.groupId, auth);
          continue;
        }
        if (deletions[pendingMessage.id]) {
          // Deleted here while this copy was still on its way. Ack it so the
          // server stops offering it (and drops it) rather than re-downloading
          // content the user has already destroyed.
          await api.ackMessage(pendingMessage.id, auth);
          continue;
        }
        registered.push(
          await registerIncoming(pendingMessage, ring, identities, currentSession.groupId),
        );
      } catch {
        // Leave it pending; the next poll will retry.
      }
    }

    const adopted = ring;
    await runWithConcurrency(registered, MAX_PARALLEL_DOWNLOADS, async (local) => {
      try {
        await downloadAndAck(local, adopted, auth);
      } catch {
        // Leave it pending; the next poll will retry.
      }
    });
  } catch {
    // Network/transient errors are silently retried on the next tick.
  } finally {
    outboxAbortController = null;
    running = false;
  }
}

async function flushOutbox(): Promise<{ remaining: number }> {
  const controller = new AbortController();
  outboxAbortController = controller;
  const flushed = await flushQueuedOutbox(applyMessageUpdate, { signal: controller.signal });
  if (outboxAbortController === controller) outboxAbortController = null;
  if (flushed.remaining > 0) {
    // Couldn't send everything (offline/flaky network): let the browser
    // retry from the service worker even if the app gets closed.
    void requestBackgroundSync();
  }
  return flushed;
}

/** Adopt keys delivered while this device was away, then mirror them into the UI. */
async function adoptKeys(
  ring: Keyring,
  keys: Awaited<ReturnType<typeof api.pendingMessages>>["keys"],
  groupId: string,
  deviceId: string,
  auth: Auth,
): Promise<Keyring> {
  const privateKey = deviceKeyPair.value?.privateKey;
  if (keys.length === 0 || !privateKey) return ring;
  const updated = await adoptPendingKeys(ring, keys, privateKey, groupId, deviceId, auth);
  applyKeyring(updated);
  return updated;
}

async function completeDueRotation(
  ring: Keyring,
  groupId: string,
  deviceId: string,
  auth: Auth,
): Promise<Keyring> {
  try {
    const rotated = await rotateGroupKey(ring, groupId, deviceId, auth);
    if (!rotated) return ring;
    applyKeyring(rotated.keyring);
    return rotated.keyring;
  } catch (error) {
    // A swapped device key is the one rotation failure the user has to know
    // about: it means something is trying to be handed the new key. Said once,
    // not on every poll — the condition persists until it is dealt with.
    if (error instanceof DeviceKeyMismatchError && !keyMismatchReported) {
      keyMismatchReported = true;
      showToast(error.message, "error");
    }
    return ring;
  }
}

// When the service worker flushes the outbox in the background while the app
// is (still or again) open, mirror its persisted updates into the signal so
// bubbles flip from "uploading" to "sent" live.
if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
  navigator.serviceWorker.addEventListener("message", (event: MessageEvent) => {
    const data = event.data as Partial<OutboxUpdateBroadcast> | null;
    if (data?.type !== "outbox-message-updated" || !data.message) return;
    // The worker flushes every space; only the open one is on screen.
    if (data.spaceId !== activeSpace()) return;
    applyMessageUpdate(data.message);
  });
}

/**
 * The keys to verify this batch's senders against, refreshing the roster when
 * one of them is a device we have never heard of.
 *
 * That refresh is the only extra request signing adds to the hot path, and it
 * happens exactly once per newly-added device — the alternative (verifying
 * against a stale local view) would report a brand-new device's first message
 * as unverified for no reason.
 */
async function senderIdentities(
  pending: readonly PendingMessage[],
  groupId: string,
  auth: Auth,
): Promise<DeviceIdentities> {
  const identities = await loadIdentities();
  if (pending.every((message) => identities[message.senderDeviceId])) return identities;
  try {
    const listing = await api.listDevices(auth);
    await reconcileRoster(listing.devices, groupId);
    return await loadIdentities();
  } catch {
    // Offline or rate-limited: fall back to what we hold. Unknown senders come
    // out as "unverified", which is silent, and the next pass tries again.
    return identities;
  }
}

/** Run `fn` over `items`, keeping at most `limit` invocations in flight. */
async function runWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      await fn(items[next++]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/** A forged deletion is worth saying out loud, but only once per session. */
let forgedDeletionReported = false;

/**
 * Apply another device's "delete for everyone".
 *
 * The signature is checked *before* anything is destroyed, and against the
 * delete-specific statement, so neither the server nor anyone holding a
 * captured message signature can order history erased. `unverified` is still
 * accepted — it means we hold no signing key for that device at all, exactly
 * the case where its ordinary messages are accepted too — but `invalid` (we
 * hold its key and the signature does not match) is refused outright.
 *
 * Acked either way: the verdict is a pure function of bytes that never change,
 * so leaving it pending would re-run the same decision on every poll for a day.
 */
async function applyIncomingDeletion(
  pendingMessage: PendingMessage,
  identities: DeviceIdentities,
  groupId: string,
  auth: Auth,
): Promise<void> {
  const deletesMessageId = pendingMessage.deletesMessageId!;
  const verdict = await verifyDeviceSignature(
    identities,
    pendingMessage.senderDeviceId,
    deleteSignatureStatement({
      groupId,
      messageId: pendingMessage.id,
      senderDeviceId: pendingMessage.senderDeviceId,
      keyEpoch: pendingMessage.keyEpoch,
      deletesMessageId,
    }),
    pendingMessage.signature,
  );

  if (verdict === "invalid") {
    if (!forgedDeletionReported) {
      forgedDeletionReported = true;
      showToast("Ignored a delete request that wasn't signed by one of your devices", "error");
    }
  } else {
    await applyGlobalDeletion(deletesMessageId);
  }

  await api.ackMessage(pendingMessage.id, auth);
}

/**
 * Decrypt an incoming message's metadata and persist it locally (without
 * downloading its file yet), so it shows up in the UI immediately.
 */
async function registerIncoming(
  pendingMessage: PendingMessage,
  ring: Keyring,
  identities: DeviceIdentities,
  groupId: string,
): Promise<LocalMessage> {
  let local = getLocalMessage(pendingMessage.id);

  if (!local) {
    // Not holding the epoch yet is transient, not corruption: the key is on
    // its way through the same channel. Throwing here leaves the message
    // pending for the next pass without spending any decrypt budget.
    const key = keyForEpoch(ring, pendingMessage.keyEpoch);
    if (!key) throw new Error(`No GroupKey for epoch ${pendingMessage.keyEpoch}`);

    // Decrypt failures here are permanent for a given ciphertext, so retrying
    // forever just burns CPU every poll. Below the retry budget we rethrow
    // (leave pending, retry next pass); past it the payload is dropped and the
    // message registered as corrupted so it gets acked and stops coming back.
    let corrupted = false;

    let text: string | undefined;
    if (pendingMessage.encryptedPayload && pendingMessage.iv) {
      try {
        text = await decryptText(
          key,
          pendingMessage.encryptedPayload,
          pendingMessage.iv,
          `text:${pendingMessage.id}`,
        );
        decryptAttempts.delete(`text:${pendingMessage.id}`);
      } catch (error) {
        if (!decryptBudgetExhausted(`text:${pendingMessage.id}`)) throw error;
        corrupted = true;
      }
    }

    let file: FileRef | undefined;
    let batch: LocalMessage["batch"];
    let viewOnce: true | undefined;
    if (pendingMessage.fileMeta && pendingMessage.fileMetaIv) {
      try {
        const meta = await decryptMeta(key, pendingMessage);
        if (meta) {
          if (pendingMessage.fileR2Key && pendingMessage.fileIv) {
            file = {
              r2Key: pendingMessage.fileR2Key,
              iv: pendingMessage.fileIv,
              // Written by an older build, or by a sender that lied: an
              // attachment with no name is still worth showing, so it falls
              // back rather than being dropped along with the message.
              name: meta.name ?? "file",
              size: meta.size ?? 0,
              mime: meta.mime ?? "application/octet-stream",
            };
          }
          if (meta.batchId !== undefined) {
            batch = {
              id: meta.batchId,
              index: meta.batchIndex ?? 0,
              count: meta.batchCount ?? 1,
            };
          }
          if (meta.viewOnce) viewOnce = true;
        }
        decryptAttempts.delete(`meta:${pendingMessage.id}`);
      } catch (error) {
        if (!decryptBudgetExhausted(`meta:${pendingMessage.id}`)) throw error;
        corrupted = true; // unusable metadata: the file is dropped with it
      }
    }

    // The sender's name was encrypted when that device joined, so it can be
    // several epochs older than the message itself.
    const nameKey =
      pendingMessage.senderNameEpoch === null
        ? undefined
        : keyForEpoch(ring, pendingMessage.senderNameEpoch);
    const senderDeviceName =
      nameKey && pendingMessage.senderNameEnc && pendingMessage.senderNameIv
        ? await decryptName(
            nameKey,
            pendingMessage.senderNameEnc,
            pendingMessage.senderNameIv,
            pendingMessage.senderDeviceId,
          ).catch(() => pendingMessage.senderDeviceId)
        : pendingMessage.senderDeviceId;

    // Who really sent this. The signature covers the sender id and every
    // ciphertext, so a server that re-attributes a message or swaps its payload
    // cannot produce one that checks out. Verified before the message is
    // persisted, so the verdict is part of local history rather than something
    // recomputed (and possibly lost) later.
    const senderVerified = await verifyDeviceSignature(
      identities,
      pendingMessage.senderDeviceId,
      messageSignatureStatement({
        groupId,
        messageId: pendingMessage.id,
        senderDeviceId: pendingMessage.senderDeviceId,
        keyEpoch: pendingMessage.keyEpoch,
        encryptedPayload: pendingMessage.encryptedPayload,
        iv: pendingMessage.iv,
        fileR2Key: pendingMessage.fileR2Key,
        fileIv: pendingMessage.fileIv,
        fileMeta: pendingMessage.fileMeta,
        fileMetaIv: pendingMessage.fileMetaIv,
      }),
      pendingMessage.signature,
    );

    local = {
      id: pendingMessage.id,
      direction: "in",
      keyEpoch: pendingMessage.keyEpoch,
      senderDeviceId: pendingMessage.senderDeviceId,
      senderDeviceName,
      senderVerified,
      text,
      file,
      batch,
      viewOnce,
      createdAt: pendingMessage.createdAt,
      status: "sent",
      fileState: file ? "remote" : undefined,
      corrupted: corrupted || undefined,
      acked: false,
    };
    await upsertMessage(local);
  }

  return local;
}

/**
 * Download + decrypt a registered message's file (if any), then ack it. For
 * file messages we only confirm receipt (ack) AFTER a successful download +
 * decrypt, so the server never deletes a file we haven't received.
 */
async function downloadAndAck(message: LocalMessage, ring: Keyring, auth: Auth): Promise<void> {
  let local = message;
  const file = local.file;

  if (file && needsDownload(local.fileState)) {
    // Registered under an epoch we somehow no longer hold: transient, retry.
    const key = local.keyEpoch === undefined ? undefined : keyForEpoch(ring, local.keyEpoch);
    if (!key) throw new Error(`No GroupKey for epoch ${local.keyEpoch}`);

    await upsertMessage({ ...local, fileState: "downloading" });

    let ciphertext: ArrayBuffer;
    try {
      ciphertext = await api.downloadFile(file.r2Key, auth);
    } catch (error) {
      if (error instanceof ApiError && error.code === "not_found") {
        // The blob is gone server-side (TTL/cleanup) and will never come
        // back; record that and fall through to the ack so the message
        // stops being re-polled.
        local = { ...local, fileState: "expired" };
        await upsertMessage(local);
      } else {
        await upsertMessage({ ...local, fileState: "error" });
        return; // transient (network/5xx): do not ack; retry next pass
      }
    }

    if (local.fileState !== "expired") {
      let plaintext: ArrayBuffer;
      try {
        plaintext = await decryptFile(key, ciphertext!, file.iv, `file:${local.id}`);
        decryptAttempts.delete(`file:${local.id}`);
      } catch (error) {
        if (!decryptBudgetExhausted(`file:${local.id}`)) {
          await upsertMessage({ ...local, fileState: "error" });
          return; // do not ack; retry next pass
        }
        // Poisoned ciphertext: give up and fall through to the ack, so we
        // stop re-downloading up to 50 MB on every poll until the TTL.
        local = { ...local, fileState: "corrupted" };
        await upsertMessage(local);
      }

      if (local.fileState !== "corrupted") {
        try {
          await putFile(file.r2Key, new Blob([plaintext!], { type: file.mime }));
        } catch {
          // Local storage failure (quota, …) is transient, unlike a decrypt
          // failure — never spend the decrypt budget or ack on it.
          await upsertMessage({ ...local, fileState: "error" });
          return;
        }
        local = { ...local, fileState: "downloaded" };
        await upsertMessage(local);
      }
    }
  }

  if (!local.acked) {
    await api.ackMessage(local.id, auth);
    await upsertMessage({ ...local, acked: true });
  }
}

/** File states that still want a download attempt on this pass. */
function needsDownload(state: LocalMessage["fileState"]): boolean {
  return state === "remote" || state === "downloading" || state === "error";
}
