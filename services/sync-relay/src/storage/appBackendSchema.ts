import type { SqliteDb } from "./types";

export function initializeAppBackendSchema(db: SqliteDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_relay_app_backends (
      workspace_id TEXT NOT NULL REFERENCES sync_relay_workspaces(workspace_id) ON DELETE CASCADE,
      data_path TEXT NOT NULL, app_root TEXT NOT NULL,
      publication_id TEXT NOT NULL, publication_revision INTEGER NOT NULL CHECK(publication_revision > 0),
      schema_sha256 TEXT NOT NULL, schema_version INTEGER NOT NULL CHECK(schema_version > 0),
      source_sha256 TEXT NOT NULL, source TEXT NOT NULL, capability_json TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK(revision > 0), database BLOB NOT NULL CHECK(length(database) <= 16777216),
      updated_at_ms INTEGER NOT NULL, storage_bytes INTEGER NOT NULL CHECK(storage_bytes > 0),
      PRIMARY KEY(workspace_id,data_path)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS sync_relay_app_backend_history (
      workspace_id TEXT NOT NULL, data_path TEXT NOT NULL, revision INTEGER NOT NULL,
      publication_id TEXT NOT NULL, publication_revision INTEGER NOT NULL,
      source_sha256 TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('activate','operation')),
      grant_id TEXT NOT NULL, principal_id TEXT NOT NULL, changeset BLOB NOT NULL,
      database_sha256 TEXT NOT NULL, recorded_at_ms INTEGER NOT NULL,
      storage_bytes INTEGER NOT NULL CHECK(storage_bytes > 0),
      PRIMARY KEY(workspace_id,data_path,revision),
      FOREIGN KEY(workspace_id,data_path) REFERENCES sync_relay_app_backends(workspace_id,data_path) ON DELETE CASCADE
    ) STRICT;
    CREATE TABLE IF NOT EXISTS sync_relay_app_backend_receipts (
      workspace_id TEXT NOT NULL, data_path TEXT NOT NULL, grant_id TEXT NOT NULL, principal_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL, payload_sha256 TEXT NOT NULL,
      revision INTEGER NOT NULL, result_json TEXT NOT NULL, recorded_at_ms INTEGER NOT NULL,
      storage_bytes INTEGER NOT NULL CHECK(storage_bytes > 0),
      PRIMARY KEY(workspace_id,data_path,grant_id,principal_id,idempotency_key),
      FOREIGN KEY(workspace_id,data_path) REFERENCES sync_relay_app_backends(workspace_id,data_path) ON DELETE CASCADE
    ) STRICT;
    CREATE TABLE IF NOT EXISTS sync_relay_app_backend_files (
      workspace_id TEXT NOT NULL, data_path TEXT NOT NULL, file_id TEXT NOT NULL,
      grant_id TEXT NOT NULL, principal_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
      name TEXT NOT NULL, content_type TEXT NOT NULL, sha256 TEXT NOT NULL,
      content BLOB NOT NULL CHECK(length(content) BETWEEN 1 AND 5242880),
      created_at_ms INTEGER NOT NULL, expires_at_ms INTEGER NOT NULL, attached_revision INTEGER,
      storage_bytes INTEGER NOT NULL CHECK(storage_bytes > 0),
      PRIMARY KEY(workspace_id,data_path,file_id),
      UNIQUE(workspace_id,data_path,grant_id,principal_id,idempotency_key),
      FOREIGN KEY(workspace_id,data_path) REFERENCES sync_relay_app_backends(workspace_id,data_path) ON DELETE CASCADE
    ) STRICT;
    CREATE INDEX IF NOT EXISTS idx_app_backend_staged_expiry ON sync_relay_app_backend_files(expires_at_ms) WHERE attached_revision IS NULL;
    CREATE TABLE IF NOT EXISTS sync_relay_app_backend_helpers (
      workspace_id TEXT NOT NULL, data_path TEXT NOT NULL, grant_id TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL, storage_bytes INTEGER NOT NULL CHECK(storage_bytes > 0),
      PRIMARY KEY(workspace_id,data_path,grant_id),
      FOREIGN KEY(workspace_id,data_path) REFERENCES sync_relay_app_backends(workspace_id,data_path) ON DELETE CASCADE
    ) STRICT;
    CREATE TABLE IF NOT EXISTS sync_relay_app_backend_usage (
      workspace_id TEXT NOT NULL, data_path TEXT NOT NULL,
      storage_bytes INTEGER NOT NULL CHECK(storage_bytes >= 0),
      history_rows INTEGER NOT NULL CHECK(history_rows >= 0),
      receipt_rows INTEGER NOT NULL CHECK(receipt_rows >= 0),
      file_rows INTEGER NOT NULL CHECK(file_rows >= 0),
      PRIMARY KEY(workspace_id,data_path),
      FOREIGN KEY(workspace_id,data_path) REFERENCES sync_relay_app_backends(workspace_id,data_path) ON DELETE CASCADE
    ) STRICT;
    CREATE TRIGGER IF NOT EXISTS app_backend_account_insert AFTER INSERT ON sync_relay_app_backends BEGIN
      INSERT INTO sync_relay_app_backend_usage(workspace_id,data_path,storage_bytes,history_rows,receipt_rows,file_rows)
        VALUES(NEW.workspace_id,NEW.data_path,NEW.storage_bytes,0,0,0); END;
    CREATE TRIGGER IF NOT EXISTS app_backend_account_update AFTER UPDATE ON sync_relay_app_backends BEGIN
      UPDATE sync_relay_app_backend_usage SET storage_bytes=storage_bytes+NEW.storage_bytes-OLD.storage_bytes
        WHERE workspace_id=NEW.workspace_id AND data_path=NEW.data_path; END;
  `);
  for (const table of ["sync_relay_app_backends", "sync_relay_app_backend_history", "sync_relay_app_backend_receipts", "sync_relay_app_backend_files", "sync_relay_app_backend_helpers"]) {
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS ${table}_usage_insert AFTER INSERT ON ${table} BEGIN
        UPDATE sync_relay_workspace_usage SET usage_bytes=usage_bytes+NEW.storage_bytes WHERE workspace_id=NEW.workspace_id; END;
      CREATE TRIGGER IF NOT EXISTS ${table}_usage_update AFTER UPDATE ON ${table} BEGIN
        UPDATE sync_relay_workspace_usage SET usage_bytes=usage_bytes+NEW.storage_bytes-OLD.storage_bytes WHERE workspace_id=NEW.workspace_id; END;
      CREATE TRIGGER IF NOT EXISTS ${table}_usage_delete AFTER DELETE ON ${table} BEGIN
        UPDATE sync_relay_workspace_usage SET usage_bytes=usage_bytes-OLD.storage_bytes WHERE workspace_id=OLD.workspace_id; END;
    `);
  }
  for (const [table,count] of [["sync_relay_app_backend_history","history_rows"], ["sync_relay_app_backend_receipts","receipt_rows"],
    ["sync_relay_app_backend_files","file_rows"], ["sync_relay_app_backend_helpers",null]] as const) {
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS ${table}_account_insert AFTER INSERT ON ${table} BEGIN
        UPDATE sync_relay_app_backend_usage SET storage_bytes=storage_bytes+NEW.storage_bytes${count ? `,${count}=${count}+1` : ""}
          WHERE workspace_id=NEW.workspace_id AND data_path=NEW.data_path; END;
      CREATE TRIGGER IF NOT EXISTS ${table}_account_update AFTER UPDATE ON ${table} BEGIN
        UPDATE sync_relay_app_backend_usage SET storage_bytes=storage_bytes+NEW.storage_bytes-OLD.storage_bytes
          WHERE workspace_id=NEW.workspace_id AND data_path=NEW.data_path; END;
      CREATE TRIGGER IF NOT EXISTS ${table}_account_delete AFTER DELETE ON ${table} BEGIN
        UPDATE sync_relay_app_backend_usage SET storage_bytes=storage_bytes-OLD.storage_bytes${count ? `,${count}=${count}-1` : ""}
          WHERE workspace_id=OLD.workspace_id AND data_path=OLD.data_path; END;
    `);
  }
}
