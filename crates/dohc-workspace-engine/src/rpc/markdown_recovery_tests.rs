use super::*;
use crate::EngineService;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use dohc_engine_collab::{ContentKind, DocKey, Ydoc, reader_resolver};
use dohc_engine_domain::{VersionedTextStore, WriteText};
use dohc_engine_protocol::transport::RequestContext;
use dohc_engine_storage::{EngineStore, StorageError, hex_sha256};
use dohc_engine_testkit::{ScratchDir, engine_db_path};
use serde_json::{Value, json};
use std::path::PathBuf;
use yrs::{Map, ReadTxn, Transact, updates::decoder::Decode};

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn markdown_recovery_preparation_exhaustion_finishes_without_an_open_session() {
    for queued in [false, true] {
        let scratch = ScratchDir::new().unwrap();
        let token = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        crate::root_binding::write_root_binding(scratch.path(), token).unwrap();
        let db = engine_db_path(&scratch).unwrap();
        let data: Value = serde_json::from_str(include_str!(
            "../../../dohc-engine-collab/tests/reader-resolver.json")).unwrap();
        let source = data["source"].as_str().unwrap().to_owned();
        let key = DocKey::new("w", "main", "note").unwrap();
        let wire = yrs::Doc::new();
        wire.transact_mut().apply_update(yrs::Update::decode_v1(
            &STANDARD.decode(data["checkpoint"].as_str().unwrap()).unwrap()).unwrap()).unwrap();
        wire.get_or_insert_map("meta").remove(&mut wire.transact_mut(), "dohcLineageEpoch");
        let mut store = EngineStore::open(&db, 1).unwrap();
        store.bind_root_token(token, &NoFaults).unwrap();
        VersionedTextStore::new(&mut store).ensure_main_version("w", "main", 1, &NoFaults).unwrap();
        VersionedTextStore::new(&mut store).write_text(&WriteText {
            workspace_id: "w".into(), version_id: "main".into(), object_id: "note".into(),
            path: "note.md".into(), text: source.clone(), moment_id: "source".into(),
            metadata_origin: "test".into(), metadata_summary: None, metadata_correlation_id: None,
            author_json: None, now_ms: 2, request_id: None,
        }, &NoFaults).unwrap();
        dohc_engine_collab::claim_base(&mut store, &key, ContentKind::Richdoc,
            &wire.transact().encode_state_as_update_v1(&yrs::StateVector::default()), &NoFaults, 3).unwrap();
        store.write_with(&NoFaults, |tx| tx.execute("UPDATE ydoc_docs SET path='note.md'", [])
            .map_err(StorageError::persist_public)).unwrap();
        let original = dohc_engine_collab::load_persisted(&store, &key).unwrap().unwrap().doc;
        let resolver = reader_resolver::ReaderResolver::new(Arc::new(dohc_engine_reader::Reader::new(None)));
        let proof = match store.read_with(|conn| reader_resolver::resolve(conn, &key, &original,
            &original.project(ContentKind::Richdoc)?.content, Some(&resolver))) {
            Err(dohc_engine_collab::CollabError::MarkdownReaderPending(proof)) => proof,
            _ => panic!("expected a preparation proof"),
        };
        let before = wire.transact().state_vector();
        wire.get_or_insert_map("meta").remove(&mut wire.transact_mut(), "dohcMarkdownSourceReader");
        let doc = Ydoc::wire();
        doc.apply(&original.encode_full_state()).unwrap();
        doc.apply(&wire.transact().encode_state_as_update_v1(&before)).unwrap();
        doc.richdoc_append_paragraph("Accepted edit awaiting preparation");
        store.write_with(&NoFaults, |tx| dohc_engine_collab::record_update_in_tx(
            tx, &key, &doc.encode_full_state(), None, None, 4)).unwrap();
        let marker = dohc_engine_collab::read_marker(&store, &key).unwrap().unwrap();
        drop(store);
        std::fs::write(scratch.path().join("note.md"), &source).unwrap();
        let modified = std::fs::metadata(scratch.path().join("note.md")).unwrap().modified().unwrap();
        let service = EngineService::new();
        let opened = service.workspace_open(&RequestContext::unbounded(), json!({
            "rootDir":scratch.path(),"workspaceId":"w","captureMode":"none",
        })).await.unwrap();
        let handle: WorkspaceHandle = serde_json::from_value(opened["workspace"].clone()).unwrap();
        let open = service.open(Some(&handle)).unwrap();
        let gate = open.session_ops.lock().await;
        let reader = Arc::new(dohc_engine_reader::Reader::new(Some(witness_reader(&scratch))));
        open.actor.configure_reader_resolver(Arc::new(reader_resolver::ReaderResolver::new(reader.clone())))
            .await.unwrap();
        let changed_key = key.clone();
        open.actor.markdown_settlement_fault_for_harness(move |_| {
            Err(dohc_engine_collab::CollabError::MarkdownReaderPending(proof).into())
        }, move |store| {
            let doc = dohc_engine_collab::load_persisted(store, &changed_key)?.unwrap().doc;
            let wire = yrs::Doc::new();
            wire.transact_mut().apply_update(yrs::Update::decode_v1(&doc.encode_full_state()).unwrap()).unwrap();
            let before = wire.transact().state_vector();
            wire.get_or_insert_map("meta").insert(&mut wire.transact_mut(),
                "dohcMarkdownSourceProjectionSha256", "f".repeat(64));
            store.write_with(&NoFaults, |tx| dohc_engine_collab::record_update_in_tx(
                tx, &changed_key, &wire.transact().encode_state_as_update_v1(&before), None, None, 11))?;
            Ok(())
        }).await.unwrap();
        let result = if queued {
            open.actor.ydoc_settle_queued(scratch.path().to_owned(), key.clone(), "note.md".into(),
                ContentKind::Richdoc, marker.lineage_claim_id.clone(), Some(hex_sha256(source.as_bytes())),
                "closed-owner".into(), Arc::new(()), 10, Arc::new(NoFaults), CancellationToken::new(), None, None).await
        } else {
            open.actor.ydoc_settle(scratch.path().to_owned(), key.clone(), "note.md".into(),
                ContentKind::Richdoc, marker.lineage_claim_id.clone(), Some(hex_sha256(source.as_bytes())),
                "closed-owner".into(), Arc::new(()), 10, Arc::new(NoFaults), CancellationToken::new(), None, None).await
        };
        assert!(matches!(result, Err(RuntimeError::Collab(
            dohc_engine_collab::CollabError::MarkdownWitnessCheckPending { .. }))));
        assert!(lock(&service.sessions).is_empty());
        {
            let store = EngineStore::open_read_only(&db).unwrap();
            let owed = store.read_with(|conn| dohc_engine_collab::markdown_write_obligations::pending_in(conn, "w")).unwrap();
            assert_eq!(owed.len(), 1);
            assert_eq!(owed[0].kind, Kind::Session);
            assert!(owed[0].held_checkpoint_sha256.is_none());
            assert!(dohc_engine_sync::list_refusal_notices(&store, "w").unwrap().is_empty());
            assert_eq!(store.table_row_count("moments").unwrap(), 1);
            assert_eq!(store.table_row_count("materialization_jobs").unwrap(), 0);
            assert_eq!(store.table_row_count("live_device_settlements").unwrap(), 0);
        }
        assert_eq!(std::fs::read_to_string(scratch.path().join("note.md")).unwrap(), source);
        assert_eq!(std::fs::metadata(scratch.path().join("note.md")).unwrap().modified().unwrap(), modified);
        drop(gate);
        tokio::time::timeout(std::time::Duration::from_secs(60), async {
            loop {
                if open.actor.markdown_recovery_candidates("w".into()).await.unwrap().is_empty() { break; }
                tokio::task::yield_now().await;
            }
        }).await.expect("the workspace worker completes the save without a session or explicit retry");
        let saved = std::fs::read_to_string(scratch.path().join("note.md")).unwrap();
        assert_eq!(saved.matches("Accepted edit awaiting preparation").count(), 1);
        assert_eq!(reader.dispatch_count(), 2);
        {
            let store = EngineStore::open_read_only(&db).unwrap();
            assert_eq!(store.table_row_count("moments").unwrap(), 2);
            assert_eq!(store.table_row_count("materialization_jobs").unwrap(), 1);
            assert_eq!(store.table_row_count("live_device_settlements").unwrap(), 0);
            assert_eq!(dohc_engine_collab::read_marker(&store, &key).unwrap().unwrap().head_update_seq,
                marker.head_update_seq + 1);
        }
        service.workspace_close(Some(handle)).await.unwrap();
    }
}

