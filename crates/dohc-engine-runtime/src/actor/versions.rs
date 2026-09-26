use super::ActorHandle;
use super::journal::journal_version_create_outbound_in_tx;
use super::materialization::{
    MaterializationReplayScope, SelfWriteRecorder, replay_pending_materializations,
    rollback_job_matches_active,
};
use crate::error::RuntimeError;
use crate::search::{read_engine_search_policy, resolve_effective_policy};
use dohc_engine_crypto::{SecretDataKey, load_key_file};
use dohc_engine_domain::{
    CreateNamedVersion, DomainError, ListMomentsQuery, MomentPage, MomentRecord, SecretFileStore,
    SecretMomentRecord, SnapshotContent, SnapshotMetadata, VersionFileChangePage, VersionRecord,
    VersionedTextStore, list_secret_files_keyless, list_secret_moments_in_time_window_keyless,
};
use dohc_engine_files::{
    ProjectionTargetKind, ProjectionTargetState, probe_projection_target,
    remove_empty_directory_target, target_has_requested_name,
};
use dohc_engine_storage::{
    EngineStore, FaultInjector, MaterializationJobSpec, MaterializationOperation, Preimage,
    StorageError, TxnOutcome, hex_sha256, put_binary_blob, upsert_projection_job,
};
use rusqlite::{OptionalExtension, params};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

/// One active-version history page read in a single actor turn.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HistoryPageRead {
    pub active_version: VersionRecord,
    pub text_moment_page: MomentPage,
    /// A limit+1 probe. The protocol layer applies the row and wire-byte cuts
    /// and reports whether either cut omitted protected activity in the time
    /// window.
    pub protected_moments: Vec<SecretMomentRecord>,
    pub upper_recorded_at_ms: Option<i64>,
}

pub struct ActiveVersionSwitch {
    pub workspace_id: String,
    pub version_id: String,
    pub root_dir: PathBuf,
    pub self_writes: Arc<dyn SelfWriteRecorder>,
    pub now_ms: i64,
}

impl ActorHandle {
    pub async fn capture_sources(
        &self,
        workspace_id: String,
        version_id: String,
        paths: Vec<String>,
        bounds: dohc_engine_domain::store::SourceCaptureBounds,
    ) -> Result<dohc_engine_domain::store::SourceCapture, RuntimeError> {
        self.run(move |store, _| {
            VersionedTextStore::new(store)
                .capture_sources(&workspace_id, &version_id, &paths, &bounds)
                .map_err(RuntimeError::from)
        })
        .await
    }

    pub async fn compare_version_files_page(
        &self,
        workspace_id: String,
        source_version_id: String,
        target_version_id: String,
        after_path: Option<String>,
        limit: usize,
    ) -> Result<VersionFileChangePage, RuntimeError> {
        self.run(move |store, _| {
            VersionedTextStore::new(store)
                .compare_version_files_page(
                    &workspace_id,
                    &source_version_id,
                    &target_version_id,
                    after_path.as_deref(),
                    limit,
                )
                .map_err(RuntimeError::from)
        })
        .await
    }

    /// Every version record in the workspace, oldest-first
    /// (`created_at_ms, name, version_id`) — the read behind `versions.list`.
    pub async fn list_versions(
        &self,
        workspace_id: String,
    ) -> Result<Vec<VersionRecord>, RuntimeError> {
        self.run(move |store, _| {
            VersionedTextStore::new(store)
                .list_versions(&workspace_id)
                .map_err(RuntimeError::from)
        })
        .await
    }

    /// One page of snapshot METADATA (no body hydration) — the listing read
    /// behind `versionedText.list`.
    pub async fn list_snapshot_metadata(
        &self,
        workspace_id: String,
        version_id: String,
        after_path: Option<String>,
        limit: usize,
    ) -> Result<Vec<SnapshotMetadata>, RuntimeError> {
        self.run(move |store, _| {
            VersionedTextStore::new(store)
                .list_snapshot_metadata(&workspace_id, &version_id, after_path.as_deref(), limit)
                .map_err(RuntimeError::from)
        })
        .await
    }

    pub async fn list_moments(&self, query: ListMomentsQuery) -> Result<MomentPage, RuntimeError> {
        self.run(move |store, _| {
            VersionedTextStore::new(store)
                .list_moments(&query)
                .map_err(RuntimeError::from)
        })
        .await
    }

