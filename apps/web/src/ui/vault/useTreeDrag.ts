/**
 * Dragging an item to another folder of the tree, with a mouse or a finger.
 *
 * Built on pointer events rather than the HTML drag-and-drop API: that API
 * does nothing on most touch screens, and a phone is where the vault is used
 * as much as anywhere. A mouse picks an item up as soon as it moves a few
 * pixels; a finger has to hold still on it first, so a swipe still scrolls.
 */

import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { VaultEntry } from "../../state/vaultItems";
import { folderAt, vaultDropTarget } from "./drop";

/** How far a mouse travels before a press becomes a drag. */
const MOUSE_SLOP = 5;
/** How far a finger may wander while held before it counts as a scroll instead. */
const TOUCH_SLOP = 8;
/** How long a finger holds an item before it lifts. */
const TOUCH_HOLD_MS = 380;
/** How long a drag hovers a closed folder before it opens. */
const HOVER_OPEN_MS = 650;
/** The band at the top and bottom of the list that scrolls it during a drag. */
const EDGE = 56;

export interface TreeDrag {
  entry: VaultEntry;
  x: number;
  y: number;
}

interface Options {
  /** The element that scrolls the tree, for scrolling while dragging near its edges. */
  scroller: () => HTMLElement | null;
  canDrop: (entry: VaultEntry, folderId: string | null) => boolean;
  onDrop: (entry: VaultEntry, folderId: string | null) => void;
  /** A closed folder was hovered long enough to open it. */
  onHoverFolder: (folderId: string) => void;
}

interface Press {
  entry: VaultEntry;
  pointerId: number;
  touch: boolean;
  x: number;
  y: number;
  timer: number | undefined;
}

