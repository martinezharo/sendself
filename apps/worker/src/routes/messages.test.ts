import { SELF, env } from "cloudflare:test";
import type { PendingMessagesResponse, SendMessageRequest } from "@sendself/shared";
import { describe, expect, it } from "vitest";
import { fileStorageKey } from "../db";
import type { SeededDevice } from "../test/helpers";
import { authHeader, errorCode, seedDevice, seedMessage, seedSpace, uid } from "../test/helpers";

function send(
  device: SeededDevice,
  overrides: Partial<SendMessageRequest> = {},
): Promise<Response> {
  const body: SendMessageRequest = {
    id: uid("msg"),
    keyEpoch: 1,
    encryptedPayload: "ciphertext",
    iv: "iv",
    ...overrides,
  };
  return SELF.fetch("https://x.dev/api/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeader(device) },
    body: JSON.stringify(body),
  });
}

async function pending(device: SeededDevice, since?: number): Promise<PendingMessagesResponse> {
  const query = since === undefined ? "" : `?since=${since}`;
  const response = await SELF.fetch(`https://x.dev/api/messages/pending${query}`, {
    headers: authHeader(device),
  });
  return (await response.json()) as PendingMessagesResponse;
}

function ack(device: SeededDevice, messageId: string): Promise<Response> {
  return SELF.fetch(`https://x.dev/api/messages/${messageId}/ack`, {
    method: "POST",
    headers: authHeader(device),
  });
}

describe("POST /api/messages", () => {
  it("stores the message and one pending delivery per other active device", async () => {
    const { groupId, owner } = await seedSpace();
    const a = await seedDevice(groupId);
    const b = await seedDevice(groupId);
    const id = uid("msg");

    const response = await send(owner, { id });

    expect(response.status).toBe(200);
    const rows = await env.DB.prepare(
      "SELECT device_id AS deviceId FROM delivery_status WHERE message_id = ?",
    )
      .bind(id)
      .all<{ deviceId: string }>();
    expect(rows.results.map((r) => r.deviceId).sort()).toEqual([a.id, b.id].sort());
  });

  it("never queues a delivery for the sender or for a revoked device", async () => {
    const { groupId, owner } = await seedSpace();
    const active = await seedDevice(groupId);
    const revoked = await seedDevice(groupId, { revoked: true });
    const id = uid("msg");

    await send(owner, { id });

    const rows = await env.DB.prepare(
      "SELECT device_id AS deviceId FROM delivery_status WHERE message_id = ?",
    )
      .bind(id)
      .all<{ deviceId: string }>();
    expect(rows.results.map((r) => r.deviceId)).toEqual([active.id]);
    expect(rows.results.map((r) => r.deviceId)).not.toContain(revoked.id);
    expect(rows.results.map((r) => r.deviceId)).not.toContain(owner.id);
  });

  it("stores nothing when the sender is the only device left", async () => {
    const { owner } = await seedSpace();
    const id = uid("msg");

    const response = await send(owner, { id });

    expect(response.status).toBe(200);
    const row = await env.DB.prepare("SELECT id FROM messages WHERE id = ?").bind(id).first();
    expect(row).toBeNull();
  });

  it("drops an uploaded file when there is nobody to deliver it to", async () => {
    const { groupId, owner } = await seedSpace();
    const key = uid("blob").replace(/[^A-Za-z0-9_-]/g, "");
    await env.FILES.put(fileStorageKey(groupId, key), "ciphertext");

    await send(owner, {
      fileR2Key: key,
      fileIv: "file-iv",
      fileMeta: "encrypted-meta",
      fileMetaIv: "meta-iv",
      encryptedPayload: undefined,
      iv: undefined,
    });

    expect(await env.FILES.head(fileStorageKey(groupId, key))).toBeNull();
  });

  it("refuses to register a file that was never uploaded", async () => {
    const { groupId, owner } = await seedSpace();
    await seedDevice(groupId);

    const response = await send(owner, {
      fileR2Key: uid("nothere").replace(/[^A-Za-z0-9_-]/g, ""),
      fileIv: "file-iv",
      encryptedPayload: undefined,
      iv: undefined,
    });

    expect(response.status).toBe(400);
  });

  it("rejects content encrypted under a superseded epoch", async () => {
    // Without this, everything sent between a revocation and the sender
    // noticing the rotation would still be readable by the revoked device.
    const { groupId, owner } = await seedSpace({ keyEpoch: 2 });
    await seedDevice(groupId, { keyEpoch: 2 });

    const response = await send(owner, { keyEpoch: 1 });

    expect(response.status).toBe(409);
    expect(await errorCode(response)).toBe("key_rotated");
  });

  it("tells a stale sender about the rotation even when nobody else is left", async () => {
    const { owner } = await seedSpace({ keyEpoch: 2 });

    expect((await send(owner, { keyEpoch: 1 })).status).toBe(409);
  });

  it("requires a signature from a device that has published a signing key", async () => {
    const { groupId } = await seedSpace();
    const signer = await seedDevice(groupId, { signingPublicKey: "spki" });
    await seedDevice(groupId);

    const response = await send(signer);

    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe("bad_request");
  });

  it("accepts a signed message from that same device", async () => {
    const { groupId } = await seedSpace();
    const signer = await seedDevice(groupId, { signingPublicKey: "spki" });
    await seedDevice(groupId);
    const id = uid("msg");

    const response = await send(signer, { id, signature: "sig" });

    expect(response.status).toBe(200);
    const row = await env.DB.prepare("SELECT signature FROM messages WHERE id = ?")
      .bind(id)
      .first<{ signature: string }>();
    expect(row?.signature).toBe("sig");
  });

  it("resolves a duplicate id as conflict rather than a 500", async () => {
    // The outbox reads `conflict` as "already sent"; a 500 would make it retry
    // forever and, worse, re-encrypt the payload under a newer key.
    const { groupId, owner } = await seedSpace();
    await seedDevice(groupId);
    const id = uid("msg");
    await send(owner, { id });

    const response = await send(owner, { id });

    expect(response.status).toBe(409);
    expect(await errorCode(response)).toBe("conflict");
  });

  it("reports the duplicate before the epoch check, so a resend is never re-encrypted", async () => {
    const { groupId, owner } = await seedSpace();
    await seedDevice(groupId);
    const id = uid("msg");
    await send(owner, { id });
    await env.DB.prepare("UPDATE groups SET key_epoch = 2 WHERE id = ?").bind(groupId).run();

    const response = await send(owner, { id });

    expect(await errorCode(response)).toBe("conflict");
  });

  it.each([
    ["neither text nor file", { encryptedPayload: undefined, iv: undefined }],
    ["text without an iv", { iv: undefined }],
    ["a file without an iv", { fileR2Key: "blob", fileIv: undefined }],
    ["an iv without text", { encryptedPayload: undefined, iv: "iv" }],
    ["metadata without its own iv", { fileMeta: "metadata" }],
    ["a metadata iv without the metadata it belongs to", { fileMetaIv: "meta-iv" }],
    [
      "a file without encrypted metadata",
      { fileR2Key: "blob", fileIv: "file-iv", fileMeta: undefined, fileMetaIv: undefined },
    ],
  ])("rejects a message with %s", async (_label, overrides) => {
    const { groupId, owner } = await seedSpace();
    await seedDevice(groupId);

    expect((await send(owner, overrides)).status).toBe(400);
  });

  it("rejects an unauthenticated send", async () => {
    const response = await SELF.fetch("https://x.dev/api/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "x", keyEpoch: 1, encryptedPayload: "c", iv: "i" }),
    });

    expect(response.status).toBe(401);
  });
});

