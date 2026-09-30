/**
 * End-to-end verification against a running `wrangler dev` (http://localhost:8787).
 *
 * Simulates several devices doing the real flow with the REAL crypto core:
 *  create group -> pair device B -> send text + file -> B fetches/decrypts/acks
 *  -> server deletes file & metadata -> revoke B -> rotate the GroupKey and
 *  check the revoked device can no longer read anything sent afterwards.
 *  Sender authenticity rides along: A and B sign what they send and attest to
 *  each other's keys, while groups C/D stay unsigned to prove that a device
 *  from before signing existed keeps working untouched.
 *
 * Run with: node scripts/e2e-verify.mts
 */

import {
  type DeviceAttestation,
  attestationStatement,
  messageSignatureStatement,
} from "../packages/shared/src/index.ts";
import {
  decryptFile,
  decryptJson,
  decryptText,
  encryptFile,
  encryptJson,
  encryptName,
  encryptText,
  exportGroupKey,
  exportPublicKey,
  exportSigningPublicKey,
  generateDeviceKeyPair,
  generateGroupKey,
  generateSigningKeyPair,
  importGroupKey,
  importPublicKey,
  importSigningPublicKey,
  randomId,
  randomToken,
  rekeyContext,
  sha256Hex,
  signStatement,
  unwrapPairingPackage,
  unwrapSecret,
  verifyStatement,
  wrapPairingPackage,
  wrapSecret,
} from "../packages/client/src/crypto.ts";

const BASE = process.env.BASE_URL ?? "http://localhost:8787";

let failures = 0;
function check(name: string, condition: boolean): void {
  const ok = condition;
  if (!ok) failures++;
  console.log(`${ok ? "✅" : "❌"} ${name}`);
}

interface Auth {
  token: string;
}
function headers(auth?: Auth, extra: Record<string, string> = {}): Record<string, string> {
  const h: Record<string, string> = { ...extra };
  if (auth) {
    h.Authorization = `Bearer ${auth.token}`;
  }
  return h;
}
async function postJson(path: string, body: unknown, auth?: Auth): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    method: "POST",
    headers: headers(auth, { "Content-Type": "application/json" }),
    body: JSON.stringify(body),
  });
}

/** A device's signing identity, as the sender half of authenticity needs it. */
interface Signer {
  deviceId: string;
  privateKey: CryptoKey;
}

/**
 * Send a message the way a real client does: signed when the sending device has
 * published a signing key, unsigned when it predates them.
 */
async function sendMessage(
  groupId: string,
  body: Record<string, unknown> & { id: string; keyEpoch: number },
  auth: Auth,
  signer?: Signer,
): Promise<Response> {
  const signature = signer
    ? await signStatement(
        signer.privateKey,
        messageSignatureStatement({
          groupId,
          messageId: body.id,
          senderDeviceId: signer.deviceId,
          keyEpoch: body.keyEpoch,
          encryptedPayload: body.encryptedPayload as string | undefined,
          iv: body.iv as string | undefined,
          fileR2Key: body.fileR2Key as string | undefined,
          fileIv: body.fileIv as string | undefined,
          fileMeta: body.fileMeta as string | undefined,
          fileMetaIv: body.fileMetaIv as string | undefined,
        }),
      )
    : undefined;
  return postJson("/api/messages", signature ? { ...body, signature } : body, auth);
}

// --- Device A: create the space -------------------------------------------
const aKeys = await generateDeviceKeyPair();
const groupKey = await generateGroupKey();
const token = randomToken();
const groupId = randomId();
const aId = randomId();
const aAuth: Auth = { token };

const aSigning = await generateSigningKeyPair();
const aPublic = await exportPublicKey(aKeys.publicKey);
const aSigningPublic = await exportSigningPublicKey(aSigning.publicKey);
const aSigner: Signer = { deviceId: aId, privateKey: aSigning.privateKey };

// The founding device vouches for itself: the root of the trust chain.
const aAttestationFields = {
  groupId,
  deviceId: aId,
  publicKey: aPublic,
  signingPublicKey: aSigningPublic,
  signerDeviceId: aId,
  issuedAt: Date.now(),
};
const aAttestation: DeviceAttestation = {
  ...aAttestationFields,
  signature: await signStatement(aSigning.privateKey, attestationStatement(aAttestationFields)),
};

