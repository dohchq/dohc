//! The durable materialization pipeline — the filesystem half of the plan's
//! filesystem/database crash boundary (`plan §Filesystem/database crash
//! boundary`, `TEST_ORACLE.md` §3.3). The DB half (job rows, content blobs)
//! lives in `dohc-engine-storage`; this module executes PENDING jobs against
//! the real user file tree and marks them terminal.
//!
//! Per job, the five durable steps:
//!
//! 1. Load the content blob; short-circuit idempotently if the target already
//!    holds exactly it (a prior run renamed but crashed before marking
//!    complete — no second write, no duplicate).
//! 2. Write a **sibling temp file**, bounded bytes, restrictive mode.
//! 3. **Flush** per the per-OS [`DurabilityPolicy`].
//! 4. **Revalidate the preimage** immediately before the replace: if an external
//!    editor produced newer content after the DB commit, do NOT overwrite —
//!    preserve both and mark the job `conflict`.
//! 5. **Atomically replace without following links**, with bounded retry for
//!    transient sharing violations (Windows AV/indexer), then mark complete or
//!    fail closed with the job left pending for startup replay.
//!
//! Each boundary has a named fault point so a crash-injection test can prove the
//! recovery contract by reopening and replaying.
//!
//! **Residual TOCTOU (documented, not closed).** The preimage revalidation
//! (step 4) reads the current target and the atomic replace (step 5) renames
//! over it; no filesystem offers a content-compare-and-swap, so these two steps
//! are NOT atomic. An external write landing in the microsecond between the
//! revalidation read and the rename is clobbered. This is an inherent, narrow
//! residual window — the pipeline closes the common case (an editor that wrote
//! before the pipeline started is detected and preserved), not the sub-op race.
//! Recorded in `BEHAVIOR_DELTA.md` (R04) so it is not mistaken for closed.

use crate::bounds::{MAX_CAPTURE_BINARY_BYTES, MAX_CAPTURE_TEXT_BYTES};
use crate::floor::is_excluded_file;
use crate::media::{is_text_media_type, media_type_for_path};
use dohc_engine_storage::{
    EngineStore, FaultInjector, FaultPoint, MaterializationJob, MaterializationOperation, Preimage,
    StorageError, hex_sha256,
};
use std::io::{ErrorKind, Read};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// Maximum bytes the pipeline will materialize or read back for comparison. A
/// job's content came from a bounded blob; the on-disk comparison read is
/// bounded the same way so a giant external file cannot blow memory.
pub const MAX_MATERIALIZE_BYTES: usize = dohc_engine_storage::MAX_MATERIALIZE_BYTES;

/// The normative maximum atomic-replace attempts before failing closed
/// (`TEST_ORACLE.md` §3.10). Re-exported from storage so both halves share ONE
/// constant.
pub const MAX_REPLACE_ATTEMPTS: u32 = dohc_engine_storage::MAX_REPLACE_ATTEMPTS;

/// A per-OS flush policy (`plan` step 3, `LANGUAGE_SEMANTICS_MATRIX` 8.6). The
/// TS engine never fsyncs; the Rust pipeline adds an explicit, documented policy
/// (approved delta). Directory fsync is a POSIX affordance; on Windows `std`
/// exposes no portable directory sync, so `fsync_parent_dir` is a documented
/// no-op there (an honestly-scoped durability limit).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DurabilityPolicy {
    pub fsync_file: bool,
    pub fsync_parent_dir: bool,
}

impl DurabilityPolicy {
    /// The production per-OS policy: fsync the temp file everywhere; fsync the
    /// parent directory on POSIX (durable rename), best-effort/no-op on Windows.
    pub fn per_os() -> Self {
        DurabilityPolicy {
            fsync_file: true,
            fsync_parent_dir: cfg!(unix),
        }
    }

    /// No flushing — for fast tests that assert logical recovery, not the OS
    /// durability floor.
    pub fn none() -> Self {
        DurabilityPolicy {
            fsync_file: false,
            fsync_parent_dir: false,
        }
    }
}

/// One replace attempt seam so the bounded retry loop can be exercised against
/// injected transient sharing violations without racing a real AV process.
pub trait AtomicReplacer: Send + Sync {
    /// A single atomic replace of `to` by `from`, WITHOUT following links. On
    /// Windows this is `ReplaceFile`/`MoveFileEx(REPLACE_EXISTING)` semantics
    /// (what `std::fs::rename` maps to); on POSIX it is `rename(2)`.
    fn try_replace(&self, from: &Path, to: &Path) -> std::io::Result<()>;
}

/// The production replacer: `std::fs::rename`, which on Windows performs an
/// atomic `MoveFileExW(REPLACE_EXISTING | WRITE_THROUGH)` and on POSIX a
/// `rename(2)` — both replace the target without following a symlink at the
/// destination name.
#[derive(Debug, Clone, Copy, Default)]
pub struct StdReplacer;

impl AtomicReplacer for StdReplacer {
    fn try_replace(&self, from: &Path, to: &Path) -> std::io::Result<()> {
        std::fs::rename(from, to)
    }
}

/// The delay schedule between bounded atomic-replace retries. Injectable so
/// tests stay fast (no real sleep) while production absorbs the tens-of-ms
/// window a real Windows AV/indexer sharing violation holds a handle.
pub trait ReplaceBackoff: Send + Sync {
    /// Wait before retrying after `failed_attempt` (1-indexed) failed with a
    /// transient sharing violation.
    fn wait_before_retry(&self, failed_attempt: u32);
}

/// Exponential backoff delay: base 10 ms doubled per failed attempt, capped at
/// 200 ms. Pure so the schedule is unit-testable without sleeping.
pub fn backoff_delay(failed_attempt: u32) -> Duration {
    const BASE_MS: u64 = 10;
    const CAP_MS: u64 = 200;
    let shift = failed_attempt.saturating_sub(1).min(20);
    let ms = BASE_MS.saturating_mul(1u64 << shift).min(CAP_MS);
    Duration::from_millis(ms)
}

