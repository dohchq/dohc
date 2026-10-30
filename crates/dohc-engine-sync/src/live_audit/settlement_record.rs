use super::*;
use dohc_engine_collab::live_update_application::ApplicationHostCoordinate;
use dohc_engine_storage::text;

pub(super) const SETTLEMENT_OP: &str = "live.audit.settlement";

/// Imported audit identifies history; the authenticated owner binding supplies
/// the accepted cursor against which its publication is checked.
pub(crate) fn owner_settlement_cursor_in(
    conn: &Connection,
    owner: &dohc_engine_collab::owner_outbox::draft::OwnerDraftDescriptor,
    moment_id: &str,
    markdown_digest: &str,
) -> Result<Option<i64>, SyncError> {
    let mut stmt = conn
        .prepare(
            "SELECT json_extract(record_json,'$.binding'),json_extract(record_json,'$.terminalCursor')
             FROM live_audit_settlements
             WHERE workspace_id=?1 AND json_extract(record_json,'$.momentId')=?2 AND markdown_digest=?3
               AND json_extract(record_json,'$.relayDatabaseNamespace')=?4
             ORDER BY json_extract(record_json,'$.terminalCursor')",
        )
        .map_err(SyncError::corrupt)?;
    let mut rows = stmt
        .query(params![
            owner.binding.workspace_id,
            moment_id,
            markdown_digest,
            owner.relay_database_namespace,
        ])
        .map_err(SyncError::corrupt)?;
    while let Some(row) = rows.next().map_err(SyncError::corrupt)? {
        let binding: LiveObjectBinding =
            serde_json::from_str(&row.get::<_, String>(0).map_err(SyncError::corrupt)?)
                .map_err(SyncError::corrupt)?;
        if binding == owner.binding {
            return row.get(1).map(Some).map_err(SyncError::corrupt);
        }
    }
    Ok(None)
}

/// An audited settlement at a later restore generation of the owner's binding.
/// It shows only that the owner has not yet observed that generation, so the
/// moment waits for the authenticated binding to reach it.
pub(crate) fn restore_successor_settlement_in(
    conn: &Connection,
    owner: &dohc_engine_collab::owner_outbox::draft::OwnerDraftDescriptor,
    moment_id: &str,
    markdown_digest: &str,
) -> Result<Option<(LiveObjectBinding, i64)>, SyncError> {
    let mut stmt = conn
        .prepare(
            "SELECT json_extract(record_json,'$.binding'),json_extract(record_json,'$.terminalCursor')
             FROM live_audit_settlements
             WHERE workspace_id=?1 AND json_extract(record_json,'$.momentId')=?2 AND markdown_digest=?3
               AND json_extract(record_json,'$.relayDatabaseNamespace')=?4
               AND json_extract(record_json,'$.binding.restoreFenceGeneration')>?5
             ORDER BY json_extract(record_json,'$.terminalCursor')",
        )
        .map_err(SyncError::corrupt)?;
    let mut rows = stmt
        .query(params![
            owner.binding.workspace_id,
            moment_id,
            markdown_digest,
            owner.relay_database_namespace,
            owner.binding.restore_fence_generation
        ])
        .map_err(SyncError::corrupt)?;
    while let Some(row) = rows.next().map_err(SyncError::corrupt)? {
        let binding: LiveObjectBinding =
            serde_json::from_str(&row.get::<_, String>(0).map_err(SyncError::corrupt)?)
                .map_err(SyncError::corrupt)?;
        if dohc_engine_collab::owner_outbox::enrollment::restore_successor(&owner.binding, &binding)
        {
            return Ok(Some((binding, row.get(1).map_err(SyncError::corrupt)?)));
        }
    }
    Ok(None)
}

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
    accepted_state_blob_sha256: String,
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
                &self.accepted_state_blob_sha256,
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
                serde_json::to_vec(&serde_json::to_value(self).map_err(SyncError::corrupt)?)
                    .map_err(SyncError::corrupt)?
                    .as_slice(),
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
    let lengths: Option<(i64, i64)> = text::lengths(conn, sha)
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
        let bytes: Vec<u8> =
            text::byte_range(conn, sha, offset + 1, 65_536).map_err(SyncError::corrupt)?;
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

