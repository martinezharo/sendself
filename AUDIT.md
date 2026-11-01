# Deep Audit — Deferred Design Decisions

Date: 2026-08-07

This audit records findings that were intentionally not changed because the
correct fix depends on a product, protocol, privacy, or compatibility decision.
Low-risk correctness, security, and performance fixes from the same review are
already implemented in the commits on this branch.

## Findings left open

### 1. Replay and message ordering

The current authenticated message format proves the sender and the signed
content, but it does not prove ordering or freshness. A relay that can replay,
duplicate, or reorder ciphertext can therefore affect the receiver's view of
the conversation without forging a signature.

Closing this requires a protocol decision: for example, a per-sender
monotonic counter included in the signed statement, durable receiver-side
high-water marks, and a policy for gaps, restored devices, and multi-device
convergence. This was not added speculatively.

### 2. Share-target cleartext lifetime

The browser share-target hand-off temporarily stores received files in a
dedicated Cache Storage namespace before the application consumes them. The
namespace is now bounded, cleared before replacement, and cleared again after
consumption, but the bytes remain cleartext during that short hand-off window.

Encrypting the stash, shortening its lifetime further, or rejecting shares
while the app is locked are different UX and recovery choices. The current
implementation keeps the hand-off reliable and leaves that trade-off open.

The stash also has a defensive maximum of 100 files. Whether excess files
should be truncated, rejected, or surfaced as an explicit user warning is a
product decision; the current bounded behavior avoids unbounded browser storage.

### 3. At-rest lock policy

The lock is available on launch and on demand, and writes are now blocked while
it is active. Automatic locking after inactivity is intentionally not enabled:
a timer can interrupt an upload or a synchronization transaction, while a
longer timeout weakens the protection. The timeout, warning, and in-flight
operation policy should be chosen together before implementing auto-lock.

### 4. Metadata privacy

End-to-end encryption does not hide request sizes, ciphertext metadata, timing,
or the number of active devices from the service. Padding ciphertexts into
size buckets, delaying or batching operations, and reducing device-level
observability all have bandwidth, latency, and operational consequences. The
threat-model and padding policy should be agreed before changing the wire
format.

### 5. Streaming encryption and resumable transfers

File encryption and decryption currently operate in memory, with the 50 MB
file limit bounding the worst case. Moving to chunked encryption would reduce
peak memory and enable resumable uploads, but it requires a versioned file
format, chunk authentication, retry semantics, cleanup rules, and a migration
plan. The upload endpoint therefore keeps its current known-length contract.

### 6. Local history retention and sync indexing

Resolved for retention and outbox indexing: each device can choose to keep the
last month to year of history (default: forever, so nothing changes unless the
user asks); the cleanup is local only, removes cached files with their
messages, and never removes an outgoing message that has not been delivered.
The outbox reads an index of queued ids instead of scanning the history. The
chat itself still loads the full history (see §7).

Similarly, the existing `since` query parameter is not wired to a timestamp:
pending delivery rows already identify undelivered messages. A safe incremental
cursor needs a monotonic server sequence rather than the edge-assigned wall
clock timestamp, plus recovery behavior for gaps and restored devices.

### 7. Long conversation rendering

The chat view renders the current history rather than using windowed
virtualization. Virtualization and paginated history would improve long-lived
spaces, but they affect scroll anchoring, message insertion, date separators,
search, and read position. Those behaviors should be specified together.

### 8. Notifications and ownership lifecycle

Web Push is implemented: opt-in per device, a contentless payload encrypted to
the browser, subscriptions removed on revocation, on leaving a space and when
the push service reports them gone, and no push to a device with the space on
screen. Explicit ownership transfer remains a roadmap feature that needs
decisions about administrator authority and failure when the original owner
disappears.

## Verification of the implemented changes

- `pnpm lint`
- `pnpm typecheck`
- `pnpm test` — 100 web tests and 282 Worker tests
- `pnpm build` — production, service worker, SSR, and prerender builds
- `pnpm audit` — no known vulnerabilities after the toolchain updates
- Chromium CDP smoke test against the production preview for `/` and `/app`;
  both rendered successfully with no page exceptions or console errors.

The D1 cleanup changes use bounded batches in line with Cloudflare's documented
limits and batch execution model:
<https://developers.cloudflare.com/d1/platform/limits/> and
<https://developers.cloudflare.com/d1/worker-api/d1-database/>.
