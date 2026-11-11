import {
  type AssignableDeviceRole,
  type DeviceRole,
  PAIRING_TTL_MS,
  type PairingQrPayload,
} from "@sendself/shared";
import {
  type Invite,
  createInvite,
  deviceFingerprint,
  formatInviteCode,
  openInvite,
} from "@sendself/client/pairing";
import { api } from "../api/client";
import { agentSetupPrompt, linkCommand } from "../cli";
import {
  encryptName,
  exportGroupKey,
  importPublicKey,
  randomToken,
  sha256Hex,
  wrapPairingPackage,
} from "@sendself/client/crypto";
import { createAttestation, identityBundles, pinScannedDevice } from "../crypto/identity";
import { currentKey } from "../crypto/keyring";
import { decryptDeviceNames } from "../crypto/names";
import { trackPromoStep } from "../promo";
import { noteDeviceAdded, reconcileRoster } from "../state/events";
import { applyKeyring, authHeaders, keyring, session, signingKeyPair } from "../state/session";
import { activeSpace } from "../state/spaces";
import { DeviceKeyMismatchError, rotateGroupKey } from "../sync/rekey";

// ---------------------------------------------------------------------------
// Device management: add a new device (this device is an existing member)
// ---------------------------------------------------------------------------

export async function addDeviceFromQr(qrText: string): Promise<void> {
  let payload: PairingQrPayload;
  try {
    payload = JSON.parse(qrText) as PairingQrPayload;
  } catch {
    throw new Error("That does not look like a valid device code");
  }
  if (payload.v !== 1 || !payload.pairingId || !payload.publicKey || !payload.deviceId) {
    throw new Error("Unsupported or malformed device code");
  }
  await addDevice(payload);
}

/**
 * Add a device whose keys this device learned out-of-band — scanned from its QR
 * code, or proven by an invitation seal (see `checkDeviceInvite`).
 */
async function addDevice(payload: PairingQrPayload): Promise<void> {
  const currentSession = session.value;
  const ring = keyring.value;
  if (!currentSession || !ring) throw new Error("Not signed in");
  const currentGroupKey = currentKey(ring);

  const recipientPublicKey = await importPublicKey(payload.publicKey);
  const deviceAuthToken = randomToken();
  const wrapped = await wrapPairingPackage(
    recipientPublicKey,
    {
      groupKey: await exportGroupKey(currentGroupKey),
      keyEpoch: ring.current,
      deviceAuthToken,
      groupId: currentSession.groupId,
      // Hand over our verified view of the space along with the key: without it
      // the joining device would have to believe the server's roster, and would
      // have no trusted key to check any attestation against.
      roster: await identityBundles(),
      ...(activeSpace.value?.name ? { spaceName: activeSpace.value.name } : {}),
    },
    payload.pairingId,
  );

  // The QR was read out-of-band, so this is the one moment anyone learns this
  // device's keys through a channel the server cannot touch. Signing them is
  // what lets every *other* device verify this newcomer without having to
  // trust the roster it is served.
  const signingPair = signingKeyPair.value;
  const attestation =
    signingPair && payload.signingPublicKey
      ? await createAttestation(signingPair.privateKey, {
          groupId: currentSession.groupId,
          deviceId: payload.deviceId,
          publicKey: payload.publicKey,
          signingPublicKey: payload.signingPublicKey,
          signerDeviceId: currentSession.deviceId,
          issuedAt: Date.now(),
        })
      : undefined;
  // The joining device can't encrypt its own name (it has no GroupKey yet), so
  // this device encrypts the scanned (out-of-band) name on its behalf.
  const name = await encryptName(currentGroupKey, payload.deviceName, payload.deviceId);

  await api.pairingComplete(
    payload.pairingId,
    {
      wrappedPackage: wrapped.wrappedPackage,
      ephemeralPublicKey: wrapped.ephemeralPublicKey,
      scannedPublicKey: payload.publicKey,
      ...(payload.signingPublicKey ? { scannedSigningPublicKey: payload.signingPublicKey } : {}),
      ...(attestation ? { attestation } : {}),
      encryptedName: name.ciphertext,
      nameIv: name.iv,
      deviceAuthTokenHash: await sha256Hex(deviceAuthToken),
      keyEpoch: ring.current,
    },
    authHeaders(),
  );

  // Pin what we scanned: a later rotation refuses to wrap the new GroupKey for
  // a device whose key changed since, and messages from it are verified against
  // this signing key rather than whatever the roster later claims.
  await pinScannedDevice({
    deviceId: payload.deviceId,
    publicKey: payload.publicKey,
    ...(payload.signingPublicKey ? { signingPublicKey: payload.signingPublicKey } : {}),
  });
  // Recorded here rather than left to the roster diff: pinning the scanned keys
  // has just made this device part of what we know, so the next roster read
  // would see nothing new — and this is the one moment we know both that the
  // QR was scanned *here* and what the device is called.
  await noteDeviceAdded({
    deviceId: payload.deviceId,
    publicKey: payload.publicKey,
    name: payload.deviceName,
    trust: "scanned",
    byMe: true,
  });
  trackPromoStep("add-device");
}

