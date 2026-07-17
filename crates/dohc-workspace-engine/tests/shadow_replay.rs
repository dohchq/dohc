use base64::Engine as _;
use dohc_engine_collab::Ydoc;
use dohc_engine_domain::VersionedTextStore;
use dohc_engine_protocol::{
    error::ErrorCode,
    transport::{EngineTransport, InProcessTransport, RequestContext},
    wire::{Request, WorkspaceHandle},
};
use dohc_engine_storage::EngineStore;
use dohc_engine_testkit::{ScratchDir, harness::write_fingerprint_db};
use dohc_workspace_engine::{EngineService, shadow_fence::write_shadow_marker_for_harness};
use serde_json::{Value, json};
use std::sync::Arc;

const TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

fn request(id: u64, method: &str, workspace: Option<WorkspaceHandle>, params: Value) -> Request {
    Request {
        id,
        method: method.to_owned(),
        workspace,
        deadline_ms: None,
        idempotency_key: Some(format!("shadow-{id}")),
        params,
    }
}

fn root_string(scratch: &ScratchDir) -> String {
    scratch.path().to_string_lossy().into_owned()
}

#[tokio::test]
async fn clone_marked_shadow_replay_composes_real_domains_end_to_end() {
    let scratch = ScratchDir::new().expect("scratch");
    write_shadow_marker_for_harness(scratch.path(), TOKEN).expect("marker");
    let transport = InProcessTransport::new(Arc::new(EngineService::new()));

    let opened = transport
        .call(
            RequestContext::unbounded(),
            request(
                1,
                "workspace.open",
                None,
                json!({ "rootDir": root_string(&scratch), "workspaceId": "ws-shadow" }),
            ),
        )
        .await
        .expect("workspace open");
    let handle: WorkspaceHandle =
        serde_json::from_value(opened.result["workspace"].clone()).expect("workspace handle");

    transport
        .call(
            RequestContext::unbounded(),
            request(
                2,
                "versionedText.write",
                Some(handle.clone()),
                json!({
                    "versionId": "main",
                    "objectId": "object-1",
                    "path": "notes/hello.md",
                    "text": "hello shadow replay",
                    "momentId": "moment-1",
                    "metadataOrigin": "shadow-replay",
                    "nowMs": 100
                }),
            ),
        )
        .await
        .expect("text write");

    let read = transport
        .call(
            RequestContext::unbounded(),
            request(
                3,
                "versionedText.read",
                Some(handle.clone()),
                json!({ "versionId": "main", "path": "notes/hello.md" }),
            ),
        )
        .await
        .expect("text read");
    assert_eq!(read.result["text"], "hello shadow replay");

    let doc = Ydoc::wire();
    let update = doc.plaintext_insert(0, "benign");
    transport
        .call(
            RequestContext::unbounded(),
            request(
                4,
                "ydoc.apply",
                Some(handle.clone()),
                json!({
                    "versionId": "main",
                    "objectId": "object-1",
                    "contentKind": "plaintext",
                    "updateBase64": base64::engine::general_purpose::STANDARD.encode(update),
                    "nowMs": 101
                }),
            ),
        )
        .await
        .expect("ydoc apply");

    let conflicts = transport
        .call(
            RequestContext::unbounded(),
            request(
                5,
                "conflicts.list",
                Some(handle.clone()),
                json!({ "status": "open" }),
            ),
        )
        .await
        .expect("conflict list");
    assert_eq!(conflicts.result, json!([]));

    let search = transport
        .call(
            RequestContext::unbounded(),
            request(
                6,
                "search.query",
                Some(handle.clone()),
                json!({ "versionId": "main", "query": "shadow", "nowMs": 102 }),
            ),
        )
        .await
        .expect("search");
    assert_eq!(search.result[0]["path"], "notes/hello.md");

    let closed = transport
        .call(
            RequestContext::unbounded(),
            request(7, "workspace.close", Some(handle), json!({})),
        )
        .await
        .expect("workspace close");
    assert_eq!(closed.result["closed"], true);

    let db_path = scratch.engine_db_path().expect("db path");
    let mut store = EngineStore::open(&db_path, 103).expect("reopen after actor close");
    let snapshot = VersionedTextStore::new(&mut store)
        .read_text("ws-shadow", "main", "notes/hello.md")
        .expect("disk read")
        .expect("disk snapshot");
    assert_eq!(snapshot.text, "hello shadow replay");
}

#[tokio::test]
async fn shadow_replay_without_marker_is_refused_before_workspace_open() {
    let scratch = ScratchDir::new().expect("scratch");
    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let error = transport
        .call(
            RequestContext::unbounded(),
            request(
                1,
                "workspace.open",
                None,
                json!({ "rootDir": root_string(&scratch), "workspaceId": "ws-shadow" }),
            ),
        )
        .await
        .expect_err("missing marker must fail");
    assert_eq!(error.code, ErrorCode::InvalidParams);
    assert!(!scratch.join(".dohc/engine/engine.db").exists());
}

#[tokio::test]
async fn clone_marker_cannot_bypass_ts_v1_fingerprint_refusal() {
    let scratch = ScratchDir::new().expect("scratch");
    write_shadow_marker_for_harness(scratch.path(), TOKEN).expect("marker");
    let db_path = scratch.engine_db_path().expect("db path");
    write_fingerprint_db(&db_path, 1).expect("foreign v1 fixture");
    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let error = transport
        .call(
            RequestContext::unbounded(),
            request(
                1,
                "workspace.open",
                None,
                json!({ "rootDir": root_string(&scratch), "workspaceId": "ws-shadow" }),
            ),
        )
        .await
        .expect_err("foreign fingerprint must fail");
    assert_eq!(error.code, ErrorCode::Internal);
}
