/**
 * End-to-end crypto core (Web Crypto API).
 *
 * Design:
 *  - GroupKey: AES-GCM 256. Encrypts every message/file. Created by the first
 *    device and shared to others only via the ECIES wrap below. Revoking a
 *    device rotates it, so keys are versioned by epoch and each device keeps
 *    every epoch it has held (crypto/keyring.ts) to stay able to read history.
 *  - Device keypair: ECDH P-256. The private key stays local and can be carried
 *    only in the app's encrypted vault/recovery file.
 *  - Signing keypair: ECDSA P-256, also kept local. Separate from the ECDH
 *    key on purpose — one key, one job — and used both to sign every message
 *    (so the server cannot forge who sent what) and to attest to the keys of a
 *    device this one adds (so the roster is verifiable rather than trusted).
 *  - ECIES wrap: an ephemeral ECDH key + the recipient's public key derive a
 *    one-time AES-GCM key that encrypts a JSON secret. Used for the pairing
 *    package and for handing a rotated GroupKey to each remaining device.
 *
 * The server never sees plaintext or an unwrapped GroupKey. Authenticated
 * requests carry a bearer token; only its hash is stored server-side.
 */

import type { PairingPayload } from "@sendself/shared";

const AES = "AES-GCM";
const EC = "ECDH";
const SIG = "ECDSA";
const SIG_HASH = "SHA-256";
const CURVE = "P-256";
const IV_BYTES = 12;

/**
 * Web Crypto's subtle API is intentionally unavailable on insecure origins
 * (for example, an HTTP page opened through a LAN or Tailscale IP). This app
 * cannot safely fall back to a JavaScript crypto implementation: an insecure
 * origin could also be modified in transit before that implementation runs.
 */
export class SecureContextRequiredError extends Error {
  constructor() {
    super(
      "End-to-end encryption requires a secure connection. Open SendSelf over HTTPS; HTTP only works on localhost during development.",
    );
    this.name = "SecureContextRequiredError";
  }
}

/** Fail early with a useful message instead of `undefined.generateKey`. */
export function assertWebCryptoAvailable(): void {
  const webCrypto = globalThis.crypto;
  if (
    !webCrypto ||
    typeof webCrypto.getRandomValues !== "function" ||
    !webCrypto.subtle ||
    typeof webCrypto.subtle.generateKey !== "function"
  ) {
    throw new SecureContextRequiredError();
  }
}

// ---------------------------------------------------------------------------
// Encoding helpers
// ---------------------------------------------------------------------------

export function bufToBase64Url(input: ArrayBuffer | Uint8Array): string {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlToBuf(value: string): ArrayBuffer {
  const pad = value.length % 4 === 0 ? "" : "=".repeat(4 - (value.length % 4));
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/") + pad;
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

// ---------------------------------------------------------------------------
// Randomness
// ---------------------------------------------------------------------------

export function randomBytes(length: number) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

/** 256-bit URL-safe token (group auth token). */
export function randomToken(): string {
  return bufToBase64Url(randomBytes(32));
}

/** 128-bit URL-safe id (device id, message id, pairing id, R2 key). */
export function randomId(): string {
  return bufToBase64Url(randomBytes(16));
}

function randomIv() {
  return randomBytes(IV_BYTES);
}

/**
 * Build AES-GCM "additional authenticated data". Binding a context string (e.g.
 * the message id + role) to each ciphertext means a malicious server cannot move
 * a ciphertext from one message/slot/role to another: decryption with the wrong
 * context fails. AAD is authenticated but not encrypted.
 */
function aad(context?: string): Uint8Array<ArrayBuffer> | undefined {
  if (context === undefined) return undefined;
  const bytes = new TextEncoder().encode(context);
  // Copy into a fresh ArrayBuffer-backed view (TextEncoder may return an
  // ArrayBufferLike-backed array, which doesn't satisfy BufferSource here).
  const out = new Uint8Array(bytes.byteLength);
  out.set(bytes);
  return out;
}

/** SHA-256 of a UTF-8 string as lowercase hex (matches the server). */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------------
// GroupKey (AES-GCM 256)
// ---------------------------------------------------------------------------

export function generateGroupKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: AES, length: 256 }, true, ["encrypt", "decrypt"]);
}

