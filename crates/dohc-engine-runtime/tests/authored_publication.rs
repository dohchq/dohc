use dohc_engine_domain::{DomainError, WriteBinary, WriteText};
use dohc_engine_runtime::{
    ActorHandle, CancellationToken, NoFaults, PostCommitMaterializeOutcome as Outcome,
    RuntimeError, WorkspaceSupervisor, WriteConditions,
};
use dohc_engine_storage::{FaultAction, FaultInjector, FaultPoint};
use dohc_engine_testkit::{ScratchDir, ScriptedFaults, engine_db_path};
use std::{
    path::Path,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

fn text(key: &str, path: &str, body: &str) -> WriteText {
    WriteText {
        workspace_id: "publish".into(),
        version_id: "main".into(),
        object_id: format!("object-{key}"),
        path: path.into(),
        text: body.into(),
        moment_id: format!("moment-{key}"),
        metadata_origin: "api".into(),
        metadata_summary: None,
        metadata_correlation_id: Some("batch".into()),
        author_json: Some(r#"{"kind":"agent","agentId":"agent","onBehalfOf":"local"}"#.into()),
        now_ms: 10,
        request_id: Some(key.into()),
    }
}
fn binary(key: &str) -> WriteBinary {
    let text = text(key, "asset.bin", "");
    WriteBinary {
        workspace_id: text.workspace_id,
        version_id: text.version_id,
        object_id: text.object_id,
        path: text.path,
        bytes: vec![0, 255, 13, 10],
        moment_id: text.moment_id,
        metadata_origin: text.metadata_origin,
        metadata_summary: None,
        metadata_correlation_id: text.metadata_correlation_id,
        author_json: text.author_json,
        now_ms: 10,
        request_id: text.request_id,
    }
}
async fn publish(
    actor: &ActorHandle,
    root: &Path,
    input: WriteText,
    conditions: WriteConditions,
    faults: Arc<dyn FaultInjector>,
) -> Result<dohc_engine_runtime::TextWriteExecutionResult, RuntimeError> {
    actor
        .versioned_text_publish(
            input,
            root.into(),
            conditions,
            None,
            Arc::new(()),
            faults,
            CancellationToken::new(),
        )
        .await
}
async fn count(actor: &ActorHandle) -> i64 {
    actor
        .list_moments(dohc_engine_domain::ListMomentsQuery {
            workspace_id: "publish".into(),
            version_id: None,
            object_id: None,
            limit: 100,
            before_moment_order: None,
        })
        .await
        .expect("count")
        .moments
        .len() as i64
}
fn create() -> WriteConditions {
    WriteConditions {
        create_only: true,
        expected_sha256: None,
    }
}

#[tokio::test]
async fn lost_text_reply_replays_original_outcome_after_restart_and_later_edit() {
    let scratch = ScratchDir::new().unwrap();
    let db = engine_db_path(&scratch).unwrap();
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 1).unwrap().actor;
    let input = text("stable", "note.txt", "original");
    let first = publish(
        &actor,
        scratch.path(),
        input.clone(),
        create(),
        Arc::new(NoFaults),
    )
    .await
    .unwrap();
    let identity = file_id::get_file_id(scratch.path().join("note.txt")).unwrap();
    supervisor.close(&db).unwrap();
    let actor = supervisor.open(&db, 2).unwrap().actor;
    let replay = publish(
        &actor,
        scratch.path(),
        input.clone(),
        create(),
        Arc::new(NoFaults),
    )
    .await
    .unwrap();
    assert_eq!(first.materialize_outcome, replay.materialize_outcome);
    assert!(replay.write.deduped);
    assert_eq!(first.write.moment, replay.write.moment);
    assert_eq!(
        identity,
        file_id::get_file_id(scratch.path().join("note.txt")).unwrap()
    );
    std::fs::write(scratch.path().join("note.txt"), "outside edit").unwrap();
    let replay = publish(
        &actor,
        scratch.path(),
        input.clone(),
        create(),
        Arc::new(NoFaults),
    )
    .await
    .unwrap();
    assert_eq!(replay.materialize_outcome, Outcome::Applied);
    assert_eq!(
        std::fs::read_to_string(scratch.path().join("note.txt")).unwrap(),
        "outside edit"
    );
    for changed in [
        WriteText {
            text: "different".into(),
            ..input.clone()
        },
        WriteText {
            path: "other.txt".into(),
            ..input.clone()
        },
        WriteText {
            author_json: None,
            ..input.clone()
        },
    ] {
        assert!(matches!(
            publish(
                &actor,
                scratch.path(),
                changed,
                create(),
                Arc::new(NoFaults)
            )
            .await,
            Err(RuntimeError::Domain(
                DomainError::IdempotencyKeyReuseMismatch
            ))
        ));
    }
    assert!(matches!(
        publish(
            &actor,
            scratch.path(),
            input,
            WriteConditions::default(),
            Arc::new(NoFaults)
        )
        .await,
        Err(RuntimeError::Domain(
            DomainError::IdempotencyKeyReuseMismatch
        ))
    ));
    assert_eq!(count(&actor).await, 1);
    supervisor.close(&db).unwrap();
}

#[tokio::test]
async fn expected_hash_retry_and_partial_batch_preserve_completed_outcomes_after_restart() {
    let scratch = ScratchDir::new().unwrap();
    let db = engine_db_path(&scratch).unwrap();
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 1).unwrap().actor;
    publish(
        &actor,
        scratch.path(),
        text("seed", "one.txt", "before"),
        create(),
        Arc::new(NoFaults),
    )
    .await
    .unwrap();
    let conditions = WriteConditions {
        create_only: false,
        expected_sha256: Some(dohc_engine_storage::hex_sha256(b"before")),
    };
    let first = publish(
        &actor,
        scratch.path(),
        text("batch-0", "one.txt", "after"),
        conditions.clone(),
        Arc::new(NoFaults),
    )
    .await
    .unwrap();
    let second = publish(
        &actor,
        scratch.path(),
        text("batch-1", "two.txt", "two"),
        create(),
        Arc::new(NoFaults),
    )
    .await
    .unwrap();
    std::fs::write(scratch.path().join("three.txt"), "concurrent").unwrap();
    assert!(
        publish(
            &actor,
            scratch.path(),
            text("batch-2", "three.txt", "three"),
            create(),
            Arc::new(NoFaults)
        )
        .await
        .is_err()
    );
    supervisor.close(&db).unwrap();
    let actor = supervisor.open(&db, 2).unwrap().actor;
    assert_eq!(
        publish(
            &actor,
            scratch.path(),
            text("batch-0", "one.txt", "after"),
            conditions,
            Arc::new(NoFaults)
        )
        .await
        .unwrap()
        .write
        .moment,
        first.write.moment
    );
    assert_eq!(
        publish(
            &actor,
            scratch.path(),
            text("batch-1", "two.txt", "two"),
            create(),
            Arc::new(NoFaults)
        )
        .await
        .unwrap()
        .write
        .moment,
        second.write.moment
    );
    assert_eq!(count(&actor).await, 3);
    std::fs::remove_file(scratch.path().join("three.txt")).unwrap();
    publish(
        &actor,
        scratch.path(),
        text("batch-2", "three.txt", "three"),
        create(),
        Arc::new(NoFaults),
    )
    .await
    .unwrap();
    assert_eq!(count(&actor).await, 4);
    supervisor.close(&db).unwrap();
}

