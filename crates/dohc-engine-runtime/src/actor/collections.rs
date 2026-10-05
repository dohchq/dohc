use super::ActorHandle;
use super::capture::{WorkspaceRootGuard, validate_workspace_root};
use super::materialization::SelfWriteRecorder;
use super::ydoc::{ydoc_open_state_on_store, ydoc_record_update_on_store, ydoc_settle_on_store};
use crate::error::RuntimeError;
use dohc_engine_collab::{
    CollabError, ContentKind, DocKey, LeaseRegistry, Regime, WriterDocCache, Ydoc,
};
use dohc_engine_domain::{
    CollectionAdoptionCandidate, CollectionDetails, CollectionListPage,
    CollectionPendingAdoptionCursor, CollectionPendingAdoptionPage, CollectionQuery,
    CollectionQueryResult, CollectionRecordDetails, CollectionRelationCleanupCandidate,
    DomainError, RECORD_ID_FRONTMATTER_KEY, VersionedTextStore,
    collection_record_id_mismatch_in_tx, collection_record_markdown_with_id,
    decline_oversized_collection_adoption_in_tx, delete_collection_adoption_binding_in_tx,
    get_collection, get_collection_record, list_collections, list_pending_collection_adoptions,
    query_collection_records, reconcile_collections_in_tx, set_collection_adoption_state_in_tx,
    synchronize_collection_frontmatter_index_in_tx,
};
use dohc_engine_storage::{EngineStore, FaultInjector, TxnOutcome, hex_sha256};
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

