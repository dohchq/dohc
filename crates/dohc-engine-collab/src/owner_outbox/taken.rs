//! The owner's own edits a live room took that no save holds yet. The relay
//! keeps them as unsaved room edits; this copy keeps them on the owner's
//! screen through a quit, a crash or a lost connection. A row leaves only when
//! the accepted state holds it, or with its note's release or retirement.
//! Other editors' unsaved rows stay the relay's and are never stored here.
use super::draft::{bounded, bounded_blob, collab};
use super::*;

const SCOPE: &str =
    "workspace_id=?1 AND main_version_id=?2 AND object_id=?3 AND lineage_claim_id=?4";

/// Keep the bytes of a delivery the relay took at `room_position`. Call it in
/// the transaction that takes the delivery off the queue, before the queue
/// releases the delivery's own blob.
pub(super) fn put_in(
    tx: &rusqlite::Transaction<'_>,
    binding: &LiveObjectBinding,
    room_position: i64,
    bytes: &[u8],
) -> Result<(), OwnerOutboxError> {
    let digest =
        dohc_engine_storage::put_binary_blob(tx, bytes).map_err(OwnerOutboxError::Storage)?;
    tx.execute(
        "INSERT INTO ydoc_owner_taken_rows VALUES (?1,?2,?3,?4,?5,?6,?7)",
        params![
            binding.workspace_id,
            binding.main_version_id,
            binding.object_id,
            binding.lineage_claim_id,
            binding.restore_fence_generation,
            room_position,
            digest
        ],
    )
    .map_err(write_sql)?;
    Ok(())
}

/// The note's taken edits in room order, for the owner's draft.
pub(super) fn read_in(
    conn: &Connection,
    binding: &LiveObjectBinding,
) -> Result<Vec<Vec<u8>>, OwnerOutboxError> {
    rows_in(conn, binding, i64::MAX)?
        .into_iter()
        .map(|(_, digest)| bounded_blob(conn, &digest))
        .collect()
}

/// Drop each taken edit the new accepted `checkpoint` at `accepted_cursor`
/// holds: applying it changes nothing. A room save can hold fewer rows than
/// its cursor, so the position alone is not enough.
pub(super) fn prune_held_in(
    tx: &rusqlite::Transaction<'_>,
    binding: &LiveObjectBinding,
    checkpoint: &[u8],
    accepted_cursor: i64,
) -> Result<(), OwnerOutboxError> {
    let candidates = rows_in(tx, binding, accepted_cursor)?;
    if candidates.is_empty() {
        return Ok(());
    }
    let accepted = || -> Result<crate::Ydoc, OwnerOutboxError> {
        let doc = crate::Ydoc::wire();
        doc.apply(checkpoint).map_err(collab)?;
        Ok(doc)
    };
    let before = bounded(&accepted()?)?;
    for (position, digest) in candidates {
        let doc = accepted()?;
        doc.apply(&bounded_blob(tx, &digest)?).map_err(collab)?;
        if doc.has_pending_dependencies() || bounded(&doc)? != before {
            continue;
        }
        tx.execute(
            &format!("DELETE FROM ydoc_owner_taken_rows WHERE {SCOPE} AND room_position=?5"),
            params![
                binding.workspace_id,
                binding.main_version_id,
                binding.object_id,
                binding.lineage_claim_id,
                position
            ],
        )
        .map_err(write_sql)?;
        delete_binary_blob_if_unreferenced(tx, &digest)?;
    }
    Ok(())
}

/// Drop every taken edit of the note's lineage: its binding ends.
pub(super) fn clear_in(
    tx: &rusqlite::Transaction<'_>,
    binding: &LiveObjectBinding,
) -> Result<(), OwnerOutboxError> {
    let scope = params![
        binding.workspace_id,
        binding.main_version_id,
        binding.object_id,
        binding.lineage_claim_id
    ];
    let digests = {
        let mut stmt = tx
            .prepare(&format!(
                "SELECT update_blob_digest FROM ydoc_owner_taken_rows WHERE {SCOPE}"
            ))
            .map_err(read_sql)?;
        let rows = stmt
            .query_map(scope, |row| row.get::<_, String>(0))
            .map_err(read_sql)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(read_sql)?
    };
    tx.execute(
        &format!("DELETE FROM ydoc_owner_taken_rows WHERE {SCOPE}"),
        scope,
    )
    .map_err(write_sql)?;
    for digest in digests {
        delete_binary_blob_if_unreferenced(tx, &digest)?;
    }
    Ok(())
}

/// The current binding's taken edits at or below `through`, in room order.
fn rows_in(
    conn: &Connection,
    binding: &LiveObjectBinding,
    through: i64,
) -> Result<Vec<(i64, String)>, OwnerOutboxError> {
    let mut stmt = conn
        .prepare_cached(&format!(
            "SELECT room_position,update_blob_digest FROM ydoc_owner_taken_rows \
             WHERE {SCOPE} AND restore_fence_generation=?5 AND room_position<=?6 \
             ORDER BY room_position"
        ))
        .map_err(read_sql)?;
    let rows = stmt
        .query_map(
            params![
                binding.workspace_id,
                binding.main_version_id,
                binding.object_id,
                binding.lineage_claim_id,
                binding.restore_fence_generation,
                through
            ],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(read_sql)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(read_sql)
}
