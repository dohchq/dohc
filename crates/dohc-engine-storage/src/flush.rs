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
//! them. The drain runs on the database's folder, held open since the store
//! opened, so a workspace renamed, moved or replaced meanwhile still drains
//! the device its barriers ran on. The drain does not sync the WAL, so the
//! command's NORMAL commits are no more durable than before. A drain that
//! fails stays owed until one succeeds, and the reply carries the error.
//!
//! Intel Macs keep a drain per file: a Fusion Drive spans two devices under
//! one `st_dev`, and a barrier orders only one of them. An AppleRAID set on
//! Apple silicon has the same shape and is an accepted limit: it takes a
//! deliberate setup, and how APFS orders writes across its members is not
//! public. Other platforms call `sync_all` for every file and never owe a
//! drain.

use std::cell::Cell;
use std::fs::File;

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
    /// The `st_dev` that the database file and its folder share. `None`
    /// drains every file.
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    device: Cell<Option<u64>>,
    /// The database's folder, held open for the drain. It holds none of the
    /// POSIX locks SQLite takes on the database file.
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    folder: Option<File>,
    /// A barrier ran since the last successful drain.
    drain_owed: Cell<bool>,
    #[cfg(feature = "fault-injection")]
    trace: std::cell::RefCell<Vec<FlushEvent>>,
    #[cfg(feature = "fault-injection")]
    fail_next_drain: Cell<bool>,
    #[cfg(feature = "fault-injection")]
    observer: std::cell::RefCell<Option<FlushObserver>>,
}

/// Called with each recorded flush, as it happens.
#[cfg(feature = "fault-injection")]
pub(crate) struct FlushObserver(pub(crate) Box<dyn Fn(FlushEvent) + Send>);

#[cfg(feature = "fault-injection")]
impl std::fmt::Debug for FlushObserver {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("FlushObserver")
    }
}

/// The database's folder, opened now, and the device it shares with the
/// database file. The path is the one SQLite resolved, links included, when it
/// opened the database, so the barriers follow the file whose WAL it writes.
/// `None` when the folder cannot be opened or sits on another device than the
/// file; every file then drains at once.
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
fn database_folder(conn: &rusqlite::Connection) -> Option<(u64, File)> {
    use std::os::unix::fs::MetadataExt;
    let database = std::path::Path::new(conn.path().filter(|path| !path.is_empty())?);
    let device = std::fs::metadata(database).ok()?.dev();
    let folder = File::open(database.parent()?).ok()?;
    (folder.metadata().ok()?.dev() == device).then_some((device, folder))
}

impl Flushes {
    pub(crate) fn for_database(conn: &rusqlite::Connection) -> Self {
        #[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
        let _ = conn;
        #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
        let (device, folder) = database_folder(conn).unzip();
        Self {
            #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
            device: Cell::new(device),
            #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
            folder,
            drain_owed: Cell::new(false),
            #[cfg(feature = "fault-injection")]
            trace: std::cell::RefCell::default(),
            #[cfg(feature = "fault-injection")]
            fail_next_drain: Cell::new(false),
            #[cfg(feature = "fault-injection")]
            observer: std::cell::RefCell::default(),
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
    /// drain. `F_FULLFSYNC` drains the whole device, so it runs on the held
    /// folder: closing a descriptor on the database file would drop every
    /// POSIX lock SQLite holds on it.
    pub(crate) fn drain(&self) -> std::io::Result<()> {
        if !self.drain_owed.get() {
            return Ok(());
        }
        #[cfg(feature = "fault-injection")]
        if self.fail_next_drain.take() {
            return Err(std::io::Error::other("injected drain failure"));
        }
        #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
        {
            let folder = self
                .folder
                .as_ref()
                .ok_or_else(|| std::io::Error::other("no database folder to drain"))?;
            folder.sync_all()?;
            self.drain_owed.set(false);
            #[cfg(feature = "fault-injection")]
            self.record(FlushKind::Drain, folder);
        }
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
        let event = FlushEvent {
            kind,
            device,
            inode,
        };
        self.trace.borrow_mut().push(event);
        if let Some(FlushObserver(observe)) = &*self.observer.borrow() {
            observe(event);
        }
    }

    #[cfg(feature = "fault-injection")]
    pub(crate) fn observe(&self, observer: FlushObserver) {
        self.observer.replace(Some(observer));
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

    /// A database reached through a link drains the folder the link points
    /// to, not the folder holding the link.
    #[cfg(all(
        feature = "fault-injection",
        target_os = "macos",
        target_arch = "aarch64"
    ))]
    #[test]
    fn a_linked_database_drains_its_real_folder() {
        use std::os::unix::fs::MetadataExt;
        let scratch = ScratchDir::new_named("drain-linked").unwrap();
        std::fs::create_dir(scratch.path().join("real")).unwrap();
        std::fs::create_dir(scratch.path().join("alias")).unwrap();
        drop(EngineStore::open(&scratch.path().join("real/engine.db"), 1).unwrap());
        let alias = scratch.path().join("alias/engine.db");
        std::os::unix::fs::symlink(scratch.path().join("real/engine.db"), &alias).unwrap();
        let store = EngineStore::open(&alias, 1).unwrap();
        let note = scratch.path().join("note.md");
        std::fs::write(&note, b"ordered").unwrap();
        store
            .flush_before_commits(&std::fs::File::open(&note).unwrap())
            .unwrap();
        store.drain_flushes().unwrap();
        let drain = store.take_flush_trace().pop().unwrap();
        let real = std::fs::metadata(scratch.path().join("real")).unwrap();
        assert_eq!(drain.kind, crate::FlushKind::Drain);
        assert_eq!((drain.device, drain.inode), (real.dev(), real.ino()));
    }