impl ActorHandle {
    #[allow(clippy::too_many_arguments)]
    pub async fn ydoc_adopt_collection_record(
        &self,
        key: DocKey,
        path: String,
        expected_lineage_claim_id: Option<String>,
        root: PathBuf,
        leases: LeaseRegistry,
        self_writes: Arc<dyn SelfWriteRecorder>,
        draft: Option<dohc_engine_collab::owner_outbox::draft::OwnerDraftSnapshot>,
        now_ms: i64,
        token: CancellationToken,
        reservation: Option<Arc<dyn Send + Sync>>,
    ) -> Result<Result<&'static str, dohc_engine_collab::OwnerOutboxError>, RuntimeError> {
        self.run(move |store, cache| {
            let _reservation = reservation;
            if token.is_cancelled() { return Err(RuntimeError::Cancelled); }
            let marker = dohc_engine_collab::read_marker(store, &key)?.ok_or(CollabError::NoMarker)?;
            if marker.lineage_claim_id != expected_lineage_claim_id {
                return Err(CollabError::LineageWriteStale {
                    expected: expected_lineage_claim_id,
                    observed: marker.lineage_claim_id,
                }.into());
            }
            if marker.path.as_deref() != Some(path.as_str()) || marker.content_kind != ContentKind::Richdoc {
                return Err(DomainError::ConflictStaleTarget.into());
            }
            use rusqlite::{OptionalExtension, params};
            let candidate = store.read_with(|conn| {
                conn.query_row("SELECT record_id, collection_path, adoption_state FROM collection_records
                    WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3 AND file_path=?4
                    AND adoption_state IN ('pending','pending-lossless')",
                    params![key.workspace_id, key.version_id, key.object_id, path], |row| {
                        Ok(CollectionAdoptionCandidate {
                            record_id: row.get(0)?, collection_path: row.get(1)?,
                            file_path: path.clone(), object_id: key.object_id.clone(),
                            lossless_insertion_required: row.get::<_, String>(2)? == "pending-lossless",
                        })
                    }).optional().map_err(dohc_engine_storage::StorageError::corrupt_public)
            })?;
            let Some(candidate) = candidate else { return Ok(Ok("declined")); };
            let execution = if let Some(draft) = draft {
                let doc = Ydoc::wire();
                doc.apply(&draft.initial_update)?;
                let head = VersionedTextStore::new(store).read_text(&key.workspace_id, &key.version_id, &path)?;
                let source = if candidate.lossless_insertion_required && head.as_ref().is_some_and(|snapshot| {
                    snapshot.object_id == candidate.object_id && doc.project(ContentKind::Richdoc)
                        .is_ok_and(|projection| projection.content == snapshot.text)
                }) {
                    head.as_ref().and_then(|snapshot| collection_record_markdown_with_id(&snapshot.text, &candidate.record_id)).map(Some)
                } else {
                    collection_adoption_source(store, &doc, &key, head.as_ref().map(|snapshot| &snapshot.blob_sha256), &candidate, false)?
                };
                match source {
                    None => CollectionAdoptionExecution::Declined,
                    Some(source) => {
                        let update = match collection_adoption_update(&doc, &candidate.record_id, source.as_deref())? {
                            None => { decline_oversized_collection_adoption(store, &candidate, &key.workspace_id, &key.version_id, &dohc_engine_storage::NoFaults)?;
                                return Ok(Ok("declined")); },
                            Some(update) => update,
                        };
                        if !update.is_empty() {
                            let result = dohc_engine_collab::owner_outbox::draft::append_draft_cached(
                                store, cache, &key.workspace_id,
                                dohc_engine_collab::owner_outbox::draft::OwnerDraftAppendInput {
                                    binding: draft.descriptor.binding,
                                    expected_revision: draft.descriptor.revision,
                                    append_key: format!("collection-adoption:{}:{}", candidate.record_id, hex_sha256(&update)),
                                    update, now_ms, agent_declaration: None,
                                }, &dohc_engine_storage::NoFaults);
                            if let Err(error) = result { return Ok(Err(error)); }
                        }
                        return Ok(Ok("ownerPending"));
                    }
                }
            } else {
                adopt_collection_record_on_store(store, cache, &candidate, &key.workspace_id,
                    &key.version_id, &root, &leases, self_writes.as_ref(), now_ms,
                    &dohc_engine_storage::NoFaults, &token, None, Some(&key))?
                    .ok_or(CollabError::LeaseHeld)?
            };
            match execution {
                CollectionAdoptionExecution::Declined => delete_collection_adoption_binding(
                    store, &candidate, &key.workspace_id, &key.version_id, &dohc_engine_storage::NoFaults)?,
                CollectionAdoptionExecution::DeclinedOversized => decline_oversized_collection_adoption(
                    store, &candidate, &key.workspace_id, &key.version_id, &dohc_engine_storage::NoFaults)?,
                CollectionAdoptionExecution::Applied { .. } => return Ok(Ok("settled")),
                CollectionAdoptionExecution::NeedsRichdocSeed => return Ok(Ok("declined")),
            }
            Ok(Ok("declined"))
        }).await
    }

    pub async fn project_collections(
        &self,
        workspace_id: String,
        previous: dohc_engine_domain::CollectionProjection,
    ) -> Result<(dohc_engine_domain::CollectionProjection, Vec<String>), RuntimeError> {
        self.run(move |store, _| {
            let version_id = match VersionedTextStore::new(store).get_active_version(&workspace_id)
            {
                Ok(version) => version.version_id,
                // A fresh share binding opens before its first pull bootstraps main.
                Err(DomainError::WorkspaceNotFound) => return Ok((Default::default(), Vec::new())),
                Err(error) => return Err(error.into()),
            };
            match store.write_with(&dohc_engine_storage::NoFaults, |tx| {
                dohc_engine_domain::project_collections_in_tx(
                    tx,
                    &workspace_id,
                    &version_id,
                    previous,
                )
            })? {
                TxnOutcome::Committed(result) => Ok(result),
                TxnOutcome::Crashed { .. } => Err(RuntimeError::OperationCrashed),
            }
        })
        .await
    }

    /// Check changed collection records against their durable id bindings,
    /// blocking the calling capture worker thread.
    pub fn collection_record_id_mismatch_blocking(
        &self,
        workspace_id: String,
        version_id: String,
        paths: Vec<String>,
    ) -> Result<bool, RuntimeError> {
        self.run_blocking(move |store, _| {
            store
                .read_with(|conn| {
                    collection_record_id_mismatch_in_tx(conn, &workspace_id, &version_id, &paths)
                })
                .map_err(RuntimeError::from)
        })
    }

    #[allow(clippy::too_many_arguments)]
    pub fn reconcile_collections_blocking_guarded(
        &self,
        workspace_id: String,
        version_id: String,
        root_dir: PathBuf,
        leases: LeaseRegistry,
        self_writes: Arc<dyn SelfWriteRecorder>,
        now_ms: i64,
        faults: Arc<dyn FaultInjector>,
        root_guard: Arc<dyn WorkspaceRootGuard>,
    ) -> Result<CollectionReconciliation, RuntimeError> {
        let root_guard: Option<Arc<dyn WorkspaceRootGuard>> = Some(root_guard);
        let token: CancellationToken = CancellationToken::new();
        self.run_blocking(move |store, cache| {
            reconcile_collections_on_store(
                store,
                cache,
                &workspace_id,
                &version_id,
                &root_dir,
                root_guard.as_deref(),
                &leases,
                self_writes.as_ref(),
                now_ms,
                faults.as_ref(),
                &token,
            )
        })
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn reconcile_collections(
        &self,
        workspace_id: String,
        version_id: String,
        root_dir: PathBuf,
        leases: LeaseRegistry,
        self_writes: Arc<dyn SelfWriteRecorder>,
        now_ms: i64,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
    ) -> Result<CollectionReconciliation, RuntimeError> {
        let root_guard: Option<Arc<dyn WorkspaceRootGuard>> = None;
        self.run(move |store, cache| {
            reconcile_collections_on_store(
                store,
                cache,
                &workspace_id,
                &version_id,
                &root_dir,
                root_guard.as_deref(),
                &leases,
                self_writes.as_ref(),
                now_ms,
                faults.as_ref(),
                &token,
            )
        })
        .await
    }

    pub async fn collections_list(
        &self,
        workspace_id: String,
        limit: usize,
        cursor: Option<String>,
    ) -> Result<CollectionListPage, RuntimeError> {
        self.run(move |store, _cache| {
            store
                .read_with(|conn| list_collections(conn, &workspace_id, limit, cursor.as_deref()))
                .map_err(RuntimeError::from)
        })
        .await
    }

    pub async fn collections_list_pending_adoptions(
        &self,
        workspace_id: String,
        limit: usize,
        cursor: Option<CollectionPendingAdoptionCursor>,
    ) -> Result<CollectionPendingAdoptionPage, RuntimeError> {
        self.run(move |store, _cache| {
            store
                .read_with(|conn| {
                    list_pending_collection_adoptions(conn, &workspace_id, limit, cursor.as_ref())
                })
                .map_err(RuntimeError::from)
        })
        .await
    }

    pub async fn collections_get(
        &self,
        workspace_id: String,
        collection_path: String,
    ) -> Result<Option<CollectionDetails>, RuntimeError> {
        self.run(move |store, _cache| {
            store
                .read_with(|conn| get_collection(conn, &workspace_id, &collection_path))
                .map_err(RuntimeError::from)
        })
        .await
    }

    pub async fn collections_query_records(
        &self,
        workspace_id: String,
        collection_path: String,
        query: CollectionQuery,
    ) -> Result<Option<CollectionQueryResult>, RuntimeError> {
        self.run(move |store, _cache| {
            store
                .read_with(|conn| {
                    query_collection_records(conn, &workspace_id, &collection_path, &query)
                })
                .map_err(RuntimeError::from)
        })
        .await
    }

    pub async fn collections_get_record(
        &self,
        workspace_id: String,
        collection_path: String,
        record_id: String,
        history_limit: usize,
        before_history_id: Option<i64>,
    ) -> Result<Option<CollectionRecordDetails>, RuntimeError> {
        self.run(move |store, _cache| {
            store
                .read_with(|conn| {
                    get_collection_record(
                        conn,
                        &workspace_id,
                        &collection_path,
                        &record_id,
                        history_limit,
                        before_history_id,
                    )
                })
                .map_err(RuntimeError::from)
        })
        .await
    }
}

