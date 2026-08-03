use dohc_engine_storage::{EngineStore, FaultInjector, TxnOutcome};
use rusqlite::{OptionalExtension, params};

use crate::SyncError;
use crate::model::bounded;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CursorKind {
    RelayFetch,
    SharedChannel,
    ShareView,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RelayCursor {
    pub cursor: i64,
    pub replication_epoch: String,
    pub stream_identity: String,
    /// Local-only ownership token for refusal rows surfaced with this pending
    /// cursor. Persisted relay positions never carry one.
    pub refusal_report_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SharedPeerPosition {
    pub applied_origin_seq: i64,
    pub dense_seq: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShareCursor {
    pub kind: CursorKind,
    pub share_id: String,
    pub cursor: i64,
}

pub fn read_relay_cursor(
    store: &EngineStore,
    workspace_id: &str,
) -> Result<Option<RelayCursor>, SyncError> {
    bounded(workspace_id, "workspace_id must be non-empty and bounded")?;
    store.read_with(|conn| {
        let value = conn
            .query_row(
            "SELECT cursor, replication_epoch, stream_identity FROM sync_relay_cursors WHERE workspace_id = ?1",
            [workspace_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )
        .optional()
        .map_err(SyncError::corrupt)?;
        value
            .map(|(cursor, replication_epoch, stream_identity)| {
                Ok(RelayCursor {
                    cursor: parse_relay_cursor(&cursor)?,
                    replication_epoch,
                    stream_identity,
                    refusal_report_id: None,
                })
            })
            .transpose()
    })
}

/// Returns whether this commit ORIGINATED owed Y.Doc lineages (the first
/// cursor sweep journaled bases). The caller must surface it as a pending
/// push: the origination lands AFTER the pass's push already ran, and
/// nothing else schedules one.
pub fn commit_relay_cursor(
    store: &mut EngineStore,
    workspace_id: &str,
    cursor: &RelayCursor,
    now_ms: i64,
    faults: &dyn FaultInjector,
) -> Result<TxnOutcome<bool>, SyncError> {
    bounded(workspace_id, "workspace_id must be non-empty and bounded")?;
    if !(0..=crate::MAX_WIRE_INTEGER).contains(&cursor.cursor) {
        return Err(SyncError::InvalidInput {
            reason: "cursor is outside the wire integer range",
        });
    }
    bounded(
        &cursor.replication_epoch,
        "replication_epoch must be non-empty and bounded",
    )?;
    bounded(
        &cursor.stream_identity,
        "stream_identity must be non-empty and bounded",
    )?;
    store
        .write_with(faults, |tx| {
            // The workspace's FIRST cursor commit ends the freshly-enrolled
            // KNOWN WINDOW (`workspace_replicates_with_relay_in_tx`): edits
            // made before any relay position exists decline to originate,
            // and nothing on the append path retries them (#548). Detect the
            // transition BEFORE the row lands and originate every owed
            // lineage in the SAME transaction, so a crash cannot separate
            // the position from the bases it makes possible. Push state can
            // land earlier in the same pass, but every enrolled workspace
            // reaches a first cursor commit, so hooking it alone closes the
            // window.
            let first_cursor =
                crate::ydoc_originate::is_first_relay_cursor_in_tx(tx, workspace_id)?;
            tx.execute(
                "INSERT INTO sync_relay_cursors (workspace_id,cursor,replication_epoch,stream_identity) \
                 VALUES (?1,?2,?3,?4) ON CONFLICT(workspace_id) DO UPDATE SET \
                 cursor=excluded.cursor,replication_epoch=excluded.replication_epoch,stream_identity=excluded.stream_identity \
                 WHERE sync_relay_cursors.replication_epoch != excluded.replication_epoch \
                    OR sync_relay_cursors.stream_identity != excluded.stream_identity \
                    OR CAST(sync_relay_cursors.cursor AS INTEGER) <= CAST(excluded.cursor AS INTEGER)",
                params![
                    workspace_id,
                    cursor.cursor.to_string(),
                    cursor.replication_epoch,
                    cursor.stream_identity
                ],
            )
            .map_err(SyncError::persist)?;
            // A committed cursor means the stream never replays coordinates
            // at or before this pull, so persisted pending-resolve decisions
            // kept for retry reconstruction are dead.
            tx.execute(
                "DELETE FROM replication_pending_resolves WHERE workspace_id=?1",
                params![workspace_id],
            )
            .map_err(SyncError::persist)?;
            // Refusals can also be created OUTSIDE a pull when open/resync/
            // close drains an already-ACKed Y.Doc coordinate. Delete only the
            // rows that this exact pull claimed and surfaced. A later drain is
            // unowned (report_id NULL), and a newer pull retags all pending
            // rows, so neither a delayed nor stale cursor commit can destroy
            // a refusal its caller never received.
            if let Some(report_id) = &cursor.refusal_report_id {
                tx.execute(
                    "DELETE FROM replication_pending_refusals \
                     WHERE workspace_id=?1 AND report_id=?2",
                    params![workspace_id, report_id],
                )
                .map_err(SyncError::persist)?;
            }
            let originated = if first_cursor {
                crate::ydoc_originate::originate_owed_ydoc_lineages_in_tx(
                    tx,
                    workspace_id,
                    now_ms,
                )?
            } else {
                0
            };
            Ok::<bool, SyncError>(originated > 0)
    })
}

fn parse_relay_cursor(value: &str) -> Result<i64, SyncError> {
    value
        .parse::<i64>()
        .ok()
        .filter(|cursor| (0..=crate::MAX_WIRE_INTEGER).contains(cursor))
        .ok_or(SyncError::InvalidInput {
            reason: "persisted relay cursor is invalid",
        })
}

pub fn read_pushed_seq(
    store: &EngineStore,
    workspace_id: &str,
    origin_id: &str,
) -> Result<i64, SyncError> {
    store.read_with(|conn| {
        conn.query_row(
            "SELECT pushed_seq FROM sync_relay_push_state WHERE workspace_id=?1 AND origin_id=?2",
            params![workspace_id, origin_id],
            |row| row.get(0),
        )
        .optional()
        .map(|value| value.unwrap_or(-1))
        .map_err(SyncError::corrupt)
    })
}

pub(crate) fn write_pushed_seq(
    store: &mut EngineStore,
    workspace_id: &str,
    origin_id: &str,
    pushed_seq: i64,
    faults: &dyn FaultInjector,
) -> Result<TxnOutcome<()>, SyncError> {
    if !(-1..=crate::MAX_WIRE_INTEGER).contains(&pushed_seq) {
        return Err(SyncError::InvalidInput {
            reason: "pushed_seq is outside the wire integer range",
        });
    }
    store
        .write_with(faults, |tx| {
            tx.execute(
                "INSERT INTO sync_relay_push_state (workspace_id,origin_id,pushed_seq) VALUES (?1,?2,?3) \
                 ON CONFLICT(workspace_id,origin_id) DO UPDATE SET pushed_seq=MAX(pushed_seq,excluded.pushed_seq)",
                params![workspace_id, origin_id, pushed_seq],
            )
            .map_err(SyncError::persist)?;
            Ok::<(), SyncError>(())
        })
}

pub(crate) fn rewind_pushed_seq(
    store: &mut EngineStore,
    workspace_id: &str,
    origin_id: &str,
    pushed_seq: i64,
    faults: &dyn FaultInjector,
) -> Result<TxnOutcome<()>, SyncError> {
    if !(-1..=crate::MAX_WIRE_INTEGER).contains(&pushed_seq) {
        return Err(SyncError::InvalidInput {
            reason: "pushed_seq is outside the wire integer range",
        });
    }
    store.write_with(faults, |tx| {
        tx.execute(
            "INSERT INTO sync_relay_push_state (workspace_id,origin_id,pushed_seq) VALUES (?1,?2,?3) \
             ON CONFLICT(workspace_id,origin_id) DO UPDATE SET pushed_seq=excluded.pushed_seq",
            params![workspace_id, origin_id, pushed_seq],
        )
        .map_err(SyncError::persist)?;
        Ok::<(), SyncError>(())
    })
}

pub fn read_shared_peer_position(
    store: &EngineStore,
    workspace_id: &str,
    share_id: &str,
    origin_id: &str,
) -> Result<SharedPeerPosition, SyncError> {
    store.read_with(|conn| {
        conn.query_row(
            "SELECT applied_origin_seq,dense_seq FROM shared_channel_peers \
             WHERE workspace_id=?1 AND share_id=?2 AND origin_id=?3",
            params![workspace_id, share_id, origin_id],
            |row| {
                Ok(SharedPeerPosition {
                    applied_origin_seq: row.get(0)?,
                    dense_seq: row.get(1)?,
                })
            },
        )
        .optional()
        .map(|value| {
            value.unwrap_or(SharedPeerPosition {
                applied_origin_seq: -1,
                dense_seq: -1,
            })
        })
        .map_err(SyncError::corrupt)
    })
}

pub fn read_share_cursor(
    store: &EngineStore,
    workspace_id: &str,
    share_id: &str,
    kind: CursorKind,
) -> Result<i64, SyncError> {
    bounded(workspace_id, "workspace_id must be non-empty and bounded")?;
    bounded(share_id, "share_id must be non-empty and bounded")?;
    let table = share_cursor_table(kind)?;
    store.read_with(|conn| {
        let sql = format!("SELECT cursor FROM {table} WHERE workspace_id=?1 AND share_id=?2");
        let value = conn
            .query_row(&sql, params![workspace_id, share_id], |row| {
                row.get::<_, String>(0)
            })
            .optional()
            .map_err(SyncError::corrupt)?;
        value.map_or(Ok(0), |cursor| parse_share_cursor(&cursor))
    })
}

pub fn commit_share_cursor(
    store: &mut EngineStore,
    workspace_id: &str,
    cursor: &ShareCursor,
    faults: &dyn FaultInjector,
) -> Result<TxnOutcome<()>, SyncError> {
    bounded(workspace_id, "workspace_id must be non-empty and bounded")?;
    bounded(&cursor.share_id, "share_id must be non-empty and bounded")?;
    if !(0..=crate::MAX_WIRE_INTEGER).contains(&cursor.cursor) {
        return Err(SyncError::InvalidInput {
            reason: "cursor is outside the wire integer range",
        });
    }
    let table = share_cursor_table(cursor.kind)?;
    store.write_with(faults, |tx| {
        let sql = format!(
            "INSERT INTO {table} (workspace_id,share_id,cursor) VALUES (?1,?2,?3) \
             ON CONFLICT(workspace_id,share_id) DO UPDATE SET cursor=excluded.cursor \
             WHERE CAST({table}.cursor AS INTEGER) <= CAST(excluded.cursor AS INTEGER)"
        );
        tx.execute(
            &sql,
            params![workspace_id, cursor.share_id, cursor.cursor.to_string()],
        )
        .map_err(SyncError::persist)?;
        Ok::<(), SyncError>(())
    })
}

fn share_cursor_table(kind: CursorKind) -> Result<&'static str, SyncError> {
    match kind {
        CursorKind::SharedChannel => Ok("shared_channel_cursors"),
        CursorKind::ShareView => Ok("share_view_cursors"),
        CursorKind::RelayFetch => Err(SyncError::InvalidInput {
            reason: "relay cursor cannot use a share cursor table",
        }),
    }
}

fn parse_share_cursor(value: &str) -> Result<i64, SyncError> {
    value
        .parse::<i64>()
        .ok()
        .filter(|cursor| (0..=crate::MAX_WIRE_INTEGER).contains(cursor))
        .ok_or(SyncError::InvalidInput {
            reason: "persisted share cursor is invalid",
        })
}

pub(crate) fn advance_shared_peer_tx(
    tx: &rusqlite::Transaction<'_>,
    workspace_id: &str,
    share_id: &str,
    origin_id: &str,
    source_seq: i64,
) -> Result<i64, SyncError> {
    let current: Option<SharedPeerPosition> = tx
        .query_row(
            "SELECT applied_origin_seq,dense_seq FROM shared_channel_peers \
             WHERE workspace_id=?1 AND share_id=?2 AND origin_id=?3",
            params![workspace_id, share_id, origin_id],
            |row| {
                Ok(SharedPeerPosition {
                    applied_origin_seq: row.get(0)?,
                    dense_seq: row.get(1)?,
                })
            },
        )
        .optional()
        .map_err(SyncError::corrupt)?;
    if let Some(position) = &current {
        if source_seq <= position.applied_origin_seq {
            return Ok(position.dense_seq);
        }
    } else if source_seq < 0 {
        return Err(SyncError::InvalidInput {
            reason: "shared source sequence is invalid",
        });
    }
    let dense = current
        .as_ref()
        .map_or(-1, |position| position.dense_seq)
        .checked_add(1)
        .ok_or(SyncError::CoordinateDiverged)?;
    tx.execute(
        "INSERT INTO shared_channel_peers (workspace_id,share_id,origin_id,applied_origin_seq,dense_seq) \
         VALUES (?1,?2,?3,?4,?5) ON CONFLICT(workspace_id,share_id,origin_id) DO UPDATE SET \
         applied_origin_seq=excluded.applied_origin_seq,dense_seq=excluded.dense_seq",
        params![workspace_id, share_id, origin_id, source_seq, dense],
    )
    .map_err(SyncError::persist)?;
    Ok(dense)
}
