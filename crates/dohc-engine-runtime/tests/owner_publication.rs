use dohc_engine_collab::live_update_application::*;
use dohc_engine_collab::{ContentKind, DocKey, Regime, Ydoc};
use dohc_engine_runtime::{ActorHandle, CancellationToken, WorkspaceSupervisor};
use dohc_engine_storage::{EngineStore, NoFaults, hex_sha256};
use dohc_engine_testkit::{ScratchDir, engine_db_path};
use std::{path::PathBuf, sync::Arc};

struct Fixture {
    root: ScratchDir,
    db: PathBuf,
    store: EngineStore,
    binding: dohc_engine_collab::LiveObjectBinding,
    doc: Ydoc,
    bytes: Vec<u8>,
    text: String,
}

impl Fixture {
    fn new() -> Self {
        let root = ScratchDir::new().unwrap();
        let db = engine_db_path(&root).unwrap();
        let mut store = EngineStore::open(&db, 0).unwrap();
        let source: serde_json::Value = serde_json::from_str(include_str!(
            "../../dohc-engine-collab/tests/owner-source/owner-source-seed.json"
        ))
        .unwrap();
        let text = source["markdown"].as_str().unwrap().to_owned();
        let bytes: Vec<u8> = serde_json::from_value(source["bytes"].clone()).unwrap();
        dohc_engine_domain::VersionedTextStore::new(&mut store)
            .ensure_main_version("workspace", "main", 0, &NoFaults)
            .unwrap();
        dohc_engine_domain::VersionedTextStore::new(&mut store)
            .write_text(
                &dohc_engine_domain::WriteText {
                    workspace_id: "workspace".into(),
                    version_id: "main".into(),
                    object_id: "object".into(),
                    path: "notes/owner.md".into(),
                    text: text.clone(),
                    moment_id: "original".into(),
                    metadata_origin: "api".into(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: None,
                    now_ms: 1,
                    request_id: None,
                },
                &NoFaults,
            )
            .unwrap();
        std::fs::create_dir(root.path().join("notes")).unwrap();
        std::fs::write(root.path().join("notes/owner.md"), &text).unwrap();
        let key = DocKey::new("workspace", "main", "object").unwrap();
        dohc_engine_collab::claim_base(
            &mut store,
            &key,
            ContentKind::Richdoc,
            &bytes,
            &NoFaults,
            2,
        )
        .unwrap();
        let binding = dohc_engine_collab::LiveObjectBinding {
            workspace_id: "workspace".into(),
            main_version_id: "main".into(),
            object_id: "object".into(),
            lineage_claim_id: hex_sha256(&bytes),
            current_path: "notes/owner.md".into(),
            selector_paths: vec!["notes/owner.md".into()],
            restore_fence_generation: 0,
        };
        store.write_with(&NoFaults,|tx| {
            tx.execute("UPDATE ydoc_docs SET path='notes/owner.md'",[]).unwrap();
            dohc_engine_collab::owner_base_source::retain_owner_base_source_in_tx(tx,&key,"notes/owner.md",&binding.lineage_claim_id,&dohc_engine_collab::owner_base_source::OwnerSeedSource { moment_id:"original".into(),blob_sha256:hex_sha256(text.as_bytes()) })?;
            tx.execute("INSERT INTO collections VALUES ('workspace','main','notes','notes/.collection.json','valid','[]')",[]).unwrap();
            tx.execute("INSERT INTO collection_records (workspace_id,version_id,record_id,collection_path,file_path,object_id,adoption_state) VALUES ('workspace','main','rec_00000000000000000000000000','notes','notes/owner.md','object','adopted')",[]).unwrap();
            tx.execute("INSERT INTO sync_identity (workspace_id,origin_id,replication_epoch,stream_identity,created_at_ms) VALUES ('workspace','origin','epoch','stream',1)",[]).unwrap();
            tx.execute("INSERT INTO sync_relay_push_state (workspace_id,origin_id,pushed_seq) VALUES ('workspace','origin',0)",[]).unwrap();
            Ok::<_,dohc_engine_collab::CollabError>(())
        }).unwrap();
        let doc = Ydoc::wire();
        doc.apply(&bytes).unwrap();
        Self {
            root,
            db,
            store,
            binding,
            doc,
            bytes,
            text,
        }
    }

    async fn adopt(
        &self,
        owner: &dohc_engine_runtime::actor::ActorLiveApplicationOwner,
    ) -> dohc_engine_runtime::actor::ActorLiveApplicationHandle {
        let handle = owner
            .register(
                "relay".into(),
                ApplicationHostCoordinate {
                    host_id: "host".into(),
                    host_epoch: 1,
                    instance_id: "instance".into(),
                    connection_id: "connection".into(),
                },
                self.binding.clone(),
            )
            .await
            .unwrap();
        handle
            .adopt_owner(
                OwnerAdoptionCut {
                    relay_database_namespace: "relay".into(),
                    adoption_id: "adoption".into(),
                    source_moment_id: "original".into(),
                    source_digest: hex_sha256(self.text.as_bytes()),
                    source_byte_length: self.text.len() as i64,
                    baseline_moment_relay_sequence: 1,
                    baseline_registered_at_ms: 3,
                    baseline_bytes: self.bytes.clone(),
                    expected_local_sequence: 0,
                    events: vec![],
                    terminal_receipt: None,
                    outbox_limits: dohc_engine_collab::OwnerOutboxLimits {
                        max_pending_bytes: 1_000_000,
                        max_pending_age_ms: 100_000,
                    },
                },
                1_000_000,
                100,
                Arc::new(NoFaults),
                Arc::new(()),
            )
            .await
            .unwrap();
        handle
    }

    fn counts(&self) -> Vec<i64> {
        [
            "moments",
            "replication_log",
            "collection_record_fields",
            "collection_field_history",
            "materialization_jobs",
        ]
        .map(|name| self.store.table_row_count(name).unwrap())
        .to_vec()
    }

    async fn ordinary_settle(
        &self,
        actor: &ActorHandle,
    ) -> Result<dohc_engine_runtime::actor::YdocSettleOutcome, dohc_engine_runtime::RuntimeError>
    {
        actor
            .ydoc_settle(
                self.root.path().to_owned(),
                DocKey::new("workspace", "main", "object").unwrap(),
                self.binding.current_path.clone(),
                ContentKind::Richdoc,
                Some(self.binding.lineage_claim_id.clone()),
                Some(hex_sha256(self.text.as_bytes())),
                "editor".into(),
                Arc::new(()),
                30,
                Arc::new(NoFaults),
                CancellationToken::new(),
                None,
            )
            .await
    }
}

#[tokio::test]
async fn ordinary_same_path_moment_on_adopted_owner_is_retained_and_acknowledged() {
    use dohc_engine_sync::{ApplyDisposition, NoLiveLeases, ReplicationEnvelope};
    let mut f = Fixture::new();
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&f.db, 3).unwrap().actor;
    let owner = actor
        .live_application_owner("workspace".into())
        .await
        .unwrap();
    let _handle = f.adopt(&owner).await;
    let peer_text = format!("{}\n\nordinary peer edit\n", f.text);
    let peer_digest = hex_sha256(peer_text.as_bytes());
    f.store
        .read_with(|conn| {
            conn.execute(
                "INSERT INTO blobs(sha256,byte_length,text) VALUES (?1,?2,?3)",
                rusqlite::params![peer_digest, peer_text.len() as i64, peer_text],
            )
        })
        .unwrap();
    let key = DocKey::new("workspace", "main", "object").unwrap();
    let before_native = dohc_engine_collab::load_persisted(&f.store, &key)
        .unwrap()
        .unwrap()
        .doc
        .encode_full_state();
    let before_moments = f.store.table_row_count("moments").unwrap();
    let op = ReplicationEnvelope {
        workspace_id: "workspace".into(),
        origin_id: "ordinary-peer".into(),
        origin_seq: 0,
        op_kind: "moment.append".into(),
        recorded_at_ms: 40,
        relay_seq: Some(1),
        payload: serde_json::json!({
            "momentId":"ordinary-peer-edit", "versionId":"main", "objectId":"object",
            "objectCreatedAtMs":1, "path":f.binding.current_path, "recordedAtMs":40,
            "operation":"write", "payloadBeforeBlobSha256":hex_sha256(f.text.as_bytes()),
            "payloadBeforePath":f.binding.current_path, "payloadAfterBlobSha256":peer_digest,
            "payloadAfterPath":f.binding.current_path, "metadata":{"origin":"sync"},
            "beforePresent":"present", "beforeObjectId":"object", "beforeVersionId":"main",
            "beforePath":f.binding.current_path, "beforeBlobSha256":hex_sha256(f.text.as_bytes()),
            "beforeUpdatedAtMs":1, "beforeLatestMomentId":"original", "beforeMetadata":{"origin":"api"}
        }),
    };
    let mut cache = dohc_engine_collab::WriterDocCache::new();
    let applied = dohc_engine_sync::apply_replication_envelope(
        &mut f.store,
        &mut cache,
        &op,
        &NoFaults,
        &NoLiveLeases,
    )
    .expect("an ordinary peer edit must not wedge the adopted owner's cursor");
    let ApplyDisposition::Refused(refusal) = applied.primary else {
        panic!("expected retained binding refusal")
    };
    assert_eq!(
        refusal.reason.message(),
        "live document binding is still active"
    );
    assert_eq!(
        dohc_engine_sync::read_replication_acked_seq(&f.store, "workspace", "ordinary-peer")
            .unwrap(),
        0
    );
    assert_eq!(f.store.table_row_count("moments").unwrap(), before_moments);
    assert_eq!(
        dohc_engine_collab::load_persisted(&f.store, &key)
            .unwrap()
            .unwrap()
            .doc
            .encode_full_state(),
        before_native
    );
    let retained: String = f.store.read_with(|conn| conn.query_row(
        "SELECT text_sha256 FROM replication_refused_moment_blobs WHERE workspace_id='workspace' AND origin_id='ordinary-peer' AND origin_seq=0 AND role='payload-after'",
        [], |row| row.get(0),
    )).unwrap();
    assert_eq!(retained, peer_digest);
    assert_eq!(
        dohc_engine_sync::apply_replication_envelope(
            &mut f.store,
            &mut cache,
            &op,
            &NoFaults,
            &NoLiveLeases
        )
        .unwrap()
        .primary,
        ApplyDisposition::Skipped
    );
}

