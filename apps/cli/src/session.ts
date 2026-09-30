/**
 * What every command that talks to the space needs: an API client for the
 * device's server, and a keyring that has caught up with any key rotation.
 */

import { type Api, createApi, isAuthFailure } from "@sendself/client/api";
import { unwrapRotatedKey } from "@sendself/client/crypto";
import { withEpoch } from "@sendself/client/keyring";
import { type Device, saveDevice } from "./config";

export function apiFor(server: string): Api {
  return createApi({ baseUrl: `${server.replace(/\/+$/, "")}/api` });
}

/** The server no longer accepts this device's credentials. */
export class DeviceUnlinkedError extends Error {
  constructor() {
    super(
      "This device was revoked or its link is no longer valid. Link it again with: sendself link --force",
    );
    this.name = "DeviceUnlinkedError";
  }
}

/** Turn a dead-session API error into one that says what to do about it. */
export function explainAuthFailure(error: unknown): unknown {
  return isAuthFailure(error) ? new DeviceUnlinkedError() : error;
}

export interface KeySync {
  device: Device;
  /** The space's current key epoch, as the server sees it. */
  groupKeyEpoch: number;
}

/**
 * Adopt every rotated GroupKey the server holds for this device, persist them,
 * then ack — in that order, because the ack is what makes the server drop the
 * blob, and it must never happen for a key that was not stored.
 *
 * A send-only device never rotates keys itself: rotating means wrapping the new
 * key for every device in the roster, which only a device that verifies that
 * roster should do. Its readers finish any rotation the space owes.
 */
export async function syncKeys(device: Device, api: Api, devicePath?: string): Promise<KeySync> {
  const auth = { token: device.token };
  let pending: Awaited<ReturnType<Api["pendingMessages"]>>;
  try {
    pending = await api.pendingMessages(auth);
  } catch (error) {
    throw explainAuthFailure(error);
  }

  let keyring = device.keyring;
  let highest = 0;
  for (const delivery of [...pending.keys].sort((a, b) => a.epoch - b.epoch)) {
    if (!keyring.keys.has(delivery.epoch)) {
      keyring = withEpoch(
        keyring,
        delivery.epoch,
        await unwrapRotatedKey(
          device.keyPair.privateKey,
          delivery,
          device.groupId,
          device.deviceId,
        ),
      );
    }
    highest = Math.max(highest, delivery.epoch);
  }

  let synced = device;
  if (keyring !== device.keyring) {
    synced = { ...device, keyring };
    await saveDevice(synced, devicePath);
  }
  if (highest > 0) await api.ackKey(highest, auth);
  return { device: synced, groupKeyEpoch: pending.keyEpoch };
}
