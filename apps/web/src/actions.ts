import {
  type AssignableDeviceRole,
  type DeviceRole,
  INITIAL_KEY_EPOCH,
  MAX_FILE_SIZE,
  type PairingQrPayload,
} from "@sendself/shared";
import { signal } from "@preact/signals";
import { NetworkError, api } from "./api/client";
import {
  encryptName,
  exportGroupKey,
  exportPublicKey,
  exportSigningPublicKey,
  generateDeviceKeyPair,
  generateGroupKey,
  generateSigningKeyPair,
  importGroupKey,
  importPublicKey,
  randomId,
  randomToken,
  sha256Hex,
  unwrapPairingPackage,
  wrapPairingPackage,
} from "./crypto/crypto";
import {
  createAttestation,
  identityBundles,
  knownDeviceIds,
  loadIdentities,
  pinScannedDevice,
  seedInheritedIdentities,
} from "./crypto/identity";
import { createKeyring, currentKey } from "./crypto/keyring";
import { decryptDeviceNames } from "./crypto/names";
import { recordDeletion } from "./db/deletions";
import {
  GLOBAL_PENDING_PAIRING,
  type SpaceRecord,
  globalMetaDelete,
  globalMetaGet,
  globalMetaSet,
} from "./db/spaces";
import {
  META_SIGNING_KEYPAIR,
  META_SIGNING_KEY_PUBLISHED,
  getFile,
  metaGet,
  metaSet,
  putOutgoingFileMessages,
} from "./db/store";
import { takeSharedContent } from "./share/incoming";
import {
  clearComposer,
  composerDraft,
  resetComposer,
  stageFiles,
  stagedFiles,
  viewOnceArmed,
} from "./state/composer";
import { locked } from "./state/lock";
import { loadSpaceEvents, noteDeviceAdded, reconcileRoster } from "./state/events";
import {
  applyGlobalDeletion,
  applyMessageUpdate,
  discardMessage,
  loadMessages,
  upsertMessage,
} from "./state/messages";
import { APP_PATH, navigate, route, showSpaceSection, spacePath } from "./state/route";
import {
  applyKeyring,
  applySigningKeyPair,
  authHeaders,
  deviceKeyPair,
  keyring,
  persistSession,
  session,
  sessionRevoked,
  signingKeyPair,
} from "./state/session";
import {
  activeSpace,
  beginSpace,
  closeSpace,
  forgetLastSpace,
  forgetSpace,
  openSpace,
  refreshSpaces,
} from "./state/spaces";
import { showToast } from "./state/ui";
import { backgroundSyncSupported, requestBackgroundSync } from "./sync/background";
import { DeviceKeyMismatchError, rotateGroupKey } from "./sync/rekey";
import { startSync, stopSync, syncNow } from "./sync/sync";
import type { FileRef, LinkingState, LocalMessage, Session } from "./types";

/** Live state while linking THIS device to an existing space. */
export const linking = signal<LinkingState | null>(null);

interface PendingPairing {
  keyPair: CryptoKeyPair;
  /**
   * Optional only for a link that was already in flight when the app updated
   * to a version that signs: that device finishes pairing without an identity
   * and mints one on its next launch, like any other pre-signing device.
   */
  signingKeyPair?: CryptoKeyPair;
  payload: PairingQrPayload;
}

let linkTimer: ReturnType<typeof setInterval> | null = null;

// ---------------------------------------------------------------------------
// Onboarding: create a new space (this device becomes the first member)
// ---------------------------------------------------------------------------

export async function createSpace(deviceName: string, spaceName: string): Promise<SpaceRecord> {
  // Registered (and made the active space) first, so everything below already
  // writes into its own storage rather than into whatever was open before.
  const space = await beginSpace(spaceName);
  try {
    await setUpNewSpace(deviceName);
  } catch (error) {
    // Nothing reached the server, or nothing that this device can use: leaving
    // a half-created space in the list would only offer a door into nowhere.
    await forgetSpace(space.id);
    throw error;
  }
  return space;
}

