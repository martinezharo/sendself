/**
 * The vault as a tree on screen: which rows show, in what order, and how deep.
 *
 * Pure functions over the opened entries, so the view, the move picker and the
 * drag-and-drop rules all read the hierarchy the same way.
 */

import { vaultSubtree } from "@sendself/client/vault";
import type { VaultItemRecord } from "@sendself/shared";
import type { VaultEntry } from "../../state/vaultItems";

/** A line of the tree: an item, or the placeholder inside an open empty folder. */
export type TreeRow =
  | {
      kind: "item";
      entry: VaultEntry;
      depth: number;
      /** Only meaningful for folders. */
      expanded: boolean;
      /** Direct children, for folders. */
      childCount: number;
    }
  | { kind: "empty"; parentId: string; depth: number };

/**
 * Folders first, by name; then notes and files, newest first. A vault is
 * mostly things sent to oneself, and the last one sent is the one looked for.
 */
export function compareEntries(a: VaultEntry, b: VaultEntry): number {
  const aFolder = a.record.kind === "folder";
  const bFolder = b.record.kind === "folder";
  if (aFolder !== bFolder) return aFolder ? -1 : 1;
  if (aFolder) {
    // A folder this device can't open yet has no name to sort by: it goes last.
    return (a.meta?.name ?? "\uffff").localeCompare(b.meta?.name ?? "\uffff", undefined, {
      sensitivity: "base",
      numeric: true,
    });
  }
  return b.record.updatedAt - a.record.updatedAt;
}

/** Children of every folder (and of the top level, under `null`), sorted. */
export function groupChildren(entries: readonly VaultEntry[]): Map<string | null, VaultEntry[]> {
  const children = new Map<string | null, VaultEntry[]>();
  for (const entry of entries) {
    const siblings = children.get(entry.record.parentId);
    if (siblings) siblings.push(entry);
    else children.set(entry.record.parentId, [entry]);
  }
  for (const siblings of children.values()) siblings.sort(compareEntries);
  return children;
}

/**
 * The rows under `rootId`, depth first, descending only into expanded
 * folders. Depth is capped as a guard against a cycle the server should never
 * let exist.
 */
export function flattenTree(
  children: ReadonlyMap<string | null, readonly VaultEntry[]>,
  rootId: string | null,
  expanded: ReadonlySet<string>,
): TreeRow[] {
  const rows: TreeRow[] = [];
  const walk = (parentId: string | null, depth: number): void => {
    if (depth > 64) return;
    for (const entry of children.get(parentId) ?? []) {
      const isFolder = entry.record.kind === "folder";
      const childCount = isFolder ? (children.get(entry.record.id)?.length ?? 0) : 0;
      const open = isFolder && entry.meta !== null && expanded.has(entry.record.id);
      rows.push({ kind: "item", entry, depth, expanded: open, childCount });
      if (!open) continue;
      if (childCount === 0)
        rows.push({ kind: "empty", parentId: entry.record.id, depth: depth + 1 });
      else walk(entry.record.id, depth + 1);
    }
  };
  walk(rootId, 0);
  return rows;
}

/**
 * Whether `entry` may be moved into `folderId` (null: the top level). Not
 * into where it already is, and a folder not into itself or anything inside it.
 */
export function canMoveInto(
  entry: VaultEntry,
  folderId: string | null,
  records: ReadonlyMap<string, VaultItemRecord>,
): boolean {
  if (folderId === entry.record.parentId) return false;
  if (folderId === null || entry.record.kind !== "folder") return true;
  return !vaultSubtree(records, entry.record.id).has(folderId);
}

/** Every folder an item could be moved into, as a tree: depth and label in order. */
export function folderOptions(
  children: ReadonlyMap<string | null, readonly VaultEntry[]>,
  entry: VaultEntry | undefined,
  records: ReadonlyMap<string, VaultItemRecord>,
): Array<{ entry: VaultEntry; depth: number }> {
  const excluded =
    entry?.record.kind === "folder" ? vaultSubtree(records, entry.record.id) : new Set<string>();
  const options: Array<{ entry: VaultEntry; depth: number }> = [];
  const walk = (parentId: string | null, depth: number): void => {
    if (depth > 64) return;
    for (const child of children.get(parentId) ?? []) {
      if (child.record.kind !== "folder" || !child.meta || excluded.has(child.record.id)) continue;
      options.push({ entry: child, depth });
      walk(child.record.id, depth + 1);
    }
  };
  walk(null, 0);
  return options;
}
