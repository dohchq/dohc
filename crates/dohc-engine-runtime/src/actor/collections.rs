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
                                    person_edit: false,
                                    binding: draft.descriptor.binding,
                                    expected_revision: draft.descriptor.revision,
                                    append_key: format!("collection-adoption:{}:{}", candidate.record_id, hex_sha256(&update)),
                                    update, now_ms, agent_declaration: None, automation_declaration: None,
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
        committed: Option<CollectionCommitListener>,
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
                committed.as_deref(),
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
                None,
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

fn file_conflict(error: &RuntimeError) -> bool {
    matches!(
        error,
        RuntimeError::Domain(DomainError::InvalidInput {
            reason: "ydoc-conflict-open"
        })
    )
}

fn adoption_pending(error: &RuntimeError) -> bool {
    matches!(
        error,
        RuntimeError::Domain(DomainError::ConflictStaleTarget)
            | RuntimeError::Domain(DomainError::InvalidInput {
                reason: "collection record does not have a rich-document lineage"
            })
            | RuntimeError::Materialize(dohc_engine_files::MaterializeError::SymlinkTarget)
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

    fn fixture() -> (dohc_engine_testkit::ScratchDir, EngineStore, WriterDocCache) {
        let scratch = dohc_engine_testkit::ScratchDir::new().expect("scratch");
        let mut store = EngineStore::open(
            &dohc_engine_testkit::engine_db_path(&scratch).expect("db"),
            1,
        )
        .expect("store");
        VersionedTextStore::new(&mut store)
            .ensure_main_version("workspace", "main", 1, &dohc_engine_storage::NoFaults)
            .expect("version");
        std::fs::create_dir_all(scratch.path().join("tasks")).expect("collection directory");
        capture(
            &mut store,
            "tasks/collection.yaml",
            "fields:\n  Title:\n    type: text\n",
            2,
        );
        (scratch, store, WriterDocCache::new())
    }

    fn capture(store: &mut EngineStore, path: &str, text: &str, now_ms: i64) {
        VersionedTextStore::new(store)
            .capture_ingest(
                &dohc_engine_domain::CaptureIngest {
                    workspace_id: "workspace".to_owned(),
                    version_id: "main".to_owned(),
                    path: path.to_owned(),
                    text: text.to_owned(),
                    metadata_origin: "capture".to_owned(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: None,
                    now_ms,
                    request_id: None,
                    claim_foreign_head: false,
                },
                &dohc_engine_storage::NoFaults,
            )
            .expect("capture head");
    }

    fn seed(store: &mut EngineStore, cache: &mut WriterDocCache, path: &str, text: &str) -> DocKey {
        capture(store, path, text, 3);
        let snapshot = VersionedTextStore::new(store)
            .read_text("workspace", "main", path)
            .expect("read head")
            .expect("head");
        let key = DocKey::new("workspace", "main", snapshot.object_id.clone()).expect("key");
        let doc = Ydoc::wire();
        doc.rewrite_content_to_markdown_preserving_source(ContentKind::Richdoc, text)
            .expect("seed source");
        dohc_engine_collab::record_local_update(
            store,
            cache,
            &key,
            &doc.encode_full_state(),
            dohc_engine_collab::LocalAppend {
                marker: Some(dohc_engine_collab::MarkerCreation {
                    path: Some(path),
                    content_kind: ContentKind::Richdoc,
                    regime: Regime::LocalOnly,
                }),
                seed_source_sha256: Some(&snapshot.blob_sha256),
                ..Default::default()
            },
            &dohc_engine_storage::NoFaults,
            4,
            |_tx, _outcome, _sha| Ok(()),
        )
        .expect("record seed");
        key
    }

    fn reconcile(
        store: &mut EngineStore,
        cache: &mut WriterDocCache,
        root: &std::path::Path,
    ) -> Result<CollectionReconciliation, RuntimeError> {
        reconcile_collections_on_store(
            store,
            cache,
            "workspace",
            "main",
            root,
            None,
            &LeaseRegistry::new(),
            &(),
            10,
            &dohc_engine_storage::NoFaults,
            &CancellationToken::new(),
            None,
        )
    }

    #[test]
    fn a_never_replicated_empty_seed_retires_and_adopts_a_nested_list_exactly() {
        for settled_empty in [false, true] {
            assert_never_replicated_completion_adopts(settled_empty);
        }
    }

    fn assert_never_replicated_completion_adopts(settled_empty: bool) {
        let (scratch, mut store, mut cache) = fixture();
        let path = "tasks/empty.md";
        let key = seed(&mut store, &mut cache, path, "");
        if settled_empty {
            store
                .write_with(&dohc_engine_storage::NoFaults, |tx| {
                    let settled = dohc_engine_domain::write_projected_text_in_tx(
                        tx,
                        &dohc_engine_domain::WriteText {
                            workspace_id: "workspace".into(),
                            version_id: "main".into(),
                            object_id: key.object_id.clone(),
                            path: path.into(),
                            text: "".into(),
                            moment_id: "empty-settle".into(),
                            metadata_origin: "ydoc".into(),
                            metadata_summary: None,
                            metadata_correlation_id: None,
                            author_json: None,
                            now_ms: 4,
                            request_id: None,
                        },
                    )
                    .unwrap();
                    tx.execute(
                        "UPDATE ydoc_docs SET settle_seq=?1,last_settled_sha=?2 WHERE object_id=?3",
                        rusqlite::params![
                            settled.moment.moment_order,
                            settled.snapshot.blob_sha256,
                            key.object_id
                        ],
                    )
                    .map_err(dohc_engine_storage::StorageError::persist_public)
                })
                .unwrap();
        }
        let completed = "---\nTitle: Completed\n---\n- parent\n  - child\n";
        std::fs::write(scratch.path().join(path), completed).unwrap();
        store
            .write_with(&dohc_engine_storage::NoFaults, |tx| {
                capture_ingest_fixture_in_tx(tx, &key, path, completed)
            })
            .expect("capture retires untouched empty seed");
        assert!(
            dohc_engine_collab::read_marker(&store, &key)
                .unwrap()
                .is_none()
        );
        assert_eq!(
            VersionedTextStore::new(&mut store)
                .read_text("workspace", "main", path)
                .unwrap()
                .unwrap()
                .text,
            completed
        );
        cache.clear();
        seed(&mut store, &mut cache, path, completed);
        reconcile(&mut store, &mut cache, scratch.path()).expect("adopt fresh seed");
        let adopted = VersionedTextStore::new(&mut store)
            .read_text("workspace", "main", path)
            .unwrap()
            .unwrap();
        let frontmatter =
            dohc_engine_domain::collections::markdown_frontmatter_json(&adopted.text).unwrap();
        assert_eq!(
            adopted.text,
            collection_record_markdown_with_id(completed, frontmatter["id"].as_str().unwrap())
                .unwrap()
        );
        assert_eq!(
            std::fs::read_to_string(scratch.path().join(path)).unwrap(),
            adopted.text
        );
        let state: String = store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT adoption_state FROM collection_records WHERE file_path=?1",
                    [path],
                    |row| row.get(0),
                )
            })
            .unwrap();
        assert_eq!(state, "adopted");
    }

    #[test]
    fn a_journaled_empty_seed_cannot_be_retired_even_before_relay_push() {
        for imported in [false, true] {
            let (scratch, mut store, mut cache) = fixture();
            let path = "tasks/empty.md";
            let key = seed(&mut store, &mut cache, path, "");
            std::fs::write(scratch.path().join(path), "").unwrap();
            store.write_with(&dohc_engine_storage::NoFaults, |tx| {
                tx.execute("INSERT INTO replication_log (workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms,imported) \
                    VALUES ('workspace','seed-origin',0,'ydoc.update',?1,4,?2)",
                    rusqlite::params![serde_json::json!({"versionId":"main", "objectId":key.object_id}).to_string(), imported])
                    .map_err(dohc_engine_storage::StorageError::persist_public)
            }).unwrap();
            store
                .write_with(&dohc_engine_storage::NoFaults, |tx| {
                    reconcile_collections_in_tx(tx, "workspace", "main")
                })
                .unwrap();
            let completed = "---\nTitle: Completed\n---\n- parent\n  - child\n";
            std::fs::write(scratch.path().join(path), completed).unwrap();
            let result = store.write_with(&dohc_engine_storage::NoFaults, |tx| {
                capture_ingest_fixture_in_tx(tx, &key, path, completed)
            });
            assert!(
                matches!(
                    result,
                    Err(dohc_engine_sync::SyncError::InvalidInput {
                        reason: "ydoc-resolution-not-representable"
                    })
                ),
                "{result:?}"
            );
            assert!(
                dohc_engine_collab::read_marker(&store, &key)
                    .unwrap()
                    .is_some()
            );
            assert_eq!(
                VersionedTextStore::new(&mut store)
                    .read_text("workspace", "main", path)
                    .unwrap()
                    .unwrap()
                    .text,
                ""
            );
            reconcile(&mut store, &mut cache, scratch.path()).unwrap();
            assert!(
                store
                    .read_with(|conn| list_pending_collection_adoptions(
                        conn,
                        "workspace",
                        100,
                        None
                    ))
                    .unwrap()
                    .adoptions
                    .is_empty()
            );
            let query = store
                .read_with(|conn| {
                    query_collection_records(
                        conn,
                        "workspace",
                        "tasks",
                        &CollectionQuery::default(),
                    )
                })
                .unwrap()
                .unwrap();
            assert_eq!(query.records.len(), 1);
            assert!(!query.records[0].conflicted);
            assert_eq!(
                std::fs::read_to_string(scratch.path().join(path)).unwrap(),
                completed
            );
        }
    }

    #[test]
    fn an_owner_or_live_device_bound_empty_seed_cannot_be_retired() {
        for owner_binding in [false, true] {
            let (_scratch, mut store, mut cache) = fixture();
            let path = "tasks/empty.md";
            let key = seed(&mut store, &mut cache, path, "");
            store
                .write_with(&dohc_engine_storage::NoFaults, |tx| {
                    if owner_binding {
                        tx.execute(
                            "INSERT INTO ydoc_owner_bindings \
                             SELECT workspace_id,version_id,object_id,update_blob_sha256,'{}', \
                               'relay',1,0,1,update_blob_sha256,1024,1000 \
                             FROM ydoc_updates WHERE object_id=?1",
                            [&key.object_id],
                        )
                    } else {
                        tx.execute(
                            "INSERT INTO live_device_application_bindings VALUES \
                             ('relay','workspace','main',?1,'lineage',?2,'[]',0,'host',1,'instance','connection',1,NULL)",
                            rusqlite::params![key.object_id, path],
                        )
                    }
                    .map_err(dohc_engine_storage::StorageError::persist_public)
                })
                .unwrap();
            let result = store.write_with(&dohc_engine_storage::NoFaults, |tx| {
                capture_ingest_fixture_in_tx(tx, &key, path, "- parent\n  - child\n")
            });
            assert!(
                matches!(
                    result,
                    Err(dohc_engine_sync::SyncError::InvalidInput {
                        reason: "ydoc-resolution-not-representable"
                    })
                ),
                "owner binding: {owner_binding}, {result:?}"
            );
            let marker = dohc_engine_collab::read_marker(&store, &key)
                .unwrap()
                .expect("bound seed remains");
            assert_eq!(marker.head_update_seq, 1);
            assert_eq!(
                VersionedTextStore::new(&mut store)
                    .read_text("workspace", "main", path)
                    .unwrap()
                    .unwrap()
                    .text,
                ""
            );
        }
    }

    #[test]
    fn an_empty_seed_edited_back_to_empty_cannot_be_retired() {
        let (_scratch, mut store, mut cache) = fixture();
        let path = "tasks/empty.md";
        let key = seed(&mut store, &mut cache, path, "");
        let doc = store
            .read_with(|conn| dohc_engine_collab::load_doc_in(conn, &key))
            .unwrap();
        for text in ["An edit", ""] {
            let update = doc
                .rewrite_content_to_markdown_for_fold(ContentKind::Richdoc, text)
                .unwrap();
            store
                .write_with(&dohc_engine_storage::NoFaults, |tx| {
                    dohc_engine_collab::record_update_in_tx(tx, &key, &update, None, None, 5)
                })
                .unwrap();
        }
        let result = store.write_with(&dohc_engine_storage::NoFaults, |tx| {
            dohc_engine_sync::fold_resolution_into_ydoc_in_tx(
                tx,
                "workspace",
                "main",
                &key.object_id,
                path,
                "- parent\n  - child\n",
                6,
            )
        });
        assert!(
            matches!(
                result,
                Err(dohc_engine_sync::SyncError::InvalidInput {
                    reason: "ydoc-resolution-not-representable"
                })
            ),
            "{result:?}"
        );
        assert_eq!(
            dohc_engine_collab::read_marker(&store, &key)
                .unwrap()
                .unwrap()
                .head_update_seq,
            3
        );
    }

    fn capture_ingest_fixture_in_tx(
        tx: &rusqlite::Transaction<'_>,
        key: &DocKey,
        path: &str,
        text: &str,
    ) -> Result<Option<dohc_engine_domain::CollectionRecordApplyFacts>, dohc_engine_sync::SyncError>
    {
        dohc_engine_domain::capture_ingest_in_tx(
            tx,
            &dohc_engine_domain::CaptureIngest {
                workspace_id: key.workspace_id.clone(),
                version_id: key.version_id.clone(),
                path: path.into(),
                text: text.into(),
                metadata_origin: "capture".into(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 5,
                request_id: None,
                claim_foreign_head: true,
            },
        )
        .unwrap();
        dohc_engine_sync::reconcile_local_resulting_head_in_tx(
            tx,
            &key.workspace_id,
            &key.version_id,
            &key.object_id,
            dohc_engine_sync::ResultingHead::Text { path, text },
            None,
            None,
            5,
        )
    }

    #[test]
    fn canonical_empty_seed_completion_adopts_without_a_source_witness() {
        assert_completed_empty_seed_adopts("Completed");
    }

    fn assert_completed_empty_seed_adopts(completed: &str) {
        let (scratch, mut store, mut cache) = fixture();
        let path = "tasks/empty.md";
        let key = seed(&mut store, &mut cache, path, "");
        std::fs::write(scratch.path().join(path), completed).expect("complete file");
        capture(&mut store, path, completed, 5);
        store
            .write_with(&dohc_engine_storage::NoFaults, |tx| {
                dohc_engine_sync::fold_resolution_into_ydoc_in_tx(
                    tx,
                    "workspace",
                    "main",
                    &key.object_id,
                    path,
                    completed,
                    5,
                )
            })
            .expect("fold completed Markdown");
        let doc = store
            .read_with(|conn| dohc_engine_collab::load_doc_in(conn, &key))
            .expect("folded lineage");
        assert_eq!(
            store
                .read_with(|conn| dohc_engine_sync::project_ydoc_with_store(
                    conn,
                    &key,
                    &doc,
                    ContentKind::Richdoc
                ))
                .unwrap()
                .content,
            completed
        );
        if completed == "Completed" {
            assert!(doc.markdown_source_reference().is_none());
        }
        capture(&mut store, path, completed, 6);
        cache.clear();
        reconcile(&mut store, &mut cache, scratch.path()).expect("adopt completed record");
        let adopted = VersionedTextStore::new(&mut store)
            .read_text("workspace", "main", path)
            .expect("snapshot")
            .expect("head");
        let frontmatter = dohc_engine_domain::collections::markdown_frontmatter_json(&adopted.text)
            .expect("adopted frontmatter");
        let record_id = frontmatter["id"].as_str().expect("adopted id");
        assert_eq!(
            adopted.text,
            collection_record_markdown_with_id(completed, record_id).unwrap()
        );
        assert_eq!(
            std::fs::read_to_string(scratch.path().join(path)).unwrap(),
            adopted.text
        );
        let state: String = store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT adoption_state FROM collection_records WHERE file_path=?1",
                    [path],
                    |row| row.get(0),
                )
            })
            .unwrap();
        assert_eq!(state, "adopted");
    }

    #[test]
    fn refused_record_keeps_its_state_without_blocking_siblings_and_recovers() {
        let (scratch, mut store, mut cache) = fixture();
        let stale = "tasks/a.md";
        let key = seed(&mut store, &mut cache, stale, "");
        std::fs::write(scratch.path().join(stale), "Completed\n").unwrap();
        for path in ["tasks/b.md", "tasks/c.md"] {
            seed(&mut store, &mut cache, path, "Sibling\n");
            std::fs::write(scratch.path().join(path), "Sibling\n").unwrap();
        }
        let result = reconcile(&mut store, &mut cache, scratch.path()).expect("reconcile siblings");
        assert_eq!(result.changed_paths, ["tasks/b.md", "tasks/c.md"]);
        let states: Vec<(String, String)> = store
            .read_with(|conn| {
                conn.prepare(
                    "SELECT file_path, adoption_state FROM collection_records ORDER BY file_path",
                )?
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
                .collect::<Result<_, rusqlite::Error>>()
            })
            .unwrap();
        assert_eq!(
            states,
            vec![
                (stale.to_owned(), "deferred-conflict-lossless".to_owned()),
                ("tasks/b.md".to_owned(), "adopted".to_owned()),
                ("tasks/c.md".to_owned(), "adopted".to_owned()),
            ]
        );
        let query = store
            .read_with(|conn| {
                query_collection_records(conn, "workspace", "tasks", &CollectionQuery::default())
            })
            .unwrap()
            .unwrap();
        assert_eq!(query.records.len(), 3);
        assert!(
            !query
                .records
                .iter()
                .find(|record| record.path == stale)
                .unwrap()
                .conflicted
        );
        for _ in 0..3 {
            let pending = store
                .read_with(|conn| list_pending_collection_adoptions(conn, "workspace", 100, None))
                .unwrap();
            assert!(
                pending.adoptions.is_empty(),
                "health polls must have nothing to drain"
            );
        }
        store
            .write_with(&dohc_engine_storage::NoFaults, |tx| {
                dohc_engine_sync::fold_resolution_into_ydoc_in_tx(
                    tx,
                    "workspace",
                    "main",
                    &key.object_id,
                    stale,
                    "Completed\n",
                    11,
                )
            })
            .expect("fold later content");
        capture(&mut store, stale, "Completed\n", 12);
        cache.clear();
        reconcile(&mut store, &mut cache, scratch.path()).expect("recover refused record");
        let remaining: i64 = store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT COUNT(*) FROM collection_records WHERE adoption_state!='adopted'",
                    [],
                    |row| row.get(0),
                )
            })
            .unwrap();
        assert_eq!(remaining, 0);
    }

    #[test]
    fn persisting_a_refusal_does_not_hide_storage_failure() {
        let (scratch, mut store, mut cache) = fixture();
        seed(&mut store, &mut cache, "tasks/a.md", "");
        std::fs::write(scratch.path().join("tasks/a.md"), "Completed\n").unwrap();
        store.write_with(&dohc_engine_storage::NoFaults, |tx| {
            tx.execute_batch("CREATE TRIGGER refuse_adoption_state BEFORE UPDATE OF adoption_state ON collection_records WHEN NEW.adoption_state='deferred-conflict-lossless' BEGIN SELECT RAISE(ABORT, 'storage failure'); END;")
                .map_err(dohc_engine_storage::StorageError::persist_public)
        }).unwrap();
        assert!(matches!(
            reconcile(&mut store, &mut cache, scratch.path()),
            Err(RuntimeError::Domain(DomainError::Storage(_)))
        ));
        assert!(!adoption_pending(&RuntimeError::Domain(
            DomainError::StateCorrupt {
                reason: "corrupt record"
            }
        )));
    }

    #[test]
    fn a_non_richdoc_record_stays_deferred_without_blocking_siblings() {
        let (scratch, mut store, mut cache) = fixture();
        let path = "tasks/a.md";
        let key = seed(&mut store, &mut cache, path, "Body\n");
        std::fs::write(scratch.path().join(path), "Body\n").unwrap();
        // Plaintext is a supported lineage kind, but not a Collection record.
        store
            .write_with(&dohc_engine_storage::NoFaults, |tx| {
                tx.execute(
                    "UPDATE ydoc_docs SET content_kind='plaintext' WHERE object_id=?1",
                    [&key.object_id],
                )
                .map_err(dohc_engine_storage::StorageError::persist_public)
            })
            .unwrap();
        seed(&mut store, &mut cache, "tasks/b.md", "Sibling\n");
        std::fs::write(scratch.path().join("tasks/b.md"), "Sibling\n").unwrap();
        cache.clear();
        let result = reconcile(&mut store, &mut cache, scratch.path()).unwrap();
        assert_eq!(result.changed_paths, ["tasks/b.md"]);
        let query = store
            .read_with(|conn| {
                query_collection_records(conn, "workspace", "tasks", &CollectionQuery::default())
            })
            .unwrap()
            .unwrap();
        assert!(
            !query
                .records
                .iter()
                .find(|record| record.path == path)
                .unwrap()
                .conflicted
        );
        let state: String = store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT adoption_state FROM collection_records WHERE file_path=?1",
                    [path],
                    |row| row.get(0),
                )
            })
            .unwrap();
        assert_eq!(state, "deferred-conflict-lossless");
        for _ in 0..3 {
            assert!(
                store
                    .read_with(|conn| {
                        list_pending_collection_adoptions(conn, "workspace", 100, None)
                    })
                    .unwrap()
                    .adoptions
                    .is_empty(),
                "a permanent refusal must not request another import"
            );
        }
        assert_eq!(
            std::fs::read_to_string(scratch.path().join(path)).unwrap(),
            "Body\n"
        );
    }

    #[test]
    fn adoption_refusals_do_not_hide_transient_or_storage_errors() {
        assert!(adoption_pending(&RuntimeError::Materialize(
            dohc_engine_files::MaterializeError::SymlinkTarget
        )));
        for error in [
            RuntimeError::Collab(CollabError::MissingDependencies),
            RuntimeError::Sync(dohc_engine_sync::SyncError::RetryableState {
                reason: "settlement-materialization-pending",
            }),
            RuntimeError::Domain(DomainError::StateCorrupt {
                reason: "corrupt record",
            }),
        ] {
            assert!(!adoption_pending(&error));
            assert!(!file_conflict(&error));
        }
        let stale = RuntimeError::Domain(DomainError::ConflictStaleTarget);
        assert!(adoption_pending(&stale));
        assert!(
            !file_conflict(&stale),
            "relation cleanup must propagate and re-arm stale targets"
        );
    }

    #[test]
    fn relation_cleanup_skips_a_never_opened_indented_code_referrer() {
        let (scratch, mut store, mut cache) = fixture();
        capture(
            &mut store,
            "tasks/collection.yaml",
            "fields:\n  related:\n    type: relation\n    collection: tasks\n    many: false\n",
            3,
        );
        let text = "---\nid: rec_aaaaaaaaaaaaaaaaaaaaaaaaaa\nrelated: rec_bbbbbbbbbbbbbbbbbbbbbbbbbb\n---\nInstall:\n\n    npm i foo";
        capture(&mut store, "tasks/a.md", text, 4);
        std::fs::write(scratch.path().join("tasks/a.md"), text).unwrap();
        let snapshot = VersionedTextStore::new(&mut store)
            .read_text("workspace", "main", "tasks/a.md")
            .unwrap()
            .unwrap();
        let result = cleanup_collection_relation_on_store(
            &mut store,
            &mut cache,
            &CollectionRelationCleanupCandidate {
                source_record_id: "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa".into(),
                source_file_path: "tasks/a.md".into(),
                source_object_id: snapshot.object_id,
                field_name: "related".into(),
                target_record_id: "rec_bbbbbbbbbbbbbbbbbbbbbbbbbb".into(),
                many: false,
            },
            "workspace",
            "main",
            scratch.path(),
            &LeaseRegistry::new(),
            &(),
            5,
            &dohc_engine_storage::NoFaults,
            &CancellationToken::new(),
            None,
        )
        .unwrap();
        assert!(matches!(
            result,
            CollectionRelationCleanupExecution::Skipped
        ));
        assert_eq!(
            std::fs::read_to_string(scratch.path().join("tasks/a.md")).unwrap(),
            text
        );
    }

    #[test]
    fn nested1b_relation_cleanup_skips_non_allowlisted_seed() {
        let (scratch, mut store, mut cache) = fixture();
        capture(
            &mut store,
            "tasks/collection.yaml",
            "fields:\n  related:\n    type: relation\n    collection: tasks\n    many: false\n",
            3,
        );
        let text = "---\nid: rec_aaaaaaaaaaaaaaaaaaaaaaaaaa\nrelated: rec_bbbbbbbbbbbbbbbbbbbbbbbbbb\n---\n- a\n  ---";
        capture(&mut store, "tasks/a.md", text, 4);
        std::fs::write(scratch.path().join("tasks/a.md"), text).unwrap();
        let snapshot = VersionedTextStore::new(&mut store)
            .read_text("workspace", "main", "tasks/a.md")
            .unwrap()
            .unwrap();
        let result = cleanup_collection_relation_on_store(
            &mut store,
            &mut cache,
            &CollectionRelationCleanupCandidate {
                source_record_id: "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa".into(),
                source_file_path: "tasks/a.md".into(),
                source_object_id: snapshot.object_id.clone(),
                field_name: "related".into(),
                target_record_id: "rec_bbbbbbbbbbbbbbbbbbbbbbbbbb".into(),
                many: false,
            },
            "workspace",
            "main",
            scratch.path(),
            &LeaseRegistry::new(),
            &(),
            5,
            &dohc_engine_storage::NoFaults,
            &CancellationToken::new(),
            None,
        )
        .unwrap();
        assert!(matches!(
            result,
            CollectionRelationCleanupExecution::Skipped
        ));
        assert_eq!(
            std::fs::read_to_string(scratch.path().join("tasks/a.md")).unwrap(),
            text
        );
        let after = VersionedTextStore::new(&mut store)
            .read_text("workspace", "main", "tasks/a.md")
            .unwrap()
            .unwrap();
        assert_eq!(after.latest_moment_id, snapshot.latest_moment_id);
        assert_eq!(after.text, text);
        let key = DocKey::new("workspace", "main", &snapshot.object_id).unwrap();
        assert!(
            dohc_engine_collab::load_persisted(&store, &key)
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn nested1b_relation_cleanup_keeps_exact_allowed_body() {
        let (scratch, mut store, mut cache) = fixture();
        capture(
            &mut store,
            "tasks/collection.yaml",
            "fields:\n  related:\n    type: relation\n    collection: tasks\n    many: false\n",
            3,
        );
        let text = "---\nid: rec_aaaaaaaaaaaaaaaaaaaaaaaaaa\nrelated: rec_bbbbbbbbbbbbbbbbbbbbbbbbbb\n---\n* parent\n\n    * child\n";
        capture(&mut store, "tasks/a.md", text, 4);
        std::fs::write(scratch.path().join("tasks/a.md"), text).unwrap();
        let snapshot = VersionedTextStore::new(&mut store)
            .read_text("workspace", "main", "tasks/a.md")
            .unwrap()
            .unwrap();
        let result = cleanup_collection_relation_on_store(
            &mut store,
            &mut cache,
            &CollectionRelationCleanupCandidate {
                source_record_id: "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa".into(),
                source_file_path: "tasks/a.md".into(),
                source_object_id: snapshot.object_id.clone(),
                field_name: "related".into(),
                target_record_id: "rec_bbbbbbbbbbbbbbbbbbbbbbbbbb".into(),
                many: false,
            },
            "workspace",
            "main",
            scratch.path(),
            &LeaseRegistry::new(),
            &(),
            5,
            &dohc_engine_storage::NoFaults,
            &CancellationToken::new(),
            None,
        )
        .unwrap();
        assert!(matches!(
            result,
            CollectionRelationCleanupExecution::Applied(_)
        ));
        let expected = text.replace("related: rec_bbbbbbbbbbbbbbbbbbbbbbbbbb\n", "");
        assert_eq!(
            std::fs::read_to_string(scratch.path().join("tasks/a.md")).unwrap(),
            expected
        );
        assert_eq!(
            VersionedTextStore::new(&mut store)
                .read_text("workspace", "main", "tasks/a.md")
                .unwrap()
                .unwrap()
                .text,
            expected
        );
        let key = DocKey::new("workspace", "main", &snapshot.object_id).unwrap();
        drop(store);
        let store =
            EngineStore::open(&dohc_engine_testkit::engine_db_path(&scratch).unwrap(), 6).unwrap();
        let loaded = dohc_engine_collab::load_persisted(&store, &key)
            .unwrap()
            .unwrap();
        let canonical = loaded.doc.project(ContentKind::Richdoc).unwrap().content;
        assert_eq!(
            loaded.doc.preserved_markdown_source(&canonical).as_deref(),
            Some(expected.as_str())
        );
    }

    #[test]
    fn relation_cleanup_skips_a_symlink_referrer_then_retries_after_replacement() {
        let (scratch, mut store, mut cache) = fixture();
        seed_relation_referrers(&mut store, &mut cache, scratch.path());
        let target = scratch.path().join("symlink-target.md");
        let path = scratch.path().join("tasks/a.md");
        let original = std::fs::read_to_string(&path).unwrap();
        std::fs::rename(&path, &target).unwrap();
        if !dohc_engine_testkit::try_make_file_symlink(&target, &path).unwrap() {
            eprintln!("file symlink privilege unavailable; skipping symlink referrer test");
            return;
        }
        assert_relation_cleanup_skips_only_broken_referrer(&mut store, &mut cache, scratch.path());
        assert!(
            std::fs::symlink_metadata(&path)
                .unwrap()
                .file_type()
                .is_symlink()
        );
        assert_eq!(std::fs::read_to_string(&target).unwrap(), original);
        assert_relation_referrer_is_retried(&mut store, &mut cache, scratch.path());
        let indexed = store
            .read_with(|conn| {
                query_collection_records(conn, "workspace", "tasks", &CollectionQuery::default())
            })
            .unwrap()
            .unwrap();
        let referrer = indexed
            .records
            .iter()
            .find(|record| record.path == "tasks/a.md")
            .unwrap();
        assert!(referrer.values.iter().any(|value| {
            value.field == "related" && value.value == "rec_bbbbbbbbbbbbbbbbbbbbbbbbbb"
        }));
        cache.clear();
        let state = ydoc_open_state_on_store(
            &mut store,
            &mut cache,
            "workspace",
            10,
            false,
            None,
            "main",
            "tasks/a.md",
            Some(ContentKind::Richdoc),
            false,
            &CancellationToken::new(),
        )
        .unwrap();
        let doc = Ydoc::wire();
        doc.apply(&state.initial_update).unwrap();
        assert_eq!(
            doc.frontmatter_json()["related"],
            "rec_bbbbbbbbbbbbbbbbbbbbbbbbbb"
        );

        std::fs::remove_file(&path).unwrap();
        std::fs::rename(&target, &path).unwrap();
        let result = reconcile(&mut store, &mut cache, scratch.path()).unwrap();
        assert_eq!(result.changed_paths, ["tasks/a.md"]);
        assert!(!std::fs::read_to_string(&path).unwrap().contains("related:"));
        assert!(
            reconcile(&mut store, &mut cache, scratch.path())
                .unwrap()
                .changed_paths
                .is_empty()
        );
    }

    #[test]
    fn relation_cleanup_skips_a_non_richdoc_referrer_without_blocking_siblings() {
        let (scratch, mut store, mut cache) = fixture();
        let key = seed_relation_referrers(&mut store, &mut cache, scratch.path());
        store
            .write_with(&dohc_engine_storage::NoFaults, |tx| {
                tx.execute(
                    "UPDATE ydoc_docs SET content_kind='plaintext' WHERE object_id=?1",
                    [&key.object_id],
                )
                .map_err(dohc_engine_storage::StorageError::persist_public)
            })
            .unwrap();
        cache.clear();
        let original = std::fs::read_to_string(scratch.path().join("tasks/a.md")).unwrap();
        assert_relation_cleanup_skips_only_broken_referrer(&mut store, &mut cache, scratch.path());
        assert_eq!(
            std::fs::read_to_string(scratch.path().join("tasks/a.md")).unwrap(),
            original
        );
        assert_relation_referrer_is_retried(&mut store, &mut cache, scratch.path());
    }

    #[test]
    fn relation_cleanup_propagates_an_identity_change_between_opens() {
        for replacement_kind in [ContentKind::Richdoc, ContentKind::Plaintext] {
            let (scratch, mut store, mut cache) = fixture();
            let key = seed_relation_referrers(&mut store, &mut cache, scratch.path());
            let TxnOutcome::Committed(reconciliation) = store
                .write_with(&dohc_engine_storage::NoFaults, |tx| {
                    reconcile_collections_in_tx(tx, "workspace", "main")
                })
                .unwrap()
            else {
                panic!("candidate enumeration must commit");
            };
            let candidate = reconciliation
                .relation_cleanups
                .into_iter()
                .find(|candidate| candidate.source_file_path == "tasks/a.md")
                .unwrap();
            store
                .write_with(&dohc_engine_storage::NoFaults, |tx| {
                    tx.execute("DELETE FROM ydoc_updates WHERE object_id=?1", [&key.object_id])
                        .map_err(dohc_engine_storage::StorageError::persist_public)?;
                    tx.execute(
                        "UPDATE ydoc_docs SET content_kind='plaintext',head_update_seq=0,head_snapshot_seq=0,settled_update_seq=NULL,lineage_claim_status='unclaimed',lineage_claim_id=NULL WHERE object_id=?1",
                        [&key.object_id],
                    ).map_err(dohc_engine_storage::StorageError::persist_public)?;
                    tx.execute(
                        "UPDATE ydoc_docs SET content_kind=?1 WHERE path='tasks/z.md'",
                        [replacement_kind.as_str()],
                    ).map_err(dohc_engine_storage::StorageError::persist_public)?;
                    // Rewriting the bare marker during the probe rebinds the path before the second open.
                    tx.execute_batch(
                        "CREATE TEMP TRIGGER rebind_referrer AFTER UPDATE OF content_kind ON ydoc_docs \
                         WHEN NEW.path='tasks/a.md' AND NEW.content_kind='richdoc' BEGIN \
                         UPDATE path_aliases SET object_id=(SELECT object_id FROM path_aliases \
                         WHERE workspace_id='workspace' AND version_id='main' AND path='tasks/z.md') \
                         WHERE workspace_id='workspace' AND version_id='main' AND path='tasks/a.md'; END;",
                    ).map_err(dohc_engine_storage::StorageError::persist_public)
                })
                .unwrap();
            cache.clear();
            let error = cleanup_collection_relation_on_store(
                &mut store,
                &mut cache,
                &candidate,
                "workspace",
                "main",
                scratch.path(),
                &LeaseRegistry::new(),
                &(),
                10,
                &dohc_engine_storage::NoFaults,
                &CancellationToken::new(),
                None,
            )
            .err()
            .expect("identity changes must fail cleanup");
            assert!(
                matches!(
                    error,
                    RuntimeError::Domain(DomainError::StateCorrupt {
                        reason: "collection relation referrer changed identity during cleanup"
                    })
                ),
                "expected identity corruption, got {error:?}"
            );
        }
    }

    fn seed_relation_referrers(
        store: &mut EngineStore,
        cache: &mut WriterDocCache,
        root: &std::path::Path,
    ) -> DocKey {
        capture(
            store,
            "tasks/collection.yaml",
            "fields:\n  related:\n    type: relation\n    collection: tasks\n    many: false\n",
            3,
        );
        let mut broken_key = None;
        for (path, id) in [
            ("tasks/a.md", "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa"),
            ("tasks/z.md", "rec_cccccccccccccccccccccccccc"),
        ] {
            let text =
                format!("---\nid: {id}\nrelated: rec_bbbbbbbbbbbbbbbbbbbbbbbbbb\n---\nSource\n");
            let key = seed(store, cache, path, &text);
            std::fs::write(root.join(path), text).unwrap();
            if path == "tasks/a.md" {
                broken_key = Some(key);
            }
        }
        broken_key.unwrap()
    }

    fn assert_relation_cleanup_skips_only_broken_referrer(
        store: &mut EngineStore,
        cache: &mut WriterDocCache,
        root: &std::path::Path,
    ) {
        let result =
            reconcile(store, cache, root).expect("broken referrer must not abort the pass");
        assert!(result.changed_paths.contains(&"tasks/z.md".to_owned()));
        let healthy = std::fs::read_to_string(root.join("tasks/z.md")).unwrap();
        assert!(
            !healthy.contains("related:"),
            "healthy referrer must reconcile"
        );
    }

    fn assert_relation_referrer_is_retried(
        store: &mut EngineStore,
        cache: &mut WriterDocCache,
        root: &std::path::Path,
    ) {
        for _ in 0..2 {
            let candidates = store
                .write_with(&dohc_engine_storage::NoFaults, |tx| {
                    reconcile_collections_in_tx(tx, "workspace", "main")
                })
                .unwrap();
            let TxnOutcome::Committed(candidates) = candidates else {
                panic!("candidate enumeration must commit");
            };
            assert_eq!(candidates.relation_cleanups.len(), 1);
            assert_eq!(
                candidates.relation_cleanups[0].source_file_path,
                "tasks/a.md"
            );
            assert!(
                reconcile(store, cache, root)
                    .unwrap()
                    .changed_paths
                    .is_empty()
            );
        }
    }

    #[test]
    fn relation_cleanup_propagates_a_stale_target_for_reconciliation_retry() {
        let (scratch, mut store, mut cache) = fixture();
        capture(
            &mut store,
            "tasks/collection.yaml",
            "fields:\n  related:\n    type: relation\n    collection: tasks\n    many: false\n",
            3,
        );
        let path = "tasks/source.md";
        let original = "---\nid: rec_aaaaaaaaaaaaaaaaaaaaaaaaaa\nrelated: rec_bbbbbbbbbbbbbbbbbbbbbbbbbb\n---\nSource\n";
        seed(&mut store, &mut cache, path, original);
        std::fs::write(scratch.path().join(path), "A newer disk preimage\n").unwrap();
        assert!(matches!(
            reconcile(&mut store, &mut cache, scratch.path()),
            Err(RuntimeError::Domain(DomainError::ConflictStaleTarget))
        ));
        assert_eq!(
            std::fs::read_to_string(scratch.path().join(path)).unwrap(),
            "A newer disk preimage\n",
            "cleanup must not replace a stale disk target"
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
                    // A canonical fold needs no source witness. Its current
                    // snapshot still permits lossless id insertion.
                    let canonical = doc.project(ContentKind::Richdoc)?;
                    return Ok(VersionedTextStore::new(store)
                        .read_text(&key.workspace_id, &key.version_id, &candidate.file_path)?
                        .filter(|snapshot| {
                            snapshot.object_id == candidate.object_id
                                && Some(&snapshot.blob_sha256) == head_blob_sha256
                                && snapshot.text == canonical.content
                        })
                        .and_then(|snapshot| {
                            collection_record_markdown_with_id(&snapshot.text, &candidate.record_id)
                        })
                        .map(Some));
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
    if probe.content_kind != ContentKind::Richdoc {
        return Err(DomainError::InvalidInput {
            reason: "collection record does not have a rich-document lineage",
        }
        .into());
    }
    // An empty captured head can lag a refused external completion. Do not
    // add an id to that obsolete seed or acquire a lease that would re-offer
    // the parked file on every release. The next disk change retries capture.
    if session_key.is_none()
        && probe.head_blob_sha256.as_deref() == Some(hex_sha256(b"").as_str())
        && matches!(dohc_engine_files::probe_projection_target(root_dir, &candidate.file_path,
            dohc_engine_files::ProjectionTargetKind::Plaintext),
            dohc_engine_files::ProjectionTargetState::Text { sha256 }
                if Some(&sha256) != probe.head_blob_sha256.as_ref())
    {
        return Err(DomainError::ConflictStaleTarget.into());
    }
    let _lease = if let Some(key) = session_key {
        if key != &probe.key {
            return Err(DomainError::ConflictStaleTarget.into());
        }
        None
    } else {
        match leases.acquire_internal(&probe.key) {
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
    if state.key != probe.key {
        return Err(DomainError::StateCorrupt {
            reason: "collection record changed identity during adoption",
        }
        .into());
    }
    if state.content_kind != ContentKind::Richdoc {
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
            false,
        )?
        .into_settlement_for_internal_caller()?
        .path,
    );
    Ok(Some(CollectionAdoptionExecution::Applied { changed_path }))
}

enum CollectionRelationCleanupExecution {
    Applied(String),
    NoChange,
    Skipped,
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
    match dohc_engine_files::materialize::write_precondition_sha256(
        root_dir,
        &candidate.source_file_path,
    ) {
        Ok(_) => {}
        Err(dohc_engine_files::MaterializeError::SymlinkTarget) => {
            return Ok(CollectionRelationCleanupExecution::Skipped);
        }
        Err(error) => return Err(error.into()),
    }
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
    let _lease = match leases.acquire_internal(&probe.key) {
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
    if state.key != probe.key {
        return Err(DomainError::StateCorrupt {
            reason: "collection relation referrer changed identity during cleanup",
        }
        .into());
    }
    if state.content_kind != ContentKind::Richdoc {
        return Ok(CollectionRelationCleanupExecution::Skipped);
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
        match doc.seed_collection_relation_markdown(seed) {
            Err(CollabError::MarkdownNotRepresentable) => {
                return Ok(CollectionRelationCleanupExecution::Skipped);
            }
            result => {
                result?;
            }
        }
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
        false,
    )?
    .into_settlement_for_internal_caller()?;
    Ok(CollectionRelationCleanupExecution::Applied(settlement.path))
}

/// Receives durable reconcile steps on the actor; must not re-enter it.
pub type CollectionCommitListener = Arc<dyn Fn(&CollectionReconciliation) + Send + Sync>;

/// What one collection reconciliation changed.
#[derive(Debug, Default)]
pub struct CollectionReconciliation {
    /// An adoption candidate or relation-cleanup source still has a live lease.
    pub lease_held: bool,
    /// Workspace paths the reconciliation rewrote: record id adoptions and
    /// relation cleanups.
    pub changed_paths: Vec<String>,
    /// Automation claims for the records it added or removed on this
    /// computer, committed with the bindings. The caller announces them.
    pub automation_claims: Vec<dohc_engine_domain::AutomationClaim>,
    /// An ordinary pull has not finished, so nothing ran. Its terminal
    /// commit, or abandoning it, asks for the update again.
    pub waits_for_pull: bool,
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
    committed: Option<&(dyn Fn(&CollectionReconciliation) + Send + Sync)>,
) -> Result<CollectionReconciliation, RuntimeError> {
    if token.is_cancelled() {
        return Err(RuntimeError::Cancelled);
    }
    validate_workspace_root(root_dir, root_guard)?;
    let (reconciliation, automation_claims) = match store.write_with(faults, |tx| {
        // Half a pull can lack a relation's target that a later page brings.
        if dohc_engine_sync::ordinary_pull_unfinished_in(tx, workspace_id)? {
            return Ok::<_, RuntimeError>(None);
        }
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
        Ok(Some((reconciliation, claims)))
    })? {
        TxnOutcome::Committed(Some(committed)) => committed,
        TxnOutcome::Committed(None) => {
            return Ok(CollectionReconciliation {
                waits_for_pull: true,
                ..Default::default()
            });
        }
        TxnOutcome::Crashed { .. } => return Err(RuntimeError::OperationCrashed),
    };

    if let Some(committed) = committed {
        committed(&CollectionReconciliation {
            automation_claims: automation_claims.clone(),
            ..Default::default()
        });
    }
    let mut changed_paths = Vec::new();
    let mut pending_seed_objects = HashSet::new();
    let mut lease_held = false;
    for candidate in reconciliation.adoptions {
        if token.is_cancelled() {
            return Err(RuntimeError::Cancelled);
        }
        if dohc_engine_files::placement_is_held_in(store, workspace_id, &candidate.file_path)? {
            continue;
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
                    if let Some(committed) = committed {
                        committed(&CollectionReconciliation {
                            changed_paths: vec![path.clone()],
                            ..Default::default()
                        });
                    }
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
            Err(error) if file_conflict(&error) || adoption_pending(&error) => {
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
        if dohc_engine_files::placement_is_held_in(
            store,
            workspace_id,
            &candidate.source_file_path,
        )? {
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
                    if let Some(committed) = committed {
                        committed(&CollectionReconciliation {
                            changed_paths: vec![path.clone()],
                            ..Default::default()
                        });
                    }
                    changed_paths.push(path);
                }
            }
            Ok(
                CollectionRelationCleanupExecution::NoChange
                | CollectionRelationCleanupExecution::Skipped,
            ) => {}
            Ok(CollectionRelationCleanupExecution::LeaseHeld) => {
                lease_held = true;
            }
            Err(error) if file_conflict(&error) => {}
            Err(error) => return Err(error),
        }
    }
    Ok(CollectionReconciliation {
        lease_held,
        changed_paths,
        automation_claims,
        waits_for_pull: false,
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
    const PACKING: &str = "tasks/packing.md";
    const FLIGHTS: &str = "tasks/flights.md";
    const SOURCE: &str = "---\nid: rec_aaaaaaaaaaaaaaaaaaaaaaaaaa\nrelated: rec_bbbbbbbbbbbbbbbbbbbbbbbbbb\n---\n\n# Packing list\n\n<details>\n<summary>Extras</summary>\n\nSunscreen and a spare charger.\n</details>\n\nSee [the airline's bag rules][bags].\n\n[bags]: https://example.com/bags\n";
    const TARGET: &str = "---\nid: rec_bbbbbbbbbbbbbbbbbbbbbbbbbb\n---\n\n# Book flights\n";
    const REWRITTEN: &str = "---\nid: rec_aaaaaaaaaaaaaaaaaaaaaaaaaa\n---\n\n# Packing list\n\n&lt;details&gt;\n&lt;summary&gt;Extras&lt;/summary&gt;\n\nSunscreen and a spare charger.\n\n&lt;/details&gt;\n\nSee [the airline's bag rules](https://example.com/bags).\n\n&#91;bags&#93;&#58; https&#58;//example&#46;com/bags";

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
    fn adopted_lossy_relation_cleanup_preserves_source_without_opening() {
        assert_adopted_lossy_relation_cleanup_preserves_source(false);
    }

    #[test]
    fn adopted_lossy_relation_cleanup_preserves_source_after_opening() {
        assert_adopted_lossy_relation_cleanup_preserves_source(true);
    }

    fn adopted_lossy_fixture(reopen_note: bool) -> (ScratchDir, EngineStore, WriterDocCache) {
        let scratch = ScratchDir::new().unwrap();
        let mut store =
            EngineStore::open(&dohc_engine_testkit::engine_db_path(&scratch).unwrap(), 1).unwrap();
        ensure_mutation_version_on_store(&mut store, WORKSPACE_ID, VERSION_ID, 1, &NoFaults)
            .unwrap();
        std::fs::create_dir_all(scratch.path().join("tasks")).unwrap();
        for (object, path, text, moment) in [
            (
                "schema",
                "tasks/collection.yaml",
                "fields:\n  related:\n    type: relation\n    collection: tasks\n    many: false\n",
                "schema-moment",
            ),
            (SOURCE_OBJECT_ID, PACKING, SOURCE, "packing-moment"),
            ("flights-object", FLIGHTS, TARGET, "flights-moment"),
        ] {
            write_text(&mut store, object, path, text, moment, 2);
            std::fs::write(scratch.path().join(path), text).unwrap();
        }
        let mut cache = WriterDocCache::new();
        let token = CancellationToken::new();
        let reconcile = |store: &mut EngineStore, cache: &mut WriterDocCache, now_ms| {
            reconcile_lossy_fixture(store, cache, scratch.path(), now_ms)
        };
        reconcile(&mut store, &mut cache, 3);

        for (path, seed) in [
            (
                PACKING,
                // Adoption seed from a desktop build.
                include_bytes!("../../tests/fixtures/adopted-lossy-packing-seed.bin").to_vec(),
            ),
            (FLIGHTS, {
                let doc = Ydoc::wire();
                doc.rewrite_content_to_markdown_preserving_source(ContentKind::Richdoc, TARGET)
                    .unwrap();
                doc.encode_full_state()
            }),
        ] {
            let state = ydoc_open_state_on_store(
                &mut store,
                &mut cache,
                WORKSPACE_ID,
                4,
                false,
                None,
                VERSION_ID,
                path,
                Some(ContentKind::Richdoc),
                false,
                &token,
            )
            .unwrap();
            assert!(!state.lineage_existing);
            ydoc_record_update_on_store(
                &mut store,
                &mut cache,
                &state.key,
                path,
                ContentKind::Richdoc,
                state.regime,
                &seed,
                None,
                None,
                state.lineage_claim_id,
                true,
                state.owner_seed_source,
                None,
                false,
                4,
                &NoFaults,
                &token,
                None,
            )
            .unwrap();
        }
        reconcile(&mut store, &mut cache, 5);
        assert_eq!(
            std::fs::read(scratch.path().join(PACKING)).unwrap(),
            SOURCE.as_bytes()
        );
        let key = DocKey::new(WORKSPACE_ID, VERSION_ID, SOURCE_OBJECT_ID).unwrap();
        let seeded = dohc_engine_collab::load_persisted(&store, &key)
            .unwrap()
            .unwrap();
        let reference = seeded.doc.markdown_source_reference().unwrap();
        assert_eq!(
            seeded.doc.markdown_source(&reference).as_deref(),
            Some(SOURCE)
        );
        assert_eq!(
            dohc_engine_collab::read_marker(&store, &key)
                .unwrap()
                .unwrap()
                .head_update_seq,
            1,
            "adoption must leave only the file seed, with no intervening edit"
        );
        let adopted: String = store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT adoption_state FROM collection_records WHERE file_path=?1",
                    [PACKING],
                    |row| row.get(0),
                )
            })
            .unwrap();
        assert_eq!(adopted, "adopted");

        if reopen_note {
            let state = ydoc_open_state_on_store(
                &mut store,
                &mut cache,
                WORKSPACE_ID,
                6,
                false,
                None,
                VERSION_ID,
                PACKING,
                Some(ContentKind::Richdoc),
                false,
                &token,
            )
            .unwrap();
            assert!(state.lineage_existing);
        }
        (scratch, store, cache)
    }

    fn reconcile_lossy_fixture(
        store: &mut EngineStore,
        cache: &mut WriterDocCache,
        root: &std::path::Path,
        now_ms: i64,
    ) {
        reconcile_collections_on_store(
            store,
            cache,
            WORKSPACE_ID,
            VERSION_ID,
            root,
            None,
            &LeaseRegistry::default(),
            &(),
            now_ms,
            &NoFaults,
            &CancellationToken::new(),
            None,
        )
        .unwrap();
    }

    fn delete_lossy_fixture_target(scratch: &ScratchDir, store: &mut EngineStore) {
        use dohc_engine_domain::DeleteTextFile;

        std::fs::remove_file(scratch.path().join(FLIGHTS)).unwrap();
        VersionedTextStore::new(store)
            .delete_text_file(
                &DeleteTextFile {
                    workspace_id: WORKSPACE_ID.into(),
                    version_id: VERSION_ID.into(),
                    path: FLIGHTS.into(),
                    moment_id: "flights-delete".into(),
                    request_id: None,
                    metadata_origin: "explorer".into(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: None,
                    now_ms: 7,
                },
                &NoFaults,
            )
            .unwrap();
    }

    fn assert_adopted_lossy_relation_cleanup_preserves_source(reopen_note: bool) {
        let (scratch, mut store, mut cache) = adopted_lossy_fixture(reopen_note);
        delete_lossy_fixture_target(&scratch, &mut store);
        reconcile_lossy_fixture(&mut store, &mut cache, scratch.path(), 8);
        let actual = std::fs::read(scratch.path().join(PACKING)).unwrap();
        let without_relation = SOURCE.replace(&format!("related: {TARGET_ID}\n"), "");
        let key = DocKey::new(WORKSPACE_ID, VERSION_ID, SOURCE_OBJECT_ID).unwrap();
        let cleaned = dohc_engine_collab::load_persisted(&store, &key)
            .unwrap()
            .unwrap();
        let reference = cleaned.doc.markdown_source_reference().unwrap();
        assert_eq!(
            cleaned.doc.markdown_source(&reference).as_deref(),
            Some(without_relation.as_str()),
            "the cleanup delta must retain the exact body in its source witness"
        );
        assert_eq!(
            actual,
            without_relation.as_bytes(),
            "cleanup must reach disk (reopen_note={reopen_note})",
        );
        let snapshot = VersionedTextStore::new(&mut store)
            .read_text(WORKSPACE_ID, VERSION_ID, PACKING)
            .unwrap()
            .unwrap();
        assert_eq!(
            snapshot.text, without_relation,
            "cleanup must reach stored text (reopen_note={reopen_note})",
        );
    }

    #[test]
    fn history_restore_after_relation_cleanup_rewrite() {
        let (scratch, mut store, mut cache) = adopted_lossy_fixture(false);
        delete_lossy_fixture_target(&scratch, &mut store);
        reconcile_lossy_fixture(&mut store, &mut cache, scratch.path(), 8);
        assert_history_restore(true, &scratch, &mut store, &mut cache);
    }

    #[test]
    fn history_restore_of_lossy_version_over_rewritten_text() {
        let (scratch, mut store, mut cache) = adopted_lossy_fixture(false);
        let key = DocKey::new(WORKSPACE_ID, VERSION_ID, SOURCE_OBJECT_ID).unwrap();
        let persisted = dohc_engine_collab::load_persisted(&store, &key)
            .unwrap()
            .unwrap();
        let update = persisted
            .doc
            .frontmatter_drop_relation_target_preserving_markdown_source(
                "related", TARGET_ID, false,
            )
            .unwrap()
            .unwrap();
        ydoc_record_update_on_store(
            &mut store,
            &mut cache,
            &key,
            PACKING,
            ContentKind::Richdoc,
            persisted.marker.regime,
            &update,
            Some("engine".into()),
            None,
            persisted.marker.lineage_claim_id,
            false,
            None,
            None,
            false,
            8,
            &NoFaults,
            &CancellationToken::new(),
            None,
        )
        .unwrap();
        // Use the old fallback bytes with the same settlement write and marker.
        // This fixture must also exist after cleanup stops producing these bytes.
        settle_lossy_fixture(&scratch, &mut store, &mut cache, Some(REWRITTEN.into()), 9);
        assert_eq!(
            std::fs::read(scratch.path().join(PACKING)).unwrap(),
            REWRITTEN.as_bytes()
        );
        assert_history_restore(false, &scratch, &mut store, &mut cache);
    }

    fn settle_lossy_fixture(
        scratch: &ScratchDir,
        store: &mut EngineStore,
        cache: &mut WriterDocCache,
        content_override: Option<String>,
        now_ms: i64,
    ) {
        let state = ydoc_open_state_on_store(
            store,
            cache,
            WORKSPACE_ID,
            now_ms,
            false,
            None,
            VERSION_ID,
            PACKING,
            Some(ContentKind::Richdoc),
            false,
            &CancellationToken::new(),
        )
        .unwrap();
        assert!(state.lineage_existing);
        ydoc_settle_on_store(
            store,
            cache,
            scratch.path(),
            &state.key,
            PACKING,
            ContentKind::Richdoc,
            false,
            state.lineage_claim_id.as_deref(),
            state.head_blob_sha256,
            content_override,
            "history-restore-test",
            &(),
            now_ms,
            &NoFaults,
            &CancellationToken::new(),
            None,
            None,
            None,
            super::super::ydoc::SettlementKind::Document,
            false,
        )
        .unwrap()
        .into_settlement_for_internal_caller()
        .unwrap();
    }

    fn assert_history_restore(
        expect_exact: bool,
        scratch: &ScratchDir,
        store: &mut EngineStore,
        cache: &mut WriterDocCache,
    ) {
        use super::super::versioned::{
            WriteConditions, versioned_text_write_with_publication_on_store,
            with_local_file_mutation_cache_reset,
        };

        let key = DocKey::new(WORKSPACE_ID, VERSION_ID, SOURCE_OBJECT_ID).unwrap();
        let current = VersionedTextStore::new(store)
            .read_text(WORKSPACE_ID, VERSION_ID, PACKING)
            .unwrap()
            .unwrap();
        // History restores the pre-moment bytes, not a separately supplied repair.
        let earlier: String = store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT b.text FROM moments m JOIN blobs b ON b.sha256=m.before_blob_sha256 \
                     WHERE m.workspace_id=?1 AND m.moment_id=?2",
                    [WORKSPACE_ID, current.latest_moment_id.as_str()],
                    |row| row.get(0),
                )
            })
            .unwrap();
        assert_eq!(earlier, SOURCE);
        let before_bytes = std::fs::read(scratch.path().join(PACKING)).unwrap();
        let before_doc = dohc_engine_collab::load_persisted(store, &key)
            .unwrap()
            .unwrap();
        let before_reference = before_doc.doc.markdown_source_reference();
        let before_source = before_reference
            .as_ref()
            .and_then(|reference| before_doc.doc.markdown_source(reference));
        let moment_count = |store: &EngineStore| -> i64 {
            store
                .read_with(|conn| {
                    conn.query_row(
                        "SELECT count(*) FROM moments WHERE workspace_id=?1",
                        [WORKSPACE_ID],
                        |row| row.get(0),
                    )
                })
                .unwrap()
        };
        let before_count = moment_count(store);
        let expected_sha = dohc_engine_storage::hex_sha256(&before_bytes);
        assert_eq!(current.blob_sha256, expected_sha);
        let input = WriteText {
            workspace_id: WORKSPACE_ID.into(),
            version_id: VERSION_ID.into(),
            object_id: SOURCE_OBJECT_ID.into(),
            path: PACKING.into(),
            text: earlier,
            moment_id: "packing-restore".into(),
            request_id: Some("packing-restore-request".into()),
            metadata_origin: "restore".into(),
            metadata_summary: Some("Restored packing.md".into()),
            metadata_correlation_id: None,
            author_json: None,
            now_ms: 10,
        };
        let result = with_local_file_mutation_cache_reset(cache, || {
            versioned_text_write_with_publication_on_store(
                store,
                &input,
                Some(scratch.path()),
                Some(&current.latest_moment_id),
                Some(&WriteConditions {
                    create_only: false,
                    expected_sha256: Some(expected_sha),
                }),
                None,
                &NoFaults,
                &CancellationToken::new(),
            )
        });
        match result {
            Ok(write) => {
                assert!(expect_exact, "restore over rewritten text must be refused");
                assert_eq!(moment_count(store), before_count + 1);
                let job = store
                    .load_materialization_job(&format!("authored-mat_{}", write.moment.moment_id))
                    .unwrap()
                    .unwrap();
                let (materialized, _) = super::super::materialization::materialize_pending_job(
                    store,
                    scratch.path(),
                    WORKSPACE_ID,
                    &job,
                    &(),
                    10,
                    &NoFaults,
                    None,
                );
                assert!(
                    materialized,
                    "restore did not reach disk: {}",
                    std::fs::read_to_string(scratch.path().join(PACKING)).unwrap(),
                );
                assert_exact_lossy_restore(scratch, store);
                settle_lossy_fixture(scratch, store, cache, None, 11);
                assert_exact_lossy_restore(scratch, store);
                assert_eq!(moment_count(store), before_count + 1);
            }
            Err(error) => {
                assert!(
                    !expect_exact,
                    "restore after cleanup must succeed: {error:?}"
                );
                let actual = std::fs::read(scratch.path().join(PACKING)).unwrap();
                let snapshot = VersionedTextStore::new(store)
                    .read_text(WORKSPACE_ID, VERSION_ID, PACKING)
                    .unwrap()
                    .unwrap();
                let after_doc = dohc_engine_collab::load_persisted(store, &key)
                    .unwrap()
                    .unwrap();
                let reference = after_doc.doc.markdown_source_reference();
                let source = reference
                    .as_ref()
                    .and_then(|reference| after_doc.doc.markdown_source(reference));
                assert!(
                    actual == before_bytes
                        && snapshot.blob_sha256 == current.blob_sha256
                        && snapshot.text == current.text
                        && after_doc.marker.head_update_seq == before_doc.marker.head_update_seq
                        && reference == before_reference
                        && source == before_source
                        && moment_count(store) == before_count,
                    "restore failed with {error:?} but changed state; disk: {}",
                    String::from_utf8_lossy(&actual),
                );
            }
        }
    }

    fn assert_exact_lossy_restore(scratch: &ScratchDir, store: &mut EngineStore) {
        let actual = std::fs::read(scratch.path().join(PACKING)).unwrap();
        let snapshot = VersionedTextStore::new(store)
            .read_text(WORKSPACE_ID, VERSION_ID, PACKING)
            .unwrap()
            .unwrap();
        let key = DocKey::new(WORKSPACE_ID, VERSION_ID, SOURCE_OBJECT_ID).unwrap();
        let persisted = dohc_engine_collab::load_persisted(store, &key)
            .unwrap()
            .unwrap();
        let source = persisted
            .doc
            .markdown_source_reference()
            .and_then(|reference| persisted.doc.markdown_source(&reference));
        assert!(
            actual == SOURCE.as_bytes()
                && snapshot.text == SOURCE
                && snapshot.blob_sha256 == dohc_engine_storage::hex_sha256(SOURCE.as_bytes())
                && source.as_deref() == Some(SOURCE),
            "restore was not exact; disk: {}",
            String::from_utf8_lossy(&actual),
        );
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

    /// What reconciliation can change: bindings, relations, derived fields,
    /// moments and automation claims.
    fn collections_state(store: &EngineStore) -> Vec<i64> {
        store
            .read_with(|conn| {
                [
                    "SELECT COUNT(*) FROM collection_records",
                    "SELECT COUNT(*) FROM collection_records WHERE adoption_state='adopted'",
                    "SELECT COUNT(*) FROM collection_relation_edges",
                    "SELECT COUNT(*) FROM collection_record_fields",
                    "SELECT COUNT(*) FROM moments",
                    "SELECT COUNT(*) FROM automation_claims",
                ]
                .iter()
                .map(|query| conn.query_row(query, [], |row| row.get(0)))
                .collect::<Result<Vec<i64>, _>>()
            })
            .unwrap()
    }

    #[test]
    fn reconciliation_changes_nothing_while_an_ordinary_pull_is_unfinished() {
        let scratch = ScratchDir::new().unwrap();
        let mut store =
            EngineStore::open(&dohc_engine_testkit::engine_db_path(&scratch).unwrap(), 1).unwrap();
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
        std::fs::create_dir_all(scratch.path().join("tasks")).unwrap();
        std::fs::write(scratch.path().join(SOURCE_PATH), &markdown).unwrap();
        let mut cache = WriterDocCache::new();
        let reconcile = |store: &mut EngineStore, cache: &mut WriterDocCache, now_ms| {
            reconcile_collections_on_store(
                store,
                cache,
                WORKSPACE_ID,
                VERSION_ID,
                scratch.path(),
                None,
                &LeaseRegistry::default(),
                &(),
                now_ms,
                &NoFaults,
                &CancellationToken::new(),
                None,
            )
            .unwrap()
        };
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
        // A page of an unfinished pull removed the relation's target.
        store
            .write_with(&NoFaults, |tx| {
                tx.execute(
                    "INSERT INTO sync_identity \
                     (workspace_id,origin_id,replication_epoch,stream_identity,created_at_ms,ordinary_pull_token) \
                     VALUES (?1,'origin','epoch','stream',1,'unfinished')",
                    [WORKSPACE_ID],
                )
                .map_err(dohc_engine_storage::StorageError::persist_public)
            })
            .unwrap();
        VersionedTextStore::new(&mut store)
            .delete_text_file(
                &dohc_engine_domain::DeleteTextFile {
                    workspace_id: WORKSPACE_ID.to_owned(),
                    version_id: VERSION_ID.to_owned(),
                    path: "tasks/target.md".to_owned(),
                    moment_id: "target-delete".to_owned(),
                    request_id: None,
                    metadata_origin: "sync".to_owned(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: None,
                    now_ms: 6,
                },
                &NoFaults,
            )
            .unwrap();
        let before = collections_state(&store);

        let waiting = reconcile(&mut store, &mut cache, 7);
        assert!(waiting.waits_for_pull);
        assert!(waiting.changed_paths.is_empty());
        assert!(waiting.automation_claims.is_empty());
        assert_eq!(collections_state(&store), before, "nothing changed");
        assert!(
            std::fs::read_to_string(scratch.path().join(SOURCE_PATH))
                .unwrap()
                .contains(TARGET_ID),
            "the relation stays in the source file"
        );

        // The pull finished: the next update cleans the relation.
        store
            .write_with(&NoFaults, |tx| {
                tx.execute("UPDATE sync_identity SET ordinary_pull_token=NULL", [])
                    .map_err(dohc_engine_storage::StorageError::persist_public)
            })
            .unwrap();
        let cleaned = reconcile(&mut store, &mut cache, 8);
        assert!(!cleaned.waits_for_pull);
        assert_eq!(cleaned.changed_paths, [SOURCE_PATH]);
        assert_ne!(collections_state(&store), before);
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
        let announced_paths = std::sync::Mutex::new(Vec::<String>::new());
        let committed = |step: &CollectionReconciliation| {
            announced_paths
                .lock()
                .unwrap()
                .extend(step.changed_paths.iter().cloned());
        };
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
            Some(&committed),
        )
        .unwrap();
        assert_eq!(outcome.changed_paths, [SOURCE_PATH]);
        assert_eq!(*announced_paths.lock().unwrap(), [SOURCE_PATH]);
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
