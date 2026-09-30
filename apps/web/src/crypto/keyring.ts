/**
 * The PWA's keyring (see @sendself/client/keyring), persisted in IndexedDB.
 *
 * Context-neutral (IndexedDB only, no signals/DOM) because the service worker
 * flushes the outbox with it too.
 */

import { type Keyring, createKeyring } from "@sendself/client/keyring";
import { META_GROUP_KEY, META_KEYRING, metaDelete, metaGet, metaSet } from "../db/store";

export {
  type Keyring,
  createKeyring,
  currentKey,
  keyForEpoch,
  withEpoch,
} from "@sendself/client/keyring";

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
