//! Local persistence of an authenticated, ordered owner applied feed.
//! These records prove local containment, not configured-host authority.
use super::draft::{bounded, collab, key, read_observed_in, ObservedOwnerBinding};
use super::*;
const SAFE: i64 = 9_007_199_254_740_991;
const SCOPE: &str =
    "workspace_id=?1 AND main_version_id=?2 AND object_id=?3 AND lineage_claim_id=?4";

#[derive(Debug, Clone)]
pub struct OwnerAcceptedFrameInput {
    pub binding: LiveObjectBinding,
    pub relay_database_namespace: String,
    pub expected_revision: i64,
    pub expected_native_head_sequence: i64,
    pub previous_accepted_cursor: i64,
    pub journal_cursor: i64,
    pub update_bytes: Vec<u8>,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OwnerAcceptedFrameResult {
    pub revision: i64,
    pub accepted_cursor: i64,
    pub native_head_sequence: i64,
}

#[derive(Debug, Clone)]
pub struct OwnerAcceptedState {
    pub revision: i64,
    pub accepted_cursor: i64,
    pub native_head_sequence: i64,
    pub state_vector: Vec<u8>,
}

/// Read the accepted checkpoint vector, never the private pending draft vector.
pub fn read_state_in(
    conn: &Connection,
    binding: &LiveObjectBinding,
    namespace: &str,
) -> Result<OwnerAcceptedState, OwnerOutboxError> {
    let observed = current(conn, binding)?;
    if observed.relay_database_namespace != namespace {
        return Err(OwnerOutboxError::ParentMismatch);
    }
    let doc = crate::Ydoc::wire();
    doc.apply(&super::draft::bounded_blob(
        conn,
        &observed.checkpoint_digest,
    )?)
    .map_err(collab)?;
    if doc.has_pending_dependencies() {
        return Err(OwnerOutboxError::Corrupt);
    }
    let state_vector = doc
        .encode_state_vector_bounded(crate::limits::MAX_YDOC_UPDATE_BYTES)
        .ok_or(OwnerOutboxError::InvalidInput(
            "accepted vector exceeds document limit",
        ))?;
    Ok(OwnerAcceptedState {
        revision: observed.revision,
        accepted_cursor: observed.accepted_cursor,
        native_head_sequence: observed.native_head_sequence,
        state_vector,
    })
}

pub(super) fn current(
    conn: &Connection,
    binding: &LiveObjectBinding,
) -> Result<ObservedOwnerBinding, OwnerOutboxError> {
    let observed = read_observed_in(conn, binding)?.ok_or(OwnerOutboxError::NotFound)?;
    let marker = crate::read_marker_in(conn, &key(binding)?)
        .map_err(collab)?
        .ok_or(OwnerOutboxError::NotFound)?;
    if marker.head_update_seq != observed.native_head_sequence
        || marker.content_kind != crate::ContentKind::Richdoc
        || marker.regime != crate::Regime::Replicated
        || marker.path.as_deref() != Some(&binding.current_path)
        || marker.lineage_claim_id.as_deref() != Some(&binding.lineage_claim_id)
    {
        return Err(OwnerOutboxError::ParentMismatch);
    }
    Ok(observed)
}

/// Called only by the trusted main-owned authenticated feed, on the actor writer.
/// A submission ACK is not an input to this operation.
pub fn apply_frame_in_tx(
    tx: &rusqlite::Transaction<'_>,
    workspace_id: &str,
    input: &OwnerAcceptedFrameInput,
    now_ms: i64,
) -> Result<OwnerAcceptedFrameResult, OwnerOutboxError> {
    apply_ordered_in_tx(tx, workspace_id, input, None, now_ms)
}

/// Advance from the captured accepted checkpoint to an authenticated host cut.
/// The vector authenticates the resulting struct clocks; the update also carries
/// delete sets, which must be applied even when those clocks have not changed.
pub fn apply_sync_in_tx(
    tx: &rusqlite::Transaction<'_>,
    workspace_id: &str,
    input: &OwnerAcceptedFrameInput,
    host_vector: &[u8],
    now_ms: i64,
) -> Result<OwnerAcceptedFrameResult, OwnerOutboxError> {
    apply_ordered_in_tx(tx, workspace_id, input, Some(host_vector), now_ms)
}

fn apply_ordered_in_tx(
    tx: &rusqlite::Transaction<'_>,
    workspace_id: &str,
    input: &OwnerAcceptedFrameInput,
    host_vector: Option<&[u8]>,
    now_ms: i64,
) -> Result<OwnerAcceptedFrameResult, OwnerOutboxError> {
    let b = &input.binding;
    b.validate_canonical()
        .map_err(OwnerOutboxError::InvalidInput)?;
    require_workspace(workspace_id, &b.workspace_id)?;
    if input.update_bytes.is_empty()
        || input.update_bytes.len() > crate::limits::MAX_YDOC_UPDATE_BYTES
        || !(0..=SAFE).contains(&input.journal_cursor)
        || !(0..=input.journal_cursor).contains(&input.previous_accepted_cursor)
        || (host_vector.is_none() && input.previous_accepted_cursor == input.journal_cursor)
        || !(1..SAFE).contains(&input.expected_revision)
        || !(0..=SAFE).contains(&input.expected_native_head_sequence)
        || !(0..=SAFE).contains(&now_ms)
    {
        return Err(OwnerOutboxError::InvalidInput("invalid accepted frame"));
    }
    let observed = current(tx, b)?;
    if observed.relay_database_namespace != input.relay_database_namespace {
        return Err(OwnerOutboxError::ParentMismatch);
    }
    let digest = if let Some(vector) = host_vector {
        use sha2::{Digest, Sha256};
        use yrs::updates::decoder::Decode;
        if vector.len() > crate::limits::MAX_YDOC_UPDATE_BYTES {
            return Err(OwnerOutboxError::InvalidInput(
                "host vector exceeds document limit",
            ));
        }
        crate::replay_parity::prevalidate_state_vector_bytes(vector).map_err(collab)?;
        let host = yrs::StateVector::decode_v1(vector)
            .map_err(|_| OwnerOutboxError::InvalidInput("invalid host vector"))?;
        let scratch = crate::Ydoc::wire();
        scratch
            .apply(&super::draft::bounded_blob(
                tx,
                &observed.checkpoint_digest,
            )?)
            .map_err(collab)?;
        scratch.apply(&input.update_bytes).map_err(collab)?;
        if scratch.has_pending_dependencies() || scratch.state_vector() != host {
            return Err(OwnerOutboxError::ParentMismatch);
        }
        let checkpoint = bounded(&scratch)?;
        if input.journal_cursor == input.previous_accepted_cursor {
            if observed.revision != input.expected_revision
                || observed.native_head_sequence != input.expected_native_head_sequence
                || observed.accepted_cursor != input.previous_accepted_cursor
                || hex_sha256(&checkpoint) != observed.checkpoint_digest
            {
                return Err(OwnerOutboxError::ParentMismatch);
            }
            return Ok(OwnerAcceptedFrameResult {
                revision: observed.revision,
                accepted_cursor: observed.accepted_cursor,
                native_head_sequence: observed.native_head_sequence,
            });
        }
        let mut hash = Sha256::new();
        hash.update(b"owner-accepted-sync-v1\0");
        hash.update(hex_sha256(&scratch.encode_state_vector()).as_bytes());
        hash.update(&input.update_bytes);
        dohc_engine_storage::hex(&hash.finalize())
    } else {
        hex_sha256(&input.update_bytes)
    };
    let json = binding_json(b)?;
    type AppliedFrameRow = (String, String, String, i64, i64, i64, i64);
    let prior:Option<AppliedFrameRow>=tx.query_row(
        &format!("SELECT binding_json,relay_database_namespace,update_digest,previous_cursor,previous_revision,previous_native_head,native_head_sequence FROM ydoc_owner_applied_frames WHERE {SCOPE} AND journal_cursor=?5"),
        params![b.workspace_id,b.main_version_id,b.object_id,b.lineage_claim_id,input.journal_cursor],
        |r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?)),
    ).optional().map_err(read_sql)?;
    if let Some(prior) = prior {
        if prior.0 != json
            || prior.1 != input.relay_database_namespace
            || prior.2 != digest
            || prior.3 != input.previous_accepted_cursor
            || prior.4 != input.expected_revision
            || prior.5 != input.expected_native_head_sequence
        {
            return Err(OwnerOutboxError::ReceiptMismatch);
        }
        return Ok(OwnerAcceptedFrameResult {
            revision: prior.4 + 1,
            accepted_cursor: input.journal_cursor,
            native_head_sequence: prior.6,
        });
    }
    if observed.revision != input.expected_revision
        || observed.native_head_sequence != input.expected_native_head_sequence
        || observed.accepted_cursor != input.previous_accepted_cursor
    {
        return Err(OwnerOutboxError::ParentMismatch);
    }
    let key = key(b)?;
    // No ordinary publication callback runs. Frame attribution is unknown here.
    crate::durable::record_authorized_update_in_tx(
        tx,
        &key,
        &input.update_bytes,
        None,
        None,
        now_ms,
    )
    .map_err(collab)?;
    let marker = crate::read_marker_in(tx, &key)
        .map_err(collab)?
        .ok_or(OwnerOutboxError::NotFound)?;
    let checkpoint = bounded(&crate::load_doc_in(tx, &key).map_err(collab)?)?;
    let checkpoint_digest = hex_sha256(&checkpoint);
    put_binary_blob_with_sha(tx, &checkpoint, &checkpoint_digest)?;
    let revision = input.expected_revision + 1;
    tx.execute(&format!("UPDATE ydoc_owner_bindings SET binding_revision=?5,accepted_cursor=?6,native_head_sequence=?7,checkpoint_digest=?8 WHERE {SCOPE}"),
        params![b.workspace_id,b.main_version_id,b.object_id,b.lineage_claim_id,revision,input.journal_cursor,marker.head_update_seq,checkpoint_digest]).map_err(write_sql)?;
    tx.execute(
        "INSERT INTO ydoc_owner_applied_frames VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
        params![
            b.workspace_id,
            b.main_version_id,
            b.object_id,
            b.lineage_claim_id,
            json,
            input.relay_database_namespace,
            input.journal_cursor,
            input.previous_accepted_cursor,
            digest,
            input.expected_revision,
            input.expected_native_head_sequence,
            marker.head_update_seq
        ],
    )
    .map_err(write_sql)?;
    // A frame another computer wrote is a change from elsewhere; this
    // owner's own accepted draft is not. A sync can carry either, so it
    // counts.
    if host_vector.is_some() || !super::is_own_draft_in(tx, &key, &digest, None).map_err(collab)? {
        dohc_engine_storage::count_remote_change_in_tx(tx, workspace_id)?;
    }
    prune_in(tx, b)?;
    if checkpoint_digest != observed.checkpoint_digest {
        delete_binary_blob_if_unreferenced(tx, &observed.checkpoint_digest)?;
    }
    Ok(OwnerAcceptedFrameResult {
        revision,
        accepted_cursor: input.journal_cursor,
        native_head_sequence: marker.head_update_seq,
    })
}

