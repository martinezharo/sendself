/**
 * The conversation as drawn, and the search over it.
 *
 * Derived here, once, because two places that sit far apart in the component
 * tree need the same answer: the chat draws the entries and marks the hit, and
 * the header shows how many there are and steps between them. Kept apart from
 * `search.ts` so that module stays free of the message store and can be tested
 * without it.
 */

import { computed } from "@preact/signals";
import { spaceEvents } from "./events";
import { chatEntries } from "./grouping";
import { visibleMessages } from "./messages";
import { resolveCurrent, searchCurrent, searchEntries, searchNeedle, stepMatch } from "./search";

/** Messages (albums folded together) and space notices, in thread order. */
export const threadEntries = computed(() => chatEntries(visibleMessages.value, spaceEvents.value));

/** Keys of the entries matching the query, oldest first. */
export const searchMatches = computed(() => searchEntries(threadEntries.value, searchNeedle.value));

/** The entry the search is on, or null when nothing matches. */
export const currentMatch = computed(() =>
  resolveCurrent(searchMatches.value, searchCurrent.value),
);

/** 1-based place of the current hit among the matches; 0 when there is none. */
export const currentPosition = computed(() => {
  const key = currentMatch.value;
  return key === null ? 0 : searchMatches.value.indexOf(key) + 1;
});

/** Move to the next hit toward the start (`older`) or the end (`newer`) of the thread. */
export function stepSearch(direction: "older" | "newer"): void {
  searchCurrent.value = stepMatch(searchMatches.value, searchCurrent.value, direction);
}
