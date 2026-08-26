import { SELF, env } from "cloudflare:test";
import type {
  DeviceDescriptor,
  PairingCompleteBody,
  PairingPollResponse,
  RotateKeyRequest,
} from "@sendself/shared";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../auth";
import type { SeededDevice } from "../test/helpers";
import { authHeader, errorCode, seedDevice, seedSpace, uid } from "../test/helpers";

/**
 * A joining device, unique per call: `devices.id` is a primary key across every
 * group, so a shared id would make one test fail on another test's leftovers.
 */
function joiner(overrides: Partial<DeviceDescriptor> = {}): DeviceDescriptor {
  const id = uid("joiner");
  return { id, publicKey: `${id}-ecdh`, signingPublicKey: `${id}-ecdsa`, ...overrides };
}

/** Step 1: the joining device reserves the slot anonymously. */
function request(pairingId: string, device: unknown): Promise<Response> {
  return SELF.fetch(`https://x.dev/api/pairing/${pairingId}/request`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ device }),
  });
}

function rotate(adder: SeededDevice, body: RotateKeyRequest): Promise<Response> {
  return SELF.fetch("https://x.dev/api/keys/rotate", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeader(adder) },
    body: JSON.stringify(body),
  });
}

/** Step 2: an existing device deposits the wrapped package. */
async function complete(
  pairingId: string,
  adder: SeededDevice,
  device: DeviceDescriptor,
  overrides: Partial<PairingCompleteBody> = {},
): Promise<Response> {
  const payload: PairingCompleteBody = {
    wrappedPackage: "wrapped",
    ephemeralPublicKey: "ephemeral",
    scannedPublicKey: device.publicKey,
    scannedSigningPublicKey: device.signingPublicKey,
    encryptedName: "name-ct",
    nameIv: "name-iv",
    deviceAuthTokenHash: await sha256Hex(uid("joiner-token")),
    keyEpoch: 1,
    ...overrides,
  };
  return SELF.fetch(`https://x.dev/api/pairing/${pairingId}/complete`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeader(adder) },
    body: JSON.stringify(payload),
  });
}

describe("POST /api/pairing/:id/request", () => {
  it("reserves the slot and stores the joining device's public material", async () => {
    const device = joiner();
    const slot = uid("slot");

    const response = await request(slot, device);

    expect(response.status).toBe(200);
    const row = await env.DB.prepare(
      "SELECT new_device AS device FROM pairing WHERE pairing_id = ?",
    )
      .bind(slot)
      .first<{ device: string }>();
    expect(JSON.parse(row!.device)).toEqual(device);
  });

  it("refuses to reuse a slot id someone already claimed", async () => {
    const slot = uid("slot");
    await request(slot, joiner());

    const response = await request(slot, joiner());

    expect(response.status).toBe(409);
    expect(await errorCode(response)).toBe("conflict");
  });

  it("rejects a slot id that is not URL-safe", async () => {
    // It never reaches the handler: the path does not route at all, which is
    // what keeps a traversal out of the id in the first place.
    expect((await request("../evil", joiner())).status).toBe(404);
  });

  it("rejects a device without a public key", async () => {
    expect((await request(uid("slot"), { id: "d", publicKey: "" })).status).toBe(400);
  });
});

