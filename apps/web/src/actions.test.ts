import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateGroupKey } from "./crypto/crypto";
import type { LocalMessage, Session } from "./types";

/**
 * The two moments that take the app out of a space for good, and therefore have
 * to take the "reopen here" marker with them: stepping back out to the list,
 * and being thrown out of the space by the server.
 *
 * Both are one line inside much larger functions, which is precisely why they
 * are worth pinning: nothing else would notice if either went missing, and the
 * symptom (a device that reopens into a space it cannot use, or cannot leave)
 * only shows up on the *next* launch.
 */

// The sync loop is the one thing here that reaches for a DOM (window/document
// listeners) and for the network. Neither is what these tests are about, and
// stubbing it keeps them in the plain node environment the rest of the suite
// runs in.
// One object for the whole file, not a fresh one per `resetModules`: a test
// that asserts on `syncNow` has to be holding the same spy the code under test
// just called.
const syncModule = vi.hoisted(() => ({
  startSync: vi.fn(),
  stopSync: vi.fn(),
  syncNow: vi.fn(async () => {}),
}));
vi.mock("./sync/sync", () => syncModule);

let actions: typeof import("./actions");
let route: typeof import("./state/route");
let session: typeof import("./state/session");
let spaces: typeof import("./state/spaces");
let messagesState: typeof import("./state/messages");
let deletions: typeof import("./db/deletions");
let identity: typeof import("./crypto/identity");
let store: typeof import("./db/store");
let atrest: typeof import("./db/atrest");
let ui: typeof import("./state/ui");

const A_SESSION: Session = {
  groupId: "group",
  deviceId: "device",
  deviceName: "Phone",
  deviceAuthToken: "token",
};

beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory();
  vi.resetModules();
  // Imported together after the reset so every module below shares one instance
  // of the registry and of the signals.
  [actions, route, session, spaces, messagesState, deletions, identity, store, atrest, ui] =
    await Promise.all([
      import("./actions"),
      import("./state/route"),
      import("./state/session"),
      import("./state/spaces"),
      import("./state/messages"),
      import("./db/deletions"),
      import("./crypto/identity"),
      import("./db/store"),
      import("./db/atrest"),
      import("./state/ui"),
    ]);
});

describe("applyRoute", () => {
  it("forgets the space once the app is standing on the list", async () => {
    const created = await spaces.beginSpace("Home");
    route.navigate(route.spacePath(created.id));
    await actions.applyRoute();
    expect(await spaces.lastOpenedSpace()).toBe(created.id);

    route.navigate(route.APP_PATH);
    await actions.applyRoute();

    expect(await spaces.lastOpenedSpace()).toBeUndefined();
    expect(spaces.activeSpace.value).toBeNull();
  });

  it("keeps it while the app is only moving between a space's sections", async () => {
    const created = await spaces.beginSpace("Home");

    route.navigate(route.spacePath(created.id, "devices"));
    await actions.applyRoute();

    expect(await spaces.lastOpenedSpace()).toBe(created.id);
    expect(spaces.activeSpace.value?.id).toBe(created.id);
  });

  it("keeps it on the public landing page, which is not a decision about spaces", async () => {
    // Reaching the marketing page (a link, a restored tab) says nothing about
    // where the installed app should reopen.
    const created = await spaces.beginSpace("Home");

    route.navigate("/");
    await actions.applyRoute();

    expect(await spaces.lastOpenedSpace()).toBe(created.id);
  });
});

describe("handleAuthFailure", () => {
  it("forgets a space this device was thrown out of", async () => {
    const created = await spaces.beginSpace("Home");
    await spaces.openSpace(created.id);
    session.session.value = A_SESSION;

    actions.handleAuthFailure();

    expect(session.sessionRevoked.value).toBe(true);
    // The space stays on the device — the user still has to choose to leave it
    // — but the next launch lands on the list, where that choice can be made
    // and the other spaces are still reachable.
    await vi.waitFor(async () => expect(await spaces.lastOpenedSpace()).toBeUndefined());
    await spaces.refreshSpaces();
    expect(spaces.spaces.value.map((space) => space.id)).toEqual([created.id]);
  });

  it("does nothing without a session, so a stray 401 cannot wipe the marker", async () => {
    const created = await spaces.beginSpace("Home");
    session.session.value = null;

    actions.handleAuthFailure();

    expect(session.sessionRevoked.value).toBe(false);
    expect(await spaces.lastOpenedSpace()).toBe(created.id);
  });
});

/**
 * Opening a view-once message is split across two moments on purpose, and the
 * split is the whole feature: the retraction goes out when it is *opened*, so
 * no second device can still reach it, while the local copy survives until the
 * reader closes it, so the person who opened it gets to finish reading.
 */
