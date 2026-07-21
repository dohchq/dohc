//! RPC-C acceptance: daemon-owned Y.Doc sessions over the in-process
//! transport, with real domain writes, materialization, capture, and leases.

use base64::Engine as _;
use dohc_engine_collab::Ydoc;
use dohc_engine_protocol::{
    error::ErrorCode,
    transport::{EngineTransport, InProcessTransport, RequestContext},
    wire::{Request, WorkspaceHandle},
};
use dohc_engine_testkit::ScratchDir;
use dohc_workspace_engine::{EngineService, shadow_fence::write_shadow_marker_for_harness};
use serde_json::{Value, json};
use std::{path::Path, sync::Arc, time::Duration};

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
        .unwrap_or_else(|error| panic!("{method} failed: {error:?}"))
        .result
}

async fn open_workspace(
    transport: &InProcessTransport<EngineService>,
    scratch: &ScratchDir,
    workspace_id: &str,
    id: u64,
) -> WorkspaceHandle {
    let opened = transport
        .call(
            RequestContext::unbounded(),
            request(
                id,
                "workspace.open",
                None,
                json!({
                    "rootDir": scratch.path().to_string_lossy(),
                    "workspaceId": workspace_id,
                }),
            ),
        )
        .await
        .expect("workspace open");
    serde_json::from_value(opened.result["workspace"].clone()).expect("workspace handle")
}

fn write_file(root: &Path, path: &str, bytes: &[u8]) {
    let absolute = root.join(path);
    if let Some(parent) = absolute.parent() {
        std::fs::create_dir_all(parent).expect("create parent");
    }
    std::fs::write(absolute, bytes).expect("write file");
}

fn plaintext_update(text: &str) -> String {
    let doc = Ydoc::wire();
    base64::engine::general_purpose::STANDARD.encode(doc.plaintext_insert(0, text))
}

