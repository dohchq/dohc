//! Closes this computer's observed-owner state when its document's live lineage is retired.
use super::draft::{bounded, bounded_blob, collab, read_observed_in};
use super::*;
use crate::DocKey;

/// The quarantine reason of a queue whose document's live lineage was retired.
/// Its edits can only be saved as a recovery copy; they are never sent again.
pub const RETIRED_REASON: &str = "retired";

/// Closes every observed-owner binding of `key`, keeping each byte a person may
/// need. Retirement calls it before it deletes the lineage, and the writable
/// open calls it for a binding whose marker is already gone.
///
/// For each binding, every queue of its exact restore generation is set aside
/// under [`RETIRED_REASON`] with the accepted checkpoint its entries build on.
/// Refused and abandoned bytes become pending again, so the recovery copy holds
/// them. Native state that the checkpoint and those entries lack is kept as
/// one more entry. Then the
/// binding and its applied frames go, so publication proof answers `Unbound`.
///
/// Unlike Stop's release, this unbinds even when settlements are pending or a
/// Stop was deferred, because the document they wait for is being deleted.
/// A pending settlement holds no document bytes: it names a published moment
/// that waits for the server's cursor. It stays as it is, and its drain joins
/// the binding, so it never replays into the retired document. A deferred
/// Stop's row goes with the marker it cascades from.
pub fn close_retired_in_tx(
    tx: &rusqlite::Transaction<'_>,
    key: &DocKey,
    now_ms: i64,
) -> Result<(), OwnerOutboxError> {
    let bindings = {
        let mut stmt = tx
            .prepare(
                "SELECT binding_json FROM ydoc_owner_bindings \
                 WHERE workspace_id=?1 AND main_version_id=?2 AND object_id=?3 \
                 ORDER BY lineage_claim_id",
            )
            .map_err(read_sql)?;
        let rows = stmt
            .query_map(
                params![key.workspace_id, key.version_id, key.object_id],
                |row| row.get::<_, String>(0),
            )
            .map_err(read_sql)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(read_sql)?
    };
    if bindings.is_empty() {
        return Ok(());
    }
    let marker = crate::read_marker_in(tx, key).map_err(collab)?;
    for json in bindings {
        let binding: LiveObjectBinding =
            serde_json::from_str(&json).map_err(|_| OwnerOutboxError::Corrupt)?;
        let observed = read_observed_in(tx, &binding)?.ok_or(OwnerOutboxError::Corrupt)?;
        // Native state survives only while the marker still names this lineage.
        let native = match &marker {
            Some(marker)
                if marker.lineage_claim_id.as_deref() == Some(&binding.lineage_claim_id) =>
            {
                Some(crate::load_doc_in(tx, key).map_err(collab)?)
            }
            _ => None,
        };
        let parent = match find_parent_for_binding(tx, &binding)? {
            Some(parent) => Some(parent),
            None => open_closed_outbox_in_tx(tx, &binding, now_ms)?,
        };
        close_generation_in_tx(tx, &binding, &observed.checkpoint_digest)?;
        let native = match native {
            Some(doc) => adds_to(tx, &binding, &observed.checkpoint_digest, &doc)?,
            None => None,
        };
        if let Some(native) = native {
            let parent = parent.ok_or(OwnerOutboxError::Corrupt)?;
            let parent = read_parent(tx, &parent.outbox_id)?.ok_or(OwnerOutboxError::Corrupt)?;
            let append_key = format!("owner-retired:{}", hex_sha256(&native));
            retain_fenced_in_tx(tx, &parent, observed.revision, &append_key, &native, now_ms)?;
        }
        let scope = params![
            binding.workspace_id,
            binding.main_version_id,
            binding.object_id,
            binding.lineage_claim_id
        ];
        tx.execute(
            "DELETE FROM ydoc_owner_applied_frames WHERE workspace_id=?1 AND main_version_id=?2 \
             AND object_id=?3 AND lineage_claim_id=?4",
            scope,
        )
        .map_err(write_sql)?;
        tx.execute(
            "DELETE FROM ydoc_owner_bindings WHERE workspace_id=?1 AND main_version_id=?2 \
             AND object_id=?3 AND lineage_claim_id=?4",
            scope,
        )
        .map_err(write_sql)?;
    }
    Ok(())
}

/// The documents whose observed-owner binding outlived their marker, as a
/// store retired before [`close_retired_in_tx`] existed left them. The
/// writable open closes each in its own transaction, so one it cannot close
/// keeps only its own page.
pub fn stranded_in(conn: &Connection) -> Result<Vec<DocKey>, OwnerOutboxError> {
    let mut stmt = conn
        .prepare(
            "SELECT DISTINCT workspace_id,main_version_id,object_id FROM ydoc_owner_bindings b \
             WHERE NOT EXISTS(SELECT 1 FROM ydoc_docs d WHERE d.workspace_id=b.workspace_id \
               AND d.version_id=b.main_version_id AND d.object_id=b.object_id) \
             ORDER BY workspace_id,main_version_id,object_id",
        )
        .map_err(read_sql)?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(read_sql)?;
    rows.map(|row| {
        let (workspace_id, version_id, object_id) = row.map_err(read_sql)?;
        DocKey::new(workspace_id, version_id, object_id)
            .map_err(|_| OwnerOutboxError::Corrupt)
    })
    .collect()
}

