import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalMessage, Session } from "../types";

const state = vi.hoisted(() => ({
  messages: new Map<string, LocalMessage>(),
  files: new Map<string, Blob>(),
  session: {
    groupId: "group",
    deviceId: "device",
    deviceName: "Phone",
    deviceAuthToken: "token",
  } satisfies Session,
  keyring: { current: 3, keys: new Map<number, CryptoKey>([[3, {} as CryptoKey]]) },
  signingKeyPair: { privateKey: {} as CryptoKey, publicKey: {} as CryptoKey } as CryptoKeyPair,
  uploadFile: vi.fn(),
  sendMessage: vi.fn(),
  encryptJson: vi.fn(),
}));

vi.mock("../db/store", () => ({
  META_GROUP_KEY: "groupKey",
  META_KEYRING: "keyring",
  META_SESSION: "session",
  META_SIGNING_KEYPAIR: "signingKeyPair",
  allMessages: async () => [...state.messages.values()],
  getFile: async (key: string) => state.files.get(key),
  getMessage: async (id: string) => state.messages.get(id),
  metaGet: async (key: string) =>
    key === "session"
      ? state.session
      : key === "keyring"
        ? state.keyring
        : key === "signingKeyPair"
          ? state.signingKeyPair
          : undefined,
  metaSet: async () => {},
  metaDelete: async () => {},
  putMessage: async (message: LocalMessage) => {
    state.messages.set(message.id, message);
  },
}));

vi.mock("../crypto/crypto", () => ({
  bufToBase64Url: () => "pinned-iv",
  encryptFile: async () => ({ ciphertext: new ArrayBuffer(16), iv: "pinned-iv" }),
  encryptJson: async (_key: CryptoKey, payload: unknown, context: string) => {
    state.encryptJson(payload, context);
    return { ciphertext: "encrypted-meta", iv: "meta-iv" };
  },
  encryptText: async () => ({ ciphertext: "encrypted-text", iv: "text-iv" }),
  randomBytes: () => new Uint8Array(12),
  signStatement: async (_key: CryptoKey, statement: string) => `signed(${statement})`,
}));

vi.mock("../api/client", () => {
  class ApiError extends Error {
    constructor(
      readonly status: number,
      readonly code: string,
      message: string,
    ) {
      super(message);
    }
  }
  class NetworkError extends Error {}
  return {
    ApiError,
    NetworkError,
    api: {
      uploadFile: state.uploadFile,
      sendMessage: state.sendMessage,
    },
  };
});

import { deleteSignatureStatement, messageSignatureStatement } from "@sendself/shared";
import { flushQueuedOutbox } from "./outbox";

function queuedFile(id: string, createdAt: number): LocalMessage {
  return {
    id,
    direction: "out",
    senderDeviceId: "device",
    file: {
      r2Key: `file-${id}`,
      iv: "",
      name: `${id}.bin`,
      size: 4,
      mime: "application/octet-stream",
    },
    createdAt,
    status: "queued",
    fileState: "downloaded",
  };
}

function addFiles(count: number): LocalMessage[] {
  const messages = Array.from({ length: count }, (_, index) =>
    queuedFile(`message-${index + 1}`, index),
  );
  for (const message of messages) {
    state.messages.set(message.id, message);
    state.files.set(message.file!.r2Key, new Blob(["data"]));
  }
  return messages;
}

