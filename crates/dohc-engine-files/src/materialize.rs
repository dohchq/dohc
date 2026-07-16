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

use crate::floor::is_excluded_file;
use dohc_engine_storage::{
    EngineStore, FaultInjector, FaultPoint, MaterializationJob, Preimage, StorageError, hex_sha256,
};
use std::io::{ErrorKind, Read};
use std::path::{Path, PathBuf};

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

/// The terminal outcome of one job.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JobOutcome {
    /// Written and marked complete.
    Completed,
    /// The target already equalled the desired content (idempotent replay); no
    /// write performed, marked complete.
    AlreadyMaterialized,
    /// Newer external content was found at revalidation; preserved-both, marked
    /// conflict, target NOT overwritten.
    Conflict,
    /// A crash fault fired at this named point; the job is left as-is for
    /// startup replay. Durability is proven by reopening.
    Crashed(FaultPoint),
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
    now_ms: i64,
    faults: &dyn FaultInjector,
) -> Result<Vec<JobResult>, MaterializeError> {
    let jobs = store.list_pending_materialization_jobs()?;
    let mut results = Vec::with_capacity(jobs.len());
    for job in jobs {
        let outcome = materialize_one(store, root, &job, policy, replacer, now_ms, faults)?;
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
pub fn materialize_one(
    store: &EngineStore,
    root: &Path,
    job: &MaterializationJob,
    policy: DurabilityPolicy,
    replacer: &dyn AtomicReplacer,
    now_ms: i64,
    faults: &dyn FaultInjector,
) -> Result<JobOutcome, MaterializeError> {
    let target = resolve_target(root, &job.target_path)?;

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

    // Step 1 (idempotent replay): the target already equals the desired content.
    let current = read_current_no_follow(&target)?;
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

    // Step 2: sibling temp file, bounded, restrictive mode.
    let tmp = temp_sibling(&target, &job.job_id);
    write_temp(&tmp, &content)?;
    if should_crash(faults, FaultPoint::MaterializeAfterTempWrite) {
        // A crash here leaves an orphan temp; startup replay ignores it (temp is
        // never captured as user content — it lives under a `.dohc-write-` name
        // the path floor excludes) and re-runs the job.
        return Ok(JobOutcome::Crashed(FaultPoint::MaterializeAfterTempWrite));
    }

    // Step 3: flush per the per-OS durability policy.
    flush_temp(&tmp, target.parent(), policy)?;
    if should_crash(faults, FaultPoint::MaterializeAfterFlushBeforeRename) {
        return Ok(JobOutcome::Crashed(
            FaultPoint::MaterializeAfterFlushBeforeRename,
        ));
    }

    // Step 4: revalidate the preimage immediately before the replace. The fault
    // point fires FIRST so a trace can mutate the target and prove we observe
    // the newer external content rather than clobbering it.
    if should_crash(faults, FaultPoint::MaterializeBeforePreimageRevalidate) {
        return Ok(JobOutcome::Crashed(
            FaultPoint::MaterializeBeforePreimageRevalidate,
        ));
    }
    let current_now = read_current_no_follow(&target)?;
    if !preimage_matches(&job.preimage, &current_now) {
        // External newer content: preserve BOTH. Keep the on-disk target
        // untouched; persist our intended content to a `.conflict` sibling so it
        // is not lost; mark the job conflict (never silently replayed).
        let conflict_path = conflict_sibling(&target, &job.job_id);
        rename_no_follow(&tmp, &conflict_path, replacer)?;
        store.mark_materialization_conflict(&job.job_id, now_ms)?;
        return Ok(JobOutcome::Conflict);
    }

    // Step 5: atomic replace with bounded retry, then mark complete.
    replace_with_bounded_retry(&tmp, &target, replacer)?;
    if should_crash(faults, FaultPoint::MaterializeAfterRenameBeforeComplete) {
        // Renamed but not marked complete. Startup replay: the target now equals
        // the desired content, so step 1 short-circuits and marks complete —
        // exactly-once, no second write.
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

fn write_temp(tmp: &Path, content: &[u8]) -> Result<(), MaterializeError> {
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
    Ok(())
}

fn flush_temp(
    tmp: &Path,
    parent: Option<&Path>,
    policy: DurabilityPolicy,
) -> Result<(), MaterializeError> {
    if policy.fsync_file {
        // Open with WRITE access: on Windows `sync_all` maps to
        // `FlushFileBuffers`, which requires a writable handle (a read-only
        // handle fails ERROR_ACCESS_DENIED). `write(true)` does not truncate.
        let file = std::fs::OpenOptions::new()
            .write(true)
            .open(tmp)
            .map_err(|e| MaterializeError::io(tmp, &e))?;
        file.sync_all().map_err(|e| MaterializeError::io(tmp, &e))?;
    }
    if policy.fsync_parent_dir
        && let Some(dir) = parent
    {
        // POSIX: fsync the directory so the rename is durable. On Windows this
        // path is disabled by `per_os()` (std cannot open a dir for sync).
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
                // Retry: a real pipeline would back off on the test clock; the
                // seam makes the schedule deterministic in tests.
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
