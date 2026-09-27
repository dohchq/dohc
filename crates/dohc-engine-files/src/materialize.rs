//! The durable materialization pipeline — the filesystem half of the plan's
//! filesystem/database crash boundary (`plan §Filesystem/database crash
//! boundary`, `TEST_ORACLE.md` §3.3). The DB half (job rows, content blobs)
//! lives in `dohc-engine-storage`; this module executes pending jobs against
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
//!    editor produced newer content after the DB commit, do not overwrite —
//!    preserve both and mark the job `conflict`.
//! 5. **Replace without overwriting**, with bounded retry for transient sharing
//!    violations (Windows AV/indexer) that rechecks the preimage before every
//!    attempt, then mark complete or fail closed with the job left pending for
//!    startup replay.
//!
//! Each boundary has a named fault point so a crash-injection test can prove the
//! recovery contract by reopening and replaying.
//!
//! **Stage, then place.** No filesystem offers a content compare-and-swap,
//! so another program can write the target after step 4 read it. An ordinary
//! write or delete therefore never renames over the target or unlinks it:
//!
//! - One rename moves whatever is at the target name into the workspace's
//!   staging directory, `.dohc/engine/displaced`, under a name that spells
//!   the job id. No row is written first: recovery finds a staged file by
//!   scanning that directory and learns its job from the name. A file
//!   another program renamed over the target after the check moves with it,
//!   and bytes written in place move with the file they were written to.
//! - A write renames its temp into the empty name at once, without replacing.
//!   The target name is empty only between those two renames. If a program
//!   created the name in between, its file stays and the job conflicts.
//! - Then the staged file is read. It is known only when it holds the
//!   preimage or the job's own content and the store holds that blob. Any
//!   other stored blob, such as an older head `git checkout` restored, is an
//!   outside change, and so is a preimage the store never had, which a version
//!   switch can probe from disk. An empty file needs no blob but is known only
//!   against an empty preimage: a writer that truncated the file is still
//!   writing. On Windows a file another handle still has open for writing is
//!   never known.
//! - A known file is deleted, and the job ends in one ordinary commit. Any
//!   other file first gets an `open` row in `materialization_displacements`,
//!   in a commit that syncs the WAL, and then goes back: the job's content
//!   moves aside to the conflict sibling, the staged file returns to its
//!   path, where capture records it like any outside edit, and the job
//!   conflicts. The file stays staged, with its row `kept` as evidence, only
//!   when a program created the target meanwhile.
//! - Replay resolves staged files and open rows together, newest first by
//!   job creation time and reserved sequence, including other jobs for the
//!   same path. A write whose temp is still beside an empty target never placed its
//!   content, so its staged file goes back. Any other staged file is judged
//!   like a finished replace and never brings back a file the store holds. A
//!   staged file no job identifies stays, kept. A file a replace could not
//!   return is tried again whenever the actor is asked to confirm that path is
//!   gone.
//!
//! Windows has no atomic exchange, so the same renames run on every platform
//! and share one recovery path. The actor applies capture's and the desktop's
//! absence-driven deletes only after confirming the absence on its own thread,
//! where materialization runs, so the engine never records the empty name as
//! a delete. POSIX has no share modes, so a program that writes through a
//! descriptor it opened before the move, after the file was judged, writes
//! into a deleted file. The staging rename needs the target and the
//! workspace's `.dohc` directory on one volume; a target under another mount
//! uses a preimage-checked rename or unlink: an outside write after that
//! check can be lost. Secret writes keep a single rename over the target,
//! because a staged plaintext copy is what that path must
//! never leave.
//!
//! The guarantee covers process crashes and outside writes closed or renamed
//! into place before inspection. Power loss protection for a known preimage
//! comes from the same history durability as an in-place overwrite on main.
//! Unknown retained bytes get a FULL row before recovery moves them again.
//!
//! Every materialization first canonicalizes the workspace root, then rejects
//! symlinks/reparse points in each existing below-root target component.
//! Ordinary writes create missing parents one component at a time through that
//! same walk. Directories above the workspace root are intentionally outside
//! this validation, and ordinary name-based operations retain the single-user
//! rename-TOCTOU assumption.
//!
//! Secret plaintext uses a stronger path-binding rule after the shared walk.
//! Unix pins the workspace root and target parent with `openat2`/`openat`, then
//! creates, reads, unlinks, renames, and syncs relative to that parent
//! descriptor. Windows validates and retains non-delete-shared handles for the
//! root and every below-root target ancestor until the name-based replace
//! completes. Its single rename keeps the check-to-replace race; the
//! ancestor-redirection race is closed.

use crate::bounds::{MAX_CAPTURE_BINARY_BYTES, MAX_CAPTURE_TEXT_BYTES};
use crate::floor::is_excluded_file;
use crate::media::{is_text_media_type, media_type_for_path};
use dohc_engine_storage::{
    Displacement, DisplacementResolution, DisplacementSpec, DisplacementState, EngineStore,
    FaultInjector, FaultPoint, JobStatus, MaterializationJob, MaterializationOperation, Preimage,
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
/// (`TEST_ORACLE.md` §3.10). Re-exported from storage so both halves share one
/// constant.
pub const MAX_REPLACE_ATTEMPTS: u32 = dohc_engine_storage::MAX_REPLACE_ATTEMPTS;

/// A per-OS flush policy. The
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

/// The two renames of an ordinary replace, as a seam so tests can inject
/// sharing violations and racing writers at the moment each one runs. Each
/// step claims its destination without replacing an existing entry.
pub trait AtomicReplacer: Send + Sync {
    /// Move `target` to the unused name reserved by the staging allocator.
    /// Never emulate this with link/unlink: a writer can replace the source
    /// between those operations.
    fn displace(&self, target: &Path, displaced: &Path) -> std::io::Result<()> {
        // The actor owns staging and selected an unused name before this call.
        // A plain rename preserves attributes and works without NOREPLACE support.
        std::fs::rename(target, displaced)
    }

    /// Move `incoming` to `target` only while nothing exists at `target`.
    /// Fails with [`ErrorKind::AlreadyExists`] otherwise. Reports which
    /// rename it used, so a workspace whose drive falls back to a
    /// check-then-rename can say so.
    fn place(&self, incoming: &Path, target: &Path) -> std::io::Result<Placement> {
        rename_no_replace(incoming, target)
    }

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

/// The error of a check-then-rename's rename, which may have taken effect
/// before it failed (a network filesystem can report a rename it did as
/// failed). It carries the fallback on the error, so the placement still
/// records the limit. The wrapping `io::Error` keeps the original kind.
#[derive(Debug)]
pub struct CheckThenRenameFailed(pub std::io::Error);

impl CheckThenRenameFailed {
    /// Wrap a fallback rename's error, keeping its kind.
    pub fn wrap(err: std::io::Error) -> std::io::Error {
        std::io::Error::new(err.kind(), CheckThenRenameFailed(err))
    }

    fn is(err: &std::io::Error) -> bool {
        err.get_ref()
            .is_some_and(|inner| inner.is::<CheckThenRenameFailed>())
    }
}

impl std::fmt::Display for CheckThenRenameFailed {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "check-then-rename failed: {}", self.0)
    }
}

impl std::error::Error for CheckThenRenameFailed {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(&self.0)
    }
}

/// Which rename placed a file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Placement {
    /// A rename that refuses, atomically, to replace an existing file.
    Atomic,
    /// A rename after an absence check, on a filesystem with neither an
    /// exclusive rename nor hard links. A file another program creates
    /// between the check and the rename is lost.
    CheckThenRename,
}

/// The production replacer, using the trait's own steps.
#[derive(Debug, Clone, Copy, Default)]
pub struct StdReplacer;

impl AtomicReplacer for StdReplacer {}

/// Rename `incoming` to `target` without replacing an existing entry.
///
/// Windows claims the target with a hard link, then removes the incoming name.
/// Attributes never change, including if the process stops between those steps.
/// Filesystems without hard links fail closed.
///
/// Linux and macOS ask the kernel for an exclusive rename. Other Unix
/// systems, and filesystems that refuse the flag, claim the name with a hard
/// link and then remove the incoming name. A Unix filesystem that supports
/// neither (some SMB and FUSE mounts, or FAT on a kernel without the flag;
/// Linux 6.x FAT and exFAT accept it) falls back to a rename
/// after an absence check, which a file another program creates in between
/// can lose, and reports [`Placement::CheckThenRename`].
#[cfg(windows)]
fn rename_no_replace(incoming: &Path, target: &Path) -> std::io::Result<Placement> {
    place_with_hard_link(incoming, target, || std::fs::remove_file(incoming))
}

#[cfg(windows)]
fn place_with_hard_link(
    incoming: &Path,
    target: &Path,
    remove_incoming: impl FnOnce() -> std::io::Result<()>,
) -> std::io::Result<Placement> {
    std::fs::hard_link(incoming, target)?;
    // Placement already succeeded. A crash or failed unlink leaves another
    // name for the same file, without changing its attributes.
    let _ = remove_incoming();
    Ok(Placement::Atomic)
}

#[cfg(not(windows))]
fn rename_no_replace(incoming: &Path, target: &Path) -> std::io::Result<Placement> {
    match rename_no_replace_atomic(incoming, target) {
        Ok(()) => Ok(Placement::Atomic),
        Err(err) if err.kind() == ErrorKind::Unsupported => {
            match std::fs::symlink_metadata(target) {
                Ok(_) => Err(std::io::Error::from(ErrorKind::AlreadyExists)),
                Err(err) if err.kind() == ErrorKind::NotFound => {
                    std::fs::rename(incoming, target).map_err(CheckThenRenameFailed::wrap)?;
                    Ok(Placement::CheckThenRename)
                }
                Err(err) => Err(err),
            }
        }
        Err(err) => Err(err),
    }
}

/// The atomic half of [`rename_no_replace`]: [`ErrorKind::Unsupported`]
/// when the filesystem has neither an exclusive rename nor hard links.
#[cfg(not(windows))]
fn rename_no_replace_atomic(incoming: &Path, target: &Path) -> std::io::Result<()> {
    #[cfg(any(target_os = "linux", target_os = "android", target_vendor = "apple"))]
    {
        use rustix::fs::{CWD, RenameFlags, renameat_with};
        use rustix::io::Errno;
        match renameat_with(CWD, incoming, CWD, target, RenameFlags::NOREPLACE) {
            Ok(()) => return Ok(()),
            Err(err)
                if err == Errno::INVAL
                    || err == Errno::NOSYS
                    || err == Errno::NOTSUP
                    || err == Errno::OPNOTSUPP => {}
            Err(err) => return Err(err.into()),
        }
    }
    match std::fs::hard_link(incoming, target) {
        Ok(()) => {
            // The target name is claimed; a leftover incoming name is only a
            // second name for the same file, under the ignored write prefix.
            let _ = std::fs::remove_file(incoming);
            Ok(())
        }
        Err(err) if hard_links_unsupported(&err) => Err(std::io::Error::new(
            ErrorKind::Unsupported,
            "this filesystem has no rename that refuses to replace",
        )),
        Err(err) => Err(err),
    }
}

#[cfg(not(windows))]
fn hard_links_unsupported(err: &std::io::Error) -> bool {
    use rustix::io::Errno;
    err.kind() == ErrorKind::Unsupported
        || err.raw_os_error().is_some_and(|code| {
            let errno = Errno::from_raw_os_error(code);
            errno == Errno::PERM || errno == Errno::NOTSUP || errno == Errno::OPNOTSUPP
        })
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
    /// conflict, target not overwritten.
    Conflict,
    /// An ordinary target operation encountered a symlink/reparse point,
    /// including in target ancestry or a predictable sibling. The job stays
    /// pending (no DB mark) so it retries once containment is restored, and the
    /// batch continues — one blocked path must not stall every other path's
    /// materialization.
    Blocked,
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

/// Private evidence for an authored create. Publication links this complete file
/// into an absent workspace path; the link preserves identity across restart.
pub struct AuthoredCreateStage {
    root: PathBuf,
    stage: PathBuf,
    target: PathBuf,
}

#[derive(Debug)]
pub struct AuthoredCreatePublishError {
    pub error: MaterializeError,
    pub may_be_published: bool,
}

impl AuthoredCreateStage {
    pub fn open(root: &Path, path: &str, id: &str) -> Result<Self, MaterializeError> {
        if id.len() != 64 || !id.bytes().all(|c| c.is_ascii_hexdigit()) {
            return Err(MaterializeError::UnsafeTargetPath);
        }
        let root = std::fs::canonicalize(root).map_err(|e| MaterializeError::io(root, &e))?;
        let target = resolve_target(&root, path)?;
        walk_target_components(
            &root,
            target.parent().ok_or(MaterializeError::UnsafeTargetPath)?,
            reject_link_or_reparse,
        )?;
        let stage = root
            .join(".dohc/engine/authored-create")
            .join(format!("{id}.stage"));
        prepare_target_parent_symlink_free(&root, &stage)?;
        Ok(Self {
            root,
            stage,
            target,
        })
    }

    pub fn prepare(&self, text: &str) -> Result<(), MaterializeError> {
        if text.len() > MAX_MATERIALIZE_BYTES {
            return Err(MaterializeError::TooLarge { actual: text.len() });
        }
        prepare_target_parent_symlink_free(&self.root, &self.target)?;
        let sibling = self.preparation_sibling();
        let prepared = (|| {
            // Create in the destination directory to inherit its security metadata.
            let file = write_temp(&sibling, text.as_bytes())?;
            file.sync_all()
                .map_err(|error| MaterializeError::io(&sibling, &error))?;
            std::fs::hard_link(&sibling, &self.stage)
                .map_err(|error| MaterializeError::io(&self.stage, &error))?;
            sync_parent_dir(self.stage.parent(), DurabilityPolicy::per_os())
        })();
        let removed = remove_authored_preparation(&sibling);
        prepared?;
        removed?;
        sync_parent_dir(sibling.parent(), DurabilityPolicy::per_os())
    }

    fn preparation_sibling(&self) -> PathBuf {
        temp_sibling(
            &self.target,
            &format!(
                "authored-create-{}",
                self.stage.file_stem().expect("stage ID").to_string_lossy()
            ),
        )
    }

    /// False means an existing entry won. Never overwrite or follow that entry.
    pub fn publish(&self) -> Result<bool, AuthoredCreatePublishError> {
        self.publish_with_link(|from, to| std::fs::hard_link(from, to))
    }

    fn publish_with_link(
        &self,
        link: impl FnOnce(&Path, &Path) -> std::io::Result<()>,
    ) -> Result<bool, AuthoredCreatePublishError> {
        let unpublished = |error| AuthoredCreatePublishError {
            error,
            may_be_published: false,
        };
        walk_target_components(
            &self.root,
            self.target
                .parent()
                .ok_or(MaterializeError::UnsafeTargetPath)
                .map_err(unpublished)?,
            ensure_real_directory,
        )
        .map_err(unpublished)?;
        if let Err(error) = link(&self.stage, &self.target) {
            // A remote server can create the link before losing its reply.
            // Unsupported is a definitive refusal; other outcomes need identity evidence.
            if error.kind() == ErrorKind::Unsupported {
                return Err(unpublished(MaterializeError::io(&self.target, &error)));
            }
            match self.is_published() {
                Ok(true) => {}
                Ok(false) if error.kind() == ErrorKind::AlreadyExists => return Ok(false),
                Ok(false) => return Err(unpublished(MaterializeError::io(&self.target, &error))),
                Err(_) => {
                    return Err(AuthoredCreatePublishError {
                        error: MaterializeError::io(&self.target, &error),
                        may_be_published: true,
                    });
                }
            }
        }
        sync_parent_dir(self.target.parent(), DurabilityPolicy::per_os()).map_err(|error| {
            AuthoredCreatePublishError {
                error,
                may_be_published: true,
            }
        })?;
        Ok(true)
    }

    pub fn is_published(&self) -> Result<bool, MaterializeError> {
        // Missing evidence cannot prove either publication or a collision.
        let stage = same_file::Handle::from_path(&self.stage)
            .map_err(|e| MaterializeError::io(&self.stage, &e))?;
        let metadata = match std::fs::symlink_metadata(&self.target) {
            Ok(metadata) => metadata,
            Err(e) if matches!(e.kind(), ErrorKind::NotFound | ErrorKind::NotADirectory) => {
                return Ok(false);
            }
            Err(e) => return Err(MaterializeError::io(&self.target, &e)),
        };
        if !metadata.is_file()
            || metadata.file_type().is_symlink()
            || metadata_is_reparse_point(&metadata)
        {
            return Ok(false);
        }
        let target = same_file::Handle::from_path(&self.target)
            .map_err(|e| MaterializeError::io(&self.target, &e))?;
        Ok(stage == target)
    }

    pub fn cleanup(&self) -> Result<(), MaterializeError> {
        remove_authored_preparation(&self.preparation_sibling())?;
        match std::fs::remove_file(&self.stage) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == ErrorKind::NotFound => Ok(()),
            Err(e) => Err(MaterializeError::io(&self.stage, &e)),
        }
    }
}

