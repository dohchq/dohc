//! The page check of a store that serves before its pages are checked.
//!
//! Checking a store's pages reads the whole file, which takes about a minute
//! for each gigabyte the operating system has not cached. An actor's open
//! leaves that check to [`PageCheck`], which runs it on a connection of its
//! own while the store serves. A check that finds damage marks the store, so
//! the next open checks the pages before it serves and refuses the store.
//!
//! This is a chosen trade: a store that is already damaged when it opens is
//! read and written until the check ends, where an open that checks first
//! never touches it. In that time a write can make the damage worse, and a
//! damaged row that still reads as valid can reach a workspace file, a live
//! note's saved text, or the relay. Blob content is checked against its hash
//! on those paths. Backups and recovery check for themselves.
//!
//! The check reads one snapshot of the store from start to end, and the WAL
//! cannot restart while it does. It is a held reader: before it starts it
//! measures the WAL, and once the WAL presses it gives way to the writer and
//! starts again later from the first page. What it read stays in the
//! operating system's cache, so a new start is faster. It goes on trying
//! for as long as the store is open. After [`UNFINISHED_STARTS`] starts
//! without a verdict it also marks the store, so a store that is always
//! written to is checked at its next open instead of never.

use crate::checkpoint::{Checkpoints, WalPressure};
use crate::error::StorageError;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

/// What the store's owner does once the check has found damage. It runs on
/// the check's thread and must not wait for the store's owner.
pub type PagesDamaged = Box<dyn FnOnce() + Send>;

/// How long a check that gave way, or could not run, waits before its next
/// start. Each wait is twice the last, up to [`LONGEST_WAIT`].
const FIRST_WAIT: Duration = Duration::from_secs(1);
const LONGEST_WAIT: Duration = Duration::from_secs(600);

/// How many starts without a verdict mark the store for a check at its next
/// open. The tests wait for that mark.
const UNFINISHED_STARTS: u32 = if cfg!(test) { 3 } else { 10 };

/// The marker beside the store at `path`.
pub(crate) fn check_first_marker(path: &Path) -> PathBuf {
    let mut marker = path.as_os_str().to_owned();
    marker.push(".check-first");
    PathBuf::from(marker)
}

/// Whether the store at `path` is marked: its pages failed a check after an
/// open, or that check has not finished, so its next open checks them before
/// it serves.
pub(crate) fn marked(path: &Path) -> bool {
    check_first_marker(path).exists()
}

/// Mark the store at `path` for a check before it serves again. A marker that
/// cannot be written leaves the store to the check after its next open.
pub(crate) fn mark(path: &Path) {
    let marker = check_first_marker(path);
    let written = std::fs::File::create(&marker).and_then(|file| file.sync_all());
    // The marker's name lives in its folder, which is synced too where a
    // folder can be opened. The store's own files are never opened here:
    // closing such a descriptor would drop the locks SQLite holds on them.
    #[cfg(unix)]
    let written = written.and_then(|()| {
        let folder = marker.parent().unwrap_or(Path::new("."));
        std::fs::File::open(folder)?.sync_all()
    });
    if let Err(error) = written {
        eprintln!("engine store: could not mark the store for a check at its next open: {error}");
    }
}

/// The marked store at `path` checked sound.
pub(crate) fn unmark(path: &Path) {
    // A marker that stays costs only one more check at the next open.
    let _ = std::fs::remove_file(check_first_marker(path));
}

/// Whether a failed check found damage. Every other failure, such as a file
/// that could not be opened or read just then, says nothing about the pages.
fn is_damage(error: &StorageError) -> bool {
    match error {
        // `quick_check` answered, and not with "ok", or the schema is not this build's.
        StorageError::StateCorrupt { source: None } => true,
        StorageError::StateCorrupt {
            source: Some(source),
        } => source
            .downcast_ref::<rusqlite::Error>()
            .and_then(rusqlite::Error::sqlite_error_code)
            .is_some_and(|code| {
                matches!(
                    code,
                    rusqlite::ErrorCode::DatabaseCorrupt | rusqlite::ErrorCode::NotADatabase
                )
            }),
        _ => false,
    }
}

enum Attempt {
    Sound,
    Damaged,
    /// The check gave way, was stopped, or could not run. A later one may pass.
    Later,
}

