//! RPC-D sequencing steps 1-3: mutation guards exercised through the real
//! in-process transport and actor-owned store.

use dohc_engine_protocol::{
    transport::{EngineTransport, InProcessTransport, RequestContext},
    wire::{Request, WorkspaceHandle},
};
use dohc_engine_testkit::ScratchDir;
use dohc_workspace_engine::{EngineService, shadow_fence::write_shadow_marker_for_harness};
use serde_json::{Value, json};
use std::{collections::BTreeMap, path::Path, sync::Arc};

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
) {
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
                json!({
                    "rootDir": scratch.path().to_string_lossy(),
                    "workspaceId": format!("ws-rpcd-{name}"),
                }),
            ),
        )
        .await
        .expect("open");
    let handle = serde_json::from_value(opened.result["workspace"].clone()).expect("handle");
    (scratch, transport, handle)
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

async fn write(
    transport: &InProcessTransport<EngineService>,
    handle: &WorkspaceHandle,
    id: u64,
    path: &str,
    text: &str,
    request_id: &str,
) -> Value {
    call(
        transport,
        handle,
        id,
        "versionedText.write",
        json!({
            "versionId": "main",
            "path": path,
            "text": text,
            "origin": "api",
            "requestId": request_id,
        }),
    )
    .await
}

