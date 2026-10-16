use dohc_engine_collab::{DocKey, LiveObjectBinding, WriterDocCache};
use dohc_engine_storage::{EngineStore, FaultInjector};
use rusqlite::{OptionalExtension, Transaction, params};

mod lifecycle;
pub use lifecycle::*;

use crate::{ApplyOutcome, BlobKind, LeaseProbe, ReplicationEnvelope, RoutedApply, SyncError};

/// Inert until a caller opens it in the durable sent-ID transaction.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReleaseHold {
    binding: LiveObjectBinding,
    namespace: String,
    digest: String,
}

fn waiting() -> SyncError {
    SyncError::RetryableState {
        reason: "release hold is not ready for replay",
    }
}

#[cfg(test)]
pub(crate) fn open_release_hold_in(
    tx: &Transaction<'_>,
    binding: &LiveObjectBinding,
    namespace: &str,
    digest: &str,
) -> Result<ReleaseHold, SyncError> {
    open_in(tx, binding, namespace, digest, false)
}

fn open_in(
    tx: &Transaction<'_>,
    binding: &LiveObjectBinding,
    namespace: &str,
    digest: &str,
    adopting: bool,
) -> Result<ReleaseHold, SyncError> {
    binding
        .validate_canonical()
        .map_err(|_| SyncError::CoordinateDiverged)?;
    if namespace.is_empty()
        || digest.len() != 64
        || !digest
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(SyncError::CoordinateDiverged);
    }
    let hold = ReleaseHold {
        binding: binding.clone(),
        namespace: namespace.into(),
        digest: digest.into(),
    };
    let encoded = serde_json::to_string(binding).map_err(SyncError::corrupt)?;
    let valid: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM ydoc_owner_bindings WHERE workspace_id=?1 AND main_version_id=?2 AND object_id=?3 AND json(binding_json)=json(?4) AND relay_database_namespace=?5)",
        params![binding.workspace_id,binding.main_version_id,binding.object_id,encoded,namespace], |r| r.get(0)).map_err(SyncError::corrupt)?;
    if !valid {
        return Err(waiting());
    }
    let pending: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM owner_pending_settlements p WHERE workspace_id=?1 AND main_version_id=?2 AND object_id=?3 AND lineage_claim_id=?4 AND relay_namespace=?5 AND applied=0
        AND NOT EXISTS(SELECT 1 FROM release_held_ops r WHERE r.workspace_id=p.workspace_id AND r.origin_id=p.origin_id AND r.origin_seq=p.origin_seq))",
        params![binding.workspace_id,binding.main_version_id,binding.object_id,binding.lineage_claim_id,namespace], |r|r.get(0)).map_err(SyncError::corrupt)?;
    if pending && !adopting {
        return Err(waiting());
    }
    tx.execute("INSERT INTO release_holds(workspace_id,version_id,object_id,release_digest,binding_json,relay_namespace)
        VALUES (?1,?2,?3,?4,?5,?6) ON CONFLICT DO NOTHING",
        params![binding.workspace_id,binding.main_version_id,binding.object_id,digest,encoded,namespace]).map_err(SyncError::persist)?;
    hold.check_in(tx, false)?;
    Ok(hold)
}

pub fn read_release_hold(
    store: &EngineStore,
    key: &DocKey,
) -> Result<Option<ReleaseHold>, SyncError> {
    store.read_with(|c| c.query_row("SELECT binding_json,relay_namespace,release_digest FROM release_holds WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
        params![key.workspace_id,key.version_id,key.object_id], |r| Ok((r.get::<_,String>(0)?,r.get(1)?,r.get(2)?))).optional().map_err(SyncError::corrupt))?
        .map(|(json,namespace,digest)| Ok(ReleaseHold { binding: serde_json::from_str(&json).map_err(SyncError::corrupt)?,namespace,digest })).transpose()
}

impl ReleaseHold {
    pub fn binding(&self) -> &LiveObjectBinding {
        &self.binding
    }

    pub fn digest(&self) -> &str {
        &self.digest
    }

