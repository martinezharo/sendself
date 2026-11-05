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
import { ApiError, NetworkError, quietApi, reportAuthFailure } from "../api/client";

/**
 * Every vault request goes through the quiet client: a request made for a
 * space the user has since left must not mark the space now open as revoked.
 * A dead-session answer is reported only after checking it came from the
 * open space's own credentials.
 */
const api = quietApi;
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
/**
 * Bumped whenever the vault in memory is replaced (a space loaded or closed).
 * Every pass that awaits checks it before publishing anything, so a sync still
 * running for the previous space cannot write its items, cursor or usage over
 * the space that is open now.
 */
let generation = 0;

function begin(): number {
  generation += 1;
  syncing = null;
  again = false;
  return generation;
}

/** Whether a pass started at `run` for `spaceId` may still publish its results. */
function stillCurrent(run: number, spaceId: string): boolean {
  return run === generation && activeSpaceId() === spaceId;
}
/** Whether this session asked the server yet: the usage figures only come from there. */
let fetched = false;
let syncing: Promise<void> | null = null;
/** Another pass was asked for while one was running. */
let again = false;
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
  previous: ReadonlyMap<string, VaultEntry> = vaultEntries.value,
): Promise<Map<string, VaultEntry>> {
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
  const run = begin();
  const stored = await loadVaultRecords(spaceId);
  if (!stillCurrent(run, spaceId)) return;
  const records = new Map(stored.records.map((record) => [record.id, record]));
  // Nothing in memory is reused: it may be another space's.
  const opened = await openRecords(records, ring, current.groupId, new Map());
  if (!stillCurrent(run, spaceId)) return;
  vaultEntries.value = opened;
  cursor = stored.cursor;
  fetched = false;
  vaultSpace.value = spaceId;
}

/** Forget the vault in memory (the space was closed). */
export function clearVault(): void {
  begin();
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
  if (syncing) {
    // Asked while a pass is running (typically right after this device's own
    // write): that pass may have read the server before the write, so run
    // another one once it is done rather than settle for it.
    again = true;
    return syncing;
  }
  const pass = runSync(ring, vaultSeq).finally(() => {
    // A newer space may already have started its own pass: leave that one be.
    if (syncing !== pass) return;
    syncing = null;
    if (again) {
      again = false;
      const latest = keyring.value;
      if (latest) void syncVault(latest).catch(() => {});
    }
  });
  syncing = pass;
  return pass;
}

