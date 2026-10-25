//! Reconcile: turn a scan diff into a **capture plan** (which files to ingest,
//! which to retire), and own the watcher **dirty-generation** state machine.
//!
//! The plan is the CAL-3 deliverable; actual materialization/capture into the
//! domain is a thin downstream call. Two invariants live here:
//!
//! - **Prepare, apply, then acknowledge.** A reconcile only prepares a bounded
//!   plan. [`crate::capture`] applies its operations one at a time, then calls
//!   the controller acknowledgement with successful paths. The generation and
//!   manifest never advance past a failed/unapplied path.
//! - **Cancellation leaves consistent, resumable state.** A cancelled scan
//!   produces no plan, so generation, manifest, and dirty remain untouched.
//! - **Dirty coalesces but never drops a change.** A watcher overflow (or any
//!   uncertainty) sets the single dirty flag; many events coalesce to one
//!   pending rescan, but the flag is cleared only by a completed apply/ack, so
//!   evidence of a change is never lost (`plan §Workspace actor model`).

use crate::diff::{ManifestEntry, ScanDiff, ScanManifest, diff_scans};
use crate::error::FilesError;
use crate::scan::{ScanOutcome, Scanner};
use std::collections::{BTreeMap, BTreeSet};
use std::hash::{DefaultHasher, Hash, Hasher};
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use tokio_util::sync::CancellationToken;

/// Identical degraded observations are retried this many times before the
/// controller quarantines them and stops self-forcing immediate full scans.
pub const DEGRADED_RESCAN_BACKOFF: usize = 3;
/// Maximum number of degraded paths retained for diagnostics/quarantine.
pub const MAX_QUARANTINED_PATHS: usize = 256;

/// A monotonically increasing scan generation. Generation 0 is the pre-scan
/// baseline; each completed apply/ack increments it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Default)]
pub struct ScanGeneration(pub u64);

impl ScanGeneration {
    fn next(self) -> ScanGeneration {
        // A scan generation cannot realistically overflow u64; saturate rather
        // than wrap so a pathological run degrades safely instead of aliasing.
        ScanGeneration(self.0.saturating_add(1))
    }
}

/// Why a file is being ingested.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IngestReason {
    Added,
    Changed,
}

/// One capture operation in a reconcile plan.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CaptureOp {
    /// Ingest (capture) a file's current content.
    Ingest {
        path: String,
        size: u64,
        sha256: String,
        /// The mtime the manifest may pair with `sha256` at acknowledgement,
        /// already passed through [`recordable_mtime_ms`]; `0` means no
        /// trustworthy pairing (the next scan re-hashes this path once). Never
        /// sent to the sink — the receipt protocol is untouched.
        mtime_ms: i64,
        media_type: &'static str,
        reason: IngestReason,
    },
    /// Retire a tracked file that is gone from disk.
    Retire { path: String },
}

impl CaptureOp {
    /// The workspace-relative path this op targets (for deterministic ordering).
    pub fn path(&self) -> &str {
        match self {
            CaptureOp::Ingest { path, .. } | CaptureOp::Retire { path } => path,
        }
    }
}

/// The spelling a respelled path's file is stored under now, and the bytes
/// the scan found there.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Respelling {
    pub path: String,
    pub sha256: String,
}

/// A reconcile plan: the ordered capture ops plus the generation transition.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReconcilePlan {
    pub from_generation: ScanGeneration,
    pub to_generation: ScanGeneration,
    pub ops: Vec<CaptureOp>,
    /// Previously-tracked paths that are still on disk but whose content the
    /// scan did not read: over the size cap, or evicted by a cloud provider.
    /// A distinct, no-op disposition: not an `Ingest` (not re-hashed),
    /// never a `Retire` (the file exists). The engine keeps them tracked at
    /// their last-known-good content. Surfaced for
    /// R07 materialization so it can leave these files untouched.
    pub retained_unread: Vec<String>,
    /// Missing paths retained because a scan failure or final lstat result did
    /// not prove absence. Their prior manifest entries remain last-known-good.
    pub unconfirmed_removed: Vec<String>,
    /// Retires the plan's ingests respell, proven on disk: the old spelling
    /// still opens the file, which is stored under another spelling. Each
    /// names the ingest of that spelling.
    pub respelled_retires: BTreeMap<String, Respelling>,
    /// The pass saw one or more readability failures or an unconfirmed retire.
    /// Callers mirror TS `onCaptureOutcome({ok:false})` while still applying
    /// every independent safe operation.
    pub degraded: bool,
    /// Paths whose observation was degraded or whose absence was unconfirmed.
    /// They remain last-known-good and feed the bounded retry quarantine.
    pub degraded_paths: Vec<String>,
    /// Whether the plan was prepared because a dirty generation was pending.
    pub prepared_from_dirty: bool,
    /// Dirty epoch observed when this plan was prepared. An overflow arriving
    /// before acknowledgement increments the controller epoch, preventing this
    /// older receipt from clearing newer evidence.
    pub dirty_epoch: u64,
}

