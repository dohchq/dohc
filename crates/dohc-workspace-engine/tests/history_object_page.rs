mod common;

use common::*;
use dohc_engine_protocol::{
    ErrorCode,
    transport::{EngineTransport, InProcessTransport, RequestContext},
    wire::WorkspaceHandle,
};
use dohc_engine_testkit::ScratchDir;
use dohc_workspace_engine::{CaptureApplyProbe, EngineService, root_binding::write_root_binding};
use serde_json::{Value, json};
use std::{future::Future, sync::Arc, task::Poll};

async fn open(scratch: &ScratchDir) -> (InProcessTransport<EngineService>, WorkspaceHandle) {
    write_root_binding(scratch.path(), TOKEN).expect("root binding");
    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let opened = call_with_busy_retry(
        &transport,
        RequestContext::unbounded(),
        request(
            1,
            "workspace.open",
            None,
            json!({"rootDir": scratch.path().to_string_lossy(), "workspaceId": "history-object"}),
        ),
    )
    .await
    .expect("open");
    let handle = serde_json::from_value(opened.result["workspace"].clone()).expect("handle");
    (transport, handle)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn history_object_page_preserves_identity_paging_and_active_version() {
    let scratch = ScratchDir::new().expect("scratch");
    let (transport, handle) = open(&scratch).await;
    call(
        &transport,
        &handle,
        2,
        "versions.ensureMain",
        json!({"workspaceId": "history-object"}),
    )
    .await;
    let first = call(&transport, &handle, 3, "versionedText.write", json!({"versionId": "main", "path": "old.md", "text": "first", "origin": "api", "momentId": "first", "objectId": "stable-object"})).await;
    let object_id = first["object"]["id"].as_str().expect("object id");
    call(&transport, &handle, 4, "versionedText.write", json!({"versionId": "main", "path": "other.md", "text": "other", "origin": "api", "momentId": "other"})).await;
    call_keyed(
        &transport,
        &handle,
        5,
        "versionedText.rename",
        "rename",
        json!({"versionId": "main", "fromPath": "old.md", "toPath": "new.md", "origin": "api"}),
    )
    .await;
    call(&transport, &handle, 6, "secrets.write", json!({"workspaceId": "history-object", "versionId": "main", "path": ".env", "text": "KEY=secret", "origin": "api", "momentId": "secret"})).await;
    let first_page = call(
        &transport,
        &handle,
        7,
        "history.page",
        json!({"workspaceId": "history-object", "objectId": object_id, "limit": 1}),
    )
    .await;
    assert_eq!(first_page["activeVersion"]["id"], "main");
    assert_eq!(first_page["moments"][0]["operation"], "rename");
    assert_eq!(first_page["moments"][0]["path"], "new.md");
    assert_eq!(first_page["protectedMoments"], json!([]));
    assert_eq!(first_page["versionMarkers"], json!([]));
    let second_page = call(&transport, &handle, 8, "history.page", json!({"workspaceId": "history-object", "objectId": object_id, "limit": 1, "cursor": first_page["nextCursor"]})).await;
    assert_eq!(second_page["moments"].as_array().unwrap().len(), 1);
    assert_eq!(second_page["moments"][0]["momentId"], "first");
    assert_eq!(second_page["nextCursor"], Value::Null);
    assert_eq!(
        second_page["latestMomentOrder"],
        first_page["latestMomentOrder"]
    );
    let missing = call(
        &transport,
        &handle,
        9,
        "history.page",
        json!({"workspaceId": "history-object", "objectId": "not-imported"}),
    )
    .await;
    assert_eq!(missing["moments"], json!([]));
    assert_eq!(missing["latestMomentOrder"], -1);
    assert_eq!(missing["protectedMoments"], json!([]));
    let workspace = call(
        &transport,
        &handle,
        10,
        "history.page",
        json!({"workspaceId": "history-object"}),
    )
    .await;
    assert_eq!(workspace["moments"].as_array().unwrap().len(), 3);
    assert_eq!(workspace["protectedMoments"].as_array().unwrap().len(), 1);
    let branch = call(
        &transport,
        &handle,
        11,
        "versions.createNamed",
        json!({"workspaceId": "history-object", "name": "Draft", "fromVersionId": "main"}),
    )
    .await;
    call(&transport, &handle, 12, "versionedText.write", json!({"versionId": branch["id"], "path": "new.md", "text": "branch only", "origin": "api", "momentId": "branch-only"})).await;
    let active = call(
        &transport,
        &handle,
        13,
        "history.page",
        json!({"workspaceId": "history-object", "objectId": object_id}),
    )
    .await;
    assert_eq!(active["moments"].as_array().unwrap().len(), 2);
    let empty = call_error(
        &transport,
        &handle,
        14,
        "history.page",
        json!({"workspaceId": "history-object", "objectId": ""}),
    )
    .await;
    assert_eq!(empty.code, ErrorCode::InvalidParams);
    let wrong_workspace = call_error(
        &transport,
        &handle,
        15,
        "history.page",
        json!({"workspaceId": "other", "objectId": object_id}),
    )
    .await;
    assert_eq!(wrong_workspace.code, ErrorCode::InvalidParams);
    call(&transport, &handle, 16, "workspace.close", json!({})).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn history_object_page_includes_the_latest_external_save() {
    let scratch = ScratchDir::new().expect("scratch");
    write_file(scratch.path(), "saved.md", b"before");
    write_root_binding(scratch.path(), TOKEN).expect("root binding");
    let probe = CaptureApplyProbe::default();
    let transport = InProcessTransport::new(Arc::new(
        EngineService::with_capture_apply_probe_for_harness(probe.clone()),
    ));
    let opened = call_with_busy_retry(
        &transport,
        RequestContext::unbounded(),
        request(
            1,
            "workspace.open",
            None,
            json!({"rootDir": scratch.path().to_string_lossy(), "workspaceId": "history-object"}),
        ),
    )
    .await
    .expect("open");
    let handle: WorkspaceHandle =
        serde_json::from_value(opened.result["workspace"].clone()).expect("handle");
    let initial = call(
        &transport,
        &handle,
        2,
        "history.page",
        json!({"workspaceId": "history-object"}),
    )
    .await;
    let object_id = initial["moments"][0]["objectId"]
        .as_str()
        .expect("captured object");
    probe.pause_next_apply();
    write_file(scratch.path(), "saved.md", b"latest save");
    tokio::time::timeout(
        std::time::Duration::from_secs(20),
        probe.wait_until_paused(),
    )
    .await
    .expect("watcher admits the pending save");
    // Start History while the admitted save is paused before its actor write.
    let mut history = std::pin::pin!(transport.call(
        RequestContext::unbounded(),
        request(
            3,
            "history.page",
            Some(handle.clone()),
            json!({"workspaceId": "history-object", "objectId": object_id})
        )
    ));
    std::future::poll_fn(|cx| {
        assert!(history.as_mut().poll(cx).is_pending());
        Poll::Ready(())
    })
    .await;
    // An actor read behind that request sees the old body. History must still
    // wait for capture instead of returning the same stale page.
    let pending = call(
        &transport,
        &handle,
        30,
        "moments.list",
        json!({"versionId": "main", "objectId": object_id}),
    )
    .await;
    assert_eq!(pending["moments"][0]["afterText"], "before");
    let waited = std::future::poll_fn(|cx| {
        let outcome = history.as_mut().poll(cx);
        Poll::Ready(outcome.is_pending())
    })
    .await;
    probe.release();
    assert!(waited, "History answered before the latest save settled");
    let saved = history.await.expect("History after save settles").result;
    assert!(saved["moments"][0].get("afterText").is_none());
    let detail = call(
        &transport,
        &handle,
        5,
        "moments.get",
        json!({"momentId":saved["moments"][0]["momentId"]}),
    )
    .await;
    assert_eq!(detail["afterText"], "latest save");
    assert_eq!(saved["moments"][0]["objectId"], object_id);
    assert_eq!(saved["protectedMoments"], json!([]));
    call(&transport, &handle, 4, "workspace.close", json!({})).await;
}
