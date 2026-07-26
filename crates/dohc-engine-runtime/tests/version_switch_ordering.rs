use dohc_engine_crypto::create_key_file;
use dohc_engine_domain::{
    CreateNamedVersion, SecretDelete, SecretDiskIntent, SecretWrite, WriteText,
};
use dohc_engine_runtime::{
    ActiveVersionSwitch, CancellationToken, NoFaults, RuntimeError, SelfWriteRecorder,
    WorkspaceSupervisor,
};
use dohc_engine_storage::{FaultAction, FaultInjector, FaultPoint};
use dohc_engine_testkit::{ScratchDir, ScriptedFaults};
use rusqlite::Connection;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

const WORKSPACE: &str = "ws-switch-ordering";

struct NoRecorder;

impl SelfWriteRecorder for NoRecorder {
    fn record(&self, _workspace_id: &str, _path: &str, _sha256: &str) {}
    fn retract(&self, _workspace_id: &str, _path: &str, _sha256: &str) {}
}

fn write(version_id: &str, text: &str, moment_id: &str, now_ms: i64) -> WriteText {
    write_for(WORKSPACE, version_id, "ordered.md", text, moment_id, now_ms)
}

fn write_for(
    workspace_id: &str,
    version_id: &str,
    path: &str,
    text: &str,
    moment_id: &str,
    now_ms: i64,
) -> WriteText {
    WriteText {
        workspace_id: workspace_id.to_owned(),
        version_id: version_id.to_owned(),
        object_id: format!("switch-object-{workspace_id}-{path}"),
        path: path.to_owned(),
        text: text.to_owned(),
        moment_id: moment_id.to_owned(),
        metadata_origin: "api".to_owned(),
        metadata_summary: None,
        metadata_correlation_id: None,
        author_json: None,
        now_ms,
        request_id: None,
    }
}

struct RewriteAtJobStart {
    target: PathBuf,
    replacement: &'static [u8],
    fired: AtomicBool,
}

impl RewriteAtJobStart {
    fn new(target: PathBuf, replacement: &'static [u8]) -> Self {
        Self {
            target,
            replacement,
            fired: AtomicBool::new(false),
        }
    }
}

