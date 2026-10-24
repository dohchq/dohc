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
    full_requested: Arc<AtomicBool>,
    completed: Arc<(std::sync::Mutex<u64>, std::sync::Condvar)>,
    #[cfg(test)]
    writer_max: std::sync::atomic::AtomicI64,
    #[cfg(test)]
    writer_calls: std::sync::atomic::AtomicU64,
    #[cfg(test)]
    startup_max: std::sync::atomic::AtomicI64,
    #[cfg(test)]
    startup_calls: std::sync::atomic::AtomicU64,
}

fn frames(conn: &Connection) -> rusqlite::Result<(i64, i64)> {
    conn.query_row("PRAGMA main.wal_checkpoint(NOOP)", [], |row| {
        Ok((row.get(1)?, row.get(2)?))
    })
}

impl Checkpoints {
    /// The background connection. It never waits for a lock, and it syncs
    /// copied pages as the writer's connection does.
    pub(crate) fn connection(path: &Path) -> Result<Connection, crate::StorageError> {
        let conn = crate::open_store(path, OpenFlags::SQLITE_OPEN_READ_WRITE)
            .map_err(crate::StorageError::persist)?;
        conn.busy_timeout(std::time::Duration::ZERO)
            .map_err(crate::StorageError::persist)?;
        conn.pragma_update(None, "synchronous", "NORMAL")
            .map_err(crate::StorageError::persist)?;
        crate::schema::set_checkpoint_fullfsync(&conn).map_err(crate::StorageError::persist)?;
        Ok(conn)
    }

    pub(crate) fn start(path: &Path) -> Result<Self, crate::StorageError> {
        let conn = Self::connection(path)?;
        let (requests, rx) = mpsc::sync_channel(1);
        let stopped = Arc::new(AtomicBool::new(false));
        let worker_stopped = Arc::clone(&stopped);
        let full_requested = Arc::new(AtomicBool::new(false));
        let worker_full = full_requested.clone();
        let completed = Arc::new((std::sync::Mutex::new(0), std::sync::Condvar::new()));
        let worker_completed = Arc::clone(&completed);
        let thread = std::thread::Builder::new()
            .name("dohc-wal-checkpoint".into())
            .spawn(move || {
                while rx.recv().is_ok() {
                    #[cfg(feature = "fault-injection")]
                    let mut phase =
                        crate::capture_phase::Phase::new("checkpoint_request_cycle", None, 0, true);
                    #[cfg(feature = "fault-injection")]
                    if phase.active()
                        && let Ok((log, backfilled)) = frames(&conn)
                    {
                        phase.field("starting_log", log);
                        phase.field("starting_backfilled", backfilled);
                    }
                    let full = worker_full.swap(false, Ordering::AcqRel);
                    if frames(&conn).is_ok_and(|(log, backfilled)| {
                        log > backfilled
                            && (full || log - backfilled >= BACKGROUND_CHECKPOINT_FRAMES)
                    }) {
                        catch_up(&conn, &worker_stopped, full);
                    }
                    let (sequence, signal) = &*worker_completed;
                    *sequence.lock().unwrap() += 1;
                    signal.notify_all();
                    #[cfg(feature = "fault-injection")]
                    {
                        phase.field("completed", *sequence.lock().unwrap());
                        if phase.active()
                            && let Ok((log, backfilled)) = frames(&conn)
                        {
                            phase.field("ending_log", log);
                            phase.field("ending_backfilled", backfilled);
                        }
                        phase.finish("completed");
                    }
                }
            })
            .map_err(crate::StorageError::persist)?;
        Ok(Self {
            requests: Some(requests),
            thread: Some(thread),
            stopped,
            full_requested,
            completed,
            #[cfg(test)]
            writer_max: std::sync::atomic::AtomicI64::new(0),
            #[cfg(test)]
            writer_calls: std::sync::atomic::AtomicU64::new(0),
            #[cfg(test)]
            startup_max: std::sync::atomic::AtomicI64::new(0),
            #[cfg(test)]
            startup_calls: std::sync::atomic::AtomicU64::new(0),
        })
    }

