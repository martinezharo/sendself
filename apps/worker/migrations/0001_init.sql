-- sendself initial schema
-- The server only ever stores ciphertext, public keys and hashes.

CREATE TABLE groups (
  id              TEXT PRIMARY KEY,
  auth_token_hash TEXT NOT NULL,         -- legacy bootstrap hash; device auth lives on devices
  created_at      INTEGER NOT NULL
);

CREATE TABLE devices (
  id          TEXT PRIMARY KEY,
  group_id    TEXT NOT NULL,
  name        TEXT NOT NULL,
  public_key  TEXT NOT NULL,             -- ECDH P-256 public key (base64url SPKI)
  created_at  INTEGER NOT NULL,
  revoked_at  INTEGER                    -- NULL = active
);

CREATE TABLE messages (
  id                TEXT PRIMARY KEY,
  group_id          TEXT NOT NULL,
  sender_device_id  TEXT NOT NULL,
  encrypted_payload TEXT,                -- AES-GCM ciphertext of the text (base64url) or NULL
  iv                TEXT,                -- IV for the text payload
  file_r2_key       TEXT,               -- R2 object key for an encrypted file, or NULL
  file_iv           TEXT,               -- IV for the file payload
  file_meta         TEXT,               -- encrypted file metadata (name/size/mime)
  file_meta_iv      TEXT,               -- IV for the file metadata payload
  created_at        INTEGER NOT NULL
);

CREATE TABLE delivery_status (
  message_id    TEXT NOT NULL,
  device_id     TEXT NOT NULL,
  downloaded_at INTEGER,                 -- NULL = still pending for this device
  PRIMARY KEY (message_id, device_id)
);

-- Short-lived slots used during device pairing (reaped by cron after 10 min).
CREATE TABLE pairing (
  pairing_id           TEXT PRIMARY KEY,  -- random, unguessable
  group_id             TEXT,              -- set by device 1 on /complete
  wrapped_package      TEXT,              -- ECIES-wrapped GroupKey package
  ephemeral_public_key TEXT,              -- ephemeral ECDH public key (base64url SPKI)
  new_device           TEXT,              -- JSON DeviceDescriptor of the joining device
  created_at           INTEGER NOT NULL
);

CREATE INDEX idx_messages_group_created ON messages (group_id, created_at);
CREATE INDEX idx_delivery_device_pending ON delivery_status (device_id, downloaded_at);
CREATE INDEX idx_delivery_message ON delivery_status (message_id);
CREATE INDEX idx_devices_group ON devices (group_id, revoked_at);
