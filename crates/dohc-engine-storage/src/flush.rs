//! How the store flushes the files its later commits describe.
//!
//! A materialization flushes a file, then commits the job's status at
//! `synchronous = NORMAL`, which syncs nothing. The status must never reach
//! the disk before the file. On macOS, `File::sync_all` is `F_FULLFSYNC`,
//! which also drains the drive cache, at several milliseconds per call.
//!
//! On Apple silicon, a barrier (`F_BARRIERFSYNC`) orders the file before every
//! later write on the same device, including the WAL frame that holds the
//! status, without the drain. Only a file whose `st_dev` matches the database
//! file's takes a barrier; any other file is still drained at once. A barrier
//! leaves a drain owed. The actor pays it before each reply, so the files a
//! command projected are as durable at its reply as a drain per file made
//! them. The drain does not sync the WAL, so the command's NORMAL commits are
//! no more durable than before. A drain that fails stays owed until one
//! succeeds, and the reply carries the error.
//!
//! Intel Macs keep a drain per file: a Fusion Drive spans two devices under
//! one `st_dev`, and a barrier orders only one of them. An AppleRAID set on
//! Apple silicon has the same shape and is an accepted limit: it takes a
//! deliberate setup, and how APFS orders writes across its members is not
//! public. Other platforms call `sync_all` for every file and never owe a
//! drain.

use std::cell::Cell;
use std::fs::File;
use std::path::Path;

/// What a flush did, as the harness records it.
#[cfg(feature = "fault-injection")]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FlushKind {
    /// `F_BARRIERFSYNC`: ordered before later writes on the device, not drained.
    Barrier,
    /// `File::sync_all`: `F_FULLFSYNC` on macOS, `fsync` or
    /// `FlushFileBuffers` elsewhere.
    Full,
    /// The owed drain: `F_FULLFSYNC` on the database's folder.
    Drain,
}

/// One recorded flush and the file or folder it ran on, by device and inode.
/// Both are 0 off Unix.
#[cfg(feature = "fault-injection")]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FlushEvent {
    pub kind: FlushKind,
    pub device: u64,
    pub inode: u64,
}

#[derive(Debug)]
pub(crate) struct Flushes {
    /// The database file's `st_dev`. `None` drains every file.
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    device: Cell<Option<u64>>,
    /// A barrier ran since the last successful drain.
    drain_owed: Cell<bool>,
    #[cfg(feature = "fault-injection")]
    trace: std::cell::RefCell<Vec<FlushEvent>>,
    #[cfg(feature = "fault-injection")]
    fail_next_drain: Cell<bool>,
}

impl Flushes {
    pub(crate) fn for_database(path: &Path) -> Self {
        #[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
        let _ = path;
        Self {
            #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
            device: Cell::new({
                use std::os::unix::fs::MetadataExt;
                std::fs::metadata(path).ok().map(|metadata| metadata.dev())
            }),
            drain_owed: Cell::new(false),
            #[cfg(feature = "fault-injection")]
            trace: std::cell::RefCell::default(),
            #[cfg(feature = "fault-injection")]
            fail_next_drain: Cell::new(false),
        }
    }

    pub(crate) fn flush(&self, file: &File) -> std::io::Result<()> {
        #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
        {
            use std::os::unix::fs::MetadataExt;
            if self.device.get() == Some(file.metadata()?.dev()) {
                dohc_macos_files::barrier_fsync(file)?;
                self.drain_owed.set(true);
                #[cfg(feature = "fault-injection")]
                self.record(FlushKind::Barrier, file);
                return Ok(());
            }
        }
        file.sync_all()?;
        #[cfg(feature = "fault-injection")]
        self.record(FlushKind::Full, file);
        Ok(())
    }

    /// Drain the drive cache when a barrier ran since the last successful
    /// drain. `F_FULLFSYNC` drains the whole device, so it runs on the
    /// database's folder: closing a descriptor on the database file would drop
    /// every POSIX lock SQLite holds on it.
    pub(crate) fn drain(&self, database: &Path) -> std::io::Result<()> {
        if !self.drain_owed.get() {
            return Ok(());
        }
        #[cfg(feature = "fault-injection")]
        if self.fail_next_drain.take() {
            return Err(std::io::Error::other("injected drain failure"));
        }
        let folder = match database.parent() {
            Some(folder) if !folder.as_os_str().is_empty() => folder,
            _ => Path::new("."),
        };
        let folder = File::open(folder)?;
        folder.sync_all()?;
        self.drain_owed.set(false);
        #[cfg(feature = "fault-injection")]
        self.record(FlushKind::Drain, &folder);
        Ok(())
    }

