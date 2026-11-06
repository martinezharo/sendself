/**
 * The app's URLs, as pure functions: the router (state/route.ts) and the
 * service worker, which opens a space from a notification, both build them,
 * and the worker has no DOM to load the router with.
 */

/** The sections of an open space. Messages are what a space is, so they are its root. */
export type SpaceSection = "chat" | "vault" | "devices";

/** Where in the vault: the top level, a folder by id, or the trash. */
export type VaultLocation = { folderId: string | null } | { trash: true };

export const APP_PATH = "/app";

export function spacePath(spaceId: string, section: SpaceSection = "chat"): string {
  const base = `${APP_PATH}/${encodeURIComponent(spaceId)}`;
  return section === "chat" ? base : `${base}/${section}`;
}

/**
 * A place in a space's vault. Folders are URLs so that opening one is a real
 * navigation: Back climbs out of it, the same way it backs out of a section.
 */
export function vaultPath(spaceId: string, location: VaultLocation): string {
  const base = spacePath(spaceId, "vault");
  if ("trash" in location) return `${base}/trash`;
  return location.folderId ? `${base}/${encodeURIComponent(location.folderId)}` : base;
}
