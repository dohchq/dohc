use super::super::ydoc::YdocSession;
use super::*;
use dohc_engine_collab::live_update_application::{ImportedOwnerActivation, ImportedOwnerSource};
use dohc_engine_collab::markdown_write_safety::MarkdownConversionConsent;

fn session(id: &str) -> YdocSession {
    let source: ImportedOwnerSource = serde_json::from_value(json!({
        "version":1,"relayDatabaseNamespace":"relay","workspaceId":"w","mainVersionId":"main",
        "objectId":"note","lineageClaimId":"a".repeat(64),"currentPath":"note.md","replicationEpoch":"epoch",
        "streamIdentity":"stream","committedCursor":1,"baseOriginId":"peer","baseOriginSeq":0,
        "baseRelaySeq":1,"sourceMomentId":"source","sourceDigest":"b".repeat(64),"sourceByteLength":0,
        "nativeHeadSequence":0,"fullStateDigest":"a".repeat(64),"fullStateByteLength":0
    })).unwrap();
    let captured = ImportedOwnerActivation {
        activation_id: "activation".into(),
        source,
        baseline_bytes: Vec::new(),
        full_state: Vec::new(),
        restore_generation: None,
    };
    let key = DocKey::new("w", "main", "note").unwrap();
    let leases = dohc_engine_collab::LeaseRegistry::new();
    let mut session = YdocSession::imported_owner(
        WorkspaceHandle("workspace-handle".into()),
        key.clone(),
        &captured,
        leases.acquire(&key).unwrap(),
    )
    .unwrap();
    session.conversion_consent = Some(Arc::new(MarkdownConversionConsent::new(
        key,
        id.into(),
        Some("a".repeat(64)),
        None,
        "b".repeat(64),
        Some("b".repeat(64)),
    )));
    session
}

fn binding() -> LiveObjectBinding {
    LiveObjectBinding {
        workspace_id: "w".into(),
        main_version_id: "main".into(),
        object_id: "note".into(),
        lineage_claim_id: "a".repeat(64),
        current_path: "note.md".into(),
        selector_paths: vec!["note.md".into()],
        restore_fence_generation: 0,
    }
}

#[test]
fn markdown_owner_consent_uses_only_the_forwarded_session_and_keeps_its_grant_until_commit() {
    let workspace = WorkspaceHandle("workspace-handle".into());
    let sessions = Mutex::new(HashMap::from([
        ("owner".into(), session("owner")),
        ("local-mcp".into(), session("local-mcp")),
    ]));
    let grant =
        forwarded_owner_consent(&sessions, Some(&workspace), &binding(), Some("owner")).unwrap();
    assert!(Arc::ptr_eq(
        &grant,
        lock(&sessions)["owner"]
            .conversion_consent
            .as_ref()
            .unwrap()
    ));
    assert!(forwarded_owner_consent(&sessions, Some(&workspace), &binding(), None).is_none());
    assert!(
        forwarded_owner_consent(&sessions, Some(&workspace), &binding(), Some("missing")).is_none()
    );
    // A dropped failed attempt leaves the same grant in that session.
    drop(grant);
    let grant =
        forwarded_owner_consent(&sessions, Some(&workspace), &binding(), Some("owner")).unwrap();
    assert!(!grant.is_consumed());
    lock(&sessions).remove("owner");
    assert!(
        forwarded_owner_consent(&sessions, Some(&workspace), &binding(), Some("owner")).is_none()
    );
    assert!(
        !lock(&sessions)["local-mcp"]
            .conversion_consent
            .as_ref()
            .unwrap()
            .is_consumed()
    );
    grant.committed();
    assert!(grant.is_consumed());
}

#[test]
fn markdown_owner_consent_rejects_workspace_document_lineage_and_restore_mismatches() {
    let workspace = WorkspaceHandle("workspace-handle".into());
    let sessions = Mutex::new(HashMap::from([("owner".into(), session("owner"))]));
    let original = binding();
    assert!(
        forwarded_owner_consent(
            &sessions,
            Some(&WorkspaceHandle("elsewhere".into())),
            &original,
            Some("owner")
        )
        .is_none()
    );
    assert!(forwarded_owner_consent(&sessions, None, &original, Some("owner")).is_none());
    for changed in [
        LiveObjectBinding {
            workspace_id: "other".into(),
            ..original.clone()
        },
        LiveObjectBinding {
            main_version_id: "other".into(),
            ..original.clone()
        },
        LiveObjectBinding {
            object_id: "other".into(),
            ..original.clone()
        },
        LiveObjectBinding {
            lineage_claim_id: "c".repeat(64),
            ..original.clone()
        },
        LiveObjectBinding {
            restore_fence_generation: 1,
            ..original.clone()
        },
    ] {
        assert!(
            forwarded_owner_consent(&sessions, Some(&workspace), &changed, Some("owner")).is_none()
        );
    }
    let grant =
        forwarded_owner_consent(&sessions, Some(&workspace), &original, Some("owner")).unwrap();
    assert!(grant.permits_audited(
        &DocKey::new("w", "main", "note").unwrap(),
        Some(&"a".repeat(64)),
        0,
        Some(&"b".repeat(64)),
        Some(&"b".repeat(64))
    ));
    grant.committed();
    assert!(
        forwarded_owner_consent(&sessions, Some(&workspace), &original, Some("owner")).is_none()
    );
}

