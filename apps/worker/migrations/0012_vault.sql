-- The vault: a space's folders, notes and files that persist, as opposed to
-- messages, which the server forgets once every device has them.
--
-- What the server learns: how many items a space keeps, their kind, how they
-- nest, how large each stored blob is and when each changed. Names, note text,
-- file contents and file types are inside `meta` (or the blob it points at),
-- sealed under the space's GroupKey.
CREATE TABLE vault_items (
  group_id    TEXT NOT NULL,
  id          TEXT NOT NULL,              -- client-generated, random
  parent_id   TEXT,                       -- a folder of the same space; NULL = the root
  kind        TEXT NOT NULL,              -- 'folder' | 'note' | 'file'
  key_epoch   INTEGER,                    -- GroupKey epoch `meta` is sealed under
  meta        TEXT,                       -- AES-GCM ciphertext of VaultItemMeta
  meta_iv     TEXT,
  blob_key    TEXT,                       -- the item's content in VAULT (notes and files)
  blob_size   INTEGER NOT NULL DEFAULT 0, -- ciphertext bytes of that blob
  revision    INTEGER NOT NULL DEFAULT 1, -- bumped by every edit; what a write is checked against
  seq         INTEGER NOT NULL,           -- the space's change counter at the latest change
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  trashed_at  INTEGER,                    -- in the trash since; purged after VAULT_TRASH_TTL_MS
  removed_at  INTEGER,                    -- purged: the row is a tombstone devices sync from
  PRIMARY KEY (group_id, id)
);

-- "What changed since cursor N", the vault's only read.
CREATE UNIQUE INDEX idx_vault_items_seq ON vault_items (group_id, seq);
-- Children of a folder (moves, purges) and the trash sweep.
CREATE INDEX idx_vault_items_parent ON vault_items (group_id, parent_id);
CREATE INDEX idx_vault_items_trashed ON vault_items (trashed_at) WHERE trashed_at IS NOT NULL;
CREATE INDEX idx_vault_items_removed ON vault_items (removed_at) WHERE removed_at IS NOT NULL;

-- The space's change counter: every vault write takes the next value, so a
-- device asks only for what changed after the last one it saw. `vault_floor`
-- is the newest seq whose tombstone has been forgotten; a device whose cursor
-- is older than that cannot be told what it missed and resyncs from scratch.
ALTER TABLE groups ADD COLUMN vault_seq INTEGER NOT NULL DEFAULT 0;
ALTER TABLE groups ADD COLUMN vault_floor INTEGER NOT NULL DEFAULT 0;

-- Accounting of the blobs in the VAULT bucket, exactly like `uploads` for
-- message files: a row per object, written before the bytes, so the space's
-- quota (VAULT_BYTES_QUOTA) is enforced atomically.
CREATE TABLE vault_blobs (
  group_id   TEXT NOT NULL,
  r2_key     TEXT NOT NULL,
  size       INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (group_id, r2_key)
);

CREATE INDEX idx_vault_blobs_created ON vault_blobs (created_at);
CREATE INDEX idx_vault_items_blob ON vault_items (group_id, blob_key)
  WHERE blob_key IS NOT NULL;
