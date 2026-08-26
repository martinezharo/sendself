import { env } from "cloudflare:test";
import { MESSAGE_TTL_MS, PAIRING_TTL_MS } from "@sendself/shared";
import { describe, expect, it } from "vitest";
import { runCleanup } from "./cron";
import { fileStorageKey } from "./db";
import { seedMessage, seedSpace } from "./test/helpers";

async function seedPairingSlot(pairingId: string, createdAt: number): Promise<void> {
  await env.DB.prepare("INSERT INTO pairing (pairing_id, new_device, created_at) VALUES (?, ?, ?)")
    .bind(pairingId, JSON.stringify({ id: "d", publicKey: "pk" }), createdAt)
    .run();
}

async function pairingExists(pairingId: string): Promise<boolean> {
  const row = await env.DB.prepare("SELECT pairing_id FROM pairing WHERE pairing_id = ?")
    .bind(pairingId)
    .first();
  return row !== null;
}

async function messageExists(id: string): Promise<boolean> {
  const row = await env.DB.prepare("SELECT id FROM messages WHERE id = ?").bind(id).first();
  return row !== null;
}

describe("runCleanup", () => {
  it("reaps pairing slots past their TTL and keeps the ones still usable", async () => {
    const now = Date.now();
    await seedPairingSlot("expired", now - PAIRING_TTL_MS - 1_000);
    await seedPairingSlot("fresh", now - 1_000);

    await runCleanup(env);

    expect(await pairingExists("expired")).toBe(false);
    expect(await pairingExists("fresh")).toBe(true);
  });

  it("deletes messages past the TTL together with their R2 blobs", async () => {
    const now = Date.now();
    const { groupId, owner } = await seedSpace();
    const stale = await seedMessage(groupId, owner.id, {
      createdAt: now - MESSAGE_TTL_MS - 1_000,
      fileR2Key: "stale-blob",
    });
    const recent = await seedMessage(groupId, owner.id, { createdAt: now - 1_000 });
    await env.FILES.put(fileStorageKey(groupId, "stale-blob"), "ciphertext");

    await runCleanup(env);

    expect(await messageExists(stale)).toBe(false);
    expect(await messageExists(recent)).toBe(true);
    expect(await env.FILES.head(fileStorageKey(groupId, "stale-blob"))).toBeNull();
  });

  it("deletes an undelivered message's delivery rows too, leaving nothing orphaned", async () => {
    const now = Date.now();
    const { groupId, owner } = await seedSpace();
    const stale = await seedMessage(groupId, owner.id, {
      createdAt: now - MESSAGE_TTL_MS - 1_000,
      recipients: ["never-came-back"],
    });

    await runCleanup(env);

    const row = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM delivery_status WHERE message_id = ?",
    )
      .bind(stale)
      .first<{ n: number }>();
    expect(row?.n).toBe(0);
  });

  it("does nothing (and does not throw) when there is nothing to clean", async () => {
    await expect(runCleanup(env)).resolves.toBeUndefined();
  });
});