describe("view-once messages", () => {
  const A_MESSAGE: LocalMessage = {
    id: "msg-1",
    direction: "in",
    senderDeviceId: "other-device",
    text: "secret",
    viewOnce: true,
    createdAt: 1,
    status: "sent",
  };

  beforeEach(async () => {
    // The message store is per space, so one has to be open to write into it.
    await spaces.beginSpace("Home");
    session.session.value = A_SESSION;
    identity.knownDeviceIds.value = ["device", "other-device"];
    await messagesState.upsertMessage(A_MESSAGE);
  });

  it("retracts from the other devices on open, and keeps the copy being read", async () => {
    await actions.consumeViewOnce(A_MESSAGE);

    // The tombstone is queued for delivery...
    const tombstone = messagesState.messages.value.find((m) => m.deletes === A_MESSAGE.id);
    expect(tombstone).toMatchObject({ direction: "out", status: "queued" });
    // ...and the id is remembered, so a copy still in flight is dropped on
    // arrival instead of quietly coming back.
    expect(await deletions.loadDeletions()).toHaveProperty(A_MESSAGE.id);
    // But what is being read is still here.
    expect(messagesState.getLocalMessage(A_MESSAGE.id)).toBeDefined();
  });

  it("erases the local copy when the reader closes it", async () => {
    await actions.consumeViewOnce(A_MESSAGE);
    await actions.releaseViewOnce(A_MESSAGE);

    expect(messagesState.getLocalMessage(A_MESSAGE.id)).toBeUndefined();
  });

  it("records the deletion but sends no tombstone when there is nobody to tell", async () => {
    identity.knownDeviceIds.value = ["device"];

    await actions.consumeViewOnce(A_MESSAGE);

    expect(messagesState.messages.value.some((m) => m.deletes)).toBe(false);
    expect(await deletions.loadDeletions()).toHaveProperty(A_MESSAGE.id);
  });

  it("ignores a message that is not view-once, whatever calls it", async () => {
    const ordinary: LocalMessage = { ...A_MESSAGE, id: "msg-2", viewOnce: undefined };
    await messagesState.upsertMessage(ordinary);

    await actions.consumeViewOnce(ordinary);

    expect(messagesState.messages.value.some((m) => m.deletes)).toBe(false);
    expect(messagesState.getLocalMessage("msg-2")).toBeDefined();
  });
});

/**
 * Saving an attachment is the one chat action whose outcome the app cannot
 * observe: the browser takes over the moment the anchor is clicked. So what
 * `saveFile` owes the button that started it is exactly this — `true` once a
 * download is really under way, and a spoken failure on every dead end, never a
 * rejected promise nobody is awaiting.
 */
describe("saveFile", () => {
  const A_FILE_MESSAGE: LocalMessage = {
    id: "file-1",
    direction: "in",
    senderDeviceId: "other-device",
    createdAt: 1,
    status: "sent",
    fileState: "downloaded",
    file: { r2Key: "key-1", iv: "", name: "notes.txt", size: 5, mime: "text/plain" },
  };

  /** The two browser affordances `saveFile` reaches for, in a plain-node run. */
  function stubDownload(): { href: string; download: string; clicks: number } {
    const anchor = {
      href: "",
      download: "",
      clicks: 0,
      click(): void {
        anchor.clicks++;
      },
      remove(): void {},
    };
    vi.stubGlobal("document", {
      createElement: () => anchor,
      body: { appendChild: () => {} },
    });
    URL.createObjectURL = () => "blob:test";
    URL.revokeObjectURL = () => {};
    return anchor;
  }

  beforeEach(async () => {
    await spaces.beginSpace("Home");
    session.session.value = A_SESSION;
    ui.toasts.value = [];
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    atrest.setContentKey(null);
    Reflect.deleteProperty(URL, "createObjectURL");
    // `revokeObjectURL` is left behind as a no-op on purpose: the release runs
    // on a timer that outlives the test, and it must find something to call.
    URL.revokeObjectURL = () => {};
  });

  it("hands the file to the browser under its own name, and confirms it", async () => {
    const anchor = stubDownload();
    await store.putFile("key-1", new Blob(["hello"], { type: "text/plain" }));

    await expect(actions.saveFile(A_FILE_MESSAGE)).resolves.toBe(true);

    expect(anchor).toMatchObject({ clicks: 1, download: "notes.txt", href: "blob:test" });
    expect(ui.toasts.value).toEqual([]);
  });

  it("says so when the blob is no longer on this device", async () => {
    stubDownload();

    await expect(actions.saveFile(A_FILE_MESSAGE)).resolves.toBe(false);

    expect(ui.toasts.value).toMatchObject([{ kind: "error" }]);
  });

  it("speaks up when the cached blob cannot be opened, instead of failing silently", async () => {
    // A file sealed under an at-rest key this device no longer holds: reading
    // it back rejects rather than coming back empty, and that rejection used to
    // leave the button looking broken.
    atrest.setContentKey(await generateGroupKey());
    await store.putFile("key-1", new Blob(["hello"], { type: "text/plain" }));
    atrest.setContentKey(await generateGroupKey());
    stubDownload();

    await expect(actions.saveFile(A_FILE_MESSAGE)).resolves.toBe(false);

    expect(ui.toasts.value).toMatchObject([{ kind: "error" }]);
  });
});

