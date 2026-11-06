/**
 * The vault, as every client sees it: how items are sealed, and the handful of
 * operations that change them. Shared by the PWA and the CLI so both seal the
 * same bytes the same way (see `VaultItemRecord` in @sendself/shared for the
 * model).
 *
 * Two layers of keys, on purpose:
 *  - an item's `meta` is sealed under the space's GroupKey, so a rotation only
 *    ever re-seals a few hundred bytes per item (`resealVault`);
 *  - a note's or file's content is sealed under a random key of its own, which
 *    only `meta` carries, so it is never re-encrypted at all. Every new
 *    version of the content gets a new key.
 */

import {
  MAX_FILE_SIZE,
  VAULT_RESEAL_BATCH,
  type VaultChangesResponse,
  type VaultItemKind,
  type VaultItemMeta,
  type VaultItemRecord,
  vaultContext,
} from "@sendself/shared";
import type { Api, Auth } from "./api";
import {
  decryptFile,
  decryptJson,
  encryptFile,
  encryptJson,
  exportGroupKey,
  generateGroupKey,
  importGroupKey,
  randomId,
} from "./crypto";
import { type Keyring, currentKey, keyForEpoch } from "./keyring";

/** An item with its metadata opened, or `meta: null` when this device holds no key for it. */
export interface VaultEntry {
  record: VaultItemRecord;
  meta: VaultItemMeta | null;
}

/** Everything a vault operation needs to reach the space and seal for it. */
export interface VaultContext {
  api: Api;
  auth: Auth;
  groupId: string;
  keyring: Keyring;
}

/** How long a note's excerpt is: enough for two lines of a list row. */
const EXCERPT_LENGTH = 160;

/** The opening of a note, flattened to one line, for listing it without its blob. */
export function noteExcerpt(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, EXCERPT_LENGTH);
}

/** What a note is called when its title is left empty: its first line. */
export function noteTitle(title: string, text: string): string {
  const named = title.trim();
  if (named) return named;
  const firstLine = text.trim().split("\n", 1)[0]?.trim() ?? "";
  return firstLine.slice(0, 80) || "Untitled note";
}

// ---------------------------------------------------------------------------
// Sealing
// ---------------------------------------------------------------------------

interface SealedMeta {
  keyEpoch: number;
  meta: string;
  metaIv: string;
}

async function sealMeta(
  keyring: Keyring,
  groupId: string,
  id: string,
  kind: VaultItemKind,
  meta: VaultItemMeta,
): Promise<SealedMeta> {
  const sealed = await encryptJson(currentKey(keyring), meta, vaultContext.meta(groupId, id, kind));
  return { keyEpoch: keyring.current, meta: sealed.ciphertext, metaIv: sealed.iv };
}

/** Open an item's metadata, or null when this device never held its epoch (or it fails). */
export async function openVaultMeta(
  keyring: Keyring,
  groupId: string,
  record: VaultItemRecord,
): Promise<VaultItemMeta | null> {
  const key = keyForEpoch(keyring, record.keyEpoch);
  if (!key) return null;
  try {
    return await decryptJson<VaultItemMeta>(
      key,
      record.meta,
      record.metaIv,
      vaultContext.meta(groupId, record.id, record.kind),
    );
  } catch {
    return null;
  }
}

export async function openVaultEntries(
  keyring: Keyring,
  groupId: string,
  records: readonly VaultItemRecord[],
): Promise<VaultEntry[]> {
  return Promise.all(
    records.map(async (record) => ({
      record,
      meta: await openVaultMeta(keyring, groupId, record),
    })),
  );
}

interface SealedContent {
  blobKey: string;
  meta: Pick<VaultItemMeta, "contentKey" | "contentIv" | "size">;
}

/** Seal and upload one version of an item's content under a fresh key. */
async function uploadContent(ctx: VaultContext, data: ArrayBuffer): Promise<SealedContent> {
  if (data.byteLength > MAX_FILE_SIZE) {
    throw new Error(`Files are limited to ${Math.round(MAX_FILE_SIZE / 1024 / 1024)} MB`);
  }
  const blobKey = randomId();
  const contentKey = await generateGroupKey();
  const sealed = await encryptFile(contentKey, data, vaultContext.blob(ctx.groupId, blobKey));
  await ctx.api.uploadVaultBlob(blobKey, sealed.ciphertext, ctx.auth);
  return {
    blobKey,
    meta: {
      contentKey: await exportGroupKey(contentKey),
      contentIv: sealed.iv,
      size: data.byteLength,
    },
  };
}

/** Download and open an item's content. */
export async function readVaultContent(
  ctx: Pick<VaultContext, "api" | "auth" | "groupId">,
  entry: VaultEntry,
): Promise<ArrayBuffer> {
  const { record, meta } = entry;
  if (!record.blobKey || !meta?.contentKey || !meta.contentIv) {
    throw new Error("This item has no content this device can open");
  }
  const ciphertext = await ctx.api.downloadVaultBlob(record.blobKey, ctx.auth);
  return decryptFile(
    await importGroupKey(meta.contentKey),
    ciphertext,
    meta.contentIv,
    vaultContext.blob(ctx.groupId, record.blobKey),
  );
}

