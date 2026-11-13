use crate::common;

use common::*;
use dohc_engine_protocol::{
    error::ErrorCode,
    limits::WireLimits,
    transport::{
        EngineService as ProtocolEngineService, EngineTransport, InProcessTransport, RequestContext,
    },
    wire::{Envelope, WorkspaceHandle, encode_control},
};
use dohc_engine_testkit::ScratchDir;
use dohc_workspace_engine::EngineService;
use serde_json::{Value, json};
use std::sync::Arc;

async fn fixture(
    name: &str,
) -> (
    ScratchDir,
    InProcessTransport<EngineService>,
    WorkspaceHandle,
    String,
) {
    let (scratch, _service, transport, handle, workspace_id) = fixture_with_service(name).await;
    (scratch, transport, handle, workspace_id)
}

async fn fixture_with_service(
    name: &str,
) -> (
    ScratchDir,
    Arc<EngineService>,
    InProcessTransport<EngineService>,
    WorkspaceHandle,
    String,
) {
    let scratch = ScratchDir::new().expect("scratch");
    let workspace_id = format!("ws-conflicts-{name}");
    let service = Arc::new(EngineService::new());
    let transport = InProcessTransport::new(Arc::clone(&service));
    let opened = call_with_busy_retry(
        &transport,
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
    call_with_busy_retry(
        &transport,
        RequestContext::unbounded(),
        keyed_request(
            2,
            "versionedText.write",
            Some(handle.clone()),
            &format!("{name}-bootstrap"),
            json!({
                "versionId": "main",
                "path": "bootstrap.md",
                "text": "bootstrap",
                "origin": "api",
            }),
        ),
    )
    .await
    .expect("bootstrap versioned workspace");

    (scratch, service, transport, handle, workspace_id)
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
        let opened = call_with_busy_retry(
            transport,
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

async fn open_conflict(
    transport: &InProcessTransport<EngineService>,
    handle: &WorkspaceHandle,
    workspace_id: &str,
    index: usize,
    text: &str,
) {
    let opened = call_with_busy_retry(
        transport,
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

async fn open_workspace(
    transport: &InProcessTransport<EngineService>,
    scratch: &ScratchDir,
    workspace_id: &str,
    request_id: u64,
) -> WorkspaceHandle {
    let opened = call_with_busy_retry(
        transport,
        RequestContext::unbounded(),
        request(
            request_id,
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
    call_with_busy_retry(
        transport,
        RequestContext::unbounded(),
        keyed_request(
            request_id + 1,
            "versionedText.write",
            Some(handle.clone()),
            &format!("{workspace_id}-bootstrap"),
            json!({
                "versionId": "main",
                "path": "bootstrap.md",
                "text": "bootstrap",
                "origin": "api",
            }),
        ),
    )
    .await
    .expect("bootstrap versioned workspace");

    handle
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn conflict_list_and_resolve_are_isolated_by_workspace() {
    let scratch_a = ScratchDir::new().expect("workspace A scratch");
    let scratch_b = ScratchDir::new().expect("workspace B scratch");
    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let workspace_a_id = "ws-conflicts-isolation-a";
    let workspace_b_id = "ws-conflicts-isolation-b";
    let handle_a = open_workspace(&transport, &scratch_a, workspace_a_id, 1).await;
    let handle_b = open_workspace(&transport, &scratch_b, workspace_b_id, 10).await;

    open_conflict(&transport, &handle_a, workspace_a_id, 0, "workspace A").await;

    let workspace_b_conflicts = transport
        .call(
            RequestContext::unbounded(),
            request(
                20,
                "conflicts.list",
                Some(handle_b.clone()),
                json!({ "status": "open" }),
            ),
        )
        .await
        .expect("list workspace B conflicts");
    assert_eq!(workspace_b_conflicts.result["conflicts"], json!([]));

    let wrong_workspace_resolve = transport
        .call(
            RequestContext::unbounded(),
            request(
                21,
                "conflicts.resolve",
                Some(handle_b),
                json!({ "local": {
                    "conflictId": "conflict-000",
                    "resolution": "keep-current",
                    "objectId": "wrong-workspace-object",
                    "writeMomentId": "wrong-workspace-write",
                    "deleteMomentId": "wrong-workspace-delete",
                    "metadataOrigin": "api",
                    "nowMs": 100,
                }}),
            ),
        )
        .await
        .expect_err("workspace B must not resolve workspace A's conflict");
    assert_eq!(wrong_workspace_resolve.code, ErrorCode::InvalidParams);
    assert_eq!(wrong_workspace_resolve.message, "conflict-not-found");

    let workspace_a_conflicts = transport
        .call(
            RequestContext::unbounded(),
            request(
                22,
                "conflicts.list",
                Some(handle_a),
                json!({ "status": "open" }),
            ),
        )
        .await
        .expect("list workspace A conflicts after refused resolve");
    assert_eq!(
        workspace_a_conflicts.result["conflicts"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        workspace_a_conflicts.result["conflicts"][0]["id"],
        "conflict-000"
    );
    assert_eq!(
        workspace_a_conflicts.result["conflicts"][0]["status"],
        "open"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn absent_path_live_session_blocks_local_resolve_through_rpc() {
    let (_scratch, transport, handle, workspace_id) = fixture("absent-live-resolve").await;
    let path = "absent-live.md";
    let opened = transport
        .call(
            RequestContext::unbounded(),
            request(
                10,
                "ydoc.open",
                Some(handle.clone()),
                json!({
                    "versionId": "main",
                    "path": path,
                    "contentKind": "plaintext"
                }),
            ),
        )
        .await
        .expect("open absent path live");
    assert_eq!(opened.result["head"], "absent");
    let session_id = opened.result["sessionId"]
        .as_str()
        .expect("session id")
        .to_owned();
    let incoming_text = "reviewed incoming";
    let incoming_sha = dohc_engine_storage::hex_sha256(incoming_text.as_bytes());
    let absent = json!({
        "path": path,
        "contentKind": "text",
        "snapshot": null,
        "metadataSummary": null,
        "metadataCorrelationId": null
    });
    let incoming = json!({
        "path": path,
        "contentKind": "text",
        "snapshot": {
            "workspaceId": workspace_id,
            "versionId": "main",
            "objectId": "incoming-absent-live",
            "path": path,
            "text": incoming_text,
            "blobSha256": incoming_sha,
            "updatedAtMs": 20,
            "latestMomentId": "incoming-absent-live-moment",
            "metadataOrigin": "sync"
        },
        "metadataSummary": null,
        "metadataCorrelationId": null
    });
    transport
        .call(
            RequestContext::unbounded(),
            request(
                11,
                "conflicts.open",
                Some(handle.clone()),
                json!({ "conflict": {
                    "id": "absent-live-conflict",
                    "workspaceId": workspace_id,
                    "path": path,
                    "targetVersionId": "main",
                    "sourceVersionId": "peer",
                    "createdAtMs": 20,
                    "updatedAtMs": 20,
                    "status": "open",
                    "chosenFrom": "current",
                    "resolution": null,
                    // The engine refuses incoming text over an absent current side in
                    // a sync conflict, so this test uses a non-sync conflict.
                    "metadata": { "origin": "api" },
                    "base": absent,
                    "current": absent,
                    "incoming": incoming
                }}),
            ),
        )
        .await
        .expect("open absent-path conflict");
    let resolve_params = json!({ "local": {
        "conflictId": "absent-live-conflict",
        "resolution": "apply-incoming",
        "objectId": "resolved-absent-live",
        "writeMomentId": "resolved-absent-live-write",
        "deleteMomentId": "resolved-absent-live-delete",
        "metadataOrigin": "api",
        "nowMs": 30
    }});

    let refused = transport
        .call(
            RequestContext::unbounded(),
            request(
                12,
                "conflicts.resolve",
                Some(handle.clone()),
                resolve_params.clone(),
            ),
        )
        .await
        .expect_err("the root-scoped absent-path lease must block resolve");
    assert_eq!(refused.code, ErrorCode::InvalidParams);
    assert_eq!(refused.message, "invalid-input");

    transport
        .call(
            RequestContext::unbounded(),
            request(
                13,
                "ydoc.close",
                Some(handle.clone()),
                json!({ "sessionId": session_id, "settle": false }),
            ),
        )
        .await
        .expect("close absent-path session");
    let resolved = transport
        .call(
            RequestContext::unbounded(),
            request(14, "conflicts.resolve", Some(handle), resolve_params),
        )
        .await
        .expect("resolve retries after session close");
    assert_eq!(resolved.result["conflict"]["status"], "resolved");
    assert_eq!(resolved.result["write"]["snapshot"]["text"], incoming_text);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn resolve_refuses_a_stale_target_without_clobbering_the_newer_head() {
    let (_scratch, transport, handle, workspace_id) = fixture("stale-target").await;
    let path = "conflict-000.md";
    let current = transport
        .call(
            RequestContext::unbounded(),
            keyed_request(
                10,
                "versionedText.write",
                Some(handle.clone()),
                "seed-stale-current",
                json!({
                    "versionId": "main",
                    "objectId": "stale-object",
                    "path": path,
                    "text": "recorded current",
                    "momentId": "stale-recorded",
                    "origin": "api",
                    "nowMs": 10,
                }),
            ),
        )
        .await
        .expect("seed recorded current head");
    let snapshot = &current.result["snapshot"];
    let mut payload = conflict_payload(&workspace_id, 0, "incoming");
    payload["conflict"]["current"]["snapshot"] = json!({
        "workspaceId": snapshot["workspaceId"],
        "versionId": snapshot["versionId"],
        "objectId": snapshot["objectId"],
        "path": snapshot["path"],
        "text": snapshot["text"],
        "blobSha256": snapshot["blobSha256"],
        "updatedAtMs": snapshot["updatedAtMs"],
        "latestMomentId": snapshot["latestMomentId"],
        "metadataOrigin": snapshot["metadataOrigin"],
    });
    transport
        .call(
            RequestContext::unbounded(),
            request(11, "conflicts.open", Some(handle.clone()), payload),
        )
        .await
        .expect("open conflict against recorded head");
    transport
        .call(
            RequestContext::unbounded(),
            keyed_request(
                12,
                "versionedText.write",
                Some(handle.clone()),
                "advance-stale-current",
                json!({
                    "versionId": "main",
                    "objectId": "stale-object",
                    "path": path,
                    "text": "newer current",
                    "momentId": "stale-newer",
                    "origin": "api",
                    "nowMs": 20,
                }),
            ),
        )
        .await
        .expect("advance target after conflict opens");

    let stale = transport
        .call(
            RequestContext::unbounded(),
            request(
                13,
                "conflicts.resolve",
                Some(handle.clone()),
                json!({ "local": {
                    "conflictId": "conflict-000",
                    "resolution": "apply-incoming",
                    "objectId": "stale-resolution-object",
                    "writeMomentId": "stale-resolution-write",
                    "deleteMomentId": "stale-resolution-delete",
                    "metadataOrigin": "api",
                    "nowMs": 30,
                }}),
            ),
        )
        .await
        .expect_err("a changed target must make conflict resolution stale");
    assert_eq!(stale.code, ErrorCode::InvalidParams);
    assert_eq!(stale.message, "conflict-stale-target");

    let newer = transport
        .call(
            RequestContext::unbounded(),
            request(
                14,
                "versionedText.read",
                Some(handle.clone()),
                json!({ "versionId": "main", "path": path }),
            ),
        )
        .await
        .expect("read newer target after refused resolve");
    assert_eq!(newer.result["text"], "newer current");

    let conflicts = transport
        .call(
            RequestContext::unbounded(),
            request(
                15,
                "conflicts.list",
                Some(handle),
                json!({ "status": "open" }),
            ),
        )
        .await
        .expect("list open conflict after refused resolve");
    assert_eq!(conflicts.result["conflicts"].as_array().unwrap().len(), 1);
    assert_eq!(conflicts.result["conflicts"][0]["id"], "conflict-000");
    assert_eq!(conflicts.result["conflicts"][0]["status"], "open");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn over_cap_merged_resolution_applies_and_withholds_its_body() {
    let (_scratch, service, transport, handle, workspace_id) =
        fixture_with_service("over-cap-merged").await;
    let path =
        open_conflict_against_seeded_head(&transport, &handle, &workspace_id, 10, "incoming").await;
    // Past MAX_DESKTOP_CAPTURE_TEXT_BYTES (128 KiB). The multi-byte character
    // keeps the byte length honest against a character count.
    let merged = "combined \u{2713} line\n".repeat(12_000);
    assert!(
        merged.len() > 128 * 1024,
        "cap the merged arm at MAX_DESKTOP_CAPTURE_TEXT_BYTES again -> the resolve refuses instead of settling; echo the settled body through the unclamped `snapshot_json` -> the withheld assertions fail."
    );
    let merged_sha256 = dohc_engine_storage::hex_sha256(merged.as_bytes());

    let resolved = transport
        .call(
            RequestContext::unbounded(),
            request(
                12,
                "conflicts.resolve",
                Some(handle.clone()),
                json!({ "local": {
                    "conflictId": "conflict-000",
                    "resolution": "apply-merged",
                    "mergedText": merged,
                    "objectId": "over-cap-resolution-object",
                    "writeMomentId": "over-cap-resolution-write",
                    "deleteMomentId": "over-cap-resolution-delete",
                    "metadataOrigin": "api",
                    "nowMs": 20,
                }}),
            ),
        )
        .await
        .expect("an over-cap combined resolution applies");
    let settled = &resolved.result["write"]["snapshot"];
    assert_eq!(settled["text"], Value::Null);
    assert_eq!(settled["inbandLimitBytes"], json!(128 * 1024));
    assert_eq!(settled["byteLength"], json!(merged.len()));
    assert_eq!(settled["blobSha256"], json!(merged_sha256));
    assert_eq!(resolved.result["conflict"]["status"], "resolved");
    assert_eq!(resolved.result["conflict"]["resolution"], "applied-merged");

    // The stored body is the combined text, byte for byte, and it hydrates the
    // way an over-cap head read already does.
    let hydrated = ProtocolEngineService::call(
        service.as_ref(),
        RequestContext::unbounded().with_capability("blobs"),
        request(
            13,
            "versionedText.readBlob",
            Some(handle.clone()),
            json!({ "workspaceId": workspace_id, "sha256": merged_sha256 }),
        ),
    )
    .await
    .expect("hydrate the settled combined body");
    assert_eq!(hydrated.response.result["bytesBase64"], Value::Null);
    let egress = hydrated.blob_egress.expect("over-cap settled body egress");
    assert_eq!(egress.bytes, merged.as_bytes());

    let head = transport
        .call(
            RequestContext::unbounded(),
            request(
                14,
                "versionedText.read",
                Some(handle.clone()),
                json!({ "versionId": "main", "path": path }),
            ),
        )
        .await
        .expect("read the settled head");
    assert_eq!(head.result["text"], Value::Null);
    assert_eq!(head.result["blobSha256"], json!(merged_sha256));
    assert_eq!(head.result["byteLength"], json!(merged.len()));

    let conflicts = transport
        .call(
            RequestContext::unbounded(),
            request(
                15,
                "conflicts.list",
                Some(handle),
                json!({ "status": "open" }),
            ),
        )
        .await
        .expect("list open conflicts after the resolution");
    assert!(
        conflicts.result["conflicts"]
            .as_array()
            .expect("conflict rows")
            .is_empty()
    );
}

/// Seed `conflict-000.md` with a recorded current head and open a conflict
/// against exactly that head, so a resolution passes the exact-head gate.
async fn open_conflict_against_seeded_head(
    transport: &InProcessTransport<EngineService>,
    handle: &WorkspaceHandle,
    workspace_id: &str,
    request_id: u64,
    side_text: &str,
) -> String {
    open_conflict_against_seeded_head_with(
        transport,
        handle,
        workspace_id,
        request_id,
        side_text,
        |_| {},
    )
    .await
}

/// The same seeded conflict, with `shape` applied to the open payload first.
async fn open_conflict_against_seeded_head_with(
    transport: &InProcessTransport<EngineService>,
    handle: &WorkspaceHandle,
    workspace_id: &str,
    request_id: u64,
    side_text: &str,
    shape: impl FnOnce(&mut Value),
) -> String {
    let path = "conflict-000.md".to_owned();
    let current = call_with_busy_retry(
        transport,
        RequestContext::unbounded(),
        keyed_request(
            request_id,
            "versionedText.write",
            Some(handle.clone()),
            "seed-conflict-current",
            json!({
                "versionId": "main",
                "objectId": "seeded-conflict-object",
                "path": path,
                "text": "recorded current",
                "momentId": "seeded-conflict-recorded",
                "origin": "api",
                "nowMs": 10,
            }),
        ),
    )
    .await
    .expect("seed current head");

    let snapshot = &current.result["snapshot"];
    let mut payload = conflict_payload(workspace_id, 0, side_text);
    payload["conflict"]["current"]["snapshot"] = json!({
        "workspaceId": snapshot["workspaceId"],
        "versionId": snapshot["versionId"],
        "objectId": snapshot["objectId"],
        "path": snapshot["path"],
        "text": snapshot["text"],
        "blobSha256": snapshot["blobSha256"],
        "updatedAtMs": snapshot["updatedAtMs"],
        "latestMomentId": snapshot["latestMomentId"],
        "metadataOrigin": snapshot["metadataOrigin"],
    });
    shape(&mut payload);
    call_with_busy_retry(
        transport,
        RequestContext::unbounded(),
        request(
            request_id + 1,
            "conflicts.open",
            Some(handle.clone()),
            payload,
        ),
    )
    .await
    .expect("open conflict against current head");
    path
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn over_frame_conflict_row_degrades_to_hydratable_metadata_instead_of_refusing() {
    // Three ~3 MB sides serialize past CONFLICT_ROW_HARD_CAP_BYTES (the 8 MiB
    // control frame minus 64 KiB envelope headroom), so this row can never
    // carry its bodies in band.
    let (_scratch, service, transport, handle, workspace_id) =
        fixture_with_service("over-frame-row").await;
    let oversized = "x".repeat(3_000_000);
    let oversized_sha256 = dohc_engine_storage::hex_sha256(oversized.as_bytes());
    seed_conflicts(&transport, &handle, &workspace_id, 1, &oversized).await;
    open_conflict(&transport, &handle, &workspace_id, 1, "small neighbor").await;

    let response = transport
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
        .expect("one over-frame row must not refuse the listing");
    let rows = response.result["conflicts"]
        .as_array()
        .expect("conflict rows");
    assert_eq!(
        rows.len(),
        2,
        "the healthy neighbor ships beside the degraded row"
    );

    // The degraded row keeps every side's address and loses only the bodies.
    assert_eq!(rows[0]["id"], "conflict-000");
    for side in ["base", "current", "incoming"] {
        let snapshot = &rows[0][side]["snapshot"];
        assert_eq!(snapshot["text"], Value::Null);
        assert_eq!(snapshot["inbandLimitBytes"], json!(128 * 1024));
        assert_eq!(snapshot["blobSha256"], json!(oversized_sha256));
        assert_eq!(snapshot["byteLength"], json!(oversized.len()));
    }
    assert_eq!(
        rows[1]["current"]["snapshot"]["text"],
        json!("small neighbor"),
        "a row under the cap still carries its bodies in band"
    );
    assert_eq!(response.result["nextAfterConflictId"], Value::Null);
    encode_control(&Envelope::Response(response), &WireLimits::default())
        .expect("the degraded page fits the negotiated control frame");

    // The withheld body hydrates through the blob route `versionedText.read`
    // already uses; the conflict-side reference alone authorizes it.
    let hydrated = ProtocolEngineService::call(
        service.as_ref(),
        RequestContext::unbounded().with_capability("blobs"),
        request(
            11,
            "versionedText.readBlob",
            Some(handle),
            json!({ "workspaceId": workspace_id, "sha256": oversized_sha256 }),
        ),
    )
    .await
    .expect("hydrate a withheld conflict side");
    assert_eq!(hydrated.response.result["bytesBase64"], Value::Null);
    let egress = hydrated.blob_egress.expect("over-cap side body egress");
    assert_eq!(egress.bytes, oversized.as_bytes());
}

/// #2205: an original retained on a volume that cannot refuse to unlink an
/// open file is counted in watcher.status, listed with its revision, and
/// deleted only with the late-write risk accepted.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_retained_copy_on_an_unchecked_volume_is_counted_listed_and_deleted() {
    use std::os::unix::fs::MetadataExt;
    let (scratch, transport, handle, workspace_id) = fixture("retained-copy").await;
    let _simulated = dohc_engine_files::retained::unchecked::simulate(scratch.path());
    // The first name job "old" stages its original under.
    let source = ".dohc/engine/displaced/6f6c64.0";
    write_file(scratch.path(), source, b"old bytes");
    let m = std::fs::metadata(scratch.path().join(source)).expect("source");
    let store =
        dohc_engine_storage::EngineStore::open(&scratch.path().join(".dohc/engine/engine.db"), 10)
            .expect("store");
    let id = store
        .retain_displacement(&dohc_engine_storage::RetainedDisplacement {
            displacement_id: 0,
            job_id: "old".to_owned(),
            workspace_id: workspace_id.clone(),
            target_path: "notes/a.md".to_owned(),
            source_path: source.to_owned(),
            device: m.dev().to_string(),
            inode: m.ino().to_string(),
            digest: dohc_engine_storage::hex_sha256(b"old bytes"),
            size: 9,
            mtime: format!("{}:{}", m.mtime(), m.mtime_nsec()),
            ctime: format!("{}:{}", m.ctime(), m.ctime_nsec()),
            changed_at_ms: 0,
            busy_check_unsupported: true,
        })
        .expect("retain");
    drop(store);

    let status = call(&transport, &handle, 9, "watcher.status", json!({})).await;
    assert_eq!(status["retainedCopies"], json!({ "count": 1, "bytes": 9 }));
    let listed = call(&transport, &handle, 10, "retainedCopies.list", json!({})).await;
    assert_eq!(
        listed,
        json!({
            "copies": [{ "id": id, "revision": 0 }],
            "more": false,
            "total": { "count": 1, "bytes": 9 },
        })
    );
    let copies = listed["copies"].clone();
    for (n, params) in [
        json!({ "copies": copies }),
        json!({ "copies": copies, "acceptLateWriteRisk": false }),
    ]
    .into_iter()
    .enumerate()
    {
        let refused = call_error(
            &transport,
            &handle,
            11 + n as u64,
            "retainedCopies.delete",
            params,
        )
        .await;
        assert_eq!(refused.code, ErrorCode::InvalidParams, "{refused:?}");
    }
    assert!(scratch.path().join(source).exists());
    let deleted = call(
        &transport,
        &handle,
        13,
        "retainedCopies.delete",
        json!({ "copies": copies, "acceptLateWriteRisk": true }),
    )
    .await;
    assert_eq!(
        deleted,
        json!({
            "deleted": 1,
            "skipped": 0,
            "failed": 0,
            "remaining": { "count": 0, "bytes": 0 },
        })
    );
    assert!(!scratch.path().join(source).exists());
    assert_eq!(
        call(&transport, &handle, 14, "retainedCopies.list", json!({})).await,
        json!({ "copies": [], "more": false, "total": { "count": 0, "bytes": 0 } })
    );
}

/// A file a replace kept at its hidden displaced name is listed until it is
/// saved as a visible copy beside its path, and saving it twice finds nothing.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_kept_copy_is_listed_until_it_is_saved_beside_its_file() {
    let (scratch, transport, handle, workspace_id) = fixture("kept-copy").await;
    write_file(scratch.path(), "notes/a.md", b"a newer save");
    write_file(
        scratch.path(),
        ".dohc/engine/displaced/6a6f62.0",
        b"bytes another program wrote",
    );
    let store =
        dohc_engine_storage::EngineStore::open(&scratch.path().join(".dohc/engine/engine.db"), 10)
            .expect("store");
    // Older orphan rows remain accessible through watcher.status, but cannot
    // consume the page of named copies or violate its nonempty-path contract.
    for n in 0..100 {
        let job_id = format!("orphan-{n}");
        let name = format!("h{}.0", dohc_engine_storage::hex_sha256(job_id.as_bytes()));
        write_file(
            scratch.path(),
            &format!(".dohc/engine/displaced/{name}"),
            b"orphan bytes",
        );
        store
            .keep_displacement(
                &dohc_engine_storage::DisplacementSpec {
                    job_id,
                    workspace_id: workspace_id.clone(),
                    target_path: String::new(),
                    displaced_name: name,
                    expected_sha256: String::new(),
                    content_sha256: None,
                    now_ms: 9,
                },
                Some(&dohc_engine_storage::hex_sha256(b"orphan bytes")),
            )
            .expect("keep orphan");
    }
    let id = store
        .open_displacement(&dohc_engine_storage::DisplacementSpec {
            job_id: "job".to_owned(),
            workspace_id: workspace_id.clone(),
            target_path: "notes/a.md".to_owned(),
            displaced_name: "6a6f62.0".to_owned(),
            expected_sha256: dohc_engine_storage::hex_sha256(b"ours before"),
            content_sha256: Some(dohc_engine_storage::hex_sha256(b"ours")),
            now_ms: 10,
        })
        .expect("open displacement");
    store
        .resolve_displacement(
            id,
            dohc_engine_storage::DisplacementResolution::Keep {
                displaced_sha256: Some(&dohc_engine_storage::hex_sha256(
                    b"bytes another program wrote",
                )),
            },
            None,
            11,
        )
        .expect("keep");
    drop(store);

    let status = call(&transport, &handle, 9, "watcher.status", json!({})).await;
    let recovery = status["keptFiles"].as_array().expect("recovery copies");
    assert_eq!(recovery.iter().filter(|copy| copy[0] == "").count(), 100);
    let listed = call(&transport, &handle, 10, "keptCopies.list", json!({})).await;
    assert_eq!(
        listed,
        json!({
            "keptCopies": [{ "id": id, "path": "notes/a.md", "keptAtMs": 10 }],
            "more": false,
        })
    );

    let saved = call(
        &transport,
        &handle,
        11,
        "keptCopies.save",
        json!({ "id": id }),
    )
    .await;
    assert_eq!(
        saved,
        json!({ "status": "saved", "path": "notes/a (kept copy).md" })
    );
    assert_eq!(
        std::fs::read(scratch.path().join("notes/a (kept copy).md")).expect("copy"),
        b"bytes another program wrote"
    );
    assert_eq!(
        std::fs::read(scratch.path().join("notes/a.md")).expect("file"),
        b"a newer save"
    );
    assert!(
        !scratch
            .path()
            .join(".dohc/engine/displaced/6a6f62.0")
            .exists()
    );
    assert_eq!(
        call(&transport, &handle, 12, "keptCopies.list", json!({})).await,
        json!({ "keptCopies": [], "more": false })
    );
    assert_eq!(
        call(
            &transport,
            &handle,
            13,
            "keptCopies.save",
            json!({ "id": id })
        )
        .await,
        json!({ "status": "gone" })
    );
}
