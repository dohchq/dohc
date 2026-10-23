mod common;

use base64::Engine as _;
use common::*;
use dohc_engine_collab::{OwnerOutboxAppendInput, OwnerOutboxLimits, Ydoc, append_owner_outbox};
use dohc_engine_protocol::{
    error::ErrorCode,
    transport::{EngineTransport, InProcessTransport, RequestContext},
    wire::WorkspaceHandle,
};
use dohc_engine_storage::EngineStore;
use dohc_engine_testkit::{ScratchDir, engine_db_path};
use dohc_workspace_engine::{EngineService, LiveApplicationHostConfig};
use serde_json::{Value, json};
use std::sync::Arc;

async fn open(
    transport: &InProcessTransport<EngineService>,
    scratch: &ScratchDir,
    received: bool,
) -> WorkspaceHandle {
    let response = call_with_busy_retry(
        transport,
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
    let session = call_with_busy_retry(
        &transport,
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
            "expectedLineageClaimId": null,
            "sessionId": session_id,
            "updateBase64": base64::engine::general_purpose::STANDARD
                .encode(Ydoc::wire().richdoc_append_paragraph("Workspace body.")),
        }),
    )
    .await;
    let params = match method {
        "ydoc.open" => open_params,
        "ydoc.recordUpdate" => json!({
            "expectedLineageClaimId": null,
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
    call_with_busy_retry(
        &transport,
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

async fn received_live_application_provision(trusted: bool) {
    let workspace = ScratchDir::new().unwrap();
    let received = ScratchDir::new().unwrap();
    let (service, owner, _ingress) = EngineService::ordinary_live_host(
        serde_json::from_value(json!({
            "ingress": {
                "aggregateBytes": 536_870_912,
                "applicationWorkingReserveBytes": 8_388_608,
                "maxUploads": 2,
                "uploadDeadlineMs": 30_000,
            },
            "maxRegistrations": 4,
            "maxAdoptionBytes": 4_194_304,
            "maxAdoptionEvents": 16,
            "maxApplicationsPerSettlement": 4,
            "ownerOutbox": {"maxPendingBytes": 1_000, "maxPendingAgeMs": 1_000},
        }))
        .unwrap(),
    )
    .unwrap();
    let transport = InProcessTransport::new(service.clone());
    let workspace_handle = open(&transport, &workspace, false).await;
    let received_handle = open(&transport, &received, true).await;
    let host = json!({
        "hostId": "host", "hostEpoch": 1,
        "instanceId": "instance", "connectionId": "connection",
    });
    let provision = async |handle: WorkspaceHandle| {
        if trusted {
            service
                .provision_live_application(
                    owner.handle(),
                    LiveApplicationHostConfig {
                        workspace: handle,
                        namespace: "relay-history".into(),
                        coordinate: serde_json::from_value(host.clone()).unwrap(),
                        max_registrations: 4,
                    },
                )
                .await
        } else {
            let mut context = RequestContext::unbounded();
            context.connection = Some(owner.handle());
            call_with_busy_retry(
                &transport,
                context,
                request(
                    2,
                    "liveApplication.provisionOwner",
                    Some(handle),
                    json!({"relayNamespace": "relay-history", "host": host}),
                ),
            )
            .await
            .map(|response| assert_eq!(response.result["provisioned"], true))
        }
    };
    let received_result = provision(received_handle.clone()).await;
    let workspace_result = provision(workspace_handle.clone()).await;
    call(
        &transport,
        &workspace_handle,
        3,
        "workspace.close",
        json!({}),
    )
    .await;
    call(
        &transport,
        &received_handle,
        4,
        "workspace.close",
        json!({}),
    )
    .await;
    workspace_result.expect("workspace must still provision an owner");
    let error = received_result.expect_err("received share must refuse owner provisioning");
    assert_eq!(error.code, ErrorCode::Forbidden);
    assert_eq!(
        error.message,
        "received shares do not host live applications"
    );
}

#[tokio::test]
async fn received_live_application_provision_owner_dispatch() {
    received_live_application_provision(false).await;
}

#[tokio::test]
async fn received_live_application_provision_owner_trusted() {
    received_live_application_provision(true).await;
}

#[tokio::test]
async fn received_ydoc_guard_keeps_configured_outbox_read() {
    let scratch = ScratchDir::new().unwrap();
    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let handle = open(&transport, &scratch, true).await;
    call(
        &transport,
        &handle,
        2,
        "versions.ensureMain",
        json!({"workspaceId": "received"}),
    )
    .await;
    call(&transport, &handle, 2, "workspace.close", json!({})).await;
    let vectors: Value = serde_json::from_str(include_str!(
        "../../../packages/live-session-contract/src/liveObjectBinding.vectors.json"
    ))
    .unwrap();
    let mut binding = vectors["accepted"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["name"] == "canonical-binding")
        .unwrap()["input"]
        .clone();
    binding["workspaceId"] = json!("received");
    // Seed below RPC so a future ydoc prefix guard is tested by the read itself.
    let appended = {
        let mut store = EngineStore::open(&engine_db_path(&scratch).unwrap(), 1).unwrap();
        append_owner_outbox(
            &mut store,
            "received",
            OwnerOutboxAppendInput {
                binding: serde_json::from_value(binding).unwrap(),
                base_update: b"base".to_vec(),
                append_key: "allowed-read".into(),
                update: b"update".to_vec(),
                limits: OwnerOutboxLimits {
                    max_pending_bytes: 1_000,
                    max_pending_age_ms: 1_000,
                },
                created_at_ms: 1,
            },
        )
        .unwrap()
    };
    let handle = open(&transport, &scratch, true).await;
    let result = transport
        .call(
            RequestContext::unbounded(),
            request(
                3,
                "ydoc.ownerOutbox.readPending",
                Some(handle.clone()),
                json!({"outboxId": appended.outbox_id}),
            ),
        )
        .await;
    call(&transport, &handle, 4, "workspace.close", json!({})).await;
    let page = result
        .expect("received share must allow the configured outbox read")
        .result;
    assert_eq!(page["kind"], "page");
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(page["bytesBase64"].as_str().unwrap())
        .unwrap();
    let header: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(header["outboxId"], appended.outbox_id);
    assert_eq!(header["binding"]["workspaceId"], "received");
    assert_eq!(header["pendingEntryCount"], 1);
}
