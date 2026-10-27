use super::*;
use super::super::ydoc::YdocSession;
use dohc_engine_collab::markdown_write_safety::MarkdownConversionConsent;
use dohc_engine_collab::live_update_application::{ImportedOwnerActivation, ImportedOwnerSource};

fn session(id: &str) -> YdocSession {
    let source: ImportedOwnerSource = serde_json::from_value(json!({
        "version":1,"relayDatabaseNamespace":"relay","workspaceId":"w","mainVersionId":"main",
        "objectId":"note","lineageClaimId":"a".repeat(64),"currentPath":"note.md","replicationEpoch":"epoch",
        "streamIdentity":"stream","committedCursor":1,"baseOriginId":"peer","baseOriginSeq":0,
        "baseRelaySeq":1,"sourceMomentId":"source","sourceDigest":"b".repeat(64),"sourceByteLength":0,
        "nativeHeadSequence":0,"fullStateDigest":"a".repeat(64),"fullStateByteLength":0
    })).unwrap();
    let captured = ImportedOwnerActivation { activation_id: "activation".into(), source,
        baseline_bytes: Vec::new(), full_state: Vec::new(), restore_generation: None };
    let key = DocKey::new("w", "main", "note").unwrap();
    let leases = dohc_engine_collab::LeaseRegistry::new();
    let mut session = YdocSession::imported_owner(WorkspaceHandle("workspace-handle".into()),
        key.clone(), &captured, leases.acquire(&key).unwrap()).unwrap();
    session.conversion_consent = Some(Arc::new(MarkdownConversionConsent::new(key, id.into(),
        Some("a".repeat(64)), None, "b".repeat(64), Some("b".repeat(64)))));
    session
}

fn binding() -> LiveObjectBinding {
    LiveObjectBinding { workspace_id: "w".into(), main_version_id: "main".into(), object_id: "note".into(),
        lineage_claim_id: "a".repeat(64), current_path: "note.md".into(), selector_paths: vec!["note.md".into()],
        restore_fence_generation: 0 }
}

#[test]
fn markdown_owner_consent_uses_only_the_forwarded_session_and_keeps_its_grant_until_commit() {
    let workspace = WorkspaceHandle("workspace-handle".into());
    let sessions = Mutex::new(HashMap::from([
        ("owner".into(), session("owner")), ("local-mcp".into(), session("local-mcp")),
    ]));
    let grant = forwarded_owner_consent(&sessions, Some(&workspace), &binding(), Some("owner")).unwrap();
    assert!(Arc::ptr_eq(&grant, lock(&sessions)["owner"].conversion_consent.as_ref().unwrap()));
    assert!(forwarded_owner_consent(&sessions, Some(&workspace), &binding(), None).is_none());
    assert!(forwarded_owner_consent(&sessions, Some(&workspace), &binding(), Some("missing")).is_none());
    // A dropped failed attempt leaves the same grant in that session.
    drop(grant);
    let grant = forwarded_owner_consent(&sessions, Some(&workspace), &binding(), Some("owner")).unwrap();
    assert!(!grant.is_consumed());
    lock(&sessions).remove("owner");
    assert!(forwarded_owner_consent(&sessions, Some(&workspace), &binding(), Some("owner")).is_none());
    assert!(!lock(&sessions)["local-mcp"].conversion_consent.as_ref().unwrap().is_consumed());
    grant.committed();
    assert!(grant.is_consumed());
}

