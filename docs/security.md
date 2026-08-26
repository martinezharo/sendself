# Security model

This document describes the security properties intended by the current implementation. It is not a formal protocol specification or an independent security audit. Read [TODO.md](../TODO.md) and [AUDIT.md](../AUDIT.md) for unresolved decisions.

## Security goals

SendSelf is designed to keep message and file contents out of the application server and to limit the damage caused by losing one device. It also aims to make tampering visible to recipient devices when the relevant signing identity is already trusted.

The model assumes that the user can trust the browser, operating system, device storage, and the JavaScript delivered by the application origin. A server or deployment that can replace the application code can potentially read plaintext while the app is running; application-level encryption cannot defend against a malicious client.

## Key material

| Material | Use | Where it lives |
| --- | --- | --- |
| `GroupKey` | AES-GCM 256 key for message text, file contents, the message metadata envelope, and shared space names. | Generated and unwrapped only in clients; stored by epoch in the local keyring. |
| Device ECDH key pair | P-256 key agreement for pairing and rotated-key delivery. | Private key stays on the device; the public key is published in the roster. |
| Device ECDSA key pair | P-256 signatures for messages, deletion tombstones, and device attestations. | Private key stays on the device; the public key is published once. |
| Device bearer token | Independent 256-bit API credential for one device. | Raw token is kept by the client; D1 stores only its SHA-256 hash. |
| At-rest vault key | Encrypts the local session, keyring, device keys, and content store when a lock is enabled. | Derived on unlock and held in memory only. |

The exact algorithm and statement formats are implemented in [`apps/web/src/crypto`](../apps/web/src/crypto), [`apps/web/src/db/atrest.ts`](../apps/web/src/db/atrest.ts), and [`packages/shared/src/index.ts`](../packages/shared/src/index.ts). AES-GCM additional authenticated data binds ciphertext to its message, file, or metadata context.

## Pairing and trust

Pairing uses an out-of-band QR code or text payload:

1. The joining device publishes its device id and public keys to a short-lived, unguessable pairing slot.
2. The existing device scans or receives the same public keys out of band and refuses to wrap a package if the slot differs from what it saw.
3. The existing device uses an ephemeral ECDH exchange to encrypt the current `GroupKey` and a newly generated bearer token for the joining device.
4. When signing identities are available, the package also carries the introducer's verified device roster. The introducer signs the joining device's public keys, and later devices verify that attestation instead of trusting an arbitrary roster returned by the server.

The first device is the root of the attestation chain. A first link still requires the user to verify the displayed code or text through the out-of-band channel; the project does not currently require a separate compare-the-numbers ceremony.

## Message authenticity and confidentiality

The server receives ciphertexts, not plaintext. A signed message covers the sender id, key epoch, message id, and every ciphertext/IV field. A recipient verifies the signature against the locally trusted device identity before persisting the message.

This prevents a server from silently changing a payload or re-attributing it to another already-known device. Devices that predate signing can publish a key on a later launch; until then, their messages are treated as unverifiable rather than forged. A signature that fails against a known key is surfaced as invalid.

The server assigns message timestamps, so timestamps are not signed. The current protocol also has no monotonic sender counter or receiver high-water mark. A relay can therefore replay, duplicate, or reorder valid ciphertexts without forging them. This is an open design item.

## Revocation and key rotation

Revocation has two layers:

1. The revoked device's bearer token stops authenticating immediately.
2. An active device rotates the `GroupKey` to a new epoch and deposits an ECIES-wrapped copy for each remaining device.

The server never sees the new unwrapped key. Existing devices keep older epochs so history and in-flight content remain readable, while new messages must use the current epoch. Rotation is serialized server-side so two devices cannot create competing current epochs.

Rotation is forward-only. A revoked device can still read content from epochs it already held, and it may have copied plaintext before revocation. If a device has been revoked before the rotation completes, the API denies its access, but the cryptographic boundary for future content is the new epoch.

## Delete for everyone

Global deletion is a signed tombstone, not a privileged server-side erase request from the UI. The tombstone signs a deletion-specific statement so a normal message signature cannot be replayed as a destructive command. When it arrives, the Worker removes the target row and R2 object if they still exist; each recipient then validates the tombstone and deletes its local copy.

The target message id is intentionally visible to the server. The feature is cooperative and cannot erase a file that a user has already exported, a device that never reconnects, or a modified client that ignores the tombstone.

## Temporary (view-once) messages

A temporary message is an ordinary message with `viewOnce` set inside its encrypted metadata envelope, and opening one emits the tombstone above. Two properties follow from putting the flag there rather than in a column of its own: the server cannot tell which messages are temporary, and it cannot strip the flag to make one persist, because the envelope is covered by `messageSignatureStatement`.

It inherits the limits of global deletion exactly, and adds none of its own guarantees. It is a UI affordance: it does not survive a screenshot, a modified client that ignores the tombstone, or a device that is opened and then killed before it can close. The interface is worded so it does not promise more than that.

## Local at-rest protection

Without a local lock, the browser profile contains the session credential, key material, decrypted messages, and cached files in a form accessible to code or software that can read that profile.

With a lock enabled, the vault derives keys from a passphrase/PIN using PBKDF2-SHA-256 (600,000 iterations by default) or from a passkey's WebAuthn PRF output. It seals the session and keyring and encrypts local message and file records. The unlock secret is never sent to the server and cannot be reset remotely; losing it costs that device's local copy, not the other devices in the space.

Record ids and timestamps remain available as local indexing metadata. Share-target hand-off files also spend a short period in cleartext Cache Storage while the service worker passes them to the app; this is a documented open trade-off.

An encrypted recovery export can restore the device identity and its held key epochs. The recovery file and its one-time displayed code are equivalent to full access to that device's spaces, so they must be protected together. A recovery export is also a snapshot: it cannot decrypt content written after a later key rotation unless it is refreshed.

## What the service can see

Application-level encryption does not hide metadata. Depending on the request and platform telemetry, the service can observe:

- Space, device, message, pairing-slot, and R2 object identifiers.
- Public ECDH/ECDSA keys, attestations, token hashes, and signatures.
- Ciphertext lengths, file sizes, IVs, request timing, server timestamps, and delivery state.
- That a message carries a metadata envelope and roughly how long it is — but not its contents, so not whether a message is temporary or which files were sent together.
- Which devices are active or awaiting delivery, and when a file or message is removed.
- Network and platform metadata such as source IP information and access timing, subject to the Cloudflare deployment and its logging configuration.

The service cannot decrypt message text, file contents, encrypted names, or the `GroupKey` from the application data it stores. That statement does not cover a compromised browser/device, malicious JavaScript served to the browser, or a user who exports plaintext.

## Known non-goals and limitations

- No protection for plaintext already seen by a revoked or compromised device.
- No replay or reorder protection yet.
- No hiding of message sizes, timing, device count, or other traffic metadata.
- No remote wipe guarantee, and temporary messages are the same cooperative mechanism rather than an exception to it.
- At-rest protection is opt-in and has no automatic inactivity lock.
- Local history and file caches currently have no automatic retention policy.
- Legacy devices without a published signing key can produce messages that are unverifiable rather than cryptographically authenticated.
