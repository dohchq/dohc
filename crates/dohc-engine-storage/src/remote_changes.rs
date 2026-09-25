//! How many changes that did not originate on this computer the engine has
//! applied to each workspace. A caller records the count with a decision
//! and reads it again later: an unchanged count proves nobody else's change
//! arrived in between. The share roster uses it to tell whether a new
//! editor's change could have arrived since its last listing of grants.
//!
//! Each apply path counts in the transaction that commits the change, at the
//! point where it knows the change is new, so a replay or a redelivery never
//! counts twice and a crash never loses a count. The count only grows, except
//! that restoring a backup replaces it with the backup's: compare for
//! equality, never for order.

use crate::error::StorageError;
use rusqlite::{Connection, OptionalExtension, params};

/// Count one applied change that did not originate on this computer.
pub fn count_remote_change_in_tx(
    conn: &Connection,
    workspace_id: &str,
) -> Result<(), StorageError> {
    conn.execute(
        "INSERT INTO remote_changes (workspace_id, applied) VALUES (?1, 1) \
         ON CONFLICT(workspace_id) DO UPDATE SET applied = applied + 1",
        params![workspace_id],
    )
    .map_err(StorageError::persist_public)?;
    Ok(())
}

/// How many changes that did not originate on this computer the engine has
/// applied to the workspace; 0 before the first.
pub fn remote_changes_applied_in(
    conn: &Connection,
    workspace_id: &str,
) -> Result<i64, StorageError> {
    Ok(conn
        .query_row(
            "SELECT applied FROM remote_changes WHERE workspace_id = ?1",
            params![workspace_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(StorageError::corrupt_public)?
        .unwrap_or(0))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{EngineStore, NoFaults};

    #[test]
    fn the_count_grows_per_workspace_and_survives_reopening() {
        let dir = dohc_test_scratch::ScratchDir::new_named("remote-changes").expect("scratch");
        let path = dir.join("engine.db");
        {
            let mut store = EngineStore::open(&path, 1).expect("open");
            for workspace_id in ["ws-a", "ws-a", "ws-b"] {
                store
                    .write_with(&NoFaults, |tx| count_remote_change_in_tx(tx, workspace_id))
                    .expect("count");
            }
        }
        let store = EngineStore::open(&path, 2).expect("reopen");
        let read = |workspace_id| {
            store
                .read_with(|conn| remote_changes_applied_in(conn, workspace_id))
                .expect("read")
        };
        assert_eq!((read("ws-a"), read("ws-b"), read("ws-c")), (2, 1, 0));
    }
}
