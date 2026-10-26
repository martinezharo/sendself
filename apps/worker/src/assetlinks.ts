import androidConfig from "../../../android.config.json";

/**
 * Android Digital Asset Links for the Trusted Web Activity.
 *
 * Chrome verifies the app against this document before it hides the URL bar,
 * and Android uses the same file for App Links verification. It is served by
 * the Worker rather than kept as a static asset so the package id and signing
 * fingerprints live in one place: android.config.json, which the Android build
 * reads too.
 */

export const ASSETLINKS_PATH = "/.well-known/assetlinks.json";

export function assetLinks(): Response {
  const statements = [
    {
      relation: ["delegate_permission/common.handle_all_urls"],
      target: {
        namespace: "android_app",
        package_name: androidConfig.packageId,
        sha256_cert_fingerprints: androidConfig.sha256CertFingerprints,
      },
    },
  ];

  return new Response(JSON.stringify(statements), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      // Public, cacheable metadata that only changes on a release. Keep it short
      // enough that a corrected fingerprint goes live without a long wait.
      "Cache-Control": "public, max-age=300",
    },
  });
}
