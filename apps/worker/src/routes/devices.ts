import type {
  AssignableDeviceRole,
  DeviceInfo,
  DevicesListResponse,
  PublishSigningKeyRequest,
  PublishSigningKeyResponse,
  RevokeDeviceResponse,
  UpdateDeviceRoleRequest,
  UpdateDeviceRoleResponse,
} from "@sendself/shared";
import { parseAttestation } from "../attestation";
import { authenticate, requireAdmin, requireOwner } from "../auth";
import { purgeDeliveredMessages } from "../db";
import { ApiError, json } from "../errors";
import { readJsonObject, requireId, requireString } from "../http";
import { notifySpace } from "../realtime";
import type { RouteContext } from "../router";

/**
 * List active devices in the caller's group. `publicKey` and `keyEpoch` are
 * included because this is also the input to a key rotation: the caller wraps
 * the new key for exactly these devices, and the epochs say which of them are
 * still catching up. `signingPublicKey` + `attestation` are what turn this list
 * from "what the server claims" into something the caller can verify itself.
 */
export async function listDevices(c: RouteContext): Promise<Response> {
  const auth = await authenticate(c.request, c.env);
  const rows = await c.env.DB.prepare(
    `SELECT id, name_enc AS encryptedName, name_iv AS nameIv, role,
            public_key AS publicKey, signing_public_key AS signingPublicKey,
            attestation, key_epoch AS keyEpoch,
            name_key_epoch AS nameKeyEpoch, created_at AS createdAt
       FROM devices
      WHERE group_id = ? AND revoked_at IS NULL
      ORDER BY created_at ASC, id ASC`,
  )
    .bind(auth.groupId)
    .all<Omit<DeviceInfo, "attestation"> & { attestation: string | null }>();
  return json({
    devices: rows.results.map((row) => ({
      ...row,
      attestation: parseAttestation(row.attestation),
    })),
    currentRole: auth.role,
    keyEpoch: auth.groupKeyEpoch,
    rotationPending: auth.rotationPending,
  } satisfies DevicesListResponse);
}

/**
 * Revoke a device: mark it revoked, drop its pending deliveries so it no longer
 * blocks immediate deletion of fully-delivered messages, and flag the group as
 * owing a key rotation. Then purge any messages that just became fully
 * delivered.
 *
 * The rotation itself happens client-side (the server must never see the
 * GroupKey): the caller performs it immediately after this returns, and the
 * `rotation_pending` flag makes any other active device finish the job if that
 * one goes offline first. Until it lands, the revoked device is already denied
 * by the API — the rotation is what also stops it decrypting ciphertext it
 * captures by any other route.
 */
export async function revokeDevice(c: RouteContext): Promise<Response> {
  const auth = await authenticate(c.request, c.env);
  requireAdmin(auth);
  const deviceId = requireId(c.params.id, "id");

  if (deviceId === auth.deviceId) {
    throw new ApiError("bad_request", "You cannot revoke the device you are currently using");
  }

  const target = await c.env.DB.prepare(
    "SELECT role FROM devices WHERE id = ? AND group_id = ? AND revoked_at IS NULL",
  )
    .bind(deviceId, auth.groupId)
    .first<{ role: DeviceInfo["role"] }>();
  if (!target) throw new ApiError("not_found", "Active device not found");
  if (target.role === "owner") throw new ApiError("forbidden", "The space owner cannot be revoked");
  if (target.role === "admin" && auth.role !== "owner") {
    throw new ApiError("forbidden", "Only the space owner can revoke an administrator");
  }

  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE devices SET revoked_at = ? WHERE id = ? AND group_id = ?").bind(
      Date.now(),
      deviceId,
      auth.groupId,
    ),
    c.env.DB.prepare(
      "DELETE FROM delivery_status WHERE device_id = ? AND downloaded_at IS NULL",
    ).bind(deviceId),
    // Any key still queued for it is now undeliverable by definition.
    c.env.DB.prepare("DELETE FROM key_distribution WHERE device_id = ? AND group_id = ?").bind(
      deviceId,
      auth.groupId,
    ),
    c.env.DB.prepare("UPDATE groups SET rotation_pending = 1 WHERE id = ?").bind(auth.groupId),
  ]);

  await purgeDeliveredMessages(c.env, auth.groupId);

  // The space now owes a rotation. Telling the other devices immediately is
  // what makes the rotation land in seconds rather than at the next poll, and
  // the revoked device is already denied by `authenticate` before it could
  // receive anything here.
  c.ctx.waitUntil(notifySpace(c.env, auth.groupId, auth.deviceId));

  return json({ ok: true } satisfies RevokeDeviceResponse);
}

/**
 * Publish this device's signing key.
 *
 * The upgrade path for a device that existed before sender authenticity: it
 * mints a signing keypair locally and announces the public half here, without
 * re-pairing or any user-visible step. Until it does, its messages are
 * unsigned and its peers treat them as merely unverifiable.
 *
 * Set-once, and only by the device itself. Refusing to replace an existing key
 * matters: peers pin it on first sight, so a token that leaked could otherwise
 * install a signing key of the attacker's choosing and inherit the identity of
 * a device the others already trust. A device that genuinely needs a new
 * signing key is a device that has to be linked again — which mints a new
 * identity, attested by whoever scans its code.
 */
export async function publishSigningKey(c: RouteContext): Promise<Response> {
  const auth = await authenticate(c.request, c.env);
  const body = await readJsonObject<PublishSigningKeyRequest>(c.request);
  const signingPublicKey = requireString(body.signingPublicKey, "signingPublicKey", 2048);

  const result = await c.env.DB.prepare(
    `UPDATE devices SET signing_public_key = ?
      WHERE id = ? AND group_id = ? AND revoked_at IS NULL
        AND (signing_public_key IS NULL OR signing_public_key = ?)`,
  )
    .bind(signingPublicKey, auth.deviceId, auth.groupId, signingPublicKey)
    .run();
  if (result.meta.changes === 0) {
    throw new ApiError("conflict", "This device already published a different signing key");
  }

  return json({ ok: true } satisfies PublishSigningKeyResponse);
}

/** Change administrative access. Ownership is intentionally immutable until a transfer flow exists. */
export async function updateDeviceRole(c: RouteContext): Promise<Response> {
  const auth = await authenticate(c.request, c.env);
  requireOwner(auth);
  const deviceId = requireId(c.params.id, "id");
  if (deviceId === auth.deviceId) {
    throw new ApiError("bad_request", "Transfer ownership before changing your own role");
  }

  const body = await readJsonObject<UpdateDeviceRoleRequest>(c.request);
  if (body.role !== "admin" && body.role !== "member") {
    throw new ApiError("bad_request", "Role must be admin or member");
  }
  const role: AssignableDeviceRole = body.role;
  const result = await c.env.DB.prepare(
    "UPDATE devices SET role = ? WHERE id = ? AND group_id = ? AND revoked_at IS NULL AND role != 'owner'",
  )
    .bind(role, deviceId, auth.groupId)
    .run();
  if (result.meta.changes === 0) throw new ApiError("not_found", "Active device not found");

  return json({ ok: true } satisfies UpdateDeviceRoleResponse);
}
