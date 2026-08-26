import { REALTIME_AUTH_PROTOCOL_PREFIX, type RealtimeEvent } from "@sendself/shared";
import { type AuthContext, authenticate } from "./auth";
import type { Env } from "./env";
import { ApiError } from "./errors";
import type { RouteContext } from "./router";

/**
 * Real-time delivery.
 *
 * Polling every 8 s was the app's biggest remaining cost: a phone with the tab
 * open woke its radio 450 times an hour to be told nothing had happened, and a
 * message still took up to 8 s to appear. A Durable Object per space fixes both
 * — devices hold one socket, and a send notifies exactly the devices that need
 * to fetch it.
 *
 * Three decisions worth stating, because they are what keep this from widening
 * the trust model:
 *
 *  - **The socket carries no content.** The event says "there is something for
 *    you" and nothing else; the client then runs the same authenticated sync
 *    pass polling ran. Pushing ciphertext down the socket would have been one
 *    round-trip faster and would have put delivery bookkeeping in a second
 *    place, where it could disagree with D1.
 *  - **Polling does not go away.** It drops to a slow safety net
 *    (`REALTIME_POLL_INTERVAL_MS`). A dropped notification, a frozen tab or a
 *    hibernating object can cost latency; it must never cost a message.
 *  - **The object stores nothing.** It holds sockets, not state, so it is a
 *    routing convenience rather than a new copy of the space to protect.
 */

/** Sent to the object by the API to fan a notification out to a space. */
interface NotifyBody {
  /** Device that caused the change; it already knows, so it is skipped. */
  exclude?: string;
}

/** Per-socket data, so a broadcast can skip the device that caused the event. */
interface SocketAttachment {
  deviceId: string;
}

/**
 * One instance per space, addressed by `idFromName(groupId)`. Every device in a
 * space therefore lands on the same object, and devices in different spaces can
 * never reach each other's.
 */
export class SpaceHub implements DurableObject {
  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/notify") {
      const { exclude } = (await request.json()) as NotifyBody;
      this.broadcast(exclude);
      return new Response(null, { status: 204 });
    }

    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected a WebSocket upgrade", { status: 426 });
    }

    const deviceId = url.searchParams.get("deviceId") ?? "";
    const protocol = url.searchParams.get("protocol");
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];

    // The hibernation API: the object can be evicted while sockets stay open,
    // so an idle space costs nothing. Without it, every space with a connected
    // device would keep an object resident indefinitely.
    this.state.acceptWebSocket(server);
    server.serializeAttachment({ deviceId } satisfies SocketAttachment);

    // Browsers fail the handshake unless the server echoes one of the offered
    // subprotocols back.
    const headers = new Headers();
    if (protocol) headers.set("Sec-WebSocket-Protocol", protocol);
    return new Response(null, { status: 101, webSocket: client, headers });
  }

  /**
   * The only thing a client may say is "ping". Answering it is what lets a
   * device notice a connection that a proxy or a sleeping radio killed without
   * a close frame, rather than sitting on a socket that will never deliver.
   */
  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    if (message === "ping") ws.send("pong");
  }

  webSocketError(ws: WebSocket): void {
    ws.close(1011, "socket error");
  }

  private broadcast(exclude?: string): void {
    const event: RealtimeEvent = { type: "sync" };
    const payload = JSON.stringify(event);
    for (const socket of this.state.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as SocketAttachment | null;
      if (exclude && attachment?.deviceId === exclude) continue;
      try {
        socket.send(payload);
      } catch {
        // A socket that died between `getWebSockets` and `send` is exactly the
        // case the polling safety net exists for. Nothing to do here.
      }
    }
  }
}

function hub(env: Env, groupId: string): DurableObjectStub {
  return env.SPACE_HUB.get(env.SPACE_HUB.idFromName(groupId));
}

/**
 * Tell a space's devices that something is waiting. Best-effort and never
 * awaited by a request handler: a failed notification costs one poll interval
 * of latency, while a failed *send* would cost the user their message.
 */
export function notifySpace(env: Env, groupId: string, exclude?: string): Promise<unknown> {
  return hub(env, groupId)
    .fetch("https://space-hub/notify", {
      method: "POST",
      body: JSON.stringify({ exclude } satisfies NotifyBody),
    })
    .catch(() => undefined);
}

/**
 * `GET /api/realtime`: authenticate, then hand the upgrade to the space's
 * object.
 *
 * The token arrives as a subprotocol rather than a header (the browser
 * WebSocket API cannot set headers) or a query parameter (which would land the
 * credential in access logs and referrers). Authentication is unchanged
 * otherwise: same bearer, same revocation, same 401/403.
 */
export async function realtimeConnect(c: RouteContext): Promise<Response> {
  const offered = c.request.headers.get("Sec-WebSocket-Protocol") ?? "";
  const auth = await authenticateSubprotocol(offered, c.request, c.env);

  if (c.request.headers.get("Upgrade") !== "websocket") {
    throw new ApiError("bad_request", "Expected a WebSocket upgrade");
  }

  const chosen = offered
    .split(",")
    .map((value) => value.trim())
    .find((value) => value.startsWith(REALTIME_AUTH_PROTOCOL_PREFIX));

  const url = new URL("https://space-hub/connect");
  url.searchParams.set("deviceId", auth.deviceId);
  if (chosen) url.searchParams.set("protocol", chosen);

  return hub(c.env, auth.groupId).fetch(
    new Request(url, { headers: c.request.headers, method: "GET" }),
  );
}

/**
 * Read the bearer token out of the offered subprotocols and authenticate with
 * it, falling back to a normal Authorization header so a non-browser client
 * (or a test) can connect the ordinary way.
 */
function authenticateSubprotocol(
  offered: string,
  request: Request,
  env: Env,
): Promise<AuthContext> {
  const token = offered
    .split(",")
    .map((value) => value.trim())
    .find((value) => value.startsWith(REALTIME_AUTH_PROTOCOL_PREFIX))
    ?.slice(REALTIME_AUTH_PROTOCOL_PREFIX.length);

  if (!token) return authenticate(request, env);

  const headers = new Headers(request.headers);
  headers.set("Authorization", `Bearer ${token}`);
  return authenticate(new Request(request.url, { headers }), env);
}
