use dohc_engine_collab::{ClaimOutcome, ContentKind, DocKey};
use rusqlite::Transaction;

use crate::{SyncError, journal_local_op_in_tx, workspace_replicates_with_relay_in_tx};

/// Why a lineage that could otherwise share does not: it is too large to
/// encode as a base. Names the constraint, the configured limit, the unit and
/// the observed size, because the caller cannot act on "it did not happen".
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SharingDeclined {
    pub path: String,
    pub constraint: &'static str,
    pub limit_bytes: usize,
    pub observed_bytes: usize,
}

impl std::fmt::Display for SharingDeclined {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "File {} is too large to share. {} allows {} bytes; the encoded base uses {} bytes. \
             The edit is saved. Reduce the file to share it.",
            self.path, self.constraint, self.limit_bytes, self.observed_bytes
        )
    }
}

/// What an origination attempt decided.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BaseOrigination {
    /// The lineage originated and its base was journaled.
    Originated { base_snapshot_sha: String },
    /// Nothing to originate, and nothing to report: no marker, a base already
    /// claimed, a workspace that does not replicate, or an unresolved dependency.
    NothingToDo,
    /// The lineage could have originated and did not. The edit still commits.
    Declined(SharingDeclined),
}

/// Claim and journal the base that originates `key`'s replicated lineage.
pub fn originate_ydoc_base_in_tx(
    tx: &Transaction<'_>,
    key: &DocKey,
    path: &str,
    now_ms: i64,
) -> Result<BaseOrigination, SyncError> {
    let Some(marker) =
        dohc_engine_collab::read_marker_in_tx(tx, key).map_err(SyncError::corrupt)?
    else {
        return Ok(BaseOrigination::NothingToDo);
    };
    if marker.lineage_claim_status.has_claimed_base() {
        return Ok(BaseOrigination::NothingToDo);
    }
    // Check replication before the claim. A later refusal in the caller's
    // append or backfill transaction would otherwise roll back real work with
    // a claim that should never have started.
    if !workspace_replicates_with_relay_in_tx(tx, &key.workspace_id)? {
        return Ok(BaseOrigination::NothingToDo);
    }
    let Some(encoded) =
        dohc_engine_collab::encode_origination_base_in_tx(tx, key).map_err(SyncError::corrupt)?
    else {
        return Ok(BaseOrigination::NothingToDo);
    };
    // #549 owns the measured base-specific bound that replaces this check.
    // The decline is REPORTED, not silent (#632): it is the one branch here a
    // user can act on, and it is indistinguishable from the four benign ones
    // unless it says so.
    if encoded.base.len() > dohc_engine_collab::limits::MAX_YDOC_UPDATE_BYTES {
        return Ok(BaseOrigination::Declined(SharingDeclined {
            path: path.to_owned(),
            constraint: "MAX_YDOC_UPDATE_BYTES",
            limit_bytes: dohc_engine_collab::limits::MAX_YDOC_UPDATE_BYTES,
            observed_bytes: encoded.base.len(),
        }));
    }
    match dohc_engine_collab::claim_base_in_tx(
        tx,
        key,
        marker.content_kind,
        &encoded.base,
        &encoded.state_vector,
        now_ms,
    )
    .map_err(SyncError::corrupt)?
    {
        ClaimOutcome::Claimed { base_snapshot_sha } => {
            journal_local_op_in_tx(
                tx,
                &key.workspace_id,
                "ydoc.update",
                &ydoc_update_payload(key, path, marker.content_kind, &base_snapshot_sha, true),
                now_ms,
            )?;
            Ok(BaseOrigination::Originated { base_snapshot_sha })
        }
        ClaimOutcome::Resumed => Ok(BaseOrigination::NothingToDo),
    }
}

/// Build the one wire payload used by every locally journaled Y.Doc update.
pub fn ydoc_update_payload(
    key: &DocKey,
    path: &str,
    content_kind: ContentKind,
    update_blob_sha256: &str,
    is_base_state: bool,
) -> serde_json::Value {
    serde_json::json!({
        "versionId": key.version_id,
        "objectId": key.object_id,
        "path": path,
        "contentKind": content_kind.as_str(),
        "updateBlobSha256": update_blob_sha256,
        "isBaseState": is_base_state,
    })
}
