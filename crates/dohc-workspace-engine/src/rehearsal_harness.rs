//! Harness-only dispatcher for a real-tree clone/reset rehearsal.
//!
//! This module is compiled only by the `harness` feature. It never opens the
//! source workspace for writing: all markers, stores, and rehearsal state are
//! created beneath a byte clone. Evidence is banked only after a full source
//! hash/mtime snapshot is unchanged and the production daemon capture path has
//! recaptured every expected user file into a healthy, settled fresh store.

use crate::EngineService;
use crate::cutover_rehearse::{
    BackupFingerprint, NoFaults, RehearsalConfig, RehearsalError, RehearsalOutcome, RehearsalState,
    StateRecord, fsync_dir, run_rehearsal, validate_rehearsal_root,
    write_rehearsal_token_for_harness,
};
use crate::shadow_fence::{ShadowFenceError, write_shadow_marker_for_harness};
use dohc_engine_domain::{SECRET_SEED_SENTINEL_SHA, SecretFileStore, capture_manifest_seed};
use dohc_engine_files::floor::{
    ENGINE_STORAGE_SEGMENT, IGNORED_FILE_PREFIXES, RESERVED_SEGMENTS, is_excluded_file,
    normalize_segment,
};
use dohc_engine_files::policy::{PathClassification, classify_engine_file_path_normalized};
use dohc_engine_protocol::{
    transport::{EngineTransport, InProcessTransport, RequestContext},
    wire::{Request, WorkspaceHandle},
};
use dohc_engine_runtime::search::{
    DiagnosticReason, read_engine_search_policy, resolve_effective_policy,
};
use dohc_engine_storage::{EngineStore, StorageError};
use filetime::FileTime;
use serde::Serialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::ffi::{OsStr, OsString};
use std::fs::{File, Metadata};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const EVIDENCE_FILE: &str = "REHEARSAL_EVIDENCE.json";
const TYPESCRIPT_STORE_DIR: &str = "typescript-engine-byte-clone";
const RECAPTURE_WORKSPACE_ID: &str = "gate6-recapture";
const RECAPTURE_VERSION_ID: &str = "main";
const RECAPTURE_TIMEOUT: Duration = Duration::from_secs(60);
const SQLITE_SOURCE_FILES: [&str; 4] = [
    "engine.db",
    "engine.db-wal",
    "engine.db-shm",
    "engine.db-journal",
];
const COPY_BUFFER_BYTES: usize = 64 * 1024;
const HARD_LINK_FILE_SAMPLE_LIMIT: usize = 128;
const HARD_LINK_TWIN_PATH_SAMPLE_LIMIT: usize = 32;

#[derive(Debug, Clone, Copy)]
pub struct HarnessConfig<'a> {
    pub source: &'a Path,
    pub scratch: &'a Path,
    pub recovery: &'a Path,
}

