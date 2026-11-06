import { VAULT_TRASH_TTL_MS } from "@sendself/shared";
import type { VaultEntry } from "../../state/vaultItems";
import { formatBytes } from "../components";

/** A short date: "6 Nov", or "6 Nov 2025" outside the current year. */
export function formatDate(ts: number): string {
  const date = new Date(ts);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString([], {
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

/** How long a trashed item has left before it is purged. */
export function trashedLabel(entry: VaultEntry): string {
  const trashedAt = entry.record.trashedAt ?? Date.now();
  const days = Math.ceil((trashedAt + VAULT_TRASH_TTL_MS - Date.now()) / 86_400_000);
  return days <= 1 ? "Deleted for good tomorrow" : `Deleted for good in ${days} days`;
}

/** What a folder holds, in words. */
export function countLabel(count: number): string {
  return count === 0 ? "Empty" : count === 1 ? "1 item" : `${count} items`;
}

/** A file's size, or nothing for what has none. */
export function sizeLabel(entry: VaultEntry): string {
  return entry.record.kind === "folder" || !entry.meta ? "" : formatBytes(entry.meta.size ?? 0);
}
