import type { SpaceNameRecord } from "@sendself/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SpaceRecord } from "../db/spaces";

const KEYS = new Map<number, CryptoKey>([
  [1, { epoch: 1 } as unknown as CryptoKey],
  [2, { epoch: 2 } as unknown as CryptoKey],
]);

const state = vi.hoisted(() => ({
  /** Stands in for the reactive `activeSpace` signal: the code only reads `.value`. */
  activeSpace: { value: null as SpaceRecord | null },
  session: { value: { groupId: "group", deviceId: "device" } as { groupId: string } | null },
  keyring: { value: null as { current: number; keys: Map<number, CryptoKey> } | null },
  applySpaceRecord: vi.fn(),
  updateSpaceName: vi.fn(),
  renameSpace: vi.fn(),
  adoptSpaceName: vi.fn(),
  markSpaceNamePublished: vi.fn(),
}));

vi.mock("../api/client", () => ({
  api: { updateSpaceName: state.updateSpaceName },
}));

// `enc(name)` stands for the ciphertext, so a test can read what was published
// and a decrypt is just the inverse. `enc(unreadable)` fails to open, like a
// blob written under a key this device never held.
vi.mock("../crypto/crypto", () => ({
  encryptText: async (_key: CryptoKey, text: string) => ({
    ciphertext: `enc(${text})`,
    iv: "iv",
  }),
  decryptText: async (_key: CryptoKey, ciphertext: string) => {
    const name = /^enc\((.*)\)$/.exec(ciphertext)?.[1];
    if (name === undefined || name === "unreadable") throw new Error("bad ciphertext");
    return name;
  },
}));

vi.mock("../db/spaces", () => ({
  renameSpace: state.renameSpace,
  adoptSpaceName: state.adoptSpaceName,
  markSpaceNamePublished: state.markSpaceNamePublished,
}));

vi.mock("../state/session", () => ({
  session: state.session,
  keyring: state.keyring,
  authHeaders: () => ({ token: "token" }),
}));

vi.mock("../state/spaces", () => ({
  activeSpace: state.activeSpace,
  applySpaceRecord: state.applySpaceRecord,
}));

const { renameActiveSpace, syncSpaceName } = await import("./spaceName");

function space(overrides: Partial<SpaceRecord> = {}): SpaceRecord {
  return {
    id: "space-1",
    name: "Home",
    createdAt: 1,
    nameUpdatedAt: 0,
    namePending: false,
    ...overrides,
  };
}

function record(overrides: Partial<SpaceNameRecord> = {}): SpaceNameRecord {
  return {
    encryptedName: "enc(Office)",
    nameIv: "iv",
    nameKeyEpoch: 2,
    updatedAt: 500,
    ...overrides,
  };
}

const ring = (current = 2): { current: number; keys: Map<number, CryptoKey> } => ({
  current,
  keys: KEYS,
});

beforeEach(() => {
  vi.clearAllMocks();
  state.activeSpace.value = space();
  state.session.value = { groupId: "group" };
  state.keyring.value = ring();
  state.updateSpaceName.mockResolvedValue({ ok: true, updatedAt: 900 });
  state.renameSpace.mockImplementation(async (id: string, name: string) =>
    space({ id, name: name.trim() || null, namePending: true }),
  );
  state.adoptSpaceName.mockImplementation(async (id: string, name: string | null, at: number) =>
    space({ id, name, nameUpdatedAt: at }),
  );
  state.markSpaceNamePublished.mockImplementation(async (id: string) => space({ id }));
});

describe("renameActiveSpace", () => {
  it("shows the new name here and publishes it for every other device", async () => {
    await renameActiveSpace("Office");

    expect(state.renameSpace).toHaveBeenCalledWith("space-1", "Office");
    expect(state.applySpaceRecord).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Office", namePending: true }),
    );
    expect(state.updateSpaceName).toHaveBeenCalledWith(
      { encryptedName: "enc(Office)", nameIv: "iv", nameKeyEpoch: 2 },
      { token: "token" },
    );
    expect(state.markSpaceNamePublished).toHaveBeenCalledWith("space-1", "Office", 900);
  });

  it("publishes a cleared name as an absent one rather than as empty ciphertext", async () => {
    state.renameSpace.mockResolvedValue(space({ name: null, namePending: true }));

    await renameActiveSpace("   ");

    expect(state.updateSpaceName).toHaveBeenCalledWith(
      { encryptedName: null, nameIv: null, nameKeyEpoch: 2 },
      { token: "token" },
    );
  });

  it("keeps the rename locally when it cannot be published, and owes it", async () => {
    state.updateSpaceName.mockRejectedValue(new Error("offline"));

    await expect(renameActiveSpace("Office")).resolves.toBeUndefined();

    expect(state.applySpaceRecord).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Office", namePending: true }),
    );
    expect(state.markSpaceNamePublished).not.toHaveBeenCalled();
  });
});

