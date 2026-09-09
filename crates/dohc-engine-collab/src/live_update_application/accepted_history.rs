use super::*;
use crate::Ydoc;
use dohc_engine_storage::put_binary_blob;

const CHECKPOINT_EVENTS: i64 = 4095;
const CHECKPOINT_BYTES: i64 = 20_971_520;
const DOCUMENT: &str = "relay_database_namespace=?1 AND workspace_id=?2 AND main_version_id=?3 AND object_id=?4 AND lineage_claim_id=?5";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeAcceptedCheckpoint {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub restore_operation_id: Option<String>,
    pub event_count: i64,
    pub terminal: Option<LiveUpdateReceipt>,
    pub binding: LiveObjectBinding,
    pub state_digest: String,
    pub evidence_digest: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeRestoreHistoryProof {
    pub checkpoint: NativeAcceptedCheckpoint,
    pub suffix: Vec<AdmittedLiveUpdateMetadata>,
    pub event_count: i64,
    pub terminal: Option<LiveUpdateReceipt>,
    pub evidence_digest: String,
}

pub(super) struct HistoryRead {
    pub proof: NativeRestoreHistoryProof,
    pub doc: Ydoc,
}

fn parameters(held: &Registration) -> [&str; 5] {
    let b = &held.binding;
    [
        &held.namespace,
        &b.workspace_id,
        &b.main_version_id,
        &b.object_id,
        &b.lineage_claim_id,
    ]
}

fn initial_digest(held: &Registration) -> Result<String, ApplicationError> {
    Ok(hex_sha256(
        &serde_json::to_vec(&("accepted-history-v1", parameters(held)))
            .map_err(|_| ApplicationError::Corrupt)?,
    ))
}

fn next_digest(
    previous: &str,
    count: i64,
    metadata: &AdmittedLiveUpdateMetadata,
) -> Result<String, ApplicationError> {
    Ok(hex_sha256(
        &serde_json::to_vec(&("accepted-event-v1", previous, count, metadata))
            .map_err(|_| ApplicationError::Corrupt)?,
    ))
}

pub(super) fn origin_stamp(
    conn: &Connection,
    held: &Registration,
) -> Result<String, ApplicationError> {
    if let Some(record) = bootstrap::read_bootstrap(conn, held)? {
        return Ok(hex_sha256(
            &serde_json::to_vec(&record).map_err(|_| ApplicationError::Corrupt)?,
        ));
    }
    let p = parameters(held);
    let json:String=conn.query_row("SELECT json_array(adoption_id,evidence_digest,binding_json,source_moment_id,source_digest,source_byte_length,baseline_moment_relay_sequence,baseline_registered_at_ms,coverage_digest,covered_outbox_sequence,local_ydoc_sequence,terminal_cursor,terminal_receipt_json,host_coordinate_json,max_pending_bytes,max_pending_age_ms) FROM live_owner_adoptions WHERE relay_database_namespace=?1 AND workspace_id=?2 AND main_version_id=?3 AND object_id=?4 AND lineage_claim_id=?5",p,|r|r.get(0)).map_err(read_sql)?;
    Ok(hex_sha256(json.as_bytes()))
}

pub(super) fn initialize(
    tx: &Transaction<'_>,
    held: &Registration,
    baseline: &[u8],
) -> Result<(), ApplicationError> {
    if hex_sha256(baseline) != held.binding.lineage_claim_id {
        return Err(ApplicationError::Conflict);
    }
    let doc = Ydoc::wire();
    doc.apply(baseline)?;
    doc.validate_public_baseline(baseline)?;
    let checkpoint = NativeAcceptedCheckpoint {
        restore_operation_id: None,
        event_count: 0,
        terminal: None,
        binding: held.binding.clone(),
        state_digest: put_binary_blob(tx, baseline)?,
        evidence_digest: initial_digest(held)?,
    };
    insert_checkpoint(
        tx,
        held,
        &checkpoint,
        &mut restore_content::Budget {
            remaining: crate::limits::MAX_YDOC_UPDATE_BYTES,
        },
    )
}

fn insert_checkpoint(
    tx: &Transaction<'_>,
    held: &Registration,
    c: &NativeAcceptedCheckpoint,
    budget: &mut restore_content::Budget,
) -> Result<(), ApplicationError> {
    let p = parameters(held);
    tx.execute(
        "INSERT INTO live_accepted_checkpoints VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)",
        params![
            p[0],
            p[1],
            p[2],
            p[3],
            p[4],
            c.event_count,
            c.terminal.as_ref().map_or(0, |r| r.journal_cursor),
            serde_json::to_string(&c.terminal).map_err(|_| ApplicationError::Corrupt)?,
            serde_json::to_string(&c.binding).map_err(|_| ApplicationError::Corrupt)?,
            origin_stamp(tx, held)?,
            c.state_digest,
            c.evidence_digest,
            c.restore_operation_id,
            c.restore_operation_id.as_deref().map(|id| restore_stamp(tx,held,id,budget)).transpose()?
        ],
    )
    .map_err(write_sql)?;
    Ok(())
}

fn checkpoint(
    conn: &Connection,
    held: &Registration,
    through: i64,
    budget: &mut restore_content::Budget,
    verify_cadence: bool,
) -> Result<NativeAcceptedCheckpoint, ApplicationError> {
    let p = parameters(held);
    let sql = format!("SELECT event_count,journal_cursor,length(CAST(terminal_json AS BLOB))+length(CAST(binding_json AS BLOB))+coalesce(length(CAST(restore_operation_id AS BLOB)),0) FROM live_accepted_checkpoints WHERE {DOCUMENT} AND journal_cursor<=?6 ORDER BY journal_cursor DESC LIMIT 1");
    let (count, cursor, length): (i64, i64, i64) = conn
        .query_row(&sql, params![p[0], p[1], p[2], p[3], p[4], through], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })
        .optional()
        .map_err(read_sql)?
        .ok_or(ApplicationError::Conflict)?;
    budget.charge(usize::try_from(length).map_err(|_| ApplicationError::Corrupt)?)?;
    let sql = format!("SELECT terminal_json,binding_json,state_sha256,evidence_digest,origin_stamp,restore_operation_id,restore_stamp FROM live_accepted_checkpoints WHERE {DOCUMENT} AND event_count=?6");
    let (
        terminal,
        binding,
        state_digest,
        evidence_digest,
        stamp,
        restore_operation_id,
        saved_restore_stamp,
    ): (
        String,
        String,
        String,
        String,
        String,
        Option<String>,
        Option<String>,
    ) = conn
        .query_row(&sql, params![p[0], p[1], p[2], p[3], p[4], count], |r| {
            Ok((
                r.get(0)?,
                r.get(1)?,
                r.get(2)?,
                r.get(3)?,
                r.get(4)?,
                r.get(5)?,
                r.get(6)?,
            ))
        })
        .map_err(read_sql)?;
    if stamp != origin_stamp(conn, held)? {
        return Err(ApplicationError::Corrupt);
    }
    let terminal: Option<LiveUpdateReceipt> =
        serde_json::from_str(&terminal).map_err(|_| ApplicationError::Corrupt)?;
    let binding: LiveObjectBinding =
        serde_json::from_str(&binding).map_err(|_| ApplicationError::Corrupt)?;
    binding
        .validate_canonical()
        .map_err(|_| ApplicationError::Corrupt)?;
    require_document(held, &binding)?;
    digest(&state_digest)?;
    digest(&evidence_digest)?;
    if terminal.as_ref().map_or(0, |r| r.journal_cursor) != cursor
        || (count == 0) != terminal.is_none()
    {
        return Err(ApplicationError::Corrupt);
    }
    if let Some(receipt) = &terminal {
        receipt.validate()?;
    }
    if count == 0
        && (state_digest != held.binding.lineage_claim_id
            || evidence_digest != initial_digest(held)?)
    {
        return Err(ApplicationError::Corrupt);
    }
    if count == 0 && restore_operation_id.is_some() {
        return Err(ApplicationError::Corrupt);
    };
    if let Some(id) = &restore_operation_id {
        if Some(restore_stamp(conn, held, id, budget)?) != saved_restore_stamp {
            return Err(ApplicationError::Corrupt);
        };
        let bound:bool=conn.query_row("SELECT application_delivery_id=?3 AND new_generation=?4 AND json_extract(application_json,'$.admitted.accepted.binding')=?5 FROM live_restore_fences WHERE relay_database_namespace=?1 AND operation_id=?2",params![held.namespace,id,terminal.as_ref().ok_or(ApplicationError::Corrupt)?.delivery_id,binding.restore_fence_generation,serde_json::to_string(&binding).map_err(|_|ApplicationError::Corrupt)?],|r|r.get(0)).map_err(read_sql)?;
        if !bound {
            return Err(ApplicationError::Corrupt);
        };
        if verify_cadence {
            verify_restore_state(conn, held, id, &state_digest, budget)?;
        }
    } else if saved_restore_stamp.is_some() {
        return Err(ApplicationError::Corrupt);
    };
    if count > 0 {
        let sql=format!("SELECT length(CAST(metadata_json AS BLOB)) FROM live_accepted_updates WHERE {DOCUMENT} AND event_count=?6 AND journal_cursor=?7");
        let length: i64 = conn
            .query_row(
                &sql,
                params![p[0], p[1], p[2], p[3], p[4], count, cursor],
                |r| r.get(0),
            )
            .map_err(read_sql)?;
        budget.charge(usize::try_from(length).map_err(|_| ApplicationError::Corrupt)?)?;
        let sql=format!("SELECT metadata_json,evidence_digest FROM live_accepted_updates WHERE {DOCUMENT} AND event_count=?6 AND journal_cursor=?7");
        let (json, expected): (String, String) = conn
            .query_row(
                &sql,
                params![p[0], p[1], p[2], p[3], p[4], count, cursor],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(read_sql)?;
        let metadata: AdmittedLiveUpdateMetadata =
            serde_json::from_str(&json).map_err(|_| ApplicationError::Corrupt)?;
        if Some(&metadata.accepted.receipt) != terminal.as_ref()
            || metadata.accepted.binding != binding
            || expected != evidence_digest
        {
            return Err(ApplicationError::Corrupt);
        }
        if verify_cadence {
            // Check cadence from the preceding checkpoint using lengths only.
            let sql=format!("SELECT event_count FROM live_accepted_checkpoints WHERE {DOCUMENT} AND event_count<?6 ORDER BY event_count DESC LIMIT 1");
            let previous: i64 = conn
                .query_row(&sql, params![p[0], p[1], p[2], p[3], p[4], count], |r| {
                    r.get(0)
                })
                .map_err(read_sql)?;
            let (events, bytes) = segment_position(conn, held, previous, count)?;
            if restore_operation_id.is_none()
                && events != CHECKPOINT_EVENTS
                && bytes < CHECKPOINT_BYTES
            {
                return Err(ApplicationError::Corrupt);
            }
        }
    }
    Ok(NativeAcceptedCheckpoint {
        restore_operation_id,
        event_count: count,
        terminal,
        binding,
        state_digest,
        evidence_digest,
    })
}

fn require_document(held: &Registration, b: &LiveObjectBinding) -> Result<(), ApplicationError> {
    if b.workspace_id != held.binding.workspace_id
        || b.main_version_id != held.binding.main_version_id
        || b.object_id != held.binding.object_id
        || b.lineage_claim_id != held.binding.lineage_claim_id
    {
        return Err(ApplicationError::Conflict);
    }
    Ok(())
}

fn segment_position(
    conn: &Connection,
    held: &Registration,
    after: i64,
    through: i64,
) -> Result<(i64, i64), ApplicationError> {
    let p = parameters(held);
    let sql="SELECT a.event_count,b.byte_length,length(b.bytes),a.suffix_count,a.suffix_bytes FROM live_accepted_updates a JOIN binary_blobs b ON b.sha256=a.update_sha256 WHERE a.relay_database_namespace=?1 AND a.workspace_id=?2 AND a.main_version_id=?3 AND a.object_id=?4 AND a.lineage_claim_id=?5 AND a.event_count>?6 AND a.event_count<=?7 ORDER BY a.event_count LIMIT 4096";
    let mut query = conn.prepare(sql).map_err(read_sql)?;
    let mut rows = query
        .query(params![p[0], p[1], p[2], p[3], p[4], after, through])
        .map_err(read_sql)?;
    let mut count = 0;
    let mut bytes = 0;
    while let Some(row) = rows.next().map_err(read_sql)? {
        if count == CHECKPOINT_EVENTS || bytes >= CHECKPOINT_BYTES {
            return Err(ApplicationError::Corrupt);
        }
        let ordinal: i64 = row.get(0).map_err(read_sql)?;
        let length: i64 = row.get(1).map_err(read_sql)?;
        if ordinal != after + count + 1
            || length <= 0
            || length > CHECKPOINT_BYTES
            || row.get::<_, i64>(2).map_err(read_sql)? != length
        {
            return Err(ApplicationError::Corrupt);
        }
        count += 1;
        bytes += length;
        if row.get::<_, i64>(3).map_err(read_sql)? != count
            || row.get::<_, i64>(4).map_err(read_sql)? != bytes
        {
            return Err(ApplicationError::Corrupt);
        }
    }
    if after + count != through {
        return Err(ApplicationError::Corrupt);
    }
    Ok((count, bytes))
}

/// A full accepted history is initialized only by verified bootstrap or adoption.
/// Other application users can keep applying without gaining restore authority.
pub(super) fn append(
    tx: &Transaction<'_>,
    held: &Registration,
    event: &AdmittedLiveUpdate,
    working_reserve_bytes: usize,
) -> Result<(), ApplicationError> {
    append_inner(
        tx,
        held,
        event,
        &mut restore_content::Budget {
            remaining: working_reserve_bytes,
        },
        None,
    )
}

pub(super) fn append_restore(
    tx: &Transaction<'_>,
    held: &Registration,
    event: &AdmittedLiveUpdate,
    doc: &Ydoc,
    operation: &str,
    budget: &mut restore_content::Budget,
) -> Result<(), ApplicationError> {
    append_inner(tx, held, event, budget, Some((operation, doc)))
}

fn append_inner(
    tx: &Transaction<'_>,
    held: &Registration,
    event: &AdmittedLiveUpdate,
    budget: &mut restore_content::Budget,
    restored: Option<(&str, &Ydoc)>,
) -> Result<(), ApplicationError> {
    let p = parameters(held);
    let sql = format!("SELECT EXISTS(SELECT 1 FROM live_accepted_checkpoints WHERE {DOCUMENT})");
    if !tx
        .query_row(&sql, p, |r| r.get::<_, bool>(0))
        .map_err(read_sql)?
    {
        if bootstrap::read_bootstrap(tx, held)?.is_some()
            || adoption::read_origin(tx, held)?.is_some()
        {
            return Err(ApplicationError::Corrupt);
        }
        return Ok(());
    }
    let c = checkpoint(tx, held, SAFE, budget, false)?;
    let sql=format!("SELECT length(CAST(metadata_json AS BLOB)) FROM live_accepted_updates WHERE {DOCUMENT} ORDER BY event_count DESC LIMIT 1");
    if let Some(length) = tx
        .query_row(&sql, p, |r| r.get::<_, i64>(0))
        .optional()
        .map_err(read_sql)?
    {
        budget.charge(usize::try_from(length).map_err(|_| ApplicationError::Corrupt)?)?;
    }
    let sql=format!("SELECT event_count,journal_cursor,metadata_json,evidence_digest,suffix_count,suffix_bytes FROM live_accepted_updates WHERE {DOCUMENT} ORDER BY event_count DESC LIMIT 1");
    let prior: Option<(i64, i64, String, String, i64, i64)> = tx
        .query_row(&sql, p, |r| {
            Ok((
                r.get(0)?,
                r.get(1)?,
                r.get(2)?,
                r.get(3)?,
                r.get(4)?,
                r.get(5)?,
            ))
        })
        .optional()
        .map_err(read_sql)?;
    let (count, cursor, previous, binding, prior_events, prior_bytes) = match prior {
        Some((count, cursor, json, digest, events, bytes)) => {
            let metadata: AdmittedLiveUpdateMetadata =
                serde_json::from_str(&json).map_err(|_| ApplicationError::Corrupt)?;
            (
                count,
                cursor,
                digest,
                metadata.accepted.binding,
                events,
                bytes,
            )
        }
        None => (0, 0, c.evidence_digest.clone(), c.binding.clone(), 0, 0),
    };
    require_document(held, &event.metadata.accepted.binding)?;
    if event.metadata.accepted.receipt.journal_cursor <= cursor || count == SAFE {
        return Err(ApplicationError::Conflict);
    }
    require_transition(tx, held, &binding, &event.metadata)?;
    let (events, bytes) = if count == c.event_count {
        (1, event.update_bytes.len() as i64)
    } else {
        if count - c.event_count != prior_events
            || prior_events >= CHECKPOINT_EVENTS
            || prior_bytes >= CHECKPOINT_BYTES
        {
            return Err(ApplicationError::Corrupt);
        }
        (
            prior_events + 1,
            prior_bytes + event.update_bytes.len() as i64,
        )
    };
    let count = count + 1;
    let evidence = next_digest(&previous, count, &event.metadata)?;
    let update = put_binary_blob(tx, &event.update_bytes)?;
    tx.execute(
        "INSERT INTO live_accepted_updates VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",
        params![
            p[0],
            p[1],
            p[2],
            p[3],
            p[4],
            count,
            event.metadata.accepted.receipt.journal_cursor,
            event.metadata.accepted.receipt.delivery_id,
            serde_json::to_string(&event.metadata).map_err(|_| ApplicationError::Corrupt)?,
            update,
            events,
            bytes,
            evidence
        ],
    )
    .map_err(write_sql)?;
    if restored.is_some() || events == CHECKPOINT_EVENTS || bytes >= CHECKPOINT_BYTES {
        let history = if restored.is_none() {
            Some(read_inner(
                tx,
                held,
                event.metadata.accepted.receipt.journal_cursor,
                budget,
                CHECKPOINT_EVENTS as usize,
                false,
            )?)
        } else {
            None
        };
        let doc = restored
            .map(|(_, doc)| doc)
            .or_else(|| history.as_ref().map(|h| &h.doc))
            .ok_or(ApplicationError::Corrupt)?;
        let state = doc
            .encode_full_state_bounded(budget.remaining.min(CHECKPOINT_BYTES as usize))
            .ok_or_else(|| {
                if budget.remaining < CHECKPOINT_BYTES as usize {
                    ApplicationError::ConfiguredByteBudgetExceeded
                } else {
                    invalid("accepted checkpoint exceeds update limit")
                }
            })?;
        budget.charge(state.len())?;
        doc.validate_public_baseline(&state)?;
        insert_checkpoint(
            tx,
            held,
            &NativeAcceptedCheckpoint {
                restore_operation_id: restored.map(|(id, _)| id.to_owned()),
                event_count: count,
                terminal: Some(event.metadata.accepted.receipt.clone()),
                binding: event.metadata.accepted.binding.clone(),
                state_digest: put_binary_blob(tx, &state)?,
                evidence_digest: evidence,
            },
            budget,
        )?;
    }
    Ok(())
}

fn require_transition(
    conn: &Connection,
    held: &Registration,
    previous: &LiveObjectBinding,
    next: &AdmittedLiveUpdateMetadata,
) -> Result<(), ApplicationError> {
    let binding = &next.accepted.binding;
    if previous.restore_fence_generation == binding.restore_fence_generation {
        return Ok(());
    }
    let json:Option<String>=conn.query_row("SELECT application_json FROM live_restore_fences WHERE relay_database_namespace=?1 AND workspace_id=?2 AND main_version_id=?3 AND object_id=?4 AND application_delivery_id=?5",params![held.namespace,held.workspace_id,binding.main_version_id,binding.object_id,next.accepted.receipt.delivery_id],|r|r.get(0)).optional().map_err(read_sql)?.flatten();
    let receipt: NativeRestoreApplicationReceipt =
        serde_json::from_str(&json.ok_or(ApplicationError::Conflict)?)
            .map_err(|_| ApplicationError::Corrupt)?;
    if receipt.admitted != *next
        || receipt.fence.operation.old_binding.restore_fence_generation
            != previous.restore_fence_generation
        || receipt.fence.operation.new_fence != binding.restore_fence_generation
        || receipt.fence.operation.old_binding.lineage_claim_id != binding.lineage_claim_id
    {
        return Err(ApplicationError::Conflict);
    }
    Ok(())
}

pub(super) fn read(
    conn: &Connection,
    held: &Registration,
    through: i64,
    budget: &mut restore_content::Budget,
    max_events: usize,
) -> Result<HistoryRead, ApplicationError> {
    read_inner(conn, held, through, budget, max_events, true)
}

fn read_inner(
    conn: &Connection,
    held: &Registration,
    through: i64,
    budget: &mut restore_content::Budget,
    max_events: usize,
    retain_metadata: bool,
) -> Result<HistoryRead, ApplicationError> {
    let c = checkpoint(conn, held, through, budget, true)?;
    let baseline = budget.blob(conn, &c.state_digest)?;
    let doc = Ydoc::wire();
    doc.apply(&baseline)?;
    doc.validate_public_baseline(&baseline)?;
    let p = parameters(held);
    let sql=format!("SELECT event_count,journal_cursor,length(CAST(metadata_json AS BLOB)),update_sha256,evidence_digest FROM live_accepted_updates WHERE {DOCUMENT} AND event_count>?6 AND journal_cursor<=?7 ORDER BY event_count LIMIT ?8");
    let mut query = conn.prepare(&sql).map_err(read_sql)?;
    let mut rows = query
        .query(params![
            p[0],
            p[1],
            p[2],
            p[3],
            p[4],
            c.event_count,
            through,
            (max_events.min(CHECKPOINT_EVENTS as usize) + 1) as i64
        ])
        .map_err(read_sql)?;
    let mut suffix = Vec::new();
    let mut count = c.event_count;
    let mut terminal = c.terminal.clone();
    let mut evidence = c.evidence_digest.clone();
    let mut binding = c.binding.clone();
    let mut bytes = 0;
    while let Some(row) = rows.next().map_err(read_sql)? {
        if count - c.event_count >= max_events as i64
            || count - c.event_count >= CHECKPOINT_EVENTS
            || bytes >= CHECKPOINT_BYTES
        {
            return Err(invalid("accepted suffix exceeds configured bounds"));
        }
        let ordinal: i64 = row.get(0).map_err(read_sql)?;
        let cursor: i64 = row.get(1).map_err(read_sql)?;
        let metadata_len: i64 = row.get(2).map_err(read_sql)?;
        if ordinal != count + 1 || cursor <= terminal.as_ref().map_or(0, |r| r.journal_cursor) {
            return Err(ApplicationError::Corrupt);
        }
        budget.charge(usize::try_from(metadata_len).map_err(|_| ApplicationError::Corrupt)?)?;
        let sql = format!(
            "SELECT metadata_json FROM live_accepted_updates WHERE {DOCUMENT} AND event_count=?6"
        );
        let json: String = conn
            .query_row(&sql, params![p[0], p[1], p[2], p[3], p[4], ordinal], |r| {
                r.get(0)
            })
            .map_err(read_sql)?;
        let metadata: AdmittedLiveUpdateMetadata =
            serde_json::from_str(&json).map_err(|_| ApplicationError::Corrupt)?;
        let update_digest: String = row.get(3).map_err(read_sql)?;
        if metadata.accepted.receipt.update_digest != update_digest
            || metadata.accepted.receipt.journal_cursor != cursor
        {
            return Err(ApplicationError::Corrupt);
        }
        let update = budget.blob(conn, &update_digest)?;
        let event = AdmittedLiveUpdate {
            metadata,
            update_bytes: update,
        };
        event.validate()?;
        require_document(held, &event.metadata.accepted.binding)?;
        require_transition(conn, held, &binding, &event.metadata)?;
        let next = next_digest(&evidence, ordinal, &event.metadata)?;
        if next != row.get::<_, String>(4).map_err(read_sql)? {
            return Err(ApplicationError::Corrupt);
        }
        doc.apply(&event.update_bytes)?;
        bytes += event.update_bytes.len() as i64;
        count = ordinal;
        terminal = Some(event.metadata.accepted.receipt.clone());
        evidence = next;
        binding = event.metadata.accepted.binding.clone();
        if retain_metadata {
            suffix.push(event.metadata);
        }
    }
    if terminal.as_ref().map_or(0, |r| r.journal_cursor) != through || doc.has_missing_updates() {
        return Err(ApplicationError::Conflict);
    }
    Ok(HistoryRead {
        doc,
        proof: NativeRestoreHistoryProof {
            checkpoint: c,
            suffix,
            event_count: count,
            terminal,
            evidence_digest: evidence,
        },
    })
}

pub(super) fn accepted_source(
    conn: &Connection,
    held: &Registration,
    delivery: &str,
    budget: &mut restore_content::Budget,
) -> Result<Option<AdmittedLiveUpdateMetadata>, ApplicationError> {
    let length:Option<i64>=conn.query_row("SELECT length(CAST(metadata_json AS BLOB)) FROM live_accepted_updates WHERE relay_database_namespace=?1 AND delivery_id=?2",params![held.namespace,delivery],|r|r.get(0)).optional().map_err(read_sql)?;
    let Some(length) = length else {
        let applied:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM live_device_update_applications WHERE relay_database_namespace=?1 AND delivery_id=?2)",params![held.namespace,delivery],|r|r.get(0)).map_err(read_sql)?;
        if applied {
            return Err(ApplicationError::Corrupt);
        }
        return Ok(None);
    };
    budget.charge(usize::try_from(length).map_err(|_| ApplicationError::Corrupt)?)?;
    let (json,count,cursor,update,evidence):(String,i64,i64,String,String)=conn.query_row("SELECT metadata_json,event_count,journal_cursor,update_sha256,evidence_digest FROM live_accepted_updates WHERE relay_database_namespace=?1 AND delivery_id=?2",params![held.namespace,delivery],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).map_err(read_sql)?;
    let metadata: AdmittedLiveUpdateMetadata =
        serde_json::from_str(&json).map_err(|_| ApplicationError::Corrupt)?;
    require_document(held, &metadata.accepted.binding)?;
    metadata.accepted.receipt.validate()?;
    let previous = if count == 1 {
        initial_digest(held)?
    } else {
        let p = parameters(held);
        let sql = format!(
            "SELECT evidence_digest FROM live_accepted_updates WHERE {DOCUMENT} AND event_count=?6"
        );
        conn.query_row(
            &sql,
            params![p[0], p[1], p[2], p[3], p[4], count - 1],
            |r| r.get::<_, String>(0),
        )
        .map_err(read_sql)?
    };
    if count <= 0
        || metadata.accepted.receipt.delivery_id != delivery
        || metadata.accepted.receipt.journal_cursor != cursor
        || metadata.accepted.receipt.update_digest != update
        || next_digest(&previous, count, &metadata)? != evidence
    {
        return Err(ApplicationError::Corrupt);
    }
    Ok(Some(metadata))
}