fn read_native_metadata(
    conn: &Connection,
    workspace: &str,
    id: &str,
) -> Result<SettlementRecord, SyncError> {
    let record=conn.query_row("SELECT relay_database_namespace,binding_json,host_coordinate_json,previous_cursor,terminal_cursor,previous_ydoc_sequence,local_ydoc_sequence,application_count,interval_digest,moment_id,markdown_digest,source_state_vector_digest,recorded_at_ms,restore_operation_id FROM live_device_settlements WHERE workspace_id=?1 AND settlement_id=?2",params![workspace,id],|row|{
        let binding=serde_json::from_str(&row.get::<_,String>(1)?).map_err(|error|rusqlite::Error::FromSqlConversionFailure(1,rusqlite::types::Type::Text,Box::new(error)))?;
        let host_coordinate=serde_json::from_str(&row.get::<_,String>(2)?).map_err(|error|rusqlite::Error::FromSqlConversionFailure(2,rusqlite::types::Type::Text,Box::new(error)))?;
        Ok(SettlementRecord{settlement_id:id.into(),relay_database_namespace:row.get(0)?,binding,host_coordinate,previous_cursor:row.get(3)?,terminal_cursor:row.get(4)?,previous_ydoc_sequence:row.get(5)?,local_ydoc_sequence:row.get(6)?,application_count:row.get(7)?,native_interval_digest:row.get(8)?,accepted_event_count:0,accepted_interval_digest:String::new(),moment_id:row.get(9)?,markdown_digest:row.get(10)?,source_state_vector_digest:row.get(11)?,accepted_state_blob_sha256:String::new(),recorded_at_ms:row.get(12)?,restore_operation_id:row.get(13)?})
    }).map_err(SyncError::corrupt)?;
    record.binding.validate_canonical().map_err(invalid)?;
    Ok(record)
}

fn read_native(
    conn: &Connection,
    workspace: &str,
    id: &str,
) -> Result<SettlementRecord, SyncError> {
    let mut record = read_native_metadata(conn, workspace, id)?;
    let (count, digest) = accepted_interval(
        conn,
        &record.relay_database_namespace,
        &record.binding,
        record.previous_cursor,
        record.terminal_cursor,
    )?;
    record.accepted_state_blob_sha256 = conn.query_row(
        "SELECT state_blob_sha256 FROM live_settlement_publication_states WHERE settlement_id=?1",
        [id], |row| row.get(0),
    ).map_err(SyncError::corrupt)?;
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
    let unavailable:Option<String>=tx.query_row("SELECT moment_id FROM live_device_settlements s WHERE s.workspace_id=?1 AND s.settlement_id=?2 AND NOT EXISTS(SELECT 1 FROM live_settlement_publication_states p WHERE p.settlement_id=s.settlement_id)",params![workspace,id],|r|r.get(0)).optional().map_err(SyncError::corrupt)?;
    if let Some(moment) = unavailable {
        let terminal: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM live_settlement_attribution_unavailable WHERE workspace_id=?1 AND moment_id=?2 AND settlement_id=?3 AND reason='terminal-owner-source')",params![workspace,moment,id],|r|r.get(0)).map_err(SyncError::corrupt)?;
        let before = if terminal {
            publication_source_before_in_tx(tx, &read_native_metadata(tx, workspace, id)?)?
        } else {
            None
        };
        return crate::outbound::journal_saved_settlement_moment_in_tx(
            tx,
            workspace,
            &moment,
            before.as_ref(),
        )
        .map(Some);
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
    let published: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM replication_log WHERE workspace_id=?1 AND op_kind='moment.append' AND json_extract(payload_json,'$.momentId')=?2)",
        params![workspace, record.moment_id], |row| row.get(0),
    ).map_err(SyncError::corrupt)?;
    if !published {
        match publication_source_before_in_tx(tx, &record)? {
            Some(before) => crate::outbound::journal_moment_append_from_in_tx(
                tx,
                workspace,
                &record.moment_id,
                &before,
            )?,
            None => crate::journal_moment_append_in_tx(tx, workspace, &record.moment_id)?,
        }
        tx.execute(
        "UPDATE replication_log SET payload_json=json_set(json_remove(payload_json,'$.authors','$.attributionUnavailable'),'$.settlementReference',json(?3)) WHERE workspace_id=?1 AND op_kind='moment.append' AND json_extract(payload_json,'$.momentId')=?2 AND imported=0",
        params![workspace,record.moment_id,serde_json::to_string(&payload).map_err(SyncError::corrupt)?],
        ).map_err(SyncError::persist)?;
    }
    Ok(Some(sequence))
}

