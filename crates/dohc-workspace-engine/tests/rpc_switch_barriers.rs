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
use std::sync::Arc;
use std::time::Duration;

const TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

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
    let opened = transport
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
        .expect("open");
    let handle = serde_json::from_value(opened.result["workspace"].clone()).expect("handle");
    (scratch, transport, handle, workspace_id)
}

async fn call(
    transport: &InProcessTransport<EngineService>,
    handle: &WorkspaceHandle,
    id: u64,
    method: &str,
    params: Value,
) -> Value {
    transport
        .call(
            RequestContext::unbounded(),
            request(id, method, Some(handle.clone()), params),
        )
        .await
        .unwrap_or_else(|error| panic!("{method}: {error:?}"))
        .result
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
    transport
        .call(
            RequestContext::unbounded(),
            request(
                id,
                "versions.setActive",
                Some(handle.clone()),
                json!({ "workspaceId": workspace_id, "versionId": version_id }),
            ),
        )
        .await
        .map(|response| response.result)
}

async fn read_text(
    transport: &InProcessTransport<EngineService>,
    handle: &WorkspaceHandle,
    version_id: &str,
    id: u64,
) -> Option<String> {
    let value = call(
        transport,
        handle,
        id,
        "versionedText.read",
        json!({ "versionId": version_id, "path": "notes.md" }),
    )
    .await;
    value["text"].as_str().map(str::to_owned)
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
        read_text(&transport, &handle, &feature, 7).await.as_deref(),
        Some("live feature edit"),
        "the forced settle must target the version being left"
    );
    assert_eq!(
        read_text(&transport, &handle, "main", 8).await.as_deref(),
        Some("main base"),
        "the old session must not cross into the destination"
    );
    assert_eq!(
        std::fs::read_to_string(scratch.path().join("notes.md")).expect("main projection"),
        "main base"
    );
    let closed = transport
        .call(
            RequestContext::unbounded(),
            request(
                9,
                "ydoc.settle",
                Some(handle.clone()),
                json!({ "sessionId": session_id }),
            ),
        )
        .await
        .expect_err("switch must close the old session");
    assert_eq!(closed.code, ErrorCode::InvalidParams);
    assert_eq!(closed.message, "ydoc-session-not-found");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn set_active_full_scans_even_when_watcher_dirty_bit_is_still_unset() {
    let (scratch, transport, handle, workspace_id) =
        fixture("full-scan", EngineService::new()).await;
    let feature = create_feature(&transport, &handle, &workspace_id, 2).await;

    // Deliberately switch inside the watcher's settle window. The edit is a
    // real disk write, but reconcile_if_dirty still sees no dirty generation.
    std::fs::write(scratch.path().join("notes.md"), "unannounced disk edit")
        .expect("external edit");
    switch_to(&transport, &handle, &workspace_id, &feature, 3)
        .await
        .expect("switch");

    assert_eq!(
        read_text(&transport, &handle, "main", 4).await.as_deref(),
        Some("unannounced disk edit"),
        "the pre-switch full scan captures the edit into the version being left"
    );
    assert_eq!(
        read_text(&transport, &handle, &feature, 5).await.as_deref(),
        Some("main base")
    );
}

#[cfg(windows)]
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn set_active_fails_closed_when_the_forced_scan_is_degraded() {
    use std::io::Write as _;
    use std::os::windows::fs::OpenOptionsExt as _;

    let (scratch, transport, handle, workspace_id) =
        fixture("degraded", EngineService::new()).await;
    let feature = create_feature(&transport, &handle, &workspace_id, 2).await;
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
    assert_eq!(error.message, "pre-switch-scan-degraded");
    let active = call(
        &transport,
        &handle,
        4,
        "versions.active",
        json!({ "workspaceId": workspace_id }),
    )
    .await;
    assert_eq!(active["id"], json!("main"));
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
    probe.wait_until_paused().await;

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
    flush.await.expect("flush task");
    switch
        .await
        .expect("switch task")
        .expect("switch after drain");
    assert_eq!(
        read_text(&transport, &handle, "main", 5).await.as_deref(),
        Some("apply already planned")
    );
    assert_eq!(
        read_text(&transport, &handle, &feature, 6).await.as_deref(),
        Some("main base"),
        "the in-flight apply must not resolve its destination after the switch"
    );
}
