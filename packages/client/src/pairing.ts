/**
 * The joining half of pairing — the identity a new device mints for itself and
 * what it publishes so an existing device can add it — and invitations, the
 * way round for devices that cannot show a QR code (see `InviteSealFields`).
 */

import {
  type InviteSealFields,
  type PairingQrPayload,
  type PairingRequestBody,
  inviteSealStatement,
} from "@sendself/shared";
import {
  base64UrlToBuf,
  bufToBase64Url,
  exportPublicKey,
  exportSigningPublicKey,
  generateDeviceKeyPair,
  generateSigningKeyPair,
  randomBytes,
  randomId,
} from "./crypto";

export interface JoiningDevice {
  keyPair: CryptoKeyPair;
  signingKeyPair: CryptoKeyPair;
  /** What the existing device scans (or has pasted): the out-of-band half. */
  payload: PairingQrPayload;
  /** What reserves the pairing slot on the server: the in-band half. */
  request: PairingRequestBody;
}

export interface JoiningOptions {
  sendOnly?: boolean;
  /** Answer this invitation instead of showing a QR code. */
  invite?: Invite;
}

/**
 * Mint a fresh identity and the two views of it pairing needs. The signing key
 * rides in the QR code too, so the adding device learns it out-of-band and can
 * attest to it for everyone else.
 */
export async function createJoiningDevice(
  deviceName: string,
  options: JoiningOptions = {},
): Promise<JoiningDevice> {
  const keyPair = await generateDeviceKeyPair();
  const signingKeyPair = await generateSigningKeyPair();
  const deviceId = randomId();
  const pairingId = options.invite?.pairingId ?? randomId();
  const publicKey = await exportPublicKey(keyPair.publicKey);
  const signingPublicKey = await exportSigningPublicKey(signingKeyPair.publicKey);
  const sendOnly = options.sendOnly ? { sendOnly: true as const } : {};
  const invite = options.invite
    ? {
        invite: await sealInvite(options.invite, deviceName, {
          pairingId,
          deviceId,
          publicKey,
          signingPublicKey,
          sendOnly: !!options.sendOnly,
        }),
      }
    : {};

  return {
    keyPair,
    signingKeyPair,
    payload: {
      v: 1,
      pairingId,
      deviceId,
      deviceName,
      publicKey,
      signingPublicKey,
      ...sendOnly,
    },
    request: { device: { id: deviceId, publicKey, signingPublicKey }, ...sendOnly, ...invite },
  };
}

// ---------------------------------------------------------------------------
// Invitations
// ---------------------------------------------------------------------------

/** An invitation to join a space: a pairing slot and the secret that vouches for it. */
export interface Invite {
  pairingId: string;
  /** 256 bits, base64url. Out-of-band only: it must never reach the server. */
  secret: string;
}

export function createInvite(): Invite {
  return { pairingId: randomId(), secret: bufToBase64Url(randomBytes(32)) };
}

/** The code the joining device is given: `<pairingId>.<secret>`. */
export function formatInviteCode(invite: Invite): string {
  return `${invite.pairingId}.${invite.secret}`;
}

/** Parse an invitation code, or return null when it is not one. */
export function parseInviteCode(code: string): Invite | null {
  const match = /^([A-Za-z0-9_-]{16,64})\.([A-Za-z0-9_-]{43})$/.exec(code.trim());
  if (!match) return null;
  return { pairingId: match[1]!, secret: match[2]! };
}

/** Plaintext inside a seal. */
interface InviteSealPayload {
  deviceName: string;
}

async function inviteKey(invite: Invite): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    "raw",
    base64UrlToBuf(invite.secret),
    "HKDF",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new TextEncoder().encode(invite.pairingId),
      info: new TextEncoder().encode("sendself-pairing-invite:1"),
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Seal the joining device's name over the keys it publishes. */
export async function sealInvite(
  invite: Invite,
  deviceName: string,
  fields: InviteSealFields,
): Promise<string> {
  const iv = randomBytes(12);
  const payload: InviteSealPayload = { deviceName };
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData: new TextEncoder().encode(inviteSealStatement(fields)),
    },
    await inviteKey(invite),
    new TextEncoder().encode(JSON.stringify(payload)),
  );
  return `${bufToBase64Url(iv)}.${bufToBase64Url(ciphertext)}`;
}

/** The seal did not open: the keys are not the ones whoever holds the code published. */
export class InviteMismatchError extends Error {
  constructor() {
    super(
      "The device that answered could not prove it holds this code. Nothing was added; create a new code.",
    );
    this.name = "InviteMismatchError";
  }
}

/**
 * Open a seal, proving the keys in `fields` came from whoever holds the code.
 * Returns the joining device's name.
 */
export async function openInvite(
  invite: Invite,
  sealed: string,
  fields: InviteSealFields,
): Promise<string> {
  try {
    const [iv, ciphertext] = sealed.split(".");
    if (!iv || !ciphertext) throw new Error("malformed");
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: base64UrlToBuf(iv),
        additionalData: new TextEncoder().encode(inviteSealStatement(fields)),
      },
      await inviteKey(invite),
      base64UrlToBuf(ciphertext),
    );
    const payload = JSON.parse(new TextDecoder().decode(plaintext)) as InviteSealPayload;
    if (typeof payload.deviceName !== "string" || !payload.deviceName.trim()) {
      throw new Error("no name");
    }
    return payload.deviceName.trim().slice(0, 80);
  } catch {
    throw new InviteMismatchError();
  }
}

/**
 * A short code both sides of a pairing can show for the same keys, like
 * `4F2A-91C3`, so a person can check at a glance that the device asking to join
 * is the one they just started.
 */
export async function deviceFingerprint(
  publicKey: string,
  signingPublicKey: string,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${publicKey}:${signingPublicKey}`),
  );
  const hex = [...new Uint8Array(digest).slice(0, 4)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
  return `${hex.slice(0, 4)}-${hex.slice(4)}`;
}