impl ReconcilePlan {
    /// Build a plan from a classified diff. Ops are sorted by path so the plan
    /// is deterministic and inspectable, except that a retire whose path an
    /// ingested path respells comes before every ingest. `stored_spelling`
    /// gives the spelling a retired path's file is stored under, when that is
    /// another one; the retire is respelled only when the plan ingests that
    /// exact path.
    #[allow(clippy::too_many_arguments)]
    fn from_diff(
        diff: ScanDiff,
        stored_spelling: impl Fn(&str) -> Option<String>,
        from_generation: ScanGeneration,
        to_generation: ScanGeneration,
        prepared_from_dirty: bool,
        dirty_epoch: u64,
        degraded: bool,
        degraded_paths: Vec<String>,
    ) -> Self {
        let mut ops: Vec<CaptureOp> = Vec::with_capacity(diff.len());
        for file in diff.added {
            ops.push(CaptureOp::Ingest {
                path: file.path,
                size: file.size,
                sha256: file.sha256,
                mtime_ms: file.mtime_ms,
                media_type: file.media_type,
                reason: IngestReason::Added,
            });
        }
        for file in diff.changed {
            ops.push(CaptureOp::Ingest {
                path: file.path,
                size: file.size,
                sha256: file.sha256,
                mtime_ms: file.mtime_ms,
                media_type: file.media_type,
                reason: IngestReason::Changed,
            });
        }
        for path in diff.removed {
            ops.push(CaptureOp::Retire { path });
        }
        ops.sort_by(|a, b| a.path().cmp(b.path()));
        // A rename that changes only case or Unicode normalization retires the
        // old spelling first. A peer on a disk that ignores case then deletes
        // the old file before it writes the new one, never the new one after.
        let key = crate::floor::path_collision_key;
        let retired: BTreeSet<String> = ops
            .iter()
            .filter_map(|op| match op {
                CaptureOp::Retire { path } => Some(key(path)),
                CaptureOp::Ingest { .. } => None,
            })
            .collect();
        let paired: BTreeSet<String> = if retired.is_empty() {
            BTreeSet::new()
        } else {
            ops.iter()
                .filter_map(|op| match op {
                    CaptureOp::Ingest { path, .. } => Some(key(path)),
                    CaptureOp::Retire { .. } => None,
                })
                .filter(|path| retired.contains(path))
                .collect()
        };
        let mut respelled_retires = BTreeMap::new();
        if !paired.is_empty() {
            ops.sort_by_key(
                |op| !matches!(op, CaptureOp::Retire { path } if paired.contains(&key(path))),
            );
            let ingests: BTreeMap<&str, &str> = ops
                .iter()
                .filter_map(|op| match op {
                    CaptureOp::Ingest { path, sha256, .. } if paired.contains(&key(path)) => {
                        Some((path.as_str(), sha256.as_str()))
                    }
                    _ => None,
                })
                .collect();
            for op in &ops {
                let CaptureOp::Retire { path } = op else {
                    break;
                };
                if let Some(stored) = stored_spelling(path)
                    && let Some(sha256) = ingests.get(stored.as_str())
                {
                    let sha256 = (*sha256).to_owned();
                    respelled_retires.insert(
                        path.clone(),
                        Respelling {
                            path: stored,
                            sha256,
                        },
                    );
                }
            }
        }
        ReconcilePlan {
            from_generation,
            to_generation,
            ops,
            retained_unread: diff.retained_unread,
            unconfirmed_removed: diff.unconfirmed_removed,
            respelled_retires,
            degraded,
            degraded_paths,
            prepared_from_dirty,
            dirty_epoch,
        }
    }

    /// The number of ops.
    pub fn len(&self) -> usize {
        self.ops.len()
    }

    /// Whether the plan has no actionable ops (retained-unread is a no-op
    /// disposition and does not count here).
    pub fn is_empty(&self) -> bool {
        self.ops.is_empty()
    }
}

/// The outcome of a reconcile.
#[derive(Debug)]
pub enum ReconcileRun {
    /// The scan completed and produced a prepared plan. No generation or
    /// manifest state advances until capture applies and acknowledges it.
    Completed(ReconcilePlan),
    /// The scan was cancelled mid-way. Nothing was committed: the generation
    /// and manifest are unchanged and the dirty flag is preserved, so the next
    /// reconcile completes the work. No partial capture.
    Cancelled,
    /// [`ReconcileController::reconcile_if_dirty`] found nothing dirty; disk and
    /// engine are already converged and no scan was run.
    Converged,
}

/// Final destructive-retire guard. Production uses `symlink_metadata` (lstat,
/// never stat) to distinguish a path gone as a regular file (retire) from a
/// regular-file reappearance or an indeterminate error (retain). The trait
/// keeps all three outcomes directly testable on every platform.
pub trait AbsenceProbe: Send + Sync {
    /// True when the tracked regular file at `relative` under `root` is
    /// confirmed gone, including when a non-regular entry now occupies its
    /// path or the file found there is stored under another spelling. False
    /// retains on either a regular-file reappearance or an indeterminate
    /// probe error.
    fn confirms_absent(&self, root: &Path, relative: &str) -> bool;
}

/// Production probe: gone/non-regular retires; regular or indeterminate retains.
#[derive(Debug, Clone, Copy, Default)]
pub struct StdAbsenceProbe;

impl AbsenceProbe for StdAbsenceProbe {
    fn confirms_absent(&self, root: &Path, relative: &str) -> bool {
        let Some(absolute) = absolute_path(root, relative) else {
            return false;
        };
        match std::fs::symlink_metadata(absolute) {
            Err(err) if matches!(err.kind(), ErrorKind::NotFound | ErrorKind::NotADirectory) => {
                true
            }
            // The scanner tracks regular files only. A directory, symlink, or
            // other non-regular replacement confirms that tracked file gone.
            Ok(metadata) => {
                !metadata.file_type().is_file() || stored_under_other_spelling(root, relative)
            }
            // Permission, lock, sharing, and other errors cannot prove the
            // regular file gone, so retain its last-known-good state.
            Err(_) => false,
        }
    }
}

/// Whether `relative` reaches an entry under `root` only through another
/// stored spelling of its file name. APFS ignores case and Unicode
/// normalization; NTFS ignores case. A lookup of `notes.md` can therefore
/// find a file renamed to `Notes.md`. The stored spelling shows that
/// `relative` itself is gone. A symlink is never another spelling, and a
/// renamed folder is not proven: its files keep their old handling.
pub fn stored_under_other_spelling(root: &Path, relative: &str) -> bool {
    stored_spelling(root, relative).is_some()
}