const aName = await encryptName(groupKey, "Device A", aId);
const createRes = await postJson("/api/groups", {
  groupId,
  deviceAuthTokenHash: await sha256Hex(token),
  device: { id: aId, publicKey: aPublic, signingPublicKey: aSigningPublic },
  encryptedName: aName.ciphertext,
  nameIv: aName.iv,
  attestation: aAttestation,
});
check("create group returns 200", createRes.ok);

// --- Device B: request pairing slot ---------------------------------------
const bKeys = await generateDeviceKeyPair();
const bSigning = await generateSigningKeyPair();
const bId = randomId();
const pairingId = randomId();
const bPublic = await exportPublicKey(bKeys.publicKey);
const bSigningPublic = await exportSigningPublicKey(bSigning.publicKey);
const bToken = randomToken();
const reqRes = await postJson(`/api/pairing/${pairingId}/request`, {
  device: { id: bId, publicKey: bPublic, signingPublicKey: bSigningPublic },
});
check("pairing request returns 200", reqRes.ok);

// --- Device A: wrap GroupKey for B and complete ---------------------------
const recipientPub = await importPublicKey(bPublic);
const wrapped = await wrapPairingPackage(
  recipientPub,
  {
    groupKey: await exportGroupKey(groupKey),
    keyEpoch: 1,
    deviceAuthToken: bToken,
    groupId,
    roster: [
      { deviceId: aId, publicKey: aPublic, signingPublicKey: aSigningPublic },
      { deviceId: bId, publicKey: bPublic, signingPublicKey: bSigningPublic },
    ],
  },
  pairingId,
);

// A scanned B's QR out-of-band, so it signs what it saw: this is what lets
// every other device verify B without ever meeting it.
const bAttestationFields = {
  groupId,
  deviceId: bId,
  publicKey: bPublic,
  signingPublicKey: bSigningPublic,
  signerDeviceId: aId,
  issuedAt: Date.now(),
};
const bAttestation: DeviceAttestation = {
  ...bAttestationFields,
  signature: await signStatement(aSigning.privateKey, attestationStatement(bAttestationFields)),
};

const bName = await encryptName(groupKey, "Device B", bId);
const completeRes = await postJson(
  `/api/pairing/${pairingId}/complete`,
  {
    wrappedPackage: wrapped.wrappedPackage,
    ephemeralPublicKey: wrapped.ephemeralPublicKey,
    scannedPublicKey: bPublic,
    scannedSigningPublicKey: bSigningPublic,
    attestation: bAttestation,
    encryptedName: bName.ciphertext,
    nameIv: bName.iv,
    deviceAuthTokenHash: await sha256Hex(bToken),
    keyEpoch: 1,
  },
  aAuth,
);
check("pairing complete returns 200", completeRes.ok);

// An attestation that vouches for a different device must be refused outright.
const strayPairingId = randomId();
const strayKeys = await generateDeviceKeyPair();
const strayPublic = await exportPublicKey(strayKeys.publicKey);
const strayId = randomId();
await postJson(`/api/pairing/${strayPairingId}/request`, {
  device: { id: strayId, publicKey: strayPublic, signingPublicKey: bSigningPublic },
});
const strayComplete = await postJson(
  `/api/pairing/${strayPairingId}/complete`,
  {
    wrappedPackage: wrapped.wrappedPackage,
    ephemeralPublicKey: wrapped.ephemeralPublicKey,
    scannedPublicKey: strayPublic,
    scannedSigningPublicKey: bSigningPublic,
    attestation: bAttestation,
    encryptedName: bName.ciphertext,
    nameIv: bName.iv,
    deviceAuthTokenHash: await sha256Hex(randomToken()),
    keyEpoch: 1,
  },
  aAuth,
);
check("an attestation for another device is rejected", strayComplete.status === 400);

// --- Device B: poll, unwrap, recover the GroupKey -------------------------
const pollRes = await fetch(`${BASE}/api/pairing/${pairingId}`);
const poll = (await pollRes.json()) as {
  ready: boolean;
  wrappedPackage?: string;
  ephemeralPublicKey?: string;
};
check("pairing poll is ready", poll.ready === true);
const recovered = await unwrapPairingPackage(
  bKeys.privateKey,
  poll.ephemeralPublicKey!,
  poll.wrappedPackage!,
  pairingId,
);
check("B recovered the correct groupId", recovered.groupId === groupId);
check("B recovered its own auth token", recovered.deviceAuthToken === bToken);
const bGroupKey = await importGroupKey(recovered.groupKey);
const bAuth: Auth = { token: recovered.deviceAuthToken };

