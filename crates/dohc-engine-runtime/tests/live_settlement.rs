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

impl Drop for Fixture {
    fn drop(&mut self) {
        self.supervisor.close(&self.db).unwrap();
    }
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

async fn unload(f: &Fixture) -> Option<UnloadPending> {
    f.owner
        .unload(
            f.binding.object_id.clone(),
            f.handle.activation_id(),
            vec![dohc_engine_collab::DocKey::new("workspace", "main", "object").unwrap()],
            f.root.path().to_owned(),
            40,
        )
        .await
        .unwrap()
}

#[tokio::test]
async fn unload_waits_for_a_committed_settlement_whose_file_write_failed() {
    for crash in [false, true] {
        let f = Fixture::new().await;
        let terminal = if crash {
            let terminal = f.apply(2, vector("ordinary-frontmatter-order")).await;
            let _interrupted = f
                .settle(
                    Some(terminal.clone()),
                    4,
                    Arc::new(Crash(FaultPoint::MaterializeAfterJobCommit)),
                )
                .await;
            Some(terminal)
        } else {
            std::fs::write(f.root.path().join("notes"), "owned file").unwrap();
            assert!(f.settle(None, 4, Arc::new(NoFaults)).await.is_err());
            None
        };
        assert_eq!(f.counts().0, i64::from(crash), "crash={crash}");
        assert_eq!(
            unload(&f).await,
            Some(UnloadPending::Materialization),
            "crash={crash}"
        );
        if !crash {
            std::fs::remove_file(f.root.path().join("notes")).unwrap();
        }
        // The refusal kept the registration, so the normal retry lands the file.
        assert!(
            f.settle(terminal, 4, Arc::new(NoFaults))
                .await
                .unwrap()
                .materialized
        );
        f.assert_projection();
        assert_eq!(unload(&f).await, None, "crash={crash}");
    }
}

const HISTORY_INTERVAL: usize = 32;
const HISTORY_MAX_APPLICATIONS: usize = 128;
const HISTORY_PUBLICATION_BUDGET: usize = 32 << 20;
/// Four full 4,095-event checkpoint segments precede a long scenario's
/// measured interval, so its accepted suffix holds 32 events like a short one.
const HISTORY_LONG_PREFIX: usize = 4 * 4_095;
const HISTORY_MAX_UPDATE_BYTES: usize = 64 << 10;
const HISTORY_MAX_BOOTSTRAP_BYTES: usize = 1 << 20;
const HISTORY_MAX_CORPUS_BYTES: usize = 64 << 20;
/// Name, visible document, and what accepted history holds before the
/// measured interval. Short scenarios carry their visible document in the
/// bootstrap. `long-empty-updates` is a history-only control: empty updates
/// precede short-small's exact bytes, so accepted history grows while native
/// state does not.
const HISTORY_SCENARIOS: [(&str, &str, &str); 5] = [
    ("short-small", "small", "none"),
    ("short-large", "large", "none"),
    ("long-small", "small", "status edits"),
    ("long-large", "large", "status and paragraph edits"),
    ("long-empty-updates", "small", "empty updates"),
];
const HISTORY_LIMITS: [&str; 2] = [
    "The operating system file cache is warm. First calls follow a new connection or actor restart, not a cold disk.",
    "Nearest-rank p95 of fewer than 20 samples is the slowest sample.",
];

fn history_env(name: &str, default: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| default.into())
}

fn elapsed_ms(started: std::time::Instant) -> f64 {
    started.elapsed().as_secs_f64() * 1_000.0
}

fn dir_bytes(path: &std::path::Path) -> u64 {
    std::fs::read_dir(path).map_or(0, |entries| {
        entries
            .filter_map(Result::ok)
            .map(|entry| match entry.file_type() {
                Ok(kind) if kind.is_dir() => dir_bytes(&entry.path()),
                _ => entry.metadata().map_or(0, |m| m.len()),
            })
            .sum()
    })
}

