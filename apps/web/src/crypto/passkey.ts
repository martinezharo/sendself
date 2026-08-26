/**
 * Unlocking with a passkey, via WebAuthn's PRF extension.
 *
 * The authenticator holds a secret this app never sees and, given a salt,
 * returns 32 deterministic bytes derived from it — but only after the user has
 * proven presence (Face ID, a fingerprint, the device PIN). That is exactly the
 * shape the vault needs: same input, same key, and nothing to remember.
 *
 * Everything here degrades rather than breaks. PRF is not universal yet, so
 * support is *probed* by actually creating a credential and checking the
 * extension result instead of trusting a capability flag; when it comes back
 * unsupported the credential is discarded and the user is offered a passphrase.
 */

import { base64UrlToBuf, bufToBase64Url } from "./crypto";

/** The relying-party id is the origin's host: this is a same-device credential. */
function relyingParty(): PublicKeyCredentialRpEntity {
  return { id: window.location.hostname, name: "SendSelf" };
}

/** WebAuthn's PRF extension is not in the DOM lib yet. */
interface PrfExtensionResults {
  prf?: { enabled?: boolean; results?: { first?: ArrayBuffer } };
}

function prfResult(credential: PublicKeyCredential): ArrayBuffer | undefined {
  const results = credential.getClientExtensionResults() as PrfExtensionResults;
  return results.prf?.results?.first;
}

function saltBytes(salt: ArrayBuffer): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(salt.byteLength);
  bytes.set(new Uint8Array(salt));
  return bytes;
}

/** Whether this browser exposes WebAuthn at all (PRF is probed separately). */
export function passkeySupported(): boolean {
  return typeof window !== "undefined" && !!window.PublicKeyCredential;
}

export class PasskeyUnsupportedError extends Error {
  constructor() {
    super("This device's passkeys can't derive an encryption key. Use a passphrase instead.");
    this.name = "PasskeyUnsupportedError";
  }
}

/**
 * Create a passkey for this space and return the credential id plus the PRF
 * bytes to derive the vault from.
 *
 * `deviceName` only ever shows in the platform's own passkey UI; it is not the
 * space's device name reaching any server.
 */
export async function createPasskey(
  deviceName: string,
  salt: ArrayBuffer,
): Promise<{ credentialId: string; secret: ArrayBuffer }> {
  if (!passkeySupported()) throw new PasskeyUnsupportedError();

  const credential = (await navigator.credentials.create({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rp: relyingParty(),
      // A local, non-discoverable identity: the "user" is this device's copy of
      // the space, and no server ever verifies this credential.
      user: {
        id: crypto.getRandomValues(new Uint8Array(16)),
        name: deviceName,
        displayName: deviceName,
      },
      pubKeyCredParams: [
        { type: "public-key", alg: -7 },
        { type: "public-key", alg: -257 },
      ],
      authenticatorSelection: {
        authenticatorAttachment: "platform",
        residentKey: "required",
        userVerification: "required",
      },
      extensions: {
        prf: { eval: { first: saltBytes(salt) } },
      } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null;

  if (!credential) throw new PasskeyUnsupportedError();

  // Some authenticators only produce PRF output on an assertion, not at
  // creation. Ask once more before giving up on them.
  const secret =
    prfResult(credential) ?? (await evaluatePrf(bufToBase64Url(credential.rawId), salt));
  if (!secret) throw new PasskeyUnsupportedError();

  return { credentialId: bufToBase64Url(credential.rawId), secret };
}

/**
 * Re-derive the same bytes from an existing credential. Returns undefined when
 * the authenticator refuses to produce PRF output; a user cancellation throws,
 * so the two cases stay distinguishable to the caller.
 */
export async function evaluatePrf(
  credentialId: string,
  salt: ArrayBuffer,
): Promise<ArrayBuffer | undefined> {
  const credential = (await navigator.credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rpId: relyingParty().id,
      allowCredentials: [{ type: "public-key", id: base64UrlToBuf(credentialId) }],
      userVerification: "required",
      extensions: {
        prf: { eval: { first: saltBytes(salt) } },
      } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null;

  return credential ? prfResult(credential) : undefined;
}
