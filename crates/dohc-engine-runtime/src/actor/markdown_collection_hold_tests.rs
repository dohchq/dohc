use super::*;
use dohc_engine_collab::markdown_write_obligations::{self as obligations, Kind};
use dohc_engine_domain::WriteText;
use dohc_engine_storage::{NoFaults, StorageError};
use dohc_engine_testkit::{ScratchDir, engine_db_path};

const RECORD: &str = "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const TARGET: &str = "rec_bbbbbbbbbbbbbbbbbbbbbbbbbb";
const PATH: &str = "tasks/a.md";

struct Fixture {
    scratch: ScratchDir,
    store: EngineStore,
    cache: WriterDocCache,
    key: DocKey,
    source: String,
    modified: std::time::SystemTime,
}

impl Fixture {
    async fn new(relation: bool) -> Self {
        let scratch = ScratchDir::new().unwrap();
        let mut store = EngineStore::open(&engine_db_path(&scratch).unwrap(), 1).unwrap();
        VersionedTextStore::new(&mut store).ensure_main_version("w", "main", 1, &NoFaults).unwrap();
        std::fs::create_dir_all(scratch.path().join("tasks")).unwrap();
        let source = if relation {
            format!("---\nid: {RECORD}\nrelated: {TARGET}\n---\n\n- parent\n  - child\n")
        } else { "- parent\n  - child\n\n[Other](other.md)\n".into() };
        for (object, path, text) in [
            ("schema", "tasks/collection.yaml", "fields:\n  related:\n    type: relation\n    collection: tasks\n    many: false\n"),
            ("note", PATH, source.as_str()),
        ] {
            VersionedTextStore::new(&mut store).write_text(&WriteText {
                workspace_id: "w".into(), version_id: "main".into(), object_id: object.into(),
                path: path.into(), text: text.into(), moment_id: object.into(),
                metadata_origin: "test".into(), metadata_summary: None, metadata_correlation_id: None,
                author_json: None, now_ms: 2, request_id: None,
            }, &NoFaults).unwrap();
        }
        std::fs::write(scratch.path().join(PATH), &source).unwrap();
        let key = DocKey::new("w", "main", "note").unwrap();
        let doc = Ydoc::wire();
        doc.rewrite_content_to_markdown_preserving_source(ContentKind::Richdoc, &source).unwrap();
        doc.richdoc_append_paragraph("Accepted text remains in the document");
        let mut cache = WriterDocCache::new();
        dohc_engine_collab::record_local_update(&mut store, &mut cache, &key, &doc.encode_full_state(),
            dohc_engine_collab::LocalAppend {
                marker: Some(dohc_engine_collab::MarkerCreation {
                    path: Some(PATH), content_kind: ContentKind::Richdoc, regime: Regime::LocalOnly,
                }), ..Default::default()
            }, &NoFaults, 3, |_, _, _| Ok(())).unwrap();
        store.write_with(&NoFaults, |tx| {
            reconcile_collections_in_tx(tx, "w", "main")?;
            if relation { set_collection_adoption_state_in_tx(tx, "w", "main", PATH, RECORD, "adopted")?; }
            Ok::<_, DomainError>(())
        }).unwrap();
        let modified = std::fs::metadata(scratch.path().join(PATH)).unwrap().modified().unwrap();
        let mut f = Self { scratch, store, cache, key, source, modified };
        f.prepare_unsafe().await;
        f
    }

    async fn prepare_unsafe(&mut self) {
        let config = super::super::reader_tests::fake_reader(&self.scratch, "witness-unsafe");
        let resolver = Arc::new(dohc_engine_collab::reader_resolver::ReaderResolver::new(
            Arc::new(dohc_engine_reader::Reader::new(Some(config)))));
        let doc = self.doc();
        let Err(CollabError::MarkdownWitnessCheckPending { pending, .. }) =
            dohc_engine_collab::markdown_write_safety::check_witness(&doc, &self.key, PATH, Some(&resolver))
            else { panic!("the first witness check must prepare outside the transaction"); };
        pending.resolve().await;
        assert!(!dohc_engine_collab::markdown_write_safety::check_witness(
            &doc, &self.key, PATH, Some(&resolver)).unwrap());
        self.cache.reader_resolver = Some(resolver);
    }