#[test]
fn markdown_owner_consent_rejects_workspace_document_lineage_and_restore_mismatches() {
    let workspace = WorkspaceHandle("workspace-handle".into());
    let sessions = Mutex::new(HashMap::from([("owner".into(), session("owner"))]));
    let original = binding();
    assert!(forwarded_owner_consent(&sessions, Some(&WorkspaceHandle("elsewhere".into())),
        &original, Some("owner")).is_none());
    assert!(forwarded_owner_consent(&sessions, None, &original, Some("owner")).is_none());
    for changed in [
        LiveObjectBinding { workspace_id: "other".into(), ..original.clone() },
        LiveObjectBinding { main_version_id: "other".into(), ..original.clone() },
        LiveObjectBinding { object_id: "other".into(), ..original.clone() },
        LiveObjectBinding { lineage_claim_id: "c".repeat(64), ..original.clone() },
        LiveObjectBinding { restore_fence_generation: 1, ..original.clone() },
    ] {
        assert!(forwarded_owner_consent(&sessions, Some(&workspace), &changed, Some("owner")).is_none());
    }
    let grant = forwarded_owner_consent(&sessions, Some(&workspace), &original, Some("owner")).unwrap();
    assert!(grant.permits_audited(&DocKey::new("w", "main", "note").unwrap(),
        Some(&"a".repeat(64)), 0, Some(&"b".repeat(64)), Some(&"b".repeat(64))));
    grant.committed();
    assert!(forwarded_owner_consent(&sessions, Some(&workspace), &original, Some("owner")).is_none());
}

