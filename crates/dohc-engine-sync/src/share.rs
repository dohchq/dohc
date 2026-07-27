use dohc_engine_storage::{EngineStore, FaultInjector};
use rusqlite::{OptionalExtension, Transaction, params};
use serde_json::Value;

use crate::apply::apply_envelope_with;
use crate::cursor::advance_shared_peer_tx;
use crate::{ApplyOutcome, PathClass, ReplicationEnvelope, SyncError, classify_share_path};

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
    }
    apply_envelope_with(store, envelope, faults, |tx, op| {
        if boundary.surface == ShareSurface::SharedChannel {
            enforce_shared_channel_boundary(tx, boundary, op)?;
            let _ = crate::apply::apply_chat_tx(tx, op)?;
            advance_shared_peer_tx(
                tx,
                &op.workspace_id,
                &boundary.share_id,
                &op.origin_id,
                op.origin_seq,
            )
        } else {
            Ok(op.origin_seq)
        }
    })
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
    let mut any = false;
    for field in [
        "path",
        "payloadBeforePath",
        "payloadAfterPath",
        "beforePath",
    ] {
        if let Some(path) = op.payload.get(field).and_then(Value::as_str) {
            any = true;
            if classify_share_path(path) != PathClass::Tracked {
                return Err(SyncError::ShareBoundaryViolation);
            }
            if !path_within_prefix(path, prefix) {
                return Err(SyncError::ShareBoundaryViolation);
            }
        }
    }
    if !any {
        return Err(SyncError::ShareBoundaryViolation);
    }
    Ok(())
}

fn path_within_prefix(path: &str, prefix: &str) -> bool {
    path == prefix
        || path
            .strip_prefix(prefix)
            .is_some_and(|tail| tail.starts_with('/'))
}