fn persist_collection_adoption_state(
    store: &mut EngineStore,
    candidate: &CollectionAdoptionCandidate,
    workspace_id: &str,
    version_id: &str,
    state: &str,
    faults: &dyn FaultInjector,
) -> Result<(), RuntimeError> {
    match store.write_with(faults, |tx| {
        set_collection_adoption_state_in_tx(
            tx,
            workspace_id,
            version_id,
            &candidate.file_path,
            &candidate.record_id,
            state,
        )
        .map_err(RuntimeError::from)
    })? {
        TxnOutcome::Committed(()) => Ok(()),
        TxnOutcome::Crashed { .. } => Err(RuntimeError::OperationCrashed),
    }
}

fn decline_oversized_collection_adoption(
    store: &mut EngineStore,
    candidate: &CollectionAdoptionCandidate,
    workspace_id: &str,
    version_id: &str,
    faults: &dyn FaultInjector,
) -> Result<(), RuntimeError> {
    match store.write_with(faults, |tx| {
        decline_oversized_collection_adoption_in_tx(
            tx,
            workspace_id,
            version_id,
            &candidate.collection_path,
            &candidate.file_path,
            &candidate.record_id,
        )
        .map_err(RuntimeError::from)
    })? {
        TxnOutcome::Committed(()) => Ok(()),
        TxnOutcome::Crashed { .. } => Err(RuntimeError::OperationCrashed),
    }
}

fn delete_collection_adoption_binding(
    store: &mut EngineStore,
    candidate: &CollectionAdoptionCandidate,
    workspace_id: &str,
    version_id: &str,
    faults: &dyn FaultInjector,
) -> Result<(), RuntimeError> {
    match store.write_with(faults, |tx| {
        delete_collection_adoption_binding_in_tx(
            tx,
            workspace_id,
            version_id,
            &candidate.file_path,
            &candidate.record_id,
        )
        .map_err(RuntimeError::from)
    })? {
        TxnOutcome::Committed(()) => Ok(()),
        TxnOutcome::Crashed { .. } => Err(RuntimeError::OperationCrashed),
    }
}

fn adoption_conflict(error: &RuntimeError) -> bool {
    matches!(
        error,
        RuntimeError::Domain(DomainError::InvalidInput {
            reason: "ydoc-conflict-open"
        })
    )
}

enum CollectionAdoptionExecution {
    Applied { changed_path: Option<String> },
    Declined,
    DeclinedOversized,
    NeedsRichdocSeed,
}

#[cfg(test)]
mod collection_adoption_update_tests {
    use super::*;

    #[test]
    fn preserved_source_retry_is_noop() {
        let doc = Ydoc::wire();
        doc.rewrite_content_to_markdown_preserving_source(
            ContentKind::Richdoc,
            "A heading\n=========\n\n* first\n* second\n",
        )
        .expect("seed");
        let markdown = collection_record_markdown_with_id(
            "A heading\n=========\n\n* first\n* second\n",
            "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa",
        )
        .expect("insert id");
        assert!(
            !collection_adoption_update(&doc, "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa", Some(&markdown))
                .expect("adopt")
                .expect("accepted")
                .is_empty()
        );
        assert!(
            collection_adoption_update(&doc, "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa", Some(&markdown))
                .expect("retry")
                .expect("accepted")
                .is_empty()
        );
    }
}

fn collection_adoption_update(
    doc: &Ydoc,
    record_id: &str,
    preserved_markdown: Option<&str>,
) -> Result<Option<Vec<u8>>, RuntimeError> {
    if doc
        .frontmatter_json()
        .get(RECORD_ID_FRONTMATTER_KEY)
        .and_then(serde_json::Value::as_str)
        == Some(record_id)
        && preserved_markdown.is_none_or(|markdown| {
            doc.markdown_source_reference().is_some_and(|reference| {
                doc.markdown_source(&reference).as_deref() == Some(markdown)
            })
        })
    {
        return Ok(Some(Vec::new()));
    }
    let update = match preserved_markdown {
        Some(markdown) => match doc.frontmatter_set_preserving_markdown_source(
            RECORD_ID_FRONTMATTER_KEY,
            record_id,
            markdown,
        ) {
            Ok(update) => update,
            Err(
                CollabError::ProjectionTooLarge { .. }
                | CollabError::UpdateTooLarge { .. }
                | CollabError::FrontmatterEditRefused,
            ) => {
                return Ok(None);
            }
            Err(error) => return Err(error.into()),
        },
        // An unsplittable block cannot take a key without rewriting
        // the others; adoption declines until the file is edited.
        None if doc.frontmatter_edits_refused() => return Ok(None),
        None => match doc.frontmatter_set(RECORD_ID_FRONTMATTER_KEY, record_id) {
            Ok(update) => update,
            Err(CollabError::FrontmatterEditRefused) => return Ok(None),
            Err(error) => return Err(error.into()),
        },
    };
    Ok(Some(update))
}

fn collection_adoption_source(
    store: &mut EngineStore,
    doc: &Ydoc,
    key: &DocKey,
    head_blob_sha256: Option<&String>,
    candidate: &CollectionAdoptionCandidate,
    allow_pristine: bool,
) -> Result<Option<Option<String>>, RuntimeError> {
    let preserved = if candidate.lossless_insertion_required {
        let preserved = match if allow_pristine {
            dohc_engine_collab::read_pristine_seed_lineage_source(store, key)?
        } else {
            None
        } {
            Some(seed_source_sha) if Some(&seed_source_sha) == head_blob_sha256 => {
                VersionedTextStore::new(store)
                    .read_text(&key.workspace_id, &key.version_id, &candidate.file_path)?
                    .filter(|snapshot| {
                        snapshot.object_id == candidate.object_id
                            && snapshot.blob_sha256 == seed_source_sha
                    })
                    .and_then(|snapshot| {
                        collection_record_markdown_with_id(&snapshot.text, &candidate.record_id)
                    })
            }
            _ => None,
        };
        match preserved {
            Some(preserved) => Some(preserved),
            None => {
                let Some(reference) = doc.markdown_source_reference() else {
                    return Ok(None);
                };
                if !doc.project(ContentKind::Richdoc).is_ok_and(|projection| {
                    reference.projection_sha256 == hex_sha256(projection.content.as_bytes())
                }) {
                    return Ok(None);
                }
                let Some(source) = doc.markdown_source(&reference) else {
                    return Ok(None);
                };
                let Some(inserted) =
                    collection_record_markdown_with_id(&source, &candidate.record_id)
                else {
                    return Ok(None);
                };
                Some(inserted)
            }
        }
    } else {
        None
    };
    Ok(Some(preserved))
}

