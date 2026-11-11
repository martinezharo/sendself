import {
  type DBSchema,
  type IDBPDatabase,
  type IDBPTransaction,
  type StoreNames,
  deleteDB,
  openDB,
} from "idb";
import type { VaultItemRecord } from "@sendself/shared";
import type { LocalEvent, LocalMessage } from "../types";
import { PRE_REBRAND_ID } from "../legacy";
import { isQueuedOutgoing } from "./queue";
import {
  type Sealed,
  directoryContext,
  eventContext,
  fileContext,
  messageContext,
  openBlob,
  openJson,
  sealBlob,
  sealJson,
} from "./atrest";
import { LEGACY_SPACE_ID } from "./spaces";

/**
 * A message row. When an at-rest lock is set the payload is sealed and only the
 * key path and the sort index stay readable, so history can still be listed in
 * order without holding the key (see db/atrest.ts).
 */
type StoredMessage =
  | LocalMessage
  | { id: string; createdAt: number; sealed: Sealed; mime?: undefined };

/**
 * A space event row (device joined, revoked, key rotated). Sealed under a lock
 * exactly like a message: an event names a device, and a device name is the
 * user's own words about their hardware.
 */
type StoredEvent = LocalEvent | { id: string; createdAt: number; sealed: Sealed };

/**
 * The last name this device saw for another device.
 *
 * It exists because a revocation is observed *after* the fact: by the time the
 * roster no longer lists a device there is nothing left to decrypt its name
 * from, and "iPad was removed" is worth infinitely more than the device id.
 * Keeping it also means the chat can name a sender while offline.
 */
type StoredDeviceName = { deviceId: string; name: string } | { deviceId: string; sealed: Sealed };

/** A cached decrypted file. `iv` present = the blob holds ciphertext. */
interface StoredFile {
  r2Key: string;
  blob: Blob;
  iv?: string;
  /** Preserved separately: sealing a Blob loses its type. */
  mime?: string;
}

interface SendSelfDB extends DBSchema {
  /** Key-value store for session, crypto keys, sync cursor, pending pairing. */
  meta: { key: string; value: unknown };
  messages: {
    key: string;
    value: StoredMessage;
    indexes: { "by-createdAt": number };
  };
  /** Space events derived locally from the roster (state/events.ts). */
  events: {
    key: string;
    value: StoredEvent;
    indexes: { "by-createdAt": number };
  };
  /** deviceId → the name this device last saw for it. */
  directory: { key: string; value: StoredDeviceName };
  /** Decrypted file blobs cached locally for preview/offline access. */
  files: { key: string; value: StoredFile };
  /**
   * The space's vault as the server last described it (`VaultItemRecord`).
   * Kept as the server's own ciphertext: names and contents are sealed under
   * the GroupKey, which an at-rest lock already seals, so nothing here needs
   * sealing twice.
   */
  vault: { key: string; value: VaultItemRecord };
}

/**
 * One database per space.
 *
 * Spaces share nothing: separate sessions, separate keys, separate history —
 * so they get separate databases rather than a space column threaded through
 * every index. Leaving a space is then a `deleteDatabase`, which cannot leave a
 * stray row of someone else's history behind, and the space a device had
 * before spaces were plural keeps the original name (`LEGACY_SPACE_ID`) and is
 * adopted without migrating a byte.
 */
// IndexedDB names are persistent format identifiers. Renaming this would make
// existing devices appear empty even though their keys and history still exist.
const DB_NAME = PRE_REBRAND_ID;
/**
 * 2 added `events` and `directory`, 3 added `vault`. Bumping the version is
 * what gets them created on devices that already hold history; the upgrade
 * adds only what is missing, so it is the same code path for a fresh install
 * and an existing one.
 */
const DB_VERSION = 3;

function dbName(spaceId: string): string {
  return spaceId === LEGACY_SPACE_ID ? DB_NAME : `${DB_NAME}:${spaceId}`;
}

/**
 * Well-known `meta` keys. Shared between the page (state/session.ts) and the
 * service worker (sync/outbox.ts), which reads credentials straight from
 * IndexedDB because it has no access to the page's signals.
 */
