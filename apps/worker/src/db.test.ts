import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  activeDevices,
  deleteMessageById,
  deleteUpload,
  fileStorageKey,
  messageRecipients,
  purgeDeliveredMessages,
  purgeExpiredMessages,
  purgeOrphanUploads,
  reserveUpload,
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

async function uploadRow(groupId: string, key: string): Promise<{ size: number } | null> {
  return env.DB.prepare("SELECT size FROM uploads WHERE group_id = ? AND r2_key = ?")
    .bind(groupId, key)
    .first<{ size: number }>();
}

async function seedUpload(groupId: string, key: string, createdAt: number): Promise<void> {
  await reserveUpload(env, groupId, key, 10, Number.MAX_SAFE_INTEGER, createdAt);
  await env.FILES.put(fileStorageKey(groupId, key), "ciphertext");
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

describe("reserveUpload", () => {
  it("records uploads while the space stays within its quota", async () => {
    const { groupId } = await seedSpace();

    expect(await reserveUpload(env, groupId, "a", 60, 100, Date.now())).toBe(true);
    expect(await reserveUpload(env, groupId, "b", 40, 100, Date.now())).toBe(true);

    expect(await uploadRow(groupId, "b")).toEqual({ size: 40 });
  });

  it("refuses the upload that would cross the quota, and records nothing for it", async () => {
    const { groupId } = await seedSpace();
    await reserveUpload(env, groupId, "a", 60, 100, Date.now());

    expect(await reserveUpload(env, groupId, "b", 41, 100, Date.now())).toBe(false);
    expect(await uploadRow(groupId, "b")).toBeNull();
  });

  it("counts a re-upload of the same key once, at its new size", async () => {
    const { groupId } = await seedSpace();
    await reserveUpload(env, groupId, "a", 90, 100, Date.now());

    expect(await reserveUpload(env, groupId, "a", 95, 100, Date.now())).toBe(true);
    expect(await uploadRow(groupId, "a")).toEqual({ size: 95 });
  });

  it("never shrinks a key's reservation, since an overlapping larger write may win", async () => {
    const { groupId } = await seedSpace();
    await reserveUpload(env, groupId, "a", 50, 100, Date.now());

    expect(await reserveUpload(env, groupId, "a", 1, 100, Date.now())).toBe(true);
    expect(await uploadRow(groupId, "a")).toEqual({ size: 50 });
    // The space is still charged for the larger write.
    expect(await reserveUpload(env, groupId, "b", 51, 100, Date.now())).toBe(false);
  });

  it("charges each space only for its own uploads", async () => {
    const a = await seedSpace();
    const b = await seedSpace();
    await reserveUpload(env, a.groupId, "x", 100, 100, Date.now());

    expect(await reserveUpload(env, b.groupId, "x", 100, 100, Date.now())).toBe(true);
  });
});

describe("upload accounting", () => {
  it("releases the quota when the blob is deleted on its own", async () => {
    const { groupId } = await seedSpace();
    await seedUpload(groupId, "blob", Date.now());

    await deleteUpload(env, groupId, "blob");

    expect(await uploadRow(groupId, "blob")).toBeNull();
    expect(await env.FILES.head(fileStorageKey(groupId, "blob"))).toBeNull();
  });

  it("releases the quota when the message carrying the blob is deleted", async () => {
    const { groupId, owner } = await seedSpace();
    await seedUpload(groupId, "attached", Date.now());
    const id = await seedMessage(groupId, owner.id, { fileR2Key: "attached" });

    await deleteMessageById(env, id);

    expect(await uploadRow(groupId, "attached")).toBeNull();
  });
});

describe("purgeOrphanUploads", () => {
  it("deletes old uploads no message references, keeping claimed and recent ones", async () => {
    const now = Date.now();
    const { groupId, owner } = await seedSpace();
    await seedUpload(groupId, "abandoned", now - 2_000);
    await seedUpload(groupId, "claimed", now - 2_000);
    await seedMessage(groupId, owner.id, { fileR2Key: "claimed" });
    await seedUpload(groupId, "in-flight", now);

    await purgeOrphanUploads(env, now - 1_000);

    expect(await uploadRow(groupId, "abandoned")).toBeNull();
    expect(await env.FILES.head(fileStorageKey(groupId, "abandoned"))).toBeNull();
    expect(await uploadRow(groupId, "claimed")).not.toBeNull();
    expect(await env.FILES.head(fileStorageKey(groupId, "claimed"))).not.toBeNull();
    expect(await uploadRow(groupId, "in-flight")).not.toBeNull();
  });

  it("does not let another space's message claim a blob", async () => {
    const now = Date.now();
    const a = await seedSpace();
    const b = await seedSpace();
    await seedUpload(a.groupId, "same-key", now - 2_000);
    await seedMessage(b.groupId, b.owner.id, { fileR2Key: "same-key" });

    await purgeOrphanUploads(env, now - 1_000);

    expect(await uploadRow(a.groupId, "same-key")).toBeNull();
  });
});
