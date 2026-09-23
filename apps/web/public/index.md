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
- [Source code and technical documentation](https://github.com/martinezharo/sendself)