export async function exportGroupKey(key: CryptoKey): Promise<string> {
  return bufToBase64Url(await crypto.subtle.exportKey("raw", key));
}

export function importGroupKey(raw: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", base64UrlToBuf(raw), { name: AES }, true, [
    "encrypt",
    "decrypt",
  ]);
}

// ---------------------------------------------------------------------------
// Device keypair (ECDH P-256)
// ---------------------------------------------------------------------------

/**
 * The device's ECDH identity.
 *
 * Extractable, which was a deliberate change: a space whose devices are all
 * lost is otherwise unrecoverable, and a recovery file that cannot carry this
 * key would restore a device that can never be handed a rotated GroupKey. What
 * non-extractability bought was narrower than it looks — the GroupKey next to
 * it in the same store has to be extractable to be wrapped for other devices at
 * all, so anyone who could read this key already had everything worth reading.
 * The at-rest lock (crypto/vault.ts) is what actually closes that, and it
 * covers the whole store rather than one key.
 */
export function generateDeviceKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey({ name: EC, namedCurve: CURVE }, true, ["deriveKey"]);
}

export async function exportPublicKey(key: CryptoKey): Promise<string> {
  return bufToBase64Url(await crypto.subtle.exportKey("spki", key));
}

export function importPublicKey(spki: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "spki",
    base64UrlToBuf(spki),
    { name: EC, namedCurve: CURVE },
    true,
    [],
  );
}

// ---------------------------------------------------------------------------
// Signing keypair (ECDSA P-256)
// ---------------------------------------------------------------------------

/**
 * The device's long-term signing identity. Extractable for the same reason as
 * the ECDH key above: a restored device that cannot sign is a device whose
 * messages every peer reports as unverifiable forever.
 */
export function generateSigningKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey({ name: SIG, namedCurve: CURVE }, true, ["sign", "verify"]);
}

export async function exportSigningPublicKey(key: CryptoKey): Promise<string> {
  return bufToBase64Url(await crypto.subtle.exportKey("spki", key));
}

export function importSigningPublicKey(spki: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "spki",
    base64UrlToBuf(spki),
    { name: SIG, namedCurve: CURVE },
    true,
    ["verify"],
  );
}

/** Sign a canonical statement string (see @sendself/shared). */
export async function signStatement(privateKey: CryptoKey, statement: string): Promise<string> {
  const signature = await crypto.subtle.sign(
    { name: SIG, hash: SIG_HASH },
    privateKey,
    new TextEncoder().encode(statement),
  );
  return bufToBase64Url(signature);
}

/**
 * Verify a statement's signature. Returns false rather than throwing for a
 * malformed key or signature too: to the caller, "this doesn't check out" and
 * "this isn't even well-formed" are the same answer.
 */
