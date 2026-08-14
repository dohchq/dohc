use serde::{Deserialize, Serialize};

/// JavaScript's largest exactly representable integer. Every sequence crossing
/// the relay trait boundary is validated against this value.
pub const MAX_WIRE_INTEGER: i64 = (1_i64 << 53) - 1;
pub const MAX_PUSH_OPS_PER_BATCH: usize = 500;
pub const MAX_PULL_OPS: usize = 500;
pub const MAX_BLOB_HAVE_BATCH: usize = 2_000;
/// Matches `services/sync-relay`'s per-operation canonical JSON limit.
pub const MAX_PAYLOAD_JSON_BYTES: usize = 256 * 1024;
pub(crate) const MAX_PULL_PAGES_PER_PASS: usize = 16;
pub(crate) const MAX_PULL_OPS_PER_PASS: usize = MAX_PULL_OPS;
pub(crate) const MAX_IDENTIFIER_BYTES: usize = 512;
pub(crate) const MAX_OP_KIND_BYTES: usize = 128;

/// One coordinate-addressed replication operation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplicationEnvelope {
    pub workspace_id: String,
    pub origin_id: String,
    pub origin_seq: i64,
    /// Global workspace-log position. Pull must supply it; push envelopes have
    /// no relay position before the relay commits them.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub relay_seq: Option<i64>,
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
        if self
            .relay_seq
            .is_some_and(|relay_seq| !(0..=MAX_WIRE_INTEGER).contains(&relay_seq))
        {
            return Err(crate::SyncError::InvalidInput {
                reason: "relay_seq is outside the wire integer range",
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
        if encoded.len() > MAX_PAYLOAD_JSON_BYTES {
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

/// The clause of `bounded` a value breaks, phrased for a refusal whose reader
/// never sees the value. `None` when the value passes.
///
/// `bounded` is written in terms of this so the rule and the report of which
/// part of it fired cannot drift apart. Reporting the length clause for an id
/// that is short but carries a control byte tells the reader a bound the id
/// SATISFIES, which reads as a contradiction and hides the real cause.
pub(crate) fn unbounded_clause(value: &str) -> Option<String> {
    if value.is_empty() {
        return Some("it is empty".to_owned());
    }
    if value.len() > MAX_IDENTIFIER_BYTES {
        return Some(format!(
            "at most {MAX_IDENTIFIER_BYTES} bytes, offered {} bytes",
            value.len()
        ));
    }
    if value.bytes().any(|byte| byte.is_ascii_control()) {
        return Some("it carries a control byte".to_owned());
    }
    None
}

pub(crate) fn bounded(value: &str, reason: &'static str) -> Result<(), crate::SyncError> {
    if unbounded_clause(value).is_some() {
        return Err(crate::SyncError::InvalidInput { reason });
    }
    Ok(())
}