impl FaultInjector for RewriteAtJobStart {
    fn poll(&self, point: FaultPoint) -> FaultAction {
        if point == FaultPoint::MaterializeAfterJobCommit
            && !self.fired.swap(true, Ordering::AcqRel)
        {
            std::fs::write(&self.target, self.replacement)
                .expect("inject edit between planning and phase two");
        }
        FaultAction::Continue
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn destination_is_active_when_switch_materialization_fails() {
    // MUTATION: materialize before updating active_versions, or restore the
    // database-only switch, and the error/active-version assertions fail.
    let scratch = ScratchDir::new().expect("scratch");
    let database = scratch.engine_db_path().expect("database");
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&database, 1).expect("actor").actor;
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
        .versioned_text_write(
            write("main", "main", "switch-main", 2),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("main write");
    actor
        .create_named_version(
            CreateNamedVersion {
                workspace_id: WORKSPACE.to_owned(),
                new_version_id: "feature".to_owned(),
                name: "Feature".to_owned(),
                from_version_id: "main".to_owned(),
                now_ms: 3,
                request_id: None,
            },
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("feature");
    actor
        .versioned_text_write(
            write("feature", "feature", "switch-feature", 4),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("feature write");
    std::fs::write(scratch.path().join("ordered.md"), "main").expect("seed disk");
    let faults = ScriptedFaults::crash_at(FaultPoint::MaterializeAfterJobCommit);

    let error = actor
        .set_active_version(
            ActiveVersionSwitch {
                workspace_id: WORKSPACE.to_owned(),
                version_id: "feature".to_owned(),
                root_dir: scratch.path().to_path_buf(),
                self_writes: Arc::new(NoRecorder),
                now_ms: 5,
            },
            faults.clone(),
            CancellationToken::new(),
        )
        .await
        .expect_err("materialization fault must fail the switch");

    assert!(matches!(
        error,
        RuntimeError::ActiveVersionMaterializationIncomplete { failed_jobs: 1 }
    ));
    assert!(faults.fired(), "the materialization seam must be reached");
    assert_eq!(
        actor
            .active_version(WORKSPACE.to_owned())
            .await
            .expect("active version")
            .version_id,
        "feature"
    );
    assert_eq!(
        std::fs::read_to_string(scratch.path().join("ordered.md")).expect("disk"),
        "main"
    );
    supervisor.close(&database).expect("close");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn secret_switch_write_preserves_an_edit_between_planning_and_phase_two() {
    let scratch = ScratchDir::new().expect("scratch");
    let database = scratch.engine_db_path().expect("database");
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&database, 1).expect("actor").actor;
    actor
        .ensure_main_version(
            WORKSPACE.to_owned(),
            1,
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("main");
    let key = create_key_file(scratch.path()).expect("secret key");
    actor
        .write_secret_file(
            SecretWrite {
                workspace_id: WORKSPACE.to_owned(),
                version_id: "main".to_owned(),
                path: ".env".to_owned(),
                text: "MODE=main\n".to_owned(),
                moment_id: "switch-race-main".to_owned(),
                metadata_origin: "api".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                now_ms: 2,
                disk_intent: SecretDiskIntent::AlreadyOnDisk,
            },
            key,
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("main secret");
    std::fs::write(scratch.path().join(".env"), b"MODE=main\n").expect("seed disk");
    actor
        .create_named_version(
            CreateNamedVersion {
                workspace_id: WORKSPACE.to_owned(),
                new_version_id: "feature".to_owned(),
                name: "Feature".to_owned(),
                from_version_id: "main".to_owned(),
                now_ms: 3,
                request_id: None,
            },
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("feature");
    let key = dohc_engine_crypto::load_key_file(scratch.path())
        .expect("load key")
        .expect("key exists");
    actor
        .write_secret_file(
            SecretWrite {
                workspace_id: WORKSPACE.to_owned(),
                version_id: "feature".to_owned(),
                path: ".env".to_owned(),
                text: "MODE=feature\n".to_owned(),
                moment_id: "switch-race-feature".to_owned(),
                metadata_origin: "api".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                now_ms: 4,
                disk_intent: SecretDiskIntent::Materialize,
            },
            key,
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("feature secret");
    let faults = Arc::new(RewriteAtJobStart::new(
        scratch.path().join(".env"),
        b"MODE=external\n",
    ));

    let error = actor
        .set_active_version(
            ActiveVersionSwitch {
                workspace_id: WORKSPACE.to_owned(),
                version_id: "feature".to_owned(),
                root_dir: scratch.path().to_path_buf(),
                self_writes: Arc::new(NoRecorder),
                now_ms: 5,
            },
            faults.clone(),
            CancellationToken::new(),
        )
        .await
        .expect_err("the changed secret preimage must conflict");

    assert!(matches!(
        error,
        RuntimeError::ActiveVersionMaterializationIncomplete { failed_jobs: 1 }
    ));
    assert!(faults.fired.load(Ordering::Acquire));
    assert_eq!(
        std::fs::read(scratch.path().join(".env")).expect("preserved disk"),
        b"MODE=external\n"
    );
    supervisor.close(&database).expect("close");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn secret_switch_delete_preserves_an_edit_between_planning_and_phase_two() {
    let scratch = ScratchDir::new().expect("scratch");
    let database = scratch.engine_db_path().expect("database");
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&database, 1).expect("actor").actor;
    actor
        .ensure_main_version(
            WORKSPACE.to_owned(),
            1,
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("main");
    let key = create_key_file(scratch.path()).expect("secret key");
    actor
        .write_secret_file(
            SecretWrite {
                workspace_id: WORKSPACE.to_owned(),
                version_id: "main".to_owned(),
                path: ".env".to_owned(),
                text: "MODE=main\n".to_owned(),
                moment_id: "switch-delete-race-main".to_owned(),
                metadata_origin: "api".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                now_ms: 2,
                disk_intent: SecretDiskIntent::AlreadyOnDisk,
            },
            key,
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("main secret");
    std::fs::write(scratch.path().join(".env"), b"MODE=main\n").expect("seed disk");
    actor
        .create_named_version(
            CreateNamedVersion {
                workspace_id: WORKSPACE.to_owned(),
                new_version_id: "feature".to_owned(),
                name: "Feature".to_owned(),
                from_version_id: "main".to_owned(),
                now_ms: 3,
                request_id: None,
            },
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("feature");
    actor
        .delete_secret_file(
            SecretDelete {
                workspace_id: WORKSPACE.to_owned(),
                version_id: "feature".to_owned(),
                path: ".env".to_owned(),
                moment_id: "switch-delete-race-feature".to_owned(),
                metadata_origin: "api".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                now_ms: 4,
            },
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("delete feature secret");
    let faults = Arc::new(RewriteAtJobStart::new(
        scratch.path().join(".env"),
        b"MODE=external\n",
    ));

    let error = actor
        .set_active_version(
            ActiveVersionSwitch {
                workspace_id: WORKSPACE.to_owned(),
                version_id: "feature".to_owned(),
                root_dir: scratch.path().to_path_buf(),
                self_writes: Arc::new(NoRecorder),
                now_ms: 5,
            },
            faults.clone(),
            CancellationToken::new(),
        )
        .await
        .expect_err("the changed secret delete preimage must conflict");

    assert!(matches!(
        error,
        RuntimeError::ActiveVersionMaterializationIncomplete { failed_jobs: 1 }
    ));
    assert!(faults.fired.load(Ordering::Acquire));
    assert_eq!(
        std::fs::read(scratch.path().join(".env")).expect("preserved disk"),
        b"MODE=external\n"
    );
    supervisor.close(&database).expect("close");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn switch_jobs_are_distinct_and_match_their_active_workspace() {
    const FIRST: &str = "ws-switch-first";
    const SECOND: &str = "ws-switch-second";

    let first_root = ScratchDir::new().expect("first root");
    let second_root = ScratchDir::new().expect("second root");
    let database = first_root.engine_db_path().expect("database");
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&database, 1).expect("actor").actor;
    for workspace_id in [FIRST, SECOND] {
        actor
            .ensure_main_version(
                workspace_id.to_owned(),
                1,
                Arc::new(NoFaults),
                CancellationToken::new(),
            )
            .await
            .expect("main");
        actor
            .versioned_text_write(
                write_for(
                    workspace_id,
                    "main",
                    "shared.md",
                    "main",
                    &format!("{workspace_id}-main"),
                    2,
                ),
                Arc::new(NoFaults),
                CancellationToken::new(),
            )
            .await
            .expect("main write");
        actor
            .create_named_version(
                CreateNamedVersion {
                    workspace_id: workspace_id.to_owned(),
                    new_version_id: "feature".to_owned(),
                    name: "Feature".to_owned(),
                    from_version_id: "main".to_owned(),
                    now_ms: 3,
                    request_id: None,
                },
                Arc::new(NoFaults),
                CancellationToken::new(),
            )
            .await
            .expect("feature");
        actor
            .versioned_text_write(
                write_for(
                    workspace_id,
                    "feature",
                    "shared.md",
                    "feature",
                    &format!("{workspace_id}-feature"),
                    4,
                ),
                Arc::new(NoFaults),
                CancellationToken::new(),
            )
            .await
            .expect("feature write");
    }
    std::fs::write(first_root.path().join("shared.md"), "main").expect("first disk");
    std::fs::write(second_root.path().join("shared.md"), "main").expect("second disk");

    for (workspace_id, root) in [(FIRST, first_root.path()), (SECOND, second_root.path())] {
        actor
            .set_active_version(
                ActiveVersionSwitch {
                    workspace_id: workspace_id.to_owned(),
                    version_id: "feature".to_owned(),
                    root_dir: root.to_path_buf(),
                    self_writes: Arc::new(NoRecorder),
                    now_ms: 1_700_000_000_000,
                },
                Arc::new(NoFaults),
                CancellationToken::new(),
            )
            .await
            .expect("switch");
    }

    assert_eq!(
        std::fs::read_to_string(first_root.path().join("shared.md")).expect("first switched"),
        "feature"
    );
    assert_eq!(
        std::fs::read_to_string(second_root.path().join("shared.md")).expect("second switched"),
        "feature"
    );
    supervisor.close(&database).expect("close");
    let connection = Connection::open(&database).expect("sqlite");
    let jobs: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM materialization_jobs \
             WHERE job_id LIKE 'version-switch-mat_%' AND target_path = 'shared.md'",
            [],
            |row| row.get(0),
        )
        .expect("switch jobs");
    assert_eq!(
        jobs, 2,
        "each workspace needs its own durable switch projection identity"
    );
}