/// Production backoff: really sleeps [`backoff_delay`] so a transient sharing
/// violation (tens of ms) is actually absorbed rather than burned through in
/// microseconds.
#[derive(Debug, Clone, Copy, Default)]
pub struct StdBackoff;

impl ReplaceBackoff for StdBackoff {
    fn wait_before_retry(&self, failed_attempt: u32) {
        std::thread::sleep(backoff_delay(failed_attempt));
    }
}

/// No-wait backoff for tests that assert logical retry behavior, not timing.
#[derive(Debug, Clone, Copy, Default)]
pub struct NoBackoff;

impl ReplaceBackoff for NoBackoff {
    fn wait_before_retry(&self, _failed_attempt: u32) {}
}

trait SecretTempRemover: Send + Sync {
    fn remove_file(&self, path: &Path) -> std::io::Result<()>;
}

#[derive(Debug, Clone, Copy, Default)]
struct StdSecretTempRemover;

impl SecretTempRemover for StdSecretTempRemover {
    fn remove_file(&self, path: &Path) -> std::io::Result<()> {
        std::fs::remove_file(path)
    }
}

/// The terminal outcome of one job.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JobOutcome {
    /// Written and marked complete.
    Completed,
    /// The target already equalled the desired content (idempotent replay); no
    /// write performed, marked complete.
    AlreadyMaterialized,
    /// A newer generation was already materialized at this path; this job is
    /// superseded and marked complete without regressing the path to older
    /// content.
    Superseded,
    /// Newer external content was found at revalidation; preserved-both, marked
    /// conflict, target NOT overwritten.
    Conflict,
    /// A crash fault fired at this named point; the job is left as-is for
    /// startup replay. Durability is proven by reopening.
    Crashed(FaultPoint),
}

/// The ownership-aware disk state used to plan an active-version projection.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProjectionTargetState {
    Absent,
    Text { sha256: String },
    Binary { sha256: String },
    UntrackedContent,
    Unreadable,
}

/// Whether a projection path follows the ordinary text/binary policy or the
/// secret store's text-only policy.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProjectionTargetKind {
    Plaintext,
    Secret,
}

/// Read a prospective projection target without treating foreign or
/// transiently unreadable content as an overwrite preimage.
pub fn probe_projection_target(
    root: &Path,
    rel: &str,
    kind: ProjectionTargetKind,
) -> ProjectionTargetState {
    let canonical_root = match std::fs::canonicalize(root) {
        Ok(root) => root,
        Err(_) => return ProjectionTargetState::UntrackedContent,
    };
    let target = match resolve_target(&canonical_root, rel) {
        Ok(target) => target,
        Err(_) => return ProjectionTargetState::UntrackedContent,
    };
    if ensure_target_symlink_free(&canonical_root, &target).is_err() {
        return ProjectionTargetState::UntrackedContent;
    }
    let metadata = match std::fs::symlink_metadata(&target) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => {
            return if existing_ancestor_is_contained(&canonical_root, &target) {
                ProjectionTargetState::Absent
            } else {
                ProjectionTargetState::UntrackedContent
            };
        }
        Err(_) => return ProjectionTargetState::Unreadable,
    };
    if metadata.file_type().is_symlink() || !metadata.file_type().is_file() {
        return ProjectionTargetState::UntrackedContent;
    }
    if !existing_ancestor_is_contained(&canonical_root, &target) {
        return ProjectionTargetState::UntrackedContent;
    }
    let cap = match kind {
        ProjectionTargetKind::Plaintext => MAX_CAPTURE_BINARY_BYTES,
        ProjectionTargetKind::Secret => MAX_CAPTURE_TEXT_BYTES,
    };
    if metadata.len() > cap {
        return ProjectionTargetState::UntrackedContent;
    }
    let file = match std::fs::File::open(&target) {
        Ok(file) => file,
        Err(_) => return ProjectionTargetState::Unreadable,
    };
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    if file
        .take(cap.saturating_add(1))
        .read_to_end(&mut bytes)
        .is_err()
    {
        return ProjectionTargetState::Unreadable;
    }
    if bytes.len() as u64 > cap {
        return ProjectionTargetState::UntrackedContent;
    }
    let sha256 = hex_sha256(&bytes);
    match kind {
        ProjectionTargetKind::Secret => match String::from_utf8(bytes) {
            Ok(_) => ProjectionTargetState::Text { sha256 },
            Err(_) => ProjectionTargetState::UntrackedContent,
        },
        ProjectionTargetKind::Plaintext => {
            let media_type = media_type_for_path(rel);
            if !is_text_media_type(media_type, rel) {
                return ProjectionTargetState::Binary { sha256 };
            }
            match String::from_utf8(bytes) {
                Ok(text) if text.len() as u64 <= MAX_CAPTURE_TEXT_BYTES => {
                    ProjectionTargetState::Text { sha256 }
                }
                Ok(_) => ProjectionTargetState::UntrackedContent,
                Err(_) => ProjectionTargetState::Binary { sha256 },
            }
        }
    }
}

fn existing_ancestor_is_contained(root: &Path, target: &Path) -> bool {
    let Ok(canonical_root) = std::fs::canonicalize(root) else {
        return false;
    };
    let mut candidate = Some(target);
    while let Some(path) = candidate {
        match std::fs::canonicalize(path) {
            Ok(canonical) => return canonical.starts_with(&canonical_root),
            Err(error) if error.kind() == ErrorKind::NotFound => {
                candidate = path.parent();
            }
            Err(_) => return false,
        }
    }
    false
}

/// The result of executing one job.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JobResult {
    pub job_id: String,
    pub outcome: JobOutcome,
}

