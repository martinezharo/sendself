import type {
  PushStatusResponse,
  PushSubscribeRequest,
  PushSubscribeResponse,
} from "@sendself/shared";
import { authenticate } from "../auth";
import { ApiError, json } from "../errors";
import { readJsonObject, requireString } from "../http";
import { isBase64UrlOfLength, isPushServiceEndpoint } from "../push";
import type { RouteContext } from "../router";
import { rateLimit } from "../security";

/** Long enough for every push service's endpoints, short enough to bound the row. */
const MAX_ENDPOINT_LENGTH = 2048;

/**
 * `GET /api/push`: the server's VAPID key, and the endpoint this device is
 * subscribed with. The app reads both: the key to subscribe the browser, and
 * the endpoint to tell whether the server still has the subscription the
 * browser holds (it is dropped when the push service reports it gone).
 */
export async function pushStatus(c: RouteContext): Promise<Response> {
  const auth = await authenticate(c.request, c.env);
  const row = await c.env.DB.prepare(
    "SELECT endpoint FROM push_subscriptions WHERE device_id = ? AND group_id = ?",
  )
    .bind(auth.deviceId, auth.groupId)
    .first<{ endpoint: string }>();
  const publicKey =
    c.env.VAPID_PUBLIC_KEY && c.env.VAPID_PRIVATE_KEY ? c.env.VAPID_PUBLIC_KEY : null;
  return json({ publicKey, endpoint: row?.endpoint ?? null } satisfies PushStatusResponse);
}

/** `PUT /api/push`: subscribe this device (or replace its subscription). */
export async function pushSubscribe(c: RouteContext): Promise<Response> {
  const auth = await authenticate(c.request, c.env);
  await rateLimit(c.env, "RL_WRITE", auth.deviceId);
  if (!c.env.VAPID_PUBLIC_KEY || !c.env.VAPID_PRIVATE_KEY) {
    throw new ApiError("not_found", "Push notifications are not set up on this server");
  }
  const body = await readJsonObject<PushSubscribeRequest>(c.request);

  const endpoint = requireString(body.endpoint, "endpoint", MAX_ENDPOINT_LENGTH);
  if (!isPushServiceEndpoint(endpoint)) {
    throw new ApiError("bad_request", "endpoint is not a known push service");
  }
  const p256dh = requireString(body.p256dh, "p256dh", 128);
  if (!isBase64UrlOfLength(p256dh, 65, 0x04)) {
    throw new ApiError("bad_request", "p256dh must be an uncompressed P-256 public key");
  }
  const secret = requireString(body.auth, "auth", 64);
  if (!isBase64UrlOfLength(secret, 16)) {
    throw new ApiError("bad_request", "auth must be a 16-byte secret");
  }

  await c.env.DB.prepare(
    `INSERT INTO push_subscriptions (device_id, group_id, endpoint, p256dh, auth, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (device_id) DO UPDATE
       SET group_id = excluded.group_id,
           endpoint = excluded.endpoint,
           p256dh = excluded.p256dh,
           auth = excluded.auth,
           created_at = excluded.created_at`,
  )
    .bind(auth.deviceId, auth.groupId, endpoint, p256dh, secret, Date.now())
    .run();

  return json({ ok: true } satisfies PushSubscribeResponse);
}

/** `DELETE /api/push`: stop pushing to this device. Idempotent. */
export async function pushUnsubscribe(c: RouteContext): Promise<Response> {
  const auth = await authenticate(c.request, c.env);
  await c.env.DB.prepare("DELETE FROM push_subscriptions WHERE device_id = ? AND group_id = ?")
    .bind(auth.deviceId, auth.groupId)
    .run();
  return json({ ok: true } satisfies PushSubscribeResponse);
}
