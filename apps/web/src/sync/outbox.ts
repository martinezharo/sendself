/**
 * Outgoing-message flush, shared by the page (sync/sync.ts) and the service
 * worker (sw.ts, Background Sync). It must therefore stay context-neutral:
 * no DOM, no signals — session, keys and the queue are read from IndexedDB.
 *
 * Concurrency: the page's poll loop and a background `sync` event can fire at
 * the same time. A Web Lock serializes whole flush passes, and each message is
 * re-read from IndexedDB right before sending so a queue entry that another
 * context already flushed is skipped instead of sent twice. As a last resort
 * the server rejects a duplicate message id with `conflict`, which is treated
 * as "already sent".
 */

import {
  type DeleteSignatureFields,
  type MessageMeta,
  type MessageSignatureFields,
  deleteSignatureStatement,
  messageSignatureStatement,
} from "@sendself/shared";
import { ApiError, type Auth, NetworkError, api } from "../api/client";
import {
  bufToBase64Url,
  encryptFile,
  encryptJson,
  encryptText,
  randomBytes,
  signStatement,
} from "../crypto/crypto";
import { type Keyring, currentKey, loadKeyring } from "../crypto/keyring";
import {
  META_SESSION,
  META_SIGNING_KEYPAIR,
  allMessages,
  getFile,
  getMessage,
  metaGet,
  putMessage,
} from "../db/store";
import type { LocalMessage, Session } from "../types";

/** Background Sync tag registered by the page and handled by the SW. */
export const OUTBOX_SYNC_TAG = "sendself-outbox";
/** Message used for an immediate SW handoff (also works without Background Sync). */
export const OUTBOX_FLUSH_MESSAGE = "sendself-flush-outbox";

/** Cross-context lock name serializing outbox flushes (page ↔ SW). */
const OUTBOX_LOCK = "sendself-outbox";

/** postMessage shape the SW broadcasts after persisting a message update. */
export interface OutboxUpdateBroadcast {
  type: "outbox-message-updated";
  /** Which space it belongs to: the page may well be looking at another one. */
  spaceId: string;
  message: LocalMessage;
}

export interface FlushResult {
  /** Messages successfully handed to the server in this pass. */
  sent: number;
  /** Messages permanently rejected (marked "failed"). */
  failed: number;
  /** Messages still queued (transient/network errors) — retry later. */
  remaining: number;
}

export interface FlushOptions {
  /** Cancel page-owned network work when its lifecycle is about to be frozen. */
  signal?: AbortSignal;
  /** Bound a worker pass so a large batch is split into resumable chunks. */
  maxMessages?: number;
  /**
   * Which space to flush. Omitted in the page, which is always working in one
   * space; the service worker passes it, because it flushes every space this
   * device holds without any of them being "open".
   */
  spaceId?: string;
}

/** Called after each persisted state change so live UIs can update. */
type NotifyUpdate = (message: LocalMessage) => void;

/**
 * Signs what this device sends, so the receiver can tell it really came from
 * here and not from a server rewriting the sender. The group and sender are
 * filled in by the flush, which is where they are known.
 *
 * Two statements, never one: a deletion is signed over its own statement so a
 * signature can never be lifted from a message and replayed as an order to
 * destroy one (see `deleteSignatureStatement`).
 */
interface Signer {
  message(fields: Omit<MessageSignatureFields, "groupId" | "senderDeviceId">): Promise<string>;
  deletion(fields: Omit<DeleteSignatureFields, "groupId" | "senderDeviceId">): Promise<string>;
}

/** Everything one flush pass needs, resolved once before the first send. */
interface FlushContext {
  keyring: Keyring;
  auth: Auth;
  /** Absent for a session that predates sender authenticity (see below). */
  sign?: Signer;
  notify?: NotifyUpdate;
  signal?: AbortSignal;
  /** The space being flushed; undefined means the one the page has open. */
  spaceId?: string;
}

function isFlushable(message: LocalMessage): boolean {
  // "uploading" is included so an upload interrupted by a crash/kill is
  // retried on the next pass instead of being stuck forever.
  return (
    message.direction === "out" && (message.status === "queued" || message.status === "uploading")
  );
}

