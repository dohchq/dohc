import type { SqliteDb } from "./types";

export function initializeAppPublicationSchema(db: SqliteDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_relay_app_publications (
      publication_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      share_id TEXT NOT NULL,
      grant_id TEXT NOT NULL,
      grant_generation INTEGER NOT NULL CHECK (grant_generation BETWEEN 1 AND 9007199254740991),
      owner_user_id TEXT NOT NULL,
      manifest_sha256 TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL CHECK (created_at_ms BETWEEN 0 AND 9007199254740991),
      active INTEGER NOT NULL CHECK (active IN (0, 1)),
      authority_revision INTEGER NOT NULL CHECK (authority_revision BETWEEN 1 AND 9007199254740991),
      UNIQUE (publication_id, workspace_id),
      FOREIGN KEY (workspace_id) REFERENCES sync_relay_workspaces(workspace_id) ON DELETE CASCADE,
      FOREIGN KEY (grant_id, share_id) REFERENCES sync_relay_share_grants(grant_id, share_id) ON DELETE CASCADE,
      FOREIGN KEY (workspace_id, manifest_sha256) REFERENCES sync_relay_blobs(workspace_id, sha256)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS sync_relay_app_publication_blobs (
      publication_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      PRIMARY KEY (publication_id, workspace_id, sha256),
      FOREIGN KEY (publication_id, workspace_id) REFERENCES sync_relay_app_publications(publication_id, workspace_id) ON DELETE CASCADE,
      FOREIGN KEY (workspace_id, sha256) REFERENCES sync_relay_blobs(workspace_id, sha256)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS idx_sync_relay_publication_blobs_workspace
      ON sync_relay_app_publication_blobs(workspace_id, sha256);
    CREATE INDEX IF NOT EXISTS idx_sync_relay_publication_discovery
      ON sync_relay_app_publications(workspace_id, grant_id, grant_generation, active, publication_id);
  `);
}
