import { runCleanup } from "./cron";
import type { Env } from "./env";
import { ApiError } from "./errors";
import { SpaceHub, realtimeConnect } from "./realtime";
import { Router } from "./router";
import { listDevices, publishSigningKey, revokeDevice, updateDeviceRole } from "./routes/devices";
import { downloadFile, uploadFile } from "./routes/files";
import { createGroup } from "./routes/groups";
import { ackKey, rotateKey } from "./routes/keys";
import { ackMessage, pendingMessages, sendMessage } from "./routes/messages";
import { completePairing, deletePairing, pollPairing, requestPairing } from "./routes/pairing";
import { updateSpaceName } from "./routes/space";
import { withSecurityHeaders } from "./security";

const router = new Router();

const CANONICAL_HOST = "sendself.4oli.com";

router.post("/api/groups", createGroup);

router.post("/api/pairing/:pairingId/request", requestPairing);
router.post("/api/pairing/:pairingId/complete", completePairing);
router.get("/api/pairing/:pairingId", pollPairing);
router.delete("/api/pairing/:pairingId", deletePairing);

router.get("/api/realtime", realtimeConnect);

router.get("/api/messages/pending", pendingMessages);
router.post("/api/messages/:id/ack", ackMessage);
router.post("/api/messages", sendMessage);

router.put("/api/files/:r2key", uploadFile);
router.get("/api/files/:r2key", downloadFile);

router.post("/api/keys/rotate", rotateKey);
router.post("/api/keys/:epoch/ack", ackKey);

router.put("/api/groups/self/name", updateSpaceName);

router.get("/api/devices", listDevices);
router.post("/api/devices/self/signing-key", publishSigningKey);
router.delete("/api/devices/:id", revokeDevice);
router.patch("/api/devices/:id/role", updateDeviceRole);

export { SpaceHub };

/** The document every `/app` URL is served, prerendered as the app's own shell. */
const APP_SHELL = "/app.html";

/**
 * `/app` and everything under it: the client-routed part of the site.
 *
 * The shell's own URL counts as one of them: the service worker precaches it
 * under that name, and the assets binding answers a request for a `.html` file
 * with a redirect to its extensionless path — a hop on every install, and a
 * redirected response to keep in the cache the app launches from offline.
 */
function isAppPath(pathname: string): boolean {
  return pathname === "/app" || pathname.startsWith("/app/") || pathname === APP_SHELL;
}

function redirectHttpToHttps(request: Request): Response | undefined {
  const url = new URL(request.url);
  // Keep local Wrangler development on its configured HTTP port. The port is
  // also used when Wrangler is bound to a VPS/Tailscale IP instead of localhost;
  // the browser still reaches the app through the HTTPS Vite/Tailscale proxy.
  if (
    url.protocol !== "http:" ||
    url.port === "8787" ||
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  ) {
    return undefined;
  }

  url.protocol = "https:";
  return withSecurityHeaders(
    new Response(null, {
      status: 308,
      headers: { Location: url.toString() },
    }),
  );
}

function redirectWwwToCanonical(request: Request): Response | undefined {
  const url = new URL(request.url);
  if (url.hostname !== `www.${CANONICAL_HOST}`) return undefined;

  url.protocol = "https:";
  url.hostname = CANONICAL_HOST;
  return withSecurityHeaders(
    new Response(null, {
      status: 308,
      headers: { Location: url.toString() },
    }),
  );
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    const wwwRedirect = redirectWwwToCanonical(request);
    if (wwwRedirect) return wwwRedirect;

    const redirect = redirectHttpToHttps(request);
    if (redirect) return redirect;

    // The Worker owns /api/* and applies the same security policy to static PWA
    // assets. The assets binding handles public HTML and the custom 404 page.
    if (url.pathname.startsWith("/api/")) {
      try {
        const response = await router.handle(request, env, ctx);
        // A 101 is not a normal response: its body is the socket, and rebuilding
        // it (which is what applying headers does) would both be illegal and
        // drop the `webSocket` the client is waiting for.
        if (response?.status === 101) return response;
        if (response) return withSecurityHeaders(response);
        throw new ApiError("not_found", "No such endpoint");
      } catch (err) {
        if (err instanceof ApiError) return withSecurityHeaders(err.toResponse());
        console.error("Unhandled error:", err);
        return withSecurityHeaders(new ApiError("internal", "Internal server error").toResponse());
      }
    }

    const isCanonicalOrigin = url.protocol === "https:" && url.hostname === CANONICAL_HOST;

    // The app is a single page under /app: the spaces list and every space
    // below it are the same shell, resolved client-side. The assets binding
    // would 404 those paths (there is no file at /app/<id>), so they are served
    // the shell here. It is never indexed: there is nothing public behind it,
    // and each URL is local to one device.
    //
    // The shell is `app.html`, not the marketing page: it is prerendered as the
    // app's loading screen, so an installed app that launches here paints the
    // app from the first frame instead of flashing the landing page until its
    // bundle boots. The service worker serves the same document offline.
    if (isAppPath(url.pathname)) {
      const shell = await env.ASSETS.fetch(new URL(APP_SHELL, url.origin));
      return withSecurityHeaders(shell, { noIndex: true });
    }

    return withSecurityHeaders(await env.ASSETS.fetch(request), {
      noIndex: !isCanonicalOrigin,
    });
  },

  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runCleanup(env));
  },
} satisfies ExportedHandler<Env>;
