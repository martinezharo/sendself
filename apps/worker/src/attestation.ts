import type { DeviceAttestation } from "@sendself/shared";
import { ApiError } from "./errors";
import { requireId, requireInt, requireString } from "./http";

/** Base64url SPKI keys and signatures are short; these caps are generous. */
const MAX_PUBLIC_KEY = 2048;
const MAX_SIGNATURE = 512;

/**
 * Validate an introducer's attestation before storing it.
 *
 * The server deliberately does **not** verify the signature: it has no trusted
 * key to verify it against, and a server that could be trusted to do so is
 * exactly what this feature refuses to assume. Verification happens on every
 * client, against a signing key it already trusts. What happens here is only
 * shape and size validation, plus binding the attestation to the device it is
 * being stored for — a blob that vouches for a *different* device would be
 * useless at best and confusing at worst.
 */
export function optionalAttestation(
  value: unknown,
  field: string,
  expected: { groupId: string; deviceId: string; publicKey: string; signingPublicKey?: string },
): DeviceAttestation | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object") {
    throw new ApiError("bad_request", `Missing or invalid field: ${field}`);
  }
  const raw = value as Record<string, unknown>;

  const attestation: DeviceAttestation = {
    groupId: requireId(raw.groupId, `${field}.groupId`),
    deviceId: requireId(raw.deviceId, `${field}.deviceId`),
    publicKey: requireString(raw.publicKey, `${field}.publicKey`, MAX_PUBLIC_KEY),
    signingPublicKey: requireString(
      raw.signingPublicKey,
      `${field}.signingPublicKey`,
      MAX_PUBLIC_KEY,
    ),
    signerDeviceId: requireId(raw.signerDeviceId, `${field}.signerDeviceId`),
    issuedAt: requireInt(raw.issuedAt, `${field}.issuedAt`, 0, Number.MAX_SAFE_INTEGER),
    signature: requireString(raw.signature, `${field}.signature`, MAX_SIGNATURE),
  };

  if (
    attestation.groupId !== expected.groupId ||
    attestation.deviceId !== expected.deviceId ||
    attestation.publicKey !== expected.publicKey ||
    (expected.signingPublicKey !== undefined &&
      attestation.signingPublicKey !== expected.signingPublicKey)
  ) {
    throw new ApiError("bad_request", `${field} does not describe the device being registered`);
  }

  return attestation;
}

/** Parse an attestation column back into the DTO, tolerating a corrupt row. */
export function parseAttestation(stored: string | null): DeviceAttestation | null {
  if (!stored) return null;
  try {
    return JSON.parse(stored) as DeviceAttestation;
  } catch {
    return null;
  }
}
