import type {SqliteDb} from "./types";
import {replicaTextCleanupSql} from "./replicaTextStorage";

export function initializeReplicaCurrentViewIncrementalSchema(db: SqliteDb) {
  const migration="replica-current-incremental-v1";
  if(db.prepare("SELECT 1 FROM sync_relay_migrations WHERE migration_id=?").get(migration))return;
  db.exec(`CREATE TABLE sync_relay_replica_cut_omitted (
    workspace_id TEXT NOT NULL REFERENCES sync_relay_replica_cuts(workspace_id) ON DELETE CASCADE,
    version_id TEXT NOT NULL,object_id TEXT NOT NULL,path TEXT NOT NULL,sha256 TEXT NOT NULL CHECK(length(sha256)=64 AND sha256 NOT GLOB '*[^0-9a-f]*'),reason TEXT NOT NULL CHECK(reason='text-frame-limit'),
    PRIMARY KEY(workspace_id,version_id,object_id),UNIQUE(workspace_id,version_id,path)
  ) STRICT;
  INSERT INTO sync_relay_replica_cut_omitted SELECT c.workspace_id,json_extract(o.value,'$.versionId'),
    json_extract(o.value,'$.objectId'),json_extract(o.value,'$.path'),json_extract(o.value,'$.sha256'),json_extract(o.value,'$.reason')
    FROM sync_relay_replica_cuts c,json_each(c.omitted_json) o;
  ALTER TABLE sync_relay_replica_cuts DROP COLUMN omitted_json;
  ${replicaTextCleanupSql().join("; ")};`);
  // Preserve the standing predicates and cleanup; delete doomed pins before the cut recounts them.
  for(const suffix of ["grant_update","grant_delete","share_update","share_delete"]) {
    const name=`replica_current_view_${suffix}`;
    const original=String(db.prepare("SELECT sql FROM sqlite_schema WHERE name=?").get(name)!.sql);
    const ordered=original.replace(/DELETE FROM sync_relay_replica_cuts( WHERE[^;]+;)/g,
      "DELETE FROM sync_relay_history_pins$1\nDELETE FROM sync_relay_replica_cuts$1");
    if(ordered===original)throw new Error(`Terminal cleanup rewrite did not match ${name}`);
    db.exec(`DROP TRIGGER ${name}; ${ordered}`);
  }
  db.prepare("INSERT INTO sync_relay_migrations VALUES (?,?)").run(migration,Date.now());
}
