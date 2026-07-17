use dohc_engine_storage::{EngineStore, FaultInjector};

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
pub fn apply_shared_envelope(
    store: &mut EngineStore,
    boundary: &ShareBoundary,
    envelope: &ReplicationEnvelope,
    faults: &dyn FaultInjector,
) -> Result<ApplyOutcome<i64>, SyncError> {
    crate::model::bounded(&boundary.share_id, "share_id must be non-empty and bounded")?;
    enforce_boundary(boundary, envelope)?;
    apply_envelope_with(store, envelope, faults, |tx, op| {
        if boundary.surface == ShareSurface::SharedChannel {
            crate::apply::apply_chat_tx(tx, op)?;
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

fn enforce_boundary(boundary: &ShareBoundary, op: &ReplicationEnvelope) -> Result<(), SyncError> {
    match boundary.surface {
        ShareSurface::SharedChannel => {
            if matches!(
                op.op_kind.as_str(),
                "chat.follow.set" | "chat.feed.read.set"
            ) {
                return Err(SyncError::ShareBoundaryViolation);
            }
            if !matches!(
                op.op_kind.as_str(),
                "chat.channel.create"
                    | "chat.thread.create"
                    | "chat.message.append"
                    | "chat.decision.set"
                    | "chat.attachment.add"
                    | "chat.reaction.set"
            ) {
                return Err(SyncError::ShareBoundaryViolation);
            }
            let expected = boundary
                .channel_wire_id
                .as_deref()
                .ok_or(SyncError::ShareBoundaryViolation)?;
            let selected = op
                .payload
                .get("channelWireId")
                .or_else(|| op.payload.get("wireId"))
                .and_then(serde_json::Value::as_str);
            if selected.is_some_and(|actual| actual != expected) {
                return Err(SyncError::ShareBoundaryViolation);
            }
        }
        ShareSurface::ShareView => {
            let path = op
                .payload
                .get("path")
                .and_then(serde_json::Value::as_str)
                .ok_or(SyncError::ShareBoundaryViolation)?;
            if classify_share_path(path) != PathClass::Tracked {
                return Err(SyncError::ShareBoundaryViolation);
            }
            let prefix = boundary
                .path_prefix
                .as_deref()
                .ok_or(SyncError::ShareBoundaryViolation)?;
            if path != prefix
                && !path
                    .strip_prefix(prefix)
                    .is_some_and(|tail| tail.starts_with('/'))
            {
                return Err(SyncError::ShareBoundaryViolation);
            }
        }
    }
    Ok(())
}
