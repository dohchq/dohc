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
    for reserved in ["channel_wire_general_v1", "channel_wire_agent_v1"] {
        let error = call_error(
            &transport,
            &first_handle,
            &mut id,
            "chats.channels.create",
            json!({
                "channelId": reserved,
                "name": format!("Reserved {reserved}"),
                "kind": "channel",
                "nowMs": 10,
            }),
        )
        .await;
        assert_eq!(error.code, ErrorCode::InvalidParams);
    }

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

    let reserved_first_message = call_error(
        &transport,
        &first_handle,
        &mut id,
        "chats.threads.start",
        json!({
            "channelId": "channel-project",
            "threadId": "reserved-message-thread",
            "messageId": "__thread__",
            "authorKind": "human",
            "authorDisplayName": "Alice",
            "body": "must fail",
            "nowMs": 21,
        }),
    )
    .await;
    assert_eq!(reserved_first_message.code, ErrorCode::InvalidParams);

    let overlong_message_id = "x".repeat(257);
    let byte_heavy_message_id = "😀".repeat(200);
    let overlong_first_message = call_error(
        &transport,
        &first_handle,
        &mut id,
        "chats.threads.start",
        json!({
            "channelId": "channel-project",
            "threadId": "overlong-message-thread",
            "messageId": overlong_message_id,
            "authorKind": "human",
            "authorDisplayName": "Alice",
            "body": "must fail",
            "nowMs": 22,
        }),
    )
    .await;
    assert_eq!(overlong_first_message.code, ErrorCode::InvalidParams);
    let byte_heavy_first_message = call_error(
        &transport,
        &first_handle,
        &mut id,
        "chats.threads.start",
        json!({
            "channelId": "channel-project",
            "threadId": "byte-heavy-message-thread",
            "messageId": byte_heavy_message_id.clone(),
            "authorKind": "human",
            "authorDisplayName": "Alice",
            "body": "must fail",
            "nowMs": 22,
        }),
    )
    .await;
    assert_eq!(byte_heavy_first_message.code, ErrorCode::InvalidParams);

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

    let overlong_send = call_error(
        &transport,
        &first_handle,
        &mut id,
        "chats.messages.send",
        json!({
            "threadId": "thread-1",
            "messageId": "x".repeat(257),
            "authorKind": "agent",
            "authorDisplayName": "My agent",
            "body": "must fail",
            "nowMs": 1001,
        }),
    )
    .await;
    assert_eq!(overlong_send.code, ErrorCode::InvalidParams);
    let byte_heavy_send = call_error(
        &transport,
        &first_handle,
        &mut id,
        "chats.messages.send",
        json!({
            "threadId": "thread-1",
            "messageId": byte_heavy_message_id,
            "authorKind": "agent",
            "authorDisplayName": "My agent",
            "body": "must fail",
            "nowMs": 1001,
        }),
    )
    .await;
    assert_eq!(byte_heavy_send.code, ErrorCode::InvalidParams);

    let max_cursor_message_id = format!("{}abc", "😀".repeat(89));
    assert_eq!(max_cursor_message_id.len(), 359);
    call(
        &transport,
        &first_handle,
        &mut id,
        "chats.threads.start",
        json!({
            "channelId": "channel-general",
            "threadId": "cursor-cap-thread",
            "messageId": max_cursor_message_id.clone(),
            "authorKind": "human",
            "authorDisplayName": "Alice",
            "body": "cursor cap newest",
            "nowMs": 1000,
        }),
    )
    .await;
    call(
        &transport,
        &first_handle,
        &mut id,
        "chats.messages.send",
        json!({
            "threadId": "cursor-cap-thread",
            "messageId": "cursor-cap-older",
            "authorKind": "human",
            "authorDisplayName": "Alice",
            "body": "cursor cap older",
            "nowMs": 999,
        }),
    )
    .await;
    call(
        &transport,
        &first_handle,
        &mut id,
        "chats.follows.set",
        json!({
            "ownerUserId": "cursor-cap-owner",
            "targetKind": "thread",
            "targetId": "cursor-cap-thread",
            "state": "following",
            "nowMs": 1002,
        }),
    )
    .await;
    let cursor_cap_page = call(
        &transport,
        &first_handle,
        &mut id,
        "chats.feed.listPersonal",
        json!({ "ownerUserId": "cursor-cap-owner", "limit": 1 }),
    )
    .await;
    assert_eq!(
        cursor_cap_page["items"][0]["messageId"],
        json!(max_cursor_message_id)
    );
    let cursor_cap_next = cursor_cap_page["nextCursor"]
        .as_str()
        .expect("exact-byte-budget message-id cursor")
        .to_owned();
    let cursor_cap_seen = call(
        &transport,
        &first_handle,
        &mut id,
        "chats.feed.markSeen",
        json!({
            "ownerUserId": "cursor-cap-owner",
            "headCursor": cursor_cap_next.clone(),
            "nowMs": 1003,
        }),
    )
    .await;
    assert_eq!(
        cursor_cap_seen["lastSeenMessageId"],
        json!(max_cursor_message_id)
    );
    let cursor_cap_remainder = call(
        &transport,
        &first_handle,
        &mut id,
        "chats.feed.listPersonal",
        json!({
            "ownerUserId": "cursor-cap-owner",
            "limit": 1,
            "cursor": cursor_cap_next,
        }),
    )
    .await;
    assert_eq!(
        cursor_cap_remainder["items"][0]["messageId"],
        json!("cursor-cap-older")
    );

    let search_started = call(
        &transport,
        &first_handle,
        &mut id,
        "chats.threads.start",
        json!({
            "channelId": "channel-general",
            "threadId": "thread-search",
            "messageId": "message-search-seed",
            "authorKind": "human",
            "authorDisplayName": "Alice",
            "body": "search seed\nrest",
            "nowMs": 1001,
        }),
    )
    .await;
    assert_eq!(search_started["thread"]["title"], json!("search seed"));
    let reserved_message = call_error(
        &transport,
        &first_handle,
        &mut id,
        "chats.messages.send",
        json!({
            "threadId": "thread-search",
            "messageId": "__thread__",
            "authorKind": "agent",
            "authorDisplayName": "My agent",
            "body": "must not replace the header",
            "nowMs": 1002,
        }),
    )
    .await;
    assert_eq!(reserved_message.code, ErrorCode::InvalidParams);
    // Prime the durable search state. The next stable-policy query will not run
    // the repair rebuild, so only write-time indexing can expose the new message.
    call(
        &transport,
        &first_handle,
        &mut id,
        "search.query",
        json!({ "versionId": "main", "query": "search seed", "nowMs": 1002 }),
    )
    .await;
    call(
        &transport,
        &first_handle,
        &mut id,
        "chats.messages.send",
        json!({
            "threadId": "thread-search",
            "messageId": "message-search-fresh",
            "authorKind": "agent",
            "authorDisplayName": "My agent",
            "body": "fresh r2indexsentinel payload",
            "nowMs": 1003,
        }),
    )
    .await;
    let write_time_search = call(
        &transport,
        &first_handle,
        &mut id,
        "search.query",
        json!({ "versionId": "main", "query": "r2indexsentinel", "nowMs": 1004 }),
    )
    .await;
    // Mutation guard: removing the send-message FTS upsert must make this fail;
    // no policy transition occurs between the priming and asserting queries.
    assert!(
        write_time_search
            .as_array()
            .expect("search results")
            .iter()
            .any(|result| result["surface"] == "chat" && result["threadId"] == "thread-search")
    );

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
    assert_eq!(threads["threads"].as_array().expect("threads").len(), 3);
    assert_eq!(
        threads["threads"]
            .as_array()
            .expect("threads")
            .iter()
            .find(|thread| thread["threadId"] == "thread-search")
            .expect("untitled thread")["title"],
        json!("search seed")
    );

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
                "nowMs": 2090,
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
            "nowMs": 2100,
        }),
    )
    .await;
    assert_eq!(follow["state"], json!("following"));
    assert_eq!(follow["workspaceId"], json!("rpc-chat-first"));
    assert!(follow.get("originId").is_none());
    assert!(follow.get("originSeq").is_none());
    let forged_origin = call_error(
        &transport,
        &first_handle,
        &mut id,
        "chats.follows.set",
        json!({
            "ownerUserId": "owner-1",
            "targetKind": "thread",
            "targetId": "thread-1",
            "state": "following",
            "originId": "forged-origin",
        }),
    )
    .await;
    assert_eq!(forged_origin.code, ErrorCode::InvalidParams);
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
    let head_cursor = feed["headCursor"].clone();
    let marked = call(
        &transport,
        &first_handle,
        &mut id,
        "chats.feed.markSeen",
        json!({
            "ownerUserId": "owner-1",
            "headCursor": head_cursor,
            "nowMs": 2200,
        }),
    )
    .await;
    assert_eq!(marked["ownerUserId"], json!("owner-1"));
    assert_eq!(marked["lastSeenCreatedAtMs"], newest["createdAtMs"]);
    assert_eq!(marked["lastSeenMessageId"], newest["messageId"]);
    let garbage_cursor = call_error(
        &transport,
        &first_handle,
        &mut id,
        "chats.feed.markSeen",
        json!({
            "ownerUserId": "owner-1",
            "headCursor": "!!!not-a-feed-cursor!!!",
        }),
    )
    .await;
    assert_eq!(garbage_cursor.code, ErrorCode::InvalidParams);
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

    call(
        &transport,
        &first_handle,
        &mut id,
        "chats.follows.set",
        json!({
            "ownerUserId": "feed-budget-owner",
            "targetKind": "channel",
            "targetId": "channel-project",
            "state": "following",
            "nowMs": 2250,
        }),
    )
    .await;
    for sequence in 0..6_i64 {
        let huge_thread_id = format!("feed-{sequence}-{}", "t".repeat(60 * 1024));
        call(
            &transport,
            &first_handle,
            &mut id,
            "chats.threads.start",
            json!({
                "channelId": "channel-project",
                "threadId": huge_thread_id,
                "messageId": format!("feed-budget-message-{sequence}"),
                "authorKind": "human",
                "authorDisplayName": "Feed",
                "body": "feed budget seed",
                "nowMs": 2260 + sequence,
            }),
        )
        .await;
    }
    let budget_page = call(
        &transport,
        &first_handle,
        &mut id,
        "chats.feed.listPersonal",
        json!({ "ownerUserId": "feed-budget-owner", "limit": 100 }),
    )
    .await;
    let budget_first_count = budget_page["items"].as_array().expect("budget feed").len();
    assert!(
        (3..=5).contains(&budget_first_count),
        "large thread ids must cut the feed page by serialized bytes"
    );
    let budget_cursor = budget_page["nextCursor"]
        .as_str()
        .expect("byte-cut feed cursor")
        .to_owned();
    let budget_rest = call(
        &transport,
        &first_handle,
        &mut id,
        "chats.feed.listPersonal",
        json!({
            "ownerUserId": "feed-budget-owner",
            "limit": 100,
            "cursor": budget_cursor,
        }),
    )
    .await;
    assert_eq!(
        budget_first_count + budget_rest["items"].as_array().expect("budget rest").len(),
        8,
        "the byte-cut cursor must resume after the last included coordinate"
    );

    let caller_supplied_bookmark_id = call_error(
        &transport,
        &first_handle,
        &mut id,
        "chats.bookmarks.save",
        json!({
            "bookmarkId": "caller-controlled",
            "ownerUserId": "owner-1",
            "targetKind": "thread",
            "targetId": "thread-1",
            "mode": "live",
            "destinationPath": "bookmarks/launch.md",
            "nowMs": 2299,
        }),
    )
    .await;
    assert_eq!(caller_supplied_bookmark_id.code, ErrorCode::InvalidParams);
    let bookmark = call(
        &transport,
        &first_handle,
        &mut id,
        "chats.bookmarks.save",
        json!({
            "ownerUserId": "owner-1",
            "targetKind": "thread",
            "targetId": "thread-1",
            "mode": "live",
            "destinationPath": "bookmarks/launch.md",
            "nowMs": 2300,
        }),
    )
    .await;
    let bookmark_id = bookmark["bookmarkId"]
        .as_str()
        .expect("derived bookmark id")
        .to_owned();
    assert!(bookmark_id.starts_with("bookmark_"));
    assert_eq!(bookmark["workspaceId"], json!("rpc-chat-first"));
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
    assert_eq!(
        bookmarks["bookmarks"][0]["workspaceId"],
        json!("rpc-chat-first")
    );
    let wrong_projection_path = call_error(
        &transport,
        &first_handle,
        &mut id,
        "chats.bookmarks.markReady",
        json!({
            "ownerUserId": "owner-1",
            "bookmarkId": &bookmark_id,
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
            "bookmarkId": &bookmark_id,
            "generation": 1,
            "projectedAtMs": 2302,
            "projectionObjectId": "bookmark-object-1",
            "projectionPath": "bookmarks/launch.md",
        }),
    )
    .await;
    assert_eq!(ready["applied"], json!(true));
    assert_eq!(ready["bookmark"]["workspaceId"], json!("rpc-chat-first"));
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
    let moved_bookmark = call(
        &transport,
        &first_handle,
        &mut id,
        "chats.bookmarks.save",
        json!({
            "ownerUserId": "owner-1",
            "targetKind": "thread",
            "targetId": "thread-1",
            "mode": "live",
            "destinationPath": "bookmarks/moved.md",
            "nowMs": 2303,
        }),
    )
    .await;
    assert_eq!(moved_bookmark["bookmarkId"], json!(&bookmark_id));
    assert_eq!(moved_bookmark["generation"], json!(2));
    assert_eq!(moved_bookmark["projectionObjectId"], Value::Null);
    let moved_ready = call(
        &transport,
        &first_handle,
        &mut id,
        "chats.bookmarks.markReady",
        json!({
            "ownerUserId": "owner-1",
            "bookmarkId": &bookmark_id,
            "generation": 2,
            "projectedAtMs": 2304,
            "projectionObjectId": "bookmark-object-2",
            "projectionPath": "bookmarks/moved.md",
        }),
    )
    .await;
    assert_eq!(moved_ready["applied"], json!(true));
    assert_eq!(
        moved_ready["bookmark"]["projectionObjectId"],
        json!("bookmark-object-2")
    );

    // Complete, fail, and close/reopen reclaim each exercise a distinct
    // terminal/recovery transition. A claim while another is running is null.
    let enqueued = call(
        &transport,
        &first_handle,
        &mut id,
        "chats.dispatch.enqueue",
        json!({ "triggerMessageId": "message-001", "threadId": "thread-1", "nowMs": 2400 }),
    )
    .await;
    assert_eq!(enqueued["enqueued"], json!(true));
    let duplicate = call(
        &transport,
        &first_handle,
        &mut id,
        "chats.dispatch.enqueue",
        json!({ "triggerMessageId": "message-001", "threadId": "thread-1", "nowMs": 2400 }),
    )
    .await;
    assert_eq!(duplicate["enqueued"], json!(false));
    let conflicting_thread = call_error(
        &transport,
        &first_handle,
        &mut id,
        "chats.dispatch.enqueue",
        json!({ "triggerMessageId": "message-001", "threadId": "thread-big", "nowMs": 2400 }),
    )
    .await;
    assert_eq!(conflicting_thread.code, ErrorCode::Internal);
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
    for invalid_command in [
        json!("bad\0command"),
        json!("   "),
        json!("x".repeat(16_385)),
    ] {
        let error = call_error(
            &transport,
            &first_handle,
            &mut id,
            "chats.dispatch.claimNextPending",
            json!({ "runId": "run-1", "command": invalid_command, "nowMs": 2401 }),
        )
        .await;
        assert_eq!(error.code, ErrorCode::InvalidParams);
    }
    for invalid_path in [json!(""), json!("bad\0path"), json!("x".repeat(16_385))] {
        let error = call_error(
            &transport,
            &first_handle,
            &mut id,
            "chats.dispatch.claimNextPending",
            json!({
                "runId": "run-1",
                "command": "agent",
                "logPath": invalid_path,
                "nowMs": 2401,
            }),
        )
        .await;
        assert_eq!(error.code, ErrorCode::InvalidParams);
    }
    let claimed = call(
        &transport,
        &first_handle,
        &mut id,
        "chats.dispatch.claimNextPending",
        json!({
            "runId": " run-1 ",
            "command": "  runner --once  ",
            "logPath": "  logs/run-1.log  ",
            "nowMs": 2401,
        }),
    )
    .await;
    assert_eq!(claimed["dispatch"]["attemptCount"], json!(1));
    assert_eq!(claimed["dispatch"]["state"], json!("running"));
    assert_eq!(claimed["dispatch"]["workspaceId"], json!("rpc-chat-first"));
    assert_eq!(claimed["dispatch"]["runId"], json!("run-1"));
    assert_eq!(claimed["dispatch"]["failureReason"], Value::Null);
    assert_eq!(claimed["run"]["runId"], json!("run-1"));
    assert_eq!(claimed["run"]["command"], json!("  runner --once  "));
    assert_eq!(claimed["run"]["startedAtMs"], json!(2401));
    assert_eq!(claimed["run"]["endedAtMs"], Value::Null);
    assert_eq!(claimed["run"]["exitCode"], Value::Null);
    assert_eq!(claimed["run"]["failureReason"], Value::Null);
    assert_eq!(claimed["run"]["logPath"], json!("  logs/run-1.log  "));
    assert_eq!(claimed["run"]["failureNotePosted"], json!(false));
    let retried_claim = call(
        &transport,
        &first_handle,
        &mut id,
        "chats.dispatch.claimNextPending",
        json!({
            "runId": "run-1",
            "command": "ignored retry command",
            "nowMs": 2402,
        }),
    )
    .await;
    assert_eq!(retried_claim, claimed);
    let blocked_claim = call(
        &transport,
        &first_handle,
        &mut id,
        "chats.dispatch.claimNextPending",
        json!({ "runId": "run-other", "nowMs": 2402 }),
    )
    .await;
    assert!(blocked_claim.is_null());
    let cross_workspace = call_error(
        &transport,
        &second_handle,
        &mut id,
        "chats.dispatch.complete",
        json!({ "runId": "run-1", "exitCode": 0, "nowMs": 2402 }),
    )
    .await;
    assert_eq!(cross_workspace.code, ErrorCode::InvalidParams);
    call(
        &transport,
        &first_handle,
        &mut id,
        "chats.dispatch.complete",
        json!({ "runId": "run-1", "exitCode": 0, "nowMs": 2403 }),
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
    for invalid_reason in [json!("   "), json!("x".repeat(16_385)), json!(7)] {
        let error = call_error(
            &transport,
            &first_handle,
            &mut id,
            "chats.dispatch.fail",
            json!({
                "runId": "run-fail",
                "reason": invalid_reason,
                "exitCode": 7,
                "nowMs": 2412,
            }),
        )
        .await;
        assert_eq!(error.code, ErrorCode::InvalidParams);
    }
    call(
        &transport,
        &first_handle,
        &mut id,
        "chats.dispatch.fail",
        json!({ "runId": "run-fail", "reason": "  test failure  ", "exitCode": 7, "nowMs": 2412 }),
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
    assert_eq!(retry["dispatch"]["attemptCount"], json!(2));

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
