import { Check, Download, Folder, FolderLock, X } from "lucide-preact";
import type { JSX } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import {
  type VaultEntry,
  entryName,
  moveItem,
  vaultEntries,
  visibleVaultEntries,
} from "../../state/vaultItems";
import { showToast } from "../../state/ui";
import { Button, IconButton, Modal, cx, useDialogFocus } from "../components";
import { folderOptions, groupChildren } from "./tree";

export function NameDialog({
  title,
  label,
  action,
  initial,
  onClose,
  onSubmit,
}: {
  title: string;
  label: string;
  action: string;
  initial: string;
  onClose: () => void;
  onSubmit: (name: string) => Promise<void>;
}): JSX.Element {
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  return (
    <Modal title={title} onClose={onClose}>
      <form
        class="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          const name = value.trim();
          if (!name) return;
          setBusy(true);
          void onSubmit(name).finally(() => setBusy(false));
        }}
      >
        <label class="flex flex-col gap-1.5 text-left">
          <span class="text-note font-medium text-subtle">{label}</span>
          <input
            type="text"
            class="field-input"
            value={value}
            maxLength={200}
            autoFocus
            onFocus={(event) => {
              // Renaming a file selects the name, not its extension.
              const input = event.currentTarget;
              const dot = input.value.lastIndexOf(".");
              input.setSelectionRange(0, dot > 0 ? dot : input.value.length);
            }}
            onInput={(event) => setValue((event.target as HTMLInputElement).value)}
          />
        </label>
        <div class="flex flex-col-reverse gap-2.5 sm:flex-row sm:justify-end">
          <Button class="sm:w-auto" variant="ghost" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button
            class="sm:w-auto"
            variant="primary"
            type="submit"
            disabled={busy || !value.trim()}
          >
            {action}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * Pick a destination folder from the same tree the vault shows, minus the item
 * itself and anything inside it. The keyboard and screen-reader way to do what
 * a drag does.
 */
export function MoveDialog({
  entry,
  onClose,
}: {
  entry: VaultEntry;
  onClose: () => void;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const entries = vaultEntries.value;
  const options = useMemo(() => {
    const records = new Map([...entries].map(([id, e]) => [id, e.record]));
    return folderOptions(groupChildren(visibleVaultEntries.value), entry, records);
  }, [entries, entry]);

  async function move(parentId: string | null): Promise<void> {
    setBusy(true);
    const moved = await moveItem(entry, parentId);
    setBusy(false);
    if (moved) {
      showToast(`Moved ${entryName(entry)}`);
      onClose();
    }
  }

  const destinations = [
    { id: null as string | null, label: "Vault", depth: 0, top: true },
    ...options.map((option) => ({
      id: option.entry.record.id as string | null,
      label: entryName(option.entry),
      depth: option.depth + 1,
      top: false,
    })),
  ];
  return (
    <Modal title={`Move ${entryName(entry)}`} onClose={onClose}>
      <ul class="-mx-2 flex flex-col" aria-label="Folders">
        {destinations.map((destination) => {
          const current = destination.id === entry.record.parentId;
          return (
            <li key={destination.id ?? "root"}>
              <button
                type="button"
                disabled={busy || current}
                onClick={() => void move(destination.id)}
                class="flex h-10 w-full items-center gap-2 rounded-lg pr-3 text-left text-note transition hover:bg-surface-3 disabled:cursor-default disabled:hover:bg-transparent"
                style={{ paddingLeft: `${10 + destination.depth * 18}px` }}
              >
                {destination.top ? (
                  <FolderLock class="size-4 flex-none text-subtle" aria-hidden="true" />
                ) : (
                  <Folder
                    class="size-4 flex-none fill-[color-mix(in_srgb,var(--c-accent)_18%,transparent)] text-accent"
                    aria-hidden="true"
                  />
                )}
                <span
                  class={cx(
                    "min-w-0 flex-1 truncate",
                    destination.top ? "font-medium" : "",
                    current && "text-muted",
                  )}
                >
                  {destination.label}
                </span>
                {current && (
                  <span class="flex items-center gap-1 text-caption text-muted">
                    <Check class="size-3.5" aria-hidden="true" />
                    Here now
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </Modal>
  );
}

export function ConfirmDialog({
  title,
  text,
  action,
  onClose,
  onConfirm,
}: {
  title: string;
  text: string;
  action: string;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  return (
    <Modal title={title} onClose={onClose}>
      <p class="text-body leading-relaxed text-subtle">{text}</p>
      <div class="flex flex-col-reverse gap-2.5 sm:flex-row sm:justify-end">
        <Button class="sm:w-auto" variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button
          class="sm:w-auto"
          variant="danger"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void onConfirm().finally(() => setBusy(false));
          }}
        >
          {action}
        </Button>
      </div>
    </Modal>
  );
}

/** An image from the vault, on its own over a dark backdrop. */
export function ImageViewer({
  name,
  url,
  onDownload,
  onClose,
}: {
  name: string;
  url: string;
  onDownload: () => void;
  onClose: () => void;
}): JSX.Element {
  const panelRef = useRef<HTMLDivElement>(null);
  useDialogFocus(panelRef);
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-modal="true"
      aria-label={name}
      tabIndex={-1}
      class="outline-none focus-visible:!shadow-none animate-fade-in fixed inset-0 z-50 flex flex-col bg-[color-mix(in_srgb,#050506_88%,transparent)] pt-[env(safe-area-inset-top)] text-white backdrop-blur-md"
      onClick={onClose}
    >
      <header
        class="flex h-14 flex-none items-center gap-2 px-3"
        onClick={(event) => event.stopPropagation()}
      >
        <span class="min-w-0 flex-1 truncate px-2 text-note font-medium">{name}</span>
        <IconButton label="Download" class="!text-white/80 hover:!bg-white/10" onClick={onDownload}>
          <Download />
        </IconButton>
        <IconButton label="Close" class="!text-white/80 hover:!bg-white/10" onClick={onClose}>
          <X />
        </IconButton>
      </header>
      <div class="grid min-h-0 flex-1 place-items-center p-4 pb-[calc(1rem+env(safe-area-inset-bottom))]">
        <img
          src={url}
          alt={name}
          class="animate-modal-in max-h-full max-w-full rounded-lg object-contain shadow-float"
          onClick={(event) => event.stopPropagation()}
        />
      </div>
    </div>
  );
}
