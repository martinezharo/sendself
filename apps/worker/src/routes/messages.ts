import type {
  AckResponse,
  PendingMessage,
  PendingMessagesResponse,
  SendMessageRequest,
  SendMessageResponse,
} from "@sendself/shared";
import { authenticate } from "../auth";
import { activeDeviceIds, deleteGroupMessage, deleteMessageById, fileStorageKey } from "../db";
import { ApiError, json } from "../errors";
import { optionalString, readJsonObject, requireId, requireInt } from "../http";
import { notifySpace } from "../realtime";
import type { RouteContext } from "../router";
import { rateLimit } from "../security";
import { pendingKeysFor } from "./keys";
import { spaceNameRecord } from "./space";

/** Create message metadata + one pending delivery row per other active device. */
export async function sendMessage(c: RouteContext): Promise<Response> {
  const auth = await authenticate(c.request, c.env);
  await rateLimit(c.env, "RL_WRITE", auth.deviceId);
  const body = await readJsonObject<SendMessageRequest>(c.request);

  const id = requireId(body.id, "id");
  const keyEpoch = requireInt(body.keyEpoch, "keyEpoch", 1, Number.MAX_SAFE_INTEGER);
  const encryptedPayload = optionalString(body.encryptedPayload, "encryptedPayload", 1_000_000);
  const iv = optionalString(body.iv, "iv", 128);
  const fileR2Key =
    body.fileR2Key === undefined ? undefined : requireId(body.fileR2Key, "fileR2Key");
  const fileIv = optionalString(body.fileIv, "fileIv", 128);
  const fileMeta = optionalString(body.fileMeta, "fileMeta", 8192);
  const fileMetaIv = optionalString(body.fileMetaIv, "fileMetaIv", 128);
  const signature = optionalString(body.signature, "signature", 512);
  const deletesMessageId =
    body.deletesMessageId === undefined
      ? undefined
      : requireId(body.deletesMessageId, "deletesMessageId");

  // Keep optional ciphertext fields paired with their payload. Without these
  // invariants a malformed client could store a record that the receiver
  // partially renders and acknowledges, silently losing the other half.
  if (!encryptedPayload && iv) {
    throw new ApiError("bad_request", "iv requires encryptedPayload");
  }
  if (!fileR2Key && fileIv) {
    throw new ApiError("bad_request", "fileIv requires fileR2Key");
  }
  // `fileMeta` is the message's metadata envelope, not the file's alone: a
  // text-only message carries one when it is view-once or part of an album
  // (see `MessageMeta`). So it no longer requires a file — only its own IV.
  if (!fileMeta !== !fileMetaIv) {
    throw new ApiError("bad_request", "fileMeta and fileMetaIv must travel together");
  }
  if (fileR2Key && (!fileIv || !fileMeta || !fileMetaIv)) {
    throw new ApiError("bad_request", "A file requires iv and encrypted metadata");
  }

  // A device whose peers hold a signing key for it must sign, or they would
  // reject the message as a downgrade. Catching it here turns a client bug into
  // a clear error instead of a message that silently arrives unverifiable.
  if (auth.hasSigningKey && !signature) {
    throw new ApiError("bad_request", "This device must sign its messages");
  }

  // A tombstone is a message whose entire content is "forget that other one",
  // so it carries no payload. Refusing the mixed form keeps the two kinds
  // unambiguous: a receiver never has to decide whether to render *and* delete,
  // and the signature covering it is unambiguously the delete statement.
  if (deletesMessageId && (encryptedPayload || fileR2Key || fileMeta)) {
    throw new ApiError("bad_request", "A deletion cannot carry text, a file or metadata");
  }
  if (deletesMessageId === id) {
    throw new ApiError("bad_request", "A deletion cannot target itself");
  }
  if (!encryptedPayload && !fileR2Key && !deletesMessageId) {
    throw new ApiError("bad_request", "Message must contain text and/or a file");
  }
  if (encryptedPayload && !iv) {
    throw new ApiError("bad_request", "Missing iv for text payload");
  }
  if (fileR2Key && !fileIv) {
    throw new ApiError("bad_request", "Missing fileIv for file payload");
  }

  // Friendly-path duplicate check; the racy window between this SELECT and
  // the INSERT below is closed by mapping the unique-constraint error to the
  // same `conflict` (the outbox treats it as "already sent").
  //
  // This runs *before* the epoch check on purpose: a resent message that the
  // server already stored must resolve as `conflict`, so the client leaves the
  // registered ciphertext alone instead of re-encrypting it under a newer key
  // and overwriting its R2 object with bytes the stored IV/epoch don't match.
  const existing = await c.env.DB.prepare("SELECT id FROM messages WHERE id = ?").bind(id).first();
  if (existing) {
    throw new ApiError("conflict", "Message id already exists");
  }

  // Refuse content encrypted under a superseded key, before anything is stored
  // or dropped. Without this, everything sent between a revocation and the
  // sender noticing the rotation would still be readable by the device that was
  // just revoked. Checked ahead of the no-recipient short-circuit below so a
  // stale sender always hears about it, whoever else is in the space.
  if (keyEpoch !== auth.groupKeyEpoch) {
    throw new ApiError(
      "key_rotated",
      "The space key has rotated; encrypt this message with the new key",
    );
  }

  // Destroy the target now, before anything else can go wrong with this
  // request. Done ahead of the no-recipients short-circuit below because it is
  // worth doing even when nobody is left to notify: the user asked for this
  // content to be gone, and content the server still holds is the one copy it
  // can actually guarantee.
  //
  // A miss is expected, not an error: a message every device already
  // acknowledged was purged from here the moment it was delivered, which is
  // precisely when the tombstone still has work to do on the devices.
  if (deletesMessageId) {
    await deleteGroupMessage(c.env, auth.groupId, deletesMessageId);
  }

  // Recipients are every active device except the sender.
  const recipients = (await activeDeviceIds(c.env, auth.groupId)).filter(
    (d) => d !== auth.deviceId,
  );

  // No recipients: nothing to deliver. Drop any uploaded file and skip storage
  // so the server keeps nothing around.
  if (recipients.length === 0) {
    if (fileR2Key) await c.env.FILES.delete(fileStorageKey(auth.groupId, fileR2Key));
    return json({ ok: true } satisfies SendMessageResponse);
  }

  // If a file is referenced it must already be uploaded (under this group).
  if (fileR2Key) {
    const head = await c.env.FILES.head(fileStorageKey(auth.groupId, fileR2Key));
    if (!head) {
      throw new ApiError("bad_request", "Referenced file has not been uploaded");
    }
  }

  const now = Date.now();
  const stmts = [
    c.env.DB.prepare(
      `INSERT INTO messages
         (id, group_id, sender_device_id, encrypted_payload, iv,
          file_r2_key, file_iv, file_meta, file_meta_iv, key_epoch, signature,
          deletes_message_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      id,
      auth.groupId,
      auth.deviceId,
      encryptedPayload ?? null,
      iv ?? null,
      fileR2Key ?? null,
      fileIv ?? null,
      fileMeta ?? null,
      fileMetaIv ?? null,
      keyEpoch,
      signature ?? null,
      deletesMessageId ?? null,
      now,
    ),
    ...recipients.map((deviceId) =>
      c.env.DB.prepare(
        "INSERT INTO delivery_status (message_id, device_id, downloaded_at) VALUES (?, ?, NULL)",
      ).bind(id, deviceId),
    ),
  ];
  try {
    await c.env.DB.batch(stmts);
  } catch (error) {
    if (error instanceof Error && error.message.includes("UNIQUE constraint failed")) {
      throw new ApiError("conflict", "Message id already exists");
    }
    throw error;
  }

  // Wake the recipients now instead of leaving them to notice on their next
  // poll. Never awaited: a notification that fails costs one poll interval of
  // latency, while making the send wait on it would cost the user their message.
  c.ctx.waitUntil(notifySpace(c.env, auth.groupId, auth.deviceId));

  return json({ ok: true } satisfies SendMessageResponse);
}

/**
 * One poll returns everything the client needs to stay in sync: pending
 * messages, any rotated GroupKey it has not adopted yet, and whether a rotation
 * is still owed. Bundling them keeps the rotation protocol free of extra
 * round-trips on the app's hottest request.
 */
export async function pendingMessages(c: RouteContext): Promise<Response> {
  const auth = await authenticate(c.request, c.env);
  const sinceRaw = c.url.searchParams.get("since");
  const since = sinceRaw ? Number(sinceRaw) : 0;
  if (!Number.isFinite(since) || since < 0) {
    throw new ApiError("bad_request", "Invalid 'since' cursor");
  }

  // Everything this answer needs is fetched at once rather than one query after
  // another: this is the app's hottest request, and none of the three depends on
  // the others.
  const [rows, keys, spaceName] = await Promise.all([
    c.env.DB.prepare(
      `SELECT m.id AS id,
              m.key_epoch AS keyEpoch,
              m.sender_device_id AS senderDeviceId,
              d.name_enc AS senderNameEnc,
              d.name_iv AS senderNameIv,
              d.name_key_epoch AS senderNameEpoch,
              m.encrypted_payload AS encryptedPayload,
              m.iv AS iv,
              m.file_r2_key AS fileR2Key,
              m.file_iv AS fileIv,
              m.file_meta AS fileMeta,
              m.file_meta_iv AS fileMetaIv,
              m.deletes_message_id AS deletesMessageId,
              m.signature AS signature,
              m.created_at AS createdAt
         FROM messages m
         JOIN delivery_status ds ON ds.message_id = m.id
         LEFT JOIN devices d ON d.id = m.sender_device_id AND d.group_id = m.group_id
        WHERE ds.device_id = ?
          AND ds.downloaded_at IS NULL
          AND m.created_at > ?
        ORDER BY m.created_at ASC
        LIMIT 200`,
    )
      .bind(auth.deviceId, since)
      .all<PendingMessage>(),
    pendingKeysFor(c.env, auth.groupId, auth.deviceId),
    spaceNameRecord(c.env, auth.groupId),
  ]);

  return json({
    messages: rows.results,
    keys,
    keyEpoch: auth.groupKeyEpoch,
    rotationPending: auth.rotationPending,
    spaceName,
  } satisfies PendingMessagesResponse);
}

/**
 * Mark a message delivered for the calling device. When no recipients remain
 * pending, the message metadata and its R2 file are deleted immediately.
 */
export async function ackMessage(c: RouteContext): Promise<Response> {
  const auth = await authenticate(c.request, c.env);
  const messageId = requireId(c.params.id, "id");

  // The UPDATE below only matches this device's own delivery row, so it
  // can't leak between groups. But the subsequent COUNT + deleteMessageById
  // operate on any messageId: a caller with a valid token for group A who
  // guesses (or enumerates) a messageId from group B would see "0 pending"
  // and trigger the cascade delete. Verify group ownership first.
  const owned = await c.env.DB.prepare("SELECT id FROM messages WHERE id = ? AND group_id = ?")
    .bind(messageId, auth.groupId)
    .first<{ id: string }>();
  if (!owned) {
    // Don't leak the distinction between "wrong group" and "doesn't exist".
    throw new ApiError("not_found", "Message not found");
  }

  await c.env.DB.prepare(
    "UPDATE delivery_status SET downloaded_at = ? WHERE message_id = ? AND device_id = ? AND downloaded_at IS NULL",
  )
    .bind(Date.now(), messageId, auth.deviceId)
    .run();

  const pending = await c.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM delivery_status WHERE message_id = ? AND downloaded_at IS NULL",
  )
    .bind(messageId)
    .first<{ n: number }>();

  let deleted = false;
  if (pending && pending.n === 0) {
    deleted = await deleteMessageById(c.env, messageId);
  }

  return json({ ok: true, deleted } satisfies AckResponse);
}
