import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import type { DeviceInfo } from "@sendself/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * What the chat is allowed to claim about the space.
 *
 * Every notice is derived here from a roster this device verified, so these
 * tests are about restraint as much as detection: a device with nothing to
 * compare against must stay silent, and the same change seen three times must
 * still be one line in the thread.
 *
 * A fresh IndexedDB and module registry per test, because both the database
 * handle and the signals are module state.
 */

type Events = typeof import("./events");
type Crypto = typeof import("../crypto/crypto");

let events: Events;
let identity: typeof import("../crypto/identity");
let cryptoModule: Crypto;
let groupKey: CryptoKey;

const GROUP = "group-1";

async function device(id: string, name: string, publicKey: string): Promise<DeviceInfo> {
  const encrypted = await cryptoModule.encryptName(groupKey, name, id);
  return {
    id,
    publicKey,
    signingPublicKey: null,
    encryptedName: encrypted.ciphertext,
    nameIv: encrypted.iv,
    createdAt: 1,
    role: "member",
    attestation: null,
    keyEpoch: 1,
    nameKeyEpoch: 1,
  };
}

beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory();
  vi.resetModules();

  const store = await import("../db/store");
  store.setActiveSpace("space-1");
  cryptoModule = await import("../crypto/crypto");
  identity = await import("../crypto/identity");
  const keyring = await import("../crypto/keyring");
  const session = await import("./session");
  groupKey = await cryptoModule.generateGroupKey();
  session.keyring.value = keyring.createKeyring(groupKey);
  session.session.value = {
    groupId: GROUP,
    deviceId: "device-a",
    deviceName: "Laptop",
    deviceAuthToken: "token",
  };
  events = await import("./events");
});

describe("space notices", () => {
  it("says nothing on a device that has no roster to compare against", async () => {
    // A device mid-pairing, or one from before identities were tracked. The
    // alternative is announcing every device in the space as a new arrival.
    await events.reconcileRoster(
      [await device("device-a", "Laptop", "key-a"), await device("device-b", "iPhone", "key-b")],
      GROUP,
    );

    expect(events.spaceEvents.value).toEqual([]);
  });

  it("reports a device that joined, by name", async () => {
    await identity.pinScannedDevice({ deviceId: "device-a", publicKey: "key-a" });

    await events.reconcileRoster(
      [await device("device-a", "Laptop", "key-a"), await device("device-b", "iPhone", "key-b")],
      GROUP,
    );

    expect(events.spaceEvents.value).toMatchObject([
      { kind: "device-added", deviceId: "device-b", deviceName: "iPhone", trust: "tofu" },
    ]);
  });

  it("reports a revocation under the name it last saw, which the roster no longer carries", async () => {
    await identity.pinScannedDevice({ deviceId: "device-a", publicKey: "key-a" });
    const roster = [
      await device("device-a", "Laptop", "key-a"),
      await device("device-b", "iPhone", "key-b"),
    ];
    await events.reconcileRoster(roster, GROUP);

    await events.reconcileRoster([roster[0]!], GROUP);

    expect(events.spaceEvents.value.at(-1)).toMatchObject({
      kind: "device-removed",
      deviceId: "device-b",
      deviceName: "iPhone",
    });
  });

  it("never reports this device's own removal: being thrown out is said elsewhere", async () => {
    await identity.pinScannedDevice({ deviceId: "device-a", publicKey: "key-a" });
    await identity.pinScannedDevice({ deviceId: "device-b", publicKey: "key-b" });

    await events.reconcileRoster([await device("device-b", "iPhone", "key-b")], GROUP);

    expect(events.spaceEvents.value).toEqual([]);
  });

  it("flags a device whose published key no longer matches the one we pinned", async () => {
    await identity.pinScannedDevice({ deviceId: "device-a", publicKey: "key-a" });
    await identity.pinScannedDevice({ deviceId: "device-b", publicKey: "key-b" });

    await events.reconcileRoster(
      [
        await device("device-a", "Laptop", "key-a"),
        await device("device-b", "iPhone", "swapped-key-b"),
      ],
      GROUP,
    );

    expect(events.spaceEvents.value).toMatchObject([
      { kind: "device-key-changed", deviceId: "device-b", deviceName: "iPhone" },
    ]);
  });

  it("records one notice however many times the same roster is read", async () => {
    await identity.pinScannedDevice({ deviceId: "device-a", publicKey: "key-a" });
    const roster = [
      await device("device-a", "Laptop", "key-a"),
      await device("device-b", "iPhone", "key-b"),
    ];

    await events.reconcileRoster(roster, GROUP);
    await events.reconcileRoster(roster, GROUP);
    await events.reconcileRoster(roster, GROUP);

    expect(events.spaceEvents.value).toHaveLength(1);
  });

  it("keeps a device added here as a scanned join, which the roster diff would miss", async () => {
    // Pairing pins the scanned keys, so by the time the roster is fetched the
    // device is no longer new to us — the notice has to come from the pairing.
    await events.noteDeviceAdded({
      deviceId: "device-b",
      publicKey: "key-b",
      name: "iPhone",
      trust: "scanned",
      byMe: true,
    });

    expect(events.spaceEvents.value).toMatchObject([
      { kind: "device-added", deviceId: "device-b", trust: "scanned", byMe: true },
    ]);
  });

  it("survives a reload, oldest first", async () => {
    await events.noteDeviceAdded({
      deviceId: "device-b",
      publicKey: "key-b",
      name: "iPhone",
      trust: "scanned",
      byMe: true,
    });
    await events.noteKeyRotated(2);

    events.spaceEvents.value = [];
    await events.loadSpaceEvents();

    expect(events.spaceEvents.value.map((event) => event.kind)).toEqual([
      "device-added",
      "key-rotated",
    ]);
  });
});

describe("the event store", () => {
  it("keeps one row when the same observation is written twice at once", async () => {
    // Two roster reads can be in flight together, and both would pass a check
    // that has to await its own answer.
    const store = await import("../db/store");
    const event = {
      id: "added:device-b:key-b",
      kind: "device-added" as const,
      createdAt: 1,
      deviceId: "device-b",
    };

    const written = await Promise.all([store.putEvent(event), store.putEvent(event)]);

    expect(written.filter(Boolean)).toHaveLength(1);
    expect(await store.allEvents()).toHaveLength(1);
  });
});