export const META_SESSION = "session";
/** Pre-rotation single GroupKey. Read once, then folded into META_KEYRING. */
export const META_GROUP_KEY = "groupKey";
/** Every GroupKey epoch this device holds (crypto/keyring.ts). */
export const META_KEYRING = "keyring";
export const META_DEVICE_KEYPAIR = "deviceKeyPair";
/** This device's ECDSA signing identity (crypto/identity.ts). */
export const META_SIGNING_KEYPAIR = "signingKeyPair";
/** True once the signing public key reached the server (actions/spaces.ensureSigningIdentity). */
export const META_SIGNING_KEY_PUBLISHED = "signingKeyPublished";
/** Pre-signing pins: a plain deviceId → ECDH key map, folded into META_DEVICE_IDENTITIES. */
export const META_DEVICE_PINS = "devicePins";
/** What we believe about the other devices' keys, and why (crypto/identity.ts). */
export const META_DEVICE_IDENTITIES = "deviceIdentities";
/**
 * Where the at-rest vault envelope used to live, back when a device held one
 * space. A lock covers the device, so the envelope now lives in the registry
 * (db/spaces.ts, `GLOBAL_VAULT`); this key is only read to move it there.
 */
export const META_LEGACY_VAULT = "vault";
/** Key epoch the last recovery file was exported at, so a stale one can be flagged. */
export const META_RECOVERY_EPOCH = "recoveryExportEpoch";
/** Ids deleted for everyone, so a late copy is dropped instead of reappearing (db/deletions.ts). */
export const META_DELETED_MESSAGES = "deletedMessages";
/** Ids of outgoing messages still owed to the server (see `queuedMessages`). */
export const META_OUTBOX = "outbox";
/** The vault change the local copy is up to date with (`VaultChangesResponse.cursor`). */
export const META_VAULT_CURSOR = "vaultCursor";

/**
 * Which messages the outbox has to look at.
 *
 * Without it every flush pass — the page's, and the service worker's once per
 * space per file — read and decrypted the whole history to find the handful of
 * rows still queued. A real IndexedDB index cannot do the job: under an at-rest
 * lock a row's status is sealed, and only its id and timestamp are readable.
 *
 * The list may hold *extra* ids (a row that has since been sent or deleted):
 * reading it filters on the real status and drops them. It must never *miss*
 * one, so every write of an outgoing row updates it in the same transaction,
 * and `complete` is only set by a scan that could open every row. A device
 * whose history predates the index gets one such scan, then never again.
 */
interface OutboxIndex {
  complete: boolean;
  ids: string[];
}

const handles = new Map<string, Promise<IDBPDatabase<SendSelfDB>>>();

/**
 * The space the page is currently working in. Everything the UI, the sync loop
 * and the outbox do belongs to exactly one space, so it is set once when a
 * space is opened rather than passed through every call. The few operations
 * that genuinely span spaces — the service worker flushing every outbox, the
 * at-rest lock re-encrypting the device — name their space explicitly.
 */
let active: string | null = null;

export function setActiveSpace(spaceId: string | null): void {
  active = spaceId;
}

export function activeSpace(): string | null {
  return active;
}

function db(spaceId?: string): Promise<IDBPDatabase<SendSelfDB>> {
  const id = spaceId ?? active;
  if (!id) throw new Error("No space is open");
  let handle = handles.get(id);
  if (!handle) {
    handle = openDB<SendSelfDB>(dbName(id), DB_VERSION, {
      upgrade(database) {
        if (!database.objectStoreNames.contains("meta")) database.createObjectStore("meta");
        if (!database.objectStoreNames.contains("messages")) {
          const messages = database.createObjectStore("messages", { keyPath: "id" });
          messages.createIndex("by-createdAt", "createdAt");
        }
        if (!database.objectStoreNames.contains("events")) {
          const events = database.createObjectStore("events", { keyPath: "id" });
          events.createIndex("by-createdAt", "createdAt");
        }
        if (!database.objectStoreNames.contains("directory")) {
          database.createObjectStore("directory", { keyPath: "deviceId" });
        }
        if (!database.objectStoreNames.contains("files")) {
          database.createObjectStore("files", { keyPath: "r2Key" });
        }
        if (!database.objectStoreNames.contains("vault")) {
          database.createObjectStore("vault", { keyPath: "id" });
        }
      },
      // A newer build (another tab, or this one after an update) wants to
      // upgrade the schema, and an open connection here would hold it up until
      // this context closed. Step aside: the next access reopens at the new
      // version.
      blocking() {
        handles.delete(id);
        void handle?.then((database) => database.close());
      },
    });
    handles.set(id, handle);
  }
  return handle;
}

