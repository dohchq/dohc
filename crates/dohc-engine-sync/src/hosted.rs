//! A hosted replica: the session host's store for the documents the relay's
//! scoped feed serves it. The feed serves each hosted document's rows with
//! their original coordinates and withholds every other row, so one origin's
//! sequence reaches this store with gaps, and a document that joins the scope
//! backfills below coordinates already applied. Its journal is therefore the
//! ledger of what applied; the contiguous origin ack never moves.
//!
//! The `hosted_replicas` row selects this mode. Nothing infers it.
//!
//! Its fetch position lives here too, never in `sync_relay_cursors`: one main
//! cursor, frozen while any document backfills, and one backfill cursor per
//! document. A document is in scope while its row carries the replica's scope
//! generation; one that left keeps its state for removal.

use std::collections::{BTreeMap, BTreeSet};

use dohc_engine_storage::{EngineStore, FaultInjector, TxnOutcome};
use rusqlite::{Connection, OptionalExtension, params};

use crate::{ReplicationEnvelope, SyncError};

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

/// The hosted document an op names, read where each kind states it, as the
/// relay's scoped feed reads it. `None` for an op that names no document.
pub(crate) fn hosted_document(op: &ReplicationEnvelope) -> Option<&str> {
    let payload = &op.payload;
    match op.op_kind.as_str() {
        "moment.append" | "ydoc.update" | "live.audit.application" => &payload["objectId"],
        "live.audit.settlement" => &payload["record"]["binding"]["objectId"],
        "live.audit.base" => &payload["record"]["checkpoint"]["binding"]["objectId"],
        _ => return None,
    }
    .as_str()
}

/// What a hosted replica knows of its scope and position.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostedReplicaState {
    /// `None` until the first scoped response.
    pub scope_token: Option<String>,
    pub scope_generation: i64,
    pub main_cursor: i64,
    /// The documents in the current scope, by object id.
    pub documents: BTreeMap<String, HostedDocumentState>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HostedDocumentState {
    /// Its backfill completed and committed.
    pub ready: bool,
    pub backfill_cursor: i64,
}

/// The replica's state, or `None` for a workspace that is not hosted.
pub fn read_hosted_replica(
    store: &EngineStore,
    workspace_id: &str,
) -> Result<Option<HostedReplicaState>, SyncError> {
    store.read_with(|conn| {
        let replica = conn
            .query_row(
                "SELECT scope_token,scope_generation,main_cursor FROM hosted_replicas \
                 WHERE workspace_id=?1",
                [workspace_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()
            .map_err(SyncError::corrupt)?;
        let Some((scope_token, scope_generation, main_cursor)) = replica else {
            return Ok(None);
        };
        let mut statement = conn
            .prepare(
                "SELECT object_id,state,backfill_cursor FROM hosted_documents \
                 WHERE workspace_id=?1 AND scope_generation=?2",
            )
            .map_err(SyncError::corrupt)?;
        let documents = statement
            .query_map(params![workspace_id, scope_generation], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    HostedDocumentState {
                        ready: row.get::<_, String>(1)? == "ready",
                        backfill_cursor: row.get(2)?,
                    },
                ))
            })
            .map_err(SyncError::corrupt)?
            .collect::<Result<_, _>>()
            .map_err(SyncError::corrupt)?;
        Ok(Some(HostedReplicaState {
            scope_token,
            scope_generation,
            main_cursor,
            documents,
        }))
    })
}

