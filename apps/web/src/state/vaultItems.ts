/**
 * The open space's vault: its folders, notes and files, kept in sync with the
 * server and opened with this device's keys.
 *
 * (Not to be confused with the at-rest lock in crypto/vault.ts, which predates
 * this and seals the whole device. This module is the user-facing Vault.)
 *
 * The server is the source of truth and every write goes through it first: a
 * vault is shared state that two devices can edit at once, and the server's
 * revision check is what keeps one from silently overwriting the other. What
 * this module adds is the local copy (IndexedDB, as the server's own
 * ciphertext) that lets the vault open instantly and offline, and the opened
 * view the UI renders.
 */

import { computed, signal } from "@preact/signals";
import { VAULT_BYTES_QUOTA, type VaultItemRecord } from "@sendself/shared";
import {
  type VaultContext,
  type VaultEntry,
  applyVaultChanges,
  createVaultFile,
  createVaultFolder,
  createVaultNote,
  isVaultItemVisible,
  moveVaultItem,
  openVaultMeta,
  pullVaultChanges,
  readVaultContent,
  renameVaultItem,
  resealVault,
  setVaultItemTrashed,
  updateVaultNote,
} from "@sendself/client/vault";
import { ApiError, NetworkError, api } from "../api/client";
import type { Keyring } from "../crypto/keyring";
import {
  activeSpace as activeSpaceId,
  deleteFile,
  getFile,
  loadVaultRecords,
  putFile,
  storeVaultChanges,
  vaultFileKey,
} from "../db/store";
import { authHeaders, keyring, session } from "./session";
import { showToast } from "./ui";

export type { VaultEntry };

/** Every live item, opened where this device holds the key. Keyed by id. */
export const vaultEntries = signal<ReadonlyMap<string, VaultEntry>>(new Map());
/** What the vault holds against its quota, as of the last sync. */
export const vaultUsage = signal<{ bytes: number; items: number }>({ bytes: 0, items: 0 });
/** The space whose vault is loaded, so a view never renders another space's. */
export const vaultSpace = signal<string | null>(null);
/** Files on their way into the vault, for the progress the view shows. */
export const vaultUploads = signal(0);

export const vaultQuota = VAULT_BYTES_QUOTA;

/** Items not in the trash (nor inside a trashed folder). */
export const visibleVaultEntries = computed(() => {
  const records = recordsOf(vaultEntries.value);
  return [...vaultEntries.value.values()].filter((entry) =>
    isVaultItemVisible(records, entry.record),
  );
});

/** What the trash lists: items trashed themselves, not everything inside them. */
export const trashedVaultEntries = computed(() =>
  [...vaultEntries.value.values()].filter((entry) => entry.record.trashedAt !== null),
);

let cursor = 0;
/** Whether this session asked the server yet: the usage figures only come from there. */
let fetched = false;
let syncing: Promise<void> | null = null;
let resealing = false;

/**
 * How a write that met a key rotation catches up before trying again: the
 * sync engine adopts the new key. Registered by sync/sync.ts, which imports
 * this module, so the dependency only runs one way.
 */
let refreshKeys: () => Promise<void> = async () => {};
export function setVaultKeyRefresher(refresher: () => Promise<void>): void {
  refreshKeys = refresher;
}

function recordsOf(entries: ReadonlyMap<string, VaultEntry>): Map<string, VaultItemRecord> {
  return new Map([...entries].map(([id, entry]) => [id, entry.record]));
}

/**
 * Open the records whose ciphertext changed, reusing what was already opened.
 * A record this device could not open is tried again whenever it is asked to,
 * since a key it was missing may have arrived since.
 */
async function openRecords(
  records: ReadonlyMap<string, VaultItemRecord>,
  ring: Keyring,
  groupId: string,
): Promise<Map<string, VaultEntry>> {
  const previous = vaultEntries.value;
  const opened = new Map<string, VaultEntry>();
  await Promise.all(
    [...records.values()].map(async (record) => {
      const known = previous.get(record.id);
      const unchanged =
        known?.meta &&
        known.record.meta === record.meta &&
        known.record.keyEpoch === record.keyEpoch;
      opened.set(record.id, {
        record,
        meta: unchanged ? known.meta : await openVaultMeta(ring, groupId, record),
      });
    }),
  );
  return opened;
}

/** Load the open space's local copy. Called when a session starts. */
export async function loadVault(): Promise<void> {
  const spaceId = activeSpaceId();
  const ring = keyring.value;
  const current = session.value;
  if (!spaceId || !ring || !current) return;
  const stored = await loadVaultRecords();
  if (activeSpaceId() !== spaceId) return;
  vaultEntries.value = new Map();
  const records = new Map(stored.records.map((record) => [record.id, record]));
  vaultEntries.value = await openRecords(records, ring, current.groupId);
  cursor = stored.cursor;
  fetched = false;
  vaultSpace.value = spaceId;
}