export function useTreeDrag(options: Options): {
  drag: TreeDrag | null;
  rowHandlers: (
    entry: VaultEntry,
  ) => Pick<JSX.HTMLAttributes<HTMLElement>, "onPointerDown" | "onClickCapture">;
} {
  const [drag, setDrag] = useState<TreeDrag | null>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const press = useRef<Press | null>(null);
  const active = useRef<TreeDrag | null>(null);
  const swallowClick = useRef(false);
  const hover = useRef<{ folderId: string; timer: number } | null>(null);
  const scroll = useRef({ speed: 0, frame: 0 });
  const detach = useRef<() => void>(() => {});

  function aim(x: number, y: number): void {
    const current = active.current;
    if (!current) return;
    const folderId = folderAt(document.elementFromPoint(x, y));
    const target =
      folderId !== undefined && optionsRef.current.canDrop(current.entry, folderId)
        ? folderId
        : undefined;
    vaultDropTarget.value = target;

    // A closed folder held under the item for a moment opens, so a drop can
    // reach somewhere deep without letting go first.
    const hovered = target ?? null;
    if (hover.current?.folderId !== hovered) {
      if (hover.current) clearTimeout(hover.current.timer);
      hover.current = hovered
        ? {
            folderId: hovered,
            timer: window.setTimeout(
              () => optionsRef.current.onHoverFolder(hovered),
              HOVER_OPEN_MS,
            ),
          }
        : null;
    }
  }

  function autoScroll(y: number): void {
    const element = optionsRef.current.scroller();
    if (!element) return;
    const rect = element.getBoundingClientRect();
    const top = y - rect.top;
    const bottom = rect.bottom - y;
    scroll.current.speed =
      top < EDGE
        ? -Math.ceil((EDGE - top) / 4)
        : bottom < EDGE
          ? Math.ceil((EDGE - bottom) / 4)
          : 0;
    if (scroll.current.speed !== 0 && !scroll.current.frame) {
      const step = (): void => {
        const { speed } = scroll.current;
        const current = active.current;
        if (speed === 0 || !current) {
          scroll.current.frame = 0;
          return;
        }
        element.scrollTop += speed;
        aim(current.x, current.y);
        scroll.current.frame = requestAnimationFrame(step);
      };
      scroll.current.frame = requestAnimationFrame(step);
    }
  }

  function begin(x: number, y: number): void {
    const held = press.current;
    if (!held) return;
    if (held.timer) clearTimeout(held.timer);
    held.timer = undefined;
    const started = { entry: held.entry, x, y };
    active.current = started;
    setDrag(started);
    // Text the press started on would otherwise be selected as the pointer moves.
    window.getSelection()?.removeAllRanges();
    if (held.touch) navigator.vibrate?.(8);
    aim(x, y);
  }

  function finish(drop: boolean): void {
    const current = active.current;
    const target = vaultDropTarget.value;
    detach.current();
    if (press.current?.timer) clearTimeout(press.current.timer);
    press.current = null;
    if (hover.current) clearTimeout(hover.current.timer);
    hover.current = null;
    cancelAnimationFrame(scroll.current.frame);
    scroll.current = { speed: 0, frame: 0 };
    active.current = null;
    vaultDropTarget.value = undefined;
    setDrag(null);
    if (!current) return;
    // The release that ends a drag must not also open the row it started on.
    swallowClick.current = true;
    setTimeout(() => {
      swallowClick.current = false;
    }, 0);
    if (drop && target !== undefined) optionsRef.current.onDrop(current.entry, target);
  }

  function onPointerDown(entry: VaultEntry, event: PointerEvent): void {
    if (event.button !== 0 || press.current || !entry.meta) return;
    // The row's own buttons (its menu) are not handles.
    if ((event.target as Element).closest("button")) return;
    const touch = event.pointerType !== "mouse";
    const held: Press = {
      entry,
      pointerId: event.pointerId,
      touch,
      x: event.clientX,
      y: event.clientY,
      timer: undefined,
    };
    press.current = held;
    if (touch) held.timer = window.setTimeout(() => begin(held.x, held.y), TOUCH_HOLD_MS);

    const onMove = (move: PointerEvent): void => {
      if (move.pointerId !== held.pointerId) return;
      const current = active.current;
      if (!current) {
        const distance = Math.hypot(move.clientX - held.x, move.clientY - held.y);
        if (touch) {
          if (distance > TOUCH_SLOP) finish(false);
        } else if (distance > MOUSE_SLOP) {
          begin(move.clientX, move.clientY);
        }
        return;
      }
      const next = { ...current, x: move.clientX, y: move.clientY };
      active.current = next;
      setDrag(next);
      aim(next.x, next.y);
      autoScroll(next.y);
    };
    const onUp = (up: PointerEvent): void => {
      if (up.pointerId === held.pointerId) finish(true);
    };
    const onCancel = (cancel: PointerEvent): void => {
      if (cancel.pointerId === held.pointerId) finish(false);
    };
    const onKey = (key: KeyboardEvent): void => {
      if (key.key === "Escape" && active.current) {
        key.stopPropagation();
        finish(false);
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("keydown", onKey, true);
    detach.current = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("keydown", onKey, true);
      detach.current = () => {};
    };
  }

  // A drag still going when the tree goes away (a sync replaced it, the user
  // navigated) must not leave listeners or a highlighted target behind.
  useEffect(
    () => () => {
      if (press.current || active.current) finish(false);
    },
    [],
  );

  // A finger carrying an item must not also scroll the page. The listener is
  // in place before any touch starts (the browser only lets a touch's moves be
  // cancelled when a blocking listener existed when it began), and it is added
  // by hand: `onTouchMove` in JSX is registered under the wrong event name
  // wherever the browser doesn't advertise touch support up front, which
  // includes desktop Chrome on a touchscreen laptop.
  useEffect(() => {
    const element = optionsRef.current.scroller();
    if (!element) return;
    const onTouchMove = (event: TouchEvent): void => {
      if (active.current && event.cancelable) event.preventDefault();
    };
    element.addEventListener("touchmove", onTouchMove, { passive: false });
    return () => element.removeEventListener("touchmove", onTouchMove);
  }, []);

  return {
    drag,
    rowHandlers: (entry) => ({
      onPointerDown: (event) => onPointerDown(entry, event as unknown as PointerEvent),
      onClickCapture: (event) => {
        if (!swallowClick.current) return;
        event.preventDefault();
        event.stopPropagation();
      },
    }),
  };
}
