use base64::{Engine as _, engine::general_purpose::STANDARD};
use dohc_engine_collab::{ContentKind, DocKey, reader_resolver::ReaderResolver};
use dohc_engine_domain::{VersionedTextStore, WriteText};
use dohc_engine_reader::Reader;
use dohc_engine_runtime::{CancellationToken, WorkspaceSupervisor};
use dohc_engine_storage::{EngineStore, NoFaults, hex_sha256};
use dohc_engine_testkit::{ScratchDir, engine_db_path};
use std::sync::Arc;
use yrs::{Map, ReadTxn, Transact, updates::decoder::Decode};

fn seed() -> (ScratchDir, std::path::PathBuf, DocKey, String, String) {
    let data: serde_json::Value = serde_json::from_str(include_str!(
        "../../dohc-engine-collab/tests/reader-resolver.json"
    ))
    .unwrap();
    let source = data["source"].as_str().unwrap().to_owned();
    let checkpoint = STANDARD
        .decode(data["checkpoint"].as_str().unwrap())
        .unwrap();
    let doc = yrs::Doc::new();
    doc.transact_mut()
        .apply_update(yrs::Update::decode_v1(&checkpoint).unwrap())
        .unwrap();
    doc.get_or_insert_map("meta")
        .remove(&mut doc.transact_mut(), "dohcLineageEpoch");
    let checkpoint = doc
        .transact()
        .encode_state_as_update_v1(&yrs::StateVector::default());
    let scratch = ScratchDir::new().unwrap();
    let db = engine_db_path(&scratch).unwrap();
    let mut store = EngineStore::open(&db, 1).unwrap();
    let key = DocKey::new("w", "main", "fixture").unwrap();
    let mut versions = VersionedTextStore::new(&mut store);
    versions
        .ensure_main_version("w", "main", 1, &NoFaults)
        .unwrap();
    versions
        .write_text(
            &WriteText {
                workspace_id: "w".into(),
                version_id: "main".into(),
                object_id: "fixture".into(),
                path: "note.md".into(),
                text: source.clone(),
                moment_id: "initial".into(),
                metadata_origin: "test".into(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 2,
                request_id: None,
            },
            &NoFaults,
        )
        .unwrap();
    dohc_engine_collab::claim_base(
        &mut store,
        &key,
        ContentKind::Richdoc,
        &checkpoint,
        &NoFaults,
        3,
    )
    .unwrap();
    // Synthetic claimed fixture. Admission and successor installation remain PR 6/7 work.
    store
        .write_with(&NoFaults, |tx| {
            tx.execute("UPDATE ydoc_docs SET path='note.md'", [])
                .map_err(dohc_engine_storage::StorageError::persist_public)
        })
        .unwrap();
    let claim = dohc_engine_collab::read_marker(&store, &key)
        .unwrap()
        .unwrap()
        .lineage_claim_id
        .unwrap();
    std::fs::write(scratch.path().join("note.md"), &source).unwrap();
    (scratch, db, key, source, claim)
}

async fn settle(
    actor: &dohc_engine_runtime::ActorHandle,
    root: &std::path::Path,
    key: &DocKey,
    source: &str,
    claim: &str,
) -> Result<dohc_engine_runtime::YdocSettleOutcome, dohc_engine_runtime::RuntimeError> {
    actor
        .ydoc_settle(
            root.to_owned(),
            key.clone(),
            "note.md".into(),
            ContentKind::Richdoc,
            Some(claim.into()),
            Some(hex_sha256(source.as_bytes())),
            "reader-test".into(),
            Arc::new(()),
            10,
            Arc::new(NoFaults),
            CancellationToken::new(),
            None,

            None,
        )
        .await
}

#[tokio::test]
async fn missing_reader_holds_settlement_and_preserves_file_and_checkpoint() {
    let (scratch, db, key, source, claim) = seed();
    let before = dohc_engine_collab::load_persisted(&EngineStore::open(&db, 4).unwrap(), &key)
        .unwrap()
        .unwrap()
        .doc;
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 5).unwrap().actor;
    assert!(
        settle(&actor, scratch.path(), &key, &source, &claim)
            .await
            .is_err()
    );
    supervisor.close(&db).unwrap();
    assert_eq!(
        std::fs::read(scratch.path().join("note.md")).unwrap(),
        source.as_bytes()
    );
    let after = dohc_engine_collab::load_persisted(&EngineStore::open(&db, 11).unwrap(), &key)
        .unwrap()
        .unwrap()
        .doc;
    assert!(
        dohc_engine_collab::replay_parity::structurally_equal_v2_for_test(&before, &after).unwrap()
    );
}

