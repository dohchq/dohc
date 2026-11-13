//! Settlement consumes admission coverage, including edits that only delete content.

use dohc_engine_collab::{ContentKind, DocKey, Regime, Ydoc, author_coverage};
use dohc_engine_domain::{ChangeActorKind, ChangeAttribution};
use dohc_engine_runtime::{ActorHandle, CancellationToken, WorkspaceSupervisor, YdocOpenState};
use dohc_engine_storage::{EngineStore, FaultInjector, FaultPoint, NoFaults, StorageError};
use dohc_engine_testkit::{ScratchDir, ScriptedFaults, engine_db_path};
use serde_json::Value;
use std::{path::Path, sync::Arc, time::Instant};

const WS: &str = "author-coverage";
const FILE: &str = "authors.txt";

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
                run: None,
                agent_run_id: None,
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

/// The authors the next settlement would name.
fn interval(db: &Path, key: &DocKey) -> Value {
    let store = EngineStore::open(db, 4).expect("inspect store");
    let authors = store
        .read_with(|conn| author_coverage::interval_in(conn, key, i64::MAX))
        .expect("interval authors");
    serde_json::from_str(&authors.json()).expect("author list")
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
    let covered = interval(&db, &state.key);
    assert_eq!(ids(&covered), ["alice", "bob"]);
    let started = Instant::now();
    settle(&actor, scratch.path(), &state, Arc::new(NoFaults))
        .await
        .expect("settle");
    println!(
        "AUTHOR_MEASURE settlement_128_updates_us={} interval_author_bytes={}",
        started.elapsed().as_micros(),
        covered.to_string().len()
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

