import type { DeviceAttestation } from "@sendself/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => new Map<string, unknown>());

vi.mock("../db/store", () => ({
  META_DEVICE_IDENTITIES: "deviceIdentities",
  META_DEVICE_PINS: "devicePins",
  metaGet: async (key: string) => store.get(key),
  metaSet: async (key: string, value: unknown) => {
    store.set(key, value);
  },
}));

import {
  exportSigningPublicKey,
  generateSigningKeyPair,
  signStatement,
  verifyStatement,
} from "./crypto";
import {
  type DeviceIdentities,
  createAttestation,
  identityBundles,
  loadIdentities,
  pinScannedDevice,
  reconcileDevices,
  seedInheritedIdentities,
  verifyDeviceSignature,
} from "./identity";

const GROUP = "group-1";

/** A device with a real signing keypair, so signatures actually have to check out. */
async function device(id: string, publicKey = `ecdh-${id}`) {
  const pair = await generateSigningKeyPair();
  return {
    id,
    publicKey,
    signingPublicKey: await exportSigningPublicKey(pair.publicKey),
    privateKey: pair.privateKey,
  };
}

type TestDevice = Awaited<ReturnType<typeof device>>;

function attest(signer: TestDevice, subject: TestDevice): Promise<DeviceAttestation> {
  return createAttestation(signer.privateKey, {
    groupId: GROUP,
    deviceId: subject.id,
    publicKey: subject.publicKey,
    signingPublicKey: subject.signingPublicKey,
    signerDeviceId: signer.id,
    issuedAt: 1,
  });
}

describe("device identities", () => {
  beforeEach(() => store.clear());

  it("adopts a device it has never seen on first sight", async () => {
    const phone = await device("phone");

    const { changed } = await reconcileDevices([phone], GROUP);

    expect(changed).toEqual([]);
    expect((await loadIdentities()).phone).toMatchObject({
      publicKey: "ecdh-phone",
      trust: "tofu",
    });
  });

  it("reports a key that changed underneath us", async () => {
    const phone = await device("phone");
    await pinScannedDevice({ deviceId: "phone", publicKey: "ecdh-phone" });

    const { changed } = await reconcileDevices([{ ...phone, publicKey: "swapped" }], GROUP);

    // This is what stops a rotation from wrapping the new GroupKey for whoever
    // swapped the key.
    expect(changed).toEqual(["phone"]);
    expect((await loadIdentities()).phone?.publicKey).toBe("ecdh-phone");
  });

  it("never replaces a signing key it already holds", async () => {
    const phone = await device("phone");
    const impostor = await device("phone");
    await pinScannedDevice({
      deviceId: "phone",
      publicKey: phone.publicKey,
      signingPublicKey: phone.signingPublicKey,
    });

    const { changed } = await reconcileDevices(
      [{ ...phone, signingPublicKey: impostor.signingPublicKey }],
      GROUP,
    );

    expect(changed).toEqual(["phone"]);
    expect((await loadIdentities()).phone?.signingPublicKey).toBe(phone.signingPublicKey);
  });

  it("verifies a newcomer attested by a device we already trust", async () => {
    const owner = await device("owner");
    const laptop = await device("laptop");
    await pinScannedDevice({
      deviceId: owner.id,
      publicKey: owner.publicKey,
      signingPublicKey: owner.signingPublicKey,
    });

    await reconcileDevices([owner, { ...laptop, attestation: await attest(owner, laptop) }], GROUP);

    // Attested rather than trusted-on-first-sight: this is the whole point —
    // the server never got to introduce a device of its own.
    expect((await loadIdentities()).laptop?.trust).toBe("attested");
  });

  it("resolves a chain introduced in a single roster", async () => {
    const owner = await device("owner");
    const laptop = await device("laptop");
    const tablet = await device("tablet");
    await pinScannedDevice({
      deviceId: owner.id,
      publicKey: owner.publicKey,
      signingPublicKey: owner.signingPublicKey,
    });

    // tablet is vouched for by laptop, which this device is also meeting now.
    await reconcileDevices(
      [
        owner,
        { ...tablet, attestation: await attest(laptop, tablet) },
        { ...laptop, attestation: await attest(owner, laptop) },
      ],
      GROUP,
    );

    const identities = await loadIdentities();
    expect(identities.laptop?.trust).toBe("attested");
    expect(identities.tablet?.trust).toBe("attested");
  });

  it("falls back to first sight when an attestation does not check out", async () => {
    const owner = await device("owner");
    const laptop = await device("laptop");
    const forger = await device("forger");
    await pinScannedDevice({
      deviceId: owner.id,
      publicKey: owner.publicKey,
      signingPublicKey: owner.signingPublicKey,
    });

    // Signed by someone else, but claiming to come from the owner.
    const forged = { ...(await attest(forger, laptop)), signerDeviceId: owner.id };
    await reconcileDevices([owner, { ...laptop, attestation: forged }], GROUP);

    // Adopted (we can't tell a bad introducer from an unknown one), but it
    // earns none of the trust a real attestation would.
    expect((await loadIdentities()).laptop?.trust).toBe("tofu");
  });

  it("does not accept an attestation from another space", async () => {
    const owner = await device("owner");
    const laptop = await device("laptop");
    await pinScannedDevice({
      deviceId: owner.id,
      publicKey: owner.publicKey,
      signingPublicKey: owner.signingPublicKey,
    });

    const attestation = await attest(owner, laptop);
    await reconcileDevices([owner, { ...laptop, attestation }], "another-group");

    expect((await loadIdentities()).laptop?.trust).toBe("tofu");
  });

  it("forgets devices that left, so a re-paired id is not a false alarm", async () => {
    await pinScannedDevice({ deviceId: "phone", publicKey: "ecdh-phone" });

    await reconcileDevices([{ id: "laptop", publicKey: "ecdh-laptop" }], GROUP);

    expect(Object.keys(await loadIdentities())).toEqual(["laptop"]);
  });

  it("upgrades pre-signing pins instead of losing them", async () => {
    store.set("devicePins", { phone: "ecdh-phone" });

    const identities = await loadIdentities();

    expect(identities.phone).toEqual({ publicKey: "ecdh-phone", trust: "tofu" });
  });

  it("hands its verified view to a device it links", async () => {
    const phone = await device("phone");
    await pinScannedDevice({
      deviceId: phone.id,
      publicKey: phone.publicKey,
      signingPublicKey: phone.signingPublicKey,
    });

    expect(await identityBundles()).toEqual([
      { deviceId: "phone", publicKey: phone.publicKey, signingPublicKey: phone.signingPublicKey },
    ]);
  });

  it("keeps a scanned key when an inherited roster disagrees", async () => {
    await pinScannedDevice({ deviceId: "phone", publicKey: "scanned" });

    await seedInheritedIdentities([{ deviceId: "phone", publicKey: "inherited" }]);

    expect((await loadIdentities()).phone).toEqual({ publicKey: "scanned", trust: "scanned" });
  });
});

