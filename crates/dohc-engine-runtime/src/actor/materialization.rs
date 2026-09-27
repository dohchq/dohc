use super::ActorHandle;
use super::versions::switch_projection_job_id;
use crate::error::RuntimeError;
use dohc_engine_crypto::{SecretDataKey, SecretPlaintext, load_key_file};
use dohc_engine_domain::{
    DomainError, SecretFileStore, VersionedTextStore, binary_rename_write_job_id,
    decode_binary_rollback_job_identity,
};
use dohc_engine_files::{
    DurabilityPolicy, JobOutcome, KeptCopySave, MaterializeOptions, StdBackoff, StdReplacer,
    materialize_one, materialize_secret_delete_one, materialize_secret_one, recover_displacements,
    save_kept_displacement,
};
use dohc_engine_storage::{
    Displacement, EngineStore, FaultInjector, FaultPoint, JobStatus, MaterializationJob,
    MaterializationOperation, NoFaults, StorageError, hex_sha256,
};
use rusqlite::{OptionalExtension, params};
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PostCommitMaterializeOutcome {
    Applied,
    Skipped,
    Conflict,
    Superseded,
    Error,
}

/// Daemon-owned sink for identities written by settlement. Recording before
/// the actor replies closes the watcher race between atomic replace and the
/// protocol layer regaining control.
pub trait SelfWriteRecorder: Send + Sync {
    fn record(&self, workspace_id: &str, path: &str, sha256: &str);
    /// Remove a previously recorded identity — the compensation for a settle
    /// whose materialization conflicted (the file was never replaced, so the
    /// entry must not survive to suppress a genuine capture).
    fn retract(&self, workspace_id: &str, path: &str, sha256: &str);
}

/// The recorder for callers with no capture layer to suppress: every write is
/// forgotten.
impl SelfWriteRecorder for () {
    fn record(&self, _workspace_id: &str, _path: &str, _sha256: &str) {}
    fn retract(&self, _workspace_id: &str, _path: &str, _sha256: &str) {}
}

impl ActorHandle {
    /// The workspace's kept displacements, oldest first: files a replace
    /// moved aside that hold bytes the store does not have.
    pub async fn list_kept_displacements(
        &self,
        workspace_id: String,
    ) -> Result<Vec<Displacement>, RuntimeError> {
        self.run(move |store, _cache| Ok(store.list_kept_displacements(&workspace_id)?))
            .await
    }

    /// Move one kept file to a visible copy beside its path. Runs on the
    /// actor, where materialization and its recovery run, so no replace moves
    /// the file meanwhile.
    pub async fn save_kept_displacement(
        &self,
        root_dir: PathBuf,
        workspace_id: String,
        displacement_id: i64,
        now_ms: i64,
    ) -> Result<KeptCopySave, RuntimeError> {
        self.run(move |store, _cache| {
            Ok(save_kept_displacement(
                store,
                &root_dir,
                &workspace_id,
                displacement_id,
                &MaterializeOptions {
                    policy: DurabilityPolicy::per_os(),
                    replacer: &StdReplacer,
                    backoff: &StdBackoff,
                    now_ms,
                    faults: &NoFaults,
                },
            )?)
        })
        .await
    }

    /// Replay every pending materialization job (best-effort, per-job
    /// failures tolerated). Returns the number of jobs that reached disk.
    pub async fn materialize_replay_pending(
        &self,
        root_dir: PathBuf,
        workspace_id: String,
        now_ms: i64,
    ) -> Result<usize, RuntimeError> {
        self.materialize_replay_pending_counting(root_dir, workspace_id, now_ms, None)
            .await
    }

    /// [`Self::materialize_replay_pending`], counting into `progress` each job
    /// the replay takes on. The whole replay is one actor command, so without
    /// this a long replay moves no counter until it ends.
    pub async fn materialize_replay_pending_counting(
        &self,
        root_dir: PathBuf,
        workspace_id: String,
        now_ms: i64,
        progress: Option<Arc<AtomicU64>>,
    ) -> Result<usize, RuntimeError> {
        self.run(move |store, _cache| {
            // Open-time replay runs before the files layer starts. The
            // switch path calls the same tolerant per-job executor with a
            // selected durable job set and watcher suppression enabled.
            replay_pending_materializations(
                store,
                &root_dir,
                MaterializationReplayScope {
                    workspace_id: &workspace_id,
                    self_writes: None,
                    progress: progress.as_deref(),
                },
                now_ms,
                &NoFaults,
                None,
                false,
            )
            .map(|summary| summary.completed)
        })
        .await
    }