#[tokio::test]
async fn text_crash_recovery_publishes_or_preserves_foreign_bytes_once() {
    for point in [
        FaultPoint::MaterializeAfterJobCommit,
        FaultPoint::MaterializeAfterRenameBeforeComplete,
    ] {
        for outside in [false, true] {
            let scratch = ScratchDir::new().unwrap();
            let db = engine_db_path(&scratch).unwrap();
            let supervisor = WorkspaceSupervisor::new();
            let actor = supervisor.open(&db, 1).unwrap().actor;
            let input = text(
                "crash",
                "large.txt",
                &format!("{}€", "a".repeat(128 * 1024 - 1)),
            );
            let faults = ScriptedFaults::crash_at(point);
            let first = publish(
                &actor,
                scratch.path(),
                input.clone(),
                create(),
                faults.clone(),
            )
            .await
            .unwrap();
            assert!(faults.fired());
            assert_eq!(first.materialize_outcome, Outcome::Error);
            supervisor.close(&db).unwrap();
            if outside {
                std::fs::write(scratch.path().join("large.txt"), "outside").unwrap();
            }
            let actor = supervisor.open(&db, 2).unwrap().actor;
            actor
                .materialize_replay_pending(scratch.path().into(), "publish".into(), 20)
                .await
                .unwrap();
            let retry = publish(
                &actor,
                scratch.path(),
                input.clone(),
                create(),
                Arc::new(NoFaults),
            )
            .await
            .unwrap();
            assert!(retry.write.deduped);
            assert_eq!(
                retry.materialize_outcome,
                if outside {
                    Outcome::Conflict
                } else {
                    Outcome::Applied
                }
            );
            assert_eq!(
                std::fs::read_to_string(scratch.path().join("large.txt")).unwrap(),
                if outside { "outside" } else { &input.text }
            );
            assert_eq!(count(&actor).await, 1);
            supervisor.close(&db).unwrap();
        }
    }
}

