//! The origin-device automation trigger (ADR 0008) through the real local
//! apply path: a committed `ydoc_record_update` with a registered
//! subscription inserts exactly one pending claim, in the append's own
//! transaction, keyed by the journaled replication coordinate and carrying
//! the change's kind, actor, and field facts. A field-filtered subscription
//! claims only its fields' changes, and each executor drains only its own
//! automation id prefix. A replay of the same update dedupes into no second
//! claim, and a peer applying the same ops by replication claims nothing at
//! all — the non-origin device's half of the two-device exactly-once rule.

use dohc_engine_collab::{ContentKind, DocKey, Regime, Ydoc};
use dohc_engine_domain::{
    AUTOMATION_RECLAIM_EXHAUSTED, AutomationChange, AutomationChangeKind, AutomationClaimState,
    AutomationFactValue, AutomationFieldFact, AutomationSettle, AutomationSubscription,
    AutomationTrigger, ChangeActorKind, ChangeAttribution, VersionedTextStore, WriteText,
    subscribe_automation,
};
use dohc_engine_runtime::{
    CancellationToken, LifecycleState, NoFaults, RuntimeError, WorkspaceSupervisor,
};
use dohc_engine_storage::{EngineStore, FaultPoint, StorageError};
use dohc_engine_sync::{NoLiveLeases, ReplicationEnvelope, apply_ydoc_envelope};
use dohc_engine_testkit::{GateFaults, PanicFaults, ScratchDir, ScriptedFaults, engine_db_path};
use std::path::Path;
use std::sync::Arc;

const WS: &str = "ws-automation-claims";
const PATH: &str = "tasks/alpha.md";
const OBJECT: &str = "automation-claim-record-object";
const RECORD: &str = "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const AUTOMATION: &str = "plugin:triage";

/// Added and changed records under "tasks", on any field or only `field`.
fn subscription(automation_id: &str, field: Option<&str>) -> AutomationSubscription {
    AutomationSubscription {
        automation_id: automation_id.to_owned(),
        prefix: "tasks".to_owned(),
        kinds: vec![AutomationChangeKind::Added, AutomationChangeKind::Changed],
        fields: field.map(|field| vec![field.to_owned()]),
    }
}

fn seed_identity(db: &Path, workspace_id: &str) {
    let mut store = EngineStore::open(db, 9_103).expect("open store");
    store
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT OR IGNORE INTO sync_identity \
                 (workspace_id, origin_id, replication_epoch, stream_identity, created_at_ms) \
                 VALUES (?1, 'origin-local', 'epoch-local', 'stream-local', 1)",
                rusqlite::params![workspace_id],
            )
            .map_err(StorageError::persist_public)?;
            Ok::<_, StorageError>(())
        })
        .expect("seed identity");
}

/// Sync is genuinely on: identity plus a durable relay position.
fn enable_sync(db: &Path, workspace_id: &str) {
    seed_identity(db, workspace_id);
    let mut store = EngineStore::open(db, 9_106).expect("open store");
    store
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT OR IGNORE INTO sync_relay_push_state \
                 (workspace_id, origin_id, pushed_seq) VALUES (?1, 'origin-local', 0)",
                rusqlite::params![workspace_id],
            )
            .map_err(StorageError::persist_public)?;
            Ok::<_, StorageError>(())
        })
        .expect("enable sync");
}

