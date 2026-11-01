/**
 * Custom service worker (vite-plugin-pwa `injectManifest` strategy).
 *
 * Beyond the standard precache/SPA-fallback duties this SW owns three things:
 *  - the Web Share Target POST handler (src/sw/share-target.ts),
 *  - Background Sync for the outbox: queued sends — file uploads in
 *    particular — are flushed here (src/sync/outbox.ts) when the browser
 *    fires the `sync` event, which happens even after the PWA was closed, and
 *  - new-message notifications (Web Push) while the app is closed
 *    (src/sw/notifications.ts).
 *
 * Everything the flush needs (session, GroupKey, queued messages, cached file
 * originals) lives in IndexedDB, so the content-confidentiality invariant is
 * unchanged: encryption happens in this worker on-device; the server still
 * receives ciphertext rather than readable content.
 */

import { clientsClaim } from "workbox-core";
import {
  type PrecacheEntry,
  cleanupOutdatedCaches,
  createHandlerBoundToURL,
  precacheAndRoute,
} from "workbox-precaching";
import { NavigationRoute, registerRoute } from "workbox-routing";
import { listSpaces } from "./db/spaces";
import { registerNotificationHandlers } from "./sw/notifications";
import { handleShareTarget } from "./sw/share-target";
import {
  OUTBOX_FLUSH_MESSAGE,
  OUTBOX_SYNC_TAG,
  type OutboxUpdateBroadcast,
  flushQueuedOutbox,
} from "./sync/outbox";
import type { LocalMessage } from "./types";

declare let self: ServiceWorkerGlobalScope & {
  /** Injected by vite-plugin-pwa / workbox-build at build time. */
  __WB_MANIFEST: Array<PrecacheEntry | string>;
};

// Background Sync (Chromium) is not in the standard TS webworker lib.
interface SyncEvent extends ExtendableEvent {
  readonly tag: string;
  /** True on the browser's final retry attempt for this tag. */
  readonly lastChance: boolean;
}

// Take control immediately and drop stale precaches so a new deploy is fully
// live after one auto-reload (no manual cache clearing).
self.skipWaiting();
clientsClaim();

precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

// The public pages are real static HTML. Only two navigations are answered
// from the precache, and with a different document each — so an unknown URL
// remains a 404 and search engines do not see the application shell at every
// path. Never serve the API from cache.
//
// `/app` and every space under it get `app.html`, whose prerendered content is
// the app's loading screen. Serving them `index.html` (the marketing page) is
// what made the installed app flash the landing page on launch: the shell was
// painted long before the bundle had booted and could replace it.
const navigation = (document: string, allowlist: RegExp[]): NavigationRoute =>
  new NavigationRoute(createHandlerBoundToURL(document), {
    allowlist,
    denylist: [/^\/api\//],
  });

registerRoute(navigation("app.html", [/^\/app(?:\/|\?|$)/]));
registerRoute(navigation("index.html", [/^\/(?:\?.*)?$/]));

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method === "POST" && url.pathname === "/share-target") {
    event.respondWith(handleShareTarget(event.request));
  }
});

registerNotificationHandlers(self);

self.addEventListener("sync", ((event: SyncEvent) => {
  if (event.tag !== OUTBOX_SYNC_TAG) return;
  event.waitUntil(flushOutboxInBackground(event.lastChance));
}) as EventListener);

self.addEventListener("message", (event) => {
  const data = event.data as { type?: string } | null;
  if (data?.type !== OUTBOX_FLUSH_MESSAGE) return;
  // ExtendableMessageEvent.waitUntil keeps this worker alive after the page is
  // suspended. On browsers without Background Sync (notably iOS/Safari), drain
  // successive chunks inside this one best-effort lifecycle event.
  event.waitUntil(flushOutboxInBackground(false, true));
});

/**
 * How long one background event keeps starting new uploads before it hands the
 * rest to a fresh `sync` registration.
 *
 * It used to be one file per space per event, re-registering the tag for the
 * next. Chrome throttles a tag re-registered from inside its own handler, and
 * Safari has no Background Sync at all, so in practice two or three files of a
 * selection landed after the screen went off and the rest waited for the app
 * to be reopened. A time budget keeps the per-file granularity that makes a
 * selection resumable — each file is still its own step, persisted as it
 * completes — while letting one event get through the whole selection when the
 * network allows. It stays well inside Chrome's few-minute limit on a `sync`
 * event, even with one more large upload started just before it runs out.
 */
const BACKGROUND_PASS_BUDGET_MS = 60_000;

async function flushOutboxInBackground(
  lastChance: boolean,
  drainWithoutBackgroundSync = false,
): Promise<void> {
  const deadline = Date.now() + BACKGROUND_PASS_BUDGET_MS;
  while (true) {
    // Every space, not just whichever one the app had open: a message queued in
    // one space must not wait for the user to walk back into it. One file per
    // space per round keeps the spaces taking turns, so a long selection in one
    // cannot starve a short message in another.
    const result = { sent: 0, failed: 0, remaining: 0 };
    for (const space of await listSpaces()) {
      const flushed = await flushQueuedOutbox(
        (message) => void broadcastUpdate(space.id, message),
        { maxMessages: 1, spaceId: space.id },
      );
      result.sent += flushed.sent;
      result.failed += flushed.failed;
      result.remaining += flushed.remaining;
    }
    if (result.remaining === 0) return;

    if (result.sent + result.failed > 0) {
      // Still inside the budget: keep draining in this event.
      if (Date.now() < deadline) continue;
      // Out of budget: hand the rest to a fresh event.
      if (await registerNextOutboxSync()) return;
      // No Background Sync (iOS): there is no later event to hand over to, so
      // the direct message handoff drains for as long as the browser lets it.
      if (drainWithoutBackgroundSync) continue;
    }
    if (!lastChance) {
      // Rejecting waitUntil makes supporting browsers retry with backoff.
      throw new Error(`Outbox not fully flushed (${result.remaining} left)`);
    }
    return;
  }
}

interface SyncCapableRegistration extends ServiceWorkerRegistration {
  sync?: { register(tag: string): Promise<void> };
}

async function registerNextOutboxSync(): Promise<boolean> {
  try {
    const registration = self.registration as SyncCapableRegistration;
    if (!registration.sync) return false;
    await registration.sync.register(OUTBOX_SYNC_TAG);
    return true;
  } catch {
    return false;
  }
}

/** Mirror persisted outbox updates into any open app windows (live UI). */
async function broadcastUpdate(spaceId: string, message: LocalMessage): Promise<void> {
  const broadcast: OutboxUpdateBroadcast = { type: "outbox-message-updated", spaceId, message };
  const windows = await self.clients.matchAll({ type: "window" });
  for (const client of windows) {
    client.postMessage(broadcast);
  }
}
