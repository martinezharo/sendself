import {
  ArchiveRestore,
  ChevronRight,
  Download,
  Folder,
  FolderInput,
  FolderPlus,
  Lock,
  MoreVertical,
  NotebookPen,
  Pencil,
  Plus,
  RotateCcw,
  Trash2,
  Upload,
  X,
} from "lucide-preact";
import type { ComponentChildren, JSX } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { VAULT_TRASH_TTL_MS } from "@sendself/shared";
import { vaultPath as buildVaultPath, vaultSubtree } from "@sendself/client/vault";
import { type VaultLocation, followLink, navigate, vaultPath } from "../state/route";
import { activeSpace } from "../state/spaces";
import {
  type VaultEntry,
  createFolder,
  createNote,
  deleteForever,
  emptyTrash,
  entryName,
  moveItem,
  openContent,
  readNote,
  renameItem,
  restoreItem,
  saveNote,
  trashItem,
  trashedVaultEntries,
  uploadFiles,
  vaultEntries,
  vaultQuota,
  vaultSpace,
  vaultUploads,
  vaultUsage,
  visibleVaultEntries,
} from "../state/vaultItems";
import { showToast } from "../state/ui";
import { downloadBlob } from "../share/download";
import { Menu, type MenuAnchor, MenuItem, MenuSeparator, anchorBelow } from "./Menu";
import { Button, FileTypeIcon, IconButton, Modal, Spinner, cx, formatBytes } from "./components";

/** What is open over the listing, if anything. */
type Dialog =
  | { kind: "note"; entry: VaultEntry | null }
  | { kind: "folder" }
  | { kind: "rename"; entry: VaultEntry }
  | { kind: "move"; entry: VaultEntry }
  | { kind: "image"; entry: VaultEntry; url: string }
  | { kind: "delete"; entry: VaultEntry }
  | { kind: "empty-trash" };

