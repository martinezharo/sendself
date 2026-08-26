import { SELF, env } from "cloudflare:test";
import type { KeyWrap, PendingMessagesResponse, RotateKeyRequest } from "@sendself/shared";
import { describe, expect, it } from "vitest";
import type { SeededDevice } from "../test/helpers";
import { authHeader, errorCode, seedDevice, seedSpace } from "../test/helpers";

function wrapFor(device: SeededDevice): KeyWrap {
  return {
    deviceId: device.id,
    wrappedKey: `wrapped-for-${device.id}`,
    ephemeralPublicKey: `ephemeral-for-${device.id}`,
  };
}

function rotate(device: SeededDevice, body: RotateKeyRequest): Promise<Response> {
  return SELF.fetch("https://x.dev/api/keys/rotate", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeader(device) },
    body: JSON.stringify(body),
  });
}

function ackKey(device: SeededDevice, epoch: number | string): Promise<Response> {
  return SELF.fetch(`https://x.dev/api/keys/${epoch}/ack`, {
    method: "POST",
    headers: authHeader(device),
  });
}

async function groupEpoch(groupId: string): Promise<{ epoch: number; pending: number }> {
  const row = await env.DB.prepare(
    "SELECT key_epoch AS epoch, rotation_pending AS pending FROM groups WHERE id = ?",
  )
    .bind(groupId)
    .first<{ epoch: number; pending: number }>();
  return row!;
}

async function deviceEpoch(deviceId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT key_epoch AS epoch FROM devices WHERE id = ?")
    .bind(deviceId)
    .first<{ epoch: number }>();
  return row!.epoch;
}

describe("POST /api/keys/rotate", () => {
  it("bumps the epoch, clears the flag and deposits one blob per remaining device", async () => {
    const { groupId, owner } = await seedSpace({ rotationPending: true });
    const other = await seedDevice(groupId);

    const response = await rotate(owner, { epoch: 2, wraps: [wrapFor(other)] });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, epoch: 2, devices: 1 });
    expect(await groupEpoch(groupId)).toEqual({ epoch: 2, pending: 0 });
    const blobs = await env.DB.prepare(
      "SELECT device_id AS deviceId, epoch FROM key_distribution WHERE group_id = ?",
    )
      .bind(groupId)
      .all<{ deviceId: string; epoch: number }>();
    expect(blobs.results).toEqual([{ deviceId: other.id, epoch: 2 }]);
  });

  it("adopts the new epoch on the rotating device, which minted the key", async () => {
    const { groupId, owner } = await seedSpace({ rotationPending: true });
    const other = await seedDevice(groupId);

    await rotate(owner, { epoch: 2, wraps: [wrapFor(other)] });

    expect(await deviceEpoch(owner.id)).toBe(2);
    expect(await deviceEpoch(other.id)).toBe(1);
  });

  it("leaves no token touched, so nobody is signed out by a rotation", async () => {
    const { groupId, owner } = await seedSpace({ rotationPending: true });
    const other = await seedDevice(groupId);

    await rotate(owner, { epoch: 2, wraps: [wrapFor(other)] });

    const response = await SELF.fetch("https://x.dev/api/devices", { headers: authHeader(other) });
    expect(response.status).toBe(200);
  });

  it("rotates for a lone device with no wraps at all", async () => {
    const { groupId, owner } = await seedSpace({ rotationPending: true });

    const response = await rotate(owner, { epoch: 2, wraps: [] });

    expect(response.status).toBe(200);
    expect(await groupEpoch(groupId)).toEqual({ epoch: 2, pending: 0 });
  });

  it("refuses to rotate when no rotation is owed", async () => {
    const { groupId, owner } = await seedSpace();
    const other = await seedDevice(groupId);

    const response = await rotate(owner, { epoch: 2, wraps: [wrapFor(other)] });

    expect(response.status).toBe(409);
    expect(await errorCode(response)).toBe("conflict");
  });

  it("refuses a device that has not adopted the current key yet", async () => {
    // It would rotate away from an epoch it never held, skipping its own
    // pending deliveries.
    const { groupId } = await seedSpace({ keyEpoch: 3, rotationPending: true });
    const behind = await seedDevice(groupId, { role: "owner", keyEpoch: 2 });
    const other = await seedDevice(groupId, { keyEpoch: 3 });

    const response = await rotate(behind, { epoch: 4, wraps: [wrapFor(other)] });

    expect(response.status).toBe(409);
    expect(await errorCode(response)).toBe("conflict");
  });

  it.each([
    ["skips ahead", 3],
    ["repeats the current epoch", 1],
    ["goes backwards", 0],
  ])("rejects an epoch that %s", async (_label, epoch) => {
    const { groupId, owner } = await seedSpace({ rotationPending: true });
    const other = await seedDevice(groupId);

    const response = await rotate(owner, { epoch, wraps: [wrapFor(other)] });

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(await groupEpoch(groupId)).toMatchObject({ epoch: 1 });
  });

  it("rejects a rotation that leaves a remaining device behind", async () => {
    // Stranding one device is how a caller could quietly cut it out of the
    // space without having the right to revoke it.
    const { groupId, owner } = await seedSpace({ rotationPending: true });
    const included = await seedDevice(groupId);
    await seedDevice(groupId);

    const response = await rotate(owner, { epoch: 2, wraps: [wrapFor(included)] });

    expect(response.status).toBe(409);
    expect(await groupEpoch(groupId)).toMatchObject({ epoch: 1 });
  });

  it("rejects a wrap for a device that is not in the space", async () => {
    const { groupId, owner } = await seedSpace({ rotationPending: true });
    const member = await seedDevice(groupId);
    const outsider = await seedSpace();

    const response = await rotate(owner, {
      epoch: 2,
      wraps: [wrapFor(member), wrapFor(outsider.owner)],
    });

    expect(response.status).toBe(409);
  });

  it("rejects a wrap for a device that was just revoked", async () => {
    const { groupId, owner } = await seedSpace({ rotationPending: true });
    const revoked = await seedDevice(groupId, { revoked: true });

    const response = await rotate(owner, { epoch: 2, wraps: [wrapFor(revoked)] });

    expect(response.status).toBe(409);
  });

  it("rejects duplicate devices in the wrap list", async () => {
    const { groupId, owner } = await seedSpace({ rotationPending: true });
    const other = await seedDevice(groupId);

    const response = await rotate(owner, { epoch: 2, wraps: [wrapFor(other), wrapFor(other)] });

    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe("bad_request");
  });

  it("rejects a missing or malformed wrap list", async () => {
    const { groupId, owner } = await seedSpace({ rotationPending: true });
    await seedDevice(groupId);

    const missing = await rotate(owner, { epoch: 2 } as RotateKeyRequest);
    const malformed = await rotate(owner, {
      epoch: 2,
      wraps: [{ deviceId: "d" }] as unknown as KeyWrap[],
    });

    expect(missing.status).toBe(400);
    expect(malformed.status).toBe(400);
  });

  it("lets exactly one of two concurrent rotations win, with no split brain", async () => {
    const { groupId, owner } = await seedSpace({ rotationPending: true });
    const second = await seedDevice(groupId);
    const third = await seedDevice(groupId);

    const [a, b] = await Promise.all([
      rotate(owner, { epoch: 2, wraps: [wrapFor(second), wrapFor(third)] }),
      rotate(second, { epoch: 2, wraps: [wrapFor(owner), wrapFor(third)] }),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);
    expect(await groupEpoch(groupId)).toEqual({ epoch: 2, pending: 0 });
    // The loser's batch must be a complete no-op: no blob from it survives, or
    // a device could adopt epoch 2 from a key nobody else has.
    const blobs = await env.DB.prepare(
      "SELECT device_id AS deviceId FROM key_distribution WHERE group_id = ? AND epoch = 2",
    )
      .bind(groupId)
      .all<{ deviceId: string }>();
    expect(blobs.results).toHaveLength(2);
  });

  it("rejects an unauthenticated rotation", async () => {
    const response = await SELF.fetch("https://x.dev/api/keys/rotate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ epoch: 2, wraps: [] }),
    });

    expect(response.status).toBe(401);
  });
});

