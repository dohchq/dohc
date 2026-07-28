use dohc_engine_domain::{
    CaptureIngestBinary, CaptureRetire, CreateNamedVersion, DeleteTextFile, RenameTextFile,
    RollbackTextFileMutation, WriteBinary, binary_rename_delete_job_id, binary_rename_write_job_id,
    binary_rollback_job_identity,
};
use dohc_engine_files::{
    CaptureOp, ManifestEntry, ReconcileController, ReconcileRun, ScanBounds, ScanGeneration,
    ScanManifest, Scanner,
};
use dohc_engine_runtime::{
    ActiveVersionSwitch, CancellationToken, NoFaults, PostCommitMaterializeOutcome,
    SelfWriteRecorder, WorkspaceSupervisor,
};
use dohc_engine_storage::{FaultAction, FaultInjector, FaultPoint};
use dohc_engine_testkit::{ScratchDir, ScriptedFaults};
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

const WORKSPACE: &str = "ws-binary-rollback-disk";
const BYTES: &[u8] = &[0, 1, 2, 3, 0xff];
const UPDATED_BYTES: &[u8] = &[9, 8, 7, 6, 0xfe];
const OTHER_LINEAGE_BYTES: &[u8] = &[4, 3, 2, 1, 0xfd];

struct NoRecorder;

impl SelfWriteRecorder for NoRecorder {
    fn record(&self, _workspace_id: &str, _path: &str, _sha256: &str) {}
    fn retract(&self, _workspace_id: &str, _path: &str, _sha256: &str) {}
}

struct CrashSecondMaterialization {
    visits: AtomicUsize,
}

impl CrashSecondMaterialization {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            visits: AtomicUsize::new(0),
        })
    }
}

