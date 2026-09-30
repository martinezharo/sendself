import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Api, ApiError } from "@sendself/client/api";
import {
  generateDeviceKeyPair,
  generateGroupKey,
  generateSigningKeyPair,
  importPublicKey,
  exportPublicKey,
  verifyStatement,
  wrapRotatedKey,
} from "@sendself/client/crypto";
import { createKeyring } from "@sendself/client/keyring";
import {
  decryptMessageFile,
  decryptMessageMeta,
  decryptMessageText,
} from "@sendself/client/message";
import {
  type PendingKeyDelivery,
  type PendingMessagesResponse,
  type SendMessageRequest,
  messageSignatureStatement,
} from "@sendself/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Device, loadDevice, saveDevice } from "./config";
import { planMessages, sendAll } from "./send";

const GROUP = "group-1";

let dir: string;
let path: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "sendself-cli-"));
  path = join(dir, "state", "device.json");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function newDevice(): Promise<Device> {
  return {
    server: "https://example.test",
    groupId: GROUP,
    deviceId: "cli-device",
    deviceName: "VPS",
    token: "token-1",
    keyPair: await generateDeviceKeyPair(),
    signingKeyPair: await generateSigningKeyPair(),
    keyring: createKeyring(await generateGroupKey(), 3),
  };
}

/** The slice of the API `send` uses, recording what reached the "server". */
function fakeApi(options: {
  keys?: PendingKeyDelivery[];
  keyEpoch?: number;
  /** Refuse this many sends with `key_rotated` before accepting one. */
  rotatedSends?: number;
}) {
  const sent: SendMessageRequest[] = [];
  const uploads = new Map<string, ArrayBuffer>();
  const acked: number[] = [];
  let rotatedSends = options.rotatedSends ?? 0;
  let keys = options.keys ?? [];
  const api = {
    async pendingMessages(): Promise<PendingMessagesResponse> {
      return {
        messages: [],
        keys,
        keyEpoch: options.keyEpoch ?? 3,
        rotationPending: false,
        spaceName: null,
      };
    },
    async ackKey(epoch: number) {
      acked.push(epoch);
      keys = keys.filter((k) => k.epoch > epoch);
      return { ok: true as const };
    },
    async uploadFile(r2Key: string, ciphertext: ArrayBuffer) {
      uploads.set(r2Key, ciphertext);
    },
    async sendMessage(body: SendMessageRequest) {
      if (rotatedSends > 0) {
        rotatedSends--;
        throw new ApiError(409, "key_rotated", "rotated");
      }
      sent.push(body);
    },
  };
  return { api: api as unknown as Api, sent, uploads, acked };
}

describe("planMessages", () => {
  const file = (name: string) => ({ path: `/tmp/${name}`, name, size: 3, mime: "text/plain" });

  it("sends text alone as one message", () => {
    const [message, ...rest] = planMessages({ text: "hello", files: [] });
    expect(rest).toEqual([]);
    expect(message).toMatchObject({ text: "hello" });
    expect(message?.meta).toBeUndefined();
  });

  it("puts the caption on the first of several files and groups them as an album", () => {
    const messages = planMessages({ text: "caption", files: [file("a.txt"), file("b.txt")] });

    expect(messages.map((m) => m.text)).toEqual(["caption", undefined]);
    const batchIds = new Set(messages.map((m) => m.meta?.batchId));
    expect(batchIds.size).toBe(1);
    expect(messages.map((m) => [m.meta?.batchIndex, m.meta?.batchCount])).toEqual([
      [0, 2],
      [1, 2],
    ]);
    expect(new Set(messages.map((m) => m.file?.r2Key)).size).toBe(2);
  });

  it("does not make an album of one file", () => {
    const [message] = planMessages({ files: [file("a.txt")] });
    expect(message?.meta).toEqual({ name: "a.txt", size: 3, mime: "text/plain" });
  });

  it("marks every message view-once when asked", () => {
    const messages = planMessages({ text: "secret", files: [], viewOnce: true });
    expect(messages[0]?.meta).toEqual({ viewOnce: true });
  });

  it("refuses to send nothing", () => {
    expect(() => planMessages({ files: [] })).toThrow("Nothing to send");
  });
});