    pub async fn history_page(
        &self,
        workspace_id: String,
        limit: i64,
        before_moment_order: Option<i64>,
        protected_probe_limit: usize,
    ) -> Result<HistoryPageRead, RuntimeError> {
        self.run(move |store, _| {
            (|| {
                let versioned = VersionedTextStore::new(store);
                let active_version = versioned.get_active_version(&workspace_id)?;
                let text_moment_page = versioned.list_moments(&ListMomentsQuery {
                    workspace_id: workspace_id.clone(),
                    version_id: Some(active_version.version_id.clone()),
                    object_id: None,
                    limit,
                    before_moment_order,
                })?;
                let upper_recorded_at_ms = before_moment_order
                    .map(|cursor| {
                        let through_cursor =
                            cursor.checked_add(1).ok_or(DomainError::InvalidInput {
                                reason: "before_moment_order is too large",
                            })?;
                        versioned
                            .list_moments(&ListMomentsQuery {
                                workspace_id: workspace_id.clone(),
                                version_id: Some(active_version.version_id.clone()),
                                object_id: None,
                                limit: 1,
                                before_moment_order: Some(through_cursor),
                            })
                            .map(|page| page.moments.first().map(|moment| moment.recorded_at_ms))
                    })
                    .transpose()?
                    .flatten();
                let lower_recorded_at_ms =
                    text_moment_page.next_before_moment_order.and_then(|_| {
                        text_moment_page
                            .moments
                            .last()
                            .map(|moment| moment.recorded_at_ms)
                    });
                let protected_moments = list_secret_moments_in_time_window_keyless(
                    store,
                    &workspace_id,
                    &active_version.version_id,
                    lower_recorded_at_ms,
                    upper_recorded_at_ms,
                    protected_probe_limit,
                )?;
                Ok::<HistoryPageRead, DomainError>(HistoryPageRead {
                    active_version,
                    text_moment_page,
                    protected_moments,
                    upper_recorded_at_ms,
                })
            })()
            .map_err(RuntimeError::from)
        })
        .await
    }

    pub async fn get_moment(
        &self,
        workspace_id: String,
        moment_id: String,
    ) -> Result<Option<MomentRecord>, RuntimeError> {
        self.run(move |store, _| {
            VersionedTextStore::new(store)
                .get_moment(&workspace_id, &moment_id)
                .map_err(RuntimeError::from)
        })
        .await
    }

    /// The workspace's active version id (falling back to main), read on the
    /// actor thread. The capture driver targets this so captures land in the
    /// version the user is actually on (TS oracle parity).
    pub async fn active_version_id(&self, workspace_id: String) -> Result<String, RuntimeError> {
        self.run(move |store, _| {
            VersionedTextStore::new(store)
                .get_active_version(&workspace_id)
                .map(|version| version.version_id)
                .map_err(RuntimeError::from)
        })
        .await
    }

    pub async fn active_version(
        &self,
        workspace_id: String,
    ) -> Result<VersionRecord, RuntimeError> {
        self.run(move |store, _| {
            VersionedTextStore::new(store)
                .get_active_version(&workspace_id)
                .map_err(RuntimeError::from)
        })
        .await
    }

    pub async fn ensure_main_version(
        &self,
        workspace_id: String,
        now_ms: i64,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
    ) -> Result<VersionRecord, RuntimeError> {
        self.run(move |store, _| {
            if token.is_cancelled() {
                Err(RuntimeError::Cancelled)
            } else {
                VersionedTextStore::new(store)
                    .ensure_main_version(&workspace_id, "main", now_ms, faults.as_ref())
                    .map_err(RuntimeError::from)
            }
        })
        .await
    }

    pub async fn set_active_version(
        &self,
        input: ActiveVersionSwitch,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
    ) -> Result<VersionRecord, RuntimeError> {
        self.run(move |store, _cache| {
            switch_active_version_on_store(
                store,
                &input.workspace_id,
                &input.version_id,
                &input.root_dir,
                input.self_writes.as_ref(),
                input.now_ms,
                faults.as_ref(),
                &token,
            )
        })
        .await
    }

    pub async fn create_named_version(
        &self,
        input: CreateNamedVersion,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
    ) -> Result<VersionRecord, RuntimeError> {
        self.run(move |store, _| {
            if token.is_cancelled() {
                Err(RuntimeError::Cancelled)
            } else {
                VersionedTextStore::new(store)
                    .create_named_version_with(&input, faults.as_ref(), |tx, record| {
                        journal_version_create_outbound_in_tx(tx, record, &input.from_version_id)
                    })
                    .map_err(RuntimeError::from)
            }
        })
        .await
    }

    pub async fn preflight_create_named_version(
        &self,
        input: CreateNamedVersion,
        token: CancellationToken,
    ) -> Result<Option<VersionRecord>, RuntimeError> {
        self.run(move |store, _| {
            if token.is_cancelled() {
                Err(RuntimeError::Cancelled)
            } else {
                VersionedTextStore::new(store)
                    .preflight_create_named_version(&input)
                    .map_err(RuntimeError::from)
            }
        })
        .await
    }
}

struct SwitchProjection {
    spec: MaterializationJobSpec,
    operation: MaterializationOperation,
    inline_content: Option<Vec<u8>>,
}

fn projection_preimage(state: &ProjectionTargetState) -> Option<Preimage> {
    match state {
        ProjectionTargetState::Absent => Some(Preimage::Absent),
        ProjectionTargetState::Text { sha256 } | ProjectionTargetState::Binary { sha256 } => {
            Some(Preimage::Present(sha256.clone()))
        }
        ProjectionTargetState::UntrackedContent | ProjectionTargetState::Unreadable => None,
    }
}