    /// An APFS disk image, detached on drop. `None` when this host cannot
    /// create or attach one.
    #[cfg(all(
        feature = "fault-injection",
        target_os = "macos",
        target_arch = "aarch64"
    ))]
    struct Volume {
        mount: std::path::PathBuf,
    }

    #[cfg(all(
        feature = "fault-injection",
        target_os = "macos",
        target_arch = "aarch64"
    ))]
    impl Volume {
        fn attach(dir: &Path) -> Option<Self> {
            let image = dir.join("other.dmg");
            let mount = dir.join("other");
            std::fs::create_dir(&mount).ok()?;
            let hdiutil = || std::process::Command::new("hdiutil");
            let made = hdiutil()
                .args(["create", "-quiet", "-size", "40m", "-fs", "APFS"])
                .args(["-volname", "DOHCFLUSH"])
                .arg(&image)
                .status()
                .ok()?
                .success();
            let attached = made
                && hdiutil()
                    .args(["attach", "-quiet", "-nobrowse", "-mountpoint"])
                    .arg(&mount)
                    .arg(&image)
                    .status()
                    .ok()?
                    .success();
            attached.then_some(Self { mount })
        }
    }

    #[cfg(all(
        feature = "fault-injection",
        target_os = "macos",
        target_arch = "aarch64"
    ))]
    impl Drop for Volume {
        fn drop(&mut self) {
            let _ = std::process::Command::new("hdiutil")
                .args(["detach", "-quiet", "-force"])
                .arg(&self.mount)
                .status();
        }
    }

    /// A link on the startup disk to a database on another volume: files on
    /// the database's volume take barriers, files beside the link drain at
    /// once, and the owed drain flushes the database's volume.
    #[cfg(all(
        feature = "fault-injection",
        target_os = "macos",
        target_arch = "aarch64"
    ))]
    #[test]
    fn a_database_linked_across_volumes_orders_and_drains_its_own_volume() {
        use crate::FlushKind::{Barrier, Drain, Full};
        use std::os::unix::fs::MetadataExt;
        let scratch = ScratchDir::new_named("drain-across-volumes").unwrap();
        let Some(volume) = Volume::attach(scratch.path()) else {
            eprintln!("skipped: this host cannot attach a disk image");
            return;
        };
        let real = volume.mount.join("engine.db");
        drop(EngineStore::open(&real, 1).unwrap());
        let alias = scratch.path().join("engine.db");
        std::os::unix::fs::symlink(&real, &alias).unwrap();
        let store = EngineStore::open(&alias, 1).unwrap();
        let remote = volume.mount.join("remote.md");
        let local = scratch.path().join("local.md");
        for file in [&remote, &local] {
            std::fs::write(file, b"ordered").unwrap();
            store
                .flush_before_commits(&std::fs::File::open(file).unwrap())
                .unwrap();
        }
        store.drain_flushes().unwrap();
        let trace = store.take_flush_trace();
        let kinds: Vec<_> = trace.iter().map(|event| event.kind).collect();
        assert_eq!(kinds, [Barrier, Full, Drain]);
        let mount = std::fs::metadata(&volume.mount).unwrap();
        assert_eq!(
            (trace[2].device, trace[2].inode),
            (mount.dev(), mount.ino())
        );
        drop(store);
    }
}