/** An invitation this device is waiting on (see `InviteSealFields`). */
export interface DeviceInvite {
  invite: Invite;
  /** The command to paste on the machine joining the space. */
  command: string;
  /** The same, as a prompt that has an agent set itself up. */
  prompt: string;
  expiresAt: number;
}

/**
 * Invite a server, a script or an agent into the space as a send-only device.
 *
 * Nothing reaches the server here: the invitation is only a slot id and a
 * secret, shown to the person as a command. It becomes real when the machine
 * running that command answers, and a device when this one approves it.
 */
export function createDeviceInvite(): DeviceInvite {
  const invite = createInvite();
  const command = linkCommand(formatInviteCode(invite), window.location.origin);
  return {
    invite,
    command,
    prompt: agentSetupPrompt(command),
    expiresAt: Date.now() + PAIRING_TTL_MS,
  };
}

/** A device that answered an invitation, its keys already proven by the seal. */
export interface InviteAnswer {
  payload: PairingQrPayload;
  /** Shown by the CLI too, so a person can tell it is the machine they started. */
  fingerprint: string;
}

/**
 * Whether anyone has answered the invitation yet. Throws `InviteMismatchError`
 * when the answer was not sealed with the invitation's secret: the keys did not
 * come from whoever holds the code, so they must not be let in.
 */
export async function checkDeviceInvite(invite: Invite): Promise<InviteAnswer | null> {
  const answer = await api.pairingJoiner(invite.pairingId, authHeaders());
  if (!answer.present || !answer.device?.signingPublicKey || !answer.invite) return null;
  const { device } = answer;
  const signingPublicKey = device.signingPublicKey!;
  const sendOnly = answer.sendOnly === true;
  const deviceName = await openInvite(invite, answer.invite, {
    pairingId: invite.pairingId,
    deviceId: device.id,
    publicKey: device.publicKey,
    signingPublicKey,
    sendOnly,
  });
  return {
    payload: {
      v: 1,
      pairingId: invite.pairingId,
      deviceId: device.id,
      deviceName,
      publicKey: device.publicKey,
      signingPublicKey,
      ...(sendOnly ? { sendOnly: true as const } : {}),
    },
    fingerprint: await deviceFingerprint(device.publicKey, signingPublicKey),
  };
}

/** Let in the device that answered an invitation. */
export function approveInvitedDevice(answer: InviteAnswer): Promise<void> {
  return addDevice(answer.payload);
}

/** Fetch the group's devices and decrypt their names for display. */
export interface DeviceView {
  id: string;
  name: string;
  createdAt: number;
  role: DeviceRole;
  /** False while this device still has to pick up the latest key rotation. */
  keyUpToDate: boolean;
  /** Sends into the space but never receives, like the `sendself` CLI. */
  sendOnly: boolean;
}

export interface DeviceManagementView {
  devices: DeviceView[];
  currentRole: DeviceRole;
  /** A revocation is still waiting for its key rotation to land. */
  rotationPending: boolean;
}

export async function listDevicesDecrypted(): Promise<DeviceManagementView> {
  const ring = keyring.value;
  const currentSession = session.value;
  if (!ring || !currentSession) throw new Error("Not signed in");
  const { devices, currentRole, keyEpoch, rotationPending } = await api.listDevices(authHeaders());
  // Seeing the roster is also how a device learns the keys of members it did
  // not add itself, so this is where those get verified — and where a change
  // in it becomes a notice in the chat (state/events.ts).
  await reconcileRoster(devices, currentSession.groupId);
  const names = await decryptDeviceNames(ring, devices);
  return {
    currentRole,
    rotationPending,
    devices: devices.map((d) => ({
      id: d.id,
      createdAt: d.createdAt,
      role: d.role,
      keyUpToDate: d.keyEpoch >= keyEpoch,
      sendOnly: d.sendOnly,
      name: names.get(d.id) ?? d.id,
    })),
  };
}

/**
 * Revoke a device and immediately rotate the GroupKey, which is what actually
 * ends its access: revocation alone only closes the API to it, leaving it able
 * to decrypt any ciphertext it captures by other means.
 *
 * Rotation is reported separately because it can legitimately not happen here
 * (offline, or another device won the race). The server remembers the space
 * owes one, so the next device to poll finishes it — nothing is lost.
 */
export async function revokeDevice(deviceId: string): Promise<{ rotated: boolean }> {
  await api.revokeDevice(deviceId, authHeaders());
  return { rotated: await rotateNow() };
}

/** Run the rotation this space owes, if this device can. */
async function rotateNow(): Promise<boolean> {
  const currentSession = session.value;
  const ring = keyring.value;
  if (!currentSession || !ring) return false;
  try {
    const rotated = await rotateGroupKey(
      ring,
      currentSession.groupId,
      currentSession.deviceId,
      authHeaders(),
    );
    if (!rotated) return false;
    applyKeyring(rotated.keyring);
    return true;
  } catch (error) {
    if (error instanceof DeviceKeyMismatchError) throw error;
    // Anything else (offline, a racing rotation) is picked up by the sync loop.
    return false;
  }
}

export async function updateDeviceRole(
  deviceId: string,
  role: AssignableDeviceRole,
): Promise<void> {
  await api.updateDeviceRole(deviceId, role, authHeaders());
}