#[tokio::test]
async fn markdown_owner_consent_session_retains_the_checked_grant_after_audited_rollbacks() {
    use base64::{Engine as _, engine::general_purpose::STANDARD};
    use dohc_engine_collab::{ContentKind, Ydoc, reader_resolver, markdown_write_obligations};
    use dohc_engine_domain::{DomainError, VersionedTextStore, WriteText};
    use dohc_engine_runtime::{RuntimeError, CancellationToken};
    use dohc_engine_storage::{EngineStore, StorageError, hex_sha256};
    use dohc_engine_testkit::{ScratchDir, engine_db_path};
    use yrs::{Map, ReadTxn, Transact, updates::decoder::Decode};

    for failure in ["pending", "stale-head", "conflict"] {
        let scratch = ScratchDir::new().unwrap();
        let db = engine_db_path(&scratch).unwrap();
        let data: Value = serde_json::from_str(include_str!(
            "../../../dohc-engine-collab/tests/reader-resolver.json")).unwrap();
        let source = data["source"].as_str().unwrap().to_owned();
        let source_sha = hex_sha256(source.as_bytes());
        let wire = yrs::Doc::new();
        wire.transact_mut().apply_update(yrs::Update::decode_v1(
            &STANDARD.decode(data["checkpoint"].as_str().unwrap()).unwrap()).unwrap()).unwrap();
        wire.get_or_insert_map("meta").remove(&mut wire.transact_mut(), "dohcLineageEpoch");
        let key = DocKey::new("w", "main", "note").unwrap();
        let mut store = EngineStore::open(&db, 1).unwrap();
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
        let pending = match store.read_with(|conn| reader_resolver::resolve(conn, &key, &original,
            &original.project(ContentKind::Richdoc)?.content, Some(&resolver))) {
            Err(dohc_engine_collab::CollabError::MarkdownReaderPending(pending)) => pending,
            _ => panic!("expected a snapshot proof"),
        };
        let before = wire.transact().state_vector();
        wire.get_or_insert_map("meta").remove(&mut wire.transact_mut(), "dohcMarkdownSourceReader");
        let doc = Ydoc::wire();
        doc.apply(&original.encode_full_state()).unwrap();
        doc.apply(&wire.transact().encode_state_as_update_v1(&before)).unwrap();
        doc.richdoc_append_paragraph("Accepted visitor edit");
        store.write_with(&NoFaults, |tx| dohc_engine_collab::record_update_in_tx(
            tx, &key, &doc.encode_full_state(), None, None, 4)).unwrap();
        let marker = dohc_engine_collab::read_marker(&store, &key).unwrap().unwrap();
        let binding = LiveObjectBinding { lineage_claim_id: marker.lineage_claim_id.clone().unwrap(), ..binding() };
        store.write_with(&NoFaults, |tx| {
            tx.execute("INSERT INTO ydoc_owner_base_sources(workspace_id,version_id,object_id,lineage_claim_id,\
                path,source_moment_id,source_blob_sha256,source_byte_length) VALUES ('w','main','note',?1,\
                'note.md','source',?2,?3)", rusqlite::params![binding.lineage_claim_id,source_sha,source.len() as i64])
                .map_err(StorageError::persist_public)?;
            tx.execute("INSERT INTO live_owner_adoptions(relay_database_namespace,adoption_id,workspace_id,main_version_id,\
                object_id,lineage_claim_id,binding_json,source_moment_id,source_digest,source_byte_length,\
                baseline_moment_relay_sequence,baseline_registered_at_ms,evidence_digest,coverage_digest,\
                covered_outbox_sequence,local_ydoc_sequence,terminal_cursor,terminal_receipt_json,host_coordinate_json,\
                max_pending_bytes,max_pending_age_ms) VALUES ('relay','adoption','w','main','note',?1,?2,'source',?3,?4,\
                0,0,?3,?3,0,?5,0,'null','{}',1000000,1000000)",
                rusqlite::params![binding.lineage_claim_id,serde_json::to_string(&binding).unwrap(),source_sha,
                    source.len() as i64,marker.head_update_seq]).map_err(StorageError::persist_public)
        }).unwrap();
        drop(store);
        std::fs::write(scratch.path().join("note.md"), &source).unwrap();
        let supervisor = dohc_engine_runtime::WorkspaceSupervisor::new();
        let actor = supervisor.open(&db, 5).unwrap().actor;
        actor.configure_reader_resolver(Arc::new(reader_resolver::ReaderResolver::new(
            Arc::new(dohc_engine_reader::Reader::new(Some(unsafe_witness_reader(&scratch))))))).await.unwrap();
        let owner = actor.live_application_owner("w".into()).await.unwrap();
        let host = owner.register("relay".into(), ApplicationHostCoordinate {
            host_id: "host".into(), host_epoch: 1, instance_id: "instance".into(), connection_id: "connection".into(),
        }, binding.clone()).await.unwrap();
        let workspace = WorkspaceHandle("workspace-handle".into());
        let grant = Arc::new(MarkdownConversionConsent::new(key, "owner".into(),
            Some(binding.lineage_claim_id.clone()), None, source_sha.clone(), Some(source_sha)));
        let mut owner_session = session("owner");
        owner_session.lineage_claim_id = Some(binding.lineage_claim_id.clone());
        owner_session.conversion_consent = Some(grant.clone());
        let sessions = Arc::new(Mutex::new(HashMap::from([("owner".into(), owner_session)])));
        let retained = sessions.clone();
        let expected = grant.clone();
        let checked = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let checked_retry = checked.clone();
        let rollback_source = source.clone();
        let rollback_path = scratch.path().join("note.md");
        let rollback_mtime = std::fs::metadata(&rollback_path).unwrap().modified().unwrap();
        actor.markdown_settlement_fault_for_harness(move |conn| {
            assert_eq!(conn.query_row("SELECT count(*) FROM live_device_settlements", [],
                |row| row.get::<_, i64>(0)).unwrap(), 1);
            Err(match failure {
                "pending" => dohc_engine_collab::CollabError::MarkdownReaderPending(pending).into(),
                "stale-head" => DomainError::ConflictStaleTarget.into(),
                _ => DomainError::InvalidInput { reason: "ydoc-conflict-open" }.into(),
            })
        }, move |store| {
            let session_grant = lock(&retained)["owner"].conversion_consent.clone().unwrap();
            assert!(Arc::ptr_eq(&expected, &session_grant));
            assert!(!session_grant.is_consumed());
            assert_eq!(store.table_row_count("moments")?, 1);
            assert_eq!(store.table_row_count("materialization_jobs")?, 0);
            assert_eq!(store.table_row_count("live_device_settlements")?, 0);
            let owed = store.read_with(|conn| markdown_write_obligations::pending_in(conn, "w"))?;
            assert_eq!(owed.len(), 1);
            assert_eq!(owed[0].kind, markdown_write_obligations::Kind::AuditedSettle);
            assert!(owed[0].held_checkpoint_sha256.is_none());
            let head = VersionedTextStore::new(store).read_text("w", "main", "note.md")?.unwrap();
            assert_eq!(head.text, rollback_source);
            assert_eq!(head.blob_sha256, hex_sha256(rollback_source.as_bytes()));
            assert_eq!(std::fs::read_to_string(&rollback_path).unwrap(), rollback_source);
            assert_eq!(std::fs::metadata(&rollback_path).unwrap().modified().unwrap(), rollback_mtime);
            let key = DocKey::new("w", "main", "note").unwrap();
            let doc = dohc_engine_collab::load_persisted(store, &key)?.unwrap().doc;
            assert!(doc.project(ContentKind::Richdoc)?.content.contains("Accepted visitor edit"));
            checked_retry.store(true, std::sync::atomic::Ordering::Release);
            Ok(())
        }).await.unwrap();
        let settle = || host.settle_with_consent(None, 100, scratch.path().to_owned(), 10,
            Arc::new(NoFaults), CancellationToken::new(),
            dohc_engine_collab::live_update_application::AdmittedNativeHistoryReconstruction {
                policy: dohc_engine_collab::live_update_application::NativeHistoryReconstruction {
                    working_reserve_bytes: 8 * 1024 * 1024,
                }, reservation: Arc::new(()),
            }, forwarded_owner_consent(&sessions, Some(&workspace), &binding, Some("owner")));
        let result = settle().await;
        if failure != "pending" {
            assert!(matches!(result, Err(RuntimeError::Domain(_))));
            assert!(Arc::ptr_eq(&grant, lock(&sessions)["owner"].conversion_consent.as_ref().unwrap()));
            assert!(!grant.is_consumed());
            assert_eq!(std::fs::read_to_string(scratch.path().join("note.md")).unwrap(), source);
            assert!(settle().await.unwrap().materialized);
        } else {
            assert!(result.unwrap().materialized);
        }
        assert!(checked.load(std::sync::atomic::Ordering::Acquire));
        assert!(Arc::ptr_eq(&grant, lock(&sessions)["owner"].conversion_consent.as_ref().unwrap()));
        assert!(grant.is_consumed());
        {
            let store = EngineStore::open_read_only(&db).unwrap();
            assert_eq!(store.table_row_count("moments").unwrap(), 2);
            assert_eq!(store.table_row_count("materialization_jobs").unwrap(), 1);
            assert_eq!(store.table_row_count("live_device_settlements").unwrap(), 1);
            let debt = store.read_with(|conn| markdown_write_obligations::pending_in(conn, "w")).unwrap();
            assert_eq!(debt.len(), 1);
            assert_eq!(debt[0].kind, markdown_write_obligations::Kind::WitnessRefresh);
        }
        supervisor.close(&db).unwrap();
    }
}

