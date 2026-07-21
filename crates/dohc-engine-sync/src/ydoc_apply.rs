use dohc_engine_collab::limits::DEFAULT_COMPACTION_THRESHOLD;
use dohc_engine_collab::{
    DocKey, RemoteUpdate, ReplicationApplyOutcome, apply_remote_update,
    apply_remote_update_in_transaction, maybe_compact,
};
use dohc_engine_storage::{EngineStore, FaultInjector, TxnOutcome};
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

/// Read-only lease seam used by sync apply to avoid mutating a lineage while
/// an interactive daemon session owns it.
pub trait LeaseProbe: Send + Sync {
    fn is_live(&self, key: &DocKey) -> bool;
}

/// Default probe for callers that do not own an interactive session registry.
#[derive(Debug, Default, Clone, Copy)]
pub struct NoLiveLeases;

impl LeaseProbe for NoLiveLeases {
    fn is_live(&self, _key: &DocKey) -> bool {
        false
    }
}

impl LeaseProbe for dohc_engine_collab::LeaseRegistry {
    fn is_live(&self, key: &DocKey) -> bool {
        self.is_held(key)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct YdocApplyResult {
    pub deferred: bool,
    pub reason: Option<&'static str>,
}

/// Drain acked Y.Doc envelopes parked in the imported replication log while
/// `key` was leased. That log is the durable pending queue: replaying a row
/// already applied is convergence-neutral and content-deduped.
pub fn drain_deferred_ydoc_for_key(
    store: &mut EngineStore,
    key: &DocKey,
    faults: &dyn FaultInjector,
) -> Result<usize, SyncError> {
    let pending: Vec<(String, i64, i64, YdocUpdatePayload)> = store.read_with(|conn| {
        let mut stmt = conn
            .prepare(
                "SELECT origin_id, origin_seq, recorded_at_ms, payload_json \
                 FROM replication_log WHERE workspace_id = ?1 AND op_kind = 'ydoc.update' \
                 ORDER BY recorded_at_ms, origin_id, origin_seq",
            )
            .map_err(SyncError::corrupt)?;
        let rows = stmt
            .query_map([&key.workspace_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, String>(3)?,
                ))
            })
            .map_err(SyncError::corrupt)?;
        let mut pending = Vec::new();
        for row in rows {
            let (origin_id, origin_seq, recorded_at_ms, payload_json) =
                row.map_err(SyncError::corrupt)?;
            let payload =
                serde_json::from_str::<YdocUpdatePayload>(&payload_json).map_err(|_| {
                    SyncError::InvalidInput {
                        reason: "parked ydoc.update payload is malformed",
                    }
                })?;
            if payload.version_id == key.version_id && payload.object_id == key.object_id {
                pending.push((origin_id, origin_seq, recorded_at_ms, payload));
            }
        }
        Ok::<_, SyncError>(pending)
    })?;
    let mut applied = 0usize;
    for (origin_id, origin_seq, recorded_at_ms, payload) in pending {
        let bytes = store
            .get_binary_blob(&payload.update_blob_sha256)?
            .ok_or(SyncError::BlobInvalid)?;
        if dohc_engine_storage::hex_sha256(&bytes) != payload.update_blob_sha256 {
            return Err(SyncError::BlobInvalid);
        }
        match apply_remote_update(
            store,
            key,
            &RemoteUpdate {
                origin_id,
                origin_seq,
                bytes,
            },
            faults,
            recorded_at_ms,
        )
        .map_err(|_| SyncError::InvalidInput {
            reason: "parked ydoc.update could not be applied",
        })? {
            TxnOutcome::Committed(ReplicationApplyOutcome::Applied { .. }) => applied += 1,
            TxnOutcome::Committed(ReplicationApplyOutcome::Deduped { .. }) => {}
            TxnOutcome::Crashed { .. } => return Err(SyncError::FaultCrash),
        }
    }
    Ok(applied)
}

pub fn apply_ydoc_envelope(
    store: &mut EngineStore,
    envelope: &ReplicationEnvelope,
    faults: &dyn FaultInjector,
    leases: &dyn LeaseProbe,
) -> Result<ApplyOutcome<YdocApplyResult>, SyncError> {
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
    if leases.is_live(&key) {
        return crate::apply_envelope_with(store, envelope, faults, |_tx, _op| {
            Ok(YdocApplyResult {
                deferred: true,
                reason: Some("ydoc-session-live"),
            })
        });
    }
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
        ApplyOutcome::Applied(_) => ApplyOutcome::Applied(YdocApplyResult {
            deferred: false,
            reason: None,
        }),
        ApplyOutcome::Skipped => ApplyOutcome::Skipped,
        ApplyOutcome::Crashed { committed } => ApplyOutcome::Crashed { committed },
    })
}