    fn doc(&self) -> Ydoc { dohc_engine_collab::load_persisted(&self.store, &self.key).unwrap().unwrap().doc }

    fn append(&mut self, update: &[u8]) {
        dohc_engine_collab::record_local_update(&mut self.store, &mut self.cache, &self.key, update,
            dohc_engine_collab::LocalAppend::default(), &NoFaults, 10, |_, _, _| Ok(())).unwrap();
    }

    fn assert_held(&mut self) {
        assert_eq!(std::fs::read_to_string(self.scratch.path().join(PATH)).unwrap(), self.source);
        assert_eq!(std::fs::metadata(self.scratch.path().join(PATH)).unwrap().modified().unwrap(), self.modified);
        let head = VersionedTextStore::new(&mut self.store).read_text("w", "main", PATH).unwrap().unwrap();
        assert_eq!(head.text, self.source);
        assert_eq!(head.blob_sha256, hex_sha256(self.source.as_bytes()));
        assert_eq!(self.store.table_row_count("moments").unwrap(), 2);
        assert_eq!(self.store.table_row_count("materialization_jobs").unwrap(), 0);
        assert_eq!(self.store.table_row_count("live_device_settlements").unwrap(), 0);
        assert!(self.doc().project(ContentKind::Richdoc).unwrap().content.contains("Accepted text remains"));
    }

    fn adopt(&mut self) -> Option<CollectionAdoptionExecution> {
        adopt_collection_record_on_store(&mut self.store, &mut self.cache, &CollectionAdoptionCandidate {
            record_id: RECORD.into(), collection_path: "tasks".into(), file_path: PATH.into(),
            object_id: self.key.object_id.clone(), lossless_insertion_required: false,
        }, "w", "main", self.scratch.path(), &LeaseRegistry::new(), &(), 10,
            &NoFaults, &CancellationToken::new(), None, None).unwrap()
    }

    fn cleanup(&mut self) -> CollectionRelationCleanupExecution {
        cleanup_collection_relation_on_store(&mut self.store, &mut self.cache, &CollectionRelationCleanupCandidate {
            source_record_id: RECORD.into(), source_file_path: PATH.into(), source_object_id: self.key.object_id.clone(),
            field_name: "related".into(), target_record_id: TARGET.into(), many: false,
        }, "w", "main", self.scratch.path(), &LeaseRegistry::new(), &(), 10,
            &NoFaults, &CancellationToken::new(), None).unwrap()
    }
}

#[tokio::test]
async fn markdown_hold_adoption_retries_its_boundary_after_id_append_and_restart() {
    let mut f = Fixture::new(false).await;
    for _ in 0..2 {
        assert!(matches!(f.adopt(), Some(CollectionAdoptionExecution::Held(RuntimeError::MarkdownWriteHeld { .. }))));
        assert_eq!(f.doc().frontmatter_json()["id"], RECORD);
        f.assert_held();
    }
    let before = dohc_engine_collab::read_marker(&f.store, &f.key).unwrap().unwrap().head_update_seq;
    let db = engine_db_path(&f.scratch).unwrap();
    drop(f.store);
    f.store = EngineStore::open(&db, 11).unwrap();
    f.cache = WriterDocCache::new();
    f.prepare_unsafe().await;
    assert!(matches!(f.adopt(), Some(CollectionAdoptionExecution::Held(_))));
    assert_eq!(dohc_engine_collab::read_marker(&f.store, &f.key).unwrap().unwrap().head_update_seq, before);
    let pending = f.store.read_with(|conn| obligations::pending_in(conn, "w")).unwrap();
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].kind, Kind::CollectionAdoption);
    let update = f.doc().clear_markdown_source_witness();
    f.append(&update);
    assert!(matches!(f.adopt(), Some(CollectionAdoptionExecution::Applied { .. })));
    assert!(f.store.read_with(|conn| obligations::pending_in(conn, "w")).unwrap().is_empty());
    let moments = f.store.table_row_count("moments").unwrap();
    f.adopt();
    assert_eq!(f.store.table_row_count("moments").unwrap(), moments);
}

