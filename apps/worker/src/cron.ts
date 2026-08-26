import { MESSAGE_TTL_MS, PAIRING_TTL_MS } from "@sendself/shared";
import { purgeExpiredMessages } from "./db";
import type { Env } from "./env";

/**
 * Scheduled cleanup so nothing lingers indefinitely:
 *  - expired pairing slots (> 10 min)
 *  - messages + their R2 files older than 24h that were never fully delivered
 */
export async function runCleanup(env: Env): Promise<void> {
  const now = Date.now();

  await env.DB.prepare("DELETE FROM pairing WHERE created_at < ?")
    .bind(now - PAIRING_TTL_MS)
    .run();

  await purgeExpiredMessages(env, now - MESSAGE_TTL_MS);
}
