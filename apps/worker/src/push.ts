import { MESSAGE_TTL_MS, type PushPayload, base64UrlToBuf, bufToBase64Url } from "@sendself/shared";
import type { Env } from "./env";

/**
 * Web Push: tell a device whose app is closed that something is waiting.
 *
 * The same rules as the real-time socket (realtime.ts), for the same reasons:
 *
 *  - **It carries no content.** The payload names the space and nothing else;
 *    the app syncs and decrypts exactly as it always does once it is opened.
 *    It is encrypted to the browser (RFC 8291), so the push service in the
 *    middle — Google, Apple, Mozilla, Microsoft — sees a sender, a size and a
 *    time, never which space it is about.
 *  - **It is a hint.** A push that fails, expires or is never shown costs a
 *    notification, not a message: delivery is still the pending queue in D1.
 *  - **It goes only where the socket cannot.** A device with the space open on
 *    screen is told over its socket and pushed nothing.
 *
 * Implemented on WebCrypto rather than a library: the `web-push` package needs
 * Node's crypto, and the protocol is two small, well-specified pieces — a VAPID
 * JWT (RFC 8292) and one aes128gcm record (RFC 8188).
 */

/** Hosts a subscription may point at. Anything else would turn the API into an open relay. */
const PUSH_SERVICE_HOSTS = ["fcm.googleapis.com"];
const PUSH_SERVICE_SUFFIXES = [
  ".push.services.mozilla.com",
  ".push.apple.com",
  ".notify.windows.com",
];

/** A push outliving the message it announces would wake the device for nothing. */
const PUSH_TTL_SECONDS = Math.floor(MESSAGE_TTL_MS / 1000);
/** VAPID tokens may live up to 24 h; half of that leaves room for clock skew. */
const VAPID_TOKEN_TTL_SECONDS = 12 * 60 * 60;
/** D1 caps bound parameters per statement; a space's devices fit many times over. */
const MAX_DEVICES_PER_QUERY = 90;

const encoder = new TextEncoder();
const utf8 = (text: string): Uint8Array<ArrayBuffer> => new Uint8Array(encoder.encode(text));

// --- encoding ---------------------------------------------------------------

/** Bytes as base64url. */
export const bytesToBase64Url = (bytes: Uint8Array): string => bufToBase64Url(bytes);

/** base64url as bytes, typed for WebCrypto. */
export function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(base64UrlToBuf(value));
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

// --- validation -------------------------------------------------------------

/**
 * Whether `endpoint` belongs to a browser push service. The server POSTs to
 * whatever is stored here, so this is the line between "notify a device" and
 * "make requests to any URL a client names".
 */
export function isPushServiceEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.port !== "" || url.username || url.password) return false;
  const host = url.hostname;
  return (
    PUSH_SERVICE_HOSTS.includes(host) ||
    PUSH_SERVICE_SUFFIXES.some((suffix) => host.endsWith(suffix))
  );
}

/** A base64url value that decodes to exactly `length` bytes (and, for a key, starts like one). */
export function isBase64UrlOfLength(value: string, length: number, firstByte?: number): boolean {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return false;
  try {
    const bytes = base64UrlToBytes(value);
    return bytes.length === length && (firstByte === undefined || bytes[0] === firstByte);
  } catch {
    return false;
  }
}

// --- VAPID (RFC 8292) -------------------------------------------------------

export interface VapidKeys {
  /** Uncompressed P-256 point, base64url: what browsers subscribe with. */
  publicKey: string;
  privateKey: CryptoKey;
  /** Contact for the push services, as RFC 8292 asks: a mailto: or https: URL. */
  subject: string;
}

let cachedKeys: { source: string; keys: Promise<VapidKeys> } | null = null;

