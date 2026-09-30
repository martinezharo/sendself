/**
 * The joining half of pairing: the identity a new device mints for itself and
 * what it publishes and shows so an existing device can add it.
 */

import type { PairingQrPayload, PairingRequestBody } from "@sendself/shared";
import {
  exportPublicKey,
  exportSigningPublicKey,
  generateDeviceKeyPair,
  generateSigningKeyPair,
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

/**
 * Mint a fresh identity and the two views of it pairing needs. The signing key
 * rides in the QR code too, so the adding device learns it out-of-band and can
 * attest to it for everyone else.
 */
export async function createJoiningDevice(deviceName: string): Promise<JoiningDevice> {
  const keyPair = await generateDeviceKeyPair();
  const signingKeyPair = await generateSigningKeyPair();
  const deviceId = randomId();
  const publicKey = await exportPublicKey(keyPair.publicKey);
  const signingPublicKey = await exportSigningPublicKey(signingKeyPair.publicKey);

  return {
    keyPair,
    signingKeyPair,
    payload: {
      v: 1,
      pairingId: randomId(),
      deviceId,
      deviceName,
      publicKey,
      signingPublicKey,
    },
    request: { device: { id: deviceId, publicKey, signingPublicKey } },
  };
}