/// A materialization-pipeline failure.
#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
pub enum MaterializeError {
    /// A durable storage step failed (blob read, job status update).
    #[error(transparent)]
    Storage(#[from] StorageError),
    /// A filesystem step failed for a non-transient reason.
    #[error("materialization io failed at {path}: {kind:?}")]
    Io { path: String, kind: ErrorKind },
    /// The job references a content blob that is not in the store — a corrupt
    /// job (the enqueue should have committed the blob in the same txn).
    #[error("job {job_id} references missing blob {sha256}")]
    MissingBlob { job_id: String, sha256: String },
    /// The target path escapes the workspace root, is absolute, or is on the
    /// path floor — never materialize outside the tree or into engine scratch.
    #[error("job target path is not a safe workspace-relative path")]
    UnsafeTargetPath,
    /// The existing target is a symlink; refusing to materialize through it
    /// (would follow the link out of the tree). `LANGUAGE_SEMANTICS_MATRIX` 8.1.
    #[error("job target is a symlink; refusing to overwrite through it")]
    SymlinkTarget,
    /// A secret target exists but cannot safely be compared or replaced (for
    /// example, it is a directory or special file). The job remains pending.
    #[error("secret materialization target is not a bounded regular file")]
    BlockedTarget,
    /// The atomic replace exhausted its bounded retry budget on transient
    /// sharing violations; the job is left pending for startup replay.
    #[error("atomic replace exhausted {MAX_REPLACE_ATTEMPTS} attempts (file locked)")]
    FileLocked,
    /// The content or an on-disk file exceeded the materialization byte cap.
    #[error("materialization content {actual} bytes exceeds the cap")]
    TooLarge { actual: usize },
}

impl MaterializeError {
    fn io(path: &Path, err: &std::io::Error) -> Self {
        MaterializeError::Io {
            path: path.to_string_lossy().into_owned(),
            kind: err.kind(),
        }
    }

    /// The stable machine code (kebab-case).
    pub fn code(&self) -> &'static str {
        match self {
            MaterializeError::Storage(e) => e.code(),
            MaterializeError::Io { .. } => "materialize-io",
            MaterializeError::MissingBlob { .. } => "missing-blob",
            MaterializeError::UnsafeTargetPath => "unsafe-target-path",
            MaterializeError::SymlinkTarget => "symlink-target",
            MaterializeError::BlockedTarget => "blocked-target",
            MaterializeError::FileLocked => "file-locked",
            MaterializeError::TooLarge { .. } => "materialize-too-large",
        }
    }
}

#[cfg(feature = "fault-injection")]
#[inline]
fn should_crash(faults: &dyn FaultInjector, point: FaultPoint) -> bool {
    faults.poll(point) == dohc_engine_storage::FaultAction::Crash
}

#[cfg(not(feature = "fault-injection"))]
#[inline(always)]
fn should_crash(_faults: &dyn FaultInjector, _point: FaultPoint) -> bool {
    false
}

/// Execute every pending job (oldest first). Stops at the first job that
/// crashes (simulating process death), returning the results accumulated so
/// far; the remaining jobs stay pending and are replayed on the next call.
pub fn run_pending_jobs(
    store: &EngineStore,
    root: &Path,
    policy: DurabilityPolicy,
    replacer: &dyn AtomicReplacer,
    backoff: &dyn ReplaceBackoff,
    now_ms: i64,
    faults: &dyn FaultInjector,
) -> Result<Vec<JobResult>, MaterializeError> {
    let jobs = store.list_pending_materialization_jobs()?;
    let mut results = Vec::with_capacity(jobs.len());
    for job in jobs {
        let outcome =
            materialize_one(store, root, &job, policy, replacer, backoff, now_ms, faults)?;
        let crashed = matches!(outcome, JobOutcome::Crashed(_));
        results.push(JobResult {
            job_id: job.job_id,
            outcome,
        });
        if crashed {
            break;
        }
    }
    Ok(results)
}

/// Execute a single job through the five durable steps.
#[allow(
    clippy::too_many_arguments,
    reason = "each seam is injected for testability"
)]
pub fn materialize_one(
    store: &EngineStore,
    root: &Path,
    job: &MaterializationJob,
    policy: DurabilityPolicy,
    replacer: &dyn AtomicReplacer,
    backoff: &dyn ReplaceBackoff,
    now_ms: i64,
    faults: &dyn FaultInjector,
) -> Result<JobOutcome, MaterializeError> {
    let target = resolve_target(root, &job.target_path)?;

    // `materialize.after-job-commit`: the job row is durable but nothing is on
    // disk yet. A crash here leaves the job pending for startup replay.
    if should_crash(faults, FaultPoint::MaterializeAfterJobCommit) {
        return Ok(JobOutcome::Crashed(FaultPoint::MaterializeAfterJobCommit));
    }

    // Generation staleness gate: if a NEWER generation has already been
    // materialized at this path, this job is superseded — never regress the path
    // to older content (concurrent / out-of-order jobs). No-op; mark complete.
    if !job.job_id.starts_with("version-switch-")
        && let Some(done_gen) = store.max_completed_generation_for_path(&job.target_path)?
        && done_gen > job.target_generation
    {
        store.mark_materialization_complete(&job.job_id, now_ms)?;
        return Ok(JobOutcome::Superseded);
    }

    if job.operation == MaterializationOperation::Delete {
        return materialize_delete(store, &target, job, policy, now_ms, faults);
    }

    // Load the content blob (integrity-verified on read).
    let content = store.get_binary_blob(&job.content_sha256)?.ok_or_else(|| {
        MaterializeError::MissingBlob {
            job_id: job.job_id.clone(),
            sha256: job.content_sha256.clone(),
        }
    })?;
    if content.len() > MAX_MATERIALIZE_BYTES {
        return Err(MaterializeError::TooLarge {
            actual: content.len(),
        });
    }
    materialize_write_content(
        store,
        &target,
        job,
        &content,
        policy,
        replacer,
        backoff,
        now_ms,
        faults,
        true,
        None,
        &StdSecretTempRemover,
    )
}

/// Execute a secret write through the same atomic-replace pipeline without
/// ever persisting plaintext in the content-blob table. Ordinary secret jobs
/// adopt the current disk state as their immediate preimage; version-switch
/// jobs retain the preimage probed during phase 1 so an intervening edit
/// conflicts. Conflict handling never writes a plaintext `.conflict` sibling.
#[allow(
    clippy::too_many_arguments,
    reason = "each seam is injected for testability"
)]
pub fn materialize_secret_one(
    store: &EngineStore,
    root: &Path,
    job: &MaterializationJob,
    plaintext: &[u8],
    policy: DurabilityPolicy,
    replacer: &dyn AtomicReplacer,
    backoff: &dyn ReplaceBackoff,
    now_ms: i64,
    faults: &dyn FaultInjector,
) -> Result<JobOutcome, MaterializeError> {
    materialize_secret_one_with_remover(
        store,
        root,
        job,
        plaintext,
        policy,
        replacer,
        backoff,
        now_ms,
        faults,
        &StdSecretTempRemover,
    )
}

