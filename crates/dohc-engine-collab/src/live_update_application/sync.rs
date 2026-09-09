use super::*;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppliedPosition {
    pub event_count: i64,
    pub journal_cursor: i64,
    pub evidence_digest: String,
}
impl AppliedPosition {
    pub fn validate(&self) -> Result<(), ApplicationError> {
        integer(self.event_count, 0, SAFE)?;
        integer(self.journal_cursor, 0, SAFE)?;
        digest(&self.evidence_digest)?;
        if (self.event_count == 0) != (self.journal_cursor == 0) {
            return Err(invalid("invalid applied position"));
        }
        Ok(())
    }
}

/// Explicit admission bounds, not a hard heap or preemptible CPU limit.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppliedSyncPolicy {
    pub max_client_vector_bytes: usize,
    pub max_host_vector_bytes: usize,
    pub max_output_bytes: usize,
    pub max_read_bytes: usize,
}
impl AppliedSyncPolicy {
    pub fn validate(&self) -> Result<(), ApplicationError> {
        if [
            self.max_client_vector_bytes,
            self.max_host_vector_bytes,
            self.max_output_bytes,
            self.max_read_bytes,
        ]
        .iter()
        .any(|n| *n == 0 || *n as u128 > SAFE as u128)
            || self.max_client_vector_bytes > self.max_read_bytes
            || self.max_host_vector_bytes > self.max_output_bytes
        {
            return Err(invalid("invalid applied sync policy"));
        }
        Ok(())
    }
}
#[derive(Debug)]
pub struct AppliedSyncCut {
    pub binding: LiveObjectBinding,
    pub position: AppliedPosition,
    pub observed_local_ydoc_head_sequence: i64,
    pub host_vector: Vec<u8>,
    pub missing_state_update: Vec<u8>,
}
#[derive(Debug)]
pub struct NextAppliedUpdate {
    pub position: AppliedPosition,
    pub ack: LiveUpdateHostApplicationAck,
    pub update_bytes: Vec<u8>,
}

pub(super) fn current(conn: &Connection, held: &Registration) -> Result<durable::Marker, ApplicationError> {
    if !held.live {
        return Err(ApplicationError::Interrupted);
    }
    require_workspace(conn, held)?;
    let b = &held.binding;
    if !read_binding(conn, held)?.is_some_and(|(binding, coordinate, available)| {
        available && binding == *b && coordinate == held.coordinate
    }) {
        return Err(ApplicationError::Interrupted);
    }
    let key = DocKey::new(&b.workspace_id, &b.main_version_id, &b.object_id)?;
    restore_fence::require_registration(conn, &key, &held.namespace, b)?;
    let marker = durable::read_marker_in(conn, &key)?.ok_or(ApplicationError::Conflict)?;
    if marker.regime != Regime::Replicated
        || marker.content_kind != crate::ContentKind::Richdoc
        || marker.lineage_claim_status != durable::LineageClaimStatus::Exact
        || marker.lineage_claim_id.as_deref() != Some(&b.lineage_claim_id)
        || marker.path.as_deref() != Some(&b.current_path)
    {
        return Err(ApplicationError::Conflict);
    }
    Ok(marker)
}
fn check_cancel(check: &impl Fn() -> bool) -> Result<(), ApplicationError> {
    if check() {
        Ok(())
    } else {
        Err(ApplicationError::Interrupted)
    }
}

/// One native applied-only cut. Owner-local outbox bytes are absent until admitted.
pub fn read_applied_sync(
    store: &EngineStore,
    handle: &ApplicationHandle,
    client_vector: &[u8],
    policy: AppliedSyncPolicy,
    is_current: impl Fn() -> bool,
) -> Result<AppliedSyncCut, ApplicationError> {
    policy.validate()?;
    if client_vector.is_empty() || client_vector.len() > policy.max_client_vector_bytes {
        return Err(ApplicationError::ConfiguredByteBudgetExceeded);
    }
    check_cancel(&is_current)?;
    let held = handle
        .registration
        .lock()
        .map_err(|_| ApplicationError::Interrupted)?;
    store.read_with(|conn| {
        let read_tx = conn.unchecked_transaction().map_err(read_sql)?;
        let conn = &*read_tx;
        let marker = current(conn, &held)?;
        let terminal = settlement::latest_receipt(conn, &held)?;
        let through = terminal.as_ref().map_or(0, |r| r.journal_cursor);
        let mut budget = restore_content::Budget {
            remaining: policy.max_read_bytes,
        };
        budget.charge(client_vector.len())?;
        let history = accepted_history::read_inner(
            conn,
            &held,
            through,
            &mut budget,
            accepted_history::CHECKPOINT_EVENTS as usize,
            false,
        )?;
        check_cancel(&is_current)?;
        let host_vector = history
            .doc
            .encode_state_vector_bounded(policy.max_host_vector_bytes)
            .ok_or(ApplicationError::ConfiguredByteBudgetExceeded)?;
        let missing_state_update = history
            .doc
            .diff_bounded(
                client_vector,
                policy
                    .max_output_bytes
                    .saturating_sub(host_vector.len())
                    .min(crate::limits::MAX_YDOC_UPDATE_BYTES),
            )?
            .ok_or(ApplicationError::ConfiguredByteBudgetExceeded)?;
        check_cancel(&is_current)?;
        let position = AppliedPosition {
            event_count: history.proof.event_count,
            journal_cursor: through,
            evidence_digest: history.proof.evidence_digest,
        };
        position.validate()?;
        Ok(AppliedSyncCut {
            binding: held.binding.clone(),
            position,
            observed_local_ydoc_head_sequence: marker.head_update_seq,
            host_vector,
            missing_state_update,
        })
    })
}

