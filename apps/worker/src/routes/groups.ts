import type { CreateGroupRequest, CreateGroupResponse } from "@sendself/shared";
import { optionalAttestation } from "../attestation";
import { ApiError, json } from "../errors";
import {
  optionalString,
  readJsonObject,
  requireId,
  requireSha256Hex,
  requireString,
} from "../http";
import type { RouteContext } from "../router";
import { clientIp, rateLimit } from "../security";

/**
 * Bootstrap a new group with its first device. Unauthenticated: the caller
 * proves nothing yet, but an attacker can only create empty groups (no
 * GroupKey is ever revealed). The first device stores the GroupKey + token
 * locally; the server keeps only the token hash.
 */
export async function createGroup(c: RouteContext): Promise<Response> {
  await rateLimit(c.env, "RL_PUBLIC", clientIp(c.request));
  const body = await readJsonObject<CreateGroupRequest>(c.request);
  const groupId = requireId(body.groupId, "groupId");
  const deviceAuthTokenHash = requireSha256Hex(body.deviceAuthTokenHash, "deviceAuthTokenHash");
  const device = body.device;
  if (!device || typeof device !== "object") {
    throw new ApiError("bad_request", "Missing device");
  }
  const deviceId = requireId(device.id, "device.id");
  const publicKey = requireString(device.publicKey, "device.publicKey", 2048);
  const signingPublicKey = optionalString(device.signingPublicKey, "device.signingPublicKey", 2048);
  const nameEnc = requireString(body.encryptedName, "encryptedName", 1024);
  const nameIv = requireString(body.nameIv, "nameIv", 128);
  // The founding device vouches for itself: this is the root of the trust chain
  // every device that joins later inherits through its pairing package.
  const attestation = optionalAttestation(body.attestation, "attestation", {
    groupId,
    deviceId,
    publicKey,
    ...(signingPublicKey === undefined ? {} : { signingPublicKey }),
  });

  const existing = await c.env.DB.prepare("SELECT id FROM groups WHERE id = ?")
    .bind(groupId)
    .first();
  if (existing) {
    throw new ApiError("conflict", "Group already exists");
  }

  const now = Date.now();
  await c.env.DB.batch([
    c.env.DB.prepare("INSERT INTO groups (id, auth_token_hash, created_at) VALUES (?, ?, ?)").bind(
      groupId,
      deviceAuthTokenHash,
      now,
    ),
    c.env.DB.prepare(
      `INSERT INTO devices
         (id, group_id, name_enc, name_iv, public_key, signing_public_key, attestation,
          auth_token_hash, role, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'owner', ?)`,
    ).bind(
      deviceId,
      groupId,
      nameEnc,
      nameIv,
      publicKey,
      signingPublicKey ?? null,
      attestation ? JSON.stringify(attestation) : null,
      deviceAuthTokenHash,
      now,
    ),
  ]);

  return json({ ok: true } satisfies CreateGroupResponse);
}
