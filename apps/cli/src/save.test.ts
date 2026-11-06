import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api } from "@sendself/client/api";
import {
  generateDeviceKeyPair,
  generateGroupKey,
  generateSigningKeyPair,
} from "@sendself/client/crypto";
import { createKeyring } from "@sendself/client/keyring";
import { openVaultMeta, readVaultContent } from "@sendself/client/vault";
import type {
  CreateVaultItemRequest,
  PendingMessagesResponse,
  VaultChangesResponse,
  VaultItemRecord,
} from "@sendself/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Device } from "./config";
import { folderNames, saveAll } from "./save";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "sendself-save-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function newDevice(): Promise<Device> {
  return {
    server: "https://example.test",
    groupId: "group-1",
    deviceId: "cli-device",
    deviceName: "VPS",
    token: "token-1",
    keyPair: await generateDeviceKeyPair(),
    signingKeyPair: await generateSigningKeyPair(),
    keyring: createKeyring(await generateGroupKey(), 1),
  };
}

/** The slice of the API `save` uses: an in-memory vault. */
function fakeApi() {
  const records: VaultItemRecord[] = [];
  const blobs = new Map<string, ArrayBuffer>();
  const api = {
    async pendingMessages(): Promise<PendingMessagesResponse> {
      return { messages: [], keys: [], keyEpoch: 1, rotationPending: false, spaceName: null };
    },
    async vaultChanges(): Promise<VaultChangesResponse> {
      return {
        items: [...records],
        removed: [],
        cursor: records.length,
        more: false,
        reset: false,
        usage: { bytes: 0, items: records.length },
      };
    },
    async uploadVaultBlob(key: string, data: ArrayBuffer) {
      blobs.set(key, data);
    },
    async downloadVaultBlob(key: string) {
      return blobs.get(key);
    },
    async createVaultItem(body: CreateVaultItemRequest) {
      const item: VaultItemRecord = {
        id: body.id,
        parentId: body.parentId,
        kind: body.kind,
        keyEpoch: body.keyEpoch,
        meta: body.meta,
        metaIv: body.metaIv,
        blobKey: body.blobKey ?? null,
        blobSize: 0,
        revision: 1,
        createdAt: records.length,
        updatedAt: records.length,
        trashedAt: null,
        seq: records.length + 1,
      };
      records.push(item);
      return { ok: true as const, item };
    },
  };
  return { api: api as unknown as Api, records };
}

describe("folderNames", () => {
  it("ignores empty segments and surrounding space", () => {
    expect(folderNames(" /Work// Invoices /")).toEqual(["Work", "Invoices"]);
    expect(folderNames(undefined)).toEqual([]);
  });
});

describe("saveAll", () => {
  it("creates the missing folders once and saves files and a note into the last one", async () => {
    const device = await newDevice();
    const { api, records } = fakeApi();
    const path = join(dir, "invoice.pdf");
    await writeFile(path, "pdf-bytes");
    const file = { path, name: "invoice.pdf", size: 9, mime: "application/pdf" };

    await saveAll(device, api, { folder: "Work/Invoices", files: [file] });
    await saveAll(device, api, {
      folder: "Work/Invoices",
      files: [],
      note: { title: "", text: "Paid on the 3rd" },
    });

    const opened = await Promise.all(
      records.map(async (record) => ({
        record,
        meta: await openVaultMeta(device.keyring, device.groupId, record),
      })),
    );
    const folders = opened.filter((entry) => entry.record.kind === "folder");
    expect(folders.map((entry) => entry.meta?.name)).toEqual(["Work", "Invoices"]);
    const invoices = folders[1]!.record.id;
    const saved = opened.filter((entry) => entry.record.kind !== "folder");
    expect(saved.map((entry) => [entry.meta?.name, entry.record.parentId])).toEqual([
      ["invoice.pdf", invoices],
      ["Paid on the 3rd", invoices],
    ]);
    const content = await readVaultContent(
      { api, auth: { token: device.token }, groupId: device.groupId },
      saved[0]!,
    );
    expect(new TextDecoder().decode(content)).toBe("pdf-bytes");
  });
});