fn remove_authored_preparation(path: &Path) -> Result<(), MaterializeError> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if matches!(error.kind(), ErrorKind::NotFound | ErrorKind::NotADirectory) => {
            Ok(())
        }
        Err(error) => Err(MaterializeError::io(path, &error)),
    }
}

/// No intent remains when this runs. Only this subsystem owns these private files.
pub fn cleanup_authored_create_stages(root: &Path) -> Result<(), MaterializeError> {
    let root = std::fs::canonicalize(root).map_err(|e| MaterializeError::io(root, &e))?;
    let dir = root.join(".dohc/engine/authored-create");
    ensure_target_symlink_free(&root, &dir)?;
    let entries = match std::fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(MaterializeError::io(&dir, &e)),
    };
    for entry in entries {
        let entry = entry.map_err(|e| MaterializeError::io(&dir, &e))?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.len() == 70
            && name.ends_with(".stage")
            && name[..64].bytes().all(|c| c.is_ascii_hexdigit())
        {
            std::fs::remove_file(entry.path())
                .map_err(|e| MaterializeError::io(&entry.path(), &e))?;
        }
    }
    Ok(())
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
    /// The target or a below-root ancestor is a symlink/reparse point; refusing
    /// to materialize through it.
    #[error("job target path contains a symlink; refusing materialization")]
    SymlinkTarget,
    /// A secret target exists but cannot safely be compared or replaced (for
    /// example, it is a directory or special file). The job remains pending.
    #[error("secret materialization target is not a bounded regular file")]
    BlockedTarget,
    /// The atomic replace exhausted its bounded retry budget on transient
    /// sharing violations; the job is left pending for startup replay.
    #[error("atomic replace exhausted {MAX_REPLACE_ATTEMPTS} attempts (file locked)")]
    FileLocked,
    /// Recovery cannot enumerate staged files. Replacements stay pending.
    #[error("file recovery is unavailable")]
    RecoveryUnavailable,
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
            MaterializeError::RecoveryUnavailable => "recovery-unavailable",
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

/// Shared execution settings for a materialization attempt or pending-job batch.
/// The caller supplies the timestamp and owns the replacement and fault seams.
#[derive(Clone, Copy)]
pub struct MaterializeOptions<'a> {
    pub policy: DurabilityPolicy,
    pub replacer: &'a dyn AtomicReplacer,
    pub backoff: &'a dyn ReplaceBackoff,
    pub now_ms: i64,
    pub faults: &'a dyn FaultInjector,
}

/// Execute every pending job (oldest first), after resolving every
/// displacement a crash left open. Stops at the first job that crashes
/// (simulating process death), returning the results accumulated so far; the
/// remaining jobs stay pending and are replayed on the next call.
pub fn run_pending_jobs(
    store: &EngineStore,
    root: &Path,
    options: &MaterializeOptions<'_>,
) -> Result<Vec<JobResult>, MaterializeError> {
    recover_displacements(store, root, None, options)?;
    let jobs = store.list_pending_materialization_jobs()?;
    let mut results = Vec::with_capacity(jobs.len());
    for job in jobs {
        let outcome = materialize_one(store, root, &job, options)?;
        let crashed = matches!(outcome, JobOutcome::Crashed(_));
        results.push(JobResult {
            job_id: job.job_id,
            outcome,
        });
        if crashed {
            // A crashed process cleans nothing up; replay does.
            return Ok(results);
        }
    }
    Ok(results)
}

/// Execute a single job through the five durable steps.
pub fn materialize_one(
    store: &EngineStore,
    root: &Path,
    job: &MaterializationJob,
    options: &MaterializeOptions<'_>,
) -> Result<JobOutcome, MaterializeError> {
    match materialize_one_ordinary(store, root, job, options) {
        Err(MaterializeError::SymlinkTarget | MaterializeError::RecoveryUnavailable) => {
            Ok(JobOutcome::Blocked)
        }
        outcome => outcome,
    }
}

