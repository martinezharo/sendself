# TODO — SendSelf

> Remaining work only. Anything that is done has been removed from this file:
> the crypto and authorization model is documented in docs/security.md, and the
> reasoning behind each change lives in its commit.
>
> Legend: 🔴 critical · 🟠 important · 🟡 improvement · 🔵 nice-to-have
> Effort: ⚡ quick · 🛠️ medium · 🏗️ large

---

## 0. Priorities / next up

Biggest remaining items (need design decisions, don't do blindly):

- **Resumable/chunked uploads** 🟡🏗️ (§7). The screen-off stall now has a wake lock and a
  time-budgeted background pass, but a single large file still has to finish in one request —
  and on iOS, where the service worker outlives the page by seconds, nothing short of
  chunking lets it finish after the screen goes off. Verify the new behaviour on a real
  iPhone and a real Android phone before deciding how far to go.
- **Replay/reorder protection** 🟡🛠️ (§1).

---

## 1. Security

- [ ] 🟡🛠️ **No replay/reorder protection.** The server could resend, duplicate or reorder messages: a signature proves *what* was sent, not *when* or *in what order*. Now cheap to close — the signing key is already there, so it is a per-device monotonic counter inside the signed statement (and a receiver-side "highest seen" per sender). Documented in [docs/security.md](docs/security.md) meanwhile.
- [ ] 🔵🛠️ **Shared files sit in Cache Storage in clear** until `consumeSharedContent` drains them. The dedicated stash is now replaced and cleared more aggressively; encrypting the hand-off remains a design decision (see `AUDIT.md`).

## 2. Privacy

- [ ] 🟡⚡ **The at-rest lock is opt-in and has no auto-lock.** It locks on launch and on demand, never on a timer or after inactivity. Worth revisiting once there is data on how people actually use it; a timeout that fires mid-upload would be worse than no timeout.
- [ ] 🟡🏗️ **Server-observable metadata:** sizes (via `Content-Length` and metadata length), timing, device count. For sizes, consider padding the ciphertext to buckets. Explicitly document what the server sees.

## 3. Performance

- [ ] 🔵⚡ **The safety-net poll is a fixed 60 s** while the socket is up. It could back off further (or stop while the tab is hidden and a notification would wake it anyway), but only once there is evidence about how often a notification is actually lost.
- [ ] 🟡⚡ **Dead `since` cursor — needs a design decision, not a blind wire-up.** `apps/web/src/sync/sync.ts` always calls `api.pendingMessages(auth)` with `since=0`. On inspection this isn't just an unused optimization: the worker query (`apps/worker/src/routes/messages.ts`) already scopes results via `ds.device_id = ? AND ds.downloaded_at IS NULL` (backed by `idx_delivery_device_pending`), so every row returned is, by definition, still pending for this device — `since` currently adds nothing. Naively wiring it to "last acked `createdAt`" would filter on `m.created_at`, which is a wall-clock timestamp assigned by whichever edge Worker handled `sendMessage`; under clock skew/out-of-order arrival across colos, a message from another device could land with a `created_at` at or before the cursor and get **silently filtered out and never delivered**. If this is worth doing, it needs a monotonic cursor (e.g. an auto-increment `rowid`/sequence) instead of `created_at`, which is a real design decision — left for §0.
- [ ] 🟡⚡ **Measure the screen-off upload fixes on real devices.** The page now holds a screen wake lock while a file is uploading (`sync/wakeLock.ts`), and a background pass keeps sending one file per space per round for up to 60 s before handing over to a fresh `sync` (`sw.ts`, `BACKGROUND_PASS_BUDGET_MS`). Neither has been measured on a physical iPhone/Android yet; if a selection still stalls after the user turns the screen off, the remaining fix is chunked uploads (§7).
- [ ] 🟡🛠️ **One-shot in-memory file crypto.** `encryptFile`/`decryptFile` load the whole file + ciphertext + decrypted copy (up to ~3×50 MB) into RAM. Move to chunked/streaming crypto for low-end phones and to be able to raise the size limit.
- [ ] 🟡🛠️ **Heavy initial bundle.** `jsqr`, `qrcode` and the scanner are now lazy-loaded for pairing; the 3 variable font families (`bricolage`, `hanken`, `jetbrains-mono`) are still loaded eagerly in `main.tsx`. Subset or selectively preload fonts if the remaining cost is significant.
- [ ] 🔵🛠️ **Chat list not virtualized** (`Chat.tsx`): full re-render. Virtualize for long histories.
- [ ] 🔵🟡 **Base64 ciphertext in D1** (up to 1 MB per `encryptedPayload`) bloats the database. Acceptable, keep an eye on it.
- [ ] 🔵🛠️ **The chat still loads the whole local history into memory** on every space open (`loadMessages` → `allMessages()`). The outbox no longer does (it reads an index of queued ids, `queuedMessages`), and a per-device retention period now bounds growth when the user picks one — but the default is "forever", so a long-lived space still pays this. The fix is pagination, together with the virtualization item above.

## 4. Best practices / tooling

- [ ] 🟡🛠️ **No component tests** in the PWA (crypto, the vault, at-rest storage, the outbox and the Worker are covered). Add `@testing-library/preact` for key flows (composer, pairing, lock screen, message rendering).
- [ ] 🟡🛠️ **No tests for `db/store.ts` or `state/lock.ts`.** Both need a fake IndexedDB (`fake-indexeddb`); the crypto underneath them is covered, the wiring that turns a lock on and off is not.
- [ ] 🟡⚡ **Confirm the committed `database_id`** in `wrangler.jsonc` (`05e8acfd-…`). The comment says "replace"; if it is the real prod id, fine (not secret), but document it to avoid confusion.
- [ ] 🔵⚡ **`exactOptionalPropertyTypes: false`** in `tsconfig.base.json`. Enabling it hardens optional handling (may need minor adjustments).
- [ ] 🔵⚡ `sha256Hex` duplicated (worker `auth.ts` / web `crypto.ts`): unavoidable due to different runtimes, noted for the record. The Worker's copy is now pinned to a known digest by `auth.test.ts`, so the two cannot drift silently.

## 5. Refactoring

- [ ] 🟡🛠️ **`processIncoming` mixes responsibilities** (create local, download, ack). Split into smaller functions.
- [ ] 🟡🛠️ **`actions.ts` is a grab-bag** (onboarding + pairing + messaging + files + session). Split by domain.
- [ ] 🔵⚡ **The outbox uploads one message at a time.** `flushQueuedOutbox` walks the queue in a plain loop, so a selection of five files is five round trips end to end. Acceptable (it avoids overloading a phone's uplink, and it is what keeps each file independently resumable), but it could run a small concurrency limit — see the note in §3 before changing the shape of a pass.

## 6. UI / UX / Accessibility

- [ ] 🟡🛠️ **No image/video previews.** Everything renders as a generic file card. Render inline thumbnails/previews from the decrypted blob (`URL.createObjectURL`).
- [ ] 🟡🛠️ **No real upload/download progress** for large files (spinner only). Show %.
- [ ] 🟡🛠️ **No "clear history".** Single-message delete now exists in both flavours (this device / all devices), but there is no way to wipe a whole conversation in one go. The tombstone pipeline is the mechanism; what it needs is a bounded batch form, since one tombstone per message does not scale to a year of history.
- [ ] 🟡🛠️ **No date separators** in the chat (time only). Group by day.
- [ ] 🔵⚡ **`Modal` has no full focus trap** (Escape + focus restore are done). Trap Tab within the dialog.
- [ ] 🔵⚡ **Rename a device** after creation: doesn't exist.
- [ ] 🔵⚡ **Delivery/read indicators.** The server already has `delivery_status`; could show "delivered to N devices".
- [ ] 🔵⚡ **QR scanner** has no torch/camera switch.
- [ ] 🔵⚡ **No manual theme toggle** (system `dark:` only). Optional.
- [ ] 🟡🛠️ **A dead session marks its queue `failed`.** When a flush hits `unauthorized`/`device_revoked` the messages in flight are marked permanently failed, and re-linking the device does not bring them back — the user has to find each bubble. Leaving them `queued` and stopping the pass would let a new session resume them, but it needs a bound: a device that is never re-linked would keep a queue forever. Decide before changing (`isRetriable` in `apps/web/src/sync/outbox.ts`).

## 7. Features (roadmap "next level")

- [ ] 🟡🛠️ **Ownership transfer.** Add an explicit, confirmed hand-off to another admin before the owner leaves. (Recovering a permanently lost owner is now covered by the recovery file, which restores that device's identity, role included.)
- [ ] 🟡🏗️ **Resumable/chunked uploads** and raise the 50 MB limit. Also the eventual fix for the background-send stall in §3, and the only thing that would make any form of message-level file grouping safe.
- [ ] 🔵🛠️ **Self-destruct timers** per message. Time-based, and it should layer on the view-once mechanism that now exists (`viewOnce` in the encrypted `MessageMeta` envelope, consumed into a global-delete tombstone) rather than growing a second pipeline beside it.
- [ ] 🔵🛠️ **i18n** (the app is English-only; at least ES/EN).
- [ ] 🔵🛠️ **Self-hosting** docs and configuration (BASE_URL, limits).

## 8. Documentation / observability

- [ ] 🔵⚡ Review that the Worker's observability (`observability.enabled`) **doesn't log** sensitive material (today `console.error` for unhandled errors; correct, keep watching). `index.test.ts` pins the shape of the 500 response so an internal message can never reach the client.
