use super::{
    ActorHandle,
    journal::journal_moment_outbound_with_batch_in_tx,
    materialization::{
        MaterializationReplayScope, SelfWriteRecorder, replay_pending_materializations,
    },
    versioned::with_local_file_mutation_cache_reset,
};
use crate::RuntimeError;
use dohc_engine_domain::{
    DomainError, OperationMoment, VersionedTextStore, binary_rename_delete_job_id,
    binary_rename_write_job_id, binary_rollback_job_identity, operation_moments_in,
    preflight_undo_operation_in, replayed_undo_operation_in, undo_correlation_id,
    undo_operation_in_tx, undo_request_is_replay_in, validate_operation_id,
};
use dohc_engine_storage::text;
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
#[derive(Debug, Clone)]
pub struct HistoryUndoResult {
    pub operation_id: String,
    pub version_id: String,
    pub moments: Vec<OperationMoment>,
    pub compensation_operation_id: String,
    pub deduped: bool,
    pub materialized: bool,
}

impl ActorHandle {
    pub async fn preflight_history_undo(
        &self,
        ws: String,
        operation: String,
        request: String,
        author: Option<String>,
    ) -> Result<Option<HistoryUndoResult>, RuntimeError> {
        self.run(move |store, _| {
            let version = VersionedTextStore::new(store)
                .get_active_version(&ws)?
                .version_id;
            let replay = store.read_with(|conn| {
                replayed_undo_operation_in(conn, &ws, &operation, &request, author.as_deref())
            })?;
            if let Some((replay_version, moments)) = replay {
                let jobs: Vec<String> = moments
                    .iter()
                    .flat_map(|m| undo_job_ids(&ws, &replay_version, m))
                    .collect();
                let job_ids =
                    serde_json::to_string(&jobs).map_err(|_| DomainError::StateCorrupt {
                        reason: "Undo job list",
                    })?;
                let completed: i64 = store.read_with(|conn| {
                    conn.query_row(
                        "SELECT COUNT(*) FROM materialization_jobs
                     WHERE workspace_id=?1 AND status='complete'
                         AND job_id IN (SELECT value FROM json_each(?2))",
                        params![ws, job_ids],
                        |r| r.get(0),
                    )
                    .map_err(StorageError::corrupt_public)
                })?;
                return Ok(Some(HistoryUndoResult {
                    operation_id: operation.clone(),
                    version_id: replay_version.clone(),
                    moments,
                    compensation_operation_id: undo_correlation_id(&ws, &operation, &request),
                    deduped: true,
                    materialized: replay_version == version
                        && usize::try_from(completed).ok() == Some(jobs.len()),
                }));
            }
            let available = store.read_with(|conn| -> Result<bool, DomainError> {
                dohc_engine_domain::ensure_operation_published_in(conn, &ws, &version, &operation)?;
                conn.query_row(
                    "SELECT EXISTS(SELECT 1 FROM moments m WHERE m.workspace_id=?1
                        AND m.version_id=?2 AND m.metadata_correlation_id=?3
                        AND coalesce(m.sync_record_only,0)=0
                        AND NOT EXISTS(SELECT 1 FROM replication_log r
                            WHERE r.workspace_id=m.workspace_id AND r.imported=1
                            AND r.op_kind='moment.append'
                            AND json_extract(r.payload_json,'$.momentId')=m.moment_id))",
                    params![ws, version, operation],
                    |r| r.get(0),
                )
                .map_err(|e| DomainError::Storage(StorageError::corrupt_public(e)))
            })?;
            if !available {
                return Err(DomainError::UndoRefused {
                    path: operation,
                    reason: "operation unavailable",
                }
                .into());
            }
            Ok(None)
        })
        .await
    }

    pub async fn ensure_history_undo_path_available(
        &self,
        ws: String,
        version: String,
        path: String,
    ) -> Result<(), RuntimeError> {
        self.run(move |store, _| {
            match VersionedTextStore::new(store).get_active_version(&ws) {
                Ok(active) if active.version_id == version => {}
                Ok(_) | Err(DomainError::WorkspaceNotFound) => return Ok(()),
                Err(error) => return Err(error.into()),
            }
            store.read_with(|conn| {
                super::capture::ensure_no_pending_undo_placement(conn, &ws, &path)
            })
        })
        .await
    }

    pub async fn admit_history_operation(
        &self,
        ws: String,
        operation: String,
    ) -> Result<(), RuntimeError> {
        self.run(move |store, _| {
            validate_operation_id(&operation)?;
            let exists: bool = store.read_with(|conn| {
                conn.query_row(
                    "SELECT EXISTS(SELECT 1 FROM moments
                 WHERE workspace_id=?1 AND metadata_correlation_id=?2)",
                    params![ws, operation],
                    |r| r.get(0),
                )
                .map_err(StorageError::corrupt_public)
            })?;
            if exists {
                return Err(DomainError::InvalidInput {
                    reason: "operation id already used",
                }
                .into());
            }
            Ok(())
        })
        .await
    }
    pub async fn history_operation_capture_seed(
        &self,
        ws: String,
        operation: String,
    ) -> Result<Vec<dohc_engine_domain::CaptureManifestSeedEntry>, RuntimeError> {
        self.run(move |store, _| {
            let version = VersionedTextStore::new(store)
                .get_active_version(&ws)?
                .version_id;
            store
                .read_with(|conn| {
                    let members = operation_moments_in(conn, &ws, &version, &operation)?;
                    let paths: HashSet<&str> = members
                        .iter()
                        .flat_map(|m| {
                            std::iter::once(m.path.as_str()).chain(m.before_path.as_deref())
                        })
                        .collect();
                    let paths_json =
                        serde_json::to_string(&paths).map_err(|_| DomainError::StateCorrupt {
                            reason: "Undo path list",
                        })?;
                    let mut stmt = conn
                        .prepare_cached(
                            "SELECT s.path,coalesce(b.byte_length,t.byte_length),
                         coalesce(s.binary_sha256,s.blob_sha256)
                     FROM snapshots s
                     LEFT JOIN binary_blobs b ON b.sha256=s.binary_sha256
                     LEFT JOIN blobs t ON t.sha256=s.blob_sha256
                     WHERE s.workspace_id=?1 AND s.version_id=?2
                         AND s.path IN (SELECT value FROM json_each(?3))",
                        )
                        .map_err(|e| DomainError::Storage(StorageError::corrupt_public(e)))?;
                    stmt.query_map(params![ws, version, paths_json], |r| {
                        Ok(dohc_engine_domain::CaptureManifestSeedEntry {
                            path: r.get(0)?,
                            size: u64::try_from(r.get::<_, i64>(1)?)
                                .map_err(|_| rusqlite::Error::IntegralValueOutOfRange(1, -1))?,
                            sha256: r.get(2)?,
                        })
                    })
                    .map_err(|e| DomainError::Storage(StorageError::corrupt_public(e)))?
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|e| DomainError::Storage(StorageError::corrupt_public(e)))
                })
                .map_err(RuntimeError::from)
        })
        .await
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
    pub async fn history_undo_commit(
        &self,
        ws: String,
        operation: String,
        request: String,
        author: Option<String>,
        root: PathBuf,
        faults: Arc<dyn FaultInjector>,
        now: i64,
    ) -> Result<HistoryUndoResult, RuntimeError> {
        self.run(move |store, cache| {
            with_local_file_mutation_cache_reset(cache, || {
                commit_history_undo_on_store(
                    store,
                    &ws,
                    &operation,
                    &request,
                    author.as_deref(),
                    &root,
                    faults.as_ref(),
                    now,
                )
            })
        })
        .await
    }
    pub async fn history_undo_place<F>(
        &self,
        ws: String,
        mut result: HistoryUndoResult,
        root: PathBuf,
        recorder: Arc<dyn SelfWriteRecorder>,
        now: i64,
        mut on_placed: F,
    ) -> HistoryUndoResult
    where
        F: FnMut(&[OperationMoment]) + Send,
    {
        result.materialized = true;
        // Each actor turn finishes a bounded placement batch, then yields to other work.
        for members in result.moments.chunks(8) {
            let selected = members.to_vec();
            let ws = ws.clone();
            let version = result.version_id.clone();
            let root = root.clone();
            let recorder = Arc::clone(&recorder);
            match self
                .run(move |store, _| {
                    place_undo_members(
                        store,
                        &ws,
                        &version,
                        &selected,
                        &root,
                        recorder.as_ref(),
                        &dohc_engine_storage::NoFaults,
                        now,
                    )
                })
                .await
            {
                Ok(true) => on_placed(members),
                Ok(false) => result.materialized = false,
                Err(error) => {
                    eprintln!("engine: Undo committed; placement will retry: {error}");
                    result.materialized = false;
                    break;
                }
            }
        }
        result
    }

    pub async fn history_operation_pending_jobs(
        &self,
        ws: String,
        operation: String,
    ) -> Result<Vec<String>, RuntimeError> {
        self.run(move |store, _| {
            let version = VersionedTextStore::new(store)
                .get_active_version(&ws)?
                .version_id;
            store
                .read_with(|conn| {
                    let members = operation_moments_in(conn, &ws, &version, &operation)?;
                    let paths = serde_json::to_string(
                        &members
                            .iter()
                            .flat_map(|m| {
                                std::iter::once(m.path.as_str()).chain(m.before_path.as_deref())
                            })
                            .collect::<Vec<_>>(),
                    )
                    .map_err(|_| DomainError::StateCorrupt {
                        reason: "Undo path list",
                    })?;
                    let mut stmt = conn
                        .prepare_cached(
                            "SELECT job_id FROM materialization_jobs
                     WHERE workspace_id=?1 AND status='pending'
                         AND target_path IN (SELECT value FROM json_each(?2))",
                        )
                        .map_err(|e| DomainError::Storage(StorageError::corrupt_public(e)))?;
                    stmt.query_map(params![ws, paths], |r| r.get(0))
                        .map_err(|e| DomainError::Storage(StorageError::corrupt_public(e)))?
                        .collect::<Result<Vec<_>, _>>()
                        .map_err(|e| DomainError::Storage(StorageError::corrupt_public(e)))
                })
                .map_err(RuntimeError::from)
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

#[cfg(test)]
thread_local! {
    static UNDO_PROBE_OBSERVER: std::cell::RefCell<Option<Box<dyn Fn()>>> = std::cell::RefCell::new(None);
}

fn probe_undo_source(
    probe: &dohc_engine_files::ProjectionProbe,
    path: &str,
) -> dohc_engine_files::ProjectionTargetState {
    #[cfg(test)]
    UNDO_PROBE_OBSERVER.with(|observer| {
        if let Some(observer) = observer.borrow().as_ref() {
            observer();
        }
    });
    probe.probe(path, dohc_engine_files::ProjectionTargetKind::Plaintext)
}

fn check_undo_ownership(
    conn: &rusqlite::Connection,
    ws: &str,
    version: &str,
    m: &OperationMoment,
) -> Result<(), RuntimeError> {
    for path in std::iter::once(m.path.as_str()).chain(m.before_path.as_deref()) {
        let held: Option<String> = conn
            .query_row(
                "SELECT path FROM capture_file_holds
             WHERE workspace_id=?1 AND (path=?2 OR object_id=?3) LIMIT 1",
                params![ws, path, m.object_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(StorageError::corrupt_public)?;
        if let Some(path) = held {
            return Err(DomainError::UndoRefused {
                path,
                reason: "capture hold",
            }
            .into());
        }
        dohc_engine_sync::ensure_no_adopted_owner_under_path(conn, ws, version, path)?;
    }
    Ok(())
}

fn rename_head_sha(
    conn: &rusqlite::Connection,
    ws: &str,
    version: &str,
    object: &str,
) -> Result<String, RuntimeError> {
    conn.query_row(
        "SELECT CASE content_kind WHEN 'binary' THEN binary_sha256 ELSE blob_sha256 END
         FROM snapshots WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
        params![ws, version, object],
        |r| r.get(0),
    )
    .map_err(StorageError::corrupt_public)
    .map_err(RuntimeError::from)
}

#[allow(clippy::too_many_arguments)]
fn commit_history_undo_on_store(
    store: &mut EngineStore,
    ws: &str,
    operation: &str,
    request: &str,
    author: Option<&str>,
    root: &Path,
    faults: &dyn FaultInjector,
    now: i64,
) -> Result<HistoryUndoResult, RuntimeError> {
    let version_id = VersionedTextStore::new(store)
        .get_active_version(ws)?
        .version_id;
    let probe =
        dohc_engine_files::ProjectionProbe::new(root).map_err(StorageError::persist_public)?;
    // The actor and workspace fence stay held, but disk reads do not hold SQLite's writer.
    let proofs = store.read_with(|conn| -> Result<_, RuntimeError> {
        let replay = undo_request_is_replay_in(conn, ws, operation, request, author)?;
        if replay {
            return Ok(Vec::new());
        }
        for m in operation_moments_in(conn, ws, &version_id, operation)? {
            check_undo_ownership(conn, ws, &version_id, &m)?;
        }
        let originals = preflight_undo_operation_in(conn, ws, &version_id, operation)?;
        originals
            .into_iter()
            .map(|m| {
                let source = if m.operation == "rename" {
                    let sha = rename_head_sha(conn, ws, &version_id, &m.object_id)?;
                    let stamp = probe.stamp(&m.path);
                    let digest = probe_undo_source(&probe, &m.path);
                    if !matches!(stamp, dohc_engine_files::ProjectionTargetStamp::File { .. })
                        || probe.stamp(&m.path) != stamp
                        || !matches!(digest,
                            dohc_engine_files::ProjectionTargetState::Text { sha256 }
                            | dohc_engine_files::ProjectionTargetState::Binary { sha256 }
                            if sha256 == sha)
                    {
                        return Err(DomainError::UndoRefused {
                            path: m.path.clone(),
                            reason: "source changed on disk",
                        }
                        .into());
                    }
                    Some(stamp)
                } else {
                    None
                };
                Ok((m, source))
            })
            .collect::<Result<Vec<_>, RuntimeError>>()
    })?;
    let policy = crate::search::read_engine_search_policy(root);
    let objects = serde_json::to_string(
        &proofs
            .iter()
            .map(|(m, _)| m.object_id.as_str())
            .collect::<Vec<_>>(),
    )
    .map_err(|_| DomainError::StateCorrupt {
        reason: "Undo object list",
    })?;
    let result = store.write_with(faults, |tx| {
        for (m, source) in &proofs {
            if let Some(stamp) = source {
                if probe.stamp(&m.path) != *stamp {
                    return Err(DomainError::UndoRefused {
                        path: m.path.clone(),
                        reason: "source changed on disk",
                    }
                    .into());
                }
            }
            let target = m.before_path.as_deref().unwrap_or(&m.path);
            if probe.stamp(target) != dohc_engine_files::ProjectionTargetStamp::Absent {
                return Err(DomainError::UndoRefused {
                    path: target.into(),
                    reason: "old path occupied on disk",
                }
                .into());
            }
        }
        if !proofs.is_empty() {
            crate::search::index::begin_file_search_index_batch(
                tx,
                &policy,
                ws,
                &version_id,
                &objects,
            )
            .map_err(super::search::search_domain)?;
        }
        let mut journal_eligibility = None;
        undo_operation_in_tx(
            tx,
            ws,
            &version_id,
            operation,
            request,
            author,
            now,
            |tx, m| {
                let (path, text, kind, sha): (String, Option<String>, String, String) = tx
                    .query_row(
                        "SELECT s.path,b.sha256,s.content_kind,
                    CASE s.content_kind WHEN 'binary' THEN s.binary_sha256 ELSE s.blob_sha256 END
                 FROM snapshots s LEFT JOIN blobs b ON b.sha256=s.blob_sha256
                 WHERE s.workspace_id=?1 AND s.version_id=?2 AND s.object_id=?3",
                        params![ws, version_id, m.object_id],
                        |r| Ok((r.get(0)?, text::from_row(tx, r, 1)?, r.get(2)?, r.get(3)?)),
                    )
                    .map_err(StorageError::corrupt_public)?;
                let head = if kind == "text" {
                    dohc_engine_sync::ResultingHead::Text {
                        path: &path,
                        text: text.as_deref().unwrap_or(""),
                    }
                } else {
                    dohc_engine_sync::ResultingHead::BinaryOrAbsent
                };
                dohc_engine_sync::reconcile_local_resulting_head_in_tx(
                    tx,
                    ws,
                    &version_id,
                    &m.object_id,
                    head,
                    None,
                    None,
                    now,
                )
                .map_err(|e| {
                    DomainError::Storage(StorageError::persist_public(std::io::Error::other(e)))
                })?;
                if let Some(text) = text.as_deref() {
                    crate::search::index::insert_file_search_index_with_policy(
                        tx,
                        &policy,
                        ws,
                        &version_id,
                        &m.object_id,
                        &path,
                        text,
                    )
                    .map_err(super::search::search_domain)?;
                }
                let rename = m.operation == dohc_engine_domain::MomentOp::Rename;
                let job_identity = binary_rollback_job_identity(ws, &version_id, &m.moment_id);
                let spec = MaterializationJobSpec {
                    job_id: if rename {
                        binary_rename_write_job_id(&job_identity)
                    } else {
                        job_identity.clone()
                    },
                    workspace_id: ws.into(),
                    target_path: path,
                    content_sha256: sha.clone(),
                    preimage: Preimage::Absent,
                    target_generation: m.moment_order,
                    now_ms: now,
                };
                enqueue_job(tx, &spec)?;
                if rename {
                    enqueue_delete_job(
                        tx,
                        &MaterializationJobSpec {
                            job_id: binary_rename_delete_job_id(&job_identity),
                            target_path: m.before_path.clone().ok_or(
                                DomainError::StateCorrupt {
                                    reason: "inverse rename lost path",
                                },
                            )?,
                            preimage: Preimage::Present(sha),
                            ..spec
                        },
                    )?;
                }
                journal_moment_outbound_with_batch_in_tx(
                    tx,
                    ws,
                    &m.moment_id,
                    false,
                    &mut journal_eligibility,
                )?;
                Ok(())
            },
        )
        .map_err(RuntimeError::from)
    })?;
    let (moments, deduped) = match result {
        TxnOutcome::Committed(r) => r,
        TxnOutcome::Crashed { .. } => return Err(RuntimeError::OperationCrashed),
    };
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
    Ok(HistoryUndoResult {
        operation_id: operation.into(),
        version_id,
        moments,
        compensation_operation_id: undo_correlation_id(ws, operation, request),
        deduped,
        materialized: false,
    })
}

#[allow(clippy::too_many_arguments)]
fn place_undo_members(
    store: &mut EngineStore,
    ws: &str,
    version: &str,
    members: &[OperationMoment],
    root: &Path,
    recorder: &dyn SelfWriteRecorder,
    faults: &dyn FaultInjector,
    now: i64,
) -> Result<bool, RuntimeError> {
    if VersionedTextStore::new(store)
        .get_active_version(ws)?
        .version_id
        != version
    {
        return Ok(false);
    }
    let jobs: HashSet<String> = members
        .iter()
        .flat_map(|m| undo_job_ids(ws, version, m))
        .collect();
    let summary = store.with_materialization_status_batch(|store| {
        replay_pending_materializations(
            store,
            root,
            MaterializationReplayScope {
                holds: None,
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
        )
    })?;
    let all_complete = jobs.iter().all(|id| {
        matches!(store.load_materialization_job(id), Ok(Some(job)) if job.status == JobStatus::Complete)
    });
    Ok(summary.failed == 0 && summary.parked == 0 && all_complete)
}

#[cfg(test)]
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
    let mut result =
        commit_history_undo_on_store(store, ws, operation, request, author, root, faults, now)?;
    result.materialized = place_undo_members(
        store,
        ws,
        &result.version_id,
        &result.moments,
        root,
        recorder,
        faults,
        now,
    )?;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use dohc_engine_domain::{DeleteTextFile, RenameTextFile, WriteBinary, WriteText};
    use dohc_engine_storage::{FaultAction, FaultPoint, NoFaults};
    use dohc_engine_testkit::{ScratchDir, engine_db_path};
    const WS: &str = "history-operations";
    const OP: &str = "dohc-operation:original";

    #[tokio::test]
    async fn history_operation_seed_includes_other_objects_at_endpoints() {
        let (root, mut store) = fixture();
        seed(&mut store, root.path(), "a.md", "one", "One");
        rename(&mut store, root.path(), "a.md", "b.md", "move", OP);
        seed(&mut store, root.path(), "a.md", "other", "New A");
        drop(store);
        let supervisor = crate::WorkspaceSupervisor::new();
        let actor = supervisor
            .open(&engine_db_path(&root).unwrap(), 4)
            .unwrap()
            .actor;
        let seed = actor
            .history_operation_capture_seed(WS.into(), OP.into())
            .await
            .unwrap();
        tokio::task::spawn_blocking(move || supervisor.close_all())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            seed.len(),
            2,
            "both endpoint heads must seed reconciliation"
        );
        assert!(seed.iter().any(|entry| entry.path == "a.md"));
        assert!(seed.iter().any(|entry| entry.path == "b.md"));
    }

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
    fn history_operation_member_cursor_keeps_its_fence_and_scope() {
        let (root, mut store) = fixture();
        for i in 0..3 {
            let old = format!("old-{i}.md");
            let new = format!("new-{i}.md");
            seed(
                &mut store,
                root.path(),
                &old,
                &format!("object-{i}"),
                "Content",
            );
            rename(
                &mut store,
                root.path(),
                &old,
                &new,
                &format!("move-{i}"),
                OP,
            );
        }
        let first = VersionedTextStore::new(&mut store)
            .history_page(WS, None, None, Some(OP), 1, None)
            .unwrap();
        let mut cursor = first.cursor.clone();
        let m = &first.moments[0];
        cursor.text = Some(dohc_engine_domain::HistoryMomentPosition {
            recorded_at_ms: m.recorded_at_ms,
            moment_order: m.moment_order,
        });
        seed(&mut store, root.path(), "late-old.md", "late", "Late");
        rename(
            &mut store,
            root.path(),
            "late-old.md",
            "late-new.md",
            "late-move",
            OP,
        );
        let rest = VersionedTextStore::new(&mut store)
            .history_page(WS, None, None, Some(OP), 50, Some(cursor.clone()))
            .unwrap();
        assert_eq!(rest.moments.len(), 2);
        assert!(rest.protected_moments.is_empty());
        assert!(rest.version_markers.is_empty());
        assert!(rest.moments.iter().all(|m| m.moment_id != "late-move"));
        assert!(matches!(
            VersionedTextStore::new(&mut store).history_page(
                WS,
                None,
                None,
                Some("dohc-operation:another"),
                50,
                Some(cursor)
            ),
            Err(DomainError::InvalidInput { .. })
        ));
    }
    #[test]
    fn history_operation_disk_probe_does_not_hold_write_transaction() {
        let (root, mut store) = fixture();
        seed(&mut store, root.path(), "old.md", "one", "One");
        rename(&mut store, root.path(), "old.md", "new.md", "move", OP);
        let conn = rusqlite::Connection::open(engine_db_path(&root).unwrap()).unwrap();
        conn.busy_timeout(std::time::Duration::ZERO).unwrap();
        let observed = std::rc::Rc::new(std::cell::Cell::new(false));
        let flag = observed.clone();
        UNDO_PROBE_OBSERVER.with(|slot| {
            *slot.borrow_mut() = Some(Box::new(move || {
                flag.set(conn.execute_batch("BEGIN IMMEDIATE; ROLLBACK;").is_ok());
            }))
        });
        let result = undo(&mut store, root.path(), "undo", &NoFaults);
        UNDO_PROBE_OBSERVER.with(|slot| *slot.borrow_mut() = None);
        assert!(result.unwrap().materialized);
        assert!(observed.get());
    }
    #[tokio::test]
    async fn history_operation_old_rename_cannot_reverse_a_later_move() {
        let (root, mut store) = fixture();
        seed(&mut store, root.path(), "a.md", "one", "One");
        rename(&mut store, root.path(), "a.md", "b.md", "move-one", OP);
        assert!(
            undo(&mut store, root.path(), "undo-one", &NoFaults)
                .unwrap()
                .materialized
        );
        rename(
            &mut store,
            root.path(),
            "a.md",
            "b.md",
            "move-two",
            "dohc-operation:second",
        );
        let before = count(&store);
        assert!(
            matches!(
                undo(&mut store, root.path(), "fresh-undo-one", &NoFaults),
                Err(RuntimeError::Domain(DomainError::UndoRefused { .. }))
            ),
            "old rename must not reverse the later operation"
        );
        assert_eq!(count(&store), before);
        assert_eq!(
            std::fs::read_to_string(root.path().join("b.md")).unwrap(),
            "One"
        );
        assert!(!root.path().join("a.md").exists());
        rename(
            &mut store,
            root.path(),
            "b.md",
            "elsewhere.md",
            "move-three",
            "dohc-operation:third",
        );
        drop(store);
        let supervisor = crate::WorkspaceSupervisor::new();
        let actor = supervisor
            .open(&engine_db_path(&root).unwrap(), 4)
            .unwrap()
            .actor;
        let seed = actor
            .history_operation_capture_seed(WS.into(), OP.into())
            .await
            .unwrap();
        tokio::task::spawn_blocking(move || supervisor.close_all())
            .await
            .unwrap()
            .unwrap();
        assert!(
            seed.is_empty(),
            "a head outside the endpoint scan must not be seeded for retirement"
        );
    }
    #[test]
    fn history_operation_batches_search_deletes() {
        use std::cell::Cell;
        thread_local! {static DELETES:Cell<usize>=const {Cell::new(0)};}
        fn trace(event: rusqlite::trace::TraceEvent<'_>) {
            if let rusqlite::trace::TraceEvent::Stmt(_, sql) = event {
                if sql.starts_with("DELETE FROM engine_search_files_fts") {
                    DELETES.with(|n| n.set(n.get() + 1));
                }
            }
        }
        let (root, mut store) = fixture();
        for i in 0..8 {
            let old = format!("old-{i}.md");
            let new = format!("new-{i}.md");
            seed(
                &mut store,
                root.path(),
                &old,
                &format!("object-{i}"),
                "Indexed content",
            );
            rename(
                &mut store,
                root.path(),
                &old,
                &new,
                &format!("move-{i}"),
                OP,
            );
        }
        store
            .write_with(&NoFaults, |tx| {
                crate::search::ensure_search_index_for_version(
                    tx,
                    root.path(),
                    WS,
                    "main",
                    1,
                    &NoFaults,
                )
            })
            .unwrap();
        DELETES.with(|n| n.set(0));
        store
            .read_with(|conn| {
                conn.trace_v2(
                    rusqlite::trace::TraceEventCodes::SQLITE_TRACE_STMT,
                    Some(trace),
                );
                Ok::<_, RuntimeError>(())
            })
            .unwrap();
        let result = undo(&mut store, root.path(), "undo", &NoFaults);
        store
            .read_with(|conn| {
                conn.trace_v2(rusqlite::trace::TraceEventCodes::empty(), None);
                Ok::<_, RuntimeError>(())
            })
            .unwrap();
        assert!(result.unwrap().materialized);
        assert_eq!(
            DELETES.with(Cell::get),
            1,
            "one group must scan the search table once"
        );
        let paths = store
            .read_with(|conn| {
                conn.prepare("SELECT path FROM engine_search_files_fts")?
                    .query_map([], |r| r.get::<_, String>(0))?
                    .collect::<Result<Vec<_>, _>>()
            })
            .unwrap();
        assert_eq!(paths.len(), 8);
        assert!(paths.iter().all(|p| p.starts_with("old-")));
    }
    #[test]
    fn history_operation_batches_completion_commits() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let (root, mut store) = fixture();
        for i in 0..8 {
            let old = format!("old-{i}.md");
            let new = format!("new-{i}.md");
            seed(
                &mut store,
                root.path(),
                &old,
                &format!("object-{i}"),
                "Content",
            );
            rename(
                &mut store,
                root.path(),
                &old,
                &new,
                &format!("move-{i}"),
                OP,
            );
        }
        let commits = Arc::new(AtomicUsize::new(0));
        let observed = Arc::clone(&commits);
        store
            .read_with(|conn| {
                conn.commit_hook(Some(move || {
                    observed.fetch_add(1, Ordering::Relaxed);
                    false
                }))
            })
            .unwrap();
        let result = undo(&mut store, root.path(), "undo", &NoFaults);
        store
            .read_with(|conn| conn.commit_hook(None::<fn() -> bool>))
            .unwrap();
        assert!(result.unwrap().materialized);
        // Unix also durably retains each displaced original before completing the batch.
        let retention_commits = if cfg!(unix) { 8 } else { 0 };
        assert_eq!(
            commits.load(Ordering::Relaxed),
            2 + retention_commits,
            "one inverse commit, one completion commit, and per-file retention commits"
        );
    }

    #[tokio::test]
    async fn history_operation_pending_only_refuses_before_fence() {
        let (root, mut store) = fixture();
        seed(&mut store, root.path(), "pending.md", "one", "Content");
        let sha = dohc_engine_storage::hex_sha256(b"Content");
        store
            .write_with(&NoFaults, |tx| {
                let deletion = dohc_engine_domain::prepare_checked_delete_in_tx(
                    tx,
                    &DeleteTextFile {
                        workspace_id: WS.into(),
                        version_id: "main".into(),
                        path: "pending.md".into(),
                        moment_id: "pending-delete".into(),
                        request_id: None,
                        metadata_origin: "api".into(),
                        metadata_summary: None,
                        metadata_correlation_id: Some(OP.into()),
                        author_json: None,
                        now_ms: 3,
                    },
                    Some("one"),
                    &sha,
                )?;
                enqueue_delete_job(
                    tx,
                    &MaterializationJobSpec {
                        job_id: "restore-delete-mat_pending-delete".into(),
                        workspace_id: WS.into(),
                        target_path: "pending.md".into(),
                        content_sha256: sha.clone(),
                        preimage: Preimage::Present(sha),
                        target_generation: deletion.moment.moment_order,
                        now_ms: 3,
                    },
                )?;
                Ok::<_, DomainError>(())
            })
            .unwrap();
        drop(store);
        let supervisor = crate::WorkspaceSupervisor::new();
        let actor = supervisor
            .open(&engine_db_path(&root).unwrap(), 4)
            .unwrap()
            .actor;
        let outcome = actor
            .preflight_history_undo(WS.into(), OP.into(), "undo".into(), None)
            .await;
        // Close on a plain thread: supervisor shutdown joins its actor.
        tokio::task::spawn_blocking(move || supervisor.close_all())
            .await
            .unwrap()
            .unwrap();
        assert!(matches!(
            outcome,
            Err(RuntimeError::Domain(DomainError::UndoRefused {
                reason: "operation publication pending",
                ..
            }))
        ));
        assert_eq!(
            std::fs::read(root.path().join("pending.md")).unwrap(),
            b"Content"
        );
    }

    #[test]
    fn history_operation_old_delete_cannot_restore_over_a_newer_delete() {
        let (root, mut store) = fixture();
        seed(&mut store, root.path(), "notes.md", "one", "v1");
        remove(&mut store, root.path(), "notes.md", "delete-v1");
        assert!(
            undo(&mut store, root.path(), "undo-v1", &NoFaults)
                .unwrap()
                .materialized
        );
        let mut input = text("notes.md", "one", "v2");
        input.moment_id = "edit-v2".into();
        VersionedTextStore::new(&mut store)
            .write_text(&input, &NoFaults)
            .unwrap();
        std::fs::write(root.path().join("notes.md"), "v2").unwrap();
        VersionedTextStore::new(&mut store)
            .delete_text_file(
                &DeleteTextFile {
                    workspace_id: WS.into(),
                    version_id: "main".into(),
                    path: "notes.md".into(),
                    moment_id: "delete-v2".into(),
                    request_id: None,
                    metadata_origin: "api".into(),
                    metadata_summary: None,
                    metadata_correlation_id: Some("dohc-operation:agent-delete".into()),
                    author_json: Some(
                        r#"[{"kind":"agent","agentId":"agent","onBehalfOf":"person"}]"#.into(),
                    ),
                    now_ms: 11,
                },
                &NoFaults,
            )
            .unwrap();
        std::fs::remove_file(root.path().join("notes.md")).unwrap();
        let n = count(&store);
        assert!(
            matches!(
                undo(&mut store, root.path(), "fresh-undo-v1", &NoFaults),
                Err(RuntimeError::Domain(DomainError::UndoRefused { .. }))
            ),
            "an old delete must not restore v1 over the newer deletion of v2"
        );
        assert_eq!(count(&store), n);
        assert!(!root.path().join("notes.md").exists());
        assert!(
            history_undo_on_store(
                &mut store,
                WS,
                "dohc-operation:agent-delete",
                "undo-v2",
                None,
                root.path(),
                &(),
                &NoFaults,
                12
            )
            .unwrap()
            .materialized
        );
        assert_eq!(
            std::fs::read_to_string(root.path().join("notes.md")).unwrap(),
            "v2"
        );
    }
    #[test]
    fn history_operation_pending_member_refuses_entire_group() {
        let (root, mut store) = fixture();
        seed(&mut store, root.path(), "published.md", "one", "One");
        seed(&mut store, root.path(), "pending.md", "two", "Two");
        remove(&mut store, root.path(), "published.md", "published-delete");
        let sha = dohc_engine_storage::hex_sha256(b"Two");
        store
            .write_with(&NoFaults, |tx| {
                let deletion = dohc_engine_domain::prepare_checked_delete_in_tx(
                    tx,
                    &DeleteTextFile {
                        workspace_id: WS.into(),
                        version_id: "main".into(),
                        path: "pending.md".into(),
                        moment_id: "pending-delete".into(),
                        request_id: None,
                        metadata_origin: "api".into(),
                        metadata_summary: None,
                        metadata_correlation_id: Some(OP.into()),
                        author_json: None,
                        now_ms: 3,
                    },
                    Some("two"),
                    &sha,
                )?;
                enqueue_delete_job(
                    tx,
                    &MaterializationJobSpec {
                        job_id: "restore-delete-mat_pending-delete".into(),
                        workspace_id: WS.into(),
                        target_path: "pending.md".into(),
                        content_sha256: sha.clone(),
                        preimage: Preimage::Present(sha.clone()),
                        target_generation: deletion.moment.moment_order,
                        now_ms: 3,
                    },
                )?;
                Ok::<_, DomainError>(())
            })
            .unwrap();
        let n = count(&store);
        assert!(
            matches!(
                undo(&mut store, root.path(), "undo", &NoFaults),
                Err(RuntimeError::Domain(DomainError::UndoRefused { .. }))
            ),
            "a hidden pending member must not produce a partial Undo"
        );
        assert_eq!(count(&store), n);
        assert!(!root.path().join("published.md").exists());
        assert_eq!(
            std::fs::read(root.path().join("pending.md")).unwrap(),
            b"Two"
        );
        assert!(
            store
                .load_materialization_job("restore-delete-mat_pending-delete")
                .unwrap()
                .is_some()
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
                reason: "operation publication pending",
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
