import {
  type CreateVaultItemRequest,
  type DeleteVaultItemResponse,
  type UpdateVaultItemRequest,
  VAULT_BYTES_QUOTA,
  VAULT_ITEM_KINDS,
  VAULT_MAX_ITEMS,
  VAULT_PAGE_SIZE,
  VAULT_RESEAL_BATCH,
  type VaultChangesResponse,
  type VaultItemKind,
  type VaultItemRecord,
  type VaultItemWriteResponse,
  type VaultResealRequest,
  type VaultResealResponse,
} from "@sendself/shared";
import { type AuthContext, authenticate } from "../auth";
import { RESERVED_FOR_DELETION, VAULT_BLOBS, blobSize, deleteBlob } from "../blobs";
import { ApiError, json } from "../errors";
import { readJsonObject, requireId, requireInt, requireString } from "../http";
import { notifySpace } from "../realtime";
import type { RouteContext } from "../router";
import { rateLimit } from "../security";
import { VAULT_ITEM_COLUMNS, VAULT_SEQ, nextVaultSeq, purgeVaultItem, vaultItem } from "../vault";
import { receiveBlob, sendBlob } from "./files";

/** Sealed metadata cap: a name, a content key, an IV and a short excerpt. */
const MAX_META = 8192;
const MAX_IV = 64;

/**
 * Who may use the vault: every active device, send-only ones included. The
 * send-only flag keeps a device out of message delivery; it was never a
 * permission, and a script saving a file into a folder is exactly what the
 * CLI is for.
 */
async function vaultAuth(c: RouteContext, write: boolean): Promise<AuthContext> {
  const auth = await authenticate(c.request, c.env);
  if (write) await rateLimit(c.env, "RL_WRITE", auth.deviceId);
  return auth;
}

/** Tell the space's other devices to sync. Never a push: nothing arrived for them to read. */
function announce(c: RouteContext, auth: AuthContext): void {
  c.ctx.waitUntil(notifySpace(c.env, auth.groupId, auth.deviceId));
}

function requireKind(value: unknown): VaultItemKind {
  if (typeof value !== "string" || !VAULT_ITEM_KINDS.includes(value as VaultItemKind)) {
    throw new ApiError("bad_request", "Missing or invalid field: kind");
  }
  return value as VaultItemKind;
}

function parentIdOf(value: unknown): string | null {
  return value === null || value === undefined ? null : requireId(value, "parentId");
}

/** Same rule as a message: sealed under anything but the current key is refused. */
function requireCurrentEpoch(auth: AuthContext, value: unknown): number {
  const epoch = requireInt(value, "keyEpoch", 1, Number.MAX_SAFE_INTEGER);
  if (epoch !== auth.groupKeyEpoch) {
    throw new ApiError("key_rotated", "The space key has rotated; seal it with the new key");
  }
  return epoch;
}

/** A folder of this space that can take children, or a precise error. */
async function requireFolder(c: RouteContext, groupId: string, id: string): Promise<void> {
  const parent = await vaultItem(c.env, groupId, id);
  if (!parent || parent.kind !== "folder") {
    throw new ApiError("not_found", "That folder no longer exists");
  }
}

/** The size of an uploaded blob nothing else claims yet, or a precise error. */
async function requireFreeBlob(c: RouteContext, groupId: string, key: string): Promise<number> {
  const size = await blobSize(c.env, VAULT_BLOBS, groupId, key);
  if (size === null) {
    throw new ApiError("bad_request", "Referenced content has not been uploaded");
  }
  const owner = await c.env.DB.prepare(
    "SELECT 1 FROM vault_items WHERE group_id = ? AND blob_key = ? AND removed_at IS NULL",
  )
    .bind(groupId, key)
    .first();
  if (owner) throw new ApiError("conflict", "That content already belongs to another item");
  return size;
}

/**
 * SQL true while `?` (a blob key) can still be claimed: no live item owns it,
 * and the cleanup has not reserved it for deletion (see `RESERVED_FOR_DELETION`).
 * Binds group id, key, group id, key.
 */
