use dohc_engine_files::CancellationToken;
use dohc_engine_runtime::RuntimeError;
use dohc_engine_storage::StorageError;
use std::cell::Cell;
use std::time::{Duration, Instant};

const BUSY_RETRY_LIMIT: Duration = Duration::from_secs(5);
const BUSY_RETRY_INTERVAL: Duration = Duration::from_millis(10);

/// Share a contention budget across the pass; a non-busy result ends the episode.
#[derive(Default)]
pub(super) struct CaptureBatchRetry {
    pub(super) cancel: CancellationToken,
    deadline: Cell<Option<Instant>>,
    #[cfg(test)]
    pub(super) wait: Option<Box<dyn Fn(Duration) + Send>>,
}

impl CaptureBatchRetry {
    pub(super) fn new(cancel: CancellationToken) -> Self {
        Self {
            cancel,
            ..Self::default()
        }
    }
    /// Single-file writes share the pass's contention state with batch writes.
    pub(super) fn observe<T>(&self, result: Result<T, RuntimeError>) -> Result<T, RuntimeError> {
        if !matches!(&result, Err(error) if crate::rpc::error::store_busy(error)) {
            self.deadline.set(None);
        }
        result
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
        self.run_with(attempt, Instant::now, |duration| {
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
            if self
                .deadline
                .get()
                .is_some_and(|deadline| now() >= deadline)
            {
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
                    let deadline = self.deadline.get().unwrap_or_else(|| {
                        let deadline = now() + BUSY_RETRY_LIMIT;
                        self.deadline.set(Some(deadline));
                        deadline
                    });
                    let remaining = deadline.saturating_duration_since(now());
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
                |_| retry.cancel.cancel(),
            ),
            Err(RuntimeError::Cancelled)
        ));
    }
}