    /// Replay pending writes before a version fence scans the filesystem.
    /// Unlike startup replay, any attempted job failure is fatal: scanning
    /// stale disk bytes after a committed write failed to materialize could
    /// capture those bytes back over the committed head.
    pub async fn materialize_replay_pending_for_fence(
        &self,
        root_dir: PathBuf,
        workspace_id: String,
        self_writes: Arc<dyn SelfWriteRecorder>,
        now_ms: i64,
    ) -> Result<(), RuntimeError> {
        self.run(move |store, _cache| {
            replay_pending_materializations(
                store,
                &root_dir,
                MaterializationReplayScope {
                    workspace_id: &workspace_id,
                    self_writes: Some(self_writes.as_ref()),
                    progress: None,
                },
                now_ms,
                &NoFaults,
                None,
                false,
            )
            .and_then(|summary| {
                if summary.failed == 0 {
                    Ok(())
                } else {
                    Err(RuntimeError::ActiveVersionMaterializationIncomplete {
                        failed_jobs: summary.failed,
                    })
                }
            })
        })
        .await
    }

    /// Strictly replay one caller-owned set of pending materialization jobs.
    /// Jobs outside this set retain their existing status for ordinary replay.
    pub async fn materialize_replay_selected_for_fence(
        &self,
        root_dir: PathBuf,
        workspace_id: String,
        self_writes: Arc<dyn SelfWriteRecorder>,
        materialization_job_ids: Vec<String>,
        now_ms: i64,
    ) -> Result<(), RuntimeError> {
        self.run(move |store, _cache| {
            let selected: HashSet<String> = materialization_job_ids.into_iter().collect();
            replay_pending_materializations(
                store,
                &root_dir,
                MaterializationReplayScope {
                    workspace_id: &workspace_id,
                    self_writes: Some(self_writes.as_ref()),
                    progress: None,
                },
                now_ms,
                &NoFaults,
                Some(&selected),
                false,
            )
            .and_then(|summary| {
                let failed_jobs =
                    summary.failed + selected.len().saturating_sub(summary.selected_seen);
                if failed_jobs == 0 {
                    Ok(())
                } else {
                    Err(RuntimeError::ActiveVersionMaterializationIncomplete { failed_jobs })
                }
            })
        })
        .await
    }
}

struct SecretJobCoordinates {
    workspace_id: String,
    version_id: String,
    path: String,
}