struct ConcurrentCreate {
    path: std::path::PathBuf,
    fired: AtomicBool,
}
impl FaultInjector for ConcurrentCreate {
    fn poll(&self, point: FaultPoint) -> FaultAction {
        if point == FaultPoint::MaterializeBeforePreimageRevalidate
            && !self.fired.swap(true, Ordering::SeqCst)
        {
            std::fs::write(&self.path, b"competitor").unwrap();
        }
        FaultAction::Continue
    }
}
#[tokio::test]
async fn binary_create_race_preserves_competitor_and_replays_conflict_after_restart() {
    let scratch = ScratchDir::new().unwrap();
    let db = engine_db_path(&scratch).unwrap();
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 1).unwrap().actor;
    let input = binary("binary-race");
    let first = actor
        .versioned_binary_write_with_conditions(
            input.clone(),
            scratch.path().into(),
            create(),
            Arc::new(()),
            Arc::new(ConcurrentCreate {
                path: scratch.path().join("asset.bin"),
                fired: AtomicBool::new(false),
            }),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(first.materialize_outcome, Outcome::Conflict);
    supervisor.close(&db).unwrap();
    let actor = supervisor.open(&db, 2).unwrap().actor;
    let replay = actor
        .versioned_binary_write_with_conditions(
            input,
            scratch.path().into(),
            create(),
            Arc::new(()),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(replay.materialize_outcome, Outcome::Conflict);
    assert!(replay.write.deduped);
    assert_eq!(
        std::fs::read(scratch.path().join("asset.bin")).unwrap(),
        b"competitor"
    );
    assert_eq!(count(&actor).await, 1);
    supervisor.close(&db).unwrap();
}

#[tokio::test]
async fn binary_lost_reply_and_changed_conditions_survive_restart() {
    let scratch = ScratchDir::new().unwrap();
    let db = engine_db_path(&scratch).unwrap();
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 1).unwrap().actor;
    let input = binary("binary-stable");
    let first = actor
        .versioned_binary_write_with_conditions(
            input.clone(),
            scratch.path().into(),
            create(),
            Arc::new(()),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    let identity = file_id::get_file_id(scratch.path().join("asset.bin")).unwrap();
    supervisor.close(&db).unwrap();
    let actor = supervisor.open(&db, 2).unwrap().actor;
    let replay = actor
        .versioned_binary_write_with_conditions(
            input.clone(),
            scratch.path().into(),
            create(),
            Arc::new(()),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(first.write.moment, replay.write.moment);
    assert_eq!(replay.materialize_outcome, Outcome::Applied);
    assert!(replay.write.deduped);
    assert_eq!(
        identity,
        file_id::get_file_id(scratch.path().join("asset.bin")).unwrap()
    );
    for field in ["bytes", "path", "author"] {
        let mut changed = input.clone();
        match field {
            "bytes" => changed.bytes.push(42),
            "path" => changed.path = "other.bin".into(),
            "author" => changed.author_json = None,
            _ => unreachable!(),
        }
        assert!(matches!(
            actor
                .versioned_binary_write_with_conditions(
                    changed,
                    scratch.path().into(),
                    create(),
                    Arc::new(()),
                    Arc::new(NoFaults),
                    CancellationToken::new()
                )
                .await,
            Err(RuntimeError::Domain(
                DomainError::IdempotencyKeyReuseMismatch
            ))
        ));
    }
    assert!(matches!(
        actor
            .versioned_binary_write_with_conditions(
                input,
                scratch.path().into(),
                WriteConditions::default(),
                Arc::new(()),
                Arc::new(NoFaults),
                CancellationToken::new()
            )
            .await,
        Err(RuntimeError::Domain(
            DomainError::IdempotencyKeyReuseMismatch
        ))
    ));
    assert_eq!(count(&actor).await, 1);
    supervisor.close(&db).unwrap();
}

#[tokio::test]
async fn watcher_observation_between_commit_and_publication_preserves_the_authored_head() {
    let scratch = ScratchDir::new().unwrap();
    let db = engine_db_path(&scratch).unwrap();
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 1).unwrap().actor;
    let input = text("pending", "pending.txt", "authored");
    let first = publish(
        &actor,
        scratch.path(),
        input.clone(),
        create(),
        ScriptedFaults::crash_at(FaultPoint::MaterializeAfterJobCommit),
    )
    .await
    .unwrap();
    assert_eq!(first.materialize_outcome, Outcome::Error);
    let captured = actor
        .capture_ingest(
            dohc_engine_domain::CaptureIngest {
                workspace_id: "publish".into(),
                version_id: "main".into(),
                path: "pending.txt".into(),
                text: "stale watcher bytes".into(),
                metadata_origin: "capture".into(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 11,
                request_id: None,
                claim_foreign_head: false,
            },
            dohc_engine_collab::LeaseRegistry::new(),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await;
    assert!(matches!(
        captured,
        Err(RuntimeError::Domain(DomainError::CaptureNotOwned))
    ));
    let retry = publish(&actor, scratch.path(), input, create(), Arc::new(NoFaults))
        .await
        .unwrap();
    assert_eq!(retry.materialize_outcome, Outcome::Applied);
    assert_eq!(count(&actor).await, 1);
    assert_eq!(
        std::fs::read_to_string(scratch.path().join("pending.txt")).unwrap(),
        "authored"
    );
    supervisor.close(&db).unwrap();
}

#[tokio::test]
async fn rolled_back_pending_text_cannot_publish_after_restart() {
    let scratch = ScratchDir::new().unwrap();
    let db = engine_db_path(&scratch).unwrap();
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 1).unwrap().actor;
    let input = text("rollback", "rollback.txt", "unpublished");
    publish(
        &actor,
        scratch.path(),
        input.clone(),
        create(),
        ScriptedFaults::crash_at(FaultPoint::MaterializeAfterJobCommit),
    )
    .await
    .unwrap();
    actor
        .versioned_text_rollback(
            dohc_engine_domain::RollbackTextFileMutation {
                workspace_id: input.workspace_id.clone(),
                version_id: input.version_id.clone(),
                path: input.path.clone(),
                mutation_moment_id: input.moment_id,
                request_id: Some("undo".into()),
                metadata_origin: "restore".into(),
                author_json: None,
            },
            scratch.path().into(),
            Arc::new(()),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(count(&actor).await, 1);
    supervisor.close(&db).unwrap();
    let actor = supervisor.open(&db, 2).unwrap().actor;
    actor
        .materialize_replay_pending(scratch.path().into(), "publish".into(), 20)
        .await
        .unwrap();
    assert!(!scratch.path().join("rollback.txt").exists());
    assert_eq!(count(&actor).await, 1);
    supervisor.close(&db).unwrap();
}

#[tokio::test]
async fn superseded_text_result_remains_superseded_after_restart() {
    let scratch = ScratchDir::new().unwrap();
    let db = engine_db_path(&scratch).unwrap();
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 1).unwrap().actor;
    let input = text("older", "note.txt", "older");
    publish(
        &actor,
        scratch.path(),
        input.clone(),
        create(),
        ScriptedFaults::crash_at(FaultPoint::MaterializeAfterJobCommit),
    )
    .await
    .unwrap();
    std::fs::write(scratch.path().join("note.txt"), "newer").unwrap();
    let newer = publish(
        &actor,
        scratch.path(),
        text("newer", "note.txt", "newer"),
        WriteConditions::default(),
        Arc::new(NoFaults),
    )
    .await
    .unwrap();
    assert_eq!(newer.materialize_outcome, Outcome::Applied);
    assert_eq!(
        publish(
            &actor,
            scratch.path(),
            input.clone(),
            create(),
            Arc::new(NoFaults)
        )
        .await
        .unwrap()
        .materialize_outcome,
        Outcome::Superseded
    );
    supervisor.close(&db).unwrap();
    let actor = supervisor.open(&db, 2).unwrap().actor;
    assert_eq!(
        publish(&actor, scratch.path(), input, create(), Arc::new(NoFaults))
            .await
            .unwrap()
            .materialize_outcome,
        Outcome::Superseded
    );
    assert_eq!(
        std::fs::read_to_string(scratch.path().join("note.txt")).unwrap(),
        "newer"
    );
    assert_eq!(count(&actor).await, 2);
    supervisor.close(&db).unwrap();
}

#[tokio::test]
async fn rollback_published_text_restores_previous_bytes_and_removes_a_created_file() {
    for (overwrite, crash) in [(false, false), (true, false), (false, true), (true, true)] {
        let scratch = ScratchDir::new().unwrap();
        let db = engine_db_path(&scratch).unwrap();
        let supervisor = WorkspaceSupervisor::new();
        let actor = supervisor.open(&db, 1).unwrap().actor;
        if overwrite {
            publish(
                &actor,
                scratch.path(),
                text("before", "rollback.txt", "before"),
                create(),
                Arc::new(NoFaults),
            )
            .await
            .unwrap();
        }
        let input = text("rollback", "rollback.txt", "after");
        let result = publish(
            &actor,
            scratch.path(),
            input.clone(),
            WriteConditions::default(),
            if crash {
                ScriptedFaults::crash_at(FaultPoint::MaterializeAfterRenameBeforeComplete)
            } else {
                Arc::new(NoFaults)
            },
        )
        .await
        .unwrap();
        assert_eq!(
            result.materialize_outcome,
            if crash {
                Outcome::Error
            } else {
                Outcome::Applied
            }
        );
        actor
            .versioned_text_rollback(
                dohc_engine_domain::RollbackTextFileMutation {
                    workspace_id: input.workspace_id,
                    version_id: input.version_id,
                    path: input.path,
                    mutation_moment_id: input.moment_id,
                    request_id: Some("undo".into()),
                    metadata_origin: "restore".into(),
                    author_json: None,
                },
                scratch.path().into(),
                Arc::new(()),
                Arc::new(NoFaults),
                CancellationToken::new(),
            )
            .await
            .unwrap();
        supervisor.close(&db).unwrap();
        let actor = supervisor.open(&db, 2).unwrap().actor;
        actor
            .materialize_replay_pending(scratch.path().into(), "publish".into(), 20)
            .await
            .unwrap();
        if overwrite {
            assert_eq!(
                std::fs::read_to_string(scratch.path().join("rollback.txt")).unwrap(),
                "before"
            );
        } else {
            assert!(!scratch.path().join("rollback.txt").exists());
        }
        supervisor.close(&db).unwrap();
    }
}
