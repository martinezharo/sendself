import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  activeDevices,
  deleteMessageById,
  fileStorageKey,
  messageRecipients,
  purgeDeliveredMessages,
  purgeExpiredMessages,
} from "./db";
import { seedDevice, seedMessage, seedSpace } from "./test/helpers";

async function messageExists(id: string): Promise<boolean> {
  const row = await env.DB.prepare("SELECT id FROM messages WHERE id = ?").bind(id).first();
  return row !== null;
}

async function deliveryRowCount(id: string): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM delivery_status WHERE message_id = ?")
    .bind(id)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

describe("fileStorageKey", () => {
  it("namespaces the object by group", () => {
    expect(fileStorageKey("group-a", "key-1")).toBe("group-a/key-1");
  });

  it("gives two groups disjoint keys for the same client-chosen key", () => {
    // The client only ever knows the bare key, so this is what stops a device
    // in group A from reaching group B's blob by guessing it.
    expect(fileStorageKey("a", "shared")).not.toBe(fileStorageKey("b", "shared"));
  });
});

describe("activeDevices", () => {
  it("returns the material a rotation needs, and nothing from other groups", async () => {
    const { groupId, owner } = await seedSpace();
    const member = await seedDevice(groupId, { keyEpoch: 2 });
    await seedDevice(groupId, { revoked: true });
    const other = await seedSpace();
    await seedDevice(other.groupId);

    const devices = await activeDevices(env, groupId);

    expect(devices.map((d) => d.id).sort()).toEqual([member.id, owner.id].sort());
    expect(devices.find((d) => d.id === member.id)).toEqual({
      id: member.id,
      publicKey: member.publicKey,
      keyEpoch: 2,
    });
  });

  it("excludes revoked devices, so a rotation never wraps the key for one", async () => {
    const { groupId, owner } = await seedSpace();
    const revoked = await seedDevice(groupId, { revoked: true });

    const ids = (await activeDevices(env, groupId)).map((d) => d.id);
    expect(ids).toEqual([owner.id]);
    expect(ids).not.toContain(revoked.id);
  });

  it("includes send-only devices, which a rotated key still has to reach", async () => {
    const { groupId, owner } = await seedSpace();
    const cli = await seedDevice(groupId, { sendOnly: true });

    const ids = (await activeDevices(env, groupId)).map((d) => d.id);
    expect(ids.sort()).toEqual([owner.id, cli.id].sort());
  });
});

describe("messageRecipients", () => {
  it("is every active device but the sender, the revoked and the send-only", async () => {
    const { groupId, owner } = await seedSpace();
    const member = await seedDevice(groupId);
    await seedDevice(groupId, { revoked: true });
    const cli = await seedDevice(groupId, { sendOnly: true });
    const other = await seedSpace();
    await seedDevice(other.groupId);

    expect(await messageRecipients(env, groupId, owner.id)).toEqual([member.id]);
    expect((await messageRecipients(env, groupId, cli.id)).sort()).toEqual(
      [owner.id, member.id].sort(),
    );
  });
});

describe("purgeDeliveredMessages", () => {
  it("processes more than one cleanup batch", async () => {
    const { groupId, owner } = await seedSpace();
    await Promise.all(Array.from({ length: 101 }, () => seedMessage(groupId, owner.id)));

    await purgeDeliveredMessages(env, groupId);

    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE group_id = ?")
      .bind(groupId)
      .first<{ n: number }>();
    expect(row?.n).toBe(0);
  });

  it("deletes a message once no delivery is pending, and its R2 object with it", async () => {
    const { groupId, owner } = await seedSpace();
    const member = await seedDevice(groupId);
    const id = await seedMessage(groupId, owner.id, {
      recipients: [member.id],
      fileR2Key: "blob-1",
    });
    await env.FILES.put(fileStorageKey(groupId, "blob-1"), "ciphertext");
    await env.DB.prepare("UPDATE delivery_status SET downloaded_at = ? WHERE message_id = ?")
      .bind(Date.now(), id)
      .run();

    await purgeDeliveredMessages(env, groupId);

    expect(await messageExists(id)).toBe(false);
    expect(await deliveryRowCount(id)).toBe(0);
    expect(await env.FILES.head(fileStorageKey(groupId, "blob-1"))).toBeNull();
  });

  it("keeps a message while any device has not downloaded it", async () => {
    const { groupId, owner } = await seedSpace();
    const a = await seedDevice(groupId);
    const b = await seedDevice(groupId);
    const id = await seedMessage(groupId, owner.id, { recipients: [a.id, b.id] });
    await env.DB.prepare(
      "UPDATE delivery_status SET downloaded_at = ? WHERE message_id = ? AND device_id = ?",
    )
      .bind(Date.now(), id, a.id)
      .run();

    await purgeDeliveredMessages(env, groupId);

    expect(await messageExists(id)).toBe(true);
  });

  it("never touches another group's messages", async () => {
    const { groupId, owner } = await seedSpace();
    const other = await seedSpace();
    const foreign = await seedMessage(other.groupId, other.owner.id);

    await purgeDeliveredMessages(env, groupId);

    expect(await messageExists(foreign)).toBe(true);
  });
});

describe("deleteMessageById", () => {
  it("removes the message, its delivery rows and its blob", async () => {
    const { groupId, owner } = await seedSpace();
    const member = await seedDevice(groupId);
    const id = await seedMessage(groupId, owner.id, {
      recipients: [member.id],
      fileR2Key: "blob-2",
    });
    await env.FILES.put(fileStorageKey(groupId, "blob-2"), "ciphertext");

    expect(await deleteMessageById(env, id)).toBe(true);

    expect(await messageExists(id)).toBe(false);
    expect(await deliveryRowCount(id)).toBe(0);
    expect(await env.FILES.head(fileStorageKey(groupId, "blob-2"))).toBeNull();
  });

  it("reports false for a message that does not exist", async () => {
    expect(await deleteMessageById(env, "no-such-message")).toBe(false);
  });
});

describe("purgeExpiredMessages", () => {
  it("deletes only messages older than the cutoff", async () => {
    const { groupId, owner } = await seedSpace();
    const old = await seedMessage(groupId, owner.id, { createdAt: 1_000 });
    const fresh = await seedMessage(groupId, owner.id, { createdAt: 9_000 });

    await purgeExpiredMessages(env, 5_000);

    expect(await messageExists(old)).toBe(false);
    expect(await messageExists(fresh)).toBe(true);
  });

  it("spans every group, since it runs from cron with no group context", async () => {
    const a = await seedSpace();
    const b = await seedSpace();
    const oldA = await seedMessage(a.groupId, a.owner.id, { createdAt: 1_000 });
    const oldB = await seedMessage(b.groupId, b.owner.id, { createdAt: 1_000 });

    await purgeExpiredMessages(env, 5_000);

    expect(await messageExists(oldA)).toBe(false);
    expect(await messageExists(oldB)).toBe(false);
  });
});
