import { describe, expect, it } from "vitest";
import { installedAppStartPath, manualInstallHint } from "./pwa";

describe("installedAppStartPath", () => {
  it("opens an installed standalone PWA at /app instead of the landing page", () => {
    expect(
      installedAppStartPath({
        pathname: "/",
        standaloneDisplayMode: true,
        iosStandalone: false,
      }),
    ).toBe("/app");
  });

  it("recognizes the iOS Home Screen standalone mode", () => {
    expect(
      installedAppStartPath({
        pathname: "/",
        standaloneDisplayMode: false,
        iosStandalone: true,
      }),
    ).toBe("/app");
  });

  it("leaves the landing page available in a normal browser tab", () => {
    expect(
      installedAppStartPath({
        pathname: "/",
        standaloneDisplayMode: false,
        iosStandalone: false,
      }),
    ).toBeUndefined();
  });

  it("does not replace an installed app deep link", () => {
    expect(
      installedAppStartPath({
        pathname: "/app/space-id",
        standaloneDisplayMode: true,
        iosStandalone: false,
      }),
    ).toBeUndefined();
  });
});

describe("manualInstallHint", () => {
  const hint = (userAgent: string, maxTouchPoints = 0): string | undefined =>
    manualInstallHint({ userAgent, maxTouchPoints });

  it("points every iOS browser at the share sheet", () => {
    const safari =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1";
    const chrome =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/138.0.0.0 Mobile/15E148 Safari/604.1";

    expect(hint(safari)).toMatch(/Add to Home Screen/);
    expect(hint(chrome)).toMatch(/Add to Home Screen/);
  });

  it("recognizes iPadOS, which reports itself as a Mac", () => {
    const ipad =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15";

    expect(hint(ipad, 5)).toMatch(/Add to Home Screen/);
  });

  it("sends Safari on macOS to Add to Dock, from Safari 17 on", () => {
    const safari = (version: string): string =>
      `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/${version} Safari/605.1.15`;

    expect(hint(safari("18.5"))).toMatch(/Add to Dock/);
    expect(hint(safari("16.6"))).toBeUndefined();
  });

  it("uses the browser menu on Android browsers that have no prompt", () => {
    const firefox = "Mozilla/5.0 (Android 15; Mobile; rv:141.0) Gecko/141.0 Firefox/141.0";

    expect(hint(firefox)).toMatch(/browser menu/);
  });

  it("offers nothing where a desktop browser cannot install", () => {
    const firefox =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:141.0) Gecko/20100101 Firefox/141.0";
    const chrome =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36";

    expect(hint(firefox)).toBeUndefined();
    // Chromium installs through its own prompt, not through instructions.
    expect(hint(chrome)).toBeUndefined();
  });
});
