/**
 * Web Push plumbing shared by the page (state/notifications.ts) and the
 * service worker (sw.ts). Context-neutral like the outbox: no DOM, no signals,
 * credentials read from IndexedDB.
 *
 * One browser holds one push subscription, but this device is a different
 * device in every space it belongs to, each with its own credentials. So the
 * same subscription is registered once per space, and every push names the
 * space it is about (`PushPayload.groupId`) for the worker to map back to a
 * local one.
 */

import type { PushSubscribeRequest } from "@sendself/shared";
import { base64UrlToBuf, bufToBase64Url } from "@sendself/client/crypto";
import { quietApi } from "../api/client";
import { type SpaceRecord, listSpaces } from "../db/spaces";
import { META_SESSION, metaGet } from "../db/store";
import type { Session } from "../types";

/** The tag a space's notification is shown under, so a new one replaces it. */
export function notificationTag(key: string): string {
  return `sendself-space:${key}`;
}

/** Whether this context can subscribe to pushes at all. */
export function pushSupported(): boolean {
  return (
    typeof self !== "undefined" &&
    "PushManager" in self &&
    "Notification" in self &&
    (typeof navigator === "undefined" || "serviceWorker" in navigator)
  );
}

/** The browser's subscription, in the shape the API takes. */
export function subscriptionBody(subscription: PushSubscription): PushSubscribeRequest {
  const key = (name: PushEncryptionKeyName): string => {
    const value = subscription.getKey(name);
    if (!value) throw new Error(`Push subscription has no ${name} key`);
    return bufToBase64Url(value);
  };
  return { endpoint: subscription.endpoint, p256dh: key("p256dh"), auth: key("auth") };
}

/** The session of `spaceId`, when it can be read here (not under an at-rest lock). */
function storedSession(spaceId: string): Promise<Session | undefined> {
  return metaGet<Session>(META_SESSION, spaceId).catch(() => undefined);
}

/**
 * Register `subscription` with every space whose credentials this context can
 * read, through the client that does not treat a rejection as the open space
 * being revoked. A space it cannot (locked, or a failed request) registers itself the
 * next time it is opened (`syncPushSubscription`), so nothing here is fatal.
 */
export async function registerWithEverySpace(subscription: PushSubscription): Promise<void> {
  const body = subscriptionBody(subscription);
  const spaces = await listSpaces();
  await Promise.all(
    spaces.map(async (space) => {
      const session = await storedSession(space.id);
      if (!session) return;
      await quietApi.pushSubscribe(body, { token: session.deviceAuthToken }).catch(() => undefined);
    }),
  );
}

/** Stop pushes for every space whose credentials this context can read. */
export async function unregisterFromEverySpace(): Promise<void> {
  const spaces = await listSpaces();
  await Promise.all(
    spaces.map(async (space) => {
      const session = await storedSession(space.id);
      if (!session) return;
      await quietApi.pushUnsubscribe({ token: session.deviceAuthToken }).catch(() => undefined);
    }),
  );
}

/** The local space a push is about, or undefined when this context cannot tell. */
export async function spaceForGroup(groupId: string): Promise<SpaceRecord | undefined> {
  for (const space of await listSpaces()) {
    if ((await storedSession(space.id))?.groupId === groupId) return space;
  }
  return undefined;
}

/** A base64url VAPID key as the `applicationServerKey` the Push API takes. */
export function applicationServerKey(publicKey: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(base64UrlToBuf(publicKey));
}

/** Whether `subscription` was made for `publicKey` (a server key change invalidates it). */
export function subscribedWithKey(subscription: PushSubscription, publicKey: string): boolean {
  const current = subscription.options.applicationServerKey;
  return !!current && bufToBase64Url(current) === publicKey;
}
