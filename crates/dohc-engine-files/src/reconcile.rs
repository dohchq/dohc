//! Reconcile: turn a scan diff into a **capture plan** (which files to ingest,
//! which to retire), and own the watcher **dirty-generation** state machine.
//!
//! The plan is the CAL-3 deliverable; actual materialization/capture into the
//! domain is a thin downstream call (a later shard). Two invariants live here:
//!
//! - **Prepare, apply, then acknowledge.** A reconcile only prepares a bounded
//!   plan. [`crate::capture`] applies its operations one at a time, then calls
//!   the controller acknowledgement with successful paths. The generation and
//!   manifest never advance past a failed/unapplied path.
//! - **Cancellation leaves consistent, resumable state.** A cancelled scan
//!   produces no plan, so generation, manifest, and dirty remain untouched.
//! - **Dirty coalesces but never drops a change.** A watcher overflow (or any
//!   uncertainty) sets the single dirty flag; many events coalesce to one
//!   pending rescan, but the flag is cleared ONLY by a completed apply/ack, so
//!   evidence of a change is never lost (`plan §Workspace actor model`).

use crate::diff::{ManifestEntry, ScanDiff, ScanManifest, diff_scans};
use crate::error::FilesError;
use crate::scan::{ScanOutcome, Scanner};
use std::collections::BTreeSet;
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

