import { createNote, saveFilesToVault } from "../state/vaultItems";
import { downloadBlob } from "../share/download";
import { readMessageFile } from "../share/attachments";
import { api } from "../api/client";
import { randomId } from "@sendself/client/crypto";
import { knownDeviceIds } from "../crypto/identity";
import { recordDeletion } from "../db/deletions";
import { putOutgoingFileMessages } from "../db/store";
import { copyImageBlob, canCopyImages } from "../share/clipboard-image";
import { clearComposer, composerDraft, stagedFiles, viewOnceArmed } from "../state/composer";
import { trackPromoStep } from "../promo";
import {
  applyGlobalDeletion,
  applyMessageUpdate,
  discardMessage,
  failedSends,
  upsertMessage,
} from "../state/messages";
import { authHeaders, keyring, session } from "../state/session";
import { activeSpace } from "../state/spaces";
import { copyText, showToast } from "../state/ui";
import { backgroundSyncSupported, requestBackgroundSync } from "../sync/background";
import { syncNow } from "../sync/sync";
import type { LocalMessage } from "../types";

// ---------------------------------------------------------------------------
// Messaging
// ---------------------------------------------------------------------------

/**
 * Kick the queued send on its way: flush immediately from the page and, where
 * supported, register a background sync so the service worker finishes the
 * job even if the app is closed before the upload completes.
 */
function scheduleOutboxFlush(): void {
  void syncNow();
  void requestBackgroundSync();
}

/** Everything one press of the send button turns into messages. */
export interface ComposerContent {
  text?: string;
  files?: readonly File[];
  viewOnce?: boolean;
}

/**
 * Send whatever the composer is holding.
 *
 * One entry point for text, files and both together, replacing the separate
 * `sendTextMessage`/`sendFileMessages` that could not produce a message
 * carrying both — even though the wire format has always allowed it (a
 * `messages` row has the text and file columns side by side, and the Worker
 * only requires one of them to be present).
 *
 * A selection of several files still becomes several messages. They share a
 * batch id so the other devices render them as one album under one caption,
 * but each keeps its own delivery row and its own resumable upload: fusing
 * them into a single message or a single archive would turn "three of five
 * arrived" into "none of one" the moment a background pass is cut short.
 */
export async function sendComposerMessage(content: ComposerContent): Promise<void> {
  const currentSession = session.value;
  if (!currentSession || !keyring.value) return;

  const text = content.text?.trim() ?? "";
  const files = content.files ?? [];
  if (!text && files.length === 0) return;
  // On the press of send, not on delivery: the outbox may deliver it from the
  // service worker, long after this page is gone.
  trackPromoStep("send-message");

  const viewOnce = content.viewOnce ? (true as const) : undefined;
  const sender = {
    direction: "out" as const,
    senderDeviceId: currentSession.deviceId,
    senderDeviceName: currentSession.deviceName,
    status: "queued" as const,
  };
  // One base timestamp with an offset per item, so an album keeps the order it
  // was picked in rather than the order the clock happened to tick.
  const createdAt = Date.now();

  if (files.length === 0) {
    await upsertMessage({
      id: randomId(),
      ...sender,
      text,
      viewOnce,
      createdAt,
    });
    scheduleOutboxFlush();
    return;
  }

  // Only a real batch gets a batch id: a lone file is not an album, and
  // tagging it as one would make the receiver draw a group of one.
  const batchId = files.length > 1 ? randomId() : undefined;
  const entries = files.map((file, index) => {
    const message: LocalMessage = {
      id: randomId(),
      ...sender,
      // The caption belongs to the selection, so it rides on the first message
      // and the album renders it once, underneath the group.
      ...(index === 0 && text ? { text } : {}),
      file: {
        r2Key: randomId(),
        iv: "",
        name: file.name,
        size: file.size,
        mime: file.type || "application/octet-stream",
      },
      ...(batchId ? { batch: { id: batchId, index, count: files.length } } : {}),
      viewOnce,
      createdAt: createdAt + index,
      fileState: "downloaded",
    };
    return { message, blob: file };
  });

  // Commit the complete selection before starting any upload: kicking the sync
  // loop per file used to freeze the first upload while the rest of the
  // selection had not even joined the outbox yet.
  await putOutgoingFileMessages(entries);
  for (const { message } of entries) applyMessageUpdate(message);
  scheduleOutboxFlush();

  // Tell the user what will happen to their upload(s) beyond this screen.
  if (!navigator.onLine) {
    showToast(
      backgroundSyncSupported()
        ? "You're offline — uploads will continue in the background once you reconnect"
        : "You're offline — uploads will resume when you're back online (keep the app open)",
    );
  }
}