#[allow(clippy::too_many_arguments)]
fn ensure_collection_record_id_on_store(
    store: &mut EngineStore,
    doc_cache: &mut WriterDocCache,
    doc: &Ydoc,
    key: &DocKey,
    file_path: &str,
    regime: Regime,
    record_id: &str,
    preserved_markdown: Option<&str>,
    lineage_claim_id: Option<String>,
    now_ms: i64,
    faults: &dyn FaultInjector,
    token: &CancellationToken,
) -> Result<Option<(Option<String>, bool)>, RuntimeError> {
    if doc
        .frontmatter_json()
        .get(RECORD_ID_FRONTMATTER_KEY)
        .and_then(serde_json::Value::as_str)
        == Some(record_id)
        && preserved_markdown.is_none()
    {
        return Ok(Some((lineage_claim_id, false)));
    }

    let Some(update) = collection_adoption_update(doc, record_id, preserved_markdown)? else {
        return Ok(None);
    };
    let lineage_claim_id = ydoc_record_update_on_store(
        store,
        doc_cache,
        key,
        file_path,
        ContentKind::Richdoc,
        regime,
        &update,
        Some("engine".to_owned()),
        None,
        lineage_claim_id,
        false,
        None,
        None,
        false,
        now_ms,
        faults,
        token,
        None,
    )?
    .lineage_claim_id;
    Ok(Some((lineage_claim_id, true)))
}

#[allow(clippy::too_many_arguments)]
fn adopt_collection_record_on_store(
    store: &mut EngineStore,
    doc_cache: &mut WriterDocCache,
    candidate: &CollectionAdoptionCandidate,
    workspace_id: &str,
    version_id: &str,
    root_dir: &std::path::Path,
    leases: &LeaseRegistry,
    self_writes: &dyn SelfWriteRecorder,
    now_ms: i64,
    faults: &dyn FaultInjector,
    token: &CancellationToken,
    root_guard: Option<&dyn WorkspaceRootGuard>,
    session_key: Option<&DocKey>,
) -> Result<Option<CollectionAdoptionExecution>, RuntimeError> {
    let probe = ydoc_open_state_on_store(
        store,
        doc_cache,
        workspace_id,
        now_ms,
        false,
        None,
        version_id,
        &candidate.file_path,
        Some(ContentKind::Richdoc),
        false,
        token,
    )?;
    if probe.key.object_id != candidate.object_id {
        return Err(DomainError::StateCorrupt {
            reason: "collection record changed identity during adoption",
        }
        .into());
    }
    if !probe.lineage_existing {
        return Ok(Some(CollectionAdoptionExecution::NeedsRichdocSeed));
    }
    let _lease = if let Some(key) = session_key {
        if key != &probe.key {
            return Err(DomainError::ConflictStaleTarget.into());
        }
        None
    } else {
        match leases.acquire(&probe.key) {
            Ok(lease) => Some(lease),
            Err(CollabError::LeaseHeld) => return Ok(None),
            Err(error) => return Err(error.into()),
        }
    };
    // `drain_deferred = false`: this engine-internal open must not consume
    // the parked deferred queue. Its caller discards `state.record_facts`,
    // so a parked update drained here would fire no record events on any
    // path. The rows stay queued for the next pull, open, settle, or close,
    // which all emit. Skipping the drain can change what this pass sees: a
    // queued update whose base has arrived would otherwise be applied
    // first. The result still converges: at worst adoption writes a record
    // id the queued update also carries, which the CRDT merge and the
    // by-sha projection make idempotent, and the later drain projects the
    // queued update over the adopted result.
    let state = ydoc_open_state_on_store(
        store,
        doc_cache,
        workspace_id,
        now_ms,
        false,
        Some(&probe.key),
        version_id,
        &candidate.file_path,
        Some(ContentKind::Richdoc),
        false,
        token,
    )?;
    if state.key != probe.key || state.content_kind != ContentKind::Richdoc {
        return Err(DomainError::InvalidInput {
            reason: "collection record does not have a rich-document lineage",
        }
        .into());
    }

    if !state.lineage_existing {
        return Err(DomainError::StateCorrupt {
            reason: "collection record lineage disappeared during adoption",
        }
        .into());
    }
    let doc = Ydoc::wire();
    doc.apply(&state.initial_update)?;
    let lineage_claim_id = state.lineage_claim_id;
    let Some(settled_content_override) = collection_adoption_source(
        store,
        &doc,
        &state.key,
        state.head_blob_sha256.as_ref(),
        candidate,
        true,
    )?
    else {
        return Ok(Some(CollectionAdoptionExecution::Declined));
    };
    let Some((lineage_claim_id, _id_added)) = ensure_collection_record_id_on_store(
        store,
        doc_cache,
        &doc,
        &state.key,
        &candidate.file_path,
        state.regime,
        &candidate.record_id,
        settled_content_override.as_deref(),
        lineage_claim_id,
        now_ms,
        faults,
        token,
    )?
    else {
        return Ok(Some(CollectionAdoptionExecution::DeclinedOversized));
    };
    validate_workspace_root(root_dir, root_guard)?;
    let changed_path = Some(
        ydoc_settle_on_store(
            store,
            doc_cache,
            root_dir,
            &state.key,
            &candidate.file_path,
            ContentKind::Richdoc,
            false,
            lineage_claim_id.as_deref(),
            state.head_blob_sha256,
            settled_content_override,
            &format!("collection-adoption:{}", candidate.record_id),
            self_writes,
            now_ms,
            faults,
            token,
            root_guard,
            None,
            None,
            super::ydoc::SettlementKind::CollectionAdoption,
        )?
        .into_settlement_for_internal_caller()?
        .path,
    );
    Ok(Some(CollectionAdoptionExecution::Applied { changed_path }))
}

