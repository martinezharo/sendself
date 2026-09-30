# API reference

The Worker exposes a JSON API under `/api`. Request and response DTOs are defined in [`packages/shared/src/index.ts`](../packages/shared/src/index.ts), and the route registration is in [`apps/worker/src/index.ts`](../apps/worker/src/index.ts).

## Authentication

Authenticated HTTP routes use:

```http
Authorization: Bearer <device-auth-token>
```

The token belongs to one device. The Worker hashes the presented token and looks up the active device in D1; the raw token is not stored server-side.

Group creation and the pairing-slot routes are unauthenticated, but pairing request and polling depend on a random, short-lived pairing id and are rate-limited at the edge in production. All other routes require an active device token unless the table says otherwise.

The browser WebSocket API cannot set an `Authorization` header. For `GET /api/realtime`, the PWA sends the same token as the `fs-auth.<token>` WebSocket subprotocol. Non-browser clients may use the bearer header.

## Routes

### Bootstrap and pairing

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `POST` | `/api/groups` | None | Create a space and its first device. The client sends public material, an encrypted device name, and a token hash. |
| `POST` | `/api/pairing/:pairingId/request` | Pairing id | Reserve a slot and publish the joining device's public keys. |
| `POST` | `/api/pairing/:pairingId/complete` | Bearer; admin required | Verify the scanned keys, register the joining device, and store the wrapped pairing package. |
| `GET` | `/api/pairing/:pairingId` | Pairing id | Poll for the wrapped package. |
| `GET` | `/api/pairing/:pairingId/joiner` | Bearer; admin required | For an invitation: the keys, send-only flag and sealed name the joining device published, or `{ "present": false }`. Slots answered through a QR code are never shown. |
| `DELETE` | `/api/pairing/:pairingId` | Pairing id | Cancel a pairing slot. |

When the joining device answers an invitation rather than showing a QR code, the request body also carries `invite`: its name sealed with the invitation's secret over the keys it publishes (see [Security](security.md#pairing-by-invitation)). The server stores it opaquely.

The request body may set `"sendOnly": true` for a device that will only send, such as the CLI. The flag travels with the slot and is applied when the pairing completes; see [Send-only devices](architecture.md#send-only-devices).

Pairing slots are reaped after 10 minutes. The joining device receives the raw token and `GroupKey` only after it unwraps the package locally.

### Synchronization and files

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/realtime` | Bearer or `fs-auth.*` subprotocol | Upgrade to a WebSocket that receives contentless `{ "type": "sync" }` hints. |
| `GET` | `/api/messages/pending` | Bearer | Return messages pending for this device, pending rotated keys, the current key epoch, rotation status, and the shared space name. Accepts the optional `since=<timestamp>` query parameter. |
| `POST` | `/api/messages` | Bearer | Store encrypted message metadata or a signed global-delete tombstone and queue it for the other active devices that receive (every one except send-only devices). |
| `POST` | `/api/messages/:id/ack` | Bearer | Acknowledge delivery for this device. The message and R2 object are deleted when no active recipient remains pending. |
| `PUT` | `/api/files/:r2key` | Bearer | Store an already-encrypted file blob in R2. The request must provide a known `Content-Length`. |
| `GET` | `/api/files/:r2key` | Bearer | Stream an encrypted file blob from R2. |

The plaintext file limit is 50 MiB. The upload limit allows a small amount of overhead for the AES-GCM authentication tag. The server cannot interpret the file body.

The `since` parameter is accepted as a timestamp cursor, but the current client uses `0` and relies on pending delivery rows as the durable source of truth. It is not currently a safe replay/order cursor; see [TODO.md](../TODO.md).

### Keys and shared space state

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `POST` | `/api/keys/rotate` | Bearer | Commit a client-generated next `GroupKey` epoch after a revocation, with one wrapped key for every remaining device. |
| `POST` | `/api/keys/:epoch/ack` | Bearer | Adopt a pending wrapped key locally and remove its server-side delivery blob. |
| `PUT` | `/api/groups/self/name` | Bearer | Set or clear the shared space name. The name is encrypted by the client with the current `GroupKey`. |

### Device management

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/devices` | Bearer | List active devices, roles, public keys, attestations, key epochs, and whether each is send-only. |
| `POST` | `/api/devices/self/signing-key` | Bearer | Publish this device's ECDSA public key. It is set once and cannot be replaced. |
| `DELETE` | `/api/devices/:id` | Bearer; admin required | Revoke another device and mark the space for key rotation. The owner cannot be revoked; only the owner can revoke an administrator. |
| `PATCH` | `/api/devices/:id/role` | Bearer; owner required | Set another active device's role to `admin` or `member`. A send-only device cannot be made `admin`. Ownership transfer is not implemented. |

## Message contract

The server accepts encrypted text fields, an encrypted metadata envelope, an R2 object key, the key epoch, and an optional signature. A normal message must contain text, a file reference, or both. A tombstone sets `deletesMessageId` and carries no content fields.

The `fileMeta`/`fileMetaIv` pair is the message's whole metadata envelope (`MessageMeta` in the shared contract), not only an attachment's name and size: it also carries the album grouping and the view-once flag, so a message with no file at all can have one. The server never opens it. It requires only that the two travel together, and that a message with a file has one.

The Worker rejects a message encrypted under a superseded epoch. If a device has published a signing key, it must provide a signature; recipients perform the final cryptographic signature verification and may mark a tampered message invalid.

## Errors

API errors use this shape:

```json
{
  "error": {
    "code": "unauthorized",
    "message": "Missing bearer token"
  }
}
```

The main error codes are:

| Code | HTTP status | Meaning |
| --- | ---: | --- |
| `bad_request` | 400 | Invalid JSON, field, path, or protocol state. |
| `unauthorized` | 401 | Missing or invalid credentials. |
| `forbidden` | 403 | The device is authenticated but lacks the required role. |
| `device_revoked` | 403 | This device was revoked and must be paired again. |
| `not_found` | 404 | The resource does not exist or is not visible to this space. |
| `conflict` | 409 | The resource or protocol state changed concurrently. |
| `key_rotated` | 409 | The client must adopt the current key epoch before retrying. |
| `payload_too_large` | 413 | A request or file exceeds the configured limit. |
| `rate_limited` | 429 | A configured edge limiter rejected the request. |
| `internal` | 500 | An unexpected Worker failure. |
