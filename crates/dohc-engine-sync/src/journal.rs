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
/// A `sync_identity` row does NOT answer this. `local_replication_coordinate`
/// (`dohc-engine-domain/src/chats.rs`) mints one with `INSERT OR IGNORE` from
/// `randomblob(16)` on every ordinary chat write, including the
/// `ensure_general_channel` bootstrap, so a workspace that has never seen a
/// relay still has an identity. Gating anything cloud-shaped on its existence
/// promotes private local documents.
///
/// A durable relay position does answer it. `sync_relay_cursors` advances only
/// when a pull cursor commits and `sync_relay_push_state` only when a push
/// succeeds; both run behind `relay-not-configured`, which the desktop
/// satisfies only for a workspace the user explicitly enabled cloud sync on
/// (`RegistryEntry.remote` plus matching credentials).
///
/// These two tables are a SUBSET of what `adopt_join_identity` below calls
/// pristine local replication state. That check is deliberately wider — it also
/// rejects `replication_log`, `replication_peers`, the `shared_channel_*`
/// tables, `share_view_cursors`, `chat_pending_replication` and
/// `ydoc_deferred_updates`, because adoption must refuse on ANY prior
/// replication activity. This predicate wants the narrower question: has THIS
/// workspace exchanged data with a relay. Do not widen one to match the other.
///
/// The identity is checked as well, because Y.Doc base origination consults
/// this BEFORE it claims a base: [`journal_local_op_in_tx`] refuses without an
/// identity, and a refusal raised inside the append transaction would roll the
/// user's edit back with it.
///
/// No `bounded` guard, unlike its neighbours here. Every caller passes a
/// `DocKey`'s `workspace_id`, which `DocKey::new` already bounds by
/// `MAX_IDENTIFIER_BYTES`. Re-checking it would add a rejection path that runs
/// inside an append transaction and can only fire on input the type forbids.
///
/// KNOWN WINDOW, and a known LATCH. This reads past contact, not current
/// enrolment.
///
/// The window: a freshly enrolled workspace answers `false` until its first
/// push or pull commits, so an edit inside that window does not originate.
/// The deferred drain, non-leased apply path, and enrolment backfill now retry
/// the origination (#548). Before that retrigger, the window cost at most one
/// edit: the next append asked again, the base carried the complete state, and
/// a local-only close refused until the Markdown artifact was durable
/// (`close_session` raises `UnsettledClose`), so reopening seeded from that
/// Markdown and originated then.
///
/// The latch: nothing deletes a position row, so this keeps answering `true`
/// after the user signs out or unbinds the workspace. #558 owns that. Both come
/// from the same root — the engine has no durable, revocable record of current
/// enrolment — and one such record replaces this predicate and closes both.
pub fn workspace_replicates_with_relay_in_tx(
    tx: &rusqlite::Transaction<'_>,
    workspace_id: &str,
) -> Result<bool, SyncError> {
    tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM sync_identity WHERE workspace_id = ?1) \
           AND (EXISTS(SELECT 1 FROM sync_relay_cursors WHERE workspace_id = ?1) \
             OR EXISTS(SELECT 1 FROM sync_relay_push_state WHERE workspace_id = ?1))",
        [workspace_id],
        |row| row.get(0),
    )
    .map_err(SyncError::corrupt)
}

/// Transaction-composable local journal append for callers that must commit
/// an op in the SAME transaction as a domain mutation (the live-session
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
                   EXISTS(SELECT 1 FROM ydoc_deferred_updates WHERE workspace_id = ?1)",
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

pub fn ack_replication_peer(
    store: &mut EngineStore,
    workspace_id: &str,
    origin_id: &str,
    origin_seq: i64,
    faults: &dyn FaultInjector,
) -> Result<TxnOutcome<i64>, SyncError> {
    let outcome = store.write_with(faults, |tx| {
        ack_tx(tx, workspace_id, origin_id, origin_seq)?;
        Ok::<i64, SyncError>(origin_seq)
    })?;
    Ok(outcome)
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
