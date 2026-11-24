use super::*;

pub fn require_open(conn: &Connection, key: &DocKey) -> Result<(), CollabError> {
    let stopped: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM live_restore_fences WHERE workspace_id=?1 AND main_version_id=?2 AND object_id=?3)",
        params![key.workspace_id, key.version_id, key.object_id], |r| r.get(0),
    ).map_err(|e| CollabError::Storage(StorageError::corrupt_public(e)))?;
    if stopped {
        Err(CollabError::RestoreFenced)
    } else {
        Ok(())
    }
}

pub fn current_generation(conn: &Connection, key: &DocKey) -> Result<Option<i64>, CollabError> {
    require_open(conn, key)?;
    Ok(None)
}

pub fn require_generation(
    conn: &Connection,
    key: &DocKey,
    expected: Option<i64>,
) -> Result<(), CollabError> {
    require_open(conn, key)?;
    if expected.is_none() {
        Ok(())
    } else {
        Err(CollabError::RestoreFenced)
    }
}
