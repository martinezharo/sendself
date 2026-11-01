-- Web Push subscriptions: where to wake a device whose app is closed.
--
-- One row per device, because a device belongs to exactly one space. A browser
-- holding several spaces registers the same endpoint once per device; each
-- push still names only the space it is about (encrypted, see src/push.ts).
--
-- Nothing here is content. The endpoint is a capability URL at the browser's
-- push service, and p256dh/auth are the keys its payloads are encrypted to.
-- The row goes with the device: a revocation deletes it, and so does the push
-- service reporting the subscription gone.
--
-- A new table only, so existing spaces are untouched: a device that never
-- subscribes has no row and behaves exactly as before.
CREATE TABLE push_subscriptions (
  device_id  TEXT PRIMARY KEY,
  group_id   TEXT NOT NULL,
  endpoint   TEXT NOT NULL,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
