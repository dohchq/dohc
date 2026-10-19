import type {SqliteDb} from "./types";
import {replicaTextCleanupSql} from "./replicaTextStorage";

export function initializeReplicaCurrentViewIncrementalSchema(db: SqliteDb) {
  const migration="replica-current-incremental-v1";
  if(db.prepare("SELECT 1 FROM sync_relay_migrations WHERE migration_id=?").get(migration))return;
  db.exec(`CREATE TABLE sync_relay_replica_cut_omitted (
    workspace_id TEXT NOT NULL REFERENCES sync_relay_replica_cuts(workspace_id) ON DELETE CASCADE,
    version_id TEXT NOT NULL,object_id TEXT NOT NULL,path TEXT NOT NULL,sha256 TEXT NOT NULL,reason TEXT NOT NULL,
    PRIMARY KEY(workspace_id,version_id,object_id),UNIQUE(workspace_id,version_id,path)
  ) STRICT;
  INSERT INTO sync_relay_replica_cut_omitted SELECT c.workspace_id,json_extract(o.value,'$.versionId'),
    json_extract(o.value,'$.objectId'),json_extract(o.value,'$.path'),json_extract(o.value,'$.sha256'),json_extract(o.value,'$.reason')
    FROM sync_relay_replica_cuts c,json_each(c.omitted_json) o;
  ${replicaTextCleanupSql().join("; ")};`);
  db.prepare("INSERT INTO sync_relay_migrations VALUES (?,?)").run(migration,Date.now());
}
