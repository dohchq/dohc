use dohc_engine_collab::{ContentKind, DocKey, Regime, Ydoc, author_coverage};
use dohc_engine_domain::{ChangeActorKind, ChangeAttribution, RollbackTextFileMutation};
use dohc_engine_runtime::{
    ActorHandle, CancellationToken, CaptureIngest, WorkspaceSupervisor, YdocOpenState,
};
use dohc_engine_storage::{
    EngineStore, FaultInjector, FaultPoint, NoFaults, StorageError, TxnOutcome,
};
use dohc_engine_sync::{SyncError, project_and_write_in_tx};
use dohc_engine_testkit::{ScratchDir, ScriptedFaults, engine_db_path, try_make_dir_alias};
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
                run: None,
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
async fn rollback_pending_settlement_compensates_before_removing_its_moment() {
    for crash in [
        None,
        Some(FaultPoint::StorageBeforePersist),
        Some(FaultPoint::StorageAfterCommitBeforeAck),
    ] {
        let scratch = ScratchDir::new().expect("scratch");
        let db = engine_db_path(&scratch).expect("database");
        let supervisor = WorkspaceSupervisor::new();
        let actor = supervisor.open(&db, 1).expect("actor").actor;
        let state = open(&actor).await;
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
                ScriptedFaults::crash_at(FaultPoint::MaterializeAfterJobCommit),
            )
            .await
            .is_err()
        );
        let store = EngineStore::open(&db, 4).expect("inspect pending moment");
        let moment_id: String = store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT latest_moment_id FROM snapshots WHERE workspace_id=?1 AND object_id=?2",
                    rusqlite::params![WS, state.key.object_id],
                    |row| row.get(0),
                )
                .map_err(StorageError::persist_public)
            })
            .expect("pending moment");
        let before = coverage(&store, &state.key);
        drop(store);
        let input = RollbackTextFileMutation {
            workspace_id: WS.into(),
            version_id: "main".into(),
            path: FILE.into(),
            mutation_moment_id: moment_id.clone(),
            request_id: Some("rollback-pending-settlement".into()),
            metadata_origin: "coverage-regression".into(),
            author_json: None,
        };
        let faults: Arc<dyn FaultInjector> = crash.map(ScriptedFaults::crash_at).map_or_else(
            || Arc::new(NoFaults) as Arc<dyn FaultInjector>,
            |faults| faults,
        );
        let result = actor
            .versioned_text_rollback(
                input.clone(),
                scratch.path().into(),
                Arc::new(()),
                faults,
                CancellationToken::new(),
            )
            .await;
        if crash.is_some() {
            assert!(result.is_err(), "fault must reach the rollback transaction");
        } else {
            result.expect("rollback pending settlement");
        }
        supervisor.close(&db).expect("stop");
        drop(actor);
        let store = EngineStore::open(&db, 5).expect("restart inspection");
        if crash == Some(FaultPoint::StorageBeforePersist) {
            assert_eq!(coverage(&store, &state.key), before, "rollback is atomic");
        } else {
            let restored = coverage(&store, &state.key);
            assert_eq!(restored.3, None);
            assert!(
                restored.2 == "[]",
                "rollback consumes authors of the removed content"
            );
        }
        drop(store);
        let actor = supervisor.open(&db, 6).expect("restart").actor;
        actor
            .versioned_text_rollback(
                input,
                scratch.path().into(),
                Arc::new(()),
                Arc::new(NoFaults),
                CancellationToken::new(),
            )
            .await
            .expect("retry rollback");
        actor
            .materialize_replay_pending(scratch.path().into(), WS.into(), 7)
            .await
            .expect("cancelled settlement cannot replay");
        assert_eq!(
            std::fs::read_to_string(scratch.path().join(FILE)).expect("disk"),
            "a"
        );
        let reopened = open(&actor).await;
        let store = EngineStore::open(&db, 8).expect("inspect restored lineage");
        let restored = coverage(&store, &state.key);
        assert_eq!(restored.3, None);
        assert_eq!(restored.2, "[]");
        let job_status: String = store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT status FROM materialization_jobs WHERE job_id=?1",
                    [format!("ydoc-mat_{moment_id}")],
                    |row| row.get(0),
                )
                .map_err(StorageError::persist_public)
            })
            .expect("cancelled job");
        assert_eq!(job_status, "cancelled");
        let doc = dohc_engine_collab::load_persisted(&store, &state.key)
            .expect("load")
            .expect("restored lineage")
            .doc;
        drop(store);
        append(&actor, &state.key, doc.plaintext_insert(1, "c"), "carol").await;
        settle(&actor, scratch.path(), &reopened, Arc::new(NoFaults))
            .await
            .expect("settle after rollback");
        supervisor.close(&db).expect("stop");
        drop(actor);
        let store = EngineStore::open(&db, 9).expect("inspect later authors");
        let authors: String = store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT m.author_json FROM snapshots s JOIN moments m ON m.moment_id=s.latest_moment_id \
                     AND m.workspace_id=s.workspace_id WHERE s.workspace_id=?1 AND s.object_id=?2",
                    rusqlite::params![WS, state.key.object_id],
                    |row| row.get(0),
                )
                .map_err(StorageError::persist_public)
            })
            .expect("settlement authors");
        assert!(!authors.contains("bob"));
        assert!(authors.contains("carol"));
        assert!(!authors.contains("alice"));
        assert_eq!(coverage(&store, &state.key).2, "[]");
    }
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
    let imported = store.write_with(&NoFaults, |tx| {
        dohc_engine_sync::reconcile_imported_resulting_head_in_tx(
            tx,
            WS,
            "main",
            &state.key.object_id,
            dohc_engine_sync::ResultingHead::Text {
                path: FILE,
                text: "not the ordered rewrite",
            },
            5,
        )
    });
    assert!(matches!(
        imported,
        Err(SyncError::RetryableState {
            reason: "ydoc-resulting-head-pending"
        })
    ));
    assert_eq!(
        coverage(&store, &state.key),
        pending,
        "a mismatched imported head must wait for its rewrite"
    );
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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn reset_cannot_leave_an_attempt_or_authors_on_a_replacement_lineage() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = engine_db_path(&scratch).expect("database");
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
    let mut store = EngineStore::open(&db, 4).expect("store");
    dohc_engine_collab::maybe_compact(&mut store, &state.key, 0, &NoFaults, 5)
        .expect("fold arrivals");
    let before = coverage(&store, &state.key);
    assert!(before.3.is_some());
    assert_ne!(before.2, "[]");
    let retained = store.write_with(&NoFaults, |tx| {
        author_coverage::reset_in(tx, &state.key, true)
    });
    assert!(matches!(
        retained,
        Err(dohc_engine_collab::CollabError::UnsettledClose)
    ));
    assert_eq!(
        coverage(&store, &state.key),
        before,
        "content-retaining reset must wait for materialization"
    );
    store.write_with(&NoFaults,|tx| {
        author_coverage::reset_in(tx,&state.key,false)?;
        tx.execute("DELETE FROM ydoc_updates WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
            rusqlite::params![state.key.workspace_id,state.key.version_id,state.key.object_id])
            .map_err(StorageError::persist_public)?;
        tx.execute("DELETE FROM ydoc_snapshots WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
            rusqlite::params![state.key.workspace_id,state.key.version_id,state.key.object_id])
            .map_err(StorageError::persist_public)?;
        tx.execute("UPDATE ydoc_docs SET head_update_seq=0,head_snapshot_seq=0 WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
            rusqlite::params![state.key.workspace_id,state.key.version_id,state.key.object_id])
            .map_err(StorageError::persist_public)?;
        Ok::<_,dohc_engine_collab::CollabError>(())
    }).expect("replace lineage");
    let reset = coverage(&store, &state.key);
    assert_eq!(reset.1, None);
    assert_eq!(reset.2, "[]");
    assert_eq!(reset.3, None);
    assert_eq!(reset.4, None);
    let pending: i64 = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM materialization_jobs WHERE status='pending'",
                [],
                |row| row.get(0),
            )
            .map_err(StorageError::persist_public)
        })
        .expect("pending jobs");
    assert_eq!(
        pending, 1,
        "the file job must preserve the committed head preimage for later writes"
    );
    drop(store);
    let actor = supervisor.open(&db, 6).expect("restart").actor;
    actor
        .materialize_replay_pending(scratch.path().into(), WS.into(), 7)
        .await
        .expect("restart can reconcile without rewinding new head");
    supervisor.close(&db).expect("stop");
    let store = EngineStore::open(&db, 8).expect("inspect restart");
    assert_eq!(coverage(&store, &state.key), reset);
    assert_eq!(
        std::fs::read_to_string(scratch.path().join(FILE)).expect("replayed head"),
        "ab"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn terminal_status_distinguishes_success_from_supersession_including_equal_timestamps() {
    for newer_workspace in [WS, ""] {
        for newer_completed_at in [9, 10, 11] {
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
            let mut store = EngineStore::open(&db, 4).expect("store");
            store.write_with(&NoFaults,|tx| {
                tx.execute("UPDATE materialization_jobs SET status=?1,completed_at_ms=10 WHERE status='pending'",[if newer_completed_at == 9 { "cancelled" } else { "complete" }])
                    .map_err(StorageError::persist_public)?;
                tx.execute("INSERT INTO materialization_jobs (job_id,workspace_id,target_path,content_sha256,preimage_present,target_generation,status,created_at_ms,completed_at_ms) \
                    SELECT 'newer',?1,target_path,content_sha256,preimage_present,target_generation+1,'complete',created_at_ms,?2 FROM materialization_jobs LIMIT 1",
                    rusqlite::params![newer_workspace,newer_completed_at]).map_err(StorageError::persist_public)?;
                author_coverage::reconcile_in(tx,&state.key,12)
                    .map_err(StorageError::persist_public)
            }).expect("reconcile completion ordering");
            let reconciled = coverage(&store, &state.key);
            assert_eq!(reconciled.3, None);
            if newer_completed_at >= 10 {
                assert_eq!(
                    reconciled.1,
                    Some(1),
                    "genuine prior success remains covered"
                );
                assert_eq!(
                    reconciled.2, "[]",
                    "success must not credit accepted authors twice"
                );
                assert!(reconciled.4.is_some());
            } else {
                assert_eq!(
                    reconciled.1, None,
                    "older job completed after the superseding write"
                );
                assert!(reconciled.2.contains("alice"));
                assert_eq!(reconciled.4, None);
            }
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sync_projection_credits_folded_authors_and_consumes_pending() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = engine_db_path(&scratch).expect("database");
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 1).expect("actor").actor;
    let state = open(&actor).await;
    let doc = Ydoc::wire();
    append(&actor, &state.key, doc.plaintext_insert(0, "a"), "alice").await;
    settle(&actor, scratch.path(), &state, Arc::new(NoFaults))
        .await
        .expect("settle");
    append(&actor, &state.key, doc.plaintext_insert(1, "b"), "bob").await;
    supervisor.close(&db).expect("stop");
    drop(actor);
    let mut store = EngineStore::open(&db, 4).expect("store");
    dohc_engine_collab::maybe_compact(&mut store, &state.key, 0, &NoFaults, 5).expect("fold");
    assert!(coverage(&store, &state.key).2.contains("bob"));
    store
        .write_with(&NoFaults, |tx| {
            project_and_write_in_tx(
                tx,
                &state.key,
                FILE,
                &doc,
                ContentKind::Plaintext,
                "remote",
                1,
                6,
                None,
            )
        })
        .expect("projection");
    assert_eq!(coverage(&store, &state.key).2, "[]");
    let authors:String=store.read_with(|conn| conn.query_row(
        "SELECT m.author_json FROM snapshots s JOIN moments m ON m.workspace_id=s.workspace_id AND m.moment_id=s.latest_moment_id WHERE s.workspace_id=?1 AND s.object_id=?2",
        rusqlite::params![WS,state.key.object_id],|row|row.get(0)).map_err(StorageError::persist_public)).expect("authors");
    assert!(authors.contains("bob"));
    assert!(!authors.contains("alice"));
    assert_eq!(coverage(&store, &state.key).3, None);
    store
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "UPDATE ydoc_docs SET pending_authors_json=?1",
                [r#"[{"kind":"agent","agentId":"carol"}]"#],
            )
            .map_err(StorageError::persist_public)?;
            project_and_write_in_tx(
                tx,
                &state.key,
                FILE,
                &doc,
                ContentKind::Plaintext,
                "remote",
                2,
                8,
                None,
            )
        })
        .expect("converged projection");
    assert_eq!(
        coverage(&store, &state.key).2,
        "[]",
        "no-op consumes its interval"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn file_rewrite_discards_pending_authors_of_replaced_content() {
    for origin in ["capture", "api", "conflict-resolution"] {
        let scratch = ScratchDir::new().expect("scratch");
        let db = engine_db_path(&scratch).expect("database");
        let supervisor = WorkspaceSupervisor::new();
        let actor = supervisor.open(&db, 1).expect("actor").actor;
        let state = open(&actor).await;
        let doc = Ydoc::wire();
        append(&actor, &state.key, doc.plaintext_insert(0, "a"), "alice").await;
        settle(&actor, scratch.path(), &state, Arc::new(NoFaults))
            .await
            .expect("settle");
        append(&actor, &state.key, doc.plaintext_insert(1, "b"), "bob").await;
        supervisor.close(&db).expect("stop");
        drop(actor);
        let mut store = EngineStore::open(&db, 4).expect("store");
        dohc_engine_collab::maybe_compact(&mut store, &state.key, 0, &NoFaults, 5).expect("fold");
        store
            .write_with(&NoFaults, |tx| {
                dohc_engine_sync::reconcile_local_resulting_head_in_tx(
                    tx,
                    WS,
                    "main",
                    &state.key.object_id,
                    dohc_engine_sync::ResultingHead::Text {
                        path: FILE,
                        text: "replacement",
                    },
                    Some(origin),
                    Some(&ChangeAttribution {
                        actor_kind: ChangeActorKind::Agent,
                        on_behalf_of: Some("person".into()),
                        depth: 0,
                        run: None,
                    }),
                    6,
                )
            })
            .expect("rewrite");
        let replaced = coverage(&store, &state.key);
        assert_eq!(
            replaced.2, "[]",
            "{origin} must consume the replaced interval"
        );
        assert_eq!(replaced.3, None);
        let authors = store
            .read_with(|conn| author_coverage::interval_in(conn, &state.key, i64::MAX))
            .expect("remaining authors");
        assert!(
            authors.is_empty(),
            "{origin} cannot credit old edits in a later settlement"
        );
    }
}

fn settlement_job_and_history(store: &EngineStore, key: &DocKey) -> (String, Vec<String>) {
    store
        .read_with(|conn| {
            let status = conn
                .query_row(
                    "SELECT j.status FROM ydoc_docs d JOIN moments m ON m.workspace_id=d.workspace_id \
                     AND m.version_id=d.version_id AND m.object_id=d.object_id AND m.moment_order=d.settle_seq \
                     JOIN materialization_jobs j ON j.job_id='ydoc-mat_'||m.moment_id \
                     WHERE d.workspace_id=?1 AND d.version_id=?2 AND d.object_id=?3",
                    rusqlite::params![key.workspace_id, key.version_id, key.object_id],
                    |row| row.get(0),
                )
                .map_err(StorageError::persist_public)?;
            let authors = conn
                .prepare(
                    "SELECT author_json FROM moments WHERE workspace_id=?1 AND object_id=?2 \
                     AND author_json IS NOT NULL ORDER BY moment_order",
                )
                .and_then(|mut statement| {
                    statement
                        .query_map(rusqlite::params![WS, key.object_id], |row| row.get(0))?
                        .collect::<rusqlite::Result<Vec<String>>>()
                })
                .map_err(StorageError::persist_public)?;
            Ok::<_, StorageError>((status, authors))
        })
        .expect("settlement job and history")
}

fn credits(history: &[String], author: &str) -> usize {
    history
        .iter()
        .filter(|authors| authors.contains(&format!("\"{author}\"")))
        .count()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn directory_blocked_settlement_yields_to_a_captured_outside_edit() {
    for operation in ["capture", "conflict-resolution", "imported"] {
        let scratch = ScratchDir::new().expect("scratch");
        let elsewhere = ScratchDir::new().expect("outside directory");
        let db = engine_db_path(&scratch).expect("database");
        let supervisor = WorkspaceSupervisor::new();
        let mut actor = supervisor.open(&db, 1).expect("actor").actor;
        let state = open(&actor).await;
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
                ScriptedFaults::crash_at(FaultPoint::MaterializeAfterJobCommit),
            )
            .await
            .is_err()
        );
        let file = scratch.path().join(FILE);
        std::fs::remove_file(&file).expect("remove settled file");
        assert!(
            try_make_dir_alias(elsewhere.path(), &file).expect("directory alias"),
            "host must create the directory alias; this regression cannot skip"
        );
        actor
            .materialize_replay_pending(scratch.path().into(), WS.into(), 4)
            .await
            .expect("replay reaches the directory");
        let store = EngineStore::open(&db, 5).expect("inspect blocked attempt");
        let (status, _) = settlement_job_and_history(&store, &state.key);
        assert_eq!(
            status, "pending",
            "the directory blocks the settlement write"
        );
        assert!(coverage(&store, &state.key).3.is_some());
        drop(store);

        // The person replaces the blocking directory with their own file.
        #[cfg(windows)]
        std::fs::remove_dir(&file).expect("remove blocking junction");
        #[cfg(not(windows))]
        std::fs::remove_file(&file).expect("remove blocking directory symlink");
        let resulting_text = if operation == "imported" {
            "ab"
        } else {
            "outside"
        };
        std::fs::write(&file, resulting_text).expect("new artifact");
        if operation == "capture" {
            actor
                .capture_ingest(
                    CaptureIngest {
                        workspace_id: WS.into(),
                        version_id: "main".into(),
                        path: FILE.into(),
                        text: "outside".into(),
                        metadata_origin: "capture".into(),
                        metadata_summary: None,
                        metadata_correlation_id: None,
                        author_json: None,
                        now_ms: 6,
                        request_id: None,
                        claim_foreign_head: true,
                    },
                    dohc_engine_collab::LeaseRegistry::new(),
                    Arc::new(NoFaults),
                    CancellationToken::new(),
                )
                .await
                .expect("outside edit captured");
        } else {
            supervisor
                .close(&db)
                .expect("stop before direct transaction");
            drop(actor);
            let mut store = EngineStore::open(&db, 6).expect("resulting head store");
            store
                .write_with(&NoFaults, |tx| {
                    if operation == "conflict-resolution" {
                        // Resolution writes its chosen file head in this same transaction.
                        dohc_engine_domain::write_text_in_tx(
                            tx,
                            &dohc_engine_domain::WriteText {
                                workspace_id: WS.into(),
                                version_id: "main".into(),
                                object_id: state.key.object_id.clone(),
                                path: FILE.into(),
                                text: resulting_text.into(),
                                moment_id: "resolution-head".into(),
                                metadata_origin: "conflict-resolution".into(),
                                metadata_summary: None,
                                metadata_correlation_id: None,
                                author_json: None,
                                now_ms: 6,
                                request_id: None,
                            },
                        )
                        .expect("resolution file head");
                        dohc_engine_sync::fold_resolution_into_ydoc_in_tx(
                            tx,
                            WS,
                            "main",
                            &state.key.object_id,
                            FILE,
                            resulting_text,
                            6,
                        )
                    } else {
                        dohc_engine_sync::reconcile_imported_resulting_head_in_tx(
                            tx,
                            WS,
                            "main",
                            &state.key.object_id,
                            dohc_engine_sync::ResultingHead::Text {
                                path: FILE,
                                text: resulting_text,
                            },
                            6,
                        )
                    }
                })
                .expect("new head supersedes blocked settlement");
            drop(store);
            actor = supervisor.open(&db, 7).expect("restart").actor;
        }
        let store = EngineStore::open(&db, 7).expect("inspect captured edit");
        let captured = coverage(&store, &state.key);
        assert_eq!(captured.3, None, "the captured head resolves the attempt");
        assert_eq!(captured.2, "[]");
        let (status, history) = settlement_job_and_history(&store, &state.key);
        assert_eq!(status, "cancelled", "the superseded write cannot replay");
        assert_eq!(credits(&history, "alice"), 1);
        assert_eq!(
            credits(&history, "bob"),
            1,
            "the blocked settlement moment keeps its credit"
        );
        assert!(
            store
                .read_with(|conn| author_coverage::interval_in(conn, &state.key, i64::MAX))
                .expect("interval")
                .is_empty(),
            "no later settlement can credit bob again"
        );
        drop(store);

        let reopened = open(&actor).await;
        let doc = Ydoc::wire();
        doc.apply(&reopened.initial_update)
            .expect("captured lineage");
        assert_eq!(doc.plaintext_string(), resulting_text);
        append(
            &actor,
            &state.key,
            doc.plaintext_insert(resulting_text.len() as u32, "c"),
            "carol",
        )
        .await;
        settle(&actor, scratch.path(), &reopened, Arc::new(NoFaults))
            .await
            .expect("settlement after the capture");
        actor
            .materialize_replay_pending(scratch.path().into(), WS.into(), 8)
            .await
            .expect("cancelled write stays cancelled");
        supervisor.close(&db).expect("stop");
        drop(actor);
        assert_eq!(
            std::fs::read_to_string(&file).expect("disk"),
            format!("{resulting_text}c")
        );
        let store = EngineStore::open(&db, 9).expect("inspect later settlement");
        let (_, history) = settlement_job_and_history(&store, &state.key);
        for author in ["alice", "bob", "carol"] {
            assert_eq!(credits(&history, author), 1, "{author} is credited once");
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn inactive_version_projection_without_a_job_remains_resolved() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = engine_db_path(&scratch).expect("db");
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 1).expect("actor").actor;
    let state = open(&actor).await;
    let doc = Ydoc::wire();
    append(&actor, &state.key, doc.plaintext_insert(0, "a"), "alice").await;
    supervisor.close(&db).expect("stop");
    drop(actor);
    let mut store = EngineStore::open(&db, 2).expect("store");
    store.write_with(&NoFaults,|tx| {
        tx.execute("INSERT INTO versions(workspace_id,version_id,name,kind,created_at_ms) VALUES (?1,'other','Other','named',1)",[WS]).map_err(StorageError::persist_public)?;
        tx.execute("INSERT INTO active_versions(workspace_id,version_id) VALUES (?1,'other') ON CONFLICT(workspace_id) DO UPDATE SET version_id='other'",[WS]).map_err(StorageError::persist_public)?;
        Ok::<_,StorageError>(())
    }).expect("deactivate main");
    store
        .write_with(&NoFaults, |tx| {
            project_and_write_in_tx(
                tx,
                &state.key,
                FILE,
                &doc,
                ContentKind::Plaintext,
                "remote",
                1,
                3,
                None,
            )
        })
        .expect("inactive projection");
    assert_eq!(
        coverage(&store, &state.key).3,
        None,
        "no disk job means no unresolved attempt"
    );
    store
        .write_with(&NoFaults, |tx| {
            project_and_write_in_tx(
                tx,
                &state.key,
                FILE,
                &doc,
                ContentKind::Plaintext,
                "remote",
                1,
                4,
                None,
            )
        })
        .expect("inactive retry");
    store
        .read_with(|conn| {
            let jobs: i64 = conn
                .query_row("SELECT COUNT(*) FROM materialization_jobs", [], |row| {
                    row.get(0)
                })
                .map_err(StorageError::persist_public)?;
            assert_eq!(jobs, 0);
            Ok::<_, StorageError>(())
        })
        .expect("no disk materialization");
}