fn secret_job_coordinates(
    store: &mut EngineStore,
    job: &MaterializationJob,
) -> Result<Option<SecretJobCoordinates>, RuntimeError> {
    let moment_id = job
        .job_id
        .strip_prefix("secret-mat_")
        .ok_or(DomainError::StateCorrupt {
            reason: "secret materialization job id is malformed",
        })?;
    let coordinates: Option<(String, String, String, i64, String)> = store.read_with(|conn| {
        conn.query_row(
            "SELECT workspace_id, version_id, path, moment_order, operation \
                 FROM secret_moments WHERE moment_id = ?1",
            [moment_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )
        .optional()
        .map_err(StorageError::corrupt_public)
    })?;
    let Some((workspace_id, version_id, path, moment_order, operation)) = coordinates else {
        // Version deletion cascades its secret moments but the generic
        // materialization ledger has no FK back to those domain rows. Treat
        // that pending job as an orphan the replay loop can retire, not as
        // corruption that bricks every future workspace open.
        return Ok(None);
    };
    let expected_operation = match job.operation {
        dohc_engine_storage::MaterializationOperation::Write => "write",
        dohc_engine_storage::MaterializationOperation::Delete => "delete",
    };
    if path != job.target_path
        || moment_order != job.target_generation
        || operation != expected_operation
    {
        return Err(DomainError::StateCorrupt {
            reason: "secret materialization job does not match its moment",
        }
        .into());
    }
    Ok(Some(SecretJobCoordinates {
        workspace_id,
        version_id,
        path,
    }))
}

fn secret_tip_exists(
    store: &EngineStore,
    coordinates: &SecretJobCoordinates,
) -> Result<bool, RuntimeError> {
    store
        .read_with(|conn| {
            conn.query_row(
                "SELECT 1 FROM secret_files \
                 WHERE workspace_id = ?1 AND version_id = ?2 AND path = ?3",
                params![
                    coordinates.workspace_id,
                    coordinates.version_id,
                    coordinates.path
                ],
                |_| Ok(()),
            )
            .optional()
            .map(|row| row.is_some())
            .map_err(StorageError::corrupt_public)
        })
        .map_err(RuntimeError::from)
}

fn secret_plaintext_for_job(
    store: &mut EngineStore,
    key: &SecretDataKey,
    coordinates: &SecretJobCoordinates,
) -> Result<Option<SecretPlaintext>, RuntimeError> {
    SecretFileStore::new(store, key)
        .materialize_secret_file(
            &coordinates.workspace_id,
            &coordinates.version_id,
            &coordinates.path,
        )
        .map_err(RuntimeError::from)
}

fn active_projection_coordinates(
    store: &EngineStore,
) -> Result<Vec<(String, String)>, RuntimeError> {
    store
        .read_with(|connection| {
            let mut statement = connection
                .prepare(
                    "SELECT w.workspace_id, COALESCE(v.version_id, w.main_version_id) \
                     FROM versioned_workspaces w \
                     LEFT JOIN active_versions a ON a.workspace_id = w.workspace_id \
                     LEFT JOIN versions v ON v.workspace_id = a.workspace_id \
                       AND v.version_id = a.version_id ORDER BY w.workspace_id",
                )
                .map_err(StorageError::corrupt_public)?;
            let rows = statement
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
                .map_err(StorageError::corrupt_public)?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(StorageError::corrupt_public)
        })
        .map_err(RuntimeError::from)
}

fn switch_projection_matches_active(
    store: &EngineStore,
    job: &MaterializationJob,
    secret: bool,
) -> Result<Option<SecretJobCoordinates>, RuntimeError> {
    for (workspace_id, version_id) in active_projection_coordinates(store)? {
        let expected_job_id = switch_projection_job_id(
            &workspace_id,
            &version_id,
            &job.target_path,
            job.operation,
            &job.content_sha256,
            secret,
        );
        if job.job_id != expected_job_id {
            continue;
        }
        let matches = if secret {
            let ciphertext_base64: Option<String> = store.read_with(|connection| {
                connection
                    .query_row(
                        "SELECT ciphertext_base64 FROM secret_files \
                         WHERE workspace_id = ?1 AND version_id = ?2 AND path = ?3",
                        params![workspace_id, version_id, job.target_path],
                        |row| row.get(0),
                    )
                    .optional()
                    .map_err(StorageError::corrupt_public)
            })?;
            let tip_sha = ciphertext_base64
                .map(|encoded| hex_sha256(&dohc_engine_crypto::base64::forgiving_decode(&encoded)));
            match job.operation {
                MaterializationOperation::Write => tip_sha.as_deref() == Some(&job.content_sha256),
                MaterializationOperation::Delete => tip_sha.is_none(),
            }
        } else {
            let tip_sha: Option<String> = store.read_with(|connection| {
                connection
                    .query_row(
                        "SELECT CASE COALESCE(content_kind, 'text') \
                                  WHEN 'binary' THEN binary_sha256 ELSE blob_sha256 END \
                         FROM snapshots \
                         WHERE workspace_id = ?1 AND version_id = ?2 AND path = ?3",
                        params![workspace_id, version_id, job.target_path],
                        |row| row.get(0),
                    )
                    .optional()
                    .map_err(StorageError::corrupt_public)
            })?;
            match job.operation {
                MaterializationOperation::Write => tip_sha.as_deref() == Some(&job.content_sha256),
                MaterializationOperation::Delete => tip_sha.is_none(),
            }
        };
        if matches {
            return Ok(Some(SecretJobCoordinates {
                workspace_id,
                version_id,
                path: job.target_path.clone(),
            }));
        }
        return Ok(None);
    }
    Ok(None)
}

pub(super) struct MaterializationReplaySummary {
    pub(super) completed: usize,
    pub(super) failed: usize,
    pub(super) selected_seen: usize,
}

#[derive(Clone, Copy)]
pub(super) struct MaterializationReplayScope<'a> {
    pub(super) workspace_id: &'a str,
    pub(super) self_writes: Option<&'a dyn SelfWriteRecorder>,
    /// Counts each job this replay takes on, so a caller waiting on a long
    /// replay can tell it from a stuck one.
    pub(super) progress: Option<&'a AtomicU64>,
}

