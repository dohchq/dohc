CREATE TABLE series (
  id TEXT PRIMARY KEY NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  unit TEXT NOT NULL,
  domain TEXT NOT NULL
) STRICT;

CREATE TABLE import_batches (
  id INTEGER PRIMARY KEY NOT NULL,
  filename TEXT NOT NULL,
  sha256 TEXT NOT NULL UNIQUE,
  row_count INTEGER NOT NULL,
  received_rows INTEGER NOT NULL,
  imported_at_ms INTEGER
) STRICT;

CREATE TABLE observations (
  id INTEGER PRIMARY KEY NOT NULL,
  series_id TEXT NOT NULL REFERENCES series(id),
  observed_at TEXT NOT NULL,
  value REAL NOT NULL,
  tags_json TEXT NOT NULL,
  import_batch_id INTEGER NOT NULL REFERENCES import_batches(id)
) STRICT;

CREATE INDEX observation_series_time ON observations (series_id, observed_at);

CREATE TABLE research_notes (
  id TEXT PRIMARY KEY NOT NULL,
  title TEXT NOT NULL,
  body_md TEXT NOT NULL,
  date_start TEXT NOT NULL,
  date_end TEXT NOT NULL,
  series_ids_json TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL,
  grant_id TEXT UNIQUE,
  link_version INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE TABLE settings (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
) STRICT;
