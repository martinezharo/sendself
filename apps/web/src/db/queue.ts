import type { LocalMessage } from "../types";

/**
 * Still owed to the server. "uploading" counts, so an upload interrupted by a
 * crash or a kill is picked up again instead of being stuck forever.
 *
 * Shared by the outbox flush (which decides what to send) and the store's
 * outbox index (which decides which rows are worth reading at all), so the two
 * can never disagree about what "queued" means.
 */
export function isQueuedOutgoing(message: LocalMessage): boolean {
  return (
    message.direction === "out" && (message.status === "queued" || message.status === "uploading")
  );
}