#[tokio::test]
async fn markdown_hold_relation_cleanup_retains_the_file_index_across_no_change_retry() {
    let mut f = Fixture::new(true).await;
    for _ in 0..2 {
        assert!(matches!(f.cleanup(), CollectionRelationCleanupExecution::Held(RuntimeError::MarkdownWriteHeld { .. })));
        f.assert_held();
        assert!(f.doc().frontmatter_json().get("related").is_none());
        let indexed: i64 = f.store.read_with(|conn| conn.query_row(
            "SELECT count(*) FROM collection_record_fields WHERE record_id=?1 AND field_name='related'",
            [RECORD], |row| row.get(0))).unwrap();
        assert_eq!(indexed, 1);
    }
    let update = f.doc().clear_markdown_source_witness();
    f.append(&update);
    assert!(matches!(f.cleanup(), CollectionRelationCleanupExecution::Applied(_)));
    let indexed: i64 = f.store.read_with(|conn| conn.query_row(
        "SELECT count(*) FROM collection_record_fields WHERE record_id=?1 AND field_name='related'",
        [RECORD], |row| row.get(0))).unwrap();
    assert_eq!(indexed, 0);
    assert!(f.store.read_with(|conn| obligations::pending_in(conn, "w")).unwrap().is_empty());
}

#[tokio::test]
async fn markdown_hold_relation_cleanup_owes_settlement_after_append_crash_and_restart() {
    for unsafe_witness in [false, true] {
        let mut f = Fixture::new(true).await;
        if !unsafe_witness {
            let clear = f.doc().clear_markdown_source_witness();
            f.append(&clear);
        }
        let before = dohc_engine_collab::read_marker(&f.store, &f.key).unwrap().unwrap().head_update_seq;
        let crash = dohc_engine_testkit::ScriptedFaults::crash_at(
            dohc_engine_storage::FaultPoint::StorageAfterCommitBeforeAck);
        let result = cleanup_collection_relation_on_store(&mut f.store, &mut f.cache,
            &CollectionRelationCleanupCandidate {
                source_record_id: RECORD.into(), source_file_path: PATH.into(),
                source_object_id: f.key.object_id.clone(), field_name: "related".into(),
                target_record_id: TARGET.into(), many: false,
            }, "w", "main", f.scratch.path(), &LeaseRegistry::new(), &(), 10,
            crash.as_ref(), &CancellationToken::new(), None);
        assert!(crash.fired());
        assert!(matches!(result, Err(RuntimeError::OperationCrashed)));
        let db = engine_db_path(&f.scratch).unwrap();
        drop(f.store);
        f.store = EngineStore::open(&db, 11).unwrap();
        f.cache = WriterDocCache::new();
        let owed = f.store.read_with(|conn| obligations::pending_in(conn, "w")).unwrap();
        assert_eq!(owed.len(), 1);
        assert_eq!(owed[0].kind, Kind::RelationCleanup);
        assert_eq!(owed[0].held_head_sha256.as_deref(), Some(hex_sha256(f.source.as_bytes()).as_str()));
        assert!(f.doc().frontmatter_json().get("related").is_none());
        let appended = dohc_engine_collab::read_marker(&f.store, &f.key).unwrap().unwrap().head_update_seq;
        assert_eq!(appended, before + 1);
        f.assert_held();
        if unsafe_witness {
            f.prepare_unsafe().await;
            for _ in 0..2 {
                assert!(matches!(f.cleanup(), CollectionRelationCleanupExecution::Held(RuntimeError::MarkdownWriteHeld { .. })));
                f.assert_held();
                let pending = f.store.read_with(|conn| obligations::pending_in(conn, "w")).unwrap();
                assert_eq!(pending.len(), 1);
                assert_eq!(pending[0].order, owed[0].order);
                assert_eq!(dohc_engine_collab::read_marker(&f.store, &f.key).unwrap().unwrap().head_update_seq, appended);
            }
            let clear = f.doc().clear_markdown_source_witness();
            f.append(&clear);
        }
        assert!(matches!(f.cleanup(), CollectionRelationCleanupExecution::Applied(_)));
        assert!(f.store.read_with(|conn| obligations::pending_in(conn, "w")).unwrap().is_empty());
        let indexed: i64 = f.store.read_with(|conn| conn.query_row(
            "SELECT count(*) FROM collection_record_fields WHERE record_id=?1 AND field_name='related'",
            [RECORD], |row| row.get(0))).unwrap();
        assert_eq!(indexed, 0);
        let saved = std::fs::read_to_string(f.scratch.path().join(PATH)).unwrap();
        assert!(!saved.contains("related:"));
        assert!(saved.contains("Accepted text remains in the document"));
    }
}