/**
 * Whether a space's database exists, where the browser can be asked cheaply.
 *
 * Firefox has no `indexedDB.databases()`, so the answer there is "maybe" —
 * `true`, which costs the caller a probe of an empty database rather than a
 * wrong answer.
 */
export async function spaceDataExists(spaceId: string): Promise<boolean> {
  const known = await indexedDB.databases?.().catch(() => undefined);
  if (!known) return true;
  return known.some((entry) => entry.name === dbName(spaceId));
}

// --- meta (CryptoKeys are structured-cloneable, so they live here directly) ---

export async function metaGet<T>(key: string, spaceId?: string): Promise<T | undefined> {
  return (await (await db(spaceId)).get("meta", key)) as T | undefined;
}

export async function metaSet(key: string, value: unknown, spaceId?: string): Promise<void> {
  await (await db(spaceId)).put("meta", value, key);
}

export async function metaDelete(key: string, spaceId?: string): Promise<void> {
  await (await db(spaceId)).delete("meta", key);
}

// --- messages ---

/** Encode a message for storage, sealing its payload when a lock is set. */
async function toStored(message: LocalMessage): Promise<StoredMessage> {
  const sealed = await sealJson(message, messageContext(message.id));
  if (!sealed) return message;
  return { id: message.id, createdAt: message.createdAt, sealed };
}

/** Decode a stored row. Undefined when it is sealed and this context is locked. */
async function fromStored(stored: StoredMessage | undefined): Promise<LocalMessage | undefined> {
  if (!stored) return undefined;
  if (!("sealed" in stored) || !stored.sealed) return stored as LocalMessage;
  return openJson<LocalMessage>(stored.sealed, messageContext(stored.id));
}

/** Any read-write transaction that includes `meta`, where the index lives. */
type OutboxTransaction = IDBPTransaction<SendSelfDB, StoreNames<SendSelfDB>[], "readwrite">;

/**
 * Bring the outbox index in line with `messages`, inside the transaction that
 * writes them, so another context can never observe the row without the index
 * entry. With no index yet the ids are still recorded (as incomplete): the scan
 * that will build it may already be running, and merges them in.
 */
async function trackOutbox(
  transaction: OutboxTransaction,
  messages: readonly LocalMessage[],
  { addOnly = false }: { addOnly?: boolean } = {},
): Promise<void> {
  const store = transaction.objectStore("meta");
  const current = (await store.get(META_OUTBOX)) as OutboxIndex | undefined;
  const ids = new Set(current?.ids);
  for (const message of messages) {
    if (isQueuedOutgoing(message)) ids.add(message.id);
    else if (!addOnly) ids.delete(message.id);
  }
  await store.put({ complete: current?.complete ?? false, ids: [...ids] }, META_OUTBOX);
}

/** Drop `ids` from the outbox index, if there is one. */
async function untrackOutbox(
  transaction: OutboxTransaction,
  ids: readonly string[],
): Promise<void> {
  const store = transaction.objectStore("meta");
  const current = (await store.get(META_OUTBOX)) as OutboxIndex | undefined;
  if (!current) return;
  const drop = new Set(ids);
  const kept = current.ids.filter((id) => !drop.has(id));
  if (kept.length !== current.ids.length) {
    await store.put({ complete: current.complete, ids: kept }, META_OUTBOX);
  }
}

export async function putMessage(message: LocalMessage, spaceId?: string): Promise<void> {
  // Resolved before sealing, which is async: leaving or switching spaces in the
  // meantime must not change which database this write lands in.
  const database = await db(spaceId);
  const stored = await toStored(message);
  // Incoming rows never enter the outbox, so they skip the index entirely:
  // they are the bulk of the writes on a receiving device.
  if (message.direction !== "out") {
    await database.put("messages", stored);
    return;
  }
  const transaction = database.transaction(["messages", "meta"], "readwrite");
  await Promise.all([
    transaction.objectStore("messages").put(stored),
    trackOutbox(transaction, [message]),
    transaction.done,
  ]);
}

/**
 * Persist a batch of outgoing file messages and their source blobs atomically.
 * A mobile suspension can therefore never leave half a selected batch queued,
 * or a message whose upload source was not committed yet.
 */
