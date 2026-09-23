import { signal } from "@preact/signals";
import { APP_PATH, navigate } from "./state/route";

interface InstalledAppLaunch {
  pathname: string;
  standaloneDisplayMode: boolean;
  iosStandalone: boolean;
}

/** Return the canonical app URL when an installed PWA is restored on the landing page. */
export function installedAppStartPath({
  pathname,
  standaloneDisplayMode,
  iosStandalone,
}: InstalledAppLaunch): string | undefined {
  if (pathname !== "/" || (!standaloneDisplayMode && !iosStandalone)) return undefined;
  return APP_PATH;
}

/** This document is running as the installed app rather than in a browser tab. */
function runningInstalled(): { standaloneDisplayMode: boolean; iosStandalone: boolean } {
  return {
    standaloneDisplayMode: window.matchMedia("(display-mode: standalone)").matches,
    // Safari exposes installed Home Screen apps through this non-standard flag.
    iosStandalone: (navigator as Navigator & { standalone?: boolean }).standalone === true,
  };
}

/** Keep the installed experience inside the app even when the browser restores `/`. */
export function redirectInstalledAppFromLanding(): void {
  const startPath = installedAppStartPath({ pathname: location.pathname, ...runningInstalled() });
  if (startPath) navigate(startPath, { replace: true });
}

// ---------------------------------------------------------------------------
// Installing
// ---------------------------------------------------------------------------

/**
 * How this browser installs a web app, when it cannot be asked to do it.
 *
 * Chromium browsers fire `beforeinstallprompt` and install in one tap; that
 * path needs no words. Everyone else installs from their own menus, and the
 * steps differ enough that a generic "use your browser's menu" leaves the
 * reader looking for it. Browsers
 * that cannot install at all — desktop Firefox — get no hint rather than a
 * false one.
 */
export function manualInstallHint({
  userAgent,
  maxTouchPoints,
}: {
  userAgent: string;
  maxTouchPoints: number;
}): string | undefined {
  // iPadOS reports itself as a Mac; the touch screen is what gives it away.
  const ios =
    /iPhone|iPad|iPod/.test(userAgent) || (/Macintosh/.test(userAgent) && maxTouchPoints > 1);
  // Every browser on iOS can add to the Home Screen, all through the share sheet.
  if (ios) return "Open the Share menu and choose “Add to Home Screen”.";

  if (/Android/.test(userAgent)) {
    return "Open the browser menu and choose “Install” or “Add to Home screen”.";
  }

  const safariVersion = /Version\/(\d+)[.\d]* Safari\//.exec(userAgent);
  const otherEngine = /Chrome|Chromium|CriOS|Edg|OPR|Firefox|FxiOS/.test(userAgent);
  // Safari on macOS installs web apps from Sonoma (Safari 17) on.
  if (/Macintosh/.test(userAgent) && safariVersion && !otherEngine) {
    return Number(safariVersion[1]) >= 17
      ? "In the menu bar, choose File → Add to Dock."
      : undefined;
  }

  return undefined;
}

/** Chromium's install prompt; not in the DOM lib because it is not standard. */
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

export type InstallOption =
  /** The browser can install on request: a button is enough. */
  | { kind: "prompt" }
  /** The reader has to do it from the browser's own UI, as described. */
  | { kind: "manual"; hint: string };

/** How this device can install the app, or `null` when it cannot (or already has). */
export const installOption = signal<InstallOption | null>(null);

let deferredPrompt: BeforeInstallPromptEvent | null = null;
let manualOption: InstallOption | null = null;

/**
 * Work out whether, and how, the app can be installed here.
 *
 * Called once at startup. The prompt event is kept rather than suppressed: the
 * browser's own install affordances (the address-bar icon, Android's
 * infobar) stay where users expect them, and the app offers the same prompt
 * from its menu for anyone who never noticed them.
 */
export function watchInstallability(): void {
  const { standaloneDisplayMode, iosStandalone } = runningInstalled();
  if (standaloneDisplayMode || iosStandalone) return;

  const hint = manualInstallHint({
    userAgent: navigator.userAgent,
    maxTouchPoints: navigator.maxTouchPoints,
  });
  manualOption = hint ? { kind: "manual", hint } : null;
  installOption.value = manualOption;

  window.addEventListener("beforeinstallprompt", (event) => {
    deferredPrompt = event as BeforeInstallPromptEvent;
    installOption.value = { kind: "prompt" };
  });
  window.addEventListener("appinstalled", () => {
    deferredPrompt = null;
    manualOption = null;
    installOption.value = null;
  });
}

/** Show the browser's install prompt. Only meaningful for a `prompt` option. */
export async function promptInstall(): Promise<void> {
  const event = deferredPrompt;
  if (!event) return;
  // A prompt event can be shown once. Until the browser offers another, a
  // reader who dismissed it can still install the way the browser's menu does.
  deferredPrompt = null;
  installOption.value = manualOption;
  await event.prompt();
}