/// One start of the check, from a measured WAL to a verdict or an early stop.
fn attempt(path: &Path, pressure: &Arc<WalPressure>, stopped: &Arc<AtomicBool>) -> Attempt {
    // A held reader measures the WAL before it starts. The flag it reads is
    // only as fresh as the writer's last write, and an idle store's writer
    // asks for no checkpoint, so a WAL that presses is copied here and
    // measured again. A flag still raised stops the check at its first step.
    let measured = Checkpoints::connection(path).and_then(|gauge| {
        if pressure.measure(&gauge).map_err(StorageError::persist)? {
            // Whatever this copies, the next measurement decides.
            let _ = gauge.query_row("PRAGMA main.wal_checkpoint(PASSIVE)", [], |_| Ok(()));
            pressure.measure(&gauge).map_err(StorageError::persist)?;
        }
        Ok(())
    });
    if let Err(error) = measured {
        eprintln!("engine store: the page check after opening could not start: {error}");
        return Attempt::Later;
    }
    // Counted while it reads, so the writer measures its WAL before each write.
    let held = pressure.hold();
    // Set by the check's own step when it stops early, which SQLite reports as a failure.
    let stopped_early = Arc::new(AtomicBool::new(false));
    let checked = crate::schema::check_pages_until(path, {
        let (stopped, pressure, stopped_early) = (
            Arc::clone(stopped),
            Arc::clone(pressure),
            Arc::clone(&stopped_early),
        );
        move || {
            let stop = stopped.load(Ordering::Acquire) || pressure.raised();
            if stop {
                stopped_early.store(true, Ordering::Release);
            }
            stop
        }
    });
    drop(held);
    match checked {
        Ok(()) => Attempt::Sound,
        Err(_) if stopped_early.load(Ordering::Acquire) => Attempt::Later,
        Err(error) if is_damage(&error) => Attempt::Damaged,
        Err(error) => {
            eprintln!("engine store: the page check after opening did not run: {error}");
            Attempt::Later
        }
    }
}

/// A running page check. Dropping it stops the check.
#[derive(Debug)]
pub(crate) struct PageCheck {
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl PageCheck {
    pub(crate) fn start(
        path: &Path,
        pressure: Arc<WalPressure>,
        damaged: PagesDamaged,
    ) -> Result<Self, StorageError> {
        let stop = Arc::new(AtomicBool::new(false));
        let stopped = Arc::clone(&stop);
        let path = path.to_path_buf();
        let thread = std::thread::Builder::new()
            .name("dohc-store-check".into())
            .spawn(move || {
                let mut wait = FIRST_WAIT;
                let mut unfinished = 0;
                loop {
                    match attempt(&path, &pressure, &stopped) {
                        Attempt::Sound => {
                            if unfinished >= UNFINISHED_STARTS {
                                unmark(&path);
                            }
                            return;
                        }
                        // A verdict reached as the store closes still marks it.
                        Attempt::Damaged => {
                            eprintln!(
                                "engine store: the page check after opening found damage; the store stops serving"
                            );
                            mark(&path);
                            damaged();
                            return;
                        }
                        Attempt::Later => {}
                    }
                    // A closing store's unfinished check leaves no mark.
                    if stopped.load(Ordering::Acquire) {
                        return;
                    }
                    unfinished += 1;
                    if unfinished == UNFINISHED_STARTS {
                        eprintln!(
                            "engine store: the page check after opening has not finished; the store's next open checks it first unless this check does"
                        );
                        mark(&path);
                    }
                    std::thread::park_timeout(wait);
                    wait = (wait * 2).min(LONGEST_WAIT);
                    if stopped.load(Ordering::Acquire) {
                        return;
                    }
                }
            })
            .map_err(StorageError::persist)?;
        Ok(Self {
            stop,
            thread: Some(thread),
        })
    }
}

#[cfg(any(test, feature = "test-support"))]
impl PageCheck {
    /// Whether the check has ended, with a verdict or because it was stopped.
    pub(crate) fn has_ended(&self) -> bool {
        self.thread
            .as_ref()
            .is_none_or(std::thread::JoinHandle::is_finished)
    }
}

#[cfg(test)]
impl PageCheck {
    /// Waits for the check to end by itself.
    pub(crate) fn join(&mut self) {
        if let Some(thread) = self.thread.take() {
            thread.join().unwrap();
        }
    }
}

impl Drop for PageCheck {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(thread) = self.thread.take() {
            thread.thread().unpark();
            let _ = thread.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn failure(code: std::ffi::c_int) -> StorageError {
        StorageError::corrupt(rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error::new(code),
            None,
        ))
    }

    #[test]
    fn only_a_failed_check_and_a_corrupt_file_count_as_damage() {
        assert!(is_damage(&StorageError::StateCorrupt { source: None }));
        assert!(is_damage(&failure(rusqlite::ffi::SQLITE_CORRUPT)));
        assert!(is_damage(&failure(rusqlite::ffi::SQLITE_NOTADB)));
        // A file that could not be opened or read just then is no verdict on its pages.
        for code in [
            rusqlite::ffi::SQLITE_IOERR,
            rusqlite::ffi::SQLITE_CANTOPEN,
            rusqlite::ffi::SQLITE_NOMEM,
            rusqlite::ffi::SQLITE_PROTOCOL,
            rusqlite::ffi::SQLITE_INTERRUPT,
            rusqlite::ffi::SQLITE_BUSY,
        ] {
            assert!(!is_damage(&failure(code)), "{code}");
        }
        assert!(!is_damage(&StorageError::MigrationPending));
    }
}