export async function putOutgoingFileMessages(
  entries: readonly { message: LocalMessage; blob: Blob }[],
  spaceId?: string,
): Promise<void> {
  if (entries.length === 0) return;
  // The destination is fixed before the awaits below: see `putMessage`.
  const database = await db(spaceId);
  // Sealing is async and IndexedDB transactions do not survive an await that
  // isn't a request, so everything is encrypted first and written after.
  const prepared = await Promise.all(
    entries.map(async ({ message, blob }) => ({
      stored: await toStored(message),
      file: await toStoredFile(message.file!.r2Key, blob),
    })),
  );
  const transaction = database.transaction(["messages", "files", "meta"], "readwrite");
  await Promise.all([
    ...prepared.map(({ stored }) => transaction.objectStore("messages").put(stored)),
    ...prepared.map(({ file }) => transaction.objectStore("files").put(file)),
    trackOutbox(
      transaction,
      entries.map(({ message }) => message),
    ),
    transaction.done,
  ]);
}

export async function getMessage(id: string, spaceId?: string): Promise<LocalMessage | undefined> {
  return fromStored(await (await db(spaceId)).get("messages", id));
}

/**
 * Every message, oldest first. While locked this is empty rather than an
 * error: the only caller that can run locked is the service worker's outbox
 * flush, which correctly does nothing without a session either.
 */
export async function allMessages(spaceId?: string): Promise<LocalMessage[]> {
  const rows = await (await db(spaceId)).getAllFromIndex("messages", "by-createdAt");
  const opened = await Promise.all(rows.map((row) => fromStored(row)));
  return opened.filter((message): message is LocalMessage => message !== undefined);
}

export async function deleteMessage(id: string, spaceId?: string): Promise<void> {
  const transaction = (await db(spaceId)).transaction(["messages", "meta"], "readwrite");
  await Promise.all([
    transaction.objectStore("messages").delete(id),
    untrackOutbox(transaction, [id]),
    transaction.done,
  ]);
}

const byCreatedAt = (a: LocalMessage, b: LocalMessage): number => a.createdAt - b.createdAt;

/**
 * Every outgoing message still owed to the server, oldest first — what the
 * outbox flushes, read without touching the rest of the history.
 *
 * Like `allMessages` this is empty for rows this context cannot open (a locked
 * service worker), and those ids are kept: they are still owed.
 */
export async function queuedMessages(spaceId?: string): Promise<LocalMessage[]> {
  const database = await db(spaceId);
  const index = (await database.get("meta", META_OUTBOX)) as OutboxIndex | undefined;
  if (!index?.complete) return rebuildOutboxIndex(database);

  const rows = await Promise.all(index.ids.map((id) => database.get("messages", id)));
  const queued: LocalMessage[] = [];
  /** Ids that look done, with the row as it was read (undefined: no row). */
  const stale = new Map<string, StoredMessage | undefined>();
  await Promise.all(
    rows.map(async (row, i) => {
      if (!row) {
        stale.set(index.ids[i]!, undefined);
        return;
      }
      const message = await fromStored(row);
      if (!message) return;
      if (isQueuedOutgoing(message)) queued.push(message);
      else stale.set(message.id, row);
    }),
  );
  if (stale.size > 0) await dropStale(database, stale);
  return queued.sort(byCreatedAt);
}

/**
 * Drop index entries that turned out to be done — but only those whose row is
 * still exactly what was read. Opening a sealed row is async, so the decision
 * is made outside this transaction; another context re-queueing the message in
 * between must win, or the index would lose an id that is owed again.
 */
async function dropStale(
  database: IDBPDatabase<SendSelfDB>,
  stale: ReadonlyMap<string, StoredMessage | undefined>,
): Promise<void> {
  const transaction = database.transaction(["messages", "meta"], "readwrite");
  const work = (async () => {
    const unchanged: string[] = [];
    for (const [id, seen] of stale) {
      const now = await transaction.objectStore("messages").get(id);
      if (JSON.stringify(now) === JSON.stringify(seen)) unchanged.push(id);
    }
    await untrackOutbox(transaction, unchanged);
  })();
  await Promise.all([work, transaction.done]);
}

