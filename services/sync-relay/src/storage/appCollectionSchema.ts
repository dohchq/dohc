import type { SqliteDb } from "./types";

export function initializeAppCollectionSchema(db: SqliteDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_relay_app_collection_approvals (
      publication_id TEXT PRIMARY KEY REFERENCES sync_relay_app_publications(publication_id) ON DELETE CASCADE,
      capability_json TEXT NOT NULL,
      active INTEGER NOT NULL CHECK(active IN (0,1)), storage_bytes INTEGER NOT NULL CHECK(storage_bytes >= 0)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS sync_relay_app_public_principals (
      workspace_id TEXT NOT NULL REFERENCES sync_relay_workspaces(workspace_id) ON DELETE CASCADE,
      grant_id TEXT NOT NULL REFERENCES sync_relay_share_grants(grant_id) ON DELETE CASCADE,
      principal_id TEXT NOT NULL REFERENCES sync_relay_link_principals(principal_id),
      public_principal_id TEXT NOT NULL UNIQUE,
      storage_bytes INTEGER NOT NULL CHECK(storage_bytes > 0),
      PRIMARY KEY(grant_id,principal_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS sync_relay_app_collection_receipts (
      workspace_id TEXT NOT NULL REFERENCES sync_relay_workspaces(workspace_id) ON DELETE CASCADE,
      grant_id TEXT NOT NULL REFERENCES sync_relay_share_grants(grant_id) ON DELETE CASCADE,
      principal_id TEXT NOT NULL REFERENCES sync_relay_link_principals(principal_id),
      idempotency_key TEXT NOT NULL,
      payload_sha256 TEXT NOT NULL,
      receipt_json TEXT NOT NULL,
      acceptance_id TEXT NOT NULL UNIQUE,
      storage_bytes INTEGER NOT NULL CHECK(storage_bytes > 0),
      PRIMARY KEY(grant_id,principal_id,idempotency_key)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS idx_app_collection_receipt_grant ON sync_relay_app_collection_receipts(grant_id);
  `);
  for (const table of ["sync_relay_app_public_principals", "sync_relay_app_collection_receipts"]) {
    db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_usage_insert AFTER INSERT ON ${table} BEGIN
      UPDATE sync_relay_workspace_usage SET usage_bytes=usage_bytes+NEW.storage_bytes WHERE workspace_id=NEW.workspace_id; END;
      CREATE TRIGGER IF NOT EXISTS ${table}_usage_delete AFTER DELETE ON ${table} BEGIN
      UPDATE sync_relay_workspace_usage SET usage_bytes=usage_bytes-OLD.storage_bytes WHERE workspace_id=OLD.workspace_id; END;`);
  }
}
