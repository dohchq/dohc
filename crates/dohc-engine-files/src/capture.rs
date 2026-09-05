//! Two-phase reconcile capture: durably apply operations, then acknowledge them.
//!
//! The default path sends each [`CaptureOp`](crate::reconcile::CaptureOp) to its
//! sink separately. A sink may durably batch a bounded all-ingest plan while
//! preserving one outcome per path. Only successfully applied paths enter the
//! acknowledgement receipt; failed paths retain their prior manifest entry and
//! keep the controller dirty for retry.
//!
//! The crash seam sits after one durable sink unit—an ordinary operation or a
//! committed batch prefix—and before the receipt records that unit. A restart
//! may therefore reapply domain transactions that already committed. That is
//! safe by contract: text/secret writes are
//! content-equality no-ops and deletes are absent-tip no-ops. The manifest is
//! never advanced past an unapplied path, while redundant replay cannot append
//! a second user-visible moment. Together those two halves prevent both lost
//! capture and double-journaling.
//!
//! This crate owns the sequencing and a narrow sink trait. The concrete desktop
//! adapter may route `Tracked` to `VersionedTextStore`, `Secret` to
//! `SecretFileStore`, and skip `Ignored` using [`crate::policy`], without
//! introducing the forbidden files -> domain dependency cycle.

use crate::CancellationToken;
use crate::error::FilesError;
use crate::reconcile::{CaptureOp, IngestReason, ReconcileController, ReconcilePlan};
use dohc_engine_storage::FaultInjector;
#[cfg(feature = "fault-injection")]
use dohc_engine_storage::FaultPoint;

/// A contained per-path domain apply failure. It is deliberately content-free.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("capture sink rejected the path: {reason}")]
pub struct CaptureError {
    pub reason: &'static str,
}

/// How a sink disposed of a planned ingest.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IngestOutcome {
    /// The observed content was captured. The sink reports the size and
    /// lowercase-hex sha256 of the bytes it actually persisted — the manifest
    /// must record those, not the plan's scan-time observation: a re-reading
    /// sink can capture newer bytes than the scan hashed (rapid writes
    /// coalescing, or a change landing before the watcher was live), and a
    /// manifest recording the stale scan hash would silently skip the
    /// re-ingest if the file later reverted to those exact bytes.
    Captured { size: u64, sha256: String },
    /// The path is durably not engine-owned (policy-untracked, no longer
    /// engine-ownable content, or an unsafe name). The op is acknowledged —
    /// the disposition is settled, not retryable — but the manifest must
    /// forget the path rather than record it as captured, so a later
    /// ownership change (policy widened, content became ownable) re-ingests
    /// on the next scan instead of reading as already-captured.
    NotOwned,
}

/// The actual content identity an applied ingest persisted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CapturedIngest {
    pub path: String,
    pub size: u64,
    pub sha256: String,
}

/// Result of attempting one bounded batch prefix.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BatchIngestResult {
    /// The returned outcomes committed together and align with the same-size
    /// prefix of the requested operations.
    Committed(Vec<Result<IngestOutcome, CaptureError>>),
    /// The sink could not certify a commit for this many leading operations.
    /// They remain dirty and the capture crash seam must not be polled.
    Uncertain { attempted: usize },
}

/// The narrow downstream contract. The default path applies one idempotent
/// domain transaction per operation. A sink may override [`Self::ingest_batch`]
/// when it can commit a bounded all-ingest plan atomically while returning one
/// durable outcome per path.
pub trait CaptureSink {
    fn ingest(
        &mut self,
        path: &str,
        size: u64,
        sha256: &str,
        media_type: &str,
        reason: IngestReason,
    ) -> Result<IngestOutcome, CaptureError>;

    fn retire(&mut self, path: &str) -> Result<(), CaptureError>;

    /// Try one bounded all-ingest prefix. `None` asks the capture loop to use
    /// the ordinary per-operation contract for the whole plan. A committed
    /// result is one durability boundary; its non-empty outcomes must align
    /// with a prefix of `ops`. An uncertain result likewise consumes a
    /// non-empty prefix, but certifies no commit and therefore receives no
    /// post-commit crash poll.
    fn ingest_batch(&mut self, _ops: &[CaptureOp]) -> Option<BatchIngestResult> {
        None
    }
}

