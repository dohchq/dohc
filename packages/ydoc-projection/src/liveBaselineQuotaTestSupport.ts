import type { DatabaseSync } from 'node:sqlite'

export function liveBaselineStoredBytes(db: DatabaseSync): number {
  const documents = db.prepare(`SELECT workspace_id,main_version_id,object_id,lineage_claim_id,
    replaces_lineage_claim_id,current_path,baseline_moment_relay_seq,baseline_projected_sha256,
    baseline_projected_byte_length,baseline_digest,lineage_state,admission_state,
    restore_fence_generation,registered_at_ms,retired_at_ms,baseline_bytes
    FROM sync_relay_live_documents WHERE workspace_id='workspace'`).all()
  const ranges = db.prepare(`SELECT workspace_id,main_version_id,object_id,lineage_claim_id,
    client_id,start_clock,end_clock FROM sync_relay_live_document_baseline_ranges
    WHERE workspace_id='workspace'`).all()
  return documents.reduce((sum, { baseline_bytes, ...metadata }) =>
    sum + (baseline_bytes as Uint8Array).byteLength + Buffer.byteLength(JSON.stringify(Object.values(metadata))), 0)
    + ranges.reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(Object.values(row))), 0)
}
