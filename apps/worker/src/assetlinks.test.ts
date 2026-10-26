import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import androidConfig from "../../../android.config.json";

describe("Android Digital Asset Links", () => {
  it("associates the published Android package with this origin", async () => {
    const response = await SELF.fetch("https://sendself.4oli.com/.well-known/assetlinks.json");

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("application/json");
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

  it("is cacheable metadata that still carries the site security policy", async () => {
    const response = await SELF.fetch("https://sendself.4oli.com/.well-known/assetlinks.json");

    expect(response.headers.get("Cache-Control")).toBe("public, max-age=300");
    expect(response.headers.get("Content-Security-Policy")).toContain("default-src 'self'");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });
});