    fn check_identity_in(&self, conn: &rusqlite::Connection) -> Result<(), SyncError> {
        let encoded = serde_json::to_string(&self.binding).map_err(SyncError::corrupt)?;
        let found:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM release_holds WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3 AND release_digest=?4 AND json(binding_json)=json(?5) AND relay_namespace=?6)",params![self.binding.workspace_id,self.binding.main_version_id,self.binding.object_id,self.digest,encoded,self.namespace],|r|r.get(0)).map_err(SyncError::corrupt)?;
        if !found {
            return Err(waiting());
        }
        Ok(())
    }
    pub(crate) fn matches(&self, op: &ReplicationEnvelope) -> bool {
        op.workspace_id == self.binding.workspace_id
            && op.payload["versionId"] == self.binding.main_version_id
            && op.payload["objectId"] == self.binding.object_id
    }
    pub(crate) fn check_in(
        &self,
        tx: &rusqlite::Connection,
        replay: bool,
    ) -> Result<(), SyncError> {
        let encoded = serde_json::to_string(&self.binding).map_err(SyncError::corrupt)?;
        let ready: Option<(bool,bool)> = tx.query_row("SELECT replay_ready,abandoned FROM release_holds WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3 AND release_digest=?4 AND json(binding_json)=json(?5) AND relay_namespace=?6",
            params![self.binding.workspace_id,self.binding.main_version_id,self.binding.object_id,self.digest,encoded,self.namespace], |r|Ok((r.get(0)?,r.get(1)?))).optional().map_err(SyncError::corrupt)?;
        if ready.is_none_or(|(ready, abandoned)| abandoned || (replay && !ready)) {
            return Err(waiting());
        }
        if replay {
            self.check_released_in(tx)?;
        }
        Ok(())
    }
    fn check_released_in(&self, tx: &rusqlite::Connection) -> Result<(), SyncError> {
        let b = &self.binding;
        let expected = (b.restore_fence_generation > 0).then_some(b.restore_fence_generation);
        let key = DocKey::new(&b.workspace_id, &b.main_version_id, &b.object_id)
            .map_err(|_| SyncError::CoordinateDiverged)?;
        dohc_engine_collab::live_update_application::require_restore_generation(tx, &key, expected)
            .map_err(crate::ydoc_apply::map_collab_hard_error)?;
        let encoded = serde_json::to_string(b).map_err(SyncError::corrupt)?;
        let successor:bool=tx.query_row("SELECT successor_ready FROM release_holds WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",params![b.workspace_id,b.main_version_id,b.object_id],|r|r.get(0)).map_err(SyncError::corrupt)?;
        if successor {
            if restored_release_ready_in(tx, b, &self.namespace)? {
                return Ok(());
            }
            let installed = dohc_engine_collab::owner_outbox::prefix::effective_in(tx, b)
                .map_err(SyncError::corrupt)?;
            if installed.relay_database_namespace != self.namespace {
                return Err(waiting());
            }
            return Ok(());
        }
        let released: bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM owner_live_stops s JOIN ydoc_docs d ON d.workspace_id=s.workspace_id AND d.version_id=s.main_version_id AND d.object_id=s.object_id
            WHERE s.workspace_id=?1 AND s.main_version_id=?2 AND s.object_id=?3 AND s.state='released' AND json_extract(s.binding_json,'$.binding')=json(?4) AND s.relay_database_namespace=?5 AND d.lineage_claim_id=?6)
            AND NOT EXISTS(SELECT 1 FROM ydoc_owner_bindings WHERE workspace_id=?1 AND main_version_id=?2 AND object_id=?3)
            AND NOT EXISTS(SELECT 1 FROM live_device_application_bindings WHERE workspace_id=?1 AND main_version_id=?2 AND object_id=?3)",
            params![b.workspace_id,b.main_version_id,b.object_id,encoded,self.namespace,b.lineage_claim_id], |r|r.get(0)).map_err(SyncError::corrupt)?;
        if !released {
            return Err(waiting());
        }
        Ok(())
    }
    pub(crate) fn retain_in(
        &self,
        tx: &Transaction<'_>,
        op: &ReplicationEnvelope,
    ) -> Result<(), SyncError> {
        self.check_in(tx, false)?;
        if !self.matches(op) || op.relay_seq.is_none() {
            return Err(SyncError::CoordinateDiverged);
        }
        let json = serde_json::to_string(op).map_err(SyncError::corrupt)?;
        let refs = crate::relay::collect_blob_refs(std::slice::from_ref(op))
            .map_err(|_| SyncError::BlobInvalid)?;
        let mut bytes = json.len() as i64;
        let mut roots = Vec::new();
        for (sha, kinds) in refs {
            for kind in kinds {
                let text = kind == BlobKind::Text;
                let length: i64 = if text {
                    tx.query_row(
                        "SELECT length(CAST(text AS BLOB)) FROM blobs WHERE sha256=?1",
                        [&sha],
                        |r| r.get(0),
                    )
                } else {
                    tx.query_row(
                        "SELECT length(bytes) FROM binary_blobs WHERE sha256=?1",
                        [&sha],
                        |r| r.get(0),
                    )
                }
                .optional()
                .map_err(SyncError::corrupt)?
                .ok_or(SyncError::BlobInvalid)?;
                bytes = bytes
                    .checked_add(length)
                    .ok_or(SyncError::CoordinateDiverged)?;
                roots.push((sha.clone(), text));
            }
        }
        tx.execute("INSERT INTO release_held_ops(workspace_id,origin_id,origin_seq,version_id,object_id,release_digest,envelope_json,retained_bytes) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
            params![op.workspace_id,op.origin_id,op.origin_seq,self.binding.main_version_id,self.binding.object_id,self.digest,json,bytes]).map_err(SyncError::persist)?;
        let unowned:bool=tx.query_row(concat!("SELECT EXISTS(SELECT 1 FROM owner_pending_settlements p WHERE p.workspace_id=?1 AND p.origin_id=?2 AND p.origin_seq=?3 AND NOT (",owned_pending!(),"))"),params![op.workspace_id,op.origin_id,op.origin_seq],|r|r.get(0)).map_err(SyncError::corrupt)?;
        if unowned {
            return Err(waiting());
        }
        for (sha, text) in roots {
            tx.execute(
                "INSERT INTO release_held_blobs VALUES (?1,?2,?3,?4,?5,?6,?7)",
                params![
                    op.workspace_id,
                    op.origin_id,
                    op.origin_seq,
                    sha,
                    text,
                    text.then_some(&sha),
                    (!text).then_some(&sha)
                ],
            )
            .map_err(SyncError::persist)?;
        }
        let (count,bytes):(i64,i64)=tx.query_row("SELECT operation_count,retained_bytes FROM release_hold_usage WHERE workspace_id=?1",[&op.workspace_id],|r|Ok((r.get(0)?,r.get(1)?))).map_err(SyncError::corrupt)?;
        if count > 10_000 || bytes > 512 * 1024 * 1024 {
            return Err(SyncError::RetryableState {
                reason: "release hold capacity reached",
            });
        }
        Ok(())
    }
}

