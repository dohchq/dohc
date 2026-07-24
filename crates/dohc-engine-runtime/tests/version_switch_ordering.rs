use dohc_engine_domain::{CreateNamedVersion, WriteText};
use dohc_engine_runtime::{
    ActiveVersionSwitch, CancellationToken, NoFaults, RuntimeError, SelfWriteRecorder,
    WorkspaceSupervisor,
};
use dohc_engine_storage::FaultPoint;
use dohc_engine_testkit::{ScratchDir, ScriptedFaults};
use std::sync::Arc;

const WORKSPACE: &str = "ws-switch-ordering";

struct NoRecorder;

impl SelfWriteRecorder for NoRecorder {
    fn record(&self, _workspace_id: &str, _path: &str, _sha256: &str) {}
    fn retract(&self, _workspace_id: &str, _path: &str, _sha256: &str) {}
}

fn write(version_id: &str, text: &str, moment_id: &str, now_ms: i64) -> WriteText {
    WriteText {
        workspace_id: WORKSPACE.to_owned(),
        version_id: version_id.to_owned(),
        object_id: "switch-object".to_owned(),
        path: "ordered.md".to_owned(),
        text: text.to_owned(),
        moment_id: moment_id.to_owned(),
        metadata_origin: "api".to_owned(),
        author_json: None,
        now_ms,
        request_id: None,
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