async fn moment_count_for_object(
    transport: &InProcessTransport<EngineService>,
    handle: &WorkspaceHandle,
    id: u64,
    object_id: &str,
) -> usize {
    call(
        transport,
        handle,
        id,
        "moments.list",
        json!({ "objectId": object_id, "limit": 100 }),
    )
    .await["moments"]
        .as_array()
        .expect("moments")
        .len()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn daemon_ydoc_sessions_settle_suppress_capture_and_roundtrip() {
    let scratch = ScratchDir::new().expect("scratch");
    write_shadow_marker_for_harness(scratch.path(), TOKEN).expect("marker");
    write_file(scratch.path(), "notes/live.md", b"before");
    write_file(scratch.path(), "notes/race.md", b"race base");
    write_file(
        scratch.path(),
        "binary.png",
        &[0x89, 0x50, 0x4e, 0x47, 0x00, 0xff],
    );

    let service = Arc::new(EngineService::new());
    let transport = InProcessTransport::new(service);
    let handle = open_workspace(&transport, &scratch, "ws-rpc-ydoc", 1).await;

    let opened = call(
        &transport,
        &handle,
        2,
        "ydoc.open",
        json!({
            "versionId": "main",
            "path": "notes/live.md",
            "contentKind": "plaintext"
        }),
    )
    .await;
    assert_eq!(opened["lineage"], json!("absent"));
    assert_eq!(opened["seedMarkdown"], json!("before"));
    let session_id = opened["sessionId"].as_str().expect("session id");
    let object_id = opened["objectId"].as_str().expect("object id");
    assert!(session_id.starts_with("ydoc-"));
    assert_eq!(session_id.len(), "ydoc-".len() + 16);

    let busy = transport
        .call(
            RequestContext::unbounded(),
            request(
                3,
                "ydoc.open",
                Some(handle.clone()),
                json!({ "versionId": "main", "path": "notes/live.md" }),
            ),
        )
        .await
        .expect_err("a second live lease must refuse");
    assert_eq!(busy.code, ErrorCode::InvalidParams);
    assert_eq!(busy.message, "ydoc-session-busy");

    let external = transport
        .call(
            RequestContext::unbounded(),
            request(
                4,
                "ydoc.applyExternalMarkdownEdit",
                Some(handle.clone()),
                json!({ "sessionId": session_id, "markdown": "external" }),
            ),
        )
        .await
        .expect_err("live external edit is a C1 refusal");
    assert_eq!(external.code, ErrorCode::InvalidParams);
    assert_eq!(external.message, "external-edit-unsupported-live");

    let before_moments = moment_count_for_object(&transport, &handle, 5, object_id).await;
    let recorded = call(
        &transport,
        &handle,
        6,
        "ydoc.recordUpdate",
        json!({
            "sessionId": session_id,
            "updateBase64": plaintext_update("settled text")
        }),
    )
    .await;
    assert_eq!(recorded["seq"], json!(1));
    assert_eq!(recorded["deduped"], json!(false));
    let settled = call(
        &transport,
        &handle,
        7,
        "ydoc.settle",
        json!({ "sessionId": session_id, "summary": "RPC-C settle" }),
    )
    .await;
    assert_eq!(settled["markdown"], json!("settled text"));
    assert_eq!(settled["projection"]["contentKind"], json!("plaintext"));
    assert_eq!(settled["projection"]["destructive"], json!(false));
    assert_eq!(
        std::fs::read_to_string(scratch.path().join("notes/live.md")).expect("materialized"),
        "settled text"
    );
    assert!(
        std::fs::read_dir(scratch.path().join("notes"))
            .expect("notes dir")
            .all(|entry| !entry
                .expect("entry")
                .file_name()
                .to_string_lossy()
                .ends_with(".conflict")),
        "settling over an existing file must not create a spurious conflict"
    );
    let fetched = call(
        &transport,
        &handle,
        8,
        "moments.get",
        json!({ "momentId": settled["momentId"] }),
    )
    .await;
    assert_eq!(fetched["afterText"], json!("settled text"));

    tokio::time::sleep(Duration::from_millis(800)).await;
    let flushed = call(&transport, &handle, 9, "capture.flush", json!({})).await;
    assert_eq!(flushed["settled"], json!(true));
    let after_moments = moment_count_for_object(&transport, &handle, 10, object_id).await;
    assert_eq!(after_moments, before_moments + 1);
    // Mutation check: disable the SelfWriteSuppression::record call after
    // settlement to restore the bug. Identical-content ingest is a deduped
    // no-op moment-wise, so the count above stays +1 either way — the real
    // damage is the CLAIMED dedupe transferring ownership: capture's Changed
    // observation flips the settled head's metadata origin from "ydoc" to the
    // capture origin. This assertion fails under that mutation.
    let head = call(
        &transport,
        &handle,
        91,
        "versionedText.read",
        json!({ "versionId": "main", "path": "notes/live.md" }),
    )
    .await;
    assert_eq!(
        head["metadataOrigin"],
        json!("ydoc"),
        "capture must not claim the daemon's own settlement write"
    );

    call(
        &transport,
        &handle,
        11,
        "ydoc.close",
        json!({ "sessionId": session_id, "settle": false }),
    )
    .await;
    let reopened = call(
        &transport,
        &handle,
        12,
        "ydoc.open",
        json!({ "versionId": "main", "path": "notes/live.md" }),
    )
    .await;
    // The local-only close PRUNED the CRDT cache to the bare marker
    // (markdown-is-the-artifact), so the reopen must NOT claim an existing
    // lineage — that would hand the client an empty doc with nothing to seed
    // from, and its next settle would clobber the settled file. Instead the
    // artifact re-seeds the cache: lineage absent + seedMarkdown carrying the
    // settled content.
    assert_eq!(reopened["lineage"], json!("absent"));
    assert_eq!(reopened["seedMarkdown"], json!("settled text"));
    let reopened_session = reopened["sessionId"].as_str().expect("reopened session");
    let reseeded = call(
        &transport,
        &handle,
        13,
        "ydoc.recordUpdate",
        json!({
            "sessionId": reopened_session,
            "updateBase64": plaintext_update("settled text")
        }),
    )
    .await;
    assert_eq!(reseeded["seq"], json!(1));
    let resync = call(
        &transport,
        &handle,
        32,
        "ydoc.resync",
        json!({ "sessionId": reopened_session }),
    )
    .await;
    // Decode the resync state and prove the durable lineage now carries the
    // re-seeded settled content — equality with an empty state can't pass.
    let resync_state = base64::engine::general_purpose::STANDARD
        .decode(
            resync["initialUpdateBase64"]
                .as_str()
                .expect("resync state"),
        )
        .expect("resync state decodes");
    let resynced_doc = Ydoc::wire();
    resynced_doc
        .apply(&resync_state)
        .expect("resync state applies");
    assert_eq!(resynced_doc.plaintext_string(), "settled text");
    call(
        &transport,
        &handle,
        14,
        "ydoc.close",
        json!({ "sessionId": reopened_session }),
    )
    .await;

    let rich = call(
        &transport,
        &handle,
        15,
        "ydoc.open",
        json!({
            "versionId": "main",
            "path": "notes/rich.md",
            "contentKind": "richdoc"
        }),
    )
    .await;
    let rich_session = rich["sessionId"].as_str().expect("rich session");
    let rich_refusal = transport
        .call(
            RequestContext::unbounded(),
            request(
                16,
                "ydoc.settle",
                Some(handle.clone()),
                json!({ "sessionId": rich_session }),
            ),
        )
        .await
        .expect_err("richdoc settle is gated in C1");
    assert_eq!(rich_refusal.message, "richdoc-settle-unsupported");
    call(
        &transport,
        &handle,
        17,
        "ydoc.close",
        json!({ "sessionId": rich_session }),
    )
    .await;

    let binary = transport
        .call(
            RequestContext::unbounded(),
            request(
                18,
                "ydoc.open",
                Some(handle.clone()),
                json!({ "versionId": "main", "path": "binary.png" }),
            ),
        )
        .await
        .expect_err("binary heads cannot open as Y.Doc text");
    assert_eq!(binary.code, ErrorCode::InvalidParams);

    let race = call(
        &transport,
        &handle,
        19,
        "ydoc.open",
        json!({ "versionId": "main", "path": "notes/race.md" }),
    )
    .await;
    assert_eq!(race["lineage"], json!("absent"));
    let race_session = race["sessionId"].as_str().expect("race session");
    // The legacy append path cannot advance the CRDT behind a live editor:
    // the session's lease is single-writer, so the old raced-seed scenario
    // (apply a durable head under an open absent session) is refused at the
    // door. The recordUpdate seed guard stays as actor-level defense-in-depth.
    let busy_apply = transport
        .call(
            RequestContext::unbounded(),
            request(
                20,
                "ydoc.apply",
                Some(handle.clone()),
                json!({
                    "versionId": "main",
                    "objectId": race["objectId"],
                    "contentKind": "plaintext",
                    "updateBase64": plaintext_update("winner")
                }),
            ),
        )
        .await
        .expect_err("a leased doc refuses legacy appends");
    assert_eq!(busy_apply.message, "ydoc-session-busy");
    // An untouched absent session closes without settling (nothing durable
    // exists to project) and releases the lease.
    call(
        &transport,
        &handle,
        21,
        "ydoc.close",
        json!({ "sessionId": race_session }),
    )
    .await;
    call(
        &transport,
        &handle,
        22,
        "ydoc.apply",
        json!({
            "versionId": "main",
            "objectId": race["objectId"],
            "contentKind": "plaintext",
            "updateBase64": plaintext_update("winner")
        }),
    )
    .await;
    let reraced = call(
        &transport,
        &handle,
        33,
        "ydoc.open",
        json!({ "versionId": "main", "path": "notes/race.md" }),
    )
    .await;
    assert_eq!(
        reraced["lineage"],
        json!("existing"),
        "a lineage created after the lease released is existing on reopen"
    );
    // Default close settles the raced winner over its captured base and
    // prunes cleanly.
    call(
        &transport,
        &handle,
        34,
        "ydoc.close",
        json!({ "sessionId": reraced["sessionId"] }),
    )
    .await;

    let isolated = call(
        &transport,
        &handle,
        23,
        "ydoc.open",
        json!({ "versionId": "main", "path": "notes/isolated.md" }),
    )
    .await;
    let isolated_session = isolated["sessionId"].as_str().expect("isolated session");
    let other = ScratchDir::new().expect("other scratch");
    write_shadow_marker_for_harness(other.path(), TOKEN).expect("other marker");
    write_file(other.path(), "bootstrap.md", b"other");
    let other_handle = open_workspace(&transport, &other, "ws-rpc-ydoc-other", 24).await;
    let cross_workspace = transport
        .call(
            RequestContext::unbounded(),
            request(
                25,
                "ydoc.resync",
                Some(other_handle.clone()),
                json!({ "sessionId": isolated_session }),
            ),
        )
        .await
        .expect_err("session ids are workspace scoped");
    assert_eq!(cross_workspace.message, "ydoc-session-not-found");
    // workspace.close drops every bound session and therefore its lease.
    call(&transport, &handle, 26, "workspace.close", json!({})).await;
    let reopened_handle = open_workspace(&transport, &scratch, "ws-rpc-ydoc", 27).await;
    let after_workspace_close = call(
        &transport,
        &reopened_handle,
        28,
        "ydoc.open",
        json!({ "versionId": "main", "path": "notes/isolated.md" }),
    )
    .await;
    call(
        &transport,
        &reopened_handle,
        29,
        "ydoc.close",
        json!({ "sessionId": after_workspace_close["sessionId"] }),
    )
    .await;
    call(
        &transport,
        &reopened_handle,
        30,
        "workspace.close",
        json!({}),
    )
    .await;
    call(&transport, &other_handle, 31, "workspace.close", json!({})).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn settle_without_a_seeded_lineage_refuses_and_leaves_the_file_intact() {
    let scratch = ScratchDir::new().expect("scratch");
    write_shadow_marker_for_harness(scratch.path(), TOKEN).expect("marker");
    write_file(scratch.path(), "notes/precious.md", b"precious content");

    let service = Arc::new(EngineService::new());
    let transport = InProcessTransport::new(service);
    let handle = open_workspace(&transport, &scratch, "ws-rpc-ydoc-noseed", 1).await;

    let opened = call(
        &transport,
        &handle,
        2,
        "ydoc.open",
        json!({
            "versionId": "main",
            "path": "notes/precious.md",
            "contentKind": "plaintext"
        }),
    )
    .await;
    assert_eq!(opened["lineage"], json!("absent"));
    let session_id = opened["sessionId"].as_str().expect("session id");

    // Mutation check: restore `None => Ydoc::wire()` in ydoc_settle_on_store's
    // load_persisted match to bring the bug back — the settle then projects an
    // EMPTY doc over the existing file and both assertions below fail.
    let refused = transport
        .call(
            RequestContext::unbounded(),
            request(
                3,
                "ydoc.settle",
                Some(handle.clone()),
                json!({ "sessionId": session_id, "summary": "no seed" }),
            ),
        )
        .await
        .expect_err("settling an un-seeded lineage must refuse");
    assert_eq!(refused.code, ErrorCode::InvalidParams);

    assert_eq!(
        std::fs::read_to_string(scratch.path().join("notes/precious.md"))
            .expect("file still readable"),
        "precious content",
        "a refused settle must not touch the file"
    );
    let head = call(
        &transport,
        &handle,
        4,
        "versionedText.read",
        json!({ "versionId": "main", "path": "notes/precious.md" }),
    )
    .await;
    assert_eq!(head["text"], json!("precious content"));

    call(
        &transport,
        &handle,
        5,
        "ydoc.close",
        json!({ "sessionId": session_id, "settle": false }),
    )
    .await;
    call(&transport, &handle, 6, "workspace.close", json!({})).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn settle_refuses_after_the_path_changes_owners() {
    let scratch = ScratchDir::new().expect("scratch");
    write_shadow_marker_for_harness(scratch.path(), TOKEN).expect("marker");
    // An unrelated captured file establishes the main version; the contested
    // path itself stays absent until the rival write claims it.
    write_file(scratch.path(), "notes/seed.md", b"seed");

    let service = Arc::new(EngineService::new());
    let transport = InProcessTransport::new(service);
    let handle = open_workspace(&transport, &scratch, "ws-rpc-ydoc-owner", 1).await;

    let opened = call(
        &transport,
        &handle,
        2,
        "ydoc.open",
        json!({
            "versionId": "main",
            "path": "notes/claimed.md",
            "contentKind": "plaintext"
        }),
    )
    .await;
    assert_eq!(opened["lineage"], json!("absent"));
    let session_id = opened["sessionId"].as_str().expect("session id");
    call(
        &transport,
        &handle,
        3,
        "ydoc.recordUpdate",
        json!({
            "sessionId": session_id,
            "updateBase64": plaintext_update("session text")
        }),
    )
    .await;

    // Another writer claims the same path with a DIFFERENT object before the
    // session settles.
    call(
        &transport,
        &handle,
        4,
        "versionedText.write",
        json!({
            "versionId": "main",
            "objectId": "other-object",
            "path": "notes/claimed.md",
            "text": "the other owner's content",
            "momentId": "moment-other-owner",
            "metadataOrigin": "agent"
        }),
    )
    .await;

    // Mutation check: drop the object_id ownership comparison in
    // ydoc_settle_on_store to restore the bug — the stale session projection
    // then overwrites the other object's head and this refusal assertion
    // fails (and the content assertion below would read "session text").
    let refused = transport
        .call(
            RequestContext::unbounded(),
            request(
                5,
                "ydoc.settle",
                Some(handle.clone()),
                json!({ "sessionId": session_id, "summary": "stale owner" }),
            ),
        )
        .await
        .expect_err("settling after the path changed owners must refuse");
    assert_eq!(refused.code, ErrorCode::InvalidParams);

    let head = call(
        &transport,
        &handle,
        6,
        "versionedText.read",
        json!({ "versionId": "main", "path": "notes/claimed.md" }),
    )
    .await;
    assert_eq!(head["text"], json!("the other owner's content"));
    assert_eq!(head["objectId"], json!("other-object"));

    // The session cannot settle (stale owner) and cannot prune-close
    // (UnsettledClose guard: recorded edits with no matching artifact) —
    // workspace.close is the teardown path that releases its lease.
    call(&transport, &handle, 7, "workspace.close", json!({})).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn creating_a_new_file_through_a_ydoc_session_settles_to_disk() {
    let scratch = ScratchDir::new().expect("scratch");
    write_shadow_marker_for_harness(scratch.path(), TOKEN).expect("marker");
    write_file(scratch.path(), "notes/seed.md", b"seed");

    let service = Arc::new(EngineService::new());
    let transport = InProcessTransport::new(service);
    let handle = open_workspace(&transport, &scratch, "ws-rpc-ydoc-create", 1).await;

    // notes/created.md exists NOWHERE: not on disk, no head, no lineage. The
    // seed path pre-creates the file_objects row for the marker FK; the
    // settle's projected write must accept that preallocated object instead
    // of refusing "already bound".
    let opened = call(
        &transport,
        &handle,
        2,
        "ydoc.open",
        json!({
            "versionId": "main",
            "path": "notes/created.md",
            "contentKind": "plaintext"
        }),
    )
    .await;
    assert_eq!(opened["lineage"], json!("absent"));
    assert_eq!(opened["seedMarkdown"], Value::Null);
    let session_id = opened["sessionId"].as_str().expect("session id");

    call(
        &transport,
        &handle,
        3,
        "ydoc.recordUpdate",
        json!({
            "sessionId": session_id,
            "updateBase64": plaintext_update("fresh content")
        }),
    )
    .await;
    let settled = call(
        &transport,
        &handle,
        4,
        "ydoc.settle",
        json!({ "sessionId": session_id, "summary": "create" }),
    )
    .await;
    assert_eq!(settled["markdown"], json!("fresh content"));
    assert_eq!(
        std::fs::read_to_string(scratch.path().join("notes/created.md")).expect("created"),
        "fresh content"
    );
    let head = call(
        &transport,
        &handle,
        5,
        "versionedText.read",
        json!({ "versionId": "main", "path": "notes/created.md" }),
    )
    .await;
    assert_eq!(head["text"], json!("fresh content"));
    assert_eq!(head["objectId"], opened["objectId"]);
    assert_eq!(head["metadataOrigin"], json!("ydoc"));

    call(
        &transport,
        &handle,
        6,
        "ydoc.close",
        json!({ "sessionId": session_id }),
    )
    .await;
    call(&transport, &handle, 7, "workspace.close", json!({})).await;
}
