use super::*;
use dohc_engine_collab::markdown_write_obligations::{self as obligations, Kind};
use dohc_engine_domain::WriteText;
use dohc_engine_storage::NoFaults;
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
