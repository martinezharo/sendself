# sendself

Let AI agents, scripts and servers send files and messages to your devices with [SendSelf](https://sendself.4oli.com), end-to-end encrypted like everything else in it.

```bash
npx -y sendself link <code>        # once: the code comes from the app
npx -y sendself send report.pdf    # from then on
```

It needs Node.js 20 or newer and nothing else. It links to one of your spaces as a **send-only device**: it shows up in the app's device list with a "Send only" badge, can be revoked there like any other device, and never receives anything. Everything is encrypted and signed on the machine that runs it, so the server only ever sees ciphertext.

## Set it up with your agent

In the SendSelf app, open **Devices → Add device → Agent** and press **Copy the setup prompt for your agent**. Paste it to your agent (Claude Code, Codex, Cursor or any agent that can run a command). It links the machine and remembers how to send you things. When it connects, the app asks you to approve it.

## Or link it yourself

Copy the command from the same screen and run it on the machine:

```bash
npx -y sendself link <code> --name "Build server"
```

It prints a short code, and the app shows the same one next to the machine's name: approve it there and the command finishes by itself. An invitation works once and expires after 10 minutes. `--name` defaults to the hostname.

Without an invitation, `sendself link` shows a QR code, plus the same code as text, for an owner or admin to scan or paste under **Devices → Add device**.

## Send

```bash
npx -y sendself send report.pdf                              # a file
npx -y sendself send -m "Nightly results" chart.png log.txt  # files with a caption, as one album
npx -y sendself send -m "Deploy finished"                    # a message
echo "Deploy finished" | npx -y sendself send                # a message from stdin
npx -y sendself send --view-once -m "one-time secret"        # deleted everywhere once opened
```

Files go up to 50 MiB each. Results go to stdout, errors to stderr, and the exit code is `0` on success, `1` on failure and `2` on wrong usage, so scripts and agents can rely on it.

`sendself status` shows the space, the device and the key epoch, and checks that the link still works. `sendself unlink` forgets the link on this machine; revoke the device in the app as well so the space stops trusting it.

## Where the link lives

The link is one file, `device.json`, in `$SENDSELF_HOME` (default `~/.config/sendself`). It holds the device's private keys, its bearer token and every space key it has been given, so it is as sensitive as an unlocked phone in the space. It is written with owner-only permissions (`0600` in a `0700` directory) and has no passphrase, because the CLI is meant to run unattended.

On a machine that can be rebuilt, point `SENDSELF_HOME` at storage that survives it. If the file is lost, link again. If it may have leaked, revoke the device in the app, which also rotates the space key.

## Key rotation

When a device is revoked, the space's key rotates and every remaining device, this one included, is handed the new key. The CLI picks it up before each send. It never performs a rotation itself: that means wrapping the new key for every device in the roster, which only a device that verifies the roster should do, so the app on your other devices does it.

## Development

The CLI lives in the SendSelf monorepo and shares its crypto and wire format with the app (`packages/client`). `pnpm --filter sendself build` bundles it into one self-contained file, `apps/cli/dist/sendself.mjs`.