describe("syncSpaceName", () => {
  it("takes on a name published after the one this device holds", async () => {
    state.activeSpace.value = space({ name: "Home", nameUpdatedAt: 100 });

    await syncSpaceName(record({ updatedAt: 500 }), ring());

    expect(state.adoptSpaceName).toHaveBeenCalledWith("space-1", "Office", 500);
    expect(state.applySpaceRecord).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Office", nameUpdatedAt: 500 }),
    );
  });

  it("ignores a name that is not newer than the one already adopted", async () => {
    state.activeSpace.value = space({ nameUpdatedAt: 500 });

    await syncSpaceName(record({ updatedAt: 500 }), ring());

    expect(state.adoptSpaceName).not.toHaveBeenCalled();
    expect(state.updateSpaceName).not.toHaveBeenCalled();
  });

  it("clears the local name when the space's was cleared", async () => {
    state.activeSpace.value = space({ name: "Home", nameUpdatedAt: 100 });

    await syncSpaceName(record({ encryptedName: null, nameIv: null, updatedAt: 500 }), ring());

    expect(state.adoptSpaceName).toHaveBeenCalledWith("space-1", null, 500);
  });

  it("keeps the local name when the published one cannot be decrypted here", async () => {
    state.activeSpace.value = space({ name: "Home", nameUpdatedAt: 100 });

    await syncSpaceName(record({ encryptedName: "enc(unreadable)" }), ring());

    expect(state.adoptSpaceName).not.toHaveBeenCalled();
    expect(state.applySpaceRecord).not.toHaveBeenCalled();
  });

  it("keeps the local name when it was sealed under an epoch this device never held", async () => {
    state.activeSpace.value = space({ name: "Home", nameUpdatedAt: 100 });

    await syncSpaceName(record({ nameKeyEpoch: 7 }), ring());

    expect(state.adoptSpaceName).not.toHaveBeenCalled();
  });

  it("sends the rename that never made it out, before looking at anything else", async () => {
    state.activeSpace.value = space({ name: "Office", namePending: true, nameUpdatedAt: 100 });

    await syncSpaceName(record({ encryptedName: "enc(Stale)", updatedAt: 500 }), ring());

    expect(state.updateSpaceName).toHaveBeenCalledWith(
      { encryptedName: "enc(Office)", nameIv: "iv", nameKeyEpoch: 2 },
      { token: "token" },
    );
    expect(state.adoptSpaceName).not.toHaveBeenCalled();
  });

  it("publishes even when the space has no name of its own yet", async () => {
    state.activeSpace.value = space({ name: "Office", namePending: true });

    await syncSpaceName(null, ring());

    expect(state.updateSpaceName).toHaveBeenCalled();
  });

  it("re-seals a name left behind by a key rotation, so a new device can read it", async () => {
    state.activeSpace.value = space({ name: "Office", nameUpdatedAt: 500 });

    await syncSpaceName(record({ nameKeyEpoch: 1, updatedAt: 500 }), ring(2));

    expect(state.updateSpaceName).toHaveBeenCalledWith(
      { encryptedName: "enc(Office)", nameIv: "iv", nameKeyEpoch: 2 },
      { token: "token" },
    );
  });

  it("never re-publishes a name it cannot read, which would clear it everywhere", async () => {
    // What a sealed registry looks like from here: the record exists, the local
    // copy of the name does not.
    state.activeSpace.value = space({ name: null, nameUpdatedAt: 500 });

    await syncSpaceName(record({ nameKeyEpoch: 1, updatedAt: 500 }), ring(2));

    expect(state.updateSpaceName).not.toHaveBeenCalled();
  });

  it("leaves a name alone while it is sealed under the current key", async () => {
    state.activeSpace.value = space({ name: "Office", nameUpdatedAt: 500 });

    await syncSpaceName(record({ nameKeyEpoch: 2, updatedAt: 500 }), ring(2));

    expect(state.updateSpaceName).not.toHaveBeenCalled();
  });

  it("does nothing when no space is open", async () => {
    state.activeSpace.value = null;

    await syncSpaceName(record(), ring());

    expect(state.adoptSpaceName).not.toHaveBeenCalled();
    expect(state.updateSpaceName).not.toHaveBeenCalled();
  });
});