/// A reconcile plan: the ordered capture ops plus the generation transition.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReconcilePlan {
    pub from_generation: ScanGeneration,
    pub to_generation: ScanGeneration,
    pub ops: Vec<CaptureOp>,
    /// Previously-tracked paths that are STILL on disk but now exceed the size
    /// cap. A distinct, no-op disposition: NOT an `Ingest` (can't re-hash),
    /// NEVER a `Retire` (the file exists). The engine keeps them tracked at
    /// their last-known-good content (`BEHAVIOR_DELTA.md` CAL-3). Surfaced for
    /// R07 materialization so it can leave these files untouched.
    pub retained_over_cap: Vec<String>,
    /// Missing paths retained because a scan failure or final lstat result did
    /// not prove absence. Their prior manifest entries remain last-known-good.
    pub unconfirmed_removed: Vec<String>,
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
    /// is deterministic and inspectable.
    fn from_diff(
        diff: ScanDiff,
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
        ReconcilePlan {
            from_generation,
            to_generation,
            ops,
            retained_over_cap: diff.retained_over_cap,
            unconfirmed_removed: diff.unconfirmed_removed,
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

    /// Whether the plan has no actionable ops (retained-over-cap is a no-op
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
    /// The scan was cancelled mid-way. NOTHING was committed: the generation
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
    /// True when the tracked regular file is confirmed gone, including when a
    /// non-regular entry now occupies its path. False retains on either a
    /// regular-file reappearance or an indeterminate probe error.
    fn confirms_absent(&self, absolute_path: &Path) -> bool;
}

/// Production probe: gone/non-regular retires; regular or indeterminate retains.
#[derive(Debug, Clone, Copy, Default)]
pub struct StdAbsenceProbe;

impl AbsenceProbe for StdAbsenceProbe {
    fn confirms_absent(&self, absolute_path: &Path) -> bool {
        match std::fs::symlink_metadata(absolute_path) {
            Err(err) if matches!(err.kind(), ErrorKind::NotFound | ErrorKind::NotADirectory) => {
                true
            }
            // The scanner tracks regular files only. A directory, symlink, or
            // other non-regular replacement confirms that tracked file gone.
            Ok(metadata) => !metadata.file_type().is_file(),
            // Permission, lock, sharing, and other errors cannot prove the
            // regular file gone, so retain its last-known-good state.
            Err(_) => false,
        }
    }
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
    /// Building the seed `ScanManifest` from the domain's own captured-file
    /// records (rather than a caller-supplied one, as here) is a deliberate
    /// follow-up: this crate does not depend on the domain layer (see
    /// `capture.rs`), so the actual rehydration SOURCE lives above this
    /// primitive.
    pub fn rehydrated(manifest: ScanManifest, generation: ScanGeneration) -> Self {
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
        let listing = match scanner.scan_with_prior(root, &self.manifest, token)? {
            // Cancelled mid-scan: commit nothing. Dirty and generation stay put
            // — the state is consistent and the work is resumable.
            ScanOutcome::Cancelled => return Ok(ReconcileRun::Cancelled),
            ScanOutcome::Completed(listing) => listing,
        };

        // Refresh the mtime pairing of every hash-verified unchanged file, so
        // the NEXT scan can reuse its hash: a rehydrated seed carries no
        // mtimes, and a touch-without-change moves the mtime while the hash
        // stays put. Content identity (size + hash) is never touched here, and
        // this is deliberately not part of the capture receipt: the pairing is
        // a true observation from a completed scan whether or not the plan
        // below is ever applied. Changed/added files get their pairing at
        // acknowledgement instead — recording it before the sink ran would let
        // the next scan skip a path whose capture failed.
        for file in &listing.files {
            if let Some(entry) = self.manifest.entry_mut(&file.path)
                && entry.size == file.size
                && entry.sha256 == file.sha256
            {
                let recordable = recordable_mtime_ms(file.mtime_ms, scan_started_ms);
                if entry.mtime_ms != recordable {
                    entry.mtime_ms = recordable;
                }
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
            let confirmed = absolute_path(root, &path)
                .is_some_and(|absolute| absence_probe.confirms_absent(&absolute));
            if confirmed {
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

        // Clamp the diff's mtimes to what the manifest may PAIR at
        // acknowledgement (the racy-write guard); the plan's ops carry the
        // clamped value, never the raw observation.
        for file in diff.added.iter_mut().chain(diff.changed.iter_mut()) {
            file.mtime_ms = recordable_mtime_ms(file.mtime_ms, scan_started_ms);
        }

        let from = self.generation;
        let to = from.next();
        let prepared_from_dirty = self.dirty;
        let dirty_epoch = self.dirty_epoch;
        let plan = ReconcilePlan::from_diff(
            diff,
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
    /// FORGET the path — a not-owned path must never read as already-captured,
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
        let applied: BTreeSet<&str> = result.applied_paths.iter().map(String::as_str).collect();
        let not_owned: BTreeSet<&str> = result.not_owned_paths.iter().map(String::as_str).collect();
        let captured: std::collections::BTreeMap<&str, (u64, &str)> = result
            .captured
            .iter()
            .map(|c| (c.path.as_str(), (c.size, c.sha256.as_str())))
            .collect();
        let mut next = self.manifest.clone();
        for op in &plan.ops {
            if not_owned.contains(op.path()) {
                next.remove(op.path());
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
                    // hashed; record what was ACTUALLY captured so a later
                    // revert to the scan-time bytes still diffs as a change.
                    // A receipt claiming an applied ingest WITHOUT its captured
                    // identity is malformed — falling back to the scan hash
                    // would recreate the exact lost-capture bug this exists to
                    // prevent, so it fails closed before any state advances.
                    let Some((size, sha)) = captured.get(path.as_str()) else {
                        return Err(FilesError::InvalidCaptureReceipt { path: path.clone() });
                    };
                    // The scan-time mtime pairs ONLY with the scan-time hash: a
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
        // effect (such paths are `retained_over_cap`, deliberately absent
        // from the ops), and leaving its manifest entry would claim the path
        // is still tracked at content whose head has just been deleted — so a
        // later policy widen would diff clean and never re-ingest it.
        for path in &result.not_owned_paths {
            next.remove(path);
        }
        self.manifest = next;
        self.generation = plan.to_generation;
        self.outstanding = false;
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
/// full granule OLDER than the write that produced it.
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
        fn retire(&mut self, _path: &str) -> Result<(), crate::capture::CaptureError> {
            Ok(())
        }
    }

    /// A side-effect retire (the driver's over-cap policy-exclusion path)
    /// reports a path that never appeared in `plan.ops`. The manifest MUST
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
            retained_over_cap: vec!["over-cap.md".to_owned()],
            unconfirmed_removed: Vec::new(),
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
            crashed_after_apply: None,
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
