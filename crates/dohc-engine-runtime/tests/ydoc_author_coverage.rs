//! Settlement consumes admission coverage, including edits that only delete content.

use dohc_engine_collab::{ContentKind, DocKey, Regime, Ydoc, author_coverage};
use dohc_engine_domain::{ChangeActorKind, ChangeAttribution};
use dohc_engine_runtime::{ActorHandle, CancellationToken, WorkspaceSupervisor, YdocOpenState};
use dohc_engine_storage::{
    EngineStore, FaultAction, FaultInjector, FaultPoint, NoFaults, StorageError,
};
use dohc_engine_testkit::{ScratchDir, ScriptedFaults, engine_db_path};
use serde_json::Value;
use std::{
    path::Path,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Instant,
};

const WS: &str = "author-coverage";
const FILE: &str = "authors.txt";

struct NthStorageCrash {
    point: FaultPoint,
    remaining: AtomicUsize,
}
impl FaultInjector for NthStorageCrash {
    fn poll(&self, point: FaultPoint) -> FaultAction {
        if point == self.point && self.remaining.fetch_sub(1, Ordering::SeqCst) == 1 {
            FaultAction::Crash
        } else {
            FaultAction::Continue
        }
    }
}

async fn open(actor: &ActorHandle) -> YdocOpenState {
    actor
        .ydoc_open_state(
            WS.into(),
            1,
            true,
            None,
            "main".into(),
            FILE.into(),
            Some(ContentKind::Plaintext),
            CancellationToken::new(),
        )
        .await
        .expect("open document")
}

async fn append(actor: &ActorHandle, key: &DocKey, bytes: Vec<u8>, id: &str) {
    actor
        .ydoc_record_update(
            key.clone(),
            FILE.into(),
            ContentKind::Plaintext,
            Regime::LocalOnly,
            bytes,
            Some(id.into()),
            Some(ChangeAttribution {
                actor_kind: ChangeActorKind::Agent,
                on_behalf_of: Some("person".into()),
                depth: 0,
            }),
            None,
            false,
            None,
            None,
            2,
            Arc::new(NoFaults),
            CancellationToken::new(),
            None,
        )
        .await
        .expect("admit edit");
}

async fn settle(
    actor: &ActorHandle,
    root: &Path,
    state: &YdocOpenState,
    faults: Arc<dyn FaultInjector>,
) -> Result<dohc_engine_runtime::YdocSettleOutcome, dohc_engine_runtime::RuntimeError> {
    actor
        .ydoc_settle(
            root.into(),
            state.key.clone(),
            FILE.into(),
            ContentKind::Plaintext,
            state.lineage_claim_id.clone(),
            state.head_blob_sha256.clone(),
            "coverage-session".into(),
            Arc::new(()),
            3,
            faults,
            CancellationToken::new(),
            None,
        )
        .await
}

fn coverage(db: &Path) -> (i64, Option<i64>, String, Option<i64>) {
    let store = EngineStore::open(db, 4).expect("inspect store");
    store.read_with(|conn| conn.query_row(
        "SELECT head_update_seq,settled_update_seq,pending_authors_json,settle_prior_update_seq FROM ydoc_docs",
        [], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?)))
        .map_err(StorageError::persist_public)).expect("coverage")
}

fn authors(db: &Path) -> Vec<Value> {
    let store = EngineStore::open(db, 4).expect("inspect store");
    store
        .read_with(|conn| {
            let mut stmt = conn
                .prepare("SELECT author_json FROM moments ORDER BY moment_order")
                .map_err(StorageError::persist_public)?;
            let rows = stmt
                .query_map([], |row| row.get::<_, Option<String>>(0))
                .map_err(StorageError::persist_public)?;
            rows.map(|row| {
                row.map(|raw| {
                    raw.map_or(Value::Null, |raw| {
                        serde_json::from_str(&raw).expect("author list")
                    })
                })
            })
            .collect::<Result<Vec<_>, _>>()
            .map_err(StorageError::persist_public)
        })
        .expect("moments")
}

