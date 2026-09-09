use super::*;
use dohc_engine_collab::live_update_application::{
    LiveUpdateReceipt, NativeRestorePoint, RelayAcceptedLiveUpdate, RestoreDeliveryOrigin,
    ServerDerivedLiveUpdateAuthority,
};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HistoryEnd {
    event_count: i64,
    terminal: Option<LiveUpdateReceipt>,
    evidence_digest: String,
}

/// The accepted history supplies authors and bytes. Private quarantined sources
/// stay private; their native manifest fingerprint records the reviewed cut.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct RestoreSource {
    pub operation_id: String,
    old_generation: i64,
    origin: RestoreDeliveryOrigin,
    host_id: String,
    applied_sequence: i64,
    fence_head_sequence: i64,
    fenced_at_ms: i64,
    pub point: NativeRestorePoint,
    selected: HistoryEnd,
    accepted: HistoryEnd,
    origin_evidence_digest: String,
    native_source_manifest_digest: String,
    frozen_state_digest: String,
    point_state_digest: String,
    final_content_digest: String,
}

impl HistoryEnd {
    fn verify(
        &self,
        conn: &Connection,
        namespace: &str,
        binding: &LiveObjectBinding,
        base: &BaseRecord,
    ) -> Result<(), SyncError> {
        if !(0..=crate::MAX_WIRE_INTEGER).contains(&self.event_count)
            || !digest(&self.evidence_digest)
        {
            return Err(invalid("invalid restore history endpoint"));
        }
        let Some(receipt) = &self.terminal else {
            if self.event_count != 0 || self.evidence_digest != base.checkpoint.evidence_digest {
                return Err(invalid("restore event-zero endpoint differs"));
            }
            return Ok(());
        };
        receipt.validate().map_err(SyncError::corrupt)?;
        let p = scope(namespace, binding);
        let actual:Option<(i64,String,String,i64)>=conn.query_row(&format!("SELECT e.journal_cursor,e.evidence_digest,m.update_sha256,e.accepting_host_epoch FROM live_audit_events e JOIN live_audit_record_manifests m ON m.record_digest=e.record_digest WHERE {SCOPE} AND e.event_count=?6 AND e.delivery_id=?7"),params![p[0],p[1],p[2],p[3],p[4],self.event_count,receipt.delivery_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional().map_err(SyncError::corrupt)?;
        let actual = actual.ok_or(SyncError::RetryableState {
            reason: "restore audit history endpoint is unavailable",
        })?;
        if actual
            != (
                receipt.journal_cursor,
                self.evidence_digest.clone(),
                receipt.update_digest.clone(),
                receipt.accepting_host_epoch,
            )
        {
            return Err(invalid("restore audit history endpoint differs"));
        }
        Ok(())
    }
}

impl RestoreSource {
    pub(super) fn verify(
        &self,
        conn: &Connection,
        namespace: &str,
        event_count: i64,
        accepted: &RelayAcceptedLiveUpdate,
        sequence: i64,
        host_id: &str,
    ) -> Result<(), SyncError> {
        let b = &accepted.binding;
        crate::model::bounded(&self.operation_id, "invalid historical restore operation")?;
        if self.operation_id.bytes().any(|c| c.is_ascii_control())
            || !matches!(
                accepted.authority,
                ServerDerivedLiveUpdateAuthority::Owner { .. }
            )
            || self.old_generation.checked_add(1) != Some(b.restore_fence_generation)
            || [
                self.old_generation,
                self.applied_sequence,
                self.fence_head_sequence,
                self.fenced_at_ms,
                self.point.journal_cursor,
            ]
            .iter()
            .any(|n| !(0..=crate::MAX_WIRE_INTEGER).contains(n))
            || self.applied_sequence > self.fence_head_sequence
            || self.fence_head_sequence.checked_add(1) != Some(sequence)
            || self.host_id != host_id
            || self.accepted.event_count.checked_add(1) != Some(event_count)
            || self.selected.event_count > self.accepted.event_count
            || self.point.journal_cursor
                != self
                    .selected
                    .terminal
                    .as_ref()
                    .map_or(0, |r| r.journal_cursor)
            || accepted.receipt.journal_cursor
                <= self
                    .accepted
                    .terminal
                    .as_ref()
                    .map_or(0, |r| r.journal_cursor)
            || self.point.receipt_digest
                != self
                    .selected
                    .terminal
                    .as_ref()
                    .map_or(b.lineage_claim_id.as_str(), |r| r.update_digest.as_str())
            || [
                &self.point.markdown_digest,
                &self.point.projection_digest,
                &self.origin_evidence_digest,
                &self.native_source_manifest_digest,
                &self.frozen_state_digest,
                &self.point_state_digest,
                &self.final_content_digest,
            ]
            .iter()
            .any(|v| !digest(v))
        {
            return Err(invalid("historical restore source differs"));
        }
        let p = scope(namespace, b);
        let json:String=conn.query_row(&format!("SELECT record_json FROM live_audit_base_publications WHERE {SCOPE} UNION ALL SELECT record_json FROM live_audit_bases WHERE {SCOPE} LIMIT 1"),p,|r|r.get(0)).map_err(SyncError::corrupt)?;
        let base: BaseRecord = serde_json::from_str(&json).map_err(SyncError::corrupt)?;
        if !base.origin.matches_restore(
            &self.origin,
            &self.host_id,
            &self.origin_evidence_digest,
        )? {
            return Err(invalid("historical restore origin differs"));
        }
        self.selected.verify(conn, namespace, b, &base)?;
        self.accepted.verify(conn, namespace, b, &base)?;
        Ok(())
    }
}

pub(super) fn read(
    conn: &Connection,
    namespace: &str,
    accepted: &RelayAcceptedLiveUpdate,
) -> Result<Option<RestoreSource>, SyncError> {
    let source:Option<(String,String,String)>=conn.query_row("SELECT json_object('operationId',operation_id,'oldGeneration',old_generation,'origin',json_extract(input_json,'$.origin'),'hostId',json_extract(input_json,'$.hostId'),'appliedSequence',json_extract(input_json,'$.appliedSequence'),'fenceHeadSequence',json_extract(receipt_json,'$.localHeadSequence'),'fencedAtMs',json_extract(receipt_json,'$.recordedAtMs'),'point',json_extract(proposal_json,'$.point'),'selected',json_object('eventCount',json_extract(proposal_json,'$.selectedHistory.eventCount'),'terminal',json_extract(proposal_json,'$.selectedHistory.terminal'),'evidenceDigest',json_extract(proposal_json,'$.selectedHistory.evidenceDigest')),'accepted',json_object('eventCount',json_extract(proposal_json,'$.acceptedHistory.eventCount'),'terminal',json_extract(proposal_json,'$.acceptedHistory.terminal'),'evidenceDigest',json_extract(proposal_json,'$.acceptedHistory.evidenceDigest')),'originEvidenceDigest',json_extract(proposal_json,'$.originEvidenceDigest'),'nativeSourceManifestDigest',json_extract(proposal_json,'$.nativeSourceManifestDigest'),'frozenStateDigest',proposal_frozen_sha256,'pointStateDigest',proposal_point_sha256,'finalContentDigest',json_extract(proposal_json,'$.finalContentDigest')),json_extract(application_json,'$.admitted.accepted'),proposal_candidate_sha256 FROM live_restore_fences WHERE relay_database_namespace=?1 AND application_delivery_id=?2",params![namespace,accepted.receipt.delivery_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional().map_err(SyncError::corrupt)?;
    let Some((json, application, candidate)) = source else {
        return Ok(None);
    };
    let source: RestoreSource = serde_json::from_str(&json).map_err(SyncError::corrupt)?;
    if serde_json::from_str::<RelayAcceptedLiveUpdate>(&application).map_err(SyncError::corrupt)?
        != *accepted
        || candidate != accepted.receipt.update_digest
    {
        return Err(invalid("native restore application source differs"));
    }
    let checkpoint:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM live_accepted_checkpoints WHERE relay_database_namespace=?1 AND workspace_id=?2 AND main_version_id=?3 AND object_id=?4 AND lineage_claim_id=?5 AND restore_operation_id=?6 AND journal_cursor=?7)",params![namespace,accepted.binding.workspace_id,accepted.binding.main_version_id,accepted.binding.object_id,accepted.binding.lineage_claim_id,source.operation_id,accepted.receipt.journal_cursor],|r|r.get(0)).map_err(SyncError::corrupt)?;
    if !checkpoint {
        return Err(invalid("native restore checkpoint is unavailable"));
    }
    Ok(Some(source))
}
