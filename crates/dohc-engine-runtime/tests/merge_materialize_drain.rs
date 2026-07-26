use dohc_engine_domain::{CreateNamedVersion, MergeTextFileFromVersion, WriteText};
use dohc_engine_runtime::{
    CancellationToken, MergeTextFileResult, NoFaults, PostCommitMaterializeOutcome,
    SelfWriteRecorder, WorkspaceSupervisor,
};
use dohc_engine_storage::FaultPoint;
use dohc_engine_testkit::{ScratchDir, ScriptedFaults};
use std::sync::Arc;

const WORKSPACE: &str = "ws-merge-materialize-drain";

struct NoRecorder;

impl SelfWriteRecorder for NoRecorder {
    fn record(&self, _workspace_id: &str, _path: &str, _sha256: &str) {}
    fn retract(&self, _workspace_id: &str, _path: &str, _sha256: &str) {}
}

fn write(version_id: &str, text: &str, moment_id: &str, object_id: &str) -> WriteText {
    WriteText {
        workspace_id: WORKSPACE.to_owned(),
        version_id: version_id.to_owned(),
        object_id: object_id.to_owned(),
        path: "active.md".to_owned(),
        text: text.to_owned(),
        moment_id: moment_id.to_owned(),
        metadata_origin: "api".to_owned(),
        metadata_summary: None,
        metadata_correlation_id: None,
        author_json: None,
        now_ms: 10,
        request_id: None,
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn active_merge_drains_materialization_before_rpc_return_even_when_completion_faults() {
    // MUTATION: return the committed merge without draining merge-mat_ -> the
    // injected materializer fault never fires and active.md remains "base".
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
        .versioned_text_write(
            write("main", "base", "merge-drain-base", "merge-drain-object"),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("base write");
    actor
        .create_named_version(
            CreateNamedVersion {
                workspace_id: WORKSPACE.to_owned(),
                new_version_id: "feature".to_owned(),
                name: "feature".to_owned(),
                from_version_id: "main".to_owned(),
                now_ms: 20,
                request_id: None,
            },
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("feature fork");
    actor
        .versioned_text_write(
            write(
                "feature",
                "merged before return",
                "merge-drain-incoming",
                "ignored",
            ),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("feature write");
    std::fs::write(scratch.path().join("active.md"), "base").expect("disk preimage");

    let faults = ScriptedFaults::crash_at(FaultPoint::MaterializeAfterRenameBeforeComplete);
    let merge = MergeTextFileFromVersion {
        workspace_id: WORKSPACE.to_owned(),
        target_version_id: "main".to_owned(),
        source_version_id: "feature".to_owned(),
        path: "active.md".to_owned(),
        object_id: "ignored".to_owned(),
        moment_id: "merge-drain-result".to_owned(),
        request_id: Some("merge-drain-request".to_owned()),
        conflict_id: "merge-drain-conflict".to_owned(),
        metadata_origin: "api".to_owned(),
        metadata_summary: None,
        metadata_correlation_id: None,
        author_json: None,
        now_ms: 30,
    };
    let execution = actor
        .versioned_text_merge(
            merge.clone(),
            scratch.path().to_path_buf(),
            Arc::new(NoRecorder),
            faults.clone(),
            CancellationToken::new(),
        )
        .await
        .expect("committed merge");

    assert!(matches!(execution.merge, MergeTextFileResult::Write { .. }));
    assert!(execution.materialize_enqueued);
    assert!(!execution.materialized);
    assert_eq!(
        execution.materialize_outcome,
        PostCommitMaterializeOutcome::Error
    );
    assert!(
        faults.fired(),
        "the synchronous merge drain must reach the injected fault"
    );
    assert_eq!(
        std::fs::read_to_string(scratch.path().join("active.md")).expect("merged disk head"),
        "merged before return"
    );

    let retried = actor
        .versioned_text_merge(
            merge,
            scratch.path().to_path_buf(),
            Arc::new(NoRecorder),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("deduped merge retry");
    assert!(matches!(
        retried.merge,
        MergeTextFileResult::Write { ref write, .. } if write.deduped
    ));
    assert!(!retried.materialize_enqueued);
    assert!(retried.materialized);
    assert_eq!(
        retried.materialize_outcome,
        PostCommitMaterializeOutcome::Applied
    );
    supervisor.close(&db).expect("close actor");
}
