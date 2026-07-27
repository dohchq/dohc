use dohc_engine_domain::{CreateNamedVersion, RollbackTextFileMutation, WriteBinary};
use dohc_engine_runtime::{
    ActiveVersionSwitch, CancellationToken, NoFaults, PostCommitMaterializeOutcome,
    SelfWriteRecorder, WorkspaceSupervisor,
};
use dohc_engine_storage::FaultPoint;
use dohc_engine_testkit::{ScratchDir, ScriptedFaults};
use std::sync::Arc;

struct NoRecorder;

impl SelfWriteRecorder for NoRecorder {
    fn record(&self, _workspace_id: &str, _path: &str, _sha256: &str) {}
    fn retract(&self, _workspace_id: &str, _path: &str, _sha256: &str) {}
}

fn binary_input(request_id: &str) -> WriteBinary {
    WriteBinary {
        workspace_id: "ws-binary-materialize-retry".to_owned(),
        version_id: "main".to_owned(),
        object_id: "binary-object".to_owned(),
        path: "asset.bin".to_owned(),
        bytes: vec![1, 2, 3, 4],
        moment_id: "binary-original-moment".to_owned(),
        metadata_origin: "api".to_owned(),
        metadata_summary: None,
        metadata_correlation_id: None,
        author_json: None,
        now_ms: 10,
        request_id: Some(request_id.to_owned()),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn deduped_binary_write_retries_its_original_pending_materialization() {
    // MUTATION: keep the deduped skipped short-circuit -> the retry reports
    // skipped and asset.bin remains absent.
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 1).expect("open actor").actor;
    let input = binary_input("binary-materialize-request");
    let faults = ScriptedFaults::crash_at(FaultPoint::MaterializeAfterJobCommit);

    let first = actor
        .versioned_binary_write(
            input.clone(),
            scratch.path().to_path_buf(),
            Arc::new(NoRecorder),
            faults.clone(),
            CancellationToken::new(),
        )
        .await
        .expect("committed binary write");
    assert!(!first.write.deduped);
    assert_eq!(
        first.materialize_outcome,
        PostCommitMaterializeOutcome::Error
    );
    assert!(faults.fired(), "materialization fault must fire");
    assert!(!scratch.path().join("asset.bin").exists());

    let retried = actor
        .versioned_binary_write(
            input,
            scratch.path().to_path_buf(),
            Arc::new(NoRecorder),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("deduped retry");
    assert!(retried.write.deduped);
    assert_eq!(retried.write.moment.moment_id, "binary-original-moment");
    assert!(retried.materialized);
    assert_eq!(
        retried.materialize_outcome,
        PostCommitMaterializeOutcome::Applied
    );
    assert_eq!(
        std::fs::read(scratch.path().join("asset.bin")).expect("materialized bytes"),
        [1, 2, 3, 4]
    );
    supervisor.close(&db).expect("close actor");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn deduped_binary_rollback_retries_its_pending_compensation() {
    // MUTATION: keep rollback's deduped skipped short-circuit -> asset.bin
    // survives the retry and the pending compensation never reaches disk.
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 1).expect("open actor").actor;
    actor
        .versioned_binary_write(
            binary_input("binary-seed-request"),
            scratch.path().to_path_buf(),
            Arc::new(NoRecorder),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("materialized binary seed");
    assert!(scratch.path().join("asset.bin").exists());

    let rollback = RollbackTextFileMutation {
        workspace_id: "ws-binary-materialize-retry".to_owned(),
        version_id: "main".to_owned(),
        path: "asset.bin".to_owned(),
        mutation_moment_id: "binary-original-moment".to_owned(),
        request_id: Some("binary-rollback-request".to_owned()),
        legacy_before_text: None,
        metadata_origin: "restore".to_owned(),
        author_json: None,
    };
    let faults = ScriptedFaults::crash_at(FaultPoint::MaterializeAfterJobCommit);
    let first = actor
        .versioned_text_rollback(
            rollback.clone(),
            scratch.path().to_path_buf(),
            Arc::new(NoRecorder),
            faults.clone(),
            CancellationToken::new(),
        )
        .await
        .expect("committed rollback");
    assert!(!first.deduped);
    assert_eq!(
        first.materialize_outcome,
        PostCommitMaterializeOutcome::Error
    );
    assert!(faults.fired(), "rollback materialization fault must fire");
    assert!(scratch.path().join("asset.bin").exists());

    let retried = actor
        .versioned_text_rollback(
            rollback,
            scratch.path().to_path_buf(),
            Arc::new(NoRecorder),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("deduped rollback retry");
    assert!(retried.deduped);
    assert!(retried.materialized);
    assert_eq!(
        retried.materialize_outcome,
        PostCommitMaterializeOutcome::Applied
    );
    assert!(!scratch.path().join("asset.bin").exists());
    supervisor.close(&db).expect("close actor");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn inactive_binary_rollback_cancels_the_original_pending_job_before_reopen() {
    // MUTATION: keep original-job cancellation behind the active-version guard
    // -> reopen replays main's stale bytes into branch's working tree.
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 1).expect("open actor").actor;
    actor
        .ensure_main_version(
            "ws-binary-materialize-retry".to_owned(),
            1,
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("main");
    actor
        .create_named_version(
            CreateNamedVersion {
                workspace_id: "ws-binary-materialize-retry".to_owned(),
                new_version_id: "branch".to_owned(),
                name: "Branch".to_owned(),
                from_version_id: "main".to_owned(),
                now_ms: 2,
                request_id: None,
            },
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("branch before binary write");

    let faults = ScriptedFaults::crash_at(FaultPoint::MaterializeAfterJobCommit);
    let write = actor
        .versioned_binary_write(
            binary_input("inactive-rollback-binary-write"),
            scratch.path().to_path_buf(),
            Arc::new(NoRecorder),
            faults.clone(),
            CancellationToken::new(),
        )
        .await
        .expect("committed binary write with pending job");
    assert_eq!(
        write.materialize_outcome,
        PostCommitMaterializeOutcome::Error
    );
    assert!(faults.fired(), "materialization fault must fire");
    assert!(!scratch.path().join("asset.bin").exists());

    actor
        .set_active_version(
            ActiveVersionSwitch {
                workspace_id: "ws-binary-materialize-retry".to_owned(),
                version_id: "branch".to_owned(),
                root_dir: scratch.path().to_path_buf(),
                self_writes: Arc::new(NoRecorder),
                now_ms: 10,
            },
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("activate branch");
    let rollback = actor
        .versioned_text_rollback(
            RollbackTextFileMutation {
                workspace_id: "ws-binary-materialize-retry".to_owned(),
                version_id: "main".to_owned(),
                path: "asset.bin".to_owned(),
                mutation_moment_id: "binary-original-moment".to_owned(),
                request_id: Some("inactive-binary-rollback".to_owned()),
                legacy_before_text: None,
                metadata_origin: "restore".to_owned(),
                author_json: None,
            },
            scratch.path().to_path_buf(),
            Arc::new(NoRecorder),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("rollback inactive main");
    assert!(!rollback.materialize_enqueued);
    assert_eq!(
        rollback.materialize_outcome,
        PostCommitMaterializeOutcome::Skipped
    );

    supervisor.close(&db).expect("close actor");
    let reopened = supervisor.open(&db, 20).expect("reopen actor").actor;
    assert_eq!(
        reopened
            .materialize_replay_pending(scratch.path().to_path_buf(), 21)
            .await
            .expect("open-time replay"),
        0,
        "the rolled-back main job must not survive to replay"
    );
    assert!(
        !scratch.path().join("asset.bin").exists(),
        "branch's working tree must not receive main's rolled-back bytes"
    );
    supervisor.close(&db).expect("close reopened actor");
}
