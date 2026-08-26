import type {
  AckKeyResponse,
  KeyWrap,
  PendingKeyDelivery,
  RotateKeyRequest,
  RotateKeyResponse,
} from "@sendself/shared";
import { authenticate } from "../auth";
import { activeDevices } from "../db";
import { ApiError, json } from "../errors";
import { readJsonObject, requireId, requireInt, requireString } from "../http";
import { notifySpace } from "../realtime";
import type { RouteContext } from "../router";
import { rateLimit } from "../security";

/** Wrapped-key blob size cap: an ECIES-wrapped 32-byte key plus JSON overhead. */
const MAX_WRAPPED_KEY = 2048;

/**
 * Rotate the group's GroupKey so a revoked device cannot read anything sent
 * from now on.
 *
 * Deliberately *only* the key rotates: every remaining device keeps its bearer
 * token, so nobody is logged out and nobody re-pairs. The caller generates the
 * new key locally and deposits it wrapped (ECIES) to each remaining device's
 * published ECDH key — the server never sees it.
 *
 * Any active device may run this, but only while a rotation is actually owed
 * (`groups.rotation_pending`, set by a revocation). That keeps the rotation
 * from being stranded on the device that pressed "Revoke" if it goes offline
 * mid-flight, without turning rotation into something a device can spam.
 */
export async function rotateKey(c: RouteContext): Promise<Response> {
  const auth = await authenticate(c.request, c.env);
  await rateLimit(c.env, "RL_WRITE", auth.deviceId);
  const body = await readJsonObject<RotateKeyRequest>(c.request);

  if (!auth.rotationPending) {
    throw new ApiError("conflict", "No key rotation is due for this space");
  }
  // A device that has not adopted the current key would rotate away from an
  // epoch it never held, silently skipping its own pending deliveries.
  if (auth.keyEpoch !== auth.groupKeyEpoch) {
    throw new ApiError("conflict", "This device has not adopted the current key yet");
  }

  const previousEpoch = auth.groupKeyEpoch;
  const epoch = requireInt(body.epoch, "epoch", 1, Number.MAX_SAFE_INTEGER);
  if (epoch !== previousEpoch + 1) {
    // Someone else rotated first. The caller adopts their key on the next poll.
    throw new ApiError("conflict", "The key was already rotated by another device");
  }

  if (!Array.isArray(body.wraps)) {
    throw new ApiError("bad_request", "Missing wraps");
  }
  const wraps: KeyWrap[] = body.wraps.map((wrap) => ({
    deviceId: requireId(wrap?.deviceId, "wraps[].deviceId"),
    wrappedKey: requireString(wrap?.wrappedKey, "wraps[].wrappedKey", MAX_WRAPPED_KEY),
    ephemeralPublicKey: requireString(wrap?.ephemeralPublicKey, "wraps[].ephemeralPublicKey", 2048),
  }));

  // The new key must reach every remaining device and nobody else. Checking the
  // set exactly (rather than just "these ids are members") is what stops a
  // caller from quietly leaving one device behind to strand it, or from
  // depositing a blob for a device that is not in the space.
  const recipients = (await activeDevices(c.env, auth.groupId))
    .map((d) => d.id)
    .filter((id) => id !== auth.deviceId);
  const wrapped = new Set(wraps.map((w) => w.deviceId));
  if (wrapped.size !== wraps.length) {
    throw new ApiError("bad_request", "Duplicate device in wraps");
  }
  if (wrapped.size !== recipients.length || recipients.some((id) => !wrapped.has(id))) {
    throw new ApiError("conflict", "Device list changed while rotating; try again");
  }

  const now = Date.now();
  // Every statement is guarded on the *previous* epoch, and the compare-and-swap
  // on `groups` runs last. Two devices rotating at once therefore produce one
  // winner and one caller whose batch is a complete no-op — never a split brain
  // where some devices got epoch N from one rotation and some from another.
  const statements = [
    ...wraps.map((wrap) =>
      c.env.DB.prepare(
        `INSERT INTO key_distribution
           (group_id, epoch, device_id, wrapped_key, ephemeral_public_key, created_at)
         SELECT ?, ?, ?, ?, ?, ?
          WHERE (SELECT key_epoch FROM groups WHERE id = ?) = ?
            AND EXISTS (
              SELECT 1 FROM devices
               WHERE id = ? AND group_id = ? AND revoked_at IS NULL
            )`,
      ).bind(
        auth.groupId,
        epoch,
        wrap.deviceId,
        wrap.wrappedKey,
        wrap.ephemeralPublicKey,
        now,
        auth.groupId,
        previousEpoch,
        wrap.deviceId,
        auth.groupId,
      ),
    ),
    // The rotating device adopts the new key by construction: it generated it.
    c.env.DB.prepare(
      `UPDATE devices
          SET key_epoch = ?
        WHERE id = ? AND group_id = ? AND revoked_at IS NULL AND key_epoch = ?`,
    ).bind(epoch, auth.deviceId, auth.groupId, previousEpoch),
    c.env.DB.prepare(
      `UPDATE groups
          SET key_epoch = ?, rotation_pending = 0
        WHERE id = ? AND key_epoch = ? AND rotation_pending = 1
          AND EXISTS (
            SELECT 1 FROM devices
             WHERE id = ? AND group_id = ? AND revoked_at IS NULL AND key_epoch = ?
          )
          AND NOT EXISTS (
            SELECT 1 FROM devices AS d
             WHERE d.group_id = ?
               AND d.revoked_at IS NULL
               AND d.id != ?
               AND NOT EXISTS (
                 SELECT 1 FROM key_distribution AS kd
                  WHERE kd.group_id = ? AND kd.epoch = ? AND kd.device_id = d.id
               )
          )`,
    ).bind(
      epoch,
      auth.groupId,
      previousEpoch,
      auth.deviceId,
      auth.groupId,
      epoch,
      auth.groupId,
      auth.deviceId,
      auth.groupId,
      epoch,
    ),
  ];

  const results = await c.env.DB.batch(statements);
  if (results[results.length - 1]?.meta.changes !== 1) {
    throw new ApiError("conflict", "The key was already rotated by another device");
  }

  // Every remaining device now has a wrapped key waiting; the sooner they adopt
  // it, the shorter the window in which their sends are refused as `key_rotated`.
  c.ctx.waitUntil(notifySpace(c.env, auth.groupId, auth.deviceId));

  return json({ ok: true, epoch, devices: wraps.length } satisfies RotateKeyResponse);
}