async function setUpNewSpace(deviceName: string): Promise<void> {
  const keyPair = await generateDeviceKeyPair();
  const signingPair = await generateSigningKeyPair();
  const newGroupKey = await generateGroupKey();
  const token = randomToken();
  const groupId = randomId();
  const deviceId = randomId();
  const publicKey = await exportPublicKey(keyPair.publicKey);
  const signingPublicKey = await exportSigningPublicKey(signingPair.publicKey);
  const name = await encryptName(newGroupKey, deviceName, deviceId);

  // The founding device signs its own keys. It is the root every device that
  // joins later inherits, so "who belongs to this space" is anchored on the
  // device that created it instead of on the roster the server serves.
  const attestation = await createAttestation(signingPair.privateKey, {
    groupId,
    deviceId,
    publicKey,
    signingPublicKey,
    signerDeviceId: deviceId,
    issuedAt: Date.now(),
  });

  await api.createGroup({
    groupId,
    deviceAuthTokenHash: await sha256Hex(token),
    device: { id: deviceId, publicKey, signingPublicKey },
    encryptedName: name.ciphertext,
    nameIv: name.iv,
    attestation,
  });

  const newSession: Session = { groupId, deviceId, deviceName, deviceAuthToken: token };
  await persistSession(
    newSession,
    createKeyring(newGroupKey, INITIAL_KEY_EPOCH),
    keyPair,
    signingPair,
  );
  await pinScannedDevice({ deviceId, publicKey, signingPublicKey });
  await metaSet(META_SIGNING_KEY_PUBLISHED, true);
  await startSession();
}

// ---------------------------------------------------------------------------
// Signing identity (upgrade path for sessions that predate sender authenticity)
// ---------------------------------------------------------------------------

/** In-memory guard so a published key isn't re-checked on every sync pass. */
let signingKeyPublished = false;

/**
 * Make sure this device has a signing identity and that its peers know the
 * public half.
 *
 * A session created before sender authenticity has no signing keypair, and
 * asking the user to link the device again to get one would be exactly the kind
 * of disruption rotation was careful to avoid. So it mints one silently on the
 * next launch and announces it. Until that lands, the device simply sends
 * unsigned messages, which peers treat as unverifiable rather than forged.
 *
 * Safe to call repeatedly: it is a no-op once the key is published.
 */
export async function ensureSigningIdentity(): Promise<void> {
  if (signingKeyPublished || !session.value || sessionRevoked.value) return;
  if (await metaGet<boolean>(META_SIGNING_KEY_PUBLISHED)) {
    signingKeyPublished = true;
    return;
  }

  let pair = signingKeyPair.value;
  if (!pair) {
    pair = await generateSigningKeyPair();
    // Persist before publishing: announcing a key we then failed to store would
    // leave peers expecting signatures this device cannot produce.
    await metaSet(META_SIGNING_KEYPAIR, pair);
    applySigningKeyPair(pair);
  }

  const signingPublicKey = await exportSigningPublicKey(pair.publicKey);
  // Record our own identity locally either way: it is what makes the
  // attestations this device issues verifiable to the devices it adds.
  const ownKeyPair = deviceKeyPair.value;
  if (ownKeyPair) {
    await pinScannedDevice({
      deviceId: session.value.deviceId,
      publicKey: await exportPublicKey(ownKeyPair.publicKey),
      signingPublicKey,
    });
  }

  try {
    await api.publishSigningKey({ signingPublicKey }, authHeaders());
  } catch {
    // Offline, or the server already holds a different key for this device
    // (only possible after a local wipe that kept the session). Either way the
    // next launch tries again; messages stay unsigned meanwhile.
    return;
  }
  await metaSet(META_SIGNING_KEY_PUBLISHED, true);
  signingKeyPublished = true;
}

// ---------------------------------------------------------------------------
// Onboarding: link this device to an existing space (this device is the joiner)
// ---------------------------------------------------------------------------

