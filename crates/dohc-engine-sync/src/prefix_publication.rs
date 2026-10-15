//! Journal support for the inert native prefix primitive.
use crate::SyncError;
use dohc_engine_collab::{ContentKind, DocKey, LiveObjectBinding, owner_outbox::prefix};
use dohc_engine_domain::ChangeAttribution;
use rusqlite::{OptionalExtension, Transaction, params};

pub fn journal_prefix_moment_in_tx(
    tx: &Transaction<'_>,
    binding: &LiveObjectBinding,
    moment: &str,
    now_ms: i64,
) -> Result<(), SyncError> {
    let (payload, _) =
        crate::outbound::moment_append_payload_in_tx(tx, &binding.workspace_id, moment)?;
    let (origin, seq) = journal_prefix_op_in_tx(tx, binding, "moment.append", &payload, now_ms)?;
    prefix::record_publication_in_tx(tx, binding, &origin, seq, now_ms)
        .map_err(SyncError::corrupt)?;
    Ok(())
}

pub fn journal_prefix_op_in_tx(
    tx: &Transaction<'_>,
    binding: &LiveObjectBinding,
    kind: &str,
    payload: &serde_json::Value,
    now_ms: i64,
) -> Result<(String, i64), SyncError> {
    let mut tagged = payload.clone();
    tagged["release"] = prefix::publication_tag_in(tx, binding).map_err(SyncError::corrupt)?;
    let seq = crate::journal_local_op_in_tx(tx, &binding.workspace_id, kind, &tagged, now_ms)?;
    let origin: String = tx
        .query_row(
            "SELECT origin_id FROM sync_identity WHERE workspace_id=?1",
            [&binding.workspace_id],
            |r| r.get(0),
        )
        .map_err(SyncError::corrupt)?;
    Ok((origin, seq))
}

pub fn journal_prefix_update_in_tx(
    tx: &Transaction<'_>,
    binding: &LiveObjectBinding,
    bytes: &[u8],
    actor: Option<&str>,
    attribution: Option<&ChangeAttribution>,
    now_ms: i64,
) -> Result<Option<(String, i64, bool)>, SyncError> {
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
    let marker = dohc_engine_collab::read_marker_in(tx, &key).map_err(SyncError::corrupt)?;
    let first = marker
        .as_ref()
        .is_some_and(|m| m.head_update_seq == p.accepted_head + 1);
    if first {
        let marker_had_coordinate = marker
            .as_ref()
            .is_some_and(|m| m.base_origin_id.is_some() && m.base_origin_seq.is_some());
        // Sequence zero retains the original lineage checkpoint, not the accepted head.
        let digest: String = tx.query_row("SELECT snapshot_blob_sha256 FROM ydoc_snapshots WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3 AND up_to_seq=0",params![key.workspace_id,key.version_id,key.object_id],|r|r.get(0)).map_err(SyncError::corrupt)?;
        if digest != binding.lineage_claim_id {
            return Err(SyncError::InvalidInput {
                reason: "owner-prefix-base-mismatch",
            });
        }
        let existing: Option<(String,i64)> = tx.query_row("SELECT origin_id,origin_seq FROM replication_log WHERE workspace_id=?1 AND op_kind='ydoc.update' AND json_extract(payload_json,'$.versionId')=?2 AND json_extract(payload_json,'$.objectId')=?3 AND json_extract(payload_json,'$.lineageClaimId')=?4 AND json_extract(payload_json,'$.updateBlobSha256')=?5 AND json_extract(payload_json,'$.contentKind')='richdoc' AND json_extract(payload_json,'$.isBaseState')=1 ORDER BY (origin_id=?6 AND origin_seq=?7) DESC,origin_id,origin_seq LIMIT 1",params![key.workspace_id,key.version_id,key.object_id,binding.lineage_claim_id,digest,marker.as_ref().and_then(|m|m.base_origin_id.as_deref()),marker.as_ref().and_then(|m|m.base_origin_seq)],|r|Ok((r.get(0)?,r.get(1)?))).optional().map_err(SyncError::corrupt)?;
        let (origin, seq, newly_journaled) = match existing {
            Some(coordinate) => (coordinate.0, coordinate.1, false),
            None => journal_prefix_op_in_tx(
                tx,
                binding,
                "ydoc.update",
                &crate::ydoc_update_payload(
                    &key,
                    &binding.current_path,
                    ContentKind::Richdoc,
                    &digest,
                    &binding.lineage_claim_id,
                    None,
                    None,
                    true,
                ),
                now_ms,
            )
            .map(|(origin, seq)| (origin, seq, true))?,
        };
        dohc_engine_collab::record_base_coordinate_in_tx(
            tx,
            dohc_engine_collab::BaseCoordinateRecord {
                key: &key,
                lineage_claim_id: &binding.lineage_claim_id,
                origin_id: &origin,
                origin_seq: seq,
                relay_seq: None,
                now_ms,
            },
        )
        .map_err(SyncError::corrupt)?;
        if newly_journaled || !marker_had_coordinate {
            tx.execute("INSERT OR IGNORE INTO ydoc_base_relay_candidates(workspace_id,version_id,object_id,lineage_claim_id,origin_id,origin_seq) VALUES(?1,?2,?3,?4,?5,?6)",params![key.workspace_id,key.version_id,key.object_id,binding.lineage_claim_id,origin,seq]).map_err(SyncError::persist)?;
        }
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
    journal_prefix_op_in_tx(tx, binding, "ydoc.update", &payload, now_ms)
        .map(|(origin, seq)| Some((origin, seq, true)))
}
