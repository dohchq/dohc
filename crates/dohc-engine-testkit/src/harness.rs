//! Adversarial database builders and WAL helpers for the crash tier. A crash
//! is simulated by arming a single-shot fault at a named storage point and then
//! dropping the store; "restart" is a fresh `EngineStore::open` on the same
//! path. Durability is proven by what the reopened store contains.

use rusqlite::Connection;
use std::path::Path;

/// Error type for the adversarial-fixture builders (they mix filesystem and
/// raw-SQLite failures; neither is a storage-domain error).
pub type FixtureResult = Result<(), Box<dyn std::error::Error + Send + Sync>>;

/// Materialize an adversarial database stamped with a foreign schema version
/// (default: the v1 TS fingerprint) and one table, so the fingerprint fence
/// has something concrete to reject. The file is fully closed on return.
pub fn write_fingerprint_db(db_path: &Path, schema_version: i64) -> FixtureResult {
    if let Some(parent) = db_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let conn = Connection::open(db_path)?;
    conn.execute_batch("CREATE TABLE legacy_marker (x INTEGER)")?;
    conn.pragma_update(None, "user_version", schema_version)?;
    // Explicit close so no handle lingers (Windows: an open handle blocks the
    // subsequent fence open).
    conn.close().map_err(|(_, err)| err)?;
    Ok(())
}

/// Materialize a version-0 database that already holds a user table — a
/// "foreign" store the initializer must refuse to write over.
pub fn write_foreign_unversioned_db(db_path: &Path) -> FixtureResult {
    if let Some(parent) = db_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let conn = Connection::open(db_path)?;
    conn.execute_batch("CREATE TABLE someone_elses_table (y TEXT)")?;
    // user_version stays 0.
    conn.close().map_err(|(_, err)| err)?;
    Ok(())
}

/// Open a read-only connection that keeps the WAL alive: while it is held, a
/// writer's close is NOT the last connection, so SQLite does not checkpoint on
/// that close. This lets a test read the WAL itself, or prove data is
/// recoverable *from* it, before a checkpoint folds it into the main file.
///
/// Opening alone is not enough — a connection that has never queried holds no
/// lock, and the close checkpoints anyway. So this also opens a read
/// transaction and takes a snapshot.
///
/// Call this AFTER the writer has committed: a read-only connection cannot
/// create the `-shm` file a WAL database needs, so it must find one already
/// there. Then drop the writer while this is held.
pub fn open_readonly_keeper(db_path: &Path) -> rusqlite::Result<Connection> {
    let conn = Connection::open_with_flags(db_path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    conn.execute_batch("BEGIN")?;
    // Any read will do; `sqlite_schema` exists in every database.
    let _snapshot: i64 =
        conn.query_row("SELECT count(*) FROM sqlite_schema", [], |row| row.get(0))?;
    Ok(conn)
}

/// The `-wal` sidecar path for a database file.
pub fn wal_sidecar(db_path: &Path) -> std::path::PathBuf {
    sidecar(db_path, "-wal")
}

/// The `-shm` sidecar path for a database file.
pub fn shm_sidecar(db_path: &Path) -> std::path::PathBuf {
    sidecar(db_path, "-shm")
}

fn sidecar(db_path: &Path, suffix: &str) -> std::path::PathBuf {
    let mut os = db_path.as_os_str().to_owned();
    os.push(suffix);
    std::path::PathBuf::from(os)
}