fn seed_collection_replica(db: &Path, workspace_id: &str, object_id: &str, path: &str, text: &str) {
    let mut store = EngineStore::open(db, 9_110).expect("open collection replica");
    let mut versions = VersionedTextStore::new(&mut store);
    versions
        .ensure_main_version(workspace_id, "main", 1, &NoFaults)
        .expect("collection main version");
    versions
        .write_text(
            &WriteText {
                workspace_id: workspace_id.to_owned(),
                version_id: "main".to_owned(),
                object_id: "collection-schema-object".to_owned(),
                path: "tasks/collection.yaml".to_owned(),
                text: "fields:\n  status:\n    type: text\n".to_owned(),
                moment_id: "collection-schema-moment".to_owned(),
                metadata_origin: "test".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 2,
                request_id: None,
            },
            &NoFaults,
        )
        .expect("seed collection schema");
    versions
        .write_text(
            &WriteText {
                workspace_id: workspace_id.to_owned(),
                version_id: "main".to_owned(),
                object_id: object_id.to_owned(),
                path: path.to_owned(),
                text: text.to_owned(),
                moment_id: "collection-record-moment".to_owned(),
                metadata_origin: "test".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 3,
                request_id: None,
            },
            &NoFaults,
        )
        .expect("seed collection record");
    store
        .write_with(&NoFaults, |tx| {
            dohc_engine_domain::reconcile_collections_in_tx(tx, workspace_id, "main")?;
            dohc_engine_domain::set_collection_adoption_state_in_tx(
                tx,
                workspace_id,
                "main",
                path,
                RECORD,
                "adopted",
            )
        })
        .expect("bind adopted collection record");
}

#[derive(Debug, Clone)]
struct LoggedOp {
    origin_id: String,
    origin_seq: i64,
    op_kind: String,
    payload: serde_json::Value,
    recorded_at_ms: i64,
}

