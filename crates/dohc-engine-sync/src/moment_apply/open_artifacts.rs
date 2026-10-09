use super::*;
use dohc_engine_collab::WriterDocCache;
use dohc_engine_storage::TxnOutcome;

pub(crate) const RECOVERY_FAILURE: &str = "dohc could not write this document's changes to its file. Open the document and try saving again.";

#[derive(Default)]
pub struct OpenArtifactDrain {
    pub changes: Vec<MomentMaterializationChange>,
    pub record_facts: Vec<dohc_engine_domain::CollectionRecordApplyFacts>,
    pub refusals: Vec<crate::ReplicationRefusal>,
    pub sharing_declined: Vec<crate::SharingDeclined>,
    pub conflicts_opened: i64,
}

pub(super) fn enqueue(
    tx: &Transaction<'_>,
    envelope: &ReplicationEnvelope,
    payload: &MomentAppendPayload,
    claim: &str,
) -> Result<(), SyncError> {
    tx.execute(
        "INSERT INTO ydoc_pending_artifacts(workspace_id,version_id,object_id,moment_id,origin_id,origin_seq,lineage_claim_id) \
         VALUES (?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(workspace_id,version_id,object_id) DO UPDATE SET \
         moment_id=excluded.moment_id,origin_id=excluded.origin_id,origin_seq=excluded.origin_seq, \
         lineage_claim_id=excluded.lineage_claim_id,last_attempt_state=NULL",
        params![envelope.workspace_id,payload.version_id,payload.object_id,payload.moment_id,envelope.origin_id,envelope.origin_seq,claim],
    ).map_err(SyncError::persist)?;
    Ok(())
}

fn state(conn: &rusqlite::Connection, key: &DocKey) -> Result<String, SyncError> {
    conn.query_row(
        "SELECT json_array(d.head_update_seq,d.head_snapshot_seq,d.last_local_update_seq,d.settled_update_seq, \
         d.last_settled_sha,d.settle_prior_update_seq,d.lineage_claim_id,d.path,d.updated_at_ms, \
         (SELECT latest_moment_id FROM snapshots s WHERE s.workspace_id=d.workspace_id AND s.version_id=d.version_id AND s.object_id=d.object_id), \
         (SELECT json_array(COUNT(*),MAX(rowid)) FROM ydoc_deferred_updates u WHERE u.workspace_id=d.workspace_id AND u.version_id=d.version_id AND u.object_id=d.object_id), \
         (SELECT COUNT(b.sha256) FROM ydoc_deferred_updates u JOIN replication_log r USING(workspace_id,origin_id,origin_seq) LEFT JOIN binary_blobs b ON b.sha256=json_extract(r.payload_json,'$.updateBlobSha256') WHERE u.workspace_id=d.workspace_id AND u.version_id=d.version_id AND u.object_id=d.object_id), \
         (SELECT COUNT(b.sha256) FROM ydoc_snapshots y LEFT JOIN binary_blobs b ON b.sha256=y.snapshot_blob_sha256 OR b.sha256=y.state_vector_blob_sha256 WHERE y.workspace_id=d.workspace_id AND y.version_id=d.version_id AND y.object_id=d.object_id), \
         (SELECT EXISTS(SELECT 1 FROM snapshots s JOIN blobs b ON b.sha256=s.blob_sha256 WHERE s.workspace_id=d.workspace_id AND s.version_id=d.version_id AND s.object_id=d.object_id)), \
         (SELECT group_concat(operation_id || COALESCE(resume_receipt_json,'')) FROM live_restore_fences f WHERE f.workspace_id=d.workspace_id AND f.main_version_id=d.version_id AND f.object_id=d.object_id), \
         (SELECT COUNT(*) FROM conflicts c WHERE c.workspace_id=d.workspace_id AND c.target_version_id=d.version_id AND c.status='open' AND (c.current_object_id=d.object_id OR c.incoming_object_id=d.object_id))) \
         FROM ydoc_docs d WHERE d.workspace_id=?1 AND d.version_id=?2 AND d.object_id=?3",
        params![key.workspace_id,key.version_id,key.object_id], |row| row.get(0),
    ).map_err(SyncError::corrupt)
}

pub(crate) fn remember_attempt_in_tx(tx: &Transaction<'_>, key: &DocKey) -> Result<(), SyncError> {
    let pending:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM ydoc_pending_artifacts WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3)",params![key.workspace_id,key.version_id,key.object_id],|row|row.get(0)).map_err(SyncError::corrupt)?;
    if pending {
        let fingerprint = state(tx, key)?;
        tx.execute("UPDATE ydoc_pending_artifacts SET last_attempt_state=?4 WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",params![key.workspace_id,key.version_id,key.object_id,fingerprint]).map_err(SyncError::persist)?;
    }
    Ok(())
}