/// Nearest-rank summary of raw milliseconds. With fewer than 20 samples, p95
/// is the slowest sample.
fn summary(samples: &[f64]) -> serde_json::Value {
    let mut sorted = samples.to_vec();
    sorted.sort_by(f64::total_cmp);
    let rank = |q: f64| {
        sorted
            .get(((q * sorted.len() as f64).ceil() as usize).max(1) - 1)
            .copied()
    };
    serde_json::json!({
        "count": sorted.len(),
        "medianMs": rank(0.5),
        "p95Ms": rank(0.95),
        "maxMs": sorted.last(),
    })
}

/// Edit `i` of the long realistic lineage, unchanged from the first frozen
/// corpus: a status change on most edits and a short Unicode paragraph every
/// 64th, never a full-body replacement.
fn history_edit(doc: &Ydoc, i: usize) -> Vec<u8> {
    if i % 64 == 63 {
        doc.richdoc_append_paragraph(&format!("Revision {i}: Ã¼nÃ¯cÃ¸dÃ© âœ“ ðŸš€"))
    } else {
        history_status(doc, i)
    }
}

fn history_status(doc: &Ydoc, i: usize) -> Vec<u8> {
    doc.frontmatter_set("status", ["draft", "review", "done"][i % 3])
        .unwrap()
}

/// A fresh generation of `name`: its own bootstrap, unless it uses the
/// `rich-unicode` fixture, and its accepted updates. Every scenario ends with
/// edits 16380..16412 of the realistic lineage, so each measured interval
/// makes the same edits to the same visible document.
fn history_generate(name: &str) -> (Option<Vec<u8>>, Vec<Vec<u8>>) {
    let doc = Ydoc::wire();
    doc.apply(&vector("rich-unicode")).unwrap();
    let (bootstrap, mut updates) = match name {
        "short-small" | "short-large" => {
            history_status(&doc, HISTORY_LONG_PREFIX - 1);
            if name == "short-large" {
                for i in (63..HISTORY_LONG_PREFIX).step_by(64) {
                    history_edit(&doc, i);
                }
            }
            (Some(doc.encode_full_state()), Vec::new())
        }
        "long-small" => (
            None,
            (0..HISTORY_LONG_PREFIX)
                .map(|i| history_status(&doc, i))
                .collect(),
        ),
        "long-large" => (
            None,
            (0..HISTORY_LONG_PREFIX)
                .map(|i| history_edit(&doc, i))
                .collect(),
        ),
        _ => unreachable!("{name} has no generator"),
    };
    updates.extend(
        (HISTORY_LONG_PREFIX..HISTORY_LONG_PREFIX + HISTORY_INTERVAL)
            .map(|i| history_edit(&doc, i)),
    );
    (bootstrap, updates)
}

fn encode_frames(updates: &[Vec<u8>]) -> Vec<u8> {
    updates
        .iter()
        .flat_map(|u| {
            (u.len() as u32)
                .to_le_bytes()
                .into_iter()
                .chain(u.iter().copied())
        })
        .collect()
}

fn decode_frames(encoded: &[u8], expected: usize) -> Vec<Vec<u8>> {
    let (mut updates, mut rest) = (Vec::with_capacity(expected), encoded);
    while !rest.is_empty() {
        assert!(
            updates.len() < expected,
            "corpus holds more than {expected} updates"
        );
        let Some((length, tail)) = rest.split_first_chunk::<4>() else {
            panic!("corpus ends inside frame {}", updates.len());
        };
        let length = u32::from_le_bytes(*length) as usize;
        assert!(
            length <= HISTORY_MAX_UPDATE_BYTES && length <= tail.len(),
            "corpus frame {} is truncated or exceeds 64 KiB",
            updates.len()
        );
        let (update, tail) = tail.split_at(length);
        updates.push(update.to_vec());
        rest = tail;
    }
    assert_eq!(updates.len(), expected, "corpus update count");
    updates
}

fn read_capped(path: &std::path::Path, cap: usize) -> Vec<u8> {
    use std::io::Read;
    let mut bytes = Vec::new();
    std::fs::File::open(path)
        .unwrap()
        .take(cap as u64 + 1)
        .read_to_end(&mut bytes)
        .unwrap();
    assert!(bytes.len() <= cap, "{} exceeds {cap} bytes", path.display());
    bytes
}