const BLOB_CLAIMABLE = `NOT EXISTS (
  SELECT 1 FROM vault_items WHERE group_id = ? AND blob_key = ? AND removed_at IS NULL
) AND EXISTS (
  SELECT 1 FROM vault_blobs
   WHERE group_id = ? AND r2_key = ? AND created_at != ${RESERVED_FOR_DELETION}
)`;

/** SQL true while `?` (an item id) is a live folder; binds group id, id. */
const LIVE_FOLDER = `EXISTS (
  SELECT 1 FROM vault_items
   WHERE group_id = ? AND id = ? AND kind = 'folder' AND removed_at IS NULL
)`;

/**
 * The row a write produced, as its own statement returned it. Read in the same
 * statement rather than afterwards: by then another device's edit may have
 * landed, and its revision would be handed back as if it were this one's.
 */
function writtenItem(result: D1Result | undefined): Response {
  const item = result?.results?.[0] as VaultItemRecord | undefined;
  if (!item) throw new ApiError("conflict", "The item changed while saving; try again");
  return json({ ok: true, item } satisfies VaultItemWriteResponse);
}

/**
 * `GET /api/vault?since=<cursor>`: every change after `since`, in order.
 *
 * A device keeps the cursor of the last answer and asks only for what is
 * newer, so browsing a large vault costs one full read on the first visit and
 * almost nothing after. Purged items come back as ids to drop.
 */
export async function vaultChanges(c: RouteContext): Promise<Response> {
  const auth = await vaultAuth(c, false);
  const requested = Number(c.url.searchParams.get("since") ?? "0");
  if (!Number.isSafeInteger(requested) || requested < 0) {
    throw new ApiError("bad_request", "Invalid 'since' cursor");
  }
  // A later page of a listing that started from 0 is complete whatever the
  // floor says: anything purged while it is being read leaves a fresh
  // tombstone, newer than every forgotten one.
  const continuing = c.url.searchParams.get("full") === "1";

  // One transaction, so the counter, the floor, the rows and the usage all
  // describe the same moment: the cursor can never skip a change committed in
  // between, and no tombstone can be forgotten between deciding the cursor is
  // still good and reading what came after it.
  const read = (since: number) =>
    c.env.DB.batch([
      c.env.DB.prepare(
        "SELECT vault_seq AS seq, vault_floor AS floor FROM groups WHERE id = ?",
      ).bind(auth.groupId),
      c.env.DB.prepare(
        `SELECT ${VAULT_ITEM_COLUMNS}, removed_at AS removedAt
           FROM vault_items
          WHERE group_id = ? AND seq > ?
          ORDER BY seq ASC
          LIMIT ?`,
      ).bind(auth.groupId, since, VAULT_PAGE_SIZE + 1),
      c.env.DB.prepare(
        "SELECT COUNT(*) AS count FROM vault_items WHERE group_id = ? AND removed_at IS NULL",
      ).bind(auth.groupId),
      c.env.DB.prepare(
        "SELECT COALESCE(SUM(size), 0) AS bytes FROM vault_blobs WHERE group_id = ?",
      ).bind(auth.groupId),
    ]);

  let since = requested;
  let [group, rows, items, bytes] = await read(since);
  const floor = (group?.results[0] as { floor: number } | undefined)?.floor ?? 0;
  // A cursor older than the newest forgotten tombstone may hold items purged
  // since, and nobody can say which: start the listing over from the
  // beginning. That second read needs no floor of its own: a listing from 0
  // is complete whatever was forgotten meanwhile.
  const reset = !continuing && requested > 0 && requested < floor;
  if (reset) {
    since = 0;
    [group, rows, items, bytes] = await read(since);
  }

  const counter = (group?.results[0] as { seq: number } | undefined) ?? { seq: 0 };
  const changed = (rows?.results ?? []) as Array<VaultItemRecord & { removedAt: number | null }>;
  const itemCount = (items?.results[0] as { count: number } | undefined)?.count ?? 0;
  const byteCount = (bytes?.results[0] as { bytes: number } | undefined)?.bytes ?? 0;
  const more = changed.length > VAULT_PAGE_SIZE;
  const page = more ? changed.slice(0, VAULT_PAGE_SIZE) : changed;

  return json({
    items: page.filter((row) => row.removedAt === null).map(({ removedAt: _, ...item }) => item),
    removed: page.filter((row) => row.removedAt !== null).map((row) => row.id),
    cursor: more ? (page[page.length - 1]?.seq ?? since) : Math.max(counter.seq, since),
    more,
    reset,
    usage: { bytes: byteCount, items: itemCount },
  } satisfies VaultChangesResponse);
}