#[tokio::test]
async fn markdown_hold_link_baseline_reports_unusable_without_splicing_the_older_file() {
    let mut f = Fixture::new(false).await;
    for _ in 0..2 {
        assert!(!super::super::link_documents::baseline(&mut f.store, &mut f.cache,
            f.scratch.path(), &f.key, PATH, &CancellationToken::new(), &(),
            |text| text.contains("other.md")).unwrap());
        f.assert_held();
    }
    let update = f.doc().clear_markdown_source_witness();
    f.append(&update);
    assert!(super::super::link_documents::baseline(&mut f.store, &mut f.cache,
        f.scratch.path(), &f.key, PATH, &CancellationToken::new(), &(),
        |text| text.contains("other.md")).unwrap());
}

struct CaptureRoot(std::path::PathBuf);
impl super::super::WorkspaceRootGuard for CaptureRoot {
    fn validate(&self, root: &std::path::Path) -> Result<(), RuntimeError> {
        assert_eq!(root, self.0);
        assert!(root.is_dir());
        Ok(())
    }
}

#[tokio::test]
async fn markdown_hold_capture_preparation_hands_off_from_a_plain_thread_to_async_recovery() {
    let mut f = Fixture::new(false).await;
    let expected_id: String = f.store.read_with(|conn| conn.query_row(
        "SELECT record_id FROM collection_records WHERE workspace_id='w' AND version_id='main' AND file_path=?1",
        [PATH], |row| row.get(0))).unwrap();
    f.store.write_with(&NoFaults, |tx| tx.execute(
        "UPDATE collection_records SET adoption_state='pending' WHERE file_path=?1", [PATH])
        .map_err(StorageError::persist_public)).unwrap();
    let db = engine_db_path(&f.scratch).unwrap();
    drop(f.store);
    let supervisor = crate::WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 20).unwrap().actor;
    actor.configure_reader_resolver(Arc::new(dohc_engine_collab::reader_resolver::ReaderResolver::new(
        Arc::new(dohc_engine_reader::Reader::new(Some(super::super::reader_tests::fake_reader(
            &f.scratch, "witness-unsafe"))))))).await.unwrap();
    let root = f.scratch.path().to_owned();
    let capture = actor.clone();
    let capture_root = root.clone();
    let epoch = actor.markdown_recovery_epoch();
    let result = std::thread::spawn(move || capture.reconcile_collections_blocking_guarded(
        "w".into(), "main".into(), capture_root.clone(), LeaseRegistry::new(), Arc::new(()),
        21, Arc::new(NoFaults), Arc::new(CaptureRoot(capture_root)), None)).join().unwrap().unwrap();
    assert!(result.changed_paths.is_empty());
    assert!(result.held_documents.is_empty());
    assert!(actor.markdown_recovery_epoch() > epoch);
    let candidates = actor.markdown_recovery_candidates("w".into()).await.unwrap();
    assert_eq!(candidates.len(), 1);
    assert_eq!(candidates[0].obligation.kind, Kind::CollectionAdoption);
    assert_eq!(candidates[0].obligation.held_checkpoint_sha256, None);
    let key = f.key.clone();
    let sequence = actor.run(move |store, _| {
        assert_eq!(store.table_row_count("moments")?, 2);
        assert_eq!(store.table_row_count("materialization_jobs")?, 0);
        let doc = dohc_engine_collab::load_persisted(store, &key)?.unwrap().doc;
        assert_eq!(doc.frontmatter_json()["id"], expected_id);
        Ok(dohc_engine_collab::read_marker(store, &key)?.unwrap().head_update_seq)
    }).await.unwrap();
    let recovered = actor.reconcile_collections_guarded("w".into(), "main".into(), root.clone(),
        LeaseRegistry::new(), Arc::new(()), 22, Arc::new(NoFaults), CancellationToken::new(),
        Arc::new(CaptureRoot(root.clone()))).await.unwrap();
    assert_eq!(recovered.held_documents.len(), 1);
    let key = f.key.clone();
    actor.run(move |store, _| {
        assert_eq!(dohc_engine_collab::read_marker(store, &key)?.unwrap().head_update_seq, sequence);
        assert_eq!(store.table_row_count("materialization_jobs")?, 0);
        Ok(())
    }).await.unwrap();
    assert_eq!(std::fs::read_to_string(root.join(PATH)).unwrap(), f.source);
    supervisor.close(&db).unwrap();
}

