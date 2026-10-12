use dohc_engine_files::CancellationToken;
use dohc_engine_runtime::RuntimeError;
use std::cell::Cell;
use std::time::{Duration, Instant};

const BUSY_RETRY_LIMIT: Duration = Duration::from_secs(5);
const BUSY_RETRY_INTERVAL: Duration = Duration::from_millis(10);

/// One budget across this pass's batches. Wait on the capture worker, never the actor.
#[derive(Default)]
pub(super) struct CaptureBatchRetry {
    pub(super) cancel: CancellationToken,
    deadline: Cell<Option<Instant>>,
}

impl CaptureBatchRetry {
    pub(super) fn run<T>(
        &self,
        attempt: impl FnMut() -> Result<T, RuntimeError>,
    ) -> Result<T, RuntimeError> {
        self.run_with(attempt, Instant::now, std::thread::sleep)
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
                result => return result,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use dohc_engine_storage::{EngineStore, NoFaults, StorageError, TxnOutcome};
    use dohc_engine_testkit::ScratchDir;

    #[test]
    fn capture_batch_busy_clears_without_a_failed_receipt_or_rescan() {
        let scratch = ScratchDir::new().unwrap();
        let db = scratch.path().join("engine.db");
        let mut store = EngineStore::open_for_actor(&db, 1, None, None).unwrap();
        store
            .write_with(&NoFaults, |tx| {
                tx.execute_batch("CREATE TABLE payload(body BLOB)")
                    .map_err(StorageError::persist_public)
            })
            .unwrap();
        let reader = rusqlite::Connection::open(&db).unwrap();
        reader
            .execute_batch("BEGIN; SELECT count(*) FROM payload")
            .unwrap();
        store
            .write_with(&NoFaults, |tx| {
                tx.execute("INSERT INTO payload VALUES(zeroblob(28*1024*1024))", [])
                    .map_err(StorageError::persist_public)
            })
            .unwrap();
        let retry = CaptureBatchRetry::default();
        let refused = Cell::new(0);
        let released = Cell::new(false);
        let result = retry.run_with(
            || {
                let result = store.write_with(&NoFaults, |tx| {
                    tx.execute("INSERT INTO payload VALUES('next capture batch')", [])
                        .map_err(StorageError::persist_public)
                });
                if matches!(result, Err(StorageError::FileLocked)) {
                    refused.set(refused.get() + 1);
                }
                result.map_err(RuntimeError::from)
            },
            Instant::now,
            |duration| {
                if !released.replace(true) {
                    reader.execute_batch("ROLLBACK").unwrap();
                }
                std::thread::sleep(duration);
            },
        );
        assert!(matches!(result, Ok(TxnOutcome::Committed(1))), "{result:?}");
        assert!(
            refused.get() > 0,
            "the real write gate must refuse before reader release"
        );
        let rows = store
            .read_with(|c| c.query_row("SELECT count(*) FROM payload", [], |r| r.get::<_, i64>(0)))
            .unwrap();
        assert_eq!(rows, 2, "the successful retry must commit exactly once");
    }

    #[test]
    fn capture_batch_busy_budget_is_shared_bounded_and_cancellable() {
        let retry = CaptureBatchRetry::default();
        let start = Instant::now();
        let clock = Cell::new(start);
        let attempts = Cell::new(0);
        let busy = || {
            attempts.set(attempts.get() + 1);
            Err::<(), _>(RuntimeError::Storage(StorageError::FileLocked))
        };
        assert!(matches!(
            retry.run_with(busy, || clock.get(), |wait| clock.set(clock.get() + wait)),
            Err(RuntimeError::Storage(StorageError::FileLocked))
        ));
        assert_eq!(clock.get() - start, BUSY_RETRY_LIMIT);
        let before = attempts.get();
        assert!(
            retry
                .run_with(
                    busy,
                    || clock.get(),
                    |_| panic!("a later batch must not get another budget")
                )
                .is_err()
        );
        assert_eq!(attempts.get(), before + 1);
        let retry = CaptureBatchRetry::default();
        assert!(matches!(
            retry.run_with(busy, || start, |_| retry.cancel.cancel()),
            Err(RuntimeError::Cancelled)
        ));
    }
}
