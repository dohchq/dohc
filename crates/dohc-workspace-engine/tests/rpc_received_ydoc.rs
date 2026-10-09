mod common;

use base64::Engine as _;
use common::*;
use dohc_engine_collab::Ydoc;
use dohc_engine_protocol::{
    error::ErrorCode,
    transport::{EngineTransport, InProcessTransport, RequestContext},
    wire::WorkspaceHandle,
};
use dohc_engine_testkit::ScratchDir;
use dohc_workspace_engine::EngineService;
use serde_json::{Value, json};
use std::sync::Arc;

async fn open(
    transport: &InProcessTransport<EngineService>,
    scratch: &ScratchDir,
    received: bool,
) -> WorkspaceHandle {
    let response = transport
        .call(
            RequestContext::unbounded(),
            request(
                1,
                "workspace.open",
                None,
                json!({
                    "rootDir": scratch.path().to_string_lossy(),
                    "workspaceId": if received { "received" } else { "owned" },
                    "captureMode": "none",
                    "projectCollections": received,
                }),
            ),
        )
        .await
        .expect("open handle");
    serde_json::from_value(response.result["workspace"].clone()).unwrap()
}

async fn received_ydoc_method(method: &str) {
    let workspace = ScratchDir::new().unwrap();
    let received = ScratchDir::new().unwrap();
    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let workspace_handle = open(&transport, &workspace, false).await;
    let received_handle = open(&transport, &received, true).await;
    let open_params = json!({ "versionId": "main", "path": "note.md", "contentKind": "richdoc" });
    let context = || RequestContext::unbounded().with_capability("blobs");
    let session = transport
        .call(
            context(),
            request(
                2,
                "ydoc.open",
                Some(workspace_handle.clone()),
                open_params.clone(),
            ),
        )
        .await
        .expect("workspace live session");
    let session_id = session.result["sessionId"].clone();
    call(
        &transport,
        &workspace_handle,
        20,
        "ydoc.recordUpdate",
        json!({
            "sessionId": session_id,
            "updateBase64": base64::engine::general_purpose::STANDARD
                .encode(Ydoc::wire().richdoc_append_paragraph("Workspace body.")),
        }),
    )
    .await;
    let params = match method {
        "ydoc.open" => open_params,
        "ydoc.recordUpdate" => json!({
            "sessionId": session_id,
            "updateBase64": base64::engine::general_purpose::STANDARD
                .encode(Ydoc::wire().richdoc_append_paragraph("Shared guard test.")),
        }),
        _ => json!({ "sessionId": session_id }),
    };
    let received_result = transport
        .call(
            context(),
            request(3, method, Some(received_handle.clone()), params.clone()),
        )
        .await;

    // Open uses another path because the first workspace session already leases note.md.
    let workspace_params = if method == "ydoc.open" {
        json!({ "versionId": "main", "path": "other.md", "contentKind": "richdoc" })
    } else {
        params
    };
    transport
        .call(
            context(),
            request(4, method, Some(workspace_handle.clone()), workspace_params),
        )
        .await
        .unwrap_or_else(|error| panic!("{method} must still work on a workspace: {error:?}"));
    call(
        &transport,
        &workspace_handle,
        5,
        "workspace.close",
        json!({}),
    )
    .await;
    call(
        &transport,
        &received_handle,
        6,
        "workspace.close",
        json!({}),
    )
    .await;
    let error =
        received_result.expect_err("received share must refuse the method before session lookup");
    assert_eq!(error.code, ErrorCode::Forbidden, "{method}");
    assert_eq!(
        error.message, "received shares do not open live document sessions",
        "{method}"
    );
}

macro_rules! received_ydoc_test {
    ($name:ident, $method:literal) => {
        #[tokio::test]
        async fn $name() {
            received_ydoc_method($method).await;
        }
    };
}

received_ydoc_test!(received_ydoc_open, "ydoc.open");
received_ydoc_test!(received_ydoc_record_update, "ydoc.recordUpdate");
received_ydoc_test!(received_ydoc_resync, "ydoc.resync");
received_ydoc_test!(
    received_ydoc_adopt_collection_record,
    "ydoc.adoptCollectionRecord"
);
received_ydoc_test!(received_ydoc_settle, "ydoc.settle");
received_ydoc_test!(received_ydoc_close, "ydoc.close");
received_ydoc_test!(received_ydoc_evict, "ydoc.evict");

#[tokio::test]
async fn received_ydoc_guard_keeps_snapshot_reads() {
    let scratch = ScratchDir::new().unwrap();
    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let handle = open(&transport, &scratch, true).await;
    call(
        &transport,
        &handle,
        2,
        "versionedText.write",
        json!({
            "versionId": "main", "path": "note.md", "text": "Shared snapshot.\n", "origin": "api",
        }),
    )
    .await;
    let snapshot: Value = call(
        &transport,
        &handle,
        3,
        "versionedText.read",
        json!({
            "versionId": "main", "path": "note.md",
        }),
    )
    .await;
    assert_eq!(snapshot["text"], "Shared snapshot.\n");
    call(&transport, &handle, 4, "workspace.close", json!({})).await;
}