enum CollectionRelationCleanupExecution {
    Applied(String),
    NoChange,
    LeaseHeld,
}

#[allow(clippy::too_many_arguments)]
fn cleanup_collection_relation_on_store(
    store: &mut EngineStore,
    doc_cache: &mut WriterDocCache,
    candidate: &CollectionRelationCleanupCandidate,
    workspace_id: &str,
    version_id: &str,
    root_dir: &std::path::Path,
    leases: &LeaseRegistry,
    self_writes: &dyn SelfWriteRecorder,
    now_ms: i64,
    faults: &dyn FaultInjector,
    token: &CancellationToken,
    root_guard: Option<&dyn WorkspaceRootGuard>,
) -> Result<CollectionRelationCleanupExecution, RuntimeError> {
    let probe = ydoc_open_state_on_store(
        store,
        doc_cache,
        workspace_id,
        now_ms,
        false,
        None,
        version_id,
        &candidate.source_file_path,
        Some(ContentKind::Richdoc),
        false,
        token,
    )?;
    if probe.key.object_id != candidate.source_object_id {
        return Err(DomainError::StateCorrupt {
            reason: "collection relation referrer changed identity during cleanup",
        }
        .into());
    }
    let _lease = match leases.acquire(&probe.key) {
        Ok(lease) => lease,
        Err(CollabError::LeaseHeld) => {
            return Ok(CollectionRelationCleanupExecution::LeaseHeld);
        }
        Err(error) => return Err(error.into()),
    };
    // `drain_deferred = false` for the same reason as the adoption pass:
    // this caller has no event route for drained record facts, so the
    // parked rows stay queued for a path that emits.
    let state = ydoc_open_state_on_store(
        store,
        doc_cache,
        workspace_id,
        now_ms,
        false,
        Some(&probe.key),
        version_id,
        &candidate.source_file_path,
        Some(ContentKind::Richdoc),
        false,
        token,
    )?;
    if state.key != probe.key || state.content_kind != ContentKind::Richdoc {
        return Err(DomainError::InvalidInput {
            reason: "collection relation referrer does not have a rich-document lineage",
        }
        .into());
    }

    let doc = Ydoc::wire();
    doc.apply(&state.initial_update)?;
    let mut lineage_claim_id = state.lineage_claim_id.clone();
    if !state.lineage_existing {
        let seed = state
            .seed_content
            .as_deref()
            .ok_or(DomainError::StateCorrupt {
                reason: "collection relation cleanup has no Markdown artifact seed",
            })?;
        doc.rewrite_content_to_markdown(ContentKind::Richdoc, seed)?;
        let seed_update = doc.encode_full_state();
        lineage_claim_id = ydoc_record_update_on_store(
            store,
            doc_cache,
            &state.key,
            &candidate.source_file_path,
            ContentKind::Richdoc,
            state.regime,
            &seed_update,
            None,
            None,
            lineage_claim_id,
            true,
            state.owner_seed_source.clone(),
            None,
            false,
            now_ms,
            faults,
            token,
            None,
        )?
        .lineage_claim_id;
    }
    let Some(update) = doc.frontmatter_drop_relation_target_preserving_markdown_source(
        &candidate.field_name,
        &candidate.target_record_id,
        candidate.many,
    )?
    else {
        match store.write_with(faults, |tx| {
            synchronize_collection_frontmatter_index_in_tx(
                tx,
                workspace_id,
                version_id,
                &candidate.source_object_id,
                &doc.frontmatter_json(),
            )
            .map_err(RuntimeError::from)
        })? {
            TxnOutcome::Committed(()) => {
                return Ok(CollectionRelationCleanupExecution::NoChange);
            }
            TxnOutcome::Crashed { .. } => return Err(RuntimeError::OperationCrashed),
        }
    };
    let append = ydoc_record_update_on_store(
        store,
        doc_cache,
        &state.key,
        &candidate.source_file_path,
        ContentKind::Richdoc,
        state.regime,
        &update,
        Some("engine".to_owned()),
        None,
        lineage_claim_id,
        false,
        None,
        None,
        false,
        now_ms,
        faults,
        token,
        None,
    )?;
    validate_workspace_root(root_dir, root_guard)?;
    let settlement = ydoc_settle_on_store(
        store,
        doc_cache,
        root_dir,
        &state.key,
        &candidate.source_file_path,
        ContentKind::Richdoc,
        false,
        append.lineage_claim_id.as_deref(),
        state.head_blob_sha256,
        None,
        &format!(
            "collection-relation-cleanup:{}:{}:{}",
            candidate.source_record_id, candidate.field_name, candidate.target_record_id
        ),
        self_writes,
        now_ms,
        faults,
        token,
        root_guard,
        None,
        None,
        super::ydoc::SettlementKind::Document,
    )?
    .into_settlement_for_internal_caller()?;
    Ok(CollectionRelationCleanupExecution::Applied(settlement.path))
}

/// What one collection reconciliation changed.
#[derive(Debug, Default)]
pub struct CollectionReconciliation {
    /// Workspace paths the reconciliation rewrote: record id adoptions and
    /// relation cleanups.
    pub changed_paths: Vec<String>,
    /// Automation claims for the records it added or removed on this
    /// computer, committed with the bindings. The caller announces them.
    pub automation_claims: Vec<dohc_engine_domain::AutomationClaim>,
}

