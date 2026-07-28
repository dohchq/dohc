use dohc_engine_domain::{
    CaptureIngestBinary, CaptureRetire, CreateNamedVersion, DeleteTextFile, RenameTextFile,
    RollbackTextFileMutation, WriteBinary,
};
use dohc_engine_runtime::{
    ActiveVersionSwitch, CancellationToken, NoFaults, PostCommitMaterializeOutcome,
    SelfWriteRecorder, WorkspaceSupervisor,
};
use dohc_engine_storage::FaultPoint;
use dohc_engine_testkit::{ScratchDir, ScriptedFaults};
use std::sync::Arc;

const WORKSPACE: &str = "ws-binary-rollback-disk";
const BYTES: &[u8] = &[0, 1, 2, 3, 0xff];

struct NoRecorder;

impl SelfWriteRecorder for NoRecorder {
    fn record(&self, _workspace_id: &str, _path: &str, _sha256: &str) {}
    fn retract(&self, _workspace_id: &str, _path: &str, _sha256: &str) {}
}

fn binary_write(path: &str, moment_id: &str) -> WriteBinary {
    WriteBinary {
        workspace_id: WORKSPACE.to_owned(),
        version_id: "main".to_owned(),
        object_id: format!("object-{moment_id}"),
        path: path.to_owned(),
        bytes: BYTES.to_vec(),
        moment_id: moment_id.to_owned(),
        metadata_origin: "api".to_owned(),
        metadata_summary: None,
        metadata_correlation_id: None,
        author_json: None,
        now_ms: 10,
        request_id: None,
    }
}

fn delete(path: &str, moment_id: &str) -> DeleteTextFile {
    DeleteTextFile {
        workspace_id: WORKSPACE.to_owned(),
        version_id: "main".to_owned(),
        path: path.to_owned(),
        moment_id: moment_id.to_owned(),
        request_id: None,
        metadata_origin: "api".to_owned(),
        metadata_summary: None,
        metadata_correlation_id: None,
        author_json: None,
        now_ms: 20,
    }
}