#[allow(
    clippy::too_many_arguments,
    reason = "each seam is injected for testability"
)]
fn materialize_secret_one_with_remover(
    store: &EngineStore,
    root: &Path,
    job: &MaterializationJob,
    plaintext: &[u8],
    policy: DurabilityPolicy,
    replacer: &dyn AtomicReplacer,
    backoff: &dyn ReplaceBackoff,
    now_ms: i64,
    faults: &dyn FaultInjector,
    secret_temp_remover: &dyn SecretTempRemover,
) -> Result<JobOutcome, MaterializeError> {
    let canonical_root =
        std::fs::canonicalize(root).map_err(|err| MaterializeError::io(root, &err))?;
    let target = resolve_target(&canonical_root, &job.target_path)?;
    ensure_target_symlink_free(&canonical_root, &target)?;
    if should_crash(faults, FaultPoint::MaterializeAfterJobCommit) {
        return Ok(JobOutcome::Crashed(FaultPoint::MaterializeAfterJobCommit));
    }
    if plaintext.len() > MAX_MATERIALIZE_BYTES {
        return Err(MaterializeError::TooLarge {
            actual: plaintext.len(),
        });
    }
    let desired_sha = hex_sha256(plaintext);
    let current = read_current_no_follow(&target)?;
    if let CurrentTarget::Present(bytes) = &current
        && hex_sha256(bytes) == desired_sha
    {
        store.mark_materialization_complete(&job.job_id, now_ms)?;
        return Ok(JobOutcome::AlreadyMaterialized);
    }
    let preimage = if job.job_id.starts_with("version-switch-secret-mat_") {
        job.preimage.clone()
    } else {
        match current {
            CurrentTarget::Absent => Preimage::Absent,
            CurrentTarget::Present(bytes) => Preimage::Present(hex_sha256(&bytes)),
            CurrentTarget::Oversized => {
                return Err(MaterializeError::BlockedTarget);
            }
        }
    };
    let plaintext_job = MaterializationJob {
        content_sha256: desired_sha,
        preimage,
        ..job.clone()
    };
    materialize_write_content(
        store,
        &target,
        &plaintext_job,
        plaintext,
        policy,
        replacer,
        backoff,
        now_ms,
        faults,
        false,
        Some(&canonical_root),
        secret_temp_remover,
    )
}

/// Execute an active-version secret delete after the runtime has resolved the
/// versioned current tip. Unlike the generic pipeline, this deliberately has no
/// workspace-wide generation fence: generations from another version cannot
/// suppress deletion of the active disk projection. Ordinary keyless deletes
/// adopt the current regular file; version-switch deletes retain their
/// phase-1 plaintext hash so an intervening edit conflicts. Neither path emits
/// a plaintext conflict artifact.
#[allow(
    clippy::too_many_arguments,
    reason = "each seam is injected for testability"
)]
pub fn materialize_secret_delete_one(
    store: &EngineStore,
    root: &Path,
    job: &MaterializationJob,
    policy: DurabilityPolicy,
    now_ms: i64,
    faults: &dyn FaultInjector,
) -> Result<JobOutcome, MaterializeError> {
    let canonical_root =
        std::fs::canonicalize(root).map_err(|err| MaterializeError::io(root, &err))?;
    let target = resolve_target(&canonical_root, &job.target_path)?;
    ensure_target_symlink_free(&canonical_root, &target)?;
    if should_crash(faults, FaultPoint::MaterializeAfterJobCommit) {
        return Ok(JobOutcome::Crashed(FaultPoint::MaterializeAfterJobCommit));
    }
    materialize_secret_delete(store, &canonical_root, &target, job, policy, now_ms, faults)
}

fn materialize_secret_delete(
    store: &EngineStore,
    root: &Path,
    target: &Path,
    job: &MaterializationJob,
    policy: DurabilityPolicy,
    now_ms: i64,
    faults: &dyn FaultInjector,
) -> Result<JobOutcome, MaterializeError> {
    let current = read_current_no_follow(target)?;
    let preimage = match current {
        CurrentTarget::Absent => {
            store.mark_materialization_complete(&job.job_id, now_ms)?;
            return Ok(JobOutcome::AlreadyMaterialized);
        }
        CurrentTarget::Present(_) if job.job_id.starts_with("version-switch-secret-mat_") => {
            job.preimage.clone()
        }
        CurrentTarget::Present(bytes) => Preimage::Present(hex_sha256(&bytes)),
        CurrentTarget::Oversized => return Err(MaterializeError::BlockedTarget),
    };
    if should_crash(faults, FaultPoint::MaterializeBeforePreimageRevalidate) {
        return Ok(JobOutcome::Crashed(
            FaultPoint::MaterializeBeforePreimageRevalidate,
        ));
    }
    // Re-read immediately before unlinking to preserve no-follow semantics.
    let current_now = read_current_no_follow(target)?;
    match &current_now {
        CurrentTarget::Absent => {
            store.mark_materialization_complete(&job.job_id, now_ms)?;
            return Ok(JobOutcome::AlreadyMaterialized);
        }
        CurrentTarget::Present(_) => {}
        CurrentTarget::Oversized => return Err(MaterializeError::BlockedTarget),
    }
    if !preimage_matches(&preimage, &current_now) {
        store.mark_materialization_conflict(&job.job_id, now_ms)?;
        return Ok(JobOutcome::Conflict);
    }
    ensure_target_symlink_free(root, target)?;
    std::fs::remove_file(target).map_err(|err| MaterializeError::io(target, &err))?;
    sync_parent_dir(target.parent(), policy)?;
    if should_crash(faults, FaultPoint::MaterializeAfterRenameBeforeComplete) {
        return Ok(JobOutcome::Crashed(
            FaultPoint::MaterializeAfterRenameBeforeComplete,
        ));
    }
    store.mark_materialization_complete(&job.job_id, now_ms)?;
    Ok(JobOutcome::Completed)
}

