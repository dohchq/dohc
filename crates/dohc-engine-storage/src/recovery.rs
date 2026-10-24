//! An earlier store of a workspace, opened for its owner's recovery copy
//! without changing it.
//!
//! The store is quiescent: nothing else may open it while it serves recovery.
//! Its connection never writes, sets session-only exclusive locking before
//! its first read, so SQLite keeps the WAL index in memory and creates no
//! `-shm`, and never checkpoints on close. Every committed edit still in the
//! WAL is read. A store fully migrated by this build is read in place. One
//! with pending migrations is copied, with SQLite's backup API, from the same
//! read snapshot the caller checked, into a private folder the caller makes;
//! the copy runs the ordinary migrations and is then read.

use crate::backup::FreeSpaceProbe;
use crate::error::StorageError;
use crate::migration::LedgerState;
use crate::store::EngineStore;
use rusqlite::config::DbConfig;
use rusqlite::{Connection, OpenFlags};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

/// Pages the backup copies between cancellation checks.
const COPY_PAGES_PER_STEP: std::ffi::c_int = 1024;

/// Room the migrations of a copy may need beyond twice its size: a migration
/// that rebuilds a table writes it again, and every one checks the copy.
const COPY_HEADROOM_BYTES: u64 = 16 * 1024 * 1024;

