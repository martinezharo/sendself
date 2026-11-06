import { vaultPath as buildVaultPath } from "@sendself/client/vault";
import { ChevronRight, X } from "lucide-preact";
import type { JSX } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import {
  type VaultEntry,
  createNote,
  entryName,
  readNote,
  saveNote,
  vaultEntries,
} from "../../state/vaultItems";
import { showToast } from "../../state/ui";
import { Button, IconButton, Spinner, cx } from "../components";
import { formatDate } from "./format";

/** How the save shortcut is spelled on this platform. */
const SAVE_SHORTCUT =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘S" : "Ctrl S";

/**
 * A note, read and written in the same place, laid out like a page rather
 * than a form: no boxes, no rings, just the title and the text.
 *
 * Saving is explicit: a note is shared between devices, and a save is the
 * moment another device's edit is checked for, which should not happen behind
 * the user's back on every key.
 */
export function NoteEditor({
  entry,
  folderId,
  onClose,
}: {
  entry: VaultEntry | null;
  /** Where a new note goes. An existing one stays where it is. */
  folderId: string | null;
  onClose: () => void;
}): JSX.Element {
  const [title, setTitle] = useState(entry?.meta?.name ?? "");
  const [text, setText] = useState("");
  const [original, setOriginal] = useState<{ title: string; text: string } | null>(
    entry ? null : { title: "", text: "" },
  );
  const [saving, setSaving] = useState(false);
  const [confirmingClose, setConfirmingClose] = useState(false);
  const textRef = useRef<HTMLTextAreaElement>(null);
  // Read through a ref: the parent hands a new closure on every render, and
  // re-running the load for it would throw away what is being typed.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!entry) return;
    let cancelled = false;
    readNote(entry)
      .then((body) => {
        if (cancelled) return;
        setText(body);
        setOriginal({ title: entry.meta?.name ?? "", text: body });
      })
      .catch(() => {
        if (cancelled) return;
        showToast("Couldn't open this note. Check your connection and try again", "error");
        closeRef.current();
      });
    return () => {
      cancelled = true;
    };
  }, [entry]);

  // The text area grows with the note, so the page scrolls as one piece
  // instead of a box scrolling inside a box.
  useLayoutEffect(() => {
    const area = textRef.current;
    if (!area) return;
    area.style.height = "auto";
    area.style.height = `${area.scrollHeight}px`;
  }, [text, original]);

  const dirty = original !== null && (title !== original.title || text !== original.text);
  const requestCloseRef = useRef<() => void>(() => {});

  // On the document, not the panel: Escape has to work wherever focus is.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") requestCloseRef.current();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // A ref, not the state: the shortcut can fire twice before a re-render.
  const savingRef = useRef(false);

  /** Every way of saving (button, shortcut, the close prompt) goes through here. */
  async function save(): Promise<void> {
    // Still loading: the editor holds an empty draft, not the note.
    if (savingRef.current || original === null) return;
    if (entry && !dirty) {
      onClose();
      return;
    }
    // An empty new note is nothing to keep. An existing one emptied on purpose
    // is saved like any other edit.
    if (!entry && !text.trim() && !title.trim()) {
      onClose();
      return;
    }
    savingRef.current = true;
    setSaving(true);
    const saved = entry
      ? await saveNote(entry, title, text)
      : await createNote(folderId, title, text);
    savingRef.current = false;
    setSaving(false);
    if (saved) onClose();
  }

  function requestClose(): void {
    if (dirty) setConfirmingClose(true);
    else onClose();
  }
  requestCloseRef.current = requestClose;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  // The open editor is a step in the history of its own, so Back (the
  // browser's, or Android's) closes it rather than leaving the folder under
  // it, and asks first when there is something unsaved.
  useEffect(() => {
    const marker = { vaultNoteEditor: true };
    history.pushState(marker, "");
    let open = true;
    const onPop = (): void => {
      if (!open) return;
      if (dirtyRef.current) {
        history.pushState(marker, "");
        setConfirmingClose(true);
        return;
      }
      open = false;
      closeRef.current();
    };
    // Closing the tab or reloading cannot be held back, only warned about.
    const onUnload = (event: BeforeUnloadEvent): void => {
      if (dirtyRef.current) event.preventDefault();
    };
    window.addEventListener("popstate", onPop);
    window.addEventListener("beforeunload", onUnload);
    return () => {
      window.removeEventListener("popstate", onPop);
      window.removeEventListener("beforeunload", onUnload);
      // Closed from inside (Save, Discard, the close button): take back the
      // step it added, so Back afterwards means what it meant before.
      if (open && (history.state as typeof marker | null)?.vaultNoteEditor) history.back();
    };
  }, []);

  const where = [
    "Vault",
    ...buildVaultPath(vaultEntries.value, entry ? entry.record.parentId : folderId).map(entryName),
  ];
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  const status = saving
    ? "Saving…"
    : original === null
      ? "Opening…"
      : dirty
        ? "Unsaved changes"
        : entry
          ? `Saved ${formatDate(entry.record.updatedAt)}`
          : "New note";

  return (
    <div
      class="animate-fade-in fixed inset-0 z-50 flex items-center justify-center bg-[color-mix(in_srgb,#0a0a0c_60%,transparent)] backdrop-blur-[6px] md:p-6"
      onClick={requestClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={entry ? `Note: ${title || "Untitled"}` : "New note"}
        class="animate-modal-in flex h-full w-full flex-col overflow-hidden bg-elevated pt-[env(safe-area-inset-top)] md:h-[min(860px,calc(100dvh-3rem))] md:max-w-[780px] md:rounded-xl3 md:border md:border-line md:pt-0 md:shadow-float"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "s" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void save();
          }
        }}
      >
        <header class="flex h-14 flex-none items-center gap-1.5 px-2 md:px-3">
          <IconButton label="Close" onClick={requestClose}>
            <X />
          </IconButton>
          <ol
            aria-label="Saved in"
            class="flex min-w-0 flex-1 items-center gap-1 text-caption text-muted"
          >
            {where.map((part, index) => (
              <li
                // biome-ignore lint/suspicious/noArrayIndexKey: a path, read once
                key={index}
                class={cx(
                  "flex min-w-0 items-center gap-1",
                  index < where.length - 1 ? "flex-none max-sm:hidden" : "",
                )}
              >
                {index > 0 && (
                  <ChevronRight aria-hidden="true" class="size-3 flex-none max-sm:hidden" />
                )}
                <span class="truncate">{part}</span>
              </li>
            ))}
          </ol>
          <span
            role="status"
            class={cx(
              "flex flex-none items-center gap-1.5 px-2 text-caption",
              dirty ? "text-subtle" : "text-muted",
            )}
          >
            {dirty && !saving && (
              <span class="size-1.5 rounded-full bg-accent" aria-hidden="true" />
            )}
            {status}
          </span>
          <Button
            size="sm"
            variant="primary"
            class="!shadow-none"
            title={`Save (${SAVE_SHORTCUT})`}
            disabled={saving || original === null || (!dirty && entry !== null)}
            onClick={() => void save()}
          >
            {saving ? <Spinner class="size-4" /> : null}
            Save
          </Button>
        </header>

        {confirmingClose && (
          <div class="animate-fade-in mx-3 mb-2 flex flex-none flex-wrap items-center gap-2 rounded-card border border-line bg-surface-3 py-2 pl-3.5 pr-2 text-note md:mx-4">
            <span class="flex-1 text-ink">Save your changes to this note?</span>
            <Button size="sm" variant="ghost" onClick={onClose}>
              Discard
            </Button>
            <Button size="sm" variant="primary" class="!shadow-none" onClick={() => void save()}>
              Save
            </Button>
          </div>
        )}

        {original === null ? (
          <div class="grid flex-1 place-items-center">
            <Spinner large class="text-accent" />
          </div>
        ) : (
          <div
            class="min-h-0 flex-1 cursor-text overflow-y-auto border-t border-line"
            // A click below the last line still means "write here".
            onClick={(event) => {
              if (event.target === event.currentTarget) textRef.current?.focus();
            }}
          >
            <div class="mx-auto flex w-full max-w-[66ch] flex-col px-5 pb-24 pt-7 md:px-10 md:pt-10">
              <input
                type="text"
                value={title}
                maxLength={200}
                placeholder="Untitled"
                aria-label="Title"
                // Read-only while saving: what is on screen must be what was saved,
                // or closing on success would drop whatever was typed meanwhile.
                readOnly={saving}
                autoFocus={entry === null}
                class="vault-page-field w-full bg-transparent font-display text-[1.75rem] font-semibold leading-tight tracking-[-0.03em] text-ink placeholder:text-muted/50 md:text-[2rem]"
                onInput={(event) => setTitle((event.target as HTMLInputElement).value)}
                onKeyDown={(event) => {
                  // Enter in the title moves on to the text, as in any editor.
                  if (event.key === "Enter") {
                    event.preventDefault();
                    textRef.current?.focus();
                  }
                }}
              />
              <p class="mb-5 mt-2 text-caption tabular-nums text-muted">
                {words === 1 ? "1 word" : `${words} words`}
              </p>
              <textarea
                ref={textRef}
                value={text}
                placeholder="Start writing…"
                aria-label="Note"
                readOnly={saving}
                rows={8}
                class="vault-page-field w-full resize-none overflow-hidden bg-transparent text-lead leading-[1.75] text-ink placeholder:text-muted/50 md:text-[1.0625rem]"
                onInput={(event) => setText((event.target as HTMLTextAreaElement).value)}
              />
            </div>
          </div>
        )}

        <footer class="flex h-9 flex-none items-center justify-end gap-4 border-t border-line px-4 text-meta text-muted max-md:hidden">
          <span>
            <kbd class="font-mono">{SAVE_SHORTCUT}</kbd> save
          </span>
          <span>
            <kbd class="font-mono">Esc</kbd> close
          </span>
        </footer>
      </div>
    </div>
  );
}