#[tokio::test]
async fn markdown_hold_collection_driver_waits_for_witness_and_proof_before_one_write() {
    let mut f = Fixture::new(false).await;
    let expected_id: String = f.store.read_with(|conn| conn.query_row(
        "SELECT record_id FROM collection_records WHERE file_path=?1", [PATH], |row| row.get(0))).unwrap();
    f.store.write_with(&NoFaults, |tx| tx.execute(
        "UPDATE collection_records SET adoption_state='pending' WHERE file_path=?1", [PATH])
        .map_err(StorageError::persist_public)).unwrap();
    let doc = f.doc();
    let resolver = dohc_engine_collab::reader_resolver::ReaderResolver::new(
        Arc::new(dohc_engine_reader::Reader::new(None)));
    let proof = match f.store.read_with(|conn| dohc_engine_collab::reader_resolver::resolve(
        conn, &f.key, &doc, &doc.project(ContentKind::Richdoc)?.content, Some(&resolver))) {
        Err(CollabError::MarkdownReaderPending(proof)) => proof,
        _ => panic!("expected a proof preparation request"),
    };
    let marker = dohc_engine_collab::read_marker(&f.store, &f.key).unwrap().unwrap();
    let db = engine_db_path(&f.scratch).unwrap();
    drop(f.store);
    let supervisor = crate::WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 20).unwrap().actor;
    let reader = Arc::new(dohc_engine_reader::Reader::new(Some(
        super::super::reader_tests::fake_reader(&f.scratch, "witness-safe"))));
    actor.configure_reader_resolver(Arc::new(dohc_engine_collab::reader_resolver::ReaderResolver::new(reader.clone())))
        .await.unwrap();
    actor.run(move |_, _| {
        super::super::ydoc::MARKDOWN_SETTLEMENT_FAULT.with(|slot| *slot.borrow_mut() = Some(Box::new(move |_| {
            Err(CollabError::MarkdownReaderPending(proof).into())
        })));
        Ok(())
    }).await.unwrap();
    assert_eq!(actor.ydoc_adopt_collection_record(f.key.clone(), PATH.into(), marker.lineage_claim_id.clone(),
        f.scratch.path().to_owned(), LeaseRegistry::new(), Arc::new(()), None, 21,
        CancellationToken::new(), None).await.unwrap().unwrap(), "settled");
    assert_eq!(reader.dispatch_count(), 1);
    let key = f.key.clone();
    actor.run(move |store, _| {
        assert_eq!(store.table_row_count("moments")?, 3);
        assert_eq!(store.table_row_count("materialization_jobs")?, 1);
        assert!(store.read_with(|conn| obligations::pending_in(conn, "w"))?.is_empty());
        let doc = dohc_engine_collab::load_persisted(store, &key)?.unwrap().doc;
        assert_eq!(doc.frontmatter_json()["id"], expected_id);
        assert_eq!(dohc_engine_collab::read_marker(store, &key)?.unwrap().head_update_seq, marker.head_update_seq + 1);
        Ok(())
    }).await.unwrap();
    let saved = std::fs::read_to_string(f.scratch.path().join(PATH)).unwrap();
    assert_eq!(saved.matches("Accepted text remains in the document").count(), 1);
    supervisor.close(&db).unwrap();
}

