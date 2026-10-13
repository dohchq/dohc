use super::{
    ActorHandle,
    journal::journal_moment_outbound_in_tx,
    materialization::{
        MaterializationReplayScope, SelfWriteRecorder, replay_pending_materializations,
    },
    versioned::with_local_file_mutation_cache_reset,
};
use crate::RuntimeError;
use dohc_engine_domain::{
    DomainError, OperationMoment, VersionedTextStore, binary_rename_delete_job_id,
    binary_rename_write_job_id, binary_rollback_job_identity, operation_moments_in,
    undo_operation_in_tx,
};
use dohc_engine_storage::{
    EngineStore, FaultInjector, JobStatus, MaterializationJobSpec, Preimage, StorageError,
    TxnOutcome, enqueue_delete_job, enqueue_job,
};
use rusqlite::{OptionalExtension, params};
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    sync::Arc,
};

#[derive(Debug)]
pub struct HistoryOperation {
    pub operation_id: String,
    pub version_id: String,
    pub moments: Vec<OperationMoment>,
}
#[derive(Debug)]
pub struct HistoryUndoResult {
    pub operation_id: String,
    pub version_id: String,
    pub moments: Vec<OperationMoment>,
    pub deduped: bool,
    pub materialized: bool,
}

impl ActorHandle {
    pub async fn admit_history_operation(
        &self,
        ws: String,
        operation: String,
    ) -> Result<(), RuntimeError> {
        self.run(move |store,_| {
            if !operation.starts_with(dohc_engine_domain::OPERATION_ID_PREFIX) || operation.contains(":undo:") {return Err(DomainError::InvalidInput {reason:"invalid operation id"}.into());}
            if operation.len() > 512 || operation.chars().any(char::is_control) {return Err(DomainError::InvalidInput {reason:"invalid operation id"}.into());}
            let exists:bool=store.read_with(|conn|conn.query_row("SELECT EXISTS(SELECT 1 FROM moments WHERE workspace_id=?1 AND metadata_correlation_id=?2)",params![ws,operation],|r|r.get(0)).map_err(StorageError::corrupt_public))?;
            if exists {return Err(DomainError::InvalidInput {reason:"operation id already used"}.into());} Ok(())
        }).await
    }
    pub async fn history_operation_capture_seed(
        &self,
        ws: String,
        operation: String,
    ) -> Result<Vec<dohc_engine_domain::CaptureManifestSeedEntry>, RuntimeError> {
        self.run(move |store,_| {
            let version=VersionedTextStore::new(store).get_active_version(&ws)?.version_id;
            store.read_with(|conn| {
                operation_moments_in(conn,&ws,&version,&operation)?.iter().map(|m| {
                    conn.query_row("SELECT s.path,coalesce(b.byte_length,t.byte_length),coalesce(s.binary_sha256,s.blob_sha256) FROM snapshots s LEFT JOIN binary_blobs b ON b.sha256=s.binary_sha256 LEFT JOIN blobs t ON t.sha256=s.blob_sha256 WHERE s.workspace_id=?1 AND s.version_id=?2 AND s.object_id=?3",params![ws,version,m.object_id],|r|Ok(dohc_engine_domain::CaptureManifestSeedEntry {path:r.get(0)?,size:u64::try_from(r.get::<_,i64>(1)?).map_err(|_|rusqlite::Error::IntegralValueOutOfRange(1,-1))?,sha256:r.get(2)?})).optional().map_err(|e|DomainError::Storage(StorageError::corrupt_public(e)))
                }).collect::<Result<Vec<_>,_>>().map(|rows|rows.into_iter().flatten().collect())
            }).map_err(RuntimeError::from)
        }).await
    }

    pub async fn history_operation(
        &self,
        ws: String,
        operation: String,
    ) -> Result<HistoryOperation, RuntimeError> {
        self.run(move |store, _| {
            let version_id = VersionedTextStore::new(store)
                .get_active_version(&ws)?
                .version_id;
            let moments =
                store.read_with(|conn| operation_moments_in(conn, &ws, &version_id, &operation))?;
            Ok(HistoryOperation {
                operation_id: operation,
                version_id,
                moments,
            })
        })
        .await
    }
    #[allow(clippy::too_many_arguments)]
    pub async fn history_undo(
        &self,
        ws: String,
        operation: String,
        request: String,
        author: Option<String>,
        root: PathBuf,
        recorder: Arc<dyn SelfWriteRecorder>,
        faults: Arc<dyn FaultInjector>,
        now: i64,
    ) -> Result<HistoryUndoResult, RuntimeError> {
        self.run(move |store, cache| {
            with_local_file_mutation_cache_reset(cache, || {
                history_undo_on_store(
                    store,
                    &ws,
                    &operation,
                    &request,
                    author.as_deref(),
                    &root,
                    recorder.as_ref(),
                    faults.as_ref(),
                    now,
                )
            })
        })
        .await
    }
}

