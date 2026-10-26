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
//! 2. Write a **sibling temp file**, bounded bytes. A secret's temp is
//!    owner-only. On POSIX an ordinary temp takes the group and permission
//!    bits of the file it replaces, and on macOS its ACL and the extended
//!    attributes a save keeps. When the full mode could give someone else
//!    more access, because the group or the ACL did not carry over, the temp
//!    takes only the owner's bits. A temp for a new file follows the umask.
//! 3. **Flush** per the per-OS [`DurabilityPolicy`], through
//!    [`EngineStore::flush_before_commits`], so the file persists before the
//!    job's status.
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
//! - A known POSIX file gets an ordinary retained row before the job ends.
//!   Recovery rebuilds lost rows from staged names. Windows deletes it while
//!   inspection denies write sharing. Any
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
//! a delete. POSIX originals stay reachable through retained rows. A worker
//! imports changed reads durably and restarts a 30-second quiet period. Linux
//! probes a read lease before release. Where a lease can be taken and the file
//! has one name, a writable descriptor keeps the original. Unsupported leases
//! (including another owner) use the quiet period. Multiple names allow the
//! staged name to be released because another name still reaches the inode.
//! On macOS, a descriptor write more than 30 seconds after the last observed
//! change can land in an inode whose staged name has been released.
//!
//! An original above MAX_MATERIALIZE_BYTES becomes an unreadable kept copy;
//! its complete source stays reachable instead of importing a truncated read.
//!
//! Cross-volume targets stage beside the target under `.dohc-write-`, with a
//! FULL location row before the rename. If sibling staging cannot be created,
//! the checked replacement fallback remains and records `no-atomic-placement`.
//! POSIX drives without exclusive rename or hard links have the same limit:
//! a concurrent name replacement after the check can be lost. Windows uses
//! MoveFileExW without replacement when hard links are unavailable.
//! Secret paths retain their single bound replacement and are excluded.
//!
//! These guarantees cover process crashes. Power-loss protection follows the
//! flush policy: every flush persists its file before the commits after it.
//! On Apple silicon a file on the database's device takes a barrier, and the
//! actor drains the drive once before it replies. B1 must expose durable
//! displacement reads as document observations before the product promises to
//! keep every outside version read.
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
use crate::floor::{is_excluded_file, path_collision_key};
use crate::media::{is_text_media_type, media_type_for_path};
use crate::policy::{
    MAX_CANONICAL_WORKSPACE_PATH_BYTES, PathClassification, classify_engine_file_path,
    classify_engine_file_path_normalized,
};
use dohc_engine_storage::{
    Displacement, DisplacementResolution, DisplacementSpec, DisplacementState, EngineStore,
    FaultInjector, FaultPoint, JobStatus, MaterializationJob, MaterializationOperation, Preimage,
    StorageError, hex_sha256,
};
use std::ffi::OsStr;
use std::io::{ErrorKind, Read};
use std::path::{Path, PathBuf};
use std::time::Duration;

#[cfg(windows)]
mod readonly_link;

/// Maximum bytes the pipeline will materialize or read back for comparison. A
/// job's content came from a bounded blob; the on-disk comparison read is
/// bounded the same way so a giant external file cannot blow memory.
pub const MAX_MATERIALIZE_BYTES: usize = dohc_engine_storage::MAX_MATERIALIZE_BYTES;

/// The normative maximum atomic-replace attempts before failing closed
/// (`TEST_ORACLE.md` §3.10). Re-exported from storage so both halves share one
/// constant.
pub const MAX_REPLACE_ATTEMPTS: u32 = dohc_engine_storage::MAX_REPLACE_ATTEMPTS;

/// A per-OS flush policy: which files a job flushes. The store decides how
/// ([`EngineStore::flush_before_commits`]). The TS engine never fsyncs; the
/// Rust pipeline adds an explicit, documented policy (approved delta).
/// Directory fsync is a POSIX affordance; on Windows `std` exposes no portable
/// directory sync, so `fsync_parent_dir` is a documented no-op there (an
/// honestly-scoped durability limit).
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
/// Read-only links use the standard library's ignore-readonly deletion. If a
/// drive refuses it, cleanup journals attributes before temporarily clearing them.
/// Filesystems without hard links use an exclusive MoveFileExW rename.
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
    readonly_link::recover_one(incoming, target)?;
    place_with_hard_link(
        incoming,
        target,
        || std::fs::hard_link(incoming, target),
        || remove_placement_link(incoming, target),
    )
}

#[cfg(windows)]
fn place_with_hard_link(
    incoming: &Path,
    target: &Path,
    link: impl FnOnce() -> std::io::Result<()>,
    remove_incoming: impl FnOnce() -> std::io::Result<()>,
) -> std::io::Result<Placement> {
    match link() {
        Ok(()) => {}
        Err(err) if hard_links_unsupported(&err) => {
            return move_file_no_replace(incoming, target).map(|()| Placement::Atomic);
        }
        Err(err)
            if err.kind() == ErrorKind::AlreadyExists && placement_is_linked(incoming, target)? => {
        }
        Err(err) => return Err(err),
    }
    // A retry can find the target already claimed. It must finish the unlink
    // before recovery may discard the row that owns the staging name.
    remove_incoming()?;
    Ok(Placement::Atomic)
}

#[cfg(windows)]
fn placement_is_linked(incoming: &Path, target: &Path) -> std::io::Result<bool> {
    for path in [incoming, target] {
        let metadata = match std::fs::symlink_metadata(path) {
            Ok(metadata) => metadata,
            Err(err) if err.kind() == ErrorKind::NotFound => return Ok(false),
            Err(err) => return Err(err),
        };
        if !metadata.is_file() || metadata_is_reparse_point(&metadata) {
            return Ok(false);
        }
    }
    same_file::is_same_file(incoming, target)
}

#[cfg(windows)]
fn remove_placement_link(incoming: &Path, target: &Path) -> std::io::Result<()> {
    // Rust 1.96.1's unlink opens this name with DELETE access, then calls
    // SetFileInformationByHandle(FileDispositionInfoEx) with DELETE,
    // POSIX_SEMANTICS and IGNORE_READONLY_ATTRIBUTE on access denied.
    // It preserves the original access-denied error if that API is unsupported.
    match std::fs::remove_file(incoming) {
        Ok(()) => return Ok(()),
        Err(err) if err.kind() == ErrorKind::PermissionDenied => {
            if !std::fs::symlink_metadata(incoming)?
                .permissions()
                .readonly()
            {
                return Err(err);
            }
        }
        Err(err) => return Err(err),
    }
    readonly_link::remove(incoming, target, || std::fs::remove_file(incoming))
}

#[cfg(windows)]
fn hard_links_unsupported(err: &std::io::Error) -> bool {
    err.kind() == ErrorKind::Unsupported || matches!(err.raw_os_error(), Some(1 | 50))
}

#[cfg(not(windows))]
fn check_then_rename(incoming: &Path, target: &Path) -> std::io::Result<Placement> {
    match std::fs::symlink_metadata(target) {
        Ok(_) => Err(std::io::Error::from(ErrorKind::AlreadyExists)),
        Err(err) if err.kind() == ErrorKind::NotFound => {
            std::fs::rename(incoming, target).map_err(CheckThenRenameFailed::wrap)?;
            Ok(Placement::CheckThenRename)
        }
        Err(err) => Err(err),
    }
}

#[cfg(not(windows))]
fn rename_no_replace(incoming: &Path, target: &Path) -> std::io::Result<Placement> {
    match rename_no_replace_atomic(incoming, target) {
        Ok(()) => Ok(Placement::Atomic),
        Err(err) if err.kind() == ErrorKind::Unsupported => check_then_rename(incoming, target),
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

/// Rename a visible file to an empty name in one kernel operation that
/// refuses to replace, so bytes another program writes at either name are
/// never lost: a writer that opens the source name after the rename makes a
/// new file, and a file that appears at the target first stays.
///
/// Answers [`ErrorKind::Unsupported`] wherever no such rename exists, and the
/// caller stages the file and places a private copy instead. Some SMB and
/// FUSE mounts refuse the exclusive rename flag. Windows uses the safe
/// MoveFileExW wrapper without replacement or cross-volume copying. This never
/// claims the target through a hard link from the visible source, as
/// [`AtomicReplacer::place`] may for a private staged name: a program writing
/// into the source between link and unlink would write into the destination.
pub fn move_file_no_replace(from: &Path, to: &Path) -> std::io::Result<()> {
    #[cfg(any(target_os = "linux", target_os = "android", target_vendor = "apple"))]
    {
        use rustix::fs::{CWD, RenameFlags, renameat_with};
        exclusive_move_result(renameat_with(CWD, from, CWD, to, RenameFlags::NOREPLACE))
    }
    #[cfg(windows)]
    {
        dohc_windows_files::move_file_no_replace(from, to)
    }
    #[cfg(not(any(
        windows,
        target_os = "linux",
        target_os = "android",
        target_vendor = "apple"
    )))]
    {
        let _ = (from, to);
        Err(std::io::Error::new(
            ErrorKind::Unsupported,
            "this platform has no rename that refuses to replace",
        ))
    }
}

