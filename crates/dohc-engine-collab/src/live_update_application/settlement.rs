use super::*;
use std::collections::HashSet;

/// Immutable projection coverage. Filesystem status belongs to its materialization job.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveSettlementResult {
    pub settlement_id: String,
    pub previous_cursor: i64,
    pub terminal_cursor: i64,
    pub application_count: usize,
    #[serde(rename = "localYDocSequence")]
    pub local_ydoc_sequence: i64,
    pub moment_id: String,
    pub markdown_digest: String,
    pub materialized: bool,
}

pub struct LiveSettlementAudit {
    namespace: String,
    binding: LiveObjectBinding,
    coordinate: ApplicationHostCoordinate,
    previous_cursor: i64,
    terminal_cursor: i64,
    previous_sequence: i64,
    sequence: i64,
    receipts: Vec<ReceiptIdentity>,
    interval_digest: String,
    bootstrap_moment: String,
    bootstrap_digest: String,
    first: bool,
}

fn audit_error(error: ApplicationError) -> StorageError {
    match error {
        ApplicationError::Storage(error) => error,
        _ => StorageError::StateCorrupt { source: None },
    }
}

impl LiveSettlementAudit {
    /// A compensated filesystem marker can be restored only for this retained projection.
    pub fn covers_projection_in(
        &self,
        conn: &Connection,
        moment: &str,
        markdown: &str,
    ) -> Result<bool, StorageError> {
        let b = &self.binding;
        let registration = Registration {
            workspace_id: b.workspace_id.clone(),
            namespace: self.namespace.clone(),
            coordinate: self.coordinate.clone(),
            binding: b.clone(),
            live: true,
        };
        require_workspace(conn, &registration).map_err(audit_error)?;
        if !read_binding(conn, &registration)
            .map_err(audit_error)?
            .is_some_and(|(binding, coordinate, available)| {
                available && binding == *b && coordinate == self.coordinate
            })
        {
            return Err(StorageError::StateCorrupt { source: None });
        }
        let saved:Option<(String,String,i64,String)>=conn.query_row("SELECT moment_id,markdown_digest,local_ydoc_sequence,binding_json FROM live_device_settlements WHERE relay_database_namespace=?1 AND workspace_id=?2 AND main_version_id=?3 AND object_id=?4 AND lineage_claim_id=?5 ORDER BY terminal_cursor DESC LIMIT 1",
            params![self.namespace,b.workspace_id,b.main_version_id,b.object_id,b.lineage_claim_id],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?))).optional().map_err(StorageError::persist_public)?;
        let Some((saved_moment, saved_markdown, sequence, binding)) = saved else {
            return Ok(false);
        };
        let binding: LiveObjectBinding =
            serde_json::from_str(&binding).map_err(StorageError::persist_public)?;
        validate_historical_binding(&binding, b).map_err(audit_error)?;
        Ok(saved_moment == moment && saved_markdown == markdown && sequence <= self.sequence)
    }
    pub fn binding(&self) -> &LiveObjectBinding {
        &self.binding
    }
    pub fn expected_head(&self) -> &str {
        &self.bootstrap_digest
    }
    pub fn stored_id(
        &self,
        store: &EngineStore,
        moment: &str,
        markdown: &str,
    ) -> Result<String, StorageError> {
        let b = &self.binding;
        store.read_with(|conn| conn.query_row("SELECT settlement_id FROM live_device_settlements WHERE relay_database_namespace=?1 AND workspace_id=?2 AND main_version_id=?3 AND object_id=?4 AND lineage_claim_id=?5 AND terminal_cursor=?6 AND moment_id=?7 AND markdown_digest=?8",
            params![self.namespace,b.workspace_id,b.main_version_id,b.object_id,b.lineage_claim_id,self.terminal_cursor,moment,markdown],|row| row.get(0))).map_err(StorageError::persist_public)
    }
    pub fn permits_absent_bootstrap(&self, moment: &str, digest: &str) -> bool {
        self.first && moment == self.bootstrap_moment && digest == self.bootstrap_digest
    }

    pub fn record_in_tx(
        &self,
        tx: &Transaction<'_>,
        moment: &str,
        markdown: &str,
        vector: &str,
        now_ms: i64,
    ) -> Result<String, StorageError> {
        let corrupt = || StorageError::StateCorrupt { source: None };
        let b = &self.binding;
        let registration = Registration {
            workspace_id: b.workspace_id.clone(),
            namespace: self.namespace.clone(),
            coordinate: self.coordinate.clone(),
            binding: b.clone(),
            live: true,
        };
        require_workspace(tx, &registration).map_err(audit_error)?;
        if !read_binding(tx, &registration)
            .map_err(audit_error)?
            .is_some_and(|(binding, coordinate, available)| {
                available && binding == *b && coordinate == self.coordinate
            })
        {
            return Err(corrupt());
        }
        let latest = latest_receipt(tx, &registration).map_err(audit_error)?;
        if latest.as_ref().map_or(0, |receipt| receipt.journal_cursor) != self.terminal_cursor {
            return Err(corrupt());
        }
        let receipts = read_interval(
            tx,
            &registration,
            self.previous_cursor,
            self.terminal_cursor,
            self.receipts.len(),
        )
        .map_err(audit_error)?;
        if receipts != self.receipts {
            return Err(corrupt());
        }
        let observed: i64 = tx.query_row("SELECT head_update_seq FROM ydoc_docs WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3 AND lineage_claim_id=?4",
            params![b.workspace_id,b.main_version_id,b.object_id,b.lineage_claim_id], |row| row.get(0)).map_err(StorageError::persist_public)?;
        if observed != self.sequence {
            return Err(corrupt());
        }
        let matches_projection: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM snapshots s JOIN ydoc_docs d ON d.workspace_id=s.workspace_id AND d.version_id=s.version_id AND d.object_id=s.object_id WHERE s.workspace_id=?1 AND s.version_id=?2 AND s.object_id=?3 AND s.path=?4 AND s.latest_moment_id=?5 AND s.blob_sha256=?6 AND d.path=?4 AND d.lineage_claim_id=?7 AND d.last_settled_sha=?6)",
            params![b.workspace_id,b.main_version_id,b.object_id,b.current_path,moment,markdown,b.lineage_claim_id],|row|row.get(0)).map_err(StorageError::persist_public)?;
        if !matches_projection {
            return Err(corrupt());
        }
        let identities = serde_json::to_vec(&(
            &self.namespace,
            b,
            self.previous_cursor,
            self.terminal_cursor,
            self.previous_sequence,
            self.sequence,
            &self.interval_digest,
            moment,
            markdown,
            vector,
        ))
        .map_err(StorageError::persist_public)?;
        let id = format!("live-settlement-{}", hex_sha256(&identities));
        let existing: Option<(String,String,String,String,i64,i64)> = tx.query_row(
            "SELECT settlement_id,moment_id,markdown_digest,interval_digest,application_count,local_ydoc_sequence FROM live_device_settlements WHERE relay_database_namespace=?1 AND workspace_id=?2 AND main_version_id=?3 AND object_id=?4 AND lineage_claim_id=?5 AND terminal_cursor=?6",
            params![self.namespace,b.workspace_id,b.main_version_id,b.object_id,b.lineage_claim_id,self.terminal_cursor],
            |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?))).optional().map_err(StorageError::persist_public)?;
        if let Some((saved, saved_moment, saved_markdown, saved_interval, count, sequence)) =
            existing
        {
            if saved != id
                || saved_moment != moment
                || saved_markdown != markdown
                || saved_interval != self.interval_digest
                || count != self.receipts.len() as i64
                || sequence != self.sequence
            {
                return Err(corrupt());
            }
            return Ok(id);
        }
        tx.execute("INSERT INTO live_device_settlements VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18)",
            params![id,self.namespace,b.workspace_id,b.main_version_id,b.object_id,b.lineage_claim_id,self.previous_cursor,self.terminal_cursor,self.previous_sequence,self.sequence,self.receipts.len() as i64,self.interval_digest,moment,markdown,vector,
                serde_json::to_string(b).map_err(StorageError::persist_public)?,serde_json::to_string(&self.coordinate).map_err(StorageError::persist_public)?,now_ms]).map_err(StorageError::persist_public)?;
        Ok(id)
    }

    pub fn result(
        &self,
        settlement_id: String,
        moment_id: String,
        markdown_digest: String,
        materialized: bool,
    ) -> LiveSettlementResult {
        LiveSettlementResult {
            settlement_id,
            previous_cursor: self.previous_cursor,
            terminal_cursor: self.terminal_cursor,
            application_count: self.receipts.len(),
            local_ydoc_sequence: self.sequence,
            moment_id,
            markdown_digest,
            materialized,
        }
    }
}