/// The spelling under which `relative`'s entry is stored, when that differs
/// from `relative` only in case or Unicode normalization. See
/// [`stored_under_other_spelling`]. NTFS keeps normalization forms distinct.
fn stored_spelling(root: &Path, relative: &str) -> Option<String> {
    let root = root.canonicalize().ok()?;
    stored_spelling_in(&root, relative)
}

pub(crate) fn stored_spelling_in(root: &Path, relative: &str) -> Option<String> {
    let spelling = disk_spelling_in(root, &root.join(relative))?;
    let stored: Vec<&str> = spelling.split('/').collect();
    let tracked: Vec<&str> = relative.split('/').collect();
    if stored.len() != tracked.len() {
        return None;
    }
    let mut lookup = root.to_path_buf();
    let leaf = tracked.len() - 1;
    for (index, (stored, tracked)) in stored.into_iter().zip(tracked).enumerate() {
        lookup.push(tracked);
        if stored != tracked
            && (index < leaf
                || crate::floor::fold_segment(stored) != crate::floor::fold_segment(tracked)
                || std::fs::symlink_metadata(&lookup)
                    .ok()
                    .is_none_or(|entry| entry.file_type().is_symlink()))
        {
            return None;
        }
    }
    (spelling != relative).then_some(spelling)
}

/// The path below `root` that `relative` reaches, spelled as the disk stores
/// each name, with links resolved. `None` when nothing is there, the path
/// leaves `root`, or the disk can't say which name it stores.
pub fn disk_spelling(root: &Path, relative: &str) -> Option<String> {
    let root = root.canonicalize().ok()?;
    disk_spelling_in(&root, &root.join(relative))
}

/// [`disk_spelling`] for an absolute `path`, below a canonical `root`. Windows
/// names each folder as the disk stores it. macOS does only on disks that can
/// tell it, and Linux keeps the spelling it was given, so on a folder that
/// ignores case, such as a Windows drive under WSL, `Notes.md` reaches `notes.md`
/// and keeps its own spelling. There each name comes from its folder.
pub(crate) fn disk_spelling_in(root: &Path, path: &Path) -> Option<String> {
    let file = path.canonicalize().ok()?;
    let below = file.strip_prefix(root).ok()?;
    #[cfg(unix)]
    let mut lookup = root.to_path_buf();
    let mut names = Vec::new();
    for name in below.components() {
        #[cfg(unix)]
        let name = {
            lookup.push(name);
            stored_leaf_name(&lookup).ok()?
        };
        #[cfg(not(unix))]
        let name = name.as_os_str().to_owned();
        names.push(name.into_string().ok()?);
    }
    // Query the leaf's directory entry on Windows: a file handle's final path
    // need not name the hard link we looked up. Folders cannot be hard-linked.
    #[cfg(windows)]
    if let Some(leaf) = names.last_mut() {
        *leaf = dohc_windows_files::stored_leaf_name(path)
            .ok()?
            .into_string()
            .ok()?;
    }
    Some(names.join("/"))
}

/// The name `path`'s folder stores its entry under. A folder that can be
/// searched but not listed keeps the name `canonicalize` gave, which macOS
/// already reports as stored.
#[cfg(unix)]
fn stored_leaf_name(path: &Path) -> std::io::Result<std::ffi::OsString> {
    use std::os::unix::fs::MetadataExt;
    let (Some(folder), Some(leaf)) = (path.parent(), path.file_name()) else {
        return Err(ErrorKind::InvalidInput.into());
    };
    let file = std::fs::symlink_metadata(path)?;
    let Ok(names) = std::fs::read_dir(folder).and_then(|entries| {
        entries
            .map(|entry| entry.map(|entry| entry.file_name()))
            .collect::<std::io::Result<Vec<_>>>()
    }) else {
        return Ok(leaf.to_owned());
    };
    let folded = leaf.to_str().map(crate::floor::fold_segment);
    stored_name_among(
        leaf,
        names,
        |name| folded.is_some() && name.to_str().map(crate::floor::fold_segment) == folded,
        |name| {
            std::fs::symlink_metadata(folder.join(name))
                .is_ok_and(|entry| (entry.dev(), entry.ino()) == (file.dev(), file.ino()))
        },
    )
}

/// Of a folder's `names`, the one a lookup of `leaf` reached: `leaf` itself
/// when the folder lists it, or else the one name that is the same file.
/// Names that fold like `leaf` come first, so a hard link under an unrelated
/// name doesn't count. Two names that both could be it are an error, never a
/// guess.
#[cfg(any(unix, test))]
fn stored_name_among(
    leaf: &std::ffi::OsStr,
    names: Vec<std::ffi::OsString>,
    folds_like_leaf: impl Fn(&std::ffi::OsStr) -> bool,
    same_file: impl Fn(&std::ffi::OsStr) -> bool,
) -> std::io::Result<std::ffi::OsString> {
    if names.iter().any(|name| name == leaf) {
        return Ok(leaf.to_owned());
    }
    let (like, other): (Vec<_>, Vec<_>) = names.into_iter().partition(|name| folds_like_leaf(name));
    for group in [like, other] {
        let mut same = group.into_iter().filter(|name| same_file(name));
        if let Some(name) = same.next() {
            return match same.next() {
                None => Ok(name),
                Some(_) => Err(std::io::Error::other(
                    "two names in one folder reach this file",
                )),
            };
        }
    }
    Err(ErrorKind::NotFound.into())
}

/// Owns the reconcile state: the last committed manifest, the current scan
/// generation, and the dirty flag. This is the actor-native home of the
/// watcher/reconcile generation (`plan §Workspace actor model`).
#[derive(Debug)]
pub struct ReconcileController {
    manifest: ScanManifest,
    generation: ScanGeneration,
    dirty: bool,
    dirty_epoch: u64,
    outstanding: bool,
    degraded_signature: Option<u64>,
    degraded_epoch: u64,
    identical_degraded_count: usize,
    quarantined_paths: Vec<String>,
    deferred_paths: Vec<String>,
}

