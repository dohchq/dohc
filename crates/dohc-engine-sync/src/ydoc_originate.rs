//! Origination of a replicated Y.Doc lineage: the base-once claim plus its
//! outbound journal append, in one transaction.
//!
//! #535 built origination and asked for it in exactly one place — the local
//! append. #548 is the observation that an origination DECLINED there is owed
//! later, at the moment its precondition ends, and the paths that end a
//! precondition never asked again. So the ask lives here, callable from every
//! such path:
//!
//! - the local append (`dohc-engine-runtime`'s record-update hook),
//! - the deferred drain and the direct remote apply, which resolve a missing
//!   dependency (`ydoc_apply.rs`),
//! - the first relay-cursor commit, which ends the freshly-enrolled window
//!   (`cursor.rs`; the KNOWN WINDOW note in `journal.rs`).

use dohc_engine_collab::DocKey;
use rusqlite::{OptionalExtension, Transaction, params};

use crate::SyncError;

fn map_collab(error: dohc_engine_collab::CollabError) -> SyncError {
    SyncError::Storage(dohc_engine_storage::StorageError::corrupt_public(error))
}

/// Claim the base that ORIGINATES `key`'s replicated lineage, inside the
/// caller's transaction, and journal it as the lineage's single
/// `isBaseState: true` op. Returns the base blob sha when this call
/// originated, `None` when this lineage must not originate (yet).
///
/// Encoding inside the claim transaction is what makes the claim race-free.
/// SQLite serializes writers, so no append can land between the encode and
/// the claim, and the marker read here is that same transaction's view.
pub fn originate_ydoc_base_in_tx(
    tx: &Transaction<'_>,
    key: &DocKey,
    path: &str,
    now_ms: i64,
) -> Result<Option<String>, SyncError> {
    let Some(marker) = dohc_engine_collab::read_marker_in_tx(tx, key).map_err(map_collab)? else {
        return Ok(None);
    };
    // Base-once. A claimed lineage journals deltas, never a second base.
    if marker.base_claimed {
        return Ok(None);
    }
    // This workspace does not replicate with a relay, so nothing here has a
    // peer: the lineage stays local-only, keeps markdown as its artifact, and
    // prunes on close. A private document must never be promoted to a shared
    // lineage — promotion is irreversible in the log it starts writing.
    //
    // Checked BEFORE the claim because `journal_local_op_in_tx` refuses
    // without an identity, and on the append path that refusal would roll
    // back the user's edit.
    if !crate::journal::workspace_replicates_with_relay_in_tx(tx, &key.workspace_id)? {
        return Ok(None);
    }
    let Some(encoded) =
        dohc_engine_collab::encode_origination_base_in_tx(tx, key).map_err(map_collab)?
    else {
        // An unresolved dependency: a full-state encode would drop the
        // pending row. The apply that resolves the dependency asks again.
        return Ok(None);
    };
    // `claim_base_in_tx` measures the base against MAX_YDOC_UPDATE_BYTES, a
    // cap written for ONE update. A base is a full state, so a lineage that
    // grew local-only past 5 MiB and then reached a synced workspace would
    // fail its promoting write — and on the append path the refusal would
    // roll that valid edit back, and every later one with it.
    //
    // Decline to originate instead. The write commits, the lineage stays
    // local-only, and markdown remains its artifact. #549 owns the measured
    // base-specific bound that replaces this check.
    if encoded.base.len() > dohc_engine_collab::limits::MAX_YDOC_UPDATE_BYTES {
        return Ok(None);
    }
    // The marker's OWN kind, never the caller's: the kind belongs to the
    // lineage, and `claim_base_in_tx` upserts whatever it is handed.
    match dohc_engine_collab::claim_base_in_tx(
        tx,
        key,
        marker.content_kind,
        &encoded.base,
        &encoded.state_vector,
        now_ms,
    )
    .map_err(map_collab)?
    {
        dohc_engine_collab::ClaimOutcome::Claimed { base_snapshot_sha } => {
            crate::journal::journal_local_op_in_tx(
                tx,
                &key.workspace_id,
                "ydoc.update",
                &serde_json::json!({
                    "versionId": key.version_id,
                    "objectId": key.object_id,
                    "path": path,
                    "contentKind": marker.content_kind.as_str(),
                    "updateBlobSha256": base_snapshot_sha,
                    "isBaseState": true,
                }),
                now_ms,
            )?;
            Ok(Some(base_snapshot_sha))
        }
        // Unreachable: `base_claimed` was false in this same transaction and
        // no other writer can interleave. Harmless if it ever is — the
        // lineage has its base, and base-once forbids a second.
        dohc_engine_collab::ClaimOutcome::Resumed => Ok(None),
    }
}

/// Originate every lineage in `workspace_id` that is OWED a base: an
/// unclaimed marker holding durable rows whose origination was declined
/// while the workspace had no relay position. The first relay-cursor commit
/// calls this in its own transaction, ending the KNOWN WINDOW recorded on
/// `workspace_replicates_with_relay_in_tx`. Lineages without a path alias
/// have never projected a head and carry nothing a peer could name; they
/// originate on their next append instead.
pub fn originate_owed_ydoc_lineages_in_tx(
    tx: &Transaction<'_>,
    workspace_id: &str,
    now_ms: i64,
) -> Result<usize, SyncError> {
    let owed: Vec<(String, String, String)> = {
        let mut stmt = tx
            .prepare(
                "SELECT d.version_id, d.object_id, a.path \
                 FROM ydoc_docs d \
                 JOIN path_aliases a \
                   ON a.workspace_id = d.workspace_id \
                  AND a.version_id = d.version_id \
                  AND a.object_id = d.object_id \
                 WHERE d.workspace_id = ?1 AND d.base_claimed = 0 \
                   AND (d.head_update_seq > 0 OR d.head_snapshot_seq > 0) \
                 ORDER BY d.version_id, d.object_id",
            )
            .map_err(SyncError::corrupt)?;
        let rows = stmt
            .query_map([workspace_id], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })
            .map_err(SyncError::corrupt)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(SyncError::corrupt)?
    };
    let mut originated = 0usize;
    for (version_id, object_id, path) in owed {
        let key = DocKey::new(workspace_id.to_owned(), version_id, object_id).map_err(|_| {
            SyncError::InvalidInput {
                reason: "persisted ydoc lineage coordinates are invalid",
            }
        })?;
        if originate_ydoc_base_in_tx(tx, &key, &path, now_ms)?.is_some() {
            originated += 1;
        }
    }
    Ok(originated)
}

/// Whether this cursor commit is the workspace's FIRST — read inside the
/// commit transaction, before the row lands.
pub(crate) fn is_first_relay_cursor_in_tx(
    tx: &Transaction<'_>,
    workspace_id: &str,
) -> Result<bool, SyncError> {
    let existing: Option<i64> = tx
        .query_row(
            "SELECT 1 FROM sync_relay_cursors WHERE workspace_id = ?1",
            params![workspace_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(SyncError::corrupt)?;
    Ok(existing.is_none())
}