/// The registered application mutex remains held across projection and its transaction.
pub fn with_settlement<E, T>(
    store: &mut EngineStore,
    handle: &ApplicationHandle,
    terminal: Option<LiveUpdateReceipt>,
    max_applications: usize,
    settle: impl FnOnce(&mut EngineStore, &LiveSettlementAudit) -> Result<T, E>,
) -> Result<T, E>
where
    E: From<ApplicationError> + From<StorageError>,
{
    if max_applications == 0 || max_applications >= i64::MAX as usize {
        return Err(E::from(invalid("invalid settlement application limit")));
    }
    if let Some(receipt) = &terminal {
        receipt.validate().map_err(E::from)?;
    }
    let held = handle
        .registration
        .lock()
        .map_err(|_| E::from(ApplicationError::Interrupted))?;
    if !held.live {
        return Err(E::from(ApplicationError::Interrupted));
    }
    let audit = store.read_with(|conn| -> Result<LiveSettlementAudit, ApplicationError> {
        require_workspace(conn, &held)?;
        if !read_binding(conn,&held)?.is_some_and(|(binding,coordinate,available)| available && binding == held.binding && coordinate == held.coordinate) { return Err(ApplicationError::Interrupted); }
        let b = &held.binding;
        validate_historical_binding(b,b)?;
        let key = DocKey::new(&b.workspace_id,&b.main_version_id,&b.object_id)?;
        let marker = durable::read_marker_in(conn,&key)?.ok_or(ApplicationError::Corrupt)?;
        if marker.regime != Regime::Replicated || marker.lineage_claim_status != durable::LineageClaimStatus::Exact || marker.content_kind != crate::ContentKind::Richdoc || marker.lineage_claim_id.as_deref()!=Some(b.lineage_claim_id.as_str()) || marker.path.as_deref()!=Some(b.current_path.as_str()) { return Err(ApplicationError::Conflict); }
        let owner_origin = adoption::read_origin(conn,&held)?;
        let (original_binding,origin_moment,origin_digest,origin_cursor,origin_sequence) = if let Some(origin) = &owner_origin {
            (origin.binding.clone(),origin.source_moment.clone(),origin.source_digest.clone(),origin.terminal.as_ref().map_or(0,|r|r.journal_cursor),origin.sequence)
        } else {
            let (bootstrap,original_binding,_,_) = bootstrap::read_bootstrap(conn,&held)?.ok_or(ApplicationError::Corrupt)?;
            (original_binding,bootstrap.bootstrap_moment_id,bootstrap.projected_markdown_digest,0,0)
        };
        validate_historical_binding(&original_binding,b)?;
        let latest = latest_receipt(conn,&held)?;
        if latest != terminal { return Err(invalid("settlement terminal is not current")); }
        let terminal_cursor = terminal.as_ref().map_or(0,|r|r.journal_cursor);
        let previous: Option<(i64,i64,i64,i64)> = conn.query_row("SELECT previous_cursor,terminal_cursor,previous_ydoc_sequence,local_ydoc_sequence FROM live_device_settlements WHERE relay_database_namespace=?1 AND workspace_id=?2 AND main_version_id=?3 AND object_id=?4 AND lineage_claim_id=?5 ORDER BY terminal_cursor DESC LIMIT 1",
            params![held.namespace,b.workspace_id,b.main_version_id,b.object_id,b.lineage_claim_id],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?))).optional().map_err(read_sql)?;
        let (previous_cursor,previous_sequence) = match previous {
            Some((start,end,start_sequence,_)) if end == terminal_cursor => (start,start_sequence),
            Some((_,end,_,end_sequence)) if end < terminal_cursor => (end,end_sequence),
            Some(_) => return Err(ApplicationError::Corrupt),
            None => (origin_cursor,origin_sequence),
        };
        let receipts = read_interval(conn,&held,previous_cursor,terminal_cursor,max_applications)?;
        let mut sequences=HashSet::new();
        for (delivery,hash,cursor,epoch,sequence,_) in &receipts {
            LiveUpdateReceipt { delivery_id:delivery.clone(),update_digest:hash.clone(),journal_cursor:*cursor,accepting_host_epoch:*epoch }.validate()?;
            integer(*sequence,1,marker.head_update_seq)?;
            if *sequence>previous_sequence { sequences.insert(*sequence); }
        }
        if marker.head_update_seq < previous_sequence || sequences.len() as i64 != marker.head_update_seq-previous_sequence { return Err(invalid("settlement application coverage is incomplete")); }
        let interval_digest=hex_sha256(&serde_json::to_vec(&receipts).map_err(|_| ApplicationError::Corrupt)?);
        let last_settled: Option<String> = conn.query_row("SELECT last_settled_sha FROM ydoc_docs WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",params![b.workspace_id,b.main_version_id,b.object_id],|row|row.get(0)).map_err(read_sql)?;
        Ok(LiveSettlementAudit { namespace:held.namespace.clone(),binding:b.clone(),coordinate:held.coordinate.clone(),previous_cursor,terminal_cursor,previous_sequence,sequence:marker.head_update_seq,receipts,interval_digest,
            bootstrap_moment:origin_moment,bootstrap_digest:origin_digest,first:owner_origin.is_none() && previous.is_none() && last_settled.is_none() })
    }).map_err(E::from)?;
    settle(store, &audit)
}

