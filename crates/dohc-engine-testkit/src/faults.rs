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
mod wait_flag {
    use super::{Condvar, Mutex};

    /// One sticky predicate and its permanently paired condition variable.
    /// Private fields prevent callers from waiting on `changed` with any other
    /// mutex guard.
    pub(super) struct WaitFlag {
        value: Mutex<bool>,
        changed: Condvar,
    }

    impl WaitFlag {
        pub(super) fn new() -> Self {
            Self {
                value: Mutex::new(false),
                changed: Condvar::new(),
            }
        }

        pub(super) fn wait(&self) {
            let mut value = self.value.lock().unwrap_or_else(|p| p.into_inner());
            while !*value {
                value = self.changed.wait(value).unwrap_or_else(|p| p.into_inner());
            }
        }

        pub(super) fn set(&self) {
            let mut value = self.value.lock().unwrap_or_else(|p| p.into_inner());
            *value = true;
            self.changed.notify_all();
        }

        #[cfg(test)]
        pub(super) fn pair_addresses(&self) -> (*const Mutex<bool>, *const Condvar) {
            (
                std::ptr::from_ref(&self.value),
                std::ptr::from_ref(&self.changed),
            )
        }
    }
}

use wait_flag::WaitFlag;

pub struct GateFaults {
    point: FaultPoint,
    open: WaitFlag,
    reached: WaitFlag,
}

impl GateFaults {
    /// Arm a gate at `point` (initially closed).
    pub fn at(point: FaultPoint) -> Arc<Self> {
        Arc::new(GateFaults {
            point,
            open: WaitFlag::new(),
            reached: WaitFlag::new(),
        })
    }

    /// Block until the worker has reached (and is parked at) the gate.
    pub fn wait_until_reached(&self) {
        self.reached.wait();
    }

    /// Open the gate, releasing the parked worker and all future traversals.
    pub fn release(&self) {
        self.open.set();
    }
}

impl FaultInjector for GateFaults {
    fn poll(&self, point: FaultPoint) -> FaultAction {
        if point == self.point {
            self.reached.set();
            self.open.wait();
        }
        FaultAction::Continue
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gate_conditions_own_distinct_mutex_condvar_pairs() {
        let gate = GateFaults::at(FaultPoint::StorageBeforePersist);
        let reached = gate.reached.pair_addresses();
        let open = gate.open.pair_addresses();

        // MUTATION: collapse the two conditions back onto one mutex or one
        // Condvar and the corresponding address assertion fails.
        assert_ne!(reached.0, open.0, "conditions must not share a mutex");
        assert_ne!(reached.1, open.1, "conditions must not share a condvar");
    }
}