#[tokio::test]
async fn markdown_hold_full_collection_reconciliation_keeps_adoption_pending_across_restart() {
    let mut f = Fixture::new(false).await;
    f.store.write_with(&NoFaults, |tx| tx.execute(
        "UPDATE collection_records SET adoption_state='pending' WHERE file_path=?1", [PATH])
        .map_err(StorageError::persist_public)).unwrap();
    let db = engine_db_path(&f.scratch).unwrap();
    drop(f.store);
    let supervisor = crate::WorkspaceSupervisor::new();
    let mut actor = supervisor.open(&db, 20).unwrap().actor;
    let root = f.scratch.path().to_owned();
    let mut held_sequence = None;
    for pass in 0..3 {
        if pass == 2 {
            supervisor.close(&db).unwrap();
            actor = supervisor.open(&db, 22).unwrap().actor;
        }
        actor.configure_reader_resolver(Arc::new(dohc_engine_collab::reader_resolver::ReaderResolver::new(
            Arc::new(dohc_engine_reader::Reader::new(Some(super::super::reader_tests::fake_reader(
                &f.scratch, "witness-unsafe"))))))).await.unwrap();
        let result = actor.reconcile_collections("w".into(), "main".into(), root.clone(),
            LeaseRegistry::new(), Arc::new(()), 23 + pass, Arc::new(NoFaults), CancellationToken::new()).await.unwrap();
        assert!(result.changed_paths.is_empty());
        assert_eq!(result.held_documents.len(), 1);
        let key = f.key.clone();
        let sequence = actor.run(move |store, _| {
            assert_eq!(store.table_row_count("moments")?, 2);
            assert_eq!(store.table_row_count("materialization_jobs")?, 0);
            let state: String = store.read_with(|conn| conn.query_row(
                "SELECT adoption_state FROM collection_records WHERE file_path=?1", [PATH], |row| row.get(0))).unwrap();
            assert_eq!(state, "pending");
            let owed = store.read_with(|conn| obligations::pending_in(conn, "w"))?;
            assert_eq!(owed.len(), 1);
            assert_eq!(owed[0].kind, Kind::CollectionAdoption);
            Ok(dohc_engine_collab::read_marker(store, &key)?.unwrap().head_update_seq)
        }).await.unwrap();
        if let Some(before) = held_sequence { assert_eq!(sequence, before); }
        held_sequence = Some(sequence);
        assert_eq!(std::fs::read_to_string(root.join(PATH)).unwrap(), f.source);
        assert_eq!(std::fs::metadata(root.join(PATH)).unwrap().modified().unwrap(), f.modified);
    }
    let key = f.key.clone();
    actor.run(move |store, cache| {
        let doc = dohc_engine_collab::load_persisted(store, &key)?.unwrap().doc;
        dohc_engine_collab::record_local_update(store, cache, &key, &doc.clear_markdown_source_witness(),
            dohc_engine_collab::LocalAppend::default(), &NoFaults, 30, |_, _, _| Ok(()))?;
        Ok(())
    }).await.unwrap();
    for pass in 0..2 {
        let result = actor.reconcile_collections("w".into(), "main".into(), root.clone(),
            LeaseRegistry::new(), Arc::new(()), 31 + pass, Arc::new(NoFaults), CancellationToken::new()).await.unwrap();
        assert!(result.held_documents.is_empty());
        assert_eq!(result.changed_paths.len(), if pass == 0 { 1 } else { 0 });
    }
    actor.run(|store, _| {
        assert_eq!(store.table_row_count("moments")?, 3);
        assert_eq!(store.table_row_count("materialization_jobs")?, 1);
        assert!(store.read_with(|conn| obligations::pending_in(conn, "w"))?.is_empty());
        Ok(())
    }).await.unwrap();
    supervisor.close(&db).unwrap();
}