/// Equal bytes need no write, whichever kind the snapshot and the disk file
/// have. A snapshot stored as binary before its path was read as text still
/// matches the same bytes on disk.
fn projection_matches(state: &ProjectionTargetState, desired_sha256: &str) -> bool {
    matches!(
        state,
        ProjectionTargetState::Text { sha256 } | ProjectionTargetState::Binary { sha256 }
            if sha256 == desired_sha256
    )
}

pub(super) fn switch_projection_job_id(
    workspace_id: &str,
    version_id: &str,
    path: &str,
    operation: MaterializationOperation,
    content_sha256: &str,
    secret: bool,
) -> String {
    let operation = match operation {
        MaterializationOperation::Write => "write",
        MaterializationOperation::Delete => "delete",
    };
    let identity = format!(
        "{workspace_id}\0{version_id}\0{path}\0{operation}\0{content_sha256}\0{}",
        if secret { "secret" } else { "plain" }
    );
    let prefix = if secret {
        "version-switch-secret-mat_"
    } else {
        "version-switch-mat_"
    };
    format!("{prefix}{}", hex_sha256(identity.as_bytes()))
}

/// Whether `path` lies strictly inside the directory `ancestor`.
fn is_inside(root: &std::path::Path, path: &str, ancestor: &str) -> bool {
    let Some((end, _)) = path
        .match_indices('/')
        .nth(ancestor.bytes().filter(|byte| *byte == b'/').count())
    else {
        return false;
    };
    let prefix = &path[..end];
    if prefix.is_ascii()
        && ancestor.is_ascii()
        && !prefix.split('/').zip(ancestor.split('/')).all(|(a, b)| {
            a.trim_end_matches(['.', ' '])
                .eq_ignore_ascii_case(b.trim_end_matches(['.', ' ']))
        })
    {
        return false;
    }
    prefix == ancestor
        || (prefix
            .split('/')
            .map(dohc_engine_sync::path_component_collision_key)
            .eq(ancestor
                .split('/')
                .map(dohc_engine_sync::path_component_collision_key))
            && same_projection_file(root, prefix, ancestor))
}

fn same_projection_file(root: &std::path::Path, source: &str, target: &str) -> bool {
    dohc_engine_files::materialize::same_existing_file(&root.join(source), &root.join(target))
}

fn relay_case_replacement_paths(
    changes: &[dohc_engine_sync::MomentMaterializationChange],
) -> HashMap<String, String> {
    use dohc_engine_sync::path_component_collision_key;
    changes
        .iter()
        .filter(|change| change.operation == "delete")
        .filter_map(|change| {
            changes
                .iter()
                .find(|other| {
                    other.operation == "write"
                        && other.version_id == change.version_id
                        && other.path != change.path
                        && other
                            .path
                            .split('/')
                            .map(path_component_collision_key)
                            .eq(change.path.split('/').map(path_component_collision_key))
                })
                .map(|other| (change.path.clone(), other.path.clone()))
        })
        .collect()
}

/// Enqueue one batch of a sync page in one transaction and materialize it in
/// one replay. Clears `projections` and adds the batch's deletes to
/// `deleted`.
fn run_relay_batch(
    store: &mut EngineStore,
    root_dir: &std::path::Path,
    workspace_id: &str,
    self_writes: &dyn SelfWriteRecorder,
    projections: &mut Vec<SwitchProjection>,
    deleted: &mut Vec<String>,
    now_ms: i64,
) -> Result<(), RuntimeError> {
    if projections.is_empty() {
        return Ok(());
    }
    let batch = std::mem::take(projections);
    let outcome = store.write_with(&dohc_engine_storage::NoFaults, |tx| {
        for projection in &batch {
            if let Some(bytes) = projection.inline_content.as_deref()
                && put_binary_blob(tx, bytes)? != projection.spec.content_sha256
            {
                return Err(StorageError::corrupt_public(rusqlite::Error::InvalidQuery));
            }
            upsert_projection_job(tx, &projection.spec, projection.operation)?;
        }
        Ok::<_, StorageError>(())
    })?;
    if matches!(outcome, TxnOutcome::Crashed { .. }) {
        return Err(RuntimeError::OperationCrashed);
    }
    for projection in &batch {
        if projection.operation == MaterializationOperation::Delete {
            deleted.push(projection.spec.target_path.clone());
        }
    }
    let selected: HashSet<String> = batch
        .into_iter()
        .map(|projection| projection.spec.job_id)
        .collect();
    let replay = replay_pending_materializations(
        store,
        root_dir,
        MaterializationReplayScope {
            workspace_id,
            self_writes: Some(self_writes),
            progress: None,
        },
        now_ms,
        &dohc_engine_storage::NoFaults,
        Some(&selected),
        false,
    )?;
    let failed_jobs = replay.failed + selected.len().saturating_sub(replay.selected_seen);
    if failed_jobs > 0 {
        return Err(RuntimeError::ActiveVersionMaterializationIncomplete { failed_jobs });
    }
    Ok(())
}

