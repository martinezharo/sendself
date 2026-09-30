/**
 * Shared contract between the Cloudflare Worker (backend) and the PWA (frontend).
 *
 * Nothing in here is secret: the server only ever handles ciphertext, public keys
 * and hashes. All plaintext and symmetric keys stay on the clients.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum size (bytes) of a single file *before* encryption: 50 MB. */
export const MAX_FILE_SIZE = 50 * 1024 * 1024;

/**
 * Upper bound for the *encrypted* upload. AES-GCM adds a 16-byte auth tag, so we
 * allow a small margin above MAX_FILE_SIZE when validating the R2 upload.
 */
export const MAX_UPLOAD_SIZE = MAX_FILE_SIZE + 1024;

/** Pairing slots live at most this long before the cron job reaps them. */
export const PAIRING_TTL_MS = 10 * 60 * 1000;

/** Server-side messages/files are purged after this age regardless of delivery. */
export const MESSAGE_TTL_MS = 24 * 60 * 60 * 1000;

/** Default client polling interval for pending messages. */
export const POLL_INTERVAL_MS = 8000;

/**
 * Polling interval once a real-time connection is live.
 *
 * Not zero: the socket is a *hint*, never the source of truth. A notification
 * that is dropped in transit, or one that arrives while the tab is being
 * frozen, would otherwise strand a message until the next user action. This is
 * the safety net that makes losing one harmless, at 1/7th of the battery cost
 * of the old cadence.
 */
export const REALTIME_POLL_INTERVAL_MS = 60_000;

/** WebSocket endpoint devices subscribe to for delivery notifications. */
export const REALTIME_PATH = "/api/realtime";

/**
 * The bearer token travels as a WebSocket subprotocol because the browser API
 * cannot set request headers, and a token in the query string ends up in
 * access logs and referrers. Device tokens are base64url, which is a valid
 * subprotocol token.
 */
export const REALTIME_AUTH_PROTOCOL_PREFIX = "fs-auth.";

/** Interval at which the client pings, to notice a dead connection early. */
export const REALTIME_PING_INTERVAL_MS = 30_000;

/**
 * What the server pushes. Deliberately contentless: it says "there is something
 * for you", and the client then runs the same sync pass polling would have. No
 * ciphertext, no ids and no delivery bookkeeping travel over the socket, so the
 * real-time path adds nothing to what the server could learn or forge.
 */
export interface RealtimeEvent {
  type: "sync";
}

/**
 * Epoch of the GroupKey a space is born with. Every key rotation increments it
 * by exactly one, so an epoch identifies which key a ciphertext needs. Spaces
 * created before rotation existed are epoch 1 by migration default, which is
 * why they keep working without re-pairing.
 */
export const INITIAL_KEY_EPOCH = 1;

// ---------------------------------------------------------------------------
// Core domain shapes
// ---------------------------------------------------------------------------

/** A device as published during registration/pairing (public material only). */
export interface DeviceDescriptor {
  id: string;
  /** ECDH P-256 public key, base64url-encoded SPKI. */
  publicKey: string;
  /**
   * ECDSA P-256 public key (base64url SPKI) this device signs its messages with.
   * Optional because devices that predate sender authenticity have none until
   * they publish one (see PublishSigningKeyRequest) — their messages are simply
   * unverifiable rather than rejected, so nothing breaks mid-upgrade.
   */
  signingPublicKey?: string;
}

/**
 * The device's human-readable name, encrypted with the GroupKey so the server
 * never sees it in the clear (it is PII). `iv` is the AES-GCM IV (base64url).
 */
export interface EncryptedName {
  encryptedName: string;
  nameIv: string;
}

export const DEVICE_ROLES = ["owner", "admin", "member"] as const;
export type DeviceRole = (typeof DEVICE_ROLES)[number];
export type AssignableDeviceRole = Exclude<DeviceRole, "owner">;

/**
 * An introducer's signed statement that a device's public material is genuine.
 *
 * The device that adds another one scans its QR code, so it learns that
 * device's keys through a channel the server cannot touch. Signing what it
 * learned turns that one-off out-of-band moment into something every *other*
 * device can check later, which is what removes the trust-on-first-use gap:
 * a server that invents a device (or swaps the keys of one nobody has seen)
 * cannot produce a signature from a device that is already trusted.
 */