#[cfg(any(target_os = "linux", target_os = "android", target_vendor = "apple"))]
fn exclusive_move_result(result: Result<(), rustix::io::Errno>) -> std::io::Result<()> {
    use rustix::io::Errno;
    match result {
        Ok(()) => Ok(()),
        Err(err)
            if err == Errno::INVAL
                || err == Errno::NOSYS
                || err == Errno::NOTSUP
                || err == Errno::OPNOTSUPP =>
        {
            Err(std::io::Error::new(
                ErrorKind::Unsupported,
                "this filesystem has no rename that refuses to replace",
            ))
        }
        Err(err) => Err(err.into()),
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
    /// A capture hold protects this target. The intent stays pending without
    /// placement or conflict compensation until the hold is resolved.
    Parked,
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

/// Metadata-only proof for rechecking a hashed projection under a write lock.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProjectionTargetStamp {
    Absent,
    File {
        byte_length: u64,
        modified: std::time::SystemTime,
    },
    Unavailable,
}

/// A projection probe bound to one canonical workspace root.
pub struct ProjectionProbe {
    root: PathBuf,
}

impl ProjectionProbe {
    pub fn new(root: &Path) -> std::io::Result<Self> {
        Ok(Self {
            root: std::fs::canonicalize(root)?,
        })
    }
    pub fn stamp(&self, rel: &str) -> ProjectionTargetStamp {
        projection_target_stamp_in(&self.root, rel)
    }
    pub fn probe(&self, rel: &str, kind: ProjectionTargetKind) -> ProjectionTargetState {
        probe_projection_target_in(&self.root, rel, kind)
    }
    pub fn stored_under_other_spelling(&self, rel: &str) -> bool {
        crate::reconcile::stored_spelling_in(&self.root, rel).is_some()
    }
}

pub fn projection_target_stamp(root: &Path, rel: &str) -> ProjectionTargetStamp {
    let Ok(root) = std::fs::canonicalize(root) else {
        return ProjectionTargetStamp::Unavailable;
    };
    projection_target_stamp_in(&root, rel)
}

fn projection_target_stamp_in(root: &Path, rel: &str) -> ProjectionTargetStamp {
    let Ok(target) = resolve_target(root, rel) else {
        return ProjectionTargetStamp::Unavailable;
    };
    if !matches!(projection_has_file_ancestor(root, &target), Ok(false))
        || !existing_ancestor_is_contained(root, &target)
    {
        return ProjectionTargetStamp::Unavailable;
    }
    match std::fs::symlink_metadata(target) {
        Err(e) if e.kind() == ErrorKind::NotFound => ProjectionTargetStamp::Absent,
        Ok(m) if m.file_type().is_file() && !m.file_type().is_symlink() => match m.modified() {
            Ok(modified) => ProjectionTargetStamp::File {
                byte_length: m.len(),
                modified,
            },
            Err(_) => ProjectionTargetStamp::Unavailable,
        },
        _ => ProjectionTargetStamp::Unavailable,
    }
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
    probe_projection_target_in(&canonical_root, rel, kind)
}

fn probe_projection_target_in(
    canonical_root: &Path,
    rel: &str,
    kind: ProjectionTargetKind,
) -> ProjectionTargetState {
    let target = match resolve_target(canonical_root, rel) {
        Ok(target) => target,
        Err(_) => return ProjectionTargetState::UntrackedContent,
    };
    match projection_has_file_ancestor(canonical_root, &target) {
        Ok(true) => return ProjectionTargetState::Absent,
        Ok(false) => {}
        Err(_) => return ProjectionTargetState::UntrackedContent,
    }
    let metadata = match std::fs::symlink_metadata(&target) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => {
            return if existing_ancestor_is_contained(canonical_root, &target) {
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
    if !existing_ancestor_is_contained(canonical_root, &target) {
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

/// A no-follow observation for publication recovery.
pub enum PublicationTarget {
    Absent,
    Bytes(Vec<u8>),
    /// A non-file target or a file larger than the bounded reader can retain.
    Untracked,
}

/// Read a publication target without following links or changing disk.
pub fn read_publication_target(
    root: &Path,
    rel: &str,
) -> Result<PublicationTarget, MaterializeError> {
    let root = std::fs::canonicalize(root).map_err(|error| MaterializeError::io(root, &error))?;
    let target = resolve_target(&root, rel)?;
    ensure_target_symlink_free(&root, &target)?;
    match read_current_no_follow(&target)? {
        CurrentTarget::Present(bytes) => Ok(PublicationTarget::Bytes(bytes)),
        CurrentTarget::Absent => Ok(PublicationTarget::Absent),
        CurrentTarget::Oversized => Ok(PublicationTarget::Untracked),
    }
}

/// Hash a write precondition without applying capture's text or binary caps.
pub fn write_precondition_sha256(
    root: &Path,
    rel: &str,
) -> Result<Option<String>, MaterializeError> {
    let root = std::fs::canonicalize(root).map_err(|error| MaterializeError::io(root, &error))?;
    let target = resolve_target(&root, rel)?;
    ensure_target_symlink_free(&root, &target)?;
    Ok(match read_current_no_follow(&target)? {
        CurrentTarget::Present(bytes) => Some(hex_sha256(&bytes)),
        CurrentTarget::Absent | CurrentTarget::Oversized => None,
    })
}

fn existing_ancestor_is_contained(root: &Path, target: &Path) -> bool {
    let mut candidate = Some(target);
    while let Some(path) = candidate {
        match std::fs::canonicalize(path) {
            Ok(canonical) => return canonical.starts_with(root),
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
    Io {
        path: String,
        kind: ErrorKind,
        /// The OS error number, which tells EPERM from EACCES where `kind`
        /// cannot.
        raw_os_error: Option<i32>,
        /// See [`crate::privacy_denied`].
        privacy_denied: bool,
    },
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
    /// The volume gave a new temp ACL entries, so neither a secret nor a
    /// file's own access could be kept. The write is refused like an io
    /// failure.
    #[error(
        "this volume adds sharing permissions to new files, so dohc can't keep this file private"
    )]
    VolumeSharesNewFiles,
}

impl MaterializeError {
    pub(super) fn io(path: &Path, err: &std::io::Error) -> Self {
        MaterializeError::Io {
            path: path.to_string_lossy().into_owned(),
            kind: err.kind(),
            raw_os_error: err.raw_os_error(),
            privacy_denied: crate::privacy_denied(err, path),
        }
    }

    /// The stable machine code (kebab-case).
    pub fn code(&self) -> &'static str {
        match self {
            MaterializeError::Storage(e) => e.code(),
            MaterializeError::Io {
                privacy_denied: true,
                ..
            } => crate::PRIVACY_DENIED,
            MaterializeError::Io { .. } => "materialize-io",
            MaterializeError::MissingBlob { .. } => "missing-blob",
            MaterializeError::UnsafeTargetPath => "unsafe-target-path",
            MaterializeError::SymlinkTarget => "symlink-target",
            MaterializeError::BlockedTarget => "blocked-target",
            MaterializeError::FileLocked => "file-locked",
            MaterializeError::RecoveryUnavailable => "recovery-unavailable",
            MaterializeError::TooLarge { .. } => "materialize-too-large",
            MaterializeError::VolumeSharesNewFiles => "volume-shares-new-files",
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
    /// A snapshot valid for this serialized writer operation. Other callers
    /// check the durable hold at each placement boundary.
    pub holds: Option<&'a PlacementHolds>,
}

/// A held file's source head, never the refused outside observation.
pub struct PlacementHold {
    pub source_version_id: String,
    pub preimage: Preimage,
}

/// One indexed workspace read, reused throughout a serialized placement batch.
pub struct PlacementHolds {
    workspace_id: String,
    paths: std::collections::HashMap<String, PlacementHold>,
    case_aliases: std::collections::HashMap<String, String>,
}

impl PlacementHolds {
    pub fn load(store: &EngineStore, workspace_id: &str) -> Result<Self, MaterializeError> {
        let paths = store.read_with(|conn| {
            let mut statement = conn
                .prepare_cached(
                    "SELECT h.path,h.source_version_id,CASE COALESCE(s.content_kind,'text') \
                 WHEN 'binary' THEN s.binary_sha256 ELSE s.blob_sha256 END \
                 FROM capture_file_holds h LEFT JOIN snapshots s \
                 ON s.workspace_id=h.workspace_id AND s.version_id=h.source_version_id \
                 AND s.object_id=h.object_id WHERE h.workspace_id=?1 ORDER BY h.path",
                )
                .map_err(StorageError::corrupt_public)?;
            statement
                .query_map([workspace_id], |row| {
                    let recorded: Option<String> = row.get(2)?;
                    Ok((
                        row.get::<_, String>(0)?,
                        PlacementHold {
                            source_version_id: row.get(1)?,
                            preimage: recorded.map_or(Preimage::Absent, Preimage::Present),
                        },
                    ))
                })
                .map_err(StorageError::corrupt_public)?
                .collect::<Result<std::collections::HashMap<_, _>, _>>()
                .map_err(StorageError::corrupt_public)
        })?;
        Ok(Self::from_paths(workspace_id, paths))
    }

    pub fn from_holds(
        workspace_id: &str,
        holds: &[dohc_engine_storage::capture_file_holds::CaptureFileHold],
    ) -> Self {
        Self::from_paths(
            workspace_id,
            holds
                .iter()
                .map(|hold| {
                    (
                        hold.path.clone(),
                        PlacementHold {
                            source_version_id: hold.source_version_id.clone(),
                            preimage: Preimage::Absent,
                        },
                    )
                })
                .collect(),
        )
    }

    fn from_paths(
        workspace_id: &str,
        paths: std::collections::HashMap<String, PlacementHold>,
    ) -> Self {
        let case_aliases = paths
            .keys()
            .map(|path| (path_collision_key(path), path.clone()))
            .collect();
        Self {
            workspace_id: workspace_id.to_owned(),
            paths,
            case_aliases,
        }
    }

    pub fn is_empty(&self) -> bool {
        self.paths.is_empty()
    }
    pub fn entries(&self) -> impl Iterator<Item = (&str, &PlacementHold)> {
        self.paths.iter().map(|(path, hold)| (path.as_str(), hold))
    }

    /// Lexical checks never resolve or read the outside file. Case and
    /// normalization aliases deliberately over-park distinct paths on
    /// case-sensitive volumes.
    pub fn get(&self, path: &str) -> Option<(&str, &PlacementHold)> {
        if let Some((path, hold)) = self.paths.get_key_value(path) {
            return Some((path, hold));
        }
        if self.is_empty() {
            return None;
        }
        let stored = self.case_aliases.get(&path_collision_key(path))?;
        self.paths
            .get_key_value(stored)
            .map(|(path, hold)| (path.as_str(), hold))
    }

    pub fn ancestor(&self, mut path: &str) -> Option<(&str, &PlacementHold)> {
        if self.is_empty() {
            return None;
        }
        while let Some((parent, _)) = path.rsplit_once('/') {
            if let Some(held) = self.get(parent) {
                return Some(held);
            }
            path = parent;
        }
        None
    }

    pub fn blocks(&self, path: &str) -> bool {
        self.get(path).or_else(|| self.ancestor(path)).is_some()
    }

    #[cfg(windows)]
    fn resolved(&self, root: &Path, target: &Path) -> Result<bool, MaterializeError> {
        let path = target
            .strip_prefix(root)
            .map_err(|_| MaterializeError::UnsafeTargetPath)?
            .to_string_lossy()
            .replace('\\', "/");
        Ok(self.blocks(&path))
    }
}

fn require_materialization_owner(store: &EngineStore) -> Result<(), MaterializeError> {
    if store.is_passive() {
        return Err(StorageError::InvalidInput {
            reason: "passive store cannot materialize",
        }
        .into());
    }
    Ok(())
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
    if store.is_passive() {
        return Ok(Vec::new());
    }
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

/// Execute an ordinary job, retaining the error that explains a blocked path.
/// Callers that manage a staged publication need that reason before deciding
/// whether to retain or discard it.
pub fn materialize_one_ordinary(
    store: &EngineStore,
    root: &Path,
    job: &MaterializationJob,
    options: &MaterializeOptions<'_>,
) -> Result<JobOutcome, MaterializeError> {
    materialize_one_ordinary_with(store, root, job, options, false)
}

fn materialize_one_ordinary_with(
    store: &EngineStore,
    root: &Path,
    job: &MaterializationJob,
    options: &MaterializeOptions<'_>,
    conflict_only: bool,
) -> Result<JobOutcome, MaterializeError> {
    require_materialization_owner(store)?;
    let result = materialize_one_inner(store, root, job, options, conflict_only);
    if matches!(&result, Ok(outcome) if !matches!(outcome, JobOutcome::Crashed(_)))
        || matches!(
            &result,
            Err(MaterializeError::SymlinkTarget | MaterializeError::RecoveryUnavailable)
        )
    {
        let cleanup = (|| {
            if let Some(relative) = store.staging_location(&job.job_id)? {
                cleanup_staging_directory(store, root, &root.join(relative))?;
            }
            Ok::<_, MaterializeError>(())
        })();
        if let Err(error) = cleanup {
            eprintln!("materialization staging cleanup: {error}");
        }
    }
    result
}

fn materialize_one_inner(
    store: &EngineStore,
    root: &Path,
    job: &MaterializationJob,
    options: &MaterializeOptions<'_>,
    conflict_only: bool,
) -> Result<JobOutcome, MaterializeError> {
    let MaterializeOptions { now_ms, faults, .. } = *options;
    // Canonicalizing the root deliberately accepts aliases above (or at) the
    // workspace boundary. The component walk below owns only descendants.
    // A job an older build queued for OS metadata the floor now excludes (an
    // old `.DS_Store`) has nothing to place. It ends as cancelled and reports no
    // further work, so no replay counts it as failed.
    if crate::floor::names_os_metadata(&job.target_path) {
        store.mark_materialization_cancelled(&job.job_id, now_ms)?;
        return Ok(JobOutcome::AlreadyMaterialized);
    }
    let canonical_root =
        std::fs::canonicalize(root).map_err(|err| MaterializeError::io(root, &err))?;
    let target = resolve_target(&canonical_root, &job.target_path)?;

    if placement_is_held(
        store,
        &canonical_root,
        &job.workspace_id,
        &job.target_path,
        Some(&target),
        options.holds,
    )? {
        return Ok(JobOutcome::Parked);
    }

    // `materialize.after-job-commit`: the job row is durable but nothing is on
    // disk yet. A crash here leaves the job pending for startup replay.
    if should_crash(faults, FaultPoint::MaterializeAfterJobCommit) {
        return Ok(JobOutcome::Crashed(FaultPoint::MaterializeAfterJobCommit));
    }

    // An earlier run of this job may have stopped mid-replace. Resolve that
    // first, so every check below sees the target as it was or as it ended.
    // Bytes the store lacks that cannot return to their path make the job
    // conflict, so the person is told.
    let (staging, kept) = recover_job_displacements(store, &canonical_root, &target, job, options)?;
    if kept {
        store.mark_materialization_conflict(&job.job_id, now_ms)?;
        return Ok(JobOutcome::Conflict);
    }

    // Generation staleness gate: if a newer generation has already been
    // materialized at this path, this job is superseded — never regress the path
    // to older content (concurrent / out-of-order jobs). No-op; mark complete.
    // A keyed write's request records the supersession first, so a complete
    // job with no recorded outcome always reached disk.
    if !conflict_only
        && !job.job_id.starts_with("version-switch-")
        && let Some(done_gen) =
            store.max_completed_generation_for_path(&job.workspace_id, &job.target_path)?
        && done_gen > job.target_generation
    {
        if job.job_id.starts_with("ydoc-mat_") {
            store.mark_materialization_cancelled(&job.job_id, now_ms)?;
        } else {
            store.record_superseded_publication(job)?;
            store.mark_materialization_complete(&job.job_id, now_ms)?;
        }
        return Ok(JobOutcome::Superseded);
    }

    if job.operation == MaterializationOperation::Delete {
        return materialize_delete(store, &canonical_root, &staging, &target, job, options);
    }

    // Load the content blob (integrity-verified on read).
    let content = store
        .get_materialization_blob(&job.content_sha256)?
        .ok_or_else(|| MaterializeError::MissingBlob {
            job_id: job.job_id.clone(),
            sha256: job.content_sha256.clone(),
        })?;
    if content.len() > MAX_MATERIALIZE_BYTES {
        return Err(MaterializeError::TooLarge {
            actual: content.len(),
        });
    }
    materialize_ordinary_write(
        store,
        &canonical_root,
        if conflict_only {
            OrdinaryWritePlacement::ConflictSibling
        } else {
            OrdinaryWritePlacement::Target(&staging)
        },
        &target,
        job,
        &content,
        options,
    )
}

/// Preserve a stale write as the ordinary conflict sibling, without placing
/// its content at the target. The capture drain uses this after an outside
/// repair has already become the head.
pub fn materialize_write_conflict(
    store: &EngineStore,
    root: &Path,
    job: &MaterializationJob,
    options: &MaterializeOptions<'_>,
) -> Result<JobOutcome, MaterializeError> {
    match materialize_one_ordinary_with(store, root, job, options, true) {
        Err(MaterializeError::SymlinkTarget | MaterializeError::RecoveryUnavailable) => {
            Ok(JobOutcome::Blocked)
        }
        outcome => outcome,
    }
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
    require_materialization_owner(store)?;
    let MaterializeOptions { now_ms, faults, .. } = *options;
    let canonical_root =
        std::fs::canonicalize(root).map_err(|err| MaterializeError::io(root, &err))?;
    let target = resolve_target(&canonical_root, &job.target_path)?;
    if placement_is_held(
        store,
        &canonical_root,
        &job.workspace_id,
        &job.target_path,
        Some(&target),
        options.holds,
    )? {
        return Ok(JobOutcome::Parked);
    }
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
        && !target_has_other_leaf_spelling(&target)
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
    require_materialization_owner(store)?;
    let MaterializeOptions { faults, .. } = *options;
    let canonical_root =
        std::fs::canonicalize(root).map_err(|err| MaterializeError::io(root, &err))?;
    let target = resolve_target(&canonical_root, &job.target_path)?;
    if placement_is_held(
        store,
        &canonical_root,
        &job.workspace_id,
        &job.target_path,
        Some(&target),
        options.holds,
    )? {
        return Ok(JobOutcome::Parked);
    }
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
    parent.sync(store, policy)?;
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
        ..
    } = *options;
    ensure_target_symlink_free(root, target)?;
    // Step 1 (idempotent replay): the target already equals the desired content.
    let current = read_current_no_follow(target)?;
    if matches!(current, CurrentTarget::Oversized) {
        return Err(MaterializeError::BlockedTarget);
    }
    if let CurrentTarget::Present(bytes) = &current
        && hex_sha256(bytes) == job.content_sha256
        && !target_has_other_leaf_spelling(target)
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
    flush_temp_file(store, &temp_file, &tmp, policy)?;
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
    parent.sync(store, policy)?;
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

enum OrdinaryWritePlacement<'a> {
    Target(&'a Staging),
    ConflictSibling,
}

/// Write an ordinary job's content without overwriting bytes the preimage
/// check did not see (module docs, "Stage, then place").
fn materialize_ordinary_write(
    store: &EngineStore,
    root: &Path,
    placement: OrdinaryWritePlacement<'_>,
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
    let mut respelled = None;
    if matches!(placement, OrdinaryWritePlacement::Target(_))
        && let TargetHash::Sha(sha) = reads.read(target)?
    {
        if matches!(job.preimage, Preimage::Absent) {
            respelled = pending_respelled_delete(store, root, target, job, &sha)?;
        }
        if sha == job.content_sha256
            && respelled.is_none()
            && !target_has_other_leaf_spelling(target)
        {
            store.mark_materialization_complete(&job.job_id, now_ms)?;
            return Ok(JobOutcome::AlreadyMaterialized);
        }
    }

    // Step 2: sibling temp file, bounded, with the target's permissions. A
    // secret path routed here still gets an owner-only temp.
    let tmp = temp_sibling(target, &job.job_id);
    let owner_only = crate::policy::normalized_path_is_secret(&job.target_path);
    let temp_file = write_temp(target, &tmp, content, owner_only)?;
    if should_crash(faults, FaultPoint::MaterializeAfterTempWrite) {
        // A crash here leaves an orphan temp; startup replay ignores it (temp is
        // never captured as user content: it lives under a `.dohc-write-` name
        // the path floor excludes) and re-runs the job.
        return Ok(JobOutcome::Crashed(FaultPoint::MaterializeAfterTempWrite));
    }

    // Step 3: flush the temp FILE per the per-OS durability policy. The parent
    // directory is synced after the renames, which is where their durability
    // lives on POSIX.
    flush_temp_file(store, &temp_file, &tmp, policy)?;
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
    let outcome = match placement {
        OrdinaryWritePlacement::Target(staging) => swap_in_temp(
            store,
            staging,
            target,
            &tmp,
            job,
            respelled.as_ref(),
            &mut reads,
            options,
        ),
        OrdinaryWritePlacement::ConflictSibling => {
            record_write_conflict(store, target, &tmp, job, now_ms)
        }
    };
    if outcome.is_err() {
        let _ = std::fs::remove_file(&tmp); // best-effort cleanup
    }
    outcome
}

#[allow(
    clippy::too_many_arguments,
    reason = "the respelled delete is found with the first read of the target"
)]
fn swap_in_temp(
    store: &EngineStore,
    staging: &Staging,
    target: &Path,
    tmp: &Path,
    job: &MaterializationJob,
    respelled: Option<&MaterializationJob>,
    reads: &mut TargetReads,
    options: &MaterializeOptions<'_>,
) -> Result<JobOutcome, MaterializeError> {
    let root = staging.root.as_path();
    let MaterializeOptions {
        policy,
        now_ms,
        faults,
        ..
    } = *options;
    let expected = match &job.preimage {
        Preimage::Absent => {
            if !create_from_temp(target, tmp, options)? {
                // The old spelling's delete keeps its own preimage check, so
                // a file changed since the merge stays and this write conflicts.
                let Some(delete) = respelled else {
                    return record_write_conflict(store, target, tmp, job, now_ms);
                };
                match materialize_one(store, root, delete, options)? {
                    JobOutcome::Completed | JobOutcome::AlreadyMaterialized
                        if create_from_temp(target, tmp, options)? => {}
                    outcome @ (JobOutcome::Parked | JobOutcome::Blocked) => {
                        // Both jobs stay pending, and replay runs the delete first.
                        let _ = std::fs::remove_file(tmp);
                        return Ok(outcome);
                    }
                    outcome @ JobOutcome::Crashed(_) => return Ok(outcome),
                    _ => return record_write_conflict(store, target, tmp, job, now_ms),
                }
            }
            sync_parent_dir(store, target.parent(), policy)?;
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
    let mut active = Staging {
        root: staging.root.clone(),
        dir: staging.dir.clone(),
        taken: staging.taken.clone(),
    };
    let spec = match stage_target_same_volume(
        store,
        &mut active,
        target,
        job,
        expected,
        reads,
        options,
    )? {
        Stage::Moved(spec) => spec,
        Stage::CrossVolume => {
            return materialize_cross_volume(store, target, Some(tmp), job, options);
        }
        Stage::Conflict | Stage::Vanished => {
            return record_write_conflict(store, target, tmp, job, now_ms);
        }
    };
    let staging = &active;
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
            known @ (Inspected::Known { .. } | Inspected::Missing) => {
                dispose_known(store, root, &staged, &spec, &known, now_ms)?;
            }
            other => {
                sync_staged(store, &staging.dir, policy)?;
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
        // POSIX recovery must not treat this known original as rowless.
        dispose_known(store, root, &staged, &spec, &inspected, now_ms)?;
        if should_crash(faults, FaultPoint::MaterializeAfterKnownCopyDeletion) {
            return Ok(JobOutcome::Crashed(
                FaultPoint::MaterializeAfterKnownCopyDeletion,
            ));
        }
        sync_parent_dir(store, target.parent(), policy)?;
        store.mark_materialization_complete(&job.job_id, now_ms)?;
        return Ok(JobOutcome::Completed);
    }
    // Another program wrote the file after the check. Its bytes go back to
    // their path, where capture records them like any outside edit; the
    // job's content moves to the conflict sibling.
    sync_staged(store, &staging.dir, policy)?;
    sync_parent_dir(store, target.parent(), policy)?;
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
    // disposes it only once it is known to hold the preimage the store has. An
    // empty name is what a delete leaves anyway.
    let mut active = Staging {
        root: staging.root.clone(),
        dir: staging.dir.clone(),
        taken: staging.taken.clone(),
    };
    let spec = match stage_target_same_volume(
        store,
        &mut active,
        target,
        job,
        expected,
        &mut reads,
        options,
    )? {
        Stage::Moved(spec) => spec,
        Stage::CrossVolume if job.job_id.starts_with("restore-delete-mat_") => {
            return Err(MaterializeError::io(
                target,
                &std::io::Error::from(ErrorKind::CrossesDevices),
            ));
        }
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
    let staging = &active;
    let staged = staging.dir.join(&spec.displaced_name);
    if job.job_id.starts_with("restore-delete-mat_") {
        // Keep the preimage until the durable publication receipt exists. A
        // filesystem or receipt failure returns it without replacing new work.
        #[cfg(unix)]
        let mut registered = None;
        let published = (|| {
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
            if matches!(inspected, Inspected::Unreadable) {
                return Err(MaterializeError::io(
                    &staged,
                    &std::io::Error::from(ErrorKind::PermissionDenied),
                ));
            }
            if !matches!(inspected, Inspected::Known { .. } | Inspected::Missing) {
                if !return_displaced(store, target, &staged, options)? {
                    let moved = Moved::open(store, spec.clone(), &staging.dir)?;
                    store.resolve_displacement(
                        moved.displacement_id,
                        keep_resolution(&inspected),
                        None,
                        now_ms,
                    )?;
                }
                store.mark_materialization_conflict(&job.job_id, now_ms)?;
                return Ok(JobOutcome::Conflict);
            }
            sync_parent_dir(store, target.parent(), policy)?;
            #[cfg(unix)]
            {
                registered = if let Inspected::Known {
                    _guard: file,
                    sha256,
                } = &inspected
                {
                    // Register before the receipt, but keep the staged name for rollback.
                    Some(crate::retained::register_known(
                        store, root, &staged, file, sha256, &spec, now_ms,
                    )?)
                } else {
                    None
                };
            }
            #[cfg(unix)]
            if should_crash(faults, FaultPoint::MaterializeAfterKnownCopyDeletion) {
                return Ok(JobOutcome::Crashed(
                    FaultPoint::MaterializeAfterKnownCopyDeletion,
                ));
            }
            store.mark_materialization_complete(&job.job_id, now_ms)?;
            // Cleanup cannot turn an applied publication into a refusal.
            #[cfg(unix)]
            if let Some((id, links)) = registered
                && let Err(error) = crate::retained::release_linked(store, &staged, id, links)
            {
                eprintln!("materialization staged original cleanup: {error}");
            }
            #[cfg(not(unix))]
            if let Err(error) = dispose_known(store, root, &staged, &spec, &inspected, now_ms) {
                eprintln!("materialization staged original retention: {error}");
            }
            #[cfg(not(unix))]
            if should_crash(faults, FaultPoint::MaterializeAfterKnownCopyDeletion) {
                return Ok(JobOutcome::Crashed(
                    FaultPoint::MaterializeAfterKnownCopyDeletion,
                ));
            }
            Ok(JobOutcome::Completed)
        })();
        #[cfg(unix)]
        let retention_release_failed = published.is_err()
            && registered.is_some_and(|(id, _)| {
                if let Err(error) = store.release_retained(id) {
                    eprintln!("materialization rollback retention release: {error}");
                    true
                } else {
                    false
                }
            });
        #[cfg(not(unix))]
        let retention_release_failed = false;
        if published.is_err()
            && match entry_exists(&staged) {
                Ok(exists) => exists,
                Err(error) => {
                    eprintln!("materialization rollback source stat: {error}");
                    return published;
                }
            }
            && !return_displaced(store, target, &staged, options)?
        {
            // A failed return leaves retention as the only owner of this source.
            if retention_release_failed {
                return published;
            }
            let moved = Moved::open(store, spec, &staging.dir)?;
            store.resolve_displacement(
                moved.displacement_id,
                keep_resolution(&Inspected::Missing),
                None,
                now_ms,
            )?;
        }
        return published;
    }
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
        dispose_known(store, root, &staged, &spec, &inspected, now_ms)?;
        if should_crash(faults, FaultPoint::MaterializeAfterKnownCopyDeletion) {
            return Ok(JobOutcome::Crashed(
                FaultPoint::MaterializeAfterKnownCopyDeletion,
            ));
        }
        sync_parent_dir(store, target.parent(), policy)?;
        store.mark_materialization_complete(&job.job_id, now_ms)?;
        return Ok(JobOutcome::Completed);
    }
    // Bytes the store does not have go back to their path, and the delete
    // conflicts, as it would had the recheck seen them.
    sync_staged(store, &staging.dir, policy)?;
    sync_parent_dir(store, target.parent(), policy)?;
    let moved = Moved::open(store, spec, &staging.dir)?;
    if should_crash(faults, FaultPoint::MaterializeAfterDisplacementJournal) {
        return Ok(JobOutcome::Crashed(
            FaultPoint::MaterializeAfterDisplacementJournal,
        ));
    }
    let resolution = if return_displaced(store, target, &moved.path, options)? {
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
    if let Some(dir) = target.parent() {
        if let Ok(mut dirs) = dirs_without_atomic_placement().lock() {
            dirs.insert(dir.to_owned());
        }
    }
    let recorded_preimage = match &job.preimage {
        Preimage::Present(expected) => {
            expected == &hex_sha256(b"") || store.holds_content(expected)?
        }
        Preimage::Absent => true,
    };
    let replaced = retry_while_locked(
        target,
        target,
        options.backoff,
        MAX_REPLACE_ATTEMPTS,
        || {
            if !recorded_preimage
                || !preimage_matches(&job.preimage, &read_current_no_follow(target)?)
            {
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
    sync_parent_dir(store, target.parent(), options.policy)?;
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
    root: PathBuf,
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
fn stage_target_same_volume(
    store: &EngineStore,
    staging: &mut Staging,
    target: &Path,
    job: &MaterializationJob,
    expected: &str,
    reads: &mut TargetReads,
    options: &MaterializeOptions<'_>,
) -> Result<Stage, MaterializeError> {
    let root = staging.root.as_path();
    let first = stage_target(staging, target, job, expected, reads, options)?;
    if !matches!(first, Stage::CrossVolume) {
        return Ok(first);
    }
    let dir = target
        .parent()
        .ok_or(MaterializeError::UnsafeTargetPath)?
        .join(".dohc-write-displaced");
    if walk_target_components(root, &dir, ensure_real_directory).is_err() {
        return Ok(Stage::CrossVolume);
    }
    let rel = dir
        .strip_prefix(root)
        .map_err(|_| MaterializeError::UnsafeTargetPath)?
        .to_string_lossy()
        .replace('\\', "/");
    // FULL commit precedes the rename. A pending job finds this directory after a crash.
    store.remember_staging(&job.job_id, &rel)?;
    staging.dir = dir;
    match stage_target(staging, target, job, expected, reads, options) {
        Err(MaterializeError::Io {
            kind: ErrorKind::Unsupported | ErrorKind::PermissionDenied,
            ..
        }) => Ok(Stage::CrossVolume),
        result => result,
    }
}

fn job_staging_dir(
    store: &EngineStore,
    root: &Path,
    job_id: &str,
    create: bool,
) -> Result<PathBuf, MaterializeError> {
    let Some(rel) = store.staging_location(job_id)? else {
        return checked_staging_dir(store.database_path(), root, create);
    };
    let path = Path::new(&rel);
    if path.is_absolute()
        || path
            .components()
            .any(|c| !matches!(c, std::path::Component::Normal(_)))
        || path.file_name() != Some(OsStr::new(".dohc-write-displaced"))
    {
        return Err(MaterializeError::UnsafeTargetPath);
    }
    let dir = root.join(path);
    if create {
        walk_target_components(root, &dir, ensure_real_directory)?;
    } else {
        ensure_target_symlink_free(root, &dir)?;
    }
    Ok(dir)
}

fn all_staging_dirs(
    store: &EngineStore,
    root: &Path,
) -> Result<(Vec<PathBuf>, bool), MaterializeError> {
    let mut dirs = Vec::new();
    let mut unavailable = false;
    let mut add = |result: Result<PathBuf, MaterializeError>| match result {
        Ok(dir) => dirs.push(dir),
        Err(error) => {
            unavailable = true;
            eprintln!("materialization recovery directory: {error}");
        }
    };
    add(staging_dir(store.database_path(), root, false));
    for rel in store.staging_locations()? {
        add((|| {
            let path = Path::new(&rel);
            if path.is_absolute()
                || path
                    .components()
                    .any(|c| !matches!(c, std::path::Component::Normal(_)))
                || path.file_name() != Some(OsStr::new(".dohc-write-displaced"))
            {
                return Err(MaterializeError::UnsafeTargetPath);
            }
            let dir = root.join(path);
            ensure_target_symlink_free(root, &dir)?;
            Ok(dir)
        })());
    }
    Ok((dirs, unavailable))
}

/// Called on the writer thread, so cleanup cannot race a pending job's rename.
/// Only empty sibling staging directories can be removed; retained and kept
/// sources keep their directory and its location rows reachable.
pub fn cleanup_staging_directory(
    store: &EngineStore,
    root: &Path,
    directory: &Path,
) -> Result<(), MaterializeError> {
    cleanup_staging_directory_with_sync(store, root, directory, |parent| {
        sync_parent_dir(store, Some(parent), DurabilityPolicy::per_os())
    })
}

fn cleanup_staging_directory_with_sync(
    store: &EngineStore,
    root: &Path,
    directory: &Path,
    sync: impl FnOnce(&Path) -> Result<(), MaterializeError>,
) -> Result<(), MaterializeError> {
    if store.is_passive() {
        return Ok(());
    }
    if directory.file_name() != Some(OsStr::new(".dohc-write-displaced")) {
        return Ok(());
    }
    let relative = directory
        .strip_prefix(root)
        .map_err(|_| MaterializeError::UnsafeTargetPath)?;
    if relative
        .components()
        .any(|c| !matches!(c, std::path::Component::Normal(_)))
    {
        return Err(MaterializeError::UnsafeTargetPath);
    }
    let root = std::fs::canonicalize(root).map_err(|e| MaterializeError::io(root, &e))?;
    let directory = root.join(relative);
    ensure_target_symlink_free(&root, &directory)?;
    let relative = relative.to_string_lossy().replace('\\', "/");
    match std::fs::remove_dir(&directory) {
        Ok(()) => {}
        Err(e) if e.kind() == ErrorKind::NotFound => {}
        Err(e) if e.kind() == ErrorKind::DirectoryNotEmpty => return Ok(()),
        Err(e) => return Err(MaterializeError::io(&directory, &e)),
    }
    // Make removal durable before a later FULL commit can persist forgetting it.
    if let Some(parent) = directory.parent() {
        sync(parent)?;
    }
    store.forget_staging_directory(&relative)?;
    Ok(())
}

fn stage_target(
    staging: &Staging,
    target: &Path,
    job: &MaterializationJob,
    expected: &str,
    reads: &mut TargetReads,
    options: &MaterializeOptions<'_>,
) -> Result<Stage, MaterializeError> {
    let write = job.operation == MaterializationOperation::Write;
    let mut original_path = PathBuf::from(&job.target_path);
    if let Some(leaf) = other_leaf_spelling(target)
        .as_deref()
        .or_else(|| target.file_name())
    {
        original_path.set_file_name(leaf);
    }
    let spec = DisplacementSpec {
        job_id: job.job_id.clone(),
        workspace_id: job.workspace_id.clone(),
        target_path: original_path.to_string_lossy().replace('\\', "/"),
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
            #[cfg(windows)]
            if placement_is_linked(tmp, target).map_err(|err| MaterializeError::io(tmp, &err))? {
                return place_attempt(options.replacer, tmp, target);
            }
            return Ok(Attempt::Done(false));
        }
        place_attempt(options.replacer, tmp, target)
    })
}

/// A merge that renames a file only by case or normalization deletes the old
/// path before it creates the new one. On a disk that ignores the difference,
/// a create that finds its name held by the file that delete must still
/// remove runs the delete first. This finds that delete when its path
/// reaches the same file on disk as the target, and the file holds the bytes
/// the delete expects. Either path can be spelled differently from the name
/// the disk stores. A delete through a link never matches: it would refuse
/// to run, and the write would wait for it forever.
fn pending_respelled_delete(
    store: &EngineStore,
    root: &Path,
    target: &Path,
    job: &MaterializationJob,
    current_sha256: &str,
) -> Result<Option<MaterializationJob>, MaterializeError> {
    let deletes = store.pending_merge_deletes_expecting(&job.workspace_id, current_sha256)?;
    if deletes.is_empty() {
        return Ok(None);
    }
    Ok(deletes.into_iter().find(|delete| {
        delete.target_path != job.target_path
            && resolve_target(root, &delete.target_path)
                .ok()
                .filter(|path| ensure_target_symlink_free(root, path).is_ok())
                .is_some_and(|path| crate::reconcile::may_share_entry_in(root, target, &path))
    }))
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
            return_displaced(
                store,
                &target.with_file_name(
                    Path::new(&spec.target_path)
                        .file_name()
                        .ok_or(MaterializeError::UnsafeTargetPath)?
                ),
                &staging.join(&spec.displaced_name),
                options,
            ),
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
    store: &EngineStore,
    target: &Path,
    staged: &Path,
    options: &MaterializeOptions<'_>,
) -> Result<bool, MaterializeError> {
    let returned = retry_while_locked(target, staged, options.backoff, RETURN_ATTEMPTS, || {
        place_attempt(options.replacer, staged, target)
    })?;
    if returned {
        sync_parent_dir(store, target.parent(), options.policy)?;
        sync_parent_dir(store, staged.parent(), options.policy)?;
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
        let back = if return_displaced(store, target, &aside.path, options)? {
            DisplacementResolution::Discard
        } else {
            DisplacementResolution::Keep {
                displaced_sha256: None,
            }
        };
        store.resolve_displacement(aside.displacement_id, back, None, options.now_ms)?;
        return Ok(true);
    }
    let original = target.with_file_name(
        Path::new(&moved.target_path)
            .file_name()
            .ok_or(MaterializeError::UnsafeTargetPath)?,
    );
    let returned = return_displaced(store, &original, &moved.path, options)?;
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
    let mut original_path = PathBuf::from(&moved.target_path);
    if let Some(leaf) = other_leaf_spelling(target)
        .as_deref()
        .or_else(|| target.file_name())
    {
        original_path.set_file_name(leaf);
    }
    let spec = DisplacementSpec {
        job_id: moved.job_id.clone(),
        workspace_id: moved.workspace_id.clone(),
        target_path: original_path.to_string_lossy().replace('\\', "/"),
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
        sync_staged(store, staging, options.policy)?;
        sync_parent_dir(store, target.parent(), options.policy)?;
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
        sha256: String,
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
        Ok(Inspected::Known {
            _guard: file,
            sha256,
        })
    } else {
        Ok(Inspected::Unknown { sha256 })
    }
}

/// Retain the inspected POSIX inode before ending the job or its recovery row.
fn dispose_known(
    store: &EngineStore,
    root: &Path,
    path: &Path,
    spec: &DisplacementSpec,
    inspected: &Inspected,
    now_ms: i64,
) -> Result<(), MaterializeError> {
    if let Inspected::Known {
        _guard: file,
        sha256,
    } = inspected
    {
        #[cfg(unix)]
        crate::retained::retain_known(store, root, path, file, sha256, spec, now_ms)?;
        #[cfg(not(unix))]
        {
            let _ = (store, root, spec, now_ms, file, sha256);
            let _ = std::fs::remove_file(path);
        }
    }
    Ok(())
}

/// Open a displaced file for reading without following a link. On Windows
/// the handle denies write sharing, so the open fails while another handle
/// has the file open for writing.
pub(super) fn open_displaced(path: &Path) -> std::io::Result<std::fs::File> {
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

/// The folder staging is checked from, and the staging folder below it. A
/// store at `database` that opened through the engine folder the engine
/// checked, by the folder's ID on a Mac or by the descriptor the engine holds
/// for it on Linux, sits in that folder. Staging then goes through that
/// folder, and only `displaced` is checked below it. Otherwise the check
/// starts at `root`.
fn staging_base(database: &Path, root: &Path) -> (PathBuf, PathBuf) {
    if let Some(engine) = database.parent().filter(|engine| by_id(engine)) {
        let name = Path::new(STAGING_DIR).file_name().unwrap_or_default();
        return (engine.to_owned(), engine.join(name));
    }
    (root.to_owned(), root.join(STAGING_DIR))
}

/// Whether `path` reaches its folder by its ID on a Mac, or through a
/// descriptor this process holds on Linux, rather than by its name.
fn by_id(path: &Path) -> bool {
    #[cfg(target_vendor = "apple")]
    return dohc_macos_files::is_path_by_id(path);
    #[cfg(target_os = "linux")]
    return dohc_linux_files::held::is_path_by_fd(path);
    #[cfg(not(any(target_vendor = "apple", target_os = "linux")))]
    {
        let _ = path;
        false
    }
}

/// The path that reaches `rel`, a workspace-relative name a row stores, and
/// the folder to check that path from. A name below `.dohc/engine/displaced`
/// goes through the staging folder of [`staging_base`].
pub fn stored_path(database: &Path, root: &Path, rel: &Path) -> (PathBuf, PathBuf) {
    let (base, staging) = staging_base(database, root);
    match rel.strip_prefix(STAGING_DIR) {
        Ok(name) if by_id(&base) => (base, staging.join(name)),
        _ => (root.to_owned(), root.join(rel)),
    }
}

/// The workspace-relative name a row stores for `path`, a staged file. A file
/// in the staging folder of [`staging_base`] is named below
/// `.dohc/engine/displaced`, whichever path reached it.
pub(super) fn stored_name(
    database: &Path,
    root: &Path,
    path: &Path,
) -> Result<String, MaterializeError> {
    let rel = match path.strip_prefix(root) {
        Ok(rel) => rel.to_owned(),
        Err(_) => {
            let (_, staging) = staging_base(database, root);
            let name = path
                .strip_prefix(&staging)
                .map_err(|_| MaterializeError::UnsafeTargetPath)?;
            Path::new(STAGING_DIR).join(name)
        }
    };
    Ok(rel.to_string_lossy().replace('\\', "/"))
}

fn sync_staged(
    store: &EngineStore,
    staging: &Path,
    policy: DurabilityPolicy,
) -> Result<(), MaterializeError> {
    sync_parent_dir(store, Some(staging), policy)?;
    // Include newly created staging ancestors before source removal is synced.
    // A staging folder reached through the checked engine folder was the only
    // one made.
    sync_parent_dir(store, staging.parent(), policy)?;
    let engine = staging.parent().filter(|engine| !by_id(engine));
    sync_parent_dir(store, engine.and_then(Path::parent), policy)
}

/// The staging directory under an already-canonicalized root, or through the
/// engine folder of [`staging_base`]. Every component must be a real
/// directory; `create` makes the missing ones.
fn staging_dir(database: &Path, root: &Path, create: bool) -> Result<PathBuf, MaterializeError> {
    let dir = checked_staging_dir(database, root, create)?;
    #[cfg(windows)]
    readonly_link::recover_all(root, &dir).map_err(|err| MaterializeError::io(&dir, &err))?;
    Ok(dir)
}

fn checked_staging_dir(
    database: &Path,
    root: &Path,
    create: bool,
) -> Result<PathBuf, MaterializeError> {
    let (base, dir) = staging_base(database, root);
    if create {
        walk_target_components(&base, &dir, ensure_real_directory)?;
    } else {
        ensure_target_symlink_free(&base, &dir)?;
    }
    // Check access without walking other jobs' entries.
    #[cfg(windows)]
    if let Err(err) = std::fs::read_dir(&dir)
        && err.kind() != ErrorKind::NotFound
    {
        return Err(MaterializeError::io(&dir, &err));
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

/// Whether `source_path`, the name a retained row stores, names a staged
/// original of `job_id`: a name that job's replace makes, in the folder it
/// stages into.
pub fn is_staged_original(
    store: &EngineStore,
    job_id: &str,
    source_path: &str,
) -> Result<bool, MaterializeError> {
    let Some((folder, name)) = source_path.rsplit_once('/') else {
        return Ok(false);
    };
    let staging = store
        .staging_location(job_id)?
        .unwrap_or_else(|| STAGING_DIR.to_owned());
    Ok(folder == staging && staged_name_key(name) == Some(staged_key(job_id).as_str()))
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
    root: &Path,
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
        #[cfg(feature = "fault-injection")]
        dohc_engine_storage::capture_phase::count("publication_staging_entries", 1);
        let entry = entry.map_err(|err| MaterializeError::io(staging, &err))?;
        let Ok(name) = entry.file_name().into_string() else {
            continue;
        };
        let Some(key) = staged_name_key(&name) else {
            continue;
        };
        if names.contains(&name)
            || store.is_retained_source(&stored_name(
                store.database_path(),
                root,
                &staging.join(&name),
            )?)?
        {
            continue;
        }
        let (job_id, job) = staged_job(store, key)?;
        let job_id = job_id.unwrap_or_else(|| key.to_owned());
        found.push(RowlessStaged { name, job_id, job });
    }
    Ok(found)
}

fn rowless_all(store: &EngineStore, root: &Path) -> Result<Vec<RowlessStaged>, MaterializeError> {
    let mut files = Vec::new();
    let (dirs, unavailable) = all_staging_dirs(store, root)?;
    if unavailable {
        set_recovery_unavailable(root, true);
    }
    for dir in dirs {
        files.extend(rowless_staged(store, root, &dir)?);
    }
    Ok(files)
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
        let staging = if matches!(self, Self::Rowless(RowlessStaged { job: None, .. })) {
            staging.to_path_buf()
        } else {
            job_staging_dir(store, root, self.job_id(), false)?
        };
        let path = match self {
            Self::Journaled(row) => Some(row.target_path.as_str()),
            Self::Rowless(staged) => staged.job.as_ref().map(|job| job.target_path.as_str()),
        };
        if let Some(path) = path
            && !path.is_empty()
            && match placement_is_held(store, root, self.workspace_id(), path, None, options.holds)
            {
                Ok(held) => held,
                Err(error @ MaterializeError::Storage(_)) => return Err(error),
                // Recovery inspects staging before it needs a resolvable target.
                Err(_) => false,
            }
        {
            return Ok(false);
        }
        match self {
            Self::Journaled(row) => recover_displacement(store, root, &staging, row, options),
            Self::Rowless(staged) => match &staged.job {
                Some(job) => recover_staged(store, root, &staging, &staged.name, job, options),
                None => keep_orphan(store, &staging, staged, workspace_id, options),
            },
        }
    }
}

/// Remove the regular file at `rel` when its bytes hash to `sha256`, so the
/// path is free. `true` when `rel` is free afterwards, absent before or
/// removed; `false`, removing nothing, when it holds anything else.
pub fn remove_file_holding(
    store: &EngineStore,
    root: &Path,
    rel: &str,
    sha256: &str,
) -> Result<bool, MaterializeError> {
    match probe_projection_target(root, rel, ProjectionTargetKind::Plaintext) {
        ProjectionTargetState::Absent => return Ok(true),
        ProjectionTargetState::Text { sha256: held }
        | ProjectionTargetState::Binary { sha256: held }
            if held == sha256 => {}
        _ => return Ok(false),
    }
    let canonical_root =
        std::fs::canonicalize(root).map_err(|err| MaterializeError::io(root, &err))?;
    let target = resolve_target(&canonical_root, rel)?;
    ensure_target_symlink_free(&canonical_root, &target)?;
    std::fs::remove_file(&target).map_err(|err| MaterializeError::io(&target, &err))?;
    sync_parent_dir(store, target.parent(), DurabilityPolicy::per_os())?;
    Ok(true)
}

/// Remove the directory at `rel` when it is empty, so a file can take its
/// name. Used when a sync page deletes the last tracked files under a path
/// and then writes a file there. Only a real, empty directory below the
/// workspace root is removed; `false` when nothing was removed. On macOS a
/// directory that holds only Finder's files, such as `.DS_Store`, is empty.
pub fn remove_empty_directory_target(
    store: &EngineStore,
    root: &Path,
    rel: &str,
) -> Result<bool, MaterializeError> {
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
    if remove_emptied_directory(&canonical_root, rel, &target, || {}) {
        sync_parent_dir(store, target.parent(), DurabilityPolicy::per_os())?;
        Ok(true)
    } else {
        Ok(false)
    }
}

/// Remove the directory at `rel` if it is empty. On Unix every step goes
/// through directory handles opened without following a link, so a folder
/// swapped for a link cannot point a deletion outside the workspace. On macOS
/// Finder's files go first when they are all the directory holds;
/// `after_inspect` runs between that check and the deletion.
#[cfg(unix)]
fn remove_emptied_directory(
    root: &Path,
    rel: &str,
    target: &Path,
    after_inspect: impl FnOnce(),
) -> bool {
    use rustix::fs::{AtFlags, Mode, OFlags};
    let relative = Path::new(rel);
    let Some(leaf) = relative.file_name() else {
        return false;
    };
    let parent = relative.parent().unwrap_or_else(|| Path::new(""));
    let Ok(Some(parent_fd)) = open_existing_secret_parent_unix(root, parent, target) else {
        return false;
    };
    let flags = OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC;
    let Ok(directory) = rustix::fs::openat(&parent_fd, leaf, flags, Mode::empty()) else {
        return false;
    };
    #[cfg(target_vendor = "apple")]
    {
        let finder_files = finder_files_only(&directory);
        after_inspect();
        for name in finder_files.into_iter().flatten() {
            let _ = rustix::fs::unlinkat(&directory, name.as_c_str(), AtFlags::empty());
        }
    }
    #[cfg(not(target_vendor = "apple"))]
    {
        // Only macOS removes metadata, so the open only proved this is a
        // directory and not a link.
        drop(directory);
        after_inspect();
    }
    rustix::fs::unlinkat(&parent_fd, leaf, AtFlags::REMOVEDIR).is_ok()
}

#[cfg(not(unix))]
fn remove_emptied_directory(
    _root: &Path,
    _rel: &str,
    target: &Path,
    after_inspect: impl FnOnce(),
) -> bool {
    after_inspect();
    std::fs::remove_dir(target).is_ok()
}

/// The names in `directory` when every entry is a regular file Finder wrote,
/// such as `.DS_Store`. `None` when anything else is there.
#[cfg(target_vendor = "apple")]
fn finder_files_only(directory: &rustix::fd::OwnedFd) -> Option<Vec<std::ffi::CString>> {
    use rustix::fs::{AtFlags, FileType};
    let mut entries = rustix::fs::Dir::read_from(directory).ok()?;
    let mut names = Vec::new();
    while let Some(entry) = entries.read() {
        let entry = entry.ok()?;
        let name = entry.file_name();
        if matches!(name.to_bytes(), b"." | b"..") {
            continue;
        }
        let regular = rustix::fs::statat(directory, name, AtFlags::SYMLINK_NOFOLLOW)
            .is_ok_and(|stat| FileType::from_raw_mode(stat.st_mode) == FileType::RegularFile);
        let finder = name.to_str().is_ok_and(|text| {
            crate::floor::is_finder_metadata_file(&crate::floor::normalize_segment(text))
        });
        if !regular || !finder {
            return None;
        }
        names.push(name.to_owned());
    }
    Some(names)
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
    if store.is_passive() {
        return Ok(());
    }
    let canonical_root =
        std::fs::canonicalize(root).map_err(|err| MaterializeError::io(root, &err))?;
    let (dirs, mut unavailable) = all_staging_dirs(store, &canonical_root)?;
    for dir in dirs {
        match recover_displacements_in(store, &canonical_root, &dir, workspace_id, options) {
            Ok(()) => {}
            Err(
                error @ MaterializeError::Io {
                    kind: ErrorKind::Interrupted,
                    ..
                },
            ) => return Err(error),
            Err(MaterializeError::Storage(e)) => {
                set_recovery_unavailable(&canonical_root, true);
                return Err(e.into());
            }
            Err(error) => {
                unavailable = true;
                eprintln!(
                    "materialization recovery directory {}: {error}",
                    dir.display()
                );
            }
        }
    }
    // One verdict for the entire sweep. A later healthy directory cannot clear
    // an earlier failure; a subsequent complete healthy sweep can.
    set_recovery_unavailable(&canonical_root, unavailable);
    Ok(())
}

fn recover_displacements_in(
    store: &EngineStore,
    canonical_root: &Path,
    staging: &Path,
    workspace_id: Option<&str>,
    options: &MaterializeOptions<'_>,
) -> Result<(), MaterializeError> {
    let rowless = rowless_staged(store, canonical_root, staging)?;
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
        sync_staged(store, staging, options.policy)?;
        store.open_displacements(&adopt)?;
    }
    if !adopt.is_empty()
        && should_crash(
            options.faults,
            FaultPoint::MaterializeAfterDisplacementJournal,
        )
    {
        return Err(MaterializeError::io(
            staging,
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
            canonical_root,
            staging,
            workspace_id.unwrap_or(""),
            options,
        );
        settle(recovered, entry.job_id())?;
    }
    cleanup_staging_directory(store, canonical_root, staging)?;
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
    if store.is_passive() {
        return Ok(());
    }
    let canonical_root =
        std::fs::canonicalize(root).map_err(|err| MaterializeError::io(root, &err))?;
    let staging = staging_dir(store.database_path(), &canonical_root, false)?;
    let rowless = rowless_all(store, &canonical_root)?
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

/// What [`save_kept_displacement`] did with a kept file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KeptCopySave {
    /// The kept file is now this visible workspace-relative path.
    Saved(String),
    /// The workspace has no kept row under that id, or its file was already
    /// gone. A row whose file is gone is ended too.
    Gone,
    /// No free sibling name fits the engine's and the OS's name and path
    /// limits and keeps the original's classification, so capture could not
    /// record a copy.
    /// The file stays at its hidden name, and its row stays.
    NoValidName,
}

/// Move a kept file from staging to a visible copy beside
/// its path, `name (kept copy).ext`, and end its row. Capture then records
/// the copy like any new file, and the person or an agent can open, compare
/// or delete it.
///
/// The move never replaces a file, and the row ends only once the hidden
/// name is gone, so kept bytes are never left under two names unreported.
/// Where no sibling name would be recorded by capture, the file and its row
/// stay.
pub fn save_kept_displacement(
    store: &EngineStore,
    root: &Path,
    workspace_id: &str,
    displacement_id: i64,
    options: &MaterializeOptions<'_>,
) -> Result<KeptCopySave, MaterializeError> {
    save_kept_displacement_with_cleanup(
        store,
        root,
        workspace_id,
        displacement_id,
        options,
        cleanup_staging_directory,
    )
}

fn save_kept_displacement_with_cleanup(
    store: &EngineStore,
    root: &Path,
    workspace_id: &str,
    displacement_id: i64,
    options: &MaterializeOptions<'_>,
    cleanup: impl FnOnce(&EngineStore, &Path, &Path) -> Result<(), MaterializeError>,
) -> Result<KeptCopySave, MaterializeError> {
    require_materialization_owner(store)?;
    let Some(row) = store
        .list_kept_displacements(workspace_id)?
        .into_iter()
        .find(|row| row.displacement_id == displacement_id)
    else {
        return Ok(KeptCopySave::Gone);
    };
    if !is_staged_name(&row.displaced_name) {
        return Err(MaterializeError::UnsafeTargetPath);
    }
    let canonical_root =
        std::fs::canonicalize(root).map_err(|err| MaterializeError::io(root, &err))?;
    let staging = job_staging_dir(store, &canonical_root, &row.job_id, false)?;
    let kept = staging.join(&row.displaced_name);
    if !entry_exists(&kept)? {
        store.resolve_displacement(
            displacement_id,
            DisplacementResolution::Discard,
            None,
            options.now_ms,
        )?;
        if let Err(error) = cleanup(store, &canonical_root, &staging) {
            eprintln!("materialization staging cleanup: {error}");
        }
        return Ok(KeptCopySave::Gone);
    }
    // Orphan staging files have no original path. Keep them available through
    // the recovery folder rather than guessing a name or file classification.
    if row.target_path.is_empty() {
        return Ok(KeptCopySave::NoValidName);
    }
    let target = resolve_target(&canonical_root, &row.target_path)?;
    match ensure_target_symlink_free(&canonical_root, &target) {
        Err(err) if names_too_long(&err) => return Ok(KeptCopySave::NoValidName),
        checked => checked?,
    }
    let (parent, file_name) = match row.target_path.rsplit_once('/') {
        Some((parent, name)) => (Some(parent), name),
        None => (None, row.target_path.as_str()),
    };
    let original_class = classify_engine_file_path(&row.target_path);
    let name_budget = MAX_KEPT_COPY_NAME_BYTES.min(
        MAX_CANONICAL_WORKSPACE_PATH_BYTES
            .saturating_sub(parent.map_or(0, |parent| parent.len() + 1)),
    );
    // macOS refuses a whole path of PATH_MAX bytes, its NUL included, so the
    // copy's full path must fit too.
    #[cfg(target_vendor = "apple")]
    let name_budget = name_budget.min(
        APPLE_PATH_MAX.saturating_sub(target.parent().map_or(0, |dir| dir.as_os_str().len() + 2)),
    );
    for n in 1..=MAX_DISPLACED_NAMES {
        let Some(name) = kept_copy_name(file_name, n, name_budget) else {
            return Ok(KeptCopySave::NoValidName);
        };
        let copy_path = match parent {
            Some(parent) => format!("{parent}/{name}"),
            None => name.clone(),
        };
        // The copy must be a path capture records, under the same rule as the
        // original: never ignored, and never a secret turned plain or back.
        let (class, normalized) = classify_engine_file_path_normalized(&copy_path);
        if class == PathClassification::Ignored
            || class != original_class
            || normalized.as_deref() != Some(copy_path.as_str())
        {
            return Ok(KeptCopySave::NoValidName);
        }
        let copy = sibling_with_name(&target, &name);
        let exists = match entry_exists(&copy) {
            Err(err) if names_too_long(&err) => return Ok(KeptCopySave::NoValidName),
            exists => exists?,
        };
        // A copy that is the kept file itself, linked before a crash or a
        // failed unlink, is this save's own: finish it. Anything else at the
        // name, even with the same bytes, is another file.
        if exists {
            if !is_same_file(&kept, &copy).map_err(|err| MaterializeError::io(&copy, &err))? {
                continue;
            }
            #[cfg(windows)]
            remove_placement_link(&kept, &copy).map_err(|err| MaterializeError::io(&kept, &err))?;
            #[cfg(not(windows))]
            std::fs::remove_file(&kept).map_err(|err| MaterializeError::io(&kept, &err))?;
        } else {
            match move_kept_copy(&kept, &copy, options) {
                Ok(true) => {}
                Ok(false) => continue,
                Err(err) if names_too_long(&err) => return Ok(KeptCopySave::NoValidName),
                Err(err) => return Err(err),
            }
        }
        sync_parent_dir(store, copy.parent(), options.policy)?;
        sync_staged(store, &staging, options.policy)?;
        store.resolve_displacement(
            displacement_id,
            DisplacementResolution::Discard,
            None,
            options.now_ms,
        )?;
        if let Err(error) = cleanup(store, &canonical_root, &staging) {
            eprintln!("materialization staging cleanup: {error}");
        }
        return Ok(KeptCopySave::Saved(copy_path));
    }
    Ok(KeptCopySave::NoValidName)
}

/// Move the kept file to `copy` without replacing anything there. `false`
/// when something is already at `copy`.
///
/// Linux and macOS try one exclusive rename first. A Unix filesystem without
/// it links the copy and then unlinks the hidden name; unlike
/// [`rename_no_replace`], a failed unlink is an error, so the row stays and
/// the next save finishes it. Windows and Unix filesystems with neither
/// use [`place_attempt`], so a
/// check-then-rename is recorded like any other placement's.
fn move_kept_copy(
    kept: &Path,
    copy: &Path,
    options: &MaterializeOptions<'_>,
) -> Result<bool, MaterializeError> {
    #[cfg(not(windows))]
    {
        #[cfg(any(target_os = "linux", target_os = "android", target_vendor = "apple"))]
        {
            use rustix::fs::{CWD, RenameFlags, renameat_with};
            use rustix::io::Errno;
            match renameat_with(CWD, kept, CWD, copy, RenameFlags::NOREPLACE) {
                Ok(()) => return Ok(true),
                Err(err) if err == Errno::EXIST => return Ok(false),
                Err(err)
                    if err == Errno::INVAL
                        || err == Errno::NOSYS
                        || err == Errno::NOTSUP
                        || err == Errno::OPNOTSUPP => {}
                Err(err) => return Err(MaterializeError::io(copy, &std::io::Error::from(err))),
            }
        }
        match std::fs::hard_link(kept, copy) {
            Ok(()) => {
                std::fs::remove_file(kept).map_err(|err| MaterializeError::io(kept, &err))?;
                return Ok(true);
            }
            Err(err) if err.kind() == ErrorKind::AlreadyExists => return Ok(false),
            Err(err) if hard_links_unsupported(&err) => {}
            Err(err) => return Err(MaterializeError::io(copy, &err)),
        }
    }
    match place_attempt(options.replacer, kept, copy)? {
        Attempt::Done(placed) => Ok(placed),
        Attempt::Locked(err) => Err(MaterializeError::io(copy, &err)),
    }
}

/// Whether the visible copy is the same regular file as the staged copy,
/// left under both names by an interrupted hard-link placement.
fn is_same_file(kept: &Path, copy: &Path) -> std::io::Result<bool> {
    for path in [kept, copy] {
        let metadata = std::fs::symlink_metadata(path)?;
        if !metadata.is_file() || metadata_is_reparse_point(&metadata) {
            return Ok(false);
        }
    }
    same_file::is_same_file(kept, copy)
}

fn has_multiple_links(path: &Path) -> std::io::Result<bool> {
    let file = open_displaced(path)?;
    #[cfg(windows)]
    let count = winapi_util::file::information(&file)?.number_of_links();
    #[cfg(unix)]
    let count = {
        use std::os::unix::fs::MetadataExt;
        file.metadata()?.nlink()
    };
    Ok(count > 1)
}

/// `notes (kept copy).md`, then `notes (kept copy 2).md`, within `budget`
/// bytes. A name with no extension, or only a leading dot, takes the suffix
/// at its end. The stem gives up bytes, never splitting a character; the
/// suffix and the extension stay whole. `None` when not one stem byte fits.
fn kept_copy_name(file_name: &str, n: u32, budget: usize) -> Option<String> {
    let suffix = match n {
        1 => " (kept copy)".to_owned(),
        n => format!(" (kept copy {n})"),
    };
    let (stem, extension) = match file_name.rfind('.') {
        Some(dot) if dot > 0 && file_name.len() - dot + suffix.len() < budget => {
            file_name.split_at(dot)
        }
        _ => (file_name, ""),
    };
    let mut keep = budget
        .checked_sub(suffix.len() + extension.len())?
        .min(stem.len());
    while !stem.is_char_boundary(keep) {
        keep -= 1;
    }
    (keep > 0).then(|| format!("{}{suffix}{extension}", &stem[..keep]))
}

/// The longest file name, in UTF-8 bytes, a kept copy takes. Most file
/// systems allow 255 bytes or 255 UTF-16 units per name, and 255 bytes of
/// UTF-8 never needs more than 255 UTF-16 units.
const MAX_KEPT_COPY_NAME_BYTES: usize = 255;

/// macOS `PATH_MAX`: the bytes of a whole path, its NUL included.
#[cfg(target_vendor = "apple")]
const APPLE_PATH_MAX: usize = 1_024;

/// Whether the OS refused a path as too long, or as a name it cannot hold.
/// No kept copy can take such a path, so the file stays kept.
fn names_too_long(err: &MaterializeError) -> bool {
    matches!(
        err,
        MaterializeError::Io {
            kind: ErrorKind::InvalidFilename,
            ..
        }
    )
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
    Ok(rowless_all(store, &canonical_root)?.iter().any(|staged| {
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
    _target: &Path,
    job: &MaterializationJob,
    options: &MaterializeOptions<'_>,
) -> Result<(Staging, bool), MaterializeError> {
    // Only a job that expects a file can stage one.
    let path_rows =
        store.list_unsettled_displacements_for_path(&job.workspace_id, &job.target_path)?;
    if matches!(job.preimage, Preimage::Absent) && path_rows.is_empty() {
        return Ok((
            Staging {
                root: root.to_owned(),
                dir: staging_base(store.database_path(), root).1,
                taken: Vec::new(),
            },
            false,
        ));
    }
    let dir = job_staging_dir(
        store,
        root,
        &job.job_id,
        matches!(job.preimage, Preimage::Present(_)),
    )
    .map_err(|_| {
        set_recovery_unavailable(root, true);
        MaterializeError::RecoveryUnavailable
    })?;
    let mut rows = store.list_displacements_for_job(&job.job_id)?;
    let mut taken: Vec<String> = rows.iter().map(|row| row.displaced_name.clone()).collect();
    taken.extend(store.retained_names_for_job(&job.job_id)?);
    // Names are bounded per job. Do not scan other saves' retained originals.
    let mut rowless = Vec::new();
    for n in 0..MAX_DISPLACED_NAMES {
        let name = staged_name(&job.job_id, n);
        #[cfg(windows)]
        readonly_link::recover_one(&dir.join(&name), _target)
            .map_err(|err| MaterializeError::io(&dir, &err))?;
        if !taken.contains(&name) && entry_exists(&dir.join(&name))? {
            rowless.push(name);
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
        return Ok((
            Staging {
                root: root.to_owned(),
                dir,
                taken,
            },
            false,
        ));
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
    taken.extend(store.retained_names_for_job(&job.job_id)?);
    Ok((
        Staging {
            root: root.to_owned(),
            dir,
            taken,
        },
        kept,
    ))
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
    #[cfg(windows)]
    if placement_is_linked(&staged, &target).map_err(|err| MaterializeError::io(&staged, &err))? {
        return return_displaced(store, &target, &staged, options).map(|returned| !returned);
    }
    let write = job.operation == MaterializationOperation::Write;
    if write
        && !entry_exists(&target)?
        && entry_exists(&temp_sibling(&target, &job.job_id))?
        && return_displaced(store, &target, &staged, options)?
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
        known @ (Inspected::Known { .. } | Inspected::Missing) => {
            dispose_known(store, root, &staged, &spec, &known, options.now_ms)?;
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
    // Save may have linked the visible copy but stopped before unlinking
    // staging. Leave both names and the row for the next Save to finish. A
    // kept file that cannot be opened is also left staged.
    if displacement.state == DisplacementState::Kept
        && has_multiple_links(&moved.path).unwrap_or(true)
    {
        return Ok(true);
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
    #[cfg(windows)]
    if placement_is_linked(&moved.path, &target)
        .map_err(|err| MaterializeError::io(&moved.path, &err))?
    {
        if return_displaced(store, &target, &moved.path, options)? {
            store.resolve_displacement(
                moved.displacement_id,
                DisplacementResolution::Discard,
                None,
                options.now_ms,
            )?;
            return Ok(false);
        }
        return Ok(true);
    }
    if displacement.state == DisplacementState::Open
        && !entry_exists(&target)?
        && return_displaced(store, &target, &moved.path, options)?
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
        known @ (Inspected::Known { .. } | Inspected::Missing) => {
            let spec = DisplacementSpec {
                job_id: displacement.job_id.clone(),
                workspace_id: displacement.workspace_id.clone(),
                target_path: displacement.target_path.clone(),
                displaced_name: displacement.displaced_name.clone(),
                expected_sha256: displacement.expected_sha256.clone(),
                content_sha256: displacement.content_sha256.clone(),
                now_ms: options.now_ms,
            };
            dispose_known(store, root, &moved.path, &spec, &known, options.now_ms)?;
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

/// Whether a hold on `held` covers `path`: the same path in any case or
/// Unicode normalization, or a path beneath it. Aliases deliberately over-hold
/// distinct paths on case-sensitive volumes.
pub fn path_is_held(held: &str, path: &str) -> bool {
    let (held, path) = (path_collision_key(held), path_collision_key(path));
    path == held
        || path
            .strip_prefix(&held)
            .is_some_and(|tail| tail.starts_with('/'))
}

/// Whether a durable capture hold in `workspace` covers `path`.
pub fn placement_is_held_in(
    store: &EngineStore,
    workspace: &str,
    path: &str,
) -> Result<bool, StorageError> {
    Ok(store
        .held_paths(workspace)?
        .iter()
        .any(|held| path_is_held(held, path)))
}

/// Protect lexical aliases and held ancestors on every platform. Filesystem
/// aliases are checked only here, after the placement boundary resolves them.
fn placement_is_held(
    store: &EngineStore,
    root: &Path,
    workspace: &str,
    path: &str,
    target: Option<&Path>,
    holds: Option<&PlacementHolds>,
) -> Result<bool, MaterializeError> {
    if target.is_some_and(|target| target.strip_prefix(root).is_err()) {
        return Err(MaterializeError::UnsafeTargetPath);
    }
    if let Some(holds) = holds.filter(|holds| holds.workspace_id == workspace) {
        if holds.blocks(path) {
            return Ok(true);
        }
        if holds.is_empty() {
            return Ok(false);
        }
        #[cfg(windows)]
        {
            if let Some(target) = target {
                return holds.resolved(root, target);
            }
            return holds.resolved(root, &resolve_target(root, path)?);
        }
        #[cfg(not(windows))]
        return Ok(false);
    }
    if placement_is_held_in(store, workspace, path)? {
        return Ok(true);
    }
    #[cfg(windows)]
    {
        let resolved_target;
        let target = if let Some(target) = target {
            target
        } else {
            resolved_target = resolve_target(root, path)?;
            &resolved_target
        };
        let resolved = target
            .strip_prefix(root)
            .map_err(|_| MaterializeError::UnsafeTargetPath)?
            .to_string_lossy()
            .replace('\\', "/");
        if resolved != path {
            return Ok(placement_is_held_in(store, workspace, &resolved)?);
        }
    }
    #[cfg(not(windows))]
    let _ = (root, target);
    Ok(false)
}

fn target_has_other_leaf_spelling(target: &Path) -> bool {
    other_leaf_spelling(target).is_some()
}

fn other_leaf_spelling(target: &Path) -> Option<std::ffi::OsString> {
    #[cfg(windows)]
    {
        let requested = target.file_name()?.to_str()?;
        let stored = dohc_windows_files::stored_leaf_name(target).ok()?;
        if stored != requested
            && crate::floor::fold_segment(stored.to_str()?) == crate::floor::fold_segment(requested)
        {
            return Some(stored);
        }
    }
    #[cfg(not(windows))]
    let _ = target;
    None
}

/// The existing disk-placement segment rule, including tracked peer names.
fn materialize_segment_is_safe(segment: &str) -> bool {
    !segment.is_empty()
        && segment != "."
        && segment != ".."
        && !segment.contains('\\')
        && !segment.contains(':')
}

/// Admission for a new document opened by a link click. Existing tracked
/// files keep the disk writer's broader rule.
pub fn creation_segment_is_safe(segment: &str) -> bool {
    if !materialize_segment_is_safe(segment)
        || segment.contains('/')
        || segment.chars().any(char::is_control)
    {
        return false;
    }
    #[cfg(windows)]
    {
        let name = segment.trim_end_matches(['.', ' ']);
        let base = name
            .split('.')
            .next()
            .unwrap_or(name)
            .trim_end_matches(['.', ' ']);
        let base = base.to_ascii_lowercase();
        let named_device = matches!(
            base.as_str(),
            "con" | "prn" | "aux" | "nul" | "conin$" | "conout$" | "clock$"
        );
        let numbered_device = ["com", "lpt"].into_iter().any(|prefix| {
            base.strip_prefix(prefix).is_some_and(|number| {
                number.chars().count() == 1
                    && number
                        .chars()
                        .any(|c| matches!(c, '1'..='9' | '¹' | '²' | '³'))
            })
        });
        if named_device || numbered_device {
            return false;
        }
        // Desktop: ^[^.\s]{1,8}~\d+(?:\.[^.\s]{1,3})?$
        let (base, extension) = name
            .split_once('.')
            .map_or((name, None), |(b, e)| (b, Some(e)));
        if let Some((stem, digits)) = base.rsplit_once('~') {
            let plain = |text: &str| {
                !text
                    .chars()
                    .any(|c| c == '.' || c.is_whitespace() || c == '\u{feff}')
            };
            if (1..=8).contains(&stem.encode_utf16().count())
                && plain(stem)
                && !digits.is_empty()
                && digits.bytes().all(|byte| byte.is_ascii_digit())
                && extension
                    .is_none_or(|ext| (1..=3).contains(&ext.encode_utf16().count()) && plain(ext))
            {
                return false;
            }
        }
    }
    true
}

/// Resolve a workspace-relative forward-slash path to an absolute target under
/// `root`, rejecting escapes, absolute inputs, and path-floor entries.
fn resolve_target(root: &Path, rel: &str) -> Result<PathBuf, MaterializeError> {
    if rel.is_empty() || is_excluded_file(rel) || crate::policy::is_shared_with_me_path(rel) {
        return Err(MaterializeError::UnsafeTargetPath);
    }
    let mut out = root.to_path_buf();
    for segment in rel.split('/') {
        if !materialize_segment_is_safe(segment) {
            return Err(MaterializeError::UnsafeTargetPath);
        }
        out.push(segment);
    }
    #[cfg(windows)]
    {
        let requested_leaf = out.file_name().unwrap().to_os_string();
        // Check links before resolving aliases. Resolve the deepest existing
        // path once, including an existing leaf so file aliases cannot bypass
        // the sidecar and conflict-artifact floor.
        let mut existing = root.to_path_buf();
        for component in out.strip_prefix(root).unwrap().components() {
            let candidate = existing.join(component);
            match std::fs::symlink_metadata(&candidate) {
                Ok(metadata) => {
                    if metadata.file_type().is_symlink() || metadata_is_reparse_point(&metadata) {
                        return Err(MaterializeError::SymlinkTarget);
                    }
                    existing = candidate;
                }
                Err(err) if err.kind() == ErrorKind::NotFound => break,
                Err(err) => return Err(MaterializeError::io(&candidate, &err)),
            }
        }
        if existing != root {
            let resolved = std::fs::canonicalize(&existing)
                .map_err(|err| MaterializeError::io(&existing, &err))?;
            let suffix = out.strip_prefix(&existing).unwrap();
            out = if suffix.as_os_str().is_empty() {
                resolved
            } else {
                resolved.join(suffix)
            };
        }
        let relative = out
            .strip_prefix(root)
            .map_err(|_| MaterializeError::UnsafeTargetPath)?;
        let relative = relative.to_string_lossy().replace('\\', "/");
        if is_excluded_file(&relative) || crate::policy::is_shared_with_me_path(&relative) {
            return Err(MaterializeError::UnsafeTargetPath);
        }
        // Validate the resolved alias first, including the short-name floor.
        // Publication must still use the requested case of an ordinary leaf.
        if requested_leaf
            .to_str()
            .zip(out.file_name().and_then(OsStr::to_str))
            .is_some_and(|(requested, resolved)| {
                crate::floor::fold_segment(requested) == crate::floor::fold_segment(resolved)
            })
        {
            out.set_file_name(requested_leaf);
        }
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
/// workspace. This validator shares the component walk with projection probes
/// and parent creation.
pub(super) fn ensure_target_symlink_free(
    root: &Path,
    target: &Path,
) -> Result<(), MaterializeError> {
    walk_target_components(root, target, reject_link_or_reparse)
}

fn projection_has_file_ancestor(root: &Path, target: &Path) -> Result<bool, MaterializeError> {
    let mut blocked = false;
    walk_target_components(root, target, |path| {
        if blocked {
            return Ok(());
        }
        let metadata = match std::fs::symlink_metadata(path) {
            Ok(metadata) => metadata,
            Err(err) if err.kind() == ErrorKind::NotFound => return Ok(()),
            Err(err) => return Err(MaterializeError::io(path, &err)),
        };
        if metadata.file_type().is_symlink() || metadata_is_reparse_point(&metadata) {
            return Err(MaterializeError::SymlinkTarget);
        }
        blocked = path != target && metadata.is_file();
        Ok(())
    })?;
    Ok(blocked)
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
            write_temp_at_unix(
                &self.parent_fd,
                name,
                display_path,
                content,
                TempAccess::Owner,
            )
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

    fn sync(&self, store: &EngineStore, policy: DurabilityPolicy) -> Result<(), MaterializeError> {
        if !policy.fsync_parent_dir {
            return Ok(());
        }

        #[cfg(unix)]
        {
            // Flush through the store, not `rustix::fs::fsync`: plain fsync
            // neither orders nor drains on macOS, and the store picks the
            // flush `sync_parent_dir` uses. Duplicating the PINNED fd keeps
            // the pin — the duplicate closes with `file`, the original stays
            // open.
            let duplicate = rustix::io::fcntl_dupfd_cloexec(&self.parent_fd, 0)
                .map_err(std::io::Error::from)
                .map_err(|err| MaterializeError::io(&self.parent_path, &err))?;
            store
                .flush_before_commits(&std::fs::File::from(duplicate))
                .map_err(|err| MaterializeError::io(&self.parent_path, &err))
        }

        #[cfg(not(unix))]
        {
            let _ = store;
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

/// Who may open a temp. A temp gives nobody but the owner more access than
/// the file it replaces. Only a new ordinary file takes what the folder's
/// ACL grants every new file: on macOS the other temps never take it, and
/// on Linux their 0600 mode empties a default ACL's mask.
#[cfg(unix)]
enum TempAccess {
    /// Only the owner: secret plaintext, or a target the engine cannot read.
    Owner,
    /// A new ordinary file. The umask decides its mode.
    New,
    /// The regular file the temp replaces.
    Like(Replaced),
}

#[cfg(unix)]
impl TempAccess {
    /// Stat `target` without following a link first, so nothing opens a FIFO
    /// or a device there. A missing target is a new file. A regular file is
    /// opened without following a link. Any other entry, or a file the
    /// engine cannot open, gets an owner-only temp.
    fn replacing(parent_fd: &rustix::fd::OwnedFd, target: &OsStr) -> Self {
        use rustix::fs::{AtFlags, FileType, Mode, OFlags};

        match rustix::fs::statat(parent_fd, target, AtFlags::SYMLINK_NOFOLLOW) {
            Err(rustix::io::Errno::NOENT) => return Self::New,
            Ok(stat) if FileType::from_raw_mode(stat.st_mode) == FileType::RegularFile => {}
            _ => return Self::Owner,
        }
        let Ok(file) = rustix::fs::openat(
            parent_fd,
            target,
            OFlags::RDONLY | OFlags::NONBLOCK | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        ) else {
            return Self::Owner;
        };
        let stat = match rustix::fs::fstat(&file) {
            Ok(stat) if FileType::from_raw_mode(stat.st_mode) == FileType::RegularFile => stat,
            _ => return Self::Owner,
        };
        Self::Like(Replaced {
            #[cfg(target_os = "linux")]
            has_acl: has_posix_acl(&file),
            #[cfg(target_vendor = "apple")]
            file,
            mode: Mode::from_raw_mode(stat.st_mode & 0o777),
            uid: stat.st_uid,
            gid: stat.st_gid,
        })
    }
}

/// What an ordinary temp takes from the regular file it replaces: the group,
/// the permission bits and, on macOS, the ACL and the extended attributes a
/// save keeps. Setuid, setgid and sticky bits, the owner and times are not
/// copied, so capture sees the replace.
#[cfg(unix)]
struct Replaced {
    #[cfg(target_vendor = "apple")]
    file: rustix::fd::OwnedFd,
    mode: rustix::fs::Mode,
    uid: u32,
    gid: u32,
    /// Whether the file has a POSIX ACL, which the temp does not take.
    #[cfg(target_os = "linux")]
    has_acl: bool,
}

#[cfg(unix)]
impl Replaced {
    /// Give the empty temp this file's group, ACL and mode, as [`temp_mode`]
    /// allows. A failed copy never fails the write.
    fn apply_to(&self, temp: &std::fs::File) {
        let has_gid = || rustix::fs::fstat(temp).is_ok_and(|stat| stat.st_gid == self.gid);
        let gid = Some(rustix::fs::Gid::from_raw(self.gid));
        let group_kept = has_gid() || (rustix::fs::fchown(temp, None, gid).is_ok() && has_gid());
        let owner_kept = rustix::fs::fstat(temp).is_ok_and(|stat| stat.st_uid == self.uid);
        // A Linux ACL's mask shows as the group bits. A folder's default ACL
        // can give the temp an ACL the file never had.
        #[cfg(target_os = "linux")]
        let acl_kept = !self.has_acl && !has_posix_acl(temp);
        // The temp has no ACL yet, so none of the file's entries can block
        // the attribute copy.
        #[cfg(target_vendor = "apple")]
        dohc_macos_files::copy_saved_xattrs(&self.file, temp);
        #[cfg(target_vendor = "apple")]
        let acl_kept = dohc_macos_files::copy_acl(&self.file, temp).is_ok();
        // No check exists for another Unix's ACLs.
        #[cfg(not(any(target_os = "linux", target_vendor = "apple")))]
        let acl_kept = false;
        let mode = temp_mode(self.mode, group_kept, acl_kept, owner_kept);
        let _ = rustix::fs::fchmod(temp, mode);
    }
}

/// The mode a temp takes from a file with `mode`. The full mode needs the
/// file's ACL on the temp, or no ACL on either, and it needs the file's group
/// or equal group and other bits. Otherwise only the owner's bits stay, so
/// nobody but the owner gains access. A temp with another owner than the
/// file, the engine's user, keeps read and write, so the engine can read the
/// file it wrote.
#[cfg(unix)]
fn temp_mode(
    mode: rustix::fs::Mode,
    group_kept: bool,
    acl_kept: bool,
    owner_kept: bool,
) -> rustix::fs::Mode {
    use rustix::fs::Mode;

    let bits = mode.bits();
    let group_is_other = (bits >> 3) & 0o7 == bits & 0o7;
    let mode = if acl_kept && (group_kept || group_is_other) {
        mode
    } else {
        mode & Mode::RWXU
    };
    if owner_kept {
        mode
    } else {
        mode | Mode::RUSR | Mode::WUSR
    }
}

#[cfg(all(test, target_vendor = "apple"))]
#[test]
fn a_volume_that_shares_new_files_reaches_the_caller_by_its_code() {
    let refused = std::io::Error::other(dohc_macos_files::VolumeSharesNewFiles);
    let err = temp_create_error(Path::new("ws/.env"), &refused);
    assert!(matches!(err, MaterializeError::VolumeSharesNewFiles));
    assert_eq!(err.code(), "volume-shares-new-files");
    assert!(!err.to_string().contains(".env"), "{err}");
}

#[cfg(all(test, unix))]
mod temp_mode_tests {
    use super::temp_mode;
    use rustix::fs::Mode;

    #[test]
    fn a_temp_with_another_owner_keeps_owner_read_and_write() {
        let mode = temp_mode(Mode::from_raw_mode(0o040), true, true, false);
        assert_eq!(mode, Mode::from_raw_mode(0o640));
        let mode = temp_mode(Mode::from_raw_mode(0o755), true, true, false);
        assert_eq!(mode, Mode::from_raw_mode(0o755));
    }

    #[test]
    fn a_lost_group_keeps_the_mode_only_when_group_and_other_bits_match() {
        for (old, new) in [
            (0o755, 0o755),
            (0o644, 0o644),
            (0o640, 0o600),
            (0o604, 0o600),
        ] {
            let mode = temp_mode(Mode::from_raw_mode(old), false, true, true);
            assert_eq!(mode, Mode::from_raw_mode(new), "{old:o}");
        }
    }

    #[test]
    fn an_acl_left_behind_keeps_only_the_owner_bits() {
        let mode = temp_mode(Mode::from_raw_mode(0o755), true, false, true);
        assert_eq!(mode, Mode::from_raw_mode(0o700));
    }
}

/// Whether a file has a POSIX access ACL. A failed check counts as one.
#[cfg(target_os = "linux")]
fn has_posix_acl(file: impl rustix::fd::AsFd) -> bool {
    !matches!(
        rustix::fs::fgetxattr(file, "system.posix_acl_access", &mut [0u8; 0]),
        Err(rustix::io::Errno::NODATA | rustix::io::Errno::NOTSUP)
    )
}

#[cfg(unix)]
fn write_temp_at_unix(
    parent_fd: &rustix::fd::OwnedFd,
    name: &OsStr,
    display_path: &Path,
    content: &[u8],
    access: TempAccess,
) -> Result<std::fs::File, MaterializeError> {
    use rustix::fs::{Mode, OFlags};
    use std::io::Write as _;

    let flags = OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC;
    let mode = Mode::from_raw_mode(match access {
        TempAccess::New => 0o666,
        TempAccess::Owner | TempAccess::Like(_) => 0o600,
    });
    let create = || -> std::io::Result<std::fs::File> {
        #[cfg(target_vendor = "apple")]
        if !matches!(access, TempAccess::New) {
            return dohc_macos_files::create_uninherited(parent_fd, name, mode.bits())
                .map(std::fs::File::from);
        }
        Ok(rustix::fs::openat(parent_fd, name, flags, mode)?.into())
    };
    let errno = |err: &std::io::Error| rustix::io::Errno::from_io_error(err);
    let mut file = match create() {
        Ok(file) => file,
        Err(err) if errno(&err) == Some(rustix::io::Errno::EXIST) => {
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
            create().map_err(|retry_err| temp_create_error(display_path, &retry_err))?
        }
        Err(err) if errno(&err) == Some(rustix::io::Errno::LOOP) => {
            return Err(MaterializeError::SymlinkTarget);
        }
        Err(err) => return Err(temp_create_error(display_path, &err)),
    };
    if let TempAccess::Like(replaced) = &access {
        replaced.apply_to(&file);
    }
    if let Err(err) = file.write_all(content) {
        drop(file);
        let _ = rustix::fs::unlinkat(parent_fd, name, rustix::fs::AtFlags::empty());
        return Err(MaterializeError::io(display_path, &err));
    }
    Ok(file)
}

/// The error for a temp that could not be created at `display_path`.
#[cfg(unix)]
fn temp_create_error(display_path: &Path, err: &std::io::Error) -> MaterializeError {
    #[cfg(target_vendor = "apple")]
    if dohc_macos_files::volume_shares_new_files(err) {
        return MaterializeError::VolumeSharesNewFiles;
    }
    MaterializeError::io(display_path, err)
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

/// Write an ordinary job's temp beside `target`, which it will replace. An
/// `owner_only` temp is 0600 whatever the target allows.
fn write_temp(
    target: &Path,
    tmp: &Path,
    content: &[u8],
    owner_only: bool,
) -> Result<std::fs::File, MaterializeError> {
    #[cfg(unix)]
    {
        use std::os::fd::OwnedFd;

        let parent_path = tmp.parent().ok_or(MaterializeError::UnsafeTargetPath)?;
        let name = tmp.file_name().ok_or(MaterializeError::UnsafeTargetPath)?;
        let target_name = target
            .file_name()
            .ok_or(MaterializeError::UnsafeTargetPath)?;
        let parent_fd: OwnedFd = std::fs::File::open(parent_path)
            .map_err(|err| MaterializeError::io(parent_path, &err))?
            .into();
        let access = if owner_only {
            TempAccess::Owner
        } else {
            TempAccess::replacing(&parent_fd, target_name)
        };
        write_temp_at_unix(&parent_fd, name, tmp, content, access)
    }
    #[cfg(not(unix))]
    {
        let _ = (target, owner_only);
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
    store: &EngineStore,
    file: &std::fs::File,
    tmp: &Path,
    policy: DurabilityPolicy,
) -> Result<(), MaterializeError> {
    if policy.fsync_file {
        store
            .flush_before_commits(file)
            .map_err(|e| MaterializeError::io(tmp, &e))?;
    }
    Ok(())
}

/// Flush the parent directory after the rename so the directory entry change
/// (the replace) persists before the job's status. POSIX only; on Windows `std`
/// exposes no portable directory sync, so this is a documented no-op there (an
/// honestly-scoped durability limit — `per_os()` sets `fsync_parent_dir =
/// false` off POSIX).
fn sync_parent_dir(
    store: &EngineStore,
    parent: Option<&Path>,
    policy: DurabilityPolicy,
) -> Result<(), MaterializeError> {
    if policy.fsync_parent_dir
        && let Some(dir) = parent
    {
        #[cfg(unix)]
        {
            let dirf = std::fs::File::open(dir).map_err(|e| MaterializeError::io(dir, &e))?;
            store
                .flush_before_commits(&dirf)
                .map_err(|e| MaterializeError::io(dir, &e))?;
        }
        #[cfg(not(unix))]
        {
            let _ = (store, dir); // documented no-op off POSIX
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
/// EPERM on Unix is not a lock: a macOS privacy refusal or an immutable file
/// does not clear while dohc waits.
fn is_transient_lock(err: &std::io::Error) -> bool {
    if cfg!(unix) && err.raw_os_error() == Some(1) {
        return false;
    }
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
    /// A store outside the workspace under test, for helpers that flush.
    fn flush_store() -> (dohc_test_scratch::ScratchDir, EngineStore) {
        let scratch = dohc_test_scratch::ScratchDir::new_named("flush-store").unwrap();
        let store = EngineStore::open(&scratch.path().join("engine.db"), 0).unwrap();
        (scratch, store)
    }

    #[test]
    fn directory_replacement_removes_only_empty_real_directories() {
        let (_db, store) = flush_store();
        let scratch = dohc_test_scratch::ScratchDir::new_named("empty-directory-target").unwrap();
        let root = scratch.path();
        std::fs::create_dir_all(root.join("d/sub")).unwrap();
        std::fs::write(root.join("d/keep.md"), "keep").unwrap();
        assert!(!super::remove_empty_directory_target(&store, root, "d").unwrap());
        assert!(super::remove_empty_directory_target(&store, root, "d/sub").unwrap());
        assert!(!super::remove_empty_directory_target(&store, root, "d").unwrap());
        assert_eq!(
            std::fs::read_to_string(root.join("d/keep.md")).unwrap(),
            "keep"
        );
        assert!(!super::remove_empty_directory_target(&store, root, "d/sub").unwrap());
        assert!(super::remove_empty_directory_target(&store, root, "../d").is_err());
    }

    /// Finder writes `.DS_Store` into every folder it shows. Once the last
    /// file leaves, that folder is empty and goes, but no other file goes
    /// with it, and a volume folder such as `.Trashes` keeps its folder.
    #[cfg(target_vendor = "apple")]
    #[test]
    fn a_directory_holding_only_finder_files_is_empty() {
        let (_db, store) = flush_store();
        let scratch = dohc_test_scratch::ScratchDir::new_named("os-metadata-directory").unwrap();
        let root = scratch.path();
        std::fs::create_dir_all(root.join("d/sub")).unwrap();
        std::fs::write(root.join("d/sub/.DS_Store"), "finder").unwrap();
        std::fs::write(root.join("d/sub/._a.md"), "appledouble").unwrap();
        std::fs::write(root.join("d/.DS_Store"), "finder").unwrap();
        std::fs::write(root.join("d/keep.md"), "keep").unwrap();
        std::fs::create_dir_all(root.join("t/.Trashes/501")).unwrap();
        std::fs::write(root.join("t/.Trashes/501/trashed.md"), "trashed").unwrap();
        std::fs::create_dir_all(root.join("w")).unwrap();
        std::fs::write(root.join("w/Thumbs.db"), "explorer").unwrap();
        assert!(super::remove_empty_directory_target(&store, root, "d/sub").unwrap());
        assert!(!root.join("d/sub").exists());
        assert!(!super::remove_empty_directory_target(&store, root, "d").unwrap());
        assert!(root.join("d/.DS_Store").exists());
        assert!(root.join("d/keep.md").exists());
        assert!(!super::remove_empty_directory_target(&store, root, "t").unwrap());
        assert!(root.join("t/.Trashes/501/trashed.md").exists());
        assert!(!super::remove_empty_directory_target(&store, root, "w").unwrap());
        assert!(root.join("w/Thumbs.db").exists());
    }

    /// A folder swapped for a link between the check and the deletion must
    /// not send the deletion through the link.
    #[cfg(target_vendor = "apple")]
    #[test]
    fn a_folder_swapped_for_a_link_keeps_the_files_outside() {
        let scratch = dohc_test_scratch::ScratchDir::new_named("os-metadata-swap").unwrap();
        let outside = dohc_test_scratch::ScratchDir::new_named("os-metadata-outside").unwrap();
        let root = std::fs::canonicalize(scratch.path()).unwrap();
        std::fs::create_dir_all(root.join("d/sub")).unwrap();
        std::fs::write(root.join("d/sub/.DS_Store"), "ours").unwrap();
        std::fs::write(outside.path().join(".DS_Store"), "outside").unwrap();
        let target = root.join("d/sub");
        let removed = super::remove_emptied_directory(&root, "d/sub", &target, || {
            std::fs::rename(root.join("d/sub"), root.join("d/moved")).unwrap();
            std::os::unix::fs::symlink(outside.path(), root.join("d/sub")).unwrap();
        });
        assert!(!removed);
        assert_eq!(
            std::fs::read_to_string(outside.path().join(".DS_Store")).unwrap(),
            "outside"
        );
        assert!(
            std::fs::symlink_metadata(root.join("d/sub"))
                .unwrap()
                .file_type()
                .is_symlink()
        );
        assert!(root.join("d/moved").is_dir());
    }

    #[test]
    fn a_file_is_removed_only_while_it_holds_the_expected_bytes() {
        let (_db, store) = flush_store();
        let scratch = dohc_test_scratch::ScratchDir::new_named("file-holding").unwrap();
        let root = scratch.path();
        let held = dohc_engine_storage::hex_sha256(b"held");
        std::fs::write(root.join("a.md"), "edited").unwrap();
        assert!(!super::remove_file_holding(&store, root, "a.md", &held).unwrap());
        assert_eq!(
            std::fs::read_to_string(root.join("a.md")).unwrap(),
            "edited"
        );
        std::fs::write(root.join("a.md"), "held").unwrap();
        assert!(super::remove_file_holding(&store, root, "a.md", &held).unwrap());
        assert!(!root.join("a.md").exists());
        assert!(
            super::remove_file_holding(&store, root, "a.md", &held).unwrap(),
            "already free"
        );
        std::fs::create_dir(root.join("d.md")).unwrap();
        assert!(!super::remove_file_holding(&store, root, "d.md", &held).unwrap());
        assert!(root.join("d.md").is_dir());
    }

    #[cfg(unix)]
    #[test]
    fn directory_replacement_refuses_links_in_the_parent_chain() {
        let (_db, store) = flush_store();
        let scratch = dohc_test_scratch::ScratchDir::new_named("linked-directory-target").unwrap();
        let root = scratch.path();
        std::fs::create_dir_all(root.join("real/sub")).unwrap();
        std::os::unix::fs::symlink(root.join("real"), root.join("alias")).unwrap();
        assert!(super::remove_empty_directory_target(&store, root, "alias/sub").is_err());
        assert!(super::remove_empty_directory_target(&store, root, "alias").is_err());
        assert!(root.join("real/sub").is_dir());
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

    #[test]
    fn review_snapshot_refuses_a_target_outside_its_root() {
        let scratch = Scratch::new("held-target-outside-root");
        let store = EngineStore::open(&scratch.db(), 1).unwrap();
        let holds = PlacementHolds::from_holds("workspace", &[]);
        let outside = scratch.root.parent().unwrap().join("outside.md");
        assert!(matches!(
            placement_is_held(
                &store,
                &scratch.root,
                "workspace",
                "file.md",
                Some(&outside),
                Some(&holds)
            ),
            Err(MaterializeError::UnsafeTargetPath)
        ));
    }

    #[test]
    fn review_durable_hold_matches_case_and_descendants() {
        let scratch = Scratch::new("held-case-and-descendant");
        let mut store = EngineStore::open(&scratch.db(), 1).unwrap();
        store.write_with(&NoFaults, |tx| tx.execute_batch("INSERT INTO versioned_workspaces VALUES ('workspace','main'); INSERT INTO versions(workspace_id,version_id,kind,name,created_at_ms) VALUES ('workspace','main','main','Main',1); INSERT INTO file_objects VALUES ('workspace','held',1);").map_err(StorageError::persist_public)).unwrap();
        store
            .write_with(&NoFaults, |tx| {
                dohc_engine_storage::capture_file_holds::record_in(
                    tx,
                    &dohc_engine_storage::capture_file_holds::CaptureFileHold {
                        workspace_id: "workspace".into(),
                        source_version_id: "main".into(),
                        object_id: "held".into(),
                        path: "Plans".into(),
                        observed_sha256: dohc_engine_storage::hex_sha256(b"outside"),
                        observed_size: 7,
                        reason: "ydoc-resolution-not-representable".into(),
                        observed_at_ms: 1,
                        attempt_count: 1,
                        retry_requested: false,
                    },
                )
            })
            .unwrap();
        assert!(placement_is_held_in(&store, "workspace", "plans/trip.md").unwrap());
        assert!(placement_is_held_in(&store, "workspace", "PLANS").unwrap());
        assert!(!placement_is_held_in(&store, "other", "PLANS").unwrap());
        assert!(!placement_is_held_in(&store, "workspace", "planets.md").unwrap());
    }

    /// APFS stores `café` in whichever normalization it was written in and
    /// opens it under either, so a write to one must not replace a held other.
    #[test]
    fn holds_cover_every_spelling_a_disk_may_alias() {
        for (held, path) in [
            ("caf\u{e9}.md", "cafe\u{301}.md"),
            ("cafe\u{301}/plan.md", "CAF\u{c9}/plan.md"),
            ("Stra\u{df}e.md", "STRASSE.md"),
            ("notes", "Notes/a.md"),
        ] {
            assert!(path_is_held(held, path), "{held} {path}");
            let holds = PlacementHolds::from_paths(
                "workspace",
                std::collections::HashMap::from([(
                    held.to_owned(),
                    PlacementHold {
                        source_version_id: "main".into(),
                        preimage: Preimage::Absent,
                    },
                )]),
            );
            assert!(holds.blocks(path), "{held} {path}");
        }
        assert!(!path_is_held("caf\u{e9}.md", "cafe.md"));
        assert!(!path_is_held("notes", "notes.md"));
    }

    fn options_with(replacer: &dyn AtomicReplacer) -> MaterializeOptions<'_> {
        MaterializeOptions {
            holds: None,
            policy: DurabilityPolicy::none(),
            replacer,
            backoff: &NoBackoff,
            now_ms: 1,
            faults: &NoFaults,
        }
    }

    #[test]
    fn corrupt_pending_preimage_stops_the_batch_before_any_file_is_replaced() {
        let scratch = Scratch::new("corrupt-pending-preimage");
        let mut store = EngineStore::open(&scratch.db(), 1).unwrap();
        let sha = store.put_binary_blob(b"new content").unwrap();
        std::fs::write(scratch.root.join("existing.bin"), b"outside content").unwrap();
        store
            .write_with(&NoFaults, |tx| {
                for (id, path, preimage) in [
                    ("first", "new.bin", Preimage::Absent),
                    (
                        "corrupt",
                        "existing.bin",
                        Preimage::Present(hex_sha256(b"outside content")),
                    ),
                ] {
                    enqueue_job(
                        tx,
                        &MaterializationJobSpec {
                            job_id: id.into(),
                            workspace_id: "workspace".into(),
                            target_path: path.into(),
                            content_sha256: sha.clone(),
                            preimage,
                            target_generation: 1,
                            now_ms: if id == "first" { 1 } else { 2 },
                        },
                    )?;
                }
                Ok::<_, StorageError>(())
            })
            .unwrap();
        store
            .write_with(&NoFaults, |tx| {
                tx.execute(
                    "UPDATE materialization_jobs SET preimage_sha256 = NULL WHERE job_id = 'corrupt'",
                    [],
                )
                .map_err(StorageError::persist_public)
            })
            .unwrap();
        assert!(matches!(
            run_pending_jobs(&store, &scratch.root, &options_with(&StdReplacer)),
            Err(MaterializeError::Storage(StorageError::StateCorrupt { .. }))
        ));
        assert!(!scratch.root.join("new.bin").exists());
        assert_eq!(
            std::fs::read(scratch.root.join("existing.bin")).unwrap(),
            b"outside content"
        );
        assert_eq!(store.pending_materialization_count().unwrap(), 2);
        assert_eq!(
            store
                .load_materialization_job("first")
                .unwrap()
                .unwrap()
                .status,
            JobStatus::Pending
        );
    }

    #[test]
    fn corrupt_job_status_stops_the_pending_batch_before_any_file_is_replaced() {
        let scratch = Scratch::new("corrupt-pending-status");
        let mut store = EngineStore::open(&scratch.db(), 1).unwrap();
        let sha = store.put_binary_blob(b"new content").unwrap();
        let preimage_sha = store.put_binary_blob(b"outside content").unwrap();
        for path in ["first.bin", "later.bin"] {
            std::fs::write(scratch.root.join(path), b"outside content").unwrap();
        }
        store
            .write_with(&NoFaults, |tx| {
                for (id, path, now_ms) in [("first", "first.bin", 1), ("later", "later.bin", 2)] {
                    enqueue_job(
                        tx,
                        &MaterializationJobSpec {
                            job_id: id.into(),
                            workspace_id: "workspace".into(),
                            target_path: path.into(),
                            content_sha256: sha.clone(),
                            preimage: Preimage::Present(preimage_sha.clone()),
                            target_generation: 1,
                            now_ms,
                        },
                    )?;
                }
                tx.execute(
                    "UPDATE materialization_jobs SET status = 'pendng' WHERE job_id = 'later'",
                    [],
                )
                .map_err(StorageError::persist_public)?;
                Ok::<_, StorageError>(())
            })
            .unwrap();
        // Quote every raw field so the invalid status remains readable.
        let ledger = |store: &EngineStore| {
            store
                .read_with(|conn| {
                    let mut query = conn.prepare(
                        "SELECT quote(job_id), quote(workspace_id), quote(target_path), \
                         quote(content_sha256), quote(preimage_present), quote(preimage_sha256), \
                         quote(target_generation), quote(status), quote(created_at_ms), \
                         quote(completed_at_ms), quote(operation) \
                         FROM materialization_jobs ORDER BY job_id",
                    )?;
                    let rows = query.query_map([], |row| {
                        (0..11)
                            .map(|index| row.get::<_, String>(index))
                            .collect::<Result<Vec<_>, _>>()
                    })?;
                    rows.collect::<Result<Vec<_>, _>>()
                })
                .unwrap()
        };
        let before = ledger(&store);
        assert_eq!(before.len(), 2);
        assert_eq!(before[0][7], "'pending'");
        assert_eq!(before[1][7], "'pendng'");

        assert!(matches!(
            run_pending_jobs(&store, &scratch.root, &options_with(&StdReplacer)),
            Err(MaterializeError::Storage(StorageError::StateCorrupt { .. }))
        ));
        for path in ["first.bin", "later.bin"] {
            assert_eq!(
                std::fs::read(scratch.root.join(path)).unwrap(),
                b"outside content"
            );
        }
        assert_eq!(ledger(&store), before);
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

    /// EPERM is not a lock on Unix: a macOS privacy refusal does not clear
    /// while the replace waits, so it fails on the first try and keeps its
    /// OS error. On macOS it has its own code. EACCES still retries.
    #[cfg(unix)]
    #[test]
    fn replace_fails_eperm_at_once_and_names_a_macos_privacy_denial() {
        let scratch = Scratch::new("replace-eperm");
        let tmp = scratch.root.join("tmp-file");
        std::fs::write(&tmp, b"pending bytes").expect("write tmp");
        let attempt = |error: fn() -> std::io::Error| {
            let replacer = AlwaysFailReplacer {
                error,
                attempts: AtomicUsize::new(0),
            };
            let result = create_from_temp(
                &scratch.root.join("target.md"),
                &tmp,
                &options_with(&replacer),
            );
            (replacer.attempts.load(Ordering::Relaxed), result)
        };

        let (attempts, result) = attempt(|| std::io::Error::from_raw_os_error(1));
        assert_eq!(attempts, 1);
        let error = result.expect_err("EPERM fails the replace");
        assert!(matches!(
            error,
            MaterializeError::Io {
                raw_os_error: Some(1),
                ..
            }
        ));
        let eperm = if cfg!(target_os = "macos") {
            "privacy-denied"
        } else {
            "materialize-io"
        };
        assert_eq!(error.code(), eperm);

        let (attempts, result) = attempt(|| std::io::Error::from_raw_os_error(13));
        assert_eq!(attempts, MAX_REPLACE_ATTEMPTS as usize);
        assert_eq!(result.expect_err("EACCES").code(), "materialize-io");
    }

    /// A file locked in Finder, or a locked folder a new file goes into, also
    /// fails a write with EPERM. That is the file's own state, so it keeps
    /// the ordinary io code and is still not retried as a lock.
    #[cfg(target_os = "macos")]
    #[test]
    fn a_finder_lock_is_not_a_privacy_denial() {
        let chflags = |flag: &str, path: &Path| {
            let status = std::process::Command::new("chflags")
                .arg(flag)
                .arg(path)
                .status()
                .expect("chflags");
            assert!(status.success());
        };
        let scratch = Scratch::new("replace-finder-lock");
        let tmp = scratch.root.join("tmp-file");
        std::fs::write(&tmp, b"pending bytes").expect("write tmp");
        let locked_file = scratch.root.join("locked.md");
        std::fs::write(&locked_file, b"locked").expect("write locked file");
        let locked_dir = scratch.root.join("locked");
        std::fs::create_dir(&locked_dir).expect("create locked folder");
        chflags("uchg", &locked_file);
        chflags("uchg", &locked_dir);

        let replaced = std::fs::rename(&tmp, &locked_file).expect_err("a locked file refuses");
        let replaced = MaterializeError::io(&locked_file, &replaced);
        let replacer = AlwaysFailReplacer {
            error: || std::io::Error::from_raw_os_error(1),
            attempts: AtomicUsize::new(0),
        };
        let created = create_from_temp(&locked_dir.join("new.md"), &tmp, &options_with(&replacer));
        chflags("nouchg", &locked_file);
        chflags("nouchg", &locked_dir);

        assert!(matches!(
            replaced,
            MaterializeError::Io {
                raw_os_error: Some(1),
                ..
            }
        ));
        assert_eq!(replaced.code(), "materialize-io");
        assert_eq!(replacer.attempts.load(Ordering::Relaxed), 1);
        assert_eq!(created.expect_err("EPERM").code(), "materialize-io");
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

    #[test]
    fn kept_copy_names_keep_the_extension() {
        let name = |file: &str, n| kept_copy_name(file, n, MAX_KEPT_COPY_NAME_BYTES).expect("fits");
        assert_eq!(name("notes.md", 1), "notes (kept copy).md");
        assert_eq!(name("notes.md", 2), "notes (kept copy 2).md");
        assert_eq!(name("a.tar.gz", 1), "a.tar (kept copy).gz");
        assert_eq!(name(".env", 1), ".env (kept copy)");
        assert_eq!(name("Makefile", 3), "Makefile (kept copy 3)");
    }

    #[test]
    fn recovery_leaves_interrupted_kept_copy_link_for_next_save() {
        for target_exists in [false, true] {
            for known_bytes in [false, true] {
                let scratch = Scratch::new("kept-copy-interrupted-link");
                let root = std::fs::canonicalize(&scratch.root).unwrap();
                let mut store = EngineStore::open(&scratch.db(), 1).unwrap();
                enqueue_write_job(&mut store, "kept-link", "notes.md", b"job content", 1);
                let expected = store.put_binary_blob(b"preimage").unwrap();
                let staging = staging_dir(&scratch.db(), &root, true).unwrap();
                let name = staged_name("kept-link", 0);
                let kept = staging.join(&name);
                let bytes: &[u8] = if known_bytes {
                    b"preimage"
                } else {
                    b"outside edit"
                };
                std::fs::write(&kept, bytes).unwrap();
                let id = store
                    .open_displacement(&DisplacementSpec {
                        job_id: "kept-link".into(),
                        workspace_id: "ws".into(),
                        target_path: "notes.md".into(),
                        displaced_name: name,
                        expected_sha256: expected,
                        content_sha256: Some(hex_sha256(b"job content")),
                        now_ms: 1,
                    })
                    .unwrap();
                // The earlier inspection could not read the staged bytes.
                store
                    .resolve_displacement(
                        id,
                        DisplacementResolution::Keep {
                            displaced_sha256: None,
                        },
                        None,
                        1,
                    )
                    .unwrap();
                let target = root.join("notes.md");
                if target_exists {
                    std::fs::write(&target, b"job content").unwrap();
                }
                let copy = root.join("notes (kept copy).md");
                // Save claimed the visible name but stopped before unlinking staging.
                std::fs::hard_link(&kept, &copy).unwrap();
                let rows = store.list_kept_displacements("ws").unwrap();
                let options = options_with(&StdReplacer);
                for _ in 0..2 {
                    recover_displacements(&store, &root, Some("ws"), &options).unwrap();
                    assert!(kept.exists(), "recovery must leave Save's staging link");
                    assert!(is_same_file(&kept, &copy).unwrap());
                    assert_eq!(store.list_kept_displacements("ws").unwrap(), rows);
                    assert_eq!(target.exists(), target_exists);
                    if target_exists {
                        assert_eq!(std::fs::read(&target).unwrap(), b"job content");
                    }
                }
                assert_eq!(
                    save_kept_displacement(&store, &root, "ws", id, &options).unwrap(),
                    KeptCopySave::Saved("notes (kept copy).md".into())
                );
                assert!(!kept.exists());
                assert!(store.list_kept_displacements("ws").unwrap().is_empty());
                assert_eq!(std::fs::read(&copy).unwrap(), bytes);
                std::fs::write(&target, b"later original edit").unwrap();
                assert_eq!(std::fs::read(&copy).unwrap(), bytes);
                std::fs::write(&copy, b"later copy edit").unwrap();
                assert_eq!(std::fs::read(&target).unwrap(), b"later original edit");
            }
        }
    }

    /// A name near its budget gives up stem bytes, never its extension or
    /// suffix, and never splits a character. With no stem byte left, there is
    /// no name.
    #[test]
    fn kept_copy_names_fit_their_budget() {
        let long = format!("{}.md", "a".repeat(252));
        let copy = kept_copy_name(&long, 12, MAX_KEPT_COPY_NAME_BYTES).expect("fits");
        assert_eq!(copy.len(), MAX_KEPT_COPY_NAME_BYTES);
        assert!(copy.ends_with("a (kept copy 12).md"), "{copy}");

        let wide = format!("{}.md", "é".repeat(126));
        let copy = kept_copy_name(&wide, 1, MAX_KEPT_COPY_NAME_BYTES).expect("fits");
        assert!(copy.len() <= MAX_KEPT_COPY_NAME_BYTES, "{}", copy.len());
        assert!(copy.ends_with("é (kept copy).md"), "{copy}");

        let dotted = format!("a.{}", "b".repeat(253));
        let copy = kept_copy_name(&dotted, 1, MAX_KEPT_COPY_NAME_BYTES).expect("fits");
        assert_eq!(copy.len(), MAX_KEPT_COPY_NAME_BYTES);
        assert!(
            copy.starts_with("a.b") && copy.ends_with("b (kept copy)"),
            "{copy}"
        );

        assert_eq!(
            kept_copy_name("notes.md", 1, 17).as_deref(),
            Some("no (kept copy).md")
        );
        assert_eq!(
            kept_copy_name("notes.md", 1, 15).as_deref(),
            Some("not (kept copy)")
        );
        assert_eq!(kept_copy_name("notes.md", 1, 12), None);
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

    #[cfg(any(
        windows,
        target_os = "linux",
        target_os = "android",
        target_vendor = "apple"
    ))]
    #[test]
    fn visible_file_move_refuses_an_occupied_destination_and_renames_an_empty_one() {
        let scratch = Scratch::new("visible-file-move");
        let source = scratch.root.join("source.bin");
        let target = scratch.root.join("target.bin");
        std::fs::write(&source, vec![7_u8; 4 * 1024 * 1024]).expect("source");
        std::fs::write(&target, b"theirs").expect("target");
        assert_eq!(
            move_file_no_replace(&source, &target)
                .expect_err("occupied")
                .kind(),
            ErrorKind::AlreadyExists
        );
        assert_eq!(std::fs::read(&target).expect("target bytes"), b"theirs");
        assert!(source.exists());
        std::fs::remove_file(&target).expect("remove target");
        move_file_no_replace(&source, &target).expect("empty target");
        assert!(!source.exists());
        assert_eq!(
            std::fs::metadata(&target).expect("target").len(),
            4 * 1024 * 1024
        );
    }

    #[cfg(any(target_os = "linux", target_os = "android", target_vendor = "apple"))]
    #[test]
    fn visible_file_move_reports_unsupported_exclusive_rename() {
        use rustix::io::Errno;
        for err in [Errno::INVAL, Errno::NOSYS, Errno::NOTSUP, Errno::OPNOTSUPP] {
            assert_eq!(
                exclusive_move_result(Err(err))
                    .expect_err("unsupported rename")
                    .kind(),
                ErrorKind::Unsupported
            );
        }
        for err in [Errno::EXIST, Errno::ACCESS, Errno::XDEV] {
            assert_eq!(
                exclusive_move_result(Err(err))
                    .expect_err("rename refusal")
                    .raw_os_error(),
                Some(err.raw_os_error())
            );
        }
    }

    #[cfg(windows)]
    #[test]
    fn visible_file_move_rejects_null_paths_without_touching_files() {
        let scratch = Scratch::new("visible-file-move-null");
        let source = scratch.root.join("source.bin");
        let target = scratch.root.join("target.bin");
        std::fs::write(&source, b"mine").expect("source");
        for (from, to) in [
            (source.clone(), scratch.root.join("target.bin\0other")),
            (scratch.root.join("source.bin\0other"), target.clone()),
        ] {
            assert_eq!(
                move_file_no_replace(&from, &to)
                    .expect_err("null path")
                    .kind(),
                ErrorKind::InvalidInput
            );
        }
        assert_eq!(std::fs::read(&source).expect("source"), b"mine");
        assert!(!target.exists());
    }

    #[cfg(windows)]
    #[test]
    fn visible_file_move_preserves_windows_readonly_attribute() {
        let scratch = Scratch::new("visible-file-move-attributes");
        let source = scratch.root.join("source.bin");
        let target = scratch.root.join("target.bin");
        std::fs::write(&source, b"mine").expect("source");
        let original = std::fs::metadata(&source).expect("metadata").permissions();
        let mut readonly = original.clone();
        readonly.set_readonly(true);
        std::fs::set_permissions(&source, readonly).expect("readonly");
        move_file_no_replace(&source, &target).expect("move readonly file");
        assert!(
            std::fs::metadata(&target)
                .expect("metadata")
                .permissions()
                .readonly()
        );
        std::fs::set_permissions(&target, original).expect("cleanup attributes");
    }

    #[cfg(windows)]
    #[test]
    fn windows_readonly_unlink_fallback_restores_attributes_on_success_and_failure() {
        use std::os::windows::fs::MetadataExt;
        for fail in [true, false] {
            let scratch = Scratch::new("readonly-unlink");
            let root = std::fs::canonicalize(&scratch.root).unwrap();
            let incoming = staging_dir(&scratch.db(), &root, true)
                .unwrap()
                .join("staged.md");
            let target = root.join("target.md");
            std::fs::write(&incoming, b"outside").unwrap();
            let mut permissions = std::fs::metadata(&incoming).unwrap().permissions();
            permissions.set_readonly(true);
            std::fs::set_permissions(&incoming, permissions).unwrap();
            let attrs = std::fs::metadata(&incoming).unwrap().file_attributes();
            std::fs::hard_link(&incoming, &target).unwrap();
            let result = readonly_link::remove(&incoming, &target, || {
                assert!(!std::fs::metadata(&incoming)?.permissions().readonly());
                if fail {
                    Err(std::io::Error::from_raw_os_error(32))
                } else {
                    std::fs::remove_file(&incoming)
                }
            });
            assert_eq!(result.is_err(), fail);
            assert_eq!(incoming.exists(), fail);
            assert_eq!(std::fs::metadata(&target).unwrap().file_attributes(), attrs);
            assert_eq!(std::fs::read(&target).unwrap(), b"outside");
        }
    }

    #[cfg(windows)]
    #[test]
    fn windows_unsupported_hard_links_create_overwrite_and_return() {
        struct UnsupportedLinks(fn() -> std::io::Error);
        impl AtomicReplacer for UnsupportedLinks {
            fn place(&self, incoming: &Path, target: &Path) -> std::io::Result<Placement> {
                place_with_hard_link(
                    incoming,
                    target,
                    || Err((self.0)()),
                    || std::fs::remove_file(incoming),
                )
            }
        }
        for error in [
            (|| std::io::Error::from_raw_os_error(50)) as fn() -> std::io::Error,
            || std::io::Error::from_raw_os_error(1),
            || std::io::Error::from(ErrorKind::Unsupported),
        ] {
            let replacer = UnsupportedLinks(error);
            let scratch = Scratch::new("unsupported-links-text");
            let mut store = EngineStore::open(&scratch.db(), 1).unwrap();
            let sha = hex_sha256(b"authored text");
            store.write_with(&NoFaults, |tx| {
                tx.execute("INSERT INTO blobs (sha256, byte_length, text) VALUES (?1, 13, 'authored text')", [&sha]).map_err(StorageError::persist_public)?;
                enqueue_job(tx, &MaterializationJobSpec { job_id: "authored-text".into(), workspace_id: "workspace".into(), target_path: "authored.txt".into(), content_sha256: sha.clone(), preimage: Preimage::Absent, target_generation: 1, now_ms: 1 })
            }).unwrap();
            let job = store
                .load_materialization_job("authored-text")
                .unwrap()
                .unwrap();
            assert_eq!(
                materialize_one(&store, &scratch.root, &job, &options_with(&replacer)).unwrap(),
                JobOutcome::Completed
            );
            assert_eq!(
                std::fs::read(scratch.root.join("authored.txt")).unwrap(),
                b"authored text"
            );
            assert_eq!(store.binary_blob_count().unwrap(), 0);
            for overwrite in [false, true] {
                let scratch = Scratch::new("unsupported-links");
                let mut store = EngineStore::open(&scratch.db(), 1).unwrap();
                enqueue_write_job(&mut store, "write", "notes.md", b"new", 1);
                let mut job = store.load_materialization_job("write").unwrap().unwrap();
                let target = scratch.root.join("notes.md");
                if overwrite {
                    std::fs::write(&target, b"old").unwrap();
                    job.preimage = Preimage::Present(store.put_binary_blob(b"old").unwrap());
                }
                assert_eq!(
                    materialize_one(&store, &scratch.root, &job, &options_with(&replacer)).unwrap(),
                    JobOutcome::Completed
                );
                assert_eq!(std::fs::read(&target).unwrap(), b"new");
                assert!(store.list_unsettled_displacements().unwrap().is_empty());
                assert!(!workspace_lacks_atomic_placement(&scratch.root));
            }
            let scratch = Scratch::new("unsupported-return");
            let store = EngineStore::open(&scratch.db(), 1).unwrap();
            let root = std::fs::canonicalize(&scratch.root).unwrap();
            let staged = root.join("staged.md");
            let target = root.join("notes.md");
            std::fs::write(&staged, b"outside").unwrap();
            let mut permissions = std::fs::metadata(&staged).unwrap().permissions();
            permissions.set_readonly(true);
            std::fs::set_permissions(&staged, permissions).unwrap();
            assert!(return_displaced(&store, &target, &staged, &options_with(&replacer)).unwrap());
            assert!(!staged.exists());
            assert_eq!(std::fs::read(&target).unwrap(), b"outside");
            assert!(std::fs::metadata(&target).unwrap().permissions().readonly());
            assert!(!workspace_lacks_atomic_placement(&scratch.root));
            std::fs::write(&staged, b"another file").unwrap();
            assert!(!return_displaced(&store, &target, &staged, &options_with(&replacer)).unwrap());
            assert_eq!(std::fs::read(&target).unwrap(), b"outside");
            assert_eq!(std::fs::read(&staged).unwrap(), b"another file");
        }
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
        let placed = place_with_hard_link(
            &incoming,
            &target,
            || std::fs::hard_link(&incoming, &target),
            || {
                assert_eq!(std::fs::metadata(&target)?.file_attributes(), attributes);
                Err(std::io::Error::from(ErrorKind::Interrupted))
            },
        )
        .expect_err("unlink failure must be retried");
        assert_eq!(placed.kind(), ErrorKind::Interrupted);
        for path in [&incoming, &target] {
            assert_eq!(std::fs::read(path).unwrap(), b"outside bytes");
            assert_eq!(
                std::fs::metadata(path).unwrap().file_attributes(),
                attributes
            );
        }
        rename_no_replace(&incoming, &target).expect("retry finishes the unlink");
        assert!(!incoming.exists());
        assert_eq!(
            std::fs::metadata(&target).unwrap().file_attributes(),
            attributes
        );
        std::fs::set_permissions(&target, original_permissions).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn windows_crash_after_staging_unlink_keeps_live_attributes() {
        use std::os::windows::fs::MetadataExt;
        let scratch = Scratch::new("readonly-native-crash");
        let incoming = scratch.root.join("staged.md");
        let target = scratch.root.join("target.md");
        std::fs::write(&incoming, b"outside").unwrap();
        let mut permissions = std::fs::metadata(&incoming).unwrap().permissions();
        permissions.set_readonly(true);
        std::fs::set_permissions(&incoming, permissions).unwrap();
        let attributes = std::fs::metadata(&incoming).unwrap().file_attributes();
        let result = place_with_hard_link(
            &incoming,
            &target,
            || std::fs::hard_link(&incoming, &target),
            || {
                remove_placement_link(&incoming, &target)?;
                // Stop after the native unlink, before placement reports success.
                Err(std::io::Error::from(ErrorKind::Interrupted))
            },
        );
        assert_eq!(result.unwrap_err().kind(), ErrorKind::Interrupted);
        assert!(!incoming.exists());
        assert_eq!(
            std::fs::metadata(&target).unwrap().file_attributes(),
            attributes
        );
        assert_eq!(std::fs::read(&target).unwrap(), b"outside");
    }

    #[cfg(windows)]
    #[test]
    fn windows_readonly_fallback_crash_recovers_without_staged_file_or_job() {
        use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
        for unlink in [false, true] {
            let scratch = Scratch::new("readonly-fallback-crash");
            let root = std::fs::canonicalize(&scratch.root).unwrap();
            let incoming = staging_dir(&scratch.db(), &root, true)
                .unwrap()
                .join("staged.md");
            let target = root.join("target.md");
            let store = EngineStore::open(&scratch.db(), 1).unwrap();
            drop(store);
            drop(
                std::fs::OpenOptions::new()
                    .create_new(true)
                    .write(true)
                    .attributes(0x2 | 0x20)
                    .open(&incoming)
                    .unwrap(),
            );
            std::fs::write(&incoming, b"outside").unwrap();
            let mut permissions = std::fs::metadata(&incoming).unwrap().permissions();
            permissions.set_readonly(true);
            std::fs::set_permissions(&incoming, permissions).unwrap();
            let attributes = std::fs::metadata(&incoming).unwrap().file_attributes();
            std::fs::hard_link(&incoming, &target).unwrap();
            assert!(
                std::panic::catch_unwind(|| {
                    let _ = readonly_link::remove(&incoming, &target, || {
                        assert!(!std::fs::metadata(&target)?.permissions().readonly());
                        if unlink {
                            std::fs::remove_file(&incoming)?;
                        }
                        panic!("crash before attribute restoration");
                    });
                })
                .is_err()
            );
            assert_eq!(incoming.exists(), !unlink);
            let store = EngineStore::open(&scratch.db(), 2).unwrap();
            // Failed recovery must retain the durable word for a later retry.
            let lock = std::fs::OpenOptions::new()
                .read(true)
                .share_mode(0)
                .open(incoming.with_extension("md.restore-attributes"))
                .unwrap();
            recover_displacements(&store, &root, None, &options_with(&StdReplacer)).unwrap();
            assert!(workspace_recovery_unavailable(&root));
            drop(lock);
            recover_displacements(&store, &root, None, &options_with(&StdReplacer)).unwrap();
            assert!(!workspace_recovery_unavailable(&root));
            assert_eq!(
                std::fs::metadata(&target).unwrap().file_attributes(),
                attributes
            );
            assert_eq!(std::fs::read(&target).unwrap(), b"outside");
            if !unlink {
                rename_no_replace(&incoming, &target).unwrap();
            }
            assert_eq!(
                std::fs::read_dir(root.join(STAGING_DIR)).unwrap().count(),
                0
            );
            assert_eq!(
                std::fs::metadata(&target).unwrap().file_attributes(),
                attributes
            );
        }
    }

    #[cfg(windows)]
    #[test]
    fn selected_job_recovers_readonly_journal_with_resolved_folder_case() {
        use std::os::windows::fs::MetadataExt;

        let scratch = Scratch::new("readonly-folder-case");
        let root = std::fs::canonicalize(&scratch.root).unwrap();
        std::fs::create_dir(root.join("Notes")).unwrap();
        let target = root.join("Notes/a.md");
        let mut store = EngineStore::open(&scratch.db(), 1).unwrap();
        let sha = store.put_binary_blob(b"outside").unwrap();
        store
            .write_with(&NoFaults, |tx| {
                enqueue_job(
                    tx,
                    &MaterializationJobSpec {
                        job_id: "folder-case".into(),
                        workspace_id: "ws".into(),
                        target_path: "notes/a.md".into(),
                        content_sha256: sha.clone(),
                        preimage: Preimage::Present(sha.clone()),
                        target_generation: 1,
                        now_ms: 1,
                    },
                )
            })
            .unwrap();
        let job = store
            .load_materialization_job("folder-case")
            .unwrap()
            .unwrap();
        let incoming = staging_dir(&scratch.db(), &root, true)
            .unwrap()
            .join(staged_name(&job.job_id, 0));
        std::fs::write(&incoming, b"outside").unwrap();
        let mut permissions = std::fs::metadata(&incoming).unwrap().permissions();
        permissions.set_readonly(true);
        std::fs::set_permissions(&incoming, permissions).unwrap();
        let attributes = std::fs::metadata(&incoming).unwrap().file_attributes();
        std::fs::hard_link(&incoming, &target).unwrap();
        assert!(
            std::panic::catch_unwind(|| {
                let _ = readonly_link::remove(&incoming, &target, || {
                    std::fs::remove_file(&incoming)?;
                    panic!("crash before attribute restoration");
                });
            })
            .is_err()
        );
        assert!(!incoming.exists());
        assert!(!std::fs::metadata(&target).unwrap().permissions().readonly());

        // Exercise selected placement without the workspace-wide journal sweep.
        materialize_one(&store, &root, &job, &options_with(&StdReplacer)).unwrap();
        assert_eq!(
            std::fs::metadata(&target).unwrap().file_attributes(),
            attributes
        );
        assert_eq!(std::fs::read(&target).unwrap(), b"outside");
        assert_eq!(store.pending_materialization_count().unwrap(), 0);
        assert!(!incoming.with_extension("0.restore-attributes").exists());
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

    #[cfg(windows)]
    #[test]
    fn conflicting_case_alias_publication_returns_the_outside_spelling() {
        struct EditOnDisplace(AtomicUsize);
        impl AtomicReplacer for EditOnDisplace {
            fn displace(&self, target: &Path, displaced: &Path) -> std::io::Result<()> {
                if self.0.fetch_add(1, Ordering::Relaxed) == 0 {
                    std::fs::write(target, b"outside edit")?;
                }
                std::fs::rename(target, displaced)
            }
        }
        for crash in [false, true] {
            let scratch = Scratch::new("conflict-leaf-case");
            let root = scratch.root.path();
            std::fs::write(root.join("held.md"), b"before").unwrap();
            if !root.join("HELD.MD").exists() {
                continue;
            }
            let (_db, mut store) = flush_store();
            let before = store.put_binary_blob(b"before").unwrap();
            let content = store.put_binary_blob(b"intended").unwrap();
            store
                .write_with(&NoFaults, |tx| {
                    enqueue_job(
                        tx,
                        &MaterializationJobSpec {
                            job_id: "alias-conflict".into(),
                            workspace_id: "ws".into(),
                            target_path: "HELD.MD".into(),
                            content_sha256: content,
                            preimage: Preimage::Present(before),
                            target_generation: 1,
                            now_ms: 1,
                        },
                    )
                })
                .unwrap();
            let job = store
                .load_materialization_job("alias-conflict")
                .unwrap()
                .unwrap();
            struct CrashAfterJournal;
            impl FaultInjector for CrashAfterJournal {
                fn poll(&self, point: FaultPoint) -> FaultAction {
                    if point == FaultPoint::MaterializeAfterDisplacementJournal {
                        FaultAction::Crash
                    } else {
                        FaultAction::Continue
                    }
                }
            }
            let faults = CrashAfterJournal;
            let replacer = EditOnDisplace(AtomicUsize::new(0));
            let mut options = options_with(&replacer);
            if crash {
                options.faults = &faults;
            }
            let outcome = materialize_one(&store, root, &job, &options).unwrap();
            if crash {
                assert_eq!(
                    outcome,
                    JobOutcome::Crashed(FaultPoint::MaterializeAfterDisplacementJournal)
                );
                recover_displacements(&store, root, None, &options_with(&StdReplacer)).unwrap();
            } else {
                assert_eq!(outcome, JobOutcome::Conflict);
            }
            assert_eq!(
                dohc_windows_files::stored_leaf_name(&root.join("held.md")).unwrap(),
                "held.md"
            );
            assert_eq!(
                std::fs::read(root.join("held.md")).unwrap(),
                b"outside edit"
            );
            assert_eq!(
                std::fs::read(conflict_sibling(&root.join("HELD.MD"), "alias-conflict")).unwrap(),
                b"intended"
            );
        }
    }

    #[cfg(windows)]
    #[test]
    fn ordinary_publication_keeps_the_requested_leaf_case_even_with_equal_bytes() {
        for desired in [b"Before.\n".as_slice(), b"After.\n".as_slice()] {
            let scratch = Scratch::new("publication-leaf-case");
            let root = scratch.root.path();
            std::fs::write(root.join("held.md"), b"Before.\n").unwrap();
            if !root.join("HELD.MD").exists() {
                continue;
            }
            let (_db, mut store) = flush_store();
            let before = store.put_binary_blob(b"Before.\n").unwrap();
            let content = store.put_binary_blob(desired).unwrap();
            store
                .write_with(&NoFaults, |tx| {
                    enqueue_job(
                        tx,
                        &MaterializationJobSpec {
                            job_id: "leaf-case".into(),
                            workspace_id: "ws".into(),
                            target_path: "HELD.MD".into(),
                            content_sha256: content,
                            preimage: Preimage::Present(before),
                            target_generation: 1,
                            now_ms: 1,
                        },
                    )
                })
                .unwrap();
            let job = store
                .load_materialization_job("leaf-case")
                .unwrap()
                .unwrap();
            assert_eq!(
                materialize_one(&store, root, &job, &options_with(&StdReplacer)).unwrap(),
                JobOutcome::Completed
            );
            assert_eq!(
                dohc_windows_files::stored_leaf_name(&root.join("HELD.MD")).unwrap(),
                "HELD.MD"
            );
            assert_eq!(std::fs::read(root.join("HELD.MD")).unwrap(), desired);
            assert!(!crate::stored_under_other_spelling(root, "HELD.MD"));
        }
    }

    fn capture_file_hold_fixture(store: &mut EngineStore, outside: &[u8]) {
        store.write_with(&NoFaults, |tx| {
            // The fixture supplies the durable hold contract on the old build
            // too, so the base failure exercises placement, not missing DDL.
            tx.execute_batch("CREATE TABLE IF NOT EXISTS capture_file_holds (workspace_id TEXT NOT NULL, source_version_id TEXT NOT NULL, object_id TEXT NOT NULL, path TEXT NOT NULL, observed_sha256 TEXT NOT NULL, observed_size INTEGER NOT NULL, reason TEXT NOT NULL, observed_at_ms INTEGER NOT NULL, attempt_count INTEGER NOT NULL, retry_requested INTEGER NOT NULL, PRIMARY KEY(workspace_id,path)); INSERT OR IGNORE INTO versioned_workspaces VALUES ('ws','main'); INSERT OR IGNORE INTO versions(workspace_id,version_id,kind,name,created_at_ms) VALUES ('ws','main','main','Main',1); INSERT OR IGNORE INTO file_objects VALUES ('ws','held-object',1);").map_err(StorageError::persist_public)?;
            tx.execute("INSERT INTO capture_file_holds VALUES ('ws','main','held-object','held.md',?1,?2,'ydoc-resolution-not-representable',1,1,0)", (hex_sha256(outside), outside.len() as i64)).map_err(StorageError::persist_public)?;
            Ok::<_, StorageError>(())
        }).unwrap();
    }

    fn capture_hold_parks_job(operation: MaterializationOperation, path: &str, secret: bool) {
        let scratch = Scratch::new("capture-hold-job");
        let root = scratch.root.path().to_path_buf();
        let outside = format!("{} too deep\n", "> ".repeat(121));
        std::fs::write(root.join("held.md"), &outside).unwrap();
        if path != "held.md" && !root.join(path).exists() {
            return;
        }
        let mut store = EngineStore::open(&scratch.db(), 1).unwrap();
        capture_file_hold_fixture(&mut store, outside.as_bytes());
        let sha = store.put_binary_blob(b"Canonical.\n").unwrap();
        // A known preimage would normally authorize replacement, including a
        // remote job whose blob happens to equal the outside observation.
        store.put_binary_blob(outside.as_bytes()).unwrap();
        store
            .write_with(&NoFaults, |tx| {
                let spec = MaterializationJobSpec {
                    job_id: "held-job".into(),
                    workspace_id: "ws".into(),
                    target_path: path.into(),
                    content_sha256: sha,
                    preimage: Preimage::Present(hex_sha256(outside.as_bytes())),
                    target_generation: 1,
                    now_ms: 1,
                };
                match operation {
                    MaterializationOperation::Write => enqueue_job(tx, &spec),
                    MaterializationOperation::Delete => {
                        dohc_engine_storage::enqueue_delete_job(tx, &spec)
                    }
                }
            })
            .unwrap();
        let job = store.load_materialization_job("held-job").unwrap().unwrap();
        let result = if secret {
            match operation {
                MaterializationOperation::Write => materialize_secret_one(
                    &store,
                    &root,
                    &job,
                    b"Canonical.\n",
                    &options_with(&StdReplacer),
                ),
                MaterializationOperation::Delete => {
                    materialize_secret_delete_one(&store, &root, &job, &options_with(&StdReplacer))
                }
            }
        } else {
            materialize_one(&store, &root, &job, &options_with(&StdReplacer))
        }
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(root.join("held.md")).unwrap(),
            outside
        );
        assert_eq!(format!("{result:?}"), "Parked");
        assert_eq!(
            store
                .load_materialization_job("held-job")
                .unwrap()
                .unwrap()
                .status,
            JobStatus::Pending
        );
    }

    #[test]
    fn capture_file_hold_parks_sync_and_settlement_writes() {
        capture_hold_parks_job(MaterializationOperation::Write, "held.md", false);
    }

    #[test]
    fn capture_file_hold_parks_rollback_deletes() {
        capture_hold_parks_job(MaterializationOperation::Delete, "held.md", false);
    }

    #[test]
    fn capture_file_hold_parks_secret_writes_and_deletes() {
        for operation in [
            MaterializationOperation::Write,
            MaterializationOperation::Delete,
        ] {
            capture_hold_parks_job(operation, "held.md", true);
        }
    }

    #[test]
    fn capture_file_hold_parks_case_alias_placements() {
        capture_hold_parks_job(MaterializationOperation::Write, "HELD.MD", false);
    }

    fn capture_hold_parks_displacement(journaled: bool, path: &str) {
        let scratch = Scratch::new("capture-hold-recovery");
        let root = scratch.root.path().to_path_buf();
        let outside = format!("{} too deep\n", "> ".repeat(121));
        let previous = b"Unknown bytes from before a crash.\n";
        std::fs::write(root.join("held.md"), &outside).unwrap();
        if path != "held.md" && !root.join(path).exists() {
            return;
        }
        let mut store = EngineStore::open(&scratch.db(), 1).unwrap();
        capture_file_hold_fixture(&mut store, outside.as_bytes());
        enqueue_write_job(&mut store, "held-recovery", path, outside.as_bytes(), 1);
        let staging = staging_dir(&scratch.db(), &root, true).unwrap();
        let name = staged_name("held-recovery", 0);
        std::fs::write(staging.join(&name), previous).unwrap();
        if journaled {
            store
                .open_displacement(&DisplacementSpec {
                    job_id: "held-recovery".into(),
                    workspace_id: "ws".into(),
                    target_path: path.into(),
                    displaced_name: name.clone(),
                    expected_sha256: hex_sha256(previous),
                    content_sha256: Some(hex_sha256(outside.as_bytes())),
                    now_ms: 1,
                })
                .unwrap();
        }
        recover_displacements(&store, &root, Some("ws"), &options_with(&StdReplacer)).unwrap();
        assert_eq!(
            std::fs::read_to_string(root.join("held.md")).unwrap(),
            outside
        );
        assert_eq!(std::fs::read(staging.join(name)).unwrap(), previous);
        assert_eq!(
            store
                .load_materialization_job("held-recovery")
                .unwrap()
                .unwrap()
                .status,
            JobStatus::Pending
        );
    }

    #[test]
    fn capture_file_hold_parks_journaled_displacement_sweep() {
        capture_hold_parks_displacement(true, "held.md");
    }

    #[test]
    fn capture_file_hold_parks_rowless_recovery_materialization() {
        capture_hold_parks_displacement(false, "held.md");
    }

    #[test]
    fn capture_file_hold_parks_case_alias_recovery_sweep() {
        capture_hold_parks_displacement(true, "HELD.MD");
        capture_hold_parks_displacement(false, "HELD.MD");
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
    fn disk_targets_reject_colon_segments() {
        let scratch = Scratch::new("colon-segments");
        for path in ["x.md:evil", "notes/x:evil.md"] {
            assert!(matches!(
                resolve_target(&scratch.root, path),
                Err(MaterializeError::UnsafeTargetPath)
            ));
        }
    }

    #[cfg(windows)]
    #[test]
    fn tracked_short_name_still_writes_probes_and_deletes() {
        let scratch = Scratch::new("tracked-short-name");
        let path = "draft~2.md";
        assert_eq!(
            crate::policy::classify_engine_file_path(path),
            crate::policy::PathClassification::Tracked
        );
        std::fs::write(scratch.root.join(path), b"old\n").unwrap();
        let mut store = EngineStore::open(&scratch.db(), 1).unwrap();
        let original = store.put_binary_blob(b"old\n").unwrap();
        let updated = store.put_binary_blob(b"new\n").unwrap();
        store
            .write_with(&NoFaults, |tx| {
                enqueue_job(
                    tx,
                    &MaterializationJobSpec {
                        job_id: "short-write".into(),
                        workspace_id: "ws".into(),
                        target_path: path.into(),
                        content_sha256: updated.clone(),
                        preimage: Preimage::Present(original.clone()),
                        target_generation: 1,
                        now_ms: 1,
                    },
                )
            })
            .unwrap();
        let write = store
            .load_materialization_job("short-write")
            .unwrap()
            .unwrap();
        assert_eq!(
            materialize_one(&store, &scratch.root, &write, &options_with(&StdReplacer)).unwrap(),
            JobOutcome::Completed
        );
        assert_eq!(std::fs::read(scratch.root.join(path)).unwrap(), b"new\n");
        assert_eq!(
            probe_projection_target(&scratch.root, path, ProjectionTargetKind::Plaintext),
            ProjectionTargetState::Text {
                sha256: updated.clone()
            }
        );
        assert!(matches!(
            projection_target_stamp(&scratch.root, path),
            ProjectionTargetStamp::File { byte_length: 4, .. }
        ));
        store
            .write_with(&NoFaults, |tx| {
                dohc_engine_storage::enqueue_delete_job(
                    tx,
                    &MaterializationJobSpec {
                        job_id: "short-delete".into(),
                        workspace_id: "ws".into(),
                        target_path: path.into(),
                        content_sha256: updated.clone(),
                        preimage: Preimage::Present(updated.clone()),
                        target_generation: 2,
                        now_ms: 2,
                    },
                )
            })
            .unwrap();
        let delete = store
            .load_materialization_job("short-delete")
            .unwrap()
            .unwrap();
        assert_eq!(
            materialize_one(&store, &scratch.root, &delete, &options_with(&StdReplacer)).unwrap(),
            JobOutcome::Completed
        );
        assert!(!scratch.root.join(path).exists());
        assert_eq!(
            projection_target_stamp(&scratch.root, path),
            ProjectionTargetStamp::Absent
        );
    }

    #[test]
    fn pending_respelled_delete_matches_only_the_targets_entry_and_preimage() {
        let scratch = Scratch::new("pending-respelled-delete");
        let root = std::fs::canonicalize(&scratch.root).unwrap();
        std::fs::write(root.join("notes.md"), b"notes").unwrap();
        let mut store = EngineStore::open(&scratch.db(), 1).unwrap();
        let sha = store.put_binary_blob(b"notes").unwrap();
        enqueue_write_job(&mut store, "write", "Notes.md", b"notes", 2);
        store
            .write_with(&NoFaults, |tx| {
                dohc_engine_storage::enqueue_delete_job(
                    tx,
                    &MaterializationJobSpec {
                        job_id: "merge-mat_notes".into(),
                        workspace_id: "ws".into(),
                        target_path: "notes.md".into(),
                        content_sha256: sha.clone(),
                        preimage: Preimage::Present(sha.clone()),
                        target_generation: 1,
                        now_ms: 1,
                    },
                )
            })
            .unwrap();
        let write = store.load_materialization_job("write").unwrap().unwrap();
        let target = root.join("Notes.md");
        let ignores_case = target.exists();
        if !ignores_case {
            std::fs::hard_link(root.join("notes.md"), &target).unwrap();
        }
        assert_eq!(
            pending_respelled_delete(&store, &root, &target, &write, &sha)
                .unwrap()
                .is_some(),
            ignores_case,
            "known separate directory entries do not order each other's deletes"
        );
        assert!(
            pending_respelled_delete(&store, &root, &target, &write, &hex_sha256(b"other"))
                .unwrap()
                .is_none()
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let permissions = std::fs::metadata(&root).unwrap().permissions();
            std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o311)).unwrap();
            let unlistable = std::fs::read_dir(&root).is_err();
            let pending = pending_respelled_delete(&store, &root, &target, &write, &sha);
            std::fs::set_permissions(&root, permissions).unwrap();
            if !unlistable {
                eprintln!("SKIP: this user can list the folder");
                return;
            }
            assert_eq!(
                pending.unwrap().is_some(),
                ignores_case || !cfg!(target_os = "macos")
            );
        }
    }

    /// A merge's pending delete through a link reaches the file a create
    /// targets, but would refuse to run. The create must not wait for it.
    #[cfg(unix)]
    #[test]
    fn a_pending_delete_through_a_link_never_holds_back_a_create() {
        let scratch = Scratch::new("respelled-delete-link");
        std::fs::write(scratch.root.join("notes.md"), b"notes").unwrap();
        std::os::unix::fs::symlink("notes.md", scratch.root.join("alias.md")).unwrap();
        let mut store = EngineStore::open(&scratch.db(), 1).unwrap();
        let sha = store.put_binary_blob(b"notes").unwrap();
        let spec = |job_id: &str, target_path: &str, preimage| MaterializationJobSpec {
            job_id: job_id.into(),
            workspace_id: "ws".into(),
            target_path: target_path.into(),
            content_sha256: sha.clone(),
            preimage,
            target_generation: 1,
            now_ms: 1,
        };
        let delete = spec(
            "merge-mat_alias",
            "alias.md",
            Preimage::Present(sha.clone()),
        );
        let write = spec("merge-mat_notes", "notes.md", Preimage::Absent);
        store
            .write_with(&NoFaults, |tx| {
                dohc_engine_storage::enqueue_delete_job(tx, &delete)?;
                enqueue_job(tx, &write)
            })
            .unwrap();
        let write = store
            .load_materialization_job("merge-mat_notes")
            .unwrap()
            .unwrap();
        assert_eq!(
            materialize_one(&store, &scratch.root, &write, &options_with(&StdReplacer)).unwrap(),
            JobOutcome::AlreadyMaterialized
        );
        let delete = store.load_materialization_job("merge-mat_alias").unwrap();
        assert_eq!(delete.unwrap().status, JobStatus::Pending);
        let link = std::fs::symlink_metadata(scratch.root.join("alias.md")).unwrap();
        assert!(link.file_type().is_symlink());
    }

    #[test]
    fn fullwidth_names_remain_writable() {
        let scratch = Scratch::new("fullwidth");
        let root = std::fs::canonicalize(&scratch.root).unwrap();
        let directory = root.join(".ＤＯＨＣ");
        std::fs::create_dir(&directory).unwrap();
        let target = resolve_target(&root, ".ＤＯＨＣ/notes.md").unwrap();
        std::fs::write(&target, b"ordinary content").unwrap();
        assert_eq!(
            std::fs::read(directory.join("notes.md")).unwrap(),
            b"ordinary content"
        );
    }

    #[test]
    fn file_suffix_exclusions_do_not_exclude_ordinary_directories() {
        let scratch = Scratch::new("ordinary-ancestor");
        let root = std::fs::canonicalize(&scratch.root).unwrap();
        for name in ["notes.conflict", "ledger.db-wal"] {
            std::fs::create_dir(root.join(name)).unwrap();
            assert!(resolve_target(&root, &format!("{name}/readme.md")).is_ok());
        }
    }

    #[test]
    fn resolves_existing_ancestors_and_missing_suffixes() {
        let scratch = Scratch::new("existing-ancestor");
        let root = std::fs::canonicalize(&scratch.root).unwrap();
        std::fs::create_dir_all(root.join("notes/deep")).unwrap();
        std::fs::write(root.join("notes/deep/existing.md"), b"existing").unwrap();
        for path in [
            "notes/deep/existing.md",
            "notes/deep/missing.md",
            "notes/deep/new/more/missing.md",
            "new/more/missing.md",
        ] {
            assert_eq!(resolve_target(&root, path).unwrap(), root.join(path));
        }
    }

    #[cfg(windows)]
    #[test]
    fn resolves_existing_hashed_short_names_before_admitting_them() {
        use std::os::windows::process::CommandExt;
        fn short_name(root: &Path, name: &str) -> String {
            let output = std::process::Command::new("cmd")
                .args(["/d", "/c"])
                .raw_arg(format!("for %I in ({name}) do @echo %~snxI"))
                .current_dir(root)
                .output()
                .unwrap();
            assert!(output.status.success());
            String::from_utf8(output.stdout).unwrap().trim().to_owned()
        }
        let scratch = Scratch::new("short-name");
        let root = std::fs::canonicalize(&scratch.root).unwrap();
        let mut checked_hashed_alias = false;
        for index in 0..12 {
            let name = format!(".dohc-write-{index}");
            std::fs::create_dir(scratch.root.join(&name)).unwrap();
            let alias = short_name(&scratch.root, &name);
            if alias == name || crate::floor::has_ignored_segment(&alias) {
                continue;
            }
            assert!(scratch.root.join(&alias).is_dir(), "{alias}");
            std::fs::create_dir(scratch.root.join(&name).join("existing")).unwrap();
            for suffix in [
                "injected.md",
                "existing/injected.md",
                "new/deep/injected.md",
            ] {
                assert!(
                    matches!(
                        resolve_target(&root, &format!("{alias}/{suffix}")),
                        Err(MaterializeError::UnsafeTargetPath)
                    ),
                    "{alias}/{suffix}"
                );
            }
            checked_hashed_alias = true;
        }
        for index in 0..5 {
            std::fs::create_dir(scratch.root.join(format!("shared-prefix-{index}"))).unwrap();
        }
        std::fs::create_dir(scratch.root.join("shared-with-me")).unwrap();
        let alias = short_name(&scratch.root, "shared-with-me");
        assert!(
            matches!(
                resolve_target(&root, &format!("{alias}/injected.md")),
                Err(MaterializeError::UnsafeTargetPath)
            ),
            "{alias}"
        );
        eprintln!(
            "Checked hashed scratch alias: {checked_hashed_alias}; shared mount alias: {alias}"
        );
        if !checked_hashed_alias {
            eprintln!("NTFS hashed short names were not generated on this test volume");
        }
        for name in ["notes.conflict", "ledger.db-wal"] {
            std::fs::write(scratch.root.join(name), b"private").unwrap();
            let alias = short_name(&scratch.root, name);
            assert!(
                matches!(
                    resolve_target(&root, &alias),
                    Err(MaterializeError::UnsafeTargetPath)
                ),
                "{alias}"
            );
        }
    }

    #[test]
    fn ordinary_writes_refuse_reserved_case_variants() {
        for name in [
            ".DOHC",
            ".Dohc",
            ".dohc",
            ".do‍hc",
            ".GIT",
            "NODE_MODULES",
            "GIT~1",
            "NODE_M~1",
            "DOHC~1",
        ] {
            let scratch = Scratch::new("reserved-case");
            let mut store = EngineStore::open(&scratch.db(), 1).expect("store");
            let path = format!("{name}/engine/injected.md");
            enqueue_write_job(&mut store, "reserved", &path, b"peer content", 1);
            let job = store.load_materialization_job("reserved").unwrap().unwrap();
            let result = materialize_one(
                &store,
                &scratch.root,
                &job,
                &MaterializeOptions {
                    holds: None,
                    policy: DurabilityPolicy::none(),
                    replacer: &StdReplacer,
                    backoff: &NoBackoff,
                    now_ms: 2,
                    faults: &NoFaults,
                },
            );
            assert!(
                matches!(result, Err(MaterializeError::UnsafeTargetPath)),
                "{name}: {result:?}"
            );
            assert!(!scratch.root.join(&path).exists());
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
                holds: None,
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
                holds: None,
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
            write_temp_at_unix(
                parent_fd,
                OsStr::new(".env"),
                &redirected_target,
                plaintext,
                TempAccess::Owner,
            )
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
                holds: None,
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
                holds: None,
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
                holds: None,
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
                holds: None,
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
                holds: None,
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
                holds: None,
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
                holds: None,
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
                holds: None,
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
                holds: None,
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
                holds: None,
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
    fn projection_probe_treats_a_leaf_under_an_ordinary_file_as_absent() {
        let scratch = Scratch::new("projection-file-ancestor");
        std::fs::create_dir(scratch.root.join("parent")).unwrap();
        for ancestor in ["notes", "parent/notes"] {
            let obstacle = scratch.root.join(ancestor);
            std::fs::write(&obstacle, b"owned obstacle").unwrap();
            for kind in [
                ProjectionTargetKind::Plaintext,
                ProjectionTargetKind::Secret,
            ] {
                assert_eq!(
                    probe_projection_target(
                        &scratch.root,
                        &format!("{ancestor}/nested/doc.md"),
                        kind
                    ),
                    ProjectionTargetState::Absent,
                );
            }
            assert_eq!(std::fs::read(&obstacle).unwrap(), b"owned obstacle");
            assert_eq!(
                probe_projection_target(&scratch.root, ancestor, ProjectionTargetKind::Plaintext),
                ProjectionTargetState::Binary {
                    sha256: hex_sha256(b"owned obstacle"),
                },
            );
        }
        assert_eq!(
            probe_projection_target(
                &scratch.root,
                "../notes/doc.md",
                ProjectionTargetKind::Plaintext
            ),
            ProjectionTargetState::UntrackedContent,
        );
    }

    #[test]
    fn projection_probe_rejects_an_in_workspace_symlinked_ancestor() {
        let scratch = Scratch::new("projection-ancestor-alias");
        let real = scratch.root.join("real");
        std::fs::create_dir_all(&real).expect("create real directory");
        std::fs::write(real.join("owned.md"), b"real content").expect("write aliased target");
        std::fs::write(real.join("obstacle"), b"owned obstacle").unwrap();
        let alias = scratch.root.join("alias");
        create_directory_alias(&alias, &real);

        assert_eq!(
            probe_projection_target(
                &scratch.root,
                "alias/obstacle/doc.md",
                ProjectionTargetKind::Plaintext,
            ),
            ProjectionTargetState::UntrackedContent,
        );
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
                holds: None,
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

#[cfg(test)]
#[path = "materialize/retention_tests.rs"]
mod retention_tests;