// --- Device A: send a text message ----------------------------------------
const plaintext = "Hello from A 🌍 — secret!";
const textId = randomId();
const encText = await encryptText(groupKey, plaintext, `text:${textId}`);
const sendTextRes = await sendMessage(
  groupId,
  { id: textId, keyEpoch: 1, encryptedPayload: encText.ciphertext, iv: encText.iv },
  aAuth,
  aSigner,
);
check("send text returns 200", sendTextRes.ok);
check("server payload is ciphertext (not plaintext)", encText.ciphertext !== plaintext);

// A published a signing key, so its peers expect every message to carry one.
const unsignedRes = await postJson(
  "/api/messages",
  { id: randomId(), keyEpoch: 1, encryptedPayload: encText.ciphertext, iv: encText.iv },
  aAuth,
);
check("an unsigned message from a signing device is rejected", unsignedRes.status === 400);

// --- Device A: send a file message ----------------------------------------
const original = new Uint8Array(1024 * 1024); // 1 MB
for (let off = 0; off < original.length; off += 65536) {
  crypto.getRandomValues(original.subarray(off, Math.min(off + 65536, original.length)));
}
const r2Key = randomId();
const fileId = randomId();
const encFile = await encryptFile(groupKey, original.buffer, `file:${fileId}`);
const upRes = await fetch(`${BASE}/api/files/${r2Key}`, {
  method: "PUT",
  headers: headers(aAuth),
  body: encFile.ciphertext,
});
check("file upload returns 200", upRes.ok);
const metaEnc = await encryptJson(
  groupKey,
  {
    name: "secret.bin",
    size: original.byteLength,
    mime: "application/octet-stream",
  },
  `meta:${fileId}`,
);
const sendFileRes = await sendMessage(
  groupId,
  {
    id: fileId,
    keyEpoch: 1,
    fileR2Key: r2Key,
    fileIv: encFile.iv,
    fileMeta: metaEnc.ciphertext,
    fileMetaIv: metaEnc.iv,
  },
  aAuth,
  aSigner,
);
check("send file message returns 200", sendFileRes.ok);

// --- Device B: fetch pending, decrypt, verify -----------------------------
const pendingRes = await fetch(`${BASE}/api/messages/pending`, { headers: headers(bAuth) });
const pending = (await pendingRes.json()) as { messages: any[] };
check("B has 2 pending messages", pending.messages.length === 2);

const textMsg = pending.messages.find((m) => m.id === textId);
const fileMsg = pending.messages.find((m) => m.id === fileId);
check("text message present for B", !!textMsg);
check(
  "B decrypts text to original plaintext",
  textMsg &&
    (await decryptText(bGroupKey, textMsg.encryptedPayload, textMsg.iv, `text:${textId}`)) ===
      plaintext,
);

// --- Sender authenticity: B verifies A really sent that text --------------
const aVerifyKey = await importSigningPublicKey(aSigningPublic);
const textStatement = (message: any, senderDeviceId = message.senderDeviceId): string =>
  messageSignatureStatement({
    groupId,
    messageId: message.id,
    senderDeviceId,
    keyEpoch: message.keyEpoch,
    encryptedPayload: message.encryptedPayload,
    iv: message.iv,
    fileR2Key: message.fileR2Key,
    fileIv: message.fileIv,
    fileMeta: message.fileMeta,
    fileMetaIv: message.fileMetaIv,
  });
check("the message carries a signature", typeof textMsg?.signature === "string");
check(
  "B verifies the signature against A's published key",
  await verifyStatement(aVerifyKey, textStatement(textMsg), textMsg.signature),
);
check(
  "a message re-attributed to another sender fails verification",
  !(await verifyStatement(aVerifyKey, textStatement(textMsg, bId), textMsg.signature)),
);
check(
  "a swapped payload fails verification",
  !(await verifyStatement(
    aVerifyKey,
    textStatement({ ...textMsg, encryptedPayload: "tampered" }),
    textMsg.signature,
  )),
);