/** `POST /api/vault/items`: a new folder, note or file. */
export async function createVaultItem(c: RouteContext): Promise<Response> {
  const auth = await vaultAuth(c, true);
  const body = await readJsonObject<CreateVaultItemRequest>(c.request);

  const id = requireId(body.id, "id");
  const kind = requireKind(body.kind);
  const parentId = parentIdOf(body.parentId);
  const keyEpoch = requireCurrentEpoch(auth, body.keyEpoch);
  const meta = requireString(body.meta, "meta", MAX_META);
  const metaIv = requireString(body.metaIv, "metaIv", MAX_IV);
  const blobKey = kind === "folder" ? null : requireId(body.blobKey, "blobKey");
  if (kind === "folder" && body.blobKey !== undefined) {
    throw new ApiError("bad_request", "A folder has no content");
  }

  // Checked first for a precise error; every one of them is checked again in
  // the write itself, which is what actually holds against a concurrent one.
  const existing = await vaultItem(c.env, auth.groupId, id);
  if (existing) {
    // The id is the client's own and random: the same id with the same sealed
    // metadata is this very request again, retried after its answer was lost.
    // Answer it as it was answered then rather than fail a save that happened.
    if (existing.meta === meta && existing.metaIv === metaIv && existing.kind === kind) {
      return json({ ok: true, item: existing } satisfies VaultItemWriteResponse);
    }
    throw new ApiError("conflict", "An item with this id already exists");
  }
  if (parentId) await requireFolder(c, auth.groupId, parentId);
  const size = blobKey ? await requireFreeBlob(c, auth.groupId, blobKey) : 0;

  const now = Date.now();
  const [, insert] = await c.env.DB.batch([
    nextVaultSeq(c.env, auth.groupId),
    c.env.DB.prepare(
      `INSERT INTO vault_items
         (group_id, id, parent_id, kind, key_epoch, meta, meta_iv, blob_key, blob_size,
          revision, seq, created_at, updated_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ${VAULT_SEQ}, ?, ?
        WHERE (SELECT COUNT(*) FROM vault_items
                WHERE group_id = ? AND removed_at IS NULL) < ?
          AND (? IS NULL OR ${LIVE_FOLDER})
          AND (? IS NULL OR (${BLOB_CLAIMABLE}))
          AND NOT EXISTS (SELECT 1 FROM vault_items WHERE group_id = ? AND id = ?)
       RETURNING ${VAULT_ITEM_COLUMNS}`,
    ).bind(
      auth.groupId,
      id,
      parentId,
      kind,
      keyEpoch,
      meta,
      metaIv,
      blobKey,
      size,
      auth.groupId,
      now,
      now,
      auth.groupId,
      VAULT_MAX_ITEMS,
      parentId,
      auth.groupId,
      parentId,
      blobKey,
      auth.groupId,
      blobKey,
      auth.groupId,
      blobKey,
      auth.groupId,
      id,
    ),
  ]);

  if (insert?.meta.changes !== 1) {
    const count = await c.env.DB.prepare(
      "SELECT COUNT(*) AS count FROM vault_items WHERE group_id = ? AND removed_at IS NULL",
    )
      .bind(auth.groupId)
      .first<{ count: number }>();
    if ((count?.count ?? 0) >= VAULT_MAX_ITEMS) {
      throw new ApiError(
        "quota_exceeded",
        `The vault holds the most items it can (${VAULT_MAX_ITEMS.toLocaleString("en")})`,
      );
    }
    throw new ApiError("conflict", "The vault changed while saving; try again");
  }

  announce(c, auth);
  return writtenItem(insert);
}

