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
                    metadata_origin: "test".into(),
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
async fn configured_pending_edits_do_not_escape_through_ordinary_index_journal_or_settlement() {
    let f = Fixture::new();
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&f.db, 3).unwrap().actor;
    let owner = actor
        .live_application_owner("workspace".into())
        .await
        .unwrap();
    let handle = owner
        .register(
            "relay".into(),
            ApplicationHostCoordinate {
                host_id: "host".into(),
                host_epoch: 1,
                instance_id: "instance".into(),
                connection_id: "connection".into(),
            },
            f.binding.clone(),
        )
        .await
        .unwrap();
    handle
        .adopt_owner(
            OwnerAdoptionCut {
                relay_database_namespace: "relay".into(),
                adoption_id: "adoption".into(),
                source_moment_id: "original".into(),
                source_digest: hex_sha256(f.text.as_bytes()),
                source_byte_length: f.text.len() as i64,
                baseline_moment_relay_sequence: 1,
                baseline_registered_at_ms: 3,
                baseline_bytes: f.bytes.clone(),
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
