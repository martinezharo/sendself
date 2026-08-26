/**
 * Encrypted recovery file: the answer to "every device is gone".
 *
 * Until now a space had exactly as many copies of its keys as it had linked
 * devices, and losing all of them lost the space for good — there is no server
 * copy to fall back on, by design. A recovery file is a copy the user keeps:
 * this device's credentials and every GroupKey epoch it holds, sealed under a
 * randomly generated recovery code that is shown once and never stored.
 *
 * Two properties it deliberately keeps:
 *
 *  - **The code is generated, not chosen.** 160 bits of entropy, because unlike
 *    the at-rest lock this file will sit in a password manager or a drawer,
 *    away from the device that would otherwise rate-limit guesses.
 *  - **It restores a device, not a new one.** Recovery replays the exporting
 *    device's own identity, so nothing has to be re-authorised by a device that
 *    no longer exists. That is also why a device whose keys predate exportable
 *    key material cannot produce one: the file would restore a device unable to
 *    receive a future rotated GroupKey, which is worse than no file at all.
 *
 * A file is a snapshot. Revoking a device rotates the key, and a file exported
 * before that rotation opens history but not what came after — so the UI
 * flags a stale one (`META_RECOVERY_EPOCH`).
 */

import { INITIAL_KEY_EPOCH } from "@sendself/shared";
import { startSession } from "./actions";
import { PRE_REBRAND_ID } from "./legacy";
import {
  importDeviceKeyPair,
  importGroupKey,
  importSigningKeyPair,
  randomBytes,
} from "./crypto/crypto";
import type { SerializedKeyPair } from "./crypto/crypto";
import type { Keyring } from "./crypto/keyring";
import {
  PBKDF2_ITERATIONS,
  type SealedBlob,
  type SerializedKeyring,
  keysFromPassphrase,
  newSalt,
  open,
  seal,
  validatePbkdf2Iterations,
} from "./crypto/vault";
import { META_RECOVERY_EPOCH, metaSet } from "./db/store";
import { activeSpaceSecrets } from "./state/lock";
import { navigate, spacePath } from "./state/route";
import { persistSession } from "./state/session";
import { activeSpace, beginSpace, forgetSpace } from "./state/spaces";
import type { Session } from "./types";

/** Bound as AAD, so a blob cannot be replayed as an at-rest vault or vice versa. */
const RECOVERY_AAD = "sendself-recovery:1";
const LEGACY_RECOVERY_AAD = `${PRE_REBRAND_ID}-recovery:1`;
const RECOVERY_KIND = "sendself-recovery" as const;
const LEGACY_RECOVERY_KIND = `${PRE_REBRAND_ID}-recovery`;

/**
 * Crockford-style alphabet: no I, L, O or U, so nothing in a handwritten code
 * can be confused with 1, 0 or an accidental profanity.
 */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_CHARS = 32;
const CODE_GROUP = 4;

export interface RecoveryFile {
  kind: typeof RECOVERY_KIND | typeof LEGACY_RECOVERY_KIND;
  v: 1;
  createdAt: number;
  /** Epoch the space was at when this was written; a restore below it is stale. */
  keyEpoch: number;
  salt: string;
  iterations: number;
  sealed: SealedBlob;
}

interface RecoveryPayload {
  session: Session;
  keyring: SerializedKeyring;
  deviceKeyPair: SerializedKeyPair;
  signingKeyPair: SerializedKeyPair | null;
  /** The space's local name, so a restore doesn't come back nameless. */
  spaceName?: string;
}

export class NoExportableKeysError extends Error {
  constructor() {
    super(
      "This device was linked before recovery files existed, so its keys can't leave it. " +
        "Link it again (or link another device) to be able to create one.",
    );
    this.name = "NoExportableKeysError";
  }
}

export class BadRecoveryFileError extends Error {
  constructor(message = "That file isn't a SendSelf recovery file.") {
    super(message);
    this.name = "BadRecoveryFileError";
  }
}

export class WrongRecoveryCodeError extends Error {
  constructor() {
    super("That recovery code doesn't open this file.");
    this.name = "WrongRecoveryCodeError";
  }
}

/** A fresh 160-bit code, grouped for reading aloud and typing back. */
export function generateRecoveryCode(): string {
  const bytes = randomBytes(CODE_CHARS);
  let code = "";
  for (let i = 0; i < CODE_CHARS; i++) {
    if (i > 0 && i % CODE_GROUP === 0) code += "-";
    code += ALPHABET[bytes[i]! % ALPHABET.length];
  }
  return code;
}

/**
 * Accept a code however it was written down: lower case, spaced, hyphenated, or
 * with the O/0 and I/1 substitutions people make without noticing.
 */
