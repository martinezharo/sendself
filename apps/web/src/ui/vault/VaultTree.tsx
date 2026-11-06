import { ChevronRight, Ellipsis, Folder, FolderOpen, Lock, StickyNote } from "lucide-preact";
import type { JSX } from "preact";
import { useRef, useState } from "preact/hooks";
import { type VaultEntry, entryName } from "../../state/vaultItems";
import type { MenuAnchor } from "../Menu";
import { anchorBelow } from "../Menu";
import { FileTypeIcon, cx } from "../components";
import { dropFolder, vaultDropTarget } from "./drop";
import { countLabel, formatDate, sizeLabel } from "./format";
import type { TreeRow } from "./tree";
import { useTreeDrag } from "./useTreeDrag";

/** Width of one level of indentation, in px. Also the width of the chevron column. */
const INDENT = 20;

interface Props {
  rows: readonly TreeRow[];
  /** The folder the tree hangs from: null for the whole vault. */
  rootId: string | null;
  /** The element that scrolls the tree. */
  scroller: () => HTMLElement | null;
  canDrop: (entry: VaultEntry, folderId: string | null) => boolean;
  onToggle: (folderId: string, open?: boolean) => void;
  onOpen: (entry: VaultEntry) => void;
  onMenu: (entry: VaultEntry, anchor: MenuAnchor, atPointer: boolean) => void;
  onMove: (entry: VaultEntry, folderId: string | null) => void;
  onRename: (entry: VaultEntry) => void;
  onTrash: (entry: VaultEntry) => void;
  /** Copy the row's content (Ctrl/⌘+C), where it has any to copy. */
  onCopy: (entry: VaultEntry) => void;
}

/**
 * The vault as a tree: folders open in place, with guides down to what they
 * hold. Items are dragged between folders (see `useTreeDrag`) and the whole
 * tree is walked from the keyboard the way the ARIA tree pattern describes.
 */
export function VaultTree({
  rows,
  rootId,
  scroller,
  canDrop,
  onToggle,
  onOpen,
  onMenu,
  onMove,
  onRename,
  onTrash,
  onCopy,
}: Props): JSX.Element {
  const [activeId, setActiveId] = useState<string | null>(null);
  const lastPointer = useRef("mouse");
  const { drag, rowHandlers } = useTreeDrag({
    scroller,
    canDrop,
    onDrop: onMove,
    onHoverFolder: (folderId) => onToggle(folderId, true),
  });
  const target = vaultDropTarget.value;

  const items = rows.filter(
    (row): row is Extract<TreeRow, { kind: "item" }> => row.kind === "item",
  );
  const focusId = items.some((row) => row.entry.record.id === activeId)
    ? activeId
    : (items[0]?.entry.record.id ?? null);

  function focusRow(id: string | undefined): void {
    if (!id) return;
    setActiveId(id);
    document.getElementById(rowId(id))?.focus();
  }

  function activate(row: Extract<TreeRow, { kind: "item" }>): void {
    const { entry } = row;
    if (entry.record.kind === "folder" && entry.meta) onToggle(entry.record.id);
    else onOpen(entry);
  }

  function onKeyDown(event: KeyboardEvent, row: Extract<TreeRow, { kind: "item" }>): void {
    const { entry } = row;
    const index = items.indexOf(row);
    const isFolder = entry.record.kind === "folder" && entry.meta !== null;
    let handled = true;
    switch (event.key) {
      case "ArrowDown":
        focusRow(items[index + 1]?.entry.record.id);
        break;
      case "ArrowUp":
        focusRow(items[index - 1]?.entry.record.id);
        break;
      case "Home":
        focusRow(items[0]?.entry.record.id);
        break;
      case "End":
        focusRow(items[items.length - 1]?.entry.record.id);
        break;
      case "ArrowRight":
        if (isFolder && !row.expanded) onToggle(entry.record.id, true);
        else if (isFolder && row.childCount > 0) focusRow(items[index + 1]?.entry.record.id);
        break;
      case "ArrowLeft":
        if (isFolder && row.expanded) onToggle(entry.record.id, false);
        else if (entry.record.parentId !== rootId) focusRow(entry.record.parentId ?? undefined);
        break;
      case "Enter":
      case " ":
        activate(row);
        break;
      case "F2":
        if (entry.meta) onRename(entry);
        break;
      case "Delete":
        onTrash(entry);
        break;
      case "ContextMenu":
        onMenu(entry, anchorBelow(event.currentTarget as HTMLElement), false);
        break;
      default:
        handled = event.key === "F10" && event.shiftKey;
        if (handled) onMenu(entry, anchorBelow(event.currentTarget as HTMLElement), false);
        else if (event.key === "c" && (event.ctrlKey || event.metaKey) && !event.altKey) {
          // Copy what the row holds, unless the user is copying selected text.
          handled = !window.getSelection()?.toString();
          if (handled) onCopy(entry);
        }
    }
    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  }

  return (
    <div
      {...dropFolder(rootId)}
      class={cx(
        "flex min-h-[120px] flex-1 flex-col rounded-xl transition-colors",
        target === rootId && "bg-accent-soft shadow-[inset_0_0_0_1.5px_var(--c-accent-glow)]",
      )}
    >
      {/* Column titles, where there is room for the columns. */}
      <div
        aria-hidden="true"
        class="flex h-8 items-center border-b border-line pl-2 pr-1 font-mono text-meta uppercase tracking-[0.08em] text-muted max-sm:hidden"
      >
        <span class="flex-1" style={{ paddingLeft: `${INDENT + 30}px` }}>
          Name
        </span>
        <span class="w-24 text-right">Modified</span>
        <span class="w-20 text-right">Size</span>
        <span class="w-9" />
      </div>

      <ul role="tree" aria-label="Vault items" class="flex flex-col py-1">
        {rows.map((row) =>
          row.kind === "empty" ? (
            <li
              key={`empty:${row.parentId}`}
              role="treeitem"
              aria-level={row.depth + 1}
              aria-disabled="true"
              {...dropFolder(row.parentId)}
              class={cx(
                "flex h-9 items-center pl-2 text-caption italic text-muted",
                target === row.parentId && "bg-accent-soft",
              )}
            >
              <Guides depth={row.depth} />
              <span class="pl-1.5">Nothing here yet</span>
            </li>
          ) : (
            <TreeItem
              key={row.entry.record.id}
              row={row}
              rootId={rootId}
              focusable={row.entry.record.id === focusId}
              isTarget={row.entry.record.kind === "folder" && target === row.entry.record.id}
              inTarget={
                target !== undefined && target !== rootId && row.entry.record.parentId === target
              }
              dragging={drag?.entry.record.id === row.entry.record.id}
              handlers={rowHandlers(row.entry)}
              onPointerType={(type) => {
                lastPointer.current = type;
              }}
              onFocus={() => setActiveId(row.entry.record.id)}
              onActivate={() => activate(row)}
              onKeyDown={(event) => onKeyDown(event, row)}
              onMenu={(anchor) => onMenu(row.entry, anchor, false)}
              onContextMenu={(event) => {
                event.preventDefault();
                // A held finger is picking the item up, not asking for its menu.
                if (lastPointer.current !== "mouse") return;
                onMenu(row.entry, { x: event.clientX, y: event.clientY }, true);
              }}
            />
          ),
        )}
      </ul>

      {drag && <DragGhost entry={drag.entry} x={drag.x} y={drag.y} />}
    </div>
  );
}

