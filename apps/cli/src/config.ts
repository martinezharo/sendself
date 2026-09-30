/**
 * Where the CLI keeps its identity: one JSON file per linked device.
 *
 * The file holds the device's private keys, its bearer token and every
 * GroupKey epoch it has been handed, so it is as sensitive as an unlocked
 * phone in the space. It is written owner-only (0600, in a 0700 directory) and
 * replaced atomically, so a crash mid-write can never leave half a key behind.
 * There is no passphrase: the CLI exists to run unattended, and whoever can
 * read this file as its owner can already read whatever the agents send.
 */

import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  type SerializedKeyPair,
  exportGroupKey,
  importDeviceKeyPair,
  importGroupKey,
  importSigningKeyPair,
  serializeKeyPair,
} from "@sendself/client/crypto";
import { type Keyring, createKeyring, withEpoch } from "@sendself/client/keyring";
import { SERVICE_ORIGIN } from "@sendself/shared";

/** The service a device links to unless told otherwise. */
export const DEFAULT_SERVER = SERVICE_ORIGIN;

/** A linked device, ready to use. */
export interface Device {
  /** Origin of the SendSelf deployment, e.g. `https://sendself.4oli.com`. */
  server: string;
  groupId: string;
  deviceId: string;
  deviceName: string;
  /** The space's name when this device was linked, if it had one. */
  spaceName?: string;
  token: string;
  keyPair: CryptoKeyPair;
  signingKeyPair: CryptoKeyPair;
  keyring: Keyring;
}

/** The on-disk form of `Device`. */
interface StoredDevice {
  v: 1;
  server: string;
  groupId: string;
  deviceId: string;
  deviceName: string;
  spaceName?: string;
  token: string;
  keyPair: SerializedKeyPair;
  signingKeyPair: SerializedKeyPair;
  /** Raw GroupKey (base64url) by epoch. */
  keys: Record<string, string>;
  currentEpoch: number;
}

/**
 * The directory holding the device file. `SENDSELF_HOME` wins, so the state can
 * live wherever the host keeps what must survive a rebuild; otherwise the XDG
 * config directory.
 */
export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.SENDSELF_HOME) return env.SENDSELF_HOME;
  return join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "sendself");
}

export function devicePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(configDir(env), "device.json");
}

export class NotLinkedError extends Error {
  constructor(path: string) {
    super(`This machine is not linked to a space yet (no ${path}). Run: sendself link`);
    this.name = "NotLinkedError";
  }
}

/** Load the linked device, or throw `NotLinkedError`. */
export async function loadDevice(path = devicePath()): Promise<Device> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new NotLinkedError(path);
    throw error;
  }
  const stored = JSON.parse(raw) as StoredDevice;
  if (stored.v !== 1) throw new Error(`Unsupported device file version in ${path}`);

  let keyring: Keyring | undefined;
  for (const [epoch, key] of Object.entries(stored.keys)) {
    const imported = await importGroupKey(key);
    keyring = keyring
      ? withEpoch(keyring, Number(epoch), imported)
      : createKeyring(imported, Number(epoch));
  }
  if (!keyring || !keyring.keys.has(stored.currentEpoch)) {
    throw new Error(`The device file ${path} has no key for its current epoch`);
  }

  return {
    server: stored.server,
    groupId: stored.groupId,
    deviceId: stored.deviceId,
    deviceName: stored.deviceName,
    ...(stored.spaceName ? { spaceName: stored.spaceName } : {}),
    token: stored.token,
    keyPair: await importDeviceKeyPair(stored.keyPair),
    signingKeyPair: await importSigningKeyPair(stored.signingKeyPair),
    keyring: { ...keyring, current: stored.currentEpoch },
  };
}

/** Whether a device file exists at `path`. */
export async function isLinked(path = devicePath()): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

/** Persist the device atomically, readable by its owner only. */
export async function saveDevice(device: Device, path = devicePath()): Promise<void> {
  const keyPair = await serializeKeyPair(device.keyPair);
  const signingKeyPair = await serializeKeyPair(device.signingKeyPair);
  if (!keyPair || !signingKeyPair) throw new Error("Device keys cannot be exported");

  const keys: Record<string, string> = {};
  for (const [epoch, key] of device.keyring.keys) keys[String(epoch)] = await exportGroupKey(key);

  const stored: StoredDevice = {
    v: 1,
    server: device.server,
    groupId: device.groupId,
    deviceId: device.deviceId,
    deviceName: device.deviceName,
    ...(device.spaceName ? { spaceName: device.spaceName } : {}),
    token: device.token,
    keyPair,
    signingKeyPair,
    keys,
    currentEpoch: device.keyring.current,
  };

  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, path);
}

/** Forget the linked device. */
export async function removeDevice(path = devicePath()): Promise<void> {
  await rm(path, { force: true });
}