type ReceiptIdentity = (String, String, i64, i64, i64, String);

pub(super) fn validate_historical_binding(
    historical: &LiveObjectBinding,
    current: &LiveObjectBinding,
) -> Result<(), ApplicationError> {
    historical.validate_canonical().map_err(invalid)?;
    if historical.workspace_id != current.workspace_id
        || historical.main_version_id != current.main_version_id
        || historical.object_id != current.object_id
        || historical.lineage_claim_id != current.lineage_claim_id
        || historical.current_path != current.current_path
        || historical.restore_fence_generation != current.restore_fence_generation
        || !historical.selector_paths.iter().any(|selector| {
            historical.current_path == *selector
                || historical
                    .current_path
                    .strip_prefix(selector)
                    .is_some_and(|suffix| suffix.starts_with('/'))
        })
    {
        return Err(ApplicationError::Conflict);
    }
    Ok(())
}

fn latest_receipt(
    conn: &Connection,
    registration: &Registration,
) -> Result<Option<LiveUpdateReceipt>, ApplicationError> {
    let b = &registration.binding;
    let applied: Option<LiveUpdateReceipt> = conn.query_row("SELECT delivery_id,update_digest,journal_cursor,accepting_host_epoch FROM live_device_update_applications WHERE relay_database_namespace=?1 AND workspace_id=?2 AND main_version_id=?3 AND object_id=?4 AND lineage_claim_id=?5 ORDER BY journal_cursor DESC LIMIT 1",
        params![registration.namespace,b.workspace_id,b.main_version_id,b.object_id,b.lineage_claim_id],
        |row| Ok(LiveUpdateReceipt { delivery_id:row.get(0)?,update_digest:row.get(1)?,journal_cursor:row.get(2)?,accepting_host_epoch:row.get(3)? })).optional().map_err(read_sql)?;
    let adopted = adoption::read_origin(conn, registration)?.and_then(|origin| origin.terminal);
    match (applied, adopted) {
        (Some(applied), Some(adopted)) if applied.journal_cursor <= adopted.journal_cursor => {
            Ok(Some(adopted))
        }
        (Some(applied), _) => Ok(Some(applied)),
        (None, adopted) => Ok(adopted),
    }
}

