use dohc_engine_storage::{EngineStore, FaultInjector, FaultPoint, TxnOutcome};
use rusqlite::{OptionalExtension, Transaction, params};

use crate::SyncError;
use crate::model::{MAX_PULL_OPS, ReplicationEnvelope, bounded};

fn relay_identity_component(value: &str, reason: &'static str) -> Result<(), SyncError> {
    bounded(value, reason)?;
    if value.trim() != value || value.starts_with('\u{feff}') || value.ends_with('\u{feff}') {
        return Err(SyncError::InvalidInput { reason });
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SyncIdentity {
    pub workspace_id: String,
    pub origin_id: String,
    pub replication_epoch: String,
    pub stream_identity: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AdoptJoinIdentityOutcome {
    Adopted,
    AlreadyMatched,
}

/// What [`record_share_view_identity`] did.
///
/// Two states, because this layer does two things: it writes the row or it
/// finds one. Whether a share view should be recorded at all is the LEVEL's
/// question, and the level is answered one layer up
/// (`RelayOperation::RecordShareViewIdentity`) — a function that is never
/// called cannot report a third state, and a variant it can never return is
/// one every reader has to be told to ignore.
///
/// Deliberately not called "enrolment": in this crate that word already means
/// the owner-lane backfill in `enrolment.rs`, and one name for one thing.
/// The three components of a replica identity, which always travel together.
///
/// Grouped because they are one fact in three fields, not three arguments a
/// caller chooses independently — and passing them separately made this
/// function's parameter list long enough that the shape was the warning.
#[derive(Debug, Clone, Copy)]
pub struct ShareViewIdentity<'a> {
    pub origin_id: &'a str,
    pub replication_epoch: &'a str,
    pub stream_identity: &'a str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShareViewIdentityOutcome {
    Recorded,
    AlreadyRecorded,
}

#[cfg(any(test, feature = "fault-injection"))]
pub(crate) fn crashes(faults: &dyn FaultInjector, point: FaultPoint) -> bool {
    faults.poll(point) == dohc_engine_storage::FaultAction::Crash
}

#[cfg(not(any(test, feature = "fault-injection")))]
pub(crate) fn crashes(_faults: &dyn FaultInjector, _point: FaultPoint) -> bool {
    false
}

/// Whether `workspace_id` actually replicates with a relay, read inside the
/// caller's transaction.
///
/// A `sync_identity` row does not answer this. `local_replication_coordinate`
/// (`dohc-engine-domain/src/chats.rs`) mints one with `INSERT OR IGNORE` from
/// `randomblob(16)` on every ordinary chat write, including the
/// `ensure_general_channel` bootstrap, so a workspace that has never seen a
/// relay still has an identity. Gating anything cloud-shaped on its existence
/// promotes private local documents.
///
/// A completed initial pull or a local-origin push answers it. A partial pull
/// can precede remote document bases, so its cursor and foreign-origin push
/// bookkeeping must not enroll competing local bases. Both lanes run behind
/// `relay-not-configured`, which the desktop satisfies only for a workspace
/// the user explicitly enabled cloud sync on
/// (`RegistryEntry.remote` plus matching credentials).
///
/// A SHARE lane is deliberately not read here. This predicate answers for the
/// OWNER lane, and for a share view the honest answer is no. The narrower
/// [`workspace_journals_file_moments_in_tx`] holds the share-lane term, and
/// only the file-moment journal reads it.
///
/// This is narrower than `adopt_join_identity`'s "pristine local replication
/// state" check, which must refuse on any prior replication activity. Do not
/// widen one to match the other. The identity is checked as well because
/// [`journal_local_op_in_tx`] refuses without one, and that refusal would roll
/// the user's edit back with it.
///
/// This reads past contact, not current enrolment. A freshly enrolled
/// workspace answers `false` until its first local push or drained pull commits.
/// The deferred drain, non-leased apply path, and enrolment backfill retry
/// origination after that. Nothing deletes a position row, so the answer stays
/// `true` after sign-out or unbind until the engine has a durable, revocable
/// record of enrolment.
pub fn workspace_replicates_with_relay_in_tx(
    tx: &rusqlite::Transaction<'_>,
    workspace_id: &str,
) -> Result<bool, SyncError> {
    tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM sync_identity WHERE workspace_id = ?1) \
           AND (EXISTS(SELECT 1 FROM sync_relay_cursors \
                       WHERE workspace_id = ?1 AND bootstrap_complete=1) \
             OR EXISTS(SELECT 1 FROM sync_relay_push_state p \
                       JOIN sync_identity i ON i.workspace_id=p.workspace_id AND i.origin_id=p.origin_id \
                       WHERE p.workspace_id = ?1))",
        [workspace_id],
        |row| row.get(0),
    )
    .map_err(SyncError::corrupt)
}

