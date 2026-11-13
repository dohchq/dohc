use crate::support;

use dohc_engine_collab::live_object_binding::LiveObjectBinding;
use dohc_engine_collab::live_update_application::*;
use dohc_engine_collab::{ContentKind, Ydoc};
use dohc_engine_domain::AgentDeclaration;
use dohc_engine_runtime::actor::{ActorLiveApplicationHandle, ActorLiveApplicationOwner};
use dohc_engine_runtime::{RuntimeError, WorkspaceSupervisor};
use dohc_engine_storage::{
    EngineStore, FaultAction, FaultInjector, FaultPoint, NoFaults, hex_sha256,
};
use dohc_engine_testkit::{ScratchDir, engine_db_path};
use std::path::PathBuf;
use std::sync::Arc;

struct Fixture {
    root: ScratchDir,
    db: PathBuf,
    supervisor: WorkspaceSupervisor,
    owner: ActorLiveApplicationOwner,
    handle: ActorLiveApplicationHandle,
    binding: LiveObjectBinding,
    doc: Ydoc,
}

fn restore_coordinate() -> ApplicationHostCoordinate {
    ApplicationHostCoordinate {
        host_id: "host".into(),
        host_epoch: 1,
        instance_id: "instance".into(),
        connection_id: "connection".into(),
    }
}

async fn applied_restore(
    f: &Fixture,
    terminal: Option<LiveUpdateReceipt>,
    sequence: i64,
) -> NativeRestoreApplication {
    let point = Ydoc::wire();
    let reader = f.doc.has_reader_source();
    let baseline = if reader {
        let vector: serde_json::Value = serde_json::from_str(include_str!(
            "../../dohc-engine-collab/tests/reader-restore.json"
        ))
        .unwrap();
        serde_json::from_value(vector["pointStateBytes"].clone()).unwrap()
    } else {
        vector("rich-unicode")
    };
    point.apply(&baseline).unwrap();
    let projection = point.project(ContentKind::Richdoc).unwrap().content;
    let markdown = if reader {
        point
            .markdown_source(&point.markdown_source_reference().unwrap())
            .unwrap()
    } else {
        projection.clone()
    };
    let fence = f
        .owner
        .fence_restore(
            NativeRestoreFence {
                point: dohc_engine_collab::live_update_application::NativeRestoreSelection {
                    journal_cursor: 0,
                    receipt_digest: f.binding.lineage_claim_id.clone(),
                },
                operation_id: "restore-settlement".into(),
                relay_database_namespace: "relay".into(),
                old_binding: f.binding.clone(),
                host_id: "host".into(),
                new_fence: 1,
                origin: RestoreDeliveryOrigin::Bootstrap {
                    id: "bootstrap".into(),
                },
                terminal,
                applied_sequence: sequence,
            },
            restore_coordinate(),
            20,
            Arc::new(NoFaults),
        )
        .await
        .unwrap();
    let preparation = NativeRestorePreparation {
        fence,
        point: NativeRestorePoint {
            journal_cursor: 0,
            receipt_digest: f.binding.lineage_claim_id.clone(),
            markdown_digest: hex_sha256(markdown.as_bytes()),
            projection_digest: hex_sha256(projection.as_bytes()),
        },
    };
    let proposal = f
        .owner
        .prepare_restore(
            preparation.clone(),
            restore_coordinate(),
            2_000_000,
            100,
            Arc::new(NoFaults),
            Arc::new(()),
        )
        .await
        .unwrap();
    let mut binding = f.binding.clone();
    binding.restore_fence_generation = 1;
    let input = NativeRestoreApplication {
        preparation,
        candidate_digest: proposal.receipt().candidate_digest.clone(),
        native_source_manifest_digest: proposal.receipt().native_source_manifest_digest.clone(),
        admitted: AdmittedLiveUpdateMetadata {
            accepted: RelayAcceptedLiveUpdate {
                receipt: LiveUpdateReceipt {
                    delivery_id: "restore-delivery".into(),
                    update_digest: proposal.receipt().candidate_digest.clone(),
                    journal_cursor: 71,
                    accepting_host_epoch: 1,
                },
                binding,
                authority: ServerDerivedLiveUpdateAuthority::Owner {
                    principal_id: "owner".into(),
                },
                received_at_ms: 21,
            },
            first_seen: proposal.receipt().replacement_ranges.clone(),
            canonical_version: Some(2),
            author_snapshot: Some(vec![]),
            first_seen_deletes: Some(vec![]),
            checkpoint_coverage: None,
        },
    };
    f.owner
        .apply_restore(
            input.clone(),
            restore_coordinate(),
            2_000_000,
            100,
            22,
            Arc::new(NoFaults),
            Arc::new(()),
        )
        .await
        .unwrap();
    input
}

async fn settle_restore(
    f: &Fixture,
    input: NativeRestoreApplication,
    faults: Arc<dyn FaultInjector>,
) -> Result<LiveSettlementResult, RuntimeError> {
    f.owner
        .settle_restore(
            input,
            restore_coordinate(),
            2_000_000,
            100,
            f.root.path().to_owned(),
            30,
            faults,
            tokio_util::sync::CancellationToken::new(),
            Arc::new(()),
        )
        .await
}

#[tokio::test]
async fn restore_settlement_replays_real_projection_commit_and_materialization_crashes() {
    for fault in [
        FaultPoint::StorageBeforePersist,
        FaultPoint::StorageAfterCommitBeforeAck,
        FaultPoint::MaterializeAfterJobCommit,
        FaultPoint::MaterializeAfterRenameBeforeComplete,
    ] {
        let f = Fixture::new().await;
        let input = applied_restore(&f, None, 0).await;
        let _interrupted = settle_restore(&f, input.clone(), Arc::new(Crash(fault))).await;
        let result = settle_restore(&f, input.clone(), Arc::new(NoFaults))
            .await
            .unwrap();
        assert!(result.materialized, "{fault:?}");
        assert_eq!(
            result.markdown_digest,
            input.preparation.point.markdown_digest
        );
        assert_eq!(f.counts(), (1, 2));
        assert_eq!(
            std::fs::read(f.root.path().join(&f.binding.current_path))
                .map(|bytes| hex_sha256(&bytes))
                .unwrap(),
            result.markdown_digest
        );
        assert_eq!(
            settle_restore(&f, input, Arc::new(NoFaults))
                .await
                .unwrap()
                .settlement_id,
            result.settlement_id
        );
        assert_eq!(f.counts(), (1, 2));
    }
}

#[tokio::test]
async fn restore_settlement_refuses_wrong_host_budget_cancel_and_changed_admission_before_write() {
    let f = Fixture::new().await;
    let input = applied_restore(&f, None, 0).await;
    for variant in 0..5 {
        let mut attempted = input.clone();
        let mut coordinate = restore_coordinate();
        let mut max_bytes = 2_000_000;
        let mut max_events = 100;
        let cancel = tokio_util::sync::CancellationToken::new();
        match variant {
            0 => coordinate.host_id = "foreign-host".into(),
            1 => max_bytes = 1,
            2 => max_events = 0,
            3 => cancel.cancel(),
            4 => attempted.admitted.accepted.received_at_ms += 1,
            _ => unreachable!(),
        }
        assert!(
            f.owner
                .settle_restore(
                    attempted,
                    coordinate,
                    max_bytes,
                    max_events,
                    f.root.path().to_owned(),
                    30,
                    Arc::new(NoFaults),
                    cancel,
                    Arc::new(())
                )
                .await
                .is_err()
        );
        assert_eq!(f.counts(), (0, 1));
        assert!(!f.root.path().join(&f.binding.current_path).exists());
    }
    assert!(
        settle_restore(&f, input, Arc::new(NoFaults))
            .await
            .unwrap()
            .materialized
    );
}