export interface DeviceAttestation {
  groupId: string;
  /** The device being vouched for. */
  deviceId: string;
  /** Its ECDH public key, exactly as it must appear in the roster. */
  publicKey: string;
  /** Its ECDSA signing public key, exactly as it must appear in the roster. */
  signingPublicKey: string;
  /** The device that scanned the QR code and signed this. */
  signerDeviceId: string;
  issuedAt: number;
  /** ECDSA P-256 signature (base64url) of `attestationStatement(this)`. */
  signature: string;
}

/** A device as listed in the management UI (name stays encrypted in transit). */
export interface DeviceInfo {
  id: string;
  encryptedName: string;
  nameIv: string;
  createdAt: number;
  role: DeviceRole;
  /** ECDH P-256 public key (base64url SPKI), used to wrap a rotated GroupKey for it. */
  publicKey: string;
  /** ECDSA P-256 public key (base64url SPKI), or null for a device that has not published one. */
  signingPublicKey: string | null;
  /** Who vouched for this device's keys, or null (legacy device / joined before attestations). */
  attestation: DeviceAttestation | null;
  /** Highest GroupKey epoch this device has adopted. Below the group's = still catching up. */
  keyEpoch: number;
  /** Epoch of the key that encrypted `encryptedName` (names are never rewritten). */
  nameKeyEpoch: number;
  /** A send-only device (see `PairingRequestBody.sendOnly`): never a message recipient. */
  sendOnly: boolean;
}

/** Payload encoded inside a QR code (or pasted as text) during pairing. */
export interface PairingQrPayload {
  v: 1;
  pairingId: string;
  deviceId: string;
  deviceName: string;
  /** ECDH P-256 public key of the joining device, base64url SPKI. */
  publicKey: string;
  /**
   * ECDSA P-256 signing public key of the joining device, base64url SPKI. It
   * travels in the QR code precisely so the adding device learns it
   * out-of-band and can attest to it (see DeviceAttestation).
   */
  signingPublicKey?: string;
  /**
   * The device only sends (see `PairingRequestBody.sendOnly`). Carried here so
   * the device adding it can say what it is adding.
   */
  sendOnly?: true;
}

// ---------------------------------------------------------------------------
// Signed statements
// ---------------------------------------------------------------------------

/**
 * The exact bytes a signature covers, built the same way by signer and
 * verifier. Positional and delimiter-based rather than JSON: every field is an
 * id, a base64url key or a number, none of which can contain the separator, so
 * there is no way to shift meaning from one field into another.
 */
export function attestationStatement(fields: Omit<DeviceAttestation, "signature">): string {
  return [
    "fs-device-attestation:1",
    fields.groupId,
    fields.deviceId,
    fields.publicKey,
    fields.signingPublicKey,
    fields.signerDeviceId,
    String(fields.issuedAt),
  ].join(":");
}

/** The parts of a global-delete request a sender signs. */
export interface DeleteSignatureFields {
  groupId: string;
  /** Id of the tombstone itself (it is a message like any other). */
  messageId: string;
  senderDeviceId: string;
  keyEpoch: number;
  /** The message this tombstone orders every device to forget. */
  deletesMessageId: string;
}

/**
 * Statement signed by the device that asks every other device to delete a
 * message.
 *
 * Deliberately a *different* statement from `messageSignatureStatement` rather
 * than an extra field on it: adding a part there would change the bytes every
 * normal message is signed over, so devices running an older build would start
 * reporting perfectly good messages as `invalid`. Two prefixes that cannot
 * collide also mean a signature harvested from one kind can never be replayed
 * as the other — which matters more here than anywhere else, since this is the
 * one statement whose effect is destructive.
 */
export function deleteSignatureStatement(fields: DeleteSignatureFields): string {
  return [
    "fs-message-delete:1",
    fields.groupId,
    fields.messageId,
    fields.senderDeviceId,
    String(fields.keyEpoch),
    fields.deletesMessageId,
  ].join(":");
}

