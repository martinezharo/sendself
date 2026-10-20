import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

const androidConfig = JSON.parse(
  readFileSync(new URL("../android.config.json", import.meta.url), "utf8"),
) as { packageId: string; sha256CertFingerprints: string[] };

/**
 * The store-facing half of the PWA contract: what Chrome requires before it
 * offers installation, plus the Digital Asset Links document the Android TWA
 * verifies before it hides the URL bar.
 */

test("meets Chromium's installability criteria", async ({ page }) => {
  await page.goto("/app");

  const session = await page.context().newCDPSession(page);
  const manifest = await session.send("Page.getAppManifest");

  expect(manifest.errors).toEqual([]);
  const data = JSON.parse(manifest.data ?? "{}");

  expect(data.name).toBe("SendSelf");
  expect(data.short_name).toBe("SendSelf");
  expect(data.start_url).toBe("/app");
  expect(data.scope).toBe("/");
  expect(data.display).toBe("standalone");
  expect(data.share_target).toMatchObject({
    action: "/share-target",
    method: "POST",
    enctype: "multipart/form-data",
  });
  expect(data.icons).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ sizes: "192x192", purpose: "any" }),
      expect.objectContaining({ sizes: "512x512", purpose: "any" }),
      expect.objectContaining({ sizes: "512x512", purpose: "maskable" }),
    ]),
  );

  const installability = await session.send("Page.getInstallabilityErrors");
  expect(installability.installabilityErrors).toEqual([]);

  // A registered worker with a fetch handler is the other installability leg;
  // its precache/offline behaviour is covered in shell.spec.ts.
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
});

test("serves Digital Asset Links for the published Android package", async ({ request }) => {
  const response = await request.get("/.well-known/assetlinks.json");

  expect(response.ok()).toBe(true);
  expect(response.headers()["content-type"]).toContain("application/json");
  expect(await response.json()).toEqual([
    {
      relation: ["delegate_permission/common.handle_all_urls"],
      target: {
        namespace: "android_app",
        package_name: androidConfig.packageId,
        sha256_cert_fingerprints: androidConfig.sha256CertFingerprints,
      },
    },
  ]);
});
