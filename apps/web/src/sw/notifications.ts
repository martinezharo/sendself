/**
 * New-message notifications (runs inside the service worker, see src/sw.ts).
 *
 * A push only says which space has something waiting (`PushPayload`), so the
 * notification never shows content — the worker could not decrypt it without
 * syncing, and a lock screen is the last place it belongs. It names the space
 * when this device can read its name, counts what arrived since the last time
 * it was dismissed, and opens the space when tapped.
 *
 * Every push shows a notification, without exception. Browsers require it
 * (`userVisibleOnly`): Safari revokes a subscription after a few silent pushes,
 * and Chrome shows a generic one of its own. The server already skips devices
 * with the space on screen; if one still arrives there (the socket had not yet
 * said "visible"), it is shown without sound and the page dismisses it as soon
 * as it syncs. Anything that goes wrong on the way falls back to a generic
 * notification rather than to none.
 */

import type { PushPayload } from "@sendself/shared";
import { APP_PATH, spacePath } from "../state/paths";
import { notificationTag, registerWithEverySpace, spaceForGroup } from "../sync/push";

/** Not in the TS WebWorker lib. */
interface PushSubscriptionChangeEvent extends ExtendableEvent {
  readonly oldSubscription: PushSubscription | null;
  readonly newSubscription: PushSubscription | null;
}

interface NotificationData {
  url: string;
  count: number;
  /** When the device last buzzed for this space. */
  alertedAt: number;
}

/** A burst (an album, a few quick messages) updates the notification without buzzing again. */
const QUIET_PERIOD_MS = 30_000;

export function registerNotificationHandlers(scope: ServiceWorkerGlobalScope): void {
  scope.addEventListener("push", (event) => {
    event.waitUntil(showPushNotification(scope, event.data));
  });

  scope.addEventListener("notificationclick", (event) => {
    event.notification.close();
    const data = event.notification.data as Partial<NotificationData> | null;
    event.waitUntil(openApp(scope, data?.url ?? APP_PATH));
  });

  scope.addEventListener("pushsubscriptionchange", ((event: PushSubscriptionChangeEvent) => {
    event.waitUntil(renewSubscription(scope, event));
  }) as EventListener);
}

function readPayload(data: PushMessageData | null): PushPayload | null {
  try {
    const payload = data?.json() as PushPayload | undefined;
    return payload?.type === "message" && typeof payload.groupId === "string" ? payload : null;
  } catch {
    return null;
  }
}

async function showPushNotification(
  scope: ServiceWorkerGlobalScope,
  data: PushMessageData | null,
): Promise<void> {
  try {
    await showSpaceNotification(scope, readPayload(data));
  } catch {
    await scope.registration.showNotification("SendSelf", {
      body: "New message",
      tag: notificationTag("unknown"),
      icon: "/icon-192.png",
      data: { url: APP_PATH, count: 1, alertedAt: Date.now() } satisfies NotificationData,
    });
  }
}

async function showSpaceNotification(
  scope: ServiceWorkerGlobalScope,
  payload: PushPayload | null,
): Promise<void> {
  // Locked, or a space this context cannot map: still a notification, just an
  // anonymous one that opens the space list.
  const space = payload ? await spaceForGroup(payload.groupId).catch(() => undefined) : undefined;
  const url = space ? spacePath(space.id) : APP_PATH;
  const onScreen = space ? await spaceOnScreen(scope, url).catch(() => false) : false;

  const tag = notificationTag(space?.id ?? "unknown");
  const [previous] = await scope.registration.getNotifications({ tag }).catch(() => []);
  const before = previous?.data as Partial<NotificationData> | undefined;
  const count = (before?.count ?? 0) + 1;
  const now = Date.now();
  const quiet =
    onScreen || (before?.alertedAt !== undefined && now - before.alertedAt < QUIET_PERIOD_MS);

  await scope.registration.showNotification(space?.name ?? "SendSelf", {
    body: count === 1 ? "New message" : `${count} new messages`,
    tag,
    icon: "/icon-192.png",
    // `renotify` is what makes a replaced notification buzz again; `silent`
    // keeps a burst (or a space already on screen) quiet without hiding it.
    renotify: !quiet,
    silent: quiet,
    data: {
      url,
      count,
      alertedAt: quiet && before?.alertedAt !== undefined ? before.alertedAt : now,
    } satisfies NotificationData,
  } as NotificationOptions);
}

/** A focused window already showing this space: the user is reading it. */
async function spaceOnScreen(scope: ServiceWorkerGlobalScope, url: string): Promise<boolean> {
  const windows = await scope.clients.matchAll({ type: "window", includeUncontrolled: true });
  return windows.some(
    (client) =>
      client.focused &&
      client.visibilityState === "visible" &&
      new URL(client.url).pathname === url,
  );
}

async function openApp(scope: ServiceWorkerGlobalScope, url: string): Promise<void> {
  const windows = await scope.clients.matchAll({ type: "window", includeUncontrolled: true });
  const target = new URL(url, scope.location.origin).href;
  const existing = windows.find((client) => new URL(client.url).pathname.startsWith(APP_PATH));
  if (existing) {
    const focused = await existing.focus();
    if (focused.url !== target) await focused.navigate(target).catch(() => undefined);
    return;
  }
  await scope.clients.openWindow(target);
}

/**
 * The browser replaced the subscription (it expired, or the push service
 * rotated it). Register the new one with every space whose credentials are
 * readable here; a locked device catches up when each space is next opened.
 */
async function renewSubscription(
  scope: ServiceWorkerGlobalScope,
  event: PushSubscriptionChangeEvent,
): Promise<void> {
  let subscription = event.newSubscription;
  if (!subscription) {
    const key = event.oldSubscription?.options.applicationServerKey;
    if (!key) return;
    subscription = await scope.registration.pushManager
      .subscribe({ userVisibleOnly: true, applicationServerKey: key })
      .catch(() => null);
  }
  if (subscription) await registerWithEverySpace(subscription);
}