const ROLLBACK_RESTORE_PREFIX: &str = "rollback-restore_\u{1f}";

/// The rollback identity a materialization job belongs to, if it is one
/// `binary_rollback_job_identity` minted (bare or wrapped in a rename pair).
fn rollback_restore_identity(job_id: &str) -> Option<&str> {
    if job_id.starts_with(ROLLBACK_RESTORE_PREFIX) {
        return Some(job_id);
    }
    job_id
        .strip_prefix("binary-rename-0-write-mat_")
        .or_else(|| job_id.strip_prefix("binary-rename-1-delete-mat_"))
        .filter(|id| id.starts_with(ROLLBACK_RESTORE_PREFIX))
}

fn rollback_write_matches_active_snapshot(
    store: &EngineStore,
    write_job: &MaterializationJob,
    workspace_id: &str,
    version_id: Option<&str>,
    additionally_absent_path: Option<&str>,
) -> Result<bool, RuntimeError> {
    store
        .read_with(|conn| {
            conn.query_row(
                "SELECT 1 \
                 FROM versioned_workspaces w \
                 JOIN path_aliases a ON a.workspace_id = w.workspace_id \
                   AND a.version_id = COALESCE( \
                       (SELECT av.version_id FROM active_versions av \
                        WHERE av.workspace_id = w.workspace_id), \
                       w.main_version_id) \
                   AND a.path = ?1 \
                 JOIN snapshots s ON s.workspace_id = a.workspace_id \
                   AND s.version_id = a.version_id AND s.object_id = a.object_id \
                 WHERE w.workspace_id = ?4 \
                   AND (?5 IS NULL OR a.version_id = ?5) \
                   AND CASE COALESCE(s.content_kind, 'text') \
                         WHEN 'binary' THEN s.binary_sha256 ELSE s.blob_sha256 END = ?2 \
                   AND (?3 IS NULL OR NOT EXISTS ( \
                       SELECT 1 FROM path_aliases occupied \
                       WHERE occupied.workspace_id = a.workspace_id \
                         AND occupied.version_id = a.version_id \
                         AND occupied.path = ?3)) \
                 LIMIT 1",
                params![
                    write_job.target_path,
                    write_job.content_sha256,
                    additionally_absent_path,
                    workspace_id,
                    version_id
                ],
                |_| Ok(()),
            )
            .optional()
            .map(|match_| match_.is_some())
            .map_err(StorageError::corrupt_public)
        })
        .map_err(RuntimeError::from)
}

fn rollback_delete_matches_active_absence(
    store: &EngineStore,
    delete_job: &MaterializationJob,
    workspace_id: &str,
    version_id: Option<&str>,
) -> Result<bool, RuntimeError> {
    store
        .read_with(|conn| {
            conn.query_row(
                "SELECT 1 FROM versioned_workspaces w \
                 WHERE w.workspace_id = ?2 \
                   AND (?3 IS NULL OR COALESCE( \
                       (SELECT av.version_id FROM active_versions av \
                        WHERE av.workspace_id = w.workspace_id), \
                       w.main_version_id) = ?3) \
                   AND NOT EXISTS ( \
                     SELECT 1 FROM path_aliases a \
                     WHERE a.workspace_id = w.workspace_id \
                       AND a.version_id = COALESCE( \
                           (SELECT av.version_id FROM active_versions av \
                            WHERE av.workspace_id = w.workspace_id), \
                           w.main_version_id) \
                       AND a.path = ?1) \
                 LIMIT 1",
                params![delete_job.target_path, workspace_id, version_id],
                |_| Ok(()),
            )
            .optional()
            .map(|match_| match_.is_some())
            .map_err(StorageError::corrupt_public)
        })
        .map_err(RuntimeError::from)
}

