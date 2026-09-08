use super::*;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum RestoreDeliveryOrigin {
    Bootstrap { id: String },
    Owner { id: String },
}

/// Supplied by an authenticated operation adapter after relay old-cut ACK.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeRestoreFence {
    pub operation_id: String,
    pub relay_database_namespace: String,
    pub old_binding: LiveObjectBinding,
    pub host_id: String,
    pub new_fence: i64,
    pub origin: RestoreDeliveryOrigin,
    pub terminal: Option<LiveUpdateReceipt>,
    pub applied_sequence: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeRestoreFenceReceipt {
    pub operation: NativeRestoreFence,
    pub local_head_sequence: i64,
    pub recorded_at_ms: i64,
}

pub(crate) fn require_open(conn: &Connection, key: &DocKey) -> Result<(), CollabError> {
    let stopped: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM live_restore_fences WHERE workspace_id=?1 AND main_version_id=?2 AND object_id=?3)",
        params![key.workspace_id, key.version_id, key.object_id], |r| r.get(0),
    ).map_err(|e| CollabError::Storage(StorageError::corrupt_public(e)))?;
    if stopped {
        Err(CollabError::RestoreFenced)
    } else {
        Ok(())
    }
}

impl NativeRestoreFence {
    fn validate(&self) -> Result<(), ApplicationError> {
        identifier(&self.operation_id, 512)?;
        identifier(&self.relay_database_namespace, 512)?;
        identifier(&self.host_id, 1024)?;
        self.old_binding.validate_canonical().map_err(invalid)?;
        integer(self.old_binding.restore_fence_generation, 0, SAFE - 1)?;
        if self.new_fence != self.old_binding.restore_fence_generation + 1 {
            return Err(ApplicationError::Conflict);
        }
        integer(self.applied_sequence, 0, SAFE)?;
        let id = match &self.origin {
            RestoreDeliveryOrigin::Bootstrap { id } | RestoreDeliveryOrigin::Owner { id } => id,
        };
        identifier(id, 512)?;
        if let Some(terminal) = &self.terminal {
            terminal.validate()?;
        }
        Ok(())
    }
}

fn marker(
    conn: &Connection,
    binding: &LiveObjectBinding,
) -> Result<durable::Marker, ApplicationError> {
    let key = DocKey::new(
        &binding.workspace_id,
        &binding.main_version_id,
        &binding.object_id,
    )?;
    let marker = durable::read_marker_in(conn, &key)?.ok_or(ApplicationError::Conflict)?;
    if marker.regime != Regime::Replicated
        || marker.content_kind != crate::ContentKind::Richdoc
        || marker.lineage_claim_status != durable::LineageClaimStatus::Exact
        || marker.lineage_claim_id.as_deref() != Some(&binding.lineage_claim_id)
        || marker.path.as_deref() != Some(&binding.current_path)
    {
        return Err(ApplicationError::Conflict);
    }
    Ok(marker)
}

fn applied_tip(
    conn: &Connection,
    held: &Registration,
    input: &NativeRestoreFence,
) -> Result<(Option<LiveUpdateReceipt>, i64), ApplicationError> {
    let b = &held.binding;
    let origin = match &input.origin {
        RestoreDeliveryOrigin::Bootstrap { id } => {
            if adoption::read_origin(conn, held)?.is_some() {
                return Err(ApplicationError::Conflict);
            }
            let (bootstrap, binding, coordinate, sequence) =
                bootstrap::read_bootstrap(conn, held)?.ok_or(ApplicationError::Conflict)?;
            bootstrap.validate()?;
            settlement::validate_historical_binding(&binding, b)?;
            if bootstrap.bootstrap_id != *id || coordinate.host_id != input.host_id {
                return Err(ApplicationError::Conflict);
            }
            (None, sequence)
        }
        RestoreDeliveryOrigin::Owner { id } => {
            let origin = adoption::read_origin(conn, held)?.ok_or(ApplicationError::Conflict)?;
            let (saved_id, host): (String, String) = conn.query_row(
                "SELECT adoption_id,host_coordinate_json FROM live_owner_adoptions WHERE relay_database_namespace=?1 AND workspace_id=?2 AND main_version_id=?3 AND object_id=?4 AND lineage_claim_id=?5",
                params![held.namespace,b.workspace_id,b.main_version_id,b.object_id,b.lineage_claim_id],
                |r| Ok((r.get(0)?,r.get(1)?)),
            ).map_err(read_sql)?;
            let host: ApplicationHostCoordinate =
                serde_json::from_str(&host).map_err(|_| ApplicationError::Corrupt)?;
            host.validate()?;
            if saved_id != *id || host.host_id != input.host_id {
                return Err(ApplicationError::Conflict);
            }
            (origin.terminal, origin.sequence)
        }
    };
    let latest: Option<LiveUpdateReceipt> = conn.query_row(
        "SELECT delivery_id,update_digest,journal_cursor,accepting_host_epoch FROM live_device_update_applications WHERE relay_database_namespace=?1 AND workspace_id=?2 AND main_version_id=?3 AND object_id=?4 AND lineage_claim_id=?5 ORDER BY journal_cursor DESC LIMIT 1",
        params![held.namespace,b.workspace_id,b.main_version_id,b.object_id,b.lineage_claim_id],
        |r| Ok(LiveUpdateReceipt {delivery_id:r.get(0)?,update_digest:r.get(1)?,journal_cursor:r.get(2)?,accepting_host_epoch:r.get(3)?}),
    ).optional().map_err(read_sql)?;
    let Some(terminal) =
        latest.filter(|r| r.journal_cursor > origin.0.as_ref().map_or(0, |r| r.journal_cursor))
    else {
        return Ok(origin);
    };
    let record =
        read_application(conn, &held.namespace, &terminal)?.ok_or(ApplicationError::Corrupt)?;
    settlement::validate_historical_binding(&record.event.metadata.accepted.binding, b)?;
    if record.event.metadata.accepted.receipt != terminal
        || record.coordinate.host_id != input.host_id
    {
        return Err(ApplicationError::Corrupt);
    }
    Ok((Some(terminal), record.sequence))
}

