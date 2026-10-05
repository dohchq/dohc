//! Binding-owned, fixed-size counters for native filesystem work.

use serde::Serialize;
use std::sync::{Arc, Mutex};

const MAX_WIRE_COUNTER: u64 = (1 << 53) - 1;

fn add(total: &mut u64, value: u64) {
    *total = total.saturating_add(value).min(MAX_WIRE_COUNTER);
}

/// Cumulative work for one binding generation. Walk totals publish when the
/// operation ends; hash totals publish when each attempt ends. All values
/// saturate at JavaScript's maximum safe integer.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeWorkSnapshot {
    /// Invocations, including pre-cancelled calls and invalid roots.
    pub started: u64,
    pub active: u64,
    /// Full listings, including listings with unreadable paths.
    pub completed: u64,
    pub cancelled: u64,
    pub failed: u64,
    pub bounds_exceeded: u64,
    /// Raw directory entries consumed, including ignored paths and directories.
    pub entries_visited: u64,
    /// Admitted observation leaves or capture candidates; excludes skipped files.
    pub files_enumerated: u64,
    pub hashes_reused: u64,
    /// Finished hash attempts, including cancellation, I/O failure and panic.
    pub hash_attempts_completed: u64,
    /// Bytes returned by scanner hash reads, including abandoned attempts.
    pub bytes_read_for_hashing: u64,
}

/// Never held across filesystem work or actor waits. Snapshots do not enqueue work.
#[derive(Debug, Default, Clone)]
pub struct NativeWorkCounters(Arc<Mutex<NativeWorkSnapshot>>);

#[derive(Clone, Copy)]
pub(crate) enum WorkOutcome {
    Completed,
    Cancelled,
    Failed,
    BoundsExceeded,
}

impl NativeWorkCounters {
    pub fn snapshot(&self) -> NativeWorkSnapshot {
        *self
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    pub(crate) fn start(&self) -> WorkRun {
        let mut totals = self
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        add(&mut totals.started, 1);
        add(&mut totals.active, 1);
        WorkRun {
            counters: self.clone(),
            entries_visited: 0,
            files_enumerated: 0,
            hashes_reused: 0,
            outcome: WorkOutcome::Failed,
        }
    }

    pub(crate) fn hash_attempt(&self) -> HashAttempt {
        HashAttempt {
            counters: self.clone(),
            bytes: 0,
        }
    }
}

pub(crate) struct WorkRun {
    counters: NativeWorkCounters,
    pub(crate) entries_visited: u64,
    pub(crate) files_enumerated: u64,
    pub(crate) hashes_reused: u64,
    outcome: WorkOutcome,
}

impl WorkRun {
    pub(crate) fn finish(&mut self, outcome: WorkOutcome) {
        self.outcome = outcome;
    }
}

impl Drop for WorkRun {
    fn drop(&mut self) {
        let mut totals = self
            .counters
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        totals.active = totals.active.saturating_sub(1);
        match self.outcome {
            WorkOutcome::Completed => add(&mut totals.completed, 1),
            WorkOutcome::Cancelled => add(&mut totals.cancelled, 1),
            WorkOutcome::Failed => add(&mut totals.failed, 1),
            WorkOutcome::BoundsExceeded => add(&mut totals.bounds_exceeded, 1),
        }
        add(&mut totals.entries_visited, self.entries_visited);
        add(&mut totals.files_enumerated, self.files_enumerated);
        add(&mut totals.hashes_reused, self.hashes_reused);
    }
}

pub(crate) struct HashAttempt {
    counters: NativeWorkCounters,
    pub(crate) bytes: u64,
}

impl Drop for HashAttempt {
    fn drop(&mut self) {
        let mut totals = self
            .counters
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        add(&mut totals.hash_attempts_completed, 1);
        add(&mut totals.bytes_read_for_hashing, self.bytes);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshots_do_not_finish_or_start_active_work() {
        let counters = NativeWorkCounters::default();
        let mut run = counters.start();
        run.entries_visited = 3;
        let snapshot = counters.snapshot();
        assert_eq!(snapshot.started, 1);
        assert_eq!(snapshot.active, 1);
        assert_eq!(snapshot.entries_visited, 0);
        assert_eq!(counters.snapshot(), snapshot);
        run.finish(WorkOutcome::Cancelled);
        drop(run);
        let snapshot = counters.snapshot();
        assert_eq!(snapshot.active, 0);
        assert_eq!(snapshot.cancelled, 1);
        assert_eq!(snapshot.entries_visited, 3);
        assert_eq!(
            NativeWorkCounters::default().snapshot(),
            NativeWorkSnapshot::default()
        );
    }

    #[test]
    fn unwinding_retains_partial_work_and_read_bytes() {
        let counters = NativeWorkCounters::default();
        let _ = std::panic::catch_unwind(|| {
            let mut run = counters.start();
            run.files_enumerated = 2;
            let mut attempt = counters.hash_attempt();
            attempt.bytes = 17;
            panic!("abandoned native work");
        });
        let snapshot = counters.snapshot();
        assert_eq!(snapshot.active, 0);
        assert_eq!(snapshot.failed, 1);
        assert_eq!(snapshot.files_enumerated, 2);
        assert_eq!(snapshot.hash_attempts_completed, 1);
        assert_eq!(snapshot.bytes_read_for_hashing, 17);
    }

    #[test]
    fn wire_counters_saturate_at_safe_integers() {
        let counters = NativeWorkCounters::default();
        for _ in 0..2 {
            let mut run = counters.start();
            run.entries_visited = u64::MAX;
            run.finish(WorkOutcome::Completed);
            let mut attempt = counters.hash_attempt();
            attempt.bytes = u64::MAX;
        }
        let snapshot = counters.snapshot();
        assert_eq!(snapshot.entries_visited, MAX_WIRE_COUNTER);
        assert_eq!(snapshot.bytes_read_for_hashing, MAX_WIRE_COUNTER);
    }
}