/**
 * Flush every queued outgoing message (text *and* files). Files are uploaded
 * from the locally-cached original, so a failed send stays queued and is
 * retried on the next pass exactly like text.
 */
export async function flushQueuedOutbox(
  notify?: NotifyUpdate,
  options: FlushOptions = {},
): Promise<FlushResult> {
  // Web Locks exists in both window and worker scopes on every browser that
  // has Background Sync; fall back to running unlocked elsewhere. The abort
  // signal is intentionally checked inside the lock callback so a page that is
  // being backgrounded can relinquish the lock quickly and let the SW retry.
  if (typeof navigator !== "undefined" && navigator.locks) {
    return navigator.locks.request(OUTBOX_LOCK, { signal: options.signal }, () =>
      doFlush(notify, options),
    );
  }
  return doFlush(notify, options);
}

async function doFlush(
  notify: NotifyUpdate | undefined,
  options: FlushOptions,
): Promise<FlushResult> {
  const result: FlushResult = { sent: 0, failed: 0, remaining: 0 };
  const spaceId = options.spaceId;

  const [session, keyring, signingKeyPair] = await Promise.all([
    metaGet<Session>(META_SESSION, spaceId),
    loadKeyring(spaceId),
    metaGet<CryptoKeyPair>(META_SIGNING_KEYPAIR, spaceId),
  ]);
  if (!session || !keyring) return result;
  const auth: Auth = { token: session.deviceAuthToken };
  // A session that predates sender authenticity has no signing key until the
  // page mints one (actions.ensureSigningIdentity). Sending unsigned in the
  // meantime is the whole reason the upgrade costs the user nothing.
  const identity = { groupId: session.groupId, senderDeviceId: session.deviceId };
  const sign: Signer | undefined = signingKeyPair
    ? {
        message: (fields) =>
          signStatement(
            signingKeyPair.privateKey,
            messageSignatureStatement({ ...fields, ...identity }),
          ),
        deletion: (fields) =>
          signStatement(
            signingKeyPair.privateKey,
            deleteSignatureStatement({ ...fields, ...identity }),
          ),
      }
    : undefined;
  const context: FlushContext = {
    keyring,
    auth,
    ...(sign ? { sign } : {}),
    ...(notify ? { notify } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(spaceId ? { spaceId } : {}),
  };

  const queued = (await allMessages(spaceId))
    .filter(isFlushable)
    .slice(0, options.maxMessages ?? Number.POSITIVE_INFINITY);
  for (const stale of queued) {
    if (options.signal?.aborted) break;
    // Re-read: another context may have flushed this entry meanwhile.
    const message = await getMessage(stale.id, spaceId);
    if (!message || !isFlushable(message)) continue;

    try {
      if (message.deletes) {
        await sendQueuedDeletion(message, context);
      } else if (message.file || message.text !== undefined) {
        await sendQueuedContent(message, context);
      } else {
        continue;
      }
      result.sent++;
    } catch (error) {
      // Re-read instead of reusing `message`: sendQueuedContent pins `file.iv`
      // mid-flight and that pin must survive into the retry (see above).
      const current = (await getMessage(message.id, spaceId)) ?? message;
      if (isKeyRotated(error)) {
        // The space key rotated between pinning and sending. Drop the pinned
        // epoch (and the IV that goes with it) so the next pass re-encrypts
        // under the new key: the server refused this message precisely so the
        // revoked device never gets to read it.
        await update(
          { ...current, keyEpoch: undefined, file: repinFile(current), status: "queued" },
          context,
        );
        result.remaining++;
      } else if (isRetriable(error) || options.signal?.aborted) {
        // NetworkError or transient ApiError (rate_limited / internal): back to
        // "queued" for the next attempt. The "uploading" → "queued" reset also
        // keeps the UI honest while offline / being rate-limited.
        await update({ ...current, status: "queued" }, context);
        result.remaining++;
      } else {
        // Permanent ApiError, or a local failure (encrypt threw, corrupt blob):
        // retrying can't fix it, so surface it as "failed" (the bubble has a
        // Retry button) instead of silently re-queueing it forever.
        await update({ ...current, status: "failed" }, context);
        result.failed++;
      }
      // Once lifecycle cancellation happens, release the lock promptly. The
      // worker will resume from this item; do not start another page upload.
      if (options.signal?.aborted) break;
    }
  }
  // Count the persisted queue, including items outside this bounded pass and
  // files added while it was running. This drives reliable follow-up syncs.
  result.remaining = (await allMessages(spaceId)).filter(isFlushable).length;
  return result;
}

async function update(message: LocalMessage, context: FlushContext): Promise<void> {
  // If the user deleted the message locally mid-flush, don't resurrect it.
  if (!(await getMessage(message.id, context.spaceId))) return;
  await putMessage(message, context.spaceId);
  context.notify?.(message);
}

/**
 * The server rejects an already-registered message id with `conflict`. For our
 * own randomly-generated ids that only means a previous attempt succeeded but
 * the local status update was lost (e.g. the app was killed mid-flush).
 */
function isAlreadySent(error: unknown): boolean {
  return error instanceof ApiError && error.code === "conflict";
}

/**
 * Whether a flush failure is worth retrying on the next pass instead of
 * marking the message permanently failed. A `NetworkError` obviously is.
 * Among `ApiError`s, `rate_limited` is the textbook case: the server is
 * explicitly telling us to back off; `internal` covers transient 5xx where
 * the call might succeed on retry — the alternative (marking failed) would
 * silently drop the user's queued send on a single bad request.
 *
 * Anything else — a permanent ApiError, or a *local* throw (encryptFile /
 * encryptJson on a corrupt blob, IndexedDB read errors) — would fail
 * identically on every future pass; re-queueing it would poison the outbox
 * with an infinite retry loop.
 */
function isRetriable(error: unknown): boolean {
  if (error instanceof Error && error.name === "AbortError") return true;
  if (error instanceof NetworkError) return true;
  return error instanceof ApiError && (error.code === "rate_limited" || error.code === "internal");
}

/** The server refused this ciphertext because the space key has rotated. */
function isKeyRotated(error: unknown): boolean {
  return error instanceof ApiError && error.code === "key_rotated";
}

/** Clear a pinned file IV so the retry re-encrypts under the new epoch. */
function repinFile(message: LocalMessage): LocalMessage["file"] {
  return message.file ? { ...message.file, iv: "" } : undefined;
}

/**
 * Pin the epoch this message is encrypted under, on the first attempt.
 *
 * Retries must reuse it for the same reason they reuse the file IV: the same
 * key + IV + plaintext produce byte-identical ciphertext, so a retry racing a
 * send the server already registered cannot leave R2 holding bytes that the
 * stored IV/epoch can no longer open. A rotation is the one thing that
 * invalidates the pin, and the server says so explicitly (`key_rotated`).
 */
async function pinEpoch(
  message: LocalMessage,
  context: FlushContext,
): Promise<{ epoch: number; key: CryptoKey }> {
  const pinned = message.keyEpoch;
  if (pinned !== undefined) {
    const key = context.keyring.keys.get(pinned);
    if (key) return { epoch: pinned, key };
    // We no longer hold the pinned epoch (only possible after a local wipe);
    // fall through and re-pin to the current one.
  }
  const epoch = context.keyring.current;
  await update({ ...message, keyEpoch: epoch }, context);
  return { epoch, key: currentKey(context.keyring) };
}

/**
 * Deliver a "delete for everyone" order.
 *
 * It carries no ciphertext, but it still pins and sends the key epoch like any
 * other message: the server only accepts the current one, so a deletion queued
 * before a rotation is re-queued through the same `key_rotated` path instead of
 * being silently accepted under a superseded key.
 */
async function sendQueuedDeletion(message: LocalMessage, context: FlushContext): Promise<void> {
  const { auth, sign, signal } = context;
  signal?.throwIfAborted();
  const deletesMessageId = message.deletes!;
  const { epoch } = await pinEpoch(message, context);
  try {
    await api.sendMessage(
      {
        id: message.id,
        keyEpoch: epoch,
        deletesMessageId,
        ...(sign
          ? {
              signature: await sign.deletion({
                messageId: message.id,
                keyEpoch: epoch,
                deletesMessageId,
              }),
            }
          : {}),
      },
      auth,
      signal,
    );
  } catch (error) {
    if (!isAlreadySent(error)) throw error;
  }
  await update({ ...message, keyEpoch: epoch, status: "sent" }, context);
}

/**
 * The message's encrypted metadata envelope, or nothing when there is nothing
 * to say about it.
 *
 * It carries the attachment's name/size/mime as it always did, plus the album
 * grouping and the view-once flag — inside the ciphertext, and covered by the
 * signature, so the server can neither read which messages are sensitive nor
 * strip the flag that makes one disappear (see `MessageMeta`).
 */
function metaFor(message: LocalMessage): MessageMeta | undefined {
  const meta: MessageMeta = {
    ...(message.file
      ? { name: message.file.name, size: message.file.size, mime: message.file.mime }
      : {}),
    ...(message.batch
      ? {
          batchId: message.batch.id,
          batchIndex: message.batch.index,
          batchCount: message.batch.count,
        }
      : {}),
    ...(message.viewOnce ? { viewOnce: true as const } : {}),
  };
  return Object.keys(meta).length > 0 ? meta : undefined;
}

/**
 * Deliver a message's content: text, a file, or both in one message.
 *
 * One function rather than the two it replaces, because "text" and "file" were
 * never mutually exclusive on the wire — a `messages` row has both sets of
 * columns and the Worker only requires one of them — and keeping them apart is
 * what stopped an attachment from carrying a caption.
 */
async function sendQueuedContent(message: LocalMessage, context: FlushContext): Promise<void> {
  const { auth, sign, signal } = context;
  signal?.throwIfAborted();

  const { epoch, key } = await pinEpoch(message, context);

  let file = message.file;
  let fileIv: string | undefined;
  if (file) {
    const blob = await getFile(file.r2Key, context.spaceId);
    if (!blob) {
      // The local original is gone; we can never re-upload it.
      throw new Error("Local upload source is missing");
    }

    // Pin the file IV *before* uploading and reuse it on retries: with the same
    // key + IV the re-encrypted ciphertext is byte-identical, so a retry that
    // races a previously-registered send (see `isAlreadySent`) can never leave
    // R2 holding ciphertext that doesn't match the IV the server already stored.
    if (!file.iv) file = { ...file, iv: bufToBase64Url(randomBytes(12)) };
    await update({ ...message, file, keyEpoch: epoch, status: "uploading" }, context);

    signal?.throwIfAborted();
    const encrypted = await encryptFile(
      key,
      await blob.arrayBuffer(),
      `file:${message.id}`,
      file.iv,
    );
    signal?.throwIfAborted();
    await api.uploadFile(file.r2Key, encrypted.ciphertext, auth, signal);
    signal?.throwIfAborted();
    fileIv = encrypted.iv;
  }

  const text =
    message.text === undefined
      ? undefined
      : await encryptText(key, message.text, `text:${message.id}`);
  signal?.throwIfAborted();

  const metaPlain = metaFor(message);
  const meta = metaPlain ? await encryptJson(key, metaPlain, `meta:${message.id}`) : undefined;
  signal?.throwIfAborted();

  const payload = {
    ...(text ? { encryptedPayload: text.ciphertext, iv: text.iv } : {}),
    ...(file && fileIv ? { fileR2Key: file.r2Key, fileIv } : {}),
    ...(meta ? { fileMeta: meta.ciphertext, fileMetaIv: meta.iv } : {}),
  };

  try {
    await api.sendMessage(
      {
        id: message.id,
        keyEpoch: epoch,
        ...payload,
        ...(sign
          ? {
              signature: await sign.message({ messageId: message.id, keyEpoch: epoch, ...payload }),
            }
          : {}),
      },
      auth,
      signal,
    );
  } catch (error) {
    if (!isAlreadySent(error)) throw error;
  }
  await update({ ...message, ...(file ? { file } : {}), keyEpoch: epoch, status: "sent" }, context);
}
