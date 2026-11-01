/**
 * The app's URLs, as pure functions: the router (state/route.ts) and the
 * service worker, which opens a space from a notification, both build them,
 * and the worker has no DOM to load the router with.
 */

/** The sections of an open space. Messages are what a space is, so they are its root. */
export type SpaceSection = "chat" | "devices";

export const APP_PATH = "/app";

export function spacePath(spaceId: string, section: SpaceSection = "chat"): string {
  const base = `${APP_PATH}/${encodeURIComponent(spaceId)}`;
  return section === "chat" ? base : `${base}/${section}`;
}