export async function startLinking(deviceName: string): Promise<void> {
  const keyPair = await generateDeviceKeyPair();
  const signingPair = await generateSigningKeyPair();
  const deviceId = randomId();
  const pairingId = randomId();
  const publicKey = await exportPublicKey(keyPair.publicKey);
  const signingPublicKey = await exportSigningPublicKey(signingPair.publicKey);

  // The signing key rides in the QR code so the adding device learns it
  // out-of-band and can attest to it for everyone else.
  const payload: PairingQrPayload = {
    v: 1,
    pairingId,
    deviceId,
    deviceName,
    publicKey,
    signingPublicKey,
  };
  await api.pairingRequest(pairingId, { device: { id: deviceId, publicKey, signingPublicKey } });

  // The pairing belongs to no space yet — that is what it is trying to join —
  // so it waits in the device-global registry rather than in a space's storage.
  const pending: PendingPairing = { keyPair, signingKeyPair: signingPair, payload };
  await globalMetaSet(GLOBAL_PENDING_PAIRING, pending);

  linking.value = {
    pairingId,
    deviceId,
    deviceName,
    qrText: JSON.stringify(payload),
    status: "waiting",
  };
  startLinkPolling(pending);
}

/**
 * Resume an interrupted linking flow: after a reload, and whenever the user
 * comes back to the space list from a space (linking is offered there, and a
 * pairing that was in flight should not have to be started again).
 */
export async function resumeLinking(): Promise<void> {
  if (linking.value || locked.value) return;
  const pending = await globalMetaGet<PendingPairing>(GLOBAL_PENDING_PAIRING);
  if (!pending) return;
  linking.value = {
    pairingId: pending.payload.pairingId,
    deviceId: pending.payload.deviceId,
    deviceName: pending.payload.deviceName,
    qrText: JSON.stringify(pending.payload),
    status: "waiting",
  };
  startLinkPolling(pending);
}

function startLinkPolling(pending: PendingPairing): void {
  stopLinkPolling();
  linkTimer = setInterval(() => void pollLink(pending), 2500);
}

function stopLinkPolling(): void {
  if (linkTimer) clearInterval(linkTimer);
  linkTimer = null;
}

/**
 * Put a linking flow on hold while the user is inside a space.
 *
 * Completing a pairing switches the app to the space it just joined, which
 * would be a rude thing to do to someone who has since navigated into another
 * one. The pairing itself is untouched — it is still valid server-side, and
 * `resumeLinking` picks it up when the space list comes back into view.
 */
export function pauseLinking(): void {
  stopLinkPolling();
  linking.value = null;
}

async function pollLink(pending: PendingPairing): Promise<void> {
  const { keyPair, signingKeyPair: signingPair, payload } = pending;
  const pairingId = payload.pairingId;
  try {
    const result = await api.pairingPoll(pairingId);
    if (!result.ready || !result.wrappedPackage || !result.ephemeralPublicKey) return;

    stopLinkPolling();
    const recovered = await unwrapPairingPackage(
      keyPair.privateKey,
      result.ephemeralPublicKey,
      result.wrappedPackage,
      pairingId,
    );
    const recoveredGroupKey = await importGroupKey(recovered.groupKey);
    const newSession: Session = {
      groupId: recovered.groupId,
      deviceId: payload.deviceId,
      deviceName: payload.deviceName,
      deviceAuthToken: recovered.deviceAuthToken,
    };
    // The space's name travels inside the encrypted package, so a linked device
    // recognises the space by the name it was given instead of by an id.
    const space = await beginSpace(recovered.spaceName ?? null);
    // The space may have rotated its key long before this device existed, so
    // the keyring starts at the epoch it was handed, not at 1.
    await persistSession(
      newSession,
      createKeyring(recoveredGroupKey, recovered.keyEpoch),
      keyPair,
      signingPair,
    );
    // A link started before this device had a signing identity gets one on the
    // next launch instead — the QR its introducer scanned carried no signing
    // key, so there is nothing to attest to now anyway.
    if (signingPair) await metaSet(META_SIGNING_KEY_PUBLISHED, true);
    // The package came through a channel anchored out-of-band (the introducer
    // scanned our QR), so the roster inside it is the trusted starting point
    // for everything this device will verify from now on.
    if (recovered.roster) await seedInheritedIdentities(recovered.roster);
    await pinScannedDevice({
      deviceId: payload.deviceId,
      publicKey: payload.publicKey,
      ...(payload.signingPublicKey ? { signingPublicKey: payload.signingPublicKey } : {}),
    });
    // The thread this device is about to open starts here: it has no history
    // from before it joined, and saying so beats an unexplained empty chat.
    await noteDeviceAdded({
      deviceId: payload.deviceId,
      publicKey: payload.publicKey,
      name: payload.deviceName,
      trust: "inherited",
    });
    await globalMetaDelete(GLOBAL_PENDING_PAIRING);
    // Best-effort: the slot is already TTL-reaped by cron, this just avoids
    // leaving the (encrypted) package reachable until then.
    void api.pairingDelete(pairingId).catch(() => {});
    await startSession();
    linking.value = null;
    navigate(spacePath(space.id));
    showToast("Device linked successfully");
  } catch (error) {
    // A flaky network on a phone is the rule, not the exception: the next
    // tick (2.5 s) should get a fresh chance. Only kill the loop and surface
    // a hard error for things that retrying cannot fix (decrypt failure,
    // malformed QR, etc.).
    if (error instanceof NetworkError) return;
    stopLinkPolling();
    linking.value = linking.value
      ? { ...linking.value, status: "error", error: errorMessage(error) }
      : null;
  }
}

