/**
 * The at-rest lock: turning it on, unlocking, locking, turning it off.
 *
 * The rule this module exists to keep is simple: **while the device is locked,
 * nothing that could decrypt anything is in storage.** Every space's session
 * and keyring live inside one sealed envelope (`GLOBAL_VAULT`), local messages,
 * files and space names are ciphertext (db/atrest.ts), and the only way back is
 * a secret the user supplies. There is no stored verifier to test guesses
 * against — a wrong passphrase surfaces as an AES-GCM authentication failure
 * and nothing else.
 *
 * The lock covers the *device*, not a space: one secret unlocks every space
 * this device holds, and while it is on, the space list cannot even be read by
 * name. That is why the envelope lives in the registry rather than inside any
 * one space's database.
 *
 * Locking is not on a timer. The device locks when the app starts and whenever
 * the user asks; keeping an unlocked session alive while the app is open is
 * what makes the lock livable rather than something people turn off after a
 * day.
 */

import { signal } from "@preact/signals";
import {
  base64UrlToBuf,
  bufToBase64Url,
  exportGroupKey,
  importDeviceKeyPair,
  importGroupKey,
  importSigningKeyPair,
  serializeKeyPair,
} from "../crypto/crypto";
import { type Keyring, loadKeyring, saveKeyring } from "../crypto/keyring";
import { PasskeyUnsupportedError, createPasskey, evaluatePrf } from "../crypto/passkey";
import {
  type LockMethod,
  PBKDF2_ITERATIONS,
  type SerializedKeyring,
  type SpaceSecrets,
  type StoredVaultSecrets,
  type VaultEnvelope,
  type VaultSpaceSecrets,
  keysFromPassphrase,
  keysFromSecret,
  newSalt,
  openVault,
  sealVault,
} from "../crypto/vault";
import { currentContentKey, setContentKey, setContentLocked } from "../db/atrest";
import {
  GLOBAL_VAULT,
  LEGACY_SPACE_ID,
  globalMetaDelete,
  globalMetaGet,
  globalMetaSet,
  listSpaces,
  rewriteSpaceNames,
} from "../db/spaces";
import {
  META_DEVICE_KEYPAIR,
  META_KEYRING,
  META_SESSION,
  META_SIGNING_KEYPAIR,
  activeSpace,
  metaDelete,
  metaGet,
  metaSet,
  rewriteLocalContent,
} from "../db/store";
import { stopSync } from "../sync/sync";
import type { Session } from "../types";
import {
  deviceKeyPair,
  keyring,
  session,
  sessionRevoked,
  setSecretsChangedHandler,
  signingKeyPair,
} from "./session";
import { type VaultBridge, refreshSpaces, setVaultBridge } from "./spaces";

/** A lock is configured on this device (there is an envelope in storage). */
export const lockConfigured = signal(false);
/** How this device unlocks. Null when no lock is set. */
export const lockMethod = signal<LockMethod | null>(null);
/** The secrets are sealed and not in memory: nothing works until unlocked. */
export const locked = signal(false);

/** The envelope in storage, kept so unlocking knows its derivation parameters. */
let envelope: VaultEnvelope | null = null;
/**
 * The vault key for the current unlocked session. Held so the envelope can be
 * re-sealed after a key rotation without prompting the user again — the secret
 * has not changed, only what it protects.
 */
let vaultKey: CryptoKey | null = null;
/**
 * Every space's secrets while the device is unlocked, by space id. This is the
 * only copy there is: with a lock on, storage holds the sealed envelope and
 * nothing any space could be opened with, so switching spaces reads from here.
 */
let unlocked: Map<string, VaultSpaceSecrets> | null = null;

export class WrongSecretError extends Error {
  constructor() {
    super("That didn't unlock this device. Try again.");
    this.name = "WrongSecretError";
  }
}

/**
 * Read the lock configuration. Runs before any space is opened, because a
 * locked device deliberately has no session in storage to load.
 */
export async function loadLockState(): Promise<void> {
  envelope = (await globalMetaGet<VaultEnvelope>(GLOBAL_VAULT)) ?? null;
  setContentLocked(envelope !== null);
  lockConfigured.value = envelope !== null;
  lockMethod.value = envelope?.method ?? null;
  locked.value = envelope !== null;
}

// ---------------------------------------------------------------------------
// Serialising a space's secrets
// ---------------------------------------------------------------------------