/// Replay `updates` beside a fresh generation and compare projections at the
/// bootstrap, at the end of the prefix, and after each measured update. Yrs
/// client ids differ between the two; the visible edits must not.
fn history_validate(
    name: &str,
    bootstrap: &[u8],
    updates: &[Vec<u8>],
    reference_bootstrap: &[u8],
    reference: &[Vec<u8>],
) -> Ydoc {
    let (loaded, fresh) = (Ydoc::wire(), Ydoc::wire());
    let project = |doc: &Ydoc| doc.project(ContentKind::Richdoc).unwrap().content;
    loaded.apply(bootstrap).unwrap();
    fresh.apply(reference_bootstrap).unwrap();
    assert_eq!(project(&loaded), project(&fresh), "{name}: bootstrap");
    let prefix = updates.len() - HISTORY_INTERVAL;
    for (index, (update, expected)) in updates.iter().zip(reference).enumerate() {
        assert!(update.len() > 2, "{name}: update {index} is empty");
        loaded.apply(update).unwrap();
        fresh.apply(expected).unwrap();
        if index + 1 >= prefix {
            assert_eq!(
                project(&loaded),
                project(&fresh),
                "{name}: projection after update {}",
                index + 1
            );
        }
    }
    loaded
}

#[derive(Clone)]
struct HistoryCorpus {
    bootstrap: Vec<u8>,
    updates: Vec<Vec<u8>>,
    identity: serde_json::Value,
    markdown: String,
    full_state_bytes: usize,
    delete_set_bytes: usize,
}

/// `name`'s bootstrap and length-prefixed update frames, frozen under
/// DOHC_LIVE_HISTORY_CORPUS_DIR as `<name>.updates` and, for a scenario with
/// its own bootstrap, `<name>.bootstrap`. Frozen files keep native bytes
/// identical across builds; a fresh `Ydoc::wire()` picks a new Yrs client id.
/// A scenario with none of its files is generated and frozen. Existing files
/// are never rewritten: a partial or invalid scenario stops the run.
fn history_corpus(name: &str) -> HistoryCorpus {
    let (own_bootstrap, generated) = history_generate(name);
    let dir = std::env::var_os("DOHC_LIVE_HISTORY_CORPUS_DIR").map(PathBuf::from);
    let path = |extension: &str| {
        dir.as_ref()
            .map(|dir| dir.join(format!("{name}.{extension}")))
    };
    let bootstrap_path = path("bootstrap").filter(|_| own_bootstrap.is_some());
    let updates_path = path("updates");
    let bootstrap_source = if own_bootstrap.is_some() {
        "scenario"
    } else {
        "fixture rich-unicode"
    };
    let fresh_bootstrap = own_bootstrap.unwrap_or_else(|| vector("rich-unicode"));
    let present: Vec<bool> = updates_path
        .iter()
        .chain(&bootstrap_path)
        .map(|path| path.try_exists().unwrap())
        .collect();
    let frozen = present.contains(&true);
    assert!(
        !frozen || !present.contains(&false),
        "{name}: frozen corpus is incomplete; restore or remove its files"
    );
    let (bootstrap, encoded) = if frozen {
        (
            bootstrap_path.as_ref().map_or_else(
                || fresh_bootstrap.clone(),
                |path| read_capped(path, HISTORY_MAX_BOOTSTRAP_BYTES),
            ),
            read_capped(updates_path.as_ref().unwrap(), HISTORY_MAX_CORPUS_BYTES),
        )
    } else {
        (fresh_bootstrap.clone(), encode_frames(&generated))
    };
    let updates = decode_frames(&encoded, generated.len());
    let doc = history_validate(name, &bootstrap, &updates, &fresh_bootstrap, &generated);
    if !frozen {
        for (path, bytes) in [(&bootstrap_path, &bootstrap), (&updates_path, &encoded)] {
            use std::io::Write;
            let Some(path) = path else { continue };
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(path)
                .unwrap()
                .write_all(bytes)
                .unwrap();
        }
    }
    let source = match (frozen, &dir) {
        (true, _) => "frozen",
        (false, Some(_)) => "generated-and-frozen",
        (false, None) => "generated",
    };
    HistoryCorpus {
        identity: serde_json::json!({
            "scenario": name,
            "source": source,
            "sha256": hex_sha256(&encoded),
            "updates": updates.len(),
            "usedBytes": updates.iter().map(Vec::len).sum::<usize>(),
            "bootstrapSource": bootstrap_source,
        }),
        markdown: doc.project(ContentKind::Richdoc).unwrap().content,
        full_state_bytes: doc.encode_full_state().len(),
        delete_set_bytes: doc.encode_delete_set().len(),
        bootstrap,
        updates,
    }
}

