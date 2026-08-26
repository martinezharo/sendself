/**
 * The device's GroupKey history.
 *
 * Revoking a device rotates the GroupKey, so a space does not have *one* key
 * but a sequence of them identified by epoch. A device keeps every epoch it has
 * ever held: new content is encrypted with the current one, and anything older
 * — a message still in flight, an attachment queued before the rotation, the
 * whole local history — stays readable. That is what makes rotation invisible
 * to the user instead of a wipe.
 *
 * Context-neutral (IndexedDB only, no signals/DOM) because the service worker
 * flushes the outbox with it too.
 */

import { INITIAL_KEY_EPOCH } from "@sendself/shared";
import { META_GROUP_KEY, META_KEYRING, metaDelete, metaGet, metaSet } from "../db/store";

export interface Keyring {
  /** Epoch new outgoing content is encrypted with: the newest key we hold. */
  current: number;
  /** Every epoch this device has held, so old ciphertext stays readable. */
  keys: Map<number, CryptoKey>;
}

export function createKeyring(key: CryptoKey, epoch = INITIAL_KEY_EPOCH): Keyring {
  return { current: epoch, keys: new Map([[epoch, key]]) };
}

/**
 * Load the keyring, upgrading a pre-rotation session in place: those devices
 * stored a single `groupKey` and the server defaults their group to epoch 1, so
 * the two line up without re-pairing or any user-visible event.
 */
export async function loadKeyring(spaceId?: string): Promise<Keyring | null> {
  const stored = await metaGet<Keyring>(META_KEYRING, spaceId);
  if (stored) return stored;

  const legacy = await metaGet<CryptoKey>(META_GROUP_KEY, spaceId);
  if (!legacy) return null;
  const keyring = createKeyring(legacy);
  await saveKeyring(keyring, spaceId);
  await metaDelete(META_GROUP_KEY, spaceId);
  return keyring;
}

export async function saveKeyring(keyring: Keyring, spaceId?: string): Promise<void> {
  await metaSet(META_KEYRING, keyring, spaceId);
}

/** The key a given epoch's ciphertext needs, or undefined if we never held it. */
export function keyForEpoch(keyring: Keyring, epoch: number): CryptoKey | undefined {
  return keyring.keys.get(epoch);
}

/** The key to encrypt new content with. */
export function currentKey(keyring: Keyring): CryptoKey {
  const key = keyring.keys.get(keyring.current);
  if (!key) throw new Error("Keyring has no key for its current epoch");
  return key;
}

/**
 * Add an epoch to the ring. Older epochs are kept; `current` only ever moves
 * forward, so an out-of-order delivery cannot make this device start encrypting
 * with a superseded key.
 */
export function withEpoch(keyring: Keyring, epoch: number, key: CryptoKey): Keyring {
  const keys = new Map(keyring.keys);
  keys.set(epoch, key);
  return { current: Math.max(keyring.current, epoch), keys };
}
