/**
 * Generate the Web Push (VAPID) identity the Worker signs pushes with.
 *
 * Prints the two values to store as Worker secrets:
 *
 *   wrangler secret put VAPID_PUBLIC_KEY   (in apps/worker)
 *   wrangler secret put VAPID_PRIVATE_KEY
 *
 * Generate them once per deployment and keep them: every browser subscription
 * is bound to the public key, so replacing the pair silently stops pushes to
 * every subscribed device until it subscribes again (the app does that by
 * itself the next time it is opened).
 *
 * Run with: node scripts/generate-vapid-keys.mts
 */

const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
  "sign",
  "verify",
])) as CryptoKeyPair;

const publicKey = Buffer.from(await crypto.subtle.exportKey("raw", pair.publicKey)).toString(
  "base64url",
);
const { d } = await crypto.subtle.exportKey("jwk", pair.privateKey);

console.log(`VAPID_PUBLIC_KEY=${publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${d}`);