/// Check local inclusion only; a higher feed cursor alone is never enough.
pub fn is_receipt_applied_in(
    conn: &Connection,
    binding: &LiveObjectBinding,
    relay_database_namespace: &str,
    receipt: &OwnerDeliveryReceipt,
) -> Result<bool, OwnerOutboxError> {
    validate_identifier(&receipt.delivery_id, "invalid delivery ID")?;
    validate_digest(&receipt.update_digest)?;
    if !(1..=SAFE).contains(&receipt.journal_cursor)
        || !(1..=SAFE).contains(&receipt.accepting_host_epoch)
    {
        return Err(OwnerOutboxError::InvalidInput("invalid owner receipt"));
    }
    let observed = current(conn, binding)?;
    if observed.relay_database_namespace != relay_database_namespace {
        return Err(OwnerOutboxError::ParentMismatch);
    }
    let parent = find_parent_for_binding(conn, binding)?.ok_or(OwnerOutboxError::NotFound)?;
    if parent.binding != *binding || parent.state == OwnerOutboxState::Quarantined {
        return Err(OwnerOutboxError::Frozen);
    }
    let row: Option<(String, i64, Option<String>)> = conn.query_row(
        "SELECT update_digest,pending,accepted_receipt_json FROM owner_ydoc_outbox_entries WHERE outbox_id=?1 AND delivery_id=?2",
        params![parent.outbox_id, receipt.delivery_id], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?)),
    ).optional().map_err(read_sql)?;
    let (digest, pending, saved) = row.ok_or(OwnerOutboxError::ReceiptMismatch)?;
    if digest != receipt.update_digest {
        return Err(OwnerOutboxError::ReceiptMismatch);
    }
    if pending == 0 {
        return Ok(saved.as_deref()
            == Some(
                serde_json::to_string(receipt)
                    .map_err(|_| OwnerOutboxError::Corrupt)?
                    .as_str(),
            ));
    }
    if receipt.journal_cursor > observed.accepted_cursor {
        return Ok(false);
    }
    let checkpoint = super::draft::bounded_blob(conn, &observed.checkpoint_digest)?;
    let update = super::draft::bounded_blob(conn, &digest)?;
    let accepted = crate::Ydoc::wire();
    accepted.apply(&checkpoint).map_err(collab)?;
    if accepted.has_pending_dependencies() {
        return Err(OwnerOutboxError::Corrupt);
    }
    let before = bounded(&accepted)?;
    accepted.apply(&update).map_err(collab)?;
    if accepted.has_pending_dependencies() {
        return Ok(false);
    }
    Ok(bounded(&accepted)? == before)
}