export function normalizeRecoveryCode(code: string): string {
  return code
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1")
    .replace(/U/g, "V");
}

/**
 * Build the recovery file for the current session. The code is returned, not
 * stored: this is the only moment it exists anywhere.
 */
export async function createRecoveryFile(): Promise<{ file: RecoveryFile; code: string }> {
  const secrets = await activeSpaceSecrets();
  if (!secrets.deviceKeyPair) throw new NoExportableKeysError();

  const code = generateRecoveryCode();
  const salt = newSalt();
  const { vaultKey } = await keysFromPassphrase(
    normalizeRecoveryCode(code),
    salt,
    PBKDF2_ITERATIONS,
  );

  const payload: RecoveryPayload = {
    session: secrets.session,
    keyring: secrets.keyring,
    deviceKeyPair: secrets.deviceKeyPair,
    signingKeyPair: secrets.signingKeyPair,
    ...(activeSpace.value?.name ? { spaceName: activeSpace.value.name } : {}),
  };

  const file: RecoveryFile = {
    kind: RECOVERY_KIND,
    v: 1,
    createdAt: Date.now(),
    keyEpoch: secrets.keyring.current,
    salt,
    iterations: PBKDF2_ITERATIONS,
    sealed: await seal(vaultKey, payload, RECOVERY_AAD),
  };

  await metaSet(META_RECOVERY_EPOCH, file.keyEpoch);
  return { file, code };
}

/** Suggested file name: dated, and obvious about what it is. */
export function recoveryFileName(file: RecoveryFile): string {
  const date = new Date(file.createdAt).toISOString().slice(0, 10);
  return `sendself-recovery-${date}.json`;
}

export function parseRecoveryFile(text: string): RecoveryFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new BadRecoveryFileError();
  }
  const file = parsed as Partial<RecoveryFile>;
  if (
    (file?.kind !== RECOVERY_KIND && file?.kind !== LEGACY_RECOVERY_KIND) ||
    file.v === undefined ||
    typeof file.createdAt !== "number" ||
    !Number.isSafeInteger(file.createdAt) ||
    typeof file.keyEpoch !== "number" ||
    !Number.isSafeInteger(file.keyEpoch) ||
    file.keyEpoch < 1 ||
    typeof file.salt !== "string" ||
    file.salt.length === 0 ||
    !file.sealed ||
    typeof file.sealed !== "object" ||
    typeof file.sealed.iv !== "string" ||
    typeof file.sealed.ct !== "string"
  ) {
    throw new BadRecoveryFileError();
  }
  if (file.v !== 1) {
    throw new BadRecoveryFileError("That recovery file was written by a newer version.");
  }
  if (file.iterations !== undefined) {
    try {
      validatePbkdf2Iterations(file.iterations);
    } catch {
      throw new BadRecoveryFileError("That recovery file has invalid key derivation settings.");
    }
  }
  return file as RecoveryFile;
}

/**
 * Restore a space from a recovery file, as a new space on this device.
 *
 * The restored device *is* the exported one — same id, same credential, same
 * keys — so it needs nothing from any other device to start working again.
 * Nothing else on this device is touched: restoring is joining a space, and the
 * others it already holds are none of this file's business.
 */
export async function restoreFromRecoveryFile(text: string, code: string): Promise<void> {
  const file = parseRecoveryFile(text);
  const { vaultKey } = await keysFromPassphrase(
    normalizeRecoveryCode(code),
    file.salt,
    file.iterations ?? PBKDF2_ITERATIONS,
  );

  let payload: RecoveryPayload;
  try {
    const context = file.kind === LEGACY_RECOVERY_KIND ? LEGACY_RECOVERY_AAD : RECOVERY_AAD;
    payload = await open<RecoveryPayload>(vaultKey, file.sealed, context);
  } catch {
    throw new WrongRecoveryCodeError();
  }

  const ring: Keyring = {
    current: payload.keyring.current || INITIAL_KEY_EPOCH,
    keys: new Map(),
  };
  for (const [epoch, raw] of payload.keyring.keys) {
    ring.keys.set(epoch, await importGroupKey(raw));
  }

  const space = await beginSpace(payload.spaceName ?? null);
  try {
    await persistSession(
      payload.session,
      ring,
      await importDeviceKeyPair(payload.deviceKeyPair),
      payload.signingKeyPair ? await importSigningKeyPair(payload.signingKeyPair) : undefined,
    );
    await metaSet(META_RECOVERY_EPOCH, ring.current);
    await startSession();
  } catch (error) {
    await forgetSpace(space.id);
    throw error;
  }
  navigate(spacePath(space.id));
}
