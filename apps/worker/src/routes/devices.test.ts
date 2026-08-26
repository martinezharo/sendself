import { SELF, env } from "cloudflare:test";
import type { DevicesListResponse } from "@sendself/shared";
import { describe, expect, it } from "vitest";
import type { SeededDevice } from "../test/helpers";
import { authHeader, errorCode, seedDevice, seedMessage, seedSpace } from "../test/helpers";

async function list(device: SeededDevice): Promise<DevicesListResponse> {
  const response = await SELF.fetch("https://x.dev/api/devices", { headers: authHeader(device) });
  return (await response.json()) as DevicesListResponse;
}

function revoke(caller: SeededDevice, targetId: string): Promise<Response> {
  return SELF.fetch(`https://x.dev/api/devices/${targetId}`, {
    method: "DELETE",
    headers: authHeader(caller),
  });
}

function setRole(caller: SeededDevice, targetId: string, role: unknown): Promise<Response> {
  return SELF.fetch(`https://x.dev/api/devices/${targetId}/role`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...authHeader(caller) },
    body: JSON.stringify({ role }),
  });
}

function publishSigningKey(device: SeededDevice, signingPublicKey: unknown): Promise<Response> {
  return SELF.fetch("https://x.dev/api/devices/self/signing-key", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeader(device) },
    body: JSON.stringify({ signingPublicKey }),
  });
}

describe("GET /api/devices", () => {
  it("lists active devices with the material needed to verify and re-key them", async () => {
    const { groupId, owner } = await seedSpace({ keyEpoch: 2, rotationPending: true });
    const member = await seedDevice(groupId, { signingPublicKey: "member-spki", keyEpoch: 1 });

    const body = await list(owner);

    expect(body.currentRole).toBe("owner");
    expect(body.keyEpoch).toBe(2);
    expect(body.rotationPending).toBe(true);
    expect(body.devices.map((d) => d.id).sort()).toEqual([member.id, owner.id].sort());
    expect(body.devices.find((d) => d.id === member.id)).toMatchObject({
      publicKey: member.publicKey,
      signingPublicKey: "member-spki",
      keyEpoch: 1,
      role: "member",
      attestation: null,
    });
  });

  it("hides revoked devices and every device of another group", async () => {
    const { groupId, owner } = await seedSpace();
    const revoked = await seedDevice(groupId, { revoked: true });
    const other = await seedSpace();

    const ids = (await list(owner)).devices.map((d) => d.id);

    expect(ids).not.toContain(revoked.id);
    expect(ids).not.toContain(other.owner.id);
  });

  it("returns the device names as ciphertext, never in the clear", async () => {
    const { owner } = await seedSpace();

    const [device] = (await list(owner)).devices;

    expect(device?.encryptedName).toBe(`enc-name-${owner.id}`);
    expect(device?.nameIv).toBe(`iv-${owner.id}`);
  });

  it("degrades a corrupt attestation to null instead of failing the listing", async () => {
    const { groupId, owner } = await seedSpace();
    const member = await seedDevice(groupId);
    await env.DB.prepare("UPDATE devices SET attestation = ? WHERE id = ?")
      .bind("{not json", member.id)
      .run();

    const body = await list(owner);

    expect(body.devices.find((d) => d.id === member.id)?.attestation).toBeNull();
  });

  it("is readable by a plain member: listing is not an admin action", async () => {
    const { groupId } = await seedSpace();
    const member = await seedDevice(groupId);

    expect((await list(member)).currentRole).toBe("member");
  });

  it("rejects an unauthenticated listing", async () => {
    expect((await SELF.fetch("https://x.dev/api/devices")).status).toBe(401);
  });
});