/** The server's VAPID identity, or null when push has not been set up (see docs/deployment.md). */
export function vapidKeys(env: Env): Promise<VapidKeys> | null {
  const publicKey = env.VAPID_PUBLIC_KEY;
  const privateKey = env.VAPID_PRIVATE_KEY;
  if (!publicKey || !privateKey) return null;
  const subject = env.VAPID_SUBJECT || "https://sendself.4oli.com";
  const source = `${publicKey}.${privateKey}.${subject}`;
  if (cachedKeys?.source !== source) {
    cachedKeys = { source, keys: importVapidKeys(publicKey, privateKey, subject) };
    // A key that fails to import is a configuration error; do not cache it.
    cachedKeys.keys.catch(() => {
      if (cachedKeys?.source === source) cachedKeys = null;
    });
  }
  return cachedKeys.keys;
}

async function importVapidKeys(
  publicKey: string,
  privateKey: string,
  subject: string,
): Promise<VapidKeys> {
  const point = base64UrlToBytes(publicKey);
  const key = await crypto.subtle.importKey(
    "jwk",
    {
      kty: "EC",
      crv: "P-256",
      x: bytesToBase64Url(point.slice(1, 33)),
      y: bytesToBase64Url(point.slice(33, 65)),
      d: privateKey,
    },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  return { publicKey, privateKey: key, subject };
}

/** The `Authorization` header a push service accepts from this server. */
export async function vapidAuthorization(
  endpoint: string,
  keys: VapidKeys,
  now = Date.now(),
): Promise<string> {
  const encode = (value: unknown): string =>
    bytesToBase64Url(encoder.encode(JSON.stringify(value)));
  const unsigned = `${encode({ typ: "JWT", alg: "ES256" })}.${encode({
    aud: new URL(endpoint).origin,
    exp: Math.floor(now / 1000) + VAPID_TOKEN_TTL_SECONDS,
    sub: keys.subject,
  })}`;
  // WebCrypto's ECDSA signature is already the raw r‖s form JWS wants.
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    keys.privateKey,
    encoder.encode(unsigned),
  );
  return `vapid t=${unsigned}.${bytesToBase64Url(new Uint8Array(signature))}, k=${keys.publicKey}`;
}

// --- payload encryption (RFC 8291 / RFC 8188) -------------------------------

async function hkdf(
  salt: Uint8Array<ArrayBuffer>,
  ikm: Uint8Array<ArrayBuffer>,
  info: Uint8Array<ArrayBuffer>,
  length: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(
    await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8),
  );
}

/** One aes128gcm record is plenty: payloads here are a few dozen bytes. */
const RECORD_SIZE = 4096;

/**
 * Encrypt `plaintext` for one browser subscription. `salt` and `serverKeys`
 * are parameters only so a test can reproduce a known vector; every real push
 * uses fresh ones.
 */
export async function encryptPushPayload(
  plaintext: Uint8Array,
  p256dh: string,
  authSecret: string,
  salt: Uint8Array<ArrayBuffer> = crypto.getRandomValues(new Uint8Array(16)),
  serverKeys?: CryptoKeyPair,
): Promise<Uint8Array<ArrayBuffer>> {
  const receiverPublic = base64UrlToBytes(p256dh);
  const auth = base64UrlToBytes(authSecret);
  const local =
    serverKeys ??
    ((await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
      "deriveBits",
    ])) as CryptoKeyPair);
  const senderPublic = new Uint8Array(
    (await crypto.subtle.exportKey("raw", local.publicKey)) as ArrayBuffer,
  );

  const receiverKey = await crypto.subtle.importKey(
    "raw",
    receiverPublic,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  // The standard member is `public`; workers-types spells it `$public` (a
  // reserved-word escape in its generator), which the runtime does not read.
  const ecdh = { name: "ECDH", public: receiverKey } as unknown as SubtleCryptoDeriveKeyAlgorithm;
  const shared = new Uint8Array(await crypto.subtle.deriveBits(ecdh, local.privateKey, 256));

  const ikm = await hkdf(
    auth,
    shared,
    concat(utf8("WebPush: info\u0000"), receiverPublic, senderPublic),
    32,
  );
  const cek = await hkdf(salt, ikm, utf8("Content-Encoding: aes128gcm\u0000"), 16);
  const nonce = await hkdf(salt, ikm, utf8("Content-Encoding: nonce\u0000"), 12);

  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  // 0x02 marks the last (and only) record; no padding after it.
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce },
      key,
      concat(plaintext, new Uint8Array([2])),
    ),
  );

  const header = new Uint8Array(16 + 4 + 1 + senderPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE);
  header[20] = senderPublic.length;
  header.set(senderPublic, 21);
  return concat(header, ciphertext);
}

