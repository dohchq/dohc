use super::{ActorHandle, SelfWriteRecorder};
use crate::RuntimeError;
use dohc_engine_domain::DomainError;
use dohc_engine_files::{DurabilityPolicy, MaterializeOptions, StdBackoff, StdReplacer};
use dohc_engine_storage::{EngineStore, JobStatus, NoFaults, StorageError};
use std::{path::PathBuf, sync::Arc};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CheckedDeleteAction {
    Retry,
    FinishDelete,
}

#[derive(Debug)]
pub struct CheckedDeleteResolution {
    pub moment_id: String,
    pub expected_sha256: String,
    pub action: CheckedDeleteAction,
}

#[derive(Debug)]
pub struct CheckedDeleteRecovery {
    pub moment_id: String,
    pub version_id: String,
    pub object_id: String,
    pub path: String,
    pub expected_sha256: String,
    pub reason: &'static str,
    pub action: CheckedDeleteAction,
}

pub(super) fn pending_on_store(
    store: &EngineStore,
    workspace: &str,
) -> Result<Vec<CheckedDeleteRecovery>, RuntimeError> {
    store.read_with(|conn| {
        let mut stmt = conn.prepare("SELECT m.moment_id,m.version_id,m.object_id,j.target_path,j.content_sha256,
            EXISTS(SELECT 1 FROM replication_log r WHERE r.workspace_id=m.workspace_id AND r.op_kind='moment.append' AND json_extract(r.payload_json,'$.momentId')=m.moment_id)
            OR EXISTS(SELECT 1 FROM replication_pending_conflict_moments p WHERE p.workspace_id=m.workspace_id AND p.moment_id=m.moment_id)
            FROM materialization_jobs j JOIN moments m ON m.workspace_id=j.workspace_id AND m.moment_id=substr(j.job_id,20)
            WHERE j.workspace_id=?1 AND j.job_id GLOB 'restore-delete-mat_*' ORDER BY m.moment_order").map_err(StorageError::corrupt_public)?;
        stmt.query_map([workspace], |row| {
            let exported: bool = row.get(5)?;
            Ok(CheckedDeleteRecovery {
                moment_id: row.get(0)?, version_id: row.get(1)?, object_id: row.get(2)?, path: row.get(3)?, expected_sha256: row.get(4)?,
                reason: if exported {"checked-delete-replication-dependents"} else {"checked-delete-publication-pending"},
                action: if exported {CheckedDeleteAction::FinishDelete} else {CheckedDeleteAction::Retry},
            })
        }).map_err(StorageError::corrupt_public)?.collect::<Result<Vec<_>,_>>().map_err(StorageError::corrupt_public)
    }).map_err(RuntimeError::from)
}

pub(super) fn resolve_on_store(
    store: &mut EngineStore,
    root: &std::path::Path,
    workspace: &str,
    input: &CheckedDeleteResolution,
    recorder: &dyn SelfWriteRecorder,
    now_ms: i64,
) -> Result<(), RuntimeError> {
    let CheckedDeleteResolution {
        moment_id: moment,
        expected_sha256: expected,
        action,
    } = input;
    let Some(pending) = pending_on_store(store, workspace)?
        .into_iter()
        .find(|row| row.moment_id == *moment)
    else {
        return Ok(());
    };
    if pending.expected_sha256 != *expected {
        return Err(DomainError::WritePreconditionFailed {
            current_sha256: Some(pending.expected_sha256),
        }
        .into());
    }
    // Resolve staged files before consulting the target or its durable disk receipt.
    dohc_engine_files::recover_displacements(
        store,
        root,
        Some(workspace),
        &MaterializeOptions {
            policy: DurabilityPolicy::per_os(),
            replacer: &StdReplacer,
            backoff: &StdBackoff,
            now_ms,
            faults: &NoFaults,
        },
    )?;
    let job_id = format!("restore-delete-mat_{moment}");
    if *action == CheckedDeleteAction::FinishDelete
        && let Some(job) = store.load_materialization_job(&job_id)?
        && matches!(job.status, JobStatus::Pending | JobStatus::Conflict)
    {
        let current_sha256 =
            dohc_engine_files::materialize::write_precondition_sha256(root, &pending.path)?;
        if current_sha256
            .as_ref()
            .is_some_and(|current| current != expected)
        {
            return Err(DomainError::WritePreconditionFailed { current_sha256 }.into());
        }
        // A refused attempt keeps its export. Explicitly retry the original
        // precondition instead of leaving a conflict terminal on every open.
        if job.status == JobStatus::Conflict {
            store.requeue_materialization_conflict(&job_id)?;
        }
    }
    super::versioned::publish_checked_delete_on_store(
        store,
        root,
        workspace,
        &job_id,
        recorder,
        now_ms,
        &NoFaults,
        *action == CheckedDeleteAction::Retry,
        *action == CheckedDeleteAction::FinishDelete,
    )
}

impl ActorHandle {
    pub async fn pending_checked_deletes(
        &self,
        workspace: String,
    ) -> Result<Vec<CheckedDeleteRecovery>, RuntimeError> {
        self.run(move |store, _| pending_on_store(store, &workspace))
            .await
    }

    pub async fn resolve_checked_delete(
        &self,
        root: PathBuf,
        workspace: String,
        input: CheckedDeleteResolution,
        recorder: Arc<dyn SelfWriteRecorder>,
        now_ms: i64,
    ) -> Result<(), RuntimeError> {
        self.run(move |store, _| {
            resolve_on_store(store, &root, &workspace, &input, recorder.as_ref(), now_ms)
        })
        .await
    }
}
