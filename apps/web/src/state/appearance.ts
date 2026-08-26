import { signal } from "@preact/signals";

/**
 * Appearance preferences: colour scheme and brand palette.
 *
 * Both are written to `<html>` as data attributes and read back by
 * `styles.css`, which resolves them into the `--c-*` token set. Nothing here
 * knows a hex value; the stylesheet owns every colour.
 */

export type Theme = "system" | "light" | "dark";

export interface Palette {
  id: string;
  label: string;
}

/**
 * Must stay in step with the palette blocks in `styles.css`. The ids are the
 * `data-palette` values; `rust` is the default and is therefore what bare
 * `:root` already carries.
 */
export const PALETTES: Palette[] = [
  { id: "rust", label: "Óxido" },
  { id: "amber", label: "Ámbar" },
  { id: "garnet", label: "Granate" },
  { id: "olive", label: "Oliva" },
  { id: "pine", label: "Pino" },
  { id: "petrol", label: "Petróleo" },
  { id: "denim", label: "Denim" },
  { id: "klein", label: "Ultramarino" },
  { id: "indigo", label: "Índigo" },
  { id: "plum", label: "Ciruela" },
];

export const DEFAULT_PALETTE = "rust";
const THEMES: Theme[] = ["system", "light", "dark"];

const THEME_KEY = "appearance.theme";
const PALETTE_KEY = "appearance.palette";

// Private-mode Safari and "block site data" both make localStorage throw on
// access rather than return null, and appearance is never worth breaking
// startup over.
function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* preference simply will not persist */
  }
}

function storedTheme(): Theme {
  const value = read(THEME_KEY);
  return THEMES.includes(value as Theme) ? (value as Theme) : "system";
}

function storedPalette(): string {
  const value = read(PALETTE_KEY);
  return PALETTES.some((p) => p.id === value) ? (value as string) : DEFAULT_PALETTE;
}

export const theme = signal<Theme>(storedTheme());
export const palette = signal<string>(storedPalette());

/**
 * The browser paints its own UI (address bar, status bar) from `theme-color`,
 * so a palette or scheme change has to move that meta tag too or the chrome
 * keeps the previous brand's colour. Read from the resolved token rather than a
 * table, so this cannot drift from the stylesheet.
 */
function syncThemeColor(): void {
  // With no preference set, the prerendered pair of media-scoped tags is
  // already correct and follows the system on its own. Rewriting them would
  // replace that with a value we then have to maintain by hand.
  if (theme.value === "system" && palette.value === DEFAULT_PALETTE) return;

  const root = document.documentElement;
  const bg = getComputedStyle(root).getPropertyValue("--c-bg").trim();
  if (!bg) return;
  for (const tag of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    // The prerendered document ships one tag per scheme. Once a scheme is
    // pinned those media conditions are wrong, so collapse to a single tag.
    if (tag.media) tag.removeAttribute("media");
    tag.content = bg;
  }
}

function apply(): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;

  if (theme.value === "system") root.removeAttribute("data-theme");
  else root.dataset.theme = theme.value;

  if (palette.value === DEFAULT_PALETTE) root.removeAttribute("data-palette");
  else root.dataset.palette = palette.value;

  syncThemeColor();
}

/** Viewport point an appearance change should spread from. */
export interface TransitionOrigin {
  x: number;
  y: number;
}

/** Centre of the control that was pressed, keyboard activation included. */
export function originOf(element: Element): TransitionOrigin {
  const rect = element.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

/**
 * Repaint the interface as a circle opening from the control that was pressed.
 *
 * The browser snapshots the page before and after, and `styles.css` clips the
 * new snapshot to a growing circle. A colour change is the one case where the
 * entire page changes at once, which reads as a glitch unless something ties
 * the new state back to the thing the user just touched.
 *
 * Falls back to applying the change outright where View Transitions are absent
 * or the reader has asked for reduced motion.
 */
export function withTransition(origin: TransitionOrigin | null, apply: () => void): void {
  // Declared by TypeScript's DOM lib but absent in Firefox and older Safari,
  // so the presence check is a real runtime branch rather than a type guard.
  const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  if (still || typeof document.startViewTransition !== "function") {
    apply();
    return;
  }
  if (origin) {
    const root = document.documentElement;
    root.style.setProperty("--theme-origin-x", `${origin.x}px`);
    root.style.setProperty("--theme-origin-y", `${origin.y}px`);
    // The circle has to finish exactly when it covers the viewport. A fixed
    // radius big enough for a corner origin (the usual `150vmax`) overshoots
    // every other origin, and the overshoot is spent off-screen: the part the
    // eye can see is over well before the animation is, which is what makes it
    // read as a flash rather than a sweep.
    const { innerWidth: w, innerHeight: h } = window;
    const radius = Math.hypot(Math.max(origin.x, w - origin.x), Math.max(origin.y, h - origin.y));
    root.style.setProperty("--theme-radius", `${Math.ceil(radius)}px`);
  }
  document.startViewTransition(apply).finished.catch(() => undefined);
}

export function setTheme(next: Theme, origin: TransitionOrigin | null = null): void {
  if (next === theme.value) return;
  withTransition(origin, () => {
    theme.value = next;
    write(THEME_KEY, next === "system" ? null : next);
    apply();
  });
}

export function setPalette(next: string, origin: TransitionOrigin | null = null): void {
  if (next === palette.value) return;
  withTransition(origin, () => {
    palette.value = next;
    write(PALETTE_KEY, next === DEFAULT_PALETTE ? null : next);
    apply();
  });
}

/**
 * Applied as early as the bundle runs. A strict `script-src 'self'` CSP rules
 * out the usual inline head script, so a stored preference that disagrees with
 * the system can show one frame of the system's choice first. That is the cost
 * of not loosening the CSP, and it is only paid by users who override.
 */
export function initAppearance(): void {
  apply();
  if (typeof window === "undefined") return;
  // A scheme change while set to "system" repaints tokens via the media query,
  // but `theme-color` is ours to keep in step.
  window.matchMedia?.("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (theme.value === "system") syncThemeColor();
  });
}
