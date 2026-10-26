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

async fn open_undo_fixture() -> (
    ScratchDir,
    Arc<EngineService>,
    WorkspaceHandle,
    Arc<OpenWorkspace>,
) {
    open_undo_fixture_with_operations(1).await
}

async fn open_undo_fixture_with_operations(
    operation_count: usize,
) -> (
    ScratchDir,
    Arc<EngineService>,
    WorkspaceHandle,
    Arc<OpenWorkspace>,
) {
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
    for index in 0..6 * operation_count {
        let path = format!("{index}.md");
        let operation = if index < 6 {
            "dohc-operation:resume".to_owned()
        } else {
            format!("dohc-operation:resume-{}", index / 6)
        };
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
                        metadata_correlation_id: Some(operation),
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
                        metadata_correlation_id: Some(operation),
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
    let mut service = EngineService::new();
    service.capture_apply_probe = Some(capture_driver::CaptureApplyProbe::default());
    let service = Arc::new(service);
    let opened = service
        .workspace_open(&RequestContext::unbounded(), params.clone())
        .await
        .unwrap();
    let handle: WorkspaceHandle = serde_json::from_value(opened["workspace"].clone()).unwrap();
    let open = service.open(Some(&handle)).unwrap();
    let initial_recovery = lock(&open.undo_recovery).take().unwrap();
    initial_recovery.await.unwrap();
    (scratch, service, handle, open)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn workspace_open_resumes_interrupted_undo_and_places_every_inverse() {
    let (scratch, service, handle, open) = open_undo_fixture().await;
    let params = json!({"rootDir":scratch.path(), "workspaceId":"resume-undo"});
    // Crash after the rename's inverse commits. The five deletes can share one
    // turn on a fast host, so a later crash could find the Undo complete.
    assert!(matches!(
        open.actor
            .history_undo_in_turns(
                "resume-undo".into(),
                "dohc-operation:resume".into(),
                "resume-request".into(),
                None,
                open.root.clone(),
                Arc::new(CrashAfter(AtomicUsize::new(2))),
                10,
                [open.capture_apply_gate.clone(), open.session_ops.clone()],
                Arc::new(()),
                None,
                dohc_engine_runtime::CancellationToken::new(),
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
    // The recovery fence replies before its final placement task finishes.
    let replay = tokio::time::timeout(std::time::Duration::from_secs(30), async {
        loop {
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
            if replay.materialized {
                break replay;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("recovered inverses must finish placement");
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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn workspace_open_continues_after_one_pending_undo_fails_once() {
    let (scratch, service, handle, open) = open_undo_fixture_with_operations(2).await;
    for (operation, request) in [
        ("dohc-operation:resume", "a-failing-undo"),
        ("dohc-operation:resume-1", "b-later-undo"),
    ] {
        assert!(matches!(
            open.actor
                .history_undo_in_turns(
                    "resume-undo".into(),
                    operation.into(),
                    request.into(),
                    None,
                    open.root.clone(),
                    Arc::new(CrashAfter(AtomicUsize::new(1))),
                    10,
                    [open.capture_apply_gate.clone(), open.session_ops.clone()],
                    Arc::new(()),
                    None,
                    dohc_engine_runtime::CancellationToken::new(),
                )
                .await,
            Err(dohc_engine_runtime::RuntimeError::OperationCrashed)
        ));
    }
    let pending = open
        .actor
        .pending_history_undos("resume-undo".into())
        .await
        .unwrap();
    assert_eq!(
        pending.iter().map(|row| row.1.as_str()).collect::<Vec<_>>(),
        ["a-failing-undo", "b-later-undo"]
    );
    service.workspace_close(Some(handle)).await.unwrap();
    drop(open);
    drop(service);
    // Install the durable failure after close, without a second live writer.
    let db = dohc_engine_testkit::engine_db_path(&scratch).unwrap();
    let mut store = EngineStore::open(&db, 10).unwrap();
    store
        .write_with(&NoFaults, |tx| {
            tx.execute_batch(
                "CREATE TRIGGER first_undo_fails_once BEFORE INSERT ON moments
                 WHEN NEW.metadata_origin='restore' AND NEW.object_id='object-0'
                 AND (SELECT attempts FROM history_undo_plans WHERE request_id='a-failing-undo')=0
                 BEGIN SELECT RAISE(ABORT,'one transient Undo failure'); END;",
            )
            .map_err(dohc_engine_storage::StorageError::persist_public)
        })
        .unwrap();
    drop(store);

    let service = EngineService::new();
    let params = json!({"rootDir":scratch.path(), "workspaceId":"resume-undo"});
    let opened = service
        .workspace_open(&RequestContext::unbounded(), params.clone())
        .await
        .unwrap();
    let handle: WorkspaceHandle = serde_json::from_value(opened["workspace"].clone()).unwrap();
    let open = service.open(Some(&handle)).unwrap();
    let recovery = lock(&open.undo_recovery).take().unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(30), recovery)
        .await
        .unwrap()
        .unwrap();
    let pending = open
        .actor
        .pending_history_undos("resume-undo".into())
        .await
        .unwrap();
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].0, "dohc-operation:resume");
    assert_eq!(pending[0].1, "a-failing-undo");
    assert_eq!(pending[0].2, None);
    let store = EngineStore::open_read_only(&db).unwrap();
    let attempts: i64 = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT attempts FROM history_undo_plans WHERE request_id=?1",
                ["a-failing-undo"],
                |row| row.get(0),
            )
        })
        .unwrap();
    drop(store);
    assert_eq!(attempts, 1);
    let later = open
        .actor
        .preflight_history_undo(
            "resume-undo".into(),
            "dohc-operation:resume-1".into(),
            "b-later-undo".into(),
            None,
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(later.moments.len(), 6);
    assert!(later.not_restored.is_empty());
    service.workspace_close(Some(handle)).await.unwrap();
    drop(open);
    drop(service);

    // The first request gets its next attempt on the next open, not in a tight loop.
    let service = EngineService::new();
    let opened = service
        .workspace_open(&RequestContext::unbounded(), params)
        .await
        .unwrap();
    let handle: WorkspaceHandle = serde_json::from_value(opened["workspace"].clone()).unwrap();
    let open = service.open(Some(&handle)).unwrap();
    let recovery = lock(&open.undo_recovery).take().unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(30), recovery)
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
    service.workspace_close(Some(handle)).await.unwrap();
}

struct PauseFirstInverse {
    remaining: AtomicUsize,
    entered: std::sync::Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
    released: std::sync::Mutex<std::sync::mpsc::Receiver<()>>,
}
impl FaultInjector for PauseFirstInverse {
    fn poll(&self, point: FaultPoint) -> FaultAction {
        if point == FaultPoint::StorageBeforePersist
            && self.remaining.fetch_sub(1, Ordering::SeqCst) == 1
        {
            let _ = lock(&self.entered).take().unwrap().send(());
            lock(&self.released).recv().unwrap();
        }
        FaultAction::Continue
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn workspace_close_finishes_while_request_undo_waits_between_turns() {
    let (_scratch, service, handle, open) = open_undo_fixture().await;
    let (entered, reached) = tokio::sync::oneshot::channel();
    let (release, released) = std::sync::mpsc::channel();
    let request_open = open.clone();
    // This is a request-owned Undo, not the recovery task that close aborts.
    let undo = tokio::spawn(async move {
        request_open
            .actor
            .history_undo_in_turns(
                "resume-undo".into(),
                "dohc-operation:resume".into(),
                "closing-request".into(),
                None,
                request_open.root.clone(),
                Arc::new(PauseFirstInverse {
                    remaining: AtomicUsize::new(2),
                    entered: std::sync::Mutex::new(Some(entered)),
                    released: std::sync::Mutex::new(released),
                }),
                10,
                [
                    request_open.capture_apply_gate.clone(),
                    request_open.session_ops.clone(),
                ],
                Arc::new(()),
                None,
                dohc_engine_runtime::CancellationToken::new(),
            )
            .await
    });
    reached.await.unwrap();
    // Close queues its capture barrier while the inverse still owns that gate.
    let probe = service.capture_apply_probe.as_ref().unwrap();
    let closing_service = service.clone();
    let closing = tokio::spawn(async move { closing_service.workspace_close(Some(handle)).await });
    probe.wait_until_close_gate_waiting().await;
    release.send(()).unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(10), closing)
        .await
        .expect("close must not retain the checkpoint sender through Undo")
        .unwrap()
        .unwrap();
    assert!(
        tokio::time::timeout(std::time::Duration::from_secs(10), undo)
            .await
            .unwrap()
            .unwrap()
            .is_err()
    );
}