#[allow(clippy::too_many_arguments)]
fn reconcile_collections_on_store(
    store: &mut EngineStore,
    doc_cache: &mut WriterDocCache,
    workspace_id: &str,
    version_id: &str,
    root_dir: &std::path::Path,
    root_guard: Option<&dyn WorkspaceRootGuard>,
    leases: &LeaseRegistry,
    self_writes: &dyn SelfWriteRecorder,
    now_ms: i64,
    faults: &dyn FaultInjector,
    token: &CancellationToken,
) -> Result<CollectionReconciliation, RuntimeError> {
    if token.is_cancelled() {
        return Err(RuntimeError::Cancelled);
    }
    validate_workspace_root(root_dir, root_guard)?;
    let (reconciliation, automation_claims) = match store.write_with(faults, |tx| {
        let reconciliation = reconcile_collections_in_tx(tx, workspace_id, version_id)?;
        // Added and removed records claim in the transaction that binds or
        // unbinds them.
        let claims = dohc_engine_domain::claim_record_lifecycle_in_tx(
            tx,
            workspace_id,
            version_id,
            &reconciliation.lifecycle,
            now_ms,
        )?;
        Ok::<_, RuntimeError>((reconciliation, claims))
    })? {
        TxnOutcome::Committed(committed) => committed,
        TxnOutcome::Crashed { .. } => return Err(RuntimeError::OperationCrashed),
    };

    let mut changed_paths = Vec::new();
    let mut pending_seed_objects = HashSet::new();
    let mut lease_held = false;
    for candidate in reconciliation.adoptions {
        if token.is_cancelled() {
            return Err(RuntimeError::Cancelled);
        }
        match adopt_collection_record_on_store(
            store,
            doc_cache,
            &candidate,
            workspace_id,
            version_id,
            root_dir,
            leases,
            self_writes,
            now_ms,
            faults,
            token,
            root_guard,
            None,
        ) {
            Ok(Some(CollectionAdoptionExecution::Applied { changed_path })) => {
                if let Some(path) = changed_path
                    && !changed_paths.contains(&path)
                {
                    changed_paths.push(path);
                }
            }
            Ok(Some(CollectionAdoptionExecution::Declined)) => {
                delete_collection_adoption_binding(
                    store,
                    &candidate,
                    workspace_id,
                    version_id,
                    faults,
                )?;
            }
            Ok(Some(CollectionAdoptionExecution::DeclinedOversized)) => {
                decline_oversized_collection_adoption(
                    store,
                    &candidate,
                    workspace_id,
                    version_id,
                    faults,
                )?;
            }
            Ok(Some(CollectionAdoptionExecution::NeedsRichdocSeed)) => {
                pending_seed_objects.insert(candidate.object_id.clone());
            }
            Ok(None) => {
                lease_held = true;
            }
            Err(error) if adoption_conflict(&error) => {
                let state = if candidate.lossless_insertion_required {
                    "deferred-conflict-lossless"
                } else {
                    "deferred-conflict"
                };
                persist_collection_adoption_state(
                    store,
                    &candidate,
                    workspace_id,
                    version_id,
                    state,
                    faults,
                )?;
            }
            Err(error) => return Err(error),
        }
    }
    for candidate in reconciliation.relation_cleanups {
        if token.is_cancelled() {
            return Err(RuntimeError::Cancelled);
        }
        if pending_seed_objects.contains(&candidate.source_object_id) {
            continue;
        }
        match cleanup_collection_relation_on_store(
            store,
            doc_cache,
            &candidate,
            workspace_id,
            version_id,
            root_dir,
            leases,
            self_writes,
            now_ms,
            faults,
            token,
            root_guard,
        ) {
            Ok(CollectionRelationCleanupExecution::Applied(path)) => {
                if !changed_paths.contains(&path) {
                    changed_paths.push(path);
                }
            }
            Ok(CollectionRelationCleanupExecution::NoChange) => {}
            Ok(CollectionRelationCleanupExecution::LeaseHeld) => {
                lease_held = true;
            }
            Err(error) if adoption_conflict(&error) => {}
            Err(error) => return Err(error),
        }
    }
    if lease_held {
        return Err(RuntimeError::Sync(
            dohc_engine_sync::SyncError::RetryableState {
                reason: "collection-reconciliation-lease-held",
            },
        ));
    }
    Ok(CollectionReconciliation {
        changed_paths,
        automation_claims,
    })
}

#[cfg(test)]
mod collection_relation_cleanup_tests {
    use super::super::versions::ensure_mutation_version_on_store;
    use super::*;
    use dohc_engine_domain::WriteText;
    use dohc_engine_storage::NoFaults;
    use dohc_engine_testkit::ScratchDir;

    const WORKSPACE_ID: &str = "workspace";
    const VERSION_ID: &str = "main";
    const SOURCE_ID: &str = "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa";
    const TARGET_ID: &str = "rec_bbbbbbbbbbbbbbbbbbbbbbbbbb";
    const SOURCE_OBJECT_ID: &str = "relation-source-object";
    const SOURCE_PATH: &str = "tasks/source.md";

