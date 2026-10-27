use super::*;
use dohc_engine_domain::WriteText;
use dohc_engine_testkit::ScratchDir;

struct Fixture {
    _scratch: ScratchDir,
    store: EngineStore,
    cache: WriterDocCache,
    key: DocKey,
    source: String,
    converted: String,
}

impl Fixture {
    fn new() -> Self {
        let scratch = ScratchDir::new().unwrap();
        let mut store = EngineStore::open(&dohc_engine_testkit::engine_db_path(&scratch).unwrap(), 1).unwrap();
        ensure_mutation_version_on_store(&mut store, "w", "main", 1, &NoFaults).unwrap();
        let key = DocKey::new("w", "main", "note").unwrap();
        let source = format!("{}\n", "source paragraph ".repeat(8_000));
        assert!(source.len() > 100_000);
        let doc = Ydoc::wire();
        doc.rewrite_content_to_markdown_preserving_source(ContentKind::Richdoc, &source).unwrap();
        let mut cache = WriterDocCache::default();
        ydoc_record_update_on_store(&mut store, &mut cache, &key, "note.md", ContentKind::Richdoc,
            Regime::LocalOnly, &doc.encode_full_state(), None, None, None, false, None, None,
            false, 2, &NoFaults, &CancellationToken::new(), None).unwrap();
        let converted = "Consented conversion\n".to_owned();
        let mut fixture = Self { _scratch: scratch, store, cache, key, source, converted };
        let converted = fixture.converted.clone();
        fixture.head(&converted, "converted", true);
        let owed = WriteObligation {
            order: 0, key: fixture.key.clone(), lineage_claim_id: String::new(),
            operation_id: "consented-session".into(), kind: WriteObligationKind::WitnessRefresh,
            path: "note.md".into(), retry_inputs: serde_json::json!({}),
            held_checkpoint_sha256: None, held_head_sha256: None,
            source_sha256: Some(hex_sha256(fixture.source.as_bytes())),
            settled_head_sha256: Some(hex_sha256(converted.as_bytes())),
        };
        fixture.store.write_with(&NoFaults, |tx| write_obligations::record_in(tx, &owed, 3)).unwrap();
        fixture
    }

    fn head(&mut self, text: &str, moment: &str, complete: bool) {
        let result = VersionedTextStore::new(&mut self.store).write_text(&WriteText {
            workspace_id: "w".into(), version_id: "main".into(), object_id: "note".into(),
            path: "note.md".into(), text: text.into(), moment_id: moment.into(),
            metadata_origin: "ydoc".into(), metadata_summary: None, metadata_correlation_id: None,
            author_json: None, now_ms: 4, request_id: None,
        }, &NoFaults).unwrap();
        self.store.write_with(&NoFaults, |tx| {
            enqueue_write(tx, &result, Preimage::Absent, "ydoc")?;
            tx.execute("UPDATE ydoc_docs SET last_settled_sha=?1 WHERE workspace_id='w'",
                [hex_sha256(text.as_bytes())]).map_err(StorageError::persist_public)?;
            if complete {
                tx.execute("UPDATE materialization_jobs SET status='complete',completed_at_ms=4", [])
                    .map_err(StorageError::persist_public)?;
            }
            Ok::<_, RuntimeError>(())
        }).unwrap();
    }

    fn refresh(&mut self) {
        refresh_markdown_witnesses_on_store(&mut self.store, &mut self.cache, &self.key, 10).unwrap();
    }

    fn doc(&self) -> Ydoc { dohc_engine_collab::load_persisted(&self.store, &self.key).unwrap().unwrap().doc }
    fn debt(&self) -> Vec<WriteObligation> {
        self.store.read_with(|conn| write_obligations::pending_in(conn, "w")).unwrap()
    }
}

#[test]
fn markdown_refresh_after_restart_keeps_a_private_tail_and_large_source() {
    let mut f = Fixture::new();
    let doc = f.doc();
    let tail = doc.richdoc_append_paragraph("Private tail remains unsettled");
    ydoc_record_update_on_store(&mut f.store, &mut f.cache, &f.key, "note.md", ContentKind::Richdoc,
        Regime::LocalOnly, &tail, None, None, None, false, None, None, false, 5,
        &NoFaults, &CancellationToken::new(), None).unwrap();
    // A restart loses every cache entry and session grant, while retaining committed debt.
    f.cache.clear();
    f.refresh();
    assert!(!f.doc().has_markdown_witness());
    assert!(f.doc().project(ContentKind::Richdoc).unwrap().content.contains("Private tail remains unsettled"));
    assert!(f.debt().is_empty());
    let seq = dohc_engine_collab::read_marker(&f.store, &f.key).unwrap().unwrap().head_update_seq;
    f.refresh();
    assert_eq!(dohc_engine_collab::read_marker(&f.store, &f.key).unwrap().unwrap().head_update_seq, seq);
}

#[test]
fn markdown_refresh_drops_a_stale_row_after_reimport_without_clearing_the_new_witness() {
    let mut f = Fixture::new();
    let doc = f.doc();
    let update = doc.rewrite_content_to_markdown_preserving_source(ContentKind::Richdoc, "Different imported source\n").unwrap();
    ydoc_record_update_on_store(&mut f.store, &mut f.cache, &f.key, "note.md", ContentKind::Richdoc,
        Regime::LocalOnly, &update, None, None, None, false, None, None, false, 5,
        &NoFaults, &CancellationToken::new(), None).unwrap();
    let before = f.doc().encode_full_state();
    f.refresh();
    assert_eq!(f.doc().encode_full_state(), before);
    assert!(f.doc().has_markdown_witness());
    assert!(f.debt().is_empty());
}

#[test]
fn markdown_refresh_does_not_clear_after_the_consented_source_is_restored() {
    let mut f = Fixture::new();
    let source = f.source.clone();
    f.head(&source, "restored", true);
    f.refresh();
    assert!(f.doc().has_markdown_witness());
    assert_eq!(f.debt().len(), 1);
}

#[test]
fn markdown_refresh_waits_for_materialization_and_tracks_an_ordinary_settlement() {
    let mut f = Fixture::new();
    let next = "Later engine settlement\n";
    f.head(next, "ordinary", false);
    f.store.write_with(&NoFaults, |tx| {
        write_obligations::advance_refresh_head_in(tx, &f.key, None,
            Some(hex_sha256(f.converted.as_bytes()).as_str()), &hex_sha256(next.as_bytes()), 5)
    }).unwrap();
    f.refresh();
    assert!(f.doc().has_markdown_witness());
    assert_eq!(f.debt().len(), 1);
    f.store.write_with(&NoFaults, |tx| tx.execute(
        "UPDATE materialization_jobs SET status='complete',completed_at_ms=6 WHERE job_id='ydoc-mat_ordinary'", [])
        .map_err(StorageError::persist_public)).unwrap();
    f.refresh();
    assert!(!f.doc().has_markdown_witness());
    assert!(f.debt().is_empty());
}
