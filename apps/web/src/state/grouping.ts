/**
 * Turn what the app stores into what the chat draws.
 *
 * Two streams reach this module, and neither arrives in the shape it is drawn
 * in: the messages, and the space's own notices (state/events.ts). What comes
 * out is one ordered list of entries — the thread.
 *
 * Files picked together travel as separate messages — that is what keeps each
 * upload independently resumable — so putting them back together is the
 * renderer's job. A run of consecutive messages sharing a batch id becomes one
 * album; everything else stays a single bubble.
 *
 * Consecutive is the operative word: grouping is never allowed to reorder the
 * thread. If another device's message lands in the middle of a batch (the
 * batch is several sends, and their `createdAt` comes from the server), the
 * album splits around it rather than swallowing it or jumping over it.
 *
 * Notices are merged in afterwards rather than grouped alongside, for the same
 * reason: a device joining while a batch uploads says nothing about those
 * files, so it must never be the thing that splits them.
 */

import type { LocalEvent, LocalMessage } from "../types";

export interface SingleEntry {
  kind: "single";
  key: string;
  message: LocalMessage;
}

export interface AlbumEntry {
  kind: "album";
  key: string;
  /** The messages of this run, in the order they were picked. */
  messages: LocalMessage[];
  /**
   * How many the sender said the batch has. More than `messages.length` means
   * the rest is still on its way (or was split off by an interleaved message),
   * which the album says out loud instead of pretending to be complete.
   */
  expected: number;
}

/**
 * A space notice — a device joined, one was revoked, the key rotated — drawn
 * in the thread where it happened rather than buried in the device screen.
 *
 * It is an entry rather than a fourth kind of message: it has no sender, no
 * delivery state and nothing to retry, and the moment it entered the message
 * store it would inherit all three (see state/events.ts).
 */
export interface NoticeEntry {
  kind: "notice";
  key: string;
  event: LocalEvent;
}

export type ChatEntry = SingleEntry | AlbumEntry | NoticeEntry;

/** When an entry happened, for merging the two streams into one thread. */
function entryTime(entry: ChatEntry): number {
  if (entry.kind === "notice") return entry.event.createdAt;
  return entry.kind === "album" ? entry.messages[0]!.createdAt : entry.message.createdAt;
}

/** Whether two messages belong to the same album run. */
function sameBatch(a: LocalMessage, b: LocalMessage): boolean {
  return (
    a.batch !== undefined &&
    b.batch !== undefined &&
    a.batch.id === b.batch.id &&
    a.senderDeviceId === b.senderDeviceId
  );
}

/**
 * The thread as drawn: messages (albums folded back together) and space
 * notices, in the order this device saw them.
 *
 * The two are merged *after* grouping, so a notice landing in the middle of a
 * batch cannot split an album — the files were still picked together, and a
 * device joining while they upload says nothing about them.
 */
export function chatEntries(
  list: readonly LocalMessage[],
  events: readonly LocalEvent[] = [],
): ChatEntry[] {
  const notices: ChatEntry[] = events.map((event) => ({
    kind: "notice",
    key: `event:${event.id}`,
    event,
  }));
  if (notices.length === 0) return groupMessages(list);
  return [...groupMessages(list), ...notices].sort((a, b) => entryTime(a) - entryTime(b));
}

export function groupMessages(list: readonly LocalMessage[]): ChatEntry[] {
  const entries: ChatEntry[] = [];

  for (let i = 0; i < list.length; i++) {
    const first = list[i]!;
    if (!first.batch) {
      entries.push({ kind: "single", key: first.id, message: first });
      continue;
    }

    let end = i + 1;
    while (end < list.length && sameBatch(first, list[end]!)) end++;

    const run = list.slice(i, end);
    // A batch of one is not an album. It can happen legitimately — the rest of
    // the run was deleted, or has not arrived yet — and drawing a group around
    // a lone file would only add a frame with nothing to frame.
    if (run.length === 1) {
      entries.push({ kind: "single", key: first.id, message: first });
    } else {
      entries.push({
        kind: "album",
        // Keyed by the first message rather than by the batch id: an
        // interleaved message can split one batch into two runs, and two
        // siblings must never claim the same key.
        key: `batch:${first.id}`,
        messages: [...run].sort((a, b) => (a.batch?.index ?? 0) - (b.batch?.index ?? 0)),
        expected: first.batch.count,
      });
    }
    i = end - 1;
  }

  return entries;
}

/**
 * The caption of an album: the text the sender attached to the selection.
 *
 * It rides on the first message of the batch, but a lost or still-pending
 * first message must not lose it, so this takes the first text it finds.
 */
export function albumCaption(entry: AlbumEntry): string | undefined {
  return entry.messages.find((message) => message.text)?.text;
}
