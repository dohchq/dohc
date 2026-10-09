use super::*;
use dohc_engine_collab::WriterDocCache;
use dohc_engine_storage::{
    MaterializationJobSpec, Preimage, TxnOutcome, enqueue_job, put_binary_blob,
};

#[derive(Default)]
pub struct OpenArtifactDrain {
    pub changes: Vec<MomentMaterializationChange>,
    pub record_facts: Vec<dohc_engine_domain::CollectionRecordApplyFacts>,
}

pub(super) fn enqueue(
    tx: &Transaction<'_>,
    envelope: &ReplicationEnvelope,
    payload: &MomentAppendPayload,
    claim: &str,
    head: Option<&Snapshot>,
) -> Result<(), SyncError> {
    let head = head.ok_or(SyncError::CoordinateDiverged)?;
    let encoded = serde_json::to_string(envelope).map_err(SyncError::corrupt)?;
    tx.execute(
        "INSERT INTO ydoc_pending_artifacts(workspace_id,version_id,object_id,moment_id,\
         lineage_claim_id,expected_head_moment_id,envelope_json) VALUES (?1,?2,?3,?4,?5,?6,?7)",
        params![
            envelope.workspace_id,
            payload.version_id,
            payload.object_id,
            payload.moment_id,
            claim,
            head.latest_moment_id,
            encoded
        ],
    )
    .map_err(SyncError::persist)?;
    Ok(())
}

/// Recover acknowledged editor artifacts after eviction or restart. A merged
/// local draft stays unsettled until its editor explicitly publishes it.
pub fn drain_open_document_artifacts(
    store: &mut EngineStore,
    cache: &mut WriterDocCache,
    workspace_id: &str,
    leases: &dyn LeaseProbe,
    faults: &dyn FaultInjector,
) -> Result<OpenArtifactDrain, SyncError> {
    let pending = store.read_with(|conn| {
        let mut stmt = conn
            .prepare(
                "SELECT envelope_json,lineage_claim_id,expected_head_moment_id \
            FROM ydoc_pending_artifacts WHERE workspace_id=?1 ORDER BY rowid",
            )
            .map_err(SyncError::corrupt)?;
        stmt.query_map([workspace_id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })
        .map_err(SyncError::corrupt)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(SyncError::corrupt)
    })?;
    let mut result = OpenArtifactDrain::default();
    if pending.is_empty() {
        return Ok(result);
    }
    let policy = search_policy_for_store(store);
    for (encoded, claim, expected_head) in pending {
        let envelope: ReplicationEnvelope =
            serde_json::from_str(&encoded).map_err(SyncError::corrupt)?;
        let payload: MomentAppendPayload =
            serde_json::from_value(envelope.payload.clone()).map_err(SyncError::corrupt)?;
        let key = DocKey::new(workspace_id, &payload.version_id, &payload.object_id)
            .map_err(SyncError::corrupt)?;
        if leases.is_live(&key) {
            continue;
        }
        let ready: bool = store.read_with(|conn| conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM ydoc_pending_artifacts p JOIN ydoc_docs d \
             USING(workspace_id,version_id,object_id) WHERE p.workspace_id=?1 AND p.version_id=?2 \
             AND p.object_id=?3 AND p.moment_id=?4 AND d.lineage_claim_status='exact' \
             AND d.lineage_claim_id=?5 AND NOT EXISTS(SELECT 1 FROM ydoc_deferred_updates u \
               WHERE u.workspace_id=?1 AND u.version_id=?2 AND u.object_id=?3 AND u.lineage_claim_id IS NOT ?5))",
            params![workspace_id,key.version_id,key.object_id,payload.moment_id,claim],|r|r.get(0))
            .map_err(SyncError::corrupt))?;
        if !ready {
            continue;
        }
        // Integrate the acknowledged updates without publishing a local draft.
        let drained = crate::ydoc_apply::drain_deferred_ydoc_for_artifact(
            store, cache, &key, &claim, faults,
        )?;
        result.record_facts.extend(drained.record_facts);
        let recovered = store.write_with(faults, |tx| {
            let exists: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM ydoc_pending_artifacts \
                WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3 AND moment_id=?4)",
                params![workspace_id,key.version_id,key.object_id,payload.moment_id],|r|r.get(0)).map_err(SyncError::corrupt)?;
            if !exists {
                return Ok(Vec::new());
            }
            let Some(head) = select_snapshot_by_object(tx,workspace_id,&key.version_id,&key.object_id)? else {
                return Ok(Vec::new());
            };
            if head.latest_moment_id != expected_head || head.path != payload.payload_after_path
                || head.kind != ContentKind::Text || is_bound_owner(tx,&key)
                || crate::ydoc_apply::open_sync_conflict_for_object(tx,workspace_id,&key.version_id,&key.object_id)?.is_some()
            {
                return Ok(Vec::new());
            }
            let complete = crate::ydoc_apply::ensure_ydoc_lineage_complete_in_tx(tx,&key)?;
            let text = require_blob_text(tx,&payload.payload_after_blob_sha256)?;
            // This is the closed-document equality check, in the publication transaction.
            crate::ydoc_apply::reconcile_imported_complete_resulting_head_in_tx(tx,&complete,
                crate::ResultingHead::Text { path:&payload.payload_after_path,text:&text },envelope.recorded_at_ms)?;
            upsert_snapshot(tx,workspace_id,&payload,ContentKind::Text,text.len() as i64)?;
            tx.execute("UPDATE moments SET sync_record_only=NULL WHERE workspace_id=?1 AND moment_id=?2",
                params![workspace_id,payload.moment_id]).map_err(SyncError::persist)?;
            upsert_search_row(tx,workspace_id,&payload,ContentKind::Text,&text,policy.as_ref())?;
            tx.execute("DELETE FROM ydoc_pending_artifacts WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
                params![workspace_id,key.version_id,key.object_id]).map_err(SyncError::persist)?;
            if !is_active_version(tx,workspace_id,&key.version_id)? {
                return Ok(Vec::new());
            }
            let generation: i64 = tx.query_row("SELECT moment_order FROM moments WHERE workspace_id=?1 AND moment_id=?2",
                params![workspace_id,payload.moment_id],|r|r.get(0)).map_err(SyncError::corrupt)?;
            put_binary_blob(tx,text.as_bytes())?;
            enqueue_job(tx,&MaterializationJobSpec {
                job_id:format!("ydoc-mat_{}",payload.moment_id),workspace_id:workspace_id.to_owned(),
                target_path:payload.payload_after_path.clone(),content_sha256:payload.payload_after_blob_sha256.clone(),
                preimage:Preimage::Present(head.digest),target_generation:generation,now_ms:envelope.recorded_at_ms,
            })?;
            Ok(vec![MomentMaterializationChange { version_id:key.version_id.clone(),path:payload.payload_after_path.clone(),operation:"write",content_kind:"text" }])
        });
        match recovered {
            Ok(TxnOutcome::Committed(changes)) => result.changes.extend(changes),
            Ok(TxnOutcome::Crashed { .. }) => return Err(SyncError::FaultCrash),
            Err(SyncError::RetryableState { .. } | SyncError::LiveDocumentBindingActive) => {}
            Err(error) => return Err(error),
        }
        cache.remove(&key);
    }
    Ok(result)
}
