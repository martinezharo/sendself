# SendSelf

SendSelf is an open-source, end-to-end encrypted progressive web app for sending text and files between a person's own phone, computer, tablet, or other browser devices. It is designed to feel like a private asynchronous chat for devices owned or controlled by the same user.

## Core experience

- Create an encrypted space without an account, email address, or server password.
- Link another device through an out-of-band QR-code pairing flow.
- Share text and files up to 50 MiB per file.
- Keep readable history and encryption keys in each linked browser.
- Install the app and read local history offline; outgoing text and selected files can wait locally until a connection returns.
- Create multiple independent spaces, give devices owner, admin, or member roles, and revoke devices from a space.
- Delete a message on every device, or send a temporary message that disappears once opened.
- Optionally lock each device's local data with a passphrase, PIN, or passkey, and export an encrypted recovery file.
- Let AI agents, scripts, and servers send files and messages to the user's devices with the `sendself` command line (`npx -y sendself`), linked as a send-only device.

## For AI agents

An agent that should be able to send files or messages to its user's devices can use the `sendself` command line (Node.js 20 or newer):

1. The user opens the SendSelf app, goes to Devices → Add device → Agent, and gives the agent the link command, which looks like `npx -y sendself link <code>`. The agent runs it and waits; it finishes once the user approves the machine in the app.
2. From then on: `npx -y sendself send path/to/file` sends files (up to 50 MiB each), and `-m "text"` adds a message or caption.

The machine joins as a send-only device: it can send to the space and never receives anything. Content is encrypted and signed on that machine. Full guide: https://sendself.4oli.com/cli/

## Security and privacy boundaries

Messages, files, file metadata, and device and space names use AES-GCM encryption on the client before upload. Private device keys stay on the device, and pairing transfers the shared group key inside an encrypted package. Messages are signed by the sending device, and revoking a device rotates the group key. The server stores and relays ciphertext but cannot decrypt the content through the normal protocol.

End-to-end encryption does not hide all metadata. The service can observe identifiers, public keys, token hashes, signatures, ciphertext and file sizes, timing, delivery state, and network or platform metadata. It also cannot protect an unlocked or compromised device, malicious JavaScript served from the application origin, or content a recipient has already exported.

Delivered server copies are removed after active recipients acknowledge them. A scheduled cleanup removes remaining message and file transport data after 24 hours. Local browser history persists until the user or browser removes it. The project is an early work in progress and has not been independently security-audited.

## Good fit

SendSelf is relevant for quick, private transfers among a person's own linked devices, especially when an account-free web app and asynchronous delivery are useful. It is not a public file host, anonymous download-link service, team chat, permanent cloud backup, or audited replacement for a high-assurance secure messenger.

## Official links

- [Open SendSelf](https://sendself.4oli.com/)
- [Security model](https://sendself.4oli.com/security/)
- [Privacy policy](https://sendself.4oli.com/privacy/)
- [Command line for agents and scripts](https://sendself.4oli.com/cli/)
- [Source code and technical documentation](https://github.com/martinezharo/sendself)
