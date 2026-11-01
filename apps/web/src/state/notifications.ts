/**
 * New-message notifications while the app is closed (Web Push).
 *
 * Off until the user turns them on: the permission prompt has to come from a
 * tap, and a prompt on first launch is the one most people answer "Block" to
 * forever. Once on, the choice is device-wide — one subscription serves every
 * space on this device (see sync/push.ts) — and each space keeps its own
 * registration current whenever it is opened: a space joined later, a lock
 * that hid a space's credentials when notifications were turned on, or a
 * subscription the push service dropped all heal on their own there.
 *
 * What a notification says is decided in the service worker, and it is never
 * content: the server only knows "something is waiting in this space".
 */

import { signal } from "@preact/signals";
import { api } from "../api/client";
import { GLOBAL_PUSH_ENABLED, globalMetaGet, globalMetaSet } from "../db/spaces";
import {
  applicationServerKey,
  notificationTag,
  pushSupported,
  registerWithEverySpace,
  subscribedWithKey,
  subscriptionBody,
  unregisterFromEverySpace,
} from "../sync/push";
import { authHeaders, session } from "./session";

export type NotificationsState =
  /** No Push API here (iOS outside an installed app, Firefox private mode, `pnpm dev`). */
  | "unsupported"
  /** This server has no VAPID keys, so it sends no pushes. */
  | "unavailable"
  /** The user blocked notifications for the site in the browser. */
  | "blocked"
  | "off"
  | "on";

export const notificationsState = signal<NotificationsState>("off");

async function registration(): Promise<ServiceWorkerRegistration | undefined> {
  if (!pushSupported()) return undefined;
  return navigator.serviceWorker.getRegistration().catch(() => undefined);
}

/** The browser's subscription for `publicKey`, made if missing or made for another key. */
async function currentSubscription(
  worker: ServiceWorkerRegistration,
  publicKey: string,
): Promise<PushSubscription> {
  const existing = await worker.pushManager.getSubscription();
  if (existing && subscribedWithKey(existing, publicKey)) return existing;
  await existing?.unsubscribe().catch(() => undefined);
  return worker.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: applicationServerKey(publicKey),
  });
}

/**
 * Work out the state for the open space and keep its registration current.
 * Called whenever a space session starts; one small request when it is on.
 */
export async function syncPushSubscription(): Promise<void> {
  const worker = await registration();
  if (!worker || !session.value) {
    notificationsState.value = "unsupported";
    return;
  }
  if (Notification.permission === "denied") {
    notificationsState.value = "blocked";
    return;
  }
  const enabled = (await globalMetaGet<boolean>(GLOBAL_PUSH_ENABLED)) === true;
  try {
    const status = await api.pushStatus(authHeaders());
    if (!status.publicKey) {
      notificationsState.value = "unavailable";
      return;
    }
    if (!enabled || Notification.permission !== "granted") {
      notificationsState.value = "off";
      return;
    }
    const subscription = await currentSubscription(worker, status.publicKey);
    if (status.endpoint !== subscription.endpoint) {
      await api.pushSubscribe(subscriptionBody(subscription), authHeaders());
    }
    notificationsState.value = "on";
  } catch {
    // Offline or the server is unreachable: say what the user chose, and let
    // the next session start finish the registration.
    notificationsState.value = enabled ? "on" : "off";
  }
}

/** Ask for permission (must run from a tap) and subscribe every space this device can reach. */
export async function enableNotifications(): Promise<void> {
  const worker = await registration();
  if (!worker) throw new Error("This browser can't show notifications");
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    notificationsState.value = permission === "denied" ? "blocked" : "off";
    throw new Error("Notifications were not allowed");
  }
  const status = await api.pushStatus(authHeaders());
  if (!status.publicKey) {
    notificationsState.value = "unavailable";
    throw new Error("This server doesn't send notifications");
  }
  const subscription = await currentSubscription(worker, status.publicKey);
  // The open space first and awaited, so the toggle's answer is the truth for
  // at least the space the user is looking at.
  await api.pushSubscribe(subscriptionBody(subscription), authHeaders());
  await registerWithEverySpace(subscription);
  await globalMetaSet(GLOBAL_PUSH_ENABLED, true);
  notificationsState.value = "on";
}

/** Stop notifications on this device, for every space. */
export async function disableNotifications(): Promise<void> {
  await globalMetaSet(GLOBAL_PUSH_ENABLED, false);
  notificationsState.value = "off";
  await api.pushUnsubscribe(authHeaders()).catch(() => undefined);
  await unregisterFromEverySpace();
  const worker = await registration();
  const subscription = await worker?.pushManager.getSubscription();
  await subscription?.unsubscribe().catch(() => undefined);
}

/**
 * Stop pushes for the open space only, before this device leaves it. Leaving
 * is local — the server still lists the device — so without this a browser
 * would keep being woken for a space it no longer has, and nothing left on the
 * device could stop it.
 *
 * False when notifications are on and the server could not be told. The caller
 * must not wipe the space then: its credentials are the only way to try again,
 * and keeping them around after leaving would leave a live credential on disk
 * that the at-rest lock no longer covers.
 */
export async function forgetPushForSpace(): Promise<boolean> {
  if (!session.value) return true;
  try {
    await api.pushUnsubscribe(authHeaders());
    return true;
  } catch {
    return (await globalMetaGet<boolean>(GLOBAL_PUSH_ENABLED).catch(() => false)) !== true;
  }
}

/** Dismiss the notifications of a space the user has just opened: they have been read. */
export async function clearSpaceNotifications(spaceId: string): Promise<void> {
  const worker = await registration();
  const shown = await worker?.getNotifications({ tag: notificationTag(spaceId) }).catch(() => []);
  for (const notification of shown ?? []) notification.close();
}
