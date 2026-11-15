//! Folders whose access rule changed on disk and wait for their owner.
use crate::StorageError;
use rusqlite::{Connection, OptionalExtension, Transaction, params};

pub const WIDENED: &str = "widened";
pub const REMOVED: &str = "removed";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccessRuleHold {
    pub workspace_id: String,
    pub version_id: String,
    pub folder: String,
    /// [`WIDENED`] or [`REMOVED`].
    pub reason: String,
    /// The rule's bytes on disk when it was judged; `None` when it is gone.
    pub observed_sha256: Option<String>,
    pub recorded_at_ms: i64,
}

const COLUMNS: &str =
    "workspace_id,version_id,folder,reason,observed_sha256,recorded_at_ms FROM access_rule_holds";

fn row(r: &rusqlite::Row<'_>) -> rusqlite::Result<AccessRuleHold> {
    Ok(AccessRuleHold {
        workspace_id: r.get(0)?,
        version_id: r.get(1)?,
        folder: r.get(2)?,
        reason: r.get(3)?,
        observed_sha256: r.get(4)?,
        recorded_at_ms: r.get(5)?,
    })
}

pub fn hold_in(
    conn: &Connection,
    workspace: &str,
    version: &str,
    folder: &str,
) -> Result<Option<AccessRuleHold>, StorageError> {
    conn.prepare_cached(&format!(
        "SELECT {COLUMNS} WHERE workspace_id=?1 AND version_id=?2 AND folder=?3"
    ))
    .map_err(StorageError::corrupt_public)?
    .query_row(params![workspace, version, folder], row)
    .optional()
    .map_err(StorageError::corrupt_public)
}

pub fn list_in(conn: &Connection, workspace: &str) -> Result<Vec<AccessRuleHold>, StorageError> {
    let mut query = conn
        .prepare_cached(&format!(
            "SELECT {COLUMNS} WHERE workspace_id=?1 ORDER BY version_id, folder"
        ))
        .map_err(StorageError::corrupt_public)?;
    query
        .query_map([workspace], row)
        .map_err(StorageError::corrupt_public)?
        .collect::<Result<_, _>>()
        .map_err(StorageError::corrupt_public)
}

/// Record `hold`. True when the folder had no hold for this reason and these
/// bytes, so the owner has something new to hear about.
pub fn record_in(tx: &Transaction<'_>, hold: &AccessRuleHold) -> Result<bool, StorageError> {
    let previous = hold_in(tx, &hold.workspace_id, &hold.version_id, &hold.folder)?;
    if previous.as_ref().is_some_and(|previous| {
        previous.reason == hold.reason && previous.observed_sha256 == hold.observed_sha256
    }) {
        return Ok(false);
    }
    tx.execute(
        "INSERT INTO access_rule_holds(workspace_id,version_id,folder,reason,observed_sha256,recorded_at_ms) \
         VALUES (?1,?2,?3,?4,?5,?6) ON CONFLICT(workspace_id,version_id,folder) DO UPDATE SET \
         reason=excluded.reason,observed_sha256=excluded.observed_sha256,recorded_at_ms=excluded.recorded_at_ms",
        params![
            hold.workspace_id,
            hold.version_id,
            hold.folder,
            hold.reason,
            hold.observed_sha256,
            hold.recorded_at_ms
        ],
    )
    .map_err(StorageError::persist_public)?;
    Ok(true)
}

/// Remove the folder's hold. True when there was one.
pub fn clear_in(
    tx: &Transaction<'_>,
    workspace: &str,
    version: &str,
    folder: &str,
) -> Result<bool, StorageError> {
    tx.execute(
        "DELETE FROM access_rule_holds WHERE workspace_id=?1 AND version_id=?2 AND folder=?3",
        params![workspace, version, folder],
    )
    .map(|n| n > 0)
    .map_err(StorageError::persist_public)
}
