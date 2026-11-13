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
/// Half the WAL writes are refused at: where a held reader gives way.
const HELD_READER_WAL_FRAMES: i64 = MAX_PENDING_WAL_FRAMES / 2;

/// Whether a store's WAL presses on its held readers, which keep it from
/// restarting: at least [`HELD_READER_WAL_FRAMES`] long with frames left to
/// backfill. Its length, not only its tail, is what reaches the refusal.
/// The store's writer raises it, and held readers stop for it; see
/// [`crate::EngineStore::wal_pressure`].
#[derive(Debug, Default)]
pub struct WalPressure {
    readers: std::sync::atomic::AtomicUsize,
    raised: AtomicBool,
}

impl WalPressure {
    pub fn raised(&self) -> bool {
        self.raised.load(Ordering::Relaxed)
    }

    /// Count a held reader until the answer drops; the writer measures the
    /// WAL before each write only while one is counted.
    pub fn hold(self: &Arc<Self>) -> HeldReader {
        self.readers.fetch_add(1, Ordering::Relaxed);
        HeldReader(Arc::clone(self))
    }

    pub(crate) fn held(&self) -> bool {
        self.readers.load(Ordering::Relaxed) > 0
    }

    /// Measure the WAL at `conn` and raise or lower the flag; whether raised.
    pub(crate) fn measure(&self, conn: &Connection) -> rusqlite::Result<bool> {
        let (log, backfilled) = frames(conn)?;
        let raised = log >= HELD_READER_WAL_FRAMES && log > backfilled;
        self.raised.store(raised, Ordering::Relaxed);
        Ok(raised)
    }
}

/// One held reader [`WalPressure`] counts.
#[derive(Debug)]
pub struct HeldReader(Arc<WalPressure>);

impl Drop for HeldReader {
    fn drop(&mut self) {
        self.0.readers.fetch_sub(1, Ordering::Relaxed);
    }
}

/// The outcome of a bounded wait for checkpoint work.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CheckpointWait {
    /// The same cycle is still doing checkpoint work.
    Running,
    /// A cycle completed, or the worker is idle.
    Finished,
}

struct CheckpointRun<'a>(&'a AtomicBool);

impl<'a> CheckpointRun<'a> {
    fn start(running: &'a AtomicBool) -> Self {
        running.store(true, Ordering::Release);
        Self(running)
    }
}

impl Drop for CheckpointRun<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

/// PASSIVE checkpoints use a separate connection, including during capture.
#[derive(Debug)]
pub(crate) struct Checkpoints {
    requests: Option<SyncSender<()>>,
    thread: Option<JoinHandle<()>>,
    stopped: Arc<AtomicBool>,
    full_requested: Arc<AtomicBool>,
    running: Arc<AtomicBool>,
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
        Self::start_observed(path, Arc::default(), Arc::default())
    }

    /// Replace this stopped worker. A wait taken from it watches the replacement.
    pub(crate) fn restart(&self, path: &Path) -> Result<Self, crate::StorageError> {
        Self::start_observed(path, Arc::clone(&self.running), Arc::clone(&self.completed))
    }

    fn start_observed(
        path: &Path,
        running: Arc<AtomicBool>,
        completed: Arc<(std::sync::Mutex<u64>, std::sync::Condvar)>,
    ) -> Result<Self, crate::StorageError> {
        let conn = Self::connection(path)?;
        let (requests, rx) = mpsc::sync_channel(1);
        let stopped = Arc::new(AtomicBool::new(false));
        let worker_stopped = Arc::clone(&stopped);
        let full_requested = Arc::new(AtomicBool::new(false));
        let worker_full = full_requested.clone();
        let worker_running = running.clone();
        let worker_completed = Arc::clone(&completed);
        let thread = std::thread::Builder::new()
            .name("dohc-wal-checkpoint".into())
            .spawn(move || {
                while rx.recv().is_ok() {
                    let run = CheckpointRun::start(&worker_running);
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
                    drop(run);
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
            running,
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

    pub(crate) fn next_cycle(&self) -> impl Fn() -> CheckpointWait + Send + Sync + use<> {
        let completed = self.completed.clone();
        let running = self.running.clone();
        move || wait_for_cycle(&completed, &running)
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

    #[cfg(any(test, feature = "test-support"))]
    pub(crate) fn completed_for_test(&self) -> u64 {
        *self.completed.0.lock().unwrap()
    }

    #[cfg(any(test, feature = "test-support"))]
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

fn wait_for_cycle(
    completed: &(std::sync::Mutex<u64>, std::sync::Condvar),
    running: &AtomicBool,
) -> CheckpointWait {
    let (sequence, signal) = completed;
    let guard = sequence.lock().unwrap();
    let before = *guard;
    let (sequence, _) = signal
        .wait_timeout_while(guard, std::time::Duration::from_millis(100), |s| {
            *s == before
        })
        .unwrap();
    if *sequence == before && running.load(Ordering::Acquire) {
        CheckpointWait::Running
    } else {
        CheckpointWait::Finished
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
        reader_checkpoint_race(false, false);
    }

    #[cfg(windows)]
    fn reader_checkpoint_race(raw: bool, deep: bool) {
        let scratch = ScratchDir::new().unwrap();
        let folder = if deep {
            crate::sqlite_path::deep_folder(scratch.path(), 300)
        } else {
            scratch.path().to_path_buf()
        };
        let path = folder.join("reader-race.db");
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
