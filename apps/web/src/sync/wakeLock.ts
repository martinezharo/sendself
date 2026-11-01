/**
 * Keep the screen on while a file upload is in progress.
 *
 * Once the screen goes off the page is frozen and the service worker takes the
 * rest of a selection over, which on iOS (no Background Sync, a worker that
 * outlives the page by seconds) and on a throttled Chrome means most of it
 * waits for the app to be reopened. Users found the workaround on their own:
 * keep the screen on. This does it for them, for exactly as long as an upload
 * is actually running — never for a queue that is stuck offline, which would
 * otherwise keep the screen lit indefinitely.
 *
 * A screen wake lock does not stop the user from turning the screen off, and
 * the browser drops it whenever the page is hidden. Both cases fall back to the
 * service worker handoff exactly as before.
 */

let sentinel: WakeLockSentinel | null = null;
let requesting = false;
let wanted = false;

function supported(): boolean {
  return typeof navigator !== "undefined" && "wakeLock" in navigator;
}

/** Hold (or let go of) the screen wake lock. Idempotent and never throws. */
export function holdScreenAwake(hold: boolean): void {
  wanted = hold;
  if (hold) void acquire();
  else release();
}

async function acquire(): Promise<void> {
  if (!supported() || sentinel || requesting || document.visibilityState !== "visible") return;
  requesting = true;
  try {
    const lock = await navigator.wakeLock.request("screen");
    if (!wanted) {
      // Released while the request was in flight: the upload already finished.
      void lock.release().catch(() => undefined);
      return;
    }
    sentinel = lock;
    lock.addEventListener("release", () => {
      if (sentinel === lock) sentinel = null;
    });
  } catch {
    // Denied (battery saver, permissions policy) or hidden meanwhile: the
    // upload simply runs without it, as it always did.
  } finally {
    requesting = false;
  }
}

function release(): void {
  const lock = sentinel;
  sentinel = null;
  void lock?.release().catch(() => undefined);
}