export async function readVaultNote(
  ctx: Pick<VaultContext, "api" | "auth" | "groupId">,
  entry: VaultEntry,
): Promise<string> {
  return new TextDecoder().decode(await readVaultContent(ctx, entry));
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

export async function createVaultFolder(
  ctx: VaultContext,
  parentId: string | null,
  name: string,
): Promise<VaultEntry> {
  const id = randomId();
  const meta: VaultItemMeta = { name };
  const { item } = await ctx.api.createVaultItem(
    {
      id,
      parentId,
      kind: "folder",
      ...(await sealMeta(ctx.keyring, ctx.groupId, id, "folder", meta)),
    },
    ctx.auth,
  );
  return { record: item, meta };
}

export async function createVaultNote(
  ctx: VaultContext,
  parentId: string | null,
  title: string,
  text: string,
): Promise<VaultEntry> {
  const id = randomId();
  const content = await uploadContent(ctx, new TextEncoder().encode(text).buffer as ArrayBuffer);
  const meta: VaultItemMeta = {
    name: noteTitle(title, text),
    ...content.meta,
    excerpt: noteExcerpt(text),
  };
  const { item } = await ctx.api.createVaultItem(
    {
      id,
      parentId,
      kind: "note",
      blobKey: content.blobKey,
      ...(await sealMeta(ctx.keyring, ctx.groupId, id, "note", meta)),
    },
    ctx.auth,
  );
  return { record: item, meta };
}

export async function createVaultFile(
  ctx: VaultContext,
  parentId: string | null,
  file: { name: string; mime: string; data: ArrayBuffer },
): Promise<VaultEntry> {
  const id = randomId();
  const content = await uploadContent(ctx, file.data);
  const meta: VaultItemMeta = { name: file.name, mime: file.mime, ...content.meta };
  const { item } = await ctx.api.createVaultItem(
    {
      id,
      parentId,
      kind: "file",
      blobKey: content.blobKey,
      ...(await sealMeta(ctx.keyring, ctx.groupId, id, "file", meta)),
    },
    ctx.auth,
  );
  return { record: item, meta };
}

/**
 * Save a new version of a note. Throws the API's `conflict` when another device
 * saved one first; the caller keeps this version as a copy rather than lose it.
 */
export async function updateVaultNote(
  ctx: VaultContext,
  entry: VaultEntry,
  title: string,
  text: string,
): Promise<VaultEntry> {
  const { record } = entry;
  const content = await uploadContent(ctx, new TextEncoder().encode(text).buffer as ArrayBuffer);
  const meta: VaultItemMeta = {
    name: noteTitle(title, text),
    ...content.meta,
    excerpt: noteExcerpt(text),
  };
  const { item } = await ctx.api.updateVaultItem(
    record.id,
    {
      revision: record.revision,
      blobKey: content.blobKey,
      ...(await sealMeta(ctx.keyring, ctx.groupId, record.id, record.kind, meta)),
    },
    ctx.auth,
  );
  return { record: item, meta };
}

export async function renameVaultItem(
  ctx: VaultContext,
  entry: VaultEntry,
  name: string,
): Promise<VaultEntry> {
  if (!entry.meta) throw new Error("This item cannot be opened on this device yet");
  const meta: VaultItemMeta = { ...entry.meta, name };
  const { item } = await ctx.api.updateVaultItem(
    entry.record.id,
    {
      revision: entry.record.revision,
      ...(await sealMeta(ctx.keyring, ctx.groupId, entry.record.id, entry.record.kind, meta)),
    },
    ctx.auth,
  );
  return { record: item, meta };
}

export async function moveVaultItem(
  ctx: VaultContext,
  entry: VaultEntry,
  parentId: string | null,
): Promise<VaultEntry> {
  const { item } = await ctx.api.updateVaultItem(
    entry.record.id,
    { revision: entry.record.revision, parentId },
    ctx.auth,
  );
  return { record: item, meta: entry.meta };
}

/**
 * Trash or restore. A restored item whose folder is itself in the trash (or
 * gone) comes back at the root rather than into a folder nobody can see.
 */
export async function setVaultItemTrashed(
  ctx: VaultContext,
  entry: VaultEntry,
  trashed: boolean,
  parentVisible = true,
): Promise<VaultEntry> {
  const { item } = await ctx.api.updateVaultItem(
    entry.record.id,
    {
      revision: entry.record.revision,
      trashed,
      ...(!trashed && !parentVisible ? { parentId: null } : {}),
    },
    ctx.auth,
  );
  return { record: item, meta: entry.meta };
}

/**
 * Seal again, under the current key, every item still sealed under an older
 * epoch this device holds. After a rotation a device that joins later holds
 * only the current key; this is what keeps the vault readable for it. Any
 * device can do it and the server skips work already done, so every device
 * simply tries. Returns how many items were re-sealed.
 */
export async function resealVault(
  ctx: VaultContext,
  entries: readonly VaultEntry[],
): Promise<number> {
  const stale = entries.filter(
    (entry): entry is VaultEntry & { meta: VaultItemMeta } =>
      entry.meta !== null && entry.record.keyEpoch < ctx.keyring.current,
  );
  let resealed = 0;
  for (let offset = 0; offset < stale.length; offset += VAULT_RESEAL_BATCH) {
    const batch = stale.slice(offset, offset + VAULT_RESEAL_BATCH);
    const items = await Promise.all(
      batch.map(async ({ record, meta }) => {
        const sealed = await sealMeta(ctx.keyring, ctx.groupId, record.id, record.kind, meta);
        return {
          id: record.id,
          revision: record.revision,
          meta: sealed.meta,
          metaIv: sealed.metaIv,
        };
      }),
    );
    resealed += (await ctx.api.resealVault({ keyEpoch: ctx.keyring.current, items }, ctx.auth))
      .resealed;
  }
  return resealed;
}

// ---------------------------------------------------------------------------
// Syncing
// ---------------------------------------------------------------------------

/**
 * Every change after `since`, across as many pages as the server splits it
 * into, folded into one answer.
 *
 * Pages are folded in order: an item purged after an earlier page listed it
 * comes back in a later page's `removed`, and must leave the result rather
 * than be resurrected by it. `reset` is true when the answer is a whole
 * listing that replaces the local copy.
 */
export async function pullVaultChanges(
  api: Api,
  auth: Auth,
  since: number,
): Promise<VaultChangesResponse> {
  const items = new Map<string, VaultItemRecord>();
  const removed = new Set<string>();
  let rebuilding = since === 0;
  let cursor = since;
  for (;;) {
    const page = await api.vaultChanges(auth, cursor, rebuilding && cursor > 0);
    if (page.reset) {
      rebuilding = true;
      items.clear();
      removed.clear();
    }
    for (const id of page.removed) {
      items.delete(id);
      removed.add(id);
    }
    for (const item of page.items) {
      removed.delete(item.id);
      items.set(item.id, item);
    }
    cursor = page.cursor;
    if (!page.more) {
      return {
        items: [...items.values()],
        removed: [...removed],
        cursor,
        more: false,
        reset: rebuilding,
        usage: page.usage,
      };
    }
  }
}

/**
 * Apply changes to a set of records by id. A `reset` starts from nothing:
 * the cursor was too old to say what was purged in between.
 */
export function applyVaultChanges(
  records: ReadonlyMap<string, VaultItemRecord>,
  changes: Pick<VaultChangesResponse, "items" | "removed" | "reset">,
): Map<string, VaultItemRecord> {
  const next = changes.reset ? new Map<string, VaultItemRecord>() : new Map(records);
  for (const id of changes.removed) next.delete(id);
  for (const item of changes.items) {
    // Never older-over-newer: this device's own write may have landed a later
    // version than the listing this answer was read from.
    const known = next.get(item.id);
    if (!known || known.seq <= item.seq) next.set(item.id, item);
  }
  return next;
}

// ---------------------------------------------------------------------------
// The tree
// ---------------------------------------------------------------------------

/**
 * Whether an item shows in the vault (rather than only in the trash): neither
 * it nor any folder above it is trashed, and every folder above it exists.
 */
export function isVaultItemVisible(
  records: ReadonlyMap<string, VaultItemRecord>,
  record: VaultItemRecord,
): boolean {
  let current: VaultItemRecord | undefined = record;
  for (let depth = 0; current && depth < 256; depth++) {
    if (current.trashedAt !== null) return false;
    if (current.parentId === null) return true;
    current = records.get(current.parentId);
  }
  return false;
}

/** The folders from the root down to `folderId` (inclusive). Empty at the root. */
export function vaultPath<T extends { record: VaultItemRecord }>(
  entries: ReadonlyMap<string, T>,
  folderId: string | null,
): T[] {
  const path: T[] = [];
  let current = folderId ? entries.get(folderId) : undefined;
  while (current && path.length < 256) {
    path.unshift(current);
    current = current.record.parentId ? entries.get(current.record.parentId) : undefined;
  }
  return path;
}

/** Ids of `folderId` and every folder nested in it: where it may not be moved. */
export function vaultSubtree(
  records: ReadonlyMap<string, VaultItemRecord>,
  folderId: string,
): Set<string> {
  const subtree = new Set([folderId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const record of records.values()) {
      if (record.parentId && subtree.has(record.parentId) && !subtree.has(record.id)) {
        subtree.add(record.id);
        grew = true;
      }
    }
  }
  return subtree;
}
