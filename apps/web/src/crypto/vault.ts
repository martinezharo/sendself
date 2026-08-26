/**
 * The at-rest vault: how this device's secrets are stored when the app is not
 * open in front of you.
 *
 * Without a lock, everything IndexedDB holds — the GroupKey, the bearer token,
 * every decrypted message and file — is readable by anyone who reaches the
 * storage: someone with the unlocked device, a stray browser extension, an XSS.
 * The lock closes that by keeping a single key *out* of storage: it is derived
 * from something the user supplies (a passphrase/PIN or a passkey) and exists
 * only in memory, for as long as the app is unlocked.
 *
 * Two keys come out of one unlock, both derived from the same secret:
 *  - the **vault key**, which seals the envelope holding the session and the
 *    keyring (crypto material that has to be restored as `CryptoKey`s), and
 *  - the **content key**, which encrypts local message records and file blobs
 *    in place (db/atrest.ts). Separating them means the store layer never holds
 *    the key that opens the credentials.
 *
 * Deliberately *not* a password on the space: it is local to this device, it
 * never reaches the server, and losing it costs only this device's copy —
 * every other device keeps working, and this one can be linked again.
 */

import type { Session } from "../types";
import { PRE_REBRAND_ID } from "../legacy";
import { type SerializedKeyPair, base64UrlToBuf, bufToBase64Url, randomBytes } from "./crypto";

const AES = "AES-GCM";
const IV_BYTES = 12;
const SALT_BYTES = 16;

/**
 * PBKDF2 rounds. Tuned to stay under ~1 s on a mid-range phone, which is the
 * device that actually has to run it: a laptop-only number would make the lock
 * annoying enough on mobile to be turned off, and a lock nobody enables
 * protects nothing. A passkey doesn't go through this at all.
 */
export const PBKDF2_ITERATIONS = 600_000;

/** Hard upper bound for iteration counts loaded from local/imported envelopes. */
export const MAX_PBKDF2_ITERATIONS = PBKDF2_ITERATIONS * 4;

/** Reject corrupt metadata before Web Crypto can spend unbounded CPU. */
export function validatePbkdf2Iterations(iterations: number): void {
  if (!Number.isSafeInteger(iterations) || iterations < 1 || iterations > MAX_PBKDF2_ITERATIONS) {
    throw new Error("Invalid PBKDF2 iteration count");
  }
}

/** How the wrapping secret is obtained on unlock. */
export type LockMethod = "passphrase" | "passkey";

/** AES-GCM ciphertext plus its IV, both base64url. */
export interface SealedBlob {
  iv: string;
  ct: string;
}

/**
 * What sits in IndexedDB in place of the session and keyring once a lock is on.
 * Everything here is either ciphertext or a public parameter: the salt and the
 * iteration count are needed to derive the key and reveal nothing without the
 * secret they are combined with.
 */
export interface VaultEnvelope {
  /** 1: one space's secrets inline. 2: every space this device holds. */
  v: 1 | 2;
  method: LockMethod;
  /** PBKDF2 salt (base64url). Also the PRF salt for a passkey. */
  salt: string;
  /** PBKDF2 rounds actually used, so raising the default never locks anyone out. */
  iterations: number;
  /** Credential this device unlocks with, for `method: "passkey"`. */
  credentialId?: string;
  sealed: SealedBlob;
}

/** The keyring flattened to raw key bytes, since `CryptoKey` is not JSON. */
export interface SerializedKeyring {
  current: number;
  /** `[epoch, raw AES-256 key]`, base64url. */
  keys: [number, string][];
}

/** One space's secrets: everything the app cannot reconstruct after a restart. */
export interface SpaceSecrets {
  session: Session;
  keyring: SerializedKeyring;
  /**
   * Null only for a device linked before recovery export existed, whose keys
   * cannot be sealed or exported. Those keys stay where the browser put them;
   * see `state/lock.ts`.
   */
  deviceKeyPair: SerializedKeyPair | null;
  signingKeyPair: SerializedKeyPair | null;
}

/** A space's secrets plus the id that says which space they open. */
export interface VaultSpaceSecrets extends SpaceSecrets {
  spaceId: string;
}

/**
 * What the envelope holds. A lock protects the device, so it covers every space
 * at once: one secret, one unlock, all of them readable — and while locked, not
 * one of them is.
 */
export interface VaultSecrets {
  spaces: VaultSpaceSecrets[];
  /** Raw content key (base64url) encrypting local messages, files and names. */
  contentKey: string;
}

/** A `v: 1` envelope, written when a device could only hold one space. */
export interface VaultSecretsV1 extends SpaceSecrets {
  contentKey: string;
}

/** What `openVault` can produce, before the caller normalises the version. */
export type StoredVaultSecrets = VaultSecrets | VaultSecretsV1;

/**
 * Bound as AAD to every vault ciphertext. It is a constant rather than
 * something device-specific because the only thing worth pinning here is the
 * format: an envelope is local to one device and one browser profile, and
 * anyone who could swap it for another would need that other one's secret to
 * open it anyway.
 */
