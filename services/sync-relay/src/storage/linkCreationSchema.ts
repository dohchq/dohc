import type { SqliteDb } from "./types";
export function initializeLinkCreationSchema(db: SqliteDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_relay_link_creations (
      workspace_id TEXT NOT NULL REFERENCES sync_relay_workspaces(workspace_id) ON DELETE CASCADE,
      operation_id TEXT NOT NULL,
      owner_user_id TEXT NOT NULL,
      share_id TEXT NOT NULL REFERENCES sync_relay_shares(share_id) ON DELETE CASCADE,
      grant_id TEXT NOT NULL REFERENCES sync_relay_share_grants(grant_id) ON DELETE CASCADE,
      request_json TEXT NOT NULL,
      PRIMARY KEY (workspace_id, operation_id)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS idx_sync_relay_link_creation_share ON sync_relay_link_creations(share_id);
  `);
}
