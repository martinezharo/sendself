import { afterEach, describe, expect, it } from "vitest";
import { generateGroupKey } from "@sendself/client/crypto";
import {
  currentContentKey,
  fileContext,
  messageContext,
  openBlob,
  openJson,
  sealBlob,
  sealJson,
  setContentKey,
  setContentLocked,
} from "./atrest";

afterEach(() => setContentKey(null));

describe("without a content key", () => {
  it("seals nothing, which is how an unlocked device keeps storing in the clear", async () => {
    expect(await sealJson({ a: 1 }, "ctx")).toBeNull();
    expect(await sealBlob(new Blob(["bytes"]), "ctx")).toBeNull();
    expect(currentContentKey()).toBeNull();
  });

  it("cannot open a sealed record, and says so by returning undefined", async () => {
    // This is the service worker while the device is locked: "there is nothing
    // to read" rather than an exception every call site would have to handle.
    setContentKey(await generateGroupKey());
    const sealed = (await sealJson({ secret: true }, "ctx"))!;
    setContentKey(null);

    expect(await openJson(sealed, "ctx")).toBeUndefined();
  });

  it("never falls back to cleartext writes while explicitly locked", async () => {
    setContentLocked(true);

    await expect(sealJson({ secret: true }, "ctx")).rejects.toThrow("Local content is locked");
    await expect(sealBlob(new Blob(["secret"]), "ctx")).rejects.toThrow("Local content is locked");
  });
});

describe("with a content key", () => {
  it("round-trips a record", async () => {
    setContentKey(await generateGroupKey());

    const sealed = (await sealJson({ text: "hello" }, messageContext("m1")))!;

    expect(sealed.ct).not.toContain("hello");
    expect(await openJson(sealed, messageContext("m1"))).toEqual({ text: "hello" });
  });

  it("refuses a record moved onto another message id", async () => {
    setContentKey(await generateGroupKey());

    const sealed = (await sealJson({ text: "hello" }, messageContext("m1")))!;

    await expect(openJson(sealed, messageContext("m2"))).rejects.toThrow();
  });

  it("round-trips a file, preserving its mime type", async () => {
    setContentKey(await generateGroupKey());
    const original = new Blob(["file bytes"], { type: "text/plain" });

    const sealed = (await sealBlob(original, fileContext("k1")))!;
    const opened = await openBlob(
      new Blob([sealed.ct]),
      sealed.iv,
      fileContext("k1"),
      "text/plain",
    );

    expect(opened?.type).toBe("text/plain");
    expect(await opened?.text()).toBe("file bytes");
  });

  it("refuses a file blob moved onto another key", async () => {
    setContentKey(await generateGroupKey());
    const sealed = (await sealBlob(new Blob(["bytes"]), fileContext("k1")))!;

    await expect(
      openBlob(new Blob([sealed.ct]), sealed.iv, fileContext("k2"), ""),
    ).rejects.toThrow();
  });

  it("uses a fresh IV for identical content", async () => {
    setContentKey(await generateGroupKey());

    const a = (await sealJson({ same: 1 }, "ctx"))!;
    const b = (await sealJson({ same: 1 }, "ctx"))!;

    expect(a.iv).not.toBe(b.iv);
    expect(a.ct).not.toBe(b.ct);
  });
});

describe("explicit key choice", () => {
  it("reads through the current key and writes through another", async () => {
    // Exactly what turning a lock on and off does: the migration has to open
    // rows with the old setting and store them under the new one.
    const oldKey = await generateGroupKey();
    const newKey = await generateGroupKey();
    setContentKey(oldKey);
    const sealed = (await sealJson({ v: 1 }, "ctx"))!;

    const opened = await openJson<{ v: number }>(sealed, "ctx");
    const rewritten = await sealJson(opened, "ctx", newKey);

    setContentKey(newKey);
    expect(await openJson(rewritten!, "ctx")).toEqual({ v: 1 });
    setContentKey(oldKey);
    await expect(openJson(rewritten!, "ctx")).rejects.toThrow();
  });

  it("treats an explicit null as 'store in the clear'", async () => {
    setContentKey(await generateGroupKey());

    expect(await sealJson({ a: 1 }, "ctx", null)).toBeNull();
    expect(await sealBlob(new Blob(["x"]), "ctx", null)).toBeNull();
  });
});
