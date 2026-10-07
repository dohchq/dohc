use dohc_engine_collab::live_update_application::*;
use dohc_engine_collab::{ContentKind, DocKey, Regime, Ydoc};
use dohc_engine_domain::{AgentDeclaration, ChangeActorKind, ChangeAttribution};
use dohc_engine_runtime::{ActorHandle, CancellationToken, WorkspaceSupervisor};
use dohc_engine_storage::{EngineStore, NoFaults, hex_sha256};
use dohc_engine_testkit::{ScratchDir, engine_db_path};
use std::{path::PathBuf, sync::Arc};

struct Fixture {
    db: PathBuf,
    store: EngineStore,
    binding: dohc_engine_collab::LiveObjectBinding,
    doc: Ydoc,
    bytes: Vec<u8>,
    text: String,
    root: ScratchDir,
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
        self.adopt_at(owner, 0).await
    }

    async fn adopt_at(
        &self,
        owner: &dohc_engine_runtime::actor::ActorLiveApplicationOwner,
        expected_local_sequence: i64,
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
                    expected_local_sequence,
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

    async fn record(&self, actor: &ActorHandle, update: Vec<u8>, request: &str, now_ms: i64) {
        actor
            .ydoc_record_update(
                DocKey::new("workspace", "main", "object").unwrap(),
                self.binding.current_path.clone(),
                ContentKind::Richdoc,
                Regime::Replicated,
                update,
                Some("owner-origin".into()),
                None,
                Some(self.binding.lineage_claim_id.clone()),
                false,
                None,
                Some(request.into()),
                now_ms,
                Arc::new(NoFaults),
                CancellationToken::new(),
                None,
            )
            .await
            .unwrap();
    }

    /// A native edit by `origin` with `attribution`, as an agent's session records it.
    async fn record_by(
        &self,
        actor: &ActorHandle,
        update: Vec<u8>,
        request: &str,
        now_ms: i64,
        origin: &str,
        attribution: ChangeAttribution,
    ) {
        actor
            .ydoc_record_update(
                DocKey::new("workspace", "main", "object").unwrap(),
                self.binding.current_path.clone(),
                ContentKind::Richdoc,
                Regime::Replicated,
                update,
                Some(origin.into()),
                Some(attribution),
                Some(self.binding.lineage_claim_id.clone()),
                false,
                None,
                Some(request.into()),
                now_ms,
                Arc::new(NoFaults),
                CancellationToken::new(),
                None,
            )
            .await
            .unwrap();
    }

    async fn settle(
        &self,
        handle: &dohc_engine_runtime::actor::ActorLiveApplicationHandle,
        terminal: Option<LiveUpdateReceipt>,
    ) -> LiveSettlementResult {
        handle
            .settle(
                terminal,
                100,
                self.root.path().to_owned(),
                30,
                Arc::new(NoFaults),
                CancellationToken::new(),
                dohc_engine_collab::live_update_application::AdmittedNativeHistoryReconstruction {
                    policy:
                        dohc_engine_collab::live_update_application::NativeHistoryReconstruction {
                            working_reserve_bytes: 8 * 1024 * 1024,
                        },
                    reservation: Arc::new(()),
                },
            )
            .await
            .unwrap()
    }

    fn file(&self) -> String {
        std::fs::read_to_string(self.root.path().join(&self.binding.current_path)).unwrap()
    }

    fn moment_authors(&self, moment: &str) -> Vec<serde_json::Value> {
        let json: Option<String> = self
            .store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT author_json FROM moments WHERE moment_id=?1",
                    [moment],
                    |r| r.get(0),
                )
            })
            .unwrap();
        json.map_or_else(Vec::new, |json| serde_json::from_str(&json).unwrap())
    }

    /// The relay accepts the oldest pending owner entry at `cursor`, then the owner ACKs it.
    async fn accept_pending(
        &self,
        actor: &ActorHandle,
        handle: &dohc_engine_runtime::actor::ActorLiveApplicationHandle,
        cursor: i64,
    ) -> LiveUpdateReceipt {
        let (outbox, delivery, digest, declaration): (String, String, String, Option<String>) = self
            .store
            .read_with(|conn| conn.query_row(
                "SELECT outbox_id,delivery_id,update_digest,agent_declaration_json FROM owner_ydoc_outbox_entries WHERE pending=1 ORDER BY sequence LIMIT 1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            ))
            .unwrap();
        // The relay accepts exactly what the entry declared.
        let agent_declaration =
            declaration.map(|json| serde_json::from_str::<AgentDeclaration>(&json).unwrap());
        let receipt = LiveUpdateReceipt {
            delivery_id: delivery.clone(),
            update_digest: digest.clone(),
            journal_cursor: cursor,
            accepting_host_epoch: 1,
        };
        let applied = handle
            .apply(
                AdmittedLiveUpdate {
                    metadata: AdmittedLiveUpdateMetadata {
                        accepted: RelayAcceptedLiveUpdate {
                            receipt: receipt.clone(),
                            binding: self.binding.clone(),
                            authority: ServerDerivedLiveUpdateAuthority::Owner {
                                principal_id: "owner".into(),
                            },
                            received_at_ms: 20 + cursor,
                        },
                        first_seen: vec![],

                canonical_version: Some(2),

                author_snapshot: Some((agent_declaration).into_iter().map(dohc_engine_collab::live_update_application::LiveAuthorEntry::from).collect()),

                first_seen_deletes: Some(vec![]),

                checkpoint_coverage: None,
},
                    update_bytes: self.store.get_binary_blob(&digest).unwrap().unwrap(),
                },
                Arc::new(NoFaults),
                100_000_000,
            )
            .await
            .unwrap();
        assert!(matches!(applied, ApplicationResult::Applied(..)));
        actor
            .owner_ydoc_outbox_acknowledge(
                "workspace".into(),
                outbox,
                vec![dohc_engine_collab::OwnerDeliveryReceipt {
                    delivery_id: delivery,
                    update_digest: digest,
                    journal_cursor: cursor,
                    accepting_host_epoch: 1,
                }],
                CancellationToken::new(),
            )
            .await
            .unwrap()
            .unwrap();
        receipt
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

/// An agent as large as the declaration contract allows: escaped quotes fill
/// its author entry.
fn large_agent(index: usize) -> AgentDeclaration {
    AgentDeclaration {
        agent_id: format!("{index:03}{}", "\"".repeat(509)),
        on_behalf_of: Some("\"".repeat(512)),
        depth: 1,
    }
}

/// A collaborator agent's accepted delivery of `bytes` at `cursor`.
async fn deliver_declared(
    handle: &dohc_engine_runtime::actor::ActorLiveApplicationHandle,
    binding: &dohc_engine_collab::LiveObjectBinding,
    cursor: i64,
    bytes: &[u8],
    declaration: AgentDeclaration,
) -> (LiveUpdateReceipt, ApplicationResult) {
    let receipt = LiveUpdateReceipt {
        delivery_id: format!("remote-{cursor}"),
        update_digest: hex_sha256(bytes),
        journal_cursor: cursor,
        accepting_host_epoch: 1,
    };
    let result = handle
        .apply(
            AdmittedLiveUpdate {
                metadata: AdmittedLiveUpdateMetadata {
                    accepted: RelayAcceptedLiveUpdate {
                        receipt: receipt.clone(),
                        binding: binding.clone(),
                        authority: ServerDerivedLiveUpdateAuthority::Owner {
                            principal_id: "owner".into(),
                        },
                        received_at_ms: 20 + cursor,
                    },
                    first_seen: vec![],

                    canonical_version: Some(2),

                    author_snapshot: Some(
                        (Some(declaration))
                            .into_iter()
                            .map(dohc_engine_collab::live_update_application::LiveAuthorEntry::from)
                            .collect(),
                    ),

                    first_seen_deletes: Some(vec![]),

                    checkpoint_coverage: None,
                },
                update_bytes: bytes.to_vec(),
            },
            Arc::new(NoFaults),
            100_000_000,
        )
        .await
        .unwrap();
    (receipt, result)
}

struct PrefixRival {
    path: PathBuf,
    fired: std::sync::atomic::AtomicBool,
}
impl dohc_engine_storage::FaultInjector for PrefixRival {
    fn poll(&self, point: dohc_engine_storage::FaultPoint) -> dohc_engine_storage::FaultAction {
        if point == dohc_engine_storage::FaultPoint::MaterializeBeforePreimageRevalidate
            && !self.fired.swap(true, std::sync::atomic::Ordering::SeqCst)
        {
            std::fs::write(&self.path, "rival survives").unwrap();
        }
        dohc_engine_storage::FaultAction::Continue
    }
}

/// The owner's own agent edit waits in its outbox while declared deliveries
/// fill the interval's author bound. The accepted prefix settles without the
/// private edit. After another private edit, a lost acknowledgement, and a
/// restart, the same terminal replays that settlement instead of minting a
/// new one. The refused delivery then applies, and the private edit's own
/// acceptance names its trusted agent in the next moment.
#[tokio::test]
async fn accepted_prefix_settles_past_a_private_tail_at_author_capacity() {
    let started = std::time::Instant::now();
    let mark = |phase| {
        if std::env::var_os("DOHC_RUST_PROFILE").is_some() {
            eprintln!(
                "RUST_PROFILE publication {phase} {:.3}s",
                started.elapsed().as_secs_f64()
            );
        }
    };
    const LOCAL: &str = "Private local paragraph";
    const SECOND: &str = "Second private paragraph";
    const REMOTE: &str = "Remote agent paragraph";
    let mut f = Fixture::new();
    f.binding
        .selector_paths
        .extend((0..99).map(|i| format!("z{i:02}{}", "x".repeat(1020))));
    f.binding.selector_paths.sort();
    f.binding.validate_canonical().unwrap();
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&f.db, 3).unwrap().actor;
    let owner = actor
        .live_application_owner("workspace".into())
        .await
        .unwrap();
    let handle = f.adopt(&owner).await;
    let local_agent = ChangeAttribution {
        actor_kind: ChangeActorKind::Agent,
        on_behalf_of: Some("owner".into()),
        depth: 1,
        run: None,
    };
    f.record_by(
        &actor,
        f.doc.richdoc_append_paragraph(LOCAL),
        "local",
        20,
        "local-agent",
        local_agent.clone(),
    )
    .await;
    // The outbox entry declares the agent its native row recorded. It is no
    // enrolled draft.
    let local_entry: (Option<String>, Option<i64>) = f
        .store
        .read_with(|conn| {
            conn.query_row(
                "SELECT agent_declaration_json,draft_binding_revision FROM owner_ydoc_outbox_entries WHERE pending=1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
        })
        .unwrap();
    assert_eq!(
        local_entry,
        (
            Some(r#"{"agentId":"local-agent","onBehalfOf":"owner","depth":1}"#.into()),
            None
        )
    );
    // A collaborator's paragraph, concurrent with the private edit. Every
    // delivery after the first carries its bytes again.
    let remote = Ydoc::wire();
    remote.apply(&f.bytes).unwrap();
    let remote_bytes = remote.richdoc_append_paragraph(REMOTE);
    f.doc.apply(&remote_bytes).unwrap();
    // Keep each settlement interval inside the configured maximum while the
    // accepted checkpoint segment accumulates discarded metadata above60MiB.
    mark("fixture-private-edit");
    const PREFIX: i64 = 700;
    let mut accepted_head = None;
    for cursor in 1..=PREFIX {
        let (receipt, result) =
            deliver_declared(&handle, &f.binding, cursor, &remote_bytes, large_agent(999)).await;
        assert!(matches!(result, ApplicationResult::Applied(..)));
        if cursor % 100 == 0 {
            mark("periodic-settlement-start");
            let settled = f.settle(&handle, Some(receipt)).await;
            assert!(!f.file().contains(LOCAL));
            assert!(f.file().contains(REMOTE));
            mark("periodic-settlement-complete");
            let moments = f.store.table_row_count("moments").unwrap();
            if let Some((moment, count)) = &accepted_head {
                assert_eq!(
                    &settled.moment_id, moment,
                    "unchanged accepted projection made another moment"
                );
                assert_eq!(
                    moments, *count,
                    "unchanged accepted projection added a moment"
                );
            } else {
                accepted_head = Some((settled.moment_id, moments));
            }
        }
    }
    mark("ingress-with-periodic-settlement");
    let metadata: i64 = f
        .store
        .read_with(|conn| {
            conn.query_row(
                "SELECT sum(length(CAST(metadata_json AS BLOB))) FROM live_accepted_updates",
                [],
                |r| r.get(0),
            )
        })
        .unwrap();
    assert!(metadata > 60 * 1024 * 1024);
    let remote_bytes = remote.richdoc_append_paragraph("Capacity remote paragraph");
    f.doc.apply(&remote_bytes).unwrap();
    let mut admitted = 0;
    let mut terminal = None;
    let refused = loop {
        assert!(admitted < 80, "the author bound never refused");
        let cursor = PREFIX + admitted as i64 + 1;
        let (receipt, result) = deliver_declared(
            &handle,
            &f.binding,
            cursor,
            &remote_bytes,
            large_agent(admitted),
        )
        .await;
        match result {
            ApplicationResult::Applied(..) => {
                terminal = Some(receipt);
                admitted += 1;
            }
            ApplicationResult::Pending(ApplicationPending::SettlementRequired) => break cursor,
            other => panic!("unexpected {other:?}"),
        }
    };
    assert!(admitted > 1);
    mark("fill-capacity");

    // The private edit's native sequence has no application. Settling the
    // accepted prefix leaves it out of the file and the moment.
    let moments = f.store.table_row_count("moments").unwrap();
    let preimage = f.file();
    assert!(
        handle
            .settle(
                terminal.clone(),
                100,
                f.root.path().to_owned(),
                30,
                Arc::new(PrefixRival {
                    path: f.root.path().join(&f.binding.current_path),
                    fired: std::sync::atomic::AtomicBool::new(false)
                }),
                CancellationToken::new(),
                AdmittedNativeHistoryReconstruction {
                    policy: NativeHistoryReconstruction {
                        working_reserve_bytes: 8 * 1024 * 1024
                    },
                    reservation: Arc::new(())
                }
            )
            .await
            .is_err()
    );
    assert_eq!(f.file(), "rival survives");
    let native = dohc_engine_collab::load_persisted(
        &f.store,
        &DocKey::new("workspace", "main", "object").unwrap(),
    )
    .unwrap()
    .unwrap()
    .doc;
    assert!(
        native
            .project(ContentKind::Richdoc)
            .unwrap()
            .content
            .contains(LOCAL)
    );
    mark("rival-refusal");
    std::fs::write(f.root.path().join(&f.binding.current_path), preimage).unwrap();
    let settled = f.settle(&handle, terminal.clone()).await;
    assert!(settled.materialized);
    assert!(f.file().contains(REMOTE));
    assert!(!f.file().contains(LOCAL));
    assert_eq!(f.store.table_row_count("moments").unwrap(), moments + 1);
    let authors = f.moment_authors(&settled.moment_id);
    assert_eq!(authors.len(), admitted);
    assert!(
        authors
            .iter()
            .all(|author| author["agentId"] != "local-agent")
    );
    let (head, boundary): (i64, Option<i64>) = f
        .store
        .read_with(|conn| {
            conn.query_row(
                "SELECT head_update_seq,settled_update_seq FROM ydoc_docs",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
        })
        .unwrap();
    assert_eq!(settled.local_ydoc_sequence, head);
    assert!(
        boundary.is_none_or(|boundary| boundary < head),
        "the file lacks the private edit"
    );

    mark("rescue");
    // Another private edit, then a restart before the acknowledgement reached
    // the relay. The same terminal replays the same settlement.
    f.record_by(
        &actor,
        f.doc.richdoc_append_paragraph(SECOND),
        "second",
        40,
        "local-agent",
        local_agent,
    )
    .await;
    drop(handle);
    owner.close().await.unwrap();
    supervisor.close_all().unwrap();
    dohc_engine_collab::maybe_compact(
        &mut f.store,
        &DocKey::new("workspace", "main", "object").unwrap(),
        0,
        &NoFaults,
        41,
    )
    .unwrap();
    let native = dohc_engine_collab::load_persisted(
        &f.store,
        &DocKey::new("workspace", "main", "object").unwrap(),
    )
    .unwrap()
    .unwrap()
    .doc;
    let native_text = native.project(ContentKind::Richdoc).unwrap().content;
    assert!(native_text.contains(LOCAL));
    assert!(native_text.contains(SECOND));
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&f.db, 4).unwrap().actor;
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
    mark("restart");
    let replayed = f.settle(&handle, terminal).await;
    assert_eq!(replayed.settlement_id, settled.settlement_id);
    assert_eq!(replayed.local_ydoc_sequence, settled.local_ydoc_sequence);
    assert_eq!(replayed.moment_id, settled.moment_id);
    assert_eq!(f.store.table_row_count("moments").unwrap(), moments + 1);
    assert!(!f.file().contains(LOCAL));

    mark("ack-replay");
    // The refused delivery applies once the interval is free.
    let (_, retried) = deliver_declared(
        &handle,
        &f.binding,
        refused,
        &remote_bytes,
        large_agent(admitted),
    )
    .await;
    assert!(matches!(retried, ApplicationResult::Applied(..)));
    // The private edit's own acceptance names its trusted agent. The second
    // private edit still waits, so the next moment holds accepted content.
    let accepted = f.accept_pending(&actor, &handle, refused + 1).await;
    let next = f.settle(&handle, Some(accepted)).await;
    assert!(next.materialized);
    assert_eq!(next.application_count, 2);
    assert!(f.file().contains(LOCAL));
    assert!(!f.file().contains(SECOND));
    let mut named: Vec<String> = f
        .moment_authors(&next.moment_id)
        .iter()
        .map(|author| author["agentId"].as_str().unwrap().to_owned())
        .collect();
    named.sort();
    let mut expected = vec![large_agent(admitted).agent_id, "local-agent".to_owned()];
    expected.sort();
    assert_eq!(named, expected);
    owner.close().await.unwrap();
    supervisor.close_all().unwrap();
    mark("complete");
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
    let update = f.doc.frontmatter_set("status", "pending-only").unwrap();
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
    // A live settlement covers only the accepted prefix: the pending edit
    // stays out of the file.
    let prefix = handle
        .settle(
            None,
            100,
            f.root.path().to_owned(),
            30,
            Arc::new(NoFaults),
            CancellationToken::new(),
            dohc_engine_collab::live_update_application::AdmittedNativeHistoryReconstruction {
                policy: dohc_engine_collab::live_update_application::NativeHistoryReconstruction {
                    working_reserve_bytes: 8 * 1024 * 1024,
                },
                reservation: Arc::new(()),
            },
        )
        .await
        .unwrap();
    assert_eq!(prefix.application_count, 0);
    assert!(
        !std::fs::read_to_string(f.root.path().join(&f.binding.current_path))
            .unwrap()
            .contains("pending-only")
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
                    canonical_version: Some(2),
                    author_snapshot: Some(vec![]),
                    first_seen_deletes: Some(vec![]),
                    checkpoint_coverage: None,
                },
                update_bytes: update,
            },
            Arc::new(NoFaults),
            100_000_000,
        )
        .await
        .unwrap();
    assert!(matches!(applied, ApplicationResult::Applied(..)));
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
            dohc_engine_collab::live_update_application::AdmittedNativeHistoryReconstruction {
                policy: dohc_engine_collab::live_update_application::NativeHistoryReconstruction {
                    working_reserve_bytes: 8 * 1024 * 1024,
                },
                reservation: Arc::new(()),
            },
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

/// The host's pre-live head is an imported projection: base, then H1 alone,
/// then H1 with A1. Activation adopts that head and the accepted seed already
/// projects to it, so the first audited settlement changes no text. It must
/// still not republish the head moment's H1-only before-image.
#[tokio::test]
async fn first_audited_settlement_publishes_its_own_moment_over_an_imported_prelive_head() {
    use dohc_engine_storage::StorageError;
    use dohc_engine_sync::{
        ApplyDisposition, NoLiveLeases, ReplicationEnvelope, apply_replication_envelope,
        owner_publication_prefix,
    };
    let root = ScratchDir::new().unwrap();
    let db = engine_db_path(&root).unwrap();
    let mut store = EngineStore::open(&db, 0).unwrap();
    let path = "notes/plan.md";
    let key = DocKey::new("workspace", "main", "object").unwrap();
    let source: serde_json::Value = serde_json::from_str(include_str!(
        "../../dohc-engine-collab/tests/owner-source/owner-source-seed.json"
    ))
    .unwrap();
    let base: Vec<u8> = serde_json::from_value(source["bytes"].clone()).unwrap();
    let lineage = hex_sha256(&base);
    let doc = Ydoc::wire();
    doc.apply(&base).unwrap();
    let human = doc.richdoc_append_paragraph("Human first edit.");
    let agent = doc.richdoc_append_paragraph("Agent revised this line.");
    dohc_engine_domain::VersionedTextStore::new(&mut store)
        .ensure_main_version("workspace", "main", 0, &NoFaults)
        .unwrap();
    store
        .write_with(&NoFaults, |tx| {
            for sql in [
                "INSERT INTO sync_identity (workspace_id,origin_id,replication_epoch,stream_identity,created_at_ms) VALUES ('workspace','origin','epoch','stream',1)",
                "INSERT INTO sync_relay_push_state (workspace_id,origin_id,pushed_seq) VALUES ('workspace','origin',0)",
                "INSERT INTO sync_relay_cursors (workspace_id,cursor,replication_epoch,stream_identity) VALUES ('workspace','3','epoch','stream')",
            ] {
                tx.execute(sql, []).map_err(StorageError::persist_public)?;
            }
            Ok::<_, StorageError>(())
        })
        .unwrap();
    // A peer's ordinary edits arrive before sharing; each import writes its
    // own native projection moment.
    let mut cache = dohc_engine_collab::WriterDocCache::new();
    for (seq, update, is_base) in [(0, &base, true), (1, &human, false), (2, &agent, false)] {
        let digest = store.put_binary_blob(update).unwrap();
        let op = ReplicationEnvelope {
            workspace_id: "workspace".into(),
            origin_id: "owner-peer".into(),
            origin_seq: seq,
            relay_seq: Some(seq + 1),
            op_kind: "ydoc.update".into(),
            payload: serde_json::json!({
                "versionId":"main", "objectId":"object", "path":path, "contentKind":"richdoc",
                "updateBlobSha256":digest, "lineageClaimId":lineage, "isBaseState":is_base
            }),
            recorded_at_ms: 10 + seq,
        };
        let applied =
            apply_replication_envelope(&mut store, &mut cache, &op, &NoFaults, &NoLiveLeases)
                .unwrap();
        assert!(!matches!(applied.primary, ApplyDisposition::Refused(_)));
    }
    let head = dohc_engine_domain::VersionedTextStore::new(&mut store)
        .read_text("workspace", "main", path)
        .unwrap()
        .unwrap();
    assert!(head.latest_moment_id.starts_with("moment-ydoc-apply-"));
    let human_only: String = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT before_blob_sha256 FROM moments WHERE moment_id=?1",
                [&head.latest_moment_id],
                |row| row.get(0),
            )
        })
        .unwrap();
    let human_moment: String = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT moment_id FROM moments WHERE after_blob_sha256=?1",
                [&human_only],
                |row| row.get(0),
            )
        })
        .unwrap();
    assert!(human_moment.starts_with("moment-ydoc-apply-"));
    let journaled = |store: &EngineStore, sql: &str, value: &str| -> i64 {
        store
            .read_with(|conn| conn.query_row(sql, [value], |row| row.get(0)))
            .unwrap()
    };
    let by_moment = "SELECT count(*) FROM replication_log WHERE op_kind='moment.append' AND json_extract(payload_json,'$.momentId')=?1";
    let by_digest = "SELECT count(*) FROM replication_log WHERE op_kind='moment.append' AND instr(payload_json,?1)>0";
    assert_eq!(journaled(&store, by_moment, &head.latest_moment_id), 0);

    std::fs::create_dir(root.path().join("notes")).unwrap();
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 3).unwrap().actor;
    actor
        .materialize_replay_pending(root.path().to_owned(), "workspace".into(), 20)
        .await
        .unwrap();
    assert_eq!(
        std::fs::read_to_string(root.path().join(path)).unwrap(),
        head.text
    );
    let captured = actor
        .capture_imported_owner_activation(
            "relay".into(),
            key,
            path.into(),
            1_000_000,
            None,
            CancellationToken::new(),
            Arc::new(()),
        )
        .await
        .unwrap();
    assert_eq!(captured.source.source_moment_id, head.latest_moment_id);
    let binding = dohc_engine_collab::LiveObjectBinding {
        workspace_id: "workspace".into(),
        main_version_id: "main".into(),
        object_id: "object".into(),
        lineage_claim_id: lineage.clone(),
        current_path: path.into(),
        selector_paths: vec![path.into()],
        restore_fence_generation: 0,
    };
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
            binding.clone(),
        )
        .await
        .unwrap();
    handle
        .adopt_owner(
            OwnerAdoptionCut {
                relay_database_namespace: "relay".into(),
                adoption_id: captured.activation_id.clone(),
                source_moment_id: captured.source.source_moment_id.clone(),
                source_digest: captured.source.source_digest.clone(),
                source_byte_length: captured.source.source_byte_length,
                baseline_moment_relay_sequence: 1,
                baseline_registered_at_ms: 3,
                baseline_bytes: captured.baseline_bytes.clone(),
                expected_local_sequence: captured.source.native_head_sequence,
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
    // Adoption queues the activation state as the owner's seed delivery.
    let (outbox, delivery, digest): (String, String, String) = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT outbox_id,delivery_id,update_digest FROM owner_ydoc_outbox_entries WHERE pending=1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
        })
        .unwrap();
    assert_eq!(digest, hex_sha256(&captured.full_state));
    let receipt = LiveUpdateReceipt {
        delivery_id: delivery.clone(),
        update_digest: digest.clone(),
        journal_cursor: 1,
        accepting_host_epoch: 1,
    };
    let applied = handle
        .apply(
            AdmittedLiveUpdate {
                metadata: AdmittedLiveUpdateMetadata {
                    accepted: RelayAcceptedLiveUpdate {
                        receipt: receipt.clone(),
                        binding: binding.clone(),
                        authority: ServerDerivedLiveUpdateAuthority::Owner {
                            principal_id: "owner".into(),
                        },
                        received_at_ms: 21,
                    },
                    first_seen: vec![],

                    canonical_version: Some(2),

                    author_snapshot: Some(vec![]),

                    first_seen_deletes: Some(vec![]),

                    checkpoint_coverage: None,
                },
                update_bytes: captured.full_state.clone(),
            },
            Arc::new(NoFaults),
            100_000_000,
        )
        .await
        .unwrap();
    assert!(matches!(applied, ApplicationResult::Applied(..)));
    actor
        .owner_ydoc_outbox_acknowledge(
            "workspace".into(),
            outbox,
            vec![dohc_engine_collab::OwnerDeliveryReceipt {
                delivery_id: delivery,
                update_digest: digest,
                journal_cursor: 1,
                accepting_host_epoch: 1,
            }],
            CancellationToken::new(),
        )
        .await
        .unwrap()
        .unwrap();
    let settle = || {
        handle.settle(
            Some(receipt.clone()),
            100,
            root.path().to_owned(),
            30,
            Arc::new(NoFaults),
            CancellationToken::new(),
            dohc_engine_collab::live_update_application::AdmittedNativeHistoryReconstruction {
                policy: dohc_engine_collab::live_update_application::NativeHistoryReconstruction {
                    working_reserve_bytes: 8 * 1024 * 1024,
                },
                reservation: Arc::new(()),
            },
        )
    };
    let settled = settle().await.unwrap();
    assert_eq!(settled.markdown_digest, head.blob_sha256);
    assert_ne!(settled.moment_id, head.latest_moment_id);
    assert_eq!(journaled(&store, by_digest, &human_only), 0);

    let (origin_id, origin_seq, recorded_at_ms, payload): (String, i64, i64, String) = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT origin_id,origin_seq,recorded_at_ms,payload_json FROM replication_log WHERE imported=0 AND op_kind='moment.append' AND json_extract(payload_json,'$.momentId')=?1",
                [&settled.moment_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
        })
        .unwrap();
    let published = ReplicationEnvelope {
        workspace_id: "workspace".into(),
        origin_id,
        origin_seq,
        op_kind: "moment.append".into(),
        recorded_at_ms,
        relay_seq: None,
        payload: serde_json::from_str(&payload).unwrap(),
    };
    assert_eq!(
        published.payload["payloadBeforeBlobSha256"],
        serde_json::json!(head.blob_sha256)
    );
    let allowed = |op: &ReplicationEnvelope| {
        owner_publication_prefix(&store, "workspace", std::slice::from_ref(op), 1_000_000)
            .unwrap()
            .allowed_ops
    };
    assert_eq!(allowed(&published), 1);
    // The H1-only state was never accepted, so it remains unpublishable.
    let mut historical = published.clone();
    historical.payload["payloadBeforeBlobSha256"] = serde_json::json!(human_only);
    historical.payload["beforeBlobSha256"] = serde_json::json!(human_only);
    assert_eq!(allowed(&historical), 0);

    let counts = |store: &EngineStore| {
        [
            "moments",
            "replication_log",
            "materialization_jobs",
            "live_device_settlements",
        ]
        .map(|table| store.table_row_count(table).unwrap())
    };
    let before = counts(&store);
    let again = settle().await.unwrap();
    assert_eq!(
        (again.settlement_id, again.moment_id),
        (settled.settlement_id, settled.moment_id)
    );
    assert_eq!(counts(&store), before);
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
        recovery: false,
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

