import type { DeviceRole } from "@sendself/shared";
import type { Env } from "./env";
import { ApiError } from "./errors";

export interface AuthContext {
  groupId: string;
  deviceId: string;
  role: DeviceRole;
  /** Highest GroupKey epoch this device has adopted. */
  keyEpoch: number;
  /** The group's current GroupKey epoch. Equal to `keyEpoch` once caught up. */
  groupKeyEpoch: number;
  /** A revocation is still waiting for its key rotation. */
  rotationPending: boolean;
  /**
   * This device has published a signing key, so everything it sends must be
   * signed. Lets the server refuse an unsigned message from a device its peers
   * will expect a signature from, instead of letting it land as unverifiable.
   */
  hasSigningKey: boolean;
}

/** SHA-256 of a UTF-8 string as lowercase hex. */
export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Authenticate a request via a bearer token unique to one device.
 *
 * The raw token never reaches the server in storage: we hash the presented
 * token and look the group up by that hash. The device must exist, belong to
 * the group and not be revoked.
 */
export async function authenticate(request: Request, env: Env): Promise<AuthContext> {
  const header = request.headers.get("Authorization") ?? "";
  const match = /^Bearer\s+(.+)$/.exec(header);
  if (!match) {
    throw new ApiError("unauthorized", "Missing bearer token");
  }
  const tokenHash = await sha256Hex(match[1]!.trim());

  const row = await env.DB.prepare(
    `SELECT d.group_id AS groupId, d.id AS deviceId, d.role AS role,
            d.revoked_at AS revokedAt, d.key_epoch AS keyEpoch,
            d.signing_public_key AS signingPublicKey,
            g.key_epoch AS groupKeyEpoch, g.rotation_pending AS rotationPending
       FROM devices d
       JOIN groups g ON g.id = d.group_id
      WHERE d.auth_token_hash = ?`,
  )
    .bind(tokenHash)
    .first<{
      groupId: string;
      deviceId: string;
      role: DeviceRole;
      revokedAt: number | null;
      keyEpoch: number;
      signingPublicKey: string | null;
      groupKeyEpoch: number;
      rotationPending: number;
    }>();
  if (!row) {
    throw new ApiError("unauthorized", "Invalid token");
  }
  if (row.revokedAt !== null) {
    throw new ApiError(
      "device_revoked",
      "This device has been revoked. Link it again to reconnect.",
    );
  }

  return {
    groupId: row.groupId,
    deviceId: row.deviceId,
    role: row.role,
    keyEpoch: row.keyEpoch,
    groupKeyEpoch: row.groupKeyEpoch,
    rotationPending: row.rotationPending === 1,
    hasSigningKey: row.signingPublicKey !== null,
  };
}

export function requireAdmin(auth: AuthContext): void {
  if (auth.role !== "owner" && auth.role !== "admin") {
    throw new ApiError("forbidden", "Only space administrators can do that");
  }
}

export function requireOwner(auth: AuthContext): void {
  if (auth.role !== "owner") {
    throw new ApiError("forbidden", "Only the space owner can do that");
  }
}
