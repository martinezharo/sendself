# TODO — SendSelf

Open work only. Protocol and privacy trade-offs are recorded in [AUDIT.md](AUDIT.md);
the current implementation is described in [docs](docs/README.md).

## Transfers and history

- [ ] Design versioned chunked encryption and resumable uploads to reduce peak
  memory and finish large transfers after interruptions. Measure the existing
  wake-lock and background-upload behavior on physical iOS and Android devices first.
- [ ] Paginate local history and virtualize the chat together, preserving scroll
  anchoring, albums, notices, and search. The default retention period is forever.
- [ ] Show upload and download progress; transfers currently show a spinner.
- [ ] Add a bounded bulk operation for clearing history, reusing local deletion
  and queued tombstones rather than emitting an unbounded request per message.
- [ ] Decide how failed outbox entries should recover after a dead session is
  re-linked. Keep retries bounded and preserve pending global deletions.

## Security and lifecycle

- [ ] Design replay/order protection, including restored devices and gaps in a
  sender's sequence. Do not use message timestamps as an incremental sync cursor:
  pending delivery rows are authoritative, and edge clocks can arrive out of order.
- [ ] Choose an auto-lock policy that accounts for in-flight uploads and sync.
- [ ] Decide how to protect the temporary cleartext share-target stash and how to
  report shares exceeding its 100-file cap.
- [ ] Decide whether metadata padding is worth its bandwidth and latency costs.
- [ ] Add explicit ownership transfer, including recovery when the owner is lost.

## UI and coverage

- [ ] Add interaction tests for the composer, pairing, and lock screen, and tests
  for `state/lock.ts` orchestration. IndexedDB storage already has unit coverage.
- [ ] Extend the shared dialog focus handling to `Modal`, accounting for nested
  dialogs; only the full-screen note and image viewers currently trap focus.
- [ ] Add video previews; downloaded images already have thumbnails.
- [ ] Add date separators and delivery indicators to the chat.
- [ ] Allow renaming a device after pairing.
- [ ] Add camera switching and a torch control to the QR scanner where supported.
- [ ] Evaluate timed message deletion using the existing view-once/tombstone flow.
- [ ] Add localization; the app currently uses English.
- [ ] Document self-hosting configuration and limits beyond the existing Cloudflare
  deployment guide.

## Engineering

- [ ] Measure eager font loading before changing subsets or preload strategy.
- [ ] Enable `exactOptionalPropertyTypes` after reviewing optional-field contracts.