/// The caller still owes remote resolution. Local release alone cannot close it.
pub fn seal_release_hold_cut_in(
    tx: &Transaction<'_>,
    hold: &ReleaseHold,
    expected_anchor: i64,
) -> Result<(), SyncError> {
    hold.check_in(tx, false)?;
    let encoded = serde_json::to_string(&hold.binding).map_err(SyncError::corrupt)?;
    let row: Option<(i64,String)> = tx.query_row("SELECT accepted_cursor,checkpoint_digest FROM ydoc_owner_bindings WHERE workspace_id=?1 AND main_version_id=?2 AND object_id=?3 AND json(binding_json)=json(?4) AND relay_database_namespace=?5",
        params![hold.binding.workspace_id,hold.binding.main_version_id,hold.binding.object_id,encoded,hold.namespace],|r|Ok((r.get(0)?,r.get(1)?))).optional().map_err(SyncError::corrupt)?;
    let (cursor, sha) = row.ok_or_else(waiting)?;
    if cursor != expected_anchor {
        return Err(waiting());
    }
    let sealed: Option<(i64, String)> = tx.query_row("SELECT anchor_cursor,anchor_sha256 FROM release_holds WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3 AND anchor_cursor IS NOT NULL",
        params![hold.binding.workspace_id,hold.binding.main_version_id,hold.binding.object_id], |r|Ok((r.get(0)?,r.get(1)?))).optional().map_err(SyncError::corrupt)?;
    if sealed.is_some_and(|s| s != (cursor, sha.clone())) {
        return Err(waiting());
    }
    let bytes: Vec<u8> = tx
        .query_row(
            "SELECT bytes FROM binary_blobs WHERE sha256=?1",
            [&sha],
            |r| r.get(0),
        )
        .map_err(SyncError::corrupt)?;
    if dohc_engine_storage::hex_sha256(&bytes) != sha {
        return Err(SyncError::BlobInvalid);
    }
    tx.execute("UPDATE release_holds SET anchor_cursor=?4,anchor_sha256=?5 WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3 AND anchor_cursor IS NULL AND replay_ready=0",
        params![hold.binding.workspace_id,hold.binding.main_version_id,hold.binding.object_id,cursor,sha]).map_err(SyncError::persist)?;
    Ok(())
}