fn materialize_one_ordinary(
    store: &EngineStore,
    root: &Path,
    job: &MaterializationJob,
    options: &MaterializeOptions<'_>,
) -> Result<JobOutcome, MaterializeError> {
    let MaterializeOptions { now_ms, faults, .. } = *options;
    // Canonicalizing the root deliberately accepts aliases above (or at) the
    // workspace boundary. The component walk below owns only descendants.
    let canonical_root =
        std::fs::canonicalize(root).map_err(|err| MaterializeError::io(root, &err))?;
    let target = resolve_target(&canonical_root, &job.target_path)?;

    // `materialize.after-job-commit`: the job row is durable but nothing is on
    // disk yet. A crash here leaves the job pending for startup replay.
    if should_crash(faults, FaultPoint::MaterializeAfterJobCommit) {
        return Ok(JobOutcome::Crashed(FaultPoint::MaterializeAfterJobCommit));
    }

    // An earlier run of this job may have stopped mid-replace. Resolve that
    // first, so every check below sees the target as it was or as it ended.
    // Bytes the store lacks that cannot return to their path make the job
    // conflict, so the person is told.
    let (staging, kept) = recover_job_displacements(store, &canonical_root, job, options)?;
    if kept {
        store.mark_materialization_conflict(&job.job_id, now_ms)?;
        return Ok(JobOutcome::Conflict);
    }

    // Generation staleness gate: if a newer generation has already been
    // materialized at this path, this job is superseded — never regress the path
    // to older content (concurrent / out-of-order jobs). No-op; mark complete.
    if !job.job_id.starts_with("version-switch-")
        && let Some(done_gen) =
            store.max_completed_generation_for_path(&job.workspace_id, &job.target_path)?
        && done_gen > job.target_generation
    {
        store.mark_materialization_complete(&job.job_id, now_ms)?;
        return Ok(JobOutcome::Superseded);
    }

    if job.operation == MaterializationOperation::Delete {
        return materialize_delete(store, &canonical_root, &staging, &target, job, options);
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
    materialize_ordinary_write(
        store,
        &canonical_root,
        &staging,
        &target,
        job,
        &content,
        options,
    )
}

/// Execute a secret write through the same atomic-replace pipeline without
/// ever persisting plaintext in the content-blob table. Ordinary secret jobs
/// adopt the current disk state as their immediate preimage; version-switch
/// jobs retain the preimage probed during phase 1 so an intervening edit
/// conflicts. Conflict handling never writes a plaintext `.conflict` sibling.
pub fn materialize_secret_one(
    store: &EngineStore,
    root: &Path,
    job: &MaterializationJob,
    plaintext: &[u8],
    options: &MaterializeOptions<'_>,
) -> Result<JobOutcome, MaterializeError> {
    materialize_secret_one_with_remover(store, root, job, plaintext, options, &StdSecretTempRemover)
}

fn materialize_secret_one_with_remover(
    store: &EngineStore,
    root: &Path,
    job: &MaterializationJob,
    plaintext: &[u8],
    options: &MaterializeOptions<'_>,
    secret_temp_remover: &dyn SecretTempRemover,
) -> Result<JobOutcome, MaterializeError> {
    let MaterializeOptions { now_ms, faults, .. } = *options;
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
    materialize_secret_write(
        store,
        &canonical_root,
        &target,
        &plaintext_job,
        plaintext,
        options,
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
/// Deletion does not use `options.replacer` or `options.backoff`.
pub fn materialize_secret_delete_one(
    store: &EngineStore,
    root: &Path,
    job: &MaterializationJob,
    options: &MaterializeOptions<'_>,
) -> Result<JobOutcome, MaterializeError> {
    let MaterializeOptions { faults, .. } = *options;
    let canonical_root =
        std::fs::canonicalize(root).map_err(|err| MaterializeError::io(root, &err))?;
    let target = resolve_target(&canonical_root, &job.target_path)?;
    ensure_target_symlink_free(&canonical_root, &target)?;
    if should_crash(faults, FaultPoint::MaterializeAfterJobCommit) {
        return Ok(JobOutcome::Crashed(FaultPoint::MaterializeAfterJobCommit));
    }
    materialize_secret_delete(store, &canonical_root, &target, job, options)
}

fn materialize_secret_delete(
    store: &EngineStore,
    root: &Path,
    target: &Path,
    job: &MaterializationJob,
    options: &MaterializeOptions<'_>,
) -> Result<JobOutcome, MaterializeError> {
    materialize_secret_delete_with_hook(store, root, target, job, options, || {})
}

fn materialize_secret_delete_with_hook(
    store: &EngineStore,
    root: &Path,
    target: &Path,
    job: &MaterializationJob,
    options: &MaterializeOptions<'_>,
    before_parent_open: impl FnOnce(),
) -> Result<JobOutcome, MaterializeError> {
    let MaterializeOptions {
        policy,
        now_ms,
        faults,
        ..
    } = *options;
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
    parent: &'a SecretParentGuard,
    name: &'a OsStr,
    armed: bool,
}

impl SecretPlaintextTempCleanup<'_> {
    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for SecretPlaintextTempCleanup<'_> {
    fn drop(&mut self) {
        if self.armed {
            let _ = self.parent.remove_file(self.name, self.path);
        }
    }
}

fn materialize_secret_write(
    store: &EngineStore,
    root: &Path,
    target: &Path,
    job: &MaterializationJob,
    content: &[u8],
    options: &MaterializeOptions<'_>,
    secret_temp_remover: &dyn SecretTempRemover,
) -> Result<JobOutcome, MaterializeError> {
    let MaterializeOptions {
        policy,
        replacer,
        backoff,
        now_ms,
        faults,
    } = *options;
    ensure_target_symlink_free(root, target)?;
    // Step 1 (idempotent replay): the target already equals the desired content.
    let current = read_current_no_follow(target)?;
    if matches!(current, CurrentTarget::Oversized) {
        return Err(MaterializeError::BlockedTarget);
    }
    if let CurrentTarget::Present(bytes) = &current
        && hex_sha256(bytes) == job.content_sha256
    {
        store.mark_materialization_complete(&job.job_id, now_ms)?;
        return Ok(JobOutcome::AlreadyMaterialized);
    }

    // Ensure and pin the real parent directory. The write uses this same
    // directory object for create, revalidation, cleanup, rename, and fsync.
    let parent_path = target.parent().ok_or(MaterializeError::UnsafeTargetPath)?;
    let parent = SecretParentGuard::open_or_create(root, target, parent_path)?;

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
    let temp_file = parent.write_temp(tmp_name.as_os_str(), &tmp, content)?;
    // A secret write never preserves a plaintext temp on a returned error.
    let mut secret_temp_cleanup = SecretPlaintextTempCleanup {
        path: &tmp,
        parent: &parent,
        name: tmp_name.as_os_str(),
        armed: true,
    };
    if should_crash(faults, FaultPoint::MaterializeAfterTempWrite) {
        secret_temp_cleanup.disarm();
        return Ok(JobOutcome::Crashed(FaultPoint::MaterializeAfterTempWrite));
    }

    // Step 3: flush the temp FILE per the per-OS durability policy. The parent
    // directory is synced after the rename (below), which is where the rename's
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
    // point fires first so a trace can mutate the target and prove we observe
    // the newer external content rather than clobbering it.
    if should_crash(faults, FaultPoint::MaterializeBeforePreimageRevalidate) {
        secret_temp_cleanup.disarm();
        return Ok(JobOutcome::Crashed(
            FaultPoint::MaterializeBeforePreimageRevalidate,
        ));
    }
    // This read and the rename below are not atomic. A secret write keeps the
    // check-to-replace window (see the module docs). Each retry checks the
    // preimage again after its backoff, including the final Windows
    // exhaustion reattempt.
    let mut validate_preimage = || {
        let current = parent.read_current(target_name.as_os_str(), target)?;
        if matches!(current, CurrentTarget::Oversized) {
            return Err(MaterializeError::BlockedTarget);
        }
        Ok(preimage_matches(&job.preimage, &current))
    };
    let replaced = replace_secret_with_bounded_retry(
        &parent,
        tmp_name.as_os_str(),
        target_name.as_os_str(),
        &tmp,
        target,
        replacer,
        backoff,
        &mut validate_preimage,
    )?;
    if !replaced {
        // Newer external content stays untouched. A secret conflict writes no
        // plaintext `.conflict` sibling, so the temp is removed instead.
        if secret_temp_remover
            .remove_pinned(&parent, tmp_name.as_os_str(), &tmp)
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

    // Make the completed replace durable by syncing the parent directory
    // (POSIX), THEN mark complete — so a
    // crash can never leave the job marked complete over a non-durable rename.
    parent.sync(policy)?;
    if should_crash(faults, FaultPoint::MaterializeAfterRenameBeforeComplete) {
        secret_temp_cleanup.disarm();
        return Ok(JobOutcome::Crashed(
            FaultPoint::MaterializeAfterRenameBeforeComplete,
        ));
    }
    store.mark_materialization_complete(&job.job_id, now_ms)?;
    secret_temp_cleanup.disarm();
    Ok(JobOutcome::Completed)
}

/// Write an ordinary job's content without overwriting bytes the preimage
/// check did not see (module docs, "Stage, then place").
fn materialize_ordinary_write(
    store: &EngineStore,
    root: &Path,
    staging: &Staging,
    target: &Path,
    job: &MaterializationJob,
    content: &[u8],
    options: &MaterializeOptions<'_>,
) -> Result<JobOutcome, MaterializeError> {
    let MaterializeOptions {
        policy,
        now_ms,
        faults,
        ..
    } = *options;
    // This single preflight gates every ordinary target read, temp write,
    // rename, cleanup, and directory open below. Missing parents are created
    // one component at a time; create_dir_all would silently traverse an
    // aliased intermediate. The ordinary entry boundary converts any symlink
    // refusal from this pipeline into a pending Blocked outcome, keeping the
    // batch running.
    prepare_target_parent_symlink_free(root, target)?;
    // Step 1 (idempotent replay): the target already equals the desired content.
    // The staging recheck reuses this read while the target's size and time
    // stay the same.
    let mut reads = TargetReads::default();
    if let TargetHash::Sha(sha) = reads.read(target)?
        && sha == job.content_sha256
    {
        store.mark_materialization_complete(&job.job_id, now_ms)?;
        return Ok(JobOutcome::AlreadyMaterialized);
    }

    // Step 2: sibling temp file, bounded, restrictive mode.
    let tmp = temp_sibling(target, &job.job_id);
    let temp_file = write_temp(&tmp, content)?;
    if should_crash(faults, FaultPoint::MaterializeAfterTempWrite) {
        // A crash here leaves an orphan temp; startup replay ignores it (temp is
        // never captured as user content: it lives under a `.dohc-write-` name
        // the path floor excludes) and re-runs the job.
        return Ok(JobOutcome::Crashed(FaultPoint::MaterializeAfterTempWrite));
    }

    // Step 3: flush the temp FILE per the per-OS durability policy. The parent
    // directory is synced after the renames, which is where their durability
    // lives on POSIX.
    flush_temp_file(&temp_file, &tmp, policy)?;
    drop(temp_file);
    if should_crash(faults, FaultPoint::MaterializeAfterFlushBeforeRename) {
        return Ok(JobOutcome::Crashed(
            FaultPoint::MaterializeAfterFlushBeforeRename,
        ));
    }

    // Steps 4 and 5. The fault point fires before the first revalidation so a
    // trace can mutate the target and prove we observe the newer external
    // content rather than clobbering it.
    if should_crash(faults, FaultPoint::MaterializeBeforePreimageRevalidate) {
        return Ok(JobOutcome::Crashed(
            FaultPoint::MaterializeBeforePreimageRevalidate,
        ));
    }
    let outcome = swap_in_temp(store, staging, target, &tmp, job, &mut reads, options);
    if outcome.is_err() {
        let _ = std::fs::remove_file(&tmp); // best-effort cleanup
    }
    outcome
}

fn swap_in_temp(
    store: &EngineStore,
    staging: &Staging,
    target: &Path,
    tmp: &Path,
    job: &MaterializationJob,
    reads: &mut TargetReads,
    options: &MaterializeOptions<'_>,
) -> Result<JobOutcome, MaterializeError> {
    let MaterializeOptions {
        policy,
        now_ms,
        faults,
        ..
    } = *options;
    let expected = match &job.preimage {
        Preimage::Absent => {
            if !create_from_temp(target, tmp, options)? {
                return record_write_conflict(store, target, tmp, job, now_ms);
            }
            sync_parent_dir(target.parent(), policy)?;
            if should_crash(faults, FaultPoint::MaterializeAfterRenameBeforeComplete) {
                return Ok(JobOutcome::Crashed(
                    FaultPoint::MaterializeAfterRenameBeforeComplete,
                ));
            }
            store.mark_materialization_complete(&job.job_id, now_ms)?;
            return Ok(JobOutcome::Completed);
        }
        Preimage::Present(expected) => expected,
    };
    let spec = match stage_target(staging, target, job, expected, reads, options)? {
        Stage::Moved(spec) => spec,
        Stage::CrossVolume => {
            return materialize_cross_volume(store, target, Some(tmp), job, options);
        }
        Stage::Conflict | Stage::Vanished => {
            return record_write_conflict(store, target, tmp, job, now_ms);
        }
    };
    let staged = staging.dir.join(&spec.displaced_name);
    if should_crash(faults, FaultPoint::MaterializeAfterDisplaceBeforePlace) {
        return Ok(JobOutcome::Crashed(
            FaultPoint::MaterializeAfterDisplaceBeforePlace,
        ));
    }
    // Place first, so the target name is empty only between two renames. The
    // staged file is judged afterwards, with the name occupied.
    if !place_after_stage(store, target, tmp, &spec, &staging.dir, options)? {
        // A program created the target between the two renames. Its file
        // stays where it is, and the staged file cannot go back.
        match inspect_displaced(store, &staged, expected, Some(&job.content_sha256))? {
            Inspected::Known { .. } | Inspected::Missing => {
                let _ = std::fs::remove_file(&staged);
            }
            other => {
                sync_staged(&staging.dir, policy)?;
                store.keep_displacement(&spec, keep_sha256(&other))?;
            }
        }
        return record_write_conflict(store, target, tmp, job, now_ms);
    }
    if should_crash(faults, FaultPoint::MaterializeAfterRenameBeforeComplete) {
        // Placed but not marked complete. Startup replay judges the staged
        // file, then step 1 short-circuits and marks complete: exactly once,
        // no second write.
        return Ok(JobOutcome::Crashed(
            FaultPoint::MaterializeAfterRenameBeforeComplete,
        ));
    }
    let inspected = inspect_displaced(store, &staged, expected, Some(&job.content_sha256))?;
    if should_crash(faults, FaultPoint::MaterializeAfterDisplacedHash) {
        return Ok(JobOutcome::Crashed(
            FaultPoint::MaterializeAfterDisplacedHash,
        ));
    }
    if matches!(inspected, Inspected::Known { .. } | Inspected::Missing) {
        // No row names the file. One that cannot be deleted now is found
        // again by the next sweep.
        let _ = std::fs::remove_file(&staged);
        if should_crash(faults, FaultPoint::MaterializeAfterKnownCopyDeletion) {
            return Ok(JobOutcome::Crashed(
                FaultPoint::MaterializeAfterKnownCopyDeletion,
            ));
        }
        sync_parent_dir(target.parent(), policy)?;
        store.mark_materialization_complete(&job.job_id, now_ms)?;
        return Ok(JobOutcome::Completed);
    }
    // Another program wrote the file after the check. Its bytes go back to
    // their path, where capture records them like any outside edit; the
    // job's content moves to the conflict sibling.
    sync_staged(&staging.dir, policy)?;
    sync_parent_dir(target.parent(), policy)?;
    let moved = Moved::open(store, spec, &staging.dir)?;
    if should_crash(faults, FaultPoint::MaterializeAfterDisplacementJournal) {
        return Ok(JobOutcome::Crashed(
            FaultPoint::MaterializeAfterDisplacementJournal,
        ));
    }
    swap_back(store, target, &moved, &inspected, options)?;
    store.mark_materialization_conflict(&job.job_id, now_ms)?;
    Ok(JobOutcome::Conflict)
}

/// Keep the target as it is and move the job's content to a `.conflict`
/// sibling so it is not lost; mark the job conflict (never silently replayed).
/// The artifact is on the path floor, so the scanner does not capture it as a
/// new tracked document; a person or agent inspects and resolves it.
fn record_write_conflict(
    store: &EngineStore,
    target: &Path,
    tmp: &Path,
    job: &MaterializationJob,
    now_ms: i64,
) -> Result<JobOutcome, MaterializeError> {
    let conflict_path = conflict_sibling(target, &job.job_id);
    std::fs::rename(tmp, &conflict_path)
        .map_err(|err| MaterializeError::io(&conflict_path, &err))?;
    store.mark_materialization_conflict(&job.job_id, now_ms)?;
    Ok(JobOutcome::Conflict)
}

fn materialize_delete(
    store: &EngineStore,
    root: &Path,
    staging: &Staging,
    target: &Path,
    job: &MaterializationJob,
    options: &MaterializeOptions<'_>,
) -> Result<JobOutcome, MaterializeError> {
    let MaterializeOptions {
        policy,
        now_ms,
        faults,
        ..
    } = *options;
    // One fail-closed component walk gates both no-follow reads, the renames,
    // and the parent-directory durability open for this ordinary delete. A
    // refusal is converted to Blocked by the ordinary entry boundary.
    ensure_target_symlink_free(root, target)?;
    let mut reads = TargetReads::default();
    if should_crash(faults, FaultPoint::MaterializeBeforePreimageRevalidate) {
        return Ok(JobOutcome::Crashed(
            FaultPoint::MaterializeBeforePreimageRevalidate,
        ));
    }
    let Preimage::Present(expected) = &job.preimage else {
        if !entry_exists(target)? {
            store.mark_materialization_complete(&job.job_id, now_ms)?;
            return Ok(JobOutcome::AlreadyMaterialized);
        }
        // A delete that expected nothing found someone else's file.
        store.mark_materialization_conflict(&job.job_id, now_ms)?;
        return Ok(JobOutcome::Conflict);
    };
    // A delete moves the file into staging instead of unlinking it, and
    // unlinks it only once it is known to hold the preimage the store has. An
    // empty name is what a delete leaves anyway.
    let spec = match stage_target(staging, target, job, expected, &mut reads, options)? {
        Stage::Moved(spec) => spec,
        Stage::CrossVolume => return materialize_cross_volume(store, target, None, job, options),
        Stage::Conflict => {
            store.mark_materialization_conflict(&job.job_id, now_ms)?;
            return Ok(JobOutcome::Conflict);
        }
        Stage::Vanished => {
            store.mark_materialization_complete(&job.job_id, now_ms)?;
            return Ok(JobOutcome::AlreadyMaterialized);
        }
    };
    let staged = staging.dir.join(&spec.displaced_name);
    if should_crash(faults, FaultPoint::MaterializeAfterRenameBeforeComplete) {
        return Ok(JobOutcome::Crashed(
            FaultPoint::MaterializeAfterRenameBeforeComplete,
        ));
    }
    let inspected = inspect_displaced(store, &staged, expected, None)?;
    if should_crash(faults, FaultPoint::MaterializeAfterDisplacedHash) {
        return Ok(JobOutcome::Crashed(
            FaultPoint::MaterializeAfterDisplacedHash,
        ));
    }
    if matches!(inspected, Inspected::Known { .. } | Inspected::Missing) {
        let _ = std::fs::remove_file(&staged);
        if should_crash(faults, FaultPoint::MaterializeAfterKnownCopyDeletion) {
            return Ok(JobOutcome::Crashed(
                FaultPoint::MaterializeAfterKnownCopyDeletion,
            ));
        }
        sync_parent_dir(target.parent(), policy)?;
        store.mark_materialization_complete(&job.job_id, now_ms)?;
        return Ok(JobOutcome::Completed);
    }
    // Bytes the store does not have go back to their path, and the delete
    // conflicts, as it would had the recheck seen them.
    sync_staged(&staging.dir, policy)?;
    sync_parent_dir(target.parent(), policy)?;
    let moved = Moved::open(store, spec, &staging.dir)?;
    if should_crash(faults, FaultPoint::MaterializeAfterDisplacementJournal) {
        return Ok(JobOutcome::Crashed(
            FaultPoint::MaterializeAfterDisplacementJournal,
        ));
    }
    let resolution = if return_displaced(target, &moved.path, options)? {
        DisplacementResolution::Discard
    } else {
        keep_resolution(&inspected)
    };
    store.resolve_displacement(
        moved.displacement_id,
        resolution,
        Some((&job.job_id, JobStatus::Conflict)),
        now_ms,
    )?;
    Ok(JobOutcome::Conflict)
}

/// Cross-volume targets use the original preimage-checked replace/unlink path.
/// The sibling temp is on the target volume, so replacing it needs no copy.
fn materialize_cross_volume(
    store: &EngineStore,
    target: &Path,
    tmp: Option<&Path>,
    job: &MaterializationJob,
    options: &MaterializeOptions<'_>,
) -> Result<JobOutcome, MaterializeError> {
    let replaced = retry_while_locked(
        target,
        target,
        options.backoff,
        MAX_REPLACE_ATTEMPTS,
        || {
            if !preimage_matches(&job.preimage, &read_current_no_follow(target)?) {
                return Ok(Attempt::Done(false));
            }
            let result = match tmp {
                Some(tmp) => std::fs::rename(tmp, target),
                None => std::fs::remove_file(target),
            };
            match result {
                Ok(()) => Ok(Attempt::Done(true)),
                Err(err) if is_transient_lock(&err) => Ok(Attempt::Locked(err)),
                Err(err) => Err(MaterializeError::io(target, &err)),
            }
        },
    )?;
    if !replaced {
        if let Some(tmp) = tmp {
            return record_write_conflict(store, target, tmp, job, options.now_ms);
        }
        store.mark_materialization_conflict(&job.job_id, options.now_ms)?;
        return Ok(JobOutcome::Conflict);
    }
    sync_parent_dir(target.parent(), options.policy)?;
    if should_crash(
        options.faults,
        FaultPoint::MaterializeAfterRenameBeforeComplete,
    ) {
        return Ok(JobOutcome::Crashed(
            FaultPoint::MaterializeAfterRenameBeforeComplete,
        ));
    }
    store.mark_materialization_complete(&job.job_id, options.now_ms)?;
    Ok(JobOutcome::Completed)
}

/// A staged file whose row is not yet resolved, with what its row expects.
struct Moved {
    displacement_id: i64,
    path: PathBuf,
    job_id: String,
    workspace_id: String,
    target_path: String,
    expected_sha256: String,
    content_sha256: Option<String>,
}

impl Moved {
    fn from_row(row: &Displacement, staging: &Path) -> Self {
        Moved {
            displacement_id: row.displacement_id,
            path: staging.join(&row.displaced_name),
            job_id: row.job_id.clone(),
            workspace_id: row.workspace_id.clone(),
            target_path: row.target_path.clone(),
            expected_sha256: row.expected_sha256.clone(),
            content_sha256: row.content_sha256.clone(),
        }
    }

    /// Write the synced open row for a staged file whose bytes the store
    /// lacks, before anything moves it again.
    fn open(
        store: &EngineStore,
        spec: DisplacementSpec,
        staging: &Path,
    ) -> Result<Self, MaterializeError> {
        let displacement_id = store.open_displacement(&spec)?;
        Ok(Moved {
            displacement_id,
            path: staging.join(&spec.displaced_name),
            job_id: spec.job_id,
            workspace_id: spec.workspace_id,
            target_path: spec.target_path,
            expected_sha256: spec.expected_sha256,
            content_sha256: spec.content_sha256,
        })
    }

    /// Read the staged file and judge it against what the row expects.
    fn inspect(&self, store: &EngineStore) -> Result<Inspected, MaterializeError> {
        inspect_displaced(
            store,
            &self.path,
            &self.expected_sha256,
            self.content_sha256.as_deref(),
        )
    }
}

/// The workspace's staging directory, and the staged names a job's rows
/// hold. A kept row holds its name even after a person removes its file, so
/// a later staged file never takes a name a row already means.
struct Staging {
    dir: PathBuf,
    taken: Vec<String>,
}

/// How [`stage_target`] ended.
enum Stage {
    /// The target now lives at the staged file this spec names. No row
    /// names it yet.
    Moved(DisplacementSpec),
    /// A recheck found content other than the preimage. Nothing moved.
    Conflict,
    /// The target disappeared between the recheck and the rename. Nothing moved.
    Vanished,
    /// The target is on a different volume from workspace staging.
    CrossVolume,
}

/// Move the target into staging, with no row. Every attempt, including the
/// first, rechecks the preimage, so a file changed while a sharing violation
/// held the rename back conflicts instead of moving.
fn stage_target(
    staging: &Staging,
    target: &Path,
    job: &MaterializationJob,
    expected: &str,
    reads: &mut TargetReads,
    options: &MaterializeOptions<'_>,
) -> Result<Stage, MaterializeError> {
    let write = job.operation == MaterializationOperation::Write;
    let spec = DisplacementSpec {
        job_id: job.job_id.clone(),
        workspace_id: job.workspace_id.clone(),
        target_path: job.target_path.clone(),
        displaced_name: unused_staged_name(&staging.dir, &job.job_id, &staging.taken)?,
        expected_sha256: expected.to_owned(),
        content_sha256: write.then(|| job.content_sha256.clone()),
        now_ms: options.now_ms,
    };
    let staged = staging.dir.join(&spec.displaced_name);
    let preimage = Preimage::Present(expected.to_owned());
    let attempt = retry_while_locked(
        target,
        target,
        options.backoff,
        MAX_REPLACE_ATTEMPTS,
        || {
            // Capture the type and attributes before a staging rename. Deletes
            // must never move a directory tree or a special file.
            let metadata = match std::fs::symlink_metadata(target) {
                Ok(metadata) => metadata,
                Err(err) if err.kind() == ErrorKind::NotFound => return Ok(Attempt::Done(None)),
                Err(err) => return Err(MaterializeError::io(target, &err)),
            };
            if !metadata.is_file() || metadata_is_reparse_point(&metadata) {
                return Ok(Attempt::Done(Some(false)));
            }
            if write {
                match reads.check(target, &preimage)? {
                    TargetHolds::Expected => {}
                    TargetHolds::Nothing => return Ok(Attempt::Done(None)),
                    TargetHolds::Other => return Ok(Attempt::Done(Some(false))),
                }
            }
            #[cfg(windows)]
            if write && metadata.permissions().readonly() {
                return Err(MaterializeError::io(
                    target,
                    &std::io::Error::from(ErrorKind::PermissionDenied),
                ));
            }
            displace_attempt(options.replacer, target, &staged).map(|attempt| match attempt {
                Attempt::Done(moved) => Attempt::Done(moved.then_some(true)),
                Attempt::Locked(err) => Attempt::Locked(err),
            })
        },
    );
    let attempt = match attempt {
        Err(MaterializeError::Io {
            kind: ErrorKind::CrossesDevices,
            ..
        }) => return Ok(Stage::CrossVolume),
        other => other?,
    };
    Ok(match attempt {
        Some(true) => Stage::Moved(spec),
        Some(false) => Stage::Conflict,
        None => Stage::Vanished,
    })
}

/// What a retry loop's check found at the target.
#[derive(Clone, Copy, PartialEq, Eq)]
enum TargetHolds {
    Nothing,
    Expected,
    Other,
}

/// What a target held when it was last read.
#[derive(Clone, PartialEq, Eq)]
enum TargetHash {
    Absent,
    Sha(String),
    /// Present but over the cap or not a regular file.
    Other,
}

/// The last read of a target in one job: its size, its modification time,
/// and the hash of what it held. A later read or retry reads and hashes the
/// target again only when the size or time changed, so the staging recheck
/// reuses the job's first read and a locked large file is not hashed on
/// every try. A change the size and time miss is still caught, because
/// whatever the job moves is read and judged again after the move.
#[derive(Default)]
struct TargetReads {
    last: Option<((u64, Option<std::time::SystemTime>), TargetHash)>,
}

impl TargetReads {
    fn read(&mut self, target: &Path) -> Result<TargetHash, MaterializeError> {
        let stamp = std::fs::symlink_metadata(target)
            .ok()
            .map(|metadata| (metadata.len(), metadata.modified().ok()));
        if let (Some(stamp), Some((last, hash))) = (stamp, &self.last)
            && stamp == *last
        {
            return Ok(hash.clone());
        }
        let hash = match read_current_no_follow(target)? {
            CurrentTarget::Absent => TargetHash::Absent,
            CurrentTarget::Present(bytes) => TargetHash::Sha(hex_sha256(&bytes)),
            CurrentTarget::Oversized => TargetHash::Other,
        };
        if let Some(stamp) = stamp {
            self.last = Some((stamp, hash.clone()));
        }
        Ok(hash)
    }

    fn check(
        &mut self,
        target: &Path,
        expected: &Preimage,
    ) -> Result<TargetHolds, MaterializeError> {
        Ok(match (self.read(target)?, expected) {
            (TargetHash::Absent, _) => TargetHolds::Nothing,
            (TargetHash::Sha(sha), Preimage::Present(expected)) if sha == *expected => {
                TargetHolds::Expected
            }
            _ => TargetHolds::Other,
        })
    }
}

/// One try of moving `target` to `displaced`. `Done(false)` when nothing was
/// at the target.
fn displace_attempt(
    replacer: &dyn AtomicReplacer,
    target: &Path,
    displaced: &Path,
) -> Result<Attempt<bool>, MaterializeError> {
    match replacer.displace(target, displaced) {
        Ok(()) => Ok(Attempt::Done(true)),
        // A rename can report failure after it happened: an NFS client that
        // retransmits it gets ENOENT back. The displaced name decides.
        Err(err) if err.kind() == ErrorKind::AlreadyExists => {
            Err(MaterializeError::io(displaced, &err))
        }
        Err(_) if !entry_exists(target)? && entry_exists(displaced)? => Ok(Attempt::Done(true)),
        Err(err) if err.kind() == ErrorKind::NotFound => Ok(Attempt::Done(false)),
        Err(err) if is_transient_lock(&err) => Ok(Attempt::Locked(err)),
        Err(err) => Err(MaterializeError::io(target, &err)),
    }
}

fn entry_exists(path: &Path) -> Result<bool, MaterializeError> {
    match std::fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(err) if err.kind() == ErrorKind::NotFound => Ok(false),
        Err(err) => Err(MaterializeError::io(path, &err)),
    }
}

/// Create an expected-absent target from the temp. `false` when something is
/// at the target, because the recheck saw it or it appeared before the rename.
fn create_from_temp(
    target: &Path,
    tmp: &Path,
    options: &MaterializeOptions<'_>,
) -> Result<bool, MaterializeError> {
    retry_while_locked(target, tmp, options.backoff, MAX_REPLACE_ATTEMPTS, || {
        if !matches!(read_current_no_follow(target)?, CurrentTarget::Absent) {
            return Ok(Attempt::Done(false));
        }
        place_attempt(options.replacer, tmp, target)
    })
}

/// Rename the temp to the name staging emptied. `false` when a program
/// created the target in between. On any other failure the staged file is
/// moved back, so the target name is not left empty. One that cannot go back
/// gets an open row, so recovery returns it once the temp is gone.
fn place_after_stage(
    store: &EngineStore,
    target: &Path,
    tmp: &Path,
    spec: &DisplacementSpec,
    staging: &Path,
    options: &MaterializeOptions<'_>,
) -> Result<bool, MaterializeError> {
    let placed = retry_while_locked(target, tmp, options.backoff, MAX_REPLACE_ATTEMPTS, || {
        place_attempt(options.replacer, tmp, target)
    });
    if placed.is_err()
        && !matches!(
            return_displaced(target, &staging.join(&spec.displaced_name), options),
            Ok(true)
        )
    {
        store.open_displacement(spec)?;
    }
    placed
}

/// One try of a no-replace placement. Every placement, by a write, a delete's
/// return, or recovery after a restart, comes through here. A placement that
/// chose the check-then-rename records its directory, so the workspace
/// reports the limit, whether that rename succeeded or failed.
fn place_attempt(
    replacer: &dyn AtomicReplacer,
    incoming: &Path,
    target: &Path,
) -> Result<Attempt<bool>, MaterializeError> {
    let placed = replacer.place(incoming, target);
    let fell_back = match &placed {
        Ok(placement) => *placement == Placement::CheckThenRename,
        Err(err) => CheckThenRenameFailed::is(err),
    };
    if fell_back
        && let Some(dir) = target.parent()
        && let Ok(mut dirs) = dirs_without_atomic_placement().lock()
    {
        dirs.insert(dir.to_path_buf());
    }
    match placed {
        Ok(_) => Ok(Attempt::Done(true)),
        Err(err) if err.kind() == ErrorKind::AlreadyExists => Ok(Attempt::Done(false)),
        Err(err) if is_transient_lock(&err) => Ok(Attempt::Locked(err)),
        Err(err) => Err(MaterializeError::io(target, &err)),
    }
}

/// Directories where a placement found a filesystem with no atomic
/// no-replace rename, for the life of the process.
fn dirs_without_atomic_placement() -> &'static std::sync::Mutex<std::collections::HashSet<PathBuf>>
{
    static DIRS: std::sync::OnceLock<std::sync::Mutex<std::collections::HashSet<PathBuf>>> =
        std::sync::OnceLock::new();
    DIRS.get_or_init(Default::default)
}

/// Whether a placement under this workspace root found a filesystem that
/// cannot refuse to replace a file (`no-atomic-placement`). Such a write
/// still happens, but a file another program creates at the same moment can
/// be lost. Sticky for the life of the process.
pub fn workspace_lacks_atomic_placement(root: &Path) -> bool {
    let Ok(dirs) = dirs_without_atomic_placement().lock() else {
        return false;
    };
    if dirs.is_empty() {
        return false;
    }
    let Ok(root) = std::fs::canonicalize(root) else {
        return false;
    };
    dirs.iter().any(|dir| dir.starts_with(&root))
}

/// How many tries a displaced file gets to go back to its path: about a
/// second of backoff, more than a replace gets, because every other program
/// sees the file missing until it succeeds.
const RETURN_ATTEMPTS: u32 = 10;

/// Move a staged file back to its empty target name. `false` when a
/// program created the target meanwhile, so the file stays staged.
fn return_displaced(
    target: &Path,
    staged: &Path,
    options: &MaterializeOptions<'_>,
) -> Result<bool, MaterializeError> {
    let returned = retry_while_locked(target, staged, options.backoff, RETURN_ATTEMPTS, || {
        place_attempt(options.replacer, staged, target)
    })?;
    if returned {
        sync_parent_dir(target.parent(), options.policy)?;
        sync_parent_dir(staged.parent(), options.policy)?;
    }
    Ok(returned)
}

/// Put a displaced file whose bytes the store does not have back at its path.
/// A write first moves the job's content, which it placed there, aside to the
/// conflict sibling. Anything else at the target is someone's newer file: it
/// stays, and the displaced file stays displaced with a kept row, as does a
/// displaced file that cannot go back. Returns `true` when something stays
/// displaced.
fn swap_back(
    store: &EngineStore,
    target: &Path,
    moved: &Moved,
    inspected: &Inspected,
    options: &MaterializeOptions<'_>,
) -> Result<bool, MaterializeError> {
    let keep_moved = |store: &EngineStore| {
        store.resolve_displacement(
            moved.displacement_id,
            keep_resolution(inspected),
            None,
            options.now_ms,
        )
    };
    let aside = match &moved.content_sha256 {
        Some(content) => match move_aside(store, target, moved, content, options)? {
            Aside::Moved(aside) => Some(aside),
            Aside::Empty => None,
            Aside::Other => {
                keep_moved(store)?;
                return Ok(true);
            }
        },
        None => None,
    };
    if let Some(aside) = &aside
        && !matches!(
            aside.inspect(store)?,
            Inspected::Known { .. } | Inspected::Missing
        )
    {
        // Someone else's file landed between the check and the move. Put it
        // back where it was; the displaced file stays displaced. Its row is
        // kept first, so a put-back that fails leaves only the newer file's
        // open row, which the next recovery returns.
        keep_moved(store)?;
        let back = if return_displaced(target, &aside.path, options)? {
            DisplacementResolution::Discard
        } else {
            DisplacementResolution::Keep {
                displaced_sha256: None,
            }
        };
        store.resolve_displacement(aside.displacement_id, back, None, options.now_ms)?;
        return Ok(true);
    }
    let returned = return_displaced(target, &moved.path, options)?;
    if returned {
        store.resolve_displacement(
            moved.displacement_id,
            DisplacementResolution::Discard,
            None,
            options.now_ms,
        )?;
    } else {
        keep_moved(store)?;
    }
    let mut kept = !returned;
    if let Some(aside) = aside {
        let conflict_path = conflict_sibling(target, &aside.job_id);
        let resolution = if !entry_exists(&aside.path)?
            || std::fs::rename(&aside.path, &conflict_path).is_ok()
        {
            DisplacementResolution::Discard
        } else {
            // The job's content stays at its displaced name. Its kept row
            // holds the job's own hash, so the row says whose bytes they are.
            kept = true;
            DisplacementResolution::Keep {
                displaced_sha256: aside.content_sha256.as_deref(),
            }
        };
        store.resolve_displacement(aside.displacement_id, resolution, None, options.now_ms)?;
    }
    Ok(kept)
}

/// What [`move_aside`] found at the target.
enum Aside {
    /// The job's content, now at this displaced file.
    Moved(Moved),
    /// Nothing.
    Empty,
    /// Something other than the job's content, left where it is.
    Other,
}

/// Move the job's content off the target into staging, with an open row that
/// expects it. Every attempt first checks that the target still holds the
/// job's content, so a newer file saved there is never moved.
fn move_aside(
    store: &EngineStore,
    target: &Path,
    moved: &Moved,
    content: &str,
    options: &MaterializeOptions<'_>,
) -> Result<Aside, MaterializeError> {
    let staging = moved.path.parent().unwrap_or(Path::new(""));
    let taken: Vec<String> = store
        .list_displacements_for_job(&moved.job_id)?
        .into_iter()
        .map(|row| row.displaced_name)
        .collect();
    let spec = DisplacementSpec {
        job_id: moved.job_id.clone(),
        workspace_id: moved.workspace_id.clone(),
        target_path: moved.target_path.clone(),
        displaced_name: unused_staged_name(staging, &moved.job_id, &taken)?,
        expected_sha256: content.to_owned(),
        content_sha256: Some(content.to_owned()),
        now_ms: options.now_ms,
    };
    let aside = Moved::open(store, spec, staging)?;
    let displacement_id = aside.displacement_id;
    let ours = Preimage::Present(content.to_owned());
    let mut reads = TargetReads::default();
    let attempt = retry_while_locked(target, target, options.backoff, RETURN_ATTEMPTS, || {
        match reads.check(target, &ours) {
            Ok(TargetHolds::Nothing) => return Ok(Attempt::Done(Some(false))),
            Ok(TargetHolds::Expected) => {}
            Ok(TargetHolds::Other) | Err(MaterializeError::SymlinkTarget) => {
                return Ok(Attempt::Done(None));
            }
            Err(err) => return Err(err),
        }
        displace_attempt(options.replacer, target, &aside.path).map(|attempt| match attempt {
            Attempt::Done(moved) => Attempt::Done(Some(moved)),
            Attempt::Locked(err) => Attempt::Locked(err),
        })
    });
    if let Ok(Some(true)) = attempt {
        sync_staged(staging, options.policy)?;
        sync_parent_dir(target.parent(), options.policy)?;
        return Ok(Aside::Moved(aside));
    }
    store.resolve_displacement(
        displacement_id,
        DisplacementResolution::Discard,
        None,
        options.now_ms,
    )?;
    match attempt? {
        Some(_) => Ok(Aside::Empty),
        None => Ok(Aside::Other),
    }
}

/// An unreadable file is kept with no hash, which replay inspects again.
fn keep_resolution(inspected: &Inspected) -> DisplacementResolution<'_> {
    DisplacementResolution::Keep {
        displaced_sha256: keep_sha256(inspected),
    }
}

fn keep_sha256(inspected: &Inspected) -> Option<&str> {
    match inspected {
        Inspected::Unknown { sha256 } => Some(sha256),
        _ => None,
    }
}

/// What a displaced file holds.
enum Inspected {
    Missing,
    /// A regular file within the cap holding one of the expected hashes, whose
    /// bytes the store holds, and which no other handle had open for writing
    /// when it was read.
    Known {
        _guard: std::fs::File,
    },
    /// Bytes that are not one of the expected hashes, or that the store does
    /// not hold.
    Unknown {
        sha256: String,
    },
    /// Present but not comparable: not a regular file, over the cap,
    /// unreadable, or on Windows still open for writing by another program.
    Unreadable,
}

/// Read a displaced file and judge it: it may be deleted only when it holds
/// the `expected` preimage or the job's own `content`. A match counts only
/// when the store holds that blob: a preimage can come from disk, as a version
/// switch probes it. Any other stored blob, such as an older head a
/// `git checkout` restored, is an outside change. An empty file needs no
/// blob, but only an empty preimage makes it known, whatever the job writes:
/// a writer that truncated the file may still be writing.
fn inspect_displaced(
    store: &EngineStore,
    path: &Path,
    expected: &str,
    content: Option<&str>,
) -> Result<Inspected, MaterializeError> {
    let file = match open_displaced(path) {
        Ok(file) => file,
        Err(err) if err.kind() == ErrorKind::NotFound => return Ok(Inspected::Missing),
        Err(_) => return Ok(Inspected::Unreadable),
    };
    let Ok(metadata) = file.metadata() else {
        return Ok(Inspected::Unreadable);
    };
    if metadata.file_type().is_symlink()
        || metadata_is_reparse_point(&metadata)
        || !metadata.is_file()
        || metadata.len() > MAX_MATERIALIZE_BYTES as u64
    {
        return Ok(Inspected::Unreadable);
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    if (&file)
        .take(MAX_MATERIALIZE_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .is_err()
        || bytes.len() > MAX_MATERIALIZE_BYTES
    {
        return Ok(Inspected::Unreadable);
    }
    let sha256 = hex_sha256(&bytes);
    let expected_bytes = sha256 == expected || content == Some(sha256.as_str());
    let known = if bytes.is_empty() {
        expected == hex_sha256(b"")
    } else {
        expected_bytes && store.holds_content(&sha256)?
    };
    if known {
        Ok(Inspected::Known { _guard: file })
    } else {
        Ok(Inspected::Unknown { sha256 })
    }
}

/// Open a displaced file for reading without following a link. On Windows
/// the handle denies write sharing, so the open fails while another handle
/// has the file open for writing.
fn open_displaced(path: &Path) -> std::io::Result<std::fs::File> {
    #[cfg(unix)]
    {
        use rustix::fs::{Mode, OFlags};
        rustix::fs::openat(
            rustix::fs::CWD,
            path,
            OFlags::RDONLY | OFlags::NONBLOCK | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        )
        .map(std::fs::File::from)
        .map_err(std::io::Error::from)
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_SHARE_READ: u32 = 0x0000_0001;
        const FILE_SHARE_DELETE: u32 = 0x0000_0004;
        const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
        const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
        std::fs::OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_DELETE)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
            .open(path)
    }
    #[cfg(not(any(unix, windows)))]
    {
        std::fs::File::open(path)
    }
}

/// Where a replace stages the file it moves off its path, below the
/// workspace root. Capture never reads under `.dohc`, and the directory is on
/// the workspace's volume, so staging is one plain rename.
const STAGING_DIR: &str = ".dohc/engine/displaced";

fn sync_staged(staging: &Path, policy: DurabilityPolicy) -> Result<(), MaterializeError> {
    sync_parent_dir(Some(staging), policy)?;
    // Include newly created staging ancestors before source removal is synced.
    sync_parent_dir(staging.parent(), policy)?;
    sync_parent_dir(staging.parent().and_then(Path::parent), policy)
}

/// The staging directory under an already-canonicalized root. Every
/// component must be a real directory; `create` makes the missing ones.
fn staging_dir(root: &Path, create: bool) -> Result<PathBuf, MaterializeError> {
    let dir = root.join(STAGING_DIR);
    if create {
        walk_target_components(root, &dir, ensure_real_directory)?;
    } else {
        ensure_target_symlink_free(root, &dir)?;
    }
    Ok(dir)
}

/// How many staged files one job can hold before its replace refuses.
const MAX_DISPLACED_NAMES: u32 = 64;

/// Job ids up to this many bytes are spelled out in staged names.
const MAX_SPELLED_JOB_ID: usize = 100;

/// The part of a staged name that names its job: the id's bytes in lowercase
/// hex, which recovery decodes back to the id, or `h` and the id's hash when
/// the id is too long for a file name.
fn staged_key(job_id: &str) -> String {
    use std::fmt::Write;
    if job_id.len() > MAX_SPELLED_JOB_ID {
        return format!("h{}", hex_sha256(job_id.as_bytes()));
    }
    let mut key = String::with_capacity(job_id.len() * 2);
    for byte in job_id.bytes() {
        let _ = write!(key, "{byte:02x}");
    }
    key
}

/// The `n`th staged name for a job. The names are fixed per job, so recovery
/// can find a staged file no row names.
fn staged_name(job_id: &str, n: u32) -> String {
    format!("{}.{n}", staged_key(job_id))
}

/// Split a staged name into its job key, or `None` for a name no replace
/// makes.
fn staged_name_key(name: &str) -> Option<&str> {
    let (key, n) = name.rsplit_once('.')?;
    let n_ok = !n.is_empty()
        && n.bytes().all(|b| b.is_ascii_digit())
        && (n == "0" || !n.starts_with('0'))
        && n.parse::<u32>().is_ok_and(|n| n < MAX_DISPLACED_NAMES);
    let lower_hex = |s: &str| s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'));
    let key_ok = match key.strip_prefix('h') {
        Some(hash) => hash.len() == 64 && lower_hex(hash),
        None => !key.is_empty() && key.len() % 2 == 0 && lower_hex(key),
    };
    (n_ok && key_ok).then_some(key)
}

fn is_staged_name(name: &str) -> bool {
    staged_name_key(name).is_some()
}

/// The job a staged name spells, and its id, when the store still has it. A
/// hashed key also matches completed jobs whose staged cleanup was interrupted.
fn staged_job(
    store: &EngineStore,
    key: &str,
) -> Result<(Option<String>, Option<MaterializationJob>), MaterializeError> {
    if key.starts_with('h') {
        let job = store
            .list_materialization_jobs()?
            .into_iter()
            .find(|job| staged_key(&job.job_id) == key);
        return Ok((job.as_ref().map(|job| job.job_id.clone()), job));
    }
    let bytes: Option<Vec<u8>> = (0..key.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&key[i..i + 2], 16).ok())
        .collect();
    let Some(job_id) = bytes.and_then(|bytes| String::from_utf8(bytes).ok()) else {
        return Ok((None, None));
    };
    if staged_key(&job_id) != key {
        return Ok((None, None));
    }
    let job = store.load_materialization_job(&job_id)?;
    Ok((Some(job_id), job))
}

/// The first staged name for this job that no row holds and no file uses.
fn unused_staged_name(
    staging: &Path,
    job_id: &str,
    taken: &[String],
) -> Result<String, MaterializeError> {
    for n in 0..MAX_DISPLACED_NAMES {
        let name = staged_name(job_id, n);
        if !taken.contains(&name) && !entry_exists(&staging.join(&name))? {
            return Ok(name);
        }
    }
    Err(MaterializeError::io(
        staging,
        &std::io::Error::from(ErrorKind::AlreadyExists),
    ))
}

/// The files in `staging` no row names, with the id and job their names
/// spell. A name no replace makes is left alone.
fn rowless_staged(
    store: &EngineStore,
    staging: &Path,
) -> Result<Vec<RowlessStaged>, MaterializeError> {
    let entries = match std::fs::read_dir(staging) {
        Ok(entries) => entries,
        Err(err) if err.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
        Err(err) => return Err(MaterializeError::io(staging, &err)),
    };
    let mut found = Vec::new();
    let names = store.displacement_names()?;
    for entry in entries {
        let entry = entry.map_err(|err| MaterializeError::io(staging, &err))?;
        let Ok(name) = entry.file_name().into_string() else {
            continue;
        };
        let Some(key) = staged_name_key(&name) else {
            continue;
        };
        if names.contains(&name) {
            continue;
        }
        let (job_id, job) = staged_job(store, key)?;
        let job_id = job_id.unwrap_or_else(|| key.to_owned());
        found.push(RowlessStaged { name, job_id, job });
    }
    Ok(found)
}

/// A staged file no row names.
struct RowlessStaged {
    name: String,
    /// The id its name spells, or its key when the name spells none.
    job_id: String,
    job: Option<MaterializationJob>,
}

/// Recovery order belongs to the staged name, not to whether adoption has
/// committed a row. Use the job's creation time across jobs and its reserved
/// sequence within one job, with the job id breaking timestamp ties.
fn ordered_recovery(
    store: &EngineStore,
    rowless: Vec<RowlessStaged>,
    rows: Vec<Displacement>,
) -> Result<Vec<RecoveryEntry>, MaterializeError> {
    let mut entries = std::collections::HashMap::new();
    for staged in rowless {
        let created = staged.job.as_ref().map_or(0, |job| job.created_at_ms);
        entries.insert(
            staged.name.clone(),
            (created, RecoveryEntry::Rowless(staged)),
        );
    }
    for row in rows {
        let created = store
            .load_materialization_job(&row.job_id)?
            .map_or(row.created_at_ms, |job| job.created_at_ms);
        entries.insert(
            row.displaced_name.clone(),
            (created, RecoveryEntry::Journaled(row)),
        );
    }
    let mut entries: Vec<_> = entries.into_iter().collect();
    entries.sort_by_cached_key(|(name, (created, entry))| {
        let sequence = name
            .rsplit_once('.')
            .and_then(|(_, n)| n.parse::<u32>().ok());
        std::cmp::Reverse((*created, entry.job_id().to_owned(), sequence, name.clone()))
    });
    Ok(entries.into_iter().map(|(_, (_, entry))| entry).collect())
}

enum RecoveryEntry {
    Rowless(RowlessStaged),
    Journaled(Displacement),
}

impl RecoveryEntry {
    fn job_id(&self) -> &str {
        match self {
            Self::Rowless(staged) => &staged.job_id,
            Self::Journaled(row) => &row.job_id,
        }
    }

    fn workspace_id(&self) -> &str {
        match self {
            Self::Rowless(staged) => staged
                .job
                .as_ref()
                .map_or("", |job| job.workspace_id.as_str()),
            Self::Journaled(row) => &row.workspace_id,
        }
    }

    fn recover(
        &self,
        store: &EngineStore,
        root: &Path,
        staging: &Path,
        workspace_id: &str,
        options: &MaterializeOptions<'_>,
    ) -> Result<bool, MaterializeError> {
        match self {
            Self::Journaled(row) => recover_displacement(store, root, staging, row, options),
            Self::Rowless(staged) => match &staged.job {
                Some(job) => recover_staged(store, root, staging, &staged.name, job, options),
                None => keep_orphan(store, staging, staged, workspace_id, options),
            },
        }
    }
}

/// Remove the directory at `rel` when it is empty, so a file can take its
/// name. Used when a sync page deletes the last tracked files under a path
/// and then writes a file there. Only a real, empty directory below the
/// workspace root is removed; `false` when nothing was removed.
pub fn remove_empty_directory_target(root: &Path, rel: &str) -> Result<bool, MaterializeError> {
    let canonical_root =
        std::fs::canonicalize(root).map_err(|err| MaterializeError::io(root, &err))?;
    let target = resolve_target(&canonical_root, rel)?;
    ensure_target_symlink_free(&canonical_root, &target)?;
    let Ok(metadata) = std::fs::symlink_metadata(&target) else {
        return Ok(false);
    };
    if !metadata.is_dir()
        || metadata.file_type().is_symlink()
        || metadata_is_reparse_point(&metadata)
    {
        return Ok(false);
    }
    // `remove_dir` refuses a directory that is not empty.
    if std::fs::remove_dir(&target).is_ok() {
        sync_parent_dir(target.parent(), DurabilityPolicy::per_os())?;
        Ok(true)
    } else {
        Ok(false)
    }
}

fn unavailable_recovery_roots() -> &'static std::sync::Mutex<std::collections::HashSet<PathBuf>> {
    static ROOTS: std::sync::OnceLock<std::sync::Mutex<std::collections::HashSet<PathBuf>>> =
        std::sync::OnceLock::new();
    ROOTS.get_or_init(Default::default)
}