/// Whether `key`'s generation closed through [`close_retired_in_tx`] and no
/// marker revived it. Delivery skips such a binding instead of failing on it.
pub fn retired_in(
    conn: &Connection,
    binding: &LiveObjectBinding,
) -> Result<bool, OwnerOutboxError> {
    conn.query_row(
        "SELECT NOT EXISTS(SELECT 1 FROM ydoc_docs WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3) \
           AND NOT EXISTS(SELECT 1 FROM ydoc_owner_bindings WHERE workspace_id=?1 AND main_version_id=?2 AND object_id=?3) \
           AND EXISTS(SELECT 1 FROM owner_ydoc_outboxes WHERE workspace_id=?1 AND main_version_id=?2 AND object_id=?3 \
             AND lineage_claim_id=?4 AND restore_fence_generation=?5 AND state='quarantined' AND quarantine_reason=?6)",
        params![
            binding.workspace_id,
            binding.main_version_id,
            binding.object_id,
            binding.lineage_claim_id,
            binding.restore_fence_generation,
            RETIRED_REASON
        ],
        |row| row.get(0),
    )
    .map_err(read_sql)
}

/// Sets aside every queue of the binding's exact generation, at any path it
/// had, with the checkpoint its entries build on. A refused or abandoned entry
/// with no receipt becomes pending again: a closed queue is never sent, and the
/// recovery copy reads only pending entries.
fn close_generation_in_tx(
    tx: &rusqlite::Transaction<'_>,
    binding: &LiveObjectBinding,
    checkpoint_digest: &str,
) -> Result<(), OwnerOutboxError> {
    let scope = params![
        binding.workspace_id,
        binding.main_version_id,
        binding.object_id,
        binding.lineage_claim_id,
        binding.restore_fence_generation
    ];
    let outboxes = {
        let mut stmt = tx
            .prepare(
                "SELECT outbox_id FROM owner_ydoc_outboxes WHERE workspace_id=?1 AND main_version_id=?2 \
                 AND object_id=?3 AND lineage_claim_id=?4 AND restore_fence_generation=?5 ORDER BY outbox_id",
            )
            .map_err(read_sql)?;
        let rows = stmt
            .query_map(scope, |row| row.get::<_, String>(0))
            .map_err(read_sql)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(read_sql)?
    };
    for outbox_id in outboxes {
        tx.execute(
            "UPDATE owner_ydoc_outboxes SET state='quarantined',quarantine_reason=?2,retry_delivery_id=NULL,\
             kept_checkpoint_digest=COALESCE(kept_checkpoint_digest,?3) WHERE outbox_id=?1",
            params![outbox_id, RETIRED_REASON, checkpoint_digest],
        )
        .map_err(write_sql)?;
        tx.execute(
            "UPDATE owner_ydoc_outbox_entries SET pending=1,update_blob_digest=terminal_blob_digest,\
             terminal_blob_digest=NULL,terminal_reason=NULL \
             WHERE outbox_id=?1 AND pending=0 AND terminal_blob_digest=update_digest AND accepted_receipt_json IS NULL",
            [&outbox_id],
        )
        .map_err(write_sql)?;
        refresh_pending_in_tx(tx, &outbox_id)?;
    }
    Ok(())
}

/// An empty closed queue at the binding, so delivery can tell this generation
/// was retired. A lineage whose base blob is gone gets none.
fn open_closed_outbox_in_tx(
    tx: &rusqlite::Transaction<'_>,
    binding: &LiveObjectBinding,
    now_ms: i64,
) -> Result<Option<ParentRow>, OwnerOutboxError> {
    let base = &binding.lineage_claim_id;
    let length: Option<i64> = tx
        .query_row(
            "SELECT byte_length FROM binary_blobs WHERE sha256=?1 AND byte_length=length(bytes) AND byte_length>0",
            [base],
            |row| row.get(0),
        )
        .optional()
        .map_err(read_sql)?;
    let Some(length) = length else {
        return Ok(None);
    };
    let id = outbox_id(binding, base, &binding_json(binding)?);
    insert_outbox(tx, &id, binding, base, length, now_ms)?;
    read_parent(tx, &id)
}

/// The native state, when it holds anything the checkpoint and the kept
/// entries of the binding's generation lack together.
fn adds_to(
    conn: &Connection,
    binding: &LiveObjectBinding,
    checkpoint_digest: &str,
    native: &crate::Ydoc,
) -> Result<Option<Vec<u8>>, OwnerOutboxError> {
    if native.has_pending_dependencies() {
        return Err(OwnerOutboxError::Corrupt);
    }
    let native = bounded(native)?;
    let kept = crate::Ydoc::wire();
    kept.apply(&bounded_blob(conn, checkpoint_digest)?)
        .map_err(collab)?;
    let digests = {
        let mut stmt = conn
            .prepare(
                "SELECT e.update_blob_digest FROM owner_ydoc_outbox_entries e \
                 JOIN owner_ydoc_outboxes o ON o.outbox_id=e.outbox_id \
                 WHERE o.workspace_id=?1 AND o.main_version_id=?2 AND o.object_id=?3 \
                   AND o.lineage_claim_id=?4 AND o.restore_fence_generation=?5 AND e.pending=1 \
                 ORDER BY o.created_at_ms,o.outbox_id,e.sequence",
            )
            .map_err(read_sql)?;
        let rows = stmt
            .query_map(
                params![
                    binding.workspace_id,
                    binding.main_version_id,
                    binding.object_id,
                    binding.lineage_claim_id,
                    binding.restore_fence_generation
                ],
                |row| row.get::<_, String>(0),
            )
            .map_err(read_sql)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(read_sql)?
    };
    for digest in digests {
        kept.apply(&bounded_blob(conn, &digest)?).map_err(collab)?;
    }
    let before = bounded(&kept)?;
    kept.apply(&native).map_err(collab)?;
    Ok((bounded(&kept)? != before).then_some(native))
}
