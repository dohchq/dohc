use crate::StorageError;
use rusqlite::{Connection, OptionalExtension, params};

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ReplicaFrontiers {
    pub revision: i64,
    pub log_cursor: i64,
    pub journal_cursor: i64,
}

pub fn read_frontiers(
    conn: &Connection,
    workspace: &str,
) -> Result<ReplicaFrontiers, StorageError> {
    conn.query_row(
        "SELECT revision,log_cursor,journal_cursor FROM replica_frontiers WHERE workspace_id=?1",
        [workspace],
        |r| {
            Ok(ReplicaFrontiers {
                revision: r.get(0)?,
                log_cursor: r.get(1)?,
                journal_cursor: r.get(2)?,
            })
        },
    )
    .optional()
    .map_err(StorageError::corrupt_public)
    .map(Option::unwrap_or_default)
}

pub fn advance_frontiers(
    conn: &Connection,
    workspace: &str,
    log: i64,
    journal: i64,
) -> Result<(), StorageError> {
    conn.execute("INSERT INTO replica_frontiers(workspace_id,revision,log_cursor,journal_cursor) VALUES (?1,1,?2,?3)
        ON CONFLICT(workspace_id) DO UPDATE SET revision=replica_frontiers.revision+1,
        log_cursor=MAX(replica_frontiers.log_cursor,excluded.log_cursor),
        journal_cursor=MAX(replica_frontiers.journal_cursor,excluded.journal_cursor)
        WHERE excluded.log_cursor>replica_frontiers.log_cursor OR excluded.journal_cursor>replica_frontiers.journal_cursor",
        params![workspace,log,journal]).map_err(StorageError::persist_public)?;
    Ok(())
}