fn set_recovery_unavailable(root: &Path, unavailable: bool) {
    if let Ok(mut roots) = unavailable_recovery_roots().lock() {
        if unavailable {
            roots.insert(root.to_owned());
        } else {
            roots.remove(root);
        }
    }
}

/// Whether the latest recovery scan could not read this workspace's staging directory.
pub fn workspace_recovery_unavailable(root: &Path) -> bool {
    std::fs::canonicalize(root).ok().is_some_and(|root| {
        unavailable_recovery_roots()
            .lock()
            .is_ok_and(|roots| roots.contains(&root))
    })
}

/// Resolve every staged file a crash or a failed return left under `root`:
/// open rows, kept files whose bytes could not be read before, and staged
/// files no row names, even when their job is finished or gone. A file that
/// stays staged makes its still-pending job conflict, so the person is told.
/// `workspace_id` narrows the sweep the way the replay it precedes is
/// narrowed; `None` sweeps everything. A file whose path is blocked or
/// unreadable stays for the next sweep, and a staging directory that is not
/// a real directory is not swept.
pub fn recover_displacements(
    store: &EngineStore,
    root: &Path,
    workspace_id: Option<&str>,
    options: &MaterializeOptions<'_>,
) -> Result<(), MaterializeError> {
    let canonical_root =
        std::fs::canonicalize(root).map_err(|err| MaterializeError::io(root, &err))?;
    let staging = match staging_dir(&canonical_root, false) {
        Ok(staging) => staging,
        Err(_) => {
            set_recovery_unavailable(&canonical_root, true);
            return Ok(());
        }
    };
    let rowless = match rowless_staged(store, &staging) {
        Ok(rowless) => rowless,
        Err(MaterializeError::Storage(err)) => return Err(err.into()),
        Err(_) => {
            set_recovery_unavailable(&canonical_root, true);
            return Ok(());
        }
    };
    set_recovery_unavailable(&canonical_root, false);
    // Only a storage failure stops the sweep; any other failure leaves that
    // file for the next one.
    let settle = |recovered: Result<bool, MaterializeError>, job_id: &str| match recovered {
        Ok(true) => conflict_if_pending(store, job_id, options.now_ms),
        Ok(false) => Ok(()),
        Err(MaterializeError::Storage(err)) => Err(err.into()),
        Err(_) => Ok(()),
    };
    // Adopt unknown rowless files together before restoring any of them.
    let mut adopt = Vec::new();
    for staged in &rowless {
        if let Some(job) = &staged.job
            && workspace_id.is_some_and(|id| !job.workspace_id.is_empty() && id != job.workspace_id)
        {
            continue;
        }
        let spec = DisplacementSpec {
            job_id: staged.job_id.clone(),
            workspace_id: staged.job.as_ref().map_or_else(
                || workspace_id.unwrap_or("").to_owned(),
                |job| job.workspace_id.clone(),
            ),
            target_path: staged
                .job
                .as_ref()
                .map_or_else(String::new, |job| job.target_path.clone()),
            displaced_name: staged.name.clone(),
            expected_sha256: staged
                .job
                .as_ref()
                .and_then(|job| match &job.preimage {
                    Preimage::Present(hash) => Some(hash.clone()),
                    Preimage::Absent => None,
                })
                .unwrap_or_default(),
            content_sha256: staged
                .job
                .as_ref()
                .filter(|job| job.operation == MaterializationOperation::Write)
                .map(|job| job.content_sha256.clone()),
            now_ms: options.now_ms,
        };
        let inspected = inspect_displaced(
            store,
            &staging.join(&staged.name),
            &spec.expected_sha256,
            spec.content_sha256.as_deref(),
        )?;
        if !matches!(inspected, Inspected::Known { .. } | Inspected::Missing) {
            adopt.push(spec);
        }
    }
    if !adopt.is_empty() {
        sync_staged(&staging, options.policy)?;
        store.open_displacements(&adopt)?;
    }
    if !adopt.is_empty()
        && should_crash(
            options.faults,
            FaultPoint::MaterializeAfterDisplacementJournal,
        )
    {
        return Err(MaterializeError::io(
            &staging,
            &std::io::Error::from(ErrorKind::Interrupted),
        ));
    }
    for entry in ordered_recovery(store, rowless, store.list_unsettled_displacements()?)? {
        if workspace_id
            .is_some_and(|id| !entry.workspace_id().is_empty() && entry.workspace_id() != id)
        {
            continue;
        }
        let recovered = entry.recover(
            store,
            &canonical_root,
            &staging,
            workspace_id.unwrap_or(""),
            options,
        );
        settle(recovered, entry.job_id())?;
    }
    Ok(())
}

