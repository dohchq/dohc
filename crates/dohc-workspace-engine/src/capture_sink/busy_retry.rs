use dohc_engine_files::CancellationToken;
use dohc_engine_runtime::RuntimeError;
use std::time::{Duration, Instant};

const BUSY_RETRY_LIMIT: Duration = Duration::from_secs(5);
const BUSY_RETRY_INTERVAL: Duration = Duration::from_millis(10);

/// Each bounded batch gets one budget. Wait on the capture worker, never the actor.
#[derive(Default)]
pub(super) struct CaptureBatchRetry {
    pub(super) cancel: CancellationToken,
    #[cfg(test)]
    pub(super) wait: Option<Box<dyn Fn(Duration) + Send>>,
}

impl CaptureBatchRetry {
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
        // Healthy work between batches must not consume a later batch's budget.
        let mut deadline = None;
        loop {
            if self.cancel.is_cancelled() {
                return Err(RuntimeError::Cancelled);
            }
            match attempt() {
                Err(error) if crate::rpc::error::store_busy(&error) => {
                    let deadline = *deadline.get_or_insert_with(|| now() + BUSY_RETRY_LIMIT);
                    let remaining = deadline.saturating_duration_since(now());
                    if remaining.is_zero() {
                        return Err(error);
                    }
                    wait(remaining.min(BUSY_RETRY_INTERVAL));
                }
                result => return result,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use dohc_engine_storage::StorageError;
    use std::cell::Cell;

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
    fn each_batch_budget_is_bounded_and_cancellable() {
        let retry = CaptureBatchRetry::default();
        let start = Instant::now();
        let clock = Cell::new(start);
        for _ in 0..2 {
            let before = clock.get();
            assert!(matches!(
                retry.run_with(
                    || Err::<(), _>(RuntimeError::Storage(StorageError::FileLocked)),
                    || clock.get(),
                    |wait| clock.set(clock.get() + wait),
                ),
                Err(RuntimeError::Storage(StorageError::FileLocked))
            ));
            assert_eq!(clock.get() - before, BUSY_RETRY_LIMIT);
        }
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
