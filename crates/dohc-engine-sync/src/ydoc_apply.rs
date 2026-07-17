use dohc_engine_collab::limits::DEFAULT_COMPACTION_THRESHOLD;
use dohc_engine_collab::{
    DocKey, RemoteUpdate, ReplicationApplyOutcome, apply_remote_update_in_transaction,
    maybe_compact,
};
use dohc_engine_storage::{EngineStore, FaultInjector};
use rusqlite::OptionalExtension;
use serde::Deserialize;

use crate::{ApplyOutcome, PathClass, ReplicationEnvelope, SyncError};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct YdocUpdatePayload {
    version_id: String,
    object_id: String,
    path: String,
    content_kind: String,
    update_blob_sha256: String,
    #[serde(default)]
    is_base_state: bool,
}

pub fn apply_ydoc_envelope(
    store: &mut EngineStore,
    envelope: &ReplicationEnvelope,
    faults: &dyn FaultInjector,
) -> Result<ApplyOutcome<()>, SyncError> {
    if envelope.op_kind != "ydoc.update" {
        return Err(SyncError::UnsupportedOperation);
    }
    let payload: YdocUpdatePayload =
        serde_json::from_value(envelope.payload.clone()).map_err(|_| SyncError::InvalidInput {
            reason: "ydoc.update payload is malformed",
        })?;
    if crate::classify_share_path(&payload.path) != PathClass::Tracked
        || !matches!(payload.content_kind.as_str(), "plaintext" | "richdoc")
    {
        return Err(SyncError::InvalidInput {
            reason: "ydoc.update path or content kind is invalid",
        });
    }
    let key = DocKey::new(
        envelope.workspace_id.clone(),
        payload.version_id,
        payload.object_id,
    )
    .map_err(|_| SyncError::InvalidInput {
        reason: "ydoc.update coordinates are invalid",
    })?;
    let bytes: Vec<u8> = store.read_with(|conn| {
        conn.query_row(
            "SELECT bytes FROM binary_blobs WHERE sha256=?1",
            [&payload.update_blob_sha256],
            |row| row.get(0),
        )
        .optional()
        .map_err(SyncError::corrupt)?
        .ok_or(SyncError::BlobInvalid)
    })?;
    if dohc_engine_storage::hex_sha256(&bytes) != payload.update_blob_sha256 {
        return Err(SyncError::BlobInvalid);
    }
    let remote = RemoteUpdate {
        origin_id: envelope.origin_id.clone(),
        origin_seq: envelope.origin_seq,
        bytes,
    };
    let outcome = crate::apply_envelope_with(store, envelope, faults, |tx, op| {
        let _ = payload.is_base_state;
        apply_remote_update_in_transaction(tx, &key, &remote, op.recorded_at_ms).map_err(|_| {
            SyncError::InvalidInput {
                reason: "ydoc.update could not be applied",
            }
        })
    })?;
    if matches!(
        outcome,
        ApplyOutcome::Applied(ReplicationApplyOutcome::Applied { .. })
    ) {
        maybe_compact(
            store,
            &key,
            DEFAULT_COMPACTION_THRESHOLD,
            faults,
            envelope.recorded_at_ms,
        )
        .map_err(|_| SyncError::InvalidInput {
            reason: "ydoc.update compaction failed",
        })?;
    }
    Ok(match outcome {
        ApplyOutcome::Applied(_) => ApplyOutcome::Applied(()),
        ApplyOutcome::Skipped => ApplyOutcome::Skipped,
        ApplyOutcome::Crashed { committed } => ApplyOutcome::Crashed { committed },
    })
}
