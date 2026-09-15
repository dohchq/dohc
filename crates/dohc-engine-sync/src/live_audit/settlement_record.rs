use super::*;
use dohc_engine_collab::live_update_application::ApplicationHostCoordinate;

pub(super) const SETTLEMENT_OP: &str = "live.audit.settlement";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SettlementRecord {
    settlement_id: String,
    relay_database_namespace: String,
    binding: LiveObjectBinding,
    host_coordinate: ApplicationHostCoordinate,
    previous_cursor: i64,
    terminal_cursor: i64,
    previous_ydoc_sequence: i64,
    local_ydoc_sequence: i64,
    application_count: i64,
    native_interval_digest: String,
    accepted_event_count: i64,
    accepted_interval_digest: String,
    moment_id: String,
    markdown_digest: String,
    source_state_vector_digest: String,
    recorded_at_ms: i64,
    restore_operation_id: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SettlementPayload {
    format_version: u32,
    record_digest: String,
    record: SettlementRecord,
}

impl SettlementRecord {
    fn validate(&self, workspace: &str) -> Result<(), SyncError> {
        self.binding.validate_canonical().map_err(invalid)?;
        self.host_coordinate
            .validate()
            .map_err(SyncError::corrupt)?;
        crate::model::bounded(&self.moment_id, "invalid settlement moment")?;
        if let Some(operation) = &self.restore_operation_id {
            crate::model::bounded(operation, "invalid settlement restore operation")?;
        }
        if self.binding.workspace_id != workspace
            || self.relay_database_namespace.is_empty()
            || self.relay_database_namespace.len() > 1024
            || self
                .relay_database_namespace
                .bytes()
                .any(|byte| byte.is_ascii_control())
            || [
                self.previous_cursor,
                self.terminal_cursor,
                self.previous_ydoc_sequence,
                self.local_ydoc_sequence,
                self.application_count,
                self.accepted_event_count,
                self.recorded_at_ms,
            ]
            .iter()
            .any(|n| !(0..=crate::MAX_WIRE_INTEGER).contains(n))
            || self.previous_cursor > self.terminal_cursor
            || self.previous_ydoc_sequence > self.local_ydoc_sequence
            || self.application_count > self.accepted_event_count
            || [
                &self.native_interval_digest,
                &self.accepted_interval_digest,
                &self.markdown_digest,
                &self.source_state_vector_digest,
            ]
            .iter()
            .any(|value| !digest(value))
        {
            return Err(invalid("invalid historical live settlement"));
        }
        let identity = serde_json::to_vec(&(
            &self.relay_database_namespace,
            &self.binding,
            self.previous_cursor,
            self.terminal_cursor,
            self.previous_ydoc_sequence,
            self.local_ydoc_sequence,
            &self.native_interval_digest,
            &self.moment_id,
            &self.markdown_digest,
            &self.source_state_vector_digest,
        ))
        .map_err(SyncError::corrupt)?;
        if self.settlement_id != format!("live-settlement-{}", hex_sha256(&identity)) {
            return Err(invalid("historical settlement identity differs"));
        }
        Ok(())
    }

    fn payload(&self) -> Result<serde_json::Value, SyncError> {
        serde_json::to_value(SettlementPayload {
            format_version: 1,
            record_digest: hex_sha256(
                serde_json::to_string(self)
                    .map_err(SyncError::corrupt)?
                    .as_bytes(),
            ),
            record: self.clone(),
        })
        .map_err(SyncError::corrupt)
    }
}

/// Native coverage retains its device-local fingerprint. Portable coverage names
/// two endpoints of the accepted-event hash chain, which commits to every event
/// between them without scanning or copying the interval during each sync.
fn accepted_interval(
    conn: &Connection,
    namespace: &str,
    binding: &LiveObjectBinding,
    previous: i64,
    terminal: i64,
) -> Result<(i64, String), SyncError> {
    let p = scope(namespace, binding);
    let json:Option<String>=conn.query_row(&format!("SELECT record_json FROM live_audit_base_publications WHERE {SCOPE} UNION ALL SELECT record_json FROM live_audit_bases WHERE {SCOPE} LIMIT 1"),p,|row|row.get(0)).optional().map_err(SyncError::corrupt)?;
    let base: BaseRecord = serde_json::from_str(&json.ok_or(SyncError::RetryableState {
        reason: "settlement event zero is unavailable",
    })?)
    .map_err(SyncError::corrupt)?;
    base.validate(&binding.workspace_id)?;
    if scope(&base.relay_database_namespace, &base.checkpoint.binding) != p {
        return Err(invalid("settlement event zero scope differs"));
    }
    let boundary = |cursor: i64| -> Result<(i64, i64, String), SyncError> {
        if cursor == 0 {
            return Ok((0, 0, base.checkpoint.evidence_digest.clone()));
        }
        conn.query_row(&format!("SELECT event_count,journal_cursor,evidence_digest FROM live_audit_events WHERE {SCOPE} AND journal_cursor=?6"),params![p[0],p[1],p[2],p[3],p[4],cursor],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?))).optional().map_err(SyncError::corrupt)?.ok_or(SyncError::RetryableState{reason:"settlement interval boundary is unavailable"})
    };
    let start = boundary(previous)?;
    let end = boundary(terminal)?;
    let count = end
        .0
        .checked_sub(start.0)
        .filter(|count| *count >= 0)
        .ok_or_else(|| invalid("settlement interval order differs"))?;
    let bytes = serde_json::to_vec(&("live-settlement-accepted-interval-v1", p, start, end))
        .map_err(SyncError::corrupt)?;
    Ok((count, hex_sha256(&bytes)))
}

