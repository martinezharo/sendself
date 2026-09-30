import { describe, expect, it } from "vitest";
import { generateGroupKey } from "./crypto";
import {
  decryptMessageMeta,
  decryptMessageText,
  encryptMessageMeta,
  encryptMessageText,
  messageContext,
} from "./message";

describe("message contexts", () => {
  it("are pinned: every build that ever sent a message used these exact strings", () => {
    expect(messageContext.text("m1")).toBe("text:m1");
    expect(messageContext.file("m1")).toBe("file:m1");
    expect(messageContext.meta("m1")).toBe("meta:m1");
  });

  it("round-trip each part of a message", async () => {
    const key = await generateGroupKey();
    const text = await encryptMessageText(key, "m1", "hello");
    const meta = await encryptMessageMeta(key, "m1", { name: "a.txt", viewOnce: true });

    expect(await decryptMessageText(key, "m1", text.ciphertext, text.iv)).toBe("hello");
    expect(await decryptMessageMeta(key, "m1", meta.ciphertext, meta.iv)).toEqual({
      name: "a.txt",
      viewOnce: true,
    });
  });

  it("refuse a ciphertext moved to another message or another role", async () => {
    const key = await generateGroupKey();
    const text = await encryptMessageText(key, "m1", "hello");

    await expect(decryptMessageText(key, "m2", text.ciphertext, text.iv)).rejects.toThrow();
    await expect(decryptMessageMeta(key, "m1", text.ciphertext, text.iv)).rejects.toThrow();
  });
});
