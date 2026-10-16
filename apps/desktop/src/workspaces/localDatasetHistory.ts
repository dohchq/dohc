import { historyActivitySql, historyStatement, readDatasetHistoryHeads } from "@dohc/app-backend-runtime/dataset-host";
import type { JournalDb } from "@dohc/app-backend-runtime/journal";

export interface LocalDatasetHistoryInput {
  positions?: Array<{ datasetId: string; beforeRevision: number }>;
  limit?: number;
  sourceIds?: string[];
}

/** Source discovery and heads must see the same read transaction. */
export function readLocalDatasetHistory(db: JournalDb, workspaceId: string, input: LocalDatasetHistoryInput) {
  const identities = "SELECT c.dataset_id FROM dohc_dataset_catalog c LEFT JOIN dohc_dataset_lifecycle l ON l.workspace_id=c.workspace_id AND l.dataset_id=c.dataset_id WHERE c.workspace_id=? AND COALESCE(l.archived,0)=0 UNION SELECT dataset_id FROM local_dataset_transfers WHERE workspace_id=?";
  const sourceIds = input.sourceIds ?? historyStatement(db, `SELECT c.dataset_id FROM (${identities}) c LEFT JOIN dohc_dataset_journals j ON j.workspace_id=? AND j.dataset_id=c.dataset_id ORDER BY ${historyActivitySql} DESC,c.dataset_id LIMIT 129`)
    .all(workspaceId, workspaceId, workspaceId).map(row => String(row.dataset_id));
  const transferred = historyStatement(db, "SELECT dataset_id FROM local_dataset_transfers WHERE workspace_id=? AND dataset_id IN (SELECT value FROM json_each(?))")
    .all(workspaceId, JSON.stringify(sourceIds)).map(row => String(row.dataset_id));
  const sourceCount = input.positions ? 0 : Number(historyStatement(db, `SELECT count(*) AS count FROM (${identities})`).get(workspaceId, workspaceId)?.count ?? 0);
  const positions = input.positions ?? sourceIds.filter(id => !transferred.includes(id)).map(datasetId => ({ datasetId, beforeRevision: Number.MAX_SAFE_INTEGER }));
  return { transferred, sourceIds, sourceCount, pages: readDatasetHistoryHeads(db, { workspaceId, positions, limit: input.limit, skip: transferred }) };
}
