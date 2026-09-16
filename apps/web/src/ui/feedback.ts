import { useCallback, useEffect, useRef, useState } from "preact/hooks";

/** What a control that started an async action is currently saying. */
export type ActionState = "idle" | "busy" | "done";

/**
 * How long an action is given before it is worth a spinner. Below this it is
 * over within a frame or two, and a spinner that appears and vanishes reads as
 * a glitch rather than as progress.
 */
const BUSY_AFTER_MS = 120;
/** Once a spinner is up, it stays long enough to be read as one. */
const BUSY_MIN_MS = 320;
/** How long a confirmation holds before the control offers itself again. */
const DONE_MS = 1800;

/**
 * Run an async action and report it back through the control that started it:
 * a spinner while it is slow, then a confirmation for a beat.
 *
 * The action earns that confirmation by resolving `true`; resolving `false` (a
 * failure it has already reported as a toast) or rejecting just ends the wait.
 * Re-entry is refused until the control is back to `idle` — confirmation
 * included, since a save is usually over within a frame or two and the second
 * half of a double click would otherwise land on the check.
 */
export function useActionFeedback(action: () => Promise<boolean>): {
  state: ActionState;
  run: () => void;
} {
  const [state, setState] = useState<ActionState>("idle");
  // The caller rebuilds its action on every render (it closes over a message);
  // reading the latest one out of a ref is what keeps `run` stable.
  const latest = useRef(action);
  latest.current = action;
  const running = useRef(false);
  const timers = useRef<number[]>([]);
  const mounted = useRef(true);

  const after = useCallback((ms: number, fn: () => void): number => {
    const id = window.setTimeout(() => {
      timers.current = timers.current.filter((timer) => timer !== id);
      if (mounted.current) fn();
    }, ms);
    timers.current.push(id);
    return id;
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      // Nothing may land on a control that is no longer on screen — a bubble
      // can be deleted, or scrolled out of an unmounted view, mid-save.
      mounted.current = false;
      for (const timer of timers.current) clearTimeout(timer);
      timers.current = [];
    };
  }, []);

  const run = useCallback(() => {
    if (running.current) return;
    running.current = true;
    // Whatever is still on screen belongs to the previous run.
    for (const timer of timers.current) clearTimeout(timer);
    timers.current = [];
    setState("idle");

    let busySince = 0;
    const spinner = after(BUSY_AFTER_MS, () => {
      busySince = Date.now();
      setState("busy");
    });

    /** Back to offering itself, and open to being run again. */
    function release(): void {
      running.current = false;
      setState("idle");
    }

    function settle(confirmed: boolean): void {
      clearTimeout(spinner);
      if (!mounted.current) return;
      const hold = busySince ? Math.max(0, BUSY_MIN_MS - (Date.now() - busySince)) : 0;
      after(hold, () => {
        if (!confirmed) {
          release();
          return;
        }
        setState("done");
        // The lock outlives the action: a save is usually over in a frame or
        // two, so the second half of a double click lands on the check rather
        // than on the wait, and would save the same file all over again.
        after(DONE_MS, release);
      });
    }

    void latest.current().then(
      (confirmed) => settle(confirmed),
      () => settle(false),
    );
  }, [after]);

  return { state, run };
}
