//! Watcher event vocabulary and an injectable stub source.
//!
//! The live OS watcher is a later shard (`plan §Workspace actor model`; the
//! watcher fault family `watch.overflow` is new-test work per `TEST_ORACLE.md`
//! §3.8). CAL-3's deliverable is the reconcile-on-dirty *logic*, so this module
//! provides only the event vocabulary and a stub source a test injects to drive
//! the [`crate::reconcile::ReconcileController`] into a dirty generation. Every
//! event kind coalesces to the same outcome — set the dirty flag — because
//! CAL-3 always resolves a dirty generation with a full bounded rescan; the
//! point being modeled is that overflow/uncertainty never drops a change.

use crate::reconcile::ReconcileController;
use std::collections::VecDeque;

/// A watcher event. Both kinds mark the generation dirty in CAL-3 (a full
/// rescan supersedes any per-path delta), so the modeled property is
/// coalescing-without-drop, not per-path routing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WatchEvent {
    /// The native watcher overflowed or dropped events — uncertainty. This is
    /// the canonical dirty-generation trigger.
    Overflow,
    /// A specific path changed. Modeled for completeness.
    Changed { path: String },
}

/// Apply one event to a controller: any event marks the generation dirty. Never
/// drops evidence — the controller's dirty flag stays set until a completed
/// reconcile clears it.
pub fn apply_event(controller: &mut ReconcileController, _event: &WatchEvent) {
    controller.mark_dirty();
}

/// An injectable stub event source: a bounded queue a test loads with events,
/// then drains into a controller. Stands in for the real native watcher.
#[derive(Debug, Default)]
pub struct StubWatchSource {
    queue: VecDeque<WatchEvent>,
    capacity: usize,
}

impl StubWatchSource {
    /// A stub source bounded to `capacity` queued events. Pushing beyond the
    /// bound is itself modeled as an overflow (the newest event is coalesced
    /// into an `Overflow`, never silently dropped).
    pub fn new(capacity: usize) -> Self {
        StubWatchSource {
            queue: VecDeque::new(),
            capacity: capacity.max(1),
        }
    }

    /// Push an event. If the bounded queue is full, the queue is collapsed to a
    /// single `Overflow` — coalescing under pressure, never dropping the
    /// evidence that *something* changed.
    pub fn push(&mut self, event: WatchEvent) {
        if self.queue.len() >= self.capacity {
            self.queue.clear();
            self.queue.push_back(WatchEvent::Overflow);
            return;
        }
        self.queue.push_back(event);
    }

    /// Number of queued events.
    pub fn len(&self) -> usize {
        self.queue.len()
    }

    /// Whether the source is empty.
    pub fn is_empty(&self) -> bool {
        self.queue.is_empty()
    }

    /// Drain every queued event into the controller, marking it dirty if any
    /// event was present. Returns whether the controller was marked dirty.
    pub fn drain_into(&mut self, controller: &mut ReconcileController) -> bool {
        let had_events = !self.queue.is_empty();
        for event in self.queue.drain(..) {
            apply_event(controller, &event);
        }
        had_events
    }
}
