import { describe, expect, it } from "vitest";
import {
  APP_PATH,
  navigate,
  route,
  showSpaceSection,
  spacePath,
  startupSpaceTarget,
  vaultPath,
} from "./route";

/**
 * The router runs without a DOM here (no `history`), which is also the shape it
 * has during the server-side prerender of the landing page: it must resolve a
 * path without touching the browser.
 */
describe("navigate", () => {
  it("reads the landing page from the site root", () => {
    navigate("/");

    expect(route.value).toEqual({ name: "landing" });
  });

  it("reads the space list from /app, with or without a trailing slash", () => {
    navigate(APP_PATH);
    expect(route.value).toEqual({ name: "spaces" });

    navigate("/app/");
    expect(route.value).toEqual({ name: "spaces" });
  });

  it("reads a space from the segment below /app, on its chat by default", () => {
    navigate(spacePath("abc-123"));

    expect(route.value).toEqual({ name: "space", spaceId: "abc-123", section: "chat" });
  });

  it("reads a space's section from the segment below it", () => {
    navigate(spacePath("abc-123", "devices"));

    expect(route.value).toEqual({ name: "space", spaceId: "abc-123", section: "devices" });
  });

  it("reads a place in the vault: the top level, a folder, or the trash", () => {
    navigate("/app/abc-123/vault");
    expect(route.value).toEqual({
      name: "space",
      spaceId: "abc-123",
      section: "vault",
      vault: { folderId: null },
    });

    navigate(vaultPath("abc-123", { folderId: "f/1" }));
    expect(route.value).toMatchObject({ section: "vault", vault: { folderId: "f/1" } });

    navigate(vaultPath("abc-123", { trash: true }));
    expect(route.value).toMatchObject({ section: "vault", vault: { trash: true } });
  });

  it("falls back to the space's chat for a section it does not know", () => {
    navigate("/app/abc-123/settings");

    expect(route.value).toEqual({ name: "space", spaceId: "abc-123", section: "chat" });
  });

  it("round-trips an id whose base64url characters need escaping", () => {
    // Space ids are random base64url, so they can contain characters a URL
    // would otherwise reinterpret — including the separator of the section
    // that follows it.
    const id = "a/b+c d";

    navigate(spacePath(id, "devices"));

    expect(route.value).toEqual({ name: "space", spaceId: id, section: "devices" });
  });

  it("ignores the query and hash when deciding where it is", () => {
    navigate("/app?share-target=1");
    expect(route.value).toEqual({ name: "spaces" });

    navigate("/app/xyz?a=1#top");
    expect(route.value).toEqual({ name: "space", spaceId: "xyz", section: "chat" });
  });

  it("treats anything outside /app as the public site", () => {
    navigate("/security/");
    expect(route.value).toEqual({ name: "landing" });

    // Not a prefix match: /applications is someone else's page.
    navigate("/applications");
    expect(route.value).toEqual({ name: "landing" });
  });
});

describe("showSpaceSection", () => {
  it("switches section while staying in the same space", () => {
    navigate(spacePath("abc-123", "devices"));

    showSpaceSection("chat");

    expect(route.value).toEqual({ name: "space", spaceId: "abc-123", section: "chat" });
  });

  it("does nothing when no space is open", () => {
    navigate(APP_PATH);

    showSpaceSection("chat");

    expect(route.value).toEqual({ name: "spaces" });
  });
});

describe("startupSpaceTarget", () => {
  const launch = (
    over: Partial<Parameters<typeof startupSpaceTarget>[0]> = {},
  ): ReturnType<typeof startupSpaceTarget> =>
    startupSpaceTarget({ spaceIds: [], lastSpaceId: undefined, pendingShare: false, ...over });

  it("reopens the space the app was last in, keeping the list behind it", () => {
    expect(launch({ spaceIds: ["one", "two"], lastSpaceId: "two" })).toEqual({
      path: spacePath("two"),
      replace: false,
    });
  });

  it("stays on the list when the app was last left there", () => {
    expect(launch({ spaceIds: ["one"] })).toBeUndefined();
  });

  it("stays on the list when the remembered space is no longer on this device", () => {
    expect(launch({ spaceIds: ["one"], lastSpaceId: "gone" })).toBeUndefined();
  });

  it("sends a share straight into the only space, replacing the list", () => {
    expect(launch({ spaceIds: ["one"], pendingShare: true })).toEqual({
      path: spacePath("one"),
      replace: true,
    });
  });

  it("asks where a share goes when the device has more than one space", () => {
    expect(
      launch({ spaceIds: ["one", "two"], lastSpaceId: "two", pendingShare: true }),
    ).toBeUndefined();
  });

  it("has nowhere to go on a device with no spaces", () => {
    expect(launch({ pendingShare: true })).toBeUndefined();
  });
});
