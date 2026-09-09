use super::*;
use dohc_engine_collab::live_update_application::{
    ApplicationHostCoordinate, LiveApplicationBootstrap, LiveUpdateReceipt,
};

/// Historical source facts. These never become imported owner registrations.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub(super) enum OriginRecord {
    Bootstrap {
        source: Box<LiveApplicationBootstrap>,
        #[serde(rename = "hostCoordinate")]
        host_coordinate: ApplicationHostCoordinate,
        #[serde(rename = "localYDocSequence")]
        local_ydoc_sequence: i64,
    },
    Owner {
        source: Box<OwnerSource>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct OwnerSource {
    adoption_id: String,
    evidence_digest: String,
    source_moment_id: String,
    source_digest: String,
    source_byte_length: i64,
    baseline_moment_relay_sequence: i64,
    baseline_registered_at_ms: i64,
    coverage_digest: String,
    covered_outbox_sequence: i64,
    #[serde(rename = "localYDocSequence")]
    local_ydoc_sequence: i64,
    terminal_cursor: i64,
    terminal_receipt: Option<LiveUpdateReceipt>,
    host_coordinate: ApplicationHostCoordinate,
    max_pending_bytes: i64,
    max_pending_age_ms: i64,
}

impl OriginRecord {
    pub(super) fn stamp(
        &self,
        conn: &Connection,
        binding: &LiveObjectBinding,
    ) -> Result<String, SyncError> {
        match self {
            Self::Bootstrap {
                source,
                host_coordinate,
                local_ydoc_sequence,
            } => {
                source.validate().map_err(SyncError::corrupt)?;
                host_coordinate.validate().map_err(SyncError::corrupt)?;
                if source.baseline_digest != binding.lineage_claim_id || *local_ydoc_sequence != 0 {
                    return Err(invalid("historical bootstrap source differs"));
                }
                Ok(hex_sha256(
                    &serde_json::to_vec(&(source, binding, host_coordinate, local_ydoc_sequence))
                        .map_err(SyncError::corrupt)?,
                ))
            }
            Self::Owner { source: s } => {
                for id in [&s.adoption_id, &s.source_moment_id] {
                    crate::model::bounded(id, "invalid historical adoption identity")?;
                    if id.bytes().any(|b| b.is_ascii_control()) {
                        return Err(invalid("invalid historical adoption identity"));
                    }
                }
                s.host_coordinate.validate().map_err(SyncError::corrupt)?;
                if [&s.evidence_digest, &s.source_digest, &s.coverage_digest]
                    .iter()
                    .any(|v| !digest(v))
                    || [
                        s.source_byte_length,
                        s.baseline_moment_relay_sequence,
                        s.baseline_registered_at_ms,
                        s.covered_outbox_sequence,
                        s.local_ydoc_sequence,
                        s.terminal_cursor,
                    ]
                    .iter()
                    .any(|v| !(0..=crate::MAX_WIRE_INTEGER).contains(v))
                    || s.source_byte_length > dohc_engine_domain::MAX_TEXT_BYTES as i64
                    || !(1..=crate::MAX_WIRE_INTEGER).contains(&s.max_pending_bytes)
                    || !(1..=crate::MAX_WIRE_INTEGER).contains(&s.max_pending_age_ms)
                    || s.terminal_receipt.as_ref().map_or(0, |r| r.journal_cursor)
                        != s.terminal_cursor
                {
                    return Err(invalid("invalid historical adoption source"));
                }
                if let Some(r) = &s.terminal_receipt {
                    r.validate().map_err(SyncError::corrupt)?;
                }
                // The native stamp hashes SQLite's JSON array, including its embedded JSON strings.
                let binding_json = serde_json::to_string(binding).map_err(SyncError::corrupt)?;
                let terminal_json =
                    serde_json::to_string(&s.terminal_receipt).map_err(SyncError::corrupt)?;
                let host_json =
                    serde_json::to_string(&s.host_coordinate).map_err(SyncError::corrupt)?;
                let json: String = conn
                    .query_row(
                        "SELECT json_array(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)",
                        params![
                            s.adoption_id,
                            s.evidence_digest,
                            binding_json,
                            s.source_moment_id,
                            s.source_digest,
                            s.source_byte_length,
                            s.baseline_moment_relay_sequence,
                            s.baseline_registered_at_ms,
                            s.coverage_digest,
                            s.covered_outbox_sequence,
                            s.local_ydoc_sequence,
                            s.terminal_cursor,
                            terminal_json,
                            host_json,
                            s.max_pending_bytes,
                            s.max_pending_age_ms
                        ],
                        |r| r.get(0),
                    )
                    .map_err(SyncError::corrupt)?;
                Ok(hex_sha256(json.as_bytes()))
            }
        }
    }
}

pub(super) fn read(
    conn: &Connection,
    namespace: &str,
    binding: &LiveObjectBinding,
) -> Result<OriginRecord, SyncError> {
    let p = scope(namespace, binding);
    let bootstrap:Option<(String,String,String,i64)>=conn.query_row(&format!("SELECT json_object('bootstrapId',bootstrap_id,'bootstrapMomentId',bootstrap_moment_id,'baselineMomentRelaySequence',baseline_moment_relay_sequence,'baselineRegisteredAtMs',baseline_registered_at_ms,'baselineDigest',baseline_digest,'baselineByteLength',baseline_byte_length,'projectedMarkdownDigest',projected_markdown_digest,'projectedMarkdownByteLength',projected_markdown_byte_length),binding_json,host_coordinate_json,local_ydoc_sequence FROM live_device_bootstraps WHERE {SCOPE}"),p,|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional().map_err(SyncError::corrupt)?;
    let (source, stored_binding) = if let Some((source, binding, host, sequence)) = bootstrap {
        (
            OriginRecord::Bootstrap {
                source: Box::new(serde_json::from_str(&source).map_err(SyncError::corrupt)?),
                host_coordinate: serde_json::from_str(&host).map_err(SyncError::corrupt)?,
                local_ydoc_sequence: sequence,
            },
            binding,
        )
    } else {
        let (json,binding):(String,String)=conn.query_row(&format!("SELECT json_object('adoptionId',adoption_id,'evidenceDigest',evidence_digest,'sourceMomentId',source_moment_id,'sourceDigest',source_digest,'sourceByteLength',source_byte_length,'baselineMomentRelaySequence',baseline_moment_relay_sequence,'baselineRegisteredAtMs',baseline_registered_at_ms,'coverageDigest',coverage_digest,'coveredOutboxSequence',covered_outbox_sequence,'localYDocSequence',local_ydoc_sequence,'terminalCursor',terminal_cursor,'terminalReceipt',json(terminal_receipt_json),'hostCoordinate',json(host_coordinate_json),'maxPendingBytes',max_pending_bytes,'maxPendingAgeMs',max_pending_age_ms),binding_json FROM live_owner_adoptions WHERE {SCOPE}"),p,|r|Ok((r.get(0)?,r.get(1)?))).map_err(SyncError::corrupt)?;
        (
            OriginRecord::Owner {
                source: Box::new(serde_json::from_str(&json).map_err(SyncError::corrupt)?),
            },
            binding,
        )
    };
    if serde_json::from_str::<LiveObjectBinding>(&stored_binding).map_err(SyncError::corrupt)?
        != *binding
    {
        return Err(invalid("historical origin binding differs"));
    }
    Ok(source)
}

impl OriginRecord {
    pub(super) fn matches_restore(
        &self,
        origin: &dohc_engine_collab::live_update_application::RestoreDeliveryOrigin,
        host_id: &str,
        evidence: &str,
    ) -> Result<bool, SyncError> {
        use dohc_engine_collab::live_update_application::RestoreDeliveryOrigin;
        Ok(match (self, origin) {
            (
                Self::Bootstrap {
                    source,
                    host_coordinate,
                    ..
                },
                RestoreDeliveryOrigin::Bootstrap { id },
            ) => {
                source.bootstrap_id == *id
                    && host_coordinate.host_id == host_id
                    && hex_sha256(&serde_json::to_vec(source).map_err(SyncError::corrupt)?)
                        == evidence
            }
            (Self::Owner { source }, RestoreDeliveryOrigin::Owner { id }) => {
                source.adoption_id == *id
                    && source.host_coordinate.host_id == host_id
                    && source.evidence_digest == evidence
            }
            _ => false,
        })
    }
}
