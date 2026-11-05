import type { Env } from "./env";

/**
 * Encrypted blobs in R2 and the accounting that caps them.
 *
 * Two stores hold blobs, and they differ only in where the bytes live, how long
 * they are meant to stay and what claims them: message attachments (delivered,
 * then deleted) and vault content (kept until the user deletes it). Each has a
 * table with a row per object, because R2 cannot answer "how many bytes does
 * this space hold" cheaply, and the same rules keep both rows honest.
 */
export interface BlobStore {
  /** The accounting table: `(group_id, r2_key, size, created_at)`. */
  readonly table: "uploads" | "vault_blobs";
  readonly bucket: (env: Env) => R2Bucket;
  /**
   * SQL true when the accounting row `u` is claimed by something that owns its
   * blob. An unclaimed row older than the orphan TTL is an abandoned upload.
   */
  readonly claimed: string;
}

/** Message attachments, deleted once every recipient has them. */
export const MESSAGE_FILES: BlobStore = {
  table: "uploads",
  bucket: (env) => env.FILES,
  claimed: `EXISTS (
    SELECT 1 FROM messages m WHERE m.group_id = u.group_id AND m.file_r2_key = u.r2_key
  )`,
};

/** Vault notes and files, kept until their item is purged. */
export const VAULT_BLOBS: BlobStore = {
  table: "vault_blobs",
  bucket: (env) => env.VAULT,
  claimed: `EXISTS (
    SELECT 1 FROM vault_items v
     WHERE v.group_id = u.group_id AND v.blob_key = u.r2_key AND v.removed_at IS NULL
  )`,
};

/** Keep D1 batches comfortably below statement/parameter limits. */
const SWEEP_BATCH_SIZE = 100;

/**
 * R2 object key, namespaced by group. The client only ever knows the bare
 * `key`; the server derives the storage key from the authenticated group, so a
 * device in group A can never reach group B's blobs even if it learns the key.
 */
export function blobStorageKey(groupId: string, key: string): string {
  return `${groupId}/${key}`;
}

/**
 * Record an upload of `size` bytes against the space's quota in `store`, unless
 * that would take it past `quota`. Returns false (and records nothing) if so.
 *
 * One statement, so the check and the write are atomic: concurrent uploads to
 * the same space cannot all pass a check made before any of them was counted.
 *
 * Re-uploading a key never adds to its reservation, but never shrinks it
 * either: two overlapping writes to one key finish in no particular order, so
 * the object R2 keeps may be the larger one even when the smaller reserved
 * last. Keeping the maximum counts whichever wins.
 *
 * Accounting invariant: an object is never left in R2 without its row. Every
 * deletion removes the row *before* the blob, and a write that completes
 * re-records its own row (`recordBlob`), so a deletion that raced a write in
 * flight can at worst leave a row with no blob, which the space is charged for
 * until the orphan sweep or its owner's deletion releases it.
 */
export async function reserveBlob(
  env: Env,
  store: BlobStore,
  groupId: string,
  key: string,
  size: number,
  quota: number,
  now: number,
): Promise<boolean> {
  const result = await env.DB.prepare(
    `INSERT INTO ${store.table} (group_id, r2_key, size, created_at)
     SELECT ?1, ?2, ?3, ?4
      WHERE COALESCE(
              (SELECT SUM(size) FROM ${store.table} WHERE group_id = ?1 AND r2_key != ?2), 0
            ) + MAX(?3, COALESCE(
              (SELECT size FROM ${store.table} WHERE group_id = ?1 AND r2_key = ?2), 0
            )) <= ?5
     ON CONFLICT (group_id, r2_key) DO UPDATE
        SET size = MAX(size, excluded.size), created_at = excluded.created_at`,
  )
    .bind(groupId, key, size, now, quota)
    .run();
  return result.meta.changes > 0;
}

/**
 * Re-record a blob whose write just completed, without the quota check (its
 * bytes were admitted when it reserved). Restores the row if a concurrent
 * deletion of the same key removed it while this write was still in flight.
 */
export async function recordBlob(
  env: Env,
  store: BlobStore,
  groupId: string,
  key: string,
  size: number,
  now: number,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO ${store.table} (group_id, r2_key, size, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (group_id, r2_key) DO UPDATE
        SET size = MAX(size, excluded.size), created_at = excluded.created_at`,
  )
    .bind(groupId, key, size, now)
    .run();
}

/** The recorded size of one blob, or null when it was never uploaded (or is gone). */
export async function blobSize(
  env: Env,
  store: BlobStore,
  groupId: string,
  key: string,
): Promise<number | null> {
  const row = await env.DB.prepare(
    `SELECT size FROM ${store.table} WHERE group_id = ? AND r2_key = ?`,
  )
    .bind(groupId, key)
    .first<{ size: number }>();
  return row?.size ?? null;
}

/** Statement dropping the accounting row of one blob. */
export function forgetBlob(
  env: Env,
  store: BlobStore,
  groupId: string,
  key: string,
): D1PreparedStatement {
  return env.DB.prepare(`DELETE FROM ${store.table} WHERE group_id = ? AND r2_key = ?`).bind(
    groupId,
    key,
  );
}

/**
 * Delete one blob and its accounting row. The only way a blob nothing owns
 * should leave R2, so the quota never counts bytes that are gone.
 */
export async function deleteBlob(
  env: Env,
  store: BlobStore,
  groupId: string,
  key: string,
): Promise<void> {
  // Row first: see the accounting invariant on `reserveBlob`.
  await forgetBlob(env, store, groupId, key).run();
  await store.bucket(env).delete(blobStorageKey(groupId, key));
}

/** Delete blobs whose rows were already dropped (`forgetBlob` in a caller's batch). */
export async function deleteForgottenBlobs(
  env: Env,
  store: BlobStore,
  blobs: readonly { groupId: string; key: string }[],
): Promise<void> {
  for (let offset = 0; offset < blobs.length; offset += SWEEP_BATCH_SIZE) {
    const batch = blobs.slice(offset, offset + SWEEP_BATCH_SIZE);
    await store.bucket(env).delete(batch.map((blob) => blobStorageKey(blob.groupId, blob.key)));
  }
}

/**
 * Delete uploads that nothing claims and that are older than `olderThan`:
 * writes abandoned between the upload and the record that owns it. Without
 * this they would count against the space's quota until something else
 * removed them (the 24-hour cleanup for messages; nothing at all for the vault).
 *
 * Candidates are claimed by deleting their rows in one statement, and only the
 * blobs of rows actually claimed are removed. A retry that re-uploads the key
 * refreshes its row first, and an owner that claims it is checked in the same
 * statement, so neither can be swept from under it by a decision made earlier.
 */
export async function purgeOrphanBlobs(
  env: Env,
  store: BlobStore,
  olderThan: number,
): Promise<void> {
  while (true) {
    const rows = await env.DB.prepare(
      `DELETE FROM ${store.table}
        WHERE rowid IN (
          SELECT u.rowid
            FROM ${store.table} u
           WHERE u.created_at < ?1
             AND NOT ${store.claimed}
           ORDER BY u.created_at ASC
           LIMIT ?2
        )
       RETURNING group_id AS groupId, r2_key AS key`,
    )
      .bind(olderThan, SWEEP_BATCH_SIZE)
      .all<{ groupId: string; key: string }>();
    if (rows.results.length === 0) break;
    await deleteForgottenBlobs(env, store, rows.results);
  }
}
