mod support;

use dohc_engine_collab::live_update_application::*;
use dohc_engine_collab::owner_outbox::release::{MAX_RELEASE_BYTES, MAX_RELEASE_ENTRIES};
use dohc_engine_collab::{ContentKind, DocKey, Regime, Ydoc};
use dohc_engine_domain::{AgentDeclaration, ChangeActorKind, ChangeAttribution};
use dohc_engine_runtime::{ActorHandle, CancellationToken, WorkspaceSupervisor};
use dohc_engine_storage::{EngineStore, NoFaults, hex_sha256};
use dohc_engine_testkit::{ScratchDir, engine_db_path};
use std::{path::PathBuf, sync::Arc};

fn adoption_reconstruction() -> NativeHistoryReconstruction {
    NativeHistoryReconstruction {
        working_reserve_bytes: 8 * 1024 * 1024,
    }
}

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
        Self::with_size(0)
    }

    fn with_size(size: usize) -> Self {
        Self::with_source(size, false)
    }

    fn with_source(size: usize, canonical: bool) -> Self {
        let source: serde_json::Value = serde_json::from_str(include_str!(
            "../../dohc-engine-collab/tests/owner-source/owner-source-seed.json"
        ))
        .unwrap();
        let mut text = source[if canonical { "canonical" } else { "markdown" }]
            .as_str()
            .unwrap()
            .to_owned();
        let mut bytes: Vec<u8> = serde_json::from_value(source["bytes"].clone()).unwrap();
        if canonical {
            let doc = Ydoc::wire();
            doc.rewrite_content_to_markdown(ContentKind::Richdoc, &text)
                .unwrap();
            bytes = doc.encode_full_state();
        }
        if size > 0 {
            let doc = Ydoc::wire();
            doc.apply(&bytes).unwrap();
            doc.richdoc_append_paragraph(&"x".repeat(size));
            text = doc.project(ContentKind::Richdoc).unwrap().content;
            bytes = doc.encode_full_state();
        }
        Self::with_seed(text, bytes)
    }

    fn with_seed(text: String, bytes: Vec<u8>) -> Self {
        let root = ScratchDir::new().unwrap();
        let db = engine_db_path(&root).unwrap();
        let mut store = EngineStore::open(&db, 0).unwrap();
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
            dohc_engine_collab::owner_base_source::retain_owner_base_source_in_tx(tx,&key,"notes/owner.md",&binding.lineage_claim_id,&dohc_engine_collab::owner_base_source::OwnerSeedSource { moment_id:"original".into(),blob_sha256:hex_sha256(text.as_bytes()) }, None)?;
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
        self.adopt_cut(owner, self.cut(expected_local_sequence, vec![], None))
            .await
    }

    fn cut(
        &self,
        expected_local_sequence: i64,
        events: Vec<AdmittedLiveUpdate>,
        terminal_receipt: Option<LiveUpdateReceipt>,
    ) -> OwnerAdoptionCut {
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
            events,
            terminal_receipt,
            retained_prefix: None,
            reconstruction: adoption_reconstruction(),
            outbox_limits: dohc_engine_collab::OwnerOutboxLimits {
                max_pending_bytes: 1_000_000,
                max_pending_age_ms: 100_000,
            },
        }
    }

    async fn adopt_cut(
        &self,
        owner: &dohc_engine_runtime::actor::ActorLiveApplicationOwner,
        cut: OwnerAdoptionCut,
    ) -> dohc_engine_runtime::actor::ActorLiveApplicationHandle {
        let handle = self.register(owner, "instance").await;
        handle
            .adopt_owner(cut, 1_000_000, 100, Arc::new(NoFaults), Arc::new(()))
            .await
            .unwrap();
        handle
    }

    async fn register(
        &self,
        owner: &dohc_engine_runtime::actor::ActorLiveApplicationOwner,
        instance: &str,
    ) -> dohc_engine_runtime::actor::ActorLiveApplicationHandle {
        owner
            .register(
                "relay".into(),
                ApplicationHostCoordinate {
                    host_id: "host".into(),
                    host_epoch: 1,
                    instance_id: instance.into(),
                    connection_id: "connection".into(),
                },
                self.binding.clone(),
            )
            .await
            .unwrap()
    }

    /// The relay accepted an owner edit at `cursor` and the outbox drained
    /// before the handover. The edit can preserve the projected Markdown.
    fn edit_accepted_before_handover(
        &mut self,
        cursor: i64,
        changes_content: bool,
    ) -> OwnerAdoptionCut {
        self.edit_accepted_before_handover_with_source(cursor, changes_content, false)
    }

    fn edit_accepted_before_handover_with_source(
        &mut self,
        cursor: i64,
        changes_content: bool,
        preserved_source: bool,
    ) -> OwnerAdoptionCut {
        self.doc
            .rewrite_content_to_markdown(ContentKind::Richdoc, "owner edit")
            .unwrap();
        if !changes_content {
            self.doc
                .rewrite_content_to_markdown(ContentKind::Richdoc, &self.text)
                .unwrap();
        }
        if preserved_source {
            let source = if changes_content {
                "# Shared\n\nChanged together.\n"
            } else {
                &self.text
            };
            self.doc
                .rewrite_content_to_markdown_preserving_source(ContentKind::Richdoc, source)
                .unwrap();
        }
        let update = self.doc.encode_full_state();
        self.accepted_handover_update(cursor, update)
    }

    fn accepted_handover_update(&mut self, cursor: i64, update: Vec<u8>) -> OwnerAdoptionCut {
        let key = DocKey::new("workspace", "main", "object").unwrap();
        let limits = dohc_engine_collab::OwnerOutboxLimits {
            max_pending_bytes: 1_000_000,
            max_pending_age_ms: 100_000,
        };
        let dohc_engine_storage::TxnOutcome::Committed(recorded) =
            dohc_engine_collab::record_local_update(
                &mut self.store,
                &mut dohc_engine_collab::WriterDocCache::new(),
                &key,
                &update,
                dohc_engine_collab::LocalAppend::default(),
                &NoFaults,
                4,
                |_, _, _| Ok(()),
            )
            .unwrap()
        else {
            panic!("record crash")
        };
        let entry = dohc_engine_collab::append_owner_outbox(
            &mut self.store,
            "workspace",
            dohc_engine_collab::OwnerOutboxAppendInput {
                binding: self.binding.clone(),
                base_update: self.bytes.clone(),
                append_key: "edit".into(),
                update: update.clone(),
                limits,
                created_at_ms: 4,
            },
        )
        .unwrap();
        let receipt = LiveUpdateReceipt {
            delivery_id: entry.delivery_id.clone(),
            update_digest: entry.update_digest.clone(),
            journal_cursor: cursor,
            accepting_host_epoch: 1,
        };
        dohc_engine_collab::acknowledge_owner_outbox(
            &mut self.store,
            "workspace",
            &entry.outbox_id,
            &[dohc_engine_collab::OwnerDeliveryReceipt {
                delivery_id: entry.delivery_id,
                update_digest: entry.update_digest,
                journal_cursor: cursor,
                accepting_host_epoch: 1,
            }],
        )
        .unwrap();
        let event = AdmittedLiveUpdate {
            metadata: AdmittedLiveUpdateMetadata {
                accepted: RelayAcceptedLiveUpdate {
                    receipt: receipt.clone(),
                    binding: self.binding.clone(),
                    authority: ServerDerivedLiveUpdateAuthority::Owner {
                        principal_id: "owner".into(),
                    },
                    received_at_ms: 4,
                },
                first_seen: vec![],
                canonical_version: None,
                author_snapshot: None,
                first_seen_deletes: None,
                checkpoint_coverage: None,
            },
            update_bytes: update,
        };
        self.cut(recorded.seq, vec![event], Some(receipt))
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
        self.settle_with_limit(handle, terminal, 100).await
    }

    async fn settle_with_limit(
        &self,
        handle: &dohc_engine_runtime::actor::ActorLiveApplicationHandle,
        terminal: Option<LiveUpdateReceipt>,
        max_applications: usize,
    ) -> LiveSettlementResult {
        handle
            .settle(
                terminal,
                max_applications,
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
        self.ordinary_settle_with_faults(actor, Arc::new(NoFaults))
            .await
    }

    async fn ordinary_settle_with_faults(
        &self,
        actor: &ActorHandle,
        faults: Arc<dyn dohc_engine_storage::FaultInjector>,
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
                faults,
                CancellationToken::new(),
                None,
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
    support::configure_witness_reader(&actor, &f.root).await;
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
    // accepted checkpoint segment accumulates large discarded metadata.
    mark("fixture-private-edit");
    // Twice the settlements' 8 MiB working reserve, so none can hold the segment.
    const LARGE_HISTORY_BYTES: i64 = 16 * 1024 * 1024;
    const PREFIX: i64 = 200;
    let mut accepted_head = None;
    for cursor in 1..=PREFIX {
        let (receipt, result) =
            deliver_declared(&handle, &f.binding, cursor, &remote_bytes, large_agent(999)).await;
        assert!(matches!(result, ApplicationResult::Applied(..)));
        if cursor % 100 == 0 {
            mark("periodic-settlement-start");
            let settled = f.settle(&handle, Some(receipt)).await;
            assert_eq!(settled.application_count, 100);
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
    assert!(metadata > LARGE_HISTORY_BYTES);
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
    assert!(settled.local_ydoc_sequence < head);
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
    support::configure_witness_reader(&actor, &f.root).await;
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
async fn projection_neutral_settlements_keep_the_application_interval_bounded() {
    let mut f = Fixture::new();
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&f.db, 3).unwrap().actor;
    support::configure_witness_reader(&actor, &f.root).await;
    let owner = actor
        .live_application_owner("workspace".into())
        .await
        .unwrap();
    let handle = f.adopt(&owner).await;
    let attribution = ChangeAttribution {
        actor_kind: ChangeActorKind::Agent,
        on_behalf_of: Some("owner".into()),
        depth: 1,
        run: None,
    };
    f.record_by(
        &actor,
        f.doc.richdoc_append_paragraph("Accepted baseline"),
        "first",
        10,
        "first-agent",
        attribution.clone(),
    )
    .await;
    let receipt = f.accept_pending(&actor, &handle, 1).await;
    let first = f.settle_with_limit(&handle, Some(receipt), 1).await;
    let mut latest = first.clone();
    for cursor in 2..=5 {
        let same = f
            .doc
            .rewrite_content_to_markdown(ContentKind::Richdoc, &f.file())
            .unwrap();
        f.record_by(
            &actor,
            same,
            &format!("neutral-{cursor}"),
            10 + cursor,
            "neutral-agent",
            attribution.clone(),
        )
        .await;
        let receipt = f.accept_pending(&actor, &handle, cursor).await;
        latest = f.settle_with_limit(&handle, Some(receipt), 1).await;
        assert_eq!(latest.previous_cursor, cursor - 1);
        assert_eq!(latest.application_count, 1);
        assert_eq!(latest.moment_id, first.moment_id);
    }
    // A mark naming a later reused settlement cannot refuse the original publisher.
    f.store.write_with(&NoFaults, |tx| {
        tx.execute("INSERT INTO live_settlement_attribution_unavailable(workspace_id,moment_id,settlement_id,reason) VALUES (?1,?2,?3,'terminal-owner-source')",
            rusqlite::params!["workspace",first.moment_id,latest.settlement_id])
            .map_err(dohc_engine_storage::StorageError::persist_public)?;
        Ok::<_,dohc_engine_storage::StorageError>(())
    }).unwrap();
    f.record_by(
        &actor,
        f.doc.richdoc_append_paragraph("Visible later edit"),
        "visible",
        30,
        "visible-agent",
        attribution,
    )
    .await;
    let receipt = f.accept_pending(&actor, &handle, 6).await;
    let next = f.settle_with_limit(&handle, Some(receipt), 1).await;
    assert_eq!(next.previous_cursor, 5);
    assert_eq!(next.application_count, 1);
    assert!(f.file().contains("Visible later edit"));
    let authors = f.moment_authors(&next.moment_id);
    assert_eq!(
        authors
            .iter()
            .map(|author| author["agentId"].as_str())
            .collect::<Vec<_>>(),
        vec![Some("visible-agent")]
    );
    owner.close().await.unwrap();
    supervisor.close_all().unwrap();
}

#[tokio::test]
async fn ordinary_same_path_moment_on_adopted_owner_is_retained_and_acknowledged() {
    use dohc_engine_sync::{ApplyDisposition, NoLiveLeases, ReplicationEnvelope};
    let mut f = Fixture::new();
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&f.db, 3).unwrap().actor;
    support::configure_witness_reader(&actor, &f.root).await;
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
        settlement_admission: None,
        admitted_author_snapshot: None,
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
    let applied = settled_apply(&mut f.store, &mut cache, &op, &NoFaults, &NoLiveLeases)
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
        settled_apply(&mut f.store, &mut cache, &op, &NoFaults, &NoLiveLeases)
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
    support::configure_witness_reader(&actor, &f.root).await;
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
    cache.reader_resolver = Some(Arc::new(
        dohc_engine_collab::reader_resolver::ReaderResolver::new(Arc::new(
            dohc_engine_reader::Reader::new(Some(support::fake_reader(&root, "witness-safe"))),
        )),
    ));
    for (seq, update, is_base) in [(0, &base, true), (1, &human, false), (2, &agent, false)] {
        let digest = store.put_binary_blob(update).unwrap();
        let op = ReplicationEnvelope {
            settlement_admission: None,
            admitted_author_snapshot: None,
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
        let applied = loop {
            match apply_replication_envelope(&mut store, &mut cache, &op, &NoFaults, &NoLiveLeases)
            {
                Ok(applied) => break applied,
                Err(dohc_engine_sync::SyncError::MarkdownWitnessCheckPending {
                    pending, ..
                }) => {
                    pending.resolve().await;
                }
                Err(error) => panic!("{error:?}"),
            }
        };
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
                retained_prefix: None,
                outbox_limits: dohc_engine_collab::OwnerOutboxLimits {
                    max_pending_bytes: 1_000_000,
                    max_pending_age_ms: 100_000,
                },
                reconstruction: adoption_reconstruction(),
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
        settlement_admission: None,
        admitted_author_snapshot: None,
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
        serde_json::json!(hex_sha256(source["markdown"].as_str().unwrap().as_bytes()))
    );
    let local_before: String = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT before_blob_sha256 FROM moments WHERE moment_id=?1",
                [&settled.moment_id],
                |r| r.get(0),
            )
        })
        .unwrap();
    assert_eq!(local_before, head.blob_sha256);
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
    support::configure_witness_reader(&actor, &f.root).await;
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
    support::configure_witness_reader(&actor, &f.root).await;
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
    support::configure_witness_reader(&actor, &f.root).await;

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
    let (audit_origin, audit_seq, audit_json) = journaled(
        &f.store,
        "live.audit.settlement",
        settled.settlement_id.as_deref().unwrap(),
    );
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
        settlement_admission: None,
        admitted_author_snapshot: None,
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
    support::configure_witness_reader(&actor, &f.root).await;
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

#[tokio::test]
async fn terminal_native_seed_publishes_only_accepted_content_and_unblocks_ordinary_work() {
    use dohc_engine_sync::{ReplicationEnvelope, owner_publication_prefix};
    let mut f = Fixture::new();
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&f.db, 3).unwrap().actor;
    support::configure_witness_reader(&actor, &f.root).await;
    f.record(
        &actor,
        f.doc.richdoc_append_paragraph("Private refused seed"),
        "private",
        10,
    )
    .await;
    f.ordinary_settle(&actor).await.unwrap();
    let head: i64 = f
        .store
        .read_with(|conn| conn.query_row("SELECT head_update_seq FROM ydoc_docs", [], |r| r.get(0)))
        .unwrap();
    let owner = actor
        .live_application_owner("workspace".into())
        .await
        .unwrap();
    let handle = f.adopt_at(&owner, head).await;
    let settle = |terminal| {
        handle.settle(
            terminal,
            100,
            f.root.path().to_owned(),
            30,
            Arc::new(NoFaults),
            CancellationToken::new(),
            AdmittedNativeHistoryReconstruction {
                policy: NativeHistoryReconstruction {
                    working_reserve_bytes: 8 * 1024 * 1024,
                },
                reservation: Arc::new(()),
            },
        )
    };
    // A real pending seed remains retryable and cannot publish its private bytes.
    assert!(settle(None).await.is_err());
    let input = f.store.read_with(|conn| conn.query_row("SELECT outbox_id,delivery_id,update_digest FROM owner_ydoc_outbox_entries WHERE pending=1", [], |r| Ok(dohc_engine_collab::owner_outbox::OwnerOutboxRefuseInput {
        outbox_id:r.get(0)?, delivery_id:r.get(1)?, update_digest:r.get(2)?, reason:"terminal-source-refused".into()
    }))).unwrap();
    let refused_digest = input.update_digest.clone();
    actor
        .owner_ydoc_refuse_entry(
            "workspace".into(),
            input,
            12,
            CancellationToken::new(),
            Arc::new(()),
        )
        .await
        .unwrap()
        .unwrap();
    let remote = Ydoc::wire();
    remote.apply(&f.bytes).unwrap();
    let bytes = remote.richdoc_append_paragraph("Accepted collaborator work");
    let (receipt, _) = deliver_declared(
        &handle,
        &f.binding,
        1,
        &bytes,
        AgentDeclaration {
            agent_id: "accepted-agent".into(),
            on_behalf_of: Some("owner".into()),
            depth: 1,
        },
    )
    .await;
    let result = settle(Some(receipt.clone())).await.unwrap();
    assert!(!f.file().contains("Private refused seed"));
    assert!(f.file().contains("Accepted collaborator work"));
    let op = f.store.read_with(|conn| conn.query_row("SELECT origin_id,origin_seq,payload_json,recorded_at_ms FROM replication_log WHERE imported=0 AND op_kind='moment.append' AND json_extract(payload_json,'$.momentId')=?1", [&result.moment_id], |r| Ok(ReplicationEnvelope {
        workspace_id:"workspace".into(), origin_id:r.get(0)?, origin_seq:r.get(1)?, relay_seq:None, op_kind:"moment.append".into(), payload:serde_json::from_str(&r.get::<_,String>(2)?).unwrap(), recorded_at_ms:r.get(3)?, settlement_admission:None, admitted_author_snapshot:None
    }))).unwrap();
    assert_eq!(
        op.payload["attributionUnavailable"]["reason"],
        "terminal-owner-source"
    );
    assert!(op.payload.get("authors").is_none());
    assert!(op.payload.get("settlementReference").is_none());
    assert_eq!(
        op.payload["payloadBeforeBlobSha256"],
        hex_sha256(f.text.as_bytes())
    );
    assert_eq!(
        owner_publication_prefix(&f.store, "workspace", std::slice::from_ref(&op), 1_000_000)
            .unwrap()
            .allowed_ops,
        1
    );
    let mut unaccepted = op.clone();
    unaccepted.payload["payloadBeforeBlobSha256"] =
        serde_json::json!(hex_sha256(b"Unaccepted content"));
    assert_eq!(
        owner_publication_prefix(&f.store, "workspace", &[unaccepted], 1_000_000)
            .unwrap()
            .allowed_ops,
        0
    );
    assert_eq!(
        f.store
            .table_row_count("live_settlement_publication_states")
            .unwrap(),
        0
    );
    assert_eq!(
        f.store
            .table_row_count("replication_pending_refusals")
            .unwrap(),
        1
    );
    assert!(f.moment_authors(&result.moment_id).is_empty());
    assert!(f.store.get_binary_blob(&refused_digest).unwrap().is_some());
    let counts = f.counts();
    assert_eq!(
        settle(Some(receipt)).await.unwrap().settlement_id,
        result.settlement_id
    );
    assert_eq!(f.counts(), counts);
    assert_eq!(
        f.store
            .table_row_count("replication_pending_refusals")
            .unwrap(),
        1
    );
    let next = remote.richdoc_append_paragraph("Later accepted work");
    let (next_receipt, _) = deliver_declared(
        &handle,
        &f.binding,
        2,
        &next,
        AgentDeclaration {
            agent_id: "later-agent".into(),
            on_behalf_of: Some("owner".into()),
            depth: 1,
        },
    )
    .await;
    let next_result = settle(Some(next_receipt)).await.unwrap();
    assert_eq!(next_result.previous_cursor, 0);
    assert_eq!(next_result.terminal_cursor, 2);
    let next_payload: serde_json::Value = f.store.read_with(|conn|conn.query_row("SELECT payload_json FROM replication_log WHERE op_kind='moment.append' AND json_extract(payload_json,'$.momentId')=?1",[&next_result.moment_id],|r|r.get::<_,String>(0))).map(|s|serde_json::from_str(&s).unwrap()).unwrap();
    assert_eq!(
        next_payload["settlementReference"]["record"]["previousCursor"],
        0
    );
    assert_eq!(
        next_payload["payloadBeforeBlobSha256"],
        hex_sha256(f.text.as_bytes())
    );
    assert!(next_payload.get("attributionUnavailable").is_none());
    assert!(next_payload.get("authors").is_none()); // relay supplies canonical attribution
    assert_eq!(
        f.store
            .table_row_count("live_settlement_publication_states")
            .unwrap(),
        1
    );
    assert!(!f.file().contains("Private refused seed"));
    // An unrelated ordinary operation uses the unchanged publication gate.
    dohc_engine_domain::VersionedTextStore::new(&mut f.store)
        .write_text(
            &dohc_engine_domain::WriteText {
                workspace_id: "workspace".into(),
                version_id: "main".into(),
                object_id: "other".into(),
                path: "other.md".into(),
                text: "Ordinary later work".into(),
                moment_id: "later".into(),
                metadata_origin: "api".into(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 40,
                request_id: None,
            },
            &NoFaults,
        )
        .unwrap();
    f.store
        .write_with(&NoFaults, |tx| {
            dohc_engine_sync::journal_moment_append_in_tx(tx, "workspace", "later")
        })
        .unwrap();
    let later: serde_json::Value=f.store.read_with(|conn|conn.query_row("SELECT payload_json FROM replication_log WHERE op_kind='moment.append' AND json_extract(payload_json,'$.momentId')='later'",[],|r|r.get::<_,String>(0))).map(|s|serde_json::from_str(&s).unwrap()).unwrap();
    let mut later_op = op.clone();
    later_op.payload = later;
    assert_eq!(
        owner_publication_prefix(&f.store, "workspace", &[op, later_op], 1_000_000)
            .unwrap()
            .allowed_ops,
        2
    );
    owner.close().await.unwrap();
    supervisor.close_all().unwrap();
}

#[tokio::test]
async fn native_refusal_rejects_wrong_digest_stale_binding_and_accepted_delivery() {
    let f = Fixture::new();
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&f.db, 3).unwrap().actor;
    support::configure_witness_reader(&actor, &f.root).await;
    let owner = actor
        .live_application_owner("workspace".into())
        .await
        .unwrap();
    let _handle = f.adopt(&owner).await;
    f.record(
        &actor,
        f.doc.richdoc_append_paragraph("Exact native source"),
        "native",
        10,
    )
    .await;
    let input=f.store.read_with(|conn|conn.query_row("SELECT outbox_id,delivery_id,update_digest FROM owner_ydoc_outbox_entries WHERE pending=1",[],|r|Ok(dohc_engine_collab::owner_outbox::OwnerOutboxRefuseInput {outbox_id:r.get(0)?,delivery_id:r.get(1)?,update_digest:r.get(2)?,reason:"terminal-source-refused".into()}))).unwrap();
    let mut wrong = input.clone();
    wrong.update_digest = "ab".repeat(32);
    assert!(
        actor
            .owner_ydoc_refuse_entry(
                "workspace".into(),
                wrong,
                12,
                CancellationToken::new(),
                Arc::new(())
            )
            .await
            .unwrap()
            .is_err()
    );
    let mut stale = f.binding.clone();
    stale.selector_paths = vec!["notes".into()];
    let _new_handle = owner
        .register(
            "relay".into(),
            ApplicationHostCoordinate {
                host_id: "host".into(),
                host_epoch: 1,
                instance_id: "instance".into(),
                connection_id: "connection".into(),
            },
            stale,
        )
        .await
        .unwrap();
    assert!(
        actor
            .owner_ydoc_refuse_entry(
                "workspace".into(),
                input.clone(),
                12,
                CancellationToken::new(),
                Arc::new(())
            )
            .await
            .unwrap()
            .is_err()
    );
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
    let receipt = LiveUpdateReceipt {
        delivery_id: input.delivery_id.clone(),
        update_digest: input.update_digest.clone(),
        journal_cursor: 1,
        accepting_host_epoch: 1,
    };
    assert!(matches!(
        handle
            .apply(
                AdmittedLiveUpdate {
                    metadata: AdmittedLiveUpdateMetadata {
                        accepted: RelayAcceptedLiveUpdate {
                            receipt: receipt.clone(),
                            binding: f.binding.clone(),
                            authority: ServerDerivedLiveUpdateAuthority::Owner {
                                principal_id: "owner".into()
                            },
                            received_at_ms: 20
                        },
                        first_seen: vec![],
                        canonical_version: Some(2),
                        author_snapshot: Some(vec![]),
                        first_seen_deletes: Some(vec![]),
                        checkpoint_coverage: None
                    },
                    update_bytes: f
                        .store
                        .get_binary_blob(&input.update_digest)
                        .unwrap()
                        .unwrap()
                },
                Arc::new(NoFaults),
                100_000_000
            )
            .await
            .unwrap(),
        ApplicationResult::Applied(..)
    ));
    // Delivery acceptance is authoritative even before its owner ACK arrives.
    assert!(matches!(
        actor
            .owner_ydoc_refuse_entry(
                "workspace".into(),
                input,
                12,
                CancellationToken::new(),
                Arc::new(())
            )
            .await
            .unwrap(),
        Err(dohc_engine_collab::OwnerOutboxError::ReceiptMismatch)
    ));
    let saved = f.settle(&handle, Some(receipt)).await;
    assert!(f.file().contains("Exact native source"));
    assert_eq!(
        f.store
            .table_row_count("live_settlement_publication_states")
            .unwrap(),
        1
    );
    assert!(saved.materialized);
    owner.close().await.unwrap();
    supervisor.close_all().unwrap();
}

#[tokio::test]
async fn refused_admission_keeps_the_next_native_proof_at_the_last_verified_cut() {
    refused_native_publications_continue(1, false).await;
}

#[tokio::test]
async fn queued_refused_admissions_keep_the_third_native_proof_at_the_last_verified_cut() {
    refused_native_publications_continue(2, false).await;
}

#[tokio::test]
async fn refused_publication_followed_by_a_neutral_settlement_recovers_its_verified_cut() {
    refused_native_publications_continue(1, true).await;
}

async fn refused_native_publications_continue(queued: i64, neutral: bool) {
    use dohc_engine_sync::{NoLiveLeases, SettlementAdmission, apply_replication_envelope};
    let mut f = Fixture::new();
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&f.db, 3).unwrap().actor;
    support::configure_witness_reader(&actor, &f.root).await;
    let owner = actor
        .live_application_owner("workspace".into())
        .await
        .unwrap();
    let handle = f.adopt(&owner).await;
    let mut settlements = Vec::new();
    // Each proof is queued against the preceding cut before any refusal arrives.
    for cursor in 1..=queued {
        f.record(
            &actor,
            f.doc
                .richdoc_append_paragraph(&format!("Accepted content {cursor}")),
            &format!("queued-{cursor}"),
            10 + cursor,
        )
        .await;
        let receipt = f.accept_pending(&actor, &handle, cursor).await;
        settlements.push(f.settle(&handle, Some(receipt)).await);
    }
    let mut cache = dohc_engine_collab::WriterDocCache::new();
    let mut echoes =
        dohc_engine_sync::list_replication_ops(&f.store, "workspace", "origin", -1, 500).unwrap();
    let last_sequence = echoes
        .iter()
        .filter(|op| {
            op.op_kind == "moment.append"
                && settlements
                    .iter()
                    .any(|s| op.payload["momentId"] == s.moment_id)
        })
        .map(|op| op.origin_seq)
        .max()
        .unwrap();
    for echoed in &mut echoes {
        if echoed.origin_seq > last_sequence {
            break;
        }
        echoed.relay_seq = Some(echoed.origin_seq + 1);
        if let Some(settled) = settlements.iter().find(|s| {
            echoed.op_kind == "moment.append" && echoed.payload["momentId"] == s.moment_id
        }) {
            // Authenticated results use the canonical admission path, not mark edits.
            echoed.settlement_admission = Some(SettlementAdmission::Refused {
                settlement_id: settled.settlement_id.clone().unwrap(),
                reason: "authorship-mismatch".into(),
            });
        }
        apply_replication_envelope(&mut f.store, &mut cache, echoed, &NoFaults, &NoLiveLeases)
            .unwrap();
    }
    assert_eq!(
        f.store
            .table_row_count("live_settlement_attribution_unavailable")
            .unwrap(),
        queued
    );
    if neutral {
        let (receipt, result) = deliver_declared(
            &handle,
            &f.binding,
            queued + 1,
            &f.doc.encode_full_state(),
            AgentDeclaration {
                agent_id: "neutral-agent".into(),
                on_behalf_of: Some("owner".into()),
                depth: 1,
            },
        )
        .await;
        assert!(matches!(result, ApplicationResult::Applied(..)));
        let unchanged = f.settle(&handle, Some(receipt)).await;
        assert_eq!(unchanged.moment_id, settlements.last().unwrap().moment_id);
    }
    let next_cursor = queued + 1 + i64::from(neutral);
    f.record(
        &actor,
        f.doc.richdoc_append_paragraph("Accepted next content"),
        "next",
        40,
    )
    .await;
    let receipt = f.accept_pending(&actor, &handle, next_cursor).await;
    let next = f.settle(&handle, Some(receipt)).await;
    assert_eq!(next.previous_cursor, 0);
    assert_eq!(next.terminal_cursor, next_cursor);
    let payload:serde_json::Value=f.store.read_with(|conn|conn.query_row("SELECT payload_json FROM replication_log WHERE op_kind='moment.append' AND json_extract(payload_json,'$.momentId')=?1",[&next.moment_id],|r|r.get::<_,String>(0))).map(|s|serde_json::from_str(&s).unwrap()).unwrap();
    assert_eq!(
        payload["settlementReference"]["record"]["previousCursor"],
        0
    );
    assert_eq!(
        payload["payloadBeforeBlobSha256"],
        hex_sha256(f.text.as_bytes())
    );
    assert!(payload.get("attributionUnavailable").is_none());
    assert!(payload.get("authors").is_none());
    assert_eq!(
        f.store
            .table_row_count("live_settlement_attribution_unavailable")
            .unwrap(),
        queued
    );
    for cursor in 1..=queued {
        assert!(f.file().contains(&format!("Accepted content {cursor}")));
    }
    assert!(f.file().contains("Accepted next content"));
    owner.close().await.unwrap();
    supervisor.close_all().unwrap();
}

fn refuse_handover_publication(store: &mut EngineStore, settlement: &LiveSettlementResult) {
    use dohc_engine_sync::{NoLiveLeases, SettlementAdmission, apply_replication_envelope};
    let mut echoes =
        dohc_engine_sync::list_replication_ops(store, "workspace", "origin", -1, 500).unwrap();
    let last = echoes
        .iter()
        .find(|op| op.op_kind == "moment.append" && op.payload["momentId"] == settlement.moment_id)
        .unwrap()
        .origin_seq;
    for echoed in &mut echoes {
        if echoed.origin_seq > last {
            break;
        }
        echoed.relay_seq = Some(echoed.origin_seq + 1);
        if echoed.op_kind == "moment.append" && echoed.payload["momentId"] == settlement.moment_id {
            echoed.settlement_admission = Some(SettlementAdmission::Refused {
                settlement_id: settlement.settlement_id.clone().unwrap(),
                reason: "authorship-mismatch".into(),
            });
        }
        apply_replication_envelope(
            store,
            &mut dohc_engine_collab::WriterDocCache::new(),
            echoed,
            &NoFaults,
            &NoLiveLeases,
        )
        .unwrap();
    }
}

#[tokio::test]
async fn refused_publications_after_a_handover_keep_the_cut_across_a_restart() {
    for changes_content in [false, true] {
        for canonical in [false, true] {
            unavailable_publication_after_handover(changes_content, canonical, false, false).await;
        }
    }
}

#[tokio::test]
async fn a_resumed_owners_empty_handover_publishes_after_a_refused_interval() {
    unavailable_publication_after_handover(true, true, true, true).await;
}

#[tokio::test]
async fn terminal_owner_source_after_a_handover_keeps_the_cut_across_a_restart() {
    for changes_content in [false, true] {
        unavailable_publication_after_handover(changes_content, false, true, false).await;
    }
}

async fn unavailable_publication_after_handover(
    changes_content: bool,
    canonical: bool,
    terminal_source: bool,
    resumed: bool,
) {
    use dohc_engine_sync::owner_publication_prefix;
    let mut f = Fixture::with_source(0, canonical);
    let cut = (!resumed)
        .then(|| f.edit_accepted_before_handover_with_source(7, changes_content, !canonical));
    let mut receipt = cut.as_ref().and_then(|cut| cut.terminal_receipt.clone());
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&f.db, 3).unwrap().actor;
    support::configure_witness_reader(&actor, &f.root).await;
    let owner = actor
        .live_application_owner("workspace".into())
        .await
        .unwrap();
    let handle = if let Some(cut) = cut {
        f.adopt_cut(&owner, cut).await
    } else {
        let first = f.adopt(&owner).await;
        let scope = dohc_engine_runtime::actor::OwnedRetirementScope {
            namespace: "relay".into(),
            max_deliveries: 100,
            max_applications: 100,
        };
        assert_eq!(
            owner
                .prepare_retirement(
                    scope.clone(),
                    PreparationKey {
                        object_id: "object".into(),
                        lineage_claim_id: f.binding.lineage_claim_id.clone(),
                        activation_id: "adoption".into(),
                        restore_fence_generation: 0,
                    }
                )
                .await
                .unwrap(),
            None
        );
        // The accepted owner edit arrives while Stop prepares its fence.
        let update = f
            .doc
            .richdoc_append_paragraph("Owner edit accepted before Resume");
        let accepted = LiveUpdateReceipt {
            delivery_id: "stopped-owner-edit".into(),
            update_digest: hex_sha256(&update),
            journal_cursor: 7,
            accepting_host_epoch: 1,
        };
        assert!(matches!(
            deliver_owned(&first, &f.binding, &accepted, update).await,
            ApplicationResult::Applied(..)
        ));
        let retired = f.settle(&first, Some(accepted.clone())).await;
        refuse_handover_publication(&mut f.store, &retired);
        // An uncaptured historical settlement has no retained publication
        // state. Its replay must keep that absence, as live_settlement tests.
        f.store
            .write_with(&NoFaults, |tx| {
                tx.execute(
                    "DELETE FROM live_settlement_publication_states WHERE settlement_id=?1",
                    [retired.settlement_id.as_deref().unwrap()],
                )
                .map_err(dohc_engine_storage::StorageError::persist_public)
            })
            .unwrap();
        let coordinate = window_host_coordinate();
        let key = RetirementKey {
            object_id: "object".into(),
            lineage_claim_id: f.binding.lineage_claim_id.clone(),
            activation_id: "adoption".into(),
            restore_fence_generation: 0,
            accepted_through: 7,
        };
        owner
            .begin_retirement(scope.clone(), coordinate.clone(), key.clone(), false)
            .await
            .unwrap();
        // Give this native fixture ordinary sync's imported base and cursor.
        f.store.write_with(&NoFaults, |tx| {
            let payload = serde_json::json!({"versionId":"main","objectId":"object","contentKind":"richdoc",
                "isBaseState":true,"lineageClaimId":f.binding.lineage_claim_id,"updateBlobSha256":f.binding.lineage_claim_id});
            tx.execute("UPDATE ydoc_docs SET base_origin_id='remote',base_origin_seq=7,base_relay_seq=9", []).unwrap();
            tx.execute("INSERT INTO replication_log(workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms,imported)
                VALUES('workspace','remote',7,'ydoc.update',?1,1,1)", [payload.to_string()]).unwrap();
            tx.execute("INSERT INTO sync_relay_cursors(workspace_id,cursor,replication_epoch,stream_identity)
                VALUES('workspace','9','epoch','stream')", []).unwrap();
            tx.execute("INSERT INTO hosted_replicas(workspace_id,scope_generation,created_at_ms,main_cursor,last_outbound_seq)
                VALUES('workspace',1,0,9,(SELECT COALESCE(MAX(origin_seq),-1) FROM replication_log WHERE origin_id='origin'))", []).unwrap();
            tx.execute("INSERT INTO hosted_documents(workspace_id,object_id,path,state,scope_generation)
                VALUES('workspace','object','notes/owner.md','parked',0)", []).unwrap();
            Ok::<_, dohc_engine_storage::StorageError>(())
        }).unwrap();
        let Release::Released {
            boundary: Some(boundary),
            ..
        } = owner
            .release_activation(scope, coordinate.clone(), key, 40)
            .await
            .unwrap()
        else {
            panic!("Stop releases the adopted activation");
        };
        execute(
            &mut f.store,
            "UPDATE hosted_documents SET state='ready',scope_generation=1",
        );
        let captured = actor
            .capture_imported_owner_activation(
                "relay".into(),
                DocKey::new("workspace", "main", "object").unwrap(),
                f.binding.current_path.clone(),
                1_000_000,
                None,
                CancellationToken::new(),
                Arc::new(()),
            )
            .await
            .unwrap();
        assert_eq!(
            captured.source.predecessor_activation_id.as_deref(),
            Some("adoption")
        );
        let successor = owner
            .register_activation(
                "relay".into(),
                coordinate,
                f.binding.clone(),
                captured.activation_id.clone(),
            )
            .await
            .unwrap();
        successor
            .adopt_owner(
                imported_cut(
                    &captured,
                    Some(RetainedPrefix {
                        terminal_receipt: boundary.terminal_receipt,
                        event_count: boundary.event_count,
                        history_evidence_digest: boundary.history_evidence_digest,
                        predecessor_activation_id: "adoption".into(),
                    }),
                ),
                1_000_000,
                100,
                Arc::new(NoFaults),
                Arc::new(()),
            )
            .await
            .unwrap();
        receipt = Some(accepted);
        successor
    };
    let handover_bytes = f.doc.encode_full_state();
    let empty = f.settle(&handle, receipt).await;
    if resumed {
        assert!(
            empty.settlement_id.is_some(),
            "the empty handover replays the retired settlement"
        );
        assert_eq!((empty.previous_cursor, empty.terminal_cursor), (0, 7));
        let retry = f
            .store
            .read_with(|conn| {
                dohc_engine_collab::markdown_write_obligations::AuditedRetry::adopted_owner_in(
                    conn,
                    &DocKey::new("workspace", "main", "object").unwrap(),
                    1,
                )
            })
            .unwrap()
            .unwrap();
        assert_eq!(retry.binding, f.binding, "retry uses the successor binding");
        assert_eq!(retry.terminal_cursor, 7);
        let mut renamed_binding = f.binding.clone();
        renamed_binding.selector_paths = vec!["notes".into()];
        f.store.read_with(|conn| {
            let tx = conn.unchecked_transaction().unwrap();
            tx.execute("UPDATE live_owner_activations SET binding_json=?1 WHERE released_at_ms IS NULL",
                [serde_json::to_string(&renamed_binding).unwrap()]).unwrap();
            let retry = dohc_engine_collab::markdown_write_obligations::AuditedRetry::adopted_owner_in(
                &tx, &DocKey::new("workspace", "main", "object").unwrap(), 1,
            ).unwrap().unwrap();
            assert_eq!(retry.binding, renamed_binding, "retry reads the successor's binding");
            tx.rollback().unwrap();
            Ok::<_, dohc_engine_storage::StorageError>(())
        }).unwrap();
    }
    assert_eq!(
        recorded_settlements(&f.store),
        if resumed { (1, 1) } else { (0, 0) }
    );
    f.record(
        &actor,
        f.doc.richdoc_append_paragraph("Accepted first content"),
        "first",
        40,
    )
    .await;
    let first_receipt = f.accept_pending(&actor, &handle, 8).await;
    let intermediate_bytes = f.doc.encode_full_state();
    if terminal_source {
        f.record(
            &actor,
            f.doc.richdoc_append_paragraph("Private refused content"),
            "private",
            41,
        )
        .await;
        let input = f.store.read_with(|conn| conn.query_row(
            "SELECT outbox_id,delivery_id,update_digest FROM owner_ydoc_outbox_entries WHERE pending=1", [],
            |r| Ok(dohc_engine_collab::owner_outbox::OwnerOutboxRefuseInput {
                outbox_id:r.get(0)?, delivery_id:r.get(1)?, update_digest:r.get(2)?, reason:"terminal-source-refused".into()
            }))).unwrap();
        actor
            .owner_ydoc_refuse_entry(
                "workspace".into(),
                input,
                42,
                CancellationToken::new(),
                Arc::new(()),
            )
            .await
            .unwrap()
            .unwrap();
    }
    let first = f.settle(&handle, Some(first_receipt)).await;
    if !terminal_source {
        refuse_handover_publication(&mut f.store, &first);
    }
    assert_eq!(
        f.store
            .table_row_count("live_settlement_attribution_unavailable")
            .unwrap(),
        if resumed { 2 } else { 1 }
    );
    owner.close().await.unwrap();
    supervisor.close_all().unwrap();

    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&f.db, 3).unwrap().actor;
    support::configure_witness_reader(&actor, &f.root).await;
    let owner = actor
        .live_application_owner("workspace".into())
        .await
        .unwrap();
    let handle = f.register(&owner, "reloaded").await;
    // Continue from the accepted state, leaving the refused native tail private.
    let next_doc = Ydoc::wire();
    next_doc.apply(&intermediate_bytes).unwrap();
    let next_update = next_doc.richdoc_append_paragraph("Accepted next content");
    let next_receipt = if terminal_source {
        let (receipt, result) = deliver_declared(
            &handle,
            &f.binding,
            9,
            &next_doc.encode_full_state(),
            AgentDeclaration {
                agent_id: "next-agent".into(),
                on_behalf_of: Some("owner".into()),
                depth: 1,
            },
        )
        .await;
        assert!(matches!(result, ApplicationResult::Applied(..)));
        receipt
    } else {
        f.record(&actor, next_update, "next", 50).await;
        f.accept_pending(&actor, &handle, 9).await
    };
    let next = f.settle(&handle, Some(next_receipt)).await;
    assert_eq!((next.previous_cursor, next.terminal_cursor), (7, 9));
    let op = dohc_engine_sync::list_replication_ops(&f.store, "workspace", "origin", -1, 500)
        .unwrap()
        .into_iter()
        .find(|op| op.op_kind == "moment.append" && op.payload["momentId"] == next.moment_id)
        .unwrap();
    assert_eq!(op.payload["payloadBeforeBlobSha256"], empty.markdown_digest);
    assert_eq!(
        owner_publication_prefix(&f.store, "workspace", std::slice::from_ref(&op), 1_000_000)
            .unwrap()
            .allowed_ops,
        1
    );
    assert!(f.file().contains("Accepted first content"));
    assert!(f.file().contains("Accepted next content"));
    assert!(!f.file().contains("Private refused content"));
    if !terminal_source
        && let Some(directory) = std::env::var_os("DOHC_HANDOVER_PUBLICATION_EVIDENCE")
    {
        let name = format!(
            "{}-{}refused.json",
            if changes_content {
                "changed"
            } else {
                "unchanged"
            },
            if canonical { "" } else { "preserved-" }
        );
        let evidence = serde_json::json!({
            "baselineBytes":f.bytes, "handoverBytes":handover_bytes,
            "intermediateBytes":intermediate_bytes, "nextBytes":next_doc.encode_full_state(), "payload":op.payload,
        });
        std::fs::write(
            PathBuf::from(directory).join(name),
            serde_json::to_vec(&evidence).unwrap(),
        )
        .unwrap();
    }
    owner.close().await.unwrap();
    supervisor.close_all().unwrap();
}

#[tokio::test]
async fn unload_waits_for_an_owner_edit_adopted_before_its_first_settlement() {
    let mut f = Fixture::new();
    let key = DocKey::new("workspace", "main", "object").unwrap();
    let cut = f.edit_accepted_before_handover(7, true);
    let receipt = cut.terminal_receipt.clone().unwrap();
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&f.db, 3).unwrap().actor;
    support::configure_witness_reader(&actor, &f.root).await;
    let owner = actor
        .live_application_owner("workspace".into())
        .await
        .unwrap();
    let handle = f.adopt_cut(&owner, cut).await;
    let unload = || {
        owner.unload(
            "object".into(),
            Some("adoption".into()),
            vec![key.clone()],
            f.root.path().to_owned(),
            40,
        )
    };
    // The adoption cursor covers the edit, but the file does not hold it yet.
    assert_eq!(unload().await.unwrap(), Some(UnloadPending::Settlement));
    assert!(f.settle(&handle, Some(receipt)).await.materialized);
    assert_eq!(unload().await.unwrap(), None);
    owner.close().await.unwrap();
    supervisor.close_all().unwrap();
}

/// Stored settlements and the settlement audits journaled for the relay.
fn recorded_settlements(store: &EngineStore) -> (i64, i64) {
    store
        .read_with(|conn| {
            conn.query_row(
                "SELECT (SELECT COUNT(*) FROM live_device_settlements),(SELECT COUNT(*) FROM replication_log WHERE op_kind='live.audit.settlement')",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
        })
        .unwrap()
}

#[tokio::test]
async fn settling_straight_after_a_handover_records_and_publishes_nothing() {
    let f = Fixture::new();
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&f.db, 3).unwrap().actor;
    support::configure_witness_reader(&actor, &f.root).await;
    let owner = actor
        .live_application_owner("workspace".into())
        .await
        .unwrap();
    let handle = f.adopt(&owner).await;
    let before = f.counts();
    let empty = f.settle(&handle, None).await;
    assert_eq!(empty.settlement_id, None);
    assert_eq!(
        (
            empty.previous_cursor,
            empty.terminal_cursor,
            empty.application_count
        ),
        (0, 0, 0)
    );
    assert!(empty.materialized);
    assert_eq!(f.file(), f.text);
    assert_eq!(f.counts(), before);
    assert_eq!(recorded_settlements(&f.store), (0, 0));

    // The first accepted edit is recorded and journaled from the handover.
    f.record(
        &actor,
        f.doc.richdoc_append_paragraph("Accepted owner edit."),
        "accepted-edit",
        10,
    )
    .await;
    let receipt = f.accept_pending(&actor, &handle, 1).await;
    let settled = f.settle(&handle, Some(receipt)).await;
    assert!(settled.settlement_id.is_some());
    assert_eq!(
        (
            settled.previous_cursor,
            settled.terminal_cursor,
            settled.application_count
        ),
        (0, 1, 1)
    );
    assert!(f.file().contains("Accepted owner edit."));
    assert_eq!(recorded_settlements(&f.store), (1, 1));
    owner.close().await.unwrap();
    supervisor.close_all().unwrap();
}

#[tokio::test]
async fn the_settlement_after_an_empty_one_starts_at_a_changed_handover_across_a_reload() {
    the_settlement_after_an_empty_one_starts_at_the_handover_across_a_reload(true, true, false)
        .await;
}

#[tokio::test]
async fn the_handover_settle_keeps_the_new_owners_unaccepted_edit() {
    let mut f = Fixture::with_source(0, true);
    let cut = f.edit_accepted_before_handover(7, true);
    let receipt = cut.terminal_receipt.clone().unwrap();
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&f.db, 3).unwrap().actor;
    support::configure_witness_reader(&actor, &f.root).await;
    let owner = actor
        .live_application_owner("workspace".into())
        .await
        .unwrap();
    let handle = f.adopt_cut(&owner, cut).await;
    f.record(
        &actor,
        f.doc.frontmatter_set("status", "still typing").unwrap(),
        "typing",
        20,
    )
    .await;
    let empty = f.settle(&handle, Some(receipt)).await;
    assert!(empty.materialized);
    assert_eq!(empty.settlement_id, None);
    assert_eq!(f.file(), "owner edit");
    assert_eq!(
        f.store
            .read_with(|conn| conn.query_row(
                "SELECT count(*) FROM owner_ydoc_outbox_entries WHERE pending=1",
                [],
                |row| row.get::<_, i64>(0)
            ))
            .unwrap(),
        1
    );
    let receipt = f.accept_pending(&actor, &handle, 8).await;
    let settled = f.settle(&handle, Some(receipt)).await;
    assert_eq!((settled.previous_cursor, settled.terminal_cursor), (7, 8));
    assert!(f.file().contains("still typing"));
    owner.close().await.unwrap();
    supervisor.close_all().unwrap();
}

#[tokio::test]
async fn the_handover_settle_refuses_an_unfolded_file_change() {
    let mut f = Fixture::with_source(0, true);
    let cut = f.edit_accepted_before_handover(7, true);
    let receipt = cut.terminal_receipt.clone().unwrap();
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&f.db, 3).unwrap().actor;
    support::configure_witness_reader(&actor, &f.root).await;
    let owner = actor
        .live_application_owner("workspace".into())
        .await
        .unwrap();
    let handle = f.adopt_cut(&owner, cut).await;
    let text = "A file change still awaiting capture.";
    std::fs::write(f.root.path().join(&f.binding.current_path), text).unwrap();
    let error = handle
        .settle(
            Some(receipt),
            100,
            f.root.path().to_owned(),
            30,
            Arc::new(NoFaults),
            CancellationToken::new(),
            AdmittedNativeHistoryReconstruction {
                policy: NativeHistoryReconstruction {
                    working_reserve_bytes: 8 * 1024 * 1024,
                },
                reservation: Arc::new(()),
            },
        )
        .await
        .err()
        .unwrap();
    assert_eq!(error.code(), "conflict-stale-target");
    assert_eq!(f.file(), text);
    assert_eq!(recorded_settlements(&f.store), (0, 0));
    owner.close().await.unwrap();
    supervisor.close_all().unwrap();
}

/// An outside write lands while the handover settle writes the owner's
/// accepted edit, so its materialization conflicts. Once the file holds its
/// earlier bytes again, the next settle writes the edit, and also any edit
/// accepted meanwhile. A head that this lineage's empty settle didn't write
/// is never restored.
#[derive(Clone, Copy, PartialEq)]
enum AfterConflict {
    Nothing,
    AnotherEditAccepted,
    RecordOfOtherLineage,
}

#[tokio::test]
async fn an_empty_handover_settle_recovers_after_its_file_is_restored() {
    empty_handover_settle_after_its_file_is_restored(AfterConflict::Nothing).await;
}

#[tokio::test]
async fn an_empty_handover_settle_recovers_after_another_edit_is_accepted() {
    empty_handover_settle_after_its_file_is_restored(AfterConflict::AnotherEditAccepted).await;
}

#[tokio::test]
async fn an_empty_handover_settle_restores_only_its_own_lineages_head() {
    empty_handover_settle_after_its_file_is_restored(AfterConflict::RecordOfOtherLineage).await;
}

async fn empty_handover_settle_after_its_file_is_restored(after: AfterConflict) {
    use dohc_engine_storage::FaultInjector;
    let mut f = Fixture::with_source(0, true);
    let root = f.root.path().to_owned();
    let path = root.join(&f.binding.current_path);
    let before = std::fs::read(&path).unwrap();
    let cut = f.edit_accepted_before_handover(7, true);
    let receipt = cut.terminal_receipt.clone().unwrap();
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&f.db, 3).unwrap().actor;
    support::configure_witness_reader(&actor, &f.root).await;
    let owner = actor
        .live_application_owner("workspace".into())
        .await
        .unwrap();
    let handle = f.adopt_cut(&owner, cut).await;
    let settle = |receipt: LiveUpdateReceipt, faults: Arc<dyn FaultInjector>| {
        handle.settle(
            Some(receipt),
            100,
            root.clone(),
            30,
            faults,
            CancellationToken::new(),
            AdmittedNativeHistoryReconstruction {
                policy: NativeHistoryReconstruction {
                    working_reserve_bytes: 8 * 1024 * 1024,
                },
                reservation: Arc::new(()),
            },
        )
    };
    let rival = Arc::new(PrefixRival {
        path: path.clone(),
        fired: std::sync::atomic::AtomicBool::new(false),
    });
    assert_eq!(
        settle(receipt.clone(), rival).await.err().unwrap().code(),
        "conflict-stale-target"
    );
    assert_eq!(f.file(), "rival survives");
    assert_eq!(
        settle(receipt.clone(), Arc::new(NoFaults))
            .await
            .err()
            .unwrap()
            .code(),
        "conflict-stale-target"
    );
    assert_eq!(f.file(), "rival survives");
    let receipt = match after {
        AfterConflict::Nothing => receipt,
        AfterConflict::AnotherEditAccepted => {
            f.record(
                &actor,
                f.doc.richdoc_append_paragraph("Edit after the conflict."),
                "after-conflict",
                50,
            )
            .await;
            f.accept_pending(&actor, &handle, 8).await
        }
        AfterConflict::RecordOfOtherLineage => {
            f.store
                .write_with(&NoFaults, |tx| {
                    tx.execute(
                        "UPDATE live_empty_settlements SET lineage_claim_id=?1",
                        ["0".repeat(64)],
                    )
                    .unwrap();
                    Ok::<_, dohc_engine_storage::StorageError>(())
                })
                .unwrap();
            receipt
        }
    };
    std::fs::write(&path, &before).unwrap();
    if after == AfterConflict::RecordOfOtherLineage {
        assert_eq!(
            settle(receipt, Arc::new(NoFaults))
                .await
                .err()
                .unwrap()
                .code(),
            "conflict-stale-target"
        );
        assert_eq!(std::fs::read(&path).unwrap(), before);
    } else {
        let recovered = settle(receipt, Arc::new(NoFaults)).await.unwrap();
        assert!(recovered.materialized);
        assert_eq!(
            f.file(),
            f.doc.project(ContentKind::Richdoc).unwrap().content
        );
        let recorded = after == AfterConflict::AnotherEditAccepted;
        assert_eq!(recovered.settlement_id.is_some(), recorded);
        assert_eq!(
            recorded_settlements(&f.store),
            if recorded { (1, 1) } else { (0, 0) }
        );
    }
    owner.close().await.unwrap();
    supervisor.close_all().unwrap();
}

#[tokio::test]
async fn the_settlement_after_an_empty_one_starts_at_an_unchanged_handover_across_a_reload() {
    the_settlement_after_an_empty_one_starts_at_the_handover_across_a_reload(false, true, false)
        .await;
}

#[tokio::test]
async fn a_changed_handover_preserves_its_markdown_source_across_a_reload() {
    the_settlement_after_an_empty_one_starts_at_the_handover_across_a_reload(true, false, false)
        .await;
}

#[tokio::test]
async fn an_unchanged_handover_preserves_its_markdown_source_across_a_reload() {
    the_settlement_after_an_empty_one_starts_at_the_handover_across_a_reload(false, false, false)
        .await;
}

#[tokio::test]
async fn a_frontmatter_handover_proves_the_settled_html_source_after_the_file_advances() {
    the_settlement_after_an_empty_one_starts_at_the_handover_across_a_reload(true, false, true)
        .await;
}

async fn the_settlement_after_an_empty_one_starts_at_the_handover_across_a_reload(
    changes_content: bool,
    canonical: bool,
    html: bool,
) {
    use dohc_engine_sync::{ReplicationEnvelope, owner_publication_prefix};
    let mut f = if html {
        let snapshot = "---\ntitle: old\n---\n\nHello <b>hidden</b> world\n";
        let doc = Ydoc::wire();
        doc.rewrite_content_to_markdown_preserving_source(ContentKind::Richdoc, snapshot)
            .unwrap();
        let original = doc.project(ContentKind::Richdoc).unwrap().content;
        let mut f = Fixture::with_seed(original, doc.encode_full_state());
        for (object, path, text, moment) in [
            ("schema", "notes/.collection.json", "{}", "schema"),
            (
                "object",
                f.binding.current_path.as_str(),
                snapshot,
                "before-handover",
            ),
        ] {
            dohc_engine_domain::VersionedTextStore::new(&mut f.store)
                .write_text(
                    &dohc_engine_domain::WriteText {
                        workspace_id: "workspace".into(),
                        version_id: "main".into(),
                        object_id: object.into(),
                        path: path.into(),
                        text: text.into(),
                        moment_id: moment.into(),
                        metadata_origin: "api".into(),
                        metadata_summary: None,
                        metadata_correlation_id: None,
                        author_json: None,
                        now_ms: 3,
                        request_id: None,
                    },
                    &NoFaults,
                )
                .unwrap();
        }
        std::fs::write(f.root.path().join(&f.binding.current_path), snapshot).unwrap();
        f.store
            .write_with(&NoFaults, |tx| {
                tx.execute(
                    "UPDATE ydoc_docs SET last_settled_sha=?1",
                    [hex_sha256(snapshot.as_bytes())],
                )
                .unwrap();
                Ok::<_, dohc_engine_storage::StorageError>(())
            })
            .unwrap();
        f
    } else {
        Fixture::with_source(0, canonical)
    };
    let key = DocKey::new("workspace", "main", "object").unwrap();
    let cut = if html {
        let snapshot = f.file();
        assert_ne!(snapshot, f.text);
        let source = snapshot.replace("title: old", "title: new");
        f.doc
            .frontmatter_set_preserving_markdown_source("title", "new", &source)
            .unwrap();
        let projection = f.doc.project(ContentKind::Richdoc).unwrap().content;
        assert_eq!(f.doc.preserved_markdown_source(&projection), None);
        assert_eq!(
            f.doc
                .settled_markdown_source(&projection, || Ok::<_, ()>(Some(snapshot.clone())))
                .unwrap(),
            Some(source)
        );
        f.accepted_handover_update(7, f.doc.encode_full_state())
    } else {
        f.edit_accepted_before_handover_with_source(7, changes_content, !canonical)
    };
    let handover_bytes = f.doc.encode_full_state();
    let receipt = cut.terminal_receipt.clone().unwrap();
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&f.db, 3).unwrap().actor;
    support::configure_witness_reader(&actor, &f.root).await;
    let owner = actor
        .live_application_owner("workspace".into())
        .await
        .unwrap();
    let handle = f.adopt_cut(&owner, cut).await;
    let empty = f.settle(&handle, Some(receipt)).await;
    assert_eq!(
        (
            empty.settlement_id,
            empty.previous_cursor,
            empty.terminal_cursor
        ),
        (None, 7, 7)
    );
    assert!(empty.materialized);
    assert_eq!(
        empty.markdown_digest == hex_sha256(f.text.as_bytes()),
        !changes_content
    );
    if !canonical {
        let projected = f.doc.project(ContentKind::Richdoc).unwrap().content;
        assert_ne!(empty.markdown_digest, hex_sha256(projected.as_bytes()));
        if html {
            assert_eq!(f.doc.preserved_markdown_source(&projected), None);
        } else {
            assert_eq!(f.doc.preserved_markdown_source(&projected), Some(f.file()));
        }
    }
    assert_eq!(recorded_settlements(&f.store), (0, 0));
    assert_eq!(
        owner
            .unload(
                "object".into(),
                Some("adoption".into()),
                vec![key],
                f.root.path().to_owned(),
                40
            )
            .await
            .unwrap(),
        None
    );
    owner.close().await.unwrap();
    supervisor.close_all().unwrap();

    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&f.db, 3).unwrap().actor;
    support::configure_witness_reader(&actor, &f.root).await;
    let owner = actor
        .live_application_owner("workspace".into())
        .await
        .unwrap();
    let handle = f.register(&owner, "reloaded").await;
    f.record(
        &actor,
        f.doc.richdoc_append_paragraph("Edit after the reload."),
        "after-reload",
        50,
    )
    .await;
    let receipt = f.accept_pending(&actor, &handle, 8).await;
    let next = f.settle(&handle, Some(receipt)).await;
    assert!(next.settlement_id.is_some());
    assert_eq!(
        (
            next.previous_cursor,
            next.terminal_cursor,
            next.application_count
        ),
        (7, 8, 1)
    );
    assert!(f.file().contains("Edit after the reload."));
    let stored: (i64, i64) = f
        .store
        .read_with(|conn| {
            conn.query_row(
                "SELECT previous_cursor,terminal_cursor FROM live_device_settlements",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
        })
        .unwrap();
    assert_eq!(stored, (7, 8));
    assert_eq!(recorded_settlements(&f.store), (1, 1));
    // The relay holds the Markdown at the handover cut as this proof's
    // predecessor, so the outgoing moment starts there.
    let op = f.store.read_with(|conn| conn.query_row("SELECT origin_id,origin_seq,payload_json,recorded_at_ms FROM replication_log WHERE imported=0 AND op_kind='moment.append' AND json_extract(payload_json,'$.momentId')=?1", [&next.moment_id], |r| Ok(ReplicationEnvelope {
        workspace_id:"workspace".into(), origin_id:r.get(0)?, origin_seq:r.get(1)?, relay_seq:None, op_kind:"moment.append".into(), payload:serde_json::from_str(&r.get::<_,String>(2)?).unwrap(), recorded_at_ms:r.get(3)?, settlement_admission:None, admitted_author_snapshot:None
    }))).unwrap();
    assert_eq!(
        op.payload["settlementReference"]["record"]["previousCursor"],
        7
    );
    assert_eq!(
        op.payload["payloadBeforeBlobSha256"],
        serde_json::json!(empty.markdown_digest)
    );
    assert_eq!(
        owner_publication_prefix(&f.store, "workspace", std::slice::from_ref(&op), 1_000_000)
            .unwrap()
            .allowed_ops,
        1
    );
    if changes_content && !canonical {
        let handover = Ydoc::wire();
        handover.apply(&handover_bytes).unwrap();
        let projected = handover.project(ContentKind::Richdoc).unwrap().content;
        let mut canonical_before = op.clone();
        canonical_before.payload["payloadBeforeBlobSha256"] =
            serde_json::json!(hex_sha256(projected.as_bytes()));
        canonical_before.payload["beforeBlobSha256"] =
            canonical_before.payload["payloadBeforeBlobSha256"].clone();
        assert_eq!(
            owner_publication_prefix(&f.store, "workspace", &[canonical_before], 1_000_000)
                .unwrap()
                .allowed_ops,
            usize::from(html)
        );
    }
    let mut unaccepted = op.clone();
    unaccepted.payload["payloadBeforeBlobSha256"] =
        serde_json::json!(hex_sha256(b"Unaccepted predecessor"));
    unaccepted.payload["beforeBlobSha256"] = unaccepted.payload["payloadBeforeBlobSha256"].clone();
    assert_eq!(
        owner_publication_prefix(&f.store, "workspace", &[unaccepted], 1_000_000)
            .unwrap()
            .allowed_ops,
        0
    );
    if let Some(directory) = std::env::var_os("DOHC_HANDOVER_PUBLICATION_EVIDENCE") {
        let evidence = serde_json::json!({
            "baselineBytes": f.bytes,
            "handoverBytes": handover_bytes,
            "nextBytes": f.doc.encode_full_state(),
            "payload": op.payload,
        });
        let name = if html {
            "changed-html.json"
        } else {
            match (changes_content, canonical) {
                (true, true) => "changed.json",
                (false, true) => "unchanged.json",
                (true, false) => "changed-preserved.json",
                (false, false) => "unchanged-preserved.json",
            }
        };
        std::fs::write(
            PathBuf::from(directory).join(name),
            serde_json::to_vec(&evidence).unwrap(),
        )
        .unwrap();
    }
    owner.close().await.unwrap();
    supervisor.close_all().unwrap();
}

fn observed_release_fixture() -> Fixture {
    observed_release_fixture_with_size(0)
}

fn observed_release_fixture_with_size(size: usize) -> Fixture {
    use dohc_engine_collab::owner_outbox::draft::{
        ObservedOwnerBinding, install_observed_binding_in_tx,
    };
    let mut f = Fixture::with_size(size);
    let key = DocKey::new("workspace", "main", "object").unwrap();
    let state = dohc_engine_collab::load_persisted(&f.store, &key)
        .unwrap()
        .unwrap();
    let checkpoint = state.doc.encode_full_state();
    f.store
        .write_with(&NoFaults, |tx| {
            tx.execute("DELETE FROM collection_records", []).unwrap();
            tx.execute("DELETE FROM collections", []).unwrap();
            install_observed_binding_in_tx(
                tx,
                "workspace",
                &ObservedOwnerBinding {
                    binding: f.binding.clone(),
                    relay_database_namespace: "relay".into(),
                    revision: 1,
                    accepted_cursor: 0,
                    native_head_sequence: state.marker.head_update_seq,
                    checkpoint_digest: hex_sha256(&checkpoint),
                    limits: dohc_engine_collab::OwnerOutboxLimits {
                        max_pending_bytes: 1_000_000,
                        max_pending_age_ms: 100_000,
                    },
                },
                &checkpoint,
            )
        })
        .unwrap();
    f
}

fn release_snapshot(f: &Fixture) -> Vec<Vec<String>> {
    f.store
        .read_with(|conn| {
            [
                "owner_live_stops",
                "ydoc_owner_bindings",
                "ydoc_owner_applied_frames",
                "owner_ydoc_outboxes",
                "owner_ydoc_outbox_entries",
                "binary_blobs",
                "ydoc_docs",
                "ydoc_updates",
                "ydoc_snapshots",
                "replication_log",
                "moments",
            ]
            .iter()
            .map(|table| {
                let mut stmt = conn.prepare(&format!("SELECT * FROM {table}")).unwrap();
                let columns = stmt.column_count();
                let mut rows = stmt
                    .query_map([], |row| {
                        (0..columns)
                            .map(|i| row.get::<_, rusqlite::types::Value>(i))
                            .collect::<rusqlite::Result<Vec<_>>>()
                    })
                    .unwrap()
                    .map(|row| format!("{:?}", row.unwrap()))
                    .collect::<Vec<_>>();
                rows.sort();
                Ok::<_, dohc_engine_storage::StorageError>(rows)
            })
            .collect()
        })
        .unwrap()
}

async fn stop_action(
    actor: &ActorHandle,
    f: &Fixture,
    action: &str,
) -> Result<
    Vec<dohc_engine_collab::owner_outbox::release::OwnerLiveStop>,
    dohc_engine_collab::OwnerOutboxError,
> {
    stop_action_at_cursor(actor, f, action, 0).await
}

async fn stop_action_at_cursor(
    actor: &ActorHandle,
    f: &Fixture,
    action: &str,
    accepted_cursor: i64,
) -> Result<
    Vec<dohc_engine_collab::owner_outbox::release::OwnerLiveStop>,
    dohc_engine_collab::OwnerOutboxError,
> {
    actor
        .owner_ydoc_stop(
            "workspace".into(),
            if action == "release" {
                None
            } else {
                Some(f.binding.current_path.clone())
            },
            if action == "release" {
                Some(f.binding.clone())
            } else {
                None
            },
            None,
            Some(accepted_cursor),
            None,
            action.into(),
            40,
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .unwrap()
}

#[tokio::test]
async fn stop_releases_current_owner_edits_with_credit_and_preserves_remote_edits() {
    for reason in [
        None,
        Some("stale-binding"),
        Some("binding-changed"),
        Some("delivery-conflict"),
        Some("provenance-refused"),
    ] {
        let f = observed_release_fixture();
        let key = DocKey::new("workspace", "main", "object").unwrap();
        let supervisor = WorkspaceSupervisor::new();
        let actor = supervisor.open(&f.db, 3).unwrap().actor;
        support::configure_witness_reader(&actor, &f.root).await;
        let pending = f
            .doc
            .frontmatter_set("pending", "Owner pending edit")
            .unwrap();
        let entry = actor
            .owner_ydoc_append_draft(
                "workspace".into(),
                dohc_engine_collab::owner_outbox::draft::OwnerDraftAppendInput {
                    person_edit: true,
                    binding: f.binding.clone(),
                    expected_revision: 1,
                    append_key: "pending".into(),
                    update: pending,
                    now_ms: 10,
                    agent_declaration: None,
                    automation_declaration: None,
                },
                CancellationToken::new(),
                Arc::new(()),
            )
            .await
            .unwrap()
            .unwrap();
        let remote = Ydoc::wire();
        remote.apply(&f.bytes).unwrap();
        let update = remote
            .frontmatter_set("remote", "Accepted remote edit")
            .unwrap();
        let head = dohc_engine_collab::read_marker(&f.store, &key)
            .unwrap()
            .unwrap()
            .head_update_seq;
        actor
            .owner_ydoc_apply_accepted(
                "workspace".into(),
                dohc_engine_collab::owner_outbox::accepted::OwnerAcceptedFrameInput {
                    binding: f.binding.clone(),
                    relay_database_namespace: "relay".into(),
                    expected_revision: 1,
                    expected_native_head_sequence: head,
                    previous_accepted_cursor: 0,
                    journal_cursor: 1,
                    update_bytes: update,
                },
                20,
                CancellationToken::new(),
                Arc::new(()),
            )
            .await
            .unwrap()
            .unwrap();
        if let Some(reason) = reason {
            actor
                .owner_ydoc_outbox_quarantine(
                    "workspace".into(),
                    dohc_engine_collab::OwnerOutboxQuarantineInput {
                        outbox_id: entry.outbox_id.clone(),
                        reason: reason.into(),
                        observed_binding: None,
                    },
                    30,
                    CancellationToken::new(),
                )
                .await
                .unwrap()
                .unwrap();
        }
        assert_eq!(
            stop_action(&actor, &f, "request").await.unwrap()[0].state,
            "requested"
        );
        assert_eq!(
            stop_action(&actor, &f, "release").await.unwrap()[0].state,
            "released"
        );
        assert_eq!(
            stop_action(&actor, &f, "release").await.unwrap()[0].state,
            "released"
        );
        let doc = dohc_engine_collab::load_persisted(&f.store, &key)
            .unwrap()
            .unwrap()
            .doc;
        assert_eq!(doc.frontmatter_json()["pending"], "Owner pending edit");
        assert_eq!(doc.frontmatter_json()["remote"], "Accepted remote edit");
        let update = doc.frontmatter_set("after", "Ordinary edit").unwrap();
        f.record(&actor, update, "after-stop", 41).await;
        assert!(
            f.ordinary_settle(&actor)
                .await
                .unwrap()
                .settled()
                .unwrap()
                .materialized
        );
        let text = std::fs::read_to_string(f.root.path().join(&f.binding.current_path)).unwrap();
        assert!(
            text.contains("Owner pending edit")
                && text.contains("Accepted remote edit")
                && text.contains("Ordinary edit")
        );
        f.store.read_with(|conn| {
            let (updates,authors):(i64,String)=conn.query_row("SELECT (SELECT COUNT(*) FROM replication_log WHERE op_kind='ydoc.update'),(SELECT author_json FROM moments ORDER BY moment_order DESC LIMIT 1)",[],|r|Ok((r.get(0)?,r.get(1)?))).unwrap();
            assert!(updates>=2);assert!(authors.contains("local-person"));
            assert_eq!(conn.query_row("SELECT COUNT(*) FROM owner_ydoc_outboxes",[],|r|r.get::<_,i64>(0)).unwrap(),0);
            Ok::<_,rusqlite::Error>(())
        }).unwrap();
        supervisor.close_all().unwrap();
    }
}

#[tokio::test]
async fn stop_waits_for_current_restore_and_refuses_a_desktop_host() {
    let f = observed_release_fixture();
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&f.db, 3).unwrap().actor;
    support::configure_witness_reader(&actor, &f.root).await;
    let update = f
        .doc
        .frontmatter_set("pending", "Frozen restore work")
        .unwrap();
    let entry = actor
        .owner_ydoc_append_draft(
            "workspace".into(),
            dohc_engine_collab::owner_outbox::draft::OwnerDraftAppendInput {
                person_edit: true,
                binding: f.binding.clone(),
                expected_revision: 1,
                append_key: "pending".into(),
                update,
                now_ms: 10,
                agent_declaration: None,
                automation_declaration: None,
            },
            CancellationToken::new(),
            Arc::new(()),
        )
        .await
        .unwrap()
        .unwrap();
    actor
        .owner_ydoc_outbox_quarantine(
            "workspace".into(),
            dohc_engine_collab::OwnerOutboxQuarantineInput {
                outbox_id: entry.outbox_id,
                reason: "restore-fenced".into(),
                observed_binding: None,
            },
            20,
            CancellationToken::new(),
        )
        .await
        .unwrap()
        .unwrap();
    stop_action(&actor, &f, "request").await.unwrap();
    let before = release_snapshot(&f);
    assert!(matches!(
        stop_action(&actor, &f, "release").await,
        Err(dohc_engine_collab::OwnerOutboxError::RestorePending)
    ));
    assert_eq!(release_snapshot(&f), before);
    assert!(
        f.store
            .read_with(|c| dohc_engine_collab::owner_outbox::release::blocked_in(
                c,
                &DocKey::new("workspace", "main", "object").unwrap()
            ))
            .unwrap()
    );
    stop_action(&actor, &f, "clear").await.unwrap();
    supervisor.close_all().unwrap();
    let f = Fixture::new();
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&f.db, 3).unwrap().actor;
    support::configure_witness_reader(&actor, &f.root).await;
    let owner = actor
        .live_application_owner("workspace".into())
        .await
        .unwrap();
    let _host = f.adopt(&owner).await;
    let before = f.counts();
    assert!(matches!(
        stop_action(&actor, &f, "request").await,
        Err(dohc_engine_collab::OwnerOutboxError::DesktopHost)
    ));
    assert_eq!(f.counts(), before);
    supervisor.close_all().unwrap();
}

#[tokio::test]
async fn stop_release_is_atomic_at_both_commit_faults_and_survives_restart() {
    use dohc_engine_storage::{FaultAction, FaultInjector, FaultPoint};
    struct CrashAt(FaultPoint);
    impl FaultInjector for CrashAt {
        fn poll(&self, point: FaultPoint) -> FaultAction {
            if point == self.0 {
                FaultAction::Crash
            } else {
                FaultAction::Continue
            }
        }
    }
    for count in [
        MAX_RELEASE_ENTRIES as usize,
        MAX_RELEASE_ENTRIES as usize + 1,
    ] {
        for point in [
            FaultPoint::StorageBeforePersist,
            FaultPoint::StorageAfterCommitBeforeAck,
        ] {
            let f = observed_release_fixture();
            let supervisor = WorkspaceSupervisor::new();
            let actor = supervisor.open(&f.db, 3).unwrap().actor;
            support::configure_witness_reader(&actor, &f.root).await;
            for index in 0..count {
                let update = f
                    .doc
                    .richdoc_append_paragraph(&format!("Atomic pending edit {index}"));
                actor
                    .owner_ydoc_append_draft(
                        "workspace".into(),
                        dohc_engine_collab::owner_outbox::draft::OwnerDraftAppendInput {
                            person_edit: true,
                            binding: f.binding.clone(),
                            expected_revision: 1,
                            append_key: format!("atomic-{index}"),
                            update,
                            now_ms: 10,
                            agent_declaration: None,
                            automation_declaration: None,
                        },
                        CancellationToken::new(),
                        Arc::new(()),
                    )
                    .await
                    .unwrap()
                    .unwrap();
            }
            stop_action(&actor, &f, "request").await.unwrap();
            let before = release_snapshot(&f);
            assert!(
                actor
                    .owner_ydoc_stop(
                        "workspace".into(),
                        None,
                        Some(f.binding.clone()),
                        None,
                        Some(0),
                        None,
                        "release".into(),
                        30,
                        Arc::new(CrashAt(point)),
                        CancellationToken::new()
                    )
                    .await
                    .unwrap()
                    .is_err()
            );
            supervisor.close_all().unwrap();
            let supervisor = WorkspaceSupervisor::new();
            let actor = supervisor.open(&f.db, 31).unwrap().actor;
            support::configure_witness_reader(&actor, &f.root).await;
            if point == FaultPoint::StorageBeforePersist {
                assert_eq!(release_snapshot(&f), before);
            }
            assert_eq!(
                stop_action(&actor, &f, "release").await.unwrap()[0].state,
                "released"
            );
            let counts = release_snapshot(&f);
            assert_eq!(
                stop_action(&actor, &f, "release").await.unwrap()[0].state,
                "released"
            );
            assert_eq!(release_snapshot(&f), counts);
            let doc = dohc_engine_collab::load_persisted(
                &f.store,
                &DocKey::new("workspace", "main", "object").unwrap(),
            )
            .unwrap()
            .unwrap()
            .doc;
            assert_eq!(
                doc.project(ContentKind::Richdoc)
                    .unwrap()
                    .content
                    .contains("Atomic pending edit"),
                count <= MAX_RELEASE_ENTRIES as usize
            );
            supervisor.close_all().unwrap();
        }
    }
}

#[tokio::test]
async fn stop_refuses_device_hosts_and_synthetic_restore_fences_without_mutation() {
    for hosted in [false, true] {
        let mut f = observed_release_fixture();
        if !hosted {
            let supervisor = WorkspaceSupervisor::new();
            let actor = supervisor.open(&f.db, 3).unwrap().actor;
            support::configure_witness_reader(&actor, &f.root).await;
            stop_action(&actor, &f, "request").await.unwrap();
            supervisor.close_all().unwrap();
        }
        f.store.write_with(&NoFaults, |tx| {
            if hosted {
                tx.execute("INSERT INTO live_device_application_bindings (relay_database_namespace,workspace_id,main_version_id,object_id,lineage_claim_id,current_path,selector_paths_json,restore_fence_generation,host_id,host_epoch,instance_id,connection_id,available) VALUES ('relay','workspace','main','object',?1,'notes/owner.md','[\"notes/owner.md\"]',0,'host',1,'instance','connection',1)", [&f.binding.lineage_claim_id]).unwrap();
            } else {
                tx.execute("INSERT INTO live_restore_fences(workspace_id,main_version_id,object_id,relay_database_namespace,operation_id,input_json,receipt_json) VALUES ('workspace','main','object','relay','synthetic','{}','{}')", []).unwrap();
            }
            Ok::<_, dohc_engine_storage::StorageError>(())
        }).unwrap();
        let before = f.counts();
        let supervisor = WorkspaceSupervisor::new();
        let actor = supervisor.open(&f.db, 3).unwrap().actor;
        support::configure_witness_reader(&actor, &f.root).await;
        let result = stop_action(&actor, &f, if hosted { "request" } else { "release" }).await;
        assert!(if hosted {
            matches!(
                result,
                Err(dohc_engine_collab::OwnerOutboxError::DesktopHost)
            )
        } else {
            matches!(result, Err(dohc_engine_collab::OwnerOutboxError::Corrupt))
        });
        assert_eq!(f.counts(), before);
        supervisor.close_all().unwrap();
    }
}

fn sized_release_updates(f: &mut Fixture, count: usize, total: usize) -> Vec<Vec<u8>> {
    let mut updates = Vec::new();
    for index in 0..count {
        let target = total / count + usize::from(index < total % count);
        let base = f.doc.encode_full_state();
        let mut length = target - 80;
        loop {
            let doc = Ydoc::wire();
            doc.apply(&base).unwrap();
            let update = doc.richdoc_append_paragraph(&"x".repeat(length));
            if update.len() == target {
                f.doc = doc;
                updates.push(update);
                break;
            }
            length = (length as isize + target as isize - update.len() as isize) as usize;
        }
    }
    updates
}

// Seed real, dependent Yjs deltas without timing the unrelated draft append
// path. The first append creates the actual outbox; the rest copy its schema.
async fn pending_release_fixture(count: usize) -> (Fixture, WorkspaceSupervisor, ActorHandle) {
    pending_release_fixture_sized(
        count,
        (count == MAX_RELEASE_ENTRIES as usize).then_some(MAX_RELEASE_BYTES as usize),
    )
    .await
}

async fn pending_release_fixture_sized(
    count: usize,
    size: Option<usize>,
) -> (Fixture, WorkspaceSupervisor, ActorHandle) {
    let mut f = observed_release_fixture();
    let mut pending_bytes = 0;
    let updates: Vec<_> = if let Some(size) = size {
        sized_release_updates(&mut f, count, size)
    } else {
        (0..count)
            .map(|index| {
                f.doc
                    .richdoc_append_paragraph(&format!("Pending edit {index}"))
            })
            .take_while(|update| {
                pending_bytes += update.len();
                pending_bytes <= 1_000_000
            })
            .collect()
    };
    pending_release_fixture_updates(f, updates).await
}

async fn pending_release_fixture_updates(
    mut f: Fixture,
    updates: Vec<Vec<u8>>,
) -> (Fixture, WorkspaceSupervisor, ActorHandle) {
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&f.db, 3).unwrap().actor;
    support::configure_witness_reader(&actor, &f.root).await;
    let count = updates.len();
    if let Some(first) = updates.first() {
        let entry = actor
            .owner_ydoc_append_draft(
                "workspace".into(),
                dohc_engine_collab::owner_outbox::draft::OwnerDraftAppendInput {
                    person_edit: true,
                    binding: f.binding.clone(),
                    expected_revision: 1,
                    append_key: "pending-0".into(),
                    update: first.clone(),
                    now_ms: 10,
                    agent_declaration: None,
                    automation_declaration: None,
                },
                CancellationToken::new(),
                Arc::new(()),
            )
            .await
            .unwrap()
            .unwrap();
        f.store.write_with(&NoFaults, |tx| {
            let mut total = first.len();
            for (index, update) in updates.iter().enumerate().skip(1) {
                let digest = hex_sha256(update);
                dohc_engine_storage::put_binary_blob_with_sha(tx, update, &digest)?;
                total += update.len();
                tx.execute("INSERT INTO owner_ydoc_outbox_entries (outbox_id,sequence,append_key,delivery_id,update_digest,update_blob_digest,byte_length,created_at_ms,pending,result_pending_bytes,result_oldest_entry_at_ms,result_state,draft_binding_revision,person_edit) SELECT outbox_id,?1,?2,?2,?3,?3,?4,created_at_ms,pending,?5,result_oldest_entry_at_ms,result_state,draft_binding_revision,person_edit FROM owner_ydoc_outbox_entries WHERE append_key='pending-0'",
                    rusqlite::params![index as i64+1,format!("pending-{index}"),digest,update.len() as i64,total as i64]).unwrap();
            }
            tx.execute("UPDATE owner_ydoc_outboxes SET next_sequence=?2,pending_bytes=?3 WHERE outbox_id=?1",rusqlite::params![entry.outbox_id,count as i64+1,total as i64]).unwrap();
            Ok::<_,dohc_engine_storage::StorageError>(())
        }).unwrap();
    }
    stop_action(&actor, &f, "request").await.unwrap();
    (f, supervisor, actor)
}

#[tokio::test]
#[ignore = "manual shipped-profile fold and full-cap count timing"]
async fn measure_stop_fold_limits_and_full_cap_count() {
    for (count, bytes) in [(8, 1024), (32, 4096), (64, 16384)] {
        if count > MAX_RELEASE_ENTRIES as usize {
            continue;
        }
        for run in 0..21 {
            let (f, supervisor, actor) = pending_release_fixture_sized(count, Some(bytes)).await;
            let started = std::time::Instant::now();
            let rows = stop_action(&actor, &f, "release").await.unwrap();
            let elapsed = started.elapsed().as_secs_f64() * 1000.0;
            assert!(rows[0].deferred.is_none());
            let native_count: i64 = f
                .store
                .read_with(|conn| {
                    conn.query_row("SELECT COUNT(*) FROM ydoc_updates", [], |r| r.get(0))
                })
                .unwrap();
            assert_eq!(native_count, count as i64);
            println!("stop_fold entries={count} bytes={bytes} run={run} ms={elapsed:.3}");
            supervisor.close_all().unwrap();
        }
    }
    let (mut f, supervisor, actor) = pending_release_fixture_sized(1, Some(128)).await;
    f.store.write_with(&NoFaults, |tx| {
        // 524,288 metadata rows of 128 bytes exactly fill the 64 MiB profile.
        tx.execute("WITH RECURSIVE n(i) AS (VALUES(2) UNION ALL SELECT i+1 FROM n WHERE i<524288) INSERT INTO owner_ydoc_outbox_entries(outbox_id,sequence,append_key,delivery_id,update_digest,update_blob_digest,byte_length,created_at_ms,pending,result_pending_bytes,result_oldest_entry_at_ms,result_state,draft_binding_revision,person_edit) SELECT e.outbox_id,n.i,'cap-'||n.i,'cap-'||n.i,e.update_digest,e.update_blob_digest,128,e.created_at_ms,1,n.i*128,e.result_oldest_entry_at_ms,e.result_state,e.draft_binding_revision,e.person_edit FROM n CROSS JOIN owner_ydoc_outbox_entries e WHERE e.sequence=1", []).unwrap();
        tx.execute("UPDATE owner_ydoc_outbox_entries SET byte_length=128 WHERE sequence=1",[]).unwrap();
        tx.execute("UPDATE owner_ydoc_outboxes SET pending_bytes=67108864,next_sequence=524289,state='sealed'",[]).unwrap();
        tx.execute("UPDATE ydoc_owner_bindings SET max_pending_bytes=67108864",[]).unwrap();
        Ok::<_,dohc_engine_storage::StorageError>(())
    }).unwrap();
    let rows = stop_action(&actor, &f, "release").await.unwrap();
    assert_eq!(rows[0].deferred.as_ref().unwrap().unsent_edits, 524288);
    for run in 0..21 {
        let started = std::time::Instant::now();
        let rows = stop_action(&actor, &f, "list").await.unwrap();
        let elapsed = started.elapsed().as_secs_f64() * 1000.0;
        assert_eq!(rows[0].deferred.as_ref().unwrap().unsent_edits, 524288);
        println!("stop_full_cap_list entries=524288 bytes=67108864 run={run} ms={elapsed:.3}");
    }
    supervisor.close_all().unwrap();
}

#[tokio::test]
async fn stop_release_entry_and_byte_bounds_are_inclusive() {
    for count in [
        0,
        MAX_RELEASE_ENTRIES as usize - 1,
        MAX_RELEASE_ENTRIES as usize,
    ] {
        let (f, supervisor, actor) = pending_release_fixture(count).await;
        let result = stop_action(&actor, &f, "release").await.unwrap();
        assert!(result[0].deferred.is_none());
        assert_eq!(f.store.table_row_count("ydoc_owner_bindings").unwrap(), 0);
        assert_eq!(
            f.store.table_row_count("ydoc_updates").unwrap(),
            count as i64
        );
        supervisor.close_all().unwrap();
    }
    for size in [
        MAX_RELEASE_BYTES as usize - 1,
        MAX_RELEASE_BYTES as usize,
        MAX_RELEASE_BYTES as usize + 1,
    ] {
        let (mut f, supervisor, actor) = pending_release_fixture(1).await;
        f.doc = Ydoc::wire();
        f.doc.apply(&f.bytes).unwrap();
        let update = sized_release_updates(&mut f, 1, size).pop().unwrap();
        let digest = hex_sha256(&update);
        f.store.write_with(&NoFaults,|tx| {
            dohc_engine_storage::put_binary_blob_with_sha(tx,&update,&digest)?;
            tx.execute("UPDATE owner_ydoc_outbox_entries SET update_digest=?1,update_blob_digest=?1,byte_length=?2,result_pending_bytes=?2",rusqlite::params![digest,size as i64]).unwrap();
            tx.execute("UPDATE owner_ydoc_outboxes SET pending_bytes=?1",[size as i64]).unwrap();
            Ok::<_,dohc_engine_storage::StorageError>(())
        }).unwrap();
        let result = stop_action(&actor, &f, "release").await.unwrap();
        assert_eq!(
            result[0].deferred.is_some(),
            size > MAX_RELEASE_BYTES as usize
        );
        assert_eq!(
            f.store.table_row_count("ydoc_updates").unwrap(),
            i64::from(size <= MAX_RELEASE_BYTES as usize)
        );
        assert_eq!(
            f.store.table_row_count("ydoc_owner_bindings").unwrap(),
            i64::from(size > MAX_RELEASE_BYTES as usize)
        );
        supervisor.close_all().unwrap();
    }
}

#[tokio::test]
async fn stop_defers_a_lost_accepted_receipt_without_double_history() {
    let (mut f, supervisor, actor) = pending_release_fixture(1).await;
    let declaration = AgentDeclaration {
        agent_id: "lost-receipt-agent".into(),
        on_behalf_of: Some("owner".into()),
        depth: 1,
    };
    f.store
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "UPDATE owner_ydoc_outbox_entries SET delivery_id='remote-1',person_edit=NULL,agent_declaration_json=?1",
                [serde_json::to_string(&declaration).unwrap()],
            )
            .unwrap();
            Ok::<_, dohc_engine_storage::StorageError>(())
        })
        .unwrap();
    let host = Fixture::new();
    let host_actor = supervisor.open(&host.db, 3).unwrap().actor;
    support::configure_witness_reader(&host_actor, &host.root).await;
    let host_owner = host_actor
        .live_application_owner("workspace".into())
        .await
        .unwrap();
    let host_handle = host.adopt(&host_owner).await;
    let update = f
        .store
        .read_with(|conn| {
            let digest: String = conn
                .query_row(
                    "SELECT update_digest FROM owner_ydoc_outbox_entries",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            dohc_engine_storage::get_binary_blob(conn, &digest).map(Option::unwrap)
        })
        .unwrap();
    let (receipt, _) =
        deliver_declared(&host_handle, &host.binding, 1, &update, declaration.clone()).await;
    let saved = host.settle(&host_handle, Some(receipt)).await;
    assert_eq!(
        host.moment_authors(&saved.moment_id)[0]["agentId"],
        declaration.agent_id
    );
    let before = release_snapshot(&f);
    // The relay has accepted this entry at cursor 1, but its receipt was lost.
    let row = stop_action_at_cursor(&actor, &f, "release", 1)
        .await
        .unwrap()
        .remove(0);
    assert_eq!(row.deferred.as_ref().unwrap().unsent_edits, 1);
    assert_eq!(row.state, "released");
    assert_eq!(release_snapshot(&f)[1..], before[1..]);
    assert!(
        f.store
            .read_with(|conn| conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM ydoc_owner_bindings)",
                [],
                |r| r.get::<_, bool>(0)
            ))
            .unwrap()
    );
    stop_action(&actor, &f, "clear").await.unwrap();
    let (revision, head): (i64, i64) = f
        .store
        .read_with(|conn| {
            conn.query_row(
                "SELECT binding_revision,native_head_sequence FROM ydoc_owner_bindings",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
        })
        .unwrap();
    let update = f
        .store
        .read_with(|conn| {
            let digest: String = conn
                .query_row(
                    "SELECT update_digest FROM owner_ydoc_outbox_entries WHERE pending=1",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            dohc_engine_storage::get_binary_blob(conn, &digest).map(|bytes| bytes.unwrap())
        })
        .unwrap();
    actor
        .owner_ydoc_apply_accepted(
            "workspace".into(),
            dohc_engine_collab::owner_outbox::accepted::OwnerAcceptedFrameInput {
                binding: f.binding.clone(),
                relay_database_namespace: "relay".into(),
                expected_revision: revision,
                expected_native_head_sequence: head,
                previous_accepted_cursor: 0,
                journal_cursor: 1,
                update_bytes: update,
            },
            41,
            CancellationToken::new(),
            Arc::new(()),
        )
        .await
        .unwrap()
        .unwrap();
    // Resume replays the receipt before another Stop releases this draft.
    let (outbox, digest): (String, String) = f
        .store
        .read_with(|conn| {
            conn.query_row(
                "SELECT outbox_id,update_digest FROM owner_ydoc_outbox_entries WHERE pending=1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
        })
        .unwrap();
    actor
        .owner_ydoc_outbox_acknowledge(
            "workspace".into(),
            outbox,
            vec![dohc_engine_collab::OwnerDeliveryReceipt {
                delivery_id: "remote-1".into(),
                update_digest: digest,
                journal_cursor: 1,
                accepting_host_epoch: 1,
            }],
            CancellationToken::new(),
        )
        .await
        .unwrap()
        .unwrap();
    // The host's authenticated History boundary arrives before unbinding.
    let mut envelope=host.store.read_with(|conn| conn.query_row("SELECT payload_json,recorded_at_ms FROM replication_log WHERE op_kind='moment.append' AND json_extract(payload_json,'$.momentId')=?1",[&saved.moment_id],|r| Ok(dohc_engine_sync::ReplicationEnvelope {
        workspace_id:"workspace".into(),origin_id:"host".into(),origin_seq:0,relay_seq:Some(1),op_kind:"moment.append".into(),payload:serde_json::from_str(&r.get::<_,String>(0)?).unwrap(),recorded_at_ms:r.get(1)?,settlement_admission:Some(dohc_engine_sync::SettlementAdmission::Accepted{settlement_id:saved.settlement_id.clone().unwrap()}),admitted_author_snapshot:Some(serde_json::json!([dohc_engine_collab::live_update_application::LiveAuthorEntry::from(declaration.clone())]))
    }))).unwrap();
    envelope.payload.as_object_mut().unwrap().remove("authors");
    let blobs: Vec<(String, String)> = host
        .store
        .read_with(|conn| {
            let mut stmt = conn.prepare("SELECT sha256,text FROM blobs").unwrap();
            stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
        })
        .unwrap();
    f.store
        .write_with(&NoFaults, |tx| {
            // Seed the committed output of the authenticated audit import;
            // its parser and proof checks have their own sync coverage.
            let record=envelope.payload["settlementReference"]["record"].to_string();
            for (digest, text) in blobs {
                tx.execute(
                    "INSERT OR IGNORE INTO blobs(sha256,byte_length,text) VALUES(?1,?2,?3)",
                    rusqlite::params![digest, text.len() as i64, text],
                )
                .unwrap();
            }
            tx.execute("INSERT INTO live_audit_settlements(settlement_id,workspace_id,record_digest,record_json,markdown_digest) VALUES(?1,'workspace',?2,?3,?4)",rusqlite::params![saved.settlement_id,hex_sha256(record.as_bytes()),record,envelope.payload["payloadAfterBlobSha256"].as_str().unwrap()]).unwrap();
            Ok::<_, dohc_engine_storage::StorageError>(())
        })
        .unwrap();
    let applied = settled_apply(
        &mut f.store,
        &mut dohc_engine_collab::WriterDocCache::new(),
        &envelope,
        &NoFaults,
        &dohc_engine_sync::NoLiveLeases,
    )
    .unwrap();
    assert!(
        matches!(
            applied.primary,
            dohc_engine_sync::ApplyDisposition::Applied(_)
        ),
        "{applied:?}"
    );
    stop_action(&actor, &f, "request").await.unwrap();
    stop_action_at_cursor(&actor, &f, "release", 1)
        .await
        .unwrap();
    actor
        .materialize_relay_page(
            "workspace".into(),
            f.root.path().to_owned(),
            vec![dohc_engine_sync::MomentMaterializationChange {
                version_id: "main".into(),
                path: f.binding.current_path.clone(),
                operation: "write",
                content_kind: "text",
            }],
            Arc::new(()),
            42,
            CancellationToken::new(),
        )
        .await
        .unwrap();
    let key = DocKey::new("workspace", "main", "object").unwrap();
    let state = actor
        .ydoc_open_state(
            "workspace".into(),
            43,
            false,
            Some(key.clone()),
            "main".into(),
            f.binding.current_path.clone(),
            Some(ContentKind::Richdoc),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    actor
        .ydoc_settle(
            f.root.path().to_owned(),
            key,
            f.binding.current_path.clone(),
            ContentKind::Richdoc,
            Some(f.binding.lineage_claim_id.clone()),
            state.head_blob_sha256,
            "owner-live-stop".into(),
            Arc::new(()),
            44,
            Arc::new(NoFaults),
            CancellationToken::new(),
            None,
            None,
        )
        .await
        .unwrap();
    f.store.read_with(|conn| {
        let count:i64=conn.query_row("SELECT COUNT(*) FROM ydoc_updates WHERE is_seed=0",[],|r|r.get(0)).unwrap();
        assert_eq!(count,1,"the accepted edit must not be appended again by Stop");
        let text:String=conn.query_row("SELECT text FROM blobs WHERE sha256=(SELECT blob_sha256 FROM snapshots WHERE object_id='object')",[],|r|r.get(0)).unwrap();
        assert_eq!(text.matches("Pending edit 0").count(),1);
        let credits:i64=conn.query_row("SELECT COUNT(*) FROM moments WHERE instr(author_json,'lost-receipt-agent')>0",[],|r|r.get(0)).unwrap();
        assert_eq!(credits,1,"Stop must not mint a second credited History boundary");
        Ok::<_,rusqlite::Error>(())
    }).unwrap();
    host_owner.close().await.unwrap();
    supervisor.close_all().unwrap();
}

#[tokio::test]
async fn stop_requested_work_precedes_sixty_four_deferred_rows() {
    let (mut f, supervisor, actor) = pending_release_fixture(0).await;
    f.store.write_with(&NoFaults,|tx| {
        let saved:String=tx.query_row("SELECT binding_json FROM owner_live_stops",[],|r|r.get(0)).unwrap();
        for index in 0..64 {
            let mut row:serde_json::Value=serde_json::from_str(&saved).unwrap();
            let object=format!("aaa-deferred-{index:02}");
            row["binding"]["objectId"]=serde_json::json!(object);
            row["document"]["objectId"]=serde_json::json!(object);
            row["retirementOwed"]=serde_json::json!(false);
            row["deferred"]=serde_json::json!({"unsentEdits":0,"editable":true});
            tx.execute("INSERT INTO file_objects(workspace_id,object_id,created_at_ms) VALUES('workspace',?1,1)",[&object]).unwrap();
            tx.execute("INSERT INTO ydoc_docs(workspace_id,version_id,object_id,content_kind,regime,head_update_seq,head_snapshot_seq,lineage_claim_status,updated_at_ms) VALUES('workspace','main',?1,'richdoc','local-only',0,0,'unclaimed',1)",[&object]).unwrap();
            tx.execute("INSERT INTO owner_live_stops(workspace_id,main_version_id,object_id,relay_database_namespace,state,binding_json,requested_at_ms,updated_at_ms) VALUES('workspace','main',?1,'relay','released',?2,1,1)",rusqlite::params![object,row.to_string()]).unwrap();
        }
        Ok::<_,dohc_engine_storage::StorageError>(())
    }).unwrap();
    let rows = stop_action(&actor, &f, "list").await.unwrap();
    assert_eq!(rows.len(), 64);
    assert_eq!(rows[0].document.object_id, "object");
    assert!(rows[0].retirement_owed);
    supervisor.close_all().unwrap();
}

// A Try again names the kept edits its record holds. It never starts a
// release, and an older finished Stop restored under the same binding, which
// took other edits, does not answer for the newer record.
#[tokio::test]
async fn stop_try_again_answers_only_for_its_own_kept_edits() {
    let (mut f, supervisor, actor) = pending_release_fixture(1).await;
    let (older, newer) = ("1".repeat(64), "2".repeat(64));
    let kept = |accepted_cursor: Option<i64>, snapshot: &str| {
        actor.owner_ydoc_stop(
            "workspace".into(),
            None,
            Some(f.binding.clone()),
            None,
            accepted_cursor,
            Some(snapshot.to_owned()),
            "release".into(),
            41,
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
    };
    let before = release_snapshot(&f);
    assert!(matches!(
        kept(None, &newer).await.unwrap(),
        Err(dohc_engine_collab::OwnerOutboxError::StopConflict)
    ));
    assert_eq!(release_snapshot(&f), before);
    let released = kept(Some(0), &newer).await.unwrap().unwrap();
    assert_eq!(released[0].kept_snapshot.as_deref(), Some(newer.as_str()));
    assert_eq!(
        kept(None, &newer).await.unwrap().unwrap()[0].state,
        "released"
    );
    assert!(matches!(
        kept(None, &older).await.unwrap(),
        Err(dohc_engine_collab::OwnerOutboxError::StopConflict)
    ));
    // The engine store restored to the older Stop's state.
    f.store
        .write_with(&NoFaults, |tx| {
            let saved: String = tx
                .query_row("SELECT binding_json FROM owner_live_stops", [], |r| {
                    r.get(0)
                })
                .unwrap();
            let mut row: serde_json::Value = serde_json::from_str(&saved).unwrap();
            row["keptSnapshot"] = serde_json::json!(older);
            tx.execute(
                "UPDATE owner_live_stops SET binding_json=?1",
                [row.to_string()],
            )
            .unwrap();
            Ok::<_, dohc_engine_storage::StorageError>(())
        })
        .unwrap();
    assert!(matches!(
        kept(None, &newer).await.unwrap(),
        Err(dohc_engine_collab::OwnerOutboxError::StopConflict)
    ));
    assert!(matches!(
        kept(Some(0), &newer).await.unwrap(),
        Err(dohc_engine_collab::OwnerOutboxError::StopConflict)
    ));
    supervisor.close_all().unwrap();
}

#[tokio::test]
async fn stop_waits_for_unapplied_owner_settlements() {
    let (mut f, supervisor, actor) = pending_release_fixture(1).await;
    f.store.write_with(&NoFaults,|tx| {
        tx.execute("INSERT INTO replication_log(workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms,imported) VALUES('workspace','held',0,'moment.append','{}',1,1)",[]).unwrap();
        tx.execute("INSERT INTO owner_pending_settlements(workspace_id,origin_id,origin_seq,main_version_id,object_id,lineage_claim_id,relay_namespace,binding_json,terminal_cursor) VALUES('workspace','held',0,'main','object',?1,'relay',?2,0)",rusqlite::params![f.binding.lineage_claim_id,serde_json::to_string(&f.binding).unwrap()]).unwrap();
        Ok::<_,dohc_engine_storage::StorageError>(())
    }).unwrap();
    let before = release_snapshot(&f);
    assert!(matches!(
        stop_action(&actor, &f, "release").await,
        Err(dohc_engine_collab::OwnerOutboxError::StopConflict)
    ));
    assert_eq!(release_snapshot(&f), before);
    supervisor.close_all().unwrap();
}

#[tokio::test]
async fn stop_defers_a_settlement_above_the_observed_cursor() {
    let (mut f, supervisor, actor) = pending_release_fixture(1).await;
    f.store.write_with(&NoFaults, |tx| {
        tx.execute("INSERT INTO replication_log(workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms,imported) VALUES('workspace','held',0,'moment.append','{}',1,1)",[]).unwrap();
        tx.execute("INSERT INTO owner_pending_settlements(workspace_id,origin_id,origin_seq,main_version_id,object_id,lineage_claim_id,relay_namespace,binding_json,terminal_cursor) VALUES('workspace','held',0,'main','object',?1,'relay',?2,2)",rusqlite::params![f.binding.lineage_claim_id,serde_json::to_string(&f.binding).unwrap()]).unwrap();
        Ok::<_,dohc_engine_storage::StorageError>(())
    }).unwrap();
    let before = release_snapshot(&f);
    let row = stop_action_at_cursor(&actor, &f, "release", 2)
        .await
        .unwrap()
        .remove(0);
    assert_eq!(row.deferred.unwrap().unsent_edits, 1);
    assert!(!row.retirement_owed);
    assert_eq!(release_snapshot(&f)[1..], before[1..]);
    supervisor.close_all().unwrap();
}

#[tokio::test]
async fn stop_defers_an_entry_contained_by_initial_sync_with_prior_deletion() {
    let (f, supervisor, actor) = pending_release_fixture(1).await;
    let entry = f
        .store
        .read_with(|conn| {
            let digest: String = conn
                .query_row(
                    "SELECT update_digest FROM owner_ydoc_outbox_entries WHERE pending=1",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            dohc_engine_storage::get_binary_blob(conn, &digest).map(Option::unwrap)
        })
        .unwrap();
    let cut = Ydoc::wire();
    cut.apply(&f.bytes).unwrap();
    let vector = cut.encode_state_vector();
    // The earlier accepted deletion rides in the host cut, not in this entry.
    cut.rewrite_content_to_markdown(ContentKind::Richdoc, "Accepted replacement\n")
        .unwrap();
    cut.apply(&entry).unwrap();
    let update = cut.diff(&vector).unwrap();
    assert_ne!(update, entry);
    let head = dohc_engine_collab::read_marker(
        &f.store,
        &DocKey::new("workspace", "main", "object").unwrap(),
    )
    .unwrap()
    .unwrap()
    .head_update_seq;
    actor
        .owner_ydoc_apply_initial_sync(
            "workspace".into(),
            dohc_engine_collab::owner_outbox::accepted::OwnerAcceptedFrameInput {
                binding: f.binding.clone(),
                relay_database_namespace: "relay".into(),
                expected_revision: 1,
                expected_native_head_sequence: head,
                previous_accepted_cursor: 0,
                journal_cursor: 2,
                update_bytes: update,
            },
            cut.encode_state_vector(),
            20,
            CancellationToken::new(),
            Arc::new(()),
        )
        .await
        .unwrap()
        .unwrap();
    f.store
        .read_with(|conn| {
            let exact: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM ydoc_updates WHERE update_blob_sha256=?1",
                    [hex_sha256(&entry)],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(exact, 0, "the accepted cut has different wire bytes");
            Ok::<_, rusqlite::Error>(())
        })
        .unwrap();
    let before = release_snapshot(&f);
    let row = stop_action_at_cursor(&actor, &f, "release", 2)
        .await
        .unwrap()
        .remove(0);
    assert_eq!(row.deferred.unwrap().unsent_edits, 1);
    assert_eq!(
        release_snapshot(&f)[1..],
        before[1..],
        "Stop must not append or credit contained content again"
    );
    let native = dohc_engine_collab::load_persisted(
        &f.store,
        &DocKey::new("workspace", "main", "object").unwrap(),
    )
    .unwrap()
    .unwrap()
    .doc;
    assert_eq!(native.encode_full_state(), cut.encode_full_state());
    assert_eq!(
        native
            .project(ContentKind::Richdoc)
            .unwrap()
            .content
            .matches("Pending edit 0")
            .count(),
        1
    );
    supervisor.close_all().unwrap();
}

fn backspace_updates(bytes: &[u8], count: usize) -> Vec<Vec<u8>> {
    use yrs::updates::decoder::Decode;
    use yrs::{Text, Transact, XmlFragment};
    let doc = yrs::Doc::with_options(yrs::Options {
        client_id: yrs::ClientID::new(777),
        offset_kind: yrs::OffsetKind::Utf16,
        skip_gc: true,
        ..yrs::Options::default()
    });
    doc.transact_mut()
        .apply_update(yrs::Update::decode_v1(bytes).unwrap())
        .unwrap();
    let body = doc.get_or_insert_xml_fragment(dohc_engine_collab::ydoc::ROOT_BODY);
    let text = {
        let txn = doc.transact();
        let paragraph = body
            .children(&txn)
            .last()
            .unwrap()
            .into_xml_element()
            .unwrap();
        paragraph
            .children(&txn)
            .last()
            .unwrap()
            .into_xml_text()
            .unwrap()
    };
    (0..count)
        .map(|_| {
            let mut txn = doc.transact_mut();
            let index = text.len(&txn) - 1;
            text.remove_range(&mut txn, index, 1);
            let update = txn.encode_update_v1();
            let decoded = yrs::Update::decode_v1(&update).unwrap();
            assert!(decoded.insertions(true).is_empty());
            assert!(!decoded.delete_set().is_empty());
            update
        })
        .collect()
}

#[tokio::test]
async fn stop_folds_a_delete_only_entry_against_an_unsent_insertion() {
    let f = observed_release_fixture();
    let insertion = f.doc.richdoc_append_paragraph("Unsent insertion");
    let deletion = backspace_updates(&f.doc.encode_full_state(), 1).remove(0);
    f.doc.apply(&deletion).unwrap();
    let expected = f.doc.encode_full_state();
    let (f, supervisor, actor) =
        pending_release_fixture_updates(f, vec![insertion, deletion]).await;
    assert!(
        stop_action(&actor, &f, "release").await.unwrap()[0]
            .deferred
            .is_none()
    );
    let native = dohc_engine_collab::load_persisted(
        &f.store,
        &DocKey::new("workspace", "main", "object").unwrap(),
    )
    .unwrap()
    .unwrap()
    .doc;
    assert_eq!(native.encode_full_state(), expected);
    assert_eq!(f.store.table_row_count("ydoc_owner_bindings").unwrap(), 0);
    assert_eq!(
        f.store
            .table_row_count("owner_ydoc_outbox_entries")
            .unwrap(),
        0
    );
    let recorded: i64 = f.store.read_with(|conn| conn.query_row("SELECT COUNT(*) FROM replication_log WHERE op_kind='ydoc.update' AND json_extract(payload_json,'$.attribution.actorKind')='human'", [], |r| r.get(0))).unwrap();
    assert_eq!(recorded, 2);
    supervisor.close_all().unwrap();
}

#[tokio::test]
async fn stop_defers_an_accepted_delete_only_entry() {
    let f = observed_release_fixture();
    let deletion = backspace_updates(&f.bytes, 1).remove(0);
    f.doc.apply(&deletion).unwrap();
    let (f, supervisor, actor) = pending_release_fixture_updates(f, vec![deletion]).await;
    let head = dohc_engine_collab::read_marker(
        &f.store,
        &DocKey::new("workspace", "main", "object").unwrap(),
    )
    .unwrap()
    .unwrap()
    .head_update_seq;
    actor
        .owner_ydoc_apply_initial_sync(
            "workspace".into(),
            dohc_engine_collab::owner_outbox::accepted::OwnerAcceptedFrameInput {
                binding: f.binding.clone(),
                relay_database_namespace: "relay".into(),
                expected_revision: 1,
                expected_native_head_sequence: head,
                previous_accepted_cursor: 0,
                journal_cursor: 1,
                update_bytes: f.doc.encode_full_state(),
            },
            f.doc.encode_state_vector(),
            20,
            CancellationToken::new(),
            Arc::new(()),
        )
        .await
        .unwrap()
        .unwrap();
    let before = release_snapshot(&f);
    let row = stop_action_at_cursor(&actor, &f, "release", 1)
        .await
        .unwrap()
        .remove(0);
    assert_eq!(row.deferred.unwrap().unsent_edits, 1);
    assert_eq!(release_snapshot(&f)[1..], before[1..]);
    supervisor.close_all().unwrap();
}

#[tokio::test]
async fn stop_rejects_missing_or_reordered_dependent_entries() {
    for missing in [true, false] {
        let (mut f, supervisor, actor) = pending_release_fixture(2).await;
        f.store.write_with(&NoFaults,|tx| {
            if missing {tx.execute("DELETE FROM owner_ydoc_outbox_entries WHERE sequence=1",[]).unwrap();}
            else {tx.execute("UPDATE owner_ydoc_outbox_entries SET sequence=sequence+10",[]).unwrap();tx.execute("UPDATE owner_ydoc_outbox_entries SET sequence=CASE sequence WHEN 11 THEN 2 ELSE 1 END",[]).unwrap();}
            Ok::<_,dohc_engine_storage::StorageError>(())
        }).unwrap();
        let before = release_snapshot(&f);
        assert!(stop_action(&actor, &f, "release").await.is_err());
        assert_eq!(release_snapshot(&f), before);
        supervisor.close_all().unwrap();
    }
}

#[tokio::test]
async fn stop_without_pending_entries_releases_ordinary_sized_documents() {
    for size in [4096, 50_000, 1_000_000] {
        let f = observed_release_fixture_with_size(size);
        let supervisor = WorkspaceSupervisor::new();
        let actor = supervisor.open(&f.db, 3).unwrap().actor;
        support::configure_witness_reader(&actor, &f.root).await;
        stop_action(&actor, &f, "request").await.unwrap();
        let rows = stop_action(&actor, &f, "release").await.unwrap();
        assert!(rows[0].deferred.is_none());
        assert_eq!(f.store.table_row_count("ydoc_owner_bindings").unwrap(), 0);
        assert_eq!(f.store.table_row_count("ydoc_updates").unwrap(), 0);
        assert_eq!(f.file(), f.text);
        supervisor.close_all().unwrap();
    }
}

#[tokio::test]
async fn stop_count_tracks_append_acknowledgement_and_terminal_cleanup() {
    let (mut f, supervisor, actor) = pending_release_fixture(3).await;
    let count = |f: &Fixture| {
        f.store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT SUM(pending_entry_count) FROM owner_ydoc_outboxes",
                    [],
                    |r| r.get::<_, i64>(0),
                )
            })
            .unwrap()
    };
    assert_eq!(count(&f), 3);
    let (outbox, delivery, digest): (String,String,String) = f.store.read_with(|conn| conn.query_row("SELECT outbox_id,delivery_id,update_digest FROM owner_ydoc_outbox_entries WHERE sequence=1",[],|r| Ok((r.get(0)?,r.get(1)?,r.get(2)?)))).unwrap();
    let update = f.store.get_binary_blob(&digest).unwrap().unwrap();
    let key = DocKey::new("workspace", "main", "object").unwrap();
    let head = dohc_engine_collab::read_marker(&f.store, &key)
        .unwrap()
        .unwrap()
        .head_update_seq;
    actor
        .owner_ydoc_apply_accepted(
            "workspace".into(),
            dohc_engine_collab::owner_outbox::accepted::OwnerAcceptedFrameInput {
                binding: f.binding.clone(),
                relay_database_namespace: "relay".into(),
                expected_revision: 1,
                expected_native_head_sequence: head,
                previous_accepted_cursor: 0,
                journal_cursor: 1,
                update_bytes: update,
            },
            20,
            CancellationToken::new(),
            Arc::new(()),
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        count(&f),
        3,
        "an accepted frame alone does not acknowledge the outbox"
    );
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
    assert_eq!(count(&f), 2);
    f.store
        .write_with(&NoFaults, |tx| {
            tx.execute("DELETE FROM owner_ydoc_outbox_entries WHERE pending=0", [])
                .unwrap();
            Ok::<_, dohc_engine_storage::StorageError>(())
        })
        .unwrap();
    assert_eq!(
        count(&f),
        2,
        "cleaning an acknowledged row must not decrement twice"
    );
    f.store
        .write_with(&NoFaults, |tx| {
            tx.execute("DELETE FROM owner_ydoc_outbox_entries WHERE pending=1", [])
                .unwrap();
            Ok::<_, dohc_engine_storage::StorageError>(())
        })
        .unwrap();
    assert_eq!(count(&f), 0);
    supervisor.close_all().unwrap();
}

#[tokio::test]
async fn stop_defers_above_one_turn_without_publishing_or_losing_entries() {
    let (f, supervisor, actor) = pending_release_fixture(MAX_RELEASE_ENTRIES as usize + 1).await;
    let before = f.counts();
    let retained = release_snapshot(&f);
    let result = stop_action(&actor, &f, "release").await.unwrap();
    assert_eq!(
        f.counts(),
        before,
        "deferral must preserve binding, queue and native log"
    );
    assert_eq!(release_snapshot(&f)[1..], retained[1..]);
    let row = serde_json::to_value(&result[0]).unwrap();
    assert_eq!(row["deferred"]["unsentEdits"], MAX_RELEASE_ENTRIES + 1);
    assert_eq!(row["retirementOwed"], false);
    assert_eq!(row["state"], "released");
    assert_eq!(stop_action(&actor, &f, "release").await.unwrap().len(), 1);
    assert_eq!(f.counts(), before, "retry must never drain a deferred Stop");
    actor
        .owner_ydoc_append_draft(
            "workspace".into(),
            dohc_engine_collab::owner_outbox::draft::OwnerDraftAppendInput {
                person_edit: true,
                binding: f.binding.clone(),
                expected_revision: 1,
                append_key: "after-deferred-stop".into(),
                update: f.doc.richdoc_append_paragraph("Keep editing after Stop"),
                now_ms: 45,
                agent_declaration: None,
                automation_declaration: None,
            },
            CancellationToken::new(),
            Arc::new(()),
        )
        .await
        .unwrap()
        .unwrap();
    let after_edit = release_snapshot(&f);
    assert_eq!(
        stop_action(&actor, &f, "list").await.unwrap()[0]
            .deferred
            .as_ref()
            .unwrap()
            .unsent_edits,
        MAX_RELEASE_ENTRIES + 2
    );
    assert_eq!(
        f.counts(),
        before,
        "deferred draft editing must not publish"
    );
    supervisor.close_all().unwrap();
    let restarted = WorkspaceSupervisor::new();
    let actor = restarted.open(&f.db, 50).unwrap().actor;
    assert_eq!(
        stop_action(&actor, &f, "list").await.unwrap()[0]
            .deferred
            .as_ref()
            .unwrap()
            .unsent_edits,
        MAX_RELEASE_ENTRIES + 2
    );
    assert_eq!(release_snapshot(&f)[1..], after_edit[1..]);
    stop_action(&actor, &f, "clear").await.unwrap();
    assert_eq!(f.store.table_row_count("owner_live_stops").unwrap(), 0);
    assert_eq!(release_snapshot(&f)[1..], after_edit[1..]);
    restarted.close_all().unwrap();
}

#[tokio::test]
#[ignore = "manual shipped-profile Stop command timing"]
async fn measure_stop_release_pending_entries() {
    struct TraceFaults(
        std::time::Instant,
        std::sync::Mutex<Vec<(dohc_engine_storage::FaultPoint, f64)>>,
    );
    impl dohc_engine_storage::FaultInjector for TraceFaults {
        fn poll(&self, point: dohc_engine_storage::FaultPoint) -> dohc_engine_storage::FaultAction {
            self.1
                .lock()
                .unwrap()
                .push((point, self.0.elapsed().as_secs_f64() * 1000.0));
            dohc_engine_storage::FaultAction::Continue
        }
    }
    for count in [
        0,
        MAX_RELEASE_ENTRIES as usize,
        MAX_RELEASE_ENTRIES as usize + 1,
    ] {
        let mut samples = Vec::new();
        for run in 0..21 {
            let (mut f, supervisor, actor) = pending_release_fixture(count).await;
            let declaration = serde_json::to_string(&AgentDeclaration {
                agent_id: "agent-A".into(),
                on_behalf_of: Some("person-A".into()),
                depth: 1,
            })
            .unwrap();
            f.store.write_with(&NoFaults,|tx| {
                tx.execute("UPDATE owner_ydoc_outbox_entries SET person_edit=NULL,agent_declaration_json=?1 WHERE sequence%2=0",[declaration]).unwrap();
                Ok::<_,dohc_engine_storage::StorageError>(())
            }).unwrap();
            let started = std::time::Instant::now();
            let trace = Arc::new(TraceFaults(started, std::sync::Mutex::new(Vec::new())));
            let rows = stop_action(&actor, &f, "release").await.unwrap();
            let fold_ms = started.elapsed().as_secs_f64() * 1000.0;
            if count <= MAX_RELEASE_ENTRIES as usize {
                actor
                    .ydoc_open_state(
                        "workspace".into(),
                        40,
                        false,
                        Some(DocKey::new("workspace", "main", "object").unwrap()),
                        "main".into(),
                        f.binding.current_path.clone(),
                        Some(ContentKind::Richdoc),
                        CancellationToken::new(),
                    )
                    .await
                    .unwrap();
                assert!(
                    f.ordinary_settle_with_faults(&actor, trace.clone())
                        .await
                        .unwrap()
                        .settled()
                        .unwrap()
                        .materialized
                );
            } else {
                assert_eq!(
                    rows[0].deferred.as_ref().unwrap().unsent_edits,
                    count as i64
                );
            }
            let elapsed_ms = started.elapsed().as_secs_f64() * 1000.0;
            samples.push(elapsed_ms);
            for (point, ms) in trace.1.lock().unwrap().iter() {
                println!("stop_phase entries={count} run={run} point={point:?} ms={ms:.3}");
            }
            println!(
                "stop_release entries={count} run={run} fold_ms={fold_ms:.3} command_ms={elapsed_ms:.3}"
            );
            let credits = f
                .store
                .read_with(|conn| {
                    let mut stmt = conn
                        .prepare("SELECT actor_origin_id FROM ydoc_updates ORDER BY seq")
                        .unwrap();
                    Ok::<_, rusqlite::Error>(
                        stmt.query_map([], |r| r.get::<_, String>(0))
                            .unwrap()
                            .map(|r| r.unwrap())
                            .collect::<Vec<_>>(),
                    )
                })
                .unwrap();
            assert_eq!(
                credits.len(),
                if count <= MAX_RELEASE_ENTRIES as usize {
                    count
                } else {
                    0
                }
            );
            for (index, credit) in credits.iter().enumerate() {
                assert_eq!(
                    credit,
                    if index % 2 == 0 {
                        "local-person"
                    } else {
                        "agent-A"
                    }
                );
            }
            supervisor.close_all().unwrap();
        }
        samples.sort_by(f64::total_cmp);
        println!(
            "stop_release_summary entries={count} samples=21 median_ms={:.3} p95_ms={:.3}",
            samples[10], samples[19]
        );
    }
    let mut release_samples = Vec::new();
    let mut append_samples = Vec::new();
    let mut tails = Vec::new();
    for run in 0..21 {
        let (release, append, tail) = release_contention_sample().await;
        println!(
            "stop_writer_sample run={run} release_ms={release:.3} append_ms={append:.3} tail_ms={tail:.3}"
        );
        release_samples.push(release);
        append_samples.push(append);
        tails.push(tail);
    }
    for (name, mut samples) in [
        ("release", release_samples),
        ("append", append_samples),
        ("tail", tails),
    ] {
        samples.sort_by(f64::total_cmp);
        println!(
            "stop_writer_summary component={name} samples=21 median_ms={:.3} p95_ms={:.3}",
            samples[10], samples[19]
        );
    }
}

#[tokio::test]
async fn stop_release_only_queues_another_documents_append_for_its_duration() {
    let mut samples = Vec::new();
    for _ in 0..3 {
        samples.push(release_contention_sample().await);
    }
    // A host stall can stretch one sample; work queued behind Stop stretches all of them.
    assert!(
        samples.iter().any(|(release, _, tail)| tail <= release),
        "Stop held the writer past its own command in every sample: {samples:?}"
    );
}

async fn release_contention_sample() -> (f64, f64, f64) {
    use dohc_engine_storage::{FaultAction, FaultInjector, FaultPoint};
    use std::sync::atomic::{AtomicBool, Ordering};
    struct ObserveCommit(Arc<AtomicBool>);
    impl FaultInjector for ObserveCommit {
        fn poll(&self, point: FaultPoint) -> FaultAction {
            if point == FaultPoint::StorageBeforePersist {
                assert!(
                    self.0.load(Ordering::SeqCst),
                    "the other append was submitted during release"
                );
            }
            FaultAction::Continue
        }
    }
    let (mut f, supervisor, actor) = pending_release_fixture(MAX_RELEASE_ENTRIES as usize).await;
    let key = DocKey::new("workspace", "main", "other").unwrap();
    dohc_engine_domain::VersionedTextStore::new(&mut f.store)
        .write_text(
            &dohc_engine_domain::WriteText {
                workspace_id: "workspace".into(),
                version_id: "main".into(),
                object_id: "other".into(),
                path: "notes/other.md".into(),
                text: f.text.clone(),
                moment_id: "other-base".into(),
                metadata_origin: "api".into(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 19,
                request_id: None,
            },
            &NoFaults,
        )
        .unwrap();
    dohc_engine_collab::claim_base(
        &mut f.store,
        &key,
        ContentKind::Richdoc,
        &f.bytes,
        &NoFaults,
        20,
    )
    .unwrap();
    let other = Ydoc::wire();
    other.apply(&f.bytes).unwrap();
    let record_other = |update, request_id: &str, now_ms| {
        actor.ydoc_record_update(
            key.clone(),
            "notes/other.md".into(),
            ContentKind::Richdoc,
            Regime::Replicated,
            update,
            Some("local-person".into()),
            None,
            Some(f.binding.lineage_claim_id.clone()),
            false,
            None,
            Some(request_id.into()),
            now_ms,
            Arc::new(NoFaults),
            CancellationToken::new(),
            None,
        )
    };
    record_other(
        other.richdoc_append_paragraph("Warm other document"),
        "other-warm",
        37,
    )
    .await
    .unwrap();
    let solo_started = std::time::Instant::now();
    record_other(
        other.richdoc_append_paragraph("Solo document edit"),
        "other-solo",
        38,
    )
    .await
    .unwrap();
    let solo_append = solo_started.elapsed();
    let update = other.richdoc_append_paragraph("Other document edit");
    let submitted = Arc::new(AtomicBool::new(false));
    let start = std::time::Instant::now();
    let release = async {
        actor
            .owner_ydoc_stop(
                "workspace".into(),
                None,
                Some(f.binding.clone()),
                None,
                Some(0),
                None,
                "release".into(),
                40,
                Arc::new(ObserveCommit(submitted.clone())),
                CancellationToken::new(),
            )
            .await
            .unwrap()
            .unwrap();
        start.elapsed()
    };
    let append = async {
        submitted.store(true, Ordering::SeqCst);
        record_other(update, "other-append", 41).await.unwrap();
        start.elapsed()
    };
    let (release, append) = tokio::join!(release, append);
    println!(
        "stop_writer release_ms={:.3} other_append_ms={:.3} tail_ms={:.3}",
        release.as_secs_f64() * 1_000.0,
        append.as_secs_f64() * 1_000.0,
        append.saturating_sub(release).as_secs_f64() * 1_000.0
    );
    println!(
        "stop_writer_baseline solo_append_ms={:.3}",
        solo_append.as_secs_f64() * 1_000.0
    );
    let persisted = dohc_engine_collab::load_persisted(&f.store, &key)
        .unwrap()
        .unwrap();
    assert!(
        persisted
            .doc
            .project(ContentKind::Richdoc)
            .unwrap()
            .content
            .contains("Other document edit")
    );
    supervisor.close_all().unwrap();
    (
        release.as_secs_f64() * 1000.0,
        append.as_secs_f64() * 1000.0,
        append.saturating_sub(release).as_secs_f64() * 1000.0,
    )
}

#[tokio::test]
async fn stop_keeps_each_pending_entrys_declared_credit() {
    let mut f = observed_release_fixture();
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&f.db, 3).unwrap().actor;
    support::configure_witness_reader(&actor, &f.root).await;
    for (index, kind) in [
        "person",
        "agent",
        "agent-other",
        "automation",
        "unattributed",
        "native",
        "person",
    ]
    .iter()
    .enumerate()
    {
        for repetition in 0..1 {
            let update = f
                .doc
                .richdoc_append_paragraph(&format!("credit-{index}-{repetition}-{kind}"));
            actor
                .owner_ydoc_append_draft(
                    "workspace".into(),
                    dohc_engine_collab::owner_outbox::draft::OwnerDraftAppendInput {
                        person_edit: *kind == "person",
                        binding: f.binding.clone(),
                        expected_revision: 1,
                        append_key: format!("credit-{index}-{repetition}"),
                        update,
                        now_ms: 10 + index as i64,
                        agent_declaration: kind.starts_with("agent").then(|| AgentDeclaration {
                            agent_id: "agent-A".into(),
                            on_behalf_of: Some(
                                if *kind == "agent" {
                                    "person-A"
                                } else {
                                    "person-C"
                                }
                                .into(),
                            ),
                            depth: if *kind == "agent" { 2 } else { 3 },
                        }),
                        automation_declaration: (*kind == "automation").then(|| {
                            dohc_engine_domain::AutomationDeclaration {
                                automation_id: "automation-A".into(),
                                attribution: ChangeAttribution {
                                    actor_kind: ChangeActorKind::Automation,
                                    on_behalf_of: Some("person-B".into()),
                                    depth: 1,
                                    run: None,
                                },
                            }
                        }),
                    },
                    CancellationToken::new(),
                    Arc::new(()),
                )
                .await
                .unwrap()
                .unwrap();
        }
    }
    // Native-source credit is trusted local journal metadata, separate from
    // declarations on owner draft entries.
    f.store.write_with(&dohc_engine_storage::NoFaults, |tx| {
        for repetition in 0..1 {
        let append_key = format!("credit-5-{repetition}");
        let digest: String = tx.query_row("SELECT update_digest FROM owner_ydoc_outbox_entries WHERE append_key=?1", [&append_key], |r| r.get(0)).unwrap();
        let native = dohc_engine_collab::owner_outbox::OwnerOutboxNativeSource {
            binding: f.binding.clone(), adoption_id: "native-credit".into(), native_sequence: 10,
            update_digest: digest,
            origin: dohc_engine_collab::owner_outbox::OwnerOutboxNativeOrigin::NativeUpdate {
                actor_origin_id: Some("native-agent".into()), actor_kind: Some("agent".into()),
                on_behalf_of: Some("native-person".into()), chain_depth: Some(3), recorded_at_ms: 9,
            },
        };
        // The entry declares the agent its native row recorded, as an adopted append writes it.
        let declared = serde_json::to_string(&native.agent_declaration().unwrap()).unwrap();
        let source = dohc_engine_collab::owner_outbox::OwnerOutboxSource::Native(native);
        tx.execute("UPDATE owner_ydoc_outbox_entries SET native_source_json=?1,agent_declaration_json=?3,draft_binding_revision=NULL WHERE append_key=?2", [serde_json::to_string(&source).unwrap(),append_key,declared]).unwrap();
        }
        Ok::<_, dohc_engine_storage::StorageError>(())
    }).unwrap();
    stop_action(&actor, &f, "request").await.unwrap();
    stop_action(&actor, &f, "release").await.unwrap();
    let credits = f.store.read_with(|conn| {
        let mut stmt = conn.prepare("SELECT actor_origin_id,actor_kind,on_behalf_of,chain_depth FROM ydoc_updates WHERE workspace_id='workspace' ORDER BY seq").unwrap();
        Ok::<_,dohc_engine_storage::StorageError>(stmt.query_map([],|r|Ok((r.get::<_,Option<String>>(0)?,r.get::<_,Option<String>>(1)?,r.get::<_,Option<String>>(2)?,r.get::<_,Option<i64>>(3)?))).unwrap().map(|r|r.unwrap()).collect::<Vec<_>>())
    }).unwrap();
    assert_eq!(
        credits,
        vec![
            (
                Some("local-person".into()),
                Some("human".into()),
                None,
                Some(0)
            ),
            (
                Some("agent-A".into()),
                Some("agent".into()),
                Some("person-A".into()),
                Some(2)
            ),
            (
                Some("agent-A".into()),
                Some("agent".into()),
                Some("person-C".into()),
                Some(3)
            ),
            (
                Some("automation-A".into()),
                Some("automation".into()),
                Some("person-B".into()),
                Some(1)
            ),
            (None, None, None, None),
            (
                Some("native-agent".into()),
                Some("agent".into()),
                Some("native-person".into()),
                Some(3)
            ),
            (
                Some("local-person".into()),
                Some("human".into()),
                None,
                Some(0)
            ),
        ]
        .into_iter()
        .flat_map(|credit| std::iter::repeat_n(credit, 1))
        .collect::<Vec<_>>()
    );
    // Replaying successive credited rows proves that no later author's delta
    // leaked into an earlier group. The same rows are journaled for peers.
    let grouped = f.store.read_with(|conn| {
        let mut stmt = conn.prepare("SELECT b.bytes FROM ydoc_updates u JOIN binary_blobs b ON b.sha256=u.update_blob_sha256 ORDER BY u.seq").unwrap();
        Ok::<_,rusqlite::Error>(stmt.query_map([],|r|r.get::<_,Vec<u8>>(0)).unwrap().map(|r|r.unwrap()).collect::<Vec<_>>())
    }).unwrap();
    let replay = Ydoc::wire();
    replay.apply(&f.bytes).unwrap();
    for (entry, update) in grouped.iter().enumerate() {
        let index = entry;
        let repetition = 0;
        replay.apply(update).unwrap();
        let text = replay.project(ContentKind::Richdoc).unwrap().content;
        assert!(text.contains(&format!("credit-{index}-{repetition}-")));
        assert!(!text.contains(&format!("credit-{}-{}-", entry + 1, 0)));
    }
    let journaled = f.store.read_with(|conn| {
        let mut stmt = conn.prepare("SELECT payload_json FROM replication_log WHERE op_kind='ydoc.update' ORDER BY origin_seq").unwrap();
        Ok::<_,rusqlite::Error>(stmt.query_map([],|r|r.get::<_,String>(0)).unwrap().map(|r|serde_json::from_str::<serde_json::Value>(&r.unwrap()).unwrap()).collect::<Vec<_>>())
    }).unwrap();
    assert_eq!(journaled.len(), 7);
    for ((payload, update), (actor, kind, behalf, depth)) in
        journaled.iter().zip(&grouped).zip(&credits)
    {
        assert_eq!(payload["updateBlobSha256"], hex_sha256(update));
        assert_eq!(payload["actorOriginId"], serde_json::json!(actor));
        if kind.is_some() {
            assert_eq!(payload["attribution"]["actorKind"], serde_json::json!(kind));
            assert_eq!(
                payload["attribution"]["onBehalfOf"],
                serde_json::json!(behalf)
            );
            assert_eq!(payload["attribution"]["depth"], serde_json::json!(depth));
        } else {
            assert!(payload["attribution"].is_null());
        }
    }
    assert!(
        f.ordinary_settle(&actor)
            .await
            .unwrap()
            .settled()
            .unwrap()
            .materialized
    );
    let authors: String = f
        .store
        .read_with(|conn| {
            conn.query_row(
                "SELECT author_json FROM moments ORDER BY moment_order DESC LIMIT 1",
                [],
                |r| r.get(0),
            )
        })
        .unwrap();
    let authors: Vec<serde_json::Value> = serde_json::from_str(&authors).unwrap();
    let expected = serde_json::json!([
        {"kind":"human","humanId":"local-person"},
        {"kind":"agent","agentId":"agent-A","onBehalfOf":"person-A","depth":2},
        {"kind":"agent","agentId":"agent-A","onBehalfOf":"person-C","depth":3},
        {"kind":"automation","automationId":"automation-A","onBehalfOf":"person-B","depth":1},
        {"kind":"unattributed"},
        {"kind":"agent","agentId":"native-agent","onBehalfOf":"native-person","depth":3}
    ]);
    assert_eq!(authors.len(), 6);
    for author in expected.as_array().unwrap() {
        assert!(authors.contains(author), "{authors:?}");
    }
    supervisor.close_all().unwrap();
}

/// Outside a restore the session host queues no native update of its own:
/// applying accepted work and settling it leave its outbox without one, so
/// retirement never has one to account for.
#[tokio::test]
async fn host_application_and_settlement_queue_no_native_update() {
    let f = Fixture::new();
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&f.db, 3).unwrap().actor;
    let owner = actor
        .live_application_owner("workspace".into())
        .await
        .unwrap();
    let handle = f.adopt(&owner).await;
    let remote = Ydoc::wire();
    remote.apply(&f.bytes).unwrap();
    let declaration = AgentDeclaration {
        agent_id: "remote-agent".into(),
        on_behalf_of: Some("owner".into()),
        depth: 1,
    };
    let mut terminal = None;
    for cursor in 1..=3 {
        let bytes = remote.richdoc_append_paragraph(&format!("Remote paragraph {cursor}"));
        let (receipt, result) =
            deliver_declared(&handle, &f.binding, cursor, &bytes, declaration.clone()).await;
        assert!(matches!(result, ApplicationResult::Applied(..)));
        terminal = Some(receipt);
    }
    let settled = f.settle(&handle, terminal).await;
    assert_eq!(settled.application_count, 3);
    assert!(f.file().contains("Remote paragraph 3"));
    let native: i64 = f
        .store
        .read_with(|conn| {
            conn.query_row(
                "SELECT count(*) FROM owner_ydoc_outbox_entries
                 WHERE json_extract(native_source_json,'$.origin.kind')='nativeUpdate'",
                [],
                |r| r.get(0),
            )
        })
        .unwrap();
    assert_eq!(native, 0);
    supervisor.close_all().unwrap();
}

/// The retirement form of settlement (Sol's plan §3): once Phase A ended
/// the activation's registration, the host settles what it applied through
/// its durable binding alone, materializes it, answers a replay with the
/// same settlement, and refuses a terminal past F.
#[tokio::test]
async fn a_retiring_activation_settles_through_its_durable_binding() {
    let f = Fixture::new();
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&f.db, 3).unwrap().actor;
    let owner = actor
        .live_application_owner("workspace".into())
        .await
        .unwrap();
    let handle = f.adopt(&owner).await;
    let remote = Ydoc::wire();
    remote.apply(&f.bytes).unwrap();
    let declaration = AgentDeclaration {
        agent_id: "remote-agent".into(),
        on_behalf_of: Some("owner".into()),
        depth: 1,
    };
    let mut terminal = None;
    for cursor in 1..=2 {
        let bytes = remote.richdoc_append_paragraph(&format!("Remote paragraph {cursor}"));
        let (receipt, result) =
            deliver_declared(&handle, &f.binding, cursor, &bytes, declaration.clone()).await;
        assert!(matches!(result, ApplicationResult::Applied(..)));
        terminal = Some(receipt);
    }
    let scope = dohc_engine_runtime::actor::OwnedRetirementScope {
        namespace: "relay".into(),
        max_deliveries: 8,
        max_applications: 8,
    };
    let coordinate = ApplicationHostCoordinate {
        host_id: "host".into(),
        host_epoch: 1,
        instance_id: "instance".into(),
        connection_id: "connection".into(),
    };
    let key = |through| RetirementKey {
        object_id: "object".into(),
        lineage_claim_id: f.binding.lineage_claim_id.clone(),
        activation_id: "adoption".into(),
        restore_fence_generation: 0,
        accepted_through: through,
    };
    let reconstruction = || AdmittedNativeHistoryReconstruction {
        policy: NativeHistoryReconstruction {
            working_reserve_bytes: 8 * 1024 * 1024,
        },
        reservation: Arc::new(()),
    };
    owner
        .begin_retirement(scope.clone(), coordinate.clone(), key(10), false)
        .await
        .unwrap();
    assert!(
        handle
            .settle(
                terminal.clone(),
                100,
                f.root.path().to_owned(),
                30,
                Arc::new(NoFaults),
                CancellationToken::new(),
                reconstruction(),
            )
            .await
            .is_err(),
        "Phase A ended its registration"
    );
    let settle = |terminal: Option<LiveUpdateReceipt>, through| {
        owner.settle_retirement(
            scope.clone(),
            coordinate.clone(),
            key(through),
            terminal,
            100,
            f.root.path().to_owned(),
            30,
            Arc::new(NoFaults),
            CancellationToken::new(),
            reconstruction(),
        )
    };
    assert!(matches!(
        settle(terminal.clone(), 1).await,
        Err(dohc_engine_runtime::RuntimeError::LiveApplication(
            ApplicationError::Conflict
        ))
    ));
    let settled = settle(terminal.clone(), 10).await.unwrap();
    assert_eq!((settled.terminal_cursor, settled.application_count), (2, 2));
    assert!(settled.materialized);
    assert!(f.file().contains("Remote paragraph 2"));
    assert_eq!(
        settle(terminal, 10).await.unwrap().settlement_id,
        settled.settlement_id
    );
    assert!(matches!(
        owner
            .reconcile_activation(scope, key(10), None, None)
            .await
            .unwrap(),
        Reconciliation::Reconciled { settle: false, .. }
    ));
    supervisor.close_all().unwrap();
}

/// The cut adopting `captured`, after `prefix` when it succeeds a released
/// chain.
fn imported_cut(
    captured: &ImportedOwnerActivation,
    prefix: Option<RetainedPrefix>,
) -> OwnerAdoptionCut {
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
        terminal_receipt: prefix
            .as_ref()
            .and_then(|prefix| prefix.terminal_receipt.clone()),
        retained_prefix: prefix,
        outbox_limits: dohc_engine_collab::OwnerOutboxLimits {
            max_pending_bytes: 1_000_000,
            max_pending_age_ms: 100_000,
        },
        reconstruction: adoption_reconstruction(),
    }
}

/// The owner's own delivery as the relay accepted it, applied by `handle`.
async fn deliver_owned(
    handle: &dohc_engine_runtime::actor::ActorLiveApplicationHandle,
    binding: &dohc_engine_collab::LiveObjectBinding,
    receipt: &LiveUpdateReceipt,
    bytes: Vec<u8>,
) -> ApplicationResult {
    handle
        .apply(
            AdmittedLiveUpdate {
                metadata: AdmittedLiveUpdateMetadata {
                    accepted: RelayAcceptedLiveUpdate {
                        receipt: receipt.clone(),
                        binding: binding.clone(),
                        authority: ServerDerivedLiveUpdateAuthority::Owner {
                            principal_id: "owner".into(),
                        },
                        received_at_ms: 20 + receipt.journal_cursor,
                    },
                    first_seen: vec![],
                    canonical_version: Some(2),
                    author_snapshot: Some(vec![]),
                    first_seen_deletes: Some(vec![]),
                    checkpoint_coverage: None,
                },
                update_bytes: bytes,
            },
            Arc::new(NoFaults),
            100_000_000,
        )
        .await
        .unwrap()
}

/// An ordinary `ydoc.update` envelope for the document, applied as ordinary
/// sync applies it.
fn import_envelope(
    store: &mut EngineStore,
    origin: &str,
    relay_seq: i64,
    update: &[u8],
    lineage: &str,
    base: bool,
) {
    let digest = store.put_binary_blob(update).unwrap();
    let op = dohc_engine_sync::ReplicationEnvelope {
        settlement_admission: None,
        admitted_author_snapshot: None,
        workspace_id: "workspace".into(),
        origin_id: origin.into(),
        origin_seq: 0,
        relay_seq: Some(relay_seq),
        op_kind: "ydoc.update".into(),
        payload: serde_json::json!({
            "versionId":"main", "objectId":"object", "path":"notes/plan.md", "contentKind":"richdoc",
            "updateBlobSha256":digest, "lineageClaimId":lineage, "isBaseState":base
        }),
        recorded_at_ms: 10 + relay_seq,
    };
    let applied = settled_apply(
        store,
        &mut dohc_engine_collab::WriterDocCache::new(),
        &op,
        &NoFaults,
        &dohc_engine_sync::NoLiveLeases,
    )
    .unwrap();
    assert!(
        !matches!(
            applied.primary,
            dohc_engine_sync::ApplyDisposition::Refused(_)
        ),
        "{origin}: {:?}",
        applied.primary
    );
}

/// The latest pending owner entry: its outbox, delivery and digest.
fn latest_pending(store: &EngineStore) -> (String, String, String) {
    store
        .read_with(|conn| {
            conn.query_row(
                "SELECT outbox_id,delivery_id,update_digest FROM owner_ydoc_outbox_entries WHERE pending=1 ORDER BY sequence DESC LIMIT 1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
        })
        .unwrap()
}

/// The relay's receipt for the latest pending owner entry at `cursor`,
/// saved by the owner without applying it.
async fn accept_latest(actor: &ActorHandle, store: &EngineStore, cursor: i64) -> LiveUpdateReceipt {
    let (outbox, delivery, digest) = latest_pending(store);
    actor
        .owner_ydoc_outbox_acknowledge(
            "workspace".into(),
            outbox,
            vec![dohc_engine_collab::OwnerDeliveryReceipt {
                delivery_id: delivery.clone(),
                update_digest: digest.clone(),
                journal_cursor: cursor,
                accepting_host_epoch: 1,
            }],
            CancellationToken::new(),
        )
        .await
        .unwrap()
        .unwrap();
    LiveUpdateReceipt {
        delivery_id: delivery,
        update_digest: digest,
        journal_cursor: cursor,
        accepting_host_epoch: 1,
    }
}

/// Every row a settlement could write, by table.
fn settlement_counts(store: &EngineStore) -> Vec<i64> {
    [
        "moments",
        "live_device_settlements",
        "materialization_jobs",
        "replication_log",
    ]
    .map(|table| store.table_row_count(table).unwrap())
    .to_vec()
}

/// Each delivery `table` holds, in its order.
fn deliveries(store: &EngineStore, table: &str) -> Vec<String> {
    store
        .read_with(|conn| {
            conn.prepare(&format!(
                "SELECT delivery_id FROM {table} ORDER BY journal_cursor"
            ))?
            .query_map([], |r| r.get(0))?
            .collect::<Result<Vec<String>, _>>()
        })
        .unwrap()
}

/// Sol's round 4b ruling, through the host's real lifecycle: Release, a
/// fresh capture and adoption, Carried application, the first settlement and
/// a restart, with no rewrite aligning the file and the Y.Doc. The root's
/// owner edits C1 and C2 are accepted and never applied, and it retires at
/// B, where its settlement writes the file without them. With `catch_up`, a
/// peer's ordinary edit arrives after the release and ordinary sync projects
/// the whole Y.Doc into the file; otherwise the file stays at B and only the
/// settled-B proof explains the capture. The successor's registration holds
/// C1 until it adopts, its seed's receipt is saved before anything applies,
/// each settlement holds only what applied, a restart replays the settlement
/// with no writes, and once everything applies the file holds the Y.Doc and
/// accepted history holds each delivery once. This is the native lifecycle
/// alone, not the relay's or a peer's convergence.
#[tokio::test]
async fn resume_after_carried_edits_through_the_host() {
    for catch_up in [false, true] {
        resume_through_the_host(catch_up).await;
    }
}

async fn resume_through_the_host(catch_up: bool) {
    let case = format!("catch_up={catch_up}");
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
    dohc_engine_domain::VersionedTextStore::new(&mut store)
        .ensure_main_version("workspace", "main", 0, &NoFaults)
        .unwrap();
    let execute = |store: &mut EngineStore, sql: &str| {
        store
            .write_with(&NoFaults, |tx| {
                tx.execute_batch(sql)
                    .map_err(dohc_engine_storage::StorageError::persist_public)
            })
            .unwrap();
    };
    execute(&mut store, "INSERT INTO sync_identity (workspace_id,origin_id,replication_epoch,stream_identity,created_at_ms) VALUES ('workspace','origin','epoch','stream',1);
        INSERT INTO sync_relay_push_state (workspace_id,origin_id,pushed_seq) VALUES ('workspace','origin',0);
        INSERT INTO sync_relay_cursors (workspace_id,cursor,replication_epoch,stream_identity) VALUES ('workspace','1','epoch','stream')");
    import_envelope(&mut store, "owner-peer", 1, &base, &lineage, true);
    std::fs::create_dir(root.path().join("notes")).unwrap();
    let file = || std::fs::read_to_string(root.path().join(path)).unwrap();
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 3).unwrap().actor;
    actor
        .materialize_replay_pending(root.path().to_owned(), "workspace".into(), 20)
        .await
        .unwrap();
    let capture = || {
        actor.capture_imported_owner_activation(
            "relay".into(),
            key.clone(),
            path.into(),
            1_000_000,
            None,
            CancellationToken::new(),
            Arc::new(()),
        )
    };
    let coordinate = ApplicationHostCoordinate {
        host_id: "host".into(),
        host_epoch: 1,
        instance_id: "instance".into(),
        connection_id: "connection".into(),
    };
    let binding = dohc_engine_collab::LiveObjectBinding {
        workspace_id: "workspace".into(),
        main_version_id: "main".into(),
        object_id: "object".into(),
        lineage_claim_id: lineage.clone(),
        current_path: path.into(),
        selector_paths: vec![path.into()],
        restore_fence_generation: 0,
    };
    let reconstruction = || AdmittedNativeHistoryReconstruction {
        policy: adoption_reconstruction(),
        reservation: Arc::new(()),
    };
    let first = capture().await.unwrap();
    let owner = actor
        .live_application_owner("workspace".into())
        .await
        .unwrap();
    let handle = owner
        .register("relay".into(), coordinate.clone(), binding.clone())
        .await
        .unwrap();
    handle
        .adopt_owner(
            imported_cut(&first, None),
            1_000_000,
            100,
            Arc::new(NoFaults),
            Arc::new(()),
        )
        .await
        .unwrap();
    // The owner's edits: one the host applies, then C1 and C2, which the
    // relay accepts and the host never applies.
    let owned = Ydoc::wire();
    owned.apply(&base).unwrap();
    let record = |update: Vec<u8>, request: &str| {
        actor.ydoc_record_update(
            key.clone(),
            path.into(),
            ContentKind::Richdoc,
            Regime::Replicated,
            update,
            Some("owner-origin".into()),
            None,
            Some(lineage.clone()),
            false,
            None,
            Some(request.into()),
            30,
            Arc::new(NoFaults),
            CancellationToken::new(),
            None,
        )
    };
    let covered_bytes = owned.richdoc_append_paragraph("Covered paragraph");
    record(covered_bytes.clone(), "covered").await.unwrap();
    let covered = accept_latest(&actor, &store, 2).await;
    assert!(matches!(
        deliver_owned(&handle, &binding, &covered, covered_bytes.clone()).await,
        ApplicationResult::Applied(..)
    ));
    record(
        owned.richdoc_append_paragraph("Carried paragraph one"),
        "c1",
    )
    .await
    .unwrap();
    let c1 = accept_latest(&actor, &store, 3).await;
    record(
        owned.richdoc_append_paragraph("Carried paragraph two"),
        "c2",
    )
    .await
    .unwrap();
    let c2 = accept_latest(&actor, &store, 4).await;
    // Stop: Phase A, settlement at B through F, then the document leaves the
    // scope and parks, and the release.
    let scope = dohc_engine_runtime::actor::OwnedRetirementScope {
        namespace: "relay".into(),
        max_deliveries: 8,
        max_applications: 8,
    };
    let retirement = |activation: &str| RetirementKey {
        object_id: "object".into(),
        lineage_claim_id: lineage.clone(),
        activation_id: activation.into(),
        restore_fence_generation: 0,
        accepted_through: 10,
    };
    owner
        .begin_retirement(
            scope.clone(),
            coordinate.clone(),
            retirement(&first.activation_id),
            false,
        )
        .await
        .unwrap();
    owner
        .settle_retirement(
            scope.clone(),
            coordinate.clone(),
            retirement(&first.activation_id),
            Some(covered.clone()),
            100,
            root.path().to_owned(),
            30,
            Arc::new(NoFaults),
            CancellationToken::new(),
            reconstruction(),
        )
        .await
        .unwrap();
    // The replica that hosts the document counts on from its journal.
    execute(&mut store, "INSERT INTO hosted_replicas(workspace_id,scope_generation,created_at_ms,main_cursor,last_outbound_seq)
          VALUES ('workspace',1,0,1,(SELECT COALESCE(MAX(origin_seq),-1) FROM replication_log WHERE origin_id='origin'));
        INSERT INTO hosted_documents(workspace_id,object_id,path,state,scope_generation) VALUES ('workspace','object','notes/plan.md','parked',0)");
    let Release::Released {
        boundary: Some(boundary),
        ..
    } = owner
        .release_activation(
            scope.clone(),
            coordinate.clone(),
            retirement(&first.activation_id),
            40,
        )
        .await
        .unwrap()
    else {
        panic!("{case}: released");
    };
    assert!(
        file().contains("Covered paragraph") && !file().contains("Carried"),
        "{case}: {}",
        file()
    );
    // Resume: the document returns, and with `catch_up` ordinary sync brings
    // a peer's edit and projects the whole Y.Doc.
    execute(
        &mut store,
        "UPDATE hosted_documents SET scope_generation=1,state='ready'",
    );
    if catch_up {
        let peer = Ydoc::wire();
        peer.apply(&base).unwrap();
        peer.apply(&covered_bytes).unwrap();
        import_envelope(
            &mut store,
            "peer",
            2,
            &peer.richdoc_append_paragraph("Peer paragraph"),
            &lineage,
            false,
        );
        execute(&mut store, "UPDATE hosted_replicas SET main_cursor=2");
        actor
            .materialize_replay_pending(root.path().to_owned(), "workspace".into(), 50)
            .await
            .unwrap();
        assert!(
            file().contains("Peer paragraph") && file().contains("Carried paragraph two"),
            "{case}: {}",
            file()
        );
    }
    let next = capture().await.unwrap();
    assert_eq!(
        next.source.predecessor_activation_id.as_deref(),
        Some(first.activation_id.as_str()),
        "{case}"
    );
    let successor = owner
        .register_activation(
            "relay".into(),
            coordinate.clone(),
            binding.clone(),
            next.activation_id.clone(),
        )
        .await
        .unwrap();
    let carried = |receipt: &LiveUpdateReceipt| {
        store
            .get_binary_blob(&receipt.update_digest)
            .unwrap()
            .unwrap()
    };
    let applied = [
        "live_device_update_applications",
        "live_accepted_updates",
        "ydoc_updates",
        "moments",
    ];
    let before = applied.map(|table| store.table_row_count(table).unwrap());
    assert_eq!(
        deliver_owned(&successor, &binding, &c1, carried(&c1)).await,
        ApplicationResult::Pending(ApplicationPending::DeliveryPending),
        "{case}: nothing applies before the successor adopts"
    );
    assert_eq!(
        applied.map(|table| store.table_row_count(table).unwrap()),
        before,
        "{case}"
    );
    successor
        .adopt_owner(
            imported_cut(
                &next,
                Some(RetainedPrefix {
                    terminal_receipt: boundary.terminal_receipt.clone(),
                    event_count: boundary.event_count,
                    history_evidence_digest: boundary.history_evidence_digest.clone(),
                    predecessor_activation_id: first.activation_id.clone(),
                }),
            ),
            1_000_000,
            100,
            Arc::new(NoFaults),
            Arc::new(()),
        )
        .await
        .unwrap();
    let seed = accept_latest(&actor, &store, 11).await;
    assert_eq!(
        seed.update_digest,
        hex_sha256(&next.full_state),
        "{case}: the seed is the captured state"
    );
    assert!(
        matches!(
            deliver_owned(&successor, &binding, &c1, carried(&c1)).await,
            ApplicationResult::Applied(..)
        ),
        "{case}"
    );
    let settled = successor
        .settle(
            Some(c1.clone()),
            100,
            root.path().to_owned(),
            30,
            Arc::new(NoFaults),
            CancellationToken::new(),
            reconstruction(),
        )
        .await
        .unwrap();
    assert!(
        file().contains("Carried paragraph one")
            && !file().contains("two")
            && !file().contains("Peer"),
        "{case}: {}",
        file()
    );
    // A restart, then the same settlement replays with no writes.
    owner.close().await.unwrap();
    supervisor.close_all().unwrap();
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 3).unwrap().actor;
    let owner = actor
        .live_application_owner("workspace".into())
        .await
        .unwrap();
    let successor = owner
        .register_activation(
            "relay".into(),
            coordinate.clone(),
            binding.clone(),
            next.activation_id.clone(),
        )
        .await
        .unwrap();
    let written = settlement_counts(&store);
    let replayed = successor
        .settle(
            Some(c1.clone()),
            100,
            root.path().to_owned(),
            30,
            Arc::new(NoFaults),
            CancellationToken::new(),
            reconstruction(),
        )
        .await
        .unwrap();
    assert_eq!(replayed.settlement_id, settled.settlement_id, "{case}");
    assert_eq!(
        settlement_counts(&store),
        written,
        "{case}: a replay writes nothing"
    );
    assert!(
        matches!(
            deliver_owned(&successor, &binding, &c2, carried(&c2)).await,
            ApplicationResult::Applied(..)
        ),
        "{case}"
    );
    assert!(
        matches!(
            deliver_owned(&successor, &binding, &seed, next.full_state.clone()).await,
            ApplicationResult::Applied(..)
        ),
        "{case}"
    );
    let converged = successor
        .settle(
            Some(seed.clone()),
            100,
            root.path().to_owned(),
            30,
            Arc::new(NoFaults),
            CancellationToken::new(),
            reconstruction(),
        )
        .await
        .unwrap();
    let local = dohc_engine_collab::load_persisted(&store, &key)
        .unwrap()
        .unwrap()
        .doc;
    assert_eq!(
        file(),
        local.project(ContentKind::Richdoc).unwrap().content,
        "{case}"
    );
    assert_eq!(file().contains("Peer paragraph"), catch_up, "{case}");
    let expected = [&covered, &c1, &c2, &seed]
        .map(|receipt| receipt.delivery_id.clone())
        .to_vec();
    assert_eq!(
        deliveries(&store, "live_device_update_applications"),
        expected,
        "{case}: each applies once"
    );
    assert_eq!(
        deliveries(&store, "live_accepted_updates"),
        expected,
        "{case}"
    );
    let written = settlement_counts(&store);
    let again = successor
        .settle(
            Some(seed),
            100,
            root.path().to_owned(),
            30,
            Arc::new(NoFaults),
            CancellationToken::new(),
            reconstruction(),
        )
        .await
        .unwrap();
    assert_eq!(again.settlement_id, converged.settlement_id, "{case}");
    assert_eq!(settlement_counts(&store), written, "{case}");
    owner.close().await.unwrap();
    supervisor.close_all().unwrap();
}

/// Sol's round 4b ruling, rename, through the host: the root's C1 and C2 are
/// Carried when it releases, ordinary sync projects the whole Y.Doc into the
/// file, and a person renames the document through the host's rename before
/// the successor captures it at the new path. The successor adopts there:
/// its coverage takes the root's outbox at the old path, C1 and C2 stay where
/// the root queued them, with their receipts, and its seed opens the outbox
/// at its own binding while the root's is retired. A rename while it holds
/// the document is refused, and its later edit is delivered from its own
/// outbox. Applying C1 and C2 at the new path is round 4b3b's.
#[tokio::test]
async fn a_successor_adopts_across_a_rename_through_the_host() {
    let root = ScratchDir::new().unwrap();
    let db = engine_db_path(&root).unwrap();
    let mut store = EngineStore::open(&db, 0).unwrap();
    let (path, renamed) = ("notes/plan.md", "notes/renamed.md");
    let key = DocKey::new("workspace", "main", "object").unwrap();
    let source: serde_json::Value = serde_json::from_str(include_str!(
        "../../dohc-engine-collab/tests/owner-source/owner-source-seed.json"
    ))
    .unwrap();
    let base: Vec<u8> = serde_json::from_value(source["bytes"].clone()).unwrap();
    let lineage = hex_sha256(&base);
    dohc_engine_domain::VersionedTextStore::new(&mut store)
        .ensure_main_version("workspace", "main", 0, &NoFaults)
        .unwrap();
    let execute = |store: &mut EngineStore, sql: &str| {
        store
            .write_with(&NoFaults, |tx| {
                tx.execute_batch(sql)
                    .map_err(dohc_engine_storage::StorageError::persist_public)
            })
            .unwrap();
    };
    execute(&mut store, "INSERT INTO sync_identity (workspace_id,origin_id,replication_epoch,stream_identity,created_at_ms) VALUES ('workspace','origin','epoch','stream',1);
        INSERT INTO sync_relay_push_state (workspace_id,origin_id,pushed_seq) VALUES ('workspace','origin',0);
        INSERT INTO sync_relay_cursors (workspace_id,cursor,replication_epoch,stream_identity) VALUES ('workspace','1','epoch','stream')");
    import_envelope(&mut store, "owner-peer", 1, &base, &lineage, true);
    std::fs::create_dir(root.path().join("notes")).unwrap();
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 3).unwrap().actor;
    actor
        .materialize_replay_pending(root.path().to_owned(), "workspace".into(), 20)
        .await
        .unwrap();
    let capture = |at: &str| {
        actor.capture_imported_owner_activation(
            "relay".into(),
            key.clone(),
            at.into(),
            1_000_000,
            None,
            CancellationToken::new(),
            Arc::new(()),
        )
    };
    let coordinate = ApplicationHostCoordinate {
        host_id: "host".into(),
        host_epoch: 1,
        instance_id: "instance".into(),
        connection_id: "connection".into(),
    };
    let binding = dohc_engine_collab::LiveObjectBinding {
        workspace_id: "workspace".into(),
        main_version_id: "main".into(),
        object_id: "object".into(),
        lineage_claim_id: lineage.clone(),
        current_path: path.into(),
        selector_paths: vec![path.into()],
        restore_fence_generation: 0,
    };
    let first = capture(path).await.unwrap();
    let owner = actor
        .live_application_owner("workspace".into())
        .await
        .unwrap();
    let handle = owner
        .register("relay".into(), coordinate.clone(), binding.clone())
        .await
        .unwrap();
    handle
        .adopt_owner(
            imported_cut(&first, None),
            1_000_000,
            100,
            Arc::new(NoFaults),
            Arc::new(()),
        )
        .await
        .unwrap();
    // The owner's edits: one the host applies, then C1 and C2, which the
    // relay accepts and the host never applies.
    let owned = Ydoc::wire();
    owned.apply(&base).unwrap();
    let record = |update: Vec<u8>, request: &str| {
        actor.ydoc_record_update(
            key.clone(),
            path.into(),
            ContentKind::Richdoc,
            Regime::Replicated,
            update,
            Some("owner-origin".into()),
            None,
            Some(lineage.clone()),
            false,
            None,
            Some(request.into()),
            30,
            Arc::new(NoFaults),
            CancellationToken::new(),
            None,
        )
    };
    let covered_bytes = owned.richdoc_append_paragraph("Covered paragraph");
    record(covered_bytes.clone(), "covered").await.unwrap();
    let covered = accept_latest(&actor, &store, 2).await;
    assert!(matches!(
        deliver_owned(&handle, &binding, &covered, covered_bytes.clone()).await,
        ApplicationResult::Applied(..)
    ));
    record(
        owned.richdoc_append_paragraph("Carried paragraph one"),
        "c1",
    )
    .await
    .unwrap();
    let c1 = accept_latest(&actor, &store, 3).await;
    record(
        owned.richdoc_append_paragraph("Carried paragraph two"),
        "c2",
    )
    .await
    .unwrap();
    let c2 = accept_latest(&actor, &store, 4).await;
    // Stop: Phase A, settlement at B through F, the document parks, and the
    // release.
    let scope = dohc_engine_runtime::actor::OwnedRetirementScope {
        namespace: "relay".into(),
        max_deliveries: 8,
        max_applications: 8,
    };
    let retirement = RetirementKey {
        object_id: "object".into(),
        lineage_claim_id: lineage.clone(),
        activation_id: first.activation_id.clone(),
        restore_fence_generation: 0,
        accepted_through: 10,
    };
    owner
        .begin_retirement(scope.clone(), coordinate.clone(), retirement.clone(), false)
        .await
        .unwrap();
    owner
        .settle_retirement(
            scope.clone(),
            coordinate.clone(),
            retirement.clone(),
            Some(covered.clone()),
            100,
            root.path().to_owned(),
            30,
            Arc::new(NoFaults),
            CancellationToken::new(),
            AdmittedNativeHistoryReconstruction {
                policy: adoption_reconstruction(),
                reservation: Arc::new(()),
            },
        )
        .await
        .unwrap();
    execute(&mut store, "INSERT INTO hosted_replicas(workspace_id,scope_generation,created_at_ms,main_cursor,last_outbound_seq)
          VALUES ('workspace',1,0,1,(SELECT COALESCE(MAX(origin_seq),-1) FROM replication_log WHERE origin_id='origin'));
        INSERT INTO hosted_documents(workspace_id,object_id,path,state,scope_generation) VALUES ('workspace','object','notes/plan.md','parked',0)");
    let Release::Released {
        boundary: Some(boundary),
        ..
    } = owner
        .release_activation(scope, coordinate.clone(), retirement, 40)
        .await
        .unwrap()
    else {
        panic!("released");
    };
    // The document returns, ordinary sync brings a peer's edit and projects
    // the whole Y.Doc, and a person renames the document.
    execute(
        &mut store,
        "UPDATE hosted_documents SET scope_generation=1,state='ready'",
    );
    let peer = Ydoc::wire();
    peer.apply(&base).unwrap();
    peer.apply(&covered_bytes).unwrap();
    import_envelope(
        &mut store,
        "peer",
        2,
        &peer.richdoc_append_paragraph("Peer paragraph"),
        &lineage,
        false,
    );
    execute(&mut store, "UPDATE hosted_replicas SET main_cursor=2");
    actor
        .materialize_replay_pending(root.path().to_owned(), "workspace".into(), 50)
        .await
        .unwrap();
    actor
        .versioned_text_rename(
            dohc_engine_domain::RenameTextFile {
                workspace_id: "workspace".into(),
                version_id: "main".into(),
                from_path: path.into(),
                to_path: renamed.into(),
                moment_id: "renamed".into(),
                request_id: None,
                metadata_origin: "api".into(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 60,
            },
            root.path().to_owned(),
            Arc::new(()),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    let next = capture(renamed).await.unwrap();
    assert_eq!(
        next.source.predecessor_activation_id.as_deref(),
        Some(first.activation_id.as_str())
    );
    let moved = dohc_engine_collab::LiveObjectBinding {
        current_path: renamed.into(),
        selector_paths: vec![renamed.into()],
        ..binding.clone()
    };
    let successor = owner
        .register_activation(
            "relay".into(),
            coordinate.clone(),
            moved,
            next.activation_id.clone(),
        )
        .await
        .unwrap();
    successor
        .adopt_owner(
            imported_cut(
                &next,
                Some(RetainedPrefix {
                    terminal_receipt: boundary.terminal_receipt.clone(),
                    event_count: boundary.event_count,
                    history_evidence_digest: boundary.history_evidence_digest.clone(),
                    predecessor_activation_id: first.activation_id.clone(),
                }),
            ),
            1_000_000,
            100,
            Arc::new(NoFaults),
            Arc::new(()),
        )
        .await
        .unwrap();
    // Where each entry sits: its outbox's path, its sequence, and the cursor
    // of the receipt it saved.
    let entry = |delivery: &str| -> (String, i64, Option<i64>) {
        store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT o.current_path,e.sequence,json_extract(e.accepted_receipt_json,'$.journalCursor')
                     FROM owner_ydoc_outbox_entries e JOIN owner_ydoc_outboxes o USING(outbox_id) WHERE e.delivery_id=?1",
                    [delivery],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
            })
            .unwrap()
    };
    assert_eq!(entry(&c1.delivery_id), (path.to_owned(), 2, Some(3)));
    assert_eq!(entry(&c2.delivery_id), (path.to_owned(), 3, Some(4)));
    let (_, seed, _) = latest_pending(&store);
    assert_eq!(entry(&seed), (renamed.to_owned(), 1, None));
    let covered_sequence: i64 = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT covered_outbox_sequence FROM live_owner_activations WHERE activation_id=?1",
                [&next.activation_id],
                |r| r.get(0),
            )
        })
        .unwrap();
    assert_eq!(
        covered_sequence, 0,
        "the new binding's outbox held nothing to cover"
    );
    // The adoption retired the root's outbox, so the successor's is the
    // generation's one open outbox.
    let outboxes = || -> Vec<(String, String, Option<String>)> {
        store
            .read_with(|conn| {
                conn.prepare("SELECT current_path,state,quarantine_reason FROM owner_ydoc_outboxes ORDER BY current_path")?
                    .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
                    .collect::<rusqlite::Result<Vec<_>>>()
            })
            .unwrap()
    };
    let expected = vec![
        (
            path.to_owned(),
            "quarantined".to_owned(),
            Some("succession-retired".to_owned()),
        ),
        (renamed.to_owned(), "active".to_owned(), None),
    ];
    assert_eq!(outboxes(), expected);
    // A rename while the successor holds the document changes nothing.
    let moved_again = actor
        .versioned_text_rename(
            dohc_engine_domain::RenameTextFile {
                workspace_id: "workspace".into(),
                version_id: "main".into(),
                from_path: renamed.into(),
                to_path: "notes/again.md".into(),
                moment_id: "renamed-again".into(),
                request_id: None,
                metadata_origin: "api".into(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 70,
            },
            root.path().to_owned(),
            Arc::new(()),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await;
    assert_eq!(
        moved_again.map(|_| ()).map_err(|error| error.code()),
        Err("live-document-binding-active")
    );
    assert_eq!(outboxes(), expected);
    // The seed delivers, and a later native edit at the new path joins the
    // successor's outbox, under the delivery ID the relay derives from it.
    accept_latest(&actor, &store, 5).await;
    actor
        .ydoc_record_update(
            key.clone(),
            renamed.into(),
            ContentKind::Richdoc,
            Regime::Replicated,
            owned.richdoc_append_paragraph("After adoption"),
            Some("owner-origin".into()),
            None,
            Some(lineage.clone()),
            false,
            None,
            Some("after-adoption".into()),
            80,
            Arc::new(NoFaults),
            CancellationToken::new(),
            None,
        )
        .await
        .unwrap();
    let (outbox, delivery, digest) = latest_pending(&store);
    assert_eq!(entry(&delivery), (renamed.to_owned(), 2, None));
    assert_eq!(
        delivery,
        format!(
            "owner-delivery-{}",
            hex_sha256(format!("{outbox}\0{}\0{digest}", 2).as_bytes())
        )
    );
    accept_latest(&actor, &store, 6).await;
    assert_eq!(entry(&delivery), (renamed.to_owned(), 2, Some(6)));
    assert_eq!(outboxes(), expected);
    owner.close().await.unwrap();
    supervisor.close_all().unwrap();
}

const WINDOW_PATH: &str = "notes/plan.md";

/// A document whose root activation adopted through the host and applied
/// the owner's edit at B and, with `carried`, whose next two owner edits the
/// relay accepted and the host never applied. Fields drop in order: the
/// actor closes before its scratch tree goes.
struct HostWindow {
    owner: dohc_engine_runtime::actor::ActorLiveApplicationOwner,
    actor: ActorHandle,
    supervisor: WorkspaceSupervisor,
    store: EngineStore,
    first: ImportedOwnerActivation,
    coordinate: ApplicationHostCoordinate,
    covered: LiveUpdateReceipt,
    lineage: String,
    base: Vec<u8>,
    covered_bytes: Vec<u8>,
    root: ScratchDir,
}

/// The host before any activation: the document's base as ordinary sync
/// brought it, materialized. Fields drop in order.
struct WindowHost {
    actor: ActorHandle,
    supervisor: WorkspaceSupervisor,
    store: EngineStore,
    lineage: String,
    base: Vec<u8>,
    root: ScratchDir,
}

async fn window_host() -> WindowHost {
    let root = ScratchDir::new().unwrap();
    let db = engine_db_path(&root).unwrap();
    let mut store = EngineStore::open(&db, 0).unwrap();
    let source: serde_json::Value = serde_json::from_str(include_str!(
        "../../dohc-engine-collab/tests/owner-source/owner-source-seed.json"
    ))
    .unwrap();
    let base: Vec<u8> = serde_json::from_value(source["bytes"].clone()).unwrap();
    let lineage = hex_sha256(&base);
    dohc_engine_domain::VersionedTextStore::new(&mut store)
        .ensure_main_version("workspace", "main", 0, &NoFaults)
        .unwrap();
    execute(&mut store, "INSERT INTO sync_identity (workspace_id,origin_id,replication_epoch,stream_identity,created_at_ms) VALUES ('workspace','origin','epoch','stream',1);
        INSERT INTO sync_relay_push_state (workspace_id,origin_id,pushed_seq) VALUES ('workspace','origin',0);
        INSERT INTO sync_relay_cursors (workspace_id,cursor,replication_epoch,stream_identity) VALUES ('workspace','1','epoch','stream')");
    import_envelope(&mut store, "owner-peer", 1, &base, &lineage, true);
    std::fs::create_dir(root.path().join("notes")).unwrap();
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 3).unwrap().actor;
    actor
        .materialize_replay_pending(root.path().to_owned(), "workspace".into(), 20)
        .await
        .unwrap();
    WindowHost {
        actor,
        supervisor,
        store,
        lineage,
        base,
        root,
    }
}

async fn adopted_window(carried: bool) -> HostWindow {
    adopt_window(window_host().await, carried).await
}

/// `host`'s root activation in "relay", adopted through the host, as
/// [`HostWindow`] describes it.
async fn adopt_window(host: WindowHost, carried: bool) -> HostWindow {
    let WindowHost {
        actor,
        supervisor,
        store,
        lineage,
        base,
        root,
    } = host;
    let first = actor
        .capture_imported_owner_activation(
            "relay".into(),
            window_key(),
            WINDOW_PATH.into(),
            1_000_000,
            None,
            CancellationToken::new(),
            Arc::new(()),
        )
        .await
        .unwrap();
    let coordinate = window_host_coordinate();
    let binding = window_binding(&lineage);
    let owner = actor
        .live_application_owner("workspace".into())
        .await
        .unwrap();
    let handle = owner
        .register("relay".into(), coordinate.clone(), binding.clone())
        .await
        .unwrap();
    handle
        .adopt_owner(
            imported_cut(&first, None),
            1_000_000,
            100,
            Arc::new(NoFaults),
            Arc::new(()),
        )
        .await
        .unwrap();
    let owned = Ydoc::wire();
    owned.apply(&base).unwrap();
    let covered_bytes = owned.richdoc_append_paragraph("Covered paragraph");
    record_owned(&actor, &lineage, covered_bytes.clone(), "covered").await;
    let covered = accept_latest(&actor, &store, 2).await;
    assert!(matches!(
        deliver_owned(&handle, &binding, &covered, covered_bytes.clone()).await,
        ApplicationResult::Applied(..)
    ));
    if carried {
        for (index, text) in ["Carried paragraph one", "Carried paragraph two"]
            .into_iter()
            .enumerate()
        {
            record_owned(
                &actor,
                &lineage,
                owned.richdoc_append_paragraph(text),
                &format!("carried-{index}"),
            )
            .await;
            accept_latest(&actor, &store, 3 + index as i64).await;
        }
    }
    HostWindow {
        owner,
        actor,
        supervisor,
        store,
        first,
        coordinate,
        covered,
        lineage,
        base,
        covered_bytes,
        root,
    }
}

fn window_key() -> DocKey {
    DocKey::new("workspace", "main", "object").unwrap()
}

fn window_host_coordinate() -> ApplicationHostCoordinate {
    ApplicationHostCoordinate {
        host_id: "host".into(),
        host_epoch: 1,
        instance_id: "instance".into(),
        connection_id: "connection".into(),
    }
}

fn window_binding(lineage: &str) -> dohc_engine_collab::LiveObjectBinding {
    dohc_engine_collab::LiveObjectBinding {
        workspace_id: "workspace".into(),
        main_version_id: "main".into(),
        object_id: "object".into(),
        lineage_claim_id: lineage.into(),
        current_path: WINDOW_PATH.into(),
        selector_paths: vec![WINDOW_PATH.into()],
        restore_fence_generation: 0,
    }
}

fn execute(store: &mut EngineStore, sql: &str) {
    store
        .write_with(&NoFaults, |tx| {
            tx.execute_batch(sql)
                .map_err(dohc_engine_storage::StorageError::persist_public)
        })
        .unwrap();
}

/// The owner's edit, recorded in the native Y.Doc.
async fn record_owned(actor: &ActorHandle, lineage: &str, update: Vec<u8>, request: &str) {
    actor
        .ydoc_record_update(
            window_key(),
            WINDOW_PATH.into(),
            ContentKind::Richdoc,
            Regime::Replicated,
            update,
            Some("owner-origin".into()),
            None,
            Some(lineage.into()),
            false,
            None,
            Some(request.into()),
            30,
            Arc::new(NoFaults),
            CancellationToken::new(),
            None,
        )
        .await
        .unwrap();
}

impl HostWindow {
    /// Stop: the retirement settles the file at B, the document parks and the
    /// activation releases. Then the document returns to the scope, with no
    /// activation current.
    async fn release(&mut self) {
        let scope = dohc_engine_runtime::actor::OwnedRetirementScope {
            namespace: "relay".into(),
            max_deliveries: 8,
            max_applications: 8,
        };
        let retirement = RetirementKey {
            object_id: "object".into(),
            lineage_claim_id: self.lineage.clone(),
            activation_id: self.first.activation_id.clone(),
            restore_fence_generation: 0,
            accepted_through: 10,
        };
        self.owner
            .begin_retirement(
                scope.clone(),
                self.coordinate.clone(),
                retirement.clone(),
                false,
            )
            .await
            .unwrap();
        self.owner
            .settle_retirement(
                scope.clone(),
                self.coordinate.clone(),
                retirement.clone(),
                Some(self.covered.clone()),
                100,
                self.root.path().to_owned(),
                30,
                Arc::new(NoFaults),
                CancellationToken::new(),
                AdmittedNativeHistoryReconstruction {
                    policy: adoption_reconstruction(),
                    reservation: Arc::new(()),
                },
            )
            .await
            .unwrap();
        execute(&mut self.store, "INSERT OR IGNORE INTO hosted_replicas(workspace_id,scope_generation,created_at_ms,main_cursor,last_outbound_seq)
              VALUES ('workspace',1,0,1,(SELECT COALESCE(MAX(origin_seq),-1) FROM replication_log WHERE origin_id='origin'));
            INSERT OR REPLACE INTO hosted_documents(workspace_id,object_id,path,state,scope_generation) VALUES ('workspace','object','notes/plan.md','parked',0)");
        assert!(matches!(
            self.owner
                .release_activation(scope, self.coordinate.clone(), retirement, 40)
                .await
                .unwrap(),
            Release::Released { .. }
        ));
        execute(
            &mut self.store,
            "UPDATE hosted_documents SET scope_generation=1,state='ready'",
        );
        let file = self.file();
        assert!(
            file.contains("Covered paragraph") && !file.contains("Carried"),
            "{file}"
        );
    }

    fn file(&self) -> String {
        std::fs::read_to_string(self.root.path().join(WINDOW_PATH)).unwrap()
    }

    /// A disk observation of `text` the capture sink watched change, with no
    /// editor lease on the file.
    async fn capture(
        &self,
        text: &str,
    ) -> Result<dohc_engine_domain::WriteResult, dohc_engine_runtime::RuntimeError> {
        self.actor
            .capture_ingest(
                dohc_engine_runtime::CaptureIngest {
                    workspace_id: "workspace".into(),
                    version_id: "main".into(),
                    path: WINDOW_PATH.into(),
                    text: text.into(),
                    metadata_origin: "capture".into(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: None,
                    now_ms: 60,
                    request_id: None,
                    claim_foreign_head: true,
                },
                dohc_engine_collab::LeaseRegistry::new(),
                Arc::new(NoFaults),
                CancellationToken::new(),
            )
            .await
    }

    /// The native Y.Doc's whole state.
    fn native(&self) -> Vec<u8> {
        dohc_engine_collab::load_persisted(&self.store, &window_key())
            .unwrap()
            .unwrap()
            .doc
            .encode_full_state()
    }

    /// Every row a capture could write, but the claimed origin of an
    /// unchanged head.
    fn written(&self) -> Vec<String> {
        let mut rows: Vec<String> = [
            "SELECT * FROM moments",
            "SELECT workspace_id,version_id,object_id,path,content_kind,blob_sha256,latest_moment_id FROM snapshots",
            "SELECT * FROM ydoc_docs",
            "SELECT * FROM ydoc_updates",
            "SELECT * FROM ydoc_snapshots",
            "SELECT * FROM replication_log",
            "SELECT * FROM owner_ydoc_outbox_entries",
            "SELECT * FROM live_owner_activations",
            "SELECT * FROM live_device_settlements",
            "SELECT * FROM materialization_jobs",
            "SELECT sha256 FROM binary_blobs",
            "SELECT sha256 FROM blobs",
        ]
        .iter()
        .flat_map(|sql| {
            self.store
                .read_with(|conn| {
                    let mut statement = conn.prepare(sql)?;
                    let columns = statement.column_count();
                    statement
                        .query_map([], |row| {
                            let values = (0..columns)
                                .map(|column| row.get::<_, rusqlite::types::Value>(column))
                                .collect::<Result<Vec<_>, _>>()?;
                            Ok(format!("{sql}: {values:?}"))
                        })?
                        .collect::<Result<Vec<_>, _>>()
                })
                .unwrap()
        })
        .collect();
        rows.sort();
        rows
    }

    /// A capture of `text` refuses and writes nothing, the native Y.Doc
    /// structure unchanged.
    async fn refuses(
        &self,
        text: &str,
        refusal: fn(&dohc_engine_runtime::RuntimeError) -> bool,
        case: &str,
    ) {
        let (native, written) = (self.native(), self.written());
        let captured = self.capture(text).await;
        assert!(
            captured.as_ref().is_err_and(refusal),
            "{case}: {:?}",
            captured.map(|result| result.moment.moment_id)
        );
        assert_eq!(self.native(), native, "{case}");
        assert_eq!(self.written(), written, "{case}");
    }

    async fn close(self) {
        self.owner.close().await.unwrap();
        self.supervisor.close_all().unwrap();
    }
}

fn unproven(error: &dohc_engine_runtime::RuntimeError) -> bool {
    matches!(
        error,
        dohc_engine_runtime::RuntimeError::Sync(dohc_engine_sync::SyncError::RetryableState {
            reason: "ydoc-released-capture-unproven"
        })
    )
}

fn binding_active(error: &dohc_engine_runtime::RuntimeError) -> bool {
    matches!(
        error,
        dohc_engine_runtime::RuntimeError::Sync(
            dohc_engine_sync::SyncError::LiveDocumentBindingActive
        )
    )
}

/// The released chain's file at B, edited on disk in each shape a person
/// edits a file: inside a paragraph, in its frontmatter, with a block added,
/// and with the paragraph that held the edit deleted.
fn disk_edits(file: &str) -> [(&'static str, String); 4] {
    [
        (
            "an inline edit",
            file.replacen("Covered paragraph", "Covered and edited paragraph", 1),
        ),
        (
            "a frontmatter change",
            format!("---\ntitle: Plan\n---\n{file}"),
        ),
        ("an added block", format!("{file}\nAn added block.\n")),
        (
            "its paragraph deleted",
            file.replacen("Covered paragraph", "", 1),
        ),
    ]
}

/// Sol's 4b2b-1 ruling, through the host's real capture: while an activation
/// is adopted, a same-path disk edit refuses with no editor lease and no
/// writes. Once it releases with C1 and C2 Carried and unapplied, the file at
/// B unchanged keeps the Y.Doc and its tail with no writes, and every disk
/// edit refuses with no writes and the native structure unchanged: over the
/// Carried content, over the owner's own typing after the release, and over
/// a peer's catch-up a moment records.
#[tokio::test]
async fn a_released_window_capture_never_rewrites_content_its_file_never_showed() {
    let mut w = adopted_window(true).await;
    let head = dohc_engine_collab::load_persisted(&w.store, &window_key())
        .unwrap()
        .unwrap()
        .doc
        .project(ContentKind::Richdoc)
        .unwrap()
        .content;
    w.refuses(
        &format!("{head}\nA disk edit.\n"),
        binding_active,
        "an adopted owner",
    )
    .await;
    w.release().await;
    let file = w.file();
    let (native, written) = (w.native(), w.written());
    w.capture(&file).await.expect("the bytes capture recorded");
    assert_eq!(w.native(), native, "the unchanged file keeps the tail");
    assert_eq!(w.written(), written, "the unchanged file writes nothing");
    for (case, text) in disk_edits(&file) {
        assert_ne!(text, file, "{case}");
        w.refuses(&text, unproven, case).await;
    }
    let typed = Ydoc::wire();
    typed.apply(&w.native()).unwrap();
    record_owned(
        &w.actor,
        &w.lineage,
        typed.richdoc_append_paragraph("Typed after the release"),
        "typed",
    )
    .await;
    w.refuses(&format!("{file}\nA disk edit.\n"), unproven, "own typing")
        .await;
    let peer = Ydoc::wire();
    peer.apply(&w.base).unwrap();
    peer.apply(&w.covered_bytes).unwrap();
    import_envelope(
        &mut w.store,
        "peer",
        2,
        &peer.richdoc_append_paragraph("Peer paragraph"),
        &w.lineage,
        false,
    );
    execute(&mut w.store, "UPDATE hosted_replicas SET main_cursor=2");
    w.actor
        .materialize_replay_pending(w.root.path().to_owned(), "workspace".into(), 50)
        .await
        .unwrap();
    let caught_up = w.file();
    assert!(caught_up.contains("Peer paragraph"), "{caught_up}");
    w.refuses(
        &format!("{caught_up}\nA disk edit.\n"),
        unproven,
        "a peer's catch-up",
    )
    .await;
    // An owner adopted on another lineage of the document holds all of it,
    // so a disk edit refuses as its rewrite would, before the window is read.
    let raw = rusqlite::Connection::open(engine_db_path(&w.root).unwrap()).unwrap();
    raw.execute_batch(&format!(
        "PRAGMA foreign_keys=OFF;
         CREATE TEMP TABLE other AS SELECT * FROM live_owner_activations WHERE activation_id='{}';
         UPDATE other SET activation_id='other-lineage',lineage_claim_id='{}',released_at_ms=NULL,
           released_restore_generation=NULL,released_accepted_cursor=NULL,released_boundary_json=NULL,
           carried_manifest_json=NULL;
         INSERT INTO live_owner_activations SELECT * FROM other",
        w.first.activation_id,
        "f".repeat(64)
    ))
    .unwrap();
    drop(raw);
    w.refuses(
        &format!("{caught_up}\nA disk edit.\n"),
        binding_active,
        "another lineage's adopted owner",
    )
    .await;
    w.close().await;
}

/// Sol's 4b2b-1 ruling: a released chain that Carried nothing settled its
/// whole Y.Doc at B, so a disk edit of that file folds as ever.
#[tokio::test]
async fn a_released_window_capture_folds_over_a_proven_equal_base() {
    let mut w = adopted_window(false).await;
    w.release().await;
    let edited = format!("{}\nA disk edit.\n", w.file());
    let native = w.native();
    w.capture(&edited).await.expect("a proven fold");
    assert_ne!(w.native(), native);
    let settled: String = w
        .store
        .read_with(|conn| {
            conn.query_row("SELECT last_settled_sha FROM ydoc_docs", [], |row| {
                row.get(0)
            })
        })
        .unwrap();
    assert_eq!(
        settled,
        hex_sha256(edited.as_bytes()),
        "the Y.Doc holds the file"
    );
    w.close().await;
}

/// The text the released chain retains, inside the file's one paragraph.
const RETAINED: &str = " Retained.";

/// How the released chain retains [`RETAINED`], as release classifies it.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Retained {
    /// An owner edit the relay accepted and the host never applied.
    Carried,
    /// An edit ordinary sync brought before the lineage adopted, so the
    /// adoption seed holds it. The relay accepted the seed and the host
    /// never applied it.
    Seed,
    /// An owner edit still pending when Stop began, which the relay's
    /// journal answered during reconciliation.
    Own,
}

/// A host whose root activation released with [`RETAINED`] unapplied, its
/// document back in the scope with no activation current. Fields drop in
/// order: the actor closes before its scratch tree goes.
struct RetainedWindow {
    owner: dohc_engine_runtime::actor::ActorLiveApplicationOwner,
    actor: ActorHandle,
    supervisor: WorkspaceSupervisor,
    store: EngineStore,
    first: ImportedOwnerActivation,
    coordinate: ApplicationHostCoordinate,
    boundary: Option<RetainedPrefixBody>,
    lineage: String,
    base: Vec<u8>,
    /// The digest of the delivery that retains [`RETAINED`].
    retained_digest: String,
    /// That delivery's ID.
    retained_delivery: String,
    /// What ordinary sync brought the host before its lineage adopted.
    synced: Vec<Vec<u8>>,
    root: ScratchDir,
}

fn owner_source_base() -> Vec<u8> {
    let source: serde_json::Value = serde_json::from_str(include_str!(
        "../../dohc-engine-collab/tests/owner-source/owner-source-seed.json"
    ))
    .unwrap();
    serde_json::from_value(source["bytes"].clone()).unwrap()
}

/// A workspace store holding the document's base as ordinary sync brought
/// it, under `origin`.
fn window_store(root: &ScratchDir, origin: &str, base: &[u8], lineage: &str) -> EngineStore {
    let mut store = EngineStore::open(&engine_db_path(root).unwrap(), 0).unwrap();
    dohc_engine_domain::VersionedTextStore::new(&mut store)
        .ensure_main_version("workspace", "main", 0, &NoFaults)
        .unwrap();
    execute(&mut store, &format!("INSERT INTO sync_identity (workspace_id,origin_id,replication_epoch,stream_identity,created_at_ms) VALUES ('workspace','{origin}','epoch','stream',1);
        INSERT INTO sync_relay_push_state (workspace_id,origin_id,pushed_seq) VALUES ('workspace','{origin}',0);
        INSERT INTO sync_relay_cursors (workspace_id,cursor,replication_epoch,stream_identity) VALUES ('workspace','1','epoch','stream')"));
    import_envelope(&mut store, "owner-peer", 1, base, lineage, true);
    std::fs::create_dir(root.path().join("notes")).unwrap();
    store
}

async fn retained_window(retained: Retained) -> RetainedWindow {
    retained_window_keeping(retained, None).await.0
}

/// An edit of the lineage from the owner's desktop, which never saw
/// [`RETAINED`].
#[derive(Clone, Copy, Debug, PartialEq)]
enum Kept {
    /// A new paragraph, which destroys nothing.
    Append,
    /// A disk edit that capture folds, which deletes the retained text.
    Fold,
}

/// [`retained_window`], where the host's hosted pass delivered `kept` while
/// the root activation was bound and the document ready. Its session never
/// admitted it, so it stays queued and holds the document through the
/// release. The document then returns to the scope backfilling. Answers the
/// feed that served it, and its row.
async fn retained_window_keeping(
    retained: Retained,
    kept: Option<Kept>,
) -> (
    RetainedWindow,
    Option<(
        dohc_engine_sync::RelaySyncClient<HostedFeed>,
        dohc_engine_sync::ReplicationEnvelope,
    )>,
) {
    let root = ScratchDir::new().unwrap();
    let base = owner_source_base();
    let lineage = hex_sha256(&base);
    let mut store = window_store(&root, "origin", &base, &lineage);
    let edited = Ydoc::wire();
    edited.apply(&base).unwrap();
    let inside = edited
        .richdoc_insert_text(1, "Starting together.".len() as u32, RETAINED)
        .unwrap();
    let mut synced = Vec::new();
    if retained == Retained::Seed {
        // The edit, and a paragraph added and removed: a deletion both
        // sides hold before the window.
        let scratch = edited.richdoc_append_paragraph("Scratch");
        let removed = edited.richdoc_remove_block(2);
        synced = vec![inside.clone(), scratch, removed];
        for (index, update) in synced.iter().enumerate() {
            import_envelope(
                &mut store,
                &format!("peer-{index}"),
                2 + index as i64,
                update,
                &lineage,
                false,
            );
        }
    }
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor
        .open(&engine_db_path(&root).unwrap(), 3)
        .unwrap()
        .actor;
    actor
        .materialize_replay_pending(root.path().to_owned(), "workspace".into(), 20)
        .await
        .unwrap();
    let first = actor
        .capture_imported_owner_activation(
            "relay".into(),
            window_key(),
            WINDOW_PATH.into(),
            1_000_000,
            None,
            CancellationToken::new(),
            Arc::new(()),
        )
        .await
        .unwrap();
    let coordinate = ApplicationHostCoordinate {
        host_id: "host".into(),
        host_epoch: 1,
        instance_id: "instance".into(),
        connection_id: "connection".into(),
    };
    let owner = actor
        .live_application_owner("workspace".into())
        .await
        .unwrap();
    owner
        .register("relay".into(), coordinate.clone(), window_binding(&lineage))
        .await
        .unwrap()
        .adopt_owner(
            imported_cut(&first, None),
            1_000_000,
            100,
            Arc::new(NoFaults),
            Arc::new(()),
        )
        .await
        .unwrap();
    if retained != Retained::Seed {
        record_owned(&actor, &lineage, inside, "retained").await;
    }
    let (_, delivery_id, retained_digest) = latest_pending(&store);
    if retained == Retained::Seed {
        assert_eq!(retained_digest, hex_sha256(&first.full_state), "the seed");
    }
    let accepted = LiveUpdateReceipt {
        delivery_id: delivery_id.clone(),
        update_digest: retained_digest.clone(),
        journal_cursor: 2,
        accepting_host_epoch: 1,
    };
    if retained != Retained::Own {
        accept_latest(&actor, &store, 2).await;
    }
    let kept = match kept {
        None => None,
        Some(kept) => {
            execute(&mut store, "INSERT INTO hosted_replicas(workspace_id,scope_generation,created_at_ms,main_cursor,last_outbound_seq,scope_token)
                  VALUES ('workspace',1,0,1,(SELECT COALESCE(MAX(origin_seq),-1) FROM replication_log WHERE origin_id='origin'),'scope');
                INSERT INTO hosted_documents(workspace_id,object_id,path,state,scope_generation) VALUES ('workspace','object','notes/plan.md','ready',1)");
            let desktop = desktop_of(&base, &lineage, &synced).await;
            let (op, bytes) = match kept {
                Kept::Append => desktop.append(&lineage, "A desktop paragraph").await,
                Kept::Fold => {
                    desktop
                        .fold(&format!("{}\nA desktop edit.\n", desktop.file()))
                        .await
                }
            };
            desktop.close().await;
            let feed = HostedFeed::new(&[("object", WINDOW_PATH)]);
            let op = feed.serve(op, bytes);
            let client = dohc_engine_sync::RelaySyncClient::new(feed);
            let pass = hosted_pass(
                &mut store,
                &client,
                &mut dohc_engine_collab::WriterDocCache::new(),
            );
            assert_eq!(
                pass.held.get("object"),
                Some(&dohc_engine_sync::HostedHold::LiveEditUnadmitted),
                "{kept:?}: {pass:?}"
            );
            assert!(pass_commit(&mut store, &client, &pass).committed);
            Some((client, op))
        }
    };
    // Stop: Phase A, settlement with nothing applied, the document parks,
    // and the release. Its document returns with no activation current.
    let scope = dohc_engine_runtime::actor::OwnedRetirementScope {
        namespace: "relay".into(),
        max_deliveries: 8,
        max_applications: 8,
    };
    let key = RetirementKey {
        object_id: "object".into(),
        lineage_claim_id: lineage.clone(),
        activation_id: first.activation_id.clone(),
        restore_fence_generation: 0,
        accepted_through: 10,
    };
    owner
        .begin_retirement(scope.clone(), coordinate.clone(), key.clone(), false)
        .await
        .unwrap();
    if retained == Retained::Own {
        let journal = JournalEvidence {
            receipts: vec![accepted],
            absent: vec![],
        };
        owner
            .reconcile_activation(scope.clone(), key.clone(), None, Some(journal))
            .await
            .unwrap();
    }
    owner
        .settle_retirement(
            scope.clone(),
            coordinate.clone(),
            key.clone(),
            None,
            100,
            root.path().to_owned(),
            30,
            Arc::new(NoFaults),
            CancellationToken::new(),
            AdmittedNativeHistoryReconstruction {
                policy: adoption_reconstruction(),
                reservation: Arc::new(()),
            },
        )
        .await
        .unwrap();
    if kept.is_some() {
        execute(
            &mut store,
            "UPDATE hosted_documents SET state='parked',held_reason=NULL,scope_generation=0,unmaterialized_seq=NULL",
        );
    } else {
        execute(&mut store, "INSERT INTO hosted_replicas(workspace_id,scope_generation,created_at_ms,main_cursor,last_outbound_seq)
              VALUES ('workspace',1,0,1,(SELECT COALESCE(MAX(origin_seq),-1) FROM replication_log WHERE origin_id='origin'));
            INSERT INTO hosted_documents(workspace_id,object_id,path,state,scope_generation) VALUES ('workspace','object','notes/plan.md','parked',0)");
    }
    let Release::Released { boundary, .. } = owner
        .release_activation(scope, coordinate.clone(), key, 40)
        .await
        .unwrap()
    else {
        panic!("{retained:?}: released");
    };
    if kept.is_some() {
        execute(
            &mut store,
            "UPDATE hosted_documents SET scope_generation=1,state='backfilling',backfill_cursor=0",
        );
    } else {
        execute(
            &mut store,
            "UPDATE hosted_documents SET scope_generation=1,state='ready';
            UPDATE hosted_replicas SET scope_token='scope'",
        );
    }
    let window = RetainedWindow {
        owner,
        actor,
        supervisor,
        store,
        first,
        coordinate,
        boundary,
        lineage,
        base,
        retained_digest,
        retained_delivery: delivery_id,
        synced,
        root,
    };
    (window, kept)
}

impl RetainedWindow {
    fn head(&self) -> Ydoc {
        dohc_engine_collab::load_persisted(&self.store, &window_key())
            .unwrap()
            .unwrap()
            .doc
    }

    fn native(&self) -> Vec<u8> {
        self.head().encode_full_state()
    }

    fn text(&self) -> String {
        self.head().project(ContentKind::Richdoc).unwrap().content
    }

    async fn close(self) {
        self.owner.close().await.unwrap();
        self.supervisor.close_all().unwrap();
    }
}

/// Every row a synced update, its refusal or its application could write.
fn ingress_rows(store: &EngineStore) -> Vec<String> {
    table_rows(
        store,
        &[
            "moments",
            "snapshots",
            "ydoc_docs",
            "ydoc_updates",
            "ydoc_snapshots",
            "ydoc_deferred_updates",
            "replication_log",
            "replication_pending_refusals",
            "relay_deferred_ops",
            "owner_ydoc_outbox_entries",
            "live_owner_activations",
            "live_device_settlements",
            "live_device_update_applications",
            "live_accepted_updates",
        ],
    )
}

/// Every row a synced file operation could write to the document: those of
/// [`ingress_rows`], its path, outbox, attribution requests and
/// materialization, and none that name the neighbour.
fn document_rows(store: &EngineStore) -> Vec<String> {
    let mut rows = ingress_rows(store);
    rows.extend(table_rows(
        store,
        &[
            "path_aliases",
            "owner_ydoc_outboxes",
            "engine_requests",
            "materialization_jobs",
        ],
    ));
    rows.retain(|row| !row.contains("neighbour"));
    rows.sort();
    rows
}

/// Every row of `tables`, sorted.
fn table_rows(store: &EngineStore, tables: &[&str]) -> Vec<String> {
    let mut rows: Vec<String> = tables
        .iter()
        .flat_map(|table| {
            store
                .read_with(|conn| {
                    let mut statement = conn.prepare(&format!("SELECT * FROM {table}"))?;
                    let columns = statement.column_count();
                    statement
                        .query_map([], |row| {
                            let values = (0..columns)
                                .map(|column| row.get::<_, rusqlite::types::Value>(column))
                                .collect::<Result<Vec<_>, _>>()?;
                            Ok(format!("{table}: {values:?}"))
                        })?
                        .collect::<Result<Vec<_>, _>>()
                })
                .unwrap()
        })
        .collect();
    rows.sort();
    rows
}

/// Whether the host journaled `op`'s coordinate: a hosted replica's ack.
fn journaled(store: &EngineStore, op: &dohc_engine_sync::ReplicationEnvelope) -> bool {
    store
        .read_with(|conn| {
            conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM replication_log WHERE origin_id=?1 AND origin_seq=?2)",
                rusqlite::params![op.origin_id, op.origin_seq],
                |row| row.get(0),
            )
        })
        .unwrap()
}

/// The owner's desktop: its own store, holding the lineage as ordinary sync
/// brought it, and its file. Fields drop in order.
struct Desktop {
    actor: ActorHandle,
    supervisor: WorkspaceSupervisor,
    store: EngineStore,
    root: ScratchDir,
}

async fn desktop_of(base: &[u8], lineage: &str, synced: &[Vec<u8>]) -> Desktop {
    replica_of("desktop", base, lineage, synced).await
}

/// A replica under `origin` holding the lineage as ordinary sync brought
/// it, with its file, and no activation ever captured.
async fn replica_of(origin: &str, base: &[u8], lineage: &str, synced: &[Vec<u8>]) -> Desktop {
    let root = ScratchDir::new().unwrap();
    let mut store = window_store(&root, origin, base, lineage);
    for (index, update) in synced.iter().enumerate() {
        import_envelope(
            &mut store,
            &format!("peer-{index}"),
            2 + index as i64,
            update,
            lineage,
            false,
        );
    }
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor
        .open(&engine_db_path(&root).unwrap(), 3)
        .unwrap()
        .actor;
    actor
        .materialize_replay_pending(root.path().to_owned(), "workspace".into(), 20)
        .await
        .unwrap();
    Desktop {
        actor,
        supervisor,
        store,
        root,
    }
}

impl Desktop {
    fn file(&self) -> String {
        std::fs::read_to_string(self.root.path().join(WINDOW_PATH)).unwrap()
    }

    /// The last `op_kind` row this desktop journaled, as the relay serves
    /// it, with the blob its payload names at `blob`, if any.
    fn last_journaled(
        &self,
        op_kind: &str,
        blob: &str,
    ) -> (dohc_engine_sync::ReplicationEnvelope, Vec<u8>) {
        let (origin_id, origin_seq, payload, recorded_at_ms): (String, i64, String, i64) = self
            .store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT origin_id,origin_seq,payload_json,recorded_at_ms FROM replication_log
                     WHERE op_kind=?1 AND imported=0 ORDER BY origin_seq DESC LIMIT 1",
                    [op_kind],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                )
            })
            .unwrap();
        let payload: serde_json::Value = serde_json::from_str(&payload).unwrap();
        let bytes = payload[blob]
            .as_str()
            .map(|sha| self.store.get_materialization_blob(sha).unwrap().unwrap())
            .unwrap_or_default();
        let op = dohc_engine_sync::ReplicationEnvelope {
            settlement_admission: None,
            admitted_author_snapshot: None,
            workspace_id: "workspace".into(),
            origin_id,
            origin_seq,
            relay_seq: None,
            op_kind: op_kind.into(),
            payload,
            recorded_at_ms,
        };
        (op, bytes)
    }

    /// The last `ydoc.update` this desktop journaled, with its bytes.
    fn journaled_update(&self) -> (dohc_engine_sync::ReplicationEnvelope, Vec<u8>) {
        self.last_journaled("ydoc.update", "updateBlobSha256")
    }

    /// How many `ydoc.update` rows this desktop journaled.
    fn updates_journaled(&self) -> i64 {
        self.store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT COUNT(*) FROM replication_log WHERE op_kind='ydoc.update' AND imported=0",
                    [],
                    |row| row.get(0),
                )
            })
            .unwrap()
    }

    /// The person makes `change` to the document on the desktop. Returns the
    /// `moment.append` it journaled, with its resulting bytes.
    async fn change(&self, change: FileChange) -> (dohc_engine_sync::ReplicationEnvelope, Vec<u8>) {
        let root = self.root.path().to_owned();
        let (self_writes, faults) = (Arc::new(()), Arc::new(NoFaults));
        match change {
            FileChange::Delete => {
                self.actor
                    .versioned_text_delete(
                        dohc_engine_domain::DeleteTextFile {
                            workspace_id: "workspace".into(),
                            version_id: "main".into(),
                            path: WINDOW_PATH.into(),
                            moment_id: "desktop-delete".into(),
                            request_id: None,
                            metadata_origin: "api".into(),
                            metadata_summary: None,
                            metadata_correlation_id: None,
                            author_json: None,
                            now_ms: 60,
                        },
                        root,
                        self_writes,
                        faults,
                        CancellationToken::new(),
                    )
                    .await
                    .unwrap();
            }
            FileChange::Rename => {
                self.actor
                    .versioned_text_rename(
                        dohc_engine_domain::RenameTextFile {
                            workspace_id: "workspace".into(),
                            version_id: "main".into(),
                            from_path: WINDOW_PATH.into(),
                            to_path: RENAMED_PATH.into(),
                            moment_id: "desktop-rename".into(),
                            request_id: None,
                            metadata_origin: "api".into(),
                            metadata_summary: None,
                            metadata_correlation_id: None,
                            author_json: None,
                            now_ms: 60,
                        },
                        root,
                        self_writes,
                        faults,
                        CancellationToken::new(),
                    )
                    .await
                    .unwrap();
            }
            FileChange::Binary => {
                self.actor
                    .versioned_binary_write(
                        dohc_engine_domain::WriteBinary {
                            workspace_id: "workspace".into(),
                            version_id: "main".into(),
                            object_id: "object".into(),
                            path: WINDOW_PATH.into(),
                            bytes: BINARY.to_vec(),
                            moment_id: "desktop-binary".into(),
                            metadata_origin: "api".into(),
                            metadata_summary: None,
                            metadata_correlation_id: None,
                            author_json: None,
                            now_ms: 60,
                            request_id: None,
                        },
                        root,
                        self_writes,
                        faults,
                        CancellationToken::new(),
                    )
                    .await
                    .unwrap();
            }
        }
        self.last_journaled("moment.append", "payloadAfterBlobSha256")
    }

    /// A disk edit to `text` that capture folds into the Y.Doc.
    async fn fold(&self, text: &str) -> (dohc_engine_sync::ReplicationEnvelope, Vec<u8>) {
        self.actor
            .capture_ingest(
                dohc_engine_runtime::CaptureIngest {
                    workspace_id: "workspace".into(),
                    version_id: "main".into(),
                    path: WINDOW_PATH.into(),
                    text: text.into(),
                    metadata_origin: "capture".into(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: None,
                    now_ms: 60,
                    request_id: None,
                    claim_foreign_head: true,
                },
                dohc_engine_collab::LeaseRegistry::new(),
                Arc::new(NoFaults),
                CancellationToken::new(),
            )
            .await
            .unwrap();
        self.journaled_update()
    }

    /// The person types a new paragraph of `text` in the desktop's editor.
    async fn append(
        &self,
        lineage: &str,
        text: &str,
    ) -> (dohc_engine_sync::ReplicationEnvelope, Vec<u8>) {
        let doc = dohc_engine_collab::load_persisted(&self.store, &window_key())
            .unwrap()
            .unwrap()
            .doc;
        record_owned(
            &self.actor,
            lineage,
            doc.richdoc_append_paragraph(text),
            text,
        )
        .await;
        self.journaled_update()
    }

    /// The desktop's editor settles the document, and its next push exports
    /// the settled head. Returns the settlement `moment.append` that journals,
    /// with its text.
    async fn settle(&mut self, lineage: &str) -> (dohc_engine_sync::ReplicationEnvelope, Vec<u8>) {
        let settled = self
            .actor
            .ydoc_settle(
                self.root.path().to_owned(),
                window_key(),
                WINDOW_PATH.into(),
                ContentKind::Richdoc,
                Some(lineage.into()),
                None,
                "desktop-session".into(),
                Arc::new(()),
                60,
                Arc::new(NoFaults),
                CancellationToken::new(),
                None,
            )
            .await
            .unwrap()
            .settled()
            .unwrap();
        self.store
            .write_with(&NoFaults, |tx| {
                dohc_engine_sync::journal_moment_append_in_tx(tx, "workspace", &settled.moment_id)
            })
            .unwrap();
        self.last_journaled("moment.append", "payloadAfterBlobSha256")
    }

    async fn close(self) {
        self.supervisor.close_all().unwrap();
    }
}

/// The relay's hosted feed for the host's scope. Each row keeps its origin
/// coordinate and takes the next relay position after the host's cursor.
struct HostedFeed {
    scope: std::sync::Mutex<dohc_engine_sync::HostedScope>,
    rows: std::sync::Mutex<Vec<dohc_engine_sync::ReplicationEnvelope>>,
    blobs: std::sync::Mutex<std::collections::BTreeMap<String, Vec<u8>>>,
    /// Rows an earlier feed placed, which the relay still knows.
    placed: Vec<dohc_engine_sync::ReplicationEnvelope>,
    /// The relay position of the feed's first row.
    first: i64,
    /// How many pages the host pulled.
    pulls: std::sync::atomic::AtomicUsize,
}

impl HostedFeed {
    fn new(documents: &[(&str, &str)]) -> Self {
        Self {
            scope: std::sync::Mutex::new(Self::scope("scope", documents)),
            rows: Default::default(),
            blobs: Default::default(),
            placed: Vec::new(),
            first: 10,
            pulls: Default::default(),
        }
    }

    fn scope(token: &str, documents: &[(&str, &str)]) -> dohc_engine_sync::HostedScope {
        dohc_engine_sync::HostedScope {
            token: token.into(),
            documents: documents
                .iter()
                .map(|(object_id, path)| dohc_engine_sync::HostedScopeDocument {
                    object_id: (*object_id).into(),
                    path: (*path).into(),
                })
                .collect(),
        }
    }

    /// Announce a new scope, under `token`: its documents, each at its path.
    /// A pull under an earlier token gets the new scope and no rows.
    fn rescope(&self, token: &str, documents: &[(&str, &str)]) {
        *self.scope.lock().unwrap() = Self::scope(token, documents);
    }

    fn pulls(&self) -> usize {
        self.pulls.load(std::sync::atomic::Ordering::SeqCst)
    }

    fn serve(
        &self,
        mut op: dohc_engine_sync::ReplicationEnvelope,
        bytes: Vec<u8>,
    ) -> dohc_engine_sync::ReplicationEnvelope {
        let mut rows = self.rows.lock().unwrap();
        op.relay_seq = Some(self.first + rows.len() as i64);
        rows.push(op.clone());
        self.blobs.lock().unwrap().insert(hex_sha256(&bytes), bytes);
        op
    }

    /// A text write that creates `object_id` at `path`.
    fn create(
        &self,
        object_id: &str,
        path: &str,
        text: &str,
    ) -> dohc_engine_sync::ReplicationEnvelope {
        self.write(object_id, path, None, text)
    }

    /// The neighbour origin's next text write of `object_id` at `path`: one
    /// that creates it, or one over `before`, the text its last write left.
    fn write(
        &self,
        object_id: &str,
        path: &str,
        before: Option<&str>,
        text: &str,
    ) -> dohc_engine_sync::ReplicationEnvelope {
        self.write_as("neighbour", object_id, path, before, text)
    }

    /// [`Self::write`], from `origin`.
    fn write_as(
        &self,
        origin: &str,
        object_id: &str,
        path: &str,
        before: Option<&str>,
        text: &str,
    ) -> dohc_engine_sync::ReplicationEnvelope {
        let origin_seq = self
            .rows
            .lock()
            .unwrap()
            .iter()
            .filter(|op| op.origin_id == origin)
            .count() as i64;
        let sha = hex_sha256(text.as_bytes());
        let mut payload = serde_json::json!({
            "momentId": format!("moment-{origin}-{origin_seq}"), "versionId": "main",
            "objectId": object_id, "objectCreatedAtMs": 1, "path": path, "recordedAtMs": 2_000,
            "operation": "write", "payloadBeforeBlobSha256": null, "payloadBeforePath": null,
            "payloadAfterBlobSha256": sha, "payloadAfterPath": path,
            "metadata": {"origin": "sync"}, "beforePresent": "absent"
        });
        if let Some(before) = before {
            let before_sha = hex_sha256(before.as_bytes());
            let fields = payload.as_object_mut().unwrap();
            for (name, value) in [
                ("payloadBeforeBlobSha256", serde_json::json!(before_sha)),
                ("payloadBeforePath", serde_json::json!(path)),
                ("beforePresent", serde_json::json!("present")),
                ("beforeObjectId", serde_json::json!(object_id)),
                ("beforeVersionId", serde_json::json!("main")),
                ("beforePath", serde_json::json!(path)),
                ("beforeBlobSha256", serde_json::json!(before_sha)),
                ("beforeContentKind", serde_json::json!("text")),
                ("beforeUpdatedAtMs", serde_json::json!(2_000)),
                (
                    "beforeLatestMomentId",
                    serde_json::json!(format!("moment-{origin}-{}", origin_seq - 1)),
                ),
            ] {
                fields.insert(name.into(), value);
            }
        }
        self.serve(
            dohc_engine_sync::ReplicationEnvelope {
                settlement_admission: None,
                admitted_author_snapshot: None,
                workspace_id: "workspace".into(),
                origin_id: origin.into(),
                origin_seq,
                relay_seq: None,
                op_kind: "moment.append".into(),
                payload,
                recorded_at_ms: 2_000,
            },
            text.as_bytes().to_vec(),
        )
    }
}

macro_rules! refused_relay_methods {
    ($($method:ident($request:ty) -> $response:ty;)*) => {
        $(fn $method(&self, _req: $request) -> Result<$response, dohc_engine_sync::RelayError> {
            Err(dohc_engine_sync::RelayError::InvalidResponse)
        })*
    };
}

impl dohc_engine_sync::RelayTransport for HostedFeed {
    fn pull_hosted(
        &self,
        req: dohc_engine_sync::HostedPullRequest,
    ) -> Result<dohc_engine_sync::HostedPullResponse, dohc_engine_sync::RelayError> {
        self.pulls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let scope = self.scope.lock().unwrap().clone();
        let current = req.scope_token.as_deref() == Some(scope.token.as_str());
        let ops: Vec<_> = self
            .rows
            .lock()
            .unwrap()
            .iter()
            .filter(|op| current && op.relay_seq.unwrap() > req.cursor)
            .filter(|op| {
                req.object_id
                    .as_ref()
                    .is_none_or(|object_id| op.payload["objectId"] == object_id.as_str())
            })
            .cloned()
            .collect();
        Ok(dohc_engine_sync::HostedPullResponse {
            scope,
            next_cursor: ops.last().map_or(req.cursor, |op| op.relay_seq.unwrap()),
            ops,
            has_more: false,
        })
    }

    fn download_blobs(
        &self,
        req: dohc_engine_sync::BlobDownloadBatchRequest,
    ) -> Result<dohc_engine_sync::BlobDownloadBatchResponse, dohc_engine_sync::RelayError> {
        let blobs = self.blobs.lock().unwrap();
        Ok(dohc_engine_sync::BlobDownloadBatchResponse {
            results: req
                .blobs
                .iter()
                .map(|blob| {
                    blobs
                        .get(&blob.sha256)
                        .cloned()
                        .map(|bytes| dohc_engine_sync::BlobDownloadResponse { bytes })
                        .ok_or(dohc_engine_sync::RelayError::BlobMissing)
                })
                .collect(),
        })
    }

    fn lookup_log_coordinate(
        &self,
        req: dohc_engine_sync::LogCoordinateRequest,
    ) -> Result<dohc_engine_sync::LogCoordinateResponse, dohc_engine_sync::RelayError> {
        Ok(self
            .placed
            .iter()
            .find(|op| op.origin_id == req.origin_id && op.origin_seq == req.origin_seq)
            .cloned()
            .map_or(
                dohc_engine_sync::LogCoordinateResponse::Absent,
                dohc_engine_sync::LogCoordinateResponse::Present,
            ))
    }

    refused_relay_methods! {
        push(dohc_engine_sync::PushRequest) -> dohc_engine_sync::PushResponse;
        pull(dohc_engine_sync::PullRequest) -> dohc_engine_sync::PullResponse;
        probe(dohc_engine_sync::ProbeRequest) -> dohc_engine_sync::ProbeResponse;
        claim_workspace(dohc_engine_sync::ClaimRequest) -> dohc_engine_sync::ClaimResponse;
        rotate_epoch(dohc_engine_sync::EpochRequest) -> dohc_engine_sync::EpochResponse;
        blobs_have(dohc_engine_sync::BlobHaveRequest) -> dohc_engine_sync::BlobHaveResponse;
        upload_blob(dohc_engine_sync::BlobUploadRequest) -> ();
        upload_key_envelope(dohc_engine_sync::KeyEnvelopeRequest) -> dohc_engine_sync::KeyEnvelopeResponse;
        download_key_envelope(dohc_engine_sync::KeyEnvelopeDownloadRequest) -> dohc_engine_sync::KeyEnvelopeDownloadResponse;
        shared_channel_pull(dohc_engine_sync::SharedChannelRequest) -> dohc_engine_sync::SharedChannelResponse;
        share_log_push(dohc_engine_sync::ShareLogPushRequest) -> dohc_engine_sync::PushResponse;
        share_view_pull(dohc_engine_sync::ShareViewRequest) -> dohc_engine_sync::ShareViewResponse;
        share_blob(dohc_engine_sync::ShareBlobRequest) -> dohc_engine_sync::BlobDownloadResponse;
        share_blob_upload(dohc_engine_sync::ShareBlobUploadRequest) -> ();
        share_proposal_submit(dohc_engine_sync::ShareProposalSubmitRequest) -> dohc_engine_sync::ShareProposalSubmitResponse;
        share_collection_write(dohc_engine_sync::ShareCollectionWriteRequest) -> dohc_engine_sync::ShareCollectionWriteResponse;
    }
}

/// One hosted pass of the host over `client`'s feed, in the relay namespace
/// its owner activations ran in, run to its end as the actor's relay
/// coordinator runs it: each released-tail validation it waits for completes
/// on the worker, and the pass goes on from where it stopped.
fn hosted_pass(
    store: &mut EngineStore,
    client: &dohc_engine_sync::RelaySyncClient<HostedFeed>,
    cache: &mut dohc_engine_collab::WriterDocCache,
) -> dohc_engine_sync::HostedPassOutcome {
    loop {
        match client.pull_hosted_workspace(
            store,
            cache,
            "workspace",
            "relay",
            &NoFaults,
            &dohc_engine_sync::NoLiveLeases,
        ) {
            Err(dohc_engine_sync::RelayError::ValidationPending(pending)) => {
                pending.validate().wait().unwrap();
            }
            pass => return pass.unwrap(),
        }
    }
}

/// [`dohc_engine_sync::apply_replication_envelope`], applied again after
/// each released-tail validation it waits for completes.
fn settled_apply(
    store: &mut EngineStore,
    cache: &mut dohc_engine_collab::WriterDocCache,
    op: &dohc_engine_sync::ReplicationEnvelope,
    faults: &dyn dohc_engine_storage::FaultInjector,
    leases: &dyn dohc_engine_sync::LeaseProbe,
) -> Result<
    dohc_engine_sync::ApplyOutcome<dohc_engine_sync::RoutedApply>,
    dohc_engine_sync::SyncError,
> {
    loop {
        match dohc_engine_sync::apply_replication_envelope(store, cache, op, faults, leases) {
            Err(dohc_engine_sync::SyncError::ValidationPending(pending)) => {
                pending.validate().wait().unwrap();
            }
            applied => return applied,
        }
    }
}

/// The binding `pass` held `object` with, when it stopped the document
/// before `op`, held unapplied for released retained work.
fn held_binding(
    pass: &dohc_engine_sync::HostedPassOutcome,
    op: &dohc_engine_sync::ReplicationEnvelope,
) -> Option<ReleasedLineageBinding> {
    let read = pass.pending_cursor.as_ref()?.reads.get("object")?;
    let Some(dohc_engine_sync::HostedHold::ReleasedLineageUnsettled {
        binding,
        continuation: dohc_engine_sync::ReleasedHoldContinuation::Frozen,
        binding_stale: false,
    }) = &read.stopped
    else {
        return None;
    };
    (read.cursor == op.relay_seq.unwrap() - 1 && pass.held.get("object") == read.stopped.as_ref())
        .then(|| *binding.clone())
}

/// `pass` stopped `object` before `op`, which waits unapplied for a reason
/// other than released retained work.
fn waits_before(
    pass: &dohc_engine_sync::HostedPassOutcome,
    op: &dohc_engine_sync::ReplicationEnvelope,
) -> bool {
    pass.pending_cursor.as_ref().is_some_and(|cursor| {
        cursor.reads.get("object").is_some_and(|read| {
            read.cursor == op.relay_seq.unwrap() - 1
                && read.stopped == Some(dohc_engine_sync::HostedHold::WorkWaiting)
        })
    })
}

/// `pass` stopped `object` before `op`, which it held unapplied, bound to
/// `op` on the feed the pull named.
fn stopped_before(
    pass: &dohc_engine_sync::HostedPassOutcome,
    op: &dohc_engine_sync::ReplicationEnvelope,
) -> bool {
    held_binding(pass, op).is_some_and(|binding| {
        binding.incoming.relay_namespace.as_deref() == Some("relay")
            && (
                binding.incoming.origin_id.as_str(),
                binding.incoming.origin_seq,
                binding.incoming.relay_seq,
            ) == (op.origin_id.as_str(), op.origin_seq, op.relay_seq.unwrap())
    })
}

/// Sol's 4b2i-1 ruling, the production shape: the owner's desktop folds a
/// disk edit into its own store and journals the `ydoc.update`, and the
/// host's hosted pull delivers it after Stop released the activation with
/// retained work in the file's existing paragraph: a Carried edit, an
/// acknowledged seed, and the owner's edit pending at Stop. The fold is
/// canonical Markdown with no metadata writes, so its deletions alone hold
/// it. The document stops before the row, which is not acknowledged; native
/// structure and every retained record stay as they were.
#[tokio::test]
async fn a_desktop_fold_never_destroys_what_a_released_chain_retains() {
    for retained in [Retained::Carried, Retained::Seed, Retained::Own] {
        let case = format!("{retained:?}");
        let mut w = retained_window(retained).await;
        assert!(
            w.text().contains(&format!("Starting together.{RETAINED}")),
            "{case}: {}",
            w.text()
        );
        let desktop = desktop_of(&w.base, &w.lineage, &[]).await;
        let file = desktop.file();
        assert!(!file.contains(RETAINED), "{case}: {file}");
        let (fold, bytes) = desktop.fold(&format!("{file}\nA desktop edit.\n")).await;
        assert_eq!(
            dohc_engine_collab::inspect_update(&w.head(), &bytes),
            dohc_engine_collab::UpdateInspection::Hold(
                dohc_engine_collab::StructuralHold::LiveDeletion
            ),
            "{case}"
        );
        let (native, rows) = (w.native(), ingress_rows(&w.store));
        let feed = HostedFeed::new(&[("object", WINDOW_PATH)]);
        let fold = feed.serve(fold, bytes);
        let client = dohc_engine_sync::RelaySyncClient::new(feed);
        let pass = hosted_pass(
            &mut w.store,
            &client,
            &mut dohc_engine_collab::WriterDocCache::new(),
        );
        assert!(w.text().contains(RETAINED), "{case}: {}", w.text());
        assert_eq!(w.native(), native, "{case}: native structure");
        assert_eq!(ingress_rows(&w.store), rows, "{case}: retained records");
        assert!(!journaled(&w.store, &fold), "{case}: acknowledged");
        assert_eq!((pass.applied, pass.refused), (0, 0), "{case}");
        assert!(
            stopped_before(&pass, &fold),
            "{case}: {:?}",
            pass.pending_cursor
        );
        // The hold carries the binding admission built. An apply outside a
        // pull names no feed namespace.
        let held = settled_apply(
            &mut w.store,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &fold,
            &NoFaults,
            &dohc_engine_sync::NoLiveLeases,
        );
        let Err(dohc_engine_sync::SyncError::ReleasedLineageUnsettled(binding)) = held else {
            panic!("{case}: {held:?}");
        };
        assert_eq!(
            binding.incoming,
            IncomingCoordinate {
                relay_namespace: None,
                replication_epoch: "epoch".into(),
                stream_identity: "stream".into(),
                origin_id: fold.origin_id.clone(),
                origin_seq: fold.origin_seq,
                relay_seq: fold.relay_seq.unwrap(),
            },
            "{case}"
        );
        assert_eq!(binding.head_digest, hex_sha256(&native), "{case}");
        let ProtectedTails::Listed(tails) = &*binding.tails else {
            panic!("{case}: {:?}", binding.tails);
        };
        let [tail] = tails.as_slice() else {
            panic!("{case}: {tails:?}");
        };
        assert_eq!(
            (tail.namespace.as_str(), tail.activation_id.as_str()),
            ("relay", w.first.activation_id.as_str()),
            "{case}"
        );
        assert_eq!(
            tail.coverage,
            RetainedCoverage::Unproven(
                UnprovenCommitment::of(vec![RetainedContribution::Carried {
                    delivery_id: w.retained_delivery.clone(),
                    update_digest: w.retained_digest.clone(),
                    journal_cursor: 2,
                    // A seed, and an edit with no attribution, credit nobody.
                    authors: RetainedAuthors::credited(None, None).unwrap(),
                }])
                .unwrap()
            ),
            "{case}"
        );
        assert_eq!(w.native(), native, "{case}");
        desktop.close().await;
        w.close().await;
    }
}

/// An update that only adds content applies in the released window, though
/// it repeats a deletion both sides already hold, and the successor then
/// captures and adopts. The retained seed survives both.
#[tokio::test]
async fn a_safe_desktop_append_applies_in_the_released_window_and_the_successor_adopts() {
    let mut w = retained_window(Retained::Seed).await;
    assert!(!w.text().contains("Scratch"), "{}", w.text());
    let desktop = desktop_of(&w.base, &w.lineage, &w.synced).await;
    let (append, bytes) = desktop.append(&w.lineage, "A desktop paragraph").await;
    assert_eq!(
        dohc_engine_collab::inspect_update(&w.head(), &bytes),
        dohc_engine_collab::UpdateInspection::Admissible
    );
    let feed = HostedFeed::new(&[("object", WINDOW_PATH)]);
    let append = feed.serve(append, bytes);
    let client = dohc_engine_sync::RelaySyncClient::new(feed);
    let mut cache = dohc_engine_collab::WriterDocCache::new();
    let pass = hosted_pass(&mut w.store, &client, &mut cache);
    assert_eq!(pass.applied, 1, "{:?}", pass.pending_cursor);
    assert!(journaled(&w.store, &append));
    let text = w.text();
    assert!(
        text.contains("A desktop paragraph") && text.contains(RETAINED),
        "{text}"
    );
    // The desktop's fold over the same head still holds, and the cache the
    // append warmed keeps the applied head.
    let (fold, bytes) = desktop
        .fold(&format!("{}\nA desktop edit.\n", desktop.file()))
        .await;
    let native = w.native();
    client.transport().serve(fold, bytes);
    hosted_pass(&mut w.store, &client, &mut cache);
    assert_eq!(w.native(), native);
    let cached = w
        .store
        .read_with(|conn| {
            Ok::<_, dohc_engine_collab::CollabError>(
                cache
                    .doc_for_consumer(conn, &window_key())?
                    .map(|doc| doc.encode_full_state()),
            )
        })
        .unwrap();
    assert!(
        cached.is_none_or(|cached| cached == native),
        "the cache keeps the applied head"
    );
    // A safe update through the same cache still applies over that head.
    let safe = {
        let doc = Ydoc::wire();
        doc.apply(&native).unwrap();
        doc.richdoc_append_paragraph("After the held fold")
    };
    w.store.put_binary_blob(&safe).unwrap();
    let mut after = ydoc_row("after", &safe, &w.lineage, WINDOW_PATH, false);
    after.relay_seq = Some(30);
    let applied = settled_apply(
        &mut w.store,
        &mut cache,
        &after,
        &NoFaults,
        &dohc_engine_sync::NoLiveLeases,
    )
    .unwrap();
    assert!(
        matches!(
            applied.primary,
            dohc_engine_sync::ApplyDisposition::Applied(_)
        ),
        "{:?}",
        applied.primary
    );
    assert!(w.text().contains("After the held fold") && w.text().contains(RETAINED));
    // The append's pass commits; the fold's, still holding, never did.
    let committed = client
        .commit_hosted_cursor(
            &mut w.store,
            "workspace",
            pass.pending_cursor.as_ref().unwrap(),
            &ReleasedTails::uncached(),
            &NoFaults,
        )
        .unwrap();
    assert!(matches!(
        committed,
        dohc_engine_storage::TxnOutcome::Committed(_)
    ));
    w.actor
        .materialize_replay_pending(w.root.path().to_owned(), "workspace".into(), 50)
        .await
        .unwrap();
    let next = w
        .actor
        .capture_imported_owner_activation(
            "relay".into(),
            window_key(),
            WINDOW_PATH.into(),
            1_000_000,
            None,
            CancellationToken::new(),
            Arc::new(()),
        )
        .await
        .unwrap();
    assert_eq!(
        next.source.predecessor_activation_id.as_deref(),
        Some(w.first.activation_id.as_str())
    );
    let boundary = w
        .boundary
        .clone()
        .expect("an adopted chain keeps its boundary");
    w.owner
        .register_activation(
            "relay".into(),
            w.coordinate.clone(),
            window_binding(&w.lineage),
            next.activation_id.clone(),
        )
        .await
        .unwrap()
        .adopt_owner(
            imported_cut(
                &next,
                Some(RetainedPrefix {
                    terminal_receipt: boundary.terminal_receipt,
                    event_count: boundary.event_count,
                    history_evidence_digest: boundary.history_evidence_digest,
                    predecessor_activation_id: w.first.activation_id.clone(),
                }),
            ),
            1_000_000,
            100,
            Arc::new(NoFaults),
            Arc::new(()),
        )
        .await
        .unwrap();
    assert!(w.text().contains(RETAINED));
    desktop.close().await;
    w.close().await;
}

/// Opus's 7h third finding, through the real release: the owner's edit, kept
/// queued while its session was bound, meets the unsettled released tail
/// Stop leaves with [`RETAINED`]. Once the document returns, an append that
/// destroys nothing applies once and the successor's captured state holds
/// it with the retained text; a fold that would delete the retained text
/// stays queued, held for that work, and changes nothing.
#[tokio::test]
async fn a_kept_edit_meets_the_released_tail_its_release_leaves() {
    for kept in [Kept::Append, Kept::Fold] {
        let (mut w, served) = retained_window_keeping(Retained::Carried, Some(kept)).await;
        let (client, op) = served.unwrap();
        let queued = vec![(
            op.origin_id.clone(),
            op.origin_seq,
            "hosted".to_owned(),
            Some("relay".to_owned()),
        )];
        assert_eq!(queued_updates(&w.store), queued, "{kept:?}");
        let native = w.native();
        assert!(w.text().contains(RETAINED), "{kept:?}: {}", w.text());
        let status = |store: &EngineStore| {
            dohc_engine_sync::read_hosted_replica(store, "workspace")
                .unwrap()
                .unwrap()
                .documents["object"]
                .status
                .clone()
        };
        // Recording a released-lineage hold counts as a commit, so the pass
        // whose drain records it commits nothing and the next pass commits.
        let commits: Vec<bool> = (0..3)
            .map(|_| {
                let pass = hosted_pass(
                    &mut w.store,
                    &client,
                    &mut dohc_engine_collab::WriterDocCache::new(),
                );
                pass_commit(&mut w.store, &client, &pass).committed
            })
            .collect();
        let expected = match kept {
            Kept::Append => [true, true, true],
            Kept::Fold => [false, true, true],
        };
        assert_eq!(commits, expected, "{kept:?}");
        match kept {
            Kept::Append => {
                assert_eq!(
                    status(&w.store),
                    dohc_engine_sync::HostedDocumentStatus::Ready
                );
                assert_eq!(queued_updates(&w.store), []);
                let text = w.text();
                assert_eq!(
                    (
                        text.matches("A desktop paragraph").count(),
                        text.matches(RETAINED).count()
                    ),
                    (1, 1),
                    "{text}"
                );
                w.actor
                    .materialize_replay_pending(w.root.path().to_owned(), "workspace".into(), 50)
                    .await
                    .unwrap();
                let next = w
                    .actor
                    .capture_imported_owner_activation(
                        "relay".into(),
                        window_key(),
                        WINDOW_PATH.into(),
                        1_000_000,
                        None,
                        CancellationToken::new(),
                        Arc::new(()),
                    )
                    .await
                    .unwrap();
                assert_eq!(
                    next.source.predecessor_activation_id.as_deref(),
                    Some(w.first.activation_id.as_str())
                );
                assert_eq!(next.full_state, w.native());
                let successor = Ydoc::wire();
                successor.apply(&next.full_state).unwrap();
                assert_eq!(
                    successor.project(ContentKind::Richdoc).unwrap().content,
                    text
                );
            }
            Kept::Fold => {
                let dohc_engine_sync::HostedDocumentStatus::Held(
                    dohc_engine_sync::HostedHold::ReleasedLineageUnsettled {
                        binding,
                        continuation: dohc_engine_sync::ReleasedHoldContinuation::Frozen,
                        binding_stale: false,
                    },
                ) = status(&w.store)
                else {
                    panic!("{:?}", status(&w.store));
                };
                assert_eq!(
                    (
                        binding.incoming.origin_id.as_str(),
                        binding.incoming.origin_seq
                    ),
                    (op.origin_id.as_str(), op.origin_seq)
                );
                assert_eq!(queued_updates(&w.store), queued);
                assert_eq!(w.native(), native);
                let text = w.text();
                assert_eq!(
                    (
                        text.matches("A desktop edit.").count(),
                        text.matches(RETAINED).count()
                    ),
                    (0, 1),
                    "{text}"
                );
            }
        }
        w.close().await;
    }
}

/// Another device's `ydoc.update` of the document, before the relay places it.
fn ydoc_row(
    origin: &str,
    bytes: &[u8],
    lineage: &str,
    path: &str,
    base: bool,
) -> dohc_engine_sync::ReplicationEnvelope {
    dohc_engine_sync::ReplicationEnvelope {
        settlement_admission: None,
        admitted_author_snapshot: None,
        workspace_id: "workspace".into(),
        origin_id: origin.into(),
        origin_seq: 0,
        relay_seq: None,
        op_kind: "ydoc.update".into(),
        payload: serde_json::json!({
            "versionId":"main", "objectId":"object", "path":path, "contentKind":"richdoc",
            "updateBlobSha256":hex_sha256(bytes), "lineageClaimId":lineage, "isBaseState":base
        }),
        recorded_at_ms: 70,
    }
}

/// The hold is one document's: the pass applies a neighbour and commits,
/// later rows of the held document wait unapplied, and the document reads
/// its own rows from there. Each later pass, and one after a restart, holds
/// again with nothing written and no more work. A held document never
/// reaches successor capture, and loses nothing.
#[tokio::test]
async fn a_released_lineage_hold_is_one_documents_across_passes_and_restart() {
    let mut w = retained_window(Retained::Carried).await;
    execute(
        &mut w.store,
        "INSERT INTO hosted_documents(workspace_id,object_id,path,state,scope_generation)
        VALUES ('workspace','neighbour','notes/neighbour.md','ready',1)",
    );
    let desktop = desktop_of(&w.base, &w.lineage, &[]).await;
    let (fold, fold_bytes) = desktop
        .fold(&format!("{}\nA desktop edit.\n", desktop.file()))
        .await;
    // A later row of the same document that would apply on its own.
    let safe = {
        let doc = Ydoc::wire();
        doc.apply(&w.native()).unwrap();
        doc.richdoc_append_paragraph("After the fold")
    };
    let feed = HostedFeed::new(&[("neighbour", "notes/neighbour.md"), ("object", WINDOW_PATH)]);
    let fold = feed.serve(fold, fold_bytes);
    let later = feed.serve(
        ydoc_row("later", &safe, &w.lineage, WINDOW_PATH, false),
        safe,
    );
    let created = feed.create("neighbour", "notes/neighbour.md", "A neighbour.\n");
    let client = dohc_engine_sync::RelaySyncClient::new(feed);
    let (native, rows) = (w.native(), ingress_rows(&w.store));
    let pass = hosted_pass(
        &mut w.store,
        &client,
        &mut dohc_engine_collab::WriterDocCache::new(),
    );
    assert_eq!(pass.applied, 1, "the neighbour");
    assert!(journaled(&w.store, &created));
    assert!(!journaled(&w.store, &fold) && !journaled(&w.store, &later));
    assert_eq!(w.native(), native);
    assert!(stopped_before(&pass, &fold), "{:?}", pass.pending_cursor);
    assert!(!pass.has_more, "no work retries hot");
    let committed = client
        .commit_hosted_cursor(
            &mut w.store,
            "workspace",
            pass.pending_cursor.as_ref().unwrap(),
            &ReleasedTails::uncached(),
            &NoFaults,
        )
        .unwrap();
    assert!(matches!(
        committed,
        dohc_engine_storage::TxnOutcome::Committed(_)
    ));
    assert_ne!(ingress_rows(&w.store), rows, "the neighbour applied");
    let rows = ingress_rows(&w.store);
    // The commit keeps the hold's own reason and the binding the pull
    // derived, the feed's namespace in it, never a generic wait.
    let binding = held_binding(&pass, &fold).unwrap();
    let hold = dohc_engine_sync::HostedDocumentStatus::Held(
        dohc_engine_sync::HostedHold::ReleasedLineageUnsettled {
            binding: Box::new(binding.clone()),
            continuation: dohc_engine_sync::ReleasedHoldContinuation::Frozen,
            binding_stale: false,
        },
    );
    let status = |store: &EngineStore| {
        let replica = dohc_engine_sync::read_hosted_replica(store, "workspace")
            .unwrap()
            .unwrap();
        (
            replica.documents["object"].status.clone(),
            replica.documents["neighbour"].status.clone(),
        )
    };
    assert_eq!(
        status(&w.store),
        (hold.clone(), dohc_engine_sync::HostedDocumentStatus::Ready)
    );
    let again = hosted_pass(
        &mut w.store,
        &client,
        &mut dohc_engine_collab::WriterDocCache::new(),
    );
    assert!(
        stopped_before(&again, &fold) && !again.has_more && again.applied == 0,
        "{again:?}"
    );
    assert_eq!(held_binding(&again, &fold), Some(binding.clone()));
    assert_eq!(
        (w.native(), ingress_rows(&w.store)),
        (native.clone(), rows.clone()),
        "redelivered"
    );
    w.store = EngineStore::open(&engine_db_path(&w.root).unwrap(), 0).unwrap();
    assert_eq!(
        status(&w.store),
        (hold, dohc_engine_sync::HostedDocumentStatus::Ready),
        "the hold reads back after a restart"
    );
    let restarted = hosted_pass(
        &mut w.store,
        &client,
        &mut dohc_engine_collab::WriterDocCache::new(),
    );
    assert!(
        stopped_before(&restarted, &fold) && !restarted.has_more && restarted.applied == 0,
        "{restarted:?}"
    );
    assert_eq!(held_binding(&restarted, &fold), Some(binding));
    assert_eq!(
        (w.native(), ingress_rows(&w.store)),
        (native.clone(), rows),
        "after a restart"
    );
    let captured = w
        .actor
        .capture_imported_owner_activation(
            "relay".into(),
            window_key(),
            WINDOW_PATH.into(),
            1_000_000,
            None,
            CancellationToken::new(),
            Arc::new(()),
        )
        .await;
    assert!(captured.is_err(), "a held document is not ready");
    assert_eq!(w.native(), native);
    assert!(w.text().contains(RETAINED));
    desktop.close().await;
    w.close().await;
}

/// The window's document, live on the host.
struct WindowLive;

impl dohc_engine_sync::LeaseProbe for WindowLive {
    fn is_live(&self, key: &DocKey) -> bool {
        *key == window_key()
    }
}

/// [`hosted_pass`] while the window's document is live on the host.
fn live_hosted_pass(
    store: &mut EngineStore,
    client: &dohc_engine_sync::RelaySyncClient<HostedFeed>,
) -> dohc_engine_sync::HostedPassOutcome {
    let mut cache = dohc_engine_collab::WriterDocCache::new();
    loop {
        match client.pull_hosted_workspace(
            store,
            &mut cache,
            "workspace",
            "relay",
            &NoFaults,
            &WindowLive,
        ) {
            Err(dohc_engine_sync::RelayError::ValidationPending(pending)) => {
                pending.validate().wait().unwrap();
            }
            pass => return pass.unwrap(),
        }
    }
}

/// The window document's drain as its session ends, run again after each
/// released-tail validation it waits for completes.
fn settled_drain(store: &mut EngineStore) -> dohc_engine_sync::YdocDrainResult {
    let mut cache = dohc_engine_collab::WriterDocCache::new();
    loop {
        let drained = dohc_engine_sync::drain_deferred_ydoc_for_key(
            store,
            &mut cache,
            &window_key(),
            &NoFaults,
        )
        .unwrap();
        match &drained.waiting {
            Some(pending) => pending.validate().wait().unwrap(),
            None => return drained,
        }
    }
}

/// Each queued Y.Doc update of the store: its coordinate and the feed it
/// recorded.
fn queued_updates(store: &EngineStore) -> Vec<(String, i64, String, Option<String>)> {
    store
        .read_with(|conn| {
            conn.prepare(
                "SELECT origin_id,origin_seq,ingress_kind,relay_namespace FROM ydoc_deferred_updates \
                 ORDER BY relay_seq",
            )?
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)))?
            .collect::<Result<Vec<_>, _>>()
        })
        .unwrap()
}

/// What the host's commit of `pass`'s cursor did.
fn pass_commit(
    store: &mut EngineStore,
    client: &dohc_engine_sync::RelaySyncClient<HostedFeed>,
    pass: &dohc_engine_sync::HostedPassOutcome,
) -> dohc_engine_sync::HostedCommit {
    let committed = client
        .commit_hosted_cursor(
            store,
            "workspace",
            pass.pending_cursor.as_ref().unwrap(),
            &ReleasedTails::uncached(),
            &NoFaults,
        )
        .unwrap();
    let dohc_engine_storage::TxnOutcome::Committed(committed) = committed else {
        panic!("no fault was injected");
    };
    committed
}

/// A destructive update deferred while the host's session is live, with
/// the feed it arrived on, stays queued when the session ends: the drain
/// holds it with a binding that names that feed, applies and refuses
/// nothing, and the document keeps the retained text. The hold and the
/// queued update read back after a restart, and each later pass decides
/// again and holds again with nothing written.
#[tokio::test]
async fn a_deferred_destructive_update_stays_queued_with_its_hold_through_a_drain_and_a_restart() {
    let mut w = retained_window(Retained::Carried).await;
    let desktop = desktop_of(&w.base, &w.lineage, &[]).await;
    let (fold, fold_bytes) = desktop
        .fold(&format!("{}\nA desktop edit.\n", desktop.file()))
        .await;
    let feed = HostedFeed::new(&[("object", WINDOW_PATH)]);
    let fold = feed.serve(fold, fold_bytes);
    let client = dohc_engine_sync::RelaySyncClient::new(feed);
    let native = w.native();
    let live = live_hosted_pass(&mut w.store, &client);
    assert!(pass_commit(&mut w.store, &client, &live).committed);
    assert!(journaled(&w.store, &fold), "its deferral acknowledged it");
    let queued = vec![(
        fold.origin_id.clone(),
        fold.origin_seq,
        "hosted".to_owned(),
        Some("relay".to_owned()),
    )];
    assert_eq!(queued_updates(&w.store), queued);
    assert_eq!(w.native(), native);

    let drained = settled_drain(&mut w.store);
    let Some(dohc_engine_sync::HostedHold::ReleasedLineageUnsettled {
        binding,
        continuation: dohc_engine_sync::ReleasedHoldContinuation::Frozen,
        binding_stale: false,
    }) = &drained.released_hold
    else {
        panic!("{drained:?}");
    };
    assert_eq!(binding.incoming.relay_namespace.as_deref(), Some("relay"));
    assert_eq!(
        (
            binding.incoming.origin_id.as_str(),
            binding.incoming.origin_seq
        ),
        (fold.origin_id.as_str(), fold.origin_seq)
    );
    assert_eq!((drained.drained, drained.refusals.len()), (0, 0));
    assert_eq!(w.native(), native);
    assert!(w.text().contains(RETAINED));
    assert_eq!(
        queued_updates(&w.store),
        queued,
        "the held update stays queued"
    );
    let held = dohc_engine_sync::HostedDocumentStatus::Held(drained.released_hold.clone().unwrap());
    let status = |store: &EngineStore| {
        dohc_engine_sync::read_hosted_replica(store, "workspace")
            .unwrap()
            .unwrap()
            .documents["object"]
            .status
            .clone()
    };
    assert_eq!(status(&w.store), held);

    w.store = EngineStore::open(&engine_db_path(&w.root).unwrap(), 0).unwrap();
    assert_eq!(
        status(&w.store),
        held,
        "the hold reads back after a restart"
    );
    assert_eq!(queued_updates(&w.store), queued);
    for _ in 0..2 {
        let pass = hosted_pass(
            &mut w.store,
            &client,
            &mut dohc_engine_collab::WriterDocCache::new(),
        );
        assert_eq!(
            pass.held.get("object"),
            drained.released_hold.as_ref(),
            "{pass:?}"
        );
        assert!(pass_commit(&mut w.store, &client, &pass).committed);
        assert_eq!(status(&w.store), held);
        assert_eq!(
            (w.native(), queued_updates(&w.store)),
            (native.clone(), queued.clone())
        );
    }
    assert!(w.text().contains(RETAINED));
    desktop.close().await;
    w.close().await;
}

/// Opus's first finding: a document whose queued update a drain held, and
/// that a live session holds again, keeps that hold through each pass while
/// the session edits its head. The pass reports the hold marked stale, since
/// the session may have moved the head its binding names, so the commit
/// checks no currency and lands, storing the same hold marked stale. The
/// first drain once the session ends derives the binding again.
#[tokio::test]
async fn a_leased_document_keeps_its_drain_hold_while_its_head_changes_and_the_pass_commits() {
    let mut w = retained_window(Retained::Carried).await;
    let desktop = desktop_of(&w.base, &w.lineage, &[]).await;
    let (fold, fold_bytes) = desktop
        .fold(&format!("{}\nA desktop edit.\n", desktop.file()))
        .await;
    let feed = HostedFeed::new(&[("object", WINDOW_PATH)]);
    let fold = feed.serve(fold, fold_bytes);
    let client = dohc_engine_sync::RelaySyncClient::new(feed);
    let live = live_hosted_pass(&mut w.store, &client);
    assert!(pass_commit(&mut w.store, &client, &live).committed);
    let hold = settled_drain(&mut w.store)
        .released_hold
        .expect("the drain holds the fold");
    let dohc_engine_sync::HostedHold::ReleasedLineageUnsettled {
        binding,
        continuation,
        binding_stale: false,
    } = hold.clone()
    else {
        panic!("{hold:?}");
    };
    let stale = dohc_engine_sync::HostedHold::ReleasedLineageUnsettled {
        binding,
        continuation,
        binding_stale: true,
    };
    let queued = queued_updates(&w.store);
    for edit in ["Typed live.", "Typed again."] {
        // The session edits the head the binding named.
        let before = w.native();
        record_owned(
            &w.actor,
            &w.lineage,
            w.head().richdoc_append_paragraph(edit),
            edit,
        )
        .await;
        assert_ne!(w.native(), before, "the head moved");
        let pass = live_hosted_pass(&mut w.store, &client);
        assert_eq!(pass.held.get("object"), Some(&stale), "{pass:?}");
        assert!(pass_commit(&mut w.store, &client, &pass).committed);
        assert_eq!(
            dohc_engine_sync::read_hosted_replica(&w.store, "workspace")
                .unwrap()
                .unwrap()
                .documents["object"]
                .status,
            dohc_engine_sync::HostedDocumentStatus::Held(stale.clone())
        );
        assert_eq!(queued_updates(&w.store), queued);
    }
    assert!(journaled(&w.store, &fold));
    // The session ended: the drain decides again, and its hold claims
    // currency once more.
    let refreshed = settled_drain(&mut w.store)
        .released_hold
        .expect("the drain still holds the fold");
    assert!(
        matches!(
            refreshed,
            dohc_engine_sync::HostedHold::ReleasedLineageUnsettled {
                binding_stale: false,
                ..
            }
        ),
        "{refreshed:?}"
    );
    assert_eq!(queued_updates(&w.store), queued);
    desktop.close().await;
    w.close().await;
}

/// Sol's third test: a held document's queued work that the end-of-pass
/// drain admits, with no op of it in the feed, reaches the pass. Its drain
/// waits for validation, and the pass goes on after the wait. The
/// destructive fold behind that work keeps the document held, so no
/// readiness writes its head: the head the drain projected reaches the pass
/// only as the drain's own change.
#[tokio::test]
async fn the_end_of_pass_drain_reports_the_head_it_writes_across_a_validation_wait() {
    let mut w = retained_window(Retained::Carried).await;
    let desktop = desktop_of(&w.base, &w.lineage, &[]).await;
    let (first, first_bytes) = desktop.append(&w.lineage, "A first paragraph.").await;
    let (second, second_bytes) = desktop.append(&w.lineage, "A second paragraph.").await;
    let (fold, fold_bytes) = desktop
        .fold(&format!("{}\nA desktop edit.\n", desktop.file()))
        .await;
    let feed = HostedFeed::new(&[("object", WINDOW_PATH)]);
    feed.serve(first, first_bytes);
    feed.serve(second, second_bytes);
    let fold = feed.serve(fold, fold_bytes);
    let client = dohc_engine_sync::RelaySyncClient::new(feed);
    let live = live_hosted_pass(&mut w.store, &client);
    assert!(pass_commit(&mut w.store, &client, &live).committed);
    assert_eq!(queued_updates(&w.store).len(), 3);
    // A pass that read the document left it waiting for that work.
    execute(
        &mut w.store,
        "UPDATE hosted_documents SET state='held',held_reason='hosted-backfill-work-waiting' \
         WHERE object_id='object'",
    );
    let mut cache = dohc_engine_collab::WriterDocCache::new();
    let mut waits = 0;
    let pass = loop {
        match client.pull_hosted_workspace(
            &mut w.store,
            &mut cache,
            "workspace",
            "relay",
            &NoFaults,
            &dohc_engine_sync::NoLiveLeases,
        ) {
            Err(dohc_engine_sync::RelayError::ValidationPending(pending)) => {
                waits += 1;
                pending.validate().wait().unwrap();
            }
            pass => break pass.unwrap(),
        }
    };
    assert!(waits >= 1, "the drain waited for validation");
    let text = w.text();
    assert!(
        text.contains("A first paragraph.") && text.contains("A second paragraph."),
        "{text}"
    );
    assert_eq!(
        queued_updates(&w.store),
        vec![(
            fold.origin_id.clone(),
            fold.origin_seq,
            "hosted".to_owned(),
            Some("relay".to_owned())
        )],
        "only the fold stays queued"
    );
    let Some(dohc_engine_sync::HostedHold::ReleasedLineageUnsettled { binding, .. }) =
        pass.held.get("object")
    else {
        panic!("{pass:?}");
    };
    assert_eq!(
        (
            binding.incoming.origin_id.as_str(),
            binding.incoming.origin_seq
        ),
        (fold.origin_id.as_str(), fold.origin_seq)
    );
    assert!(
        pass.changed_paths
            .iter()
            .any(|change| change.path == WINDOW_PATH && change.operation == "write"),
        "{pass:?}"
    );
    // Storing the fold's hold counted a commit, so this pass's cursor no
    // longer stands; the next pass reports the same hold and commits.
    assert!(!pass_commit(&mut w.store, &client, &pass).committed);
    let next = hosted_pass(&mut w.store, &client, &mut cache);
    assert_eq!(next.held.get("object"), pass.held.get("object"));
    assert!(pass_commit(&mut w.store, &client, &next).committed);
    desktop.close().await;
    w.close().await;
}

/// Sol's fourth test, with real protection: a safe append queued while the
/// session held the document is held by its drain once the document's path
/// moved past what the tail's release bound. With the path back where the
/// release bound it, the end-of-pass drain decides the append again and
/// admits it, so that same pass names no released hold for the document,
/// and once its committed passes write the head it is ready.
#[tokio::test]
async fn a_held_update_admitted_on_fresh_evidence_leaves_the_pass_that_admits_it() {
    let mut w = retained_window(Retained::Carried).await;
    let desktop = desktop_of(&w.base, &w.lineage, &[]).await;
    let (append, append_bytes) = desktop.append(&w.lineage, "A desktop paragraph.").await;
    let feed = HostedFeed::new(&[("object", WINDOW_PATH)]);
    feed.serve(append, append_bytes);
    let client = dohc_engine_sync::RelaySyncClient::new(feed);
    let live = live_hosted_pass(&mut w.store, &client);
    assert!(pass_commit(&mut w.store, &client, &live).committed);
    assert_eq!(queued_updates(&w.store).len(), 1);
    write_unchecked(
        &w,
        "UPDATE path_aliases SET path='notes/renamed.md' WHERE object_id='object'",
    );
    let held = settled_drain(&mut w.store)
        .released_hold
        .expect("the moved document holds the append");
    let status = |store: &EngineStore| {
        dohc_engine_sync::read_hosted_replica(store, "workspace")
            .unwrap()
            .unwrap()
            .documents["object"]
            .status
            .clone()
    };
    assert_eq!(
        status(&w.store),
        dohc_engine_sync::HostedDocumentStatus::Held(held)
    );

    write_unchecked(
        &w,
        &format!("UPDATE path_aliases SET path='{WINDOW_PATH}' WHERE object_id='object'"),
    );
    let mut cache = dohc_engine_collab::WriterDocCache::new();
    let pass = hosted_pass(&mut w.store, &client, &mut cache);
    assert_eq!(
        queued_updates(&w.store),
        Vec::new(),
        "the drain admitted it"
    );
    assert!(w.text().contains("A desktop paragraph."));
    assert!(
        !matches!(
            pass.held.get("object"),
            Some(dohc_engine_sync::HostedHold::ReleasedLineageUnsettled { .. })
        ),
        "{pass:?}"
    );
    assert!(pass_commit(&mut w.store, &client, &pass).committed);
    for _ in 0..2 {
        if status(&w.store) == dohc_engine_sync::HostedDocumentStatus::Ready {
            break;
        }
        let next = hosted_pass(&mut w.store, &client, &mut cache);
        assert!(pass_commit(&mut w.store, &client, &next).committed);
    }
    assert_eq!(
        status(&w.store),
        dohc_engine_sync::HostedDocumentStatus::Ready
    );
    desktop.close().await;
    w.close().await;
}

/// Sol's sixth test: recovering the artifact of a session that ended
/// unpublished runs the document's drain, which applies a queued update and
/// then holds the destructive fold behind it, after validation waits. The
/// recovery reports the typed hold and the head the applied update wrote,
/// keeps the fold queued with its bytes, and records no recovery failure,
/// since a released hold is no failure. A hosted pass then reports the same
/// hold and commits.
#[tokio::test]
async fn artifact_recovery_that_meets_a_released_hold_reports_it_and_records_no_failure() {
    let mut w = retained_window(Retained::Carried).await;
    let desktop = desktop_of(&w.base, &w.lineage, &[]).await;
    let (first, first_bytes) = desktop.append(&w.lineage, "A first paragraph.").await;
    let (fold, fold_bytes) = desktop
        .fold(&format!("{}\nA desktop edit.\n", desktop.file()))
        .await;
    let fold_blob = hex_sha256(&fold_bytes);
    let feed = HostedFeed::new(&[("object", WINDOW_PATH)]);
    feed.serve(first, first_bytes);
    let fold = feed.serve(fold, fold_bytes);
    let client = dohc_engine_sync::RelaySyncClient::new(feed);
    let live = live_hosted_pass(&mut w.store, &client);
    assert!(pass_commit(&mut w.store, &client, &live).committed);
    assert_eq!(queued_updates(&w.store).len(), 2);
    // The session ended with its own edits settled and its artifact unwritten.
    execute(
        &mut w.store,
        &format!(
            "UPDATE ydoc_docs SET settled_update_seq=last_local_update_seq \
               WHERE object_id='object' AND last_local_update_seq>COALESCE(settled_update_seq,0); \
             INSERT INTO ydoc_pending_artifacts(workspace_id,version_id,object_id,moment_id, \
               origin_id,origin_seq,lineage_claim_id) \
             SELECT workspace_id,version_id,object_id,latest_moment_id,'origin',0,'{}' \
             FROM snapshots WHERE object_id='object'",
            w.lineage
        ),
    );

    let mut cache = dohc_engine_collab::WriterDocCache::new();
    let recovered = loop {
        let recovered = dohc_engine_sync::drain_open_document_artifacts(
            &mut w.store,
            &mut cache,
            "workspace",
            &dohc_engine_sync::NoLiveLeases,
            &NoFaults,
        )
        .unwrap();
        match recovered.waiting {
            Some(pending) => pending.validate().wait().unwrap(),
            None => break recovered,
        }
    };
    let Some(Some(dohc_engine_sync::HostedHold::ReleasedLineageUnsettled { binding, .. })) =
        recovered.holds.get("object")
    else {
        panic!("{:?}", recovered.holds);
    };
    assert_eq!(
        (
            binding.incoming.origin_id.as_str(),
            binding.incoming.origin_seq
        ),
        (fold.origin_id.as_str(), fold.origin_seq)
    );
    assert!(
        recovered
            .changes
            .iter()
            .any(|change| change.path == WINDOW_PATH && change.operation == "write"),
        "{:?}",
        recovered.changes
    );
    assert!(w.text().contains("A first paragraph."));
    assert!(w.text().contains(RETAINED));
    assert_eq!(
        queued_updates(&w.store),
        vec![(
            fold.origin_id.clone(),
            fold.origin_seq,
            "hosted".to_owned(),
            Some("relay".to_owned())
        )],
        "the fold stays queued"
    );
    assert!(w.store.get_binary_blob(&fold_blob).unwrap().is_some());
    let failures: i64 = w
        .store
        .read_with(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM replication_pending_refusals \
                 WHERE reason_code='document-artifact-recovery-failed'",
                [],
                |row| row.get(0),
            )
        })
        .unwrap();
    assert_eq!(failures, 0);

    let pass = hosted_pass(&mut w.store, &client, &mut cache);
    assert_eq!(
        pass.held.get("object"),
        recovered.holds["object"].as_ref(),
        "{pass:?}"
    );
    assert!(pass_commit(&mut w.store, &client, &pass).committed);
    desktop.close().await;
    w.close().await;
}

/// A control, not a distinguishing test: a ready document never has a
/// complete read of its own, so the readiness rule never decides it. A
/// peer's update its live session queues behind its lease leaves it ready at
/// the commit, and the session settles what it queued. A document already
/// held for queued work stays waiting while the same update is queued.
#[tokio::test]
async fn a_peer_update_queued_behind_a_live_session_keeps_its_ready_document_ready() {
    let mut w = retained_window(Retained::Carried).await;
    let desktop = desktop_of(&w.base, &w.lineage, &[]).await;
    let (append, append_bytes) = desktop.append(&w.lineage, "A desktop paragraph.").await;
    let feed = HostedFeed::new(&[("object", WINDOW_PATH)]);
    feed.serve(append, append_bytes);
    let client = dohc_engine_sync::RelaySyncClient::new(feed);
    let status = |store: &EngineStore| {
        dohc_engine_sync::read_hosted_replica(store, "workspace")
            .unwrap()
            .unwrap()
            .documents["object"]
            .status
            .clone()
    };
    assert_eq!(
        status(&w.store),
        dohc_engine_sync::HostedDocumentStatus::Ready
    );
    let live = live_hosted_pass(&mut w.store, &client);
    assert_eq!(queued_updates(&w.store).len(), 1, "the lease queued it");
    assert_eq!(live.held.get("object"), None, "{live:?}");
    assert!(pass_commit(&mut w.store, &client, &live).committed);
    assert_eq!(
        status(&w.store),
        dohc_engine_sync::HostedDocumentStatus::Ready,
        "nothing releases its registration"
    );

    execute(
        &mut w.store,
        "UPDATE hosted_documents SET state='held',held_reason='hosted-backfill-work-waiting' \
         WHERE object_id='object'",
    );
    let held = live_hosted_pass(&mut w.store, &client);
    assert_eq!(
        held.held.get("object"),
        Some(&dohc_engine_sync::HostedHold::WorkWaiting),
        "{held:?}"
    );
    assert!(pass_commit(&mut w.store, &client, &held).committed);
    assert_eq!(
        status(&w.store),
        dohc_engine_sync::HostedDocumentStatus::Held(dohc_engine_sync::HostedHold::WorkWaiting)
    );
    assert_eq!(queued_updates(&w.store).len(), 1);
    desktop.close().await;
    w.close().await;
}

/// Adopt the scope `client`'s feed now announces under `token`: a pass that
/// applies nothing.
fn rescoped(
    store: &mut EngineStore,
    client: &dohc_engine_sync::RelaySyncClient<HostedFeed>,
    token: &str,
    documents: &[(&str, &str)],
) {
    client.transport().rescope(token, documents);
    let pass = hosted_pass(
        store,
        client,
        &mut dohc_engine_collab::WriterDocCache::new(),
    );
    assert!(pass.pending_cursor.is_none(), "{pass:?}");
}

/// The window's document, held for its queued desktop fold: the fold queued
/// behind the host's session, which acknowledged it, and the drain as the
/// session ended held it for the work the released chain retains.
async fn held_for_a_queued_fold() -> (
    RetainedWindow,
    Desktop,
    dohc_engine_sync::RelaySyncClient<HostedFeed>,
) {
    held_for_a_queued_fold_of(Retained::Carried).await
}

/// [`held_for_a_queued_fold`], with the window retaining its work as
/// `retained`.
async fn held_for_a_queued_fold_of(
    retained: Retained,
) -> (
    RetainedWindow,
    Desktop,
    dohc_engine_sync::RelaySyncClient<HostedFeed>,
) {
    let mut w = retained_window(retained).await;
    let desktop = desktop_of(&w.base, &w.lineage, &[]).await;
    let (fold, fold_bytes) = desktop
        .fold(&format!("{}\nA desktop edit.\n", desktop.file()))
        .await;
    let feed = HostedFeed::new(&[("object", WINDOW_PATH)]);
    feed.serve(fold, fold_bytes);
    let client = dohc_engine_sync::RelaySyncClient::new(feed);
    let live = live_hosted_pass(&mut w.store, &client);
    assert!(pass_commit(&mut w.store, &client, &live).committed);
    let hold = settled_drain(&mut w.store)
        .released_hold
        .expect("the drain holds the fold");
    assert_eq!(
        hosted_status(&w.store, "object"),
        dohc_engine_sync::HostedDocumentStatus::Held(hold)
    );
    assert_eq!(queued_updates(&w.store).len(), 1);
    (w, desktop, client)
}

/// `pass` read `object` to the end of its rows, with the queued fold still
/// standing, wrote none of its heads, and leaves it waiting.
fn completed_waiting(store: &EngineStore, pass: &dohc_engine_sync::HostedPassOutcome) {
    let read = &pass
        .pending_cursor
        .as_ref()
        .expect("a pass to commit")
        .reads["object"];
    assert!(read.complete && !read.heads_written, "{read:?}");
    assert_eq!(
        pass.held.get("object"),
        Some(&dohc_engine_sync::HostedHold::WorkWaiting),
        "{pass:?}"
    );
    assert_eq!(queued_updates(store).len(), 1, "the fold stays queued");
}

/// The window document's inspection, as the host answers its owner.
fn inspected_window(store: &EngineStore) -> dohc_engine_sync::HeldDocumentInspection {
    dohc_engine_sync::inspect_held_document(store, "workspace", "object")
        .unwrap()
        .expect("the window document is held")
}

/// Every row that holds a document's native state, its blobs' bytes among
/// them: what inspection must leave exactly as it was.
fn native_rows(store: &EngineStore) -> Vec<String> {
    table_rows(
        store,
        &[
            "ydoc_docs",
            "ydoc_updates",
            "ydoc_snapshots",
            "ydoc_inactive_lineages",
            "binary_blobs",
            "hosted_documents",
            "hosted_replicas",
        ],
    )
}

/// What [`outbox_only`] stores under its entry's digest.
enum Stored {
    TheUpdate,
    Other(&'static [u8]),
    Nothing,
}

/// The same native state: what `a` and `b` integrated and what they show.
fn same_state(a: &[u8], b: &[u8]) -> bool {
    let [a, b] = [a, b].map(|bytes| {
        let doc = Ydoc::wire();
        doc.apply(bytes).unwrap();
        doc
    });
    a.encode_state_vector() == b.encode_state_vector()
        && a.encode_delete_set() == b.encode_delete_set()
        && a.canonical_content() == b.canonical_content()
}

/// Queue, past the store's checks, an owner edit only the released lineage's
/// outbox holds: a pending entry beside the retained delivery's, whose bytes
/// add `text` to the head, with `stored` under its digest. Answers its
/// contribution.
fn outbox_only(w: &mut RetainedWindow, text: &str, stored: Stored) -> RetainedContribution {
    let writer = Ydoc::wire();
    writer.apply(&w.native()).unwrap();
    let update = writer.richdoc_append_paragraph(text);
    let digest = hex_sha256(&update);
    match stored {
        Stored::TheUpdate => {
            w.store.put_binary_blob(&update).unwrap();
        }
        Stored::Other(bytes) => write_unchecked(
            w,
            &format!(
                "INSERT INTO binary_blobs (sha256,byte_length,bytes) VALUES ('{digest}',{},X'{}')",
                bytes.len(),
                bytes
                    .iter()
                    .map(|byte| format!("{byte:02x}"))
                    .collect::<String>()
            ),
        ),
        Stored::Nothing => {}
    }
    write_unchecked(
        w,
        &format!(
            "CREATE TEMP TABLE drafted AS SELECT * FROM owner_ydoc_outbox_entries WHERE delivery_id='{}';
             UPDATE drafted SET sequence=sequence+100,append_key='outbox-only',delivery_id='outbox-only',
               update_digest='{digest}',native_source_json=NULL,accepted_receipt_json=NULL,
               update_blob_digest='{digest}',byte_length={},pending=1,terminal_reason=NULL,
               terminal_blob_digest=NULL;
             INSERT INTO owner_ydoc_outbox_entries SELECT * FROM drafted",
            w.retained_delivery,
            update.len()
        ),
    );
    let (outbox_id, sequence): (String, i64) = w
        .store
        .read_with(|conn| {
            conn.query_row(
                "SELECT outbox_id,sequence FROM owner_ydoc_outbox_entries WHERE delivery_id='outbox-only'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
        })
        .unwrap();
    RetainedContribution::Outbox {
        outbox_id,
        sequence,
        delivery_id: "outbox-only".into(),
        update_digest: digest,
        // The draft declares no one, as the unattributed edit it copies.
        authors: RetainedAuthors::credited(None, None).unwrap(),
    }
}

/// The hold the drain derives again for the queued fold, stored.
fn rebound(w: &mut RetainedWindow) -> Box<ReleasedLineageBinding> {
    let Some(dohc_engine_sync::HostedHold::ReleasedLineageUnsettled {
        binding,
        binding_stale: false,
        ..
    }) = settled_drain(&mut w.store).released_hold
    else {
        panic!("the drain holds the fold again");
    };
    assert_eq!(
        inspected_window(&w.store).document.binding_digest,
        binding.digest()
    );
    binding
}

/// Plan r3, Round 2: discovery finds a held document from durable state
/// alone, after a restart with no editor, in object ID order and bounded.
/// Inspection of integrated but unproven Carried, seed and Own work finds it
/// all in the head: preservation is complete, merges nothing, and keeps the
/// retained text. Inspection writes nothing: the head and every native row
/// stay byte for byte.
#[tokio::test]
async fn inspection_preserves_integrated_retained_work_and_writes_nothing() {
    for retained in [Retained::Carried, Retained::Seed, Retained::Own] {
        let case = format!("{retained:?}");
        let (mut w, desktop, _client) = held_for_a_queued_fold_of(retained).await;
        let dohc_engine_sync::HostedDocumentStatus::Held(hold) = hosted_status(&w.store, "object")
        else {
            panic!("{case}: held");
        };
        let dohc_engine_sync::HostedHold::ReleasedLineageUnsettled { binding, .. } = hold else {
            panic!("{case}: not held for released work");
        };
        let (native, rows, ingress) = (w.native(), native_rows(&w.store), ingress_rows(&w.store));

        let inspection = inspected_window(&w.store);
        assert_eq!(
            inspection.document.binding_digest,
            binding.digest(),
            "{case}"
        );
        assert_eq!(
            inspection.status,
            dohc_engine_sync::HeldBindingStatus::Current,
            "{case}"
        );
        let preservation = inspection
            .preservation
            .expect("a current binding is inspected");
        assert_eq!(
            preservation.status,
            PreservationStatus::Complete,
            "{case}: {:?}",
            preservation.findings
        );
        assert!(
            preservation.merged.is_empty(),
            "{case}: the head holds it all: {:?}",
            preservation.merged
        );
        let preserved = preservation.preserved.expect("complete");
        assert!(
            preserved.markdown.contains(RETAINED),
            "{case}: {}",
            preserved.markdown
        );
        assert!(
            same_state(&preserved.full_state, &native),
            "{case}: the merge is the head"
        );
        assert_eq!(w.native(), native, "{case}: the head is unchanged");
        assert_eq!(native_rows(&w.store), rows, "{case}: native rows");
        assert_eq!(ingress_rows(&w.store), ingress, "{case}: retained records");

        w.store = EngineStore::open(&engine_db_path(&w.root).unwrap(), 0).unwrap();
        let page = dohc_engine_sync::list_held_documents(&w.store, "workspace", None, 1)
            .unwrap()
            .expect("a hosted replica");
        assert_eq!(page.documents.len(), 1, "{case}: after a restart");
        assert_eq!(page.documents[0].object_id, "object");
        assert_eq!(page.documents[0].binding_digest, binding.digest());
        assert_eq!(
            page.documents[0].continuation,
            dohc_engine_sync::ReleasedHoldContinuation::Frozen
        );
        assert!(!page.has_more && !page.documents[0].binding_stale, "{case}");
        let after = dohc_engine_sync::list_held_documents(&w.store, "workspace", Some("object"), 1)
            .unwrap()
            .unwrap();
        assert!(
            after.documents.is_empty() && !after.has_more,
            "{case}: {after:?}"
        );
        assert!(
            dohc_engine_sync::list_held_documents(&w.store, "workspace", None, 0).is_err(),
            "{case}: a page holds at least one document"
        );
        assert_eq!(
            dohc_engine_sync::list_held_documents(&w.store, "elsewhere", None, 1).unwrap(),
            None
        );
        assert_eq!(
            dohc_engine_sync::inspect_held_document(&w.store, "workspace", "elsewhere").unwrap(),
            None
        );
        assert_eq!(
            native_rows(&w.store),
            rows,
            "{case}: discovery writes nothing"
        );
        desktop.close().await;
        w.close().await;
    }
}

/// Plan r3, Round 2: work only an outbox holds merges into scratch state,
/// is named in `mergedContributionIds`, and appears in the preserved text
/// and native state, while the canonical head stays byte for byte without
/// it. A binding derived before that work existed no longer stands.
#[tokio::test]
async fn an_outbox_only_contribution_is_preserved_without_changing_the_head() {
    let (mut w, desktop, _client) = held_for_a_queued_fold().await;
    let earlier = inspected_window(&w.store).document.binding_digest;
    let contribution = outbox_only(&mut w, "Outbox only.", Stored::TheUpdate);
    let stale = inspected_window(&w.store);
    assert_eq!(
        stale.document.binding_digest, earlier,
        "nothing derived it again yet"
    );
    assert_eq!(stale.status, dohc_engine_sync::HeldBindingStatus::Stale);
    assert_eq!(stale.preservation, None, "a stale binding claims nothing");

    rebound(&mut w);
    let (native, rows) = (w.native(), native_rows(&w.store));
    let inspection = inspected_window(&w.store);
    assert_eq!(
        inspection.status,
        dohc_engine_sync::HeldBindingStatus::Current
    );
    let preservation = inspection.preservation.unwrap();
    assert_eq!(
        preservation.status,
        PreservationStatus::Complete,
        "{:?}",
        preservation.findings
    );
    assert_eq!(preservation.merged, vec![contribution]);
    let preserved = preservation.preserved.unwrap();
    assert!(
        preserved.markdown.contains("Outbox only.") && preserved.markdown.contains(RETAINED),
        "{}",
        preserved.markdown
    );
    let pinned = Ydoc::wire();
    pinned.apply(&preserved.full_state).unwrap();
    assert!(
        pinned
            .project(ContentKind::Richdoc)
            .unwrap()
            .content
            .contains("Outbox only.")
    );
    assert!(
        !w.text().contains("Outbox only."),
        "the head never takes it"
    );
    assert_eq!(w.native(), native);
    assert_eq!(native_rows(&w.store), rows);
    desktop.close().await;
    w.close().await;
}

/// Plan r3, Round 2: absent bytes, stored bytes another digest names, and
/// retained evidence that contradicts itself never preserve, and name what
/// they concern.
#[tokio::test]
async fn missing_corrupt_or_contradictory_evidence_never_preserves() {
    let (mut w, desktop, _client) = held_for_a_queued_fold().await;
    let contribution = outbox_only(&mut w, "Never stored.", Stored::Nothing);
    rebound(&mut w);
    let preservation = inspected_window(&w.store).preservation.unwrap();
    assert_eq!(preservation.status, PreservationStatus::MissingEvidence);
    assert_eq!(
        preservation
            .findings
            .iter()
            .map(|found| (found.reason, found.contribution.clone()))
            .collect::<Vec<_>>(),
        [(
            PreservationReason::SourceMissing,
            Some(contribution.locator())
        )]
    );
    assert_eq!(preservation.preserved, None);
    desktop.close().await;
    w.close().await;

    let (mut w, desktop, _client) = held_for_a_queued_fold().await;
    outbox_only(&mut w, "Stored wrong.", Stored::Other(b"x"));
    rebound(&mut w);
    let preservation = inspected_window(&w.store).preservation.unwrap();
    assert_eq!(preservation.status, PreservationStatus::InvalidEvidence);
    assert!(
        preservation
            .findings
            .iter()
            .any(|found| found.reason == PreservationReason::DigestMismatch),
        "{:?}",
        preservation.findings
    );
    assert_eq!(preservation.preserved, None);
    desktop.close().await;
    w.close().await;

    let (mut w, desktop, _client) = held_for_a_queued_fold().await;
    write_unchecked(
        &w,
        &format!(
            "UPDATE owner_ydoc_outbox_entries SET accepted_receipt_json=json_set(accepted_receipt_json,'$.journalCursor',99) \
             WHERE delivery_id='{}'",
            w.retained_delivery
        ),
    );
    rebound(&mut w);
    let preservation = inspected_window(&w.store).preservation.unwrap();
    assert_eq!(preservation.status, PreservationStatus::InvalidEvidence);
    assert_eq!(
        preservation
            .findings
            .iter()
            .map(|found| found.reason)
            .collect::<Vec<_>>(),
        [PreservationReason::ContradictoryEvidence]
    );
    assert_eq!(preservation.preserved, None);
    desktop.close().await;
    w.close().await;
}

/// Sol's r2c Ruling A: a hold derived before the retained delivery's journal
/// row named another author names coverage validation no longer gives, so it
/// inspects as stale. Derived again, it names invalid coverage, and
/// inspecting it answers the contradiction and where its work is, with
/// nothing to keep.
#[tokio::test]
async fn coverage_stronger_validation_refuses_inspects_as_stale_then_as_its_finding() {
    let (mut w, desktop, _client) = held_for_a_queued_fold().await;
    assert_eq!(
        inspected_window(&w.store).status,
        dohc_engine_sync::HeldBindingStatus::Current
    );
    write_unchecked(
        &w,
        &format!(
            "UPDATE ydoc_updates SET actor_origin_id='impostor' WHERE seq=
               (SELECT json_extract(native_source_json,'$.nativeSequence') FROM owner_ydoc_outbox_entries
                WHERE delivery_id='{}')",
            w.retained_delivery
        ),
    );
    let stale = inspected_window(&w.store);
    assert_eq!(stale.status, dohc_engine_sync::HeldBindingStatus::Stale);
    assert_eq!(stale.preservation, None);
    rebound(&mut w);
    let preservation = inspected_window(&w.store).preservation.unwrap();
    assert_eq!(preservation.status, PreservationStatus::InvalidEvidence);
    assert_eq!(
        preservation
            .findings
            .iter()
            .map(|found| (
                found.reason,
                found.namespace.clone(),
                found.contribution.clone()
            ))
            .collect::<Vec<_>>(),
        [(
            PreservationReason::ContradictoryEvidence,
            Some("relay".to_owned()),
            Some(ContributionLocator::Carried {
                delivery_id: w.retained_delivery.clone(),
                update_digest: w.retained_digest.clone(),
                journal_cursor: 2,
            })
        )]
    );
    assert!(preservation.covered.is_empty() && preservation.preserved.is_none());
    desktop.close().await;
    w.close().await;
}

/// Plan r3, Round 2: a hold its store marks stale, a binding whose path
/// moved since, and a feed the replica no longer reads all inspect as stale,
/// with nothing actionable.
#[tokio::test]
async fn a_binding_that_no_longer_stands_inspects_as_stale() {
    let damages: [(&str, &str); 3] = [
        (
            "marked stale",
            "UPDATE hosted_documents SET released_hold_binding_stale=1 WHERE object_id='object'",
        ),
        (
            "moved",
            "UPDATE path_aliases SET path='notes/moved.md' WHERE object_id='object'",
        ),
        (
            "another feed",
            "UPDATE sync_identity SET stream_identity='another-stream'",
        ),
    ];
    for (case, damage) in damages {
        let (w, desktop, _client) = held_for_a_queued_fold().await;
        assert_eq!(
            inspected_window(&w.store).status,
            dohc_engine_sync::HeldBindingStatus::Current,
            "{case}"
        );
        write_unchecked(&w, damage);
        let inspection = inspected_window(&w.store);
        assert_eq!(
            inspection.status,
            dohc_engine_sync::HeldBindingStatus::Stale,
            "{case}"
        );
        assert_eq!(inspection.preservation, None, "{case}");
        desktop.close().await;
        w.close().await;
    }
}

/// Sol's archived-binding ruling: inspection selects native state by the
/// binding's lineage. An archived hold is inspected against the state its
/// archive keeps, never the head's, even once the head's own lineage moved
/// on, and both stay as they were.
#[tokio::test]
async fn an_archived_hold_is_inspected_against_its_archive() {
    let (mut w, desktop, client, queued, archive) = archived_window(2).await;
    let first = committed_pass(&mut w.store, &client);
    assert!(
        holds_archived(first.held.get("object"), &w.lineage, &archive, &queued[0]),
        "{first:?}"
    );
    let head = hex_sha256(b"the winning lineage");
    let (current, current_bytes) = safe_row(&[&w.native()], &head, "A paragraph of the head.");
    let current = client.transport().serve(current, current_bytes);
    let pass = hosted_pass(
        &mut w.store,
        &client,
        &mut dohc_engine_collab::WriterDocCache::new(),
    );
    assert!(journaled(&w.store, &current), "{pass:?}");
    assert!(pass_commit(&mut w.store, &client, &pass).committed);
    assert!(w.text().contains("A paragraph of the head."));
    let (native, rows) = (w.native(), native_rows(&w.store));

    let inspection = inspected_window(&w.store);
    let artifact = inspection
        .contributions
        .as_ref()
        .and_then(dohc_engine_sync::HeldContributions::artifact)
        .expect("an artifact");
    let artifact: serde_json::Value = serde_json::from_slice(&artifact.bytes).unwrap();
    let bound = ReleasedLineageBinding::from_json(&artifact["binding"]).unwrap();
    assert_eq!(bound.digest(), inspection.document.binding_digest);
    assert_eq!(bound.lineage_claim_id, w.lineage);
    assert_eq!(bound.head_digest, archive);
    assert_eq!(
        inspection.status,
        dohc_engine_sync::HeldBindingStatus::Current
    );
    let preservation = inspection.preservation.unwrap();
    assert_eq!(
        preservation.status,
        PreservationStatus::Complete,
        "{:?}",
        preservation.findings
    );
    let preserved = preservation.preserved.unwrap();
    assert!(
        preserved.markdown.contains(RETAINED),
        "{}",
        preserved.markdown
    );
    assert!(
        !preserved.markdown.contains("A paragraph of the head."),
        "the archive, not the head: {}",
        preserved.markdown
    );
    let archived = w.store.get_binary_blob(&archive).unwrap().unwrap();
    assert!(
        same_state(&preserved.full_state, &archived),
        "the archive holds it all"
    );
    assert_eq!(archived_state(&w.store, &w.lineage), archive);
    assert_eq!(w.native(), native);
    assert_eq!(native_rows(&w.store), rows);
    desktop.close().await;
    w.close().await;
}

/// Opus's r2a F7: an archive whose full state is gone, or is not the bytes
/// its digest names, answers a machine-readable finding about the lineage
/// rather than an error, so its owner tells corrupt state from a failed
/// read. Nothing merges or preserves.
#[tokio::test]
async fn a_corrupt_archive_answers_a_finding_not_an_error() {
    for (case, damage) in [
        (
            "missing",
            "DELETE FROM binary_blobs WHERE sha256='{archive}'",
        ),
        (
            "mismatched",
            "UPDATE binary_blobs SET bytes=X'00',byte_length=1 WHERE sha256='{archive}'",
        ),
    ] {
        let (mut w, desktop, client, queued, archive) = archived_window(2).await;
        let first = committed_pass(&mut w.store, &client);
        assert!(
            holds_archived(first.held.get("object"), &w.lineage, &archive, &queued[0]),
            "{case}: {first:?}"
        );
        write_unchecked(&w, &damage.replace("{archive}", &archive));
        let inspection = inspected_window(&w.store);
        assert_eq!(
            inspection.status,
            dohc_engine_sync::HeldBindingStatus::Current,
            "{case}"
        );
        let preservation = inspection
            .preservation
            .expect("a current binding is inspected");
        assert_eq!(
            preservation.status,
            PreservationStatus::InvalidEvidence,
            "{case}"
        );
        assert_eq!(
            preservation
                .findings
                .iter()
                .map(|found| (
                    found.reason,
                    found.namespace.clone(),
                    found.contribution.clone()
                ))
                .collect::<Vec<_>>(),
            [(PreservationReason::ContradictoryEvidence, None, None)],
            "{case}"
        );
        assert!(preservation.merged.is_empty(), "{case}");
        assert_eq!(preservation.preserved, None, "{case}");
        desktop.close().await;
        w.close().await;
    }
}

/// The commit stored `object` waiting, and it still is after a restart. The
/// next pass's drain holds it again for the fold.
fn waits_then_holds_again(
    w: &mut RetainedWindow,
    client: &dohc_engine_sync::RelaySyncClient<HostedFeed>,
) {
    let waiting =
        dohc_engine_sync::HostedDocumentStatus::Held(dohc_engine_sync::HostedHold::WorkWaiting);
    assert_eq!(hosted_status(&w.store, "object"), waiting);
    w.store = EngineStore::open(&engine_db_path(&w.root).unwrap(), 0).unwrap();
    assert_eq!(
        hosted_status(&w.store, "object"),
        waiting,
        "after a restart"
    );
    assert_eq!(queued_updates(&w.store).len(), 1);
    let again = committed_pass(&mut w.store, client);
    assert!(
        matches!(
            again.held.get("object"),
            Some(dohc_engine_sync::HostedHold::ReleasedLineageUnsettled { .. })
        ),
        "{again:?}"
    );
    assert!(matches!(
        hosted_status(&w.store, "object"),
        dohc_engine_sync::HostedDocumentStatus::Held(
            dohc_engine_sync::HostedHold::ReleasedLineageUnsettled { .. }
        )
    ));
    assert!(w.text().contains(RETAINED));
}

/// Sol's readiness ruling, its first case: a document held for its queued
/// fold leaves the scope, which the work its chain retains keeps from
/// parking, and returns. Its return clears the stored hold and backfills it
/// from the start. Its read completes with the fold still queued, so the
/// pass and its commit keep it waiting, with no heads written, never ready.
/// A backfill that reads the fold again stops there and holds it afresh, so
/// the feed serves none of its rows on the return: the read the readiness
/// rule decides is one that completes.
#[tokio::test]
async fn a_returning_document_keeps_its_queued_released_work_waiting() {
    let (mut w, desktop, client) = held_for_a_queued_fold().await;
    assert!(
        !dohc_engine_sync::hosted_document_parkable(&w.store, "workspace", "object").unwrap(),
        "the work it accepted keeps it from parking"
    );
    rescoped(&mut w.store, &client, "away", &[]);
    client.transport().rows.lock().unwrap().clear();
    rescoped(&mut w.store, &client, "back", &[("object", WINDOW_PATH)]);
    assert_eq!(
        hosted_status(&w.store, "object"),
        dohc_engine_sync::HostedDocumentStatus::Backfilling
    );
    let pass = hosted_pass(
        &mut w.store,
        &client,
        &mut dohc_engine_collab::WriterDocCache::new(),
    );
    completed_waiting(&w.store, &pass);
    commit_pass(&mut w.store, &client, &pass);
    waits_then_holds_again(&mut w, &client);
    desktop.close().await;
    w.close().await;
}

/// Sol's readiness ruling, its second case: a stopped read's commit
/// replaces the released hold's stored reason with one no drain takes up. Once
/// that blocker is gone, the next read completes with the fold still queued,
/// so the document waits; the drain after that holds it again.
#[tokio::test]
async fn a_document_whose_stopped_read_clears_keeps_its_queued_released_work_waiting() {
    let (mut w, desktop, client) = held_for_a_queued_fold().await;
    let pass = hosted_pass(
        &mut w.store,
        &client,
        &mut dohc_engine_collab::WriterDocCache::new(),
    );
    // Its read stops at a conflict child whose parent the feed withholds.
    let mut cursor = pass.pending_cursor.clone().unwrap();
    let read = cursor.reads.get_mut("object").unwrap();
    let withheld = dohc_engine_sync::HostedHold::ConflictParentWithheld {
        conflict_id: "withheld".into(),
    };
    read.stopped = Some(withheld.clone());
    read.complete = false;
    read.heads_written = false;
    let committed = client
        .commit_hosted_cursor(
            &mut w.store,
            "workspace",
            &cursor,
            &ReleasedTails::uncached(),
            &NoFaults,
        )
        .unwrap();
    assert!(matches!(
        committed,
        dohc_engine_storage::TxnOutcome::Committed(dohc_engine_sync::HostedCommit {
            committed: true,
            ..
        })
    ));
    assert_eq!(
        hosted_status(&w.store, "object"),
        dohc_engine_sync::HostedDocumentStatus::Held(withheld)
    );
    w.store = EngineStore::open(&engine_db_path(&w.root).unwrap(), 0).unwrap();
    // The feed serves nothing that stops it now.
    let pass = hosted_pass(
        &mut w.store,
        &client,
        &mut dohc_engine_collab::WriterDocCache::new(),
    );
    completed_waiting(&w.store, &pass);
    commit_pass(&mut w.store, &client, &pass);
    waits_then_holds_again(&mut w, &client);
    desktop.close().await;
    w.close().await;
}

/// Sol's readiness ruling, its last three cases: a ready document the scope
/// moves away from its head, with a peer's append its session queued, keeps
/// the mismatch its complete reads find, across a restart. Once the scope
/// names its head's path again it waits for that append, and once a drain
/// applies it the next pass writes its heads and it becomes ready.
#[tokio::test]
async fn a_moved_document_keeps_its_mismatch_then_waits_for_its_queued_work_before_ready() {
    let mut w = retained_window(Retained::Carried).await;
    let desktop = desktop_of(&w.base, &w.lineage, &[]).await;
    let (append, append_bytes) = desktop.append(&w.lineage, "A desktop paragraph.").await;
    let feed = HostedFeed::new(&[("object", WINDOW_PATH)]);
    feed.serve(append, append_bytes);
    let client = dohc_engine_sync::RelaySyncClient::new(feed);
    let live = live_hosted_pass(&mut w.store, &client);
    assert!(pass_commit(&mut w.store, &client, &live).committed);
    assert_eq!(queued_updates(&w.store).len(), 1, "the lease queued it");
    rescoped(
        &mut w.store,
        &client,
        "moved",
        &[("object", "notes/moved.md")],
    );
    let mismatch = dohc_engine_sync::HostedHold::ScopePathMismatch {
        scope_path: "notes/moved.md".into(),
        head_path: Some(WINDOW_PATH.into()),
    };
    assert_eq!(
        hosted_status(&w.store, "object"),
        dohc_engine_sync::HostedDocumentStatus::Held(mismatch.clone())
    );
    for restarted in [false, true] {
        if restarted {
            w.store = EngineStore::open(&engine_db_path(&w.root).unwrap(), 0).unwrap();
        }
        let pass = hosted_pass(
            &mut w.store,
            &client,
            &mut dohc_engine_collab::WriterDocCache::new(),
        );
        let read = &pass.pending_cursor.as_ref().unwrap().reads["object"];
        assert!(read.complete && !read.heads_written, "{read:?}");
        assert_eq!(pass.held.get("object"), Some(&mismatch), "{pass:?}");
        assert_eq!(queued_updates(&w.store).len(), 1);
        commit_pass(&mut w.store, &client, &pass);
        assert_eq!(
            hosted_status(&w.store, "object"),
            dohc_engine_sync::HostedDocumentStatus::Held(mismatch.clone())
        );
    }

    rescoped(&mut w.store, &client, "named", &[("object", WINDOW_PATH)]);
    let pass = hosted_pass(
        &mut w.store,
        &client,
        &mut dohc_engine_collab::WriterDocCache::new(),
    );
    let read = &pass.pending_cursor.as_ref().unwrap().reads["object"];
    assert!(read.complete && !read.heads_written, "{read:?}");
    assert_eq!(
        pass.held.get("object"),
        Some(&dohc_engine_sync::HostedHold::WorkWaiting),
        "{pass:?}"
    );
    assert_eq!(queued_updates(&w.store).len(), 1);
    commit_pass(&mut w.store, &client, &pass);
    let waiting =
        dohc_engine_sync::HostedDocumentStatus::Held(dohc_engine_sync::HostedHold::WorkWaiting);
    assert_eq!(hosted_status(&w.store, "object"), waiting);
    w.store = EngineStore::open(&engine_db_path(&w.root).unwrap(), 0).unwrap();
    assert_eq!(
        hosted_status(&w.store, "object"),
        waiting,
        "after a restart"
    );

    // The drain applies the append; the pass that makes it ready writes its
    // heads.
    let mut pass = committed_pass(&mut w.store, &client);
    assert_eq!(queued_updates(&w.store), Vec::new(), "{pass:?}");
    assert!(w.text().contains("A desktop paragraph."));
    if hosted_status(&w.store, "object") != dohc_engine_sync::HostedDocumentStatus::Ready {
        pass = committed_pass(&mut w.store, &client);
    }
    assert!(
        pass.pending_cursor.as_ref().unwrap().reads["object"].heads_written,
        "{pass:?}"
    );
    assert_eq!(
        hosted_status(&w.store, "object"),
        dohc_engine_sync::HostedDocumentStatus::Ready
    );
    desktop.close().await;
    w.close().await;
}

/// Sol's readiness ruling 3: archived admission precedes the live lease. A
/// ready document whose session is live receives a peer's update of its
/// archived lineage that released tails protect. The archive keeps its
/// state, the update is neither acknowledged nor queued, and the commit
/// holds the document, which ends its session.
#[tokio::test]
async fn a_live_documents_protected_archived_update_stays_in_the_feed_and_holds_it() {
    let mut w = retained_window(Retained::Carried).await;
    let desktop = desktop_of(&w.base, &w.lineage, &[]).await;
    let archive = archive_lineage(&mut w);
    assert_eq!(
        hosted_status(&w.store, "object"),
        dohc_engine_sync::HostedDocumentStatus::Ready
    );
    let (update, bytes) = desktop.append(&w.lineage, "An archived paragraph.").await;
    let feed = HostedFeed::new(&[("object", WINDOW_PATH)]);
    let update = feed.serve(update, bytes);
    let client = dohc_engine_sync::RelaySyncClient::new(feed);
    let pass = live_hosted_pass(&mut w.store, &client);
    assert!(
        holds_archived(pass.held.get("object"), &w.lineage, &archive, &update),
        "{pass:?}"
    );
    assert!(!journaled(&w.store, &update), "not acknowledged");
    assert_eq!(queued_feeds(&w.store), Vec::<String>::new(), "not queued");
    assert_eq!(archived_state(&w.store, &w.lineage), archive);
    assert!(pass_commit(&mut w.store, &client, &pass).committed);
    assert_eq!(
        hosted_status(&w.store, "object"),
        dohc_engine_sync::HostedDocumentStatus::Held(pass.held["object"].clone()),
        "a document that is not ready ends its session"
    );
    desktop.close().await;
    w.close().await;
}

/// A Collection record of the window's store, ordered before the window's
/// document.
const RECORD_OBJECT: &str = "a-record";
const RECORD_PATH: &str = "tasks/a.md";
const RECORD_ID: &str = "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa";

fn record_key() -> DocKey {
    DocKey::new("workspace", "main", RECORD_OBJECT).unwrap()
}

/// A text head of `object_id` at `path`, as ordinary sync left it.
fn seed_head(store: &mut EngineStore, object_id: &str, path: &str, text: &str) {
    dohc_engine_domain::VersionedTextStore::new(store)
        .write_text(
            &dohc_engine_domain::WriteText {
                workspace_id: "workspace".to_owned(),
                version_id: "main".to_owned(),
                object_id: object_id.to_owned(),
                path: path.to_owned(),
                text: text.to_owned(),
                moment_id: format!("seed-{object_id}"),
                metadata_origin: "sync".to_owned(),
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

/// Add [`RECORD_OBJECT`] to the window's store: its Collection's schema and
/// the record as files, the record adopted, its Y.Doc lineage a base
/// established, and a ready hosted document of it.
fn add_collection_record(w: &mut RetainedWindow) {
    let markdown = format!("---\nid: {RECORD_ID}\ntitle: Original\n---\n\nBody\n");
    std::fs::create_dir_all(w.root.path().join("tasks")).unwrap();
    seed_head(
        &mut w.store,
        "a-schema",
        "tasks/collection.yaml",
        "fields:\n  title:\n    type: text\n",
    );
    seed_head(&mut w.store, RECORD_OBJECT, RECORD_PATH, &markdown);
    w.store
        .write_with(&NoFaults, |tx| {
            dohc_engine_domain::reconcile_collections_in_tx(tx, "workspace", "main")?;
            dohc_engine_domain::set_collection_adoption_state_in_tx(
                tx,
                "workspace",
                "main",
                RECORD_PATH,
                RECORD_ID,
                "adopted",
            )
        })
        .unwrap();
    let local = Ydoc::wire();
    local
        .rewrite_content_to_markdown(ContentKind::Richdoc, &markdown)
        .unwrap();
    dohc_engine_collab::claim_base(
        &mut w.store,
        &record_key(),
        ContentKind::Richdoc,
        &local.encode_full_state(),
        &NoFaults,
        1_500,
    )
    .unwrap();
    execute(
        &mut w.store,
        &format!(
            "INSERT INTO hosted_documents(workspace_id,object_id,path,state,scope_generation) \
             VALUES ('workspace','{RECORD_OBJECT}','{RECORD_PATH}','ready',1)"
        ),
    );
}

/// A peer's update that sets the record's title.
fn record_title_update(
    store: &EngineStore,
    title: &str,
) -> (dohc_engine_sync::ReplicationEnvelope, Vec<u8>) {
    let head = dohc_engine_collab::load_persisted(store, &record_key())
        .unwrap()
        .unwrap();
    let remote = Ydoc::wire();
    remote.apply(&head.doc.encode_full_state()).unwrap();
    let bytes = remote.frontmatter_set("title", title).unwrap();
    let lineage = head.marker.lineage_claim_id.unwrap();
    let op = peer_update(&record_key(), RECORD_PATH, &lineage, 0, &bytes);
    (op, bytes)
}

/// The peer's update of `key`'s `lineage` at `origin_seq`, carrying `bytes`.
fn peer_update(
    key: &DocKey,
    path: &str,
    lineage: &str,
    origin_seq: i64,
    bytes: &[u8],
) -> dohc_engine_sync::ReplicationEnvelope {
    dohc_engine_sync::ReplicationEnvelope {
        settlement_admission: None,
        admitted_author_snapshot: None,
        workspace_id: "workspace".into(),
        origin_id: "peer".into(),
        origin_seq,
        relay_seq: None,
        op_kind: "ydoc.update".into(),
        payload: serde_json::json!({
            "versionId": "main", "objectId": key.object_id, "path": path,
            "contentKind": "richdoc", "updateBlobSha256": hex_sha256(bytes),
            "lineageClaimId": lineage, "isBaseState": false,
        }),
        recorded_at_ms: 2_000,
    }
}

/// The window's document and the record, both live on the host.
struct BothLive;

impl dohc_engine_sync::LeaseProbe for BothLive {
    fn is_live(&self, key: &DocKey) -> bool {
        *key == window_key() || *key == record_key()
    }
}

/// The scope of a feed holding the record and the window's document.
const BOTH: [(&str, &str); 2] = [(RECORD_OBJECT, RECORD_PATH), ("object", WINDOW_PATH)];

/// Each row a feed served, with its bytes, in relay order.
type Served = Vec<(dohc_engine_sync::ReplicationEnvelope, Vec<u8>)>;

/// A new client, as a new request has, over a feed of [`BOTH`] serving
/// `rows` at the positions the first feed served them.
fn served_again(rows: &Served) -> dohc_engine_sync::RelaySyncClient<HostedFeed> {
    let feed = HostedFeed::new(&BOTH);
    for (op, bytes) in rows {
        feed.serve(op.clone(), bytes.clone());
    }
    dohc_engine_sync::RelaySyncClient::new(feed)
}

/// The window with the record added, and a client whose feed served the
/// record's title change and two desktop appends while both documents were
/// live: a committed pass queued all three, and both documents are ready.
async fn record_and_window_queued() -> (
    RetainedWindow,
    Desktop,
    dohc_engine_sync::RelaySyncClient<HostedFeed>,
) {
    let (w, desktop, client, _) = record_and_window_served().await;
    (w, desktop, client)
}

/// [`record_and_window_queued`], with the rows its feed served.
async fn record_and_window_served() -> (
    RetainedWindow,
    Desktop,
    dohc_engine_sync::RelaySyncClient<HostedFeed>,
    Served,
) {
    let mut w = retained_window(Retained::Carried).await;
    add_collection_record(&mut w);
    let desktop = desktop_of(&w.base, &w.lineage, &[]).await;
    let (first, first_bytes) = desktop.append(&w.lineage, "A first paragraph.").await;
    let (second, second_bytes) = desktop.append(&w.lineage, "A second paragraph.").await;
    let (titled, titled_bytes) = record_title_update(&w.store, "Remote");
    let feed = HostedFeed::new(&BOTH);
    let mut rows = Served::new();
    for (op, bytes) in [
        (titled, titled_bytes),
        (first, first_bytes),
        (second, second_bytes),
    ] {
        rows.push((feed.serve(op, bytes.clone()), bytes));
    }
    let client = dohc_engine_sync::RelaySyncClient::new(feed);
    let mut cache = dohc_engine_collab::WriterDocCache::new();
    let live = loop {
        match client.pull_hosted_workspace(
            &mut w.store,
            &mut cache,
            "workspace",
            "relay",
            &NoFaults,
            &BothLive,
        ) {
            Err(dohc_engine_sync::RelayError::ValidationPending(pending)) => {
                pending.validate().wait().unwrap();
            }
            pass => break pass.unwrap(),
        }
    };
    assert!(pass_commit(&mut w.store, &client, &live).committed);
    assert_eq!(queued_updates(&w.store).len(), 3);
    assert_eq!(field_history(&w.store), 0);
    (w, desktop, client, rows)
}

/// How many of `facts` report the record's title change to "Remote".
fn remote_titles(facts: &[dohc_engine_domain::CollectionRecordApplyFacts]) -> usize {
    facts
        .iter()
        .filter(|facts| {
            facts.record_id == RECORD_ID
                && facts.fields.iter().any(|field| {
                    field.field_name == "title" && field.next_json.as_deref() == Some("\"Remote\"")
                })
        })
        .count()
}

/// How many drain reports the store keeps.
fn drain_reports(store: &EngineStore) -> i64 {
    store
        .read_with(|conn| {
            conn.query_row("SELECT COUNT(*) FROM ydoc_drain_reports", [], |row| {
                row.get(0)
            })
        })
        .unwrap()
}

/// After a pass waited with the record's queued title change removed and
/// its report owed: resume it, or abandon it, with a restart or not, and
/// run the next request. That request reports the change once, its commit
/// acknowledges the report, and the pass after it reports nothing.
fn owed_title_reported_once(
    w: &mut RetainedWindow,
    after: AfterWait,
    client: dohc_engine_sync::RelaySyncClient<HostedFeed>,
    cache: dohc_engine_collab::WriterDocCache,
    pending: Box<PendingValidation>,
    rows: &Served,
) {
    assert_eq!(field_history(&w.store), 1, "{after:?}");
    assert!(
        !record_update_parked(&w.store),
        "{after:?}: its row is gone"
    );
    assert_eq!(drain_reports(&w.store), 1, "{after:?}: its report is owed");
    let (client, mut cache) = match after {
        AfterWait::Resume => {
            pending.validate().wait().unwrap();
            (client, cache)
        }
        AfterWait::Abandon | AfterWait::Restart => {
            drop(pending);
            if matches!(after, AfterWait::Restart) {
                w.store = EngineStore::open(&engine_db_path(&w.root).unwrap(), 0).unwrap();
            }
            (
                served_again(rows),
                dohc_engine_collab::WriterDocCache::new(),
            )
        }
    };
    let mut pass = hosted_pass(&mut w.store, &client, &mut cache);
    assert_eq!(remote_titles(&pass.record_facts), 1, "{after:?}: {pass:?}");
    if matches!(after, AfterWait::Restart) {
        // A pass that reported it and never committed leaves it owed.
        w.store = EngineStore::open(&engine_db_path(&w.root).unwrap(), 0).unwrap();
        pass = hosted_pass(&mut w.store, &client, &mut cache);
        assert_eq!(remote_titles(&pass.record_facts), 1, "{after:?}: {pass:?}");
    }
    assert_eq!(field_history(&w.store), 1, "{after:?}");
    assert!(pass_commit(&mut w.store, &client, &pass).committed);
    assert_eq!(drain_reports(&w.store), 0, "{after:?}: acknowledged");
    let next = hosted_pass(&mut w.store, &client, &mut cache);
    assert_eq!(remote_titles(&next.record_facts), 0, "{after:?}: {next:?}");
}

/// Sol's ruling 1, window (c): a pass's op for the record drains its queued
/// title change before it applies, which removes that row, and a later op of
/// the window waits for validation. Whether the request resumes, is
/// abandoned, or the store restarts, the change reaches the next reporting
/// boundary once through the drain report its removal wrote.
#[tokio::test]
async fn an_ingress_drains_facts_survive_a_later_ops_wait() {
    for after in [AfterWait::Resume, AfterWait::Abandon, AfterWait::Restart] {
        let (mut w, desktop, client, mut rows) = record_and_window_served().await;
        let record_lineage = record_lineage(&w.store);
        let head = dohc_engine_collab::load_persisted(&w.store, &record_key())
            .unwrap()
            .unwrap();
        let remote = Ydoc::wire();
        remote.apply(&head.doc.encode_full_state()).unwrap();
        let paragraph = remote.richdoc_append_paragraph("A record paragraph.");
        let record_op = peer_update(&record_key(), RECORD_PATH, &record_lineage, 1, &paragraph);
        let (third, third_bytes) = desktop.append(&w.lineage, "A third paragraph.").await;
        for (op, bytes) in [(record_op, paragraph), (third, third_bytes)] {
            rows.push((client.transport().serve(op, bytes.clone()), bytes));
        }
        let mut cache = dohc_engine_collab::WriterDocCache::new();
        let waited = client.pull_hosted_workspace(
            &mut w.store,
            &mut cache,
            "workspace",
            "relay",
            &NoFaults,
            &dohc_engine_sync::NoLiveLeases,
        );
        let Err(dohc_engine_sync::RelayError::ValidationPending(pending)) = waited else {
            panic!("{after:?}: {waited:?}");
        };
        owed_title_reported_once(&mut w, after, client, cache, pending, &rows);
        desktop.close().await;
        w.close().await;
    }
}

/// Sol's ruling 1, window (b): the pass's inactive drain applies the
/// record's queued title change, which an earlier drain applied to the head
/// before its lineage was archived, to that archive and removes its row; the
/// window's drain then waits for validation. Whether the request resumes,
/// is abandoned, or the store restarts, the change reaches the next
/// reporting boundary once through the drain report its removal wrote.
#[tokio::test]
async fn an_inactive_drains_facts_survive_a_later_wait() {
    for after in [AfterWait::Resume, AfterWait::Abandon, AfterWait::Restart] {
        let (mut w, desktop, client, rows) = record_and_window_served().await;
        // An earlier drain applied the change and stopped before its cleanup.
        let (stopped, _cleanup) = dohc_engine_sync::drain_deferred_ydoc_for_key_holding_cleanup(
            &mut w.store,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &record_key(),
            &NoFaults,
        )
        .unwrap();
        assert_eq!(remote_titles(&stopped.record_facts), 1, "{after:?}");
        assert!(record_update_parked(&w.store), "{after:?}");
        // Its lineage is archived and another takes the head. The archive
        // refuses while rows are queued, so they are set aside around it.
        let lineage = record_lineage(&w.store);
        let head = dohc_engine_collab::load_persisted(&w.store, &record_key())
            .unwrap()
            .unwrap();
        let vector = hex_sha256(&head.doc.encode_state_vector());
        execute(
            &mut w.store,
            "CREATE TEMP TABLE set_aside AS SELECT * FROM ydoc_deferred_updates; \
             DELETE FROM ydoc_deferred_updates;",
        );
        w.store
            .write_with(&NoFaults, |tx| {
                dohc_engine_collab::archive_active_lineage_in_tx(
                    tx,
                    &record_key(),
                    &lineage,
                    &vector,
                    None,
                    1_600,
                )
            })
            .unwrap();
        let successor = Ydoc::wire();
        successor.apply(&head.doc.encode_full_state()).unwrap();
        dohc_engine_collab::claim_base(
            &mut w.store,
            &record_key(),
            ContentKind::Richdoc,
            &successor.encode_full_state(),
            &NoFaults,
            1_700,
        )
        .unwrap();
        assert_ne!(record_lineage(&w.store), lineage, "{after:?}");
        execute(
            &mut w.store,
            "INSERT INTO ydoc_deferred_updates SELECT * FROM set_aside; DROP TABLE set_aside; \
             UPDATE hosted_documents SET state='held',held_reason='hosted-backfill-work-waiting', \
               backfill_cursor=(SELECT main_cursor FROM hosted_replicas)",
        );
        let mut cache = dohc_engine_collab::WriterDocCache::new();
        let waited = client.pull_hosted_workspace(
            &mut w.store,
            &mut cache,
            "workspace",
            "relay",
            &NoFaults,
            &dohc_engine_sync::NoLiveLeases,
        );
        let Err(dohc_engine_sync::RelayError::ValidationPending(pending)) = waited else {
            panic!("{after:?}: {waited:?}");
        };
        owed_title_reported_once(&mut w, after, client, cache, pending, &rows);
        desktop.close().await;
        w.close().await;
    }
}

/// How many field-history rows the record has.
fn field_history(store: &EngineStore) -> i64 {
    record_history(store, RECORD_ID)
}

/// How many field-history rows `record_id` has.
fn record_history(store: &EngineStore, record_id: &str) -> i64 {
    store
        .read_with(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM collection_field_history WHERE record_id=?1",
                [record_id],
                |row| row.get(0),
            )
        })
        .unwrap()
}

/// How many moments the record has, and how many conflicts the store keeps.
fn record_moments_and_conflicts(store: &EngineStore) -> (i64, i64) {
    store
        .read_with(|conn| {
            conn.query_row(
                "SELECT (SELECT COUNT(*) FROM moments WHERE object_id=?1), \
                   (SELECT COUNT(*) FROM conflicts)",
                [RECORD_OBJECT],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
        })
        .unwrap()
}

/// Whether the record's queued update is still queued, with the facts its
/// application parked on it.
fn record_update_parked(store: &EngineStore) -> bool {
    store
        .read_with(|conn| {
            conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM ydoc_deferred_updates \
                 WHERE object_id=?1 AND record_facts_json IS NOT NULL)",
                [RECORD_OBJECT],
                |row| row.get(0),
            )
        })
        .unwrap()
}

/// How a request whose drain waited goes on.
#[derive(Debug, Clone, Copy)]
enum AfterWait {
    /// The same request resumes once validation completes.
    Resume,
    /// It is abandoned, and a new request runs.
    Abandon,
    /// The store restarts, and a new request runs.
    Restart,
}

/// Sol's first finding, across documents: the end-of-pass drain finished the
/// record's drain, removing its queued update, before the window's drain
/// waited for validation, so the record's facts lived only in the request's
/// continuation. Each drain's rows now stay queued until no drain waits, so
/// whether the request resumes, is abandoned or the store restarts, the
/// record's facts reach the next reporting boundary once, with one
/// field-history effect.
#[tokio::test]
async fn a_completed_documents_facts_survive_a_later_documents_wait() {
    for after in [AfterWait::Resume, AfterWait::Abandon, AfterWait::Restart] {
        let (mut w, desktop, client) = record_and_window_queued().await;
        // Passes that read both documents left them waiting for that work,
        // their reads where the main feed is.
        execute(
            &mut w.store,
            "UPDATE hosted_documents SET state='held',held_reason='hosted-backfill-work-waiting', \
               backfill_cursor=(SELECT main_cursor FROM hosted_replicas)",
        );
        let mut cache = dohc_engine_collab::WriterDocCache::new();
        let waited = client.pull_hosted_workspace(
            &mut w.store,
            &mut cache,
            "workspace",
            "relay",
            &NoFaults,
            &dohc_engine_sync::NoLiveLeases,
        );
        let Err(dohc_engine_sync::RelayError::ValidationPending(pending)) = waited else {
            panic!("{after:?}: {waited:?}");
        };
        // The record's drain committed its field change; the window's drain
        // waits with nothing applied.
        assert_eq!(field_history(&w.store), 1, "{after:?}");
        assert!(record_update_parked(&w.store), "{after:?}");
        assert_eq!(queued_updates(&w.store).len(), 3, "{after:?}");
        let committed = record_moments_and_conflicts(&w.store);

        let (client, mut cache) = match after {
            AfterWait::Resume => {
                pending.validate().wait().unwrap();
                (client, cache)
            }
            AfterWait::Abandon | AfterWait::Restart => {
                drop(pending);
                if matches!(after, AfterWait::Restart) {
                    let db = engine_db_path(&w.root).unwrap();
                    w.store = EngineStore::open(&db, 0).unwrap();
                }
                (
                    dohc_engine_sync::RelaySyncClient::new(HostedFeed::new(&BOTH)),
                    dohc_engine_collab::WriterDocCache::new(),
                )
            }
        };
        let pass = hosted_pass(&mut w.store, &client, &mut cache);
        let reported = pass
            .record_facts
            .iter()
            .filter(|facts| facts.record_id == RECORD_ID)
            .count();
        assert_eq!(reported, 1, "{after:?}: {pass:?}");
        assert_eq!(field_history(&w.store), 1, "{after:?}");
        // Sol's fifth ruling: draining the record again duplicates nothing.
        assert_eq!(
            record_moments_and_conflicts(&w.store),
            committed,
            "{after:?}: no moment or conflict again"
        );
        assert_eq!(queued_updates(&w.store), Vec::new(), "{after:?}");
        assert!(w.text().contains("A second paragraph."), "{after:?}");
        assert!(pass_commit(&mut w.store, &client, &pass).committed);
        let next = hosted_pass(&mut w.store, &client, &mut cache);
        assert!(next.record_facts.is_empty(), "{after:?}: {next:?}");
        assert_eq!(
            record_moments_and_conflicts(&w.store),
            committed,
            "{after:?}"
        );
        desktop.close().await;
        w.close().await;
    }
}

/// Sol's sixth test and ruling 2, across documents: artifact recovery
/// finished the record's drain before the window's waited, and lost the
/// record's facts with the request. Each drain's rows now stay queued until
/// no drain waits, and the record keeps its pending artifact while they do,
/// so whether the recovery resumes, is abandoned or the store restarts,
/// recovery itself takes the record up again and reports its facts and its
/// file once, with no recovery failure.
#[tokio::test]
async fn artifact_recovery_keeps_a_completed_documents_facts_across_a_later_wait() {
    for after in [AfterWait::Resume, AfterWait::Abandon, AfterWait::Restart] {
        let (mut w, desktop, _client) = record_and_window_queued().await;
        // Both sessions ended with their own edits settled and their
        // artifacts unwritten; the record's recovers first.
        for (object, lineage) in [
            (RECORD_OBJECT, record_lineage(&w.store)),
            ("object", w.lineage.clone()),
        ] {
            execute(
                &mut w.store,
                &format!(
                    "UPDATE ydoc_docs SET settled_update_seq=last_local_update_seq \
                       WHERE object_id='{object}' AND last_local_update_seq>COALESCE(settled_update_seq,0); \
                     INSERT INTO ydoc_pending_artifacts(workspace_id,version_id,object_id,moment_id, \
                       origin_id,origin_seq,lineage_claim_id) \
                     SELECT workspace_id,version_id,object_id,latest_moment_id,'origin',0,'{lineage}' \
                     FROM snapshots WHERE object_id='{object}'"
                ),
            );
        }
        let mut cache = dohc_engine_collab::WriterDocCache::new();
        let waited = dohc_engine_sync::drain_open_document_artifacts(
            &mut w.store,
            &mut cache,
            "workspace",
            &dohc_engine_sync::NoLiveLeases,
            &NoFaults,
        )
        .unwrap();
        let Some(pending) = waited.waiting else {
            panic!("{after:?}: the window's drain waits");
        };
        assert!(
            waited.record_facts.is_empty(),
            "{after:?}: reports nothing yet"
        );
        assert_eq!(field_history(&w.store), 1, "{after:?}");
        assert!(record_update_parked(&w.store), "{after:?}");
        let marked: bool = w
            .store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT EXISTS(SELECT 1 FROM ydoc_pending_artifacts WHERE object_id=?1)",
                    [RECORD_OBJECT],
                    |row| row.get(0),
                )
            })
            .unwrap();
        assert!(marked, "{after:?}: its artifact stays pending");
        match after {
            AfterWait::Resume => pending.validate().wait().unwrap(),
            AfterWait::Abandon => drop(pending),
            AfterWait::Restart => {
                drop(pending);
                let db = engine_db_path(&w.root).unwrap();
                w.store = EngineStore::open(&db, 0).unwrap();
                cache = dohc_engine_collab::WriterDocCache::new();
            }
        }
        let (mut facts, mut changes) = (Vec::new(), Vec::new());
        loop {
            let recovered = dohc_engine_sync::drain_open_document_artifacts(
                &mut w.store,
                &mut cache,
                "workspace",
                &dohc_engine_sync::NoLiveLeases,
                &NoFaults,
            )
            .unwrap();
            facts.extend(recovered.record_facts);
            changes.extend(recovered.changes);
            match recovered.waiting {
                Some(pending) => pending.validate().wait().unwrap(),
                None => break,
            }
        }
        assert_eq!(
            facts
                .iter()
                .filter(|facts| facts.record_id == RECORD_ID)
                .count(),
            1,
            "{after:?}: {facts:?}"
        );
        assert_eq!(
            changes
                .iter()
                .filter(|change| change.path == RECORD_PATH && change.operation == "write")
                .count(),
            1,
            "{after:?}: {changes:?}"
        );
        assert_eq!(field_history(&w.store), 1, "{after:?}");
        assert!(!record_update_parked(&w.store), "{after:?}");
        assert_eq!(queued_updates(&w.store), Vec::new(), "{after:?}");
        let again = dohc_engine_sync::drain_open_document_artifacts(
            &mut w.store,
            &mut cache,
            "workspace",
            &dohc_engine_sync::NoLiveLeases,
            &NoFaults,
        )
        .unwrap();
        assert!(
            again.record_facts.is_empty() && again.changes.is_empty(),
            "{after:?}: reported once"
        );
        let failures: i64 = w
            .store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT COUNT(*) FROM replication_pending_refusals \
                     WHERE reason_code='document-artifact-recovery-failed'",
                    [],
                    |row| row.get(0),
                )
            })
            .unwrap();
        assert_eq!(failures, 0, "{after:?}");
        desktop.close().await;
        w.close().await;
    }
}

/// The record's lineage.
fn record_lineage(store: &EngineStore) -> String {
    dohc_engine_collab::read_marker(store, &record_key())
        .unwrap()
        .unwrap()
        .lineage_claim_id
        .unwrap()
}

/// The window's document as a Collection record.
const WINDOW_RECORD_ID: &str = "rec_bbbbbbbbbbbbbbbbbbbbbbbbbb";

/// The window document's released-tail generation.
fn window_generation(store: &EngineStore) -> i64 {
    store
        .read_with(|conn| {
            conn.query_row(
                "SELECT generation FROM released_tail_generations WHERE object_id='object'",
                [],
                |row| row.get(0),
            )
        })
        .unwrap()
}

/// How many updates the window document's journal holds beyond its snapshot.
fn window_pending(store: &EngineStore) -> i64 {
    let marker = dohc_engine_collab::read_marker(store, &window_key())
        .unwrap()
        .unwrap();
    marker.head_update_seq - marker.head_snapshot_seq
}

/// Whether the window document's queued update at `origin_seq` is still
/// queued, with the facts its application parked on it.
fn window_update_parked(store: &EngineStore, origin_seq: i64) -> bool {
    store
        .read_with(|conn| {
            conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM ydoc_deferred_updates WHERE object_id='object' \
                 AND origin_id='peer' AND origin_seq=?1 AND record_facts_json IS NOT NULL)",
                [origin_seq],
                |row| row.get(0),
            )
        })
        .unwrap()
}

/// How a drain that waits for validation after a committed prefix goes on,
/// from the paused validation.
#[derive(Debug, Clone, Copy)]
enum FromPause {
    /// Validation completes, and the same drain runs again.
    Resume,
    /// Validation is cancelled, and a new drain runs on fresh tails.
    Cancel,
    /// Validation is cancelled, the store restarts, and a new drain runs.
    Restart,
}

/// Write, past the store's checks, the host's application of the window's
/// retained delivery: its tail then retains nothing without proof.
fn prove_retained_delivery(w: &RetainedWindow) {
    let (delivery_id, receipt): (String, String) = w
        .store
        .read_with(|conn| {
            conn.query_row(
                "SELECT delivery_id,accepted_receipt_json FROM owner_ydoc_outbox_entries
                 WHERE update_digest=?1",
                [&w.retained_digest],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
        })
        .unwrap();
    let receipt: dohc_engine_collab::OwnerDeliveryReceipt = serde_json::from_str(&receipt).unwrap();
    let raw = rusqlite::Connection::open(engine_db_path(&w.root).unwrap()).unwrap();
    raw.execute_batch("PRAGMA foreign_keys=OFF").unwrap();
    raw.execute(
        APPLIED_EXACTLY,
        rusqlite::params![
            delivery_id,
            w.lineage,
            w.retained_digest,
            receipt.journal_cursor,
            receipt.accepting_host_epoch
        ],
    )
    .unwrap();
}

/// Sol's first finding, within one document, with Sol's post-prefix wait:
/// an outbox entry whose native source is above the snapshot, a journal one
/// short of compaction, two queued updates and tails validated for the
/// current generation, which a host's application of the retained delivery
/// leaves unprotected. The first update, a field change, applies; its
/// compaction moves the snapshot past that native source, which moves the
/// generation, so the second's decision waits. At the paused validation the
/// first committed its field change and keeps its row and facts; the second
/// has not applied. Whether validation then resumes, is cancelled or the
/// store restarts, the next drain reports the first's facts once, with one
/// field-history effect. An update applied and then refused too.
#[tokio::test]
async fn a_drain_that_waits_after_a_committed_prefix_keeps_its_facts() {
    for from in [FromPause::Resume, FromPause::Cancel, FromPause::Restart] {
        for refused in [false, true] {
            drain_waiting_after_a_committed_prefix(from, refused).await;
        }
    }
}

/// Whether an outbox entry's native source names a window journal update
/// above its snapshot, so a compaction past it moves the generation.
fn window_source_above_snapshot(store: &EngineStore) -> bool {
    store
        .read_with(|conn| {
            conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM owner_ydoc_outbox_entries e JOIN ydoc_docs d \
                   ON d.object_id='object' JOIN ydoc_updates u ON u.workspace_id=d.workspace_id \
                   AND u.version_id=d.version_id AND u.object_id=d.object_id \
                   AND u.seq=json_extract(e.native_source_json,'$.nativeSequence') \
                 WHERE json_extract(e.native_source_json,'$.binding.objectId')='object' \
                   AND u.seq>d.head_snapshot_seq)",
                [],
                |row| row.get(0),
            )
        })
        .unwrap()
}

/// The window document's journal position its snapshot covers.
fn window_snapshot(store: &EngineStore) -> i64 {
    dohc_engine_collab::read_marker(store, &window_key())
        .unwrap()
        .unwrap()
        .head_snapshot_seq
}

/// Fill the window document's journal to one update short of compaction:
/// `leading`, then paragraph appends, each made on `head`.
fn fill_window_journal(w: &mut RetainedWindow, head: &Ydoc, leading: Vec<Vec<u8>>) {
    let mut filler = leading;
    while window_pending(&w.store) + (filler.len() as i64) < 63 {
        filler.push(head.richdoc_append_paragraph(&format!("Filler {}.", filler.len())));
    }
    for (seq, bytes) in filler.into_iter().enumerate() {
        dohc_engine_collab::apply_remote_update(
            &mut w.store,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &window_key(),
            &dohc_engine_collab::RemoteUpdate {
                origin_id: "filler".into(),
                origin_seq: seq as i64,
                bytes,
            },
            None,
            None,
            &NoFaults,
            1_000,
        )
        .unwrap();
    }
    assert_eq!(window_pending(&w.store), 63);
}

/// Validate `tails` for the window lineage's current generation, and answer
/// whether they protect it.
fn validated_protection(w: &RetainedWindow, tails: &ReleasedTails) -> bool {
    use dohc_engine_collab::live_update_application::LineageProtection;
    loop {
        let decided = w
            .store
            .read_with(|conn| {
                Ok::<_, dohc_engine_storage::StorageError>(
                    dohc_engine_collab::live_update_application::lineage_protection(
                        conn,
                        &window_key(),
                        &w.lineage,
                        tails,
                    ),
                )
            })
            .unwrap()
            .unwrap();
        match decided {
            LineageProtection::Pending(pending) => pending.validate().wait().unwrap(),
            LineageProtection::Unprotected => return false,
            LineageProtection::Protected(_) => return true,
        }
    }
}

async fn drain_waiting_after_a_committed_prefix(from: FromPause, refused: bool) {
    let case = format!("{from:?} refused={refused}");
    let mut w = retained_window(Retained::Carried).await;
    assert!(
        window_source_above_snapshot(&w.store),
        "{case}: an outbox entry's native source above the snapshot"
    );

    // The document becomes a Collection record, and its journal fills to one
    // update short of compaction.
    std::fs::create_dir_all(w.root.path().join("notes")).unwrap();
    seed_head(
        &mut w.store,
        "notes-schema",
        "notes/collection.yaml",
        "fields:\n  title:\n    type: text\n",
    );
    let head = w.head();
    let id = head.frontmatter_set("id", WINDOW_RECORD_ID).unwrap();
    fill_window_journal(&mut w, &head, vec![id]);
    let doc = w.head();
    w.store
        .write_with(&NoFaults, |tx| {
            dohc_engine_sync::project_and_write_in_tx(
                tx,
                &window_key(),
                WINDOW_PATH,
                &doc,
                ContentKind::Richdoc,
                "filler",
                63,
                1_000,
                None,
            )
        })
        .unwrap();
    w.store
        .write_with(&NoFaults, |tx| {
            dohc_engine_domain::reconcile_collections_in_tx(tx, "workspace", "main")?;
            dohc_engine_domain::set_collection_adoption_state_in_tx(
                tx,
                "workspace",
                "main",
                WINDOW_PATH,
                WINDOW_RECORD_ID,
                "adopted",
            )
        })
        .unwrap();
    let history = record_history(&w.store, WINDOW_RECORD_ID);

    // Two admissible updates queue while the document is live.
    let replica = Ydoc::wire();
    replica.apply(&w.native()).unwrap();
    let titled = replica.frontmatter_set("title", "Remote").unwrap();
    let appended = replica.richdoc_append_paragraph("A later paragraph.");
    let feed = HostedFeed::new(&[("object", WINDOW_PATH)]);
    for (seq, bytes) in [(0, titled), (1, appended)] {
        feed.serve(
            peer_update(&window_key(), WINDOW_PATH, &w.lineage, seq, &bytes),
            bytes,
        );
    }
    let client = dohc_engine_sync::RelaySyncClient::new(feed);
    let live = live_hosted_pass(&mut w.store, &client);
    assert!(pass_commit(&mut w.store, &client, &live).committed);
    assert_eq!(queued_updates(&w.store).len(), 2, "{case}");
    if refused {
        execute(
            &mut w.store,
            "UPDATE replication_log SET payload_json=json_set(payload_json,'$.path','notes/elsewhere.md') \
             WHERE origin_id='peer' AND origin_seq=0",
        );
    }

    // A host applied the retained delivery, so the tails validate for the
    // current generation with nothing protected; then validation pauses.
    prove_retained_delivery(&w);
    let mut cache = dohc_engine_collab::WriterDocCache::new();
    let tails = cache.released_tails(&w.store);
    assert!(
        !validated_protection(&w, &tails),
        "{case}: the applied delivery leaves nothing protected"
    );
    let (generation, snapshot) = (window_generation(&w.store), window_snapshot(&w.store));
    tails.pause_validation();
    let stopped = dohc_engine_sync::drain_deferred_ydoc_for_key(
        &mut w.store,
        &mut cache,
        &window_key(),
        &NoFaults,
    )
    .unwrap();
    assert!(
        stopped.record_facts.is_empty(),
        "{case}: a waiting drain reports nothing"
    );
    let pending = stopped.waiting.expect("the second update waits");
    assert!(
        window_snapshot(&w.store) > snapshot,
        "{case}: compaction advanced the snapshot"
    );
    assert_ne!(
        window_generation(&w.store),
        generation,
        "{case}: compaction moved it"
    );
    let validating = std::thread::spawn(move || pending.validate().wait());
    tails.wait_for_paused_validation();
    assert_eq!(
        record_history(&w.store, WINDOW_RECORD_ID),
        history + 1,
        "{case}"
    );
    assert!(
        window_update_parked(&w.store, 0),
        "{case}: its facts stay with its row"
    );
    assert!(!w.text().contains("A later paragraph."), "{case}");
    assert_eq!(queued_updates(&w.store).len(), 2, "{case}");

    let drained = match from {
        FromPause::Resume => {
            tails.resume_validation();
            validating.join().unwrap().unwrap();
            dohc_engine_sync::drain_deferred_ydoc_for_key(
                &mut w.store,
                &mut cache,
                &window_key(),
                &NoFaults,
            )
            .unwrap()
        }
        FromPause::Cancel | FromPause::Restart => {
            tails.close();
            assert!(validating.join().unwrap().is_err(), "{case}");
            if matches!(from, FromPause::Restart) {
                let db = engine_db_path(&w.root).unwrap();
                w.store = EngineStore::open(&db, 0).unwrap();
            }
            settled_drain(&mut w.store)
        }
    };
    assert!(drained.waiting.is_none(), "{case}: {drained:?}");
    let reported = drained
        .record_facts
        .iter()
        .filter(|facts| facts.record_id == WINDOW_RECORD_ID)
        .count();
    assert_eq!(reported, 1, "{case}: {drained:?}");
    assert_eq!(
        drained
            .refusals
            .iter()
            .filter(|refusal| (refusal.origin_id.as_str(), refusal.origin_seq) == ("peer", 0))
            .count(),
        usize::from(refused),
        "{case}: {drained:?}"
    );
    assert_eq!(
        record_history(&w.store, WINDOW_RECORD_ID),
        history + 1,
        "{case}"
    );
    assert_eq!(queued_updates(&w.store), Vec::new(), "{case}");
    assert!(w.text().contains("A later paragraph."), "{case}");
    assert!(
        settled_drain(&mut w.store).record_facts.is_empty(),
        "{case}"
    );
    w.close().await;
}

/// Sol's sixth ruling, its mechanism form: the same post-prefix wait with
/// the Carried window still protected, so only structurally safe updates
/// apply. Of two queued paragraph appends the first applies; its compaction
/// moves the snapshot past the outbox entry's native source, which moves the
/// generation, so the second's decision waits. At the paused validation the
/// first is in the head, the second is not, and both rows stay queued.
/// Whether validation then resumes, is cancelled or the store restarts, the
/// next drain applies the second, and each lands once.
#[tokio::test]
async fn a_protected_drain_that_waits_after_a_committed_prefix_keeps_its_rows() {
    for from in [FromPause::Resume, FromPause::Cancel, FromPause::Restart] {
        let case = format!("{from:?}");
        let mut w = retained_window(Retained::Carried).await;
        assert!(window_source_above_snapshot(&w.store), "{case}");
        let head = w.head();
        fill_window_journal(&mut w, &head, Vec::new());

        // Two paragraph appends queue while the document is live.
        let replica = Ydoc::wire();
        replica.apply(&w.native()).unwrap();
        let first = replica.richdoc_append_paragraph("A first paragraph.");
        let second = replica.richdoc_append_paragraph("A second paragraph.");
        let feed = HostedFeed::new(&[("object", WINDOW_PATH)]);
        for (seq, bytes) in [(0, first), (1, second)] {
            feed.serve(
                peer_update(&window_key(), WINDOW_PATH, &w.lineage, seq, &bytes),
                bytes,
            );
        }
        let client = dohc_engine_sync::RelaySyncClient::new(feed);
        let live = live_hosted_pass(&mut w.store, &client);
        assert!(pass_commit(&mut w.store, &client, &live).committed);
        assert_eq!(queued_updates(&w.store).len(), 2, "{case}");

        // The tails validate for the current generation and still protect
        // the window; then validation pauses.
        let mut cache = dohc_engine_collab::WriterDocCache::new();
        let tails = cache.released_tails(&w.store);
        assert!(validated_protection(&w, &tails), "{case}: still protected");
        let (generation, snapshot) = (window_generation(&w.store), window_snapshot(&w.store));
        tails.pause_validation();
        let stopped = dohc_engine_sync::drain_deferred_ydoc_for_key(
            &mut w.store,
            &mut cache,
            &window_key(),
            &NoFaults,
        )
        .unwrap();
        assert!(
            stopped.refusals.is_empty() && stopped.released_hold.is_none(),
            "{case}: nothing refused or held"
        );
        let pending = stopped.waiting.expect("the second append waits");
        assert!(
            window_snapshot(&w.store) > snapshot,
            "{case}: compaction advanced the snapshot"
        );
        assert_ne!(
            window_generation(&w.store),
            generation,
            "{case}: compaction moved it"
        );
        let validating = std::thread::spawn(move || pending.validate().wait());
        tails.wait_for_paused_validation();
        let text = w.text();
        assert!(text.contains("A first paragraph."), "{case}: it committed");
        assert!(!text.contains("A second paragraph."), "{case}: it waits");
        assert!(text.contains(RETAINED), "{case}");
        assert_eq!(
            queued_updates(&w.store).len(),
            2,
            "{case}: both stay queued"
        );

        let drained = match from {
            FromPause::Resume => {
                tails.resume_validation();
                validating.join().unwrap().unwrap();
                dohc_engine_sync::drain_deferred_ydoc_for_key(
                    &mut w.store,
                    &mut cache,
                    &window_key(),
                    &NoFaults,
                )
                .unwrap()
            }
            FromPause::Cancel | FromPause::Restart => {
                tails.close();
                assert!(validating.join().unwrap().is_err(), "{case}");
                if matches!(from, FromPause::Restart) {
                    let db = engine_db_path(&w.root).unwrap();
                    w.store = EngineStore::open(&db, 0).unwrap();
                }
                settled_drain(&mut w.store)
            }
        };
        assert!(
            drained.waiting.is_none()
                && drained.refusals.is_empty()
                && drained.released_hold.is_none(),
            "{case}: {drained:?}"
        );
        let text = w.text();
        assert_eq!(text.matches("A first paragraph.").count(), 1, "{case}");
        assert_eq!(text.matches("A second paragraph.").count(), 1, "{case}");
        assert!(text.contains(RETAINED), "{case}");
        assert_eq!(queued_updates(&w.store), Vec::new(), "{case}");
        w.close().await;
    }
}

/// Sol's fifth and Opus's sixth findings: a close's drain read a failed
/// restore-generation read as a restore fence, answered success and drained
/// nothing. Only a restore that fences the document skips the drain; any
/// other failure of that read fails it, and the queued work stays for the
/// drain that reads it.
#[tokio::test]
async fn a_close_drain_fails_when_its_restore_generation_cannot_be_read() {
    let mut w = retained_window(Retained::Carried).await;
    let desktop = desktop_of(&w.base, &w.lineage, &[]).await;
    let (first, first_bytes) = desktop.append(&w.lineage, "A queued paragraph.").await;
    let feed = HostedFeed::new(&[("object", WINDOW_PATH)]);
    feed.serve(first, first_bytes);
    let client = dohc_engine_sync::RelaySyncClient::new(feed);
    let live = live_hosted_pass(&mut w.store, &client);
    assert!(pass_commit(&mut w.store, &client, &live).committed);
    let queued = queued_updates(&w.store);
    assert_eq!(queued.len(), 1);
    execute(
        &mut w.store,
        "ALTER TABLE live_restore_fences RENAME TO live_restore_fences_unreadable",
    );
    let failed = w
        .actor
        .ydoc_close_drain(
            window_key(),
            None,
            1_000_000,
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await;
    assert!(failed.is_err(), "{failed:?}");
    execute(
        &mut w.store,
        "ALTER TABLE live_restore_fences_unreadable RENAME TO live_restore_fences",
    );
    assert_eq!(queued_updates(&w.store), queued, "nothing drained");
    w.actor
        .ydoc_close_drain(
            window_key(),
            None,
            1_000_000,
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(queued_updates(&w.store), Vec::new());
    assert!(w.text().contains("A queued paragraph."));
    desktop.close().await;
    w.close().await;
}

/// Where an actor operation drains queued updates of a protected lineage.
#[derive(Debug, Clone, Copy)]
enum DrainingOperation {
    Open,
    Resync,
    Settle,
    Close,
}

/// Two queued updates that only add content, on a protected lineage, with
/// the actor's tails never validated: the drain waits for validation before
/// either applies. The actor waits outside its transaction and drains
/// again, so every operation finishes with both updates applied and nothing
/// queued.
#[tokio::test]
async fn actor_drains_wait_for_validation_and_finish() {
    for operation in [
        DrainingOperation::Open,
        DrainingOperation::Resync,
        DrainingOperation::Settle,
        DrainingOperation::Close,
    ] {
        let mut w = retained_window(Retained::Carried).await;
        let desktop = desktop_of(&w.base, &w.lineage, &[]).await;
        let (first, first_bytes) = desktop.append(&w.lineage, "A first paragraph.").await;
        let (second, second_bytes) = desktop.append(&w.lineage, "A second paragraph.").await;
        let feed = HostedFeed::new(&[("object", WINDOW_PATH)]);
        feed.serve(first, first_bytes);
        feed.serve(second, second_bytes);
        let client = dohc_engine_sync::RelaySyncClient::new(feed);
        let live = live_hosted_pass(&mut w.store, &client);
        assert!(pass_commit(&mut w.store, &client, &live).committed);
        assert_eq!(queued_updates(&w.store).len(), 2, "{operation:?}");
        let token = CancellationToken::new;
        match operation {
            DrainingOperation::Open => {
                w.actor
                    .ydoc_open_state(
                        "workspace".into(),
                        1_000_000,
                        true,
                        Some(window_key()),
                        "main".into(),
                        WINDOW_PATH.into(),
                        None,
                        token(),
                    )
                    .await
                    .unwrap();
            }
            DrainingOperation::Resync => {
                w.actor
                    .ydoc_resync(window_key(), Some(w.lineage.clone()), token(), None)
                    .await
                    .unwrap();
            }
            DrainingOperation::Settle => {
                let settled = w
                    .actor
                    .ydoc_settle(
                        w.root.path().to_owned(),
                        window_key(),
                        WINDOW_PATH.into(),
                        ContentKind::Richdoc,
                        Some(w.lineage.clone()),
                        None,
                        "session".into(),
                        Arc::new(()),
                        1_000_000,
                        Arc::new(NoFaults),
                        token(),
                        None,
                    )
                    .await
                    .unwrap();
                assert!(
                    matches!(
                        settled,
                        dohc_engine_runtime::actor::YdocSettleOutcome::RemoteUpdatesPending { .. }
                    ),
                    "the drained updates are news to the editor"
                );
            }
            DrainingOperation::Close => {
                let closed = w
                    .actor
                    .ydoc_close_session(window_key(), 1_000_000, Arc::new(NoFaults), token())
                    .await
                    .unwrap();
                assert!(closed.outcome.is_some());
            }
        }
        assert_eq!(queued_updates(&w.store), Vec::new(), "{operation:?}");
        let text = w.text();
        assert!(
            text.contains("A first paragraph.") && text.contains("A second paragraph."),
            "{operation:?}: {text}"
        );
        desktop.close().await;
        w.close().await;
    }
}

/// An update queued before deferrals recorded their feed, of the protected
/// lineage, stays queued and holds the document with a binding that names
/// no namespace, though it only adds content: nothing shows the feed it
/// arrived on. The same update with the feed it recorded drains.
#[tokio::test]
async fn a_queued_update_with_no_recorded_feed_holds_a_protected_lineage() {
    for legacy in [true, false] {
        let mut w = retained_window(Retained::Carried).await;
        let desktop = desktop_of(&w.base, &w.lineage, &[]).await;
        let (added, added_bytes) = desktop.append(&w.lineage, "A desktop paragraph.").await;
        let feed = HostedFeed::new(&[("object", WINDOW_PATH)]);
        let added = feed.serve(added, added_bytes);
        let client = dohc_engine_sync::RelaySyncClient::new(feed);
        let live = live_hosted_pass(&mut w.store, &client);
        assert!(pass_commit(&mut w.store, &client, &live).committed);
        if legacy {
            execute(
                &mut w.store,
                "UPDATE ydoc_deferred_updates SET ingress_kind='legacy-unknown', \
                 relay_namespace=NULL,replication_epoch=NULL,stream_identity=NULL",
            );
        }
        let drained = settled_drain(&mut w.store);
        if !legacy {
            assert_eq!(
                (drained.drained, &drained.released_hold),
                (1, &None),
                "{drained:?}"
            );
            assert!(queued_updates(&w.store).is_empty());
            assert!(w.text().contains("A desktop paragraph"));
        } else {
            let Some(dohc_engine_sync::HostedHold::ReleasedLineageUnsettled { binding, .. }) =
                &drained.released_hold
            else {
                panic!("{drained:?}");
            };
            assert_eq!(binding.incoming.relay_namespace, None);
            assert_eq!(
                (
                    binding.incoming.origin_id.as_str(),
                    binding.incoming.origin_seq
                ),
                (added.origin_id.as_str(), added.origin_seq)
            );
            assert_eq!(drained.drained, 0);
            assert_eq!(
                queued_updates(&w.store),
                [(
                    added.origin_id.clone(),
                    added.origin_seq,
                    "legacy-unknown".to_owned(),
                    None
                )]
            );
            assert!(!w.text().contains("A desktop paragraph"));
        }
        assert!(w.text().contains(RETAINED));
        desktop.close().await;
        w.close().await;
    }
}

/// Archive the window's lineage as a rejected base leaves one: the archive
/// keeps the document's state, and the head moves to a lineage no released
/// tail names, so only the archived lineage is protected. Answers the digest
/// of the state the archive keeps.
fn archive_lineage(w: &mut RetainedWindow) -> String {
    let state = w.native();
    let vector = w.head().encode_state_vector();
    let full = w.store.put_binary_blob(&state).unwrap();
    let vector = w.store.put_binary_blob(&vector).unwrap();
    let winner = w.store.put_binary_blob(b"the winning lineage").unwrap();
    execute(
        &mut w.store,
        &format!(
            "INSERT INTO ydoc_inactive_lineages (workspace_id,version_id,object_id, \
               lineage_claim_id,disposition,content_kind,path,full_state_blob_sha256, \
               state_vector_blob_sha256,recorded_at_ms,updated_at_ms) \
             VALUES ('workspace','main','object','{}','rejected-base','richdoc', \
               '{WINDOW_PATH}','{full}','{vector}',1,1)",
            w.lineage
        ),
    );
    write_unchecked(
        w,
        &format!("UPDATE ydoc_docs SET lineage_claim_id='{winner}' WHERE object_id='object'"),
    );
    full
}

/// The digest of the state the archive of `lineage` keeps.
fn archived_state(store: &EngineStore, lineage: &str) -> String {
    store
        .read_with(|conn| {
            conn.query_row(
                "SELECT full_state_blob_sha256 FROM ydoc_inactive_lineages \
                 WHERE object_id='object' AND lineage_claim_id=?1",
                [lineage],
                |row| row.get(0),
            )
        })
        .unwrap()
}

/// Each queued Y.Doc update of the store, in relay order: its coordinate,
/// relay position, lineage and the whole feed it recorded.
fn queued_feeds(store: &EngineStore) -> Vec<String> {
    store
        .read_with(|conn| {
            conn.prepare(
                "SELECT json_array(origin_id,origin_seq,relay_seq,lineage_claim_id,ingress_kind, \
                 relay_namespace,replication_epoch,stream_identity) \
                 FROM ydoc_deferred_updates ORDER BY relay_seq",
            )?
            .query_map([], |row| row.get(0))?
            .collect::<Result<Vec<_>, _>>()
        })
        .unwrap()
}

/// Each of `ops`' update blobs is still stored.
fn blobs_kept(store: &EngineStore, ops: &[dohc_engine_sync::ReplicationEnvelope]) {
    for op in ops {
        let blob = op.payload["updateBlobSha256"].as_str().unwrap();
        assert!(store.get_binary_blob(blob).unwrap().is_some(), "{blob}");
    }
}

/// The window, with the neighbour ready beside it, whose lineage was
/// archived after `appends` desktop appends of it queued while the host's
/// session held the document. Answers the window, the desktop, the feed, the
/// queued appends in relay order, and the digest of the archived state.
async fn archived_window(
    appends: usize,
) -> (
    RetainedWindow,
    Desktop,
    dohc_engine_sync::RelaySyncClient<HostedFeed>,
    Vec<dohc_engine_sync::ReplicationEnvelope>,
    String,
) {
    let mut w = retained_window(Retained::Carried).await;
    add_neighbour(&mut w.store);
    let desktop = desktop_of(&w.base, &w.lineage, &[]).await;
    let feed = HostedFeed::new(&[("neighbour", NEIGHBOUR_PATH), ("object", WINDOW_PATH)]);
    let mut queued = Vec::new();
    for index in 0..appends {
        let (append, bytes) = desktop
            .append(&w.lineage, &format!("Archived paragraph {index}."))
            .await;
        queued.push(feed.serve(append, bytes));
    }
    let client = dohc_engine_sync::RelaySyncClient::new(feed);
    let live = live_hosted_pass(&mut w.store, &client);
    assert!(pass_commit(&mut w.store, &client, &live).committed);
    assert_eq!(queued_updates(&w.store).len(), appends);
    let archive = archive_lineage(&mut w);
    (w, desktop, client, queued, archive)
}

/// `hold` names the window's archived `lineage`, the `archive` state it
/// keeps and the queued `first` update, on the feed it arrived on: frozen,
/// and claiming currency.
fn holds_archived(
    hold: Option<&dohc_engine_sync::HostedHold>,
    lineage: &str,
    archive: &str,
    first: &dohc_engine_sync::ReplicationEnvelope,
) -> bool {
    let Some(dohc_engine_sync::HostedHold::ReleasedLineageUnsettled {
        binding,
        continuation: dohc_engine_sync::ReleasedHoldContinuation::Frozen,
        binding_stale: false,
    }) = hold
    else {
        return false;
    };
    binding.lineage_claim_id == lineage
        && binding.head_digest == archive
        && binding.incoming.relay_namespace.as_deref() == Some("relay")
        && (
            binding.incoming.origin_id.as_str(),
            binding.incoming.origin_seq,
            binding.incoming.relay_seq,
        ) == (
            first.origin_id.as_str(),
            first.origin_seq,
            first.relay_seq.unwrap(),
        )
}

/// Hosted passes until one commits, at most two: a pass that stores a hold
/// counts a commit, so its own cursor no longer stands.
fn committed_pass(
    store: &mut EngineStore,
    client: &dohc_engine_sync::RelaySyncClient<HostedFeed>,
) -> dohc_engine_sync::HostedPassOutcome {
    for _ in 0..2 {
        let pass = hosted_pass(
            store,
            client,
            &mut dohc_engine_collab::WriterDocCache::new(),
        );
        if pass_commit(store, client, &pass).committed {
            return pass;
        }
    }
    panic!("no pass committed");
}

/// Sol's fifth test, the pass's inactive drain: queued updates of an
/// archived lineage released tails protect stay queued with their blobs and
/// feeds, and the archive keeps its state. The document holds with a binding
/// of that lineage and its archived state, durably and in the pass, while a
/// neighbour's writes apply in the same passes. The hold stands through
/// committed passes and reads back after a restart. Once nothing protects the
/// lineage, the next pass applies the queued updates to the archive, names no
/// hold, and the document becomes ready.
#[tokio::test]
async fn a_pass_holds_a_protected_archived_lineage_and_continues_once_it_is_free() {
    let (mut w, desktop, client, queued, archive) = archived_window(2).await;
    let rows = queued_feeds(&w.store);
    let created = client
        .transport()
        .create("neighbour", NEIGHBOUR_PATH, "A neighbour.\n");
    let pass = hosted_pass(
        &mut w.store,
        &client,
        &mut dohc_engine_collab::WriterDocCache::new(),
    );
    assert!(journaled(&w.store, &created), "the neighbour applied");
    assert!(
        holds_archived(pass.held.get("object"), &w.lineage, &archive, &queued[0]),
        "{pass:?}"
    );
    let held = dohc_engine_sync::HostedDocumentStatus::Held(pass.held["object"].clone());
    assert_eq!(hosted_status(&w.store, "object"), held);
    assert_eq!(queued_feeds(&w.store), rows, "rows and feeds stay");
    assert_eq!(
        archived_state(&w.store, &w.lineage),
        archive,
        "nothing applied"
    );
    blobs_kept(&w.store, &queued);
    let committed = committed_pass(&mut w.store, &client);
    assert_eq!(committed.held.get("object"), pass.held.get("object"));
    assert_eq!(hosted_status(&w.store, "object"), held);

    w.store = EngineStore::open(&engine_db_path(&w.root).unwrap(), 0).unwrap();
    assert_eq!(hosted_status(&w.store, "object"), held, "after a restart");
    assert_eq!(queued_feeds(&w.store), rows);
    let edited = client.transport().write(
        "neighbour",
        NEIGHBOUR_PATH,
        Some("A neighbour.\n"),
        "A neighbour, edited.\n",
    );
    let again = committed_pass(&mut w.store, &client);
    assert!(journaled(&w.store, &edited), "the neighbour goes on");
    assert_eq!(again.held.get("object"), pass.held.get("object"));
    assert_eq!(hosted_status(&w.store, "object"), held);
    assert_eq!(queued_feeds(&w.store), rows);
    assert_eq!(archived_state(&w.store, &w.lineage), archive);
    blobs_kept(&w.store, &queued);

    write_unchecked(
        &w,
        &format!(
            "DELETE FROM live_owner_activations WHERE lineage_claim_id='{}'",
            w.lineage
        ),
    );
    let free = committed_pass(&mut w.store, &client);
    assert!(
        !matches!(
            free.held.get("object"),
            Some(dohc_engine_sync::HostedHold::ReleasedLineageUnsettled { .. })
        ),
        "{free:?}"
    );
    assert_eq!(
        queued_updates(&w.store),
        Vec::new(),
        "the archive took them"
    );
    assert_ne!(archived_state(&w.store, &w.lineage), archive);
    for _ in 0..2 {
        if hosted_status(&w.store, "object") == dohc_engine_sync::HostedDocumentStatus::Ready {
            break;
        }
        committed_pass(&mut w.store, &client);
    }
    assert_eq!(
        hosted_status(&w.store, "object"),
        dohc_engine_sync::HostedDocumentStatus::Ready
    );
    desktop.close().await;
    w.close().await;
}

/// Opus's r2c-3c-7 finding 1: a pass's inactive drain decides one archived
/// lineage of a document per transaction, so what deciding one wrote, its
/// hold or its archive, never leaves another lineage of the document asking
/// for validation of a generation only that transaction holds, which the
/// worker answers uncommitted on every retry. Beside the window's protected
/// archived lineage, a second archive of it takes a copy of its queued rows,
/// in one batch with them: later in relay order and unprotected, later and
/// protected too, or earlier and unprotected, so it is decided first and
/// applying it moves the generation first. Each pass ends, the window holds
/// with its own lineage's first row, and only an unprotected copy applies.
#[tokio::test]
async fn archived_lineages_of_one_document_drain_in_their_own_transactions() {
    for case in [
        "held, then applied",
        "held, then held",
        "applied, then held",
    ] {
        let (mut w, desktop, client, queued, archive) = archived_window(2).await;
        let rows = queued_feeds(&w.store);
        // A batch decides its groups in relay order, so the copy that applies
        // first comes before the window's rows.
        let (second, shift) = if case == "applied, then held" {
            ("0".repeat(64), -1000)
        } else {
            ("f".repeat(64), 1000)
        };
        assert_ne!(second, w.lineage, "{case}");
        write_unchecked(
            &w,
            &format!(
                "CREATE TEMP TABLE archive AS SELECT * FROM ydoc_inactive_lineages WHERE lineage_claim_id='{first}';
                 UPDATE temp.archive SET lineage_claim_id='{second}';
                 INSERT INTO ydoc_inactive_lineages SELECT * FROM temp.archive;
                 CREATE TEMP TABLE log AS SELECT * FROM replication_log
                   WHERE (origin_id,origin_seq) IN (SELECT origin_id,origin_seq FROM ydoc_deferred_updates);
                 UPDATE temp.log SET origin_seq=origin_seq+1000,
                   payload_json=json_set(payload_json,'$.lineageClaimId','{second}');
                 INSERT INTO replication_log SELECT * FROM temp.log;
                 CREATE TEMP TABLE queued AS SELECT * FROM ydoc_deferred_updates;
                 UPDATE temp.queued SET origin_seq=origin_seq+1000,lineage_claim_id='{second}',
                   relay_seq=relay_seq+{shift};
                 INSERT INTO ydoc_deferred_updates SELECT * FROM temp.queued;",
                first = w.lineage
            ),
        );
        let protected = case == "held, then held";
        if protected {
            write_unchecked(
                &w,
                &format!(
                    "CREATE TEMP TABLE activations AS SELECT * FROM live_owner_activations
                       WHERE lineage_claim_id='{first}';
                     UPDATE temp.activations SET activation_id=activation_id||'-second',
                       predecessor_activation_id=predecessor_activation_id||'-second',
                       lineage_claim_id='{second}';
                     INSERT INTO live_owner_activations SELECT * FROM temp.activations;",
                    first = w.lineage
                ),
            );
        }
        assert_eq!(queued_feeds(&w.store).len(), 2 * rows.len(), "{case}");
        let pass = hosted_pass(
            &mut w.store,
            &client,
            &mut dohc_engine_collab::WriterDocCache::new(),
        );
        assert!(
            holds_archived(pass.held.get("object"), &w.lineage, &archive, &queued[0]),
            "{case}: {pass:?}"
        );
        assert_eq!(archived_state(&w.store, &w.lineage), archive, "{case}");
        if protected {
            assert_eq!(
                queued_feeds(&w.store).len(),
                2 * rows.len(),
                "{case}: both stay"
            );
            assert_eq!(archived_state(&w.store, &second), archive, "{case}");
        } else {
            assert_eq!(queued_feeds(&w.store), rows, "{case}: the copy applied");
            assert_ne!(archived_state(&w.store, &second), archive, "{case}");
        }
        desktop.close().await;
        w.close().await;
    }
}

/// Sol's fifth test, the drain a document's own operations run: its queued
/// updates of an archived lineage released tails protect stay queued with
/// their blobs and feeds, the archive keeps its state, and the drain reports
/// and stores the document's hold of that lineage. After a restart the drain
/// holds again with nothing written. Once nothing protects the lineage, the
/// drain applies the updates to the archive and leaves no hold.
#[tokio::test]
async fn a_documents_drain_holds_its_protected_archived_lineage() {
    let (mut w, desktop, _client, queued, archive) = archived_window(2).await;
    let rows = queued_feeds(&w.store);
    let drained = settled_drain(&mut w.store);
    assert!(
        holds_archived(
            drained.archived_hold.as_ref(),
            &w.lineage,
            &archive,
            &queued[0]
        ),
        "{drained:?}"
    );
    assert_eq!((drained.drained, drained.refusals.len()), (0, 0));
    assert_eq!(drained.released_hold, None);
    assert_eq!(queued_feeds(&w.store), rows);
    assert_eq!(archived_state(&w.store, &w.lineage), archive);
    blobs_kept(&w.store, &queued);
    let held = dohc_engine_sync::HostedDocumentStatus::Held(drained.archived_hold.clone().unwrap());
    assert_eq!(hosted_status(&w.store, "object"), held);

    w.store = EngineStore::open(&engine_db_path(&w.root).unwrap(), 0).unwrap();
    assert_eq!(hosted_status(&w.store, "object"), held, "after a restart");
    let again = settled_drain(&mut w.store);
    assert_eq!(again.archived_hold, drained.archived_hold);
    assert_eq!(again.drained, 0);
    assert_eq!(queued_feeds(&w.store), rows);
    assert_eq!(archived_state(&w.store, &w.lineage), archive);
    assert_eq!(hosted_status(&w.store, "object"), held);

    write_unchecked(
        &w,
        &format!(
            "DELETE FROM live_owner_activations WHERE lineage_claim_id='{}'",
            w.lineage
        ),
    );
    // The archive takes both; a hosted replica refuses the recovered copy
    // its projection would write.
    let free = settled_drain(&mut w.store);
    assert_eq!(
        (
            free.archived_hold.as_ref(),
            free.drained + free.refusals.len()
        ),
        (None, 2),
        "{free:?}"
    );
    assert_eq!(queued_feeds(&w.store), Vec::<String>::new());
    assert_ne!(archived_state(&w.store, &w.lineage), archive);
    desktop.close().await;
    w.close().await;
}

/// Opus's focus question 4: an update of an archived lineage released tails
/// protect is neither acknowledged nor queued. The document's read stops
/// before it with the archived lineage's binding, the update and the one
/// behind it stay in the feed, a neighbour's write after them applies in the
/// same pass, and the pass commits that hold, again after a restart. Once
/// nothing protects the lineage, both updates reach the archive.
#[tokio::test]
async fn an_update_of_a_protected_archived_lineage_stays_in_the_feed() {
    let mut w = retained_window(Retained::Carried).await;
    add_neighbour(&mut w.store);
    let desktop = desktop_of(&w.base, &w.lineage, &[]).await;
    let archive = archive_lineage(&mut w);
    let (first, first_bytes) = desktop.append(&w.lineage, "An archived paragraph.").await;
    let (second, second_bytes) = desktop.append(&w.lineage, "Another one.").await;
    let feed = HostedFeed::new(&[("neighbour", NEIGHBOUR_PATH), ("object", WINDOW_PATH)]);
    let first = feed.serve(first, first_bytes);
    let second = feed.serve(second, second_bytes);
    let created = feed.create("neighbour", NEIGHBOUR_PATH, "A neighbour.\n");
    let client = dohc_engine_sync::RelaySyncClient::new(feed);
    for restarted in [false, true] {
        if restarted {
            w.store = EngineStore::open(&engine_db_path(&w.root).unwrap(), 0).unwrap();
        }
        let pass = hosted_pass(
            &mut w.store,
            &client,
            &mut dohc_engine_collab::WriterDocCache::new(),
        );
        assert!(journaled(&w.store, &created), "the neighbour applied");
        let binding = held_binding(&pass, &first).expect("held before the update");
        assert!(holds_archived(
            pass.held.get("object"),
            &w.lineage,
            &archive,
            &first
        ));
        assert_eq!(binding.lineage_claim_id, w.lineage);
        for op in [&first, &second] {
            assert!(!journaled(&w.store, op), "{}", op.origin_seq);
        }
        assert_eq!(queued_feeds(&w.store), Vec::<String>::new());
        assert_eq!(archived_state(&w.store, &w.lineage), archive);
        assert!(pass_commit(&mut w.store, &client, &pass).committed);
    }

    write_unchecked(
        &w,
        &format!(
            "DELETE FROM live_owner_activations WHERE lineage_claim_id='{}'",
            w.lineage
        ),
    );
    let free = committed_pass(&mut w.store, &client);
    assert!(
        !matches!(
            free.held.get("object"),
            Some(dohc_engine_sync::HostedHold::ReleasedLineageUnsettled { .. })
        ),
        "{free:?}"
    );
    for op in [&first, &second] {
        assert!(journaled(&w.store, op), "{}", op.origin_seq);
    }
    assert_eq!(queued_feeds(&w.store), Vec::<String>::new());
    assert_ne!(archived_state(&w.store, &w.lineage), archive);
    desktop.close().await;
    w.close().await;
}

/// Opus's second finding: deciding a protected archived lineage reads its
/// tails alone, never a head. A document's drain decides it once for all its
/// queued updates, and a pass decides it before its first op and at its end,
/// whatever it queues and however many ops the pass applies.
#[tokio::test]
async fn protected_archived_rows_cost_the_same_however_many_are_queued() {
    let decided = || {
        (
            lineage_protection_checks_on_this_thread(),
            released_head_loads_on_this_thread(),
        )
    };
    let since = |(checks, loads): (u64, u64)| {
        let (now_checks, now_loads) = decided();
        (now_checks - checks, now_loads - loads)
    };
    let mut counts = Vec::new();
    for (appends, writes) in [(2, 1), (6, 4)] {
        let (mut w, desktop, client, _, _) = archived_window(appends).await;
        let before = decided();
        settled_drain(&mut w.store);
        let drain = since(before);
        let mut text = "A neighbour.\n".to_owned();
        let mut ops = vec![
            client
                .transport()
                .create("neighbour", NEIGHBOUR_PATH, &text),
        ];
        for index in 1..writes {
            let next = format!("A neighbour, written {index} times.\n");
            ops.push(
                client
                    .transport()
                    .write("neighbour", NEIGHBOUR_PATH, Some(&text), &next),
            );
            text = next;
        }
        let before = decided();
        hosted_pass(
            &mut w.store,
            &client,
            &mut dohc_engine_collab::WriterDocCache::new(),
        );
        let pass = since(before);
        for op in &ops {
            assert!(journaled(&w.store, op), "{appends}: the neighbour applied");
        }
        assert_eq!((drain.1, pass.1), (0, 0), "{appends}: no head loads");
        assert_eq!(queued_updates(&w.store).len(), appends);
        counts.push((drain.0, pass.0));
        desktop.close().await;
        w.close().await;
    }
    // Each decision that waits for validation is made once more after it.
    assert_eq!(counts, [(2, 3), (2, 3)]);
}

/// Opus's gap under focus question 1: the drain another document's open
/// and close each run, on tails that never validated this document's
/// lineage, takes up only that document's queued work. It neither waits for
/// the validation of this one's protected archived lineage nor changes
/// anything of it.
#[tokio::test]
async fn another_documents_open_and_close_drains_do_not_wait_on_an_archived_lineage() {
    let (mut w, desktop, _client, _, archive) = archived_window(2).await;
    let rows = queued_feeds(&w.store);
    let status = hosted_status(&w.store, "object");
    let neighbour = DocKey::new("workspace", "main", "neighbour").unwrap();
    for operation in ["open", "close"] {
        let (drained, cleanup) = dohc_engine_sync::drain_deferred_ydoc_for_key_holding_cleanup(
            &mut w.store,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &neighbour,
            &NoFaults,
        )
        .unwrap();
        assert!(drained.waiting.is_none(), "{operation}: {drained:?}");
        dohc_engine_sync::complete_deferred_ydoc_drain_cleanup(&mut w.store, cleanup, &NoFaults)
            .unwrap();
    }
    assert_eq!(queued_feeds(&w.store), rows);
    assert_eq!(archived_state(&w.store, &w.lineage), archive);
    assert_eq!(hosted_status(&w.store, "object"), status);
    desktop.close().await;
    w.close().await;
}

/// Sol's ruling on archived freezing, with Opus's fourth finding on
/// 6ded1a22a: while a protected archived lineage holds its document, an
/// update of the head's lineage applies and the archive keeps its state.
/// The document stays held for the archived lineage, never ready. An update
/// of the archived lineage still stops the document's read at its own
/// coordinate, unacknowledged, under the binding the queued rows hold it
/// with, so each pass commits that one hold, again after a restart.
#[tokio::test]
async fn the_heads_lineage_applies_while_an_archived_lineage_holds_its_document() {
    let (mut w, desktop, client, queued, archive) = archived_window(2).await;
    let rows = queued_feeds(&w.store);
    let first = committed_pass(&mut w.store, &client);
    assert!(
        holds_archived(first.held.get("object"), &w.lineage, &archive, &queued[0]),
        "{first:?}"
    );
    let hold = first.held["object"].clone();
    let held = dohc_engine_sync::HostedDocumentStatus::Held(hold.clone());
    assert_eq!(hosted_status(&w.store, "object"), held);

    // The head's lineage is the one `archive_lineage` moved it to.
    let head = hex_sha256(b"the winning lineage");
    let (current, current_bytes) = safe_row(&[&w.native()], &head, "A paragraph of the head.");
    let current = client.transport().serve(current, current_bytes);
    let pass = hosted_pass(
        &mut w.store,
        &client,
        &mut dohc_engine_collab::WriterDocCache::new(),
    );
    assert!(journaled(&w.store, &current), "{pass:?}");
    assert!(w.text().contains("A paragraph of the head."));
    assert_eq!(pass.held.get("object"), Some(&hold), "{pass:?}");
    assert!(pass_commit(&mut w.store, &client, &pass).committed);
    assert_eq!(hosted_status(&w.store, "object"), held, "not ready");
    assert_eq!(queued_feeds(&w.store), rows);
    assert_eq!(archived_state(&w.store, &w.lineage), archive);
    blobs_kept(&w.store, &queued);

    let (archived, archived_bytes) = desktop
        .append(&w.lineage, "A later archived paragraph.")
        .await;
    let archived = client.transport().serve(archived, archived_bytes);
    for restarted in [false, true] {
        if restarted {
            w.store = EngineStore::open(&engine_db_path(&w.root).unwrap(), 0).unwrap();
        }
        let pass = hosted_pass(
            &mut w.store,
            &client,
            &mut dohc_engine_collab::WriterDocCache::new(),
        );
        let read = &pass.pending_cursor.as_ref().unwrap().reads["object"];
        assert_eq!(
            (read.cursor, read.stopped.as_ref()),
            (archived.relay_seq.unwrap() - 1, Some(&hold)),
            "restarted={restarted}: {pass:?}"
        );
        assert_eq!(pass.held.get("object"), Some(&hold));
        assert!(!journaled(&w.store, &archived), "restarted={restarted}");
        assert!(
            pass_commit(&mut w.store, &client, &pass).committed,
            "restarted={restarted}: the binding stands"
        );
        assert_eq!(hosted_status(&w.store, "object"), held);
        assert_eq!(queued_feeds(&w.store), rows);
        assert_eq!(archived_state(&w.store, &w.lineage), archive);
    }
    desktop.close().await;
    w.close().await;
}

/// Sol's first two findings on 6ded1a22a, with Opus's second: a queued
/// update of an archived lineage with no relay position, NULL or 0 as local
/// and legacy rows may record, never stalls the workspace. Unprotected, it
/// reaches the archive. Protected, it stays queued with its blob and the
/// identity it recorded, and its document waits with no binding stored,
/// through committed passes and a restart, while a neighbour's writes apply.
/// Once nothing protects the lineage, the archive takes it.
#[tokio::test]
async fn archived_rows_with_no_relay_position_never_stall_the_workspace() {
    let free = |w: &RetainedWindow| {
        write_unchecked(
            w,
            &format!(
                "DELETE FROM live_owner_activations WHERE lineage_claim_id='{}'",
                w.lineage
            ),
        );
    };
    // Rows at one position have no relay order between them.
    let sorted_feeds = |store: &EngineStore| {
        let mut feeds = queued_feeds(store);
        feeds.sort();
        feeds
    };
    let waiting = dohc_engine_sync::HostedHold::WorkWaiting;
    let held = dohc_engine_sync::HostedDocumentStatus::Held(waiting.clone());
    let ready = dohc_engine_sync::HostedDocumentStatus::Ready;
    for position in ["NULL", "0"] {
        for protected in [true, false] {
            let case = format!("relay_seq={position}, protected={protected}");
            let (mut w, desktop, client, queued, archive) = archived_window(2).await;
            execute(
                &mut w.store,
                &format!(
                    "UPDATE ydoc_deferred_updates SET ingress_kind='legacy-unknown', \
                     relay_namespace=NULL,replication_epoch=NULL,stream_identity=NULL, \
                     relay_seq={position}"
                ),
            );
            let rows = sorted_feeds(&w.store);
            if !protected {
                free(&w);
            }
            let mut text = "A neighbour.\n".to_owned();
            let created = client
                .transport()
                .create("neighbour", NEIGHBOUR_PATH, &text);
            let pass = committed_pass(&mut w.store, &client);
            assert!(
                journaled(&w.store, &created),
                "{case}: the neighbour applied"
            );
            if protected {
                assert_eq!(pass.held.get("object"), Some(&waiting), "{case}: {pass:?}");
                assert_eq!(hosted_status(&w.store, "object"), held, "{case}");
                for restarted in [false, true] {
                    if restarted {
                        w.store = EngineStore::open(&engine_db_path(&w.root).unwrap(), 0).unwrap();
                    }
                    assert_eq!(sorted_feeds(&w.store), rows, "{case}: rows and feeds stay");
                    assert_eq!(archived_state(&w.store, &w.lineage), archive, "{case}");
                    blobs_kept(&w.store, &queued);
                    let next = format!("A neighbour, written again ({restarted}).\n");
                    let edited =
                        client
                            .transport()
                            .write("neighbour", NEIGHBOUR_PATH, Some(&text), &next);
                    text = next;
                    let again = committed_pass(&mut w.store, &client);
                    assert!(
                        journaled(&w.store, &edited),
                        "{case}: the neighbour goes on"
                    );
                    assert_eq!(
                        again.held.get("object"),
                        Some(&waiting),
                        "{case}: {again:?}"
                    );
                    assert_eq!(hosted_status(&w.store, "object"), held, "{case}");
                }
                assert_eq!(sorted_feeds(&w.store), rows, "{case}");
                free(&w);
                committed_pass(&mut w.store, &client);
            }
            assert_eq!(
                queued_feeds(&w.store),
                Vec::<String>::new(),
                "{case}: the archive took them"
            );
            assert_ne!(archived_state(&w.store, &w.lineage), archive, "{case}");
            for _ in 0..2 {
                if hosted_status(&w.store, "object") == ready {
                    break;
                }
                committed_pass(&mut w.store, &client);
            }
            assert_eq!(hosted_status(&w.store, "object"), ready, "{case}");
            desktop.close().await;
            w.close().await;
        }
    }
}

/// A binding names a relay position from 1, so a row the window would hold
/// at relay position 0 has none: it waits unapplied and unacknowledged
/// instead of holding with a binding no store could read back.
#[tokio::test]
async fn a_row_at_relay_position_zero_waits_without_a_binding() {
    let mut w = retained_window(Retained::Carried).await;
    let desktop = desktop_of(&w.base, &w.lineage, &[]).await;
    let (mut fold, fold_bytes) = desktop
        .fold(&format!("{}\nA desktop edit.\n", desktop.file()))
        .await;
    w.store.put_binary_blob(&fold_bytes).unwrap();
    fold.relay_seq = Some(0);
    let native = w.native();
    let applied = settled_apply(
        &mut w.store,
        &mut dohc_engine_collab::WriterDocCache::new(),
        &fold,
        &NoFaults,
        &dohc_engine_sync::NoLiveLeases,
    );
    assert!(
        matches!(
            applied,
            Err(dohc_engine_sync::SyncError::RetryableState {
                reason: "a row held for a released lineage has no relay sequence"
            })
        ),
        "{applied:?}"
    );
    assert!(!journaled(&w.store, &fold));
    assert_eq!(w.native(), native);
    desktop.close().await;
    w.close().await;
}

/// A fence row that resumed the document at restore generation 1.
fn restored(w: &RetainedWindow) {
    write_unchecked(
        w,
        &format!(
            "INSERT INTO live_restore_fences(workspace_id,main_version_id,object_id,relay_database_namespace,
               operation_id,input_json,receipt_json,proposal_json,application_json,application_delivery_id,
               resume_receipt_json,resume_settlement_id,resume_evidence_digest)
             VALUES ('workspace','main','object','relay','restore',
               '{{\"oldBinding\":{{\"lineageClaimId\":\"{}\",\"restoreFenceGeneration\":0}},\"newFence\":1}}',
               '{{}}','{{}}','{{}}','restore-delivery','{{}}','settlement','{}')",
            w.lineage,
            "a".repeat(64)
        ),
    );
}

/// A pass whose hold names what its row would change commits nothing once
/// that moved before its commit: neither its cursor nor its hold. The
/// document's head, path or restore generation, the replica's feed, or the
/// tail's retained work moves it, whether the commit validates its tails
/// itself, decides on the tails the pass kept, or decides after a reopen of
/// the store forgot them. The next pass derives the binding again from the
/// same row, and its commit holds the document with it.
#[tokio::test]
async fn a_pass_whose_released_binding_went_stale_commits_nothing() {
    type Change = fn(&mut RetainedWindow);
    let cases: [(&str, Change); 5] = [
        ("head", |w| {
            let safe = {
                let doc = Ydoc::wire();
                doc.apply(&w.native()).unwrap();
                doc.richdoc_append_paragraph("Safe")
            };
            w.store.put_binary_blob(&safe).unwrap();
            let mut op = ydoc_row("safe", &safe, &w.lineage, WINDOW_PATH, false);
            op.relay_seq = Some(40);
            settled_apply(
                &mut w.store,
                &mut dohc_engine_collab::WriterDocCache::new(),
                &op,
                &NoFaults,
                &dohc_engine_sync::NoLiveLeases,
            )
            .unwrap();
        }),
        ("path", |w| {
            write_unchecked(
                w,
                "UPDATE path_aliases SET path='notes/renamed.md' WHERE object_id='object'",
            )
        }),
        ("restore generation", |w| restored(w)),
        ("feed", |w| {
            write_unchecked(
                w,
                "UPDATE sync_identity SET stream_identity='stream-2' WHERE workspace_id='workspace'",
            )
        }),
        ("retained work", |w| {
            write_unchecked(
                w,
                &format!(
                    "DELETE FROM owner_ydoc_outbox_entries WHERE update_digest='{}'",
                    w.retained_digest
                ),
            )
        }),
    ];
    for (case, change) in cases {
        let mut w = retained_window(Retained::Carried).await;
        let desktop = desktop_of(&w.base, &w.lineage, &[]).await;
        let (fold, bytes) = desktop
            .fold(&format!("{}\nA desktop edit.\n", desktop.file()))
            .await;
        let feed = HostedFeed::new(&[("object", WINDOW_PATH)]);
        let fold = feed.serve(fold, bytes);
        let client = dohc_engine_sync::RelaySyncClient::new(feed);
        let mut cache = dohc_engine_collab::WriterDocCache::new();
        let pass = hosted_pass(&mut w.store, &client, &mut cache);
        let stale = held_binding(&pass, &fold).expect(case);
        let replica = |store: &EngineStore| {
            dohc_engine_sync::read_hosted_replica(store, "workspace")
                .unwrap()
                .unwrap()
        };
        let before = replica(&w.store);
        // Another open of the store, whose tails keep nothing the pass's
        // did; the changes below are made past the store's checks, so it
        // opens before them.
        let mut reopened = EngineStore::open(&engine_db_path(&w.root).unwrap(), 0).unwrap();
        change(&mut w);
        let commit = |store: &mut EngineStore,
                      pass: &dohc_engine_sync::HostedPassOutcome,
                      tails: &ReleasedTails| loop {
            match client.commit_hosted_cursor(
                store,
                "workspace",
                pass.pending_cursor.as_ref().unwrap(),
                tails,
                &NoFaults,
            ) {
                Err(dohc_engine_sync::RelayError::ValidationPending(pending)) => {
                    pending.validate().wait().unwrap();
                }
                committed => break committed.unwrap(),
            }
        };
        let kept = cache.released_tails(&w.store);
        let reopened_tails = ReleasedTails::default().bound_to(&reopened);
        for mode in ["uncached", "kept", "reopened"] {
            let (store, tails) = match mode {
                "uncached" => (&mut w.store, ReleasedTails::uncached()),
                "kept" => (&mut w.store, kept.clone()),
                _ => (&mut reopened, reopened_tails.clone()),
            };
            assert_eq!(
                commit(store, &pass, &tails),
                dohc_engine_storage::TxnOutcome::Committed(dohc_engine_sync::HostedCommit {
                    committed: false,
                    has_more: false,
                }),
                "{case}, {mode}"
            );
            assert_eq!(replica(store), before, "{case}, {mode}: nothing committed");
        }
        drop(reopened);
        let next = hosted_pass(&mut w.store, &client, &mut cache);
        let fresh = held_binding(&next, &fold).expect(case);
        assert_ne!(fresh, stale, "{case}");
        assert!(
            matches!(
                commit(&mut w.store, &next, &kept),
                dohc_engine_storage::TxnOutcome::Committed(dohc_engine_sync::HostedCommit {
                    committed: true,
                    ..
                })
            ),
            "{case}"
        );
        assert_eq!(
            replica(&w.store).documents["object"].status,
            dohc_engine_sync::HostedDocumentStatus::Held(
                dohc_engine_sync::HostedHold::ReleasedLineageUnsettled {
                    binding: Box::new(fresh),
                    continuation: dohc_engine_sync::ReleasedHoldContinuation::Frozen,
                    binding_stale: false,
                }
            ),
            "{case}"
        );
        assert!(!journaled(&w.store, &fold), "{case}");
        desktop.close().await;
        w.close().await;
    }
}

/// The ingress gate's own sites: a base state, a delta of another lineage
/// and an update at another path hold while protected, never passing as an
/// ordinary update. The same update at the document's path applies.
#[tokio::test]
async fn a_released_window_holds_a_base_another_lineage_and_another_path() {
    let mut w = retained_window(Retained::Carried).await;
    let fresh = Ydoc::wire().richdoc_append_paragraph("Another lineage");
    let safe = {
        let doc = Ydoc::wire();
        doc.apply(&w.native()).unwrap();
        doc.richdoc_append_paragraph("Safe")
    };
    let row = |store: &mut EngineStore,
               origin: &str,
               relay_seq: i64,
               bytes: &[u8],
               lineage: &str,
               path: &str,
               base: bool| {
        store.put_binary_blob(bytes).unwrap();
        let mut op = ydoc_row(origin, bytes, lineage, path, base);
        op.relay_seq = Some(relay_seq);
        op
    };
    let other_lineage = "e".repeat(64);
    let lineage = w.lineage.clone();
    let cases = [
        (
            "a base state",
            row(
                &mut w.store,
                "base",
                20,
                &fresh,
                &hex_sha256(&fresh),
                WINDOW_PATH,
                true,
            ),
        ),
        (
            "another lineage",
            row(
                &mut w.store,
                "lineage",
                21,
                &safe,
                &other_lineage,
                WINDOW_PATH,
                false,
            ),
        ),
        (
            "another path",
            row(
                &mut w.store,
                "path",
                22,
                &safe,
                &lineage,
                "notes/moved.md",
                false,
            ),
        ),
    ];
    let native = w.native();
    for (case, op) in &cases {
        let held = settled_apply(
            &mut w.store,
            &mut dohc_engine_collab::WriterDocCache::new(),
            op,
            &NoFaults,
            &dohc_engine_sync::NoLiveLeases,
        );
        assert!(
            matches!(
                held,
                Err(dohc_engine_sync::SyncError::ReleasedLineageUnsettled(_))
            ),
            "{case}: {held:?}"
        );
        assert_eq!(w.native(), native, "{case}");
        assert!(!journaled(&w.store, op), "{case}");
    }
    let op = row(
        &mut w.store,
        "safe",
        23,
        &safe,
        &lineage,
        WINDOW_PATH,
        false,
    );
    let applied = settled_apply(
        &mut w.store,
        &mut dohc_engine_collab::WriterDocCache::new(),
        &op,
        &NoFaults,
        &dohc_engine_sync::NoLiveLeases,
    )
    .unwrap();
    assert!(
        matches!(
            applied.primary,
            dohc_engine_sync::ApplyDisposition::Applied(_)
        ),
        "{:?}",
        applied.primary
    );
    assert!(w.text().contains("Safe") && w.text().contains(RETAINED));
    w.close().await;
}

/// Write `sql` past the store's own checks, as a damaged store could hold it.
fn write_unchecked(w: &RetainedWindow, sql: &str) {
    let raw = rusqlite::Connection::open(engine_db_path(&w.root).unwrap()).unwrap();
    raw.execute_batch(&format!(
        "PRAGMA foreign_keys=OFF; PRAGMA ignore_check_constraints=ON; {sql}"
    ))
    .unwrap();
}

/// Sol's 1a-2 finding 2: once the document's durable restore generation or
/// path moves past what the tail's release bound, even an update that only
/// adds content holds, whether the tail's coverage reads or not. A release
/// that does not read holds an update at an unchanged path and generation.
#[tokio::test]
async fn a_released_window_holds_a_safe_append_once_its_binding_moves() {
    const RENAMED: &str = "notes/renamed.md";
    let renamed = |w: &RetainedWindow| {
        write_unchecked(
            w,
            &format!("UPDATE path_aliases SET path='{RENAMED}' WHERE object_id='object'"),
        );
    };
    let uncovered = |w: &RetainedWindow| {
        write_unchecked(
            w,
            &format!(
                "DELETE FROM owner_ydoc_outbox_entries WHERE update_digest='{}'",
                w.retained_digest
            ),
        );
    };
    let unbound = |w: &RetainedWindow| {
        write_unchecked(
            w,
            "UPDATE live_owner_activations SET released_restore_generation=NULL",
        );
    };
    type Damage = fn(&RetainedWindow);
    // Each case: its damage, the path the update lands at, and whether the
    // tail's coverage still reads.
    let cases: [(&str, &[Damage], &str, bool); 5] = [
        ("restored", &[restored], WINDOW_PATH, true),
        ("renamed", &[renamed], RENAMED, true),
        (
            "restored, coverage invalid",
            &[uncovered, restored],
            WINDOW_PATH,
            false,
        ),
        (
            "renamed, coverage invalid",
            &[uncovered, renamed],
            RENAMED,
            false,
        ),
        (
            "a release that does not read",
            &[unbound],
            WINDOW_PATH,
            false,
        ),
    ];
    for (case, damages, path, readable) in cases {
        let mut w = retained_window(Retained::Carried).await;
        let safe = {
            let doc = Ydoc::wire();
            doc.apply(&w.native()).unwrap();
            doc.richdoc_append_paragraph("Safe")
        };
        assert_eq!(
            dohc_engine_collab::inspect_update(&w.head(), &safe),
            dohc_engine_collab::UpdateInspection::Admissible,
            "{case}"
        );
        for damage in damages {
            damage(&w);
        }
        w.store.put_binary_blob(&safe).unwrap();
        let mut op = ydoc_row("safe", &safe, &w.lineage, path, false);
        op.relay_seq = Some(20);
        let native = w.native();
        let held = settled_apply(
            &mut w.store,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &op,
            &NoFaults,
            &dohc_engine_sync::NoLiveLeases,
        );
        let Err(dohc_engine_sync::SyncError::ReleasedLineageUnsettled(binding)) = held else {
            panic!("{case}: {held:?}");
        };
        let ProtectedTails::Listed(tails) = &*binding.tails else {
            panic!("{case}: {:?}", binding.tails);
        };
        let [tail] = tails.as_slice() else {
            panic!("{case}: {tails:?}");
        };
        assert_eq!(
            tail.coverage != RetainedCoverage::Invalid,
            readable,
            "{case}: {:?}",
            tail.coverage
        );
        assert_eq!(
            tail.release.is_some(),
            case != "a release that does not read",
            "{case}"
        );
        assert_eq!(w.native(), native, "{case}");
        assert!(!journaled(&w.store, &op), "{case}");
        w.close().await;
    }
}

/// Opus's 1a-2 finding 3: window evidence that does not read, here two
/// tails in one namespace, holds only its document. An update that would
/// otherwise apply waits; a neighbour in the same pass applies, and the pass
/// commits.
#[tokio::test]
async fn a_window_that_does_not_read_holds_only_its_document() {
    let mut w = retained_window(Retained::Carried).await;
    execute(
        &mut w.store,
        "INSERT INTO hosted_documents(workspace_id,object_id,path,state,scope_generation)
        VALUES ('workspace','neighbour','notes/neighbour.md','ready',1)",
    );
    write_unchecked(
        &w,
        &format!(
            "CREATE TEMP TABLE twin AS SELECT * FROM live_owner_activations WHERE activation_id='{}';
             UPDATE twin SET activation_id='twin';
             INSERT INTO live_owner_activations SELECT * FROM twin",
            w.first.activation_id
        ),
    );
    let safe = {
        let doc = Ydoc::wire();
        doc.apply(&w.native()).unwrap();
        doc.richdoc_append_paragraph("Safe")
    };
    let feed = HostedFeed::new(&[("neighbour", "notes/neighbour.md"), ("object", WINDOW_PATH)]);
    let held = feed.serve(
        ydoc_row("safe", &safe, &w.lineage, WINDOW_PATH, false),
        safe,
    );
    let created = feed.create("neighbour", "notes/neighbour.md", "A neighbour.\n");
    let client = dohc_engine_sync::RelaySyncClient::new(feed);
    let native = w.native();
    let pass = hosted_pass(
        &mut w.store,
        &client,
        &mut dohc_engine_collab::WriterDocCache::new(),
    );
    assert_eq!(pass.applied, 1, "the neighbour");
    assert!(journaled(&w.store, &created));
    assert!(!journaled(&w.store, &held));
    assert!(stopped_before(&pass, &held), "{:?}", pass.pending_cursor);
    assert_eq!(w.native(), native);
    let committed = client
        .commit_hosted_cursor(
            &mut w.store,
            "workspace",
            pass.pending_cursor.as_ref().unwrap(),
            &ReleasedTails::uncached(),
            &NoFaults,
        )
        .unwrap();
    assert!(matches!(
        committed,
        dohc_engine_storage::TxnOutcome::Committed(_)
    ));
    w.close().await;
}

/// The host's application of exactly one delivery to the window's document,
/// written past the store's checks: its delivery, lineage, digest, journal
/// cursor and accepting epoch.
const APPLIED_EXACTLY: &str = "INSERT INTO live_device_update_applications (relay_database_namespace,
      workspace_id,delivery_id,main_version_id,object_id,lineage_claim_id,current_path,selector_paths_json,
      restore_fence_generation,update_digest,update_byte_length,journal_cursor,accepting_host_epoch,
      principal_kind,principal_id,received_at_ms,first_seen_count,local_ydoc_sequence,applied_host_id,
      applied_host_epoch,applied_instance_id,applied_connection_id)
    VALUES ('relay','workspace',?1,'main','object',?2,'notes/plan.md','[\"notes/plan.md\"]',0,?3,1,?4,?5,
      'owner','owner',0,0,1,'host',1,'instance','connection')";

#[path = "owner_publication/released_window_measure.rs"]
mod released_window_measure;

#[path = "owner_publication/settlement_drain.rs"]
mod settlement_drain;

#[path = "owner_publication/released_namespaces.rs"]
mod released_namespaces;

#[path = "owner_publication/held_proof.rs"]
mod held_proof;

/// A decision of [`released_window_measure`] on `tails`, kept for one open
/// store as the actor keeps them, run to its end as the actor's relay
/// coordinator runs it: each attempt, with the request for the validation it
/// waits for, is one actor operation, and the worker validates between them.
/// The retained work its protecting binding lists.
fn measured_protection(
    store: &EngineStore,
    key: &ProtectionKey<'_>,
    tails: &mut ReleasedTails,
) -> usize {
    let tails = tails.bound_to(store);
    let protected = loop {
        let decided = released_window_measure::operation(|| {
            match store
                .read_with(|conn| protection(conn, key, &tails))
                .unwrap()
            {
                Protection::Pending(pending) => Err(pending.validate()),
                decided => Ok(decided),
            }
        });
        match decided {
            Ok(decided) => break decided,
            Err(validation) => validation.wait().unwrap(),
        }
    };
    let Protection::Protected { binding, .. } = protected else {
        panic!("protected");
    };
    let ProtectedTails::Listed(tails) = &*binding.tails else {
        panic!("listed");
    };
    tails
        .iter()
        .map(|tail| match &tail.coverage {
            RetainedCoverage::Unproven(unproven) => unproven.count as usize,
            RetainedCoverage::Invalid => panic!("readable"),
        })
        .sum()
}

/// A hosted pass of [`released_window_measure`] run to its end the same way.
fn measured_pull(
    store: &mut EngineStore,
    client: &dohc_engine_sync::RelaySyncClient<HostedFeed>,
    cache: &mut dohc_engine_collab::WriterDocCache,
) -> Result<dohc_engine_sync::HostedPassOutcome, dohc_engine_sync::RelayError> {
    loop {
        let attempt = released_window_measure::operation(|| {
            match client.pull_hosted_workspace(
                store,
                cache,
                "workspace",
                "relay",
                &NoFaults,
                &dohc_engine_sync::NoLiveLeases,
            ) {
                Err(dohc_engine_sync::RelayError::ValidationPending(pending)) => {
                    Err(pending.validate())
                }
                pass => Ok(pass),
            }
        });
        match attempt {
            Ok(pass) => return pass,
            Err(validation) => validation.wait().unwrap(),
        }
    }
}

/// The commit that completes a pass of [`released_window_measure`], with
/// the tails the actor keeps, run to its end the same way.
fn measured_commit(
    client: &dohc_engine_sync::RelaySyncClient<HostedFeed>,
    store: &mut EngineStore,
    cache: &dohc_engine_collab::WriterDocCache,
    cursor: &dohc_engine_sync::HostedCursor,
) -> dohc_engine_sync::HostedCommit {
    loop {
        let attempt = released_window_measure::operation(|| {
            match client.commit_hosted_cursor(
                store,
                "workspace",
                cursor,
                &cache.released_tails(store),
                &NoFaults,
            ) {
                Err(dohc_engine_sync::RelayError::ValidationPending(pending)) => {
                    Err(pending.validate())
                }
                commit => Ok(commit.unwrap()),
            }
        });
        match attempt {
            Ok(dohc_engine_storage::TxnOutcome::Committed(commit)) => return commit,
            Ok(_) => panic!("crashed"),
            Err(validation) => validation.wait().unwrap(),
        }
    }
}

/// Sol's tails-cache ruling: the actor keeps a released lineage's validated
/// tails across passes while the document's generation stands. A pass that
/// applies a neighbour and a safe row and ends in a hold validates once, and
/// the next pass, which holds again, reuses that. The Carried delivery
/// applied moves the generation: the next pass validates again and applies
/// the fold the earlier ones held.
#[tokio::test]
async fn validated_tails_stand_across_passes_until_a_tail_input_changes() {
    let mut w = retained_window(Retained::Carried).await;
    execute(
        &mut w.store,
        "INSERT INTO hosted_documents(workspace_id,object_id,path,state,scope_generation)
        VALUES ('workspace','neighbour','notes/neighbour.md','ready',1)",
    );
    let desktop = desktop_of(&w.base, &w.lineage, &[]).await;
    let (fold, fold_bytes) = desktop
        .fold(&format!("{}\nA desktop edit.\n", desktop.file()))
        .await;
    let safe = {
        let doc = Ydoc::wire();
        doc.apply(&w.native()).unwrap();
        doc.richdoc_append_paragraph("Safe")
    };
    let feed = HostedFeed::new(&[("neighbour", "notes/neighbour.md"), ("object", WINDOW_PATH)]);
    let safe = feed.serve(
        ydoc_row("safe", &safe, &w.lineage, WINDOW_PATH, false),
        safe,
    );
    let created = feed.create("neighbour", "notes/neighbour.md", "A neighbour.\n");
    let fold = feed.serve(fold, fold_bytes);
    let client = dohc_engine_sync::RelaySyncClient::new(feed);
    let mut cache = dohc_engine_collab::WriterDocCache::new();
    let validations = |w: &RetainedWindow, cache: &dohc_engine_collab::WriterDocCache| {
        cache.released_tails(&w.store).validations()
    };
    let pass = hosted_pass(&mut w.store, &client, &mut cache);
    assert_eq!(pass.applied, 2, "{:?}", pass.pending_cursor);
    assert!(journaled(&w.store, &safe) && journaled(&w.store, &created));
    assert!(!journaled(&w.store, &fold));
    assert!(stopped_before(&pass, &fold), "{:?}", pass.pending_cursor);
    assert_eq!(validations(&w, &cache), 1, "one validation for the pass");
    let again = hosted_pass(&mut w.store, &client, &mut cache);
    assert!(
        again.applied == 0 && stopped_before(&again, &fold),
        "{:?}",
        again.pending_cursor
    );
    assert_eq!(validations(&w, &cache), 1, "the next pass reuses it");
    let (delivery_id, receipt): (String, String) = w
        .store
        .read_with(|conn| {
            conn.query_row(
                "SELECT delivery_id,accepted_receipt_json FROM owner_ydoc_outbox_entries
                 WHERE update_digest=?1",
                [&w.retained_digest],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
        })
        .unwrap();
    let receipt: dohc_engine_collab::OwnerDeliveryReceipt = serde_json::from_str(&receipt).unwrap();
    let raw = rusqlite::Connection::open(engine_db_path(&w.root).unwrap()).unwrap();
    raw.execute_batch("PRAGMA foreign_keys=OFF").unwrap();
    raw.execute(
        APPLIED_EXACTLY,
        rusqlite::params![
            delivery_id,
            w.lineage,
            w.retained_digest,
            receipt.journal_cursor,
            receipt.accepting_host_epoch
        ],
    )
    .unwrap();
    drop(raw);
    let next = hosted_pass(&mut w.store, &client, &mut cache);
    assert_eq!(next.applied, 1, "{:?}", next.pending_cursor);
    assert!(journaled(&w.store, &fold));
    assert_eq!(validations(&w, &cache), 2, "a tail input changed");
    desktop.close().await;
    w.close().await;
}

/// Sol's tails-cache ruling, the retired lineage Opus found: in the window,
/// with both Carried deliveries applied here, the owner's desktop delete
/// decides its document unprotected and retires the lineage. A base of the
/// same bytes recreates it under the same lineage in the same pass, and the
/// update after it is decided as uncached validation decides it: the
/// recreated journal no longer proves the Carried deliveries, so the
/// lineage is protected and the update, which deletes, holds. Decided on
/// the tails kept before the retirement, it would apply.
#[tokio::test]
async fn a_lineage_retired_and_recreated_in_one_pass_is_validated_again() {
    let mut w = adopted_window(true).await;
    w.release().await;
    execute(
        &mut w.store,
        "UPDATE hosted_replicas SET scope_token='scope'",
    );
    let raw = rusqlite::Connection::open(engine_db_path(&w.root).unwrap()).unwrap();
    raw.execute_batch("PRAGMA foreign_keys=OFF").unwrap();
    let carried: Vec<String> = raw
        .prepare(
            "SELECT accepted_receipt_json FROM owner_ydoc_outbox_entries
             WHERE accepted_receipt_json IS NOT NULL AND delivery_id<>?1",
        )
        .unwrap()
        .query_map([&w.covered.delivery_id], |row| row.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(carried.len(), 2);
    for receipt in carried {
        let receipt: dohc_engine_collab::OwnerDeliveryReceipt =
            serde_json::from_str(&receipt).unwrap();
        raw.execute(
            APPLIED_EXACTLY,
            rusqlite::params![
                receipt.delivery_id,
                w.lineage,
                receipt.update_digest,
                receipt.journal_cursor,
                receipt.accepting_host_epoch
            ],
        )
        .unwrap();
    }
    drop(raw);
    let desktop = desktop_of(&w.base, &w.lineage, &[w.covered_bytes.clone()]).await;
    let (delete, delete_bytes) = desktop.change(FileChange::Delete).await;
    let recreated = {
        let doc = Ydoc::wire();
        doc.apply(&w.base).unwrap();
        doc.richdoc_remove_block(0)
    };
    let feed = HostedFeed::new(&[("object", WINDOW_PATH)]);
    let delete = feed.serve(delete, delete_bytes);
    let base = feed.serve(
        ydoc_row("recreator", &w.base, &w.lineage, WINDOW_PATH, true),
        w.base.clone(),
    );
    let update = feed.serve(
        ydoc_row(
            "after-recreation",
            &recreated,
            &w.lineage,
            WINDOW_PATH,
            false,
        ),
        recreated,
    );
    let client = dohc_engine_sync::RelaySyncClient::new(feed);
    let mut cache = dohc_engine_collab::WriterDocCache::new();
    let pass = hosted_pass(&mut w.store, &client, &mut cache);
    assert!(
        journaled(&w.store, &delete),
        "the delete retires the lineage"
    );
    assert!(journaled(&w.store, &base), "the base recreates it");
    let incoming = IncomingCoordinate {
        relay_namespace: Some("relay".into()),
        replication_epoch: "epoch".into(),
        stream_identity: "stream".into(),
        origin_id: "after-recreation".into(),
        origin_seq: 0,
        relay_seq: update.relay_seq.unwrap(),
    };
    let key = window_key();
    let uncached = w
        .store
        .read_with(|conn| {
            protection(
                conn,
                &ProtectionKey {
                    doc: &key,
                    lineage_claim_id: &w.lineage,
                    incoming: &incoming,
                },
                &ReleasedTails::uncached(),
            )
        })
        .unwrap();
    assert!(matches!(uncached, Protection::Protected { .. }));
    assert!(!journaled(&w.store, &update), "{:?}", pass.pending_cursor);
    assert!(stopped_before(&pass, &update), "{:?}", pass.pending_cursor);
    assert_eq!(
        cache.released_tails(&w.store).validations(),
        2,
        "before the retirement and after the recreation"
    );
    desktop.close().await;
    w.close().await;
}

type HeldPass = (
    RetainedWindow,
    Desktop,
    dohc_engine_sync::RelaySyncClient<HostedFeed>,
    dohc_engine_sync::HostedPassOutcome,
);

/// The window with a ready neighbour, its feed, and a pass that holds the
/// desktop's fold of the document after applying the neighbour's create, as
/// yet uncommitted.
async fn held_pass() -> HeldPass {
    let mut w = retained_window(Retained::Carried).await;
    add_neighbour(&mut w.store);
    let desktop = desktop_of(&w.base, &w.lineage, &[]).await;
    let (fold, bytes) = desktop
        .fold(&format!("{}\nA desktop edit.\n", desktop.file()))
        .await;
    let feed = HostedFeed::new(&[("neighbour", NEIGHBOUR_PATH), ("object", WINDOW_PATH)]);
    feed.create("neighbour", NEIGHBOUR_PATH, "A neighbour.\n");
    let fold = feed.serve(fold, bytes);
    let client = dohc_engine_sync::RelaySyncClient::new(feed);
    let pass = hosted_pass(
        &mut w.store,
        &client,
        &mut dohc_engine_collab::WriterDocCache::new(),
    );
    assert!(stopped_before(&pass, &fold), "{:?}", pass.pending_cursor);
    (w, desktop, client, pass)
}

fn relay_configuration() -> dohc_engine_runtime::RelayConfiguration {
    dohc_engine_runtime::RelayConfiguration {
        base_url: "https://relay.example".into(),
        socket_path: None,
        bearer_token: "service-credential".into(),
        #[cfg(debug_assertions)]
        allow_insecure_loopback_for_tests: false,
    }
}

type Answer = Result<dohc_engine_runtime::RelayOperationOutcome, dohc_engine_runtime::RuntimeError>;

/// The actor's commit of `pass`, running as a relay request does.
fn actor_commit(
    w: &RetainedWindow,
    pass: &dohc_engine_sync::HostedPassOutcome,
    token: CancellationToken,
) -> tokio::task::JoinHandle<Answer> {
    let actor = w.actor.clone();
    let operation = dohc_engine_runtime::RelayOperation::CommitHostedCursor {
        workspace_id: "workspace".into(),
        cursor: pass.pending_cursor.clone().unwrap(),
        root: w.root.path().to_owned(),
        now_ms: 1_000_000,
    };
    tokio::spawn(async move {
        actor
            .relay(
                relay_configuration(),
                operation,
                dohc_engine_collab::LeaseRegistry::new(),
                token,
                None,
            )
            .await
    })
}

/// Wait until `tails` holds a validation at its pause, failing if the
/// request answers first.
async fn held_validation(tails: &ReleasedTails, request: &mut tokio::task::JoinHandle<Answer>) {
    tokio::select! {
        () = tails.paused_validation() => {}
        answered = request => panic!("answered before its validation completed: {answered:?}"),
    }
}

fn committed(answer: Answer) -> bool {
    match answer.unwrap() {
        dohc_engine_runtime::RelayOperationOutcome::HostedCursorCommitted { commit, .. } => {
            commit.committed
        }
        other => panic!("{other:?}"),
    }
}

fn cursor_commits(store: &EngineStore) -> i64 {
    store
        .read_with(|conn| {
            conn.query_row(
                "SELECT cursor_commits FROM hosted_replicas WHERE workspace_id='workspace'",
                [],
                |row| row.get(0),
            )
        })
        .unwrap()
}

/// Sol's worker ruling 1: a pass whose decision waits for validation stops
/// with its row unapplied and its transaction ended. Its next run validates
/// nothing itself and fetches nothing again: it goes on from that row with
/// the neighbour's create it applied before still counted and still
/// written, and holds the fold.
#[tokio::test]
async fn a_pass_waiting_for_validation_goes_on_from_the_row_that_waited() {
    let mut w = retained_window(Retained::Carried).await;
    add_neighbour(&mut w.store);
    let desktop = desktop_of(&w.base, &w.lineage, &[]).await;
    let (fold, fold_bytes) = desktop
        .fold(&format!("{}\nA desktop edit.\n", desktop.file()))
        .await;
    let safe = {
        let doc = Ydoc::wire();
        doc.apply(&w.native()).unwrap();
        doc.richdoc_append_paragraph("Safe")
    };
    let feed = HostedFeed::new(&[("neighbour", NEIGHBOUR_PATH), ("object", WINDOW_PATH)]);
    let created = feed.create("neighbour", NEIGHBOUR_PATH, "A neighbour.\n");
    let safe = feed.serve(
        ydoc_row("safe", &safe, &w.lineage, WINDOW_PATH, false),
        safe,
    );
    let fold = feed.serve(fold, fold_bytes);
    let client = dohc_engine_sync::RelaySyncClient::new(feed);
    let mut cache = dohc_engine_collab::WriterDocCache::new();
    let tails = cache.released_tails(&w.store);
    let scans = released_tail_scans_on_this_thread();
    let pull = |store: &mut EngineStore, cache: &mut _| {
        client.pull_hosted_workspace(
            store,
            cache,
            "workspace",
            "relay",
            &NoFaults,
            &dohc_engine_sync::NoLiveLeases,
        )
    };
    let Err(dohc_engine_sync::RelayError::ValidationPending(pending)) =
        pull(&mut w.store, &mut cache)
    else {
        panic!("the window's first decision waits");
    };
    assert!(journaled(&w.store, &created), "the neighbour applied first");
    assert!(
        !journaled(&w.store, &safe),
        "the row that waits applied nothing"
    );
    assert_eq!(
        tails.validation_requests(),
        0,
        "nothing asked the worker yet"
    );
    pending.validate().wait().unwrap();
    let pass = pull(&mut w.store, &mut cache).unwrap();
    assert_eq!(pass.applied, 2, "the neighbour and the safe row");
    assert!(
        pass.changed_paths
            .iter()
            .any(|change| change.path == NEIGHBOUR_PATH),
        "{:?}",
        pass.changed_paths
    );
    assert!(journaled(&w.store, &safe));
    assert!(stopped_before(&pass, &fold), "{:?}", pass.pending_cursor);
    assert_eq!(client.transport().pulls(), 1, "fetched once");
    assert_eq!((tails.validation_requests(), tails.validations()), (1, 1));
    assert_eq!(
        released_tail_scans_on_this_thread(),
        scans,
        "no decision scanned"
    );
    desktop.close().await;
    w.close().await;
}

/// Sol's 1a-2g finding 2: the same through the actor, where each attempt of
/// the request runs a new client and only the request's transport keeps the
/// pass. The neighbour's create applies and the next row waits; the actor
/// serves other work, a non-relay operation among it, while the request
/// stays outstanding. Once validation completes the request goes on from
/// the row that waited, fetched once, with the neighbour still counted and
/// its change still reported.
#[tokio::test]
async fn an_actor_pull_waiting_for_validation_goes_on_from_the_row_that_waited() {
    let mut w = retained_window(Retained::Carried).await;
    add_neighbour(&mut w.store);
    let desktop = desktop_of(&w.base, &w.lineage, &[]).await;
    let (fold, fold_bytes) = desktop
        .fold(&format!("{}\nA desktop edit.\n", desktop.file()))
        .await;
    let safe = {
        let doc = Ydoc::wire();
        doc.apply(&w.native()).unwrap();
        doc.richdoc_append_paragraph("Safe")
    };
    let feed = std::sync::Arc::new(HostedFeed::new(&[
        ("neighbour", NEIGHBOUR_PATH),
        ("object", WINDOW_PATH),
    ]));
    let created = feed.create("neighbour", NEIGHBOUR_PATH, "A neighbour.\n");
    let safe = feed.serve(
        ydoc_row("safe", &safe, &w.lineage, WINDOW_PATH, false),
        safe,
    );
    let fold = feed.serve(fold, fold_bytes);
    let tails = w.actor.released_tails();
    tails.pause_validation();
    let mut pull = tokio::spawn({
        let (actor, feed) = (w.actor.clone(), std::sync::Arc::clone(&feed));
        let operation = dohc_engine_runtime::RelayOperation::PullHosted {
            workspace_id: "workspace".into(),
            root: w.root.path().to_owned(),
            relay_namespace: "relay".into(),
            now_ms: 1_000_000,
        };
        async move {
            actor
                .relay_through(feed, operation, CancellationToken::new())
                .await
        }
    });
    held_validation(&tails, &mut pull).await;
    assert!(journaled(&w.store, &created), "the neighbour applied first");
    assert!(
        !journaled(&w.store, &safe),
        "the row that waits applied nothing"
    );
    w.actor
        .remote_changes_applied("workspace".into())
        .await
        .expect("the actor serves other work");
    assert!(!pull.is_finished(), "the pull is outstanding");
    tails.resume_validation();
    let dohc_engine_runtime::RelayOperationOutcome::HostedPass { pass, .. } =
        pull.await.unwrap().unwrap()
    else {
        panic!("a hosted pass");
    };
    assert_eq!(pass.applied, 2, "the neighbour and the safe row");
    assert!(
        pass.changed_paths
            .iter()
            .any(|change| change.path == NEIGHBOUR_PATH),
        "{:?}",
        pass.changed_paths
    );
    assert!(journaled(&w.store, &safe));
    assert!(stopped_before(&pass, &fold), "{:?}", pass.pending_cursor);
    assert_eq!(feed.pulls(), 1, "fetched once");
    assert_eq!((tails.validation_requests(), tails.validations()), (1, 1));
    desktop.close().await;
    w.close().await;
}

/// Each queued owner settlement in drain order: its origin, whether it was
/// scheduled, whether it applied, and the report that owns it.
fn settlement_queue(store: &EngineStore) -> Vec<(String, bool, bool, Option<String>)> {
    store
        .read_with(|conn| {
            conn.prepare(
                "SELECT origin_id,checked_sequence>0,applied,report_id FROM owner_pending_settlements
                 ORDER BY checked_sequence,terminal_cursor,origin_id,origin_seq",
            )?
            .query_map([], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
            })?
            .collect()
        })
        .unwrap()
}

/// The released-lineage binding `pass` holds the window document with.
fn held_object(pass: &dohc_engine_sync::HostedPassOutcome) -> ReleasedLineageBinding {
    match pass.held.get("object") {
        Some(dohc_engine_sync::HostedHold::ReleasedLineageUnsettled { binding, .. }) => {
            (**binding).clone()
        }
        other => panic!("{other:?}"),
    }
}

/// How many contributions each tail of `binding` commits to.
fn committed_counts(binding: &ReleasedLineageBinding) -> Vec<i64> {
    let ProtectedTails::Listed(tails) = &*binding.tails else {
        panic!("{:?}", binding.tails);
    };
    tails
        .iter()
        .map(|tail| match &tail.coverage {
            RetainedCoverage::Unproven(unproven) => unproven.count,
            RetainedCoverage::Invalid => panic!("readable"),
        })
        .collect()
}

/// Sol's binding-cost ruling: a protected tail's binding names its unproven
/// work by count and digest, so a hold over 50,000 retained entries is the
/// size of a hold over one. The worker commits to the work once, as it
/// validates. Warm passes and their cursor commits scan nothing and commit to
/// nothing again, storing the hold included, which moves its hold revision
/// and never its document's generation, and the hold stores the binding's
/// own canonical bytes.
#[tokio::test]
async fn a_hold_names_retained_work_by_one_commitment_at_any_size() {
    let (mut w, desktop, client, pass) = held_pass().await;
    let one = held_object(&pass);
    assert_eq!(committed_counts(&one), [1]);
    released_window_measure::retained_history(&w, 50_000, false);
    let mut cache = dohc_engine_collab::WriterDocCache::new();
    let tails = cache.released_tails(&w.store);
    let many = held_object(&hosted_pass(&mut w.store, &client, &mut cache));
    assert_eq!(committed_counts(&many), [50_001]);
    assert_eq!(
        many.canonical_json().len(),
        one.canonical_json().len() + "50001".len() - "1".len(),
        "only the count's digits differ in size"
    );
    assert_eq!(tails.validations(), 1);
    let (scans, commitments) = (
        released_tail_scans_on_this_thread(),
        released_tail_commitments_on_this_thread(),
    );
    for _ in 0..3 {
        let pass = hosted_pass(&mut w.store, &client, &mut cache);
        assert_eq!(held_object(&pass), many);
        let commit = client
            .commit_hosted_cursor(
                &mut w.store,
                "workspace",
                pass.pending_cursor.as_ref().unwrap(),
                &tails,
                &NoFaults,
            )
            .unwrap();
        assert!(
            matches!(&commit, dohc_engine_storage::TxnOutcome::Committed(commit) if commit.committed),
            "{commit:?}"
        );
    }
    assert_eq!(
        (
            released_tail_scans_on_this_thread(),
            released_tail_commitments_on_this_thread(),
            tails.validations(),
        ),
        (scans, commitments, 1),
        "warm passes and commits scan and commit to nothing"
    );
    let stored: String = w
        .store
        .read_with(|conn| {
            conn.query_row(
                "SELECT released_hold_binding_json FROM hosted_documents WHERE object_id='object'",
                [],
                |row| row.get(0),
            )
        })
        .unwrap();
    assert_eq!(stored, many.canonical_json());
    desktop.close().await;
    w.close().await;
}

/// Sol's worker ruling 1 and 4: a cursor commit whose hold waits for
/// validation rolls back and stays outstanding while the worker validates;
/// it never answers committed: false. The actor serves other work
/// meanwhile, and nothing commits until validation completes. A later pass
/// whose commit follows a tail-input change waits again the same way.
#[tokio::test]
async fn a_hosted_commit_waits_off_the_actor_for_validation() {
    let (mut w, desktop, client, pass) = held_pass().await;
    let tails = w.actor.released_tails();
    let before = cursor_commits(&w.store);
    tails.pause_validation();
    let mut commit = actor_commit(&w, &pass, CancellationToken::new());
    held_validation(&tails, &mut commit).await;
    w.actor
        .remote_changes_applied("workspace".into())
        .await
        .expect("the actor serves other work");
    assert!(!commit.is_finished(), "the commit is outstanding");
    assert_eq!(cursor_commits(&w.store), before, "nothing committed");
    tails.resume_validation();
    assert!(committed(commit.await.unwrap()));
    assert_eq!(cursor_commits(&w.store), before + 1);
    assert_eq!(tails.validation_requests(), 1);

    // The next pass holds again; a tail input changes before its commit.
    let again = hosted_pass(
        &mut w.store,
        &client,
        &mut dohc_engine_collab::WriterDocCache::new(),
    );
    assert_eq!(
        again.held.get("object"),
        pass.held.get("object"),
        "held again"
    );
    write_unchecked(
        &w,
        "UPDATE live_owner_activations SET source_byte_length=source_byte_length",
    );
    tails.pause_validation();
    let mut commit = actor_commit(&w, &again, CancellationToken::new());
    held_validation(&tails, &mut commit).await;
    assert!(!commit.is_finished(), "one commit outstanding");
    tails.resume_validation();
    assert!(committed(commit.await.unwrap()), "the binding still stands");
    assert_eq!(tails.validation_requests(), 2);
    desktop.close().await;
    w.close().await;
}

/// Sol's worker ruling 4: a validation that fails fails its commit once,
/// committing nothing; nothing retries it on its own. A commit cancelled
/// while it waits for validation committed nothing either, and its retry
/// commits.
#[tokio::test]
async fn a_waiting_commit_fails_or_cancels_without_committing() {
    let (w, desktop, _client, pass) = held_pass().await;
    let tails = w.actor.released_tails();
    let before = cursor_commits(&w.store);
    tails.fail_validations(1);
    let failed = actor_commit(&w, &pass, CancellationToken::new())
        .await
        .unwrap();
    assert!(
        matches!(
            &failed,
            Err(dohc_engine_runtime::RuntimeError::Relay(
                dohc_engine_sync::RelayError::Local(reason)
            )) if reason == "released-tails-unvalidated"
        ),
        "{failed:?}"
    );
    assert_eq!((tails.validation_requests(), tails.validations()), (1, 0));
    assert_eq!(cursor_commits(&w.store), before);

    tails.pause_validation();
    let token = CancellationToken::new();
    let mut commit = actor_commit(&w, &pass, token.clone());
    held_validation(&tails, &mut commit).await;
    token.cancel();
    assert!(matches!(
        commit.await.unwrap(),
        Err(dohc_engine_runtime::RuntimeError::Cancelled)
    ));
    assert_eq!(cursor_commits(&w.store), before);
    tails.resume_validation();
    assert!(committed(
        actor_commit(&w, &pass, CancellationToken::new())
            .await
            .unwrap()
    ));
    assert_eq!(cursor_commits(&w.store), before + 1);
    desktop.close().await;
    w.close().await;
}

/// Sol's worker ruling, close and replacement: closing the workspace while
/// a commit waits cancels its validation off the actor and returns only once
/// the worker and its connection ended. The commit fails as unavailable, and
/// the store's file can be replaced at once.
#[tokio::test]
async fn closing_a_waiting_workspace_releases_its_file() {
    let (mut w, desktop, _client, pass) = held_pass().await;
    let tails = w.actor.released_tails();
    tails.pause_validation();
    let mut commit = actor_commit(&w, &pass, CancellationToken::new());
    held_validation(&tails, &mut commit).await;
    let elsewhere = ScratchDir::new().unwrap();
    drop(std::mem::replace(
        &mut w.store,
        EngineStore::open(&engine_db_path(&elsewhere).unwrap(), 0).unwrap(),
    ));
    w.owner.close().await.unwrap();
    w.supervisor.close_all().unwrap();
    assert!(!tails.validating(), "the worker ended");
    assert!(matches!(
        commit.await.unwrap(),
        Err(dohc_engine_runtime::RuntimeError::ActorUnavailable)
    ));
    let db = engine_db_path(&w.root).unwrap();
    std::fs::rename(&db, db.with_extension("replaced")).expect("no connection holds the store");
    desktop.close().await;
}

/// With nothing retained, a released chain protects nothing: the desktop's
/// fold applies in the window as it does outside it.
#[tokio::test]
async fn with_nothing_retained_a_desktop_fold_applies_in_the_released_window() {
    let mut w = adopted_window(false).await;
    w.release().await;
    execute(
        &mut w.store,
        "UPDATE hosted_replicas SET scope_token='scope'",
    );
    let desktop = desktop_of(&w.base, &w.lineage, &[w.covered_bytes.clone()]).await;
    let edited = format!("{}\nA desktop edit.\n", desktop.file());
    let (fold, bytes) = desktop.fold(&edited).await;
    let feed = HostedFeed::new(&[("object", WINDOW_PATH)]);
    let fold = feed.serve(fold, bytes);
    let client = dohc_engine_sync::RelaySyncClient::new(feed);
    let pass = hosted_pass(
        &mut w.store,
        &client,
        &mut dohc_engine_collab::WriterDocCache::new(),
    );
    assert_eq!(pass.applied, 1, "{:?}", pass.pending_cursor);
    assert!(journaled(&w.store, &fold));
    let projection = |store: &EngineStore| {
        dohc_engine_collab::load_persisted(store, &window_key())
            .unwrap()
            .unwrap()
            .doc
            .project(ContentKind::Richdoc)
            .unwrap()
            .content
    };
    assert!(projection(&w.store).contains("A desktop edit."));
    assert_eq!(projection(&w.store), projection(&desktop.store));
    desktop.close().await;
    w.close().await;
}

/// A change the owner makes to the whole file on the desktop without
/// editing it first: it retires or rebinds the lineage, and journals no
/// `ydoc.update`.
#[derive(Clone, Copy, Debug, PartialEq)]
enum FileChange {
    Delete,
    Rename,
    Binary,
}

const FILE_CHANGES: [FileChange; 3] = [FileChange::Delete, FileChange::Rename, FileChange::Binary];
const RENAMED_PATH: &str = "notes/renamed.md";
const BINARY: &[u8] = &[0, 255, 13, 10];

/// The files under `notes`, with their bytes, but the neighbour's.
fn notes(root: &ScratchDir) -> Vec<(String, Vec<u8>)> {
    let mut files: Vec<_> = std::fs::read_dir(root.path().join("notes"))
        .unwrap()
        .map(|entry| entry.unwrap())
        .map(|entry| {
            (
                entry.file_name().to_string_lossy().into_owned(),
                std::fs::read(entry.path()).unwrap(),
            )
        })
        .filter(|(name, _)| !name.contains("neighbour"))
        .collect();
    files.sort();
    files
}

/// Opus's review of round 4b2i-1a-2, finding 1, with the rename and binary
/// write beside it: in the released window the owner deletes, renames or
/// writes binary bytes over the document on the desktop, so no `ydoc.update`
/// comes first. The host's hosted pull holds the row before it retires or
/// rebinds the lineage, and a neighbour in the same pass applies. Native
/// state, retained records, attribution, the snapshot, settlement evidence
/// and the files stay as they were, nothing is acknowledged, and successor
/// capture finds the document not ready. The delete holds over the owner's
/// own pending work too, and a row with no relay position is refused rather
/// than held at an invented one.
#[tokio::test]
async fn a_desktop_delete_rename_or_binary_write_never_retires_what_a_released_chain_retains() {
    for (change, retained) in [
        (FileChange::Delete, Retained::Carried),
        (FileChange::Delete, Retained::Own),
        (FileChange::Rename, Retained::Carried),
        (FileChange::Binary, Retained::Carried),
    ] {
        let case = format!("{change:?}, {retained:?}");
        let mut w = retained_window(retained).await;
        execute(
            &mut w.store,
            "INSERT INTO hosted_documents(workspace_id,object_id,path,state,scope_generation)
            VALUES ('workspace','neighbour','notes/neighbour.md','ready',1)",
        );
        let desktop = desktop_of(&w.base, &w.lineage, &[]).await;
        let updates = desktop.updates_journaled();
        let (op, bytes) = desktop.change(change).await;
        assert_eq!(desktop.updates_journaled(), updates, "{case}: an update");
        let feed = HostedFeed::new(&[("neighbour", "notes/neighbour.md"), ("object", WINDOW_PATH)]);
        let op = feed.serve(op, bytes.clone());
        let created = feed.create("neighbour", "notes/neighbour.md", "A neighbour.\n");
        let client = dohc_engine_sync::RelaySyncClient::new(feed);
        let (native, rows, files) = (w.native(), document_rows(&w.store), notes(&w.root));
        let unchanged = |w: &RetainedWindow, stage: &str| {
            let persisted = dohc_engine_collab::load_persisted(&w.store, &window_key())
                .unwrap()
                .map(|persisted| hex_sha256(&persisted.doc.encode_full_state()));
            assert_eq!(
                persisted,
                Some(hex_sha256(&native)),
                "{case}, {stage}: native"
            );
            assert!(w.text().contains(RETAINED), "{case}, {stage}: {}", w.text());
            assert_eq!(document_rows(&w.store), rows, "{case}, {stage}: records");
            assert_eq!(notes(&w.root), files, "{case}, {stage}: files");
        };
        let pass = hosted_pass(
            &mut w.store,
            &client,
            &mut dohc_engine_collab::WriterDocCache::new(),
        );
        unchanged(&w, "the pass");
        assert_eq!(pass.applied, 1, "{case}: the neighbour");
        assert!(journaled(&w.store, &created), "{case}");
        assert!(!journaled(&w.store, &op), "{case}: acknowledged");
        assert!(
            stopped_before(&pass, &op),
            "{case}: {:?}",
            pass.pending_cursor
        );
        let committed = client
            .commit_hosted_cursor(
                &mut w.store,
                "workspace",
                pass.pending_cursor.as_ref().unwrap(),
                &ReleasedTails::uncached(),
                &NoFaults,
            )
            .unwrap();
        assert!(
            matches!(committed, dohc_engine_storage::TxnOutcome::Committed(_)),
            "{case}"
        );
        // The hold is the released lineage's, not another wait.
        w.store.put_binary_blob(&bytes).unwrap();
        let held = settled_apply(
            &mut w.store,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &op,
            &NoFaults,
            &dohc_engine_sync::NoLiveLeases,
        );
        assert!(
            matches!(
                held,
                Err(dohc_engine_sync::SyncError::ReleasedLineageUnsettled(_))
            ),
            "{case}: {held:?}"
        );
        unchanged(&w, "the hold");
        let unplaced = dohc_engine_sync::ReplicationEnvelope {
            relay_seq: None,
            ..op.clone()
        };
        let refused = settled_apply(
            &mut w.store,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &unplaced,
            &NoFaults,
            &dohc_engine_sync::NoLiveLeases,
        );
        assert!(
            matches!(
                refused,
                Err(dohc_engine_sync::SyncError::RetryableState {
                    reason: "a row held for a released lineage has no relay sequence"
                })
            ),
            "{case}: {refused:?}"
        );
        unchanged(&w, "no relay position");
        let captured = w
            .actor
            .capture_imported_owner_activation(
                "relay".into(),
                window_key(),
                WINDOW_PATH.into(),
                1_000_000,
                None,
                CancellationToken::new(),
                Arc::new(()),
            )
            .await;
        assert!(captured.is_err(), "{case}: a held document is not ready");
        desktop.close().await;
        w.close().await;
    }
}

/// What a file operation left of the document on a replica: its path, its
/// snapshot's kind, and whether a lineage remains.
fn file_state(store: &EngineStore) -> (Option<String>, Option<String>, bool) {
    store
        .read_with(|conn| {
            conn.query_row(
                "SELECT (SELECT path FROM path_aliases WHERE object_id='object'),
                        (SELECT content_kind FROM snapshots WHERE object_id='object'),
                        EXISTS(SELECT 1 FROM ydoc_docs WHERE object_id='object')",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
        })
        .unwrap()
}

/// Outside the window, and in it with nothing retained, each file operation
/// applies as it did before: a delete retires the lineage, a rename moves
/// the document, and a binary write replaces its text and lineage.
#[tokio::test]
async fn a_desktop_delete_rename_or_binary_write_applies_outside_the_window_or_with_nothing_retained()
 {
    for change in FILE_CHANGES {
        for released in [false, true] {
            let case = format!("{change:?}, released {released}");
            // The host: released with nothing retained, or a hosted replica
            // no activation ever reached.
            let (mut window, mut plain, desktop) = if released {
                let mut w = adopted_window(false).await;
                w.release().await;
                execute(
                    &mut w.store,
                    "UPDATE hosted_replicas SET scope_token='scope'",
                );
                let desktop = desktop_of(&w.base, &w.lineage, &[w.covered_bytes.clone()]).await;
                (Some(w), None, desktop)
            } else {
                let base = owner_source_base();
                let lineage = hex_sha256(&base);
                let mut host = replica_of("origin", &base, &lineage, &[]).await;
                execute(&mut host.store, "INSERT INTO hosted_replicas(workspace_id,scope_generation,created_at_ms,main_cursor,last_outbound_seq,scope_token)
                      VALUES ('workspace',1,0,1,(SELECT COALESCE(MAX(origin_seq),-1) FROM replication_log WHERE origin_id='origin'),'scope');
                    INSERT INTO hosted_documents(workspace_id,object_id,path,state,scope_generation) VALUES ('workspace','object','notes/plan.md','ready',1)");
                let desktop = desktop_of(&base, &lineage, &[]).await;
                (None, Some(host), desktop)
            };
            let store = match (&mut window, &mut plain) {
                (Some(w), _) => &mut w.store,
                (_, Some(host)) => &mut host.store,
                _ => unreachable!(),
            };
            let (op, bytes) = desktop.change(change).await;
            let feed = HostedFeed::new(&[("object", WINDOW_PATH)]);
            let op = feed.serve(op, bytes);
            let client = dohc_engine_sync::RelaySyncClient::new(feed);
            let pass = hosted_pass(
                store,
                &client,
                &mut dohc_engine_collab::WriterDocCache::new(),
            );
            assert_eq!(pass.applied, 1, "{case}: {:?}", pass.pending_cursor);
            assert!(journaled(store, &op), "{case}");
            assert_eq!(
                file_state(store),
                match change {
                    FileChange::Delete => (None, None, false),
                    FileChange::Rename => (Some(RENAMED_PATH.into()), Some("text".into()), true),
                    FileChange::Binary => (Some(WINDOW_PATH.into()), Some("binary".into()), false),
                },
                "{case}"
            );
            assert_eq!(file_state(store), file_state(&desktop.store), "{case}");
            desktop.close().await;
            if let Some(w) = window {
                w.close().await;
            }
            if let Some(host) = plain {
                host.close().await;
            }
        }
    }
}

const NEIGHBOUR_PATH: &str = "notes/neighbour.md";

/// The neighbour, a ready document of the host's scope.
fn add_neighbour(store: &mut EngineStore) {
    execute(
        store,
        "INSERT INTO hosted_documents(workspace_id,object_id,path,state,scope_generation)
        VALUES ('workspace','neighbour','notes/neighbour.md','ready',1)",
    );
}

/// Where the host's scope holds `object_id`.
fn hosted_status(store: &EngineStore, object_id: &str) -> dohc_engine_sync::HostedDocumentStatus {
    dohc_engine_sync::read_hosted_replica(store, "workspace")
        .unwrap()
        .unwrap()
        .documents[object_id]
        .status
        .clone()
}

/// The host commits `pass`'s cursor.
fn commit_pass(
    store: &mut EngineStore,
    client: &dohc_engine_sync::RelaySyncClient<HostedFeed>,
    pass: &dohc_engine_sync::HostedPassOutcome,
) {
    let committed = client
        .commit_hosted_cursor(
            store,
            "workspace",
            pass.pending_cursor.as_ref().unwrap(),
            &ReleasedTails::uncached(),
            &NoFaults,
        )
        .unwrap();
    assert!(matches!(
        committed,
        dohc_engine_storage::TxnOutcome::Committed(_)
    ));
}

/// A safe update of the document over `heads`, another device's row.
fn safe_row(
    heads: &[&[u8]],
    lineage: &str,
    text: &str,
) -> (dohc_engine_sync::ReplicationEnvelope, Vec<u8>) {
    let doc = Ydoc::wire();
    for head in heads {
        doc.apply(head).unwrap();
    }
    let bytes = doc.richdoc_append_paragraph(text);
    (
        ydoc_row("later", &bytes, lineage, WINDOW_PATH, false),
        bytes,
    )
}

/// The host's main cursor.
fn main_cursor(store: &EngineStore) -> i64 {
    dohc_engine_sync::read_hosted_replica(store, "workspace")
        .unwrap()
        .unwrap()
        .main_cursor
}

/// Opus's review of round 4b2i-2, finding 1, the most ordinary path: in the
/// released window the owner types in another paragraph on the desktop and
/// its editor settles. The update only adds content, so it applies and the
/// host writes the head it projects, the retained text with it. The
/// settlement's preimage is then not the host's head, so it would open a
/// sync conflict no host could close. It holds before anything of that
/// conflict is written: no moment, file object or conflict, and the document
/// waits at it, with its later row unapplied, held for released retained
/// work. Nothing else stalls: a neighbour applies, the pass commits, the
/// cursor advances, and the next pass progresses.
#[tokio::test]
async fn a_desktop_edit_in_the_released_window_holds_its_settlement_before_a_conflict() {
    let mut w = retained_window(Retained::Carried).await;
    add_neighbour(&mut w.store);
    let mut desktop = desktop_of(&w.base, &w.lineage, &[]).await;
    let (update, update_bytes) = desktop.append(&w.lineage, "A desktop paragraph").await;
    let (settlement, text) = desktop.settle(&w.lineage).await;
    let feed = HostedFeed::new(&[("neighbour", NEIGHBOUR_PATH), ("object", WINDOW_PATH)]);
    let (later, later_bytes) = safe_row(
        &[&w.native(), &update_bytes],
        &w.lineage,
        "After the settlement",
    );
    let update = feed.serve(update, update_bytes);
    let settlement = feed.serve(settlement, text);
    let later = feed.serve(later, later_bytes);
    let created = feed.create("neighbour", NEIGHBOUR_PATH, "A neighbour.\n");
    let client = dohc_engine_sync::RelaySyncClient::new(feed);
    let pass = hosted_pass(
        &mut w.store,
        &client,
        &mut dohc_engine_collab::WriterDocCache::new(),
    );
    assert_eq!(pass.applied, 2, "{:?}", pass.pending_cursor);
    assert_eq!(pass.conflicts_opened, 0);
    for op in [&update, &created] {
        assert!(journaled(&w.store, op), "{}", op.origin_id);
    }
    for op in [&settlement, &later] {
        assert!(!journaled(&w.store, op), "{}", op.origin_id);
    }
    assert!(held_binding(&pass, &settlement).is_some(), "{pass:?}");
    let written = |store: &EngineStore| {
        store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT (SELECT COUNT(*) FROM conflicts) \
                     + (SELECT COUNT(*) FROM moments WHERE moment_id=?1)",
                    [settlement.payload["momentId"].as_str().unwrap()],
                    |row| row.get::<_, i64>(0),
                )
            })
            .unwrap()
    };
    assert_eq!(written(&w.store), 0, "nothing of the conflict is written");
    let projected = w.text();
    assert!(
        projected.contains("A desktop paragraph")
            && projected.contains(RETAINED)
            && !projected.contains("After the settlement"),
        "{projected}"
    );
    commit_pass(&mut w.store, &client, &pass);
    assert_eq!(main_cursor(&w.store), created.relay_seq.unwrap());
    assert!(matches!(
        hosted_status(&w.store, "object"),
        dohc_engine_sync::HostedDocumentStatus::Held(
            dohc_engine_sync::HostedHold::ReleasedLineageUnsettled { .. }
        )
    ));
    let edited = client.transport().write(
        "neighbour",
        NEIGHBOUR_PATH,
        Some("A neighbour.\n"),
        "A neighbour, edited.\n",
    );
    let again = hosted_pass(
        &mut w.store,
        &client,
        &mut dohc_engine_collab::WriterDocCache::new(),
    );
    assert_eq!(again.applied, 1, "{:?}", again.pending_cursor);
    assert!(journaled(&w.store, &edited));
    assert!(held_binding(&again, &settlement).is_some(), "{again:?}");
    commit_pass(&mut w.store, &client, &again);
    assert_eq!(main_cursor(&w.store), edited.relay_seq.unwrap());
    assert_eq!(written(&w.store), 0);
    assert!(w.text().contains(RETAINED));
    desktop.close().await;
    w.close().await;
}

/// A text write over the host's head that leaves the document at `path` with
/// `text`, from an origin that journaled no `ydoc.update` for it.
fn host_write(
    store: &EngineStore,
    path: &str,
    text: &str,
) -> (dohc_engine_sync::ReplicationEnvelope, Vec<u8>) {
    let (sha, latest, updated): (String, String, i64) = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT blob_sha256,latest_moment_id,updated_at_ms FROM snapshots WHERE object_id='object'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
        })
        .unwrap();
    let op = dohc_engine_sync::ReplicationEnvelope {
        settlement_admission: None,
        admitted_author_snapshot: None,
        workspace_id: "workspace".into(),
        origin_id: "writer".into(),
        origin_seq: 0,
        relay_seq: None,
        op_kind: "moment.append".into(),
        payload: serde_json::json!({
            "momentId": "host-write", "versionId": "main", "objectId": "object",
            "path": path, "recordedAtMs": 2_000, "operation": "write",
            "payloadBeforeBlobSha256": sha, "payloadBeforePath": WINDOW_PATH,
            "payloadAfterBlobSha256": hex_sha256(text.as_bytes()), "payloadAfterPath": path,
            "metadata": {"origin": "sync"}, "beforePresent": "present", "beforeObjectId": "object",
            "beforeVersionId": "main", "beforePath": WINDOW_PATH, "beforeBlobSha256": sha,
            "beforeContentKind": "text", "beforeUpdatedAtMs": updated, "beforeLatestMomentId": latest
        }),
        recorded_at_ms: 2_000,
    };
    (op, text.as_bytes().to_vec())
}

/// Opus's review of round 4b2i-2, finding 1, where the pending reconcile is
/// reached in the window: a bare text moment over the host's head, one the
/// desktop journals with no `ydoc.update`, as a frontmatter edit can. Its
/// text lacks the retained work, so the lineage never projects it, and the
/// moment holds as the released lineage's: unjournaled, with a later row of
/// the document behind it. A neighbour applies, the pass commits, and the
/// next pass still lets the neighbour progress.
#[tokio::test]
async fn a_bare_text_moment_in_the_released_window_holds_only_its_document() {
    let mut w = retained_window(Retained::Carried).await;
    add_neighbour(&mut w.store);
    let file = std::fs::read_to_string(w.root.path().join(WINDOW_PATH)).unwrap();
    let (moment, text) = host_write(
        &w.store,
        WINDOW_PATH,
        &format!("---\ntitle: Plan\n---\n{file}"),
    );
    let feed = HostedFeed::new(&[("neighbour", NEIGHBOUR_PATH), ("object", WINDOW_PATH)]);
    let (later, later_bytes) = safe_row(&[&w.native()], &w.lineage, "After the moment");
    let moment = feed.serve(moment, text.clone());
    let later = feed.serve(later, later_bytes);
    let created = feed.create("neighbour", NEIGHBOUR_PATH, "A neighbour.\n");
    let client = dohc_engine_sync::RelaySyncClient::new(feed);
    let (native, rows, files) = (w.native(), document_rows(&w.store), notes(&w.root));
    let pass = hosted_pass(
        &mut w.store,
        &client,
        &mut dohc_engine_collab::WriterDocCache::new(),
    );
    assert_eq!(pass.applied, 1, "the neighbour");
    assert!(journaled(&w.store, &created));
    assert!(!journaled(&w.store, &moment) && !journaled(&w.store, &later));
    assert!(stopped_before(&pass, &moment), "{:?}", pass.pending_cursor);
    assert!(!pass.has_more, "no work retries hot");
    commit_pass(&mut w.store, &client, &pass);
    assert_eq!(main_cursor(&w.store), created.relay_seq.unwrap());
    assert_eq!(
        hosted_status(&w.store, "object"),
        dohc_engine_sync::HostedDocumentStatus::Held(
            dohc_engine_sync::HostedHold::ReleasedLineageUnsettled {
                binding: Box::new(held_binding(&pass, &moment).unwrap()),
                continuation: dohc_engine_sync::ReleasedHoldContinuation::Frozen,
                binding_stale: false,
            }
        )
    );
    assert_eq!(
        (w.native(), document_rows(&w.store), notes(&w.root)),
        (native.clone(), rows.clone(), files.clone())
    );
    // The hold is the released lineage's, and writes nothing.
    w.store.put_binary_blob(&text).unwrap();
    let held = settled_apply(
        &mut w.store,
        &mut dohc_engine_collab::WriterDocCache::new(),
        &moment,
        &NoFaults,
        &dohc_engine_sync::NoLiveLeases,
    );
    let Err(dohc_engine_sync::SyncError::ReleasedLineageUnsettled(binding)) = held else {
        panic!("{held:?}");
    };
    assert_eq!(binding.current_path.as_deref(), Some(WINDOW_PATH));
    assert_eq!(binding.head_digest, hex_sha256(&native));
    assert_eq!(
        (w.native(), document_rows(&w.store), notes(&w.root)),
        (native.clone(), rows, files)
    );
    let edited = client.transport().write(
        "neighbour",
        NEIGHBOUR_PATH,
        Some("A neighbour.\n"),
        "A neighbour, edited.\n",
    );
    let again = hosted_pass(
        &mut w.store,
        &client,
        &mut dohc_engine_collab::WriterDocCache::new(),
    );
    assert_eq!(again.applied, 1, "{:?}", again.pending_cursor);
    assert!(journaled(&w.store, &edited));
    assert!(
        stopped_before(&again, &moment) && !again.has_more,
        "{again:?}"
    );
    commit_pass(&mut w.store, &client, &again);
    assert_eq!(main_cursor(&w.store), edited.relay_seq.unwrap());
    assert_eq!(w.native(), native);
    assert!(w.text().contains(RETAINED));
    w.close().await;
}

/// Opus's review of round 4b2i-1a-2i, finding 1: a moment decides
/// released-window protection once, before it writes. A protected text write
/// that leaves the document at its path, whose resulting head the lineage
/// does not project, holds with the binding that decision named: the head
/// before the moment, after one validation. On tails that keep nothing, the
/// moment reads the window once.
#[tokio::test]
async fn a_moment_decides_released_window_protection_once() {
    let mut w = retained_window(Retained::Carried).await;
    let file = std::fs::read_to_string(w.root.path().join(WINDOW_PATH)).unwrap();
    let text = format!("---\ntitle: Plan\n---\n{file}");
    let (mut moment, _) = host_write(&w.store, WINDOW_PATH, &text);
    moment.relay_seq = Some(10);
    w.store
        .read_with(|conn| {
            conn.execute(
                "INSERT INTO blobs (sha256,byte_length,text) VALUES (?1,?2,?3)",
                rusqlite::params![hex_sha256(text.as_bytes()), text.len() as i64, text],
            )
        })
        .unwrap();
    let head = hex_sha256(&w.native());
    let held = |store: &mut EngineStore, tails: &ReleasedTails| {
        let held = settled_apply(
            store,
            &mut dohc_engine_collab::WriterDocCache::with_released_tails(tails.clone()),
            &moment,
            &NoFaults,
            &dohc_engine_sync::NoLiveLeases,
        );
        let Err(dohc_engine_sync::SyncError::ReleasedLineageUnsettled(binding)) = held else {
            panic!("{held:?}");
        };
        binding
    };
    let tails = ReleasedTails::default();
    let binding = held(&mut w.store, &tails);
    assert_eq!(binding.head_digest, head, "the head before the moment");
    assert_eq!(binding.current_path.as_deref(), Some(WINDOW_PATH));
    assert_eq!((tails.validation_requests(), tails.validations()), (1, 1));
    let scans = released_tail_scans_on_this_thread();
    let binding = held(&mut w.store, &ReleasedTails::uncached());
    assert_eq!(binding.head_digest, head);
    assert_eq!(
        released_tail_scans_on_this_thread(),
        scans + 1,
        "one decision"
    );
    assert_eq!(hex_sha256(&w.native()), head);
    w.close().await;
}

/// Sol's review of round 4b2i-2, finding 1: on a ready hosted document with
/// nothing retained, a bare text moment whose head the lineage does not
/// project waits for its rewrite. It stops its document alone, with a later
/// row of it behind, as a released lineage's hold does: the neighbour applies,
/// the pass commits, and the next pass still lets the neighbour progress.
#[tokio::test]
async fn a_pending_text_moment_stops_only_its_document() {
    let base = owner_source_base();
    let lineage = hex_sha256(&base);
    let mut host = replica_of("origin", &base, &lineage, &[]).await;
    execute(&mut host.store, "INSERT INTO hosted_replicas(workspace_id,scope_generation,created_at_ms,main_cursor,last_outbound_seq,scope_token)
          VALUES ('workspace',1,0,1,(SELECT COALESCE(MAX(origin_seq),-1) FROM replication_log WHERE origin_id='origin'),'scope');
        INSERT INTO hosted_documents(workspace_id,object_id,path,state,scope_generation) VALUES ('workspace','object','notes/plan.md','ready',1)");
    add_neighbour(&mut host.store);
    let mut desktop = desktop_of(&base, &lineage, &[]).await;
    desktop.append(&lineage, "A desktop paragraph").await;
    // The relay serves the settlement alone: the host never sees its update.
    let (moment, text) = desktop.settle(&lineage).await;
    let feed = HostedFeed::new(&[("neighbour", NEIGHBOUR_PATH), ("object", WINDOW_PATH)]);
    let (later, later_bytes) = safe_row(&[&base], &lineage, "After the moment");
    let moment = feed.serve(moment, text.clone());
    let later = feed.serve(later, later_bytes);
    let created = feed.create("neighbour", NEIGHBOUR_PATH, "A neighbour.\n");
    let client = dohc_engine_sync::RelaySyncClient::new(feed);
    let (head, rows) = (
        dohc_engine_collab::load_persisted(&host.store, &window_key())
            .unwrap()
            .unwrap()
            .doc
            .encode_full_state(),
        document_rows(&host.store),
    );
    let pass = hosted_pass(
        &mut host.store,
        &client,
        &mut dohc_engine_collab::WriterDocCache::new(),
    );
    assert_eq!(pass.applied, 1, "the neighbour");
    assert!(journaled(&host.store, &created));
    assert!(!journaled(&host.store, &moment) && !journaled(&host.store, &later));
    assert!(waits_before(&pass, &moment), "{:?}", pass.pending_cursor);
    assert!(!pass.has_more, "no work retries hot");
    commit_pass(&mut host.store, &client, &pass);
    assert_eq!(
        hosted_status(&host.store, "object"),
        dohc_engine_sync::HostedDocumentStatus::Held(dohc_engine_sync::HostedHold::WorkWaiting)
    );
    assert_eq!(document_rows(&host.store), rows);
    // It waits for its rewrite, not for a released lineage.
    host.store.put_binary_blob(&text).unwrap();
    let pending = settled_apply(
        &mut host.store,
        &mut dohc_engine_collab::WriterDocCache::new(),
        &moment,
        &NoFaults,
        &dohc_engine_sync::NoLiveLeases,
    );
    assert!(
        matches!(
            pending,
            Err(dohc_engine_sync::SyncError::RetryableState {
                reason: "ydoc-resulting-head-pending"
            })
        ),
        "{pending:?}"
    );
    let edited = client.transport().write(
        "neighbour",
        NEIGHBOUR_PATH,
        Some("A neighbour.\n"),
        "A neighbour, edited.\n",
    );
    let again = hosted_pass(
        &mut host.store,
        &client,
        &mut dohc_engine_collab::WriterDocCache::new(),
    );
    assert_eq!(again.applied, 1, "{:?}", again.pending_cursor);
    assert!(journaled(&host.store, &edited));
    assert!(
        waits_before(&again, &moment) && !again.has_more,
        "{again:?}"
    );
    commit_pass(&mut host.store, &client, &again);
    let persisted = dohc_engine_collab::load_persisted(&host.store, &window_key())
        .unwrap()
        .unwrap()
        .doc
        .encode_full_state();
    assert_eq!(persisted, head);
    desktop.close().await;
    host.close().await;
}

/// Sol's review of round 4b2i-2, finding 2: a text write that moves the
/// document rebinds it as a rename does, whatever its text. With the text the
/// host's lineage projects, and with other text, the write holds before any
/// write, the protected state stays as it was, and a neighbour applies.
#[tokio::test]
async fn a_text_write_that_moves_the_document_holds_in_the_released_window() {
    for equal in [true, false] {
        let case = if equal {
            "projected text"
        } else {
            "other text"
        };
        let mut w = retained_window(Retained::Carried).await;
        add_neighbour(&mut w.store);
        let text = if equal {
            w.text()
        } else {
            "Moved elsewhere.\n".to_owned()
        };
        let (op, bytes) = host_write(&w.store, RENAMED_PATH, &text);
        let feed = HostedFeed::new(&[("neighbour", NEIGHBOUR_PATH), ("object", WINDOW_PATH)]);
        let op = feed.serve(op, bytes.clone());
        let created = feed.create("neighbour", NEIGHBOUR_PATH, "A neighbour.\n");
        let client = dohc_engine_sync::RelaySyncClient::new(feed);
        let (native, rows, files) = (w.native(), document_rows(&w.store), notes(&w.root));
        let pass = hosted_pass(
            &mut w.store,
            &client,
            &mut dohc_engine_collab::WriterDocCache::new(),
        );
        assert_eq!(pass.applied, 1, "{case}: the neighbour");
        assert!(journaled(&w.store, &created), "{case}");
        assert!(!journaled(&w.store, &op), "{case}: acknowledged");
        assert!(
            stopped_before(&pass, &op),
            "{case}: {:?}",
            pass.pending_cursor
        );
        commit_pass(&mut w.store, &client, &pass);
        w.store.put_binary_blob(&bytes).unwrap();
        let held = settled_apply(
            &mut w.store,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &op,
            &NoFaults,
            &dohc_engine_sync::NoLiveLeases,
        );
        let Err(dohc_engine_sync::SyncError::ReleasedLineageUnsettled(binding)) = held else {
            panic!("{case}: {held:?}");
        };
        assert_eq!(binding.current_path.as_deref(), Some(WINDOW_PATH), "{case}");
        assert_eq!(w.native(), native, "{case}: native");
        assert!(w.text().contains(RETAINED), "{case}: {}", w.text());
        assert_eq!(document_rows(&w.store), rows, "{case}: records");
        assert_eq!(notes(&w.root), files, "{case}: files");
        w.close().await;
    }
}
