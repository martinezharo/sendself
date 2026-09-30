import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  exportGroupKey,
  generateGroupKey,
  importPublicKey,
  wrapSecret,
} from "@sendself/client/crypto";
import { createInvite } from "@sendself/client/pairing";
import { PAIRING_TTL_MS, type PairingRequestBody } from "@sendself/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadDevice } from "./config";
import { link } from "./link";

let directory: string;
let path: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "sendself-link-"));
  path = join(directory, "device.json");
});

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  await rm(directory, { recursive: true, force: true });
});

async function server(
  options: { transient?: "rate_limited" | "network" | "server"; ready?: boolean } = {},
) {
  const groupKey = await exportGroupKey(await generateGroupKey());
  const printed: string[] = [];
  let request: PairingRequestBody | undefined;
  let wrapped: Awaited<ReturnType<typeof wrapSecret>> | undefined;
  let polls = 0;
  let deleted = false;
  let firstPoll!: () => void;
  const polled = new Promise<void>((resolve) => {
    firstPoll = resolve;
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        request = JSON.parse(init.body as string) as PairingRequestBody;
        const slot = url.split("/").at(-2)!;
        wrapped = await wrapSecret(
          await importPublicKey(request.device.publicKey),
          {
            groupId: "space-1",
            deviceAuthToken: "device-token",
            groupKey,
            keyEpoch: 3,
            spaceName: "Personal",
          },
          `pairing:${slot}`,
        );
        return Response.json({ ok: true });
      }
      if (init?.method === "DELETE") {
        deleted = true;
        return Response.json({ ok: true });
      }
      polls++;
      firstPoll();
      if (polls === 1 && options.transient === "network") throw new TypeError("Connection lost");
      if (polls === 1 && options.transient === "server") {
        return Response.json(
          { error: { code: "internal", message: "Temporary failure" } },
          { status: 500 },
        );
      }
      if (polls === 1 && options.transient === "rate_limited") {
        return Response.json(
          { error: { code: "rate_limited", message: "Slow down" } },
          { status: 429 },
        );
      }
      return Response.json(
        options.ready === false ? { ready: false } : { ready: true, ...wrapped },
      );
    }),
  );
  return {
    options: {
      server: "https://example.test",
      deviceName: "Test server",
      devicePath: path,
      print: (text: string) => {
        printed.push(text);
      },
    },
    printed,
    polled,
    groupKey,
    request: () => request,
    polls: () => polls,
    deleted: () => deleted,
  };
}

describe("link", () => {
  it.each(["invitation", "QR"])("unwraps and persists a device using %s pairing", async (mode) => {
    const api = await server();
    const device = await link({
      ...api.options,
      ...(mode === "invitation" ? { invite: createInvite() } : {}),
    });
    const stored = await loadDevice(path);
    expect(stored).toMatchObject({
      groupId: "space-1",
      token: "device-token",
      spaceName: "Personal",
      deviceId: device.deviceId,
    });
    expect(await exportGroupKey(stored.keyring.keys.get(3)!)).toBe(api.groupKey);
    expect(api.request()?.sendOnly).toBe(true);
    expect(!!api.request()?.invite).toBe(mode === "invitation");
    expect(api.printed.join("\n")).toContain(
      mode === "invitation" ? "Waiting for approval" : "Paste code",
    );
    expect(api.deleted()).toBe(true);
  });

  it.each(["rate_limited", "network", "server"] as const)(
    "keeps linking after a transient %s failure",
    async (transient) => {
      const api = await server({ transient });
      vi.useFakeTimers();
      const result = link({ ...api.options, invite: createInvite() });
      await api.polled;
      await vi.advanceTimersByTimeAsync(transient === "rate_limited" ? 15_000 : 2500);
      await expect(result).resolves.toMatchObject({ groupId: "space-1" });
      expect(api.polls()).toBe(2);
      expect((await loadDevice(path)).groupId).toBe("space-1");
    },
  );

  it("reports expiration and cleans up an unanswered invitation", async () => {
    const api = await server({ ready: false });
    vi.useFakeTimers();
    const result = link({ ...api.options, invite: createInvite() });
    const assertion = expect(result).rejects.toThrow(
      "The invitation expired before it was approved",
    );
    await api.polled;
    await vi.advanceTimersByTimeAsync(PAIRING_TTL_MS + 2500);
    await assertion;
    expect(api.deleted()).toBe(true);
    await expect(loadDevice(path)).rejects.toThrow("not linked");
  });

  it("cancels waiting without saving a device", async () => {
    const api = await server({ ready: false });
    const controller = new AbortController();
    const result = link({ ...api.options, invite: createInvite(), signal: controller.signal });
    const assertion = expect(result).rejects.toThrow("Linking cancelled");
    await api.polled;
    controller.abort(new Error("Linking cancelled"));
    await assertion;
    expect(api.deleted()).toBe(true);
    await expect(loadDevice(path)).rejects.toThrow("not linked");
  });
});
