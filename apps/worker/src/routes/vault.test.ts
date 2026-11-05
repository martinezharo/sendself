import { SELF, env } from "cloudflare:test";
import {
  type CreateVaultItemRequest,
  type DeleteVaultItemResponse,
  type PendingMessagesResponse,
  type UpdateVaultItemRequest,
  VAULT_TOMBSTONE_TTL_MS,
  VAULT_TRASH_TTL_MS,
  type VaultChangesResponse,
  type VaultItemRecord,
  type VaultItemWriteResponse,
  type VaultResealRequest,
} from "@sendself/shared";
import { describe, expect, it } from "vitest";
import { VAULT_BLOBS, blobStorageKey } from "../blobs";
import { runCleanup } from "../cron";
import type { SeededDevice } from "../test/helpers";
import { authHeader, errorCode, seedDevice, seedSpace, uid } from "../test/helpers";

const BASE = "https://x.dev/api/vault";

function call(device: SeededDevice, path: string, init: RequestInit = {}): Promise<Response> {
  return SELF.fetch(`${BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...authHeader(device), ...init.headers },
  });
}

async function changes(device: SeededDevice, since = 0): Promise<VaultChangesResponse> {
  const response = await call(device, `?since=${since}`);
  expect(response.status).toBe(200);
  return (await response.json()) as VaultChangesResponse;
}

function create(device: SeededDevice, body: Partial<CreateVaultItemRequest>): Promise<Response> {
  return call(device, "/items", {
    method: "POST",
    body: JSON.stringify({ keyEpoch: 1, meta: "sealed", metaIv: "iv", parentId: null, ...body }),
  });
}

async function created(
  device: SeededDevice,
  body: Partial<CreateVaultItemRequest>,
): Promise<VaultItemRecord> {
  const response = await create(device, body);
  expect(response.status).toBe(200);
  return ((await response.json()) as VaultItemWriteResponse).item;
}

async function folder(device: SeededDevice, parentId: string | null = null): Promise<string> {
  return (await created(device, { id: uid("folder"), kind: "folder", parentId })).id;
}

function update(
  device: SeededDevice,
  id: string,
  body: Partial<UpdateVaultItemRequest>,
): Promise<Response> {
  return call(device, `/items/${id}`, { method: "PATCH", body: JSON.stringify(body) });
}

async function uploadBlob(device: SeededDevice, key: string, body = "ciphertext"): Promise<void> {
  const response = await SELF.fetch(`${BASE}/blobs/${key}`, {
    method: "PUT",
    headers: authHeader(device),
    body,
  });
  expect(response.status).toBe(200);
}

async function note(
  device: SeededDevice,
  parentId: string | null = null,
): Promise<VaultItemRecord> {
  const blobKey = uid("blob");
  await uploadBlob(device, blobKey);
  return created(device, { id: uid("note"), kind: "note", parentId, blobKey });
}

describe("POST /api/vault/items", () => {
  it("creates a folder and lists it to every device in the space", async () => {
    const { groupId, owner } = await seedSpace();
    const other = await seedDevice(groupId);

    const id = await folder(owner);

    const listing = await changes(other);
    expect(listing.items.map((item) => item.id)).toEqual([id]);
    expect(listing.items[0]).toMatchObject({ kind: "folder", parentId: null, revision: 1 });
    expect(listing.usage).toEqual({ bytes: 0, items: 1 });
  });

  it("charges a note's blob to the vault and records its size", async () => {
    const { owner } = await seedSpace();

    const item = await note(owner);

    expect(item.blobSize).toBe("ciphertext".length);
    expect((await changes(owner)).usage.bytes).toBe("ciphertext".length);
  });

  it("refuses content that was never uploaded", async () => {
    const { owner } = await seedSpace();

    const response = await create(owner, { id: uid("note"), kind: "note", blobKey: "missing" });

    expect(response.status).toBe(400);
  });

  it("refuses to let two items claim one blob", async () => {
    const { owner } = await seedSpace();
    const first = await note(owner);

    const response = await create(owner, {
      id: uid("note"),
      kind: "note",
      blobKey: first.blobKey ?? "",
    });

    expect(await errorCode(response)).toBe("conflict");
  });

  it("refuses metadata sealed under a superseded key", async () => {
    const { owner } = await seedSpace({ keyEpoch: 2 });

    const response = await create(owner, { id: uid("folder"), kind: "folder", keyEpoch: 1 });

    expect(await errorCode(response)).toBe("key_rotated");
  });

  it("refuses a parent that is not a folder of this space", async () => {
    const { owner } = await seedSpace();
    const other = await seedSpace();
    const foreign = await folder(other.owner);
    const aNote = await note(owner);

    expect((await create(owner, { id: uid("f"), kind: "folder", parentId: foreign })).status).toBe(
      404,
    );
    expect((await create(owner, { id: uid("f"), kind: "folder", parentId: aNote.id })).status).toBe(
      404,
    );
  });

  it("is open to send-only devices, which is what the CLI saves through", async () => {
    const { groupId } = await seedSpace();
    const cli = await seedDevice(groupId, { sendOnly: true });

    expect(await note(cli)).toMatchObject({ kind: "note" });
  });
});

describe("GET /api/vault", () => {
  it("answers only what changed after the cursor", async () => {
    const { owner } = await seedSpace();
    const first = await folder(owner);
    const { cursor } = await changes(owner);
    const second = await folder(owner);

    const next = await changes(owner, cursor);

    expect(next.items.map((item) => item.id)).toEqual([second]);
    expect(next.items.map((item) => item.id)).not.toContain(first);
    expect((await changes(owner, next.cursor)).items).toEqual([]);
  });

  it("keeps spaces apart", async () => {
    const a = await seedSpace();
    const b = await seedSpace();
    await folder(a.owner);

    expect((await changes(b.owner)).items).toEqual([]);
  });

  it("announces the counter on the poll, so an unchanged vault costs no request", async () => {
    const { owner } = await seedSpace();
    await folder(owner);
    const { cursor } = await changes(owner);

    const response = await SELF.fetch("https://x.dev/api/messages/pending", {
      headers: authHeader(owner),
    });

    expect(((await response.json()) as PendingMessagesResponse).vaultSeq).toBe(cursor);
  });
});

describe("PATCH /api/vault/items/:id", () => {
  it("applies an edit made against the current revision and bumps it", async () => {
    const { owner } = await seedSpace();
    const id = await folder(owner);

    const response = await update(owner, id, {
      revision: 1,
      keyEpoch: 1,
      meta: "renamed",
      metaIv: "iv2",
    });

    expect(response.status).toBe(200);
    const { item } = (await response.json()) as VaultItemWriteResponse;
    expect(item).toMatchObject({ meta: "renamed", metaIv: "iv2", revision: 2 });
  });

  it("refuses an edit made against a stale revision", async () => {
    const { owner } = await seedSpace();
    const id = await folder(owner);
    await update(owner, id, { revision: 1, keyEpoch: 1, meta: "first", metaIv: "iv" });

    const response = await update(owner, id, {
      revision: 1,
      keyEpoch: 1,
      meta: "second",
      metaIv: "iv",
    });

    expect(await errorCode(response)).toBe("conflict");
  });

  it("swaps a note's content and deletes the superseded blob", async () => {
    const { groupId, owner } = await seedSpace();
    const item = await note(owner);
    await uploadBlob(owner, "next-version", "longer-ciphertext");

    const response = await update(owner, item.id, {
      revision: 1,
      keyEpoch: 1,
      meta: "sealed-2",
      metaIv: "iv",
      blobKey: "next-version",
    });

    expect(response.status).toBe(200);
    expect(((await response.json()) as VaultItemWriteResponse).item.blobSize).toBe(
      "longer-ciphertext".length,
    );
    expect(await env.VAULT.head(blobStorageKey(groupId, item.blobKey ?? ""))).toBeNull();
    expect((await changes(owner)).usage.bytes).toBe("longer-ciphertext".length);
  });

  it("refuses new content without the metadata that holds its key", async () => {
    const { owner } = await seedSpace();
    const item = await note(owner);
    await uploadBlob(owner, "orphan-version");

    const response = await update(owner, item.id, { revision: 1, blobKey: "orphan-version" });

    expect(response.status).toBe(400);
  });

  it("moves an item into a folder", async () => {
    const { owner } = await seedSpace();
    const target = await folder(owner);
    const item = await note(owner);

    const response = await update(owner, item.id, { revision: 1, parentId: target });

    expect(((await response.json()) as VaultItemWriteResponse).item.parentId).toBe(target);
  });

  it("refuses to move a folder into itself or anything inside it", async () => {
    const { owner } = await seedSpace();
    const outer = await folder(owner);
    const inner = await folder(owner, outer);
    const deepest = await folder(owner, inner);

    expect((await update(owner, outer, { revision: 1, parentId: outer })).status).toBe(400);
    expect(await errorCode(await update(owner, outer, { revision: 1, parentId: deepest }))).toBe(
      "conflict",
    );
  });

  it("trashes and restores", async () => {
    const { owner } = await seedSpace();
    const id = await folder(owner);

    const trashed = await update(owner, id, { revision: 1, trashed: true });
    expect(((await trashed.json()) as VaultItemWriteResponse).item.trashedAt).not.toBeNull();

    const restored = await update(owner, id, { revision: 2, trashed: false });
    expect(((await restored.json()) as VaultItemWriteResponse).item.trashedAt).toBeNull();
  });
});

describe("DELETE /api/vault/items/:id", () => {
  it("purges a folder with everything nested in it, blobs included", async () => {
    const { groupId, owner } = await seedSpace();
    const outer = await folder(owner);
    const inner = await folder(owner, outer);
    const deep = await note(owner, inner);
    const kept = await note(owner);
    const { cursor } = await changes(owner);

    const response = await call(owner, `/items/${outer}`, { method: "DELETE" });

    expect(response.status).toBe(200);
    expect(((await response.json()) as DeleteVaultItemResponse).removed.sort()).toEqual(
      [outer, inner, deep.id].sort(),
    );
    expect(await env.VAULT.head(blobStorageKey(groupId, deep.blobKey ?? ""))).toBeNull();

    // Devices that held a copy learn to drop it; the rest of the vault is untouched.
    const next = await changes(owner, cursor);
    expect(next.removed.sort()).toEqual([outer, inner, deep.id].sort());
    expect(next.usage).toEqual({ bytes: kept.blobSize, items: 1 });
  });
});

describe("POST /api/vault/reseal", () => {
  async function rotateTo(groupId: string, epoch: number): Promise<void> {
    await env.DB.batch([
      env.DB.prepare("UPDATE groups SET key_epoch = ? WHERE id = ?").bind(epoch, groupId),
      env.DB.prepare("UPDATE devices SET key_epoch = ? WHERE group_id = ?").bind(epoch, groupId),
    ]);
  }

  function reseal(device: SeededDevice, body: VaultResealRequest): Promise<Response> {
    return call(device, "/reseal", { method: "POST", body: JSON.stringify(body) });
  }

  it("re-seals metadata under the current key without touching the revision", async () => {
    const { groupId, owner } = await seedSpace();
    const id = await folder(owner);
    await rotateTo(groupId, 2);

    const response = await reseal(owner, {
      keyEpoch: 2,
      items: [{ id, revision: 1, meta: "resealed", metaIv: "iv" }],
    });

    expect(await response.json()).toEqual({ ok: true, resealed: 1 });
    expect((await changes(owner)).items[0]).toMatchObject({
      keyEpoch: 2,
      meta: "resealed",
      revision: 1,
    });
  });

  it("skips an item edited since it was read, and one already current", async () => {
    const { groupId, owner } = await seedSpace();
    const edited = await folder(owner);
    await rotateTo(groupId, 2);
    await update(owner, edited, { revision: 1, keyEpoch: 2, meta: "edit", metaIv: "iv" });

    const response = await reseal(owner, {
      keyEpoch: 2,
      items: [{ id: edited, revision: 1, meta: "stale", metaIv: "iv" }],
    });

    expect(await response.json()).toEqual({ ok: true, resealed: 0 });
  });
});

describe("vault cleanup", () => {
  it("purges what sat in the trash past its TTL", async () => {
    const { groupId, owner } = await seedSpace();
    const old = await note(owner);
    const recent = await folder(owner);
    await update(owner, old.id, { revision: 1, trashed: true });
    await update(owner, recent, { revision: 1, trashed: true });
    await env.DB.prepare("UPDATE vault_items SET trashed_at = ? WHERE group_id = ? AND id = ?")
      .bind(Date.now() - VAULT_TRASH_TTL_MS - 1_000, groupId, old.id)
      .run();

    await runCleanup(env);

    const listing = await changes(owner);
    expect(listing.items.map((item) => item.id)).toEqual([recent]);
    expect(await env.VAULT.head(blobStorageKey(groupId, old.blobKey ?? ""))).toBeNull();
  });

  it("forgets old tombstones and makes a cursor older than them resync", async () => {
    const { groupId, owner } = await seedSpace();
    const doomed = await folder(owner);
    const { cursor } = await changes(owner);
    await call(owner, `/items/${doomed}`, { method: "DELETE" });
    await env.DB.prepare("UPDATE vault_items SET removed_at = ? WHERE group_id = ?")
      .bind(Date.now() - VAULT_TOMBSTONE_TTL_MS - 1_000, groupId)
      .run();

    await runCleanup(env);

    const stale = await changes(owner, cursor);
    expect(stale.reset).toBe(true);
    expect(stale.removed).toEqual([]);
    expect((await changes(owner, stale.cursor)).reset).toBe(false);
  });

  it("discards an upload no item claimed within the hour, and keeps claimed ones", async () => {
    const { groupId, owner } = await seedSpace();
    await uploadBlob(owner, "abandoned");
    const claimed = await note(owner);
    await env.DB.prepare(`UPDATE ${VAULT_BLOBS.table} SET created_at = ? WHERE group_id = ?`)
      .bind(Date.now() - 2 * 60 * 60 * 1000, groupId)
      .run();

    await runCleanup(env);

    expect(await env.VAULT.head(blobStorageKey(groupId, "abandoned"))).toBeNull();
    expect(await env.VAULT.head(blobStorageKey(groupId, claimed.blobKey ?? ""))).not.toBeNull();
  });
});
