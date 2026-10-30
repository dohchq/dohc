use super::*;
use dohc_engine_collab::WriterDocCache;
use dohc_engine_storage::{StorageError, TxnOutcome};

pub(crate) const RECOVERY_FAILURE_CODE: &str = "document-artifact-recovery-failed";

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

const RECOVERY_STATE_SQL: &str = "SELECT json_array(d.head_update_seq,d.head_snapshot_seq,d.last_local_update_seq,d.settled_update_seq, \
         d.last_settled_sha,d.settle_prior_update_seq,d.lineage_claim_id,d.path,d.updated_at_ms, \
         (SELECT latest_moment_id FROM snapshots s WHERE s.workspace_id=d.workspace_id AND s.version_id=d.version_id AND s.object_id=d.object_id), \
         (SELECT json_array(COUNT(*),MAX(rowid)) FROM ydoc_deferred_updates u WHERE u.workspace_id=d.workspace_id AND u.version_id=d.version_id AND u.object_id=d.object_id), \
         (SELECT EXISTS(SELECT 1 FROM snapshots s JOIN blobs b ON b.sha256=s.blob_sha256 WHERE s.workspace_id=d.workspace_id AND s.version_id=d.version_id AND s.object_id=d.object_id)), \
         (SELECT group_concat(operation_id || COALESCE(resume_receipt_json,'')) FROM live_restore_fences f WHERE f.workspace_id=d.workspace_id AND f.main_version_id=d.version_id AND f.object_id=d.object_id), \
         (SELECT COUNT(*) FROM conflicts c WHERE c.workspace_id=d.workspace_id AND c.target_version_id=d.version_id AND c.status='open' AND (c.current_object_id=d.object_id OR c.incoming_object_id=d.object_id))) \
         FROM ydoc_docs d WHERE d.workspace_id=?1 AND d.version_id=?2 AND d.object_id=?3";

fn state(conn: &rusqlite::Connection, key: &DocKey) -> Result<String, SyncError> {
    conn.query_row(
        RECOVERY_STATE_SQL,
        params![key.workspace_id, key.version_id, key.object_id],
        |row| row.get(0),
    )
    .map_err(SyncError::corrupt)
}

pub(crate) fn clear_settled_mark_in_tx(
    tx: &Transaction<'_>,
    key: &DocKey,
) -> Result<bool, SyncError> {
    // Re-run the settlement trigger when the mark arrived after the live projection.
    tx.execute("UPDATE ydoc_docs SET settled_update_seq=settled_update_seq \
         WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3 \
         AND settle_prior_update_seq IS NULL AND settled_update_seq=head_update_seq \
         AND EXISTS(SELECT 1 FROM ydoc_pending_artifacts p WHERE p.workspace_id=?1 AND p.version_id=?2 AND p.object_id=?3) \
         AND NOT EXISTS(SELECT 1 FROM ydoc_deferred_updates u WHERE u.workspace_id=?1 AND u.version_id=?2 AND u.object_id=?3) \
         AND EXISTS(SELECT 1 FROM snapshots s WHERE s.workspace_id=?1 AND s.version_id=?2 AND s.object_id=?3 AND s.blob_sha256=ydoc_docs.last_settled_sha)",
         params![key.workspace_id,key.version_id,key.object_id]).map(|rows|rows!=0).map_err(SyncError::persist)
}

#[derive(serde::Serialize, serde::Deserialize)]
struct SavedAttempt {
    state: String,
    missing_blob: Option<String>,
}

fn attempt_is_unchanged(
    conn: &rusqlite::Connection,
    key: &DocKey,
    previous: &str,
) -> Result<bool, SyncError> {
    let previous: SavedAttempt = serde_json::from_str(previous).map_err(SyncError::corrupt)?;
    if previous.state != state(conn, key)? {
        return Ok(false);
    }
    if let Some(sha) = previous.missing_blob {
        let restored: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM binary_blobs WHERE sha256=?1)",
                [sha],
                |row| row.get(0),
            )
            .map_err(SyncError::corrupt)?;
        return Ok(!restored);
    }
    Ok(true)
}

