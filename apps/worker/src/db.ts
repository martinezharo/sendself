import type { Env } from "./env";

/** Keep D1 batches comfortably below statement/parameter limits. */
const DELETE_BATCH_SIZE = 100;

/**
 * R2 object key, namespaced by group. The client only ever knows the bare
 * `key`; the server derives the storage key from the authenticated group, so a
 * device in group A can never reach group B's blobs even if it learns the key.
 */
export function fileStorageKey(groupId: string, key: string): string {
  return `${groupId}/${key}`;
}

/** An active member of a group, with the material needed to re-key it. */
export interface ActiveDevice {
  id: string;
  publicKey: string;
  keyEpoch: number;
}

/**
 * Active (non-revoked) devices in a group. Single source of truth for "who is
 * still in this space", and so for who a key rotation must reach.
 */
export async function activeDevices(env: Env, groupId: string): Promise<ActiveDevice[]> {
  const rows = await env.DB.prepare(
    `SELECT id, public_key AS publicKey, key_epoch AS keyEpoch
       FROM devices
      WHERE group_id = ? AND revoked_at IS NULL`,
  )
    .bind(groupId)
    .all<ActiveDevice>();
  return rows.results;
}

/**
 * The devices a message from `senderId` is delivered to: every active device
 * except the sender and the send-only ones, which never collect anything (see
 * `PairingRequestBody.sendOnly`). Send-only devices are still in
 * `activeDevices`, because a rotated key has to reach them like anyone else.
 */
export async function messageRecipients(
  env: Env,
  groupId: string,
  senderId: string,
): Promise<string[]> {
  const rows = await env.DB.prepare(
    `SELECT id
       FROM devices
      WHERE group_id = ? AND revoked_at IS NULL AND send_only = 0 AND id != ?`,
  )
    .bind(groupId, senderId)
    .all<{ id: string }>();
  return rows.results.map((row) => row.id);
}

/**
 * Record an upload of `size` bytes against the space's quota, unless that
 * would take it past `quota`. Returns false (and records nothing) if so.
 *
 * One statement, so the check and the write are atomic: concurrent uploads to
 * the same space cannot all pass a check made before any of them was counted.
 *
 * Re-uploading a key never adds to its reservation, but never shrinks it
 * either: two overlapping writes to one key finish in no particular order, so
 * the object R2 keeps may be the larger one even when the smaller reserved
 * last. Keeping the maximum counts whichever wins; the row goes with the blob.
 */
export async function reserveUpload(
  env: Env,
  groupId: string,
  key: string,
  size: number,
  quota: number,
  now: number,
): Promise<boolean> {
  const result = await env.DB.prepare(
    `INSERT INTO uploads (group_id, r2_key, size, created_at)
     SELECT ?1, ?2, ?3, ?4
      WHERE COALESCE(
              (SELECT SUM(size) FROM uploads WHERE group_id = ?1 AND r2_key != ?2), 0
            ) + MAX(?3, COALESCE(
              (SELECT size FROM uploads WHERE group_id = ?1 AND r2_key = ?2), 0
            )) <= ?5
     ON CONFLICT (group_id, r2_key) DO UPDATE
        SET size = MAX(size, excluded.size), created_at = excluded.created_at`,
  )
    .bind(groupId, key, size, now, quota)
    .run();
  return result.meta.changes > 0;
}

/** Statement dropping the accounting row of one blob. */
function forgetUpload(env: Env, groupId: string, key: string): D1PreparedStatement {
  return env.DB.prepare("DELETE FROM uploads WHERE group_id = ? AND r2_key = ?").bind(groupId, key);
}

/**
 * Delete one uploaded blob and its accounting row. The only way a blob that no
 * message owns should leave R2, so the quota never counts bytes that are gone.
 */
export async function deleteUpload(env: Env, groupId: string, key: string): Promise<void> {
  await env.FILES.delete(fileStorageKey(groupId, key));
  await forgetUpload(env, groupId, key).run();
}

/**
 * Delete uploads that no message references and that are older than
 * `olderThan`: sends abandoned between the upload and the message. Without
 * this they would count against the space's quota until the 24-hour cleanup.
 *
 * Candidates are claimed by deleting their rows in one statement, and only the
 * blobs of rows actually claimed are removed. A retry that re-uploads the key
 * refreshes its row first, and a message that claims it is checked in the same
 * statement, so neither can be swept from under it by a decision made earlier.
 * If the R2 delete then fails, the bucket's lifecycle rule still expires it.
 */