#[tokio::test]
async fn markdown_hold_relation_reconciliation_keeps_the_held_index_and_completes_a_safe_peer() {
    let mut f = Fixture::new(true).await;
    let peer_id = "rec_cccccccccccccccccccccccccc";
    let peer_source = format!("---\nid: {peer_id}\nrelated: {TARGET}\n---\n\nSafe peer\n");
    VersionedTextStore::new(&mut f.store).write_text(&WriteText {
        workspace_id: "w".into(), version_id: "main".into(), object_id: "safe-peer".into(),
        path: "tasks/b.md".into(), text: peer_source.clone(), moment_id: "safe-peer-source".into(),
        metadata_origin: "test".into(), metadata_summary: None, metadata_correlation_id: None,
        author_json: None, now_ms: 3, request_id: None,
    }, &NoFaults).unwrap();
    std::fs::write(f.scratch.path().join("tasks/b.md"), &peer_source).unwrap();
    let peer_key = DocKey::new("w", "main", "safe-peer").unwrap();
    let peer = Ydoc::wire();
    peer.rewrite_content_to_markdown(ContentKind::Richdoc, &peer_source).unwrap();
    peer.richdoc_append_paragraph("Safe accepted edit");
    dohc_engine_collab::record_local_update(&mut f.store, &mut f.cache, &peer_key, &peer.encode_full_state(),
        dohc_engine_collab::LocalAppend { marker: Some(dohc_engine_collab::MarkerCreation {
            path: Some("tasks/b.md"), content_kind: ContentKind::Richdoc, regime: Regime::LocalOnly,
        }), ..Default::default() }, &NoFaults, 4, |_, _, _| Ok(())).unwrap();
    f.store.write_with(&NoFaults, |tx| {
        reconcile_collections_in_tx(tx, "w", "main")?;
        set_collection_adoption_state_in_tx(tx, "w", "main", "tasks/b.md", peer_id, "adopted")?;
        Ok::<_, DomainError>(())
    }).unwrap();
    let mut held_sequence = None;
    for pass in 0..2 {
        let result = reconcile_collections_on_store(&mut f.store, &mut f.cache, "w", "main",
            f.scratch.path(), None, &LeaseRegistry::new(), &(), 20 + pass, &NoFaults,
            &CancellationToken::new(), None).unwrap();
        assert_eq!(result.held_documents.len(), 1);
        assert_eq!(result.changed_paths, if pass == 0 { vec!["tasks/b.md".to_owned()] } else { Vec::new() });
        assert_eq!(std::fs::read_to_string(f.scratch.path().join(PATH)).unwrap(), f.source);
        assert_eq!(std::fs::metadata(f.scratch.path().join(PATH)).unwrap().modified().unwrap(), f.modified);
        let indexed: i64 = f.store.read_with(|conn| conn.query_row(
            "SELECT count(*) FROM collection_record_fields WHERE record_id=?1 AND field_name='related'",
            [RECORD], |row| row.get(0))).unwrap();
        assert_eq!(indexed, 1);
        let indexed_peer: i64 = f.store.read_with(|conn| conn.query_row(
            "SELECT count(*) FROM collection_record_fields WHERE record_id=?1 AND field_name='related'",
            [peer_id], |row| row.get(0))).unwrap();
        assert_eq!(indexed_peer, 0);
        assert!(f.doc().frontmatter_json().get("related").is_none());
        let sequence = dohc_engine_collab::read_marker(&f.store, &f.key).unwrap().unwrap().head_update_seq;
        if let Some(before) = held_sequence { assert_eq!(sequence, before); }
        held_sequence = Some(sequence);
    }
    let peer_saved = std::fs::read_to_string(f.scratch.path().join("tasks/b.md")).unwrap();
    assert!(!peer_saved.contains("related:"));
    assert!(peer_saved.contains("Safe accepted edit"));
    let clear = f.doc().clear_markdown_source_witness();
    f.append(&clear);
    let result = reconcile_collections_on_store(&mut f.store, &mut f.cache, "w", "main",
        f.scratch.path(), None, &LeaseRegistry::new(), &(), 25, &NoFaults,
        &CancellationToken::new(), None).unwrap();
    assert!(result.held_documents.is_empty());
    assert_eq!(result.changed_paths, [PATH]);
    assert!(f.store.read_with(|conn| obligations::pending_in(conn, "w")).unwrap().is_empty());
    assert!(!std::fs::read_to_string(f.scratch.path().join(PATH)).unwrap().contains("related:"));
}
