/**
 * Ids of messages that were deleted for everyone, remembered for as long as a
 * copy of them could still turn up.
 *
 * Deleting locally is not enough on its own, because a deletion races the
 * delivery of the very thing it deletes. Two orderings make a message come back
 * from the dead without this:
 *
 *  - The tombstone reaches a device *before* the message does (the sender had
 *    both queued, or the server serves them out of order). Nothing is deleted,
 *    and the message arrives afterwards as if nothing had happened.
 *  - The user deletes an incoming message that is still pending server-side
 *    while offline. The tombstone cannot go out yet, so the next sync pass
 *    downloads the original again.
 *
 * So a deletion is recorded here first and consulted before anything incoming
 * is registered. Entries are pruned past MESSAGE_TTL_MS: after that the server
 * has dropped the message itself, so no copy of it can be delivered any more
 * and remembering the id buys nothing.
 */

import { MESSAGE_TTL_MS } from "@sendself/shared";
import { META_DELETED_MESSAGES, metaGet, metaSet } from "./store";

/** messageId → when it was deleted (epoch ms). */
export type Deletions = Record<string, number>;

function prune(deletions: Deletions, now: number): Deletions {
  const kept: Deletions = {};
  for (const [id, at] of Object.entries(deletions)) {
    if (now - at < MESSAGE_TTL_MS) kept[id] = at;
  }
  return kept;
}

/** Every id still worth remembering, pruning expired entries as a side effect. */
export async function loadDeletions(): Promise<Deletions> {
  const stored = (await metaGet<Deletions>(META_DELETED_MESSAGES)) ?? {};
  const pruned = prune(stored, Date.now());
  // Only write when something actually expired: this runs on every sync pass.
  if (Object.keys(pruned).length !== Object.keys(stored).length) {
    await metaSet(META_DELETED_MESSAGES, pruned);
  }
  return pruned;
}

/** Remember that `id` is deleted, so any late copy of it is dropped on sight. */
export async function recordDeletion(id: string): Promise<void> {
  const deletions = await loadDeletions();
  deletions[id] = Date.now();
  await metaSet(META_DELETED_MESSAGES, deletions);
}
