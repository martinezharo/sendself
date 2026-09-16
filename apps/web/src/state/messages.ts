import { computed, signal } from "@preact/signals";
import { recordDeletion } from "../db/deletions";
import { allMessages, deleteFile, deleteMessage, getMessage, putMessage } from "../db/store";
import type { LocalMessage } from "../types";

export const messages = signal<LocalMessage[]>([]);

/**
 * What the chat renders. Outgoing tombstones ("delete for everyone") live in
 * the same store so the outbox delivers them like any other send, but they are
 * bookkeeping, not content.
 */
export const visibleMessages = computed(() => messages.value.filter((m) => !m.deletes));

/**
 * Outgoing work that gave up.
 *
 * `failed` is the one state the outbox will not pick up again on its own (see
 * `isQueued` in sync/outbox.ts): it is reserved for what would fail identically
 * forever, so retrying it has to be somebody's decision. Until this list is
 * empty, that decision is still owed — which is why the chat says so out loud
 * rather than leaving it to whoever scrolls past the right bubble.
 */
export const failedSends = computed(() =>
  messages.value.filter((m) => m.direction === "out" && m.status === "failed"),
);

export async function loadMessages(): Promise<void> {
  const stored = await allMessages();
  // A tombstone only exists to be delivered. Once the server has it, delivery
  // to every device is its job, so the local row is dead weight — dropped here
  // rather than at send time because the send also runs in the service worker,
  // which has no way to tell the page a row disappeared.
  const spent = stored.filter((m) => m.deletes && m.status === "sent");
  await Promise.all(spent.map((m) => deleteMessage(m.id)));
  messages.value = spent.length === 0 ? stored : stored.filter((m) => !spent.includes(m));
}

/** Insert `message` into an array already sorted by `createdAt`, ascending. */
function insertSorted(list: LocalMessage[], message: LocalMessage): LocalMessage[] {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (list[mid]!.createdAt <= message.createdAt) lo = mid + 1;
    else hi = mid;
  }
  const next = list.slice();
  next.splice(lo, 0, message);
  return next;
}

/**
 * Update the in-memory signal only. Used when the message is already persisted
 * (e.g. the service worker flushed the outbox and broadcast the new state).
 *
 * `createdAt` is assigned once at message creation and never changes, so an
 * update to an existing message can be applied in place without re-sorting.
 */
export function applyMessageUpdate(message: LocalMessage): void {
  const current = messages.value;
  const idx = current.findIndex((m) => m.id === message.id);
  if (idx !== -1) {
    const next = current.slice();
    next[idx] = message;
    messages.value = next;
    return;
  }
  messages.value = insertSorted(current, message);
}

/** Insert or update a message both in IndexedDB and the reactive signal. */
export async function upsertMessage(message: LocalMessage): Promise<void> {
  await putMessage(message);
  applyMessageUpdate(message);
}

/** Remove a message from IndexedDB and the reactive signal. */
export async function removeMessage(id: string): Promise<void> {
  await deleteMessage(id);
  messages.value = messages.value.filter((m) => m.id !== id);
}

export function getLocalMessage(id: string): LocalMessage | undefined {
  return messages.value.find((m) => m.id === id);
}

/**
 * Erase every trace of a message from this device: the history row, the
 * reactive signal and the cached blob of its attachment.
 *
 * Shared by both ways a message can disappear — the user deleting it here, and
 * a tombstone arriving from another device — so neither can drift into
 * forgetting the file blob and leaving the actual content on disk.
 */
export async function discardMessage(message: LocalMessage): Promise<void> {
  await removeMessage(message.id);
  if (message.file) {
    await deleteFile(message.file.r2Key).catch(() => {
      /* cached blob cleanup is best-effort */
    });
  }
}

/**
 * Apply a deletion that must hold everywhere: drop the message if we still have
 * it, and remember the id either way so a copy still in flight is dropped when
 * it lands (see db/deletions.ts).
 */
export async function applyGlobalDeletion(id: string): Promise<void> {
  await recordDeletion(id);
  const local = getLocalMessage(id) ?? (await getMessage(id));
  if (local) await discardMessage(local);
}