// The roster is verifiable rather than merely served: B checks A's attestation
// of its own keys before trusting anything else about the space.
const rosterForB = (await (
  await fetch(`${BASE}/api/devices`, { headers: headers(bAuth) })
).json()) as { devices: any[] };
const bEntry = rosterForB.devices.find((d) => d.id === bId);
check("the roster publishes signing keys", bEntry?.signingPublicKey === bSigningPublic);
const { signature: bAttSig, ...bAttFields } = bEntry.attestation as DeviceAttestation;
check(
  "B's roster entry is attested by A",
  bAttFields.signerDeviceId === aId &&
    (await verifyStatement(aVerifyKey, attestationStatement(bAttFields), bAttSig)),
);

const meta = await decryptJson<{ name: string; size: number }>(
  bGroupKey,
  fileMsg.fileMeta,
  fileMsg.fileMetaIv,
  `meta:${fileId}`,
);
check("B decrypts file metadata", meta.name === "secret.bin" && meta.size === original.byteLength);

const fileDl = await fetch(`${BASE}/api/files/${fileMsg.fileR2Key}`, { headers: headers(bAuth) });
check("B downloads encrypted file", fileDl.ok);
const decrypted = new Uint8Array(
  await decryptFile(bGroupKey, await fileDl.arrayBuffer(), fileMsg.fileIv, `file:${fileId}`),
);
check(
  "B decrypts file to byte-identical original",
  decrypted.length === original.length && decrypted.every((b, i) => b === original[i]),
);

// --- Device B: ack both (B is the only recipient) -------------------------
const ackText = await (await postJson(`/api/messages/${textId}/ack`, {}, bAuth)).json();
const ackFile = (await (await postJson(`/api/messages/${fileId}/ack`, {}, bAuth)).json()) as {
  deleted: boolean;
};
check("acking last recipient reports deletion", ackFile.deleted === true);

// --- Server-side deletion checks ------------------------------------------
const afterAckPending = (await (
  await fetch(`${BASE}/api/messages/pending`, { headers: headers(bAuth) })
).json()) as { messages: any[] };
check("no pending messages remain after ack", afterAckPending.messages.length === 0);

const fileGone = await fetch(`${BASE}/api/files/${r2Key}`, { headers: headers(bAuth) });
check("R2 file deleted immediately after full ack", fileGone.status === 404);

// --- Cross-group ack rejection (security: #3) ----------------------------
// A device with a valid token for group A must not be able to ack/delete a
// message in group B, even by guessing the id. Build a second group with
// two devices, persist a real message, then try to ack it from A's auth.
const cKeys = await generateDeviceKeyPair();
const c2Keys = await generateDeviceKeyPair();
const cGroupId = randomId();
const cToken = randomToken();
const cId = randomId();
const c2Id = randomId();
const cGroupKey = await generateGroupKey();
const cName = await encryptName(cGroupKey, "Group C device", cId);
const cCreate = await postJson("/api/groups", {
  groupId: cGroupId,
  deviceAuthTokenHash: await sha256Hex(cToken),
  device: { id: cId, publicKey: await exportPublicKey(cKeys.publicKey) },
  encryptedName: cName.ciphertext,
  nameIv: cName.iv,
});
check("group C create returns 200", cCreate.ok);

// Pair a second device into C so the message has a real recipient and
// actually gets persisted (sendMessage short-circuits when no recipients).
const cPairingId = randomId();
const c2Public = await exportPublicKey(c2Keys.publicKey);
const c2Token = randomToken();
await postJson(`/api/pairing/${cPairingId}/request`, {
  device: { id: c2Id, publicKey: c2Public },
});
const cRecipient = await importPublicKey(c2Public);
const cWrapped = await wrapPairingPackage(
  cRecipient,
  {
    groupKey: await exportGroupKey(cGroupKey),
    keyEpoch: 1,
    deviceAuthToken: c2Token,
    groupId: cGroupId,
  },
  cPairingId,
);
const c2Name = await encryptName(cGroupKey, "Group C2 device", c2Id);
const cComplete = await postJson(
  `/api/pairing/${cPairingId}/complete`,
  {
    wrappedPackage: cWrapped.wrappedPackage,
    ephemeralPublicKey: cWrapped.ephemeralPublicKey,
    scannedPublicKey: c2Public,
    encryptedName: c2Name.ciphertext,
    nameIv: c2Name.iv,
    deviceAuthTokenHash: await sha256Hex(c2Token),
    keyEpoch: 1,
  },
  { token: cToken },
);
check("group C second device paired", cComplete.ok);

