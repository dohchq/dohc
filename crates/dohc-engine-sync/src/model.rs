use serde::{Deserialize, Serialize};

/// JavaScript's largest exactly representable integer. Every sequence crossing
/// the relay trait boundary is validated against this value.
pub const MAX_WIRE_INTEGER: i64 = (1_i64 << 53) - 1;
pub const MAX_PUSH_OPS_PER_BATCH: usize = 500;
pub const MAX_PULL_OPS: usize = 500;
pub(crate) const MAX_IDENTIFIER_BYTES: usize = 512;
pub(crate) const MAX_OP_KIND_BYTES: usize = 128;
pub(crate) const MAX_PAYLOAD_BYTES: usize = 10 * 1024 * 1024;

/// One coordinate-addressed replication operation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplicationEnvelope {
    pub workspace_id: String,
    pub origin_id: String,
    pub origin_seq: i64,
    pub op_kind: String,
    pub payload: serde_json::Value,
    pub recorded_at_ms: i64,
}

impl ReplicationEnvelope {
    pub(crate) fn validate(&self) -> Result<(), crate::SyncError> {
        bounded(
            &self.workspace_id,
            "workspace_id must be non-empty and bounded",
        )?;
        bounded(&self.origin_id, "origin_id must be non-empty and bounded")?;
        if self.origin_seq < 0 || self.origin_seq > MAX_WIRE_INTEGER {
            return Err(crate::SyncError::InvalidInput {
                reason: "origin_seq is outside the wire integer range",
            });
        }
        if self.op_kind.is_empty() || self.op_kind.len() > MAX_OP_KIND_BYTES {
            return Err(crate::SyncError::InvalidInput {
                reason: "op_kind must be non-empty and bounded",
            });
        }
        let encoded =
            serde_json::to_vec(&self.payload).map_err(|_| crate::SyncError::InvalidInput {
                reason: "payload is not valid JSON",
            })?;
        if encoded.len() > MAX_PAYLOAD_BYTES {
            return Err(crate::SyncError::InvalidInput {
                reason: "payload exceeds the relay limit",
            });
        }
        Ok(())
    }

    pub(crate) fn payload_json(&self) -> Result<String, crate::SyncError> {
        serde_json::to_string(&self.payload).map_err(|_| crate::SyncError::InvalidInput {
            reason: "payload is not valid JSON",
        })
    }
}

pub(crate) fn bounded(value: &str, reason: &'static str) -> Result<(), crate::SyncError> {
    if value.is_empty()
        || value.len() > MAX_IDENTIFIER_BYTES
        || value.bytes().any(|byte| byte.is_ascii_control())
    {
        return Err(crate::SyncError::InvalidInput { reason });
    }
    Ok(())
}
