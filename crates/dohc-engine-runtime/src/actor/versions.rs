use super::ActorHandle;
use super::journal::journal_version_create_outbound_in_tx;
use super::materialization::{
    MaterializationReplayScope, SelfWriteRecorder, load_projection_secret_key,
    replay_pending_materializations, rollback_job_matches_active, secret_ciphertext_sha,
};
use crate::error::RuntimeError;
use crate::search::{read_engine_search_policy, resolve_effective_policy};
use dohc_engine_crypto::SecretDataKey;
use dohc_engine_domain::{
    CreateNamedVersion, DomainError, ListMomentsQuery, MomentPage, MomentRecord, SecretFileStore,
    SecretMomentRecord, SnapshotContent, SnapshotMetadata, VersionFileChangePage, VersionRecord,
    VersionedTextStore, list_secret_files_keyless, list_secret_moments_in_time_window_keyless,
};
use dohc_engine_files::{ProjectionTargetKind, ProjectionTargetState, probe_projection_target};
use dohc_engine_storage::{
    EngineStore, FaultInjector, MaterializationJobSpec, MaterializationOperation, Preimage,
    StorageError, TxnOutcome, hex_sha256, put_binary_blob, upsert_projection_job,
};
use rusqlite::params;
use std::collections::HashSet;
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

fn projection_matches(
    state: &ProjectionTargetState,
    content: &SnapshotContent,
    desired_sha256: &str,
) -> bool {
    matches!(
        (state, content),
        (
            ProjectionTargetState::Text { sha256 },
            SnapshotContent::Text { .. }
        ) if sha256 == desired_sha256
    ) || matches!(
        (state, content),
        (
            ProjectionTargetState::Binary { sha256 },
            SnapshotContent::Binary { .. }
        ) if sha256 == desired_sha256
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
            if projection_matches(&state, &snapshot.content, &desired_sha256) {
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