impl ApplicationOwner {
    /// Replays need no ordinary registration, which stays refused after restart.
    pub fn fence_restore(
        &mut self,
        store: &mut EngineStore,
        input: NativeRestoreFence,
        coordinate: ApplicationHostCoordinate,
        now_ms: i64,
        faults: &dyn FaultInjector,
    ) -> Result<NativeRestoreFenceReceipt, ApplicationError> {
        input.validate()?;
        coordinate.validate()?;
        integer(now_ms, 0, SAFE)?;
        if input.host_id != coordinate.host_id {
            return Err(ApplicationError::Conflict);
        }
        validate_application_binding(store, &self.workspace_id, &input.old_binding)?;
        let b = &input.old_binding;
        let held = Registration {
            workspace_id: self.workspace_id.clone(),
            namespace: input.relay_database_namespace.clone(),
            coordinate,
            binding: b.clone(),
            live: true,
        };
        let input_json = serde_json::to_string(&input).map_err(|_| ApplicationError::Corrupt)?;
        let outcome = store.write_with(faults, |tx| {
            require_workspace(tx, &held)?;
            let saved: Option<(String, String)> = tx.query_row(
                "SELECT input_json,receipt_json FROM live_restore_fences WHERE workspace_id=?1 AND main_version_id=?2 AND object_id=?3",
                params![b.workspace_id,b.main_version_id,b.object_id],
                |r| Ok((r.get(0)?,r.get(1)?)),
            ).optional().map_err(read_sql)?;
            if let Some((saved_input, receipt)) = saved {
                if saved_input != input_json { return Err(ApplicationError::Conflict); }
                let receipt: NativeRestoreFenceReceipt = serde_json::from_str(&receipt).map_err(|_| ApplicationError::Corrupt)?;
                if receipt.operation != input || receipt.local_head_sequence < input.applied_sequence {
                    return Err(ApplicationError::Corrupt);
                }
                integer(receipt.local_head_sequence, 0, SAFE)?;
                integer(receipt.recorded_at_ms, 0, SAFE)?;
                let mut stopped = b.clone();
                stopped.restore_fence_generation = input.new_fence;
                if !read_binding(tx, &held)?.is_some_and(|(binding, coordinate, available)| {
                    binding == stopped && coordinate.host_id == input.host_id && !available
                }) || marker(tx, b)?.head_update_seq != receipt.local_head_sequence {
                    return Err(ApplicationError::Corrupt);
                }
                return Ok(receipt);
            }
            let collision: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM live_restore_fences WHERE relay_database_namespace=?1 AND operation_id=?2)",
                params![held.namespace,input.operation_id], |r| r.get(0),
            ).map_err(read_sql)?;
            if collision { return Err(ApplicationError::Conflict); }
            if !read_binding(tx, &held)?.is_some_and(|(binding, coordinate, available)| {
                binding == *b && coordinate == held.coordinate && available
            }) {
                return Err(ApplicationError::Interrupted);
            }
            let marker = marker(tx, b)?;
            let (terminal, sequence) = applied_tip(tx, &held, &input)?;
            if terminal != input.terminal || sequence != input.applied_sequence || marker.head_update_seq < sequence {
                return Err(ApplicationError::Conflict);
            }
            let receipt = NativeRestoreFenceReceipt {
                operation: input.clone(),
                local_head_sequence: marker.head_update_seq,
                recorded_at_ms: now_ms,
            };
            tx.execute(
                "INSERT INTO live_restore_fences VALUES(?1,?2,?3,?4,?5,?6,?7)",
                params![b.workspace_id,b.main_version_id,b.object_id,held.namespace,input.operation_id,input_json,serde_json::to_string(&receipt).map_err(|_| ApplicationError::Corrupt)?],
            ).map_err(write_sql)?;
            let changed = tx.execute(
                "UPDATE live_device_application_bindings SET available=0,restore_fence_generation=?5 WHERE relay_database_namespace=?1 AND workspace_id=?2 AND main_version_id=?3 AND object_id=?4",
                params![held.namespace,b.workspace_id,b.main_version_id,b.object_id,input.new_fence],
            ).map_err(write_sql)?;
            if changed != 1 { return Err(ApplicationError::Corrupt); }
            let mut observed = b.clone();
            observed.restore_fence_generation = input.new_fence;
            tx.execute(
                "UPDATE owner_ydoc_outboxes SET state='quarantined',quarantine_reason='restore-fenced',observed_binding_json=?5 WHERE workspace_id=?1 AND main_version_id=?2 AND object_id=?3 AND lineage_claim_id=?4 AND state!='quarantined'",
                params![b.workspace_id,b.main_version_id,b.object_id,b.lineage_claim_id,serde_json::to_string(&observed).map_err(|_| ApplicationError::Corrupt)?],
            ).map_err(write_sql)?;
            Ok(receipt)
        })?;
        for current in &self.current {
            let mut current = current.lock().map_err(|_| ApplicationError::Interrupted)?;
            if current.binding.main_version_id == b.main_version_id
                && current.binding.object_id == b.object_id
            {
                current.live = false;
            }
        }
        match outcome {
            TxnOutcome::Committed(receipt) => Ok(receipt),
            TxnOutcome::Crashed { .. } => Err(ApplicationError::Interrupted),
        }
    }
}
