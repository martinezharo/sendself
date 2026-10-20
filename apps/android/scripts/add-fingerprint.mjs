/**
 * Add a certificate fingerprint to android.config.json.
 *
 * Play re-signs the uploaded bundle, so the fingerprint from Play Console's
 * "App signing key certificate" has to be added after the first upload:
 *
 *   pnpm android:fingerprint "AA:BB:…"
 *
 * The upload-key fingerprint is already present for sideloaded release builds.
 */

import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const configPath = resolve(here, "../../../android.config.json");
const fingerprint = (process.argv[2] ?? "").trim().toUpperCase();

if (!/^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(fingerprint)) {
  console.error("Usage: pnpm android:fingerprint AA:BB:CC:… (32 SHA-256 bytes, colon-separated)");
  process.exit(1);
}

const config = JSON.parse(await readFile(configPath, "utf8"));
config.sha256CertFingerprints ??= [];
if (!config.sha256CertFingerprints.includes(fingerprint)) {
  config.sha256CertFingerprints.push(fingerprint);
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  console.log(`Added ${fingerprint} to android.config.json`);
} else {
  console.log(`${fingerprint} is already in android.config.json`);
}

console.log("Redeploy the Worker so /.well-known/assetlinks.json serves it.");