/// Keep a staged file no job identifies where it is, with a kept row as the
/// evidence. `true` unless the file is gone.
fn keep_orphan(
    store: &EngineStore,
    staging: &Path,
    staged: &RowlessStaged,
    workspace_id: &str,
    options: &MaterializeOptions<'_>,
) -> Result<bool, MaterializeError> {
    // An empty expected hash matches nothing, so the file is never known.
    let inspected = inspect_displaced(store, &staging.join(&staged.name), "", None)?;
    if matches!(inspected, Inspected::Missing) {
        return Ok(false);
    }
    store.keep_displacement(
        &DisplacementSpec {
            job_id: staged.job_id.clone(),
            workspace_id: workspace_id.to_owned(),
            target_path: String::new(),
            displaced_name: staged.name.clone(),
            expected_sha256: String::new(),
            content_sha256: None,
            now_ms: options.now_ms,
        },
        keep_sha256(&inspected),
    )?;
    Ok(true)
}

fn conflict_if_pending(
    store: &EngineStore,
    job_id: &str,
    now_ms: i64,
) -> Result<(), MaterializeError> {
    if store
        .load_materialization_job(job_id)?
        .is_some_and(|job| job.status == JobStatus::Pending)
    {
        store.mark_materialization_conflict(job_id, now_ms)?;
    }
    Ok(())
}

/// Resolve the unfinished staged files of one path, from any job. The actor
/// runs this, without backoff sleeps, before it refuses an absence it cannot
/// confirm, so a staged file that could not go back when its replace ran
/// gets another try as soon as capture or a delete looks at the path. The
/// sweep keeps retrying with backoff.
pub fn recover_path_displacements(
    store: &EngineStore,
    root: &Path,
    workspace_id: &str,
    path: &str,
    options: &MaterializeOptions<'_>,
) -> Result<(), MaterializeError> {
    let canonical_root =
        std::fs::canonicalize(root).map_err(|err| MaterializeError::io(root, &err))?;
    let staging = staging_dir(&canonical_root, false)?;
    let rowless = rowless_staged(store, &staging)?
        .into_iter()
        .filter(|staged| {
            staged
                .job
                .as_ref()
                .is_some_and(|job| job_targets(job, workspace_id, path))
        })
        .collect();
    let rows = store.list_unsettled_displacements_for_path(workspace_id, path)?;
    for entry in ordered_recovery(store, rowless, rows)? {
        if entry.recover(store, &canonical_root, &staging, workspace_id, options)? {
            conflict_if_pending(store, entry.job_id(), options.now_ms)?;
        }
    }
    Ok(())
}

/// Whether a replace left `path`'s file staged where it may still go back:
/// an open row names it, or a pending job that targets it staged a file no
/// row names yet. Capture must not record such a path as deleted.
pub fn path_is_displaced(
    store: &EngineStore,
    root: &Path,
    workspace_id: &str,
    path: &str,
) -> Result<bool, MaterializeError> {
    if store.path_is_displaced(workspace_id, path)? {
        return Ok(true);
    }
    if !store.has_pending_materialization_for_path(workspace_id, path)? {
        return Ok(false);
    }
    let canonical_root =
        std::fs::canonicalize(root).map_err(|err| MaterializeError::io(root, &err))?;
    let staging = staging_dir(&canonical_root, false)?;
    Ok(rowless_staged(store, &staging)?.iter().any(|staged| {
        staged.job.as_ref().is_some_and(|job| {
            job.status == JobStatus::Pending && job_targets(job, workspace_id, path)
        })
    }))
}

fn job_targets(job: &MaterializationJob, workspace_id: &str, path: &str) -> bool {
    job.target_path == path
        && (workspace_id.is_empty()
            || job.workspace_id.is_empty()
            || job.workspace_id == workspace_id)
}

/// Resolve this job's staged files, and any other job's open rows for the
/// same path, before it runs, including a staged file no row names because
/// the run that staged it stopped. Returns the staging directory with the
/// names this job's rows hold, and `true` when a file held bytes the store
/// does not have and could not go back to its path.
fn recover_job_displacements(
    store: &EngineStore,
    root: &Path,
    job: &MaterializationJob,
    options: &MaterializeOptions<'_>,
) -> Result<(Staging, bool), MaterializeError> {
    // Only a job that expects a file can stage one.
    let path_rows =
        store.list_unsettled_displacements_for_path(&job.workspace_id, &job.target_path)?;
    if matches!(job.preimage, Preimage::Absent) && path_rows.is_empty() {
        return Ok((
            Staging {
                dir: root.join(STAGING_DIR),
                taken: Vec::new(),
            },
            false,
        ));
    }
    let dir = staging_dir(root, matches!(job.preimage, Preimage::Present(_))).map_err(|_| {
        set_recovery_unavailable(root, true);
        MaterializeError::RecoveryUnavailable
    })?;
    let mut rows = store.list_displacements_for_job(&job.job_id)?;
    let mut taken: Vec<String> = rows.iter().map(|row| row.displaced_name.clone()).collect();
    // Scan entries rather than stopping at a gap: a person may have removed
    // an earlier copy. The common empty directory needs only one read_dir.
    let mut rowless = Vec::new();
    let entries = match std::fs::read_dir(&dir) {
        Ok(entries) => Some(entries),
        Err(err) if err.kind() == ErrorKind::NotFound => None,
        Err(_) => {
            set_recovery_unavailable(root, true);
            return Err(MaterializeError::RecoveryUnavailable);
        }
    };
    if let Some(entries) = entries {
        let key = staged_key(&job.job_id);
        for entry in entries {
            let entry = entry.map_err(|_| {
                set_recovery_unavailable(root, true);
                MaterializeError::RecoveryUnavailable
            })?;
            let Ok(name) = entry.file_name().into_string() else {
                continue;
            };
            if staged_name_key(&name) == Some(key.as_str()) && !taken.contains(&name) {
                rowless.push(name);
            }
        }
    }
    for row in path_rows {
        if !rows
            .iter()
            .any(|seen| seen.displacement_id == row.displacement_id)
        {
            rows.push(row);
        }
    }
    rows.retain(|row| row.state == DisplacementState::Open || row.displaced_sha256.is_none());
    if rows.is_empty() && rowless.is_empty() {
        return Ok((Staging { dir, taken }, false));
    }
    let rowless = rowless
        .into_iter()
        .map(|name| RowlessStaged {
            name,
            job_id: job.job_id.clone(),
            job: Some(job.clone()),
        })
        .collect();
    let mut kept = false;
    for entry in ordered_recovery(store, rowless, rows)? {
        kept |= entry.recover(store, root, &dir, &job.workspace_id, options)?;
    }
    taken = store
        .list_displacements_for_job(&job.job_id)?
        .into_iter()
        .map(|row| row.displaced_name)
        .collect();
    Ok((Staging { dir, taken }, kept))
}

