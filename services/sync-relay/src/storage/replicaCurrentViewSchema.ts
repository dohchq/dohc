import type {SqliteDb} from "./types";
import {currentShareGrantSql} from "./currentShareGrant";

const currentShare = `EXISTS (SELECT 1 FROM sync_relay_shares s JOIN sync_relay_share_grants g ON g.share_id=s.share_id
  WHERE s.workspace_id=sync_relay_replica_cuts.workspace_id AND ${currentShareGrantSql("g","s")})`;
export const currentViewSweep = `DELETE FROM sync_relay_replica_cuts WHERE NOT ${currentShare};
  DELETE FROM sync_relay_replica_cut_texts WHERE NOT EXISTS (SELECT 1 FROM sync_relay_shares s JOIN sync_relay_share_grants g ON g.share_id=s.share_id
    WHERE s.workspace_id=sync_relay_replica_cut_texts.workspace_id AND ${currentShareGrantSql("g","s")})`;

export function initializeReplicaCurrentViewSchema(db: SqliteDb) {
  db.exec(`CREATE TABLE IF NOT EXISTS sync_relay_replica_cuts (
    workspace_id TEXT PRIMARY KEY REFERENCES sync_relay_workspaces(workspace_id) ON DELETE CASCADE,
    replication_epoch TEXT NOT NULL, stream_identity TEXT NOT NULL, incarnation TEXT NOT NULL,
    cut_seq INTEGER NOT NULL CHECK(cut_seq>0), revision INTEGER NOT NULL CHECK(revision>=0),
    log_cursor INTEGER NOT NULL CHECK(log_cursor>=0), journal_cursor INTEGER NOT NULL CHECK(journal_cursor>=0)
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
    ${currentViewSweep};
  END;`);
  for (const table of ["sync_relay_share_grants", "sync_relay_shares"]) {
    for (const event of ["UPDATE", "DELETE"]) db.exec(`CREATE TRIGGER IF NOT EXISTS replica_current_view_${table}_${event}
      AFTER ${event} ON ${table} BEGIN ${currentViewSweep}; END;`);
  }
  db.exec(`${currentViewSweep}; DELETE FROM sync_relay_replica_cut_texts WHERE ref_count=0`);
}