fn witness_reader(scratch: &ScratchDir) -> dohc_engine_reader::Config {
    let node = std::env::var_os("DOHC_READER_TEST_NODE").unwrap_or_else(|| "node".into());
    let output = std::process::Command::new(node).args(["-p", "JSON.stringify({path:process.execPath,version:process.versions.node,platform:process.platform,arch:process.arch,unicode:process.versions.unicode,icu:process.versions.icu})"]).output().unwrap();
    assert!(output.status.success());
    let mut runtime: Value = serde_json::from_slice(&output.stdout).unwrap();
    let node = PathBuf::from(runtime.as_object_mut().unwrap().remove("path").unwrap().as_str().unwrap());
    runtime["sha256"] = hex_sha256(&std::fs::read(&node).unwrap()).into();
    let mut manifest = json!({"version":1,"runtime":runtime,"buildSha256":"test","parentCwd":std::env::current_dir().unwrap()});
    let script = include_str!("../../../dohc-engine-reader/src/fake.cjs")
        .replace("MANIFEST", &manifest.to_string()).replace("MODE", "\"witness-safe\"");
    let bundle = scratch.path().join("reader.cjs");
    std::fs::write(&bundle, &script).unwrap();
    manifest["bundleSha256"] = hex_sha256(script.as_bytes()).into();
    manifest["sources"] = json!([]);
    let manifest_path = scratch.path().join("reader-manifest.json");
    std::fs::write(&manifest_path, manifest.to_string()).unwrap();
    dohc_engine_reader::Config { node, bundle, manifest: manifest_path }
}