/// A repeatable single-event read; no subscription or compaction pin is created.
pub fn read_next_applied(
    store: &EngineStore,
    handle: &ApplicationHandle,
    after: &AppliedPosition,
    policy: AppliedSyncPolicy,
    is_current: impl Fn() -> bool,
) -> Result<Option<NextAppliedUpdate>, ApplicationError> {
    policy.validate()?;
    after.validate()?;
    check_cancel(&is_current)?;
    let held = handle
        .registration
        .lock()
        .map_err(|_| ApplicationError::Interrupted)?;
    store.read_with(|conn| {
        let read_tx=conn.unchecked_transaction().map_err(read_sql)?;
        let conn=&*read_tx;
        let marker = current(conn, &held)?;
        let b = &held.binding;
        let has_checkpoint: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM live_accepted_checkpoints WHERE relay_database_namespace=?1 AND workspace_id=?2 AND main_version_id=?3 AND object_id=?4 AND lineage_claim_id=?5)",params![held.namespace,b.workspace_id,b.main_version_id,b.object_id,b.lineage_claim_id],|r|r.get(0)).map_err(read_sql)?;
        if !has_checkpoint {return Err(ApplicationError::Conflict)}
        let p = params![held.namespace,b.workspace_id,b.main_version_id,b.object_id,b.lineage_claim_id,after.event_count];
        if after.event_count == 0 {
            if after.evidence_digest != accepted_history::initial_digest(&held)? {return Err(ApplicationError::Conflict)}
        } else {
            let saved: Option<(i64,String)> = conn.query_row("SELECT journal_cursor,evidence_digest FROM live_accepted_updates WHERE relay_database_namespace=?1 AND workspace_id=?2 AND main_version_id=?3 AND object_id=?4 AND lineage_claim_id=?5 AND event_count=?6",p,|r|Ok((r.get(0)?,r.get(1)?))).optional().map_err(read_sql)?;
            if saved != Some((after.journal_cursor, after.evidence_digest.clone())) {return Err(ApplicationError::Conflict)}
        }
        let next: Option<(i64,i64,String,String)> = conn.query_row("SELECT event_count,journal_cursor,delivery_id,evidence_digest FROM live_accepted_updates WHERE relay_database_namespace=?1 AND workspace_id=?2 AND main_version_id=?3 AND object_id=?4 AND lineage_claim_id=?5 AND event_count>?6 ORDER BY event_count LIMIT 1",p,|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional().map_err(read_sql)?;
        let Some((count,cursor,delivery,evidence_digest)) = next else {
            if settlement::latest_receipt(conn,&held)?.as_ref().map_or(0,|r|r.journal_cursor) != after.journal_cursor {return Err(ApplicationError::Corrupt)}
            check_cancel(&is_current)?;
            return Ok(None)
        };
        if count != after.event_count.checked_add(1).ok_or(ApplicationError::Corrupt)? || cursor <= after.journal_cursor {return Err(ApplicationError::Corrupt)}
        let mut budget = restore_content::Budget {remaining:policy.max_read_bytes};
        let metadata = accepted_history::accepted_source(conn,&held,&delivery,&mut budget)?.ok_or(ApplicationError::Corrupt)?;
        settlement::validate_historical_binding(&metadata.accepted.binding,&held.binding)?;
        if metadata.accepted.receipt.journal_cursor != cursor {return Err(ApplicationError::Corrupt)}
        let receipt = &metadata.accepted.receipt;
        let row: Option<(i64,bool)> = conn.query_row("SELECT local_ydoc_sequence, journal_cursor=?3 AND update_digest=?4 AND accepting_host_epoch=?5 AND update_byte_length=(SELECT byte_length FROM binary_blobs WHERE sha256=?4) FROM live_device_update_applications WHERE relay_database_namespace=?1 AND delivery_id=?2 AND workspace_id=?6 AND main_version_id=?7 AND object_id=?8 AND lineage_claim_id=?9 AND current_path=?10 AND restore_fence_generation=?11 AND selector_paths_json=?12",params![held.namespace,delivery,cursor,receipt.update_digest,receipt.accepting_host_epoch,b.workspace_id,b.main_version_id,b.object_id,b.lineage_claim_id,b.current_path,b.restore_fence_generation,serde_json::to_string(&metadata.accepted.binding.selector_paths).map_err(|_|ApplicationError::Corrupt)?],|r|Ok((r.get(0)?,r.get(1)?))).optional().map_err(read_sql)?;
        let (sequence,true) = row.ok_or(ApplicationError::Corrupt)? else {return Err(ApplicationError::Corrupt)};
        integer(sequence,1,marker.head_update_seq).map_err(|_|ApplicationError::Corrupt)?;
        let length: i64 = conn.query_row("SELECT length(bytes) FROM binary_blobs WHERE sha256=?1",[&receipt.update_digest],|r|r.get(0)).map_err(read_sql)?;
        if usize::try_from(length).map_err(|_|ApplicationError::Corrupt)? > policy.max_output_bytes {return Err(ApplicationError::ConfiguredByteBudgetExceeded)}
        let update_bytes = budget.blob(conn,&receipt.update_digest)?;
        check_cancel(&is_current)?;
        Ok(Some(NextAppliedUpdate {position:AppliedPosition {event_count:count,journal_cursor:cursor,evidence_digest},
            ack:LiveUpdateHostApplicationAck::new(receipt,sequence,true),update_bytes}))
    })
}
