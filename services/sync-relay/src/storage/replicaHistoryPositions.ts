import type {StorageContext} from "./context";
import {replicaStatement as statement} from "./replicaStatements";
import type {ReplicaCurrentView} from "@dohc/workspace-engine-client/daemon";
import {objectMomentFromMomentValue} from "./currentFiles";

const historyAdmittedContent = `op_kind IN ('moment.append','ydoc.update') AND relay_admission IS NULL
  AND (settlement_admission_json IS NULL OR json_extract(settlement_admission_json,'$.status')<>'refused')`;

/** Find the end of the most recent proven lifetime of this exact state. */
export function replicaHistoryReplacement(storage: StorageContext, workspace: string, version: string, object: string,
  fromLog: number, toLog: number, fromJournal: number, toJournal: number,
  file: ReplicaCurrentView["files"][number]): [number | null, number | null] {
  const logs = statement(storage,`SELECT relay_seq,op_kind,CASE WHEN op_kind='moment.append' THEN payload_json END AS moment_payload,
    settlement_admission_json FROM sync_relay_log WHERE workspace_id=?
    AND json_extract(payload_json,'$.versionId')=? AND json_extract(payload_json,'$.objectId')=?
    AND relay_seq>? AND relay_seq<=? AND ${historyAdmittedContent}
    ORDER BY relay_seq LIMIT 10001`).all(workspace,version,object,fromLog,toLog);
  let log:number|null=null;
  for (const row of logs) {
    let same=false;
    if (row.op_kind==="moment.append") {
      const payload=JSON.parse(String(row.moment_payload));
      const moment=objectMomentFromMomentValue(payload);
      const binding=row.settlement_admission_json && JSON.parse(String(row.settlement_admission_json)).status==="accepted"
        ? payload.settlementReference?.record?.binding : undefined;
      same=moment?.blobSha256===file.sha256 && moment.path===file.path && moment.contentKind===file.contentKind &&
        (binding ? binding.lineageClaimId===file.lineageClaimId && binding.restoreFenceGeneration===file.restoreGeneration : file.lineageClaimId===null);
    }
    // Ordinary Y.Doc rows have no recorded projection. They remain replacements.
    log=same ? null : log ?? Number(row.relay_seq);
  }
  const updates = statement(storage,`SELECT j.journal_cursor,j.current_path,j.lineage_claim_id,j.restore_fence_generation,c.markdown_sha256
    FROM sync_relay_live_update_journal j LEFT JOIN sync_relay_live_settlement_cuts c ON c.journal_cursor=j.journal_cursor
    WHERE j.workspace_id=? AND j.main_version_id=? AND j.object_id=? AND j.journal_cursor>? AND j.journal_cursor<=?
    ORDER BY j.journal_cursor LIMIT 10001`).all(workspace,version,object,fromJournal,toJournal);
  let journal:number|null=null;
  for (const row of updates) {
    const same=row.markdown_sha256===file.sha256 && row.current_path===file.path && file.contentKind==="text" &&
      row.lineage_claim_id===file.lineageClaimId && row.restore_fence_generation===file.restoreGeneration;
    journal=same ? null : journal ?? Number(row.journal_cursor);
  }
  // An unseen suffix cannot prove a returned state.
  return [logs.length>10000 ? Number(logs[0]!.relay_seq) : log,updates.length>10000 ? Number(updates[0]!.journal_cursor) : journal];
}
