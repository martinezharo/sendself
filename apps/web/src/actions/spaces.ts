import { INITIAL_KEY_EPOCH, type PairingQrPayload } from "@sendself/shared";
import { signal } from "@preact/signals";
import { createJoiningDevice } from "@sendself/client/pairing";
import {
  clearSpaceNotifications,
  forgetPushForSpace,
  syncPushSubscription,
} from "../state/notifications";
import { applyHistoryRetention } from "../state/retention";
import { loadVault } from "../state/vaultItems";
import { NetworkError, api } from "../api/client";
import {
  encryptName,
  exportPublicKey,
  exportSigningPublicKey,
  generateDeviceKeyPair,
  generateGroupKey,
  generateSigningKeyPair,
  importGroupKey,
  randomId,
  randomToken,
  sha256Hex,
  unwrapPairingPackage,
} from "@sendself/client/crypto";
import {
  createAttestation,
  loadIdentities,
  pinScannedDevice,
  seedInheritedIdentities,
} from "../crypto/identity";
import { createKeyring } from "../crypto/keyring";
import {
  GLOBAL_PENDING_PAIRING,
  type SpaceRecord,
  globalMetaDelete,
  globalMetaGet,
  globalMetaSet,
} from "../db/spaces";
import { META_SIGNING_KEYPAIR, META_SIGNING_KEY_PUBLISHED, metaGet, metaSet } from "../db/store";
import { takeSharedContent } from "../share/incoming";
import { composerDraft, resetComposer, stageFiles } from "../state/composer";
import { trackPromoStep } from "../promo";
import { locked } from "../state/lock";
import { loadSpaceEvents, noteDeviceAdded } from "../state/events";
import { loadMessages } from "../state/messages";
import { APP_PATH, navigate, route, showSpaceSection, spacePath } from "../state/route";
import {
  applySigningKeyPair,
  authHeaders,
  deviceKeyPair,
  persistSession,
  session,
  sessionRevoked,
  signingKeyPair,
} from "../state/session";
import {
  activeSpace,
  beginSpace,
  closeSpace,
  forgetLastSpace,
  forgetSpace,
  openSpace,
  refreshSpaces,
} from "../state/spaces";
import { showToast } from "../state/ui";
import { startSync, stopSync } from "../sync/sync";
import type { LinkingState, Session } from "../types";

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

/**
 * `challengeToken` is the solved anti-abuse challenge (see `solveSpaceChallenge`),
 * when the server asks for one.
 */
export async function createSpace(
  deviceName: string,
  spaceName: string,
  challengeToken?: string,
): Promise<SpaceRecord> {
  // Registered (and made the active space) first, so everything below already
  // writes into its own storage rather than into whatever was open before.
  const space = await beginSpace(spaceName);
  try {
    await setUpNewSpace(deviceName, challengeToken);
  } catch (error) {
    // Nothing reached the server, or nothing that this device can use: leaving
    // a half-created space in the list would only offer a door into nowhere.
    await forgetSpace(space.id);
    throw error;
  }
  trackPromoStep("create-space");
  return space;
}

async function setUpNewSpace(deviceName: string, challengeToken?: string): Promise<void> {
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
    ...(challengeToken ? { challengeToken } : {}),
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
  const {
    keyPair,
    signingKeyPair: signingPair,
    payload,
    request,
  } = await createJoiningDevice(deviceName);
  const { pairingId, deviceId } = payload;
  await api.pairingRequest(pairingId, request);

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
    // The joining side of the same step: a visitor who came from a promo on
    // this device and linked it into a space started elsewhere.
    trackPromoStep("add-device");
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
// Session lifecycle
// ---------------------------------------------------------------------------

/**
 * Leave the active space on this device: its history, files and keys are wiped
 * here, while the space itself lives on for every other device in it.
 */
export async function leaveSpace(): Promise<void> {
  const space = activeSpace.value;
  if (!space) return;
  // Before the credentials are wiped: afterwards nothing could tell the server
  // to stop waking this browser for a space it no longer has.
  if (!(await forgetPushForSpace())) {
    showToast("Connect to the internet to leave this space, so its notifications stop", "error");
    return;
  }
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
  // Any route but the marketing page is the app: reached from the landing
  // page's call to action, a static page's link to /app, or a bookmark.
  if (current.name !== "landing") trackPromoStep("open-app");
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
  // Before loading, so history past the device's retention is never read into
  // memory just to be thrown away. A cleanup that fails costs nothing but room.
  await applyHistoryRetention().catch(() => 0);
  await loadMessages();
  await loadSpaceEvents();
  // Populate the local view of the space's devices before anything asks how
  // many there are. It reads from IndexedDB, so unlike the roster endpoint it
  // answers offline too — which is exactly when a device is most likely to be
  // queueing actions that depend on having peers.
  await loadIdentities();
  // The vault's local copy, so it opens instantly; the sync pass catches it up.
  await loadVault().catch(() => {});
  startSync();
  void ensureSigningIdentity();
  void syncPushSubscription();
  const spaceId = activeSpace.value?.id;
  if (spaceId) void clearSpaceNotifications(spaceId);
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