export async function cancelLinking(): Promise<void> {
  stopLinkPolling();
  linking.value = null;
  await globalMetaDelete(GLOBAL_PENDING_PAIRING);
}

// ---------------------------------------------------------------------------
// Device management: add a new device (this device is an existing member)
// ---------------------------------------------------------------------------

export async function addDeviceFromQr(qrText: string): Promise<void> {
  const currentSession = session.value;
  const ring = keyring.value;
  if (!currentSession || !ring) throw new Error("Not signed in");
  const currentGroupKey = currentKey(ring);

  let payload: PairingQrPayload;
  try {
    payload = JSON.parse(qrText) as PairingQrPayload;
  } catch {
    throw new Error("That does not look like a valid device code");
  }
  if (payload.v !== 1 || !payload.pairingId || !payload.publicKey || !payload.deviceId) {
    throw new Error("Unsupported or malformed device code");
  }

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
}

/** Fetch the group's devices and decrypt their names for display. */
export interface DeviceView {
  id: string;
  name: string;
  createdAt: number;
  role: DeviceRole;
  /** False while this device still has to pick up the latest key rotation. */
  keyUpToDate: boolean;
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

// ---------------------------------------------------------------------------
// Messaging
// ---------------------------------------------------------------------------

/**
 * Kick the queued send on its way: flush immediately from the page and, where
 * supported, register a background sync so the service worker finishes the
 * job even if the app is closed before the upload completes.
 */
function scheduleOutboxFlush(): void {
  void syncNow();
  void requestBackgroundSync();
}

/** Everything one press of the send button turns into messages. */
export interface ComposerContent {
  text?: string;
  files?: readonly File[];
  viewOnce?: boolean;
}

/**
 * Send whatever the composer is holding.
 *
 * One entry point for text, files and both together, replacing the separate
 * `sendTextMessage`/`sendFileMessages` that could not produce a message
 * carrying both — even though the wire format has always allowed it (a
 * `messages` row has the text and file columns side by side, and the Worker
 * only requires one of them to be present).
 *
 * A selection of several files still becomes several messages. They share a
 * batch id so the other devices render them as one album under one caption,
 * but each keeps its own delivery row and its own resumable upload: fusing
 * them into a single message or a single archive would turn "three of five
 * arrived" into "none of one" the moment a background pass is cut short.
 */
export async function sendComposerMessage(content: ComposerContent): Promise<void> {
  const currentSession = session.value;
  if (!currentSession || !keyring.value) return;

  const text = content.text?.trim() ?? "";
  const files = content.files ?? [];
  if (!text && files.length === 0) return;

  const viewOnce = content.viewOnce ? (true as const) : undefined;
  const sender = {
    direction: "out" as const,
    senderDeviceId: currentSession.deviceId,
    senderDeviceName: currentSession.deviceName,
    status: "queued" as const,
  };
  // One base timestamp with an offset per item, so an album keeps the order it
  // was picked in rather than the order the clock happened to tick.
  const createdAt = Date.now();

  if (files.length === 0) {
    await upsertMessage({
      id: randomId(),
      ...sender,
      text,
      viewOnce,
      createdAt,
    });
    scheduleOutboxFlush();
    return;
  }

  // Only a real batch gets a batch id: a lone file is not an album, and
  // tagging it as one would make the receiver draw a group of one.
  const batchId = files.length > 1 ? randomId() : undefined;
  const entries = files.map((file, index) => {
    const message: LocalMessage = {
      id: randomId(),
      ...sender,
      // The caption belongs to the selection, so it rides on the first message
      // and the album renders it once, underneath the group.
      ...(index === 0 && text ? { text } : {}),
      file: {
        r2Key: randomId(),
        iv: "",
        name: file.name,
        size: file.size,
        mime: file.type || "application/octet-stream",
      },
      ...(batchId ? { batch: { id: batchId, index, count: files.length } } : {}),
      viewOnce,
      createdAt: createdAt + index,
      fileState: "downloaded",
    };
    return { message, blob: file };
  });

  // Commit the complete selection before starting any upload: kicking the sync
  // loop per file used to freeze the first upload while the rest of the
  // selection had not even joined the outbox yet.
  await putOutgoingFileMessages(entries);
  for (const { message } of entries) applyMessageUpdate(message);
  scheduleOutboxFlush();

  // Tell the user what will happen to their upload(s) beyond this screen.
  if (!navigator.onLine) {
    showToast(
      backgroundSyncSupported()
        ? "You're offline — uploads will continue in the background once you reconnect"
        : "You're offline — uploads will resume when you're back online (keep the app open)",
    );
  }
}

/** Send what the composer currently holds, then empty it. */
export async function sendStagedComposer(): Promise<void> {
  const text = composerDraft.value;
  const files = stagedFiles.value.map((staged) => staged.file);
  const viewOnce = viewOnceArmed.value;
  if (!text.trim() && files.length === 0) return;

  // Cleared first: the send is queued to IndexedDB and retried from there, so
  // leaving the content in the composer until it lands would only invite it to
  // be sent twice.
  clearComposer();
  await sendComposerMessage({ text, files, viewOnce });
}

/** Re-queue a failed outgoing message and try again. */
export async function retryMessage(message: LocalMessage): Promise<void> {
  if (message.direction !== "out" || message.status !== "failed") return;
  await upsertMessage({ ...message, status: "queued" });
  scheduleOutboxFlush();
}

/** Trigger a browser download of a (already decrypted, locally cached) file. */
export async function saveFile(message: LocalMessage): Promise<void> {
  if (!message.file) return;
  const blob = await getFile(message.file.r2Key);
  if (!blob) {
    showToast("File is no longer available", "error");
    return;
  }
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = message.file.name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------------------------------------------------------------------------
// Message actions (context menu)
// ---------------------------------------------------------------------------

export async function copyMessageText(message: LocalMessage): Promise<void> {
  if (!message.text) return;
  try {
    await navigator.clipboard.writeText(message.text);
    showToast("Copied to clipboard");
  } catch {
    showToast("Couldn't copy to clipboard", "error");
  }
}

/** Whether the Web Share API can plausibly share this message from here. */
export function canShareMessage(message: LocalMessage): boolean {
  if (typeof navigator.share !== "function") return false;
  if (message.text) return true;
  // Files can only be shared once the decrypted blob is cached locally.
  return !!message.file && message.fileState === "downloaded";
}

export async function shareMessage(message: LocalMessage): Promise<void> {
  try {
    if (message.text) {
      await navigator.share({ text: message.text });
      return;
    }
    if (!message.file) return;
    const blob = await getFile(message.file.r2Key);
    if (!blob) {
      showToast("File is no longer available", "error");
      return;
    }
    const file = new File([blob], message.file.name, { type: message.file.mime });
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file] });
    } else {
      showToast("Sharing files isn't supported on this device", "error");
    }
  } catch (error) {
    // The user dismissing the share sheet is not an error.
    if (error instanceof DOMException && error.name === "AbortError") return;
    showToast("Couldn't share", "error");
  }
}