export function Vault({ location }: { location: VaultLocation }): JSX.Element {
  const spaceId = activeSpace.value?.id ?? "";
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [menu, setMenu] = useState<{ entry: VaultEntry; anchor: MenuAnchor } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const inTrash = "trash" in location;
  const folderId = inTrash ? null : location.folderId;
  const visible = visibleVaultEntries.value;
  const folder = folderId ? visible.find((entry) => entry.record.id === folderId) : undefined;

  // Object URLs for previews are released with the dialog that showed them.
  useEffect(
    () => () => {
      if (dialog?.kind === "image") URL.revokeObjectURL(dialog.url);
    },
    [dialog],
  );

  if (vaultSpace.value !== spaceId) {
    return (
      <div class="grid flex-1 place-items-center">
        <Spinner large class="text-accent" />
      </div>
    );
  }

  const children = inTrash
    ? trashedVaultEntries.value
    : visible.filter((entry) => entry.record.parentId === folderId);
  const folders = children
    .filter((entry) => entry.record.kind === "folder")
    .sort((a, b) => entryName(a).localeCompare(entryName(b)));
  const items = children
    .filter((entry) => entry.record.kind !== "folder")
    .sort((a, b) => b.record.updatedAt - a.record.updatedAt);

  async function open(entry: VaultEntry): Promise<void> {
    if (!entry.meta) {
      showToast("This item opens once this device receives the space's current key", "error");
      return;
    }
    if (entry.record.kind === "folder") {
      navigate(vaultPath(spaceId, { folderId: entry.record.id }));
      return;
    }
    if (entry.record.kind === "note") {
      setDialog({ kind: "note", entry });
      return;
    }
    try {
      const blob = await openContent(entry);
      if (entry.meta.mime?.startsWith("image/")) {
        setDialog({ kind: "image", entry, url: URL.createObjectURL(blob) });
      } else {
        downloadBlob(blob, entry.meta.name);
      }
    } catch {
      showToast("Couldn't open this file. Check your connection and try again", "error");
    }
  }

  async function download(entry: VaultEntry): Promise<void> {
    try {
      downloadBlob(await openContent(entry), entryName(entry));
    } catch {
      showToast("Couldn't download this file. Check your connection and try again", "error");
    }
  }

  function onPick(event: Event): void {
    const input = event.currentTarget as HTMLInputElement;
    const files = [...(input.files ?? [])];
    input.value = "";
    if (files.length === 0) return;
    void uploadFiles(folderId, files).then((saved) => {
      if (saved > 0) showToast(saved === 1 ? "Saved to the vault" : `${saved} files saved`);
    });
  }

  const missingFolder = folderId !== null && !folder;

  return (
    <div class="min-h-0 flex-1 overflow-y-auto p-6 max-md:p-[14px]">
      <div class="mx-auto flex max-w-[760px] flex-col gap-5">
        <div class="flex items-center justify-between gap-3">
          <Breadcrumbs spaceId={spaceId} location={location} />
          {inTrash
            ? trashedVaultEntries.value.length > 0 && (
                <Button
                  size="sm"
                  variant="danger"
                  class="flex-none"
                  onClick={() => setDialog({ kind: "empty-trash" })}
                >
                  Empty trash
                </Button>
              )
            : !missingFolder && (
                <AddButton
                  onNote={() => setDialog({ kind: "note", entry: null })}
                  onFolder={() => setDialog({ kind: "folder" })}
                  onUpload={() => fileInput.current?.click()}
                />
              )}
          <input ref={fileInput} type="file" multiple hidden onChange={onPick} />
        </div>

        {vaultUploads.value > 0 && (
          <div
            role="status"
            class="flex items-center gap-2.5 rounded-card bg-accent-soft px-4 py-3 text-note font-medium text-accent"
          >
            <Spinner class="size-4" />
            {vaultUploads.value === 1
              ? "Encrypting and saving 1 file…"
              : `Encrypting and saving ${vaultUploads.value} files…`}
          </div>
        )}

        {missingFolder ? (
          <EmptyState
            title="This folder is gone"
            text="It was deleted or moved to the trash on one of your devices."
          >
            <a
              class="text-note font-medium text-accent underline-offset-4 hover:underline"
              href={vaultPath(spaceId, { folderId: null })}
              onClick={(event) =>
                followLink(event as unknown as MouseEvent, vaultPath(spaceId, { folderId: null }))
              }
            >
              Back to the vault
            </a>
          </EmptyState>
        ) : children.length === 0 ? (
          inTrash ? (
            <EmptyState
              title="The trash is empty"
              text="Deleted items wait here for 30 days, then they're gone for good."
            />
          ) : (
            <EmptyState
              title={folderId ? "This folder is empty" : "Keep things here"}
              text={
                folderId
                  ? "Add a note or upload a file to keep it here."
                  : "Notes and files you save here stay until you delete them, on every device in this space. Only your devices can read them."
              }
            >
              <div class="flex flex-wrap justify-center gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => setDialog({ kind: "note", entry: null })}
                >
                  <NotebookPen aria-hidden="true" />
                  New note
                </Button>
                <Button size="sm" variant="secondary" onClick={() => fileInput.current?.click()}>
                  <Upload aria-hidden="true" />
                  Upload files
                </Button>
              </div>
            </EmptyState>
          )
        ) : (
          <>
            {folders.length > 0 && (
              <ul class="grid grid-cols-2 gap-2.5 sm:grid-cols-3" aria-label="Folders">
                {folders.map((entry) => (
                  <li key={entry.record.id}>
                    <FolderTile
                      entry={entry}
                      count={
                        visible.filter((child) => child.record.parentId === entry.record.id).length
                      }
                      inTrash={inTrash}
                      onOpen={() => void open(entry)}
                      onMenu={(anchor) => setMenu({ entry, anchor })}
                    />
                  </li>
                ))}
              </ul>
            )}
            {items.length > 0 && (
              <ul
                class="surface-card flex flex-col overflow-hidden rounded-xl2"
                aria-label="Notes and files"
              >
                {items.map((entry) => (
                  <li key={entry.record.id} class="border-b border-line last:border-b-0">
                    <ItemRow
                      entry={entry}
                      onOpen={() => void (inTrash ? undefined : open(entry))}
                      onMenu={(anchor) => setMenu({ entry, anchor })}
                    />
                  </li>
                ))}
              </ul>
            )}
          </>
        )}

        <VaultFooter spaceId={spaceId} inTrash={inTrash} />
      </div>

      {menu && (
        <ItemMenu
          entry={menu.entry}
          anchor={menu.anchor}
          inTrash={inTrash}
          onClose={() => setMenu(null)}
          onOpen={() => void open(menu.entry)}
          onDownload={() => void download(menu.entry)}
          onDialog={setDialog}
        />
      )}

      {dialog?.kind === "note" && (
        <NoteEditor entry={dialog.entry} folderId={folderId} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === "folder" && (
        <NameDialog
          title="New folder"
          label="Folder name"
          action="Create folder"
          initial=""
          onClose={() => setDialog(null)}
          onSubmit={async (name) => {
            const created = await createFolder(folderId, name);
            if (created) setDialog(null);
          }}
        />
      )}
      {dialog?.kind === "rename" && (
        <NameDialog
          title="Rename"
          label="Name"
          action="Rename"
          initial={entryName(dialog.entry)}
          onClose={() => setDialog(null)}
          onSubmit={async (name) => {
            if (await renameItem(dialog.entry, name)) setDialog(null);
          }}
        />
      )}
      {dialog?.kind === "move" && (
        <MoveDialog entry={dialog.entry} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === "image" && (
        <Modal title={entryName(dialog.entry)} onClose={() => setDialog(null)}>
          <img
            src={dialog.url}
            alt={entryName(dialog.entry)}
            class="max-h-[60dvh] w-full rounded-card bg-surface-3 object-contain"
          />
          <Button variant="secondary" onClick={() => void download(dialog.entry)}>
            <Download aria-hidden="true" />
            Download
          </Button>
        </Modal>
      )}
      {dialog?.kind === "delete" && (
        <ConfirmDialog
          title="Delete for good?"
          text={`${entryName(dialog.entry)}${dialog.entry.record.kind === "folder" ? " and everything in it" : ""} will be removed from every device in this space. This can't be undone.`}
          action="Delete for good"
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            await deleteForever(dialog.entry);
            setDialog(null);
          }}
        />
      )}
      {dialog?.kind === "empty-trash" && (
        <ConfirmDialog
          title="Empty the trash?"
          text="Everything in the trash will be removed from every device in this space. This can't be undone."
          action="Empty trash"
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            await emptyTrash();
            setDialog(null);
          }}
        />
      )}
    </div>
  );
}

