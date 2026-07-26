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
    pub cursor: String,
    pub replication_epoch: String,
    pub stream_identity: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SharedPeerPosition {
    pub applied_origin_seq: i64,
    pub dense_seq: i64,
}

pub fn read_relay_cursor(
    store: &EngineStore,
    workspace_id: &str,
) -> Result<Option<RelayCursor>, SyncError> {
    bounded(workspace_id, "workspace_id must be non-empty and bounded")?;
    store.read_with(|conn| {
        conn.query_row(
            "SELECT cursor, replication_epoch, stream_identity FROM sync_relay_cursors WHERE workspace_id = ?1",
            [workspace_id],
            |row| {
                Ok(RelayCursor {
                    cursor: row.get(0)?,
                    replication_epoch: row.get(1)?,
                    stream_identity: row.get(2)?,
                })
            },
        )
        .optional()
        .map_err(SyncError::corrupt)
    })
}

pub fn commit_relay_cursor(
    store: &mut EngineStore,
    workspace_id: &str,
    cursor: &RelayCursor,
    faults: &dyn FaultInjector,
) -> Result<TxnOutcome<()>, SyncError> {
    bounded(workspace_id, "workspace_id must be non-empty and bounded")?;
    bounded(&cursor.cursor, "cursor must be non-empty and bounded")?;
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
            tx.execute(
                "INSERT INTO sync_relay_cursors (workspace_id,cursor,replication_epoch,stream_identity) \
                 VALUES (?1,?2,?3,?4) ON CONFLICT(workspace_id) DO UPDATE SET \
                 cursor=excluded.cursor,replication_epoch=excluded.replication_epoch,stream_identity=excluded.stream_identity",
                params![workspace_id, cursor.cursor, cursor.replication_epoch, cursor.stream_identity],
            )
            .map_err(SyncError::persist)?;
            // A committed cursor means the stream never replays coordinates
            // at or before this pull, so the persisted pending-resolve
            // decisions kept for retry reconstruction are dead. Workspace
            // pulls serialize through the engine actor, so a per-workspace
            // sweep is exact; without it every deferred resolve leaves a row
            // forever.
            tx.execute(
                "DELETE FROM replication_pending_resolves WHERE workspace_id=?1",
                params![workspace_id],
            )
            .map_err(SyncError::persist)?;
            Ok::<(), SyncError>(())
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
    if !(0..=crate::MAX_WIRE_INTEGER).contains(&pushed_seq) {
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
    let max_dense: i64 = tx
        .query_row(
            "SELECT COALESCE(MAX(dense_seq),-1) FROM shared_channel_peers WHERE workspace_id=?1 AND share_id=?2",
            params![workspace_id, share_id],
            |row| row.get(0),
        )
        .map_err(SyncError::corrupt)?;
    let dense = max_dense
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