const VAULT_AAD = "sendself-vault:1";
const LEGACY_VAULT_AAD = `${PRE_REBRAND_ID}-vault:1`;

function aad(context: string): Uint8Array<ArrayBuffer> {
  const encoded = new TextEncoder().encode(context);
  const out = new Uint8Array(encoded.byteLength);
  out.set(encoded);
  return out;
}

/**
 * Stretch a user secret into the two keys an unlock produces.
 *
 * The vault key and the content key are derived from the same PBKDF2 output
 * through HKDF with different `info` strings, so one unlock yields both while
 * the store layer only ever receives the content key — a bug there cannot leak
 * the credentials.
 */
async function deriveKeys(
  material: CryptoKey,
  salt: ArrayBuffer,
  iterations: number,
): Promise<{ vaultKey: CryptoKey; hkdf: CryptoKey }> {
  validatePbkdf2Iterations(iterations);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    material,
    256,
  );
  const hkdf = await crypto.subtle.importKey("raw", bits, "HKDF", false, ["deriveKey"]);
  return { vaultKey: await hkdfKey(hkdf, salt, "vault"), hkdf };
}

function hkdfKey(hkdf: CryptoKey, salt: ArrayBuffer, info: string): Promise<CryptoKey> {
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt, info: aad(info) },
    hkdf,
    { name: AES, length: 256 },
    // The content key is exported into the vault, so it must be extractable;
    // it is never written anywhere outside that (already sealed) envelope.
    true,
    ["encrypt", "decrypt"],
  );
}

/** The pair of keys an unlock produces from one secret. */
export interface UnlockedKeys {
  vaultKey: CryptoKey;
  contentKey: CryptoKey;
}

/** Derive both keys from a passphrase/PIN. */
export async function keysFromPassphrase(
  passphrase: string,
  saltB64: string,
  iterations: number,
): Promise<UnlockedKeys> {
  const salt = base64UrlToBuf(saltB64);
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const { vaultKey, hkdf } = await deriveKeys(material, salt, iterations);
  return { vaultKey, contentKey: await hkdfKey(hkdf, salt, "content") };
}

/**
 * Derive both keys from the bytes a passkey's PRF extension produced. The
 * authenticator returns the same 32 bytes for the same credential + salt and
 * only after the user has proven presence, so it plays exactly the role a
 * passphrase does — minus anything for the user to remember or mistype.
 */
export async function keysFromSecret(secret: ArrayBuffer, saltB64: string): Promise<UnlockedKeys> {
  const salt = base64UrlToBuf(saltB64);
  const hkdf = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveKey"]);
  return {
    vaultKey: await hkdfKey(hkdf, salt, "vault"),
    contentKey: await hkdfKey(hkdf, salt, "content"),
  };
}

export function newSalt(): string {
  return bufToBase64Url(randomBytes(SALT_BYTES));
}

/** Encrypt an arbitrary JSON value under `key`, bound to `context` as AAD. */
export async function seal(key: CryptoKey, value: unknown, context: string): Promise<SealedBlob> {
  const iv = randomBytes(IV_BYTES);
  const ct = await crypto.subtle.encrypt(
    { name: AES, iv, additionalData: aad(context) },
    key,
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return { iv: bufToBase64Url(iv), ct: bufToBase64Url(ct) };
}

/** Decrypt a `seal` blob. Throws when the key or the context is wrong. */
export async function open<T>(key: CryptoKey, blob: SealedBlob, context: string): Promise<T> {
  const plaintext = await crypto.subtle.decrypt(
    { name: AES, iv: base64UrlToBuf(blob.iv), additionalData: aad(context) },
    key,
    base64UrlToBuf(blob.ct),
  );
  return JSON.parse(new TextDecoder().decode(plaintext)) as T;
}

/** Seal the device's secrets into an envelope safe to leave in IndexedDB. */
export async function sealVault(
  key: CryptoKey,
  secrets: VaultSecrets,
  header: Omit<VaultEnvelope, "sealed">,
): Promise<VaultEnvelope> {
  return { ...header, sealed: await seal(key, secrets, VAULT_AAD) };
}

/**
 * Open an envelope. A wrong passphrase surfaces as an AES-GCM authentication
 * failure, which is the only signal there is — and the right one: there is no
 * verifier stored anywhere that an attacker could test guesses against offline
 * any faster than by attempting the decryption itself.
 */
export async function openVault(
  key: CryptoKey,
  envelope: VaultEnvelope,
): Promise<StoredVaultSecrets> {
  try {
    return await open<StoredVaultSecrets>(key, envelope.sealed, VAULT_AAD);
  } catch {
    return open<StoredVaultSecrets>(key, envelope.sealed, LEGACY_VAULT_AAD);
  }
}

/**
 * How long a passphrase has to be to be worth calling one. Short enough that a
 * 6-digit PIN qualifies (600k PBKDF2 rounds on a local-only secret is a real
 * cost per guess, and an attacker needs the device in hand), long enough to
 * rule out the one-character lock that only pretends.
 */
export const MIN_PASSPHRASE_LENGTH = 6;