describe("DELETE /api/devices/:id", () => {
  it("revokes the device, drops its pending deliveries and flags a rotation", async () => {
    const { groupId, owner } = await seedSpace();
    const target = await seedDevice(groupId);
    await seedMessage(groupId, owner.id, { recipients: [target.id] });

    const response = await revoke(owner, target.id);

    expect(response.status).toBe(200);
    const device = await env.DB.prepare("SELECT revoked_at AS revokedAt FROM devices WHERE id = ?")
      .bind(target.id)
      .first<{ revokedAt: number | null }>();
    expect(device?.revokedAt).not.toBeNull();
    const deliveries = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM delivery_status WHERE device_id = ?",
    )
      .bind(target.id)
      .first<{ n: number }>();
    expect(deliveries?.n).toBe(0);
    const group = await env.DB.prepare(
      "SELECT rotation_pending AS pending FROM groups WHERE id = ?",
    )
      .bind(groupId)
      .first<{ pending: number }>();
    expect(group?.pending).toBe(1);
  });

  it("deletes a message that the revoked device was the last to owe an ack for", async () => {
    const { groupId, owner } = await seedSpace();
    const target = await seedDevice(groupId);
    const id = await seedMessage(groupId, owner.id, { recipients: [target.id] });

    await revoke(owner, target.id);

    const row = await env.DB.prepare("SELECT id FROM messages WHERE id = ?").bind(id).first();
    expect(row).toBeNull();
  });

  it("drops any key still queued for it, now undeliverable by definition", async () => {
    const { groupId, owner } = await seedSpace();
    const target = await seedDevice(groupId);
    await env.DB.prepare(
      `INSERT INTO key_distribution
         (group_id, epoch, device_id, wrapped_key, ephemeral_public_key, created_at)
       VALUES (?, 2, ?, 'w', 'e', 0)`,
    )
      .bind(groupId, target.id)
      .run();

    await revoke(owner, target.id);

    const row = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM key_distribution WHERE device_id = ?",
    )
      .bind(target.id)
      .first<{ n: number }>();
    expect(row?.n).toBe(0);
  });

  it("refuses to revoke the caller's own device", async () => {
    const { owner } = await seedSpace();

    const response = await revoke(owner, owner.id);

    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe("bad_request");
  });

  it("refuses to revoke the owner, whoever asks", async () => {
    const { groupId, owner } = await seedSpace();
    const admin = await seedDevice(groupId, { role: "admin" });

    const response = await revoke(admin, owner.id);

    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe("forbidden");
  });

  it("lets an admin revoke a member but not another admin", async () => {
    const { groupId } = await seedSpace();
    const admin = await seedDevice(groupId, { role: "admin" });
    const member = await seedDevice(groupId, { role: "member" });
    const peer = await seedDevice(groupId, { role: "admin" });

    expect((await revoke(admin, member.id)).status).toBe(200);
    expect((await revoke(admin, peer.id)).status).toBe(403);
  });

  it("refuses a plain member entirely", async () => {
    const { groupId } = await seedSpace();
    const member = await seedDevice(groupId);
    const target = await seedDevice(groupId);

    const response = await revoke(member, target.id);

    expect(response.status).toBe(403);
    const row = await env.DB.prepare("SELECT revoked_at AS revokedAt FROM devices WHERE id = ?")
      .bind(target.id)
      .first<{ revokedAt: number | null }>();
    expect(row?.revokedAt).toBeNull();
  });

  it("cannot reach a device in another group", async () => {
    const victim = await seedSpace();
    const target = await seedDevice(victim.groupId);
    const attacker = await seedSpace();

    const response = await revoke(attacker.owner, target.id);

    expect(response.status).toBe(404);
    const row = await env.DB.prepare("SELECT revoked_at AS revokedAt FROM devices WHERE id = ?")
      .bind(target.id)
      .first<{ revokedAt: number | null }>();
    expect(row?.revokedAt).toBeNull();
  });

  it("404s on a device that is already revoked", async () => {
    const { groupId, owner } = await seedSpace();
    const target = await seedDevice(groupId, { revoked: true });

    expect((await revoke(owner, target.id)).status).toBe(404);
  });
});

describe("POST /api/devices/self/signing-key", () => {
  it("publishes a key for a device that had none", async () => {
    const { groupId } = await seedSpace();
    const device = await seedDevice(groupId);

    const response = await publishSigningKey(device, "spki-new");

    expect(response.status).toBe(200);
    const row = await env.DB.prepare("SELECT signing_public_key AS key FROM devices WHERE id = ?")
      .bind(device.id)
      .first<{ key: string }>();
    expect(row?.key).toBe("spki-new");
  });

  it("is idempotent when the same key is published again", async () => {
    const { groupId } = await seedSpace();
    const device = await seedDevice(groupId, { signingPublicKey: "spki-same" });

    expect((await publishSigningKey(device, "spki-same")).status).toBe(200);
  });

  it("refuses to replace an existing key, so a leaked token cannot steal an identity", async () => {
    // Peers pin the key on first sight; letting it be replaced would let
    // whoever holds the bearer token inherit a trusted device's identity.
    const { groupId } = await seedSpace();
    const device = await seedDevice(groupId, { signingPublicKey: "spki-original" });

    const response = await publishSigningKey(device, "spki-attacker");

    expect(response.status).toBe(409);
    expect(await errorCode(response)).toBe("conflict");
    const row = await env.DB.prepare("SELECT signing_public_key AS key FROM devices WHERE id = ?")
      .bind(device.id)
      .first<{ key: string }>();
    expect(row?.key).toBe("spki-original");
  });

  it("rejects a missing key", async () => {
    const { owner } = await seedSpace();

    expect((await publishSigningKey(owner, "")).status).toBe(400);
  });

  it("rejects an unauthenticated publish", async () => {
    const response = await SELF.fetch("https://x.dev/api/devices/self/signing-key", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ signingPublicKey: "spki" }),
    });

    expect(response.status).toBe(401);
  });
});

describe("PATCH /api/devices/:id/role", () => {
  it("lets the owner promote a member to admin and demote it again", async () => {
    const { groupId, owner } = await seedSpace();
    const member = await seedDevice(groupId);

    expect((await setRole(owner, member.id, "admin")).status).toBe(200);
    expect((await list(owner)).devices.find((d) => d.id === member.id)?.role).toBe("admin");

    expect((await setRole(owner, member.id, "member")).status).toBe(200);
    expect((await list(owner)).devices.find((d) => d.id === member.id)?.role).toBe("member");
  });

  it("refuses an admin: only the owner manages administrative access", async () => {
    const { groupId } = await seedSpace();
    const admin = await seedDevice(groupId, { role: "admin" });
    const member = await seedDevice(groupId);

    const response = await setRole(admin, member.id, "admin");

    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe("forbidden");
  });

  it("refuses to change the owner's own role: ownership needs a transfer flow", async () => {
    const { owner } = await seedSpace();

    const response = await setRole(owner, owner.id, "member");

    expect(response.status).toBe(400);
  });

  it("cannot make a second owner through this endpoint", async () => {
    const { groupId, owner } = await seedSpace();
    const member = await seedDevice(groupId);

    const response = await setRole(owner, member.id, "owner");

    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe("bad_request");
  });

  it("404s on a revoked device or one from another group", async () => {
    const { groupId, owner } = await seedSpace();
    const revoked = await seedDevice(groupId, { revoked: true });
    const foreign = await seedSpace();

    expect((await setRole(owner, revoked.id, "admin")).status).toBe(404);
    expect((await setRole(owner, foreign.owner.id, "admin")).status).toBe(404);
  });
});
