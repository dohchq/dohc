use super::*;
use crate::NoFaults;
#[cfg(feature = "fault-injection")]
use crate::{FaultAction, FaultPoint};
use dohc_test_scratch::ScratchDir;

fn store(path: &Path) -> EngineStore {
    let mut store = EngineStore::open_for_actor(path, 1, None, None).unwrap();
    store
        .write_with(&NoFaults, |tx| {
            tx.execute_batch("CREATE TABLE undo_checkpoint_load(id INTEGER PRIMARY KEY, body BLOB)")
                .map_err(StorageError::persist)
        })
        .unwrap();
    finish_checkpoint(&store);
    drop(store);
    EngineStore::open_for_actor(path, 1, None, None).unwrap()
}
fn write(store: &mut EngineStore, id: i64) -> Result<TxnOutcome<usize>, StorageError> {
    store.write_background_with(&NoFaults, |tx| {
        tx.execute(
            "INSERT INTO undo_checkpoint_load VALUES(?1,?2)",
            rusqlite::params![id, vec![42_u8; 128 * 1024]],
        )
        .map_err(StorageError::persist)
    })
}
fn finish_checkpoint(store: &EngineStore) {
    let started = std::time::Instant::now();
    loop {
        let before = store.checkpoint_completed_for_test();
        store.checkpoints.as_ref().unwrap().request_full();
        store.wait_for_checkpoint_completion_for_test(before);
        let (log, backfilled): (i64, i64) = store
            .conn
            .query_row("PRAGMA main.wal_checkpoint(NOOP)", [], |r| {
                Ok((r.get(1)?, r.get(2)?))
            })
            .unwrap();
        if log < 0 || log == backfilled {
            return;
        }
        assert!(
            started.elapsed().as_secs() < 60,
            "background checkpoint never caught up"
        );
    }
}
#[test]
fn background_writes_finish_full_tails_without_writer_backfill() {
    let root = ScratchDir::new_named("undo-background-checkpoint").unwrap();
    let db = root.join("engine.db");
    let mut store = store(&db);
    let before = store.checkpoint_work_for_test().1;
    assert_eq!(before, 0);
    for id in 0..200 {
        loop {
            match write(&mut store, id) {
                Ok(TxnOutcome::Committed(_)) => break,
                Err(StorageError::FileLocked) => finish_checkpoint(&store),
                other => panic!("unexpected background write: {other:?}"),
            }
        }
    }
    finish_checkpoint(&store);
    assert_eq!(store.checkpoint_work_for_test().1, before);
    drop(store);
    let reopened = EngineStore::open_read_only(&db).unwrap();
    assert_eq!(
        reopened
            .read_with(|conn| conn.query_row(
                "SELECT count(*) FROM undo_checkpoint_load WHERE length(body)=131072",
                [],
                |r| r.get::<_, i64>(0)
            ))
            .unwrap(),
        200
    );
}
#[test]
fn a_pinned_wal_refuses_before_the_callback_then_resumes() {
    let root = ScratchDir::new_named("undo-background-pin").unwrap();
    let db = root.join("engine.db");
    let mut store = store(&db);
    write(&mut store, 0).unwrap();
    let reader = Connection::open(&db).unwrap();
    reader
        .execute_batch("BEGIN; SELECT * FROM undo_checkpoint_load")
        .unwrap();
    let mut refused = false;
    for id in 1..400 {
        let entered = std::cell::Cell::new(false);
        let outcome = store.write_background_with(&NoFaults, |tx| {
            entered.set(true);
            tx.execute(
                "INSERT INTO undo_checkpoint_load VALUES(?1,?2)",
                rusqlite::params![id, vec![42_u8; 128 * 1024]],
            )
            .map_err(StorageError::persist)
        });
        match outcome {
            Ok(TxnOutcome::Committed(_)) => {}
            Err(StorageError::FileLocked) => {
                assert!(!entered.get(), "WAL refusal reached the mutation callback");
                refused = true;
                break;
            }
            other => panic!("unexpected background write: {other:?}"),
        }
    }
    assert!(refused, "pinned WAL grew past its admission limit");
    reader.execute_batch("ROLLBACK").unwrap();
    finish_checkpoint(&store);
    assert!(matches!(
        write(&mut store, 1000).unwrap(),
        TxnOutcome::Committed(_)
    ));
}

#[cfg(feature = "fault-injection")]
struct CrashAt(FaultPoint);
#[cfg(feature = "fault-injection")]
impl FaultInjector for CrashAt {
    fn poll(&self, point: FaultPoint) -> FaultAction {
        if point == self.0 {
            FaultAction::Crash
        } else {
            FaultAction::Continue
        }
    }
}
#[test]
#[cfg(feature = "fault-injection")]
fn background_writes_preserve_both_crash_boundaries() {
    for (point, committed) in [
        (FaultPoint::StorageBeforePersist, false),
        (FaultPoint::StorageAfterCommitBeforeAck, true),
    ] {
        let root = ScratchDir::new_named("undo-background-crash").unwrap();
        let db = root.join("engine.db");
        let mut store = store(&db);
        let outcome = store
            .write_background_with(&CrashAt(point), |tx| {
                tx.execute("INSERT INTO undo_checkpoint_load VALUES(1,X'01')", [])
                    .map_err(StorageError::persist)
            })
            .unwrap();
        assert!(
            matches!(outcome, TxnOutcome::Crashed { committed: actual } if actual == committed)
        );
        drop(store);
        let reopened = EngineStore::open_read_only(&db).unwrap();
        assert_eq!(
            reopened
                .read_with(|conn| conn.query_row(
                    "SELECT count(*) FROM undo_checkpoint_load",
                    [],
                    |r| r.get::<_, i64>(0)
                ))
                .unwrap(),
            i64::from(committed)
        );
    }
}
