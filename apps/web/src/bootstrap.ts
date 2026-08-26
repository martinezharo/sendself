import { effect, untracked } from "@preact/signals";
import { applyRoute, handleAuthFailure, hasPendingShare, noteSharedContent } from "./actions";
import { setAuthFailureHandler } from "./api/client";
import { initAppearance } from "./state/appearance";
import { assertWebCryptoAvailable } from "./crypto/crypto";
import { claimSharedContent } from "./share/incoming";
import { loadLockState } from "./state/lock";
import { navigate, route, startupSpaceTarget } from "./state/route";
import { ready } from "./state/session";
import { adoptLegacySpace, lastOpenedSpace, refreshSpaces, spaces } from "./state/spaces";

/** Load local state before the interactive app replaces the prerendered page. */
export async function bootstrap(): Promise<void> {
  // Before anything renders: the stored scheme and palette are only data
  // attributes on <html>, and applying them first keeps the first paint from
  // showing a brand the user already changed away from.
  initAppearance();

  // The rest of the app is built around Web Crypto. Check it before touching
  // local state so an insecure-origin failure cannot surface halfway through
  // onboarding as `Cannot read properties of undefined`.
  assertWebCryptoAvailable();

  // Any authenticated request can be the one that discovers the device is no
  // longer linked; wire that up before the first one goes out.
  setAuthFailureHandler(handleAuthFailure);

  // Read the share marker out of the URL before anything routes on it.
  if (claimSharedContent()) noteSharedContent();

  // Adopting first: a device that predates the registry keeps its at-rest vault
  // inside its space, and that is where `loadLockState` no longer looks.
  await adoptLegacySpace();
  // A locked device deliberately has no session and no readable space name in
  // storage, so the UI has to show the lock screen rather than an empty space
  // list, which would look like a fresh install.
  await loadLockState();
  await refreshSpaces();
  ready.value = true;

  // The URL names no space: a share from the OS, the installed app's start_url,
  // a bookmark to `/app`. Resolved before the effect below, so the space it
  // picks is the first route the app ever applies rather than a second one on
  // top of the list.
  if (route.value.name === "spaces") {
    const target = startupSpaceTarget({
      spaceIds: spaces.value.map((space) => space.id),
      lastSpaceId: await lastOpenedSpace(),
      pendingShare: hasPendingShare(),
    });
    if (target) navigate(target.path, { replace: target.replace });
  }

  // From here the URL drives everything: a click, the back button and a cold
  // load all take the same path into (and out of) a space.
  effect(() => {
    route.value;
    untracked(() => void applyRoute());
  });
}
