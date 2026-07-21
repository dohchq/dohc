//! RPC-B acceptance: the complete R09 chat read/write surface through the
//! in-process protocol transport, backed only by real domain writes.

use dohc_engine_protocol::{
    error::ErrorCode,
    transport::{EngineTransport, InProcessTransport, RequestContext},
    wire::{Request, WorkspaceHandle},
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

async fn open_workspace(
    transport: &InProcessTransport<EngineService>,
    scratch: &ScratchDir,
    id: u64,
    workspace_id: &str,
) -> WorkspaceHandle {
    write_shadow_marker_for_harness(scratch.path(), TOKEN).expect("shadow marker");
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
        .expect("open workspace");
    serde_json::from_value(opened.result["workspace"].clone()).expect("workspace handle")
}

async fn call(
    transport: &InProcessTransport<EngineService>,
    handle: &WorkspaceHandle,
    id: &mut u64,
    method: &str,
    params: Value,
) -> Value {
    *id += 1;
    transport
        .call(
            RequestContext::unbounded(),
            request(*id, method, Some(handle.clone()), params),
        )
        .await
        .unwrap_or_else(|error| panic!("{method} failed: {error:?}"))
        .result
}

async fn call_error(
    transport: &InProcessTransport<EngineService>,
    handle: &WorkspaceHandle,
    id: &mut u64,
    method: &str,
    params: Value,
) -> dohc_engine_protocol::error::WireError {
    *id += 1;
    transport
        .call(
            RequestContext::unbounded(),
            request(*id, method, Some(handle.clone()), params),
        )
        .await
        .unwrap_err()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn chat_rpc_surface_is_bounded_scoped_and_covers_dispatch_lifecycle() {
    let first = ScratchDir::new().expect("first scratch");
    let second = ScratchDir::new().expect("second scratch");
    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let mut first_handle = open_workspace(&transport, &first, 1, "rpc-chat-first").await;
    let second_handle = open_workspace(&transport, &second, 2, "rpc-chat-second").await;
    let mut id = 10;

    let created = call(
        &transport,
        &first_handle,
        &mut id,
        "chats.channels.create",
        json!({
            "channelId": "channel-project",
            "name": "Project Alpha",
            "kind": "channel",
            "nowMs": 10,
        }),
    )
    .await;
    assert_eq!(created["slug"], json!("project-alpha"));
    assert_eq!(created["workspaceId"], json!("rpc-chat-first"));

    let general = call(
        &transport,
        &first_handle,
        &mut id,
        "chats.channels.ensureGeneral",
        json!({ "channelId": "channel-general", "nowMs": 11 }),
    )
    .await;
    assert_eq!(general["slug"], json!("general"));
    let agent = call(
        &transport,
        &first_handle,
        &mut id,
        "chats.channels.ensureAgent",
        json!({ "channelId": "channel-agent", "nowMs": 12 }),
    )
    .await;
    assert_eq!(agent["kind"], json!("agent"));

    let channels = call(
        &transport,
        &first_handle,
        &mut id,
        "chats.channels.list",
        json!({}),
    )
    .await;
    assert_eq!(channels["channels"].as_array().expect("channels").len(), 3);
    let project = channels["channels"]
        .as_array()
        .expect("channels")
        .iter()
        .find(|channel| channel["channelId"].as_str() == Some("channel-project"))
        .expect("project channel");
    assert_eq!(project["threadCount"], json!(0));
    assert_eq!(project["unreadCount"], json!(0));
    let found = call(
        &transport,
        &first_handle,
        &mut id,
        "chats.channels.findBySlug",
        json!({ "slug": "Project Alpha" }),
    )
    .await;
    assert_eq!(found["channelId"], json!("channel-project"));

    let unknown_channel = call_error(
        &transport,
        &first_handle,
        &mut id,
        "chats.threads.start",
        json!({
            "channelId": "missing-channel",
            "threadId": "bad-thread",
            "messageId": "bad-message",
            "title": "Bad",
            "authorKind": "human",
            "authorDisplayName": "Alice",
            "authorUserId": "alice",
            "body": "must fail",
            "nowMs": 20,
        }),
    )
    .await;
    assert_eq!(unknown_channel.code, ErrorCode::InvalidParams);

    let started = call(
        &transport,
        &first_handle,
        &mut id,
        "chats.threads.start",
        json!({
            "channelId": "channel-project",
            "threadId": "thread-1",
            "messageId": "message-0",
            "title": "Launch",
            "authorKind": "human",
            "authorDisplayName": "Alice",
            "authorUserId": "alice",
            "origin": "cli",
            "body": "first message",
            "nowMs": 1000,
        }),
    )
    .await;
    assert_eq!(started["thread"]["threadId"], json!("thread-1"));
    assert_eq!(started["message"]["messageOrder"], json!(0));

    let channels = call(
        &transport,
        &first_handle,
        &mut id,
        "chats.channels.list",
        json!({}),
    )
    .await;
    let project = channels["channels"]
        .as_array()
        .expect("channels")
        .iter()
        .find(|channel| channel["channelId"].as_str() == Some("channel-project"))
        .expect("project channel");
    assert_eq!(project["threadCount"], json!(1));
    assert_eq!(project["unreadCount"], json!(0));

    let threads = call(
        &transport,
        &first_handle,
        &mut id,
        "chats.threads.list",
        json!({}),
    )
    .await;
    assert_eq!(threads["threads"].as_array().expect("threads").len(), 1);

    // 501 more real sends make the message cap observable: a request for 999
    // returns exactly 500 plus a keyset cursor, then the remaining two.
    for sequence in 1..=501_i64 {
        let sent = call(
            &transport,
            &first_handle,
            &mut id,
            "chats.messages.send",
            json!({
                "threadId": "thread-1",
                "messageId": format!("message-{sequence:03}"),
                "authorKind": "agent",
                "authorDisplayName": "My agent",
                "authorUserId": "agent-1",
                "body": format!("message {sequence}"),
                "nowMs": 1000 + sequence,
            }),
        )
        .await;
        assert_eq!(sent["messageOrder"], json!(sequence));
    }

    let channels = call(
        &transport,
        &first_handle,
        &mut id,
        "chats.channels.list",
        json!({}),
    )
    .await;
    let project = channels["channels"]
        .as_array()
        .expect("channels")
        .iter()
        .find(|channel| channel["channelId"].as_str() == Some("channel-project"))
        .expect("project channel");
    assert_eq!(project["threadCount"], json!(1));
    assert_eq!(project["unreadCount"], json!(501));

    let first_page = call(
        &transport,
        &first_handle,
        &mut id,
        "chats.messages.list",
        json!({ "threadId": "thread-1", "limit": 999 }),
    )
    .await;
    assert_eq!(
        first_page["messages"].as_array().expect("messages").len(),
        500
    );

    // BYTE budget, not just row count: a handful of wire-legal 63 KiB
    // bodies must cut the page long before 500 rows — otherwise a framed
    // response exceeds the 1 MiB DOP1 limit and the thread becomes
    // unreadable (the InProcessTransport harness never encodes frames, so
    // this asserts the cut itself).
    {
        call(
            &transport,
            &first_handle,
            &mut id,
            "chats.threads.start",
            json!({
                "channelId": "channel-project",
                "threadId": "thread-big",
                "messageId": "big-0",
                "authorKind": "human",
                "authorDisplayName": "Big",
                "body": "seed",
                "nowMs": 5000,
            }),
        )
        .await;
        let big_body = "b".repeat(63 * 1024);
        for sequence in 1..=6_i64 {
            call(
                &transport,
                &first_handle,
                &mut id,
                "chats.messages.send",
                json!({
                    "threadId": "thread-big",
                    "messageId": format!("big-{sequence}"),
                    "authorKind": "agent",
                    "authorDisplayName": "Big",
                    "body": big_body,
                    "nowMs": 5000 + sequence,
                }),
            )
            .await;
        }
        let cut = call(
            &transport,
            &first_handle,
            &mut id,
            "chats.messages.list",
            json!({ "threadId": "thread-big", "limit": 500 }),
        )
        .await;
        let first_rows = cut["messages"].as_array().expect("messages").len();
        assert!(
            (2..=5).contains(&first_rows),
            "63 KiB bodies must cut the page by BYTES — the tiny seed plus              ~4 big rows fit the 256 KiB budget (got {first_rows} rows)"
        );
        let cursor = cut["nextAfterMessageOrder"]
            .as_i64()
            .expect("byte-cut page carries a cursor");
        let rest = call(
            &transport,
            &first_handle,
            &mut id,
            "chats.messages.list",
            json!({ "threadId": "thread-big", "limit": 500, "afterMessageOrder": cursor }),
        )
        .await;
        let rest_rows = rest["messages"].as_array().expect("messages").len();
        assert_eq!(first_rows + rest_rows, 7, "the pages must cover all rows");
    }
    assert_eq!(first_page["nextAfterMessageOrder"], json!(499));
    let second_page = call(
        &transport,
        &first_handle,
        &mut id,
        "chats.messages.list",
        json!({
            "threadId": "thread-1",
            "limit": 999,
            "afterMessageOrder": first_page["nextAfterMessageOrder"],
        }),
    )
    .await;
    assert_eq!(
        second_page["messages"].as_array().expect("messages").len(),
        2
    );
    assert!(second_page["nextAfterMessageOrder"].is_null());

    let unknown_thread = call_error(
        &transport,
        &first_handle,
        &mut id,
        "chats.messages.list",
        json!({ "threadId": "missing-thread", "limit": 10 }),
    )
    .await;
    assert_eq!(unknown_thread.code, ErrorCode::InvalidParams);

    let read_before = call(
        &transport,
        &first_handle,
        &mut id,
        "chats.readState.get",
        json!({ "threadId": "thread-1" }),
    )
    .await;
    assert_eq!(read_before["lastReadSequence"], json!(1));
    let read_after = call(
        &transport,
        &first_handle,
        &mut id,
        "chats.readState.markThreadRead",
        json!({
            "threadId": "thread-1",
            "upToSequence": 9999,
            "expectedRevision": read_before["revision"],
            "nowMs": 2000,
        }),
    )
    .await;
    assert_eq!(read_after["lastReadSequence"], json!(502));

    let channels = call(
        &transport,
        &first_handle,
        &mut id,
        "chats.channels.list",
        json!({}),
    )
    .await;
    let project = channels["channels"]
        .as_array()
        .expect("channels")
        .iter()
        .find(|channel| channel["channelId"].as_str() == Some("channel-project"))
        .expect("project channel");
    assert_eq!(project["threadCount"], json!(2));
    assert_eq!(project["unreadCount"], json!(6));

    let big_read = call(
        &transport,
        &first_handle,
        &mut id,
        "chats.readState.get",
        json!({ "threadId": "thread-big" }),
    )
    .await;
    call(
        &transport,
        &first_handle,
        &mut id,
        "chats.readState.markThreadRead",
        json!({
            "threadId": "thread-big",
            "upToSequence": 9999,
            "expectedRevision": big_read["revision"],
            "nowMs": 2001,
        }),
    )
    .await;
    let channels = call(
        &transport,
        &first_handle,
        &mut id,
        "chats.channels.list",
        json!({}),
    )
    .await;
    let project = channels["channels"]
        .as_array()
        .expect("channels")
        .iter()
        .find(|channel| channel["channelId"].as_str() == Some("channel-project"))
        .expect("project channel");
    assert_eq!(project["unreadCount"], json!(0));

    call(
        &transport,
        &first_handle,
        &mut id,
        "chats.channels.create",
        json!({
            "channelId": "channel-dm",
            "name": "Private chat",
            "kind": "dm",
            "nowMs": 2050,
        }),
    )
    .await;
    for (target_kind, target_id) in [
        ("channel", "channel-dm"),
        ("thread", "missing-thread"),
        ("person", "non-author"),
    ] {
        let error = call_error(
            &transport,
            &first_handle,
            &mut id,
            "chats.follows.set",
            json!({
                "ownerUserId": "owner-1",
                "targetKind": target_kind,
                "targetId": target_id,
                "state": "following",
                "atMs": 2090,
                "originId": "device-owner-1",
                "originSeq": 1,
            }),
        )
        .await;
        assert_eq!(error.code, ErrorCode::InvalidParams);
    }

    let follow = call(
        &transport,
        &first_handle,
        &mut id,
        "chats.follows.set",
        json!({
            "ownerUserId": "owner-1",
            "targetKind": "thread",
            "targetId": "thread-1",
            "state": "following",
            "atMs": 2100,
            "originId": "device-owner-1",
            "originSeq": 1,
        }),
    )
    .await;
    assert_eq!(follow["state"], json!("following"));
    let follows = call(
        &transport,
        &first_handle,
        &mut id,
        "chats.follows.list",
        json!({ "ownerUserId": "owner-1" }),
    )
    .await;
    assert_eq!(follows["follows"].as_array().expect("follows").len(), 1);

    // The feed domain caps at 100. The RPC clamps a larger request before it
    // reaches the domain and preserves its cursor for the next keyset page.
    let feed = call(
        &transport,
        &first_handle,
        &mut id,
        "chats.feed.listPersonal",
        json!({ "ownerUserId": "owner-1", "limit": 500 }),
    )
    .await;
    assert_eq!(feed["items"].as_array().expect("feed items").len(), 100);
    assert!(feed["nextCursor"].is_string());
    assert!(feed["headCursor"].is_string());
    assert!(feed["readState"].is_null());
    let newest = &feed["items"][0];
    let marked = call(
        &transport,
        &first_handle,
        &mut id,
        "chats.feed.markSeen",
        json!({
            "ownerUserId": "owner-1",
            "lastSeenCreatedAtMs": newest["createdAtMs"],
            "lastSeenMessageId": newest["messageId"],
            "atMs": 2200,
            "originId": "device-owner-1",
            "originSeq": 2,
        }),
    )
    .await;
    assert_eq!(marked["marked"], json!(true));
    let feed_after_seen = call(
        &transport,
        &first_handle,
        &mut id,
        "chats.feed.listPersonal",
        json!({ "ownerUserId": "owner-1", "limit": 500 }),
    )
    .await;
    assert_eq!(feed_after_seen["headCursor"], feed["headCursor"]);
    assert_eq!(
        feed_after_seen["readState"]["workspaceId"],
        json!("rpc-chat-first")
    );
    assert_eq!(
        feed_after_seen["readState"]["ownerUserId"],
        json!("owner-1")
    );
    assert_eq!(
        feed_after_seen["readState"]["lastSeenCreatedAtMs"],
        newest["createdAtMs"]
    );
    assert_eq!(
        feed_after_seen["readState"]["lastSeenMessageId"],
        newest["messageId"]
    );

    let bookmark = call(
        &transport,
        &first_handle,
        &mut id,
        "chats.bookmarks.save",
        json!({
            "bookmarkId": "bookmark-1",
            "ownerUserId": "owner-1",
            "targetKind": "thread",
            "targetId": "thread-1",
            "mode": "live",
            "destinationPath": "bookmarks/launch.md",
            "nowMs": 2300,
        }),
    )
    .await;
    assert_eq!(bookmark["generation"], json!(1));
    assert_eq!(bookmark["projectionState"], json!("pending"));
    let bookmarks = call(
        &transport,
        &first_handle,
        &mut id,
        "chats.bookmarks.list",
        json!({ "ownerUserId": "owner-1" }),
    )
    .await;
    assert_eq!(
        bookmarks["bookmarks"].as_array().expect("bookmarks").len(),
        1
    );
    let wrong_projection_path = call_error(
        &transport,
        &first_handle,
        &mut id,
        "chats.bookmarks.markReady",
        json!({
            "ownerUserId": "owner-1",
            "bookmarkId": "bookmark-1",
            "generation": 1,
            "projectedAtMs": 2301,
            "projectionObjectId": "bookmark-object-1",
            "projectionPath": "bookmarks/wrong.md",
        }),
    )
    .await;
    assert_eq!(wrong_projection_path.code, ErrorCode::InvalidParams);

    let ready = call(
        &transport,
        &first_handle,
        &mut id,
        "chats.bookmarks.markReady",
        json!({
            "ownerUserId": "owner-1",
            "bookmarkId": "bookmark-1",
            "generation": 1,
            "projectedAtMs": 2302,
            "projectionObjectId": "bookmark-object-1",
            "projectionPath": "bookmarks/launch.md",
        }),
    )
    .await;
    assert_eq!(ready["applied"], json!(true));
    assert_eq!(ready["bookmark"]["projectionState"], json!("ready"));
    assert_eq!(
        ready["bookmark"]["projectionObjectId"],
        json!("bookmark-object-1")
    );
    assert_eq!(ready["bookmark"]["projectedGeneration"], json!(1));
    assert_eq!(ready["bookmark"]["lastProjectedAtMs"], json!(2302));
    let bookmarks = call(
        &transport,
        &first_handle,
        &mut id,
        "chats.bookmarks.list",
        json!({ "ownerUserId": "owner-1" }),
    )
    .await;
    assert_eq!(
        bookmarks["bookmarks"][0]["projectionObjectId"],
        json!("bookmark-object-1")
    );

    // Complete, fail, and close/reopen reclaim each exercise a distinct
    // terminal/recovery transition. A claim while another is running is null.
    call(
        &transport,
        &first_handle,
        &mut id,
        "chats.dispatch.enqueue",
        json!({ "triggerMessageId": "message-001", "threadId": "thread-1", "nowMs": 2400 }),
    )
    .await;
    for run_id in [String::new(), "bad\0run".to_owned(), "x".repeat(513)] {
        let error = call_error(
            &transport,
            &first_handle,
            &mut id,
            "chats.dispatch.claimNextPending",
            json!({ "runId": run_id, "command": "agent", "nowMs": 2401 }),
        )
        .await;
        assert_eq!(error.code, ErrorCode::InvalidParams);
    }
    let claimed = call(
        &transport,
        &first_handle,
        &mut id,
        "chats.dispatch.claimNextPending",
        json!({ "runId": "run-complete", "command": "agent", "nowMs": 2401 }),
    )
    .await;
    assert_eq!(claimed["attemptCount"], json!(1));
    let cross_workspace = call_error(
        &transport,
        &second_handle,
        &mut id,
        "chats.dispatch.complete",
        json!({ "runId": "run-complete", "exitCode": 0, "nowMs": 2402 }),
    )
    .await;
    assert_eq!(cross_workspace.code, ErrorCode::InvalidParams);
    call(
        &transport,
        &first_handle,
        &mut id,
        "chats.dispatch.complete",
        json!({ "runId": "run-complete", "exitCode": 0, "nowMs": 2403 }),
    )
    .await;

    call(
        &transport,
        &first_handle,
        &mut id,
        "chats.dispatch.enqueue",
        json!({ "triggerMessageId": "message-002", "threadId": "thread-1", "nowMs": 2410 }),
    )
    .await;
    call(
        &transport,
        &first_handle,
        &mut id,
        "chats.dispatch.claimNextPending",
        json!({ "runId": "run-fail", "nowMs": 2411 }),
    )
    .await;
    call(
        &transport,
        &first_handle,
        &mut id,
        "chats.dispatch.fail",
        json!({ "runId": "run-fail", "reason": "test failure", "exitCode": 7, "nowMs": 2412 }),
    )
    .await;

    call(
        &transport,
        &first_handle,
        &mut id,
        "chats.dispatch.enqueue",
        json!({ "triggerMessageId": "message-003", "threadId": "thread-1", "nowMs": 2420 }),
    )
    .await;
    call(
        &transport,
        &first_handle,
        &mut id,
        "chats.dispatch.claimNextPending",
        json!({ "runId": "run-crashed", "nowMs": 2421 }),
    )
    .await;
    let reclaim_rpc = call_error(
        &transport,
        &first_handle,
        &mut id,
        "chats.dispatch.reclaimRunning",
        json!({ "maxAttempts": 2, "nowMs": 2422 }),
    )
    .await;
    assert_eq!(reclaim_rpc.code, ErrorCode::MethodNotFound);

    // No worker is killed here: closing the workspace simulates the process
    // boundary. The next actual open performs the one safe reclaim sweep.
    call(
        &transport,
        &first_handle,
        &mut id,
        "workspace.close",
        json!({}),
    )
    .await;
    id += 1;
    first_handle = open_workspace(&transport, &first, id, "rpc-chat-first").await;
    let retry = call(
        &transport,
        &first_handle,
        &mut id,
        "chats.dispatch.claimNextPending",
        json!({ "runId": "run-retry", "nowMs": 2423 }),
    )
    .await;
    assert_eq!(retry["attemptCount"], json!(2));

    // A second close/reopen reclaims the second crashed attempt as exhausted.
    call(
        &transport,
        &first_handle,
        &mut id,
        "workspace.close",
        json!({}),
    )
    .await;
    id += 1;
    first_handle = open_workspace(&transport, &first, id, "rpc-chat-first").await;
    let no_claim = call(
        &transport,
        &first_handle,
        &mut id,
        "chats.dispatch.claimNextPending",
        json!({ "runId": "run-none", "nowMs": 2425 }),
    )
    .await;
    assert!(no_claim.is_null());

    // The second handle derives a different workspace id server-side and sees
    // none of the first workspace's state across every list family.
    let second_channels = call(
        &transport,
        &second_handle,
        &mut id,
        "chats.channels.list",
        json!({}),
    )
    .await;
    assert!(
        second_channels["channels"]
            .as_array()
            .expect("channels")
            .is_empty()
    );
    let second_threads = call(
        &transport,
        &second_handle,
        &mut id,
        "chats.threads.list",
        json!({}),
    )
    .await;
    assert!(
        second_threads["threads"]
            .as_array()
            .expect("threads")
            .is_empty()
    );
    let second_follows = call(
        &transport,
        &second_handle,
        &mut id,
        "chats.follows.list",
        json!({ "ownerUserId": "owner-1" }),
    )
    .await;
    assert!(
        second_follows["follows"]
            .as_array()
            .expect("follows")
            .is_empty()
    );
    let second_feed = call(
        &transport,
        &second_handle,
        &mut id,
        "chats.feed.listPersonal",
        json!({ "ownerUserId": "owner-1", "limit": 20 }),
    )
    .await;
    assert!(second_feed["items"].as_array().expect("feed").is_empty());
    let second_bookmarks = call(
        &transport,
        &second_handle,
        &mut id,
        "chats.bookmarks.list",
        json!({ "ownerUserId": "owner-1" }),
    )
    .await;
    assert!(
        second_bookmarks["bookmarks"]
            .as_array()
            .expect("bookmarks")
            .is_empty()
    );

    call(
        &transport,
        &first_handle,
        &mut id,
        "workspace.close",
        json!({}),
    )
    .await;
    call(
        &transport,
        &second_handle,
        &mut id,
        "workspace.close",
        json!({}),
    )
    .await;
}