/// Settle a staged file no row names, for the job its name spells. A write
/// whose temp is still beside an empty target never placed its content, so
/// the file goes back and the job runs again against it. Any other staged
/// file is judged like a finished replace: deleted when its bytes are known,
/// otherwise given an open row and put back. Returns `true` when it stays
/// staged.
fn recover_staged(
    store: &EngineStore,
    root: &Path,
    staging: &Path,
    name: &str,
    job: &MaterializationJob,
    options: &MaterializeOptions<'_>,
) -> Result<bool, MaterializeError> {
    let target = resolve_target(root, &job.target_path)?;
    ensure_target_symlink_free(root, &target)?;
    let staged = staging.join(name);
    let write = job.operation == MaterializationOperation::Write;
    if write
        && !entry_exists(&target)?
        && entry_exists(&temp_sibling(&target, &job.job_id))?
        && return_displaced(&target, &staged, options)?
    {
        return Ok(false);
    }
    let spec = DisplacementSpec {
        job_id: job.job_id.clone(),
        workspace_id: job.workspace_id.clone(),
        target_path: job.target_path.clone(),
        displaced_name: name.to_owned(),
        expected_sha256: match &job.preimage {
            Preimage::Present(sha) => sha.clone(),
            Preimage::Absent => String::new(),
        },
        content_sha256: write.then(|| job.content_sha256.clone()),
        now_ms: options.now_ms,
    };
    match inspect_displaced(
        store,
        &staged,
        &spec.expected_sha256,
        spec.content_sha256.as_deref(),
    )? {
        Inspected::Known { .. } | Inspected::Missing => {
            // Nothing names the file; one that cannot be deleted now is
            // found again by the next sweep.
            let _ = std::fs::remove_file(&staged);
            Ok(false)
        }
        unknown => {
            let moved = Moved::open(store, spec, staging)?;
            swap_back(store, &target, &moved, &unknown, options)
        }
    }
}

/// Resolve one open row, or inspect a kept file again. An open row names
/// bytes the store lacks, so its file goes back to an empty target name and
/// the job, if pending, runs again against it. Otherwise the file is deleted
/// when its bytes are now known, and goes back to its path, moving what is
/// there aside, when they are not. A file no job identifies stays where it
/// is. Returns `true` when a file stays staged.
fn recover_displacement(
    store: &EngineStore,
    root: &Path,
    staging: &Path,
    displacement: &Displacement,
    options: &MaterializeOptions<'_>,
) -> Result<bool, MaterializeError> {
    if !is_staged_name(&displacement.displaced_name) {
        return Err(MaterializeError::UnsafeTargetPath);
    }
    let moved = Moved::from_row(displacement, staging);
    if !entry_exists(&moved.path)? {
        store.resolve_displacement(
            moved.displacement_id,
            DisplacementResolution::Discard,
            None,
            options.now_ms,
        )?;
        return Ok(false);
    }
    if displacement.target_path.is_empty() {
        let inspected = moved.inspect(store)?;
        store.resolve_displacement(
            moved.displacement_id,
            keep_resolution(&inspected),
            None,
            options.now_ms,
        )?;
        return Ok(true);
    }
    let target = resolve_target(root, &displacement.target_path)?;
    ensure_target_symlink_free(root, &target)?;
    if displacement.state == DisplacementState::Open
        && !entry_exists(&target)?
        && return_displaced(&target, &moved.path, options)?
    {
        store.resolve_displacement(
            moved.displacement_id,
            DisplacementResolution::Discard,
            None,
            options.now_ms,
        )?;
        return Ok(false);
    }
    match moved.inspect(store)? {
        Inspected::Known { .. } | Inspected::Missing => {
            // The row ends even when the delete fails: an open row would send
            // known bytes back to an empty path. The next sweep finds the
            // file by name and deletes it.
            let _ = std::fs::remove_file(&moved.path);
            store.resolve_displacement(
                moved.displacement_id,
                DisplacementResolution::Discard,
                None,
                options.now_ms,
            )?;
            Ok(false)
        }
        other if displacement.state == DisplacementState::Kept => {
            // Inspected again and still not known: record what it holds now.
            store.resolve_displacement(
                moved.displacement_id,
                keep_resolution(&other),
                None,
                options.now_ms,
            )?;
            Ok(true)
        }
        unknown => swap_back(store, &target, &moved, &unknown, options),
    }
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
            // A handle held without read sharing fails the preimage read
            // before the replace loop can classify it. Name the lock here
            // too: the job stays pending either way, and callers key
            // their retry contract off `FileLocked`, not the io grab-bag.
            Err(err) => return Err(terminal_lock_classification(err, target)),
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
    // The open is not the only place a lock speaks. A
    // byte-range lock (`LockFileEx`) leaves the handle openable and fails the
    // read with ERROR_LOCK_VIOLATION, so classifying only the open sent that
    // file down the terminal io path — no retry, for a lock that releases.
    // Same narrow rule as the open: 32/33 only, ACL denials stay terminal.
    let metadata = file
        .metadata()
        .map_err(|err| terminal_lock_classification(err, display_path))?;
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
        .map_err(|err| terminal_lock_classification(err, display_path))?;
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

/// Visit every component strictly below an already-canonicalized workspace
/// root. This is the one component iterator used by validation-only paths and
/// ordinary parent creation, so a new mutation lane cannot silently acquire a
/// weaker walk.
fn walk_target_components(
    root: &Path,
    target: &Path,
    mut visit: impl FnMut(&Path) -> Result<(), MaterializeError>,
) -> Result<(), MaterializeError> {
    let relative = target
        .strip_prefix(root)
        .map_err(|_| MaterializeError::UnsafeTargetPath)?;
    let mut current = root.to_path_buf();
    for component in relative.components() {
        current.push(component);
        visit(&current)?;
    }
    Ok(())
}

/// Refuse every symlink/reparse point strictly below the already-canonicalized
/// workspace root through a target. Capture never owns paths reached through
/// aliased directories, even when the alias resolves elsewhere inside the
/// workspace, so projection probes and every materialization lane share this
/// component walk.
fn ensure_target_symlink_free(root: &Path, target: &Path) -> Result<(), MaterializeError> {
    walk_target_components(root, target, reject_link_or_reparse)
}

/// Validate existing ordinary ancestors and create missing ones without ever
/// asking the OS to traverse an unchecked multi-component suffix.
fn prepare_target_parent_symlink_free(root: &Path, target: &Path) -> Result<(), MaterializeError> {
    let parent = target.parent().ok_or(MaterializeError::UnsafeTargetPath)?;
    walk_target_components(root, parent, ensure_real_directory)?;
    reject_link_or_reparse(target)
}

fn ensure_real_directory(path: &Path) -> Result<(), MaterializeError> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() || metadata_is_reparse_point(&metadata) {
                return Err(MaterializeError::SymlinkTarget);
            }
            if !metadata.is_dir() {
                let err = std::io::Error::new(
                    ErrorKind::NotADirectory,
                    "materialization ancestor is not a directory",
                );
                return Err(MaterializeError::io(path, &err));
            }
            Ok(())
        }
        Err(err) if err.kind() == ErrorKind::NotFound => match std::fs::create_dir(path) {
            Ok(()) => reject_link_or_reparse(path),
            Err(create_err) if create_err.kind() == ErrorKind::AlreadyExists => {
                ensure_real_directory(path)
            }
            Err(create_err) => Err(MaterializeError::io(path, &create_err)),
        },
        Err(err) => Err(MaterializeError::io(path, &err)),
    }
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
/// `O_NOFOLLOW` does not report a symlink uniformly: with `O_DIRECTORY` Linux
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
    sibling_with_name(
        target,
        &format!(".dohc-write-{}.tmp", filesystem_job_component(job_id)),
    )
}

