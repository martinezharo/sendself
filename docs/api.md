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
| `GET` | `/api/groups/challenge` | None | `{ "siteKey": string \| null }`: the Turnstile site key a client must solve before creating a space, or `null` when the deployment asks for no challenge. |
| `POST` | `/api/groups` | None; challenge if configured | Create a space and its first device. The client sends public material, an encrypted device name, a token hash and, when the deployment has a challenge, `challengeToken` (a Turnstile token for the `create-space` action). |
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

Each space may hold at most 2 GiB of uploaded blobs at once (`SPACE_PENDING_BYTES_QUOTA`), counted from the declared `Content-Length` before anything is written. Bytes are released when the blob is deleted: on full delivery, when its message is deleted, or by cleanup. An upload over the cap is refused with `quota_exceeded`, which clients treat as transient. An uploaded blob that no message references after an hour is discarded by the hourly cleanup.

The `since` parameter is accepted as a timestamp cursor, but the current client uses `0` and relies on pending delivery rows as the durable source of truth. It is not currently a safe replay/order cursor; see [TODO.md](../TODO.md).

### Keys and shared space state

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `POST` | `/api/keys/rotate` | Bearer | Commit a client-generated next `GroupKey` epoch after a revocation, with one wrapped key for every remaining device. |
| `POST` | `/api/keys/:epoch/ack` | Bearer | Adopt a pending wrapped key locally and remove its server-side delivery blob. |
| `PUT` | `/api/groups/self/name` | Bearer | Set or clear the shared space name. The name is encrypted by the client with the current `GroupKey`. |

### Vault

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/vault?since=<cursor>` | Bearer | Every vault change after `cursor`, oldest first: changed items, ids purged for good, the new `cursor`, `more` when another page follows, `reset` when the cursor is too old to be answered incrementally, and the vault's usage. |
| `POST` | `/api/vault/items` | Bearer | Create a folder, note or file. A note or file names a blob already uploaded to `/api/vault/blobs`. |
| `PATCH` | `/api/vault/items/:id` | Bearer | Rename (new `meta`), replace a note's content (new `blobKey` with its `meta`), move (`parentId`), trash or restore (`trashed`). Must name the item's current `revision`, otherwise `conflict`. |
| `DELETE` | `/api/vault/items/:id` | Bearer | Purge an item for good, with everything nested in it and their blobs. |
| `POST` | `/api/vault/reseal` | Bearer | Replace the `meta` of up to 100 items sealed under an older key epoch with `meta` sealed under the current one. An item edited since its `revision` is skipped. |
| `PUT` | `/api/vault/blobs/:r2key` | Bearer | Store an encrypted vault blob in the `VAULT` bucket. Same limits as `/api/files`. |
| `GET` | `/api/vault/blobs/:r2key` | Bearer | Stream an encrypted vault blob. |

Every active device can use the vault, send-only ones included. The server never opens `meta`; it checks that metadata is sealed under the space's current key epoch (otherwise `key_rotated`), that a parent is a live folder of the same space, that a move does not put a folder inside itself, and that one blob belongs to at most one item.

Each vault holds at most 1 GiB of blobs (`VAULT_BYTES_QUOTA`, pending uploads included) and 10,000 items (`VAULT_MAX_ITEMS`); either cap answers `quota_exceeded`, which unlike the pending quota does not clear by waiting. A blob no item claims within an hour is discarded. Trashed items are purged after 30 days; a purged item leaves a contentless tombstone for 90 days so devices that were offline learn to drop it.

`GET /api/messages/pending` also returns `vaultSeq`, the vault's change counter, so a device only asks `/api/vault` when it moved. Vault writes notify the space's other devices over the realtime socket but never send a push.

### Device management

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/devices` | Bearer | List active devices, roles, public keys, attestations, key epochs, and whether each is send-only. |
| `POST` | `/api/devices/self/signing-key` | Bearer | Publish this device's ECDSA public key. It is set once and cannot be replaced. |
| `DELETE` | `/api/devices/:id` | Bearer; admin required | Revoke another device and mark the space for key rotation. The owner cannot be revoked; only the owner can revoke an administrator. |
| `PATCH` | `/api/devices/:id/role` | Bearer; owner required | Set another active device's role to `admin` or `member`. A send-only device cannot be made `admin`. Ownership transfer is not implemented. |

### Notifications

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/push` | Bearer | Return the server's VAPID public key (`null` when push is not configured) and the endpoint this device is subscribed with. |
| `PUT` | `/api/push` | Bearer | Store or replace this device's browser push subscription (`endpoint`, `p256dh`, `auth`). The endpoint must belong to a known browser push service. |
| `DELETE` | `/api/push` | Bearer | Remove this device's subscription. Revoking a device removes it too. |

When a message is stored, every recipient without the space on screen gets a Web Push whose encrypted payload is `{ "type": "message", "groupId": "…" }` and nothing else. A client reports whether the space is on screen by sending `visible` or `hidden` over its real-time socket; a socket that says neither counts as on screen. Deletions, renames and key rotations never trigger a push.

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
| `quota_exceeded` | 413 | The space already holds as many undelivered bytes as it may. Retry once other devices have downloaded them. |
| `challenge_failed` | 403 | The space-creation challenge was missing, expired, or failed. |
| `rate_limited` | 429 | A configured edge limiter rejected the request. Clients also read a bare 429 without a JSON body (from a Cloudflare WAF rule) as this code. |
| `internal` | 500 | An unexpected Worker failure. |