fn require_projection(conn: &Connection, sha: &str) -> Result<(), SyncError> {
    let lengths: Option<(i64, i64)> = conn
        .query_row(
            "SELECT byte_length,length(CAST(text AS BLOB)) FROM blobs WHERE sha256=?1",
            [sha],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(SyncError::corrupt)?;
    let Some((length, actual)) = lengths else {
        return Err(SyncError::BlobInvalid);
    };
    if length != actual || !(0..=dohc_engine_domain::MAX_TEXT_BYTES as i64).contains(&length) {
        return Err(SyncError::BlobInvalid);
    }
    let mut hash = Sha256::new();
    for offset in (0..length).step_by(65_536) {
        let bytes: Vec<u8> = conn
            .query_row(
                "SELECT substr(CAST(text AS BLOB),?2,?3) FROM blobs WHERE sha256=?1",
                params![sha, offset + 1, 65_536],
                |row| row.get(0),
            )
            .map_err(SyncError::corrupt)?;
        hash.update(bytes);
    }
    if dohc_engine_storage::hex(&hash.finalize()) != sha {
        return Err(SyncError::BlobInvalid);
    }
    Ok(())
}

fn require_restore_application(
    conn: &Connection,
    record: &SettlementRecord,
) -> Result<(), SyncError> {
    let Some(operation) = &record.restore_operation_id else {
        return Ok(());
    };
    let p = scope(&record.relay_database_namespace, &record.binding);
    let proof:Option<(Option<String>,Option<String>)>=conn.query_row(&format!("SELECT restore_operation_id,restore_markdown_digest FROM live_audit_events WHERE {SCOPE} AND journal_cursor=?6"),params![p[0],p[1],p[2],p[3],p[4],record.terminal_cursor],|r|Ok((r.get(0)?,r.get(1)?))).optional().map_err(SyncError::corrupt)?;
    let proof = proof.ok_or(SyncError::RetryableState {
        reason: "settlement restore application is unavailable",
    })?;
    if proof
        != (
            Some(operation.clone()),
            Some(record.markdown_digest.clone()),
        )
    {
        return Err(invalid("settlement restore provenance differs"));
    }
    Ok(())
}

fn read_native(
    conn: &Connection,
    workspace: &str,
    id: &str,
) -> Result<SettlementRecord, SyncError> {
    let mut record=conn.query_row("SELECT relay_database_namespace,binding_json,host_coordinate_json,previous_cursor,terminal_cursor,previous_ydoc_sequence,local_ydoc_sequence,application_count,interval_digest,moment_id,markdown_digest,source_state_vector_digest,recorded_at_ms,restore_operation_id FROM live_device_settlements WHERE workspace_id=?1 AND settlement_id=?2",params![workspace,id],|row|{
        let binding=serde_json::from_str(&row.get::<_,String>(1)?).map_err(|error|rusqlite::Error::FromSqlConversionFailure(1,rusqlite::types::Type::Text,Box::new(error)))?;
        let host_coordinate=serde_json::from_str(&row.get::<_,String>(2)?).map_err(|error|rusqlite::Error::FromSqlConversionFailure(2,rusqlite::types::Type::Text,Box::new(error)))?;
        Ok(SettlementRecord{settlement_id:id.into(),relay_database_namespace:row.get(0)?,binding,host_coordinate,previous_cursor:row.get(3)?,terminal_cursor:row.get(4)?,previous_ydoc_sequence:row.get(5)?,local_ydoc_sequence:row.get(6)?,application_count:row.get(7)?,native_interval_digest:row.get(8)?,accepted_event_count:0,accepted_interval_digest:String::new(),moment_id:row.get(9)?,markdown_digest:row.get(10)?,source_state_vector_digest:row.get(11)?,recorded_at_ms:row.get(12)?,restore_operation_id:row.get(13)?})
    }).map_err(SyncError::corrupt)?;
    let (count, digest) = accepted_interval(
        conn,
        &record.relay_database_namespace,
        &record.binding,
        record.previous_cursor,
        record.terminal_cursor,
    )?;
    record.accepted_event_count = count;
    record.accepted_interval_digest = digest;
    record.validate(workspace)?;
    require_restore_application(conn, &record)?;
    require_projection(conn, &record.markdown_digest)?;
    Ok(record)
}

pub fn journal_live_settlement_in_tx(
    tx: &Transaction<'_>,
    workspace: &str,
    id: &str,
    now_ms: i64,
) -> Result<Option<i64>, SyncError> {
    if !crate::workspace_replicates_with_relay_in_tx(tx, workspace)? {
        return Ok(None);
    }
    let pending:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM live_device_settlements s JOIN live_audit_pending_exports p ON p.workspace_id=s.workspace_id AND p.relay_database_namespace=s.relay_database_namespace AND p.main_version_id=s.main_version_id AND p.object_id=s.object_id AND p.lineage_claim_id=s.lineage_claim_id WHERE s.workspace_id=?1 AND s.settlement_id=?2)",params![workspace,id],|row|row.get(0)).map_err(SyncError::corrupt)?;
    if pending {
        return Ok(None);
    }
    journal_ready_in_tx(tx, workspace, id, now_ms)
}