/// Whether `workspace_id` journals FILE MOMENTS for replication: the owner
/// relay lane, or an Edit share view's proposal lane.
///
/// Deliberately narrower than [`workspace_replicates_with_relay_in_tx`]. A
/// Edit can carry file moments through proposals and nothing else, so
/// the Y.Doc lanes, the conflict outbox and cursor advancement keep the
/// owner-lane answer. Journaling anything a proposal cannot carry would leave
/// rows in the recipient's database that nothing ever drains: a
/// `ydoc.update` there would accumulate forever.
///
/// The share-lane term is `share_view_file_lane`, and it is a fact rather
/// than a proxy: [`record_share_view_identity`] writes that row only for an
/// Edit grant, which is the only level whose file changes a share can drain.
/// View and Comment record neither an identity nor a lane row.
///
/// `EXISTS(sync_identity)` must never stand in for that. The doc on
/// [`workspace_replicates_with_relay_in_tx`] above says why, and it predicted
/// this exact mistake: an identity row alone cannot tell a share view that
/// may send file changes from one that may not. An earlier revision of this
/// function read it and would have journaled file moments for a read-only
/// share carrying an unrelated identity.
///
/// The identity a journal append needs still exists whenever this answers
/// true, because the lane row and the identity are written in one
/// transaction. That matters: `journal_local_payload_json_in_tx` Refuses
/// without an identity, and the refusal rolls the user's edit back with it.
pub fn workspace_journals_file_moments_in_tx(
    tx: &rusqlite::Transaction<'_>,
    workspace_id: &str,
) -> Result<bool, SyncError> {
    if workspace_replicates_with_relay_in_tx(tx, workspace_id)? {
        return Ok(true);
    }
    tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM share_view_file_lane WHERE workspace_id = ?1)",
        [workspace_id],
        |row| row.get(0),
    )
    .map_err(SyncError::corrupt)
}

/// Transaction-composable local journal append for callers that must commit
/// an op in the same transaction as a domain mutation (the live-session
/// `ydoc.update` delta: blob-before-log holds because the CRDT append stored
/// the blob earlier in this transaction). This requires an existing sync
/// identity. An exact replicated lineage cannot exist without one.
pub fn journal_local_op_in_tx(
    tx: &rusqlite::Transaction<'_>,
    workspace_id: &str,
    op_kind: &str,
    payload: &serde_json::Value,
    now_ms: i64,
) -> Result<i64, SyncError> {
    let payload_json = serde_json::to_string(payload).map_err(|_| SyncError::InvalidInput {
        reason: "payload is not valid JSON",
    })?;
    journal_local_payload_json_in_tx(tx, workspace_id, op_kind, &payload_json, now_ms)
}