const crossTextId = randomId();
const crossEnc = await encryptText(cGroupKey, "private to C", `text:${crossTextId}`);
const crossSend = await postJson(
  "/api/messages",
  { id: crossTextId, keyEpoch: 1, encryptedPayload: crossEnc.ciphertext, iv: crossEnc.iv },
  { token: cToken },
);
check("group C message created", crossSend.ok);

// A is authenticated but tries to ack C's message id. With the group
// ownership check in place this should be 404 (not 200 and not 200+deleted).
const crossAck = await postJson(`/api/messages/${crossTextId}/ack`, {}, aAuth);
check("ackMessage rejects cross-group message with 404", crossAck.status === 404);

// And the foreign message must still exist afterwards (C2 sees it pending).
const c2Pending = (await (
  await fetch(`${BASE}/api/messages/pending`, {
    headers: headers({ token: c2Token }),
  })
).json()) as { messages: { id: string }[] };
check(
  "cross-group message is still intact after rejected ack",
  c2Pending.messages.some((m) => m.id === crossTextId),
);

// --- Auth checks -----------------------------------------------------------
const noAuth = await fetch(`${BASE}/api/devices`);
check("unauthenticated request is rejected", noAuth.status === 401);

const badToken = await fetch(`${BASE}/api/devices`, {
  headers: headers({ token: "wrong-token", deviceId: aId }),
});
check("invalid token is rejected", badToken.status === 401);

// --- Device management / revoke -------------------------------------------
const devicesBefore = (await (
  await fetch(`${BASE}/api/devices`, { headers: headers(aAuth) })
).json()) as { devices: any[]; currentRole: string };
check("group lists 2 active devices", devicesBefore.devices.length === 2);
check("space creator is the owner", devicesBefore.currentRole === "owner");
check(
  "newly paired device is a member",
  devicesBefore.devices.find((d) => d.id === bId)?.role === "member",
);

const memberRevokeOwner = await fetch(`${BASE}/api/devices/${aId}`, {
  method: "DELETE",
  headers: headers(bAuth),
});
check("member cannot revoke another device", memberRevokeOwner.status === 403);

const promoteB = await fetch(`${BASE}/api/devices/${bId}/role`, {
  method: "PATCH",
  headers: headers(aAuth, { "Content-Type": "application/json" }),
  body: JSON.stringify({ role: "admin" }),
});
check("owner can promote a member to admin", promoteB.ok);

const adminRevokeOwner = await fetch(`${BASE}/api/devices/${aId}`, {
  method: "DELETE",
  headers: headers(bAuth),
});
check("admin cannot revoke the owner", adminRevokeOwner.status === 403);

const adminChangesRole = await fetch(`${BASE}/api/devices/${aId}/role`, {
  method: "PATCH",
  headers: headers(bAuth, { "Content-Type": "application/json" }),
  body: JSON.stringify({ role: "member" }),
});
check("admin cannot change roles", adminChangesRole.status === 403);

const demoteB = await fetch(`${BASE}/api/devices/${bId}/role`, {
  method: "PATCH",
  headers: headers(aAuth, { "Content-Type": "application/json" }),
  body: JSON.stringify({ role: "member" }),
});
check("owner can remove administrator access", demoteB.ok);

const revokeB = await fetch(`${BASE}/api/devices/${bId}`, {
  method: "DELETE",
  headers: headers(aAuth),
});
check("owner can revoke a member", revokeB.ok);
const devicesAfter = (await (
  await fetch(`${BASE}/api/devices`, { headers: headers(aAuth) })
).json()) as { devices: any[] };
check("after revoke, only 1 active device", devicesAfter.devices.length === 1);

const revokedAccess = await fetch(`${BASE}/api/messages/pending`, { headers: headers(bAuth) });
check("revoked device is forbidden", revokedAccess.status === 403);

// --- Key rotation: what makes the revoke above real ------------------------
// B is revoked but still holds the epoch-1 GroupKey. Rotating is what actually
// ends its access. Pair a device D first, so the rotation has a real remaining
// device to wrap the new key for.
const dKeys = await generateDeviceKeyPair();
const dId = randomId();
const dPairingId = randomId();
const dPublic = await exportPublicKey(dKeys.publicKey);
const dToken = randomToken();
await postJson(`/api/pairing/${dPairingId}/request`, { device: { id: dId, publicKey: dPublic } });
const dWrapped = await wrapPairingPackage(
  await importPublicKey(dPublic),
  { groupKey: await exportGroupKey(groupKey), keyEpoch: 1, deviceAuthToken: dToken, groupId },
  dPairingId,
);
const dName = await encryptName(groupKey, "Device D", dId);
const dComplete = await postJson(
  `/api/pairing/${dPairingId}/complete`,
  {
    wrappedPackage: dWrapped.wrappedPackage,
    ephemeralPublicKey: dWrapped.ephemeralPublicKey,
    scannedPublicKey: dPublic,
    encryptedName: dName.ciphertext,
    nameIv: dName.iv,
    deviceAuthTokenHash: await sha256Hex(dToken),
    keyEpoch: 1,
  },
  aAuth,
);
check("device D paired at the current epoch", dComplete.ok);
const dAuth: Auth = { token: dToken };