impl Default for ReconcileController {
    fn default() -> Self {
        ReconcileController::new()
    }
}

impl ReconcileController {
    /// A fresh controller. It starts **dirty**: no scan has established a
    /// baseline yet, so the first reconcile must be a full rescan.
    pub fn new() -> Self {
        ReconcileController {
            manifest: ScanManifest::empty(),
            generation: ScanGeneration::default(),
            dirty: true,
            dirty_epoch: 1,
            outstanding: false,
            degraded_signature: None,
            degraded_epoch: 0,
            identical_degraded_count: 0,
            quarantined_paths: Vec::new(),
            deferred_paths: Vec::new(),
        }
    }

    /// A controller seeded with a manifest recovered from a process restart
    /// (R14 robustness: manifest rehydration), rather than the empty
    /// baseline [`ReconcileController::new`] starts from. Without this, every
    /// restart treats every already-tracked, unchanged file as freshly
    /// `Added` — safe (capture is a content-equality no-op downstream) but
    /// wasteful, and it loses the `Added`-vs-`Changed` distinction. Seeding
    /// the manifest lets the first post-restart reconcile report only the
    /// changes that actually happened while the process was down.
    ///
    /// Still starts **dirty**, same as [`ReconcileController::new`]: a
    /// rehydrated manifest is a last-known-good snapshot, not proof the disk
    /// still matches it, so the mandatory post-restart full reconcile is
    /// never skipped.
    ///
    /// Entries the path floor now excludes are dropped. A `.DS_Store`
    /// captured before the floor named it can never be listed again, and the
    /// file still on disk would otherwise hold every pass degraded.
    ///
    /// Building the seed `ScanManifest` from the domain's own captured-file
    /// records (rather than a caller-supplied one, as here) is a deliberate
    /// follow-up: this crate does not depend on the domain layer (see
    /// `capture.rs`), so the actual rehydration SOURCE lives above this
    /// primitive.
    pub fn rehydrated(mut manifest: ScanManifest, generation: ScanGeneration) -> Self {
        manifest.drop_excluded();
        ReconcileController {
            manifest,
            generation,
            dirty: true,
            dirty_epoch: 1,
            outstanding: false,
            degraded_signature: None,
            degraded_epoch: 0,
            identical_degraded_count: 0,
            quarantined_paths: Vec::new(),
            deferred_paths: Vec::new(),
        }
    }

    /// The current committed generation.
    pub fn generation(&self) -> ScanGeneration {
        self.generation
    }

    /// Whether a full rescan is pending.
    pub fn is_dirty(&self) -> bool {
        self.dirty
    }

    /// Number of files in the last committed manifest.
    pub fn tracked_len(&self) -> usize {
        self.manifest.len()
    }

    /// Whether the committed manifest still tracks an exact normalized path.
    pub fn tracks_path(&self, path: &str) -> bool {
        self.manifest.get(path).is_some()
    }

    /// Paths the last acknowledged run deferred to a live document session.
    /// Every full scan offers them again until one captures or retires them.
    pub fn deferred_paths(&self) -> &[String] {
        &self.deferred_paths
    }

    /// Bounded last-known degraded paths retained by the retry quarantine.
    pub fn quarantined_paths(&self) -> &[String] {
        &self.quarantined_paths
    }

    /// Mark the generation dirty — a watcher overflow / uncertainty signal.
    /// Coalesces: repeated calls collapse to one pending rescan. Never drops
    /// evidence of a change: the flag is cleared only by a completed apply/ack.
    pub fn mark_dirty(&mut self) {
        self.dirty = true;
        self.dirty_epoch = self.dirty_epoch.saturating_add(1);
    }

    /// Prepare a full reconcile: scan `root` and diff against the last
    /// acknowledged manifest. This method does not commit the generation.
    pub fn reconcile(
        &mut self,
        scanner: &Scanner,
        root: &Path,
        token: &CancellationToken,
    ) -> Result<ReconcileRun, FilesError> {
        self.reconcile_with_absence_probe(scanner, root, token, &StdAbsenceProbe)
    }

    /// Prepare a reconcile with an injectable final lstat seam. This remains
    /// bounded to one probe per apparent removal candidate.
    pub fn reconcile_with_absence_probe(
        &mut self,
        scanner: &Scanner,
        root: &Path,
        token: &CancellationToken,
        absence_probe: &dyn AbsenceProbe,
    ) -> Result<ReconcileRun, FilesError> {
        if self.outstanding {
            return Err(FilesError::StaleReconcilePlan);
        }
        let scan_started_ms = now_ms();
        let mut listing = match scanner.scan_with_prior(root, &self.manifest, token)? {
            // Cancelled mid-scan: commit nothing. Dirty and generation stay put
            // — the state is consistent and the work is resumable.
            ScanOutcome::Cancelled => return Ok(ReconcileRun::Cancelled),
            ScanOutcome::Completed(listing) => listing,
        };

        // Clamp every observed mtime to what the manifest may pair with this
        // scan's hashes ([`recordable_mtime_ms`], the racy-write fence).
        // Everything downstream — the refresh pass and the plan's ops — carries
        // the clamped value, never the raw observation.
        for file in &mut listing.files {
            file.mtime_ms = recordable_mtime_ms(file.mtime_ms, scan_started_ms);
        }

        // Refresh the mtime pairing of every hash-verified unchanged file so
        // the next scan can reuse its hash (a rehydrated seed carries no
        // mtimes; a touch-without-change moves the mtime while the hash stays
        // put). Content identity (size + hash) is never touched. Changed/added
        // files get their pairing at acknowledgement instead — recording it
        // before the sink ran would let the next scan skip a path whose
        // capture failed.
        for file in &listing.files {
            if let Some(entry) = self.manifest.entry_mut(&file.path)
                && entry.size == file.size
                && entry.sha256 == file.sha256
            {
                entry.mtime_ms = file.mtime_ms;
            }
        }

        let scan_degraded = listing.degraded();
        let mut degraded_paths: Vec<String> = listing
            .failed
            .iter()
            .map(|failed| failed.path.clone())
            .collect();
        let mut diff = diff_scans(&self.manifest, &listing, scanner.bounds())?;

        // False-delete defense, second layer: even a clean scan's apparent
        // removals get one final lstat. Absence or a non-regular replacement
        // confirms the tracked regular file is gone. Regular-file reappearance,
        // permission denial, locks, and other errors retain last-known-good.
        let mut confirmed_removed = Vec::with_capacity(diff.removed.len());
        let mut lstat_unconfirmed = Vec::new();
        for path in diff.removed.drain(..) {
            if absence_probe.confirms_absent(root, &path) {
                confirmed_removed.push(path);
            } else {
                lstat_unconfirmed.push(path);
            }
        }
        diff.removed = confirmed_removed;
        diff.unconfirmed_removed.extend(lstat_unconfirmed);
        diff.unconfirmed_removed.sort();
        diff.unconfirmed_removed.dedup();
        degraded_paths.extend(diff.unconfirmed_removed.iter().cloned());
        degraded_paths.sort();
        degraded_paths.dedup();
        let degraded = scan_degraded || !diff.unconfirmed_removed.is_empty();

        let from = self.generation;
        let to = from.next();
        let prepared_from_dirty = self.dirty;
        let dirty_epoch = self.dirty_epoch;
        let plan = ReconcilePlan::from_diff(
            diff,
            |path| stored_spelling(root, path),
            from,
            to,
            prepared_from_dirty,
            dirty_epoch,
            degraded,
            degraded_paths,
        );
        self.outstanding = true;
        Ok(ReconcileRun::Completed(plan))
    }