/** Send what the composer currently holds, then empty it. */
export async function sendStagedComposer(): Promise<void> {
  const text = composerDraft.value;
  const files = stagedFiles.value.map((staged) => staged.file);
  const viewOnce = viewOnceArmed.value;
  if (!text.trim() && files.length === 0) return;

  // Cleared first: the send is queued to IndexedDB and retried from there, so
  // leaving the content in the composer until it lands would only invite it to
  // be sent twice.
  clearComposer();
  await sendComposerMessage({ text, files, viewOnce });
}

/**
 * Re-queue a failed outgoing message and try again.
 *
 * The backoff goes with it: a person pressing "Retry" means *now*, and leaving
 * a schedule behind would make the press do nothing for up to five minutes.
 */
export async function retryMessage(message: LocalMessage): Promise<void> {
  if (message.direction !== "out" || message.status !== "failed") return;
  await upsertMessage({ ...message, status: "queued", retry: undefined });
  scheduleOutboxFlush();
}

/**
 * Put everything that gave up back in the queue.
 *
 * Tombstones ride along. They have no bubble to press "Retry" on, so this is
 * the only thing that ever revives a "delete everywhere" the server refused —
 * and a deletion the user was told had happened is the last thing that should
 * stay stranded.
 */
export async function retryFailedSends(): Promise<void> {
  const stranded = failedSends.value;
  if (stranded.length === 0) return;
  // One flush covers all of them: `syncNow` is a no-op while a pass is running.
  await Promise.all(stranded.map(retryMessage));
}

/**
 * Have another go at an incoming file whose transfer failed.
 *
 * The message is put back into its waiting state before the sync pass is even
 * asked to run, exactly like a re-queued upload: `syncNow()` is a no-op while a
 * pass is already in flight, so leaving the card on "Download failed" until the
 * loop happened to come round would answer the click with nothing at all.
 */
export async function retryFileDownload(message: LocalMessage): Promise<void> {
  if (message.direction !== "in" || message.fileState !== "error") return;
  // Clearing the backoff is what makes the press mean "now": the pass below
  // skips a file that is still serving one.
  await upsertMessage({ ...message, fileState: "remote", retry: undefined });
  await syncNow();
}

/** Start a cached attachment's download; resolves whether it was opened successfully. */
export async function saveFile(message: LocalMessage): Promise<boolean> {
  const file = await readMessageFile(message);
  if (!file) return false;
  downloadBlob(file, file.name);
  return true;
}

// ---------------------------------------------------------------------------
// Message actions (context menu)
// ---------------------------------------------------------------------------

export async function copyMessageText(message: LocalMessage): Promise<void> {
  if (!message.text) return;
  await copyText(message.text);
}

/**
 * Whether "Copy image" can work for this message: an image attachment whose
 * decrypted blob is cached locally, in a browser that can write images.
 */
export function canCopyImage(message: LocalMessage): boolean {
  return (
    !!message.file?.mime.startsWith("image/") &&
    message.fileState === "downloaded" &&
    canCopyImages()
  );
}

export async function copyMessageImage(message: LocalMessage): Promise<void> {
  const file = await readMessageFile(message);
  if (!file) return;
  try {
    await copyImageBlob(file);
    showToast("Image copied to clipboard");
  } catch {
    showToast("Couldn't copy the image", "error");
  }
}

/**
 * Whether a message can be kept in the vault from here: its text, or its file
 * once the decrypted copy is on this device (the vault re-encrypts it under a
 * key of its own, so it needs the plaintext, not the message's ciphertext).
 */
export function canSaveToVault(message: LocalMessage): boolean {
  if (message.file) return message.fileState === "downloaded" && !message.viewOnce;
  return !!message.text && !message.viewOnce;
}

/**
 * Keep messages in a vault folder (`null`: its top level): files as files,
 * text as a note. Several messages are an album, saved as one batch. Resolves
 * to whether everything was saved.
 */
export async function saveMessagesToVault(
  messages: readonly LocalMessage[],
  parentId: string | null,
): Promise<boolean> {
  // The vault it goes to is the space the messages are in. `saveFilesToVault`
  // pins the open space when it starts, so the space must not have changed
  // while the files were being read.
  const spaceId = activeSpace.value?.id;
  if (!spaceId) return false;
  const files: File[] = [];
  for (const message of messages) {
    if (!message.file) continue;
    const file = await readMessageFile(message, spaceId);
    if (!file) return false;
    files.push(file);
  }
  if (activeSpace.value?.id !== spaceId) return false;
  if (files.length > 0) return (await saveFilesToVault(parentId, files)) === files.length;

  const text = messages.find((message) => message.text)?.text;
  if (!text || !(await createNote(parentId, "", text))) return false;
  showToast("Saved to the vault as a note");
  return true;
}

