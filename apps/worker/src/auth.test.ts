import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { authenticate, requireAdmin, requireOwner, sha256Hex } from "./auth";
import type { AuthContext } from "./auth";
import { ApiError } from "./errors";
import { seedDevice, seedGroup, seedSpace } from "./test/helpers";

function request(token?: string): Request {
  return new Request("https://x.dev/api/messages/pending", {
    headers: token === undefined ? {} : { Authorization: token },
  });
}

describe("sha256Hex", () => {
  it("matches the well-known digest of the empty string", async () => {
    // The client computes the token hash independently (apps/web crypto.ts).
    // If these two ever diverge, every device is locked out at once.
    expect(await sha256Hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("produces 64 lowercase hex chars", async () => {
    expect(await sha256Hex("some-token")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("authenticate", () => {
  it("resolves the group, device, role and epochs from the token alone", async () => {
    const groupId = await seedGroup({ keyEpoch: 4, rotationPending: true });
    const device = await seedDevice(groupId, { role: "admin", keyEpoch: 3 });

    const auth = await authenticate(request(`Bearer ${device.token}`), env);

    expect(auth).toEqual({
      groupId,
      deviceId: device.id,
      role: "admin",
      keyEpoch: 3,
      groupKeyEpoch: 4,
      rotationPending: true,
      hasSigningKey: false,
      vaultSeq: 0,
    } satisfies AuthContext);
  });

  it("reports a published signing key, which makes signatures mandatory", async () => {
    const { groupId } = await seedSpace();
    const device = await seedDevice(groupId, { signingPublicKey: "spki-abc" });

    const auth = await authenticate(request(`Bearer ${device.token}`), env);

    expect(auth.hasSigningKey).toBe(true);
  });

  it("tolerates whitespace around the token", async () => {
    const { owner } = await seedSpace();

    const auth = await authenticate(request(`Bearer   ${owner.token}  `), env);

    expect(auth.deviceId).toBe(owner.id);
  });

  it.each([
    ["a missing header", undefined],
    ["a header without the Bearer scheme", "token-only"],
    ["a different scheme", "Basic abc"],
    ["an empty bearer value", "Bearer "],
  ])("rejects %s as unauthorized", async (_label, header) => {
    await expect(authenticate(request(header), env)).rejects.toMatchObject({
      code: "unauthorized",
    });
  });

  it("rejects a token no device owns", async () => {
    await seedSpace();

    await expect(authenticate(request("Bearer nobody-token"), env)).rejects.toMatchObject({
      code: "unauthorized",
    });
  });

  it("rejects a revoked device with device_revoked, not unauthorized", async () => {
    // The distinction is what tells the client to stop retrying and ask the
    // user to link the device again, instead of looping on a dead session.
    const { groupId } = await seedSpace();
    const revoked = await seedDevice(groupId, { revoked: true });

    const error = await authenticate(request(`Bearer ${revoked.token}`), env).catch((e) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect(error.code).toBe("device_revoked");
    expect(error.status).toBe(403);
  });

  it("never authenticates one device's token into another device's identity", async () => {
    const { groupId } = await seedSpace();
    const a = await seedDevice(groupId);
    const b = await seedDevice(groupId);

    expect((await authenticate(request(`Bearer ${a.token}`), env)).deviceId).toBe(a.id);
    expect((await authenticate(request(`Bearer ${b.token}`), env)).deviceId).toBe(b.id);
  });

  it("stores only the hash: the raw token is never written to the database", async () => {
    const { groupId } = await seedSpace();
    const device = await seedDevice(groupId);

    const row = await env.DB.prepare("SELECT auth_token_hash AS hash FROM devices WHERE id = ?")
      .bind(device.id)
      .first<{ hash: string }>();

    expect(row?.hash).toBe(await sha256Hex(device.token));
    expect(row?.hash).not.toBe(device.token);
  });
});

describe("role guards", () => {
  const context = (role: AuthContext["role"]): AuthContext => ({
    groupId: "g",
    deviceId: "d",
    role,
    keyEpoch: 1,
    groupKeyEpoch: 1,
    rotationPending: false,
    hasSigningKey: false,
    vaultSeq: 0,
  });

  it("lets owners and admins through requireAdmin", () => {
    expect(() => requireAdmin(context("owner"))).not.toThrow();
    expect(() => requireAdmin(context("admin"))).not.toThrow();
  });

  it("refuses a member with forbidden", () => {
    expect(() => requireAdmin(context("member"))).toThrow(ApiError);
    expect(() => requireAdmin(context("member"))).toThrow(/administrators/);
  });

  it("lets only the owner through requireOwner", () => {
    expect(() => requireOwner(context("owner"))).not.toThrow();
    expect(() => requireOwner(context("admin"))).toThrow(/owner/);
    expect(() => requireOwner(context("member"))).toThrow(/owner/);
  });
});