export async function verifyStatement(
  publicKey: CryptoKey,
  statement: string,
  signature: string,
): Promise<boolean> {
  try {
    return await crypto.subtle.verify(
      { name: SIG, hash: SIG_HASH },
      publicKey,
      base64UrlToBuf(signature),
      new TextEncoder().encode(statement),
    );
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Serialising a device keypair (at-rest vault + recovery file)
// ---------------------------------------------------------------------------

/** A keypair as base64url SPKI + PKCS#8, the only form that survives storage. */
export interface SerializedKeyPair {
  publicKey: string;
  privateKey: string;
}

/**
 * Export a keypair for the encrypted local vault/recovery file, or null for a
 * legacy key that was generated before recovery export existed.
 *
 * Null is not an error: a legacy device keeps working exactly as it did, but
 * cannot be sealed into a vault or written into a recovery file. The UI says so
 * instead of producing a backup that would not restore.
 */
export async function serializeKeyPair(pair: CryptoKeyPair): Promise<SerializedKeyPair | null> {
  try {
    return {
      publicKey: bufToBase64Url(await crypto.subtle.exportKey("spki", pair.publicKey)),
      privateKey: bufToBase64Url(await crypto.subtle.exportKey("pkcs8", pair.privateKey)),
    };
  } catch {
    return null;
  }
}

export async function importDeviceKeyPair(pair: SerializedKeyPair): Promise<CryptoKeyPair> {
  return {
    publicKey: await importPublicKey(pair.publicKey),
    privateKey: await crypto.subtle.importKey(
      "pkcs8",
      base64UrlToBuf(pair.privateKey),
      { name: EC, namedCurve: CURVE },
      true,
      ["deriveKey"],
    ),
  };
}

export async function importSigningKeyPair(pair: SerializedKeyPair): Promise<CryptoKeyPair> {
  return {
    publicKey: await importSigningPublicKey(pair.publicKey),
    privateKey: await crypto.subtle.importKey(
      "pkcs8",
      base64UrlToBuf(pair.privateKey),
      { name: SIG, namedCurve: CURVE },
      true,
      ["sign"],
    ),
  };
}

// ---------------------------------------------------------------------------
// ECIES pairing wrap / unwrap
// ---------------------------------------------------------------------------

function deriveSharedKey(privateKey: CryptoKey, peerPublicKey: CryptoKey): Promise<CryptoKey> {
  return crypto.subtle.deriveKey(
    { name: EC, public: peerPublicKey },
    privateKey,
    { name: AES, length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export interface WrappedSecret {
  /** base64url of JSON `{ iv, ct }`. */
  wrappedPackage: string;
  /** Ephemeral ECDH P-256 public key (base64url SPKI). */
  ephemeralPublicKey: string;
}

/**
 * Encrypt a JSON secret so only the holder of `recipientPublicKey`'s private
 * key can read it. Used for both hand-offs of the GroupKey: the pairing package
 * and the per-device blobs of a key rotation.
 *
 * `context` is bound as AAD, so a blob is only decryptable in the exact place
 * it was minted for — a rotation blob cannot be replayed at another device or
 * epoch, and a pairing package cannot be moved to another slot.
 */
export async function wrapSecret(
  recipientPublicKey: CryptoKey,
  payload: unknown,
  context?: string,
): Promise<WrappedSecret> {
  const ephemeral = await crypto.subtle.generateKey({ name: EC, namedCurve: CURVE }, false, [
    "deriveKey",
  ]);
  const sharedKey = await deriveSharedKey(ephemeral.privateKey, recipientPublicKey);
  const iv = randomIv();
  const ciphertext = await crypto.subtle.encrypt(
    { name: AES, iv, additionalData: aad(context) },
    sharedKey,
    new TextEncoder().encode(JSON.stringify(payload)),
  );
  const wrapped = JSON.stringify({ iv: bufToBase64Url(iv), ct: bufToBase64Url(ciphertext) });
  return {
    wrappedPackage: bufToBase64Url(new TextEncoder().encode(wrapped)),
    ephemeralPublicKey: await exportPublicKey(ephemeral.publicKey),
  };
}

/** Decrypt a `wrapSecret` blob with this device's private key. */
export async function unwrapSecret<T>(
  myPrivateKey: CryptoKey,
  ephemeralPublicKey: string,
  wrappedPackage: string,
  context?: string,
): Promise<T> {
  const ephemeralPublic = await importPublicKey(ephemeralPublicKey);
  const sharedKey = await deriveSharedKey(myPrivateKey, ephemeralPublic);
  const wrappedJson = new TextDecoder().decode(base64UrlToBuf(wrappedPackage));
  const { iv, ct } = JSON.parse(wrappedJson) as { iv: string; ct: string };
  const plaintext = await crypto.subtle.decrypt(
    { name: AES, iv: base64UrlToBuf(iv), additionalData: aad(context) },
    sharedKey,
    base64UrlToBuf(ct),
  );
  return JSON.parse(new TextDecoder().decode(plaintext)) as T;
}

/** AAD context binding a rotated-key blob to one recipient and one epoch. */
export function rekeyContext(groupId: string, epoch: number, deviceId: string): string {
  return `rekey:${groupId}:${epoch}:${deviceId}`;
}

/** Encrypt the pairing payload for a recipient's public key. */
export function wrapPairingPackage(
  recipientPublicKey: CryptoKey,
  payload: PairingPayload,
  pairingId?: string,
): Promise<WrappedSecret> {
  return wrapSecret(recipientPublicKey, payload, pairingId && `pairing:${pairingId}`);
}

/** Decrypt the pairing payload using this device's private key. */
export function unwrapPairingPackage(
  myPrivateKey: CryptoKey,
  ephemeralPublicKey: string,
  wrappedPackage: string,
  pairingId?: string,
): Promise<PairingPayload> {
  return unwrapSecret<PairingPayload>(
    myPrivateKey,
    ephemeralPublicKey,
    wrappedPackage,
    pairingId && `pairing:${pairingId}`,
  );
}

// ---------------------------------------------------------------------------
// Text / binary payloads (AES-GCM with the GroupKey)
// ---------------------------------------------------------------------------

export interface EncryptedText {
  ciphertext: string;
  iv: string;
}

export async function encryptText(
  groupKey: CryptoKey,
  text: string,
  context?: string,
): Promise<EncryptedText> {
  const iv = randomIv();
  const ciphertext = await crypto.subtle.encrypt(
    { name: AES, iv, additionalData: aad(context) },
    groupKey,
    new TextEncoder().encode(text),
  );
  return { ciphertext: bufToBase64Url(ciphertext), iv: bufToBase64Url(iv) };
}

export async function decryptText(
  groupKey: CryptoKey,
  ciphertext: string,
  iv: string,
  context?: string,
): Promise<string> {
  const plaintext = await crypto.subtle.decrypt(
    { name: AES, iv: base64UrlToBuf(iv), additionalData: aad(context) },
    groupKey,
    base64UrlToBuf(ciphertext),
  );
  return new TextDecoder().decode(plaintext);
}

/** Encrypt a JSON-serialisable value (e.g. file metadata). */
export async function encryptJson(
  groupKey: CryptoKey,
  value: unknown,
  context?: string,
): Promise<EncryptedText> {
  return encryptText(groupKey, JSON.stringify(value), context);
}

export async function decryptJson<T>(
  groupKey: CryptoKey,
  ciphertext: string,
  iv: string,
  context?: string,
): Promise<T> {
  return JSON.parse(await decryptText(groupKey, ciphertext, iv, context)) as T;
}

/**
 * Encrypt/decrypt a device name with the GroupKey, bound to the device id so a
 * name ciphertext cannot be transplanted onto another device.
 */
export function encryptName(
  groupKey: CryptoKey,
  name: string,
  deviceId: string,
): Promise<EncryptedText> {
  return encryptText(groupKey, name, `name:${deviceId}`);
}

export function decryptName(
  groupKey: CryptoKey,
  ciphertext: string,
  iv: string,
  deviceId: string,
): Promise<string> {
  return decryptText(groupKey, ciphertext, iv, `name:${deviceId}`);
}

export interface EncryptedFile {
  ciphertext: ArrayBuffer;
  iv: string;
}

/**
 * One-shot AES-GCM over a whole file buffer (fine for files up to ~50 MB).
 *
 * `ivB64` lets a retried upload reuse the IV persisted by an earlier attempt:
 * same key + IV + plaintext + AAD produce byte-identical ciphertext, so a
 * re-upload can never diverge from the IV a previous attempt already
 * registered with the server. Only ever pass an IV that was generated for
 * this exact plaintext/context — reusing it across different plaintexts
 * breaks AES-GCM.
 */
export async function encryptFile(
  groupKey: CryptoKey,
  data: ArrayBuffer,
  context?: string,
  ivB64?: string,
): Promise<EncryptedFile> {
  const iv = ivB64 ? new Uint8Array(base64UrlToBuf(ivB64)) : randomIv();
  const ciphertext = await crypto.subtle.encrypt(
    { name: AES, iv, additionalData: aad(context) },
    groupKey,
    data,
  );
  return { ciphertext, iv: bufToBase64Url(iv) };
}

export async function decryptFile(
  groupKey: CryptoKey,
  data: ArrayBuffer,
  iv: string,
  context?: string,
): Promise<ArrayBuffer> {
  return crypto.subtle.decrypt(
    { name: AES, iv: base64UrlToBuf(iv), additionalData: aad(context) },
    groupKey,
    data,
  );
}