pub fn prepare_release_hold_replay_in(
    tx: &Transaction<'_>,
    hold: &ReleaseHold,
    remote_closed: bool,
) -> Result<(), SyncError> {
    hold.check_in(tx, false)?;
    hold.check_released_in(tx)?;
    let sealed: bool = tx.query_row("SELECT (anchor_cursor IS NOT NULL AND anchor_sha256 IS NOT NULL) OR successor_ready=1 FROM release_holds WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
        params![hold.binding.workspace_id,hold.binding.main_version_id,hold.binding.object_id], |r|r.get(0)).map_err(SyncError::corrupt)?;
    if !sealed {
        return Err(waiting());
    }
    tx.execute("UPDATE release_holds SET replay_ready=1,remote_closed=MAX(remote_closed,?4) WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
        params![hold.binding.workspace_id,hold.binding.main_version_id,hold.binding.object_id,remote_closed]).map_err(SyncError::persist)?;
    Ok(())
}

/// Explicit ordinary replication entry point; ordinary sync never calls it.
pub fn apply_replication_envelope_with_release_hold(
    store: &mut EngineStore,
    cache: &mut WriterDocCache,
    op: &ReplicationEnvelope,
    faults: &dyn FaultInjector,
    leases: &dyn LeaseProbe,
    hold: &ReleaseHold,
) -> Result<ApplyOutcome<RoutedApply>, SyncError> {
    let saved:Option<String>=store.read_with(|c|c.query_row("SELECT envelope_json FROM release_held_ops WHERE workspace_id=?1 AND origin_id=?2 AND origin_seq=?3",params![op.workspace_id,op.origin_id,op.origin_seq],|r|r.get(0)).optional().map_err(SyncError::corrupt))?;
    if let Some(saved) = saved
        && serde_json::from_str::<ReplicationEnvelope>(&saved).map_err(SyncError::corrupt)? != *op
    {
        return Err(SyncError::CoordinateDiverged);
    }
    if !hold.matches(op)
        || matches!(
            op.settlement_admission,
            Some(
                crate::SettlementAdmission::Refused { .. }
                    | crate::SettlementAdmission::ReleaseRefused { .. }
            )
        )
    {
        return crate::apply_replication_envelope(store, cache, op, faults, leases);
    }
    match op.op_kind.as_str() {
        "ydoc.update" => crate::ydoc_apply::apply_ydoc_envelope_in_batch(
            store,
            cache,
            op,
            faults,
            leases,
            false,
            crate::ydoc_apply::YdocAdmission::Hold(hold),
        )
        .map(|outcome| outcome.map(|_| RoutedApply::default())),
        "moment.append" => {
            crate::moment_apply::apply_moment_with_hold(store, op, faults, leases, Some(hold), None)
                .map(|outcome| outcome.map(|_| RoutedApply::default()))
        }
        _ => crate::apply_replication_envelope(store, cache, op, faults, leases),
    }
}