describe("device file", () => {
  it("round-trips the identity and every key epoch, readable by its owner only", async () => {
    const device = await newDevice();

    await saveDevice(device, path);
    const loaded = await loadDevice(path);

    expect(loaded).toMatchObject({ groupId: GROUP, deviceId: "cli-device", token: "token-1" });
    expect(loaded.keyring.current).toBe(3);
    expect(await exportPublicKey(loaded.keyPair.publicKey)).toBe(
      await exportPublicKey(device.keyPair.publicKey),
    );
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, "state"))).mode & 0o777).toBe(0o700);
    expect(await readFile(path, "utf8")).not.toContain("undefined");
  });

  it("says how to link when there is nothing linked yet", async () => {
    await expect(loadDevice(path)).rejects.toThrow("sendself link");
  });
});

describe("sendAll", () => {
  it("sends a signed file whose ciphertext only the space key opens", async () => {
    const device = await newDevice();
    const { api, sent, uploads } = fakeApi({});
    const source = join(dir, "report.txt");
    await writeFile(source, "quarterly numbers");

    await sendAll(
      device,
      api,
      {
        text: "here you go",
        files: [{ path: source, name: "report.txt", size: 17, mime: "text/plain" }],
      },
      { devicePath: path },
    );

    expect(sent).toHaveLength(1);
    const message = sent[0]!;
    const key = device.keyring.keys.get(3)!;
    expect(message.keyEpoch).toBe(3);
    expect(await decryptMessageText(key, message.id, message.encryptedPayload!, message.iv!)).toBe(
      "here you go",
    );
    expect(
      await decryptMessageMeta(key, message.id, message.fileMeta!, message.fileMetaIv!),
    ).toEqual({ name: "report.txt", size: 17, mime: "text/plain" });
    const plaintext = await decryptMessageFile(
      key,
      message.id,
      uploads.get(message.fileR2Key!)!,
      message.fileIv!,
    );
    expect(new TextDecoder().decode(plaintext)).toBe("quarterly numbers");

    const verified = await verifyStatement(
      device.signingKeyPair.publicKey,
      messageSignatureStatement({
        groupId: GROUP,
        messageId: message.id,
        senderDeviceId: device.deviceId,
        keyEpoch: 3,
        encryptedPayload: message.encryptedPayload,
        iv: message.iv,
        fileR2Key: message.fileR2Key,
        fileIv: message.fileIv,
        fileMeta: message.fileMeta,
        fileMetaIv: message.fileMetaIv,
      }),
      message.signature!,
    );
    expect(verified).toBe(true);
  });

  it("adopts a rotated key, persists it before acking, and encrypts under it", async () => {
    const device = await newDevice();
    const next = await generateGroupKey();
    const wrapped = await wrapRotatedKey(
      await importPublicKey(await exportPublicKey(device.keyPair.publicKey)),
      next,
      GROUP,
      4,
      device.deviceId,
    );
    const { api, sent, acked } = fakeApi({
      keyEpoch: 4,
      keys: [
        {
          epoch: 4,
          wrappedKey: wrapped.wrappedPackage,
          ephemeralPublicKey: wrapped.ephemeralPublicKey,
        },
      ],
    });

    await sendAll(device, api, { text: "after rotation", files: [] }, { devicePath: path });

    expect(acked).toEqual([4]);
    expect((await loadDevice(path)).keyring.current).toBe(4);
    const message = sent[0]!;
    expect(message.keyEpoch).toBe(4);
    expect(await decryptMessageText(next, message.id, message.encryptedPayload!, message.iv!)).toBe(
      "after rotation",
    );
  });

  it("explains a rotation it cannot catch up with instead of looping", async () => {
    const device = await newDevice();
    const { api } = fakeApi({ rotatedSends: 5 });

    await expect(
      sendAll(device, api, { text: "hi", files: [] }, { devicePath: path }),
    ).rejects.toThrow("has not received the new one yet");
  });

  it("refuses a file over the size limit before sending anything", async () => {
    const device = await newDevice();
    const { api, sent } = fakeApi({});

    await expect(
      sendAll(
        device,
        api,
        { files: [{ path: "/nope", name: "huge.bin", size: 60 * 1024 * 1024, mime: "x/y" }] },
        { devicePath: path },
      ),
    ).rejects.toThrow("limit");
    expect(sent).toEqual([]);
  });

  it("waits out a rate limit rather than failing the send", async () => {
    const device = await newDevice();
    const { api, sent } = fakeApi({});
    let limited = 2;
    const send = api.sendMessage;
    api.sendMessage = async (...args) => {
      if (limited-- > 0) throw new ApiError(429, "rate_limited", "slow down");
      return send(...args);
    };
    const waits: number[] = [];

    await sendAll(
      device,
      api,
      { text: "patience", files: [] },
      { devicePath: path, sleep: async (ms) => void waits.push(ms) },
    );

    expect(sent).toHaveLength(1);
    expect(waits).toHaveLength(2);
  });
});