/**
 * `PATCH /api/vault/items/:id`: rename, edit, move, trash or restore.
 *
 * Every edit names the revision it was made against, and the write only lands
 * if that is still the item's revision. Two devices editing one note therefore
 * never silently overwrite each other: the second is told `conflict` and keeps
 * its version as a copy instead.
 */
export async function updateVaultItem(c: RouteContext): Promise<Response> {
  const auth = await vaultAuth(c, true);
  const id = requireId(c.params.id, "id");
  const body = await readJsonObject<UpdateVaultItemRequest>(c.request);
  const revision = requireInt(body.revision, "revision", 1, Number.MAX_SAFE_INTEGER);

  const item = await vaultItem(c.env, auth.groupId, id);
  if (!item) throw new ApiError("not_found", "That item no longer exists");
  if (item.revision !== revision) {
    throw new ApiError("conflict", "The item was changed on another device");
  }

  const sets: string[] = [];
  const binds: unknown[] = [];
  const guards: string[] = [];
  const guardBinds: unknown[] = [];

  const moving = "parentId" in body;
  const parentId = moving ? parentIdOf(body.parentId) : item.parentId;
  if (moving && parentId !== item.parentId) {
    if (parentId) {
      if (parentId === id) throw new ApiError("bad_request", "A folder cannot hold itself");
      await requireFolder(c, auth.groupId, parentId);
      // The new parent must not sit inside the item being moved, or the move
      // would cut a branch off the tree. Checked in the write, not before it:
      // two moves racing each other would otherwise both pass.
      guards.push(
        LIVE_FOLDER,
        `? NOT IN (
           WITH RECURSIVE tree(id) AS (
             SELECT ?
             UNION
             SELECT v.id FROM vault_items v JOIN tree ON v.parent_id = tree.id
              WHERE v.group_id = ?
           )
           SELECT id FROM tree
         )`,
      );
      guardBinds.push(auth.groupId, parentId, parentId, id, auth.groupId);
    }
    sets.push("parent_id = ?");
    binds.push(parentId);
  }

  const sealing = body.meta !== undefined || body.metaIv !== undefined;
  if (sealing || body.keyEpoch !== undefined) {
    const keyEpoch = requireCurrentEpoch(auth, body.keyEpoch);
    const meta = requireString(body.meta, "meta", MAX_META);
    const metaIv = requireString(body.metaIv, "metaIv", MAX_IV);
    sets.push("key_epoch = ?", "meta = ?", "meta_iv = ?");
    binds.push(keyEpoch, meta, metaIv);
  }

  let replacedBlob: string | null = null;
  if (body.blobKey !== undefined) {
    if (item.kind === "folder") throw new ApiError("bad_request", "A folder has no content");
    // The key to new content is in the metadata, so one never changes without the other.
    if (!sealing) throw new ApiError("bad_request", "New content needs its metadata");
    const blobKey = requireId(body.blobKey, "blobKey");
    if (blobKey !== item.blobKey) {
      const size = await requireFreeBlob(c, auth.groupId, blobKey);
      sets.push("blob_key = ?", "blob_size = ?");
      binds.push(blobKey, size);
      guards.push(`(${BLOB_CLAIMABLE})`);
      guardBinds.push(auth.groupId, blobKey, auth.groupId, blobKey);
      replacedBlob = item.blobKey;
    }
  }

  if (body.trashed !== undefined) {
    if (typeof body.trashed !== "boolean") {
      throw new ApiError("bad_request", "Missing or invalid field: trashed");
    }
    sets.push("trashed_at = ?");
    binds.push(body.trashed ? (item.trashedAt ?? Date.now()) : null);
  }

  if (sets.length === 0) return json({ ok: true, item } satisfies VaultItemWriteResponse);

  const now = Date.now();
  const [, update] = await c.env.DB.batch([
    nextVaultSeq(c.env, auth.groupId),
    c.env.DB.prepare(
      `UPDATE vault_items
          SET ${sets.join(", ")}, revision = revision + 1, updated_at = ?, seq = ${VAULT_SEQ}
        WHERE group_id = ? AND id = ? AND revision = ? AND removed_at IS NULL
          ${guards.map((guard) => `AND ${guard}`).join("\n")}
       RETURNING ${VAULT_ITEM_COLUMNS}`,
    ).bind(...binds, now, auth.groupId, auth.groupId, id, revision, ...guardBinds),
  ]);
  if (update?.meta.changes !== 1) {
    throw new ApiError("conflict", "The item was changed on another device");
  }

  // The superseded content is nobody's any more. If this delete fails, the
  // orphan sweep finds it: no live item claims it.
  if (replacedBlob) {
    await deleteBlob(c.env, VAULT_BLOBS, auth.groupId, replacedBlob).catch(() => {});
  }

  announce(c, auth);
  return writtenItem(update);
}

