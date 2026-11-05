import { Upload } from "lucide-preact";
import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import { getDroppedFiles, hasTransferFiles } from "../share/transfer";
import { stageFiles } from "../state/composer";
import { route, showSpaceSection } from "../state/route";
import { uploadFiles } from "../state/vaultItems";
import { session } from "../state/session";
import { showToast } from "../state/ui";

/**
 * Whole-window drag & drop: files dropped anywhere in the app land in the
 * composer's queue, no need to aim at it.
 *
 * The listeners live on `window` (capture phase) rather than on a wrapper
 * element so that dropping over any part of the UI — sidebar, modals, the
 * device list — behaves the same, and so a stray drop can never fall through to
 * the browser's default of navigating away from the app to open the file.
 */
export function DropZone(): JSX.Element | null {
  const [active, setActive] = useState(false);

  useEffect(() => {
    // `dragenter`/`dragleave` fire again for every element the pointer crosses,
    // so the overlay is driven by a depth counter instead of the last event.
    let depth = 0;

    const reset = (): void => {
      depth = 0;
      setActive(false);
    };

    const onDragEnter = (event: DragEvent): void => {
      if (!hasTransferFiles(event.dataTransfer)) return;
      event.preventDefault();
      depth++;
      setActive(true);
    };

    const onDragOver = (event: DragEvent): void => {
      if (!hasTransferFiles(event.dataTransfer)) return;
      // Both the preventDefault and the drop effect are required for the drop
      // to be accepted, and must be reapplied on every dragover.
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    };

    const onDragLeave = (event: DragEvent): void => {
      if (!hasTransferFiles(event.dataTransfer)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setActive(false);
    };

    const onDrop = (event: DragEvent): void => {
      if (!hasTransferFiles(event.dataTransfer)) return;
      event.preventDefault();
      reset();
      void acceptDrop(event.dataTransfer);
    };

    window.addEventListener("dragenter", onDragEnter, true);
    window.addEventListener("dragover", onDragOver, true);
    window.addEventListener("dragleave", onDragLeave, true);
    window.addEventListener("drop", onDrop, true);
    // A drag that ends outside the window (cancelled, or dropped on another
    // app) leaves no dragleave behind — these are the only hints we get.
    window.addEventListener("dragend", reset, true);
    window.addEventListener("blur", reset);

    return () => {
      window.removeEventListener("dragenter", onDragEnter, true);
      window.removeEventListener("dragover", onDragOver, true);
      window.removeEventListener("dragleave", onDragLeave, true);
      window.removeEventListener("drop", onDrop, true);
      window.removeEventListener("dragend", reset, true);
      window.removeEventListener("blur", reset);
    };
  }, []);

  // Without a space there is nowhere to send to: the drop is still swallowed
  // (see `acceptDrop`), but promising "drop to send" would be a lie.
  if (!active || !session.value) return null;

  return (
    <div
      class="animate-fade-in pointer-events-none fixed inset-0 z-[60] grid place-items-center bg-[color-mix(in_srgb,#0a0a0c_45%,transparent)] p-6 backdrop-blur-[3px]"
      aria-hidden="true"
    >
      <div class="surface-card flex flex-col items-center gap-3.5 rounded-xl2 border-2 border-dashed border-accent px-9 py-8 text-center !shadow-pop">
        <div class="grid size-14 place-items-center rounded-xl2 bg-accent-soft text-accent [&_svg]:size-[26px]">
          <Upload />
        </div>
        {inVault() ? (
          <>
            <h3 class="text-title">Drop to save</h3>
            <p class="max-w-[280px] text-body leading-relaxed text-muted">
              They're encrypted and kept in this folder of the vault.
            </p>
          </>
        ) : (
          <>
            <h3 class="text-title">Drop to attach</h3>
            <p class="max-w-[280px] text-body leading-relaxed text-muted">
              They go to the composer first, so you can add a comment before sending.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

async function acceptDrop(data: DataTransfer | null): Promise<void> {
  if (!session.value) {
    showToast("Set up this space first, then drop your files.", "error");
    return;
  }

  const files = await getDroppedFiles(data);
  if (files.length === 0) {
    showToast("Nothing to send — that drop had no files", "error");
    return;
  }

  // In the vault a drop means "keep these here", in the folder on screen.
  const current = route.value;
  if (inVault() && current.name === "space" && current.vault && "folderId" in current.vault) {
    const saved = await uploadFiles(current.vault.folderId, files);
    if (saved > 0) showToast(saved === 1 ? "Saved to the vault" : `${saved} files saved`);
    return;
  }

  // Land on the chat, which is where the queue they just joined is shown.
  showSpaceSection("chat");
  stageFiles(files);
}

/** Whether a drop right now would land in a vault folder (the trash takes none). */
function inVault(): boolean {
  const current = route.value;
  return (
    current.name === "space" &&
    current.section === "vault" &&
    !!current.vault &&
    "folderId" in current.vault
  );
}