/** Whether the Web Share API can plausibly share this message from here. */
export function canShareMessage(message: LocalMessage): boolean {
  if (typeof navigator.share !== "function") return false;
  if (message.text) return true;
  // Files can only be shared once the decrypted blob is cached locally.
  return !!message.file && message.fileState === "downloaded";
}

export async function shareMessage(message: LocalMessage): Promise<void> {
  try {
    if (message.text) {
      await navigator.share({ text: message.text });
      return;
    }
    const file = await readMessageFile(message);
    if (!file) return;
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file] });
    } else {
      showToast("Sharing files isn't supported on this device", "error");
    }
  } catch (error) {
    // The user dismissing the share sheet is not an error.
    if (error instanceof DOMException && error.name === "AbortError") return;
    showToast("Couldn't share", "error");
  }
}

/**
 * Delete a message from THIS device only (other devices keep their copy).
 * An incoming message the server still lists as pending must be acked first,
 * otherwise the next sync pass would just re-download it.
 */
export async function deleteMessageLocally(message: LocalMessage): Promise<void> {
  if (message.direction === "in" && !message.acked) {
    try {
      await api.ackMessage(message.id, authHeaders());
    } catch {
      showToast("Couldn't delete — check your connection and try again", "error");
      return;
    }
  }
  await discardMessage(message);
  showToast("Deleted on this device");
}

/**
 * Whether "delete for everyone" would actually do anything for this message.
 *
 * It is offered only when some *other* device can be holding a copy, which
 * rules out two cases where the global delete would be a more frightening name
 * for what the local one already does:
 *
 *  - a space with no other device linked, so there is nobody to tell;
 *  - an outgoing message that never left this device (still queued, or failed),
 *    so no copy of it exists anywhere else.
 *
 * Note that "the server no longer stores it" is deliberately *not* a reason to
 * hide it: the server drops a message as soon as every device has downloaded
 * it, which is precisely when the only copies left are the ones on those
 * devices — the copies this action exists to remove.
 */
export function canDeleteEverywhere(message: LocalMessage): boolean {
  const currentSession = session.value;
  if (!currentSession) return false;
  if (message.deletes) return false;
  const peers = knownDeviceIds.value.filter((id) => id !== currentSession.deviceId);
  if (peers.length === 0) return false;
  return message.direction === "in" || message.status === "sent";
}

/**
 * Delete a message from every device in the space.
 *
 * The local copy goes immediately and a tombstone is queued for the others.
 * Queued rather than sent inline on purpose: it then inherits the outbox's
 * retries, its Web Lock and Background Sync, so a deletion asked for on a train
 * still lands when the connection comes back, and the app being closed in the
 * meantime does not lose it.
 *
 * The order matters. The id is recorded as deleted (inside `applyGlobalDeletion`)
 * *before* anything is sent, so a copy of the message that is still in flight is
 * dropped when it arrives instead of quietly reappearing in the history the user
 * just cleared.
 */
async function queueGlobalDeletion(messageId: string): Promise<void> {
  const currentSession = session.value;
  if (!currentSession) return;
  await upsertMessage({
    id: randomId(),
    direction: "out",
    senderDeviceId: currentSession.deviceId,
    deletes: messageId,
    createdAt: Date.now(),
    status: "queued",
  });
  scheduleOutboxFlush();
}

export async function deleteMessageEverywhere(message: LocalMessage): Promise<void> {
  if (!session.value || !canDeleteEverywhere(message)) return;

  await applyGlobalDeletion(message.id);
  await queueGlobalDeletion(message.id);

  showToast(
    navigator.onLine
      ? "Deleting on all your devices"
      : "Deleted here — your other devices will follow when you're back online",
  );
}

/**
 * Open a view-once message: retract it from every *other* device now, and keep
 * the local copy only until the reader closes it.
 *
 * The split is what makes "disappears once opened" true rather than
 * approximately true. Retracting on open (instead of on close) means a second
 * device can no longer reach it from the moment the first one does; keeping
 * the local row until `releaseViewOnce` means the person who opened it gets to
 * finish reading. `recordDeletion` runs first either way, so a copy of the
 * message still in flight is dropped on arrival instead of reappearing.
 *
 * A device with no peers has nobody to tell, so it only records and discards.
 */
export async function consumeViewOnce(message: LocalMessage): Promise<void> {
  const currentSession = session.value;
  if (!currentSession || !message.viewOnce) return;

  await recordDeletion(message.id);
  const peers = knownDeviceIds.value.filter((id) => id !== currentSession.deviceId);
  if (peers.length > 0) await queueGlobalDeletion(message.id);
}

/** The reader closed a view-once message: erase what is left of it here. */
export async function releaseViewOnce(message: LocalMessage): Promise<void> {
  await discardMessage(message);
}