fn restore_stamp(
    conn: &Connection,
    held: &Registration,
    id: &str,
    budget: &mut restore_content::Budget,
) -> Result<String, ApplicationError> {
    let json = budget.sql_json_array(
        conn,
        &["input_json", "receipt_json", "proposal_json", "proposal_candidate_sha256", "proposal_frozen_sha256", "proposal_point_sha256", "application_json", "application_delivery_id"],
        "FROM live_restore_fences WHERE relay_database_namespace=?1 AND operation_id=?2 AND workspace_id=?3 AND main_version_id=?4 AND object_id=?5",
        params![held.namespace,id,held.workspace_id,held.binding.main_version_id,held.binding.object_id],
    )?;
    Ok(hex_sha256(json.as_bytes()))
}

fn verify_restore_state(
    conn: &Connection,
    held: &Registration,
    id: &str,
    state_digest: &str,
    budget: &mut restore_content::Budget,
) -> Result<(), ApplicationError> {
    let (frozen,candidate,proposal):(String,String,String)=conn.query_row("SELECT proposal_frozen_sha256,proposal_candidate_sha256,proposal_json FROM live_restore_fences WHERE relay_database_namespace=?1 AND operation_id=?2",params![held.namespace,id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).map_err(read_sql)?;
    // restore_stamp charged the complete retained metadata before this read.
    let proposal: NativeRestoreProposalReceipt =
        serde_json::from_str(&proposal).map_err(|_| ApplicationError::Corrupt)?;
    if proposal.fence.operation.operation_id != id
        || proposal.frozen_state_digest != frozen
        || proposal.candidate_digest != candidate
    {
        return Err(ApplicationError::Corrupt);
    };
    let doc = Ydoc::wire();
    doc.apply(&budget.blob(conn, &frozen)?)?;
    for source in &proposal.native_sources {
        let bytes = budget.blob(conn, &source.update_digest)?;
        if bytes.len() as i64 != source.byte_length {
            return Err(ApplicationError::Corrupt);
        };
    }
    let candidate = budget.blob(conn, &candidate)?;
    crate::validate_replay_parity(&doc, &candidate)?;
    doc.apply(&candidate)?;
    let state = budget.blob(conn, state_digest)?;
    let saved = Ydoc::wire();
    saved.apply(&state)?;
    if !crate::replay_parity::structurally_equal_v2(&doc, &saved)?
        || doc.canonical_content_sha256() != proposal.final_content_digest
    {
        return Err(ApplicationError::Corrupt);
    };
    Ok(())
}