/** The parts of a message a sender signs: who sent it, under which key, and every ciphertext in it. */
export interface MessageSignatureFields {
  groupId: string;
  messageId: string;
  senderDeviceId: string;
  keyEpoch: number;
  encryptedPayload?: string | null;
  iv?: string | null;
  fileR2Key?: string | null;
  fileIv?: string | null;
  fileMeta?: string | null;
  fileMetaIv?: string | null;
}

/**
 * Statement signed by the sending device over a message.
 *
 * It covers the sender id and the ciphertexts, so the server can neither
 * re-attribute a message to another device nor swap in a different payload.
 * `createdAt` is deliberately absent: it is assigned by the server, so the
 * sender could not sign it. Ordering/replay is a separate problem (see
 * docs/security.md).
 *
 * The ciphertexts are length-prefixed because, unlike ids and keys, base64url
 * payloads sit next to each other and an absent field must not be confusable
 * with an empty one.
 */
export function messageSignatureStatement(fields: MessageSignatureFields): string {
  const part = (value: string | null | undefined): string =>
    value === undefined || value === null ? "-" : `${value.length}.${value}`;
  return [
    "fs-message:1",
    fields.groupId,
    fields.messageId,
    fields.senderDeviceId,
    String(fields.keyEpoch),
    part(fields.encryptedPayload),
    part(fields.iv),
    part(fields.fileR2Key),
    part(fields.fileIv),
    part(fields.fileMeta),
    part(fields.fileMetaIv),
  ].join(":");
}

// ---------------------------------------------------------------------------
// Encrypted message metadata
// ---------------------------------------------------------------------------

/**
 * What `fileMeta`/`fileMetaIv` decrypt to: everything about a message that is
 * neither its text nor its file bytes.
 *
 * It rides in the `fileMeta` fields rather than in columns of its own for two
 * reasons, and both matter more than the slightly stale name.
 *
 * It is already *encrypted*, so the server never learns which messages are
 * view-once (the ones worth attacking) or which files were sent together. And
 * it is already covered by `messageSignatureStatement`, so a server cannot
 * strip the view-once flag to make a message persist, nor forge a grouping.
 * A new column would have neither property until the signature statement was
 * versioned — which would make every older build report good messages as
 * `invalid` (see the note on `deleteSignatureStatement`).
 *
 * Every field is optional and the shape stays flat, so metadata written before
 * any of this existed (`{ name, size, mime }`) still decodes unchanged.
 */
export interface MessageMeta {
  /** Attachment name. Absent when the message carries no file. */
  name?: string;
  size?: number;
  mime?: string;
  /**
   * Files picked together share a batch id, so the receiving chat can render
   * them as one album under one caption. Deliberately *not* a protocol-level
   * album: on the wire these stay independent messages, each with its own
   * delivery row and its own resumable upload, which is the only granularity
   * that survives a background pass being cut short.
   */
  batchId?: string;
  /** Position within the batch, so the album renders in the order picked. */
  batchIndex?: number;
  /** How many messages the batch has, so a partial album can say so. */
  batchCount?: number;
  /**
   * Removed from every device once the first one opens it. The opener emits an
   * ordinary "delete for everyone" tombstone, so the retraction inherits the
   * offline delivery, retries and races that pipeline already handles.
   */
  viewOnce?: true;
}

// ---------------------------------------------------------------------------
// API request/response DTOs
// ---------------------------------------------------------------------------

export interface CreateGroupRequest {
  groupId: string;
  /** SHA-256(deviceAuthToken) as lowercase hex. The raw token never leaves clients. */
  deviceAuthTokenHash: string;
  device: DeviceDescriptor;
  /** GroupKey-encrypted device name (the first device already holds the key). */
  encryptedName: string;
  nameIv: string;
  /**
   * The founding device's self-attestation. It is the root every later
   * attestation chains back to: a device that joins inherits it through its
   * pairing package, so "who is genuinely in this space" is anchored on the
   * device that created it rather than on whatever the server lists.
   */
  attestation?: DeviceAttestation;
}

export interface CreateGroupResponse {
  ok: true;
}

