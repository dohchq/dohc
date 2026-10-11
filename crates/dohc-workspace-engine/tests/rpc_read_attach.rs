mod common;

use common::*;
use std::sync::Arc;

use dohc_engine_protocol::{
    error::ErrorCode,
    transport::{EngineTransport, InProcessTransport, RequestContext},
    wire::WorkspaceHandle,
};
use dohc_engine_testkit::ScratchDir;
use dohc_workspace_engine::EngineService;
use serde_json::{Value, json};

const WORKSPACE_ID: &str = "cli-read-attach";

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
    call_with_busy_retry(
        transport,
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
    call_with_busy_retry(
        transport,
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
    let flushed = call(&transport, &desktop, 5, "capture.flush").await;
    assert_eq!(
        flushed["settled"],
        json!(true),
        "routing attached close through owner teardown makes this fail."
    );
    assert_eq!(
        attached_close,
        json!({ "closed": false, "attachmentClosed": true })
    );
    let owner_close = call(&transport, &desktop, 6, "workspace.close").await;
    assert_eq!(owner_close["closed"], json!(true));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn read_attach_respects_the_open_handle_cap() {
    let scratch = ScratchDir::new().expect("scratch");
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
    let scratch = ScratchDir::new().expect("scratch");
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

    let history = common::call(
        &transport,
        &cli,
        5,
        "history.page",
        json!({ "workspaceId": workspace_id }),
    )
    .await;
    assert_eq!(history["activeVersion"]["id"], "main");
    assert_eq!(
        history["textMomentPage"]["moments"][0]["momentId"],
        written["moment"]["momentId"]
    );
    let detail = common::call(
        &transport,
        &cli,
        6,
        "moments.get",
        json!({ "momentId": written["moment"]["momentId"] }),
    )
    .await;
    assert_eq!(detail["afterText"], "the owner still writes");

    for (index, method) in [
        "capture.flush",
        "capture.reconcile",
        "versionedText.rollback",
        "versions.ensureMain",
        "versions.setActive",
        "sync.pull",
        "secrets.write",
    ]
    .into_iter()
    .enumerate()
    {
        let error = common::call_error(&transport, &cli, 7 + index as u64, method, json!({})).await;
        assert_eq!(error.code, ErrorCode::InvalidParams, "{method}");
        assert_eq!(
            error.message, "method is unavailable on a read-only workspace handle",
            "{method}"
        );
    }
    call(&transport, &cli, 14, "workspace.close").await;
    call(&transport, &desktop, 15, "workspace.close").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn read_only_history_hydrates_large_moment_text_within_its_workspace() {
    use dohc_engine_domain::{NoFaults, VersionedTextStore, WriteText};
    use dohc_engine_protocol::transport::EngineService as ProtocolEngineService;
    use dohc_engine_storage::EngineStore;
    use dohc_workspace_engine::root_binding::write_root_binding;

    let scratch = ScratchDir::new().expect("scratch");
    write_root_binding(scratch.path(), TOKEN).expect("root binding");
    let workspace_id = "ws-read-only-history-blob";
    let other_workspace = "ws-read-only-history-blob-other";
    let db_path = scratch.path().join(".dohc/engine/engine.db");
    std::fs::create_dir_all(db_path.parent().expect("engine dir")).expect("engine dir");
    let text = "x".repeat(128 * 1024 + 1);
    let sha256 = dohc_engine_storage::hex_sha256(text.as_bytes());
    let other_text = "referenced only by another workspace";
    let other_sha256 = dohc_engine_storage::hex_sha256(other_text.as_bytes());
    {
        let mut store = EngineStore::open(&db_path, 1).expect("store");
        store.bind_root_token(TOKEN, &NoFaults).expect("bind token");
        let mut versioned = VersionedTextStore::new(&mut store);
        for workspace in [workspace_id, other_workspace] {
            versioned
                .ensure_main_version(workspace, "main", 1, &NoFaults)
                .expect("main");
        }
        for (index, (workspace, moment_id, body)) in [
            (workspace_id, "large-text-moment", text.as_str()),
            (workspace_id, "current-text-moment", "small now"),
            (other_workspace, "other-text-moment", other_text),
        ]
        .into_iter()
        .enumerate()
        {
            versioned
                .write_text(
                    &WriteText {
                        workspace_id: workspace.to_owned(),
                        version_id: "main".to_owned(),
                        object_id: format!("{workspace}-text-object"),
                        path: "large.md".to_owned(),
                        text: body.to_owned(),
                        moment_id: moment_id.to_owned(),
                        metadata_origin: "api".to_owned(),
                        metadata_summary: None,
                        metadata_correlation_id: None,
                        author_json: None,
                        now_ms: index as i64 + 2,
                        request_id: None,
                    },
                    &NoFaults,
                )
                .expect("seed text moment");
        }
    }

    let service = Arc::new(EngineService::new());
    let transport = InProcessTransport::new(Arc::clone(&service));
    let read_only = open(
        &transport,
        &scratch,
        1,
        workspace_id,
        json!({ "skipStartupMaintenance": true }),
    )
    .await
    .expect("read-only open");
    let history = common::call(
        &transport,
        &read_only,
        2,
        "history.page",
        json!({ "workspaceId": workspace_id }),
    )
    .await;
    let moment = history["textMomentPage"]["moments"]
        .as_array()
        .expect("history moments")
        .iter()
        .find(|moment| moment["momentId"] == "large-text-moment")
        .expect("historical large text moment");
    assert_eq!(moment["afterText"], Value::Null);
    assert_eq!(moment["afterBlobSha256"], sha256);
    let detail = common::call(
        &transport,
        &read_only,
        3,
        "moments.get",
        json!({ "momentId": moment["momentId"] }),
    )
    .await;
    assert_eq!(detail["afterText"], Value::Null);
    assert_eq!(detail["afterBlobSha256"], sha256);
    let hydrated = ProtocolEngineService::call(
        service.as_ref(),
        RequestContext::unbounded().with_capability("blobs"),
        request(
            4,
            "versionedText.readBlob",
            Some(read_only.clone()),
            json!({ "workspaceId": workspace_id, "sha256": detail["afterBlobSha256"] }),
        ),
    )
    .await
    .expect("read-only historical blob hydration");
    assert_eq!(hydrated.response.result["bytesBase64"], Value::Null);
    let egress = hydrated.blob_egress.expect("over-cap text egress");
    assert_eq!(egress.sha256, sha256);
    assert_eq!(egress.bytes, text.as_bytes());

    let foreign_blob = common::call_error(
        &transport,
        &read_only,
        5,
        "versionedText.readBlob",
        json!({ "workspaceId": workspace_id, "sha256": other_sha256 }),
    )
    .await;
    assert_eq!(foreign_blob.code, ErrorCode::InvalidParams);
    assert_eq!(foreign_blob.message, "file-not-found");
    let foreign_workspace = common::call_error(
        &transport,
        &read_only,
        6,
        "versionedText.readBlob",
        json!({ "workspaceId": other_workspace, "sha256": other_sha256 }),
    )
    .await;
    assert_eq!(foreign_workspace.code, ErrorCode::InvalidParams);
    assert_eq!(foreign_workspace.message, "invalid-workspace");
    let mutation = common::call_error(
        &transport,
        &read_only,
        7,
        "versionedText.rollback",
        json!({}),
    )
    .await;
    assert_eq!(mutation.code, ErrorCode::InvalidParams);
    assert_eq!(
        mutation.message,
        "method is unavailable on a read-only workspace handle"
    );
    call(&transport, &read_only, 8, "workspace.close").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn read_attach_preserves_workspace_id_binding() {
    let scratch = ScratchDir::new().expect("scratch");
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