#[tokio::test]
async fn absent_snapshot_reader_refusal_does_not_use_conversion_consent() {
    let (scratch, db, key, source, claim) = seed();
    let mut store = EngineStore::open(&db, 4).unwrap();
    let persisted = dohc_engine_collab::load_persisted(&store, &key).unwrap().unwrap();
    let update = persisted.doc.richdoc_append_paragraph("Accepted edit stays canonical");
    store.write_with(&NoFaults, |tx| {
        dohc_engine_collab::record_update_in_tx(tx, &key, &update, None, None, 4)?;
        tx.execute("DELETE FROM snapshots WHERE workspace_id='w'", [])
            .map_err(dohc_engine_storage::StorageError::persist_public)?;
        Ok::<_, dohc_engine_collab::CollabError>(())
    }).unwrap();
    let before = dohc_engine_collab::load_persisted(&store, &key).unwrap().unwrap().doc.encode_full_state();
    drop(store);
    std::fs::remove_file(scratch.path().join("note.md")).unwrap();
    let consent = Arc::new(dohc_engine_collab::markdown_write_safety::MarkdownConversionConsent::new(
        key.clone(), "reader-test".into(), Some(claim.clone()), None,
        hex_sha256(source.as_bytes()), None,
    ));
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 5).unwrap().actor;
    actor.configure_reader_resolver(Arc::new(ReaderResolver::new(Arc::new(Reader::new(None)))))
        .await.unwrap();
    let error = actor.ydoc_settle(scratch.path().to_owned(), key.clone(), "note.md".into(),
        ContentKind::Richdoc, Some(claim), None, "reader-test".into(), Arc::new(()), 10,
        Arc::new(NoFaults), CancellationToken::new(), None, Some(consent.clone()))
        .await.unwrap_err();
    assert!(matches!(error, dohc_engine_runtime::RuntimeError::Sync(
        dohc_engine_sync::SyncError::RetryableState { reason: "dohc could not verify this file. Try again." }
    )));
    assert!(!consent.is_consumed());
    supervisor.close(&db).unwrap();
    assert!(!scratch.path().join("note.md").exists());
    let store = EngineStore::open(&db, 11).unwrap();
    let after = dohc_engine_collab::load_persisted(&store, &key).unwrap().unwrap().doc.encode_full_state();
    assert_eq!(after, before);
    store.read_with(|conn| {
        for table in ["snapshots", "materialization_jobs", "markdown_write_obligations"] {
            let count: i64 = conn.query_row(&format!("SELECT count(*) FROM {table}"), [], |row| row.get(0))
                .map_err(dohc_engine_storage::StorageError::corrupt_public)?;
            assert_eq!(count, 0, "{table}");
        }
        let moments: i64 = conn.query_row("SELECT count(*) FROM moments", [], |row| row.get(0))
            .map_err(dohc_engine_storage::StorageError::corrupt_public)?;
        assert_eq!(moments, 1);
        Ok::<_, dohc_engine_storage::StorageError>(())
    }).unwrap();
}

#[tokio::test]
async fn absent_snapshot_without_reader_metadata_reaches_markdown_hold() {
    let (scratch, db, key, _, claim) = seed();
    let mut store = EngineStore::open(&db, 4).unwrap();
    let persisted = dohc_engine_collab::load_persisted(&store, &key).unwrap().unwrap();
    let wire = yrs::Doc::new();
    wire.transact_mut().apply_update(yrs::Update::decode_v1(&persisted.doc.encode_full_state()).unwrap()).unwrap();
    let before = wire.transact().state_vector();
    let meta = wire.get_or_insert_map("meta");
    meta.remove(&mut wire.transact_mut(), "dohcMarkdownSourceReader");
    // An incomplete witness is unsafe without asking a checker.
    meta.remove(&mut wire.transact_mut(), "dohcMarkdownSourceProjectionSha256");
    let update = wire.transact().encode_state_as_update_v1(&before);
    store.write_with(&NoFaults, |tx| {
        dohc_engine_collab::record_update_in_tx(tx, &key, &update, None, None, 4)?;
        tx.execute("DELETE FROM snapshots WHERE workspace_id='w'", [])
            .map_err(dohc_engine_storage::StorageError::persist_public)?;
        Ok::<_, dohc_engine_collab::CollabError>(())
    }).unwrap();
    let doc = dohc_engine_collab::load_persisted(&store, &key).unwrap().unwrap().doc;
    let update = doc.richdoc_append_paragraph("Accepted edit stays canonical");
    store.write_with(&NoFaults, |tx| dohc_engine_collab::record_update_in_tx(tx, &key, &update, None, None, 4)).unwrap();
    drop(store);
    std::fs::remove_file(scratch.path().join("note.md")).unwrap();
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 5).unwrap().actor;
    let error = actor.ydoc_settle(scratch.path().to_owned(), key.clone(), "note.md".into(),
        ContentKind::Richdoc, Some(claim), None, "reader-test".into(), Arc::new(()), 10,
        Arc::new(NoFaults), CancellationToken::new(), None, None).await.unwrap_err();
    assert!(matches!(error, dohc_engine_runtime::RuntimeError::MarkdownWriteHeld { head_sha256: None, .. }));
    supervisor.close(&db).unwrap();
    assert!(!scratch.path().join("note.md").exists());
    let store = EngineStore::open(&db, 11).unwrap();
    let doc = dohc_engine_collab::load_persisted(&store, &key).unwrap().unwrap().doc;
    assert!(doc.project(ContentKind::Richdoc).unwrap().content.contains("Accepted edit stays canonical"));
    let owed = store.read_with(|conn| dohc_engine_collab::markdown_write_obligations::pending_in(conn, "w")).unwrap();
    assert_eq!(owed.len(), 1);
    assert_eq!(owed[0].kind, dohc_engine_collab::markdown_write_obligations::Kind::Session);
    assert!(owed[0].held_head_sha256.is_none());
    assert!(store.list_materialization_jobs().unwrap().is_empty());
}