/// At cursor 0, publication starts at the admitted source. The local moment
/// keeps the actual prior file for rollback.
fn publication_source_before_in_tx(
    tx: &Transaction<'_>,
    record: &SettlementRecord,
) -> Result<Option<crate::outbound::PortableBefore>, SyncError> {
    if record.restore_operation_id.is_some() {
        return Ok(None);
    }
    let b = &record.binding;
    if record.previous_cursor == 0
        && let origin_record::OriginRecord::Bootstrap { source, .. } =
            origin_record::read(tx, &record.relay_database_namespace, b)?
    {
        source.validate().map_err(SyncError::corrupt)?;
        return tx.query_row(
            concat!("SELECT m.moment_id,m.version_id,m.object_id,m.path,m.after_blob_sha256,t.byte_length,m.recorded_at_ms,m.metadata_origin,m.metadata_summary,m.metadata_correlation_id
             FROM moments m JOIN blobs t ON t.sha256=m.after_blob_sha256
             WHERE ", dohc_engine_domain::exclude_capture_recovery_sql!("m"), " AND m.workspace_id=?1 AND m.version_id=?2 AND m.object_id=?3 AND m.path=?4
               AND m.moment_id=?5 AND m.after_content_kind='text' AND m.after_blob_sha256=?6
               AND t.byte_length=?7 AND m.recorded_at_ms=?8 AND m.metadata_origin='sync'"),
            params![b.workspace_id,b.main_version_id,b.object_id,b.current_path,
                source.bootstrap_moment_id,source.projected_markdown_digest,
                source.projected_markdown_byte_length,source.baseline_registered_at_ms],
            portable_before_from_row,
        ).map(Some).map_err(SyncError::corrupt);
    }
    if record.previous_cursor == 0
        && let Some(before) = imported_event_zero_before_in_tx(tx, record)?
    {
        return Ok(Some(before));
    }
    // An unavailable interval does not advance the relay's verified chain.
    // The next proof starts at its prior accepted cut and names that artifact.
    let skipped: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM live_device_settlements s JOIN live_settlement_attribution_unavailable u ON u.workspace_id=s.workspace_id AND u.settlement_id=s.settlement_id WHERE s.workspace_id=?1 AND s.relay_database_namespace=?2 AND s.main_version_id=?3 AND s.object_id=?4 AND s.lineage_claim_id=?5 AND s.terminal_cursor>?6 AND s.terminal_cursor<?7)",params![b.workspace_id,record.relay_database_namespace,b.main_version_id,b.object_id,b.lineage_claim_id,record.previous_cursor,record.terminal_cursor],|r|r.get(0)).map_err(SyncError::corrupt)?;
    if skipped && record.previous_cursor > 0 {
        let accepted = tx.query_row(concat!("SELECT m.moment_id,m.version_id,m.object_id,m.path,m.after_blob_sha256,t.byte_length,m.recorded_at_ms,m.metadata_origin,m.metadata_summary,m.metadata_correlation_id FROM live_device_settlements s JOIN live_settlement_publication_states p USING(settlement_id) JOIN moments m ON ", dohc_engine_domain::exclude_capture_recovery_sql!("m"), " AND m.workspace_id=s.workspace_id AND m.moment_id=s.moment_id JOIN blobs t ON t.sha256=s.markdown_digest WHERE s.workspace_id=?1 AND s.relay_database_namespace=?2 AND s.main_version_id=?3 AND s.object_id=?4 AND s.lineage_claim_id=?5 AND s.terminal_cursor=?6 AND m.after_blob_sha256=s.markdown_digest"),params![b.workspace_id,record.relay_database_namespace,b.main_version_id,b.object_id,b.lineage_claim_id,record.previous_cursor],portable_before_from_row).optional().map_err(SyncError::corrupt)?;
        if let Some(before) = accepted {
            return Ok(Some(before));
        }
        // An empty handover writes the cut but leaves no settlement row.
        // The first unavailable interval from that exact cut kept its preimage.
        let moment: String = tx
            .query_row(
                "SELECT s.moment_id FROM live_owner_activations a
             JOIN live_device_settlements s ON s.relay_database_namespace=a.relay_database_namespace
               AND s.workspace_id=a.workspace_id AND s.main_version_id=a.main_version_id
               AND s.object_id=a.object_id AND s.lineage_claim_id=a.lineage_claim_id
               AND s.binding_json=a.binding_json AND s.previous_cursor=a.terminal_cursor
             JOIN live_settlement_attribution_unavailable u ON u.workspace_id=s.workspace_id
               AND u.settlement_id=s.settlement_id AND u.moment_id=s.moment_id
             WHERE a.workspace_id=?1 AND a.relay_database_namespace=?2 AND a.main_version_id=?3
               AND a.object_id=?4 AND a.lineage_claim_id=?5 AND a.terminal_cursor=?6
               AND a.evidence_digest IS NOT NULL AND a.binding_json=?7 AND s.terminal_cursor<?8
             ORDER BY s.terminal_cursor LIMIT 1",
                params![
                    b.workspace_id,
                    record.relay_database_namespace,
                    b.main_version_id,
                    b.object_id,
                    b.lineage_claim_id,
                    record.previous_cursor,
                    serde_json::to_string(b).map_err(SyncError::corrupt)?,
                    record.terminal_cursor
                ],
                |row| row.get(0),
            )
            .map_err(SyncError::corrupt)?;
        let (payload, _) =
            crate::outbound::published_moment_append_payload_in_tx(tx, &b.workspace_id, &moment)?;
        return Ok(Some(crate::outbound::PortableBefore::bootstrap(&payload)));
    }
    // Past cursor 0 the relay starts this proof at the Markdown of the
    // handover cut, not at the adoption's source. The settlement that covered
    // no edits there wrote that projection, so the moment's own preimage names it.
    if record.previous_cursor > 0 {
        return Ok(None);
    }
    // The adopted activation whose cut this settlement follows, released or
    // not. Activations that adopted the same cut from different sources
    // cannot name one before-image.
    let mut statement = tx.prepare(
        concat!("SELECT DISTINCT m.moment_id,m.version_id,m.object_id,m.path,a.source_digest,a.source_byte_length,m.recorded_at_ms,m.metadata_origin,m.metadata_summary,m.metadata_correlation_id
         FROM live_owner_activations a
         JOIN moments m ON ", dohc_engine_domain::exclude_capture_recovery_sql!("m"), " AND m.workspace_id=a.workspace_id AND m.version_id=a.main_version_id AND m.object_id=a.object_id AND m.moment_id=a.source_moment_id
           AND m.path=?7 AND m.after_content_kind='text' AND m.after_blob_sha256=a.source_digest
         JOIN blobs t ON t.sha256=a.source_digest AND t.byte_length=a.source_byte_length
         WHERE a.relay_database_namespace=?1 AND a.workspace_id=?2 AND a.main_version_id=?3 AND a.object_id=?4 AND a.lineage_claim_id=?5
           AND a.evidence_digest IS NOT NULL AND a.binding_json=?6 AND a.terminal_cursor=?8
           AND (?10 OR NOT EXISTS(SELECT 1 FROM live_device_settlements s WHERE s.relay_database_namespace=?1 AND s.workspace_id=?2 AND s.main_version_id=?3 AND s.object_id=?4 AND s.lineage_claim_id=?5 AND s.terminal_cursor<?9))
         LIMIT 2"),
    ).map_err(SyncError::corrupt)?;
    let mut before = statement
        .query_map(
            params![
                record.relay_database_namespace,
                b.workspace_id,
                b.main_version_id,
                b.object_id,
                b.lineage_claim_id,
                serde_json::to_string(b).map_err(SyncError::corrupt)?,
                b.current_path,
                record.previous_cursor,
                record.terminal_cursor,
                skipped
            ],
            portable_before_from_row,
        )
        .map_err(SyncError::corrupt)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(SyncError::corrupt)?;
    if before.len() > 1 {
        return Err(invalid(
            "settlement follows activations with different sources",
        ));
    }
    Ok(before.pop())
}

/// Ordinary activation can adopt an edited replica. Event zero still names
/// its original imported base, so the first portable moment starts there.
fn imported_event_zero_before_in_tx(
    tx: &Transaction<'_>,
    record: &SettlementRecord,
) -> Result<Option<crate::outbound::PortableBefore>, SyncError> {
    let b = &record.binding;
    let json: String = tx
        .query_row(
            &format!("SELECT record_json FROM live_audit_base_publications WHERE {SCOPE}"),
            scope(&record.relay_database_namespace, b),
            |row| row.get(0),
        )
        .map_err(SyncError::corrupt)?;
    let base: BaseRecord = serde_json::from_str(&json).map_err(SyncError::corrupt)?;
    base.validate(&b.workspace_id)?;
    if base.relay_database_namespace != record.relay_database_namespace
        || base.checkpoint.binding != *b
    {
        return Err(invalid("settlement event zero binding differs"));
    }
    require_base_coordinate(tx, &base)?;
    let (imported, disposition, path): (bool, String, String) = tx.query_row(
        "SELECT imported,apply_disposition,json_extract(payload_json,'$.path') FROM replication_log
         WHERE workspace_id=?1 AND origin_id=?2 AND origin_seq=?3",
        params![b.workspace_id,base.base_coordinate.origin_id,base.base_coordinate.origin_seq],
        |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?)),
    ).map_err(SyncError::corrupt)?;
    if !imported {
        return Ok(None);
    }
    if disposition != "applied" || path != b.current_path {
        return Err(invalid("settlement event zero was not applied at its path"));
    }
    require_base_blob(tx, &base)?;
    let bytes: Vec<u8> = tx
        .query_row(
            "SELECT bytes FROM binary_blobs WHERE sha256=?1",
            [&base.checkpoint.state_digest],
            |row| row.get(0),
        )
        .map_err(SyncError::corrupt)?;
    let doc = dohc_engine_collab::Ydoc::wire();
    doc.apply(&bytes).map_err(SyncError::corrupt)?;
    let projected = doc
        .project(ContentKind::Richdoc)
        .map_err(SyncError::corrupt)?
        .content;
    let markdown = doc
        .preserved_markdown_source(&projected)
        .unwrap_or(projected);
    let digest = hex_sha256(markdown.as_bytes());
    // Base import may reuse an already matching file head rather than create
    // a projection moment. Find that artifact within this exact object.
    tx.query_row(
        concat!("SELECT m.moment_id,m.version_id,m.object_id,m.path,m.after_blob_sha256,t.byte_length,m.recorded_at_ms,m.metadata_origin,m.metadata_summary,m.metadata_correlation_id
         FROM moments m JOIN blobs t ON t.sha256=m.after_blob_sha256
         WHERE ", dohc_engine_domain::exclude_capture_recovery_sql!("m"), " AND m.workspace_id=?1 AND m.version_id=?2 AND m.object_id=?3 AND m.path=?4
           AND m.after_content_kind='text' AND m.after_blob_sha256=?5 AND t.byte_length=?6
         ORDER BY m.moment_order LIMIT 1"),
        params![b.workspace_id,b.main_version_id,b.object_id,b.current_path,digest,markdown.len() as i64],
        portable_before_from_row,
    ).map(Some).map_err(SyncError::corrupt)
}