#[allow(
    clippy::too_many_arguments,
    reason = "durable projection fields remain explicit at each planner branch"
)]
fn planned_projection(
    workspace_id: &str,
    version_id: &str,
    path: String,
    operation: MaterializationOperation,
    content_sha256: String,
    preimage: Preimage,
    target_generation: i64,
    now_ms: i64,
    secret: bool,
    inline_content: Option<Vec<u8>>,
) -> SwitchProjection {
    SwitchProjection {
        spec: MaterializationJobSpec {
            job_id: switch_projection_job_id(
                workspace_id,
                version_id,
                &path,
                operation,
                &content_sha256,
                secret,
            ),
            workspace_id: workspace_id.to_owned(),
            target_path: path,
            content_sha256,
            preimage,
            target_generation,
            now_ms,
        },
        operation,
        inline_content,
    }
}

#[allow(
    clippy::too_many_arguments,
    reason = "projection coordinates and rollback-only pre-state paths are independent"
)]
fn plan_plaintext_switch(
    store: &mut EngineStore,
    workspace_id: &str,
    target_version_id: &str,
    previous_version_id: &str,
    additional_previous_paths: &[(&str, i64)],
    root_dir: &std::path::Path,
    now_ms: i64,
    token: &CancellationToken,
) -> Result<Vec<SwitchProjection>, RuntimeError> {
    let target = VersionedTextStore::new(store)
        .list_snapshots(workspace_id, target_version_id)
        .map_err(RuntimeError::from)?;
    let target_paths: HashSet<&str> = target
        .iter()
        .map(|snapshot| snapshot.path.as_str())
        .collect();
    let policy = read_engine_search_policy(root_dir);
    if policy.is_degraded() {
        return Err(DomainError::StateCorrupt {
            reason: "workspace file policy is unavailable during version switch",
        }
        .into());
    }
    let mut projections = Vec::new();
    if !policy.is_degraded() {
        for snapshot in &target {
            if token.is_cancelled() {
                return Err(RuntimeError::Cancelled);
            }
            if !resolve_effective_policy(
                &snapshot.path,
                policy.files_policy.as_deref(),
                policy.visibility_policy.as_deref(),
            )
            .tracked
            {
                continue;
            }
            let state =
                probe_projection_target(root_dir, &snapshot.path, ProjectionTargetKind::Plaintext);
            let Some(preimage) = projection_preimage(&state) else {
                continue;
            };
            let (desired_sha256, inline_content) = match &snapshot.content {
                SnapshotContent::Text { text } => {
                    (hex_sha256(text.as_bytes()), Some(text.as_bytes().to_vec()))
                }
                SnapshotContent::Binary { sha256 } => (sha256.clone(), None),
            };
            if projection_matches(&state, &desired_sha256) {
                continue;
            }
            projections.push(planned_projection(
                workspace_id,
                target_version_id,
                snapshot.path.clone(),
                MaterializationOperation::Write,
                desired_sha256,
                preimage,
                snapshot.updated_at_ms,
                now_ms,
                false,
                inline_content,
            ));
        }
    }
    let previous = VersionedTextStore::new(store)
        .list_snapshots(workspace_id, previous_version_id)
        .map_err(RuntimeError::from)?;
    let mut previous_paths: Vec<(String, i64)> = previous
        .into_iter()
        .map(|snapshot| (snapshot.path, snapshot.updated_at_ms))
        .collect();
    for (path, target_generation) in additional_previous_paths {
        if !previous_paths
            .iter()
            .any(|(previous_path, _)| previous_path == path)
        {
            previous_paths.push(((*path).to_owned(), *target_generation));
        }
    }
    if !policy.is_degraded() {
        let empty_sha = hex_sha256(&[]);
        for (path, target_generation) in previous_paths {
            if token.is_cancelled() {
                return Err(RuntimeError::Cancelled);
            }
            if target_paths.contains(path.as_str())
                || !resolve_effective_policy(
                    &path,
                    policy.files_policy.as_deref(),
                    policy.visibility_policy.as_deref(),
                )
                .tracked
            {
                continue;
            }
            let state = probe_projection_target(root_dir, &path, ProjectionTargetKind::Plaintext);
            let Some(preimage @ Preimage::Present(_)) = projection_preimage(&state) else {
                continue;
            };
            projections.push(planned_projection(
                workspace_id,
                target_version_id,
                path,
                MaterializationOperation::Delete,
                empty_sha.clone(),
                preimage,
                target_generation,
                now_ms,
                false,
                Some(Vec::new()),
            ));
        }
    }
    Ok(projections)
}

fn secret_ciphertext_sha(
    store: &EngineStore,
    workspace_id: &str,
    version_id: &str,
    path: &str,
) -> Result<String, RuntimeError> {
    let ciphertext_base64: Option<String> = store.read_with(|connection| {
        connection
            .query_row(
                "SELECT ciphertext_base64 FROM secret_files \
                 WHERE workspace_id = ?1 AND version_id = ?2 AND path = ?3",
                params![workspace_id, version_id, path],
                |row| row.get(0),
            )
            .optional()
            .map_err(StorageError::corrupt_public)
    })?;
    let ciphertext_base64 = ciphertext_base64.ok_or(DomainError::StateCorrupt {
        reason: "secret tip has no ciphertext identity",
    })?;
    let ciphertext = dohc_engine_crypto::base64::forgiving_decode(&ciphertext_base64);
    Ok(hex_sha256(&ciphertext))
}