pub(crate) struct ReplayPermit<'a> {
    pub hold: &'a ReleaseHold,
    pub op: &'a ReplicationEnvelope,
}
impl ReplayPermit<'_> {
    pub(crate) fn included_in(&self, tx: &Transaction<'_>) -> Result<bool, SyncError> {
        let row:Option<(String,String)>=tx.query_row("SELECT h.anchor_sha256,json_extract(a.record_json,'$.acceptedStateBlobSha256')
            FROM release_holds h JOIN owner_pending_settlements p ON p.workspace_id=h.workspace_id AND p.main_version_id=h.version_id AND p.object_id=h.object_id
            JOIN live_audit_settlements a ON a.workspace_id=p.workspace_id AND json_extract(a.record_json,'$.momentId')=json_extract(?4,'$.momentId')
            WHERE p.workspace_id=?1 AND p.origin_id=?2 AND p.origin_seq=?3 AND p.terminal_cursor<=h.anchor_cursor
              AND json(p.binding_json)=json(h.binding_json) AND p.relay_namespace=h.relay_namespace
              AND NOT EXISTS(SELECT 1 FROM json_each(h.binding_json) b WHERE b.value IS NOT json_extract(a.record_json,'$.binding.'||b.key))
              AND json_extract(a.record_json,'$.relayDatabaseNamespace')=h.relay_namespace
              AND json_extract(a.record_json,'$.terminalCursor')=p.terminal_cursor
              AND a.markdown_digest=json_extract(?4,'$.payloadAfterBlobSha256')",
            params![self.op.workspace_id,self.op.origin_id,self.op.origin_seq,self.op.payload_json()?],|r|Ok((r.get(0)?,r.get(1)?))).optional().map_err(SyncError::corrupt)?;
        let Some((anchor, state)) = row else {
            return Ok(false);
        };
        let read = |sha: &str| -> Result<Vec<u8>, SyncError> {
            let bytes: Vec<u8> = tx
                .query_row(
                    "SELECT bytes FROM binary_blobs WHERE sha256=?1",
                    [sha],
                    |r| r.get(0),
                )
                .map_err(SyncError::corrupt)?;
            if dohc_engine_storage::hex_sha256(&bytes) != sha {
                return Err(SyncError::BlobInvalid);
            }
            Ok(bytes)
        };
        let doc = dohc_engine_collab::Ydoc::wire();
        doc.apply(&read(&anchor)?).map_err(SyncError::corrupt)?;
        let before = doc.encode_full_state();
        doc.apply(&read(&state)?).map_err(SyncError::corrupt)?;
        Ok(!doc.has_pending_dependencies() && doc.encode_full_state() == before)
    }
    pub(crate) fn check_in(&self, tx: &Transaction<'_>) -> Result<(), SyncError> {
        let op = self.op;
        self.hold.check_in(tx, true)?;
        let json:String=tx.query_row("SELECT envelope_json FROM release_held_ops WHERE workspace_id=?1 AND origin_id=?2 AND origin_seq=?3 AND release_digest=?4 AND stage='held'",
            params![op.workspace_id,op.origin_id,op.origin_seq,self.hold.digest],|r|r.get(0)).optional().map_err(SyncError::corrupt)?.ok_or(SyncError::CoordinateDiverged)?;
        let saved: ReplicationEnvelope = serde_json::from_str(&json).map_err(SyncError::corrupt)?;
        if saved != *op {
            return Err(SyncError::CoordinateDiverged);
        }
        let earlier:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM release_held_ops WHERE workspace_id=?1 AND origin_id=?2 AND origin_seq<?3 AND stage='held' AND version_id=?4 AND object_id=?5)",
            params![op.workspace_id,op.origin_id,op.origin_seq,self.hold.binding.main_version_id,self.hold.binding.object_id],|r|r.get(0)).map_err(SyncError::corrupt)?;
        if earlier {
            return Err(SyncError::SequenceGap);
        }
        Ok(())
    }
    pub(crate) fn finish_in(&self, tx: &Transaction<'_>) -> Result<(), SyncError> {
        tx.execute("DELETE FROM owner_pending_settlements WHERE workspace_id=?1 AND origin_id=?2 AND origin_seq=?3",
            params![self.op.workspace_id,self.op.origin_id,self.op.origin_seq]).map_err(SyncError::persist)?;
        tx.execute("UPDATE release_held_ops SET stage='done' WHERE workspace_id=?1 AND origin_id=?2 AND origin_seq=?3",
            params![self.op.workspace_id,self.op.origin_id,self.op.origin_seq]).map_err(SyncError::persist)?;
        Ok(())
    }
}

