use dohc_engine_files::CancellationToken;
use dohc_engine_runtime::{CheckpointCycle, RuntimeError};
use dohc_engine_storage::{CheckpointWait, StorageError};
use std::cell::Cell;
use std::time::{Duration, Instant};

const BUSY_RETRY_LIMIT: Duration = Duration::from_secs(5);
// A running checkpoint restarts the limit above, so this bounds the whole wait.
// Copying a 7,000-frame WAL back took up to 3.9 s on a loaded 4-core Linux VM.
const BUSY_RETRY_CEILING: Duration = Duration::from_secs(15);
const BUSY_RETRY_INTERVAL: Duration = Duration::from_millis(10);

/// Share a contention budget across the pass; a non-busy result ends the episode.
/// The episode starts at its first busy result. Time while a checkpoint is
/// still copying pages does not count against the limit, since only an idle or
/// finished cycle shows persistent contention. The ceiling bounds it either way.
#[derive(Default)]
pub(super) struct CaptureBatchRetry {
    pub(super) cancel: CancellationToken,
    checkpoint: Option<CheckpointCycle>,
    deadline: Cell<Option<Instant>>,
    ceiling: Cell<Option<Instant>>,
    exhausted: Cell<bool>,
    #[cfg(test)]
    pub(super) wait: Option<Box<dyn Fn(Duration) + Send>>,
}

impl CaptureBatchRetry {
    pub(super) fn new(cancel: CancellationToken, checkpoint: CheckpointCycle) -> Self {
        Self {
            cancel,
            checkpoint: Some(checkpoint),
            ..Self::default()
        }
    }
    /// Single-file writes share the pass's contention state with batch writes.
    pub(super) fn observe<T>(&self, result: Result<T, RuntimeError>) -> Result<T, RuntimeError> {
        if !matches!(&result, Err(error) if crate::rpc::error::store_busy(error)) {
            self.deadline.set(None);
            self.ceiling.set(None);
            self.exhausted.set(false);
        }
        result
    }

    /// Let healthy single-file work end contention even after the retry budget expires.
    pub(super) fn run_single<T>(
        &self,
        attempt: impl FnMut() -> Result<T, RuntimeError>,
    ) -> Result<T, RuntimeError> {
        self.retry(true, attempt)
    }

    #[cfg(test)]
    pub(super) fn exhaust_for_test(&self) {
        self.exhausted.set(true);
    }

    pub(super) fn run<T>(
        &self,
        attempt: impl FnMut() -> Result<T, RuntimeError>,
    ) -> Result<T, RuntimeError> {
        self.retry(false, attempt)
    }

    fn retry<T>(
        &self,
        probe: bool,
        attempt: impl FnMut() -> Result<T, RuntimeError>,
    ) -> Result<T, RuntimeError> {
        let checkpoint = || {
            self.checkpoint
                .as_ref()
                .map_or(CheckpointWait::Finished, |cycle| cycle())
        };
        self.run_with(probe, attempt, Instant::now, checkpoint, |duration| {
            #[cfg(test)]
            if let Some(wait) = &self.wait {
                wait(duration);
                return;
            }
            std::thread::sleep(duration);
        })
    }