/// Why an earlier store could not be opened for recovery.
#[derive(Debug, thiserror::Error)]
pub enum RecoveryError {
    /// The caller's check refused the store's contents.
    #[error("recovery store refused")]
    Refused,
    /// Cancelled before the store was ready.
    #[error("recovery store preparation cancelled")]
    Cancelled,
    /// The private folder for a copy could not be made.
    #[error("recovery copy folder unavailable")]
    Folder(#[source] std::io::Error),
    /// The store, its copy or its migrations failed. A busy store is
    /// [`StorageError::FileLocked`], and a volume without room for the copy
    /// is [`StorageError::DiskFull`].
    #[error(transparent)]
    Storage(#[from] StorageError),
}

/// An earlier store ready for page reads.
#[derive(Debug)]
pub struct PreparedRecovery {
    store: EngineStore,
    copied: bool,
    // Dropped after `store` closes.
    _created: CreatedWal,
}

impl PreparedRecovery {
    /// The store, or its migrated copy, for queries only.
    pub fn store(&self) -> &EngineStore {
        &self.store
    }

    /// Whether the store is a copy in the caller's folder.
    pub fn copied(&self) -> bool {
        self.copied
    }
}

/// The source's WAL when the source had none: a WAL-mode connection creates
/// an empty one as it opens. Dropped after that connection closes, it removes
/// the file if it is still empty, so the source's folder is left as it was.
#[derive(Debug)]
struct CreatedWal(Option<PathBuf>);

impl CreatedWal {
    fn watch(source: &Path) -> Self {
        let mut wal = source.as_os_str().to_owned();
        wal.push("-wal");
        let wal = PathBuf::from(wal);
        Self(std::fs::symlink_metadata(&wal).is_err().then_some(wal))
    }
}

impl Drop for CreatedWal {
    fn drop(&mut self) {
        if let Some(wal) = &self.0
            && std::fs::symlink_metadata(wal).is_ok_and(|wal| wal.is_file() && wal.len() == 0)
        {
            let _ = std::fs::remove_file(wal);
        }
    }
}

/// Open the store at `source` for recovery. `accept` checks its contents
/// inside the read snapshot the store is then read or copied from; `false`
/// refuses it. `folder` makes the private, empty folder a copy goes in, only
/// when one is needed; the caller owns it and removes it whatever this
/// returns. Setting `cancelled` stops a copy between steps and interrupts its
/// migrations, and interrupts any statement reading the store.
pub fn open_for_recovery(
    source: &Path,
    accept: impl FnOnce(&Connection) -> rusqlite::Result<bool>,
    folder: impl FnOnce() -> std::io::Result<PathBuf>,
    free_space: &dyn FreeSpaceProbe,
    cancelled: &Arc<AtomicBool>,
    now_ms: i64,
) -> Result<PreparedRecovery, RecoveryError> {
    prepare(source, accept, folder, free_space, cancelled, now_ms).map_err(|error| {
        if cancelled.load(Ordering::Relaxed) {
            RecoveryError::Cancelled
        } else {
            error
        }
    })
}

fn prepare(
    source: &Path,
    accept: impl FnOnce(&Connection) -> rusqlite::Result<bool>,
    folder: impl FnOnce() -> std::io::Result<PathBuf>,
    free_space: &dyn FreeSpaceProbe,
    cancelled: &Arc<AtomicBool>,
    now_ms: i64,
) -> Result<PreparedRecovery, RecoveryError> {
    // Declared first, so it drops after the connection.
    let created = CreatedWal::watch(source);
    let conn = open_source(source, cancelled.clone())?;
    let ledger = crate::schema::classify_existing(&conn)?;
    let passive = crate::schema::store_is_passive(&conn)?;
    if !accept(&conn).map_err(StorageError::corrupt)? {
        return Err(RecoveryError::Refused);
    }
    if ledger == LedgerState::Current {
        crate::schema::check_current(&conn)?;
        conn.execute_batch("COMMIT")
            .map_err(StorageError::corrupt)?;
        // Page reads are not part of the preparation.
        conn.progress_handler(0, None::<fn() -> bool>)
            .map_err(StorageError::corrupt)?;
        return Ok(PreparedRecovery {
            store: EngineStore::from_read_only(conn, source, passive),
            copied: false,
            _created: created,
        });
    }
    let folder = folder().map_err(RecoveryError::Folder)?;
    let pragma = |name| {
        conn.pragma_query_value(None, name, |row| row.get::<_, i64>(0))
            .map_err(StorageError::corrupt)
    };
    let bytes = u64::try_from(pragma("page_count")?.saturating_mul(pragma("page_size")?))
        .map_err(|_| StorageError::StateCorrupt { source: None })?;
    let needed = bytes.saturating_mul(2).saturating_add(COPY_HEADROOM_BYTES);
    let available = free_space.available_bytes(&folder)?;
    if available < needed {
        return Err(StorageError::DiskFull { needed, available }.into());
    }
    let copy = folder.join("engine.db");
    let mut target = crate::open_store(
        &copy,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE,
    )
    .map_err(StorageError::corrupt)?;
    copy_snapshot(&conn, &mut target, cancelled)
        .map_err(|error| full(error, needed, free_space, &folder))?;
    drop(target);
    conn.execute_batch("COMMIT")
        .map_err(StorageError::corrupt)?;
    drop(conn);
    drop(created);
    let migrated =
        crate::schema::open_engine_db_cancellable(&copy, now_ms, passive, cancelled.clone())
            .map_err(|error| {
                if cancelled.load(Ordering::Relaxed) {
                    RecoveryError::Cancelled
                } else {
                    full(error.into(), needed, free_space, &folder)
                }
            })?;
    drop(migrated);
    Ok(PreparedRecovery {
        store: EngineStore::open_read_only(&copy)?,
        copied: true,
        _created: CreatedWal(None),
    })
}

/// A connection to `path` that reads it as one quiescent snapshot and changes
/// nothing: no write, no checkpoint on close, and exclusive locking set
/// before the first read, so the WAL index stays in memory. A store another
/// connection holds is [`StorageError::FileLocked`] once the busy timeout
/// passes. The snapshot's read transaction is open; the caller ends it.
///
/// POSIX refuses an exclusive lock through a read-only descriptor, so the
/// file is opened for writing and the connection refuses every write. It
/// never creates the file. Its statements stop once `cancelled` is set.
fn open_source(path: &Path, cancelled: Arc<AtomicBool>) -> Result<Connection, StorageError> {
    crate::schema::reject_undersized_database(path)?;
    let conn = crate::open_store(path, OpenFlags::SQLITE_OPEN_READ_WRITE)
        .map_err(StorageError::corrupt)?;
    conn.set_db_config(DbConfig::SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE, true)
        .map_err(StorageError::corrupt)?;
    conn.progress_handler(
        crate::schema::OPEN_WORK_STEP_OPS,
        Some(move || cancelled.load(Ordering::Relaxed)),
    )
    .map_err(StorageError::corrupt)?;
    crate::schema::apply_session_pragmas(&conn)?;
    conn.pragma_update(None, "query_only", true)
        .map_err(StorageError::corrupt)?;
    let mode: String = conn
        .pragma_update_and_check(None, "locking_mode", "EXCLUSIVE", |row| row.get(0))
        .map_err(StorageError::corrupt)?;
    if !mode.eq_ignore_ascii_case("exclusive") {
        return Err(StorageError::StateCorrupt { source: None });
    }
    conn.execute_batch("BEGIN").map_err(StorageError::corrupt)?;
    Ok(conn)
}

/// Copy the snapshot `source` reads into `target`, checking `cancelled`
/// between steps.
fn copy_snapshot(
    source: &Connection,
    target: &mut Connection,
    cancelled: &AtomicBool,
) -> Result<(), RecoveryError> {
    let backup = rusqlite::backup::Backup::new(source, target).map_err(StorageError::corrupt)?;
    loop {
        if cancelled.load(Ordering::Relaxed) {
            return Err(RecoveryError::Cancelled);
        }
        match backup
            .step(COPY_PAGES_PER_STEP)
            .map_err(StorageError::corrupt)?
        {
            rusqlite::backup::StepResult::Done => return Ok(()),
            rusqlite::backup::StepResult::More => {}
            _ => return Err(StorageError::FileLocked.into()),
        }
    }
}

/// `error`, or [`StorageError::DiskFull`] when SQLite ran out of room for the
/// copy or its migrations.
fn full(
    error: RecoveryError,
    needed: u64,
    free_space: &dyn FreeSpaceProbe,
    folder: &Path,
) -> RecoveryError {
    let RecoveryError::Storage(storage) = &error else {
        return error;
    };
    let mut cause: Option<&(dyn std::error::Error + 'static)> = Some(storage);
    while let Some(current) = cause {
        if current
            .downcast_ref::<rusqlite::Error>()
            .and_then(rusqlite::Error::sqlite_error_code)
            == Some(rusqlite::ErrorCode::DiskFull)
        {
            return StorageError::DiskFull {
                needed,
                available: free_space.available_bytes(folder).unwrap_or(0),
            }
            .into();
        }
        cause = current.source();
    }
    error
}

/// Create the store at `path` as a build that defined every migration but
/// the last `missing` left it.
#[cfg(any(test, feature = "test-support"))]
pub fn create_earlier_store_for_test(path: &Path, missing: usize) -> Result<(), StorageError> {
    use crate::migration::{BASELINE_MIGRATIONS, MigrationContext, run_migrations};
    let mut conn = Connection::open(path).map_err(StorageError::corrupt)?;
    conn.pragma_update(None, "journal_mode", "WAL")
        .map_err(StorageError::corrupt)?;
    let prefix = &BASELINE_MIGRATIONS[..BASELINE_MIGRATIONS.len() - missing];
    run_migrations(
        &mut conn,
        prefix,
        &MigrationContext::current(1),
        &crate::NoFaults,
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backup::RealFreeSpace;
    use crate::migration::BASELINE_MIGRATIONS;
    use crate::{get_binary_blob, put_binary_blob};

    /// A store an older build last opened: every migration but the last ran.
    fn earlier_store(path: &Path) {
        create_earlier_store_for_test(path, 1).unwrap();
    }

    /// Commits `bytes` as a blob that stays in the WAL alone: nothing
    /// checkpoints it, on close or otherwise.
    fn blob_in_wal(path: &Path, bytes: &[u8]) -> String {
        let conn = Connection::open(path).unwrap();
        conn.set_db_config(DbConfig::SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE, true)
            .unwrap();
        conn.pragma_update(None, "wal_autocheckpoint", 0).unwrap();
        put_binary_blob(&conn, bytes).unwrap()
    }

    /// Every file in `dir` with the digest of its bytes.
    fn contents(dir: &Path) -> Vec<(std::ffi::OsString, String)> {
        let mut files: Vec<_> = std::fs::read_dir(dir)
            .unwrap()
            .map(|entry| {
                let entry = entry.unwrap();
                let bytes = std::fs::read(entry.path()).unwrap();
                (entry.file_name(), crate::hex_sha256(&bytes))
            })
            .collect();
        files.sort();
        files
    }

    fn open(
        source: &Path,
        folder: &Path,
        free_space: &dyn FreeSpaceProbe,
        cancelled: &Arc<AtomicBool>,
    ) -> Result<PreparedRecovery, RecoveryError> {
        open_for_recovery(
            source,
            |_| Ok(true),
            || std::fs::create_dir(folder).map(|()| folder.to_path_buf()),
            free_space,
            cancelled,
            1,
        )
    }

    struct Space(u64);
    impl FreeSpaceProbe for Space {
        fn available_bytes(&self, _: &Path) -> Result<u64, StorageError> {
            Ok(self.0)
        }
    }

    #[test]
    fn a_current_store_is_read_in_place_with_its_wal_and_no_copy() {
        let scratch = dohc_test_scratch::ScratchDir::new_named("recovery-current").unwrap();
        let (store, folder) = (scratch.path().join("store"), scratch.path().join("copy"));
        std::fs::create_dir(&store).unwrap();
        let source = store.join("engine.db");
        drop(EngineStore::open(&source, 1).unwrap());
        let sha = blob_in_wal(&source, b"kept in the wal");
        std::fs::remove_file(store.join("engine.db-shm")).unwrap();
        let before = contents(&store);
        assert!(before.iter().any(|(name, _)| name == "engine.db-wal"));
        let prepared = open(&source, &folder, &RealFreeSpace, &Arc::default()).unwrap();
        assert!(!prepared.copied());
        assert!(!folder.exists());
        let read = prepared
            .store()
            .read_with(|conn| get_binary_blob(conn, &sha))
            .unwrap();
        assert_eq!(read.as_deref(), Some(&b"kept in the wal"[..]));
        // Held exclusively: no other connection reads it meanwhile.
        let other = Connection::open_with_flags(&source, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        other.busy_timeout(std::time::Duration::ZERO).unwrap();
        assert!(
            other
                .query_row("SELECT COUNT(*) FROM binary_blobs", [], |row| row
                    .get::<_, i64>(0))
                .is_err()
        );
        drop(other);
        drop(prepared);
        assert_eq!(contents(&store), before);
        // A cancelled check of a store read in place stops, and leaves it as it was.
        let cancelled = Arc::new(AtomicBool::new(true));
        let refused = open(&source, &folder, &RealFreeSpace, &cancelled).unwrap_err();
        assert!(matches!(refused, RecoveryError::Cancelled), "{refused:?}");
        assert_eq!(contents(&store), before);
    }

    #[test]
    fn an_earlier_store_is_copied_with_its_wal_then_migrated_and_left_as_it_was() {
        for keep_shm in [true, false] {
            let scratch = dohc_test_scratch::ScratchDir::new_named("recovery-earlier").unwrap();
            let (store, folder) = (scratch.path().join("store"), scratch.path().join("copy"));
            std::fs::create_dir(&store).unwrap();
            let source = store.join("engine.db");
            earlier_store(&source);
            // Before the schema: an older store can lack tables this build requires.
            assert!(matches!(
                EngineStore::open_read_only(&source),
                Err(StorageError::MigrationPending)
            ));
            let sha = blob_in_wal(&source, b"committed in the wal");
            if !keep_shm {
                std::fs::remove_file(store.join("engine.db-shm")).unwrap();
            }
            let before = contents(&store);
            assert!(before.iter().any(|(name, _)| name == "engine.db-wal"));
            let prepared = open(&source, &folder, &RealFreeSpace, &Arc::default()).unwrap();
            assert!(prepared.copied());
            assert_eq!(contents(&store), before, "keep_shm={keep_shm}");
            let read = prepared
                .store()
                .read_with(|conn| {
                    let migrated = crate::migration::classify_ledger(conn, BASELINE_MIGRATIONS)?;
                    Ok::<_, StorageError>((migrated, get_binary_blob(conn, &sha)?))
                })
                .unwrap();
            assert_eq!(read.0, LedgerState::Current);
            assert_eq!(read.1.as_deref(), Some(&b"committed in the wal"[..]));
            assert!(folder.join("engine.db").exists());
            drop(prepared);
            assert_eq!(contents(&store), before);
        }
    }

    #[test]
    fn a_refused_ledger_or_store_is_never_read_or_copied() {
        type Damage = fn(&Path);
        let cases: [(&str, Damage, &str); 5] = [
            (
                "unknown",
                |source| {
                    Connection::open(source).unwrap().execute_batch(
                    "INSERT INTO engine_migrations VALUES (9999,'v9-later','x','b',1,1,1,1,1)",
                ).unwrap();
                },
                "migrated-by-newer-build",
            ),
            (
                "checksum",
                |source| {
                    Connection::open(source)
                        .unwrap()
                        .execute_batch(
                            "UPDATE engine_migrations SET checksum='other' WHERE ordinal=1",
                        )
                        .unwrap();
                },
                "migration-failed",
            ),
            (
                "ordinal",
                |source| {
                    Connection::open(source)
                        .unwrap()
                        .execute_batch(
                            "UPDATE engine_migrations SET ordinal=ordinal+1000 WHERE ordinal=2",
                        )
                        .unwrap();
                },
                "migration-failed",
            ),
            (
                "integrity",
                |source| {
                    Connection::open(source)
                        .unwrap()
                        .execute_batch(
                            "UPDATE engine_migrations SET integrity_ok=0 WHERE ordinal=3",
                        )
                        .unwrap();
                },
                "migration-failed",
            ),
            (
                "corrupt",
                |source| {
                    let mut bytes = std::fs::read(source).unwrap();
                    bytes[100..4096].fill(0xA5);
                    std::fs::write(source, bytes).unwrap();
                },
                "state-corrupt",
            ),
        ];
        for (name, damage, code) in cases {
            let scratch = dohc_test_scratch::ScratchDir::new_named("recovery-refused").unwrap();
            let (store, folder) = (scratch.path().join("store"), scratch.path().join("copy"));
            std::fs::create_dir(&store).unwrap();
            let source = store.join("engine.db");
            earlier_store(&source);
            Connection::open(&source)
                .unwrap()
                .pragma_update(None, "wal_checkpoint", "TRUNCATE")
                .unwrap();
            damage(&source);
            let before = contents(&store);
            let refused = open(&source, &folder, &RealFreeSpace, &Arc::default()).unwrap_err();
            assert!(
                matches!(&refused, RecoveryError::Storage(error) if error.code() == code),
                "{name}: {refused:?}"
            );
            assert!(!folder.exists(), "{name}");
            assert_eq!(contents(&store), before, "{name}");
        }
        // A store the caller's check refuses is neither read nor copied.
        let scratch = dohc_test_scratch::ScratchDir::new_named("recovery-refused").unwrap();
        let source = scratch.path().join("engine.db");
        earlier_store(&source);
        let refused = open_for_recovery(
            &source,
            |_| Ok(false),
            || -> std::io::Result<PathBuf> { panic!("no copy of a refused store") },
            &RealFreeSpace,
            &Arc::default(),
            1,
        )
        .unwrap_err();
        assert!(matches!(refused, RecoveryError::Refused));
    }

    #[test]
    fn a_migration_that_fails_on_the_copy_stays_a_refusal() {
        let scratch = dohc_test_scratch::ScratchDir::new_named("recovery-runner").unwrap();
        let (store, folder) = (scratch.path().join("store"), scratch.path().join("copy"));
        std::fs::create_dir(&store).unwrap();
        let source = store.join("engine.db");
        earlier_store(&source);
        // The last migration creates this table, so on this store it fails.
        Connection::open(&source)
            .unwrap()
            .execute_batch("CREATE TABLE owner_ydoc_outbox_refusals (planted INTEGER)")
            .unwrap();
        let before = contents(&store);
        let refused = open(&source, &folder, &RealFreeSpace, &Arc::default()).unwrap_err();
        assert!(
            matches!(&refused, RecoveryError::Storage(error) if error.code() == "migration-failed"),
            "{refused:?}"
        );
        assert_eq!(contents(&store), before);
    }

    #[test]
    fn a_copy_without_room_or_cancelled_leaves_the_store_as_it_was() {
        let scratch = dohc_test_scratch::ScratchDir::new_named("recovery-space").unwrap();
        let store = scratch.path().join("store");
        std::fs::create_dir(&store).unwrap();
        let source = store.join("engine.db");
        earlier_store(&source);
        blob_in_wal(&source, b"in the wal");
        let before = contents(&store);
        let refused = open(
            &source,
            &scratch.path().join("small"),
            &Space(1024),
            &Arc::default(),
        )
        .unwrap_err();
        assert!(
            matches!(
                refused,
                RecoveryError::Storage(StorageError::DiskFull {
                    available: 1024,
                    ..
                })
            ),
            "{refused:?}"
        );
        let cancelled = Arc::new(AtomicBool::new(true));
        let refused = open(
            &source,
            &scratch.path().join("cancelled"),
            &RealFreeSpace,
            &cancelled,
        )
        .unwrap_err();
        assert!(matches!(refused, RecoveryError::Cancelled), "{refused:?}");
        assert_eq!(contents(&store), before);
        // A volume that fills during the copy refuses as one without room.
        let source_conn = open_source(&source, Arc::default()).unwrap();
        let mut target = Connection::open(scratch.path().join("full.db")).unwrap();
        target.pragma_update(None, "max_page_count", 8).unwrap();
        let failed = copy_snapshot(&source_conn, &mut target, &AtomicBool::new(false)).unwrap_err();
        let failed = full(failed, 1, &Space(7), scratch.path());
        assert!(
            matches!(
                failed,
                RecoveryError::Storage(StorageError::DiskFull { available: 7, .. })
            ),
            "{failed:?}"
        );
        drop((source_conn, target));
        assert_eq!(contents(&store), before);
    }

    #[test]
    fn a_store_another_connection_holds_is_busy() {
        let scratch = dohc_test_scratch::ScratchDir::new_named("recovery-busy").unwrap();
        let store = scratch.path().join("store");
        std::fs::create_dir(&store).unwrap();
        let source = store.join("engine.db");
        earlier_store(&source);
        let holder = Connection::open(&source).unwrap();
        holder.execute_batch("BEGIN IMMEDIATE").unwrap();
        let refused = open(
            &source,
            &scratch.path().join("copy"),
            &RealFreeSpace,
            &Arc::default(),
        )
        .unwrap_err();
        assert!(
            matches!(refused, RecoveryError::Storage(StorageError::FileLocked)),
            "{refused:?}"
        );
        assert!(!scratch.path().join("copy").exists());
    }
}
