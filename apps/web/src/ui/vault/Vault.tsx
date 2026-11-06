import { signal } from "@preact/signals";
import { vaultPath as buildVaultPath } from "@sendself/client/vault";
import {
  ArchiveRestore,
  ChevronRight,
  ChevronsDownUp,
  ClipboardCopy,
  Download,
  Ellipsis,
  ExternalLink,
  Folder,
  FolderInput,
  FolderLock,
  FolderPlus,
  ImageIcon,
  Lock,
  Pencil,
  StickyNote,
  Trash2,
  Upload,
} from "lucide-preact";
import type { ComponentChildren, JSX } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { type VaultLocation, followLink, navigate, vaultPath } from "../../state/route";
import { activeSpace } from "../../state/spaces";
import { copyText, showToast } from "../../state/ui";
import {
  type VaultEntry,
  createFolder,
  deleteForever,
  emptyTrash,
  entryName,
  moveItem,
  openContent,
  readNote,
  renameItem,
  restoreItem,
  trashItem,
  trashedVaultEntries,
  uploadFiles,
  vaultEntries,
  vaultQuota,
  vaultSpace,
  vaultUploads,
  vaultUsage,
  visibleVaultEntries,
} from "../../state/vaultItems";
import { canCopyImages, copyImageBlob } from "../../share/clipboard-image";
import { downloadBlob } from "../../share/download";
import { Menu, type MenuAnchor, MenuItem, MenuSeparator, anchorBelow } from "../Menu";
import { Button, FileTypeIcon, Spinner, cx, formatBytes } from "../components";
import { ConfirmDialog, ImageViewer, MoveDialog, NameDialog } from "./dialogs";
import { dropFolder, vaultDropTarget } from "./drop";
import { trashedLabel } from "./format";
import { NoteEditor } from "./NoteEditor";
import { canMoveInto, flattenTree, groupChildren } from "./tree";
import { VaultTree } from "./VaultTree";

/** What is open over the listing, if anything. */
type Dialog =
  | { kind: "note"; entry: VaultEntry | null; parentId: string | null }
  | { kind: "folder"; parentId: string | null }
  | { kind: "rename"; entry: VaultEntry }
  | { kind: "move"; entry: VaultEntry }
  | { kind: "image"; entry: VaultEntry; url: string }
  | { kind: "delete"; entry: VaultEntry }
  | { kind: "empty-trash" };

/**
 * Folders open in the tree. Kept for the session, across visits to the vault,
 * so coming back finds the tree as it was left. Ids are unique across spaces,
 * so one set serves them all.
 */
const expandedFolders = signal<ReadonlySet<string>>(new Set());

/**
 * An open context menu: an item's, or (`entry: null`) the one for the empty
 * space around the items. One opened at the pointer hangs from it; one opened
 * from a button hangs from the button's right edge.
 */
interface OpenMenu {
  entry: VaultEntry | null;
  anchor: MenuAnchor;
  atPointer: boolean;
}

/** What can be copied out of an item, if anything. */
function copyKind(entry: VaultEntry): "text" | "image" | null {
  const { meta, record } = entry;
  if (!meta || record.kind === "folder") return null;
  if (record.kind === "note") return "text";
  const mime = meta.mime ?? "";
  if (mime.startsWith("image/")) return canCopyImages() ? "image" : null;
  // Small text files read like notes; anything big belongs in a download.
  if ((mime.startsWith("text/") || mime === "application/json") && (meta.size ?? 0) <= 1_000_000) {
    return "text";
  }
  return null;
}

