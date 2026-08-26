import { SELF, env } from "cloudflare:test";
import type { CreateGroupRequest } from "@sendself/shared";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../auth";
import { errorCode, uid } from "../test/helpers";

/**
 * A fresh group + device + token per call. Device ids are a primary key across
 * every group and token hashes carry a unique index, so reusing them between
 * tests in this file would fail on a constraint rather than on the behaviour
 * under test.
 */
async function fixture(
  overrides: Partial<CreateGroupRequest> = {},
): Promise<{ payload: CreateGroupRequest; token: string; deviceId: string }> {
  const token = uid("token");
  const deviceId = uid("device");
  return {
    token,
    deviceId,
    payload: {
      groupId: uid("group"),
      deviceAuthTokenHash: await sha256Hex(token),
      device: { id: deviceId, publicKey: "ecdh-pk", signingPublicKey: "ecdsa-pk" },
      encryptedName: "name-ciphertext",
      nameIv: "name-iv",
      ...overrides,
    },
  };
}

function post(payload: unknown): Promise<Response> {
  return SELF.fetch("https://x.dev/api/groups", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

describe("POST /api/groups", () => {
  it("creates the group and makes its first device the owner", async () => {
    const { payload, deviceId } = await fixture();

    const response = await post(payload);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    const device = await env.DB.prepare(
      "SELECT role, group_id AS groupId, key_epoch AS keyEpoch FROM devices WHERE id = ?",
    )
      .bind(deviceId)
      .first<{ role: string; groupId: string; keyEpoch: number }>();
    expect(device).toEqual({ role: "owner", groupId: payload.groupId, keyEpoch: 1 });
  });

  it("starts the space at epoch 1 with no rotation owed", async () => {
    const { payload } = await fixture();

    await post(payload);

    const group = await env.DB.prepare(
      "SELECT key_epoch AS keyEpoch, rotation_pending AS pending FROM groups WHERE id = ?",
    )
      .bind(payload.groupId)
      .first<{ keyEpoch: number; pending: number }>();
    expect(group).toEqual({ keyEpoch: 1, pending: 0 });
  });

  it("stores only the token hash, never the token", async () => {
    const { payload, token, deviceId } = await fixture();

    await post(payload);

    const row = await env.DB.prepare("SELECT auth_token_hash AS hash FROM devices WHERE id = ?")
      .bind(deviceId)
      .first<{ hash: string }>();
    expect(row?.hash).toBe(await sha256Hex(token));
    expect(row?.hash).not.toBe(token);
  });

  it("stores the device name as ciphertext, since it is PII", async () => {
    const { payload, deviceId } = await fixture();

    await post(payload);

    const row = await env.DB.prepare(
      "SELECT name_enc AS enc, name_iv AS iv FROM devices WHERE id = ?",
    )
      .bind(deviceId)
      .first<{ enc: string; iv: string }>();
    expect(row).toEqual({ enc: "name-ciphertext", iv: "name-iv" });
  });

  it("keeps the founding device's self-attestation, the root of the trust chain", async () => {
    const { payload, deviceId } = await fixture();
    const attestation = {
      groupId: payload.groupId,
      deviceId,
      publicKey: "ecdh-pk",
      signingPublicKey: "ecdsa-pk",
      signerDeviceId: deviceId,
      issuedAt: 1_700_000_000_000,
      signature: "self-signature",
    };

    await post({ ...payload, attestation });

    const row = await env.DB.prepare("SELECT attestation FROM devices WHERE id = ?")
      .bind(deviceId)
      .first<{ attestation: string }>();
    expect(JSON.parse(row!.attestation)).toEqual(attestation);
  });

  it("rejects an attestation that vouches for a different device", async () => {
    const { payload, deviceId } = await fixture();

    const response = await post({
      ...payload,
      attestation: {
        groupId: payload.groupId,
        deviceId: "someone-else",
        publicKey: "ecdh-pk",
        signingPublicKey: "ecdsa-pk",
        signerDeviceId: deviceId,
        issuedAt: 1,
        signature: "s",
      },
    });

    expect(response.status).toBe(400);
  });

  it("refuses to recreate an existing group", async () => {
    const { payload } = await fixture();
    const second = await fixture({ groupId: payload.groupId });
    await post(payload);

    const response = await post(second.payload);

    expect(response.status).toBe(409);
    expect(await errorCode(response)).toBe("conflict");
  });

  it("rejects an auth token hash that is not a SHA-256 digest", async () => {
    const { payload } = await fixture({ deviceAuthTokenHash: "not-a-digest" });

    const response = await post(payload);

    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe("bad_request");
  });

  it.each([
    ["a missing device", { device: undefined }],
    ["a group id with unsafe characters", { groupId: "../evil" }],
    ["a missing public key", { device: { id: "d", publicKey: "" } }],
    ["a missing encrypted name", { encryptedName: "" }],
  ])("rejects %s", async (_label, overrides) => {
    const { payload } = await fixture(overrides as Partial<CreateGroupRequest>);

    expect((await post(payload)).status).toBe(400);
  });

  it("leaves no group behind when the device insert is rejected", async () => {
    // Group + device are written in one batch precisely so a rejected device
    // cannot leave an ownerless group nobody can ever authenticate into.
    const { payload } = await fixture({ device: { id: "bad id", publicKey: "pk" } });

    await post(payload);

    const group = await env.DB.prepare("SELECT id FROM groups WHERE id = ?")
      .bind(payload.groupId)
      .first();
    expect(group).toBeNull();
  });
});