/**
 * Delete a message from THIS device only (other devices keep their copy).
 * An incoming message the server still lists as pending must be acked first,
 * otherwise the next sync pass would just re-download it.
 */
export async function deleteMessageLocally(message: LocalMessage): Promise<void> {
  if (message.direction === "in" && !message.acked) {
    try {
      await api.ackMessage(message.id, authHeaders());
    } catch {
      showToast("Couldn't delete — check your connection and try again", "error");
      return;
    }
  }
  await discardMessage(message);
  showToast("Deleted on this device");
}

/**
 * Whether "delete for everyone" would actually do anything for this message.
 *
 * It is offered only when some *other* device can be holding a copy, which
 * rules out two cases where the global delete would be a more frightening name
 * for what the local one already does:
 *
 *  - a space with no other device linked, so there is nobody to tell;
 *  - an outgoing message that never left this device (still queued, or failed),
 *    so no copy of it exists anywhere else.
 *
 * Note that "the server no longer stores it" is deliberately *not* a reason to
 * hide it: the server drops a message as soon as every device has downloaded
 * it, which is precisely when the only copies left are the ones on those
 * devices — the copies this action exists to remove.
 */
export function canDeleteEverywhere(message: LocalMessage): boolean {
  const currentSession = session.value;
  if (!currentSession) return false;
  if (message.deletes) return false;
  const peers = knownDeviceIds.value.filter((id) => id !== currentSession.deviceId);
  if (peers.length === 0) return false;
  return message.direction === "in" || message.status === "sent";
}

