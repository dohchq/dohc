//! Scripted fault injection for the in-process crash tier.
//!
//! - [`ScriptedFaults`] arms a single crash at one named storage fault point
//!   and fires it exactly once, so a post-crash *retry* of the same operation
//!   runs without re-crashing (proving exactly-once recovery).
//! - [`PanicFaults`] panics inside `poll`, exercising the actor's panic-safe
//!   teardown (the panic originates in the injector, so the engine crates keep
//!   `#![forbid(unsafe_code)]` and carry no `panic!` in their own source).
//! - [`GateFaults`] blocks inside `poll` until released, wedging the actor's
//!   worker so a test can fill the bounded command queue and observe
//!   backpressure.

use dohc_engine_storage::{FaultAction, FaultInjector, FaultPoint};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};

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

/// An injector that panics the first time the armed point is reached. Used to
/// verify the actor publishes `Closed` on a worker panic and stays joinable.
pub struct PanicFaults {
    point: FaultPoint,
    armed: AtomicBool,
}

impl PanicFaults {
    /// Arm a one-shot panic at `point`.
    pub fn at(point: FaultPoint) -> Arc<Self> {
        Arc::new(PanicFaults {
            point,
            armed: AtomicBool::new(true),
        })
    }
}

impl FaultInjector for PanicFaults {
    fn poll(&self, point: FaultPoint) -> FaultAction {
        if point == self.point && self.armed.swap(false, Ordering::AcqRel) {
            panic!("injected worker panic at {}", point.as_str());
        }
        FaultAction::Continue
    }
}

/// An injector that blocks inside `poll` at the armed point until
/// [`GateFaults::release`] is called, then lets every future traversal proceed.
/// Wedging the worker this way lets a test back up the bounded command queue and
/// observe [`dohc_engine_runtime::RuntimeError::Overloaded`].
pub struct GateFaults {
    point: FaultPoint,
    open: Mutex<bool>,
    reached: Mutex<bool>,
    changed: Condvar,
}

impl GateFaults {
    /// Arm a gate at `point` (initially closed).
    pub fn at(point: FaultPoint) -> Arc<Self> {
        Arc::new(GateFaults {
            point,
            open: Mutex::new(false),
            reached: Mutex::new(false),
            changed: Condvar::new(),
        })
    }

    /// Block until the worker has reached (and is parked at) the gate.
    pub fn wait_until_reached(&self) {
        let mut reached = self.reached.lock().unwrap_or_else(|p| p.into_inner());
        while !*reached {
            reached = self
                .changed
                .wait(reached)
                .unwrap_or_else(|p| p.into_inner());
        }
    }

    /// Open the gate, releasing the parked worker and all future traversals.
    pub fn release(&self) {
        let mut open = self.open.lock().unwrap_or_else(|p| p.into_inner());
        *open = true;
        self.changed.notify_all();
    }
}

impl FaultInjector for GateFaults {
    fn poll(&self, point: FaultPoint) -> FaultAction {
        if point == self.point {
            {
                let mut reached = self.reached.lock().unwrap_or_else(|p| p.into_inner());
                *reached = true;
                self.changed.notify_all();
            }
            let mut open = self.open.lock().unwrap_or_else(|p| p.into_inner());
            while !*open {
                open = self.changed.wait(open).unwrap_or_else(|p| p.into_inner());
            }
        }
        FaultAction::Continue
    }
}