    /// Reconcile only if a rescan is pending. Returns [`ReconcileRun::Converged`]
    /// without touching the filesystem when nothing is dirty.
    pub fn reconcile_if_dirty(
        &mut self,
        scanner: &Scanner,
        root: &Path,
        token: &CancellationToken,
    ) -> Result<ReconcileRun, FilesError> {
        if !self.dirty {
            return Ok(ReconcileRun::Converged);
        }
        self.reconcile(scanner, root, token)
    }

    /// Advance the manifest only for acknowledged paths. Called by the capture
    /// module after the sink phase; stale receipts fail closed. Applied ingests
    /// record the plan's hash, applied retires remove the path, and
    /// [`IngestOutcome::NotOwned`](crate::capture::IngestOutcome) dispositions
    /// forget the path — a not-owned path must never read as already-captured,
    /// or a later ownership change (policy widened, content became ownable
    /// again) would silently skip its re-ingest.
    pub(crate) fn acknowledge_capture(
        &mut self,
        plan: &ReconcilePlan,
        result: &crate::capture::CaptureApplyResult,
    ) -> Result<(), FilesError> {
        if !self.outstanding
            || plan.from_generation != self.generation
            || plan.to_generation != self.generation.next()
        {
            return Err(FilesError::StaleReconcilePlan);
        }
        if plan.ops.is_empty()
            && result.not_owned_paths.is_empty()
            && result.deferred_paths.is_empty()
        {
            self.generation = plan.to_generation;
            self.outstanding = false;
            self.deferred_paths = result.deferred_paths.clone();
            self.update_degraded_retry_state(plan, &result.failed_applies);
            return Ok(());
        }
        let applied: BTreeSet<&str> = result.applied_paths.iter().map(String::as_str).collect();
        let not_owned: BTreeSet<&str> = result.not_owned_paths.iter().map(String::as_str).collect();
        let deferred: BTreeSet<&str> = result.deferred_paths.iter().map(String::as_str).collect();
        let deferred_retires: BTreeSet<&str> =
            result.deferred_retires.iter().map(String::as_str).collect();
        let deferred_writes: BTreeSet<&str> =
            result.deferred_writes.iter().map(String::as_str).collect();
        let captured: std::collections::BTreeMap<&str, (u64, &str)> = result
            .captured
            .iter()
            .map(|c| (c.path.as_str(), (c.size, c.sha256.as_str())))
            .collect();
        let mut next = self.manifest.clone();
        let held: std::collections::BTreeMap<_, _> = result
            .held_observations
            .iter()
            .map(|held| (held.path.as_str(), held))
            .collect();
        for op in &plan.ops {
            if let Some(held) = held.get(op.path()) {
                let CaptureOp::Ingest {
                    size,
                    sha256,
                    mtime_ms,
                    ..
                } = op
                else {
                    return Err(FilesError::InvalidCaptureReceipt {
                        path: held.path.clone(),
                    });
                };
                let mtime_ms = if *size == held.size && sha256 == &held.sha256 {
                    *mtime_ms
                } else {
                    0
                };
                next.insert(
                    held.path.clone(),
                    ManifestEntry {
                        size: held.size,
                        sha256: held.sha256.clone(),
                        mtime_ms,
                    },
                );
                continue;
            }
            if not_owned.contains(op.path()) {
                next.remove(op.path());
                continue;
            }
            if deferred.contains(op.path()) {
                // A deferred ingest is not captured. An entry left from an
                // earlier file at the path would make the next scan call it
                // unchanged whenever the bytes match that file, and capture
                // would never check them. Deferred retires and outside writes
                // keep their entries, so release retries the original change.
                if !deferred_retires.contains(op.path()) && !deferred_writes.contains(op.path()) {
                    next.remove(op.path());
                }
                continue;
            }
            if !applied.contains(op.path()) {
                continue;
            }
            match op {
                CaptureOp::Ingest {
                    path,
                    size: op_size,
                    sha256: op_sha,
                    mtime_ms: op_mtime_ms,
                    ..
                } => {
                    // A re-reading sink can persist newer bytes than the scan
                    // hashed; record what was actually captured so a later
                    // revert to the scan-time bytes still diffs as a change.
                    // A receipt claiming an applied ingest without its captured
                    // identity is malformed — falling back to the scan hash
                    // would recreate the exact lost-capture bug this exists to
                    // prevent, so it fails closed before any state advances.
                    let Some((size, sha)) = captured.get(path.as_str()) else {
                        return Err(FilesError::InvalidCaptureReceipt { path: path.clone() });
                    };
                    // The scan-time mtime pairs only with the scan-time hash: a
                    // sink that persisted different bytes than the scan hashed
                    // leaves no mtime observation for what it captured, so
                    // that entry records 0 and the next scan re-hashes it once
                    // (the refresh pass then records a real pairing).
                    let mtime_ms = if *size == *op_size && *sha == op_sha.as_str() {
                        *op_mtime_ms
                    } else {
                        0
                    };
                    next.insert(
                        path.clone(),
                        ManifestEntry {
                            size: *size,
                            sha256: (*sha).to_owned(),
                            mtime_ms,
                        },
                    );
                }
                CaptureOp::Retire { path } => next.remove(path),
            }
        }
        // NotOwned paths are dropped even when they never appeared in
        // `plan.ops`: an over-cap policy retire is applied as a direct side
        // effect (such paths are `retained_unread`, deliberately absent
        // from the ops), and leaving its manifest entry would claim the path
        // is still tracked at content whose head has just been deleted — so a
        // later policy widen would diff clean and never re-ingest it.
        for path in &result.not_owned_paths {
            next.remove(path);
        }
        self.manifest = next;
        self.generation = plan.to_generation;
        self.outstanding = false;
        self.deferred_paths = result.deferred_paths.clone();
        self.update_degraded_retry_state(plan, &result.failed_applies);
        Ok(())
    }