describe("POST /api/pairing/:id/complete", () => {
  it("registers the joining device as a member and deposits the wrapped package", async () => {
    const { groupId, owner } = await seedSpace();
    const device = joiner();
    const slot = uid("slot");
    await request(slot, device);

    const response = await complete(slot, owner, device);

    expect(response.status).toBe(200);
    const row = await env.DB.prepare(
      `SELECT group_id AS groupId, role, public_key AS publicKey,
              signing_public_key AS signingPublicKey, key_epoch AS keyEpoch
         FROM devices WHERE id = ?`,
    )
      .bind(device.id)
      .first<Record<string, unknown>>();
    expect(row).toEqual({
      groupId,
      role: "member",
      publicKey: device.publicKey,
      signingPublicKey: device.signingPublicKey,
      keyEpoch: 1,
    });
    const stored = await env.DB.prepare(
      "SELECT wrapped_package AS wrapped, group_id AS groupId FROM pairing WHERE pairing_id = ?",
    )
      .bind(slot)
      .first<{ wrapped: string; groupId: string }>();
    expect(stored).toEqual({ wrapped: "wrapped", groupId });
  });

  it("lets an admin add a device", async () => {
    const { groupId } = await seedSpace();
    const admin = await seedDevice(groupId, { role: "admin" });
    const device = joiner();
    const slot = uid("slot");
    await request(slot, device);

    expect((await complete(slot, admin, device)).status).toBe(200);
  });

  it("refuses a plain member, who may not change membership", async () => {
    const { groupId } = await seedSpace();
    const member = await seedDevice(groupId, { role: "member" });
    const device = joiner();
    const slot = uid("slot");
    await request(slot, device);

    const response = await complete(slot, member, device);

    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe("forbidden");
  });

  it("rejects a stale key epoch instead of handing over a superseded key", async () => {
    const { owner } = await seedSpace({ keyEpoch: 3 });
    const device = joiner();
    const slot = uid("slot");
    await request(slot, device);

    const response = await complete(slot, owner, device, { keyEpoch: 2 });

    expect(response.status).toBe(409);
    expect(await errorCode(response)).toBe("key_rotated");
  });

  it("does not let pairing and key rotation commit a stale device", async () => {
    const { groupId, owner } = await seedSpace({ rotationPending: true });
    const device = joiner();
    const slot = uid("slot");
    await request(slot, device);

    const [pairingResponse, rotationResponse] = await Promise.all([
      complete(slot, owner, device),
      rotate(owner, { epoch: 2, wraps: [] }),
    ]);

    // One transaction must win the epoch/slot race. If pairing wins, rotation
    // must retry with the new recipient; if rotation wins, pairing must not
    // leave a device registered with a package encrypted for epoch 1.
    expect([pairingResponse.status, rotationResponse.status].sort()).toEqual([200, 409]);
    const group = await env.DB.prepare("SELECT key_epoch AS epoch FROM groups WHERE id = ?")
      .bind(groupId)
      .first<{ epoch: number }>();
    const registered = await env.DB.prepare(
      "SELECT key_epoch AS epoch FROM devices WHERE id = ? AND group_id = ?",
    )
      .bind(device.id, groupId)
      .first<{ epoch: number }>();

    if (rotationResponse.status === 200) {
      expect(group?.epoch).toBe(2);
      expect(registered).toBeNull();
    } else {
      expect(group?.epoch).toBe(1);
      expect(registered?.epoch).toBe(1);
    }
  });

  it("rejects a slot whose published key is not the one that was scanned", async () => {
    // The wrap targets the key read from the QR code; if the slot holds a
    // different one, the GroupKey would go to a device nobody ever scanned.
    const { owner } = await seedSpace();
    const device = joiner();
    const slot = uid("slot");
    await request(slot, { ...device, publicKey: "swapped-by-the-server" });

    const response = await complete(slot, owner, device);

    expect(response.status).toBe(409);
    expect(await errorCode(response)).toBe("conflict");
  });

  it("rejects a slot whose signing key is not the one that was scanned", async () => {
    const { owner } = await seedSpace();
    const device = joiner();
    const slot = uid("slot");
    await request(slot, { ...device, signingPublicKey: "swapped" });

    expect((await complete(slot, owner, device)).status).toBe(409);
  });

  it("requires the attestation to be signed by the device doing the adding", async () => {
    const { groupId, owner } = await seedSpace();
    const device = joiner();
    const slot = uid("slot");
    await request(slot, device);

    const response = await complete(slot, owner, device, {
      attestation: {
        groupId,
        deviceId: device.id,
        publicKey: device.publicKey,
        signingPublicKey: device.signingPublicKey!,
        signerDeviceId: "somebody-else",
        issuedAt: 1,
        signature: "s",
      },
    });

    expect(response.status).toBe(400);
  });

  it("stores an attestation issued by the adding device", async () => {
    const { groupId, owner } = await seedSpace();
    const device = joiner();
    const slot = uid("slot");
    await request(slot, device);
    const attestation = {
      groupId,
      deviceId: device.id,
      publicKey: device.publicKey,
      signingPublicKey: device.signingPublicKey!,
      signerDeviceId: owner.id,
      issuedAt: 1_700_000_000_000,
      signature: "introducer-signature",
    };

    await complete(slot, owner, device, { attestation });

    const row = await env.DB.prepare("SELECT attestation FROM devices WHERE id = ?")
      .bind(device.id)
      .first<{ attestation: string }>();
    expect(JSON.parse(row!.attestation)).toEqual(attestation);
  });

  it("refuses a slot that was already completed", async () => {
    const { owner } = await seedSpace();
    const device = joiner();
    const slot = uid("slot");
    await request(slot, device);
    await complete(slot, owner, device);

    expect((await complete(slot, owner, device)).status).toBe(409);
  });

  it("404s on a slot that never existed or has been reaped", async () => {
    const { owner } = await seedSpace();

    const response = await complete(uid("missing-slot"), owner, joiner());

    expect(response.status).toBe(404);
    expect(await errorCode(response)).toBe("not_found");
  });

  it("cannot un-revoke a device that belongs to another group", async () => {
    // The device id in step 1 is published anonymously, so it can name a device
    // registered elsewhere. Letting the upsert run would clear its revoked_at
    // and give it a fresh token: a revocation bypass.
    const victim = await seedSpace();
    const revoked = await seedDevice(victim.groupId, { revoked: true });
    const attacker = await seedSpace();
    const slot = uid("slot");
    const impersonation: DeviceDescriptor = { id: revoked.id, publicKey: "attacker-key" };
    await request(slot, impersonation);

    const response = await complete(slot, attacker.owner, impersonation);

    expect(response.status).toBe(409);
    const row = await env.DB.prepare(
      "SELECT group_id AS groupId, revoked_at AS revokedAt FROM devices WHERE id = ?",
    )
      .bind(revoked.id)
      .first<{ groupId: string; revokedAt: number | null }>();
    expect(row?.groupId).toBe(victim.groupId);
    expect(row?.revokedAt).not.toBeNull();
  });

  it("re-links a device that was revoked from this same group", async () => {
    const { groupId, owner } = await seedSpace();
    const revoked = await seedDevice(groupId, { revoked: true });
    const slot = uid("slot");
    const relink: DeviceDescriptor = { id: revoked.id, publicKey: "new-key" };
    await request(slot, relink);

    const response = await complete(slot, owner, relink);

    expect(response.status).toBe(200);
    const row = await env.DB.prepare(
      "SELECT revoked_at AS revokedAt, role FROM devices WHERE id = ?",
    )
      .bind(revoked.id)
      .first<{ revokedAt: number | null; role: string }>();
    expect(row).toEqual({ revokedAt: null, role: "member" });
  });

  it("demotes a re-linked admin back to member rather than restoring its role", async () => {
    const { groupId, owner } = await seedSpace();
    const revoked = await seedDevice(groupId, { role: "admin", revoked: true });
    const slot = uid("slot");
    const relink: DeviceDescriptor = { id: revoked.id, publicKey: "new-key" };
    await request(slot, relink);

    await complete(slot, owner, relink);

    const row = await env.DB.prepare("SELECT role FROM devices WHERE id = ?")
      .bind(revoked.id)
      .first<{ role: string }>();
    expect(row?.role).toBe("member");
  });

  it("rejects an unauthenticated caller", async () => {
    const slot = uid("slot");
    await request(slot, joiner());

    const response = await SELF.fetch(`https://x.dev/api/pairing/${slot}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(401);
  });
});

describe("GET /api/pairing/:id", () => {
  it("reports not ready until the package lands", async () => {
    const slot = uid("slot");
    await request(slot, joiner());

    const response = await SELF.fetch(`https://x.dev/api/pairing/${slot}`);

    expect(await response.json()).toEqual({ ready: false } satisfies PairingPollResponse);
  });

  it("reports not ready for a slot that does not exist, leaking nothing", async () => {
    const response = await SELF.fetch(`https://x.dev/api/pairing/${uid("never-existed")}`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ready: false });
  });

  it("returns the wrapped package once the adding device completed it", async () => {
    const { owner } = await seedSpace();
    const device = joiner();
    const slot = uid("slot");
    await request(slot, device);
    await complete(slot, owner, device);

    const response = await SELF.fetch(`https://x.dev/api/pairing/${slot}`);

    expect(await response.json()).toEqual({
      ready: true,
      wrappedPackage: "wrapped",
      ephemeralPublicKey: "ephemeral",
    } satisfies PairingPollResponse);
  });
});

describe("DELETE /api/pairing/:id", () => {
  it("drops the slot so the encrypted package stops being reachable", async () => {
    const { owner } = await seedSpace();
    const device = joiner();
    const slot = uid("slot");
    await request(slot, device);
    await complete(slot, owner, device);

    const response = await SELF.fetch(`https://x.dev/api/pairing/${slot}`, { method: "DELETE" });

    expect(response.status).toBe(200);
    const row = await env.DB.prepare("SELECT pairing_id FROM pairing WHERE pairing_id = ?")
      .bind(slot)
      .first();
    expect(row).toBeNull();
  });

  it("is idempotent, since the client fires it best-effort", async () => {
    const response = await SELF.fetch(`https://x.dev/api/pairing/${uid("gone")}`, {
      method: "DELETE",
    });

    expect(response.status).toBe(200);
  });
});