#[tokio::test]
async fn configured_pending_edits_do_not_escape_through_ordinary_index_journal_or_settlement() {
    let f = Fixture::new();
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&f.db, 3).unwrap().actor;
    let owner = actor
        .live_application_owner("workspace".into())
        .await
        .unwrap();
    let handle = f.adopt(&owner).await;
    let before = f.counts();
    let update = f.doc.frontmatter_set("status", "pending-only");
    let appended = actor
        .ydoc_record_update(
            DocKey::new("workspace", "main", "object").unwrap(),
            f.binding.current_path.clone(),
            ContentKind::Richdoc,
            Regime::Replicated,
            update.clone(),
            Some("owner-origin".into()),
            None,
            Some(f.binding.lineage_claim_id.clone()),
            false,
            None,
            Some("owner-edit".into()),
            20,
            Arc::new(NoFaults),
            CancellationToken::new(),
            None,
        )
        .await
        .unwrap();
    assert!(!appended.outcome.emit_outbound);
    assert!(appended.outcome.record_facts.is_none());
    assert!(appended.automation_claims.is_empty());
    assert_eq!(f.counts(), before);
    let refused = f.ordinary_settle(&actor).await.err().unwrap();
    assert_eq!(refused.code(), "owner-outbox-frozen");
    assert_eq!(f.counts(), before);
    assert_eq!(
        std::fs::read_to_string(f.root.path().join(&f.binding.current_path)).unwrap(),
        f.text
    );
    assert!(
        handle
            .settle(
                None,
                100,
                f.root.path().to_owned(),
                30,
                Arc::new(NoFaults),
                CancellationToken::new(),
                Arc::new(())
            )
            .await
            .is_err()
    );
    let (outbox,delivery,digest):(String,String,String)=f.store.read_with(|conn|conn.query_row("SELECT outbox_id,delivery_id,update_digest FROM owner_ydoc_outbox_entries WHERE pending=1",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?)))).unwrap();
    let receipt = LiveUpdateReceipt {
        delivery_id: delivery.clone(),
        update_digest: digest.clone(),
        journal_cursor: 7,
        accepting_host_epoch: 1,
    };
    let applied = handle
        .apply(
            AdmittedLiveUpdate {
                metadata: AdmittedLiveUpdateMetadata {
                    accepted: RelayAcceptedLiveUpdate {
                        receipt: receipt.clone(),
                        binding: f.binding.clone(),
                        authority: ServerDerivedLiveUpdateAuthority::Owner {
                            principal_id: "owner".into(),
                        },
                        received_at_ms: 21,
                    },
                    first_seen: vec![],
                },
                update_bytes: update,
            },
            Arc::new(NoFaults),
            100_000_000,
        )
        .await
        .unwrap();
    assert!(matches!(applied, ApplicationResult::Applied(_)));
    actor
        .owner_ydoc_outbox_acknowledge(
            "workspace".into(),
            outbox,
            vec![dohc_engine_collab::OwnerDeliveryReceipt {
                delivery_id: delivery,
                update_digest: digest,
                journal_cursor: 7,
                accepting_host_epoch: 1,
            }],
            CancellationToken::new(),
        )
        .await
        .unwrap()
        .unwrap();
    let settled = handle
        .settle(
            Some(receipt),
            100,
            f.root.path().to_owned(),
            30,
            Arc::new(NoFaults),
            CancellationToken::new(),
            Arc::new(()),
        )
        .await
        .unwrap();
    assert!(settled.materialized);
    assert_eq!(
        std::fs::read_to_string(f.root.path().join(&f.binding.current_path)).unwrap(),
        f.doc.project(ContentKind::Richdoc).unwrap().content
    );
    owner.close().await.unwrap();
    supervisor.close_all().unwrap();
}