    /// Refuse stale work before any sink effect. A newer dirty epoch supersedes
    /// the prepared plan and releases its outstanding slot for a fresh scan.
    pub(crate) fn ensure_plan_fresh(&mut self, plan: &ReconcilePlan) -> Result<(), FilesError> {
        let generation_matches =
            plan.from_generation == self.generation && plan.to_generation == self.generation.next();
        let epoch_matches = plan.dirty_epoch == self.dirty_epoch;
        if self.outstanding && generation_matches && epoch_matches {
            return Ok(());
        }
        if self.outstanding && generation_matches && !epoch_matches {
            self.outstanding = false;
        }
        Err(FilesError::StaleReconcilePlan)
    }

    fn update_degraded_retry_state(&mut self, plan: &ReconcilePlan, failed_applies: &[String]) {
        let newer_signal = self.dirty_epoch != plan.dirty_epoch;
        let mut degraded_paths = plan.degraded_paths.clone();
        degraded_paths.extend(failed_applies.iter().cloned());
        degraded_paths.sort();
        degraded_paths.dedup();

        if degraded_paths.is_empty() {
            self.degraded_signature = None;
            self.degraded_epoch = 0;
            self.identical_degraded_count = 0;
            self.quarantined_paths.clear();
            self.dirty = newer_signal;
            return;
        }

        let signature = degraded_path_signature(&degraded_paths);
        if self.degraded_signature == Some(signature) && self.degraded_epoch == plan.dirty_epoch {
            self.identical_degraded_count = self.identical_degraded_count.saturating_add(1);
        } else {
            self.degraded_signature = Some(signature);
            self.degraded_epoch = plan.dirty_epoch;
            self.identical_degraded_count = 1;
        }
        degraded_paths.truncate(MAX_QUARANTINED_PATHS);
        self.quarantined_paths = degraded_paths;
        self.dirty = newer_signal || self.identical_degraded_count < DEGRADED_RESCAN_BACKOFF;
    }
}

/// Worst-case filesystem mtime granularity: exFAT/FAT truncate mtimes to 2s
/// (ext3, HFS+, and SMB servers to 1s), so a stat can report an mtime up to a
/// full granule older than the write that produced it.
const MTIME_GRANULARITY_MARGIN_MS: i64 = 2000;

/// The mtime a manifest entry may pair with a hash computed by a scan that
/// began at `scan_started_ms` — git's racy-clean rule, widened for coarse
/// timestamps. A file whose mtime is not at least one worst-case granule
/// older than the scan's start could have been rewritten after hashing while
/// its truncated timestamp still stats below the fence (on exFAT a write up
/// to 2s after scan start can); recording that pairing would let every later
/// scan reuse a hash of bytes that are already gone, and a second same-size
/// write in the same granule would stay invisible forever. Such files record
/// `0` (no pairing) and are simply re-hashed on the next scan, by which point
/// their mtime is safely in the past. `0` (no observation) stays `0`, and a
/// broken clock (`now_ms() == 0`) disables pairing entirely — always failing
/// toward the hash.
fn recordable_mtime_ms(mtime_ms: i64, scan_started_ms: i64) -> i64 {
    if mtime_ms != 0 && mtime_ms.saturating_add(MTIME_GRANULARITY_MARGIN_MS) <= scan_started_ms {
        mtime_ms
    } else {
        0
    }
}

/// Milliseconds since the Unix epoch, or `0` when the clock is unusable.
fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .and_then(|since| i64::try_from(since.as_millis()).ok())
        .unwrap_or(0)
}

fn degraded_path_signature(paths: &[String]) -> u64 {
    let mut hasher = DefaultHasher::new();
    paths.len().hash(&mut hasher);
    for path in paths {
        path.hash(&mut hasher);
    }
    hasher.finish()
}

fn absolute_path(root: &Path, relative: &str) -> Option<PathBuf> {
    let mut out = root.to_path_buf();
    for segment in relative.split('/') {
        let mut components = Path::new(segment).components();
        if !matches!(components.next(), Some(std::path::Component::Normal(_)))
            || components.next().is_some()
        {
            // A malformed/prefixed manifest path can never authorize a probe
            // outside the root. Fail safe toward retention.
            return None;
        }
        out.push(segment);
    }
    Some(out)
}

