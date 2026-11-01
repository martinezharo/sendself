import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalMessage } from "../types";

/**
 * The outbox index and history pruning, against a real IndexedDB.
 *
 * The index is a cache of "which rows are still owed to the server", and the
 * one thing it may never do is miss a row — the outbox would then stop sending
 * it without any error. These tests pin that, including for a device whose
 * history predates the index and for a sealed (locked) store.
 */

type Store = typeof import("./store");
type AtRest = typeof import("./atrest");

let store: Store;
let atrest: AtRest;
const SPACE = "space-a";

beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory();
  vi.resetModules();
  store = await import("./store");
  atrest = await import("./atrest");
  store.setActiveSpace(SPACE);
});

function message(
  id: string,
  createdAt: number,
  overrides: Partial<LocalMessage> = {},
): LocalMessage {
  return {
    id,
    direction: "out",
    senderDeviceId: "this-device",
    text: id,
    createdAt,
    status: "queued",
    ...overrides,
  };
}

async function contentKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

const ids = (messages: LocalMessage[]): string[] => messages.map((m) => m.id);

describe("the outbox index", () => {
  it("lists queued and uploading outgoing messages, oldest first", async () => {
    await store.putMessage(message("b", 2, { status: "uploading" }));
    await store.putMessage(message("a", 1));
    await store.putMessage(message("sent", 3, { status: "sent" }));
    await store.putMessage(message("failed", 4, { status: "failed" }));
    await store.putMessage(message("in", 5, { direction: "in", status: "sent" }));

    expect(ids(await store.queuedMessages())).toEqual(["a", "b"]);
  });

  it("drops a message once it is sent, and picks it up again when it is retried", async () => {
    await store.putMessage(message("a", 1));
    await store.queuedMessages();

    await store.putMessage(message("a", 1, { status: "sent" }));
    expect(await store.queuedMessages()).toEqual([]);

    await store.putMessage(message("a", 1, { status: "failed" }));
    await store.putMessage(message("a", 1, { status: "queued" }));
    expect(ids(await store.queuedMessages())).toEqual(["a"]);
  });

  it("forgets a deleted message", async () => {
    await store.putMessage(message("a", 1));
    await store.queuedMessages();
    await store.deleteMessage("a");

    expect(await store.queuedMessages()).toEqual([]);
    expect(await store.metaGet<{ ids: string[] }>(store.META_OUTBOX)).toMatchObject({ ids: [] });
  });

  it("includes a batch of files queued in one go", async () => {
    await store.putOutgoingFileMessages([
      {
        message: message("f1", 1, {
          text: undefined,
          file: { r2Key: "k1", iv: "", name: "a", size: 1, mime: "text/plain" },
        }),
        blob: new Blob(["a"]),
      },
      {
        message: message("f2", 2, {
          text: undefined,
          file: { r2Key: "k2", iv: "", name: "b", size: 1, mime: "text/plain" },
        }),
        blob: new Blob(["b"]),
      },
    ]);

    expect(ids(await store.queuedMessages())).toEqual(["f1", "f2"]);
  });

  it("is built from one scan on a device whose history predates it", async () => {
    await store.putMessage(message("a", 1));
    await store.putMessage(message("sent", 2, { status: "sent" }));
    // What an older build left behind: rows, and no index.
    await store.metaDelete(store.META_OUTBOX);

    expect(ids(await store.queuedMessages())).toEqual(["a"]);
    expect(await store.metaGet(store.META_OUTBOX)).toEqual({ complete: true, ids: ["a"] });
  });

  it("is not called complete by a scan that could not open every row", async () => {
    atrest.setContentKey(await contentKey());
    await store.putMessage(message("sealed", 1));
    await store.metaDelete(store.META_OUTBOX);

    // The service worker never holds the content key.
    atrest.setContentLocked(true);
    expect(await store.queuedMessages()).toEqual([]);
    expect(await store.metaGet(store.META_OUTBOX)).toMatchObject({ complete: false });
  });

  it("heals an index that a writer unaware of it left without a queued id", async () => {
    await store.putMessage(message("a", 1));
    // What an older build, still open in another tab, leaves behind.
    await store.metaSet(store.META_OUTBOX, { complete: true, ids: [] });
    expect(await store.queuedMessages()).toEqual([]);

    await store.trackQueued(await store.allMessages());

    expect(ids(await store.queuedMessages())).toEqual(["a"]);
  });

  it("keeps a message queued through turning the at-rest lock on", async () => {
    await store.putMessage(message("a", 1));
    await store.metaSet(store.META_OUTBOX, { complete: true, ids: [] });

    await store.rewriteLocalContent(await contentKey());

    expect(await store.metaGet(store.META_OUTBOX)).toMatchObject({ ids: ["a"] });
  });

  it("keeps the id of a sealed row it cannot open, so it is sent once unlocked", async () => {
    const key = await contentKey();
    atrest.setContentKey(key);
    await store.putMessage(message("sealed", 1));
    await store.queuedMessages();

    atrest.setContentLocked(true);
    expect(await store.queuedMessages()).toEqual([]);

    atrest.setContentKey(key);
    expect(ids(await store.queuedMessages())).toEqual(["sealed"]);
  });
});

describe("pruning history", () => {
  it("deletes messages, their files and events older than the cutoff", async () => {
    await store.putMessage(
      message("old-in", 1, {
        direction: "in",
        status: "sent",
        file: { r2Key: "old-file", iv: "iv", name: "a", size: 1, mime: "text/plain" },
      }),
    );
    await store.putFile("old-file", new Blob(["a"]));
    await store.putMessage(message("old-out", 2, { status: "sent" }));
    await store.putMessage(message("new", 20, { direction: "in", status: "sent" }));
    await store.putEvent({ id: "old-event", createdAt: 3 } as never);
    await store.putEvent({ id: "new-event", createdAt: 30 } as never);

    expect(await store.pruneHistory(10)).toBe(2);

    expect(ids(await store.allMessages())).toEqual(["new"]);
    expect(await store.getFile("old-file")).toBeUndefined();
    expect((await store.allEvents()).map((event) => event.id)).toEqual(["new-event"]);
  });

  it("never deletes an outgoing message that has not been delivered", async () => {
    await store.putMessage(message("queued", 1));
    await store.putMessage(message("failed", 2, { status: "failed" }));

    expect(await store.pruneHistory(10)).toBe(0);
    expect(ids(await store.allMessages())).toEqual(["queued", "failed"]);
    expect(ids(await store.queuedMessages())).toEqual(["queued"]);
  });
});
