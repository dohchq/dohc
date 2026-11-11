use std::path::Path;

/// Open the store at `path`. On Linux a path that reaches its folder
/// through a descriptor the engine holds opens with the VFS that keeps that
/// path, so the store and every file SQLite opens beside it go through that
/// folder, not through whatever has its name.
pub(crate) fn open_store(
    path: &Path,
    flags: rusqlite::OpenFlags,
) -> rusqlite::Result<rusqlite::Connection> {
    #[cfg(target_os = "linux")]
    if dohc_linux_files::held::is_path_by_fd(path) {
        let vfs = dohc_linux_files::held::held_vfs().map_err(|err| {
            let code = rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_CANTOPEN);
            rusqlite::Error::SqliteFailure(code, Some(err.to_string()))
        })?;
        return rusqlite::Connection::open_with_flags_and_vfs(path, flags, vfs);
    }
    rusqlite::Connection::open_with_flags(path, flags)
}

/// A new folder in `root` whose canonical path is at least `units` UTF-16
/// units long, deeper than Windows' 260-unit `MAX_PATH`.
#[cfg(all(test, windows))]
pub(crate) fn deep_folder(root: &Path, units: usize) -> std::path::PathBuf {
    use std::os::windows::ffi::OsStrExt;
    let mut folder = std::fs::canonicalize(root).unwrap();
    while folder.as_os_str().encode_wide().count() < units {
        folder.push("d".repeat(100));
    }
    std::fs::create_dir_all(&folder).unwrap();
    folder
}

/// #2338: a store deeper than `MAX_PATH` is created, written, backed up,
/// verified and reopened through its verbatim path.
#[cfg(all(test, windows))]
#[test]
fn a_store_deeper_than_max_path_is_written_backed_up_and_reopened() {
    use crate::backup::{BackupOutcome, RealFreeSpace, create_verified_backup, load_valid_backup};
    use crate::{EngineStore, NoFaults, StorageError};
    use dohc_test_scratch::ScratchDir;

    let scratch = ScratchDir::new().unwrap();
    let folder = deep_folder(scratch.path(), 300);
    let path = folder.join("engine.db");
    let mut store = EngineStore::open(&path, 0).unwrap();
    store
        .write_with(&NoFaults, |tx| {
            tx.execute_batch("CREATE TABLE path_probe(n); INSERT INTO path_probe VALUES(42)")
                .map_err(StorageError::persist_public)
        })
        .unwrap();
    let recovery = folder.join("recovery");
    std::fs::create_dir(&recovery).unwrap();
    let outcome = create_verified_backup(
        &store,
        &recovery,
        "deep",
        "test",
        1,
        &RealFreeSpace,
        &NoFaults,
    )
    .unwrap();
    assert!(matches!(outcome, BackupOutcome::Verified(_)));
    assert!(load_valid_backup(&recovery, "deep").unwrap().is_some());
    drop(store);
    let reopened = EngineStore::open(&path, 1).unwrap();
    let value: i64 = reopened
        .read_with(|conn| {
            conn.query_row("SELECT n FROM path_probe", [], |row| row.get(0))
                .map_err(StorageError::persist_public)
        })
        .unwrap();
    assert_eq!(value, 42);
}
