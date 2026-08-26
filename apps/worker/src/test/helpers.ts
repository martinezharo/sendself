import { env } from "cloudflare:test";
import type { DeviceRole } from "@sendself/shared";
import { sha256Hex } from "../auth";

/**
 * Seeding helpers.
 *
 * Tests build their fixtures by writing rows directly rather than by driving
 * the public API: a test for revocation should fail when revocation breaks, not
 * when pairing does. The routes that *create* those rows are covered by their
 * own tests, end to end.
 */

export interface SeededDevice {
  id: string;
  /** The raw bearer token; only its hash is stored. */
  token: string;
  publicKey: string;
  role: DeviceRole;
}

let counter = 0;

/**
 * Unique-per-call id.
 *
 * Tests in one file share a database, and several columns are globally unique
 * (`devices.id` is a PK across groups, `devices.auth_token_hash` has a unique
 * index). Fixtures therefore have to be unique per call rather than per test,
 * or one test's leftovers make the next one fail for the wrong reason.
 */
export function uid(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}`;
}

export function authHeader(device: SeededDevice): Record<string, string> {
  return { Authorization: `Bearer ${device.token}` };
}

export async function seedGroup(
  options: { groupId?: string; keyEpoch?: number; rotationPending?: boolean } = {},
): Promise<string> {
  const groupId = options.groupId ?? uid("group");
  await env.DB.prepare(
    `INSERT INTO groups (id, auth_token_hash, created_at, key_epoch, rotation_pending)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(
      groupId,
      await sha256Hex(uid("legacy-token")),
      Date.now(),
      options.keyEpoch ?? 1,
      options.rotationPending ? 1 : 0,
    )
    .run();
  return groupId;
}

export async function seedDevice(
  groupId: string,
  options: {
    id?: string;
    role?: DeviceRole;
    keyEpoch?: number;
    nameKeyEpoch?: number;
    revoked?: boolean;
    signingPublicKey?: string | null;
    publicKey?: string;
    createdAt?: number;
  } = {},
): Promise<SeededDevice> {
  const id = options.id ?? uid("device");
  const token = uid("token");
  const publicKey = options.publicKey ?? `pk-${id}`;
  const role = options.role ?? "member";

  await env.DB.prepare(
    `INSERT INTO devices
       (id, group_id, name_enc, name_iv, public_key, signing_public_key,
        auth_token_hash, role, key_epoch, name_key_epoch, created_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      groupId,
      `enc-name-${id}`,
      `iv-${id}`,
      publicKey,
      options.signingPublicKey ?? null,
      await sha256Hex(token),
      role,
      options.keyEpoch ?? 1,
      options.nameKeyEpoch ?? 1,
      options.createdAt ?? Date.now(),
      options.revoked ? Date.now() : null,
    )
    .run();

  return { id, token, publicKey, role };
}

/** A group with an owner device, the shape almost every test starts from. */
export async function seedSpace(
  options: { keyEpoch?: number; rotationPending?: boolean } = {},
): Promise<{ groupId: string; owner: SeededDevice }> {
  const groupId = await seedGroup(options);
  const owner = await seedDevice(groupId, {
    role: "owner",
    keyEpoch: options.keyEpoch ?? 1,
    nameKeyEpoch: options.keyEpoch ?? 1,
  });
  return { groupId, owner };
}

export async function seedMessage(
  groupId: string,
  senderDeviceId: string,
  options: {
    id?: string;
    recipients?: readonly string[];
    fileR2Key?: string | null;
    createdAt?: number;
    keyEpoch?: number;
  } = {},
): Promise<string> {
  const id = options.id ?? uid("message");
  await env.DB.prepare(
    `INSERT INTO messages
       (id, group_id, sender_device_id, encrypted_payload, iv, file_r2_key, file_iv,
        file_meta, file_meta_iv, key_epoch, signature, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, NULL, ?)`,
  )
    .bind(
      id,
      groupId,
      senderDeviceId,
      "ciphertext",
      "iv",
      options.fileR2Key ?? null,
      options.fileR2Key ? "file-iv" : null,
      options.keyEpoch ?? 1,
      options.createdAt ?? Date.now(),
    )
    .run();

  for (const deviceId of options.recipients ?? []) {
    await env.DB.prepare(
      "INSERT INTO delivery_status (message_id, device_id, downloaded_at) VALUES (?, ?, NULL)",
    )
      .bind(id, deviceId)
      .run();
  }
  return id;
}

/** Parse a JSON error response body into its code, for readable assertions. */
export async function errorCode(response: Response): Promise<string> {
  const body = (await response.json()) as { error?: { code?: string } };
  return body.error?.code ?? "";
}
