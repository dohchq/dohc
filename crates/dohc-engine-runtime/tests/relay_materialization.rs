use dohc_engine_domain::{VersionedTextStore, WriteText};
use dohc_engine_runtime::{CancellationToken, NoFaults, WorkspaceSupervisor};
use dohc_engine_storage::EngineStore;
use dohc_engine_sync::MomentMaterializationChange;
use dohc_engine_testkit::{ScratchDir, engine_db_path};
use std::sync::Arc;

fn change(version: &str, path: &str, operation: &'static str) -> MomentMaterializationChange {
    MomentMaterializationChange {
        version_id: version.into(),
        path: path.into(),
        operation,
        content_kind: "text",
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn relay_page_materializes_native_state_and_preserves_retry_after_blocked_path() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = engine_db_path(&scratch).expect("database");
    {
        let mut store = EngineStore::open(&db, 1).expect("store");
        let mut versions = VersionedTextStore::new(&mut store);
        versions
            .ensure_main_version("workspace", "main", 1, &NoFaults)
            .expect("main");
        versions
            .write_text(
                &WriteText {
                    workspace_id: "workspace".into(),
                    version_id: "main".into(),
                    object_id: "object".into(),
                    path: "notes/work.md".into(),
                    text: "native accepted text".into(),
                    moment_id: "moment".into(),
                    metadata_origin: "test".into(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: None,
                    now_ms: 2,
                    request_id: None,
                },
                &NoFaults,
            )
            .expect("head");
    }
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 3).expect("actor").actor;
    std::fs::write(scratch.path().join("notes"), "foreign blocker").expect("blocker");
    let paths = vec![change("main", "notes/work.md", "write")];
    assert!(
        actor
            .materialize_relay_page(
                "workspace".into(),
                scratch.path().into(),
                paths.clone(),
                Arc::new(()),
                4,
                CancellationToken::new()
            )
            .await
            .is_err()
    );
    assert_eq!(
        std::fs::read_to_string(scratch.path().join("notes")).expect("retained blocker"),
        "foreign blocker"
    );
    std::fs::remove_file(scratch.path().join("notes")).expect("remove fixture blocker");
    actor
        .materialize_relay_page(
            "workspace".into(),
            scratch.path().into(),
            paths.clone(),
            Arc::new(()),
            5,
            CancellationToken::new(),
        )
        .await
        .expect("retry");
    assert_eq!(
        std::fs::read_to_string(scratch.path().join("notes/work.md")).expect("projection"),
        "native accepted text"
    );
    actor
        .materialize_relay_page(
            "workspace".into(),
            scratch.path().into(),
            paths,
            Arc::new(()),
            6,
            CancellationToken::new(),
        )
        .await
        .expect("idempotent replay");
    // A page from another version must never use this active version's head.
    std::fs::write(scratch.path().join("notes/work.md"), "current disk state")
        .expect("current disk");
    actor
        .materialize_relay_page(
            "workspace".into(),
            scratch.path().into(),
            vec![change("old-version", "notes/work.md", "delete")],
            Arc::new(()),
            7,
            CancellationToken::new(),
        )
        .await
        .expect("skip inactive page");
    assert_eq!(
        std::fs::read_to_string(scratch.path().join("notes/work.md"))
            .expect("retained active projection"),
        "current disk state"
    );
    let cancelled = CancellationToken::new();
    cancelled.cancel();
    assert!(
        actor
            .materialize_relay_page(
                "workspace".into(),
                scratch.path().into(),
                vec![change("main", "notes/work.md", "write")],
                Arc::new(()),
                8,
                cancelled
            )
            .await
            .is_err()
    );
    assert_eq!(
        std::fs::read_to_string(scratch.path().join("notes/work.md"))
            .expect("cancelled projection"),
        "current disk state"
    );
    supervisor.close(&db).expect("close actor");
}