fn vector(name: &str) -> Vec<u8> {
    let fixtures: serde_json::Value = serde_json::from_str(include_str!(
        "../../dohc-engine-collab/tests/live-bootstrap-fixtures/live-bootstrap.json"
    ))
    .unwrap();
    serde_json::from_value(
        fixtures
            .as_array()
            .unwrap()
            .iter()
            .find(|v| v["name"] == name)
            .unwrap()["bytes"]
            .clone(),
    )
    .unwrap()
}

impl Fixture {
    async fn new() -> Self {
        Self::with_relay(false).await
    }
    async fn with_relay(replicates: bool) -> Self {
        Self::build(
            replicates,
            vector("rich-unicode"),
            "notes/example.md",
            |_| {},
        )
        .await
    }
    /// Bootstrap `bytes` as the live document at `path`, after `seed`
    /// writes the store.
    async fn build(
        replicates: bool,
        bytes: Vec<u8>,
        path: &str,
        seed: impl FnOnce(&mut EngineStore),
    ) -> Self {
        let root = ScratchDir::new().unwrap();
        let db = engine_db_path(&root).unwrap();
        let mut store = EngineStore::open(&db, 0).unwrap();
        dohc_engine_domain::VersionedTextStore::new(&mut store)
            .ensure_main_version("workspace", "main", 0, &NoFaults)
            .unwrap();
        if replicates {
            dohc_engine_sync::journal_local_replication_op(
                &mut store,
                "workspace",
                "owner-origin",
                "epoch",
                "stream",
                "workspace.init",
                &serde_json::json!({}),
                0,
                &NoFaults,
            )
            .unwrap();
            dohc_engine_sync::commit_relay_cursor(
                &mut store,
                "workspace",
                &dohc_engine_sync::RelayCursor {
                    bootstrap_complete: true,
                    cursor: 0,
                    replication_epoch: "epoch".into(),
                    stream_identity: "stream".into(),
                    settlement_report_id: None,
                    ordinary_pull: None,
                },
                &NoFaults,
                &dohc_engine_sync::NoLiveLeases,
                0,
            )
            .unwrap();
        }
        seed(&mut store);
        drop(store);
        let supervisor = WorkspaceSupervisor::new();
        let actor = supervisor.open(&db, 1).unwrap().actor;
        support::configure_witness_reader(&actor, &root).await;
        let owner = actor
            .live_application_owner("workspace".into())
            .await
            .unwrap();
        let doc = Ydoc::wire();
        doc.apply(&bytes).unwrap();
        let markdown = if doc.has_reader_source() {
            let config =
                serde_json::from_str(&std::env::var("DOHC_ENGINE_READER_CONFIG").unwrap()).unwrap();
            actor
                .configure_reader_resolver(Arc::new(
                    dohc_engine_collab::reader_resolver::ReaderResolver::new(Arc::new(
                        dohc_engine_reader::Reader::new(Some(config)),
                    )),
                ))
                .await
                .unwrap();
            doc.markdown_source(&doc.markdown_source_reference().unwrap())
                .unwrap()
        } else {
            doc.project(ContentKind::Richdoc).unwrap().content
        };
        let binding = LiveObjectBinding {
            workspace_id: "workspace".into(),
            main_version_id: "main".into(),
            object_id: "object".into(),
            lineage_claim_id: hex_sha256(&bytes),
            current_path: path.into(),
            selector_paths: vec![path.into()],
            restore_fence_generation: 0,
        };
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
        let input = LiveApplicationBootstrap {
            bootstrap_id: "bootstrap".into(),
            bootstrap_moment_id: "bootstrap-moment".into(),
            baseline_moment_relay_sequence: 0,
            baseline_registered_at_ms: 1,
            baseline_digest: hex_sha256(&bytes),
            baseline_byte_length: bytes.len() as i64,
            projected_markdown_digest: hex_sha256(markdown.as_bytes()),
            projected_markdown_byte_length: markdown.len() as i64,
        };
        assert!(matches!(
            handle
                .bootstrap(
                    input,
                    bytes,
                    root.path().to_owned(),
                    Arc::new(NoFaults),
                    None
                )
                .await
                .unwrap(),
            BootstrapResult::Bootstrapped(_)
        ));
        Self {
            root,
            db,
            supervisor,
            owner,
            handle,
            binding,
            doc,
        }
    }
    async fn settle(
        &self,
        terminal: Option<LiveUpdateReceipt>,
        max: usize,
        faults: Arc<dyn FaultInjector>,
    ) -> Result<LiveSettlementResult, RuntimeError> {
        self.handle
            .settle(
                terminal,
                max,
                self.root.path().to_owned(),
                10,
                faults,
                tokio_util::sync::CancellationToken::new(),
                dohc_engine_collab::live_update_application::AdmittedNativeHistoryReconstruction {
                    policy:
                        dohc_engine_collab::live_update_application::NativeHistoryReconstruction {
                            working_reserve_bytes: 8 * 1024 * 1024,
                        },
                    reservation: Arc::new(()),
                },
            )
            .await
    }
    async fn apply(&self, cursor: i64, bytes: Vec<u8>) -> LiveUpdateReceipt {
        self.apply_as(
            cursor,
            bytes,
            ServerDerivedLiveUpdateAuthority::Owner {
                principal_id: "owner".into(),
            },
            2,
        )
        .await
    }
    async fn apply_as(
        &self,
        cursor: i64,
        bytes: Vec<u8>,
        authority: ServerDerivedLiveUpdateAuthority,
        received_at_ms: i64,
    ) -> LiveUpdateReceipt {
        let (receipt, result) = self
            .apply_declared(cursor, bytes, authority, received_at_ms, None)
            .await;
        assert!(matches!(result, ApplicationResult::Applied(..)));
        receipt
    }
    async fn apply_declared(
        &self,
        cursor: i64,
        bytes: Vec<u8>,
        authority: ServerDerivedLiveUpdateAuthority,
        received_at_ms: i64,
        agent_declaration: Option<AgentDeclaration>,
    ) -> (LiveUpdateReceipt, ApplicationResult) {
        self.apply_declared_with_content(
            cursor,
            bytes,
            authority,
            received_at_ms,
            (agent_declaration, (vec![], vec![])),
        )
        .await
    }
    async fn apply_declared_with_content(
        &self,
        cursor: i64,
        bytes: Vec<u8>,
        authority: ServerDerivedLiveUpdateAuthority,
        received_at_ms: i64,
        authorship: (Option<AgentDeclaration>, FirstSeen),
    ) -> (LiveUpdateReceipt, ApplicationResult) {
        let (agent_declaration, (first_seen, first_seen_deletes)) = authorship;
        self.doc.apply(&bytes).unwrap();
        let receipt = LiveUpdateReceipt {
            delivery_id: format!("delivery-{cursor}"),
            update_digest: hex_sha256(&bytes),
            journal_cursor: cursor,
            accepting_host_epoch: 1,
        };
        let event = AdmittedLiveUpdate {
            metadata: AdmittedLiveUpdateMetadata {
                accepted: RelayAcceptedLiveUpdate {
                    receipt: receipt.clone(),
                    binding: self.binding.clone(),
                    authority,
                    received_at_ms,
                },
                first_seen,
                canonical_version: Some(2),
                author_snapshot: Some(
                    (agent_declaration)
                        .into_iter()
                        .map(dohc_engine_collab::live_update_application::LiveAuthorEntry::from)
                        .collect(),
                ),
                first_seen_deletes: Some(first_seen_deletes),
                checkpoint_coverage: None,
            },
            update_bytes: bytes,
        };
        let result = self
            .handle
            .apply(event, Arc::new(NoFaults), 100_000_000)
            .await
            .unwrap();
        (receipt, result)
    }

