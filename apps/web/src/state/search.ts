/**
 * Searching the conversation.
 *
 * Messages are end-to-end encrypted, so the server cannot search them and
 * nothing here ever leaves the device: the query is matched against the
 * plaintext this device already holds in memory (`messages`), with no separate
 * index to build, persist or keep in step with deletions.
 *
 * The search runs over the thread as it is *drawn* (`ChatEntry`), not over raw
 * messages. An album is one bubble, so one hit — and "jump to the result" needs
 * a bubble to jump to.
 */

import { computed, signal } from "@preact/signals";
import type { LocalMessage } from "../types";
import type { ChatEntry } from "./grouping";
import { albumCaption } from "./grouping";

/** Whether the search bar is showing. */
export const searchOpen = signal(false);

/** What the user typed, verbatim. */
export const searchQuery = signal("");

/**
 * The bubble the search is on, by entry key.
 *
 * Null means "wherever the search naturally starts" — the newest hit — which
 * is also what a query change falls back to, so typing never needs to reset
 * anything explicitly. A key rather than an index because the thread keeps
 * moving underneath: a message landing mid-search would shift every index and
 * silently move the user to a different result.
 */
export const searchCurrent = signal<string | null>(null);

/** The query in the form matching works on; empty when there is nothing to find. */
export const searchNeedle = computed(() =>
  searchOpen.value ? fold(searchQuery.value.trim()).folded : "",
);

export function openSearch(): void {
  searchOpen.value = true;
}

export function closeSearch(): void {
  searchOpen.value = false;
  searchQuery.value = "";
  searchCurrent.value = null;
}

export function toggleSearch(): void {
  if (searchOpen.value) closeSearch();
  else openSearch();
}

const COMBINING_MARKS = /\p{M}/gu;
const ASCII_ONLY = /^\p{ASCII}*$/u;

/** A string reduced to what matching compares, plus the way back to the original. */
interface Folded {
  folded: string;
  /**
   * For each code unit of `folded`, where the character it came from starts
   * and ends in the original. Null when folding kept every index (plain ASCII,
   * which is nearly all of what people type and the case worth being fast on).
   */
  starts: number[] | null;
  ends: number[] | null;
}

/**
 * Case- and accent-insensitive form of `text`: "Canción" finds "cancion" and
 * the other way round, which is what someone typing on a phone keyboard
 * actually wants.
 *
 * Folded one character at a time so the result can be mapped back: lowercasing
 * or stripping a mark can change a string's length ("İ" lowercases to two code
 * units), and highlighting needs positions in the *original* text.
 */
export function fold(text: string): Folded {
  if (ASCII_ONLY.test(text)) return { folded: text.toLowerCase(), starts: null, ends: null };

  let folded = "";
  const starts: number[] = [];
  const ends: number[] = [];
  let at = 0;
  for (const char of text) {
    const piece = char.normalize("NFD").replace(COMBINING_MARKS, "").toLowerCase();
    folded += piece;
    for (let i = 0; i < piece.length; i++) {
      starts.push(at);
      ends.push(at + char.length);
    }
    at += char.length;
  }
  return { folded, starts, ends };
}

/** Whether `text` contains the already-folded `needle`. */
export function matchesText(text: string, needle: string): boolean {
  return needle !== "" && fold(text).folded.includes(needle);
}

/** `[start, end)` ranges of `text` (in the original string) that match `needle`. */
export function findRanges(text: string, needle: string): Array<[number, number]> {
  if (needle === "") return [];
  const { folded, starts, ends } = fold(text);
  const ranges: Array<[number, number]> = [];
  for (
    let from = folded.indexOf(needle);
    from !== -1;
    from = folded.indexOf(needle, from + needle.length)
  ) {
    const to = from + needle.length;
    ranges.push(starts && ends ? [starts[from]!, ends[to - 1]!] : [from, to]);
  }
  return ranges;
}

/**
 * What of a message a search may look at.
 *
 * A view-once message shows a seal instead of its content until it is opened,
 * and its content is deliberately not in the DOM (see `ViewOnceSeal`). Letting
 * search match it would turn "Temporary" into something that can be read one
 * query at a time, so it contributes nothing.
 */
function messageText(message: LocalMessage): string[] {
  if (message.viewOnce) return [];
  const texts: string[] = [];
  if (message.text) texts.push(message.text);
  if (message.file) texts.push(message.file.name);
  return texts;
}

function entryText(entry: ChatEntry): string[] {
  switch (entry.kind) {
    case "notice":
      return [];
    case "single":
      return messageText(entry.message);
    case "album": {
      // The caption rides on one message but belongs to the whole bubble, and
      // is shown whichever file carries it.
      const caption = entry.messages.some((m) => m.viewOnce) ? undefined : albumCaption(entry);
      const names = entry.messages.flatMap((m) => (m.viewOnce || !m.file ? [] : [m.file.name]));
      return caption ? [caption, ...names] : names;
    }
  }
}

/** Keys of the entries that match, oldest first (the order they are drawn in). */
export function searchEntries(entries: readonly ChatEntry[], needle: string): string[] {
  if (needle === "") return [];
  return entries
    .filter((entry) => entryText(entry).some((text) => matchesText(text, needle)))
    .map((entry) => entry.key);
}

/** The match the search is on: the remembered one if it is still a hit, else the newest. */
export function resolveCurrent(matches: readonly string[], current: string | null): string | null {
  if (matches.length === 0) return null;
  return current !== null && matches.includes(current) ? current : matches[matches.length - 1]!;
}

/** The match one step from `current`, wrapping around either end. */
export function stepMatch(
  matches: readonly string[],
  current: string | null,
  direction: "older" | "newer",
): string | null {
  const resolved = resolveCurrent(matches, current);
  if (resolved === null) return null;
  const index = matches.indexOf(resolved);
  const next = direction === "older" ? index - 1 : index + 1;
  return matches[(next + matches.length) % matches.length]!;
}