/**
 * Make sure every queued message in `messages` is in the outbox index. Adding
 * is always safe, so this is the self-heal for a row written by something that
 * does not maintain the index (an older build still open in another tab, a
 * rollback). Called with the history the chat loads anyway, so it costs one
 * read of the index and, almost always, nothing else.
 */
export async function trackQueued(
  messages: readonly LocalMessage[],
  spaceId?: string,
): Promise<void> {
  const queued = messages.filter(isQueuedOutgoing);
  if (queued.length === 0) return;
  const database = await db(spaceId);
  const index = (await database.get("meta", META_OUTBOX)) as OutboxIndex | undefined;
  if (index && queued.every((message) => index.ids.includes(message.id))) return;
  const transaction = database.transaction(["messages", "meta"], "readwrite");
  await Promise.all([trackOutbox(transaction, queued, { addOnly: true }), transaction.done]);
}

/**
 * Build the outbox index from one full scan. Only a scan that could open every
 * row may call the index complete; a locked context records what it found and
 * leaves the full scan to the next one that can.
 */
async function rebuildOutboxIndex(database: IDBPDatabase<SendSelfDB>): Promise<LocalMessage[]> {
  const rows = await database.getAllFromIndex("messages", "by-createdAt");
  const opened = await Promise.all(rows.map((row) => fromStored(row)));
  const complete = opened.every((message) => message !== undefined);
  const queued = opened.filter(
    (message): message is LocalMessage => message !== undefined && isQueuedOutgoing(message),
  );

  const transaction = database.transaction(["messages", "meta"], "readwrite");
  const store = transaction.objectStore("meta");
  const write = (async () => {
    // Merge rather than overwrite: anything queued while the scan ran was
    // recorded by `trackOutbox` and is not in `queued`.
    const current = (await store.get(META_OUTBOX)) as OutboxIndex | undefined;
    const ids = new Set([...(current?.ids ?? []), ...queued.map((message) => message.id)]);
    await store.put({ complete: complete || !!current?.complete, ids: [...ids] }, META_OUTBOX);
  })();
  await Promise.all([write, transaction.done]);
  return queued;
}

/** Rows deleted per transaction while pruning, so a big cleanup never holds one open for long. */
const PRUNE_BATCH = 200;

/**
 * Delete this device's copy of everything older than `cutoff`: messages, their
 * cached files and the space notices around them.
 *
 * Outgoing messages that have not been delivered are kept whatever their age:
 * deleting one would silently cancel a send, and a `failed` one is still
 * waiting for the user to decide. A row this context cannot open is kept too.
 * Returns how many messages were removed.
 */
export async function pruneHistory(cutoff: number, spaceId?: string): Promise<number> {
  const database = await db(spaceId);
  const range = IDBKeyRange.upperBound(cutoff, true);

  const rows = await database.getAllFromIndex("messages", "by-createdAt", range);
  const doomed: LocalMessage[] = [];
  for (const row of rows) {
    const message = await fromStored(row);
    if (!message) continue;
    if (message.direction === "out" && message.status !== "sent") continue;
    doomed.push(message);
  }

  for (let start = 0; start < doomed.length; start += PRUNE_BATCH) {
    const batch = doomed.slice(start, start + PRUNE_BATCH);
    const transaction = database.transaction(["messages", "files", "meta"], "readwrite");
    await Promise.all([
      ...batch.map((message) => transaction.objectStore("messages").delete(message.id)),
      ...batch.flatMap((message) =>
        message.file ? [transaction.objectStore("files").delete(message.file.r2Key)] : [],
      ),
      untrackOutbox(
        transaction,
        batch.map((message) => message.id),
      ),
      transaction.done,
    ]);
  }

  const events = await database.getAllKeysFromIndex("events", "by-createdAt", range);
  for (let start = 0; start < events.length; start += PRUNE_BATCH) {
    const transaction = database.transaction("events", "readwrite");
    await Promise.all([
      ...events
        .slice(start, start + PRUNE_BATCH)
        .map((key) => transaction.objectStore("events").delete(key)),
      transaction.done,
    ]);
  }

  return doomed.length;
}

// --- events ---

