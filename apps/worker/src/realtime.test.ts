import { SELF, env } from "cloudflare:test";
import { REALTIME_AUTH_PROTOCOL_PREFIX, type RealtimeEvent } from "@sendself/shared";
import { describe, expect, it } from "vitest";
import type { SeededDevice } from "./test/helpers";
import { authHeader, errorCode, seedDevice, seedMessage, seedSpace } from "./test/helpers";

/** Open a real-time socket the way the browser does: token as a subprotocol. */
async function connect(device: SeededDevice): Promise<WebSocket> {
  const response = await SELF.fetch("https://x.dev/api/realtime", {
    headers: {
      Upgrade: "websocket",
      "Sec-WebSocket-Protocol": `${REALTIME_AUTH_PROTOCOL_PREFIX}${device.token}`,
    },
  });
  expect(response.status).toBe(101);
  const socket = response.webSocket;
  if (!socket) throw new Error("no socket on the upgrade response");
  socket.accept();
  return socket;
}

/** Resolve with the next frame, or with null if none arrives within `ms`. */
function nextFrame(socket: WebSocket, ms = 1_000): Promise<string | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    socket.addEventListener(
      "message",
      (event) => {
        clearTimeout(timer);
        resolve(String((event as MessageEvent).data));
      },
      { once: true },
    );
  });
}

describe("GET /api/realtime", () => {
  it("upgrades an authenticated device and echoes its subprotocol back", async () => {
    // Browsers fail the handshake unless the server picks one of the offered
    // protocols, so this is not cosmetic: without it nothing ever connects.
    const { owner } = await seedSpace();

    const response = await SELF.fetch("https://x.dev/api/realtime", {
      headers: {
        Upgrade: "websocket",
        "Sec-WebSocket-Protocol": `${REALTIME_AUTH_PROTOCOL_PREFIX}${owner.token}`,
      },
    });

    expect(response.status).toBe(101);
    expect(response.headers.get("Sec-WebSocket-Protocol")).toBe(
      `${REALTIME_AUTH_PROTOCOL_PREFIX}${owner.token}`,
    );
  });

  it("also accepts an ordinary Authorization header", async () => {
    const { owner } = await seedSpace();

    const response = await SELF.fetch("https://x.dev/api/realtime", {
      headers: { Upgrade: "websocket", ...authHeader(owner) },
    });

    expect(response.status).toBe(101);
  });

  it("rejects a connection with no credentials", async () => {
    const response = await SELF.fetch("https://x.dev/api/realtime", {
      headers: { Upgrade: "websocket" },
    });

    expect(response.status).toBe(401);
  });

  it("rejects a token no device owns", async () => {
    await seedSpace();

    const response = await SELF.fetch("https://x.dev/api/realtime", {
      headers: {
        Upgrade: "websocket",
        "Sec-WebSocket-Protocol": `${REALTIME_AUTH_PROTOCOL_PREFIX}not-a-real-token`,
      },
    });

    expect(response.status).toBe(401);
  });

  it("rejects a revoked device, so a socket cannot outlive its access", async () => {
    const { groupId } = await seedSpace();
    const revoked = await seedDevice(groupId, { revoked: true });

    const response = await SELF.fetch("https://x.dev/api/realtime", {
      headers: {
        Upgrade: "websocket",
        "Sec-WebSocket-Protocol": `${REALTIME_AUTH_PROTOCOL_PREFIX}${revoked.token}`,
      },
    });

    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe("device_revoked");
  });

  it("refuses a plain GET that is not an upgrade", async () => {
    const { owner } = await seedSpace();

    const response = await SELF.fetch("https://x.dev/api/realtime", {
      headers: authHeader(owner),
    });

    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe("bad_request");
  });
});