/**
 * Delete a message from every device in the space.
 *
 * The local copy goes immediately and a tombstone is queued for the others.
 * Queued rather than sent inline on purpose: it then inherits the outbox's
 * retries, its Web Lock and Background Sync, so a deletion asked for on a train
 * still lands when the connection comes back, and the app being closed in the
 * meantime does not lose it.
 *
 * The order matters. The id is recorded as deleted (inside `applyGlobalDeletion`)
 * *before* anything is sent, so a copy of the message that is still in flight is
 * dropped when it arrives instead of quietly reappearing in the history the user
 * just cleared.
 */
async function queueGlobalDeletion(messageId: string): Promise<void> {
  const currentSession = session.value;
  if (!currentSession) return;
  await upsertMessage({
    id: randomId(),
    direction: "out",
    senderDeviceId: currentSession.deviceId,
    deletes: messageId,
    createdAt: Date.now(),
    status: "queued",
  });
  scheduleOutboxFlush();
}

export async function deleteMessageEverywhere(message: LocalMessage): Promise<void> {
  if (!session.value || !canDeleteEverywhere(message)) return;

  await applyGlobalDeletion(message.id);
  await queueGlobalDeletion(message.id);

  showToast(
    navigator.onLine
      ? "Deleting on all your devices"
      : "Deleted here — your other devices will follow when you're back online",
  );
}

/**
 * Open a view-once message: retract it from every *other* device now, and keep
 * the local copy only until the reader closes it.
 *
 * The split is what makes "disappears once opened" true rather than
 * approximately true. Retracting on open (instead of on close) means a second
 * device can no longer reach it from the moment the first one does; keeping
 * the local row until `releaseViewOnce` means the person who opened it gets to
 * finish reading. `recordDeletion` runs first either way, so a copy of the
 * message still in flight is dropped on arrival instead of reappearing.
 *
 * A device with no peers has nobody to tell, so it only records and discards.
 */
export async function consumeViewOnce(message: LocalMessage): Promise<void> {
  const currentSession = session.value;
  if (!currentSession || !message.viewOnce) return;

  await recordDeletion(message.id);
  const peers = knownDeviceIds.value.filter((id) => id !== currentSession.deviceId);
  if (peers.length > 0) await queueGlobalDeletion(message.id);
}

