//! Reconcile: turn a scan diff into a **capture plan** (which files to ingest,
//! which to retire), and own the watcher **dirty-generation** state machine.
//!
//! The plan is the CAL-3 deliverable; actual materialization/capture into the
//! domain is a thin downstream call (a later shard). Two invariants live here:
//!
//! - **Cancellation leaves consistent, resumable state.** A reconcile runs a
//!   full scan, and only on a COMPLETED scan does it advance the generation,
//!   replace the manifest, and clear dirty. If the scan is cancelled mid-way,
//!   nothing is committed: the generation and manifest are untouched and the
//!   dirty flag stays set, so the next reconcile completes the work. There is
//!   no partial capture — the plan is produced atomically or not at all.
//! - **Dirty coalesces but never drops a change.** A watcher overflow (or any
//!   uncertainty) sets the single dirty flag; many events coalesce to one
//!   pending rescan, but the flag is cleared ONLY by a completed reconcile, so
//!   evidence of a change is never lost (`plan §Workspace actor model`).

use crate::diff::{ScanDiff, ScanManifest, diff_scans};
use crate::error::FilesError;
use crate::scan::{ScanOutcome, Scanner};
use std::path::Path;
use tokio_util::sync::CancellationToken;

/// A monotonically increasing scan generation. Generation 0 is the pre-scan
/// baseline; each completed reconcile increments it.
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
    /// Whether this reconcile cleared a pending dirty generation.
    pub cleared_dirty: bool,
}

impl ReconcilePlan {
    /// Build a plan from a classified diff. Ops are sorted by path so the plan
    /// is deterministic and inspectable.
    fn from_diff(
        diff: ScanDiff,
        from_generation: ScanGeneration,
        to_generation: ScanGeneration,
        cleared_dirty: bool,
    ) -> Self {
        let mut ops: Vec<CaptureOp> = Vec::with_capacity(diff.len());
        for file in diff.added {
            ops.push(CaptureOp::Ingest {
                path: file.path,
                size: file.size,
                sha256: file.sha256,
                media_type: file.media_type,
                reason: IngestReason::Added,
            });
        }
        for file in diff.changed {
            ops.push(CaptureOp::Ingest {
                path: file.path,
                size: file.size,
                sha256: file.sha256,
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
            cleared_dirty,
        }
    }

    /// The number of ops.
    pub fn len(&self) -> usize {
        self.ops.len()
    }

    /// Whether the plan is empty (disk already converged with the engine).
    pub fn is_empty(&self) -> bool {
        self.ops.is_empty()
    }
}

/// The outcome of a reconcile.
#[derive(Debug)]
pub enum ReconcileRun {
    /// The scan completed; the plan is committed (generation advanced, manifest
    /// replaced, dirty cleared).
    Completed(ReconcilePlan),
    /// The scan was cancelled mid-way. NOTHING was committed: the generation
    /// and manifest are unchanged and the dirty flag is preserved, so the next
    /// reconcile completes the work. No partial capture.
    Cancelled,
    /// [`ReconcileController::reconcile_if_dirty`] found nothing dirty; disk and
    /// engine are already converged and no scan was run.
    Converged,
}

/// Owns the reconcile state: the last committed manifest, the current scan
/// generation, and the dirty flag. This is the actor-native home of the
/// watcher/reconcile generation (`plan §Workspace actor model`).
#[derive(Debug)]
pub struct ReconcileController {
    manifest: ScanManifest,
    generation: ScanGeneration,
    dirty: bool,
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

    /// Mark the generation dirty — a watcher overflow / uncertainty signal.
    /// Coalesces: repeated calls collapse to one pending rescan. Never drops
    /// evidence of a change: the flag is cleared only by a completed reconcile.
    pub fn mark_dirty(&mut self) {
        self.dirty = true;
    }

    /// Run a full reconcile: scan `root`, diff against the last committed
    /// manifest, and (on completion) commit the new generation.
    pub fn reconcile(
        &mut self,
        scanner: &Scanner,
        root: &Path,
        token: &CancellationToken,
    ) -> Result<ReconcileRun, FilesError> {
        let listing = match scanner.scan(root, token)? {
            // Cancelled mid-scan: commit nothing. Dirty and generation stay put
            // — the state is consistent and the work is resumable.
            ScanOutcome::Cancelled => return Ok(ReconcileRun::Cancelled),
            ScanOutcome::Completed(listing) => listing,
        };

        let diff = diff_scans(&self.manifest, &listing, scanner.bounds())?;

        // COMMIT POINT: everything below is the atomic advance. The diff is
        // already fully materialized in memory (bounded), so there is no
        // cancellation window here that could tear the transition.
        let from = self.generation;
        let to = from.next();
        let cleared_dirty = self.dirty;
        self.manifest = ScanManifest::from_listing(&listing);
        self.generation = to;
        self.dirty = false;

        Ok(ReconcileRun::Completed(ReconcilePlan::from_diff(
            diff,
            from,
            to,
            cleared_dirty,
        )))
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
}
