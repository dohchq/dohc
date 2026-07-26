use base64::Engine as _;
use dohc_engine_collab::Ydoc;
use dohc_engine_protocol::{
    error::ErrorCode,
    transport::{EngineTransport, InProcessTransport, RequestContext},
    wire::{Request, WorkspaceHandle},
};
use dohc_engine_testkit::ScratchDir;
use dohc_workspace_engine::{
    CaptureApplyProbe, EngineService, shadow_fence::write_shadow_marker_for_harness,
};
use serde_json::{Value, json};
use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

const TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const TEST_TIMEOUT: Duration = Duration::from_secs(15);

async fn bounded<T>(what: &str, future: impl Future<Output = T>) -> T {
    tokio::time::timeout(TEST_TIMEOUT, future)
        .await
        .unwrap_or_else(|_| panic!("{what} timed out"))
}

fn request(id: u64, method: &str, workspace: Option<WorkspaceHandle>, params: Value) -> Request {
    Request {
        id,
        method: method.to_owned(),
        workspace,
        deadline_ms: None,
        idempotency_key: None,
        params,
    }
}

async fn fixture(
    name: &str,
    service: EngineService,
) -> (
    ScratchDir,
    Arc<InProcessTransport<EngineService>>,
    WorkspaceHandle,
    String,
) {
    let scratch = ScratchDir::new().expect("scratch");
    write_shadow_marker_for_harness(scratch.path(), TOKEN).expect("marker");
    std::fs::write(scratch.path().join("notes.md"), "main base").expect("seed disk");
    let workspace_id = format!("ws-switch-barrier-{name}");
    let transport = Arc::new(InProcessTransport::new(Arc::new(service)));
    let opened = bounded(
        "workspace.open",
        transport.call(
            RequestContext::unbounded(),
            request(
                1,
                "workspace.open",
                None,
                json!({
                    "rootDir": scratch.path().to_string_lossy(),
                    "workspaceId": workspace_id,
                }),
            ),
        ),
    )
    .await
    .expect("open");
    let handle = serde_json::from_value(opened.result["workspace"].clone()).expect("handle");
    (scratch, transport, handle, workspace_id)
}

async fn open_additional_workspace(
    transport: &InProcessTransport<EngineService>,
    scratch: &ScratchDir,
    workspace_id: &str,
    id: u64,
) -> WorkspaceHandle {
    write_shadow_marker_for_harness(scratch.path(), TOKEN).expect("marker");
    std::fs::write(scratch.path().join("notes.md"), "other base").expect("seed disk");
    let opened = bounded(
        "additional workspace.open",
        transport.call(
            RequestContext::unbounded(),
            request(
                id,
                "workspace.open",
                None,
                json!({
                    "rootDir": scratch.path().to_string_lossy(),
                    "workspaceId": workspace_id,
                }),
            ),
        ),
    )
    .await
    .expect("open additional workspace");
    serde_json::from_value(opened.result["workspace"].clone()).expect("additional handle")
}

async fn call(
    transport: &InProcessTransport<EngineService>,
    handle: &WorkspaceHandle,
    id: u64,
    method: &str,
    params: Value,
) -> Value {
    bounded(
        method,
        transport.call(
            RequestContext::unbounded(),
            request(id, method, Some(handle.clone()), params),
        ),
    )
    .await
    .unwrap_or_else(|error| panic!("{method}: {error:?}"))
    .result
}

async fn call_error(
    transport: &InProcessTransport<EngineService>,
    handle: &WorkspaceHandle,
    id: u64,
    method: &str,
    params: Value,
) -> dohc_engine_protocol::error::WireError {
    bounded(
        method,
        transport.call(
            RequestContext::unbounded(),
            request(id, method, Some(handle.clone()), params),
        ),
    )
    .await
    .expect_err(method)
}

async fn call_with_idempotency(
    transport: &InProcessTransport<EngineService>,
    handle: &WorkspaceHandle,
    id: u64,
    method: &str,
    idempotency_key: &str,
    params: Value,
) -> Result<Value, dohc_engine_protocol::error::WireError> {
    let mut request = request(id, method, Some(handle.clone()), params);
    request.idempotency_key = Some(idempotency_key.to_owned());
    bounded(method, transport.call(RequestContext::unbounded(), request))
        .await
        .map(|response| response.result)
}

async fn create_feature(
    transport: &InProcessTransport<EngineService>,
    handle: &WorkspaceHandle,
    workspace_id: &str,
    id: u64,
) -> String {
    call(
        transport,
        handle,
        id,
        "versions.createNamed",
        json!({
            "workspaceId": workspace_id,
            "name": format!("feature-{id}"),
            "fromVersionId": "main",
        }),
    )
    .await["id"]
        .as_str()
        .expect("feature id")
        .to_owned()
}

async fn switch_to(
    transport: &InProcessTransport<EngineService>,
    handle: &WorkspaceHandle,
    workspace_id: &str,
    version_id: &str,
    id: u64,
) -> Result<Value, dohc_engine_protocol::error::WireError> {
    bounded(
        "versions.setActive",
        transport.call(
            RequestContext::unbounded(),
            request(
                id,
                "versions.setActive",
                Some(handle.clone()),
                json!({ "workspaceId": workspace_id, "versionId": version_id }),
            ),
        ),
    )
    .await
    .map(|response| response.result)
}

async fn read_path(
    transport: &InProcessTransport<EngineService>,
    handle: &WorkspaceHandle,
    version_id: &str,
    path: &str,
    id: u64,
) -> Option<String> {
    let value = call(
        transport,
        handle,
        id,
        "versionedText.read",
        json!({ "versionId": version_id, "path": path }),
    )
    .await;
    value["text"].as_str().map(str::to_owned)
}

