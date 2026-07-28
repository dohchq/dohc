use std::sync::Arc;

use dohc_engine_protocol::{
    error::ErrorCode,
    transport::{EngineTransport, InProcessTransport, RequestContext},
    wire::{Request, WorkspaceHandle},
};
use dohc_engine_testkit::ScratchDir;
use dohc_workspace_engine::{EngineService, shadow_fence::write_shadow_marker_for_harness};
use serde_json::{Value, json};

const TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const WORKSPACE_ID: &str = "cli-read-attach";

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

async fn open(
    transport: &InProcessTransport<EngineService>,
    scratch: &ScratchDir,
    id: u64,
    workspace_id: &str,
    params: Value,
) -> Result<WorkspaceHandle, dohc_engine_protocol::error::WireError> {
    let mut open_params = json!({
        "rootDir": scratch.path().to_string_lossy(),
        "workspaceId": workspace_id,
    });
    open_params
        .as_object_mut()
        .expect("open params")
        .extend(params.as_object().expect("extra open params").clone());
    transport
        .call(
            RequestContext::unbounded(),
            request(id, "workspace.open", None, open_params),
        )
        .await
        .map(|response| {
            serde_json::from_value(response.result["workspace"].clone()).expect("workspace handle")
        })
}

async fn call(
    transport: &InProcessTransport<EngineService>,
    handle: &WorkspaceHandle,
    id: u64,
    method: &str,
) -> Value {
    transport
        .call(
            RequestContext::unbounded(),
            request(id, method, Some(handle.clone()), json!({})),
        )
        .await
        .unwrap_or_else(|error| panic!("{method} failed: {error:?}"))
        .result
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn cli_read_attaches_to_full_relay_binding_and_close_preserves_owner() {
    let scratch = ScratchDir::new().expect("scratch");
    write_shadow_marker_for_harness(scratch.path(), TOKEN).expect("shadow marker");
    let transport = InProcessTransport::new(Arc::new(EngineService::new()));

    let desktop = open(
        &transport,
        &scratch,
        1,
        WORKSPACE_ID,
        json!({
            "relay": {
                "baseUrl": "http://127.0.0.1:9",
                "bearerToken": "desktop-relay-token",
                "allowInsecureLoopbackForTests": true,
            },
        }),
    )
    .await
    .expect("desktop full+relay open");
    let cli = open(
        &transport,
        &scratch,
        2,
        WORKSPACE_ID,
        json!({
            "recoverRunningDispatches": false,
            "skipStartupMaintenance": true,
        }),
    )
    .await
    .expect("CLI read attach");
    assert_ne!(cli, desktop, "read intent must receive a non-owning token");

    let unread = call(&transport, &cli, 3, "chats.readState.listUnreadFileThreads").await;
    assert_eq!(unread, json!([]));

    let attached_close = call(&transport, &cli, 4, "workspace.close").await;
    // MUTATION: routing attached close through owner teardown makes this fail.
    let flushed = call(&transport, &desktop, 5, "capture.flush").await;
    assert_eq!(flushed["settled"], json!(true));
    assert_eq!(
        attached_close,
        json!({ "closed": false, "attachmentClosed": true })
    );
    let owner_close = call(&transport, &desktop, 6, "workspace.close").await;
    assert_eq!(owner_close["closed"], json!(true));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn read_attach_respects_the_open_handle_cap() {
    // MUTATION: insert the attachment without the MAX_OPEN_HANDLES check and
    // this loop mints handles far past the cap instead of refusing.
    let scratch = ScratchDir::new().expect("scratch");
    write_shadow_marker_for_harness(scratch.path(), TOKEN).expect("shadow marker");
    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let workspace_id = "ws-attach-cap";
    open(&transport, &scratch, 1, workspace_id, json!({}))
        .await
        .expect("owner open");
    let mut refused_at = None;
    for attempt in 0..100u64 {
        match open(
            &transport,
            &scratch,
            2 + attempt,
            workspace_id,
            json!({ "skipStartupMaintenance": true }),
        )
        .await
        {
            Ok(_) => {}
            Err(error) => {
                assert_eq!(error.code, ErrorCode::Overloaded);
                refused_at = Some(attempt);
                break;
            }
        }
    }
    refused_at.expect("read attaches must hit the handle cap before unbounded growth");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn read_attachment_over_a_full_owner_cannot_reach_mutating_methods() {
    // MUTATION: keep the owner's mode on the attached clone (drop the
    // `attached.mode = WorkspaceOpenMode::ReadOnly` line) and this write
    // reaches the desktop's Full binding through a "read" handle.
    let scratch = ScratchDir::new().expect("scratch");
    write_shadow_marker_for_harness(scratch.path(), TOKEN).expect("shadow marker");
    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let workspace_id = "ws-attach-write-isolation";
    let desktop = open(&transport, &scratch, 1, workspace_id, json!({}))
        .await
        .expect("desktop full open");
    let cli = open(
        &transport,
        &scratch,
        2,
        workspace_id,
        json!({ "skipStartupMaintenance": true }),
    )
    .await
    .expect("CLI read attach");
    assert_ne!(cli, desktop);

    let error = transport
        .call(
            RequestContext::unbounded(),
            request(
                3,
                "versionedText.write",
                Some(cli.clone()),
                json!({
                    "versionId": "main",
                    "path": "notes/isolated.md",
                    "text": "a read handle must not write",
                    "origin": "api",
                    "requestId": "attach-write-1",
                }),
            ),
        )
        .await
        .expect_err("a mutating method through a read attachment must refuse");
    assert_eq!(error.code, ErrorCode::InvalidParams);
    assert_eq!(
        error.message,
        "method is unavailable on a read-only workspace handle"
    );
    // The same write through the OWNER handle proceeds — the refusal above is
    // the attachment's mode, not a broken method.
    let written = transport
        .call(
            RequestContext::unbounded(),
            request(
                4,
                "versionedText.write",
                Some(desktop.clone()),
                json!({
                    "versionId": "main",
                    "path": "notes/isolated.md",
                    "text": "the owner still writes",
                    "origin": "api",
                    "requestId": "attach-write-2",
                }),
            ),
        )
        .await
        .expect("owner write")
        .result;
    assert!(written["moment"]["momentId"].is_string());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn read_attach_preserves_workspace_id_binding() {
    let scratch = ScratchDir::new().expect("scratch");
    write_shadow_marker_for_harness(scratch.path(), TOKEN).expect("shadow marker");
    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let desktop = open(&transport, &scratch, 1, WORKSPACE_ID, json!({}))
        .await
        .expect("desktop open");

    let mismatch = open(
        &transport,
        &scratch,
        2,
        "another-workspace",
        json!({ "skipStartupMaintenance": true }),
    )
    .await
    .expect_err("workspace-id mismatch must reject");
    assert_eq!(mismatch.code, ErrorCode::InvalidParams);
    assert_eq!(
        mismatch.message,
        "workspace root is already bound to another workspace"
    );

    call(&transport, &desktop, 3, "workspace.close").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn full_write_intent_still_rejects_a_live_read_only_owner() {
    let scratch = ScratchDir::new().expect("scratch");
    write_shadow_marker_for_harness(scratch.path(), TOKEN).expect("shadow marker");
    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let seed = open(&transport, &scratch, 1, WORKSPACE_ID, json!({}))
        .await
        .expect("seed full open");
    call(&transport, &seed, 2, "workspace.close").await;
    let read_only = open(
        &transport,
        &scratch,
        3,
        WORKSPACE_ID,
        json!({ "skipStartupMaintenance": true }),
    )
    .await
    .expect("read-only owner open");

    let write_intent = open(&transport, &scratch, 4, WORKSPACE_ID, json!({}))
        .await
        .expect_err("full write intent must preserve ownership conflict");
    assert_eq!(write_intent.code, ErrorCode::InvalidParams);
    assert_eq!(
        write_intent.message,
        "workspace root is already open in a different mode"
    );

    call(&transport, &read_only, 5, "workspace.close").await;
}