fn load_projection_secret_key(root_dir: &std::path::Path) -> Result<SecretDataKey, RuntimeError> {
    load_key_file(root_dir)
        .map_err(DomainError::from)?
        .ok_or_else(|| {
            RuntimeError::from(DomainError::StateCorrupt {
                reason: "workspace secret key is unavailable",
            })
        })
}

#[allow(
    clippy::too_many_arguments,
    reason = "the planner keeps key custody and switch coordinates explicit"
)]
fn plan_secret_switch(
    store: &mut EngineStore,
    workspace_id: &str,
    target_version_id: &str,
    previous_version_id: &str,
    root_dir: &std::path::Path,
    now_ms: i64,
    token: &CancellationToken,
    secret_key: &mut Option<SecretDataKey>,
) -> Result<Vec<SwitchProjection>, RuntimeError> {
    let target = list_secret_files_keyless(store, workspace_id, target_version_id)?;
    let target_paths: HashSet<&str> = target.iter().map(|stat| stat.path.as_str()).collect();
    let mut projections = Vec::new();
    for stat in &target {
        if token.is_cancelled() {
            return Err(RuntimeError::Cancelled);
        }
        let state = probe_projection_target(root_dir, &stat.path, ProjectionTargetKind::Secret);
        let Some(preimage) = projection_preimage(&state) else {
            continue;
        };
        if secret_key.is_none() {
            *secret_key = Some(load_projection_secret_key(root_dir)?);
        }
        let plaintext =
            SecretFileStore::new(store, secret_key.as_ref().expect("secret key loaded"))
                .materialize_secret_file(workspace_id, target_version_id, &stat.path)?
                .ok_or(DomainError::StateCorrupt {
                    reason: "secret tip could not be materialized",
                })?;
        let desired_plaintext_sha = hex_sha256(plaintext.as_bytes());
        let already_equal = matches!(
            &state,
            ProjectionTargetState::Text { sha256 } if sha256 == &desired_plaintext_sha
        );
        drop(plaintext);
        if already_equal {
            continue;
        }
        let ciphertext_sha =
            secret_ciphertext_sha(store, workspace_id, target_version_id, &stat.path)?;
        projections.push(planned_projection(
            workspace_id,
            target_version_id,
            stat.path.clone(),
            MaterializationOperation::Write,
            ciphertext_sha,
            preimage,
            stat.updated_at_ms,
            now_ms,
            true,
            None,
        ));
    }
    let previous = list_secret_files_keyless(store, workspace_id, previous_version_id)?;
    let empty_sha = hex_sha256(&[]);
    for stat in previous {
        if token.is_cancelled() {
            return Err(RuntimeError::Cancelled);
        }
        if target_paths.contains(stat.path.as_str()) {
            continue;
        }
        let state = probe_projection_target(root_dir, &stat.path, ProjectionTargetKind::Secret);
        let Some(preimage @ Preimage::Present(_)) = projection_preimage(&state) else {
            continue;
        };
        projections.push(planned_projection(
            workspace_id,
            target_version_id,
            stat.path,
            MaterializationOperation::Delete,
            empty_sha.clone(),
            preimage,
            stat.updated_at_ms,
            now_ms,
            true,
            Some(Vec::new()),
        ));
    }
    Ok(projections)
}

#[allow(
    clippy::too_many_arguments,
    reason = "projection coordinates, disk suppression, faults, and cancellation are independent"
)]
pub(super) fn reconcile_active_plaintext_projection_on_store(
    store: &mut EngineStore,
    workspace_id: &str,
    active_version_id: &str,
    inactive_version_id: &str,
    rollback_paths: &[(&str, i64)],
    root_dir: &std::path::Path,
    self_writes: &dyn SelfWriteRecorder,
    now_ms: i64,
    faults: &dyn FaultInjector,
    token: &CancellationToken,
) -> Result<(), RuntimeError> {
    let projections = plan_plaintext_switch(
        store,
        workspace_id,
        active_version_id,
        inactive_version_id,
        rollback_paths,
        root_dir,
        now_ms,
        token,
    )?;
    if projections.is_empty() {
        return Ok(());
    }
    let outcome = store.write_with(faults, |tx| {
        for projection in &projections {
            if let Some(content) = projection.inline_content.as_deref() {
                let stored_sha = put_binary_blob(tx, content)?;
                if stored_sha != projection.spec.content_sha256 {
                    return Err(StorageError::corrupt_public(rusqlite::Error::InvalidQuery));
                }
            }
            upsert_projection_job(tx, &projection.spec, projection.operation)?;
        }
        Ok::<_, StorageError>(())
    })?;
    if matches!(outcome, TxnOutcome::Crashed { .. }) {
        return Err(RuntimeError::OperationCrashed);
    }
    let selected: HashSet<String> = projections
        .iter()
        .map(|projection| projection.spec.job_id.clone())
        .collect();
    let replay = replay_pending_materializations(
        store,
        root_dir,
        MaterializationReplayScope {
            workspace_id,
            self_writes: Some(self_writes),
            progress: None,
        },
        now_ms,
        faults,
        Some(&selected),
        false,
    )?;
    let failed_jobs = replay.failed + selected.len().saturating_sub(replay.selected_seen);
    if failed_jobs > 0 {
        return Err(RuntimeError::ActiveVersionMaterializationIncomplete { failed_jobs });
    }
    Ok(())
}

