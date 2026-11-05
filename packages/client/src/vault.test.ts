import type {
  CreateVaultItemRequest,
  UpdateVaultItemRequest,
  VaultItemRecord,
  VaultResealRequest,
} from "@sendself/shared";
import { describe, expect, it } from "vitest";
import type { Api } from "./api";
import { generateGroupKey } from "./crypto";
import { type Keyring, createKeyring, withEpoch } from "./keyring";
import {
  type VaultContext,
  applyVaultChanges,
  createVaultFile,
  createVaultFolder,
  createVaultNote,
  isVaultItemVisible,
  noteTitle,
  openVaultMeta,
  readVaultNote,
  readVaultContent,
  resealVault,
  updateVaultNote,
  vaultSubtree,
} from "./vault";

/** An in-memory stand-in for the vault endpoints, enough to round-trip what clients seal. */
function fakeServer() {
  const records = new Map<string, VaultItemRecord>();
  const blobs = new Map<string, ArrayBuffer>();
  let seq = 0;
  const write = (record: VaultItemRecord): VaultItemRecord => {
    const next = { ...record, seq: ++seq };
    records.set(record.id, next);
    return next;
  };
  const api = {
    async uploadVaultBlob(key: string, data: ArrayBuffer) {
      blobs.set(key, data);
    },
    async downloadVaultBlob(key: string) {
      const blob = blobs.get(key);
      if (!blob) throw new Error("missing blob");
      return blob;
    },
    async createVaultItem(body: CreateVaultItemRequest) {
      const item = write({
        id: body.id,
        parentId: body.parentId,
        kind: body.kind,
        keyEpoch: body.keyEpoch,
        meta: body.meta,
        metaIv: body.metaIv,
        blobKey: body.blobKey ?? null,
        blobSize: body.blobKey ? (blobs.get(body.blobKey)?.byteLength ?? 0) : 0,
        revision: 1,
        createdAt: 0,
        updatedAt: 0,
        trashedAt: null,
        seq: 0,
      });
      return { ok: true as const, item };
    },
    async updateVaultItem(id: string, body: UpdateVaultItemRequest) {
      const current = records.get(id);
      if (!current || current.revision !== body.revision) throw new Error("conflict");
      const item = write({
        ...current,
        ...(body.meta
          ? { meta: body.meta, metaIv: body.metaIv ?? "", keyEpoch: body.keyEpoch ?? 0 }
          : {}),
        ...(body.blobKey ? { blobKey: body.blobKey } : {}),
        revision: current.revision + 1,
      });
      return { ok: true as const, item };
    },
    async resealVault(body: VaultResealRequest) {
      for (const item of body.items) {
        const current = records.get(item.id);
        if (current)
          write({ ...current, meta: item.meta, metaIv: item.metaIv, keyEpoch: body.keyEpoch });
      }
      return { ok: true as const, resealed: body.items.length };
    },
  };
  return { api: api as unknown as Api, records };
}

async function context(keyring?: Keyring) {
  const server = fakeServer();
  const ctx: VaultContext = {
    api: server.api,
    auth: { token: "t" },
    groupId: "group",
    keyring: keyring ?? createKeyring(await generateGroupKey()),
  };
  return { ctx, server };
}

describe("vault sealing", () => {
  it("round-trips a note's title, excerpt and text", async () => {
    const { ctx, server } = await context();

    const entry = await createVaultNote(ctx, null, "", "Wi-Fi\npassword is on the fridge");

    const record = server.records.get(entry.record.id)!;
    const meta = await openVaultMeta(ctx.keyring, ctx.groupId, record);
    expect(meta).toMatchObject({ name: "Wi-Fi", excerpt: "Wi-Fi password is on the fridge" });
    expect(await readVaultNote(ctx, { record, meta })).toBe("Wi-Fi\npassword is on the fridge");
  });

  it("round-trips a file and keeps the server from moving metadata between items", async () => {
    const { ctx, server } = await context();
    const bytes = new Uint8Array([1, 2, 3, 4]).buffer;

    const file = await createVaultFile(ctx, null, { name: "a.bin", mime: "x/y", data: bytes });
    const other = await createVaultFolder(ctx, null, "Folder");

    expect(new Uint8Array(await readVaultContent(ctx, file))).toEqual(new Uint8Array(bytes));
    // The other item's ciphertext pasted onto this one does not open.
    const forged = {
      ...server.records.get(file.record.id)!,
      meta: other.record.meta,
      metaIv: other.record.metaIv,
    };
    expect(await openVaultMeta(ctx.keyring, ctx.groupId, forged)).toBeNull();
  });

  it("seals each saved version of a note under a new content key", async () => {
    const { ctx } = await context();
    const first = await createVaultNote(ctx, null, "Plan", "v1");

    const second = await updateVaultNote(ctx, first, "Plan", "v2");

    expect(second.meta?.contentKey).not.toBe(first.meta?.contentKey);
    expect(await readVaultNote(ctx, second)).toBe("v2");
  });

  it("re-seals what an older epoch sealed, so a device holding only the new key can read it", async () => {
    const oldKey = await generateGroupKey();
    const { ctx, server } = await context(createKeyring(oldKey));
    const folder = await createVaultFolder(ctx, null, "Taxes");
    const newKey = await generateGroupKey();
    const rotated = withEpoch(ctx.keyring, 2, newKey);

    const resealed = await resealVault({ ...ctx, keyring: rotated }, [folder]);

    expect(resealed).toBe(1);
    const latecomer = createKeyring(newKey, 2);
    const record = server.records.get(folder.record.id)!;
    expect(await openVaultMeta(latecomer, ctx.groupId, record)).toEqual({ name: "Taxes" });
  });
});

describe("vault tree", () => {
  const record = (id: string, parentId: string | null, trashedAt: number | null = null) =>
    ({ id, parentId, trashedAt }) as VaultItemRecord;

  it("hides everything under a trashed folder", () => {
    const records = new Map(
      [record("a", null, 1), record("b", "a"), record("c", null)].map((r) => [r.id, r]),
    );

    expect(isVaultItemVisible(records, records.get("b")!)).toBe(false);
    expect(isVaultItemVisible(records, records.get("c")!)).toBe(true);
  });

  it("finds a folder's subtree, which is where it may not be moved", () => {
    const records = new Map(
      [record("a", null), record("b", "a"), record("c", "b"), record("d", null)].map((r) => [
        r.id,
        r,
      ]),
    );

    expect([...vaultSubtree(records, "a")].sort()).toEqual(["a", "b", "c"]);
  });

  it("starts over on a reset, and otherwise applies changes on top", () => {
    const before = new Map([["a", record("a", null)]]);

    expect([...applyVaultChanges(before, { items: [], removed: [], reset: true }).keys()]).toEqual(
      [],
    );
    expect([
      ...applyVaultChanges(before, {
        items: [record("b", null)],
        removed: ["a"],
        reset: false,
      }).keys(),
    ]).toEqual(["b"]);
  });

  it("names an untitled note after its first line", () => {
    expect(noteTitle("  ", "\n  Groceries  \nmilk")).toBe("Groceries");
    expect(noteTitle("", "")).toBe("Untitled note");
  });
});
