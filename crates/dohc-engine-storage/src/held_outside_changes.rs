//! Files that changed outside dohc while their note was live. A row confers
//! no recorded-edit credit: its bytes are in neither the note nor History.
use crate::StorageError;
use rusqlite::{Connection, OptionalExtension, Transaction, params};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HeldOutsideChange {
    pub workspace_id: String,
    pub version_id: String,
    pub object_id: String,
    pub path: String,
    pub observed_sha256: String,
    pub observed_size: u64,
    pub first_observed_at_ms: i64,
    pub observed_at_ms: i64,
}

const COLUMNS: &str = "workspace_id,version_id,object_id,path,observed_sha256,observed_size,first_observed_at_ms,observed_at_ms";

fn row(r: &rusqlite::Row<'_>) -> rusqlite::Result<HeldOutsideChange> {
    Ok(HeldOutsideChange {
        workspace_id: r.get(0)?,
        version_id: r.get(1)?,
        object_id: r.get(2)?,
        path: r.get(3)?,
        observed_sha256: r.get(4)?,
        observed_size: u64::try_from(r.get::<_, i64>(5)?).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                5,
                rusqlite::types::Type::Integer,
                Box::new(error),
            )
        })?,
        first_observed_at_ms: r.get(6)?,
        observed_at_ms: r.get(7)?,
    })
}

pub fn hold_in(
    conn: &Connection,
    workspace: &str,
    path: &str,
) -> Result<Option<HeldOutsideChange>, StorageError> {
    conn.prepare_cached(&format!(
        "SELECT {COLUMNS} FROM held_outside_changes WHERE workspace_id=?1 AND path=?2"
    ))
    .map_err(StorageError::corrupt_public)?
    .query_row([workspace, path], row)
    .optional()
    .map_err(StorageError::corrupt_public)
}

pub fn list_in(conn: &Connection, workspace: &str) -> Result<Vec<HeldOutsideChange>, StorageError> {
    conn.prepare_cached(&format!(
        "SELECT {COLUMNS} FROM held_outside_changes WHERE workspace_id=?1 ORDER BY path"
    ))
    .map_err(StorageError::corrupt_public)?
    .query_map([workspace], row)
    .map_err(StorageError::corrupt_public)?
    .collect::<Result<_, _>>()
    .map_err(StorageError::corrupt_public)
}

/// A newer observation of the same path replaces the bytes and keeps the
/// time the hold began.
pub fn record_in(tx: &Transaction<'_>, hold: &HeldOutsideChange) -> Result<(), StorageError> {
    let size = i64::try_from(hold.observed_size).map_err(StorageError::persist_public)?;
    tx.prepare_cached(&format!(
        "INSERT INTO held_outside_changes({COLUMNS}) VALUES (?1,?2,?3,?4,?5,?6,?7,?8) \
         ON CONFLICT(workspace_id,path) DO UPDATE SET version_id=excluded.version_id,\
         object_id=excluded.object_id,observed_sha256=excluded.observed_sha256,\
         observed_size=excluded.observed_size,observed_at_ms=excluded.observed_at_ms"
    ))
    .map_err(StorageError::persist_public)?
    .execute(params![
        hold.workspace_id,
        hold.version_id,
        hold.object_id,
        hold.path,
        hold.observed_sha256,
        size,
        hold.first_observed_at_ms,
        hold.observed_at_ms
    ])
    .map_err(StorageError::persist_public)?;
    Ok(())
}

/// Whether a hold for `path` ended.
pub fn clear_in(tx: &Transaction<'_>, workspace: &str, path: &str) -> Result<bool, StorageError> {
    tx.prepare_cached("DELETE FROM held_outside_changes WHERE workspace_id=?1 AND path=?2")
        .map_err(StorageError::persist_public)?
        .execute([workspace, path])
        .map(|deleted| deleted > 0)
        .map_err(StorageError::persist_public)
}
