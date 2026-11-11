import type {SqliteDb} from "./types";

export function initializeWorkReferenceSchema(db: SqliteDb): void {
  db.exec(`CREATE TABLE IF NOT EXISTS sync_relay_work_references (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    reference TEXT NOT NULL UNIQUE CHECK(length(reference)=43 AND reference NOT GLOB '*[^A-Za-z0-9_-]*'),
    workspace_id TEXT NOT NULL REFERENCES sync_relay_workspaces(workspace_id) ON DELETE CASCADE,
    target_json TEXT NOT NULL CHECK(json_valid(target_json)),
    created_at_ms INTEGER NOT NULL,
    registered_by TEXT NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS idx_sync_relay_work_references_target
    ON sync_relay_work_references(workspace_id,target_json,reference);
  CREATE INDEX IF NOT EXISTS idx_sync_relay_work_references_page
    ON sync_relay_work_references(workspace_id,seq);
  CREATE TRIGGER IF NOT EXISTS sync_relay_work_references_immutable
    BEFORE UPDATE OF reference,workspace_id,target_json,created_at_ms,registered_by ON sync_relay_work_references BEGIN SELECT RAISE(ABORT,'work references are immutable'); END;
  CREATE TABLE IF NOT EXISTS sync_relay_work_reference_scopes (
    reference TEXT PRIMARY KEY REFERENCES sync_relay_work_references(reference) ON DELETE CASCADE,
    workspace_id TEXT NOT NULL REFERENCES sync_relay_workspaces(workspace_id) ON DELETE CASCADE,
    version_id TEXT, object_id TEXT, last_path TEXT, deleted INTEGER NOT NULL CHECK(deleted IN (0,1))
  ) STRICT;
  CREATE INDEX IF NOT EXISTS idx_sync_relay_work_reference_scopes_object
    ON sync_relay_work_reference_scopes(workspace_id,version_id,object_id);
  CREATE INDEX IF NOT EXISTS idx_sync_relay_work_reference_messages
    ON sync_relay_log(workspace_id,json_extract(payload_json,'$.messageId')) WHERE op_kind='chat.message.append';
  CREATE INDEX IF NOT EXISTS idx_sync_relay_work_reference_chats
    ON sync_relay_log(workspace_id,json_extract(payload_json,'$.channelId')) WHERE op_kind='chat.channel.create';
  CREATE INDEX IF NOT EXISTS idx_sync_relay_work_reference_chat_wires
    ON sync_relay_log(workspace_id,json_extract(payload_json,'$.wireId')) WHERE op_kind='chat.channel.create';
  CREATE INDEX IF NOT EXISTS idx_sync_relay_work_reference_moment_sequence
    ON sync_relay_object_moments(workspace_id,version_id,relay_seq);
  CREATE TABLE IF NOT EXISTS sync_relay_work_reference_record_objects (
    workspace_id TEXT NOT NULL REFERENCES sync_relay_workspaces(workspace_id) ON DELETE CASCADE,
    version_id TEXT NOT NULL, record_id TEXT NOT NULL, object_id TEXT NOT NULL, last_path TEXT NOT NULL,
    PRIMARY KEY(workspace_id,version_id,record_id,object_id)
  ) STRICT;
  CREATE TRIGGER IF NOT EXISTS sync_relay_work_reference_deleted_record BEFORE DELETE ON sync_relay_current_files BEGIN
    INSERT OR IGNORE INTO sync_relay_work_reference_record_objects
      SELECT OLD.workspace_id,OLD.version_id,r.record_id,m.object_id,OLD.path FROM sync_relay_current_record_ids r
      JOIN sync_relay_object_moments m ON m.workspace_id=r.workspace_id AND m.version_id=r.version_id AND m.relay_seq=OLD.state_relay_seq
      WHERE r.workspace_id=OLD.workspace_id AND r.version_id=OLD.version_id AND r.path=OLD.path;
    INSERT OR IGNORE INTO sync_relay_work_reference_record_objects
      SELECT OLD.workspace_id,OLD.version_id,r.record_id,s.object_id,OLD.path FROM sync_relay_current_record_ids r
      JOIN sync_relay_work_reference_snapshot_objects s ON s.workspace_id=r.workspace_id AND s.version_id=r.version_id AND s.path=r.path
      WHERE r.workspace_id=OLD.workspace_id AND r.version_id=OLD.version_id AND r.path=OLD.path;
  END;
  CREATE TABLE IF NOT EXISTS sync_relay_received_work_targets (
    recipient_kind TEXT NOT NULL, recipient_id TEXT NOT NULL, source_handle TEXT NOT NULL,
    object_token TEXT NOT NULL, workspace_id TEXT NOT NULL REFERENCES sync_relay_workspaces(workspace_id) ON DELETE CASCADE, object_id TEXT NOT NULL,
    PRIMARY KEY(recipient_kind,recipient_id,source_handle,object_token)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS sync_relay_work_reference_snapshot_objects (
    workspace_id TEXT NOT NULL REFERENCES sync_relay_workspaces(workspace_id) ON DELETE CASCADE,
    version_id TEXT NOT NULL, object_id TEXT NOT NULL, path TEXT NOT NULL, relay_seq INTEGER NOT NULL,
    PRIMARY KEY(workspace_id,version_id,object_id), UNIQUE(workspace_id,version_id,path)
  ) STRICT;`);
  const migration = "work-reference-snapshot-objects-v1";
  if (db.prepare("SELECT 1 FROM sync_relay_migrations WHERE migration_id=?").get(migration)) return;
  for (const row of db.prepare("SELECT workspace_id,payload_json,relay_seq FROM sync_relay_log WHERE op_kind='version.create' ORDER BY relay_seq").iterate()) {
    indexWorkReferenceSnapshot(db, String(row.workspace_id), String(row.payload_json), Number(row.relay_seq));
  }
  db.prepare("INSERT INTO sync_relay_migrations VALUES (?,?)").run(migration, Date.now());
}

export function indexWorkReferenceSnapshot(db: SqliteDb, workspaceId: string, payloadJson: string, relaySeq: number): void {
  const payload = JSON.parse(payloadJson) as {versionId?: unknown; forkSnapshots?: unknown};
  if (typeof payload.versionId !== "string" || !Array.isArray(payload.forkSnapshots)) return;
  const insert = db.prepare("INSERT OR IGNORE INTO sync_relay_work_reference_snapshot_objects VALUES (?,?,?,?,?)");
  for (const snapshot of payload.forkSnapshots) {
    if (!snapshot || typeof snapshot !== "object" || typeof snapshot.objectId !== "string" || !snapshot.objectId ||
        typeof snapshot.path !== "string" || !snapshot.path) continue;
    insert.run(workspaceId, payload.versionId, snapshot.objectId, snapshot.path, relaySeq);
  }
}