    fn write_text(
        store: &mut EngineStore,
        object_id: &str,
        path: &str,
        text: &str,
        moment_id: &str,
        now_ms: i64,
    ) {
        VersionedTextStore::new(store)
            .write_text(
                &WriteText {
                    workspace_id: WORKSPACE_ID.to_owned(),
                    version_id: VERSION_ID.to_owned(),
                    object_id: object_id.to_owned(),
                    path: path.to_owned(),
                    text: text.to_owned(),
                    moment_id: moment_id.to_owned(),
                    metadata_origin: "test".to_owned(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: None,
                    now_ms,
                    request_id: None,
                },
                &NoFaults,
            )
            .expect("write collection fixture");
    }

    #[test]
    fn absent_relation_target_cleanup_refreshes_only_the_index() {
        let scratch = ScratchDir::new().expect("scratch directory");
        let mut store = EngineStore::open(
            &dohc_engine_testkit::engine_db_path(&scratch).expect("engine database"),
            1,
        )
        .expect("open engine store");
        ensure_mutation_version_on_store(&mut store, WORKSPACE_ID, VERSION_ID, 1, &NoFaults)
            .expect("ensure main version");
        write_text(
            &mut store,
            "relation-schema-object",
            "tasks/collection.yaml",
            "fields:\n  related:\n    type: relation\n    collection: tasks\n    many: false\n",
            "relation-schema-moment",
            2,
        );
        let markdown = format!("---\nid: {SOURCE_ID}\n---\n\nSource\n");
        write_text(
            &mut store,
            SOURCE_OBJECT_ID,
            SOURCE_PATH,
            &markdown,
            "relation-source-moment",
            3,
        );
        store
            .write_with(&NoFaults, |tx| {
                reconcile_collections_in_tx(tx, WORKSPACE_ID, VERSION_ID)?;
                set_collection_adoption_state_in_tx(
                    tx,
                    WORKSPACE_ID,
                    VERSION_ID,
                    SOURCE_PATH,
                    SOURCE_ID,
                    "adopted",
                )
            })
            .expect("adopt source record");

        let key = DocKey::new(WORKSPACE_ID, VERSION_ID, SOURCE_OBJECT_ID).expect("document key");
        let doc = Ydoc::wire();
        doc.rewrite_content_to_markdown(ContentKind::Richdoc, &markdown)
            .expect("seed rich document");
        let mut cache = WriterDocCache::new();
        let appended = dohc_engine_collab::record_local_update(
            &mut store,
            &mut cache,
            &key,
            &doc.encode_full_state(),
            dohc_engine_collab::LocalAppend {
                marker: Some(dohc_engine_collab::MarkerCreation {
                    path: Some(SOURCE_PATH),
                    content_kind: ContentKind::Richdoc,
                    regime: Regime::LocalOnly,
                }),
                ..Default::default()
            },
            &NoFaults,
            4,
            |_tx, _outcome, _update_sha| Ok(()),
        )
        .expect("seed source lineage");
        assert!(matches!(appended, TxnOutcome::Committed(_)));
        store
            .write_with(&NoFaults, |tx| {
                synchronize_collection_frontmatter_index_in_tx(
                    tx,
                    WORKSPACE_ID,
                    VERSION_ID,
                    SOURCE_OBJECT_ID,
                    &serde_json::json!({ "id": SOURCE_ID, "related": TARGET_ID }),
                )
                .map_err(RuntimeError::from)
            })
            .expect("seed stale relation index");

        let before: (i64, i64, i64) = store
            .read_with(|conn| {
                Ok::<_, rusqlite::Error>((
                    conn.query_row("SELECT COUNT(*) FROM ydoc_updates", [], |row| row.get(0))?,
                    conn.query_row("SELECT COUNT(*) FROM moments", [], |row| row.get(0))?,
                    conn.query_row(
                        "SELECT COUNT(*) FROM collection_relation_edges",
                        [],
                        |row| row.get(0),
                    )?,
                ))
            })
            .expect("state before cleanup");
        assert_eq!(before.2, 1, "the stale index must contain the target edge");

        let outcome = cleanup_collection_relation_on_store(
            &mut store,
            &mut cache,
            &CollectionRelationCleanupCandidate {
                source_record_id: SOURCE_ID.to_owned(),
                source_file_path: SOURCE_PATH.to_owned(),
                source_object_id: SOURCE_OBJECT_ID.to_owned(),
                field_name: "related".to_owned(),
                target_record_id: TARGET_ID.to_owned(),
                many: false,
            },
            WORKSPACE_ID,
            VERSION_ID,
            scratch.path(),
            &LeaseRegistry::default(),
            &(),
            5,
            &NoFaults,
            &CancellationToken::new(),
            None,
        )
        .expect("clean absent relation target");
        assert!(matches!(
            outcome,
            CollectionRelationCleanupExecution::NoChange
        ));

        let after: (i64, i64, i64, i64) = store
            .read_with(|conn| {
                Ok::<_, rusqlite::Error>((
                    conn.query_row("SELECT COUNT(*) FROM ydoc_updates", [], |row| row.get(0))?,
                    conn.query_row("SELECT COUNT(*) FROM moments", [], |row| row.get(0))?,
                    conn.query_row(
                        "SELECT COUNT(*) FROM collection_relation_edges",
                        [],
                        |row| row.get(0),
                    )?,
                    conn.query_row(
                        "SELECT COUNT(*) FROM collection_record_fields \
                         WHERE record_id=?1 AND field_name='related'",
                        [SOURCE_ID],
                        |row| row.get(0),
                    )?,
                ))
            })
            .expect("state after cleanup");
        assert_eq!((after.0, after.1), (before.0, before.1));
        assert_eq!((after.2, after.3), (0, 0));
    }

    #[test]
    fn engine_seeded_relation_cleanup_survives_restart() {
        use dohc_engine_domain::DeleteTextFile;
        use yrs::{Any, Doc, Map, Transact, Update, updates::decoder::Decode};

        let scratch = ScratchDir::new().unwrap();
        let db = dohc_engine_testkit::engine_db_path(&scratch).unwrap();
        let mut store = EngineStore::open(&db, 1).unwrap();
        ensure_mutation_version_on_store(&mut store, WORKSPACE_ID, VERSION_ID, 1, &NoFaults)
            .unwrap();
        let markdown = format!("---\nid: {SOURCE_ID}\nrelated: {TARGET_ID}\n---\n\nSource");
        write_text(
            &mut store,
            "schema",
            "tasks/collection.yaml",
            "fields:\n  related:\n    type: relation\n    collection: tasks\n    many: false\n",
            "schema-moment",
            2,
        );
        write_text(
            &mut store,
            SOURCE_OBJECT_ID,
            SOURCE_PATH,
            &markdown,
            "source-moment",
            3,
        );
        write_text(
            &mut store,
            "target-object",
            "tasks/target.md",
            &format!("---\nid: {TARGET_ID}\n---\n\nTarget\n"),
            "target-moment",
            4,
        );
        store
            .write_with(&NoFaults, |tx| {
                reconcile_collections_in_tx(tx, WORKSPACE_ID, VERSION_ID)?;
                for (path, id) in [(SOURCE_PATH, SOURCE_ID), ("tasks/target.md", TARGET_ID)] {
                    set_collection_adoption_state_in_tx(
                        tx,
                        WORKSPACE_ID,
                        VERSION_ID,
                        path,
                        id,
                        "adopted",
                    )?;
                }
                Ok::<_, DomainError>(())
            })
            .unwrap();
        let key = DocKey::new(WORKSPACE_ID, VERSION_ID, SOURCE_OBJECT_ID).unwrap();
        assert!(
            dohc_engine_collab::load_persisted(&store, &key)
                .unwrap()
                .is_none(),
            "never opened"
        );
        std::fs::create_dir_all(scratch.path().join("tasks")).unwrap();
        std::fs::write(scratch.path().join(SOURCE_PATH), &markdown).unwrap();
        VersionedTextStore::new(&mut store)
            .delete_text_file(
                &DeleteTextFile {
                    workspace_id: WORKSPACE_ID.to_owned(),
                    version_id: VERSION_ID.to_owned(),
                    path: "tasks/target.md".to_owned(),
                    moment_id: "target-delete".to_owned(),
                    request_id: None,
                    metadata_origin: "test".to_owned(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: None,
                    now_ms: 5,
                },
                &NoFaults,
            )
            .unwrap();
        let mut cache = WriterDocCache::new();
        let outcome = reconcile_collections_on_store(
            &mut store,
            &mut cache,
            WORKSPACE_ID,
            VERSION_ID,
            scratch.path(),
            None,
            &LeaseRegistry::default(),
            &(),
            6,
            &NoFaults,
            &CancellationToken::new(),
        )
        .unwrap();
        assert_eq!(outcome.changed_paths, [SOURCE_PATH]);
        let persisted = dohc_engine_collab::load_persisted(&store, &key)
            .unwrap()
            .unwrap();
        assert_eq!(
            persisted.doc.frontmatter_json(),
            serde_json::json!({"id": SOURCE_ID})
        );
        let checkpoint = persisted.doc.encode_full_state();
        let updates: Vec<Vec<u8>> = store
            .read_with(|conn| {
                let mut stmt = conn.prepare(
                    "SELECT b.bytes FROM ydoc_updates u JOIN binary_blobs b \
                ON b.sha256=u.update_blob_sha256 WHERE u.workspace_id=?1 AND u.version_id=?2 \
                AND u.object_id=?3 ORDER BY u.seq",
                )?;
                stmt.query_map([WORKSPACE_ID, VERSION_ID, SOURCE_OBJECT_ID], |row| {
                    row.get(0)
                })?
                .collect::<Result<_, rusqlite::Error>>()
            })
            .unwrap();
        assert_eq!(updates.len(), 2, "one seed and one relation cleanup delta");
        drop(persisted);
        drop(cache);
        drop(store);
        let store = EngineStore::open(&db, 7).unwrap();
        let reopened = dohc_engine_collab::load_persisted(&store, &key)
            .unwrap()
            .unwrap();
        let after_restart = reopened.doc.encode_full_state();
        let fixture = serde_json::json!({
            "sourceId": SOURCE_ID, "targetId": TARGET_ID, "seed": updates[0],
            "cleanup": updates[1], "checkpoint": checkpoint, "afterRestart": after_restart,
        });
        if let Ok(path) = std::env::var("DOHC_SEEDED_CLEANUP_FIXTURE") {
            std::fs::write(path, serde_json::to_vec_pretty(&fixture).unwrap()).unwrap();
        }
        let committed: serde_json::Value = serde_json::from_str(include_str!(
            "../../../dohc-engine-collab/tests/seeded-doc-fixtures/cleanup.json"
        ))
        .unwrap();
        assert_eq!(
            fixture.as_object().unwrap().keys().collect::<Vec<_>>(),
            committed.as_object().unwrap().keys().collect::<Vec<_>>(),
            "cleanup fixture keys drift"
        );
        for field in ["sourceId", "targetId"] {
            assert_eq!(
                fixture[field], committed[field],
                "cleanup input drift: {field}"
            );
        }
        for field in ["seed", "cleanup", "checkpoint", "afterRestart"] {
            let documents = [&fixture, &committed].map(|input| {
                let doc = Ydoc::wire();
                if field == "cleanup" {
                    let seed: Vec<u8> = serde_json::from_value(input["seed"].clone()).unwrap();
                    doc.apply(&seed).unwrap();
                }
                let bytes: Vec<u8> = serde_json::from_value(input[field].clone()).unwrap();
                doc.apply(&bytes).unwrap();
                doc
            });
            // Compare semantic roots, metadata, and projection, not random client bytes.
            assert_eq!(
                documents[0].canonical_content(),
                documents[1].canonical_content(),
                "cleanup shape drift: {field}"
            );
            assert_eq!(
                documents[0].project(ContentKind::Richdoc).unwrap().content,
                documents[1].project(ContentKind::Richdoc).unwrap().content,
                "cleanup projection drift: {field}"
            );
        }
        assert_eq!(
            after_restart, checkpoint,
            "restart replays the same client and clocks"
        );
        let receiver = Doc::new();
        receiver.get_or_insert_xml_fragment("body");
        let meta = receiver.get_or_insert_map("meta");
        receiver
            .transact_mut()
            .apply_update(Update::decode_v1(&after_restart).unwrap())
            .unwrap();
        assert_eq!(
            meta.get(&receiver.transact(), "schemaVersion"),
            Some(yrs::Out::Any(Any::Number(1.0)))
        );
        assert_eq!(
            reopened.doc.frontmatter_json(),
            serde_json::json!({"id": SOURCE_ID})
        );
        let relation_edges: i64 = store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT COUNT(*) FROM collection_relation_edges WHERE source_record_id=?1",
                    [SOURCE_ID],
                    |row| row.get(0),
                )
            })
            .unwrap();
        assert_eq!(relation_edges, 0);
        assert_eq!(
            std::fs::read_to_string(scratch.path().join(SOURCE_PATH)).unwrap(),
            markdown.replace(&format!("related: {TARGET_ID}\n"), "")
        );
    }
}
