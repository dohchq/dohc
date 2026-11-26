ALTER TABLE replication_refused_ydoc_blobs ADD COLUMN reason TEXT;
ALTER TABLE replication_refused_ydoc_blobs ADD COLUMN relay_seq INTEGER
    CHECK (relay_seq IS NULL OR relay_seq >= 0);
ALTER TABLE replication_refused_ydoc_blobs ADD COLUMN replication_epoch TEXT;
ALTER TABLE replication_refused_ydoc_blobs ADD COLUMN stream_identity TEXT;
ALTER TABLE replication_refused_ydoc_blobs ADD COLUMN replayed INTEGER NOT NULL DEFAULT 0
    CHECK (replayed IN (0, 1));
