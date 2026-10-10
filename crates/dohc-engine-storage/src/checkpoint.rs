use rusqlite::{Connection, OpenFlags};
use std::path::Path;
use std::sync::mpsc::{self, SyncSender};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use std::thread::JoinHandle;

const BACKGROUND_CHECKPOINT_FRAMES: i64 = 1000;
const WRITER_CHECKPOINT_FRAMES: i64 = 2000;
const MAX_WRITER_BACKFILL_FRAMES: i64 = 1000;
const MAX_PENDING_WAL_FRAMES: i64 = 6000;
const MAX_CHECKPOINT_HANDOFF_WAIT: std::time::Duration = std::time::Duration::from_millis(5);

/// PASSIVE checkpoints use a separate connection, including during capture.
#[derive(Debug)]
pub(crate) struct Checkpoints {
    requests: Option<SyncSender<()>>,
    thread: Option<JoinHandle<()>>,
    stopped: Arc<AtomicBool>,
    completed: Arc<(std::sync::Mutex<u64>, std::sync::Condvar)>,
    #[cfg(test)]
    writer_max: std::sync::atomic::AtomicI64,
    #[cfg(test)]
    writer_calls: std::sync::atomic::AtomicU64,
}

fn frames(conn: &Connection) -> rusqlite::Result<(i64, i64)> {
    conn.query_row("PRAGMA main.wal_checkpoint(NOOP)", [], |row| {
        Ok((row.get(1)?, row.get(2)?))
    })
}