pub(crate) fn remember_attempt_in_tx(tx: &Transaction<'_>, key: &DocKey) -> Result<(), SyncError> {
    let pending:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM ydoc_pending_artifacts WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3)",params![key.workspace_id,key.version_id,key.object_id],|row|row.get(0)).map_err(SyncError::corrupt)?;
    if pending {
        // Find one missing blob only after a failed/unfinished attempt, never on an unchanged pull.
        let missing_blob:Option<String>=tx.query_row("SELECT sha FROM (
            SELECT lineage_claim_id AS sha FROM ydoc_docs WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3
            UNION ALL SELECT update_blob_sha256 FROM ydoc_updates WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3
            UNION ALL SELECT snapshot_blob_sha256 FROM ydoc_snapshots WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3
            UNION ALL SELECT state_vector_blob_sha256 FROM ydoc_snapshots WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3
            UNION ALL SELECT json_extract(r.payload_json,'$.updateBlobSha256') FROM ydoc_deferred_updates u JOIN replication_log r USING(workspace_id,origin_id,origin_seq) WHERE u.workspace_id=?1 AND u.version_id=?2 AND u.object_id=?3
            ) refs WHERE sha IS NOT NULL AND NOT EXISTS(SELECT 1 FROM binary_blobs b WHERE b.sha256=refs.sha) LIMIT 1",
            params![key.workspace_id,key.version_id,key.object_id],|row|row.get(0)).optional().map_err(SyncError::corrupt)?;
        let fingerprint = serde_json::to_string(&SavedAttempt {
            state: state(tx, key)?,
            missing_blob,
        })
        .map_err(SyncError::corrupt)?;
        tx.execute("UPDATE ydoc_pending_artifacts SET last_attempt_state=?4 WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",params![key.workspace_id,key.version_id,key.object_id,fingerprint]).map_err(SyncError::persist)?;
    }
    Ok(())
}

pub(crate) fn record_recovery_failure_in_tx(
    tx: &Transaction<'_>,
    key: &DocKey,
) -> Result<(), SyncError> {
    tx.execute(
        "INSERT OR IGNORE INTO replication_pending_refusals(workspace_id,origin_id,origin_seq,op_kind,reason_code,reason_message) \
         SELECT workspace_id,origin_id,origin_seq,'moment.append',?4,?5 FROM ydoc_pending_artifacts \
         WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
        params![key.workspace_id,key.version_id,key.object_id,RECOVERY_FAILURE_CODE,RECOVERY_FAILURE],
    ).map_err(SyncError::persist)?;
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
    let mut pending = None;
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
                if clear_settled_mark_in_tx(tx, &key)? { return Ok(false); }
                match previous {
                    Some(previous)=>Ok(!attempt_is_unchanged(tx,&key,&previous)?),
                    None=>Ok(true),
                }
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
            Err(
                error @ (SyncError::MarkdownWitnessCheckPending { .. }
                | SyncError::MarkdownReaderPending(_)),
            ) => {
                pending.get_or_insert(error);
                continue;
            }
            Err(error) => {
                if !isolate_document_failure(error)? {
                    continue;
                }
                let recorded = store.write_with(faults, |tx| {
                    if leases.is_live(&key) {
                        return Ok(());
                    }
                    remember_attempt_in_tx(tx, &key)?;
                    record_recovery_failure_in_tx(tx, &key)?;
                    Ok::<_, SyncError>(())
                })?;
                if matches!(recorded, TxnOutcome::Crashed { .. }) {
                    return Err(SyncError::FaultCrash);
                }
            }
        }
        cache.remove(&key);
    }
    if let Some(error) = pending
        && result.changes.is_empty()
        && result.record_facts.is_empty()
        && result.refusals.is_empty()
        && result.sharing_declined.is_empty()
        && result.conflicts_opened == 0
    {
        return Err(error);
    }
    Ok(result)
}

