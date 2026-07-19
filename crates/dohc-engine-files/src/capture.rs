//! Two-phase reconcile capture: apply one operation, then acknowledge it.
//!
//! Each [`CaptureOp`](crate::reconcile::CaptureOp) is sent to its sink in a
//! separate call. A bad path is recorded and the remaining bounded batch keeps
//! moving, matching the TS desktop capture chain's per-path transaction
//! posture. Only successfully applied paths enter the acknowledgement receipt;
//! failed paths retain their prior manifest entry and keep the controller dirty
//! for retry.
//!
//! The crash seam sits after the sink call and before the receipt records that
//! path. A restart may therefore reapply an operation whose domain transaction
//! already committed. That is safe by contract: text/secret writes are
//! content-equality no-ops and deletes are absent-tip no-ops. The manifest is
//! never advanced past an unapplied path, while redundant replay cannot append
//! a second user-visible moment. Together those two halves prevent both lost
//! capture and double-journaling.
//!
//! This crate owns the sequencing and a narrow sink trait. The concrete desktop
//! adapter may route `Tracked` to `VersionedTextStore`, `Secret` to
//! `SecretFileStore`, and skip `Ignored` using [`crate::policy`], without
//! introducing the forbidden files -> domain dependency cycle.

use crate::error::FilesError;
use crate::reconcile::{CaptureOp, IngestReason, ReconcileController, ReconcilePlan};
use dohc_engine_storage::{FaultInjector, FaultPoint};

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
    /// lowercase-hex sha256 of the bytes it ACTUALLY persisted — the manifest
    /// must record those, not the plan's scan-time observation: a re-reading
    /// sink can capture newer bytes than the scan hashed (rapid writes
    /// coalescing, or a change landing before the watcher was live), and a
    /// manifest recording the stale scan hash would silently skip the
    /// re-ingest if the file later reverted to those exact bytes.
    Captured { size: u64, sha256: String },
    /// The path is durably NOT engine-owned (policy-untracked, no longer
    /// engine-ownable content, or an unsafe name). The op is acknowledged —
    /// the disposition is settled, not retryable — but the manifest must
    /// FORGET the path rather than record it as captured, so a later
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

/// The narrow downstream contract. Each call is one idempotent domain
/// transaction; the capture loop never batches multiple paths into one commit.
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
}

/// Bounded receipt from the apply phase.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CaptureApplyResult {
    /// Paths safe for the controller to acknowledge as applied (captured
    /// ingests and completed retires).
    pub applied_paths: Vec<String>,
    /// The actual content identity of each applied ingest, in plan order.
    /// The manifest records THESE, never the plan's scan-time hash.
    pub captured: Vec<CapturedIngest>,
    /// Ingest paths the sink settled as [`IngestOutcome::NotOwned`]. They are
    /// acknowledged, but the controller manifest drops them instead of
    /// recording the plan's hash.
    pub not_owned_paths: Vec<String>,
    /// Sink failures, in deterministic plan order. These remain dirty.
    pub failed_applies: Vec<String>,
    /// The path applied immediately before the injected crash. It is excluded
    /// from `applied_paths`, so a restarted controller retries it.
    pub crashed_after_apply: Option<String>,
    /// Scan degradation or any contained apply failure.
    pub degraded: bool,
}

impl CaptureApplyResult {
    /// Whether the apply phase reached the end without the crash seam firing.
    pub fn completed(&self) -> bool {
        self.crashed_after_apply.is_none()
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

/// Apply a prepared plan one operation at a time. Sink errors are contained and
/// surfaced in the receipt; the loop continues with the next independent path.
pub fn apply_reconcile_plan(
    plan: &ReconcilePlan,
    sink: &mut dyn CaptureSink,
    faults: &dyn FaultInjector,
) -> CaptureApplyResult {
    let mut applied_paths = Vec::with_capacity(plan.ops.len());
    let mut captured = Vec::new();
    let mut not_owned_paths = Vec::new();
    let mut failed_applies = Vec::new();
    for op in &plan.ops {
        enum Applied {
            Ingested { size: u64, sha256: String },
            Retired,
            NotOwned,
        }
        let outcome = match op {
            CaptureOp::Ingest {
                path,
                size,
                sha256,
                media_type,
                reason,
            } => {
                sink.ingest(path, *size, sha256, media_type, *reason)
                    .map(|outcome| match outcome {
                        IngestOutcome::Captured { size, sha256 } => {
                            Applied::Ingested { size, sha256 }
                        }
                        IngestOutcome::NotOwned => Applied::NotOwned,
                    })
            }
            CaptureOp::Retire { path } => sink.retire(path).map(|()| Applied::Retired),
        };
        let Ok(outcome) = outcome else {
            failed_applies.push(op.path().to_owned());
            continue;
        };
        if should_crash(faults) {
            return CaptureApplyResult {
                applied_paths,
                captured,
                not_owned_paths,
                failed_applies,
                crashed_after_apply: Some(op.path().to_owned()),
                degraded: true,
            };
        }
        match outcome {
            Applied::Ingested { size, sha256 } => {
                applied_paths.push(op.path().to_owned());
                captured.push(CapturedIngest {
                    path: op.path().to_owned(),
                    size,
                    sha256,
                });
            }
            Applied::Retired => applied_paths.push(op.path().to_owned()),
            Applied::NotOwned => not_owned_paths.push(op.path().to_owned()),
        }
    }
    let degraded = plan.degraded || !failed_applies.is_empty();
    CaptureApplyResult {
        applied_paths,
        captured,
        not_owned_paths,
        failed_applies,
        crashed_after_apply: None,
        degraded,
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
