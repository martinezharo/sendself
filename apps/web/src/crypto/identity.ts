/**
 * What this device believes about the other devices' public keys.
 *
 * The server hands out the device roster, so nothing in it can be taken at face
 * value: it decides which ECDH key a rotation wraps the new GroupKey for, and
 * which signing key a message is verified against. Getting either wrong hands
 * the space away. This module is the single answer to "which keys are really
 * theirs", and it has three sources, in decreasing order of strength:
 *
 *  - **scanned** — read out of a QR code by this very device while adding it.
 *    The server is not in that channel at all.
 *  - **inherited** — handed over inside the (E2E-encrypted) pairing package by
 *    the device that added us. We already trust it with the GroupKey.
 *  - **attested** — vouched for by a device whose signing key we already trust,
 *    which signed the newcomer's keys at the moment it scanned them. This is
 *    what extends the out-of-band guarantee to devices we never scanned
 *    ourselves, and it is why a roster entry no longer has to be believed.
 *
 * Anything left over is **tofu**: adopted on first sight because there is
 * nothing better available (a device from before attestations existed, or one
 * whose introducer had no signing key yet). It is exactly as trustworthy as the
 * old pin-on-first-sight behaviour — no worse, and it disappears from a space
 * as its devices are re-linked.
 *
 * Whatever the source, a key that is already stored is never silently replaced:
 * a change is reported instead, which is what stops a rotation from wrapping
 * the GroupKey for whoever swapped a key underneath us.
 */

import type { DeviceAttestation, DeviceKeyBundle } from "@sendself/shared";
import { attestationStatement } from "@sendself/shared";
import { signal } from "@preact/signals";
import { META_DEVICE_IDENTITIES, META_DEVICE_PINS, metaGet, metaSet } from "../db/store";
import { importSigningPublicKey, signStatement, verifyStatement } from "./crypto";

/**
 * Every device id this one knows about, including itself.
 *
 * The reactive mirror of the store below, so the UI can answer "is there
 * anybody else in this space?" without a request. That question decides whether
 * actions which only make sense with peers are offered at all, and it has to be
 * answerable offline and on first paint — a roster fetch that is slow or fails
 * would otherwise make those actions flicker or disappear.
 *
 * Kept honest by `reconcileDevices`, which drops devices that left the space.
 */
export const knownDeviceIds = signal<readonly string[]>([]);

function trackKnownDevices(identities: DeviceIdentities): void {
  const next = Object.keys(identities).sort();
  const current = knownDeviceIds.value;
  // Refreshed on every sync pass; only publish a genuine change so subscribers
  // are not re-rendered for an identical roster.
  if (current.length === next.length && next.every((id, i) => current[i] === id)) return;
  knownDeviceIds.value = next;
}

/** How a device's keys reached us, weakest last. */
export type IdentityTrust = "scanned" | "inherited" | "attested" | "tofu";

export interface DeviceIdentity {
  publicKey: string;
  /** Absent for a device that has not published a signing key yet. */
  signingPublicKey?: string;
  trust: IdentityTrust;
}

export type DeviceIdentities = Record<string, DeviceIdentity>;

/** A roster entry as the server serves it (a subset of DeviceInfo). */
export interface RosterDevice {
  id: string;
  publicKey: string;
  signingPublicKey?: string | null;
  attestation?: DeviceAttestation | null;
}

export interface IdentityCheck {
  /** Devices whose published key no longer matches the one we hold. */
  changed: string[];
}

/** Imported keys are reused across messages: verification runs on every poll. */
const importedKeys = new Map<string, Promise<CryptoKey>>();

function signingKey(spki: string): Promise<CryptoKey> {
  let key = importedKeys.get(spki);
  if (!key) {
    key = importSigningPublicKey(spki);
    importedKeys.set(spki, key);
  }
  return key;
}

/**
 * Load the store, folding in a pre-signing session's plain ECDH pins. Those
 * devices become `tofu`, which is precisely what they already were.
 */