export async function purgeOrphanUploads(env: Env, olderThan: number): Promise<void> {
  while (true) {
    const rows = await env.DB.prepare(
      `DELETE FROM uploads
        WHERE rowid IN (
          SELECT u.rowid
            FROM uploads u
           WHERE u.created_at < ?1
             AND NOT EXISTS (
               SELECT 1 FROM messages m
                WHERE m.group_id = u.group_id AND m.file_r2_key = u.r2_key
             )
           ORDER BY u.created_at ASC
           LIMIT ?2
        )
       RETURNING group_id AS groupId, r2_key AS key`,
    )
      .bind(olderThan, DELETE_BATCH_SIZE)
      .all<{ groupId: string; key: string }>();
    if (rows.results.length === 0) break;
    await env.FILES.delete(rows.results.map((row) => fileStorageKey(row.groupId, row.key)));
  }
}

/** Delete a set of messages (and their R2 files + delivery rows) by id. */
async function deleteMessages(
  env: Env,
  messages: { id: string; groupId: string; fileKey: string | null }[],
): Promise<void> {
  for (let offset = 0; offset < messages.length; offset += DELETE_BATCH_SIZE) {
    const batch = messages.slice(offset, offset + DELETE_BATCH_SIZE);
    const fileKeys = batch
      .filter((m) => m.fileKey)
      .map((m) => fileStorageKey(m.groupId, m.fileKey as string));
    if (fileKeys.length > 0) {
      await env.FILES.delete(fileKeys);
    }

    const stmts = batch.flatMap((m) => [
      env.DB.prepare("DELETE FROM delivery_status WHERE message_id = ?").bind(m.id),
      env.DB.prepare("DELETE FROM messages WHERE id = ?").bind(m.id),
      ...(m.fileKey ? [forgetUpload(env, m.groupId, m.fileKey)] : []),
    ]);
    await env.DB.batch(stmts);
  }
}

/**
 * Delete every message in a group that has no remaining pending recipients
 * (fully delivered), removing its R2 object too. Used after an ack or after a
 * device revocation frees up the last pending delivery.
 */
export async function purgeDeliveredMessages(env: Env, groupId: string): Promise<void> {
  while (true) {
    const rows = await env.DB.prepare(
      `SELECT m.id AS id, m.group_id AS groupId, m.file_r2_key AS fileKey
         FROM messages m
        WHERE m.group_id = ?
          AND NOT EXISTS (
            SELECT 1 FROM delivery_status ds
             WHERE ds.message_id = m.id AND ds.downloaded_at IS NULL
          )
        ORDER BY m.created_at ASC, m.id ASC
        LIMIT ?`,
    )
      .bind(groupId, DELETE_BATCH_SIZE)
      .all<{ id: string; groupId: string; fileKey: string | null }>();
    if (rows.results.length === 0) break;
    await deleteMessages(env, rows.results);
  }
}

/** Delete one message (and its R2 object) by id. Returns true if it existed. */
export async function deleteMessageById(env: Env, id: string): Promise<boolean> {
  const row = await env.DB.prepare(
    "SELECT id, group_id AS groupId, file_r2_key AS fileKey FROM messages WHERE id = ?",
  )
    .bind(id)
    .first<{ id: string; groupId: string; fileKey: string | null }>();
  if (!row) return false;
  await deleteMessages(env, [row]);
  return true;
}

/**
 * Delete one message (and its R2 object) belonging to `groupId`. Returns true
 * if it existed.
 *
 * Group-scoped on purpose: unlike `deleteMessageById`, whose callers have
 * already established ownership, this one acts directly on an id chosen by a
 * client (the target of a "delete for everyone"), so the group has to be part
 * of the match or a device could delete another space's message by guessing an
 * id. A miss is not an error — the target being gone already is the normal
 * case, since a fully delivered message is purged from here immediately.
 */
export async function deleteGroupMessage(env: Env, groupId: string, id: string): Promise<boolean> {
  const row = await env.DB.prepare(
    "SELECT id, group_id AS groupId, file_r2_key AS fileKey FROM messages WHERE id = ? AND group_id = ?",
  )
    .bind(id, groupId)
    .first<{ id: string; groupId: string; fileKey: string | null }>();
  if (!row) return false;
  await deleteMessages(env, [row]);
  return true;
}

/** Delete messages (and files) older than `olderThan` epoch ms across all groups. */
export async function purgeExpiredMessages(env: Env, olderThan: number): Promise<void> {
  while (true) {
    const rows = await env.DB.prepare(
      `SELECT id, group_id AS groupId, file_r2_key AS fileKey
         FROM messages
        WHERE created_at < ?
        ORDER BY created_at ASC, id ASC
        LIMIT ?`,
    )
      .bind(olderThan, DELETE_BATCH_SIZE)
      .all<{ id: string; groupId: string; fileKey: string | null }>();
    if (rows.results.length === 0) break;
    await deleteMessages(env, rows.results);
  }
}