#[cfg(test)]
mod fence_tests {
    use super::recordable_mtime_ms;

    /// The racy-clean fence must hold on coarse-timestamp filesystems: only
    /// an mtime a full worst-case granule (2000ms, exFAT) below scan start
    /// may pair; anything younger — including the exact boundary minus one —
    /// records no pairing, as do a missing observation and a broken clock.
    #[test]
    fn fence_requires_a_full_granularity_margin() {
        let start = 1_700_000_000_000;
        assert_eq!(recordable_mtime_ms(start - 2000, start), start - 2000);
        assert_eq!(recordable_mtime_ms(start - 1999, start), 0);
        assert_eq!(recordable_mtime_ms(start - 1, start), 0);
        assert_eq!(recordable_mtime_ms(start, start), 0);
        assert_eq!(
            recordable_mtime_ms(0, start),
            0,
            "no observation stays no pairing"
        );
        assert_eq!(
            recordable_mtime_ms(1000, 0),
            0,
            "a broken clock disables pairing"
        );
        assert_eq!(
            recordable_mtime_ms(i64::MAX, start),
            0,
            "a saturating margin cannot wrap a pathological mtime past the fence"
        );
    }
}

#[cfg(test)]
mod ack_receipt_tests {
    use super::*;
    use crate::capture::{CaptureApplyResult, CaptureSink, IngestOutcome};

    struct Accept;
    impl CaptureSink for Accept {
        fn ingest(
            &mut self,
            _path: &str,
            size: u64,
            sha256: &str,
            _media_type: &str,
            _reason: IngestReason,
        ) -> Result<IngestOutcome, crate::capture::CaptureError> {
            Ok(IngestOutcome::Captured {
                size,
                sha256: sha256.to_owned(),
            })
        }
        fn retire(
            &mut self,
            _path: &str,
        ) -> Result<crate::capture::RetireOutcome, crate::capture::CaptureError> {
            Ok(crate::capture::RetireOutcome::Retired)
        }
    }

    #[test]
    fn empty_ack_preserves_manifest_storage_and_advances_generation() {
        let mut controller = ReconcileController::new();
        controller.manifest.insert(
            "note.md".to_owned(),
            ManifestEntry {
                size: 3,
                sha256: "abc".to_owned(),
                mtime_ms: 42,
            },
        );
        controller.outstanding = true;
        let plan = empty_plan(&controller);
        let receipt = empty_receipt();
        let hash_storage = controller.manifest.get("note.md").unwrap().sha256.as_ptr();

        controller.acknowledge_capture(&plan, &receipt).unwrap();

        let entry = controller.manifest.get("note.md").unwrap();
        assert_eq!(
            entry.sha256.as_ptr(),
            hash_storage,
            "an empty acknowledgement must not clone the manifest"
        );
        assert_eq!(entry.mtime_ms, 42);
        assert_eq!(controller.generation, plan.to_generation);
        assert!(!controller.outstanding);
        assert!(!controller.dirty);
        assert!(matches!(
            controller.acknowledge_capture(&plan, &receipt),
            Err(FilesError::StaleReconcilePlan)
        ));
    }

    #[test]
    fn empty_ack_preserves_newer_dirty_signals_and_degraded_retry() {
        let mut controller = ReconcileController::new();
        controller.outstanding = true;
        let plan = empty_plan(&controller);
        controller.mark_dirty();
        controller
            .acknowledge_capture(&plan, &empty_receipt())
            .unwrap();
        assert!(controller.dirty);

        for _ in 0..DEGRADED_RESCAN_BACKOFF {
            controller.outstanding = true;
            let mut plan = empty_plan(&controller);
            plan.degraded = true;
            plan.degraded_paths.push("unreadable.md".to_owned());
            controller
                .acknowledge_capture(&plan, &empty_receipt())
                .unwrap();
        }
        assert!(!controller.dirty);
        assert_eq!(controller.quarantined_paths, vec!["unreadable.md"]);
    }

    fn empty_plan(controller: &ReconcileController) -> ReconcilePlan {
        ReconcilePlan {
            from_generation: controller.generation,
            to_generation: controller.generation.next(),
            ops: Vec::new(),
            retained_unread: Vec::new(),
            unconfirmed_removed: Vec::new(),
            respelled_retires: BTreeMap::new(),
            degraded: false,
            degraded_paths: Vec::new(),
            prepared_from_dirty: true,
            dirty_epoch: controller.dirty_epoch,
        }
    }

    fn empty_receipt() -> CaptureApplyResult {
        CaptureApplyResult {
            applied_paths: Vec::new(),
            captured: Vec::new(),
            not_owned_paths: Vec::new(),
            failed_applies: Vec::new(),
            deferred_paths: Vec::new(),
            deferred_retires: Vec::new(),
            deferred_writes: Vec::new(),
            held_observations: Vec::new(),
            crashed_after_durable_boundary: None,
            degraded: false,
        }
    }

