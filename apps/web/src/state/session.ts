import { signal } from "@preact/signals";
import type { Auth } from "../api/client";
import { type Keyring, loadKeyring, saveKeyring } from "../crypto/keyring";
import {
  META_DEVICE_KEYPAIR,
  META_SESSION,
  META_SIGNING_KEYPAIR,
  metaGet,
  metaSet,
} from "../db/store";
import type { Session } from "../types";

export const session = signal<Session | null>(null);
/**
 * Every GroupKey epoch this device holds. Not a single key: revoking a device
 * rotates the key, and the old epochs are kept so existing history and
 * in-flight content stay readable (crypto/keyring.ts).
 */
export const keyring = signal<Keyring | null>(null);
export const deviceKeyPair = signal<CryptoKeyPair | null>(null);
/**
 * This device's ECDSA identity: it signs every message it sends and vouches for
 * the keys of any device it adds. Null only for a session created before sender
 * authenticity existed, until `ensureSigningIdentity()` mints one.
 */
export const signingKeyPair = signal<CryptoKeyPair | null>(null);

/**
 * True once the app has finished its initial load from IndexedDB: the lock
 * state and the list of spaces are known, so the UI can tell a returning device
 * from a fresh one instead of flashing the wrong screen at both.
 */
export const ready = signal(false);

/** A fatal startup problem that should be explained instead of leaving a spinner. */
export const startupError = signal<string | null>(null);

/**
 * The server no longer accepts this device's token (revoked, or wiped along
 * with the space). The session is kept in memory so the UI can explain what
 * happened instead of silently dropping the user on the landing page.
 */
export const sessionRevoked = signal(false);

const SESSION_KEY = META_SESSION;
const DEVICE_KEYPAIR_KEY = META_DEVICE_KEYPAIR;

/**
 * Notified whenever the material an at-rest vault holds changes (a rotation
 * adds a key epoch, a signing identity appears). Registered by `state/lock.ts`
 * rather than imported from it: this module is what the lock builds on, and a
 * cycle between the two would be a real one — same shape as the API layer's
 * auth-failure handler.
 */
type SecretsChangedHandler = () => void;
let secretsChanged: SecretsChangedHandler | null = null;

export function setSecretsChangedHandler(handler: SecretsChangedHandler | null): void {
  secretsChanged = handler;
}

export function authHeaders(): Auth {
  const current = session.value;
  if (!current) throw new Error("Not signed in");
  return { token: current.deviceAuthToken };
}

/** Restore the active space's session + keys from its own database. */
export async function loadSession(): Promise<void> {
  const [storedSession, storedKeyring, storedKeyPair, storedSigningKeyPair] = await Promise.all([
    metaGet<Session>(SESSION_KEY),
    loadKeyring(),
    metaGet<CryptoKeyPair>(DEVICE_KEYPAIR_KEY),
    metaGet<CryptoKeyPair>(META_SIGNING_KEYPAIR),
  ]);
  if (storedSession && storedKeyring && storedKeyPair) {
    session.value = storedSession;
    keyring.value = storedKeyring;
    deviceKeyPair.value = storedKeyPair;
    // Deliberately not required: a session from before signing existed loads
    // exactly as it did, and grows an identity on its own (ensureSigningIdentity).
    signingKeyPair.value = storedSigningKeyPair ?? null;
  }
}

/**
 * `newSigningKeyPair` is optional for the one case that can legitimately lack
 * one: a pairing that was already in flight when the app updated to a version
 * that signs. That device mints its identity on the next launch, like any other
 * session that predates sender authenticity.
 */
export async function persistSession(
  newSession: Session,
  newKeyring: Keyring,
  newKeyPair: CryptoKeyPair,
  newSigningKeyPair?: CryptoKeyPair,
): Promise<void> {
  await Promise.all([
    metaSet(SESSION_KEY, newSession),
    saveKeyring(newKeyring),
    metaSet(DEVICE_KEYPAIR_KEY, newKeyPair),
    ...(newSigningKeyPair ? [metaSet(META_SIGNING_KEYPAIR, newSigningKeyPair)] : []),
  ]);
  session.value = newSession;
  keyring.value = newKeyring;
  deviceKeyPair.value = newKeyPair;
  signingKeyPair.value = newSigningKeyPair ?? null;
  sessionRevoked.value = false;
  secretsChanged?.();
}

/** Mirror a signing identity minted after the fact (actions/spaces.ensureSigningIdentity). */
export function applySigningKeyPair(pair: CryptoKeyPair): void {
  signingKeyPair.value = pair;
  secretsChanged?.();
}

/**
 * Mirror a keyring that was already persisted (adopted or rotated by the sync
 * engine, which is context-neutral and cannot touch signals) into the UI.
 */
export function applyKeyring(updated: Keyring): void {
  keyring.value = updated;
  // A rotation just added an epoch. If this device has an at-rest lock, the
  // sealed envelope still holds the old keyring, and an unlock that restored it
  // would leave the device unable to read anything sent since.
  secretsChanged?.();
}

/**
 * Drop the active space's secrets from memory. Storage is untouched: this is
 * what closing a space, locking the device and leaving a space all start with,
 * and only the last of those also deletes anything.
 */
export function clearSessionState(): void {
  session.value = null;
  keyring.value = null;
  deviceKeyPair.value = null;
  signingKeyPair.value = null;
  sessionRevoked.value = false;
}
