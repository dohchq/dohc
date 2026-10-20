import type {SqliteDb} from "./types";
import {currentShareGrantSql} from "./currentShareGrant";
import {replicaTextCleanupSql} from "./replicaTextStorage";

export const historyPinDue = "max(min(changed_at_ms+30000,dirty_since_ms+300000),coalesce(last_nonstructural_at_ms+30000,0))";
const migration = "replica-history-incremental-v1";
const pinBytes = (row: string) => `${row}.byte_length+length(CAST(${row}.authors_json AS BLOB))+length(CAST(${row}.path AS BLOB))+256`;
const purge = (workspace: string) => `DELETE FROM sync_relay_replica_cuts WHERE workspace_id=${workspace}
  AND NOT EXISTS (SELECT 1 FROM sync_relay_shares s JOIN sync_relay_share_grants g ON g.share_id=s.share_id
    WHERE s.workspace_id=${workspace} AND ${currentShareGrantSql("g","s")});
  ${replicaTextCleanupSql(workspace).join("; ")};`;
const captureFloors = (workspace: string) => `INSERT OR REPLACE INTO sync_relay_history_grant_floors
  SELECT g.grant_id,w.workspace_id,w.replication_epoch,w.stream_identity,
    coalesce((SELECT max(relay_seq) FROM sync_relay_log WHERE workspace_id=w.workspace_id),0),
    coalesce((SELECT max(journal_cursor) FROM sync_relay_live_update_journal WHERE workspace_id=w.workspace_id),0)
  FROM sync_relay_share_grants g JOIN sync_relay_shares s ON s.share_id=g.share_id
    JOIN sync_relay_workspaces w ON w.workspace_id=s.workspace_id
  WHERE w.workspace_id=${workspace} AND ${currentShareGrantSql("g","s")};`;
const addUsage = (row: string) => `INSERT INTO sync_relay_history_pin_usage
  SELECT ${row}.workspace_id,1,${pinBytes(row)} WHERE ${row}.superseded_at_ms IS NOT NULL
  ON CONFLICT(workspace_id) DO UPDATE SET pin_count=pin_count+1,total_bytes=total_bytes+excluded.total_bytes;`;
const removeUsage = `UPDATE sync_relay_history_pin_usage SET pin_count=pin_count-1,total_bytes=total_bytes-(${pinBytes("OLD")})
  WHERE workspace_id=OLD.workspace_id AND OLD.superseded_at_ms IS NOT NULL;
  DELETE FROM sync_relay_history_pin_usage WHERE workspace_id=OLD.workspace_id AND pin_count=0;`;

