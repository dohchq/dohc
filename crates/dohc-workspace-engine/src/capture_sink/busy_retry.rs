use dohc_engine_files::CancellationToken;
use dohc_engine_runtime::{ActorHandle, RuntimeError};
use dohc_engine_storage::{CheckpointWait, StorageError};
use std::cell::{Cell, OnceCell};
use std::sync::Arc;
use std::time::{Duration, Instant};

const BUSY_RETRY_LIMIT: Duration = Duration::from_secs(5);
// A running checkpoint restarts the limit above, so this bounds the whole wait.
// Copying a 7,000-frame WAL back took up to 3.9 s on a loaded 4-core Linux VM.
const BUSY_RETRY_CEILING: Duration = Duration::from_secs(15);
const BUSY_RETRY_INTERVAL: Duration = Duration::from_millis(10);

type CheckpointCycle = Arc<dyn Fn() -> CheckpointWait + Send + Sync>;

/// Share a contention budget across the pass; a non-busy result ends the episode.
/// Time while a checkpoint is still copying pages does not count against the
/// limit, since only an idle or finished cycle shows persistent contention.
#[derive(Default)]
pub(super) struct CaptureBatchRetry {
    pub(super) cancel: CancellationToken,
    actor: Option<ActorHandle>,
    checkpoint: OnceCell<Option<CheckpointCycle>>,
    deadline: Cell<Option<Instant>>,
    ceiling: Cell<Option<Instant>>,
    #[cfg(test)]
    pub(super) wait: Option<Box<dyn Fn(Duration) + Send>>,
}

impl CaptureBatchRetry {
    pub(super) fn new(cancel: CancellationToken, actor: ActorHandle) -> Self {
        Self {
            cancel,
            actor: Some(actor),
            ..Self::default()
        }
    }
    /// Single-file writes share the pass's contention state with batch writes.
    pub(super) fn observe<T>(&self, result: Result<T, RuntimeError>) -> Result<T, RuntimeError> {
        if !matches!(&result, Err(error) if crate::rpc::error::store_busy(error)) {
            self.deadline.set(None);
            self.ceiling.set(None);
        }
        result
    }

    fn exhausted(&self, now: Instant) -> bool {
        [self.deadline.get(), self.ceiling.get()]
            .into_iter()
            .flatten()
            .any(|limit| now >= limit)
    }

    /// Let healthy single-file work end contention even after the retry budget expires.
    pub(super) fn run_single<T>(
        &self,
        mut attempt: impl FnMut() -> Result<T, RuntimeError>,
    ) -> Result<T, RuntimeError> {
        if self.cancel.is_cancelled() {
            return self.observe(Err(RuntimeError::Cancelled));
        }
        match self.observe(attempt()) {
            Err(error) if crate::rpc::error::store_busy(&error) => self.run(attempt),
            result => result,
        }
    }

    #[cfg(test)]
    pub(super) fn exhaust_for_test(&self) {
        self.deadline.set(Some(Instant::now()));
    }

    pub(super) fn run<T>(
        &self,
        attempt: impl FnMut() -> Result<T, RuntimeError>,
    ) -> Result<T, RuntimeError> {
        let checkpoint = || {
            // Fetched on the first busy result only. Without it, every wait
            // counts, as it would with no checkpoint running.
            let cycle = self.checkpoint.get_or_init(|| {
                self.actor
                    .as_ref()
                    .and_then(|actor| actor.checkpoint_cycle_blocking().ok())
            });
            cycle
                .as_ref()
                .map_or(CheckpointWait::Finished, |cycle| cycle())
        };
        self.run_with(attempt, Instant::now, checkpoint, |duration| {
            #[cfg(test)]
            if let Some(wait) = &self.wait {
                wait(duration);
                return;
            }
            std::thread::sleep(duration);
        })
    }

    fn run_with<T>(
        &self,
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
            if self.exhausted(now()) {
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
                    let ceiling = self.ceiling.get().unwrap_or_else(|| {
                        let ceiling = now() + BUSY_RETRY_CEILING;
                        self.ceiling.set(Some(ceiling));
                        ceiling
                    });
                    let deadline = match (checkpoint(), self.deadline.get()) {
                        (CheckpointWait::Finished, Some(deadline)) => deadline,
                        _ => now() + BUSY_RETRY_LIMIT,
                    };
                    self.deadline.set(Some(deadline));
                    let remaining = deadline.min(ceiling).saturating_duration_since(now());
                    if remaining.is_zero() {
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
}
