import { SELF, env } from "cloudflare:test";
import { REALTIME_AUTH_PROTOCOL_PREFIX, REALTIME_PRESENCE_HIDDEN } from "@sendself/shared";
import { describe, expect, it } from "vitest";
import {
  base64UrlToBytes,
  bytesToBase64Url,
  encryptPushPayload,
  isPushServiceEndpoint,
  pushToDevices,
  vapidAuthorization,
  vapidKeys,
} from "./push";
import { authHeader, errorCode, seedDevice, seedSpace } from "./test/helpers";
import type { SeededDevice } from "./test/helpers";

const encoder = new TextEncoder();

/** A browser's side of a subscription: its ECDH key pair and auth secret. */
async function browserSubscription(): Promise<{
  keys: CryptoKeyPair;
  p256dh: string;
  auth: string;
}> {
  const keys = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ])) as CryptoKeyPair;
  const raw = new Uint8Array((await crypto.subtle.exportKey("raw", keys.publicKey)) as ArrayBuffer);
  return {
    keys,
    p256dh: bytesToBase64Url(raw),
    auth: bytesToBase64Url(crypto.getRandomValues(new Uint8Array(16))),
  };
}

async function hkdf(
  salt: Uint8Array<ArrayBuffer>,
  ikm: Uint8Array<ArrayBuffer>,
  info: string | Uint8Array<ArrayBuffer>,
  length: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const infoBytes = typeof info === "string" ? new Uint8Array(encoder.encode(info)) : info;
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt, info: infoBytes },
      key,
      length * 8,
    ),
  );
}

/** What the browser does with a push body (RFC 8291), written out independently. */
async function decryptAsBrowser(
  body: Uint8Array<ArrayBuffer>,
  browser: Awaited<ReturnType<typeof browserSubscription>>,
): Promise<string> {
  const salt = body.slice(0, 16);
  const recordSize = new DataView(body.buffer, body.byteOffset).getUint32(16);
  const idLength = body[20]!;
  const senderPublic = body.slice(21, 21 + idLength);
  const ciphertext = body.slice(21 + idLength);
  expect(recordSize).toBeGreaterThan(ciphertext.length);

  const senderKey = await crypto.subtle.importKey(
    "raw",
    senderPublic,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const ecdh = { name: "ECDH", public: senderKey } as unknown as SubtleCryptoDeriveKeyAlgorithm;
  const shared = new Uint8Array(await crypto.subtle.deriveBits(ecdh, browser.keys.privateKey, 256));
  const receiverPublic = base64UrlToBytes(browser.p256dh);
  const info = new Uint8Array(14 + 65 + 65);
  info.set(encoder.encode("WebPush: info\u0000"), 0);
  info.set(receiverPublic, 14);
  info.set(senderPublic, 79);
  const ikm = await hkdf(base64UrlToBytes(browser.auth), shared, info, 32);
  const cek = await hkdf(salt, ikm, "Content-Encoding: aes128gcm\u0000", 16);
  const nonce = await hkdf(salt, ikm, "Content-Encoding: nonce\u0000", 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  const padded = new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, ciphertext),
  );
  // Last record: the plaintext ends at the 0x02 delimiter.
  const end = padded.lastIndexOf(2);
  expect(end).toBe(padded.length - 1);
  return new TextDecoder().decode(padded.slice(0, end));
}

describe("payload encryption", () => {
  it("produces a body the subscribed browser can decrypt", async () => {
    const browser = await browserSubscription();
    const body = await encryptPushPayload(
      encoder.encode('{"type":"message","groupId":"g"}'),
      browser.p256dh,
      browser.auth,
    );

    expect(await decryptAsBrowser(body, browser)).toBe('{"type":"message","groupId":"g"}');
  });

  it("uses a fresh salt and key for every push", async () => {
    const browser = await browserSubscription();
    const plaintext = encoder.encode("same");
    const a = await encryptPushPayload(plaintext, browser.p256dh, browser.auth);
    const b = await encryptPushPayload(plaintext, browser.p256dh, browser.auth);

    expect(bytesToBase64Url(a)).not.toBe(bytesToBase64Url(b));
  });
});

describe("VAPID", () => {
  it("signs a token for the push service's origin with the server's key", async () => {
    const keys = await vapidKeys(env)!;
    const header = await vapidAuthorization(
      "https://fcm.googleapis.com/fcm/send/abc",
      keys,
      1_700_000_000_000,
    );

    const match = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header);
    expect(match).not.toBeNull();
    const [, head, claims, signature, k] = match!;
    expect(k).toBe(env.VAPID_PUBLIC_KEY);
    expect(JSON.parse(new TextDecoder().decode(base64UrlToBytes(claims!)))).toMatchObject({
      aud: "https://fcm.googleapis.com",
      exp: 1_700_000_000 + 12 * 60 * 60,
    });

    const publicKey = await crypto.subtle.importKey(
      "raw",
      base64UrlToBytes(k!),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    expect(
      await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        publicKey,
        base64UrlToBytes(signature!),
        new Uint8Array(encoder.encode(`${head}.${claims}`)),
      ),
    ).toBe(true);
  });
});