fn read_interval(
    conn: &Connection,
    registration: &Registration,
    previous: i64,
    terminal: i64,
    max: usize,
) -> Result<Vec<ReceiptIdentity>, ApplicationError> {
    let b = &registration.binding;
    let mut query=conn.prepare("SELECT delivery_id,update_digest,journal_cursor,accepting_host_epoch,local_ydoc_sequence,current_path,selector_paths_json,restore_fence_generation FROM live_device_update_applications WHERE relay_database_namespace=?1 AND workspace_id=?2 AND main_version_id=?3 AND object_id=?4 AND lineage_claim_id=?5 AND journal_cursor>?6 AND journal_cursor<=?7 ORDER BY journal_cursor LIMIT ?8").map_err(read_sql)?;
    let mut rows = query
        .query(params![
            registration.namespace,
            b.workspace_id,
            b.main_version_id,
            b.object_id,
            b.lineage_claim_id,
            previous,
            terminal,
            max as i64 + 1
        ])
        .map_err(read_sql)?;
    let mut receipts = Vec::new();
    while let Some(row) = rows.next().map_err(read_sql)? {
        if receipts.len() == max {
            return Err(invalid("settlement application limit exceeded"));
        }
        let path: String = row.get(5).map_err(read_sql)?;
        let selectors: String = row.get(6).map_err(read_sql)?;
        let selectors: Vec<String> =
            serde_json::from_str(&selectors).map_err(|_| ApplicationError::Corrupt)?;
        let generation: i64 = row.get(7).map_err(read_sql)?;
        let historical = LiveObjectBinding {
            current_path: path,
            selector_paths: selectors,
            restore_fence_generation: generation,
            ..b.clone()
        };
        validate_historical_binding(&historical, b)?;
        let binding_digest =
            hex_sha256(&serde_json::to_vec(&historical).map_err(|_| ApplicationError::Corrupt)?);
        receipts.push((
            row.get(0).map_err(read_sql)?,
            row.get(1).map_err(read_sql)?,
            row.get(2).map_err(read_sql)?,
            row.get(3).map_err(read_sql)?,
            row.get(4).map_err(read_sql)?,
            binding_digest,
        ));
    }
    Ok(receipts)
}
