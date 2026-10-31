import type { StorageContext } from "./context";
import { currentShareGrantSql } from "./currentShareGrant";
import { LIVE_RESTORE_CANCELLATIONS } from "./liveRestoreCancellationSchema";

const standingStatements = new WeakMap<StorageContext, ReturnType<StorageContext["db"]["prepare"]>>();
export function readReplicaStanding(storage: StorageContext, workspaceId: string, shareGrantBindings?: string) {
  storage.captureStanding();
  let statement = standingStatements.get(storage);
  if (!statement) {
    statement = storage.db.prepare(`SELECT w.owner_user_id, w.replication_epoch, w.stream_identity, w.epoch_log_floor,
    COALESCE((SELECT MAX(relay_seq) FROM sync_relay_log WHERE workspace_id=w.workspace_id),0) AS log_seq,
    MAX(COALESCE((SELECT MAX(journal_cursor) FROM sync_relay_live_update_journal WHERE workspace_id=w.workspace_id),0),
      COALESCE((SELECT MAX(journal_cursor) FROM ${LIVE_RESTORE_CANCELLATIONS} WHERE workspace_id=w.workspace_id AND journal_cursor IS NOT NULL),0)) AS journal_cursor,
    json_group_array(json_array(g.grant_id,g.generation)) AS share_grants
    FROM sync_relay_workspaces w JOIN sync_relay_shares s ON s.workspace_id=w.workspace_id
      JOIN sync_relay_share_grants g ON g.share_id=s.share_id
    WHERE w.workspace_id=? AND ${currentShareGrantSql("g", "s")}
      AND (? IS NULL OR EXISTS (SELECT 1 FROM json_each(?) binding
        WHERE json_extract(binding.value,'$[0]')=g.grant_id AND json_extract(binding.value,'$[1]')=g.generation))
    GROUP BY w.workspace_id`);
    standingStatements.set(storage,statement);
  }
  const row = statement.get(workspaceId, shareGrantBindings ?? null, shareGrantBindings ?? null);
  if (!row || typeof row.owner_user_id !== "string" || typeof row.replication_epoch !== "string" ||
      typeof row.stream_identity !== "string") return null;
  return { workspaceId, ownerUserId: row.owner_user_id, replicationEpoch: row.replication_epoch,
    streamIdentity: row.stream_identity, epochLogFloor: Number(row.epoch_log_floor), logSeq: Number(row.log_seq), journalCursor: Number(row.journal_cursor),
    shareGrantBindings: String(row.share_grants) };
}
