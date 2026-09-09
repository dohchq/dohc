//! Ordinary queued content may leave the device only with native accepted proof.
use super::draft::{bounded, collab};
use super::*;
use crate::{DocKey, Ydoc};

#[derive(Clone, Copy)]
pub enum PublicationContentKind {
    Ydoc,
    Projection,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PublicationProof {
    Unbound,
    Contained,
    NotContained,
    BudgetExhausted,
}

/// Unbound means this exact native object has never been owner-bound. NotContained keeps
/// its immutable origin coordinate pending. Imported audit history is not read.
pub fn contains_in(
    conn: &Connection,
    key: &DocKey,
    path: &str,
    lineage: Option<&str>,
    kind: PublicationContentKind,
    digest: &str,
    remaining: &mut usize,
) -> Result<PublicationProof, OwnerOutboxError> {
    validate_digest(digest)?;
    let bound:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM live_device_application_bindings WHERE workspace_id=?1 AND main_version_id=?2 AND object_id=?3) OR EXISTS(SELECT 1 FROM ydoc_owner_bindings WHERE workspace_id=?1 AND main_version_id=?2 AND object_id=?3)", params![key.workspace_id,key.version_id,key.object_id],|r|r.get(0)).map_err(read_sql)?;
    if !bound {
        return Ok(PublicationProof::Unbound);
    }
    let mut budget_exhausted = false;
    let proof = (|| -> Result<bool, OwnerOutboxError> {
        let (binding, namespace, accepted) = if let Some(draft) =
            super::draft::descriptor_for_key_in(conn, key)?
        {
            let observed = super::accepted::current(conn, &draft.binding)?;
            let checkpoint = read_blob(
                conn,
                &observed.checkpoint_digest,
                remaining,
                &mut budget_exhausted,
            )?;
            let doc = Ydoc::wire();
            doc.apply(&checkpoint).map_err(collab)?;
            (observed.binding, observed.relay_database_namespace, doc)
        } else {
            crate::live_update_application::read_native_accepted_in(conn, key, remaining)
                    .map_err(|error| {
                        budget_exhausted = matches!(error, crate::live_update_application::ApplicationError::ConfiguredByteBudgetExceeded);
                        OwnerOutboxError::Frozen
                    })?
                    .ok_or(OwnerOutboxError::Frozen)?
        };
        if binding.current_path != path
            || lineage.is_some_and(|id| id != binding.lineage_claim_id)
            || accepted.has_pending_dependencies()
        {
            return Ok(false);
        }
        crate::live_update_application::require_restore_open(conn, key).map_err(collab)?;
        match kind {
            PublicationContentKind::Ydoc => {
                let update = read_blob(conn, digest, remaining, &mut budget_exhausted)?;
                let before = bounded(&accepted)?;
                accepted.apply(&update).map_err(collab)?;
                Ok(!accepted.has_pending_dependencies() && bounded(&accepted)? == before)
            }
            PublicationContentKind::Projection => {
                // Native bootstrap/adoption sources and audited settlements retain
                // exact projection digests even after accepted state advances.
                let proved:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM live_device_bootstraps WHERE relay_database_namespace=?1 AND workspace_id=?2 AND main_version_id=?3 AND object_id=?4 AND lineage_claim_id=?5 AND projected_markdown_digest=?6 AND binding_json=?7) OR EXISTS(SELECT 1 FROM live_owner_adoptions WHERE relay_database_namespace=?1 AND workspace_id=?2 AND main_version_id=?3 AND object_id=?4 AND lineage_claim_id=?5 AND source_digest=?6 AND binding_json=?7) OR EXISTS(SELECT 1 FROM live_device_settlements WHERE relay_database_namespace=?1 AND workspace_id=?2 AND main_version_id=?3 AND object_id=?4 AND lineage_claim_id=?5 AND markdown_digest=?6 AND binding_json=?7)",params![namespace,key.workspace_id,key.version_id,key.object_id,binding.lineage_claim_id,digest,binding_json(&binding)?],|r|r.get(0)).map_err(read_sql)?;
                if proved {
                    return Ok(true);
                }
                let projection = accepted
                    .project(crate::ContentKind::Richdoc)
                    .map_err(collab)?;
                if hex_sha256(projection.content.as_bytes()) == digest {
                    return Ok(true);
                }
                // Initial observed enrollment proves that the original claimed
                // base is contained, including its delete set, before installing.
                let original = Ydoc::wire();
                original
                    .apply(&read_blob(
                        conn,
                        &binding.lineage_claim_id,
                        remaining,
                        &mut budget_exhausted,
                    )?)
                    .map_err(collab)?;
                let before = bounded(&accepted)?;
                accepted.apply(&bounded(&original)?).map_err(collab)?;
                if accepted.has_pending_dependencies() || bounded(&accepted)? != before {
                    return Ok(false);
                }
                Ok(hex_sha256(
                    original
                        .project(crate::ContentKind::Richdoc)
                        .map_err(collab)?
                        .content
                        .as_bytes(),
                ) == digest)
            }
        }
    })();
    // Failure to prove containment never uploads the bytes. Durable corruption
    // remains recoverable at the original queued coordinate.
    Ok(if budget_exhausted {
        PublicationProof::BudgetExhausted
    } else if proof.unwrap_or(false) {
        PublicationProof::Contained
    } else {
        PublicationProof::NotContained
    })
}

