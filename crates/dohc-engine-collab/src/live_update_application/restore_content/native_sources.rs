use super::*;
use crate::owner_outbox::{OwnerOutboxNativeOrigin, OwnerOutboxNativeSource};

/// A retained pending queue identity. Admission, when present, is separate evidence.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeRestoreSource {
    pub outbox_id: String,
    pub outbox_sequence: i64,
    pub binding: LiveObjectBinding,
    pub append_key: String,
    pub delivery_id: String,
    pub update_digest: String,
    pub byte_length: i64,
    pub created_at_ms: i64,
    pub source: OwnerOutboxNativeSource,
    pub accepted_receipt: Option<LiveUpdateReceipt>,
}

pub(super) struct ClassifiedNativeSources {
    pub sources: Vec<NativeRestoreSource>,
    pub bytes: Vec<Vec<u8>>,
    pub digest: String,
}

struct Parent {
    outbox: String,
    path: String,
    selectors: String,
    fence: i64,
    base: String,
    blob: String,
    base_length: i64,
    state: String,
    pending: i64,
    oldest: Option<i64>,
    next: i64,
    reason: Option<String>,
    observed: Option<String>,
}

#[allow(clippy::too_many_arguments)]
pub(super) fn classify(
    conn: &Connection,
    held: &Registration,
    input: &NativeRestorePreparation,
    origin_sequence: i64,
    event_count: usize,
    context: &Ydoc,
    budget: &mut Budget,
    max_events: usize,
) -> Result<ClassifiedNativeSources, ApplicationError> {
    let operation = &input.fence.operation;
    let b = &operation.old_binding;
    let parent_length: Option<i64> = conn.query_row(
        "SELECT length(CAST(outbox_id AS BLOB))+length(CAST(current_path AS BLOB))+length(CAST(selector_paths_json AS BLOB))+length(CAST(base_update_digest AS BLOB))+length(CAST(base_blob_digest AS BLOB))+length(CAST(state AS BLOB))+coalesce(length(CAST(quarantine_reason AS BLOB)),0)+coalesce(length(CAST(observed_binding_json AS BLOB)),0) FROM owner_ydoc_outboxes WHERE workspace_id=?1 AND main_version_id=?2 AND object_id=?3 AND lineage_claim_id=?4",
        params![b.workspace_id,b.main_version_id,b.object_id,b.lineage_claim_id],|row|row.get(0),
    ).optional().map_err(read_sql)?;
    if let Some(length) = parent_length {
        budget.charge(usize::try_from(length).map_err(|_| ApplicationError::Corrupt)?)?;
    }
    let parent: Option<Parent> = conn.query_row(
        "SELECT outbox_id,current_path,selector_paths_json,restore_fence_generation,base_update_digest,base_blob_digest,base_byte_length,state,pending_bytes,oldest_entry_at_ms,next_sequence,quarantine_reason,observed_binding_json FROM owner_ydoc_outboxes WHERE workspace_id=?1 AND main_version_id=?2 AND object_id=?3 AND lineage_claim_id=?4",
        params![b.workspace_id,b.main_version_id,b.object_id,b.lineage_claim_id],|row|Ok(Parent {outbox:row.get(0)?,path:row.get(1)?,selectors:row.get(2)?,fence:row.get(3)?,base:row.get(4)?,blob:row.get(5)?,base_length:row.get(6)?,state:row.get(7)?,pending:row.get(8)?,oldest:row.get(9)?,next:row.get(10)?,reason:row.get(11)?,observed:row.get(12)?}),
    ).optional().map_err(read_sql)?;
    let mut sources = Vec::new();
    let mut bytes = Vec::new();
    if let Some(Parent {
        outbox,
        path,
        selectors,
        fence,
        base,
        blob,
        base_length,
        state,
        pending,
        oldest,
        next,
        reason,
        observed,
    }) = parent
    {
        let expected_outbox = crate::owner_outbox::outbox_id(
            b,
            &b.lineage_claim_id,
            &serde_json::to_string(b).map_err(|_| ApplicationError::Corrupt)?,
        );
        if outbox != expected_outbox {
            return Err(ApplicationError::Corrupt);
        }
        let selectors: Vec<String> =
            serde_json::from_str(&selectors).map_err(|_| ApplicationError::Corrupt)?;
        let observed: LiveObjectBinding =
            serde_json::from_str(observed.as_deref().ok_or(ApplicationError::Corrupt)?)
                .map_err(|_| ApplicationError::Corrupt)?;
        let mut stopped = b.clone();
        stopped.restore_fence_generation = operation.new_fence;
        let actual_base_length: i64 = conn
            .query_row(
                "SELECT byte_length FROM binary_blobs WHERE sha256=?1",
                [&base],
                |row| row.get(0),
            )
            .map_err(read_sql)?;
        if path != b.current_path
            || selectors != b.selector_paths
            || fence != b.restore_fence_generation
            || base != b.lineage_claim_id
            || blob != base
            || base_length != actual_base_length
            || state != "quarantined"
            || reason.as_deref() != Some("restore-fenced")
            || observed != stopped
            || next < 1
        {
            return Err(ApplicationError::Conflict);
        }
        let mut query=conn.prepare("SELECT sequence,append_key,delivery_id,update_digest,update_blob_digest,byte_length,created_at_ms,length(CAST(native_source_json AS BLOB)),length(CAST(append_key AS BLOB))+length(CAST(delivery_id AS BLOB))+length(CAST(update_digest AS BLOB))+length(CAST(update_blob_digest AS BLOB)) FROM owner_ydoc_outbox_entries WHERE outbox_id=?1 AND pending=1 ORDER BY sequence LIMIT ?2").map_err(read_sql)?;
        let mut rows = query
            .query(params![outbox, max_events as i64 + 1])
            .map_err(read_sql)?;
        let mut total = 0_i64;
        let mut observed_oldest = None;
        while let Some(row) = rows.next().map_err(read_sql)? {
            if sources.len() + event_count >= max_events {
                return Err(invalid("restore source count exceeds configured budget"));
            }
            let sequence: i64 = row.get(0).map_err(read_sql)?;
            let metadata_length: i64 = row.get(8).map_err(read_sql)?;
            budget
                .charge(usize::try_from(metadata_length).map_err(|_| ApplicationError::Corrupt)?)?;
            let append_key: String = row.get(1).map_err(read_sql)?;
            let delivery_id: String = row.get(2).map_err(read_sql)?;
            let update_digest: String = row.get(3).map_err(read_sql)?;
            let update_blob: String = row.get(4).map_err(read_sql)?;
            let length: i64 = row.get(5).map_err(read_sql)?;
            let created: i64 = row.get(6).map_err(read_sql)?;
            let source_length: Option<i64> = row.get(7).map_err(read_sql)?;
            if created < 0
                || sequence < 1
                || sequence >= next
                || update_digest != update_blob
                || length <= 0
                || length as u64 > crate::limits::MAX_YDOC_UPDATE_BYTES as u64
            {
                return Err(ApplicationError::Corrupt);
            }
            budget.charge(
                usize::try_from(source_length.ok_or(invalid(
                    "restore pending source has no trusted native association",
                ))?)
                .map_err(|_| ApplicationError::Corrupt)?,
            )?;
            let json:String=conn.query_row("SELECT native_source_json FROM owner_ydoc_outbox_entries WHERE outbox_id=?1 AND sequence=?2",params![outbox,sequence],|row|row.get(0)).map_err(read_sql)?;
            let source: OwnerOutboxNativeSource =
                serde_json::from_str(&json).map_err(|_| ApplicationError::Corrupt)?;
            source
                .validate(&append_key)
                .map_err(|_| ApplicationError::Corrupt)?;
            source
                .verify_retained_row(conn)
                .map_err(|_| ApplicationError::Corrupt)?;
            let RestoreDeliveryOrigin::Owner { id } = &operation.origin else {
                return Err(ApplicationError::Conflict);
            };
            let covered: i64 = conn.query_row(
                "SELECT covered_outbox_sequence FROM live_owner_adoptions WHERE relay_database_namespace=?1 AND adoption_id=?2",
                params![held.namespace,id], |row|row.get(0),
            ).map_err(read_sql)?;
            if sequence <= covered {
                return Err(ApplicationError::Corrupt);
            }
            if source.binding != *b
                || source.adoption_id != *id
                || source.update_digest != update_digest
                || source.native_sequence > input.fence.local_head_sequence
                || match source.origin {
                    OwnerOutboxNativeOrigin::AdoptionSeed => {
                        source.native_sequence != origin_sequence
                    }
                    OwnerOutboxNativeOrigin::NativeUpdate { .. } => false,
                }
            {
                return Err(ApplicationError::Conflict);
            }
            if delivery_id != crate::owner_outbox::delivery_id(&outbox, sequence, &update_digest) {
                return Err(ApplicationError::Corrupt);
            }
            let update = budget.blob(conn, &update_digest)?;
            if update.len() as i64 != length {
                return Err(ApplicationError::Corrupt);
            }
            let admitted = accepted_history::accepted_source(conn, held, &delivery_id, budget)?;
            let accepted_receipt = if let Some(metadata) = admitted {
                if metadata.accepted.receipt.update_digest != update_digest
                    || metadata.accepted.binding != *b
                    || metadata.accepted.receipt.journal_cursor
                        > operation.terminal.as_ref().map_or(0, |r| r.journal_cursor)
                    || !matches!(
                        metadata.accepted.authority,
                        ServerDerivedLiveUpdateAuthority::Owner { .. }
                    )
                {
                    return Err(ApplicationError::Conflict);
                }
                Some(metadata.accepted.receipt)
            } else {
                None
            };
            crate::validate_replay_parity(context, &update)?;
            context.apply(&update)?;
            total = total.checked_add(length).ok_or(ApplicationError::Corrupt)?;
            observed_oldest =
                Some(observed_oldest.map_or(created, |value: i64| value.min(created)));
            sources.push(NativeRestoreSource {
                outbox_id: outbox.clone(),
                outbox_sequence: sequence,
                binding: b.clone(),
                append_key,
                delivery_id,
                update_digest,
                byte_length: length,
                created_at_ms: created,
                source,
                accepted_receipt,
            });
            bytes.push(update);
        }
        if total != pending || observed_oldest != oldest {
            return Err(ApplicationError::Corrupt);
        }
    }
    let digest = hex_sha256(&budget.json(&(&input.fence, &sources))?);
    Ok(ClassifiedNativeSources {
        sources,
        bytes,
        digest,
    })
}
