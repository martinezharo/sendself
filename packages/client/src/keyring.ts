/**
 * A device's GroupKey history.
 *
 * Revoking a device rotates the GroupKey, so a space does not have *one* key
 * but a sequence of them identified by epoch. A device keeps every epoch it has
 * ever held: new content is encrypted with the current one, and anything older
 * — a message still in flight, an attachment queued before the rotation, the
 * whole local history — stays readable. That is what makes rotation invisible
 * to the user instead of a wipe.
 *
 * Pure data: where it is kept is up to each client (IndexedDB in the PWA, a
 * file for the CLI).
 */

import { INITIAL_KEY_EPOCH } from "@sendself/shared";

export interface Keyring {
  /** Epoch new outgoing content is encrypted with: the newest key we hold. */
  current: number;
  /** Every epoch this device has held, so old ciphertext stays readable. */
  keys: Map<number, CryptoKey>;
}

export function createKeyring(key: CryptoKey, epoch = INITIAL_KEY_EPOCH): Keyring {
  return { current: epoch, keys: new Map([[epoch, key]]) };
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