/**
 * Where the listing is, as a path the user can climb back up. It doubles as
 * the page title: on a phone the header only says "Vault", and a folder three
 * levels down is lost without it.
 */
function Breadcrumbs({
  spaceId,
  location,
}: { spaceId: string; location: VaultLocation }): JSX.Element {
  const entries = vaultEntries.value;
  // At the top level the header already says "Vault": say what it is instead.
  if (!("trash" in location) && location.folderId === null) {
    return (
      <p class="min-w-0 max-w-[46ch] text-note leading-5 text-muted">
        Notes and files kept on every device in this space, encrypted so only your devices can read
        them.
      </p>
    );
  }
  const path = "trash" in location ? [] : buildVaultPath(entries, location.folderId);
  const crumbs: Array<{ label: string; href: string }> = [
    { label: "Vault", href: vaultPath(spaceId, { folderId: null }) },
    ...("trash" in location
      ? [{ label: "Trash", href: vaultPath(spaceId, { trash: true }) }]
      : path.map((entry) => ({
          label: entryName(entry),
          href: vaultPath(spaceId, { folderId: entry.record.id }),
        }))),
  ];

  return (
    <nav aria-label="Location in the vault" class="min-w-0">
      <ol class="flex min-w-0 items-center gap-1 font-display text-title-lg font-semibold tracking-[-0.025em]">
        {crumbs.map((crumb, index) => {
          const last = index === crumbs.length - 1;
          return (
            <li
              key={crumb.href}
              class={cx(
                "flex min-w-0 items-center gap-1",
                !last && "flex-none",
                // A phone keeps the folder and its parent: the way up is one tap.
                index < crumbs.length - 2 && "max-sm:hidden",
              )}
            >
              {last ? (
                <span aria-current="page" class="truncate">
                  {crumb.label}
                </span>
              ) : (
                <>
                  <a
                    href={crumb.href}
                    onClick={(event) => followLink(event as unknown as MouseEvent, crumb.href)}
                    class="max-w-[12ch] truncate text-muted transition hover:text-ink"
                  >
                    {crumb.label}
                  </a>
                  <ChevronRight aria-hidden="true" class="size-4 flex-none text-muted" />
                </>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function AddButton({
  onNote,
  onFolder,
  onUpload,
}: {
  onNote: () => void;
  onFolder: () => void;
  onUpload: () => void;
}): JSX.Element {
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null);
  const run = (action: () => void) => (): void => {
    setAnchor(null);
    action();
  };
  return (
    <>
      <Button
        size="sm"
        variant="primary"
        class="flex-none"
        aria-haspopup="menu"
        aria-expanded={anchor !== null}
        onClick={(event) => setAnchor(anchorBelow(event.currentTarget as HTMLElement))}
      >
        <Plus aria-hidden="true" />
        Add
      </Button>
      {anchor && (
        <Menu anchor={anchor} alignRight label="Add to the vault" onClose={() => setAnchor(null)}>
          <MenuItem icon={<NotebookPen />} onClick={run(onNote)}>
            New note
          </MenuItem>
          <MenuItem icon={<Upload />} onClick={run(onUpload)}>
            Upload files
          </MenuItem>
          <MenuItem icon={<FolderPlus />} onClick={run(onFolder)}>
            New folder
          </MenuItem>
        </Menu>
      )}
    </>
  );
}

function FolderTile({
  entry,
  count,
  inTrash,
  onOpen,
  onMenu,
}: {
  entry: VaultEntry;
  count: number;
  inTrash: boolean;
  onOpen: () => void;
  onMenu: (anchor: MenuAnchor) => void;
}): JSX.Element {
  return (
    <div class="surface-card group relative flex h-full items-center gap-3 rounded-xl2 py-3 pl-3.5 pr-1.5 transition hover:shadow-pop">
      <button
        type="button"
        onClick={inTrash ? undefined : onOpen}
        disabled={inTrash}
        class="flex min-w-0 flex-1 items-center gap-3 text-left after:absolute after:inset-0 after:rounded-xl2 disabled:cursor-default"
      >
        <span class="grid size-10 flex-none place-items-center rounded-[12px] bg-accent-soft text-accent [&_svg]:size-5">
          {entry.meta ? <Folder /> : <Lock />}
        </span>
        <span class="min-w-0">
          <span class="block truncate text-body font-medium">{entryName(entry)}</span>
          <span class="block text-caption text-muted">
            {inTrash
              ? trashedLabel(entry)
              : count === 0
                ? "Empty"
                : count === 1
                  ? "1 item"
                  : `${count} items`}
          </span>
        </span>
      </button>
      <IconButton
        label={`Options for ${entryName(entry)}`}
        class="relative z-[1] flex-none"
        onClick={(event) => onMenu(anchorBelow(event.currentTarget as HTMLElement))}
      >
        <MoreVertical />
      </IconButton>
    </div>
  );
}

function ItemRow({
  entry,
  onOpen,
  onMenu,
}: {
  entry: VaultEntry;
  onOpen: () => void;
  onMenu: (anchor: MenuAnchor) => void;
}): JSX.Element {
  const { record, meta } = entry;
  const detail = !meta
    ? "Opens once this device has the space's current key"
    : record.trashedAt !== null
      ? trashedLabel(entry)
      : record.kind === "note"
        ? meta.excerpt || "Empty note"
        : `${formatBytes(meta.size ?? 0)}, ${formatDate(record.updatedAt)}`;

  return (
    <div class="relative flex items-center gap-3 py-2.5 pl-3.5 pr-1.5 transition hover:bg-surface-2">
      <button
        type="button"
        onClick={onOpen}
        class="flex min-w-0 flex-1 items-center gap-3 text-left after:absolute after:inset-0"
      >
        <span
          class={cx(
            "grid size-10 flex-none place-items-center rounded-[12px] [&_svg]:size-5",
            record.kind === "note"
              ? "bg-[color-mix(in_srgb,var(--c-warning)_16%,transparent)] text-ink"
              : "bg-surface-3 text-subtle",
          )}
        >
          {!meta ? (
            <Lock />
          ) : record.kind === "note" ? (
            <NotebookPen />
          ) : (
            <FileTypeIcon mime={meta.mime ?? ""} />
          )}
        </span>
        <span class="min-w-0 flex-1">
          <span class="block truncate text-body font-medium">{entryName(entry)}</span>
          <span
            class={cx(
              "block text-caption text-muted",
              record.kind === "note" ? "line-clamp-1" : "truncate",
            )}
          >
            {detail}
          </span>
        </span>
      </button>
      <IconButton
        label={`Options for ${entryName(entry)}`}
        class="relative z-[1] flex-none"
        onClick={(event) => onMenu(anchorBelow(event.currentTarget as HTMLElement))}
      >
        <MoreVertical />
      </IconButton>
    </div>
  );
}

function ItemMenu({
  entry,
  anchor,
  inTrash,
  onClose,
  onOpen,
  onDownload,
  onDialog,
}: {
  entry: VaultEntry;
  anchor: MenuAnchor;
  inTrash: boolean;
  onClose: () => void;
  onOpen: () => void;
  onDownload: () => void;
  onDialog: (dialog: Dialog) => void;
}): JSX.Element {
  const run = (action: () => void) => (): void => {
    onClose();
    action();
  };
  const readable = entry.meta !== null;

  if (inTrash) {
    return (
      <Menu anchor={anchor} alignRight label="Item actions" onClose={onClose}>
        <MenuItem icon={<ArchiveRestore />} onClick={run(() => void restoreItem(entry))}>
          Restore
        </MenuItem>
        <MenuSeparator />
        <MenuItem danger icon={<Trash2 />} onClick={run(() => onDialog({ kind: "delete", entry }))}>
          Delete for good
        </MenuItem>
      </Menu>
    );
  }

  return (
    <Menu anchor={anchor} alignRight label="Item actions" onClose={onClose}>
      {readable && (
        <MenuItem
          icon={entry.record.kind === "folder" ? <Folder /> : <NotebookPen />}
          onClick={run(onOpen)}
        >
          Open
        </MenuItem>
      )}
      {readable && entry.record.kind === "file" && (
        <MenuItem icon={<Download />} onClick={run(onDownload)}>
          Download
        </MenuItem>
      )}
      {readable && (
        <MenuItem icon={<Pencil />} onClick={run(() => onDialog({ kind: "rename", entry }))}>
          Rename
        </MenuItem>
      )}
      <MenuItem icon={<FolderInput />} onClick={run(() => onDialog({ kind: "move", entry }))}>
        Move to…
      </MenuItem>
      <MenuSeparator />
      <MenuItem
        danger
        icon={<Trash2 />}
        onClick={run(() => {
          void trashItem(entry).then((done) => {
            if (done) showToast(`Moved ${entryName(entry)} to the trash`);
          });
        })}
      >
        Move to trash
      </MenuItem>
    </Menu>
  );
}

/**
 * A note, read and written in the same place. Saving is explicit: a note is
 * shared between devices, and a save is the moment another device's edit is
 * checked for, which should not happen behind the user's back on every key.
 */
function NoteEditor({
  entry,
  folderId,
  onClose,
}: {
  entry: VaultEntry | null;
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

  async function save(): Promise<void> {
    if (!text.trim() && !title.trim()) {
      onClose();
      return;
    }
    setSaving(true);
    const saved = entry
      ? await saveNote(entry, title, text)
      : await createNote(folderId, title, text);
    setSaving(false);
    if (saved) onClose();
  }

  function requestClose(): void {
    if (dirty) setConfirmingClose(true);
    else onClose();
  }
  requestCloseRef.current = requestClose;

  return (
    <div
      class="animate-fade-in fixed inset-0 z-50 flex items-center justify-center bg-[color-mix(in_srgb,#0a0a0c_55%,transparent)] backdrop-blur-[4px] md:p-6"
      onClick={requestClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={entry ? `Note: ${title || "Untitled"}` : "New note"}
        class="animate-modal-in flex h-full w-full flex-col bg-elevated pt-[env(safe-area-inset-top)] md:h-[min(720px,calc(100dvh-3rem))] md:max-w-[680px] md:rounded-xl3 md:pt-0 md:shadow-float"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "s" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void save();
          }
        }}
      >
        <header class="flex flex-none items-center gap-2 border-b border-line px-3 py-2.5 md:px-4">
          <IconButton label="Close" onClick={requestClose}>
            <X />
          </IconButton>
          <span class="flex-1 truncate text-caption text-muted">
            {entry ? `Edited ${formatDate(entry.record.updatedAt)}` : "New note"}
          </span>
          <Button
            size="sm"
            variant="primary"
            disabled={saving || original === null || (!dirty && entry !== null)}
            onClick={() => void save()}
          >
            {saving ? <Spinner class="size-4" /> : null}
            Save
          </Button>
        </header>

        {confirmingClose && (
          <div class="flex flex-none flex-wrap items-center gap-2 border-b border-line bg-surface-2 px-4 py-2.5 text-note">
            <span class="flex-1 text-subtle">Save your changes to this note?</span>
            <Button size="sm" variant="ghost" onClick={onClose}>
              Discard
            </Button>
            <Button size="sm" variant="primary" onClick={() => void save()}>
              Save
            </Button>
          </div>
        )}

        {original === null ? (
          <div class="grid flex-1 place-items-center">
            <Spinner large class="text-accent" />
          </div>
        ) : (
          <div class="flex min-h-0 flex-1 flex-col px-5 pb-5 pt-4 md:px-8 md:pt-6">
            <input
              type="text"
              value={title}
              maxLength={200}
              placeholder="Title"
              aria-label="Title"
              // Read-only while saving: what is on screen must be what was saved,
              // or closing on success would drop whatever was typed meanwhile.
              readOnly={saving}
              class="w-full flex-none bg-transparent font-display text-display font-semibold tracking-[-0.025em] text-ink outline-none placeholder:text-muted/60"
              onInput={(event) => setTitle((event.target as HTMLInputElement).value)}
            />
            <textarea
              value={text}
              placeholder="Write something to keep…"
              aria-label="Note"
              readOnly={saving}
              autoFocus={entry === null}
              class="mt-3 min-h-0 w-full flex-1 resize-none bg-transparent text-lead leading-7 text-ink outline-none placeholder:text-muted/60"
              onInput={(event) => setText((event.target as HTMLTextAreaElement).value)}
            />
          </div>
        )}
      </div>
    </div>
  );
}

function NameDialog({
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

/** Pick a destination folder: every visible folder except the item and what is inside it. */
function MoveDialog({ entry, onClose }: { entry: VaultEntry; onClose: () => void }): JSX.Element {
  const [busy, setBusy] = useState(false);
  const entries = vaultEntries.value;
  const options = useMemo(() => {
    const records = new Map([...entries].map(([id, e]) => [id, e.record]));
    const excluded =
      entry.record.kind === "folder" ? vaultSubtree(records, entry.record.id) : new Set<string>();
    return visibleVaultEntries.value
      .filter(
        (candidate) =>
          candidate.record.kind === "folder" &&
          candidate.meta &&
          !excluded.has(candidate.record.id),
      )
      .map((candidate) => ({
        id: candidate.record.id,
        label: buildVaultPath(entries, candidate.record.id).map(entryName).join(" / "),
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
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

  const destinations = [{ id: null as string | null, label: "Vault (top level)" }, ...options];
  return (
    <Modal title={`Move ${entryName(entry)}`} onClose={onClose}>
      <ul class="flex flex-col gap-1" aria-label="Folders">
        {destinations.map((destination) => {
          const current = destination.id === entry.record.parentId;
          return (
            <li key={destination.id ?? "root"}>
              <button
                type="button"
                disabled={busy || current}
                onClick={() => void move(destination.id)}
                class="flex w-full items-center gap-3 rounded-[10px] px-3 py-2.5 text-left text-body transition hover:bg-surface-3 disabled:cursor-default disabled:opacity-50"
              >
                <Folder class="size-[18px] flex-none text-accent" aria-hidden="true" />
                <span class="min-w-0 flex-1 truncate">{destination.label}</span>
                {current && <span class="text-caption text-muted">Here now</span>}
              </button>
            </li>
          );
        })}
      </ul>
    </Modal>
  );
}

function ConfirmDialog({
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

function EmptyState({
  title,
  text,
  children,
}: {
  title: string;
  text: string;
  children?: ComponentChildren;
}): JSX.Element {
  return (
    <div class="flex flex-col items-center gap-3 rounded-xl2 border border-dashed border-line-strong px-6 py-12 text-center">
      <h3 class="font-display text-title font-semibold tracking-[-0.02em]">{title}</h3>
      <p class="max-w-[42ch] text-body leading-relaxed text-muted">{text}</p>
      {children && <div class="mt-1">{children}</div>}
    </div>
  );
}

/** How full the vault is, and the way into the trash. */
function VaultFooter({ spaceId, inTrash }: { spaceId: string; inTrash: boolean }): JSX.Element {
  const used = vaultUsage.value.bytes;
  const share = Math.min(1, used / vaultQuota);
  const trashed = trashedVaultEntries.value.length;
  const trashHref = vaultPath(spaceId, inTrash ? { folderId: null } : { trash: true });
  return (
    <div class="mt-2 flex flex-wrap items-center justify-between gap-x-6 gap-y-3 border-t border-line pt-4">
      <div class="flex min-w-[200px] flex-1 flex-col gap-1.5">
        <div
          class="h-1.5 overflow-hidden rounded-full bg-surface-3"
          role="meter"
          aria-label="Vault storage used"
          aria-valuemin={0}
          aria-valuemax={vaultQuota}
          aria-valuenow={used}
        >
          <div
            class={cx("h-full rounded-full", share > 0.9 ? "bg-danger" : "bg-accent")}
            style={{ width: `${Math.max(share * 100, used > 0 ? 1 : 0)}%` }}
          />
        </div>
        <span class="text-caption text-muted">
          {formatBytes(used)} of {formatBytes(vaultQuota)} used
        </span>
      </div>
      <a
        href={trashHref}
        onClick={(event) => followLink(event as unknown as MouseEvent, trashHref)}
        class="inline-flex items-center gap-2 rounded-[10px] px-2.5 py-1.5 text-note font-medium text-subtle transition hover:bg-surface-3 hover:text-ink [&_svg]:size-4"
      >
        {inTrash ? <RotateCcw aria-hidden="true" /> : <Trash2 aria-hidden="true" />}
        {inTrash ? "Back to the vault" : trashed > 0 ? `Trash (${trashed})` : "Trash"}
      </a>
    </div>
  );
}

function trashedLabel(entry: VaultEntry): string {
  const trashedAt = entry.record.trashedAt ?? Date.now();
  const days = Math.ceil((trashedAt + VAULT_TRASH_TTL_MS - Date.now()) / 86_400_000);
  return days <= 1 ? "Deleted for good tomorrow" : `Deleted for good in ${days} days`;
}

function formatDate(ts: number): string {
  const date = new Date(ts);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString([], {
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}
