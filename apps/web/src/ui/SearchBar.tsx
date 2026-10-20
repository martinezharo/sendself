import { ChevronDown, ChevronUp, Search, X } from "lucide-preact";
import type { JSX } from "preact";
import { useEffect, useRef } from "preact/hooks";
import {
  closeSearch,
  findRanges,
  searchNeedle,
  searchOpen,
  searchQuery,
  toggleSearch,
} from "../state/search";
import { currentPosition, searchMatches, stepSearch } from "../state/thread";
import { IconButton, cx } from "./components";

/** Header button that opens the search. Closing is the layer's own button, in the same spot. */
export function SearchToggle(): JSX.Element {
  return (
    <IconButton label="Search messages" aria-expanded={searchOpen.value} onClick={toggleSearch}>
      <Search />
    </IconButton>
  );
}

/**
 * What the rest of the header does while the search is open: fade out, and
 * stop being focusable or clickable. The search layer is painted over the same
 * row, so whatever it covers must be gone for the keyboard and screen readers
 * too, not just for the eye.
 */
export function coveredBySearch(): string {
  return cx(
    "transition-opacity duration-200",
    searchOpen.value ? "invisible opacity-0" : "visible opacity-100",
  );
}

/**
 * The search field, with its result counter and the steps between results.
 *
 * It lives in the header rather than in a strip of its own: a strip costs the
 * thread a row of height exactly when a phone keyboard has taken most of the
 * screen. The layer is always mounted and revealed by a clip that opens from
 * the right, where the button that summoned it is — so it reads as the button
 * unfolding. Closed, it is `invisible`, which also removes it from the tab
 * order and the accessibility tree without needing to unmount it mid-animation.
 *
 * The caller positions it over the header row (`class`).
 *
 * Results are ordered the way the thread is: "older" goes up, "newer" goes
 * down, and the search starts on the newest hit because that is nearly always
 * the one being looked for. Enter steps to the next older one and Shift+Enter
 * back, so a query can be worked through without leaving the keyboard.
 */
export function SearchLayer({ class: cls }: { class: string }): JSX.Element {
  const open = searchOpen.value;
  const inputRef = useRef<HTMLInputElement>(null);
  const total = searchMatches.value.length;
  const searching = searchNeedle.value !== "";

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  function onKeyDown(event: JSX.TargetedKeyboardEvent<HTMLInputElement>): void {
    if (event.key === "Escape") {
      event.preventDefault();
      closeSearch();
    } else if (event.key === "Enter") {
      event.preventDefault();
      stepSearch(event.shiftKey ? "newer" : "older");
    }
  }

  return (
    <div
      class={cx(
        "flex items-center",
        // `visibility` is stepped, not tweened: it has to turn `visible` the
        // instant the search opens (a field that is still hidden at t=0 cannot
        // take focus) and `hidden` only once the clip has finished closing.
        open
          ? "visible opacity-100 [clip-path:inset(0)] [transition:clip-path_300ms_var(--ease-emphasized),opacity_300ms,visibility_0s]"
          : "invisible opacity-0 [clip-path:inset(0_0_0_100%)] [transition:clip-path_300ms_var(--ease-emphasized),opacity_300ms,visibility_0s_300ms]",
        cls,
      )}
    >
      <div class="ml-auto flex w-full max-w-[520px] items-center gap-1">
        <div class="relative min-w-0 flex-1">
          <Search
            aria-hidden="true"
            class="pointer-events-none absolute left-3 top-1/2 size-[16px] -translate-y-1/2 text-muted"
          />
          <input
            ref={inputRef}
            type="search"
            enterkeyhint="search"
            autocomplete="off"
            aria-label="Search messages"
            placeholder="Search messages"
            // Room for the glyph on the left; the native clear control is
            // redundant next to the close button, so `field-input` is kept for
            // its focus ring and its 16px size on phones (see styles.css).
            class="field-input !py-2 !pl-9 [&::-webkit-search-cancel-button]:hidden"
            value={searchQuery.value}
            onInput={(event) => {
              searchQuery.value = (event.target as HTMLInputElement).value;
            }}
            onKeyDown={onKeyDown}
          />
        </div>
        {/* Announced as it changes: the count is the only feedback that the
            query found (or missed) anything once the hit is off screen. */}
        <span
          role="status"
          class="min-w-[58px] flex-none px-1.5 text-center font-mono text-meta text-muted"
        >
          {searching ? (total === 0 ? "No results" : `${currentPosition.value} of ${total}`) : ""}
        </span>
        <IconButton label="Older match" disabled={total === 0} onClick={() => stepSearch("older")}>
          <ChevronUp />
        </IconButton>
        <IconButton label="Newer match" disabled={total === 0} onClick={() => stepSearch("newer")}>
          <ChevronDown />
        </IconButton>
        <IconButton label="Close search" onClick={closeSearch}>
          <X />
        </IconButton>
      </div>
    </div>
  );
}

/**
 * `text` with every occurrence of the current query marked.
 *
 * Reads the query from the signal rather than taking it as a prop: the text
 * being drawn sits several components below the search bar, and threading the
 * query down to each of them would touch every one of them for a decoration.
 */
export function Highlighted({ text }: { text: string }): JSX.Element {
  const ranges = findRanges(text, searchNeedle.value);
  if (ranges.length === 0) return <>{text}</>;

  const parts: (string | JSX.Element)[] = [];
  let at = 0;
  for (const [start, end] of ranges) {
    if (start > at) parts.push(text.slice(at, start));
    parts.push(<mark class="search-hit">{text.slice(start, end)}</mark>);
    at = end;
  }
  if (at < text.length) parts.push(text.slice(at));
  return <>{parts}</>;
}