fn rollback(version_id: &str, path: &str, moment_id: &str) -> RollbackTextFileMutation {
    RollbackTextFileMutation {
        workspace_id: WORKSPACE.to_owned(),
        version_id: version_id.to_owned(),
        path: path.to_owned(),
        mutation_moment_id: moment_id.to_owned(),
        request_id: None,
        legacy_before_text: None,
        metadata_origin: "restore".to_owned(),
        author_json: None,
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn completed_binary_delete_rollback_restores_file_bytes() {
    // MUTATION: remove the binary-delete rollback restore enqueue -> this
    // leaves deleted.bin absent after the DB head has been restored.
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 1).expect("open actor").actor;

    actor
        .versioned_binary_write(
            binary_write("deleted.bin", "delete-seed"),
            scratch.path().to_path_buf(),
            Arc::new(NoRecorder),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("binary seed");
    actor
        .versioned_text_delete(
            delete("deleted.bin", "completed-delete"),
            scratch.path().to_path_buf(),
            Arc::new(NoRecorder),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("completed delete");
    assert!(!scratch.path().join("deleted.bin").exists());

    let result = actor
        .versioned_text_rollback(
            rollback("main", "deleted.bin", "completed-delete"),
            scratch.path().to_path_buf(),
            Arc::new(NoRecorder),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("delete rollback");
    assert!(result.materialize_enqueued);
    assert!(result.materialized);
    assert_eq!(
        std::fs::read(scratch.path().join("deleted.bin")).expect("restored file"),
        BYTES
    );
    supervisor.close(&db).expect("close actor");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn completed_binary_rename_rollback_restores_old_path_and_removes_new_path() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 1).expect("open actor").actor;

    actor
        .versioned_binary_write(
            binary_write("old.bin", "rename-seed"),
            scratch.path().to_path_buf(),
            Arc::new(NoRecorder),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("binary seed");
    actor
        .versioned_text_rename(
            RenameTextFile {
                workspace_id: WORKSPACE.to_owned(),
                version_id: "main".to_owned(),
                from_path: "old.bin".to_owned(),
                to_path: "new.bin".to_owned(),
                moment_id: "completed-rename".to_owned(),
                request_id: None,
                metadata_origin: "api".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 20,
            },
            scratch.path().to_path_buf(),
            Arc::new(NoRecorder),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("completed rename");
    assert!(!scratch.path().join("old.bin").exists());
    assert_eq!(
        std::fs::read(scratch.path().join("new.bin")).expect("renamed file"),
        BYTES
    );

    let result = actor
        .versioned_text_rollback(
            rollback("main", "new.bin", "completed-rename"),
            scratch.path().to_path_buf(),
            Arc::new(NoRecorder),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("rename rollback");
    assert!(result.materialized);
    assert_eq!(
        std::fs::read(scratch.path().join("old.bin")).expect("restored old path"),
        BYTES
    );
    assert!(!scratch.path().join("new.bin").exists());
    supervisor.close(&db).expect("close actor");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pending_delete_rollback_restore_is_not_seeded_for_capture_retire_on_reopen() {
    // MUTATION: remove capture_manifest_seed's pending rollback-job exclusion
    // -> the emulated baseline sees capture.bin missing, retires the restored
    // capture-origin head, and the final read returns None.
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 1).expect("open actor").actor;
    std::fs::write(scratch.path().join("capture.bin"), BYTES).expect("disk capture seed");
    actor
        .capture_ingest_binary(
            CaptureIngestBinary {
                workspace_id: WORKSPACE.to_owned(),
                version_id: "main".to_owned(),
                path: "capture.bin".to_owned(),
                bytes: BYTES.to_vec(),
                metadata_origin: "capture".to_owned(),
                author_json: None,
                now_ms: 10,
                request_id: None,
                claim_foreign_head: false,
            },
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("capture binary");
    actor
        .versioned_text_delete(
            delete("capture.bin", "capture-delete"),
            scratch.path().to_path_buf(),
            Arc::new(NoRecorder),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("delete captured binary");

    let faults = ScriptedFaults::crash_at(FaultPoint::MaterializeAfterJobCommit);
    let result = actor
        .versioned_text_rollback(
            rollback("main", "capture.bin", "capture-delete"),
            scratch.path().to_path_buf(),
            Arc::new(NoRecorder),
            faults.clone(),
            CancellationToken::new(),
        )
        .await
        .expect("committed rollback with pending restore");
    assert_eq!(
        result.materialize_outcome,
        PostCommitMaterializeOutcome::Error
    );
    assert!(faults.fired());
    assert!(!scratch.path().join("capture.bin").exists());
    supervisor.close(&db).expect("close actor");

    let reopened = supervisor.open(&db, 40).expect("reopen actor").actor;
    let seed = reopened
        .capture_manifest_seed(WORKSPACE.to_owned(), "main".to_owned())
        .await
        .expect("capture seed");
    for entry in seed {
        if !scratch.path().join(&entry.path).exists() {
            reopened
                .capture_retire(
                    CaptureRetire {
                        workspace_id: WORKSPACE.to_owned(),
                        version_id: "main".to_owned(),
                        path: entry.path,
                        now_ms: 41,
                        request_id: None,
                        only_if_text_head: false,
                        only_if_capture_origin: true,
                    },
                    Arc::new(NoFaults),
                    CancellationToken::new(),
                )
                .await
                .expect("emulated baseline retire");
        }
    }
    let restored = reopened
        .read_binary(
            WORKSPACE.to_owned(),
            "main".to_owned(),
            "capture.bin".to_owned(),
        )
        .await
        .expect("read restored head");
    assert_eq!(
        restored.expect("pending restore head must survive").bytes,
        BYTES
    );
    supervisor.close(&db).expect("close reopened actor");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn inactive_delete_rollback_is_db_only_and_leaves_restore_job_pending() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 1).expect("open actor").actor;
    actor
        .ensure_main_version(
            WORKSPACE.to_owned(),
            1,
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("main");
    actor
        .create_named_version(
            CreateNamedVersion {
                workspace_id: WORKSPACE.to_owned(),
                new_version_id: "empty-branch".to_owned(),
                name: "Empty branch".to_owned(),
                from_version_id: "main".to_owned(),
                now_ms: 2,
                request_id: None,
            },
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("empty branch");
    actor
        .versioned_binary_write(
            binary_write("inactive.bin", "inactive-seed"),
            scratch.path().to_path_buf(),
            Arc::new(NoRecorder),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("main binary");
    actor
        .versioned_text_delete(
            delete("inactive.bin", "inactive-delete"),
            scratch.path().to_path_buf(),
            Arc::new(NoRecorder),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("main delete");
    actor
        .set_active_version(
            ActiveVersionSwitch {
                workspace_id: WORKSPACE.to_owned(),
                version_id: "empty-branch".to_owned(),
                root_dir: scratch.path().to_path_buf(),
                self_writes: Arc::new(NoRecorder),
                now_ms: 30,
            },
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("activate empty branch");

    let result = actor
        .versioned_text_rollback(
            rollback("main", "inactive.bin", "inactive-delete"),
            scratch.path().to_path_buf(),
            Arc::new(NoRecorder),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("inactive rollback");
    assert!(result.materialize_enqueued);
    assert!(!result.materialized);
    assert_eq!(
        result.materialize_outcome,
        PostCommitMaterializeOutcome::Skipped
    );
    assert!(!scratch.path().join("inactive.bin").exists());
    assert_eq!(
        actor
            .materialize_replay_pending(scratch.path().to_path_buf(), 31)
            .await
            .expect("inactive replay"),
        0
    );

    let connection = rusqlite::Connection::open(&db).expect("read job ledger");
    let status: String = connection
        .query_row(
            "SELECT status FROM materialization_jobs \
             WHERE job_id = 'rollback-restore_inactive-delete'",
            [],
            |row| row.get(0),
        )
        .expect("restore job");
    assert_eq!(status, "pending");
    drop(connection);
    supervisor.close(&db).expect("close actor");
}