struct SecretPlaintextTempCleanup<'a> {
    path: &'a Path,
    armed: bool,
}

impl<'a> SecretPlaintextTempCleanup<'a> {
    fn new(path: &'a Path, armed: bool) -> Self {
        SecretPlaintextTempCleanup { path, armed }
    }

    fn disarm(&mut self) {
        self.armed = false;
    }

    fn arm(&mut self) {
        self.armed = true;
    }
}

impl Drop for SecretPlaintextTempCleanup<'_> {
    fn drop(&mut self) {
        if self.armed {
            let _ = std::fs::remove_file(self.path);
        }
    }
}

#[allow(
    clippy::too_many_arguments,
    reason = "each seam is injected for testability"
)]
fn materialize_write_content(
    store: &EngineStore,
    target: &Path,
    job: &MaterializationJob,
    content: &[u8],
    policy: DurabilityPolicy,
    replacer: &dyn AtomicReplacer,
    backoff: &dyn ReplaceBackoff,
    now_ms: i64,
    faults: &dyn FaultInjector,
    preserve_conflict_artifact: bool,
    secret_root: Option<&Path>,
    secret_temp_remover: &dyn SecretTempRemover,
) -> Result<JobOutcome, MaterializeError> {
    if let Some(root) = secret_root {
        ensure_target_symlink_free(root, target)?;
    }
    // Step 1 (idempotent replay): the target already equals the desired content.
    let current = read_current_no_follow(target)?;
    if secret_root.is_some() && matches!(current, CurrentTarget::Oversized) {
        return Err(MaterializeError::BlockedTarget);
    }
    if let CurrentTarget::Present(bytes) = &current
        && hex_sha256(bytes) == job.content_sha256
    {
        store.mark_materialization_complete(&job.job_id, now_ms)?;
        return Ok(JobOutcome::AlreadyMaterialized);
    }

    // Ensure the parent directory exists (a new file in a new subtree).
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| MaterializeError::io(parent, &e))?;
    }
    if let Some(root) = secret_root {
        ensure_target_symlink_free(root, target)?;
    }

    // Step 2: sibling temp file, bounded, restrictive mode.
    let tmp = temp_sibling(target, &job.job_id);
    // Secret writes never preserve a plaintext temp on a returned error. The
    // ordinary materializer keeps its established crash/replay behavior.
    let mut secret_temp_cleanup = SecretPlaintextTempCleanup::new(&tmp, false);
    let temp_file = if preserve_conflict_artifact {
        write_temp(&tmp, content)?
    } else {
        let file = write_secret_temp_no_follow(&tmp, content)?;
        secret_temp_cleanup.arm();
        file
    };
    if should_crash(faults, FaultPoint::MaterializeAfterTempWrite) {
        // A crash here leaves an orphan temp; startup replay ignores it (temp is
        // never captured as user content — it lives under a `.dohc-write-` name
        // the path floor excludes) and re-runs the job.
        secret_temp_cleanup.disarm();
        return Ok(JobOutcome::Crashed(FaultPoint::MaterializeAfterTempWrite));
    }

    // Step 3: flush the temp FILE per the per-OS durability policy. The parent
    // directory is synced AFTER the rename (below), which is where the rename's
    // durability actually lives on POSIX.
    flush_temp_file(&temp_file, &tmp, policy)?;
    drop(temp_file);
    if should_crash(faults, FaultPoint::MaterializeAfterFlushBeforeRename) {
        secret_temp_cleanup.disarm();
        return Ok(JobOutcome::Crashed(
            FaultPoint::MaterializeAfterFlushBeforeRename,
        ));
    }

    // Step 4: revalidate the preimage immediately before the replace. The fault
    // point fires FIRST so a trace can mutate the target and prove we observe
    // the newer external content rather than clobbering it.
    if should_crash(faults, FaultPoint::MaterializeBeforePreimageRevalidate) {
        secret_temp_cleanup.disarm();
        return Ok(JobOutcome::Crashed(
            FaultPoint::MaterializeBeforePreimageRevalidate,
        ));
    }
    // NOTE: this read and the rename below are not atomic (no fs content-CAS);
    // an external write in the gap is clobbered — the documented residual TOCTOU
    // (module docs + BEHAVIOR_DELTA). The common case (an editor that wrote
    // before the pipeline ran) IS caught here.
    if let Some(root) = secret_root {
        ensure_target_symlink_free(root, target)?;
    }
    let current_now = read_current_no_follow(target)?;
    if secret_root.is_some() && matches!(current_now, CurrentTarget::Oversized) {
        return Err(MaterializeError::BlockedTarget);
    }
    if !preimage_matches(&job.preimage, &current_now) {
        // External newer content: preserve BOTH. Keep the on-disk target
        // untouched; persist our intended content to a `.conflict` sibling so it
        // is not lost; mark the job conflict (never silently replayed). The
        // `.conflict` artifact is on the path floor, so the scanner does NOT
        // auto-capture it as a new tracked document — the user/agent inspects
        // and resolves it manually.
        if preserve_conflict_artifact {
            let conflict_path = conflict_sibling(target, &job.job_id);
            rename_no_follow(&tmp, &conflict_path, replacer)?;
        } else if secret_temp_remover.remove_file(&tmp).is_ok() {
            // Keep the guard armed until removal actually succeeds. If this
            // best-effort attempt fails, Drop retries instead of leaking a
            // plaintext secret temp on the conflict return path.
            secret_temp_cleanup.disarm();
        }
        store.mark_materialization_conflict(&job.job_id, now_ms)?;
        return Ok(JobOutcome::Conflict);
    }

    // Step 5: atomic replace with bounded retry, then make the rename itself
    // durable by syncing the parent directory (POSIX), THEN mark complete — so a
    // crash can never leave the job marked complete over a non-durable rename.
    if let Some(root) = secret_root {
        ensure_target_symlink_free(root, target)?;
    }
    // This final path-based check narrows but cannot close an ancestor
    // rename-TOCTOU: a workspace writer can still swap a checked parent before
    // `rename`. Full closure needs future dirfd/openat2 + renameat work.
    replace_with_bounded_retry(&tmp, target, replacer, backoff)?;
    sync_parent_dir(target.parent(), policy)?;
    if should_crash(faults, FaultPoint::MaterializeAfterRenameBeforeComplete) {
        // Renamed but not marked complete. Startup replay: the target now equals
        // the desired content, so step 1 short-circuits and marks complete —
        // exactly-once, no second write.
        secret_temp_cleanup.disarm();
        return Ok(JobOutcome::Crashed(
            FaultPoint::MaterializeAfterRenameBeforeComplete,
        ));
    }
    store.mark_materialization_complete(&job.job_id, now_ms)?;
    secret_temp_cleanup.disarm();
    Ok(JobOutcome::Completed)
}