/**
 * Write an event, keeping the first observation. True when this call is the one
 * that wrote it.
 *
 * Ids are deterministic, so the same change seen twice (two tabs, three call
 * sites reading the same roster) is one row — and the timestamp that survives
 * is the earliest, which is when this device actually learned of it.
 *
 * `add` rather than a read followed by a write: the two roster readers can be
 * in flight at the same moment, and a check that has to await its answer lets
 * both of them conclude they are first. The store's own uniqueness constraint
 * cannot be raced, so exactly one caller is told it wrote the row — which is
 * what keeps the notice out of the thread twice.
 */
export async function putEvent(event: LocalEvent, spaceId?: string): Promise<boolean> {
  const sealed = await sealJson(event, eventContext(event.id));
  try {
    await (await db(spaceId)).add(
      "events",
      sealed ? { id: event.id, createdAt: event.createdAt, sealed } : event,
    );
    return true;
  } catch (error) {
    if (error instanceof DOMException && error.name === "ConstraintError") return false;
    throw error;
  }
}

/** Every event, oldest first. Empty while locked, like `allMessages`. */
export async function allEvents(spaceId?: string): Promise<LocalEvent[]> {
  const rows = await (await db(spaceId)).getAllFromIndex("events", "by-createdAt");
  const opened = await Promise.all(
    rows.map((row) =>
      "sealed" in row && row.sealed
        ? openJson<LocalEvent>(row.sealed, eventContext(row.id))
        : Promise.resolve(row as LocalEvent),
    ),
  );
  return opened.filter((event): event is LocalEvent => event !== undefined);
}

// --- device directory ---

export async function putDeviceName(
  deviceId: string,
  name: string,
  spaceId?: string,
): Promise<void> {
  const sealed = await sealJson(name, directoryContext(deviceId));
  await (await db(spaceId)).put("directory", sealed ? { deviceId, sealed } : { deviceId, name });
}

export async function deviceNames(spaceId?: string): Promise<Map<string, string>> {
  const rows = await (await db(spaceId)).getAll("directory");
  const entries = await Promise.all(
    rows.map(
      async (row): Promise<[string, string | undefined]> => [
        row.deviceId,
        "sealed" in row
          ? await openJson<string>(row.sealed, directoryContext(row.deviceId))
          : row.name,
      ],
    ),
  );
  return new Map(entries.filter((entry): entry is [string, string] => entry[1] !== undefined));
}

// --- files ---

async function toStoredFile(r2Key: string, blob: Blob): Promise<StoredFile> {
  const sealed = await sealBlob(blob, fileContext(r2Key));
  if (!sealed) return { r2Key, blob };
  return { r2Key, blob: new Blob([sealed.ct]), iv: sealed.iv, mime: blob.type };
}

export async function putFile(r2Key: string, blob: Blob, spaceId?: string): Promise<void> {
  await (await db(spaceId)).put("files", await toStoredFile(r2Key, blob));
}

export async function getFile(r2Key: string, spaceId?: string): Promise<Blob | undefined> {
  const stored = await (await db(spaceId)).get("files", r2Key);
  if (!stored) return undefined;
  if (!stored.iv) return stored.blob;
  return openBlob(stored.blob, stored.iv, fileContext(r2Key), stored.mime ?? "");
}

export async function deleteFile(r2Key: string, spaceId?: string): Promise<void> {
  await (await db(spaceId)).delete("files", r2Key);
}

// --- vault ---

/** The local copy of the vault and the cursor it is current to. */
export async function loadVaultRecords(
  spaceId?: string,
): Promise<{ records: VaultItemRecord[]; cursor: number }> {
  const database = await db(spaceId);
  const [records, cursor] = await Promise.all([
    database.getAll("vault"),
    database.get("meta", META_VAULT_CURSOR) as Promise<number | undefined>,
  ]);
  return { records, cursor: cursor ?? 0 };
}

/**
 * Apply a batch of vault changes and move the cursor, in one transaction: a
 * copy whose cursor moved past changes it never stored would never ask for
 * them again. `reset` clears the copy first.
 */