export async function loadIdentities(): Promise<DeviceIdentities> {
  const stored = await metaGet<DeviceIdentities>(META_DEVICE_IDENTITIES);
  if (stored) {
    trackKnownDevices(stored);
    return stored;
  }

  const legacy = await metaGet<Record<string, string>>(META_DEVICE_PINS);
  if (!legacy) return {};
  const upgraded: DeviceIdentities = {};
  for (const [id, publicKey] of Object.entries(legacy)) {
    upgraded[id] = { publicKey, trust: "tofu" };
  }
  await metaSet(META_DEVICE_IDENTITIES, upgraded);
  trackKnownDevices(upgraded);
  return upgraded;
}

async function saveIdentities(identities: DeviceIdentities): Promise<void> {
  await metaSet(META_DEVICE_IDENTITIES, identities);
  // Every mutation funnels through here, so this is the one place the reactive
  // mirror can be kept in step with the store.
  trackKnownDevices(identities);
}

/**
 * Record keys learned through a channel the server is not part of: the QR code
 * scanned while adding a device, or this device's own identity. Overwrites any
 * previous entry — re-pairing a device legitimately gives it new keys, and this
 * is the one moment we can be sure of them.
 */
export async function pinScannedDevice(bundle: DeviceKeyBundle): Promise<void> {
  const identities = await loadIdentities();
  identities[bundle.deviceId] = {
    publicKey: bundle.publicKey,
    ...(bundle.signingPublicKey === undefined ? {} : { signingPublicKey: bundle.signingPublicKey }),
    trust: "scanned",
  };
  await saveIdentities(identities);
}

/**
 * Adopt the roster the introducer handed over in the pairing package. It is the
 * joining device's starting point of trust: every later change to the space has
 * to be attested by someone in here (or chain back to them).
 */
export async function seedInheritedIdentities(bundles: readonly DeviceKeyBundle[]): Promise<void> {
  const identities = await loadIdentities();
  for (const bundle of bundles) {
    // Never downgrade something we scanned ourselves.
    if (identities[bundle.deviceId]?.trust === "scanned") continue;
    identities[bundle.deviceId] = {
      publicKey: bundle.publicKey,
      ...(bundle.signingPublicKey === undefined
        ? {}
        : { signingPublicKey: bundle.signingPublicKey }),
      trust: "inherited",
    };
  }
  await saveIdentities(identities);
}

/** The bundles to hand to a device we are adding, so it inherits our view. */
export async function identityBundles(): Promise<DeviceKeyBundle[]> {
  return Object.entries(await loadIdentities()).map(([deviceId, identity]) => ({
    deviceId,
    publicKey: identity.publicKey,
    ...(identity.signingPublicKey === undefined
      ? {}
      : { signingPublicKey: identity.signingPublicKey }),
  }));
}

/**
 * Vouch for the keys of a device we just scanned, so every other device can
 * verify them without ever having seen its QR code.
 */
export async function createAttestation(
  signingPrivateKey: CryptoKey,
  fields: Omit<DeviceAttestation, "signature">,
): Promise<DeviceAttestation> {
  return {
    ...fields,
    signature: await signStatement(signingPrivateKey, attestationStatement(fields)),
  };
}

/**
 * Check an introducer's attestation against a signing key we already trust.
 * The statement covers both of the attested device's keys, so a valid
 * signature is a promise about the exact roster entry in front of us.
 */
async function attestationHolds(
  attestation: DeviceAttestation,
  device: RosterDevice,
  signerSigningKey: string,
): Promise<boolean> {
  if (
    attestation.deviceId !== device.id ||
    attestation.publicKey !== device.publicKey ||
    attestation.signingPublicKey !== device.signingPublicKey
  ) {
    return false;
  }
  const { signature, ...fields } = attestation;
  return verifyStatement(
    await signingKey(signerSigningKey),
    attestationStatement(fields),
    signature,
  );
}

