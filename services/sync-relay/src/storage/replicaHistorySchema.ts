import type {SqliteDb} from "./types";
import {currentShareGrantSql} from "./currentShareGrant";
import {replicaTextCleanupSql} from "./replicaTextStorage";

const migration = "replica-history-pins-v1";
export const HISTORY_JOURNAL_POSITION_INDEX = "replica_history_journal_position";
const standing = (workspace: string) => `EXISTS (SELECT 1 FROM sync_relay_shares s JOIN sync_relay_share_grants g ON g.share_id=s.share_id
  WHERE s.workspace_id=${workspace} AND ${currentShareGrantSql("g","s")})`;
const cleanup = (workspace: string) => `DELETE FROM sync_relay_history_pins WHERE workspace_id=${workspace} AND NOT ${standing(workspace)};
  DELETE FROM sync_relay_history_clocks WHERE workspace_id=${workspace} AND NOT ${standing(workspace)};
  ${replicaTextCleanupSql(workspace).join("; ")};`;

export function initializeReplicaHistorySchema(db: SqliteDb) {
  if (!db.prepare("SELECT 1 FROM sync_relay_migrations WHERE migration_id=?").get(migration)) {
    db.exec(`CREATE TABLE sync_relay_replica_cut_text_refs (
      workspace_id TEXT NOT NULL REFERENCES sync_relay_workspaces(workspace_id) ON DELETE CASCADE,
      sha256 TEXT NOT NULL, ref_count INTEGER NOT NULL CHECK(ref_count>=0), PRIMARY KEY(workspace_id,sha256)
    ) STRICT;
    CREATE INDEX replica_current_text_unreferenced ON sync_relay_replica_cut_text_refs(workspace_id,sha256) WHERE ref_count=0;
    INSERT INTO sync_relay_replica_cut_text_refs SELECT workspace_id,sha256,max(ref_count) FROM sync_relay_replica_cut_texts GROUP BY workspace_id,sha256;
    ALTER TABLE sync_relay_replica_cut_texts DROP COLUMN ref_count;
    CREATE TABLE sync_relay_history_pins (
      pin_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES sync_relay_workspaces(workspace_id) ON DELETE CASCADE,
      version_id TEXT NOT NULL, object_id TEXT NOT NULL, path TEXT NOT NULL, content_kind TEXT NOT NULL CHECK(content_kind IN ('text','binary')),
      sha256 TEXT NOT NULL, byte_length INTEGER NOT NULL CHECK(byte_length>=0), lineage_claim_id TEXT, restore_generation INTEGER,
      reason TEXT NOT NULL CHECK(reason IN ('quiet','ceiling','rename','delete','restore','lineage')),
      pinned_at_ms INTEGER NOT NULL, superseded_at_ms INTEGER,
      log_cursor INTEGER NOT NULL, journal_cursor INTEGER NOT NULL, authors_json TEXT NOT NULL CHECK(json_valid(authors_json)),
      replaced_stream TEXT CHECK(replaced_stream IN ('log','journal')), replaced_position INTEGER
    ) STRICT;
    CREATE INDEX replica_history_object ON sync_relay_history_pins(workspace_id,version_id,object_id,pinned_at_ms);
    CREATE INDEX ${HISTORY_JOURNAL_POSITION_INDEX} ON sync_relay_live_update_journal(workspace_id,main_version_id,object_id,journal_cursor);
    CREATE TABLE sync_relay_history_grant_floors (
      grant_id TEXT PRIMARY KEY REFERENCES sync_relay_share_grants(grant_id) ON DELETE CASCADE,
      workspace_id TEXT NOT NULL, replication_epoch TEXT, stream_identity TEXT, log_floor INTEGER NOT NULL, journal_floor INTEGER NOT NULL
    ) STRICT;
    CREATE TRIGGER replica_history_grant_floor AFTER INSERT ON sync_relay_share_grants BEGIN
      INSERT INTO sync_relay_history_grant_floors SELECT NEW.grant_id,w.workspace_id,w.replication_epoch,w.stream_identity,
        coalesce((SELECT max(relay_seq) FROM sync_relay_log WHERE workspace_id=w.workspace_id),0),
        coalesce((SELECT max(journal_cursor) FROM sync_relay_live_update_journal WHERE workspace_id=w.workspace_id),0)
        FROM sync_relay_workspaces w JOIN sync_relay_shares s ON s.workspace_id=w.workspace_id WHERE s.share_id=NEW.share_id;
    END;
    CREATE TABLE sync_relay_history_clocks (
      workspace_id TEXT NOT NULL REFERENCES sync_relay_workspaces(workspace_id) ON DELETE CASCADE,
      version_id TEXT NOT NULL, object_id TEXT NOT NULL,
      changed_at_ms INTEGER NOT NULL, dirty_since_ms INTEGER, last_nonstructural_at_ms INTEGER,
      pin_log_cursor INTEGER NOT NULL DEFAULT 0, pin_journal_cursor INTEGER NOT NULL DEFAULT 0,
      state_key TEXT,
      PRIMARY KEY(workspace_id,version_id,object_id)
    ) STRICT;
    CREATE TRIGGER replica_history_pin_delete AFTER DELETE ON sync_relay_history_pins WHEN OLD.content_kind='text' BEGIN
      UPDATE sync_relay_replica_cut_text_refs SET ref_count=ref_count-1 WHERE workspace_id=OLD.workspace_id AND sha256=OLD.sha256;
    END;
    DROP TRIGGER replica_current_view_delete;
    CREATE TRIGGER replica_current_view_delete AFTER DELETE ON sync_relay_replica_cuts BEGIN
      UPDATE sync_relay_replica_cut_text_refs SET ref_count=(SELECT count(*) FROM sync_relay_history_pins p
        WHERE p.workspace_id=OLD.workspace_id AND p.sha256=sync_relay_replica_cut_text_refs.sha256 AND p.content_kind='text') WHERE workspace_id=OLD.workspace_id;
      ${replicaTextCleanupSql("OLD.workspace_id").join("; ")};
    END;
    CREATE TRIGGER replica_history_identity AFTER UPDATE OF replication_epoch,stream_identity,owner_user_id ON sync_relay_workspaces
      WHEN OLD.replication_epoch IS NOT NEW.replication_epoch OR OLD.stream_identity IS NOT NEW.stream_identity OR OLD.owner_user_id IS NOT NEW.owner_user_id BEGIN
      DELETE FROM sync_relay_history_pins WHERE workspace_id=NEW.workspace_id;
      DELETE FROM sync_relay_history_clocks WHERE workspace_id=NEW.workspace_id;
      DELETE FROM sync_relay_replica_cut_text_refs WHERE workspace_id=NEW.workspace_id;
    END;
    CREATE TRIGGER replica_history_grant_update AFTER UPDATE ON sync_relay_share_grants BEGIN
      ${cleanup("(SELECT workspace_id FROM sync_relay_shares WHERE share_id=NEW.share_id)")}
    END;
    CREATE TRIGGER replica_history_grant_delete AFTER DELETE ON sync_relay_share_grants BEGIN
      ${cleanup("(SELECT workspace_id FROM sync_relay_shares WHERE share_id=OLD.share_id)")}
    END;
    CREATE TRIGGER replica_history_share_delete AFTER DELETE ON sync_relay_shares BEGIN ${cleanup("OLD.workspace_id")} END;
    CREATE TRIGGER replica_history_share_update AFTER UPDATE OF workspace_id,granter_user_id ON sync_relay_shares BEGIN
      ${cleanup("OLD.workspace_id")} ${cleanup("NEW.workspace_id")}
    END;`);
    // 6a discards the view when one grant ends. Other grants must keep their History texts.
    for (const name of ["replica_current_view_grant_update","replica_current_view_grant_delete","replica_current_view_share_update","replica_current_view_share_delete"]) {
      const sql = String(db.prepare("SELECT sql FROM sqlite_schema WHERE name=?").get(name)!.sql);
      db.exec(`DROP TRIGGER ${name}`);
      db.exec(sql.replaceAll("DELETE FROM sync_relay_replica_cut_texts WHERE workspace_id", `DELETE FROM sync_relay_replica_cut_texts WHERE (workspace_id,sha256) IN
        (SELECT workspace_id,sha256 FROM sync_relay_replica_cut_text_refs WHERE ref_count=0) AND workspace_id`));
    }
    db.prepare("INSERT INTO sync_relay_migrations VALUES (?,?)").run(migration,Date.now());
  }
  if (JSON.stringify(db.prepare(`PRAGMA index_info(${HISTORY_JOURNAL_POSITION_INDEX})`).all().map(r=>r.name)) !==
      JSON.stringify(["workspace_id","main_version_id","object_id","journal_cursor"])) throw new Error("History journal position index is missing or damaged");
  db.exec(`DELETE FROM sync_relay_history_pins WHERE NOT ${standing("sync_relay_history_pins.workspace_id")};
    DELETE FROM sync_relay_history_clocks WHERE NOT ${standing("sync_relay_history_clocks.workspace_id")};
    ${replicaTextCleanupSql().join("; ")}`);
}
