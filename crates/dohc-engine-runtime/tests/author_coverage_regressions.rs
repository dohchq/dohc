use dohc_engine_collab::{ContentKind, DocKey, Regime, Ydoc, author_coverage};
use dohc_engine_domain::{ChangeActorKind, ChangeAttribution};
use dohc_engine_runtime::{ActorHandle, CancellationToken, WorkspaceSupervisor, YdocOpenState};
use dohc_engine_storage::{
    EngineStore, FaultInjector, FaultPoint, NoFaults, StorageError, TxnOutcome,
};
use dohc_engine_sync::{SyncError, project_and_write_in_tx};
use dohc_engine_testkit::{ScratchDir, ScriptedFaults, engine_db_path};
use std::{path::Path, sync::Arc};

const WS: &str = "coverage-regression";
const FILE: &str = "authors.txt";

type Coverage = (i64, Option<i64>, String, Option<i64>, Option<String>, i64);

fn coverage(store: &EngineStore, key: &DocKey) -> Coverage {
    store.read_with(|conn| conn.query_row(
        "SELECT settle_seq,settled_update_seq,pending_authors_json,settle_prior_update_seq,last_settled_sha,updated_at_ms \
         FROM ydoc_docs WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
        rusqlite::params![key.workspace_id,key.version_id,key.object_id],
        |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?)))
        .map_err(StorageError::persist_public)).expect("coverage")
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
        .expect("open")
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
            "coverage-regression".into(),
            Arc::new(()),
            3,
            faults,
            CancellationToken::new(),
            None,
        )
        .await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn repeated_old_job_compensation_preserves_a_later_successful_settlement() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = engine_db_path(&scratch).expect("database");
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 1).expect("actor").actor;
    let mut state = open(&actor).await;
    let doc = Ydoc::wire();
    append(&actor, &state.key, doc.plaintext_insert(0, "a"), "alice").await;
    settle(&actor, scratch.path(), &state, Arc::new(NoFaults))
        .await
        .expect("first settlement");
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
    supervisor.close(&db).expect("stop");
    drop(actor);
    let mut store = EngineStore::open(&db, 4).expect("inspect failed attempt");
    let (failed_moment, failed_sha): (String, String) = store
        .read_with(|conn| {
            conn.query_row(
        "SELECT latest_moment_id,blob_sha256 FROM snapshots WHERE workspace_id=?1 AND object_id=?2",
        rusqlite::params![WS,state.key.object_id], |row| Ok((row.get(0)?,row.get(1)?)))
        .map_err(StorageError::persist_public)
        })
        .expect("failed head");
    store
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "UPDATE materialization_jobs SET status='conflict' WHERE job_id=?1",
                [format!("ydoc-mat_{failed_moment}")],
            )
            .map_err(StorageError::persist_public)?;
            Ok::<_, StorageError>(())
        })
        .expect("terminal conflict");
    store
        .write_with(&NoFaults, |tx| {
            author_coverage::compensate_in(tx, &state.key, Some(&failed_moment), 5)
        })
        .expect("compensate failed attempt");
    let compensated = coverage(&store, &state.key);
    assert_eq!(compensated.1, Some(1));
    assert_eq!(compensated.3, None);
    assert_eq!(compensated.4, None);
    store
        .write_with(&NoFaults, |tx| {
            author_coverage::compensate_in(tx, &state.key, Some(&failed_moment), 6)
        })
        .expect("repeat compensation");
    assert_eq!(coverage(&store, &state.key), compensated);
    drop(store);

    // Restore the committed failed head so the next settlement has its exact disk preimage.
    std::fs::write(scratch.path().join(FILE), "ab").expect("restore preimage");
    state.head_blob_sha256 = Some(failed_sha);
    let actor = supervisor.open(&db, 7).expect("restart").actor;
    append(&actor, &state.key, doc.plaintext_insert(2, "c"), "carol").await;
    settle(&actor, scratch.path(), &state, Arc::new(NoFaults))
        .await
        .expect("later settlement");
    supervisor.close(&db).expect("stop");
    drop(actor);
    let mut store = EngineStore::open(&db, 8).expect("inspect success");
    let successful = coverage(&store, &state.key);
    assert_eq!(successful.1, Some(3));
    assert_eq!(successful.3, None);
    assert_eq!(successful.4, Some(dohc_engine_storage::hex_sha256(b"abc")));
    store
        .write_with(&NoFaults, |tx| {
            author_coverage::compensate_in(tx, &state.key, Some(&failed_moment), 9)
        })
        .expect("stale compensation");
    assert_eq!(
        coverage(&store, &state.key),
        successful,
        "old job must not invalidate the newer success"
    );
    assert_eq!(
        std::fs::read_to_string(scratch.path().join(FILE)).expect("artifact"),
        "abc"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sync_projection_cannot_replace_an_unresolved_local_attempt_marker() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = engine_db_path(&scratch).expect("database");
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 1).expect("actor").actor;
    let state = open(&actor).await;
    let doc = Ydoc::wire();
    append(&actor, &state.key, doc.plaintext_insert(0, "a"), "alice").await;
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
    supervisor.close(&db).expect("stop");
    drop(actor);
    let mut store = EngineStore::open(&db, 4).expect("inspect pending attempt");
    let remote_doc = dohc_engine_collab::load_persisted(&store, &state.key)
        .expect("load")
        .expect("lineage")
        .doc;
    let _remote_update = remote_doc.plaintext_insert(1, "remote");
    let pending = coverage(&store, &state.key);
    assert!(pending.3.is_some());
    let refused = store.write_with(&NoFaults, |tx| {
        project_and_write_in_tx(
            tx,
            &state.key,
            FILE,
            &remote_doc,
            ContentKind::Plaintext,
            "remote-origin",
            1,
            5,
            None,
        )
    });
    assert!(matches!(
        refused,
        Err(SyncError::RetryableState {
            reason: "settlement-materialization-pending"
        })
    ));
    assert_eq!(
        coverage(&store, &state.key),
        pending,
        "refusal must preserve attempt and author reservation"
    );
    let moment_count: i64 = store
        .read_with(|conn| {
            conn.query_row("SELECT COUNT(*) FROM moments", [], |row| row.get(0))
                .map_err(StorageError::persist_public)
        })
        .expect("count moments");
    assert_eq!(moment_count, 1);
    drop(store);

    let actor = supervisor.open(&db, 6).expect("restart").actor;
    actor
        .materialize_replay_pending(scratch.path().into(), WS.into(), 7)
        .await
        .expect("finish local attempt");
    supervisor.close(&db).expect("stop");
    drop(actor);
    let mut store = EngineStore::open(&db, 8).expect("inspect completed attempt");
    assert_eq!(coverage(&store, &state.key).3, None);
    let projected = store
        .write_with(&NoFaults, |tx| {
            project_and_write_in_tx(
                tx,
                &state.key,
                FILE,
                &remote_doc,
                ContentKind::Plaintext,
                "remote-origin",
                1,
                9,
                None,
            )
        })
        .expect("sync after local completion");
    assert!(matches!(projected, TxnOutcome::Committed(())));
    assert!(
        coverage(&store, &state.key).0 > pending.0,
        "sync can advance its own marker after local completion"
    );
}
