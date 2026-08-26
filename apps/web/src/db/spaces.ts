/**
 * The registry of spaces this device belongs to, and the device-global state
 * that cannot live inside any one of them.
 *
 * A space owns everything about itself — its session, its keys, its history,
 * its cached files — in its own IndexedDB database (db/store.ts). What is left
 * over is exactly two things, and they live here:
 *
 *  - **which spaces exist**, with the local name the user gave them, so `/app`
 *    can list them before any of them is opened, and
 *  - **the at-rest vault envelope**, because a lock protects the *device* (all
 *    of its spaces at once), not a single space.
 *
 * A space's name is shared by every device in it, but the server never sees it
 * in the clear: it holds a GroupKey-encrypted copy (see sync/spaceName.ts), and
 * this is where the readable one lives. While an at-rest lock is set it is
 * sealed under the same content key as the message history — a list of space
 * names is a meaningful thing to leak on its own.
 */

import { type DBSchema, type IDBPDatabase, openDB } from "idb";
import { randomId } from "../crypto/crypto";
import { PRE_REBRAND_ID } from "../legacy";
import { type KeyChoice, type Sealed, openJson, sealJson } from "./atrest";

/**
 * The space of a device that was set up before spaces were plural. Its data
 * stays in the original database, so an update registers it instead of
 * migrating anything (see `registerLegacySpace`).
 */
export const LEGACY_SPACE_ID = "default";

/** Shown wherever a space has no name of its own. */
export const UNNAMED_SPACE = "Untitled";

export interface SpaceRecord {
  /** Local id: the URL segment (`/app/<id>`) and the storage namespace. */
  id: string;
  /** Null when the space was never named, or while this device is locked. */
  name: string | null;
  createdAt: number;
  /**
   * Server-assigned time of the shared name this device has adopted, or 0 when
   * it has never seen one. Anything newer than this replaces the local name.
   */
  nameUpdatedAt: number;
  /** A rename made here has not reached the space yet. Until it does, it wins. */
  namePending: boolean;
}

/** A row as stored: the name is sealed whenever a lock is set. */
interface StoredSpace {
  id: string;
  createdAt: number;
  name?: string | null;
  sealed?: Sealed;
  /** Absent on rows written before names were shared: unsynced, like a new space. */
  nameUpdatedAt?: number;
  namePending?: boolean;
}

interface RegistryDB extends DBSchema {
  spaces: { key: string; value: StoredSpace };
  /** Device-global key-value pairs (the vault envelope, the last space opened). */
  meta: { key: string; value: unknown };
}

const REGISTRY_DB_NAME = `${PRE_REBRAND_ID}-registry`;
const REGISTRY_DB_VERSION = 1;

/**
 * The sealed envelope holding every space's secrets while an at-rest lock is
 * set (crypto/vault.ts). Device-global: one lock covers the device.
 */
export const GLOBAL_VAULT = "vault";
/** Last space opened, so a share target or a cold start lands where it left off. */
export const GLOBAL_LAST_SPACE = "lastSpace";
/** In-flight device linking, which belongs to no space until it succeeds. */
export const GLOBAL_PENDING_PAIRING = "pendingPairing";

let registryPromise: Promise<IDBPDatabase<RegistryDB>> | null = null;

function registry(): Promise<IDBPDatabase<RegistryDB>> {
  if (!registryPromise) {
    registryPromise = openDB<RegistryDB>(REGISTRY_DB_NAME, REGISTRY_DB_VERSION, {
      upgrade(database) {
        database.createObjectStore("spaces", { keyPath: "id" });
        database.createObjectStore("meta");
      },
    });
  }
  return registryPromise;
}

// --- device-global meta ---

export async function globalMetaGet<T>(key: string): Promise<T | undefined> {
  return (await (await registry()).get("meta", key)) as T | undefined;
}

export async function globalMetaSet(key: string, value: unknown): Promise<void> {
  await (await registry()).put("meta", value, key);
}

export async function globalMetaDelete(key: string): Promise<void> {
  await (await registry()).delete("meta", key);
}

// --- the space list ---

/** Name context bound as AAD, so a sealed name cannot be moved onto another space. */
const nameContext = (id: string): string => `space-name:${id}`;

async function toStored(space: SpaceRecord, target?: KeyChoice): Promise<StoredSpace> {
  const sync = { nameUpdatedAt: space.nameUpdatedAt, namePending: space.namePending };
  if (space.name === null) return { id: space.id, createdAt: space.createdAt, name: null, ...sync };
  const sealed = await sealJson(space.name, nameContext(space.id), target);
  return sealed
    ? { id: space.id, createdAt: space.createdAt, sealed, ...sync }
    : { id: space.id, createdAt: space.createdAt, name: space.name, ...sync };
}