/// One coordinate per call. Y.Doc work transfers into its ordinary continuation.
pub fn replay_release_held_envelope(
    store: &mut EngineStore,
    cache: &mut WriterDocCache,
    op: &ReplicationEnvelope,
    faults: &dyn FaultInjector,
    leases: &dyn LeaseProbe,
    hold: &ReleaseHold,
) -> Result<ApplyOutcome<RoutedApply>, SyncError> {
    store.read_with(|conn| hold.check_in(conn, false))?;
    let completed=store.read_with(|c|c.query_row("SELECT envelope_json,stage,record_facts_json FROM release_held_ops WHERE workspace_id=?1 AND origin_id=?2 AND origin_seq=?3 AND release_digest=?4",
        params![op.workspace_id,op.origin_id,op.origin_seq,hold.digest],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,Option<String>>(2)?))).optional().map_err(SyncError::corrupt))?;
    if let Some((json, stage, facts)) = completed {
        if serde_json::from_str::<ReplicationEnvelope>(&json).map_err(SyncError::corrupt)? != *op {
            return Err(SyncError::CoordinateDiverged);
        }
        if stage != "held" {
            let refused: bool = store.read_with(|c|c.query_row("SELECT apply_disposition='refused' FROM replication_log WHERE workspace_id=?1 AND origin_id=?2 AND origin_seq=?3", params![op.workspace_id,op.origin_id,op.origin_seq], |r|r.get(0)).map_err(SyncError::corrupt))?;
            let primary = if refused {
                crate::ApplyDisposition::Refused(
                    crate::read_replayed_refusal(store, op)?.unwrap_or_else(|| {
                        crate::ReplicationRefusal {
                            workspace_id: op.workspace_id.clone(),
                            origin_id: op.origin_id.clone(),
                            origin_seq: op.origin_seq,
                            op_kind: op.op_kind.clone(),
                            reason: crate::RefusalReason::InvalidInput {
                                reason: "dohc did not apply this edit.".into(),
                            },
                        }
                    }),
                )
            } else {
                crate::ApplyDisposition::Applied(RoutedApply {
                    materialization_changes: crate::router::redelivered_materialization_changes(
                        store, op,
                    )?,
                    conflicts_opened: crate::router::redelivered_conflicts_opened(store, op)?,
                    record_facts: facts
                        .map(|s| serde_json::from_str(&s).map_err(SyncError::corrupt))
                        .transpose()?
                        .into_iter()
                        .collect(),
                    ..RoutedApply::default()
                })
            };
            return Ok(ApplyOutcome::new(primary));
        }
    }
    let permit = ReplayPermit { hold, op };
    if op.op_kind == "moment.append" {
        return crate::moment_apply::apply_moment_with_hold(
            store,
            op,
            faults,
            leases,
            None,
            Some(&permit),
        )
        .map(|outcome| {
            outcome.map(|result| RoutedApply {
                conflicts_opened: result.conflicts_opened,
                materialization_changes: result.materialization_changes,
                record_facts: result.record_facts.into_iter().collect(),
                ..RoutedApply::default()
            })
        });
    }
    if op.op_kind != "ydoc.update" {
        return Err(SyncError::UnsupportedOperation);
    }
    if op.payload["isBaseState"] == true {
        return crate::ydoc_apply::apply_ydoc_envelope_in_batch(
            store,
            cache,
            op,
            faults,
            leases,
            false,
            crate::ydoc_apply::YdocAdmission::Replay(&permit),
        )
        .map(|outcome| {
            outcome.map(|result| RoutedApply {
                conflicts_opened: result.conflicts_opened,
                record_facts: result.record_facts,
                ..RoutedApply::default()
            })
        });
    }
    let result=store.write_with(faults,|tx| {
        permit.check_in(tx)?;
        tx.execute("INSERT INTO ydoc_deferred_updates(workspace_id,version_id,object_id,origin_id,origin_seq,recorded_at_ms,lineage_claim_id,relay_seq,release_generation,release_digest)
            VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
            params![op.workspace_id,hold.binding.main_version_id,hold.binding.object_id,op.origin_id,op.origin_seq,op.recorded_at_ms,op.payload["lineageClaimId"].as_str().ok_or(SyncError::CoordinateDiverged)?,op.relay_seq,hold.binding.restore_fence_generation,hold.digest]).map_err(SyncError::persist)?;
        tx.execute("UPDATE release_held_ops SET stage='dependency' WHERE workspace_id=?1 AND origin_id=?2 AND origin_seq=?3",
            params![op.workspace_id,op.origin_id,op.origin_seq]).map_err(SyncError::persist)?;
        Ok::<_,SyncError>(())
    })?;
    Ok(ApplyOutcome::new(match result {
        dohc_engine_storage::TxnOutcome::Committed(()) => {
            crate::ApplyDisposition::Applied(RoutedApply::default())
        }
        dohc_engine_storage::TxnOutcome::Crashed { committed } => {
            crate::ApplyDisposition::Crashed { committed }
        }
    }))
}

