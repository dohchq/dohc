-- A workspace's first import of the files already in its folder, from its
-- first capture pass until no file it found is left to record. While the row
-- is unfinished, capture labels each file it has never recorded with the
-- import's correlation id. A store with records and no row finished its
-- import before this table existed.
CREATE TABLE capture_first_imports (
    workspace_id TEXT PRIMARY KEY NOT NULL,
    correlation_id TEXT NOT NULL,
    finished INTEGER NOT NULL CHECK (finished IN (0, 1))
) STRICT;