/** Forget the vault in memory (the space was closed). */
export function clearVault(): void {
  vaultEntries.value = new Map();
  vaultUsage.value = { bytes: 0, items: 0 };
  vaultSpace.value = null;
  cursor = 0;
  fetched = false;
}

/**
 * Bring the local copy up to date. `vaultSeq` is the counter the poll just
 * reported: when it matches the cursor there is nothing to fetch, which is
 * what keeps an unchanged vault from costing a request per poll. Also re-seals
 * what an older key sealed, once this device holds the current one.
 */
export function syncVault(ring: Keyring, vaultSeq?: number): Promise<void> {
  if (syncing) return syncing;
  syncing = runSync(ring, vaultSeq).finally(() => {
    syncing = null;
  });
  return syncing;
}

async function runSync(ring: Keyring, vaultSeq?: number): Promise<void> {
  const spaceId = activeSpaceId();
  const current = session.value;
  if (!spaceId || !current || vaultSpace.value !== spaceId) return;

  const stale = vaultSeq === undefined || vaultSeq !== cursor || !fetched;
  let records = recordsOf(vaultEntries.value);
  if (stale) {
    const changes = await pullVaultChanges(api, authHeaders(), cursor);
    if (activeSpaceId() !== spaceId) return;
    await storeVaultChanges(changes);
    records = applyVaultChanges(records, changes);
    cursor = changes.cursor;
    fetched = true;
    vaultUsage.value = changes.usage;
    for (const id of changes.removed) forgetCachedContent(vaultEntries.value.get(id));
  }

  const keyChanged = [...vaultEntries.value.values()].some(
    (entry) => !entry.meta && ring.keys.has(entry.record.keyEpoch),
  );
  if (stale || keyChanged) {
    vaultEntries.value = await openRecords(records, ring, current.groupId);
  }

  await resealStale(ring, current.groupId);
}