pub(super) fn rollback_job_matches_active(
    store: &EngineStore,
    replay_workspace_id: &str,
    job: &MaterializationJob,
) -> Result<Option<bool>, RuntimeError> {
    let Some(rollback_id) = rollback_restore_identity(&job.job_id) else {
        return Ok(None);
    };
    let Some((workspace_id, version_id, _)) = decode_binary_rollback_job_identity(rollback_id)
    else {
        return Ok(Some(false));
    };
    if workspace_id != replay_workspace_id {
        return Ok(Some(false));
    }
    let version_id = Some(version_id);
    if job.job_id.starts_with("binary-rename-1-delete-mat_") {
        let write_id = binary_rename_write_job_id(rollback_id);
        let Some(write_job) = store.load_materialization_job(&write_id)? else {
            return Ok(Some(false));
        };
        return rollback_write_matches_active_snapshot(
            store,
            &write_job,
            replay_workspace_id,
            version_id,
            Some(&job.target_path),
        )
        .map(Some);
    }
    match job.operation {
        MaterializationOperation::Write => rollback_write_matches_active_snapshot(
            store,
            job,
            replay_workspace_id,
            version_id,
            None,
        ),
        MaterializationOperation::Delete => {
            rollback_delete_matches_active_absence(store, job, replay_workspace_id, version_id)
        }
    }
    .map(Some)
}

