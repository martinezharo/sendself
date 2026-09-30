# sendself CLI

Send files and text to your SendSelf devices from a terminal, a script or an AI agent. Everything is encrypted and signed on the machine running the CLI, exactly as the app does it: the server only ever receives ciphertext.

The CLI joins a space once as a **send-only device**. It shows up in the app's device list with a "Send only" badge, can be revoked from there like any other device, and never receives anything: the server leaves it out of every message's recipients, so nothing waits on the server for it.

## Install

The CLI is bundled into one self-contained file that needs only Node.js 20 or newer:

```bash
pnpm install
pnpm --filter @sendself/cli build          # writes apps/cli/dist/sendself.mjs
ln -s "$PWD/apps/cli/dist/sendself.mjs" ~/.local/bin/sendself
```

## Link it to a space (once)

```bash
sendself link --name "VPS"
```

It prints a QR code and the same code as text. On a device that is already in the space as its owner or an admin, open **Devices → Add device** and scan the code, or choose **Paste code** and paste the text. The command finishes when the device has been added; the code expires after 10 minutes.

## Send

```bash
sendself send report.pdf                          # a file
sendself send -m "Build finished" out.png log.txt # files with a caption, shown as one album
sendself send -m "Deploy done"                    # text
echo "Deploy done" | sendself send                # text from stdin
sendself send --view-once -m "one-time secret"    # deleted everywhere once opened
```

Files are limited to 50 MiB each, like in the app. Results go to stdout, errors to stderr, and the exit code is `0` on success, `1` on failure and `2` on wrong usage, so scripts and agents can rely on it.

`sendself status` shows the space, the device and the key epoch, and checks that the link still works. `sendself unlink` forgets the link locally; revoke the device in the app as well so the space stops trusting it.

## Where the link lives

The link is one file, `device.json`, in `$SENDSELF_HOME` (default `~/.config/sendself`). It holds the device's private keys, its bearer token and every space key it has been given, so it is as sensitive as an unlocked phone in the space. It is written with owner-only permissions (`0600` in a `0700` directory) and has no passphrase, because the CLI is meant to run unattended.

On a machine that can be rebuilt, point `SENDSELF_HOME` at storage that survives it. If the file is lost, link again; if it may have leaked, revoke the device in the app, which also rotates the space key.

## Key rotation

When a device is revoked, the space's key rotates and every remaining device, this one included, is handed the new key. The CLI picks it up before each send. It never performs a rotation itself: that means wrapping the new key for every device in the roster, which only a device that verifies the roster should do, so the app on your other devices does it.