async function runSync(ring: Keyring, vaultSeq?: number): Promise<void> {
  const spaceId = activeSpaceId();
  const current = session.value;
  if (!spaceId || !current || vaultSpace.value !== spaceId) return;
  const run = generation;

  const stale = vaultSeq === undefined || vaultSeq !== cursor || !fetched;
  let records = recordsOf(vaultEntries.value);
  if (stale) {
    const changes = await pullVaultChanges(api, authHeaders(), cursor).catch((error: unknown) => {
      if (stillCurrent(run, spaceId)) reportAuthFailure(error);
      throw error;
    });
    if (!stillCurrent(run, spaceId)) return;
    await storeVaultChanges(changes, spaceId);
    if (!stillCurrent(run, spaceId)) return;
    // Applied to what is in memory now, not to what it was before the fetch:
    // a write this device finished meanwhile is newer than the listing.
    const previous = recordsOf(vaultEntries.value);
    records = applyVaultChanges(previous, changes);
    // Content cached for a blob no record points at any more (purged, edited
    // elsewhere, or dropped by a reset) is unreachable: let it go.
    for (const [id, record] of previous) {
      if (record.blobKey && records.get(id)?.blobKey !== record.blobKey) {
        forgetCachedContent({ record, meta: null }, spaceId);
      }
    }
    cursor = changes.cursor;
    fetched = true;
    vaultUsage.value = changes.usage;
  }

  const keyChanged = [...vaultEntries.value.values()].some(
    (entry) => !entry.meta && ring.keys.has(entry.record.keyEpoch),
  );
  if (stale || keyChanged) {
    const before = vaultEntries.value;
    const opened = await openRecords(records, ring, current.groupId);
    if (!stillCurrent(run, spaceId)) return;
    // Opening is asynchronous too: keep what this device wrote while it ran,
    // and nothing else (an entry merely left over from before the sync may be
    // one the server just reported purged).
    for (const [id, entry] of vaultEntries.value) {
      if (before.get(id) === entry) continue;
      const mine = opened.get(id);
      if (!mine || mine.record.seq < entry.record.seq) opened.set(id, entry);
    }
    vaultEntries.value = opened;
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

/**
 * The space a write was started in, and the credentials and keys it seals and
 * authenticates with. Captured once, when the write starts: switching spaces
 * while an upload is still going must neither send the rest of it to the space
 * now on screen nor file its results in that space's copy.
 */
interface Target {
  spaceId: string;
  ctx: VaultContext;
}

function target(): Target {
  const spaceId = activeSpaceId();
  const current = session.value;
  const ring = keyring.value;
  if (!spaceId || !current || !ring) throw new Error("No space is open");
  return { spaceId, ctx: { api, auth: authHeaders(), groupId: current.groupId, keyring: ring } };
}

/** Whether the space a write started in is still the one loaded on screen. */
function stillOpen(t: Target): boolean {
  return activeSpaceId() === t.spaceId && vaultSpace.value === t.spaceId;
}

/** Put a record the server just returned into the copy, without moving the cursor. */
async function remember(t: Target, entry: VaultEntry): Promise<VaultEntry> {
  // Never newer-for-older: a response that took its time can arrive after a
  // sync already brought in a later change to the same item.
  await storeVaultChanges({ items: [entry.record], removed: [] }, t.spaceId);
  if (stillOpen(t)) {
    const known = vaultEntries.value.get(entry.record.id);
    if (!known || known.record.seq < entry.record.seq) {
      if (known?.record.blobKey !== entry.record.blobKey) forgetCachedContent(known, t.spaceId);
      const next = new Map(vaultEntries.value);
      next.set(entry.record.id, entry);
      vaultEntries.value = next;
    }
    refreshAfterWrite();
  }
  return entry;
}

/** Catch up after this device's own write: the usage figures only come from the server. */
function refreshAfterWrite(): void {
  const ring = keyring.value;
  if (ring) void syncVault(ring).catch(() => {});
}

async function forget(t: Target, ids: readonly string[]): Promise<void> {
  const known = vaultEntries.value;
  if (stillOpen(t)) {
    for (const id of ids) forgetCachedContent(known.get(id), t.spaceId);
  }
  await storeVaultChanges({ items: [], removed: ids }, t.spaceId);
  if (stillOpen(t)) {
    const next = new Map(vaultEntries.value);
    for (const id of ids) next.delete(id);
    vaultEntries.value = next;
    refreshAfterWrite();
  }
}

function forgetCachedContent(entry: VaultEntry | undefined, spaceId?: string): void {
  if (entry?.record.blobKey) {
    void deleteFile(vaultFileKey(entry.record.blobKey), spaceId).catch(() => {});
  }
}

/**
 * Run a write, catching up with a key rotation once if the server says the
 * space's key moved on while this device was sealing. The new key arrives
 * through the open space's sync, so a write for a space that is no longer open
 * fails instead of being retried with another space's keys.
 */
async function write<T>(t: Target, operation: (ctx: VaultContext) => Promise<T>): Promise<T> {
  try {
    return await operation(t.ctx);
  } catch (error) {
    if (stillOpen(t)) reportAuthFailure(error);
    if (!(error instanceof ApiError) || error.code !== "key_rotated" || !stillOpen(t)) throw error;
    await refreshKeys();
    const fresh = target();
    if (fresh.spaceId !== t.spaceId) throw error;
    t.ctx = fresh.ctx;
    return operation(t.ctx).catch((retryError: unknown) => {
      if (stillOpen(t)) reportAuthFailure(retryError);
      throw retryError;
    });
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
  return attempt(async () => {
    const t = target();
    return remember(t, await write(t, (ctx) => createVaultFolder(ctx, parentId, name)));
  });
}

export function createNote(
  parentId: string | null,
  title: string,
  text: string,
): Promise<VaultEntry | undefined> {
  return attempt(async () => {
    const t = target();
    return remember(t, await write(t, (ctx) => createVaultNote(ctx, parentId, title, text)));
  });
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
    const t = target();
    try {
      const saved = await remember(
        t,
        await write(t, (ctx) => updateVaultNote(ctx, entry, title, text)),
      );
      forgetCachedContent(entry, t.spaceId);
      return saved;
    } catch (error) {
      if (!(error instanceof ApiError) || error.code !== "conflict") throw error;
      const copy = await remember(
        t,
        await write(t, (ctx) =>
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
  let t: Target;
  try {
    t = target();
  } catch (error) {
    showToast(vaultErrorText(error), "error");
    return 0;
  }
  let saved = 0;
  let remaining = files.length;
  vaultUploads.value += remaining;
  try {
    for (const file of files) {
      const entry = await attempt(async () =>
        remember(
          t,
          await write(t, async (ctx) =>
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
  return attempt(async () => {
    const t = target();
    return remember(t, await write(t, (ctx) => renameVaultItem(ctx, entry, name)));
  });
}

export function moveItem(
  entry: VaultEntry,
  parentId: string | null,
): Promise<VaultEntry | undefined> {
  return attempt(async () => {
    const t = target();
    return remember(t, await write(t, (ctx) => moveVaultItem(ctx, entry, parentId)));
  });
}

export function trashItem(entry: VaultEntry): Promise<VaultEntry | undefined> {
  return attempt(async () => {
    const t = target();
    return remember(t, await write(t, (ctx) => setVaultItemTrashed(ctx, entry, true)));
  });
}

/** Restore from the trash, to the top level when its folder is not there to return to. */
export function restoreItem(entry: VaultEntry): Promise<VaultEntry | undefined> {
  const records = recordsOf(vaultEntries.value);
  const parent = entry.record.parentId ? records.get(entry.record.parentId) : undefined;
  const parentVisible =
    entry.record.parentId === null || (!!parent && isVaultItemVisible(records, parent));
  return attempt(async () => {
    const t = target();
    return remember(
      t,
      await write(t, (ctx) => setVaultItemTrashed(ctx, entry, false, parentVisible)),
    );
  });
}

export function deleteForever(entry: VaultEntry): Promise<boolean> {
  return attempt(async () => {
    const t = target();
    const { removed } = await write(t, (ctx) => ctx.api.deleteVaultItem(entry.record.id, ctx.auth));
    await forget(t, removed);
    return true;
  }).then((done) => done === true);
}

export async function emptyTrash(): Promise<void> {
  for (const entry of trashedVaultEntries.value) {
    // Purging a trashed folder takes everything inside it, trashed or not.
    if (!vaultEntries.value.has(entry.record.id)) continue;
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
  const t = target();
  const cacheKey = vaultFileKey(record.blobKey);
  const cached = await getFile(cacheKey, t.spaceId).catch(() => undefined);
  if (cached) return cached;
  const data = await write(t, (ctx) => readVaultContent(ctx, entry));
  const blob = new Blob([data], {
    type: meta.mime ?? (record.kind === "note" ? "text/plain" : ""),
  });
  await putFile(cacheKey, blob, t.spaceId).catch(() => {});
  return blob;
}

export async function readNote(entry: VaultEntry): Promise<string> {
  return (await openContent(entry)).text();
}

export function entryName(entry: VaultEntry): string {
  return entry.meta?.name ?? "Locked item";
}