describe("GET /api/messages/pending", () => {
  it("returns this device's pending messages with the sender's encrypted name", async () => {
    const { groupId, owner } = await seedSpace();
    const recipient = await seedDevice(groupId);
    const id = await seedMessage(groupId, owner.id, { recipients: [recipient.id] });

    const { messages } = await pending(recipient);

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      id,
      senderDeviceId: owner.id,
      senderNameEnc: `enc-name-${owner.id}`,
      senderNameIv: `iv-${owner.id}`,
      senderNameEpoch: 1,
      keyEpoch: 1,
    });
  });

  it("never returns a message queued for another device", async () => {
    const { groupId, owner } = await seedSpace();
    const mine = await seedDevice(groupId);
    const theirs = await seedDevice(groupId);
    await seedMessage(groupId, owner.id, { recipients: [theirs.id] });

    expect((await pending(mine)).messages).toEqual([]);
  });

  it("stops returning a message once it has been acked", async () => {
    const { groupId, owner } = await seedSpace();
    const recipient = await seedDevice(groupId);
    const id = await seedMessage(groupId, owner.id, { recipients: [recipient.id, owner.id] });

    await ack(recipient, id);

    expect((await pending(recipient)).messages).toEqual([]);
  });

  it("orders messages oldest first", async () => {
    const { groupId, owner } = await seedSpace();
    const recipient = await seedDevice(groupId);
    const second = await seedMessage(groupId, owner.id, {
      recipients: [recipient.id],
      createdAt: 2_000,
    });
    const first = await seedMessage(groupId, owner.id, {
      recipients: [recipient.id],
      createdAt: 1_000,
    });

    const { messages } = await pending(recipient);

    expect(messages.map((m) => m.id)).toEqual([first, second]);
  });

  it("reports the group's epoch and whether a rotation is still owed", async () => {
    const { groupId, owner } = await seedSpace({ keyEpoch: 4, rotationPending: true });
    await env.DB.prepare("UPDATE devices SET key_epoch = 4 WHERE id = ?").bind(owner.id).run();
    await seedDevice(groupId);

    const response = await pending(owner);

    expect(response.keyEpoch).toBe(4);
    expect(response.rotationPending).toBe(true);
    expect(response.keys).toEqual([]);
  });

  it("rejects a negative or non-numeric cursor", async () => {
    const { owner } = await seedSpace();

    const negative = await SELF.fetch("https://x.dev/api/messages/pending?since=-1", {
      headers: authHeader(owner),
    });
    const nonsense = await SELF.fetch("https://x.dev/api/messages/pending?since=soon", {
      headers: authHeader(owner),
    });

    expect(negative.status).toBe(400);
    expect(nonsense.status).toBe(400);
  });

  it("rejects an unauthenticated poll", async () => {
    expect((await SELF.fetch("https://x.dev/api/messages/pending")).status).toBe(401);
  });
});