interface SyncBody {
  messages: any[];
  keys: { epoch: number; wrappedKey: string; ephemeralPublicKey: string }[];
  keyEpoch: number;
  rotationPending: boolean;
}
const syncAs = async (auth: Auth): Promise<SyncBody> =>
  (await (
    await fetch(`${BASE}/api/messages/pending`, { headers: headers(auth) })
  ).json()) as SyncBody;

const beforeRotation = await syncAs(aAuth);
check("revoking flags the space as owing a rotation", beforeRotation.rotationPending === true);
check("the space is still on epoch 1", beforeRotation.keyEpoch === 1);

// A rotates: a brand-new key, wrapped for every remaining device (only D).
const newGroupKey = await generateGroupKey();
const newEpoch = 2;
const dWrap = await wrapSecret(
  await importPublicKey(dPublic),
  { groupKey: await exportGroupKey(newGroupKey), epoch: newEpoch },
  rekeyContext(groupId, newEpoch, dId),
);
const rotateRes = await postJson(
  "/api/keys/rotate",
  {
    epoch: newEpoch,
    wraps: [
      {
        deviceId: dId,
        wrappedKey: dWrap.wrappedPackage,
        ephemeralPublicKey: dWrap.ephemeralPublicKey,
      },
    ],
  },
  aAuth,
);
const rotateBody = (await rotateRes.json()) as { epoch?: number; devices?: number };
check("rotation is accepted", rotateRes.ok && rotateBody.epoch === 2);
check("the new key was deposited for the one remaining device", rotateBody.devices === 1);

// A second rotation from the same epoch loses the compare-and-swap.
const staleRotate = await postJson("/api/keys/rotate", { epoch: 2, wraps: [] }, aAuth);
check("a concurrent rotation from the old epoch is rejected", staleRotate.status === 409);

// The whole point: content encrypted with the superseded key is refused.
const staleId = randomId();
const staleEnc = await encryptText(groupKey, "should never ship", `text:${staleId}`);
const staleSend = await sendMessage(
  groupId,
  { id: staleId, keyEpoch: 1, encryptedPayload: staleEnc.ciphertext, iv: staleEnc.iv },
  aAuth,
  aSigner,
);
check("sending under the superseded key is rejected", staleSend.status === 409);
check(
  "…with the code that tells the client to re-encrypt",
  ((await staleSend.json()) as { error?: { code?: string } }).error?.code === "key_rotated",
);

const rotatedId = randomId();
const rotatedText = "only readable after the rotation";
const rotatedEnc = await encryptText(newGroupKey, rotatedText, `text:${rotatedId}`);
const rotatedSend = await sendMessage(
  groupId,
  { id: rotatedId, keyEpoch: 2, encryptedPayload: rotatedEnc.ciphertext, iv: rotatedEnc.iv },
  aAuth,
  aSigner,
);
check("sending under the new key is accepted", rotatedSend.ok);

// D was never asked to re-pair: it picks the new key up on its next poll.
const dSync = await syncAs(dAuth);
check("the new key is waiting for D", dSync.keys.length === 1 && dSync.keys[0]!.epoch === 2);
check("the rotation cleared the space's debt", dSync.rotationPending === false);
const dRecovered = await unwrapSecret<{ groupKey: string; epoch: number }>(
  dKeys.privateKey,
  dSync.keys[0]!.ephemeralPublicKey,
  dSync.keys[0]!.wrappedKey,
  rekeyContext(groupId, 2, dId),
);
const dNewKey = await importGroupKey(dRecovered.groupKey);
const dRotatedMsg = dSync.messages.find((m) => m.id === rotatedId);
check("the post-rotation message is tagged with its epoch", dRotatedMsg?.keyEpoch === 2);
check(
  "D decrypts it with the key it just adopted",
  (await decryptText(
    dNewKey,
    dRotatedMsg.encryptedPayload,
    dRotatedMsg.iv,
    `text:${rotatedId}`,
  )) === rotatedText,
);

