/**
 * The space's own timeline: devices joining, being revoked, keys rotating.
 *
 * Every notice the chat draws is derived *here*, on the device that shows it,
 * from the roster it has already verified (crypto/identity.ts). Nothing about
 * them is sent or received. That is not an implementation shortcut: a
 * server-authored "a device joined" line would be an unauthenticated string
 * injected straight into an end-to-end encrypted thread — perfect for
 * normalising a device the user never added — and a server that wanted to hide
 * one would simply omit the line. A notice that comes from this device's own
 * roster check can only say what this device verified.
 *
 * Events are therefore local, per-device and never backfilled: a device that
 * joined today has no notices from yesterday, and two devices can disagree by
 * a few seconds on when something happened. Both are the honest answer to
 * "what did *this* device see?".
 */

import { signal } from "@preact/signals";
import type { DeviceInfo } from "@sendself/shared";
import {
  type IdentityCheck,
  type IdentityTrust,
  loadIdentities,
  reconcileDevices,
} from "../crypto/identity";
import { decryptDeviceNames } from "../crypto/names";
import { allEvents, deviceNames, putDeviceName, putEvent } from "../db/store";
import type { LocalEvent } from "../types";
import { keyring, session } from "./session";

export const spaceEvents = signal<LocalEvent[]>([]);

export async function loadSpaceEvents(): Promise<void> {
  spaceEvents.value = await allEvents();
}

/**
 * The tail of a public key, as a stable discriminator inside an event id.
 *
 * The *tail*, because every P-256 SPKI shares the same DER header: the first
 * thirty-odd base64 characters of two different keys are identical, so a
 * prefix would collide for every device in the space.
 */
function keyMark(publicKey: string): string {
  return publicKey.slice(-12);
}

/**
 * Persist an observation, keeping the first one.
 *
 * Ids are deterministic (the change, not the moment it was noticed), so the
 * same roster read by three call sites in the same second is one notice. A
 * failure here is swallowed: a notice is a courtesy, and no sync pass, key
 * rotation or pairing should ever fail because one could not be written.
 */
async function record(event: LocalEvent): Promise<void> {
  try {
    if (!(await putEvent(event))) return;
    const next = [...spaceEvents.value, event].sort((a, b) => a.createdAt - b.createdAt);
    spaceEvents.value = next;
  } catch {
    /* cosmetic: never let a notice break the operation that produced it */
  }
}

/** A device this device just added by scanning its QR code, or itself on joining. */
export async function noteDeviceAdded(device: {
  deviceId: string;
  publicKey: string;
  name: string;
  trust: IdentityTrust;
  byMe?: true;
}): Promise<void> {
  await putDeviceName(device.deviceId, device.name).catch(() => {});
  await record({
    id: `added:${device.deviceId}:${keyMark(device.publicKey)}`,
    kind: "device-added",
    createdAt: Date.now(),
    deviceId: device.deviceId,
    deviceName: device.name,
    trust: device.trust,
    ...(device.byMe ? { byMe: device.byMe } : {}),
  });
}

/** A new GroupKey epoch took effect on this device — minted here or adopted. */
export async function noteKeyRotated(epoch: number): Promise<void> {
  await record({
    id: `rotated:${epoch}`,
    kind: "key-rotated",
    createdAt: Date.now(),
    epoch,
  });
}

/**
 * Reconcile the roster *and* record what changed in it.
 *
 * One entry point rather than a `reconcileDevices` call followed by a diff at
 * each of the three places that read the roster: the sync loop, the device
 * screen and a key rotation would otherwise each need their own copy of "what
 * is new here", and any of them forgetting would silently drop notices.
 */
export async function reconcileRoster(
  devices: readonly DeviceInfo[],
  groupId: string,
): Promise<IdentityCheck> {
  const before = await loadIdentities();
  const check = await reconcileDevices(devices, groupId);
  await noteRosterChange(before, devices, check.changed);
  return check;
}

async function noteRosterChange(
  before: Awaited<ReturnType<typeof loadIdentities>>,
  devices: readonly DeviceInfo[],
  changed: readonly string[],
): Promise<void> {
  const ring = keyring.value;
  const names = ring ? await decryptDeviceNames(ring, devices) : new Map<string, string>();
  // Refresh the directory first, so a device that disappears from the *next*
  // roster can still be named in its own revocation notice.
  await Promise.all([...names].map(([id, name]) => putDeviceName(id, name).catch(() => {})));

  // No baseline to diff against: this device is mid-pairing, or predates
  // identity tracking altogether. Announcing the whole space as new arrivals
  // would be worse than saying nothing.
  if (Object.keys(before).length === 0) return;

  const identities = await loadIdentities();
  for (const device of devices) {
    if (before[device.id]) continue;
    await record({
      id: `added:${device.id}:${keyMark(device.publicKey)}`,
      kind: "device-added",
      createdAt: Date.now(),
      deviceId: device.id,
      deviceName: names.get(device.id) ?? device.id,
      trust: identities[device.id]?.trust ?? "tofu",
    });
  }

  const known = await deviceNames().catch(() => new Map<string, string>());
  const present = new Set(devices.map((device) => device.id));
  const selfId = session.value?.deviceId;
  for (const [id, identity] of Object.entries(before)) {
    // This device being gone from the roster is not a line in the chat: it has
    // been thrown out of the space, which the app says far more loudly
    // elsewhere (see `handleAuthFailure`).
    if (present.has(id) || id === selfId) continue;
    await record({
      id: `removed:${id}:${keyMark(identity.publicKey)}`,
      kind: "device-removed",
      createdAt: Date.now(),
      deviceId: id,
      deviceName: known.get(id) ?? id,
    });
  }

  for (const id of changed) {
    const device = devices.find((entry) => entry.id === id);
    if (!device) continue;
    await record({
      id: `key-changed:${id}:${keyMark(device.publicKey)}`,
      kind: "device-key-changed",
      createdAt: Date.now(),
      deviceId: id,
      deviceName: names.get(id) ?? known.get(id) ?? id,
    });
  }
}