pub(super) fn replay_pending_materializations(
    store: &mut EngineStore,
    root_dir: &std::path::Path,
    scope: MaterializationReplayScope<'_>,
    now_ms: i64,
    faults: &dyn FaultInjector,
    selected: Option<&HashSet<String>>,
    superseded_after_projection_is_drained: bool,
) -> Result<MaterializationReplaySummary, RuntimeError> {
    // A crash can leave a replace half done, including for a job that will not
    // run again. Resolve those first, so no displaced file is left unsettled.
    recover_displacements(
        store,
        root_dir,
        Some(scope.workspace_id),
        &MaterializeOptions {
            policy: DurabilityPolicy::per_os(),
            replacer: &StdReplacer,
            backoff: &StdBackoff,
            now_ms,
            faults,
        },
    )?;
    let jobs = store.list_pending_materialization_jobs()?;
    (|| -> Result<MaterializationReplaySummary, RuntimeError> {
        let mut summary = MaterializationReplaySummary {
            completed: 0,
            failed: 0,
            selected_seen: 0,
        };
        let mut secret_key: Option<SecretDataKey> = None;
        for job in jobs {
            if selected.is_some_and(|selected| !selected.contains(&job.job_id)) {
                continue;
            }
            // Empty is the migration sentinel for a pre-coordinate row. Those
            // intents were globally replayable before workspace scoping existed,
            // so preserve that behavior until one workspace drains them.
            if !job.workspace_id.is_empty() && job.workspace_id != scope.workspace_id {
                continue;
            }
            summary.selected_seen += usize::from(selected.is_some());
            if let Some(progress) = scope.progress {
                progress.fetch_add(1, Ordering::Relaxed);
            }
            let switch_secret = job.job_id.starts_with("version-switch-secret-mat_");
            let ordinary_secret = job.job_id.starts_with("secret-mat_");
            if switch_secret || ordinary_secret {
                let coordinates = if switch_secret {
                    match switch_projection_matches_active(store, &job, true)? {
                        Some(coordinates) => coordinates,
                        None => {
                            store.mark_materialization_complete(&job.job_id, now_ms)?;
                            if selected.is_some() {
                                summary.failed += 1;
                            }
                            continue;
                        }
                    }
                } else {
                    let Some(coordinates) = secret_job_coordinates(store, &job)? else {
                        store.mark_materialization_complete(&job.job_id, now_ms)?;
                        continue;
                    };
                    let active_version_id = VersionedTextStore::new(store)
                        .get_active_version(&coordinates.workspace_id)?
                        .version_id;
                    if coordinates.version_id != active_version_id {
                        continue;
                    }
                    let tip_present = secret_tip_exists(store, &coordinates)?;
                    match (job.operation, tip_present) {
                        (MaterializationOperation::Write, false)
                        | (MaterializationOperation::Delete, true) => {
                            store.mark_materialization_complete(&job.job_id, now_ms)?;
                            continue;
                        }
                        (MaterializationOperation::Delete, false)
                        | (MaterializationOperation::Write, true) => {}
                    }
                    coordinates
                };
                if job.operation == MaterializationOperation::Delete {
                    match materialize_secret_delete_one(
                        store,
                        root_dir,
                        &job,
                        &MaterializeOptions {
                            policy: DurabilityPolicy::per_os(),
                            replacer: &StdReplacer,
                            backoff: &StdBackoff,
                            now_ms,
                            faults,
                        },
                    ) {
                        Ok(JobOutcome::Completed | JobOutcome::AlreadyMaterialized) => {
                            summary.completed += 1;
                        }
                        Ok(
                            JobOutcome::Conflict
                            | JobOutcome::Superseded
                            | JobOutcome::Blocked
                            | JobOutcome::Crashed(_),
                        )
                        | Err(_) => summary.failed += 1,
                    }
                    continue;
                }
                if secret_key.is_none() {
                    let Ok(Some(key)) = load_key_file(root_dir) else {
                        summary.failed += 1;
                        continue;
                    };
                    secret_key = Some(key);
                }
                let plaintext = match secret_plaintext_for_job(
                    store,
                    secret_key.as_ref().expect("secret key loaded"),
                    &coordinates,
                ) {
                    Ok(Some(plaintext)) => plaintext,
                    Ok(None) => {
                        store.mark_materialization_complete(&job.job_id, now_ms)?;
                        continue;
                    }
                    Err(_) => {
                        summary.failed += 1;
                        continue;
                    }
                };
                let plaintext_sha = hex_sha256(plaintext.as_bytes());
                if let Some(self_writes) = scope.self_writes {
                    self_writes.record(scope.workspace_id, &job.target_path, &plaintext_sha);
                }
                let outcome = materialize_secret_one(
                    store,
                    root_dir,
                    &job,
                    plaintext.as_bytes(),
                    &MaterializeOptions {
                        policy: DurabilityPolicy::per_os(),
                        replacer: &StdReplacer,
                        backoff: &StdBackoff,
                        now_ms,
                        faults,
                    },
                );
                match outcome {
                    Ok(JobOutcome::Completed | JobOutcome::AlreadyMaterialized) => {
                        summary.completed += 1;
                    }
                    Ok(
                        JobOutcome::Conflict
                        | JobOutcome::Superseded
                        | JobOutcome::Blocked
                        | JobOutcome::Crashed(_),
                    )
                    | Err(_) => {
                        if let Some(self_writes) = scope.self_writes {
                            self_writes.retract(
                                scope.workspace_id,
                                &job.target_path,
                                &plaintext_sha,
                            );
                        }
                        summary.failed += 1;
                    }
                }
                continue;
            }
            if job.job_id.starts_with("version-switch-mat_")
                && switch_projection_matches_active(store, &job, false)?.is_none()
            {
                store.mark_materialization_complete(&job.job_id, now_ms)?;
                if selected.is_some() {
                    summary.failed += 1;
                }
                continue;
            }
            if matches!(
                rollback_job_matches_active(store, scope.workspace_id, &job)?,
                Some(false)
            ) {
                continue;
            }
            if let Some(moment_id) = job.job_id.strip_prefix("binary-rename-1-delete-mat_") {
                let write_job_id = binary_rename_write_job_id(moment_id);
                match store
                    .load_materialization_job(&write_job_id)?
                    .map(|write_job| write_job.status)
                {
                    // Follow-up: cancelled means the destination path was
                    // explicitly deleted after the rename committed — that
                    // delete already resolved the destination, so this paired
                    // delete (removing the rename's old path) must still run.
                    // Treating it like Conflict would strand the old path on
                    // disk forever, under a job nothing ever revisits.
                    Some(JobStatus::Complete) | Some(JobStatus::Cancelled) => {}
                    Some(JobStatus::Conflict) => {
                        store.mark_materialization_conflict(&job.job_id, now_ms)?;
                        summary.failed += 1;
                        continue;
                    }
                    Some(JobStatus::Pending) | None => {
                        if selected.is_some() {
                            summary.failed += 1;
                        }
                        continue;
                    }
                }
            }
            let outcome = if let Some(self_writes) = scope.self_writes {
                let (materialized, reported) = materialize_pending_job(
                    store,
                    root_dir,
                    scope.workspace_id,
                    &job,
                    self_writes,
                    now_ms,
                    faults,
                );
                if materialized {
                    Ok(JobOutcome::Completed)
                } else {
                    Ok(match reported {
                        PostCommitMaterializeOutcome::Conflict => JobOutcome::Conflict,
                        PostCommitMaterializeOutcome::Superseded => JobOutcome::Superseded,
                        PostCommitMaterializeOutcome::Applied
                        | PostCommitMaterializeOutcome::Skipped
                        | PostCommitMaterializeOutcome::Error => {
                            JobOutcome::Crashed(FaultPoint::MaterializeAfterJobCommit)
                        }
                    })
                }
            } else {
                materialize_one(
                    store,
                    root_dir,
                    &job,
                    &MaterializeOptions {
                        policy: DurabilityPolicy::per_os(),
                        replacer: &StdReplacer,
                        backoff: &StdBackoff,
                        now_ms,
                        faults,
                    },
                )
                .map_err(RuntimeError::from)
            };
            match outcome {
                Ok(JobOutcome::Completed | JobOutcome::AlreadyMaterialized) => {
                    summary.completed += 1;
                }
                Ok(JobOutcome::Blocked) => summary.failed += 1,
                Ok(JobOutcome::Superseded) if superseded_after_projection_is_drained => {
                    summary.completed += 1;
                }
                Ok(JobOutcome::Conflict | JobOutcome::Superseded) => {
                    summary.failed += 1;
                    if let Some(moment_id) = job.job_id.strip_prefix("ydoc-mat_") {
                        let coords: Option<(String, String, String)> =
                            store.read_with(|connection| {
                                connection
                                    .query_row(
                                        "SELECT workspace_id, version_id, object_id \
                                     FROM moments WHERE moment_id = ?1",
                                        [moment_id],
                                        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                                    )
                                    .optional()
                                    .map_err(StorageError::corrupt_public)
                            })?;
                        if let Some((workspace_id, version_id, object_id)) = coords {
                            store.write_with(&NoFaults, |transaction| {
                                transaction
                                    .execute(
                                        "UPDATE ydoc_docs SET last_settled_sha = NULL, \
                                         settled_update_seq = NULL, updated_at_ms = ?4 \
                                         WHERE workspace_id = ?1 AND version_id = ?2 AND object_id = ?3",
                                        params![workspace_id, version_id, object_id, now_ms],
                                    )
                                    .map_err(StorageError::persist_public)?;
                                Ok::<_, StorageError>(())
                            })?;
                        }
                    }
                }
                Ok(JobOutcome::Crashed(_)) | Err(_) => summary.failed += 1,
            }
        }
        Ok(summary)
    })()
}

