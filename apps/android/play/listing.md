# Play Store listing copy

Use these strings in Play Console. They are written for the default English
(United States) listing; translate them if the listing is localized.

## App name (30 characters max)

```
SendSelf — Private Sharing
```

## Short description (80 characters max)

```
Encrypted text and file sharing between your own devices. No account needed.
```

## Full description (4000 characters max)

```
SendSelf is a private space for everything you need to move between your own phone, tablet and computer.

Send text, links and files up to 50 MiB. Everything is encrypted on your device before it is uploaded with AES-GCM, so the service can deliver your content but cannot read it. There is no account, no password to remember and no plaintext stored on the server.

HOW IT WORKS
• Create a private space on one device.
• Add your other devices by scanning a QR code — the shared key travels in an encrypted pairing package.
• The space works like a calm, asynchronous chat: send now, and the other device catches up when it is online.
• Message contents, files and file names are encrypted on your devices.

BUILT FOR YOUR OWN DEVICES
• No public profiles, followers or feed.
• No ads and no tracking SDKs.
• Device roles, revocation and key rotation when a device leaves.
• An optional local lock protects the copy on a shared computer.
• An optional recovery file can restore the space if every device is lost.

PRIVATE BY DEFAULT
• Your device keys are generated locally and never sent to the server.
• The server stores ciphertext and the minimum metadata needed to deliver it; it cannot decrypt messages or files.
• Message and file copies on the server are removed after 24 hours; space and device metadata remains so your devices can reconnect.
• Content is encrypted in transit. The optional local lock encrypts the copy stored in the browser profile.

WORKS EVERYWHERE
SendSelf is a progressive web app. Install it from your browser for a standalone window, offline access to your local history and, on Android, a share-sheet entry so any app can send to your space. A command-line client is also available for servers, scripts and AI agents.

LIMITS, STATED PLAINLY
• Files up to 50 MiB each.
• Server-side delivery is asynchronous, not a real-time call.
• The service necessarily sees IP addresses, timing, ciphertext sizes and the number of devices. The project is not independently security-audited; the threat model and limitations are documented in the repository.

SendSelf is open source. The source code, security model and issue tracker are at github.com/martinezharo/sendself.
```

## Categorization

- Category: **Productivity**
- Tags: file sharing, encryption, privacy
- Contact website: `https://sendself.4oli.com`
- Privacy policy: `https://sendself.4oli.com/privacy/`
- Support email: `oliver@martinezharo.com`.
- Support URL: `https://github.com/martinezharo/sendself/issues`

## Graphics

| Slot | File |
| --- | --- |
| App icon | `icon-512.png` |
| Feature graphic | `feature-graphic.png` |
| Phone screenshot 1 | `screenshots/01-first-run.png` |
| Phone screenshot 2 | `screenshots/03-chat.png` |
| Phone screenshot 3 | `screenshots/05-devices.png` |
| Phone screenshot 4 | `screenshots/04-spaces.png` |
| Phone screenshot 5 | `screenshots/02-create-space.png` |

The screenshots are 1080×1920 (9:16), generated from the real app by
`pnpm android:play-assets`. The feature graphic is 1024×500.

## What not to claim

- Do not promise push notifications with the app closed; they are not
  implemented yet.
- Do not describe the service as anonymous: it necessarily sees IP addresses,
  timing, sizes and the number of devices.
- Do not claim the app is audited. It is not independently audited.