function rowId(id: string): string {
  return `vault-row-${id}`;
}

function TreeItem({
  row,
  rootId,
  focusable,
  isTarget,
  inTarget,
  dragging,
  handlers,
  onPointerType,
  onFocus,
  onActivate,
  onKeyDown,
  onMenu,
  onContextMenu,
}: {
  row: Extract<TreeRow, { kind: "item" }>;
  rootId: string | null;
  focusable: boolean;
  isTarget: boolean;
  inTarget: boolean;
  dragging: boolean;
  handlers: ReturnType<ReturnType<typeof useTreeDrag>["rowHandlers"]>;
  onPointerType: (type: string) => void;
  onFocus: () => void;
  onActivate: () => void;
  onKeyDown: (event: KeyboardEvent) => void;
  onMenu: (anchor: MenuAnchor) => void;
  onContextMenu: (event: MouseEvent) => void;
}): JSX.Element {
  const { entry, depth, expanded } = row;
  const { record, meta } = entry;
  const isFolder = record.kind === "folder";
  const name = entryName(entry);
  const detailId = `${rowId(record.id)}-detail`;

  return (
    <li
      id={rowId(record.id)}
      role="treeitem"
      aria-level={depth + 1}
      aria-expanded={isFolder && meta ? expanded : undefined}
      aria-label={name}
      aria-describedby={detailId}
      tabIndex={focusable ? 0 : -1}
      {...dropFolder(isFolder ? record.id : (record.parentId ?? rootId))}
      class={cx(
        "group relative flex h-11 cursor-default select-none items-center rounded-lg pl-2 pr-1 outline-none transition-colors sm:h-9",
        "[-webkit-touch-callout:none] [-webkit-tap-highlight-color:transparent]",
        "hover:bg-[color-mix(in_srgb,var(--c-ink)_5%,transparent)]",
        "focus-visible:rounded-lg focus-visible:bg-[color-mix(in_srgb,var(--c-ink)_5%,transparent)] focus-visible:shadow-[inset_0_0_0_1.5px_var(--c-accent)]",
        isTarget && "!bg-accent-soft shadow-[inset_0_0_0_1.5px_var(--c-accent-glow)]",
        inTarget && "bg-[color-mix(in_srgb,var(--c-accent)_6%,transparent)]",
        dragging && "opacity-40",
      )}
      onFocus={onFocus}
      onClick={onActivate}
      onKeyDown={onKeyDown as unknown as JSX.KeyboardEventHandler<HTMLElement>}
      onContextMenu={onContextMenu as unknown as JSX.MouseEventHandler<HTMLElement>}
      {...handlers}
      onPointerDown={(event) => {
        onPointerType(event.pointerType);
        handlers.onPointerDown?.(event);
      }}
    >
      <Guides depth={depth} />
      <span
        class="grid flex-none place-items-center text-muted"
        style={{ width: `${INDENT}px` }}
        aria-hidden="true"
      >
        {isFolder && meta && (
          <ChevronRight
            class={cx(
              "size-3.5 transition-transform duration-150 ease-[var(--ease-emphasized)]",
              expanded && "rotate-90",
            )}
          />
        )}
      </span>
      <span
        aria-hidden="true"
        class={cx(
          "mr-2 grid size-[22px] flex-none place-items-center [&_svg]:size-[17px]",
          !meta
            ? "text-muted"
            : isFolder
              ? "text-accent"
              : record.kind === "note"
                ? "text-subtle"
                : "text-muted",
        )}
      >
        {!meta ? (
          <Lock />
        ) : isFolder ? (
          expanded ? (
            <FolderOpen class="fill-[color-mix(in_srgb,var(--c-accent)_18%,transparent)]" />
          ) : (
            <Folder class="fill-[color-mix(in_srgb,var(--c-accent)_18%,transparent)]" />
          )
        ) : record.kind === "note" ? (
          <StickyNote />
        ) : (
          <FileTypeIcon mime={meta.mime ?? ""} />
        )}
      </span>

      <span class="flex min-w-0 flex-1 items-baseline gap-2">
        <span
          class={cx(
            "truncate text-note text-ink sm:text-[0.875rem]",
            isFolder ? "font-medium" : "font-normal",
            record.kind === "note" && "max-w-[60%] flex-none",
          )}
        >
          {name}
        </span>
        <span id={detailId} class="min-w-0 flex-1 truncate text-caption text-muted">
          {!meta ? (
            "Opens once this device has the space's current key"
          ) : record.kind === "note" ? (
            meta.excerpt || "Empty note"
          ) : isFolder ? (
            <span class="sm:hidden">{countLabel(row.childCount)}</span>
          ) : (
            <span class="sm:hidden">{sizeLabel(entry)}</span>
          )}
        </span>
      </span>

      <span class="w-24 flex-none text-right text-caption tabular-nums text-muted max-sm:hidden">
        {formatDate(record.updatedAt)}
      </span>
      <span class="w-20 flex-none text-right text-caption tabular-nums text-muted max-sm:hidden">
        {isFolder ? (meta ? countLabel(row.childCount) : "") : sizeLabel(entry)}
      </span>
      <button
        type="button"
        tabIndex={-1}
        aria-label={`Options for ${name}`}
        title="Options"
        class={cx(
          "ml-1 grid size-8 flex-none place-items-center rounded-md text-muted transition hover:bg-surface-3 hover:text-ink [&_svg]:size-[17px]",
          // On a mouse the menu is a hover affordance (and a right-click);
          // a finger has no hover, so there it is always on show.
          "[@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:hover)]:group-focus-visible:opacity-100",
        )}
        onClick={(event) => {
          event.stopPropagation();
          onMenu(anchorBelow(event.currentTarget as HTMLElement));
        }}
        // Its keys are its own: Enter opens the menu, and Delete or arrows
        // must not reach the row's tree shortcuts.
        onKeyDown={(event) => event.stopPropagation()}
      >
        <Ellipsis />
      </button>
    </li>
  );
}

