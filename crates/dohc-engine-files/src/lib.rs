//! dohc engine files — CAL-3 calibration slice.
//!
//! Workspace filesystem **scan → hash → diff → reconcile-plan**, with the path
//! floor, the watcher dirty-generation state machine, and full resource bounds,
//! driven actor-native on a dedicated blocking thread under a tokio command
//! loop (the CAL-2 model). This is the actor-native successor to the reference
//! accelerator (`crates/workspace-kernel`, NDJSON thread-per-request) — studied
//! for its documented behavior, not depended on.
//!
//! The calibration point is **cancellation + bounds** (`plan §Workspace actor
//! model`, `PORTING.md` §12/§14):
//!
//! - **Cooperative cancellation between bounded units.** Every scan checks the
//!   [`CancellationToken`] between directory entries and between hash batches,
//!   and a single large file's stream loop checks it between buffer reads —
//!   never mid-durable-step. A cancelled reconcile commits nothing: the
//!   generation, manifest, and dirty flag are untouched, so the next reconcile
//!   completes the work (consistent, resumable — no partial capture).
//! - **Everything bounded.** Max files (fail-closed, never truncate), max file
//!   size (skip-or-error), a bounded streaming read buffer, a fixed-size hash
//!   worker pool (never `spawn`-per-file — the peak concurrency is asserted via
//!   [`hash::PoolGauge`]), a bounded in-memory diff, and a bounded command
//!   queue with explicit `Overloaded` backpressure.
//! - **Dirty-generation reconcile.** A watcher overflow sets a dirty generation
//!   forcing a full bounded rescan; coalescing may reduce work but never drops
//!   the only evidence of a change.
//!
//! The crate is dormant: nothing here is reachable from product code, and it
//! changes no TypeScript/product behavior.

#![forbid(unsafe_code)]

pub mod actor;
pub mod bounds;
pub mod capture;
pub mod diff;
pub mod error;
pub mod floor;
pub mod hash;
pub mod materialize;
pub mod media;
pub mod policy;
pub mod reconcile;
pub mod scan;
pub mod watch;

pub use actor::{FilesActor, FilesHandle, FilesStats, LifecycleState};
pub use bounds::{MAX_CAPTURE_TEXT_BYTES, OverCapPolicy, ScanBounds, ScanBoundsBuilder};
pub use capture::{
    CaptureApplyResult, CaptureError, CaptureSink, apply_reconcile_plan, apply_then_ack,
};
pub use diff::{ManifestEntry, ScanDiff, ScanManifest, diff_scans};
pub use error::FilesError;
pub use hash::{HashOutcome, HashPool, PoolGauge};
pub use materialize::{
    AtomicReplacer, DurabilityPolicy, JobOutcome, JobResult, MaterializeError, NoBackoff,
    ReplaceBackoff, StdBackoff, StdReplacer, backoff_delay, materialize_one, run_pending_jobs,
};
pub use policy::{
    PathClassification, classify_engine_file_path, classify_engine_file_path_for_read,
    classify_engine_file_path_normalized,
};
pub use reconcile::{
    AbsenceProbe, CaptureOp, DEGRADED_RESCAN_BACKOFF, IngestReason, MAX_QUARANTINED_PATHS,
    ReconcileController, ReconcilePlan, ReconcileRun, ScanGeneration, StdAbsenceProbe,
};
pub use scan::{
    FailedPath, FileEntry, ScanIoFaultInjector, ScanIoOperation, ScanListing, ScanOutcome, Scanner,
    SkipReason, SkippedPath,
};
pub use watch::{
    NativeWatcher, StubWatchSource, WATCH_EVENT_QUEUE_CAPACITY, WATCH_HARD_DEADLINE, WATCH_SETTLE,
    WATCH_STARTUP_DEADLINE, WatchEvent, WatchStart, apply_event,
};

// The cancellation primitive the actor loop consumes, re-exported so a caller
// drives cancellation through one crate (mirrors `dohc-engine-runtime`).
pub use tokio_util::sync::CancellationToken;
