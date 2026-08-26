import type {
  DeviceDescriptor,
  PairingCompleteBody,
  PairingCompleteResponse,
  PairingPollResponse,
  PairingRequestBody,
  PairingRequestResponse,
} from "@sendself/shared";
import { optionalAttestation } from "../attestation";
import { authenticate, requireAdmin } from "../auth";
import { ApiError, json } from "../errors";
import {
  optionalString,
  readJsonObject,
  requireId,
  requireInt,
  requireSha256Hex,
  requireString,
} from "../http";
import type { RouteContext } from "../router";
import { clientIp, rateLimit } from "../security";

/**
 * Step 1 (joining device, semi-open): reserve a pairing slot and publish the
 * joining device's public material. The slot is protected by an unguessable
 * `pairingId` and reaped by cron after PAIRING_TTL.
 */
export async function requestPairing(c: RouteContext): Promise<Response> {
  await rateLimit(c.env, "RL_PUBLIC", clientIp(c.request));
  const pairingId = requireId(c.params.pairingId, "pairingId");
  const body = await readJsonObject<PairingRequestBody>(c.request);
  const device = body.device;
  if (!device || typeof device !== "object") {
    throw new ApiError("bad_request", "Missing device");
  }
  const signingPublicKey = optionalString(device.signingPublicKey, "device.signingPublicKey", 2048);
  const descriptor: DeviceDescriptor = {
    id: requireId(device.id, "device.id"),
    publicKey: requireString(device.publicKey, "device.publicKey", 2048),
    ...(signingPublicKey === undefined ? {} : { signingPublicKey }),
  };

  const existing = await c.env.DB.prepare("SELECT pairing_id FROM pairing WHERE pairing_id = ?")
    .bind(pairingId)
    .first();
  if (existing) {
    throw new ApiError("conflict", "Pairing slot already in use");
  }

  await c.env.DB.prepare(
    "INSERT INTO pairing (pairing_id, new_device, created_at) VALUES (?, ?, ?)",
  )
    .bind(pairingId, JSON.stringify(descriptor), Date.now())
    .run();

  return json({ ok: true } satisfies PairingRequestResponse);
}

/**
 * Step 2 (existing device, authed): deposit the wrapped GroupKey package and
 * register the joining device into the group. The joining device's descriptor
 * comes from the slot it created in step 1.
 */