impl FaultInjector for CrashSecondMaterialization {
    fn poll(&self, point: FaultPoint) -> FaultAction {
        if point == FaultPoint::MaterializeAfterJobCommit
            && self.visits.fetch_add(1, Ordering::AcqRel) == 1
        {
            FaultAction::Crash
        } else {
            FaultAction::Continue
        }
    }
}

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
        legacy_before_text: None,
        metadata_origin: "restore".to_owned(),
        author_json: None,
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn rollback_restore_uses_current_generation_over_newer_completed_lineage() {
    // MUTATION: pass the rolled-back moment's historical generation to
    // enqueue_binary_rollback_restore -> the completed other-lineage write
    // supersedes this active restore and disk remains on UPDATED_BYTES.
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
                new_version_id: "other-lineage".to_owned(),
                name: "Other lineage".to_owned(),
                from_version_id: "main".to_owned(),
                now_ms: 2,
                request_id: None,
            },
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("empty other lineage");

    actor
        .versioned_binary_write(
            binary_write_for("main", "shared.bin", "main-seed", BYTES),
            scratch.path().to_path_buf(),
            Arc::new(NoRecorder),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("main seed");
    actor
        .versioned_binary_write(
            binary_write_for("main", "shared.bin", "main-mutation", UPDATED_BYTES),
            scratch.path().to_path_buf(),
            Arc::new(NoRecorder),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("main mutation");
    actor
        .set_active_version(
            ActiveVersionSwitch {
                workspace_id: WORKSPACE.to_owned(),
                version_id: "other-lineage".to_owned(),
                root_dir: scratch.path().to_path_buf(),
                self_writes: Arc::new(NoRecorder),
                now_ms: 30,
            },
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("activate other lineage");
    actor
        .versioned_binary_write(
            binary_write_for(
                "other-lineage",
                "shared.bin",
                "higher-generation",
                OTHER_LINEAGE_BYTES,
            ),
            scratch.path().to_path_buf(),
            Arc::new(NoRecorder),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("higher-generation other-lineage write");
    actor
        .set_active_version(
            ActiveVersionSwitch {
                workspace_id: WORKSPACE.to_owned(),
                version_id: "main".to_owned(),
                root_dir: scratch.path().to_path_buf(),
                self_writes: Arc::new(NoRecorder),
                now_ms: 40,
            },
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("reactivate main");
    assert_eq!(
        std::fs::read(scratch.path().join("shared.bin")).expect("main bytes on disk"),
        UPDATED_BYTES
    );

    let result = actor
        .versioned_text_rollback(
            rollback("main", "shared.bin", "main-mutation"),
            scratch.path().to_path_buf(),
            Arc::new(NoRecorder),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("active rollback");
    assert!(result.materialized);
    assert_eq!(
        result.materialize_outcome,
        PostCommitMaterializeOutcome::Applied
    );
    assert_eq!(
        std::fs::read(scratch.path().join("shared.bin")).expect("restored disk bytes"),
        BYTES
    );

    let connection = rusqlite::Connection::open(&db).expect("read generations");
    let restore_job_id = binary_rollback_job_identity(WORKSPACE, "main", "main-mutation");
    let (higher_generation, restore_generation): (i64, i64) = connection
        .query_row(
            "SELECT higher.target_generation, restore.target_generation \
             FROM materialization_jobs higher, materialization_jobs restore \
             WHERE higher.job_id = 'higher-generation' \
               AND restore.job_id = ?1",
            [restore_job_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("materialization generations");
    assert!(
        restore_generation > higher_generation,
        "rollback must mint a generation newer than completed path history"
    );
    drop(connection);
    supervisor.close(&db).expect("close actor");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn write_after_tip_rollback_is_newer_than_the_completed_restore() {
    // MUTATION: derive next_moment_order from moments alone -> deleting the
    // tip lets this new write fall below the completed restore fence.
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 1).expect("open actor").actor;

    actor
        .versioned_binary_write(
            binary_write_for("main", "tip.bin", "tip-seed", BYTES),
            scratch.path().to_path_buf(),
            Arc::new(NoRecorder),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("seed write");
    actor
        .versioned_binary_write(
            binary_write_for("main", "tip.bin", "tip-mutation", UPDATED_BYTES),
            scratch.path().to_path_buf(),
            Arc::new(NoRecorder),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("tip mutation");

    let faults = ScriptedFaults::crash_at(FaultPoint::MaterializeAfterJobCommit);
    let rolled_back = actor
        .versioned_text_rollback(
            rollback("main", "tip.bin", "tip-mutation"),
            scratch.path().to_path_buf(),
            Arc::new(NoRecorder),
            faults.clone(),
            CancellationToken::new(),
        )
        .await
        .expect("committed tip rollback");
    assert_eq!(
        rolled_back.materialize_outcome,
        PostCommitMaterializeOutcome::Error
    );
    assert!(faults.fired());

    actor
        .materialize_replay_pending(scratch.path().to_path_buf(), WORKSPACE.to_owned(), 30)
        .await
        .expect("complete rollback restore");
    assert_eq!(
        std::fs::read(scratch.path().join("tip.bin")).expect("rolled-back bytes on disk"),
        BYTES
    );

    actor
        .versioned_binary_write(
            binary_write_for(
                "main",
                "tip.bin",
                "post-rollback-write",
                OTHER_LINEAGE_BYTES,
            ),
            scratch.path().to_path_buf(),
            Arc::new(NoRecorder),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("new write after rollback");
    assert_eq!(
        std::fs::read(scratch.path().join("tip.bin")).expect("final disk bytes"),
        OTHER_LINEAGE_BYTES,
        "the completed restore fence must not suppress a post-rollback write"
    );

    let connection = rusqlite::Connection::open(&db).expect("read job ledger");
    let restore_job_id = binary_rollback_job_identity(WORKSPACE, "main", "tip-mutation");
    let (restore_generation, write_generation, restore_status, write_status): (
        i64,
        i64,
        String,
        String,
    ) = connection
        .query_row(
            "SELECT restore.target_generation, newer.target_generation, \
                    restore.status, newer.status \
             FROM materialization_jobs restore, materialization_jobs newer \
             WHERE restore.job_id = ?1 \
               AND newer.job_id = 'post-rollback-write'",
            [restore_job_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .expect("restore and new-write jobs");
    assert!(write_generation > restore_generation);
    assert_eq!(restore_status, "complete");
    assert_eq!(write_status, "complete");
    drop(connection);
    supervisor.close(&db).expect("close actor");
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
async fn capture_ignores_a_pending_rename_rollback_delete_until_retry() {
    // MUTATION: omit pending rollback deletes from capture_manifest_seed ->
    // the baseline reports new-pending.bin as Added and capture can adopt it.
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 1).expect("open actor").actor;

    actor
        .versioned_binary_write(
            binary_write("old-pending.bin", "pending-rename-seed"),
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
                from_path: "old-pending.bin".to_owned(),
                to_path: "new-pending.bin".to_owned(),
                moment_id: "pending-rename".to_owned(),
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

    let faults = CrashSecondMaterialization::new();
    let rolled_back = actor
        .versioned_text_rollback(
            rollback("main", "new-pending.bin", "pending-rename"),
            scratch.path().to_path_buf(),
            Arc::new(NoRecorder),
            faults,
            CancellationToken::new(),
        )
        .await
        .expect("rollback with pending delete");
    assert!(!rolled_back.materialized);
    assert_eq!(
        rolled_back.materialize_outcome,
        PostCommitMaterializeOutcome::Error
    );
    assert_eq!(
        std::fs::read(scratch.path().join("old-pending.bin")).expect("restored old path"),
        BYTES
    );
    assert_eq!(
        std::fs::read(scratch.path().join("new-pending.bin")).expect("delete still pending"),
        BYTES
    );

    let seed = actor
        .capture_manifest_seed(WORKSPACE.to_owned(), "main".to_owned())
        .await
        .expect("capture seed");
    assert!(
        seed.iter().any(|entry| entry.path == "new-pending.bin"),
        "the pending rollback-delete target must be guarded in the capture baseline"
    );
    let manifest = ScanManifest::from_entries(seed.into_iter().map(|entry| {
        (
            entry.path,
            ManifestEntry {
                size: entry.size,
                sha256: entry.sha256,
            },
        )
    }));
    let mut capture = ReconcileController::rehydrated(manifest, ScanGeneration::default());
    let scanner = Scanner::new(ScanBounds::default()).expect("scanner");
    let plan = match capture
        .reconcile(&scanner, scratch.path(), &CancellationToken::new())
        .expect("capture baseline")
    {
        ReconcileRun::Completed(plan) => plan,
        other => panic!("unexpected capture run: {other:?}"),
    };
    assert!(
        !plan.ops.iter().any(|op| matches!(
            op,
            CaptureOp::Ingest { path, .. } if path == "new-pending.bin"
        )),
        "capture must not adopt a path whose rollback delete is pending"
    );
    assert!(
        actor
            .read_binary(
                WORKSPACE.to_owned(),
                "main".to_owned(),
                "new-pending.bin".to_owned(),
            )
            .await
            .expect("read renamed path")
            .is_none(),
        "the rolled-back rename must still have only one DB head"
    );

    actor
        .materialize_replay_pending(scratch.path().to_path_buf(), WORKSPACE.to_owned(), 30)
        .await
        .expect("retry pending rename delete");
    assert!(!scratch.path().join("new-pending.bin").exists());
    let connection = rusqlite::Connection::open(&db).expect("read delete job");
    let rollback_identity = binary_rollback_job_identity(WORKSPACE, "main", "pending-rename");
    let delete_job_id = binary_rename_delete_job_id(&rollback_identity);
    let status: String = connection
        .query_row(
            "SELECT status FROM materialization_jobs WHERE job_id = ?1",
            [delete_job_id],
            |row| row.get(0),
        )
        .expect("rename delete status");
    assert_eq!(status, "complete");
    drop(connection);
    supervisor.close(&db).expect("close actor");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn capture_ingests_an_inactive_versions_pending_rename_destination() {
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
                new_version_id: "inactive-rename".to_owned(),
                name: "Inactive rename".to_owned(),
                from_version_id: "main".to_owned(),
                now_ms: 2,
                request_id: None,
            },
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("branch");
    actor
        .set_active_version(
            ActiveVersionSwitch {
                workspace_id: WORKSPACE.to_owned(),
                version_id: "inactive-rename".to_owned(),
                root_dir: scratch.path().to_path_buf(),
                self_writes: Arc::new(NoRecorder),
                now_ms: 3,
            },
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("activate branch");
    actor
        .versioned_binary_write(
            binary_write_for("inactive-rename", "branch-old.bin", "branch-seed", BYTES),
            scratch.path().to_path_buf(),
            Arc::new(NoRecorder),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("branch binary");
    actor
        .versioned_text_rename(
            RenameTextFile {
                workspace_id: WORKSPACE.to_owned(),
                version_id: "inactive-rename".to_owned(),
                from_path: "branch-old.bin".to_owned(),
                to_path: "branch-new.bin".to_owned(),
                moment_id: "branch-rename".to_owned(),
                request_id: None,
                metadata_origin: "api".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 10,
            },
            scratch.path().to_path_buf(),
            Arc::new(NoRecorder),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("branch rename");
    actor
        .set_active_version(
            ActiveVersionSwitch {
                workspace_id: WORKSPACE.to_owned(),
                version_id: "main".to_owned(),
                root_dir: scratch.path().to_path_buf(),
                self_writes: Arc::new(NoRecorder),
                now_ms: 20,
            },
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("reactivate empty main");

    let rolled_back = actor
        .versioned_text_rollback(
            rollback("inactive-rename", "branch-new.bin", "branch-rename"),
            scratch.path().to_path_buf(),
            Arc::new(NoRecorder),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("inactive rename rollback");
    assert!(rolled_back.materialize_enqueued);
    assert_eq!(
        rolled_back.materialize_outcome,
        PostCommitMaterializeOutcome::Skipped
    );

    std::fs::write(scratch.path().join("branch-new.bin"), BYTES)
        .expect("user-created active-version file");
    let seed = actor
        .capture_manifest_seed(WORKSPACE.to_owned(), "main".to_owned())
        .await
        .expect("main capture seed");
    assert!(
        !seed.iter().any(|entry| entry.path == "branch-new.bin"),
        "an inactive version's rollback delete must not suppress active capture"
    );
    let manifest = ScanManifest::from_entries(seed.into_iter().map(|entry| {
        (
            entry.path,
            ManifestEntry {
                size: entry.size,
                sha256: entry.sha256,
            },
        )
    }));
    let mut capture = ReconcileController::rehydrated(manifest, ScanGeneration::default());
    let scanner = Scanner::new(ScanBounds::default()).expect("scanner");
    let plan = match capture
        .reconcile(&scanner, scratch.path(), &CancellationToken::new())
        .expect("capture active version")
    {
        ReconcileRun::Completed(plan) => plan,
        other => panic!("unexpected capture run: {other:?}"),
    };
    assert!(plan.ops.iter().any(|op| matches!(
        op,
        CaptureOp::Ingest { path, .. } if path == "branch-new.bin"
    )));
    actor
        .capture_ingest_binary(
            CaptureIngestBinary {
                workspace_id: WORKSPACE.to_owned(),
                version_id: "main".to_owned(),
                path: "branch-new.bin".to_owned(),
                bytes: BYTES.to_vec(),
                metadata_origin: "capture".to_owned(),
                author_json: None,
                now_ms: 30,
                request_id: None,
                claim_foreign_head: false,
            },
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("ingest user file into active version");
    assert_eq!(
        actor
            .read_binary(
                WORKSPACE.to_owned(),
                "main".to_owned(),
                "branch-new.bin".to_owned(),
            )
            .await
            .expect("read active capture")
            .expect("captured active head")
            .bytes,
        BYTES
    );
    supervisor.close(&db).expect("close actor");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn rollback_rename_namespaces_around_retained_normal_rename_jobs() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 1).expect("open actor").actor;

    actor
        .versioned_binary_write(
            binary_write("target-old.bin", "target-seed"),
            scratch.path().to_path_buf(),
            Arc::new(NoRecorder),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("target seed");
    actor
        .versioned_text_rename(
            RenameTextFile {
                workspace_id: WORKSPACE.to_owned(),
                version_id: "main".to_owned(),
                from_path: "target-old.bin".to_owned(),
                to_path: "target-new.bin".to_owned(),
                moment_id: "target".to_owned(),
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
        .expect("target rename");
    actor
        .versioned_binary_write(
            binary_write("unrelated-old.bin", "unrelated-seed"),
            scratch.path().to_path_buf(),
            Arc::new(NoRecorder),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("unrelated seed");
    actor
        .versioned_text_rename(
            RenameTextFile {
                workspace_id: WORKSPACE.to_owned(),
                version_id: "main".to_owned(),
                from_path: "unrelated-old.bin".to_owned(),
                to_path: "unrelated-new.bin".to_owned(),
                moment_id: "rollback-restore_target".to_owned(),
                request_id: None,
                metadata_origin: "api".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 30,
            },
            scratch.path().to_path_buf(),
            Arc::new(NoRecorder),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("colliding normal rename");

    let connection = rusqlite::Connection::open(&db).expect("read retained rows");
    let retained_before: Vec<(String, String, String, i64)> = {
        let mut statement = connection
            .prepare(
                "SELECT job_id, status, target_path, target_generation \
                 FROM materialization_jobs \
                 WHERE job_id IN ( \
                     'binary-rename-0-write-mat_rollback-restore_target', \
                     'binary-rename-1-delete-mat_rollback-restore_target') \
                 ORDER BY job_id",
            )
            .expect("prepare retained rows");
        statement
            .query_map([], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
            })
            .expect("query retained rows")
            .collect::<Result<_, _>>()
            .expect("collect retained rows")
    };
    assert_eq!(retained_before.len(), 2);
    drop(connection);

    let result = actor
        .versioned_text_rollback(
            rollback("main", "target-new.bin", "target"),
            scratch.path().to_path_buf(),
            Arc::new(NoRecorder),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("rollback despite retained job-id collision");
    assert!(result.materialized);
    assert_eq!(
        std::fs::read(scratch.path().join("target-old.bin")).expect("restored target"),
        BYTES
    );
    assert!(!scratch.path().join("target-new.bin").exists());
    assert_eq!(
        std::fs::read(scratch.path().join("unrelated-new.bin")).expect("unrelated rename"),
        BYTES
    );
    assert!(!scratch.path().join("unrelated-old.bin").exists());

    let connection = rusqlite::Connection::open(&db).expect("verify retained rows");
    let retained_after: Vec<(String, String, String, i64)> = {
        let mut statement = connection
            .prepare(
                "SELECT job_id, status, target_path, target_generation \
                 FROM materialization_jobs \
                 WHERE job_id IN ( \
                     'binary-rename-0-write-mat_rollback-restore_target', \
                     'binary-rename-1-delete-mat_rollback-restore_target') \
                 ORDER BY job_id",
            )
            .expect("prepare retained rows after rollback");
        statement
            .query_map([], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
            })
            .expect("query retained rows after rollback")
            .collect::<Result<_, _>>()
            .expect("collect retained rows after rollback")
    };
    assert_eq!(retained_after, retained_before);
    let rollback_identity = binary_rollback_job_identity(WORKSPACE, "main", "target");
    let rollback_write_id = binary_rename_write_job_id(&rollback_identity);
    let rollback_delete_id = binary_rename_delete_job_id(&rollback_identity);
    let namespaced_rows: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM materialization_jobs \
             WHERE job_id IN (?1, ?2) \
               AND status = 'complete'",
            rusqlite::params![rollback_write_id, rollback_delete_id],
            |row| row.get(0),
        )
        .expect("namespaced rollback rows");
    assert_eq!(namespaced_rows, 2);
    drop(connection);
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
async fn inactive_delete_rollback_drains_when_version_becomes_active() {
    // MUTATION: remove the activation-time rollback restore replay -> the
    // switch projection may put the bytes on disk, but the durable restore
    // remains pending instead of being consumed by its newly-active version.
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
                self_writes: Arc::new(NoRecorder),
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
async fn superseded_inactive_restore_is_drained_after_switch_projection() {
    // MUTATION: count the selected restore's post-projection Superseded outcome
    // as failed -> the already-committed switch returns incomplete.
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
                new_version_id: "active-newer".to_owned(),
                name: "Active newer".to_owned(),
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
            binary_write("switch-back.bin", "switch-back-seed"),
            scratch.path().to_path_buf(),
            Arc::new(NoRecorder),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("main binary");
    actor
        .versioned_text_delete(
            delete("switch-back.bin", "switch-back-delete"),
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
                version_id: "active-newer".to_owned(),
                root_dir: scratch.path().to_path_buf(),
                self_writes: Arc::new(NoRecorder),
                now_ms: 30,
            },
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("activate branch");

    actor
        .versioned_text_rollback(
            rollback("main", "switch-back.bin", "switch-back-delete"),
            scratch.path().to_path_buf(),
            Arc::new(NoRecorder),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("inactive rollback");
    actor
        .versioned_binary_write(
            binary_write_for(
                "active-newer",
                "switch-back.bin",
                "active-newer-write",
                OTHER_LINEAGE_BYTES,
            ),
            scratch.path().to_path_buf(),
            Arc::new(NoRecorder),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("newer active materialization");

    actor
        .set_active_version(
            ActiveVersionSwitch {
                workspace_id: WORKSPACE.to_owned(),
                version_id: "main".to_owned(),
                root_dir: scratch.path().to_path_buf(),
                self_writes: Arc::new(NoRecorder),
                now_ms: 40,
            },
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("switch back after projection");
    assert_eq!(
        std::fs::read(scratch.path().join("switch-back.bin")).expect("projected main bytes"),
        BYTES
    );
    let connection = rusqlite::Connection::open(&db).expect("read restore status");
    let restore_job_id = binary_rollback_job_identity(WORKSPACE, "main", "switch-back-delete");
    let status: String = connection
        .query_row(
            "SELECT status FROM materialization_jobs WHERE job_id = ?1",
            [restore_job_id],
            |row| row.get(0),
        )
        .expect("restore job");
    assert_eq!(status, "complete");
    drop(connection);
    supervisor.close(&db).expect("close actor");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn post_commit_active_version_lookup_failure_returns_committed_rollback() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 1).expect("open actor").actor;
    actor
        .versioned_binary_write(
            binary_write("lookup.bin", "lookup-mutation"),
            scratch.path().to_path_buf(),
            Arc::new(NoRecorder),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("binary mutation");

    let faults = ScriptedFaults::crash_at(FaultPoint::RollbackBeforeActiveVersionLookup);
    let result = actor
        .versioned_text_rollback(
            rollback("main", "lookup.bin", "lookup-mutation"),
            scratch.path().to_path_buf(),
            Arc::new(NoRecorder),
            faults.clone(),
            CancellationToken::new(),
        )
        .await
        .expect("committed rollback must still be acknowledged");
    assert!(faults.fired());
    assert!(result.materialize_enqueued);
    assert!(!result.materialized);
    assert_eq!(
        result.materialize_outcome,
        PostCommitMaterializeOutcome::Error
    );
    assert!(
        actor
            .read_binary(
                WORKSPACE.to_owned(),
                "main".to_owned(),
                "lookup.bin".to_owned(),
            )
            .await
            .expect("read committed rollback")
            .is_none(),
        "the response describes a rollback that is already durable"
    );

    let connection = rusqlite::Connection::open(&db).expect("read pending restore");
    let restore_job_id = binary_rollback_job_identity(WORKSPACE, "main", "lookup-mutation");
    let status: String = connection
        .query_row(
            "SELECT status FROM materialization_jobs WHERE job_id = ?1",
            [restore_job_id],
            |row| row.get(0),
        )
        .expect("durable restore job");
    assert_eq!(status, "pending");
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
    let db = database.engine_db_path().expect("db");
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
            Arc::new(NoRecorder),
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
                legacy_before_text: None,
                metadata_origin: "restore".to_owned(),
                author_json: None,
            },
            root_a.path().to_path_buf(),
            Arc::new(NoRecorder),
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
            Arc::new(NoRecorder),
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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ordinary_rollback_prefixed_write_is_superseded_normally() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 1).expect("open actor").actor;
    let spoofed_moment_id = "rollback-restore_ordinary-write";
    let faults = ScriptedFaults::crash_at(FaultPoint::MaterializeAfterJobCommit);

    let first = actor
        .versioned_binary_write(
            binary_write("spoof.bin", spoofed_moment_id),
            scratch.path().to_path_buf(),
            Arc::new(NoRecorder),
            faults.clone(),
            CancellationToken::new(),
        )
        .await
        .expect("committed spoof-prefixed write");
    assert_eq!(
        first.materialize_outcome,
        PostCommitMaterializeOutcome::Error
    );
    assert!(faults.fired());
    std::fs::write(scratch.path().join("spoof.bin"), BYTES).expect("first bytes on disk");

    actor
        .versioned_binary_write(
            binary_write_for("main", "spoof.bin", "newer-write", UPDATED_BYTES),
            scratch.path().to_path_buf(),
            Arc::new(NoRecorder),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("newer write");
    assert_eq!(
        std::fs::read(scratch.path().join("spoof.bin")).expect("newer disk bytes"),
        UPDATED_BYTES
    );

    assert_eq!(
        actor
            .materialize_replay_pending(scratch.path().to_path_buf(), WORKSPACE.to_owned(), 30)
            .await
            .expect("replay ordinary pending job"),
        0,
        "the stale ordinary write is superseded without touching disk"
    );
    let connection = rusqlite::Connection::open(&db).expect("read ordinary job");
    let status: String = connection
        .query_row(
            "SELECT status FROM materialization_jobs WHERE job_id = ?1",
            [spoofed_moment_id],
            |row| row.get(0),
        )
        .expect("spoof-prefixed ordinary job");
    assert_eq!(status, "complete");
    assert_eq!(
        std::fs::read(scratch.path().join("spoof.bin")).expect("newer bytes remain"),
        UPDATED_BYTES
    );
    drop(connection);
    supervisor.close(&db).expect("close actor");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn inactive_rollback_write_does_not_hide_active_capture_retire() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 1).expect("open actor").actor;
    std::fs::write(scratch.path().join("captured.bin"), BYTES).expect("capture disk seed");
    actor
        .capture_ingest_binary(
            CaptureIngestBinary {
                workspace_id: WORKSPACE.to_owned(),
                version_id: "main".to_owned(),
                path: "captured.bin".to_owned(),
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
        .expect("capture main file");
    actor
        .create_named_version(
            CreateNamedVersion {
                workspace_id: WORKSPACE.to_owned(),
                new_version_id: "inactive".to_owned(),
                name: "Inactive".to_owned(),
                from_version_id: "main".to_owned(),
                now_ms: 11,
                request_id: None,
            },
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("fork inactive version");
    actor
        .set_active_version(
            ActiveVersionSwitch {
                workspace_id: WORKSPACE.to_owned(),
                version_id: "inactive".to_owned(),
                root_dir: scratch.path().to_path_buf(),
                self_writes: Arc::new(NoRecorder),
                now_ms: 12,
            },
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("activate inactive version");
    actor
        .versioned_text_delete(
            DeleteTextFile {
                workspace_id: WORKSPACE.to_owned(),
                version_id: "inactive".to_owned(),
                path: "captured.bin".to_owned(),
                moment_id: "inactive-delete".to_owned(),
                request_id: None,
                metadata_origin: "api".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 13,
            },
            scratch.path().to_path_buf(),
            Arc::new(NoRecorder),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("delete on inactive version");
    actor
        .set_active_version(
            ActiveVersionSwitch {
                workspace_id: WORKSPACE.to_owned(),
                version_id: "main".to_owned(),
                root_dir: scratch.path().to_path_buf(),
                self_writes: Arc::new(NoRecorder),
                now_ms: 14,
            },
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("reactivate main");
    let rollback = actor
        .versioned_text_rollback(
            rollback("inactive", "captured.bin", "inactive-delete"),
            scratch.path().to_path_buf(),
            Arc::new(NoRecorder),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("rollback inactive delete");
    assert_eq!(
        rollback.materialize_outcome,
        PostCommitMaterializeOutcome::Skipped
    );

    std::fs::remove_file(scratch.path().join("captured.bin")).expect("user deletes main file");
    let seed = actor
        .capture_manifest_seed(WORKSPACE.to_owned(), "main".to_owned())
        .await
        .expect("main capture seed");
    assert!(
        seed.iter().any(|entry| entry.path == "captured.bin"),
        "the inactive version's pending write must not exclude the active capture alias"
    );
    let manifest = ScanManifest::from_entries(seed.into_iter().map(|entry| {
        (
            entry.path,
            ManifestEntry {
                size: entry.size,
                sha256: entry.sha256,
            },
        )
    }));
    let mut capture = ReconcileController::rehydrated(manifest, ScanGeneration::default());
    let scanner = Scanner::new(ScanBounds::default()).expect("scanner");
    let plan = match capture
        .reconcile(&scanner, scratch.path(), &CancellationToken::new())
        .expect("scan deleted active file")
    {
        ReconcileRun::Completed(plan) => plan,
        other => panic!("unexpected capture run: {other:?}"),
    };
    assert!(
        plan.ops
            .iter()
            .any(|op| matches!(op, CaptureOp::Retire { path } if path == "captured.bin"))
    );
    supervisor.close(&db).expect("close actor");
}