async function serializeKeyring(ring: Keyring): Promise<SerializedKeyring> {
  const keys: [number, string][] = [];
  for (const [epoch, key] of ring.keys) keys.push([epoch, await exportGroupKey(key)]);
  return { current: ring.current, keys };
}

async function deserializeKeyring(serialized: SerializedKeyring): Promise<Keyring> {
  const ring: Keyring = { current: serialized.current, keys: new Map() };
  for (const [epoch, raw] of serialized.keys) ring.keys.set(epoch, await importGroupKey(raw));
  return ring;
}

/** Read one space's secrets out of its own storage, or null if it holds none. */
async function secretsFromStorage(spaceId: string): Promise<VaultSpaceSecrets | null> {
  const [storedSession, ring, storedKeyPair, storedSigningKeyPair] = await Promise.all([
    metaGet<Session>(META_SESSION, spaceId),
    loadKeyring(spaceId),
    metaGet<CryptoKeyPair>(META_DEVICE_KEYPAIR, spaceId),
    metaGet<CryptoKeyPair>(META_SIGNING_KEYPAIR, spaceId),
  ]);
  if (!storedSession || !ring) return null;
  return {
    spaceId,
    session: storedSession,
    keyring: await serializeKeyring(ring),
    deviceKeyPair: storedKeyPair ? await serializeKeyPair(storedKeyPair) : null,
    signingKeyPair: storedSigningKeyPair ? await serializeKeyPair(storedSigningKeyPair) : null,
  };
}

/**
 * The active space's secrets, taken from the signals the app is running on.
 * Also exactly what a recovery file carries (recovery.ts), which is why this
 * lives here rather than inside the enable/disable paths.
 */
export async function activeSpaceSecrets(): Promise<SpaceSecrets> {
  const currentSession = session.value;
  const ring = keyring.value;
  if (!currentSession || !ring) throw new Error("Not signed in");
  return {
    session: currentSession,
    keyring: await serializeKeyring(ring),
    deviceKeyPair: deviceKeyPair.value ? await serializeKeyPair(deviceKeyPair.value) : null,
    signingKeyPair: signingKeyPair.value ? await serializeKeyPair(signingKeyPair.value) : null,
  };
}

function exportContentKey(key: CryptoKey): Promise<string> {
  return crypto.subtle.exportKey("raw", key).then(bufToBase64Url);
}

// ---------------------------------------------------------------------------
// Unlocking
// ---------------------------------------------------------------------------

/**
 * A `v: 1` envelope held one space's secrets inline, because a device could
 * only hold one space. It opens as exactly that: the space whose storage
 * predates the registry (see db/spaces.ts).
 */
function normalize(stored: StoredVaultSecrets): VaultSpaceSecrets[] {
  if ("spaces" in stored) return stored.spaces;
  const { contentKey: _contentKey, ...space } = stored;
  return [{ spaceId: LEGACY_SPACE_ID, ...space }];
}

/** Put the opened secrets in memory and make local content readable. */
async function hydrate(
  stored: StoredVaultSecrets,
  keys: { vaultKey: CryptoKey; contentKey: CryptoKey },
): Promise<void> {
  setContentKey(keys.contentKey);
  vaultKey = keys.vaultKey;
  unlocked = new Map(normalize(stored).map((space) => [space.spaceId, space]));
  locked.value = false;
  // Space names are sealed under the content key too, so the list of spaces
  // only becomes readable at this point.
  await refreshSpaces();
}

/** Open the envelope, turning any failure into "that wasn't the secret". */
async function openOrReject(key: CryptoKey, current: VaultEnvelope): Promise<StoredVaultSecrets> {
  try {
    return await openVault(key, current);
  } catch {
    throw new WrongSecretError();
  }
}

export async function unlockWithPassphrase(passphrase: string): Promise<void> {
  if (!envelope) throw new Error("This device has no lock");
  const keys = await keysFromPassphrase(passphrase, envelope.salt, envelope.iterations);
  await hydrate(await openOrReject(keys.vaultKey, envelope), keys);
}

export async function unlockWithPasskey(): Promise<void> {
  if (!envelope?.credentialId) throw new Error("This device has no passkey lock");
  const secret = await evaluatePrf(envelope.credentialId, base64UrlToBuf(envelope.salt));
  if (!secret) throw new PasskeyUnsupportedError();
  const keys = await keysFromSecret(secret, envelope.salt);
  await hydrate(await openOrReject(keys.vaultKey, envelope), keys);
}

