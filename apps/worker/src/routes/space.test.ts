import { SELF, env } from "cloudflare:test";
import type { PendingMessagesResponse, UpdateSpaceNameRequest } from "@sendself/shared";
import { describe, expect, it } from "vitest";
import type { SeededDevice } from "../test/helpers";
import { authHeader, errorCode, seedDevice, seedSpace } from "../test/helpers";

function setName(device: SeededDevice, body: Partial<UpdateSpaceNameRequest>): Promise<Response> {
  return SELF.fetch("https://x.dev/api/groups/self/name", {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...authHeader(device) },
    body: JSON.stringify(body),
  });
}

async function storedName(groupId: string): Promise<Record<string, unknown>> {
  const row = await env.DB.prepare(
    `SELECT name_enc AS encryptedName, name_iv AS nameIv, name_key_epoch AS nameKeyEpoch
       FROM groups WHERE id = ?`,
  )
    .bind(groupId)
    .first<Record<string, unknown>>();
  return row!;
}

async function pendingSpaceName(
  device: SeededDevice,
): Promise<PendingMessagesResponse["spaceName"]> {
  const response = await SELF.fetch("https://x.dev/api/messages/pending", {
    headers: authHeader(device),
  });
  return ((await response.json()) as PendingMessagesResponse).spaceName;
}

describe("PUT /api/groups/self/name", () => {
  it("stores the ciphertext and answers with the time it recorded", async () => {
    const { groupId, owner } = await seedSpace();

    const response = await setName(owner, {
      encryptedName: "enc",
      nameIv: "iv",
      nameKeyEpoch: 1,
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: true; updatedAt: number };
    expect(body.ok).toBe(true);
    expect(body.updatedAt).toBeGreaterThan(0);
    expect(await storedName(groupId)).toEqual({
      encryptedName: "enc",
      nameIv: "iv",
      nameKeyEpoch: 1,
    });
  });

  it("lets any device rename, not only administrators", async () => {
    const { groupId } = await seedSpace();
    const member = await seedDevice(groupId, { role: "member" });

    const response = await setName(member, { encryptedName: "enc", nameIv: "iv", nameKeyEpoch: 1 });

    expect(response.status).toBe(200);
  });

  it("records a cleared name as a name, so every device drops the old one", async () => {
    const { groupId, owner } = await seedSpace();
    await setName(owner, { encryptedName: "enc", nameIv: "iv", nameKeyEpoch: 1 });

    const response = await setName(owner, {
      encryptedName: null,
      nameIv: null,
      nameKeyEpoch: 1,
    });

    expect(response.status).toBe(200);
    expect(await storedName(groupId)).toEqual({
      encryptedName: null,
      nameIv: null,
      nameKeyEpoch: 1,
    });
    expect(await pendingSpaceName(owner)).toMatchObject({ encryptedName: null, nameIv: null });
  });

  it("refuses a ciphertext without its IV, which nobody could ever decrypt", async () => {
    const { owner } = await seedSpace();

    const response = await setName(owner, { encryptedName: "enc", nameKeyEpoch: 1 });

    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe("bad_request");
  });

  it("refuses a name encrypted under a superseded key", async () => {
    const { owner } = await seedSpace({ keyEpoch: 3 });

    const response = await setName(owner, { encryptedName: "enc", nameIv: "iv", nameKeyEpoch: 2 });

    expect(await errorCode(response)).toBe("key_rotated");
  });

  it("rejects an unauthenticated caller", async () => {
    const response = await SELF.fetch("https://x.dev/api/groups/self/name", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ encryptedName: "enc", nameIv: "iv", nameKeyEpoch: 1 }),
    });

    expect(response.status).toBe(401);
  });
});

describe("the space name on the poll", () => {
  it("is null while nobody has ever named the space", async () => {
    const { owner } = await seedSpace();

    expect(await pendingSpaceName(owner)).toBeNull();
  });

  it("reaches a device that was never told about the rename", async () => {
    const { groupId, owner } = await seedSpace();
    const other = await seedDevice(groupId);

    await setName(owner, { encryptedName: "enc", nameIv: "iv", nameKeyEpoch: 1 });

    expect(await pendingSpaceName(other)).toMatchObject({
      encryptedName: "enc",
      nameIv: "iv",
      nameKeyEpoch: 1,
    });
  });

  it("carries the last write, and a later stamp than the one before it", async () => {
    const { groupId, owner } = await seedSpace();
    const other = await seedDevice(groupId);
    await setName(owner, { encryptedName: "first", nameIv: "iv-1", nameKeyEpoch: 1 });
    const first = await pendingSpaceName(other);

    await setName(other, { encryptedName: "second", nameIv: "iv-2", nameKeyEpoch: 1 });
    const second = await pendingSpaceName(owner);

    expect(second?.encryptedName).toBe("second");
    expect(second!.updatedAt).toBeGreaterThanOrEqual(first!.updatedAt);
  });

  it("never leaks another space's name", async () => {
    const { owner } = await seedSpace();
    const elsewhere = await seedSpace();
    await setName(elsewhere.owner, { encryptedName: "theirs", nameIv: "iv", nameKeyEpoch: 1 });

    expect(await pendingSpaceName(owner)).toBeNull();
  });
});