/// The `long-empty-updates` control: empty updates before short-small's
/// exact bootstrap and update bytes, so it shares their native state.
fn history_empty_updates(short_small: &HistoryCorpus) -> HistoryCorpus {
    let updates: Vec<Vec<u8>> = std::iter::repeat_n(vec![0, 0], HISTORY_LONG_PREFIX)
        .chain(short_small.updates.iter().cloned())
        .collect();
    HistoryCorpus {
        identity: serde_json::json!({
            "scenario": "long-empty-updates",
            "sha256": hex_sha256(&encode_frames(&updates)),
            "updates": updates.len(),
            "usedBytes": updates.iter().map(Vec::len).sum::<usize>(),
            "emptyUpdates": HISTORY_LONG_PREFIX,
            "base": short_small.identity,
        }),
        updates,
        ..short_small.clone()
    }
}

impl Fixture {
    async fn admit(&self, after: usize, updates: &[Vec<u8>]) -> LiveUpdateReceipt {
        let mut terminal = None;
        for (index, update) in updates.iter().enumerate() {
            let cursor = after + index + 1;
            let authority = if cursor.is_multiple_of(8) {
                ServerDerivedLiveUpdateAuthority::Link {
                    principal_id: "link-principal".into(),
                    grant_id: "link-grant".into(),
                    grant_generation: 1,
                }
            } else {
                ServerDerivedLiveUpdateAuthority::Owner {
                    principal_id: "owner".into(),
                }
            };
            terminal = Some(
                self.apply_as(cursor as i64, update.clone(), authority, 2)
                    .await,
            );
        }
        terminal.unwrap()
    }

    async fn settle_interval(
        &self,
        terminal: Option<LiveUpdateReceipt>,
    ) -> Result<LiveSettlementResult, RuntimeError> {
        self.settle(terminal, HISTORY_MAX_APPLICATIONS, Arc::new(NoFaults))
            .await
    }

    async fn reopen(&mut self) {
        self.supervisor.close(&self.db).unwrap();
        (self.owner, self.handle) = open_owner(&self.supervisor, &self.db, &self.binding).await;
    }

    /// Close this actor and open a separate fixture on a byte copy of the
    /// quiesced workspace, its database and Markdown artifact included.
    async fn copy(&self) -> Fixture {
        self.supervisor.close(&self.db).unwrap();
        let root = ScratchDir::new().unwrap();
        copy_dir(self.root.path(), root.path());
        let db = engine_db_path(&root).unwrap();
        let supervisor = WorkspaceSupervisor::new();
        let (owner, handle) = open_owner(&supervisor, &db, &self.binding).await;
        let doc = Ydoc::wire();
        doc.apply(&self.doc.encode_full_state()).unwrap();
        Fixture {
            root,
            db,
            supervisor,
            owner,
            handle,
            binding: self.binding.clone(),
            doc,
        }
    }
}

async fn open_owner(
    supervisor: &WorkspaceSupervisor,
    db: &std::path::Path,
    binding: &LiveObjectBinding,
) -> (ActorLiveApplicationOwner, ActorLiveApplicationHandle) {
    let owner = supervisor
        .open(db, 20)
        .unwrap()
        .actor
        .live_application_owner("workspace".into())
        .await
        .unwrap();
    let handle = owner
        .register("relay".into(), restore_coordinate(), binding.clone())
        .await
        .unwrap();
    (owner, handle)
}

fn copy_dir(from: &std::path::Path, to: &std::path::Path) {
    for entry in std::fs::read_dir(from).unwrap() {
        let entry = entry.unwrap();
        let target = to.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            std::fs::create_dir(&target).unwrap();
            copy_dir(&entry.path(), &target);
        } else {
            std::fs::copy(entry.path(), target).unwrap();
        }
    }
}