/**
 * Drop everything from memory. Storage is already sealed, so this is only about
 * the copies this tab holds — nothing to rewrite, nothing to undo.
 */
export function lockNow(): void {
  if (!lockConfigured.value) return;
  stopSync();
  setContentLocked(true);
  vaultKey = null;
  unlocked = null;
  session.value = null;
  keyring.value = null;
  deviceKeyPair.value = null;
  signingKeyPair.value = null;
  locked.value = true;
}

// ---------------------------------------------------------------------------
// Turning the lock on and off
// ---------------------------------------------------------------------------

export interface EnableLockOptions {
  method: LockMethod;
  /** Required for `method: "passphrase"`. */
  passphrase?: string;
  /** Shown in the platform's own passkey prompt for `method: "passkey"`. */
  deviceName?: string;
}

/**
 * Turn the lock on, over every space this device holds.
 *
 * The order is load-bearing: content is re-encrypted *before* the envelope is
 * written and the plaintext keys are deleted. An interruption halfway therefore
 * leaves a device that still opens normally — some rows sealed under a key that
 * is still reachable in the clear — rather than one whose history is ciphertext
 * with no way in.
 */
export async function enableLock(options: EnableLockOptions): Promise<void> {
  const salt = newSalt();
  let credentialId: string | undefined;
  let keys: { vaultKey: CryptoKey; contentKey: CryptoKey };

  if (options.method === "passkey") {
    const passkey = await createPasskey(options.deviceName ?? "SendSelf", base64UrlToBuf(salt));
    credentialId = passkey.credentialId;
    keys = await keysFromSecret(passkey.secret, salt);
  } else {
    if (!options.passphrase) throw new Error("A passphrase is required");
    keys = await keysFromPassphrase(options.passphrase, salt, PBKDF2_ITERATIONS);
  }

  const registered = await listSpaces();
  const collected: VaultSpaceSecrets[] = [];
  for (const space of registered) {
    const secrets = await secretsFromStorage(space.id);
    if (secrets) collected.push(secrets);
  }

  for (const space of registered) await rewriteLocalContent(keys.contentKey, space.id);
  await rewriteSpaceNames(keys.contentKey);
  setContentKey(keys.contentKey);
  vaultKey = keys.vaultKey;
  unlocked = new Map(collected.map((space) => [space.spaceId, space]));

  const sealed = await sealVault(
    keys.vaultKey,
    { spaces: collected, contentKey: await exportContentKey(keys.contentKey) },
    {
      v: 2,
      method: options.method,
      salt,
      iterations: PBKDF2_ITERATIONS,
      ...(credentialId ? { credentialId } : {}),
    },
  );
  await globalMetaSet(GLOBAL_VAULT, sealed);

  // Only now do the plaintext copies go. The keypairs are dropped only if they
  // could be sealed: a device from before they were exportable would otherwise
  // be deleting the one copy of its own identity.
  for (const space of collected) {
    await Promise.all([
      metaDelete(META_SESSION, space.spaceId),
      metaDelete(META_KEYRING, space.spaceId),
      ...(space.deviceKeyPair ? [metaDelete(META_DEVICE_KEYPAIR, space.spaceId)] : []),
      ...(space.signingKeyPair ? [metaDelete(META_SIGNING_KEYPAIR, space.spaceId)] : []),
    ]);
  }

  envelope = sealed;
  lockConfigured.value = true;
  lockMethod.value = options.method;
  locked.value = false;
  await refreshSpaces();
}

/**
 * Turn the lock off, putting every space's secrets and local content back in
 * the clear. Only possible while unlocked, which is the point: the secret is
 * the only thing that may authorise removing the protection it provides.
 */
export async function disableLock(): Promise<void> {
  if (locked.value || !unlocked) throw new Error("Unlock this device first");
  const held = [...unlocked.values()];

  for (const space of held) {
    await rewriteLocalContent(null, space.spaceId);
    await metaSet(META_SESSION, space.session, space.spaceId);
    await saveKeyring(await deserializeKeyring(space.keyring), space.spaceId);
    if (space.deviceKeyPair) {
      const pair = await importDeviceKeyPair(space.deviceKeyPair);
      await metaSet(META_DEVICE_KEYPAIR, pair, space.spaceId);
    }
    if (space.signingKeyPair) {
      const pair = await importSigningKeyPair(space.signingKeyPair);
      await metaSet(META_SIGNING_KEYPAIR, pair, space.spaceId);
    }
  }
  await rewriteSpaceNames(null);

  setContentKey(null);
  vaultKey = null;
  await globalMetaDelete(GLOBAL_VAULT);

  envelope = null;
  lockConfigured.value = false;
  lockMethod.value = null;
  locked.value = false;
  await refreshSpaces();
}

