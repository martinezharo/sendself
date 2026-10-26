# Android (Trusted Web Activity)

This directory is the Play Store wrapper for the PWA. It is a
[Trusted Web Activity](https://developer.chrome.com/docs/android/trusted-web-activity/):
a small Android app that opens `https://sendself.4oli.com` in the user's browser
without browser UI. The web app remains the only implementation; this module
only adds the Android shell, the launcher icon, the splash screen and the share
sheet entry.

## Configuration

`../../android.config.json` is the single source of truth shared by this
project and the Worker:

| Field | Used by |
| --- | --- |
| `packageId` | Android `namespace`/`applicationId` and `assetlinks.json` |
| `host` | App Links intent filter and `assetlinks.json` |
| `startUrl` | TWA default URL and the Manage Space URL |
| `sha256CertFingerprints` | `assetlinks.json` only |

The upload key fingerprint is already listed so sideloaded release builds verify.
**Play re-signs the app with its own app-signing key**, so after the first upload
copy the SHA-256 from Play Console → App integrity into this file and redeploy
the Worker as well. Until then, the Play-installed app shows the browser toolbar
and its App Links do not verify.

## Prerequisites

- JDK 17 (AGP 9.4 requires it).
- Android SDK with `platforms;android-36` and `build-tools;36.0.0`.
- The upload keystore, kept outside the repository.

On this machine the toolchain is under `~/.cache/sendself/jdk-17*` and
`~/android-sdk`; CI installs its own.

## Build

```bash
pnpm android:debug    # APK, debug-signed, no keystore needed
pnpm android:bundle   # signed AAB for Play
```

The AAB is written to `app/build/outputs/bundle/release/app-release.aab`.

Signing is read from `apps/android/keystore.properties` (git-ignored) or from
`SENDSELF_KEYSTORE_PATH`, `SENDSELF_KEYSTORE_PASSWORD`, `SENDSELF_KEY_ALIAS` and
`SENDSELF_KEY_PASSWORD`. The local upload key and its password file live in
`~/.config/sendself/`; back up both, and never commit them.

The version is `sendselfVersionCode` / `sendselfVersionName` in
`gradle.properties`, overridable with `-PsendselfVersionCode=2`.

## Play App Signing fingerprint

After the first upload, Play Console shows the app-signing certificate under
**App integrity**. Add it without editing JSON by hand:

```bash
pnpm android:fingerprint "AA:BB:CC:…"
pnpm run deploy
```

The upload-key fingerprint stays in the list so sideloaded release builds keep
verifying.

## Store assets

```bash
pnpm android:icons        # launcher mipmaps + play/icon-512.png
pnpm android:play-assets  # feature graphic + phone screenshots
```

`play/` contains the 512×512 icon, the 1024×500 feature graphic and 1080×1920
screenshots. `scripts/capture-play-assets.mjs` drives the built PWA against a
temporary local Worker, so the screenshots are the real app rather than mockups.

## What the APK declares

Only `android.permission.INTERNET` plus an AndroidX signature-level receiver
permission. Camera, clipboard and file access belong to Chrome and are requested
by the web app at the moment they are used; the wrapper never asks for them.
This is checked in `docs/play-store.md`.

## Changing the package name

The package id is permanent once uploaded. If it must change before the first
upload, update `packageId` and `startUrl`/`host` in `android.config.json`, move
`app/src/main/java/com/fourli/sendself/LauncherActivity.java` to the matching
package path and update its `package` declaration, then rebuild. The Worker and
the Android build both read the same config, so `assetlinks.json` follows
automatically.

## Share target

The launcher activity registers `ACTION_SEND`/`ACTION_SEND_MULTIPLE` and passes
the same `share_target` declaration as the PWA manifest to Chrome
(`METADATA_SHARE_TARGET`). Chrome performs the multipart POST to
`/share-target`, which the service worker already handles. Support depends on the
TWA provider; if it is unavailable, sharing still works through the browser PWA.

## CI

`.github/workflows/android.yml` builds a debug APK on pull requests that touch
this directory, and a release AAB on `android-v*` tags or manual dispatch. The
release job needs these repository secrets:

- `ANDROID_KEYSTORE_BASE64` — `base64 -w0 ~/.config/sendself/android-upload.keystore`
- `ANDROID_KEYSTORE_PASSWORD`
- `ANDROID_KEY_ALIAS` (`sendself-upload` for the generated key)
- `ANDROID_KEY_PASSWORD`

The passwords are the values in
`~/.config/sendself/android-upload.properties`; read them from there rather
than copying them into a commit, issue or chat.

See [the Play Store guide](../../docs/play-store.md) for the full release
sequence and the Play Console declarations.