    /// `probe` makes one attempt even after the budget is spent.
    fn run_with<T>(
        &self,
        mut probe: bool,
        mut attempt: impl FnMut() -> Result<T, RuntimeError>,
        now: impl Fn() -> Instant,
        checkpoint: impl Fn() -> CheckpointWait,
        mut wait: impl FnMut(Duration),
    ) -> Result<T, RuntimeError> {
        #[cfg(feature = "harness")]
        let mut phase =
            dohc_engine_storage::capture_phase::Phase::new("capture_busy_retry", None, 0, true);
        loop {
            if self.cancel.is_cancelled() {
                #[cfg(feature = "harness")]
                phase.finish("cancelled");
                return self.observe(Err(RuntimeError::Cancelled));
            }
            // Only the ceiling is checked here. The limit is checked after the
            // store says whether a checkpoint is still running.
            let spent =
                self.exhausted.get() || self.ceiling.get().is_some_and(|ceiling| now() >= ceiling);
            if !std::mem::take(&mut probe) && spent {
                #[cfg(feature = "harness")]
                phase.finish("busy-budget-exhausted");
                return Err(RuntimeError::Storage(StorageError::FileLocked));
            }
            #[cfg(feature = "harness")]
            dohc_engine_storage::capture_phase::count("retry_attempts", 1);
            match attempt() {
                Err(error) if crate::rpc::error::store_busy(&error) => {
                    #[cfg(feature = "harness")]
                    dohc_engine_storage::capture_phase::count("FileLocked_hits", 1);
                    if self.exhausted.get() {
                        #[cfg(feature = "harness")]
                        phase.finish("busy-budget-exhausted");
                        return Err(error);
                    }
                    let busy_at = now();
                    let ceiling = self.ceiling.get().unwrap_or(busy_at + BUSY_RETRY_CEILING);
                    let mut deadline = self.deadline.get().unwrap_or(busy_at + BUSY_RETRY_LIMIT);
                    if matches!(checkpoint(), CheckpointWait::Running) {
                        deadline = now() + BUSY_RETRY_LIMIT;
                    }
                    self.ceiling.set(Some(ceiling));
                    self.deadline.set(Some(deadline));
                    let remaining = deadline.min(ceiling).saturating_duration_since(now());
                    if remaining.is_zero() {
                        self.exhausted.set(true);
                        #[cfg(feature = "harness")]
                        phase.finish("busy-budget-exhausted");
                        return Err(error);
                    }
                    #[cfg(feature = "harness")]
                    let _wait_phase =
                        dohc_engine_storage::capture_phase::Measure::new("retry_wait");
                    wait(remaining.min(BUSY_RETRY_INTERVAL));
                }
                result => {
                    #[cfg(feature = "harness")]
                    phase.finish(if result.is_ok() {
                        "success"
                    } else {
                        "non-busy-error"
                    });
                    return self.observe(result);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exhausted_single_file_probes_once_without_extending_the_budget() {
        let retry = CaptureBatchRetry::default();
        retry.exhaust_for_test();
        let attempts = Cell::new(0);
        assert!(matches!(
            retry.run_single(|| {
                attempts.set(attempts.get() + 1);
                Err::<(), _>(RuntimeError::Storage(StorageError::FileLocked))
            }),
            Err(RuntimeError::Storage(StorageError::FileLocked))
        ));
        assert_eq!(attempts.get(), 1);
        assert!(matches!(
            retry.run(|| Ok(())),
            Err(RuntimeError::Storage(StorageError::FileLocked))
        ));
        retry.run_single(|| Ok(())).unwrap();
        retry.run(|| Ok(())).unwrap();
    }

    // dohc#3621. Waiting for a switch's write is not contention. The store's
    // answer stays the same until replay, so one attempt settles the path.
    #[test]
    fn a_capture_waiting_for_a_switch_is_attempted_once() {
        let retry = CaptureBatchRetry::default();
        let attempts = Cell::new(0);
        let waits = || {
            attempts.set(attempts.get() + 1);
            Err::<(), _>(RuntimeError::Sync(
                dohc_engine_sync::SyncError::RetryableState {
                    reason: dohc_engine_runtime::actor::CAPTURE_WAITS_FOR_SWITCH,
                },
            ))
        };
        assert!(retry.run_single(waits).is_err());
        assert!(retry.run(waits).is_err());
        assert_eq!(attempts.get(), 2);
    }

    #[test]
    fn later_batch_gets_a_fresh_budget_after_healthy_work() {
        let retry = CaptureBatchRetry::default();
        let start = Instant::now();
        let clock = Cell::new(start);
        for elapsed in [Duration::ZERO, Duration::from_secs(6)] {
            clock.set(start + elapsed);
            let attempts = Cell::new(0);
            retry
                .run_with(
                    false,
                    || {
                        attempts.set(attempts.get() + 1);
                        if attempts.get() == 1 {
                            Err(RuntimeError::Storage(StorageError::FileLocked))
                        } else {
                            Ok(())
                        }
                    },
                    || clock.get(),
                    || CheckpointWait::Finished,
                    |wait| clock.set(clock.get() + wait),
                )
                .unwrap();
            assert_eq!(attempts.get(), 2);
            assert_eq!(clock.get() - start, elapsed + BUSY_RETRY_INTERVAL);
        }
    }

    #[test]
    fn non_busy_failure_ends_the_episode_before_a_later_batch() {
        let retry = CaptureBatchRetry::default();
        let start = Instant::now();
        let clock = Cell::new(start);
        let attempts = Cell::new(0);
        assert!(matches!(
            retry.run_with(
                false,
                || {
                    attempts.set(attempts.get() + 1);
                    if attempts.get() == 1 {
                        Err::<(), _>(RuntimeError::Storage(StorageError::FileLocked))
                    } else {
                        Err(RuntimeError::OperationCrashed)
                    }
                },
                || clock.get(),
                || CheckpointWait::Finished,
                |wait| clock.set(clock.get() + wait),
            ),
            Err(RuntimeError::OperationCrashed)
        ));
        assert_eq!(attempts.get(), 2);
        clock.set(start + Duration::from_secs(6));
        attempts.set(0);
        retry
            .run_with(
                false,
                || {
                    attempts.set(attempts.get() + 1);
                    if attempts.get() == 1 {
                        Err(RuntimeError::Storage(StorageError::FileLocked))
                    } else {
                        Ok(())
                    }
                },
                || clock.get(),
                || CheckpointWait::Finished,
                |wait| clock.set(clock.get() + wait),
            )
            .unwrap();
        assert_eq!(attempts.get(), 2);
        assert_eq!(
            clock.get() - start,
            Duration::from_secs(6) + BUSY_RETRY_INTERVAL
        );
    }

    #[test]
    fn steady_contention_bounds_the_whole_pass_and_is_cancellable() {
        let retry = CaptureBatchRetry::default();
        let start = Instant::now();
        let clock = Cell::new(start);
        let attempts = Cell::new(0);
        let mut first_batch_attempts = 0;
        for batch in 0..5 {
            assert!(matches!(
                retry.run_with(
                    false,
                    || {
                        attempts.set(attempts.get() + 1);
                        Err::<(), _>(RuntimeError::Storage(StorageError::FileLocked))
                    },
                    || clock.get(),
                    || CheckpointWait::Finished,
                    |wait| {
                        assert_eq!(batch, 0, "later batches must not extend the pass's wait");
                        clock.set(clock.get() + wait);
                    },
                ),
                Err(RuntimeError::Storage(StorageError::FileLocked))
            ));
            assert_eq!(clock.get() - start, BUSY_RETRY_LIMIT);
            if batch == 0 {
                first_batch_attempts = attempts.get();
                assert!(first_batch_attempts > 0);
            } else {
                assert_eq!(
                    attempts.get(),
                    first_batch_attempts,
                    "exhaustion must stop actor attempts too"
                );
            }
        }
        let retry = CaptureBatchRetry::default();
        assert!(matches!(
            retry.run_with(
                false,
                || Err::<(), _>(RuntimeError::Storage(StorageError::FileLocked)),
                || start,
                || CheckpointWait::Finished,
                |_| retry.cancel.cancel(),
            ),
            Err(RuntimeError::Cancelled)
        ));
    }

    /// Busy until `until`, then healthy, with a fake clock that each wait advances.
    fn contend(
        retry: &CaptureBatchRetry,
        until: Duration,
        checkpoint: impl Fn(Duration) -> CheckpointWait,
    ) -> (Result<(), RuntimeError>, Duration) {
        let start = Instant::now();
        let clock = Cell::new(start);
        let result = retry.run_with(
            false,
            || {
                if clock.get() - start < until {
                    Err(RuntimeError::Storage(StorageError::FileLocked))
                } else {
                    Ok(())
                }
            },
            || clock.get(),
            || checkpoint(clock.get() - start),
            |wait| clock.set(clock.get() + wait),
        );
        (result, clock.get() - start)
    }

    #[test]
    fn a_running_checkpoint_does_not_spend_the_busy_limit() {
        let retry = CaptureBatchRetry::default();
        let (result, elapsed) =
            contend(&retry, Duration::from_secs(6), |_| CheckpointWait::Running);
        result.unwrap();
        assert_eq!(elapsed, Duration::from_secs(6));
    }

    #[test]
    fn contention_after_a_checkpoint_finishes_fails_after_the_limit() {
        let retry = CaptureBatchRetry::default();
        let running = Duration::from_secs(3);
        let (result, elapsed) = contend(&retry, Duration::MAX, |at| {
            if at <= running {
                CheckpointWait::Running
            } else {
                CheckpointWait::Finished
            }
        });
        assert!(matches!(
            result,
            Err(RuntimeError::Storage(StorageError::FileLocked))
        ));
        assert_eq!(elapsed, running + BUSY_RETRY_LIMIT);
    }

    #[test]
    fn a_checkpoint_that_never_finishes_fails_at_the_ceiling() {
        let retry = CaptureBatchRetry::default();
        let (result, elapsed) = contend(&retry, Duration::MAX, |_| CheckpointWait::Running);
        assert!(matches!(
            result,
            Err(RuntimeError::Storage(StorageError::FileLocked))
        ));
        assert_eq!(elapsed, BUSY_RETRY_CEILING);
    }

    #[test]
    fn a_late_wake_during_a_running_checkpoint_asks_the_store_again() {
        let retry = CaptureBatchRetry::default();
        let start = Instant::now();
        let clock = Cell::new(start);
        let woke_late = Cell::new(false);
        retry
            .run_with(
                false,
                || {
                    if clock.get() - start < Duration::from_secs(7) {
                        Err(RuntimeError::Storage(StorageError::FileLocked))
                    } else {
                        Ok(())
                    }
                },
                || clock.get(),
                || CheckpointWait::Running,
                |wait| {
                    // The sink thread resumes 6 s late once, past the limit.
                    let late = if woke_late.replace(true) {
                        Duration::ZERO
                    } else {
                        Duration::from_secs(6)
                    };
                    clock.set(clock.get() + wait.max(late));
                },
            )
            .unwrap();
        assert_eq!(clock.get() - start, Duration::from_secs(7));
    }

    #[test]
    fn the_wait_for_the_store_counts_against_the_limit() {
        let retry = CaptureBatchRetry::default();
        let start = Instant::now();
        let clock = Cell::new(start);
        let asked = Duration::from_millis(100);
        assert!(matches!(
            retry.run_with(
                false,
                || Err::<(), _>(RuntimeError::Storage(StorageError::FileLocked)),
                || clock.get(),
                || {
                    clock.set(clock.get() + asked);
                    CheckpointWait::Finished
                },
                |wait| clock.set(clock.get() + wait),
            ),
            Err(RuntimeError::Storage(StorageError::FileLocked))
        ));
        assert!(clock.get() - start < BUSY_RETRY_LIMIT + asked);
    }

    #[test]
    fn a_single_file_probe_starts_the_ceiling() {
        let retry = CaptureBatchRetry::default();
        let start = Instant::now();
        let clock = Cell::new(start);
        let attempts = Cell::new(0);
        assert!(matches!(
            retry.run_with(
                true,
                || {
                    attempts.set(attempts.get() + 1);
                    if attempts.get() == 2 {
                        // The second actor attempt takes 4 s to answer.
                        clock.set(clock.get() + Duration::from_secs(4));
                    }
                    Err::<(), _>(RuntimeError::Storage(StorageError::FileLocked))
                },
                || clock.get(),
                || CheckpointWait::Running,
                |wait| clock.set(clock.get() + wait),
            ),
            Err(RuntimeError::Storage(StorageError::FileLocked))
        ));
        assert_eq!(clock.get() - start, BUSY_RETRY_CEILING);
    }
}