describe("push service endpoints", () => {
  it.each([
    "https://fcm.googleapis.com/fcm/send/abc",
    "https://updates.push.services.mozilla.com/wpush/v2/abc",
    "https://web.push.apple.com/abc",
    "https://wns2-par02p.notify.windows.com/w/?token=abc",
  ])("accepts %s", (endpoint) => {
    expect(isPushServiceEndpoint(endpoint)).toBe(true);
  });

  it.each([
    "http://fcm.googleapis.com/fcm/send/abc",
    "https://fcm.googleapis.com:8443/fcm/send/abc",
    "https://evil.example/fcm.googleapis.com",
    "https://fcm.googleapis.com.evil.example/x",
    "https://user:pass@fcm.googleapis.com/x",
    "https://169.254.169.254/latest",
    "not a url",
  ])("refuses %s", (endpoint) => {
    expect(isPushServiceEndpoint(endpoint)).toBe(false);
  });
});

async function subscribe(device: SeededDevice, endpoint: string): Promise<Response> {
  const browser = await browserSubscription();
  return SELF.fetch("https://x.dev/api/push", {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...authHeader(device) },
    body: JSON.stringify({ endpoint, p256dh: browser.p256dh, auth: browser.auth }),
  });
}

async function status(device: SeededDevice): Promise<{ publicKey: string; endpoint: string }> {
  const response = await SELF.fetch("https://x.dev/api/push", { headers: authHeader(device) });
  expect(response.status).toBe(200);
  return response.json();
}

describe("/api/push", () => {
  it("hands out the VAPID key and stores a subscription", async () => {
    const { owner } = await seedSpace();
    expect(await status(owner)).toEqual({ publicKey: env.VAPID_PUBLIC_KEY, endpoint: null });

    const response = await subscribe(owner, "https://fcm.googleapis.com/fcm/send/one");

    expect(response.status).toBe(200);
    expect((await status(owner)).endpoint).toBe("https://fcm.googleapis.com/fcm/send/one");
  });

  it("replaces the subscription rather than adding a second one", async () => {
    const { owner } = await seedSpace();
    await subscribe(owner, "https://fcm.googleapis.com/fcm/send/old");
    await subscribe(owner, "https://fcm.googleapis.com/fcm/send/new");

    const rows = await env.DB.prepare("SELECT endpoint FROM push_subscriptions WHERE device_id = ?")
      .bind(owner.id)
      .all<{ endpoint: string }>();
    expect(rows.results.map((row) => row.endpoint)).toEqual([
      "https://fcm.googleapis.com/fcm/send/new",
    ]);
  });

  it("refuses an endpoint that is not a push service", async () => {
    const { owner } = await seedSpace();
    const response = await subscribe(owner, "https://attacker.example/collect");

    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe("bad_request");
  });

  it("refuses keys of the wrong shape", async () => {
    const { owner } = await seedSpace();
    const response = await SELF.fetch("https://x.dev/api/push", {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...authHeader(owner) },
      body: JSON.stringify({
        endpoint: "https://fcm.googleapis.com/fcm/send/x",
        p256dh: bytesToBase64Url(new Uint8Array(33)),
        auth: bytesToBase64Url(new Uint8Array(16)),
      }),
    });

    expect(response.status).toBe(400);
  });

  it("unsubscribes", async () => {
    const { owner } = await seedSpace();
    await subscribe(owner, "https://fcm.googleapis.com/fcm/send/x");

    const response = await SELF.fetch("https://x.dev/api/push", {
      method: "DELETE",
      headers: authHeader(owner),
    });

    expect(response.status).toBe(200);
    expect((await status(owner)).endpoint).toBeNull();
  });

  it("requires a device", async () => {
    const response = await SELF.fetch("https://x.dev/api/push");
    expect(response.status).toBe(401);
  });

  it("drops a device's subscription when it is revoked", async () => {
    const { groupId, owner } = await seedSpace();
    const target = await seedDevice(groupId);
    await subscribe(target, "https://fcm.googleapis.com/fcm/send/revoked");

    await SELF.fetch(`https://x.dev/api/devices/${target.id}`, {
      method: "DELETE",
      headers: authHeader(owner),
    });

    const row = await env.DB.prepare("SELECT 1 FROM push_subscriptions WHERE device_id = ?")
      .bind(target.id)
      .first();
    expect(row).toBeNull();
  });
});