/// Manual measurement of native accepted-history publication and settlement.
/// Raw samples only, no timing assertions; correctness checks run after each
/// timer stops.
///
/// The scenarios vary accepted-history length and visible document size
/// independently: 32 accepted updates or 16412, with the latest checkpoint at
/// event 16380, and small documents or ones with 255 more paragraphs.
/// `long-empty-updates` holds native state fixed and grows only accepted
/// history. Scenarios with the same document size end with the same projected
/// Markdown, and every measured interval makes the same 32 edits. Their
/// native bytes still differ, because a long edit history leaves tombstones,
/// so each result records native sizes.
///
/// Each scenario measures fresh settlements of the last 32 updates, half on
/// the actor that admitted them and half after an actor restart. It then
/// measures warm same-terminal replay, `owner_publication_prefix` on the
/// settlement's journaled `moment.append` (first call on a new connection,
/// then warm), and per actor restart the first replay and first publication.
/// The operating system's file cache stays warm throughout.
///
/// Build the executable once under the repository's cargo budget, then run
/// it serially. The first run writes the corpus; later runs and other builds
/// read the same bytes. Scratch fixtures stay under DOHC_TEST_SCRATCH_ROOT
/// and are removed on drop.
///
///   CARGO_BUILD_JOBS=<cores/4> cargo test -p dohc-engine-runtime --release --test live_settlement --no-run
///   DOHC_TEST_SCRATCH_ROOT=<task>/scratch DOHC_LIVE_HISTORY_CORPUS_DIR=<task>/corpus \
///     <live_settlement executable> live_history_publication_and_settlement_benchmark \
///     --ignored --exact --nocapture --test-threads=1
///
/// DOHC_LIVE_HISTORY_SCENARIOS (all five, comma separated),
/// DOHC_LIVE_HISTORY_SAMPLES (31), DOHC_LIVE_HISTORY_FRESH (5 of each fresh
/// kind), and DOHC_LIVE_HISTORY_RESTARTS (5) override the defaults.
#[tokio::test]
#[ignore = "manual live history benchmark; run without competing workloads"]
async fn live_history_publication_and_settlement_benchmark() {
    use dohc_engine_sync::{ReplicationEnvelope, owner_publication_prefix};
    use std::time::Instant;
    let all = HISTORY_SCENARIOS.map(|(name, ..)| name).join(",");
    let scenarios: Vec<_> = history_env("DOHC_LIVE_HISTORY_SCENARIOS", &all)
        .split(',')
        .map(|name| {
            *HISTORY_SCENARIOS
                .iter()
                .find(|(known, ..)| *known == name.trim())
                .unwrap_or_else(|| panic!("unknown scenario {name}"))
        })
        .collect();
    let count = |name: &str, default: &str| history_env(name, default).parse::<usize>().unwrap();
    let samples = count("DOHC_LIVE_HISTORY_SAMPLES", "31");
    let fresh_samples = count("DOHC_LIVE_HISTORY_FRESH", "5");
    let restarts = count("DOHC_LIVE_HISTORY_RESTARTS", "5");
    assert!(
        samples <= 1_000 && (5..=50).contains(&fresh_samples) && restarts <= 100,
        "samples exceed 1000, fresh samples are outside 5..=50, or restarts exceed 100"
    );
    // Every corpus is generated or validated before any fixture work.
    // Short-small loads once, so the empty-update control reuses its bytes.
    let short_small = scenarios
        .iter()
        .any(|(name, ..)| matches!(*name, "short-small" | "long-empty-updates"))
        .then(|| history_corpus("short-small"));
    let corpora: Vec<HistoryCorpus> = scenarios
        .iter()
        .map(|(name, ..)| match *name {
            "short-small" => short_small.clone().unwrap(),
            "long-empty-updates" => history_empty_updates(short_small.as_ref().unwrap()),
            name => history_corpus(name),
        })
        .collect();
    let find = |wanted: &str| {
        scenarios
            .iter()
            .zip(&corpora)
            .find(|((name, ..), _)| *name == wanted)
            .map(|(_, corpus)| corpus)
    };
    if let (Some(small), Some(empty)) = (find("short-small"), find("long-empty-updates")) {
        assert_eq!(
            small.bootstrap, empty.bootstrap,
            "long-empty-updates: bootstrap bytes"
        );
        assert_eq!(
            small.updates[..],
            empty.updates[HISTORY_LONG_PREFIX..],
            "long-empty-updates: measured update bytes"
        );
    }
    for ((name, document, _), corpus) in scenarios.iter().zip(&corpora) {
        let (_, first) = scenarios
            .iter()
            .zip(&corpora)
            .find(|((_, other, _), _)| other == document)
            .unwrap();
        assert_eq!(
            corpus.markdown, first.markdown,
            "{name}: final projection differs within the {document} document"
        );
    }
    for ((name, document, history), corpus) in scenarios.iter().zip(&corpora) {
        let size = corpus.updates.len();
        let prior = size - HISTORY_INTERVAL;
        let incomplete = |reason: &str| {
            println!(
                "LIVE_HISTORY_BENCH {}",
                serde_json::json!({ "scenario": name, "acceptedUpdates": size, "outcome": "incomplete", "reason": reason })
            )
        };
        if corpus.markdown.len() > 1 << 20 || corpus.full_state_bytes > 8 << 20 {
            incomplete("projection exceeds 1 MiB or native state exceeds 8 MiB");
            continue;
        }
        let started = Instant::now();
        let mut f =
            Fixture::build(true, corpus.bootstrap.clone(), "notes/example.md", |_| {}).await;
        // First-bootstrap materialization stays out of the measured interval.
        f.settle_interval(None).await.unwrap();
        let (before, suffix) = corpus.updates.split_at(prior);
        let mut over = false;
        for (index, interval) in before.chunks(HISTORY_INTERVAL).enumerate() {
            let after = index * HISTORY_INTERVAL;
            let terminal = f.admit(after, interval).await;
            let settled = f.settle_interval(Some(terminal)).await.unwrap();
            assert!(settled.materialized);
            assert_eq!(settled.terminal_cursor, (after + interval.len()) as i64);
            over = dir_bytes(f.root.path()) > 256 << 20;
            if over {
                break;
            }
        }
        if over {
            incomplete("workspace exceeds 256 MiB");
            continue;
        }
        let setup_ms = elapsed_ms(started);

        let check = |f: &Fixture, settled: &LiveSettlementResult| {
            assert!(settled.materialized);
            assert_eq!(
                (
                    settled.previous_cursor,
                    settled.terminal_cursor,
                    settled.application_count
                ),
                (prior as i64, size as i64, HISTORY_INTERVAL)
            );
            f.assert_projection();
        };
        // Each fresh sample settles its own copy of the closed template, so no
        // sample repeats work that another already settled.
        let (mut admitted, mut restarted) = (Vec::new(), Vec::new());
        for index in 0..2 * fresh_samples {
            let started = Instant::now();
            let mut copy = f.copy().await;
            let terminal = copy.admit(prior, suffix).await;
            if index % 2 == 1 {
                copy.reopen().await;
            }
            let prepare_ms = elapsed_ms(started);
            let started = Instant::now();
            let settled = copy.settle_interval(Some(terminal)).await;
            let settle_ms = elapsed_ms(started);
            let settled = settled.unwrap();
            check(&copy, &settled);
            let sample = serde_json::json!({
                "settleMs": settle_ms,
                "prepareMs": prepare_ms,
                "settlementId": settled.settlement_id,
                "momentId": settled.moment_id,
            });
            if index % 2 == 0 {
                admitted.push((settle_ms, sample));
            } else {
                restarted.push((settle_ms, sample));
            }
        }
        let fresh = |samples: Vec<(f64, serde_json::Value)>| {
            let (ms, raw): (Vec<f64>, Vec<_>) = samples.into_iter().unzip();
            serde_json::json!({ "summary": summary(&ms), "samples": raw })
        };

        f.reopen().await;
        let terminal = Some(f.admit(prior, suffix).await);
        let settled = f.settle_interval(terminal.clone()).await.unwrap();
        check(&f, &settled);
        let file = f.root.path().join(&f.binding.current_path);
        let (counts, bytes) = (f.counts(), std::fs::read(&file).unwrap());
        let replayed = |f: &Fixture, again: LiveSettlementResult| {
            assert_eq!(
                (again.settlement_id, again.moment_id),
                (settled.settlement_id.clone(), settled.moment_id.clone())
            );
            assert_eq!(f.counts(), counts);
            assert_eq!(std::fs::read(&file).unwrap(), bytes);
        };
        let mut replay_ms = Vec::new();
        for _ in 0..samples {
            let started = Instant::now();
            let again = f.settle_interval(terminal.clone()).await;
            replay_ms.push(elapsed_ms(started));
            replayed(&f, again.unwrap());
        }

        let published = f.read(|db| {
            db.query_row(
                "SELECT origin_id,origin_seq,recorded_at_ms,payload_json FROM replication_log WHERE imported=0 AND op_kind='moment.append' AND json_extract(payload_json,'$.momentId')=?1",
                [&settled.moment_id],
                |r| {
                    Ok(ReplicationEnvelope {
                        settlement_admission: None,
                        admitted_author_snapshot: None,
                        workspace_id: "workspace".into(),
                        origin_id: r.get(0)?,
                        origin_seq: r.get(1)?,
                        op_kind: "moment.append".into(),
                        recorded_at_ms: r.get(2)?,
                        relay_seq: None,
                        payload: serde_json::from_str(&r.get::<_, String>(3)?).unwrap(),
                    })
                },
            )
            .unwrap()
        });
        let references = [
            "payloadBeforeBlobSha256",
            "payloadAfterBlobSha256",
            "beforeBlobSha256",
        ]
        .iter()
        .filter(|name| {
            published.payload[**name]
                .as_str()
                .is_some_and(|d| !d.is_empty())
        })
        .count();
        let publish = |store: &EngineStore| {
            let started = Instant::now();
            let prefix = owner_publication_prefix(
                store,
                "workspace",
                std::slice::from_ref(&published),
                HISTORY_PUBLICATION_BUDGET,
            );
            let elapsed = elapsed_ms(started);
            let prefix = prefix.unwrap();
            assert_eq!(
                (prefix.allowed_ops, prefix.pending, prefix.budget_exhausted),
                (1, None, false)
            );
            elapsed
        };
        let store = EngineStore::open(&f.db, 20).unwrap();
        let publication_first_ms = publish(&store);
        let publication_warm_ms: Vec<f64> = (0..samples).map(|_| publish(&store)).collect();
        drop(store);

        let mut restart_samples = Vec::new();
        for _ in 0..restarts {
            let started = Instant::now();
            f.reopen().await;
            let prepare_ms = elapsed_ms(started);
            let started = Instant::now();
            let again = f.settle_interval(terminal.clone()).await;
            let replay_ms = elapsed_ms(started);
            replayed(&f, again.unwrap());
            let started = Instant::now();
            let store = EngineStore::open(&f.db, 20).unwrap();
            let store_open_ms = elapsed_ms(started);
            let publication_ms = publish(&store);
            drop(store);
            restart_samples.push(serde_json::json!({
                "prepareMs": prepare_ms,
                "replayMs": replay_ms,
                "storeOpenMs": store_open_ms,
                "publicationMs": publication_ms,
            }));
        }

        let names = [
            "acceptedEvents",
            "checkpoints",
            "latestCheckpointEvent",
            "latestCheckpointStateBytes",
            "suffixEvents",
            "suffixBytes",
            "applicationReceipts",
            "settlements",
            "moments",
            "replicationOps",
            "localSnapshots",
            "localSnapshotBytes",
            "localTailUpdates",
            "localTailBytes",
        ];
        let storage: Vec<Option<i64>> = f.read(|db| {
            db.query_row(
                "SELECT (SELECT count(*) FROM live_accepted_updates),
                    (SELECT count(*) FROM live_accepted_checkpoints),
                    (SELECT max(event_count) FROM live_accepted_checkpoints),
                    (SELECT b.byte_length FROM live_accepted_checkpoints c JOIN binary_blobs b ON b.sha256=c.state_sha256 ORDER BY c.event_count DESC LIMIT 1),
                    (SELECT suffix_count FROM live_accepted_updates ORDER BY event_count DESC LIMIT 1),
                    (SELECT suffix_bytes FROM live_accepted_updates ORDER BY event_count DESC LIMIT 1),
                    (SELECT count(*) FROM live_device_update_applications),
                    (SELECT count(*) FROM live_device_settlements),
                    (SELECT count(*) FROM moments),
                    (SELECT count(*) FROM replication_log),
                    (SELECT count(*) FROM ydoc_snapshots),
                    (SELECT b.byte_length FROM ydoc_snapshots s JOIN binary_blobs b ON b.sha256=s.snapshot_blob_sha256 ORDER BY s.up_to_seq DESC LIMIT 1),
                    (SELECT count(*) FROM ydoc_updates WHERE seq>(SELECT coalesce(max(up_to_seq),0) FROM ydoc_snapshots)),
                    (SELECT coalesce(sum(b.byte_length),0) FROM ydoc_updates u JOIN binary_blobs b ON b.sha256=u.update_blob_sha256 WHERE u.seq>(SELECT coalesce(max(up_to_seq),0) FROM ydoc_snapshots))",
                [],
                |r| (0..names.len()).map(|i| r.get(i)).collect(),
            )
            .unwrap()
        });
        let layout = (storage[2], storage[4]);
        let mut wal = f.db.clone().into_os_string();
        wal.push("-wal");
        let restart_ms = |field: &str| {
            let ms: Vec<f64> = restart_samples
                .iter()
                .map(|sample| sample[field].as_f64().unwrap())
                .collect();
            summary(&ms)
        };
        println!(
            "LIVE_HISTORY_BENCH {}",
            serde_json::json!({
                "outcome": "complete",
                "scenario": name,
                "document": document,
                "historyBeforeMeasure": history,
                "acceptedUpdates": size,
                "settledBeforeMeasure": prior,
                "measuredUpdateBytes": suffix.iter().map(Vec::len).sum::<usize>(),
                "parameters": {
                    "measuredInterval": HISTORY_INTERVAL,
                    "linkAuthorityUpdates": size / 8,
                    "maxApplications": HISTORY_MAX_APPLICATIONS,
                    "publicationBudgetBytes": HISTORY_PUBLICATION_BUDGET,
                },
                "corpus": corpus.identity,
                "bootstrapBytes": corpus.bootstrap.len(),
                "bootstrapSha256": hex_sha256(&corpus.bootstrap),
                "projectedMarkdownBytes": corpus.markdown.len(),
                "projectedMarkdownSha256": hex_sha256(corpus.markdown.as_bytes()),
                "fullStateBytes": corpus.full_state_bytes,
                "deleteSetBytes": corpus.delete_set_bytes,
                "storage": names.iter().zip(storage).map(|(n, v)| (n.to_string(), serde_json::Value::from(v))).collect::<serde_json::Map<_, _>>(),
                "files": {
                    "dbBytes": std::fs::metadata(&f.db).map_or(0, |m| m.len()),
                    "walBytes": std::fs::metadata(&wal).map_or(0, |m| m.len()),
                    "workspaceBytes": dir_bytes(f.root.path()),
                },
                "process": {
                    "pid": std::process::id(),
                    "executable": std::env::current_exe().unwrap(),
                    "os": std::env::consts::OS,
                    "arch": std::env::consts::ARCH,
                    "cpus": std::thread::available_parallelism().map_or(0, |n| n.get()),
                    "debugAssertions": cfg!(debug_assertions),
                },
                "limits": HISTORY_LIMITS,
                "setupMs": setup_ms,
                "freshSettlement": {
                    "afterAdmission": fresh(admitted),
                    "afterRestart": fresh(restarted),
                },
                "replayWarmMs": replay_ms,
                "publicationReferences": references,
                "publicationAllowedOps": 1,
                "publicationFirstMs": publication_first_ms,
                "publicationWarmMs": publication_warm_ms,
                "restarts": restart_samples,
                "summaries": {
                    "replayWarm": summary(&replay_ms),
                    "publicationWarm": summary(&publication_warm_ms),
                    "restartReplay": restart_ms("replayMs"),
                    "restartPublication": restart_ms("publicationMs"),
                },
                "settlementId": settled.settlement_id,
                "momentId": settled.moment_id,
            })
        );
        assert_eq!(
            layout,
            (Some(prior as i64), Some(HISTORY_INTERVAL as i64)),
            "{name}: latest checkpoint event and suffix events"
        );
    }
}
