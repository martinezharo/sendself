import { MESSAGE_TTL_MS, ORPHAN_UPLOAD_TTL_MS, PAIRING_TTL_MS } from "@sendself/shared";
import { MESSAGE_FILES, VAULT_BLOBS, purgeOrphanBlobs } from "./blobs";
import { purgeExpiredMessages } from "./db";
import type { Env } from "./env";
import { cleanUpVault } from "./vault";

/**
 * Scheduled cleanup so nothing lingers indefinitely:
 *  - expired pairing slots (> 10 min)
 *  - messages + their R2 files older than 24h that were never fully delivered
 *  - uploads no message or vault item claimed within the hour (an abandoned send)
 *  - vault items in the trash for 30 days, and purge tombstones after 90
 */
export async function runCleanup(env: Env): Promise<void> {
  const now = Date.now();

  await env.DB.prepare("DELETE FROM pairing WHERE created_at < ?")
    .bind(now - PAIRING_TTL_MS)
    .run();

  await purgeExpiredMessages(env, now - MESSAGE_TTL_MS);
  await purgeOrphanBlobs(env, MESSAGE_FILES, now - ORPHAN_UPLOAD_TTL_MS);
  await purgeOrphanBlobs(env, VAULT_BLOBS, now - ORPHAN_UPLOAD_TTL_MS);
  await cleanUpVault(env, now);
}
