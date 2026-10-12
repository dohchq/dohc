import type { StorageContext } from "./context";
import { currentShareGrantSql } from "./currentShareGrant";
import { referencedBlobShas } from "./blobReferences";

export function readReplicaStanding(storage: StorageContext, workspaceId: string, shareGrantBindings?: string) {
  storage.captureStanding();
  const row = storage.db.prepare(`SELECT w.owner_user_id, w.replication_epoch, w.stream_identity,
    COALESCE((SELECT MAX(relay_seq) FROM sync_relay_log WHERE workspace_id=w.workspace_id),0) AS log_seq,
    json_group_array(json_array(g.grant_id,g.generation)) AS share_grants
    FROM sync_relay_workspaces w JOIN sync_relay_shares s ON s.workspace_id=w.workspace_id
      JOIN sync_relay_share_grants g ON g.share_id=s.share_id
    WHERE w.workspace_id=? AND ${currentShareGrantSql("g", "s")}
      AND (? IS NULL OR EXISTS (SELECT 1 FROM json_each(?) binding
        WHERE json_extract(binding.value,'$[0]')=g.grant_id AND json_extract(binding.value,'$[1]')=g.generation))
    GROUP BY w.workspace_id`).get(workspaceId, shareGrantBindings ?? null, shareGrantBindings ?? null);
  if (!row || typeof row.owner_user_id !== "string" || typeof row.replication_epoch !== "string" ||
      typeof row.stream_identity !== "string") return null;
  return { workspaceId, ownerUserId: row.owner_user_id, replicationEpoch: row.replication_epoch,
    streamIdentity: row.stream_identity, logSeq: Number(row.log_seq), shareGrantBindings: String(row.share_grants) };
}

export function replicaBlobIsReferenced(storage: StorageContext, workspaceId: string, sha256: string): boolean {
  storage.captureStanding();
  // Coordinate reads can refer to rows below the epoch floor.
  const rows = storage.db.prepare(`SELECT op_kind,payload_json,recorded_at_ms FROM sync_relay_log
    WHERE workspace_id=? AND payload_json LIKE '%' || ? || '%'`).iterate(workspaceId, sha256);
  for (const row of rows) {
    if (referencedBlobShas(String(row.op_kind), String(row.payload_json), {
      workspaceId, recordedAtMs: Number(row.recorded_at_ms),
    }).includes(sha256)) return true;
  }
  return false;
}