/// Bounded receipt from the apply phase.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CaptureApplyResult {
    /// Paths safe for the controller to acknowledge as applied (captured
    /// ingests and completed retires).
    pub applied_paths: Vec<String>,
    /// The actual content identity of each applied ingest, in plan order.
    /// The manifest records these, never the plan's scan-time hash.
    pub captured: Vec<CapturedIngest>,
    /// Ingest paths the sink settled as [`IngestOutcome::NotOwned`]. They are
    /// acknowledged, but the controller manifest drops them instead of
    /// recording the plan's hash.
    pub not_owned_paths: Vec<String>,
    /// Sink failures, in deterministic plan order. These remain dirty.
    pub failed_applies: Vec<String>,
    /// The last path in the durable unit committed immediately before the
    /// injected crash. The whole plan remains unacknowledged, so a restarted
    /// controller safely retries that unit and any earlier committed units.
    pub crashed_after_durable_boundary: Option<String>,
    /// Scan degradation or any contained apply failure.
    pub degraded: bool,
}

impl CaptureApplyResult {
    /// Whether the apply phase reached the end without the crash seam firing.
    pub fn completed(&self) -> bool {
        self.crashed_after_durable_boundary.is_none()
    }
}

#[cfg(feature = "fault-injection")]
#[inline]
fn should_crash(faults: &dyn FaultInjector) -> bool {
    faults.poll(FaultPoint::CaptureAfterOpApplyBeforeAck) == dohc_engine_storage::FaultAction::Crash
}

#[cfg(not(feature = "fault-injection"))]
#[inline(always)]
fn should_crash(_faults: &dyn FaultInjector) -> bool {
    false
}

/// Apply a prepared plan. Sink errors are contained and surfaced in the
/// receipt; independent paths continue.
pub fn apply_reconcile_plan(
    plan: &ReconcilePlan,
    sink: &mut dyn CaptureSink,
    faults: &dyn FaultInjector,
) -> CaptureApplyResult {
    apply_reconcile_plan_cancellable(plan, sink, faults, &CancellationToken::new())
}

/// Apply a prepared plan, stopping cooperatively between bounded sink calls.
/// The unprocessed suffix is reported failed so acknowledgement leaves it
/// dirty for the next startup instead of losing it during close.
pub fn apply_reconcile_plan_cancellable(
    plan: &ReconcilePlan,
    sink: &mut dyn CaptureSink,
    faults: &dyn FaultInjector,
    cancel: &CancellationToken,
) -> CaptureApplyResult {
    let mut receipt = Receipt::with_capacity(plan.ops.len());
    let mut cursor = 0;
    let mut try_batch = true;
    while cursor < plan.ops.len() {
        if cancel.is_cancelled() {
            receipt.fail_all(&plan.ops[cursor..]);
            break;
        }
        if try_batch {
            match sink.ingest_batch(&plan.ops[cursor..]) {
                Some(BatchIngestResult::Committed(outcomes)) => {
                    let count = outcomes.len();
                    if !valid_batch_prefix(&plan.ops[cursor..], count) {
                        receipt.fail_all(&plan.ops[cursor..]);
                        break;
                    }
                    let boundary = &plan.ops[cursor + count - 1];
                    if should_crash(faults) {
                        return receipt.crashed(boundary.path());
                    }
                    for (op, outcome) in plan.ops[cursor..cursor + count].iter().zip(outcomes) {
                        receipt.fold(op, outcome.map(Applied::from));
                    }
                    cursor += count;
                    continue;
                }
                Some(BatchIngestResult::Uncertain { attempted }) => {
                    if !valid_batch_prefix(&plan.ops[cursor..], attempted) {
                        receipt.fail_all(&plan.ops[cursor..]);
                        break;
                    }
                    receipt.fail_all(&plan.ops[cursor..cursor + attempted]);
                    cursor += attempted;
                    continue;
                }
                None => try_batch = false,
            }
        }

        let op = &plan.ops[cursor];
        let outcome = match op {
            CaptureOp::Ingest {
                path,
                size,
                sha256,
                // Manifest bookkeeping consumed at acknowledgement; the sink
                // contract never sees it.
                mtime_ms: _,
                media_type,
                reason,
            } => sink
                .ingest(path, *size, sha256, media_type, *reason)
                .map(Applied::from),
            CaptureOp::Retire { path } => sink.retire(path).map(|()| Applied::Retired),
        };
        if outcome.is_ok() && should_crash(faults) {
            return receipt.crashed(op.path());
        }
        receipt.fold(op, outcome);
        cursor += 1;
    }
    receipt.finish(plan.degraded)
}