fn materialize_delete(
    store: &EngineStore,
    target: &Path,
    job: &MaterializationJob,
    policy: DurabilityPolicy,
    now_ms: i64,
    faults: &dyn FaultInjector,
) -> Result<JobOutcome, MaterializeError> {
    let current = read_current_no_follow(target)?;
    if matches!(current, CurrentTarget::Absent) {
        store.mark_materialization_complete(&job.job_id, now_ms)?;
        return Ok(JobOutcome::AlreadyMaterialized);
    }
    if should_crash(faults, FaultPoint::MaterializeBeforePreimageRevalidate) {
        return Ok(JobOutcome::Crashed(
            FaultPoint::MaterializeBeforePreimageRevalidate,
        ));
    }
    let current_now = read_current_no_follow(target)?;
    if !preimage_matches(&job.preimage, &current_now) {
        store.mark_materialization_conflict(&job.job_id, now_ms)?;
        return Ok(JobOutcome::Conflict);
    }
    std::fs::remove_file(target).map_err(|err| MaterializeError::io(target, &err))?;
    // Make the unlink durable before marking the job complete.
    sync_parent_dir(target.parent(), policy)?;
    if should_crash(faults, FaultPoint::MaterializeAfterRenameBeforeComplete) {
        return Ok(JobOutcome::Crashed(
            FaultPoint::MaterializeAfterRenameBeforeComplete,
        ));
    }
    store.mark_materialization_complete(&job.job_id, now_ms)?;
    Ok(JobOutcome::Completed)
}

/// The current on-disk state of a target, read without following a symlink and
/// bounded to the materialization cap.
enum CurrentTarget {
    Absent,
    Present(Vec<u8>),
    /// Present but larger than the cap (or otherwise not comparable). Never
    /// matches a preimage/desired hash, so it always routes to conflict.
    Oversized,
}

fn read_current_no_follow(target: &Path) -> Result<CurrentTarget, MaterializeError> {
    let meta = match std::fs::symlink_metadata(target) {
        Ok(meta) => meta,
        Err(err) if err.kind() == ErrorKind::NotFound => return Ok(CurrentTarget::Absent),
        Err(err) => return Err(MaterializeError::io(target, &err)),
    };
    let ft = meta.file_type();
    if ft.is_symlink() {
        return Err(MaterializeError::SymlinkTarget);
    }
    if !ft.is_file() {
        // A directory (or other) at the target name is not our content.
        return Ok(CurrentTarget::Oversized);
    }
    // Bounded read: at most cap+1 bytes; more ⇒ Oversized.
    let file = std::fs::File::open(target).map_err(|e| MaterializeError::io(target, &e))?;
    let mut limited = file.take((MAX_MATERIALIZE_BYTES as u64) + 1);
    let mut buf = Vec::new();
    limited
        .read_to_end(&mut buf)
        .map_err(|e| MaterializeError::io(target, &e))?;
    if buf.len() > MAX_MATERIALIZE_BYTES {
        return Ok(CurrentTarget::Oversized);
    }
    Ok(CurrentTarget::Present(buf))
}

/// Whether the current on-disk state matches the job's expected preimage.
fn preimage_matches(preimage: &Preimage, current: &CurrentTarget) -> bool {
    match (preimage, current) {
        (Preimage::Absent, CurrentTarget::Absent) => true,
        (Preimage::Present(expected), CurrentTarget::Present(bytes)) => {
            &hex_sha256(bytes) == expected
        }
        _ => false,
    }
}

/// Resolve a workspace-relative forward-slash path to an absolute target under
/// `root`, rejecting escapes, absolute inputs, and path-floor entries.
fn resolve_target(root: &Path, rel: &str) -> Result<PathBuf, MaterializeError> {
    if rel.is_empty() || is_excluded_file(rel) {
        return Err(MaterializeError::UnsafeTargetPath);
    }
    let mut out = root.to_path_buf();
    for segment in rel.split('/') {
        // Reject empty (`a//b`), current (`.`), parent (`..`), and any segment
        // containing a backslash or drive-colon (Windows escape shapes).
        if segment.is_empty()
            || segment == "."
            || segment == ".."
            || segment.contains('\\')
            || segment.contains(':')
        {
            return Err(MaterializeError::UnsafeTargetPath);
        }
        out.push(segment);
    }
    Ok(out)
}

/// Refuse every symlink/reparse point strictly below the already-canonicalized
/// workspace root through a target. Capture never owns paths reached through
/// aliased directories, even when the alias resolves elsewhere inside the
/// workspace, so both projection probes and secret materialization use this
/// component walk.
fn ensure_target_symlink_free(root: &Path, target: &Path) -> Result<(), MaterializeError> {
    let relative = target
        .strip_prefix(root)
        .map_err(|_| MaterializeError::UnsafeTargetPath)?;
    let mut current = root.to_path_buf();
    for component in relative.components() {
        current.push(component);
        reject_link_or_reparse(&current)?;
    }
    Ok(())
}

