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
use dohc_engine_storage::{EngineStore, FaultAction, FaultInjector, FaultPoint};
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

#[derive(Default)]
struct CountingRecorder {
    records: AtomicUsize,
    retracts: AtomicUsize,
}

impl SelfWriteRecorder for CountingRecorder {
    fn record(&self, _workspace_id: &str, _path: &str, _sha256: &str) {
        self.records.fetch_add(1, Ordering::AcqRel);
    }

    fn retract(&self, _workspace_id: &str, _path: &str, _sha256: &str) {
        self.retracts.fetch_add(1, Ordering::AcqRel);
    }
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
async fn rollback_restore_generation_fence_is_scoped_to_its_workspace() {
    const WORKSPACE_A: &str = "ws-generation-a";
    const WORKSPACE_B: &str = "ws-generation-b";

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
            Arc::new(NoRecorder),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("workspace A seed");
    actor
        .versioned_binary_write(
            write(WORKSPACE_A, "a-mutation", UPDATED_BYTES, 20),
            root_a.path().to_path_buf(),
            Arc::new(NoRecorder),
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
        std::fs::read(root_a.path().join("shared.bin")).expect("pending A restore"),
        UPDATED_BYTES
    );

    actor
        .versioned_binary_write(
            write(WORKSPACE_B, "b-higher-generation", OTHER_LINEAGE_BYTES, 30),
            root_b.path().to_path_buf(),
            Arc::new(NoRecorder),
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
             WHERE restore.job_id = ?1 AND other.job_id = 'b-higher-generation'",
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
async fn deduped_rename_rollback_reports_a_cancelled_paired_delete_as_conflict() {
    // The first call commits both jobs but leaves them pending. The SQL update
    // isolates the post-commit race: the write remains retryable while another
    // disk action terminalizes its paired delete before the replay reloads it.
    // MUTATION: map the paired delete's Cancelled status to Skipped in
    // `versioned_text_rollback_on_store`; the replay reports Skipped.
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 1).expect("open actor").actor;

    actor
        .versioned_binary_write(
            binary_write("cancelled-old.bin", "cancelled-rename-seed"),
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
                from_path: "cancelled-old.bin".to_owned(),
                to_path: "cancelled-new.bin".to_owned(),
                moment_id: "cancelled-rename".to_owned(),
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

    let mut rollback_input = rollback("main", "cancelled-new.bin", "cancelled-rename");
    rollback_input.request_id = Some("cancelled-rename-rollback-request".to_owned());
    let faults = ScriptedFaults::crash_at(FaultPoint::MaterializeAfterJobCommit);
    let first = actor
        .versioned_text_rollback(
            rollback_input.clone(),
            scratch.path().to_path_buf(),
            Arc::new(NoRecorder),
            faults.clone(),
            CancellationToken::new(),
        )
        .await
        .expect("committed rollback");
    assert_eq!(
        first.materialize_outcome,
        PostCommitMaterializeOutcome::Error
    );
    assert!(faults.fired());

    let rollback_identity = binary_rollback_job_identity(WORKSPACE, "main", "cancelled-rename");
    let write_job_id = binary_rename_write_job_id(&rollback_identity);
    let delete_job_id = binary_rename_delete_job_id(&rollback_identity);
    let connection = rusqlite::Connection::open(&db).expect("open job ledger");
    connection
        .execute(
            "UPDATE materialization_jobs SET status='cancelled', completed_at_ms=30 \
             WHERE job_id=?1",
            [&delete_job_id],
        )
        .expect("cancel paired delete");
    let statuses: (String, String) = connection
        .query_row(
            "SELECT write.status, delete_job.status \
             FROM materialization_jobs write, materialization_jobs delete_job \
             WHERE write.job_id=?1 AND delete_job.job_id=?2",
            rusqlite::params![write_job_id, delete_job_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("paired statuses");
    assert_eq!(statuses, ("pending".to_owned(), "cancelled".to_owned()));
    drop(connection);

    let replay = actor
        .versioned_text_rollback(
            rollback_input,
            scratch.path().to_path_buf(),
            Arc::new(NoRecorder),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("deduped rollback replay");
    assert!(replay.deduped);
    assert!(!replay.materialized);
    assert_eq!(
        replay.materialize_outcome,
        PostCommitMaterializeOutcome::Conflict
    );

    // The deduped replay drains the still-pending write job to completion
    // even though the outcome reports Conflict; the already-terminal delete
    // stays cancelled. This proves the post-replay ledger state instead of
    // only the pre-replay setup above.
    let connection = rusqlite::Connection::open(&db).expect("reopen job ledger");
    let statuses_after_replay: (String, String) = connection
        .query_row(
            "SELECT write.status, delete_job.status \
             FROM materialization_jobs write, materialization_jobs delete_job \
             WHERE write.job_id=?1 AND delete_job.job_id=?2",
            rusqlite::params![write_job_id, delete_job_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("paired statuses after replay");
    assert_eq!(
        statuses_after_replay,
        ("complete".to_owned(), "cancelled".to_owned())
    );
    drop(connection);

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
                mtime_ms: 0,
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
async fn conflicted_rename_rollback_terminates_delete_and_capture_sees_survivor() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 1).expect("open actor").actor;

    actor
        .versioned_binary_write(
            binary_write("conflict-old.bin", "conflict-rename-seed"),
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
            Arc::new(NoRecorder),
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
            Arc::new(NoRecorder),
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
                mtime_ms: 0,
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
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 10,
                request_id: None,
                claim_foreign_head: false,
            },
            dohc_engine_collab::LeaseRegistry::new(),
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
                        metadata_summary: None,
                        metadata_correlation_id: None,
                        now_ms: 41,
                        request_id: None,
                        only_if_text_head: false,
                        only_if_capture_origin: true,
                        allow_ydoc_origin: true,
                    },
                    dohc_engine_collab::LeaseRegistry::new(),
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
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 10,
                request_id: None,
                claim_foreign_head: false,
            },
            dohc_engine_collab::LeaseRegistry::new(),
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
                mtime_ms: 0,
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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn migrated_opaque_jobs_replay_and_legacy_completed_jobs_keep_fencing() {
    const WORKSPACE_A: &str = "legacy-workspace-a";
    const WORKSPACE_B: &str = "legacy-workspace-b";
    const OPAQUE_PENDING_JOB: &str =
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const OPAQUE_COMPLETED_JOB: &str =
        "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";
    const LEGACY_PROJECTION: &[u8] = b"# migrated settle projection\n";

    let database = ScratchDir::new().expect("database scratch");
    let replay_root = ScratchDir::new().expect("replay root");
    let db = database.engine_db_path().expect("db");

    let store = EngineStore::open(&db, 1).expect("create current store");
    let content_sha = store
        .put_binary_blob(LEGACY_PROJECTION)
        .expect("stage legacy projection");
    drop(store);

    // Rewind only ordinal 24's additive schema to construct the exact shipped
    // pre-migration shape, then seed two workspaces and settle-shaped opaque
    // job ids that none of the coordinate backfills can decode.
    let connection = rusqlite::Connection::open(&db).expect("open legacy fixture");
    connection
        .execute_batch(
            "INSERT INTO versioned_workspaces (workspace_id, main_version_id) \
                 VALUES ('legacy-workspace-a', 'main'), ('legacy-workspace-b', 'main');
             INSERT INTO versions (workspace_id, version_id, kind, name, created_at_ms) \
                 VALUES ('legacy-workspace-a', 'main', 'main', 'Main', 1),
                        ('legacy-workspace-b', 'main', 'main', 'Main', 1);
             DROP INDEX idx_materialization_jobs_workspace_path_status_generation;
             DELETE FROM engine_migrations WHERE ordinal = 24;
             ALTER TABLE materialization_jobs DROP COLUMN workspace_id;",
        )
        .expect("rewind workspace-coordinate migration");
    connection
        .execute(
            "INSERT INTO materialization_jobs \
             (job_id, target_path, content_sha256, preimage_present, preimage_sha256, \
              target_generation, status, created_at_ms, completed_at_ms, operation) \
             VALUES (?1, 'legacy-settle.md', ?2, 0, NULL, 7, 'pending', 10, NULL, 'write')",
            rusqlite::params![OPAQUE_PENDING_JOB, content_sha],
        )
        .expect("pending opaque settle job");
    connection
        .execute(
            "INSERT INTO materialization_jobs \
             (job_id, target_path, content_sha256, preimage_present, preimage_sha256, \
              target_generation, status, created_at_ms, completed_at_ms, operation) \
             VALUES (?1, 'fenced.bin', ?2, 0, NULL, 41, 'complete', 11, 12, 'write')",
            rusqlite::params![OPAQUE_COMPLETED_JOB, content_sha],
        )
        .expect("completed opaque fence job");
    drop(connection);

    let migrated = EngineStore::open(&db, 20).expect("upgrade legacy store");
    for job_id in [OPAQUE_PENDING_JOB, OPAQUE_COMPLETED_JOB] {
        let workspace_id: String = migrated
            .read_with(|connection| {
                connection.query_row(
                    "SELECT workspace_id FROM materialization_jobs WHERE job_id = ?1",
                    [job_id],
                    |row| row.get(0),
                )
            })
            .expect("read migrated workspace sentinel");
        assert_eq!(
            workspace_id, "",
            "opaque jobs must retain the legacy wildcard sentinel"
        );
    }
    for workspace_id in [WORKSPACE_A, WORKSPACE_B] {
        assert_eq!(
            migrated
                .max_completed_generation_for_path(workspace_id, "fenced.bin")
                .expect("legacy completed fence"),
            Some(41),
            "a pre-coordinate completed job keeps its old global fence semantics"
        );
    }
    drop(migrated);

    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 30).expect("open migrated actor").actor;
    assert_eq!(
        actor
            .materialize_replay_pending(
                replay_root.path().to_path_buf(),
                WORKSPACE_B.to_owned(),
                31,
            )
            .await
            .expect("replay legacy opaque job"),
        1
    );
    assert_eq!(
        std::fs::read(replay_root.path().join("legacy-settle.md"))
            .expect("materialized legacy settle projection"),
        LEGACY_PROJECTION
    );
    let connection = rusqlite::Connection::open(&db).expect("read replay status");
    let status: String = connection
        .query_row(
            "SELECT status FROM materialization_jobs WHERE job_id = ?1",
            [OPAQUE_PENDING_JOB],
            |row| row.get(0),
        )
        .expect("opaque replay status");
    assert_eq!(status, "complete");
    drop(connection);
    supervisor.close(&db).expect("close actor");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn migration_backfill_binds_ambiguous_moment_ids_by_generation() {
    // MUTATION: drop the target_generation = moment_order condition from the
    // ordinal-24 backfill and this job is assigned to workspace B purely
    // because B's reuse of the moment id is newer.
    const WORKSPACE_A: &str = "ambiguous-workspace-a";
    const WORKSPACE_B: &str = "ambiguous-workspace-b";
    const SHARED_MOMENT: &str = "shared-moment-id";
    const CONTENT: &[u8] = b"generation-bound backfill\n";

    let database = ScratchDir::new().expect("database scratch");
    let db = database.engine_db_path().expect("db");
    let store = EngineStore::open(&db, 1).expect("create current store");
    let content_sha = store.put_binary_blob(CONTENT).expect("stage content");
    drop(store);

    let connection = rusqlite::Connection::open(&db).expect("open legacy fixture");
    connection
        .execute_batch(
            "INSERT INTO versioned_workspaces (workspace_id, main_version_id) \
                 VALUES ('ambiguous-workspace-a', 'main'), ('ambiguous-workspace-b', 'main');
             INSERT INTO versions (workspace_id, version_id, kind, name, created_at_ms) \
                 VALUES ('ambiguous-workspace-a', 'main', 'main', 'Main', 1),
                        ('ambiguous-workspace-b', 'main', 'main', 'Main', 1);
             INSERT INTO file_objects (workspace_id, object_id, created_at_ms) \
                 VALUES ('ambiguous-workspace-a', 'object-a', 1),
                        ('ambiguous-workspace-b', 'object-b', 1);
             INSERT INTO blobs (sha256, byte_length, text) \
                 VALUES ('moment-text-sha', 4, 'text');
             DROP INDEX idx_materialization_jobs_workspace_path_status_generation;
             DELETE FROM engine_migrations WHERE ordinal = 24;
             ALTER TABLE materialization_jobs DROP COLUMN workspace_id;",
        )
        .expect("rewind workspace-coordinate migration");
    for (workspace, object, order) in [
        (WORKSPACE_A, "object-a", 7_i64),
        (WORKSPACE_B, "object-b", 99_i64),
    ] {
        connection
            .execute(
                "INSERT INTO moments \
                 (workspace_id, moment_order, moment_id, version_id, object_id, path, \
                  recorded_at_ms, operation, after_blob_sha256, before_present, \
                  metadata_origin) \
                 VALUES (?1, ?2, ?3, 'main', ?4, 'shared.bin', 2, 'write', ?5, 0, 'api')",
                rusqlite::params![workspace, order, SHARED_MOMENT, object, "moment-text-sha"],
            )
            .expect("seed reused moment id");
    }
    // An ordinary binary write's job id IS its moment id; generation 7 makes
    // workspace A the only correct owner even though B's moment is newer.
    connection
        .execute(
            "INSERT INTO materialization_jobs \
             (job_id, target_path, content_sha256, preimage_present, preimage_sha256, \
              target_generation, status, created_at_ms, completed_at_ms, operation) \
             VALUES (?1, 'shared.bin', ?2, 0, NULL, 7, 'pending', 10, NULL, 'write')",
            rusqlite::params![SHARED_MOMENT, content_sha],
        )
        .expect("legacy job with ambiguous moment id");
    drop(connection);

    let migrated = EngineStore::open(&db, 20).expect("upgrade legacy store");
    let workspace_id: String = migrated
        .read_with(|connection| {
            connection.query_row(
                "SELECT workspace_id FROM materialization_jobs WHERE job_id = ?1",
                [SHARED_MOMENT],
                |row| row.get(0),
            )
        })
        .expect("backfilled workspace");
    assert_eq!(
        workspace_id, WORKSPACE_A,
        "the backfill must bind by matching generation, not by newest moment"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn legacy_global_pending_job_is_fenced_by_newer_scoped_completion() {
    const LEGACY_JOB: &str = "opaque-global-pending";
    const SCOPED_JOB: &str = "newer-scoped-complete";
    const PATH: &str = "global-fence.bin";

    let database = ScratchDir::new().expect("database scratch");
    let root = ScratchDir::new().expect("workspace root");
    let db = database.engine_db_path().expect("db");
    let store = EngineStore::open(&db, 1).expect("open store");
    let old_sha = store.put_binary_blob(BYTES).expect("stage old bytes");
    let new_sha = store
        .put_binary_blob(UPDATED_BYTES)
        .expect("stage current bytes");
    drop(store);

    let connection = rusqlite::Connection::open(&db).expect("open job ledger");
    connection
        .execute(
            "INSERT INTO materialization_jobs \
             (job_id, workspace_id, target_path, content_sha256, preimage_present, \
              preimage_sha256, target_generation, status, created_at_ms, \
              completed_at_ms, operation) \
             VALUES (?1, '', ?2, ?3, 1, ?4, 7, 'pending', 10, NULL, 'write')",
            rusqlite::params![LEGACY_JOB, PATH, old_sha, new_sha],
        )
        .expect("legacy global pending job");
    connection
        .execute(
            "INSERT INTO materialization_jobs \
             (job_id, workspace_id, target_path, content_sha256, preimage_present, \
              preimage_sha256, target_generation, status, created_at_ms, \
              completed_at_ms, operation) \
             VALUES (?1, ?2, ?3, ?4, 0, NULL, 8, 'complete', 11, 12, 'write')",
            rusqlite::params![SCOPED_JOB, WORKSPACE, PATH, new_sha],
        )
        .expect("newer scoped completion");
    drop(connection);
    std::fs::write(root.path().join(PATH), UPDATED_BYTES).expect("newer disk projection");

    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 20).expect("open actor").actor;
    actor
        .materialize_replay_pending(root.path().to_path_buf(), WORKSPACE.to_owned(), 21)
        .await
        .expect("replay global job");
    assert_eq!(
        std::fs::read(root.path().join(PATH)).expect("read fenced projection"),
        UPDATED_BYTES,
        "the older global job must not replay over a newer scoped completion"
    );
    let connection = rusqlite::Connection::open(&db).expect("read terminal status");
    let status: String = connection
        .query_row(
            "SELECT status FROM materialization_jobs WHERE job_id = ?1",
            [LEGACY_JOB],
            |row| row.get(0),
        )
        .expect("legacy job status");
    assert_eq!(status, "complete", "the global job must be superseded");
    drop(connection);
    supervisor.close(&db).expect("close actor");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn migration_backfill_keeps_secret_job_with_colliding_secret_moment() {
    const ORDINARY_WORKSPACE: &str = "ordinary-collision-workspace";
    const SECRET_WORKSPACE: &str = "secret-collision-workspace";
    const SHARED_MOMENT: &str = "shared-secret-id";
    const BARE_SECRET_MOMENT: &str = "bare-secret-id";
    const BARE_SECRET_JOB: &str = "secret-mat_bare-secret-id";

    let database = ScratchDir::new().expect("database scratch");
    let db = database.engine_db_path().expect("db");
    let store = EngineStore::open(&db, 1).expect("create current store");
    let content_sha = store
        .put_binary_blob(b"ciphertext placeholder")
        .expect("stage materialization content");
    drop(store);

    let connection = rusqlite::Connection::open(&db).expect("open legacy fixture");
    connection
        .execute_batch(
            "INSERT INTO versioned_workspaces (workspace_id, main_version_id) \
                 VALUES ('ordinary-collision-workspace', 'main'), \
                        ('secret-collision-workspace', 'main');
             INSERT INTO versions (workspace_id, version_id, kind, name, created_at_ms) \
                 VALUES ('ordinary-collision-workspace', 'main', 'main', 'Main', 1), \
                        ('secret-collision-workspace', 'main', 'main', 'Main', 1);
             INSERT INTO file_objects (workspace_id, object_id, created_at_ms) \
                 VALUES ('ordinary-collision-workspace', 'ordinary-object', 1), \
                        ('ordinary-collision-workspace', 'bare-ordinary-object', 1);
             INSERT INTO blobs (sha256, byte_length, text) \
                 VALUES ('ordinary-text-sha', 4, 'text');
             DROP INDEX idx_materialization_jobs_workspace_path_status_generation;
             DELETE FROM engine_migrations WHERE ordinal = 24;
             ALTER TABLE materialization_jobs DROP COLUMN workspace_id;",
        )
        .expect("rewind workspace-coordinate migration");
    connection
        .execute(
            "INSERT INTO moments \
             (workspace_id, moment_order, moment_id, version_id, object_id, path, \
              recorded_at_ms, operation, after_blob_sha256, before_present, metadata_origin) \
             VALUES (?1, 7, ?2, 'main', 'ordinary-object', 'ordinary.md', 2, \
                     'write', 'ordinary-text-sha', 0, 'api')",
            rusqlite::params![ORDINARY_WORKSPACE, SHARED_MOMENT],
        )
        .expect("ordinary collision moment");
    connection
        .execute(
            "INSERT INTO moments \
             (workspace_id, moment_order, moment_id, version_id, object_id, path, \
              recorded_at_ms, operation, after_blob_sha256, before_present, metadata_origin) \
             VALUES (?1, 8, ?2, 'main', 'bare-ordinary-object', 'bare-ordinary.md', 3, \
                     'write', 'ordinary-text-sha', 0, 'api')",
            rusqlite::params![ORDINARY_WORKSPACE, BARE_SECRET_JOB],
        )
        .expect("bare ordinary identity collision moment");
    connection
        .execute(
            "INSERT INTO secret_moments \
             (workspace_id, moment_order, moment_id, version_id, path, recorded_at_ms, \
              operation, metadata_origin, after_present) \
             VALUES (?1, 7, ?2, 'main', '.env', 2, 'write', 'api', 1)",
            rusqlite::params![SECRET_WORKSPACE, SHARED_MOMENT],
        )
        .expect("secret collision moment");
    connection
        .execute(
            "INSERT INTO secret_moments \
             (workspace_id, moment_order, moment_id, version_id, path, recorded_at_ms, \
              operation, metadata_origin, after_present) \
             VALUES (?1, 8, ?2, 'main', '.bare-env', 3, 'write', 'api', 1)",
            rusqlite::params![SECRET_WORKSPACE, BARE_SECRET_MOMENT],
        )
        .expect("bare secret collision moment");
    connection
        .execute(
            "INSERT INTO materialization_jobs \
             (job_id, target_path, content_sha256, preimage_present, preimage_sha256, \
              target_generation, status, created_at_ms, completed_at_ms, operation) \
             VALUES (?1, '.env', ?2, 0, NULL, 7, 'pending', 10, NULL, 'write')",
            rusqlite::params![format!("secret-mat_{SHARED_MOMENT}"), content_sha],
        )
        .expect("legacy secret job");
    connection
        .execute(
            "INSERT INTO materialization_jobs \
             (job_id, target_path, content_sha256, preimage_present, preimage_sha256, \
              target_generation, status, created_at_ms, completed_at_ms, operation) \
             VALUES (?1, '.bare-env', ?2, 0, NULL, 8, 'pending', 11, NULL, 'write')",
            rusqlite::params![BARE_SECRET_JOB, content_sha],
        )
        .expect("legacy bare-equality secret job");
    drop(connection);

    let migrated = EngineStore::open(&db, 20).expect("upgrade legacy store");
    for (job_id, collision_kind) in [
        (format!("secret-mat_{SHARED_MOMENT}"), "ordinary suffix"),
        (BARE_SECRET_JOB.to_owned(), "bare ordinary equality"),
    ] {
        let workspace_id: String = migrated
            .read_with(|connection| {
                connection.query_row(
                    "SELECT workspace_id FROM materialization_jobs WHERE job_id = ?1",
                    [&job_id],
                    |row| row.get(0),
                )
            })
            .expect("backfilled secret workspace");
        assert_eq!(
            workspace_id, SECRET_WORKSPACE,
            "a secret job must not be captured by the {collision_kind} backfill"
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn inactive_delete_rollback_reprojects_the_still_active_version() {
    const BRANCH: &str = "inactive-delete-branch";
    const PATH: &str = "inactive-shared.bin";

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
        .versioned_binary_write(
            binary_write_for("main", PATH, "active-seed", BYTES),
            scratch.path().to_path_buf(),
            Arc::new(NoRecorder),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("active seed");
    actor
        .create_named_version(
            CreateNamedVersion {
                workspace_id: WORKSPACE.to_owned(),
                new_version_id: BRANCH.to_owned(),
                name: "Inactive delete branch".to_owned(),
                from_version_id: "main".to_owned(),
                now_ms: 11,
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
                version_id: BRANCH.to_owned(),
                root_dir: scratch.path().to_path_buf(),
                self_writes: Arc::new(NoRecorder),
                now_ms: 12,
            },
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("activate branch");
    actor
        .versioned_text_delete(
            DeleteTextFile {
                workspace_id: WORKSPACE.to_owned(),
                version_id: BRANCH.to_owned(),
                path: PATH.to_owned(),
                moment_id: "inactive-delete-mutation".to_owned(),
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
        .expect("branch delete");
    assert!(
        !scratch.path().join(PATH).exists(),
        "the branch mutation must reach the shared disk projection"
    );
    let switch_faults = ScriptedFaults::crash_at(FaultPoint::MaterializeAfterJobCommit);
    actor
        .set_active_version(
            ActiveVersionSwitch {
                workspace_id: WORKSPACE.to_owned(),
                version_id: "main".to_owned(),
                root_dir: scratch.path().to_path_buf(),
                self_writes: Arc::new(NoRecorder),
                now_ms: 21,
            },
            switch_faults.clone(),
            CancellationToken::new(),
        )
        .await
        .expect_err("switch projection is interrupted after the active row commits");
    assert!(switch_faults.fired());

    let rollback_recorder = Arc::new(CountingRecorder::default());
    let rolled_back = actor
        .versioned_text_rollback(
            rollback(BRANCH, PATH, "inactive-delete-mutation"),
            scratch.path().to_path_buf(),
            rollback_recorder.clone(),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("inactive rollback");
    assert!(rolled_back.materialize_enqueued);
    assert_eq!(
        rolled_back.materialize_outcome,
        PostCommitMaterializeOutcome::Skipped
    );
    assert_eq!(
        std::fs::read(scratch.path().join(PATH)).expect("reprojected active file"),
        BYTES,
        "rollback must restore the active version's bytes without activating the branch"
    );
    assert_eq!(
        rollback_recorder.records.load(Ordering::Acquire),
        1,
        "the active-version reprojection must register its self-write suppression"
    );
    assert_eq!(
        rollback_recorder.retracts.load(Ordering::Acquire),
        0,
        "a completed reprojection must leave its suppression available to capture"
    );
    let connection = rusqlite::Connection::open(&db).expect("read active version");
    let active_version_id: String = connection
        .query_row(
            "SELECT version_id FROM active_versions WHERE workspace_id = ?1",
            [WORKSPACE],
            |row| row.get(0),
        )
        .expect("active version");
    assert_eq!(active_version_id, "main");
    drop(connection);
    supervisor.close(&db).expect("close actor");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn inactive_rename_rollback_removes_destination_from_the_active_projection() {
    const BRANCH: &str = "inactive-rename-reconcile";
    const OLD_PATH: &str = "inactive-rename-old.bin";
    const NEW_PATH: &str = "inactive-rename-new.bin";

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
        .versioned_binary_write(
            binary_write_for("main", OLD_PATH, "rename-main-seed", BYTES),
            scratch.path().to_path_buf(),
            Arc::new(NoRecorder),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("main seed");
    actor
        .create_named_version(
            CreateNamedVersion {
                workspace_id: WORKSPACE.to_owned(),
                new_version_id: BRANCH.to_owned(),
                name: "Inactive rename reconcile".to_owned(),
                from_version_id: "main".to_owned(),
                now_ms: 11,
                request_id: None,
            },
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("branch");
    actor
        .versioned_binary_write(
            binary_write_for(
                "main",
                OLD_PATH,
                "rename-main-diverged",
                OTHER_LINEAGE_BYTES,
            ),
            scratch.path().to_path_buf(),
            Arc::new(NoRecorder),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("diverge main");
    actor
        .set_active_version(
            ActiveVersionSwitch {
                workspace_id: WORKSPACE.to_owned(),
                version_id: BRANCH.to_owned(),
                root_dir: scratch.path().to_path_buf(),
                self_writes: Arc::new(NoRecorder),
                now_ms: 12,
            },
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("activate branch");
    actor
        .versioned_text_rename(
            RenameTextFile {
                workspace_id: WORKSPACE.to_owned(),
                version_id: BRANCH.to_owned(),
                from_path: OLD_PATH.to_owned(),
                to_path: NEW_PATH.to_owned(),
                moment_id: "inactive-rename-mutation".to_owned(),
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
        .expect("branch rename");
    assert!(!scratch.path().join(OLD_PATH).exists());
    assert_eq!(
        std::fs::read(scratch.path().join(NEW_PATH)).expect("renamed branch bytes"),
        BYTES
    );

    let switch_faults = ScriptedFaults::crash_at(FaultPoint::MaterializeAfterJobCommit);
    actor
        .set_active_version(
            ActiveVersionSwitch {
                workspace_id: WORKSPACE.to_owned(),
                version_id: "main".to_owned(),
                root_dir: scratch.path().to_path_buf(),
                self_writes: Arc::new(NoRecorder),
                now_ms: 21,
            },
            switch_faults.clone(),
            CancellationToken::new(),
        )
        .await
        .expect_err("interrupt main projection after committing the active row");
    assert!(switch_faults.fired());
    assert!(
        scratch.path().join(NEW_PATH).exists(),
        "the rollback must encounter the stranded rename destination"
    );

    let rolled_back = actor
        .versioned_text_rollback(
            rollback(BRANCH, NEW_PATH, "inactive-rename-mutation"),
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
    assert!(
        !scratch.path().join(NEW_PATH).exists(),
        "the active version does not own the rename destination"
    );
    assert_eq!(
        std::fs::read(scratch.path().join(OLD_PATH)).expect("active divergent bytes"),
        OTHER_LINEAGE_BYTES,
        "reconciling the inactive rollback must preserve the active version's content"
    );
    supervisor.close(&db).expect("close actor");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn inactive_create_rollback_removes_created_path_from_the_active_projection() {
    const BRANCH: &str = "inactive-create-reconcile";
    const PATH: &str = "inactive-created.bin";

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
                new_version_id: BRANCH.to_owned(),
                name: "Inactive create reconcile".to_owned(),
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
                version_id: BRANCH.to_owned(),
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
            binary_write_for(BRANCH, PATH, "inactive-create-mutation", BYTES),
            scratch.path().to_path_buf(),
            Arc::new(NoRecorder),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("create branch file");
    assert_eq!(
        std::fs::read(scratch.path().join(PATH)).expect("created branch bytes"),
        BYTES
    );

    let switch_faults = ScriptedFaults::crash_at(FaultPoint::MaterializeAfterJobCommit);
    actor
        .set_active_version(
            ActiveVersionSwitch {
                workspace_id: WORKSPACE.to_owned(),
                version_id: "main".to_owned(),
                root_dir: scratch.path().to_path_buf(),
                self_writes: Arc::new(NoRecorder),
                now_ms: 10,
            },
            switch_faults.clone(),
            CancellationToken::new(),
        )
        .await
        .expect_err("interrupt main projection after committing the active row");
    assert!(switch_faults.fired());
    assert!(
        scratch.path().join(PATH).exists(),
        "the rollback must encounter the stranded created path"
    );

    let rolled_back = actor
        .versioned_text_rollback(
            rollback(BRANCH, PATH, "inactive-create-mutation"),
            scratch.path().to_path_buf(),
            Arc::new(NoRecorder),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("inactive create rollback");
    assert!(!rolled_back.materialize_enqueued);
    assert_eq!(
        rolled_back.materialize_outcome,
        PostCommitMaterializeOutcome::Skipped
    );
    assert!(
        !scratch.path().join(PATH).exists(),
        "the active version does not own the rolled-back created path"
    );
    supervisor.close(&db).expect("close actor");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn long_rollback_identity_uses_a_bounded_temp_sibling() {
    let workspace_id = format!("workspace-{}", "w".repeat(120));
    let version_id = format!("version-{}", "v".repeat(120));
    let path = "long-identity.bin";
    let mutation_moment_id = "long-identity-mutation";

    let rollback_job_id =
        binary_rollback_job_identity(&workspace_id, &version_id, mutation_moment_id);
    assert!(
        format!(".dohc-write-{rollback_job_id}.tmp").len() > 255,
        "the pre-fix temp component must exceed common filesystem limits"
    );

    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 1).expect("open actor").actor;
    actor
        .ensure_main_version(
            workspace_id.clone(),
            1,
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("main");
    actor
        .create_named_version(
            CreateNamedVersion {
                workspace_id: workspace_id.clone(),
                new_version_id: version_id.clone(),
                name: "Long identity".to_owned(),
                from_version_id: "main".to_owned(),
                now_ms: 2,
                request_id: None,
            },
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("long version");
    actor
        .set_active_version(
            ActiveVersionSwitch {
                workspace_id: workspace_id.clone(),
                version_id: version_id.clone(),
                root_dir: scratch.path().to_path_buf(),
                self_writes: Arc::new(NoRecorder),
                now_ms: 3,
            },
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("activate long version");
    let write = |moment_id: &str, bytes: &[u8], now_ms: i64| WriteBinary {
        workspace_id: workspace_id.clone(),
        version_id: version_id.clone(),
        object_id: "long-identity-object".to_owned(),
        path: path.to_owned(),
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
            write("long-identity-seed", BYTES, 10),
            scratch.path().to_path_buf(),
            Arc::new(NoRecorder),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("seed");
    actor
        .versioned_binary_write(
            write(mutation_moment_id, UPDATED_BYTES, 20),
            scratch.path().to_path_buf(),
            Arc::new(NoRecorder),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("mutation");

    let rolled_back = actor
        .versioned_text_rollback(
            RollbackTextFileMutation {
                workspace_id: workspace_id.clone(),
                version_id: version_id.clone(),
                path: path.to_owned(),
                mutation_moment_id: mutation_moment_id.to_owned(),
                request_id: None,
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
        .expect("rollback with long identity");
    assert!(rolled_back.materialized);
    assert_eq!(
        std::fs::read(scratch.path().join(path)).expect("restored bytes"),
        BYTES
    );

    let conflict_moment_id = "long-identity-conflict-mutation";
    let conflict_job_id =
        binary_rollback_job_identity(&workspace_id, &version_id, conflict_moment_id);
    assert!(
        format!("{path}.{conflict_job_id}.conflict").len() > 255,
        "the unbounded conflict component must exceed common filesystem limits"
    );
    actor
        .versioned_binary_write(
            write(conflict_moment_id, UPDATED_BYTES, 30),
            scratch.path().to_path_buf(),
            Arc::new(NoRecorder),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("conflicting mutation");
    std::fs::write(scratch.path().join(path), OTHER_LINEAGE_BYTES)
        .expect("external conflicting occupant");
    let conflicted = actor
        .versioned_text_rollback(
            RollbackTextFileMutation {
                workspace_id: workspace_id.clone(),
                version_id: version_id.clone(),
                path: path.to_owned(),
                mutation_moment_id: conflict_moment_id.to_owned(),
                request_id: None,
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
        .expect("conflicting rollback with long identity");
    assert_eq!(
        conflicted.materialize_outcome,
        PostCommitMaterializeOutcome::Conflict
    );
    assert_eq!(
        std::fs::read(scratch.path().join(path)).expect("external occupant"),
        OTHER_LINEAGE_BYTES
    );
    let conflict_artifacts: Vec<_> = std::fs::read_dir(scratch.path())
        .expect("list conflict artifacts")
        .map(|entry| entry.expect("conflict directory entry").path())
        .filter(|entry| {
            entry
                .file_name()
                .is_some_and(|name| name.to_string_lossy().ends_with(".conflict"))
        })
        .collect();
    assert_eq!(conflict_artifacts.len(), 1);
    assert!(
        conflict_artifacts[0]
            .file_name()
            .expect("conflict file name")
            .to_string_lossy()
            .len()
            <= 255
    );
    assert_eq!(
        std::fs::read(&conflict_artifacts[0]).expect("preserved rollback content"),
        BYTES
    );
    supervisor.close(&db).expect("close actor");
}
