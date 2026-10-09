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
                             ('relay','workspace','main',?1,'lineage',?2,'[]',0,'host',1,'instance','connection',1)",
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
    /// An adoption candidate or relation-cleanup source still has a live lease.
    pub lease_held: bool,
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
            Err(error) if file_conflict(&error) => {}
            Err(error) => return Err(error),
        }
    }
    Ok(CollectionReconciliation {
        lease_held,
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
}