pub(super) fn journal_ready_in_tx(
    tx: &Transaction<'_>,
    workspace: &str,
    id: &str,
    now_ms: i64,
) -> Result<Option<i64>, SyncError> {
    if !crate::workspace_replicates_with_relay_in_tx(tx, workspace)? {
        return Ok(None);
    }
    let record = read_native(tx, workspace, id)?;
    let payload = record.payload()?;
    let prior:Option<i64>=tx.query_row("SELECT origin_seq FROM live_audit_settlement_publications WHERE workspace_id=?1 AND settlement_id=?2",params![workspace,id],|row|row.get(0)).optional().map_err(SyncError::corrupt)?;
    if let Some(sequence) = prior {
        let saved:String=tx.query_row("SELECT payload_json FROM replication_log WHERE workspace_id=?1 AND origin_id=(SELECT origin_id FROM sync_identity WHERE workspace_id=?1) AND origin_seq=?2 AND op_kind=?3",params![workspace,sequence,SETTLEMENT_OP],|row|row.get(0)).map_err(SyncError::corrupt)?;
        if serde_json::from_str::<serde_json::Value>(&saved).map_err(SyncError::corrupt)? != payload
        {
            return Err(invalid("published settlement changed"));
        }
        return Ok(Some(sequence));
    }
    let sequence = journal_local_op_in_tx(tx, workspace, SETTLEMENT_OP, &payload, now_ms)?;
    tx.execute("INSERT INTO live_audit_settlement_publications(settlement_id,workspace_id,relay_database_namespace,main_version_id,object_id,lineage_claim_id,terminal_cursor,markdown_digest,origin_id,origin_seq) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,(SELECT origin_id FROM sync_identity WHERE workspace_id=?2),?9)",params![id,workspace,record.relay_database_namespace,record.binding.main_version_id,record.binding.object_id,record.binding.lineage_claim_id,record.terminal_cursor,record.markdown_digest,sequence]).map_err(SyncError::persist)?;
    Ok(Some(sequence))
}

pub(super) fn apply_settlement_envelope(
    store: &mut EngineStore,
    envelope: &ReplicationEnvelope,
    faults: &dyn FaultInjector,
) -> Result<ApplyOutcome<()>, SyncError> {
    apply_envelope_with_mutation_outcome(store, envelope, faults, |tx, op| {
        let payload: SettlementPayload = serde_json::from_value(op.payload.clone())
            .map_err(|_| invalid("invalid historical settlement payload"))?;
        if payload.format_version != 1
            || serde_json::to_value(&payload).map_err(SyncError::corrupt)? != op.payload
        {
            return Err(invalid("noncanonical historical settlement payload"));
        }
        let record = payload.record;
        record.validate(&op.workspace_id)?;
        let json = serde_json::to_string(&record).map_err(SyncError::corrupt)?;
        if hex_sha256(json.as_bytes()) != payload.record_digest {
            return Err(invalid("historical settlement digest differs"));
        }
        if accepted_interval(
            tx,
            &record.relay_database_namespace,
            &record.binding,
            record.previous_cursor,
            record.terminal_cursor,
        )? != (
            record.accepted_event_count,
            record.accepted_interval_digest.clone(),
        ) {
            return Err(invalid("historical settlement interval differs"));
        }
        require_restore_application(tx, &record)?;
        require_projection(tx, &record.markdown_digest)?;
        let prior: Option<String> = tx
            .query_row(
                "SELECT record_digest FROM live_audit_settlements WHERE settlement_id=?1",
                [&record.settlement_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(SyncError::corrupt)?;
        if let Some(prior) = prior {
            if prior == payload.record_digest {
                return Ok(MutationOutcome::Applied(()));
            }
            tx.execute("INSERT INTO live_audit_settlement_conflicts(workspace_id,origin_id,origin_seq,record_digest,record_json,markdown_digest) VALUES (?1,?2,?3,?4,?5,?6)",params![op.workspace_id,op.origin_id,op.origin_seq,payload.record_digest,json,record.markdown_digest]).map_err(SyncError::persist)?;
            return Ok(MutationOutcome::RefusedRetainingMutation {
                reason: "historical settlement identity contains different evidence".into(),
            });
        }
        tx.execute("INSERT INTO live_audit_settlements(settlement_id,workspace_id,record_digest,record_json,markdown_digest) VALUES (?1,?2,?3,?4,?5)",params![record.settlement_id,op.workspace_id,payload.record_digest,json,record.markdown_digest]).map_err(SyncError::persist)?;
        Ok(MutationOutcome::Applied(()))
    })
}
