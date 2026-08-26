import type { DeviceAttestation } from "@sendself/shared";
import { describe, expect, it } from "vitest";
import { optionalAttestation, parseAttestation } from "./attestation";

const expected = {
  groupId: "group-1",
  deviceId: "device-2",
  publicKey: "ecdh-public-key",
  signingPublicKey: "ecdsa-public-key",
};

function attestation(overrides: Partial<DeviceAttestation> = {}): DeviceAttestation {
  return {
    ...expected,
    signerDeviceId: "device-1",
    issuedAt: 1_700_000_000_000,
    signature: "sig",
    ...overrides,
  };
}

describe("optionalAttestation", () => {
  it("returns undefined when absent", () => {
    expect(optionalAttestation(undefined, "attestation", expected)).toBeUndefined();
    expect(optionalAttestation(null, "attestation", expected)).toBeUndefined();
  });

  it("accepts a well-formed attestation describing the expected device", () => {
    const value = attestation();

    expect(optionalAttestation(value, "attestation", expected)).toEqual(value);
  });

  it("does not verify the signature, which is deliberately the clients' job", () => {
    // The server has no trusted key to check it against — assuming it did is
    // exactly what the attested roster refuses to do. Shape only.
    const value = attestation({ signature: "obviously-not-a-real-signature" });

    expect(optionalAttestation(value, "attestation", expected)).toEqual(value);
  });

  it.each([
    ["another group", { groupId: "group-9" }],
    ["another device", { deviceId: "device-9" }],
    ["a different ECDH key", { publicKey: "swapped" }],
    ["a different signing key", { signingPublicKey: "swapped" }],
  ])("rejects an attestation that vouches for %s", (_label, overrides) => {
    expect(() => optionalAttestation(attestation(overrides), "attestation", expected)).toThrow(
      /does not describe the device being registered/,
    );
  });

  it("skips the signing-key check when the caller has no key to compare against", () => {
    const { signingPublicKey: _ignored, ...withoutSigningKey } = expected;
    const value = attestation({ signingPublicKey: "anything" });

    expect(optionalAttestation(value, "attestation", withoutSigningKey)).toEqual(value);
  });

  it.each([
    ["a non-object", "just a string"],
    ["a missing signature", { ...attestation(), signature: undefined }],
    ["a missing signer", { ...attestation(), signerDeviceId: undefined }],
    ["a non-integer issuedAt", { ...attestation(), issuedAt: "yesterday" }],
    ["a signer id with unsafe characters", { ...attestation(), signerDeviceId: "../etc" }],
  ])("rejects %s as bad_request", (_label, value) => {
    expect(() => optionalAttestation(value, "attestation", expected)).toThrow();
  });

  it("rejects an oversized public key rather than storing it", () => {
    const value = attestation({ publicKey: "a".repeat(4096) });

    expect(() =>
      optionalAttestation(value, "attestation", { ...expected, publicKey: value.publicKey }),
    ).toThrow();
  });
});

describe("parseAttestation", () => {
  it("round-trips what optionalAttestation validated", () => {
    const value = attestation();

    expect(parseAttestation(JSON.stringify(value))).toEqual(value);
  });

  it("returns null for an absent column", () => {
    expect(parseAttestation(null)).toBeNull();
    expect(parseAttestation("")).toBeNull();
  });

  it("returns null for a corrupt row instead of throwing", () => {
    // A device listing must keep working even if one row is unreadable: the
    // caller renders it as unattested rather than failing the whole request.
    expect(parseAttestation("{not json")).toBeNull();
  });
});