describe("notifications", () => {
  it("wakes the other devices in the space when a message is sent", async () => {
    const { groupId, owner } = await seedSpace();
    const recipient = await seedDevice(groupId);
    const socket = await connect(recipient);
    const frame = nextFrame(socket);

    const response = await SELF.fetch("https://x.dev/api/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeader(owner) },
      body: JSON.stringify({ id: "rt-msg-1", keyEpoch: 1, encryptedPayload: "ct", iv: "iv" }),
    });

    expect(response.status).toBe(200);
    expect(JSON.parse((await frame) ?? "null")).toEqual({ type: "sync" } satisfies RealtimeEvent);
    socket.close();
  });

  it("does not wake the device that caused the change", async () => {
    // It already knows; a self-notification would just cost it a sync pass.
    const { groupId, owner } = await seedSpace();
    await seedDevice(groupId);
    const socket = await connect(owner);
    const frame = nextFrame(socket, 300);

    await SELF.fetch("https://x.dev/api/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeader(owner) },
      body: JSON.stringify({ id: "rt-msg-2", keyEpoch: 1, encryptedPayload: "ct", iv: "iv" }),
    });

    expect(await frame).toBeNull();
    socket.close();
  });

  it("never reaches a device in another space", async () => {
    const a = await seedSpace();
    await seedDevice(a.groupId);
    const b = await seedSpace();
    const outsider = await connect(b.owner);
    const frame = nextFrame(outsider, 300);

    await SELF.fetch("https://x.dev/api/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeader(a.owner) },
      body: JSON.stringify({ id: "rt-msg-3", keyEpoch: 1, encryptedPayload: "ct", iv: "iv" }),
    });

    expect(await frame).toBeNull();
    outsider.close();
  });

  it("wakes the remaining devices after a revocation, so the rotation lands fast", async () => {
    const { groupId, owner } = await seedSpace();
    const other = await seedDevice(groupId);
    const target = await seedDevice(groupId);
    const socket = await connect(other);
    const frame = nextFrame(socket);

    await SELF.fetch(`https://x.dev/api/devices/${target.id}`, {
      method: "DELETE",
      headers: authHeader(owner),
    });

    expect(JSON.parse((await frame) ?? "null")).toEqual({ type: "sync" });
    socket.close();
  });

  it("wakes the remaining devices after a key rotation", async () => {
    const { groupId, owner } = await seedSpace({ rotationPending: true });
    const other = await seedDevice(groupId);
    const socket = await connect(other);
    const frame = nextFrame(socket);

    await SELF.fetch("https://x.dev/api/keys/rotate", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeader(owner) },
      body: JSON.stringify({
        epoch: 2,
        wraps: [{ deviceId: other.id, wrappedKey: "w", ephemeralPublicKey: "e" }],
      }),
    });

    expect(JSON.parse((await frame) ?? "null")).toEqual({ type: "sync" });
    socket.close();
  });

  it("sends nothing when a message had no recipients to begin with", async () => {
    const { owner } = await seedSpace();
    const socket = await connect(owner);
    const frame = nextFrame(socket, 300);

    await SELF.fetch("https://x.dev/api/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeader(owner) },
      body: JSON.stringify({ id: "rt-msg-4", keyEpoch: 1, encryptedPayload: "ct", iv: "iv" }),
    });

    expect(await frame).toBeNull();
    socket.close();
  });
});

describe("keepalive", () => {
  it("answers a ping, which is how a client detects a dead socket", async () => {
    const { owner } = await seedSpace();
    const socket = await connect(owner);
    const frame = nextFrame(socket);

    socket.send("ping");

    expect(await frame).toBe("pong");
    socket.close();
  });

  it("ignores anything else a client sends", async () => {
    const { owner } = await seedSpace();
    const socket = await connect(owner);
    const frame = nextFrame(socket, 300);

    socket.send(JSON.stringify({ type: "sync" }));

    expect(await frame).toBeNull();
    socket.close();
  });
});

describe("delivery still works without a socket", () => {
  it("leaves the pending queue as the source of truth", async () => {
    // The socket is a hint. If a notification is dropped, the next poll must
    // still find everything — which is what keeps this from being a delivery
    // mechanism that can lose messages.
    const { groupId, owner } = await seedSpace();
    const recipient = await seedDevice(groupId);
    const id = await seedMessage(groupId, owner.id, { recipients: [recipient.id] });

    const response = await SELF.fetch("https://x.dev/api/messages/pending", {
      headers: authHeader(recipient),
    });
    const body = (await response.json()) as { messages: { id: string }[] };

    expect(body.messages.map((m) => m.id)).toEqual([id]);
    expect(env.SPACE_HUB).toBeDefined();
  });
});
