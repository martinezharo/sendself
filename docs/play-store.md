# Google Play Store

SendSelf is published as an Android **Trusted Web Activity (TWA)**. Google Play
does not list PWAs directly: the AAB in [`apps/android`](../apps/android) wraps
the live site in the user's browser and keeps the same origin, so sessions,
IndexedDB history, keys, passkeys and the service worker keep working. There is
no second client to maintain.

## What is ready

- [`apps/android`](../apps/android): Gradle project, package
  `com.fourli.sendself`, `compileSdk`/`targetSdk` 36, minSdk 26.
- Digital Asset Links route in the Worker at
  `/.well-known/assetlinks.json`, generated from
  [`android.config.json`](../android.config.json).
- App Links filter with `autoVerify`, TWA splash screen, adaptive and themed
  icons, and an Android share-sheet entry that reuses the PWA share target.
- Play artwork: 512×512 icon, 1024×500 feature graphic and 1080×1920
  screenshots in [`apps/android/play`](../apps/android/play).
- Chromium installability and asset-links coverage in
  [`e2e/pwa-installability.spec.ts`](../e2e/pwa-installability.spec.ts).
- CI that builds a debug APK on pull requests and a signed AAB on demand
  (`.github/workflows/android.yml`).

## What it costs

- **Google Play Console registration: US$25, one-time.** This is the only
  mandatory payment. It is paid when the developer account is created.
- Everything else used here is free at this scale: Android SDK, Gradle, the
  Trusted Web Activity library and the existing Cloudflare hosting.
- A new **personal** developer account must run a closed test with **12 testers
  for 14 consecutive days** before it can apply for production. This costs time,
  not money. Organization accounts go through business verification instead.
- Google may require identity and address verification. That is free.

## Release sequence

### 1. Deploy the Worker first

The Android app verifies the site before it hides the URL bar. The route must be
live before installing a Play build:

```bash
pnpm run deploy
curl -s https://sendself.4oli.com/.well-known/assetlinks.json | jq .
```

The response must contain `com.fourli.sendself` and the **Play App Signing**
SHA-256, not only the upload key. The upload key is already in
`android.config.json` for sideloaded builds; Play re-signs uploaded bundles, so
its certificate is a different one.

### 2. Create the Play Console account

This is the payment step. Choose a personal or organization account, complete
verification, and keep the account owner's recovery details safe.

### 3. Create the app

- App name: **SendSelf**
- Default language: English (United States)
- App or game: App
- Free or paid: Free
- Package name: `com.fourli.sendself` (must match `android.config.json`; it is
  permanent after the first upload)

### 4. Upload the first AAB

Build it locally:

```bash
pnpm android:bundle
```

Upload `apps/android/app/build/outputs/bundle/release/app-release.aab` to
**Internal testing** (or **Closed testing**). Accept Play App Signing when
prompted.

Then open **App integrity → App signing key certificate**, copy its SHA-256
fingerprint, add it to [`android.config.json`](../android.config.json), and
redeploy the Worker. The list accepts several fingerprints, so keep the
upload-key one:

```bash
pnpm android:fingerprint "AA:BB:CC:…"
pnpm run deploy
```

Verify the association:

```bash
curl -s "https://digitalassetlinks.googleapis.com/v1/statements:list?source.web.site=https://sendself.4oli.com&relation=delegate_permission/common.handle_all_urls" | jq .
```

It must return the package and the Play certificate. On a device with the Play
build installed:

```bash
adb shell pm get-app-links com.fourli.sendself
adb shell pm verify-app-links --re-verify com.fourli.sendself
```

### 5. Test the real build

Install from the testing track, not from a sideloaded APK, and check:

- the app opens without a browser toolbar;
- a cold launch works offline after the first run;
- creating a space, pairing a second device and sending text and a file work;
- the share sheet lists SendSelf, and sharing text and a file lands in the
  space picker;
- passkey unlock works (it needs the verified App Link);
- Android Settings → Apps → SendSelf → Storage lets the user clear site data.

### 6. Closed testing, then production

For a new personal account, recruit 12 testers, keep the closed test running for
14 days, then apply for production access in Play Console. For an organization
account, follow the verification prompts instead.

### 7. Store listing

Copy the title, descriptions and declarations from
[`apps/android/play/listing.md`](../apps/android/play/listing.md). Upload:

| Asset | File | Requirement |
| --- | --- | --- |
| App icon | `apps/android/play/icon-512.png` | 512×512 PNG |
| Feature graphic | `apps/android/play/feature-graphic.png` | 1024×500 |
| Phone screenshots | `apps/android/play/screenshots/01…05.png` | 1080×1920 each |

Recommended order: first run, chat, devices, spaces, create space. Add 7-inch
and 10-inch screenshots later only if you want tablet placement.

