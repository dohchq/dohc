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
        author_json: Some(r#"[{"kind":"agent","agentId":"agent","onBehalfOf":"local"}]"#.into()),
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
async fn publish_binary(
    actor: &ActorHandle,
    root: &Path,
    input: WriteBinary,
    conditions: WriteConditions,
    faults: Arc<dyn FaultInjector>,
) -> Outcome {
    actor
        .versioned_binary_write_with_conditions(
            input,
            root.into(),
            conditions,
            Arc::new(()),
            faults,
            CancellationToken::new(),
        )
        .await
        .unwrap()
        .materialize_outcome
}
async fn applied(actor: &ActorHandle, request: &str, moment: &str) -> bool {
    actor
        .publication_applied("publish".into(), request.into(), moment.into())
        .await
        .unwrap()
}
async fn publish_older(
    actor: &ActorHandle,
    root: &Path,
    binary_write: bool,
    faults: Arc<dyn FaultInjector>,
) -> Outcome {
    if binary_write {
        publish_binary(actor, root, binary("older"), create(), faults).await
    } else {
        publish(
            actor,
            root,
            text("older", "note.txt", "older"),
            create(),
            faults,
        )
        .await
        .unwrap()
        .materialize_outcome
    }
}
/// Another person's later edit, already on disk when it is recorded.
async fn publish_newer(actor: &ActorHandle, root: &Path, binary_write: bool) -> Vec<u8> {
    if binary_write {
        let input = WriteBinary {
            bytes: vec![1, 0, 254],
            ..binary("newer")
        };
        std::fs::write(root.join(&input.path), &input.bytes).unwrap();
        let bytes = input.bytes.clone();
        let outcome = publish_binary(
            actor,
            root,
            input,
            WriteConditions::default(),
            Arc::new(NoFaults),
        )
        .await;
        assert_eq!(outcome, Outcome::Applied);
        bytes
    } else {
        std::fs::write(root.join("note.txt"), "newer").unwrap();
        let result = publish(
            actor,
            root,
            text("newer", "note.txt", "newer"),
            WriteConditions::default(),
            Arc::new(NoFaults),
        )
        .await
        .unwrap();
        assert_eq!(result.materialize_outcome, Outcome::Applied);
        b"newer".to_vec()
    }
}

#[tokio::test]
async fn replay_confirms_only_a_publication_that_reached_disk() {
    for binary_write in [false, true] {
        for superseded in [false, true] {
            let scratch = ScratchDir::new().unwrap();
            let db = engine_db_path(&scratch).unwrap();
            let supervisor = WorkspaceSupervisor::new();
            let actor = supervisor.open(&db, 1).unwrap().actor;
            let path = if binary_write {
                "asset.bin"
            } else {
                "note.txt"
            };
            let crash = ScriptedFaults::crash_at(FaultPoint::MaterializeAfterJobCommit);
            assert_eq!(
                publish_older(&actor, scratch.path(), binary_write, crash).await,
                Outcome::Error
            );
            assert!(!applied(&actor, "older", "moment-older").await);
            let newer = if superseded {
                Some(publish_newer(&actor, scratch.path(), binary_write).await)
            } else {
                None
            };
            supervisor.close(&db).unwrap();
            let actor = supervisor.open(&db, 2).unwrap().actor;
            actor
                .materialize_replay_pending(scratch.path().into(), "publish".into(), 20)
                .await
                .unwrap();
            // A superseded job reads complete, yet its bytes never landed.
            assert_eq!(applied(&actor, "older", "moment-older").await, !superseded);
            let newer = match newer {
                Some(newer) => newer,
                None => publish_newer(&actor, scratch.path(), binary_write).await,
            };
            assert_eq!(
                publish_older(&actor, scratch.path(), binary_write, Arc::new(NoFaults)).await,
                if superseded {
                    Outcome::Superseded
                } else {
                    Outcome::Applied
                }
            );
            // A confirmed publication stays confirmed and never rewrites the later edit.
            assert_eq!(applied(&actor, "older", "moment-older").await, !superseded);
            assert_eq!(std::fs::read(scratch.path().join(path)).unwrap(), newer);
            // The request binds only to the moment it recorded, in its workspace.
            assert!(!applied(&actor, "older", "moment-newer").await);
            assert!(!applied(&actor, "newer", "moment-older").await);
            assert!(applied(&actor, "newer", "moment-newer").await);
            assert!(
                !actor
                    .publication_applied("other".into(), "older".into(), "moment-older".into())
                    .await
                    .unwrap()
            );
            supervisor.close(&db).unwrap();
        }
    }
}

#[tokio::test]
async fn publication_replay_after_version_switch_preserves_settled_outcomes_and_fingerprints() {
    for pending in [false, true] {
        let scratch = ScratchDir::new().unwrap();
        let db = engine_db_path(&scratch).unwrap();
        let supervisor = WorkspaceSupervisor::new();
        let actor = supervisor.open(&db, 1).unwrap().actor;
        actor
            .ensure_main_version(
                "publish".into(),
                1,
                Arc::new(NoFaults),
                CancellationToken::new(),
            )
            .await
            .unwrap();
        actor
            .create_named_version(
                dohc_engine_domain::CreateNamedVersion {
                    workspace_id: "publish".into(),
                    new_version_id: "draft".into(),
                    name: "Draft".into(),
                    from_version_id: "main".into(),
                    now_ms: 2,
                    request_id: None,
                },
                Arc::new(NoFaults),
                CancellationToken::new(),
            )
            .await
            .unwrap();
        let input = text("switch-text", "note.txt", "published");
        let bytes = binary("switch-binary");
        let faults = || -> Arc<dyn FaultInjector> {
            if pending {
                ScriptedFaults::crash_at(FaultPoint::MaterializeAfterJobCommit)
            } else {
                Arc::new(NoFaults)
            }
        };
        let first_text = publish(&actor, scratch.path(), input.clone(), create(), faults())
            .await
            .unwrap();
        let first_binary = actor
            .versioned_binary_write_with_conditions(
                bytes.clone(),
                scratch.path().into(),
                create(),
                Arc::new(()),
                faults(),
                CancellationToken::new(),
            )
            .await
            .unwrap();
        let expected = if pending {
            Outcome::Error
        } else {
            Outcome::Applied
        };
        assert_eq!(first_text.materialize_outcome, expected);
        assert_eq!(first_binary.materialize_outcome, expected);
        actor
            .set_active_version(
                dohc_engine_runtime::ActiveVersionSwitch {
                    workspace_id: "publish".into(),
                    version_id: "draft".into(),
                    root_dir: scratch.path().into(),
                    self_writes: Arc::new(()),
                    now_ms: 20,
                },
                Arc::new(NoFaults),
                CancellationToken::new(),
            )
            .await
            .unwrap();
        supervisor.close(&db).unwrap();
        let actor = supervisor.open(&db, 21).unwrap().actor;
        let replay_text = publish(
            &actor,
            scratch.path(),
            input.clone(),
            create(),
            Arc::new(NoFaults),
        )
        .await;
        let replay_binary = actor
            .versioned_binary_write_with_conditions(
                bytes.clone(),
                scratch.path().into(),
                create(),
                Arc::new(()),
                Arc::new(NoFaults),
                CancellationToken::new(),
            )
            .await;
        if pending {
            assert!(matches!(
                replay_text,
                Err(RuntimeError::Domain(DomainError::InvalidVersion))
            ));
            assert!(matches!(
                replay_binary,
                Err(RuntimeError::Domain(DomainError::InvalidVersion))
            ));
        } else {
            let replay_text = replay_text.unwrap();
            let replay_binary = replay_binary.unwrap();
            assert_eq!(
                replay_text.materialize_outcome,
                first_text.materialize_outcome
            );
            assert_eq!(
                replay_binary.materialize_outcome,
                first_binary.materialize_outcome
            );
            assert_eq!(replay_text.write.moment, first_text.write.moment);
            assert_eq!(replay_binary.write.moment, first_binary.write.moment);
            assert!(replay_text.write.deduped && replay_binary.write.deduped);
        }
        let mut changed = input.clone();
        changed.text.push('!');
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
        let mut changed = bytes.clone();
        changed.bytes.push(42);
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
        assert!(matches!(
            actor
                .versioned_binary_write_with_conditions(
                    bytes,
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
        assert_eq!(count(&actor).await, 2);
        assert!(!scratch.path().join("note.txt").exists());
        assert!(!scratch.path().join("asset.bin").exists());
        supervisor.close(&db).unwrap();
    }
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
            assert_eq!(applied(&actor, "crash", "moment-crash").await, !outside);
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
    assert!(!applied(&actor, "binary-race", "moment-binary-race").await);
    assert_eq!(
        std::fs::read(scratch.path().join("asset.bin")).unwrap(),
        b"competitor"
    );
    assert_eq!(count(&actor).await, 1);
    supervisor.close(&db).unwrap();
}

async fn capture_env(
    actor: &ActorHandle,
    root: &Path,
    key: &dohc_engine_crypto::SecretDataKey,
    body: &str,
    now_ms: i64,
) -> i64 {
    std::fs::write(root.join(".env"), body).unwrap();
    actor
        .capture_secret(
            dohc_engine_domain::CaptureSecret {
                workspace_id: "publish".into(),
                version_id: "main".into(),
                path: ".env".into(),
                text: body.into(),
                metadata_origin: "local-file".into(),
                metadata_summary: None,
                metadata_correlation_id: None,
                now_ms,
                claim_foreign_head: true,
            },
            key.clone(),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .unwrap()
        .moment
        .unwrap()
        .moment_order
}

/// Secret capture names its job after a secret moment id a caller can
/// predict. A binary publication whose moment id spells that job id keeps its
/// own job, whether the capture came before or after it: capture neither
/// confirms the publication nor takes its place, and replay publishes it.
#[tokio::test]
async fn secret_capture_never_takes_a_binary_publication_job() {
    use dohc_engine_domain::secrets::derive_capture_secret_moment_id;
    for secret_order in [0, 1] {
        let scratch = ScratchDir::new().unwrap();
        let root = scratch.path();
        let db = engine_db_path(&scratch).unwrap();
        let supervisor = WorkspaceSupervisor::new();
        let actor = supervisor.open(&db, 1).unwrap().actor;
        let key = dohc_engine_crypto::create_key_file(&root.join(".dohc/engine")).unwrap();
        assert_eq!(capture_env(&actor, root, &key, "MODE=first", 20).await, 0);
        let moment = format!(
            "secret-mat_{}",
            derive_capture_secret_moment_id("publish", "main", ".env", secret_order)
        );
        let input = WriteBinary {
            moment_id: moment.clone(),
            ..binary("collision")
        };
        let bytes = input.bytes.clone();
        let crash = ScriptedFaults::crash_at(FaultPoint::MaterializeAfterJobCommit);
        assert_eq!(
            publish_binary(&actor, root, input, create(), crash).await,
            Outcome::Error,
            "{moment}"
        );
        assert_eq!(capture_env(&actor, root, &key, "MODE=second", 21).await, 1);
        assert!(!root.join("asset.bin").exists(), "{moment}");
        assert!(!applied(&actor, "collision", &moment).await, "{moment}");

        supervisor.close(&db).unwrap();
        let actor = supervisor.open(&db, 2).unwrap().actor;
        actor
            .materialize_replay_pending(root.into(), "publish".into(), 30)
            .await
            .unwrap();
        assert_eq!(std::fs::read(root.join("asset.bin")).unwrap(), bytes);
        assert!(applied(&actor, "collision", &moment).await, "{moment}");
        assert_eq!(
            std::fs::read_to_string(root.join(".env")).unwrap(),
            "MODE=second"
        );

        // Later work on both paths keeps the publication confirmed.
        let later = WriteBinary {
            bytes: vec![7, 7],
            ..binary("later")
        };
        let later_bytes = later.bytes.clone();
        assert_eq!(
            publish_binary(
                &actor,
                root,
                later,
                WriteConditions::default(),
                Arc::new(NoFaults)
            )
            .await,
            Outcome::Applied,
            "{moment}"
        );
        assert_eq!(capture_env(&actor, root, &key, "MODE=third", 40).await, 2);
        supervisor.close(&db).unwrap();
        let actor = supervisor.open(&db, 3).unwrap().actor;
        actor
            .materialize_replay_pending(root.into(), "publish".into(), 50)
            .await
            .unwrap();
        assert_eq!(std::fs::read(root.join("asset.bin")).unwrap(), later_bytes);
        assert_eq!(
            std::fs::read_to_string(root.join(".env")).unwrap(),
            "MODE=third"
        );
        assert!(applied(&actor, "collision", &moment).await, "{moment}");
        assert!(applied(&actor, "later", "moment-later").await, "{moment}");
        supervisor.close(&db).unwrap();

        // The secret's plaintext lives only in the workspace file.
        for suffix in ["", "-wal"] {
            let mut path = db.clone().into_os_string();
            path.push(suffix);
            let Ok(stored) = std::fs::read(&path) else {
                continue;
            };
            for body in ["MODE=first", "MODE=second", "MODE=third"] {
                assert!(
                    !stored
                        .windows(body.len())
                        .any(|window| window == body.as_bytes()),
                    "{moment}: {body}"
                );
            }
        }
    }
}