/// Returns true only for an exact, entirely acknowledged retry.
pub(super) fn check_release_in(
    conn: &Connection,
    parent: &ParentRow,
    receipts: &[OwnerDeliveryReceipt],
) -> Result<bool, OwnerOutboxError> {
    let observed = current(conn, &parent.binding)?;
    let mut replayed = 0;
    for receipt in receipts {
        let row:Option<(String,i64,Option<String>)>=conn.query_row("SELECT update_digest,pending,accepted_receipt_json FROM owner_ydoc_outbox_entries WHERE outbox_id=?1 AND delivery_id=?2",
            params![parent.outbox_id,receipt.delivery_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional().map_err(read_sql)?;
        let (digest, pending, saved) = row.ok_or(OwnerOutboxError::ReceiptMismatch)?;
        if digest != receipt.update_digest {
            return Err(OwnerOutboxError::ReceiptMismatch);
        }
        if pending == 0 {
            if saved.as_deref()
                != Some(
                    serde_json::to_string(receipt)
                        .map_err(|_| OwnerOutboxError::Corrupt)?
                        .as_str(),
                )
            {
                return Err(OwnerOutboxError::ReceiptMismatch);
            }
            replayed += 1;
        } else if !is_receipt_applied_in(
            conn,
            &parent.binding,
            &observed.relay_database_namespace,
            receipt,
        )? {
            return Err(OwnerOutboxError::Frozen);
        }
    }
    if replayed != 0 && replayed != receipts.len() {
        return Err(OwnerOutboxError::ReceiptMismatch);
    }
    Ok(replayed == receipts.len())
}

pub(super) fn prune_in(
    conn: &Connection,
    binding: &LiveObjectBinding,
) -> Result<(), OwnerOutboxError> {
    let b = binding;
    conn.execute(&format!("DELETE FROM ydoc_owner_applied_frames WHERE {SCOPE} AND journal_cursor < (SELECT accepted_cursor FROM ydoc_owner_bindings WHERE {SCOPE})"),
        params![b.workspace_id,b.main_version_id,b.object_id,b.lineage_claim_id]).map_err(write_sql)?;
    Ok(())
}