/// Append an already serialized payload without changing its bytes.
///
/// Pending conflict bundles use this path because their canonical shadow
/// payloads must match the later top-level envelopes exactly.
pub(crate) fn journal_local_payload_json_in_tx(
    tx: &rusqlite::Transaction<'_>,
    workspace_id: &str,
    op_kind: &str,
    payload_json: &str,
    now_ms: i64,
) -> Result<i64, SyncError> {
    validate_local_payload_json(workspace_id, op_kind, payload_json)?;
    let origin_id: String = tx
        .query_row(
            "SELECT origin_id FROM sync_identity WHERE workspace_id = ?1",
            [workspace_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(SyncError::corrupt)?
        .ok_or(SyncError::InvalidInput {
            reason: "no sync identity for a replicated journal append",
        })?;
    let previous: i64 = tx
        .query_row(
            "SELECT COALESCE(MAX(origin_seq), -1) FROM replication_log              WHERE workspace_id = ?1 AND origin_id = ?2",
            params![workspace_id, origin_id],
            |row| row.get(0),
        )
        .map_err(SyncError::corrupt)?;
    if !(-1..crate::MAX_WIRE_INTEGER).contains(&previous) {
        return Err(SyncError::CoordinateDiverged);
    }
    let origin_seq = previous
        .checked_add(1)
        .ok_or(SyncError::CoordinateDiverged)?;
    tx.execute(
        "INSERT INTO replication_log          (workspace_id, origin_id, origin_seq, op_kind, payload_json, recorded_at_ms, imported)          VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0)",
        params![workspace_id, origin_id, origin_seq, op_kind, payload_json, now_ms],
    )
    .map_err(SyncError::persist)?;
    Ok(origin_seq)
}

pub(crate) fn validate_local_payload_json(
    workspace_id: &str,
    op_kind: &str,
    payload_json: &str,
) -> Result<(), SyncError> {
    bounded(workspace_id, "workspace_id must be non-empty and bounded")?;
    if op_kind.is_empty() || op_kind.len() > crate::model::MAX_OP_KIND_BYTES {
        return Err(SyncError::InvalidInput {
            reason: "op_kind must be non-empty and bounded",
        });
    }
    let payload = serde_json::from_str::<serde_json::Value>(payload_json).map_err(|_| {
        SyncError::InvalidInput {
            reason: "payload is not valid JSON",
        }
    })?;
    if !payload.is_object() {
        return Err(SyncError::InvalidInput {
            reason: "payload must be a JSON object",
        });
    }
    if payload_json.len() > crate::MAX_PAYLOAD_JSON_BYTES {
        return Err(SyncError::InvalidInput {
            reason: "payload exceeds the relay limit",
        });
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub fn journal_local_replication_op(
    store: &mut EngineStore,
    workspace_id: &str,
    origin_id: &str,
    replication_epoch: &str,
    stream_identity: &str,
    op_kind: &str,
    payload: &serde_json::Value,
    now_ms: i64,
    faults: &dyn FaultInjector,
) -> Result<TxnOutcome<i64>, SyncError> {
    bounded(workspace_id, "workspace_id must be non-empty and bounded")?;
    bounded(origin_id, "origin_id must be non-empty and bounded")?;
    bounded(
        replication_epoch,
        "replication_epoch must be non-empty and bounded",
    )?;
    bounded(
        stream_identity,
        "stream_identity must be non-empty and bounded",
    )?;
    if op_kind.is_empty() || op_kind.len() > crate::model::MAX_OP_KIND_BYTES {
        return Err(SyncError::InvalidInput {
            reason: "op_kind must be non-empty and bounded",
        });
    }
    let payload_json = serde_json::to_string(payload).map_err(|_| SyncError::InvalidInput {
        reason: "payload is not valid JSON",
    })?;
    if payload_json.len() > crate::MAX_PAYLOAD_JSON_BYTES {
        return Err(SyncError::InvalidInput {
            reason: "payload exceeds the relay limit",
        });
    }

    let outcome = store.write_with(faults, |tx| {
        tx.execute(
            "INSERT OR IGNORE INTO sync_identity \
             (workspace_id, origin_id, replication_epoch, stream_identity, created_at_ms) \
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![workspace_id, origin_id, replication_epoch, stream_identity, now_ms],
        )
        .map_err(SyncError::persist)?;
        let identity: (String, String, String) = tx
            .query_row(
                "SELECT origin_id, replication_epoch, stream_identity FROM sync_identity \
                 WHERE workspace_id = ?1",
                [workspace_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .map_err(SyncError::corrupt)?;
        if identity != (origin_id.to_owned(), replication_epoch.to_owned(), stream_identity.to_owned()) {
            return Err(SyncError::CoordinateDiverged);
        }
        let previous: i64 = tx
            .query_row(
                "SELECT COALESCE(MAX(origin_seq), -1) FROM replication_log \
                 WHERE workspace_id = ?1 AND origin_id = ?2",
                params![workspace_id, origin_id],
                |row| row.get(0),
            )
            .map_err(SyncError::corrupt)?;
        if !(-1..crate::MAX_WIRE_INTEGER).contains(&previous) {
            return Err(SyncError::CoordinateDiverged);
        }
        let origin_seq = previous.checked_add(1).ok_or(SyncError::CoordinateDiverged)?;
        tx.execute(
            "INSERT INTO replication_log \
             (workspace_id, origin_id, origin_seq, op_kind, payload_json, recorded_at_ms, imported) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0)",
            params![workspace_id, origin_id, origin_seq, op_kind, payload_json, now_ms],
        )
        .map_err(SyncError::persist)?;
        if crashes(faults, FaultPoint::SyncDuringJournalTxn) {
            return Err(SyncError::FaultCrash);
        }
        Ok::<i64, SyncError>(origin_seq)
    });
    match outcome {
        Err(SyncError::FaultCrash) => Ok(TxnOutcome::Crashed { committed: false }),
        other => other,
    }
}

pub fn read_sync_identity(
    store: &EngineStore,
    workspace_id: &str,
) -> Result<Option<SyncIdentity>, SyncError> {
    bounded(workspace_id, "workspace_id must be non-empty and bounded")?;
    store.read_with(|conn| {
        conn.query_row(
            "SELECT origin_id, replication_epoch, stream_identity FROM sync_identity \
             WHERE workspace_id = ?1",
            [workspace_id],
            |row| {
                Ok(SyncIdentity {
                    workspace_id: workspace_id.to_owned(),
                    origin_id: row.get(0)?,
                    replication_epoch: row.get(1)?,
                    stream_identity: row.get(2)?,
                })
            },
        )
        .optional()
        .map_err(SyncError::corrupt)
    })
}

/// Adopt the relay's existing workspace coordinate before a fresh join pulls.
/// An existing different local coordinate is never replaced. An absent
/// coordinate can be created only while every durable replication position is
/// pristine. The new origin is local to this machine; the epoch and stream
/// remain the relay's shared coordinate.
pub fn adopt_join_identity(
    store: &mut EngineStore,
    workspace_id: &str,
    new_origin_id: &str,
    replication_epoch: &str,
    stream_identity: &str,
    created_at_ms: i64,
    faults: &dyn FaultInjector,
) -> Result<TxnOutcome<AdoptJoinIdentityOutcome>, SyncError> {
    bounded(workspace_id, "workspace_id must be non-empty and bounded")?;
    relay_identity_component(
        new_origin_id,
        "origin_id must be 1-512 UTF-8 bytes, ECMAScript-trimmed, and contain no ASCII controls",
    )?;
    relay_identity_component(
        replication_epoch,
        "replication_epoch must be 1-512 UTF-8 bytes, ECMAScript-trimmed, and contain no ASCII controls",
    )?;
    relay_identity_component(
        stream_identity,
        "stream_identity must be 1-512 UTF-8 bytes, ECMAScript-trimmed, and contain no ASCII controls",
    )?;

    store.write_with(faults, |tx| {
        let current: Option<(String, String, String)> = tx
            .query_row(
                "SELECT origin_id, replication_epoch, stream_identity \
                 FROM sync_identity WHERE workspace_id = ?1",
                [workspace_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()
            .map_err(SyncError::corrupt)?;
        if let Some((_, epoch, stream)) = current {
            if epoch == replication_epoch && stream == stream_identity {
                return Ok(AdoptJoinIdentityOutcome::AlreadyMatched);
            }
            return Err(SyncError::InvalidInput {
                reason: "join identity adoption found a different local sync identity",
            });
        }

        let has_replication_state: i64 = tx
            .query_row(
                "SELECT \
                   EXISTS(SELECT 1 FROM replication_log WHERE workspace_id = ?1) OR \
                   EXISTS(SELECT 1 FROM replication_peers WHERE workspace_id = ?1) OR \
                   EXISTS(SELECT 1 FROM sync_relay_cursors WHERE workspace_id = ?1) OR \
                   EXISTS(SELECT 1 FROM sync_relay_push_state WHERE workspace_id = ?1) OR \
                   EXISTS(SELECT 1 FROM shared_channel_cursors WHERE workspace_id = ?1) OR \
                   EXISTS(SELECT 1 FROM shared_channel_peers WHERE workspace_id = ?1) OR \
                   EXISTS(SELECT 1 FROM shared_channel_push_state WHERE workspace_id = ?1) OR \
                   EXISTS(SELECT 1 FROM share_view_cursors WHERE workspace_id = ?1) OR \
                   EXISTS(SELECT 1 FROM chat_pending_replication WHERE workspace_id = ?1) OR \
                   EXISTS(SELECT 1 FROM replication_pending_conflict_bundles \
                     WHERE workspace_id = ?1) OR \
                   EXISTS(SELECT 1 FROM ydoc_deferred_updates WHERE workspace_id = ?1) OR \
                   EXISTS(SELECT 1 FROM ydoc_base_relay_candidates WHERE workspace_id = ?1) OR \
                   EXISTS(SELECT 1 FROM ydoc_recovery_decisions WHERE workspace_id = ?1)",
                [workspace_id],
                |row| row.get(0),
            )
            .map_err(SyncError::corrupt)?;
        if has_replication_state != 0 {
            return Err(SyncError::InvalidInput {
                reason: "join identity adoption requires pristine local replication state",
            });
        }

        tx.execute(
            "INSERT INTO sync_identity \
             (workspace_id, origin_id, replication_epoch, stream_identity, created_at_ms) \
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                workspace_id,
                new_origin_id,
                replication_epoch,
                stream_identity,
                created_at_ms
            ],
        )
        .map_err(SyncError::persist)?;
        Ok(AdoptJoinIdentityOutcome::Adopted)
    })
}

/// Record an editable share view's own replica identity and file-moment lane.
///
/// A share view replicates through a SHARE, not the owner lane, so it holds
/// `share_view_cursors` long before it holds an identity — which is exactly
/// the state [`adopt_join_identity`] refuses, and rightly: that primitive
/// adopts an OWNER's coordinate onto a pristine replica, and a share view is
/// neither pristine nor adopting anyone's coordinate. This is a different
/// thing, so it is a different function.
///
/// The origin is a REPLICA id local to this machine. The proposal lane uses
/// it to identify this replica's file moments. The epoch and stream are
/// owner-lane fields a share view never sends; they are stored because the
/// row requires them.
///
/// The caller has already applied the level gate: only Edit reaches this
/// function. Recording the identity and file lane together makes it
/// impossible to create the stale Comment-only identity shape this function
/// once supported for the removed received-chat push lane.
///
/// Idempotent by design — the caller runs it on every open and every refresh.
/// An existing identity wins, so a later call cannot re-mint an origin and
/// split this replica's log in two.
pub fn record_share_view_identity(
    store: &mut EngineStore,
    workspace_id: &str,
    identity: ShareViewIdentity<'_>,
    created_at_ms: i64,
    faults: &dyn FaultInjector,
) -> Result<TxnOutcome<ShareViewIdentityOutcome>, SyncError> {
    let ShareViewIdentity {
        origin_id,
        replication_epoch,
        stream_identity,
    } = identity;
    bounded(workspace_id, "workspace_id must be non-empty and bounded")?;
    relay_identity_component(
        origin_id,
        "origin_id must be 1-512 UTF-8 bytes, ECMAScript-trimmed, and contain no ASCII controls",
    )?;
    relay_identity_component(
        replication_epoch,
        "replication_epoch must be 1-512 UTF-8 bytes, ECMAScript-trimmed, and contain no ASCII controls",
    )?;
    relay_identity_component(
        stream_identity,
        "stream_identity must be 1-512 UTF-8 bytes, ECMAScript-trimmed, and contain no ASCII controls",
    )?;

    store.write_with(faults, |tx| {
        let recorded: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sync_identity WHERE workspace_id = ?1)",
                [workspace_id],
                |row| row.get(0),
            )
            .map_err(SyncError::corrupt)?;
        if !recorded {
            tx.execute(
                "INSERT INTO sync_identity \
                 (workspace_id, origin_id, replication_epoch, stream_identity, created_at_ms) \
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    workspace_id,
                    origin_id,
                    replication_epoch,
                    stream_identity,
                    created_at_ms
                ],
            )
            .map_err(SyncError::persist)?;
        }
        // The lane fact, in the same transaction as the identity, which is
        // what lets `workspace_journals_file_moments_in_tx` read this row
        // alone and still know an identity is there for the append.
        //
        // `INSERT OR IGNORE`, not a second existence probe: repeated refresh
        // must not fail, and an identity left by an interrupted older build
        // still gains the lane when Edit opens it.
        tx.execute(
            "INSERT OR IGNORE INTO share_view_file_lane \
             (workspace_id, recorded_at_ms) VALUES (?1, ?2)",
            params![workspace_id, created_at_ms],
        )
        .map_err(SyncError::persist)?;
        Ok(if recorded {
            ShareViewIdentityOutcome::AlreadyRecorded
        } else {
            ShareViewIdentityOutcome::Recorded
        })
    })
}

pub fn list_replication_ops(
    store: &EngineStore,
    workspace_id: &str,
    origin_id: &str,
    after_seq: i64,
    limit: usize,
) -> Result<Vec<ReplicationEnvelope>, SyncError> {
    bounded(workspace_id, "workspace_id must be non-empty and bounded")?;
    bounded(origin_id, "origin_id must be non-empty and bounded")?;
    if !(-1..=crate::MAX_WIRE_INTEGER).contains(&after_seq) || limit == 0 || limit > MAX_PULL_OPS {
        return Err(SyncError::InvalidInput {
            reason: "replication page bounds are invalid",
        });
    }
    let sql_limit = i64::try_from(limit).map_err(|_| SyncError::InvalidInput {
        reason: "replication page bounds are invalid",
    })?;
    store.read_with(|conn| {
        let mut stmt = conn
            .prepare(
                "SELECT origin_seq, op_kind, payload_json, recorded_at_ms FROM replication_log \
                 WHERE workspace_id = ?1 AND origin_id = ?2 AND origin_seq > ?3 \
                 ORDER BY origin_seq LIMIT ?4",
            )
            .map_err(SyncError::corrupt)?;
        let rows = stmt
            .query_map(
                params![workspace_id, origin_id, after_seq, sql_limit],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, i64>(3)?,
                    ))
                },
            )
            .map_err(SyncError::corrupt)?;
        let mut out = Vec::with_capacity(limit);
        for row in rows {
            let (origin_seq, op_kind, payload_json, recorded_at_ms) =
                row.map_err(SyncError::corrupt)?;
            let payload =
                serde_json::from_str(&payload_json).map_err(|_| SyncError::CoordinateDiverged)?;
            out.push(ReplicationEnvelope {
                workspace_id: workspace_id.to_owned(),
                origin_id: origin_id.to_owned(),
                origin_seq,
                relay_seq: None,
                op_kind,
                payload,
                recorded_at_ms,
            });
        }
        Ok(out)
    })
}

pub fn read_replication_acked_seq(
    store: &EngineStore,
    workspace_id: &str,
    origin_id: &str,
) -> Result<i64, SyncError> {
    store.read_with(|conn| read_ack_conn(conn, workspace_id, origin_id))
}

pub(crate) fn read_ack_tx(
    tx: &Transaction<'_>,
    workspace_id: &str,
    origin_id: &str,
) -> Result<i64, SyncError> {
    read_ack_conn(tx, workspace_id, origin_id)
}

fn read_ack_conn(
    conn: &rusqlite::Connection,
    workspace_id: &str,
    origin_id: &str,
) -> Result<i64, SyncError> {
    conn.query_row(
        "SELECT acked_seq FROM replication_peers WHERE workspace_id = ?1 AND origin_id = ?2",
        params![workspace_id, origin_id],
        |row| row.get(0),
    )
    .optional()
    .map(|value| value.unwrap_or(-1))
    .map_err(SyncError::corrupt)
}

pub(crate) fn ack_tx(
    tx: &Transaction<'_>,
    workspace_id: &str,
    origin_id: &str,
    origin_seq: i64,
) -> Result<(), SyncError> {
    if !(0..=crate::MAX_WIRE_INTEGER).contains(&origin_seq) {
        return Err(SyncError::InvalidInput {
            reason: "origin_seq is outside the wire integer range",
        });
    }
    tx.execute(
        "INSERT INTO replication_peers (workspace_id, origin_id, acked_seq) VALUES (?1, ?2, ?3) \
         ON CONFLICT(workspace_id, origin_id) DO UPDATE SET \
           acked_seq = MAX(acked_seq, excluded.acked_seq), \
           retry_origin_seq = CASE \
             WHEN retry_origin_seq <= excluded.acked_seq THEN NULL ELSE retry_origin_seq END, \
           retry_count = CASE \
             WHEN retry_origin_seq <= excluded.acked_seq THEN 0 ELSE retry_count END",
        params![workspace_id, origin_id, origin_seq],
    )
    .map_err(SyncError::persist)?;
    Ok(())
}
