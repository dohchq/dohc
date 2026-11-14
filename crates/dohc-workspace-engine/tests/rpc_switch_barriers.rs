use crate::common;

use base64::Engine as _;
use common::*;
use dohc_engine_collab::Ydoc;
use dohc_engine_protocol::{
    error::ErrorCode,
    transport::{EngineTransport, InProcessTransport, RequestContext},
    wire::WorkspaceHandle,
};
use dohc_engine_testkit::ScratchDir;
use dohc_workspace_engine::{CaptureApplyProbe, EngineService};
use serde_json::{Value, json};
use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

const TEST_TIMEOUT: Duration = Duration::from_secs(15);

async fn bounded<T>(what: &str, future: impl Future<Output = T>) -> T {
    tokio::time::timeout(TEST_TIMEOUT, future)
        .await
        .unwrap_or_else(|_| panic!("{what} timed out"))
}

async fn wait_until_capture_ready(
    transport: &InProcessTransport<EngineService>,
    handle: &WorkspaceHandle,
    mut id: u64,
) {
    let deadline = tokio::time::Instant::now() + TEST_TIMEOUT;
    loop {
        let status = call_with_busy_retry(
            transport,
            RequestContext::unbounded(),
            request(id, "watcher.status", Some(handle.clone()), json!({})),
        )
        .await
        .expect("watcher.status");
        id += 1;
        if status.result["phase"] == json!("ready") {
            return;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "startup capture never became ready: {}",
            status.result
        );
        tokio::task::yield_now().await;
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
    std::fs::write(scratch.path().join("notes.md"), "main base").expect("seed disk");
    let workspace_id = format!("ws-switch-barrier-{name}");
    let transport = Arc::new(InProcessTransport::new(Arc::new(service)));
    let opened = bounded(
        "workspace.open",
        call_with_busy_retry(
            &transport,
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
    wait_until_capture_ready(&transport, &handle, 1_000_000).await;
    (scratch, transport, handle, workspace_id)
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
        call_with_busy_retry(
            transport,
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
        call_with_busy_retry(
            transport,
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
    bounded(
        method,
        call_with_busy_retry(transport, RequestContext::unbounded(), request),
    )
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
        call_with_busy_retry(
            transport,
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
        json!({ "expectedLineageClaimId": null, "sessionId": session_id, "updateBase64": update }),
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
    std::fs::set_permissions(&unreadable, std::fs::Permissions::from_mode(0o000))
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
async fn cancelled_set_active_keeps_the_owned_fence_until_the_switch_finishes() {
    let probe = CaptureApplyProbe::default();
    let service = EngineService::with_capture_apply_probe_for_harness(probe.clone());
    let (_scratch, transport, handle, workspace_id) = fixture("cancel-owned", service).await;
    let feature = create_feature(&transport, &handle, &workspace_id, 2).await;

    call(&transport, &handle, 100, "capture.flush", json!({})).await;
    probe.pause_next_version_fence();
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
        "setActive capture-held pause",
        probe.wait_until_version_fence_paused(),
    )
    .await;
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
        "driver waiting before commit pause",
        probe.wait_until_apply_gate_waiting(),
    )
    .await;
    probe.release_version_fence();
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

    // The driver reached the gate before this wait, while the switch was paused.
    bounded(
        "driver still waiting behind detached fence",
        probe.wait_until_apply_gate_waiting(),
    )
    .await;
    assert!(
        tokio::time::timeout(Duration::from_millis(100), &mut flushing)
            .await
            .is_err(),
        "capture must remain fenced after the request future is cancelled"
    );
    assert!(probe.is_apply_gate_waiting(), "driver must still be fenced");

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
        json!({ "expectedLineageClaimId": null, "sessionId": session_id, "updateBase64": update }),
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
async fn create_named_preflight_keeps_live_session_for_invalid_and_replayed_requests() {
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
        json!({ "expectedLineageClaimId": null, "sessionId": session_id, "updateBase64": update }),
    )
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn create_named_fails_closed_for_a_persisted_unsettled_plaintext_lineage() {
    let probe = CaptureApplyProbe::default();
    let service = EngineService::with_capture_apply_probe_for_harness(probe.clone());
    let (scratch, transport, handle, workspace_id) =
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
    let update = base64::engine::general_purpose::STANDARD
        .encode(Ydoc::wire().plaintext_insert(0, "persisted but not materialized"));
    call(
        &transport,
        &handle,
        3,
        "ydoc.recordUpdate",
        json!({ "expectedLineageClaimId": null, "sessionId": session_id, "updateBase64": update }),
    )
    .await;
    call(&transport, &handle, 4, "workspace.close", json!({})).await;
    let reopened = bounded(
        "workspace reopen",
        call_with_busy_retry(
            &transport,
            RequestContext::unbounded(),
            request(
                5,
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
    .expect("workspace reopen");
    let handle: WorkspaceHandle =
        serde_json::from_value(reopened.result["workspace"].clone()).expect("workspace handle");
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
        json!({ "expectedLineageClaimId": null, "sessionId": healthy_session, "updateBase64": update }),
    )
    .await;
}