export async function storeVaultChanges(
  changes: {
    items: readonly VaultItemRecord[];
    removed: readonly string[];
    reset?: boolean;
    cursor?: number;
  },
  spaceId?: string,
): Promise<void> {
  const database = await db(spaceId);
  const transaction = database.transaction(["vault", "meta"], "readwrite");
  const store = transaction.objectStore("vault");
  const writes: Promise<unknown>[] = [];
  if (changes.reset) writes.push(store.clear());
  for (const id of changes.removed) writes.push(store.delete(id));
  for (const item of changes.items) {
    // Only ever newer: a slow write response must not replace a later change
    // a sync already stored.
    writes.push(
      store.get(item.id).then((known) => {
        if (!known || known.seq < item.seq) return store.put(item);
      }),
    );
  }
  if (changes.cursor !== undefined) {
    writes.push(transaction.objectStore("meta").put(changes.cursor, META_VAULT_CURSOR));
  }
  await Promise.all([...writes, transaction.done]);
}

/** Where a vault blob's opened content is cached in `files`, apart from message attachments. */
export function vaultFileKey(blobKey: string): string {
  return `vault:${blobKey}`;
}

/**
 * Re-encrypt every message and file under `target`, reading through whatever
 * key this context currently holds.
 *
 * This is the whole migration between "no lock" and "locked": turning a lock on
 * passes the new content key, turning it off passes null. Rows are rewritten
 * one at a time rather than collected first — a history with a few 50 MB
 * attachments would not survive being held in memory all at once.
 *
 * A row that cannot be opened is left untouched. That cannot happen from either
 * caller (both run with the previous state readable), and skipping beats
 * replacing content with something unreadable.
 */
export async function rewriteLocalContent(
  target: CryptoKey | null,
  spaceId?: string,
): Promise<void> {
  const database = await db(spaceId);

  for (const key of await database.getAllKeys("messages")) {
    const message = await fromStored(await database.get("messages", key));
    if (!message) continue;
    const sealed = await sealJson(message, messageContext(message.id), target);
    // This rewrite can race a flush that just sent the message, and put back
    // the copy it read. Keeping the index in step (add-only) means the worst
    // case is a resend the server answers with `conflict` — never a message
    // left showing "uploading" with nothing ever picking it up.
    const transaction = database.transaction(["messages", "meta"], "readwrite");
    await Promise.all([
      transaction
        .objectStore("messages")
        .put(sealed ? { id: message.id, createdAt: message.createdAt, sealed } : message),
      trackOutbox(transaction, [message], { addOnly: true }),
      transaction.done,
    ]);
  }

  for (const key of await database.getAllKeys("events")) {
    const row = await database.get("events", key);
    if (!row) continue;
    const event =
      "sealed" in row && row.sealed
        ? await openJson<LocalEvent>(row.sealed, eventContext(row.id))
        : (row as LocalEvent);
    if (!event) continue;
    const sealed = await sealJson(event, eventContext(event.id), target);
    await database.put(
      "events",
      sealed ? { id: event.id, createdAt: event.createdAt, sealed } : event,
    );
  }

  for (const key of await database.getAllKeys("directory")) {
    const row = await database.get("directory", key);
    if (!row) continue;
    const name =
      "sealed" in row
        ? await openJson<string>(row.sealed, directoryContext(row.deviceId))
        : row.name;
    if (name === undefined) continue;
    const sealed = await sealJson(name, directoryContext(row.deviceId), target);
    await database.put(
      "directory",
      sealed ? { deviceId: row.deviceId, sealed } : { deviceId: row.deviceId, name },
    );
  }

  for (const key of await database.getAllKeys("files")) {
    const stored = await database.get("files", key);
    if (!stored) continue;
    const blob = stored.iv
      ? await openBlob(stored.blob, stored.iv, fileContext(stored.r2Key), stored.mime ?? "")
      : stored.blob;
    if (!blob) continue;
    const sealed = await sealBlob(blob, fileContext(stored.r2Key), target);
    await database.put(
      "files",
      sealed
        ? { r2Key: stored.r2Key, blob: new Blob([sealed.ct]), iv: sealed.iv, mime: blob.type }
        : { r2Key: stored.r2Key, blob },
    );
  }
}

/**
 * Wipe a space from this device: session, keys, history and cached files.
 *
 * The whole database goes rather than its stores being cleared, because a
 * space's storage is only ever recreated by joining it again — and a dropped
 * database cannot leave behind a row nobody remembers writing.
 */
export async function deleteSpaceData(spaceId: string): Promise<void> {
  const handle = handles.get(spaceId);
  handles.delete(spaceId);
  if (handle) (await handle).close();
  if (active === spaceId) active = null;
  await deleteDB(dbName(spaceId));
}