async fn moments(
    transport: &InProcessTransport<EngineService>,
    handle: &WorkspaceHandle,
    id: u64,
) -> Vec<Value> {
    call(
        transport,
        handle,
        id,
        "moments.list",
        json!({ "versionId": "main", "limit": 100 }),
    )
    .await["moments"]
        .as_array()
        .expect("moments")
        .clone()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn write_response_shape_contains_object_snapshot_moment_and_deduped() {
    // MUTATION: drop `object` (or `moment`) from the write response -> this test fails.
    let (_scratch, transport, handle) = fixture("write-shape").await;
    let result = write(&transport, &handle, 2, "shape.md", "shape", "shape-1").await;
    assert!(result["object"]["id"].is_string());
    assert_eq!(result["snapshot"]["contentKind"], "text");
    assert!(result["snapshot"]["sha256"].is_string());
    assert!(result["moment"]["momentId"].is_string());
    assert_eq!(result["deduped"], false);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn text_write_enqueues_no_materialization_and_binary_write_enqueues_one() {
    // MUTATION: enqueue text materialization or omit binary materialization -> moment/disk assertions fail.
    let (scratch, transport, handle) = fixture("materialize").await;
    write(&transport, &handle, 2, "plain.md", "db only", "plain-1").await;
    assert!(!scratch.path().join("plain.md").exists());
    let binary = call(
        &transport,
        &handle,
        3,
        "versionedBinary.write",
        json!({
            "versionId": "main",
            "path": "asset.bin",
            "bytes": [1, 2, 3, 4],
            "origin": "api",
        }),
    )
    .await;
    assert_eq!(binary["snapshot"]["contentKind"], "binary");
    assert_eq!(
        std::fs::read(scratch.path().join("asset.bin")).expect("binary"),
        [1, 2, 3, 4]
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn conflicted_binary_materialize_returns_the_committed_moment() {
    // MUTATION: restore post-commit conflict refusal -> this call errors and hides the durable moment.
    let (scratch, transport, handle) = fixture("binary-conflict-result").await;
    std::fs::write(scratch.path().join("occupied.bin"), b"external").expect("external file");
    let result = call(
        &transport,
        &handle,
        2,
        "versionedBinary.write",
        json!({
            "versionId": "main",
            "path": "occupied.bin",
            "bytes": [1, 2, 3],
            "origin": "api",
        }),
    )
    .await;
    assert_eq!(result["materializeEnqueued"], true);
    assert_eq!(result["materialized"], false);
    assert_eq!(result["materializeOutcome"], "conflict");
    assert!(result["moment"]["momentId"].is_string());
    assert_eq!(
        std::fs::read(scratch.path().join("occupied.bin")).unwrap(),
        b"external"
    );
    assert_eq!(moments(&transport, &handle, 3).await.len(), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn binary_self_write_suppression_prevents_a_spurious_capture_moment() {
    // MUTATION: move/remove the pre-materialize suppression record -> watcher capture adds a moment.
    let (_scratch, transport, handle) = fixture("binary-suppression").await;
    call(
        &transport,
        &handle,
        2,
        "versionedBinary.write",
        json!({ "versionId": "main", "path": "one.bin", "bytes": [9, 8, 7], "origin": "api" }),
    )
    .await;
    tokio::time::sleep(std::time::Duration::from_millis(400)).await;
    call(&transport, &handle, 3, "capture.flush", json!({})).await;
    assert_eq!(moments(&transport, &handle, 4).await.len(), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn binary_write_request_id_replays_once_and_rejects_mismatch() {
    // MUTATION: seed generated ids from the wire request id instead of requestId -> retry mismatches.
    let (_scratch, transport, handle) = fixture("binary-request-ledger").await;
    let params = json!({
        "versionId": "main",
        "objectId": "binary-ledger-object",
        "path": "ledger.bin",
        "bytes": [1, 2, 3],
        "origin": "api",
        "requestId": "binary-ledger-request",
    });
    let first = call(
        &transport,
        &handle,
        2,
        "versionedBinary.write",
        params.clone(),
    )
    .await;
    assert_eq!(first["deduped"], false);
    let replay = call(&transport, &handle, 3, "versionedBinary.write", params).await;
    assert_eq!(replay["deduped"], true);
    assert_eq!(replay["moment"]["momentId"], first["moment"]["momentId"]);
    assert_eq!(moments(&transport, &handle, 4).await.len(), 1);

    let mismatch = transport
        .call(
            RequestContext::unbounded(),
            request(
                5,
                "versionedBinary.write",
                Some(handle.clone()),
                json!({
                    "versionId": "main",
                    "path": "ledger.bin",
                    "bytes": [9, 9, 9],
                    "origin": "api",
                    "momentId": "binary-ledger-moment",
                    "requestId": "binary-ledger-request",
                }),
            ),
        )
        .await
        .expect_err("request id reuse with different bytes must fail");
    assert_eq!(mismatch.message, "idempotency-key-reuse-mismatch");
    // MUTATION: omit object_id from the binary ledger hash -> this silently replays.
    let object_mismatch = transport
        .call(
            RequestContext::unbounded(),
            request(
                6,
                "versionedBinary.write",
                Some(handle.clone()),
                json!({
                    "versionId": "main",
                    "objectId": "binary-ledger-object-flipped",
                    "path": "ledger.bin",
                    "bytes": [1, 2, 3],
                    "origin": "api",
                    "requestId": "binary-ledger-request",
                }),
            ),
        )
        .await
        .expect_err("request id reuse with a different object id must fail");
    assert_eq!(object_mismatch.message, "idempotency-key-reuse-mismatch");
    assert_eq!(moments(&transport, &handle, 7).await.len(), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn over_cap_write_refuses_before_commit() {
    // MUTATION: commit text/binary and only then refuse -> the moment count changes.
    let (_scratch, transport, handle) = fixture("cap").await;
    write(&transport, &handle, 2, "seed.md", "seed", "cap-seed").await;
    let before = moments(&transport, &handle, 3).await.len();
    let refused = transport
        .call(
            RequestContext::unbounded(),
            request(
                4,
                "versionedText.write",
                Some(handle.clone()),
                json!({
                    "versionId": "main",
                    "path": "too-big.md",
                    "text": "x".repeat(49 * 1024),
                    "origin": "api",
                    "requestId": "too-big",
                }),
            ),
        )
        .await
        .expect_err("over cap");
    assert_eq!(refused.message, "content-exceeds-inband-cap");
    assert_eq!(moments(&transport, &handle, 5).await.len(), before);
    let refused = transport
        .call(
            RequestContext::unbounded(),
            request(
                6,
                "versionedBinary.write",
                Some(handle.clone()),
                json!({
                    "versionId": "main",
                    "path": "too-big.bin",
                    "bytes": vec![7_u8; 49 * 1024],
                    "origin": "api",
                }),
            ),
        )
        .await
        .expect_err("over-cap binary");
    assert_eq!(refused.message, "content-exceeds-inband-cap");
    assert_eq!(moments(&transport, &handle, 7).await.len(), before);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn rpc_paths_flow_verbatim_without_unicode_normalization() {
    // MUTATION: NFC-normalize RPC paths -> the stored spelling changes and a
    // caller feeding back a listed path misses its own row (the recorded
    // cross-engine posture: Rust stores the spelling the write carried;
    // classification stays disguise-proof).
    let (_scratch, transport, handle) = fixture("verbatim-path").await;
    call(
        &transport,
        &handle,
        2,
        "versions.ensureMain",
        json!({ "workspaceId": "ws-rpcd-verbatim-path" }),
    )
    .await;
    // "café" with U+0301 COMBINING ACUTE (NFD): NFC would rewrite it.
    let nfd_secret = "cafe\u{301}.env";
    call(
        &transport,
        &handle,
        3,
        "secrets.write",
        json!({
            "workspaceId": "ws-rpcd-verbatim-path",
            "versionId": "main",
            "path": nfd_secret,
            "text": "TOKEN=verbatim",
            "origin": "api",
            "momentId": "verbatim-secret-1",
        }),
    )
    .await;
    let listed = call(
        &transport,
        &handle,
        4,
        "secrets.list",
        json!({ "versionId": "main" }),
    )
    .await;
    let listed_path = listed["secrets"][0]["path"].as_str().expect("secret path");
    assert_eq!(listed_path, nfd_secret, "stored spelling is the caller's");
    let materialized = call(
        &transport,
        &handle,
        5,
        "secrets.materialize",
        json!({ "versionId": "main", "path": listed_path }),
    )
    .await;
    assert_eq!(materialized["text"], "TOKEN=verbatim");

    let nfd_text = "notes/tha\u{300}nh.md";
    let written = call(
        &transport,
        &handle,
        6,
        "versionedText.write",
        json!({
            "versionId": "main",
            "path": nfd_text,
            "text": "verbatim path",
            "origin": "api",
        }),
    )
    .await;
    assert_eq!(
        written["snapshot"]["path"].as_str().expect("path"),
        nfd_text
    );
    let read = call(
        &transport,
        &handle,
        7,
        "versionedText.read",
        json!({ "versionId": "main", "path": nfd_text }),
    )
    .await;
    assert_eq!(read["text"], "verbatim path");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn secrets_write_rejects_over_cap_text_before_commit() {
    // MUTATION: commit the secret and truncate only the response -> the moment leaks and fails.
    let (_scratch, transport, handle) = fixture("secret-cap").await;
    call(
        &transport,
        &handle,
        2,
        "versions.ensureMain",
        json!({ "workspaceId": "ws-rpcd-secret-cap" }),
    )
    .await;
    let refused = transport
        .call(
            RequestContext::unbounded(),
            request(
                3,
                "secrets.write",
                Some(handle.clone()),
                json!({
                    "workspaceId": "ws-rpcd-secret-cap",
                    "versionId": "main",
                    "path": ".env",
                    "text": "x".repeat(dohc_engine_domain::INBAND_CONTENT_CAP_BYTES + 1),
                    "origin": "api",
                    "momentId": "secret-too-big",
                }),
            ),
        )
        .await
        .expect_err("over-cap secret write");
    assert_eq!(refused.message, "content-exceeds-inband-cap");
    let moments = call(
        &transport,
        &handle,
        4,
        "secrets.moments.list",
        json!({
            "workspaceId": "ws-rpcd-secret-cap",
            "versionId": "main",
            "path": ".env",
        }),
    )
    .await;
    assert!(
        moments["moments"]
            .as_array()
            .expect("secret moments")
            .is_empty()
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn secret_moments_keyset_pages_round_trip_without_overlap() {
    // MUTATION: return the old bare/truncated array or use an inclusive cursor -> shape/overlap fails.
    let (_scratch, transport, handle) = fixture("secret-moment-pages").await;
    call(
        &transport,
        &handle,
        2,
        "versions.ensureMain",
        json!({ "workspaceId": "ws-rpcd-secret-moment-pages" }),
    )
    .await;
    for (index, text) in ["one", "two", "three"].into_iter().enumerate() {
        call(
            &transport,
            &handle,
            3 + index as u64,
            "secrets.write",
            json!({
                "workspaceId": "ws-rpcd-secret-moment-pages",
                "versionId": "main",
                "path": ".env",
                "text": text,
                "origin": "api",
                "momentId": format!("secret-page-{index}"),
            }),
        )
        .await;
    }
    let first = call(
        &transport,
        &handle,
        6,
        "secrets.moments.list",
        json!({
            "workspaceId": "ws-rpcd-secret-moment-pages",
            "versionId": "main",
            "path": ".env",
            "limit": 2,
        }),
    )
    .await;
    let first_rows = first["moments"].as_array().expect("first page");
    assert_eq!(first_rows.len(), 2);
    assert_eq!(first["nextBeforeMomentOrder"], first_rows[1]["momentOrder"]);
    let second = call(
        &transport,
        &handle,
        7,
        "secrets.moments.list",
        json!({
            "workspaceId": "ws-rpcd-secret-moment-pages",
            "versionId": "main",
            "path": ".env",
            "beforeMomentOrder": first["nextBeforeMomentOrder"],
            "limit": 2,
        }),
    )
    .await;
    let second_rows = second["moments"].as_array().expect("second page");
    assert_eq!(second_rows.len(), 1);
    assert_ne!(second_rows[0]["id"], first_rows[1]["id"]);
    assert!(second["nextBeforeMomentOrder"].is_null());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn secret_moments_version_wide_pages_across_paths_newest_first() {
    // MUTATION: require or unconditionally filter by path -> the mixed-path page loses a row.
    let (_scratch, transport, handle) = fixture("secret-version-history").await;
    call(
        &transport,
        &handle,
        2,
        "versions.ensureMain",
        json!({ "workspaceId": "ws-rpcd-secret-version-history" }),
    )
    .await;
    for (index, (path, text)) in [(".env", "one"), (".env.local", "two"), (".env", "three")]
        .into_iter()
        .enumerate()
    {
        call(
            &transport,
            &handle,
            3 + index as u64,
            "secrets.write",
            json!({
                "workspaceId": "ws-rpcd-secret-version-history",
                "versionId": "main",
                "path": path,
                "text": text,
                "origin": "api",
                "momentId": format!("secret-history-{index}"),
            }),
        )
        .await;
    }
    let first = call(
        &transport,
        &handle,
        6,
        "secrets.moments.list",
        json!({
            "workspaceId": "ws-rpcd-secret-version-history",
            "versionId": "main",
            "limit": 2,
        }),
    )
    .await;
    let first_rows = first["moments"].as_array().expect("first page");
    assert_eq!(first_rows.len(), 2);
    assert_eq!(first_rows[0]["id"], "secret-history-2");
    assert_eq!(first_rows[1]["id"], "secret-history-1");
    assert_eq!(first_rows[0]["path"], ".env");
    assert_eq!(first_rows[1]["path"], ".env.local");
    assert_eq!(first["nextBeforeMomentOrder"], first_rows[1]["momentOrder"]);

    let second = call(
        &transport,
        &handle,
        7,
        "secrets.moments.list",
        json!({
            "workspaceId": "ws-rpcd-secret-version-history",
            "versionId": "main",
            "beforeMomentOrder": first["nextBeforeMomentOrder"],
            "limit": 2,
        }),
    )
    .await;
    let second_rows = second["moments"].as_array().expect("second page");
    assert_eq!(second_rows.len(), 1);
    assert_eq!(second_rows[0]["id"], "secret-history-0");
    assert!(second["nextBeforeMomentOrder"].is_null());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn secret_moments_without_version_list_workspace_history_newest_first() {
    // MUTATION: require versionId or always scope the actor query to one version -> fails.
    let (_scratch, transport, handle) = fixture("secret-workspace-history").await;
    let workspace_id = "ws-rpcd-secret-workspace-history";
    call(
        &transport,
        &handle,
        2,
        "versions.ensureMain",
        json!({ "workspaceId": workspace_id }),
    )
    .await;
    call(
        &transport,
        &handle,
        3,
        "secrets.write",
        json!({
            "workspaceId": workspace_id,
            "versionId": "main",
            "path": ".env",
            "text": "MAIN=1",
            "origin": "api",
            "momentId": "secret-workspace-main",
        }),
    )
    .await;
    let feature = call(
        &transport,
        &handle,
        4,
        "versions.createNamed",
        json!({
            "workspaceId": workspace_id,
            "name": "feature",
            "fromVersionId": "main",
        }),
    )
    .await;
    call(
        &transport,
        &handle,
        5,
        "secrets.write",
        json!({
            "workspaceId": workspace_id,
            "versionId": feature["id"],
            "path": ".env",
            "text": "FEATURE=1",
            "origin": "api",
            "momentId": "secret-workspace-feature",
        }),
    )
    .await;
    let listed = call(
        &transport,
        &handle,
        6,
        "secrets.moments.list",
        json!({ "workspaceId": workspace_id }),
    )
    .await;
    let rows = listed["moments"].as_array().expect("workspace history");
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0]["id"], "secret-workspace-feature");
    assert_eq!(rows[0]["versionId"], feature["id"]);
    assert_eq!(rows[1]["id"], "secret-workspace-main");
    assert_eq!(rows[1]["versionId"], "main");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn secrets_apply_uses_explicit_target_and_preserves_caller_provenance() {
    // MUTATION: hardcode apply provenance to sync or drop summary/correlation -> assertions fail.
    let (_scratch, transport, handle) = fixture("secret-apply-target").await;
    let workspace_id = "ws-rpcd-secret-apply-target";
    call(
        &transport,
        &handle,
        2,
        "versions.ensureMain",
        json!({ "workspaceId": workspace_id }),
    )
    .await;
    call(
        &transport,
        &handle,
        3,
        "secrets.write",
        json!({
            "workspaceId": workspace_id,
            "versionId": "main",
            "path": ".env",
            "text": "MAIN=1",
            "origin": "api",
            "momentId": "secret-main-before-apply",
        }),
    )
    .await;
    let feature = call(
        &transport,
        &handle,
        4,
        "versions.createNamed",
        json!({
            "workspaceId": workspace_id,
            "name": "feature",
            "fromVersionId": "main",
        }),
    )
    .await;
    let feature_id = feature["id"].as_str().expect("feature id");
    call(
        &transport,
        &handle,
        5,
        "secrets.write",
        json!({
            "workspaceId": workspace_id,
            "versionId": feature_id,
            "path": ".env",
            "text": "FEATURE=1",
            "origin": "api",
            "momentId": "secret-feature-before-apply",
        }),
    )
    .await;
    call(
        &transport,
        &handle,
        6,
        "versions.setActive",
        json!({ "workspaceId": workspace_id, "versionId": feature_id }),
    )
    .await;
    let applied = call(
        &transport,
        &handle,
        7,
        "secrets.apply",
        json!({
            "workspaceId": workspace_id,
            "path": ".env",
            "sourceVersionId": feature_id,
            "targetVersionId": "main",
            "momentId": "secret-explicit-target-apply",
            "origin": "api",
            "summary": "Updated .env from feature",
            "correlationId": "merge-correlation-1",
        }),
    )
    .await;
    assert_eq!(applied["changed"], true);
    assert_eq!(applied["moment"]["id"], "secret-explicit-target-apply");
    assert_eq!(applied["moment"]["versionId"], "main");
    assert_eq!(applied["moment"]["metadata"]["origin"], "api");
    assert_eq!(
        applied["moment"]["metadata"]["summary"],
        "Updated .env from feature"
    );
    assert_eq!(
        applied["moment"]["metadata"]["correlationId"],
        "merge-correlation-1"
    );
    let invalid_origin = transport
        .call(
            RequestContext::unbounded(),
            request(
                8,
                "secrets.apply",
                Some(handle),
                json!({
                    "workspaceId": workspace_id,
                    "path": ".env",
                    "sourceVersionId": feature_id,
                    "targetVersionId": "main",
                    "momentId": "secret-invalid-origin-apply",
                    "origin": "capture",
                }),
            ),
        )
        .await
        .expect_err("apply origin uses the closed five-value set");
    assert_eq!(invalid_origin.message, "invalid-metadata");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn secrets_apply_fresh_workspace_returns_invalid_version() {
    // MUTATION: return the no-key/no-state early answer before validating versions -> this succeeds.
    let (_scratch, transport, handle) = fixture("secret-apply-fresh").await;
    let error = transport
        .call(
            RequestContext::unbounded(),
            request(
                2,
                "secrets.apply",
                Some(handle),
                json!({
                    "workspaceId": "ws-rpcd-secret-apply-fresh",
                    "path": ".env",
                    "sourceVersionId": "feature",
                    "targetVersionId": "main",
                    "momentId": "secret-fresh-apply",
                    "origin": "sync",
                }),
            ),
        )
        .await
        .expect_err("fresh workspace has no target version");
    assert_eq!(error.message, "invalid-version");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn rpc_secret_delete_records_a_completed_generation_marker() {
    // MUTATION: gate the delete marker on capture-retire only -> this row is absent.
    let (scratch, transport, handle) = fixture("secret-delete-marker").await;
    let workspace_id = "ws-rpcd-secret-delete-marker";
    call(
        &transport,
        &handle,
        2,
        "versions.ensureMain",
        json!({ "workspaceId": workspace_id }),
    )
    .await;
    call(
        &transport,
        &handle,
        3,
        "secrets.write",
        json!({
            "workspaceId": workspace_id,
            "versionId": "main",
            "path": ".env",
            "text": "TOKEN=delete-me",
            "origin": "api",
            "momentId": "rpc-secret-write-before-delete",
        }),
    )
    .await;
    call(
        &transport,
        &handle,
        4,
        "secrets.delete",
        json!({
            "workspaceId": workspace_id,
            "versionId": "main",
            "path": ".env",
            "origin": "api",
            "momentId": "rpc-secret-delete",
        }),
    )
    .await;

    let connection =
        rusqlite::Connection::open(scratch.path().join(".dohc/engine/engine.db")).expect("sqlite");
    let marker: (String, i64) = connection
        .query_row(
            "SELECT status, target_generation FROM materialization_jobs \
             WHERE job_id = 'secret-mat_rpc-secret-delete'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("completed secret delete marker");
    let moment_order: i64 = connection
        .query_row(
            "SELECT moment_order FROM secret_moments WHERE moment_id = 'rpc-secret-delete'",
            [],
            |row| row.get(0),
        )
        .expect("delete moment");
    assert_eq!(marker.0, "complete");
    assert_eq!(marker.1, moment_order);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn secrets_apply_rejects_non_secret_path_before_key_handling() {
    // MUTATION: move the secret-path gate after key/version handling -> the two errors diverge.
    let (scratch, transport, handle) = fixture("secret-apply-path-gate").await;
    let params = json!({
        "workspaceId": "ws-rpcd-secret-apply-path-gate",
        "path": "plain.txt",
        "sourceVersionId": "feature",
        "targetVersionId": "main",
        "momentId": "secret-non-secret-apply",
        "origin": "sync",
    });
    for (id, key_present) in [(2, false), (3, true)] {
        if key_present {
            dohc_engine_crypto::create_key_file(scratch.path()).expect("create key file");
        }
        let error = transport
            .call(
                RequestContext::unbounded(),
                request(id, "secrets.apply", Some(handle.clone()), params.clone()),
            )
            .await
            .expect_err("non-secret path must be refused");
        assert_eq!(error.message, "not-secret-path");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn secret_require_version_wire_code_is_invalid_version() {
    // MUTATION: restore the text-domain VersionNotFound code in secrets::require_version -> fails.
    let (_scratch, transport, handle) = fixture("secret-invalid-version").await;
    let error = transport
        .call(
            RequestContext::unbounded(),
            request(
                2,
                "secrets.fork",
                Some(handle),
                json!({
                    "workspaceId": "ws-rpcd-secret-invalid-version",
                    "fromVersionId": "missing",
                    "toVersionId": "main",
                }),
            ),
        )
        .await
        .expect_err("unknown secret version");
    assert_eq!(error.message, "invalid-version");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn request_id_replay_is_deduped_and_reuse_mismatch_is_refused() {
    // MUTATION: ignore the request ledger -> replay creates a second moment.
    let (_scratch, transport, handle) = fixture("request-id").await;
    let first = write(&transport, &handle, 2, "id.md", "same", "stable-id").await;
    let replay = write(&transport, &handle, 3, "id.md", "same", "stable-id").await;
    assert_eq!(replay["deduped"], true);
    assert_eq!(replay["moment"]["momentId"], first["moment"]["momentId"]);
    assert_eq!(moments(&transport, &handle, 4).await.len(), 1);
    // MUTATION: omit origin/author from the write ledger hash -> this silently replays.
    let origin_flip = transport
        .call(
            RequestContext::unbounded(),
            request(
                40,
                "versionedText.write",
                Some(handle.clone()),
                json!({ "versionId": "main", "path": "id.md", "text": "same", "origin": "sync", "requestId": "stable-id" }),
            ),
        )
        .await
        .expect_err("write provenance mismatch");
    assert_eq!(origin_flip.message, "idempotency-key-reuse-mismatch");
    let mismatch = transport
        .call(
            RequestContext::unbounded(),
            request(
                5,
                "versionedText.write",
                Some(handle.clone()),
                json!({ "versionId": "main", "path": "id.md", "text": "different", "origin": "api", "requestId": "stable-id" }),
            ),
        )
        .await
        .expect_err("reuse mismatch");
    assert_eq!(mismatch.message, "idempotency-key-reuse-mismatch");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn moment_id_collision_rejects_different_payload_and_replays_exact_payload() {
    // MUTATION: silently overwrite a colliding moment id -> the refusal assertion fails.
    let (_scratch, transport, handle) = fixture("moment-id").await;
    let params = json!({ "versionId": "main", "path": "moment.md", "text": "same", "origin": "api", "momentId": "fixed-moment" });
    call(
        &transport,
        &handle,
        2,
        "versionedText.write",
        params.clone(),
    )
    .await;
    let exact = call(&transport, &handle, 3, "versionedText.write", params).await;
    assert_eq!(exact["deduped"], true);
    let mismatch = transport
        .call(
            RequestContext::unbounded(),
            request(4, "versionedText.write", Some(handle.clone()), json!({ "versionId": "main", "path": "moment.md", "text": "other", "origin": "api", "momentId": "fixed-moment" })),
        )
        .await
        .expect_err("collision");
    assert_eq!(mismatch.message, "duplicate-id");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn origin_closed_set_rejects_capture_and_ydoc() {
    // MUTATION: admit reserved origins or reject one of the public five -> this test fails.
    let (_scratch, transport, handle) = fixture("origins").await;
    for (offset, origin) in ["api", "local-file", "restore", "sync", "unknown"]
        .into_iter()
        .enumerate()
    {
        call(
            &transport,
            &handle,
            2 + offset as u64,
            "versionedText.write",
            json!({
                "versionId": "main",
                "path": format!("accepted-{origin}.md"),
                "text": "x",
                "origin": origin,
                "requestId": format!("accepted-{origin}"),
            }),
        )
        .await;
    }
    for (id, origin) in [(20, "capture"), (21, "ydoc")] {
        let error = transport
            .call(
                RequestContext::unbounded(),
                request(id, "versionedText.write", Some(handle.clone()), json!({ "versionId": "main", "path": format!("{origin}.md"), "text": "x", "origin": origin, "requestId": format!("origin-{origin}") })),
            )
            .await
            .expect_err("reserved origin");
        assert_eq!(error.message, "invalid-metadata");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn raw_text_and_secret_bodies_round_trip_byte_identical() {
    // MUTATION: re-add trimming, CRLF rewriting, or body NFC normalization -> either equality fails.
    let (_scratch, transport, handle) = fixture("raw-bodies").await;
    let body = "  leading\r\ntrailing  ";
    let written = write(&transport, &handle, 2, "raw.md", body, "raw-body").await;
    assert_eq!(written["snapshot"]["text"], body);
    let read = call(
        &transport,
        &handle,
        3,
        "versionedText.read",
        json!({ "versionId": "main", "path": "raw.md" }),
    )
    .await;
    assert_eq!(read["text"], body);
    call(
        &transport,
        &handle,
        4,
        "secrets.write",
        json!({
            "workspaceId": "ws-rpcd-raw-bodies",
            "versionId": "main",
            "path": ".env",
            "text": body,
            "origin": "api",
            "momentId": "raw-secret",
        }),
    )
    .await;
    let materialized = call(
        &transport,
        &handle,
        5,
        "secrets.materialize",
        json!({
            "versionId": "main",
            "path": ".env",
        }),
    )
    .await;
    assert_eq!(materialized["text"], body);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn rename_is_one_moment_atomic_and_secret_floor_is_enforced() {
    // MUTATION: emit two moments, leave the old alias, or skip the secret-floor gate -> assertions fail.
    let (_scratch, transport, handle) = fixture("rename").await;
    write(
        &transport,
        &handle,
        2,
        "old.md",
        "searchable",
        "rename-seed",
    )
    .await;
    let renamed = call(&transport, &handle, 3, "versionedText.rename", json!({ "versionId": "main", "fromPath": "old.md", "toPath": "new.md", "origin": "api", "requestId": "rename-1" })).await;
    assert_eq!(renamed["moment"]["operation"], "rename");
    assert!(renamed["before"].get("text").is_none());
    assert!(renamed["after"].get("text").is_none());
    assert!(
        call(
            &transport,
            &handle,
            4,
            "versionedText.read",
            json!({ "versionId": "main", "path": "old.md" })
        )
        .await
        .is_null()
    );
    assert_eq!(
        call(
            &transport,
            &handle,
            5,
            "versionedText.read",
            json!({ "versionId": "main", "path": "new.md" })
        )
        .await["text"],
        "searchable"
    );
    assert_eq!(moments(&transport, &handle, 6).await.len(), 2);
    let secret = transport.call(RequestContext::unbounded(), request(7, "versionedText.rename", Some(handle.clone()), json!({ "versionId": "main", "fromPath": "new.md", "toPath": ".env", "origin": "api", "requestId": "rename-secret" }))).await.expect_err("secret floor");
    assert_eq!(secret.message, "invalid-path");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn rename_request_id_replay_is_deduped_and_reuse_mismatch_is_refused() {
    // MUTATION: skip the ledger check -> a replayed rename double-moves the alias.
    let (_scratch, transport, handle) = fixture("rename-request-id").await;
    write(&transport, &handle, 2, "old.md", "body", "rename-id-seed").await;
    let params = json!({ "versionId": "main", "fromPath": "old.md", "toPath": "new.md", "origin": "api", "requestId": "rename-stable" });
    let first = call(
        &transport,
        &handle,
        3,
        "versionedText.rename",
        params.clone(),
    )
    .await;
    let replay = call(
        &transport,
        &handle,
        4,
        "versionedText.rename",
        params.clone(),
    )
    .await;
    assert_eq!(replay["deduped"], true);
    assert_eq!(replay["moment"]["momentId"], first["moment"]["momentId"]);
    let after_replay = moments(&transport, &handle, 5).await.len();
    assert_eq!(after_replay, 2);
    // MUTATION: omit origin/author from the rename ledger hash -> this silently replays.
    let mut flipped = params.clone();
    flipped["origin"] = json!("sync");
    let origin_flip = transport
        .call(
            RequestContext::unbounded(),
            request(40, "versionedText.rename", Some(handle.clone()), flipped),
        )
        .await
        .expect_err("rename provenance mismatch");
    assert_eq!(origin_flip.message, "idempotency-key-reuse-mismatch");

    let mismatch = transport
        .call(
            RequestContext::unbounded(),
            request(6, "versionedText.rename", Some(handle.clone()), json!({ "versionId": "main", "fromPath": "old.md", "toPath": "other.md", "origin": "api", "requestId": "rename-stable" })),
        )
        .await
        .expect_err("rename reuse mismatch");
    assert_eq!(mismatch.message, "idempotency-key-reuse-mismatch");
    assert_eq!(moments(&transport, &handle, 7).await.len(), after_replay);
    assert_eq!(
        call(
            &transport,
            &handle,
            8,
            "versionedText.read",
            json!({ "versionId": "main", "path": "new.md" })
        )
        .await["text"],
        "body"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn delete_commits_without_a_disk_confirmation_gate() {
    // ANTI-REGRESSION: importing a desktop disk-confirm gate would make this DB-only delete block.
    let (_scratch, transport, handle) = fixture("delete").await;
    write(&transport, &handle, 2, "gone.md", "gone", "delete-seed").await;
    let deleted = call(
        &transport,
        &handle,
        3,
        "versionedText.delete",
        json!({ "versionId": "main", "path": "gone.md", "origin": "api", "requestId": "delete-1" }),
    )
    .await;
    assert_eq!(deleted["moment"]["operation"], "delete");
    assert!(deleted["before"].get("text").is_none());
    assert!(
        call(
            &transport,
            &handle,
            4,
            "versionedText.read",
            json!({ "versionId": "main", "path": "gone.md" })
        )
        .await
        .is_null()
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn delete_request_id_replay_is_deduped_and_reuse_mismatch_is_refused() {
    // MUTATION: skip the ledger check -> a replayed delete re-enters the absent-head mutation path.
    let (_scratch, transport, handle) = fixture("delete-request-id").await;
    write(&transport, &handle, 2, "gone.md", "gone", "delete-id-seed").await;
    write(&transport, &handle, 3, "keep.md", "keep", "delete-id-keep").await;
    let params = json!({ "versionId": "main", "path": "gone.md", "origin": "api", "requestId": "delete-stable" });
    let first = call(
        &transport,
        &handle,
        4,
        "versionedText.delete",
        params.clone(),
    )
    .await;
    let replay = call(
        &transport,
        &handle,
        5,
        "versionedText.delete",
        params.clone(),
    )
    .await;
    assert_eq!(replay["deduped"], true);
    assert_eq!(replay["moment"]["momentId"], first["moment"]["momentId"]);
    let after_replay = moments(&transport, &handle, 6).await.len();
    assert_eq!(after_replay, 3);
    // MUTATION: omit origin/author from the delete ledger hash -> this silently replays.
    let mut flipped = params.clone();
    flipped["origin"] = json!("sync");
    let origin_flip = transport
        .call(
            RequestContext::unbounded(),
            request(40, "versionedText.delete", Some(handle.clone()), flipped),
        )
        .await
        .expect_err("delete provenance mismatch");
    assert_eq!(origin_flip.message, "idempotency-key-reuse-mismatch");

    let mismatch = transport
        .call(
            RequestContext::unbounded(),
            request(7, "versionedText.delete", Some(handle.clone()), json!({ "versionId": "main", "path": "keep.md", "origin": "api", "requestId": "delete-stable" })),
        )
        .await
        .expect_err("delete reuse mismatch");
    assert_eq!(mismatch.message, "idempotency-key-reuse-mismatch");
    assert_eq!(moments(&transport, &handle, 8).await.len(), after_replay);
    assert_eq!(
        call(
            &transport,
            &handle,
            9,
            "versionedText.read",
            json!({ "versionId": "main", "path": "keep.md" })
        )
        .await["text"],
        "keep"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn rollback_request_id_replay_is_a_no_op_and_reuse_mismatch_is_refused() {
    // MUTATION: skip the ledger check -> replay re-deletes the moment and re-enqueues compensation.
    let (_scratch, transport, handle) = fixture("rollback-request-id").await;
    let before = write(
        &transport,
        &handle,
        2,
        "doc.md",
        "before",
        "rollback-before",
    )
    .await;
    let mutation = write(&transport, &handle, 3, "doc.md", "after", "rollback-after").await;
    let params = json!({ "versionId": "main", "path": "doc.md", "mutationMomentId": mutation["moment"]["momentId"], "origin": "restore", "requestId": "rollback-stable" });
    let first = call(
        &transport,
        &handle,
        4,
        "versionedText.rollback",
        params.clone(),
    )
    .await;
    assert_eq!(first["deduped"], false);
    let replay = call(
        &transport,
        &handle,
        5,
        "versionedText.rollback",
        params.clone(),
    )
    .await;
    assert_eq!(replay["deduped"], true);
    let after_replay = moments(&transport, &handle, 6).await.len();
    assert_eq!(after_replay, 1);
    // MUTATION: omit legacyBeforeText from the rollback ledger hash -> a
    // different legacy preimage silently replays as deduped.
    let mut legacy_flip = params.clone();
    legacy_flip["legacyBeforeText"] = json!("a different legacy preimage");
    let legacy_mismatch = transport
        .call(
            RequestContext::unbounded(),
            request(
                39,
                "versionedText.rollback",
                Some(handle.clone()),
                legacy_flip,
            ),
        )
        .await
        .expect_err("rollback legacy-preimage mismatch");
    assert_eq!(legacy_mismatch.message, "idempotency-key-reuse-mismatch");

    // MUTATION: omit origin/author from the rollback ledger hash -> this silently replays.
    let mut flipped = params.clone();
    flipped["origin"] = json!("api");
    let origin_flip = transport
        .call(
            RequestContext::unbounded(),
            request(40, "versionedText.rollback", Some(handle.clone()), flipped),
        )
        .await
        .expect_err("rollback provenance mismatch");
    assert_eq!(origin_flip.message, "idempotency-key-reuse-mismatch");

    let mismatch = transport
        .call(
            RequestContext::unbounded(),
            request(7, "versionedText.rollback", Some(handle.clone()), json!({ "versionId": "main", "path": "doc.md", "mutationMomentId": before["moment"]["momentId"], "origin": "restore", "requestId": "rollback-stable" })),
        )
        .await
        .expect_err("rollback reuse mismatch");
    assert_eq!(mismatch.message, "idempotency-key-reuse-mismatch");
    assert_eq!(moments(&transport, &handle, 8).await.len(), after_replay);
    assert_eq!(
        call(
            &transport,
            &handle,
            9,
            "versionedText.read",
            json!({ "versionId": "main", "path": "doc.md" })
        )
        .await["text"],
        "before"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn binary_rollback_enqueues_compensation_and_cancels_the_original() {
    // MUTATION: drop compensating restore or original-job cancellation -> disk remains/reappears.
    let (scratch, transport, handle) = fixture("rollback-binary").await;
    let write = call(&transport, &handle, 2, "versionedBinary.write", json!({ "versionId": "main", "path": "rollback.bin", "bytes": [4, 3, 2, 1], "origin": "api" })).await;
    call(&transport, &handle, 3, "versionedText.rollback", json!({ "versionId": "main", "path": "rollback.bin", "mutationMomentId": write["moment"]["momentId"], "origin": "restore" })).await;
    assert!(!scratch.path().join("rollback.bin").exists());
    assert!(
        call(
            &transport,
            &handle,
            4,
            "versionedBinary.read",
            json!({ "versionId": "main", "path": "rollback.bin" })
        )
        .await
        .is_null()
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn rollback_rejects_sync_record_only_moment() {
    // MUTATION: allow a replication marker to drive rollback -> this call succeeds.
    use dohc_engine_domain::{NoFaults, VersionedTextStore, WriteText};
    use dohc_engine_storage::EngineStore;

    let scratch = ScratchDir::new().expect("scratch");
    write_shadow_marker_for_harness(scratch.path(), TOKEN).expect("marker");
    let db_path = scratch.path().join(".dohc/engine/engine.db");
    std::fs::create_dir_all(db_path.parent().expect("engine dir")).expect("engine dir");
    {
        let mut store = EngineStore::open(&db_path, 1).expect("store");
        store.bind_shadow_clone_token(TOKEN).expect("bind token");
        let faults = NoFaults;
        let mut versioned = VersionedTextStore::new(&mut store);
        versioned
            .ensure_main_version("ws-rpcd-sync-only", "main", 1, &faults)
            .expect("main");
        versioned
            .write_text(
                &WriteText {
                    workspace_id: "ws-rpcd-sync-only".to_owned(),
                    version_id: "main".to_owned(),
                    object_id: "sync-object".to_owned(),
                    path: "sync.md".to_owned(),
                    text: "sync".to_owned(),
                    moment_id: "sync-marker".to_owned(),
                    metadata_origin: "api".to_owned(),
                    author_json: None,
                    now_ms: 2,
                    request_id: None,
                },
                &faults,
            )
            .expect("write");
    }
    let connection = rusqlite::Connection::open(&db_path).expect("sqlite");
    connection
        .execute(
            "UPDATE moments SET sync_record_only = 1 WHERE moment_id = 'sync-marker'",
            [],
        )
        .expect("mark sync-only");
    drop(connection);

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
                    "workspaceId": "ws-rpcd-sync-only",
                }),
            ),
        )
        .await
        .expect("open");
    let handle = serde_json::from_value(opened.result["workspace"].clone()).expect("handle");
    let error = transport
        .call(
            RequestContext::unbounded(),
            request(
                2,
                "versionedText.rollback",
                Some(handle),
                json!({
                    "versionId": "main",
                    "path": "sync.md",
                    "mutationMomentId": "sync-marker",
                    "origin": "restore",
                }),
            ),
        )
        .await
        .expect_err("sync-only rollback");
    assert_eq!(error.message, "invalid-input");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn leased_doc_rejects_write_rename_delete_and_rollback() {
    // MUTATION: remove any per-RPC lease guard -> that mutation lands behind the live editor.
    let (_scratch, transport, handle) = fixture("leases").await;
    let seed = write(&transport, &handle, 2, "leased.md", "held", "lease-seed").await;
    let opened = call(
        &transport,
        &handle,
        3,
        "ydoc.open",
        json!({ "versionId": "main", "path": "leased.md" }),
    )
    .await;
    let calls = [
        (
            4,
            "versionedText.write",
            json!({ "versionId": "main", "path": "leased.md", "text": "blocked", "origin": "api", "requestId": "lease-write" }),
        ),
        (
            5,
            "versionedText.rename",
            json!({ "versionId": "main", "fromPath": "leased.md", "toPath": "other.md", "origin": "api", "requestId": "lease-rename" }),
        ),
        (
            6,
            "versionedText.delete",
            json!({ "versionId": "main", "path": "leased.md", "origin": "api", "requestId": "lease-delete" }),
        ),
        (
            7,
            "versionedText.rollback",
            json!({ "versionId": "main", "path": "leased.md", "mutationMomentId": seed["moment"]["momentId"], "origin": "restore" }),
        ),
    ];
    for (id, method, params) in calls {
        let error = transport
            .call(
                RequestContext::unbounded(),
                request(id, method, Some(handle.clone()), params),
            )
            .await
            .expect_err("leased mutation");
        assert_eq!(error.message, "ydoc-session-busy", "{method}");
    }
    call(
        &transport,
        &handle,
        8,
        "ydoc.close",
        json!({ "sessionId": opened["sessionId"], "settle": false }),
    )
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fts_is_maintained_in_each_mutation_transaction() {
    // MUTATION: defer FTS update outside the mutation transaction -> an immediate query is stale.
    let (scratch, transport, handle) = fixture("fts").await;
    write(
        &transport,
        &handle,
        2,
        "alpha.md",
        "uniqueterm",
        "fts-write",
    )
    .await;
    let hit = call(
        &transport,
        &handle,
        3,
        "search.query",
        json!({ "versionId": "main", "query": "uniqueterm" }),
    )
    .await;
    assert!(!hit.as_array().expect("results").is_empty());
    call(&transport, &handle, 4, "versionedText.rename", json!({ "versionId": "main", "fromPath": "alpha.md", "toPath": "beta.md", "origin": "api", "requestId": "fts-rename" })).await;
    let renamed = call(
        &transport,
        &handle,
        5,
        "search.query",
        json!({ "versionId": "main", "query": "uniqueterm" }),
    )
    .await;
    assert_eq!(renamed[0]["path"], "beta.md");
    let deleted = call(&transport, &handle, 6, "versionedText.delete", json!({ "versionId": "main", "path": "beta.md", "origin": "api", "requestId": "fts-delete" })).await;
    let gone = call(
        &transport,
        &handle,
        7,
        "search.query",
        json!({ "versionId": "main", "query": "uniqueterm" }),
    )
    .await;
    assert!(gone.as_array().expect("results").is_empty());
    call(&transport, &handle, 8, "versionedText.rollback", json!({ "versionId": "main", "path": "beta.md", "mutationMomentId": deleted["moment"]["momentId"], "origin": "restore" })).await;
    let restored = call(
        &transport,
        &handle,
        9,
        "search.query",
        json!({ "versionId": "main", "query": "uniqueterm" }),
    )
    .await;
    assert_eq!(restored[0]["path"], "beta.md");
    std::fs::write(scratch.path().join("beta.md"), b"uniqueterm").expect("matching preimage");
    call(
        &transport,
        &handle,
        10,
        "versionedBinary.write",
        json!({ "versionId": "main", "path": "beta.md", "bytes": [0, 255], "origin": "api" }),
    )
    .await;
    let binary_gone = call(
        &transport,
        &handle,
        11,
        "search.query",
        json!({ "versionId": "main", "query": "uniqueterm" }),
    )
    .await;
    assert!(binary_gone.as_array().expect("results").is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn degraded_policy_write_invalidates_healthy_state_and_rebuilds_after_restore() {
    // MUTATION: skip degraded-write search-state invalidation -> restored ensure
    // trusts the old healthy generation and this new file stays unsearchable.
    let (scratch, transport, handle) = fixture("degraded-write-rebuild").await;
    let workspace_id = "ws-rpcd-degraded-write-rebuild";
    call(
        &transport,
        &handle,
        2,
        "versions.ensureMain",
        json!({ "workspaceId": workspace_id }),
    )
    .await;
    call(
        &transport,
        &handle,
        3,
        "search.ensureIndex",
        json!({ "workspaceId": workspace_id, "versionId": "main" }),
    )
    .await;

    let policy_path = scratch.path().join(".dohc/files.toml");
    std::fs::write(&policy_path, "not = valid [[[ ").expect("break files policy");
    write(
        &transport,
        &handle,
        4,
        "written-while-degraded.md",
        "degraded-window-needle",
        "degraded-window-write",
    )
    .await;
    std::fs::remove_file(policy_path).expect("restore default policy");

    call(
        &transport,
        &handle,
        5,
        "search.ensureIndex",
        json!({ "workspaceId": workspace_id, "versionId": "main" }),
    )
    .await;
    let results = call(
        &transport,
        &handle,
        6,
        "search.query",
        json!({ "versionId": "main", "query": "degraded-window-needle" }),
    )
    .await;
    assert!(
        results
            .as_array()
            .expect("results")
            .iter()
            .any(|row| row["path"] == "written-while-degraded.md")
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn binary_rename_does_not_create_an_empty_fts_row() {
    // MUTATION: unconditionally upsert the renamed head into FTS -> the raw row count becomes one.
    let (scratch, transport, handle) = fixture("binary-rename-fts").await;
    call(
        &transport,
        &handle,
        2,
        "versionedBinary.write",
        json!({ "versionId": "main", "path": "old.bin", "bytes": [1], "origin": "api" }),
    )
    .await;
    call(
        &transport,
        &handle,
        3,
        "versionedText.rename",
        json!({
            "versionId": "main",
            "fromPath": "old.bin",
            "toPath": "new.bin",
            "origin": "api",
            "requestId": "binary-rename-fts",
        }),
    )
    .await;
    call(&transport, &handle, 4, "workspace.close", json!({})).await;
    let store =
        dohc_engine_storage::EngineStore::open(&scratch.path().join(".dohc/engine/engine.db"), 1)
            .expect("store");
    let rows: i64 = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM engine_search_files_fts WHERE workspace_id=?1 AND version_id='main' AND path='new.bin'",
                ["ws-rpcd-binary-rename-fts"],
                |row| row.get(0),
            )
        })
        .expect("fts count");
    assert_eq!(rows, 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn deduped_text_write_does_not_resurrect_a_moved_fts_row() {
    // MUTATION: run the FTS upsert for a requestId replay -> stale.md reappears in search.
    let (_scratch, transport, handle) = fixture("deduped-write-fts").await;
    let params = json!({
        "versionId": "main",
        "path": "stale.md",
        "text": "unique-replay-term",
        "origin": "api",
        "requestId": "fts-write-replay",
    });
    call(
        &transport,
        &handle,
        2,
        "versionedText.write",
        params.clone(),
    )
    .await;
    call(
        &transport,
        &handle,
        3,
        "versionedText.rename",
        json!({
            "versionId": "main",
            "fromPath": "stale.md",
            "toPath": "current.md",
            "origin": "api",
            "requestId": "fts-move",
        }),
    )
    .await;
    let replay = call(&transport, &handle, 4, "versionedText.write", params).await;
    assert_eq!(replay["deduped"], true);
    let results = call(
        &transport,
        &handle,
        5,
        "search.query",
        json!({ "versionId": "main", "query": "unique-replay-term" }),
    )
    .await;
    let paths: Vec<&str> = results
        .as_array()
        .expect("results")
        .iter()
        .filter_map(|row| row["path"].as_str())
        .collect();
    assert_eq!(paths, ["current.md"]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn replayed_binary_write_does_not_delete_live_text_fts_row() {
    // MUTATION: delete the binary object's FTS row before the dedup short-circuit
    // -> replay removes the newer text head from search.
    let (_scratch, transport, handle) = fixture("binary-replay-live-text-fts").await;
    let binary_params = json!({
        "versionId": "main",
        "objectId": "replayed-object",
        "path": "replayed.md",
        "bytes": [1, 2, 3],
        "origin": "api",
        "requestId": "earlier-binary-request",
    });
    call(
        &transport,
        &handle,
        2,
        "versionedBinary.write",
        binary_params.clone(),
    )
    .await;
    call(
        &transport,
        &handle,
        3,
        "versionedText.write",
        json!({
            "versionId": "main",
            "objectId": "replayed-object",
            "path": "replayed.md",
            "text": "live-text-search-needle",
            "origin": "api",
            "requestId": "newer-text-request",
        }),
    )
    .await;
    let before = call(
        &transport,
        &handle,
        4,
        "search.query",
        json!({ "versionId": "main", "query": "live-text-search-needle" }),
    )
    .await;
    assert_eq!(before[0]["path"], "replayed.md");

    let replay = call(
        &transport,
        &handle,
        5,
        "versionedBinary.write",
        binary_params,
    )
    .await;
    assert_eq!(replay["deduped"], true);
    let after = call(
        &transport,
        &handle,
        6,
        "search.query",
        json!({ "versionId": "main", "query": "live-text-search-needle" }),
    )
    .await;
    assert_eq!(after[0]["path"], "replayed.md");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn search_ensure_index_is_idempotent() {
    // MUTATION: make ensure append duplicate state or fail on an existing generation -> second call fails.
    let (_scratch, transport, handle) = fixture("search-ensure").await;
    write(
        &transport,
        &handle,
        2,
        "searchable.md",
        "needle-for-explicit-rebuild",
        "search-ensure-write",
    )
    .await;
    for id in [3, 4] {
        let ensured = call(
            &transport,
            &handle,
            id,
            "search.ensureIndex",
            json!({
                "workspaceId": "ws-rpcd-search-ensure",
                "versionId": "main",
            }),
        )
        .await;
        assert_eq!(ensured, json!({}));
    }
    let results = call(
        &transport,
        &handle,
        5,
        "search.query",
        json!({ "versionId": "main", "query": "explicit-rebuild" }),
    )
    .await;
    assert!(
        results
            .as_array()
            .expect("search results")
            .iter()
            .any(|row| row["path"] == "searchable.md")
    );
}

fn seed_versions(root: &Path, workspace_id: &str) {
    use dohc_engine_domain::{
        CreateNamedVersion, NoFaults, VersionedTextStore, WriteBinary, WriteText,
    };
    use dohc_engine_storage::EngineStore;

    std::fs::create_dir_all(root.join(".dohc/engine")).expect("engine dir");
    let mut store = EngineStore::open(&root.join(".dohc/engine/engine.db"), 1).expect("store");
    // The seed CREATES the engine db, so the shadow token must bind here —
    // a pre-existing unbound db is exactly what the fence refuses at
    // workspace.open.
    store.bind_shadow_clone_token(TOKEN).expect("bind token");
    let faults = NoFaults;
    let mut versioned = VersionedTextStore::new(&mut store);
    versioned
        .ensure_main_version(workspace_id, "main", 1, &faults)
        .expect("main");
    versioned
        .write_text(
            &WriteText {
                workspace_id: workspace_id.to_owned(),
                version_id: "main".to_owned(),
                object_id: "base-object".to_owned(),
                path: "merge.md".to_owned(),
                text: "base".to_owned(),
                moment_id: "base-moment".to_owned(),
                metadata_origin: "api".to_owned(),
                author_json: None,
                now_ms: 2,
                request_id: None,
            },
            &faults,
        )
        .expect("base");
    versioned
        .create_named_version(
            &CreateNamedVersion {
                workspace_id: workspace_id.to_owned(),
                new_version_id: "feature".to_owned(),
                name: "Feature".to_owned(),
                from_version_id: "main".to_owned(),
                now_ms: 3,
                request_id: None,
            },
            &faults,
        )
        .expect("fork");
    versioned
        .write_text(
            &WriteText {
                workspace_id: workspace_id.to_owned(),
                version_id: "feature".to_owned(),
                object_id: "ignored".to_owned(),
                path: "merge.md".to_owned(),
                text: "incoming".to_owned(),
                moment_id: "incoming-moment".to_owned(),
                metadata_origin: "api".to_owned(),
                author_json: None,
                now_ms: 4,
                request_id: None,
            },
            &faults,
        )
        .expect("incoming");
    versioned
        .write_binary(
            &WriteBinary {
                workspace_id: workspace_id.to_owned(),
                version_id: "feature".to_owned(),
                object_id: "binary-object".to_owned(),
                path: "asset.bin".to_owned(),
                bytes: vec![1, 2, 3],
                moment_id: "binary-moment".to_owned(),
                metadata_origin: "api".to_owned(),
                author_json: None,
                now_ms: 5,
                request_id: None,
            },
            &faults,
        )
        .expect("binary");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn merge_classifies_and_never_inlines_the_merged_body() {
    // MUTATION: inline merged text in the response -> the `text` absence assertion fails.
    let scratch = ScratchDir::new().expect("scratch");
    write_shadow_marker_for_harness(scratch.path(), TOKEN).expect("marker");
    seed_versions(scratch.path(), "ws-rpcd-merge");
    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let opened = transport.call(RequestContext::unbounded(), request(1, "workspace.open", None, json!({ "rootDir": scratch.path().to_string_lossy(), "workspaceId": "ws-rpcd-merge" }))).await.expect("open");
    let handle = serde_json::from_value(opened.result["workspace"].clone()).expect("handle");
    let compared = call(
        &transport,
        &handle,
        2,
        "versionedText.compare",
        json!({ "path": "merge.md", "sourceVersionId": "feature", "targetVersionId": "main" }),
    )
    .await;
    assert_eq!(compared["status"], "merged");
    let merged = call(&transport, &handle, 3, "versionedText.merge", json!({ "path": "merge.md", "sourceVersionId": "feature", "targetVersionId": "main", "origin": "api", "requestId": "merge-1" })).await;
    assert_eq!(merged["status"], "merged");
    assert!(merged["snapshot"].get("text").is_none());
    assert!(merged["moment"]["momentId"].is_string());
    let indexed = call(
        &transport,
        &handle,
        4,
        "search.query",
        json!({ "versionId": "main", "query": "incoming" }),
    )
    .await;
    assert_eq!(indexed[0]["path"], "merge.md");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn merge_request_id_replay_after_target_moves_returns_recorded_outcome() {
    // MUTATION: re-derive replay from current target state -> the original merged variant/id is lost.
    let scratch = ScratchDir::new().expect("scratch");
    write_shadow_marker_for_harness(scratch.path(), TOKEN).expect("marker");
    seed_versions(scratch.path(), "ws-rpcd-merge-request-id");
    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let opened = transport.call(RequestContext::unbounded(), request(1, "workspace.open", None, json!({ "rootDir": scratch.path().to_string_lossy(), "workspaceId": "ws-rpcd-merge-request-id" }))).await.expect("open");
    let handle = serde_json::from_value(opened.result["workspace"].clone()).expect("handle");
    let before = moments(&transport, &handle, 2).await.len();
    let params = json!({ "path": "merge.md", "sourceVersionId": "feature", "targetVersionId": "main", "origin": "api", "requestId": "merge-stable" });
    let first = call(
        &transport,
        &handle,
        3,
        "versionedText.merge",
        params.clone(),
    )
    .await;
    write(
        &transport,
        &handle,
        4,
        "merge.md",
        "target moved on",
        "move-after-merge",
    )
    .await;
    let replay = call(&transport, &handle, 5, "versionedText.merge", params).await;
    assert_eq!(replay["deduped"], true);
    assert_eq!(replay["status"], first["status"]);
    assert_eq!(replay["moment"]["momentId"], first["moment"]["momentId"]);
    let after_replay = moments(&transport, &handle, 6).await.len();
    assert_eq!(after_replay, before + 2);

    let mismatch = transport
        .call(
            RequestContext::unbounded(),
            request(7, "versionedText.merge", Some(handle.clone()), json!({ "path": "other.md", "sourceVersionId": "feature", "targetVersionId": "main", "origin": "api", "requestId": "merge-stable" })),
        )
        .await
        .expect_err("merge reuse mismatch");
    assert_eq!(mismatch.message, "idempotency-key-reuse-mismatch");
    assert_eq!(moments(&transport, &handle, 8).await.len(), after_replay);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn merge_rejects_a_request_id_recorded_by_a_text_write() {
    // MUTATION: treat a foreign-operation ledger payload as a merge replay -> this call succeeds.
    let scratch = ScratchDir::new().expect("scratch");
    write_shadow_marker_for_harness(scratch.path(), TOKEN).expect("marker");
    seed_versions(scratch.path(), "ws-rpcd-merge-cross-kind");
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
                    "workspaceId": "ws-rpcd-merge-cross-kind",
                }),
            ),
        )
        .await
        .expect("open");
    let handle = serde_json::from_value(opened.result["workspace"].clone()).expect("handle");
    write(
        &transport,
        &handle,
        2,
        "cross-kind.md",
        "text ledger payload",
        "cross-kind-request",
    )
    .await;
    let error = transport
        .call(
            RequestContext::unbounded(),
            request(
                3,
                "versionedText.merge",
                Some(handle),
                json!({
                    "path": "merge.md",
                    "sourceVersionId": "feature",
                    "targetVersionId": "main",
                    "origin": "api",
                    "requestId": "cross-kind-request",
                }),
            ),
        )
        .await
        .expect_err("cross-kind request id reuse must fail");
    assert_eq!(error.message, "idempotency-key-reuse-mismatch");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn merge_on_a_leased_target_is_refused() {
    // MUTATION: omit the merge lease guard -> the merge lands behind the editor.
    let scratch = ScratchDir::new().expect("scratch");
    write_shadow_marker_for_harness(scratch.path(), TOKEN).expect("marker");
    seed_versions(scratch.path(), "ws-rpcd-merge-lease");
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
                    "workspaceId": "ws-rpcd-merge-lease",
                }),
            ),
        )
        .await
        .expect("open");
    let handle = serde_json::from_value(opened.result["workspace"].clone()).expect("handle");
    let opened = call(
        &transport,
        &handle,
        2,
        "ydoc.open",
        json!({ "versionId": "main", "path": "merge.md" }),
    )
    .await;
    let error = transport
        .call(
            RequestContext::unbounded(),
            request(
                3,
                "versionedText.merge",
                Some(handle.clone()),
                json!({
                    "path": "merge.md",
                    "sourceVersionId": "feature",
                    "targetVersionId": "main",
                    "origin": "api",
                    "requestId": "merge-leased",
                }),
            ),
        )
        .await
        .expect_err("leased merge");
    assert_eq!(error.message, "ydoc-session-busy");
    call(
        &transport,
        &handle,
        4,
        "ydoc.close",
        json!({ "sessionId": opened["sessionId"], "settle": false }),
    )
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn compare_files_is_paged_and_binary_entry_shape_is_exact() {
    // MUTATION: add binary sha/text fields or drop byte-budget paging -> exact-shape/cursor assertions fail.
    let scratch = ScratchDir::new().expect("scratch");
    write_shadow_marker_for_harness(scratch.path(), TOKEN).expect("marker");
    seed_versions(scratch.path(), "ws-rpcd-compare");
    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let opened = transport.call(RequestContext::unbounded(), request(1, "workspace.open", None, json!({ "rootDir": scratch.path().to_string_lossy(), "workspaceId": "ws-rpcd-compare" }))).await.expect("open");
    let handle = serde_json::from_value(opened.result["workspace"].clone()).expect("handle");
    let page = call(
        &transport,
        &handle,
        2,
        "versions.compareFiles",
        json!({ "sourceVersionId": "feature", "targetVersionId": "main", "byteBudget": 55 }),
    )
    .await;
    assert_eq!(page["entries"].as_array().expect("entries").len(), 1);
    assert!(page["nextCursor"].is_string());
    let cursor = page["nextCursor"].as_str().expect("cursor");
    let tail = call(
        &transport,
        &handle,
        3,
        "versions.compareFiles",
        json!({ "sourceVersionId": "feature", "targetVersionId": "main", "afterPath": cursor }),
    )
    .await;
    let binary = tail["entries"]
        .as_array()
        .expect("tail")
        .iter()
        .chain(page["entries"].as_array().expect("page"))
        .find(|entry| entry["path"] == "asset.bin")
        .cloned()
        .expect("binary entry");
    assert_eq!(binary.as_object().expect("object").len(), 3);
    assert_eq!(binary["binary"], true);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn compare_files_pages_via_db_keyset_not_full_vector() {
    // MUTATION: swap target/source in the SQL -> only-source/only-target statuses flip and fail.
    use dohc_engine_domain::{
        CreateNamedVersion, NoFaults, VersionFileChangeStatus, VersionedTextStore, WriteText,
    };
    use dohc_engine_storage::EngineStore;

    let scratch = ScratchDir::new().expect("scratch");
    write_shadow_marker_for_harness(scratch.path(), TOKEN).expect("marker");
    std::fs::create_dir_all(scratch.path().join(".dohc/engine")).expect("engine dir");
    let db = scratch.path().join(".dohc/engine/engine.db");
    let expected = {
        let mut store = EngineStore::open(&db, 1).expect("store");
        store.bind_shadow_clone_token(TOKEN).expect("bind token");
        let faults = NoFaults;
        let mut versioned = VersionedTextStore::new(&mut store);
        versioned
            .ensure_main_version("ws-rpcd-keyset-compare", "main", 1, &faults)
            .expect("main");
        for index in 0..230 {
            let path = format!("bulk/{index:03}.md");
            versioned
                .write_text(
                    &WriteText {
                        workspace_id: "ws-rpcd-keyset-compare".to_owned(),
                        version_id: "main".to_owned(),
                        object_id: format!("object-{index:03}"),
                        path,
                        text: "target".to_owned(),
                        moment_id: format!("target-{index:03}"),
                        metadata_origin: "api".to_owned(),
                        author_json: None,
                        now_ms: 10 + index,
                        request_id: None,
                    },
                    &faults,
                )
                .expect("target write");
        }
        versioned
            .create_named_version(
                &CreateNamedVersion {
                    workspace_id: "ws-rpcd-keyset-compare".to_owned(),
                    new_version_id: "feature".to_owned(),
                    name: "Feature".to_owned(),
                    from_version_id: "main".to_owned(),
                    now_ms: 500,
                    request_id: None,
                },
                &faults,
            )
            .expect("feature");
        for index in 0..230 {
            let path = format!("bulk/{index:03}.md");
            versioned
                .write_text(
                    &WriteText {
                        workspace_id: "ws-rpcd-keyset-compare".to_owned(),
                        version_id: "feature".to_owned(),
                        object_id: "ignored".to_owned(),
                        path,
                        text: "source".to_owned(),
                        moment_id: format!("source-{index:03}"),
                        metadata_origin: "api".to_owned(),
                        author_json: None,
                        now_ms: 600 + index,
                        request_id: None,
                    },
                    &faults,
                )
                .expect("source write");
        }
        for (version_id, path, object_id, moment_id) in [
            (
                "main",
                "only-target.md",
                "only-target-object",
                "only-target-moment",
            ),
            (
                "feature",
                "only-source.md",
                "only-source-object",
                "only-source-moment",
            ),
        ] {
            versioned
                .write_text(
                    &WriteText {
                        workspace_id: "ws-rpcd-keyset-compare".to_owned(),
                        version_id: version_id.to_owned(),
                        object_id: object_id.to_owned(),
                        path: path.to_owned(),
                        text: path.to_owned(),
                        moment_id: moment_id.to_owned(),
                        metadata_origin: "api".to_owned(),
                        author_json: None,
                        now_ms: 900,
                        request_id: None,
                    },
                    &faults,
                )
                .expect("one-sided write");
        }
        versioned
            .compare_version_files("ws-rpcd-keyset-compare", "feature", "main")
            .expect("full oracle")
            .into_iter()
            .map(|change| {
                let status = match change.status {
                    VersionFileChangeStatus::Added => "added",
                    VersionFileChangeStatus::Modified => "modified",
                    VersionFileChangeStatus::Deleted => "deleted",
                };
                (change.path, status.to_owned())
            })
            .collect::<BTreeMap<_, _>>()
    };

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
                    "workspaceId": "ws-rpcd-keyset-compare",
                }),
            ),
        )
        .await
        .expect("open");
    let handle = serde_json::from_value(opened.result["workspace"].clone()).expect("handle");
    let mut actual = BTreeMap::new();
    let mut cursor: Option<String> = None;
    let mut id = 2;
    loop {
        let mut params = json!({
            "sourceVersionId": "feature",
            "targetVersionId": "main",
        });
        if let Some(after_path) = cursor.as_ref() {
            params["afterPath"] = json!(after_path);
        }
        let page = call(&transport, &handle, id, "versions.compareFiles", params).await;
        id += 1;
        for entry in page["entries"].as_array().expect("entries") {
            actual.insert(
                entry["path"].as_str().expect("path").to_owned(),
                entry["status"].as_str().expect("status").to_owned(),
            );
        }
        cursor = page["nextCursor"].as_str().map(str::to_owned);
        if cursor.is_none() {
            break;
        }
    }
    assert_eq!(actual, expected);
    assert_eq!(actual["only-source.md"], "added");
    assert_eq!(actual["only-target.md"], "deleted");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn named_version_and_active_rpcs_return_full_version_records() {
    // MUTATION: return id-only version responses -> the full-record assertions fail.
    let (_scratch, transport, handle) = fixture("version-rpcs").await;
    write(
        &transport,
        &handle,
        2,
        "seed.md",
        "seed",
        "version-rpc-seed",
    )
    .await;
    let named = call(
        &transport,
        &handle,
        3,
        "versions.createNamed",
        json!({
            "workspaceId": "ws-rpcd-version-rpcs",
            "name": "feature",
            "fromVersionId": "main",
        }),
    )
    .await;
    assert_eq!(named["workspaceId"], "ws-rpcd-version-rpcs");
    assert_eq!(named["kind"], "named");
    assert_eq!(named["forkPoint"]["versionId"], "main");
    let version_id = named["id"].as_str().expect("named id");
    let active = call(
        &transport,
        &handle,
        4,
        "versions.setActive",
        json!({ "workspaceId": "ws-rpcd-version-rpcs", "versionId": version_id }),
    )
    .await;
    assert_eq!(active["id"], version_id);
    let active = call(
        &transport,
        &handle,
        5,
        "versions.active",
        json!({ "workspaceId": "ws-rpcd-version-rpcs" }),
    )
    .await;
    assert_eq!(active["id"], version_id);
    let main = call(
        &transport,
        &handle,
        6,
        "versions.ensureMain",
        json!({ "workspaceId": "ws-rpcd-version-rpcs" }),
    )
    .await;
    assert_eq!(main["id"], "main");
    assert_eq!(main["kind"], "main");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn text_read_returns_binary_head_and_read_blob_reads_by_sha() {
    // MUTATION: keep binary-head refusal or omit by-sha blob lookup -> either read assertion fails.
    let (_scratch, transport, handle) = fixture("binary-read-parity").await;
    let written = call(
        &transport,
        &handle,
        2,
        "versionedBinary.write",
        json!({ "versionId": "main", "path": "asset.bin", "bytes": [1, 2, 3, 4], "origin": "api" }),
    )
    .await;
    let read = call(
        &transport,
        &handle,
        3,
        "versionedText.read",
        json!({ "versionId": "main", "path": "asset.bin" }),
    )
    .await;
    assert_eq!(read["contentKind"], "binary");
    assert_eq!(read["text"], "");
    assert_eq!(read["sha256"], written["snapshot"]["sha256"]);
    assert_eq!(read["byteLength"], 4);
    let blob = call(
        &transport,
        &handle,
        4,
        "versionedBinary.readBlob",
        json!({
            "workspaceId": "ws-rpcd-binary-read-parity",
            "sha256": read["sha256"],
        }),
    )
    .await;
    // Base64 in-band, matching versionedBinary.read's encoding (one payload
    // convention for binary bytes across adjacent RPCs).
    assert_eq!(blob["bytesBase64"], json!("AQIDBA=="));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn read_blob_requires_a_reference_from_the_handle_workspace() {
    // MUTATION: drop the workspace reference check -> workspace B reads workspace A's blobs.
    let (scratch, transport, handle_a) = fixture("blob-scope-a").await;
    let workspace_a = "ws-rpcd-blob-scope-a";
    call(
        &transport,
        &handle_a,
        2,
        "versions.ensureMain",
        json!({ "workspaceId": workspace_a }),
    )
    .await;
    let named = call(
        &transport,
        &handle_a,
        3,
        "versions.createNamed",
        json!({
            "workspaceId": workspace_a,
            "name": "private-binary",
            "fromVersionId": "main",
        }),
    )
    .await;
    let written = call(
        &transport,
        &handle_a,
        4,
        "versionedBinary.write",
        json!({
            "versionId": named["id"],
            "path": "private.bin",
            "bytes": [4, 3, 2, 1],
            "origin": "api",
            "requestId": "private-binary-write",
        }),
    )
    .await;
    let sha256 = written["snapshot"]["sha256"].clone();
    let happy = call(
        &transport,
        &handle_a,
        5,
        "versionedBinary.readBlob",
        json!({ "workspaceId": workspace_a, "sha256": sha256 }),
    )
    .await;
    assert_eq!(happy["bytesBase64"], "BAMCAQ==");

    call(&transport, &handle_a, 6, "workspace.close", json!({})).await;
    let connection =
        rusqlite::Connection::open(scratch.path().join(".dohc/engine/engine.db")).expect("sqlite");
    let conflict_bytes = [8_u8, 6, 7, 5, 3, 0, 9];
    let conflict_sha =
        dohc_engine_storage::put_binary_blob(&connection, &conflict_bytes).expect("conflict blob");
    connection
        .execute(
            "INSERT INTO conflicts (\
                workspace_id, conflict_id, path, target_version_id, source_version_id, \
                created_at_ms, updated_at_ms, status, chosen_from, resolution, metadata_origin, \
                base_exists, base_path, current_exists, current_path, \
                incoming_exists, incoming_path, incoming_content_kind, incoming_binary_sha256\
             ) VALUES (?1, 'conflict-only-binary', 'conflict.bin', 'main', ?2, \
                10, 10, 'open', 'current', NULL, 'sync', \
                0, 'conflict.bin', 0, 'conflict.bin', 1, 'conflict.bin', 'binary', ?3)",
            rusqlite::params![
                workspace_a,
                named["id"].as_str().expect("named id"),
                conflict_sha
            ],
        )
        .expect("seed conflict-side-only binary reference");
    let ordinary_references: i64 = connection
        .query_row(
            "SELECT (SELECT COUNT(*) FROM snapshots WHERE binary_sha256 = ?1) + \
                    (SELECT COUNT(*) FROM moments \
                     WHERE after_binary_sha256 = ?1 OR before_binary_sha256 = ?1)",
            [&conflict_sha],
            |row| row.get(0),
        )
        .expect("count ordinary blob references");
    assert_eq!(
        ordinary_references, 0,
        "the conflict is the blob's only reference"
    );
    drop(connection);

    let reopened_a = transport
        .call(
            RequestContext::unbounded(),
            request(
                7,
                "workspace.open",
                None,
                json!({
                    "rootDir": scratch.path().to_string_lossy(),
                    "workspaceId": workspace_a,
                }),
            ),
        )
        .await
        .expect("reopen workspace A");
    let handle_a: WorkspaceHandle = serde_json::from_value(reopened_a.result["workspace"].clone())
        .expect("reopened workspace A handle");
    // MUTATION: drop the conflicts EXISTS branch -> this conflict-side-only read fails.
    let conflict_happy = call(
        &transport,
        &handle_a,
        8,
        "versionedBinary.readBlob",
        json!({ "workspaceId": workspace_a, "sha256": conflict_sha }),
    )
    .await;
    assert_eq!(conflict_happy["bytesBase64"], "CAYHBQMACQ==");
    call(&transport, &handle_a, 9, "workspace.close", json!({})).await;

    let opened_b = transport
        .call(
            RequestContext::unbounded(),
            request(
                10,
                "workspace.open",
                None,
                json!({
                    "rootDir": scratch.path().to_string_lossy(),
                    "workspaceId": "ws-rpcd-blob-scope-b",
                }),
            ),
        )
        .await
        .expect("open workspace B");
    let handle_b: WorkspaceHandle =
        serde_json::from_value(opened_b.result["workspace"].clone()).expect("workspace B handle");
    let refused = transport
        .call(
            RequestContext::unbounded(),
            request(
                11,
                "versionedBinary.readBlob",
                Some(handle_b.clone()),
                json!({
                    "workspaceId": "ws-rpcd-blob-scope-b",
                    "sha256": sha256,
                }),
            ),
        )
        .await
        .expect_err("workspace B must not read workspace A's blob");
    assert_eq!(refused.message, "file-not-found");
    let conflict_refused = transport
        .call(
            RequestContext::unbounded(),
            request(
                12,
                "versionedBinary.readBlob",
                Some(handle_b),
                json!({
                    "workspaceId": "ws-rpcd-blob-scope-b",
                    "sha256": conflict_sha,
                }),
            ),
        )
        .await
        .expect_err("workspace B must not read workspace A's conflict-only blob");
    assert_eq!(conflict_refused.message, "file-not-found");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn read_blob_canonicalizes_digests_and_rejects_broken_or_length_mismatched_blobs() {
    let (scratch, transport, handle) = fixture("blob-integrity").await;
    let workspace = "ws-rpcd-blob-integrity";
    let written = call(
        &transport,
        &handle,
        2,
        "versionedBinary.write",
        json!({
            "versionId": "main",
            "path": "asset.bin",
            "bytes": [1, 2, 3],
            "origin": "api",
        }),
    )
    .await;
    let sha = written["snapshot"]["sha256"]
        .as_str()
        .expect("sha")
        .to_owned();
    // MUTATION: skip lowercase canonicalization -> the uppercase spelling of a
    // referenced digest misses the exact-match lookup.
    let upper = call(
        &transport,
        &handle,
        3,
        "versionedBinary.readBlob",
        json!({ "workspaceId": workspace, "sha256": sha.to_ascii_uppercase() }),
    )
    .await;
    assert_eq!(upper["bytesBase64"], "AQID");

    call(&transport, &handle, 4, "workspace.close", json!({})).await;
    let connection =
        rusqlite::Connection::open(scratch.path().join(".dohc/engine/engine.db")).expect("sqlite");
    // The FK to binary_blobs normally forbids this state — a broken reference
    // only arises from real corruption (partial restore, FK-off import), which
    // is exactly what the seed simulates.
    connection
        .pragma_update(None, "foreign_keys", "OFF")
        .expect("fk off");
    // A conflict row referencing a digest with NO blob row: a broken durable
    // reference, not an absent digest.
    let phantom_sha = "a".repeat(64);
    // An over-cap blob referenced only by a conflict: the metadata answer must
    // not hydrate it.
    let big_bytes = vec![7_u8; 49_153];
    let big_sha = dohc_engine_storage::put_binary_blob(&connection, &big_bytes).expect("big blob");
    let corrupt_big_bytes = vec![8_u8; 49_153];
    let corrupt_big_sha = dohc_engine_storage::put_binary_blob(&connection, &corrupt_big_bytes)
        .expect("corrupt big blob");
    connection
        .execute(
            "UPDATE binary_blobs SET byte_length = byte_length + 1 WHERE sha256 = ?1",
            [&corrupt_big_sha],
        )
        .expect("corrupt recorded byte length");
    for (conflict_id, referenced_sha) in [
        ("conflict-phantom", phantom_sha.as_str()),
        ("conflict-big", big_sha.as_str()),
        ("conflict-big-length-mismatch", corrupt_big_sha.as_str()),
    ] {
        connection
            .execute(
                "INSERT INTO conflicts (\
                    workspace_id, conflict_id, path, target_version_id, source_version_id, \
                    created_at_ms, updated_at_ms, status, chosen_from, resolution, metadata_origin, \
                    base_exists, base_path, current_exists, current_path, \
                    incoming_exists, incoming_path, incoming_content_kind, incoming_binary_sha256\
                 ) VALUES (?1, ?2, 'conflict.bin', 'main', 'main', \
                    10, 10, 'open', 'current', NULL, 'sync', \
                    0, 'conflict.bin', 0, 'conflict.bin', 1, 'conflict.bin', 'binary', ?3)",
                rusqlite::params![workspace, conflict_id, referenced_sha],
            )
            .expect("seed conflict reference");
    }
    drop(connection);

    let reopened = transport
        .call(
            RequestContext::unbounded(),
            request(
                5,
                "workspace.open",
                None,
                json!({
                    "rootDir": scratch.path().to_string_lossy(),
                    "workspaceId": workspace,
                }),
            ),
        )
        .await
        .expect("reopen");
    let handle: WorkspaceHandle =
        serde_json::from_value(reopened.result["workspace"].clone()).expect("handle");
    // MUTATION: answer Ok(None) for a referenced-but-missing blob -> the broken
    // reference masquerades as a caller mistake instead of failing closed.
    let corrupt = transport
        .call(
            RequestContext::unbounded(),
            request(
                6,
                "versionedBinary.readBlob",
                Some(handle.clone()),
                json!({ "workspaceId": workspace, "sha256": phantom_sha }),
            ),
        )
        .await
        .expect_err("a referenced digest with no blob row is corruption");
    assert_eq!(corrupt.message, "state-corrupt");
    // MUTATION: hydrate over-cap blobs for the metadata answer -> this still
    // passes, but the arm loads 49k bytes to discard them; the shape contract
    // (null bytes + recorded length) is what this pins.
    let over_cap = call(
        &transport,
        &handle,
        7,
        "versionedBinary.readBlob",
        json!({ "workspaceId": workspace, "sha256": big_sha }),
    )
    .await;
    assert_eq!(over_cap["bytesBase64"], Value::Null);
    assert_eq!(over_cap["byteLength"], 49_153);
    assert_eq!(over_cap["inbandLimitBytes"], 49_152);
    // MUTATION: trust recorded byte_length for an over-cap metadata answer ->
    // this succeeds with false metadata instead of reporting store corruption.
    let mismatched = transport
        .call(
            RequestContext::unbounded(),
            request(
                8,
                "versionedBinary.readBlob",
                Some(handle),
                json!({ "workspaceId": workspace, "sha256": corrupt_big_sha }),
            ),
        )
        .await
        .expect_err("over-cap recorded/actual length mismatch is corruption");
    assert_eq!(mismatched.message, "state-corrupt");
}