/** A sealed name this device cannot open right now reads as "unnamed". */
async function fromStored(stored: StoredSpace): Promise<SpaceRecord> {
  const name = stored.sealed
    ? ((await openJson<string>(stored.sealed, nameContext(stored.id)).catch(() => null)) ?? null)
    : (stored.name ?? null);
  return {
    id: stored.id,
    createdAt: stored.createdAt,
    name,
    nameUpdatedAt: stored.nameUpdatedAt ?? 0,
    namePending: stored.namePending ?? false,
  };
}

/** Write a record back, re-sealing its name under whatever key is in force. */
async function writeSpace(space: SpaceRecord): Promise<SpaceRecord> {
  await (await registry()).put("spaces", await toStored(space));
  return space;
}

/** Every space on this device, oldest first. */
export async function listSpaces(): Promise<SpaceRecord[]> {
  const rows = await (await registry()).getAll("spaces");
  const spaces = await Promise.all(rows.map(fromStored));
  return spaces.sort((a, b) => a.createdAt - b.createdAt);
}

export async function getSpace(id: string): Promise<SpaceRecord | undefined> {
  const stored = await (await registry()).get("spaces", id);
  return stored ? fromStored(stored) : undefined;
}

/** Register a new space and return its record. The id is what the URL carries. */
export async function addSpace(name: string | null): Promise<SpaceRecord> {
  return writeSpace({
    id: randomId(),
    name: name?.trim() || null,
    createdAt: Date.now(),
    // Whatever name it starts with is this device's own: either the user just
    // typed it, or it came through the pairing package. The space's shared name
    // (if it has one) arrives on the first poll and takes over from there.
    nameUpdatedAt: 0,
    namePending: false,
  });
}

/**
 * Rename the space here, and owe the rest of them the same name.
 *
 * The local write happens first and unconditionally, so the new name is on
 * screen before anything touches the network; `namePending` is what makes the
 * sync loop keep trying until every other device has it (sync/spaceName.ts).
 */
export async function renameSpace(id: string, name: string): Promise<SpaceRecord | undefined> {
  const current = await getSpace(id);
  if (!current) return undefined;
  return writeSpace({ ...current, name: name.trim() || null, namePending: true });
}

/** Take on the name another device published, dropping whatever this one called it. */
export async function adoptSpaceName(
  id: string,
  name: string | null,
  updatedAt: number,
): Promise<SpaceRecord | undefined> {
  const current = await getSpace(id);
  if (!current) return undefined;
  return writeSpace({ ...current, name, nameUpdatedAt: updatedAt, namePending: false });
}

/**
 * Record that the space accepted `name` at `updatedAt`.
 *
 * The debt is only cleared when the name that landed is still the one this
 * device holds: renaming again while the previous publish was in flight has to
 * leave the newer name owed, or it would never be sent.
 */
export async function markSpaceNamePublished(
  id: string,
  name: string | null,
  updatedAt: number,
): Promise<SpaceRecord | undefined> {
  const current = await getSpace(id);
  if (!current) return undefined;
  return writeSpace({
    ...current,
    nameUpdatedAt: updatedAt,
    namePending: current.name !== name,
  });
}

export async function removeSpace(id: string): Promise<void> {
  await (await registry()).delete("spaces", id);
}

/**
 * Re-encrypt every space name under `target`, reading through whatever key this
 * device currently holds. The registry half of `rewriteLocalContent`: turning a
 * lock on passes the new content key, turning it off passes null.
 */
export async function rewriteSpaceNames(target: KeyChoice): Promise<void> {
  const database = await registry();
  for (const stored of await database.getAll("spaces")) {
    const opened = await fromStored(stored);
    await database.put("spaces", await toStored(opened, target));
  }
}

/**
 * Adopt the space of a device set up before spaces were plural.
 *
 * Its data is already in the original database, which is the one
 * `LEGACY_SPACE_ID` maps to, so this only has to say that it exists. Called
 * with whatever proves there *is* something there — a session, or a vault
 * envelope that used to live in the space's own meta store.
 */
export async function registerLegacySpace(): Promise<SpaceRecord> {
  const existing = await getSpace(LEGACY_SPACE_ID);
  if (existing) return existing;
  return writeSpace({
    id: LEGACY_SPACE_ID,
    name: null,
    createdAt: Date.now(),
    nameUpdatedAt: 0,
    namePending: false,
  });
}