    #[cfg(feature = "fault-injection")]
    fn record(&self, kind: FlushKind, file: &File) {
        #[cfg(unix)]
        let (device, inode) = {
            use std::os::unix::fs::MetadataExt;
            let metadata = file.metadata().expect("flushed file metadata");
            (metadata.dev(), metadata.ino())
        };
        #[cfg(not(unix))]
        let (device, inode) = {
            let _ = file;
            (0, 0)
        };
        self.trace.borrow_mut().push(FlushEvent {
            kind,
            device,
            inode,
        });
    }

    #[cfg(feature = "fault-injection")]
    pub(crate) fn take_trace(&self) -> Vec<FlushEvent> {
        self.trace.take()
    }

    #[cfg(feature = "fault-injection")]
    pub(crate) fn fail_next_drain(&self) {
        self.fail_next_drain.set(true);
    }

    #[cfg(all(
        feature = "fault-injection",
        target_os = "macos",
        target_arch = "aarch64"
    ))]
    pub(crate) fn order_on_device(&self, device: Option<u64>) {
        self.device.set(device);
    }
}

#[cfg(all(test, unix))]
mod tests {
    use crate::EngineStore;
    use dohc_test_scratch::ScratchDir;
    use std::path::Path;

    const PROBE: &str = "DOHC_DRAIN_LOCK_PROBE";
    const TEST: &str = "flush::tests::a_drain_keeps_the_locks_sqlite_holds_on_the_database";

    /// Whether another process can take the database's EXCLUSIVE lock. POSIX
    /// locks never conflict within one process, so the probe is a child.
    fn another_process_can_lock(db: &Path) -> bool {
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", TEST, "--nocapture"])
            .env(PROBE, db)
            .output()
            .unwrap();
        let stdout = String::from_utf8_lossy(&output.stdout);
        assert!(
            output.status.success(),
            "{stdout}{}",
            String::from_utf8_lossy(&output.stderr)
        );
        if stdout.contains("DRAIN_LOCK_PROBE taken") {
            true
        } else {
            assert!(stdout.contains("DRAIN_LOCK_PROBE busy"), "{stdout}");
            false
        }
    }

    /// In WAL mode SQLite holds a SHARED lock on the database file for the
    /// connection's life. Closing any descriptor on that file would drop it,
    /// and another process could then check point and delete the WAL under
    /// the store. The drain must leave the lock in place.
    #[test]
    fn a_drain_keeps_the_locks_sqlite_holds_on_the_database() {
        if let Some(db) = std::env::var_os(PROBE) {
            let conn = rusqlite::Connection::open(db).unwrap();
            conn.busy_timeout(std::time::Duration::ZERO).unwrap();
            conn.pragma_update(None, "locking_mode", "EXCLUSIVE")
                .unwrap();
            let read = conn.query_row("SELECT count(*) FROM sqlite_master", [], |row| {
                row.get::<_, i64>(0)
            });
            println!(
                "DRAIN_LOCK_PROBE {}",
                if read.is_ok() { "taken" } else { "busy" }
            );
            return;
        }
        let scratch = ScratchDir::new_named("drain-lock").unwrap();
        let db = scratch.path().join("engine.db");
        let store = EngineStore::open(&db, 1).unwrap();
        assert!(
            !another_process_can_lock(&db),
            "an open store holds its lock"
        );
        let note = scratch.path().join("note.md");
        std::fs::write(&note, b"ordered").unwrap();
        store
            .flush_before_commits(&std::fs::File::open(&note).unwrap())
            .unwrap();
        store.drain_flushes().unwrap();
        #[cfg(feature = "fault-injection")]
        assert_eq!(
            store.take_flush_trace().last().map(|event| event.kind),
            Some(if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
                crate::FlushKind::Drain
            } else {
                crate::FlushKind::Full
            })
        );
        assert!(!another_process_can_lock(&db), "a drain keeps the lock");
        drop(store);
        assert!(
            another_process_can_lock(&db),
            "the probe locks a closed store"
        );
    }
}
