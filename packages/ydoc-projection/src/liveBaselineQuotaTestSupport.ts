import type { DatabaseSync } from 'node:sqlite'

export function liveBaselineStoredBytes(db: DatabaseSync): number {
  const documents = db.prepare(`SELECT * FROM sync_relay_live_documents WHERE workspace_id='workspace'`).all()
  const ranges = db.prepare(`SELECT * FROM sync_relay_live_document_baseline_ranges
    WHERE workspace_id='workspace'`).all()
  return documents.reduce((sum, { baseline_bytes, ...metadata }) =>
    sum + (baseline_bytes as Uint8Array).byteLength + Buffer.byteLength(JSON.stringify(Object.values(metadata))), 0)
    + ranges.reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(Object.values(row))), 0)
}
