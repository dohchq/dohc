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
//!
//! Secret plaintext uses a stronger path-binding rule. Unix pins the workspace
//! root and target parent with `openat2`/`openat`, then creates, reads, unlinks,
//! renames, and syncs relative to that parent descriptor. Windows validates and
//! retains non-delete-shared handles for the root and every below-root target
//! ancestor until the name-based replace completes. The content preimage race
//! above remains; the ancestor-redirection race does not.

use crate::bounds::{MAX_CAPTURE_BINARY_BYTES, MAX_CAPTURE_TEXT_BYTES};
use crate::floor::is_excluded_file;
use crate::media::{is_text_media_type, media_type_for_path};
use dohc_engine_storage::{
    EngineStore, FaultInjector, FaultPoint, MaterializationJob, MaterializationOperation, Preimage,
    StorageError, hex_sha256,
};
use std::ffi::OsStr;
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

    /// Secret writes supply the only replacement operation they may execute:
    /// one bound to the pinned parent directory. Specialized test replacers
    /// may return an injected error or wrap this operation.
    #[doc(hidden)]
    fn try_replace_secret(
        &self,
        _from: &Path,
        _to: &Path,
        pinned_replace: &mut dyn FnMut() -> std::io::Result<()>,
    ) -> std::io::Result<()> {
        pinned_replace()
    }
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

    fn remove_pinned(
        &self,
        parent: &SecretParentGuard,
        name: &OsStr,
        path: &Path,
    ) -> std::io::Result<()> {
        let _ = (parent, name);
        self.remove_file(path)
    }
}

#[derive(Debug, Clone, Copy, Default)]
struct StdSecretTempRemover;

impl SecretTempRemover for StdSecretTempRemover {
    fn remove_file(&self, path: &Path) -> std::io::Result<()> {
        std::fs::remove_file(path)
    }

    fn remove_pinned(
        &self,
        parent: &SecretParentGuard,
        name: &OsStr,
        path: &Path,
    ) -> std::io::Result<()> {
        parent.remove_file(name, path)
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
    materialize_secret_delete_with_hook(store, root, target, job, policy, now_ms, faults, || {})
}

#[allow(
    clippy::too_many_arguments,
    reason = "the test hook deterministically exercises the read-to-open race"
)]
fn materialize_secret_delete_with_hook(
    store: &EngineStore,
    root: &Path,
    target: &Path,
    job: &MaterializationJob,
    policy: DurabilityPolicy,
    now_ms: i64,
    faults: &dyn FaultInjector,
    before_parent_open: impl FnOnce(),
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
    let parent_path = target.parent().ok_or(MaterializeError::UnsafeTargetPath)?;
    let target_name = target
        .file_name()
        .ok_or(MaterializeError::UnsafeTargetPath)?;
    before_parent_open();
    let Some(parent) = SecretParentGuard::open_existing(root, target, parent_path)? else {
        store.mark_materialization_complete(&job.job_id, now_ms)?;
        return Ok(JobOutcome::AlreadyMaterialized);
    };
    // Re-read immediately before unlinking to preserve no-follow semantics.
    // Any regular file currently at the active secret's own resolved path is
    // the disk projection being retired; no plaintext hash or conflict copy is
    // needed (or safe) for a secret delete.
    let current_now = parent.read_current(target_name, target)?;
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
    parent
        .remove_file(target_name, target)
        .map_err(|err| MaterializeError::io(target, &err))?;
    parent.sync(policy)?;
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
    parent: Option<&'a SecretParentGuard>,
    name: Option<&'a OsStr>,
    armed: bool,
}

impl<'a> SecretPlaintextTempCleanup<'a> {
    fn new(
        path: &'a Path,
        parent: Option<&'a SecretParentGuard>,
        name: Option<&'a OsStr>,
        armed: bool,
    ) -> Self {
        SecretPlaintextTempCleanup {
            path,
            parent,
            name,
            armed,
        }
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
            if let (Some(parent), Some(name)) = (self.parent, self.name) {
                let _ = parent.remove_file(name, self.path);
            } else {
                let _ = std::fs::remove_file(self.path);
            }
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

    // Ensure and pin the real parent directory. Secret writes use this same
    // directory object for create, revalidation, cleanup, rename, and fsync.
    let secret_parent = if let Some(root) = secret_root {
        let parent = target.parent().ok_or(MaterializeError::UnsafeTargetPath)?;
        Some(SecretParentGuard::open_or_create(root, target, parent)?)
    } else {
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|e| MaterializeError::io(parent, &e))?;
        }
        None
    };

    // Step 2: sibling temp file, bounded, restrictive mode.
    let tmp = temp_sibling(target, &job.job_id);
    let tmp_name = tmp
        .file_name()
        .ok_or(MaterializeError::UnsafeTargetPath)?
        .to_os_string();
    let target_name = target
        .file_name()
        .ok_or(MaterializeError::UnsafeTargetPath)?
        .to_os_string();
    // Secret writes never preserve a plaintext temp on a returned error. The
    // ordinary materializer keeps its established crash/replay behavior.
    let mut secret_temp_cleanup = SecretPlaintextTempCleanup::new(
        &tmp,
        secret_parent.as_ref(),
        Some(tmp_name.as_os_str()),
        false,
    );
    let temp_file = if preserve_conflict_artifact {
        write_temp(&tmp, content)?
    } else {
        let parent = secret_parent
            .as_ref()
            .ok_or(MaterializeError::UnsafeTargetPath)?;
        let file = parent.write_temp(tmp_name.as_os_str(), &tmp, content)?;
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
    let current_now = if let Some(parent) = secret_parent.as_ref() {
        parent.read_current(target_name.as_os_str(), target)?
    } else {
        read_current_no_follow(target)?
    };
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
        } else if secret_temp_remover
            .remove_pinned(
                secret_parent
                    .as_ref()
                    .ok_or(MaterializeError::UnsafeTargetPath)?,
                tmp_name.as_os_str(),
                &tmp,
            )
            .is_ok()
        {
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
    if let Some(parent) = secret_parent.as_ref() {
        replace_secret_with_bounded_retry(
            parent,
            tmp_name.as_os_str(),
            target_name.as_os_str(),
            &tmp,
            target,
            replacer,
            backoff,
        )?;
        parent.sync(policy)?;
    } else {
        replace_with_bounded_retry(&tmp, target, replacer, backoff)?;
        sync_parent_dir(target.parent(), policy)?;
    }
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
    #[cfg(unix)]
    let file = {
        use rustix::fs::{Mode, OFlags};
        match rustix::fs::openat(
            rustix::fs::CWD,
            target,
            OFlags::RDONLY | OFlags::NONBLOCK | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        ) {
            Ok(fd) => std::fs::File::from(fd),
            Err(err) => {
                return classify_current_nofollow_failure(
                    rustix::fs::CWD,
                    target.as_os_str(),
                    target,
                    err,
                );
            }
        }
    };

    #[cfg(windows)]
    let file = {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
        const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
        let mut options = std::fs::OpenOptions::new();
        options
            .read(true)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT);
        match options.open(target) {
            Ok(file) => file,
            Err(err) if err.kind() == ErrorKind::NotFound => return Ok(CurrentTarget::Absent),
            Err(err) => return Err(MaterializeError::io(target, &err)),
        }
    };

    #[cfg(not(any(unix, windows)))]
    let file = match std::fs::File::open(target) {
        Ok(file) => file,
        Err(err) if err.kind() == ErrorKind::NotFound => return Ok(CurrentTarget::Absent),
        Err(err) => return Err(MaterializeError::io(target, &err)),
    };

    read_current_file(file, target)
}

