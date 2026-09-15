mod common;

use common::*;
use dohc_engine_protocol::{
    transport::{EngineTransport, InProcessTransport, RequestContext},
    wire::WorkspaceHandle,
};
use dohc_engine_testkit::ScratchDir;
use dohc_workspace_engine::EngineService;
use serde_json::json;
use std::sync::Arc;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn source_capture_pins_selected_text_and_binary_and_rejects_read_only_attachment() {
    let scratch = ScratchDir::new().expect("scratch");
    write_file(scratch.path(), "src/index.js", b"export default 1;");
    write_file(
        scratch.path(),
        "icon.png",
        &[0x89, 0x50, 0x4e, 0x47, 0, 0xff],
    );
    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let open_params =
        json!({"rootDir": scratch.path().to_string_lossy(), "workspaceId": "ws-source"});
    let opened = transport
        .call(
            RequestContext::unbounded(),
            request(1, "workspace.open", None, open_params.clone()),
        )
        .await
        .expect("open");
    let handle: WorkspaceHandle =
        serde_json::from_value(opened.result["workspace"].clone()).expect("handle");
    reconcile_until_settled(&transport, &handle, 100).await;
    let params = json!({"versionId":"main", "paths":["src/index.js", "icon.png"], "bounds":{"maxInputFiles":2,"maxInputBytes":1024}});
    let captured = call(
        &transport,
        &handle,
        2,
        "versionedText.captureSources",
        params.clone(),
    )
    .await;
    assert_eq!(captured["workspaceId"], "ws-source");
    assert_eq!(captured["files"][0]["path"], "icon.png");
    assert_eq!(captured["files"][0]["contentKind"], "binary");
    assert_eq!(captured["files"][1]["contentKind"], "text");
    assert_eq!(captured["totalBytes"], 23);
    assert_eq!(captured["sourceDigest"].as_str().expect("digest").len(), 64);
    let mut reversed = params.clone();
    reversed["paths"] = json!(["icon.png", "src/index.js"]);
    assert_eq!(
        call(
            &transport,
            &handle,
            3,
            "versionedText.captureSources",
            reversed
        )
        .await,
        captured
    );
    let mut oversized = params.clone();
    oversized["bounds"]["maxInputBytes"] = json!(1);
    call_error(
        &transport,
        &handle,
        4,
        "versionedText.captureSources",
        oversized,
    )
    .await;
    let mut missing = params.clone();
    missing["paths"] = json!(["absent.js"]);
    call_error(
        &transport,
        &handle,
        5,
        "versionedText.captureSources",
        missing,
    )
    .await;
    let mut attach_params = open_params;
    attach_params["skipStartupMaintenance"] = json!(true);
    let attached = transport
        .call(
            RequestContext::unbounded(),
            request(6, "workspace.open", None, attach_params),
        )
        .await
        .expect("attach");
    let attached_handle: WorkspaceHandle =
        serde_json::from_value(attached.result["workspace"].clone()).expect("attached handle");
    let error = call_error(
        &transport,
        &attached_handle,
        7,
        "versionedText.captureSources",
        params,
    )
    .await;
    assert!(error.message.contains("read-only workspace handle"));
    call(
        &transport,
        &attached_handle,
        8,
        "workspace.close",
        json!({}),
    )
    .await;
    call(&transport, &handle, 9, "workspace.close", json!({})).await;
}