fn ids(value: &Value) -> Vec<&str> {
    value
        .as_array()
        .expect("list")
        .iter()
        .map(|author| author["agentId"].as_str().expect("agent"))
        .collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn compaction_deletion_undo_noop_and_close_keep_interval_authors() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = engine_db_path(&scratch).expect("db");
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 1).expect("actor").actor;
    let state = open(&actor).await;
    let doc = Ydoc::wire();
    for index in 0..128 {
        append(
            &actor,
            &state.key,
            doc.plaintext_insert(index, "x"),
            if index % 2 == 0 { "alice" } else { "bob" },
        )
        .await;
    }
    let before = coverage(&db);
    assert_eq!(before.0, 128);
    assert_eq!(
        ids(&serde_json::from_str(&before.2).expect("pending")),
        ["alice", "bob"]
    );
    let started = Instant::now();
    settle(&actor, scratch.path(), &state, Arc::new(NoFaults))
        .await
        .expect("settle");
    println!(
        "AUTHOR_MEASURE settlement_128_updates_us={} pending_metadata_bytes={}",
        started.elapsed().as_micros(),
        before.2.len()
    );
    assert_eq!(ids(&authors(&db)[0]), ["alice", "bob"]);
    assert_eq!(coverage(&db), (128, Some(128), "[]".into(), None));

    append(&actor, &state.key, doc.plaintext_delete(0, 1), "deleter").await;
    settle(&actor, scratch.path(), &state, Arc::new(NoFaults))
        .await
        .expect("deletion");
    assert_eq!(ids(authors(&db).last().expect("moment")), ["deleter"]);
    append(&actor, &state.key, doc.plaintext_insert(0, "x"), "undoer").await;
    settle(&actor, scratch.path(), &state, Arc::new(NoFaults))
        .await
        .expect("undo");
    assert_eq!(ids(authors(&db).last().expect("moment")), ["undoer"]);

    append(
        &actor,
        &state.key,
        doc.plaintext_delete(0, 1),
        "noop-delete",
    )
    .await;
    append(
        &actor,
        &state.key,
        doc.plaintext_insert(0, "x"),
        "noop-undo",
    )
    .await;
    assert!(
        actor
            .ydoc_close_session(
                state.key.clone(),
                4,
                Arc::new(NoFaults),
                CancellationToken::new()
            )
            .await
            .is_err(),
        "matching bytes do not cover admitted authors"
    );
    let count = authors(&db).len();
    settle(&actor, scratch.path(), &state, Arc::new(NoFaults))
        .await
        .expect("no-op");
    assert_eq!(authors(&db).len(), count);
    assert_eq!(coverage(&db).2, "[]");
    actor
        .ydoc_close_session(state.key, 4, Arc::new(NoFaults), CancellationToken::new())
        .await
        .expect("covered close");
    supervisor.close(&db).expect("stop actor");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn settlement_crashes_restart_without_losing_or_repeating_authors() {
    for point in [
        FaultPoint::StorageBeforePersist,
        FaultPoint::StorageAfterCommitBeforeAck,
        FaultPoint::MaterializeAfterJobCommit,
        FaultPoint::MaterializeAfterTempWrite,
        FaultPoint::MaterializeAfterFlushBeforeRename,
        FaultPoint::MaterializeAfterRenameBeforeComplete,
    ] {
        let scratch = ScratchDir::new().expect("scratch");
        let db = engine_db_path(&scratch).expect("db");
        let supervisor = WorkspaceSupervisor::new();
        let actor = supervisor.open(&db, 1).expect("actor").actor;
        let state = open(&actor).await;
        let doc = Ydoc::wire();
        append(
            &actor,
            &state.key,
            doc.plaintext_insert(0, "before crash"),
            "alice",
        )
        .await;
        let fault = ScriptedFaults::crash_at(point);
        assert!(
            settle(&actor, scratch.path(), &state, fault).await.is_err(),
            "{point:?}"
        );
        supervisor.close(&db).expect("stop actor");
        drop(actor);
        let actor = supervisor.open(&db, 5).expect("restart").actor;
        settle(&actor, scratch.path(), &state, Arc::new(NoFaults))
            .await
            .expect("recover");
        assert_eq!(authors(&db).len(), 1, "{point:?}");
        assert_eq!(ids(&authors(&db)[0]), ["alice"], "{point:?}");
        assert_eq!(coverage(&db), (1, Some(1), "[]".into(), None));
        supervisor.close(&db).expect("stop actor");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn terminal_job_commit_before_compensation_recovers_with_concurrent_arrivals() {
    for status in ["conflict", "cancelled", "complete", "superseded"] {
        for point in [
            FaultPoint::StorageBeforePersist,
            FaultPoint::StorageAfterCommitBeforeAck,
        ] {
            let scratch = ScratchDir::new().expect("scratch");
            let db = engine_db_path(&scratch).expect("db");
            let supervisor = WorkspaceSupervisor::new();
            let actor = supervisor.open(&db, 1).expect("actor").actor;
            let state = open(&actor).await;
            let doc = Ydoc::wire();
            append(&actor, &state.key, doc.plaintext_insert(0, "a"), "alice").await;
            settle(&actor, scratch.path(), &state, Arc::new(NoFaults))
                .await
                .expect("first interval");
            append(&actor, &state.key, doc.plaintext_insert(1, "b"), "bob").await;
            assert!(
                settle(
                    &actor,
                    scratch.path(),
                    &state,
                    ScriptedFaults::crash_at(FaultPoint::MaterializeAfterJobCommit)
                )
                .await
                .is_err()
            );
            append(&actor, &state.key, doc.plaintext_insert(2, "c"), "carol").await;
            supervisor.close(&db).expect("stop");
            drop(actor);
            {
                let mut store = EngineStore::open(&db, 6).expect("crashed store");
                store.write_with(&NoFaults, |tx| {
                tx.execute("UPDATE materialization_jobs SET status=?1,completed_at_ms=6 WHERE status='pending'",[if status == "superseded" { "cancelled" } else { status }]).map_err(StorageError::persist_public)?;
                if status=="superseded" {
                    tx.execute("INSERT INTO materialization_jobs (job_id,workspace_id,target_path,content_sha256,preimage_present,target_generation,status,created_at_ms,completed_at_ms) \
                        SELECT 'newer',workspace_id,target_path,content_sha256,preimage_present,target_generation+1,'complete',created_at_ms,5 FROM materialization_jobs ORDER BY target_generation DESC LIMIT 1",[]).map_err(StorageError::persist_public)?;
                }
                Ok::<_,StorageError>(())
            }).expect("terminal job commits before compensation");
                dohc_engine_collab::maybe_compact(&mut store, &state.key, 0, &NoFaults, 6)
                    .expect("compact concurrent arrival");
                let outcome = store
                    .write_with(ScriptedFaults::crash_at(point).as_ref(), |tx| {
                        author_coverage::reconcile_in(tx, &state.key, 6)
                    })
                    .expect("crash reconciliation");
                assert!(matches!(
                    outcome,
                    dohc_engine_storage::TxnOutcome::Crashed { .. }
                ));
            }
            let actor = supervisor.open(&db, 7).expect("restart").actor;
            actor
                .materialize_replay_pending(scratch.path().into(), WS.into(), 8)
                .await
                .expect("startup reconciliation");
            let recovered = coverage(&db);
            assert_eq!(
                recovered.1,
                Some(if status == "complete" { 2 } else { 1 }),
                "{status}"
            );
            assert_eq!(recovered.3, None);
            assert_eq!(
                ids(&serde_json::from_str(&recovered.2).expect("pending")),
                if status == "complete" {
                    vec!["carol"]
                } else {
                    vec!["bob", "carol"]
                }
            );
            assert_eq!(authors(&db).len(), 2, "failed moment retained");
            supervisor.close(&db).expect("stop");
            let mut store = EngineStore::open(&db, 9).expect("inspect");
            store
                .write_with(&NoFaults, |tx| {
                    author_coverage::compensate_in(tx, &state.key, None, 9)
                })
                .expect("repeat compensation");
            drop(store);
            assert_eq!(coverage(&db), recovered, "idempotent compensation");
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn completion_clear_noop_and_close_crashes_restart_idempotently() {
    for phase in ["completion", "noop", "close"] {
        for point in [
            FaultPoint::StorageBeforePersist,
            FaultPoint::StorageAfterCommitBeforeAck,
        ] {
            let scratch = ScratchDir::new().expect("scratch");
            let db = engine_db_path(&scratch).expect("db");
            let supervisor = WorkspaceSupervisor::new();
            let actor = supervisor.open(&db, 1).expect("actor").actor;
            let state = open(&actor).await;
            let doc = Ydoc::wire();
            append(&actor, &state.key, doc.plaintext_insert(0, "x"), "alice").await;
            if phase == "completion" {
                let faults = Arc::new(NthStorageCrash {
                    point,
                    remaining: AtomicUsize::new(1),
                });
                assert!(
                    settle(&actor, scratch.path(), &state, faults)
                        .await
                        .is_err()
                );
            } else {
                settle(&actor, scratch.path(), &state, Arc::new(NoFaults))
                    .await
                    .expect("first");
                if phase == "noop" {
                    append(&actor, &state.key, doc.plaintext_delete(0, 1), "bob").await;
                    append(&actor, &state.key, doc.plaintext_insert(0, "x"), "carol").await;
                    assert!(
                        settle(
                            &actor,
                            scratch.path(),
                            &state,
                            ScriptedFaults::crash_at(point)
                        )
                        .await
                        .is_err()
                    );
                } else {
                    assert!(
                        actor
                            .ydoc_close_session(
                                state.key.clone(),
                                4,
                                Arc::new(NthStorageCrash {
                                    point,
                                    remaining: AtomicUsize::new(1)
                                }),
                                CancellationToken::new()
                            )
                            .await
                            .is_err()
                    );
                }
            }
            supervisor.close(&db).expect("stop");
            drop(actor);
            if phase == "close" {
                assert_eq!(
                    coverage(&db).0,
                    if point == FaultPoint::StorageBeforePersist {
                        1
                    } else {
                        0
                    }
                );
            }
            let actor = supervisor.open(&db, 5).expect("restart").actor;
            if phase == "close" {
                actor
                    .ydoc_close_session(
                        state.key.clone(),
                        6,
                        Arc::new(NoFaults),
                        CancellationToken::new(),
                    )
                    .await
                    .expect("retry close");
            } else {
                settle(&actor, scratch.path(), &state, Arc::new(NoFaults))
                    .await
                    .expect("retry settlement");
                assert_eq!(coverage(&db).2, "[]");
                assert_eq!(coverage(&db).3, None);
            }
            assert_eq!(authors(&db).len(), 1, "{phase} {point:?}");
            assert_eq!(
                std::fs::read_to_string(scratch.path().join(FILE)).expect("artifact"),
                "x"
            );
            supervisor.close(&db).expect("stop");
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pending_attempt_reserves_capacity_without_requeueing_settlement() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = engine_db_path(&scratch).expect("db");
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 1).expect("actor").actor;
    let state = open(&actor).await;
    let doc = Ydoc::wire();
    append(&actor, &state.key, doc.plaintext_insert(0, "x"), "reserved").await;
    assert!(
        settle(
            &actor,
            scratch.path(),
            &state,
            ScriptedFaults::crash_at(FaultPoint::MaterializeAfterJobCommit)
        )
        .await
        .is_err()
    );
    for index in 1..1024 {
        let result = actor
            .ydoc_record_update(
                state.key.clone(),
                FILE.into(),
                ContentKind::Plaintext,
                Regime::LocalOnly,
                doc.plaintext_insert(index, "x"),
                Some(format!("agent-{index}")),
                Some(ChangeAttribution {
                    actor_kind: ChangeActorKind::Agent,
                    on_behalf_of: Some("person".into()),
                    depth: 0,
                }),
                None,
                false,
                None,
                None,
                2,
                Arc::new(NoFaults),
                CancellationToken::new(),
                None,
            )
            .await
            .expect("admit");
        assert!(
            !result.settlement_requested,
            "an unresolved attempt must not requeue"
        );
    }
    let refused = actor
        .ydoc_record_update(
            state.key.clone(),
            FILE.into(),
            ContentKind::Plaintext,
            Regime::LocalOnly,
            doc.plaintext_insert(1024, "y"),
            Some("new-agent".into()),
            Some(ChangeAttribution {
                actor_kind: ChangeActorKind::Agent,
                on_behalf_of: Some("person".into()),
                depth: 0,
            }),
            None,
            false,
            None,
            None,
            2,
            Arc::new(NoFaults),
            CancellationToken::new(),
            None,
        )
        .await;
    assert!(matches!(
        refused,
        Err(dohc_engine_runtime::RuntimeError::Collab(
            dohc_engine_collab::CollabError::AuthorCapacity
        ))
    ));
    let peer = dohc_engine_collab::load_persisted(
        &EngineStore::open(&db, 3).expect("inspect"),
        &state.key,
    )
    .expect("load")
    .expect("doc")
    .doc;
    append(
        &actor,
        &state.key,
        peer.plaintext_insert(1024, "z"),
        "reserved",
    )
    .await;
    assert_eq!(coverage(&db).0, 1025);
    assert!(coverage(&db).3.is_some());
    assert!(
        actor
            .ydoc_close_session(
                state.key.clone(),
                4,
                Arc::new(NoFaults),
                CancellationToken::new()
            )
            .await
            .is_err()
    );
    supervisor.close(&db).expect("stop");
    drop(actor);
    let actor = supervisor.open(&db, 5).expect("restart").actor;
    settle(&actor, scratch.path(), &state, Arc::new(NoFaults))
        .await
        .expect("replay then settle arrivals");
    assert_eq!(
        authors(&db)
            .last()
            .expect("arrivals")
            .as_array()
            .expect("authors")
            .len(),
        1024
    );
    assert_eq!(coverage(&db).3, None);
    supervisor.close(&db).expect("stop");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn exact_head_noop_restores_close_proof_across_crash_and_restart() {
    for point in [
        FaultPoint::StorageBeforePersist,
        FaultPoint::StorageAfterCommitBeforeAck,
    ] {
        let scratch = ScratchDir::new().expect("scratch");
        let db = engine_db_path(&scratch).expect("db");
        let supervisor = WorkspaceSupervisor::new();
        let actor = supervisor.open(&db, 1).expect("actor").actor;
        let state = open(&actor).await;
        let doc = Ydoc::wire();
        append(
            &actor,
            &state.key,
            doc.plaintext_insert(0, "same bytes"),
            "alice",
        )
        .await;
        settle(&actor, scratch.path(), &state, Arc::new(NoFaults))
            .await
            .expect("first settle");
        actor
            .ydoc_close_session(state.key, 4, Arc::new(NoFaults), CancellationToken::new())
            .await
            .expect("first close");
        let reopened = open(&actor).await;
        let peer = Ydoc::wire();
        append(
            &actor,
            &reopened.key,
            peer.plaintext_insert(0, "same bytes"),
            "bob",
        )
        .await;
        let count = authors(&db).len();
        assert!(
            settle(
                &actor,
                scratch.path(),
                &reopened,
                ScriptedFaults::crash_at(point)
            )
            .await
            .is_err()
        );
        supervisor.close(&db).expect("stop");
        drop(actor);
        let actor = supervisor.open(&db, 5).expect("restart").actor;
        settle(&actor, scratch.path(), &reopened, Arc::new(NoFaults))
            .await
            .expect("retry no-op");
        assert_eq!(authors(&db).len(), count, "no-op creates no moment");
        assert_eq!(coverage(&db), (1, Some(1), "[]".into(), None));
        actor
            .ydoc_close_session(
                reopened.key,
                6,
                Arc::new(NoFaults),
                CancellationToken::new(),
            )
            .await
            .expect("verified artifact permits close");
        supervisor.close(&db).expect("stop");
    }
}
