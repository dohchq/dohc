use dohc_engine_files::CancellationToken;
use dohc_engine_runtime::RuntimeError;
use dohc_engine_storage::StorageError;
use std::cell::Cell;
use std::time::{Duration, Instant};

const BUSY_RETRY_LIMIT: Duration = Duration::from_secs(5);
const BUSY_RETRY_INTERVAL: Duration = Duration::from_millis(10);

/// Share a contention budget across the pass; a success starts a new episode.
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
        loop {
            if self.cancel.is_cancelled() {
                return Err(RuntimeError::Cancelled);
            }
            if self
                .deadline
                .get()
                .is_some_and(|deadline| now() >= deadline)
            {
                return Err(RuntimeError::Storage(StorageError::FileLocked));
            }
            match attempt() {
                Err(error) if crate::rpc::error::store_busy(&error) => {
                    let deadline = self.deadline.get().unwrap_or_else(|| {
                        let deadline = now() + BUSY_RETRY_LIMIT;
                        self.deadline.set(Some(deadline));
                        deadline
                    });
                    let remaining = deadline.saturating_duration_since(now());
                    if remaining.is_zero() {
                        return Err(error);
                    }
                    wait(remaining.min(BUSY_RETRY_INTERVAL));
                }
                Ok(value) => {
                    self.deadline.set(None);
                    return Ok(value);
                }
                Err(error) => return Err(error),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