describe("message signature verdicts", () => {
  it("accepts a signature from the device we hold the key for", async () => {
    const phone = await device("phone");
    const identities: DeviceIdentities = {
      phone: {
        publicKey: phone.publicKey,
        signingPublicKey: phone.signingPublicKey,
        trust: "scanned",
      },
    };
    const signature = await signStatement(phone.privateKey, "statement");

    expect(await verifyDeviceSignature(identities, "phone", "statement", signature)).toBe(
      "verified",
    );
  });

  it("rejects a signature over a different statement", async () => {
    const phone = await device("phone");
    const identities: DeviceIdentities = {
      phone: {
        publicKey: phone.publicKey,
        signingPublicKey: phone.signingPublicKey,
        trust: "scanned",
      },
    };
    const signature = await signStatement(phone.privateKey, "statement");

    expect(await verifyDeviceSignature(identities, "phone", "tampered", signature)).toBe("invalid");
  });

  it("treats a stripped signature as invalid, not as a legacy sender", async () => {
    const phone = await device("phone");
    const identities: DeviceIdentities = {
      phone: {
        publicKey: phone.publicKey,
        signingPublicKey: phone.signingPublicKey,
        trust: "scanned",
      },
    };

    // Otherwise a server could downgrade every message by dropping signatures.
    expect(await verifyDeviceSignature(identities, "phone", "statement", null)).toBe("invalid");
  });

  it("stays silent about a device that never published a signing key", async () => {
    const identities: DeviceIdentities = { phone: { publicKey: "ecdh-phone", trust: "tofu" } };

    expect(await verifyDeviceSignature(identities, "phone", "statement", null)).toBe("unverified");
  });
});

describe("statement signing", () => {
  it("round-trips and rejects a tampered statement", async () => {
    const pair = await generateSigningKeyPair();
    const signature = await signStatement(pair.privateKey, "hello");

    expect(await verifyStatement(pair.publicKey, "hello", signature)).toBe(true);
    expect(await verifyStatement(pair.publicKey, "hello!", signature)).toBe(false);
    expect(await verifyStatement(pair.publicKey, "hello", "not-a-signature")).toBe(false);
  });
});