/** See `resealVault`. Quiet on failure: the next pass tries again. */
async function resealStale(ring: Keyring, groupId: string): Promise<void> {
  if (resealing) return;
  const entries = [...vaultEntries.value.values()];
  if (!entries.some((entry) => entry.meta && entry.record.keyEpoch < ring.current)) return;
  resealing = true;
  try {
    await resealVault({ api, auth: authHeaders(), groupId, keyring: ring }, entries);
  } catch {
    // Retried on the next pass.
  } finally {
    resealing = false;
  }
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

function context(): VaultContext {
  const current = session.value;
  const ring = keyring.value;
  if (!current || !ring) throw new Error("No space is open");
  return { api, auth: authHeaders(), groupId: current.groupId, keyring: ring };
}

/** Put a record the server just returned into the copy, without moving the cursor. */
async function remember(entry: VaultEntry): Promise<VaultEntry> {
  const next = new Map(vaultEntries.value);
  next.set(entry.record.id, entry);
  vaultEntries.value = next;
  await storeVaultChanges({ items: [entry.record], removed: [] });
  refreshAfterWrite();
  return entry;
}

/** Catch up after this device's own write: the usage figures only come from the server. */
function refreshAfterWrite(): void {
  const ring = keyring.value;
  if (ring) void syncVault(ring).catch(() => {});
}

async function forget(ids: readonly string[]): Promise<void> {
  const next = new Map(vaultEntries.value);
  for (const id of ids) {
    forgetCachedContent(next.get(id));
    next.delete(id);
  }
  vaultEntries.value = next;
  await storeVaultChanges({ items: [], removed: ids });
  refreshAfterWrite();
}

function forgetCachedContent(entry: VaultEntry | undefined): void {
  if (entry?.record.blobKey) void deleteFile(vaultFileKey(entry.record.blobKey)).catch(() => {});
}

/**
 * Run a write, catching up with a key rotation once if the server says the
 * space's key moved on while this device was sealing.
 */
async function write<T>(operation: (ctx: VaultContext) => Promise<T>): Promise<T> {
  try {
    return await operation(context());
  } catch (error) {
    if (!(error instanceof ApiError) || error.code !== "key_rotated") throw error;
    await refreshKeys();
    return operation(context());
  }
}

/** What to tell the user about a write that failed. */
export function vaultErrorText(error: unknown): string {
  if (error instanceof NetworkError) return "You're offline. The vault needs a connection to save";
  if (error instanceof ApiError) {
    if (error.code === "conflict") return "It changed on another device. Try again";
    if (error.code === "not_found") return "That item no longer exists";
    return error.message;
  }
  return error instanceof Error ? error.message : "Something went wrong";
}

/** Run a write and report its failure as a toast. Resolves to undefined when it failed. */
async function attempt<T>(run: () => Promise<T>): Promise<T | undefined> {
  try {
    return await run();
  } catch (error) {
    showToast(vaultErrorText(error), "error");
    return undefined;
  }
}

export function createFolder(
  parentId: string | null,
  name: string,
): Promise<VaultEntry | undefined> {
  return attempt(async () =>
    remember(await write((ctx) => createVaultFolder(ctx, parentId, name))),
  );
}

export function createNote(
  parentId: string | null,
  title: string,
  text: string,
): Promise<VaultEntry | undefined> {
  return attempt(async () =>
    remember(await write((ctx) => createVaultNote(ctx, parentId, title, text))),
  );
}

/**
 * Save an edited note. If another device saved it first, this version is kept
 * as a new note next to it instead of being lost or overwriting theirs.
 */
export function saveNote(
  entry: VaultEntry,
  title: string,
  text: string,
): Promise<VaultEntry | undefined> {
  return attempt(async () => {
    try {
      const saved = await remember(await write((ctx) => updateVaultNote(ctx, entry, title, text)));
      if (entry.record.blobKey) void deleteFile(vaultFileKey(entry.record.blobKey)).catch(() => {});
      return saved;
    } catch (error) {
      if (!(error instanceof ApiError) || error.code !== "conflict") throw error;
      const copy = await remember(
        await write((ctx) =>
          createVaultNote(ctx, entry.record.parentId, `${title.trim() || "Note"} (copy)`, text),
        ),
      );
      showToast("Edited on another device too. Your version was saved as a copy");
      return copy;
    }
  });
}

/** Upload files into a folder, one after another. Resolves to how many made it. */
export async function uploadFiles(
  parentId: string | null,
  files: readonly File[],
): Promise<number> {
  let saved = 0;
  let remaining = files.length;
  vaultUploads.value += remaining;
  try {
    for (const file of files) {
      const entry = await attempt(async () =>
        remember(
          await write(async (ctx) =>
            createVaultFile(ctx, parentId, {
              name: file.name,
              mime: file.type || "application/octet-stream",
              data: await file.arrayBuffer(),
            }),
          ),
        ),
      );
      remaining--;
      vaultUploads.value -= 1;
      // The rest would most likely fail the same way (offline, full): stop at one toast.
      if (!entry) break;
      saved++;
    }
  } finally {
    vaultUploads.value -= remaining;
  }
  return saved;
}

export function renameItem(entry: VaultEntry, name: string): Promise<VaultEntry | undefined> {
  return attempt(async () => remember(await write((ctx) => renameVaultItem(ctx, entry, name))));
}

export function moveItem(
  entry: VaultEntry,
  parentId: string | null,
): Promise<VaultEntry | undefined> {
  return attempt(async () => remember(await write((ctx) => moveVaultItem(ctx, entry, parentId))));
}

export function trashItem(entry: VaultEntry): Promise<VaultEntry | undefined> {
  return attempt(async () => remember(await write((ctx) => setVaultItemTrashed(ctx, entry, true))));
}

/** Restore from the trash, to the top level when its folder is not there to return to. */
export function restoreItem(entry: VaultEntry): Promise<VaultEntry | undefined> {
  const records = recordsOf(vaultEntries.value);
  const parent = entry.record.parentId ? records.get(entry.record.parentId) : undefined;
  const parentVisible =
    entry.record.parentId === null || (!!parent && isVaultItemVisible(records, parent));
  return attempt(async () =>
    remember(await write((ctx) => setVaultItemTrashed(ctx, entry, false, parentVisible))),
  );
}

export function deleteForever(entry: VaultEntry): Promise<boolean> {
  return attempt(async () => {
    const { removed } = await api.deleteVaultItem(entry.record.id, authHeaders());
    await forget(removed);
    return true;
  }).then((done) => done === true);
}

export async function emptyTrash(): Promise<void> {
  for (const entry of trashedVaultEntries.value) {
    if (!(await deleteForever(entry))) return;
  }
}

// ---------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------

/** A note's or file's content, from the local cache or downloaded and opened. */
export async function openContent(entry: VaultEntry): Promise<Blob> {
  const { record, meta } = entry;
  if (!record.blobKey || !meta) throw new Error("This item can't be opened on this device yet");
  const cacheKey = vaultFileKey(record.blobKey);
  const cached = await getFile(cacheKey).catch(() => undefined);
  if (cached) return cached;
  const current = session.value;
  if (!current) throw new Error("No space is open");
  const data = await readVaultContent(
    { api, auth: authHeaders(), groupId: current.groupId },
    entry,
  );
  const blob = new Blob([data], {
    type: meta.mime ?? (record.kind === "note" ? "text/plain" : ""),
  });
  await putFile(cacheKey, blob).catch(() => {});
  return blob;
}

export async function readNote(entry: VaultEntry): Promise<string> {
  return (await openContent(entry)).text();
}

export function entryName(entry: VaultEntry): string {
  return entry.meta?.name ?? "Locked item";
}