pub(super) fn materialize_pending_job(
    store: &EngineStore,
    root_dir: &std::path::Path,
    workspace_id: &str,
    job: &MaterializationJob,
    self_writes: &dyn SelfWriteRecorder,
    now_ms: i64,
    faults: &dyn FaultInjector,
) -> (bool, PostCommitMaterializeOutcome) {
    // Register before replacement: the watcher may observe the write as soon
    // as the atomic rename lands. Every non-applied outcome retracts the
    // identity because no self-write is then available to consume it.
    self_writes.record(workspace_id, &job.target_path, &job.content_sha256);
    let outcome = materialize_one(
        store,
        root_dir,
        job,
        &MaterializeOptions {
            policy: DurabilityPolicy::per_os(),
            replacer: &StdReplacer,
            backoff: &StdBackoff,
            now_ms,
            faults,
        },
    );
    let (materialized, reported) = match outcome {
        Ok(JobOutcome::Completed | JobOutcome::AlreadyMaterialized) => {
            (true, PostCommitMaterializeOutcome::Applied)
        }
        Ok(JobOutcome::Blocked) => (false, PostCommitMaterializeOutcome::Skipped),
        Ok(JobOutcome::Conflict) => (false, PostCommitMaterializeOutcome::Conflict),
        Ok(JobOutcome::Superseded) => (false, PostCommitMaterializeOutcome::Superseded),
        Ok(JobOutcome::Crashed(_)) => (false, PostCommitMaterializeOutcome::Error),
        Err(error) => {
            eprintln!(
                "engine: post-commit materialization failed for {}: {error}",
                job.target_path
            );
            (false, PostCommitMaterializeOutcome::Error)
        }
    };
    if !materialized {
        self_writes.retract(workspace_id, &job.target_path, &job.content_sha256);
    }
    (materialized, reported)
}

