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
    ) -> Result<(), CaptureError>;

    fn retire(&mut self, path: &str) -> Result<(), CaptureError>;
}

/// Bounded receipt from the apply phase.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CaptureApplyResult {
    /// Paths safe for the controller to acknowledge.
    pub applied_paths: Vec<String>,
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
    let mut failed_applies = Vec::new();
    for op in &plan.ops {
        let applied = match op {
            CaptureOp::Ingest {
                path,
                size,
                sha256,
                media_type,
                reason,
            } => sink.ingest(path, *size, sha256, media_type, *reason),
            CaptureOp::Retire { path } => sink.retire(path),
        };
        if applied.is_err() {
            failed_applies.push(op.path().to_owned());
            continue;
        }
        if should_crash(faults) {
            return CaptureApplyResult {
                applied_paths,
                failed_applies,
                crashed_after_apply: Some(op.path().to_owned()),
                degraded: true,
            };
        }
        applied_paths.push(op.path().to_owned());
    }
    let degraded = plan.degraded || !failed_applies.is_empty();
    CaptureApplyResult {
        applied_paths,
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
    let result = apply_reconcile_plan(plan, sink, faults);
    if result.completed() {
        controller.acknowledge_capture(plan, &result.applied_paths, &result.failed_applies)?;
    }
    Ok(result)
}
