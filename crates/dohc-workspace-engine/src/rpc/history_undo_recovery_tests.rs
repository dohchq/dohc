use super::*;
use dohc_engine_domain::{DeleteTextFile, RenameTextFile, VersionedTextStore, WriteText};
use dohc_engine_storage::{EngineStore, FaultAction, FaultInjector, FaultPoint};
use dohc_engine_testkit::ScratchDir;
use std::sync::atomic::{AtomicUsize, Ordering};

struct CrashAfter(AtomicUsize);
impl FaultInjector for CrashAfter {
    fn poll(&self, point: FaultPoint) -> FaultAction {
        if point == FaultPoint::StorageAfterCommitBeforeAck
            && self.0.fetch_sub(1, Ordering::SeqCst) == 1
        {
            FaultAction::Crash
        } else {
            FaultAction::Continue
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn workspace_open_resumes_interrupted_undo_and_places_every_inverse() {
    let scratch = ScratchDir::new().unwrap();
    let token = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    crate::root_binding::write_root_binding(scratch.path(), token).unwrap();
    let mut store =
        EngineStore::open(&dohc_engine_testkit::engine_db_path(&scratch).unwrap(), 1).unwrap();
    store.bind_root_token(token, &NoFaults).unwrap();
    let mut domain = VersionedTextStore::new(&mut store);
    domain
        .ensure_main_version("resume-undo", "main", 1, &NoFaults)
        .unwrap();
    for index in 0..6 {
        let path = format!("{index}.md");
        domain
            .write_text(
                &WriteText {
                    workspace_id: "resume-undo".into(),
                    version_id: "main".into(),
                    object_id: format!("object-{index}"),
                    path: path.clone(),
                    text: "retained".into(),
                    moment_id: format!("seed-{index}"),
                    request_id: None,
                    metadata_origin: "api".into(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: None,
                    now_ms: 2,
                },
                &NoFaults,
            )
            .unwrap();
        if index == 0 {
            domain
                .rename_text_file(
                    &RenameTextFile {
                        workspace_id: "resume-undo".into(),
                        version_id: "main".into(),
                        from_path: path,
                        to_path: "moved.md".into(),
                        moment_id: "rename".into(),
                        request_id: None,
                        metadata_origin: "api".into(),
                        metadata_summary: None,
                        metadata_correlation_id: Some("dohc-operation:resume".into()),
                        author_json: None,
                        now_ms: 3,
                    },
                    &NoFaults,
                )
                .unwrap();
        } else {
            domain
                .delete_text_file(
                    &DeleteTextFile {
                        workspace_id: "resume-undo".into(),
                        version_id: "main".into(),
                        path,
                        moment_id: format!("delete-{index}"),
                        request_id: None,
                        metadata_origin: "api".into(),
                        metadata_summary: None,
                        metadata_correlation_id: Some("dohc-operation:resume".into()),
                        author_json: None,
                        now_ms: 3,
                    },
                    &NoFaults,
                )
                .unwrap();
        }
    }
    drop(store);
    std::fs::write(scratch.path().join("moved.md"), "retained").unwrap();
    let params = json!({"rootDir":scratch.path(), "workspaceId":"resume-undo"});
    let service = EngineService::new();
    let opened = service
        .workspace_open(&RequestContext::unbounded(), params.clone())
        .await
        .unwrap();
    let handle: WorkspaceHandle = serde_json::from_value(opened["workspace"].clone()).unwrap();
    let open = service.open(Some(&handle)).unwrap();
    let initial_recovery = lock(&open.undo_recovery).take().unwrap();
    initial_recovery.await.unwrap();
    assert!(matches!(
        open.actor
            .history_undo_in_turns(
                "resume-undo".into(),
                "dohc-operation:resume".into(),
                "resume-request".into(),
                None,
                open.root.clone(),
                Arc::new(CrashAfter(AtomicUsize::new(3))),
                10,
                [open.capture_apply_gate.clone(), open.session_ops.clone()],
            )
            .await,
        Err(dohc_engine_runtime::RuntimeError::OperationCrashed)
    ));
    assert_eq!(
        open.actor
            .pending_history_undos("resume-undo".into())
            .await
            .unwrap()
            .len(),
        1
    );
    service.workspace_close(Some(handle)).await.unwrap();
    drop(open);
    drop(service);

    let service = EngineService::new();
    let opened = service
        .workspace_open(&RequestContext::unbounded(), params)
        .await
        .unwrap();
    let handle: WorkspaceHandle = serde_json::from_value(opened["workspace"].clone()).unwrap();
    let open = service.open(Some(&handle)).unwrap();
    let task = lock(&open.undo_recovery).take().unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(30), task)
        .await
        .unwrap()
        .unwrap();
    assert!(
        open.actor
            .pending_history_undos("resume-undo".into())
            .await
            .unwrap()
            .is_empty()
    );
    let replay = open
        .actor
        .preflight_history_undo(
            "resume-undo".into(),
            "dohc-operation:resume".into(),
            "resume-request".into(),
            None,
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(replay.moments.len(), 6);
    assert!(replay.not_restored.is_empty());
    assert!(replay.materialized);
    for index in 0..6 {
        assert_eq!(
            std::fs::read_to_string(scratch.path().join(format!("{index}.md"))).unwrap(),
            "retained"
        );
    }
    assert!(!scratch.path().join("moved.md").exists());
    service.workspace_close(Some(handle)).await.unwrap();
}