fn read_current_file(
    file: std::fs::File,
    display_path: &Path,
) -> Result<CurrentTarget, MaterializeError> {
    let metadata = file
        .metadata()
        .map_err(|err| MaterializeError::io(display_path, &err))?;
    if metadata.file_type().is_symlink() || metadata_is_reparse_point(&metadata) {
        return Err(MaterializeError::SymlinkTarget);
    }
    if !metadata.is_file() {
        return Ok(CurrentTarget::Oversized);
    }
    let mut limited = file.take((MAX_MATERIALIZE_BYTES as u64) + 1);
    let mut buf = Vec::new();
    limited
        .read_to_end(&mut buf)
        .map_err(|err| MaterializeError::io(display_path, &err))?;
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

/// Pins the real parent directory used by every secret temp operation.
///
/// Unix operations are descriptor-relative. Windows keeps validated handles to
/// the root and every below-root target ancestor open without delete sharing,
/// so the kernel rejects a concurrent rename/removal of those directories while
/// the final name-based operations run.
struct SecretParentGuard {
    #[cfg(unix)]
    parent_path: PathBuf,
    #[cfg(unix)]
    parent_fd: rustix::fd::OwnedFd,
    #[cfg(windows)]
    _locked_directories: Vec<std::fs::File>,
}

impl SecretParentGuard {
    fn open_or_create(
        root: &Path,
        target: &Path,
        parent_path: &Path,
    ) -> Result<Self, MaterializeError> {
        let _ = target;
        let relative_parent = parent_path
            .strip_prefix(root)
            .map_err(|_| MaterializeError::UnsafeTargetPath)?;

        #[cfg(unix)]
        {
            let parent_fd = open_secret_parent_unix(root, relative_parent, parent_path)?;
            Ok(SecretParentGuard {
                parent_path: parent_path.to_path_buf(),
                parent_fd,
            })
        }

        #[cfg(windows)]
        {
            let locked_directories =
                open_secret_parent_windows(root, relative_parent, parent_path)?;
            Ok(SecretParentGuard {
                _locked_directories: locked_directories,
            })
        }

        #[cfg(not(any(unix, windows)))]
        {
            std::fs::create_dir_all(parent_path)
                .map_err(|err| MaterializeError::io(parent_path, &err))?;
            ensure_secret_target_symlink_free(root, target)?;
            Ok(SecretParentGuard {})
        }
    }

    fn open_existing(
        root: &Path,
        target: &Path,
        parent_path: &Path,
    ) -> Result<Option<Self>, MaterializeError> {
        let _ = target;
        let relative_parent = parent_path
            .strip_prefix(root)
            .map_err(|_| MaterializeError::UnsafeTargetPath)?;

        #[cfg(unix)]
        {
            let Some(parent_fd) =
                open_existing_secret_parent_unix(root, relative_parent, parent_path)?
            else {
                return Ok(None);
            };
            Ok(Some(SecretParentGuard {
                parent_path: parent_path.to_path_buf(),
                parent_fd,
            }))
        }

        #[cfg(windows)]
        {
            let Some(locked_directories) =
                open_existing_secret_parent_windows(root, relative_parent)?
            else {
                return Ok(None);
            };
            Ok(Some(SecretParentGuard {
                _locked_directories: locked_directories,
            }))
        }

        #[cfg(not(any(unix, windows)))]
        {
            match std::fs::symlink_metadata(parent_path) {
                Ok(metadata) if metadata.is_dir() => {}
                Ok(_) => {
                    let err = std::io::Error::new(
                        ErrorKind::NotADirectory,
                        "secret parent is not a directory",
                    );
                    return Err(MaterializeError::io(parent_path, &err));
                }
                Err(err) if err.kind() == ErrorKind::NotFound => return Ok(None),
                Err(err) => return Err(MaterializeError::io(parent_path, &err)),
            }
            ensure_secret_target_symlink_free(root, target)?;
            Ok(Some(SecretParentGuard {}))
        }
    }

    fn read_current(
        &self,
        name: &OsStr,
        display_path: &Path,
    ) -> Result<CurrentTarget, MaterializeError> {
        #[cfg(unix)]
        {
            read_current_at_unix(&self.parent_fd, name, display_path)
        }

        #[cfg(not(unix))]
        {
            let _ = name;
            read_current_no_follow(display_path)
        }
    }

    fn write_temp(
        &self,
        name: &OsStr,
        display_path: &Path,
        content: &[u8],
    ) -> Result<std::fs::File, MaterializeError> {
        #[cfg(unix)]
        {
            write_secret_temp_at_unix(&self.parent_fd, name, display_path, content)
        }

        #[cfg(not(unix))]
        {
            let _ = name;
            write_secret_temp_no_follow(display_path, content)
        }
    }

    fn remove_file(&self, name: &OsStr, display_path: &Path) -> std::io::Result<()> {
        #[cfg(unix)]
        {
            let _ = display_path;
            rustix::fs::unlinkat(&self.parent_fd, name, rustix::fs::AtFlags::empty())
                .map_err(std::io::Error::from)
        }

        #[cfg(not(unix))]
        {
            let _ = name;
            std::fs::remove_file(display_path)
        }
    }

    fn rename(
        &self,
        from_name: &OsStr,
        to_name: &OsStr,
        from_path: &Path,
        to_path: &Path,
    ) -> std::io::Result<()> {
        #[cfg(unix)]
        {
            let _ = (from_path, to_path);
            rustix::fs::renameat(&self.parent_fd, from_name, &self.parent_fd, to_name)
                .map_err(std::io::Error::from)
        }

        #[cfg(not(unix))]
        {
            let _ = (from_name, to_name);
            std::fs::rename(from_path, to_path)
        }
    }

    fn sync(&self, policy: DurabilityPolicy) -> Result<(), MaterializeError> {
        if !policy.fsync_parent_dir {
            return Ok(());
        }

        #[cfg(unix)]
        {
            // Sync through `std`, not `rustix::fs::fsync`: on macOS `sync_all`
            // issues F_FULLFSYNC, which flushes the drive write cache, and
            // plain fsync does not. Duplicating the PINNED fd keeps durability
            // identical to `sync_parent_dir` on the non-secret path without
            // giving up the pin — the duplicate closes with `file`, the
            // original stays open.
            let duplicate = rustix::io::fcntl_dupfd_cloexec(&self.parent_fd, 0)
                .map_err(std::io::Error::from)
                .map_err(|err| MaterializeError::io(&self.parent_path, &err))?;
            std::fs::File::from(duplicate)
                .sync_all()
                .map_err(|err| MaterializeError::io(&self.parent_path, &err))
        }

        #[cfg(not(unix))]
        {
            Ok(())
        }
    }
}

#[cfg(unix)]
fn open_secret_parent_unix(
    root: &Path,
    relative_parent: &Path,
    display_parent: &Path,
) -> Result<rustix::fd::OwnedFd, MaterializeError> {
    use rustix::fs::{Mode, OFlags};

    let root_fd = rustix::fs::openat(
        rustix::fs::CWD,
        root,
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
    )
    .map_err(std::io::Error::from)
    .map_err(|err| MaterializeError::io(root, &err))?;

    if relative_parent.as_os_str().is_empty() {
        return Ok(root_fd);
    }

    #[cfg(target_os = "linux")]
    {
        use rustix::fs::ResolveFlags;
        match rustix::fs::openat2(
            &root_fd,
            relative_parent,
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC,
            Mode::empty(),
            ResolveFlags::NO_SYMLINKS | ResolveFlags::BENEATH,
        ) {
            Ok(parent_fd) => return Ok(parent_fd),
            Err(err) if err == rustix::io::Errno::NOSYS || err == rustix::io::Errno::INVAL => {}
            Err(err) if err == rustix::io::Errno::NOENT => {}
            Err(err) if err == rustix::io::Errno::LOOP => {
                return Err(MaterializeError::SymlinkTarget);
            }
            Err(err) => {
                let err = std::io::Error::from(err);
                return Err(MaterializeError::io(display_parent, &err));
            }
        }
    }

    walk_secret_parent_unix(root_fd, relative_parent, display_parent)
}

#[cfg(unix)]
fn open_existing_secret_parent_unix(
    root: &Path,
    relative_parent: &Path,
    display_parent: &Path,
) -> Result<Option<rustix::fd::OwnedFd>, MaterializeError> {
    use rustix::fs::{Mode, OFlags};

    let root_fd = rustix::fs::openat(
        rustix::fs::CWD,
        root,
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
    )
    .map_err(std::io::Error::from)
    .map_err(|err| MaterializeError::io(root, &err))?;

    if relative_parent.as_os_str().is_empty() {
        return Ok(Some(root_fd));
    }

    #[cfg(target_os = "linux")]
    {
        use rustix::fs::ResolveFlags;
        match rustix::fs::openat2(
            &root_fd,
            relative_parent,
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC,
            Mode::empty(),
            ResolveFlags::NO_SYMLINKS | ResolveFlags::BENEATH,
        ) {
            Ok(parent_fd) => return Ok(Some(parent_fd)),
            Err(err) if err == rustix::io::Errno::NOSYS || err == rustix::io::Errno::INVAL => {}
            Err(err) if err == rustix::io::Errno::NOENT => return Ok(None),
            Err(err) if err == rustix::io::Errno::LOOP => {
                return Err(MaterializeError::SymlinkTarget);
            }
            Err(err) => {
                let err = std::io::Error::from(err);
                return Err(MaterializeError::io(display_parent, &err));
            }
        }
    }

    walk_existing_secret_parent_unix(root_fd, relative_parent, display_parent)
}

#[cfg(unix)]
fn walk_existing_secret_parent_unix(
    mut current: rustix::fd::OwnedFd,
    relative_parent: &Path,
    display_parent: &Path,
) -> Result<Option<rustix::fd::OwnedFd>, MaterializeError> {
    use rustix::fs::{Mode, OFlags};

    for component in relative_parent.components() {
        let name = component.as_os_str();
        let flags = OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC;
        current = match rustix::fs::openat(&current, name, flags, Mode::empty()) {
            Ok(fd) => fd,
            Err(err) if err == rustix::io::Errno::NOENT => return Ok(None),
            Err(err) => {
                return Err(classify_nofollow_failure(
                    &current,
                    name,
                    display_parent,
                    err,
                ));
            }
        };
    }
    Ok(Some(current))
}

#[cfg(unix)]
fn walk_secret_parent_unix(
    current: rustix::fd::OwnedFd,
    relative_parent: &Path,
    display_parent: &Path,
) -> Result<rustix::fd::OwnedFd, MaterializeError> {
    walk_secret_parent_unix_with_hook(current, relative_parent, display_parent, |_, _| {})
}

#[cfg(unix)]
fn walk_secret_parent_unix_with_hook(
    mut current: rustix::fd::OwnedFd,
    relative_parent: &Path,
    display_parent: &Path,
    mut after_mkdir: impl FnMut(&rustix::fd::OwnedFd, &OsStr),
) -> Result<rustix::fd::OwnedFd, MaterializeError> {
    use rustix::fs::{Mode, OFlags};

    for component in relative_parent.components() {
        let name = component.as_os_str();
        let flags = OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC;
        let next = match rustix::fs::openat(&current, name, flags, Mode::empty()) {
            Ok(fd) => fd,
            Err(err) if err == rustix::io::Errno::NOENT => {
                match rustix::fs::mkdirat(&current, name, Mode::from_raw_mode(0o777)) {
                    Ok(()) => {}
                    Err(mkdir_err) if mkdir_err == rustix::io::Errno::EXIST => {}
                    Err(mkdir_err) => {
                        let mkdir_err = std::io::Error::from(mkdir_err);
                        return Err(MaterializeError::io(display_parent, &mkdir_err));
                    }
                }
                after_mkdir(&current, name);
                rustix::fs::openat(&current, name, flags, Mode::empty()).map_err(|open_err| {
                    classify_nofollow_failure(&current, name, display_parent, open_err)
                })?
            }
            Err(err) => {
                return Err(classify_nofollow_failure(
                    &current,
                    name,
                    display_parent,
                    err,
                ));
            }
        };
        current = next;
    }
    Ok(current)
}

/// Classify a failed no-follow open of `name` under `parent_fd`.
///
/// `O_NOFOLLOW` does NOT report a symlink uniformly: with `O_DIRECTORY` Linux
/// returns `ENOTDIR`, FreeBSD returns `EMLINK` and NetBSD `EFTYPE`, and only
/// the non-directory case gives `ELOOP`. Asking the filesystem what the entry
/// actually is turns every one of those into the same honest answer instead of
/// a generic IO error — which matters because the two surface differently: a
/// symlink target is a refusal, an IO error leaves the job pending and retrying.
#[cfg(unix)]
fn classify_nofollow_failure(
    parent_fd: &rustix::fd::OwnedFd,
    name: &OsStr,
    display_path: &Path,
    err: rustix::io::Errno,
) -> MaterializeError {
    let is_symlink = rustix::fs::statat(parent_fd, name, rustix::fs::AtFlags::SYMLINK_NOFOLLOW)
        .is_ok_and(|stat| {
            rustix::fs::FileType::from_raw_mode(stat.st_mode) == rustix::fs::FileType::Symlink
        });
    if is_symlink {
        return MaterializeError::SymlinkTarget;
    }
    let err = std::io::Error::from(err);
    MaterializeError::io(display_path, &err)
}

#[cfg(unix)]
fn classify_current_nofollow_failure<Fd: std::os::fd::AsFd>(
    parent_fd: Fd,
    name: &OsStr,
    display_path: &Path,
    open_err: rustix::io::Errno,
) -> Result<CurrentTarget, MaterializeError> {
    match rustix::fs::statat(parent_fd, name, rustix::fs::AtFlags::SYMLINK_NOFOLLOW) {
        Ok(stat) => match rustix::fs::FileType::from_raw_mode(stat.st_mode) {
            rustix::fs::FileType::Symlink => Err(MaterializeError::SymlinkTarget),
            rustix::fs::FileType::RegularFile => {
                let open_err = std::io::Error::from(open_err);
                Err(MaterializeError::io(display_path, &open_err))
            }
            _ => Ok(CurrentTarget::Oversized),
        },
        Err(stat_err) if stat_err == rustix::io::Errno::NOENT => Ok(CurrentTarget::Absent),
        Err(_) => {
            let open_err = std::io::Error::from(open_err);
            Err(MaterializeError::io(display_path, &open_err))
        }
    }
}

#[cfg(windows)]
fn open_secret_parent_windows(
    root: &Path,
    relative_parent: &Path,
    display_parent: &Path,
) -> Result<Vec<std::fs::File>, MaterializeError> {
    let mut locked = Vec::new();
    locked.push(open_locked_windows_directory(root)?);
    let mut current = root.to_path_buf();

    for component in relative_parent.components() {
        current.push(component.as_os_str());
        let directory = match open_locked_windows_directory(&current) {
            Ok(directory) => directory,
            Err(MaterializeError::Io {
                kind: ErrorKind::NotFound,
                ..
            }) => {
                match std::fs::create_dir(&current) {
                    Ok(()) => {}
                    Err(err) if err.kind() == ErrorKind::AlreadyExists => {}
                    Err(err) => return Err(MaterializeError::io(&current, &err)),
                }
                open_locked_windows_directory(&current)?
            }
            Err(err) => return Err(err),
        };
        locked.push(directory);
    }

    let _ = display_parent;
    Ok(locked)
}

#[cfg(windows)]
fn open_existing_secret_parent_windows(
    root: &Path,
    relative_parent: &Path,
) -> Result<Option<Vec<std::fs::File>>, MaterializeError> {
    let mut locked = Vec::new();
    locked.push(open_locked_windows_directory(root)?);
    let mut current = root.to_path_buf();

    for component in relative_parent.components() {
        current.push(component.as_os_str());
        match open_locked_windows_directory(&current) {
            Ok(directory) => locked.push(directory),
            Err(MaterializeError::Io {
                kind: ErrorKind::NotFound,
                ..
            }) => return Ok(None),
            Err(err) => return Err(err),
        }
    }
    Ok(Some(locked))
}

#[cfg(windows)]
fn open_locked_windows_directory(path: &Path) -> Result<std::fs::File, MaterializeError> {
    use std::os::windows::fs::OpenOptionsExt;

    const FILE_SHARE_READ: u32 = 0x0000_0001;
    const FILE_SHARE_WRITE: u32 = 0x0000_0002;
    const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
    const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;

    let mut options = std::fs::OpenOptions::new();
    options
        .read(true)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT);
    let directory = options
        .open(path)
        .map_err(|err| MaterializeError::io(path, &err))?;
    let metadata = directory
        .metadata()
        .map_err(|err| MaterializeError::io(path, &err))?;
    if metadata_is_reparse_point(&metadata) {
        return Err(MaterializeError::SymlinkTarget);
    }
    if !metadata.is_dir() {
        let err = std::io::Error::new(
            ErrorKind::NotADirectory,
            "secret ancestor is not a directory",
        );
        return Err(MaterializeError::io(path, &err));
    }
    Ok(directory)
}

