import type { ComponentChildren, JSX } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { cx } from "./components";

/** Viewport point the menu opens from (trigger button, long-press or right-click). */
export interface MenuAnchor {
  x: number;
  y: number;
}

const EDGE_MARGIN = 8;

/**
 * When a menu is opened by the app's own long-press timer, the browser's
 * native long-press can still fire a trailing `contextmenu` (Android) a few
 * ms later — by then aimed at the backdrop, which would instantly close the
 * menu that just opened. Ignore backdrop context-menu events this soon after
 * opening; anything later is a genuine new right-click / long-press.
 */
const OPEN_GRACE_MS = 600;

/** Open a menu below a trigger button, hanging from its right edge. */
export function anchorBelow(element: HTMLElement): MenuAnchor {
  const rect = element.getBoundingClientRect();
  return { x: rect.right, y: rect.bottom + 6 };
}

/**
 * A popover menu: a fixed-position panel clamped to the viewport, over a
 * full-screen backdrop that closes it on any outside interaction. `alignRight`
 * hangs the panel to the left of the anchor, for triggers close to the right
 * edge of the screen.
 */
export function Menu({
  anchor,
  alignRight = false,
  label,
  onClose,
  children,
}: {
  anchor: MenuAnchor;
  alignRight?: boolean;
  label: string;
  onClose: () => void;
  children: ComponentChildren;
}): JSX.Element {
  const panelRef = useRef<HTMLDivElement>(null);
  const openedAt = useRef(performance.now());
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    let left = alignRight ? anchor.x - rect.width : anchor.x;
    let top = anchor.y;
    left = Math.min(Math.max(EDGE_MARGIN, left), window.innerWidth - rect.width - EDGE_MARGIN);
    top = Math.min(Math.max(EDGE_MARGIN, top), window.innerHeight - rect.height - EDGE_MARGIN);
    setPos({ left, top });
  }, [anchor.x, anchor.y, alignRight]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Move focus into the menu so keyboard users land on the first action, and
  // hand it back to whatever opened the menu once it closes — otherwise
  // dismissing with Escape drops focus on the document and the next Tab starts
  // over from the top of the page. The trigger can be gone by then (a row that
  // swapped it for a spinner, a message that was deleted), hence `isConnected`.
  useEffect(() => {
    const trigger = document.activeElement;
    panelRef.current?.querySelector("button")?.focus();
    return () => {
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus();
    };
  }, []);

  return (
    <div
      class="fixed inset-0 z-[90]"
      // Close on pointerdown (like native menus) rather than click: the finger
      // that long-pressed the menu open is still down over the backdrop, and
      // lifting it can synthesize a click there — pointerdown only fires for a
      // genuinely new outside interaction.
      onPointerDown={onClose}
      onClick={onClose}
      onContextMenu={(e) => {
        e.preventDefault();
        if (performance.now() - openedAt.current > OPEN_GRACE_MS) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="menu"
        aria-label={label}
        class={cx(
          // select-none: the panel can open under a finger that is still mid
          // long-press, and the browser's native text-selection gesture would
          // otherwise select the first menu item's label.
          "fixed z-[91] min-w-[200px] select-none rounded-[14px] border border-line bg-elevated p-1.5 shadow-float",
          pos ? "animate-menu-in" : "invisible",
        )}
        style={{
          left: `${pos?.left ?? anchor.x}px`,
          top: `${pos?.top ?? anchor.y}px`,
          transformOrigin: alignRight ? "top right" : "top left",
        }}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

export function MenuItem({
  icon,
  danger = false,
  onClick,
  children,
}: {
  icon: JSX.Element;
  danger?: boolean;
  onClick: () => void;
  children: ComponentChildren;
}): JSX.Element {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      class={cx(
        "flex w-full items-center gap-2.5 rounded-[9px] px-2.5 py-2 text-left text-note font-medium transition [&_svg]:size-4 [&_svg]:flex-none",
        danger
          ? "text-danger hover:bg-danger-soft [&_svg]:text-danger"
          : "text-ink hover:bg-surface-3 [&_svg]:text-subtle",
      )}
    >
      {icon}
      {children}
    </button>
  );
}

export function MenuSeparator(): JSX.Element {
  return <div class="mx-2 my-1 h-px bg-line" />;
}
