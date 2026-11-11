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