/// Recover sessions that ended without publishing. Local drafts still require settlement.
pub fn drain_open_document_artifacts(
    store: &mut EngineStore,
    cache: &mut WriterDocCache,
    workspace_id: &str,
    leases: &dyn LeaseProbe,
    faults: &dyn FaultInjector,
) -> Result<OpenArtifactDrain, SyncError> {
    let keys = store.read_with(|conn| {
        let mut stmt = conn.prepare("SELECT version_id,object_id FROM ydoc_pending_artifacts WHERE workspace_id=?1 ORDER BY rowid")
            .map_err(SyncError::corrupt)?;
        stmt.query_map([workspace_id], |row| Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?)))
            .map_err(SyncError::corrupt)?.collect::<Result<Vec<_>,_>>().map_err(SyncError::corrupt)
    })?;
    let mut result = OpenArtifactDrain::default();
    for (version, object) in keys {
        let key = DocKey::new(workspace_id, version, object).map_err(SyncError::corrupt)?;
        if leases.is_live(&key) {
            continue;
        }
        let attempt = (|| {
            let ready = store.write_with(faults, |tx| -> Result<bool,SyncError> {
                if leases.is_live(&key) { return Ok(false); }
                let pending: Option<(bool,Option<String>)> = tx.query_row(
                    "SELECT d.last_local_update_seq<=COALESCE(d.settled_update_seq,0),p.last_attempt_state \
                     FROM ydoc_pending_artifacts p JOIN ydoc_docs d USING(workspace_id,version_id,object_id) \
                     WHERE p.workspace_id=?1 AND p.version_id=?2 AND p.object_id=?3",
                    params![workspace_id,key.version_id,key.object_id], |row| Ok((row.get(0)?,row.get(1)?)),
                ).optional().map_err(SyncError::corrupt)?;
                let Some((true, previous)) = pending else { return Ok(false); };
                Ok(previous.as_deref()!=Some(state(tx,&key)?.as_str()))
            })?;
            match ready {
                TxnOutcome::Committed(false) => return Ok(None),
                TxnOutcome::Crashed { .. } => return Err(SyncError::FaultCrash),
                TxnOutcome::Committed(true) => {}
            }
            let before = store.read_with(|conn| {
                select_snapshot_by_object(conn, workspace_id, &key.version_id, &key.object_id)
            })?;
            let drained = crate::ydoc_apply::drain_deferred_ydoc_for_ended_session(
                store, cache, &key, leases, faults,
            )?;
            let after = store.read_with(|conn| {
                select_snapshot_by_object(conn, workspace_id, &key.version_id, &key.object_id)
            })?;
            let change = after
                .filter(|after| {
                    before
                        .as_ref()
                        .is_none_or(|before| before.latest_moment_id != after.latest_moment_id)
                })
                .map(|head| MomentMaterializationChange {
                    version_id: key.version_id.clone(),
                    path: head.path,
                    operation: "write",
                    content_kind: "text",
                });
            Ok(Some((drained, change)))
        })();
        match attempt {
            Ok(Some((drained, change))) => {
                result.changes.extend(change);
                result.record_facts.extend(drained.record_facts);
                result.refusals.extend(drained.refusals);
                result.sharing_declined.extend(drained.sharing_declined);
                result.conflicts_opened += drained.conflicts_opened;
            }
            Ok(None) => continue,
            Err(SyncError::FaultCrash) => return Err(SyncError::FaultCrash),
            Err(SyncError::LiveDocumentBindingActive) => continue,
            Err(_) => {
                // A local recovery failure is a notice on the settlement, not a refused update.
                let recorded = store.write_with(faults, |tx| {
                    if leases.is_live(&key) { return Ok(()); }
                    remember_attempt_in_tx(tx,&key)?;
                    tx.execute("INSERT OR IGNORE INTO replication_pending_refusals(workspace_id,origin_id,origin_seq,op_kind,reason_code,reason_message) \
                        SELECT workspace_id,origin_id,origin_seq,'moment.append','invalid-input',?4 FROM ydoc_pending_artifacts \
                        WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
                        params![workspace_id,key.version_id,key.object_id,RECOVERY_FAILURE]).map_err(SyncError::persist)?;
                    Ok::<_,SyncError>(())
                });
                if matches!(recorded, Ok(TxnOutcome::Crashed { .. })) {
                    return Err(SyncError::FaultCrash);
                }
            }
        }
        cache.remove(&key);
    }
    Ok(result)
}