#[tokio::test]
async fn markdown_owner_consent_session_retains_the_checked_grant_after_audited_rollbacks() {
    use base64::{Engine as _, engine::general_purpose::STANDARD};
    use dohc_engine_collab::{ContentKind, Ydoc, markdown_write_obligations, reader_resolver};
    use dohc_engine_domain::{DomainError, VersionedTextStore, WriteText};
    use dohc_engine_runtime::{CancellationToken, RuntimeError};
    use dohc_engine_storage::{EngineStore, StorageError, hex_sha256};
    use dohc_engine_testkit::{ScratchDir, engine_db_path};
    use yrs::{Map, ReadTxn, Transact, updates::decoder::Decode};

    for failure in ["pending", "stale-head", "conflict"] {
        let scratch = ScratchDir::new().unwrap();
        let db = engine_db_path(&scratch).unwrap();
        let data: Value = serde_json::from_str(include_str!(
            "../../../dohc-engine-collab/tests/reader-resolver.json"
        ))
        .unwrap();
        let source = data["source"].as_str().unwrap().to_owned();
        let source_sha = hex_sha256(source.as_bytes());
        let wire = yrs::Doc::new();
        wire.transact_mut()
            .apply_update(
                yrs::Update::decode_v1(
                    &STANDARD
                        .decode(data["checkpoint"].as_str().unwrap())
                        .unwrap(),
                )
                .unwrap(),
            )
            .unwrap();
        wire.get_or_insert_map("meta")
            .remove(&mut wire.transact_mut(), "dohcLineageEpoch");
        let key = DocKey::new("w", "main", "note").unwrap();
        let mut store = EngineStore::open(&db, 1).unwrap();
        VersionedTextStore::new(&mut store)
            .ensure_main_version("w", "main", 1, &NoFaults)
            .unwrap();
        VersionedTextStore::new(&mut store)
            .write_text(
                &WriteText {
                    workspace_id: "w".into(),
                    version_id: "main".into(),
                    object_id: "note".into(),
                    path: "note.md".into(),
                    text: source.clone(),
                    moment_id: "source".into(),
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
            &wire
                .transact()
                .encode_state_as_update_v1(&yrs::StateVector::default()),
            &NoFaults,
            3,
        )
        .unwrap();
        store
            .write_with(&NoFaults, |tx| {
                tx.execute("UPDATE ydoc_docs SET path='note.md'", [])
                    .map_err(StorageError::persist_public)
            })
            .unwrap();
        let original = dohc_engine_collab::load_persisted(&store, &key)
            .unwrap()
            .unwrap()
            .doc;
        let resolver =
            reader_resolver::ReaderResolver::new(Arc::new(dohc_engine_reader::Reader::new(None)));
        let pending = match store.read_with(|conn| {
            reader_resolver::resolve(
                conn,
                &key,
                &original,
                &original.project(ContentKind::Richdoc)?.content,
                Some(&resolver),
            )
        }) {
            Err(dohc_engine_collab::CollabError::MarkdownReaderPending(pending)) => pending,
            _ => panic!("expected a snapshot proof"),
        };
        let before = wire.transact().state_vector();
        wire.get_or_insert_map("meta")
            .remove(&mut wire.transact_mut(), "dohcMarkdownSourceReader");
        let doc = Ydoc::wire();
        doc.apply(&original.encode_full_state()).unwrap();
        doc.apply(&wire.transact().encode_state_as_update_v1(&before))
            .unwrap();
        doc.richdoc_append_paragraph("Accepted visitor edit");
        store
            .write_with(&NoFaults, |tx| {
                dohc_engine_collab::record_update_in_tx(
                    tx,
                    &key,
                    &doc.encode_full_state(),
                    None,
                    None,
                    4,
                )
            })
            .unwrap();
        let marker = dohc_engine_collab::read_marker(&store, &key)
            .unwrap()
            .unwrap();
        let binding = LiveObjectBinding {
            lineage_claim_id: marker.lineage_claim_id.clone().unwrap(),
            ..binding()
        };
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
                0,0,?3,?3,0,?5,0,'null','{\"hostId\":\"host\",\"hostEpoch\":1,\"instanceId\":\"instance\",\"connectionId\":\"connection\"}',1000000,1000000)",
                rusqlite::params![binding.lineage_claim_id,serde_json::to_string(&binding).unwrap(),source_sha,
                    source.len() as i64,marker.head_update_seq]).map_err(StorageError::persist_public)?;
                dohc_engine_collab::live_update_application::initialize_adopted_history_for_test(tx, "relay", &binding)
                    .map_err(StorageError::persist_public)
        }).unwrap();
        drop(store);
        std::fs::write(scratch.path().join("note.md"), &source).unwrap();
        let supervisor = dohc_engine_runtime::WorkspaceSupervisor::new();
        let actor = supervisor.open(&db, 5).unwrap().actor;
        actor
            .configure_reader_resolver(Arc::new(reader_resolver::ReaderResolver::new(Arc::new(
                dohc_engine_reader::Reader::new(Some(unsafe_witness_reader(&scratch))),
            ))))
            .await
            .unwrap();
        let owner = actor.live_application_owner("w".into()).await.unwrap();
        let host = owner
            .register(
                "relay".into(),
                ApplicationHostCoordinate {
                    host_id: "host".into(),
                    host_epoch: 1,
                    instance_id: "instance".into(),
                    connection_id: "connection".into(),
                },
                binding.clone(),
            )
            .await
            .unwrap();
        let workspace = WorkspaceHandle("workspace-handle".into());
        let grant = Arc::new(MarkdownConversionConsent::new(
            key,
            "owner".into(),
            Some(binding.lineage_claim_id.clone()),
            None,
            source_sha.clone(),
            Some(source_sha),
        ));
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
        let rollback_mtime = std::fs::metadata(&rollback_path)
            .unwrap()
            .modified()
            .unwrap();
        actor
            .markdown_settlement_fault_for_harness(
                move |conn| {
                    assert_eq!(
                        conn.query_row("SELECT count(*) FROM live_empty_settlements", [], |row| {
                            row.get::<_, i64>(0)
                        })
                        .unwrap(),
                        1
                    );
                    Err(match failure {
                        "pending" => {
                            dohc_engine_collab::CollabError::MarkdownReaderPending(pending).into()
                        }
                        "stale-head" => DomainError::ConflictStaleTarget.into(),
                        _ => DomainError::InvalidInput {
                            reason: "ydoc-conflict-open",
                        }
                        .into(),
                    })
                },
                move |store| {
                    let session_grant =
                        lock(&retained)["owner"].conversion_consent.clone().unwrap();
                    assert!(Arc::ptr_eq(&expected, &session_grant));
                    assert!(!session_grant.is_consumed());
                    assert_eq!(store.table_row_count("moments")?, 1);
                    assert_eq!(store.table_row_count("materialization_jobs")?, 0);
                    assert_eq!(store.table_row_count("live_device_settlements")?, 0);
                    let owed = store
                        .read_with(|conn| markdown_write_obligations::pending_in(conn, "w"))?;
                    assert_eq!(owed.len(), 1);
                    assert_eq!(
                        owed[0].kind,
                        markdown_write_obligations::Kind::AuditedSettle
                    );
                    assert!(owed[0].held_checkpoint_sha256.is_none());
                    let head = VersionedTextStore::new(store)
                        .read_text("w", "main", "note.md")?
                        .unwrap();
                    assert_eq!(head.text, rollback_source);
                    assert_eq!(head.blob_sha256, hex_sha256(rollback_source.as_bytes()));
                    assert_eq!(
                        std::fs::read_to_string(&rollback_path).unwrap(),
                        rollback_source
                    );
                    assert_eq!(
                        std::fs::metadata(&rollback_path)
                            .unwrap()
                            .modified()
                            .unwrap(),
                        rollback_mtime
                    );
                    let key = DocKey::new("w", "main", "note").unwrap();
                    let doc = dohc_engine_collab::load_persisted(store, &key)?
                        .unwrap()
                        .doc;
                    assert!(
                        doc.project(ContentKind::Richdoc)?
                            .content
                            .contains("Accepted visitor edit")
                    );
                    checked_retry.store(true, std::sync::atomic::Ordering::Release);
                    Ok(())
                },
            )
            .await
            .unwrap();
        let settle =
            || {
                host.settle_with_consent(None, 100, scratch.path().to_owned(), 10,
            Arc::new(NoFaults), CancellationToken::new(),
            dohc_engine_collab::live_update_application::AdmittedNativeHistoryReconstruction {
                policy: dohc_engine_collab::live_update_application::NativeHistoryReconstruction {
                    working_reserve_bytes: 8 * 1024 * 1024,
                }, reservation: Arc::new(()),
            }, forwarded_owner_consent(&sessions, Some(&workspace), &binding, Some("owner")))
            };
        let result = settle().await;
        if failure != "pending" {
            assert!(matches!(result, Err(RuntimeError::Domain(_))));
            assert!(Arc::ptr_eq(
                &grant,
                lock(&sessions)["owner"]
                    .conversion_consent
                    .as_ref()
                    .unwrap()
            ));
            assert!(!grant.is_consumed());
            assert_eq!(
                std::fs::read_to_string(scratch.path().join("note.md")).unwrap(),
                source
            );
            assert!(settle().await.unwrap().materialized);
        } else {
            assert!(result.unwrap().materialized);
        }
        assert!(checked.load(std::sync::atomic::Ordering::Acquire));
        assert!(Arc::ptr_eq(
            &grant,
            lock(&sessions)["owner"]
                .conversion_consent
                .as_ref()
                .unwrap()
        ));
        assert!(grant.is_consumed());
        {
            let store = EngineStore::open_read_only(&db).unwrap();
            assert_eq!(store.table_row_count("moments").unwrap(), 2);
            assert_eq!(store.table_row_count("materialization_jobs").unwrap(), 1);
            assert_eq!(store.table_row_count("live_empty_settlements").unwrap(), 1);
            let debt = store
                .read_with(|conn| markdown_write_obligations::pending_in(conn, "w"))
                .unwrap();
            assert_eq!(debt.len(), 1);
            assert_eq!(
                debt[0].kind,
                markdown_write_obligations::Kind::WitnessRefresh
            );
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
    let node = std::path::PathBuf::from(
        runtime
            .as_object_mut()
            .unwrap()
            .remove("path")
            .unwrap()
            .as_str()
            .unwrap(),
    );
    runtime["sha256"] = hex_sha256(&std::fs::read(&node).unwrap()).into();
    let mut manifest = json!({"version":1,"runtime":runtime,"buildSha256":"test","parentCwd":std::env::current_dir().unwrap()});
    let script = include_str!("../../../dohc-engine-reader/src/fake.cjs")
        .replace("MANIFEST", &manifest.to_string())
        .replace("MODE", "\"witness-unsafe\"");
    let bundle = scratch.path().join("reader.cjs");
    std::fs::write(&bundle, &script).unwrap();
    manifest["bundleSha256"] = hex_sha256(script.as_bytes()).into();
    manifest["sources"] = json!([]);
    let manifest_path = scratch.path().join("reader-manifest.json");
    std::fs::write(&manifest_path, manifest.to_string()).unwrap();
    dohc_engine_reader::Config {
        node,
        bundle,
        manifest: manifest_path,
    }
}