#[cfg(unix)]
fn read_current_at_unix(
    parent_fd: &rustix::fd::OwnedFd,
    name: &OsStr,
    display_path: &Path,
) -> Result<CurrentTarget, MaterializeError> {
    use rustix::fs::{Mode, OFlags};

    let fd = match rustix::fs::openat(
        parent_fd,
        name,
        OFlags::RDONLY | OFlags::NONBLOCK | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
    ) {
        Ok(fd) => fd,
        Err(err) => {
            return classify_current_nofollow_failure(parent_fd, name, display_path, err);
        }
    };
    read_current_file(std::fs::File::from(fd), display_path)
}

#[cfg(unix)]
fn write_secret_temp_at_unix(
    parent_fd: &rustix::fd::OwnedFd,
    name: &OsStr,
    display_path: &Path,
    content: &[u8],
) -> Result<std::fs::File, MaterializeError> {
    use rustix::fs::{Mode, OFlags};
    use std::io::Write as _;

    let flags = OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC;
    let create = || {
        rustix::fs::openat(parent_fd, name, flags, Mode::from_raw_mode(0o600))
            .map(std::fs::File::from)
    };
    let mut file = match create() {
        Ok(file) => file,
        Err(err) if err == rustix::io::Errno::EXIST => {
            let stale = match rustix::fs::openat(
                parent_fd,
                name,
                OFlags::RDONLY | OFlags::NONBLOCK | OFlags::NOFOLLOW | OFlags::CLOEXEC,
                Mode::empty(),
            ) {
                Ok(fd) => std::fs::File::from(fd),
                Err(open_err) if open_err == rustix::io::Errno::LOOP => {
                    return Err(MaterializeError::SymlinkTarget);
                }
                Err(open_err) => {
                    let open_err = std::io::Error::from(open_err);
                    return Err(MaterializeError::io(display_path, &open_err));
                }
            };
            let metadata = stale
                .metadata()
                .map_err(|metadata_err| MaterializeError::io(display_path, &metadata_err))?;
            if !metadata.is_file() {
                let err = std::io::Error::from(ErrorKind::AlreadyExists);
                return Err(MaterializeError::io(display_path, &err));
            }
            drop(stale);
            rustix::fs::unlinkat(parent_fd, name, rustix::fs::AtFlags::empty())
                .map_err(std::io::Error::from)
                .map_err(|remove_err| MaterializeError::io(display_path, &remove_err))?;
            create()
                .map_err(std::io::Error::from)
                .map_err(|retry_err| MaterializeError::io(display_path, &retry_err))?
        }
        Err(err) if err == rustix::io::Errno::LOOP => {
            return Err(MaterializeError::SymlinkTarget);
        }
        Err(err) => {
            let err = std::io::Error::from(err);
            return Err(MaterializeError::io(display_path, &err));
        }
    };
    if let Err(err) = file.write_all(content) {
        drop(file);
        let _ = rustix::fs::unlinkat(parent_fd, name, rustix::fs::AtFlags::empty());
        return Err(MaterializeError::io(display_path, &err));
    }
    Ok(file)
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
#[cfg(not(unix))]
fn write_secret_temp_no_follow(
    tmp: &Path,
    content: &[u8],
) -> Result<std::fs::File, MaterializeError> {
    use std::io::Write as _;
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
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

fn replace_secret_with_bounded_retry(
    parent: &SecretParentGuard,
    tmp_name: &OsStr,
    target_name: &OsStr,
    tmp: &Path,
    target: &Path,
    replacer: &dyn AtomicReplacer,
    backoff: &dyn ReplaceBackoff,
) -> Result<(), MaterializeError> {
    let mut attempt = 0u32;
    loop {
        attempt += 1;
        let mut pinned_replace = || parent.rename(tmp_name, target_name, tmp, target);
        match replacer.try_replace_secret(tmp, target, &mut pinned_replace) {
            Ok(()) => return Ok(()),
            Err(err) if is_transient_lock(&err) => {
                if attempt >= MAX_REPLACE_ATTEMPTS {
                    let _ = parent.remove_file(tmp_name, tmp);
                    return Err(MaterializeError::FileLocked);
                }
                backoff.wait_before_retry(attempt);
            }
            Err(err) => {
                let _ = parent.remove_file(tmp_name, tmp);
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
        FaultAction, JobStatus, MaterializationJobSpec, NoFaults, StorageError, enqueue_job,
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

    fn prepare_secret_job(
        scratch: &Scratch,
        job_id: &str,
        target_path: &str,
    ) -> (EngineStore, MaterializationJob) {
        let mut store = EngineStore::open(&scratch.db(), 1).expect("open store");
        let staged = b"encrypted-placeholder";
        let staged_sha = store.put_binary_blob(staged).expect("stage placeholder");
        store
            .write_with(&NoFaults, |tx| {
                enqueue_job(
                    tx,
                    &MaterializationJobSpec {
                        job_id: job_id.to_owned(),
                        target_path: target_path.to_owned(),
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
            .load_materialization_job(job_id)
            .expect("load job")
            .expect("secret job");
        (store, job)
    }

    fn enqueue_write_job(
        store: &mut EngineStore,
        job_id: &str,
        target_path: &str,
        content: &[u8],
        created_at_ms: i64,
    ) {
        let content_sha256 = store.put_binary_blob(content).expect("stage content");
        store
            .write_with(&NoFaults, |tx| {
                enqueue_job(
                    tx,
                    &MaterializationJobSpec {
                        job_id: job_id.to_owned(),
                        target_path: target_path.to_owned(),
                        content_sha256: content_sha256.clone(),
                        preimage: Preimage::Absent,
                        target_generation: 1,
                        now_ms: created_at_ms,
                    },
                )?;
                Ok::<_, StorageError>(())
            })
            .expect("enqueue materialization job");
    }

    #[cfg(unix)]
    fn symlink_dir_for_test(target: &Path, link: &Path) -> bool {
        std::os::unix::fs::symlink(target, link).expect("create directory symlink");
        true
    }

    #[cfg(unix)]
    fn symlink_file_for_test(target: &Path, link: &Path) -> bool {
        std::os::unix::fs::symlink(target, link).expect("create file symlink");
        true
    }

    #[cfg(windows)]
    fn symlink_dir_for_test(target: &Path, link: &Path) -> bool {
        match std::os::windows::fs::symlink_dir(target, link) {
            Ok(()) => true,
            Err(err)
                if err.kind() == ErrorKind::PermissionDenied
                    || err.raw_os_error() == Some(1314) =>
            {
                eprintln!("skipping: Windows directory symlink privilege is unavailable: {err}");
                false
            }
            Err(err) => panic!("create directory symlink: {err}"),
        }
    }

    #[cfg(windows)]
    fn symlink_file_for_test(target: &Path, link: &Path) -> bool {
        match std::os::windows::fs::symlink_file(target, link) {
            Ok(()) => true,
            Err(err)
                if err.kind() == ErrorKind::PermissionDenied
                    || err.raw_os_error() == Some(1314) =>
            {
                eprintln!("skipping: Windows file symlink privilege is unavailable: {err}");
                false
            }
            Err(err) => panic!("create file symlink: {err}"),
        }
    }

    /// The component walk is the ONLY fd-based parent resolution on macOS and
    /// BSD — `openat2` is Linux-only — so its `O_NOFOLLOW` is what stops an
    /// ancestor swap there. Every end-to-end test reaches the path-based
    /// `ensure_secret_target_symlink_free` first and never exercises the walk,
    /// so this calls it directly. Without `O_NOFOLLOW` on every component this
    /// returns Ok and the swap succeeds.
    #[cfg(unix)]
    #[test]
    fn secret_parent_walk_refuses_a_symlinked_component_directly() {
        use std::os::fd::OwnedFd;

        let scratch = Scratch::new("secret-walk-nofollow");
        let root = scratch.root.as_path();
        let real = root.join("real");
        std::fs::create_dir_all(real.join("nested")).expect("real tree");
        // `link` -> `real`, so walking `link/nested` must be refused at `link`.
        if !symlink_dir_for_test(&real, &root.join("link")) {
            return;
        }

        let root_fd: OwnedFd = std::fs::File::open(root).expect("open root").into();
        let refused =
            walk_secret_parent_unix(root_fd, Path::new("link/nested"), &root.join("link/nested"));
        assert!(
            matches!(refused, Err(MaterializeError::SymlinkTarget)),
            "a symlinked component must be refused by the walk itself, got {:?}",
            refused.map(|_| "Ok")
        );

        // Control: the same walk through the REAL directory succeeds, so the
        // refusal above is the symlink and not a broken walk.
        let root_fd: OwnedFd = std::fs::File::open(root).expect("open root").into();
        walk_secret_parent_unix(root_fd, Path::new("real/nested"), &root.join("real/nested"))
            .expect("the walk must traverse real directories");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn secret_parent_walk_classifies_symlink_planted_before_reopen() {
        use std::os::fd::OwnedFd;

        let scratch = Scratch::new("secret-walk-reopen-symlink");
        let root_fd: OwnedFd = std::fs::File::open(&scratch.root)
            .expect("open root")
            .into();
        let result = walk_secret_parent_unix_with_hook(
            root_fd,
            Path::new("planted"),
            &scratch.root.join("planted"),
            |parent_fd, name| {
                rustix::fs::unlinkat(parent_fd, name, rustix::fs::AtFlags::REMOVEDIR)
                    .expect("remove just-created directory");
                rustix::fs::symlinkat(Path::new("."), parent_fd, name)
                    .expect("plant symlink before reopen");
            },
        );

        assert!(
            matches!(result, Err(MaterializeError::SymlinkTarget)),
            "the post-mkdir reopen must classify the planted symlink, got {:?}",
            result.map(|_| "Ok")
        );
    }

    #[cfg(unix)]
    #[test]
    fn special_target_conflicts_and_does_not_stall_later_jobs() {
        use std::os::unix::fs::FileTypeExt;
        use std::os::unix::net::UnixListener;

        let scratch = Scratch::new("special-target-conflict");
        let socket_path = scratch.root.join("occupied.sock");
        // AF_UNIX bind is limited to SUN_LEN (~104 bytes on macOS), and the
        // scratch root can exceed it on CI runners. Bind at a short /tmp path
        // and rename the socket inode into place — the listener holds an fd,
        // so the moved entry stays a live socket at the deep target path.
        let short_dir = std::path::PathBuf::from(format!(
            "/tmp/dohc-sock-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        std::fs::create_dir(&short_dir).expect("short socket dir");
        let short_sock = short_dir.join("s");
        let _listener = UnixListener::bind(&short_sock).expect("bind target socket");
        std::fs::rename(&short_sock, &socket_path).expect("move socket into scratch");
        std::fs::remove_dir(&short_dir).expect("drop short socket dir");
        let mut store = EngineStore::open(&scratch.db(), 1).expect("open store");
        enqueue_write_job(
            &mut store,
            "special-target",
            "occupied.sock",
            b"INTENDED=special\n",
            1,
        );
        enqueue_write_job(
            &mut store,
            "later-target",
            "later.txt",
            b"LATER=completed\n",
            2,
        );

        let results = run_pending_jobs(
            &store,
            &scratch.root,
            DurabilityPolicy::none(),
            &StdReplacer,
            &NoBackoff,
            3,
            &NoFaults,
        )
        .expect("a special target must be a terminal conflict, not an IO error");

        assert_eq!(
            results,
            vec![
                JobResult {
                    job_id: "special-target".to_owned(),
                    outcome: JobOutcome::Conflict,
                },
                JobResult {
                    job_id: "later-target".to_owned(),
                    outcome: JobOutcome::Completed,
                },
            ]
        );
        assert!(
            std::fs::symlink_metadata(&socket_path)
                .expect("socket target survives")
                .file_type()
                .is_socket()
        );
        assert_eq!(
            store
                .load_materialization_job("special-target")
                .expect("load special job")
                .expect("special job")
                .status,
            JobStatus::Conflict
        );
        assert_eq!(
            std::fs::read(scratch.root.join("later.txt")).expect("read later target"),
            b"LATER=completed\n"
        );
    }

    #[test]
    fn secret_delete_does_not_recreate_parent_removed_after_initial_read() {
        let scratch = Scratch::new("secret-delete-parent-removed");
        let parent = scratch.root.join("removed");
        let target = parent.join(".env");
        std::fs::create_dir(&parent).expect("create target parent");
        std::fs::write(&target, b"SECRET=old\n").expect("write target");
        let (store, job) = prepare_secret_job(&scratch, "delete-parent-removed", "removed/.env");

        let outcome = materialize_secret_delete_with_hook(
            &store,
            &scratch.root,
            &target,
            &job,
            DurabilityPolicy::none(),
            2,
            &NoFaults,
            || {
                std::fs::remove_file(&target).expect("remove target during race");
                std::fs::remove_dir(&parent).expect("remove parent during race");
            },
        )
        .expect("a missing parent means the secret target is already absent");

        assert_eq!(outcome, JobOutcome::AlreadyMaterialized);
        assert!(
            !parent.exists(),
            "secret delete must not resurrect a user-deleted parent"
        );
        assert_eq!(
            store
                .load_materialization_job(&job.job_id)
                .expect("load delete job")
                .expect("delete job")
                .status,
            JobStatus::Complete
        );
    }

    #[test]
    fn secret_symlinked_ancestor_is_refused_without_writing_plaintext() {
        let scratch = Scratch::new("secret-symlink-ancestor");
        let outside = scratch.root.join("outside");
        std::fs::create_dir(&outside).expect("create outside directory");
        let linked_parent = scratch.root.join("linked");
        if !symlink_dir_for_test(&outside, &linked_parent) {
            return;
        }
        let (store, job) = prepare_secret_job(&scratch, "ancestor-link", "linked/.env");

        let err = materialize_secret_one(
            &store,
            &scratch.root,
            &job,
            b"SECRET=ancestor\n",
            DurabilityPolicy::none(),
            &StdReplacer,
            &NoBackoff,
            2,
            &NoFaults,
        )
        .expect_err("symlinked ancestor must be refused");

        assert!(matches!(err, MaterializeError::SymlinkTarget));
        assert!(!outside.join(".env").exists());
    }

    #[test]
    fn secret_symlinked_final_target_is_refused() {
        let scratch = Scratch::new("secret-symlink-final");
        let outside = scratch.root.join("outside-secret");
        std::fs::write(&outside, b"OUTSIDE=unchanged\n").expect("write outside target");
        let target = scratch.root.join(".env");
        if !symlink_file_for_test(&outside, &target) {
            return;
        }
        let (store, job) = prepare_secret_job(&scratch, "final-link", ".env");

        let err = materialize_secret_one(
            &store,
            &scratch.root,
            &job,
            b"SECRET=final\n",
            DurabilityPolicy::none(),
            &StdReplacer,
            &NoBackoff,
            2,
            &NoFaults,
        )
        .expect_err("symlinked final target must be refused");

        assert!(matches!(err, MaterializeError::SymlinkTarget));
        assert_eq!(
            std::fs::read(&outside).expect("read outside target"),
            b"OUTSIDE=unchanged\n"
        );
    }

    #[test]
    fn secret_regular_orphan_temp_is_unlinked_and_retried() {
        let scratch = Scratch::new("secret-regular-orphan");
        let (store, job) = prepare_secret_job(&scratch, "regular-orphan", ".env");
        let target = scratch.root.join(".env");
        let tmp = temp_sibling(&target, &job.job_id);
        std::fs::write(&tmp, b"STALE=orphan\n").expect("write stale regular temp");

        let outcome = materialize_secret_one(
            &store,
            &scratch.root,
            &job,
            b"SECRET=recovered\n",
            DurabilityPolicy::none(),
            &StdReplacer,
            &NoBackoff,
            2,
            &NoFaults,
        )
        .expect("regular orphan must be recovered");

        assert_eq!(outcome, JobOutcome::Completed);
        assert_eq!(
            std::fs::read(&target).expect("read materialized secret"),
            b"SECRET=recovered\n"
        );
        assert!(!tmp.exists());
    }

    #[test]
    fn secret_symlink_orphan_temp_is_refused() {
        let scratch = Scratch::new("secret-symlink-orphan");
        let (store, job) = prepare_secret_job(&scratch, "symlink-orphan", ".env");
        let target = scratch.root.join(".env");
        let tmp = temp_sibling(&target, &job.job_id);
        let outside = scratch.root.join("outside-temp");
        std::fs::write(&outside, b"OUTSIDE=unchanged\n").expect("write outside temp target");
        if !symlink_file_for_test(&outside, &tmp) {
            return;
        }

        let err = materialize_secret_one(
            &store,
            &scratch.root,
            &job,
            b"SECRET=must-not-write\n",
            DurabilityPolicy::none(),
            &StdReplacer,
            &NoBackoff,
            2,
            &NoFaults,
        )
        .expect_err("symlink orphan must be refused");

        assert!(matches!(err, MaterializeError::SymlinkTarget));
        assert!(!target.exists());
        assert_eq!(
            std::fs::read(&outside).expect("read outside temp target"),
            b"OUTSIDE=unchanged\n"
        );
    }

    #[test]
    fn secret_happy_path_writes_exact_bytes() {
        let scratch = Scratch::new("secret-happy");
        let (store, job) = prepare_secret_job(&scratch, "happy", "nested/.env");
        let target = scratch.root.join("nested").join(".env");
        let plaintext = b"SECRET=correct-bytes\n";

        let outcome = materialize_secret_one(
            &store,
            &scratch.root,
            &job,
            plaintext,
            DurabilityPolicy::none(),
            &StdReplacer,
            &NoBackoff,
            2,
            &NoFaults,
        )
        .expect("materialize secret");

        assert_eq!(outcome, JobOutcome::Completed);
        assert_eq!(std::fs::read(&target).expect("read target"), plaintext);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&target)
                    .expect("target metadata")
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
    }

    #[cfg(unix)]
    struct SwapAncestorBeforePinnedRename {
        visible_parent: PathBuf,
        parked_parent: PathBuf,
        outside_parent: PathBuf,
    }

    #[cfg(unix)]
    impl AtomicReplacer for SwapAncestorBeforePinnedRename {
        fn try_replace(&self, from: &Path, to: &Path) -> std::io::Result<()> {
            std::fs::rename(&self.visible_parent, &self.parked_parent)?;
            std::os::unix::fs::symlink(&self.outside_parent, &self.visible_parent)?;
            std::fs::rename(from, to)
        }

        fn try_replace_secret(
            &self,
            _from: &Path,
            _to: &Path,
            pinned_replace: &mut dyn FnMut() -> std::io::Result<()>,
        ) -> std::io::Result<()> {
            std::fs::rename(&self.visible_parent, &self.parked_parent)?;
            std::os::unix::fs::symlink(&self.outside_parent, &self.visible_parent)?;
            pinned_replace()
        }
    }

    #[cfg(unix)]
    #[test]
    fn secret_parent_swap_cannot_redirect_pinned_rename() {
        let scratch = Scratch::new("secret-parent-swap");
        let visible_parent = scratch.root.join("visible");
        let parked_parent = scratch.root.join("parked");
        let outside_parent = scratch.root.join("outside");
        std::fs::create_dir(&visible_parent).expect("create visible parent");
        std::fs::create_dir(&outside_parent).expect("create outside parent");
        let (store, job) = prepare_secret_job(&scratch, "parent-swap", "visible/.env");

        let outcome = materialize_secret_one(
            &store,
            &scratch.root,
            &job,
            b"SECRET=pinned\n",
            DurabilityPolicy::none(),
            &SwapAncestorBeforePinnedRename {
                visible_parent,
                parked_parent: parked_parent.clone(),
                outside_parent: outside_parent.clone(),
            },
            &NoBackoff,
            2,
            &NoFaults,
        )
        .expect("pinned rename must survive ancestor swap");

        assert_eq!(outcome, JobOutcome::Completed);
        assert_eq!(
            std::fs::read(parked_parent.join(".env")).expect("read pinned target"),
            b"SECRET=pinned\n"
        );
        assert!(!outside_parent.join(".env").exists());
    }

    #[cfg(windows)]
    struct AssertAncestorLockedBeforeRename {
        visible_parent: PathBuf,
        parked_parent: PathBuf,
    }

    #[cfg(windows)]
    impl AtomicReplacer for AssertAncestorLockedBeforeRename {
        fn try_replace(&self, from: &Path, to: &Path) -> std::io::Result<()> {
            std::fs::rename(&self.visible_parent, &self.parked_parent)?;
            std::fs::rename(from, to)
        }

        fn try_replace_secret(
            &self,
            _from: &Path,
            _to: &Path,
            pinned_replace: &mut dyn FnMut() -> std::io::Result<()>,
        ) -> std::io::Result<()> {
            let err = std::fs::rename(&self.visible_parent, &self.parked_parent)
                .expect_err("pinned ancestor handle must deny rename");
            assert!(
                is_transient_lock(&err),
                "unexpected ancestor-lock error: {err}"
            );
            pinned_replace()
        }
    }

    #[cfg(windows)]
    #[test]
    fn secret_parent_swap_is_blocked_while_ancestor_handles_are_pinned() {
        let scratch = Scratch::new("secret-parent-lock");
        let visible_parent = scratch.root.join("visible");
        let parked_parent = scratch.root.join("parked");
        std::fs::create_dir(&visible_parent).expect("create visible parent");
        let (store, job) = prepare_secret_job(&scratch, "parent-lock", "visible/.env");

        let outcome = materialize_secret_one(
            &store,
            &scratch.root,
            &job,
            b"SECRET=locked\n",
            DurabilityPolicy::none(),
            &AssertAncestorLockedBeforeRename {
                visible_parent: visible_parent.clone(),
                parked_parent,
            },
            &NoBackoff,
            2,
            &NoFaults,
        )
        .expect("ancestor lock must keep replacement in place");

        assert_eq!(outcome, JobOutcome::Completed);
        assert_eq!(
            std::fs::read(visible_parent.join(".env")).expect("read locked target"),
            b"SECRET=locked\n"
        );
    }

    #[cfg(windows)]
    struct AssertGrandparentLockedBeforeRename {
        grandparent: PathBuf,
        parked_grandparent: PathBuf,
    }

    #[cfg(windows)]
    impl AtomicReplacer for AssertGrandparentLockedBeforeRename {
        fn try_replace(&self, from: &Path, to: &Path) -> std::io::Result<()> {
            std::fs::rename(&self.grandparent, &self.parked_grandparent)?;
            std::fs::rename(from, to)
        }

        fn try_replace_secret(
            &self,
            _from: &Path,
            _to: &Path,
            pinned_replace: &mut dyn FnMut() -> std::io::Result<()>,
        ) -> std::io::Result<()> {
            let err = std::fs::rename(&self.grandparent, &self.parked_grandparent)
                .expect_err("open descendant handles must deny a grandparent rename on Windows");
            assert!(
                is_transient_lock(&err),
                "unexpected grandparent-lock error: {err}"
            );
            pinned_replace()
        }
    }

    #[cfg(windows)]
    #[test]
    fn secret_workspace_grandparent_rename_is_blocked_by_descendant_handles() {
        let scratch = Scratch::new("secret-grandparent-lock");
        let grandparent = scratch.root.join("grandparent");
        let workspace = grandparent.join("workspace");
        let visible_parent = workspace.join("visible");
        let parked_grandparent = scratch.root.join("parked-grandparent");
        std::fs::create_dir_all(&visible_parent).expect("create nested workspace");

        // Control: this exact grandparent is normally renameable. The refusal
        // observed inside `try_replace_secret` begins only after the guard has
        // opened its descendant handles.
        std::fs::rename(&grandparent, &parked_grandparent)
            .expect("grandparent must be renameable before guard acquisition");
        std::fs::rename(&parked_grandparent, &grandparent)
            .expect("restore grandparent before materialization");

        // Keep the store outside `grandparent`, so only the secret guard's
        // root-and-below directory handles can account for the rename refusal.
        let mut store = EngineStore::open(&scratch.db(), 1).expect("open store");
        enqueue_write_job(
            &mut store,
            "grandparent-lock",
            "visible/.env",
            b"encrypted-placeholder",
            1,
        );
        let job = store
            .load_materialization_job("grandparent-lock")
            .expect("load job")
            .expect("job");

        let outcome = materialize_secret_one(
            &store,
            &workspace,
            &job,
            b"SECRET=grandparent-locked\n",
            DurabilityPolicy::none(),
            &AssertGrandparentLockedBeforeRename {
                grandparent: grandparent.clone(),
                parked_grandparent: parked_grandparent.clone(),
            },
            &NoBackoff,
            2,
            &NoFaults,
        )
        .expect("grandparent lock must keep replacement in place");

        assert_eq!(outcome, JobOutcome::Completed);
        assert_eq!(
            std::fs::read(visible_parent.join(".env")).expect("read locked target"),
            b"SECRET=grandparent-locked\n"
        );
        assert!(grandparent.exists());
        assert!(!parked_grandparent.exists());
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
