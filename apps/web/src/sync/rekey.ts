/**
 * Client half of the GroupKey rotation protocol.
 *
 * Revoking a device only closes the API to it; it keeps whatever GroupKey it
 * already had. Rotating that key is what actually ends its access, and it is
 * done here because the server must never see a GroupKey.
 *
 * Shape of the protocol, and why it costs the user nothing:
 *  - Only the key rotates. Device tokens are untouched, so no remaining device
 *    is logged out or has to be paired again.
 *  - Old epochs are kept locally (crypto/keyring.ts), so history and in-flight
 *    content stay readable.
 *  - Each remaining device gets the new key wrapped to its own ECDH key and
 *    picks it up on its next poll, so being offline during a rotation is a
 *    non-event: the blob waits, and the server drops it on ack.
 *  - The rotation is owed by the *space*, not by whoever pressed Revoke: if
 *    that device dies mid-flight, the next device to poll finishes the job.
 */

import type { KeyWrap, PendingKeyDelivery, RotateKeyResponse } from "@sendself/shared";
import { ApiError, type Auth, api } from "../api/client";
import {
  exportGroupKey,
  generateGroupKey,
  importGroupKey,
  importPublicKey,
  rekeyContext,
  unwrapSecret,
  wrapSecret,
} from "../crypto/crypto";
import { type Keyring, saveKeyring, withEpoch } from "../crypto/keyring";
import { reconcileDevices } from "../crypto/identity";

/** Plaintext inside a rotation blob. Only the recipient device ever sees it. */
interface RekeyPayload {
  groupKey: string;
  epoch: number;
}

export interface RotationResult {
  epoch: number;
  /** How many other devices the new key was deposited for. */
  devices: number;
}

/**
 * Thrown when a device's published ECDH key no longer matches the one we
 * pinned. Wrapping the new key for it would hand the space to whoever swapped
 * it, so the rotation stops instead.
 */
export class DeviceKeyMismatchError extends Error {
  constructor() {
    super("A device's security key changed unexpectedly. Rotation stopped.");
    this.name = "DeviceKeyMismatchError";
  }
}

/**
 * Adopt every GroupKey the server is holding for this device, oldest first.
 * Returns the updated keyring (unchanged when there was nothing to adopt).
 *
 * Adopting in epoch order matters: a device that was offline across several
 * rotations needs all of them, not just the newest, to read messages that were
 * encrypted in between.
 */
export async function adoptPendingKeys(
  keyring: Keyring,
  deliveries: readonly PendingKeyDelivery[],
  privateKey: CryptoKey,
  groupId: string,
  deviceId: string,
  auth: Auth,
): Promise<Keyring> {
  if (deliveries.length === 0) return keyring;

  let updated = keyring;
  let highest = 0;
  for (const delivery of [...deliveries].sort((a, b) => a.epoch - b.epoch)) {
    if (updated.keys.has(delivery.epoch)) {
      highest = Math.max(highest, delivery.epoch);
      continue;
    }
    // The AAD binds the blob to this group, epoch and device, so a blob moved
    // from another recipient or replayed at another epoch simply fails here.
    const payload = await unwrapSecret<RekeyPayload>(
      privateKey,
      delivery.ephemeralPublicKey,
      delivery.wrappedKey,
      rekeyContext(groupId, delivery.epoch, deviceId),
    );
    updated = withEpoch(updated, delivery.epoch, await importGroupKey(payload.groupKey));
    highest = Math.max(highest, delivery.epoch);
  }

  // Persist before acking: the ack is what makes the server drop the blob, so
  // it must never happen for a key we failed to store.
  await saveKeyring(updated);
  if (highest > 0) await api.ackKey(highest, auth);
  return updated;
}

/**
 * Perform the rotation this space owes: mint a new GroupKey, wrap it for every
 * remaining device, and hand the blobs to the server in one compare-and-swap.
 *
 * Returns null when there was nothing to do — including the common race where
 * another device rotated first, in which case this device simply adopts that
 * key on its next poll.
 */
export async function rotateGroupKey(
  keyring: Keyring,
  groupId: string,
  deviceId: string,
  auth: Auth,
): Promise<{ keyring: Keyring; result: RotationResult } | null> {
  const listing = await api.listDevices(auth);
  if (!listing.rotationPending) return null;

  const { changed } = await reconcileDevices(listing.devices, groupId);
  if (changed.length > 0) throw new DeviceKeyMismatchError();

  const epoch = listing.keyEpoch + 1;
  const newKey = await generateGroupKey();
  const raw = await exportGroupKey(newKey);

  const recipients = listing.devices.filter((device) => device.id !== deviceId);
  const wraps: KeyWrap[] = await Promise.all(
    recipients.map(async (device) => {
      const payload: RekeyPayload = { groupKey: raw, epoch };
      const wrapped = await wrapSecret(
        await importPublicKey(device.publicKey),
        payload,
        rekeyContext(groupId, epoch, device.id),
      );
      return {
        deviceId: device.id,
        wrappedKey: wrapped.wrappedPackage,
        ephemeralPublicKey: wrapped.ephemeralPublicKey,
      };
    }),
  );

  let response: RotateKeyResponse;
  try {
    response = await api.rotateKey({ epoch, wraps }, auth);
  } catch (error) {
    // Another device won the race (or finished the rotation while we were
    // wrapping). Its key arrives through the normal pending-key channel, so
    // this is a no-op, not a failure the user should ever hear about.
    if (error instanceof ApiError && error.code === "conflict") return null;
    throw error;
  }

  // Only adopt once the server accepted the epoch. Adopting first would leave
  // this device encrypting with a key that lost the compare-and-swap and that
  // nobody else can read.
  const updated = withEpoch(keyring, response.epoch, newKey);
  await saveKeyring(updated);
  return { keyring: updated, result: { epoch: response.epoch, devices: response.devices } };
}