async fn adopted_rpc_fixture() -> (
    dohc_engine_testkit::ScratchDir,
    Arc<EngineService>,
    dohc_engine_protocol::transport::ConnectionOwner,
    WorkspaceHandle,
    LiveObjectBinding,
    String,
) {
    use base64::{Engine as _, engine::general_purpose::STANDARD};
    use dohc_engine_collab::{ContentKind, Ydoc};
    use dohc_engine_domain::{VersionedTextStore, WriteText};
    use dohc_engine_storage::{EngineStore, StorageError, hex_sha256};
    use dohc_engine_testkit::{ScratchDir, engine_db_path};
    use yrs::{Map, ReadTxn, Transact, updates::decoder::Decode};
    let scratch = ScratchDir::new().unwrap();
    let token = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    crate::root_binding::write_root_binding(scratch.path(), token).unwrap();
    let data: Value = serde_json::from_str(include_str!(
        "../../../dohc-engine-collab/tests/reader-resolver.json"
    ))
    .unwrap();
    let source = data["source"].as_str().unwrap().to_owned();
    let source_sha = hex_sha256(source.as_bytes());
    let wire = yrs::Doc::new();
    wire.transact_mut()
        .apply_update(
            yrs::Update::decode_v1(
                &STANDARD
                    .decode(data["checkpoint"].as_str().unwrap())
                    .unwrap(),
            )
            .unwrap(),
        )
        .unwrap();
    for key in ["dohcLineageEpoch", "dohcMarkdownSourceReader"] {
        wire.get_or_insert_map("meta")
            .remove(&mut wire.transact_mut(), key);
    }
    let doc = Ydoc::wire();
    doc.apply(
        &wire
            .transact()
            .encode_state_as_update_v1(&yrs::StateVector::default()),
    )
    .unwrap();
    let key = DocKey::new("w", "main", "note").unwrap();
    let db = engine_db_path(&scratch).unwrap();
    let mut store = EngineStore::open(&db, 1).unwrap();
    store.bind_root_token(token, &NoFaults).unwrap();
    VersionedTextStore::new(&mut store)
        .ensure_main_version("w", "main", 1, &NoFaults)
        .unwrap();
    VersionedTextStore::new(&mut store)
        .write_text(
            &WriteText {
                workspace_id: "w".into(),
                version_id: "main".into(),
                object_id: "note".into(),
                path: "note.md".into(),
                text: source.clone(),
                moment_id: "source".into(),
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
        &doc.encode_full_state(),
        &NoFaults,
        3,
    )
    .unwrap();
    let marker = dohc_engine_collab::read_marker(&store, &key)
        .unwrap()
        .unwrap();
    let binding = LiveObjectBinding {
        lineage_claim_id: marker.lineage_claim_id.clone().unwrap(),
        ..binding()
    };
    store.write_with(&NoFaults, |tx| {
        tx.execute("UPDATE ydoc_docs SET path='note.md'", []).map_err(StorageError::persist_public)?;
        tx.execute("INSERT INTO ydoc_owner_base_sources(workspace_id,version_id,object_id,lineage_claim_id,\
            path,source_moment_id,source_blob_sha256,source_byte_length) VALUES ('w','main','note',?1,\
            'note.md','source',?2,?3)", rusqlite::params![binding.lineage_claim_id,source_sha,source.len() as i64])
            .map_err(StorageError::persist_public)?;
        tx.execute("INSERT INTO live_owner_adoptions(relay_database_namespace,adoption_id,workspace_id,main_version_id,\
            object_id,lineage_claim_id,binding_json,source_moment_id,source_digest,source_byte_length,\
            baseline_moment_relay_sequence,baseline_registered_at_ms,evidence_digest,coverage_digest,\
            covered_outbox_sequence,local_ydoc_sequence,terminal_cursor,terminal_receipt_json,host_coordinate_json,\
            max_pending_bytes,max_pending_age_ms) VALUES ('relay','adoption','w','main','note',?1,?2,'source',?3,?4,\
            0,0,?3,?3,0,?5,0,'null','{\"hostId\":\"host\",\"hostEpoch\":1,\"instanceId\":\"instance\",\"connectionId\":\"connection\"}',1000000,1000000)",
            rusqlite::params![binding.lineage_claim_id,serde_json::to_string(&binding).unwrap(),source_sha,
                source.len() as i64,marker.head_update_seq]).map_err(StorageError::persist_public)?;
                dohc_engine_collab::live_update_application::initialize_adopted_history_for_test(tx, "relay", &binding)
                    .map_err(StorageError::persist_public)
    }).unwrap();
    drop(store);
    std::fs::write(scratch.path().join("note.md"), &source).unwrap();
    let configuration = serde_json::from_value(json!({
        "version":1,"relayNamespace":"relay",
        "host":{"hostId":"host","hostEpoch":1,"instanceId":"instance","connectionId":"connection"},
        "workspaces":[{"root":scratch.path(),"workspaceId":"w","maxRegistrations":4}],
        "ingress":{"aggregateBytes":512*1024*1024,"applicationWorkingReserveBytes":8*1024*1024,
            "maxUploads":1,"uploadDeadlineMs":30_000},
        "settlement":{"maxApplicationsPerSettlement":4}
    }))
    .unwrap();
    let (service, owner, _ingress) = EngineService::configured_live_host(configuration)
        .await
        .unwrap();
    let workspace = lock(&service.handles).keys().next().unwrap().clone();
    service
        .open(Some(&workspace))
        .unwrap()
        .actor
        .configure_reader_resolver(Arc::new(
            dohc_engine_collab::reader_resolver::ReaderResolver::new(Arc::new(
                dohc_engine_reader::Reader::new(Some(unsafe_witness_reader(&scratch))),
            )),
        ))
        .await
        .unwrap();
    (scratch, service, owner, workspace, binding, source)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn markdown_owner_consent_rpc_releases_the_adopted_hold_but_never_uses_a_closed_owners_mcp_grant()
 {
    use dohc_engine_collab::live_update_application::*;
    use dohc_engine_collab::{ContentKind, Ydoc, markdown_write_obligations};
    use dohc_engine_protocol::wire::Request;
    use dohc_engine_storage::{EngineStore, hex_sha256};
    use dohc_engine_testkit::engine_db_path;
    for close_owner in [false, true] {
        let (scratch, service, owner, workspace, binding, source) = adopted_rpc_fixture().await;
        let open = service.open(Some(&workspace)).unwrap();
        let db = engine_db_path(&scratch).unwrap();
        let modified = std::fs::metadata(scratch.path().join("note.md"))
            .unwrap()
            .modified()
            .unwrap();
        let mut ctx = RequestContext::unbounded();
        ctx.connection = Some(owner.handle());
        let registered = service
            .live_application_register(&ctx, Some(workspace.clone()), json!({"binding":binding}))
            .await
            .unwrap();
        let registration_id = registered["registrationId"].as_u64().unwrap();
        let registration = service
            .live_application_registration(&owner.handle(), Some(&workspace), registration_id)
            .unwrap();
        let doc = {
            let store = EngineStore::open_read_only(&db).unwrap();
            dohc_engine_collab::load_persisted(&store, &DocKey::new("w", "main", "note").unwrap())
                .unwrap()
                .unwrap()
                .doc
        };
        let bytes = doc.richdoc_append_paragraph("Accepted visitor edit awaiting owner consent");
        let receipt = LiveUpdateReceipt {
            delivery_id: "visitor".into(),
            update_digest: hex_sha256(&bytes),
            journal_cursor: 1,
            accepting_host_epoch: 1,
        };
        let admitted = AdmittedLiveUpdate {
            metadata: AdmittedLiveUpdateMetadata {
                accepted: RelayAcceptedLiveUpdate {
                    receipt: receipt.clone(),
                    binding: binding.clone(),
                    authority: ServerDerivedLiveUpdateAuthority::Link {
                        principal_id: "visitor-test".into(),
                        grant_id: "edit-link".into(),
                        grant_generation: 1,
                    },
                    received_at_ms: 10,
                },
                first_seen: vec![],
                canonical_version: None,
                author_snapshot: None,
                first_seen_deletes: None,
                checkpoint_coverage: None,
            },
            update_bytes: bytes,
        };
        assert!(matches!(
            registration
                .handle
                .apply_with_reservation(
                    admitted,
                    Arc::new(NoFaults),
                    None,
                    8 * 1024 * 1024,
                    Some(4)
                )
                .await
                .unwrap(),
            ApplicationResult::Applied(_, _)
        ));
        let request = |owner_session: Option<&str>| Request {
            id: 99,
            method: "liveApplication.settle".into(),
            workspace: Some(workspace.clone()),
            deadline_ms: Some(60_000),
            idempotency_key: None,
            progress: false,
            params: json!({"registrationId":registration_id,"terminalReceipt":receipt,"ownerSessionId":owner_session}),
        };
        let error = service
            .live_application_settle(ctx.clone(), request(None))
            .await
            .err()
            .unwrap();
        assert_eq!(error.message, "markdown-write-held");
        let notice = {
            let store = EngineStore::open_read_only(&db).unwrap();
            assert_eq!(store.table_row_count("moments").unwrap(), 1);
            assert_eq!(store.table_row_count("materialization_jobs").unwrap(), 0);
            assert_eq!(store.table_row_count("live_device_settlements").unwrap(), 0);
            dohc_engine_sync::list_refusal_notices(&store, "w")
                .unwrap()
                .remove(0)
        };
        assert_eq!(
            std::fs::read_to_string(scratch.path().join("note.md")).unwrap(),
            source
        );
        assert_eq!(
            std::fs::metadata(scratch.path().join("note.md"))
                .unwrap()
                .modified()
                .unwrap(),
            modified
        );
        assert_eq!(
            notice.document.as_ref().unwrap().path.as_deref(),
            Some("note.md")
        );
        let (opened, egress) = service
            .ydoc_open(
                &ctx,
                Some(workspace.clone()),
                json!({"versionId":"main","path":"note.md","contentKind":"richdoc"}),
                100,
            )
            .await
            .unwrap();
        drop(egress);
        let session_id = opened["sessionId"].as_str().unwrap().to_owned();
        let mut events = service.events.subscribe();
        let error = service
            .ydoc_settle(
                &ctx,
                Some(workspace.clone()),
                json!({
                    "sessionId":session_id,"allowLossySourceSha256":hex_sha256(source.as_bytes()),
                }),
            )
            .await
            .unwrap_err();
        assert_eq!(error.message, "markdown-write-held");
        let grant = lock(&service.sessions)[&session_id]
            .conversion_consent
            .clone()
            .unwrap();
        assert!(!grant.is_consumed());
        tokio::time::timeout(std::time::Duration::from_secs(60), async {
            loop {
                let event = events.recv().await.unwrap();
                if event.name == "ydoc.remoteUpdate"
                    && event.payload["sessionId"] == session_id
                    && event.payload["settlementWanted"] == true
                {
                    break;
                }
            }
        })
        .await
        .expect("a held consent settle wakes the relay through the recovery worker");
        if close_owner {
            service
                .ydoc_close(
                    &ctx,
                    Some(workspace.clone()),
                    json!({"sessionId":session_id,"settle":false}),
                )
                .await
                .unwrap();
            let (mcp, egress) = service
                .ydoc_open(
                    &ctx,
                    Some(workspace.clone()),
                    json!({
                        "versionId":"main","path":"note.md","contentKind":"richdoc",
                        "allowLossySourceSha256":hex_sha256(source.as_bytes()),
                    }),
                    101,
                )
                .await
                .unwrap();
            drop(egress);
            let mcp_id = mcp["sessionId"].as_str().unwrap();
            let error = service
                .live_application_settle(ctx.clone(), request(Some(&session_id)))
                .await
                .err()
                .unwrap();
            assert_eq!(error.message, "markdown-write-held");
            assert!(
                !lock(&service.sessions)[mcp_id]
                    .conversion_consent
                    .as_ref()
                    .unwrap()
                    .is_consumed()
            );
            assert!(!grant.is_consumed());
            assert_eq!(
                std::fs::read_to_string(scratch.path().join("note.md")).unwrap(),
                source
            );
            assert_eq!(
                std::fs::metadata(scratch.path().join("note.md"))
                    .unwrap()
                    .modified()
                    .unwrap(),
                modified
            );
            let store = EngineStore::open_read_only(&db).unwrap();
            assert_eq!(store.table_row_count("live_device_settlements").unwrap(), 0);
            assert!(
                !dohc_engine_sync::list_refusal_notices(&store, "w")
                    .unwrap()
                    .is_empty()
            );
        } else {
            let settled = service
                .live_application_settle(ctx.clone(), request(Some(&session_id)))
                .await
                .unwrap();
            assert_eq!(settled.response.result["status"], "settled");
            assert_eq!(settled.response.result["settlement"]["terminalCursor"], 1);
            assert!(grant.is_consumed());
            tokio::time::timeout(std::time::Duration::from_secs(60), async {
                loop {
                    if open
                        .actor
                        .markdown_recovery_candidates("w".into())
                        .await
                        .unwrap()
                        .is_empty()
                    {
                        break;
                    }
                    tokio::task::yield_now().await;
                }
            })
            .await
            .expect("audited completion also clears its refresh debt");
            let store = EngineStore::open_read_only(&db).unwrap();
            assert!(
                store
                    .read_with(|conn| markdown_write_obligations::pending_in(conn, "w"))
                    .unwrap()
                    .is_empty()
            );
            assert!(
                dohc_engine_sync::list_refusal_notices(&store, "w")
                    .unwrap()
                    .is_empty()
            );
            assert_eq!(store.table_row_count("live_device_settlements").unwrap(), 1);
            let saved = std::fs::read_to_string(scratch.path().join("note.md")).unwrap();
            assert_eq!(
                saved
                    .matches("Accepted visitor edit awaiting owner consent")
                    .count(),
                1
            );
            let doc = Ydoc::wire();
            let refreshed = open
                .actor
                .ydoc_resync(
                    DocKey::new("w", "main", "note").unwrap(),
                    Some(binding.lineage_claim_id.clone()),
                    dohc_engine_runtime::CancellationToken::new(),
                    None,
                )
                .await
                .unwrap();
            doc.apply(&refreshed.initial_update).unwrap();
            assert!(!doc.has_markdown_witness());
            assert!(
                doc.project(ContentKind::Richdoc)
                    .unwrap()
                    .content
                    .contains("Accepted visitor edit")
            );
        }
        service.workspace_close(Some(workspace)).await.unwrap();
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn markdown_owner_consent_open_and_settle_validate_the_same_source() {
    let (scratch, service, owner, workspace, _, source) = adopted_rpc_fixture().await;
    let mut ctx = RequestContext::unbounded();
    ctx.connection = Some(owner.handle());
    let wrong_source = dohc_engine_storage::hex_sha256(b"another source");
    let open_error = service
        .ydoc_open(
            &ctx,
            Some(workspace.clone()),
            json!({
                "versionId":"main","path":"note.md","contentKind":"richdoc",
                "allowLossySourceSha256":wrong_source,
            }),
            100,
        )
        .await
        .expect_err("open must reject a different witness source");
    assert!(lock(&service.sessions).is_empty());
    let (opened, egress) = service
        .ydoc_open(
            &ctx,
            Some(workspace.clone()),
            json!({
                "versionId":"main","path":"note.md","contentKind":"richdoc",
                "allowLossySourceSha256":dohc_engine_storage::hex_sha256(source.as_bytes()),
            }),
            101,
        )
        .await
        .unwrap();
    drop(egress);
    let session_id = opened["sessionId"].as_str().unwrap();
    let grant = lock(&service.sessions)[session_id]
        .conversion_consent
        .clone()
        .unwrap();
    let settle_error = service
        .ydoc_settle(
            &ctx,
            Some(workspace.clone()),
            json!({
                "sessionId":session_id,"allowLossySourceSha256":wrong_source,
            }),
        )
        .await
        .unwrap_err();
    assert_eq!(settle_error.code, open_error.code);
    assert_eq!(settle_error.message, open_error.message);
    assert!(Arc::ptr_eq(
        &grant,
        lock(&service.sessions)[session_id]
            .conversion_consent
            .as_ref()
            .unwrap()
    ));
    assert!(!grant.is_consumed());
    assert_eq!(
        std::fs::read_to_string(scratch.path().join("note.md")).unwrap(),
        source
    );
    service.workspace_close(Some(workspace)).await.unwrap();
}

/// Edit anyway on a note never opened for editing. It has no Y.Doc state, so
/// the session seeds from the file and the open's consent covers its bytes.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn markdown_owner_consent_opens_a_never_opened_note() {
    edit_anyway_opens_a_note_with_no_ydoc_state(false, Rename::None).await;
}

/// Edit anyway on a note whose earlier local session closed, which prunes its
/// Y.Doc state to a bare marker. The new session seeds from the file again.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn markdown_owner_consent_opens_a_note_whose_session_closed() {
    edit_anyway_opens_a_note_with_no_ydoc_state(true, Rename::None).await;
}

/// Edit anyway on a note renamed in dohc after its earlier local session
/// closed. The new session seeds from the file at the new path.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn markdown_owner_consent_opens_a_note_renamed_after_its_session_closed() {
    edit_anyway_opens_a_note_with_no_ydoc_state(true, Rename::InDohc).await;
}

/// Edit anyway on a note another program moved after its earlier local session
/// closed. Capture records the move, and the new session seeds from the file
/// at the new path.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn markdown_owner_consent_opens_a_note_moved_on_disk_after_its_session_closed() {
    edit_anyway_opens_a_note_with_no_ydoc_state(true, Rename::OnDisk).await;
}