fn read_blob(
    conn: &Connection,
    digest: &str,
    remaining: &mut usize,
    budget_exhausted: &mut bool,
) -> Result<Vec<u8>, OwnerOutboxError> {
    let length: Option<i64> = conn.query_row("SELECT byte_length FROM binary_blobs WHERE sha256=?1 AND byte_length=length(bytes) AND byte_length BETWEEN 1 AND ?2", params![digest, crate::limits::MAX_YDOC_UPDATE_BYTES as i64], |r|r.get(0)).optional().map_err(read_sql)?;
    let length = usize::try_from(length.ok_or(OwnerOutboxError::Frozen)?)
        .map_err(|_| OwnerOutboxError::Corrupt)?;
    if length > *remaining {
        *budget_exhausted = true;
        return Err(OwnerOutboxError::Frozen);
    }
    let bytes: Vec<u8> = conn
        .query_row(
            "SELECT bytes FROM binary_blobs WHERE sha256=?1 AND byte_length=length(bytes) AND byte_length=?2",
            params![digest, length as i64],
            |r| r.get(0),
        )
        .map_err(read_sql)?;
    *remaining = remaining.saturating_sub(bytes.len());
    if hex_sha256(&bytes) != digest {
        return Err(OwnerOutboxError::Corrupt);
    }
    Ok(bytes)
}

/// Receive-side echo proof reuses the already hydrated, bounded incoming update.
/// One accepted checkpoint read is bounded by the same public document limit.
pub fn contains_observed_update_in(
    conn: &Connection,
    key: &DocKey,
    path: &str,
    lineage: &str,
    update: &[u8],
) -> Result<Option<bool>, OwnerOutboxError> {
    let Some(draft) = super::draft::descriptor_for_key_in(conn, key)? else {
        return Ok(None);
    };
    if draft.binding.current_path != path
        || draft.binding.lineage_claim_id != lineage
        || update.len() > crate::limits::MAX_YDOC_UPDATE_BYTES
    {
        return Ok(Some(false));
    }
    let observed = super::accepted::current(conn, &draft.binding)?;
    let checkpoint = super::draft::bounded_blob(conn, &observed.checkpoint_digest)?;
    let doc = Ydoc::wire();
    doc.apply(&checkpoint).map_err(collab)?;
    if doc.has_pending_dependencies() {
        return Err(OwnerOutboxError::Corrupt);
    }
    let before = bounded(&doc)?;
    doc.apply(update).map_err(collab)?;
    Ok(Some(
        !doc.has_pending_dependencies() && bounded(&doc)? == before,
    ))
}