fn local_ydoc_ops(db: &Path) -> Vec<LoggedOp> {
    let store = EngineStore::open(db, 9_100).expect("open store");
    store
        .read_with(|conn| {
            let mut stmt = conn.prepare(
                "SELECT origin_id, origin_seq, op_kind, payload_json, recorded_at_ms \
                 FROM replication_log WHERE imported = 0 AND op_kind = 'ydoc.update' \
                 ORDER BY origin_id, origin_seq",
            )?;
            let rows = stmt
                .query_map([], |row| {
                    let payload: String = row.get(3)?;
                    Ok(LoggedOp {
                        origin_id: row.get(0)?,
                        origin_seq: row.get(1)?,
                        op_kind: row.get(2)?,
                        payload: serde_json::from_str(&payload).expect("payload json"),
                        recorded_at_ms: row.get(4)?,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?;
            Ok::<_, rusqlite::Error>(rows)
        })
        .expect("read local ops")
}

fn blob_bytes(db: &Path, sha: &str) -> Vec<u8> {
    let store = EngineStore::open(db, 9_104).expect("open store");
    store
        .get_binary_blob(sha)
        .expect("read blob")
        .expect("the journaled blob exists locally")
}

fn claim_rows(db: &Path, workspace_id: &str) -> Vec<(String, String, Option<String>, Option<i64>)> {
    let store = EngineStore::open(db, 9_120).expect("open store");
    store
        .read_with(|conn| {
            let mut stmt = conn.prepare(
                "SELECT automation_id, state, trigger_origin_id, trigger_origin_seq \
                 FROM automation_claims WHERE workspace_id = ?1 \
                 ORDER BY created_at_ms, claim_id",
            )?;
            let rows = stmt
                .query_map([workspace_id], |row| {
                    Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            Ok::<_, rusqlite::Error>(rows)
        })
        .expect("read claims")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_local_apply_claims_exactly_once_and_a_synced_apply_never_claims() {
    let initial = format!("---\nid: {RECORD}\nstatus: open\n---\n\nAlpha");
    let source_scratch = ScratchDir::new().expect("source scratch");
    let source_db = engine_db_path(&source_scratch).expect("source db");
    let peer_scratch = ScratchDir::new().expect("peer scratch");
    let peer_db = engine_db_path(&peer_scratch).expect("peer db");
    seed_collection_replica(&source_db, WS, OBJECT, PATH, &initial);
    seed_collection_replica(&peer_db, WS, OBJECT, PATH, &initial);
    enable_sync(&source_db, WS);

    let supervisor = WorkspaceSupervisor::new();
    let handle = supervisor
        .open(&source_db, 10)
        .expect("open source actor")
        .actor;
    let key = DocKey::new(WS, "main", OBJECT).expect("collection document key");
    let doc = Ydoc::wire();
    doc.rewrite_content_to_markdown(ContentKind::Richdoc, &initial)
        .expect("seed collection rich document");
    let base = handle
        .ydoc_record_update(
            key.clone(),
            PATH.to_owned(),
            ContentKind::Richdoc,
            Regime::LocalOnly,
            doc.encode_full_state(),
            None,
            None,
            None,
            true,
            None,
            None,
            100,
            Arc::new(NoFaults),
            CancellationToken::new(),
            None,
        )
        .await
        .expect("originate collection base");
    assert!(
        base.automation_claims.is_empty(),
        "nothing is subscribed yet, so the seed claims nothing"
    );

    handle
        .automation_subscribe(
            WS.to_owned(),
            subscription(AUTOMATION, None),
            150,
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("subscribe automation");
    // A second automation watches only another field: the status edit
    // below costs it nothing.
    handle
        .automation_subscribe(
            WS.to_owned(),
            subscription("collection:tasks#priority", Some("priority")),
            150,
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("subscribe field-filtered automation");

    let edit = doc.frontmatter_set("status", "done");
    let append = handle
        .ydoc_record_update(
            key.clone(),
            PATH.to_owned(),
            ContentKind::Richdoc,
            Regime::LocalOnly,
            edit.clone(),
            Some("agent-editor".to_owned()),
            Some(ChangeAttribution {
                actor_kind: ChangeActorKind::Agent,
                on_behalf_of: Some("user:ice".to_owned()),
                depth: 0,
            }),
            base.lineage_claim_id.clone(),
            false,
            None,
            None,
            200,
            Arc::new(NoFaults),
            CancellationToken::new(),
            None,
        )
        .await
        .expect("apply status edit");
    assert!(
        append.outcome.record_facts.is_some(),
        "the status edit derives record facts"
    );
    assert_eq!(
        append.automation_claims.len(),
        1,
        "one subscription, one committed change, exactly one claim"
    );
    let claim = &append.automation_claims[0];
    assert_eq!(claim.automation_id, AUTOMATION);
    assert_eq!(claim.state, AutomationClaimState::Pending);
    assert_eq!(claim.collection_path, "tasks");
    assert_eq!(claim.record_id, RECORD);
    let facts = append
        .outcome
        .record_facts
        .as_ref()
        .expect("the edit derives record facts");
    let (origin_id, origin_seq) = facts
        .source
        .clone()
        .expect("a journaled local apply carries its own coordinate");
    assert_eq!(
        claim.trigger,
        AutomationTrigger::Coordinate {
            origin_id,
            origin_seq,
        },
        "the claim key is the same coordinate every peer derives"
    );
    assert_eq!(
        claim.change,
        AutomationChange {
            kind: AutomationChangeKind::Changed,
            author_origin_id: Some("agent-editor".to_owned()),
            actor_kind: Some(ChangeActorKind::Agent),
            on_behalf_of: Some("user:ice".to_owned()),
        },
        "the claim names the change's kind and actor"
    );
    let (served, served_facts) = handle
        .automation_claim_next(
            WS.to_owned(),
            "plugin:".to_owned(),
            250,
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("claim next")
        .expect("the status claim is pending");
    assert_eq!(served.claim_id, claim.claim_id);
    assert_eq!(
        served_facts.fields,
        vec![AutomationFieldFact {
            field_name: "status".to_owned(),
            history_id: facts.fields[0].history_id,
            previous: Some(AutomationFactValue::Whole {
                value: serde_json::json!("open"),
            }),
            next: Some(AutomationFactValue::Whole {
                value: serde_json::json!("done"),
            }),
        }],
        "the served claim carries the field's previous and next values"
    );
    handle
        .automation_settle(
            WS.to_owned(),
            served.claim_id,
            AutomationSettle::Done,
            260,
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("settle the status claim");

    // The identical update again: the append dedupes, derives no facts, and
    // therefore claims nothing — one durable claim per change, ever.
    let replay = handle
        .ydoc_record_update(
            key.clone(),
            PATH.to_owned(),
            ContentKind::Richdoc,
            Regime::LocalOnly,
            edit,
            Some("agent-editor".to_owned()),
            None,
            append.lineage_claim_id.clone(),
            false,
            None,
            None,
            300,
            Arc::new(NoFaults),
            CancellationToken::new(),
            None,
        )
        .await
        .expect("replay the same update");
    assert!(
        replay.automation_claims.is_empty(),
        "a deduped replay inserts no second claim"
    );

    // A change already at the chain depth cap runs nothing: the automation
    // gets a failed `chain-stopped` claim instead of a pending one, so the
    // stop reaches the owner's failure surface.
    let capped = doc.frontmatter_set("status", "capped");
    let at_cap = handle
        .ydoc_record_update(
            key.clone(),
            PATH.to_owned(),
            ContentKind::Richdoc,
            Regime::LocalOnly,
            capped,
            Some("agent-editor".to_owned()),
            Some(ChangeAttribution {
                actor_kind: ChangeActorKind::Automation,
                on_behalf_of: Some("user:ice".to_owned()),
                depth: dohc_engine_domain::AUTOMATION_CHAIN_DEPTH_CAP,
            }),
            replay.lineage_claim_id.clone(),
            false,
            None,
            None,
            400,
            Arc::new(NoFaults),
            CancellationToken::new(),
            None,
        )
        .await
        .expect("apply depth-capped edit");
    assert!(
        at_cap.outcome.record_facts.is_some(),
        "the capped change itself commits"
    );
    assert_eq!(
        at_cap.automation_claims.len(),
        1,
        "the chain stops at the depth cap, and the stop is recorded"
    );
    assert_eq!(
        at_cap.automation_claims[0].state,
        dohc_engine_domain::AutomationClaimState::Failed,
    );
    assert_eq!(
        at_cap.automation_claims[0].error.as_deref(),
        Some(dohc_engine_domain::AUTOMATION_CHAIN_STOPPED),
    );

    // A priority edit wakes both automations.
    let priority = handle
        .ydoc_record_update(
            key.clone(),
            PATH.to_owned(),
            ContentKind::Richdoc,
            Regime::LocalOnly,
            doc.frontmatter_set("priority", "high"),
            None,
            Some(ChangeAttribution {
                actor_kind: ChangeActorKind::Human,
                on_behalf_of: None,
                depth: 0,
            }),
            at_cap.lineage_claim_id.clone(),
            false,
            None,
            None,
            500,
            Arc::new(NoFaults),
            CancellationToken::new(),
            None,
        )
        .await
        .expect("apply priority edit");
    assert_eq!(
        priority
            .automation_claims
            .iter()
            .map(|claim| claim.automation_id.as_str())
            .collect::<Vec<_>>(),
        vec!["collection:tasks#priority", AUTOMATION],
    );
    // Each executor drains only its own namespace.
    let (collection_claim, _) = handle
        .automation_claim_next(
            WS.to_owned(),
            "collection:".to_owned(),
            510,
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("claim next")
        .expect("the collection claim is pending");
    assert_eq!(collection_claim.automation_id, "collection:tasks#priority");
    assert_eq!(
        collection_claim.change.actor_kind,
        Some(ChangeActorKind::Human)
    );
    assert!(
        handle
            .automation_claim_next(
                WS.to_owned(),
                "collection:".to_owned(),
                520,
                Arc::new(NoFaults),
                CancellationToken::new(),
            )
            .await
            .expect("claim next")
            .is_none(),
        "the plugin automation's claim waits for its own executor"
    );
    supervisor.close(&source_db).expect("close source actor");

    let source_claims = claim_rows(&source_db, WS);
    assert_eq!(
        source_claims.len(),
        4,
        "the origin device holds exactly one claim per automation per change, \
         plus the recorded chain stop: {source_claims:?}"
    );
    assert_eq!(source_claims[1].1, "failed", "the stop row is terminal");

    // The peer applies the same ops by replication, with the same
    // subscription registered — and claims nothing: the sync apply path has
    // no claim hook (ADR 0008's origin test is structural).
    let mut peer = EngineStore::open(&peer_db, 300).expect("open peer store");
    subscribe_automation(
        &mut peer,
        WS,
        &subscription(AUTOMATION, None),
        310,
        &NoFaults,
    )
    .expect("peer subscribes the same automation");
    let ops = local_ydoc_ops(&source_db);
    assert!(ops.len() >= 2, "base plus edits journaled: {}", ops.len());
    let first_origin_seq = ops[0].origin_seq;
    for op in &ops {
        let sha = op.payload["updateBlobSha256"]
            .as_str()
            .expect("every ydoc.update names its blob")
            .to_owned();
        let bytes = blob_bytes(&source_db, &sha);
        peer.put_binary_blob(&bytes).expect("copy Y.Doc blob");
        let envelope = ReplicationEnvelope {
            workspace_id: WS.to_owned(),
            origin_id: op.origin_id.clone(),
            origin_seq: op.origin_seq - first_origin_seq,
            relay_seq: Some(op.origin_seq - first_origin_seq),
            op_kind: op.op_kind.clone(),
            payload: op.payload.clone(),
            recorded_at_ms: op.recorded_at_ms,
        };
        apply_ydoc_envelope(
            &mut peer,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &envelope,
            &NoFaults,
            &NoLiveLeases,
        )
        .expect("peer applies replicated collection edit");
    }
    drop(peer);
    let peer_claims = claim_rows(&peer_db, WS);
    assert!(
        peer_claims.is_empty(),
        "the non-origin device never claims: {peer_claims:?}"
    );
}

// ---------------------------------------------------------------------------
// The claim ledger's crash tier: a claim is served at most once per attempt,
// a crashed settle rolls back to running for the open-time reaper, and the
// attempt bound turns an exhausted claim terminally failed.
// ---------------------------------------------------------------------------

const CRASH_CLAIM: &str = "atc_crash_recovery_claim";

/// A pending claim seeded straight into the ledger (History trigger shape),
/// so the crash tests exercise the claim/settle/reclaim transitions alone.
fn seed_pending_claim(db: &Path, workspace_id: &str, claim_id: &str, now_ms: i64) {
    let mut store = EngineStore::open(db, 9_130).expect("open store");
    store
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT INTO automation_claims \
                 (workspace_id, claim_id, automation_id, trigger_history_id, \
                  record_id, collection_path, depth, state, attempts, \
                  created_at_ms, updated_at_ms) \
                 VALUES (?1, ?2, ?3, 1, ?4, 'tasks', 0, 'pending', 0, ?5, ?5)",
                rusqlite::params![workspace_id, claim_id, AUTOMATION, RECORD, now_ms],
            )
            .map_err(StorageError::persist_public)?;
            Ok::<_, StorageError>(())
        })
        .expect("seed pending claim");
}

fn claim_ledger(db: &Path, workspace_id: &str, claim_id: &str) -> (String, i64, Option<String>) {
    let store = EngineStore::open(db, 9_131).expect("open store");
    store
        .read_with(|conn| {
            conn.query_row(
                "SELECT state, attempts, error FROM automation_claims \
                 WHERE workspace_id = ?1 AND claim_id = ?2",
                rusqlite::params![workspace_id, claim_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
        })
        .expect("read claim ledger")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_crashed_settle_stays_running_and_the_reaper_requeues_then_exhausts() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = engine_db_path(&scratch).expect("db");
    seed_pending_claim(&db, WS, CRASH_CLAIM, 100);

    let supervisor = WorkspaceSupervisor::new();
    let handle = supervisor.open(&db, 1).expect("open actor").actor;

    // Attempt 1: the claim is served exactly once.
    let (claim, _) = handle
        .automation_claim_next(
            WS.to_owned(),
            "plugin:".to_owned(),
            200,
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("claim next")
        .expect("the seeded claim is pending");
    assert_eq!(claim.claim_id, CRASH_CLAIM);
    assert_eq!(claim.state, AutomationClaimState::Running);
    assert_eq!(claim.attempts, 1);
    let none = handle
        .automation_claim_next(
            WS.to_owned(),
            "plugin:".to_owned(),
            210,
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("claim next again");
    assert!(
        none.is_none(),
        "a running claim is never served twice within one attempt"
    );

    // The settle crashes inside its transaction, before the commit is
    // durable: the done transition rolls back whole.
    let faults = ScriptedFaults::crash_at(FaultPoint::StorageBeforePersist);
    handle
        .automation_settle(
            WS.to_owned(),
            CRASH_CLAIM.to_owned(),
            AutomationSettle::Done,
            300,
            faults.clone(),
            CancellationToken::new(),
        )
        .await
        .expect_err("the injected mid-settle crash surfaces as an error");
    assert!(faults.fired());
    supervisor.close(&db).expect("close after settle crash");
    assert_eq!(
        claim_ledger(&db, WS, CRASH_CLAIM),
        ("running".to_owned(), 1, None),
        "a crashed settle leaves the claim running for the reaper"
    );

    // Restart: the open-time reaper requeues the stale running claim, and
    // the next claim serves it again as attempt 2.
    let handle = supervisor.open(&db, 2).expect("reopen actor").actor;
    let reclaimed = handle
        .automation_reclaim_running(
            WS.to_owned(),
            None,
            2,
            1_000,
            1_000,
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("reclaim after restart");
    assert_eq!(reclaimed.len(), 1);
    assert_eq!(reclaimed[0].state, AutomationClaimState::Pending);
    let (claim, _) = handle
        .automation_claim_next(
            WS.to_owned(),
            "plugin:".to_owned(),
            1_100,
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("claim next after requeue")
        .expect("the requeued claim is served again");
    assert_eq!(claim.attempts, 2, "the retry is a new attempt");

    // A second crashed settle exhausts the attempt bound: the reaper turns
    // the claim terminally failed with the reclaim-exhausted reason, and it
    // is never served again.
    let faults = ScriptedFaults::crash_at(FaultPoint::StorageBeforePersist);
    handle
        .automation_settle(
            WS.to_owned(),
            CRASH_CLAIM.to_owned(),
            AutomationSettle::Done,
            1_200,
            faults.clone(),
            CancellationToken::new(),
        )
        .await
        .expect_err("the second injected mid-settle crash surfaces as an error");
    assert!(faults.fired());
    supervisor
        .close(&db)
        .expect("close after second settle crash");

    let handle = supervisor.open(&db, 3).expect("reopen actor twice").actor;
    let reclaimed = handle
        .automation_reclaim_running(
            WS.to_owned(),
            None,
            2,
            2_000,
            2_000,
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("exhausting reclaim");
    assert_eq!(reclaimed.len(), 1);
    assert_eq!(reclaimed[0].state, AutomationClaimState::Failed);
    assert_eq!(
        reclaimed[0].error.as_deref(),
        Some(AUTOMATION_RECLAIM_EXHAUSTED)
    );
    let none = handle
        .automation_claim_next(
            WS.to_owned(),
            "plugin:".to_owned(),
            2_100,
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("claim next after exhaustion");
    assert!(none.is_none(), "a terminally failed claim is never served");
    supervisor.close(&db).expect("close at end");
    assert_eq!(
        claim_ledger(&db, WS, CRASH_CLAIM),
        (
            "failed".to_owned(),
            2,
            Some(AUTOMATION_RECLAIM_EXHAUSTED.to_owned())
        )
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_crashed_claim_next_rolls_back_and_the_retry_serves_one_attempt() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = engine_db_path(&scratch).expect("db");
    seed_pending_claim(&db, WS, CRASH_CLAIM, 100);

    let supervisor = WorkspaceSupervisor::new();
    let handle = supervisor.open(&db, 1).expect("open actor").actor;
    let faults = ScriptedFaults::crash_at(FaultPoint::StorageBeforePersist);
    handle
        .automation_claim_next(
            WS.to_owned(),
            "plugin:".to_owned(),
            200,
            faults.clone(),
            CancellationToken::new(),
        )
        .await
        .expect_err("the injected mid-claim crash surfaces as an error");
    assert!(faults.fired());
    supervisor.close(&db).expect("close after claim crash");
    assert_eq!(
        claim_ledger(&db, WS, CRASH_CLAIM),
        ("pending".to_owned(), 0, None),
        "a crashed claim rolls back whole: still pending, no attempt spent"
    );

    // Restart: the retry serves the claim exactly once, as attempt 1.
    let handle = supervisor.open(&db, 2).expect("reopen actor").actor;
    let (claim, _) = handle
        .automation_claim_next(
            WS.to_owned(),
            "plugin:".to_owned(),
            300,
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("claim next after restart")
        .expect("the rolled-back claim is still pending");
    assert_eq!(claim.claim_id, CRASH_CLAIM);
    assert_eq!(claim.attempts, 1);
    let settled = handle
        .automation_settle(
            WS.to_owned(),
            CRASH_CLAIM.to_owned(),
            AutomationSettle::Done,
            400,
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("settle done");
    assert_eq!(settled.state, AutomationClaimState::Done);
    supervisor.close(&db).expect("close at end");
    assert_eq!(
        claim_ledger(&db, WS, CRASH_CLAIM),
        ("done".to_owned(), 1, None)
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_cancelled_token_short_circuits_every_automation_command_without_writing() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = engine_db_path(&scratch).expect("db");
    seed_pending_claim(&db, WS, CRASH_CLAIM, 100);

    let supervisor = WorkspaceSupervisor::new();
    let handle = supervisor.open(&db, 1).expect("open actor").actor;
    let cancelled = CancellationToken::new();
    cancelled.cancel();
    let error = handle
        .automation_claim_next(
            WS.to_owned(),
            "plugin:".to_owned(),
            200,
            Arc::new(NoFaults),
            cancelled.clone(),
        )
        .await
        .expect_err("a cancelled claim next returns the cancellation error");
    assert!(matches!(error, RuntimeError::Cancelled));
    let error = handle
        .automation_reclaim_running(
            WS.to_owned(),
            None,
            2,
            1_000,
            1_000,
            Arc::new(NoFaults),
            cancelled.clone(),
        )
        .await
        .expect_err("a cancelled reclaim returns the cancellation error");
    assert!(matches!(error, RuntimeError::Cancelled));
    let error = handle
        .automation_settle(
            WS.to_owned(),
            CRASH_CLAIM.to_owned(),
            AutomationSettle::Done,
            300,
            Arc::new(NoFaults),
            cancelled.clone(),
        )
        .await
        .expect_err("a cancelled settle returns the cancellation error");
    assert!(matches!(error, RuntimeError::Cancelled));
    let error = handle
        .automation_retry(
            WS.to_owned(),
            CRASH_CLAIM.to_owned(),
            300,
            Arc::new(NoFaults),
            cancelled.clone(),
        )
        .await
        .expect_err("a cancelled retry returns the cancellation error");
    assert!(matches!(error, RuntimeError::Cancelled));
    let error = handle
        .automation_subscribe(
            WS.to_owned(),
            subscription(AUTOMATION, None),
            400,
            Arc::new(NoFaults),
            cancelled.clone(),
        )
        .await
        .expect_err("a cancelled subscribe returns the cancellation error");
    assert!(matches!(error, RuntimeError::Cancelled));
    let error = handle
        .automation_unsubscribe(
            WS.to_owned(),
            AUTOMATION.to_owned(),
            "tasks".to_owned(),
            Arc::new(NoFaults),
            cancelled,
        )
        .await
        .expect_err("a cancelled unsubscribe returns the cancellation error");
    assert!(matches!(error, RuntimeError::Cancelled));
    supervisor.close(&db).expect("close at end");
    assert_eq!(
        claim_ledger(&db, WS, CRASH_CLAIM),
        ("pending".to_owned(), 0, None),
        "a cancelled command writes nothing"
    );
    let subscriptions: i64 = {
        let conn = rusqlite::Connection::open(&db).expect("open db");
        conn.query_row(
            "SELECT COUNT(*) FROM automation_subscriptions WHERE workspace_id = ?1",
            [WS],
            |row| row.get(0),
        )
        .expect("count subscriptions")
    };
    assert_eq!(subscriptions, 0, "a cancelled subscribe registers nothing");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn abandoning_a_claim_request_does_not_cancel_its_admitted_transaction() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = engine_db_path(&scratch).expect("db");
    seed_pending_claim(&db, WS, CRASH_CLAIM, 100);
    let supervisor = WorkspaceSupervisor::new();
    let handle = supervisor.open(&db, 1).expect("open actor").actor;
    let gate = GateFaults::at(FaultPoint::StorageBeforePersist);
    let requester = {
        let handle = handle.clone();
        let gate = Arc::clone(&gate);
        tokio::spawn(async move {
            handle
                .automation_claim_next(
                    WS.to_owned(),
                    "plugin:".to_owned(),
                    200,
                    gate,
                    CancellationToken::new(),
                )
                .await
        })
    };
    let waiting = Arc::clone(&gate);
    tokio::task::spawn_blocking(move || waiting.wait_until_reached())
        .await
        .expect("claim reached the transaction gate");
    requester.abort();
    let abandoned = requester.await;
    gate.release();
    assert!(abandoned.expect_err("requester aborted").is_cancelled());

    let running = handle
        .automation_running_attempts(WS.to_owned())
        .await
        .expect("read after the admitted claim");
    assert_eq!(running.len(), 1);
    assert_eq!(running[0].claim_id, CRASH_CLAIM);
    supervisor.close(&db).expect("close after draining");
    assert_eq!(
        claim_ledger(&db, WS, CRASH_CLAIM),
        ("running".to_owned(), 1, None),
        "losing the reply receiver does not roll back admitted work"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_panicked_claim_rolls_back_and_closes_async_and_blocking_handles() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = engine_db_path(&scratch).expect("db");
    seed_pending_claim(&db, WS, CRASH_CLAIM, 100);
    let supervisor = WorkspaceSupervisor::new();
    let handle = supervisor.open(&db, 1).expect("open actor").actor;
    let blocking = handle.clone();
    assert!(
        !std::thread::spawn(move || blocking.secret_state_exists_blocking(WS.to_owned()))
            .join()
            .expect("join blocking read")
            .expect("empty secret state")
    );

    let error = handle
        .automation_claim_next(
            WS.to_owned(),
            "plugin:".to_owned(),
            200,
            PanicFaults::at(FaultPoint::StorageBeforePersist),
            CancellationToken::new(),
        )
        .await
        .expect_err("panic drops the command reply");
    assert!(matches!(error, RuntimeError::ActorUnavailable));
    assert!(matches!(
        supervisor.close(&db),
        Err(RuntimeError::WorkerPanicked)
    ));
    assert_eq!(handle.lifecycle(), LifecycleState::Closed);
    assert!(matches!(
        handle.automation_running_attempts(WS.to_owned()).await,
        Err(RuntimeError::ActorUnavailable)
    ));
    assert!(matches!(
        std::thread::spawn(move || handle.secret_state_exists_blocking(WS.to_owned()))
            .join()
            .expect("join closed blocking read"),
        Err(RuntimeError::ActorUnavailable)
    ));
    assert_eq!(
        claim_ledger(&db, WS, CRASH_CLAIM),
        ("pending".to_owned(), 0, None),
        "a panicked transaction never commits its claim"
    );
}
