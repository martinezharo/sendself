/**
 * Turning the roster's encrypted device names into readable ones.
 *
 * A name is encrypted once, when the device joins, so it can predate the
 * current epoch by any number of rotations — decrypting one is always "find
 * the key for *its* epoch, then open it". That rule lived inside the device
 * management screen, and the chat's space notices need exactly the same thing,
 * so it lives here instead of in two places that could drift apart.
 */

import type { DeviceInfo } from "@sendself/shared";
import { type Keyring, keyForEpoch } from "./keyring";
import { decryptName } from "./crypto";

/** The parts of a roster entry a name can be recovered from. */
export type NamedDevice = Pick<DeviceInfo, "id" | "encryptedName" | "nameIv" | "nameKeyEpoch">;

/**
 * The device's name, or its id when we cannot read it.
 *
 * Falling back to the id rather than throwing is deliberate: a device that
 * joined under a key epoch this device never held is still a device in the
 * space, and refusing to list it would hide it from the very screen where it
 * could be revoked.
 */
export async function decryptDeviceName(ring: Keyring, device: NamedDevice): Promise<string> {
  const key = keyForEpoch(ring, device.nameKeyEpoch);
  if (!key || !device.encryptedName || !device.nameIv) return device.id;
  return decryptName(key, device.encryptedName, device.nameIv, device.id).catch(() => device.id);
}

/** The same, for a whole roster. */
export async function decryptDeviceNames(
  ring: Keyring,
  devices: readonly NamedDevice[],
): Promise<Map<string, string>> {
  const entries = await Promise.all(
    devices.map(
      async (device): Promise<[string, string]> => [
        device.id,
        await decryptDeviceName(ring, device),
      ],
    ),
  );
  return new Map(entries);
}
