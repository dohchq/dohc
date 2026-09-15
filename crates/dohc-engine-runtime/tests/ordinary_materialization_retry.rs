use dohc_engine_domain::{DeleteTextFile, VersionedTextStore, WriteText};
use dohc_engine_runtime::{CancellationToken, NoFaults, WorkspaceSupervisor};
use dohc_engine_storage::EngineStore;
use dohc_engine_sync::MomentMaterializationChange;
use dohc_engine_testkit::{ScratchDir, engine_db_path};
use std::sync::Arc;

fn write(text: &str, moment: &str, now_ms: i64) -> WriteText {
    WriteText {
        workspace_id: "workspace".into(),
        version_id: "main".into(),
        object_id: "object".into(),
        path: "file.md".into(),
        text: text.into(),
        moment_id: moment.into(),
        metadata_origin: "sync".into(),
        metadata_summary: None,
        metadata_correlation_id: None,
        author_json: None,
        now_ms,
        request_id: None,
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn earlier_page_write_materializes_the_current_deletion_before_cursor_commit() {
    let scratch = ScratchDir::new().unwrap();
    let db = engine_db_path(&scratch).unwrap();
    {
        let mut store = EngineStore::open(&db, 1).unwrap();
        let mut domain = VersionedTextStore::new(&mut store);
        domain
            .ensure_main_version("workspace", "main", 0, &NoFaults)
            .unwrap();
        domain
            .write_text(&write("old", "write", 1), &NoFaults)
            .unwrap();
        domain
            .set_active_version("workspace", "main", &NoFaults)
            .unwrap();
        domain
            .delete_text_file(
                &DeleteTextFile {
                    workspace_id: "workspace".into(),
                    version_id: "main".into(),
                    path: "file.md".into(),
                    moment_id: "delete".into(),
                    request_id: None,
                    metadata_origin: "sync".into(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: None,
                    now_ms: 2,
                },
                &NoFaults,
            )
            .unwrap();
    }
    std::fs::write(scratch.path().join("file.md"), "old").unwrap();
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 3).unwrap().actor;
    let page = vec![MomentMaterializationChange {
        version_id: "main".into(),
        path: "file.md".into(),
        operation: "write",
        content_kind: "text",
    }];
    for now in [4, 5] {
        actor
            .materialize_relay_page(
                "workspace".into(),
                scratch.path().to_path_buf(),
                page.clone(),
                Arc::new(()),
                now,
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert!(!scratch.path().join("file.md").exists());
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn earlier_page_delete_materializes_the_current_write_instead_of_erasing_it() {
    let scratch = ScratchDir::new().unwrap();
    let db = engine_db_path(&scratch).unwrap();
    {
        let mut store = EngineStore::open(&db, 1).unwrap();
        let mut domain = VersionedTextStore::new(&mut store);
        domain
            .ensure_main_version("workspace", "main", 0, &NoFaults)
            .unwrap();
        domain
            .write_text(&write("new head", "recreated", 2), &NoFaults)
            .unwrap();
        domain
            .set_active_version("workspace", "main", &NoFaults)
            .unwrap();
    }
    std::fs::write(scratch.path().join("file.md"), "old").unwrap();
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 3).unwrap().actor;
    let page = vec![MomentMaterializationChange {
        version_id: "main".into(),
        path: "file.md".into(),
        operation: "delete",
        content_kind: "text",
    }];
    actor
        .materialize_relay_page(
            "workspace".into(),
            scratch.path().to_path_buf(),
            page,
            Arc::new(()),
            4,
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(
        std::fs::read_to_string(scratch.path().join("file.md")).unwrap(),
        "new head"
    );
}