describe("outbox batch handoff", () => {
  beforeEach(() => {
    state.messages.clear();
    state.files.clear();
    state.uploadFile.mockReset().mockResolvedValue(undefined);
    state.sendMessage.mockReset().mockResolvedValue(undefined);
  });

  it("processes only one file in a bounded worker pass and reports the rest", async () => {
    const messages = addFiles(3);

    const result = await flushQueuedOutbox(undefined, { maxMessages: 1 });

    expect(result).toEqual({ sent: 1, failed: 0, remaining: 2 });
    expect(state.uploadFile).toHaveBeenCalledTimes(1);
    expect(state.messages.get(messages[0]!.id)?.status).toBe("sent");
    expect(state.messages.get(messages[1]!.id)?.status).toBe("queued");
    expect(state.messages.get(messages[2]!.id)?.status).toBe("queued");
    // The sent message carries the epoch it was encrypted under, so a retry
    // reproduces identical ciphertext instead of re-keying it.
    expect(state.messages.get(messages[0]!.id)?.keyEpoch).toBe(3);
    expect(state.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ keyEpoch: 3 }),
      { token: "token" },
      undefined,
    );
  });

  it("signs the ciphertext it sends, so the server can't re-attribute it", async () => {
    const message = addFiles(1)[0]!;

    await flushQueuedOutbox();

    // Signing the ciphertexts (not just the id) is what stops a server from
    // keeping the signature while swapping the payload underneath it.
    expect(state.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        signature: `signed(${messageSignatureStatement({
          groupId: "group",
          messageId: message.id,
          senderDeviceId: "device",
          keyEpoch: 3,
          fileR2Key: message.file!.r2Key,
          fileIv: "pinned-iv",
          fileMeta: "encrypted-meta",
          fileMetaIv: "meta-iv",
        })})`,
      }),
      { token: "token" },
      undefined,
    );
  });

  it("sends unsigned while a pre-signing session has no identity yet", async () => {
    const original = state.signingKeyPair;
    // @ts-expect-error deliberately simulating a session that predates signing
    state.signingKeyPair = undefined;
    addFiles(1);

    await flushQueuedOutbox();

    // Nothing breaks: peers hold no signing key for this device either, so the
    // message arrives merely unverifiable rather than rejected.
    expect(state.sendMessage.mock.calls[0]![0]).not.toHaveProperty("signature");
    state.signingKeyPair = original;
  });

  it("re-queues the interrupted file and does not start the next one", async () => {
    const messages = addFiles(2);
    const controller = new AbortController();
    let uploadStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      uploadStarted = resolve;
    });
    state.uploadFile.mockImplementation(
      (_key: string, _body: ArrayBuffer, _auth: unknown, signal?: AbortSignal) =>
        new Promise<void>((_resolve, reject) => {
          uploadStarted();
          signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        }),
    );

    const flushing = flushQueuedOutbox(undefined, { signal: controller.signal });
    await started;
    controller.abort();
    const result = await flushing;

    expect(result).toEqual({ sent: 0, failed: 0, remaining: 2 });
    expect(state.uploadFile).toHaveBeenCalledTimes(1);
    expect(state.sendMessage).not.toHaveBeenCalled();
    expect(state.messages.get(messages[0]!.id)?.status).toBe("queued");
    expect(state.messages.get(messages[1]!.id)?.status).toBe("queued");
  });
});

describe("outbox deletions", () => {
  beforeEach(() => {
    state.messages.clear();
    state.files.clear();
    state.uploadFile.mockReset().mockResolvedValue(undefined);
    state.sendMessage.mockReset().mockResolvedValue(undefined);
  });

  function queueDeletion(id: string, deletes: string): LocalMessage {
    const message: LocalMessage = {
      id,
      direction: "out",
      senderDeviceId: "device",
      deletes,
      createdAt: 0,
      status: "queued",
    };
    state.messages.set(id, message);
    return message;
  }

  it("sends a tombstone with no payload, signed over the delete statement", async () => {
    queueDeletion("tombstone-1", "target-1");

    const result = await flushQueuedOutbox();

    expect(result).toEqual({ sent: 1, failed: 0, remaining: 0 });
    const body = state.sendMessage.mock.calls[0]![0] as Record<string, unknown>;
    expect(body).not.toHaveProperty("encryptedPayload");
    expect(body).not.toHaveProperty("fileR2Key");
    expect(body.deletesMessageId).toBe("target-1");
    // A distinct statement, so a signature captured from an ordinary message
    // can never be replayed as an order to destroy one.
    expect(body.signature).toBe(
      `signed(${deleteSignatureStatement({
        groupId: "group",
        messageId: "tombstone-1",
        senderDeviceId: "device",
        keyEpoch: 3,
        deletesMessageId: "target-1",
      })})`,
    );
    expect(state.messages.get("tombstone-1")?.status).toBe("sent");
  });

  it("keeps a deletion queued when the network is down, so it lands later", async () => {
    queueDeletion("tombstone-2", "target-2");
    const { NetworkError } = await import("../api/client");
    state.sendMessage.mockRejectedValue(new NetworkError("offline"));

    const result = await flushQueuedOutbox();

    expect(result).toEqual({ sent: 0, failed: 0, remaining: 1 });
    expect(state.messages.get("tombstone-2")?.status).toBe("queued");
  });

  it("treats an already-registered deletion as delivered", async () => {
    queueDeletion("tombstone-3", "target-3");
    const { ApiError } = await import("../api/client");
    state.sendMessage.mockRejectedValue(new ApiError(409, "conflict", "Message id already exists"));

    const result = await flushQueuedOutbox();

    expect(result).toEqual({ sent: 1, failed: 0, remaining: 0 });
    expect(state.messages.get("tombstone-3")?.status).toBe("sent");
  });
});

