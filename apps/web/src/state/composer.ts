/**
 * What the composer is holding but has not sent yet: the draft text, the
 * staged attachments, and whether the next send is view-once.
 *
 * It lives outside the component because four different places fill it and
 * only one of them is the composer itself — the file picker, a paste, a
 * whole-window drop (ui/DropZone.tsx) and the OS share sheet
 * (`consumeSharedContent`). Before this, each of those sent its files
 * straight away, so a drop could never carry a caption and two of them could
 * not be reviewed at all.
 */

import { MAX_FILE_SIZE } from "@sendself/shared";
import { signal } from "@preact/signals";
import { randomId } from "../crypto/crypto";
import { showToast } from "./ui";

/** One attachment waiting to be sent. `id` is local and never leaves the app. */
export interface StagedFile {
  id: string;
  file: File;
}

/** Text to push into the composer (e.g. from the Web Share Target). */
export const composerDraft = signal<string>("");

/** Attachments picked but not yet sent, in the order they were added. */
export const stagedFiles = signal<StagedFile[]>([]);

/**
 * Whether the next send is a view-once message.
 *
 * Sticky until it is turned off or the space is left, rather than resetting
 * after every send: sending three files one after the other is a real case,
 * and the composer shows the armed state loudly enough that it cannot be
 * forgotten.
 */
export const viewOnceArmed = signal(false);

const MAX_MB = Math.floor(MAX_FILE_SIZE / 1024 / 1024);

/**
 * Add files to the queue, dropping the ones that are too large to ever send.
 *
 * Rejecting per file rather than per selection is deliberate: picking six
 * photos and one oversized video should send the six, which is exactly what a
 * single bundled upload could never do.
 */
export function stageFiles(files: readonly File[]): number {
  const accepted = files.filter((file) => file.size <= MAX_FILE_SIZE);
  const rejected = files.length - accepted.length;
  if (rejected > 0) {
    showToast(
      `${rejected === 1 ? "1 file is" : `${rejected} files are`} too large (max ${MAX_MB} MB)`,
      "error",
    );
  }
  if (accepted.length === 0) return 0;

  stagedFiles.value = [...stagedFiles.value, ...accepted.map((file) => ({ id: randomId(), file }))];
  return accepted.length;
}

export function unstageFile(id: string): void {
  stagedFiles.value = stagedFiles.value.filter((staged) => staged.id !== id);
}

/**
 * Empty the composer's content after a send.
 *
 * `viewOnceArmed` deliberately survives: sending several temporary messages in
 * a row is a real case, and the armed composer is loud enough (a banner, a
 * ring and a badge on the send button) that it cannot be armed by accident and
 * forgotten. Disarming is always one tap away.
 */
export function clearComposer(): void {
  composerDraft.value = "";
  stagedFiles.value = [];
}

/**
 * Forget everything, including the mode. For leaving a space: the toggle is
 * sticky within one conversation, not across them.
 */
export function resetComposer(): void {
  clearComposer();
  viewOnceArmed.value = false;
}
