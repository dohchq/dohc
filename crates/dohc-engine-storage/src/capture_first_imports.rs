//! A workspace's first import, from its first capture pass until no file it
//! found is left to record. No row means no import is running.
use crate::StorageError;
use rusqlite::{Connection, OptionalExtension, Transaction};

/// Continue `workspace`'s unfinished import, or start one under
/// `correlation_id`. Returns the import's correlation id.
pub fn begin_in(
    tx: &Transaction<'_>,
    workspace: &str,
    correlation_id: &str,
) -> Result<String, StorageError> {
    tx.execute(
        "INSERT INTO capture_first_imports(workspace_id,correlation_id,finished) VALUES (?1,?2,0) \
         ON CONFLICT(workspace_id) DO UPDATE SET correlation_id=excluded.correlation_id,finished=0 \
         WHERE finished=1",
        [workspace, correlation_id],
    )
    .map_err(StorageError::persist_public)?;
    tx.query_row(
        "SELECT correlation_id FROM capture_first_imports WHERE workspace_id=?1",
        [workspace],
        |row| row.get(0),
    )
    .map_err(StorageError::corrupt_public)
}

/// The correlation id of `workspace`'s unfinished import.
pub fn unfinished_in(conn: &Connection, workspace: &str) -> Result<Option<String>, StorageError> {
    conn.prepare_cached(
        "SELECT correlation_id FROM capture_first_imports WHERE workspace_id=?1 AND finished=0",
    )
    .map_err(StorageError::corrupt_public)?
    .query_row([workspace], |row| row.get(0))
    .optional()
    .map_err(StorageError::corrupt_public)
}

pub fn finish_in(tx: &Transaction<'_>, workspace: &str) -> Result<(), StorageError> {
    tx.execute(
        "UPDATE capture_first_imports SET finished=1 WHERE workspace_id=?1",
        [workspace],
    )
    .map_err(StorageError::persist_public)?;
    Ok(())
}