/**
 * `fileMeta` is the message's metadata envelope, not the file's alone: it is
 * how the album grouping and the view-once flag travel where the server can
 * neither read nor strip them. These pin what actually goes into it.
 */
describe("outbox metadata envelope", () => {
  beforeEach(() => {
    state.messages.clear();
    state.files.clear();
    state.uploadFile.mockReset().mockResolvedValue(undefined);
    state.sendMessage.mockReset().mockResolvedValue(undefined);
    state.encryptJson.mockReset();
  });

  function queue(message: LocalMessage): void {
    state.messages.set(message.id, message);
    if (message.file) state.files.set(message.file.r2Key, new Blob(["data"]));
  }

  it("sends text and a file as one message, which is what a caption is", async () => {
    queue({ ...queuedFile("m1", 0), text: "the car papers" });

    await flushQueuedOutbox();

    expect(state.sendMessage).toHaveBeenCalledTimes(1);
    expect(state.sendMessage.mock.calls[0]?.[0]).toMatchObject({
      id: "m1",
      encryptedPayload: "encrypted-text",
      iv: "text-iv",
      fileR2Key: "file-m1",
      fileMeta: "encrypted-meta",
    });
  });

  it("puts the batch grouping inside the envelope, never on the wire in clear", async () => {
    queue({ ...queuedFile("m1", 0), batch: { id: "b1", index: 2, count: 5 } });

    await flushQueuedOutbox();

    expect(state.encryptJson).toHaveBeenCalledWith(
      expect.objectContaining({ batchId: "b1", batchIndex: 2, batchCount: 5 }),
      "meta:m1",
    );
    // Nothing about the grouping reaches the request body itself.
    expect(JSON.stringify(state.sendMessage.mock.calls[0]?.[0])).not.toContain("b1");
  });

  it("puts the view-once flag inside the envelope too", async () => {
    queue({ ...queuedFile("m1", 0), viewOnce: true });

    await flushQueuedOutbox();

    expect(state.encryptJson).toHaveBeenCalledWith(
      expect.objectContaining({ viewOnce: true }),
      "meta:m1",
    );
    expect(JSON.stringify(state.sendMessage.mock.calls[0]?.[0])).not.toContain("viewOnce");
  });

  it("gives a plain text message an envelope only when it has something to carry", async () => {
    queue({
      id: "m1",
      direction: "out",
      senderDeviceId: "device",
      text: "hello",
      createdAt: 0,
      status: "queued",
    });

    await flushQueuedOutbox();

    expect(state.encryptJson).not.toHaveBeenCalled();
    expect(state.sendMessage.mock.calls[0]?.[0]).not.toHaveProperty("fileMeta");
  });

  it("gives a view-once text message an envelope even though it has no file", async () => {
    queue({
      id: "m1",
      direction: "out",
      senderDeviceId: "device",
      text: "hello",
      viewOnce: true,
      createdAt: 0,
      status: "queued",
    });

    await flushQueuedOutbox();

    expect(state.encryptJson).toHaveBeenCalledWith({ viewOnce: true }, "meta:m1");
    expect(state.sendMessage.mock.calls[0]?.[0]).toMatchObject({
      encryptedPayload: "encrypted-text",
      fileMeta: "encrypted-meta",
      fileMetaIv: "meta-iv",
    });
    expect(state.uploadFile).not.toHaveBeenCalled();
  });

  it("signs the envelope, so the server cannot strip the flag that retracts a message", async () => {
    queue({
      id: "m1",
      direction: "out",
      senderDeviceId: "device",
      text: "hello",
      viewOnce: true,
      createdAt: 0,
      status: "queued",
    });

    await flushQueuedOutbox();

    const body = state.sendMessage.mock.calls[0]?.[0] as { signature?: string };
    expect(body.signature).toBe(
      `signed(${messageSignatureStatement({
        groupId: "group",
        messageId: "m1",
        senderDeviceId: "device",
        keyEpoch: 3,
        encryptedPayload: "encrypted-text",
        iv: "text-iv",
        fileMeta: "encrypted-meta",
        fileMetaIv: "meta-iv",
      })})`,
    );
  });
});
