use dohc_engine_protocol::{
    error::ErrorCode,
    limits::WireLimits,
    transport::{
        EngineService as ProtocolEngineService, EngineTransport, InProcessTransport, RequestContext,
    },
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
    write_shadow_marker_for_harness(scratch.path(), TOKEN).expect("marker");
    let workspace_id = format!("ws-conflicts-{name}");
    let service = Arc::new(EngineService::new());
    let transport = InProcessTransport::new(Arc::clone(&service));
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

async fn open_conflict(
    transport: &InProcessTransport<EngineService>,
    handle: &WorkspaceHandle,
    workspace_id: &str,
    index: usize,
    text: &str,
) {
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

async fn open_workspace(
    transport: &InProcessTransport<EngineService>,
    scratch: &ScratchDir,
    workspace_id: &str,
    request_id: u64,
) -> WorkspaceHandle {
    write_shadow_marker_for_harness(scratch.path(), TOKEN).expect("marker");
    let opened = transport
        .call(
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
    transport
        .call(
            RequestContext::unbounded(),
            request(
                request_id + 1,
                "versionedText.write",
                Some(handle.clone()),
                json!({
                    "versionId": "main",
                    "path": "bootstrap.md",
                    "text": "bootstrap",
                    "origin": "api",
                    "requestId": format!("{workspace_id}-bootstrap"),
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
async fn resolve_refuses_a_stale_target_without_clobbering_the_newer_head() {
    let (_scratch, transport, handle, workspace_id) = fixture("stale-target").await;
    let path = "conflict-000.md";
    let current = transport
        .call(
            RequestContext::unbounded(),
            request(
                10,
                "versionedText.write",
                Some(handle.clone()),
                json!({
                    "versionId": "main",
                    "objectId": "stale-object",
                    "path": path,
                    "text": "recorded current",
                    "momentId": "stale-recorded",
                    "origin": "api",
                    "nowMs": 10,
                    "requestId": "seed-stale-current",
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
            request(
                12,
                "versionedText.write",
                Some(handle.clone()),
                json!({
                    "versionId": "main",
                    "objectId": "stale-object",
                    "path": path,
                    "text": "newer current",
                    "momentId": "stale-newer",
                    "origin": "api",
                    "nowMs": 20,
                    "requestId": "advance-stale-current",
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
    // MUTATION: cap the merged arm at MAX_DESKTOP_CAPTURE_TEXT_BYTES again ->
    // the resolve refuses instead of settling. MUTATION: echo the settled body
    // through the unclamped `snapshot_json` -> the withheld assertions fail.
    let (_scratch, service, transport, handle, workspace_id) =
        fixture_with_service("over-cap-merged").await;
    let path =
        open_conflict_against_seeded_head(&transport, &handle, &workspace_id, 10, "incoming").await;
    // Past MAX_DESKTOP_CAPTURE_TEXT_BYTES (128 KiB). The multi-byte character
    // keeps the byte length honest against a character count.
    let merged = "combined \u{2713} line\n".repeat(12_000);
    assert!(merged.len() > 128 * 1024);
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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_over_long_resolve_identifier_is_refused_by_name() {
    // #654. A resolve answer serves the object id six times and each moment id
    // three, so an unbounded identifier that fits ONE request frame returns as
    // an answer that fits no frame at all. The bound refuses it before the
    // resolution commits, and says which id, which constraint, what limit, in
    // what unit, and how long the one it got was.
    //
    // MUTATION: drop the `bounded_identifier` calls from
    // `resolve_text_conflict_with` -> the resolution commits and this fails at
    // `expect_err`. MUTATION: map `IdentifierTooLong` through the static tail
    // of `map_runtime` -> the message loses its numbers.
    let (_scratch, transport, handle, workspace_id) = fixture("over-long-identifier").await;
    open_conflict_against_seeded_head(&transport, &handle, &workspace_id, 10, "incoming").await;
    let limit = dohc_engine_storage::MAX_IDENTIFIER_BYTES;
    let over_long = "x".repeat(limit + 1);

    for (field, object_id, write_moment_id) in [
        ("object_id", over_long.as_str(), "over-long-write"),
        ("moment_id", "over-long-object", over_long.as_str()),
    ] {
        let refused = transport
            .call(
                RequestContext::unbounded(),
                request(
                    11,
                    "conflicts.resolve",
                    Some(handle.clone()),
                    json!({ "local": {
                        "conflictId": "conflict-000",
                        "resolution": "keep-current",
                        "objectId": object_id,
                        "writeMomentId": write_moment_id,
                        "deleteMomentId": "over-long-delete",
                        "metadataOrigin": "api",
                        "nowMs": 20,
                    }}),
                ),
            )
            .await
            .expect_err("an identifier past the engine-wide bound must be refused");
        assert_eq!(refused.code, ErrorCode::PayloadTooLarge);
        assert_eq!(
            refused.message,
            format!(
                "identifier {field} exceeds MAX_IDENTIFIER_BYTES: limit {limit} bytes, \
                 observed {} bytes",
                limit + 1
            ),
        );
    }

    // Nothing was written: the conflict is still open and still resolvable.
    let conflicts = transport
        .call(
            RequestContext::unbounded(),
            request(
                13,
                "conflicts.list",
                Some(handle),
                json!({ "status": "open" }),
            ),
        )
        .await
        .expect("list open conflicts after the refusals");
    assert_eq!(conflicts.result["conflicts"].as_array().unwrap().len(), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn merged_resolution_past_the_frame_limit_is_refused_by_name() {
    // MUTATION: drop the limit, the unit, or the observed size from the
    // message -> the refusal names nothing an agent can act on and this fails.
    let (_scratch, transport, handle, workspace_id) = fixture("past-frame-limit").await;
    let path =
        open_conflict_against_seeded_head(&transport, &handle, &workspace_id, 10, "incoming").await;
    let frame = WireLimits::SPIKE_DEFAULTS.max_frame_bytes as usize;
    // Every newline encodes as two bytes, so this body is 4 MiB raw and 8 MiB
    // once encoded: under any raw-byte budget, past the frame that has to
    // carry it. A raw-byte check would accept it here and let the client's own
    // framer refuse it, with no limit named anywhere.
    //
    // MUTATION: measure `text.len()` instead of the encoded request -> the
    // resolve is accepted and this refusal never happens.
    let newlines = "\n".repeat(4 * 1024 * 1024);
    let encoded_newlines = newlines.len() * 2 + 2;
    assert!(newlines.len() < frame && encoded_newlines > frame);
    let escaped = transport
        .call(
            RequestContext::unbounded(),
            request(
                11,
                "conflicts.resolve",
                Some(handle.clone()),
                json!({ "local": {
                    "conflictId": "conflict-000",
                    "resolution": "apply-merged",
                    "mergedText": newlines,
                    "objectId": "escape-heavy-resolution-object",
                    "writeMomentId": "escape-heavy-resolution-write",
                    "deleteMomentId": "escape-heavy-resolution-delete",
                    "metadataOrigin": "api",
                    "nowMs": 20,
                }}),
            ),
        )
        .await
        .expect_err("an escape-heavy body past one control frame must be refused");
    assert!(
        escaped
            .message
            .contains(&format!("{encoded_newlines} encoded)")),
        "the refusal must measure the encoded body: {}",
        escaped.message
    );

    let merged = "x".repeat(frame);

    let refused = transport
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
                    "objectId": "past-limit-resolution-object",
                    "writeMomentId": "past-limit-resolution-write",
                    "deleteMomentId": "past-limit-resolution-delete",
                    "metadataOrigin": "api",
                    "nowMs": 20,
                }}),
            ),
        )
        .await
        .expect_err("a body past one control frame must be refused");
    assert_eq!(refused.code, ErrorCode::InvalidParams);
    assert!(
        refused
            .message
            .starts_with("merged-text-exceeds-wire-limit:"),
        "unexpected refusal: {}",
        refused.message
    );
    assert!(
        refused.message.contains(&format!("{frame} encoded bytes")),
        "the refusal must name the limit and its unit: {}",
        refused.message
    );
    assert!(
        refused
            .message
            .contains(&format!("({} raw bytes of combined body", merged.len())),
        "the refusal must name the body the caller sent: {}",
        refused.message
    );

    let unchanged = transport
        .call(
            RequestContext::unbounded(),
            request(
                13,
                "versionedText.read",
                Some(handle.clone()),
                json!({ "versionId": "main", "path": path }),
            ),
        )
        .await
        .expect("read target after refused resolve");
    assert_eq!(unchanged.result["text"], "recorded current");

    let conflicts = transport
        .call(
            RequestContext::unbounded(),
            request(
                14,
                "conflicts.list",
                Some(handle),
                json!({ "status": "open" }),
            ),
        )
        .await
        .expect("list conflict after refused resolve");
    assert_eq!(conflicts.result["conflicts"].as_array().unwrap().len(), 1);
    assert_eq!(conflicts.result["conflicts"][0]["id"], "conflict-000");
    assert_eq!(conflicts.result["conflicts"][0]["status"], "open");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_near_cap_conflict_row_answers_a_resolution_inside_one_control_frame() {
    // A conflict whose sides nearly fill the row cap the LISTING admits. Its
    // resolve answer carries five text bodies — three sides, the settled
    // snapshot, and the moment's before and after — and one frame has to hold
    // all of them. Withholding the settled body alone is not enough: the two
    // in-band residuals still push a near-cap row past the frame, and the
    // daemon's writer treats an oversized answer as a fatal transport error
    // AFTER the resolution has committed.
    //
    // MUTATION: answer with `conflict_json` instead of `settled_conflict_json`
    // -> the response no longer encodes into one control frame.
    let (_scratch, transport, handle, workspace_id) = fixture("near-cap-row").await;
    let side = "s".repeat(4_100_000);
    let path =
        open_conflict_against_seeded_head(&transport, &handle, &workspace_id, 10, &side).await;
    // In band on purpose: a withheld body would hide the residual this test
    // exists to measure.
    let merged = "m".repeat(120 * 1024);

    let listed = transport
        .call(
            RequestContext::unbounded(),
            request(
                12,
                "conflicts.list",
                Some(handle.clone()),
                json!({ "status": "open" }),
            ),
        )
        .await
        .expect("the row cap admits this conflict, so a caller can reach it");
    assert_eq!(listed.result["conflicts"].as_array().unwrap().len(), 1);
    // The premise, asserted: the row rides UNDER the cap, bodies in band. A
    // degraded (withheld) row would no longer carry the in-band residuals
    // whose frame cost this test exists to measure.
    for side_name in ["base", "current", "incoming"] {
        assert!(
            listed.result["conflicts"][0][side_name]["snapshot"]["text"].is_string(),
            "{side_name} must ride in band for the residual measurement to mean anything"
        );
    }

    let resolved = transport
        .call(
            RequestContext::unbounded(),
            request(
                13,
                "conflicts.resolve",
                Some(handle.clone()),
                json!({ "local": {
                    "conflictId": "conflict-000",
                    "resolution": "apply-merged",
                    "mergedText": merged,
                    "objectId": "near-cap-resolution-object",
                    "writeMomentId": "near-cap-resolution-write",
                    "deleteMomentId": "near-cap-resolution-delete",
                    "metadataOrigin": "api",
                    "nowMs": 20,
                }}),
            ),
        )
        .await
        .expect("a near-cap conflict resolves");
    for side_name in ["base", "incoming"] {
        let snapshot = &resolved.result["conflict"][side_name]["snapshot"];
        assert_eq!(snapshot["text"], Value::Null, "{side_name} body withheld");
        assert_eq!(snapshot["inbandLimitBytes"], json!(128 * 1024));
        assert_eq!(snapshot["byteLength"], json!(side.len()));
    }
    assert_eq!(resolved.result["write"]["snapshot"]["text"], json!(merged));

    encode_control(&Envelope::Response(resolved), &WireLimits::default())
        .expect("the resolve answer fits the negotiated control frame");

    let head = transport
        .call(
            RequestContext::unbounded(),
            request(
                14,
                "versionedText.read",
                Some(handle),
                json!({ "versionId": "main", "path": path }),
            ),
        )
        .await
        .expect("read the settled head");
    assert_eq!(head.result["text"], json!(merged));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn metadata_beside_a_large_body_is_measured_against_the_same_frame() {
    // The request carries more than its body. Two metadata fields at the
    // 16 KiB each `validate_metadata_fields` accepts, filled with quotes,
    // encode to 32 KiB each — so a body that fits on its own no longer fits
    // beside them. A body-only budget accepts this request and the client's
    // framer then refuses it, naming nothing the caller asked about.
    //
    // MUTATION: bound the body alone (encoded or raw) instead of the request
    // -> this resolve is accepted and the refusal never happens.
    let (_scratch, transport, handle, workspace_id) = fixture("metadata-headroom").await;
    let path =
        open_conflict_against_seeded_head(&transport, &handle, &workspace_id, 10, "incoming").await;
    let frame = WireLimits::SPIKE_DEFAULTS.max_frame_bytes as usize;
    let metadata = "\"".repeat(16 * 1024 - 1);
    // Comfortably inside the frame on its own, past it beside the metadata.
    let merged = "x".repeat(frame - 40 * 1024);

    let refused = transport
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
                    "metadataSummary": metadata,
                    "metadataCorrelationId": metadata,
                    "objectId": "metadata-resolution-object",
                    "writeMomentId": "metadata-resolution-write",
                    "deleteMomentId": "metadata-resolution-delete",
                    "metadataOrigin": "api",
                    "nowMs": 20,
                }}),
            ),
        )
        .await
        .expect_err("a request past the frame must be refused, whatever fills it");
    assert_eq!(refused.code, ErrorCode::InvalidParams);
    assert!(
        refused
            .message
            .starts_with("merged-text-exceeds-wire-limit:"),
        "unexpected refusal: {}",
        refused.message
    );
    assert!(
        refused.message.contains(&format!("{frame} encoded bytes")),
        "the refusal must name the frame it measured against: {}",
        refused.message
    );

    let unchanged = transport
        .call(
            RequestContext::unbounded(),
            request(
                13,
                "versionedText.read",
                Some(handle),
                json!({ "versionId": "main", "path": path }),
            ),
        )
        .await
        .expect("read target after refused resolve");
    assert_eq!(unchanged.result["text"], "recorded current");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_request_that_exactly_fills_the_frame_is_applied_and_one_byte_more_is_refused() {
    // THE BOUNDARY, measured on the real envelope rather than a worst-case
    // stand-in. This request carries the id and deadline it actually has, so
    // the size the daemon measures is the size that crossed. Substituting
    // `u64::MAX` and `u32::MAX` for them inflates the total by about thirty
    // bytes, and everything inside that band is valid work refused with a size
    // that never existed.
    //
    // MUTATION: substitute the worst-case id and deadline again -> the at-frame
    // resolution is refused and this fails.
    let frame = WireLimits::SPIKE_DEFAULTS.max_frame_bytes as usize;
    let (_scratch, transport, handle, workspace_id) = fixture("frame-boundary").await;
    let path =
        open_conflict_against_seeded_head(&transport, &handle, &workspace_id, 10, "incoming").await;

    // Size the body from the envelope this test will actually send: everything
    // except the body is fixed, and each added byte of plain text adds exactly
    // one encoded byte.
    let envelope = |body: &str| {
        Envelope::Request(request(
            12,
            "conflicts.resolve",
            Some(handle.clone()),
            json!({ "local": {
                "conflictId": "conflict-000",
                "resolution": "apply-merged",
                "mergedText": body,
                "objectId": "boundary-resolution-object",
                "writeMomentId": "boundary-resolution-write",
                "deleteMomentId": "boundary-resolution-delete",
                "metadataOrigin": "api",
                "nowMs": 20,
            }}),
        ))
    };
    let overhead = serde_json::to_vec(&envelope("")).expect("encode").len();
    let merged = "x".repeat(frame - overhead);
    let exact = serde_json::to_vec(&envelope(&merged))
        .expect("encode")
        .len();
    assert_eq!(exact, frame, "the request must sit exactly on the frame");
    encode_control(&envelope(&merged), &WireLimits::default())
        .expect("a request at the frame crosses it");

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
                    "objectId": "boundary-resolution-object",
                    "writeMomentId": "boundary-resolution-write",
                    "deleteMomentId": "boundary-resolution-delete",
                    "metadataOrigin": "api",
                    "nowMs": 20,
                }}),
            ),
        )
        .await
        .expect("a request that fills the frame exactly is work, not overflow");
    assert_eq!(resolved.result["conflict"]["resolution"], "applied-merged");
    assert_eq!(
        resolved.result["write"]["snapshot"]["byteLength"],
        json!(merged.len())
    );

    // One byte past it is refused, and the refusal names the real total.
    let (_scratch2, transport2, handle2, workspace_id2) = fixture("frame-boundary-past").await;
    open_conflict_against_seeded_head(&transport2, &handle2, &workspace_id2, 10, "incoming").await;
    let refused = transport2
        .call(
            RequestContext::unbounded(),
            request(
                12,
                "conflicts.resolve",
                Some(handle2.clone()),
                json!({ "local": {
                    "conflictId": "conflict-000",
                    "resolution": "apply-merged",
                    "mergedText": format!("{merged}x"),
                    "objectId": "boundary-resolution-object",
                    "writeMomentId": "boundary-resolution-write",
                    "deleteMomentId": "boundary-resolution-delete",
                    "metadataOrigin": "api",
                    "nowMs": 20,
                }}),
            ),
        )
        .await
        .expect_err("one byte past the frame must be refused");
    assert!(
        refused
            .message
            .contains(&format!("observed {} encoded bytes", frame + 1)),
        "the refusal must name the real total: {}",
        refused.message
    );

    let head = transport
        .call(
            RequestContext::unbounded(),
            request(
                14,
                "versionedText.read",
                Some(handle),
                json!({ "versionId": "main", "path": path }),
            ),
        )
        .await
        .expect("read the settled head");
    assert_eq!(head.result["byteLength"], json!(merged.len()));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_largest_accepted_request_crosses_as_one_control_frame() {
    // The bound is the frame, so the largest request the daemon accepts must
    // be one the transport can carry. This pins that: a resolve request built
    // to sit just inside the budget encodes into one control frame.
    //
    // MUTATION: compare against `max_frame_bytes + 1` -> the envelope the
    // daemon would accept no longer encodes.
    let frame = WireLimits::SPIKE_DEFAULTS.max_frame_bytes as usize;
    let envelope = Envelope::Request(request(
        12,
        "conflicts.resolve",
        Some(WorkspaceHandle("ws-0000000000000001".to_owned())),
        json!({ "local": {
            "conflictId": "conflict-000",
            "resolution": "apply-merged",
            "mergedText": "x".repeat(frame - 1024),
            "objectId": "largest-resolution-object",
            "writeMomentId": "largest-resolution-write",
            "deleteMomentId": "largest-resolution-delete",
            "metadataOrigin": "api",
            "nowMs": 20,
        }}),
    ));
    let encoded = encode_control(&envelope, &WireLimits::default())
        .expect("the largest accepted request crosses as one control frame");
    assert!(encoded.len() <= frame);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_body_at_the_in_band_cap_is_carried_and_one_byte_more_is_withheld() {
    // The withholding rule is `>`, not `>=`: a body of exactly
    // MAX_DESKTOP_CAPTURE_TEXT_BYTES is IN BAND, and the next byte withholds.
    // Both directions matter — a rule that withholds at the cap costs a
    // hydration round trip for a body that fits.
    //
    // MUTATION: relax `>` to `>=` in withhold_over_cap_text -> the at-cap
    // resolution comes back withheld and this fails.
    let cap = 128 * 1024;
    for (name, size, withheld) in [("at-cap", cap, false), ("past-cap", cap + 1, true)] {
        let (_scratch, transport, handle, workspace_id) = fixture(name).await;
        open_conflict_against_seeded_head(&transport, &handle, &workspace_id, 10, "incoming").await;
        let merged = "y".repeat(size);
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
                        "objectId": format!("{name}-resolution-object"),
                        "writeMomentId": format!("{name}-resolution-write"),
                        "deleteMomentId": format!("{name}-resolution-delete"),
                        "metadataOrigin": "api",
                        "nowMs": 20,
                    }}),
                ),
            )
            .await
            .expect("the resolution applies");
        let settled = &resolved.result["write"]["snapshot"];
        if withheld {
            assert_eq!(settled["text"], Value::Null, "{name} must be withheld");
            assert_eq!(settled["inbandLimitBytes"], json!(cap));
        } else {
            assert_eq!(settled["text"], json!(merged), "{name} must ride in band");
            assert_eq!(settled.get("inbandLimitBytes"), None);
        }
        assert_eq!(settled["byteLength"], json!(size));
    }
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
    let current = transport
        .call(
            RequestContext::unbounded(),
            request(
                request_id,
                "versionedText.write",
                Some(handle.clone()),
                json!({
                    "versionId": "main",
                    "objectId": "seeded-conflict-object",
                    "path": path,
                    "text": "recorded current",
                    "momentId": "seeded-conflict-recorded",
                    "origin": "api",
                    "nowMs": 10,
                    "requestId": "seed-conflict-current",
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
    transport
        .call(
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
async fn cursor_continues_after_its_open_conflict_is_resolved() {
    let (_scratch, transport, handle, workspace_id) = fixture("resolved-cursor").await;
    let text = "\0".repeat(20_000);

    let current = transport
        .call(
            RequestContext::unbounded(),
            request(
                10,
                "versionedText.write",
                Some(handle.clone()),
                json!({
                    "versionId": "main",
                    "objectId": "object-000",
                    "path": "conflict-000.md",
                    "text": text,
                    "momentId": "moment-000",
                    "origin": "api",
                    "nowMs": 1,
                    "requestId": "seed-resolvable-current",
                }),
            ),
        )
        .await
        .expect("seed current head");
    let mut first_payload = conflict_payload(&workspace_id, 0, &text);
    let snapshot = &current.result["snapshot"];
    first_payload["conflict"]["current"]["snapshot"] = json!({
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
            request(11, "conflicts.open", Some(handle.clone()), first_payload),
        )
        .await
        .expect("open resolvable cursor conflict");
    open_conflict(&transport, &handle, &workspace_id, 1, &text).await;
    open_conflict(&transport, &handle, &workspace_id, 2, &text).await;

    let first = transport
        .call(
            RequestContext::unbounded(),
            request(
                20,
                "conflicts.list",
                Some(handle.clone()),
                json!({ "status": "open" }),
            ),
        )
        .await
        .expect("first page");
    assert_eq!(first.result["conflicts"][0]["id"], "conflict-000");
    assert_eq!(first.result["nextAfterConflictId"], "conflict-000");

    transport
        .call(
            RequestContext::unbounded(),
            request(
                21,
                "conflicts.resolve",
                Some(handle.clone()),
                json!({ "local": {
                    "conflictId": "conflict-000",
                    "resolution": "keep-current",
                    "objectId": "resolved-object",
                    "writeMomentId": "resolved-write",
                    "deleteMomentId": "resolved-delete",
                    "metadataOrigin": "api",
                    "nowMs": 100,
                }}),
            ),
        )
        .await
        .expect("resolve continuation conflict between pages");

    let second = transport
        .call(
            RequestContext::unbounded(),
            request(
                22,
                "conflicts.list",
                Some(handle),
                json!({
                    "status": "open",
                    "afterConflictId": "conflict-000",
                }),
            ),
        )
        .await
        .expect("second page resumes from the unfiltered cursor key");
    assert_eq!(second.result["conflicts"][0]["id"], "conflict-001");
    assert!(
        second.result["conflicts"]
            .as_array()
            .expect("rows")
            .iter()
            .all(|row| row["id"] != "conflict-000"),
        "the filtered page must not restart or duplicate its resolved cursor"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn escape_heavy_conflict_that_fits_the_control_frame_is_returned() {
    let (_scratch, transport, handle, workspace_id) = fixture("single-row").await;
    let text = "\0".repeat(40_000);
    seed_conflicts(&transport, &handle, &workspace_id, 1, &text).await;

    let response = transport
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
        .expect("the conflict-specific row cap must admit this response");
    assert_eq!(response.result["conflicts"].as_array().unwrap().len(), 1);
    let encoded = encode_control(&Envelope::Response(response), &WireLimits::default())
        .expect("the escape-heavy conflict still fits the negotiated control frame");
    assert!(
        encoded.len() > 700 * 1024,
        "the regression row must exceed the old shared 700 KiB cap"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn over_frame_conflict_row_degrades_to_hydratable_metadata_instead_of_refusing() {
    // Three ~3 MB sides serialize past CONFLICT_ROW_HARD_CAP_BYTES (the 8 MiB
    // control frame minus 64 KiB envelope headroom), so this row can never
    // carry its bodies in band. MUTATION: skip the withholding pass in
    // `conflicts_list` and this listing refuses with
    // `conflict-row-exceeds-wire-limit`, taking the healthy neighbor with it.
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

/// The replicated shape of an open, which is NOT the RPC DTO's shape: a
/// peer's sides carry `exists`/`path`/`contentKind`, never a nested snapshot
/// (`dohc-engine-sync::conflict_apply::OpenPayload`). Built here so the test
/// exercises the route a peer actually takes.
fn replicated_open_envelope(workspace_id: &str, conflict_id: &str, summary: &str) -> Value {
    let side = json!({
        "exists": false,
        "path": "notes/replicated.md",
        "contentKind": "text",
    });
    json!({
        "workspaceId": workspace_id,
        "originId": "peer-over-budget",
        "originSeq": 0,
        "opKind": "conflict.open",
        "payload": {
            "id": conflict_id,
            "workspaceId": workspace_id,
            "path": "notes/replicated.md",
            "targetVersionId": "main",
            "sourceVersionId": "peer",
            "createdAtMs": 9,
            "updatedAtMs": 9,
            "status": "open",
            "chosenFrom": "current",
            "metadata": { "origin": "sync", "summary": summary },
            "base": side,
            "current": side,
            "incoming": side,
        },
        "recordedAtMs": 2_000,
    })
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn over_budget_conflict_metadata_is_refused_on_both_open_routes() {
    // The window the review found: metadata rides every listing row and
    // withholding cannot shrink it, so a conflict whose non-withheld strings
    // outgrow one row would dead-end `conflicts.list` for every open conflict
    // in the workspace. The bound lives at the shared pre-persistence path
    // (`insert_text_conflict_if_absent`) because that is the ONLY place both
    // open routes meet — the RPC DTO never sees a peer's open.
    //
    // MUTATION: delete the budget check in `insert_text_conflict_if_absent`
    // and every open below succeeds.
    let (_scratch, transport, handle, workspace_id) = fixture("metadata-budget").await;
    let over_budget = "m".repeat(dohc_engine_domain::CONFLICT_METADATA_BUDGET_BYTES + 1);

    // ROUTE 1: the local RPC. Its refusal carries the numbers.
    let mut payload = conflict_payload(&workspace_id, 0, "small body");
    payload["conflict"]["metadata"]["summary"] = json!(over_budget);
    let refused = transport
        .call(
            RequestContext::unbounded(),
            request(10, "conflicts.open", Some(handle.clone()), payload),
        )
        .await
        .expect_err("an over-budget conflict summary is refused at open");
    assert_eq!(refused.code, ErrorCode::PayloadTooLarge);
    for needle in [
        "CONFLICT_METADATA_BUDGET_BYTES".to_owned(),
        dohc_engine_domain::CONFLICT_METADATA_BUDGET_BYTES.to_string(),
        "encoded bytes".to_owned(),
    ] {
        assert!(
            refused.message.contains(&needle),
            "the refusal must name constraint, limit, unit and observed: {}",
            refused.message
        );
    }

    // ROUTE 2: a PEER's replicated open, which never passes through the RPC
    // DTO above.
    //
    // A peer cannot reach the row budget at all, and this pins WHY:
    // `ReplicationEnvelope::validate` caps every payload at
    // `MAX_PAYLOAD_JSON_BYTES` (256 KiB) before any apply runs, which is some
    // thirty times inside the row budget. So the two routes are covered by
    // two different bounds, and this test holds BOTH ends — the shared budget
    // for the local route, the payload cap for the replicated one — rather
    // than assuming either covers the other.
    let refused = transport
        .call(
            RequestContext::unbounded(),
            request(
                11,
                "conflicts.open",
                Some(handle.clone()),
                json!({
                    "envelope": replicated_open_envelope(
                        &workspace_id,
                        "replicated-over-budget",
                        &over_budget,
                    )
                }),
            ),
        )
        .await
        .expect_err("a replicated envelope past the payload cap is refused before apply");
    assert_eq!(refused.code, ErrorCode::InvalidParams);

    // The largest conflict a peer CAN serve: a payload just inside the cap.
    // It applies, and the listing still answers — which is the property the
    // budget protects, reached here by the payload cap instead. MUTATION:
    // narrowing the budget below this refuses it.
    let peer_summary = "p".repeat(200 * 1024);
    let applied = transport
        .call(
            RequestContext::unbounded(),
            request(
                12,
                "conflicts.open",
                Some(handle.clone()),
                json!({
                    "envelope": replicated_open_envelope(
                        &workspace_id,
                        "replicated-largest-legal",
                        &peer_summary,
                    )
                }),
            ),
        )
        .await
        .expect("the largest legal replicated open applies");
    assert_eq!(applied.result["status"], "applied");

    // EVERY non-withheld string, not an enumerated subset: `metadata.origin`
    // is persisted verbatim and serialized into every row, and no body
    // withholding can shrink it.
    let mut origin_payload = conflict_payload(&workspace_id, 2, "small body");
    origin_payload["conflict"]["metadata"]["origin"] = json!(over_budget);
    let refused = transport
        .call(
            RequestContext::unbounded(),
            request(12, "conflicts.open", Some(handle.clone()), origin_payload),
        )
        .await
        .expect_err("an over-budget conflict origin is refused at open");
    assert_eq!(refused.code, ErrorCode::PayloadTooLarge);

    // A snapshot identifier is the same class.
    let mut id_payload = conflict_payload(&workspace_id, 3, "small body");
    id_payload["conflict"]["current"]["snapshot"]["objectId"] = json!(over_budget);
    let refused = transport
        .call(
            RequestContext::unbounded(),
            request(13, "conflicts.open", Some(handle.clone()), id_payload),
        )
        .await
        .expect_err("an over-budget snapshot object id is refused at open");
    assert_eq!(refused.code, ErrorCode::PayloadTooLarge);

    // Every refused open landed nothing, and the listing still answers — the
    // one row present is the largest legal replicated open from above.
    let listed = transport
        .call(
            RequestContext::unbounded(),
            request(
                14,
                "conflicts.list",
                Some(handle),
                json!({ "status": "open" }),
            ),
        )
        .await
        .expect("the listing survives every refused open");
    let rows = listed.result["conflicts"]
        .as_array()
        .expect("conflict rows");
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["id"], "replicated-largest-legal");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn healthy_conflict_metadata_sits_far_inside_the_row_budget() {
    // AGENTS.md: measure representative healthy work before adding a limit
    // that rejects it. This is that measurement, executable, so a later
    // narrowing of the budget fails HERE rather than on a user's workspace.
    //
    // Case 1: an ordinary conflict this repo's own paths produce. Case 2: the
    // worst metadata a caller can legitimately supply — every free-form
    // metadata field at the 16 KiB cap the sibling write paths enforce.
    let (_scratch, transport, handle, workspace_id) = fixture("healthy-metadata").await;
    seed_conflicts(&transport, &handle, &workspace_id, 1, "a routine body\n").await;
    let listed = transport
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
        .expect("list the ordinary conflict");
    // What the row costs with its bodies removed — the quantity the budget
    // bounds.
    let mut degraded = listed.result["conflicts"][0].clone();
    for side in ["base", "current", "incoming"] {
        if let Some(snapshot) = degraded[side].get_mut("snapshot") {
            snapshot["text"] = Value::Null;
        }
    }
    let ordinary = serde_json::to_string(&degraded)
        .expect("serialize degraded row")
        .len();
    assert!(
        ordinary < 4 * 1024,
        "an ordinary conflict row costs {ordinary} bytes once its bodies are withheld"
    );

    // The legitimate worst case: 16 KiB in each metadata field, on the
    // conflict and on all three sides.
    let field = "s".repeat(16 * 1024);
    let mut maximal = conflict_payload(&workspace_id, 1, "a routine body\n");
    maximal["conflict"]["metadata"]["summary"] = json!(field);
    maximal["conflict"]["metadata"]["correlationId"] = json!(field);
    for side in ["base", "current", "incoming"] {
        maximal["conflict"][side]["metadataSummary"] = json!(field);
        maximal["conflict"][side]["metadataCorrelationId"] = json!(field);
    }
    let opened = transport
        .call(
            RequestContext::unbounded(),
            request(11, "conflicts.open", Some(handle.clone()), maximal),
        )
        .await
        .expect("MUTATION: a budget under the measured healthy range refuses this");
    assert_eq!(opened.result["inserted"], true);

    // And it still lists, which is the property the budget exists to protect.
    let listed = transport
        .call(
            RequestContext::unbounded(),
            request(
                12,
                "conflicts.list",
                Some(handle),
                json!({ "status": "open", "afterConflictId": "conflict-000" }),
            ),
        )
        .await
        .expect("the maximal-metadata conflict lists");
    let mut maximal_row = listed.result["conflicts"][0].clone();
    assert_eq!(maximal_row["id"], "conflict-001");
    // Measured on the SAME quantity the budget bounds — the row with its
    // bodies withheld — not on the full row, whose bodies the budget exempts.
    for side in ["base", "current", "incoming"] {
        if let Some(snapshot) = maximal_row[side].get_mut("snapshot") {
            snapshot["text"] = Value::Null;
        }
    }
    let maximal_cost = serde_json::to_string(&maximal_row)
        .expect("serialize maximal row")
        .len();
    // The headroom the budget keeps over the worst healthy conflict, MEASURED
    // rather than assumed: about 226 KiB against a budget of roughly 8.26 MB,
    // some thirty-five times over. Asserted so a future narrowing of the
    // budget has to confront the measurement here, not a user's workspace.
    assert!(
        maximal_cost * 30 < dohc_engine_domain::CONFLICT_METADATA_BUDGET_BYTES,
        "the budget ({}) must stay far beyond the worst healthy conflict ({maximal_cost} bytes)",
        dohc_engine_domain::CONFLICT_METADATA_BUDGET_BYTES
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_row_over_the_cap_on_the_sum_of_its_bodies_withholds_every_one_of_them() {
    // The AGGREGATE gap. Three sides exactly at the in-band body limit are
    // each individually carriable, so the per-body rule withholds none of
    // them — while their sum, beside metadata near the budget, still carries
    // the row past `CONFLICT_ROW_HARD_CAP_BYTES`. Withholding only the bodies
    // that individually cross would leave the row over the cap and dead-end
    // the cursor for every open conflict, which is #537 again by another
    // route. The failure is the sum, so the remedy is the sum.
    //
    // MUTATION: call `withhold_conflict_side_texts` instead of
    // `withhold_all_conflict_side_texts` in `conflicts_list`, and this listing
    // refuses with `conflict-row-exceeds-wire-limit`.
    let (_scratch, transport, handle, workspace_id) = fixture("aggregate-row").await;
    // Exactly AT the in-band limit, so no side trips the per-body rule.
    let body = "b".repeat(128 * 1024);
    let mut payload = conflict_payload(&workspace_id, 0, &body);
    payload["conflict"]["metadata"]["summary"] = json!("m".repeat(7_960_000));
    let opened = transport
        .call(
            RequestContext::unbounded(),
            request(10, "conflicts.open", Some(handle.clone()), payload),
        )
        .await
        .expect("the conflict is inside the metadata budget and opens");
    assert_eq!(opened.result["inserted"], true);

    let listed = transport
        .call(
            RequestContext::unbounded(),
            request(
                11,
                "conflicts.list",
                Some(handle),
                json!({ "status": "open" }),
            ),
        )
        .await
        .expect("an aggregate over-cap row degrades instead of refusing the page");
    let rows = listed.result["conflicts"]
        .as_array()
        .expect("conflict rows");
    assert_eq!(rows.len(), 1);
    for side in ["base", "current", "incoming"] {
        let snapshot = &rows[0][side]["snapshot"];
        assert!(
            snapshot["text"].is_null(),
            "{side} body must be withheld once the ROW crosses the cap"
        );
        // The caller has to be able to size and fetch what was withheld.
        assert!(snapshot["inbandLimitBytes"].is_number());
        assert_eq!(snapshot["byteLength"], json!(body.len()));
        assert!(snapshot["blobSha256"].is_string());
    }
    // And the degraded row really does fit the cap it was degraded for.
    let encoded = serde_json::to_string(&listed.result).expect("serialize the page");
    assert!(
        encoded.len() <= 8 * 1024 * 1024 - 64 * 1024,
        "the degraded page is {} bytes",
        encoded.len()
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_continuation_id_is_measured_at_both_copies_the_page_serves() {
    // `conflicts.list` serves a conflict id TWICE: once inside its row, and
    // again as `nextAfterConflictId`. Counting one copy would admit an id
    // that then puts the page over the frame, which the daemon's writer
    // treats as fatal rather than answering.
    //
    // MUTATION: count `conflict_id` once in `non_withheld_encoded_bytes` and
    // the over-budget open below succeeds.
    let (_scratch, transport, handle, workspace_id) = fixture("cursor-copies").await;
    // Under one copy this fits the budget; under two it cannot.
    let long_id = "c".repeat(6 * 1024 * 1024);
    let mut payload = conflict_payload(&workspace_id, 0, "small body");
    payload["conflict"]["id"] = json!(long_id);
    let refused = transport
        .call(
            RequestContext::unbounded(),
            request(10, "conflicts.open", Some(handle.clone()), payload),
        )
        .await
        .expect_err("an id the page would serve twice is refused at open");
    assert_eq!(refused.code, ErrorCode::PayloadTooLarge);

    // The ENCODED guard: at the largest id the budget admits, the whole page
    // — leading row plus the continuation it hands back — still fits the
    // frame. This measures what is SERVED rather than summing what is
    // stored, so a string served more times than the budget counts fails
    // here even if nobody remembered to enumerate it.
    let paged_id = "c".repeat(4_000_000);
    let mut first = conflict_payload(&workspace_id, 0, "small body");
    first["conflict"]["id"] = json!(paged_id);
    assert_eq!(
        transport
            .call(
                RequestContext::unbounded(),
                request(11, "conflicts.open", Some(handle.clone()), first),
            )
            .await
            .expect("the largest admitted id opens")
            .result["inserted"],
        true
    );
    let second = conflict_payload(&workspace_id, 1, "small body");
    transport
        .call(
            RequestContext::unbounded(),
            request(12, "conflicts.open", Some(handle.clone()), second),
        )
        .await
        .expect("a second conflict, so the page must emit a continuation");

    let listed = transport
        .call(
            RequestContext::unbounded(),
            request(
                13,
                "conflicts.list",
                Some(handle),
                json!({ "status": "open" }),
            ),
        )
        .await
        .expect("the page answers");
    assert_eq!(listed.result["nextAfterConflictId"], json!(paged_id));
    let encoded = serde_json::to_string(&listed.result).expect("serialize the page");
    assert!(
        encoded.len() <= 8 * 1024 * 1024 - 64 * 1024,
        "a page serving its id twice is {} bytes",
        encoded.len()
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_page_over_the_frame_beside_its_continuation_withholds_every_body() {
    // The row cap bounds a ROW; the frame carries the PAGE. `conflicts.list`
    // appends `nextAfterConflictId` after the rows are cut — a second copy of
    // one row's id — and the pre-persistence budget counts that copy. A side
    // BODY is exempt from that budget, though, so an in-band body can occupy
    // the room the second copy needs: row and cursor are each admissible and
    // their sum is not. The daemon's writer treats an over-frame answer as
    // fatal rather than answering, which is #537's failure shape by a third
    // route.
    //
    // MUTATION: drop the page measure from `conflicts_list` and this page no
    // longer encodes into a control frame.
    let (_scratch, transport, handle, workspace_id) = fixture("page-continuation").await;
    // Inside the budget at the two copies it counts (7 MB of 8,257,536), and
    // the row carrying one copy still fits the row cap beside its bodies.
    let long_id = "c".repeat(3_500_000);
    let body = "b".repeat(1_500_000);
    let mut first = conflict_payload(&workspace_id, 0, &body);
    first["conflict"]["id"] = json!(long_id);
    assert_eq!(
        transport
            .call(
                RequestContext::unbounded(),
                request(10, "conflicts.open", Some(handle.clone()), first),
            )
            .await
            .expect("the conflict is inside the metadata budget and opens")
            .result["inserted"],
        true
    );
    let second = conflict_payload(&workspace_id, 1, "small body");
    transport
        .call(
            RequestContext::unbounded(),
            request(11, "conflicts.open", Some(handle.clone()), second),
        )
        .await
        .expect("a second conflict, so the page must emit a continuation");

    let listed = transport
        .call(
            RequestContext::unbounded(),
            request(
                12,
                "conflicts.list",
                Some(handle),
                json!({ "status": "open" }),
            ),
        )
        .await
        .expect("the page answers");
    let page = listed.result.clone();
    encode_control(&Envelope::Response(listed), &WireLimits::default())
        .expect("the page fits the negotiated control frame");

    // The cursor still advances — withholding shrinks a row, it never drops
    // one — so the second conflict is still reachable.
    assert_eq!(page["nextAfterConflictId"], json!(long_id));
    assert_eq!(page["conflicts"].as_array().expect("rows").len(), 1);
    for side in ["base", "current", "incoming"] {
        let snapshot = &page["conflicts"][0][side]["snapshot"];
        assert!(
            snapshot["text"].is_null(),
            "{side} body must be withheld once the PAGE crosses the frame"
        );
        assert!(snapshot["inbandLimitBytes"].is_number());
        assert_eq!(snapshot["byteLength"], json!(body.len()));
        assert!(snapshot["blobSha256"].is_string());
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_resolve_answer_over_the_frame_withholds_every_body_it_serves() {
    // The resolve answer is bounded per BODY and not in aggregate: the
    // conflict it settles may carry metadata up to
    // `CONFLICT_METADATA_BUDGET_BYTES`, and every body under the 128 KiB
    // in-band limit rides beside it — three sides, the settled snapshot, and
    // the moment's after body. Each part is admissible, their sum is not, and
    // this answer reports a mutation that ALREADY COMMITTED: an over-frame
    // answer loses the acknowledgement for work the workspace kept.
    //
    // MUTATION: drop the aggregate measure from `conflicts_resolve` and this
    // answer no longer encodes into a control frame.
    let (_scratch, transport, handle, workspace_id) = fixture("resolve-aggregate").await;
    let side = "s".repeat(128 * 1024);
    let merged = "m".repeat(120 * 1024);
    // Inside the budget the resolve reserves for a conflict (about 8.12 MB
    // beside these short identifiers), so this answer is one the daemon
    // admits and then has to shrink — the belt, not the bound.
    let summary = "u".repeat(8_000_000);
    let path = open_conflict_against_seeded_head_with(
        &transport,
        &handle,
        &workspace_id,
        10,
        &side,
        |payload| {
            payload["conflict"]["metadata"]["summary"] = json!(summary);
        },
    )
    .await;

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
                    "objectId": "aggregate-resolution-object",
                    "writeMomentId": "aggregate-resolution-write",
                    "deleteMomentId": "aggregate-resolution-delete",
                    "metadataOrigin": "api",
                    "nowMs": 20,
                }}),
            ),
        )
        .await
        .expect("the conflict resolves");
    let answer = resolved.result.clone();
    encode_control(&Envelope::Response(resolved), &WireLimits::default())
        .expect("the resolve answer fits the negotiated control frame");

    for side_name in ["base", "incoming"] {
        let snapshot = &answer["conflict"][side_name]["snapshot"];
        assert_eq!(snapshot["text"], Value::Null, "{side_name} body withheld");
        assert_eq!(snapshot["inbandLimitBytes"], json!(128 * 1024));
        assert_eq!(snapshot["byteLength"], json!(side.len()));
        assert!(snapshot["blobSha256"].is_string());
    }
    let settled = &answer["write"]["snapshot"];
    assert_eq!(settled["text"], Value::Null, "settled body withheld");
    assert_eq!(settled["inbandLimitBytes"], json!(128 * 1024));
    assert_eq!(settled["byteLength"], json!(merged.len()));
    let moment = &answer["write"]["moment"];
    assert_eq!(moment["afterText"], Value::Null, "moment body withheld");
    assert_eq!(moment["afterInbandLimitBytes"], json!(128 * 1024));
    assert!(moment["afterBlobSha256"].is_string());

    // The resolution committed, and the body it settled is whole in the store.
    let head = transport
        .call(
            RequestContext::unbounded(),
            request(
                13,
                "versionedText.read",
                Some(handle),
                json!({ "versionId": "main", "path": path }),
            ),
        )
        .await
        .expect("read the settled head");
    assert_eq!(head.result["text"], json!(merged));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_resolve_whose_withheld_answer_cannot_fit_is_refused_before_it_commits() {
    // Withholding cannot save every answer, and the answer is built AFTER the
    // resolution commits. The strings withholding cannot shrink — this
    // conflict's 8.15 MB of metadata, and a 100 KB object id the answer
    // repeats in `object.id`, `snapshot.objectId` and `moment.objectId` —
    // carry the answer past the frame on their own. Sending it loses the
    // caller's acknowledgement for a mutation the workspace kept; refusing
    // after the commit reports work that happened as work that did not. So
    // the answer is bounded BEFORE anything is written.
    //
    // MUTATION: drop the budget check from `resolve_text_conflict_with` and
    // this resolution commits, and answers past the frame.
    let (_scratch, transport, handle, workspace_id) = fixture("resolve-answer-budget").await;
    let summary = "u".repeat(8_150_000);
    let path = open_conflict_against_seeded_head_with(
        &transport,
        &handle,
        &workspace_id,
        10,
        "incoming",
        |payload| {
            payload["conflict"]["metadata"]["summary"] = json!(summary);
        },
    )
    .await;

    let refused = transport
        .call(
            RequestContext::unbounded(),
            request(
                12,
                "conflicts.resolve",
                Some(handle.clone()),
                json!({ "local": {
                    "conflictId": "conflict-000",
                    "resolution": "apply-merged",
                    "mergedText": "combined",
                    "objectId": "o".repeat(100_000),
                    "writeMomentId": "budget-resolution-write",
                    "deleteMomentId": "budget-resolution-delete",
                    "metadataOrigin": "api",
                    "nowMs": 20,
                }}),
            ),
        )
        .await
        .expect_err("a resolve whose withheld answer cannot fit is refused before it commits");
    assert_eq!(refused.code, ErrorCode::PayloadTooLarge);
    // Constraint, limit, unit, observed — and what the caller most needs to
    // know about a refusal on a mutating route.
    assert!(
        refused
            .message
            .contains("conflict-resolve-answer-exceeds-wire-limit"),
        "the refusal must name the constraint: {}",
        refused.message
    );
    assert!(
        refused.message.contains("encoded bytes")
            && refused.message.contains("Nothing was written."),
        "the refusal must name the unit and say nothing was written: {}",
        refused.message
    );

    // NOTHING WAS WRITTEN. The conflict is still open, and the head still
    // holds what it held before the refusal.
    let listed = transport
        .call(
            RequestContext::unbounded(),
            request(
                13,
                "conflicts.list",
                Some(handle.clone()),
                json!({ "status": "open" }),
            ),
        )
        .await
        .expect("the listing still answers");
    assert_eq!(listed.result["conflicts"][0]["id"], json!("conflict-000"));
    assert_eq!(listed.result["conflicts"][0]["status"], json!("open"));
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
        .expect("read the head the refusal must not have touched");
    assert_eq!(head.result["text"], json!("recorded current"));
    // The moment the refused resolution would have written does not exist.
    let moments = transport
        .call(
            RequestContext::unbounded(),
            request(
                15,
                "moments.list",
                Some(handle),
                json!({ "versionId": "main" }),
            ),
        )
        .await
        .expect("list moments");
    let written = moments.result["moments"]
        .as_array()
        .expect("moment rows")
        .iter()
        .any(|moment| moment["momentId"] == json!("budget-resolution-write"));
    assert!(
        !written,
        "the refused resolution must have written no moment"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_worst_legitimate_resolve_is_admitted() {
    // The measured-limits obligation for the bound above: it must not reject
    // work anyone can legitimately do. The worst legitimate resolve is every
    // free-form field at the 16 KiB cap the sibling write paths enforce, in
    // the escaping-heaviest form (each quote encodes to two bytes), on the
    // conflict AND on the request, with UUID-length identifiers.
    //
    // MUTATION: reserve `RESPONSE_FRAME_BYTES` for the structural allowance
    // and this resolve is refused.
    let (_scratch, transport, handle, workspace_id) = fixture("worst-legitimate").await;
    let field = "\"".repeat(16 * 1024 - 1);
    let path = open_conflict_against_seeded_head_with(
        &transport,
        &handle,
        &workspace_id,
        10,
        "incoming",
        |payload| {
            payload["conflict"]["metadata"]["summary"] = json!(field);
            payload["conflict"]["metadata"]["correlationId"] = json!(field);
            for side in ["base", "current", "incoming"] {
                payload["conflict"][side]["metadataSummary"] = json!(field);
                payload["conflict"][side]["metadataCorrelationId"] = json!(field);
            }
        },
    )
    .await;

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
                    "mergedText": "combined\n",
                    // UUID-length, as every real caller mints them.
                    "objectId": "object-0f9d4b1c-6f3a-4a1e-9c7b-2d5e8f0a1b2c",
                    "writeMomentId": "moment-1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
                    "deleteMomentId": "moment-2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e",
                    "metadataOrigin": "api",
                    "metadataSummary": field,
                    "metadataCorrelationId": field,
                    "nowMs": 20,
                }}),
            ),
        )
        .await
        .expect("the worst legitimate resolve is admitted");
    assert_eq!(resolved.result["conflict"]["resolution"], "applied-merged");
    encode_control(&Envelope::Response(resolved), &WireLimits::default())
        .expect("and its answer crosses as one control frame");

    let head = transport
        .call(
            RequestContext::unbounded(),
            request(
                13,
                "versionedText.read",
                Some(handle),
                json!({ "versionId": "main", "path": path }),
            ),
        )
        .await
        .expect("read the settled head");
    assert_eq!(head.result["text"], json!("combined\n"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_fully_withheld_resolve_answer_fits_its_scaffolding_allowance() {
    // The reservation's third term, executable: the answer's own JSON keys,
    // punctuation and fixed-width fields have to stay inside
    // `RESOLVE_ANSWER_SCAFFOLDING_BYTES`. Measured on a real resolve answer
    // stripped of every free-form string, which leaves exactly that.
    //
    // MUTATION: cut `RESOLVE_ANSWER_SCAFFOLDING_BYTES` to 128 bytes and this
    // fails with the real figure. The allowance is READ, never copied — a
    // local copy of the number would pass whatever the daemon reserved.
    let (_scratch, transport, handle, workspace_id) = fixture("resolve-scaffolding").await;
    open_conflict_against_seeded_head(&transport, &handle, &workspace_id, 10, "incoming").await;
    let resolved = transport
        .call(
            RequestContext::unbounded(),
            request(
                12,
                "conflicts.resolve",
                Some(handle),
                json!({ "local": {
                    "conflictId": "conflict-000",
                    "resolution": "apply-merged",
                    "mergedText": "combined\n",
                    "objectId": "scaffolding-object",
                    "writeMomentId": "scaffolding-write",
                    "deleteMomentId": "scaffolding-delete",
                    "metadataOrigin": "api",
                    "nowMs": 20,
                }}),
            ),
        )
        .await
        .expect("a resolve to measure");
    let mut skeleton = resolved.result.clone();
    blank_every_string(&mut skeleton);
    let scaffolding = serde_json::to_string(&skeleton)
        .expect("serialize the answer skeleton")
        .len();
    assert!(
        scaffolding < dohc_workspace_engine::RESOLVE_ANSWER_SCAFFOLDING_BYTES,
        "a resolve answer's scaffolding is {scaffolding} bytes, which must stay inside the \
         {} byte allowance the reservation makes for it",
        dohc_workspace_engine::RESOLVE_ANSWER_SCAFFOLDING_BYTES
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn side_metadata_is_measured_at_the_two_copies_the_row_actually_carries() {
    // A side's metadata pair is STORED once but SERVED twice: the load reads
    // one column pair into both the side and its snapshot, so the listing row
    // carries two copies. A pre-persistence measure that counts one copy is
    // an under-estimate, and an under-estimate is the one direction this
    // bound must never err in — it would admit exactly the unlistable row the
    // budget exists to refuse.
    //
    // Sized to separate the two rules: six fields of 1 MB each is 6 MB
    // counted once (inside the budget, so a one-copy measure ADMITS it) and
    // 12 MB counted twice (past the budget, and past the row cap the row
    // would actually have to fit).
    //
    // MUTATION: count `metadata_summary`/`metadata_correlation_id` once in
    // `non_withheld_encoded_bytes` and this open succeeds, persisting a
    // conflict whose row no listing can carry.
    let (_scratch, transport, handle, workspace_id) = fixture("side-metadata-copies").await;
    let field = "s".repeat(1_000_000);
    let mut payload = conflict_payload(&workspace_id, 0, "small body");
    for side in ["base", "current", "incoming"] {
        payload["conflict"][side]["metadataSummary"] = json!(field);
        payload["conflict"][side]["metadataCorrelationId"] = json!(field);
    }
    let refused = transport
        .call(
            RequestContext::unbounded(),
            request(10, "conflicts.open", Some(handle), payload),
        )
        .await
        .expect_err("six 1 MB side metadata fields serve as twelve, past the budget");
    assert_eq!(refused.code, ErrorCode::PayloadTooLarge);
    assert!(
        refused.message.contains("12"),
        "the refusal reports the observed size the ROW carries, not the size sent: {}",
        refused.message
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_fully_withheld_conflict_row_fits_the_structural_headroom() {
    // Step 4 of the budget's derivation, executable: the budget is the row cap
    // less a 64 KiB allowance for the row's own JSON scaffolding, so that
    // allowance has to actually cover it. Measured on a row stripped of every
    // free-form string, which leaves exactly the scaffolding — keys,
    // punctuation, and the numbers beside each withheld body.
    //
    // MUTATION: drop `CONFLICT_ROW_STRUCTURAL_HEADROOM_BYTES` to 128 and this
    // fails with the real figure.
    let (_scratch, transport, handle, workspace_id) = fixture("structural-headroom").await;
    seed_conflicts(&transport, &handle, &workspace_id, 1, "a routine body\n").await;
    let listed = transport
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
        .expect("list the probe conflict");
    let mut skeleton = listed.result["conflicts"][0].clone();
    blank_every_string(&mut skeleton);
    let scaffolding = serde_json::to_string(&skeleton)
        .expect("serialize the row skeleton")
        .len();
    assert!(
        scaffolding < dohc_engine_domain::CONFLICT_ROW_STRUCTURAL_HEADROOM_BYTES,
        "a conflict row's scaffolding is {scaffolding} bytes, which must stay inside the \
         {} byte allowance the budget reserves for it",
        dohc_engine_domain::CONFLICT_ROW_STRUCTURAL_HEADROOM_BYTES
    );
}

/// Replace every string in a JSON value with the empty string, leaving the
/// structure, keys and numbers intact.
fn blank_every_string(value: &mut Value) {
    match value {
        Value::String(text) => text.clear(),
        Value::Array(items) => items.iter_mut().for_each(blank_every_string),
        Value::Object(fields) => fields.values_mut().for_each(blank_every_string),
        _ => {}
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_conflict_row_at_the_hard_cap_ships_in_band_and_one_byte_more_degrades() {
    // The degrade trigger's exact boundary, in the sibling pattern of
    // `a_request_that_exactly_fills_the_frame_is_applied_and_one_byte_more_is_refused`.
    // The serialized row size is measured from a probe row — the response
    // carries the same JSON value the daemon measured, and one ASCII 'x'
    // adds exactly one serialized byte — then the payload side is sized to
    // land the row exactly AT the cap, and one byte past it.
    const CAP: usize = 8 * 1024 * 1024 - 64 * 1024;
    let (_scratch, transport, handle, workspace_id) = fixture("row-cap-boundary").await;

    // Probe: one variable side (current), two small sides.
    let probe_len = 8_000_000_usize;
    let payload_with_current = |index: usize, len: usize| {
        let text = "x".repeat(len);
        let sha = dohc_engine_storage::hex_sha256(text.as_bytes());
        let mut payload = conflict_payload(&workspace_id, index, "small");
        payload["conflict"]["current"]["snapshot"]["text"] = json!(text);
        payload["conflict"]["current"]["snapshot"]["blobSha256"] = json!(sha);
        payload
    };
    let opened = transport
        .call(
            RequestContext::unbounded(),
            request(
                10,
                "conflicts.open",
                Some(handle.clone()),
                payload_with_current(0, probe_len),
            ),
        )
        .await
        .expect("open the probe conflict");
    assert_eq!(opened.result["inserted"], true);
    let probe = transport
        .call(
            RequestContext::unbounded(),
            request(
                11,
                "conflicts.list",
                Some(handle.clone()),
                json!({ "status": "open" }),
            ),
        )
        .await
        .expect("list the probe row");
    let probe_row = &probe.result["conflicts"][0];
    assert!(
        probe_row["current"]["snapshot"]["text"].is_string(),
        "the probe row must ride under the cap"
    );
    let probe_size = serde_json::to_string(probe_row)
        .expect("serialize probe row")
        .len();
    // 'x' escapes to itself, and the byte-length digit count is stable across
    // this range (both seven digits), so the delta maps one-to-one.
    let at_cap_len = probe_len + (CAP - probe_size);
    assert_eq!(at_cap_len.to_string().len(), probe_len.to_string().len());

    // AT the cap: the row ships whole, bodies in band.
    let opened = transport
        .call(
            RequestContext::unbounded(),
            request(
                12,
                "conflicts.open",
                Some(handle.clone()),
                payload_with_current(1, at_cap_len),
            ),
        )
        .await
        .expect("open the at-cap conflict");
    assert_eq!(opened.result["inserted"], true);
    // ONE byte past it: degraded to hydratable metadata.
    let opened = transport
        .call(
            RequestContext::unbounded(),
            request(
                13,
                "conflicts.open",
                Some(handle.clone()),
                payload_with_current(2, at_cap_len + 1),
            ),
        )
        .await
        .expect("open the one-past-cap conflict");
    assert_eq!(opened.result["inserted"], true);

    let mut after: Option<String> = Some("conflict-000".to_owned());
    let mut rows = Vec::new();
    while let Some(cursor) = after {
        let page = transport
            .call(
                RequestContext::unbounded(),
                request(
                    14,
                    "conflicts.list",
                    Some(handle.clone()),
                    json!({ "status": "open", "afterConflictId": cursor }),
                ),
            )
            .await
            .expect("list a boundary page");
        for row in page.result["conflicts"].as_array().expect("rows") {
            rows.push(row.clone());
        }
        after = page.result["nextAfterConflictId"]
            .as_str()
            .map(str::to_owned);
    }
    assert_eq!(rows.len(), 2, "both boundary rows list");

    let at_cap = &rows[0];
    assert_eq!(at_cap["id"], "conflict-001");
    let at_cap_size = serde_json::to_string(at_cap)
        .expect("serialize at-cap row")
        .len();
    assert_eq!(
        at_cap_size, CAP,
        "the probe arithmetic must land exactly on the cap"
    );
    assert!(
        at_cap["current"]["snapshot"]["text"].is_string(),
        "MUTATION: degrade at >= instead of > and the at-cap row loses its in-band body"
    );

    let past_cap = &rows[1];
    assert_eq!(past_cap["id"], "conflict-002");
    assert_eq!(
        past_cap["current"]["snapshot"]["text"],
        Value::Null,
        "MUTATION: degrade at > cap + 1 and the first over-cap row refuses the page"
    );
    assert_eq!(
        past_cap["current"]["snapshot"]["inbandLimitBytes"],
        json!(128 * 1024)
    );
}
