import type {
  SpaceNameRecord,
  UpdateSpaceNameRequest,
  UpdateSpaceNameResponse,
} from "@sendself/shared";
import { authenticate } from "../auth";
import { ApiError, json } from "../errors";
import { optionalString, readJsonObject, requireInt } from "../http";
import { notifySpace } from "../realtime";
import type { RouteContext } from "../router";
import { rateLimit } from "../security";

/**
 * Set the name every device in the space calls it by.
 *
 * Open to any active device, unlike revocation or role changes: the space's
 * name is a shared preference between someone's own devices, not an
 * administrative act, and the alternative would be a "Rename" that silently
 * fails on half of them.
 *
 * The name arrives already encrypted with the GroupKey, so this only ever
 * stores an opaque blob. The timestamp is the server's, which is what makes two
 * devices renaming at once resolve the same way for everyone: the write that
 * lands last wins, and the other device adopts it on its next poll.
 */
export async function updateSpaceName(c: RouteContext): Promise<Response> {
  const auth = await authenticate(c.request, c.env);
  await rateLimit(c.env, "RL_WRITE", auth.deviceId);
  const body = await readJsonObject<UpdateSpaceNameRequest>(c.request);

  const encryptedName = optionalString(body.encryptedName, "encryptedName", 1024);
  const nameIv = optionalString(body.nameIv, "nameIv", 128);
  const nameKeyEpoch = requireInt(body.nameKeyEpoch, "nameKeyEpoch", 1, Number.MAX_SAFE_INTEGER);

  // Half a ciphertext is a name nobody can ever read again: refuse it here
  // rather than store something every device will fail to decrypt forever.
  if (Boolean(encryptedName) !== Boolean(nameIv)) {
    throw new ApiError("bad_request", "encryptedName and nameIv go together");
  }

  // Same rule as a message: content encrypted under a superseded key is refused
  // outright, so a revoked device can never read what was written after it left.
  if (nameKeyEpoch !== auth.groupKeyEpoch) {
    throw new ApiError(
      "key_rotated",
      "The space key has rotated; encrypt the name with the new key",
    );
  }

  const updatedAt = Date.now();
  await c.env.DB.prepare(
    "UPDATE groups SET name_enc = ?, name_iv = ?, name_key_epoch = ?, name_updated_at = ? WHERE id = ?",
  )
    .bind(encryptedName ?? null, nameIv ?? null, nameKeyEpoch, updatedAt, auth.groupId)
    .run();

  // Same reasoning as a sent message: the other devices should show the new
  // name in seconds rather than at their next poll, and a notification that
  // fails costs nothing but that latency.
  c.ctx.waitUntil(notifySpace(c.env, auth.groupId, auth.deviceId));

  return json({ ok: true, updatedAt } satisfies UpdateSpaceNameResponse);
}

/** The space's shared name, or null while nobody has ever set one. */
export async function spaceNameRecord(
  env: RouteContext["env"],
  groupId: string,
): Promise<SpaceNameRecord | null> {
  const row = await env.DB.prepare(
    `SELECT name_enc AS encryptedName, name_iv AS nameIv,
            name_key_epoch AS nameKeyEpoch, name_updated_at AS updatedAt
       FROM groups
      WHERE id = ?`,
  )
    .bind(groupId)
    .first<{
      encryptedName: string | null;
      nameIv: string | null;
      nameKeyEpoch: number | null;
      updatedAt: number | null;
    }>();
  // A group that predates shared names has the columns but nothing in them.
  if (!row || row.updatedAt === null || row.nameKeyEpoch === null) return null;
  return {
    encryptedName: row.encryptedName,
    nameIv: row.nameIv,
    nameKeyEpoch: row.nameKeyEpoch,
    updatedAt: row.updatedAt,
  };
}