describe("pending key delivery", () => {
  it("hands a device its wrapped key on the next poll", async () => {
    const { groupId, owner } = await seedSpace({ rotationPending: true });
    const other = await seedDevice(groupId);
    await rotate(owner, { epoch: 2, wraps: [wrapFor(other)] });

    const response = await SELF.fetch("https://x.dev/api/messages/pending", {
      headers: authHeader(other),
    });
    const body = (await response.json()) as PendingMessagesResponse;

    expect(body.keys).toEqual([
      {
        epoch: 2,
        wrappedKey: `wrapped-for-${other.id}`,
        ephemeralPublicKey: `ephemeral-for-${other.id}`,
      },
    ]);
    expect(body.keyEpoch).toBe(2);
  });

  it("never hands one device the blob wrapped for another", async () => {
    const { groupId, owner } = await seedSpace({ rotationPending: true });
    const a = await seedDevice(groupId);
    const b = await seedDevice(groupId);
    await rotate(owner, { epoch: 2, wraps: [wrapFor(a), wrapFor(b)] });

    const response = await SELF.fetch("https://x.dev/api/messages/pending", {
      headers: authHeader(a),
    });
    const body = (await response.json()) as PendingMessagesResponse;

    expect(body.keys.map((k) => k.wrappedKey)).toEqual([`wrapped-for-${a.id}`]);
  });
});

describe("POST /api/keys/:epoch/ack", () => {
  it("adopts the epoch and drops the blob the server was holding", async () => {
    const { groupId, owner } = await seedSpace({ rotationPending: true });
    const other = await seedDevice(groupId);
    await rotate(owner, { epoch: 2, wraps: [wrapFor(other)] });

    const response = await ackKey(other, 2);

    expect(response.status).toBe(200);
    expect(await deviceEpoch(other.id)).toBe(2);
    const row = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM key_distribution WHERE device_id = ?",
    )
      .bind(other.id)
      .first<{ n: number }>();
    expect(row?.n).toBe(0);
  });

  it("never moves a device's epoch backwards", async () => {
    const { groupId, owner } = await seedSpace({ keyEpoch: 3 });
    const ahead = await seedDevice(groupId, { keyEpoch: 3 });
    void owner;

    await ackKey(ahead, 2);

    expect(await deviceEpoch(ahead.id)).toBe(3);
  });

  it("rejects an epoch the group has never reached", async () => {
    const { owner } = await seedSpace();

    const response = await ackKey(owner, 9);

    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe("bad_request");
  });

  it.each([
    ["zero", "0"],
    ["negative", "-1"],
    ["non-numeric", "latest"],
  ])("rejects a %s epoch in the path", async (_label, epoch) => {
    const { owner } = await seedSpace();

    expect((await ackKey(owner, epoch)).status).toBe(400);
  });

  it("rejects an unauthenticated ack", async () => {
    expect((await SELF.fetch("https://x.dev/api/keys/1/ack", { method: "POST" })).status).toBe(401);
  });
});