fn unsafe_witness_reader(scratch: &dohc_engine_testkit::ScratchDir) -> dohc_engine_reader::Config {
    use dohc_engine_storage::hex_sha256;
    let node = std::env::var_os("DOHC_READER_TEST_NODE").unwrap_or_else(|| "node".into());
    let output = std::process::Command::new(node).args(["-p", "JSON.stringify({path:process.execPath,version:process.versions.node,platform:process.platform,arch:process.arch,unicode:process.versions.unicode,icu:process.versions.icu})"]).output().unwrap();
    assert!(output.status.success());
    let mut runtime: Value = serde_json::from_slice(&output.stdout).unwrap();
    let node = std::path::PathBuf::from(runtime.as_object_mut().unwrap().remove("path").unwrap().as_str().unwrap());
    runtime["sha256"] = hex_sha256(&std::fs::read(&node).unwrap()).into();
    let mut manifest = json!({"version":1,"runtime":runtime,"buildSha256":"test","parentCwd":std::env::current_dir().unwrap()});
    let script = include_str!("../../../dohc-engine-reader/src/fake.cjs")
        .replace("MANIFEST", &manifest.to_string()).replace("MODE", "\"witness-unsafe\"");
    let bundle = scratch.path().join("reader.cjs");
    std::fs::write(&bundle, &script).unwrap();
    manifest["bundleSha256"] = hex_sha256(script.as_bytes()).into();
    manifest["sources"] = json!([]);
    let manifest_path = scratch.path().join("reader-manifest.json");
    std::fs::write(&manifest_path, manifest.to_string()).unwrap();
    dohc_engine_reader::Config { node, bundle, manifest: manifest_path }
}