#[derive(Debug, thiserror::Error)]
pub enum HarnessError {
    #[error("source workspace must contain a real .dohc directory")]
    SourceDohcMissing,
    #[error("{which} must be outside the source workspace")]
    PathInsideSource { which: &'static str },
    #[error("scratch and recovery must be separate, non-nested directories")]
    ScratchRecoveryOverlap,
    #[error("source workspace changed during the rehearsal")]
    SourceChanged,
    #[error("the initial clone did not exactly match the floor-filtered source snapshot")]
    CloneMismatch,
    #[error("the clone contains an unsupported alias or special file: {path}")]
    UnsupportedEntry { path: String },
    #[error("the clone already contains the reserved TypeScript-store retention directory")]
    RetentionDirectoryExists,
    #[error("the freshly initialized Rust store did not accept its shadow-clone binding")]
    ShadowBindingRefused,
    #[error("the operating system did not provide a random marker token")]
    RandomToken,
    #[error("rehearsal returned a non-complete outcome: {0}")]
    IncompleteOutcome(String),
    #[error("production recapture failed during {stage}: {detail}")]
    RecapturePipeline { stage: &'static str, detail: String },
    #[error("recapture comparison was not total:\n{diff}")]
    RecaptureIncomplete { diff: String },
    #[error("filesystem operation failed during {operation}")]
    Io {
        operation: &'static str,
        #[source]
        source: std::io::Error,
    },
    #[error("shadow marker operation failed")]
    ShadowMarker(#[from] ShadowFenceError),
    #[error("rehearsal marker operation failed")]
    RehearsalMarker(#[from] crate::cutover_rehearse::FenceError),
    #[error("Rust store initialization failed")]
    Storage(#[from] StorageError),
    #[error("clone-reset rehearsal failed")]
    Rehearsal(#[from] RehearsalError),
    #[error("evidence serialization failed")]
    Json(#[from] serde_json::Error),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TreeSummary {
    /// Includes the tree root itself.
    pub directory_count: usize,
    pub file_count: usize,
    pub total_file_bytes: u64,
    pub snapshot_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SourceUnchangedProof {
    pub verified: bool,
    pub before_snapshot_sha256: String,
    pub after_snapshot_sha256: String,
    pub before: TreeSummary,
    pub after: TreeSummary,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ArtifactEntry {
    pub relative_path: String,
    pub size_bytes: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PreservedSourceStoreEntry {
    pub original_relative_path: String,
    pub retained_relative_path: String,
    pub size_bytes: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FloorSkippedRootKind {
    Directory,
    Alias,
    File,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FloorSkippedRoot {
    pub relative_path: String,
    pub kind: FloorSkippedRootKind,
    pub source_root_modified_seconds: i64,
    pub source_root_modified_nanoseconds: u32,
    pub source_content_sha256: String,
    pub source_file_count: usize,
    pub source_total_file_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FloorSkipEvidence {
    pub root_count: usize,
    pub directory_root_count: usize,
    pub alias_root_count: usize,
    pub file_root_count: usize,
    pub roots: Vec<FloorSkippedRoot>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum HardLinkTwinLocation {
    InsideSourceTree,
    OutsideSourceTree,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct HardLinkTwinSample {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved_path: Option<String>,
    pub location: HardLinkTwinLocation,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct HardLinkedSourceFile {
    pub relative_path: String,
    pub link_count: u64,
    pub twin_path_count: usize,
    pub inside_source_tree_twin_count: usize,
    pub outside_source_tree_twin_count: usize,
    pub sampled_twin_path_count: usize,
    pub omitted_twin_path_count: usize,
    pub twin_path_sample_limit: usize,
    pub twin_paths: Vec<HardLinkTwinSample>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct HardLinkEvidence {
    pub clone_semantics: String,
    pub real_cutover_flag: String,
    pub hard_linked_source_file_count: usize,
    pub total_link_count: u64,
    pub total_twin_path_count: usize,
    pub inside_source_tree_twin_count: usize,
    pub outside_source_tree_twin_count: usize,
    pub outside_source_tree_observed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub flagged_observation_for_ice: Option<String>,
    pub file_sample_limit: usize,
    pub sampled_file_count: usize,
    pub omitted_file_count: usize,
    pub files: Vec<HardLinkedSourceFile>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RecaptureEvidence {
    pub paths_expected: usize,
    pub paths_recaptured: usize,
    pub records_expected: usize,
    pub records_recaptured: usize,
    pub content_identities_verified: usize,
    pub flush_attempts: usize,
    pub mismatches: Vec<RecaptureMismatch>,
    pub projections_settled: bool,
    pub verdict: RecaptureVerdict,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RecaptureVerdict {
    Complete,
    Incomplete,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RecaptureMismatch {
    pub path: String,
    pub reasons: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected: Option<RecaptureInventoryState>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recaptured: Option<RecaptureInventoryState>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RecaptureInventoryState {
    pub size_bytes: u64,
    pub sha256: String,
    pub storage_kind: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Timings {
    pub source_snapshot_before_ms: u64,
    pub byte_clone_ms: u64,
    pub clone_preparation_ms: u64,
    pub rehearsal_ms: u64,
    pub recapture_ms: u64,
    pub source_verification_ms: u64,
    pub total_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RehearsalEvidence {
    pub schema_version: u32,
    pub criterion: String,
    pub recorded_interpretation: String,
    pub floor_clone_design_decision: String,
    pub started_at_unix_ms: i64,
    pub finished_at_unix_ms: i64,
    pub source_path: String,
    pub clone_path: String,
    pub recovery_path: String,
    pub outcome: String,
    pub state_record: StateRecord,
    pub backup_fingerprint: BackupFingerprint,
    pub fresh_engine_uuid: String,
    pub source_unchanged: SourceUnchangedProof,
    pub source_counts: TreeSummary,
    pub byte_clone_input_counts: TreeSummary,
    pub initial_byte_clone_counts: TreeSummary,
    pub final_clone_counts: TreeSummary,
    pub floor_skips: FloorSkipEvidence,
    pub hard_links: HardLinkEvidence,
    pub recapture: RecaptureEvidence,
    pub ui_state_tmp_orphans: Vec<ArtifactEntry>,
    pub preserved_typescript_store: Vec<PreservedSourceStoreEntry>,
    pub recovery_artifacts: Vec<ArtifactEntry>,
    pub timings: Timings,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct TreeEntry {
    relative_path: String,
    kind: EntryKind,
    size_bytes: u64,
    contained_file_count: usize,
    modified_seconds: i64,
    modified_nanoseconds: u32,
    sha256: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EntryKind {
    Directory,
    File,
    FloorSkippedDirectory,
    FloorSkippedAlias,
    FloorSkippedFile,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct TreeSnapshot {
    entries: Vec<TreeEntry>,
    summary: TreeSummary,
}

struct PreparedClone {
    preserved_store: Vec<PreservedSourceStoreEntry>,
}

struct CloneTreeResult {
    floor_skips: FloorSkipEvidence,
    hard_links: HardLinkEvidence,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct InventoryState {
    size_bytes: u64,
    sha256: String,
    storage_kind: &'static str,
    secret: bool,
}

#[derive(Debug, Clone, Copy)]
struct RecaptureRun {
    flush_attempts: usize,
}

type PostCaptureHook<'a> = Option<&'a dyn Fn(&Path) -> Result<(), HarnessError>>;

/// Run one clone/reset rehearsal and bank its evidence.
///
/// The source is read only. Evidence is published only after the production
/// daemon capture path has recaptured the reset clone completely and a second
/// source snapshot proves every relative path, file hash, size, and mtime is
/// unchanged.
pub fn run(config: HarnessConfig<'_>) -> Result<RehearsalEvidence, HarnessError> {
    run_with_post_capture_hook(config, None)
}

fn run_with_post_capture_hook(
    config: HarnessConfig<'_>,
    post_capture_hook: PostCaptureHook<'_>,
) -> Result<RehearsalEvidence, HarnessError> {
    let total_started = Instant::now();
    let started_at_unix_ms = unix_now_ms()?;
    let (source, scratch, recovery) = validate_paths(config)?;

    let source_snapshot_started = Instant::now();
    let source_before = snapshot_source_tree(&source)?;
    let source_snapshot_before_ms = elapsed_ms(source_snapshot_started);

    let operation = run_on_clone(
        &source,
        &scratch,
        &recovery,
        &source_before,
        started_at_unix_ms,
        post_capture_hook,
    );

    // This assertion runs even when cloning, preparation, or rehearsal failed.
    // A source mutation is always the primary safety failure.
    let source_verification_started = Instant::now();
    let source_after = snapshot_source_tree(&source)?;
    if source_before != source_after {
        return Err(HarnessError::SourceChanged);
    }
    let source_verification_ms = elapsed_ms(source_verification_started);

    let mut completed = operation?;
    let source_unchanged = SourceUnchangedProof {
        verified: true,
        before_snapshot_sha256: source_before.summary.snapshot_sha256.clone(),
        after_snapshot_sha256: source_after.summary.snapshot_sha256.clone(),
        before: source_before.summary.clone(),
        after: source_after.summary,
    };
    let finished_at_unix_ms = unix_now_ms()?;
    let backup_fingerprint = completed.state_record.backup.clone().ok_or_else(|| {
        HarnessError::IncompleteOutcome("complete record lacks backup".to_owned())
    })?;
    let fresh_engine_uuid = completed
        .state_record
        .fresh_engine_uuid
        .clone()
        .ok_or_else(|| {
            HarnessError::IncompleteOutcome("complete record lacks fresh engine UUID".to_owned())
        })?;
    let evidence = RehearsalEvidence {
        schema_version: 4,
        criterion: "GATE6 end-to-end clone-reset rehearsal on real dogfood workspace byte-clones"
            .to_owned(),
        recorded_interpretation: "The live dogfood engine.db is TypeScript-authored and the Rust fence correctly refuses its foreign fingerprint. The authorized cutover is a reset: retain the source SQLite files inside the byte clone, initialize and bind a fresh Rust store in the clone, write the two harness-only markers, then exercise run_rehearsal(NoFaults). Ice accepted the data wipe; this interpretation remains flagged for Ice's post-hoc review.".to_owned(),
        floor_clone_design_decision: "The byte clone applies the canonical capture floor to both directory roots and files, except the .dohc subtree required by the rehearsal machinery. Reset never touches capture-excluded content because it is outside the engine's world. Every omitted root or file is recorded, and the complete contents of omitted directory trees are independently hashed into the before/after source proof. Alias and special-file refusal remains fail-closed for every entry actually cloned.".to_owned(),
        started_at_unix_ms,
        finished_at_unix_ms,
        source_path: display_path(&source),
        clone_path: display_path(&completed.clone_path),
        recovery_path: display_path(&recovery),
        outcome: "complete".to_owned(),
        state_record: completed.state_record,
        backup_fingerprint,
        fresh_engine_uuid,
        source_unchanged,
        source_counts: source_before.summary,
        byte_clone_input_counts: completed.byte_clone_input.summary,
        initial_byte_clone_counts: completed.initial_clone.summary,
        final_clone_counts: completed.final_clone.summary,
        floor_skips: completed.floor_skips,
        hard_links: completed.hard_links,
        recapture: completed.recapture,
        ui_state_tmp_orphans: completed.ui_state_tmp_orphans,
        preserved_typescript_store: completed.prepared.preserved_store,
        recovery_artifacts: std::mem::take(&mut completed.recovery_artifacts),
        timings: Timings {
            source_snapshot_before_ms,
            byte_clone_ms: completed.byte_clone_ms,
            clone_preparation_ms: completed.clone_preparation_ms,
            rehearsal_ms: completed.rehearsal_ms,
            recapture_ms: completed.recapture_ms,
            source_verification_ms,
            total_ms: elapsed_ms(total_started),
        },
    };
    write_evidence(&recovery, &evidence)?;
    Ok(evidence)
}

struct CompletedClone {
    clone_path: PathBuf,
    byte_clone_input: TreeSnapshot,
    initial_clone: TreeSnapshot,
    final_clone: TreeSnapshot,
    floor_skips: FloorSkipEvidence,
    hard_links: HardLinkEvidence,
    prepared: PreparedClone,
    state_record: StateRecord,
    recapture: RecaptureEvidence,
    ui_state_tmp_orphans: Vec<ArtifactEntry>,
    recovery_artifacts: Vec<ArtifactEntry>,
    byte_clone_ms: u64,
    clone_preparation_ms: u64,
    rehearsal_ms: u64,
    recapture_ms: u64,
}

fn run_on_clone(
    source: &Path,
    scratch: &Path,
    recovery: &Path,
    source_before: &TreeSnapshot,
    started_at_unix_ms: i64,
    post_capture_hook: PostCaptureHook<'_>,
) -> Result<CompletedClone, HarnessError> {
    create_private_dir_all(scratch, "create private scratch directory")?;
    create_private_dir_all(recovery, "create private recovery directory")?;
    let scratch = canonicalize(scratch, "canonicalize scratch directory")?;
    let recovery = canonicalize(recovery, "canonicalize recovery directory")?;
    ensure_outside(source, &scratch, "scratch")?;
    ensure_outside(source, &recovery, "recovery")?;
    ensure_disjoint(&scratch, &recovery)?;

    let clone_path = scratch.join(format!("clone-{started_at_unix_ms}"));
    ensure_outside(source, &clone_path, "clone")?;

    let clone_started = Instant::now();
    let clone_result = clone_tree(source, &clone_path)?;
    let initial_clone = snapshot_tree(&clone_path)?;
    let byte_clone_ms = elapsed_ms(clone_started);
    let byte_clone_input = clone_input_snapshot(source_before);
    if clone_result.floor_skips != floor_skip_evidence(source_before)
        || byte_clone_input.entries != initial_clone.entries
    {
        return Err(HarnessError::CloneMismatch);
    }
    let ui_state_tmp_orphans = debris_entries(&initial_clone);
    let expected_inventory = expected_recapture_inventory(&initial_clone, &clone_path)?;

    let preparation_started = Instant::now();
    let prepared = prepare_clone(&clone_path, started_at_unix_ms)?;
    let clone_preparation_ms = elapsed_ms(preparation_started);

    let rehearsal_started = Instant::now();
    let outcome = run_rehearsal(RehearsalConfig {
        root: &clone_path,
        recovery_dir: &recovery,
        now_ms: started_at_unix_ms.saturating_add(1),
        faults: &NoFaults,
    })?;
    let rehearsal_ms = elapsed_ms(rehearsal_started);
    let state_record = match outcome {
        RehearsalOutcome::Complete(record) if record.current == RehearsalState::Complete => record,
        RehearsalOutcome::Complete(record) => {
            return Err(HarnessError::IncompleteOutcome(format!(
                "Complete variant carried {:?}",
                record.current
            )));
        }
        RehearsalOutcome::Failed(record) => {
            return Err(HarnessError::IncompleteOutcome(format!(
                "failed at {:?}",
                record.current
            )));
        }
        RehearsalOutcome::Crashed(record) => {
            return Err(HarnessError::IncompleteOutcome(format!(
                "crashed at {:?}",
                record.current
            )));
        }
    };

    let recapture_started = Instant::now();
    let recapture_run = drive_production_recapture(&clone_path)?;
    if let Some(hook) = post_capture_hook {
        hook(&clone_path)?;
    }
    let recapture = compare_recapture(
        &clone_path,
        &expected_inventory,
        recapture_run.flush_attempts,
    )?;
    let recapture_ms = elapsed_ms(recapture_started);
    if recapture.verdict != RecaptureVerdict::Complete {
        let diff = serde_json::to_string_pretty(&recapture)?;
        return Err(HarnessError::RecaptureIncomplete { diff });
    }

    let final_clone = snapshot_tree(&clone_path)?;
    let recovery_artifacts = artifact_manifest(&recovery, Some(EVIDENCE_FILE))?;
    Ok(CompletedClone {
        clone_path,
        byte_clone_input,
        initial_clone,
        final_clone,
        floor_skips: clone_result.floor_skips,
        hard_links: clone_result.hard_links,
        prepared,
        state_record,
        recapture,
        ui_state_tmp_orphans,
        recovery_artifacts,
        byte_clone_ms,
        clone_preparation_ms,
        rehearsal_ms,
        recapture_ms,
    })
}

fn expected_recapture_inventory(
    pre_reset: &TreeSnapshot,
    clone_root: &Path,
) -> Result<BTreeMap<String, InventoryState>, HarnessError> {
    let policy = read_engine_search_policy(clone_root);
    if policy.diagnostics.iter().any(|diagnostic| {
        diagnostic.file == "files.toml" && diagnostic.reason == DiagnosticReason::Unreadable
    }) {
        return Err(recapture_failure(
            "read capture policy",
            "the cloned .dohc/files.toml exists but is unreadable",
        ));
    }

    let mut expected = BTreeMap::new();
    for entry in &pre_reset.entries {
        if entry.kind != EntryKind::File
            || entry.relative_path == ENGINE_STORAGE_SEGMENT
            || entry
                .relative_path
                .starts_with(&format!("{ENGINE_STORAGE_SEGMENT}/"))
        {
            continue;
        }
        let (classification, normalized) =
            classify_engine_file_path_normalized(&entry.relative_path);
        if classification == PathClassification::Ignored {
            continue;
        }
        let secret = classification == PathClassification::Secret;
        if classification == PathClassification::Tracked
            && policy.files_policy.as_ref().is_some_and(|rules| {
                !resolve_effective_policy(&entry.relative_path, Some(rules.as_slice()), None)
                    .tracked
            })
        {
            continue;
        }
        let storage_kind = match classification {
            PathClassification::Secret => "secret",
            PathClassification::Tracked
                if normalized.as_deref() == Some(entry.relative_path.as_str()) =>
            {
                "content"
            }
            PathClassification::Tracked => "capture_refused",
            PathClassification::Ignored => unreachable!("ignored paths were excluded above"),
        };
        expected.insert(
            entry.relative_path.clone(),
            InventoryState {
                size_bytes: entry.size_bytes,
                sha256: entry.sha256.clone(),
                storage_kind,
                secret,
            },
        );
    }
    Ok(expected)
}

fn drive_production_recapture(clone_root: &Path) -> Result<RecaptureRun, HarnessError> {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(4)
        .enable_all()
        .build()
        .map_err(|error| recapture_failure("create daemon runtime", error))?;
    runtime.block_on(async {
        let transport = InProcessTransport::new(Arc::new(EngineService::new()));
        let opened = transport
            .call(
                RequestContext::unbounded(),
                recapture_request(
                    1,
                    "workspace.open",
                    None,
                    json!({
                        "rootDir": clone_root.to_string_lossy(),
                        "workspaceId": RECAPTURE_WORKSPACE_ID,
                    }),
                ),
            )
            .await
            .map_err(|error| recapture_failure("workspace.open", format!("{error:?}")))?;
        let handle: WorkspaceHandle = serde_json::from_value(opened.result["workspace"].clone())
            .map_err(|error| recapture_failure("decode workspace handle", error))?;

        let mut request_id = 1_u64;
        let mut flush_attempts = 0_usize;
        let deadline = tokio::time::Instant::now() + RECAPTURE_TIMEOUT;
        let flush_result = loop {
            request_id = request_id.saturating_add(1);
            flush_attempts = flush_attempts.saturating_add(1);
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                break Err(recapture_failure(
                    "capture.flush",
                    "production capture did not reach healthy quiescence before the timeout",
                ));
            }
            let response = tokio::time::timeout(
                remaining,
                transport.call(
                    RequestContext::unbounded(),
                    recapture_request(request_id, "capture.flush", Some(handle.clone()), json!({})),
                ),
            )
            .await
            .map_err(|_| {
                recapture_failure(
                    "capture.flush",
                    "production capture did not answer before the timeout",
                )
            })
            .and_then(|response| {
                response.map_err(|error| recapture_failure("capture.flush", format!("{error:?}")))
            });
            let response = match response {
                Ok(response) => response,
                Err(error) => break Err(error),
            };
            let settled = response.result["settled"] == json!(true);
            let running = response.result["running"] == json!(true);
            let degraded = response.result["degraded"] == json!(true);
            if settled && running && !degraded {
                break Ok(());
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        };

        request_id = request_id.saturating_add(1);
        let close_result = transport
            .call(
                RequestContext::unbounded(),
                recapture_request(request_id, "workspace.close", Some(handle), json!({})),
            )
            .await
            .map_err(|error| recapture_failure("workspace.close", format!("{error:?}")));
        flush_result?;
        close_result?;
        Ok(RecaptureRun { flush_attempts })
    })
}

fn recapture_request(
    id: u64,
    method: &str,
    workspace: Option<WorkspaceHandle>,
    params: Value,
) -> Request {
    Request {
        id,
        method: method.to_owned(),
        workspace,
        deadline_ms: None,
        idempotency_key: None,
        params,
    }
}

fn compare_recapture(
    clone_root: &Path,
    expected: &BTreeMap<String, InventoryState>,
    flush_attempts: usize,
) -> Result<RecaptureEvidence, HarnessError> {
    let db = clone_root
        .join(ENGINE_STORAGE_SEGMENT)
        .join("engine")
        .join("engine.db");
    let mut store = EngineStore::open(&db, unix_now_ms()?)?;
    let seeds = capture_manifest_seed(&store, RECAPTURE_WORKSPACE_ID, RECAPTURE_VERSION_ID)
        .map_err(|error| {
            recapture_failure("read capture-owned projection", format!("{error:?}"))
        })?;

    let needs_secret_key = seeds
        .iter()
        .any(|entry| entry.sha256 == SECRET_SEED_SENTINEL_SHA);
    let secret_key = if needs_secret_key {
        Some(
            dohc_engine_crypto::load_key_file(clone_root)
                .map_err(|error| recapture_failure("load recapture secret key", error))?
                .ok_or_else(|| {
                    recapture_failure(
                        "load recapture secret key",
                        "captured secret rows exist without a key file",
                    )
                })?,
        )
    } else {
        None
    };

    let mut actual = BTreeMap::new();
    for seed in seeds {
        let secret = seed.sha256 == SECRET_SEED_SENTINEL_SHA;
        let sha256 = if secret {
            let plaintext = SecretFileStore::new(
                &mut store,
                secret_key
                    .as_ref()
                    .expect("secret seed requires a loaded key"),
            )
            .materialize_secret_file(RECAPTURE_WORKSPACE_ID, RECAPTURE_VERSION_ID, &seed.path)
            .map_err(|error| recapture_failure("decrypt recaptured secret", format!("{error:?}")))?
            .ok_or_else(|| {
                recapture_failure(
                    "decrypt recaptured secret",
                    format!("capture manifest named a missing secret path {}", seed.path),
                )
            })?;
            sha256_bytes(plaintext.as_bytes())
        } else {
            seed.sha256
        };
        let previous = actual.insert(
            seed.path.clone(),
            InventoryState {
                size_bytes: seed.size,
                sha256,
                storage_kind: if secret { "secret" } else { "content" },
                secret,
            },
        );
        if previous.is_some() {
            return Err(recapture_failure(
                "read capture-owned projection",
                format!("duplicate recaptured path {}", seed.path),
            ));
        }
    }

    let (records_recaptured, unsettled_projections): (i64, i64) = store
        .read_with(|connection| {
            let ordinary: i64 = connection.query_row(
                "SELECT COUNT(*) FROM moments \
                 WHERE workspace_id = ?1 AND version_id = ?2 \
                   AND metadata_origin = 'capture'",
                [RECAPTURE_WORKSPACE_ID, RECAPTURE_VERSION_ID],
                |row| row.get(0),
            )?;
            let secrets: i64 = connection.query_row(
                "SELECT COUNT(*) FROM secret_moments \
                 WHERE workspace_id = ?1 AND version_id = ?2 AND capture_owned = 1",
                [RECAPTURE_WORKSPACE_ID, RECAPTURE_VERSION_ID],
                |row| row.get(0),
            )?;
            let unsettled: i64 = connection.query_row(
                "SELECT COUNT(*) FROM materialization_jobs WHERE status <> 'complete'",
                [],
                |row| row.get(0),
            )?;
            Ok::<_, rusqlite::Error>((ordinary.saturating_add(secrets), unsettled))
        })
        .map_err(|error| recapture_failure("count recapture records", error))?;
    drop(store);

    let mut mismatches = Vec::new();
    let mut content_identities_verified = 0_usize;
    for (path, expected_state) in expected {
        match actual.get(path) {
            None => mismatches.push(recapture_mismatch(
                path,
                vec!["missing from fresh store".to_owned()],
                Some(expected_state),
                None,
            )),
            Some(actual_state) => {
                let mut reasons = Vec::new();
                if expected_state.size_bytes != actual_state.size_bytes {
                    reasons.push("byte count differs".to_owned());
                }
                if expected_state.sha256 != actual_state.sha256 {
                    reasons.push("sha256 differs".to_owned());
                }
                if expected_state.secret != actual_state.secret {
                    reasons.push("storage kind differs".to_owned());
                }
                if reasons.is_empty() {
                    content_identities_verified = content_identities_verified.saturating_add(1);
                } else {
                    mismatches.push(recapture_mismatch(
                        path,
                        reasons,
                        Some(expected_state),
                        Some(actual_state),
                    ));
                }
            }
        }
    }
    for (path, actual_state) in &actual {
        if !expected.contains_key(path) {
            mismatches.push(recapture_mismatch(
                path,
                vec!["unexpected capture-owned path".to_owned()],
                None,
                Some(actual_state),
            ));
        }
    }

    let records_recaptured = usize::try_from(records_recaptured).unwrap_or(usize::MAX);
    let projections_settled = unsettled_projections == 0;
    if records_recaptured != expected.len() {
        mismatches.push(RecaptureMismatch {
            path: "<record-count>".to_owned(),
            reasons: vec![format!(
                "expected {} capture records, found {records_recaptured}",
                expected.len()
            )],
            expected: None,
            recaptured: None,
        });
    }
    if !projections_settled {
        mismatches.push(RecaptureMismatch {
            path: "<projection-state>".to_owned(),
            reasons: vec![format!(
                "{unsettled_projections} materialization projection(s) are not complete"
            )],
            expected: None,
            recaptured: None,
        });
    }
    let verdict = if mismatches.is_empty()
        && actual.len() == expected.len()
        && records_recaptured == expected.len()
        && content_identities_verified == expected.len()
        && projections_settled
    {
        RecaptureVerdict::Complete
    } else {
        RecaptureVerdict::Incomplete
    };
    Ok(RecaptureEvidence {
        paths_expected: expected.len(),
        paths_recaptured: actual.len(),
        records_expected: expected.len(),
        records_recaptured,
        content_identities_verified,
        flush_attempts,
        mismatches,
        projections_settled,
        verdict,
    })
}

fn recapture_mismatch(
    path: &str,
    reasons: Vec<String>,
    expected: Option<&InventoryState>,
    actual: Option<&InventoryState>,
) -> RecaptureMismatch {
    let secret =
        expected.is_some_and(|state| state.secret) || actual.is_some_and(|state| state.secret);
    RecaptureMismatch {
        path: path.to_owned(),
        reasons,
        expected: expected.map(|state| recapture_inventory_state(state, secret)),
        recaptured: actual.map(|state| recapture_inventory_state(state, secret)),
    }
}

fn recapture_inventory_state(state: &InventoryState, redact_sha: bool) -> RecaptureInventoryState {
    RecaptureInventoryState {
        size_bytes: state.size_bytes,
        sha256: if redact_sha {
            "<redacted-secret-sha256; compared in memory>".to_owned()
        } else {
            state.sha256.clone()
        },
        storage_kind: state.storage_kind.to_owned(),
    }
}

fn recapture_failure(stage: &'static str, detail: impl ToString) -> HarnessError {
    HarnessError::RecapturePipeline {
        stage,
        detail: detail.to_string(),
    }
}

fn validate_paths(config: HarnessConfig<'_>) -> Result<(PathBuf, PathBuf, PathBuf), HarnessError> {
    let source = canonicalize(config.source, "canonicalize source workspace")?;
    let source_meta = symlink_metadata(&source, "inspect source workspace")?;
    if !source_meta.is_dir() {
        return Err(HarnessError::SourceDohcMissing);
    }
    let dohc = source.join(".dohc");
    let dohc_meta = match std::fs::symlink_metadata(&dohc) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(HarnessError::SourceDohcMissing);
        }
        Err(source) => {
            return Err(HarnessError::Io {
                operation: "inspect source .dohc directory",
                source,
            });
        }
    };
    if !dohc_meta.is_dir() || metadata_is_traversal_alias(&dohc_meta) {
        return Err(HarnessError::SourceDohcMissing);
    }

    let scratch = resolve_intended(config.scratch)?;
    let recovery = resolve_intended(config.recovery)?;
    ensure_outside(&source, &scratch, "scratch")?;
    ensure_outside(&source, &recovery, "recovery")?;
    ensure_disjoint(&scratch, &recovery)?;
    Ok((source, scratch, recovery))
}

fn ensure_outside(
    source: &Path,
    candidate: &Path,
    which: &'static str,
) -> Result<(), HarnessError> {
    if is_within(candidate, source) {
        return Err(HarnessError::PathInsideSource { which });
    }
    Ok(())
}

fn ensure_disjoint(scratch: &Path, recovery: &Path) -> Result<(), HarnessError> {
    if is_within(scratch, recovery) || is_within(recovery, scratch) {
        return Err(HarnessError::ScratchRecoveryOverlap);
    }
    Ok(())
}

fn prepare_clone(clone_path: &Path, now_ms: i64) -> Result<PreparedClone, HarnessError> {
    let engine = clone_path.join(".dohc").join("engine");
    create_dir_all(&engine, "create clone engine directory")?;
    let retention = engine.join(TYPESCRIPT_STORE_DIR);
    if std::fs::symlink_metadata(&retention).is_ok() {
        return Err(HarnessError::RetentionDirectoryExists);
    }

    let mut present = Vec::new();
    for name in SQLITE_SOURCE_FILES {
        let source = engine.join(name);
        match std::fs::symlink_metadata(&source) {
            Ok(metadata) if metadata.file_type().is_file() => present.push((name, source)),
            Ok(_) => {
                return Err(HarnessError::UnsupportedEntry {
                    path: display_path(&source),
                });
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(source) => {
                return Err(HarnessError::Io {
                    operation: "inspect cloned TypeScript store",
                    source,
                });
            }
        }
    }
    let mut preserved_store = Vec::new();
    if !present.is_empty() {
        create_dir(&retention, "create TypeScript-store retention directory")?;
        for (name, source) in present {
            let destination = retention.join(name);
            std::fs::rename(&source, &destination).map_err(|source| HarnessError::Io {
                operation: "retain cloned TypeScript store",
                source,
            })?;
            let (sha256, size_bytes) = hash_file(&destination)?;
            preserved_store.push(PreservedSourceStoreEntry {
                original_relative_path: format!(".dohc/engine/{name}"),
                retained_relative_path: format!(".dohc/engine/{TYPESCRIPT_STORE_DIR}/{name}"),
                size_bytes,
                sha256,
            });
        }
    }

    let shadow_token = issue_token()?;
    let rehearsal_token = issue_token()?;
    write_shadow_marker_for_harness(clone_path, &shadow_token)?;
    write_rehearsal_token_for_harness(clone_path, &rehearsal_token)?;
    let validated = validate_rehearsal_root(clone_path)?;
    if validated.shadow_token != shadow_token || validated.rehearsal_token != rehearsal_token {
        return Err(HarnessError::IncompleteOutcome(
            "marker round-trip validation mismatch".to_owned(),
        ));
    }

    let db = engine.join("engine.db");
    let mut store = EngineStore::open(&db, now_ms)?;
    if !store.bind_shadow_clone_token(&shadow_token)? {
        return Err(HarnessError::ShadowBindingRefused);
    }
    drop(store);

    Ok(PreparedClone { preserved_store })
}

fn issue_token() -> Result<String, HarnessError> {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes).map_err(|_| HarnessError::RandomToken)?;
    Ok(to_hex(&bytes))
}

fn clone_tree(source: &Path, destination: &Path) -> Result<CloneTreeResult, HarnessError> {
    create_private_dir(destination, "create private clone root")?;
    let source_metadata = symlink_metadata(source, "inspect source root during clone")?;
    let source_identity = traversal_identity(source, &source_metadata)?;
    let mut skipped_roots = Vec::new();
    let mut hard_links = new_hard_link_evidence();
    clone_directory(
        source,
        source,
        destination,
        source_identity,
        &mut skipped_roots,
        &mut hard_links,
    )?;
    Ok(CloneTreeResult {
        floor_skips: summarize_floor_skips(skipped_roots),
        hard_links,
    })
}

fn clone_directory(
    source_root: &Path,
    source: &Path,
    destination: &Path,
    source_identity: TraversalIdentity,
    skipped_roots: &mut Vec<FloorSkippedRoot>,
    hard_links: &mut HardLinkEvidence,
) -> Result<(), HarnessError> {
    let metadata = symlink_metadata(source, "inspect source directory during clone")?;
    if !metadata.is_dir()
        || metadata_is_traversal_alias(&metadata)
        || traversal_identity_crosses_root(source_identity, traversal_identity(source, &metadata)?)
    {
        return Err(HarnessError::UnsupportedEntry {
            path: display_path(source),
        });
    }
    let mut entries = read_dir_sorted(source)?;
    for entry in entries.drain(..) {
        let source_path = entry.path();
        let destination_path = destination.join(entry.file_name());
        let metadata = symlink_metadata(&source_path, "inspect source entry during clone")?;
        if traversal_identity_crosses_root(
            source_identity,
            traversal_identity(&source_path, &metadata)?,
        ) {
            return Err(HarnessError::UnsupportedEntry {
                path: display_path(&source_path),
            });
        }
        let relative_path =
            portable_relative(source_path.strip_prefix(source_root).map_err(|_| {
                HarnessError::IncompleteOutcome("clone path escaped source root".to_owned())
            })?)?;
        if is_floor_excluded_directory_name(&entry.file_name(), &metadata) {
            skipped_roots.push(floor_skipped_root(source_root, &source_path, &metadata)?);
            continue;
        }
        if metadata_is_traversal_alias(&metadata) {
            return Err(HarnessError::UnsupportedEntry {
                path: display_path(&source_path),
            });
        }
        if metadata.is_dir() {
            create_dir(&destination_path, "create cloned directory")?;
            clone_directory(
                source_root,
                &source_path,
                &destination_path,
                source_identity,
                skipped_roots,
                hard_links,
            )?;
        } else if metadata.is_file() {
            if is_floor_excluded_file(&relative_path) {
                skipped_roots.push(floor_skipped_root(source_root, &source_path, &metadata)?);
                continue;
            }
            let topology = metadata_hard_link_topology(&source_path, &metadata)?;
            if topology.link_count > 1 {
                let Some(twin_paths) = topology.twin_paths else {
                    // Unix nlink exposes the existence of aliases but not their paths.
                    // Without a portable enumerator, containment cannot be proven, so
                    // the rehearsal deliberately keeps failing closed on Unix.
                    return Err(HarnessError::UnsupportedEntry {
                        path: display_path(&source_path),
                    });
                };
                if record_hard_link_topology(
                    source_root,
                    &source_path,
                    &relative_path,
                    topology.link_count,
                    twin_paths,
                    hard_links,
                )? {
                    return Err(HarnessError::UnsupportedEntry {
                        path: display_path(&source_path),
                    });
                }
            }
            std::fs::copy(&source_path, &destination_path).map_err(|source| HarnessError::Io {
                operation: "copy source file into clone",
                source,
            })?;
            preserve_times(&metadata, &destination_path)?;
        } else {
            return Err(HarnessError::UnsupportedEntry {
                path: display_path(&source_path),
            });
        }
    }
    preserve_times(&metadata, destination)
}

fn is_floor_excluded_file(relative_path: &str) -> bool {
    !is_internal_dohc_path(relative_path) && is_excluded_file(relative_path)
}

fn is_internal_dohc_path(relative_path: &str) -> bool {
    relative_path == ENGINE_STORAGE_SEGMENT
        || relative_path.starts_with(&format!("{ENGINE_STORAGE_SEGMENT}/"))
}

fn new_hard_link_evidence() -> HardLinkEvidence {
    HardLinkEvidence {
        clone_semantics: "Hard-linked source files whose twins all resolve inside the source tree are copied byte-for-byte into independent regular files. Outside-source twins, or hard links whose twins cannot be enumerated, are refused before copying.".to_owned(),
        real_cutover_flag: "A complete rehearsal may contain recorded inside-source hard-link twins. Any observed outside-source twin is refused before reset because the real workspace would share file identity beyond the rehearsed source boundary.".to_owned(),
        hard_linked_source_file_count: 0,
        total_link_count: 0,
        total_twin_path_count: 0,
        inside_source_tree_twin_count: 0,
        outside_source_tree_twin_count: 0,
        outside_source_tree_observed: false,
        flagged_observation_for_ice: None,
        file_sample_limit: HARD_LINK_FILE_SAMPLE_LIMIT,
        sampled_file_count: 0,
        omitted_file_count: 0,
        files: Vec::new(),
    }
}

struct SourceHardLinkTopology {
    link_count: u64,
    twin_paths: Option<Vec<PathBuf>>,
}

#[cfg(unix)]
fn metadata_hard_link_topology(
    _path: &Path,
    metadata: &Metadata,
) -> Result<SourceHardLinkTopology, HarnessError> {
    use std::os::unix::fs::MetadataExt as _;
    // POSIX nlink provides only a count. There is no portable API for finding
    // the other directory entries, so callers must fail closed when nlink > 1.
    Ok(SourceHardLinkTopology {
        link_count: metadata.nlink(),
        twin_paths: None,
    })
}

#[cfg(windows)]
fn metadata_hard_link_topology(
    path: &Path,
    _metadata: &Metadata,
) -> Result<SourceHardLinkTopology, HarnessError> {
    let output = std::process::Command::new("fsutil")
        .args(["hardlink", "list"])
        .arg(path)
        .output()
        .map_err(|source| HarnessError::Io {
            operation: "inspect source hard-link topology",
            source,
        })?;
    if !output.status.success() {
        return Err(HarnessError::Io {
            operation: "inspect source hard-link topology",
            source: std::io::Error::other(format!(
                "fsutil returned status {}: {}",
                output.status,
                String::from_utf8_lossy(&output.stderr).trim()
            )),
        });
    }
    let listed_paths = String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(|line| resolve_fsutil_hard_link_path(path, line))
        .collect::<Result<Vec<_>, _>>()?;
    if listed_paths.is_empty() {
        return Err(hard_link_topology_error(
            "fsutil returned no paths for a regular file",
        ));
    }
    let resolved_source = canonicalize(path, "resolve source hard-link path")?;
    let source_occurrences = listed_paths
        .iter()
        .filter(|listed| same_path(listed, &resolved_source))
        .count();
    if source_occurrences != 1 {
        return Err(hard_link_topology_error(format!(
            "fsutil returned the inspected path {source_occurrences} times"
        )));
    }
    let link_count = u64::try_from(listed_paths.len())
        .map_err(|_| hard_link_topology_error("hard-link path count overflow"))?;
    let twin_paths = listed_paths
        .into_iter()
        .filter(|listed| !same_path(listed, &resolved_source))
        .collect();
    Ok(SourceHardLinkTopology {
        link_count,
        twin_paths: Some(twin_paths),
    })
}

#[cfg(windows)]
fn resolve_fsutil_hard_link_path(path: &Path, listed: &str) -> Result<PathBuf, HarnessError> {
    let listed_path = Path::new(listed);
    let unresolved = if matches!(listed_path.components().next(), Some(Component::Prefix(_))) {
        listed_path.to_path_buf()
    } else {
        let volume_root = path
            .ancestors()
            .last()
            .ok_or_else(|| hard_link_topology_error("source file has no volume root"))?;
        volume_root.join(listed.trim_start_matches(['\\', '/']))
    };
    canonicalize(&unresolved, "resolve enumerated hard-link path")
}

#[cfg(windows)]
fn hard_link_topology_error(detail: impl ToString) -> HarnessError {
    HarnessError::Io {
        operation: "inspect source hard-link topology",
        source: std::io::Error::other(detail.to_string()),
    }
}

// Only the Windows topology probe compares enumerated twin paths; Unix has no
// portable enumerator and fails closed instead, so this is dead code there.
#[cfg(windows)]
fn same_path(left: &Path, right: &Path) -> bool {
    comparable_components(left) == comparable_components(right)
}

fn record_hard_link_topology(
    source_root: &Path,
    source_path: &Path,
    relative_path: &str,
    link_count: u64,
    twin_paths: Vec<PathBuf>,
    evidence: &mut HardLinkEvidence,
) -> Result<bool, HarnessError> {
    let resolved_source_root = canonicalize(source_root, "resolve hard-link source root")?;
    let expected_twin_count = link_count
        .checked_sub(1)
        .and_then(|count| usize::try_from(count).ok())
        .ok_or_else(|| {
            HarnessError::IncompleteOutcome("hard-link twin count overflow".to_owned())
        })?;
    if twin_paths.len() != expected_twin_count {
        return Err(HarnessError::IncompleteOutcome(format!(
            "hard-link topology for {} listed {} twins for link count {link_count}",
            display_path(source_path),
            twin_paths.len()
        )));
    }

    let twin_paths = twin_paths
        .into_iter()
        .map(|resolved_path| {
            let location = if is_within(&resolved_path, &resolved_source_root) {
                HardLinkTwinLocation::InsideSourceTree
            } else {
                HardLinkTwinLocation::OutsideSourceTree
            };
            HardLinkTwinSample {
                resolved_path: Some(display_path(&resolved_path)),
                location,
            }
        })
        .collect::<Vec<_>>();
    let inside_count = twin_paths
        .iter()
        .filter(|twin| twin.location == HardLinkTwinLocation::InsideSourceTree)
        .count();
    let outside_count = twin_paths.len() - inside_count;

    evidence.hard_linked_source_file_count += 1;
    evidence.total_link_count = evidence
        .total_link_count
        .checked_add(link_count)
        .ok_or_else(|| {
            HarnessError::IncompleteOutcome("aggregate hard-link count overflow".to_owned())
        })?;
    evidence.total_twin_path_count += twin_paths.len();
    evidence.inside_source_tree_twin_count += inside_count;
    evidence.outside_source_tree_twin_count += outside_count;
    if outside_count > 0 {
        evidence.outside_source_tree_observed = true;
        evidence.flagged_observation_for_ice = Some(
            "Refused: at least one hard-link twin resolved outside the source tree, so the rehearsal could not prove the real reset boundary was self-contained.".to_owned(),
        );
    }

    if evidence.files.len() < HARD_LINK_FILE_SAMPLE_LIMIT {
        let sampled_twin_path_count = twin_paths.len().min(HARD_LINK_TWIN_PATH_SAMPLE_LIMIT);
        evidence.files.push(HardLinkedSourceFile {
            relative_path: relative_path.to_owned(),
            link_count,
            twin_path_count: twin_paths.len(),
            inside_source_tree_twin_count: inside_count,
            outside_source_tree_twin_count: outside_count,
            sampled_twin_path_count,
            omitted_twin_path_count: twin_paths.len() - sampled_twin_path_count,
            twin_path_sample_limit: HARD_LINK_TWIN_PATH_SAMPLE_LIMIT,
            twin_paths: twin_paths
                .into_iter()
                .take(HARD_LINK_TWIN_PATH_SAMPLE_LIMIT)
                .collect(),
        });
        evidence.sampled_file_count = evidence.files.len();
    } else {
        evidence.omitted_file_count += 1;
    }

    Ok(outside_count > 0)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct TraversalIdentity {
    device_id: Option<u64>,
    mount_id: Option<u64>,
}

fn traversal_identity_crosses_root(root: TraversalIdentity, candidate: TraversalIdentity) -> bool {
    root.device_id
        .zip(candidate.device_id)
        .is_some_and(|(root, candidate)| root != candidate)
        || root
            .mount_id
            .zip(candidate.mount_id)
            .is_some_and(|(root, candidate)| root != candidate)
}

#[cfg(windows)]
fn traversal_identity(
    _path: &Path,
    _metadata: &Metadata,
) -> Result<TraversalIdentity, HarnessError> {
    Ok(TraversalIdentity {
        device_id: None,
        mount_id: None,
    })
}

#[cfg(unix)]
fn traversal_identity(path: &Path, metadata: &Metadata) -> Result<TraversalIdentity, HarnessError> {
    use std::os::unix::fs::MetadataExt as _;

    #[cfg(target_os = "linux")]
    let mount_id = Some(linux_mount_id(path)?);
    #[cfg(not(target_os = "linux"))]
    let mount_id = {
        // Only Linux resolves a mount id (from /proc/self/mountinfo); every other
        // unix identifies the mount by st_dev alone. Bind the parameter so the
        // signature stays uniform without tripping -D warnings off Linux -- which
        // is a macOS-only failure the Windows gate cannot see and Linux CI cannot
        // reproduce, because Linux genuinely uses it.
        let _ = path;
        None
    };

    Ok(TraversalIdentity {
        device_id: Some(metadata.dev()),
        mount_id,
    })
}

#[cfg(target_os = "linux")]
fn linux_mount_id(path: &Path) -> Result<u64, HarnessError> {
    let mountinfo = std::fs::read("/proc/self/mountinfo").map_err(|source| HarnessError::Io {
        operation: "inspect source mount identity",
        source,
    })?;
    linux_mount_id_from_mountinfo(path, &mountinfo)
}

#[cfg(target_os = "linux")]
fn linux_mount_id_from_mountinfo(path: &Path, mountinfo: &[u8]) -> Result<u64, HarnessError> {
    use std::os::unix::ffi::OsStringExt as _;

    let mut containing_mount = None::<(usize, u64)>;
    for line in mountinfo.split(|byte| *byte == b'\n') {
        let fields = line
            .split(|byte| byte.is_ascii_whitespace())
            .filter(|field| !field.is_empty())
            .collect::<Vec<_>>();
        if fields.len() < 5 {
            continue;
        }
        let mount_id = std::str::from_utf8(fields[0])
            .ok()
            .and_then(|value| value.parse::<u64>().ok())
            .ok_or_else(|| HarnessError::Io {
                operation: "inspect source mount identity",
                source: std::io::Error::other("mountinfo contains an invalid mount ID"),
            })?;
        let mount_path = PathBuf::from(OsString::from_vec(decode_mountinfo_field(fields[4])?));
        if path.starts_with(&mount_path) {
            let depth = mount_path.components().count();
            if containing_mount.is_none_or(|(current_depth, _)| depth > current_depth) {
                containing_mount = Some((depth, mount_id));
            }
        }
    }
    containing_mount
        .map(|(_, mount_id)| mount_id)
        .ok_or_else(|| HarnessError::Io {
            operation: "inspect source mount identity",
            source: std::io::Error::other("mountinfo does not contain the source path"),
        })
}

#[cfg(target_os = "linux")]
fn decode_mountinfo_field(field: &[u8]) -> Result<Vec<u8>, HarnessError> {
    let mut decoded = Vec::with_capacity(field.len());
    let mut index = 0;
    while index < field.len() {
        if field[index] != b'\\' {
            decoded.push(field[index]);
            index += 1;
            continue;
        }
        let digits = field
            .get(index + 1..index + 4)
            .filter(|digits| digits.iter().all(|digit| matches!(digit, b'0'..=b'7')))
            .ok_or_else(|| HarnessError::Io {
                operation: "inspect source mount identity",
                source: std::io::Error::other("mountinfo contains an invalid path escape"),
            })?;
        let value = digits
            .iter()
            .fold(0_u8, |value, digit| (value << 3) | (digit - b'0'));
        decoded.push(value);
        index += 4;
    }
    Ok(decoded)
}

#[cfg(windows)]
fn metadata_is_traversal_alias(metadata: &Metadata) -> bool {
    use std::os::windows::fs::MetadataExt as _;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    metadata.file_type().is_symlink()
        || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn metadata_is_traversal_alias(metadata: &Metadata) -> bool {
    metadata.file_type().is_symlink()
}

fn is_floor_excluded_directory_name(name: &OsStr, metadata: &Metadata) -> bool {
    if !metadata.is_dir() && !metadata_is_traversal_alias(metadata) {
        return false;
    }
    let Some(name) = name.to_str() else {
        return false;
    };
    let normalized = normalize_segment(name);
    normalized != ENGINE_STORAGE_SEGMENT
        && (RESERVED_SEGMENTS.contains(&normalized.as_str())
            || IGNORED_FILE_PREFIXES
                .iter()
                .any(|prefix| normalized.starts_with(prefix)))
}

fn preserve_times(metadata: &Metadata, destination: &Path) -> Result<(), HarnessError> {
    filetime::set_file_times(
        destination,
        FileTime::from_last_access_time(metadata),
        FileTime::from_last_modification_time(metadata),
    )
    .map_err(|source| HarnessError::Io {
        operation: "preserve cloned entry timestamps",
        source,
    })
}

fn snapshot_tree(root: &Path) -> Result<TreeSnapshot, HarnessError> {
    let metadata = symlink_metadata(root, "inspect snapshot root")?;
    if !metadata.is_dir() || metadata_is_traversal_alias(&metadata) {
        return Err(HarnessError::UnsupportedEntry {
            path: display_path(root),
        });
    }
    let root_identity = traversal_identity(root, &metadata)?;
    let mut entries = Vec::new();
    snapshot_entry(root, root, &metadata, &mut entries)?;
    snapshot_directory(root, root, root_identity, &mut entries)?;
    let summary = summarize(&entries);
    Ok(TreeSnapshot { entries, summary })
}

fn snapshot_source_tree(root: &Path) -> Result<TreeSnapshot, HarnessError> {
    let metadata = symlink_metadata(root, "inspect source snapshot root")?;
    if !metadata.is_dir() || metadata_is_traversal_alias(&metadata) {
        return Err(HarnessError::UnsupportedEntry {
            path: display_path(root),
        });
    }
    let root_identity = traversal_identity(root, &metadata)?;
    let mut entries = Vec::new();
    snapshot_entry(root, root, &metadata, &mut entries)?;
    snapshot_source_directory(root, root, root_identity, &mut entries)?;
    let summary = summarize(&entries);
    Ok(TreeSnapshot { entries, summary })
}

fn snapshot_source_directory(
    root: &Path,
    directory: &Path,
    root_identity: TraversalIdentity,
    output: &mut Vec<TreeEntry>,
) -> Result<(), HarnessError> {
    for entry in read_dir_sorted(directory)? {
        let path = entry.path();
        let metadata = symlink_metadata(&path, "inspect source snapshot entry")?;
        if traversal_identity_crosses_root(root_identity, traversal_identity(&path, &metadata)?) {
            return Err(HarnessError::UnsupportedEntry {
                path: display_path(&path),
            });
        }
        if is_floor_excluded_directory_name(&entry.file_name(), &metadata) {
            snapshot_floor_skipped_root(root, &path, &metadata, output)?;
            continue;
        }
        if metadata.is_file() {
            let relative_path = portable_relative(path.strip_prefix(root).map_err(|_| {
                HarnessError::IncompleteOutcome(
                    "source snapshot path escaped source root".to_owned(),
                )
            })?)?;
            if is_floor_excluded_file(&relative_path) {
                snapshot_floor_skipped_root(root, &path, &metadata, output)?;
                continue;
            }
        }
        snapshot_entry(root, &path, &metadata, output)?;
        if metadata.is_dir() {
            snapshot_source_directory(root, &path, root_identity, output)?;
        }
    }
    Ok(())
}

fn snapshot_directory(
    root: &Path,
    directory: &Path,
    root_identity: TraversalIdentity,
    output: &mut Vec<TreeEntry>,
) -> Result<(), HarnessError> {
    for entry in read_dir_sorted(directory)? {
        let path = entry.path();
        let metadata = symlink_metadata(&path, "inspect snapshot entry")?;
        if traversal_identity_crosses_root(root_identity, traversal_identity(&path, &metadata)?) {
            return Err(HarnessError::UnsupportedEntry {
                path: display_path(&path),
            });
        }
        snapshot_entry(root, &path, &metadata, output)?;
        if metadata.is_dir() {
            snapshot_directory(root, &path, root_identity, output)?;
        }
    }
    Ok(())
}

fn snapshot_entry(
    root: &Path,
    path: &Path,
    metadata: &Metadata,
    output: &mut Vec<TreeEntry>,
) -> Result<(), HarnessError> {
    if metadata_is_traversal_alias(metadata) {
        return Err(HarnessError::UnsupportedEntry {
            path: display_path(path),
        });
    }
    let modified = FileTime::from_last_modification_time(metadata);
    let relative_path = if path == root {
        ".".to_owned()
    } else {
        portable_relative(path.strip_prefix(root).map_err(|_| {
            HarnessError::IncompleteOutcome("snapshot path escaped root".to_owned())
        })?)?
    };
    if metadata.is_dir() {
        output.push(TreeEntry {
            relative_path,
            kind: EntryKind::Directory,
            size_bytes: 0,
            contained_file_count: 0,
            modified_seconds: modified.unix_seconds(),
            modified_nanoseconds: modified.nanoseconds(),
            sha256: String::new(),
        });
    } else if metadata.is_file() {
        let (sha256, size_bytes) = hash_file(path)?;
        output.push(TreeEntry {
            relative_path,
            kind: EntryKind::File,
            size_bytes,
            contained_file_count: 1,
            modified_seconds: modified.unix_seconds(),
            modified_nanoseconds: modified.nanoseconds(),
            sha256,
        });
    } else {
        return Err(HarnessError::UnsupportedEntry {
            path: display_path(path),
        });
    }
    Ok(())
}

fn snapshot_floor_skipped_root(
    root: &Path,
    path: &Path,
    metadata: &Metadata,
    output: &mut Vec<TreeEntry>,
) -> Result<(), HarnessError> {
    let modified = FileTime::from_last_modification_time(metadata);
    let relative_path = portable_relative(path.strip_prefix(root).map_err(|_| {
        HarnessError::IncompleteOutcome("source snapshot path escaped root".to_owned())
    })?)?;
    let proof = skipped_content_proof(path, metadata)?;
    output.push(TreeEntry {
        relative_path,
        kind: if metadata_is_traversal_alias(metadata) {
            EntryKind::FloorSkippedAlias
        } else if metadata.is_file() {
            EntryKind::FloorSkippedFile
        } else {
            EntryKind::FloorSkippedDirectory
        },
        size_bytes: proof.total_file_bytes,
        contained_file_count: proof.file_count,
        modified_seconds: modified.unix_seconds(),
        modified_nanoseconds: modified.nanoseconds(),
        sha256: proof.sha256,
    });
    Ok(())
}

struct SkippedContentProof {
    sha256: String,
    file_count: usize,
    total_file_bytes: u64,
}

fn skipped_content_proof(
    path: &Path,
    metadata: &Metadata,
) -> Result<SkippedContentProof, HarnessError> {
    let root_identity = traversal_identity(path, metadata)?;
    let mut hasher = Sha256::new();
    let mut file_count = 0_usize;
    let mut total_file_bytes = 0_u64;
    hash_skipped_content(
        path,
        path,
        metadata,
        root_identity,
        &mut hasher,
        &mut file_count,
        &mut total_file_bytes,
    )?;
    Ok(SkippedContentProof {
        sha256: to_hex(&hasher.finalize()),
        file_count,
        total_file_bytes,
    })
}

fn hash_skipped_content(
    root: &Path,
    path: &Path,
    metadata: &Metadata,
    root_identity: TraversalIdentity,
    hasher: &mut Sha256,
    file_count: &mut usize,
    total_file_bytes: &mut u64,
) -> Result<(), HarnessError> {
    let relative = if path == root {
        ".".to_owned()
    } else {
        portable_relative(path.strip_prefix(root).map_err(|_| {
            HarnessError::IncompleteOutcome("floor-skipped proof path escaped its root".to_owned())
        })?)?
    };
    let modified = FileTime::from_last_modification_time(metadata);
    hash_field(hasher, relative.as_bytes());
    hasher.update(modified.unix_seconds().to_le_bytes());
    hasher.update(modified.nanoseconds().to_le_bytes());

    if metadata_is_traversal_alias(metadata) {
        hasher.update(b"a");
        let target = std::fs::read_link(path).map_err(|source| HarnessError::Io {
            operation: "read floor-skipped alias target",
            source,
        })?;
        hash_os_str(hasher, target.as_os_str());
        return Ok(());
    }
    if metadata.is_file() {
        hasher.update(b"f");
        let (sha256, size_bytes) = hash_file(path)?;
        hasher.update(size_bytes.to_le_bytes());
        hash_field(hasher, sha256.as_bytes());
        *file_count = file_count.saturating_add(1);
        *total_file_bytes = total_file_bytes.saturating_add(size_bytes);
        return Ok(());
    }
    if metadata.is_dir() {
        hasher.update(b"d");
        for entry in read_dir_sorted(path)? {
            let child = entry.path();
            let child_metadata = symlink_metadata(&child, "inspect floor-skipped proof entry")?;
            if traversal_identity_crosses_root(
                root_identity,
                traversal_identity(&child, &child_metadata)?,
            ) {
                return Err(HarnessError::UnsupportedEntry {
                    path: display_path(&child),
                });
            }
            hash_skipped_content(
                root,
                &child,
                &child_metadata,
                root_identity,
                hasher,
                file_count,
                total_file_bytes,
            )?;
        }
        return Ok(());
    }
    Err(HarnessError::UnsupportedEntry {
        path: display_path(path),
    })
}

#[cfg(unix)]
fn hash_os_str(hasher: &mut Sha256, value: &OsStr) {
    use std::os::unix::ffi::OsStrExt as _;
    hash_field(hasher, value.as_bytes());
}

#[cfg(windows)]
fn hash_os_str(hasher: &mut Sha256, value: &OsStr) {
    use std::os::windows::ffi::OsStrExt as _;
    let mut bytes = Vec::new();
    for unit in value.encode_wide() {
        bytes.extend_from_slice(&unit.to_le_bytes());
    }
    hash_field(hasher, &bytes);
}

fn summarize(entries: &[TreeEntry]) -> TreeSummary {
    let mut hasher = Sha256::new();
    let mut directory_count = 0;
    let mut file_count = 0;
    let mut total_file_bytes = 0_u64;
    for entry in entries {
        match entry.kind {
            EntryKind::Directory => {
                directory_count += 1;
                hasher.update(b"d");
            }
            EntryKind::File => {
                file_count += 1;
                total_file_bytes = total_file_bytes.saturating_add(entry.size_bytes);
                hasher.update(b"f");
            }
            EntryKind::FloorSkippedDirectory => {
                directory_count += 1;
                hasher.update(b"x");
            }
            EntryKind::FloorSkippedAlias => {
                directory_count += 1;
                hasher.update(b"a");
            }
            EntryKind::FloorSkippedFile => {
                file_count += 1;
                total_file_bytes = total_file_bytes.saturating_add(entry.size_bytes);
                hasher.update(b"z");
            }
        }
        hash_field(&mut hasher, entry.relative_path.as_bytes());
        hasher.update(entry.size_bytes.to_le_bytes());
        hasher.update((entry.contained_file_count as u64).to_le_bytes());
        hasher.update(entry.modified_seconds.to_le_bytes());
        hasher.update(entry.modified_nanoseconds.to_le_bytes());
        hash_field(&mut hasher, entry.sha256.as_bytes());
    }
    TreeSummary {
        directory_count,
        file_count,
        total_file_bytes,
        snapshot_sha256: to_hex(&hasher.finalize()),
    }
}

fn clone_input_snapshot(source: &TreeSnapshot) -> TreeSnapshot {
    let entries = source
        .entries
        .iter()
        .filter(|entry| {
            !matches!(
                entry.kind,
                EntryKind::FloorSkippedDirectory
                    | EntryKind::FloorSkippedAlias
                    | EntryKind::FloorSkippedFile
            )
        })
        .cloned()
        .collect::<Vec<_>>();
    let summary = summarize(&entries);
    TreeSnapshot { entries, summary }
}

fn floor_skipped_root(
    root: &Path,
    path: &Path,
    metadata: &Metadata,
) -> Result<FloorSkippedRoot, HarnessError> {
    let modified = FileTime::from_last_modification_time(metadata);
    let proof = skipped_content_proof(path, metadata)?;
    Ok(FloorSkippedRoot {
        relative_path: portable_relative(path.strip_prefix(root).map_err(|_| {
            HarnessError::IncompleteOutcome("floor-skipped path escaped source root".to_owned())
        })?)?,
        kind: if metadata_is_traversal_alias(metadata) {
            FloorSkippedRootKind::Alias
        } else if metadata.is_file() {
            FloorSkippedRootKind::File
        } else {
            FloorSkippedRootKind::Directory
        },
        source_root_modified_seconds: modified.unix_seconds(),
        source_root_modified_nanoseconds: modified.nanoseconds(),
        source_content_sha256: proof.sha256,
        source_file_count: proof.file_count,
        source_total_file_bytes: proof.total_file_bytes,
    })
}

fn floor_skip_evidence(snapshot: &TreeSnapshot) -> FloorSkipEvidence {
    let roots = snapshot
        .entries
        .iter()
        .filter_map(|entry| {
            let kind = match entry.kind {
                EntryKind::FloorSkippedDirectory => FloorSkippedRootKind::Directory,
                EntryKind::FloorSkippedAlias => FloorSkippedRootKind::Alias,
                EntryKind::FloorSkippedFile => FloorSkippedRootKind::File,
                EntryKind::Directory | EntryKind::File => return None,
            };
            Some(FloorSkippedRoot {
                relative_path: entry.relative_path.clone(),
                kind,
                source_root_modified_seconds: entry.modified_seconds,
                source_root_modified_nanoseconds: entry.modified_nanoseconds,
                source_content_sha256: entry.sha256.clone(),
                source_file_count: entry.contained_file_count,
                source_total_file_bytes: entry.size_bytes,
            })
        })
        .collect();
    summarize_floor_skips(roots)
}

fn summarize_floor_skips(roots: Vec<FloorSkippedRoot>) -> FloorSkipEvidence {
    let directory_root_count = roots
        .iter()
        .filter(|root| root.kind == FloorSkippedRootKind::Directory)
        .count();
    let alias_root_count = roots
        .iter()
        .filter(|root| root.kind == FloorSkippedRootKind::Alias)
        .count();
    let file_root_count = roots
        .iter()
        .filter(|root| root.kind == FloorSkippedRootKind::File)
        .count();
    FloorSkipEvidence {
        root_count: roots.len(),
        directory_root_count,
        alias_root_count,
        file_root_count,
        roots,
    }
}

fn hash_field(hasher: &mut Sha256, bytes: &[u8]) {
    hasher.update((bytes.len() as u64).to_le_bytes());
    hasher.update(bytes);
}

fn debris_entries(snapshot: &TreeSnapshot) -> Vec<ArtifactEntry> {
    snapshot
        .entries
        .iter()
        .filter(|entry| {
            entry.kind == EntryKind::File
                && entry.relative_path.starts_with(".dohc/")
                && Path::new(&entry.relative_path)
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with("ui-state.json.tmp-"))
        })
        .map(|entry| ArtifactEntry {
            relative_path: entry.relative_path.clone(),
            size_bytes: entry.size_bytes,
            sha256: entry.sha256.clone(),
        })
        .collect()
}

fn artifact_manifest(
    root: &Path,
    skip_root_file: Option<&str>,
) -> Result<Vec<ArtifactEntry>, HarnessError> {
    let snapshot = snapshot_tree(root)?;
    Ok(snapshot
        .entries
        .into_iter()
        .filter(|entry| {
            entry.kind == EntryKind::File
                && skip_root_file.is_none_or(|skip| entry.relative_path != skip)
        })
        .map(|entry| ArtifactEntry {
            relative_path: entry.relative_path,
            size_bytes: entry.size_bytes,
            sha256: entry.sha256,
        })
        .collect())
}

fn write_evidence(root: &Path, evidence: &RehearsalEvidence) -> Result<(), HarnessError> {
    let destination = root.join(EVIDENCE_FILE);
    if std::fs::symlink_metadata(&destination).is_ok() {
        return Err(HarnessError::Io {
            operation: "refuse to overwrite existing rehearsal evidence",
            source: std::io::Error::new(
                std::io::ErrorKind::AlreadyExists,
                "REHEARSAL_EVIDENCE.json already exists",
            ),
        });
    }
    let temp = root.join(format!(".{EVIDENCE_FILE}.{}.tmp", std::process::id()));
    let bytes = serde_json::to_vec_pretty(evidence)?;
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp)
        .map_err(|source| HarnessError::Io {
            operation: "create rehearsal evidence staging file",
            source,
        })?;
    file.write_all(&bytes).map_err(|source| HarnessError::Io {
        operation: "write rehearsal evidence",
        source,
    })?;
    file.write_all(b"\n").map_err(|source| HarnessError::Io {
        operation: "terminate rehearsal evidence",
        source,
    })?;
    file.sync_all().map_err(|source| HarnessError::Io {
        operation: "sync rehearsal evidence",
        source,
    })?;
    drop(file);
    std::fs::rename(&temp, &destination).map_err(|source| HarnessError::Io {
        operation: "publish rehearsal evidence",
        source,
    })?;
    fsync_dir(root)?;
    Ok(())
}

fn hash_file(path: &Path) -> Result<(String, u64), HarnessError> {
    let mut file = File::open(path).map_err(|source| HarnessError::Io {
        operation: "open file for hashing",
        source,
    })?;
    let mut buffer = vec![0_u8; COPY_BUFFER_BYTES];
    let mut hasher = Sha256::new();
    let mut bytes = 0_u64;
    loop {
        let read = file.read(&mut buffer).map_err(|source| HarnessError::Io {
            operation: "read file for hashing",
            source,
        })?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        bytes = bytes.saturating_add(read as u64);
    }
    Ok((to_hex(&hasher.finalize()), bytes))
}

fn sha256_bytes(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    to_hex(&hasher.finalize())
}

fn read_dir_sorted(path: &Path) -> Result<Vec<std::fs::DirEntry>, HarnessError> {
    let entries = std::fs::read_dir(path).map_err(|source| HarnessError::Io {
        operation: "enumerate directory",
        source,
    })?;
    let mut entries = entries
        .map(|entry| {
            entry.map_err(|source| HarnessError::Io {
                operation: "read directory entry",
                source,
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    entries.sort_by_key(std::fs::DirEntry::file_name);
    Ok(entries)
}

fn resolve_intended(path: &Path) -> Result<PathBuf, HarnessError> {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        current_dir()?.join(path)
    };
    let mut cursor = absolute.as_path();
    let mut missing = Vec::<OsString>::new();
    loop {
        match std::fs::canonicalize(cursor) {
            Ok(mut resolved) => {
                for component in missing.iter().rev() {
                    resolved.push(component);
                }
                return Ok(normalize_lexically(&resolved));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let name = cursor.file_name().ok_or(HarnessError::Io {
                    operation: "resolve intended path",
                    source: error,
                })?;
                missing.push(name.to_os_string());
                cursor = cursor.parent().ok_or(HarnessError::Io {
                    operation: "resolve intended path parent",
                    source: std::io::Error::new(
                        std::io::ErrorKind::NotFound,
                        "path has no existing ancestor",
                    ),
                })?;
            }
            Err(source) => {
                return Err(HarnessError::Io {
                    operation: "resolve intended path",
                    source,
                });
            }
        }
    }
}

fn normalize_lexically(path: &Path) -> PathBuf {
    let mut output = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                output.pop();
            }
            other => output.push(other.as_os_str()),
        }
    }
    output
}

fn is_within(candidate: &Path, parent: &Path) -> bool {
    let candidate = comparable_components(candidate);
    let parent = comparable_components(parent);
    candidate.starts_with(&parent)
}

fn comparable_components(path: &Path) -> Vec<String> {
    path.components()
        .map(|component| {
            let text = component.as_os_str().to_string_lossy();
            if cfg!(windows) {
                text.to_lowercase()
            } else {
                text.into_owned()
            }
        })
        .collect()
}

fn portable_relative(path: &Path) -> Result<String, HarnessError> {
    let text = path
        .to_str()
        .ok_or_else(|| HarnessError::UnsupportedEntry {
            path: display_path(path),
        })?;
    Ok(if cfg!(windows) {
        text.replace('\\', "/")
    } else {
        text.to_owned()
    })
}

fn unix_now_ms() -> Result<i64, HarnessError> {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|source| HarnessError::Io {
            operation: "read system clock",
            source: std::io::Error::other(source),
        })?;
    Ok(i64::try_from(duration.as_millis()).unwrap_or(i64::MAX))
}

fn elapsed_ms(started: Instant) -> u64 {
    u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX)
}

fn to_hex(digest: &[u8]) -> String {
    use std::fmt::Write as _;
    let mut output = String::with_capacity(digest.len() * 2);
    for byte in digest {
        let _ = write!(output, "{byte:02x}");
    }
    output
}

fn display_path(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn current_dir() -> Result<PathBuf, HarnessError> {
    std::env::current_dir().map_err(|source| HarnessError::Io {
        operation: "read current directory",
        source,
    })
}

fn canonicalize(path: &Path, operation: &'static str) -> Result<PathBuf, HarnessError> {
    std::fs::canonicalize(path).map_err(|source| HarnessError::Io { operation, source })
}

fn symlink_metadata(path: &Path, operation: &'static str) -> Result<Metadata, HarnessError> {
    std::fs::symlink_metadata(path).map_err(|source| HarnessError::Io { operation, source })
}

fn create_dir(path: &Path, operation: &'static str) -> Result<(), HarnessError> {
    std::fs::create_dir(path).map_err(|source| HarnessError::Io { operation, source })
}

fn create_dir_all(path: &Path, operation: &'static str) -> Result<(), HarnessError> {
    std::fs::create_dir_all(path).map_err(|source| HarnessError::Io { operation, source })
}

fn create_private_dir(path: &Path, operation: &'static str) -> Result<(), HarnessError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::{DirBuilderExt as _, PermissionsExt as _};
        std::fs::DirBuilder::new()
            .mode(0o700)
            .create(path)
            .map_err(|source| HarnessError::Io { operation, source })?;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).map_err(|source| {
            HarnessError::Io {
                operation: "tighten private directory permissions",
                source,
            }
        })
    }
    #[cfg(windows)]
    {
        std::fs::create_dir(path).map_err(|source| HarnessError::Io { operation, source })?;
        restrict_windows_directory_acl(path)
    }
}

fn create_private_dir_all(path: &Path, operation: &'static str) -> Result<(), HarnessError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::{DirBuilderExt as _, PermissionsExt as _};
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(path)
            .map_err(|source| HarnessError::Io { operation, source })?;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).map_err(|source| {
            HarnessError::Io {
                operation: "tighten private directory permissions",
                source,
            }
        })
    }
    #[cfg(windows)]
    {
        std::fs::create_dir_all(path).map_err(|source| HarnessError::Io { operation, source })?;
        restrict_windows_directory_acl(path)
    }
}

#[cfg(windows)]
fn restrict_windows_directory_acl(path: &Path) -> Result<(), HarnessError> {
    let identity = std::process::Command::new("whoami")
        .output()
        .map_err(|source| HarnessError::Io {
            operation: "resolve current Windows identity",
            source,
        })?;
    if !identity.status.success() {
        return Err(HarnessError::Io {
            operation: "resolve current Windows identity",
            source: std::io::Error::other("whoami returned a non-zero status"),
        });
    }
    let principal = String::from_utf8(identity.stdout)
        .map_err(|source| HarnessError::Io {
            operation: "decode current Windows identity",
            source: std::io::Error::new(std::io::ErrorKind::InvalidData, source),
        })?
        .trim()
        .to_owned();
    if principal.is_empty() {
        return Err(HarnessError::Io {
            operation: "resolve current Windows identity",
            source: std::io::Error::other("whoami returned an empty identity"),
        });
    }
    let reset = std::process::Command::new("icacls")
        .arg(path)
        .arg("/reset")
        .output()
        .map_err(|source| HarnessError::Io {
            operation: "reset private Windows directory ACL",
            source,
        })?;
    if !reset.status.success() {
        return Err(HarnessError::Io {
            operation: "reset private Windows directory ACL",
            source: std::io::Error::other(format!(
                "icacls returned status {}: {}",
                reset.status,
                String::from_utf8_lossy(&reset.stderr).trim()
            )),
        });
    }
    let grant = format!("{principal}:(OI)(CI)F");
    let restricted = std::process::Command::new("icacls")
        .arg(path)
        .args(["/inheritance:r", "/grant:r", &grant])
        .output()
        .map_err(|source| HarnessError::Io {
            operation: "tighten private Windows directory ACL",
            source,
        })?;
    if !restricted.status.success() {
        return Err(HarnessError::Io {
            operation: "tighten private Windows directory ACL",
            source: std::io::Error::other(format!(
                "icacls returned status {}: {}",
                restricted.status,
                String::from_utf8_lossy(&restricted.stderr).trim()
            )),
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use dohc_engine_testkit::ScratchDir;

    fn fixture_source() -> ScratchDir {
        let source = ScratchDir::new().expect("source scratch");
        let engine = source.join(".dohc").join("engine");
        std::fs::create_dir_all(&engine).expect("engine directory");
        std::fs::write(engine.join("engine.db"), b"typescript-authored-db").expect("foreign db");
        std::fs::write(source.join(".dohc").join("registry.json"), b"{}").expect("registry");
        std::fs::write(source.join("note.md"), b"dogfood fixture\n").expect("note");
        source
    }

    #[test]
    fn unix_mount_identity_boundary_is_refused_before_traversal() {
        let source = TraversalIdentity {
            device_id: Some(41),
            mount_id: Some(7),
        };
        let bind_mount = TraversalIdentity {
            device_id: Some(41),
            mount_id: Some(8),
        };
        let filesystem_mount = TraversalIdentity {
            device_id: Some(42),
            mount_id: Some(9),
        };

        assert!(
            traversal_identity_crosses_root(source, bind_mount),
            "a bind mount must be refused even when st_dev is unchanged"
        );
        assert!(
            traversal_identity_crosses_root(source, filesystem_mount),
            "a child filesystem mount must be refused when st_dev changes"
        );
        assert!(!traversal_identity_crosses_root(source, source));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_mountinfo_decodes_escaped_paths_and_selects_deepest_mount() {
        let current_dir = std::env::current_dir().expect("current directory");
        assert!(
            linux_mount_id(&current_dir).expect("live mount ID") > 0,
            "the production reader must resolve the current directory from /proc/self/mountinfo"
        );

        let mountinfo = b"10 1 0:1 / / rw - ext4 /dev/root rw\n\
            20 10 0:2 / /tmp/rehearsal\\040mount rw - ext4 /dev/root rw\n\
            30 20 0:3 / /tmp/rehearsal\\040mount/nested rw - ext4 /dev/root rw\n";

        assert_eq!(
            linux_mount_id_from_mountinfo(
                Path::new("/tmp/rehearsal mount/nested/workspace/note.md"),
                mountinfo,
            )
            .expect("mount ID"),
            30,
        );
    }

    #[test]
    fn scratch_and_recovery_inside_source_are_refused_before_creation() {
        let source = fixture_source();
        let outside = ScratchDir::new().expect("outside");
        let scratch_inside = source.join("new-scratch");
        let recovery_inside = source.join("new-recovery");

        let scratch_error = validate_paths(HarnessConfig {
            source: source.path(),
            scratch: &scratch_inside,
            recovery: outside.path(),
        })
        .expect_err("scratch inside source must fail");
        assert!(matches!(
            scratch_error,
            HarnessError::PathInsideSource { which: "scratch" }
        ));
        assert!(!scratch_inside.exists(), "guard must not create the path");

        let recovery_error = validate_paths(HarnessConfig {
            source: source.path(),
            scratch: outside.path(),
            recovery: &recovery_inside,
        })
        .expect_err("recovery inside source must fail");
        assert!(matches!(
            recovery_error,
            HarnessError::PathInsideSource { which: "recovery" }
        ));
        assert!(!recovery_inside.exists(), "guard must not create the path");
    }

    #[test]
    fn source_untouched_assertion_detects_hash_changes() {
        let source = fixture_source();
        let before = snapshot_tree(source.path()).expect("before");
        std::fs::write(source.join("note.md"), b"changed behind harness\n").expect("change");
        let after = snapshot_tree(source.path()).expect("after");
        assert_ne!(before, after);
        assert_ne!(
            before.summary.snapshot_sha256,
            after.summary.snapshot_sha256
        );
    }

    #[test]
    fn issued_markers_round_trip_and_malformed_markers_are_refused() {
        let source = fixture_source();
        let clone = ScratchDir::new().expect("clone");
        snapshot_tree(source.path()).expect("snapshot");
        let shadow = issue_token().expect("shadow token");
        let rehearsal = issue_token().expect("rehearsal token");
        assert_eq!(shadow.len(), 64);
        assert_eq!(rehearsal.len(), 64);
        assert_ne!(shadow, rehearsal);
        assert!(shadow.bytes().all(|byte| byte.is_ascii_hexdigit()));
        assert!(rehearsal.bytes().all(|byte| byte.is_ascii_hexdigit()));

        write_shadow_marker_for_harness(clone.path(), &shadow).expect("shadow marker");
        write_rehearsal_token_for_harness(clone.path(), &rehearsal).expect("rehearsal marker");
        validate_rehearsal_root(clone.path()).expect("valid marker pair");
        std::fs::write(
            clone
                .join(".dohc")
                .join("engine")
                .join("CUTOVER_REHEARSAL_TOKEN"),
            b"not-64-hex",
        )
        .expect("corrupt marker");
        assert!(validate_rehearsal_root(clone.path()).is_err());
    }

    #[test]
    fn real_tree_fixture_completes_and_reports_dohc_debris_without_touching_source() {
        let source = fixture_source();
        for index in 0..17 {
            std::fs::write(
                source
                    .join(".dohc")
                    .join(format!("ui-state.json.tmp-{index}")),
                format!("orphan-{index}"),
            )
            .expect("debris");
        }
        let scratch_parent = ScratchDir::new().expect("scratch parent");
        let recovery_parent = ScratchDir::new().expect("recovery parent");
        let scratch = scratch_parent.join("clones");
        let recovery = recovery_parent.join("artifacts");
        let before = snapshot_tree(source.path()).expect("source before");

        let evidence = run(HarnessConfig {
            source: source.path(),
            scratch: &scratch,
            recovery: &recovery,
        })
        .expect("complete rehearsal");

        assert_eq!(evidence.outcome, "complete");
        assert_eq!(evidence.state_record.current, RehearsalState::Complete);
        assert!(evidence.source_unchanged.verified);
        assert_eq!(evidence.recapture.verdict, RecaptureVerdict::Complete);
        assert_eq!(evidence.recapture.paths_expected, 1);
        assert_eq!(evidence.recapture.paths_recaptured, 1);
        assert_eq!(evidence.recapture.records_recaptured, 1);
        assert_eq!(evidence.recapture.content_identities_verified, 1);
        assert!(evidence.recapture.projections_settled);
        assert!(evidence.recapture.mismatches.is_empty());
        assert_eq!(evidence.ui_state_tmp_orphans.len(), 17);
        assert_eq!(evidence.floor_skips.root_count, 0);
        assert_eq!(
            evidence.source_counts, evidence.initial_byte_clone_counts,
            "mtime-preserving clone must exactly match the source snapshot"
        );
        assert_eq!(snapshot_tree(source.path()).expect("source after"), before);
        assert!(
            recovery.join(EVIDENCE_FILE).is_file(),
            "evidence must be banked outside the clone"
        );
        assert!(
            evidence
                .preserved_typescript_store
                .iter()
                .any(|entry| entry.original_relative_path == ".dohc/engine/engine.db")
        );
        let banked: serde_json::Value = serde_json::from_slice(
            &std::fs::read(recovery.join(EVIDENCE_FILE)).expect("read evidence"),
        )
        .expect("parse evidence");
        assert_eq!(banked["schema_version"], 4);
        assert_eq!(banked["recapture"]["verdict"], "complete");
        assert_eq!(banked["recapture"]["paths_recaptured"], 1);
    }

    #[test]
    fn gate6_orphan_claim_matches_banked_schema4_evidence() {
        let evidence: serde_json::Value = serde_json::from_str(include_str!(
            "../../../docs/superpowers/plans/rust-engine/REHEARSAL_EVIDENCE-2026-07-26.json"
        ))
        .expect("parse banked evidence");
        assert_eq!(evidence["schema_version"], 4);
        let orphan_count = evidence["ui_state_tmp_orphans"]
            .as_array()
            .expect("orphan evidence array")
            .len();
        let packet = include_str!("../../../docs/superpowers/plans/rust-engine/GATE6_PACKET.md");
        let harness = include_str!("../REHEARSAL_HARNESS.md");

        assert!(
            packet.contains(&format!(
                "the {orphan_count} `ui-state.json.tmp-*` orphans found in real data"
            )),
            "the release packet's orphan count must be derived from the banked artifact"
        );
        assert!(
            harness.contains(&format!(
                "banked dogfood evidence contains {orphan_count} such UI-state temp orphans"
            )),
            "the harness guide's real-data count must match the banked artifact"
        );
    }

    #[test]
    fn incomplete_real_recapture_fails_without_banking_complete_evidence() {
        let source = fixture_source();
        let scratch_parent = ScratchDir::new().expect("scratch parent");
        let recovery_parent = ScratchDir::new().expect("recovery parent");
        let scratch = scratch_parent.join("clones");
        let recovery = recovery_parent.join("artifacts");
        let remove_one_projection = |clone_root: &Path| {
            let db = clone_root.join(".dohc").join("engine").join("engine.db");
            let connection = rusqlite::Connection::open(db).map_err(|source| HarnessError::Io {
                operation: "open mutation fixture store",
                source: std::io::Error::other(source),
            })?;
            let removed = connection
                .execute(
                    "DELETE FROM path_aliases \
                     WHERE workspace_id = ?1 AND version_id = ?2 AND path = 'note.md'",
                    [RECAPTURE_WORKSPACE_ID, RECAPTURE_VERSION_ID],
                )
                .map_err(|source| HarnessError::Io {
                    operation: "mutate recapture fixture",
                    source: std::io::Error::other(source),
                })?;
            assert_eq!(removed, 1, "fixture must remove one recaptured path");
            Ok(())
        };

        let error = run_with_post_capture_hook(
            HarnessConfig {
                source: source.path(),
                scratch: &scratch,
                recovery: &recovery,
            },
            Some(&remove_one_projection),
        )
        .expect_err("an incomplete recapture must fail the harness");

        match error {
            HarnessError::RecaptureIncomplete { diff } => {
                assert!(diff.contains("note.md"));
                assert!(diff.contains("missing from fresh store"));
            }
            other => panic!("wanted recapture-incomplete, got {other:?}"),
        }
        assert!(
            !recovery.join(EVIDENCE_FILE).exists(),
            "incomplete recapture must not bank complete evidence"
        );
    }

    #[test]
    fn recapture_compares_text_binary_and_secret_content_identity() {
        let source = fixture_source();
        std::fs::write(source.join(".env"), b"TOKEN=fixture-secret\n").expect("secret");
        std::fs::write(source.join("image.png"), [0_u8, 1, 2, 0xff]).expect("binary");
        let scratch_parent = ScratchDir::new().expect("scratch parent");
        let recovery_parent = ScratchDir::new().expect("recovery parent");
        let scratch = scratch_parent.join("clones");
        let recovery = recovery_parent.join("artifacts");

        let evidence = run(HarnessConfig {
            source: source.path(),
            scratch: &scratch,
            recovery: &recovery,
        })
        .expect("text, binary, and secret recapture");

        assert_eq!(evidence.recapture.paths_expected, 3);
        assert_eq!(evidence.recapture.paths_recaptured, 3);
        assert_eq!(evidence.recapture.records_recaptured, 3);
        assert_eq!(evidence.recapture.content_identities_verified, 3);
        assert_eq!(evidence.recapture.verdict, RecaptureVerdict::Complete);
        let banked = std::fs::read_to_string(recovery.join(EVIDENCE_FILE)).expect("evidence");
        assert!(
            !banked.contains(&sha256_bytes(b"TOKEN=fixture-secret\n")),
            "secret sha256 must not be serialized"
        );
    }

    #[test]
    fn capture_policy_refusals_are_not_reported_as_recapture_data_loss() {
        let source = fixture_source();
        let refused = source.join("shared-with-me");
        std::fs::create_dir(&refused).expect("policy-refused directory");
        std::fs::write(refused.join("remote.md"), b"not locally captured\n")
            .expect("policy-refused file");
        let scratch_parent = ScratchDir::new().expect("scratch parent");
        let recovery_parent = ScratchDir::new().expect("recovery parent");
        let scratch = scratch_parent.join("clones");
        let recovery = recovery_parent.join("artifacts");

        let evidence = run(HarnessConfig {
            source: source.path(),
            scratch: &scratch,
            recovery: &recovery,
        })
        .expect("policy refusal must not be classified as recapture data loss");

        assert_eq!(evidence.recapture.paths_expected, 1);
        assert_eq!(evidence.recapture.paths_recaptured, 1);
        assert_eq!(evidence.recapture.records_expected, 1);
        assert_eq!(evidence.recapture.records_recaptured, 1);
        assert_eq!(evidence.recapture.verdict, RecaptureVerdict::Complete);
        assert!(evidence.recapture.mismatches.is_empty());
    }

    #[test]
    fn complete_capture_floor_excludes_file_artifacts_from_the_clone() {
        let source = fixture_source();
        for (path, bytes) in [
            (".dohc-write-123.tmp", b"temporary".as_slice()),
            ("notes.db-wal", b"sidecar".as_slice()),
            ("note.md.job-7.conflict", b"preserve both".as_slice()),
        ] {
            std::fs::write(source.join(path), bytes).expect("write excluded fixture");
        }
        let scratch_parent = ScratchDir::new().expect("scratch parent");
        let recovery_parent = ScratchDir::new().expect("recovery parent");
        let scratch = scratch_parent.join("clones");
        let recovery = recovery_parent.join("artifacts");

        let evidence = run(HarnessConfig {
            source: source.path(),
            scratch: &scratch,
            recovery: &recovery,
        })
        .expect("floor-aware rehearsal");

        assert_eq!(evidence.floor_skips.file_root_count, 3);
        for path in [
            ".dohc-write-123.tmp",
            "notes.db-wal",
            "note.md.job-7.conflict",
        ] {
            assert!(
                !Path::new(&evidence.clone_path).join(path).exists(),
                "{path} must not enter the byte clone"
            );
            assert!(
                evidence
                    .floor_skips
                    .roots
                    .iter()
                    .any(|root| root.relative_path == path
                        && root.kind == FloorSkippedRootKind::File),
                "{path} must be recorded as a floor skip"
            );
        }
        assert_eq!(evidence.recapture.paths_expected, 1);
        assert_eq!(evidence.recapture.verdict, RecaptureVerdict::Complete);
    }

    #[test]
    fn skipped_tree_content_hash_detects_byte_changes_with_stable_root_metadata() {
        let source = fixture_source();
        let skipped = source.join("node_modules");
        std::fs::create_dir(&skipped).expect("skipped directory");
        let package = skipped.join("package.js");
        std::fs::write(&package, b"aaaa").expect("package contents");
        let file_metadata = std::fs::metadata(&package).expect("file metadata");
        let accessed = FileTime::from_last_access_time(&file_metadata);
        let modified = FileTime::from_last_modification_time(&file_metadata);
        let before = snapshot_source_tree(source.path()).expect("before");
        let before_skipped = before
            .entries
            .iter()
            .find(|entry| entry.relative_path == "node_modules")
            .expect("skipped root");

        std::fs::write(&package, b"bbbb").expect("mutate package contents");
        filetime::set_file_times(&package, accessed, modified).expect("restore file times");
        let after = snapshot_source_tree(source.path()).expect("after");
        let after_skipped = after
            .entries
            .iter()
            .find(|entry| entry.relative_path == "node_modules")
            .expect("skipped root");

        assert_ne!(before_skipped.sha256, after_skipped.sha256);
        assert_ne!(
            before.summary.snapshot_sha256,
            after.summary.snapshot_sha256
        );
    }

    #[cfg(windows)]
    #[test]
    fn inside_source_hard_link_twins_are_cloned_and_recorded() {
        let source = fixture_source();
        std::fs::hard_link(source.join("note.md"), source.join("note-alias.md"))
            .expect("hard-link fixture");
        let clone_parent = ScratchDir::new().expect("clone parent");
        let clone = clone_parent.join("clone");

        let result = clone_tree(source.path(), &clone).expect("inside-source twins are safe");

        assert_eq!(
            std::fs::read(clone.join("note.md")).expect("cloned source name"),
            std::fs::read(source.join("note.md")).expect("source bytes")
        );
        assert_eq!(
            std::fs::read(clone.join("note-alias.md")).expect("cloned twin name"),
            std::fs::read(source.join("note-alias.md")).expect("twin bytes")
        );
        assert_eq!(result.hard_links.hard_linked_source_file_count, 2);
        assert_eq!(result.hard_links.total_link_count, 4);
        assert_eq!(result.hard_links.total_twin_path_count, 2);
        assert_eq!(result.hard_links.inside_source_tree_twin_count, 2);
        assert_eq!(result.hard_links.outside_source_tree_twin_count, 0);
        assert!(!result.hard_links.outside_source_tree_observed);
        assert_eq!(result.hard_links.sampled_file_count, 2);
        assert_eq!(result.hard_links.omitted_file_count, 0);
        assert!(result.hard_links.files.iter().all(|file| {
            file.inside_source_tree_twin_count == 1
                && file.outside_source_tree_twin_count == 0
                && file.twin_paths[0].location == HardLinkTwinLocation::InsideSourceTree
        }));
    }

    #[cfg(windows)]
    #[test]
    fn outside_source_hard_link_twin_is_refused() {
        let source = fixture_source();
        let outside_parent = ScratchDir::new().expect("outside parent");
        let outside_twin = outside_parent.join("outside-note.md");
        std::fs::hard_link(source.join("note.md"), &outside_twin)
            .expect("outside hard-link fixture");
        let clone_parent = ScratchDir::new().expect("clone parent");
        let clone = clone_parent.join("clone");

        let result = clone_tree(source.path(), &clone);

        assert!(
            matches!(result, Err(HarnessError::UnsupportedEntry { .. })),
            "a hard-link twin outside the source boundary must fail closed"
        );
        assert_eq!(
            std::fs::read(&outside_twin).expect("outside twin remains readable"),
            std::fs::read(source.join("note.md")).expect("source bytes remain readable")
        );
    }

    #[cfg(unix)]
    #[test]
    fn hard_links_fail_closed_when_twin_paths_cannot_be_enumerated() {
        let source = fixture_source();
        std::fs::hard_link(source.join("note.md"), source.join("note-alias.md"))
            .expect("hard-link fixture");
        let clone_parent = ScratchDir::new().expect("clone parent");
        let clone = clone_parent.join("clone");

        assert!(matches!(
            clone_tree(source.path(), &clone),
            Err(HarnessError::UnsupportedEntry { .. })
        ));
    }

    #[cfg(windows)]
    #[test]
    fn node_modules_alias_is_floor_skipped_recorded_and_source_checked() {
        let source = fixture_source();
        let package_target = source.join("package-target");
        std::fs::create_dir(&package_target).expect("package target");
        std::fs::write(package_target.join("index.js"), b"module.exports = 1;\n")
            .expect("package contents");
        let node_modules = source.join("node_modules");
        std::fs::create_dir(&node_modules).expect("node_modules");
        let package_alias = node_modules.join("picomatch");
        if let Err(error) = std::os::windows::fs::symlink_dir(&package_target, &package_alias) {
            if error.kind() == std::io::ErrorKind::PermissionDenied {
                return;
            }
            panic!("create directory symlink fixture: {error}");
        }

        let before = snapshot_source_tree(source.path()).expect("full source snapshot before");
        let skipped_before = before
            .entries
            .iter()
            .find(|entry| entry.relative_path == "node_modules")
            .expect("node_modules root must remain in source proof");
        assert_eq!(skipped_before.kind, EntryKind::FloorSkippedDirectory);

        let scratch_parent = ScratchDir::new().expect("scratch parent");
        let recovery_parent = ScratchDir::new().expect("recovery parent");
        let scratch = scratch_parent.join("clones");
        let recovery = recovery_parent.join("artifacts");
        let evidence = run(HarnessConfig {
            source: source.path(),
            scratch: &scratch,
            recovery: &recovery,
        })
        .expect("floor-aware rehearsal completes");

        assert_eq!(evidence.outcome, "complete");
        assert!(evidence.source_unchanged.verified);
        assert_eq!(evidence.floor_skips.root_count, 1);
        assert_eq!(evidence.floor_skips.directory_root_count, 1);
        assert_eq!(evidence.floor_skips.alias_root_count, 0);
        assert_eq!(evidence.floor_skips.roots[0].relative_path, "node_modules");
        assert!(
            !Path::new(&evidence.clone_path)
                .join("node_modules")
                .exists(),
            "the floor-excluded root must not be cloned"
        );
        assert!(
            std::fs::symlink_metadata(&package_alias)
                .expect("source alias remains")
                .file_type()
                .is_symlink(),
            "the source fixture alias must remain untouched"
        );
        let after = snapshot_source_tree(source.path()).expect("full source snapshot after");
        assert_eq!(
            after, before,
            "full source proof includes the skipped root's existence and mtime"
        );

        let banked: serde_json::Value = serde_json::from_slice(
            &std::fs::read(recovery.join(EVIDENCE_FILE)).expect("read banked evidence"),
        )
        .expect("parse banked evidence");
        assert_eq!(banked["floor_skips"]["root_count"], 1);
        assert_eq!(
            banked["floor_skips"]["roots"][0]["relative_path"],
            "node_modules"
        );
    }
}