/**
 * Reconcile a server-provided roster with what we hold: adopt what we can
 * verify, adopt the rest on first sight, and report anything that changed
 * underneath us.
 *
 * Adoption runs to a fixpoint because a roster can introduce a chain in one
 * go (a device attested by another device we are also seeing for the first
 * time, itself attested by one we already trust).
 */
export async function reconcileDevices(
  devices: readonly RosterDevice[],
  groupId: string,
): Promise<IdentityCheck> {
  const known = await loadIdentities();
  const next: DeviceIdentities = { ...known };
  const changed: string[] = [];
  const unresolved: RosterDevice[] = [];

  for (const device of devices) {
    const existing = next[device.id];
    if (!existing) {
      unresolved.push(device);
      continue;
    }
    if (existing.publicKey !== device.publicKey) {
      changed.push(device.id);
      continue;
    }
    if (existing.signingPublicKey) {
      // A signing key we hold is never replaced from the roster, and the
      // roster simply omitting it changes nothing: verification always uses
      // what we stored, so hiding it cannot downgrade anyone to "unsigned".
      if (device.signingPublicKey && existing.signingPublicKey !== device.signingPublicKey) {
        changed.push(device.id);
      }
      continue;
    }
    // Known device, first time it publishes a signing key: same adoption rules
    // as a brand-new device, so an attested key is verified rather than trusted.
    if (device.signingPublicKey) unresolved.push(device);
  }

  let pending = unresolved;
  let progress = true;
  while (progress && pending.length > 0) {
    progress = false;
    const stillPending: RosterDevice[] = [];
    for (const device of pending) {
      const attestation = device.attestation;
      const signer = attestation ? next[attestation.signerDeviceId] : undefined;
      if (
        !attestation ||
        attestation.groupId !== groupId ||
        !signer?.signingPublicKey ||
        !device.signingPublicKey
      ) {
        stillPending.push(device);
        continue;
      }
      if (!(await attestationHolds(attestation, device, signer.signingPublicKey))) {
        // A signature that does not check out is not a reason to reject the
        // device — it may simply have been attested by a key we mistrust — but
        // it earns nothing either: it falls back to first-sight adoption.
        stillPending.push(device);
        continue;
      }
      next[device.id] = {
        publicKey: device.publicKey,
        signingPublicKey: device.signingPublicKey,
        // A chain is only ever as strong as its weakest link.
        trust: signer.trust === "tofu" ? "tofu" : "attested",
      };
      progress = true;
    }
    pending = stillPending;
  }

  for (const device of pending) {
    next[device.id] = {
      publicKey: device.publicKey,
      ...(device.signingPublicKey ? { signingPublicKey: device.signingPublicKey } : {}),
      trust: next[device.id]?.trust ?? "tofu",
    };
  }

  // Drop devices that left the space, so an id that is paired again later
  // starts fresh instead of tripping the check with its new keypair.
  const active = new Set(devices.map((d) => d.id));
  for (const id of Object.keys(next)) {
    if (!active.has(id)) delete next[id];
  }

  await saveIdentities(next);
  return { changed };
}

/**
 * Verify a signature made by `deviceId` over `statement`.
 *
 * Three answers, and the difference matters: `verified` (it is really them),
 * `unverified` (we hold no signing key for them — a device that predates
 * signing, nothing to report to the user) and `invalid` (we hold their key and
 * the signature is missing or wrong, which is the case worth shouting about).
 */
export type SignatureVerdict = "verified" | "unverified" | "invalid";

export async function verifyDeviceSignature(
  identities: DeviceIdentities,
  deviceId: string,
  statement: string,
  signature: string | null | undefined,
): Promise<SignatureVerdict> {
  const identity = identities[deviceId];
  if (!identity?.signingPublicKey) return "unverified";
  // The device published a signing key, so everything from it must be signed:
  // an unsigned message is a stripped signature, not a legacy sender.
  if (!signature) return "invalid";
  const ok = await verifyStatement(
    await signingKey(identity.signingPublicKey),
    statement,
    signature,
  );
  return ok ? "verified" : "invalid";
}
