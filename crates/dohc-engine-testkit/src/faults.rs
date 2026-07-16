//! Scripted fault injection for the in-process crash tier.
//!
//! [`ScriptedFaults`] arms a single crash at one named storage fault point and
//! fires it exactly once, so a post-crash *retry* of the same operation runs
//! without re-crashing — which is what lets a test prove exactly-once recovery.

use dohc_engine_storage::{FaultAction, FaultInjector, FaultPoint};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

/// A single-shot crash injector. Returns [`FaultAction::Crash`] the first time
/// the armed point is reached, then [`FaultAction::Continue`] forever after.
pub struct ScriptedFaults {
    point: FaultPoint,
    armed: AtomicBool,
}

impl ScriptedFaults {
    /// Arm a one-shot crash at `point`.
    pub fn crash_at(point: FaultPoint) -> Arc<Self> {
        Arc::new(ScriptedFaults {
            point,
            armed: AtomicBool::new(true),
        })
    }

    /// Whether the armed crash has already fired.
    pub fn fired(&self) -> bool {
        !self.armed.load(Ordering::Acquire)
    }
}

impl FaultInjector for ScriptedFaults {
    fn poll(&self, point: FaultPoint) -> FaultAction {
        if point == self.point && self.armed.swap(false, Ordering::AcqRel) {
            FaultAction::Crash
        } else {
            FaultAction::Continue
        }
    }
}