/** Copy an item's content. Runs inside the click, which Safari's clipboard insists on. */
function copyContent(entry: VaultEntry): void {
  if (copyKind(entry) === "image") {
    const mime = entry.meta?.mime ?? "image/png";
    // The stored blob keeps whatever type it was saved with; the meta's is the reliable one.
    const image = openContent(entry).then((blob) =>
      blob.type ? blob : new Blob([blob], { type: mime }),
    );
    copyImageBlob(image).then(
      () => showToast("Image copied to clipboard"),
      () => showToast("Couldn't copy the image", "error"),
    );
    return;
  }
  const text =
    entry.record.kind === "note" ? readNote(entry) : openContent(entry).then((blob) => blob.text());
  void copyText(text, entry.record.kind === "note" ? "Note copied" : "Copied to clipboard");
}

function setExpanded(folderId: string, open: boolean): void {
  const current = expandedFolders.value;
  if (current.has(folderId) === open) return;
  const next = new Set(current);
  if (open) next.add(folderId);
  else next.delete(folderId);
  expandedFolders.value = next;
}

export function Vault({ location }: { location: VaultLocation }): JSX.Element {
  const spaceId = activeSpace.value?.id ?? "";
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [menu, setMenu] = useState<OpenMenu | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  /** The folder the file picker was opened for; unset, the one on screen. */
  const uploadInto = useRef<string | null | undefined>(undefined);
  const scroller = useRef<HTMLDivElement>(null);

  const inTrash = "trash" in location;
  const folderId = inTrash ? null : location.folderId;
  const entries = vaultEntries.value;
  const visible = visibleVaultEntries.value;
  const children = useMemo(() => groupChildren(visible), [visible]);
  const records = useMemo(
    () => new Map([...entries].map(([id, entry]) => [id, entry.record])),
    [entries],
  );
  const folder = folderId ? visible.find((entry) => entry.record.id === folderId) : undefined;

  // Bumped whenever a dialog opens or closes. A file being fetched to be
  // shown only shows if none did meanwhile: the listing stays usable while it
  // downloads, and a late image must not replace (and so silently discard) a
  // note the user opened in the meantime.
  const dialogTurn = useRef(0);
  useEffect(() => {
    dialogTurn.current += 1;
  }, [dialog]);

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

  const missingFolder = folderId !== null && !folder;
  const rows = flattenTree(children, folderId, expandedFolders.value);

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
      setDialog({ kind: "note", entry, parentId: entry.record.parentId });
      return;
    }
    const turn = ++dialogTurn.current;
    try {
      const blob = await openContent(entry);
      if (entry.meta.mime?.startsWith("image/")) {
        if (turn !== dialogTurn.current) return;
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

  function trash(entry: VaultEntry): void {
    void trashItem(entry).then((done) => {
      if (done) showToast(`Moved ${entryName(entry)} to the trash`);
    });
  }

  function move(entry: VaultEntry, parentId: string | null): void {
    if (parentId) setExpanded(parentId, true);
    void moveItem(entry, parentId).then((moved) => {
      if (!moved) return;
      const into = parentId ? entries.get(parentId) : undefined;
      showToast(`Moved ${entryName(entry)} to ${into ? entryName(into) : "the vault"}`);
    });
  }

  /** New things made inside a folder show up there: open it. */
  function into(parentId: string | null): string | null {
    if (parentId) setExpanded(parentId, true);
    return parentId;
  }

  function pickFiles(parentId: string | null): void {
    uploadInto.current = parentId;
    fileInput.current?.click();
  }

  function onPick(event: Event): void {
    const input = event.currentTarget as HTMLInputElement;
    const files = [...(input.files ?? [])];
    input.value = "";
    const parentId = uploadInto.current !== undefined ? uploadInto.current : folderId;
    uploadInto.current = undefined;
    if (files.length === 0) return;
    void uploadFiles(into(parentId), files).then((saved) => {
      if (saved > 0) showToast(saved === 1 ? "Saved to the vault" : `${saved} files saved`);
    });
  }

  const actions = {
    note: (parentId: string | null) =>
      setDialog({ kind: "note", entry: null, parentId: into(parentId) }),
    folder: (parentId: string | null) => setDialog({ kind: "folder", parentId }),
    upload: pickFiles,
  };

  /** Right-click (or a long press) on the empty space: what can be added here. */
  function onBackgroundMenu(event: MouseEvent): void {
    // Rows answer their own right-click, and links, fields and buttons keep
    // the browser's.
    if (event.defaultPrevented || missingFolder) return;
    // An empty trash has nothing to offer: leave the browser its own menu.
    if (inTrash && trashedVaultEntries.value.length === 0) return;
    const target = event.target as Element;
    if (target.closest("a, button, input, textarea, [role=treeitem]")) return;
    event.preventDefault();
    setMenu({ entry: null, anchor: { x: event.clientX, y: event.clientY }, atPointer: true });
  }

  return (
    <div
      ref={scroller}
      class="min-h-0 flex-1 overflow-y-auto"
      onContextMenu={onBackgroundMenu as unknown as JSX.MouseEventHandler<HTMLDivElement>}
    >
      <div class="mx-auto flex min-h-full w-full max-w-[920px] flex-col px-6 pb-4 pt-4 max-md:px-2.5 max-md:pt-2.5">
        <div class="flex min-h-11 items-center justify-between gap-3 pb-3 max-md:px-1.5">
          <Location spaceId={spaceId} location={location} />
          {inTrash
            ? trashedVaultEntries.value.length > 0 && (
                <Button
                  size="sm"
                  variant="danger"
                  class="flex-none"
                  onClick={() => setDialog({ kind: "empty-trash" })}
                >
                  <Trash2 aria-hidden="true" />
                  Empty trash
                </Button>
              )
            : !missingFolder && (
                <Toolbar
                  onNote={() => actions.note(folderId)}
                  onUpload={() => actions.upload(folderId)}
                  onFolder={() => actions.folder(folderId)}
                />
              )}
          <input ref={fileInput} type="file" multiple hidden onChange={onPick} />
        </div>

        {vaultUploads.value > 0 && (
          <div
            role="status"
            class="mb-2 flex items-center gap-2.5 rounded-lg bg-accent-soft px-3 py-2 text-caption font-medium text-accent"
          >
            <Spinner class="size-3.5" />
            {vaultUploads.value === 1
              ? "Encrypting and saving 1 file…"
              : `Encrypting and saving ${vaultUploads.value} files…`}
          </div>
        )}

        {missingFolder ? (
          <EmptyState
            icon={<Folder />}
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
        ) : inTrash ? (
          <TrashList onMenu={(entry, anchor, atPointer) => setMenu({ entry, anchor, atPointer })} />
        ) : rows.length === 0 ? (
          <div {...dropFolder(folderId)} class="flex flex-1 flex-col">
            <EmptyState
              icon={folderId ? <Folder /> : <FolderLock />}
              title={folderId ? "This folder is empty" : "Nothing in the vault yet"}
              text={
                folderId
                  ? "Write a note, upload files, or drag items here."
                  : "Notes and files kept here stay on every device in this space until you delete them. Only your devices can read them."
              }
              highlight={vaultDropTarget.value === folderId}
            >
              <p class="text-caption text-muted max-md:hidden">You can also drop files here.</p>
            </EmptyState>
          </div>
        ) : (
          <VaultTree
            rows={rows}
            rootId={folderId}
            scroller={() => scroller.current}
            canDrop={(entry, target) => canMoveInto(entry, target, records)}
            onToggle={(id, open) => setExpanded(id, open ?? !expandedFolders.value.has(id))}
            onOpen={(entry) => void open(entry)}
            onMenu={(entry, anchor, atPointer) => setMenu({ entry, anchor, atPointer })}
            onMove={move}
            onRename={(entry) => setDialog({ kind: "rename", entry })}
            onTrash={trash}
            onCopy={(entry) => {
              if (copyKind(entry)) copyContent(entry);
            }}
          />
        )}

        <VaultFooter spaceId={spaceId} inTrash={inTrash} />
      </div>

      {menu?.entry === null && (
        <BackgroundMenu
          anchor={menu.anchor}
          inTrash={inTrash}
          onClose={() => setMenu(null)}
          onNote={() => actions.note(folderId)}
          onUpload={() => actions.upload(folderId)}
          onFolder={() => actions.folder(folderId)}
          onCollapse={
            expandedFolders.value.size > 0 ? () => (expandedFolders.value = new Set()) : undefined
          }
          onEmptyTrash={
            trashedVaultEntries.value.length > 0
              ? () => setDialog({ kind: "empty-trash" })
              : undefined
          }
        />
      )}
      {menu?.entry && (
        <ItemMenu
          entry={menu.entry}
          anchor={menu.anchor}
          atPointer={menu.atPointer}
          inTrash={inTrash}
          onClose={() => setMenu(null)}
          onOpen={() => menu.entry && void open(menu.entry)}
          onDownload={() => menu.entry && void download(menu.entry)}
          onCopy={() => menu.entry && copyContent(menu.entry)}
          onTrash={() => menu.entry && trash(menu.entry)}
          onNoteHere={() => menu.entry && actions.note(menu.entry.record.id)}
          onUploadHere={() => menu.entry && actions.upload(menu.entry.record.id)}
          onFolderHere={() => menu.entry && actions.folder(menu.entry.record.id)}
          onDialog={setDialog}
        />
      )}

      {dialog?.kind === "note" && (
        <NoteEditor
          entry={dialog.entry}
          folderId={dialog.parentId}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "folder" && (
        <NameDialog
          title="New folder"
          label="Folder name"
          action="Create folder"
          initial=""
          onClose={() => setDialog(null)}
          onSubmit={async (name) => {
            const created = await createFolder(into(dialog.parentId), name);
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
        <ImageViewer
          name={entryName(dialog.entry)}
          url={dialog.url}
          onDownload={() => void download(dialog.entry)}
          onClose={() => setDialog(null)}
        />
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
 * Where the listing is. At the top level the header already says "Vault", so
 * it says what is in it instead; inside a folder it is the path back up, and
 * every step of it takes a dragged item as well.
 */
function Location({
  spaceId,
  location,
}: { spaceId: string; location: VaultLocation }): JSX.Element {
  const entries = vaultEntries.value;
  const target = vaultDropTarget.value;
  if (!("trash" in location) && location.folderId === null) {
    const top = visibleVaultEntries.value.filter((entry) => entry.record.parentId === null);
    const folders = top.filter((entry) => entry.record.kind === "folder").length;
    const items = top.length - folders;
    return (
      <p class="min-w-0 truncate text-caption text-muted">
        {top.length === 0
          ? "Empty"
          : [
              folders > 0 && (folders === 1 ? "1 folder" : `${folders} folders`),
              items > 0 && (items === 1 ? "1 item" : `${items} items`),
            ]
              .filter(Boolean)
              .join(" · ")}
      </p>
    );
  }
  const path = "trash" in location ? [] : buildVaultPath(entries, location.folderId);
  const crumbs: Array<{ label: string; href: string; folderId: string | null }> = [
    { label: "Vault", href: vaultPath(spaceId, { folderId: null }), folderId: null },
    ...("trash" in location
      ? [{ label: "Trash", href: vaultPath(spaceId, { trash: true }), folderId: null }]
      : path.map((entry) => ({
          label: entryName(entry),
          href: vaultPath(spaceId, { folderId: entry.record.id }),
          folderId: entry.record.id as string | null,
        }))),
  ];

  return (
    <nav aria-label="Location in the vault" class="min-w-0">
      <ol class="flex min-w-0 items-center gap-0.5 text-note font-medium">
        {crumbs.map((crumb, index) => {
          const last = index === crumbs.length - 1;
          return (
            <li
              key={crumb.href}
              class={cx(
                "flex min-w-0 items-center gap-0.5",
                !last && "flex-none",
                // A phone keeps the folder and its parent: the way up is one tap.
                index < crumbs.length - 2 && "max-sm:hidden",
              )}
            >
              {last ? (
                <span aria-current="page" class="truncate px-1.5 text-ink">
                  {crumb.label}
                </span>
              ) : (
                <>
                  <a
                    href={crumb.href}
                    {...("trash" in location ? {} : dropFolder(crumb.folderId))}
                    onClick={(event) => followLink(event as unknown as MouseEvent, crumb.href)}
                    class={cx(
                      "max-w-[16ch] truncate rounded-md px-1.5 py-1 text-muted transition hover:bg-surface-3 hover:text-ink",
                      target === crumb.folderId &&
                        !("trash" in location) &&
                        "bg-accent-soft text-ink",
                    )}
                  >
                    {crumb.label}
                  </a>
                  <ChevronRight aria-hidden="true" class="size-3.5 flex-none text-muted/70" />
                </>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/** The three ways to add something, as one quiet group. */
function Toolbar({
  onNote,
  onUpload,
  onFolder,
}: {
  onNote: () => void;
  onUpload: () => void;
  onFolder: () => void;
}): JSX.Element {
  return (
    <div class="flex flex-none items-center gap-0.5 rounded-[11px] border border-line bg-surface p-[3px] shadow-soft dark:bg-surface-2">
      <ToolButton label="New note" short="Note" onClick={onNote}>
        <StickyNote />
      </ToolButton>
      <ToolButton label="Upload files" short="Upload" onClick={onUpload}>
        <Upload />
      </ToolButton>
      <ToolButton label="New folder" short="Folder" onClick={onFolder}>
        <FolderPlus />
      </ToolButton>
    </div>
  );
}

function ToolButton({
  label,
  short,
  onClick,
  children,
}: {
  label: string;
  short: string;
  onClick: () => void;
  children: ComponentChildren;
}): JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      class="inline-flex h-8 items-center gap-1.5 rounded-[8px] px-2.5 text-note font-medium text-subtle transition hover:bg-surface-3 hover:text-ink active:scale-[0.97] max-sm:size-9 max-sm:justify-center max-sm:px-0 [&_svg]:size-4"
    >
      {children}
      <span class="max-sm:hidden">{short}</span>
    </button>
  );
}

/** What the trash holds: a flat list, each with how long it has left. */
function TrashList({
  onMenu,
}: {
  onMenu: (entry: VaultEntry, anchor: MenuAnchor, atPointer: boolean) => void;
}): JSX.Element {
  const trashed = [...trashedVaultEntries.value].sort(
    (a, b) => (b.record.trashedAt ?? 0) - (a.record.trashedAt ?? 0),
  );
  if (trashed.length === 0) {
    return (
      <EmptyState
        icon={<Trash2 />}
        title="The trash is empty"
        text="Deleted items wait here for 30 days, then they're gone for good."
      />
    );
  }
  return (
    <div class="flex flex-1 flex-col">
      <p class="border-b border-line px-2 pb-2 text-caption text-muted">
        Items here are deleted for good 30 days after they were trashed.
      </p>
      <ul class="flex flex-col py-1" aria-label="Trash">
        {trashed.map((entry) => (
          <li
            key={entry.record.id}
            class="group flex min-h-12 items-center gap-2.5 rounded-lg py-1.5 pl-2.5 pr-1 hover:bg-[color-mix(in_srgb,var(--c-ink)_5%,transparent)]"
            onContextMenu={(event) => {
              event.preventDefault();
              onMenu(entry, { x: event.clientX, y: event.clientY }, true);
            }}
          >
            <span class="grid size-[22px] flex-none place-items-center text-muted [&_svg]:size-[17px]">
              <EntryIcon entry={entry} />
            </span>
            <span class="min-w-0 flex-1">
              <span class="block truncate text-note text-ink">{entryName(entry)}</span>
              <span class="block truncate text-caption text-muted">{trashedLabel(entry)}</span>
            </span>
            <Button
              size="sm"
              variant="ghost"
              class="flex-none max-sm:hidden"
              aria-label={`Restore ${entryName(entry)}`}
              onClick={() => void restoreItem(entry)}
            >
              <ArchiveRestore aria-hidden="true" />
              Restore
            </Button>
            <button
              type="button"
              aria-label={`Options for ${entryName(entry)}`}
              title="Options"
              class="grid size-8 flex-none place-items-center rounded-md text-muted transition hover:bg-surface-3 hover:text-ink [&_svg]:size-[17px]"
              onClick={(event) =>
                onMenu(entry, anchorBelow(event.currentTarget as HTMLElement), false)
              }
            >
              <Ellipsis />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function EntryIcon({ entry }: { entry: VaultEntry }): JSX.Element {
  if (!entry.meta) return <Lock />;
  if (entry.record.kind === "folder") return <Folder class="text-accent" />;
  if (entry.record.kind === "note") return <StickyNote />;
  return <FileTypeIcon mime={entry.meta.mime ?? ""} />;
}

/** The menu for the empty space around the items: what can be added where the user is. */
function BackgroundMenu({
  anchor,
  inTrash,
  onClose,
  onNote,
  onUpload,
  onFolder,
  onCollapse,
  onEmptyTrash,
}: {
  anchor: MenuAnchor;
  inTrash: boolean;
  onClose: () => void;
  onNote: () => void;
  onUpload: () => void;
  onFolder: () => void;
  onCollapse?: () => void;
  onEmptyTrash?: () => void;
}): JSX.Element {
  const run = (action: () => void) => (): void => {
    onClose();
    action();
  };
  if (inTrash) {
    return (
      <Menu anchor={anchor} label="Trash actions" onClose={onClose}>
        <MenuItem danger icon={<Trash2 />} onClick={run(onEmptyTrash ?? (() => {}))}>
          Empty trash
        </MenuItem>
      </Menu>
    );
  }
  return (
    <Menu anchor={anchor} label="Add to the vault" onClose={onClose}>
      <MenuItem icon={<StickyNote />} onClick={run(onNote)}>
        New note
      </MenuItem>
      <MenuItem icon={<Upload />} onClick={run(onUpload)}>
        Upload files
      </MenuItem>
      <MenuItem icon={<FolderPlus />} onClick={run(onFolder)}>
        New folder
      </MenuItem>
      {onCollapse && (
        <>
          <MenuSeparator />
          <MenuItem icon={<ChevronsDownUp />} onClick={run(onCollapse)}>
            Collapse all folders
          </MenuItem>
        </>
      )}
    </Menu>
  );
}

function ItemMenu({
  entry,
  anchor,
  atPointer,
  inTrash,
  onClose,
  onOpen,
  onDownload,
  onCopy,
  onTrash,
  onNoteHere,
  onUploadHere,
  onFolderHere,
  onDialog,
}: {
  entry: VaultEntry;
  anchor: MenuAnchor;
  atPointer: boolean;
  inTrash: boolean;
  onClose: () => void;
  onOpen: () => void;
  onDownload: () => void;
  onCopy: () => void;
  onTrash: () => void;
  onNoteHere: () => void;
  onUploadHere: () => void;
  onFolderHere: () => void;
  onDialog: (dialog: Dialog) => void;
}): JSX.Element {
  const run = (action: () => void) => (): void => {
    onClose();
    action();
  };
  const readable = entry.meta !== null;
  const kind = entry.record.kind;
  const copyable = copyKind(entry);
  const alignRight = !atPointer;

  if (inTrash) {
    return (
      <Menu anchor={anchor} alignRight={alignRight} label="Item actions" onClose={onClose}>
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
    <Menu anchor={anchor} alignRight={alignRight} label="Item actions" onClose={onClose}>
      {readable && kind === "folder" && (
        <>
          <MenuItem icon={<StickyNote />} onClick={run(onNoteHere)}>
            New note here
          </MenuItem>
          <MenuItem icon={<Upload />} onClick={run(onUploadHere)}>
            Upload here
          </MenuItem>
          <MenuItem icon={<FolderPlus />} onClick={run(onFolderHere)}>
            New folder here
          </MenuItem>
          <MenuSeparator />
          <MenuItem icon={<ExternalLink />} onClick={run(onOpen)}>
            Open as page
          </MenuItem>
        </>
      )}
      {readable && kind !== "folder" && (
        <MenuItem icon={kind === "note" ? <StickyNote /> : <ExternalLink />} onClick={run(onOpen)}>
          Open
        </MenuItem>
      )}
      {copyable && (
        <MenuItem
          icon={copyable === "image" ? <ImageIcon /> : <ClipboardCopy />}
          onClick={run(onCopy)}
        >
          {copyable === "image" ? "Copy image" : kind === "note" ? "Copy text" : "Copy contents"}
        </MenuItem>
      )}
      {readable && kind === "file" && (
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
      <MenuItem danger icon={<Trash2 />} onClick={run(onTrash)}>
        Move to trash
      </MenuItem>
    </Menu>
  );
}

function EmptyState({
  icon,
  title,
  text,
  highlight = false,
  children,
}: {
  icon: JSX.Element;
  title: string;
  text: string;
  highlight?: boolean;
  children?: ComponentChildren;
}): JSX.Element {
  return (
    <div
      class={cx(
        "flex flex-1 flex-col items-center justify-center gap-2 rounded-xl px-6 py-16 text-center transition-colors",
        highlight && "bg-accent-soft",
      )}
    >
      <span class="mb-2 grid size-11 place-items-center rounded-[13px] border border-line bg-surface text-subtle shadow-soft dark:bg-surface-2 [&_svg]:size-5">
        {icon}
      </span>
      <h3 class="text-body-lg font-semibold tracking-[-0.015em]">{title}</h3>
      <p class="max-w-[44ch] text-note leading-relaxed text-muted">{text}</p>
      {children && <div class="mt-2">{children}</div>}
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
    <footer class="mt-6 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-line px-2 pt-3 text-caption text-muted">
      <span class="flex items-center gap-1.5 max-sm:hidden">
        <Lock aria-hidden="true" class="size-3.5" />
        End-to-end encrypted
      </span>
      <span class="flex items-center gap-2 sm:ml-auto">
        <span
          class="h-1 w-16 overflow-hidden rounded-full bg-surface-3"
          role="meter"
          aria-label="Vault storage used"
          aria-valuemin={0}
          aria-valuemax={vaultQuota}
          aria-valuenow={used}
        >
          <span
            class={cx("block h-full rounded-full", share > 0.9 ? "bg-danger" : "bg-accent")}
            style={{ width: `${Math.max(share * 100, used > 0 ? 2 : 0)}%` }}
          />
        </span>
        <span class="tabular-nums">
          {formatBytes(used)} of {formatBytes(vaultQuota)}
        </span>
      </span>
      <a
        href={trashHref}
        onClick={(event) => followLink(event as unknown as MouseEvent, trashHref)}
        class="-my-1 ml-auto inline-flex items-center gap-1.5 rounded-md px-2 py-1 font-medium text-subtle transition hover:bg-surface-3 hover:text-ink sm:ml-0 [&_svg]:size-3.5"
      >
        {inTrash ? <FolderLock aria-hidden="true" /> : <Trash2 aria-hidden="true" />}
        {inTrash ? "Back to the vault" : trashed > 0 ? `Trash (${trashed})` : "Trash"}
      </a>
    </footer>
  );
}
