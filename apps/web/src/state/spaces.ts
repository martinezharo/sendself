/**
 * The spaces this device holds, and which one the app is currently in.
 *
 * A space is the unit of everything else: one session, one keyring, one
 * history, one URL (`/app/<id>`). The app works in exactly one at a time — the
 * one the route names — so opening a space is what loads its session into the
 * signals the rest of the UI reads, and closing it is what unloads them.
 *
 * The registry lives in db/spaces.ts; this module is the reactive view of it
 * plus the lifecycle: open, create, forget. Renaming is in sync/spaceName.ts,
 * because a name belongs to the space rather than to the device holding it.
 */

import { clearVault } from "./vaultItems";
import { signal } from "@preact/signals";
import {
  GLOBAL_LAST_SPACE,
  GLOBAL_VAULT,
  LEGACY_SPACE_ID,
  type SpaceRecord,
  addSpace,
  getSpace,
  globalMetaDelete,
  globalMetaGet,
  globalMetaSet,
  listSpaces,
  registerLegacySpace,
  removeSpace,
} from "../db/spaces";
import {
  META_LEGACY_VAULT,
  META_SESSION,
  deleteSpaceData,
  metaDelete,
  metaGet,
  setActiveSpace,
  spaceDataExists,
} from "../db/store";
import { clearSessionState, loadSession } from "./session";

/** Every space on this device, oldest first. */
export const spaces = signal<SpaceRecord[]>([]);

/** The space the app is in, or null on the space list / landing page. */
export const activeSpace = signal<SpaceRecord | null>(null);

/**
 * How the at-rest lock takes part in the lifecycle, registered by
 * state/lock.ts rather than imported from it: the lock is built on top of
 * spaces, and importing it here would make that circular.
 *
 * While a lock is set the secrets of *every* space live in one envelope, so
 * opening a space reads them from there instead of from its database, and
 * forgetting a space has to take it out of the envelope too.
 */
export interface VaultBridge {
  /** Hydrate a space's secrets from the open vault. False = not in it. */
  load(spaceId: string): Promise<boolean>;
  /** Drop a space from the envelope and re-seal. No-op without a lock. */
  forget(spaceId: string): Promise<void>;
}

let vault: VaultBridge | null = null;

export function setVaultBridge(bridge: VaultBridge | null): void {
  vault = bridge;
}

/**
 * Adopt the space of a device that was set up before spaces were plural.
 *
 * Nothing moves: that space's storage already *is* the database
 * `LEGACY_SPACE_ID` maps to, so this only records that it exists and lifts the
 * at-rest vault envelope out of it, since a lock now covers the device rather
 * than one space. Runs before the lock state is read, which is where the moved
 * envelope is expected.
 */
export async function adoptLegacySpace(): Promise<void> {
  if (await getSpace(LEGACY_SPACE_ID)) return;
  if (!(await spaceDataExists(LEGACY_SPACE_ID))) return;

  const [storedSession, storedVault] = await Promise.all([
    metaGet<unknown>(META_SESSION, LEGACY_SPACE_ID),
    metaGet<unknown>(META_LEGACY_VAULT, LEGACY_SPACE_ID),
  ]);
  // No session and no envelope: an empty database, not a space.
  if (!storedSession && !storedVault) return;

  await registerLegacySpace();
  if (storedVault) {
    await globalMetaSet(GLOBAL_VAULT, storedVault);
    await metaDelete(META_LEGACY_VAULT, LEGACY_SPACE_ID);
  }
}

export async function refreshSpaces(): Promise<void> {
  spaces.value = await listSpaces();
}

/**
 * The space the app was in when it was last left, if it was in one.
 *
 * This is what a launch with no space in the URL — the installed app's
 * `start_url`, a bookmark to `/app` — reopens, so a device that only ever uses
 * one space never has to step through a list of one to reach it.
 */
export function lastOpenedSpace(): Promise<string | undefined> {
  return globalMetaGet<string>(GLOBAL_LAST_SPACE);
}

/**
 * Leave nothing to reopen into. Being on the space list is a place in its own
 * right, so backing out to it is also how the user opts out of landing in a
 * space on the next launch.
 */
export function forgetLastSpace(): Promise<void> {
  return globalMetaDelete(GLOBAL_LAST_SPACE);
}

/**
 * Make `spaceId` the space the app works in, loading its session and keys.
 * False when this device has no such space — a stale bookmark, or a space that
 * was left on this device but not on the one the link came from.
 */
export async function openSpace(spaceId: string): Promise<boolean> {
  const record = await getSpace(spaceId);
  if (!record) return false;

  setActiveSpace(spaceId);
  activeSpace.value = record;
  await globalMetaSet(GLOBAL_LAST_SPACE, spaceId);

  if (!(await vault?.load(spaceId))) await loadSession();
  return true;
}

/** Leave the space view: nothing about it stays in memory. */
export function closeSpace(): void {
  setActiveSpace(null);
  activeSpace.value = null;
  clearSessionState();
  clearVault();
}

/**
 * Register a new space and make it the active one. Called *before* the space
 * exists anywhere else (creating it on the server, or completing a pairing), so
 * everything that follows already writes into its own storage.
 */
export async function beginSpace(name: string | null): Promise<SpaceRecord> {
  const record = await addSpace(name);
  setActiveSpace(record.id);
  activeSpace.value = record;
  spaces.value = [...spaces.value, record];
  await globalMetaSet(GLOBAL_LAST_SPACE, record.id);
  return record;
}

/**
 * Mirror a record the registry just wrote into the reactive view.
 *
 * The name of a space changes from two directions — renamed here, or renamed on
 * another device and adopted on the next poll (sync/spaceName.ts) — and both
 * end here, so neither can update the list without updating the open space or
 * the other way round.
 */
export function applySpaceRecord(record: SpaceRecord | undefined): void {
  if (!record) return;
  if (activeSpace.value?.id === record.id) activeSpace.value = record;
  spaces.value = spaces.value.map((space) => (space.id === record.id ? record : space));
}

/**
 * Remove a space from this device: its database, its entry in the registry and
 * its secrets in the vault. The space itself lives on — other devices keep
 * their access, and this one can be linked again later.
 */
export async function forgetSpace(spaceId: string): Promise<void> {
  await vault?.forget(spaceId);
  await deleteSpaceData(spaceId);
  await removeSpace(spaceId);
  spaces.value = spaces.value.filter((space) => space.id !== spaceId);
  if (activeSpace.value?.id === spaceId) closeSpace();
  if ((await lastOpenedSpace()) === spaceId) await forgetLastSpace();
}