#[allow(
    clippy::too_many_arguments,
    reason = "switch ordering, disk root, suppression, faults, and cancellation are independent"
)]
fn switch_active_version_on_store(
    store: &mut EngineStore,
    workspace_id: &str,
    version_id: &str,
    root_dir: &std::path::Path,
    self_writes: &dyn SelfWriteRecorder,
    now_ms: i64,
    faults: &dyn FaultInjector,
    token: &CancellationToken,
) -> Result<VersionRecord, RuntimeError> {
    if token.is_cancelled() {
        return Err(RuntimeError::Cancelled);
    }
    let previous = VersionedTextStore::new(store).get_active_version(workspace_id)?;
    let target = VersionedTextStore::new(store)
        .list_versions(workspace_id)?
        .into_iter()
        .find(|version| version.version_id == version_id)
        .ok_or(DomainError::VersionNotFound)?;
    if previous.version_id == version_id {
        return Ok(target);
    }
    let mut secret_key = None;
    let mut projections = plan_plaintext_switch(
        store,
        workspace_id,
        version_id,
        &previous.version_id,
        &[],
        root_dir,
        now_ms,
        token,
    )?;
    projections.extend(plan_secret_switch(
        store,
        workspace_id,
        version_id,
        &previous.version_id,
        root_dir,
        now_ms,
        token,
        &mut secret_key,
    )?);
    if token.is_cancelled() {
        return Err(RuntimeError::Cancelled);
    }
    let outcome = store.write_with(faults, |tx| {
        tx.execute(
            "INSERT INTO active_versions (workspace_id, version_id) VALUES (?1, ?2) \
             ON CONFLICT(workspace_id) DO UPDATE SET version_id = excluded.version_id",
            params![workspace_id, version_id],
        )
        .map_err(StorageError::persist_public)?;
        for projection in &projections {
            if let Some(content) = projection.inline_content.as_deref() {
                let stored_sha = put_binary_blob(tx, content)?;
                if stored_sha != projection.spec.content_sha256 {
                    return Err(StorageError::corrupt_public(rusqlite::Error::InvalidQuery));
                }
            }
            upsert_projection_job(tx, &projection.spec, projection.operation)?;
        }
        Ok::<_, StorageError>(())
    })?;
    if matches!(outcome, TxnOutcome::Crashed { .. }) {
        return Err(RuntimeError::OperationCrashed);
    }
    drop(secret_key);
    let selected: HashSet<String> = projections
        .iter()
        .map(|projection| projection.spec.job_id.clone())
        .collect();
    let replay = replay_pending_materializations(
        store,
        root_dir,
        MaterializationReplayScope {
            workspace_id,
            self_writes: Some(self_writes),
            progress: None,
        },
        now_ms,
        faults,
        Some(&selected),
        false,
    )?;
    let failed_jobs = replay.failed + selected.len().saturating_sub(replay.selected_seen);
    if failed_jobs > 0 {
        return Err(RuntimeError::ActiveVersionMaterializationIncomplete { failed_jobs });
    }

    // Rollbacks against inactive versions intentionally leave their inverse
    // disk intents pending. Once that version becomes active, drain every
    // restore whose desired state now matches the active snapshots. Run this
    // after switch projections: a projection may already establish the same
    // bytes, in which case the restore completes idempotently instead of
    // conflicting with the projection's disk preimage.
    let mut rollback_restores = HashSet::new();
    for job in store.list_pending_materialization_jobs()? {
        if matches!(
            rollback_job_matches_active(store, workspace_id, &job)?,
            Some(true)
        ) {
            rollback_restores.insert(job.job_id);
        }
    }
    if !rollback_restores.is_empty() {
        let replay = replay_pending_materializations(
            store,
            root_dir,
            MaterializationReplayScope {
                workspace_id,
                self_writes: Some(self_writes),
                progress: None,
            },
            now_ms,
            faults,
            Some(&rollback_restores),
            true,
        )?;
        let failed_jobs =
            replay.failed + rollback_restores.len().saturating_sub(replay.selected_seen);
        if failed_jobs > 0 {
            return Err(RuntimeError::ActiveVersionMaterializationIncomplete { failed_jobs });
        }
    }
    Ok(target)
}