## Play Console declarations

### App access

All functionality is available without an account or login. Pairing another
device is a peer-to-peer step, not a restricted account. Select **All
functionality is available without restrictions**.

### Ads, purchases, news

No ads, no in-app purchases, not a news app.

### Data safety

Follow Google's current
[Data safety definitions](https://support.google.com/googleplay/android-developer/answer/10787469#collection).
Content protected by end-to-end encryption is exempt from the collection
declaration when only the sender and recipient can decrypt it. This applies to
SendSelf's messages, files, file names, and encrypted device and space names.
The unencrypted delivery metadata and operational logs still need disclosure:

- **Data collected:** device or other IDs (random identifiers used for delivery,
  authentication and revocation), and diagnostics (hosting request/error logs).
- **Purpose:** app functionality and fraud prevention/security for identifiers;
  analytics for diagnostics, using Google's definition that includes diagnosing
  and fixing faults. There is no advertising or user-tracking SDK.
- **Encryption in transit:** yes.
- **Shared with third parties:** no.
- **Required:** device identifiers and operational diagnostics cannot be turned
  off independently of using the service. Neither is processed only in memory.
  The at-rest lock and recovery file are optional local features.
- **Camera:** frames are processed on-device for QR scanning and are not
  collected or transmitted. Data safety asks about collection, not permission
  use; do not declare camera footage as collected.
- **Deletion:** users can delete messages for everyone and clear local site data
  from Android settings. Leaving a space clears that device's local copy; it
  does not delete the server's space/device records. There is no account to
  delete. Undelivered content expires after 24 hours. The privacy policy's
  [Your choices and rights](https://sendself.4oli.com/privacy/#rights) section
  explains how to request deletion of server records.

Review the answers against
[privacy policy](https://sendself.4oli.com/privacy/) and the current code before
submitting; the form is a legal declaration, not a checkbox.

### Content rating

Complete the questionnaire as a utility with no developer-provided sensitive
content, no ads, and no public discovery or feed. Paired devices can exchange
user-generated text and files; access is invitation-only and a device can be
revoked. There is no reporting or chat moderation. Do not assume that the
utility category guarantees an Everyone/PEGI 3 rating.

The initial questionnaire returned ESRB Teen, PEGI Parental Guidance, USK 12,
and IARC 12+. Recheck the generated ratings if the answers or app change.

### Other declarations

- **Encryption:** the app uses standard HTTPS and application-level AES-GCM;
  complete the standard encryption self-classification.
- **Target audience:** 13 and older. The app is not designed for children and
  should not be listed in the Families program.
- **EU DSA:** if distributing in the EU, complete the trader/non-trader
  declaration. An individual publishing without commercial activity can declare
  non-trader status, with the consumer-protection consequences that implies.
- **Privacy policy:** `https://sendself.4oli.com/privacy/`.
- **Support contact:** `oliver@martinezharo.com`. This address is public on the
  store listing; the account's private contact phone number is not required.

## Versioning

Bump `sendselfVersionCode` for every upload (Play rejects a reused code) and set
`sendselfVersionName` to the public version:

```bash
apps/android/gradlew -p apps/android bundleRelease \
  -PsendselfVersionCode=2 -PsendselfVersionName=1.1.0
```

CI uses the Android workflow's `github.run_number` as the version code, which
increases for each new workflow run. Tag builds derive the version name from
`android-v<version>`; manual dispatches use the `version_name` input. Rerunning
an existing workflow run keeps its version code, so start a new run for a new
Play upload. If a local upload uses a higher code, account for it before the
next CI release.

Pushing the web app does not require a new Android build: the TWA loads the live
site. A new AAB is only needed when the wrapper itself changes (icon, package,
permissions, target SDK, share target).

## Known limitations

- **Web Push is not implemented yet** (`TODO.md`). The wrapper declares the
  notification delegation service, but the site never requests permission.
- **Share target on Android** requires a TWA provider that implements Chrome's
  share target support. The wrapper passes the declaration; if the provider does
  not support it, the browser PWA still receives shares.
- **Passkeys** require the Digital Asset Links document to be correct for the
  installed signing certificate. A sideloaded build and a Play build need their
  respective fingerprints in the list.
- **No Android-native UI** is added on purpose: the TWA keeps one implementation,
  one origin and no data migration.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Browser toolbar on launch | `assetlinks.json` reachable, package id matches, Play signing fingerprint present |
| App Links open in browser | `adb shell pm get-app-links com.fourli.sendself`; redeploy or reinstall after changing fingerprints |
| Share sheet has no SendSelf | install the Play/Chrome build, open the app once, check the manifest share target |
| Play rejects the AAB | `versionCode` reused, target SDK below 36, or signing key mismatch |
| CI release fails | repository secrets missing or `keystore.properties` accidentally committed |
