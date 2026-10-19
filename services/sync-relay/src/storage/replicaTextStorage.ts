import type {StorageContext} from "./context";
import {replicaStatement as statement} from "./replicaStatements";

export function replicaTextCleanupSql(workspace?: string) {
  const scope=workspace === undefined ? "" : `workspace_id=${workspace} AND `;
  return [`DELETE FROM sync_relay_replica_cut_texts WHERE (workspace_id,sha256) IN
    (SELECT workspace_id,sha256 FROM sync_relay_replica_cut_text_refs WHERE ${scope}ref_count=0)`,
    `DELETE FROM sync_relay_replica_cut_text_refs WHERE ${scope}ref_count=0`];
}
export function deleteUnreferencedReplicaTexts(storage: StorageContext, workspace: string) {
  for (const sql of replicaTextCleanupSql("?")) statement(storage,sql).run(workspace);
}

/** Caller authorized this SHA in the same read transaction. */
export function readReplicaText(storage: StorageContext, workspace: string, sha: string): string | null {
  const rows=statement(storage,`SELECT t.bytes FROM sync_relay_replica_cut_texts t
    JOIN sync_relay_replica_cut_text_refs r USING(workspace_id,sha256)
    WHERE t.workspace_id=? AND t.sha256=? AND r.ref_count>0 ORDER BY t.ordinal`).all(workspace,sha);
  return rows.length ? Buffer.concat(rows.map(r=>Buffer.from(r.bytes as Uint8Array))).toString("utf8") : null;
}