/**
 * A failed transfer is retried through the message itself, not only through the
 * sync loop: `syncNow()` does nothing while a pass is already running, so the
 * card has to leave its failed state on the click that asked for it.
 */
describe("retryFileDownload", () => {
  const A_FAILED_FILE: LocalMessage = {
    id: "file-2",
    direction: "in",
    senderDeviceId: "other-device",
    createdAt: 1,
    status: "sent",
    fileState: "error",
    file: { r2Key: "key-2", iv: "", name: "clip.mp4", size: 9, mime: "video/mp4" },
  };

  beforeEach(async () => {
    await spaces.beginSpace("Home");
    session.session.value = A_SESSION;
    await messagesState.upsertMessage(A_FAILED_FILE);
    // Cleared last: opening a space starts the loop on its own.
    syncModule.syncNow.mockClear();
  });

  it("puts the file back in the queue and kicks the loop that fetches it", async () => {
    await actions.retryFileDownload(A_FAILED_FILE);

    expect(messagesState.getLocalMessage("file-2")?.fileState).toBe("remote");
    // Both halves matter: the waiting state is what the card shows back
    // immediately, and the pass is what actually goes and gets the file.
    expect(syncModule.syncNow).toHaveBeenCalled();
  });

  it("leaves a file that is not in a failed state alone", async () => {
    const downloaded: LocalMessage = { ...A_FAILED_FILE, id: "file-3", fileState: "downloaded" };
    await messagesState.upsertMessage(downloaded);

    await actions.retryFileDownload(downloaded);

    expect(messagesState.getLocalMessage("file-3")?.fileState).toBe("downloaded");
    expect(syncModule.syncNow).not.toHaveBeenCalled();
  });
});

/**
 * `failed` is the one state nothing picks up again on its own, so the only way
 * back for those messages is somebody asking — and asking has to reach all of
 * them, including the ones that never had a bubble to ask from.
 */
describe("retryFailedSends", () => {
  const failedText: LocalMessage = {
    id: "out-1",
    direction: "out",
    senderDeviceId: "device",
    text: "hello",
    createdAt: 1,
    status: "failed",
    retry: { attempts: 4, notBefore: Date.now() + 300_000 },
  };
  const failedTombstone: LocalMessage = {
    id: "out-2",
    direction: "out",
    senderDeviceId: "device",
    deletes: "some-message",
    createdAt: 2,
    status: "failed",
  };
  const stillGoing: LocalMessage = {
    id: "out-3",
    direction: "out",
    senderDeviceId: "device",
    text: "on its way",
    createdAt: 3,
    status: "queued",
    retry: { attempts: 1, notBefore: Date.now() + 5_000 },
  };

  beforeEach(async () => {
    await spaces.beginSpace("Home");
    session.session.value = A_SESSION;
    for (const message of [failedText, failedTombstone, stillGoing]) {
      await messagesState.upsertMessage(message);
    }
    syncModule.syncNow.mockClear();
  });

  it("re-queues everything that gave up and drops the wait it was serving", async () => {
    await actions.retryFailedSends();

    expect(messagesState.getLocalMessage("out-1")).toMatchObject({ status: "queued" });
    // The press means "now": leaving the schedule behind would make it do
    // nothing at all for the next five minutes.
    expect(messagesState.getLocalMessage("out-1")?.retry).toBeUndefined();
    expect(syncModule.syncNow).toHaveBeenCalled();
  });

  it("revives a stranded tombstone, which has no bubble of its own to ask from", async () => {
    await actions.retryFailedSends();

    expect(messagesState.getLocalMessage("out-2")).toMatchObject({ status: "queued" });
  });

  it("leaves a message that is merely waiting alone, schedule and all", async () => {
    await actions.retryFailedSends();

    // It has not given up: the outbox is still going to send it, and clearing
    // its backoff here would be the app hurrying something nobody asked about.
    expect(messagesState.getLocalMessage("out-3")).toMatchObject({
      status: "queued",
      retry: stillGoing.retry,
    });
  });
});
