use dohc_engine_runtime::{CaptureIngest, CaptureRetire, NoFaults, WorkspaceSupervisor};
use dohc_engine_testkit::ScratchDir;
use std::sync::Arc;

#[test]
fn blocking_capture_variants_round_trip_through_the_actor() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    let supervisor = WorkspaceSupervisor::new();
    let handle = supervisor.open(&db, 1).expect("open actor");

    let written = handle
        .capture_ingest_blocking(
            CaptureIngest {
                workspace_id: "ws-actor-capture".to_owned(),
                version_id: "main".to_owned(),
                path: "notes/a.md".to_owned(),
                text: "captured".to_owned(),
                metadata_origin: "actor-test".to_owned(),
                author_json: None,
                now_ms: 10,
                request_id: Some("actor-capture-request".to_owned()),
            },
            Arc::new(NoFaults),
        )
        .expect("blocking capture");

    assert_eq!(written.snapshot.text, "captured");
    assert_eq!(written.snapshot.path, "notes/a.md");

    let retired = handle
        .capture_retire_blocking(
            CaptureRetire {
                workspace_id: "ws-actor-capture".to_owned(),
                version_id: "main".to_owned(),
                path: "notes/a.md".to_owned(),
                now_ms: 20,
                request_id: Some("actor-retire-request".to_owned()),
            },
            Arc::new(NoFaults),
        )
        .expect("blocking retire");
    assert!(retired.retired.is_some());
    supervisor.close(&db).expect("close actor");
}