    fn counts(&self) -> (i64, i64) {
        self.read(|db|db.query_row("SELECT (SELECT COUNT(*) FROM live_device_settlements),(SELECT COUNT(*) FROM moments)",[],|r|Ok((r.get(0)?,r.get(1)?))).unwrap())
    }
    fn read<T>(&self, f: impl FnOnce(&rusqlite::Connection) -> T) -> T {
        let db = rusqlite::Connection::open_with_flags(
            &self.db,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .unwrap();
        f(&db)
    }
    fn assert_projection(&self) {
        let markdown = self.doc.project(ContentKind::Richdoc).unwrap().content;
        assert_eq!(
            std::fs::read_to_string(self.root.path().join(&self.binding.current_path)).unwrap(),
            markdown
        );
        self.read(|db| {
            let count:i64=db.query_row("SELECT COUNT(*) FROM engine_search_files_fts WHERE object_id='object' AND text=?1",[&markdown],|r|r.get(0)).unwrap();assert_eq!(count,1);
            let hash:String=db.query_row("SELECT blob_sha256 FROM snapshots WHERE object_id='object'",[],|r|r.get(0)).unwrap();assert_eq!(hash,hex_sha256(markdown.as_bytes()));
        });
    }
}

fn owner_authority() -> ServerDerivedLiveUpdateAuthority {
    ServerDerivedLiveUpdateAuthority::Owner {
        principal_id: "owner".into(),
    }
}

fn agent(agent_id: &str, on_behalf_of: &str) -> Option<AgentDeclaration> {
    Some(AgentDeclaration {
        agent_id: agent_id.into(),
        on_behalf_of: Some(on_behalf_of.into()),
        depth: 1,
    })
}

/// The struct and delete ranges a delivery adds, as the relay names them.
type FirstSeen = (Vec<LiveUpdateStructRange>, Vec<LiveUpdateStructRange>);

/// Makes `change` against `doc` and names what the relay, holding `doc`'s
/// state, finds new in it.
fn relay_edit(doc: &Ydoc, change: impl FnOnce(&Ydoc) -> Vec<u8>) -> (Vec<u8>, FirstSeen) {
    let accepted = Ydoc::wire();
    accepted.apply(&doc.encode_full_state()).unwrap();
    let bytes = change(doc);
    let seen = first_seen_for_test(&accepted, &bytes);
    (bytes, seen)
}

/// The authors the latest settlement moment names.
fn latest_authors(f: &Fixture) -> serde_json::Value {
    f.read(|db| {
        db.query_row(
            "SELECT author_json FROM moments ORDER BY moment_order DESC LIMIT 1",
            [],
            |r| r.get::<_, Option<String>>(0),
        )
        .unwrap()
    })
    .map_or(serde_json::Value::Null, |json| {
        serde_json::from_str(&json).unwrap()
    })
}

/// An update that only removes the body's last block: no new structs.
fn delete_last_block(doc: &Ydoc) -> Vec<u8> {
    use yrs::updates::decoder::Decode;
    use yrs::{ReadTxn, Transact, XmlFragment};
    let local = yrs::Doc::new();
    local
        .transact_mut()
        .apply_update(yrs::Update::decode_v1(&doc.encode_full_state()).unwrap())
        .unwrap();
    let before = local.transact().state_vector();
    let body = local.get_or_insert_xml_fragment("body");
    {
        let mut txn = local.transact_mut();
        let len = body.len(&txn);
        body.remove_range(&mut txn, len - 1, 1);
    }
    local.transact().encode_state_as_update_v1(&before)
}

/// A live settlement names the agents the owner declared for the deliveries
/// it covers and the collaborator the relay accepted a delivery from. The
/// owner's undeclared delivery names no author, so the interval keeps an
/// unattributed gap. A delete-only edit with no new structs counts too. The
/// next interval names only its own.
#[tokio::test]
async fn live_settlement_names_declared_agents_of_its_exact_interval() {
    fn paragraph(doc: &Ydoc, text: &str) -> (Vec<u8>, FirstSeen) {
        relay_edit(doc, |doc| doc.richdoc_append_paragraph(text))
    }
    let f = Fixture::new().await;
    f.settle(None, 100, Arc::new(NoFaults)).await.unwrap();
    let (added, ranges) = paragraph(&f.doc, "Agent paragraph");
    let (_, result) = f
        .apply_declared_with_content(
            3,
            added,
            owner_authority(),
            2,
            (agent("trip-agent âœˆ", "owner"), ranges),
        )
        .await;
    assert!(matches!(result, ApplicationResult::Applied(..)));
    let (bytes, ranges) = paragraph(&f.doc, "Owner paragraph");
    let (_, result) = f
        .apply_declared_with_content(4, bytes, owner_authority(), 2, (None, ranges))
        .await;
    assert!(matches!(result, ApplicationResult::Applied(..)));
    let (bytes, ranges) = paragraph(&f.doc, "Friend paragraph");
    let (terminal, result) = f
        .apply_declared_with_content(
            5,
            bytes,
            ServerDerivedLiveUpdateAuthority::Named {
                principal_id: "friend".into(),
                grant_id: "grant".into(),
                grant_generation: 1,
            },
            2,
            (None, ranges),
        )
        .await;
    assert!(matches!(result, ApplicationResult::Applied(..)));
    f.settle(Some(terminal), 100, Arc::new(NoFaults))
        .await
        .unwrap();
    assert_eq!(
        latest_authors(&f),
        serde_json::json!([
            {"kind":"agent","agentId":"trip-agent âœˆ","onBehalfOf":"owner","depth":1},
            {"kind":"named","userId":"friend","grantId":"grant","grantGeneration":1},
            {"kind":"unattributed"},
        ])
    );
    let vector = f.doc.encode_state_vector();
    let (removed, ranges) = relay_edit(&f.doc, delete_last_block);
    assert!(
        ranges.0.is_empty() && !ranges.1.is_empty(),
        "the edit only deletes"
    );
    let (terminal, result) = f
        .apply_declared_with_content(
            6,
            removed,
            owner_authority(),
            3,
            (agent("cleanup-agent", "owner"), ranges),
        )
        .await;
    assert!(matches!(result, ApplicationResult::Applied(..)));
    assert_eq!(f.doc.encode_state_vector(), vector, "the edit only deletes");
    f.settle(Some(terminal), 100, Arc::new(NoFaults))
        .await
        .unwrap();
    assert_eq!(
        latest_authors(&f),
        serde_json::json!([{"kind":"agent","agentId":"cleanup-agent","onBehalfOf":"owner","depth":1}])
    );
    f.assert_projection();
}

/// A delivery whose agent the next settlement could not name within the
/// moment's author bounds waits for that settlement instead of being
/// truncated. After it, the same delivery applies.
#[tokio::test]
async fn declared_agent_past_the_author_bound_waits_for_settlement() {
    let f = Fixture::new().await;
    f.settle(None, 100, Arc::new(NoFaults)).await.unwrap();
    // Escaped quotes make each author entry as large as the contract allows.
    let large = |index: usize| {
        let mut declared = agent(&format!("{index:03}{}", "\"".repeat(509)), "owner").unwrap();
        declared.on_behalf_of = Some("\"".repeat(512));
        Some(declared)
    };
    let mut terminal = None;
    let mut refused = None;
    for index in 0..80 {
        let (bytes, ranges) = relay_edit(&f.doc, |doc| {
            doc.richdoc_append_paragraph(&format!("p{index}"))
        });
        let cursor = index as i64 + 3;
        let (receipt, result) = f
            .apply_declared_with_content(
                cursor,
                bytes.clone(),
                owner_authority(),
                2,
                (large(index), ranges.clone()),
            )
            .await;
        match result {
            ApplicationResult::Applied(..) => terminal = Some(receipt),
            ApplicationResult::Pending(ApplicationPending::SettlementRequired) => {
                refused = Some((index, cursor, bytes, ranges));
                break;
            }
            other => panic!("unexpected {other:?}"),
        }
    }
    let (index, cursor, bytes, ranges) = refused.expect("the author bound refuses a delivery");
    assert!(index > 1);
    f.read(|db| {
        let applied: i64 = db
            .query_row(
                "SELECT count(*) FROM live_device_update_applications WHERE journal_cursor=?1",
                [cursor],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(applied, 0, "a refused delivery writes nothing");
    });
    f.settle(terminal, 100, Arc::new(NoFaults)).await.unwrap();
    let named = latest_authors(&f);
    assert_eq!(named.as_array().unwrap().len(), index);
    assert!(named.to_string().len() <= dohc_engine_domain::MAX_AUTHOR_JSON_BYTES);
    let (terminal, result) = f
        .apply_declared_with_content(cursor, bytes, owner_authority(), 2, (large(index), ranges))
        .await;
    assert!(matches!(result, ApplicationResult::Applied(..)));
    f.settle(Some(terminal), 100, Arc::new(NoFaults))
        .await
        .unwrap();
    assert_eq!(latest_authors(&f).as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn live_settlement_history_syncs_after_restore_without_granting_native_authority() {
    use dohc_engine_sync::{
        ApplyDisposition, BlobContent, BlobHydration, NoLiveLeases, SyncError,
        apply_replication_envelope, hydrate_blob_content,
    };
    use yrs::updates::decoder::Decode;
    let f = Fixture::with_relay(true).await;
    let first = f.settle(None, 100, Arc::new(NoFaults)).await.unwrap();
    // The first baseline covers no accepted edit, so it journals nothing.
    assert_eq!(first.settlement_id, None);
    let expected = std::fs::read(f.root.path().join(&f.binding.current_path)).unwrap();
    let before = yrs::StateVector::decode_v1(&f.doc.encode_state_vector()).unwrap();
    let update = f
        .doc
        .rewrite_content_to_markdown_preserving_source(ContentKind::Richdoc, "# Later\n")
        .unwrap();
    let mut first_seen = Vec::new();
    let after = yrs::StateVector::decode_v1(&f.doc.encode_state_vector()).unwrap();
    for (client, end) in after.iter() {
        let start = before.get(client);
        if *end > start {
            first_seen.push(LiveUpdateStructRange {
                client_id: i64::try_from(client.get()).unwrap(),
                start_clock: i64::from(start),
                end_clock: i64::from(*end),
            });
        }
    }
    first_seen.sort_by_key(|range| range.client_id);
    assert!(!first_seen.is_empty());
    let terminal = LiveUpdateReceipt {
        delivery_id: "link-delivery".into(),
        update_digest: hex_sha256(&update),
        journal_cursor: 7,
        accepting_host_epoch: 1,
    };
    let metadata = AdmittedLiveUpdateMetadata {
        accepted: RelayAcceptedLiveUpdate {
            receipt: terminal.clone(),
            binding: f.binding.clone(),
            authority: ServerDerivedLiveUpdateAuthority::Link {
                principal_id: "link-principal".into(),
                grant_id: "link-grant".into(),
                grant_generation: 1,
            },
            received_at_ms: 2,
        },
        first_seen,
        canonical_version: None,
        author_snapshot: None,
        first_seen_deletes: None,
        checkpoint_coverage: None,
    };
    assert!(matches!(
        f.handle
            .apply(
                AdmittedLiveUpdate {
                    metadata: metadata.clone(),
                    update_bytes: update,
                },
                Arc::new(NoFaults),
                100_000_000
            )
            .await
            .unwrap(),
        ApplicationResult::Applied(..)
    ));
    let second = f
        .settle(Some(terminal.clone()), 100, Arc::new(NoFaults))
        .await
        .unwrap();
    // The relay has not acknowledged either settlement moment. Their
    // before-images publish only while this generation is current.
    let fence_state = |f: &Fixture| {
        f.read(|db| {
            db.query_row(
                "SELECT (SELECT count(*) FROM live_restore_fences),(SELECT available FROM live_device_application_bindings),(SELECT restore_fence_generation FROM live_device_application_bindings)",
                [],
                |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?)),
            )
            .unwrap()
        })
    };
    assert_eq!(fence_state(&f), (0, 1, 0));
    assert!(matches!(
        f.owner
            .fence_restore(
                NativeRestoreFence {
                    point: dohc_engine_collab::live_update_application::NativeRestoreSelection {
                        journal_cursor: 0,
                        receipt_digest: f.binding.lineage_claim_id.clone()
                    },
                    operation_id: "restore-settlement".into(),
                    relay_database_namespace: "relay".into(),
                    old_binding: f.binding.clone(),
                    host_id: "host".into(),
                    new_fence: 1,
                    origin: RestoreDeliveryOrigin::Bootstrap {
                        id: "bootstrap".into(),
                    },
                    terminal: Some(terminal.clone()),
                    applied_sequence: 1,
                },
                restore_coordinate(),
                20,
                Arc::new(NoFaults),
            )
            .await,
        Err(RuntimeError::LiveApplication(
            ApplicationError::PublicationPending
        ))
    ));
    assert_eq!(fence_state(&f), (0, 1, 0));
    // Ordinary publication reaches the relay: it acknowledges the local
    // origin through the journal's high-water mark, as a completed push does.
    rusqlite::Connection::open(&f.db)
        .unwrap()
        .execute(
            "INSERT INTO sync_relay_push_state (workspace_id,origin_id,pushed_seq) SELECT workspace_id,origin_id,max(origin_seq) FROM replication_log WHERE workspace_id='workspace' AND origin_id='owner-origin' GROUP BY workspace_id,origin_id ON CONFLICT(workspace_id,origin_id) DO UPDATE SET pushed_seq=MAX(pushed_seq,excluded.pushed_seq)",
            [],
        )
        .unwrap();
    let restore = applied_restore(&f, Some(terminal), 1).await;
    let final_settlement = settle_restore(&f, restore.clone(), Arc::new(NoFaults))
        .await
        .unwrap();
    assert_eq!(
        settle_restore(&f, restore, Arc::new(NoFaults))
            .await
            .unwrap()
            .settlement_id,
        final_settlement.settlement_id
    );
    assert_eq!(
        std::fs::read(f.root.path().join(&f.binding.current_path)).unwrap(),
        expected
    );
    f.supervisor.close(&f.db).unwrap();
    let mut source = EngineStore::open(&f.db, 40).unwrap();
    let final_content_digest: String = source
        .read_with(|conn| {
            conn.query_row(
                "SELECT json_extract(proposal_json,'$.finalContentDigest') FROM live_restore_fences WHERE operation_id='restore-settlement'",
                [],
                |row| row.get(0),
            )
        })
        .unwrap();
    assert_ne!(final_content_digest, hex_sha256(&expected));
    let key = dohc_engine_collab::DocKey::new("workspace", "main", "object").unwrap();
    assert!(matches!(
        dohc_engine_collab::maybe_compact(&mut source, &key, 0, &NoFaults, 40).unwrap(),
        dohc_engine_storage::TxnOutcome::Committed(dohc_engine_collab::CompactOutcome::Compacted { pruned_updates, .. }) if pruned_updates > 0
    ));
    let ops = dohc_engine_sync::list_replication_ops(&source, "workspace", "owner-origin", -1, 500)
        .unwrap();
    for settlement in [&second, &final_settlement] {
        let moments: Vec<_> = ops
            .iter()
            .filter(|op| {
                op.op_kind == "moment.append" && op.payload["momentId"] == settlement.moment_id
            })
            .collect();
        assert_eq!(
            moments.len(),
            1,
            "settled files must reach share viewers once"
        );
        assert_eq!(
            moments[0].payload["payloadAfterBlobSha256"],
            settlement.markdown_digest
        );
        assert_eq!(
            moments[0].payload["payloadAfterPath"],
            f.binding.current_path
        );
    }
    let settlements: Vec<_> = ops
        .iter()
        .filter(|op| op.op_kind == "live.audit.settlement")
        .cloned()
        .collect();
    assert_eq!(settlements.len(), 2);
    assert_eq!(
        settlements[0].payload["record"]["settlementId"],
        serde_json::json!(second.settlement_id)
    );
    assert_eq!(
        settlements[1].payload["record"]["restoreOperationId"],
        "restore-settlement"
    );
    let binary: Vec<(String, Vec<u8>)> = source
        .read_with(|conn| {
            conn.prepare("SELECT sha256,bytes FROM binary_blobs")?
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
                .collect::<Result<Vec<_>, rusqlite::Error>>()
        })
        .unwrap();
    let texts: Vec<(String, String)> = source
        .read_with(|conn| {
            conn.prepare("SELECT sha256,text FROM blobs")?
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
                .collect::<Result<Vec<_>, rusqlite::Error>>()
        })
        .unwrap();
    let (_receiver_root, receiver_path, mut receiver) = dohc_engine_testkit::open_store();
    for (sha256, bytes) in binary {
        hydrate_blob_content(
            &mut receiver,
            &BlobHydration {
                sha256,
                content: BlobContent::Binary(bytes),
            },
            &NoFaults,
        )
        .unwrap();
    }
    for (sha256, text) in texts {
        hydrate_blob_content(
            &mut receiver,
            &BlobHydration {
                sha256,
                content: BlobContent::Text(text),
            },
            &NoFaults,
        )
        .unwrap();
    }
    let mut cache = dohc_engine_collab::WriterDocCache::new();
    for mut op in ops {
        op.relay_seq = Some(op.origin_seq + 1);
        let result =
            apply_replication_envelope(&mut receiver, &mut cache, &op, &NoFaults, &NoLiveLeases)
                .unwrap();
        assert!(
            matches!(result.primary, ApplyDisposition::Applied(_)),
            "{}: {:?}",
            op.op_kind,
            result.primary
        );
        if op.op_kind == "live.audit.base" {
            let mut missing = settlements[0].clone();
            missing.origin_id = "early-settlement".into();
            missing.origin_seq = 0;
            missing.relay_seq = Some(100);
            assert!(matches!(
                apply_replication_envelope(
                    &mut receiver,
                    &mut cache,
                    &missing,
                    &NoFaults,
                    &NoLiveLeases
                ),
                Err(SyncError::RetryableState { .. })
            ));
            assert_eq!(
                dohc_engine_sync::read_replication_acked_seq(
                    &receiver,
                    "workspace",
                    "early-settlement"
                )
                .unwrap(),
                -1
            );
        }
    }
    drop(receiver);
    let mut receiver = EngineStore::open(&receiver_path, 41).unwrap();
    let accepted_bytes = read_link_audit_record(&receiver);
    let accepted_record: serde_json::Value = serde_json::from_slice(&accepted_bytes).unwrap();
    assert_eq!(
        accepted_record["metadata"],
        serde_json::to_value(&metadata).unwrap()
    );
    receiver
        .read_with(|conn| -> Result<(), rusqlite::Error> {
            let count: i64 =
                conn.query_row("SELECT count(*) FROM live_audit_settlements", [], |row| {
                    row.get(0)
                })?;
            assert_eq!(count, 2);
            let restore:(String,String)=conn.query_row("SELECT restore_operation_id,restore_markdown_digest FROM live_audit_events WHERE restore_operation_id IS NOT NULL",[],|r|Ok((r.get(0)?,r.get(1)?)))?;
            assert_eq!(restore,("restore-settlement".into(),hex_sha256(&expected)));
            let chunks:Vec<Vec<u8>>=conn.prepare("SELECT b.bytes FROM live_audit_events e JOIN live_audit_record_chunks c ON c.record_digest=e.record_digest JOIN binary_blobs b ON b.sha256=c.chunk_sha256 WHERE e.restore_operation_id IS NOT NULL ORDER BY c.ordinal")?.query_map([],|r|r.get(0))?.collect::<Result<_,_>>()?;
            let bytes:Vec<u8>=chunks.into_iter().flatten().collect();
            let audit:serde_json::Value=serde_json::from_slice(&bytes).unwrap();
            assert_eq!(audit["sourceRestore"]["operationId"],"restore-settlement");
            assert_eq!(audit["sourceRestore"]["oldGeneration"],0);
            assert_eq!(audit["sourceRestore"]["selected"]["eventCount"],0);
            assert_eq!(audit["sourceRestore"]["accepted"]["eventCount"],1);
            assert_eq!(audit["metadata"]["accepted"]["binding"]["restoreFenceGeneration"],1);
            assert_eq!(audit["sourceRestore"]["point"]["markdownDigest"],hex_sha256(&expected));
            assert_eq!(audit["sourceRestore"]["finalContentDigest"],final_content_digest);
            assert!(audit["sourceRestore"].get("nativeSources").is_none());
            for table in [
                "live_device_settlements",
                "live_device_application_bindings",
                "live_device_update_applications",
                "live_owner_adoptions",
                "live_restore_fences",
            ] {
                let count: i64 =
                    conn.query_row(&format!("SELECT count(*) FROM {table}"), [], |row| {
                        row.get(0)
                    })?;
                assert_eq!(count, 0, "{table}");
            }
            let projection: String = conn.query_row(
                "SELECT markdown_digest FROM live_audit_settlements WHERE settlement_id=?1",
                [&final_settlement.settlement_id],
                |row| row.get(0),
            )?;
            assert_eq!(projection, hex_sha256(&expected));
            assert!(
                conn.execute("DELETE FROM blobs WHERE sha256=?1", [projection])
                    .is_err()
            );
            Ok(())
        })
        .unwrap();
    let mut forged_restore = settlements[1].clone();
    forged_restore.origin_id = "forged-restore-linkage".into();
    forged_restore.origin_seq = 0;
    forged_restore.relay_seq = Some(199);
    let valid_restore_json = serde_json::to_string(&forged_restore.payload["record"]).unwrap();
    let forged_restore_json = valid_restore_json.replace("restore-settlement", "forged-restore");
    assert_ne!(forged_restore_json, valid_restore_json);
    forged_restore.payload["record"] = serde_json::from_str(&forged_restore_json).unwrap();
    // Hash the typed record's canonical field order retained in the source payload.
    let stored_restore: String = receiver
        .read_with(|conn| {
            conn.query_row(
                "SELECT record_json FROM live_audit_settlements WHERE settlement_id=?1",
                [&final_settlement.settlement_id],
                |r| r.get(0),
            )
        })
        .unwrap();
    forged_restore.payload["recordDigest"] = serde_json::json!(hex_sha256(
        stored_restore
            .replace("restore-settlement", "forged-restore")
            .as_bytes()
    ));
    assert!(matches!(
        apply_replication_envelope(
            &mut receiver,
            &mut cache,
            &forged_restore,
            &NoFaults,
            &NoLiveLeases
        )
        .unwrap()
        .primary,
        ApplyDisposition::Refused(_)
    ));
    let retained: String = receiver
        .read_with(|conn| {
            conn.query_row(
                "SELECT record_json FROM live_audit_settlements WHERE settlement_id=?1",
                [&second.settlement_id],
                |row| row.get(0),
            )
        })
        .unwrap();
    let malformed = retained.replace("\"acceptedEventCount\":1", "\"acceptedEventCount\":2");
    assert_ne!(malformed, retained);
    let mut forged = settlements[0].clone();
    forged.origin_id = "forged-interval".into();
    forged.origin_seq = 0;
    forged.relay_seq = Some(200);
    forged.payload["record"] = serde_json::from_str(&malformed).unwrap();
    forged.payload["recordDigest"] = serde_json::json!(hex_sha256(malformed.as_bytes()));
    assert!(matches!(
        apply_replication_envelope(&mut receiver, &mut cache, &forged, &NoFaults, &NoLiveLeases)
            .unwrap()
            .primary,
        ApplyDisposition::Refused(_)
    ));
    let conflicting = retained.replace(
        "\"connectionId\":\"connection\"",
        "\"connectionId\":\"other-connection\"",
    );
    assert_ne!(conflicting, retained);
    forged.origin_id = "conflicting-settlement".into();
    forged.relay_seq = Some(201);
    forged.payload["record"] = serde_json::from_str(&conflicting).unwrap();
    forged.payload["recordDigest"] = serde_json::json!(hex_sha256(conflicting.as_bytes()));
    assert!(matches!(
        apply_replication_envelope(&mut receiver, &mut cache, &forged, &NoFaults, &NoLiveLeases)
            .unwrap()
            .primary,
        ApplyDisposition::Refused(_)
    ));
    receiver
        .read_with(|conn| -> Result<(), rusqlite::Error> {
            let conflict_count: i64 = conn.query_row(
                "SELECT count(*) FROM live_audit_settlement_conflicts",
                [],
                |row| row.get(0),
            )?;
            assert_eq!(conflict_count, 1);
            let still: String = conn.query_row(
                "SELECT record_json FROM live_audit_settlements WHERE settlement_id=?1",
                [&second.settlement_id],
                |row| row.get(0),
            )?;
            assert_eq!(still, retained);
            Ok(())
        })
        .unwrap();
    resolve_imported_history_successor(
        receiver,
        &receiver_path,
        &key,
        &f.binding.lineage_claim_id,
        &accepted_bytes,
        &retained,
    )
    .await;
}

fn read_link_audit_record(store: &EngineStore) -> Vec<u8> {
    store.read_with(|conn| {
        conn.prepare("SELECT b.bytes FROM live_audit_events e JOIN live_audit_record_chunks c ON c.record_digest=e.record_digest JOIN binary_blobs b ON b.sha256=c.chunk_sha256 WHERE e.delivery_id='link-delivery' ORDER BY c.ordinal")?
            .query_map([], |row| row.get::<_, Vec<u8>>(0))?
            .collect::<Result<Vec<_>, rusqlite::Error>>()
    }).unwrap().into_iter().flatten().collect()
}

async fn resolve_imported_history_successor(
    mut store: EngineStore,
    db: &std::path::Path,
    key: &dohc_engine_collab::DocKey,
    predecessor: &str,
    accepted_bytes: &[u8],
    settlement_record: &str,
) {
    use dohc_engine_domain::{
        ConflictChoice, ConflictFileState, ConflictMetadata, ConflictStatus, ResolveConflictKind,
        ResolveTextConflict, TextConflict, VersionedTextStore,
    };
    let current = VersionedTextStore::new(&mut store)
        .read_text("workspace", "main", "notes/example.md")
        .unwrap()
        .unwrap();
    let mut incoming = current.clone();
    incoming.version_id = "incoming-version".into();
    incoming.object_id = "incoming-object".into();
    incoming.text = "# Conflicting incoming\n".into();
    incoming.blob_sha256 = hex_sha256(incoming.text.as_bytes());
    incoming.latest_moment_id = "incoming-moment".into();
    incoming.updated_at_ms = 50;
    dohc_engine_sync::journal_local_replication_op(
        &mut store,
        "workspace",
        "receiver-origin",
        "epoch",
        "stream",
        "workspace.init",
        &serde_json::json!({}),
        50,
        &NoFaults,
    )
    .unwrap();
    dohc_engine_sync::commit_relay_cursor(
        &mut store,
        "workspace",
        &dohc_engine_sync::RelayCursor {
            bootstrap_complete: true,
            cursor: 500,
            replication_epoch: "epoch".into(),
            stream_identity: "stream".into(),
            settlement_report_id: None,
            ordinary_pull: None,
        },
        &NoFaults,
        &dohc_engine_sync::NoLiveLeases,
        50,
    )
    .unwrap();
    drop(store);
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(db, 51).unwrap().actor;
    actor
        .conflict_open(
            Box::new(TextConflict {
                conflict_id: "imported-history-conflict".into(),
                workspace_id: "workspace".into(),
                path: current.path.clone(),
                target_version_id: "main".into(),
                source_version_id: "incoming-version".into(),
                created_at_ms: 50,
                updated_at_ms: 50,
                status: ConflictStatus::Open,
                chosen_from: ConflictChoice::Current,
                resolution: None,
                metadata: ConflictMetadata::origin("api"),
                base: ConflictFileState::text(&current.path, None),
                current: ConflictFileState::text(&current.path, Some(current.clone())),
                incoming: ConflictFileState::text(&current.path, Some(incoming)),
            }),
            Arc::new(NoFaults),
            tokio_util::sync::CancellationToken::new(),
        )
        .await
        .unwrap();
    actor
        .conflict_resolve(
            ResolveTextConflict {
                workspace_id: "workspace".into(),
                conflict_id: "imported-history-conflict".into(),
                resolution: ResolveConflictKind::KeepCurrent,
                object_id: "successor-object".into(),
                write_moment_id: "successor-write".into(),
                delete_moment_id: "successor-delete".into(),
                metadata_origin: "api".into(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 52,
                request_id: Some("successor-request".into()),
                conflict_answer_budget_bytes: usize::MAX,
            },
            dohc_engine_collab::LeaseRegistry::new(),
            Arc::new(NoFaults),
            tokio_util::sync::CancellationToken::new(),
        )
        .await
        .unwrap();
    supervisor.close(db).unwrap();
    let store = EngineStore::open(db, 53).unwrap();
    let marker = dohc_engine_collab::read_marker(&store, key)
        .unwrap()
        .unwrap();
    let successor = marker.lineage_claim_id.unwrap();
    assert_ne!(successor, predecessor);
    assert_eq!(marker.lineage_parent_claim_id.as_deref(), Some(predecessor));
    assert_eq!(
        dohc_engine_collab::load_persisted(&store, key)
            .unwrap()
            .unwrap()
            .doc
            .project(ContentKind::Richdoc)
            .unwrap()
            .content,
        current.text
    );
    assert_eq!(read_link_audit_record(&store), accepted_bytes);
    let records: Vec<String> = store
        .read_with(|conn| {
            conn.prepare("SELECT record_json FROM live_audit_settlements ORDER BY settlement_id")?
                .query_map([], |row| row.get(0))?
                .collect::<Result<_, rusqlite::Error>>()
        })
        .unwrap();
    assert_eq!(records.len(), 2);
    assert!(records.iter().any(|record| record == settlement_record));
    let ops =
        dohc_engine_sync::list_replication_ops(&store, "workspace", "receiver-origin", -1, 500)
            .unwrap();
    let resolutions: Vec<_> = ops
        .iter()
        .filter(|op| op.op_kind == "conflict.resolve")
        .collect();
    assert_eq!(resolutions.len(), 1);
    assert_eq!(
        resolutions[0].payload["lineageTransition"]["predecessorClaimId"],
        predecessor
    );
    assert_eq!(
        resolutions[0].payload["lineageTransition"]["successor"]["lineageClaimId"],
        successor
    );
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.supervisor.close(&self.db).unwrap();
    }
}

#[tokio::test]
async fn restore_fence_recovers_first_commit_after_reconnect_without_readoption() {
    let f = Fixture::new().await;
    let input = NativeRestoreFence {
        point: dohc_engine_collab::live_update_application::NativeRestoreSelection {
            journal_cursor: 0,
            receipt_digest: f.binding.lineage_claim_id.clone(),
        },
        operation_id: "restore-reconnected".into(),
        relay_database_namespace: "relay".into(),
        old_binding: f.binding.clone(),
        host_id: "host".into(),
        new_fence: 1,
        origin: RestoreDeliveryOrigin::Bootstrap {
            id: "bootstrap".into(),
        },
        terminal: None,
        applied_sequence: 0,
    };
    let coordinate = ApplicationHostCoordinate {
        host_id: "host".into(),
        host_epoch: 2,
        instance_id: "restarted-instance".into(),
        connection_id: "reconnected".into(),
    };
    let snapshot = || {
        let conn = rusqlite::Connection::open_with_flags(
            &f.db,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .unwrap();
        [
            "live_device_application_bindings",
            "live_restore_fences",
            "live_owner_adoptions",
            "owner_ydoc_outboxes",
            "ydoc_docs",
            "live_device_update_applications",
        ]
        .map(|table| {
            let mut query = conn
                .prepare(&format!("SELECT * FROM {table} ORDER BY rowid"))
                .unwrap();
            let count = query.column_count();
            query
                .query_map([], |row| {
                    (0..count)
                        .map(|index| row.get::<_, rusqlite::types::Value>(index))
                        .collect::<Result<Vec<_>, _>>()
                })
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap()
        })
    };
    let before = snapshot();
    f.supervisor.close(&f.db).unwrap();
    let actor = f.supervisor.open(&f.db, 2).unwrap().actor;
    let replacement = actor
        .live_application_owner("workspace".into())
        .await
        .unwrap();
    assert!(
        f.owner
            .fence_restore_after_reconnect(input.clone(), coordinate.clone(), 3, Arc::new(NoFaults))
            .await
            .is_err()
    );
    assert_eq!(snapshot(), before, "retired connection cannot fence");
    assert!(
        replacement
            .fence_restore(input.clone(), coordinate.clone(), 3, Arc::new(NoFaults))
            .await
            .is_err()
    );
    assert_eq!(
        snapshot(),
        before,
        "strict entry retains exact coordinate checks"
    );
    for variant in 0..11 {
        let mut wrong = input.clone();
        let mut host = coordinate.clone();
        match variant {
            0 => {
                wrong.host_id = "foreign-host".into();
                host.host_id = wrong.host_id.clone();
            }
            1 => wrong.operation_id.clear(),
            2 => wrong.relay_database_namespace = "foreign-relay".into(),
            3 => wrong.old_binding.current_path = "elsewhere.md".into(),
            4 => wrong.old_binding.lineage_claim_id = "f".repeat(64),
            5 => {
                wrong.origin = RestoreDeliveryOrigin::Bootstrap {
                    id: "foreign-bootstrap".into(),
                }
            }
            6 => {
                wrong.origin = RestoreDeliveryOrigin::Owner {
                    id: "foreign-owner".into(),
                }
            }
            7 => wrong.applied_sequence = 1,
            8 => wrong.new_fence = 2,
            9 => wrong.old_binding.selector_paths = vec!["notes".into()],
            _ => {
                wrong.terminal = Some(LiveUpdateReceipt {
                    delivery_id: "unapplied".into(),
                    update_digest: "a".repeat(64),
                    journal_cursor: 1,
                    accepting_host_epoch: 1,
                })
            }
        }
        assert!(
            replacement
                .fence_restore_after_reconnect(wrong, host, 3, Arc::new(NoFaults))
                .await
                .is_err(),
            "variant {variant}"
        );
        assert_eq!(
            snapshot(),
            before,
            "variant {variant} changed durable state"
        );
    }
    let receipt = replacement
        .fence_restore_after_reconnect(input.clone(), coordinate.clone(), 4, Arc::new(NoFaults))
        .await
        .unwrap();
    assert_eq!(receipt.operation, input);
    assert_eq!(receipt.local_head_sequence, 0);
    let stopped = snapshot();
    let mut wrong = input.clone();
    wrong.operation_id = "different-operation".into();
    assert!(
        replacement
            .fence_restore_after_reconnect(wrong, coordinate.clone(), 5, Arc::new(NoFaults))
            .await
            .is_err()
    );
    assert_eq!(snapshot(), stopped, "wrong replay operation changed state");
    assert_eq!(
        replacement
            .fence_restore_after_reconnect(input, coordinate, 6, Arc::new(NoFaults))
            .await
            .unwrap(),
        receipt
    );
    assert_eq!(snapshot(), stopped, "exact replay changed state");
}

struct Crash(FaultPoint);
impl FaultInjector for Crash {
    fn poll(&self, point: FaultPoint) -> FaultAction {
        if point == self.0 {
            FaultAction::Crash
        } else {
            FaultAction::Continue
        }
    }
}

struct Rival {
    path: PathBuf,
    injected: std::sync::atomic::AtomicBool,
}
impl FaultInjector for Rival {
    fn poll(&self, point: FaultPoint) -> FaultAction {
        if point == FaultPoint::MaterializeBeforePreimageRevalidate
            && !self
                .injected
                .swap(true, std::sync::atomic::Ordering::SeqCst)
        {
            std::fs::write(&self.path, "rival survives").unwrap();
        }
        FaultAction::Continue
    }
}

#[tokio::test]
async fn configured_settlement_recovers_compensated_conflict_after_operator_restores_preimage() {
    for already_settled in [false, true] {
        let f = Fixture::new().await;
        let path = f.root.path().join(&f.binding.current_path);
        let original = if already_settled {
            f.settle(None, 4, Arc::new(NoFaults)).await.unwrap();
            Some(std::fs::read(&path).unwrap())
        } else {
            None
        };
        let terminal = f.apply(1, vector("ordinary-frontmatter-order")).await;
        assert!(
            f.settle(
                Some(terminal.clone()),
                4,
                Arc::new(Rival {
                    path: path.clone(),
                    injected: std::sync::atomic::AtomicBool::new(false)
                })
            )
            .await
            .is_err()
        );
        let counts = f.counts();
        let id:String=f.read(|db|db.query_row("SELECT settlement_id FROM live_device_settlements ORDER BY terminal_cursor DESC LIMIT 1",[],|r|r.get(0)).unwrap());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "rival survives");
        assert!(
            f.settle(Some(terminal.clone()), 4, Arc::new(NoFaults))
                .await
                .is_err()
        );
        assert_eq!(f.counts(), counts);
        if let Some(bytes) = &original {
            std::fs::write(&path, bytes).unwrap();
        } else {
            std::fs::remove_file(&path).unwrap();
        }
        assert!(
            f.settle(
                Some(terminal.clone()),
                4,
                Arc::new(Rival {
                    path: path.clone(),
                    injected: std::sync::atomic::AtomicBool::new(false)
                })
            )
            .await
            .is_err()
        );
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "rival survives");
        assert_eq!(f.counts(), counts);
        if let Some(bytes) = &original {
            std::fs::write(&path, bytes).unwrap();
        } else {
            std::fs::remove_file(&path).unwrap();
        }
        let recovered = f
            .settle(Some(terminal), 4, Arc::new(NoFaults))
            .await
            .unwrap();
        assert!(recovered.materialized);
        assert_eq!(recovered.settlement_id, Some(id));
        assert_eq!(f.counts(), counts);
        f.assert_projection();
    }
}

#[tokio::test]
async fn configured_settlement_refuses_missing_receipts_and_foreign_local_updates() {
    for damage in [
        "DELETE FROM live_device_update_applications",
        "UPDATE ydoc_docs SET head_update_seq=2",
        "UPDATE ydoc_docs SET content_kind='plaintext'",
    ] {
        let f = Fixture::new().await;
        let terminal = f.apply(1, vec![0, 0]).await;
        let raw = rusqlite::Connection::open(&f.db).unwrap();
        raw.execute(damage, []).unwrap();
        drop(raw);
        assert!(
            f.settle(Some(terminal), 4, Arc::new(NoFaults))
                .await
                .is_err()
        );
        assert_eq!(f.counts(), (0, 1));
    }
}

#[tokio::test]
async fn configured_settlement_recovers_committed_projection_and_pending_materialization() {
    for point in [
        FaultPoint::StorageAfterCommitBeforeAck,
        FaultPoint::MaterializeAfterJobCommit,
        FaultPoint::MaterializeAfterRenameBeforeComplete,
    ] {
        let f = Fixture::new().await;
        let terminal = f.apply(2, vector("ordinary-frontmatter-order")).await;
        let _interrupted = f
            .settle(Some(terminal.clone()), 4, Arc::new(Crash(point)))
            .await;
        let counts = f.counts();
        assert_eq!(counts.0, 1, "{point:?}");
        let original: String = f.read(|db| {
            db.query_row(
                "SELECT settlement_id FROM live_device_settlements",
                [],
                |r| r.get(0),
            )
            .unwrap()
        });
        let repaired = f
            .settle(Some(terminal), 4, Arc::new(NoFaults))
            .await
            .unwrap();
        assert_eq!(repaired.settlement_id, Some(original));
        assert_eq!(f.counts(), counts);
        assert!(repaired.materialized);
        f.assert_projection();
    }
}

#[tokio::test]
#[ignore = "the Rust gate's reader phase runs it with DOHC_ENGINE_READER_CONFIG"]
async fn reader_restore_dispatches_outside_the_actor_at_every_phase() {
    let vector: serde_json::Value = serde_json::from_str(include_str!(
        "../../dohc-engine-collab/tests/reader-restore.json"
    ))
    .unwrap();
    let bytes: Vec<u8> = serde_json::from_value(vector["pointStateBytes"].clone()).unwrap();
    let source = vector["source"].as_str().unwrap().to_owned();
    let path = "notes/reader.md";
    let f = Fixture::build(false, bytes, path, |store| {
        dohc_engine_domain::VersionedTextStore::new(store)
            .write_text(
                &dohc_engine_domain::WriteText {
                    workspace_id: "workspace".into(),
                    version_id: "main".into(),
                    object_id: "object".into(),
                    path: path.into(),
                    text: source.clone(),
                    moment_id: "received-file".into(),
                    metadata_origin: "sync".into(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: None,
                    now_ms: 0,
                    request_id: None,
                },
                &NoFaults,
            )
            .unwrap();
    })
    .await;
    let actor = f.supervisor.open(&f.db, 2).unwrap().actor;
    let fresh = || {
        let config =
            serde_json::from_str(&std::env::var("DOHC_ENGINE_READER_CONFIG").unwrap()).unwrap();
        let reader = Arc::new(dohc_engine_reader::Reader::new(Some(config)));
        (
            Arc::new(dohc_engine_collab::reader_resolver::ReaderResolver::new(
                reader.clone(),
            )),
            reader,
        )
    };
    let (resolver, reader) = fresh();
    actor.configure_reader_resolver(resolver).await.unwrap();
    let update = f.doc.richdoc_append_paragraph("later accepted paragraph");
    let terminal = f.apply(7, update).await;
    let input = applied_restore(&f, Some(terminal), 1).await;
    assert!(reader.dispatch_count() > 0, "preparation dispatches");
    let (resolver, reader) = fresh();
    actor.configure_reader_resolver(resolver).await.unwrap();
    f.owner
        .apply_restore(
            input.clone(),
            restore_coordinate(),
            2_000_000,
            100,
            25,
            Arc::new(NoFaults),
            Arc::new(()),
        )
        .await
        .unwrap();
    assert!(
        reader.dispatch_count() > 0,
        "replayed application revalidates"
    );
    let (resolver, reader) = fresh();
    actor.configure_reader_resolver(resolver).await.unwrap();
    let settlement = settle_restore(&f, input.clone(), Arc::new(NoFaults))
        .await
        .unwrap();
    assert!(reader.dispatch_count() > 0, "settlement revalidates");
    assert_eq!(
        std::fs::read_to_string(f.root.path().join(path)).unwrap(),
        source
    );
    let (resolver, reader) = fresh();
    actor.configure_reader_resolver(resolver).await.unwrap();
    let resumed = f
        .owner
        .resume_restore(
            NativeRestoreResume {
                application: input,
                settlement_id: settlement.settlement_id.unwrap(),
            },
            restore_coordinate(),
            2_000_000,
            100,
            f.root.path().to_owned(),
            40,
            Arc::new(NoFaults),
            tokio_util::sync::CancellationToken::new(),
            Arc::new(()),
        )
        .await
        .unwrap();
    assert_eq!(resumed.binding.restore_fence_generation, 1);
    assert!(reader.dispatch_count() > 0, "resume revalidates");
    f.supervisor.close(&f.db).unwrap();
}