/** Re-seal the envelope around whatever `unlocked` currently holds. */
async function reseal(): Promise<void> {
  const contentKey = currentContentKey();
  if (!envelope || !vaultKey || !unlocked || !contentKey) return;
  envelope = await sealVault(
    vaultKey,
    { spaces: [...unlocked.values()], contentKey: await exportContentKey(contentKey) },
    {
      v: 2,
      method: envelope.method,
      salt: envelope.salt,
      iterations: envelope.iterations,
      ...(envelope.credentialId ? { credentialId: envelope.credentialId } : {}),
    },
  );
  await globalMetaSet(GLOBAL_VAULT, envelope);
}

/**
 * Re-seal the envelope after the active space's secrets changed underneath it.
 *
 * A key rotation adds an epoch to the keyring, and the keyring lives in the
 * vault while a lock is on — so without this the next unlock would silently
 * roll the device back to yesterday's keys and stop it reading anything sent
 * since. Creating or joining a space on a locked-down device arrives here too:
 * this is the moment its secrets move into the envelope. A no-op without a
 * lock, so callers never have to check.
 */
export async function refreshVault(): Promise<void> {
  if (!envelope || !vaultKey || !unlocked || locked.value) return;
  const spaceId = activeSpace();
  if (!spaceId || !session.value || !keyring.value) return;

  unlocked.set(spaceId, { spaceId, ...(await activeSpaceSecrets()) });
  await reseal();
  // Self-healing: `persistSession` writes the plaintext copies unconditionally
  // (it is the path a brand-new or restored session takes, where no lock can
  // exist yet). Clearing them here keeps the invariant true no matter which
  // order things happened in.
  await Promise.all([
    metaDelete(META_SESSION, spaceId),
    metaDelete(META_KEYRING, spaceId),
    metaDelete(META_DEVICE_KEYPAIR, spaceId),
    metaDelete(META_SIGNING_KEYPAIR, spaceId),
  ]);
}

/** Forget the lock entirely, without touching what it was protecting. */
export function forgetLock(): void {
  envelope = null;
  vaultKey = null;
  unlocked = null;
  setContentKey(null);
  lockConfigured.value = false;
  lockMethod.value = null;
  locked.value = false;
}

// ---------------------------------------------------------------------------
// Taking part in the space lifecycle (see state/spaces.ts)
// ---------------------------------------------------------------------------

const bridge: VaultBridge = {
  async load(spaceId) {
    const secrets = unlocked?.get(spaceId);
    if (!secrets) return false;
    session.value = secrets.session;
    keyring.value = await deserializeKeyring(secrets.keyring);
    // A device from before the keys were exportable keeps them where the
    // browser put them: they could not be sealed, so they are still in `meta`.
    deviceKeyPair.value = secrets.deviceKeyPair
      ? await importDeviceKeyPair(secrets.deviceKeyPair)
      : ((await metaGet<CryptoKeyPair>(META_DEVICE_KEYPAIR, spaceId)) ?? null);
    signingKeyPair.value = secrets.signingKeyPair
      ? await importSigningKeyPair(secrets.signingKeyPair)
      : ((await metaGet<CryptoKeyPair>(META_SIGNING_KEYPAIR, spaceId)) ?? null);
    sessionRevoked.value = false;
    return true;
  },

  async forget(spaceId) {
    if (!unlocked?.delete(spaceId)) return;
    // That was the last space, and with it everything the lock protected.
    // Keeping the envelope would only ask for a secret to reveal nothing.
    if (unlocked.size === 0) {
      await rewriteSpaceNames(null);
      await globalMetaDelete(GLOBAL_VAULT);
      forgetLock();
      return;
    }
    await reseal();
  },
};

setVaultBridge(bridge);

// Registered here rather than imported by `state/session.ts`, which would make
// the dependency circular: the lock is built on the session, not the reverse.
setSecretsChangedHandler(() => void refreshVault());