#[tokio::test]
async fn observed_owner_cannot_use_ordinary_runtime_settlement() {
    let mut f = Fixture::new();
    let checkpoint = f.doc.encode_full_state();
    let observed = dohc_engine_collab::owner_outbox::draft::ObservedOwnerBinding {
        binding: f.binding.clone(),
        relay_database_namespace: "relay".into(),
        revision: 1,
        accepted_cursor: 0,
        native_head_sequence: 0,
        checkpoint_digest: hex_sha256(&checkpoint),
        limits: dohc_engine_collab::OwnerOutboxLimits {
            max_pending_bytes: 1_000_000,
            max_pending_age_ms: 100_000,
        },
    };
    f.store
        .write_with(&NoFaults, |tx| {
            dohc_engine_collab::owner_outbox::draft::install_observed_binding_in_tx(
                tx,
                "workspace",
                &observed,
                &checkpoint,
            )
        })
        .unwrap();
    let before = f.counts();
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&f.db, 3).unwrap().actor;
    assert_eq!(
        f.ordinary_settle(&actor).await.err().unwrap().code(),
        "owner-outbox-frozen"
    );
    assert_eq!(f.counts(), before);
    assert_eq!(
        std::fs::read_to_string(f.root.path().join(&f.binding.current_path)).unwrap(),
        f.text
    );
    supervisor.close_all().unwrap();
}