    pub(crate) fn next_cycle(&self) -> impl Fn() + Send + Sync + use<> {
        let completed = self.completed.clone();
        move || {
            let before = *completed.0.lock().unwrap();
            let (sequence, signal) = &*completed;
            let _wait = signal
                .wait_timeout_while(
                    sequence.lock().unwrap(),
                    std::time::Duration::from_millis(100),
                    |s| *s <= before,
                )
                .unwrap();
        }
    }

    pub(crate) fn request_full(&self) {
        // Preserve full requests when the channel already holds ordinary work.
        self.full_requested.store(true, Ordering::Release);
        self.request();
    }

    // Quiesce before BEGIN so a large commit cannot keep the worker one
    // transaction behind. Refuse before mutation if the bounded handoff expires.
    pub(crate) fn prepare_for_write(
        &self,
        conn: &Connection,
        background: bool,
    ) -> Result<(), crate::StorageError> {
        #[cfg(feature = "fault-injection")]
        let mut phase = crate::capture_phase::Phase::new("write_admission", None, 0, true);
        let deadline = std::time::Instant::now() + MAX_CHECKPOINT_HANDOFF_WAIT;
        loop {
            let (log, backfilled) = frames(conn).map_err(crate::StorageError::persist)?;
            if background && log >= MAX_PENDING_WAL_FRAMES && log != backfilled {
                self.request_full();
                return Err(crate::StorageError::FileLocked);
            }
            #[cfg(feature = "fault-injection")]
            {
                phase.field("log", log);
                phase.field("backfilled", backfilled);
            }
            if (0..MAX_PENDING_WAL_FRAMES).contains(&log) {
                #[cfg(feature = "fault-injection")]
                phase.finish("admitted");
                return Ok(());
            }
            if log >= 0 && (0..=MAX_WRITER_BACKFILL_FRAMES).contains(&(log - backfilled)) {
                if !background {
                    self.checkpoint_on_writer_if_needed(conn);
                }
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
                    #[cfg(feature = "fault-injection")]
                    phase.finish(if matches!(&restart, Ok(0)) {
                        "admitted-after-restart"
                    } else {
                        "refused-restart"
                    });
                    return match restart {
                        Ok(0) => Ok(()),
                        Ok(_) => Err(crate::StorageError::FileLocked),
                        Err(error) => Err(crate::StorageError::persist(error)),
                    };
                }
            }
            if std::time::Instant::now() >= deadline {
                #[cfg(feature = "fault-injection")]
                phase.finish("FileLocked");
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
        self.checkpoint_tail(
            conn,
            WRITER_CHECKPOINT_FRAMES,
            MAX_WRITER_BACKFILL_FRAMES,
            #[cfg(test)]
            false,
            #[cfg(feature = "fault-injection")]
            None,
        );
    }

    /// Before publication a fresh store contains only schema metadata, no user
    /// data or concurrent domain writer. Finish that entire finite schema tail.
    /// PASSIVE never waits for an outside reader, even during startup.
    pub(crate) fn checkpoint_fresh_schema(&self, conn: &Connection) {
        #[cfg(feature = "fault-injection")]
        let mut phase = crate::capture_phase::Phase::new("fresh_schema_PASSIVE", None, 0, true);
        self.checkpoint_tail(
            conn,
            0,
            i64::MAX,
            #[cfg(test)]
            true,
            #[cfg(feature = "fault-injection")]
            Some(&mut phase),
        );
    }

    /// Upgrades contain user data and may have readers pinning an old prefix.
    /// Attempt only the ordinary small-tail bound; larger backlogs stay on the
    /// background worker, and a pinned reader may leave even a small tail.
    pub(crate) fn checkpoint_migration_tail_if_small(&self, conn: &Connection) {
        #[cfg(feature = "fault-injection")]
        let mut phase = crate::capture_phase::Phase::new("migration_tail_PASSIVE", None, 0, true);
        self.checkpoint_tail(
            conn,
            0,
            MAX_WRITER_BACKFILL_FRAMES,
            #[cfg(test)]
            true,
            #[cfg(feature = "fault-injection")]
            Some(&mut phase),
        );
    }

    fn checkpoint_tail(
        &self,
        conn: &Connection,
        minimum_log_frames: i64,
        maximum_tail: i64,
        #[cfg(test)] startup: bool,
        #[cfg(feature = "fault-injection")] mut phase: Option<&mut crate::capture_phase::Phase>,
    ) {
        let Ok((log, backfilled)) = frames(conn) else {
            #[cfg(feature = "fault-injection")]
            if let Some(phase) = phase.as_mut() {
                phase.finish("error");
            }
            return;
        };
        #[cfg(feature = "fault-injection")]
        if let Some(phase) = phase.as_mut() {
            phase.field("starting_log", log);
            phase.field("starting_backfilled", backfilled);
            phase.field("ending_log", log);
            phase.field("ending_backfilled", backfilled);
            phase.field("frames_backfilled", 0);
            phase.field("frames_finished", backfilled);
        }
        if log < minimum_log_frames || !(0..=maximum_tail).contains(&(log - backfilled)) {
            #[cfg(feature = "fault-injection")]
            if let Some(phase) = phase.as_mut() {
                phase.finish("skipped");
            }
            return;
        }
        #[cfg(feature = "fault-injection")]
        let _writer_phase = crate::capture_phase::Measure::new("writer_PASSIVE");
        #[cfg(test)]
        let began = std::time::Instant::now();
        if let Ok((latest, finished)) =
            conn.query_row("PRAGMA main.wal_checkpoint(PASSIVE)", [], |row| {
                Ok((row.get::<_, i64>(1)?, row.get::<_, i64>(2)?))
            })
        {
            #[cfg(feature = "fault-injection")]
            if let Some(phase) = phase.as_mut() {
                phase.field("ending_log", latest);
                phase.field("ending_backfilled", finished);
                phase.field("frames_backfilled", (finished - backfilled).max(0));
                phase.field("frames_finished", finished);
                phase.finish(if latest >= 0 && latest == finished {
                    "completed"
                } else {
                    "skipped"
                });
            }
            #[cfg(test)]
            {
                let (calls, maximum) = if startup {
                    (&self.startup_calls, &self.startup_max)
                } else {
                    (&self.writer_calls, &self.writer_max)
                };
                calls.fetch_add(1, Ordering::Relaxed);
                maximum.fetch_max((finished - backfilled).max(0), Ordering::Relaxed);
                assert!(latest < 0 || finished - backfilled <= maximum_tail);
                if startup {
                    eprintln!(
                        "STARTUP_PASSIVE fresh={} elapsed_us={} starting_log={log} starting_backfilled={backfilled} finished={finished}",
                        maximum_tail == i64::MAX,
                        began.elapsed().as_micros()
                    );
                }
            }
            #[cfg(not(test))]
            let _ = (latest, finished);
        } else {
            #[cfg(feature = "fault-injection")]
            if let Some(phase) = phase.as_mut() {
                phase.finish("error");
            }
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
    pub(crate) fn completed_for_test(&self) -> u64 {
        *self.completed.0.lock().unwrap()
    }

    #[cfg(test)]
    pub(crate) fn wait_for_completion_for_test(&self, before: u64) {
        let (sequence, signal) = &*self.completed;
        let (sequence, _) = signal
            .wait_timeout_while(
                sequence.lock().unwrap(),
                std::time::Duration::from_secs(60),
                |sequence| *sequence <= before,
            )
            .unwrap();
        assert!(
            *sequence > before,
            "committed write never requested checkpoint work"
        );
    }

    #[cfg(test)]
    pub(crate) fn writer_work_for_test(&self) -> (u64, i64) {
        (
            self.writer_calls.load(Ordering::Relaxed),
            self.writer_max.load(Ordering::Relaxed),
        )
    }

    #[cfg(test)]
    pub(crate) fn startup_work_for_test(&self) -> (u64, i64) {
        (
            self.startup_calls.load(Ordering::Relaxed),
            self.startup_max.load(Ordering::Relaxed),
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

// A PASSIVE result describes its starting header. Full requests include writes
// that arrived during I/O; ordinary requests leave a bounded tail for the writer.
fn catch_up(conn: &Connection, stopped: &AtomicBool, full: bool) {
    while !stopped.load(Ordering::Acquire) {
        let Ok((log, backfilled)) = frames(conn) else {
            break;
        };
        if log < 0 || log == backfilled {
            break;
        }
        if !full
            && log >= WRITER_CHECKPOINT_FRAMES
            && log - backfilled <= MAX_WRITER_BACKFILL_FRAMES
        {
            break;
        }
        #[cfg(feature = "fault-injection")]
        let passive_phase = crate::capture_phase::Measure::new("background_PASSIVE");
        if conn
            .query_row("PRAGMA main.wal_checkpoint(PASSIVE)", [], |row| {
                row.get::<_, i64>(0)
            })
            .is_err()
        {
            break;
        }
        #[cfg(feature = "fault-injection")]
        drop(passive_phase);
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

    #[cfg(windows)]
    #[test]
    fn concurrent_readers_release_checkpoint_locks() {
        reader_checkpoint_race(false);
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "upstream SQLite UNC misdetection leaks SHM locks for raw verbatim drive paths"]
    fn raw_verbatim_readers_pin_checkpoint_locks() {
        reader_checkpoint_race(true);
    }

    #[cfg(windows)]
    fn reader_checkpoint_race(raw: bool) {
        let scratch = ScratchDir::new().unwrap();
        let path = scratch.path().join("reader-race.db");
        std::fs::File::create(&path).unwrap();
        let path = std::fs::canonicalize(path).unwrap();
        let writer = if raw {
            Connection::open(&path).unwrap()
        } else {
            crate::schema::open_engine_db(&path, 0, None).unwrap().conn
        };
        writer
            .execute_batch(
                "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;
                 PRAGMA wal_autocheckpoint=0; CREATE TABLE probe(n);
                 INSERT INTO probe VALUES(0)",
            )
            .unwrap();
        let barrier = Arc::new(std::sync::Barrier::new(3));
        std::thread::scope(|scope| {
            for _ in 0..2 {
                let barrier = barrier.clone();
                let path = path.clone();
                scope.spawn(move || {
                    let reader = if raw {
                        Connection::open(path).unwrap()
                    } else {
                        crate::schema::open_engine_db_read_only(&path, None, None)
                            .unwrap()
                            .conn
                    };
                    for _ in 0..256 {
                        reader.execute_batch("BEGIN; SELECT * FROM probe").unwrap();
                        barrier.wait();
                        barrier.wait();
                        reader.execute_batch("ROLLBACK").unwrap();
                        barrier.wait();
                        barrier.wait();
                    }
                });
            }
            let mut pinned = None;
            for round in 0..256 {
                barrier.wait();
                barrier.wait();
                barrier.wait();
                // Both read transactions ended. Keep them idle until the
                // writer checks that no reader still blocks backfill.
                writer.execute("UPDATE probe SET n=n+1", []).unwrap();
                let (log, backfilled): (i64, i64) = writer
                    .query_row("PRAGMA wal_checkpoint(PASSIVE)", [], |r| {
                        Ok((r.get(1)?, r.get(2)?))
                    })
                    .unwrap();
                if log != backfilled {
                    pinned.get_or_insert((round, log, backfilled));
                }
                barrier.wait();
            }
            assert!(
                pinned.is_none(),
                "finished readers pinned the WAL: {pinned:?}"
            );
        });
    }

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
    fn write_after_checkpoint(store: &mut EngineStore, n: i64, bytes: usize) -> usize {
        let deadline = Instant::now() + Duration::from_secs(20);
        let mut refusals = 0;
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
                Ok(_) => return refusals,
                Err(StorageError::FileLocked) => {
                    refusals += 1;
                    assert!(Instant::now() < deadline, "checkpoint never admitted write");
                    std::thread::sleep(Duration::from_millis(10));
                }
                Err(error) => panic!("write failed: {error}"),
            }
        }
    }

    fn store(path: &Path) -> EngineStore {
        let mut s = EngineStore::open_for_actor(path, 1, None, None).unwrap();
        s.write_with(&NoFaults, |tx| {
            tx.execute_batch("CREATE TABLE checkpoint_load(id INTEGER PRIMARY KEY, body BLOB)")
                .map_err(StorageError::persist)?;
            Ok::<_, StorageError>(())
        })
        .unwrap();
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

    #[cfg(feature = "fault-injection")]
    #[test]
    fn startup_checkpoint_spans_report_completed_and_skipped_work() {
        const CHILD: &str = "DOHC_STARTUP_PHASE_TEST_CHILD";
        if std::env::var_os(CHILD).is_some() {
            let scratch = ScratchDir::new().unwrap();
            let path = scratch.path().join("engine.db");
            let mut s = EngineStore::open_for_actor(&path, 1, None, None).unwrap();
            s.stop_checkpoint_worker_for_test();
            s.read_with(|c| {
                c.execute_batch("CREATE TABLE checkpoint_load(id INTEGER PRIMARY KEY, body BLOB)")
            })
            .unwrap();
            write(&mut s, 0, 12 * 1024 * 1024);
            let checkpoints = Checkpoints::start(&path).unwrap();
            s.read_with(|c| {
                checkpoints.checkpoint_migration_tail_if_small(c);
                Ok::<_, rusqlite::Error>(())
            })
            .unwrap();
            assert_eq!(checkpoints.startup_work_for_test().0, 0);
            return;
        }
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "checkpoint::tests::startup_checkpoint_spans_report_completed_and_skipped_work",
                "--nocapture",
            ])
            .env(CHILD, "1")
            .env("DOHC_CAPTURE_PHASE_DIAGNOSTICS", "1")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let phases: Vec<serde_json::Value> = String::from_utf8_lossy(&output.stderr)
            .lines()
            .filter_map(|line| line.strip_prefix("R16_CAPTURE_PHASE "))
            .map(|json| serde_json::from_str(json).unwrap())
            .collect();
        let fresh = phases
            .iter()
            .find(|p| p["phase"] == "fresh_schema_PASSIVE")
            .unwrap();
        assert_eq!(fresh["outcome"], "completed");
        assert!(fresh["starting_log"].as_i64().unwrap() > 0);
        assert_eq!(fresh["ending_log"], fresh["frames_finished"]);
        assert_eq!(
            fresh["frames_backfilled"].as_i64().unwrap(),
            fresh["frames_finished"].as_i64().unwrap()
                - fresh["starting_backfilled"].as_i64().unwrap()
        );
        let skipped = phases
            .iter()
            .find(|p| p["phase"] == "migration_tail_PASSIVE")
            .unwrap();
        assert_eq!(skipped["outcome"], "skipped");
        assert!(
            skipped["starting_log"].as_i64().unwrap()
                - skipped["starting_backfilled"].as_i64().unwrap()
                > MAX_WRITER_BACKFILL_FRAMES
        );
        assert_eq!(skipped["frames_backfilled"], 0);
        assert_eq!(skipped["frames_finished"], skipped["starting_backfilled"]);
        assert_eq!(skipped["ending_log"], skipped["starting_log"]);
    }

    #[cfg(feature = "fault-injection")]
    #[test]
    fn startup_checkpoint_spans_report_pinned_reader_and_error() {
        const CHILD: &str = "DOHC_PINNED_CHECKPOINT_PHASE_TEST_CHILD";
        if std::env::var_os(CHILD).is_some() {
            let scratch = ScratchDir::new().unwrap();
            let path = scratch.path().join("engine.db");
            let mut s = store(&path);
            s.stop_checkpoint_worker_for_test();
            write(&mut s, 0, 1024);
            s.read_with(|conn| conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)"))
                .unwrap();
            let reader =
                Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
            reader
                .execute_batch("BEGIN; SELECT * FROM checkpoint_load")
                .unwrap();
            write(&mut s, 1, 1024);
            let checkpoints = Checkpoints::start(&path).unwrap();
            s.read_with(|conn| {
                let mut phase =
                    crate::capture_phase::Phase::new("pinned_reader_PASSIVE", None, 0, true);
                checkpoints.checkpoint_tail(
                    conn,
                    0,
                    MAX_WRITER_BACKFILL_FRAMES,
                    true,
                    Some(&mut phase),
                );
                let (log, backfilled) = frames(conn)?;
                assert!(log > backfilled);
                Ok::<_, rusqlite::Error>(())
            })
            .unwrap();
            reader.execute_batch("ROLLBACK").unwrap();
            s.read_with(|conn| {
                conn.execute_batch(
                    "BEGIN IMMEDIATE; INSERT INTO checkpoint_load VALUES(2, X'01')",
                )?;
                {
                    let mut phase =
                        crate::capture_phase::Phase::new("error_PASSIVE", None, 0, true);
                    checkpoints.checkpoint_tail(
                        conn,
                        0,
                        MAX_WRITER_BACKFILL_FRAMES,
                        true,
                        Some(&mut phase),
                    );
                }
                conn.execute_batch("ROLLBACK")
            })
            .unwrap();
            return;
        }
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "checkpoint::tests::startup_checkpoint_spans_report_pinned_reader_and_error",
                "--nocapture",
            ])
            .env(CHILD, "1")
            .env("DOHC_CAPTURE_PHASE_DIAGNOSTICS", "1")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let phases: Vec<serde_json::Value> = String::from_utf8_lossy(&output.stderr)
            .lines()
            .filter_map(|line| line.strip_prefix("R16_CAPTURE_PHASE "))
            .map(|json| serde_json::from_str(json).unwrap())
            .collect();
        let pinned = phases
            .iter()
            .find(|p| p["phase"] == "pinned_reader_PASSIVE")
            .unwrap();
        assert_eq!(pinned["outcome"], "skipped");
        assert!(
            pinned["ending_log"].as_i64().unwrap() > pinned["frames_finished"].as_i64().unwrap()
        );
        let error = phases
            .iter()
            .find(|p| p["phase"] == "error_PASSIVE")
            .unwrap();
        assert_eq!(error["outcome"], "error");
    }

    #[test]
    fn passive_store_open_and_upgrade_do_no_startup_checkpoint_work() {
        use crate::migration::{BASELINE_MIGRATIONS, MigrationContext, run_migrations};
        for upgrading in [false, true] {
            let scratch = ScratchDir::new().unwrap();
            let path = scratch.path().join("engine.db");
            if upgrading {
                let mut conn = Connection::open(&path).unwrap();
                let before = BASELINE_MIGRATIONS
                    .iter()
                    .position(|m| m.id == "v2-persisted-links")
                    .unwrap();
                run_migrations(
                    &mut conn,
                    &BASELINE_MIGRATIONS[..before],
                    &MigrationContext::current(1),
                    &NoFaults,
                )
                .unwrap();
                conn.execute_batch("UPDATE engine_ownership SET store_role='passive'; INSERT INTO versioned_workspaces VALUES('ws','main'); INSERT INTO versions(workspace_id,version_id,kind,name,created_at_ms) VALUES('ws','main','main','Main',1);").unwrap();
            }
            let s = EngineStore::open_passive(&path, 2, None, None).unwrap();
            assert!(s.is_passive());
            assert_eq!(s.startup_checkpoint_work_for_test(), (0, 0));
            assert!(!s.checkpoint_worker_running_for_test());
            assert_eq!(s.table_row_count("link_pending").unwrap(), 0);
            assert_eq!(s.table_row_count("link_aliases").unwrap(), 0);
            assert_eq!(s.table_row_count("link_index_state").unwrap(), 0);
            if upgrading {
                assert_eq!(s.table_row_count("versions").unwrap(), 1);
            }
            drop(s);
            let s = EngineStore::open_passive(&path, 3, None, None).unwrap();
            assert_eq!(s.startup_checkpoint_work_for_test(), (0, 0));
            assert!(!s.checkpoint_worker_running_for_test());
            assert_eq!(s.table_row_count("link_index_state").unwrap(), 0);
        }
    }

    #[test]
    fn fresh_actor_schema_does_not_consume_the_write_admission_budget() {
        let scratch = ScratchDir::new().unwrap();
        let path = scratch.path().join("engine.db");
        let s = EngineStore::open_for_actor(&path, 1, None, None).unwrap();
        let (log, backfilled) = s.read_with(frames).unwrap();
        assert_eq!(
            log, backfilled,
            "fresh schema must finish its whole metadata tail before publication"
        );
        let (calls, maximum) = s.startup_checkpoint_work_for_test();
        assert_eq!(calls, 1);
        assert!(maximum > 0);
        assert_eq!(s.checkpoint_work_for_test(), (0, 0));
    }

    #[test]
    fn fresh_schema_larger_than_the_writer_bound_finishes_before_publication() {
        let scratch = ScratchDir::new().unwrap();
        let path = scratch.path().join("engine.db");
        let mut conn = Connection::open(&path).unwrap();
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;")
            .unwrap();
        let tx = conn.transaction().unwrap();
        for n in 0..1100 {
            tx.execute_batch(&format!(
                "CREATE TABLE metadata_{n}(id INTEGER PRIMARY KEY)"
            ))
            .unwrap();
        }
        tx.commit().unwrap();
        let (log, backfilled) = frames(&conn).unwrap();
        assert!(log - backfilled > MAX_WRITER_BACKFILL_FRAMES);
        let checkpoints = Checkpoints::start(&path).unwrap();
        checkpoints.checkpoint_fresh_schema(&conn);
        assert_eq!(frames(&conn).unwrap(), (log, log));
        assert_eq!(checkpoints.startup_work_for_test(), (1, log - backfilled));
        assert_eq!(checkpoints.writer_work_for_test(), (0, 0));
    }

    fn store_before_link_migration(path: &Path) -> Connection {
        use crate::migration::{BASELINE_MIGRATIONS, MigrationContext, run_migrations};
        let mut conn = Connection::open(path).unwrap();
        conn.set_db_config(
            rusqlite::config::DbConfig::SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE,
            true,
        )
        .unwrap();
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;")
            .unwrap();
        let before = BASELINE_MIGRATIONS
            .iter()
            .position(|m| m.id == "v2-persisted-links")
            .unwrap();
        run_migrations(
            &mut conn,
            &BASELINE_MIGRATIONS[..before],
            &MigrationContext::current(1),
            &NoFaults,
        )
        .unwrap();
        conn.execute_batch("CREATE TABLE checkpoint_load(id INTEGER PRIMARY KEY, body BLOB); INSERT INTO checkpoint_load VALUES(0, X'01'); PRAGMA wal_checkpoint(TRUNCATE);")
            .unwrap();
        conn
    }

    #[test]
    fn upgrade_finishes_a_small_migration_tail_before_publication() {
        let scratch = ScratchDir::new().unwrap();
        let path = scratch.path().join("engine.db");
        drop(store_before_link_migration(&path));
        let s = EngineStore::open_for_actor(&path, 2, None, None).unwrap();
        assert!(!s.was_freshly_created());
        assert_eq!(s.table_row_count("checkpoint_load").unwrap(), 1);
        let (log, backfilled) = s.read_with(frames).unwrap();
        assert_eq!(log, backfilled);
        let (calls, maximum) = s.startup_checkpoint_work_for_test();
        assert_eq!(calls, 1);
        assert!((1..=MAX_WRITER_BACKFILL_FRAMES).contains(&maximum));
    }

    #[test]
    fn upgrade_with_a_pinned_reader_keeps_startup_work_bounded() {
        for bytes in [4096, 12 * 1024 * 1024] {
            let scratch = ScratchDir::new().unwrap();
            let path = scratch.path().join("engine.db");
            let conn = store_before_link_migration(&path);
            let reader =
                Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
            reader
                .execute_batch("BEGIN; SELECT * FROM checkpoint_load;")
                .unwrap();
            conn.execute(
                "INSERT INTO checkpoint_load VALUES(1, ?1)",
                [vec![42_u8; bytes]],
            )
            .unwrap();
            drop(conn);
            let mut s = EngineStore::open_for_actor(&path, 2, None, None).unwrap();
            s.stop_checkpoint_worker_for_test();
            assert!(!s.was_freshly_created());
            assert_eq!(s.table_row_count("checkpoint_load").unwrap(), 2);
            let (calls, maximum) = s.startup_checkpoint_work_for_test();
            assert_eq!(calls, u64::from(bytes == 4096));
            assert!(maximum <= MAX_WRITER_BACKFILL_FRAMES);
            let (log, backfilled) = s.read_with(frames).unwrap();
            assert!(
                log > backfilled,
                "PASSIVE must leave the reader's pinned prefix alone"
            );
            assert_eq!(
                reader
                    .query_row("SELECT count(*) FROM checkpoint_load", [], |r| r
                        .get::<_, i64>(0))
                    .unwrap(),
                1
            );
            reader.execute_batch("ROLLBACK").unwrap();
            drop(reader);
            drop(s);
            let s = EngineStore::open_for_actor(&path, 3, None, None).unwrap();
            assert_eq!(s.table_row_count("checkpoint_load").unwrap(), 2);
            assert_eq!(s.startup_checkpoint_work_for_test().0, 0);
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
            checkpoints.checkpoint_migration_tail_if_small(c);
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
    fn each_commit_wakes_checkpoint_worker_without_write_refusals() {
        let scratch = ScratchDir::new().unwrap();
        let mut s = store(&scratch.path().join("engine.db"));
        let mut maximum = 0;
        let mut refusals = 0;
        for n in 0..1600 {
            let before = s.checkpoint_completed_for_test();
            refusals += write_after_checkpoint(&mut s, n % 64, 16 * 1024);
            s.wait_for_checkpoint_completion_for_test(before);
            maximum = maximum.max(s.read_with(frames).unwrap().0);
        }
        assert_eq!(refusals, 0);
        assert!(
            maximum < MAX_PENDING_WAL_FRAMES,
            "WAL reached the write gate: {maximum}"
        );
        assert!(s.checkpoint_work_for_test().1 <= MAX_WRITER_BACKFILL_FRAMES);
    }

    #[test]
    fn sustained_writes_recycle_wal_and_never_backfill_a_large_tail_on_writer() {
        let scratch = ScratchDir::new().unwrap();
        let mut s = store(&scratch.path().join("engine.db"));
        let mut maximum = 0;
        for n in 0..1600 {
            write_after_checkpoint(&mut s, n % 64, 16 * 1024);
            maximum = maximum.max(s.read_with(frames).unwrap().0);
        }
        assert!(
            maximum < 4 * WRITER_CHECKPOINT_FRAMES,
            "WAL grew past combined checkpoint bound: {maximum}"
        );
        assert!(s.checkpoint_work_for_test().1 <= MAX_WRITER_BACKFILL_FRAMES);
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
        assert!(matches!(
            s.write_durable_with(&NoFaults, |_| {
                mutated.store(true, Ordering::Relaxed);
                Ok::<_, StorageError>(())
            }),
            Err(StorageError::FileLocked)
        ));
        assert!(!mutated.load(Ordering::Relaxed));
        assert_eq!(
            s.read_with(|c| c.query_row("PRAGMA synchronous", [], |r| r.get::<_, i64>(0)))
                .unwrap(),
            1
        );
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
        let mut s = EngineStore::open_for_actor(&path, 1, None, None).unwrap();
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
        // Keep a small retained user-data WAL, so a removed Fresh guard is
        // observable even when an empty WAL would report no checkpoint work.
        s.read_with(|c| c.execute_batch("CREATE TABLE reopen_probe(id INTEGER PRIMARY KEY); INSERT INTO reopen_probe VALUES(1);"))
            .unwrap();
        let reader = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        reader
            .execute_batch("BEGIN; SELECT * FROM reopen_probe;")
            .unwrap();
        drop(s);
        let s = EngineStore::open_for_actor(&path, 2, None, None).unwrap();
        assert!(!s.was_freshly_created());
        assert!(s.checkpoint_worker_running_for_test());
        assert_eq!(
            s.startup_checkpoint_work_for_test().0,
            0,
            "an existing, fully migrated store must do no startup checkpoint"
        );
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
    // The worker pauses after PASSIVE returns, before its next call.
    // This tests recovery from a partially copied WAL, not a kill inside SQLite.
    fn crash_between_passive_checkpoints_preserves_every_committed_row() {
        const CHILD: &str = "DOHC_CHECKPOINT_CRASH_CHILD";
        if let Some(root) = std::env::var_os(CHILD) {
            let path = std::path::PathBuf::from(root).join("engine.db");
            let mut s = EngineStore::open_for_actor(&path, 1, None, None).unwrap();
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
                "checkpoint::tests::crash_between_passive_checkpoints_preserves_every_committed_row",
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