/** Device 2 -> server: reserve a pairing slot and publish its public material. */
export interface PairingRequestBody {
  device: DeviceDescriptor;
  /**
   * The joining device will only ever send: a script or an agent on a server
   * (the `sendself` CLI) rather than somewhere a person reads the space.
   *
   * The server then leaves it out of every message's recipients. Without that,
   * each message would wait on the server for a device that never collects it
   * until the 24-hour cleanup, instead of being deleted the moment the devices
   * that do read it have it. It is still a full member for everything else: it
   * holds the GroupKey, signs what it sends, and is handed every rotated key.
   */
  sendOnly?: true;
}

export interface PairingRequestResponse {
  ok: true;
}

/** Device 1 (authed) -> server: deposit the wrapped GroupKey package. */
export interface PairingCompleteBody {
  /** AES-GCM ciphertext of the pairing payload, JSON `{ ct, iv }` then base64url. */
  wrappedPackage: string;
  /** Ephemeral ECDH P-256 public key (base64url SPKI) used to derive the wrap key. */
  ephemeralPublicKey: string;
  /**
   * The joining device's public key as scanned from the QR code (out-of-band,
   * not the pairing slot). The server checks this matches the public key the
   * joining device published in step 1, so a slot whose stored public key was
   * swapped after the QR was scanned is rejected instead of silently wrapped
   * for the wrong recipient.
   */
  scannedPublicKey: string;
  /** Same check for the signing key: what was scanned must be what was published. */
  scannedSigningPublicKey?: string;
  /**
   * The adding device's signed statement about the keys it just scanned. Every
   * other device verifies this instead of trusting the roster the server
   * serves. Absent only when the adding device has no signing key yet.
   */
  attestation?: DeviceAttestation;
  /**
   * GroupKey-encrypted name of the *joining* device. The existing device holds
   * the GroupKey and the scanned (out-of-band) name, so it encrypts it here;
   * the joining device never sends its name to the server in the clear.
   */
  encryptedName: string;
  nameIv: string;
  /** SHA-256 of the new device's independently generated bearer token. */
  deviceAuthTokenHash: string;
  /**
   * Epoch of the GroupKey wrapped into `wrappedPackage`. The server rejects the
   * request unless it is the group's current epoch, so a device that has not
   * caught up with a rotation can never hand a joining device a stale key.
   */
  keyEpoch: number;
}

export interface PairingCompleteResponse {
  ok: true;
}

/** Device 2 polls this until `ready` is true. */
export interface PairingPollResponse {
  ready: boolean;
  wrappedPackage?: string;
  ephemeralPublicKey?: string;
}

/**
 * Plaintext structure that is encrypted into `wrappedPackage`. Only the joining
 * device ever sees this in the clear.
 */
export interface PairingPayload {
  /** Raw AES-GCM 256 GroupKey, base64url. */
  groupKey: string;
  /** Epoch of `groupKey`. The joining device starts its keyring here. */
  keyEpoch: number;
  /** Bearer credential unique to the joining device. */
  deviceAuthToken: string;
  groupId: string;
  /**
   * The space's device roster as the *introducer* knows it, handed over
   * through the same out-of-band-anchored channel as the GroupKey.
   *
   * Without it a joining device would have to take the server's word for who
   * else is in the space, and would have no trusted key to check any
   * attestation against. With it, the device starts from the introducer's
   * verified view and every later change has to be attested by someone in it.
   */
  roster?: DeviceKeyBundle[];
  /**
   * The space's name as the introducer calls it, so the joining device shows
   * the same one instead of an id. Local metadata that never reaches the
   * server: it travels here precisely because this package is encrypted for
   * the joining device alone. Absent when the space was never named.
   */
  spaceName?: string;
}

/**
 * The space's name as every device in it sees it, encrypted with the GroupKey.
 *
 * The server stores this blob and hands it back on every poll, which is what
 * makes a rename reach devices that were offline when it happened — including
 * ones that were away for longer than a message survives. It never sees the
 * name itself: it only learns that the space has one, roughly how long it is,
 * and when it last changed.
 *
 * `updatedAt` is assigned by the server, exactly like a message's `createdAt`:
 * two devices that rename at the same time both write, the later write wins,
 * and the other one adopts it on its next poll. Client clocks never take part,
 * so a device with a wrong clock cannot pin its name forever.
 */