    /// A side-effect retire (the driver's over-cap policy-exclusion path)
    /// reports a path that never appeared in `plan.ops`. The manifest must
    /// drop it: leaving the entry would claim the path is still tracked at
    /// content whose head was just deleted, so a later policy widen would
    /// diff clean and never re-ingest it.
    #[test]
    fn not_owned_paths_absent_from_the_ops_are_still_dropped() {
        let mut controller = ReconcileController::new();
        controller.manifest.insert(
            "over-cap.md".to_owned(),
            ManifestEntry {
                size: 10,
                sha256: "abc".to_owned(),
                mtime_ms: 0,
            },
        );
        controller.outstanding = true;
        let plan = ReconcilePlan {
            from_generation: controller.generation,
            to_generation: controller.generation.next(),
            ops: Vec::new(),
            retained_unread: vec!["over-cap.md".to_owned()],
            unconfirmed_removed: Vec::new(),
            respelled_retires: BTreeMap::new(),
            degraded: false,
            degraded_paths: Vec::new(),
            prepared_from_dirty: true,
            dirty_epoch: controller.dirty_epoch,
        };
        let receipt = CaptureApplyResult {
            applied_paths: Vec::new(),
            captured: Vec::new(),
            not_owned_paths: vec!["over-cap.md".to_owned()],
            failed_applies: Vec::new(),
            deferred_paths: Vec::new(),
            deferred_retires: Vec::new(),
            deferred_writes: Vec::new(),
            held_observations: Vec::new(),
            crashed_after_durable_boundary: None,
            degraded: false,
        };
        assert!(controller.tracks_path("over-cap.md"));
        controller
            .acknowledge_capture(&plan, &receipt)
            .expect("ack a side-effect receipt");
        assert!(
            !controller.tracks_path("over-cap.md"),
            "a side-effect retire must drop the manifest entry"
        );
        let _ = Accept;
    }
}

#[cfg(test)]
mod respell_order_tests {
    use super::*;
    use crate::diff::ScanDiff;
    use crate::scan::FileEntry;

    fn entry(path: &str) -> FileEntry {
        FileEntry {
            path: path.to_owned(),
            size: 1,
            mtime_ms: 0,
            sha256: "a".repeat(64),
            media_type: "text/markdown",
        }
    }

    /// The retire of a spelling comes before any ingest that respells it,
    /// changed as well as added: path order would put `Notes.md` before
    /// `notes.md`, and a peer that ignores case would delete the new file.
    /// Only a retire the disk proves respelled counts as one.
    #[test]
    fn a_retire_comes_before_every_ingest_that_respells_it() {
        for (added, changed) in [
            (vec![entry("Notes.md")], vec![]),
            (vec![], vec![entry("Notes.md")]),
        ] {
            for proven in [true, false] {
                let diff = ScanDiff {
                    added: added.clone(),
                    changed: changed.clone(),
                    removed: vec!["notes.md".to_owned(), "zz.md".to_owned()],
                    ..ScanDiff::default()
                };
                let plan = ReconcilePlan::from_diff(
                    diff,
                    |_| proven.then(|| "Notes.md".to_owned()),
                    ScanGeneration(0),
                    ScanGeneration(1),
                    false,
                    0,
                    false,
                    Vec::new(),
                );
                let paths: Vec<&str> = plan.ops.iter().map(CaptureOp::path).collect();
                assert_eq!(paths, ["notes.md", "Notes.md", "zz.md"]);
                let respelled: Vec<(&str, &str)> = plan
                    .respelled_retires
                    .iter()
                    .map(|(path, to)| (path.as_str(), to.path.as_str()))
                    .collect();
                assert_eq!(
                    respelled,
                    if proven {
                        vec![("notes.md", "Notes.md")]
                    } else {
                        vec![]
                    }
                );
            }
        }
    }

    /// A folded group can hold names the volume keeps apart, such as one with
    /// a zero-width space. A retire pairs only with the ingest at the exact
    /// spelling its file is stored under, never with another name that shares
    /// its key.
    #[test]
    fn a_respelled_retire_pairs_only_with_its_stored_spelling() {
        for (ingested, paired) in [("AB.md", false), ("A\u{200b}B.md", true)] {
            let diff = ScanDiff {
                added: vec![entry(ingested)],
                removed: vec!["a\u{200b}b.md".to_owned()],
                ..ScanDiff::default()
            };
            let plan = ReconcilePlan::from_diff(
                diff,
                |_| Some("A\u{200b}B.md".to_owned()),
                ScanGeneration(0),
                ScanGeneration(1),
                false,
                0,
                false,
                Vec::new(),
            );
            assert_eq!(!plan.respelled_retires.is_empty(), paired, "{ingested}");
        }
    }
}

#[cfg(test)]
mod stored_name_tests {
    use super::stored_name_among;
    use std::ffi::{OsStr, OsString};
    use std::io::ErrorKind;

    /// Which of `names` a lookup of `leaf` reached, where `same` are the
    /// names that are the file it found.
    fn among(leaf: &str, names: &[&str], same: &[&str]) -> std::io::Result<OsString> {
        let folded = crate::floor::fold_segment(leaf);
        stored_name_among(
            OsStr::new(leaf),
            names.iter().map(OsString::from).collect(),
            |name| name.to_str().map(crate::floor::fold_segment).as_deref() == Some(&*folded),
            |name| same.iter().any(|same| OsStr::new(same) == name),
        )
    }

    #[test]
    fn a_listed_name_is_its_own_stored_name() {
        let found = among("Notes.md", &["notes.md", "Notes.md"], &["notes.md"]);
        assert_eq!(found.unwrap(), "Notes.md");
    }

    #[test]
    fn an_unlisted_name_is_stored_as_the_same_file_spelled_like_it() {
        let found = among(
            "Notes.md",
            &["backup.md", "notes.md"],
            &["backup.md", "notes.md"],
        );
        assert_eq!(
            found.unwrap(),
            "notes.md",
            "a hard link under another name is not this entry"
        );
    }

    #[test]
    fn a_name_the_disk_folds_but_dohc_does_not_still_finds_its_entry() {
        let found = among(
            "NOTES~1.MD",
            &["other.md", "Notes draft.md"],
            &["Notes draft.md"],
        );
        assert_eq!(found.unwrap(), "Notes draft.md");
    }

    #[test]
    fn two_names_that_could_be_the_entry_are_an_error_not_a_guess() {
        among("NOTES~1.MD", &["a.md", "b.md"], &["a.md", "b.md"]).unwrap_err();
    }

    #[test]
    fn a_folder_without_the_file_has_no_stored_name() {
        let missing = among("Notes.md", &["other.md"], &[]).unwrap_err();
        assert_eq!(missing.kind(), ErrorKind::NotFound);
    }
}