/** One vertical guide per level above the row, joining it to its folder. */
function Guides({ depth }: { depth: number }): JSX.Element | null {
  if (depth === 0) return null;
  return (
    <>
      {Array.from({ length: depth }, (_, level) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: the levels are positions, nothing else
          key={level}
          aria-hidden="true"
          class="relative flex-none self-stretch before:absolute before:inset-y-0 before:left-1/2 before:w-px before:bg-line-strong"
          style={{ width: `${INDENT}px` }}
        />
      ))}
    </>
  );
}

/** What follows the pointer while an item is carried. */
function DragGhost({ entry, x, y }: { entry: VaultEntry; x: number; y: number }): JSX.Element {
  const target = vaultDropTarget.value;
  return (
    <div
      aria-hidden="true"
      class="pointer-events-none fixed left-0 top-0 z-[95] flex max-w-[260px] items-center gap-2 rounded-[10px] border border-line-strong bg-elevated py-1.5 pl-2 pr-3 text-note font-medium text-ink shadow-float [&_svg]:size-4 [&_svg]:flex-none"
      style={{ transform: `translate(${x + 14}px, ${y + 10}px)` }}
    >
      <span class={entry.record.kind === "folder" ? "text-accent" : "text-muted"}>
        {entry.record.kind === "folder" ? (
          <Folder />
        ) : entry.record.kind === "note" ? (
          <StickyNote />
        ) : (
          <FileTypeIcon mime={entry.meta?.mime ?? ""} />
        )}
      </span>
      <span class="truncate">{entryName(entry)}</span>
      <span
        class={cx(
          "ml-1 size-1.5 flex-none rounded-full transition-colors",
          target === undefined ? "bg-line-strong" : "bg-accent",
        )}
      />
    </div>
  );
}
