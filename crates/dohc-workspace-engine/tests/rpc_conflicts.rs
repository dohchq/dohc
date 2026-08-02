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
async fn merged_resolution_past_the_frame_limit_is_refused_by_name() {
    // MUTATION: drop the limit, the unit, or the observed size from the
    // message -> the refusal names nothing an agent can act on and this fails.
    let (_scratch, transport, handle, workspace_id) = fixture("past-frame-limit").await;
    let path =
        open_conflict_against_seeded_head(&transport, &handle, &workspace_id, 10, "incoming").await;
    let limit = WireLimits::SPIKE_DEFAULTS.max_frame_bytes as usize - 64 * 1024;
    // Every newline encodes as two bytes, so this body is 4 MiB raw and 8 MiB
    // once encoded: under any raw-byte budget, past the frame that has to
    // carry it. A raw-byte check would accept it here and let the client's own
    // framer refuse it, with no limit named anywhere.
    //
    // MUTATION: measure `text.len()` instead of the encoded length -> the
    // resolve is accepted and this refusal never happens.
    let newlines = "\n".repeat(4 * 1024 * 1024);
    let encoded_newlines = newlines.len() * 2 + 2;
    assert!(newlines.len() < limit && encoded_newlines > limit);
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
            .contains(&format!("observed {encoded_newlines} encoded bytes")),
        "the refusal must measure the encoded body: {}",
        escaped.message
    );

    let merged = "x".repeat(limit + 1);
    let encoded = merged.len() + 2;

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
        refused.message.contains(&format!("{limit} encoded bytes")),
        "the refusal must name the limit and its unit: {}",
        refused.message
    );
    assert!(
        refused
            .message
            .contains(&format!("observed {encoded} encoded bytes")),
        "the refusal must name the observed size: {}",
        refused.message
    );
    assert!(
        refused
            .message
            .contains(&format!("({} raw bytes)", merged.len())),
        "the refusal must name the raw size the caller sent: {}",
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
async fn the_largest_accepted_body_crosses_as_a_complete_request_envelope() {
    // The budget is stated in encoded bytes and spent on the BODY, while the
    // frame carries the whole envelope. This pins the headroom that makes the
    // stated bound the enforced one: a body at exactly the limit, inside a
    // real `conflicts.resolve` request, still encodes into one control frame.
    //
    // MUTATION: raise MAX_MERGED_RESOLUTION_TEXT_BYTES to the frame limit ->
    // the envelope no longer encodes.
    let limit = WireLimits::SPIKE_DEFAULTS.max_frame_bytes as usize - 64 * 1024;
    let envelope = Envelope::Request(request(
        12,
        "conflicts.resolve",
        Some(WorkspaceHandle("ws-0000000000000001".to_owned())),
        json!({ "local": {
            "conflictId": "conflict-000",
            // Encoded length == raw length + the two quotes.
            "resolution": "apply-merged",
            "mergedText": "x".repeat(limit - 2),
            "objectId": "largest-resolution-object",
            "writeMomentId": "largest-resolution-write",
            "deleteMomentId": "largest-resolution-delete",
            "metadataOrigin": "api",
            "nowMs": 20,
        }}),
    ));
    let encoded = encode_control(&envelope, &WireLimits::default())
        .expect("a body at the limit still crosses as one control frame");
    assert!(encoded.len() <= WireLimits::SPIKE_DEFAULTS.max_frame_bytes as usize);
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
