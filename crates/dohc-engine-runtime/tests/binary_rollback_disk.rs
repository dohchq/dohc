use dohc_engine_domain::{
    CaptureIngestBinary, CreateNamedVersion, DeleteTextFile, RenameTextFile,
    RollbackTextFileMutation, WriteBinary, binary_rename_delete_job_id, binary_rename_write_job_id,
    binary_rollback_job_identity,
};
use dohc_engine_files::{
    CaptureOp, ManifestEntry, ReconcileController, ReconcileRun, ScanBounds, ScanGeneration,
    ScanManifest, Scanner,
};
use dohc_engine_runtime::{
    ActiveVersionSwitch, CancellationToken, NoFaults, PostCommitMaterializeOutcome,
    WorkspaceSupervisor,
};
use dohc_engine_storage::FaultPoint;
use dohc_engine_testkit::{ScratchDir, ScriptedFaults, engine_db_path};
use std::sync::Arc;

const WORKSPACE: &str = "ws-binary-rollback-disk";
const BYTES: &[u8] = &[0, 1, 2, 3, 0xff];
const UPDATED_BYTES: &[u8] = &[9, 8, 7, 6, 0xfe];
const OTHER_LINEAGE_BYTES: &[u8] = &[4, 3, 2, 1, 0xfd];

fn binary_write(path: &str, moment_id: &str) -> WriteBinary {
    binary_write_for("main", path, moment_id, BYTES)
}