#[derive(Clone, Copy, PartialEq)]
enum Rename {
    None,
    InDohc,
    OnDisk,
}

async fn edit_anyway_opens_a_note_with_no_ydoc_state(edited_before: bool, rename: Rename) {
    use base64::{Engine as _, engine::general_purpose::STANDARD};
    use dohc_engine_domain::{VersionedTextStore, WriteText};
    use dohc_engine_storage::{EngineStore, hex_sha256};
    use dohc_engine_testkit::{ScratchDir, engine_db_path};
    let scratch = ScratchDir::new().unwrap();
    let token = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    let source = "- parent\n  - child\n";
    // For the move, capture imports the note, so it tracks the file it later
    // sees disappear. The other cases write the note's head directly.
    let object = if rename == Rename::OnDisk {
        dohc_engine_domain::derive_capture_object_id("w", "main", "note.md")
    } else {
        "note".to_owned()
    };
    if rename != Rename::OnDisk {
        crate::root_binding::write_root_binding(scratch.path(), token).unwrap();
        let mut store = EngineStore::open(&engine_db_path(&scratch).unwrap(), 1).unwrap();
        store.bind_root_token(token, &NoFaults).unwrap();
        VersionedTextStore::new(&mut store)
            .ensure_main_version("w", "main", 1, &NoFaults)
            .unwrap();
        VersionedTextStore::new(&mut store)
            .write_text(
                &WriteText {
                    workspace_id: "w".into(),
                    version_id: "main".into(),
                    object_id: "note".into(),
                    path: "note.md".into(),
                    text: source.into(),
                    moment_id: "source".into(),
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
    }
    std::fs::write(scratch.path().join("note.md"), source).unwrap();
    let service = EngineService::new();
    let ctx = RequestContext::unbounded();
    let opened = service
        .workspace_open(
            &ctx,
            if rename == Rename::OnDisk {
                json!({"rootDir":scratch.path(),"workspaceId":"w"})
            } else {
                json!({"rootDir":scratch.path(),"workspaceId":"w","captureMode":"none"})
            },
        )
        .await
        .unwrap();
    let workspace: WorkspaceHandle = serde_json::from_value(opened["workspace"].clone()).unwrap();
    service
        .open(Some(&workspace))
        .unwrap()
        .actor
        .configure_reader_resolver(Arc::new(
            dohc_engine_collab::reader_resolver::ReaderResolver::new(Arc::new(
                dohc_engine_reader::Reader::new(Some(unsafe_witness_reader(&scratch))),
            )),
        ))
        .await
        .unwrap();
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(30);
    while rename == Rename::OnDisk
        && service
            .capture_flush(&ctx, Some(workspace.clone()))
            .await
            .unwrap()["settled"]
            != json!(true)
    {
        assert!(tokio::time::Instant::now() < deadline, "capture settles");
        tokio::task::yield_now().await;
    }
    if edited_before {
        let (earlier, egress) = service
            .ydoc_open(
                &ctx,
                Some(workspace.clone()),
                json!({"versionId":"main","path":"note.md","contentKind":"richdoc"}),
                1,
            )
            .await
            .unwrap();
        seed_session(&service, &workspace, &earlier, &egress.bytes, source).await;
        drop(egress);
        service
            .ydoc_close(
                &ctx,
                Some(workspace.clone()),
                json!({"sessionId":earlier["sessionId"],"settle":false}),
            )
            .await
            .unwrap();
        let reader = EngineStore::open_read_only(&engine_db_path(&scratch).unwrap()).unwrap();
        let marker =
            dohc_engine_collab::read_marker(&reader, &DocKey::new("w", "main", &object).unwrap())
                .unwrap()
                .expect("the closed session leaves its marker");
        assert_eq!(
            (marker.head_update_seq, marker.head_snapshot_seq),
            (0, 0),
            "the close pruned the note's Y.Doc state"
        );
    }
    let path = if rename == Rename::None {
        "note.md"
    } else {
        "renamed.md"
    };
    if rename != Rename::None {
        std::fs::rename(scratch.path().join("note.md"), scratch.path().join(path)).unwrap();
    }
    if rename == Rename::InDohc {
        let open = service.open(Some(&workspace)).unwrap();
        open.actor
            .versioned_text_rename(
                dohc_engine_domain::RenameTextFile {
                    workspace_id: "w".into(),
                    version_id: "main".into(),
                    from_path: "note.md".into(),
                    to_path: path.into(),
                    moment_id: "rename".into(),
                    request_id: None,
                    metadata_origin: "test".into(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: None,
                    now_ms: 3,
                },
                open.root.clone(),
                Arc::new(service.self_writes.scoped(&open.root)),
                Arc::new(NoFaults),
                dohc_engine_runtime::CancellationToken::new(),
            )
            .await
            .unwrap();
    }
    if rename == Rename::OnDisk {
        let db = engine_db_path(&scratch).unwrap();
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(30);
        loop {
            let flushed = service
                .capture_flush(&ctx, Some(workspace.clone()))
                .await
                .unwrap();
            let mut store = EngineStore::open_read_only(&db).unwrap();
            let heads = VersionedTextStore::new(&mut store);
            let old = heads.read_text("w", "main", "note.md").unwrap().is_some();
            let new = heads.read_text("w", "main", path).unwrap().is_some();
            if flushed["settled"] == json!(true) && !old && new {
                break;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "capture records the move: {flushed}, old head {old}, new head {new}"
            );
            tokio::task::yield_now().await;
        }
    }
    let refused = service
        .ydoc_open(
            &ctx,
            Some(workspace.clone()),
            json!({
                "versionId":"main","path":path,"contentKind":"richdoc",
                "allowLossySourceSha256":hex_sha256(b"another source"),
            }),
            2,
        )
        .await
        .expect_err("consent to other bytes opens nothing");
    assert_eq!(
        refused.code,
        ErrorCode::Internal,
        "the source comparison refuses, not a missing marker"
    );
    assert!(lock(&service.sessions).is_empty());
    let (opened, egress) = service
        .ydoc_open(
            &ctx,
            Some(workspace.clone()),
            json!({
                "versionId":"main","path":path,"contentKind":"richdoc",
                "allowLossySourceSha256":hex_sha256(source.as_bytes()),
            }),
            3,
        )
        .await
        .expect("Edit anyway opens a note with no Y.Doc state");
    assert_eq!(opened["seedContent"], source);
    let session_id = opened["sessionId"].as_str().unwrap().to_owned();
    let (doc, seeded) = seed_session(&service, &workspace, &opened, &egress.bytes, source).await;
    drop(egress);
    let edit = doc.richdoc_append_paragraph("Edited anyway");
    service
        .ydoc_record_update(
            &ctx,
            Some(workspace.clone()),
            Some("edit".into()),
            json!({
                "sessionId":session_id,"updateBase64":STANDARD.encode(edit),
                "expectedLineageClaimId":seeded["lineageClaimId"],
            }),
        )
        .await
        .unwrap();
    let saved = service
        .ydoc_settle(
            &ctx,
            Some(workspace.clone()),
            json!({"sessionId":session_id}),
        )
        .await
        .expect("the open's consent saves the edit");
    assert!(saved["content"].as_str().unwrap().contains("Edited anyway"));
    let grant = lock(&service.sessions)[&session_id]
        .conversion_consent
        .clone()
        .unwrap();
    assert!(grant.is_consumed(), "the save used the open's consent");
    service.workspace_close(Some(workspace)).await.unwrap();
}

/// Seed a session from the file its open returned, as the desktop does.
async fn seed_session(
    service: &EngineService,
    workspace: &WorkspaceHandle,
    opened: &Value,
    initial_update: &[u8],
    source: &str,
) -> (dohc_engine_collab::Ydoc, Value) {
    use base64::{Engine as _, engine::general_purpose::STANDARD};
    let doc = dohc_engine_collab::Ydoc::wire();
    doc.apply(initial_update).unwrap();
    let seed = doc
        .rewrite_content_to_markdown_preserving_source(
            dohc_engine_collab::ContentKind::Richdoc,
            source,
        )
        .unwrap();
    let seeded = service
        .ydoc_record_update(
            &RequestContext::unbounded(),
            Some(workspace.clone()),
            Some(format!("seed-{}", opened["sessionId"].as_str().unwrap())),
            json!({
                "sessionId":opened["sessionId"],"updateBase64":STANDARD.encode(seed),"seed":true,
                "expectedLineageClaimId":opened["lineageClaimId"],
            }),
        )
        .await
        .unwrap();
    (doc, seeded)
}
