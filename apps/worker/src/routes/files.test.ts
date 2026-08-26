import { SELF, env } from "cloudflare:test";
import { MAX_UPLOAD_SIZE } from "@sendself/shared";
import { describe, expect, it } from "vitest";
import { fileStorageKey } from "../db";
import type { SeededDevice } from "../test/helpers";
import { authHeader, errorCode, seedSpace } from "../test/helpers";
import { boundedUploadBody } from "./files";

function upload(
  device: SeededDevice,
  key: string,
  body: BodyInit,
  headers: Record<string, string> = {},
): Promise<Response> {
  return SELF.fetch(`https://x.dev/api/files/${key}`, {
    method: "PUT",
    headers: { ...authHeader(device), ...headers },
    body,
  });
}

function download(device: SeededDevice, key: string): Promise<Response> {
  return SELF.fetch(`https://x.dev/api/files/${key}`, { headers: authHeader(device) });
}

describe("PUT /api/files/:key", () => {
  it("stores the ciphertext under the caller's group namespace", async () => {
    const { groupId, owner } = await seedSpace();

    const response = await upload(owner, "blob1", "encrypted-bytes");

    expect(response.status).toBe(200);
    const object = await env.FILES.get(fileStorageKey(groupId, "blob1"));
    expect(await object?.text()).toBe("encrypted-bytes");
  });

  it("cannot write outside its own group, even with a key another group uses", async () => {
    const a = await seedSpace();
    const b = await seedSpace();
    await upload(a.owner, "shared", "from-a");

    await upload(b.owner, "shared", "from-b");

    expect(await (await env.FILES.get(fileStorageKey(a.groupId, "shared")))?.text()).toBe("from-a");
    expect(await (await env.FILES.get(fileStorageKey(b.groupId, "shared")))?.text()).toBe("from-b");
  });

  it("requires Content-Length so R2 can stream a fixed-length body", async () => {
    const { owner } = await seedSpace();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("chunked"));
        controller.close();
      },
    });

    const response = await SELF.fetch("https://x.dev/api/files/chunked", {
      method: "PUT",
      headers: authHeader(owner),
      body: stream,
      // @ts-expect-error - required by undici/workerd for a streaming body
      duplex: "half",
    });

    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe("bad_request");
  });

  it("stops the bounded stream at the first byte over the limit", async () => {
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(MAX_UPLOAD_SIZE));
        controller.enqueue(new Uint8Array(1));
        controller.close();
      },
    });
    const bounded = boundedUploadBody(source);
    const reader = bounded.stream.getReader();

    await reader.read();
    await expect(reader.read()).rejects.toThrow("upload_too_large");
    expect(bounded.exceeded()).toBe(true);
  });

  it("rejects an oversized upload from the header alone", async () => {
    const { groupId, owner } = await seedSpace();

    const response = await upload(owner, "toobig", "small body", {
      "Content-Length": String(MAX_UPLOAD_SIZE + 1),
    });

    expect(response.status).toBe(413);
    expect(await errorCode(response)).toBe("payload_too_large");
    expect(await env.FILES.head(fileStorageKey(groupId, "toobig"))).toBeNull();
  });

  it.each([
    ["zero", "0"],
    ["negative", "-5"],
    ["non-numeric", "lots"],
  ])("rejects a %s Content-Length", async (_label, value) => {
    const { owner } = await seedSpace();

    const response = await upload(owner, "badlen", "body", { "Content-Length": value });

    expect(response.status).toBe(400);
  });

  it("rejects an object key that is not URL-safe", async () => {
    const { owner } = await seedSpace();

    // A traversal never routes at all, which is what keeps it out of the key.
    expect((await upload(owner, "..%2Fescape", "body")).status).toBe(400);
  });

  it("rejects an unauthenticated upload", async () => {
    const response = await SELF.fetch("https://x.dev/api/files/anon", {
      method: "PUT",
      body: "bytes",
    });

    expect(response.status).toBe(401);
  });
});

describe("GET /api/files/:key", () => {
  it("streams the ciphertext back with no-store caching", async () => {
    const { owner } = await seedSpace();
    await upload(owner, "blob2", "encrypted-bytes");

    const response = await download(owner, "blob2");

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("encrypted-bytes");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Content-Type")).toBe("application/octet-stream");
  });

  it("cannot read another group's blob even knowing its key", async () => {
    const a = await seedSpace();
    const b = await seedSpace();
    await upload(a.owner, "private", "a-secret");

    const response = await download(b.owner, "private");

    expect(response.status).toBe(404);
    expect(await errorCode(response)).toBe("not_found");
  });

  it("404s once the blob has been deleted", async () => {
    const { groupId, owner } = await seedSpace();
    await upload(owner, "gone", "bytes");
    await env.FILES.delete(fileStorageKey(groupId, "gone"));

    const response = await download(owner, "gone");

    expect(response.status).toBe(404);
  });

  it("rejects an unauthenticated download", async () => {
    expect((await SELF.fetch("https://x.dev/api/files/anon")).status).toBe(401);
  });
});
