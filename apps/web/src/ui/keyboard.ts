import type { RefObject } from "preact";
import { useEffect } from "preact/hooks";

/**
 * Chromium's VirtualKeyboard API. Not in lib.dom yet; only what we use is
 * described.
 */
interface VirtualKeyboard extends EventTarget {
  overlaysContent: boolean;
  readonly boundingRect: DOMRectReadOnly;
}

function virtualKeyboard(): VirtualKeyboard | undefined {
  if (typeof navigator === "undefined") return undefined;
  return (navigator as Navigator & { virtualKeyboard?: VirtualKeyboard }).virtualKeyboard;
}

const HEIGHT_KEY = "sendself:keyboard-height";
/** How long a predicted height may stand before the real geometry wins. */
const RESYNC_MS = 600;
const NON_TEXT_INPUTS = new Set([
  "button",
  "checkbox",
  "color",
  "file",
  "hidden",
  "image",
  "radio",
  "range",
  "reset",
  "submit",
]);

function isTextEntry(target: EventTarget | null): boolean {
  if (target instanceof HTMLTextAreaElement) return true;
  if (target instanceof HTMLInputElement) return !NON_TEXT_INPUTS.has(target.type);
  return target instanceof HTMLElement && target.isContentEditable;
}

/** The keyboard is taller in portrait than in landscape; remember each. */
function heightKey(): string {
  return `${HEIGHT_KEY}:${innerWidth > innerHeight ? "landscape" : "portrait"}`;
}

function rememberedHeight(): number {
  try {
    return Number(localStorage.getItem(heightKey())) || 0;
  } catch {
    return 0;
  }
}

function rememberHeight(height: number): void {
  try {
    localStorage.setItem(heightKey(), String(height));
  } catch {
    /* Private mode: every open simply waits for the browser's geometry. */
  }
}

/**
 * Overlay the keyboard and publish its height as `--keyboard-inset`, ahead of
 * the browser where possible.
 *
 * Chrome on Android reports the keyboard once, partway through its slide
 * (~100–170 ms in), and never frame by frame. Waiting for that report always
 * lands late: with `interactive-widget=resizes-content` the page jumps, and in
 * the PWA the strip between the page and the still-rising keyboard shows the
 * manifest's light `background_color`. A keyboard's height does not change
 * between opens, though, so once it has been seen the dock can start moving on
 * the focus itself, in step with the keyboard, and the report only corrects it.
 * Closing starts on blur, when the keyboard starts to leave.
 *
 * With the keyboard overlaid the page keeps its full height, so nothing outside
 * the page is ever exposed.
 */
function dockToKeyboard(keyboard: VirtualKeyboard): () => void {
  const root = document.documentElement;
  let resync: ReturnType<typeof setTimeout> | undefined;

  const publish = (height: number): void => {
    root.style.setProperty("--keyboard-inset", `${height}px`);
  };
  const actual = (): number => Math.round(keyboard.boundingRect.height);

  // A prediction is a bet: a hardware keyboard, or a keyboard that stayed put,
  // sends no geometry to settle it, so the real value is read back regardless.
  const predict = (height: number): void => {
    publish(height);
    clearTimeout(resync);
    resync = setTimeout(() => publish(actual()), RESYNC_MS);
  };

  const onGeometry = (): void => {
    const height = actual();
    // Chrome repeats the open geometry as the keyboard leaves; once nothing
    // that types has focus, a non-zero report is stale and would bounce the
    // dock back up.
    if (height > 0 && !isTextEntry(document.activeElement)) return;
    clearTimeout(resync);
    if (height > 0) rememberHeight(height);
    publish(height);
  };
  const expectKeyboard = (target: EventTarget | null): void => {
    if (!isTextEntry(target) || actual() > 0) return;
    const height = rememberedHeight();
    if (height > 0) predict(height);
  };
  const onFocusIn = (event: FocusEvent): void => expectKeyboard(event.target);
  // Back hides the keyboard without blurring the field; tapping it again
  // brings the keyboard back with no new focus event.
  const onClick = (event: MouseEvent): void => {
    if (event.target === document.activeElement) expectKeyboard(event.target);
  };
  const onFocusOut = (event: FocusEvent): void => {
    if (isTextEntry(event.target) && !isTextEntry(event.relatedTarget)) predict(0);
  };

  keyboard.overlaysContent = true;
  keyboard.addEventListener("geometrychange", onGeometry);
  document.addEventListener("focusin", onFocusIn);
  document.addEventListener("focusout", onFocusOut);
  document.addEventListener("click", onClick);
  publish(actual());

  return () => {
    clearTimeout(resync);
    keyboard.overlaysContent = false;
    keyboard.removeEventListener("geometrychange", onGeometry);
    document.removeEventListener("focusin", onFocusIn);
    document.removeEventListener("focusout", onFocusOut);
    document.removeEventListener("click", onClick);
    root.style.removeProperty("--keyboard-inset");
  };
}

let dockHolders = 0;
let undock: (() => void) | undefined;

/**
 * While mounted, let the keyboard slide over the page instead of resizing it,
 * and lift `.keyboard-dock` clear of it in step (see `dockToKeyboard`).
 *
 * Scoped to the views that dock to the keyboard: everywhere else (forms,
 * onboarding) the browser's own resize is what keeps a focused field visible.
 * Engines without the API (Safari, Firefox) keep the viewport meta behaviour.
 */
export function useKeyboardDock(): void {
  useEffect(() => {
    const keyboard = virtualKeyboard();
    if (!keyboard) return;
    if (dockHolders++ === 0) undock = dockToKeyboard(keyboard);
    return () => {
      if (--dockHolders === 0) undock?.();
    };
  }, []);
}

/**
 * Keep a scroller's distance from its end when the scroller itself is resized,
 * the way a messaging app's thread rides up with the keyboard instead of
 * letting it cover the latest messages. Covers anything that changes the
 * height: the keyboard, the composer growing a line, a window resize.
 *
 * ResizeObserver runs after layout and before paint, so the correction lands
 * in the same frame as the resize and the content never visibly lags.
 */
export function usePinnedScrollEnd(ref: RefObject<HTMLElement>): void {
  useEffect(() => {
    const scroller = ref.current;
    if (!scroller || typeof ResizeObserver === "undefined") return;
    let height = scroller.clientHeight;
    const observer = new ResizeObserver(() => {
      const next = scroller.clientHeight;
      if (next !== height) scroller.scrollTop += height - next;
      height = next;
    });
    observer.observe(scroller);
    return () => observer.disconnect();
  }, [ref]);
}
