import type {SqliteDb} from "./types";
import {currentShareGrantSql} from "./currentShareGrant";

const currentShare = `EXISTS (SELECT 1 FROM sync_relay_shares s JOIN sync_relay_share_grants g ON g.share_id=s.share_id
  WHERE s.workspace_id=sync_relay_replica_cuts.workspace_id AND ${currentShareGrantSql("g", "s")})`;
const currentViewSweep = `DELETE FROM sync_relay_replica_cuts WHERE NOT ${currentShare};
  DELETE FROM sync_relay_replica_cut_texts WHERE NOT EXISTS (SELECT 1 FROM sync_relay_shares s JOIN sync_relay_share_grants g ON g.share_id=s.share_id
    WHERE s.workspace_id=sync_relay_replica_cut_texts.workspace_id AND ${currentShareGrantSql("g", "s")})`;

export function initializeReplicaCurrentViewSchema(db: SqliteDb) {
  db.exec(`CREATE TABLE IF NOT EXISTS sync_relay_replica_cuts (
    workspace_id TEXT PRIMARY KEY REFERENCES sync_relay_workspaces(workspace_id) ON DELETE CASCADE,
    replication_epoch TEXT NOT NULL, stream_identity TEXT NOT NULL, incarnation TEXT NOT NULL,
    cut_seq INTEGER NOT NULL CHECK(cut_seq>0), revision INTEGER NOT NULL CHECK(revision>=0),
    log_cursor INTEGER NOT NULL CHECK(log_cursor>=0), journal_cursor INTEGER NOT NULL CHECK(journal_cursor>=0),
    omitted_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(omitted_json))
  ) STRICT;
  CREATE TABLE IF NOT EXISTS sync_relay_replica_cut_files (
    workspace_id TEXT NOT NULL REFERENCES sync_relay_replica_cuts(workspace_id) ON DELETE CASCADE,
    version_id TEXT NOT NULL, object_id TEXT NOT NULL, path TEXT NOT NULL,
    content_kind TEXT NOT NULL CHECK(content_kind IN ('text','binary')),
    sha256 TEXT NOT NULL CHECK(length(sha256)=64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
    byte_length INTEGER NOT NULL CHECK(byte_length>=0), lineage_claim_id TEXT, restore_generation INTEGER CHECK(restore_generation>=0),
    CHECK((lineage_claim_id IS NULL)=(restore_generation IS NULL)),
    PRIMARY KEY(workspace_id,version_id,object_id), UNIQUE(workspace_id,version_id,path)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS replica_current_view_file_sha ON sync_relay_replica_cut_files(workspace_id,sha256);
  CREATE TABLE IF NOT EXISTS sync_relay_replica_cut_texts (
    workspace_id TEXT NOT NULL REFERENCES sync_relay_workspaces(workspace_id) ON DELETE CASCADE,
    sha256 TEXT NOT NULL CHECK(length(sha256)=64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
    ordinal INTEGER NOT NULL CHECK(ordinal>=0), bytes BLOB NOT NULL CHECK(length(bytes)<=8388608),
    ref_count INTEGER NOT NULL CHECK(ref_count>=0), PRIMARY KEY(workspace_id,sha256,ordinal)
  ) STRICT;
  CREATE TRIGGER IF NOT EXISTS replica_current_view_delete AFTER DELETE ON sync_relay_replica_cuts BEGIN
    DELETE FROM sync_relay_replica_cut_texts WHERE workspace_id=OLD.workspace_id;
  END;
  CREATE TRIGGER IF NOT EXISTS replica_current_view_identity AFTER UPDATE OF replication_epoch,stream_identity,owner_user_id ON sync_relay_workspaces BEGIN
    DELETE FROM sync_relay_replica_cuts WHERE workspace_id=NEW.workspace_id AND
      (replication_epoch IS NOT NEW.replication_epoch OR stream_identity IS NOT NEW.stream_identity OR OLD.owner_user_id IS NOT NEW.owner_user_id);
    DELETE FROM sync_relay_replica_cut_texts WHERE workspace_id=NEW.workspace_id AND
      (OLD.replication_epoch IS NOT NEW.replication_epoch OR OLD.stream_identity IS NOT NEW.stream_identity OR OLD.owner_user_id IS NOT NEW.owner_user_id);
  END;
  CREATE TRIGGER IF NOT EXISTS replica_current_view_grant_update
    AFTER UPDATE OF status,revoked_at_ms,generation,principal_kind,principal_user_id,principal_email,parent_grant_id,access ON sync_relay_share_grants
    WHEN OLD.status='active' AND OLD.revoked_at_ms IS NULL AND NOT EXISTS (
      SELECT 1 FROM sync_relay_share_grants g JOIN sync_relay_shares s ON s.share_id=g.share_id
      WHERE g.grant_id=NEW.grant_id AND ${currentShareGrantSql("g", "s")})
    BEGIN
      DELETE FROM sync_relay_replica_cuts WHERE workspace_id=(SELECT workspace_id FROM sync_relay_shares WHERE share_id=NEW.share_id);
      DELETE FROM sync_relay_replica_cut_texts WHERE workspace_id=(SELECT workspace_id FROM sync_relay_shares WHERE share_id=NEW.share_id);
    END;
  CREATE TRIGGER IF NOT EXISTS replica_current_view_grant_delete AFTER DELETE ON sync_relay_share_grants
    WHEN OLD.status='active' AND OLD.revoked_at_ms IS NULL BEGIN
      DELETE FROM sync_relay_replica_cuts WHERE workspace_id=(SELECT workspace_id FROM sync_relay_shares WHERE share_id=OLD.share_id);
      DELETE FROM sync_relay_replica_cut_texts WHERE workspace_id=(SELECT workspace_id FROM sync_relay_shares WHERE share_id=OLD.share_id);
    END;
  CREATE TRIGGER IF NOT EXISTS replica_current_view_share_update AFTER UPDATE OF selector_json,workspace_id,granter_user_id ON sync_relay_shares BEGIN
    DELETE FROM sync_relay_replica_cuts WHERE workspace_id IN (OLD.workspace_id,NEW.workspace_id);
    DELETE FROM sync_relay_replica_cut_texts WHERE workspace_id IN (OLD.workspace_id,NEW.workspace_id);
  END;
  CREATE TRIGGER IF NOT EXISTS replica_current_view_share_delete AFTER DELETE ON sync_relay_shares BEGIN
    DELETE FROM sync_relay_replica_cuts WHERE workspace_id=OLD.workspace_id;
    DELETE FROM sync_relay_replica_cut_texts WHERE workspace_id=OLD.workspace_id;
  END;
  ${currentViewSweep}; DELETE FROM sync_relay_replica_cut_texts WHERE ref_count=0`);
}
