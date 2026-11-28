use super::*;
use dohc_engine_collab::ydoc::without_final_markdown_newline;
use dohc_engine_collab::{CloseOutcome, CloseProjection, CollabError, Overweight};
use dohc_engine_storage::{EngineStore, FaultInjector, TxnOutcome};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FormatTwoConversion {
    Converted,
    NothingToConvert,
    NotNow(&'static str),
    DoesNotFit(Option<Overweight>),
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
    here: &dyn LeaseProbe,
    elsewhere: &dyn LeaseProbe,
    now_ms: i64,
) -> Result<FormatTwoConversion, SyncError> {
    use FormatTwoConversion::{Converted, DoesNotFit, NotNow};
    if !dohc_engine_collab::ydoc::reads_body_sequence() {
        return Ok(NotNow("note-format-two-off"));
    }
    let Ready {
        marker,
        doc,
        path,
        state,
        text,
        text_sha256,
    } = match ready_to_convert(tx, key, here, elsewhere)? {
        Ok(ready) => ready,
        Err(outcome) => return Ok(outcome),
    };
    let Some(predecessor_claim_id) = marker
        .lineage_claim_id
        .clone()
        .filter(|_| marker.lineage_claim_status == LineageClaimStatus::Exact)
    else {
        return Ok(NotNow("ydoc-lineage-unclaimed"));
    };
    let settled = settled_source(&doc, &text).is_some_and(|source| {
        source == text || without_final_markdown_newline(&source) == Some(text.as_str())
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
    let successor = match successor_in_format_two(
        key,
        &predecessor_claim_id,
        &predecessor_state_vector_sha256,
        &conflict_id,
        &text,
        &text_sha256,
    ) {
        Ok(successor) => successor,
        Err(overweight) => return Ok(DoesNotFit(overweight)),
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

struct Ready {
    marker: dohc_engine_collab::Marker,
    doc: dohc_engine_collab::Ydoc,
    path: String,
    state: ConflictFileState,
    text: String,
    text_sha256: String,
}

fn ready_to_convert(
    conn: &rusqlite::Connection,
    key: &DocKey,
    here: &dyn LeaseProbe,
    elsewhere: &dyn LeaseProbe,
) -> Result<Result<Ready, FormatTwoConversion>, SyncError> {
    use FormatTwoConversion::{NotNow, NothingToConvert};
    let Some(marker) = dohc_engine_collab::read_marker_in(conn, key)
        .map_err(map_local_collab_error)?
        .filter(|marker| marker.content_kind == ContentKind::Richdoc)
        .filter(|marker| {
            marker.head_update_seq > 0 || marker.lineage_claim_status == LineageClaimStatus::Exact
        })
    else {
        return Ok(Err(NothingToConvert));
    };
    let doc = dohc_engine_collab::load_doc_in(conn, key).map_err(map_local_collab_error)?;
    if doc.note_schema_version() == 2 {
        return Ok(Err(NothingToConvert));
    }
    if here.is_live(key) {
        return Ok(Err(NotNow("open-here")));
    }
    if elsewhere.is_live(key) || live_document_bound(conn, key)? {
        return Ok(Err(NotNow("open-elsewhere")));
    }
    if doc.has_pending_dependencies() {
        return Ok(Err(NotNow("ydoc-incomplete-lineage")));
    }
    for (reason, waiting) in WAITS {
        let waits: bool = conn
            .query_row(
                &format!("SELECT EXISTS({waiting})"),
                params![key.workspace_id, key.version_id, key.object_id],
                |row| row.get(0),
            )
            .map_err(SyncError::persist)?;
        if waits {
            return Ok(Err(NotNow(reason)));
        }
    }
    let path: Option<String> = conn
        .query_row(
            "SELECT path FROM snapshots WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
            params![key.workspace_id, key.version_id, key.object_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(SyncError::corrupt)?;
    let Some(path) = path else {
        return Ok(Err(NothingToConvert));
    };
    let state = select_snapshot_by_path_in_tx(conn, &key.workspace_id, &key.version_id, &path)
        .map_err(map_local_domain_error)?;
    let Some((text, text_sha256)) = state
        .snapshot
        .as_ref()
        .map(|snapshot| (snapshot.text.clone(), snapshot.blob_sha256.clone()))
    else {
        return Ok(Err(NothingToConvert));
    };
    Ok(Ok(Ready {
        marker,
        doc,
        path,
        state,
        text,
        text_sha256,
    }))
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

fn successor_in_format_two(
    key: &DocKey,
    claim: &str,
    state_vector: &str,
    artifact_id: &str,
    text: &str,
    text_sha256: &str,
) -> Result<SuccessorBase, Option<Overweight>> {
    let identity = SuccessorIdentity::derive_with_schema_version(
        SuccessorIdentityInput {
            key,
            predecessor_claim_id: claim,
            predecessor_state_vector_sha256: state_vector,
            artifact_op_kind: "note.format-two",
            artifact_id,
            artifact_preimage_sha256: text_sha256,
            content_kind: ContentKind::Richdoc,
            result_sha256: text_sha256,
        },
        2,
    );
    let Ok(successor) = fresh_successor_base(&identity, text) else {
        return Err(None);
    };
    if in_format_two(&successor.update)
        .is_some_and(|doc| settled_source(&doc, text).as_deref() == Some(text))
    {
        Ok(successor)
    } else {
        Err(successor.does_not_fit)
    }
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

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct FormatTwoPass {
    pub off: bool,
    pub converted: Vec<DocKey>,
    pub unchanged: usize,
    pub skipped: Vec<(DocKey, String, &'static str)>,
    pub does_not_fit: Vec<(DocKey, String, Option<Overweight>)>,
    pub failed: Vec<(String, String, String)>,
    pub resume_after: Option<String>,
}

/// The hash a local-only note's file holds when it still matches what the
/// note's pristine seed imported, read from the note's stored path.
pub type FileProof<'a> =
    &'a dyn Fn(&EngineStore, &DocKey, &str) -> Result<Option<String>, CollabError>;

/// Convert up to `budget` of a workspace's main notes whose object id
/// follows `after` to format 2, skipping notes open `here` or `elsewhere`.
/// `resume_after` is the object id the next call starts after.
#[allow(clippy::too_many_arguments)]
pub fn convert_notes_to_format_two(
    store: &mut EngineStore,
    workspace_id: &str,
    after: Option<&str>,
    budget: usize,
    here: &dyn LeaseProbe,
    elsewhere: &dyn LeaseProbe,
    file_proof: FileProof<'_>,
    faults: &dyn FaultInjector,
    now_ms: i64,
) -> Result<FormatTwoPass, SyncError> {
    use FormatTwoConversion::{Converted, DoesNotFit, NotNow, NothingToConvert};
    let mut pass = FormatTwoPass::default();
    if !dohc_engine_collab::ydoc::reads_body_sequence() {
        pass.off = true;
        return Ok(pass);
    }
    if budget == 0 {
        return Err(SyncError::InvalidInput {
            reason: "note-format-two-budget-zero",
        });
    }
    let (notes, offline) = store.read_with(|conn| {
        let notes = conn
            .prepare(
                "SELECT d.object_id, COALESCE(s.path, d.path, d.object_id), \
                 d.regime='local-only' AND d.lineage_claim_status='unclaimed' FROM ydoc_docs d \
                 LEFT JOIN snapshots s ON s.workspace_id=d.workspace_id \
                 AND s.version_id=d.version_id AND s.object_id=d.object_id \
                 WHERE d.workspace_id=?1 AND d.version_id='main' AND d.content_kind='richdoc' \
                 AND (?2 IS NULL OR d.object_id > ?2) ORDER BY d.object_id LIMIT ?3",
            )
            .and_then(|mut statement| {
                statement
                    .query_map(
                        params![
                            workspace_id,
                            after,
                            i64::try_from(budget).unwrap_or(i64::MAX).saturating_add(1)
                        ],
                        |row| {
                            let path = row.get_ref(1)?.as_bytes().map_err(|error| {
                                rusqlite::Error::FromSqlConversionFailure(
                                    1,
                                    rusqlite::types::Type::Text,
                                    Box::new(error),
                                )
                            })?;
                            let path = String::from_utf8_lossy(path).into_owned();
                            Ok((row.get(0)?, path, row.get(2)?))
                        },
                    )?
                    .collect::<Result<Vec<(String, String, bool)>, _>>()
            })
            .map_err(SyncError::corrupt)?;
        Ok::<_, SyncError>((
            notes,
            !crate::workspace_replicates_with_relay(conn, workspace_id)?,
        ))
    })?;
    for (object_id, path, local) in notes.iter().take(budget) {
        pass.resume_after = Some(object_id.clone());
        let key = match DocKey::new(workspace_id, "main", object_id) {
            Ok(key) => key,
            Err(error) => {
                pass.failed
                    .push((object_id.clone(), path.clone(), error.to_string()));
                continue;
            }
        };
        let outcome = if *local && offline {
            drop_local_format_one(store, &key, here, elsewhere, file_proof, faults, now_ms)
        } else {
            store
                .write_with(faults, |tx| {
                    convert_note_to_format_two_in_tx(tx, &key, here, elsewhere, now_ms)
                })
                .and_then(|outcome| match outcome {
                    TxnOutcome::Committed(outcome) => Ok(outcome),
                    TxnOutcome::Crashed { .. } => Err(SyncError::FaultCrash),
                })
        };
        match outcome {
            Ok(Converted) => pass.converted.push(key.clone()),
            Ok(NothingToConvert) => pass.unchanged += 1,
            Ok(NotNow(reason)) => pass.skipped.push((key.clone(), path.clone(), reason)),
            Ok(DoesNotFit(overweight)) => {
                pass.does_not_fit
                    .push((key.clone(), path.clone(), overweight));
            }
            Err(error) if fails_only_the_note(&error) => {
                pass.failed
                    .push((object_id.clone(), path.clone(), error.to_string()));
            }
            Err(error) => return Err(error),
        }
    }
    if notes.len() <= budget {
        pass.resume_after = None;
    }
    Ok(pass)
}

pub(crate) fn fails_only_the_note(error: &SyncError) -> bool {
    use StorageError as Store;
    match error.original() {
        SyncError::Storage(Store::StateCorrupt {
            source: Some(source),
        }) if sqlite_engine_failed(&**source) => false,
        SyncError::Storage(
            Store::StateCorrupt { .. }
            | Store::InvalidInput { .. }
            | Store::BlobIntegrity { .. }
            | Store::BlobTooLarge { .. },
        )
        | SyncError::MarkdownWriteHeld { .. }
        | SyncError::MarkdownWitnessCheckPending { .. }
        | SyncError::MarkdownReaderPending { .. }
        | SyncError::LiveDocumentBindingActive
        | SyncError::SyncedDeletionRevivalRefused
        | SyncError::InvalidInput { .. }
        | SyncError::BaseRefused { .. }
        | SyncError::InputTooLarge { .. }
        | SyncError::CoordinateDiverged
        | SyncError::RetryableState { .. }
        | SyncError::ReleasedLineageUnsettled { .. }
        | SyncError::ValidationPending { .. }
        | SyncError::ProjectionTooLarge { .. }
        | SyncError::MarkdownReaderCapacity
        | SyncError::BlobInvalid
        | SyncError::BlobTooLarge { .. } => true,
        SyncError::Storage(_)
        | SyncError::SequenceGap
        | SyncError::UnsupportedOperation
        | SyncError::ShareBoundaryViolation
        | SyncError::ShareVersionMismatch { .. }
        | SyncError::ShareVersionUnusable { .. }
        | SyncError::FaultCrash
        | SyncError::Cancelled
        | SyncError::Shared { .. } => false,
    }
}

fn sqlite_engine_failed(source: &(dyn std::error::Error + 'static)) -> bool {
    use rusqlite::ErrorCode as Code;
    std::iter::successors(Some(source), |error| error.source())
        .filter_map(|error| error.downcast_ref::<rusqlite::Error>()?.sqlite_error_code())
        .any(|code| {
            matches!(
                code,
                Code::DatabaseCorrupt
                    | Code::NotADatabase
                    | Code::SystemIoFailure
                    | Code::OutOfMemory
                    | Code::CannotOpen
                    | Code::PermissionDenied
                    | Code::ReadOnly
            )
        })
}

fn drop_local_format_one(
    store: &mut EngineStore,
    key: &DocKey,
    here: &dyn LeaseProbe,
    elsewhere: &dyn LeaseProbe,
    file_proof: FileProof<'_>,
    faults: &dyn FaultInjector,
    now_ms: i64,
) -> Result<FormatTwoConversion, SyncError> {
    use FormatTwoConversion::{Converted, DoesNotFit, NotNow};
    let ready = match store.read_with(|conn| ready_to_convert(conn, key, here, elsewhere))? {
        Ok(ready) => ready,
        Err(outcome) => return Ok(outcome),
    };
    if let Err(overweight) =
        successor_in_format_two(key, "", "", "", &ready.text, &ready.text_sha256)
    {
        return Ok(DoesNotFit(overweight));
    }
    if dohc_engine_collab::new_note_schema_version(ContentKind::Richdoc) != 2 {
        return Ok(NotNow("local-new-notes-format-one"));
    }
    let Some(projection) = settled_source(&ready.doc, &ready.text) else {
        return Ok(NotNow("ydoc-unsettled"));
    };
    let materialized_seed_source_sha256 = match ready.marker.path.as_deref() {
        Some(path) => file_proof(store, key, path).map_err(map_local_collab_error)?,
        None => None,
    };
    let witness = CloseProjection {
        sha256: dohc_engine_storage::hex_sha256(projection.as_bytes()),
        materialized_seed_source_sha256,
    };
    match dohc_engine_collab::close_session(store, key, false, Some(&witness), faults, now_ms) {
        Ok(TxnOutcome::Committed(CloseOutcome::Pruned { .. })) => Ok(Converted),
        Ok(TxnOutcome::Committed(_)) | Err(CollabError::UnsettledClose) => {
            Ok(NotNow("ydoc-unsettled"))
        }
        Ok(TxnOutcome::Crashed { .. }) => Err(SyncError::FaultCrash),
        Err(error) => Err(map_local_collab_error(error)),
    }
}