export function initializeReplicaHistoryWorkSchema(db: SqliteDb) {
  if (db.prepare("SELECT 1 FROM sync_relay_migrations WHERE migration_id=?").get(migration)) return;
  db.exec(`CREATE INDEX replica_history_due ON sync_relay_history_clocks(workspace_id,${historyPinDue}) WHERE dirty_since_ms IS NOT NULL;
    CREATE INDEX replica_history_current_pin ON sync_relay_history_pins(workspace_id,version_id,object_id) WHERE superseded_at_ms IS NULL;
    DELETE FROM sync_relay_history_clocks AS c WHERE NOT EXISTS (
      SELECT 1 FROM sync_relay_replica_cut_files f WHERE f.workspace_id=c.workspace_id AND f.version_id=c.version_id AND f.object_id=c.object_id)
      AND NOT EXISTS (SELECT 1 FROM sync_relay_replica_cuts cut,json_each(cut.omitted_json) o WHERE cut.workspace_id=c.workspace_id
        AND json_extract(o.value,'$.versionId')=c.version_id AND json_extract(o.value,'$.objectId')=c.object_id);
    UPDATE sync_relay_history_pins SET superseded_at_ms=CAST(unixepoch('subsec')*1000 AS INTEGER)
      WHERE superseded_at_ms IS NULL AND NOT EXISTS (SELECT 1 FROM sync_relay_replica_cuts cut WHERE cut.workspace_id=sync_relay_history_pins.workspace_id)
      AND EXISTS (SELECT 1 FROM sync_relay_shares s JOIN sync_relay_share_grants g ON g.share_id=s.share_id
        WHERE s.workspace_id=sync_relay_history_pins.workspace_id AND ${currentShareGrantSql("g","s")});
    DELETE FROM sync_relay_history_pins AS c WHERE superseded_at_ms IS NULL AND NOT EXISTS (
      SELECT 1 FROM sync_relay_replica_cut_files f WHERE f.workspace_id=c.workspace_id AND f.version_id=c.version_id AND f.object_id=c.object_id)
      AND NOT EXISTS (SELECT 1 FROM sync_relay_replica_cuts cut,json_each(cut.omitted_json) o WHERE cut.workspace_id=c.workspace_id
        AND json_extract(o.value,'$.versionId')=c.version_id AND json_extract(o.value,'$.objectId')=c.object_id);
    ${replicaTextCleanupSql().join("; ")};
    CREATE TABLE sync_relay_history_pin_usage (
      workspace_id TEXT PRIMARY KEY REFERENCES sync_relay_workspaces(workspace_id) ON DELETE CASCADE,
      pin_count INTEGER NOT NULL CHECK(pin_count>=0), total_bytes INTEGER NOT NULL CHECK(total_bytes>=0)
    ) STRICT;
    INSERT INTO sync_relay_history_pin_usage SELECT workspace_id,count(*),sum(${pinBytes("p")})
      FROM sync_relay_history_pins p WHERE superseded_at_ms IS NOT NULL GROUP BY workspace_id;
    CREATE TRIGGER replica_history_usage_insert AFTER INSERT ON sync_relay_history_pins BEGIN ${addUsage("NEW")} END;
    CREATE TRIGGER replica_history_usage_delete AFTER DELETE ON sync_relay_history_pins BEGIN ${removeUsage} END;
    CREATE TRIGGER replica_history_usage_update AFTER UPDATE ON sync_relay_history_pins BEGIN ${removeUsage} ${addUsage("NEW")} END;
    DROP TRIGGER replica_current_view_grant_update;
    CREATE TRIGGER replica_current_view_grant_update AFTER UPDATE ON sync_relay_share_grants BEGIN
      ${purge("(SELECT workspace_id FROM sync_relay_shares WHERE share_id=OLD.share_id)")}
      ${purge("(SELECT workspace_id FROM sync_relay_shares WHERE share_id=NEW.share_id)")}
    END;
    DROP TRIGGER replica_current_view_grant_delete;
    CREATE TRIGGER replica_current_view_grant_delete AFTER DELETE ON sync_relay_share_grants BEGIN
      ${purge("(SELECT workspace_id FROM sync_relay_shares WHERE share_id=OLD.share_id)")}
    END;
    DROP TRIGGER replica_current_view_share_update;
    CREATE TRIGGER replica_current_view_share_update AFTER UPDATE OF selector_json,workspace_id,granter_user_id ON sync_relay_shares BEGIN
      ${purge("OLD.workspace_id")} ${purge("NEW.workspace_id")}
    END;
    DROP TRIGGER replica_current_view_share_delete;
    CREATE TRIGGER replica_current_view_share_delete AFTER DELETE ON sync_relay_shares BEGIN ${purge("OLD.workspace_id")} END;
    CREATE TRIGGER replica_history_identity_floor AFTER UPDATE OF replication_epoch,stream_identity ON sync_relay_workspaces
      WHEN OLD.replication_epoch IS NOT NEW.replication_epoch OR OLD.stream_identity IS NOT NEW.stream_identity
      BEGIN ${captureFloors("NEW.workspace_id")} END;`);
  // Existing mismatched floors can resume only from the migration's current positions.
  db.exec(captureFloors("w.workspace_id").replace(/;$/,` AND EXISTS (
    SELECT 1 FROM sync_relay_history_grant_floors f WHERE f.grant_id=g.grant_id
      AND (f.replication_epoch IS NOT w.replication_epoch OR f.stream_identity IS NOT w.stream_identity));`));
  db.prepare("INSERT INTO sync_relay_migrations VALUES (?,?)").run(migration,Date.now());
}