/** The reader closed a view-once message: erase what is left of it here. */
export async function releaseViewOnce(message: LocalMessage): Promise<void> {
  await discardMessage(message);
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

/**
 * Leave the active space on this device: its history, files and keys are wiped
 * here, while the space itself lives on for every other device in it.
 */
export async function leaveSpace(): Promise<void> {
  const space = activeSpace.value;
  if (!space) return;
  stopSync();
  // The next space this device joins mints its own identity, so the guard must
  // not carry the previous session's answer over.
  signingKeyPublished = false;
  await forgetSpace(space.id);
  navigate(APP_PATH);
}

// ---------------------------------------------------------------------------
// Web Share Target
// ---------------------------------------------------------------------------

/** This launch came from the OS share sheet and still owes a space its content. */
let sharePending = false;

export function noteSharedContent(): void {
  sharePending = true;
}

export function hasPendingShare(): boolean {
  return sharePending;
}

/**
 * Hand the shared content to the space that is now open: text prefills the
 * composer for review, files are queued like any other upload.
 *
 * It waits for a space rather than failing without one, because the share sheet
 * cannot know which space the user meant — so the app asks, and delivers the
 * content to whichever one they open.
 */
export async function consumeSharedContent(): Promise<void> {
  if (!sharePending || !session.value) return;
  sharePending = false;

  const { text, files } = await takeSharedContent();
  showSpaceSection("chat");
  // Staged rather than sent: a share that carries both text and files used to
  // arrive as a draft plus N separate messages, with no way to make the text
  // the caption of what came with it. Now it lands as one composer the user
  // can review, extend and send in one go.
  if (text) composerDraft.value = composerDraft.value ? `${composerDraft.value}\n${text}` : text;
  if (files.length > 0) {
    const staged = stageFiles(files);
    if (staged > 0) {
      showToast(staged === 1 ? "Shared file added" : `${staged} shared files added`);
    }
  }
}

// ---------------------------------------------------------------------------
// Route ↔ space
// ---------------------------------------------------------------------------

/**
 * Bring the app in line with the URL: open the space the route names, or leave
 * whichever one was open when it stops naming any.
 *
 * This is the single place a space is entered or left, so the sync loop, the
 * linking flow and the in-memory session cannot end up belonging to a space
 * other than the one on screen.
 */
export async function applyRoute(): Promise<void> {
  const current = route.value;
  if (locked.value) return;

  if (current.name !== "space") {
    if (activeSpace.value) {
      stopSync();
      closeSpace();
      // A draft, a queue of attachments and the view-once mode all belong to
      // the space that was open; carrying them into the next one would attach
      // the wrong files to the wrong conversation.
      resetComposer();
    }
    if (current.name === "spaces") {
      // Standing on the list is where the app is now: the next launch opens
      // here rather than stepping back into the space just left.
      await forgetLastSpace();
      // Linking is offered from the space list, and a pairing that was in
      // flight before the user stepped into a space is still valid.
      await resumeLinking();
    }
    return;
  }

  if (activeSpace.value?.id === current.spaceId) return;
  if (activeSpace.value) {
    stopSync();
    closeSpace();
  }
  pauseLinking();

  if (!(await openSpace(current.spaceId))) {
    // A bookmark to a space this device no longer has (left here, or never
    // linked on this one). The list is the honest place to land.
    navigate(APP_PATH, { replace: true });
    showToast("That space isn't on this device", "error");
    return;
  }
  if (session.value) await startSession();
  await consumeSharedContent();
}

/** Everything the app can only do once the device is unlocked. */
export async function resumeAfterUnlock(): Promise<void> {
  await refreshSpaces();
  await applyRoute();
}

/**
 * Bring the app up for a device that has a session: load history, start
 * syncing, make sure this device has a signing identity.
 *
 * Called both from `bootstrap()` and after a successful unlock — a locked
 * device simply could not do any of it earlier, because until the secret
 * arrived there was no session and no readable history. Kept as one function so
 * the two paths cannot drift into starting the app up differently.
 */
export async function startSession(): Promise<void> {
  await loadMessages();
  await loadSpaceEvents();
  // Populate the local view of the space's devices before anything asks how
  // many there are. It reads from IndexedDB, so unlike the roster endpoint it
  // answers offline too — which is exactly when a device is most likely to be
  // queueing actions that depend on having peers.
  await loadIdentities();
  startSync();
  void ensureSigningIdentity();
}

/**
 * The server rejected this device's credentials for good. Every request from
 * now on would fail the same way, so stop the loops that would otherwise retry
 * forever and flag the session so the UI can tell the user to link again.
 */
export function handleAuthFailure(): void {
  if (sessionRevoked.value || !session.value) return;
  sessionRevoked.value = true;
  stopSync();
  stopLinkPolling();
  // A space this device was thrown out of is not a place to reopen into. The
  // notice covering it cannot be dismissed, so resuming here on the next launch
  // would put every *other* space on this device out of reach until this one is
  // left — which is a choice the user should be making from the list, not from
  // behind a modal they cannot close.
  void forgetLastSpace();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