fn undo_job_ids(ws: &str, version: &str, m: &OperationMoment) -> Vec<String> {
    let id = binary_rollback_job_identity(ws, version, &m.moment_id);
    if m.operation == "rename" {
        vec![
            binary_rename_write_job_id(&id),
            binary_rename_delete_job_id(&id),
        ]
    } else {
        vec![id]
    }
}

#[allow(clippy::too_many_arguments)]
pub(super) fn history_undo_on_store(
    store: &mut EngineStore,
    ws: &str,
    operation: &str,
    request: &str,
    author: Option<&str>,
    root: &Path,
    recorder: &dyn SelfWriteRecorder,
    faults: &dyn FaultInjector,
    now: i64,
) -> Result<HistoryUndoResult, RuntimeError> {
    let version_id = VersionedTextStore::new(store)
        .get_active_version(ws)?
        .version_id;
    let result=store.write_with(faults,|tx| {
        let replay:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM engine_requests WHERE request_id=?1)",[request],|r|r.get(0)).map_err(StorageError::corrupt_public)?;
        if !replay {
            for m in operation_moments_in(tx,ws,&version_id,operation)? {
                for path in std::iter::once(m.path.as_str()).chain(m.before_path.as_deref()) {
                    let held:Option<String>=tx.query_row("SELECT path FROM capture_file_holds WHERE workspace_id=?1 AND (path=?2 OR object_id=?3) LIMIT 1",params![ws,path,m.object_id],|r|r.get(0)).optional().map_err(StorageError::corrupt_public)?;
                    if let Some(path)=held {return Err(DomainError::UndoRefused {path,reason:"capture hold"}.into());}
                    dohc_engine_sync::ensure_no_adopted_owner_under_path(tx,ws,&version_id,path)?;
                }
                if m.operation=="rename" {
                    let head:Option<(String,String)>=tx.query_row("SELECT path,CASE content_kind WHEN 'binary' THEN binary_sha256 ELSE blob_sha256 END FROM snapshots WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",params![ws,version_id,m.object_id],|r|Ok((r.get(0)?,r.get(1)?))).optional().map_err(StorageError::corrupt_public)?;
                    let (path,sha)=head.ok_or_else(||DomainError::UndoRefused {path:m.path.clone(),reason:"object moved or removed"})?;
                    if path!=m.path {return Err(DomainError::UndoRefused {path,reason:"object moved or removed"}.into());}
                    if !matches!(dohc_engine_files::probe_projection_target(root,&m.path,dohc_engine_files::ProjectionTargetKind::Plaintext),dohc_engine_files::ProjectionTargetState::Text {sha256} | dohc_engine_files::ProjectionTargetState::Binary {sha256} if sha256==sha) {return Err(DomainError::UndoRefused {path:m.path.clone(),reason:"source changed on disk"}.into());}
                }
                let target=m.before_path.as_deref().unwrap_or(&m.path);
                if !matches!(dohc_engine_files::probe_projection_target(root,target,dohc_engine_files::ProjectionTargetKind::Plaintext),dohc_engine_files::ProjectionTargetState::Absent) {
                    return Err(DomainError::UndoRefused {path:target.into(),reason:"old path occupied on disk"}.into());
                }
            }
        }
        undo_operation_in_tx(tx,ws,&version_id,operation,request,author,now,|tx,m| {
            let (path,text,kind,sha):(String,Option<String>,String,String)=tx.query_row("SELECT s.path,b.text,s.content_kind,CASE s.content_kind WHEN 'binary' THEN s.binary_sha256 ELSE s.blob_sha256 END FROM snapshots s LEFT JOIN blobs b ON b.sha256=s.blob_sha256 WHERE s.workspace_id=?1 AND s.version_id=?2 AND s.object_id=?3",params![ws,version_id,m.object_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).map_err(StorageError::corrupt_public)?;
            let head=if kind=="text" {dohc_engine_sync::ResultingHead::Text {path:&path,text:text.as_deref().unwrap_or("")}} else {dohc_engine_sync::ResultingHead::BinaryOrAbsent};
            dohc_engine_sync::reconcile_local_resulting_head_in_tx(tx,ws,&version_id,&m.object_id,head,None,None,now).map_err(|e|DomainError::Storage(StorageError::persist_public(std::io::Error::other(e))))?;
            crate::search::delete_file_search_index(tx,ws,&version_id,&m.object_id).map_err(super::search::search_domain)?;
            if let Some(text)=text.as_deref() {crate::search::upsert_file_search_index(tx,root,ws,&version_id,&m.object_id,&path,&text).map_err(super::search::search_domain)?;}
            let rename=m.operation==dohc_engine_domain::MomentOp::Rename;
            {
                let job_identity=binary_rollback_job_identity(ws,&version_id,&m.moment_id);
                let spec=MaterializationJobSpec {job_id:if rename {binary_rename_write_job_id(&job_identity)} else {job_identity.clone()},workspace_id:ws.into(),target_path:path,content_sha256:sha.clone(),preimage:Preimage::Absent,target_generation:m.moment_order,now_ms:now};
                enqueue_job(tx,&spec)?;
                if rename {enqueue_delete_job(tx,&MaterializationJobSpec {job_id:binary_rename_delete_job_id(&job_identity),target_path:m.before_path.clone().ok_or(DomainError::StateCorrupt {reason:"inverse rename lost path"})?,preimage:Preimage::Present(sha),..spec})?;}
            }
            journal_moment_outbound_in_tx(tx,ws,&m.moment_id,false)?;
            Ok(())
        }).map_err(RuntimeError::from)
    })?;
    let (moments, deduped) = match result {
        TxnOutcome::Committed(r) => r,
        TxnOutcome::Crashed { .. } => return Err(RuntimeError::OperationCrashed),
    };
    let active_version = version_id;
    let last = moments.last().ok_or(DomainError::StateCorrupt {
        reason: "Undo lost result",
    })?;
    let version_id: String = store.read_with(|conn| {
        conn.query_row(
            "SELECT version_id FROM moments WHERE workspace_id=?1 AND moment_id=?2",
            params![ws, last.moment_id],
            |r| r.get(0),
        )
        .map_err(StorageError::corrupt_public)
    })?;
    if active_version != version_id {
        return Ok(HistoryUndoResult {
            operation_id: operation.into(),
            version_id,
            moments,
            deduped,
            materialized: false,
        });
    }
    let mut jobs = HashSet::new();
    for id in moments
        .iter()
        .flat_map(|m| undo_job_ids(ws, &version_id, m))
    {
        if store.load_materialization_job(&id)?.is_some() {
            jobs.insert(id);
        }
    }
    let summary = replay_pending_materializations(
        store,
        root,
        MaterializationReplayScope {
            workspace_id: ws,
            self_writes: Some(recorder),
            progress: None,
            file_outcomes_settled: false,
            released_hold_paths: None,
        },
        now,
        faults,
        Some(&jobs),
        false,
    )?;
    let materialized=summary.failed==0 && summary.parked==0 && jobs.iter().all(|id| matches!(store.load_materialization_job(id),Ok(Some(j)) if j.status==JobStatus::Complete));
    Ok(HistoryUndoResult {
        operation_id: operation.into(),
        version_id,
        moments,
        deduped,
        materialized,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use dohc_engine_domain::{DeleteTextFile, RenameTextFile, WriteBinary, WriteText};
    use dohc_engine_storage::{FaultAction, FaultPoint, NoFaults};
    use dohc_engine_testkit::{ScratchDir, engine_db_path};
    const WS: &str = "history-operations";
    const OP: &str = "dohc-operation:original";

    fn fixture() -> (ScratchDir, EngineStore) {
        let root = ScratchDir::new().unwrap();
        let mut store = EngineStore::open(&engine_db_path(&root).unwrap(), 1).unwrap();
        VersionedTextStore::new(&mut store)
            .ensure_main_version(WS, "main", 1, &NoFaults)
            .unwrap();
        (root, store)
    }
    fn text(path: &str, id: &str, body: &str) -> WriteText {
        WriteText {
            workspace_id: WS.into(),
            version_id: "main".into(),
            object_id: id.into(),
            path: path.into(),
            text: body.into(),
            moment_id: id.into(),
            request_id: None,
            metadata_origin: "api".into(),
            metadata_summary: None,
            metadata_correlation_id: None,
            author_json: None,
            now_ms: 2,
        }
    }
    fn seed(store: &mut EngineStore, root: &Path, path: &str, id: &str, body: &str) {
        VersionedTextStore::new(store)
            .write_text(&text(path, id, body), &NoFaults)
            .unwrap();
        std::fs::write(root.join(path), body).unwrap();
    }
    fn rename(store: &mut EngineStore, root: &Path, from: &str, to: &str, id: &str, op: &str) {
        VersionedTextStore::new(store)
            .rename_text_file(
                &RenameTextFile {
                    workspace_id: WS.into(),
                    version_id: "main".into(),
                    from_path: from.into(),
                    to_path: to.into(),
                    moment_id: id.into(),
                    request_id: Some(id.into()),
                    metadata_origin: "api".into(),
                    metadata_summary: None,
                    metadata_correlation_id: Some(op.into()),
                    author_json: None,
                    now_ms: 3,
                },
                &NoFaults,
            )
            .unwrap();
        std::fs::rename(root.join(from), root.join(to)).unwrap();
    }
    fn remove(store: &mut EngineStore, root: &Path, path: &str, id: &str) {
        VersionedTextStore::new(store)
            .delete_text_file(
                &DeleteTextFile {
                    workspace_id: WS.into(),
                    version_id: "main".into(),
                    path: path.into(),
                    moment_id: id.into(),
                    request_id: Some(id.into()),
                    metadata_origin: "api".into(),
                    metadata_summary: None,
                    metadata_correlation_id: Some(OP.into()),
                    author_json: None,
                    now_ms: 3,
                },
                &NoFaults,
            )
            .unwrap();
        std::fs::remove_file(root.join(path)).unwrap();
    }
    fn undo(
        store: &mut EngineStore,
        root: &Path,
        request: &str,
        faults: &dyn FaultInjector,
    ) -> Result<HistoryUndoResult, RuntimeError> {
        history_undo_on_store(store, WS, OP, request, None, root, &(), faults, 10)
    }
    fn count(store: &EngineStore) -> i64 {
        store
            .read_with(|conn| conn.query_row("SELECT COUNT(*) FROM moments", [], |r| r.get(0)))
            .unwrap()
    }
    struct CrashCommit;
    impl FaultInjector for CrashCommit {
        fn poll(&self, p: FaultPoint) -> FaultAction {
            if p == FaultPoint::StorageAfterCommitBeforeAck {
                FaultAction::Crash
            } else {
                FaultAction::Continue
            }
        }
    }
    #[test]
    fn history_operation_rename_typing_and_request_replay() {
        let (root, mut store) = fixture();
        seed(&mut store, root.path(), "old.md", "seed", "Before.\n");
        rename(&mut store, root.path(), "old.md", "new.md", "rename", OP);
        let later = "x".repeat(64 * 1024);
        seed(&mut store, root.path(), "new.md", "typed", &later);
        let result = undo(&mut store, root.path(), "undo", &NoFaults).unwrap();
        assert!(result.materialized && !result.deduped);
        assert_eq!(
            std::fs::read_to_string(root.path().join("old.md")).unwrap(),
            later
        );
        assert!(!root.path().join("new.md").exists());
        let n = count(&store);
        let replay = undo(&mut store, root.path(), "undo", &NoFaults).unwrap();
        assert!(replay.deduped && replay.materialized);
        assert_eq!(replay.moments, result.moments);
        assert_eq!(count(&store), n);
        assert_eq!(
            store
                .read_with(|conn| operation_moments_in(conn, WS, "main", OP))
                .unwrap()
                .len(),
            1
        );
    }
    #[test]
    fn history_operation_whole_group_refuses_occupied_or_moved_objects() {
        for occupied in [true, false] {
            let (root, mut store) = fixture();
            seed(&mut store, root.path(), "old.md", "one", "One");
            seed(&mut store, root.path(), "other.md", "two", "Two");
            rename(&mut store, root.path(), "old.md", "new.md", "rename", OP);
            remove(&mut store, root.path(), "other.md", "delete");
            if occupied {
                seed(&mut store, root.path(), "old.md", "occupant", "Occupied");
            } else {
                rename(
                    &mut store,
                    root.path(),
                    "new.md",
                    "third.md",
                    "moved-again",
                    "dohc-operation:later",
                );
            }
            let n = count(&store);
            let error = undo(&mut store, root.path(), "undo", &NoFaults).unwrap_err();
            assert!(
                matches!(error, RuntimeError::Domain(DomainError::UndoRefused { .. })),
                "{error:?}"
            );
            assert_eq!(count(&store), n);
            assert!(!root.path().join("other.md").exists(), "no partial restore");
            assert_eq!(
                std::fs::read_to_string(root.path().join(if occupied {
                    "new.md"
                } else {
                    "third.md"
                }))
                .unwrap(),
                "One"
            );
        }
    }
    #[test]
    fn history_operation_delete_restores_text_and_binary() {
        let (root, mut store) = fixture();
        seed(
            &mut store,
            root.path(),
            "old.md",
            "one",
            &"a".repeat(64 * 1024),
        );
        VersionedTextStore::new(&mut store)
            .write_binary(
                &WriteBinary {
                    workspace_id: WS.into(),
                    version_id: "main".into(),
                    object_id: "two".into(),
                    path: "asset.bin".into(),
                    bytes: vec![0, 255, 1],
                    moment_id: "binary".into(),
                    request_id: None,
                    metadata_origin: "api".into(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: None,
                    now_ms: 2,
                },
                &NoFaults,
            )
            .unwrap();
        std::fs::write(root.path().join("asset.bin"), [0, 255, 1]).unwrap();
        remove(&mut store, root.path(), "old.md", "delete-text");
        remove(&mut store, root.path(), "asset.bin", "delete-binary");
        let result = undo(&mut store, root.path(), "undo", &NoFaults).unwrap();
        assert!(result.materialized);
        assert_eq!(result.moments.len(), 2);
        assert_eq!(
            std::fs::read(root.path().join("asset.bin")).unwrap(),
            [0, 255, 1]
        );
        assert_eq!(
            std::fs::read_to_string(root.path().join("old.md")).unwrap(),
            "a".repeat(64 * 1024)
        );
    }
    #[test]
    fn history_operation_peer_moment_cannot_be_reversed() {
        let (root, mut store) = fixture();
        seed(&mut store, root.path(), "old.md", "one", "One");
        rename(&mut store, root.path(), "old.md", "new.md", "rename", OP);
        store.write_with(&NoFaults,|tx|tx.execute("INSERT INTO replication_log(workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms,imported) VALUES (?1,'peer',1,'moment.append',?2,5,1)",params![WS,serde_json::json!({"momentId":"rename"}).to_string()]).map_err(StorageError::persist_public)).unwrap();
        assert!(
            store
                .read_with(|conn| operation_moments_in(conn, WS, "main", OP))
                .unwrap()
                .is_empty()
        );
        let n = count(&store);
        assert!(undo(&mut store, root.path(), "undo", &NoFaults).is_err());
        assert_eq!(count(&store), n);
        assert_eq!(
            std::fs::read_to_string(root.path().join("new.md")).unwrap(),
            "One"
        );
    }
    #[test]
    fn history_operation_checked_delete_is_visible_only_after_publication() {
        let (root, mut store) = fixture();
        seed(&mut store, root.path(), "old.md", "one", "Before.");
        let input = DeleteTextFile {
            workspace_id: WS.into(),
            version_id: "main".into(),
            path: "old.md".into(),
            moment_id: "checked-delete".into(),
            request_id: None,
            metadata_origin: "api".into(),
            metadata_summary: None,
            metadata_correlation_id: Some(OP.into()),
            author_json: None,
            now_ms: 3,
        };
        let sha = dohc_engine_storage::hex_sha256(b"Before.");
        store
            .write_with(&NoFaults, |tx| {
                let deletion = dohc_engine_domain::prepare_checked_delete_in_tx(
                    tx,
                    &input,
                    Some("one"),
                    &sha,
                )?;
                enqueue_delete_job(
                    tx,
                    &MaterializationJobSpec {
                        job_id: "restore-delete-mat_checked-delete".into(),
                        workspace_id: WS.into(),
                        target_path: "old.md".into(),
                        content_sha256: sha.clone(),
                        preimage: Preimage::Present(sha.clone()),
                        target_generation: deletion.moment.moment_order,
                        now_ms: 3,
                    },
                )?;
                Ok::<_, DomainError>(())
            })
            .unwrap();
        assert!(
            store
                .read_with(|conn| operation_moments_in(conn, WS, "main", OP))
                .unwrap()
                .is_empty()
        );
        let n = count(&store);
        assert!(matches!(
            undo(&mut store, root.path(), "undo", &NoFaults),
            Err(RuntimeError::Domain(DomainError::UndoRefused {
                reason: "operation unavailable",
                ..
            }))
        ));
        assert_eq!(count(&store), n);
        assert_eq!(
            std::fs::read(root.path().join("old.md")).unwrap(),
            b"Before."
        );
        std::fs::remove_file(root.path().join("old.md")).unwrap();
        store
            .write_with(&NoFaults, |tx| {
                dohc_engine_domain::finish_checked_delete_in_tx(tx, WS, "checked-delete", true)
            })
            .unwrap();
        assert_eq!(
            store
                .read_with(|conn| operation_moments_in(conn, WS, "main", OP))
                .unwrap()
                .len(),
            1
        );
        assert!(
            undo(&mut store, root.path(), "undo", &NoFaults)
                .unwrap()
                .materialized
        );
        assert_eq!(
            std::fs::read(root.path().join("old.md")).unwrap(),
            b"Before."
        );
    }
    #[test]
    fn history_operation_commit_crash_restarts_pending_placement() {
        let (root, mut store) = fixture();
        seed(&mut store, root.path(), "old.md", "one", "One");
        rename(&mut store, root.path(), "old.md", "new.md", "rename", OP);
        assert!(matches!(
            undo(&mut store, root.path(), "undo", &CrashCommit),
            Err(RuntimeError::OperationCrashed)
        ));
        assert_eq!(count(&store), 3);
        assert!(root.path().join("new.md").exists());
        drop(store);
        let mut store = EngineStore::open(&engine_db_path(&root).unwrap(), 11).unwrap();
        let result = undo(&mut store, root.path(), "undo", &NoFaults).unwrap();
        assert!(result.materialized && result.deduped);
        assert_eq!(count(&store), 3);
        assert_eq!(
            std::fs::read_to_string(root.path().join("old.md")).unwrap(),
            "One"
        );
        assert!(!root.path().join("new.md").exists());
    }
    #[test]
    fn history_operation_5000_files_engine_commit_timing() {
        let (root, mut store) = fixture();
        store
            .write_with(&NoFaults, |tx| {
                for i in 0..5000 {
                    dohc_engine_domain::write_text_in_tx(
                        tx,
                        &text(&format!("file-{i}.md"), &format!("seed-{i}"), "Before."),
                    )?;
                    std::fs::write(root.path().join(format!("file-{i}.md")), "Before.").unwrap();
                }
                Ok::<_, DomainError>(())
            })
            .unwrap();
        let mut samples = Vec::new();
        for i in 0..20 {
            let op = format!("dohc-operation:timing-{i}");
            rename(
                &mut store,
                root.path(),
                "file-0.md",
                "moved.md",
                &format!("rename-{i}"),
                &op,
            );
            let request = format!("undo-{i}");
            let started = std::time::Instant::now();
            assert!(matches!(
                history_undo_on_store(
                    &mut store,
                    WS,
                    &op,
                    &request,
                    None,
                    root.path(),
                    &(),
                    &CrashCommit,
                    10
                ),
                Err(RuntimeError::OperationCrashed)
            ));
            samples.push(started.elapsed().as_secs_f64() * 1000.0);
            let result = history_undo_on_store(
                &mut store,
                WS,
                &op,
                &request,
                None,
                root.path(),
                &(),
                &NoFaults,
                11,
            )
            .unwrap();
            assert!(result.materialized);
        }
        samples.sort_by(f64::total_cmp);
        println!(
            "HISTORY_UNDO_COMMIT_TIMING files=5000 samples=20 p50_ms={:.3} p95_ms={:.3} includes=disk-preflight,transaction excludes=materialization",
            samples[9], samples[18]
        );
    }
}
