//! A hosted replica: the session host's store for the documents the relay's
//! scoped feed serves it. The feed serves each hosted document's rows with
//! their original coordinates and withholds every other row, so one origin's
//! sequence reaches this store with gaps, and a document that joins the scope
//! backfills below coordinates already applied. Its journal is therefore the
//! ledger of what applied; the contiguous origin ack never moves.
//!
//! The `hosted_replicas` row selects this mode. Nothing infers it.

use rusqlite::{Connection, OptionalExtension};

use crate::SyncError;

/// The origin prefix the relay reserves for a service host's writes.
pub const SERVICE_HOST_ORIGIN_PREFIX: &str = "service-host:";

/// A conflict child whose `conflict.resolve` parent the feed withheld. The
/// child waits in deferred work until the relay serves what it needs.
pub(crate) const CONFLICT_PARENT_WITHHELD: &str = "hosted-conflict-parent-withheld";

pub(crate) fn is_hosted(conn: &Connection, workspace_id: &str) -> Result<bool, SyncError> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM hosted_replicas WHERE workspace_id=?1)",
        [workspace_id],
        |row| row.get(0),
    )
    .map_err(SyncError::corrupt)
}

/// The next sequence a hosted replica writes under its own origin, or `None`
/// for any other replica. The count lives in the replica's row because the
/// relay never forgets a coordinate, while this store's journal rows can go.
pub(crate) fn allocate_outbound_seq_in_tx(
    tx: &rusqlite::Transaction<'_>,
    workspace_id: &str,
) -> Result<Option<i64>, SyncError> {
    let last: Option<i64> = tx
        .query_row(
            "SELECT last_outbound_seq FROM hosted_replicas WHERE workspace_id=?1",
            [workspace_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(SyncError::corrupt)?;
    let Some(last) = last else { return Ok(None) };
    if !(-1..crate::MAX_WIRE_INTEGER).contains(&last) {
        return Err(SyncError::CoordinateDiverged);
    }
    let next = last + 1;
    tx.execute(
        "UPDATE hosted_replicas SET last_outbound_seq=?2 WHERE workspace_id=?1",
        rusqlite::params![workspace_id, next],
    )
    .map_err(SyncError::persist)?;
    Ok(Some(next))
}