fn binary_write_for(version_id: &str, path: &str, moment_id: &str, bytes: &[u8]) -> WriteBinary {
    WriteBinary {
        workspace_id: WORKSPACE.to_owned(),
        version_id: version_id.to_owned(),
        object_id: format!("object-{moment_id}"),
        path: path.to_owned(),
        bytes: bytes.to_vec(),
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
        metadata_origin: "restore".to_owned(),
        author_json: None,
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn rollback_restore_generation_fence_is_scoped_to_its_workspace() {
    const WORKSPACE_A: &str = "ws-generation-a";
    const WORKSPACE_B: &str = "ws-generation-b";

    let database = ScratchDir::new().expect("database scratch");
    let root_a = ScratchDir::new().expect("workspace A root");
    let root_b = ScratchDir::new().expect("workspace B root");
    let db = engine_db_path(&database).expect("db");
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 1).expect("open actor").actor;
    for workspace_id in [WORKSPACE_A, WORKSPACE_B] {
        actor
            .ensure_main_version(
                workspace_id.to_owned(),
                1,
                Arc::new(NoFaults),
                CancellationToken::new(),
            )
            .await
            .expect("main version");
    }

    let write = |workspace_id: &str, moment_id: &str, bytes: &[u8], now_ms: i64| WriteBinary {
        workspace_id: workspace_id.to_owned(),
        version_id: "main".to_owned(),
        object_id: format!("{workspace_id}-object"),
        path: "shared.bin".to_owned(),
        bytes: bytes.to_vec(),
        moment_id: moment_id.to_owned(),
        metadata_origin: "api".to_owned(),
        metadata_summary: None,
        metadata_correlation_id: None,
        author_json: None,
        now_ms,
        request_id: None,
    };
    actor
        .versioned_binary_write(
            write(WORKSPACE_A, "a-seed", BYTES, 10),
            root_a.path().to_path_buf(),
            Arc::new(()),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("workspace A seed");
    actor
        .versioned_binary_write(
            write(WORKSPACE_A, "a-mutation", UPDATED_BYTES, 20),
            root_a.path().to_path_buf(),
            Arc::new(()),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("workspace A mutation");

    let faults = ScriptedFaults::crash_at(FaultPoint::MaterializeAfterJobCommit);
    actor
        .versioned_text_rollback(
            RollbackTextFileMutation {
                workspace_id: WORKSPACE_A.to_owned(),
                version_id: "main".to_owned(),
                path: "shared.bin".to_owned(),
                mutation_moment_id: "a-mutation".to_owned(),
                request_id: None,
                metadata_origin: "restore".to_owned(),
                author_json: None,
            },
            root_a.path().to_path_buf(),
            Arc::new(()),
            faults.clone(),
            CancellationToken::new(),
        )
        .await
        .expect("committed workspace A rollback");
    assert!(faults.fired());
    assert_eq!(
        std::fs::read(root_a.path().join("shared.bin")).expect("pending A restore"),
        UPDATED_BYTES
    );

    actor
        .versioned_binary_write(
            write(WORKSPACE_B, "b-higher-generation", OTHER_LINEAGE_BYTES, 30),
            root_b.path().to_path_buf(),
            Arc::new(()),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("workspace B higher-generation write");

    let restore_job_id = binary_rollback_job_identity(WORKSPACE_A, "main", "a-mutation");
    let connection = rusqlite::Connection::open(&db).expect("read generation ledger");
    let (restore_generation, other_generation, restore_workspace, other_workspace): (
        i64,
        i64,
        String,
        String,
    ) = connection
        .query_row(
            "SELECT restore.target_generation, other.target_generation, \
                    restore.workspace_id, other.workspace_id \
             FROM materialization_jobs restore, materialization_jobs other \
             WHERE restore.job_id = ?1 AND other.job_id = 'binary-mat_b-higher-generation'",
            [&restore_job_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .expect("cross-workspace generations");
    assert!(other_generation > restore_generation);
    assert_eq!(restore_workspace, WORKSPACE_A);
    assert_eq!(other_workspace, WORKSPACE_B);
    drop(connection);

    assert_eq!(
        actor
            .materialize_replay_pending(root_a.path().to_path_buf(), WORKSPACE_A.to_owned(), 40)
            .await
            .expect("replay workspace A restore"),
        1
    );
    assert_eq!(
        std::fs::read(root_a.path().join("shared.bin")).expect("restored workspace A file"),
        BYTES,
        "workspace B's generation watermark must not supersede workspace A's restore"
    );
    assert_eq!(
        std::fs::read(root_b.path().join("shared.bin")).expect("workspace B file"),
        OTHER_LINEAGE_BYTES
    );
    let connection = rusqlite::Connection::open(&db).expect("read restore status");
    let status: String = connection
        .query_row(
            "SELECT status FROM materialization_jobs WHERE job_id = ?1",
            [restore_job_id],
            |row| row.get(0),
        )
        .expect("restore status");
    assert_eq!(status, "complete");
    drop(connection);
    supervisor.close(&db).expect("close actor");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn completed_binary_delete_rollback_restores_file_bytes() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = engine_db_path(&scratch).expect("db");
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 1).expect("open actor").actor;

    actor
        .versioned_binary_write(
            binary_write("deleted.bin", "delete-seed"),
            scratch.path().to_path_buf(),
            Arc::new(()),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("binary seed");
    actor
        .versioned_text_delete(
            delete("deleted.bin", "completed-delete"),
            scratch.path().to_path_buf(),
            Arc::new(()),
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
            Arc::new(()),
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
    let db = engine_db_path(&scratch).expect("db");
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 1).expect("open actor").actor;

    actor
        .versioned_binary_write(
            binary_write("old.bin", "rename-seed"),
            scratch.path().to_path_buf(),
            Arc::new(()),
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
            Arc::new(()),
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
            Arc::new(()),
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
async fn conflicted_rename_rollback_terminates_delete_and_capture_sees_survivor() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = engine_db_path(&scratch).expect("db");
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 1).expect("open actor").actor;

    actor
        .versioned_binary_write(
            binary_write("conflict-old.bin", "conflict-rename-seed"),
            scratch.path().to_path_buf(),
            Arc::new(()),
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
                from_path: "conflict-old.bin".to_owned(),
                to_path: "conflict-new.bin".to_owned(),
                moment_id: "conflicted-rollback".to_owned(),
                request_id: None,
                metadata_origin: "api".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 20,
            },
            scratch.path().to_path_buf(),
            Arc::new(()),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("completed rename");
    std::fs::write(scratch.path().join("conflict-old.bin"), UPDATED_BYTES)
        .expect("external occupant at rollback destination");

    let rolled_back = actor
        .versioned_text_rollback(
            rollback("main", "conflict-new.bin", "conflicted-rollback"),
            scratch.path().to_path_buf(),
            Arc::new(()),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("rollback commits despite disk conflict");
    assert!(!rolled_back.materialized);
    assert_eq!(
        rolled_back.materialize_outcome,
        PostCommitMaterializeOutcome::Conflict
    );
    assert_eq!(
        std::fs::read(scratch.path().join("conflict-old.bin")).expect("external occupant"),
        UPDATED_BYTES
    );
    assert_eq!(
        std::fs::read(scratch.path().join("conflict-new.bin")).expect("surviving renamed file"),
        BYTES
    );

    let rollback_identity = binary_rollback_job_identity(WORKSPACE, "main", "conflicted-rollback");
    let write_job_id = binary_rename_write_job_id(&rollback_identity);
    let delete_job_id = binary_rename_delete_job_id(&rollback_identity);
    let connection = rusqlite::Connection::open(&db).expect("read rollback jobs");
    let (write_status, delete_status): (String, String) = connection
        .query_row(
            "SELECT write.status, delete_job.status \
             FROM materialization_jobs write, materialization_jobs delete_job \
             WHERE write.job_id = ?1 AND delete_job.job_id = ?2",
            rusqlite::params![write_job_id, delete_job_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("paired rollback statuses");
    assert_eq!(write_status, "conflict");
    assert_eq!(
        delete_status, "conflict",
        "the delete half must be terminal when its prerequisite conflicts"
    );
    drop(connection);

    let seed = actor
        .capture_manifest_seed(WORKSPACE.to_owned(), "main".to_owned())
        .await
        .expect("capture seed");
    assert!(
        !seed.iter().any(|entry| entry.path == "conflict-new.bin"),
        "a terminal rollback delete must not seed the surviving renamed path"
    );
    let manifest = ScanManifest::from_entries(seed.into_iter().map(|entry| {
        (
            entry.path,
            ManifestEntry {
                size: entry.size,
                sha256: entry.sha256,
                mtime_ms: 0,
            },
        )
    }));
    let mut capture = ReconcileController::rehydrated(manifest, ScanGeneration::default());
    let scanner = Scanner::new(ScanBounds::default()).expect("scanner");
    let plan = match capture
        .reconcile(&scanner, scratch.path(), &CancellationToken::new())
        .expect("capture surviving file")
    {
        ReconcileRun::Completed(plan) => plan,
        other => panic!("unexpected capture run: {other:?}"),
    };
    assert!(plan.ops.iter().any(|op| matches!(
        op,
        CaptureOp::Ingest { path, .. } if path == "conflict-new.bin"
    )));
    actor
        .capture_ingest_binary(
            CaptureIngestBinary {
                workspace_id: WORKSPACE.to_owned(),
                version_id: "main".to_owned(),
                path: "conflict-new.bin".to_owned(),
                bytes: BYTES.to_vec(),
                metadata_origin: "capture".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 30,
                request_id: None,
                claim_foreign_head: false,
            },
            dohc_engine_collab::LeaseRegistry::new(),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("capture surviving renamed file");
    assert_eq!(
        actor
            .read_binary(
                WORKSPACE.to_owned(),
                "main".to_owned(),
                "conflict-new.bin".to_owned(),
            )
            .await
            .expect("read captured survivor")
            .expect("survivor head")
            .bytes,
        BYTES
    );
    supervisor.close(&db).expect("close actor");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn inactive_delete_rollback_drains_when_version_becomes_active() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = engine_db_path(&scratch).expect("db");
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
            Arc::new(()),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("main binary");
    actor
        .versioned_text_delete(
            delete("inactive.bin", "inactive-delete"),
            scratch.path().to_path_buf(),
            Arc::new(()),
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
                self_writes: Arc::new(()),
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
            Arc::new(()),
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
            .materialize_replay_pending(scratch.path().to_path_buf(), WORKSPACE.to_owned(), 31)
            .await
            .expect("inactive replay"),
        0
    );

    let connection = rusqlite::Connection::open(&db).expect("read job ledger");
    let restore_job_id = binary_rollback_job_identity(WORKSPACE, "main", "inactive-delete");
    let status: String = connection
        .query_row(
            "SELECT status FROM materialization_jobs WHERE job_id = ?1",
            [restore_job_id],
            |row| row.get(0),
        )
        .expect("restore job");
    assert_eq!(status, "pending");
    drop(connection);

    actor
        .set_active_version(
            ActiveVersionSwitch {
                workspace_id: WORKSPACE.to_owned(),
                version_id: "main".to_owned(),
                root_dir: scratch.path().to_path_buf(),
                self_writes: Arc::new(()),
                now_ms: 32,
            },
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("activate rolled-back version");
    assert_eq!(
        std::fs::read(scratch.path().join("inactive.bin"))
            .expect("activation restores file to disk"),
        BYTES
    );
    let connection = rusqlite::Connection::open(&db).expect("read drained job ledger");
    let restore_job_id = binary_rollback_job_identity(WORKSPACE, "main", "inactive-delete");
    let status: String = connection
        .query_row(
            "SELECT status FROM materialization_jobs WHERE job_id = ?1",
            [restore_job_id],
            |row| row.get(0),
        )
        .expect("drained restore job");
    assert_eq!(status, "complete");
    drop(connection);
    supervisor.close(&db).expect("close actor");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn rollback_replay_cannot_delete_another_workspaces_file() {
    const WORKSPACE_A: &str = "ws-rollback-owner";
    const WORKSPACE_B: &str = "ws-replay-root";

    let database = ScratchDir::new().expect("database scratch");
    let root_a = ScratchDir::new().expect("workspace A root");
    let root_b = ScratchDir::new().expect("workspace B root");
    let db = engine_db_path(&database).expect("db");
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 1).expect("open actor").actor;
    for workspace_id in [WORKSPACE_A, WORKSPACE_B] {
        actor
            .ensure_main_version(
                workspace_id.to_owned(),
                1,
                Arc::new(NoFaults),
                CancellationToken::new(),
            )
            .await
            .expect("main version");
    }

    actor
        .versioned_binary_write(
            WriteBinary {
                workspace_id: WORKSPACE_A.to_owned(),
                version_id: "main".to_owned(),
                object_id: "workspace-a-object".to_owned(),
                path: "shared.bin".to_owned(),
                bytes: BYTES.to_vec(),
                moment_id: "workspace-a-write".to_owned(),
                metadata_origin: "api".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 10,
                request_id: None,
            },
            root_a.path().to_path_buf(),
            Arc::new(()),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("workspace A write");
    let faults = ScriptedFaults::crash_at(FaultPoint::MaterializeAfterJobCommit);
    actor
        .versioned_text_rollback(
            RollbackTextFileMutation {
                workspace_id: WORKSPACE_A.to_owned(),
                version_id: "main".to_owned(),
                path: "shared.bin".to_owned(),
                mutation_moment_id: "workspace-a-write".to_owned(),
                request_id: None,
                metadata_origin: "restore".to_owned(),
                author_json: None,
            },
            root_a.path().to_path_buf(),
            Arc::new(()),
            faults.clone(),
            CancellationToken::new(),
        )
        .await
        .expect("committed workspace A rollback");
    assert!(faults.fired());
    assert_eq!(
        std::fs::read(root_a.path().join("shared.bin")).expect("pending A delete"),
        BYTES
    );

    std::fs::write(root_b.path().join("shared.bin"), UPDATED_BYTES).expect("workspace B file");
    actor
        .materialize_replay_pending_for_fence(
            root_b.path().to_path_buf(),
            WORKSPACE_B.to_owned(),
            Arc::new(()),
            20,
        )
        .await
        .expect("workspace B replay");
    assert_eq!(
        std::fs::read(root_b.path().join("shared.bin")).expect("workspace B file survives"),
        UPDATED_BYTES
    );

    let connection = rusqlite::Connection::open(&db).expect("read pending A restore");
    let restore_job_id = binary_rollback_job_identity(WORKSPACE_A, "main", "workspace-a-write");
    let status: String = connection
        .query_row(
            "SELECT status FROM materialization_jobs WHERE job_id = ?1",
            [restore_job_id],
            |row| row.get(0),
        )
        .expect("workspace A restore job");
    assert_eq!(status, "pending");
    drop(connection);
    supervisor.close(&db).expect("close actor");
}