export interface SpaceNameRecord {
  /** AES-GCM ciphertext (base64url), or null when the name was cleared. */
  encryptedName: string | null;
  nameIv: string | null;
  /**
   * Epoch of the GroupKey that encrypted it. Unlike a device name, this is
   * re-encrypted after a rotation (by any device that can still read it), so a
   * device that joins later — and only ever holds the current key — can read it.
   */
  nameKeyEpoch: number;
  /** When the server recorded this name. The tiebreaker between devices. */
  updatedAt: number;
}

/** Publish the space's name for every device. Same shape, minus the server's timestamp. */
export type UpdateSpaceNameRequest = Omit<SpaceNameRecord, "updatedAt">;

export interface UpdateSpaceNameResponse {
  ok: true;
  /** The time the server recorded, which is what decides later conflicts. */
  updatedAt: number;
}

/** One device's public identity: what a signature is checked against. */
export interface DeviceKeyBundle {
  deviceId: string;
  publicKey: string;
  signingPublicKey?: string;
}

/** A device publishes the signing key it will authenticate its messages with. */
export interface PublishSigningKeyRequest {
  /** ECDSA P-256 public key, base64url SPKI. Set once: it can never be replaced. */
  signingPublicKey: string;
}

export interface PublishSigningKeyResponse {
  ok: true;
}

export interface SendMessageRequest {
  id: string;
  /**
   * Epoch of the GroupKey every ciphertext in this message was encrypted with.
   * The server rejects anything but the current epoch, so a rotation takes
   * effect immediately instead of leaving a window in which content is still
   * readable by the device that was just revoked.
   */
  keyEpoch: number;
  /** Encrypted text (base64url AES-GCM ciphertext); omit for file-only messages. */
  encryptedPayload?: string;
  /** base64url IV for the text payload. */
  iv?: string;
  /** R2 object key for an attached encrypted file. */
  fileR2Key?: string;
  /** base64url IV for the file payload. */
  fileIv?: string;
  /**
   * The message's encrypted metadata envelope (`MessageMeta`), base64url
   * AES-GCM ciphertext. Historically file-only, which is where the name comes
   * from; it now also carries the album grouping and the view-once flag, so a
   * message with no attachment at all can have one.
   */
  fileMeta?: string;
  /** base64url IV for the metadata payload. */
  fileMetaIv?: string;
  /**
   * Id of a message this one orders every device to delete ("delete for
   * everyone"). Mutually exclusive with the payload fields: a tombstone carries
   * no content of its own.
   *
   * It travels in the clear, unlike everything else. That leaks nothing new —
   * message ids are already primary keys in the server's database — and it buys
   * the server the ability to drop the target's row and its R2 object right
   * away, so a message deleted before a device came online is never delivered
   * at all rather than delivered and then retracted.
   *
   * Signed with `deleteSignatureStatement`, not `messageSignatureStatement`.
   */
  deletesMessageId?: string;
  /**
   * ECDSA signature (base64url) over `messageSignatureStatement(...)`, proving
   * this message really comes from `senderDeviceId`. Optional on the wire only
   * for devices that have not published a signing key; the server rejects an
   * unsigned message from a device that has.
   */
  signature?: string;
}

export interface SendMessageResponse {
  ok: true;
}

export interface PendingMessage {
  id: string;
  /** Which GroupKey epoch decrypts this message's ciphertexts. */
  keyEpoch: number;
  senderDeviceId: string;
  /** GroupKey-encrypted name of the sender device (null if the device is gone). */
  senderNameEnc: string | null;
  senderNameIv: string | null;
  /** Epoch of the key that encrypted `senderNameEnc`, which may predate the message's. */
  senderNameEpoch: number | null;
  encryptedPayload: string | null;
  iv: string | null;
  fileR2Key: string | null;
  fileIv: string | null;
  fileMeta: string | null;
  fileMetaIv: string | null;
  /**
   * Set when this is a tombstone: the id of the message to delete locally. The
   * receiving device applies it and acks; nothing is ever rendered for it.
   */
  deletesMessageId: string | null;
  createdAt: number;
  /** The sender's signature over this message, or null if it never published a signing key. */
  signature: string | null;
}

/**
 * A rotated GroupKey waiting for one device, wrapped to its ECDH public key
 * exactly like a pairing package. The server stores only this blob, and drops
 * it as soon as the device acks the epoch — which is what lets a device that
 * was offline during the rotation self-heal on its next poll.
 */