fn reject_link_or_reparse(path: &Path) -> Result<(), MaterializeError> {
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(err) if err.kind() == ErrorKind::NotFound => return Ok(()),
        Err(err) => return Err(MaterializeError::io(path, &err)),
    };
    if metadata.file_type().is_symlink() || metadata_is_reparse_point(&metadata) {
        return Err(MaterializeError::SymlinkTarget);
    }
    Ok(())
}

#[cfg(windows)]
fn metadata_is_reparse_point(metadata: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn metadata_is_reparse_point(_metadata: &std::fs::Metadata) -> bool {
    false
}

fn temp_sibling(target: &Path, job_id: &str) -> PathBuf {
    sibling_with_name(target, &format!(".dohc-write-{}.tmp", sanitize(job_id)))
}

fn conflict_sibling(target: &Path, job_id: &str) -> PathBuf {
    let base = target
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("target");
    sibling_with_name(target, &format!("{base}.{}.conflict", sanitize(job_id)))
}

fn sibling_with_name(target: &Path, name: &str) -> PathBuf {
    match target.parent() {
        Some(parent) => parent.join(name),
        None => PathBuf::from(name),
    }
}

/// A job id may be an arbitrary identifier; keep only filesystem-safe chars for
/// the temp/conflict sibling name.
fn sanitize(id: &str) -> String {
    id.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

fn write_temp(tmp: &Path, content: &[u8]) -> Result<std::fs::File, MaterializeError> {
    use std::io::Write as _;
    // Restrictive mode where supported; truncate any stale temp.
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut file = opts.open(tmp).map_err(|e| MaterializeError::io(tmp, &e))?;
    file.write_all(content)
        .map_err(|e| MaterializeError::io(tmp, &e))?;
    Ok(file)
}

/// Create a secret plaintext temp as a brand-new, non-following filesystem
/// entry. A stale regular temp is unlinked and exclusive creation is retried
/// once; a symlink, junction, or other reparse point is refused.
fn write_secret_temp_no_follow(
    tmp: &Path,
    content: &[u8],
) -> Result<std::fs::File, MaterializeError> {
    use std::io::Write as _;
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
        opts.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let mut file = match opts.open(tmp) {
        Ok(file) => file,
        Err(err) if err.kind() == ErrorKind::AlreadyExists => {
            let metadata = std::fs::symlink_metadata(tmp)
                .map_err(|metadata_err| MaterializeError::io(tmp, &metadata_err))?;
            if metadata.file_type().is_symlink() || metadata_is_reparse_point(&metadata) {
                return Err(MaterializeError::SymlinkTarget);
            }
            if !metadata.file_type().is_file() {
                return Err(MaterializeError::io(tmp, &err));
            }
            std::fs::remove_file(tmp)
                .map_err(|remove_err| MaterializeError::io(tmp, &remove_err))?;
            opts.open(tmp)
                .map_err(|retry_err| MaterializeError::io(tmp, &retry_err))?
        }
        Err(err) => return Err(MaterializeError::io(tmp, &err)),
    };
    if let Err(err) = file.write_all(content) {
        drop(file);
        let _ = std::fs::remove_file(tmp);
        return Err(MaterializeError::io(tmp, &err));
    }
    Ok(file)
}

fn flush_temp_file(
    file: &std::fs::File,
    tmp: &Path,
    policy: DurabilityPolicy,
) -> Result<(), MaterializeError> {
    if policy.fsync_file {
        file.sync_all().map_err(|e| MaterializeError::io(tmp, &e))?;
    }
    Ok(())
}

/// Sync the parent directory AFTER the rename so the directory entry change (the
/// replace) is durable. POSIX only; on Windows `std` exposes no portable
/// directory sync, so this is a documented no-op there (an honestly-scoped
/// durability limit — `per_os()` sets `fsync_parent_dir = false` off POSIX).
fn sync_parent_dir(
    parent: Option<&Path>,
    policy: DurabilityPolicy,
) -> Result<(), MaterializeError> {
    if policy.fsync_parent_dir
        && let Some(dir) = parent
    {
        #[cfg(unix)]
        {
            let dirf = std::fs::File::open(dir).map_err(|e| MaterializeError::io(dir, &e))?;
            dirf.sync_all().map_err(|e| MaterializeError::io(dir, &e))?;
        }
        #[cfg(not(unix))]
        {
            let _ = dir; // documented no-op off POSIX
        }
    }
    Ok(())
}

/// Whether an io error is a transient sharing/lock condition worth retrying
/// (Windows AV/indexer `ERROR_SHARING_VIOLATION` = os error 32, or a permission
/// denial std maps such handles to). A non-transient error is returned at once.
fn is_transient_lock(err: &std::io::Error) -> bool {
    if err.kind() == ErrorKind::PermissionDenied {
        return true;
    }
    #[cfg(windows)]
    {
        // ERROR_SHARING_VIOLATION (32), ERROR_LOCK_VIOLATION (33),
        // ERROR_ACCESS_DENIED (5).
        matches!(err.raw_os_error(), Some(32) | Some(33) | Some(5))
    }
    #[cfg(not(windows))]
    {
        false
    }
}

/// Atomic replace with bounded retry (`MAX_REPLACE_ATTEMPTS`). On transient
/// sharing violations it retries; on exhaustion it fails closed with
/// [`MaterializeError::FileLocked`] and removes the temp, leaving the job
/// pending for startup replay. A non-transient error surfaces immediately.
fn replace_with_bounded_retry(
    tmp: &Path,
    target: &Path,
    replacer: &dyn AtomicReplacer,
    backoff: &dyn ReplaceBackoff,
) -> Result<(), MaterializeError> {
    let mut attempt = 0u32;
    loop {
        attempt += 1;
        match replacer.try_replace(tmp, target) {
            Ok(()) => return Ok(()),
            Err(err) if is_transient_lock(&err) => {
                if attempt >= MAX_REPLACE_ATTEMPTS {
                    let _ = std::fs::remove_file(tmp); // best-effort cleanup
                    return Err(MaterializeError::FileLocked);
                }
                // Back off before the next attempt so a real (tens-of-ms)
                // AV/indexer sharing violation is actually absorbed. Injectable,
                // so tests stay fast.
                backoff.wait_before_retry(attempt);
            }
            Err(err) => {
                let _ = std::fs::remove_file(tmp);
                return Err(MaterializeError::io(target, &err));
            }
        }
    }
}

/// A single non-retried atomic rename (used for the conflict sibling, which has
/// no contending handle).
fn rename_no_follow(
    from: &Path,
    to: &Path,
    replacer: &dyn AtomicReplacer,
) -> Result<(), MaterializeError> {
    replacer
        .try_replace(from, to)
        .map_err(|e| MaterializeError::io(to, &e))
}

#[cfg(test)]
mod tests {
    use super::*;
    use dohc_engine_storage::{
        FaultAction, MaterializationJobSpec, NoFaults, StorageError, enqueue_job,
    };
    use std::sync::atomic::{AtomicUsize, Ordering};

    static SCRATCH_SEQUENCE: AtomicUsize = AtomicUsize::new(0);

    struct Scratch {
        root: PathBuf,
    }

    impl Scratch {
        fn new(tag: &str) -> Self {
            let root = std::env::temp_dir().join(format!(
                "dohc-materialize-unit-{tag}-{}-{}",
                std::process::id(),
                SCRATCH_SEQUENCE.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir_all(root.join(".dohc").join("engine"))
                .expect("create scratch engine directory");
            Scratch { root }
        }

        fn db(&self) -> PathBuf {
            self.root.join(".dohc").join("engine").join("engine.db")
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    fn create_directory_alias(link: &Path, target: &Path) {
        #[cfg(unix)]
        std::os::unix::fs::symlink(target, link).expect("create directory symlink");

        #[cfg(windows)]
        {
            let status = std::process::Command::new("cmd")
                .arg("/C")
                .arg("mklink")
                .arg("/J")
                .arg(link)
                .arg(target)
                .status()
                .expect("spawn mklink /J");
            assert!(
                status.success(),
                "junction creation must succeed without elevation"
            );
        }
    }

    struct ConflictFault {
        target: PathBuf,
    }

    impl FaultInjector for ConflictFault {
        fn poll(&self, point: FaultPoint) -> FaultAction {
            if point == FaultPoint::MaterializeBeforePreimageRevalidate {
                std::fs::write(&self.target, b"EXTERNAL=newer\n")
                    .expect("inject newer external content");
            }
            FaultAction::Continue
        }
    }

    struct FailFirstRemove {
        calls: AtomicUsize,
    }

    impl SecretTempRemover for FailFirstRemove {
        fn remove_file(&self, _path: &Path) -> std::io::Result<()> {
            self.calls.fetch_add(1, Ordering::Relaxed);
            Err(std::io::Error::new(
                ErrorKind::PermissionDenied,
                "injected transient sharing violation",
            ))
        }
    }

    #[test]
    fn projection_probe_rejects_an_in_workspace_symlinked_ancestor() {
        let scratch = Scratch::new("projection-ancestor-alias");
        let real = scratch.root.join("real");
        std::fs::create_dir_all(&real).expect("create real directory");
        std::fs::write(real.join("owned.md"), b"real content").expect("write aliased target");
        let alias = scratch.root.join("alias");
        create_directory_alias(&alias, &real);

        assert_eq!(
            probe_projection_target(
                &scratch.root,
                "alias/owned.md",
                ProjectionTargetKind::Plaintext,
            ),
            ProjectionTargetState::UntrackedContent,
            "capture never owns a file reached through an aliased directory"
        );
        assert_eq!(
            probe_projection_target(
                &scratch.root,
                "alias/missing.md",
                ProjectionTargetKind::Plaintext,
            ),
            ProjectionTargetState::UntrackedContent,
            "an absent leaf beneath an aliased directory is not an owned create target"
        );

        #[cfg(windows)]
        std::fs::remove_dir(&alias).expect("remove test junction");
    }

    #[test]
    fn secret_conflict_failed_best_effort_remove_keeps_cleanup_guard_armed() {
        // MUTATION: disarm the plaintext-temp guard before/after the failed
        // best-effort conflict remove -> the secret temp survives this return.
        let scratch = Scratch::new("secret-conflict-remove");
        let target = scratch.root.join(".env");
        std::fs::write(&target, b"ORIGINAL=preimage\n").expect("write initial target");
        let mut store = EngineStore::open(&scratch.db(), 1).expect("open store");
        let staged = b"encrypted-placeholder";
        let staged_sha = store.put_binary_blob(staged).expect("stage placeholder");
        store
            .write_with(&NoFaults, |tx| {
                enqueue_job(
                    tx,
                    &MaterializationJobSpec {
                        job_id: "secret-mat_conflict-remove".to_owned(),
                        target_path: ".env".to_owned(),
                        content_sha256: staged_sha.clone(),
                        preimage: Preimage::Absent,
                        target_generation: 1,
                        now_ms: 1,
                    },
                )?;
                Ok::<_, StorageError>(())
            })
            .expect("enqueue secret job");
        let job = store
            .load_materialization_job("secret-mat_conflict-remove")
            .expect("load job")
            .expect("secret job");
        let remover = FailFirstRemove {
            calls: AtomicUsize::new(0),
        };

        let outcome = materialize_secret_one_with_remover(
            &store,
            &scratch.root,
            &job,
            b"SECRET=plaintext\n",
            DurabilityPolicy::none(),
            &StdReplacer,
            &NoBackoff,
            2,
            &ConflictFault {
                target: target.clone(),
            },
            &remover,
        )
        .expect("conflict is a terminal outcome");

        assert_eq!(outcome, JobOutcome::Conflict);
        assert_eq!(remover.calls.load(Ordering::Relaxed), 1);
        assert_eq!(
            std::fs::read(&target).expect("read external target"),
            b"EXTERNAL=newer\n"
        );
        let leaked = std::fs::read_dir(&scratch.root)
            .expect("list workspace")
            .filter_map(Result::ok)
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.starts_with(".dohc-write-secret-mat-"))
            .collect::<Vec<_>>();
        assert!(
            leaked.is_empty(),
            "plaintext secret temps leaked: {leaked:?}"
        );
    }
}