fn conflict_sibling(target: &Path, job_id: &str) -> PathBuf {
    let base = target
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("target");
    sibling_with_name(
        target,
        &format!("{base}.{}.conflict", filesystem_job_component(job_id)),
    )
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

fn filesystem_job_component(id: &str) -> String {
    const MAX_INLINE_LEN: usize = 96;

    let sanitized = sanitize(id);
    if sanitized.len() <= MAX_INLINE_LEN {
        sanitized
    } else {
        format!("sha256-{}", hex_sha256(id.as_bytes()))
    }
}

fn write_temp(tmp: &Path, content: &[u8]) -> Result<std::fs::File, MaterializeError> {
    #[cfg(unix)]
    {
        use std::os::fd::OwnedFd;

        let parent_path = tmp.parent().ok_or(MaterializeError::UnsafeTargetPath)?;
        let name = tmp.file_name().ok_or(MaterializeError::UnsafeTargetPath)?;
        let parent_fd: OwnedFd = std::fs::File::open(parent_path)
            .map_err(|err| MaterializeError::io(parent_path, &err))?
            .into();
        write_secret_temp_at_unix(&parent_fd, name, tmp, content)
    }
    #[cfg(not(unix))]
    {
        write_secret_temp_no_follow(tmp, content)
    }
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

/// Sync the parent directory after the rename so the directory entry change (the
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

/// Classify a failed read-open of the preimage target. Deliberately narrower
/// than [`is_transient_lock`]: only a real sharing/lock violation
/// (`ERROR_SHARING_VIOLATION` = 32, `ERROR_LOCK_VIOLATION` = 33) is
/// [`MaterializeError::FileLocked`] — the retryable contract callers poll on.
/// std folds `ERROR_ACCESS_DENIED` (5) into `PermissionDenied` as well, and an
/// ACL denial is TERMINAL: calling it a lock would put the caller into an
/// endless retry under a false cause ("another program has this file open").
///
/// This is the terminal boundary rule for the preimage read-open. The replace
/// loops at exhaustion add one probe on top ([`terminal_replace_classification`])
/// because Windows reports a held handle differently at the two boundaries:
/// a no-share read-open fails 32, but a replace over a handle held without
/// FILE_SHARE_DELETE fails with the same ERROR_ACCESS_DENIED an ACL denial
/// produces. The loops still retry on the broad predicate within their cap;
/// the error that outlives the cap must say what the cause really is.
fn terminal_lock_classification(err: std::io::Error, target: &Path) -> MaterializeError {
    // Windows-only by construction: 32 and 33 are Win32 codes, and the same
    // raw numbers are EPIPE and EDOM on Unix. This helper now serves the
    // platform-shared read below, so the guard is load-bearing rather than
    // decorative.
    if cfg!(windows) && matches!(err.raw_os_error(), Some(32) | Some(33)) {
        MaterializeError::FileLocked
    } else {
        MaterializeError::io(target, &err)
    }
}

/// What a DELETE-access probe open of the replace target observed.
#[cfg(windows)]
enum DeleteProbe {
    /// 32/33: another handle without FILE_SHARE_DELETE holds the target —
    /// the very access the replace needs and could not get. Proof of a lock.
    Contended,
    /// The probe opened. This proves nothing about the replace failure: a
    /// read-only attribute grants a DELETE-access open and still fails the
    /// replace with ACCESS_DENIED.
    Opened,
    /// Any other failure (a DACL denies the probe too, the target vanished).
    Other,
}

#[cfg(windows)]
fn probe_delete_open(target: &Path) -> DeleteProbe {
    use std::os::windows::fs::OpenOptionsExt;
    const DELETE: u32 = 0x0001_0000;
    const SHARE_ALL: u32 = 0x1 | 0x2 | 0x4; // read | write | delete
    match std::fs::OpenOptions::new()
        .access_mode(DELETE)
        .share_mode(SHARE_ALL)
        .open(target)
    {
        Ok(_) => DeleteProbe::Opened,
        Err(err) if matches!(err.raw_os_error(), Some(32) | Some(33)) => DeleteProbe::Contended,
        Err(_) => DeleteProbe::Other,
    }
}

/// What the last transient error of an exhausted retry loop proves.
enum Exhaustion {
    /// A sharing or lock violation: the retryable `FileLocked` contract.
    Locked,
    /// ERROR_ACCESS_DENIED with a probe that opened. That proves nothing, so
    /// the step gets one more try (the transient contender may be gone).
    /// Only Windows reports this error, so other targets never build it.
    #[cfg_attr(not(windows), allow(dead_code))]
    Reattempt,
    /// Anything else is terminal io.
    Terminal,
}

/// Classify a bounded replace loop's exhaustion. 32/33 keep the retryable
/// `FileLocked` contract outright. ERROR_ACCESS_DENIED is ambiguous at this
/// boundary (the dogfood shape: a handle held without FILE_SHARE_DELETE fails
/// the replace with 5, exactly like an ACL or a read-only attribute), and only
/// an observed sharing violation on `probe` proves the lock. The probe's
/// verdict: contended is `FileLocked`; an open probe earns one reattempt;
/// anything else is terminal io.
fn classify_exhaustion(err: &std::io::Error, probe: &Path) -> Exhaustion {
    if matches!(err.raw_os_error(), Some(32) | Some(33)) {
        return Exhaustion::Locked;
    }
    #[cfg(windows)]
    if err.raw_os_error() == Some(5) {
        return match probe_delete_open(probe) {
            DeleteProbe::Contended => Exhaustion::Locked,
            DeleteProbe::Opened => Exhaustion::Reattempt,
            DeleteProbe::Other => Exhaustion::Terminal,
        };
    }
    let _ = probe;
    Exhaustion::Terminal
}

/// Resolve the secret replace loop's exhaustion. `Ok(true)` means the final
/// reattempt landed the replace and `Ok(false)` that the preimage changed
/// before it; a repeat failure is terminal io unless it is itself a sharing or
/// lock violation.
fn resolve_replace_exhaustion(
    err: std::io::Error,
    target: &Path,
    reattempt: &mut dyn FnMut() -> std::io::Result<()>,
    validate: &mut dyn FnMut() -> Result<bool, MaterializeError>,
) -> Result<bool, MaterializeError> {
    match classify_exhaustion(&err, target) {
        Exhaustion::Locked => Err(MaterializeError::FileLocked),
        Exhaustion::Reattempt => {
            if !validate()? {
                return Ok(false);
            }
            match reattempt() {
                Ok(()) => Ok(true),
                Err(retry_err) if matches!(retry_err.raw_os_error(), Some(32) | Some(33)) => {
                    Err(MaterializeError::FileLocked)
                }
                Err(retry_err) => Err(MaterializeError::io(target, &retry_err)),
            }
        }
        Exhaustion::Terminal => Err(MaterializeError::io(target, &err)),
    }
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

/// One try of a replace step.
enum Attempt<T> {
    Done(T),
    /// Stopped by a transient lock ([`is_transient_lock`]) that may clear.
    Locked(std::io::Error),
}

/// Run `step` until it finishes, backing off between tries a transient lock
/// stopped, for at most `attempts` tries (plus the one reattempt
/// [`classify_exhaustion`] can grant). On exhaustion it fails closed with
/// [`MaterializeError::FileLocked`] or terminal io, leaving the job pending
/// for startup replay. `probe` is the file whose held handle would explain an
/// ambiguous denial.
fn retry_while_locked<T>(
    target: &Path,
    probe: &Path,
    backoff: &dyn ReplaceBackoff,
    attempts: u32,
    mut step: impl FnMut() -> Result<Attempt<T>, MaterializeError>,
) -> Result<T, MaterializeError> {
    let mut attempt = 0u32;
    let mut reattempted = false;
    loop {
        attempt += 1;
        let err = match step()? {
            Attempt::Done(value) => return Ok(value),
            Attempt::Locked(err) => err,
        };
        if attempt >= attempts {
            match classify_exhaustion(&err, probe) {
                Exhaustion::Locked => return Err(MaterializeError::FileLocked),
                Exhaustion::Reattempt if !reattempted => {
                    reattempted = true;
                    continue;
                }
                Exhaustion::Reattempt | Exhaustion::Terminal => {
                    return Err(MaterializeError::io(target, &err));
                }
            }
        }
        // Back off before the next attempt so a real (tens-of-ms) AV/indexer
        // sharing violation is actually absorbed. Injectable, so tests stay
        // fast.
        backoff.wait_before_retry(attempt);
    }
}

#[allow(
    clippy::too_many_arguments,
    reason = "pinned paths and retry seams keep replacement and preimage checks testable"
)]
fn replace_secret_with_bounded_retry(
    parent: &SecretParentGuard,
    tmp_name: &OsStr,
    target_name: &OsStr,
    tmp: &Path,
    target: &Path,
    replacer: &dyn AtomicReplacer,
    backoff: &dyn ReplaceBackoff,
    validate: &mut dyn FnMut() -> Result<bool, MaterializeError>,
) -> Result<bool, MaterializeError> {
    let mut attempt = 0u32;
    loop {
        if !validate()? {
            return Ok(false);
        }
        attempt += 1;
        let mut pinned_replace = || parent.rename(tmp_name, target_name, tmp, target);
        match replacer.try_replace_secret(tmp, target, &mut pinned_replace) {
            Ok(()) => return Ok(true),
            Err(err) if is_transient_lock(&err) => {
                if attempt >= MAX_REPLACE_ATTEMPTS {
                    match resolve_replace_exhaustion(
                        err,
                        target,
                        &mut || {
                            let mut pinned_replace =
                                || parent.rename(tmp_name, target_name, tmp, target);
                            replacer.try_replace_secret(tmp, target, &mut pinned_replace)
                        },
                        validate,
                    ) {
                        Ok(replaced) => return Ok(replaced),
                        Err(error) => {
                            let _ = parent.remove_file(tmp_name, tmp);
                            return Err(error);
                        }
                    }
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

#[cfg(test)]
mod tests {
    #[test]
    fn directory_replacement_removes_only_empty_real_directories() {
        let scratch = dohc_test_scratch::ScratchDir::new_named("empty-directory-target").unwrap();
        let root = scratch.path();
        std::fs::create_dir_all(root.join("d/sub")).unwrap();
        std::fs::write(root.join("d/keep.md"), "keep").unwrap();
        assert!(!super::remove_empty_directory_target(root, "d").unwrap());
        assert!(super::remove_empty_directory_target(root, "d/sub").unwrap());
        assert!(!super::remove_empty_directory_target(root, "d").unwrap());
        assert_eq!(
            std::fs::read_to_string(root.join("d/keep.md")).unwrap(),
            "keep"
        );
        assert!(!super::remove_empty_directory_target(root, "d/sub").unwrap());
        assert!(super::remove_empty_directory_target(root, "../d").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn directory_replacement_refuses_links_in_the_parent_chain() {
        let scratch = dohc_test_scratch::ScratchDir::new_named("linked-directory-target").unwrap();
        let root = scratch.path();
        std::fs::create_dir_all(root.join("real/sub")).unwrap();
        std::os::unix::fs::symlink(root.join("real"), root.join("alias")).unwrap();
        assert!(super::remove_empty_directory_target(root, "alias/sub").is_err());
        assert!(super::remove_empty_directory_target(root, "alias").is_err());
        assert!(root.join("real/sub").is_dir());
    }

    #[test]
    fn authored_create_preparation_retains_only_private_identity() {
        let root =
            dohc_test_scratch::ScratchDir::new_named("authored-preparation").expect("scratch");
        let stage =
            super::AuthoredCreateStage::open(root.path(), "nested/record.md", &"d".repeat(64))
                .expect("stage");
        stage.prepare("authored").expect("prepare");
        assert!(!stage.preparation_sibling().exists());
        assert!(!stage.target.exists());
        assert_eq!(
            std::fs::read_to_string(&stage.stage).expect("private bytes"),
            "authored"
        );
        std::fs::remove_dir(stage.target.parent().expect("parent"))
            .expect("destination removed after preparation");
        assert!(stage.stage.exists());
        let reopened =
            super::AuthoredCreateStage::open(root.path(), "nested/record.md", &"d".repeat(64))
                .expect("reopen");
        assert!(reopened.publish().expect("publish"));
        assert!(reopened.is_published().expect("retained identity"));
    }

    #[test]
    fn authored_create_failed_preparation_removes_sibling_and_preserves_existing_evidence() {
        let root =
            dohc_test_scratch::ScratchDir::new_named("authored-prepare-failure").expect("scratch");
        let stage = super::AuthoredCreateStage::open(root.path(), "record.md", &"e".repeat(64))
            .expect("stage");
        std::fs::write(&stage.stage, "prior evidence").expect("existing stage");
        assert!(stage.prepare("new attempt").is_err());
        assert!(!stage.preparation_sibling().exists());
        assert_eq!(
            std::fs::read_to_string(&stage.stage).expect("private bytes"),
            "prior evidence"
        );
        stage.cleanup().expect("discard abandoned preparation");
        stage.prepare("retry").expect("retry");
    }

    #[test]
    fn authored_create_abandoned_sibling_never_becomes_user_content() {
        let root =
            dohc_test_scratch::ScratchDir::new_named("authored-orphan-sibling").expect("scratch");
        let stage = super::AuthoredCreateStage::open(root.path(), "record.md", &"f".repeat(64))
            .expect("stage");
        let sibling = stage.preparation_sibling();
        std::fs::write(&sibling, "partial preparation").expect("crash before evidence link");
        assert!(crate::floor::is_excluded_file(
            sibling.file_name().unwrap().to_str().unwrap()
        ));
        stage.cleanup().expect("retry cleanup before intent");
        assert!(!sibling.exists());
        stage.prepare("complete").expect("prepare");
        std::fs::hard_link(&stage.stage, &sibling).expect("crash after private evidence link");
        stage.cleanup().expect("cleanup both private names");
        assert!(!sibling.exists());
        assert!(!stage.stage.exists());
        assert!(!stage.target.exists());
    }

    #[cfg(unix)]
    #[test]
    fn authored_create_uses_ordinary_restrictive_mode() {
        use std::os::unix::fs::PermissionsExt;
        let root = dohc_test_scratch::ScratchDir::new_named("authored-mode").expect("scratch");
        let stage = super::AuthoredCreateStage::open(root.path(), "record.md", &"1".repeat(64))
            .expect("stage");
        stage.prepare("authored").expect("prepare");
        let mode = std::fs::metadata(&stage.stage)
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode & !0o600, 0);
    }

    #[cfg(windows)]
    #[test]
    fn authored_create_inherits_destination_acl() {
        fn powershell(path: &std::path::Path, script: &str) {
            let output = std::process::Command::new("powershell.exe")
                .args(["-NoProfile", "-NonInteractive", "-Command", script])
                .env("DOHC_ACL_PROBE", path)
                .output()
                .expect("powershell");
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
        }
        let root = dohc_test_scratch::ScratchDir::new_named("authored-acl").expect("scratch");
        let destination = root.path().join("destination");
        std::fs::create_dir(&destination).expect("directory");
        powershell(
            &destination,
            r#"$ErrorActionPreference='Stop'; $acl=[System.IO.Directory]::GetAccessControl($env:DOHC_ACL_PROBE); $sid=[System.Security.Principal.SecurityIdentifier]::new('S-1-1-0'); $rule=[System.Security.AccessControl.FileSystemAccessRule]::new($sid,[System.Security.AccessControl.FileSystemRights]::Read,[System.Security.AccessControl.InheritanceFlags]'ObjectInherit,ContainerInherit',[System.Security.AccessControl.PropagationFlags]::None,[System.Security.AccessControl.AccessControlType]::Allow); $acl.AddAccessRule($rule); [System.IO.Directory]::SetAccessControl($env:DOHC_ACL_PROBE,$acl)"#,
        );
        let stage =
            super::AuthoredCreateStage::open(root.path(), "destination/record.md", &"2".repeat(64))
                .expect("stage");
        stage.prepare("authored").expect("prepare");
        stage.publish().expect("publish");
        powershell(
            &stage.target,
            r#"$ErrorActionPreference='Stop'; $rules=([System.IO.File]::GetAccessControl($env:DOHC_ACL_PROBE)).GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]); if (-not ($rules | Where-Object { $_.IdentityReference.Value -eq 'S-1-1-0' -and $_.IsInherited -and ($_.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::Read) })) { throw 'Destination inherited Read ACE is missing' }"#,
        );
        assert!(stage.is_published().expect("same inode"));
        assert!(!stage.preparation_sibling().exists());
    }

    #[test]
    fn authored_create_resolves_ambiguous_link_outcomes_by_identity() {
        for kind in [
            std::io::ErrorKind::TimedOut,
            std::io::ErrorKind::Other,
            std::io::ErrorKind::AlreadyExists,
        ] {
            let root = dohc_test_scratch::ScratchDir::new_named("ambiguous-link").expect("scratch");
            let stage = super::AuthoredCreateStage::open(root.path(), "record.md", &"a".repeat(64))
                .expect("stage");
            stage.prepare("authored").expect("prepare");
            let result = stage.publish_with_link(|from, to| {
                std::fs::hard_link(from, to)?;
                Err(std::io::Error::from(kind))
            });
            assert!(result.expect("own link is published"));
            assert!(stage.is_published().expect("identity"));
        }
    }

    #[test]
    fn authored_create_keeps_unknown_link_evidence_but_refuses_known_failures() {
        for kind in [
            std::io::ErrorKind::TimedOut,
            std::io::ErrorKind::AlreadyExists,
            std::io::ErrorKind::Unsupported,
        ] {
            let root = dohc_test_scratch::ScratchDir::new_named("unknown-link").expect("scratch");
            let stage = super::AuthoredCreateStage::open(root.path(), "record.md", &"b".repeat(64))
                .expect("stage");
            stage.prepare("authored").expect("prepare");
            let error = stage
                .publish_with_link(|from, _| {
                    std::fs::remove_file(from)?;
                    Err(std::io::Error::from(kind))
                })
                .expect_err("failed link");
            assert_eq!(
                error.may_be_published,
                kind != std::io::ErrorKind::Unsupported
            );
        }
    }

    #[test]
    fn authored_create_link_collision_preserves_foreign_file() {
        let root = dohc_test_scratch::ScratchDir::new_named("foreign-link").expect("scratch");
        let stage = super::AuthoredCreateStage::open(root.path(), "record.md", &"c".repeat(64))
            .expect("stage");
        stage.prepare("authored").expect("prepare");
        std::fs::write(root.path().join("record.md"), "foreign").expect("foreign");
        assert!(!stage.publish().expect("collision"));
        assert_eq!(
            std::fs::read_to_string(root.path().join("record.md")).expect("read"),
            "foreign"
        );
    }

    use super::*;
    use dohc_engine_storage::{
        FaultAction, JobStatus, MaterializationJobSpec, NoFaults, StorageError, enqueue_job,
    };
    use dohc_test_scratch::ScratchDir;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// #595 codex P2 (rounds 2+3): only a real sharing/lock violation may
    /// become the retryable `FileLocked` contract at the preimage read-open.
    /// std folds `ERROR_ACCESS_DENIED` into `PermissionDenied` too, and an
    /// ACL denial is terminal — the desktop polls `FileLocked` until it
    /// clears, so a misclassified denial means an endless retry under a
    /// false cause. (The replace boundary resolves its ambiguous
    /// ACCESS_DENIED with a probe — the test below.)
    #[test]
    fn terminal_lock_classification_splits_locks_from_acl_denials() {
        let classify = |err: std::io::Error| terminal_lock_classification(err, Path::new("n.md"));
        #[cfg(windows)]
        {
            assert!(matches!(
                classify(std::io::Error::from_raw_os_error(32)),
                MaterializeError::FileLocked
            ));
            assert!(matches!(
                classify(std::io::Error::from_raw_os_error(33)),
                MaterializeError::FileLocked
            ));
            // ERROR_ACCESS_DENIED: terminal io error, never FileLocked —
            // even though the bounded replace loops absorb it within the cap.
            assert!(matches!(
                classify(std::io::Error::from_raw_os_error(5)),
                MaterializeError::Io { .. }
            ));
            assert!(is_transient_lock(&std::io::Error::from_raw_os_error(5)));
        }
        #[cfg(not(windows))]
        {
            // 32 and 33 are EPIPE and EDOM here, not lock codes. The helper
            // serves the platform-shared read path, so the Windows guard has
            // to hold on Unix too — a retryable FileLocked for a broken pipe
            // would poll forever under a false cause. NOTE: the canonical
            // Windows gate cannot run this block; it is covered on Linux.
            assert!(matches!(
                classify(std::io::Error::from_raw_os_error(32)),
                MaterializeError::Io { .. }
            ));
            assert!(matches!(
                classify(std::io::Error::from_raw_os_error(33)),
                MaterializeError::Io { .. }
            ));
        }
        // A bare PermissionDenied (the POSIX EACCES shape): absorbed within
        // the bounded cap, terminal Io at every boundary.
        let acl = std::io::Error::from(ErrorKind::PermissionDenied);
        assert!(is_transient_lock(&acl));
        assert!(matches!(classify(acl), MaterializeError::Io { .. }));
    }

    struct AlwaysFailReplacer {
        error: fn() -> std::io::Error,
        attempts: AtomicUsize,
    }

    impl AtomicReplacer for AlwaysFailReplacer {
        fn displace(&self, _target: &Path, _displaced: &Path) -> std::io::Result<()> {
            self.attempts.fetch_add(1, Ordering::Relaxed);
            Err((self.error)())
        }

        fn place(&self, _incoming: &Path, _target: &Path) -> std::io::Result<Placement> {
            self.attempts.fetch_add(1, Ordering::Relaxed);
            Err((self.error)())
        }
    }

    fn options_with(replacer: &dyn AtomicReplacer) -> MaterializeOptions<'_> {
        MaterializeOptions {
            policy: DurabilityPolicy::none(),
            replacer,
            backoff: &NoBackoff,
            now_ms: 1,
            faults: &NoFaults,
        }
    }

    /// The replace loop retries an ACL denial to its full bounded budget —
    /// a Windows AV handle mid-scan often surfaces as ERROR_ACCESS_DENIED —
    /// but the error that outlives the cap is a terminal io failure, never
    /// the FileLocked contract the desktop polls forever.
    #[test]
    fn replace_exhaustion_classifies_acl_denials_as_terminal() {
        let scratch = Scratch::new("replace-exhaustion-acl");
        let tmp = scratch.root.join("tmp-file");
        std::fs::write(&tmp, b"pending bytes").expect("write tmp");
        let replacer = AlwaysFailReplacer {
            error: || std::io::Error::from(ErrorKind::PermissionDenied),
            attempts: AtomicUsize::new(0),
        };
        let result = create_from_temp(
            &scratch.root.join("target.md"),
            &tmp,
            &options_with(&replacer),
        );
        assert_eq!(
            replacer.attempts.load(Ordering::Relaxed),
            MAX_REPLACE_ATTEMPTS as usize
        );
        assert!(matches!(result, Err(MaterializeError::Io { .. })));
    }

    /// The replace boundary's meanings of ERROR_ACCESS_DENIED (#554, #595
    /// rounds 4+6). Only an observed sharing violation proves a lock: a
    /// handle held without FILE_SHARE_DELETE answers the probe with 32 —
    /// `FileLocked`, and no reattempt is spent. A probe that opens proves
    /// nothing (a read-only attribute opens fine for DELETE access and still
    /// fails the replace), so exactly one reattempt decides: landed means
    /// the transient contender left; a repeat denial is terminal io — never
    /// an endless file-locked poll against an attribute.
    #[cfg(windows)]
    #[test]
    fn replace_denial_probe_splits_held_handles_from_acls() {
        use std::os::windows::fs::OpenOptionsExt;
        let scratch = Scratch::new("replace-denial-probe");
        let denied = || std::io::Error::from_raw_os_error(5);

        // A real contender: convicted by the probe, no reattempt spent.
        let target = scratch.root.join("held.md");
        std::fs::write(&target, b"held").expect("write target");
        let holder = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(0x1 | 0x2) // read | write, NO delete sharing
            .open(&target)
            .expect("hold handle");
        let mut reattempts = 0u32;
        let verdict = resolve_replace_exhaustion(
            denied(),
            &target,
            &mut || {
                reattempts += 1;
                Err(denied())
            },
            &mut || Ok(true),
        );
        assert!(matches!(verdict, Err(MaterializeError::FileLocked)));
        assert_eq!(reattempts, 0, "an observed contention needs no reattempt");
        drop(holder);

        // A read-only attribute: the probe opens, the reattempt fails the
        // same way — terminal io, never the retryable lock contract.
        let read_only = scratch.root.join("read-only.md");
        std::fs::write(&read_only, b"attr").expect("write read-only target");
        let original = std::fs::metadata(&read_only).expect("meta").permissions();
        let mut readonly = original.clone();
        readonly.set_readonly(true);
        std::fs::set_permissions(&read_only, readonly).expect("set read-only");
        let mut reattempts = 0u32;
        let verdict = resolve_replace_exhaustion(
            denied(),
            &read_only,
            &mut || {
                reattempts += 1;
                Err(denied())
            },
            &mut || Ok(true),
        );
        assert!(matches!(verdict, Err(MaterializeError::Io { .. })));
        assert_eq!(reattempts, 1, "an open probe spends exactly one reattempt");
        std::fs::set_permissions(&read_only, original).expect("restore permissions");

        // The contender released between attempts: the reattempt lands.
        let freed = scratch.root.join("freed.md");
        std::fs::write(&freed, b"freed").expect("write freed target");
        let verdict =
            resolve_replace_exhaustion(denied(), &freed, &mut || Ok(()), &mut || Ok(true));
        assert!(
            verdict.is_ok(),
            "a landed reattempt resolves the exhaustion"
        );
    }

    #[cfg(windows)]
    #[test]
    fn exhausted_replace_rechecks_preimage_before_final_attempt() {
        let scratch = Scratch::new("exhausted-retry-preimage");
        let target = scratch.root.join("notes.md");
        std::fs::write(&target, b"external edit").unwrap();
        let mut attempted = false;
        let replaced = resolve_replace_exhaustion(
            std::io::Error::from_raw_os_error(5),
            &target,
            &mut || {
                attempted = true;
                Ok(())
            },
            &mut || Ok(false),
        )
        .unwrap();
        assert!(!replaced);
        assert!(
            !attempted,
            "the final attempt must not bypass the preimage check"
        );
    }

    /// The open is not the only boundary a lock
    /// speaks at. A byte-range lock (`LockFileEx`, which `File::lock` takes on
    /// Windows) leaves the target openable and fails the read with
    /// ERROR_LOCK_VIOLATION. Classifying only the open sent that file down the
    /// terminal io path, so the pending job never retried a lock that does
    /// release.
    ///
    #[cfg(windows)]
    #[test]
    fn a_byte_range_lock_on_the_read_keeps_the_retryable_lock_contract() {
        let scratch = Scratch::new("read-byte-range-lock");
        let target = scratch.root.join("locked.md");
        std::fs::write(&target, b"held bytes").expect("write target");
        let holder = std::fs::File::open(&target).expect("open holder");
        holder.lock().expect("take the byte-range lock");

        let verdict = read_current_no_follow(&target);

        // The open succeeded — this is the read failing, which is the whole
        // point. An `Io` here is the bug: it is terminal, so the durably
        // pending write would never be retried against a lock that lifts.
        assert!(
            matches!(verdict, Err(MaterializeError::FileLocked)),
            "a byte-range-locked read must keep the FileLocked contract"
        );
        drop(holder);
    }

    /// A retry loop reads and hashes the target again only when its size or
    /// modification time changed. Same size and time, new bytes: the cached
    /// answer stands (the later judgment of what moved catches that case).
    #[test]
    fn a_retry_rereads_the_target_only_when_its_size_or_time_changed() {
        let scratch = Scratch::new("target-reads");
        let target = scratch.root.join("a.md");
        std::fs::write(&target, b"expected").expect("write");
        let when = std::fs::metadata(&target)
            .expect("meta")
            .modified()
            .expect("mtime");
        let expected = Preimage::Present(hex_sha256(b"expected"));
        let mut reads = TargetReads::default();
        assert!(reads.check(&target, &expected).expect("check") == TargetHolds::Expected);

        std::fs::write(&target, b"EXPECTED").expect("same size");
        std::fs::File::options()
            .write(true)
            .open(&target)
            .and_then(|file| file.set_modified(when))
            .expect("restore mtime");
        assert!(
            reads.check(&target, &expected).expect("check") == TargetHolds::Expected,
            "an unchanged size and time skips the read"
        );

        std::fs::write(&target, b"longer content").expect("new size");
        assert!(reads.check(&target, &expected).expect("check") == TargetHolds::Other);
        std::fs::remove_file(&target).expect("remove");
        assert!(reads.check(&target, &expected).expect("check") == TargetHolds::Nothing);
    }

    /// The no-replace rename claims an empty name and refuses an occupied
    /// one, leaving both files as they were.
    #[test]
    fn no_replace_rename_never_replaces_an_existing_file() {
        let scratch = Scratch::new("no-replace-rename");
        let incoming = scratch.root.join(".dohc-write-incoming.tmp");
        let target = scratch.root.join("target.md");
        std::fs::write(&incoming, b"incoming").expect("incoming");
        std::fs::write(&target, b"someone else's").expect("occupied target");

        let refused = rename_no_replace(&incoming, &target).expect_err("occupied target");
        assert_eq!(refused.kind(), ErrorKind::AlreadyExists);
        assert_eq!(std::fs::read(&target).expect("target"), b"someone else's");
        assert_eq!(std::fs::read(&incoming).expect("incoming"), b"incoming");

        std::fs::remove_file(&target).expect("empty the name");
        rename_no_replace(&incoming, &target).expect("empty target");
        assert_eq!(std::fs::read(&target).expect("target"), b"incoming");
        assert!(!incoming.exists(), "the incoming name is gone");
    }

    #[cfg(windows)]
    #[test]
    fn windows_crash_after_target_claim_preserves_attributes() {
        use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
        let scratch = Scratch::new("attribute-crash");
        let incoming = scratch.root.join("staged.md");
        let target = scratch.root.join("target.md");
        drop(
            std::fs::OpenOptions::new()
                .create_new(true)
                .write(true)
                .attributes(0x2 | 0x20)
                .open(&incoming)
                .expect("hidden archive file"),
        );
        std::fs::write(&incoming, b"outside bytes").expect("write");
        let original_permissions = std::fs::metadata(&incoming).unwrap().permissions();
        let mut permissions = original_permissions.clone();
        permissions.set_readonly(true);
        std::fs::set_permissions(&incoming, permissions).unwrap();
        let attributes = std::fs::metadata(&incoming).unwrap().file_attributes();

        // Stop between claiming the target and removing the staged name.
        // Nothing after this boundary may be needed to restore attributes.
        let placed = place_with_hard_link(&incoming, &target, || {
            assert_eq!(std::fs::metadata(&target)?.file_attributes(), attributes);
            Err(std::io::Error::from(ErrorKind::Interrupted))
        })
        .expect("placement succeeded before the interruption");
        assert_eq!(placed, Placement::Atomic);
        for path in [&incoming, &target] {
            assert_eq!(std::fs::read(path).unwrap(), b"outside bytes");
            assert_eq!(
                std::fs::metadata(path).unwrap().file_attributes(),
                attributes
            );
        }
        assert_eq!(
            rename_no_replace(&incoming, &target).unwrap_err().kind(),
            ErrorKind::AlreadyExists
        );
        std::fs::set_permissions(&target, original_permissions).unwrap();
    }

    /// The inverse: a real sharing violation that survives every attempt
    /// keeps the retryable lock contract.
    #[cfg(windows)]
    #[test]
    fn replace_exhaustion_keeps_the_lock_contract_for_sharing_violations() {
        let scratch = Scratch::new("replace-exhaustion-lock");
        let tmp = scratch.root.join("tmp-file");
        std::fs::write(&tmp, b"pending bytes").expect("write tmp");
        let replacer = AlwaysFailReplacer {
            error: || std::io::Error::from_raw_os_error(32),
            attempts: AtomicUsize::new(0),
        };
        let result = create_from_temp(
            &scratch.root.join("target.md"),
            &tmp,
            &options_with(&replacer),
        );
        assert!(matches!(result, Err(MaterializeError::FileLocked)));
    }

    struct Scratch {
        root: ScratchDir,
    }

    impl Scratch {
        fn new(tag: &str) -> Self {
            let root = ScratchDir::new_named(&format!("materialize-unit-{tag}"))
                .expect("create scratch directory");
            std::fs::create_dir_all(root.join(".dohc").join("engine"))
                .expect("create scratch engine directory");
            Scratch { root }
        }

        fn db(&self) -> PathBuf {
            self.root.join(".dohc").join("engine").join("engine.db")
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
                        workspace_id: "ws".to_owned(),
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
                        workspace_id: "ws".to_owned(),
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

    struct ContendedOnce(AtomicUsize);

    impl AtomicReplacer for ContendedOnce {
        fn displace(&self, target: &Path, displaced: &Path) -> std::io::Result<()> {
            if self.0.fetch_add(1, Ordering::Relaxed) == 0 {
                return Err(std::io::Error::from(ErrorKind::PermissionDenied));
            }
            std::fs::rename(target, displaced)
        }

        fn place(&self, incoming: &Path, target: &Path) -> std::io::Result<Placement> {
            if self.0.fetch_add(1, Ordering::Relaxed) == 0 {
                return Err(std::io::Error::from(ErrorKind::PermissionDenied));
            }
            rename_no_replace(incoming, target)
        }

        fn try_replace_secret(
            &self,
            _from: &Path,
            _to: &Path,
            pinned_replace: &mut dyn FnMut() -> std::io::Result<()>,
        ) -> std::io::Result<()> {
            if self.0.fetch_add(1, Ordering::Relaxed) == 0 {
                return Err(std::io::Error::from(ErrorKind::PermissionDenied));
            }
            pinned_replace()
        }
    }

    struct ExternalEditDuringBackoff(PathBuf);

    impl ReplaceBackoff for ExternalEditDuringBackoff {
        fn wait_before_retry(&self, failed_attempt: u32) {
            assert_eq!(failed_attempt, 1);
            std::fs::write(&self.0, b"external edit").expect("external editor saves");
        }
    }

    #[test]
    fn ordinary_replace_retry_preserves_external_edit() {
        let scratch = Scratch::new("ordinary-retry-preimage");
        let mut store = EngineStore::open(&scratch.db(), 1).expect("store");
        enqueue_write_job(&mut store, "retry", "notes.md", b"intended", 1);
        let job = store.load_materialization_job("retry").unwrap().unwrap();
        let target = scratch.root.join("notes.md");
        let outcome = materialize_one(
            &store,
            &scratch.root,
            &job,
            &MaterializeOptions {
                policy: DurabilityPolicy::none(),
                replacer: &ContendedOnce(AtomicUsize::new(0)),
                backoff: &ExternalEditDuringBackoff(target.clone()),
                now_ms: 2,
                faults: &NoFaults,
            },
        )
        .expect("materialize");
        assert_eq!(outcome, JobOutcome::Conflict);
        assert_eq!(std::fs::read(&target).unwrap(), b"external edit");
        assert_eq!(
            std::fs::read(conflict_sibling(&target, "retry")).unwrap(),
            b"intended"
        );
        assert_eq!(
            store
                .load_materialization_job("retry")
                .unwrap()
                .unwrap()
                .status,
            JobStatus::Conflict
        );
    }

    #[test]
    fn secret_replace_retry_preserves_external_edit() {
        let scratch = Scratch::new("secret-retry-preimage");
        let (store, job) = prepare_secret_job(&scratch, "secret-retry", ".env");
        let target = scratch.root.join(".env");
        let outcome = materialize_secret_one(
            &store,
            &scratch.root,
            &job,
            b"SECRET=intended",
            &MaterializeOptions {
                policy: DurabilityPolicy::none(),
                replacer: &ContendedOnce(AtomicUsize::new(0)),
                backoff: &ExternalEditDuringBackoff(target.clone()),
                now_ms: 2,
                faults: &NoFaults,
            },
        )
        .expect("materialize");
        assert_eq!(outcome, JobOutcome::Conflict);
        assert_eq!(std::fs::read(&target).unwrap(), b"external edit");
        assert!(!temp_sibling(&target, &job.job_id).exists());
        assert!(!conflict_sibling(&target, &job.job_id).exists());
        assert_eq!(
            store
                .load_materialization_job(&job.job_id)
                .unwrap()
                .unwrap()
                .status,
            JobStatus::Conflict
        );
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

    /// The component walk is the only fd-based parent resolution on macOS and
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
        let root = scratch.root.path();
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

        // Control: the same walk through the real directory succeeds, so the
        // refusal above is the symlink and not a broken walk.
        let root_fd: OwnedFd = std::fs::File::open(root).expect("open root").into();
        walk_secret_parent_unix(root_fd, Path::new("real/nested"), &root.join("real/nested"))
            .expect("the walk must traverse real directories");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn secret_parent_openat2_refuses_a_symlinked_component_directly() {
        let scratch = Scratch::new("secret-openat2-no-symlinks");
        let root = scratch.root.path();
        let redirected_parent = root.join("real").join("nested");
        std::fs::create_dir_all(&redirected_parent).expect("real tree");
        let outside = Scratch::new("secret-openat2-outside");
        std::os::unix::fs::symlink(Path::new("real"), root.join("link"))
            .expect("create ancestor symlink");

        let relative_parent = Path::new("link/nested");
        let display_parent = root.join(relative_parent);
        let redirected_target = redirected_parent.join(".env");
        let outside_target = outside.root.join(".env");
        let plaintext = b"SECRET=must-not-escape\n";
        let opened = open_secret_parent_unix(root, relative_parent, &display_parent);
        if let Ok(parent_fd) = &opened {
            write_secret_temp_at_unix(parent_fd, OsStr::new(".env"), &redirected_target, plaintext)
                .expect("a mistakenly accepted parent handle permits the secret write");
        }

        assert!(
            !redirected_target.exists(),
            "plaintext must not be written through a symlinked ancestor"
        );
        assert!(
            !outside_target.exists(),
            "plaintext must not be written anywhere outside the pinned root"
        );
        assert!(
            matches!(opened, Err(MaterializeError::SymlinkTarget)),
            "a symlinked ancestor must be refused by the Linux parent opener, got {:?}",
            opened.map(|_| "Ok")
        );
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
            &MaterializeOptions {
                policy: DurabilityPolicy::none(),
                replacer: &StdReplacer,
                backoff: &NoBackoff,
                now_ms: 3,
                faults: &NoFaults,
            },
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
            &MaterializeOptions {
                policy: DurabilityPolicy::none(),
                replacer: &StdReplacer,
                backoff: &NoBackoff,
                now_ms: 2,
                faults: &NoFaults,
            },
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
            &MaterializeOptions {
                policy: DurabilityPolicy::none(),
                replacer: &StdReplacer,
                backoff: &NoBackoff,
                now_ms: 2,
                faults: &NoFaults,
            },
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
            &MaterializeOptions {
                policy: DurabilityPolicy::none(),
                replacer: &StdReplacer,
                backoff: &NoBackoff,
                now_ms: 2,
                faults: &NoFaults,
            },
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
            &MaterializeOptions {
                policy: DurabilityPolicy::none(),
                replacer: &StdReplacer,
                backoff: &NoBackoff,
                now_ms: 2,
                faults: &NoFaults,
            },
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
            &MaterializeOptions {
                policy: DurabilityPolicy::none(),
                replacer: &StdReplacer,
                backoff: &NoBackoff,
                now_ms: 2,
                faults: &NoFaults,
            },
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
            &MaterializeOptions {
                policy: DurabilityPolicy::none(),
                replacer: &StdReplacer,
                backoff: &NoBackoff,
                now_ms: 2,
                faults: &NoFaults,
            },
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
            &MaterializeOptions {
                policy: DurabilityPolicy::none(),
                replacer: &SwapAncestorBeforePinnedRename {
                    visible_parent,
                    parked_parent: parked_parent.clone(),
                    outside_parent: outside_parent.clone(),
                },
                backoff: &NoBackoff,
                now_ms: 2,
                faults: &NoFaults,
            },
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
            &MaterializeOptions {
                policy: DurabilityPolicy::none(),
                replacer: &AssertAncestorLockedBeforeRename {
                    visible_parent: visible_parent.clone(),
                    parked_parent,
                },
                backoff: &NoBackoff,
                now_ms: 2,
                faults: &NoFaults,
            },
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
            &MaterializeOptions {
                policy: DurabilityPolicy::none(),
                replacer: &AssertGrandparentLockedBeforeRename {
                    grandparent: grandparent.clone(),
                    parked_grandparent: parked_grandparent.clone(),
                },
                backoff: &NoBackoff,
                now_ms: 2,
                faults: &NoFaults,
            },
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
                        workspace_id: "ws".to_owned(),
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
            &MaterializeOptions {
                policy: DurabilityPolicy::none(),
                replacer: &StdReplacer,
                backoff: &NoBackoff,
                now_ms: 2,
                faults: &ConflictFault {
                    target: target.clone(),
                },
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