/// The owner settles a private draft H1 locally before the device host adopts
/// the document, optionally replaces it with unsettled H2, and the relay
/// accepts the adoption seed and a later edit H3. The first live settlement's
/// local moment keeps H1 -> H3 for rollback. Its published companion names the
/// adopted source H0 instead, so H1 never reaches the relay's history.
async fn first_owner_settlement_publishes_the_adopted_source(replace_draft_before_adoption: bool) {
    use dohc_engine_sync::{ReplicationEnvelope, owner_publication_prefix};
    const SENTINEL: &str = "Private draft sentinel 7f3c9a, never shared.";
    let mut f = Fixture::new();
    let key = DocKey::new("workspace", "main", "object").unwrap();
    let path = f.binding.current_path.clone();
    let source = hex_sha256(f.text.as_bytes());
    let projection = |doc: &Ydoc| doc.project(ContentKind::Richdoc).unwrap().content;
    let allowed = |store: &EngineStore, op: &ReplicationEnvelope| {
        owner_publication_prefix(store, "workspace", std::slice::from_ref(op), 1_000_000)
            .unwrap()
            .allowed_ops
    };
    let journaled = |store: &EngineStore, kind: &str, id: &str| -> (String, i64, String) {
        store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT origin_id,origin_seq,payload_json FROM replication_log WHERE imported=0 AND op_kind=?1 AND (json_extract(payload_json,'$.momentId')=?2 OR json_extract(payload_json,'$.record.settlementId')=?2)",
                    [kind, id],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
            })
            .unwrap()
    };
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&f.db, 3).unwrap().actor;

    // H1: a private draft settles locally.
    f.record(
        &actor,
        f.doc.richdoc_append_paragraph(SENTINEL),
        "draft",
        10,
    )
    .await;
    f.ordinary_settle(&actor).await.unwrap();
    let draft_text = projection(&f.doc);
    let draft = hex_sha256(draft_text.as_bytes());
    assert!(draft_text.contains(SENTINEL));
    assert_eq!(
        std::fs::read_to_string(f.root.path().join(&path)).unwrap(),
        draft_text
    );
    let draft_moment: String = f
        .store
        .read_with(|conn| {
            conn.query_row(
                "SELECT moment_id FROM moments WHERE after_blob_sha256=?1",
                [&draft],
                |r| r.get(0),
            )
        })
        .unwrap();
    if replace_draft_before_adoption {
        // H2 deletes the sentinel and is never settled before adoption.
        let replaced = format!("{}\nOwner work that replaced the private draft.\n", f.text);
        f.record(
            &actor,
            f.doc
                .rewrite_content_to_markdown(ContentKind::Richdoc, &replaced)
                .unwrap(),
            "replace-draft",
            20,
        )
        .await;
        assert!(!projection(&f.doc).contains(SENTINEL));
    }

    // Adoption seeds the full local state; the relay accepts it, then H3.
    let head: i64 = f
        .store
        .read_with(|conn| conn.query_row("SELECT head_update_seq FROM ydoc_docs", [], |r| r.get(0)))
        .unwrap();
    let owner = actor
        .live_application_owner("workspace".into())
        .await
        .unwrap();
    let handle = f.adopt_at(&owner, head).await;
    f.accept_pending(&actor, &handle, 1).await;
    f.record(
        &actor,
        f.doc.richdoc_append_paragraph("Accepted owner edit."),
        "accepted-edit",
        30,
    )
    .await;
    let receipt = f.accept_pending(&actor, &handle, 2).await;
    let settle = || {
        handle.settle(
            Some(receipt.clone()),
            100,
            f.root.path().to_owned(),
            30,
            Arc::new(NoFaults),
            CancellationToken::new(),
            dohc_engine_collab::live_update_application::AdmittedNativeHistoryReconstruction {
                policy: dohc_engine_collab::live_update_application::NativeHistoryReconstruction {
                    working_reserve_bytes: 8 * 1024 * 1024,
                },
                reservation: Arc::new(()),
            },
        )
    };
    let settled = settle().await.unwrap();
    assert!(settled.materialized);

    // The local moment keeps the actual rollback preimage H1.
    let local = |store: &EngineStore| -> (String, String) {
        store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT before_blob_sha256,before_latest_moment_id FROM moments WHERE moment_id=?1",
                    [&settled.moment_id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
            })
            .unwrap()
    };
    assert_eq!(local(&f.store), (draft.clone(), draft_moment.clone()));

    // The published companion names the adopted source H0 for every before field.
    let (source_recorded_at, source_origin): (i64, String) = f
        .store
        .read_with(|conn| {
            conn.query_row(
                "SELECT recorded_at_ms,metadata_origin FROM moments WHERE moment_id='original'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
        })
        .unwrap();
    assert_eq!(source_origin, "api");
    let (moment_origin, moment_seq, moment_json) =
        journaled(&f.store, "moment.append", &settled.moment_id);
    let payload: serde_json::Value = serde_json::from_str(&moment_json).unwrap();
    let length = f.text.len() as i64;
    for (field, expected) in [
        ("payloadBeforePath", serde_json::json!(path)),
        ("payloadBeforeContentKind", serde_json::json!("text")),
        ("payloadBeforeBlobSha256", serde_json::json!(source)),
        ("payloadBeforeByteLength", serde_json::json!(length)),
        ("beforePresent", serde_json::json!("present")),
        ("beforeObjectId", serde_json::json!("object")),
        ("beforeVersionId", serde_json::json!("main")),
        ("beforePath", serde_json::json!(path)),
        ("beforeBlobSha256", serde_json::json!(source)),
        ("beforeContentKind", serde_json::json!("text")),
        ("beforeByteLength", serde_json::json!(length)),
        ("beforeUpdatedAtMs", serde_json::json!(source_recorded_at)),
        ("beforeLatestMomentId", serde_json::json!("original")),
        (
            "beforeMetadata",
            serde_json::json!({"origin": "api", "summary": null, "correlationId": null}),
        ),
        ("momentId", serde_json::json!(settled.moment_id)),
        (
            "payloadAfterBlobSha256",
            serde_json::json!(settled.markdown_digest),
        ),
    ] {
        assert_eq!(payload[field], expected, "{field}");
    }
    assert!(!moment_json.contains(&draft));
    assert!(!moment_json.contains(&draft_moment));
    assert!(!moment_json.contains(SENTINEL));

    // The audit and its moment sit at consecutive native origin coordinates.
    let (audit_origin, audit_seq, audit_json) =
        journaled(&f.store, "live.audit.settlement", &settled.settlement_id);
    let audit: serde_json::Value = serde_json::from_str(&audit_json).unwrap();
    assert_eq!(
        audit["record"]["momentId"],
        serde_json::json!(settled.moment_id)
    );
    assert_eq!(
        audit["record"]["markdownDigest"],
        serde_json::json!(settled.markdown_digest)
    );
    assert_eq!(audit["record"]["previousCursor"], serde_json::json!(0));
    assert_eq!(audit["record"]["terminalCursor"], serde_json::json!(2));
    let publication: (String, i64) = f
        .store
        .read_with(|conn| {
            conn.query_row(
                "SELECT origin_id,origin_seq FROM live_audit_settlement_publications WHERE settlement_id=?1",
                [&settled.settlement_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
        })
        .unwrap();
    assert_eq!(publication, (audit_origin.clone(), audit_seq));
    assert_eq!(
        (moment_origin.clone(), moment_seq),
        (audit_origin, audit_seq + 1)
    );

    let published = ReplicationEnvelope {
        workspace_id: "workspace".into(),
        origin_id: moment_origin,
        origin_seq: moment_seq,
        op_kind: "moment.append".into(),
        recorded_at_ms: payload["recordedAtMs"].as_i64().unwrap(),
        relay_seq: None,
        payload: payload.clone(),
    };
    assert_eq!(allowed(&f.store, &published), 1);
    // The H1 envelope the old projection would have published stays refused.
    let mut leaked = published.clone();
    leaked.payload["payloadBeforeBlobSha256"] = serde_json::json!(draft);
    leaked.payload["beforeBlobSha256"] = serde_json::json!(draft);
    assert_eq!(allowed(&f.store, &leaked), 0);

    // Replaying the settlement journals nothing new.
    let rows = f.store.table_row_count("replication_log").unwrap();
    let again = settle().await.unwrap();
    assert_eq!(
        (again.settlement_id, again.moment_id),
        (settled.settlement_id.clone(), settled.moment_id.clone())
    );
    assert_eq!(f.store.table_row_count("replication_log").unwrap(), rows);

    // A later private tail stays refused.
    f.record(
        &actor,
        f.doc.richdoc_append_paragraph("Private tail."),
        "private-tail",
        50,
    )
    .await;
    let mut tail = published.clone();
    let tail_digest = hex_sha256(projection(&f.doc).as_bytes());
    tail.payload["payloadBeforeBlobSha256"] = serde_json::json!(tail_digest);
    tail.payload["beforeBlobSha256"] = serde_json::json!(tail_digest);
    assert_eq!(allowed(&f.store, &tail), 0);
    assert_eq!(allowed(&f.store, &published), 1);

    // Closing the owner fences publication; compaction and a restart keep the
    // journaled envelope and the local preimage.
    owner.close().await.unwrap();
    supervisor.close_all().unwrap();
    let compacted =
        dohc_engine_collab::maybe_compact(&mut f.store, &key, 0, &NoFaults, 60).unwrap();
    assert!(matches!(
        compacted,
        dohc_engine_storage::TxnOutcome::Committed(
            dohc_engine_collab::CompactOutcome::Compacted { .. }
        )
    ));
    let reopened = EngineStore::open(&f.db, 0).unwrap();
    assert_eq!(allowed(&reopened, &published), 0);
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&f.db, 3).unwrap().actor;
    let owner = actor
        .live_application_owner("workspace".into())
        .await
        .unwrap();
    let _registered = owner
        .register(
            "relay".into(),
            ApplicationHostCoordinate {
                host_id: "host".into(),
                host_epoch: 1,
                instance_id: "restarted".into(),
                connection_id: "reconnected".into(),
            },
            f.binding.clone(),
        )
        .await
        .unwrap();
    assert_eq!(allowed(&reopened, &published), 1);
    assert_eq!(allowed(&reopened, &leaked), 0);
    assert_eq!(allowed(&reopened, &tail), 0);
    assert_eq!(
        journaled(&reopened, "moment.append", &settled.moment_id).2,
        moment_json
    );
    assert_eq!(local(&reopened), (draft.clone(), draft_moment));
    let preimage: String = reopened
        .read_with(|conn| {
            conn.query_row("SELECT text FROM blobs WHERE sha256=?1", [&draft], |r| {
                r.get(0)
            })
        })
        .unwrap();
    assert_eq!(preimage, draft_text);
    owner.close().await.unwrap();
    supervisor.close_all().unwrap();
}

#[tokio::test]
async fn first_owner_settlement_publishes_the_adopted_source_over_a_settled_seed_head() {
    first_owner_settlement_publishes_the_adopted_source(false).await;
}

#[tokio::test]
async fn first_owner_settlement_publishes_the_adopted_source_over_a_replaced_draft() {
    first_owner_settlement_publishes_the_adopted_source(true).await;
}