// --- sending ----------------------------------------------------------------

export interface StoredSubscription {
  deviceId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

export type PushOutcome = "sent" | "gone" | "failed";

/**
 * One topic per space: while a device is offline the push service keeps only
 * the latest push per topic, so a burst of messages wakes it once. Hashed so
 * the push service does not learn the space id from it.
 */
async function topicFor(groupId: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(`sendself-push:${groupId}`));
  return bytesToBase64Url(new Uint8Array(digest)).slice(0, 32);
}

export async function sendPush(
  subscription: StoredSubscription,
  payload: PushPayload,
  keys: VapidKeys,
  fetcher: typeof fetch = fetch,
): Promise<PushOutcome> {
  try {
    const body = await encryptPushPayload(
      encoder.encode(JSON.stringify(payload)),
      subscription.p256dh,
      subscription.auth,
    );
    const response = await fetcher(subscription.endpoint, {
      method: "POST",
      headers: {
        Authorization: await vapidAuthorization(subscription.endpoint, keys),
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        TTL: String(PUSH_TTL_SECONDS),
        Urgency: "high",
        Topic: await topicFor(payload.groupId),
      },
      body,
      // A push service never redirects. Following one would send a signed
      // request to wherever an allowlisted host pointed it.
      redirect: "manual",
    });
    // 404/410: the browser dropped this subscription. Anything else (429, 5xx)
    // is the push service's problem today, not a reason to forget the device.
    if (response.status === 404 || response.status === 410) return "gone";
    return response.ok ? "sent" : "failed";
  } catch {
    return "failed";
  }
}

/**
 * Push "something is waiting" to `deviceIds` in `groupId`, for those that have
 * a subscription. Best-effort throughout, and a subscription the push service
 * reports gone is deleted so it is not retried on every message.
 */
export async function pushToDevices(
  env: Env,
  groupId: string,
  deviceIds: readonly string[],
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const keysPromise = vapidKeys(env);
  if (!keysPromise || deviceIds.length === 0) return;
  const keys = await keysPromise;

  const subscriptions: StoredSubscription[] = [];
  for (let start = 0; start < deviceIds.length; start += MAX_DEVICES_PER_QUERY) {
    const chunk = deviceIds.slice(start, start + MAX_DEVICES_PER_QUERY);
    const rows = await env.DB.prepare(
      `SELECT device_id AS deviceId, endpoint, p256dh, auth
         FROM push_subscriptions
        WHERE group_id = ? AND device_id IN (${chunk.map(() => "?").join(", ")})`,
    )
      .bind(groupId, ...chunk)
      .all<StoredSubscription>();
    subscriptions.push(...rows.results);
  }
  if (subscriptions.length === 0) return;

  const payload: PushPayload = { type: "message", groupId };
  const outcomes = await Promise.all(
    subscriptions.map((subscription) => sendPush(subscription, payload, keys, fetcher)),
  );

  const gone = subscriptions.filter((_, i) => outcomes[i] === "gone");
  if (gone.length > 0) {
    await env.DB.batch(
      gone.map((subscription) =>
        env.DB.prepare("DELETE FROM push_subscriptions WHERE device_id = ? AND endpoint = ?").bind(
          subscription.deviceId,
          subscription.endpoint,
        ),
      ),
    );
  }
}