describe("POST /api/messages/:id/ack", () => {
  it("marks the delivery done and reports the message as still alive", async () => {
    const { groupId, owner } = await seedSpace();
    const a = await seedDevice(groupId);
    const b = await seedDevice(groupId);
    const id = await seedMessage(groupId, owner.id, { recipients: [a.id, b.id] });

    const response = await ack(a, id);

    expect(await response.json()).toEqual({ ok: true, deleted: false });
    const row = await env.DB.prepare("SELECT id FROM messages WHERE id = ?").bind(id).first();
    expect(row).not.toBeNull();
  });

  it("deletes the message and its blob when the last recipient acks", async () => {
    const { groupId, owner } = await seedSpace();
    const recipient = await seedDevice(groupId);
    const key = "lastack";
    const id = await seedMessage(groupId, owner.id, {
      recipients: [recipient.id],
      fileR2Key: key,
    });
    await env.FILES.put(fileStorageKey(groupId, key), "ciphertext");

    const response = await ack(recipient, id);

    expect(await response.json()).toEqual({ ok: true, deleted: true });
    expect(await env.FILES.head(fileStorageKey(groupId, key))).toBeNull();
  });

  it("is idempotent for a device that already acked", async () => {
    const { groupId, owner } = await seedSpace();
    const a = await seedDevice(groupId);
    const b = await seedDevice(groupId);
    const id = await seedMessage(groupId, owner.id, { recipients: [a.id, b.id] });
    await ack(a, id);

    const response = await ack(a, id);

    expect(response.status).toBe(200);
    const row = await env.DB.prepare("SELECT id FROM messages WHERE id = ?").bind(id).first();
    expect(row).not.toBeNull();
  });

  it("refuses to ack a message belonging to another group", async () => {
    // The delivery UPDATE alone is group-safe, but the delete cascade that
    // follows is not: a guessed id from another space would see "0 pending"
    // and take the whole message down with it.
    const victim = await seedSpace();
    const victimRecipient = await seedDevice(victim.groupId);
    const id = await seedMessage(victim.groupId, victim.owner.id, {
      recipients: [victimRecipient.id],
    });
    const attacker = await seedSpace();

    const response = await ack(attacker.owner, id);

    expect(response.status).toBe(404);
    expect(await errorCode(response)).toBe("not_found");
    const row = await env.DB.prepare("SELECT id FROM messages WHERE id = ?").bind(id).first();
    expect(row).not.toBeNull();
  });

  it("404s on a message that does not exist", async () => {
    const { owner } = await seedSpace();

    expect((await ack(owner, "no-such-message")).status).toBe(404);
  });
});