pub(super) fn apply_settlement_envelope(
    store: &mut EngineStore,
    envelope: &ReplicationEnvelope,
    faults: &dyn FaultInjector,
) -> Result<ApplyOutcome<()>, SyncError> {
    apply_envelope_with_mutation_outcome(store, envelope, faults, |tx, op| {
        let (record, json, record_digest) = imported_record(&op.payload, &op.workspace_id)?;
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
            if prior == record_digest {
                return Ok(MutationOutcome::Applied(()));
            }
            tx.execute("INSERT INTO live_audit_settlement_conflicts(workspace_id,origin_id,origin_seq,record_digest,record_json,markdown_digest) VALUES (?1,?2,?3,?4,?5,?6)",params![op.workspace_id,op.origin_id,op.origin_seq,record_digest,json,record.markdown_digest]).map_err(SyncError::persist)?;
            return Ok(MutationOutcome::RefusedRetainingMutation {
                reason: "historical settlement identity contains different evidence".into(),
            });
        }
        tx.execute("INSERT INTO live_audit_settlements(settlement_id,workspace_id,record_digest,record_json,markdown_digest) VALUES (?1,?2,?3,?4,?5)",params![record.settlement_id,op.workspace_id,record_digest,json,record.markdown_digest]).map_err(SyncError::persist)?;
        Ok(MutationOutcome::Applied(()))
    })
}

