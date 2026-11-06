/**
 * Where something dragged over the vault would land.
 *
 * Two kinds of drag aim at the same folders: an item moved within the tree
 * (ui/vault/useTreeDrag.ts) and files dragged in from outside the app
 * (ui/DropZone.tsx). Both find the folder under the pointer the same way, from
 * the attribute below, and publish it here so the tree lights up one target
 * whichever kind of drag it is.
 */

import { signal } from "@preact/signals";

/** A folder id, `null` for the top level, or `undefined` while nothing is aimed at. */
export const vaultDropTarget = signal<string | null | undefined>(undefined);

const ATTRIBUTE = "data-vault-folder";

/**
 * Mark an element as standing for a folder (or the top level, for `null`): a
 * folder row stands for itself, a note or file row for the folder holding it.
 */
export function dropFolder(folderId: string | null): Record<string, string> {
  return { [ATTRIBUTE]: folderId ?? "" };
}

/** The folder an element stands for, or `undefined` when it is outside the vault's targets. */
export function folderAt(node: EventTarget | null): string | null | undefined {
  const element = node instanceof Element ? node : node instanceof Node ? node.parentElement : null;
  const marked = element?.closest(`[${ATTRIBUTE}]`);
  if (!marked) return undefined;
  return marked.getAttribute(ATTRIBUTE) || null;
}
