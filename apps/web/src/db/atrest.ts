/**
 * At-rest encryption for what IndexedDB holds beyond the keys: the message
 * history and the decrypted file blobs.
 *
 * Sealing only the GroupKey would be a half-measure — the plaintext of every
 * message the device ever received sits right next to it. So when a lock is on,
 * records and blobs are encrypted in place with a *content key* derived on
 * unlock, which lives in memory only (crypto/vault.ts). The store layer
 * (db/store.ts) reads and writes through this module, so no call site has to
 * know whether the device is locked.
 *
 * Context-neutral on purpose: the service worker uses the same store to flush
 * the outbox. It simply never holds a content key, so while the device is
 * locked it reads no records and does nothing — the correct behaviour rather
 * than a limitation to work around.
 *
 * What stays in the clear, and why: a message's `id` and `createdAt`, because
 * they are the key path and the sort index that keep history loadable in order,
 * and a file's `r2Key` for the same reason. Space events (db/store.ts) follow
 * the same rule, and the device directory keeps only the device id readable —
 * the name it maps to is the user's own words and is sealed with the rest.
 * That tells someone reading the raw database *when* this device received
 * something — worth stating plainly, and far less than the messages themselves.
 */

import { base64UrlToBuf, bufToBase64Url, randomBytes } from "../crypto/crypto";

const AES = "AES-GCM";
const IV_BYTES = 12;

/**
 * The key encrypting local content: null when no lock is set (records are
 * stored in the clear, exactly as before this existed) and while locked.
 */
let contentKey: CryptoKey | null = null;
let contentLocked = false;

export function setContentKey(key: CryptoKey | null): void {
  contentKey = key;
  contentLocked = false;
}

/** Mark the device locked before dropping the in-memory content key. */
export function setContentLocked(locked: boolean): void {
  contentLocked = locked;
  if (locked) contentKey = null;
}

export function currentContentKey(): CryptoKey | null {
  return contentKey;
}

/**
 * `undefined` means "whatever this context currently holds"; `null` means
 * "explicitly none". Turning a lock on or off has to read through one key and
 * write through the other, which is the only reason this is not just a getter.
 */
export type KeyChoice = CryptoKey | null | undefined;

function resolve(key: KeyChoice): CryptoKey | null {
  return key === undefined ? contentKey : key;
}

function requireWritableKey(key: CryptoKey | null): CryptoKey | null {
  if (!key && contentLocked) throw new Error("Local content is locked");
  return key;
}

/** AES-GCM ciphertext plus its IV, both base64url. */
export interface Sealed {
  iv: string;
  ct: string;
}

function aad(context: string): Uint8Array<ArrayBuffer> {
  const encoded = new TextEncoder().encode(context);
  const out = new Uint8Array(encoded.byteLength);
  out.set(encoded);
  return out;
}

async function seal(data: BufferSource, context: string, key: CryptoKey): Promise<Sealed> {
  const iv = randomBytes(IV_BYTES);
  const ct = await crypto.subtle.encrypt(
    { name: AES, iv, additionalData: aad(context) },
    key,
    data,
  );
  return { iv: bufToBase64Url(iv), ct: bufToBase64Url(ct) };
}

function unseal(sealed: Sealed, context: string, key: CryptoKey): Promise<ArrayBuffer> {
  return crypto.subtle.decrypt(
    { name: AES, iv: base64UrlToBuf(sealed.iv), additionalData: aad(context) },
    key,
    base64UrlToBuf(sealed.ct),
  );
}

/**
 * Seal a JSON value, or null when the chosen key is "none". `context` is bound
 * as AAD, so a record cannot be transplanted onto another id.
 */
export async function sealJson(
  value: unknown,
  context: string,
  key?: KeyChoice,
): Promise<Sealed | null> {
  const chosen = requireWritableKey(resolve(key));
  if (!chosen) return null;
  return seal(new TextEncoder().encode(JSON.stringify(value)), context, chosen);
}

/** Open a sealed JSON value, or undefined when there is no key to open it with. */
export async function openJson<T>(
  sealed: Sealed,
  context: string,
  key?: KeyChoice,
): Promise<T | undefined> {
  const chosen = resolve(key);
  if (!chosen) return undefined;
  return JSON.parse(new TextDecoder().decode(await unseal(sealed, context, chosen))) as T;
}

/**
 * Seal a file's bytes. The ciphertext comes back as bytes rather than base64
 * because it goes straight back into a Blob: payloads reach 50 MB and a base64
 * detour would cost a third more memory for nothing.
 */
export async function sealBlob(
  blob: Blob,
  context: string,
  key?: KeyChoice,
): Promise<{ iv: string; ct: ArrayBuffer } | null> {
  const chosen = requireWritableKey(resolve(key));
  if (!chosen) return null;
  const iv = randomBytes(IV_BYTES);
  const ct = await crypto.subtle.encrypt(
    { name: AES, iv, additionalData: aad(context) },
    chosen,
    await blob.arrayBuffer(),
  );
  return { iv: bufToBase64Url(iv), ct };
}

/** Open a sealed file back into a Blob, or undefined when there is no key. */
export async function openBlob(
  blob: Blob,
  iv: string,
  context: string,
  mime: string,
  key?: KeyChoice,
): Promise<Blob | undefined> {
  const chosen = resolve(key);
  if (!chosen) return undefined;
  const plaintext = await crypto.subtle.decrypt(
    { name: AES, iv: base64UrlToBuf(iv), additionalData: aad(context) },
    chosen,
    await blob.arrayBuffer(),
  );
  return new Blob([plaintext], { type: mime });
}

/** AAD contexts, kept here so the store and the migration cannot disagree. */
export const messageContext = (id: string): string => `local-message:${id}`;
export const fileContext = (r2Key: string): string => `local-file:${r2Key}`;
export const eventContext = (id: string): string => `local-event:${id}`;
export const directoryContext = (deviceId: string): string => `local-device:${deviceId}`;