/// Import's checks that need no store: a canonical current-format payload
/// whose record carries its own ID, and the digest of its record JSON.
fn imported_record(
    payload: &serde_json::Value,
    workspace: &str,
) -> Result<(SettlementRecord, String, String), SyncError> {
    let parsed: SettlementPayload = serde_json::from_value(payload.clone())
        .map_err(|_| invalid("invalid historical settlement payload"))?;
    if parsed.format_version != 1
        || serde_json::to_value(&parsed).map_err(SyncError::corrupt)? != *payload
    {
        return Err(invalid("noncanonical historical settlement payload"));
    }
    let record = parsed.record;
    record.validate(workspace)?;
    let json = serde_json::to_string(&serde_json::to_value(&record).map_err(SyncError::corrupt)?)
        .map_err(SyncError::corrupt)?;
    if hex_sha256(json.as_bytes()) != parsed.record_digest {
        return Err(invalid("historical settlement digest differs"));
    }
    Ok((record, json, parsed.record_digest))
}

#[cfg(test)]
pub(super) fn check_imported_payload(
    payload: &serde_json::Value,
    workspace: &str,
) -> Result<(), SyncError> {
    imported_record(payload, workspace).map(|_| ())
}

fn portable_before_from_row(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<crate::outbound::PortableBefore> {
    Ok(crate::outbound::PortableBefore::published(
        &serde_json::json!({
            "operation":"write", "momentId":row.get::<_,String>(0)?, "versionId":row.get::<_,String>(1)?, "objectId":row.get::<_,String>(2)?,
            "payloadAfterPath":row.get::<_,String>(3)?, "payloadAfterBlobSha256":row.get::<_,String>(4)?, "payloadAfterContentKind":"text", "payloadAfterByteLength":row.get::<_,i64>(5)?, "recordedAtMs":row.get::<_,i64>(6)?,
            "metadata":{"origin":row.get::<_,String>(7)?, "summary":row.get::<_,Option<String>>(8)?, "correlationId":row.get::<_,Option<String>>(9)?}
        }),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use dohc_engine_domain::{VersionedTextStore, WriteText};
    use dohc_engine_storage::{EngineStore, NoFaults, TxnOutcome};

    const SOURCES: [(&str, &str); 3] = [
        ("first-source", "First source."),
        ("second-source", "Second source."),
        ("third-source", "Third source."),
    ];

    /// The digest the settlement after `previous` names as its before-image.
    fn before(
        store: &mut EngineStore,
        binding: &LiveObjectBinding,
        previous: i64,
    ) -> Result<Option<String>, SyncError> {
        let record = SettlementRecord {
            settlement_id: "settlement".into(),
            relay_database_namespace: "relay".into(),
            binding: binding.clone(),
            host_coordinate: ApplicationHostCoordinate {
                host_id: "host".into(),
                host_epoch: 1,
                instance_id: "instance".into(),
                connection_id: "connection".into(),
            },
            previous_cursor: previous,
            terminal_cursor: previous + 1,
            previous_ydoc_sequence: 1,
            local_ydoc_sequence: 2,
            application_count: 1,
            native_interval_digest: String::new(),
            accepted_event_count: 1,
            accepted_interval_digest: String::new(),
            moment_id: "settled".into(),
            markdown_digest: String::new(),
            source_state_vector_digest: String::new(),
            accepted_state_blob_sha256: String::new(),
            recorded_at_ms: 30,
            restore_operation_id: None,
        };
        let outcome = store.write_with(&NoFaults, |tx| {
            Ok::<_, SyncError>(publication_source_before_in_tx(tx, &record)?.map(|before| {
                let mut payload = serde_json::json!({});
                before.apply_to(&mut payload);
                payload["payloadBeforeBlobSha256"]
                    .as_str()
                    .unwrap()
                    .to_owned()
            }))
        })?;
        match outcome {
            TxnOutcome::Committed(digest) => Ok(digest),
            TxnOutcome::Crashed { .. } => panic!("no fault was injected"),
        }
    }

    /// A positive cut keeps the settlement moment's recorded before-image,
    /// regardless of released, current, or competing activation sources.
    #[test]
    fn a_positive_cut_keeps_the_settlement_moments_recorded_before_image() {
        let (_scratch, _, mut store) = dohc_engine_testkit::open_store();
        let mut text = VersionedTextStore::new(&mut store);
        text.ensure_main_version("ws", "main", 1, &NoFaults)
            .unwrap();
        for (moment, body) in SOURCES {
            text.write_text(
                &WriteText {
                    workspace_id: "ws".into(),
                    version_id: "main".into(),
                    object_id: "object".into(),
                    path: "note.md".into(),
                    text: body.into(),
                    moment_id: moment.into(),
                    metadata_origin: "ydoc".into(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: None,
                    now_ms: 10,
                    request_id: None,
                },
                &NoFaults,
            )
            .unwrap();
        }
        let lineage = store
            .write_with(&NoFaults, |tx| {
                Ok::<_, SyncError>(dohc_engine_storage::put_binary_blob(tx, b"lineage")?)
            })
            .unwrap();
        let TxnOutcome::Committed(lineage) = lineage else {
            panic!("no fault was injected")
        };
        let binding = LiveObjectBinding {
            workspace_id: "ws".into(),
            main_version_id: "main".into(),
            object_id: "object".into(),
            lineage_claim_id: lineage,
            current_path: "note.md".into(),
            selector_paths: vec!["note.md".into()],
            restore_fence_generation: 0,
        };
        let binding_json = serde_json::to_string(&binding).unwrap();
        // `source` indexes SOURCES; a released activation keeps its cut.
        let activate = |store: &mut EngineStore,
                        id: &str,
                        predecessor: Option<&str>,
                        source: usize,
                        cursor: i64| {
            let (moment, body) = SOURCES[source];
            store
                .write_with(&NoFaults, |tx| {
                    if let Some(predecessor) = predecessor {
                        tx.execute(
                            "UPDATE live_owner_activations SET released_at_ms=20,released_restore_generation=0,
                                released_accepted_cursor=terminal_cursor,carried_manifest_json='[]',
                                released_boundary_json=json_object('terminalReceipt',json(terminal_receipt_json),
                                  'eventCount',0,'historyEvidenceDigest',evidence_digest)
                             WHERE activation_id=?1",
                            [predecessor],
                        )
                        .map_err(SyncError::persist)?;
                    } else {
                        tx.execute(
                            "INSERT INTO live_owner_adoptions VALUES ('relay',?1,'ws','main','object',?2,?3,?4,?5,?6,1,1,
                                'evidence','coverage',0,1,?7,'null','{}',1,1)",
                            params![id, binding.lineage_claim_id, binding_json, moment,
                                hex_sha256(body.as_bytes()), body.len() as i64, cursor],
                        )
                        .map_err(SyncError::persist)?;
                    }
                    tx.execute(
                        "INSERT INTO live_owner_activations (relay_database_namespace,activation_id,workspace_id,
                            main_version_id,object_id,lineage_claim_id,origin_adoption_id,predecessor_activation_id,
                            binding_json,source_moment_id,source_digest,source_byte_length,
                            baseline_moment_relay_sequence,baseline_registered_at_ms,host_coordinate_json,
                            evidence_digest,coverage_digest,covered_outbox_sequence,local_ydoc_sequence,
                            terminal_cursor,terminal_receipt_json,max_pending_bytes,max_pending_age_ms)
                         VALUES ('relay',?1,'ws','main','object',?2,'first',?3,?4,?5,?6,?7,1,1,'{}',
                            'evidence','coverage',0,1,?8,'null',1,1)",
                        params![id, binding.lineage_claim_id, predecessor, binding_json, moment,
                            hex_sha256(body.as_bytes()), body.len() as i64, cursor],
                    )
                    .map_err(SyncError::persist)?;
                    Ok::<_, SyncError>(())
                })
                .unwrap();
        };
        activate(&mut store, "first", None, 0, 5);
        activate(&mut store, "second", Some("first"), 1, 9);
        assert_eq!(
            before(&mut store, &binding, 5).unwrap(),
            None,
            "the released predecessor does not override the before-image"
        );
        assert_eq!(
            before(&mut store, &binding, 9).unwrap(),
            None,
            "the current activation does not override the before-image"
        );
        assert_eq!(before(&mut store, &binding, 7).unwrap(), None);
        activate(&mut store, "third", Some("second"), 2, 9);
        assert_eq!(
            before(&mut store, &binding, 9).unwrap(),
            None,
            "competing activation sources do not override the before-image"
        );
    }
}