pub(super) fn materialize_expected_job(
    store: &EngineStore,
    root_dir: &std::path::Path,
    workspace_id: &str,
    job_id: &str,
    self_writes: &dyn SelfWriteRecorder,
    now_ms: i64,
    faults: &dyn FaultInjector,
) -> bool {
    let job = match store.load_materialization_job(job_id) {
        Ok(Some(job)) => job,
        Ok(None) => return false,
        Err(error) => {
            eprintln!("engine: loading post-commit materialization job failed: {error}");
            return false;
        }
    };
    match job.status {
        JobStatus::Complete => true,
        JobStatus::Pending => {
            materialize_pending_job(
                store,
                root_dir,
                workspace_id,
                &job,
                self_writes,
                now_ms,
                faults,
            )
            .0
        }
        JobStatus::Conflict | JobStatus::Cancelled => false,
    }
}

pub(super) fn worse_materialize_outcome(
    left: PostCommitMaterializeOutcome,
    right: PostCommitMaterializeOutcome,
) -> PostCommitMaterializeOutcome {
    if materialize_outcome_severity(right) > materialize_outcome_severity(left) {
        right
    } else {
        left
    }
}

const fn materialize_outcome_severity(outcome: PostCommitMaterializeOutcome) -> u8 {
    match outcome {
        PostCommitMaterializeOutcome::Applied => 0,
        PostCommitMaterializeOutcome::Superseded => 1,
        PostCommitMaterializeOutcome::Skipped => 2,
        PostCommitMaterializeOutcome::Conflict => 3,
        PostCommitMaterializeOutcome::Error => 4,
    }
}

#[cfg(test)]
mod rollback_identity_tests {
    use super::*;
    use dohc_engine_domain::binary_rollback_job_identity;
    use dohc_engine_storage::Preimage;
    use dohc_engine_testkit::ScratchDir;

    fn pending_write(job_id: &str, workspace_id: &str) -> MaterializationJob {
        MaterializationJob {
            job_id: job_id.to_owned(),
            workspace_id: workspace_id.to_owned(),
            target_path: "asset.bin".to_owned(),
            content_sha256: hex_sha256(b"asset"),
            operation: MaterializationOperation::Write,
            preimage: Preimage::Absent,
            target_generation: 1,
            status: JobStatus::Pending,
            created_at_ms: 1,
        }
    }

    /// Only the encoded prefix marks a rollback job. One that carries the
    /// prefix but does not decode, or decodes to another workspace, fails
    /// closed as `Some(false)`: never `None` (the ordinary replay path) and
    /// never `Some(true)`.
    #[test]
    fn undecodable_or_foreign_rollback_identities_fail_closed() {
        let scratch = ScratchDir::new().expect("scratch");
        let db = dohc_engine_testkit::engine_db_path(&scratch).expect("engine database path");
        let store = EngineStore::open(&db, 1).expect("open store");

        let bare = pending_write("rollback-restore_target", "ws-a");
        assert_eq!(
            rollback_job_matches_active(&store, "ws-a", &bare).expect("bare prefix"),
            None,
            "a caller-chosen id that merely starts with the word is an ordinary job."
        );

        let truncated = pending_write("rollback-restore_\u{1f}4:ws-a", "ws-a");
        assert_eq!(
            rollback_job_matches_active(&store, "ws-a", &truncated).expect("truncated"),
            Some(false),
            "a rollback id that stops mid-encoding is refused."
        );

        let foreign_id = binary_rollback_job_identity("ws-b", "main", "moment-1");
        let foreign = pending_write(&foreign_id, "ws-b");
        assert_eq!(
            rollback_job_matches_active(&store, "ws-a", &foreign).expect("foreign"),
            Some(false),
            "a rollback minted for another workspace never matches this one."
        );

        let ordinary = pending_write("write-mat_ordinary", "ws-a");
        assert_eq!(
            rollback_job_matches_active(&store, "ws-a", &ordinary).expect("ordinary"),
            None,
            "a non-rollback job takes the ordinary replay path."
        );
    }
}