fn valid_batch_prefix(ops: &[CaptureOp], count: usize) -> bool {
    count > 0
        && count <= ops.len()
        && ops[..count]
            .iter()
            .all(|op| matches!(op, CaptureOp::Ingest { .. }))
}

enum Applied {
    Ingested { size: u64, sha256: String },
    Retired,
    NotOwned,
}

impl From<IngestOutcome> for Applied {
    fn from(outcome: IngestOutcome) -> Self {
        match outcome {
            IngestOutcome::Captured { size, sha256 } => Self::Ingested { size, sha256 },
            IngestOutcome::NotOwned => Self::NotOwned,
        }
    }
}

struct Receipt {
    applied_paths: Vec<String>,
    captured: Vec<CapturedIngest>,
    not_owned_paths: Vec<String>,
    failed_applies: Vec<String>,
}

impl Receipt {
    fn with_capacity(capacity: usize) -> Self {
        Self {
            applied_paths: Vec::with_capacity(capacity),
            captured: Vec::with_capacity(capacity),
            not_owned_paths: Vec::new(),
            failed_applies: Vec::new(),
        }
    }

    fn fold(&mut self, op: &CaptureOp, outcome: Result<Applied, CaptureError>) {
        match outcome {
            Ok(Applied::Ingested { size, sha256 }) => {
                self.applied_paths.push(op.path().to_owned());
                self.captured.push(CapturedIngest {
                    path: op.path().to_owned(),
                    size,
                    sha256,
                });
            }
            Ok(Applied::Retired) => self.applied_paths.push(op.path().to_owned()),
            Ok(Applied::NotOwned) => self.not_owned_paths.push(op.path().to_owned()),
            Err(_) => self.failed_applies.push(op.path().to_owned()),
        }
    }

    fn fail_all(&mut self, ops: &[CaptureOp]) {
        self.failed_applies
            .extend(ops.iter().map(|op| op.path().to_owned()));
    }

    fn crashed(self, boundary_path: &str) -> CaptureApplyResult {
        CaptureApplyResult {
            applied_paths: self.applied_paths,
            captured: self.captured,
            not_owned_paths: self.not_owned_paths,
            failed_applies: self.failed_applies,
            crashed_after_durable_boundary: Some(boundary_path.to_owned()),
            degraded: true,
        }
    }

    fn finish(self, scan_degraded: bool) -> CaptureApplyResult {
        let degraded = scan_degraded || !self.failed_applies.is_empty();
        CaptureApplyResult {
            applied_paths: self.applied_paths,
            captured: self.captured,
            not_owned_paths: self.not_owned_paths,
            failed_applies: self.failed_applies,
            crashed_after_durable_boundary: None,
            degraded,
        }
    }
}

/// Apply a plan and, only when the phase reaches its end, acknowledge the
/// successful paths into the controller's manifest/generation.
pub fn apply_then_ack(
    controller: &mut ReconcileController,
    plan: &ReconcilePlan,
    sink: &mut dyn CaptureSink,
    faults: &dyn FaultInjector,
) -> Result<CaptureApplyResult, FilesError> {
    controller.ensure_plan_fresh(plan)?;
    let result = apply_reconcile_plan(plan, sink, faults);
    if result.completed() {
        controller.acknowledge_capture(plan, &result)?;
    }
    Ok(result)
}
