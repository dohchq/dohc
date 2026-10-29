use super::ActorHandle;
use super::versions::{projection_target_alias, switch_projection_job_id};
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
    Displacement, EngineStore, FaultInjector, JobStatus, MaterializationJob,
    MaterializationOperation, NoFaults, StorageError, hex_sha256,
};
use rusqlite::{OptionalExtension, params};
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PostCommitMaterializeOutcome {
    Parked,
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
    pub async fn recover_open_document_artifacts(
        &self,
        workspace_id: String,
        leases: dohc_engine_collab::LeaseRegistry,
    ) -> Result<(), RuntimeError> {
        // A recovery that waits for released-tail validation has ended its
        // transactions, so the actor is free while the store's worker
        // validates; the recovery then runs again.
        loop {
            let (workspace_id, leases) = (workspace_id.clone(), leases.clone());
            let waiting = self
                .run(move |store, cache| {
                    Ok(dohc_engine_sync::drain_open_document_artifacts(
                        store,
                        cache,
                        &workspace_id,
                        &leases,
                        &NoFaults,
                    )?
                    .waiting)
                })
                .await?;
            let Some(pending) = waiting else {
                return Ok(());
            };
            pending
                .validate()
                .await
                .map_err(super::relay::validation_failed)?;
        }
    }

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
                    holds: None,
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
        #[cfg(unix)]
        self.retained_root.set(root_dir.clone());
        self.run(move |store, _cache| {
            // Open-time replay runs before the files layer starts. The
            // switch path calls the same tolerant per-job executor with a
            // selected durable job set and watcher suppression enabled.
            replay_pending_materializations(
                store,
                &root_dir,
                MaterializationReplayScope {
                    holds: None,
                    workspace_id: &workspace_id,
                    self_writes: None,
                    progress: progress.as_deref(),
                    file_outcomes_settled: false,
                    released_hold_paths: None,
                    planned_against_active_heads: false,
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
                    holds: None,
                    workspace_id: &workspace_id,
                    self_writes: Some(self_writes.as_ref()),
                    progress: None,
                    file_outcomes_settled: false,
                    released_hold_paths: None,
                    planned_against_active_heads: false,
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
                    holds: None,
                    workspace_id: &workspace_id,
                    self_writes: Some(self_writes.as_ref()),
                    progress: None,
                    file_outcomes_settled: false,
                    released_hold_paths: None,
                    planned_against_active_heads: false,
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
    pub(super) parked: usize,
    pub(super) completed: usize,
    pub(super) failed: usize,
    pub(super) store_busy: usize,
    pub(super) selected_seen: usize,
    pub(super) hard_errors: Vec<(String, String)>,
}

#[derive(Clone, Copy)]
pub(super) struct MaterializationReplayScope<'a> {
    pub(super) holds: Option<&'a dohc_engine_files::PlacementHolds>,
    pub(super) workspace_id: &'a str,
    pub(super) self_writes: Option<&'a dyn SelfWriteRecorder>,
    /// Counts each job this replay takes on, so a caller waiting on a long
    /// replay can tell it from a stuck one.
    pub(super) progress: Option<&'a AtomicU64>,
    /// Capture drains settle file conflicts without failing the workspace.
    pub(super) file_outcomes_settled: bool,
    /// Preserve unseen stale relay writes only when this capture released a hold.
    /// Paths are keyed by `dohc_engine_files::floor::path_collision_key`.
    pub(super) released_hold_paths: Option<&'a std::collections::HashSet<String>>,
    /// The caller planned every selected job just now against the active
    /// heads, so its deletes already account for heads at other spellings.
    pub(super) planned_against_active_heads: bool,
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

fn switch_parent_deletes_first(jobs: Vec<MaterializationJob>) -> Vec<MaterializationJob> {
    if !jobs.iter().any(|job| {
        job.operation == MaterializationOperation::Delete
            && job.job_id.starts_with("version-switch-")
    }) {
        return jobs;
    }
    let mut ancestors = HashSet::new();
    for job in &jobs {
        if job.operation == MaterializationOperation::Write
            && job.job_id.starts_with("version-switch-")
        {
            let path = dohc_engine_files::floor::path_collision_key(&job.target_path);
            let mut path = path.as_str();
            while let Some((parent, _)) = path.rsplit_once('/') {
                ancestors.insert(parent.to_owned());
                path = parent;
            }
        }
    }
    if ancestors.is_empty() {
        return jobs;
    }
    let (mut parents, others): (Vec<_>, Vec<_>) = jobs.into_iter().partition(|job| {
        job.operation == MaterializationOperation::Delete
            && job.job_id.starts_with("version-switch-")
            && ancestors.contains(&dohc_engine_files::floor::path_collision_key(
                &job.target_path,
            ))
    });
    parents.extend(others);
    parents
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
    replay_materializations(
        store,
        root_dir,
        scope,
        now_ms,
        faults,
        selected,
        superseded_after_projection_is_drained,
        true,
    )
}

#[allow(clippy::too_many_arguments)]
pub(super) fn replay_publication_materializations(
    store: &mut EngineStore,
    root: &std::path::Path,
    workspace: &str,
    holds: &dohc_engine_files::PlacementHolds,
    recorder: &dyn SelfWriteRecorder,
    now_ms: i64,
    faults: &dyn FaultInjector,
    selected: &HashSet<String>,
) -> Result<MaterializationReplaySummary, RuntimeError> {
    let summary = store.with_materialization_status_batch(|store| {
        replay_materializations(
            store,
            root,
            MaterializationReplayScope {
                holds: Some(holds),
                workspace_id: workspace,
                self_writes: Some(recorder),
                progress: None,
                file_outcomes_settled: false,
                released_hold_paths: None,
                planned_against_active_heads: false,
            },
            now_ms,
            faults,
            Some(selected),
            false,
            false,
        )
    })?;
    // Statuses must reach the ledger before a successful settle can reconcile.
    reconcile_selected_settlement_attempts(store, workspace, selected, now_ms, faults)?;
    Ok(summary)
}

#[allow(clippy::too_many_arguments)]
fn replay_materializations(
    store: &mut EngineStore,
    root_dir: &std::path::Path,
    scope: MaterializationReplayScope<'_>,
    now_ms: i64,
    faults: &dyn FaultInjector,
    selected: Option<&HashSet<String>>,
    superseded_after_projection_is_drained: bool,
    workspace_recovery: bool,
) -> Result<MaterializationReplaySummary, RuntimeError> {
    if store.is_passive() {
        return Ok(MaterializationReplaySummary {
            parked: 0,
            completed: 0,
            failed: 0,
            store_busy: 0,
            selected_seen: 0,
            hard_errors: Vec::new(),
        });
    }
    let loaded_holds;
    let holds = match scope.holds {
        Some(holds) => holds,
        None => {
            loaded_holds = dohc_engine_files::PlacementHolds::load(store, scope.workspace_id)?;
            &loaded_holds
        }
    };
    if workspace_recovery {
        // A crash can leave a replace half done, including for a job that will not
        // run again. Resolve those first, so no displaced file is left unsettled.
        recover_displacements(
            store,
            root_dir,
            Some(scope.workspace_id),
            &MaterializeOptions {
                holds: Some(holds),
                policy: DurabilityPolicy::per_os(),
                replacer: &StdReplacer,
                backoff: &StdBackoff,
                now_ms,
                faults,
            },
        )?;
        reconcile_settlement_attempts(store, scope.workspace_id, now_ms, faults)?;
    }
    let mut jobs = if let Some(selected) = selected {
        let mut jobs = selected
            .iter()
            .map(|id| store.load_materialization_job(id))
            .collect::<Result<Vec<_>, _>>()?
            .into_iter()
            .flatten()
            .collect::<Vec<_>>();
        jobs.sort_by(|a, b| (a.created_at_ms, &a.job_id).cmp(&(b.created_at_ms, &b.job_id)));
        jobs
    } else {
        store.list_pending_materialization_jobs()?
    };
    // Legacy unscoped intents remain replayable in each workspace.
    jobs.retain(|job| {
        job.status == JobStatus::Pending
            && !job.job_id.starts_with("restore-delete-mat_")
            && (job.workspace_id.is_empty() || job.workspace_id == scope.workspace_id)
            && selected.is_none_or(|selected| selected.contains(&job.job_id))
    });
    let jobs = switch_parent_deletes_first(jobs);
    // Filter small replays in SQL; cache the full version only for larger batches.
    let cache_all_paths = jobs
        .iter()
        .filter(|job| job.operation == MaterializationOperation::Delete)
        .take(9)
        .count()
        > 8;
    let summary = (|| -> Result<MaterializationReplaySummary, RuntimeError> {
        let mut summary = MaterializationReplaySummary {
            parked: 0,
            completed: 0,
            failed: 0,
            store_busy: 0,
            selected_seen: 0,
            hard_errors: Vec::new(),
        };
        let mut secret_key: Option<SecretDataKey> = None;
        // Replay changes disk and the job ledger, never active tips.
        let mut active_paths: std::collections::HashMap<String, Vec<String>> = Default::default();
        let mut paths_loaded = false;
        // A delete planned earlier must not remove a file that an active head
        // at another spelling now reaches, as on a disk that ignores case or
        // normalization. That head owns the file, so the delete completes
        // without removing it, unless the head's own write is still pending.
        let mut retire_delete = |store: &mut EngineStore, job: &MaterializationJob| {
            if scope.planned_against_active_heads
                || std::fs::canonicalize(root_dir.join(&job.target_path)).is_err()
            {
                return Ok::<_, RuntimeError>(false);
            }
            let key = dohc_engine_files::floor::path_collision_key(&job.target_path);
            if !paths_loaded && !active_paths.contains_key(&key) {
                // Small replays fold only SQL candidates. Check the exact path
                // before loading the shared cache for a larger batch.
                let candidates = active_projection_paths(store, scope.workspace_id, Some(&key))?;
                if candidates.iter().any(|path| path == &job.target_path) {
                    return Ok(false);
                }
                if cache_all_paths {
                    for path in active_projection_paths(store, scope.workspace_id, None)? {
                        active_paths
                            .entry(dohc_engine_files::floor::path_collision_key(&path))
                            .or_default()
                            .push(path);
                    }
                    paths_loaded = true;
                } else {
                    active_paths.insert(
                        key.clone(),
                        candidates
                            .into_iter()
                            .filter(|path| {
                                dohc_engine_files::floor::path_collision_key(path) == key
                            })
                            .collect(),
                    );
                }
            }
            let Some(candidates) = active_paths.get(&key) else {
                return Ok(false);
            };
            // The replay cache already narrowed this to one collision group.
            let active_targets: HashSet<&str> = candidates.iter().map(String::as_str).collect();
            if active_targets.contains(job.target_path.as_str()) {
                return Ok(false);
            }
            let Some(alias) =
                projection_target_alias(root_dir, &job.target_path, &active_targets, &mut None)
            else {
                return Ok(false);
            };
            if store.read_with(|conn| projection_write_pending(conn, scope.workspace_id, alias))? {
                return Ok(false);
            }
            store.mark_materialization_complete(&job.job_id, now_ms)?;
            Ok(true)
        };
        for job in jobs {
            summary.selected_seen += usize::from(selected.is_some());
            if let Some(progress) = scope.progress {
                progress.fetch_add(1, Ordering::Relaxed);
            }
            if holds.blocks(&job.target_path) {
                summary.parked += 1;
                continue;
            }
            let switch_secret = job.job_id.starts_with("version-switch-secret-mat_");
            let ordinary_secret = job.job_id.starts_with("secret-mat_");
            if switch_secret || ordinary_secret {
                let coordinates = if switch_secret {
                    match switch_projection_matches_active(store, &job, true)? {
                        Some(coordinates) => coordinates,
                        None => {
                            store.mark_materialization_complete(&job.job_id, now_ms)?;
                            if scope.file_outcomes_settled {
                                summary.completed += 1;
                            } else if selected.is_some() {
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
                    if retire_delete(store, &job)? {
                        summary.completed += 1;
                        continue;
                    }
                    match materialize_secret_delete_one(
                        store,
                        root_dir,
                        &job,
                        &MaterializeOptions {
                            holds: Some(holds),
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
                        Ok(JobOutcome::Conflict | JobOutcome::Superseded)
                            if scope.file_outcomes_settled =>
                        {
                            summary.completed += 1
                        }
                        Ok(
                            JobOutcome::Conflict
                            | JobOutcome::Superseded
                            | JobOutcome::Blocked
                            | JobOutcome::Crashed(_),
                        )
                        | Err(_) => summary.failed += 1,
                        Ok(JobOutcome::Parked) => summary.parked += 1,
                    }
                    continue;
                }
                if secret_key.is_none() {
                    let Ok(Some(key)) = load_key_file(super::store_folder(store.database_path()))
                    else {
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
                        holds: Some(holds),
                        policy: DurabilityPolicy::per_os(),
                        replacer: &StdReplacer,
                        backoff: &StdBackoff,
                        now_ms,
                        faults,
                    },
                );
                match outcome {
                    Ok(JobOutcome::Parked) => {
                        if let Some(self_writes) = scope.self_writes {
                            self_writes.retract(
                                scope.workspace_id,
                                &job.target_path,
                                &plaintext_sha,
                            );
                        }
                        summary.parked += 1;
                    }
                    Ok(JobOutcome::Completed | JobOutcome::AlreadyMaterialized) => {
                        summary.completed += 1;
                    }
                    outcome @ Ok(
                        JobOutcome::Conflict
                        | JobOutcome::Superseded
                        | JobOutcome::Blocked
                        | JobOutcome::Crashed(_),
                    )
                    | outcome @ Err(_) => {
                        if let Some(self_writes) = scope.self_writes {
                            self_writes.retract(
                                scope.workspace_id,
                                &job.target_path,
                                &plaintext_sha,
                            );
                        }
                        if scope.file_outcomes_settled
                            && matches!(outcome, Ok(JobOutcome::Conflict | JobOutcome::Superseded))
                        {
                            summary.completed += 1;
                        } else {
                            summary.failed += 1;
                        }
                    }
                }
                continue;
            }
            if job.job_id.starts_with("version-switch-mat_")
                && switch_projection_matches_active(store, &job, false)?.is_none()
            {
                if scope.released_hold_paths.is_some_and(|paths| {
                    paths.contains(&dohc_engine_files::floor::path_collision_key(
                        &job.target_path,
                    ))
                }) && job.operation == MaterializationOperation::Write
                {
                    match dohc_engine_files::materialize_write_conflict(
                        store,
                        root_dir,
                        &job,
                        &MaterializeOptions {
                            holds: Some(holds),
                            policy: DurabilityPolicy::per_os(),
                            replacer: &StdReplacer,
                            backoff: &StdBackoff,
                            now_ms,
                            faults,
                        },
                    ) {
                        Ok(JobOutcome::Conflict) => summary.completed += 1,
                        Ok(JobOutcome::Parked) => summary.parked += 1,
                        _ => summary.failed += 1,
                    }
                } else {
                    store.mark_materialization_complete(&job.job_id, now_ms)?;
                    if scope.file_outcomes_settled {
                        summary.completed += 1;
                    } else if selected.is_some() {
                        summary.failed += 1;
                    }
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
                        if scope.file_outcomes_settled {
                            summary.completed += 1;
                        } else {
                            summary.failed += 1;
                        }
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
            if job.operation == MaterializationOperation::Delete && retire_delete(store, &job)? {
                summary.completed += 1;
                continue;
            }
            if let Some(recorder) = scope.self_writes {
                recorder.record(scope.workspace_id, &job.target_path, &job.content_sha256);
            }
            #[cfg(test)]
            let injected =
                super::history_operations::turns::tests::materialization_error(root_dir, &job);
            #[cfg(not(test))]
            let injected: Option<dohc_engine_files::MaterializeError> = None;
            let outcome = injected.map_or_else(
                || {
                    dohc_engine_files::materialize::materialize_one_ordinary(
                        store,
                        root_dir,
                        &job,
                        &MaterializeOptions {
                            holds: Some(holds),
                            policy: DurabilityPolicy::per_os(),
                            replacer: &StdReplacer,
                            backoff: &StdBackoff,
                            now_ms,
                            faults,
                        },
                    )
                },
                Err,
            );
            if !matches!(
                outcome,
                Ok(JobOutcome::Completed | JobOutcome::AlreadyMaterialized)
            ) && let Some(recorder) = scope.self_writes
            {
                recorder.retract(scope.workspace_id, &job.target_path, &job.content_sha256);
            }
            match outcome {
                Ok(JobOutcome::Parked) => summary.parked += 1,
                Ok(JobOutcome::Completed | JobOutcome::AlreadyMaterialized) => {
                    summary.completed += 1;
                }
                Ok(JobOutcome::Blocked) => summary.failed += 1,
                Ok(JobOutcome::Superseded) if superseded_after_projection_is_drained => {
                    summary.completed += 1;
                }
                Ok(JobOutcome::Conflict | JobOutcome::Superseded) => {
                    if scope.file_outcomes_settled {
                        summary.completed += 1;
                    } else {
                        summary.failed += 1;
                    }
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
                            let compensated = store.write_with(faults, |transaction| {
                                dohc_engine_collab::author_coverage::compensate_in(
                                    transaction,
                                    &dohc_engine_collab::DocKey {
                                        workspace_id,
                                        version_id,
                                        object_id,
                                    },
                                    Some(moment_id),
                                    now_ms,
                                )
                            })?;
                            if matches!(
                                compensated,
                                dohc_engine_storage::TxnOutcome::Crashed { .. }
                            ) {
                                return Err(RuntimeError::OperationCrashed);
                            }
                        }
                    }
                }
                Ok(JobOutcome::Crashed(_)) => summary.failed += 1,
                Err(error) => {
                    summary.failed += 1;
                    match error {
                        dohc_engine_files::MaterializeError::Storage(StorageError::FileLocked) => {
                            summary.store_busy += 1;
                        }
                        dohc_engine_files::MaterializeError::FileLocked => {}
                        _ => summary
                            .hard_errors
                            .push((job.job_id.clone(), format!("{}: {error}", job.target_path))),
                    }
                }
            }
        }
        if workspace_recovery {
            reconcile_settlement_attempts(store, scope.workspace_id, now_ms, faults)?;
        }
        Ok(summary)
    })()?;
    if !workspace_recovery {
        return Ok(summary);
    }
    let checked_jobs = store.read_with(|conn| {
        let mut stmt = conn
            .prepare(
                "SELECT job_id FROM materialization_jobs \
                 WHERE workspace_id = ?1 AND job_id GLOB 'restore-delete-mat_*'",
            )
            .map_err(StorageError::corrupt_public)?;
        stmt.query_map([scope.workspace_id], |r| r.get::<_, String>(0))
            .map_err(StorageError::corrupt_public)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(StorageError::corrupt_public)
    })?;
    for job_id in checked_jobs {
        let recorder: &dyn SelfWriteRecorder = scope.self_writes.unwrap_or(&());
        match super::versioned::publish_checked_delete_on_store(
            store,
            root_dir,
            scope.workspace_id,
            &job_id,
            recorder,
            now_ms,
            faults,
            true,
            false,
            Some(holds),
        ) {
            Ok(()) => {}
            Err(RuntimeError::OperationCrashed) => return Err(RuntimeError::OperationCrashed),
            Err(RuntimeError::CaptureFileHeld { .. }) => {}
            Err(error) => {
                let disposition = if matches!(store.load_materialization_job(&job_id), Ok(Some(_)))
                {
                    "deferred"
                } else {
                    "refused"
                };
                eprintln!("engine: checked deletion {disposition} during recovery: {error}");
            }
        }
    }
    Ok(summary)
}

// ASCII collision keys lowercase each segment and strip trailing dots/spaces.
// Keep Unicode and trailing aliases for the full Rust collision-key check.
const ACTIVE_PROJECTION_PATHS: &str =
    "SELECT path FROM snapshots WHERE workspace_id=?1 AND version_id=?2
       AND (?3 IS NULL OR path=?3 COLLATE NOCASE OR path GLOB '*[^ -~]*'
            OR path GLOB '*[. ]/*' OR path GLOB '*[. ]')
     UNION ALL SELECT path FROM secret_files WHERE workspace_id=?1 AND version_id=?2
       AND (?3 IS NULL OR path=?3 COLLATE NOCASE OR path GLOB '*[^ -~]*'
            OR path GLOB '*[. ]/*' OR path GLOB '*[. ]')";

fn active_projection_paths(
    store: &mut EngineStore,
    workspace_id: &str,
    collision_key: Option<&str>,
) -> Result<Vec<String>, RuntimeError> {
    let version = match VersionedTextStore::new(store).get_active_version(workspace_id) {
        Ok(version) => version,
        Err(DomainError::WorkspaceNotFound) => return Ok(Vec::new()),
        Err(error) => return Err(error.into()),
    };
    store.read_with(|conn| {
        let mut statement = conn
            .prepare_cached(ACTIVE_PROJECTION_PATHS)
            .map_err(StorageError::corrupt_public)?;
        let paths = statement
            .query_map(
                params![workspace_id, version.version_id, collision_key],
                |row| row.get(0),
            )
            .map_err(StorageError::corrupt_public)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(StorageError::corrupt_public)?;
        Ok(paths)
    })
}

// A pending create still needs the old entry removed before it can place
// its bytes. Only retire an alias delete after that write has settled.
fn projection_write_pending(
    conn: &rusqlite::Connection,
    workspace_id: &str,
    path: &str,
) -> Result<bool, StorageError> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM materialization_jobs
         WHERE (workspace_id=?1 OR workspace_id='') AND target_path=?2
           AND status='pending' AND operation='write')",
        params![workspace_id, path],
        |row| row.get(0),
    )
    .map_err(StorageError::corrupt_public)
}

#[allow(clippy::too_many_arguments)]
pub(super) fn materialize_pending_job(
    store: &EngineStore,
    root_dir: &std::path::Path,
    workspace_id: &str,
    job: &MaterializationJob,
    self_writes: &dyn SelfWriteRecorder,
    now_ms: i64,
    faults: &dyn FaultInjector,
    holds: Option<&dohc_engine_files::PlacementHolds>,
) -> (bool, PostCommitMaterializeOutcome) {
    if job.job_id.starts_with("restore-delete-mat_") {
        return (false, PostCommitMaterializeOutcome::Skipped);
    }
    // Register before replacement: the watcher may observe the write as soon
    // as the atomic rename lands. Every non-applied outcome retracts the
    // identity because no self-write is then available to consume it.
    self_writes.record(workspace_id, &job.target_path, &job.content_sha256);
    let outcome = materialize_one(
        store,
        root_dir,
        job,
        &MaterializeOptions {
            holds,
            policy: DurabilityPolicy::per_os(),
            replacer: &StdReplacer,
            backoff: &StdBackoff,
            now_ms,
            faults,
        },
    );
    let (materialized, reported) = match outcome {
        Ok(JobOutcome::Parked) => {
            self_writes.retract(workspace_id, &job.target_path, &job.content_sha256);
            (false, PostCommitMaterializeOutcome::Parked)
        }
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

#[allow(clippy::too_many_arguments)]
pub(super) fn materialize_expected_job(
    store: &EngineStore,
    root_dir: &std::path::Path,
    workspace_id: &str,
    job_id: &str,
    self_writes: &dyn SelfWriteRecorder,
    now_ms: i64,
    faults: &dyn FaultInjector,
    holds: Option<&dohc_engine_files::PlacementHolds>,
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
                holds,
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
        PostCommitMaterializeOutcome::Parked => 3,
        PostCommitMaterializeOutcome::Conflict => 4,
        PostCommitMaterializeOutcome::Error => 5,
    }
}

fn reconcile_selected_settlement_attempts(
    store: &mut EngineStore,
    workspace: &str,
    selected: &HashSet<String>,
    now_ms: i64,
    faults: &dyn FaultInjector,
) -> Result<(), RuntimeError> {
    for id in selected {
        let Some(moment) = id.strip_prefix("ydoc-mat_") else {
            continue;
        };
        let key = store.read_with(|conn| {
            conn.query_row(
                "SELECT d.workspace_id,d.version_id,d.object_id FROM moments m
             JOIN ydoc_docs d ON d.workspace_id=m.workspace_id AND d.version_id=m.version_id
             AND d.object_id=m.object_id AND d.settle_seq=m.moment_order
             JOIN materialization_jobs j ON j.job_id='ydoc-mat_'||m.moment_id
             WHERE m.moment_id=?1 AND d.workspace_id=?2 AND d.settle_prior_update_seq IS NOT NULL
             AND j.status!='pending'",
                params![moment, workspace],
                |r| {
                    Ok(dohc_engine_collab::DocKey {
                        workspace_id: r.get(0)?,
                        version_id: r.get(1)?,
                        object_id: r.get(2)?,
                    })
                },
            )
            .optional()
            .map_err(StorageError::corrupt_public)
        })?;
        if let Some(key) = key
            && matches!(
                store.write_with(faults, |tx| {
                    dohc_engine_collab::author_coverage::reconcile_in(tx, &key, now_ms)
                })?,
                dohc_engine_storage::TxnOutcome::Crashed { .. }
            )
        {
            return Err(RuntimeError::OperationCrashed);
        }
    }
    Ok(())
}

fn reconcile_settlement_attempts(
    store: &mut EngineStore,
    workspace_id: &str,
    now_ms: i64,
    faults: &dyn FaultInjector,
) -> Result<(), RuntimeError> {
    let unresolved: bool = store.read_with(|conn| {
        conn.query_row("SELECT EXISTS(SELECT 1 FROM ydoc_docs WHERE workspace_id=?1 AND settle_prior_update_seq IS NOT NULL)",
            [workspace_id], |row| row.get(0)).map_err(StorageError::persist_public)
    })?;
    if unresolved
        && matches!(
            store.write_with(faults, |tx| {
                dohc_engine_collab::author_coverage::reconcile_workspace_in(
                    tx,
                    workspace_id,
                    now_ms,
                )
            })?,
            dohc_engine_storage::TxnOutcome::Crashed { .. }
        )
    {
        return Err(RuntimeError::OperationCrashed);
    }
    Ok(())
}

#[cfg(test)]
mod switch_order_tests {
    use super::*;
    use dohc_engine_storage::Preimage;

    fn switch_job(id: &str, path: &str, operation: MaterializationOperation) -> MaterializationJob {
        MaterializationJob {
            job_id: format!("version-switch-mat_{id}"),
            workspace_id: "ws".to_owned(),
            target_path: path.to_owned(),
            content_sha256: hex_sha256(b""),
            operation,
            preimage: Preimage::Absent,
            target_generation: 1,
            status: JobStatus::Pending,
            created_at_ms: 1,
        }
    }

    /// A switch that turns the file `café` into a folder deletes the file
    /// first, though the folder is spelled in the other Unicode
    /// normalization: a disk that ignores normalization holds one name.
    #[test]
    fn a_parent_delete_in_another_normalization_runs_first() {
        let ordered = switch_parent_deletes_first(vec![
            switch_job(
                "write",
                "caf\u{e9}/plan.md",
                MaterializationOperation::Write,
            ),
            switch_job("delete", "cafe\u{301}", MaterializationOperation::Delete),
        ]);
        assert_eq!(
            ordered
                .iter()
                .map(|job| job.job_id.as_str())
                .collect::<Vec<_>>(),
            ["version-switch-mat_delete", "version-switch-mat_write"]
        );
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

#[cfg(test)]
mod projection_candidate_tests {
    use super::*;

    #[test]
    fn materialization_candidates_keep_unicode_and_trailing_aliases() {
        let paths = [
            "Notes.md",
            "notes.md",
            "K.md",
            "k.md",
            "k.md.",
            "k. /child.md",
            "unrelated.md",
        ];
        let root = dohc_engine_testkit::ScratchDir::new().unwrap();
        let db = dohc_engine_testkit::engine_db_path(&root).unwrap();
        let mut store = EngineStore::open(&db, 1).unwrap();
        VersionedTextStore::new(&mut store)
            .ensure_main_version("projection-candidates", "main", 1, &NoFaults)
            .unwrap();
        store
            .write_with(&NoFaults, |tx| {
                let sha = hex_sha256(b"old");
                tx.execute("INSERT INTO blobs(sha256,byte_length,text) VALUES (?1,3,'old')", [&sha])
                    .map_err(StorageError::persist_public)?;
                for (n, path) in paths.iter().enumerate() {
                    let object = format!("live-{n}");
                    tx.execute("INSERT INTO file_objects(workspace_id,object_id,created_at_ms) VALUES ('projection-candidates',?1,1)", [&object])
                        .map_err(StorageError::persist_public)?;
                    tx.execute("INSERT INTO snapshots(workspace_id,version_id,object_id,path,blob_sha256,updated_at_ms,latest_moment_id,metadata_origin) VALUES ('projection-candidates','main',?1,?2,?3,1,'fixture','api')", params![object,path,sha])
                        .map_err(StorageError::persist_public)?;
                }
                Ok::<_, StorageError>(())
            })
            .unwrap();
        for key in ["notes.md", "k.md", "k/child.md"] {
            let mut actual =
                active_projection_paths(&mut store, "projection-candidates", Some(key))
                    .unwrap()
                    .into_iter()
                    .filter(|path| dohc_engine_files::floor::path_collision_key(path) == key)
                    .collect::<Vec<_>>();
            let mut expected = paths
                .iter()
                .filter(|path| dohc_engine_files::floor::path_collision_key(path) == key)
                .map(|path| (*path).to_owned())
                .collect::<Vec<_>>();
            actual.sort();
            expected.sort();
            assert_eq!(actual, expected);
        }
    }
}
