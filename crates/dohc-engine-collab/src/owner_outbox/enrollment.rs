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
}

fn native_state(
    conn: &Connection,
    binding: &LiveObjectBinding,
) -> Result<(crate::Marker, Vec<u8>), OwnerOutboxError> {
    binding
        .validate_canonical()
        .map_err(OwnerOutboxError::InvalidInput)?;
    let key = key(binding)?;
    let configured: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM live_device_application_bindings WHERE workspace_id=?1 AND main_version_id=?2 AND object_id=?3)",
        params![key.workspace_id,key.version_id,key.object_id], |r| r.get(0),
    ).map_err(read_sql)?;
    if configured || super::has_adopted_owner_in(conn, &key).map_err(collab)? {
        return Err(OwnerOutboxError::ParentMismatch);
    }
    super::draft::require_ordinary_write(conn, &key).map_err(collab)?;
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
    let (marker, bytes) = native_state(conn, binding)?;
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
) -> Result<OwnerEnrollmentPreparation, OwnerOutboxError> {
    validate_identifier(namespace, "invalid relay namespace")?;
    if let Some(draft) = super::draft::descriptor_for_key_in(conn, &key(binding)?)? {
        if draft.binding != *binding || draft.relay_database_namespace != namespace {
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
    let (marker, local_bytes) = native_state(tx, &input.binding)?;
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
    // Keep the original seq-0 snapshot and its exact claimed source. The new
    // snapshot replaces current native state, without resetting head identity.
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
        crate::author_coverage::reset_in(tx, &key, true).map_err(collab)?;
        let vector_digest = hex_sha256(&input.host_vector);
        put_binary_blob_with_sha(tx, &input.host_vector, &vector_digest)?;
        tx.execute("INSERT INTO ydoc_snapshots (workspace_id,version_id,object_id,up_to_seq,snapshot_blob_sha256,state_vector_blob_sha256,recorded_at_ms) VALUES (?1,?2,?3,?4,?5,?6,?7)",params![key.workspace_id,key.version_id,key.object_id,head,checkpoint_digest,vector_digest,now_ms]).map_err(write_sql)?;
        tx.execute(
            "DELETE FROM ydoc_updates WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
            params![key.workspace_id, key.version_id, key.object_id],
        )
        .map_err(write_sql)?;
        tx.execute("DELETE FROM ydoc_snapshots WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3 AND up_to_seq>0 AND up_to_seq<?4",params![key.workspace_id,key.version_id,key.object_id,head]).map_err(write_sql)?;
        tx.execute("UPDATE ydoc_docs SET head_update_seq=?4,head_snapshot_seq=?4,settled_update_seq=NULL,updated_at_ms=?5 WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",params![key.workspace_id,key.version_id,key.object_id,head,now_ms]).map_err(write_sql)?;
        crate::author_coverage::refresh_identities_in(tx, &key).map_err(collab)?;
    }
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

#[cfg(test)]
#[path = "enrollment_tests.rs"]
mod tests;
