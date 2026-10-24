//! Enrollment follows a full authenticated owner sync, never renderer authority.
use super::draft::{
    bounded, bounded_blob, collab, key, ObservedOwnerBinding, OwnerDraftDescriptor,
};
use super::*;
use crate::Ydoc;
use yrs::updates::decoder::Decode;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OwnerEnrollmentCapture {
    pub native_head_sequence: i64,
    pub local_state_digest: String,
}

#[derive(Debug, Clone)]
pub struct OwnerEnrollmentInput {
    pub binding: LiveObjectBinding,
    pub relay_database_namespace: String,
    pub captured: OwnerEnrollmentCapture,
    pub journal_cursor: i64,
    pub checkpoint: Vec<u8>,
    pub host_vector: Vec<u8>,
    pub recovery: bool,
}

/// The same observed document at a strictly later restore generation.
pub fn restore_successor(current: &LiveObjectBinding, next: &LiveObjectBinding) -> bool {
    next.restore_fence_generation > current.restore_fence_generation
        && LiveObjectBinding {
            restore_fence_generation: current.restore_fence_generation,
            ..next.clone()
        } == *current
}

/// A restore successor already holds an observed binding; first enrollment must not.
fn native_state(
    conn: &Connection,
    binding: &LiveObjectBinding,
    successor: bool,
) -> Result<(crate::Marker, Vec<u8>), OwnerOutboxError> {
    binding
        .validate_canonical()
        .map_err(OwnerOutboxError::InvalidInput)?;
    let key = key(binding)?;
    let (configured,stopped):(bool,bool) = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM live_device_application_bindings WHERE workspace_id=?1 AND main_version_id=?2 AND object_id=?3) OR EXISTS(SELECT 1 FROM live_owner_adoptions WHERE workspace_id=?1 AND main_version_id=?2 AND object_id=?3), CASE WHEN ?4 THEN 0 ELSE EXISTS(SELECT 1 FROM owner_live_stops WHERE workspace_id=?1 AND main_version_id=?2 AND object_id=?3) END",
        params![key.workspace_id,key.version_id,key.object_id,successor], |r| Ok((r.get(0)?,r.get(1)?)),
    ).map_err(read_sql)?;
    if configured {
        return Err(OwnerOutboxError::ParentMismatch);
    }
    if !successor {
        if stopped {
            return Err(OwnerOutboxError::Frozen);
        }
        super::draft::require_ordinary_write(conn, &key).map_err(collab)?;
    }
    crate::live_update_application::require_restore_open(conn, &key).map_err(collab)?;
    let marker = crate::read_marker_in(conn, &key)
        .map_err(collab)?
        .ok_or(OwnerOutboxError::NotFound)?;
    if marker.content_kind != crate::ContentKind::Richdoc
        || marker.regime != crate::Regime::Replicated
        || marker.lineage_claim_id.as_deref() != Some(&binding.lineage_claim_id)
        || marker.path.as_deref() != Some(&binding.current_path)
    {
        return Err(OwnerOutboxError::ParentMismatch);
    }
    let doc = crate::load_doc_in(conn, &key).map_err(collab)?;
    if doc.has_pending_dependencies() {
        return Err(OwnerOutboxError::ParentMismatch);
    }
    Ok((marker, bounded(&doc)?))
}

pub fn capture_in(
    conn: &Connection,
    binding: &LiveObjectBinding,
) -> Result<OwnerEnrollmentCapture, OwnerOutboxError> {
    capture(conn, binding, false)
}

