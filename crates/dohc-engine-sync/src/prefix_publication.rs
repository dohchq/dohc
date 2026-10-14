//! Journal support for the inert native prefix primitive.
use crate::SyncError;
use dohc_engine_collab::{ContentKind, DocKey, LiveObjectBinding, owner_outbox::prefix};
use dohc_engine_domain::ChangeAttribution;
use rusqlite::{Transaction, params};

pub fn journal_prefix_moment_in_tx(
    tx: &Transaction<'_>,
    binding: &LiveObjectBinding,
    moment: &str,
    now_ms: i64,
) -> Result<(), SyncError> {
    let (payload, _) =
        crate::outbound::moment_append_payload_in_tx(tx, &binding.workspace_id, moment)?;
    journal_prefix_op_in_tx(tx, binding, "moment.append", &payload, now_ms)?;
    Ok(())
}

pub fn journal_prefix_op_in_tx(
    tx: &Transaction<'_>,
    binding: &LiveObjectBinding,
    kind: &str,
    payload: &serde_json::Value,
    now_ms: i64,
) -> Result<i64, SyncError> {
    let key = DocKey::new(
        &binding.workspace_id,
        &binding.main_version_id,
        &binding.object_id,
    )
    .map_err(SyncError::corrupt)?;
    let p = prefix::progress_in(tx, &key)
        .map_err(SyncError::corrupt)?
        .ok_or(SyncError::InvalidInput {
            reason: "owner-prefix-missing",
        })?;
    let mut tagged = payload.clone();
    tagged["release"] = prefix::publication_tag(binding, &p.release_digest);
    let seq = crate::journal_local_op_in_tx(tx, &binding.workspace_id, kind, &tagged, now_ms)?;
    let origin: String = tx
        .query_row(
            "SELECT origin_id FROM sync_identity WHERE workspace_id=?1",
            [&binding.workspace_id],
            |r| r.get(0),
        )
        .map_err(SyncError::corrupt)?;
    prefix::record_publication_in_tx(tx, binding, &origin, seq, now_ms)
        .map_err(SyncError::corrupt)?;
    Ok(seq)
}

pub fn journal_prefix_update_in_tx(
    tx: &Transaction<'_>,
    binding: &LiveObjectBinding,
    bytes: &[u8],
    actor: Option<&str>,
    attribution: Option<&ChangeAttribution>,
    now_ms: i64,
) -> Result<(), SyncError> {
    let key = DocKey::new(
        &binding.workspace_id,
        &binding.main_version_id,
        &binding.object_id,
    )
    .map_err(SyncError::corrupt)?;
    let p = prefix::progress_in(tx, &key)
        .map_err(SyncError::corrupt)?
        .ok_or(SyncError::InvalidInput {
            reason: "owner-prefix-missing",
        })?;
    let first = dohc_engine_collab::read_marker_in(tx, &key)
        .map_err(SyncError::corrupt)?
        .is_some_and(|m| m.head_update_seq == p.accepted_head + 1);
    let has_base = !first || tx.query_row("SELECT EXISTS(SELECT 1 FROM replication_log WHERE workspace_id=?1 AND op_kind='ydoc.update' AND json_extract(payload_json,'$.versionId')=?2 AND json_extract(payload_json,'$.objectId')=?3 AND json_extract(payload_json,'$.lineageClaimId')=?4 AND json_extract(payload_json,'$.isBaseState')=1)",params![key.workspace_id,key.version_id,key.object_id,binding.lineage_claim_id],|r|r.get::<_,bool>(0)).map_err(SyncError::corrupt)?;
    if !has_base {
        let payload = crate::ydoc_update_payload(
            &key,
            &binding.current_path,
            ContentKind::Richdoc,
            &binding.lineage_claim_id,
            &binding.lineage_claim_id,
            None,
            None,
            true,
        );
        journal_prefix_op_in_tx(tx, binding, "ydoc.update", &payload, now_ms)?;
    }
    let payload = crate::ydoc_update_payload(
        &key,
        &binding.current_path,
        ContentKind::Richdoc,
        &dohc_engine_storage::hex_sha256(bytes),
        &binding.lineage_claim_id,
        actor,
        attribution,
        false,
    );
    journal_prefix_op_in_tx(tx, binding, "ydoc.update", &payload, now_ms)?;
    Ok(())
}
