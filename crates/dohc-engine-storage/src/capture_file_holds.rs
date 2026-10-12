//! Observations refused by capture. These rows confer no recorded-edit credit.
use crate::{EngineStore, StorageError};
use rusqlite::{Connection, OptionalExtension, Transaction, params};

pub const NOT_REPRESENTABLE: &str = "ydoc-resolution-not-representable";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CaptureFileHold {
    pub workspace_id: String,
    pub source_version_id: String,
    pub object_id: String,
    pub path: String,
    pub observed_sha256: String,
    pub observed_size: u64,
    pub reason: String,
    pub observed_at_ms: i64,
    pub attempt_count: i64,
    pub retry_requested: bool,
}

fn row(r: &rusqlite::Row<'_>) -> rusqlite::Result<CaptureFileHold> {
    Ok(CaptureFileHold {
        workspace_id: r.get(0)?,
        source_version_id: r.get(1)?,
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
        reason: r.get(6)?,
        observed_at_ms: r.get(7)?,
        attempt_count: r.get(8)?,
        retry_requested: r.get(9)?,
    })
}

const COLUMNS: &str = "workspace_id,source_version_id,object_id,path,observed_sha256,observed_size,reason,observed_at_ms,attempt_count,retry_requested";

pub fn hold_in(
    conn: &Connection,
    workspace: &str,
    path: &str,
) -> Result<Option<CaptureFileHold>, StorageError> {
    conn.query_row(
        &format!("SELECT {COLUMNS} FROM capture_file_holds WHERE workspace_id=?1 AND path=?2"),
        [workspace, path],
        row,
    )
    .optional()
    .map_err(StorageError::corrupt_public)
}

pub fn list_in(conn: &Connection, workspace: &str) -> Result<Vec<CaptureFileHold>, StorageError> {
    let mut q = conn
        .prepare(&format!(
            "SELECT {COLUMNS} FROM capture_file_holds WHERE workspace_id=?1 ORDER BY path"
        ))
        .map_err(StorageError::corrupt_public)?;
    q.query_map([workspace], row)
        .map_err(StorageError::corrupt_public)?
        .collect::<Result<_, _>>()
        .map_err(StorageError::corrupt_public)
}

/// Coordinates remain pinned even when a later observation requests another version.
pub fn record_in(tx: &Transaction<'_>, hold: &CaptureFileHold) -> Result<(), StorageError> {
    let size = i64::try_from(hold.observed_size).map_err(StorageError::persist_public)?;
    tx.execute("INSERT INTO capture_file_holds(workspace_id,source_version_id,object_id,path,observed_sha256,observed_size,reason,observed_at_ms,attempt_count,retry_requested) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,1,0) ON CONFLICT(workspace_id,path) DO UPDATE SET observed_sha256=excluded.observed_sha256,observed_size=excluded.observed_size,observed_at_ms=excluded.observed_at_ms,attempt_count=capture_file_holds.attempt_count+1,retry_requested=0", params![hold.workspace_id,hold.source_version_id,hold.object_id,hold.path,hold.observed_sha256,size,hold.reason,hold.observed_at_ms]).map_err(StorageError::persist_public)?;
    Ok(())
}

pub fn clear_in(tx: &Transaction<'_>, workspace: &str, path: &str) -> Result<(), StorageError> {
    tx.execute(
        "DELETE FROM capture_file_holds WHERE workspace_id=?1 AND path=?2",
        [workspace, path],
    )
    .map_err(StorageError::persist_public)?;
    Ok(())
}

pub fn request_retry_in(
    tx: &Transaction<'_>,
    workspace: &str,
    path: &str,
) -> Result<bool, StorageError> {
    tx.execute(
        "UPDATE capture_file_holds SET retry_requested=1 WHERE workspace_id=?1 AND path=?2",
        [workspace, path],
    )
    .map(|n| n > 0)
    .map_err(StorageError::persist_public)
}

impl EngineStore {
    /// Empty workspace is the legacy placement sentinel. It must also park.
    pub fn placement_is_held(&self, workspace: &str, path: &str) -> Result<bool, StorageError> {
        self.read_with(|conn| conn.query_row("SELECT EXISTS(SELECT 1 FROM capture_file_holds WHERE path=?2 AND (workspace_id=?1 OR ?1=''))", [workspace,path], |r| r.get(0)).map_err(StorageError::corrupt_public))
    }
}