export interface PendingKeyDelivery {
  epoch: number;
  /** ECIES-wrapped raw GroupKey (base64url of JSON `{ iv, ct }`). */
  wrappedKey: string;
  /** Ephemeral ECDH P-256 public key (base64url SPKI) used to derive the wrap key. */
  ephemeralPublicKey: string;
}

/**
 * Plaintext inside a rotation blob (`PendingKeyDelivery.wrappedKey`). Only the
 * recipient device ever sees it.
 */
export interface RekeyPayload {
  /** Raw AES-GCM 256 GroupKey, base64url. */
  groupKey: string;
  epoch: number;
}

/**
 * One poll answers everything the client needs to stay in sync: new messages,
 * any GroupKey it has not adopted yet, and whether a rotation is still owed.
 * Bundling them keeps the rotation protocol free of extra round-trips.
 */
export interface PendingMessagesResponse {
  messages: PendingMessage[];
  /** Keys this device hasn't adopted yet, oldest epoch first. Usually empty. */
  keys: PendingKeyDelivery[];
  /** The group's current key epoch. */
  keyEpoch: number;
  /**
   * A device was revoked and the GroupKey has not been rotated yet. Any active
   * device that sees this completes the rotation, so the work is never stranded
   * on the device that happened to press "Revoke".
   */
  rotationPending: boolean;
  /**
   * The space's shared name, or null while nobody has ever set one. Rides on
   * the poll rather than on an endpoint of its own: it is a handful of bytes,
   * and carrying it here is what lets a device notice a rename through the very
   * request it already makes, with no round-trip of its own.
   */
  spaceName: SpaceNameRecord | null;
}

/** One rotated GroupKey wrapped for one remaining device. */
export interface KeyWrap {
  deviceId: string;
  wrappedKey: string;
  ephemeralPublicKey: string;
}

/**
 * Rotate the GroupKey after a revocation. Device tokens are deliberately left
 * untouched: no remaining device is logged out or has to be paired again.
 */
export interface RotateKeyRequest {
  /** Must be exactly the group's current epoch + 1 (compare-and-swap). */
  epoch: number;
  /** One wrap per remaining active device except the caller — no more, no less. */
  wraps: KeyWrap[];
}

export interface RotateKeyResponse {
  ok: true;
  epoch: number;
  /** How many devices the new key was deposited for. */
  devices: number;
}

export interface AckKeyResponse {
  ok: true;
}

export interface AckResponse {
  ok: true;
  /** True if this ack completed delivery and triggered server-side deletion. */
  deleted: boolean;
}

export interface DevicesListResponse {
  devices: DeviceInfo[];
  /** Role of the device making the request, included to render permissions without another read. */
  currentRole: DeviceRole;
  /** The group's current key epoch: devices below it are still catching up. */
  keyEpoch: number;
  /** A revocation is still waiting for its key rotation (see PendingMessagesResponse). */
  rotationPending: boolean;
}

export interface RevokeDeviceResponse {
  ok: true;
}

export interface UpdateDeviceRoleRequest {
  /** Ownership is transferred through a dedicated flow in the future, never through this endpoint. */
  role: AssignableDeviceRole;
}

export interface UpdateDeviceRoleResponse {
  ok: true;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type ApiErrorCode =
  | "bad_request"
  | "unauthorized"
  /** Authenticated, but this device may not do that (insufficient role). */
  | "forbidden"
  /** This device's link is gone for good: it must be paired again. */
  | "device_revoked"
  | "not_found"
  | "conflict"
  /**
   * The GroupKey rotated while this content was being encrypted. The caller
   * must adopt the new key and encrypt again — never a reason to give up.
   */
  | "key_rotated"
  | "payload_too_large"
  | "rate_limited"
  | "internal";

/**
 * Errors that mean the caller's credentials will never work again, whatever it
 * retries. Clients use this to stop polling and ask the user to link again,
 * instead of looping forever on a dead session.
 */
export const AUTH_FAILURE_CODES: readonly ApiErrorCode[] = ["unauthorized", "device_revoked"];

export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    message: string;
  };
}