describe("pushToDevices", () => {
  it("pushes to subscribed devices only, and forgets subscriptions the service reports gone", async () => {
    const { groupId } = await seedSpace();
    const alive = await seedDevice(groupId);
    const gone = await seedDevice(groupId);
    const unsubscribed = await seedDevice(groupId);
    const browser = await browserSubscription();
    await subscribe(alive, "https://fcm.googleapis.com/fcm/send/alive");
    // The gone one is subscribed with a key this test holds, to read its payload.
    await SELF.fetch("https://x.dev/api/push", {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...authHeader(gone) },
      body: JSON.stringify({
        endpoint: "https://fcm.googleapis.com/fcm/send/gone",
        p256dh: browser.p256dh,
        auth: browser.auth,
      }),
    });

    const requests: {
      url: string;
      headers: Headers;
      body: Uint8Array<ArrayBuffer>;
      redirect?: RequestInit["redirect"];
    }[] = [];
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({
        url,
        headers: new Headers(init?.headers),
        body: new Uint8Array(init?.body as ArrayBuffer),
        redirect: init?.redirect,
      });
      return new Response(null, { status: url.endsWith("/gone") ? 410 : 201 });
    }) as typeof fetch;

    await pushToDevices(env, groupId, [alive.id, gone.id, unsubscribed.id], fetcher);

    expect(requests.map((request) => request.url).sort()).toEqual([
      "https://fcm.googleapis.com/fcm/send/alive",
      "https://fcm.googleapis.com/fcm/send/gone",
    ]);
    const toGone = requests.find((request) => request.url.endsWith("/gone"))!;
    expect(toGone.headers.get("Content-Encoding")).toBe("aes128gcm");
    expect(toGone.redirect).toBe("manual");
    expect(toGone.headers.get("TTL")).toBe(String(24 * 60 * 60));
    expect(toGone.headers.get("Topic")).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(toGone.headers.get("Topic")).not.toContain(groupId);
    expect(JSON.parse(await decryptAsBrowser(toGone.body, browser))).toEqual({
      type: "message",
      groupId,
    });

    const remaining = await env.DB.prepare(
      "SELECT device_id AS id FROM push_subscriptions WHERE group_id = ?",
    )
      .bind(groupId)
      .all<{ id: string }>();
    expect(remaining.results.map((row) => row.id)).toEqual([alive.id]);
  });

  it("never pushes into another space", async () => {
    const a = await seedSpace();
    const b = await seedSpace();
    await subscribe(b.owner, "https://fcm.googleapis.com/fcm/send/b");
    let calls = 0;
    const fetcher = (async () => {
      calls += 1;
      return new Response(null, { status: 201 });
    }) as typeof fetch;

    await pushToDevices(env, a.groupId, [b.owner.id], fetcher);

    expect(calls).toBe(0);
  });

  it("does nothing on a server without VAPID keys", async () => {
    const { groupId, owner } = await seedSpace();
    await subscribe(owner, "https://fcm.googleapis.com/fcm/send/x");
    let calls = 0;
    const fetcher = (async () => {
      calls += 1;
      return new Response(null, { status: 201 });
    }) as typeof fetch;

    await pushToDevices({ ...env, VAPID_PRIVATE_KEY: undefined }, groupId, [owner.id], fetcher);

    expect(calls).toBe(0);
  });
});

describe("presence", () => {
  async function connect(device: SeededDevice): Promise<WebSocket> {
    const response = await SELF.fetch("https://x.dev/api/realtime", {
      headers: {
        Upgrade: "websocket",
        "Sec-WebSocket-Protocol": `${REALTIME_AUTH_PROTOCOL_PREFIX}${device.token}`,
      },
    });
    const socket = response.webSocket!;
    socket.accept();
    return socket;
  }

  async function present(groupId: string): Promise<string[]> {
    const hub = env.SPACE_HUB.get(env.SPACE_HUB.idFromName(groupId));
    const response = await hub.fetch("https://space-hub/notify", {
      method: "POST",
      body: JSON.stringify({}),
    });
    return ((await response.json()) as { present: string[] }).present;
  }

  it("counts a connected device as present until it says the space is off screen", async () => {
    const { groupId, owner } = await seedSpace();
    const socket = await connect(owner);
    expect(await present(groupId)).toEqual([owner.id]);

    socket.send(REALTIME_PRESENCE_HIDDEN);
    // The message is processed asynchronously by the object; a ping round
    // trip after it proves it has been.
    const pong = new Promise((resolve) =>
      socket.addEventListener("message", resolve, { once: true }),
    );
    socket.send("ping");
    await pong;

    expect(await present(groupId)).toEqual([]);
    socket.close();
  });
});