/**
 * `POST /api/vault/reseal`: metadata sealed again under the current key after
 * a rotation, by a device that could still read it. An item edited since the
 * device read it is skipped: the edit is already sealed under the current key.
 */
export async function resealVaultItems(c: RouteContext): Promise<Response> {
  const auth = await vaultAuth(c, true);
  const body = await readJsonObject<VaultResealRequest>(c.request);
  const keyEpoch = requireCurrentEpoch(auth, body.keyEpoch);
  if (!Array.isArray(body.items) || body.items.length > VAULT_RESEAL_BATCH) {
    throw new ApiError("bad_request", `Send between 0 and ${VAULT_RESEAL_BATCH} items`);
  }
  const items = body.items.map((item) => ({
    id: requireId(item?.id, "items[].id"),
    revision: requireInt(item?.revision, "items[].revision", 1, Number.MAX_SAFE_INTEGER),
    meta: requireString(item?.meta, "items[].meta", MAX_META),
    metaIv: requireString(item?.metaIv, "items[].metaIv", MAX_IV),
  }));
  if (items.length === 0) return json({ ok: true, resealed: 0 } satisfies VaultResealResponse);

  const now = Date.now();
  const results = await c.env.DB.batch(
    items.flatMap((item) => [
      nextVaultSeq(c.env, auth.groupId),
      c.env.DB.prepare(
        `UPDATE vault_items
            SET key_epoch = ?, meta = ?, meta_iv = ?, updated_at = ?, seq = ${VAULT_SEQ}
          WHERE group_id = ? AND id = ? AND revision = ? AND key_epoch < ?
            AND removed_at IS NULL`,
      ).bind(
        keyEpoch,
        item.meta,
        item.metaIv,
        now,
        auth.groupId,
        auth.groupId,
        item.id,
        item.revision,
        keyEpoch,
      ),
    ]),
  );
  const resealed = results.filter(
    (result, index) => index % 2 === 1 && result.meta.changes > 0,
  ).length;

  if (resealed > 0) announce(c, auth);
  return json({ ok: true, resealed } satisfies VaultResealResponse);
}

/** `DELETE /api/vault/items/:id`: purge for good, with everything in it. */
export async function deleteVaultItem(c: RouteContext): Promise<Response> {
  const auth = await vaultAuth(c, true);
  const id = requireId(c.params.id, "id");
  if (!(await vaultItem(c.env, auth.groupId, id))) {
    throw new ApiError("not_found", "That item no longer exists");
  }
  const removed = await purgeVaultItem(c.env, auth.groupId, id);
  announce(c, auth);
  return json({ ok: true, removed } satisfies DeleteVaultItemResponse);
}

/** `PUT /api/vault/blobs/:r2key`: a note's or file's sealed content, before its item. */
export async function uploadVaultBlob(c: RouteContext): Promise<Response> {
  return receiveBlob(c, VAULT_BLOBS, {
    bytes: VAULT_BYTES_QUOTA,
    message: "The vault is full. Delete something or empty the trash to make room",
  });
}

/** `GET /api/vault/blobs/:r2key`. */
export function downloadVaultBlob(c: RouteContext): Promise<Response> {
  return sendBlob(c, VAULT_BLOBS);
}