pub(super) fn ensure_mutation_version_on_store(
    store: &mut EngineStore,
    workspace_id: &str,
    version_id: &str,
    now_ms: i64,
    faults: &dyn FaultInjector,
) -> Result<(), RuntimeError> {
    let mut versions = VersionedTextStore::new(store);
    if versions.get_main_version(workspace_id)?.is_some() {
        return Ok(());
    }
    if version_id != "main" {
        return Err(DomainError::VersionNotFound.into());
    }
    versions.ensure_main_version(workspace_id, "main", now_ms, faults)?;
    Ok(())
}

impl ActorHandle {
    /// Materialize only paths owned by one native ordinary pull page.
    #[allow(clippy::too_many_arguments)]
    pub async fn materialize_relay_page(
        &self,
        workspace_id: String,
        root_dir: PathBuf,
        changes: Vec<dohc_engine_sync::MomentMaterializationChange>,
        self_writes: Arc<dyn SelfWriteRecorder>,
        now_ms: i64,
        token: CancellationToken,
    ) -> Result<(), RuntimeError> {
        self.run(move |store, _cache| {
            if token.is_cancelled() { return Err(RuntimeError::Cancelled); }
            if changes.is_empty() { return Ok(()); }
            let active = VersionedTextStore::new(store).get_active_version(&workspace_id)?.version_id;
            let policy = read_engine_search_policy(&root_dir);
            if policy.is_degraded() {
                return Err(DomainError::StateCorrupt { reason: "ordinary materialization policy unavailable" }.into());
            }
            let mut secret_key = None;
            // A change can depend on another in the same page: a file becomes a
            // directory (delete `notes`, write `notes/work.md`) or the reverse
            // (delete `d/a.md`, write `d`). Deletes under another changed path
            // run first, and the page runs in batches that each hold no two
            // paths where one is inside the other, so every probe sees the
            // effects of the batches before it. Each batch shares one synced
            // displacement commit.
            let mut changes = changes;
            changes.retain(|change| change.version_id == active);
            let case_replacements = relay_case_replacement_paths(&changes);
            let inside_another = |path: &str, all: &[dohc_engine_sync::MomentMaterializationChange]| {
                all.iter().any(|other| is_inside(&root_dir, path, &other.path))
            };
            let first: Vec<bool> = changes
                .iter()
                .map(|change| change.operation == "delete" && inside_another(&change.path, &changes))
                .collect();
            let mut keyed: Vec<(bool, dohc_engine_sync::MomentMaterializationChange)> =
                first.into_iter().zip(changes.drain(..)).collect();
            keyed.sort_by(|(a_first, a), (b_first, b)| {
                b_first.cmp(a_first).then_with(|| {
                    let depth = a.path.split('/').count().cmp(&b.path.split('/').count());
                    if *a_first { depth.reverse() } else { depth }
                }).then_with(|| a.path.cmp(&b.path))
            });
            let mut projections: Vec<SwitchProjection> = Vec::new();
            let mut deleted: Vec<String> = Vec::new();
            for (_, change) in keyed {
                if token.is_cancelled() { return Err(RuntimeError::Cancelled); }
                if projections.iter().any(|planned| {
                    is_inside(&root_dir, &planned.spec.target_path, &change.path)
                        || is_inside(&root_dir, &change.path, &planned.spec.target_path)
                }) {
                    run_relay_batch(store, &root_dir, &workspace_id, self_writes.as_ref(), &mut projections, &mut deleted, now_ms)?;
                }
                // A file replacing a directory whose tracked files this page
                // deleted: the empty directory gives way.
                if root_dir.join(&change.path).is_dir() {
                    for path in deleted.iter().filter(|path| is_inside(&root_dir, path, &change.path)) {
                        let mut parent = path.as_str();
                        while let Some((directory, _)) = parent.rsplit_once('/') {
                            remove_empty_directory_target(&root_dir, directory)?;
                            if directory.split('/').count() == change.path.split('/').count() { break; }
                            parent = directory;
                        }
                    }
                }
                let secret = change.content_kind == "secret";
                if !secret && !resolve_effective_policy(&change.path, policy.files_policy.as_deref(), policy.visibility_policy.as_deref()).tracked {
                    return Err(DomainError::InvalidPath { reason: "ordinary materialization path is not tracked" }.into());
                }
                if let Some((source, _)) = case_replacements.iter().find(|(_, destination)| *destination == &change.path) {
                    dohc_engine_files::materialize::restore_parent_spelling(&root_dir, source, &change.path)?;
                }
                let state = probe_projection_target(&root_dir, &change.path,
                    if secret { ProjectionTargetKind::Secret } else { ProjectionTargetKind::Plaintext });
                let preimage = projection_preimage(&state).ok_or(DomainError::InvalidPath {
                    reason: "ordinary materialization target is unsafe or unreadable",
                })?;
                let desired = if secret {
                    if secret_key.is_none() { secret_key = Some(load_projection_secret_key(&root_dir)?); }
                    let plaintext = SecretFileStore::new(store, secret_key.as_ref().expect("secret key loaded"))
                        .materialize_secret_file(&workspace_id, &active, &change.path)?;
                    if let Some(plaintext) = plaintext {
                        let equal = matches!(&state, ProjectionTargetState::Text {sha256} if sha256 == &hex_sha256(plaintext.as_bytes()));
                        drop(plaintext);
                        Some((secret_ciphertext_sha(store, &workspace_id, &active, &change.path)?, None, equal))
                    } else { None }
                } else if change.content_kind == "binary" {
                    VersionedTextStore::new(store).read_binary(&workspace_id, &active, &change.path)?
                        .map(|head| { let equal = projection_matches(&state, &head.sha256);
                            (head.sha256, None, equal) })
                } else if change.content_kind == "text" {
                    VersionedTextStore::new(store).read_text(&workspace_id, &active, &change.path)?
                        .map(|head| { let equal = projection_matches(&state, &head.blob_sha256);
                            (head.blob_sha256, Some(head.text.into_bytes()), equal) })
                } else { return Err(DomainError::StateCorrupt { reason: "ordinary materialization kind is invalid" }.into()); };
                let (operation, sha, inline) = match (change.operation, desired) {
                    ("write" | "delete", Some((_, _, true))) if target_has_requested_name(&root_dir, &root_dir.join(&change.path)) => continue,
                    ("write" | "delete", Some((sha, inline, _))) => (MaterializationOperation::Write, sha, inline),
                    ("write" | "delete", None) if matches!(state, ProjectionTargetState::Absent) => {
                        deleted.push(change.path);
                        continue;
                    }
                    ("delete", None) if case_replacements.get(&change.path).is_some_and(|destination| {
                        // Collision keys can also group distinct files.
                        dohc_engine_files::materialize::same_existing_entry(&root_dir.join(&change.path), &root_dir.join(destination))
                    }) => continue,
                    ("write" | "delete", None) => (MaterializationOperation::Delete, hex_sha256(&[]), Some(Vec::new())),
                    _ => return Err(DomainError::StateCorrupt { reason: "ordinary materialization operation is invalid" }.into()),
                };
                projections.push(planned_projection(&workspace_id, &active, change.path, operation, sha,
                    preimage, now_ms, now_ms, secret, inline));
            }
            if token.is_cancelled() { return Err(RuntimeError::Cancelled); }
            run_relay_batch(store, &root_dir, &workspace_id, self_writes.as_ref(), &mut projections, &mut deleted, now_ms)?;
            if token.is_cancelled() { return Err(RuntimeError::Cancelled); }
            Ok(())
        }).await
    }
}