#[test]
fn raw_output_cannot_use_witness_metadata_as_snapshot_authority() {
    let data: serde_json::Value = serde_json::from_str(include_str!(
        "../../dohc-engine-collab/tests/reader-resolver.json"
    ))
    .unwrap();
    let checkpoint = STANDARD
        .decode(data["checkpoint"].as_str().unwrap())
        .unwrap();
    assert!(matches!(
        dohc_engine_sync::project_ydoc_updates([checkpoint.as_slice()], ContentKind::Richdoc),
        Err(dohc_engine_sync::UpdateProjectionError::Invalid(
            "Markdown reader output requires an authoritative snapshot"
        ))
    ));
}

#[tokio::test]
#[ignore = "requires DOHC_ENGINE_READER_CONFIG for the real staged bundle"]
async fn real_reader_settles_without_edits_and_revalidates_after_restart() {
    let (scratch, db, key, source, claim) = seed();
    for _ in 0..2 {
        let supervisor = WorkspaceSupervisor::new();
        let actor = supervisor.open(&db, 5).unwrap().actor;
        let config =
            serde_json::from_str(&std::env::var("DOHC_ENGINE_READER_CONFIG").unwrap()).unwrap();
        actor
            .configure_reader_resolver(Arc::new(ReaderResolver::new(Arc::new(Reader::new(Some(
                config,
            ))))))
            .await
            .unwrap();
        for _ in 0..2 {
            let result = settle(&actor, scratch.path(), &key, &source, &claim)
                .await
                .unwrap()
                .settled()
                .unwrap();
            assert_eq!(result.projection.content, source);
            let opened = actor
                .ydoc_open_state(
                    "w".into(),
                    11,
                    false,
                    Some(key.clone()),
                    "main".into(),
                    "note.md".into(),
                    Some(ContentKind::Richdoc),
                    CancellationToken::new(),
                )
                .await
                .unwrap();
            assert!(opened.lineage_existing);
        }
        supervisor.close(&db).unwrap();
        assert_eq!(
            std::fs::read(scratch.path().join("note.md")).unwrap(),
            source.as_bytes()
        );
    }
}

#[tokio::test]
#[ignore = "requires DOHC_ENGINE_READER_CONFIG for the real staged bundle"]
async fn real_reader_expires_body_sources_across_settles_and_restart() {
    let (scratch, db, key, source, claim) = seed();
    let mut expected = source;
    for edit in 0..2 {
        let mut store = EngineStore::open(&db, 4).unwrap();
        let doc = dohc_engine_collab::load_persisted(&store, &key)
            .unwrap()
            .unwrap()
            .doc;
        let update = doc.richdoc_append_paragraph(&format!("Body edit {edit}"));
        expected = doc.project(ContentKind::Richdoc).unwrap().content;
        store
            .write_with(&NoFaults, |tx| {
                dohc_engine_collab::record_update_in_tx(tx, &key, &update, None, None, 5)
            })
            .unwrap();
        drop(store);
        let supervisor = WorkspaceSupervisor::new();
        let actor = supervisor.open(&db, 6).unwrap().actor;
        let config =
            serde_json::from_str(&std::env::var("DOHC_ENGINE_READER_CONFIG").unwrap()).unwrap();
        actor
            .configure_reader_resolver(Arc::new(ReaderResolver::new(Arc::new(Reader::new(Some(
                config,
            ))))))
            .await
            .unwrap();
        let before = std::fs::read_to_string(scratch.path().join("note.md")).unwrap();
        let result = settle(&actor, scratch.path(), &key, &before, &claim)
            .await
            .unwrap()
            .settled()
            .unwrap();
        assert_eq!(result.projection.content, expected);
        let result = settle(&actor, scratch.path(), &key, &expected, &claim)
            .await
            .unwrap()
            .settled()
            .unwrap();
        assert_eq!(result.projection.content, expected);
        supervisor.close(&db).unwrap();
        assert_eq!(
            std::fs::read_to_string(scratch.path().join("note.md")).unwrap(),
            expected
        );
    }
    assert!(expected.contains("Body edit 1"));
}
