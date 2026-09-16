/**
 * How a transfer that failed for a transient reason waits before trying again.
 *
 * Shared by both directions on purpose: an outgoing send and an incoming file's
 * download are the same problem seen from either end — something that will
 * probably work later, driven by a loop that comes round every few seconds.
 * Without a wait, "later" is "in eight seconds, forever": up to 50 MB
 * re-encrypted and re-uploaded (or re-downloaded) on every pass, for as long as
 * the condition lasts, on a phone's battery and data.
 */

import type { RetrySchedule } from "../types";

/** The wait after the first failure. It doubles from there. */
export const FIRST_WAIT_MS = 5_000;
/** The ceiling: past this, waiting longer only makes the app look broken. */
export const MAX_WAIT_MS = 5 * 60_000;

/** The schedule after one more failure. */
export function backOff(previous: RetrySchedule | undefined, now = Date.now()): RetrySchedule {
  const attempts = (previous?.attempts ?? 0) + 1;
  const wait = Math.min(FIRST_WAIT_MS * 2 ** (attempts - 1), MAX_WAIT_MS);
  return { attempts, notBefore: now + wait };
}

/** Whether a scheduled retry may run yet. No schedule means "always". */
export function retryDue(schedule: RetrySchedule | undefined, now = Date.now()): boolean {
  return !schedule || schedule.notBefore <= now;
}

/**
 * Whether a failure that just happened should count against the backoff.
 *
 * A device with no network is not a server refusing to cooperate: everything
 * fails at once, instantly and identically, and counting that would leave the
 * whole queue serving a five-minute wait it earned inside a tunnel. Coming back
 * online re-runs a pass immediately (see `startSync`), and that pass has to be
 * allowed to send.
 *
 * Only a device that says outright that it is offline is excused. "Don't know"
 * counts as online: every context this runs in (window, service worker) does
 * define `onLine`, and the safe reading of a missing answer is the one that
 * keeps backing off a server that is genuinely refusing.
 */
export function failureCounts(): boolean {
  return typeof navigator === "undefined" || navigator.onLine !== false;
}