#[cfg(test)]
mod tests {
    use super::{is_inside, relay_case_replacement_paths, same_projection_file};
    use dohc_engine_sync::MomentMaterializationChange;

    #[test]
    fn replacement_identity_distinguishes_aliases_from_equal_bytes() {
        let scratch = dohc_engine_testkit::ScratchDir::new().unwrap();
        let root = scratch.path();
        std::fs::write(root.join("original"), "same").unwrap();
        std::fs::hard_link(root.join("original"), root.join("alias")).unwrap();
        std::fs::write(root.join("distinct"), "same").unwrap();
        assert!(same_projection_file(root, "original", "alias"));
        assert!(!same_projection_file(root, "original", "distinct"));
        assert!(!same_projection_file(root, "missing", "missing"));
    }

    #[test]
    fn containment_respects_component_boundaries_and_filesystem_aliases() {
        let scratch = dohc_engine_testkit::ScratchDir::new().unwrap();
        let root = scratch.path();
        std::fs::create_dir(root.join("D")).unwrap();
        assert!(is_inside(root, "D/sub/a.md", "D"));
        assert!(!is_inside(root, "Dog/a.md", "D"));
        assert!(!is_inside(root, "D", "D"));
        assert_eq!(
            is_inside(root, "D/a.md", "d"),
            same_projection_file(root, "D", "d")
        );
        std::fs::create_dir(root.join("\u{1e9e}")).unwrap();
        std::fs::create_dir(root.join("ss")).unwrap();
        assert!(!is_inside(root, "\u{1e9e}/a.md", "ss"));
    }

    #[test]
    fn case_replacement_planning_uses_collision_keys_and_keeps_other_deletes() {
        let change = |version: &str, path: &str, operation| MomentMaterializationChange {
            version_id: version.into(),
            path: path.into(),
            operation,
            content_kind: "text",
        };
        let changes = vec![
            change("main", "dir/File.md", "delete"),
            change("main", "dir/FILE.md", "write"),
            change("main", "\u{1e9e}.md", "delete"),
            change("main", "ss.md", "write"),
            change("main", "same.md", "delete"),
            change("main", "same.md", "write"),
            change("main", "other.md", "delete"),
            change("main", "version.md", "delete"),
            change("inactive", "VERSION.md", "write"),
        ];
        assert_eq!(
            relay_case_replacement_paths(&changes),
            [
                ("dir/File.md".into(), "dir/FILE.md".into()),
                ("\u{1e9e}.md".into(), "ss.md".into()),
            ]
            .into()
        );
    }
}