impl Checkpoints {
    pub(crate) fn start(path: &Path) -> Result<Self, crate::StorageError> {
        let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_WRITE)
            .map_err(crate::StorageError::persist)?;
        conn.busy_timeout(std::time::Duration::ZERO)
            .map_err(crate::StorageError::persist)?;
        conn.pragma_update(None, "synchronous", "NORMAL")
            .map_err(crate::StorageError::persist)?;
        let (requests, rx) = mpsc::sync_channel(1);
        let stopped = Arc::new(AtomicBool::new(false));
        let worker_stopped = Arc::clone(&stopped);
        let completed = Arc::new((std::sync::Mutex::new(0), std::sync::Condvar::new()));
        let worker_completed = Arc::clone(&completed);
        let thread = std::thread::Builder::new()
            .name("dohc-wal-checkpoint".into())
            .spawn(move || {
                while rx.recv().is_ok() {
                    if frames(&conn).is_ok_and(|(log, backfilled)| {
                        log - backfilled >= BACKGROUND_CHECKPOINT_FRAMES
                    }) {
                        catch_up(&conn, &worker_stopped);
                    }
                    let (sequence, signal) = &*worker_completed;
                    *sequence.lock().unwrap() += 1;
                    signal.notify_all();
                }
            })
            .map_err(crate::StorageError::persist)?;
        Ok(Self {
            requests: Some(requests),
            thread: Some(thread),
            stopped,
            completed,
            #[cfg(test)]
            writer_max: std::sync::atomic::AtomicI64::new(0),
            #[cfg(test)]
            writer_calls: std::sync::atomic::AtomicU64::new(0),
        })
    }

    // Quiesce before BEGIN so a large commit cannot keep the worker one
    // transaction behind. Refuse before mutation if the bounded handoff expires.
    pub(crate) fn prepare_for_write(&self, conn: &Connection) -> Result<(), crate::StorageError> {
        let deadline = std::time::Instant::now() + MAX_CHECKPOINT_HANDOFF_WAIT;
        loop {
            let (log, backfilled) = frames(conn).map_err(crate::StorageError::persist)?;
            if (0..MAX_PENDING_WAL_FRAMES).contains(&log) {
                return Ok(());
            }
            if log >= 0 && (0..=MAX_WRITER_BACKFILL_FRAMES).contains(&(log - backfilled)) {
                self.checkpoint_on_writer_if_needed(conn);
                let (latest, finished) = frames(conn).map_err(crate::StorageError::persist)?;
                if latest >= 0 && latest == finished {
                    // Full backfill alone does not release readers at the
                    // current header. Restart without waiting before admission.
                    let timeout: u32 = conn
                        .query_row("PRAGMA busy_timeout", [], |r| r.get(0))
                        .map_err(crate::StorageError::persist)?;
                    conn.busy_timeout(std::time::Duration::ZERO)
                        .map_err(crate::StorageError::persist)?;
                    let restart = conn.query_row("PRAGMA main.wal_checkpoint(RESTART)", [], |r| {
                        r.get::<_, i64>(0)
                    });
                    conn.busy_timeout(std::time::Duration::from_millis(u64::from(timeout)))
                        .map_err(crate::StorageError::persist)?;
                    return match restart {
                        Ok(0) => Ok(()),
                        Ok(_) => Err(crate::StorageError::FileLocked),
                        Err(error) => Err(crate::StorageError::persist(error)),
                    };
                }
            }
            if std::time::Instant::now() >= deadline {
                return Err(crate::StorageError::FileLocked);
            }
            let (sequence, signal) = &*self.completed;
            let guard = sequence.lock().unwrap();
            let before = *guard;
            self.request();
            let _wait = signal
                .wait_timeout_while(
                    guard,
                    deadline.saturating_duration_since(std::time::Instant::now()),
                    |sequence| *sequence == before,
                )
                .unwrap();
        }
    }

    // The writer finishes only a small tail. With one domain writer, no new
    // WAL frames can appear between this probe and its PASSIVE checkpoint.
    // The background connection can only reduce that tail.
    pub(crate) fn checkpoint_on_writer_if_needed(&self, conn: &Connection) {
        let Ok((log, backfilled)) = frames(conn) else {
            return;
        };
        if log < WRITER_CHECKPOINT_FRAMES
            || !(0..=MAX_WRITER_BACKFILL_FRAMES).contains(&(log - backfilled))
        {
            return;
        }
        if let Ok((latest, finished)) =
            conn.query_row("PRAGMA main.wal_checkpoint(PASSIVE)", [], |row| {
                Ok((row.get::<_, i64>(1)?, row.get::<_, i64>(2)?))
            })
        {
            #[cfg(test)]
            {
                self.writer_calls.fetch_add(1, Ordering::Relaxed);
                self.writer_max
                    .fetch_max((finished - backfilled).max(0), Ordering::Relaxed);
                assert!(latest < 0 || finished - backfilled <= MAX_WRITER_BACKFILL_FRAMES);
            }
            #[cfg(not(test))]
            let _ = (latest, finished);
        }
    }

    pub(crate) fn has_stopped(&self) -> bool {
        self.thread.as_ref().is_none_or(JoinHandle::is_finished)
    }

    #[cfg(test)]
    pub(crate) fn stop_for_test(&mut self) {
        self.stopped.store(true, Ordering::Release);
        self.requests.take();
        if let Some(thread) = self.thread.take() {
            thread.join().unwrap();
        }
    }

    #[cfg(test)]
    pub(crate) fn writer_work_for_test(&self) -> (u64, i64) {
        (
            self.writer_calls.load(Ordering::Relaxed),
            self.writer_max.load(Ordering::Relaxed),
        )
    }

    pub(crate) fn request(&self) -> bool {
        self.requests.as_ref().is_some_and(|requests| {
            !matches!(
                requests.try_send(()),
                Err(mpsc::TrySendError::Disconnected(()))
            )
        })
    }
}
impl Drop for Checkpoints {
    fn drop(&mut self) {
        self.stopped.store(true, Ordering::Release);
        self.requests.take();
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

// A PASSIVE result describes its starting header. Include writes that arrived
// during its I/O, and leave a bounded tail for the writer to recycle the WAL.
fn catch_up(conn: &Connection, stopped: &AtomicBool) {
    while !stopped.load(Ordering::Acquire) {
        let Ok((log, backfilled)) = frames(conn) else {
            break;
        };
        if log < 0 || log == backfilled {
            break;
        }
        if log >= WRITER_CHECKPOINT_FRAMES && log - backfilled <= MAX_WRITER_BACKFILL_FRAMES {
            break;
        }
        if conn
            .query_row("PRAGMA main.wal_checkpoint(PASSIVE)", [], |row| {
                row.get::<_, i64>(0)
            })
            .is_err()
        {
            break;
        }
        #[cfg(test)]
        checkpoint_crash_barrier();
        let Ok((latest, finished)) = frames(conn) else {
            break;
        };
        if latest < 0 || latest == finished || (latest >= log && finished <= backfilled) {
            break;
        }
    }
}

#[cfg(test)]
fn checkpoint_crash_barrier() {
    if let Some(root) = std::env::var_os("DOHC_CHECKPOINT_CRASH_CHILD") {
        std::fs::write(
            std::path::PathBuf::from(root).join("catch-up-started"),
            b"first PASSIVE completed; catch-up still active",
        )
        .unwrap();
        loop {
            std::thread::park();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{EngineStore, NoFaults, StorageError};
    use dohc_test_scratch::ScratchDir;
    use std::time::{Duration, Instant};

    fn write(store: &mut EngineStore, n: i64, bytes: usize) {
        store
            .write_with(&NoFaults, |tx| {
                tx.execute(
                    "INSERT OR REPLACE INTO checkpoint_load VALUES(?1,?2)",
                    rusqlite::params![n, vec![42_u8; bytes]],
                )
                .map_err(StorageError::persist)?;
                Ok::<_, StorageError>(())
            })
            .unwrap();
    }
    fn write_after_checkpoint(store: &mut EngineStore, n: i64, bytes: usize) {
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            let result = store.write_with(&NoFaults, |tx| {
                tx.execute(
                    "INSERT OR REPLACE INTO checkpoint_load VALUES(?1,?2)",
                    rusqlite::params![n, vec![42_u8; bytes]],
                )
                .map_err(StorageError::persist)?;
                Ok::<_, StorageError>(())
            });
            match result {
                Ok(_) => return,
                Err(StorageError::FileLocked) => {
                    assert!(Instant::now() < deadline, "checkpoint never admitted write")
                }
                Err(error) => panic!("write failed: {error}"),
            }
        }
    }

    fn store(path: &Path) -> EngineStore {
        let mut s = EngineStore::open(path, 1).unwrap();
        s.write_with(&NoFaults, |tx| {
            tx.execute_batch("CREATE TABLE checkpoint_load(id INTEGER PRIMARY KEY, body BLOB)")
                .map_err(StorageError::persist)?;
            Ok::<_, StorageError>(())
        })
        .unwrap();
        s.enable_background_checkpoints().unwrap();
        s
    }
    fn wait_checkpoint(conn: &Connection, checkpoints: &Checkpoints) {
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            checkpoints.request();
            let (log, backfilled) = frames(conn).unwrap();
            if log >= 0 && log == backfilled {
                return;
            }
            assert!(
                Instant::now() < deadline,
                "background checkpoint did not finish"
            );
            std::thread::yield_now();
        }
    }

    #[test]
    fn writer_refuses_large_backlogs_and_finishes_only_a_bounded_tail() {
        exercise_background_writer_handoff();
    }

    fn exercise_background_writer_handoff() {
        let scratch = ScratchDir::new().unwrap();
        let path = scratch.path().join("engine.db");
        let mut s = EngineStore::open(&path, 1).unwrap();
        s.read_with(|c| c.pragma_update(None, "wal_autocheckpoint", 0))
            .unwrap();
        s.write_with(&NoFaults, |tx| {
            tx.execute_batch("CREATE TABLE checkpoint_load(id INTEGER PRIMARY KEY, body BLOB)")
                .map_err(StorageError::persist)?;
            Ok::<_, StorageError>(())
        })
        .unwrap();
        let reader = EngineStore::open_read_only(&path).unwrap();
        reader
            .read_with(|c| c.execute_batch("BEGIN; SELECT * FROM checkpoint_load"))
            .unwrap();
        write(&mut s, 0, 12 * 1024 * 1024);
        let checkpoints = Checkpoints::start(&path).unwrap();
        let unmodified = s.read_with(frames).unwrap();
        s.read_with(|c| {
            checkpoints.checkpoint_on_writer_if_needed(c);
            Ok::<_, rusqlite::Error>(())
        })
        .unwrap();
        assert_eq!(checkpoints.writer_calls.load(Ordering::Relaxed), 0);
        assert_eq!(s.read_with(frames).unwrap(), unmodified);
        assert!(s.read_with(frames).unwrap().0 > WRITER_CHECKPOINT_FRAMES);
        reader.read_with(|c| c.execute_batch("ROLLBACK")).unwrap();
        // Pin the latest WAL read mark before backfill. It permits checkpoint
        // progress but keeps the log from resetting until the reader releases.
        reader
            .read_with(|c| c.execute_batch("BEGIN; SELECT * FROM checkpoint_load"))
            .unwrap();
        s.read_with(|c| {
            wait_checkpoint(c, &checkpoints);
            Ok::<_, rusqlite::Error>(())
        })
        .unwrap();
        write(&mut s, 1, 4096);
        let (before, backfilled) = s.read_with(frames).unwrap();
        assert!(before >= WRITER_CHECKPOINT_FRAMES);
        assert!((1..=MAX_WRITER_BACKFILL_FRAMES).contains(&(before - backfilled)));
        reader.read_with(|c| c.execute_batch("ROLLBACK")).unwrap();
        s.read_with(|c| {
            checkpoints.checkpoint_on_writer_if_needed(c);
            Ok::<_, rusqlite::Error>(())
        })
        .unwrap();
        assert_eq!(checkpoints.writer_calls.load(Ordering::Relaxed), 1);
        assert!(checkpoints.writer_max.load(Ordering::Relaxed) <= MAX_WRITER_BACKFILL_FRAMES);
        write(&mut s, 2, 4096);
        assert!(
            s.read_with(frames).unwrap().0 < before,
            "bounded handoff did not recycle WAL"
        );
    }

    #[test]
    fn sustained_writes_recycle_wal_and_never_backfill_a_large_tail_on_writer() {
        let scratch = ScratchDir::new().unwrap();
        let mut s = store(&scratch.path().join("engine.db"));
        let mut maximum = 0;
        let mut previous = 0;
        let mut resets = 0;
        for n in 0..1600 {
            write(&mut s, n % 64, 16 * 1024);
            let log = s.read_with(frames).unwrap().0;
            maximum = maximum.max(log);
            resets += usize::from(log < previous);
            previous = log;
        }
        assert!(resets > 0, "sustained writes never recycled WAL");
        assert!(
            maximum < 4 * WRITER_CHECKPOINT_FRAMES,
            "WAL grew past combined checkpoint bound: {maximum}"
        );
        let (_, writer_max) = s.checkpoint_work_for_test();
        assert!(writer_max <= MAX_WRITER_BACKFILL_FRAMES);
        assert_eq!(s.table_row_count("checkpoint_load").unwrap(), 64);
        exercise_background_writer_handoff();
    }

    #[test]
    fn sustained_large_transactions_recycle_without_large_writer_checkpoints() {
        let scratch = ScratchDir::new().unwrap();
        let mut s = store(&scratch.path().join("engine.db"));
        let mut maximum = 0;
        let mut previous = 0;
        let mut resets = 0;
        for n in 0..32 {
            write_after_checkpoint(&mut s, n % 2, 5 * 1024 * 1024);
            let log = s.read_with(frames).unwrap().0;
            maximum = maximum.max(log);
            resets += usize::from(log < previous);
            previous = log;
        }
        eprintln!("LARGE_WAL max={maximum} resets={resets}");
        assert!(resets > 0, "large transactions never recycled WAL");
        assert!(
            maximum <= MAX_PENDING_WAL_FRAMES + 1600,
            "large-transaction WAL exceeded high-water plus one transaction: {maximum}"
        );
        assert!(s.checkpoint_work_for_test().1 <= MAX_WRITER_BACKFILL_FRAMES);
    }

    #[test]
    fn fully_backfilled_wal_refuses_writes_until_latest_reader_releases() {
        let scratch = ScratchDir::new().unwrap();
        let path = scratch.path().join("engine.db");
        let mut s = store(&path);
        // Seed a full generation above the cap without exercising admission.
        s.read_with(|c| {
            c.execute(
                "INSERT INTO checkpoint_load VALUES(0,?1)",
                [vec![42_u8; 28 * 1024 * 1024]],
            )
        })
        .unwrap();
        let reader = EngineStore::open_read_only(&path).unwrap();
        reader
            .read_with(|c| c.execute_batch("BEGIN; SELECT * FROM checkpoint_load"))
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            s.request_checkpoint();
            let (log, copied) = s.read_with(frames).unwrap();
            if log >= MAX_PENDING_WAL_FRAMES && log == copied {
                break;
            }
            assert!(Instant::now() < deadline, "full backfill did not complete");
            std::thread::yield_now();
        }
        let before = s.read_with(frames).unwrap();
        let mutated = std::sync::atomic::AtomicBool::new(false);
        assert!(matches!(
            s.write_with(&NoFaults, |_| {
                mutated.store(true, Ordering::Relaxed);
                Ok::<_, StorageError>(())
            }),
            Err(StorageError::FileLocked)
        ));
        assert!(!mutated.load(Ordering::Relaxed));
        assert_eq!(s.read_with(frames).unwrap(), before);
        reader.read_with(|c| c.execute_batch("ROLLBACK")).unwrap();
        drop(reader);
        write_after_checkpoint(&mut s, 1, 4096);
        assert!(s.read_with(frames).unwrap().0 < before.0);
        assert_eq!(s.table_row_count("checkpoint_load").unwrap(), 2);
        assert!(s.checkpoint_work_for_test().1 <= MAX_WRITER_BACKFILL_FRAMES);
    }

    #[test]
    fn stopped_worker_restarts_without_enabling_unbounded_autocheckpoint() {
        let scratch = ScratchDir::new().unwrap();
        let mut s = store(&scratch.path().join("engine.db"));
        s.stop_checkpoint_worker_for_test();
        write(&mut s, 0, 4096);
        assert!(s.checkpoint_worker_running_for_test());
        assert_eq!(
            s.read_with(|c| c.query_row("PRAGMA wal_autocheckpoint", [], |r| r.get::<_, i64>(0)))
                .unwrap(),
            0
        );
        write(&mut s, 1, 4096);
        assert_eq!(s.table_row_count("checkpoint_load").unwrap(), 2);
        let mut previous = s.read_with(frames).unwrap().0;
        let mut resets = 0;
        for n in 0..8 {
            write_after_checkpoint(&mut s, n % 2, 5 * 1024 * 1024);
            let log = s.read_with(frames).unwrap().0;
            resets += usize::from(log < previous);
            previous = log;
        }
        assert!(resets > 0);
        assert!(s.checkpoint_work_for_test().1 <= MAX_WRITER_BACKFILL_FRAMES);
    }

    #[test]
    fn pinned_reader_does_not_block_shutdown_or_lose_commits() {
        let scratch = ScratchDir::new().unwrap();
        let path = scratch.path().join("engine.db");
        let mut s = EngineStore::open(&path, 1).unwrap();
        s.read_with(|c| c.pragma_update(None, "wal_autocheckpoint", 0))
            .unwrap();
        s.write_with(&NoFaults, |tx| {
            tx.execute_batch("CREATE TABLE checkpoint_load(id INTEGER PRIMARY KEY, body BLOB)")
                .map_err(StorageError::persist)?;
            Ok::<_, StorageError>(())
        })
        .unwrap();
        for n in 0..64 {
            write(&mut s, n, 32 * 1024);
        }
        let reader = EngineStore::open_read_only(&path).unwrap();
        reader
            .read_with(|c| c.execute_batch("BEGIN; SELECT * FROM checkpoint_load"))
            .unwrap();
        assert_eq!(reader.table_row_count("checkpoint_load").unwrap(), 64);
        s.enable_background_checkpoints().unwrap();
        for n in 64..1024 {
            s.read_with(|c| {
                c.execute(
                    "INSERT INTO checkpoint_load VALUES(?1,?2)",
                    rusqlite::params![n, vec![42_u8; 32 * 1024]],
                )
            })
            .unwrap();
        }
        s.request_checkpoint();
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            let (log, backfilled) = s.read_with(frames).unwrap();
            if backfilled > 0 && log - backfilled > MAX_WRITER_BACKFILL_FRAMES {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "reader did not pin a partial checkpoint"
            );
            std::thread::yield_now();
        }
        assert_eq!(reader.table_row_count("checkpoint_load").unwrap(), 64);
        let mutated = std::sync::atomic::AtomicBool::new(false);
        let refused = s.write_with(&NoFaults, |_tx| {
            mutated.store(true, Ordering::Relaxed);
            Ok::<_, StorageError>(())
        });
        assert!(matches!(refused, Err(StorageError::FileLocked)));
        assert!(!mutated.load(Ordering::Relaxed));
        assert_eq!(s.table_row_count("checkpoint_load").unwrap(), 1024);
        drop(s);
        assert_eq!(reader.table_row_count("checkpoint_load").unwrap(), 64);
        reader.read_with(|c| c.execute_batch("ROLLBACK")).unwrap();
        drop(reader);
        let mut s = EngineStore::open_for_actor(&path, 2, None, None).unwrap();
        assert_eq!(s.synchronous_setting().unwrap(), 1);
        assert_eq!(s.table_row_count("checkpoint_load").unwrap(), 1024);
        let previous = s.read_with(frames).unwrap().0;
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            write_after_checkpoint(&mut s, 1024, 4096);
            if s.read_with(frames).unwrap().0 < previous {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "WAL did not recycle after reader release"
            );
            std::thread::yield_now();
        }
    }

    #[test]
    fn actor_open_requires_background_checkpoints_before_serving_writes() {
        let scratch = ScratchDir::new().unwrap();
        let path = scratch.path().join("engine.db");
        let s = EngineStore::open_for_actor(&path, 1, Some("root-token"), None).unwrap();
        assert!(s.was_freshly_created());
        assert!(s.checkpoint_worker_running_for_test());
        assert_eq!(
            s.read_with(|c| c.query_row("PRAGMA wal_autocheckpoint", [], |r| r.get::<_, i64>(0)))
                .unwrap(),
            0
        );
        drop(s);
        let s = EngineStore::open_for_actor(&path, 2, None, None).unwrap();
        assert!(!s.was_freshly_created());
        assert!(s.checkpoint_worker_running_for_test());
        assert_eq!(
            s.read_with(|c| c.query_row("PRAGMA wal_autocheckpoint", [], |r| r.get::<_, i64>(0)))
                .unwrap(),
            0
        );
    }

    #[test]
    fn actor_close_never_checkpoints_a_large_wal_after_worker_exit() {
        let scratch = ScratchDir::new().unwrap();
        let path = scratch.path().join("engine.db");
        let mut s = EngineStore::open_for_actor(&path, 1, None, None).unwrap();
        s.stop_checkpoint_worker_for_test();
        s.read_with(|c| {
            c.execute_batch("CREATE TABLE checkpoint_load(id INTEGER PRIMARY KEY, body BLOB)")
        })
        .unwrap();
        s.read_with(|c| {
            c.execute(
                "INSERT INTO checkpoint_load VALUES(0,?1)",
                [vec![42_u8; 12 * 1024 * 1024]],
            )
        })
        .unwrap();
        assert!(s.read_with(frames).unwrap().0 > WRITER_CHECKPOINT_FRAMES);
        let wal = path.with_file_name("engine.db-wal");
        let before = std::fs::metadata(&wal).unwrap().len();
        drop(s);
        assert_eq!(
            std::fs::metadata(&wal).unwrap().len(),
            before,
            "actor close performed a large checkpoint"
        );
        let s = EngineStore::open_for_actor(&path, 2, None, None).unwrap();
        let body: Vec<u8> = s
            .read_with(|c| {
                c.query_row("SELECT body FROM checkpoint_load WHERE id=0", [], |r| {
                    r.get(0)
                })
            })
            .unwrap();
        assert_eq!(body, vec![42_u8; 12 * 1024 * 1024]);
    }

    #[test]
    fn crash_during_background_catch_up_preserves_every_committed_row() {
        const CHILD: &str = "DOHC_CHECKPOINT_CRASH_CHILD";
        if let Some(root) = std::env::var_os(CHILD) {
            let path = std::path::PathBuf::from(root).join("engine.db");
            let mut s = EngineStore::open(&path, 1).unwrap();
            s.read_with(|c| c.pragma_update(None, "wal_autocheckpoint", 0))
                .unwrap();
            s.write_with(&NoFaults, |tx| {
                tx.execute_batch("CREATE TABLE checkpoint_load(id INTEGER PRIMARY KEY, body BLOB)")
                    .map_err(StorageError::persist)?;
                Ok::<_, StorageError>(())
            })
            .unwrap();
            for n in 0..64 {
                write(&mut s, n, 32 * 1024);
            }
            let reader = EngineStore::open_read_only(&path).unwrap();
            reader
                .read_with(|c| c.execute_batch("BEGIN; SELECT * FROM checkpoint_load"))
                .unwrap();
            s.enable_background_checkpoints().unwrap();
            for n in 64..128 {
                write(&mut s, n, 32 * 1024);
            }
            write(&mut s, 128, 32 * 1024);
            while !path.with_file_name("catch-up-started").exists() {
                std::thread::yield_now();
            }
            let (before, partial) = s.read_with(frames).unwrap();
            assert!(partial > 0 && before > partial);
            assert_eq!(reader.table_row_count("checkpoint_load").unwrap(), 64);
            write(&mut s, 129, 32 * 1024);
            let (log, backfilled) = s.read_with(frames).unwrap();
            assert!(
                backfilled > 0 && log > backfilled && log >= before,
                "crash must retain the partially backfilled WAL generation"
            );
            s.read_with(|c| {
                c.execute(
                    "INSERT INTO checkpoint_load VALUES(130,?1)",
                    [vec![42_u8; 28 * 1024 * 1024]],
                )
            })
            .unwrap();
            assert!(s.read_with(frames).unwrap().0 >= MAX_PENDING_WAL_FRAMES);
            std::fs::write(path.with_file_name("committed"), b"131").unwrap();
            loop {
                std::thread::park();
            }
        }
        let scratch = ScratchDir::new().unwrap();
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "checkpoint::tests::crash_during_background_catch_up_preserves_every_committed_row",
                "--nocapture",
            ])
            .env(CHILD, scratch.path())
            .spawn()
            .unwrap();
        std::fs::write(scratch.path().join("child-pid"), child.id().to_string()).unwrap();
        let deadline = Instant::now() + Duration::from_secs(20);
        let ready = loop {
            if scratch.path().join("catch-up-started").exists()
                && scratch.path().join("committed").exists()
            {
                break true;
            }
            if Instant::now() >= deadline || child.try_wait().unwrap().is_some() {
                break false;
            }
            std::thread::yield_now();
        };
        child.kill().unwrap();
        child.wait().unwrap();
        assert!(ready, "child never reached checkpoint catch-up");
        let path = scratch.path().join("engine.db");
        let mut s = EngineStore::open_for_actor(&path, 2, None, None).unwrap();
        let actual: Vec<(i64, Vec<u8>)> = s
            .read_with(|c| {
                c.prepare("SELECT id,body FROM checkpoint_load ORDER BY id")?
                    .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
                    .collect::<rusqlite::Result<_>>()
            })
            .unwrap();
        assert_eq!(
            actual,
            (0..130)
                .map(|n| (n, vec![42_u8; 32 * 1024]))
                .chain(std::iter::once((130, vec![42_u8; 28 * 1024 * 1024])))
                .collect::<Vec<_>>()
        );
        let before = s.read_with(frames).unwrap().0;
        write_after_checkpoint(&mut s, 131, 4096);
        assert!(
            s.read_with(frames).unwrap().0 < before,
            "recovered WAL did not recycle"
        );
        drop(s);
        let s = EngineStore::open_for_actor(&path, 3, None, None).unwrap();
        let rows: Vec<(i64, Vec<u8>)> = s
            .read_with(|c| {
                c.prepare("SELECT id,body FROM checkpoint_load WHERE id<131 ORDER BY id")?
                    .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
                    .collect::<rusqlite::Result<_>>()
            })
            .unwrap();
        assert_eq!(rows, actual);
    }
}
