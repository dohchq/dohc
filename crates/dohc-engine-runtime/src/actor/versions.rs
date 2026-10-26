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
    CreateNamedVersion, DomainError, HistoryCursor, ListMomentsQuery, MomentPage, MomentRecord,
    SecretFileStore, SnapshotContent, SnapshotMetadata, VersionFileChangePage, VersionRecord,
    VersionedTextStore, list_secret_files_keyless,
};
use dohc_engine_files::floor::path_collision_key;
use dohc_engine_files::{
    PlacementHolds, ProjectionProbe, ProjectionTargetKind, ProjectionTargetState, disk_spelling,
    may_share_entry, remove_empty_directory_target,
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

pub use dohc_engine_domain::HistoryPageRead;

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
        version_id: Option<String>,
        object_id: Option<String>,
        operation_id: Option<String>,
        limit: usize,
        cursor: Option<HistoryCursor>,
    ) -> Result<HistoryPageRead, RuntimeError> {
        self.run(move |store, _| {
            VersionedTextStore::new(store)
                .history_page(
                    &workspace_id,
                    version_id.as_deref(),
                    object_id.as_deref(),
                    operation_id.as_deref(),
                    limit,
                    cursor,
                )
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

/// `path`'s segments as a disk that ignores case or normalization names them.
fn path_key(path: &str) -> Vec<String> {
    path.split('/')
        .map(dohc_engine_sync::collision_key)
        .collect()
}

/// Whether the path keyed `path` lies strictly inside the folder keyed
/// `ancestor` ([`path_key`]).
fn is_inside(path: &[String], ancestor: &[String]) -> bool {
    path.len() > ancestor.len() && path.starts_with(ancestor)
}

/// Whether a delete at the path keyed `path` must run before one of the
/// page's writes, keyed `writes`: it lies inside that write's folder.
fn relay_delete_precedes_write(path: &[String], writes: &[Vec<String>]) -> bool {
    writes.iter().any(|write| is_inside(path, write))
}

/// Whether a real folder, not a link to one, stands at `path`.
fn is_folder(root_dir: &std::path::Path, path: &str) -> bool {
    std::fs::symlink_metadata(root_dir.join(path)).is_ok_and(|metadata| metadata.is_dir())
}

/// Remove each folder above `path` that is empty, nearest first, through
/// `top` in any case, or to the root when `top` is `None`. Walks past a
/// folder already gone, which an interrupted pass removed, and stops at the
/// first that stays: one with content, or one that cannot go, which a later
/// write there reports.
fn remove_emptied_folders(
    store: &EngineStore,
    root_dir: &std::path::Path,
    path: &str,
    top: Option<&str>,
) {
    let top = top.map(path_key);
    let mut parent = path;
    while let Some((folder, _)) = parent.rsplit_once('/') {
        if !matches!(
            remove_empty_directory_target(store, root_dir, folder),
            Ok(true)
        ) && std::fs::symlink_metadata(root_dir.join(folder)).is_ok()
        {
            break;
        }
        if top.as_deref() == Some(path_key(folder).as_slice()) {
            break;
        }
        parent = folder;
    }
}

/// Enqueue one batch of a sync page in one transaction and materialize it in
/// one replay. Clears `projections` and adds the batch's deletes to
/// `deleted`.
#[allow(
    clippy::too_many_arguments,
    reason = "relay pages reuse one hold snapshot across dependent batches"
)]
fn run_relay_batch(
    store: &mut EngineStore,
    root_dir: &std::path::Path,
    workspace_id: &str,
    self_writes: &dyn SelfWriteRecorder,
    holds: &PlacementHolds,
    projections: &mut Vec<SwitchProjection>,
    deleted: &mut Vec<String>,
    now_ms: i64,
) -> Result<(), RuntimeError> {
    if projections.is_empty() {
        return Ok(());
    }
    let batch = std::mem::take(projections);
    let targets: HashSet<String> = if holds.is_empty() {
        HashSet::new()
    } else {
        batch
            .iter()
            .map(|projection| path_collision_key(&projection.spec.target_path))
            .collect()
    };
    let outcome = store.write_with(&dohc_engine_storage::NoFaults, |tx| {
        complete_held_switch_jobs(tx, workspace_id, holds, now_ms, |_, path| {
            targets.contains(&path_collision_key(path))
        })?;
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
    let mut selected = HashSet::new();
    for projection in batch {
        if projection.operation == MaterializationOperation::Delete {
            deleted.push(projection.spec.target_path);
        }
        selected.insert(projection.spec.job_id);
    }
    #[cfg(test)]
    let faults = tests::RELAY_FAULTS.with(|faults| faults.borrow().clone());
    #[cfg(test)]
    let faults = faults.as_deref().unwrap_or(&dohc_engine_storage::NoFaults);
    #[cfg(not(test))]
    let faults = &dohc_engine_storage::NoFaults;
    let replay = replay_pending_materializations(
        store,
        root_dir,
        MaterializationReplayScope {
            holds: Some(holds),
            workspace_id,
            self_writes: Some(self_writes),
            progress: None,
            file_outcomes_settled: false,
            released_hold_paths: None,
            planned_against_active_heads: true,
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

fn complete_held_switch_jobs(
    tx: &rusqlite::Transaction<'_>,
    workspace: &str,
    holds: &PlacementHolds,
    now_ms: i64,
    selected: impl Fn(&str, &str) -> bool,
) -> Result<(), StorageError> {
    if holds.is_empty() {
        return Ok(());
    }
    let jobs = dohc_engine_storage::pending_switch_jobs_in(tx, workspace)?;
    for (id, path) in jobs {
        if holds.blocks(&path) && selected(&id, &path) {
            tx.execute("UPDATE materialization_jobs SET status='complete',completed_at_ms=?2 WHERE job_id=?1",params![id,now_ms]).map_err(StorageError::persist_public)?;
        }
    }
    Ok(())
}

fn projection_target_contains<'a>(
    root: &std::path::Path,
    path: &str,
    targets: &HashSet<&'a str>,
    case_paths: &mut Option<HashMap<String, Vec<&'a str>>>,
) -> bool {
    projection_target_alias(root, path, targets, case_paths).is_some()
}

pub(super) fn projection_target_alias<'a>(
    root: &std::path::Path,
    path: &str,
    targets: &HashSet<&'a str>,
    case_paths: &mut Option<HashMap<String, Vec<&'a str>>>,
) -> Option<&'a str> {
    if let Some(target) = targets.get(path) {
        return Some(*target);
    }
    let aliases = case_paths.get_or_insert_with(|| {
        let mut aliases: HashMap<String, Vec<&str>> = HashMap::new();
        for target in targets {
            aliases
                .entry(path_collision_key(target))
                .or_default()
                .push(target);
        }
        aliases
    });
    let candidates = aliases.get(&path_collision_key(path))?;
    candidates
        .iter()
        .copied()
        .find(|target| may_share_entry(root, path, target))
}

/// The heads of one version, with their content kinds, grouped by how a disk
/// that ignores case or normalization names their paths.
struct AliasHeads(HashMap<String, Vec<(String, &'static str)>>);

impl AliasHeads {
    fn load(
        store: &EngineStore,
        workspace_id: &str,
        version_id: &str,
    ) -> Result<Self, RuntimeError> {
        let heads: Vec<(String, String)> = store.read_with(|connection| {
            let mut statement = connection
                .prepare(
                    "SELECT a.path, COALESCE(s.content_kind, 'text') FROM path_aliases a \
                     JOIN snapshots s ON s.workspace_id = a.workspace_id \
                     AND s.version_id = a.version_id AND s.object_id = a.object_id \
                     WHERE a.workspace_id = ?1 AND a.version_id = ?2 \
                     UNION SELECT path, 'secret' FROM secret_files \
                     WHERE workspace_id = ?1 AND version_id = ?2",
                )
                .map_err(StorageError::corrupt_public)?;
            let rows = statement
                .query_map(params![workspace_id, version_id], |row| {
                    Ok((row.get(0)?, row.get(1)?))
                })
                .map_err(StorageError::corrupt_public)?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(StorageError::corrupt_public)
        })?;
        let mut grouped: HashMap<String, Vec<(String, &'static str)>> = HashMap::new();
        for (path, kind) in heads {
            let kind = match kind.as_str() {
                "secret" => "secret",
                "binary" => "binary",
                _ => "text",
            };
            grouped
                .entry(path_collision_key(&path))
                .or_default()
                .push((path, kind));
        }
        Ok(Self(grouped))
    }

    /// The heads, with their content kinds and in path order, at other
    /// spellings of `path` that reach the file `path` reaches, as they do on a
    /// disk that ignores case. They own the file, so a delete at `path` must
    /// leave it to them (#2157).
    fn owners(&self, root: &std::path::Path, path: &str) -> Vec<(String, &'static str)> {
        let Some(candidates) = self.0.get(&path_collision_key(path)) else {
            return Vec::new();
        };
        let mut owners: Vec<_> = candidates
            .iter()
            .filter(|(head, _)| head != path && may_share_entry(root, path, head))
            .cloned()
            .collect();
        owners.sort();
        owners
    }
}

/// Whether the disk might reach `path`'s file through another spelling. A
/// path with other than ASCII characters can differ in Unicode case or
/// normalization, which this can't test, so it counts. An ASCII segment has two
/// other spellings: its letters in the other case reach the file in a folder
/// that ignores case, and its `;`, `` ` `` and `K` written as the only other
/// characters Unicode normalizes to them reach it in a folder that ignores
/// normalization. A disk that keeps every spelling apart needs no owner lookup.
fn reaches_other_spelling(root: &std::path::Path, path: &str) -> bool {
    if !path.is_ascii() {
        return true;
    }
    let segments: Vec<&str> = path.split('/').collect();
    (0..segments.len()).any(|index| {
        let swapped: String = segments[index]
            .chars()
            .map(|c| {
                if c.is_ascii_lowercase() {
                    c.to_ascii_uppercase()
                } else {
                    c.to_ascii_lowercase()
                }
            })
            .collect();
        let composed = dohc_engine_files::floor::look_alike_spelling(segments[index]);
        [swapped, composed].iter().any(|spelling| {
            if spelling == segments[index] {
                return false;
            }
            let mut probe = segments.clone();
            probe[index] = spelling;
            root.join(probe.join("/")).exists()
        })
    })
}

/// Whether the disk stores the file `path` reaches under another spelling of
/// its last segment. Not when the disk can't say, so an owner keeps the file.
fn stored_spelling_differs(root: &std::path::Path, path: &str) -> bool {
    let leaf = path.rsplit('/').next().unwrap_or(path);
    disk_spelling(root, path)
        .ok()
        .flatten()
        .is_some_and(|file| file.rsplit('/').next() != Some(leaf))
}

/// Whether the disk stores the file `path` reaches under exactly that path,
/// folders included. It may when the disk can't say.
fn stored_as(root: &std::path::Path, path: &str) -> bool {
    match disk_spelling(root, path) {
        Ok(stored) => stored.is_some_and(|stored| stored == path),
        Err(_) => true,
    }
}

fn case_alias_targets<'a>(
    previous: impl Iterator<Item = &'a str>,
    target: &HashSet<&str>,
) -> HashSet<String> {
    if !cfg!(windows) {
        return HashSet::new();
    }
    let mut aliases: HashMap<String, Vec<&str>> = HashMap::new();
    for path in previous {
        aliases
            .entry(path_collision_key(path))
            .or_default()
            .push(path);
    }
    target
        .iter()
        .filter(|path| {
            aliases
                .get(&path_collision_key(path))
                .is_some_and(|previous| previous.iter().any(|previous| previous != *path))
        })
        .map(|path| (*path).to_owned())
        .collect()
}

fn spelling_differs(
    probe: Option<&ProjectionProbe>,
    aliases: &HashSet<String>,
    path: &str,
) -> bool {
    aliases.contains(path) && probe.is_some_and(|probe| probe.stored_under_other_spelling(path))
}

fn probe_target(
    probe: Option<&ProjectionProbe>,
    path: &str,
    kind: ProjectionTargetKind,
) -> ProjectionTargetState {
    probe.map_or(ProjectionTargetState::UntrackedContent, |probe| {
        probe.probe(path, kind)
    })
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
    probe: Option<&ProjectionProbe>,
    now_ms: i64,
    token: &CancellationToken,
    holds: &PlacementHolds,
) -> Result<Vec<SwitchProjection>, RuntimeError> {
    let target = VersionedTextStore::new(store)
        .list_snapshots(workspace_id, target_version_id)
        .map_err(RuntimeError::from)?;
    let target_paths: HashSet<&str> = target
        .iter()
        .map(|snapshot| snapshot.path.as_str())
        .collect();
    let mut target_case_paths = None;
    let target_holds: HashSet<&str> = target_paths
        .iter()
        .filter_map(|path| holds.get(path).map(|(path, _)| path))
        .collect();
    let policy = read_engine_search_policy(root_dir);
    if policy.is_degraded() {
        return Err(DomainError::StateCorrupt {
            reason: "workspace file policy is unavailable during version switch",
        }
        .into());
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
    for (path, _) in holds.entries() {
        if !previous_paths.iter().any(|(previous, _)| previous == path) {
            previous_paths.push((path.to_owned(), now_ms));
        }
    }
    let spelling_aliases = case_alias_targets(
        previous_paths.iter().map(|(path, _)| path.as_str()),
        &target_paths,
    );
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
            let held = holds.get(&snapshot.path);
            if held.is_some_and(|(_, hold)| hold.source_version_id == target_version_id) {
                continue;
            }
            let state = if held.is_some() {
                ProjectionTargetState::UntrackedContent
            } else {
                probe_target(probe, &snapshot.path, ProjectionTargetKind::Plaintext)
            };
            let Some(preimage) = held
                .map(|(_, hold)| hold.preimage.clone())
                .or_else(|| projection_preimage(&state))
            else {
                continue;
            };
            let (desired_sha256, inline_content) = match &snapshot.content {
                SnapshotContent::Text { text } => {
                    (hex_sha256(text.as_bytes()), Some(text.as_bytes().to_vec()))
                }
                SnapshotContent::Binary { sha256 } => (sha256.clone(), None),
            };
            if projection_matches(&state, &desired_sha256)
                && !spelling_differs(probe, &spelling_aliases, &snapshot.path)
            {
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
    if !policy.is_degraded() {
        let empty_sha = hex_sha256(&[]);
        for (path, target_generation) in previous_paths {
            if token.is_cancelled() {
                return Err(RuntimeError::Cancelled);
            }
            if holds
                .get(&path)
                .is_some_and(|(path, _)| target_holds.contains(path))
                || projection_target_contains(
                    root_dir,
                    &path,
                    &target_paths,
                    &mut target_case_paths,
                )
                || !resolve_effective_policy(
                    &path,
                    policy.files_policy.as_deref(),
                    policy.visibility_policy.as_deref(),
                )
                .tracked
            {
                continue;
            }
            let held = holds.get(&path);
            if held.is_some_and(|(_, hold)| hold.source_version_id == target_version_id) {
                continue;
            }
            let state = if held.is_some() {
                ProjectionTargetState::UntrackedContent
            } else {
                probe_target(probe, &path, ProjectionTargetKind::Plaintext)
            };
            let Some(preimage) = held
                .map(|(_, hold)| hold.preimage.clone())
                .or_else(|| projection_preimage(&state))
            else {
                continue;
            };
            if held.is_none() && matches!(preimage, Preimage::Absent) {
                continue;
            }
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

fn load_projection_secret_key(store: &EngineStore) -> Result<SecretDataKey, RuntimeError> {
    load_key_file(super::store_folder(store.database_path()))
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
    probe: Option<&ProjectionProbe>,
    now_ms: i64,
    token: &CancellationToken,
    secret_key: &mut Option<SecretDataKey>,
    holds: &PlacementHolds,
) -> Result<Vec<SwitchProjection>, RuntimeError> {
    let target = list_secret_files_keyless(store, workspace_id, target_version_id)?;
    let target_paths: HashSet<&str> = target.iter().map(|stat| stat.path.as_str()).collect();
    let mut target_case_paths = None;
    let target_holds: HashSet<&str> = target_paths
        .iter()
        .filter_map(|path| holds.get(path).map(|(path, _)| path))
        .collect();
    let previous = list_secret_files_keyless(store, workspace_id, previous_version_id)?;
    let spelling_aliases = case_alias_targets(
        previous.iter().map(|stat| stat.path.as_str()),
        &target_paths,
    );
    let mut projections = Vec::new();
    for stat in &target {
        if token.is_cancelled() {
            return Err(RuntimeError::Cancelled);
        }
        let held = holds.get(&stat.path);
        if held.is_some_and(|(_, hold)| hold.source_version_id == target_version_id) {
            continue;
        }
        let state = if held.is_some() {
            ProjectionTargetState::UntrackedContent
        } else {
            probe_target(probe, &stat.path, ProjectionTargetKind::Secret)
        };
        let Some(preimage) = held
            .map(|(_, hold)| hold.preimage.clone())
            .or_else(|| projection_preimage(&state))
        else {
            continue;
        };
        if secret_key.is_none() {
            *secret_key = Some(load_projection_secret_key(store)?);
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
        if already_equal && !spelling_differs(probe, &spelling_aliases, &stat.path) {
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
    let empty_sha = hex_sha256(&[]);
    for stat in previous {
        if token.is_cancelled() {
            return Err(RuntimeError::Cancelled);
        }
        if holds
            .get(&stat.path)
            .is_some_and(|(path, _)| target_holds.contains(path))
            || projection_target_contains(
                root_dir,
                &stat.path,
                &target_paths,
                &mut target_case_paths,
            )
        {
            continue;
        }
        let held = holds.get(&stat.path);
        if held.is_some_and(|(_, hold)| hold.source_version_id == target_version_id) {
            continue;
        }
        let state = if held.is_some() {
            ProjectionTargetState::UntrackedContent
        } else {
            probe_target(probe, &stat.path, ProjectionTargetKind::Secret)
        };
        let Some(preimage) = held
            .map(|(_, hold)| hold.preimage.clone())
            .or_else(|| projection_preimage(&state))
        else {
            continue;
        };
        if held.is_none() && matches!(preimage, Preimage::Absent) {
            continue;
        }
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
    let holds = PlacementHolds::load(store, workspace_id)?;
    let probe = ProjectionProbe::new(root_dir).ok();
    let mut projections = plan_plaintext_switch(
        store,
        workspace_id,
        active_version_id,
        inactive_version_id,
        rollback_paths,
        root_dir,
        probe.as_ref(),
        now_ms,
        token,
        &holds,
    )?;
    if projections.is_empty() && holds.is_empty() {
        return Ok(());
    }
    for projection in &mut projections {
        if rollback_paths.iter().any(|(path, _)| {
            path_collision_key(path) == path_collision_key(&projection.spec.target_path)
        }) && let Some(job) = store.load_materialization_job(&projection.spec.job_id)?
            && job.status == dohc_engine_storage::JobStatus::Pending
        {
            projection.spec.preimage = job.preimage;
        }
    }

    let outcome = store.write_with(faults, |tx| {
        complete_held_switch_jobs(tx, workspace_id, &holds, now_ms, |id, _| {
            id.starts_with("version-switch-mat_")
        })?;
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
            holds: Some(&holds),
            workspace_id,
            self_writes: Some(self_writes),
            progress: None,
            file_outcomes_settled: false,
            released_hold_paths: None,
            planned_against_active_heads: true,
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
pub(super) fn switch_active_version_on_store(
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
    store.read_with(|conn| dohc_engine_domain::ensure_no_pending_undo_in(conn, workspace_id))?;
    let previous = VersionedTextStore::new(store).get_active_version(workspace_id)?;
    let target = VersionedTextStore::new(store)
        .list_versions(workspace_id)?
        .into_iter()
        .find(|version| version.version_id == version_id)
        .ok_or(DomainError::VersionNotFound)?;
    if previous.version_id == version_id {
        return Ok(target);
    }
    let holds = PlacementHolds::load(store, workspace_id)?;
    let mut secret_key = None;
    let probe = ProjectionProbe::new(root_dir).ok();
    let mut projections = plan_plaintext_switch(
        store,
        workspace_id,
        version_id,
        &previous.version_id,
        &[],
        root_dir,
        probe.as_ref(),
        now_ms,
        token,
        &holds,
    )?;
    projections.extend(plan_secret_switch(
        store,
        workspace_id,
        version_id,
        &previous.version_id,
        root_dir,
        probe.as_ref(),
        now_ms,
        token,
        &mut secret_key,
        &holds,
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
        complete_held_switch_jobs(tx, workspace_id, &holds, now_ms, |_, _| true)?;
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
            holds: Some(&holds),
            workspace_id,
            self_writes: Some(self_writes),
            progress: None,
            file_outcomes_settled: false,
            released_hold_paths: None,
            planned_against_active_heads: true,
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
                holds: Some(&holds),
                workspace_id,
                self_writes: Some(self_writes),
                progress: None,
                file_outcomes_settled: false,
                released_hold_paths: None,
                planned_against_active_heads: false,
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
            materialize_relay_page_on_store(
                store,
                &workspace_id,
                &root_dir,
                changes,
                self_writes.as_ref(),
                now_ms,
                &token,
            )
        })
        .await
    }
}

/// [`ActorHandle::materialize_relay_page`] on the writer's store.
pub(super) fn materialize_relay_page_on_store(
    store: &mut EngineStore,
    workspace_id: &str,
    root_dir: &std::path::Path,
    changes: Vec<dohc_engine_sync::MomentMaterializationChange>,
    self_writes: &dyn SelfWriteRecorder,
    now_ms: i64,
    token: &CancellationToken,
) -> Result<(), RuntimeError> {
    if store.is_passive() {
        return Ok(());
    }
    if token.is_cancelled() {
        return Err(RuntimeError::Cancelled);
    }
    if changes.is_empty() {
        return Ok(());
    }
    let active = VersionedTextStore::new(store)
        .get_active_version(workspace_id)?
        .version_id;
    let policy = read_engine_search_policy(root_dir);
    if policy.is_degraded() {
        return Err(DomainError::StateCorrupt {
            reason: "ordinary materialization policy unavailable",
        }
        .into());
    }
    let holds = PlacementHolds::load(store, workspace_id)?;
    let mut secret_key = None;
    // A change brings its path to the head there, whatever the page called
    // it: it writes where a head is and deletes where none is. A change can
    // depend on another in the same page: a file becomes a directory (delete
    // `notes`, write `notes/work.md`) or the reverse (delete `d/a.md`, write
    // `d`). Deletes inside a path being written run first, and the page runs
    // in batches that each hold no two paths that alias or where one is
    // inside the other. Among aliases, deletes run before writes, so on a
    // disk that ignores case a delete never removes the file an alias wrote.
    // Every probe sees earlier batches. A folder the page's deletes left
    // empty gives way to a file the page writes at its name. A hosted replica
    // keeps no folders of its own, so there every folder they leave empty
    // goes.
    let hosted = dohc_engine_sync::is_hosted_replica(store, workspace_id)?;
    let mut page = Vec::new();
    for change in changes {
        // An older build's change at a path the floor now ignores (an old
        // `.DS_Store`) has no file here.
        if change.version_id != active || dohc_engine_files::floor::names_os_metadata(&change.path)
        {
            continue;
        }
        if !matches!(change.operation, "write" | "delete") {
            return Err(DomainError::StateCorrupt {
                reason: "ordinary materialization operation is invalid",
            }
            .into());
        }
        let tracked = change.content_kind == "secret"
            || resolve_effective_policy(
                &change.path,
                policy.files_policy.as_deref(),
                policy.visibility_policy.as_deref(),
            )
            .tracked;
        if !tracked {
            return Err(DomainError::InvalidPath {
                reason: "ordinary materialization path is not tracked",
            }
            .into());
        }
        // Each head's body loads only when its change runs.
        let has_head = relay_has_head(store, workspace_id, &active, &change)?;
        page.push((path_key(&change.path), change, has_head));
    }
    let probe = ProjectionProbe::new(root_dir).ok();
    let target_paths: HashSet<&str> = page
        .iter()
        .filter(|(_, _, head)| *head)
        .map(|(_, change, _)| change.path.as_str())
        .collect();
    let spelling_aliases = case_alias_targets(
        page.iter().map(|(_, change, _)| change.path.as_str()),
        &target_paths,
    );
    let writes: Vec<Vec<String>> = page
        .iter()
        .filter(|(_, _, has_head)| *has_head)
        .map(|(key, _, _)| key.clone())
        .collect();
    let mut alias_order = HashMap::new();
    for (key, change, has_head) in &page {
        let first = !has_head && relay_delete_precedes_write(key, &writes);
        let depth = key.len();
        let order = alias_order
            .entry(key.clone())
            .or_insert_with(|| (first, depth, change.path.clone()));
        // Every alias inherits the group's strongest dependency.
        order.0 |= first;
        order.1 = order.1.max(depth);
    }
    // The stable sort keeps page order among a group's deletes and writes.
    page.sort_by(|(a, _, a_head), (b, _, b_head)| {
        let (a, b) = (&alias_order[a], &alias_order[b]);
        b.0.cmp(&a.0)
            .then_with(|| if a.0 { b.1.cmp(&a.1) } else { a.1.cmp(&b.1) })
            .then_with(|| a.2.cmp(&b.2))
            .then_with(|| a_head.cmp(b_head))
    });
    let mut projections: Vec<SwitchProjection> = Vec::new();
    let mut batch_aliases = HashSet::new();
    let mut deleted: Vec<String> = Vec::new();
    // Loaded only for a page that deletes a file the disk still has.
    let mut alias_heads: Option<AliasHeads> = None;
    // Cancellation stops the page only until its first change lands; after
    // that the page runs to its end.
    let mut changed = false;
    for (key, change, _) in page {
        if !changed && token.is_cancelled() {
            return Err(RuntimeError::Cancelled);
        }
        if batch_aliases
            .iter()
            .any(|planned: &Vec<String>| planned.starts_with(&key) || key.starts_with(planned))
        {
            changed |= !projections.is_empty();
            run_relay_batch(
                store,
                root_dir,
                workspace_id,
                self_writes,
                &holds,
                &mut projections,
                &mut deleted,
                now_ms,
            )?;
            batch_aliases.clear();
        }
        if is_folder(root_dir, &change.path) {
            for path in deleted
                .iter()
                .filter(|path| is_inside(&path_key(path), &key))
            {
                changed = true;
                remove_emptied_folders(store, root_dir, path, Some(&change.path));
            }
        }
        let secret = change.content_kind == "secret";
        let held = holds.get(&change.path);
        let state = if held.is_some() {
            ProjectionTargetState::UntrackedContent
        } else {
            probe_target(
                probe.as_ref(),
                &change.path,
                if secret {
                    ProjectionTargetKind::Secret
                } else {
                    ProjectionTargetKind::Plaintext
                },
            )
        };
        let head = relay_head(store, workspace_id, &active, &change, &mut secret_key)?;
        // A path with no head needs no file there, and a folder is none.
        if head.is_none() && is_folder(root_dir, &change.path) {
            continue;
        }
        // On a disk that ignores case or normalization, a head at another
        // spelling can own the file this delete reaches (#2157). The file then
        // goes to that head: it stays, or gets the head's bytes and spelling.
        // A page that also writes that spelling, as a case-only rename does,
        // or a path inside or around it, runs its deletes and writes in order
        // instead.
        if head.is_none()
            && held.is_none()
            && !matches!(state, ProjectionTargetState::Absent)
            && !writes
                .iter()
                .any(|write| write.starts_with(&key) || key.starts_with(write))
            && reaches_other_spelling(root_dir, &change.path)
        {
            if alias_heads.is_none() {
                alias_heads = Some(AliasHeads::load(store, workspace_id, &active)?);
            }
            let owners = alias_heads
                .as_ref()
                .map(|heads| heads.owners(root_dir, &change.path))
                .unwrap_or_default();
            if !owners.is_empty() {
                // An owner the file already holds, spelled as it is, keeps it.
                // Otherwise the file takes the first owner it holds the bytes
                // of, or the first owner in path order that can read it. A file
                // stored as an owner the files policy no longer tracks is that
                // owner's to keep, and such an owner gets no other file. With
                // no owner left, the delete runs as it would without one.
                let mut kept = false;
                let mut held_bytes = None;
                let mut first = None;
                for (path, kind) in owners {
                    let secret = kind == "secret";
                    if !secret
                        && !resolve_effective_policy(
                            &path,
                            policy.files_policy.as_deref(),
                            policy.visibility_policy.as_deref(),
                        )
                        .tracked
                    {
                        if stored_as(root_dir, &path) {
                            kept = true;
                            break;
                        }
                        continue;
                    }
                    let owner = dohc_engine_sync::MomentMaterializationChange {
                        version_id: change.version_id.clone(),
                        path,
                        operation: "write",
                        content_kind: kind,
                    };
                    let Some(owner_head) =
                        relay_head(store, workspace_id, &active, &owner, &mut secret_key)?
                    else {
                        continue;
                    };
                    // The file reads as the owner's kind reads it.
                    let owner_state = if secret == (change.content_kind == "secret") {
                        state.clone()
                    } else {
                        probe_target(
                            probe.as_ref(),
                            &change.path,
                            if secret {
                                ProjectionTargetKind::Secret
                            } else {
                                ProjectionTargetKind::Plaintext
                            },
                        )
                    };
                    if owner_head.current(&owner_state, secret) {
                        if !stored_spelling_differs(root_dir, &owner.path) {
                            kept = true;
                            break;
                        }
                        if held_bytes.is_none() {
                            held_bytes = Some((owner, owner_head, secret, owner_state));
                        }
                    } else if first.is_none() && projection_preimage(&owner_state).is_some() {
                        first = Some((owner, owner_head, secret, owner_state));
                    }
                }
                if kept {
                    continue;
                }
                if let Some((owner, owner_head, secret, owner_state)) = held_bytes.or(first) {
                    let preimage =
                        projection_preimage(&owner_state).ok_or(DomainError::InvalidPath {
                            reason: "ordinary materialization target is unsafe or unreadable",
                        })?;
                    batch_aliases.insert(key);
                    projections.push(planned_projection(
                        workspace_id,
                        &active,
                        owner.path,
                        MaterializationOperation::Write,
                        owner_head.sha,
                        preimage,
                        now_ms,
                        now_ms,
                        secret,
                        owner_head.inline,
                    ));
                    continue;
                }
            }
        }
        let preimage = held
            .map(|(_, hold)| hold.preimage.clone())
            .or_else(|| projection_preimage(&state))
            .ok_or(DomainError::InvalidPath {
                reason: "ordinary materialization target is unsafe or unreadable",
            })?;
        let (operation, sha, inline) = match head {
            Some(head)
                if head.current(&state, secret)
                    && !spelling_differs(probe.as_ref(), &spelling_aliases, &change.path) =>
            {
                continue;
            }
            Some(head) => (MaterializationOperation::Write, head.sha, head.inline),
            None if matches!(state, ProjectionTargetState::Absent) => {
                deleted.push(change.path);
                continue;
            }
            None => (
                MaterializationOperation::Delete,
                hex_sha256(&[]),
                Some(Vec::new()),
            ),
        };
        batch_aliases.insert(key);
        projections.push(planned_projection(
            workspace_id,
            &active,
            change.path,
            operation,
            sha,
            preimage,
            now_ms,
            now_ms,
            secret,
            inline,
        ));
    }
    if !changed && token.is_cancelled() {
        return Err(RuntimeError::Cancelled);
    }
    run_relay_batch(
        store,
        root_dir,
        workspace_id,
        self_writes,
        &holds,
        &mut projections,
        &mut deleted,
        now_ms,
    )?;
    if hosted {
        for path in &deleted {
            remove_emptied_folders(store, root_dir, path, None);
        }
    }
    Ok(())
}

/// The head at a page change's path in the active version: the digest and
/// bytes its projection writes, and the digest its file holds once current.
struct RelayHead {
    sha: String,
    inline: Option<Vec<u8>>,
    file_sha: String,
    #[cfg(test)]
    _held: tests::HeldHead,
}

impl RelayHead {
    fn new(sha: String, inline: Option<Vec<u8>>, file_sha: String) -> Self {
        Self {
            sha,
            inline,
            file_sha,
            #[cfg(test)]
            _held: tests::HeldHead::new(),
        }
    }

    /// Whether the file `state` describes already holds this head.
    fn current(&self, state: &ProjectionTargetState, secret: bool) -> bool {
        if secret {
            matches!(state, ProjectionTargetState::Text { sha256 } if *sha256 == self.file_sha)
        } else {
            projection_matches(state, &self.file_sha)
        }
    }
}

/// The head at `change`'s path in `active`, or `None` when it has none.
fn relay_head(
    store: &mut EngineStore,
    workspace_id: &str,
    active: &str,
    change: &dohc_engine_sync::MomentMaterializationChange,
    secret_key: &mut Option<SecretDataKey>,
) -> Result<Option<RelayHead>, RuntimeError> {
    let path = change.path.as_str();
    Ok(match change.content_kind {
        "secret" => {
            if secret_key.is_none() {
                *secret_key = Some(load_projection_secret_key(store)?);
            }
            let key = secret_key.as_ref().expect("secret key loaded");
            let Some(plaintext) = SecretFileStore::new(store, key).materialize_secret_file(
                workspace_id,
                active,
                path,
            )?
            else {
                return Ok(None);
            };
            let file_sha = hex_sha256(plaintext.as_bytes());
            drop(plaintext);
            Some(RelayHead::new(
                secret_ciphertext_sha(store, workspace_id, active, path)?,
                None,
                file_sha,
            ))
        }
        "binary" => VersionedTextStore::new(store)
            .read_binary(workspace_id, active, path)?
            .map(|head| RelayHead::new(head.sha256.clone(), None, head.sha256)),
        "text" => VersionedTextStore::new(store)
            .read_text(workspace_id, active, path)?
            .map(|head| {
                RelayHead::new(
                    head.blob_sha256.clone(),
                    Some(head.text.into_bytes()),
                    head.blob_sha256,
                )
            }),
        _ => return Err(invalid_relay_kind()),
    })
}

/// Whether [`relay_head`] finds a head at `change`'s path in `active`, read
/// from the head's row without its body.
fn relay_has_head(
    store: &EngineStore,
    workspace_id: &str,
    active: &str,
    change: &dohc_engine_sync::MomentMaterializationChange,
) -> Result<bool, RuntimeError> {
    let sql = match change.content_kind {
        "secret" => {
            "SELECT EXISTS(SELECT 1 FROM secret_files \
             WHERE workspace_id = ?1 AND version_id = ?2 AND path = ?3)"
        }
        "binary" | "text" => {
            "SELECT EXISTS(SELECT 1 FROM path_aliases a JOIN snapshots s \
             ON s.workspace_id = a.workspace_id AND s.version_id = a.version_id \
             AND s.object_id = a.object_id \
             WHERE a.workspace_id = ?1 AND a.version_id = ?2 AND a.path = ?3)"
        }
        _ => return Err(invalid_relay_kind()),
    };
    Ok(store.read_with(|connection| {
        connection
            .query_row(sql, params![workspace_id, active, change.path], |row| {
                row.get(0)
            })
            .map_err(StorageError::corrupt_public)
    })?)
}

fn invalid_relay_kind() -> RuntimeError {
    DomainError::StateCorrupt {
        reason: "ordinary materialization kind is invalid",
    }
    .into()
}

#[cfg(test)]
pub(super) mod tests {
    use super::{
        ensure_mutation_version_on_store, is_inside, materialize_relay_page_on_store, path_key,
        reaches_other_spelling, relay_delete_precedes_write,
    };
    use dohc_engine_domain::{VersionedTextStore, WriteText};
    use dohc_engine_storage::{FaultInjector, NoFaults};
    use dohc_engine_sync::MomentMaterializationChange;
    use std::cell::{Cell, RefCell};
    use std::sync::Arc;
    use tokio_util::sync::CancellationToken;

    thread_local! {
        /// How many relay heads are loaded on this thread, and the most at once.
        static HEADS_HELD: Cell<(usize, usize)> = const { Cell::new((0, 0)) };
        /// The faults relay pages on this thread write their files under.
        pub(in crate::actor) static RELAY_FAULTS: RefCell<Option<Arc<dyn FaultInjector>>> =
            const { RefCell::new(None) };
    }

    /// A loaded relay head, counted in [`HEADS_HELD`] until it drops.
    pub(super) struct HeldHead;

    impl HeldHead {
        pub(super) fn new() -> Self {
            HEADS_HELD.with(|held| {
                let (now, most) = held.get();
                held.set((now + 1, most.max(now + 1)));
            });
            Self
        }
    }

    impl Drop for HeldHead {
        fn drop(&mut self) {
            HEADS_HELD.with(|held| {
                let (now, most) = held.get();
                held.set((now - 1, most));
            });
        }
    }

    /// A page whose files already match holds one head's body at a time,
    /// however many changes it has.
    #[test]
    fn a_page_loads_each_head_only_when_its_change_runs() {
        let (scratch, _, mut store) = dohc_engine_testkit::open_store();
        ensure_mutation_version_on_store(&mut store, "ws", "main", 1, &NoFaults).unwrap();
        let mut changes = Vec::new();
        for index in 0..8 {
            let path = format!("d{}/note-{index}.md", index % 2);
            let text = format!("body {index}\n");
            VersionedTextStore::new(&mut store)
                .write_text(
                    &WriteText {
                        workspace_id: "ws".to_owned(),
                        version_id: "main".to_owned(),
                        object_id: format!("doc-{index}"),
                        path: path.clone(),
                        text: text.clone(),
                        moment_id: format!("moment-{index}"),
                        metadata_origin: "test".to_owned(),
                        metadata_summary: None,
                        metadata_correlation_id: None,
                        author_json: None,
                        now_ms: 2 + index,
                        request_id: None,
                    },
                    &NoFaults,
                )
                .unwrap();
            let file = scratch.join(&path);
            std::fs::create_dir_all(file.parent().unwrap()).unwrap();
            std::fs::write(&file, &text).unwrap();
            changes.push(MomentMaterializationChange {
                version_id: "main".to_owned(),
                path,
                operation: "write",
                content_kind: "text",
            });
        }
        HEADS_HELD.with(|held| held.set((0, 0)));
        materialize_relay_page_on_store(
            &mut store,
            "ws",
            &scratch,
            changes,
            &(),
            20,
            &CancellationToken::new(),
        )
        .unwrap();
        assert_eq!(HEADS_HELD.with(Cell::get), (0, 1));
    }

    #[cfg(windows)]
    #[test]
    fn a_case_alias_page_publishes_the_new_spelling_even_with_equal_bytes() {
        let (scratch, _, mut store) = dohc_engine_testkit::open_store();
        ensure_mutation_version_on_store(&mut store, "ws", "main", 1, &NoFaults).unwrap();
        for path in ["held.md", "HELD.MD"] {
            VersionedTextStore::new(&mut store)
                .write_text(
                    &WriteText {
                        workspace_id: "ws".into(),
                        version_id: "main".into(),
                        object_id: path.into(),
                        path: path.into(),
                        text: "same\n".into(),
                        moment_id: path.into(),
                        metadata_origin: "test".into(),
                        metadata_summary: None,
                        metadata_correlation_id: None,
                        author_json: None,
                        now_ms: 2,
                        request_id: None,
                    },
                    &NoFaults,
                )
                .unwrap();
        }
        std::fs::write(scratch.join("held.md"), "same\n").unwrap();
        if !scratch.join("HELD.MD").exists() {
            return;
        }
        materialize_relay_page_on_store(
            &mut store,
            "ws",
            &scratch,
            vec![
                MomentMaterializationChange {
                    version_id: "main".into(),
                    path: "held.md".into(),
                    operation: "write",
                    content_kind: "text",
                },
                MomentMaterializationChange {
                    version_id: "main".into(),
                    path: "HELD.MD".into(),
                    operation: "write",
                    content_kind: "text",
                },
            ],
            &(),
            3,
            &CancellationToken::new(),
        )
        .unwrap();
        assert!(
            std::fs::read_dir(&scratch)
                .unwrap()
                .any(|entry| entry.unwrap().file_name() == "HELD.MD")
        );
        assert_eq!(
            std::fs::read_to_string(scratch.join("HELD.MD")).unwrap(),
            "same\n"
        );
    }

    fn write_head(
        store: &mut dohc_engine_storage::EngineStore,
        object: &str,
        path: &str,
        text: &str,
        now_ms: i64,
    ) {
        VersionedTextStore::new(store)
            .write_text(
                &WriteText {
                    workspace_id: "ws".to_owned(),
                    version_id: "main".to_owned(),
                    object_id: object.to_owned(),
                    path: path.to_owned(),
                    text: text.to_owned(),
                    moment_id: format!("moment-{object}-{now_ms}"),
                    metadata_origin: "test".to_owned(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: None,
                    now_ms,
                    request_id: None,
                },
                &NoFaults,
            )
            .unwrap();
    }

    fn delete_head(store: &mut dohc_engine_storage::EngineStore, path: &str, now_ms: i64) {
        VersionedTextStore::new(store)
            .delete_text_file(
                &dohc_engine_domain::DeleteTextFile {
                    workspace_id: "ws".to_owned(),
                    version_id: "main".to_owned(),
                    path: path.to_owned(),
                    moment_id: format!("moment-delete-{now_ms}"),
                    request_id: None,
                    metadata_origin: "test".to_owned(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: None,
                    now_ms,
                },
                &NoFaults,
            )
            .unwrap();
    }

    /// One page that brings `path` to its head.
    fn relay_page(
        store: &mut dohc_engine_storage::EngineStore,
        root: &std::path::Path,
        path: &str,
        operation: &'static str,
        now_ms: i64,
    ) {
        materialize_relay_page_on_store(
            store,
            "ws",
            root,
            vec![MomentMaterializationChange {
                version_id: "main".to_owned(),
                path: path.to_owned(),
                operation,
                content_kind: "text",
            }],
            &(),
            now_ms,
            &CancellationToken::new(),
        )
        .unwrap();
    }

    /// A peer whose disk keeps case apart can hold `notes.md` and `Notes.md`.
    /// When it creates `Notes.md` in one page and deletes `notes.md` in a
    /// later one, both spellings reach one file on a disk that ignores case.
    /// `Notes.md`'s head owns it, so the delete leaves it (#2157).
    #[test]
    fn a_later_pages_delete_leaves_the_file_another_spelling_owns() {
        let (scratch, _, mut store) = dohc_engine_testkit::open_store();
        ensure_mutation_version_on_store(&mut store, "ws", "main", 1, &NoFaults).unwrap();
        write_head(&mut store, "older", "notes.md", "older\n", 2);
        std::fs::write(scratch.join("notes.md"), "older\n").unwrap();
        // The test needs a disk that ignores case.
        if !scratch.join("Notes.md").exists() {
            return;
        }
        write_head(&mut store, "newer", "Notes.md", "newer\n", 3);
        relay_page(&mut store, &scratch, "Notes.md", "write", 3);
        assert_eq!(
            std::fs::read_to_string(scratch.join("Notes.md")).unwrap(),
            "newer\n"
        );
        delete_head(&mut store, "notes.md", 4);
        relay_page(&mut store, &scratch, "notes.md", "delete", 4);
        assert_eq!(
            std::fs::read_to_string(scratch.join("Notes.md")).unwrap(),
            "newer\n"
        );
        assert!(
            VersionedTextStore::new(&mut store)
                .read_text("ws", "main", "notes.md")
                .unwrap()
                .is_none(),
            "the delete itself still lands"
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_later_pages_delete_leaves_an_owner_in_an_unlistable_folder() {
        use std::os::unix::fs::PermissionsExt;
        let (scratch, _, mut store) = dohc_engine_testkit::open_store();
        ensure_mutation_version_on_store(&mut store, "ws", "main", 1, &NoFaults).unwrap();
        write_head(&mut store, "older", "private/notes.md", "same\n", 2);
        write_head(&mut store, "owner", "private/NOTES.MD", "same\n", 3);
        let private = scratch.join("private");
        std::fs::create_dir(&private).unwrap();
        std::fs::write(private.join("notes.md"), "same\n").unwrap();
        match std::fs::hard_link(private.join("notes.md"), private.join("NOTES.MD")) {
            Ok(()) if cfg!(target_os = "macos") => {
                eprintln!("SKIP: macOS knows the two entries on this disk that keeps case apart");
                return;
            }
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => panic!("could not create the owner's hard link: {error}"),
        }
        delete_head(&mut store, "private/notes.md", 4);
        let permissions = std::fs::metadata(&private).unwrap().permissions();
        std::fs::set_permissions(&private, std::fs::Permissions::from_mode(0o311)).unwrap();
        if std::fs::read_dir(&private).is_ok() {
            std::fs::set_permissions(&private, permissions).unwrap();
            eprintln!("SKIP: this user can list the private folder");
            return;
        }
        let result = materialize_relay_page_on_store(
            &mut store,
            "ws",
            &scratch,
            vec![MomentMaterializationChange {
                version_id: "main".to_owned(),
                path: "private/notes.md".to_owned(),
                operation: "delete",
                content_kind: "text",
            }],
            &(),
            4,
            &CancellationToken::new(),
        );
        std::fs::set_permissions(&private, permissions).unwrap();
        result.unwrap();
        assert_eq!(
            std::fs::read_to_string(private.join("notes.md")).unwrap(),
            "same\n"
        );
        assert!(
            VersionedTextStore::new(&mut store)
                .read_text("ws", "main", "private/notes.md")
                .unwrap()
                .is_none()
        );
    }

    /// With three spellings, the file stays with the owner whose bytes it
    /// holds, though another owner comes first in path order.
    #[test]
    fn a_later_pages_delete_keeps_the_owner_the_file_holds() {
        let (scratch, _, mut store) = dohc_engine_testkit::open_store();
        ensure_mutation_version_on_store(&mut store, "ws", "main", 1, &NoFaults).unwrap();
        write_head(&mut store, "older", "notes.md", "older\n", 2);
        std::fs::write(scratch.join("notes.md"), "held\n").unwrap();
        if !scratch.join("NOTES.md").exists() {
            return;
        }
        write_head(&mut store, "first", "NOTES.md", "first\n", 3);
        write_head(&mut store, "held", "Notes.md", "held\n", 3);
        delete_head(&mut store, "notes.md", 4);
        relay_page(&mut store, &scratch, "notes.md", "delete", 4);
        assert_eq!(
            std::fs::read_to_string(scratch.join("notes.md")).unwrap(),
            "held\n"
        );
    }

    /// An owner with equal bytes can still be stored under the deleted
    /// spelling, when its own page found the bytes current. The delete then
    /// publishes the owner's spelling.
    #[cfg(windows)]
    #[test]
    fn a_later_pages_delete_publishes_the_owners_spelling() {
        let (scratch, _, mut store) = dohc_engine_testkit::open_store();
        ensure_mutation_version_on_store(&mut store, "ws", "main", 1, &NoFaults).unwrap();
        write_head(&mut store, "older", "notes.md", "same\n", 2);
        std::fs::write(scratch.join("notes.md"), "same\n").unwrap();
        if !scratch.join("Notes.md").exists() {
            return;
        }
        write_head(&mut store, "newer", "Notes.md", "same\n", 3);
        delete_head(&mut store, "notes.md", 4);
        relay_page(&mut store, &scratch, "notes.md", "delete", 4);
        assert!(
            std::fs::read_dir(&scratch)
                .unwrap()
                .any(|entry| entry.unwrap().file_name() == "Notes.md")
        );
        assert_eq!(
            std::fs::read_to_string(scratch.join("Notes.md")).unwrap(),
            "same\n"
        );
    }

    /// A page that deletes `d/a` and writes a file at `d` runs in order, though
    /// a head at `D/A` reaches the same file on a disk that ignores case.
    #[test]
    fn a_page_that_writes_around_an_aliased_delete_runs_in_order() {
        let (scratch, _, mut store) = dohc_engine_testkit::open_store();
        ensure_mutation_version_on_store(&mut store, "ws", "main", 1, &NoFaults).unwrap();
        write_head(&mut store, "older", "d/a", "older\n", 2);
        std::fs::create_dir_all(scratch.join("d")).unwrap();
        std::fs::write(scratch.join("d/a"), "older\n").unwrap();
        if !scratch.join("D/A").exists() {
            return;
        }
        write_head(&mut store, "kept", "D/A", "older\n", 3);
        delete_head(&mut store, "d/a", 4);
        write_head(&mut store, "file", "d", "file\n", 4);
        let change = |path: &str, operation| MomentMaterializationChange {
            version_id: "main".to_owned(),
            path: path.to_owned(),
            operation,
            content_kind: "text",
        };
        materialize_relay_page_on_store(
            &mut store,
            "ws",
            &scratch,
            vec![change("d/a", "delete"), change("d", "write")],
            &(),
            4,
            &CancellationToken::new(),
        )
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(scratch.join("d")).unwrap(),
            "file\n"
        );
    }

    /// Two owners hold the file's bytes. The one the disk already spells the
    /// file as keeps it, though the other comes first in path order.
    #[test]
    fn a_later_pages_delete_keeps_the_owner_spelled_as_the_file() {
        let (scratch, _, mut store) = dohc_engine_testkit::open_store();
        ensure_mutation_version_on_store(&mut store, "ws", "main", 1, &NoFaults).unwrap();
        write_head(&mut store, "older", "notes.md", "same\n", 2);
        std::fs::write(scratch.join("Notes.md"), "same\n").unwrap();
        if !scratch.join("NOTES.md").exists() {
            return;
        }
        write_head(&mut store, "first", "NOTES.md", "same\n", 3);
        write_head(&mut store, "kept", "Notes.md", "same\n", 3);
        delete_head(&mut store, "notes.md", 4);
        relay_page(&mut store, &scratch, "notes.md", "delete", 4);
        assert!(
            std::fs::read_dir(&scratch)
                .unwrap()
                .any(|entry| entry.unwrap().file_name() == "Notes.md")
        );
    }

    /// The disk spells the file as an owner the files policy no longer tracks,
    /// so the file and its local edits are that owner's to keep.
    #[test]
    fn a_later_pages_delete_keeps_the_file_of_an_untracked_owner() {
        let (scratch, _, mut store) = dohc_engine_testkit::open_store();
        ensure_mutation_version_on_store(&mut store, "ws", "main", 1, &NoFaults).unwrap();
        write_head(&mut store, "older", "notes.md", "older\n", 2);
        std::fs::write(scratch.join("NOTES.md"), "edited\n").unwrap();
        if !scratch.join("notes.md").exists() {
            return;
        }
        write_head(&mut store, "other", "NOTES.md", "other\n", 3);
        std::fs::create_dir_all(scratch.join(".dohc")).unwrap();
        std::fs::write(
            scratch.join(".dohc/files.toml"),
            "version = 1\n[[rule]]\npath = \"NOTES.md\"\ntracked = false\n",
        )
        .unwrap();
        delete_head(&mut store, "notes.md", 4);
        relay_page(&mut store, &scratch, "notes.md", "delete", 4);
        assert_eq!(
            std::fs::read_to_string(scratch.join("NOTES.md")).unwrap(),
            "edited\n"
        );
    }

    /// The disk spells the file's folder as the deleted path does, not as the
    /// untracked owner does, so the file isn't that owner's and the delete runs.
    #[test]
    fn a_later_pages_delete_removes_a_file_only_its_folder_spells_as_an_untracked_owner() {
        let (scratch, _, mut store) = dohc_engine_testkit::open_store();
        ensure_mutation_version_on_store(&mut store, "ws", "main", 1, &NoFaults).unwrap();
        write_head(&mut store, "older", "d/a.md", "older\n", 2);
        std::fs::create_dir_all(scratch.join("d")).unwrap();
        std::fs::write(scratch.join("d/a.md"), "older\n").unwrap();
        if !scratch.join("D/a.md").exists() {
            return;
        }
        write_head(&mut store, "other", "D/a.md", "other\n", 3);
        std::fs::create_dir_all(scratch.join(".dohc")).unwrap();
        std::fs::write(
            scratch.join(".dohc/files.toml"),
            "version = 1\n[[rule]]\npath = \"D/**\"\ntracked = false\n",
        )
        .unwrap();
        delete_head(&mut store, "d/a.md", 4);
        relay_page(&mut store, &scratch, "d/a.md", "delete", 4);
        assert!(!scratch.join("d/a.md").exists());
    }

    /// Two deletes in one page reach the same file while a third spelling
    /// keeps its head. The first gives the file that head's bytes, and the
    /// second then finds them in place.
    #[test]
    fn two_aliased_deletes_in_one_page_leave_the_file_to_the_third_spelling() {
        let (scratch, _, mut store) = dohc_engine_testkit::open_store();
        ensure_mutation_version_on_store(&mut store, "ws", "main", 1, &NoFaults).unwrap();
        write_head(&mut store, "older", "notes.md", "older\n", 2);
        std::fs::write(scratch.join("notes.md"), "older\n").unwrap();
        if !scratch.join("NOTES.md").exists() {
            return;
        }
        write_head(&mut store, "other", "NOTES.md", "other\n", 3);
        write_head(&mut store, "kept", "Notes.md", "kept\n", 3);
        delete_head(&mut store, "notes.md", 4);
        delete_head(&mut store, "NOTES.md", 5);
        let change = |path: &str| MomentMaterializationChange {
            version_id: "main".to_owned(),
            path: path.to_owned(),
            operation: "delete",
            content_kind: "text",
        };
        materialize_relay_page_on_store(
            &mut store,
            "ws",
            &scratch,
            vec![change("notes.md"), change("NOTES.md")],
            &(),
            4,
            &CancellationToken::new(),
        )
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(scratch.join("Notes.md")).unwrap(),
            "kept\n"
        );
    }

    /// Only a path that can have another spelling looks for an owner: one with
    /// other than ASCII characters always, and an ASCII one when a folder on its
    /// way ignores case or normalization. An ASCII path with no letters, `;` or
    /// `` ` `` has no other spelling.
    #[test]
    fn only_a_path_with_another_spelling_looks_for_an_owner() {
        let (scratch, _, _store) = dohc_engine_testkit::open_store();
        std::fs::create_dir_all(scratch.join("d")).unwrap();
        std::fs::write(scratch.join("d/notes.md"), "x").unwrap();
        std::fs::write(scratch.join("123"), "x").unwrap();
        std::fs::write(scratch.join("123;"), "x").unwrap();
        assert!(!reaches_other_spelling(&scratch, "123"));
        assert!(reaches_other_spelling(&scratch, "caf\u{e9}.md"));
        assert_eq!(
            reaches_other_spelling(&scratch, "d/notes.md"),
            scratch.join("D/NOTES.MD").exists()
        );
        assert_eq!(
            reaches_other_spelling(&scratch, "123;"),
            scratch.join("123\u{37e}").exists()
        );
        std::fs::write(scratch.join("123\u{37e}"), "x").unwrap();
        assert!(reaches_other_spelling(&scratch, "123;"));
    }

    /// A case-only rename arrives as one page that deletes `notes.md` and
    /// writes `Notes.md` with the same bytes. The page runs its delete and then
    /// its write, as #2146 orders them, and the file takes the new spelling.
    #[test]
    fn a_case_only_rename_page_runs_its_delete_and_write() {
        let (scratch, _, mut store) = dohc_engine_testkit::open_store();
        ensure_mutation_version_on_store(&mut store, "ws", "main", 1, &NoFaults).unwrap();
        write_head(&mut store, "older", "notes.md", "same\n", 2);
        std::fs::write(scratch.join("notes.md"), "same\n").unwrap();
        if !scratch.join("Notes.md").exists() {
            return;
        }
        delete_head(&mut store, "notes.md", 3);
        write_head(&mut store, "renamed", "Notes.md", "same\n", 3);
        let change = |path: &str, operation| MomentMaterializationChange {
            version_id: "main".to_owned(),
            path: path.to_owned(),
            operation,
            content_kind: "text",
        };
        materialize_relay_page_on_store(
            &mut store,
            "ws",
            &scratch,
            vec![change("notes.md", "delete"), change("Notes.md", "write")],
            &(),
            3,
            &CancellationToken::new(),
        )
        .unwrap();
        assert!(
            std::fs::read_dir(&scratch)
                .unwrap()
                .any(|entry| entry.unwrap().file_name() == "Notes.md")
        );
        assert_eq!(
            std::fs::read_to_string(scratch.join("Notes.md")).unwrap(),
            "same\n"
        );
    }

    /// The same peer edits `notes.md` after creating `Notes.md`. The edit lands
    /// on the one file both spellings reach, so when `notes.md` goes, the file
    /// holds neither head's bytes until it gets `Notes.md`'s again.
    #[test]
    fn a_later_pages_delete_gives_the_file_back_to_the_other_spelling() {
        let (scratch, _, mut store) = dohc_engine_testkit::open_store();
        ensure_mutation_version_on_store(&mut store, "ws", "main", 1, &NoFaults).unwrap();
        write_head(&mut store, "older", "notes.md", "older\n", 2);
        std::fs::write(scratch.join("notes.md"), "older\n").unwrap();
        if !scratch.join("Notes.md").exists() {
            return;
        }
        write_head(&mut store, "newer", "Notes.md", "newer\n", 3);
        relay_page(&mut store, &scratch, "Notes.md", "write", 3);
        write_head(&mut store, "older", "notes.md", "edited\n", 4);
        relay_page(&mut store, &scratch, "notes.md", "write", 4);
        assert_eq!(
            std::fs::read_to_string(scratch.join("Notes.md")).unwrap(),
            "edited\n"
        );
        delete_head(&mut store, "notes.md", 5);
        relay_page(&mut store, &scratch, "notes.md", "delete", 5);
        assert_eq!(
            std::fs::read_to_string(scratch.join("Notes.md")).unwrap(),
            "newer\n"
        );
    }

    /// An older build's page can carry a change for Finder's `.DS_Store`. The
    /// page skips it and still places the rest.
    #[test]
    fn a_page_skips_a_change_at_an_ignored_path() {
        let (scratch, _, mut store) = dohc_engine_testkit::open_store();
        ensure_mutation_version_on_store(&mut store, "ws", "main", 1, &NoFaults).unwrap();
        VersionedTextStore::new(&mut store)
            .write_text(
                &WriteText {
                    workspace_id: "ws".to_owned(),
                    version_id: "main".to_owned(),
                    object_id: "notes".to_owned(),
                    path: "notes.md".to_owned(),
                    text: "body\n".to_owned(),
                    moment_id: "moment-notes".to_owned(),
                    metadata_origin: "test".to_owned(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: None,
                    now_ms: 2,
                    request_id: None,
                },
                &NoFaults,
            )
            .unwrap();
        let change = |path: &str| MomentMaterializationChange {
            version_id: "main".to_owned(),
            path: path.to_owned(),
            operation: "write",
            content_kind: "text",
        };
        materialize_relay_page_on_store(
            &mut store,
            "ws",
            &scratch,
            vec![change(".DS_Store"), change("notes.md")],
            &(),
            20,
            &CancellationToken::new(),
        )
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(scratch.join("notes.md")).unwrap(),
            "body\n"
        );
        assert!(!scratch.join(".DS_Store").exists());
    }

    /// Finder leaves `.DS_Store` in a folder it showed. When a page deletes the
    /// folder's last file and writes a file at the folder's name, that folder
    /// still gives way.
    #[cfg(target_vendor = "apple")]
    #[test]
    fn a_folder_holding_only_finder_files_gives_way_to_a_file() {
        let (scratch, _, mut store) = dohc_engine_testkit::open_store();
        ensure_mutation_version_on_store(&mut store, "ws", "main", 1, &NoFaults).unwrap();
        let write = |store: &mut dohc_engine_storage::EngineStore, object: &str, path: &str| {
            VersionedTextStore::new(store)
                .write_text(
                    &WriteText {
                        workspace_id: "ws".to_owned(),
                        version_id: "main".to_owned(),
                        object_id: object.to_owned(),
                        path: path.to_owned(),
                        text: format!("{object}\n"),
                        moment_id: format!("moment-{object}"),
                        metadata_origin: "test".to_owned(),
                        metadata_summary: None,
                        metadata_correlation_id: None,
                        author_json: None,
                        now_ms: 2,
                        request_id: None,
                    },
                    &NoFaults,
                )
                .unwrap();
        };
        write(&mut store, "inner", "d/a.md");
        std::fs::create_dir_all(scratch.join("d")).unwrap();
        std::fs::write(scratch.join("d/a.md"), "inner\n").unwrap();
        std::fs::write(scratch.join("d/.DS_Store"), "finder").unwrap();
        VersionedTextStore::new(&mut store)
            .delete_text_file(
                &dohc_engine_domain::DeleteTextFile {
                    workspace_id: "ws".to_owned(),
                    version_id: "main".to_owned(),
                    path: "d/a.md".to_owned(),
                    moment_id: "moment-delete".to_owned(),
                    request_id: None,
                    metadata_origin: "test".to_owned(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: None,
                    now_ms: 3,
                },
                &NoFaults,
            )
            .unwrap();
        write(&mut store, "file", "d");
        let change = |path: &str, operation| MomentMaterializationChange {
            version_id: "main".to_owned(),
            path: path.to_owned(),
            operation,
            content_kind: "text",
        };
        materialize_relay_page_on_store(
            &mut store,
            "ws",
            &scratch,
            vec![change("d/a.md", "delete"), change("d", "write")],
            &(),
            20,
            &CancellationToken::new(),
        )
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(scratch.join("d")).unwrap(),
            "file\n"
        );
    }

    #[test]
    fn a_delete_precedes_only_the_writes_it_lies_inside() {
        let writes = [path_key("notes")];
        assert!(relay_delete_precedes_write(
            &path_key("notes/a.md"),
            &writes
        ));
        assert!(relay_delete_precedes_write(
            &path_key("NOTES/a.md"),
            &writes
        ));
        assert!(!relay_delete_precedes_write(&path_key("notes"), &writes));
        assert!(!relay_delete_precedes_write(&path_key("notes/a.md"), &[]));
    }

    #[test]
    fn containment_respects_component_boundaries_in_any_case() {
        let inside = |path, ancestor| is_inside(&path_key(path), &path_key(ancestor));
        assert!(inside("D/sub/a.md", "D"));
        assert!(inside("X.md/child.md", "x.md"));
        assert!(!inside("Dog/a.md", "D"));
        assert!(!inside("D", "d"));
    }
}
