use dohc_engine_storage::{EngineStore, FaultInjector, TxnOutcome};
use rusqlite::{OptionalExtension, Transaction, params};
use serde_json::Value;

use crate::apply::apply_envelope_with;
use crate::cursor::advance_shared_peer_tx;
use crate::{
    ApplyOutcome, PathClass, ReplicationEnvelope, SyncError, classify_share_path,
    read_shared_peer_position,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShareSurface {
    SharedChannel,
    ShareView,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShareBoundary {
    pub share_id: String,
    pub surface: ShareSurface,
    pub channel_wire_id: Option<String>,
    pub path_prefix: Option<String>,
}

/// Apply an inbound shared op only if its channel/path selector remains inside
/// the receiving grant. This surface never captures a new local outbound op.
///
/// Enforcement is fail-closed. ShareView is validated before the transaction
/// (it needs no store state). SharedChannel is validated INSIDE the write
/// transaction, because message/reaction/decision/attachment ops carry no
/// channel field and must be scoped by resolving `thread_id ->
/// chat_threads.channel_id -> chat_channel_wire_ids.wire_id` against the
/// granted wire id — a denied op then rolls back with nothing applied or acked.
pub fn apply_shared_envelope(
    store: &mut EngineStore,
    boundary: &ShareBoundary,
    envelope: &ReplicationEnvelope,
    faults: &dyn FaultInjector,
) -> Result<ApplyOutcome<i64>, SyncError> {
    crate::model::bounded(&boundary.share_id, "share_id must be non-empty and bounded")?;
    if boundary.surface == ShareSurface::ShareView {
        enforce_share_view_boundary(boundary, envelope)?;
        return Ok(ApplyOutcome::Applied(envelope.origin_seq));
    }

    let source_origin_id = envelope.origin_id.clone();
    let source_origin_seq = envelope.origin_seq;
    let position = read_shared_peer_position(
        store,
        &envelope.workspace_id,
        &boundary.share_id,
        &source_origin_id,
    )?;
    if source_origin_seq <= position.applied_origin_seq {
        return Ok(ApplyOutcome::Skipped);
    }
    let dense_seq = position
        .dense_seq
        .checked_add(1)
        .ok_or(SyncError::CoordinateDiverged)?;
    let mut dense = envelope.clone();
    dense.origin_id = format!("shared:{}:{}", boundary.share_id, source_origin_id);
    dense.origin_seq = dense_seq;

    let outcome = apply_envelope_with(store, &dense, faults, |tx, op| {
        enforce_shared_channel_boundary(tx, boundary, op)?;
        crate::apply::apply_chat_tx(tx, op)?;
        advance_shared_peer_tx(
            tx,
            &op.workspace_id,
            &boundary.share_id,
            &source_origin_id,
            source_origin_seq,
        )
    })?;
    let advance_source = match &outcome {
        ApplyOutcome::Applied(_) | ApplyOutcome::Crashed { .. } => false,
        ApplyOutcome::Skipped => true,
    };
    if advance_source {
        match store.write_with(faults, |tx| {
            advance_shared_peer_tx(
                tx,
                &envelope.workspace_id,
                &boundary.share_id,
                &source_origin_id,
                source_origin_seq,
            )?;
            Ok::<(), SyncError>(())
        })? {
            TxnOutcome::Committed(()) => {}
            TxnOutcome::Crashed { .. } => return Err(SyncError::FaultCrash),
        }
    }
    Ok(outcome)
}

/// Fail-closed SharedChannel scoping. Every admitted op must positively bind to
/// the granted channel wire id; receiver-private ops and everything else are
/// denied. Mirrors `services/sync-relay/src/shareFilter.ts`
/// `filterChatOpForChannelShare`.
fn enforce_shared_channel_boundary(
    tx: &Transaction<'_>,
    boundary: &ShareBoundary,
    op: &ReplicationEnvelope,
) -> Result<(), SyncError> {
    let granted = boundary
        .channel_wire_id
        .as_deref()
        .ok_or(SyncError::ShareBoundaryViolation)?;
    match op.op_kind.as_str() {
        // The create ops carry the channel selector on the wire; require it
        // present AND equal to the grant (absent -> deny).
        "chat.channel.create" => {
            let wire = op
                .payload
                .get("wireId")
                .and_then(Value::as_str)
                .ok_or(SyncError::ShareBoundaryViolation)?;
            if wire != granted {
                return Err(SyncError::ShareBoundaryViolation);
            }
        }
        "chat.thread.create" => {
            let wire = op
                .payload
                .get("channelWireId")
                .and_then(Value::as_str)
                .ok_or(SyncError::ShareBoundaryViolation)?;
            if wire != granted {
                return Err(SyncError::ShareBoundaryViolation);
            }
        }
        // These carry no channel field: resolve the binding in-store and
        // require equality to the grant. Unresolved (missing thread, or a
        // thread with no / a different channel) -> deny.
        "chat.message.append"
        | "chat.reaction.set"
        | "chat.decision.set"
        | "chat.attachment.add" => {
            let thread_id = op
                .payload
                .get("threadId")
                .and_then(Value::as_str)
                .ok_or(SyncError::ShareBoundaryViolation)?;
            if !thread_bound_to_wire(tx, &op.workspace_id, thread_id, granted)? {
                return Err(SyncError::ShareBoundaryViolation);
            }
        }
        // Receiver-private feed state and any other op kind: never served
        // through a channel share.
        _ => return Err(SyncError::ShareBoundaryViolation),
    }
    Ok(())
}

/// Whether `thread_id` resolves to a channel carrying the granted wire id.
/// `thread_id -> chat_threads.channel_id -> chat_channel_wire_ids.wire_id`.
fn thread_bound_to_wire(
    tx: &Transaction<'_>,
    workspace_id: &str,
    thread_id: &str,
    granted: &str,
) -> Result<bool, SyncError> {
    let channel_id: Option<String> = tx
        .query_row(
            "SELECT channel_id FROM chat_threads WHERE workspace_id = ?1 AND thread_id = ?2",
            params![workspace_id, thread_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
        .map_err(SyncError::corrupt)?
        .flatten();
    let Some(channel_id) = channel_id else {
        return Ok(false);
    };
    let bound: bool = tx
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM chat_channel_wire_ids \
             WHERE workspace_id = ?1 AND channel_id = ?2 AND wire_id = ?3)",
            params![workspace_id, channel_id, granted],
            |row| row.get(0),
        )
        .map_err(SyncError::corrupt)?;
    Ok(bound)
}

/// Fail-closed ShareView scoping. EVERY referenced path (`path`,
/// `payloadBeforePath`, `payloadAfterPath`, `beforePath`) must classify
/// `Tracked` and sit within the grant prefix, and at least one must be present
/// — mirroring `services/sync-relay/src/shareFilter.ts` moment.append
/// all-paths visibility so a rename crossing the boundary cannot leak the
/// outside path.
fn enforce_share_view_boundary(
    boundary: &ShareBoundary,
    op: &ReplicationEnvelope,
) -> Result<(), SyncError> {
    let prefix = boundary
        .path_prefix
        .as_deref()
        .ok_or(SyncError::ShareBoundaryViolation)?;
    if !matches!(op.op_kind.as_str(), "moment.append" | "version.create") {
        return Err(SyncError::ShareBoundaryViolation);
    }
    let mut paths = Vec::new();
    for field in [
        "path",
        "payloadBeforePath",
        "payloadAfterPath",
        "beforePath",
    ] {
        if let Some(path) = op.payload.get(field).and_then(Value::as_str) {
            paths.push(path);
        }
    }
    if op.op_kind == "version.create" {
        for snapshot in op
            .payload
            .get("forkSnapshots")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let path = snapshot
                .get("path")
                .and_then(Value::as_str)
                .ok_or(SyncError::ShareBoundaryViolation)?;
            paths.push(path);
        }
    }
    if paths.is_empty() {
        return Err(SyncError::ShareBoundaryViolation);
    }
    for path in paths {
        if classify_share_path(path) != PathClass::Tracked || !path_within_prefix(path, prefix) {
            return Err(SyncError::ShareBoundaryViolation);
        }
    }
    Ok(())
}

fn path_within_prefix(path: &str, prefix: &str) -> bool {
    path == prefix
        || path
            .strip_prefix(prefix)
            .is_some_and(|tail| tail.starts_with('/'))
}