// Each stage uses the document index. Merge at most 128 completed reports.
pub(crate) const RELEASE_HOLD_PAGE_SQL: &str = "
SELECT envelope_json FROM (
    SELECT envelope_json,arrival,0 AS rank FROM (
        SELECT envelope_json,arrival FROM release_held_ops
        WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3 AND release_digest=?4 AND stage='done'
        ORDER BY arrival LIMIT 64)
    UNION ALL
    SELECT envelope_json,arrival,0 AS rank FROM (
        SELECT envelope_json,arrival FROM release_held_ops
        WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3 AND release_digest=?4 AND stage='dependency'
        ORDER BY arrival LIMIT 64)
    UNION ALL
    SELECT envelope_json,arrival,1 AS rank FROM (
        SELECT envelope_json,arrival FROM release_held_ops
        WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3 AND release_digest=?4 AND stage='held'
        ORDER BY arrival LIMIT 64)
) ORDER BY rank,arrival LIMIT 64";

/// Recover completed reports first, then held envelopes in arrival order.
pub fn read_release_hold_page(
    store: &EngineStore,
    hold: &ReleaseHold,
) -> Result<Vec<ReplicationEnvelope>, SyncError> {
    store.read_with(|c| {
        let mut stmt = c
            .prepare(RELEASE_HOLD_PAGE_SQL)
            .map_err(SyncError::corrupt)?;
        let rows = stmt
            .query_map(
                params![
                    hold.binding.workspace_id,
                    hold.binding.main_version_id,
                    hold.binding.object_id,
                    hold.digest
                ],
                |r| r.get::<_, String>(0),
            )
            .map_err(SyncError::corrupt)?;
        rows.map(|r| {
            serde_json::from_str(&r.map_err(SyncError::corrupt)?).map_err(SyncError::corrupt)
        })
        .collect()
    })
}

/// Call after delivering the report; transferred rows keep their ordinary roots.
pub fn acknowledge_release_replay_in(
    tx: &Transaction<'_>,
    op: &ReplicationEnvelope,
) -> Result<(), SyncError> {
    let row:Option<(String,String)>=tx.query_row("SELECT envelope_json,stage FROM release_held_ops WHERE workspace_id=?1 AND origin_id=?2 AND origin_seq=?3",
        params![op.workspace_id,op.origin_id,op.origin_seq],|r|Ok((r.get(0)?,r.get(1)?))).optional().map_err(SyncError::corrupt)?;
    let Some((json, stage)) = row else {
        return Ok(());
    };
    if serde_json::from_str::<ReplicationEnvelope>(&json).map_err(SyncError::corrupt)? != *op {
        return Err(SyncError::CoordinateDiverged);
    }
    if stage == "held" {
        return Err(waiting());
    }
    if op.op_kind == "moment.append" {
        let refused:bool=tx.query_row("SELECT apply_disposition='refused' FROM replication_log WHERE workspace_id=?1 AND origin_id=?2 AND origin_seq=?3",params![op.workspace_id,op.origin_id,op.origin_seq],|r|r.get(0)).map_err(SyncError::corrupt)?;
        if refused {
            crate::moment_apply::retain_refused_moment_blobs(tx, op)?;
        }
    }
    tx.execute(
        "DELETE FROM release_held_ops WHERE workspace_id=?1 AND origin_id=?2 AND origin_seq=?3",
        params![op.workspace_id, op.origin_id, op.origin_seq],
    )
    .map_err(SyncError::persist)?;
    Ok(())
}

pub fn close_release_hold_in(tx: &Transaction<'_>, hold: &ReleaseHold) -> Result<bool, SyncError> {
    hold.check_in(tx, false)?;
    let deleted=tx.execute("DELETE FROM release_holds WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3 AND remote_closed=1
        AND NOT EXISTS(SELECT 1 FROM release_held_ops WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3)",
        params![hold.binding.workspace_id,hold.binding.main_version_id,hold.binding.object_id]).map_err(SyncError::persist)?;
    Ok(deleted == 1)
}
