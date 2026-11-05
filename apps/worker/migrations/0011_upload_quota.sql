-- Server-side accounting of uploaded file blobs, so a space's footprint can be
-- capped (SPACE_PENDING_BYTES_QUOTA) and uploads no message ever claimed can be
-- discarded early (ORPHAN_UPLOAD_TTL_MS) instead of living until the 24-hour
-- cleanup.
--
-- R2 cannot answer "how many bytes does this space hold" cheaply, hence a row
-- per object. A row lives exactly as long as its object: every path that
-- deletes the blob deletes the row in the same step.
--
-- Blobs uploaded before this migration have no row. They are simply not
-- counted, and expire within 24 hours like before.
CREATE TABLE uploads (
  group_id   TEXT NOT NULL,
  r2_key     TEXT NOT NULL,              -- the client's key, unprefixed (see fileStorageKey)
  size       INTEGER NOT NULL,           -- ciphertext bytes, as reserved before the write
  created_at INTEGER NOT NULL,           -- of the latest write; a re-upload refreshes it
  PRIMARY KEY (group_id, r2_key)
);

CREATE INDEX idx_uploads_created ON uploads (created_at);

-- The orphan sweep asks "does any message still reference this blob?".
CREATE INDEX idx_messages_file ON messages (group_id, file_r2_key)
  WHERE file_r2_key IS NOT NULL;