async fn flush_until_settled(
    transport: &InProcessTransport<EngineService>,
    handle: &WorkspaceHandle,
    mut id: u64,
) {
    for _ in 0..20 {
        let status = call(transport, handle, id, "capture.flush", json!({})).await;
        if status["settled"] == json!(true) {
            return;
        }
        id += 1;
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("capture did not settle");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn set_active_settles_live_ydoc_into_old_version_and_closes_session() {
    let (scratch, transport, handle, workspace_id) = fixture("ydoc", EngineService::new()).await;
    let feature = create_feature(&transport, &handle, &workspace_id, 2).await;
    switch_to(&transport, &handle, &workspace_id, &feature, 3)
        .await
        .expect("switch to feature");

    let opened = call(
        &transport,
        &handle,
        4,
        "ydoc.open",
        json!({
            "versionId": feature,
            "path": "notes.md",
            "contentKind": "plaintext",
        }),
    )
    .await;
    let session_id = opened["sessionId"].as_str().expect("session id").to_owned();
    let doc = Ydoc::wire();
    let update = base64::engine::general_purpose::STANDARD
        .encode(doc.plaintext_insert(0, "live feature edit"));
    call(
        &transport,
        &handle,
        5,
        "ydoc.recordUpdate",
        json!({ "sessionId": session_id, "updateBase64": update }),
    )
    .await;

    switch_to(&transport, &handle, &workspace_id, "main", 6)
        .await
        .expect("switch to main");

    assert_eq!(
        read_path(&transport, &handle, &feature, "notes.md", 7)
            .await
            .as_deref(),
        Some("live feature edit"),
        "the forced settle must target the version being left"
    );
    assert_eq!(
        read_path(&transport, &handle, "main", "notes.md", 8)
            .await
            .as_deref(),
        Some("main base"),
        "the old session must not cross into the destination"
    );
    assert_eq!(
        std::fs::read_to_string(scratch.path().join("notes.md")).expect("main projection"),
        "main base"
    );
    let closed = bounded(
        "ydoc.settle after switch",
        transport.call(
            RequestContext::unbounded(),
            request(
                9,
                "ydoc.settle",
                Some(handle.clone()),
                json!({ "sessionId": session_id }),
            ),
        ),
    )
    .await
    .expect_err("switch must close the old session");
    assert_eq!(closed.code, ErrorCode::InvalidParams);
    assert_eq!(closed.message, "ydoc-session-not-found");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn version_fence_uses_the_latest_plaintext_settlement_as_its_preimage() {
    // MUTATION: use open_head_sha instead of last_settled_sha in the fence
    // session view -> the second settlement is fenced against the original
    // open head instead of the settlement it follows.
    let (_scratch, transport, handle, workspace_id) =
        fixture("latest-settle-preimage", EngineService::new()).await;
    let opened = call(
        &transport,
        &handle,
        2,
        "ydoc.open",
        json!({
            "versionId": "main",
            "path": "notes.md",
            "contentKind": "plaintext",
        }),
    )
    .await;
    let session_id = opened["sessionId"].as_str().expect("session id").to_owned();
    let doc = Ydoc::wire();
    let first = base64::engine::general_purpose::STANDARD.encode(doc.plaintext_insert(0, "v1"));
    call(
        &transport,
        &handle,
        3,
        "ydoc.recordUpdate",
        json!({ "sessionId": session_id, "updateBase64": first }),
    )
    .await;
    let first_settle = call(
        &transport,
        &handle,
        4,
        "ydoc.settle",
        json!({ "sessionId": session_id }),
    )
    .await;
    assert_eq!(first_settle["markdown"], json!("v1"));

    let second = base64::engine::general_purpose::STANDARD.encode(doc.plaintext_insert(0, "v2 "));
    call(
        &transport,
        &handle,
        5,
        "ydoc.recordUpdate",
        json!({ "sessionId": session_id, "updateBase64": second }),
    )
    .await;
    let fork = call(
        &transport,
        &handle,
        6,
        "versions.createNamed",
        json!({
            "workspaceId": workspace_id,
            "name": "after second edit",
            "fromVersionId": "main",
        }),
    )
    .await;
    let fork_id = fork["id"].as_str().expect("fork id");
    assert_eq!(
        read_path(&transport, &handle, fork_id, "notes.md", 7)
            .await
            .as_deref(),
        Some("v2 v1")
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn set_active_forced_scan_captures_edit_while_live_driver_is_gated() {
    let probe = CaptureApplyProbe::default();
    let service = EngineService::with_capture_apply_probe_for_harness(probe.clone());
    let (scratch, transport, handle, workspace_id) = fixture("full-scan", service).await;
    let feature = create_feature(&transport, &handle, &workspace_id, 2).await;

    // The signal fires only after setActive owns the capture gate. Therefore
    // the live driver cannot observe this write; only the forced scan can.
    probe.pause_next_version_fence();
    let switch_transport = Arc::clone(&transport);
    let switch_handle = handle.clone();
    let switch_workspace = workspace_id.clone();
    let switch_feature = feature.clone();
    let switching = tokio::spawn(async move {
        switch_to(
            &switch_transport,
            &switch_handle,
            &switch_workspace,
            &switch_feature,
            3,
        )
        .await
    });
    bounded(
        "setActive pre-scan probe",
        probe.wait_until_version_fence_paused(),
    )
    .await;
    std::fs::write(scratch.path().join("notes.md"), "unannounced disk edit")
        .expect("external edit");
    probe.release_version_fence();
    bounded("setActive task", switching)
        .await
        .expect("switch task")
        .expect("switch");

    assert_eq!(
        read_path(&transport, &handle, "main", "notes.md", 4)
            .await
            .as_deref(),
        Some("unannounced disk edit"),
        "the pre-switch full scan captures the edit into the version being left"
    );
    assert_eq!(
        read_path(&transport, &handle, &feature, "notes.md", 5)
            .await
            .as_deref(),
        Some("main base")
    );
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn set_active_fails_closed_when_the_forced_scan_is_degraded() {
    use std::os::unix::fs::PermissionsExt as _;

    struct RestoreMode {
        path: std::path::PathBuf,
        mode: u32,
    }
    impl Drop for RestoreMode {
        fn drop(&mut self) {
            let _ =
                std::fs::set_permissions(&self.path, std::fs::Permissions::from_mode(self.mode));
        }
    }

    let probe = CaptureApplyProbe::default();
    let service = EngineService::with_capture_apply_probe_for_harness(probe.clone());
    let (scratch, transport, handle, workspace_id) = fixture("degraded-unix", service).await;
    let feature = create_feature(&transport, &handle, &workspace_id, 2).await;
    let refreshes_before = probe.manifest_refresh_count();
    let unreadable = scratch.path().join("unreadable");
    std::fs::create_dir(&unreadable).expect("unreadable directory");
    std::fs::write(unreadable.join("held.md"), "cannot scan this").expect("held file");
    let original_mode = std::fs::metadata(&unreadable)
        .expect("directory metadata")
        .permissions()
        .mode();
    let _restore = RestoreMode {
        path: unreadable.clone(),
        mode: original_mode,
    };
    std::fs::set_permissions(&unreadable, std::fs::Permissions::from_mode(0))
        .expect("remove directory permissions");
    if std::fs::read_dir(&unreadable).is_ok() {
        // Root and some sandboxed CI identities bypass mode bits, so this
        // fixture cannot exercise a degraded listing there.
        return;
    }

    let error = switch_to(&transport, &handle, &workspace_id, &feature, 3)
        .await
        .expect_err("degraded scan must fail the switch");
    assert_eq!(error.code, ErrorCode::Internal);
    assert_eq!(error.message, "Could not scan workspace paths: unreadable");
    let status = call(&transport, &handle, 4, "watcher.status", json!({})).await;
    assert_eq!(status["degraded"], json!(true));
    let active = call(
        &transport,
        &handle,
        5,
        "versions.active",
        json!({ "workspaceId": workspace_id }),
    )
    .await;
    assert_eq!(active["id"], json!("main"));
    assert_eq!(
        probe.manifest_refresh_count(),
        refreshes_before + 1,
        "a failed forced scan must invalidate the live manifest"
    );
}

#[cfg(windows)]
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn set_active_fails_closed_when_the_forced_scan_is_degraded() {
    use std::io::Write as _;
    use std::os::windows::fs::OpenOptionsExt as _;

    let probe = CaptureApplyProbe::default();
    let service = EngineService::with_capture_apply_probe_for_harness(probe.clone());
    let (scratch, transport, handle, workspace_id) = fixture("degraded", service).await;
    let feature = create_feature(&transport, &handle, &workspace_id, 2).await;
    let refreshes_before = probe.manifest_refresh_count();
    let mut locked = std::fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .share_mode(0)
        .open(scratch.path().join("locked.md"))
        .expect("share-locked file");
    locked.write_all(b"cannot scan this").expect("locked write");
    locked.flush().expect("locked flush");

    let error = switch_to(&transport, &handle, &workspace_id, &feature, 3)
        .await
        .expect_err("degraded scan must fail the switch");
    assert_eq!(error.code, ErrorCode::Internal);
    assert_eq!(error.message, "Could not scan workspace paths: locked.md");
    let status = call(&transport, &handle, 4, "watcher.status", json!({})).await;
    assert_eq!(status["degraded"], json!(true));
    let active = call(
        &transport,
        &handle,
        5,
        "versions.active",
        json!({ "workspaceId": workspace_id }),
    )
    .await;
    assert_eq!(active["id"], json!("main"));
    assert_eq!(
        probe.manifest_refresh_count(),
        refreshes_before + 1,
        "a failed forced scan must invalidate the live manifest"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn set_active_drains_an_apply_already_in_flight_before_switching() {
    let probe = CaptureApplyProbe::default();
    let service = EngineService::with_capture_apply_probe_for_harness(probe.clone());
    let (scratch, transport, handle, workspace_id) = fixture("straddle", service).await;
    let feature = create_feature(&transport, &handle, &workspace_id, 2).await;

    probe.pause_next_apply();
    std::fs::write(scratch.path().join("notes.md"), "apply already planned")
        .expect("external edit");
    let flush_transport = Arc::clone(&transport);
    let flush_handle = handle.clone();
    let flush = tokio::spawn(async move {
        call(
            &flush_transport,
            &flush_handle,
            3,
            "capture.flush",
            json!({}),
        )
        .await
    });
    bounded("capture apply probe", probe.wait_until_paused()).await;

    let switch_transport = Arc::clone(&transport);
    let switch_handle = handle.clone();
    let switch_workspace = workspace_id.clone();
    let switch_feature = feature.clone();
    let switch = tokio::spawn(async move {
        switch_to(
            &switch_transport,
            &switch_handle,
            &switch_workspace,
            &switch_feature,
            4,
        )
        .await
    });
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(
        !switch.is_finished(),
        "setActive must wait for the already-prepared apply to drain"
    );

    probe.release();
    bounded("capture.flush task", flush)
        .await
        .expect("flush task");
    bounded("setActive task", switch)
        .await
        .expect("switch task")
        .expect("switch after drain");
    assert_eq!(
        read_path(&transport, &handle, "main", "notes.md", 5)
            .await
            .as_deref(),
        Some("apply already planned")
    );
    assert_eq!(
        read_path(&transport, &handle, &feature, "notes.md", 6)
            .await
            .as_deref(),
        Some("main base"),
        "the in-flight apply must not resolve its destination after the switch"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn set_active_blocks_ydoc_admission_between_sweep_and_switch() {
    let probe = CaptureApplyProbe::default();
    let service = EngineService::with_capture_apply_probe_for_harness(probe.clone());
    let (_scratch, transport, handle, workspace_id) = fixture("admission", service).await;
    let feature = create_feature(&transport, &handle, &workspace_id, 2).await;

    probe.pause_next_version_commit();
    let switch_transport = Arc::clone(&transport);
    let switch_handle = handle.clone();
    let switch_workspace = workspace_id.clone();
    let switch_feature = feature.clone();
    let switching = tokio::spawn(async move {
        switch_to(
            &switch_transport,
            &switch_handle,
            &switch_workspace,
            &switch_feature,
            3,
        )
        .await
    });
    bounded(
        "setActive pre-commit probe",
        probe.wait_until_version_commit_paused(),
    )
    .await;

    let open_transport = Arc::clone(&transport);
    let open_handle = handle.clone();
    let open_feature = feature.clone();
    let mut opening = tokio::spawn(async move {
        call(
            &open_transport,
            &open_handle,
            4,
            "ydoc.open",
            json!({
                "versionId": open_feature,
                "path": "notes.md",
                "contentKind": "plaintext",
            }),
        )
        .await
    });
    assert!(
        tokio::time::timeout(Duration::from_millis(250), &mut opening)
            .await
            .is_err(),
        "ydoc.open must remain queued until the fenced switch commits"
    );

    probe.release_version_commit();
    bounded("setActive task", switching)
        .await
        .expect("switch task")
        .expect("switch");
    let opened = bounded("ydoc.open task", opening).await.expect("open task");
    assert!(opened["sessionId"].as_str().is_some());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn set_active_fence_does_not_block_ydoc_admission_in_another_workspace() {
    // MUTATION: put session_ops back on EngineService and acquire that global
    // gate in the fence + ydoc.open -> workspace B remains queued here while
    // workspace A is paused in its destructive continuation.
    let probe = CaptureApplyProbe::default();
    let service = EngineService::with_capture_apply_probe_for_harness(probe.clone());
    let (_first_scratch, transport, first_handle, first_workspace) =
        fixture("workspace-scoped-a", service).await;
    let feature = create_feature(&transport, &first_handle, &first_workspace, 2).await;
    let second_scratch = ScratchDir::new().expect("second scratch");
    let second_workspace = "ws-switch-barrier-workspace-scoped-b";
    let second_handle =
        open_additional_workspace(&transport, &second_scratch, second_workspace, 3).await;

    probe.pause_next_version_commit();
    let switch_transport = Arc::clone(&transport);
    let switch_handle = first_handle.clone();
    let switch_workspace = first_workspace.clone();
    let switching = tokio::spawn(async move {
        switch_to(
            &switch_transport,
            &switch_handle,
            &switch_workspace,
            &feature,
            4,
        )
        .await
    });
    bounded(
        "workspace A setActive pre-commit probe",
        probe.wait_until_version_commit_paused(),
    )
    .await;

    let open_transport = Arc::clone(&transport);
    let open_handle = second_handle.clone();
    let mut opening = tokio::spawn(async move {
        call(
            &open_transport,
            &open_handle,
            5,
            "ydoc.open",
            json!({
                "versionId": "main",
                "path": "notes.md",
                "contentKind": "plaintext",
            }),
        )
        .await
    });
    let admitted = tokio::time::timeout(Duration::from_secs(1), &mut opening).await;
    let admitted_while_other_workspace_fenced = admitted.is_ok();

    probe.release_version_commit();
    bounded("workspace A setActive task", switching)
        .await
        .expect("switch task")
        .expect("switch");
    let opened = match admitted {
        Ok(opened) => opened.expect("ydoc.open task"),
        Err(_) => bounded("workspace B delayed ydoc.open", opening)
            .await
            .expect("ydoc.open task"),
    };
    assert!(
        admitted_while_other_workspace_fenced,
        "workspace A's fence must not hold workspace B's admission gate"
    );
    assert!(opened["sessionId"].as_str().is_some());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn cancelled_set_active_keeps_the_owned_fence_until_the_switch_finishes() {
    // MUTATION: run the destructive continuation in the request future instead
    // of the owned task -> abort drops both guards and the switch never commits.
    let probe = CaptureApplyProbe::default();
    let service = EngineService::with_capture_apply_probe_for_harness(probe.clone());
    let (_scratch, transport, handle, workspace_id) = fixture("cancel-owned", service).await;
    let feature = create_feature(&transport, &handle, &workspace_id, 2).await;

    probe.pause_next_version_commit();
    let switch_transport = Arc::clone(&transport);
    let switch_handle = handle.clone();
    let switch_workspace = workspace_id.clone();
    let switch_feature = feature.clone();
    let switching = tokio::spawn(async move {
        switch_to(
            &switch_transport,
            &switch_handle,
            &switch_workspace,
            &switch_feature,
            3,
        )
        .await
    });
    bounded(
        "setActive detached commit pause",
        probe.wait_until_version_commit_paused(),
    )
    .await;
    switching.abort();
    assert!(
        switching
            .await
            .expect_err("request future was cancelled")
            .is_cancelled()
    );

    probe.observe_next_apply_gate_wait();
    let flush_transport = Arc::clone(&transport);
    let flush_handle = handle.clone();
    let mut flushing = tokio::spawn(async move {
        call(
            &flush_transport,
            &flush_handle,
            4,
            "capture.flush",
            json!({}),
        )
        .await
    });
    bounded(
        "live driver waiting behind detached fence",
        probe.wait_until_apply_gate_waiting(),
    )
    .await;
    assert!(
        tokio::time::timeout(Duration::from_millis(100), &mut flushing)
            .await
            .is_err(),
        "capture must remain fenced after the request future is cancelled"
    );

    probe.release_version_commit();
    bounded("capture after detached switch", flushing)
        .await
        .expect("flush task");
    for id in 5..25 {
        let active = call(
            &transport,
            &handle,
            id,
            "versions.active",
            json!({ "workspaceId": workspace_id }),
        )
        .await;
        if active["id"] == json!(feature) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("the detached setActive continuation did not commit");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn cancelled_set_active_returns_while_the_owned_fence_finishes_detached() {
    let probe = CaptureApplyProbe::default();
    let service = EngineService::with_capture_apply_probe_for_harness(probe.clone());
    let (_scratch, transport, handle, workspace_id) =
        fixture("cancel-detached-wait", service).await;
    let feature = create_feature(&transport, &handle, &workspace_id, 2).await;

    probe.pause_next_version_commit();
    let ctx = RequestContext::unbounded();
    let cancel = ctx.cancel.clone();
    let switch_transport = Arc::clone(&transport);
    let switch_handle = handle.clone();
    let switch_workspace = workspace_id.clone();
    let switch_feature = feature.clone();
    let switching = tokio::spawn(async move {
        switch_transport
            .call(
                ctx,
                request(
                    3,
                    "versions.setActive",
                    Some(switch_handle),
                    json!({
                        "workspaceId": switch_workspace,
                        "versionId": switch_feature,
                    }),
                ),
            )
            .await
    });
    bounded(
        "setActive detached commit pause",
        probe.wait_until_version_commit_paused(),
    )
    .await;

    cancel.cancel();
    let interrupted = tokio::time::timeout(Duration::from_secs(1), switching)
        .await
        .expect("cancelled in-process caller must not await the detached fence")
        .expect("switch task")
        .expect_err("cancelled switch");
    assert_eq!(interrupted.code, ErrorCode::Cancelled);

    probe.release_version_commit();
    for id in 4..24 {
        let active = call(
            &transport,
            &handle,
            id,
            "versions.active",
            json!({ "workspaceId": workspace_id }),
        )
        .await;
        if active["id"] == json!(feature) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("the detached setActive continuation did not commit");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn create_named_fences_live_ydoc_and_unannounced_disk_edits_into_fork() {
    let probe = CaptureApplyProbe::default();
    let service = EngineService::with_capture_apply_probe_for_harness(probe.clone());
    let (scratch, transport, handle, workspace_id) = fixture("create-named", service).await;

    let opened = call(
        &transport,
        &handle,
        2,
        "ydoc.open",
        json!({
            "versionId": "main",
            "path": "notes.md",
            "contentKind": "plaintext",
        }),
    )
    .await;
    let session_id = opened["sessionId"].as_str().expect("session id").to_owned();
    let update = base64::engine::general_purpose::STANDARD
        .encode(Ydoc::wire().plaintext_insert(0, "live main edit"));
    call(
        &transport,
        &handle,
        3,
        "ydoc.recordUpdate",
        json!({ "sessionId": session_id, "updateBase64": update }),
    )
    .await;

    probe.pause_next_version_fence();
    let create_transport = Arc::clone(&transport);
    let create_handle = handle.clone();
    let create_workspace = workspace_id.clone();
    let creating = tokio::spawn(async move {
        call(
            &create_transport,
            &create_handle,
            4,
            "versions.createNamed",
            json!({
                "workspaceId": create_workspace,
                "name": "fenced fork",
                "fromVersionId": "main",
            }),
        )
        .await
    });
    bounded(
        "createNamed pre-scan probe",
        probe.wait_until_version_fence_paused(),
    )
    .await;
    std::fs::write(scratch.path().join("disk-only.md"), "unannounced disk edit")
        .expect("external edit");
    probe.release_version_fence();

    let created = bounded("createNamed task", creating)
        .await
        .expect("create task");
    let fork = created["id"].as_str().expect("fork id");
    for version in ["main", fork] {
        assert_eq!(
            read_path(&transport, &handle, version, "notes.md", 5)
                .await
                .as_deref(),
            Some("live main edit"),
            "{version} must contain the swept Y.Doc edit"
        );
        assert_eq!(
            read_path(&transport, &handle, version, "disk-only.md", 6)
                .await
                .as_deref(),
            Some("unannounced disk edit"),
            "{version} must contain the forced-scan disk edit"
        );
    }

    // MUTATION: omit the live-manifest refresh -> the driver's old manifest
    // never learned this forced-scan-only add, so its deletion emits no Retire.
    std::fs::remove_file(scratch.path().join("disk-only.md")).expect("delete forced-scan add");
    flush_until_settled(&transport, &handle, 7).await;
    assert_eq!(
        read_path(&transport, &handle, "main", "disk-only.md", 30).await,
        None,
        "the refreshed live manifest must retire a later deletion"
    );
    assert_eq!(
        read_path(&transport, &handle, fork, "disk-only.md", 31)
            .await
            .as_deref(),
        Some("unannounced disk edit"),
        "the immutable fork retains the forced-scan snapshot"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn set_active_leaves_sessions_for_unrelated_versions_open_and_unprojected() {
    // MUTATION: remove the source-version filter from the sweep -> this session
    // closes and its inactive bytes can be captured into the version being left.
    let (scratch, transport, handle, workspace_id) =
        fixture("switch-session-scope", EngineService::new()).await;
    let unrelated = create_feature(&transport, &handle, &workspace_id, 2).await;
    let destination = create_feature(&transport, &handle, &workspace_id, 3).await;
    let opened = call(
        &transport,
        &handle,
        4,
        "ydoc.open",
        json!({
            "versionId": unrelated,
            "path": "notes.md",
            "contentKind": "plaintext",
        }),
    )
    .await;
    let session_id = opened["sessionId"].as_str().expect("session id").to_owned();
    let doc = Ydoc::wire();
    let first =
        base64::engine::general_purpose::STANDARD.encode(doc.plaintext_insert(0, "inactive edit"));
    call(
        &transport,
        &handle,
        5,
        "ydoc.recordUpdate",
        json!({ "sessionId": session_id, "updateBase64": first }),
    )
    .await;

    switch_to(&transport, &handle, &workspace_id, &destination, 6)
        .await
        .expect("switch");
    assert_eq!(
        std::fs::read_to_string(scratch.path().join("notes.md")).expect("projection"),
        "main base"
    );
    assert_eq!(
        read_path(&transport, &handle, "main", "notes.md", 7)
            .await
            .as_deref(),
        Some("main base")
    );
    let second =
        base64::engine::general_purpose::STANDARD.encode(doc.plaintext_insert(0, "still "));
    call(
        &transport,
        &handle,
        8,
        "ydoc.recordUpdate",
        json!({ "sessionId": session_id, "updateBase64": second }),
    )
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn create_named_ignores_and_preserves_an_unrelated_richdoc_session() {
    // MUTATION: make the richdoc refusal or session sweep workspace-wide ->
    // this valid fork is refused or the unrelated session disappears.
    let (_scratch, transport, handle, workspace_id) =
        fixture("fork-session-scope", EngineService::new()).await;
    let unrelated = create_feature(&transport, &handle, &workspace_id, 2).await;
    let opened = call(
        &transport,
        &handle,
        3,
        "ydoc.open",
        json!({
            "versionId": unrelated,
            "path": "notes.md",
            "contentKind": "richdoc",
        }),
    )
    .await;
    let session_id = opened["sessionId"].as_str().expect("session id").to_owned();
    let doc = Ydoc::wire();
    let first = base64::engine::general_purpose::STANDARD
        .encode(doc.richdoc_append_paragraph("unrelated edit"));
    call(
        &transport,
        &handle,
        4,
        "ydoc.recordUpdate",
        json!({ "sessionId": session_id, "updateBase64": first }),
    )
    .await;

    call(
        &transport,
        &handle,
        5,
        "versions.createNamed",
        json!({
            "workspaceId": workspace_id,
            "name": "fork with unrelated editor",
            "fromVersionId": "main",
        }),
    )
    .await;
    let second = base64::engine::general_purpose::STANDARD
        .encode(doc.richdoc_append_paragraph("session survived"));
    call(
        &transport,
        &handle,
        6,
        "ydoc.recordUpdate",
        json!({ "sessionId": session_id, "updateBase64": second }),
    )
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn create_named_from_an_inactive_version_leaves_its_live_session_open() {
    // MUTATION: use fromVersionId as the pre-fork reconcile target -> this
    // untouched inactive session is closed even though the working tree is
    // still materializing main.
    let (scratch, transport, handle, workspace_id) =
        fixture("inactive-fork-source", EngineService::new()).await;
    let inactive = create_feature(&transport, &handle, &workspace_id, 2).await;
    let opened = call(
        &transport,
        &handle,
        3,
        "ydoc.open",
        json!({
            "versionId": inactive,
            "path": "notes.md",
            "contentKind": "plaintext",
        }),
    )
    .await;
    let session_id = opened["sessionId"].as_str().expect("session id").to_owned();

    call(
        &transport,
        &handle,
        4,
        "versions.createNamed",
        json!({
            "workspaceId": workspace_id,
            "name": "fork inactive source",
            "fromVersionId": inactive,
        }),
    )
    .await;
    assert_eq!(
        std::fs::read_to_string(scratch.path().join("notes.md")).expect("active projection"),
        "main base",
        "forking an inactive version must not materialize it into the active tree"
    );

    let update = base64::engine::general_purpose::STANDARD
        .encode(Ydoc::wire().plaintext_insert(0, "session stayed open"));
    call(
        &transport,
        &handle,
        5,
        "ydoc.recordUpdate",
        json!({ "sessionId": session_id, "updateBase64": update }),
    )
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn dropping_engine_service_releases_its_single_actor_attachment() {
    let scratch = ScratchDir::new().expect("scratch");
    write_shadow_marker_for_harness(scratch.path(), TOKEN).expect("marker");
    let workspace_id = "ws-switch-barrier-drop-release";
    let transport = Arc::new(InProcessTransport::new(Arc::new(EngineService::new())));
    transport
        .call(
            RequestContext::unbounded(),
            request(
                1,
                "workspace.open",
                None,
                json!({
                    "rootDir": scratch.path().to_string_lossy(),
                    "workspaceId": workspace_id,
                }),
            ),
        )
        .await
        .expect("initial open");
    drop(transport);

    for id in 2..42 {
        let replacement = Arc::new(InProcessTransport::new(Arc::new(EngineService::new())));
        match replacement
            .call(
                RequestContext::unbounded(),
                request(
                    id,
                    "workspace.open",
                    None,
                    json!({
                        "rootDir": scratch.path().to_string_lossy(),
                        "workspaceId": workspace_id,
                    }),
                ),
            )
            .await
        {
            Ok(opened) => {
                let handle: WorkspaceHandle =
                    serde_json::from_value(opened.result["workspace"].clone()).expect("handle");
                replacement
                    .call(
                        RequestContext::unbounded(),
                        request(id + 100, "workspace.close", Some(handle), json!({})),
                    )
                    .await
                    .expect("replacement close");
                return;
            }
            Err(error) => {
                assert_eq!(error.code, ErrorCode::WorkspaceUnavailable);
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        }
    }
    panic!("dropping EngineService did not release its actor attachment");
}

#[test]
fn dropping_engine_service_after_its_runtime_stops_releases_the_actor() {
    let scratch = ScratchDir::new().expect("scratch");
    write_shadow_marker_for_harness(scratch.path(), TOKEN).expect("marker");
    std::fs::write(scratch.path().join("notes.md"), "main base").expect("seed disk");
    let workspace_id = "ws-switch-barrier-stopped-runtime-drop";
    let transport = Arc::new(InProcessTransport::new(Arc::new(EngineService::new())));
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("scoped runtime");
    runtime
        .block_on(transport.call(
            RequestContext::unbounded(),
            request(
                1,
                "workspace.open",
                None,
                json!({
                    "rootDir": scratch.path().to_string_lossy(),
                    "workspaceId": workspace_id,
                }),
            ),
        ))
        .expect("initial open");
    drop(runtime);
    drop(transport);

    let replacement_runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("replacement runtime");
    for id in 2..42 {
        let replacement = Arc::new(InProcessTransport::new(Arc::new(EngineService::new())));
        match replacement_runtime.block_on(replacement.call(
            RequestContext::unbounded(),
            request(
                id,
                "workspace.open",
                None,
                json!({
                    "rootDir": scratch.path().to_string_lossy(),
                    "workspaceId": workspace_id,
                }),
            ),
        )) {
            Ok(opened) => {
                let handle: WorkspaceHandle =
                    serde_json::from_value(opened.result["workspace"].clone()).expect("handle");
                replacement_runtime
                    .block_on(replacement.call(
                        RequestContext::unbounded(),
                        request(id + 100, "workspace.close", Some(handle), json!({})),
                    ))
                    .expect("replacement close");
                return;
            }
            Err(error) => {
                assert_eq!(error.code, ErrorCode::WorkspaceUnavailable);
                std::thread::sleep(Duration::from_millis(25));
            }
        }
    }
    panic!("drop after runtime shutdown did not release its actor attachment");
}

#[test]
fn dropping_engine_service_in_the_final_runtime_future_releases_the_actor() {
    // MUTATION: spawn drop cleanup onto Handle::try_current() and immediately
    // drop this current-thread runtime; the cleanup task is never polled.
    let scratch = ScratchDir::new().expect("scratch");
    write_shadow_marker_for_harness(scratch.path(), TOKEN).expect("marker");
    std::fs::write(scratch.path().join("notes.md"), "main base").expect("seed disk");
    let workspace_id = "ws-switch-barrier-final-future-drop";
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("scoped runtime");
    runtime.block_on(async {
        let transport = Arc::new(InProcessTransport::new(Arc::new(EngineService::new())));
        transport
            .call(
                RequestContext::unbounded(),
                request(
                    1,
                    "workspace.open",
                    None,
                    json!({
                        "rootDir": scratch.path().to_string_lossy(),
                        "workspaceId": workspace_id,
                    }),
                ),
            )
            .await
            .expect("initial open");
        drop(transport);
    });
    drop(runtime);

    let replacement_runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("replacement runtime");
    for id in 2..42 {
        let replacement = Arc::new(InProcessTransport::new(Arc::new(EngineService::new())));
        match replacement_runtime.block_on(replacement.call(
            RequestContext::unbounded(),
            request(
                id,
                "workspace.open",
                None,
                json!({
                    "rootDir": scratch.path().to_string_lossy(),
                    "workspaceId": workspace_id,
                }),
            ),
        )) {
            Ok(opened) => {
                let handle: WorkspaceHandle =
                    serde_json::from_value(opened.result["workspace"].clone()).expect("handle");
                replacement_runtime
                    .block_on(replacement.call(
                        RequestContext::unbounded(),
                        request(id + 100, "workspace.close", Some(handle), json!({})),
                    ))
                    .expect("replacement close");
                return;
            }
            Err(error) => {
                assert_eq!(error.code, ErrorCode::WorkspaceUnavailable);
                std::thread::sleep(Duration::from_millis(25));
            }
        }
    }
    panic!("drop in the final runtime future did not release its actor attachment");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn workspace_close_and_set_active_share_capture_then_session_lock_order() {
    // MUTATION: restore close's session→capture acquisition -> the bounded
    // setActive join times out on the deterministic three-party deadlock.
    let probe = CaptureApplyProbe::default();
    let service = EngineService::with_capture_apply_probe_for_harness(probe.clone());
    let (_scratch, transport, handle, workspace_id) = fixture("close-order", service).await;
    let feature = create_feature(&transport, &handle, &workspace_id, 2).await;

    probe.pause_next_version_fence();
    let switch_transport = Arc::clone(&transport);
    let switch_handle = handle.clone();
    let switch_workspace = workspace_id.clone();
    let switching = tokio::spawn(async move {
        switch_to(
            &switch_transport,
            &switch_handle,
            &switch_workspace,
            &feature,
            3,
        )
        .await
    });
    bounded(
        "setActive capture-held pause",
        probe.wait_until_version_fence_paused(),
    )
    .await;

    // Queue the real driver on the capture gate while setActive owns it. A
    // session-first close would now hold session_ops and await this driver,
    // while setActive awaits session_ops: the review's deadlock triangle.
    probe.observe_next_apply_gate_wait();
    let flush_transport = Arc::clone(&transport);
    let flush_handle = handle.clone();
    let flushing = tokio::spawn(async move {
        flush_transport
            .call(
                RequestContext::unbounded(),
                request(4, "capture.flush", Some(flush_handle), json!({})),
            )
            .await
    });
    bounded(
        "capture driver queued on apply gate",
        probe.wait_until_apply_gate_waiting(),
    )
    .await;

    let close_transport = Arc::clone(&transport);
    let close_handle = handle.clone();
    let mut closing = tokio::spawn(async move {
        close_transport
            .call(
                RequestContext::unbounded(),
                request(5, "workspace.close", Some(close_handle), json!({})),
            )
            .await
    });
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(
        !closing.is_finished(),
        "close must queue behind the capture-first switch barrier"
    );

    probe.release_version_fence();
    bounded("setActive task", switching)
        .await
        .expect("switch task")
        .expect("switch");
    bounded("workspace.close task", &mut closing)
        .await
        .expect("close task")
        .expect("close");
    let _ = bounded("capture.flush task", flushing)
        .await
        .expect("flush task");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn create_named_preflight_keeps_live_session_for_invalid_and_replayed_requests() {
    // MUTATION: bypass the actor preflight -> every rejected/replayed request
    // increments the scan probe and closes the live session.
    let probe = CaptureApplyProbe::default();
    let service = EngineService::with_capture_apply_probe_for_harness(probe.clone());
    let (_scratch, transport, handle, workspace_id) = fixture("create-preflight", service).await;

    let existing = call_with_idempotency(
        &transport,
        &handle,
        2,
        "versions.createNamed",
        "create-preflight-key",
        json!({
            "workspaceId": workspace_id,
            "name": "existing",
            "fromVersionId": "main",
        }),
    )
    .await
    .expect("initial named version");
    let existing_id = existing["id"].clone();

    let opened = call(
        &transport,
        &handle,
        3,
        "ydoc.open",
        json!({
            "versionId": "main",
            "path": "notes.md",
            "contentKind": "plaintext",
        }),
    )
    .await;
    let session_id = opened["sessionId"].as_str().expect("session id").to_owned();
    let scans_before = probe.version_scan_count();

    let replay = call_with_idempotency(
        &transport,
        &handle,
        4,
        "versions.createNamed",
        "create-preflight-key",
        json!({
            "workspaceId": workspace_id,
            "name": "existing",
            "fromVersionId": "main",
        }),
    )
    .await
    .expect("exact replay");
    assert_eq!(replay["id"], existing_id);

    let mismatch = call_with_idempotency(
        &transport,
        &handle,
        5,
        "versions.createNamed",
        "create-preflight-key",
        json!({
            "workspaceId": workspace_id,
            "name": "different payload",
            "fromVersionId": "main",
        }),
    )
    .await
    .expect_err("idempotency mismatch");
    assert_eq!(mismatch.message, "idempotency-key-reuse-mismatch");

    let conflict = call_error(
        &transport,
        &handle,
        6,
        "versions.createNamed",
        json!({
            "workspaceId": workspace_id,
            "name": "existing",
            "fromVersionId": "main",
        }),
    )
    .await;
    assert_eq!(conflict.message, "version-name-conflict");

    let missing = call_error(
        &transport,
        &handle,
        7,
        "versions.createNamed",
        json!({
            "workspaceId": workspace_id,
            "name": "missing source",
            "fromVersionId": "does-not-exist",
        }),
    )
    .await;
    assert_eq!(missing.message, "version-not-found");
    assert_eq!(
        probe.version_scan_count(),
        scans_before,
        "preflight rejections and replays must not run the destructive scan"
    );

    let update = base64::engine::general_purpose::STANDARD
        .encode(Ydoc::wire().plaintext_insert(0, "session stayed live"));
    call(
        &transport,
        &handle,
        8,
        "ydoc.recordUpdate",
        json!({ "sessionId": session_id, "updateBase64": update }),
    )
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn queued_create_named_revalidates_before_sweeping_sessions() {
    // MUTATION: remove the fenced preflight -> the queued name conflict scans
    // and closes the session admitted after the winning create.
    let probe = CaptureApplyProbe::default();
    let service = EngineService::with_capture_apply_probe_for_harness(probe.clone());
    let (_scratch, transport, handle, workspace_id) = fixture("create-race", service).await;
    let scans_before = probe.version_scan_count();

    probe.pause_next_version_fence();
    let first_transport = Arc::clone(&transport);
    let first_handle = handle.clone();
    let first_workspace = workspace_id.clone();
    let first = tokio::spawn(async move {
        first_transport
            .call(
                RequestContext::unbounded(),
                request(
                    2,
                    "versions.createNamed",
                    Some(first_handle),
                    json!({
                        "workspaceId": first_workspace,
                        "name": "racing name",
                        "fromVersionId": "main",
                    }),
                ),
            )
            .await
    });
    bounded(
        "winning create capture-held pause",
        probe.wait_until_version_fence_paused(),
    )
    .await;

    probe.observe_next_version_fence_wait();
    probe.pause_next_version_fence();
    let second_transport = Arc::clone(&transport);
    let second_handle = handle.clone();
    let second_workspace = workspace_id.clone();
    let second = tokio::spawn(async move {
        second_transport
            .call(
                RequestContext::unbounded(),
                request(
                    3,
                    "versions.createNamed",
                    Some(second_handle),
                    json!({
                        "workspaceId": second_workspace,
                        "name": "racing name",
                        "fromVersionId": "main",
                    }),
                ),
            )
            .await
    });
    bounded(
        "losing create queued on fence",
        probe.wait_until_version_fence_waiting(),
    )
    .await;

    probe.release_version_fence();
    bounded("winning create task", first)
        .await
        .expect("winning create task")
        .expect("winning create");
    bounded(
        "losing create capture-held pause",
        probe.wait_until_version_fence_paused(),
    )
    .await;

    let opened = call(
        &transport,
        &handle,
        4,
        "ydoc.open",
        json!({
            "versionId": "main",
            "path": "notes.md",
            "contentKind": "plaintext",
        }),
    )
    .await;
    let session_id = opened["sessionId"].as_str().expect("session id").to_owned();
    let doc = Ydoc::wire();
    let first_update =
        base64::engine::general_purpose::STANDARD.encode(doc.plaintext_insert(0, "still open"));
    call(
        &transport,
        &handle,
        5,
        "ydoc.recordUpdate",
        json!({ "sessionId": session_id, "updateBase64": first_update }),
    )
    .await;
    let scans_after_winner = probe.version_scan_count();
    assert_eq!(scans_after_winner, scans_before + 1);

    probe.release_version_fence();
    let conflict = bounded("losing create task", second)
        .await
        .expect("losing create task")
        .expect_err("losing create must report the name conflict");
    assert_eq!(conflict.message, "version-name-conflict");
    assert_eq!(
        probe.version_scan_count(),
        scans_after_winner,
        "the fenced revalidation must reject before another scan"
    );

    let second_update =
        base64::engine::general_purpose::STANDARD.encode(doc.plaintext_insert(0, "session "));
    call(
        &transport,
        &handle,
        6,
        "ydoc.recordUpdate",
        json!({ "sessionId": session_id, "updateBase64": second_update }),
    )
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn create_named_fails_closed_before_touching_a_live_richdoc_session() {
    // MUTATION: remove the live-richdoc refusal -> createNamed succeeds with a
    // fork whose materialized snapshot omits the live CRDT edit.
    let probe = CaptureApplyProbe::default();
    let service = EngineService::with_capture_apply_probe_for_harness(probe.clone());
    let (_scratch, transport, handle, workspace_id) = fixture("richdoc-fork", service).await;

    let opened = call(
        &transport,
        &handle,
        2,
        "ydoc.open",
        json!({
            "versionId": "main",
            "path": "notes.md",
            "contentKind": "richdoc",
        }),
    )
    .await;
    let session_id = opened["sessionId"].as_str().expect("session id").to_owned();
    let doc = Ydoc::wire();
    let first = base64::engine::general_purpose::STANDARD
        .encode(doc.richdoc_append_paragraph("live richdoc edit"));
    call(
        &transport,
        &handle,
        3,
        "ydoc.recordUpdate",
        json!({ "sessionId": session_id, "updateBase64": first }),
    )
    .await;
    let scans_before = probe.version_scan_count();

    let refused = call_error(
        &transport,
        &handle,
        4,
        "versions.createNamed",
        json!({
            "workspaceId": workspace_id,
            "name": "must not be stale",
            "fromVersionId": "main",
        }),
    )
    .await;
    assert_eq!(refused.message, "richdoc-settle-unsupported");
    assert_eq!(
        probe.version_scan_count(),
        scans_before,
        "the richdoc refusal must happen before the full scan"
    );

    let second = base64::engine::general_purpose::STANDARD
        .encode(doc.richdoc_append_paragraph("session remains live"));
    call(
        &transport,
        &handle,
        5,
        "ydoc.recordUpdate",
        json!({ "sessionId": session_id, "updateBase64": second }),
    )
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn create_named_fails_closed_for_a_normally_closed_unsettled_richdoc() {
    // MUTATION: remove the durable richdoc preflight (or consult only the live
    // session map) -> normal close removes the session and this stale fork
    // succeeds even though its snapshot omits the persisted CRDT edit.
    let probe = CaptureApplyProbe::default();
    let service = EngineService::with_capture_apply_probe_for_harness(probe.clone());
    let (_scratch, transport, handle, workspace_id) = fixture("closed-richdoc-fork", service).await;

    let opened = call(
        &transport,
        &handle,
        2,
        "ydoc.open",
        json!({
            "versionId": "main",
            "path": "notes.md",
            "contentKind": "richdoc",
        }),
    )
    .await;
    let session_id = opened["sessionId"].as_str().expect("session id").to_owned();
    let update = base64::engine::general_purpose::STANDARD
        .encode(Ydoc::wire().richdoc_append_paragraph("persisted but not materialized"));
    call(
        &transport,
        &handle,
        3,
        "ydoc.recordUpdate",
        json!({ "sessionId": session_id, "updateBase64": update }),
    )
    .await;
    call(
        &transport,
        &handle,
        4,
        "ydoc.close",
        json!({ "sessionId": session_id }),
    )
    .await;
    let scans_before = probe.version_scan_count();

    let refused = call_error(
        &transport,
        &handle,
        5,
        "versions.createNamed",
        json!({
            "workspaceId": workspace_id,
            "name": "closed richdoc must not fork stale",
            "fromVersionId": "main",
        }),
    )
    .await;
    assert_eq!(refused.message, "richdoc-settle-unsupported");
    assert_eq!(
        probe.version_scan_count(),
        scans_before,
        "the persisted richdoc refusal must happen before the full scan"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn create_named_fails_closed_for_a_persisted_unsettled_plaintext_lineage() {
    // MUTATION: restore `docs.content_kind = 'richdoc'` in the persisted-state
    // query -> the fork succeeds from the stale main snapshot.
    let probe = CaptureApplyProbe::default();
    let service = EngineService::with_capture_apply_probe_for_harness(probe.clone());
    let (_scratch, transport, handle, workspace_id) =
        fixture("closed-plaintext-fork", service).await;
    let opened = call(
        &transport,
        &handle,
        2,
        "ydoc.open",
        json!({
            "versionId": "main",
            "path": "notes.md",
            "contentKind": "plaintext",
        }),
    )
    .await;
    let session_id = opened["sessionId"].as_str().expect("session id").to_owned();
    let object_id = opened["objectId"].as_str().expect("object id").to_owned();
    call(
        &transport,
        &handle,
        3,
        "ydoc.close",
        json!({ "sessionId": session_id, "settle": false }),
    )
    .await;

    let update = base64::engine::general_purpose::STANDARD
        .encode(Ydoc::wire().plaintext_insert(0, "persisted but not materialized"));
    call(
        &transport,
        &handle,
        4,
        "ydoc.apply",
        json!({
            "versionId": "main",
            "objectId": object_id,
            "contentKind": "plaintext",
            "updateBase64": update,
        }),
    )
    .await;
    let reopened = call(
        &transport,
        &handle,
        5,
        "ydoc.open",
        json!({
            "versionId": "main",
            "path": "notes.md",
            "contentKind": "plaintext",
        }),
    )
    .await;
    let reopened_session = reopened["sessionId"]
        .as_str()
        .expect("reopened session id")
        .to_owned();
    call(
        &transport,
        &handle,
        6,
        "ydoc.close",
        json!({ "sessionId": reopened_session, "settle": false }),
    )
    .await;
    let healthy = call(
        &transport,
        &handle,
        7,
        "ydoc.open",
        json!({
            "versionId": "main",
            "path": "healthy.md",
            "contentKind": "plaintext",
        }),
    )
    .await;
    let healthy_session = healthy["sessionId"]
        .as_str()
        .expect("healthy session id")
        .to_owned();
    let scans_before = probe.version_scan_count();

    let refused = call_error(
        &transport,
        &handle,
        8,
        "versions.createNamed",
        json!({
            "workspaceId": workspace_id,
            "name": "closed plaintext must not fork stale",
            "fromVersionId": "main",
        }),
    )
    .await;
    assert_eq!(refused.message, "ydoc-unsettled-close");
    assert_eq!(
        probe.version_scan_count(),
        scans_before,
        "persisted plaintext refusal must happen before the full scan"
    );
    let update =
        base64::engine::general_purpose::STANDARD.encode(Ydoc::wire().plaintext_insert(0, "live"));
    call(
        &transport,
        &handle,
        9,
        "ydoc.recordUpdate",
        json!({ "sessionId": healthy_session, "updateBase64": update }),
    )
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn queued_same_target_set_active_rechecks_before_sweep_or_scan() {
    // MUTATION: remove the active-version recheck inside the fence -> the
    // second request increments the scan probe and closes the admitted session.
    let probe = CaptureApplyProbe::default();
    let service = EngineService::with_capture_apply_probe_for_harness(probe.clone());
    let (_scratch, transport, handle, workspace_id) = fixture("same-target", service).await;
    let feature = create_feature(&transport, &handle, &workspace_id, 2).await;
    let scans_before_switches = probe.version_scan_count();

    probe.pause_next_version_fence();
    let first_transport = Arc::clone(&transport);
    let first_handle = handle.clone();
    let first_workspace = workspace_id.clone();
    let first_feature = feature.clone();
    let first = tokio::spawn(async move {
        switch_to(
            &first_transport,
            &first_handle,
            &first_workspace,
            &first_feature,
            3,
        )
        .await
    });
    bounded(
        "first setActive capture-held pause",
        probe.wait_until_version_fence_paused(),
    )
    .await;

    probe.observe_next_version_fence_wait();
    probe.pause_next_version_fence();
    let second_transport = Arc::clone(&transport);
    let second_handle = handle.clone();
    let second_workspace = workspace_id.clone();
    let second_feature = feature.clone();
    let second = tokio::spawn(async move {
        switch_to(
            &second_transport,
            &second_handle,
            &second_workspace,
            &second_feature,
            4,
        )
        .await
    });
    bounded(
        "second setActive queued on fence",
        probe.wait_until_version_fence_waiting(),
    )
    .await;

    probe.release_version_fence();
    bounded("first setActive task", first)
        .await
        .expect("first switch task")
        .expect("first switch");
    bounded(
        "second setActive capture-held pause",
        probe.wait_until_version_fence_paused(),
    )
    .await;

    let opened = call(
        &transport,
        &handle,
        5,
        "ydoc.open",
        json!({
            "versionId": feature,
            "path": "notes.md",
            "contentKind": "plaintext",
        }),
    )
    .await;
    let session_id = opened["sessionId"].as_str().expect("session id").to_owned();
    let doc = Ydoc::wire();
    let first_update = base64::engine::general_purpose::STANDARD
        .encode(doc.plaintext_insert(0, "admitted between switches"));
    call(
        &transport,
        &handle,
        6,
        "ydoc.recordUpdate",
        json!({ "sessionId": session_id, "updateBase64": first_update }),
    )
    .await;
    let scans_after_first = probe.version_scan_count();
    assert_eq!(scans_after_first, scans_before_switches + 1);

    probe.release_version_fence();
    bounded("second setActive task", second)
        .await
        .expect("second switch task")
        .expect("second switch");
    assert_eq!(
        probe.version_scan_count(),
        scans_after_first,
        "the fenced same-target recheck must skip the full scan"
    );

    let second_update =
        base64::engine::general_purpose::STANDARD.encode(doc.plaintext_insert(0, "still live: "));
    call(
        &transport,
        &handle,
        7,
        "ydoc.recordUpdate",
        json!({ "sessionId": session_id, "updateBase64": second_update }),
    )
    .await;
}