export async function completePairing(c: RouteContext): Promise<Response> {
  const auth = await authenticate(c.request, c.env);
  requireAdmin(auth);
  const pairingId = requireId(c.params.pairingId, "pairingId");
  const body = await readJsonObject<PairingCompleteBody>(c.request);
  // The package also carries the introducer's view of the device roster, so its
  // size grows with the space (a few hundred bytes per device).
  const wrappedPackage = requireString(body.wrappedPackage, "wrappedPackage", 65536);
  const ephemeralPublicKey = requireString(body.ephemeralPublicKey, "ephemeralPublicKey", 2048);
  const scannedPublicKey = requireString(body.scannedPublicKey, "scannedPublicKey", 2048);
  const scannedSigningPublicKey = optionalString(
    body.scannedSigningPublicKey,
    "scannedSigningPublicKey",
    2048,
  );
  const nameEnc = requireString(body.encryptedName, "encryptedName", 1024);
  const nameIv = requireString(body.nameIv, "nameIv", 128);
  const deviceAuthTokenHash = requireSha256Hex(body.deviceAuthTokenHash, "deviceAuthTokenHash");
  const keyEpoch = requireInt(body.keyEpoch, "keyEpoch", 1, Number.MAX_SAFE_INTEGER);

  // Handing over a superseded key would create a device that cannot read
  // anything current and would be skipped by the next rotation's device list.
  if (keyEpoch !== auth.groupKeyEpoch) {
    throw new ApiError(
      "key_rotated",
      "The space key has rotated; sync this device before adding another",
    );
  }

  const slot = await c.env.DB.prepare(
    "SELECT new_device AS newDevice, wrapped_package AS wrapped FROM pairing WHERE pairing_id = ?",
  )
    .bind(pairingId)
    .first<{ newDevice: string | null; wrapped: string | null }>();
  if (!slot || !slot.newDevice) {
    throw new ApiError("not_found", "Pairing slot not found or expired");
  }
  if (slot.wrapped) {
    throw new ApiError("conflict", "Pairing already completed");
  }

  const device = JSON.parse(slot.newDevice) as DeviceDescriptor;

  // Defense in depth: the wrap targets the key scanned out-of-band from the QR
  // code, but the slot stores whatever public key step 1 (anonymous) published.
  // They should always match in the normal flow; reject if they don't rather
  // than silently wrapping the GroupKey for a key nobody scanned.
  if (device.publicKey !== scannedPublicKey) {
    throw new ApiError("conflict", "Pairing slot public key does not match the scanned device");
  }
  // Same check for the signing key: an attestation vouching for a key the
  // adding device never scanned would authenticate the wrong sender forever.
  if ((device.signingPublicKey ?? undefined) !== scannedSigningPublicKey) {
    throw new ApiError("conflict", "Pairing slot signing key does not match the scanned device");
  }

  const attestation = optionalAttestation(body.attestation, "attestation", {
    groupId: auth.groupId,
    deviceId: device.id,
    publicKey: device.publicKey,
    ...(device.signingPublicKey === undefined ? {} : { signingPublicKey: device.signingPublicKey }),
  });
  if (attestation && attestation.signerDeviceId !== auth.deviceId) {
    throw new ApiError("bad_request", "attestation must be signed by the device adding this one");
  }

  const now = Date.now();

  // The device id is chosen by the (unauthenticated) joining device in step 1, so
  // it could collide with a device already registered to a *different* group. If we
  // let the upsert below run for such a row it would un-revoke and overwrite a
  // foreign device — a revocation bypass. Reject the collision instead.
  const existingDevice = await c.env.DB.prepare(
    "SELECT group_id AS groupId FROM devices WHERE id = ?",
  )
    .bind(device.id)
    .first<{ groupId: string }>();
  if (existingDevice && existingDevice.groupId !== auth.groupId) {
    throw new ApiError("conflict", "Device id already registered to another group");
  }

  // Register the joining device (idempotent) and store the wrapped package. Both
  // statements are guarded by the slot's still-open state and the key epoch.
  // This closes the race where a rotation commits between the epoch check above
  // and this batch: a device must never be registered with a stale wrapped key.
  // The `WHERE devices.group_id = excluded.group_id` guard also makes a
  // cross-group id collision a no-op instead of reactivating a foreign device.
  const results = await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO devices
         (id, group_id, name_enc, name_iv, public_key, signing_public_key, attestation,
          auth_token_hash, role, key_epoch, name_key_epoch, created_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'member', ?, ?, ?
        WHERE (SELECT key_epoch FROM groups WHERE id = ?) = ?
          AND EXISTS (
            SELECT 1 FROM pairing
             WHERE pairing_id = ? AND wrapped_package IS NULL
          )
       ON CONFLICT(id) DO UPDATE SET
         revoked_at = NULL,
         name_enc = excluded.name_enc,
         name_iv = excluded.name_iv,
         public_key = excluded.public_key,
         signing_public_key = excluded.signing_public_key,
         attestation = excluded.attestation,
         auth_token_hash = excluded.auth_token_hash,
         role = 'member',
         key_epoch = excluded.key_epoch,
         name_key_epoch = excluded.name_key_epoch
       WHERE devices.group_id = excluded.group_id`,
    ).bind(
      device.id,
      auth.groupId,
      nameEnc,
      nameIv,
      device.publicKey,
      device.signingPublicKey ?? null,
      attestation ? JSON.stringify(attestation) : null,
      deviceAuthTokenHash,
      keyEpoch,
      keyEpoch,
      now,
      auth.groupId,
      keyEpoch,
      pairingId,
    ),
    c.env.DB.prepare(
      `UPDATE pairing
          SET group_id = ?, wrapped_package = ?, ephemeral_public_key = ?
        WHERE pairing_id = ?
          AND wrapped_package IS NULL
          AND (SELECT key_epoch FROM groups WHERE id = ?) = ?
          AND EXISTS (
            SELECT 1 FROM devices
             WHERE id = ? AND group_id = ? AND revoked_at IS NULL
          )`,
    ).bind(
      auth.groupId,
      wrappedPackage,
      ephemeralPublicKey,
      pairingId,
      auth.groupId,
      keyEpoch,
      device.id,
      auth.groupId,
    ),
  ]);

  if (results[0]?.meta.changes !== 1 || results[1]?.meta.changes !== 1) {
    throw new ApiError("conflict", "Pairing became stale; start pairing again");
  }

  return json({ ok: true } satisfies PairingCompleteResponse);
}

/**
 * Step 3 (joining device, semi-open): poll until the wrapped package is ready.
 * The slot is left in place until TTL so a dropped response can be retried.
 */
export async function pollPairing(c: RouteContext): Promise<Response> {
  // Joining device polls this every few seconds while waiting for the existing
  // device to complete the wrap. The endpoint is anonymous (no auth) and each
  // poll costs a D1 read, so it has to share the public-IP rate limit with the
  // other unauthenticated endpoints to stay out of the D1 free tier.
  await rateLimit(c.env, "RL_PUBLIC", clientIp(c.request));
  const pairingId = requireId(c.params.pairingId, "pairingId");
  const slot = await c.env.DB.prepare(
    "SELECT wrapped_package AS wrapped, ephemeral_public_key AS eph FROM pairing WHERE pairing_id = ?",
  )
    .bind(pairingId)
    .first<{ wrapped: string | null; eph: string | null }>();

  if (!slot || !slot.wrapped || !slot.eph) {
    return json({ ready: false } satisfies PairingPollResponse);
  }
  return json({
    ready: true,
    wrappedPackage: slot.wrapped,
    ephemeralPublicKey: slot.eph,
  } satisfies PairingPollResponse);
}

/**
 * Step 4 (joining device, semi-open): the joining device calls this right after
 * it has successfully unwrapped the package and persisted its session, so the
 * (encrypted) slot doesn't linger reachable by `pairingId` until cron reaps it.
 * Best-effort from the client's point of view: if this never arrives, cron
 * still cleans the slot up after PAIRING_TTL.
 */
export async function deletePairing(c: RouteContext): Promise<Response> {
  const pairingId = requireId(c.params.pairingId, "pairingId");
  await c.env.DB.prepare("DELETE FROM pairing WHERE pairing_id = ?").bind(pairingId).run();
  return json({ ok: true });
}
