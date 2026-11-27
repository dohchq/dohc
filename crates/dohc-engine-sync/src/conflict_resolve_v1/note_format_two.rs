use super::*;
use dohc_engine_collab::ydoc::without_final_markdown_newline;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FormatTwoConversion {
    Converted,
    NothingToConvert,
    NotNow(&'static str),
    DoesNotFit,
}

pub(crate) const CONVERSION_ID_PREFIX: &str = "note-format-two-";
pub(crate) const CONVERSION_BASE_PENDING: &str = "note-format-two-base-pending";
pub(crate) const CONVERSION_PENDING: &str = "note-format-two-pending";

const WAITS: [(&str, &str); 5] = [
    (
        "ydoc-deferred-updates-pending",
        "SELECT 1 FROM ydoc_deferred_updates WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
    ),
    (
        "ydoc-artifact-pending",
        "SELECT 1 FROM ydoc_pending_artifacts WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
    ),
    (
        "open-conflict",
        "SELECT 1 FROM conflicts WHERE workspace_id=?1 AND target_version_id=?2 AND status='open' \
         AND (current_object_id=?3 OR incoming_object_id=?3)",
    ),
    (
        "held",
        "SELECT 1 FROM capture_file_holds WHERE workspace_id=?1 AND source_version_id=?2 AND object_id=?3",
    ),
    (
        "unsent-edit",
        "SELECT 1 FROM replication_log l WHERE l.workspace_id=?1 AND l.imported=0 \
         AND json_extract(l.payload_json,'$.versionId')=?2 \
         AND json_extract(l.payload_json,'$.objectId')=?3 \
         AND l.origin_seq>COALESCE((SELECT p.pushed_seq FROM sync_relay_push_state p \
           WHERE p.workspace_id=l.workspace_id AND p.origin_id=l.origin_id),-1)",
    ),
];

/// Replace a format-1 note's Y.Doc with a format-2 successor holding the same
/// text, and queue the `conflict.resolve` that hands it to every peer.
pub fn convert_note_to_format_two_in_tx(
    tx: &Transaction<'_>,
    key: &DocKey,
    leases: &dyn LeaseProbe,
    now_ms: i64,
) -> Result<FormatTwoConversion, SyncError> {
    use FormatTwoConversion::{Converted, DoesNotFit, NotNow, NothingToConvert};
    if dohc_engine_collab::new_note_schema_version(ContentKind::Richdoc) != 2 {
        return Ok(NotNow("note-format-two-off"));
    }
    let Some(marker) = dohc_engine_collab::read_marker_in(tx, key)
        .map_err(map_local_collab_error)?
        .filter(|marker| marker.content_kind == ContentKind::Richdoc)
    else {
        return Ok(NothingToConvert);
    };
    let Some(predecessor_claim_id) = marker
        .lineage_claim_id
        .clone()
        .filter(|_| marker.lineage_claim_status == LineageClaimStatus::Exact)
    else {
        return Ok(NotNow("ydoc-lineage-unclaimed"));
    };
    let doc = dohc_engine_collab::load_doc_in(tx, key).map_err(map_local_collab_error)?;
    if doc.note_schema_version() == 2 {
        return Ok(NothingToConvert);
    }
    if leases.is_live(key) || live_document_bound(tx, key)? {
        return Ok(NotNow("ydoc-session-live"));
    }
    if doc.has_pending_dependencies() {
        return Ok(NotNow("ydoc-incomplete-lineage"));
    }
    for (reason, waiting) in WAITS {
        let waits: bool = tx
            .query_row(
                &format!("SELECT EXISTS({waiting})"),
                params![key.workspace_id, key.version_id, key.object_id],
                |row| row.get(0),
            )
            .map_err(SyncError::corrupt)?;
        if waits {
            return Ok(NotNow(reason));
        }
    }
    let path: Option<String> = tx
        .query_row(
            "SELECT path FROM snapshots WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
            params![key.workspace_id, key.version_id, key.object_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(SyncError::corrupt)?;
    let Some(path) = path else {
        return Ok(NothingToConvert);
    };
    let state = select_snapshot_by_path_in_tx(tx, &key.workspace_id, &key.version_id, &path)
        .map_err(map_local_domain_error)?;
    let Some(snapshot) = state.snapshot.as_ref() else {
        return Ok(NothingToConvert);
    };
    let (text, text_sha256) = (&snapshot.text, &snapshot.blob_sha256);
    let settled = settled_source(&doc, text).is_some_and(|source| {
        source == *text || without_final_markdown_newline(&source) == Some(text.as_str())
    });
    if marker.path.as_deref().is_some_and(|stored| stored != path) || !settled {
        return Ok(NotNow("ydoc-unsettled"));
    }
    let head = head_from_conflict_side(&state, 0, None)?;
    let predecessor_state_vector_sha256 =
        dohc_engine_storage::hex_sha256(&doc.encode_state_vector());
    let predecessor_delete_set_sha256 = dohc_engine_storage::hex_sha256(&doc.encode_delete_set());
    let conflict_id = conversion_id(
        key,
        &predecessor_claim_id,
        &predecessor_state_vector_sha256,
        &predecessor_delete_set_sha256,
    );
    let identity = SuccessorIdentity::derive_with_schema_version(
        SuccessorIdentityInput {
            key,
            predecessor_claim_id: &predecessor_claim_id,
            predecessor_state_vector_sha256: &predecessor_state_vector_sha256,
            artifact_op_kind: "note.format-two",
            artifact_id: &conflict_id,
            artifact_preimage_sha256: text_sha256,
            content_kind: ContentKind::Richdoc,
            result_sha256: text_sha256,
        },
        2,
    );
    let Some(successor) = fresh_successor_base(&identity, text)
        .ok()
        .filter(|successor| holds_in_format_two(successor, text))
    else {
        return Ok(DoesNotFit);
    };
    let created = object_created_at_ms(tx, &key.workspace_id, &key.object_id)?;
    let built = build_conflict_resolve_v1(ConflictResolveV1 {
        workspace_id: key.workspace_id.clone(),
        conflict_id,
        chosen_from: ResolveChoiceV1::Current,
        resolution: ResolutionV1::KeptCurrent,
        target_version_id: key.version_id.clone(),
        source_version_id: key.version_id.clone(),
        paths: vec![path.clone()],
        current: head.clone(),
        incoming: head.clone(),
        result: head,
        effect_context: EffectContextV1 {
            recorded_at_ms: now_ms,
            metadata: MetadataV1 {
                origin: "sync".to_owned(),
                summary: None,
                correlation_id: None,
            },
            author: None,
            current_object_created_at_ms: Some(created),
            result_object_created_at_ms: Some(created),
        },
        effects: Vec::new(),
        lineage_transition: lineage_transition(&LocalLineagePlan::ExactSuccessor {
            key: key.clone(),
            predecessor_claim_id: predecessor_claim_id.clone(),
            predecessor_state_vector_sha256: predecessor_state_vector_sha256.clone(),
            predecessor_delete_set_sha256,
            path: path.clone(),
            successor: successor.clone(),
        })?,
        exported_before: None,
    })?;
    let pre_effect_moment_order = tx
        .query_row(
            "SELECT COALESCE(MAX(moment_order),0) FROM moments WHERE workspace_id=?1",
            [&key.workspace_id],
            |row| row.get::<_, i64>(0),
        )
        .map_err(SyncError::corrupt)?;
    dohc_engine_collab::replace_lineage_with_successor_in_tx(
        tx,
        SuccessorReplacement {
            key,
            expected_predecessor_claim_id: &predecessor_claim_id,
            expected_predecessor_state_vector_sha256: &predecessor_state_vector_sha256,
            path: &path,
            successor: &successor,
            scene_result: None,
            author: SuccessorAuthor::default(),
            now_ms,
        },
    )
    .map_err(map_successor_collab_error)?;
    crate::conflict_outbox::persist_local_conflict_resolve_v1_in_tx(
        tx,
        &built,
        pre_effect_moment_order,
    )?;
    Ok(Converted)
}

fn conversion_id(key: &DocKey, claim: &str, state_vector: &str, delete_set: &str) -> String {
    let cut = json!([
        key.workspace_id,
        key.version_id,
        key.object_id,
        claim,
        state_vector,
        delete_set,
    ]);
    format!(
        "{CONVERSION_ID_PREFIX}{}",
        dohc_engine_storage::hex_sha256(cut.to_string().as_bytes())
    )
}

fn settled_source(doc: &dohc_engine_collab::Ydoc, file: &str) -> Option<String> {
    let projection = doc.project(ContentKind::Richdoc).ok()?.content;
    doc.settled_markdown_source(&projection, || Ok::<_, ()>(Some(file.to_owned())))
        .ok()?
        .or(Some(projection))
}

fn in_format_two(update: &[u8]) -> Option<dohc_engine_collab::Ydoc> {
    let doc = dohc_engine_collab::Ydoc::wire();
    let fits = doc.apply(update).is_ok() && doc.note_schema_version() == 2;
    fits.then_some(doc)
}

fn holds_in_format_two(successor: &SuccessorBase, text: &str) -> bool {
    in_format_two(&successor.update)
        .is_some_and(|doc| settled_source(&doc, text).as_deref() == Some(text))
}

pub(super) enum Received {
    NotAConversion,
    Conversion,
    NothingToInstall,
}

pub(super) fn received(
    tx: &Transaction<'_>,
    payload: &ConflictResolveV1,
) -> Result<Received, SyncError> {
    let (true, true, Some(current), Some(transition)) = (
        payload.effects.is_empty() && payload.resolution == ResolutionV1::KeptCurrent,
        payload.target_version_id == payload.source_version_id,
        payload.current.present(),
        payload.lineage_transition.as_ref(),
    ) else {
        return Ok(Received::NotAConversion);
    };
    let Some(successor) = transition.successor.as_ref() else {
        return Ok(Received::NotAConversion);
    };
    let Ok(key) = DocKey::new(
        &payload.workspace_id,
        &payload.target_version_id,
        &current.object_id,
    ) else {
        return Ok(Received::NotAConversion);
    };
    let named = conversion_id(
        &key,
        &transition.predecessor_claim_id,
        &transition.predecessor_state_vector_sha256,
        &transition.predecessor_delete_set_sha256,
    );
    if payload.conflict_id != named {
        return Ok(Received::NotAConversion);
    }
    let update: Option<Vec<u8>> = tx
        .query_row(
            "SELECT bytes FROM binary_blobs WHERE sha256=?1",
            [&successor.update_blob_sha256],
            |row| row.get(0),
        )
        .optional()
        .map_err(SyncError::corrupt)?;
    if update.and_then(|update| in_format_two(&update)).is_none() {
        return Ok(Received::NotAConversion);
    }
    let Some(marker) =
        dohc_engine_collab::read_marker_in(tx, &key).map_err(map_local_collab_error)?
    else {
        if crate::deferred::base_retained(tx, &key, &transition.predecessor_claim_id)? {
            return Err(SyncError::RetryableState {
                reason: CONVERSION_BASE_PENDING,
            });
        }
        return Ok(Received::NothingToInstall);
    };
    let here = marker.lineage_claim_status == LineageClaimStatus::Exact
        && marker.lineage_claim_id.as_deref() == Some(successor.lineage_claim_id.as_str())
        && marker.lineage_parent_claim_id.as_deref()
            == Some(transition.predecessor_claim_id.as_str());
    Ok(if here {
        Received::NothingToInstall
    } else {
        Received::Conversion
    })
}