fn capture(
    conn: &Connection,
    binding: &LiveObjectBinding,
    successor: bool,
) -> Result<OwnerEnrollmentCapture, OwnerOutboxError> {
    let (marker, bytes) = native_state(conn, binding, successor)?;
    Ok(OwnerEnrollmentCapture {
        native_head_sequence: marker.head_update_seq,
        local_state_digest: hex_sha256(&bytes),
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum OwnerEnrollmentPreparation {
    Observed { draft: Box<OwnerDraftDescriptor> },
    Capture { captured: OwnerEnrollmentCapture },
}

pub fn prepare_in(
    conn: &Connection,
    binding: &LiveObjectBinding,
    namespace: &str,
    recovery: bool,
) -> Result<OwnerEnrollmentPreparation, OwnerOutboxError> {
    validate_identifier(namespace, "invalid relay namespace")?;
    if let Some(previous) = if recovery {
        recovery_previous(conn, binding)?
    } else {
        None
    } {
        if previous.relay_database_namespace != namespace {
            return Err(OwnerOutboxError::ParentMismatch);
        }
        return Ok(OwnerEnrollmentPreparation::Capture {
            captured: capture(conn, binding, true)?,
        });
    }
    if let Some(draft) = super::draft::descriptor_for_key_in(conn, &key(binding)?)? {
        if draft.relay_database_namespace != namespace {
            return Err(OwnerOutboxError::ParentMismatch);
        }
        // A later restore generation only captures here. Its authenticated host
        // cut commits the transition in `enroll_in_tx`.
        if restore_successor(&draft.binding, binding) {
            return Ok(OwnerEnrollmentPreparation::Capture {
                captured: capture(conn, binding, true)?,
            });
        }
        if draft.binding != *binding {
            return Err(OwnerOutboxError::ParentMismatch);
        }
        return Ok(OwnerEnrollmentPreparation::Observed {
            draft: Box::new(draft),
        });
    }
    Ok(OwnerEnrollmentPreparation::Capture {
        captured: capture_in(conn, binding)?,
    })
}

fn recovery_previous(
    conn: &Connection,
    next: &LiveObjectBinding,
) -> Result<Option<ObservedOwnerBinding>, OwnerOutboxError> {
    next.validate_canonical()
        .map_err(OwnerOutboxError::InvalidInput)?;
    let mut stmt = conn.prepare("SELECT binding_json FROM ydoc_owner_bindings WHERE workspace_id=?1 AND main_version_id=?2 AND object_id=?3 LIMIT 2").map_err(read_sql)?;
    let rows = stmt
        .query_map(
            params![next.workspace_id, next.main_version_id, next.object_id],
            |r| r.get::<_, String>(0),
        )
        .map_err(read_sql)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(read_sql)?;
    if rows.is_empty() {
        return Ok(None);
    }
    if rows.len() != 1 {
        return Err(OwnerOutboxError::Frozen);
    }
    let old: LiveObjectBinding =
        serde_json::from_str(&rows[0]).map_err(|_| OwnerOutboxError::Corrupt)?;
    if old.workspace_id != next.workspace_id
        || old.main_version_id != next.main_version_id
        || old.object_id != next.object_id
        || old.lineage_claim_id != next.lineage_claim_id
        || next.restore_fence_generation < old.restore_fence_generation
    {
        return Err(OwnerOutboxError::ParentMismatch);
    }
    let parent = find_parent_for_binding(conn, &old)?;
    if parent
        .as_ref()
        .is_none_or(|p| p.state != OwnerOutboxState::Quarantined)
    {
        return Ok(None);
    }
    require_recoverable_parent(conn, &old)?;
    super::draft::read_observed_in(conn, &old)?
        .map(Some)
        .ok_or(OwnerOutboxError::NotFound)
}

fn require_recoverable_parent(
    conn: &Connection,
    binding: &LiveObjectBinding,
) -> Result<ParentRow, OwnerOutboxError> {
    let parent = find_parent_for_binding(conn, binding)?.ok_or(OwnerOutboxError::NotFound)?;
    if parent.binding != *binding
        || parent.state != OwnerOutboxState::Quarantined
        || !matches!(
            parent.quarantine_reason.as_deref(),
            Some("stale-binding" | "restore-fenced" | "binding-changed")
        )
    {
        return Err(OwnerOutboxError::Frozen);
    }
    Ok(parent)
}

/// A changed capture, invalid host cut, or exceeded bound rolls back the whole
/// transition. The outbox and accepted snapshot become durable together.
pub fn enroll_in_tx(
    tx: &rusqlite::Transaction<'_>,
    workspace: &str,
    input: &OwnerEnrollmentInput,
    limits: &OwnerOutboxLimits,
    now_ms: i64,
) -> Result<OwnerDraftDescriptor, OwnerOutboxError> {
    require_workspace(workspace, &input.binding.workspace_id)?;
    validate_identifier(&input.relay_database_namespace, "invalid relay namespace")?;
    validate_digest(&input.captured.local_state_digest)?;
    limits.validate()?;
    if !(0..=9_007_199_254_740_991).contains(&now_ms)
        || !(0..=9_007_199_254_740_991).contains(&input.journal_cursor)
        || input.checkpoint.len() > crate::limits::MAX_YDOC_UPDATE_BYTES
        || input.host_vector.len() > crate::limits::MAX_YDOC_UPDATE_BYTES
    {
        return Err(OwnerOutboxError::InvalidInput(
            "invalid owner enrollment cut",
        ));
    }
    let recovery = if input.recovery {
        recovery_previous(tx, &input.binding)?
    } else {
        None
    };
    let recovering = recovery.is_some();
    let previous = if let Some(previous) = recovery {
        if previous.relay_database_namespace != input.relay_database_namespace {
            return Err(OwnerOutboxError::ParentMismatch);
        }
        Some(previous)
    } else {
        match super::draft::descriptor_for_key_in(tx, &key(&input.binding)?)? {
            Some(draft) if restore_successor(&draft.binding, &input.binding) => {
                if draft.relay_database_namespace != input.relay_database_namespace {
                    return Err(OwnerOutboxError::ParentMismatch);
                }
                Some(super::accepted::current(tx, &draft.binding)?)
            }
            _ => None,
        }
    };
    let (marker, local_bytes) = native_state(tx, &input.binding, previous.is_some())?;
    if marker.head_update_seq != input.captured.native_head_sequence
        || hex_sha256(&local_bytes) != input.captured.local_state_digest
    {
        return Err(OwnerOutboxError::ParentMismatch);
    }
    let host = Ydoc::wire();
    host.apply(&input.checkpoint).map_err(collab)?;
    host.validate_public_baseline(&input.checkpoint)
        .map_err(collab)?;
    crate::replay_parity::prevalidate_state_vector_bytes(&input.host_vector).map_err(collab)?;
    let host_vector = yrs::StateVector::decode_v1(&input.host_vector)
        .map_err(|_| OwnerOutboxError::ParentMismatch)?;
    if host.has_pending_dependencies() || host.state_vector() != host_vector {
        return Err(OwnerOutboxError::ParentMismatch);
    }
    let original = Ydoc::wire();
    original
        .apply(&bounded_blob(tx, &input.binding.lineage_claim_id)?)
        .map_err(collab)?;
    if host.lineage_epoch_tag() != original.lineage_epoch_tag() {
        return Err(OwnerOutboxError::ParentMismatch);
    }
    let checkpoint = bounded(&host)?;
    host.apply(&original.encode_full_state()).map_err(collab)?;
    if host.has_pending_dependencies() || bounded(&host)? != checkpoint {
        return Err(OwnerOutboxError::ParentMismatch);
    }
    if let Some(previous) = previous {
        if recovering {
            let draft = recover_in_tx(
                tx,
                workspace,
                input,
                previous,
                &marker,
                &local_bytes,
                &checkpoint,
                now_ms,
            )?;
            index_frontmatter_in_tx(tx, &input.binding, &host, None, None, now_ms)?;
            return Ok(draft);
        }
        let draft = advance_generation_in_tx(
            tx,
            workspace,
            input,
            previous,
            &marker,
            local_bytes,
            checkpoint,
            now_ms,
        )?;
        index_frontmatter_in_tx(tx, &input.binding, &host, None, None, now_ms)?;
        return Ok(draft);
    }
    host.apply(&local_bytes).map_err(collab)?;
    let merged = bounded(&host)?;
    if host.has_pending_dependencies() || host.lineage_epoch_tag() != original.lineage_epoch_tag() {
        return Err(OwnerOutboxError::ParentMismatch);
    }
    let pending = merged != checkpoint;
    // The host checkpoint holds changes this computer lacks when merging it
    // into the local state changes that state.
    if merged != local_bytes {
        dohc_engine_storage::count_remote_change_in_tx(tx, workspace)?;
    }
    if pending && local_bytes.len() as i64 > limits.max_pending_bytes {
        return Err(OwnerOutboxError::Frozen);
    }
    if pending {
        put_binary_blob_with_sha(tx, &local_bytes, &input.captured.local_state_digest)?;
    }
    let key = key(&input.binding)?;
    let checkpoint_digest = hex_sha256(&checkpoint);
    put_binary_blob_with_sha(tx, &checkpoint, &checkpoint_digest)?;
    let head = install_native_checkpoint_in_tx(
        tx,
        &key,
        &marker,
        &local_bytes,
        &checkpoint,
        &checkpoint_digest,
        &input.host_vector,
        now_ms,
    )?;
    index_frontmatter_in_tx(tx, &input.binding, &host, None, None, now_ms)?;
    let observed = ObservedOwnerBinding {
        binding: input.binding.clone(),
        relay_database_namespace: input.relay_database_namespace.clone(),
        revision: 1,
        accepted_cursor: input.journal_cursor,
        native_head_sequence: head,
        checkpoint_digest,
        limits: limits.clone(),
    };
    super::draft::install_observed_binding_in_tx(tx, workspace, &observed, &checkpoint)?;
    if pending {
        super::draft::append_draft_in_tx(
            tx,
            workspace,
            &input.binding,
            1,
            format!("owner-enrollment:{}", input.captured.local_state_digest),
            local_bytes,
            now_ms,
        )?;
    }
    super::draft::descriptor_for_key_in(tx, &key)?.ok_or(OwnerOutboxError::Corrupt)
}

#[allow(clippy::too_many_arguments)]
fn recover_in_tx(
    tx: &rusqlite::Transaction<'_>,
    workspace: &str,
    input: &OwnerEnrollmentInput,
    previous: ObservedOwnerBinding,
    marker: &crate::Marker,
    local_bytes: &[u8],
    checkpoint: &[u8],
    now_ms: i64,
) -> Result<OwnerDraftDescriptor, OwnerOutboxError> {
    let parent = require_recoverable_parent(tx, &previous.binding)?;
    if input.journal_cursor < previous.accepted_cursor {
        return Err(OwnerOutboxError::ParentMismatch);
    }
    let checkpoint_digest = hex_sha256(checkpoint);
    put_binary_blob_with_sha(tx, checkpoint, &checkpoint_digest)?;
    if checkpoint != local_bytes {
        dohc_engine_storage::count_remote_change_in_tx(tx, workspace)?;
    }
    let head = install_native_checkpoint_in_tx(
        tx,
        &key(&input.binding)?,
        marker,
        local_bytes,
        checkpoint,
        &checkpoint_digest,
        &input.host_vector,
        now_ms,
    )?;
    let revision = previous
        .revision
        .checked_add(1)
        .filter(|n| *n < 9_007_199_254_740_991)
        .ok_or(OwnerOutboxError::Frozen)?;
    tx.execute("UPDATE owner_ydoc_outbox_entries SET pending=0,terminal_blob_digest=update_blob_digest,update_blob_digest=NULL,terminal_reason=?2 WHERE outbox_id=?1 AND pending=1", params![parent.outbox_id,parent.quarantine_reason]).map_err(write_sql)?;
    if previous.binding == input.binding {
        tx.execute("UPDATE owner_ydoc_outboxes SET state='active',pending_bytes=0,oldest_entry_at_ms=NULL,quarantine_reason=NULL,observed_binding_json=NULL WHERE outbox_id=?1", [&parent.outbox_id]).map_err(write_sql)?;
    } else {
        tx.execute("UPDATE owner_ydoc_outboxes SET pending_bytes=0,oldest_entry_at_ms=NULL,observed_binding_json=?2 WHERE outbox_id=?1", params![parent.outbox_id,binding_json(&input.binding)?]).map_err(write_sql)?;
        if let Some(target) = find_parent_for_binding(tx, &input.binding)? {
            if target.state != OwnerOutboxState::Quarantined || target.pending_bytes != 0 {
                return Err(OwnerOutboxError::ParentMismatch);
            }
            require_recoverable_parent(tx, &input.binding)?;
            tx.execute("UPDATE owner_ydoc_outboxes SET state='active',quarantine_reason=NULL,observed_binding_json=NULL WHERE outbox_id=?1", [&target.outbox_id]).map_err(write_sql)?;
        }
    }
    let changed = tx.execute("UPDATE ydoc_owner_bindings SET binding_revision=?5,accepted_cursor=?6,native_head_sequence=?7,checkpoint_digest=?8,binding_json=?10 WHERE workspace_id=?1 AND main_version_id=?2 AND object_id=?3 AND lineage_claim_id=?4 AND binding_revision=?9", params![input.binding.workspace_id,input.binding.main_version_id,input.binding.object_id,input.binding.lineage_claim_id,revision,input.journal_cursor,head,checkpoint_digest,previous.revision,binding_json(&input.binding)?]).map_err(write_sql)?;
    if changed != 1 {
        return Err(OwnerOutboxError::ParentMismatch);
    }
    if previous.checkpoint_digest != checkpoint_digest {
        delete_binary_blob_if_unreferenced(tx, &previous.checkpoint_digest)?;
    }
    super::draft::descriptor_for_key_in(tx, &key(&input.binding)?)?.ok_or(OwnerOutboxError::Corrupt)
}

/// A later restore generation of an observed owner. The authenticated host cut
/// becomes canonical as it is; old-generation work stays quarantined for
/// recovery, and none of it is merged into or queued for the new generation.
#[allow(clippy::too_many_arguments)]
fn advance_generation_in_tx(
    tx: &rusqlite::Transaction<'_>,
    workspace: &str,
    input: &OwnerEnrollmentInput,
    previous: ObservedOwnerBinding,
    marker: &crate::Marker,
    local_bytes: Vec<u8>,
    checkpoint: Vec<u8>,
    now_ms: i64,
) -> Result<OwnerDraftDescriptor, OwnerOutboxError> {
    let old = &previous.binding;
    if input.journal_cursor < previous.accepted_cursor {
        return Err(OwnerOutboxError::ParentMismatch);
    }
    // Native state past the old accepted checkpoint is private work its pending
    // rows may not hold. Retain it in the old generation before quarantine. A
    // queue that takes no more edits, such as one already refused, keeps it
    // without reopening: its refusal stays.
    if local_bytes != bounded_blob(tx, &previous.checkpoint_digest)? {
        let append_key = format!("owner-restore-fenced:{}", input.captured.local_state_digest);
        match find_parent_for_binding(tx, old)? {
            Some(parent) if parent.state != OwnerOutboxState::Active => super::retain_fenced_in_tx(
                tx,
                &parent,
                previous.revision,
                &append_key,
                &local_bytes,
                now_ms,
            )?,
            _ => {
                super::draft::append_draft_in_tx(
                    tx,
                    workspace,
                    old,
                    previous.revision,
                    append_key,
                    local_bytes.clone(),
                    now_ms,
                )?;
            }
        }
    }
    let outboxes = {
        let mut stmt = tx.prepare(
            "SELECT outbox_id FROM owner_ydoc_outboxes WHERE workspace_id=?1 AND main_version_id=?2 AND object_id=?3 AND lineage_claim_id=?4 AND restore_fence_generation=?5 AND state!='quarantined'",
        ).map_err(read_sql)?;
        let rows = stmt
            .query_map(
                params![
                    old.workspace_id,
                    old.main_version_id,
                    old.object_id,
                    old.lineage_claim_id,
                    old.restore_fence_generation
                ],
                |row| row.get::<_, String>(0),
            )
            .map_err(read_sql)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(read_sql)?
    };
    for outbox_id in outboxes {
        quarantine_in_tx(
            tx,
            workspace,
            &OwnerOutboxQuarantineInput {
                outbox_id,
                reason: "restore-fenced".into(),
                observed_binding: Some(input.binding.clone()),
            },
            now_ms,
        )?;
    }
    let key = key(&input.binding)?;
    let checkpoint_digest = hex_sha256(&checkpoint);
    put_binary_blob_with_sha(tx, &checkpoint, &checkpoint_digest)?;
    if checkpoint != local_bytes {
        dohc_engine_storage::count_remote_change_in_tx(tx, workspace)?;
    }
    let head = install_native_checkpoint_in_tx(
        tx,
        &key,
        marker,
        &local_bytes,
        &checkpoint,
        &checkpoint_digest,
        &input.host_vector,
        now_ms,
    )?;
    let revision = previous
        .revision
        .checked_add(1)
        .filter(|n| *n < 9_007_199_254_740_991)
        .ok_or(OwnerOutboxError::Frozen)?;
    let changed = tx.execute(
        "UPDATE ydoc_owner_bindings SET binding_json=?5,binding_revision=?6,accepted_cursor=?7,native_head_sequence=?8,checkpoint_digest=?9 WHERE workspace_id=?1 AND main_version_id=?2 AND object_id=?3 AND lineage_claim_id=?4 AND binding_json=?10 AND binding_revision=?11",
        params![old.workspace_id,old.main_version_id,old.object_id,old.lineage_claim_id,binding_json(&input.binding)?,revision,input.journal_cursor,head,checkpoint_digest,binding_json(old)?,previous.revision],
    ).map_err(write_sql)?;
    if changed != 1 {
        return Err(OwnerOutboxError::ParentMismatch);
    }
    // Old-generation work can build on accepted updates only the old checkpoint
    // holds, so each queue still waiting keeps it, and its blob stays referenced.
    tx.execute(
        "UPDATE owner_ydoc_outboxes SET kept_checkpoint_digest=?6 WHERE workspace_id=?1 AND main_version_id=?2 AND object_id=?3 AND lineage_claim_id=?4 AND restore_fence_generation=?5 AND pending_bytes>0",
        params![old.workspace_id,old.main_version_id,old.object_id,old.lineage_claim_id,old.restore_fence_generation,previous.checkpoint_digest],
    ).map_err(write_sql)?;
    if previous.checkpoint_digest != checkpoint_digest {
        delete_binary_blob_if_unreferenced(tx, &previous.checkpoint_digest)?;
    }
    super::draft::descriptor_for_key_in(tx, &key)?.ok_or(OwnerOutboxError::Corrupt)
}

/// Keep the original seq-0 snapshot and its exact claimed source. The new
/// snapshot replaces current native state, without resetting head identity.
#[allow(clippy::too_many_arguments)]
fn install_native_checkpoint_in_tx(
    tx: &rusqlite::Transaction<'_>,
    key: &crate::DocKey,
    marker: &crate::Marker,
    local_bytes: &[u8],
    checkpoint: &[u8],
    checkpoint_digest: &str,
    host_vector: &[u8],
    now_ms: i64,
) -> Result<i64, OwnerOutboxError> {
    let head = if local_bytes == checkpoint {
        marker.head_update_seq
    } else {
        marker
            .head_update_seq
            .checked_add(1)
            .filter(|n| *n <= 9_007_199_254_740_991)
            .ok_or(OwnerOutboxError::Frozen)?
    };
    if head != marker.head_update_seq {
        crate::author_coverage::reset_in(tx, key, true).map_err(collab)?;
        let vector_digest = hex_sha256(host_vector);
        put_binary_blob_with_sha(tx, host_vector, &vector_digest)?;
        tx.execute("INSERT INTO ydoc_snapshots (workspace_id,version_id,object_id,up_to_seq,snapshot_blob_sha256,state_vector_blob_sha256,recorded_at_ms) VALUES (?1,?2,?3,?4,?5,?6,?7)",params![key.workspace_id,key.version_id,key.object_id,head,checkpoint_digest,vector_digest,now_ms]).map_err(write_sql)?;
        tx.execute(
            "DELETE FROM ydoc_updates WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
            params![key.workspace_id, key.version_id, key.object_id],
        )
        .map_err(write_sql)?;
        tx.execute("DELETE FROM ydoc_snapshots WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3 AND up_to_seq>0 AND up_to_seq<?4",params![key.workspace_id,key.version_id,key.object_id,head]).map_err(write_sql)?;
        tx.execute("UPDATE ydoc_docs SET head_update_seq=?4,head_snapshot_seq=?4,settled_update_seq=NULL,updated_at_ms=?5 WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",params![key.workspace_id,key.version_id,key.object_id,head,now_ms]).map_err(write_sql)?;
    }
    Ok(head)
}

#[cfg(test)]
#[path = "enrollment_tests.rs"]
mod tests;