#[tokio::test]
async fn enrolled_owner_keeps_its_lineage_when_an_old_conflict_is_resolved_after_editor_close() {
    use dohc_engine_collab::owner_outbox::enrollment::{
        OwnerEnrollmentInput, capture_in, enroll_in_tx,
    };
    use dohc_engine_domain::{
        ConflictChoice, ConflictFileState, ConflictMetadata, ConflictStatus, ResolveConflictKind,
        ResolveTextConflict, TextConflict, VersionedTextStore,
    };
    let mut f = Fixture::new();
    let current = VersionedTextStore::new(&mut f.store)
        .read_text("workspace", "main", &f.binding.current_path)
        .unwrap()
        .unwrap();
    let mut incoming = current.clone();
    incoming.version_id = "incoming-version".into();
    incoming.object_id = "incoming-object".into();
    incoming.text = "Incoming peer edit".into();
    incoming.blob_sha256 = hex_sha256(incoming.text.as_bytes());
    incoming.latest_moment_id = "incoming-moment".into();
    incoming.updated_at_ms = 3;
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&f.db, 3).unwrap().actor;
    actor
        .conflict_open(
            Box::new(TextConflict {
                conflict_id: "before-enrollment".into(),
                workspace_id: "workspace".into(),
                path: current.path.clone(),
                target_version_id: "main".into(),
                source_version_id: "incoming-version".into(),
                created_at_ms: 3,
                updated_at_ms: 3,
                status: ConflictStatus::Open,
                chosen_from: ConflictChoice::Current,
                resolution: None,
                metadata: ConflictMetadata::origin("sync"),
                base: ConflictFileState::text(&current.path, None),
                current: ConflictFileState::text(&current.path, Some(current.clone())),
                incoming: ConflictFileState::text(&current.path, Some(incoming)),
            }),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    let key = DocKey::new("workspace", "main", "object").unwrap();
    let leases = dohc_engine_collab::LeaseRegistry::new();
    let editor = leases.acquire(&key).unwrap();
    let input = OwnerEnrollmentInput {
        binding: f.binding.clone(),
        relay_database_namespace: "relay".into(),
        captured: f
            .store
            .read_with(|conn| capture_in(conn, &f.binding))
            .unwrap(),
        journal_cursor: 0,
        checkpoint: f.doc.encode_full_state(),
        host_vector: f.doc.encode_state_vector(),
    };
    f.store
        .write_with(&NoFaults, |tx| {
            enroll_in_tx(
                tx,
                "workspace",
                &input,
                &dohc_engine_collab::OwnerOutboxLimits {
                    max_pending_bytes: 1_000_000,
                    max_pending_age_ms: 100_000,
                },
                4,
            )
        })
        .unwrap();
    drop(editor);
    let before_counts = f.counts();
    let state = || {
        f.store
            .read_with(|conn| {
                [
                    "conflicts",
                    "ydoc_docs",
                    "ydoc_owner_bindings",
                    "owner_ydoc_outboxes",
                    "owner_ydoc_outbox_entries",
                    "binary_blobs",
                ]
                .into_iter()
                .map(|table| {
                    let mut stmt =
                        conn.prepare(&format!("SELECT * FROM {table} ORDER BY rowid"))?;
                    let columns = stmt.column_count();
                    stmt.query_map([], |row| {
                        (0..columns)
                            .map(|i| row.get::<_, rusqlite::types::Value>(i))
                            .collect::<Result<Vec<_>, _>>()
                    })?
                    .collect::<Result<Vec<_>, _>>()
                })
                .collect::<Result<Vec<_>, rusqlite::Error>>()
            })
            .unwrap()
    };
    let before_state = state();
    let before_native = dohc_engine_collab::load_persisted(&f.store, &key)
        .unwrap()
        .unwrap()
        .doc
        .encode_full_state();
    let refusal = actor
        .conflict_resolve(
            ResolveTextConflict {
                workspace_id: "workspace".into(),
                conflict_id: "before-enrollment".into(),
                resolution: ResolveConflictKind::KeepCurrent,
                object_id: "resolution-object".into(),
                write_moment_id: "resolution-write".into(),
                delete_moment_id: "resolution-delete".into(),
                metadata_origin: "api".into(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 5,
                request_id: Some("resolve-after-close".into()),
                conflict_answer_budget_bytes: usize::MAX,
            },
            leases,
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect_err("durable owner binding survives editor closure");
    assert_eq!(refusal.code(), "live-document-binding-active");
    assert_eq!(f.counts(), before_counts);
    assert_eq!(state(), before_state);
    assert_eq!(
        dohc_engine_collab::load_persisted(&f.store, &key)
            .unwrap()
            .unwrap()
            .doc
            .encode_full_state(),
        before_native
    );
    assert_eq!(
        std::fs::read_to_string(f.root.path().join(&f.binding.current_path)).unwrap(),
        f.text
    );
    supervisor.close_all().unwrap();
}