/// Adopt the scope a response announced. Its generation moves, so no pass
/// fetched under the old scope can commit. A document still in scope keeps
/// its progress; one that joins, or returns after leaving, backfills from the
/// start, because the feed withheld its rows while it was out.
pub(crate) fn adopt_scope(
    store: &mut EngineStore,
    workspace_id: &str,
    token: &str,
    objects: &BTreeSet<String>,
    faults: &dyn FaultInjector,
) -> Result<TxnOutcome<()>, SyncError> {
    store.write_with(faults, |tx| {
        let previous: i64 = tx
            .query_row(
                "SELECT scope_generation FROM hosted_replicas WHERE workspace_id=?1",
                [workspace_id],
                |row| row.get(0),
            )
            .map_err(SyncError::corrupt)?;
        let generation = previous
            .checked_add(1)
            .ok_or(SyncError::CoordinateDiverged)?;
        tx.execute(
            "UPDATE hosted_replicas SET scope_token=?2,scope_generation=?3 WHERE workspace_id=?1",
            params![workspace_id, token, generation],
        )
        .map_err(SyncError::persist)?;
        for object_id in objects {
            tx.execute(
                "INSERT INTO hosted_documents \
                 (workspace_id,object_id,state,backfill_cursor,scope_generation) \
                 VALUES (?1,?2,'backfilling',0,?4) \
                 ON CONFLICT(workspace_id,object_id) DO UPDATE SET \
                 state=CASE WHEN scope_generation=?3 THEN state ELSE 'backfilling' END, \
                 backfill_cursor=CASE WHEN scope_generation=?3 THEN backfill_cursor ELSE 0 END, \
                 scope_generation=excluded.scope_generation",
                params![workspace_id, object_id, previous, generation],
            )
            .map_err(SyncError::persist)?;
        }
        Ok(())
    })
}

/// A hosted pass's position, committed only after its work materializes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostedCursor {
    /// The scope generation the pass fetched under.
    pub scope_generation: i64,
    /// The document a backfill pass read, or `None` for the main feed.
    pub backfill_object_id: Option<String>,
    pub cursor: i64,
    /// The backfill read reached the end of its document's rows.
    pub backfill_complete: bool,
    /// Local-only ownership token for applied settlements and deferred relay work.
    pub settlement_report_id: Option<String>,
}

/// Commit a hosted pass's position. Answers `false`, committing nothing, when
/// the scope moved since the pass fetched: its page may hold rows the current
/// scope withholds. A backfill that completed marks its document ready in the
/// same transaction, so readiness never precedes its content.
pub fn commit_hosted_cursor(
    store: &mut EngineStore,
    workspace_id: &str,
    cursor: &HostedCursor,
    faults: &dyn FaultInjector,
) -> Result<TxnOutcome<bool>, SyncError> {
    crate::model::bounded(workspace_id, "workspace_id must be non-empty and bounded")?;
    if !(0..=crate::MAX_WIRE_INTEGER).contains(&cursor.cursor) {
        return Err(SyncError::InvalidInput {
            reason: "cursor is outside the wire integer range",
        });
    }
    store.write_with(faults, |tx| {
        let generation: Option<i64> = tx
            .query_row(
                "SELECT scope_generation FROM hosted_replicas WHERE workspace_id=?1",
                [workspace_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(SyncError::corrupt)?;
        let generation = generation.ok_or(SyncError::InvalidInput {
            reason: "workspace is not a hosted replica",
        })?;
        if generation != cursor.scope_generation {
            return Ok(false);
        }
        let moved = match &cursor.backfill_object_id {
            // The main cursor stays frozen while any document backfills.
            None => tx.execute(
                "UPDATE hosted_replicas SET main_cursor=MAX(main_cursor,?2) \
                 WHERE workspace_id=?1 AND NOT EXISTS(SELECT 1 FROM hosted_documents d \
                   WHERE d.workspace_id=?1 AND d.scope_generation=?3 AND d.state='backfilling')",
                params![workspace_id, cursor.cursor, generation],
            ),
            Some(object_id) => tx.execute(
                "UPDATE hosted_documents SET backfill_cursor=MAX(backfill_cursor,?3), \
                 state=CASE WHEN ?4 THEN 'ready' ELSE state END \
                 WHERE workspace_id=?1 AND object_id=?2 AND scope_generation=?5 \
                   AND state='backfilling'",
                params![
                    workspace_id,
                    object_id,
                    cursor.cursor,
                    cursor.backfill_complete,
                    generation
                ],
            ),
        }
        .map_err(SyncError::persist)?;
        if moved != 1 {
            return Ok(false);
        }
        if let Some(report_id) = &cursor.settlement_report_id {
            crate::cursor::release_settlement_report_in_tx(tx, workspace_id, report_id)?;
        }
        Ok(true)
    })
}