describe("POST /api/messages (delete for everyone)", () => {
  it("destroys the target message and its file, and fans the tombstone out", async () => {
    const { groupId, owner } = await seedSpace();
    const peer = await seedDevice(groupId);
    const key = uid("blob");
    await env.FILES.put(fileStorageKey(groupId, key), "ciphertext");
    const target = await seedMessage(groupId, owner.id, {
      recipients: [peer.id],
      fileR2Key: key,
    });
    const tombstoneId = uid("msg");

    const response = await send(owner, {
      id: tombstoneId,
      encryptedPayload: undefined,
      iv: undefined,
      deletesMessageId: target,
    });

    expect(response.status).toBe(200);
    expect(await env.DB.prepare("SELECT id FROM messages WHERE id = ?").bind(target).first()).toBe(
      null,
    );
    expect(await env.FILES.head(fileStorageKey(groupId, key))).toBeNull();
    // The target's delivery bookkeeping goes with it, and the tombstone gets
    // its own so every other device is told.
    const rows = await env.DB.prepare(
      "SELECT message_id AS messageId, device_id AS deviceId FROM delivery_status WHERE message_id IN (?, ?)",
    )
      .bind(target, tombstoneId)
      .all<{ messageId: string; deviceId: string }>();
    expect(rows.results).toEqual([{ messageId: tombstoneId, deviceId: peer.id }]);
  });

  it("still delivers a deletion whose target is already gone", async () => {
    // The normal case: a message every device downloaded was purged from here
    // on the last ack, and the copies that remain live on those devices.
    const { groupId, owner } = await seedSpace();
    const peer = await seedDevice(groupId);
    const tombstoneId = uid("msg");

    const response = await send(owner, {
      id: tombstoneId,
      encryptedPayload: undefined,
      iv: undefined,
      deletesMessageId: uid("long-gone"),
    });

    expect(response.status).toBe(200);
    const delivered = await pending(peer);
    expect(delivered.messages.map((m) => m.id)).toContain(tombstoneId);
  });

  it("hands the recipient the id to delete", async () => {
    const { groupId, owner } = await seedSpace();
    const peer = await seedDevice(groupId);
    const target = uid("target");

    await send(owner, {
      encryptedPayload: undefined,
      iv: undefined,
      deletesMessageId: target,
      signature: "sig",
    });

    const delivered = await pending(peer);
    const tombstone = delivered.messages.find((m) => m.deletesMessageId !== null);
    expect(tombstone?.deletesMessageId).toBe(target);
    expect(tombstone?.encryptedPayload).toBeNull();
    expect(tombstone?.signature).toBe("sig");
  });

  it("never deletes a message belonging to another space", async () => {
    const { groupId: otherGroupId, owner: stranger } = await seedSpace();
    const victim = await seedMessage(otherGroupId, stranger.id, {
      recipients: [stranger.id],
    });
    const { groupId, owner } = await seedSpace();
    await seedDevice(groupId);

    const response = await send(owner, {
      encryptedPayload: undefined,
      iv: undefined,
      deletesMessageId: victim,
    });

    // Accepted (the id simply doesn't resolve for this caller) but the other
    // space's message is untouched.
    expect(response.status).toBe(200);
    expect(
      await env.DB.prepare("SELECT id FROM messages WHERE id = ?").bind(victim).first(),
    ).not.toBe(null);
  });

  it("rejects a deletion that also carries content", async () => {
    const { groupId, owner } = await seedSpace();
    await seedDevice(groupId);

    const response = await send(owner, { deletesMessageId: uid("target") });

    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe("bad_request");
  });

  it("rejects a deletion that targets itself", async () => {
    const { groupId, owner } = await seedSpace();
    await seedDevice(groupId);
    const id = uid("msg");

    const response = await send(owner, {
      id,
      encryptedPayload: undefined,
      iv: undefined,
      deletesMessageId: id,
    });

    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe("bad_request");
  });

  it("still destroys the target when no device is left to notify", async () => {
    const { groupId, owner } = await seedSpace();
    const target = await seedMessage(groupId, owner.id);

    const response = await send(owner, {
      encryptedPayload: undefined,
      iv: undefined,
      deletesMessageId: target,
    });

    expect(response.status).toBe(200);
    expect(await env.DB.prepare("SELECT id FROM messages WHERE id = ?").bind(target).first()).toBe(
      null,
    );
  });
});

/**
 * `fileMeta` carries the message's whole metadata envelope (`MessageMeta`) and
 * not just an attachment's name and size, so a message with no file at all can
 * have one. That is how the view-once flag and the album grouping reach the
 * other devices: inside the ciphertext, where the server can neither read them
 * nor strip them without breaking the signature.
 */
describe("POST /api/messages (metadata envelope)", () => {
  it("accepts and stores an envelope on a message that has no file", async () => {
    const { groupId, owner } = await seedSpace();
    const recipient = await seedDevice(groupId);
    const id = uid("msg");

    const response = await send(owner, { id, fileMeta: "meta-ct", fileMetaIv: "meta-iv" });

    expect(response.status).toBe(200);
    const stored = await env.DB.prepare(
      "SELECT file_meta AS meta, file_r2_key AS r2 FROM messages WHERE id = ?",
    )
      .bind(id)
      .first<{ meta: string | null; r2: string | null }>();
    expect(stored).toMatchObject({ meta: "meta-ct", r2: null });

    // And it reaches the recipient, which is the whole point of putting it here.
    const { messages } = await pending(recipient);
    expect(messages.find((m) => m.id === id)).toMatchObject({
      fileMeta: "meta-ct",
      fileMetaIv: "meta-iv",
      fileR2Key: null,
    });
  });

  it("refuses a tombstone that smuggles an envelope alongside the deletion", async () => {
    const { groupId, owner } = await seedSpace();
    await seedDevice(groupId);

    const response = await send(owner, {
      encryptedPayload: undefined,
      iv: undefined,
      deletesMessageId: uid("target"),
      fileMeta: "meta-ct",
      fileMetaIv: "meta-iv",
    });

    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe("bad_request");
  });
});
