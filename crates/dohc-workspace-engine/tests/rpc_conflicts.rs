use dohc_engine_protocol::{
    ErrorCode,
    limits::WireLimits,
    transport::{EngineTransport, InProcessTransport, RequestContext},
    wire::{Envelope, Request, Response, WorkspaceHandle, encode_control},
};
use dohc_engine_testkit::ScratchDir;
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
        idempotency_key: None,
        params,
    }
}

async fn fixture(
    name: &str,
) -> (
    ScratchDir,
    InProcessTransport<EngineService>,
    WorkspaceHandle,
    String,
) {
    let scratch = ScratchDir::new().expect("scratch");
    write_shadow_marker_for_harness(scratch.path(), TOKEN).expect("marker");
    let workspace_id = format!("ws-conflicts-{name}");
    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
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
    let handle: WorkspaceHandle =
        serde_json::from_value(opened.result["workspace"].clone()).expect("handle");
    transport
        .call(
            RequestContext::unbounded(),
            request(
                2,
                "versionedText.write",
                Some(handle.clone()),
                json!({
                    "versionId": "main",
                    "path": "bootstrap.md",
                    "text": "bootstrap",
                    "origin": "api",
                    "requestId": format!("{name}-bootstrap"),
                }),
            ),
        )
        .await
        .expect("bootstrap versioned workspace");
    (scratch, transport, handle, workspace_id)
}

fn conflict_payload(workspace_id: &str, index: usize, text: &str) -> Value {
    let conflict_id = format!("conflict-{index:03}");
    let path = format!("conflict-{index:03}.md");
    let sha256 = dohc_engine_storage::hex_sha256(text.as_bytes());
    let state = json!({
        "path": path,
        "contentKind": "text",
        "snapshot": {
            "workspaceId": workspace_id,
            "versionId": "main",
            "objectId": format!("object-{index:03}"),
            "path": path,
            "text": text,
            "blobSha256": sha256,
            "updatedAtMs": index as i64 + 1,
            "latestMomentId": format!("moment-{index:03}"),
            "metadataOrigin": "sync",
        },
        "metadataSummary": null,
        "metadataCorrelationId": null,
    });
    json!({
        "conflict": {
            "id": conflict_id,
            "workspaceId": workspace_id,
            "path": path,
            "targetVersionId": "main",
            "sourceVersionId": "peer",
            "createdAtMs": index as i64 + 1,
            "updatedAtMs": index as i64 + 1,
            "status": "open",
            "chosenFrom": "current",
            "resolution": null,
            "metadata": {
                "origin": "sync",
                "summary": null,
                "correlationId": null,
            },
            "base": state,
            "current": state,
            "incoming": state,
        }
    })
}

async fn seed_conflicts(
    transport: &InProcessTransport<EngineService>,
    handle: &WorkspaceHandle,
    workspace_id: &str,
    count: usize,
    text: &str,
) {
    for index in 0..count {
        let opened = transport
            .call(
                RequestContext::unbounded(),
                request(
                    index as u64 + 2,
                    "conflicts.open",
                    Some(handle.clone()),
                    conflict_payload(workspace_id, index, text),
                ),
            )
            .await
            .unwrap_or_else(|error| panic!("seed conflict {index}: {error:?}"));
        assert_eq!(opened.result["inserted"], true);
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn oversized_conflict_inventory_is_wire_safe_across_pages_and_session_survives() {
    // Fourteen rows serialize beyond the 8 MiB frame as one legacy array,
    // while each row remains under the hard single-row cap.
    const CONFLICT_COUNT: usize = 14;
    let (_scratch, transport, handle, workspace_id) = fixture("paged-inventory").await;
    let text = "\0".repeat(35_000);
    seed_conflicts(&transport, &handle, &workspace_id, CONFLICT_COUNT, &text).await;

    let mut request_id = 100;
    let mut after_conflict_id: Option<String> = None;
    let mut pages = 0usize;
    let mut all_rows = Vec::new();
    loop {
        let response = transport
            .call(
                RequestContext::unbounded(),
                request(
                    request_id,
                    "conflicts.list",
                    Some(handle.clone()),
                    json!({
                        "status": "open",
                        "afterConflictId": after_conflict_id,
                    }),
                ),
            )
            .await
            .expect("conflict page");
        encode_control(
            &Envelope::Response(response.clone()),
            &WireLimits::default(),
        )
        .expect("every returned page must fit the negotiated wire limits");

        let rows = response.result["conflicts"]
            .as_array()
            .expect("conflicts page");
        assert!(!rows.is_empty(), "a continuation page must make progress");
        all_rows.extend(rows.iter().cloned());
        pages += 1;
        after_conflict_id = response.result["nextAfterConflictId"]
            .as_str()
            .map(str::to_owned);
        request_id += 1;
        if after_conflict_id.is_none() {
            break;
        }
    }

    assert!(pages > 1, "the oversized inventory must be split");
    assert_eq!(all_rows.len(), CONFLICT_COUNT);
    let legacy = Envelope::Response(Response {
        id: 999,
        result: Value::Array(all_rows),
    });
    assert!(
        encode_control(&legacy, &WireLimits::default()).is_err(),
        "the same inventory as one legacy array must exceed the wire frame"
    );

    let status = transport
        .call(
            RequestContext::unbounded(),
            request(1_000, "watcher.status", Some(handle), json!({})),
        )
        .await
        .expect("the daemon session remains usable after all pages");
    assert!(status.result["running"].is_boolean());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn conflict_page_cursor_round_trips_without_duplicates_or_gaps() {
    // MUTATION: ignore afterConflictId (or resume before it) and page two
    // repeats conflict-000 instead of returning conflict-001.
    let (_scratch, transport, handle, workspace_id) = fixture("cursor").await;
    let text = "\0".repeat(20_000);
    seed_conflicts(&transport, &handle, &workspace_id, 3, &text).await;

    let first = transport
        .call(
            RequestContext::unbounded(),
            request(
                10,
                "conflicts.list",
                Some(handle.clone()),
                json!({ "status": "open" }),
            ),
        )
        .await
        .expect("first page");
    assert_eq!(first.result["conflicts"][0]["id"], "conflict-000");
    assert_eq!(
        first.result["nextAfterConflictId"],
        first.result["conflicts"][0]["id"]
    );

    let second = transport
        .call(
            RequestContext::unbounded(),
            request(
                11,
                "conflicts.list",
                Some(handle),
                json!({
                    "status": "open",
                    "afterConflictId": first.result["nextAfterConflictId"],
                }),
            ),
        )
        .await
        .expect("second page");
    assert_eq!(second.result["conflicts"][0]["id"], "conflict-001");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_single_conflict_row_over_the_hard_cap_refuses_explicitly() {
    let (_scratch, transport, handle, workspace_id) = fixture("single-row").await;
    let text = "\0".repeat(40_000);
    seed_conflicts(&transport, &handle, &workspace_id, 1, &text).await;

    let error = transport
        .call(
            RequestContext::unbounded(),
            request(
                10,
                "conflicts.list",
                Some(handle),
                json!({ "status": "open" }),
            ),
        )
        .await
        .expect_err("an unshippable conflict row must refuse");
    assert_eq!(error.code, ErrorCode::LimitExceeded);
    assert_eq!(error.message, "conflict-row-exceeds-wire-limit");
}
