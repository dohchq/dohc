//! The in-process crash/restart harness.
//!
//! A "crash" is simulated by arming a single-shot fault at a named storage
//! point, driving one compound write, and then **dropping the store** — the
//! Rust equivalent of the writer process dying with its connection closed.
//! "Restart" is a fresh [`EngineStore::open`] on the same path. Durability and
//! atomicity are proven by what the reopened store contains, never by trusting
//! the in-process outcome flag.

use crate::faults::ScriptedFaults;
use dohc_engine_storage::{CompoundWrite, EngineStore, FaultPoint, StorageError, WriteOutcome};
use rusqlite::Connection;
use std::path::Path;

/// Error type for the adversarial-fixture builders (they mix filesystem and
/// raw-SQLite failures; neither is a storage-domain error).
pub type FixtureResult = Result<(), Box<dyn std::error::Error + Send + Sync>>;

/// Open a store, arm a one-shot crash at `point`, run one compound `write`,
/// then drop the store (the simulated crash). Returns the observed outcome so
/// the caller can assert whether the crash landed before or after commit.
///
/// The store handle is released before this returns, so a subsequent
/// [`EngineStore::open`] on the same path is a clean restart.
pub fn crash_during_write(
    db_path: &Path,
    now_ms: i64,
    point: FaultPoint,
    write: &CompoundWrite,
) -> Result<WriteOutcome, StorageError> {
    let mut store = EngineStore::open(db_path, now_ms)?;
    let faults = ScriptedFaults::crash_at(point);
    let outcome = store.commit_compound(write, faults.as_ref())?;
    // Simulate process death: the writer connection is closed here.
    drop(store);
    Ok(outcome)
}

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

/// Convenience: build a compound write with distinct request/doc identifiers.
pub fn sample_write(request_id: &str, doc_id: &str, body: &str, now_ms: i64) -> CompoundWrite {
    CompoundWrite {
        request_id: request_id.to_owned(),
        doc_id: doc_id.to_owned(),
        body: body.to_owned(),
        op_kind: "text.write".to_owned(),
        now_ms,
    }
}