/**
 * Adopt a delivered GroupKey. Dropping the blob here (rather than marking it
 * read) is what keeps the server holding a wrapped key only for as long as some
 * device still needs it.
 */
export async function ackKey(c: RouteContext): Promise<Response> {
  const auth = await authenticate(c.request, c.env);
  const epoch = Number(c.params.epoch);
  if (!Number.isInteger(epoch) || epoch < 1) {
    throw new ApiError("bad_request", "Invalid epoch");
  }
  if (epoch > auth.groupKeyEpoch) {
    throw new ApiError("bad_request", "Unknown epoch");
  }

  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE devices SET key_epoch = ? WHERE id = ? AND key_epoch < ?").bind(
      epoch,
      auth.deviceId,
      epoch,
    ),
    c.env.DB.prepare(
      "DELETE FROM key_distribution WHERE device_id = ? AND group_id = ? AND epoch <= ?",
    ).bind(auth.deviceId, auth.groupId, epoch),
  ]);

  return json({ ok: true } satisfies AckKeyResponse);
}

/** Keys this device has not adopted yet, oldest first (usually none). */
export async function pendingKeysFor(
  env: RouteContext["env"],
  groupId: string,
  deviceId: string,
): Promise<PendingKeyDelivery[]> {
  const rows = await env.DB.prepare(
    `SELECT epoch, wrapped_key AS wrappedKey, ephemeral_public_key AS ephemeralPublicKey
       FROM key_distribution
      WHERE group_id = ? AND device_id = ?
      ORDER BY epoch ASC`,
  )
    .bind(groupId, deviceId)
    .all<PendingKeyDelivery>();
  return rows.results;
}