// The revoked device's key is now useless for anything sent from here on.
let revokedCanRead = true;
try {
  await decryptText(bGroupKey, dRotatedMsg.encryptedPayload, dRotatedMsg.iv, `text:${rotatedId}`);
} catch {
  revokedCanRead = false;
}
check("the revoked device's old key cannot decrypt post-rotation content", !revokedCanRead);

// A blob meant for another device (or epoch) is bound by its AAD.
let replayed = true;
try {
  await unwrapSecret(
    dKeys.privateKey,
    dSync.keys[0]!.ephemeralPublicKey,
    dSync.keys[0]!.wrappedKey,
    rekeyContext(groupId, 3, dId),
  );
} catch {
  replayed = false;
}
check("a wrapped key cannot be replayed at another epoch", !replayed);

const ackKeyRes = await postJson("/api/keys/2/ack", {}, dAuth);
check("D can ack the epoch it adopted", ackKeyRes.ok);
const afterAdopt = await syncAs(dAuth);
check("the server drops the wrapped key once acked", afterAdopt.keys.length === 0);
const devicesAfterRotation = (await (
  await fetch(`${BASE}/api/devices`, { headers: headers(aAuth) })
).json()) as { devices: { id: string; keyEpoch: number }[]; keyEpoch: number };
check("the space reports the new epoch", devicesAfterRotation.keyEpoch === 2);
check(
  "every remaining device is caught up",
  devicesAfterRotation.devices.every((d) => d.keyEpoch === 2),
);

// --- Upgrade path: a device that predates signing grows an identity --------
// D was paired without a signing key (exactly like every device that existed
// before authenticity landed) and has been receiving all along. It now
// publishes one, with no re-pairing and nothing else disturbed.
const dSigning = await generateSigningKeyPair();
const dSigningPublic = await exportSigningPublicKey(dSigning.publicKey);
const dLegacyId = randomId();
const dLegacyEnc = await encryptText(newGroupKey, "unsigned but fine", `text:${dLegacyId}`);
const dBeforePublish = await sendMessage(
  groupId,
  {
    id: dLegacyId,
    keyEpoch: 2,
    encryptedPayload: dLegacyEnc.ciphertext,
    iv: dLegacyEnc.iv,
  },
  dAuth,
);
check("a device with no signing key may still send unsigned", dBeforePublish.ok);

const publishD = await postJson(
  "/api/devices/self/signing-key",
  { signingPublicKey: dSigningPublic },
  dAuth,
);
check("a device can publish its signing key", publishD.ok);
const republishD = await postJson(
  "/api/devices/self/signing-key",
  { signingPublicKey: dSigningPublic },
  dAuth,
);
check("re-publishing the same key is idempotent", republishD.ok);
const replaceD = await postJson(
  "/api/devices/self/signing-key",
  { signingPublicKey: aSigningPublic },
  dAuth,
);
check("a signing key can never be replaced", replaceD.status === 409);

const dUnsigned = await postJson(
  "/api/messages",
  { id: randomId(), keyEpoch: 2, encryptedPayload: "x", iv: "y" },
  dAuth,
);
check("…and from then on its messages must be signed", dUnsigned.status === 400);

// --- pollPairing rate limit (security: #4) --------------------------------
// The poll endpoint is anonymous and should share the public-IP rate limit
// with the other unauthenticated endpoints (RL_PUBLIC, 30/60s in dev).
// Hammer it with a fresh pairing id (one that doesn't exist) until the
// limiter trips. The limit is 30/60s in the wrangler config, so we need at
// least 31 calls; the local limit may be lower, so we just check the
// behavior — any 429 we see means the limiter is wired.
let poll429 = false;
for (let i = 0; i < 40; i++) {
  const r = await fetch(`${BASE}/api/pairing/${randomId()}`);
  if (r.status === 429) {
    poll429 = true;
    break;
  }
}
check("pollPairing is rate-limited (eventually returns 429)", poll429);

// avoid unused-var lint for ackText
void ackText;

console.log("");
if (failures === 0) {
  console.log("🎉 ALL CHECKS PASSED");
} else {
  console.log(`💥 ${failures} CHECK(S) FAILED`);
  process.exit(1);
}
