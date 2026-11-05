import { VAULT_TOMBSTONE_TTL_MS, VAULT_TRASH_TTL_MS, type VaultItemRecord } from "@sendself/shared";
import { VAULT_BLOBS, deleteForgottenBlobs, forgetBlob } from "./blobs";
import type { Env } from "./env";

/**
 * Storage-level operations on the vault (`vault_items`), shared by the routes
 * and the cleanup cron. See the migration for what each column means.
 */

/** Columns of a `VaultItemRecord`, as selected from `vault_items`. */
export const VAULT_ITEM_COLUMNS = `id, parent_id AS parentId, kind, key_epoch AS keyEpoch,
  meta, meta_iv AS metaIv, blob_key AS blobKey, blob_size AS blobSize, revision,
  created_at AS createdAt, updated_at AS updatedAt, trashed_at AS trashedAt, seq`;

/** Items purged per D1 batch: three statements each, well under D1's limits. */
const PURGE_BATCH_SIZE = 40;

/**
 * Take the space's next change number. Every vault write runs this in the same
 * batch (one transaction) right before its own statement, which then stamps
 * the row with `VAULT_SEQ`, so each change gets a number of its own.
 */
export function nextVaultSeq(env: Env, groupId: string): D1PreparedStatement {
  return env.DB.prepare("UPDATE groups SET vault_seq = vault_seq + 1 WHERE id = ?").bind(groupId);
}

/** SQL for the number `nextVaultSeq` just took; binds the group id once. */
export const VAULT_SEQ = "(SELECT vault_seq FROM groups WHERE id = ?)";

/** One live (not purged) item, or null. */
export async function vaultItem(
  env: Env,
  groupId: string,
  id: string,
): Promise<VaultItemRecord | null> {
  return env.DB.prepare(
    `SELECT ${VAULT_ITEM_COLUMNS} FROM vault_items
      WHERE group_id = ? AND id = ? AND removed_at IS NULL`,
  )
    .bind(groupId, id)
    .first<VaultItemRecord>();
}

/**
 * Purge an item for good, with everything nested in it, and delete their
 * blobs. Returns the ids purged.
 *
 * A purged row stays behind as a tombstone (no content, `removed_at` set, a new
 * `seq`) so devices that hold a copy learn to drop it; the cleanup forgets
 * tombstones after `VAULT_TOMBSTONE_TTL_MS`.
 *
 * Descendants are found by walking `parent_id` through tombstones too, and the
 * walk repeats until it finds nothing alive: an item created in a folder while
 * that folder was being purged is caught by the next round rather than left
 * stranded under a parent that no longer exists. Once the folder itself is a
 * tombstone nothing new can be created in it, so the loop ends.
 */
export async function purgeVaultItem(env: Env, groupId: string, id: string): Promise<string[]> {
  const purged: string[] = [];
  while (true) {
    const rows = await env.DB.prepare(
      `WITH RECURSIVE tree(id) AS (
         SELECT id FROM vault_items WHERE group_id = ?1 AND id = ?2
         UNION
         SELECT v.id FROM vault_items v JOIN tree ON v.parent_id = tree.id
          WHERE v.group_id = ?1
       )
       SELECT v.id AS id, v.blob_key AS blobKey
         FROM vault_items v JOIN tree ON tree.id = v.id
        WHERE v.group_id = ?1 AND v.removed_at IS NULL`,
    )
      .bind(groupId, id)
      .all<{ id: string; blobKey: string | null }>();
    if (rows.results.length === 0) return purged;

    const now = Date.now();
    for (let offset = 0; offset < rows.results.length; offset += PURGE_BATCH_SIZE) {
      const batch = rows.results.slice(offset, offset + PURGE_BATCH_SIZE);
      await env.DB.batch(
        batch.flatMap((row) => [
          nextVaultSeq(env, groupId),
          env.DB.prepare(
            `UPDATE vault_items
                SET removed_at = ?, trashed_at = NULL, key_epoch = NULL, meta = NULL,
                    meta_iv = NULL, blob_key = NULL, blob_size = 0, updated_at = ?,
                    seq = ${VAULT_SEQ}
              WHERE group_id = ? AND id = ? AND removed_at IS NULL`,
          ).bind(now, now, groupId, groupId, row.id),
          // Row before blob: see the accounting invariant on `reserveBlob`.
          ...(row.blobKey ? [forgetBlob(env, VAULT_BLOBS, groupId, row.blobKey)] : []),
        ]),
      );
      purged.push(...batch.map((row) => row.id));
      await deleteForgottenBlobs(
        env,
        VAULT_BLOBS,
        batch.flatMap((row) => (row.blobKey ? [{ groupId, key: row.blobKey }] : [])),
      );
    }
  }
}

/**
 * Purge what has sat in the trash past `VAULT_TRASH_TTL_MS`, and forget
 * tombstones past `VAULT_TOMBSTONE_TTL_MS`.
 *
 * Forgetting a tombstone raises the space's `vault_floor` to its seq first, in
 * the same transaction: a device whose cursor is older than that can no longer
 * be told what it missed, and is told to resync instead.
 */
export async function cleanUpVault(env: Env, now: number): Promise<void> {
  while (true) {
    const rows = await env.DB.prepare(
      `SELECT group_id AS groupId, id FROM vault_items
        WHERE trashed_at < ? AND removed_at IS NULL
        LIMIT 50`,
    )
      .bind(now - VAULT_TRASH_TTL_MS)
      .all<{ groupId: string; id: string }>();
    if (rows.results.length === 0) break;
    for (const row of rows.results) await purgeVaultItem(env, row.groupId, row.id);
  }

  const forgottenBefore = now - VAULT_TOMBSTONE_TTL_MS;
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE groups
          SET vault_floor = MAX(vault_floor, (
            SELECT MAX(seq) FROM vault_items
             WHERE group_id = groups.id AND removed_at < ?1
          ))
        WHERE id IN (SELECT group_id FROM vault_items WHERE removed_at < ?1)`,
    ).bind(forgottenBefore),
    env.DB.prepare("DELETE FROM vault_items WHERE removed_at < ?").bind(forgottenBefore),
  ]);
}