fn isolate_document_failure(error: SyncError) -> Result<bool, SyncError> {
    match error {
        SyncError::RetryableState { .. } | SyncError::LiveDocumentBindingActive => Ok(false),
        SyncError::Storage(StorageError::StateCorrupt { ref source })
            if source
                .as_deref()
                .and_then(|source| source.downcast_ref::<rusqlite::Error>())
                .and_then(rusqlite::Error::sqlite_error_code)
                .is_some_and(|code| {
                    matches!(
                        code,
                        rusqlite::ErrorCode::SystemIoFailure
                            | rusqlite::ErrorCode::DiskFull
                            | rusqlite::ErrorCode::CannotOpen
                            | rusqlite::ErrorCode::OutOfMemory
                            | rusqlite::ErrorCode::DatabaseBusy
                            | rusqlite::ErrorCode::DatabaseLocked
                            | rusqlite::ErrorCode::PermissionDenied
                            | rusqlite::ErrorCode::ReadOnly
                    )
                }) =>
        {
            Err(error)
        }
        SyncError::BlobInvalid
        | SyncError::InvalidInput { .. }
        | SyncError::ProjectionTooLarge { .. }
        | SyncError::Storage(
            StorageError::StateCorrupt { .. } | StorageError::BlobIntegrity { .. },
        ) => Ok(true),
        hard => Err(hard),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn recovery_with_empty_queue(status: &str) -> (dohc_engine_testkit::ScratchDir, EngineStore) {
        let (scratch, mut store, key, _, _) = crate::moment_apply_tests::ended_recovery_fixture();
        let bytes = store.read_with(|conn| conn.query_row(
            "SELECT b.bytes FROM binary_blobs b JOIN replication_log r ON b.sha256=json_extract(r.payload_json,'$.updateBlobSha256') WHERE r.origin_seq=1",
            [], |row|row.get::<_,Vec<u8>>(0))).unwrap();
        dohc_engine_collab::apply_remote_update(
            &mut store,
            &mut Default::default(),
            &key,
            &dohc_engine_collab::RemoteUpdate {
                origin_id: "peer".into(),
                origin_seq: 1,
                bytes,
            },
            None,
            None,
            &dohc_engine_storage::NoFaults,
            2000,
        )
        .unwrap();
        dohc_engine_domain::VersionedTextStore::new(&mut store)
            .write_text(
                &dohc_engine_domain::WriteText {
                    workspace_id: "ws".into(),
                    version_id: "main".into(),
                    object_id: "object".into(),
                    path: "head.md".into(),
                    text: "before remote".into(),
                    moment_id: "recovery-write".into(),
                    metadata_origin: "ydoc".into(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: None,
                    now_ms: 2001,
                    request_id: None,
                },
                &dohc_engine_storage::NoFaults,
            )
            .unwrap();
        store.write_with(&dohc_engine_storage::NoFaults, |tx| {
            tx.execute("DELETE FROM ydoc_deferred_updates", []).unwrap();
            tx.execute("UPDATE ydoc_docs SET settle_prior_update_seq=0,settle_seq=(SELECT m.moment_order FROM moments m JOIN snapshots s ON s.latest_moment_id=m.moment_id WHERE s.object_id='object')", []).unwrap();
            tx.execute("INSERT INTO materialization_jobs(job_id,target_path,content_sha256,preimage_present,target_generation,created_at_ms,workspace_id,status) SELECT 'ydoc-mat_'||latest_moment_id,path,blob_sha256,1,999,0,workspace_id,?1 FROM snapshots WHERE object_id='object' ON CONFLICT(job_id) DO UPDATE SET status=excluded.status", [status]).unwrap();
            tx.execute("UPDATE materialization_jobs SET status=?1 WHERE workspace_id='ws' AND target_path='head.md'", [status]).unwrap();
            Ok::<_, SyncError>(())
        }).unwrap();
        (scratch, store)
    }

    fn recover(store: &mut EngineStore) {
        drain_open_document_artifacts(
            store,
            &mut Default::default(),
            "ws",
            &crate::NoLiveLeases,
            &dohc_engine_storage::NoFaults,
        )
        .unwrap();
    }

    fn refusal_count(store: &EngineStore) -> i64 {
        store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT COUNT(*) FROM replication_pending_refusals WHERE reason_code=?1",
                    [RECOVERY_FAILURE_CODE],
                    |row| row.get(0),
                )
            })
            .unwrap()
    }

    #[test]
    fn recovery_terminal_write_with_empty_queue_raises_one_notice_then_settle_clears_it() {
        for status in ["failed", "cancelled", "conflict"] {
            let (scratch, mut store) = recovery_with_empty_queue(status);
            assert_eq!(store.table_row_count("ydoc_deferred_updates").unwrap(), 0);
            recover(&mut store);
            assert_eq!(refusal_count(&store), 1, "terminal job: {status}");
            let fingerprint: String = store
                .read_with(|conn| {
                    conn.query_row(
                        "SELECT last_attempt_state FROM ydoc_pending_artifacts",
                        [],
                        |row| row.get(0),
                    )
                })
                .unwrap();
            recover(&mut store);
            assert_eq!(refusal_count(&store), 1);
            let unchanged: String = store
                .read_with(|conn| {
                    conn.query_row(
                        "SELECT last_attempt_state FROM ydoc_pending_artifacts",
                        [],
                        |row| row.get(0),
                    )
                })
                .unwrap();
            assert_eq!(unchanged, fingerprint);
            if status == "failed" {
                assert!(matches!(
                    store.list_pending_materialization_jobs(),
                    Err(StorageError::StateCorrupt { .. })
                ));
            }
            store.write_with(&dohc_engine_storage::NoFaults, |tx| {
                tx.execute("UPDATE materialization_jobs SET status='cancelled' WHERE workspace_id='ws' AND target_path='head.md' AND status='failed'", []).unwrap();
                tx.execute("UPDATE materialization_jobs SET status='pending',preimage_present=0,preimage_sha256=NULL WHERE job_id='ydoc-mat_recovery-write'", []).unwrap();
                Ok::<_, SyncError>(())
            }).unwrap();
            let job = store
                .list_pending_materialization_jobs()
                .unwrap()
                .into_iter()
                .find(|job| job.job_id == "ydoc-mat_recovery-write")
                .unwrap();
            assert!(matches!(
                dohc_engine_files::materialize_one(
                    &store,
                    scratch.path(),
                    &job,
                    &dohc_engine_files::MaterializeOptions {
                        holds: None,
                        policy: dohc_engine_files::DurabilityPolicy::per_os(),
                        replacer: &dohc_engine_files::StdReplacer,
                        backoff: &dohc_engine_files::NoBackoff,
                        now_ms: 3000,
                        faults: &dohc_engine_storage::NoFaults,
                    },
                )
                .unwrap(),
                dohc_engine_files::JobOutcome::Completed
            ));
            assert_eq!(
                std::fs::read_to_string(scratch.path().join("head.md")).unwrap(),
                "before remote"
            );
            store.write_with(&dohc_engine_storage::NoFaults, |tx| {
                tx.execute("UPDATE ydoc_docs SET settled_update_seq=head_update_seq,last_settled_sha=(SELECT blob_sha256 FROM snapshots WHERE object_id='object')", []).unwrap();
                Ok::<_, SyncError>(())
            }).unwrap();
            assert_eq!(refusal_count(&store), 0);
            assert_eq!(store.table_row_count("ydoc_pending_artifacts").unwrap(), 0);
        }
    }

    #[test]
    fn recovery_pending_write_with_empty_queue_raises_no_notice() {
        for waiting in [true, false] {
            let (_scratch, mut store) = recovery_with_empty_queue("pending");
            if !waiting {
                store.write_with(&dohc_engine_storage::NoFaults, |tx| {
                    tx.execute("UPDATE ydoc_docs SET settle_prior_update_seq=NULL,last_settled_sha=NULL", []).unwrap();
                    Ok::<_, SyncError>(())
                }).unwrap();
            }
            recover(&mut store);
            assert_eq!(refusal_count(&store), 0);
            assert_eq!(store.table_row_count("ydoc_pending_artifacts").unwrap(), 1);
            assert_eq!(store.table_row_count("ydoc_deferred_updates").unwrap(), 0);
        }
    }

    #[test]
    fn recovery_waits_without_recording_an_attempt() {
        for error in [
            SyncError::RetryableState {
                reason: "waiting for base",
            },
            SyncError::RetryableState {
                reason: "materialization pending",
            },
            crate::ydoc_apply::map_collab_hard_error(
                dohc_engine_collab::CollabError::RestoreFenced,
            ),
            SyncError::LiveDocumentBindingActive,
        ] {
            assert!(!isolate_document_failure(error).unwrap());
        }
    }

    #[test]
    fn recovery_isolates_document_data_and_projection_failures() {
        for error in [
            crate::error::local_corruption("corrupt update"),
            StorageError::BlobIntegrity {
                sha256: "missing".into(),
            }
            .into(),
            SyncError::BlobInvalid,
            SyncError::InvalidInput {
                reason: "document path is invalid",
            },
            SyncError::ProjectionTooLarge {
                constraint: "text",
                actual_bytes: 2,
                limit_bytes: 1,
            },
        ] {
            assert!(isolate_document_failure(error).unwrap());
        }
    }

    #[test]
    fn recovery_propagates_io_persist_disk_full_busy_and_other_hard_failures() {
        for error in [
            StorageError::persist_public(std::io::Error::other("I/O failed")).into(),
            StorageError::DiskFull {
                needed: 2,
                available: 1,
            }
            .into(),
            StorageError::FileLocked.into(),
            StorageError::PermissionDenied { source: None }.into(),
            StorageError::BackupFailed { source: None }.into(),
            SyncError::FaultCrash,
            SyncError::SequenceGap,
            SyncError::CoordinateDiverged,
        ] {
            let code = error.code();
            assert_eq!(isolate_document_failure(error).unwrap_err().code(), code);
        }
        for sqlite_code in [10, 13, 14, 7, 5, 6, 3, 8] {
            let collab = dohc_engine_collab::CollabError::Storage(StorageError::persist_public(
                rusqlite::Error::SqliteFailure(rusqlite::ffi::Error::new(sqlite_code), None),
            ));
            let error = crate::ydoc_apply::map_collab_hard_error(collab);
            let code = error.code();
            assert_eq!(isolate_document_failure(error).unwrap_err().code(), code);
        }
        for sqlite_code in [10, 13, 14, 7, 5, 6, 3, 8] {
            let error = SyncError::corrupt(rusqlite::Error::SqliteFailure(
                rusqlite::ffi::Error::new(sqlite_code),
                None,
            ));
            let code = error.code();
            assert_eq!(isolate_document_failure(error).unwrap_err().code(), code);
        }
    }
    #[test]
    #[ignore = "30,002-update recovery fingerprint measurement"]
    fn recovery_state_measurement_30002_updates() {
        let (_scratch, mut store, key, _, _) = crate::moment_apply_tests::ended_recovery_fixture();
        store.write_with(&dohc_engine_storage::NoFaults, |tx| {
            tx.execute_batch("WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<30002) INSERT INTO binary_blobs SELECT printf('%064x',x),1,X'00' FROM n;
                WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<30002) INSERT INTO ydoc_updates(workspace_id,version_id,object_id,seq,update_blob_sha256,recorded_at_ms) SELECT 'ws','main','object',x,printf('%064x',x),0 FROM n;
                WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<30002) INSERT INTO ydoc_snapshots SELECT 'ws','main','object',x,printf('%064x',x),printf('%064x',x),0 FROM n;
                UPDATE ydoc_docs SET head_update_seq=30002,head_snapshot_seq=30002;").unwrap();
            Ok::<_,SyncError>(())
        }).unwrap();
        const BASE_SQL: &str = "SELECT json_array(d.head_update_seq,d.head_snapshot_seq,d.last_local_update_seq,d.settled_update_seq,          d.last_settled_sha,d.settle_prior_update_seq,d.lineage_claim_id,d.path,d.updated_at_ms,          (SELECT latest_moment_id FROM snapshots s WHERE s.workspace_id=d.workspace_id AND s.version_id=d.version_id AND s.object_id=d.object_id),          (SELECT json_array(COUNT(*),MAX(rowid)) FROM ydoc_deferred_updates u WHERE u.workspace_id=d.workspace_id AND u.version_id=d.version_id AND u.object_id=d.object_id),          (SELECT COUNT(b.sha256) FROM ydoc_deferred_updates u JOIN replication_log r USING(workspace_id,origin_id,origin_seq) LEFT JOIN binary_blobs b ON b.sha256=json_extract(r.payload_json,'$.updateBlobSha256') WHERE u.workspace_id=d.workspace_id AND u.version_id=d.version_id AND u.object_id=d.object_id),          (SELECT COUNT(b.sha256) FROM ydoc_updates u LEFT JOIN binary_blobs b ON b.sha256=u.update_blob_sha256 WHERE u.workspace_id=d.workspace_id AND u.version_id=d.version_id AND u.object_id=d.object_id),          (SELECT COUNT(b.sha256) FROM ydoc_snapshots y LEFT JOIN binary_blobs b ON b.sha256=y.snapshot_blob_sha256 OR b.sha256=y.state_vector_blob_sha256 WHERE y.workspace_id=d.workspace_id AND y.version_id=d.version_id AND y.object_id=d.object_id),          (SELECT EXISTS(SELECT 1 FROM snapshots s JOIN blobs b ON b.sha256=s.blob_sha256 WHERE s.workspace_id=d.workspace_id AND s.version_id=d.version_id AND s.object_id=d.object_id)),          (SELECT group_concat(operation_id || COALESCE(resume_receipt_json,'')) FROM live_restore_fences f WHERE f.workspace_id=d.workspace_id AND f.main_version_id=d.version_id AND f.object_id=d.object_id),          (SELECT COUNT(*) FROM conflicts c WHERE c.workspace_id=d.workspace_id AND c.target_version_id=d.version_id AND c.status='open' AND (c.current_object_id=d.object_id OR c.incoming_object_id=d.object_id)))          FROM ydoc_docs d WHERE d.workspace_id=?1 AND d.version_id=?2 AND d.object_id=?3";
        store
            .read_with(|conn| {
                assert_eq!(
                    conn.query_row("SELECT COUNT(*) FROM ydoc_updates", [], |r| r
                        .get::<_, i64>(0))
                        .unwrap(),
                    30002
                );
                let plans = conn
                    .prepare(&format!("EXPLAIN QUERY PLAN {RECOVERY_STATE_SQL}"))
                    .unwrap()
                    .query_map(
                        params![key.workspace_id, key.version_id, key.object_id],
                        |r| r.get::<_, String>(3),
                    )
                    .unwrap()
                    .collect::<Result<Vec<_>, _>>()
                    .unwrap();
                assert!(
                    plans
                        .iter()
                        .all(|p| !p.contains("ydoc_updates") && !p.contains("ydoc_snapshots")),
                    "{plans:?}"
                );
                println!("RECOVERY_PLAN {}", serde_json::to_string(&plans).unwrap());
                let mut before = Vec::new();
                let mut after = Vec::new();
                let mut unchanged = Vec::new();
                let previous = serde_json::to_string(&SavedAttempt {state:state(conn,&key).unwrap(),missing_blob:Some("f".repeat(64))}).unwrap();
                for sample in 0..110 {
                    for arm in if sample % 2 == 0 { [0, 1, 2] } else { [2, 1, 0] } {
                        let start = std::time::Instant::now();
                        if arm == 2 {
                            assert!(attempt_is_unchanged(conn,&key,&previous).unwrap());
                            if sample >= 10 { unchanged.push(start.elapsed().as_secs_f64()*1000.0); }
                            continue;
                        }
                        let fingerprint: String = conn
                            .query_row(
                                if arm == 0 {
                                    BASE_SQL
                                } else {
                                    RECOVERY_STATE_SQL
                                },
                                params![key.workspace_id, key.version_id, key.object_id],
                                |r| r.get(0),
                            )
                            .unwrap();
                        std::hint::black_box(fingerprint);
                        if sample >= 10 {
                            (if arm == 0 { &mut before } else { &mut after })
                                .push(start.elapsed().as_secs_f64() * 1000.0);
                        }
                    }
                }
                println!(
                    "RECOVERY_STATE_MEASUREMENT {}",
                    serde_json::json!({"updates":30002,"base_ms":before,"fix_ms":after,"unchanged_check_ms":unchanged})
                );
                Ok::<_, SyncError>(())
            })
            .unwrap();
    }
}
