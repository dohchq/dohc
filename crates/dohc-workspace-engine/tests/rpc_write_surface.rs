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
    assert_eq!(blob["bytes"], json!([1, 2, 3, 4]));
}
