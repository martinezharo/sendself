/**
 * How long this device keeps history.
 *
 * Without a limit IndexedDB only ever grows: every message, every received
 * file and every space notice stays until the space is left. The server cannot
 * help — it drops a message as soon as every device has it — so the only copy
 * of old history is the one on each device, and deleting it is that device's
 * decision alone. It never sends a deletion anywhere.
 *
 * The default is to keep everything, as before, because the alternative would
 * quietly delete what people thought they had kept. The choice is device-wide
 * (one phone has less room than one laptop, but its spaces share that room)
 * and is applied when a space opens and when the choice changes.
 */

import { signal } from "@preact/signals";
import { GLOBAL_HISTORY_RETENTION, globalMetaGet, globalMetaSet, listSpaces } from "../db/spaces";
import { pruneHistory } from "../db/store";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface RetentionOption {
  /** Days of history kept, or null to keep everything. */
  days: number | null;
  label: string;
}

export const RETENTION_OPTIONS: readonly RetentionOption[] = [
  { days: null, label: "Forever" },
  { days: 365, label: "1 year" },
  { days: 180, label: "6 months" },
  { days: 90, label: "3 months" },
  { days: 30, label: "1 month" },
];

/** The current choice, in days; null keeps everything. */
export const historyRetentionDays = signal<number | null>(null);

function validDays(value: unknown): number | null {
  return RETENTION_OPTIONS.some((option) => option.days === value) ? (value as number) : null;
}

/** Read the stored choice into the signal. Unknown or absent values mean "forever". */
export async function loadHistoryRetention(): Promise<number | null> {
  const days = validDays(await globalMetaGet<number>(GLOBAL_HISTORY_RETENTION));
  historyRetentionDays.value = days;
  return days;
}

/** The oldest `createdAt` still kept for `days`, measured from `now`. */
export function retentionCutoff(days: number, now = Date.now()): number {
  return now - days * DAY_MS;
}

/**
 * Apply the stored choice to one space (the open one when omitted). Cheap when
 * nothing is old enough: it reads only the rows below the cutoff.
 */
export async function applyHistoryRetention(spaceId?: string): Promise<number> {
  const days = await loadHistoryRetention();
  if (days === null) return 0;
  return pruneHistory(retentionCutoff(days), spaceId);
}

/**
 * Change the choice and apply it to every space on this device right away, so
 * the room it frees is freed now rather than whenever each space is next
 * opened. Returns how many messages were removed in total.
 */
export async function setHistoryRetention(days: number | null): Promise<number> {
  const choice = validDays(days);
  await globalMetaSet(GLOBAL_HISTORY_RETENTION, choice);
  historyRetentionDays.value = choice;
  if (choice === null) return 0;

  const cutoff = retentionCutoff(choice);
  let removed = 0;
  for (const space of await listSpaces()) {
    removed += await pruneHistory(cutoff, space.id);
  }
  return removed;
}
