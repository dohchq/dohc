//! The complete chat read/write surface through the in-process protocol
//! transport, backed only by real domain writes.

use crate::common;

use common::*;
use dohc_engine_protocol::{
    error::ErrorCode,
    transport::{InProcessTransport, RequestContext},
    wire::WorkspaceHandle,
};
use dohc_engine_storage::{EngineStore, NoFaults, StorageError};
use dohc_engine_sync::{ReplicationEnvelope, apply_chat_envelope};
use dohc_engine_testkit::{ScratchDir, engine_db_path};
use dohc_workspace_engine::{EngineService, root_binding::write_root_binding};
use serde_json::{Value, json};
use std::sync::Arc;

async fn open_workspace(
    transport: &InProcessTransport<EngineService>,
    scratch: &ScratchDir,
    id: u64,
    workspace_id: &str,
) -> WorkspaceHandle {
    write_root_binding(scratch.path(), TOKEN).expect("root binding");
    let opened = call_with_busy_retry(
        transport,
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
    // Boxed so the scenario retains a pointer while the bounded busy retry runs.
    Box::pin(call_with_busy_retry(
        transport,
        RequestContext::unbounded(),
        request(*id, method, Some(handle.clone()), params),
    ))
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
    Box::pin(call_with_busy_retry(
        transport,
        RequestContext::unbounded(),
        request(*id, method, Some(handle.clone()), params),
    ))
    .await
    .unwrap_err()
}

async fn call_with_idempotency(
    transport: &InProcessTransport<EngineService>,
    handle: &WorkspaceHandle,
    id: &mut u64,
    method: &str,
    idempotency_key: &str,
    params: Value,
) -> Value {
    *id += 1;
    let mut request = request(*id, method, Some(handle.clone()), params);
    request.idempotency_key = Some(idempotency_key.to_owned());
    call_with_busy_retry(transport, RequestContext::unbounded(), request)
        .await
        .unwrap_or_else(|error| panic!("{method} failed: {error:?}"))
        .result
}

async fn call_error_with_idempotency(
    transport: &InProcessTransport<EngineService>,
    handle: &WorkspaceHandle,
    id: &mut u64,
    method: &str,
    idempotency_key: &str,
    params: Value,
) -> dohc_engine_protocol::error::WireError {
    *id += 1;
    let mut request = request(*id, method, Some(handle.clone()), params);
    request.idempotency_key = Some(idempotency_key.to_owned());
    call_with_busy_retry(transport, RequestContext::unbounded(), request)
        .await
        .unwrap_err()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn reactions_decisions_and_personal_feed_hydrate_over_rpc() {
    let scratch = ScratchDir::new().expect("scratch");
    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let handle = open_workspace(&transport, &scratch, 1, "rpc-b2-round3").await;
    let mut id = 10;
    call(
        &transport,
        &handle,
        &mut id,
        "chats.channels.create",
        json!({
            "channelId": "channel",
            "name": "General",
            "kind": "channel",
            "nowMs": 10,
        }),
    )
    .await;
    call(
        &transport,
        &handle,
        &mut id,
        "chats.threads.start",
        json!({
            "channelId": "channel",
            "threadId": "thread",
            "messageId": "decision",
            "authorKind": "human",
            "authorDisplayName": "Ada",
            "authorUserId": "ada",
            "body": "Choose",
            "needsDecision": true,
            "nowMs": 20,
        }),
    )
    .await;
    let decisions = call(
        &transport,
        &handle,
        &mut id,
        "chats.decisions.listForThread",
        json!({ "threadId": "thread" }),
    )
    .await;
    assert_eq!(
        decisions["decisions"][0]["state"],
        json!("open"),
        "omitting needsDecision from the strict DTO/domain input -> the opening decision is absent over DOP1."
    );

    let resolved = call_with_idempotency(
        &transport,
        &handle,
        &mut id,
        "chats.decisions.resolve",
        "resolve",
        json!({
            "threadId": "thread",
            "messageId": "decision",
            "resolvedByMessageId": "not-present-yet",
            "nowMs": 30,
        }),
    )
    .await;
    assert_eq!(
        resolved["resolvedByMessageId"],
        json!("not-present-yet"),
        "requiring the resolver row to exist -> a valid head-check-free resolver is rejected."
    );
    let malformed = call_error_with_idempotency(
        &transport,
        &handle,
        &mut id,
        "chats.decisions.resolve",
        "malformed",
        json!({
            "threadId": "thread",
            "messageId": "decision",
            "resolvedByMessageId": "",
            "nowMs": 31,
        }),
    )
    .await;
    assert_eq!(
        malformed.code,
        ErrorCode::InvalidParams,
        "mapping malformed resolver input to state-corrupt -> wire code becomes INTERNAL."
    );
    assert_eq!(malformed.message, "invalid-message-body");

    let reaction = call_with_idempotency(
        &transport,
        &handle,
        &mut id,
        "chats.reactions.set",
        "reaction",
        json!({
            "threadId": "thread",
            "messageId": "decision",
            "emoji": "👍",
            "author": {
                "authorId": "ada",
                "kind": "human",
                "displayName": "Ada",
            },
            "replicationAuthorId": "ada",
            "state": "added",
            "nowMs": 40,
        }),
    )
    .await;
    assert_eq!(reaction["emoji"], json!("👍"));
    let mismatched_author = call_error_with_idempotency(
        &transport,
        &handle,
        &mut id,
        "chats.reactions.set",
        "mismatched-author",
        json!({
            "threadId": "thread",
            "messageId": "decision",
            "emoji": "👍",
            "author": {
                "authorId": "ada",
                "kind": "human",
                "displayName": "Ada",
            },
            "replicationAuthorId": "other-user",
            "state": "removed",
        }),
    )
    .await;
    assert_eq!(mismatched_author.code, ErrorCode::InvalidParams);
    assert_eq!(mismatched_author.message, "invalid-sender");
    let invalid_state = call_error_with_idempotency(
        &transport,
        &handle,
        &mut id,
        "chats.reactions.set",
        "bad-state",
        json!({
            "threadId": "thread",
            "messageId": "decision",
            "emoji": "👍",
            "author": {
                "authorId": "ada",
                "kind": "human",
                "displayName": "Ada",
            },
            "state": "unknown",
        }),
    )
    .await;
    assert_eq!(
        invalid_state.code,
        ErrorCode::InvalidParams,
        "routing an unknown wire literal through persisted-row decoding -> caller input is mislabeled INTERNAL."
    );
    assert_eq!(invalid_state.message, "invalid-parameters");
    let reactions = call(
        &transport,
        &handle,
        &mut id,
        "chats.reactions.list",
        json!({ "threadId": "thread" }),
    )
    .await;
    assert_eq!(
        reactions["reactions"][0]["reactionId"],
        reaction["reactionId"]
    );

    call(
        &transport,
        &handle,
        &mut id,
        "chats.follows.set",
        json!({
            "ownerUserId": "viewer",
            "targetKind": "thread",
            "targetId": "thread",
            "state": "following",
            "nowMs": 41,
        }),
    )
    .await;
    let feed = call(
        &transport,
        &handle,
        &mut id,
        "chats.feed.listPersonal",
        json!({ "ownerUserId": "viewer", "limit": 10 }),
    )
    .await;
    assert_eq!(
        feed["items"][0]["reactions"][0]["emoji"],
        json!("👍"),
        "serializing the parked `reactions: []` placeholder -> active feed reactions vanish at the wire boundary."
    );

    call(
        &transport,
        &handle,
        &mut id,
        "chats.threads.start",
        json!({
            "channelId": "channel",
            "threadId": "newer-thread",
            "messageId": "newer-opening",
            "authorKind": "human",
            "authorDisplayName": "Ada",
            "body": "Newer",
            "nowMs": 50,
        }),
    )
    .await;
    let first_page = call(
        &transport,
        &handle,
        &mut id,
        "chats.threads.listForChannel",
        json!({ "channelId": "channel", "pageLimit": 1 }),
    )
    .await;
    assert_eq!(
        first_page["threads"][0]["thread"]["id"],
        json!("newer-thread")
    );
    let next_cursor = first_page["nextCursor"]
        .as_str()
        .expect("channel summary cursor")
        .to_owned();
    let second_page = call(
        &transport,
        &handle,
        &mut id,
        "chats.threads.listForChannel",
        json!({
            "channelId": "channel",
            "pageLimit": 1,
            "cursor": next_cursor,
        }),
    )
    .await;
    let summary = &second_page["threads"][0];
    assert_eq!(
        summary["thread"]["id"],
        json!("thread"),
        "shipping a prefix-only channel list or omitting the full aggregate -> older page/full opening reaction is unavailable."
    );
    assert_eq!(summary["messageCount"], json!(1));
    assert_eq!(summary["openDecisionCount"], json!(0));
    assert_eq!(
        summary["openingMessage"]["reactions"][0]["emoji"],
        json!("👍")
    );
    assert!(second_page["nextCursor"].is_null());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn attachments_and_file_threads_keep_their_wire_contracts() {
    let scratch = ScratchDir::new().expect("scratch");
    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let handle = open_workspace(&transport, &scratch, 1, "rpc-b2-attachments").await;
    let mut id = 10;
    let thread = call_with_idempotency(
        &transport,
        &handle,
        &mut id,
        "chats.threads.create",
        "create-file-thread",
        json!({
            "threadId": "file-thread",
            "title": "File thread",
            "linkedFile": { "objectId": "object-1", "pathHint": "notes/file.md" },
            "nowMs": 20,
        }),
    )
    .await;
    assert_eq!(
        thread,
        json!({
            "id": "file-thread",
            "workspaceId": "rpc-b2-attachments",
            "title": "File thread",
            "createdAtMs": 20,
            "updatedAtMs": 20,
            "lane": "posts",
            "linkedFile": {
                "objectId": "object-1",
                "pathHint": "notes/file.md",
                "linkedAtMs": 20,
            }
        }),
        "omit linked owner hydration -> canonical Thread loses its stable file identity.",
    );
    let sent = call(
        &transport,
        &handle,
        &mut id,
        "chats.messages.send",
        json!({
            "threadId": "file-thread",
            "messageId": "message-1",
            "authorKind": "human",
            "authorDisplayName": "Ada",
            "body": "See the source",
            "attachments": [{
                "objectId": "object-1",
                "pathHint": "notes/file.md",
                "headingText": "Heading",
                "headingAnchor": "heading",
                "headingOccurrence": 0
            }],
            "nowMs": 30,
        }),
    )
    .await;
    assert_eq!(
        sent["attachments"].as_array().expect("attachments").len(),
        1,
        "omit authoritative attachment hydration from send -> result is incomplete.",
    );
    assert_eq!(sent["id"], json!("message-1"));
    let attachments = call(
        &transport,
        &handle,
        &mut id,
        "chats.attachments.listForThread",
        json!({ "threadId": "file-thread", "pageLimit": 10 }),
    )
    .await;
    assert_eq!(
        attachments["attachments"]
            .as_array()
            .expect("attachment page")
            .len(),
        1
    );
    // The page resolves identities against main, even when its subject is workspace-wide.
    call(
        &transport,
        &handle,
        &mut id,
        "versions.ensureMain",
        json!({ "workspaceId": "rpc-b2-attachments" }),
    )
    .await;
    // Reusing the hint must not make object-1 resolve to this different object.
    call(
        &transport,
        &handle,
        &mut id,
        "versionedText.write",
        json!({
            "versionId": "main",
            "objectId": "object-2",
            "path": "notes/file.md",
            "text": "A different file now owns this path.",
            "momentId": "reuse-file-hint",
            "origin": "api",
            "nowMs": 31
        }),
    )
    .await;
    let mentions = call(
        &transport,
        &handle,
        &mut id,
        "chats.attachments.listFileMentions",
        json!({ "scope": "owner", "sharedChannelRowsUncovered": 0 }),
    )
    .await;
    assert_eq!(
        mentions,
        json!({
            "versionId": "main",
            "subject": null,
            "entries": [],
            "unchecked": [],
            "complete": true,
            "indexBuilding": false,
            "mountsCovered": true,
            "sharedChannelRowsUncovered": 0,
            "nextCursor": null
        }),
        "A missing object never falls back to its old path hint."
    );
    call(
        &transport,
        &handle,
        &mut id,
        "chats.follows.set",
        json!({
            "ownerUserId": "feed-viewer",
            "targetKind": "thread",
            "targetId": "file-thread",
            "state": "following",
            "nowMs": 31,
        }),
    )
    .await;
    let feed = call(
        &transport,
        &handle,
        &mut id,
        "chats.feed.listPersonal",
        json!({ "ownerUserId": "feed-viewer", "limit": 10 }),
    )
    .await;
    assert_eq!(
        feed["items"][0]["message"]["attachments"]
            .as_array()
            .expect("feed message attachments")
            .len(),
        1,
        "route Feed through the legacy slim serializers -> both of these authoritative B2 fields disappear.",
    );
    assert_eq!(
        feed["items"][0]["thread"]["linkedFile"],
        json!({
            "objectId": "object-1",
            "pathHint": "notes/file.md",
            "linkedAtMs": 20,
        })
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn mentions_backfill_marker_makes_second_open_a_noop() {
    let scratch = ScratchDir::new().expect("scratch");
    write_root_binding(scratch.path(), TOKEN).expect("root binding");
    let db_path = engine_db_path(&scratch).expect("db path");
    let mut store = EngineStore::open(&db_path, 1).expect("store");
    store.bind_root_token(TOKEN, &NoFaults).expect("bind token");
    store
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT INTO chat_channels \
                 (workspace_id,channel_id,name,slug,kind,created_at_ms,updated_at_ms) \
                 VALUES ('rpc-b2-mentions','channel','Channel','channel','channel',1,1)",
                [],
            )
            .map_err(StorageError::persist_public)?;
            tx.execute(
                "INSERT INTO chat_threads \
                 (workspace_id,thread_id,title,created_at_ms,updated_at_ms,channel_id) \
                 VALUES ('rpc-b2-mentions','thread','Thread',20,20,'channel')",
                [],
            )
            .map_err(StorageError::persist_public)?;
            tx.execute(
                "INSERT INTO chat_messages \
                 (workspace_id,thread_id,message_order,message_id,author_kind,author_display_name,body,created_at_ms) \
                 VALUES ('rpc-b2-mentions','thread',0,'message','human','Ada',\
                         'hello @agent @agent.ops_v2 @ſK',20)",
                [],
            )
            .map_err(StorageError::persist_public)?;
            Ok::<_, StorageError>(())
        })
        .expect("seed pre-index database");
    drop(store);

    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let handle = open_workspace(&transport, &scratch, 1, "rpc-b2-mentions").await;
    let mut id = 10;
    let mentions = call(
        &transport,
        &handle,
        &mut id,
        "chats.mentions.listForHandle",
        json!({ "handle": "AGENT", "pageLimit": 10 }),
    )
    .await;
    assert_eq!(
        mentions,
        json!({
            "mentions": [{
                "threadId": "thread",
                "messageId": "message",
                "handle": "agent",
                "authorKind": "human",
                "createdAtMs": 20
            }],
            "nextCursor": null
        }),
        "handing out the workspace before backfill makes this first read empty.",
    );
    for (query, normalized) in [
        ("AGENT.OPS_V2...", "agent.ops_v2"),
        ("\u{017F}\u{212A}_", "\u{017F}k"),
    ] {
        let mentions = call(
            &transport,
            &handle,
            &mut id,
            "chats.mentions.listForHandle",
            json!({ "handle": query, "pageLimit": 10 }),
        )
        .await;
        assert_eq!(
            mentions["mentions"][0]["handle"],
            json!(normalized),
            "retain the narrow ASCII alphanumeric/hyphen validator -> this indexed row is unqueryable."
        );
        assert_eq!(mentions["mentions"][0]["messageId"], json!("message"));
    }

    call(&transport, &handle, &mut id, "workspace.close", json!({})).await;
    let conn = rusqlite::Connection::open(&db_path).expect("open closed engine db");
    conn.execute(
        "INSERT INTO chat_messages \
         (workspace_id,thread_id,message_order,message_id,author_kind,author_display_name,body,created_at_ms) \
         VALUES ('rpc-b2-mentions','thread',1,'raw-after-marker','human','Ada','@raw',30)",
        [],
    )
    .expect("insert raw post-marker message");
    drop(conn);

    let reopened = open_workspace(&transport, &scratch, id + 1, "rpc-b2-mentions").await;
    let raw_mentions = call(
        &transport,
        &reopened,
        &mut id,
        "chats.mentions.listForHandle",
        json!({ "handle": "raw", "pageLimit": 10 }),
    )
    .await;
    assert!(
        raw_mentions["mentions"]
            .as_array()
            .expect("raw mentions")
            .is_empty(),
        "drop or ignore the durable completion marker -> the second open reparses this raw fixture row and hides the write-time-indexing invariant by making it visible.",
    );
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
    let general_wire = call(
        &transport,
        &first_handle,
        &mut id,
        "chats.channels.getWireId",
        json!({ "channelId": "channel-general" }),
    )
    .await;
    assert_eq!(general_wire["wireId"], json!("channel_wire_general_v1"));
    let unknown_wire = call_error(
        &transport,
        &first_handle,
        &mut id,
        "chats.channels.getWireId",
        json!({ "channelId": "missing-channel" }),
    )
    .await;
    assert_eq!(unknown_wire.code, ErrorCode::InvalidParams);
    assert_eq!(general["slug"], json!("general"));
    let agent = call(
        &transport,
        &first_handle,
        &mut id,
        "chats.channels.ensureAgent",
        json!({
            "channelId": "channel-agent",
            "agentId": "default",
            "name": "My agent",
            "nowMs": 12,
        }),
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
    assert_eq!(started["thread"]["id"], json!("thread-1"));
    assert_eq!(started["message"]["id"], json!("message-0"));

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
        cursor_cap_page["items"][0]["message"]["id"],
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
        cursor_cap_remainder["items"][0]["message"]["id"],
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
    // `search.queryPage` reads the active version, so bootstrap main first.
    call(
        &transport,
        &first_handle,
        &mut id,
        "versions.ensureMain",
        json!({ "workspaceId": "rpc-chat-first" }),
    )
    .await;
    call(
        &transport,
        &first_handle,
        &mut id,
        "search.queryPage",
        json!({ "query": "search seed", "nowMs": 1002 }),
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
        "search.queryPage",
        json!({ "query": "r2indexsentinel", "nowMs": 1004 }),
    )
    .await;
    // Mutation guard: removing the send-message FTS upsert must make this fail;
    // no policy transition occurs between the priming and asserting queries.
    assert!(
        write_time_search["results"]
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
        assert_eq!(sent["id"], json!(format!("message-{sequence:03}")));
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

    // Byte budget, not just row count: a handful of wire-legal 63 KiB
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
    let mismatched_replication_owner = call_error(
        &transport,
        &first_handle,
        &mut id,
        "chats.follows.set",
        json!({
            "ownerUserId": "owner-1",
            "replicationOwnerUserId": "someone-else",
            "targetKind": "thread",
            "targetId": "thread-1",
            "state": "following",
        }),
    )
    .await;
    assert_eq!(mismatched_replication_owner.code, ErrorCode::InvalidParams);
    call(
        &transport,
        &first_handle,
        &mut id,
        "chats.follows.set",
        json!({
            "ownerUserId": "owner-1",
            "replicationOwnerUserId": "owner-1",
            "targetKind": "thread",
            "targetId": "thread-1",
            "state": "following",
            "nowMs": 2101,
        }),
    )
    .await;
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

    let feed = call(
        &transport,
        &first_handle,
        &mut id,
        "chats.feed.listPersonal",
        json!({ "ownerUserId": "owner-1", "limit": 100 }),
    )
    .await;
    assert_eq!(feed["items"].as_array().expect("feed items").len(), 100);
    assert!(feed["nextCursor"].is_string());
    assert!(feed["headCursor"].is_string());
    assert!(feed["readState"].is_null());
    let newest = &feed["items"][0];
    assert!(newest["message"].is_object());
    assert!(newest["thread"].is_object());
    assert!(newest["channel"].is_object());
    assert_eq!(newest["reactions"], json!([]));
    assert_eq!(newest["matchedBy"], json!(["thread"]));
    let head_cursor = feed["headCursor"].clone();
    let mismatched_read_owner = call_error(
        &transport,
        &first_handle,
        &mut id,
        "chats.feed.markSeen",
        json!({
            "ownerUserId": "owner-1",
            "replicationOwnerUserId": "someone-else",
            "headCursor": head_cursor.clone(),
        }),
    )
    .await;
    assert_eq!(mismatched_read_owner.code, ErrorCode::InvalidParams);
    let marked = call(
        &transport,
        &first_handle,
        &mut id,
        "chats.feed.markSeen",
        json!({
            "ownerUserId": "owner-1",
            "replicationOwnerUserId": "owner-1",
            "headCursor": head_cursor,
            "nowMs": 2200,
        }),
    )
    .await;
    assert_eq!(marked["ownerUserId"], json!("owner-1"));
    assert_eq!(
        marked["lastSeenCreatedAtMs"],
        newest["message"]["createdAtMs"]
    );
    assert_eq!(marked["lastSeenMessageId"], newest["message"]["id"]);
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
        json!({ "ownerUserId": "owner-1", "limit": 100 }),
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
        newest["message"]["createdAtMs"]
    );
    assert_eq!(
        feed_after_seen["readState"]["lastSeenMessageId"],
        newest["message"]["id"]
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
        // Ids are bounded (256 UTF-16 units), so the byte pressure comes
        // from large message bodies. Hydrated feed items embed the opening
        // message body, so ~60 KiB bodies trip the 256 KiB page budget after
        // a handful of items.
        let huge_body = format!("feed budget {} {}", sequence, "b".repeat(60 * 1024));
        call(
            &transport,
            &first_handle,
            &mut id,
            "chats.threads.start",
            json!({
                "channelId": "channel-project",
                "threadId": format!("feed-budget-thread-{sequence}"),
                "messageId": format!("feed-budget-message-{sequence}"),
                "authorKind": "human",
                "authorDisplayName": "Feed",
                "body": huge_body,
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
    // Hydrated items embed the huge thread id several times (message.threadId,
    // thread.id, opening message), so the exact per-page count is a function
    // of the serialization shape — assert the structural property instead:
    // the byte budget cuts the page, and cursor pages walk to the full total.
    assert!(
        (1..8).contains(&budget_first_count),
        "large thread ids must cut the feed page by serialized bytes"
    );
    let mut budget_total = budget_first_count;
    let mut budget_cursor = budget_page["nextCursor"].as_str().map(str::to_owned);
    while let Some(cursor) = budget_cursor {
        let page = call(
            &transport,
            &first_handle,
            &mut id,
            "chats.feed.listPersonal",
            json!({
                "ownerUserId": "feed-budget-owner",
                "limit": 100,
                "cursor": cursor,
            }),
        )
        .await;
        let count = page["items"].as_array().expect("budget page").len();
        assert!(count >= 1, "every byte-cut page carries at least one item");
        budget_total += count;
        budget_cursor = page["nextCursor"].as_str().map(str::to_owned);
    }
    assert_eq!(
        budget_total, 8,
        "the byte-cut cursor pages must walk the full feed exactly once"
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

    let archived = call(
        &transport,
        &first_handle,
        &mut id,
        "chats.bookmarks.archive",
        json!({ "ownerUserId": "owner-1", "bookmarkId": &bookmark_id }),
    )
    .await;
    assert_eq!(archived["state"], json!("archived"));
    assert_eq!(archived["generation"], json!(3));
    assert_eq!(archived["projectionState"], json!("pending"));
    let archived_again = call(
        &transport,
        &first_handle,
        &mut id,
        "chats.bookmarks.archive",
        json!({ "ownerUserId": "owner-1", "bookmarkId": &bookmark_id }),
    )
    .await;
    assert_eq!(archived_again["generation"], json!(3));

    let stale_failure = call(
        &transport,
        &first_handle,
        &mut id,
        "chats.bookmarks.markFailed",
        json!({
            "ownerUserId": "owner-1",
            "bookmarkId": &bookmark_id,
            "generation": 2,
            "failureReason": "old worker",
        }),
    )
    .await;
    assert_eq!(stale_failure["applied"], json!(false));
    assert_eq!(
        stale_failure["bookmark"]["projectionState"],
        json!("pending")
    );
    let failed = call(
        &transport,
        &first_handle,
        &mut id,
        "chats.bookmarks.markFailed",
        json!({
            "ownerUserId": "owner-1",
            "bookmarkId": &bookmark_id,
            "generation": 3,
            "failureReason": "  disk unavailable  ",
        }),
    )
    .await;
    assert_eq!(failed["applied"], json!(true));
    assert_eq!(failed["bookmark"]["projectionState"], json!("failed"));
    assert_eq!(
        failed["bookmark"]["failureReason"],
        json!("disk unavailable")
    );
    let retried = call(
        &transport,
        &first_handle,
        &mut id,
        "chats.bookmarks.retryFailed",
        json!({ "ownerUserId": "owner-1", "bookmarkId": &bookmark_id, "generation": 3 }),
    )
    .await;
    assert_eq!(retried["applied"], json!(true));
    assert_eq!(retried["bookmark"]["generation"], json!(3));
    assert_eq!(retried["bookmark"]["projectionState"], json!("pending"));
    assert_eq!(retried["bookmark"]["failureReason"], Value::Null);

    let reactivated = call(
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
            "nowMs": 2305,
        }),
    )
    .await;
    assert_eq!(reactivated["state"], json!("active"));
    assert_eq!(reactivated["generation"], json!(4));
    let stale_stale = call(
        &transport,
        &first_handle,
        &mut id,
        "chats.bookmarks.markStale",
        json!({
            "ownerUserId": "owner-1",
            "bookmarkId": &bookmark_id,
            "generation": 3,
            "failureReason": "old access check",
        }),
    )
    .await;
    assert_eq!(stale_stale["applied"], json!(false));
    assert_eq!(stale_stale["bookmark"]["projectionState"], json!("pending"));
    let stale = call(
        &transport,
        &first_handle,
        &mut id,
        "chats.bookmarks.markStale",
        json!({
            "ownerUserId": "owner-1",
            "bookmarkId": &bookmark_id,
            "generation": 4,
        }),
    )
    .await;
    assert_eq!(stale["applied"], json!(true));
    assert_eq!(stale["bookmark"]["projectionState"], json!("stale"));
    assert_eq!(stale["bookmark"]["failureReason"], Value::Null);
    let invalid_generation = call_error(
        &transport,
        &first_handle,
        &mut id,
        "chats.bookmarks.markFailed",
        json!({
            "ownerUserId": "owner-1",
            "bookmarkId": &bookmark_id,
            "generation": 0,
            "failureReason": "invalid generation",
        }),
    )
    .await;
    assert_eq!(invalid_generation.code, ErrorCode::InvalidParams);

    let enqueued = call(
        &transport,
        &first_handle,
        &mut id,
        "chats.dispatch.enqueue",
        json!({ "agentId": "default", "triggerMessageId": "message-001", "threadId": "thread-1", "nowMs": 2400 }),
    )
    .await;
    assert_eq!(enqueued["enqueued"], json!(true));
    let duplicate = call(
        &transport,
        &first_handle,
        &mut id,
        "chats.dispatch.enqueue",
        json!({ "agentId": "default", "triggerMessageId": "message-001", "threadId": "thread-1", "nowMs": 2400 }),
    )
    .await;
    assert_eq!(duplicate["enqueued"], json!(false));
    let conflicting_thread = call_error(
        &transport,
        &first_handle,
        &mut id,
        "chats.dispatch.enqueue",
        json!({ "agentId": "default", "triggerMessageId": "message-001", "threadId": "thread-big", "nowMs": 2400 }),
    )
    .await;
    assert_eq!(conflicting_thread.code, ErrorCode::Internal);
    for run_id in [String::new(), "bad\0run".to_owned(), "x".repeat(513)] {
        let error = call_error(
            &transport,
            &first_handle,
            &mut id,
            "chats.dispatch.claimNextPending",
            json!({ "agentId": "default", "runId": run_id, "command": "agent", "nowMs": 2401 }),
        )
        .await;
        assert_eq!(error.code, ErrorCode::InvalidParams);
    }
    for invalid_command in [json!("bad\0command"), json!("x".repeat(16_385))] {
        let error = call_error(
            &transport,
            &first_handle,
            &mut id,
            "chats.dispatch.claimNextPending",
            json!({ "agentId": "default", "runId": "run-1", "command": invalid_command, "nowMs": 2401 }),
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
                "agentId": "default",
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
            "agentId": "default",
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
    assert_eq!(claimed["run"]["failureHandled"], json!(false));
    let retried_claim = call(
        &transport,
        &first_handle,
        &mut id,
        "chats.dispatch.claimNextPending",
        json!({
            "agentId": "default",
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
        json!({ "agentId": "default", "runId": "run-other", "nowMs": 2402 }),
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
        json!({ "agentId": "default", "triggerMessageId": "message-002", "threadId": "thread-1", "nowMs": 2410 }),
    )
    .await;
    call(
        &transport,
        &first_handle,
        &mut id,
        "chats.dispatch.claimNextPending",
        json!({ "agentId": "default", "runId": "run-fail", "nowMs": 2411 }),
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
        json!({ "agentId": "default", "triggerMessageId": "message-003", "threadId": "thread-1", "nowMs": 2420 }),
    )
    .await;
    call(
        &transport,
        &first_handle,
        &mut id,
        "chats.dispatch.claimNextPending",
        json!({ "agentId": "default", "runId": "run-crashed", "nowMs": 2421 }),
    )
    .await;
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
        json!({ "agentId": "default", "runId": "run-retry", "nowMs": 2423 }),
    )
    .await;
    assert_eq!(retry["dispatch"]["attemptCount"], json!(2));

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
        json!({ "agentId": "default", "runId": "run-none", "nowMs": 2425 }),
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

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn bookmark_state_filter_claim_command_default_and_path_floor() {
    let scratch = ScratchDir::new().expect("scratch");
    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let handle = open_workspace(&transport, &scratch, 1, "rpc-chat-r11").await;
    let mut id = 10;

    call(
        &transport,
        &handle,
        &mut id,
        "chats.channels.create",
        json!({ "channelId": "channel-r11", "name": "R11", "kind": "channel", "nowMs": 10 }),
    )
    .await;
    for (thread_id, message_id) in [
        ("thread-r11", "message-r11"),
        ("thread-r11b", "message-r11b"),
    ] {
        call(
            &transport,
            &handle,
            &mut id,
            "chats.threads.start",
            json!({
                "channelId": "channel-r11",
                "threadId": thread_id,
                "messageId": message_id,
                "authorKind": "human",
                "authorDisplayName": "Alice",
                "body": "r11",
                "nowMs": 11,
            }),
        )
        .await;
    }

    // `save_bookmark` decodes percent escapes before it checks the
    // destination for traversal. A percent-DISGUISED traversal has no literal
    // ".." bytes, so `crate::store::validate_path`, which reads the path as
    // written, accepts it. Mutation check: use `crate::store::validate_path`
    // in `save_bookmark` — this refusal fails (the save succeeds) and the
    // dotted destination below persists un-normalized.
    let disguised = call_error(
        &transport,
        &handle,
        &mut id,
        "chats.bookmarks.save",
        json!({
            "ownerUserId": "owner-1",
            "targetKind": "thread",
            "targetId": "thread-r11",
            "mode": "live",
            "destinationPath": "%2e%2e/outside.md",
            "nowMs": 12,
        }),
    )
    .await;
    assert_eq!(disguised.code, ErrorCode::InvalidParams);
    // Secret-classified destinations refuse even when structurally valid: a
    // plaintext bookmark projection can never land in secret space, so
    // persisting one would wedge the outbox. Mutation check: accept any
    // `Some(normalized)` classification (drop the Tracked requirement) in
    // `save_bookmark` — both refusals below fail.
    for secret_destination in [".env", "secrets%252eenv"] {
        let refused = call_error(
            &transport,
            &handle,
            &mut id,
            "chats.bookmarks.save",
            json!({
                "ownerUserId": "owner-1",
                "targetKind": "thread",
                "targetId": "thread-r11",
                "mode": "live",
                "destinationPath": secret_destination,
                "nowMs": 12,
            }),
        )
        .await;
        assert_eq!(refused.code, ErrorCode::InvalidParams);
    }
    let bookmark_a = call(
        &transport,
        &handle,
        &mut id,
        "chats.bookmarks.save",
        json!({
            "ownerUserId": "owner-1",
            "targetKind": "thread",
            "targetId": "thread-r11",
            "mode": "live",
            "destinationPath": "notes/./deep//a.md",
            "nowMs": 13,
        }),
    )
    .await;
    assert_eq!(bookmark_a["destinationPath"], json!("notes/deep/a.md"));
    let bookmark_b = call(
        &transport,
        &handle,
        &mut id,
        "chats.bookmarks.save",
        json!({
            "ownerUserId": "owner-1",
            "targetKind": "thread",
            "targetId": "thread-r11b",
            "mode": "live",
            "destinationPath": "bookmarks/b.md",
            "nowMs": 14,
        }),
    )
    .await;
    let bookmark_b_id = bookmark_b["bookmarkId"].as_str().expect("b id").to_owned();
    call(
        &transport,
        &handle,
        &mut id,
        "chats.bookmarks.archive",
        json!({ "ownerUserId": "owner-1", "bookmarkId": &bookmark_b_id }),
    )
    .await;

    // The documented optional `state` filter. Mutation check: parse the list
    // params as `ChatOwnerParams` again (deny_unknown_fields) — every
    // filtered call below refuses unknown-field and the test fails.
    let all = call(
        &transport,
        &handle,
        &mut id,
        "chats.bookmarks.list",
        json!({ "ownerUserId": "owner-1" }),
    )
    .await;
    assert_eq!(all["bookmarks"].as_array().expect("all").len(), 2);
    let active = call(
        &transport,
        &handle,
        &mut id,
        "chats.bookmarks.list",
        json!({ "ownerUserId": "owner-1", "state": "active" }),
    )
    .await;
    let active_rows = active["bookmarks"].as_array().expect("active");
    assert_eq!(active_rows.len(), 1);
    assert_eq!(active_rows[0]["bookmarkId"], bookmark_a["bookmarkId"]);
    let archived = call(
        &transport,
        &handle,
        &mut id,
        "chats.bookmarks.list",
        json!({ "ownerUserId": "owner-1", "state": "archived" }),
    )
    .await;
    let archived_rows = archived["bookmarks"].as_array().expect("archived");
    assert_eq!(archived_rows.len(), 1);
    assert_eq!(archived_rows[0]["bookmarkId"], json!(&bookmark_b_id));
    let bogus = call_error(
        &transport,
        &handle,
        &mut id,
        "chats.bookmarks.list",
        json!({ "ownerUserId": "owner-1", "state": "bogus" }),
    )
    .await;
    assert_eq!(bogus.code, ErrorCode::InvalidParams);

    // Mutation check: restore
    // `unwrap_or_else(|| "agent".to_owned())` in the claim arm — the empty
    // command assertion fails.
    call(
        &transport,
        &handle,
        &mut id,
        "chats.dispatch.enqueue",
        json!({ "agentId": "default", "triggerMessageId": "message-r11", "threadId": "thread-r11", "nowMs": 20 }),
    )
    .await;
    let omitted_command_default = "";
    let claimed = call(
        &transport,
        &handle,
        &mut id,
        "chats.dispatch.claimNextPending",
        json!({ "agentId": "default", "runId": "run-r11", "nowMs": 21 }),
    )
    .await;
    assert_eq!(claimed["run"]["command"], json!(omitted_command_default));
    call(
        &transport,
        &handle,
        &mut id,
        "chats.dispatch.complete",
        json!({ "runId": "run-r11", "exitCode": 0, "nowMs": 22 }),
    )
    .await;
    call(
        &transport,
        &handle,
        &mut id,
        "chats.dispatch.enqueue",
        json!({ "agentId": "default", "triggerMessageId": "message-r11b", "threadId": "thread-r11b", "nowMs": 23 }),
    )
    .await;
    let whitespace_command = "   ";
    let whitespace = call(
        &transport,
        &handle,
        &mut id,
        "chats.dispatch.claimNextPending",
        json!({ "agentId": "default", "runId": "run-r11b", "command": whitespace_command, "nowMs": 24 }),
    )
    .await;
    assert_eq!(whitespace["run"]["command"], json!(whitespace_command));

    call(&transport, &handle, &mut id, "workspace.close", json!({})).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn unknown_fields_and_null_optionals_are_rejected() {
    let scratch = ScratchDir::new().expect("scratch");
    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let handle = open_workspace(&transport, &scratch, 1, "rpc-b2-strict").await;
    let mut id = 10;
    let unknown = call_error(
        &transport,
        &handle,
        &mut id,
        "chats.dispatch.listPending",
        json!({ "surprise": true }),
    )
    .await;
    let null_optional = call_error(
        &transport,
        &handle,
        &mut id,
        "chats.dispatch.setThreadPaused",
        json!({ "threadId": "thread", "paused": true, "reason": null }),
    )
    .await;
    assert_eq!(
        (unknown.code, null_optional.code),
        (ErrorCode::InvalidParams, ErrorCode::InvalidParams),
        "remove deny_unknown/non-null optional decoders -> malformed calls enter domain.",
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn workspace_handle_overrides_a_spoofed_workspace_identity() {
    let scratch = ScratchDir::new().expect("scratch");
    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let handle = open_workspace(&transport, &scratch, 1, "rpc-b2-scope").await;
    let mut id = 10;
    let spoofed = call_error(
        &transport,
        &handle,
        &mut id,
        "chats.dispatch.listPending",
        json!({ "workspaceId": "foreign" }),
    )
    .await;
    assert_eq!(
        spoofed.code,
        ErrorCode::InvalidParams,
        "trust a params workspace id -> caller can select foreign rows."
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_agent_you_run_pages_its_persons_requests_under_its_own_reader() {
    let scratch = ScratchDir::new().expect("scratch");
    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let handle = open_workspace(&transport, &scratch, 1, "rpc-connected-reader").await;
    let mut id = 10;
    call(
        &transport,
        &handle,
        &mut id,
        "chats.channels.ensureAgent",
        json!({
            "channelId": "terminal-chat",
            "agentId": "terminal",
            "name": "Terminal",
            "nowMs": 2,
        }),
    )
    .await;
    call(
        &transport,
        &handle,
        &mut id,
        "chats.threads.start",
        json!({
            "channelId": "terminal-chat", "threadId": "dm", "messageId": "first",
            "authorKind": "human", "authorDisplayName": "Ada", "authorUserId": "ada",
            "body": "first", "nowMs": 10,
        }),
    )
    .await;
    for (message, user, at) in [
        ("second", "ada", 20),
        ("third", "ada", 30),
        ("bobs", "bob", 40),
    ] {
        call(
            &transport,
            &handle,
            &mut id,
            "chats.messages.send",
            json!({
                "threadId": "dm", "messageId": message, "authorKind": "human",
                "authorDisplayName": "Ada", "authorUserId": user, "body": message,
                "nowMs": at,
            }),
        )
        .await;
    }
    let reader = json!({
        "kind": "connected",
        "agentId": "terminal",
        "handle": "terminal",
        "requesters": ["ada"],
        "unattributedCounts": false,
    });
    let page = call(
        &transport,
        &handle,
        &mut id,
        "chats.agentReadState.listRequestsPage",
        json!({ "reader": reader, "pageLimit": 1 }),
    )
    .await;
    assert_eq!(
        page,
        json!({
            "requests": [{
                "threadId": "dm",
                "messageId": "first",
                "channel": {
                    "id": "terminal-chat",
                    "kind": "agent",
                    "name": "Terminal",
                    "slug": "my-agent-terminal",
                    "purpose": "",
                },
                "author": { "kind": "human", "displayName": "Ada" },
                "body": "first",
                "createdAtMs": 10,
            }],
            "more": true,
        })
    );
    let rest = call(
        &transport,
        &handle,
        &mut id,
        "chats.agentReadState.listRequestsPage",
        json!({
            "reader": reader,
            "threadId": "dm",
            "after": { "createdAtMs": 10, "messageId": "first" },
        }),
    )
    .await;
    assert_eq!(rest["more"], json!(false));
    assert_eq!(
        rest["requests"]
            .as_array()
            .expect("requests")
            .iter()
            .map(|request| request["messageId"].clone())
            .collect::<Vec<_>>(),
        [json!("second"), json!("third")],
        "another person's post does not ask the agent you run."
    );
    let unnamed = call(
        &transport,
        &handle,
        &mut id,
        "chats.agentReadState.listUnreadRequests",
        json!({ "reader": { "kind": "unnamed" } }),
    )
    .await;
    assert_eq!(unnamed["requests"], json!([]));

    let first = call(
        &transport,
        &handle,
        &mut id,
        "chats.agentReadState.listUnreadRequests",
        json!({ "reader": reader, "pageLimit": 1 }),
    )
    .await;
    let cursor = first["nextCursor"].clone();
    assert!(cursor.is_string());
    let mut someone_else = reader.clone();
    someone_else["requesters"] = json!(["bob"]);
    let refused = call_error(
        &transport,
        &handle,
        &mut id,
        "chats.agentReadState.listUnreadRequests",
        json!({ "reader": someone_else, "pageLimit": 1, "cursor": cursor }),
    )
    .await;
    assert_eq!(
        (refused.code, refused.message.as_str()),
        (ErrorCode::InvalidParams, "invalid-cursor"),
        "a cursor from one reader is refused for another."
    );
    let unknown_field = call_error(
        &transport,
        &handle,
        &mut id,
        "chats.agentReadState.listRequestsPage",
        json!({ "reader": { "kind": "unnamed", "agentId": "terminal" } }),
    )
    .await;
    assert_eq!(unknown_field.code, ErrorCode::InvalidParams);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn small_chat_arms_round_trip_strict_shapes_and_recovery_mutations() {
    let scratch = ScratchDir::new().expect("scratch");
    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let handle = open_workspace(&transport, &scratch, 1, "rpc-b2-roundtrip").await;
    let mut id = 10;
    call(
        &transport,
        &handle,
        &mut id,
        "chats.channels.create",
        json!({ "channelId": "channel", "name": "Channel", "kind": "channel", "nowMs": 2 }),
    )
    .await;
    call(
        &transport,
        &handle,
        &mut id,
        "chats.threads.start",
        json!({
            "channelId": "channel", "threadId": "thread", "messageId": "message",
            "authorKind": "human", "authorDisplayName": "Ada", "body": "hello", "nowMs": 10,
        }),
    )
    .await;
    let db_path = engine_db_path(&scratch).expect("db");
    let conn = rusqlite::Connection::open(db_path).expect("open db");
    conn.execute(
        "INSERT INTO chat_threads \
         (workspace_id,thread_id,title,created_at_ms,updated_at_ms,linked_object_id,linked_path_hint,linked_at_ms) \
         VALUES ('rpc-b2-roundtrip','file-thread','File',12,12,'object','notes/file.md',12)",
        [],
    )
    .expect("file thread");
    drop(conn);
    let file_threads = call(
        &transport,
        &handle,
        &mut id,
        "chats.threads.listForFile",
        json!({ "objectId": "object" }),
    )
    .await;
    assert_eq!(
        file_threads["threads"][0]["linkedFile"]["pathHint"],
        json!("notes/file.md")
    );
    let channel = call(
        &transport,
        &handle,
        &mut id,
        "chats.threads.findChannelId",
        json!({ "threadId": "thread" }),
    )
    .await;
    assert_eq!(channel, json!("channel"));

    let unread = call(
        &transport,
        &handle,
        &mut id,
        "chats.agentReadState.listUnreadThreads",
        json!({ "reader": { "kind": "unnamed" } }),
    )
    .await;
    assert_eq!(unread["threads"][0]["id"], json!("thread"));
    assert_eq!(
        unread["threads"][0]["lastRead"],
        json!({ "createdAtMs": 0, "messageId": "" })
    );
    let read = call(
        &transport,
        &handle,
        &mut id,
        "chats.agentReadState.markThreadRead",
        json!({
            "reader": { "kind": "unnamed" },
            "threadId": "thread",
            "upTo": { "createdAtMs": 999, "messageId": "z" },
        }),
    )
    .await;
    assert_eq!(
        (
            read["lastReadCreatedAtMs"].as_i64(),
            read["lastReadMessageId"].as_str()
        ),
        (Some(10), Some("message"))
    );
    let up_to = json!({ "createdAtMs": 999, "messageId": "z" });
    let named_agent = call_error(
        &transport,
        &handle,
        &mut id,
        "chats.agentReadState.markThreadRead",
        json!({
            "reader": { "kind": "run", "runId": "run", "agentId": "codex" },
            "threadId": "thread",
            "upTo": up_to,
        }),
    )
    .await;
    let unknown_run = call_error(
        &transport,
        &handle,
        &mut id,
        "chats.agentReadState.markThreadRead",
        json!({
            "reader": { "kind": "run", "runId": "no-such-run" },
            "threadId": "thread",
            "upTo": up_to,
        }),
    )
    .await;
    let no_reader = call_error(
        &transport,
        &handle,
        &mut id,
        "chats.agentReadState.markThreadRead",
        json!({ "threadId": "thread", "upTo": up_to }),
    )
    .await;
    assert_eq!(
        (
            named_agent.code,
            unknown_run.code,
            unknown_run.message.as_str(),
            no_reader.code
        ),
        (
            ErrorCode::InvalidParams,
            ErrorCode::InvalidParams,
            "run-not-found",
            ErrorCode::InvalidParams
        )
    );

    call(
        &transport,
        &handle,
        &mut id,
        "chats.follows.ensureDefaults",
        json!({ "ownerUserId": "owner" }),
    )
    .await;
    let bookmark = call(
        &transport,
        &handle,
        &mut id,
        "chats.bookmarks.save",
        json!({
            "ownerUserId": "owner", "targetKind": "thread", "targetId": "thread",
            "mode": "live", "destinationPath": "bookmarks/thread.md", "nowMs": 11,
        }),
    )
    .await;
    let bookmark_id = bookmark["bookmarkId"]
        .as_str()
        .expect("bookmark id")
        .to_owned();
    let pending_once = call_with_idempotency(
        &transport,
        &handle,
        &mut id,
        "chats.bookmarks.markPending",
        "bookmark-pending-request",
        json!({ "ownerUserId": "owner", "bookmarkId": bookmark_id }),
    )
    .await;
    let pending_replay = call_with_idempotency(
        &transport,
        &handle,
        &mut id,
        "chats.bookmarks.markPending",
        "bookmark-pending-request",
        json!({ "ownerUserId": "owner", "bookmarkId": bookmark["bookmarkId"] }),
    )
    .await;
    assert_eq!(pending_once["generation"], pending_replay["generation"]);

    call(
        &transport,
        &handle,
        &mut id,
        "chats.dispatch.enqueue",
        json!({ "agentId": "default", "triggerMessageId": "trigger", "threadId": "thread", "nowMs": 20 }),
    )
    .await;
    let paused = call(
        &transport,
        &handle,
        &mut id,
        "chats.dispatch.setThreadPaused",
        json!({ "threadId": "thread", "paused": true, "reason": "manual" }),
    )
    .await;
    assert_eq!(paused["reason"], json!("manual"));
    assert_eq!(
        call(
            &transport,
            &handle,
            &mut id,
            "chats.dispatch.isThreadPaused",
            json!({ "threadId": "thread" })
        )
        .await,
        json!(true)
    );
    let pause_state = call(
        &transport,
        &handle,
        &mut id,
        "chats.dispatch.getThreadPauseState",
        json!({ "threadId": "thread" }),
    )
    .await;
    assert_eq!(pause_state["reason"], json!("manual"));
    let no_claim = call(
        &transport,
        &handle,
        &mut id,
        "chats.dispatch.claimNextPending",
        json!({ "agentId": "default", "runId": "run", "command": "agent" }),
    )
    .await;
    assert_eq!(no_claim, Value::Null);
    call(
        &transport,
        &handle,
        &mut id,
        "chats.dispatch.setThreadPaused",
        json!({ "threadId": "thread", "paused": false, "reason": "ignored" }),
    )
    .await;
    let claim = call(
        &transport,
        &handle,
        &mut id,
        "chats.dispatch.claimNextPending",
        json!({ "agentId": "default", "runId": "run", "command": "agent" }),
    )
    .await;
    assert_eq!(claim["run"]["runId"], json!("run"));
    assert!(claim["run"].get("endedAtMs").is_none());
    let latest = call(
        &transport,
        &handle,
        &mut id,
        "chats.dispatch.latestRunForThread",
        json!({ "threadId": "thread" }),
    )
    .await;
    assert_eq!(latest, claim["run"]);
    let agents_latest = call(
        &transport,
        &handle,
        &mut id,
        "chats.dispatch.latestRunForThread",
        json!({ "threadId": "thread", "agentId": "default" }),
    )
    .await;
    assert_eq!(agents_latest, claim["run"]);
    let other_agents_latest = call(
        &transport,
        &handle,
        &mut id,
        "chats.dispatch.latestRunForThread",
        json!({ "threadId": "thread", "agentId": "nova" }),
    )
    .await;
    assert_eq!(other_agents_latest, Value::Null);
    let open = call(
        &transport,
        &handle,
        &mut id,
        "chats.dispatch.openRuns",
        json!({}),
    )
    .await;
    assert_eq!(open["claims"][0]["run"]["runId"], json!("run"));
    assert_eq!(
        call(
            &transport,
            &handle,
            &mut id,
            "chats.dispatch.recordRunMessage",
            json!({ "messageId": "agent-message", "runId": "run" })
        )
        .await,
        json!(true)
    );
    assert_eq!(
        call(
            &transport,
            &handle,
            &mut id,
            "chats.dispatch.runIdForMessage",
            json!({ "messageId": "agent-message" })
        )
        .await,
        json!("run")
    );
    let messages = call(
        &transport,
        &handle,
        &mut id,
        "chats.dispatch.listRunMessages",
        json!({ "runId": "run" }),
    )
    .await;
    assert_eq!(messages["messageIds"], json!(["agent-message"]));
    let run = call(
        &transport,
        &handle,
        &mut id,
        "chats.dispatch.getRunRecord",
        json!({ "runId": "run" }),
    )
    .await;
    assert_eq!(run["runId"], json!("run"));
    let runs = call(
        &transport,
        &handle,
        &mut id,
        "chats.dispatch.runRecordsForThread",
        json!({ "threadId": "thread", "limit": 200 }),
    )
    .await;
    assert_eq!(runs["runs"]["agent-message"]["runId"], json!("run"));
    let count = call(
        &transport,
        &handle,
        &mut id,
        "chats.dispatch.recentCount",
        json!({ "threadId": "thread", "sinceMs": -1.5 }),
    )
    .await;
    assert_eq!(count, json!(1));
    call(
        &transport,
        &handle,
        &mut id,
        "chats.dispatch.fail",
        json!({ "runId": "run", "reason": "app-quit", "exitCode": 143, "nowMs": 30 }),
    )
    .await;
    let recoveries = call(
        &transport,
        &handle,
        &mut id,
        "chats.dispatch.listFailedRunRecoveries",
        json!({}),
    )
    .await;
    assert_eq!(recoveries["recoveries"][0]["attemptCount"], json!(1));
    let thread_recoveries = call(
        &transport,
        &handle,
        &mut id,
        "chats.dispatch.listFailedRunRecoveries",
        json!({ "threadId": "thread" }),
    )
    .await;
    assert_eq!(thread_recoveries["recoveries"], recoveries["recoveries"]);
    let other_thread_recoveries = call(
        &transport,
        &handle,
        &mut id,
        "chats.dispatch.listFailedRunRecoveries",
        json!({ "threadId": "other-thread" }),
    )
    .await;
    assert_eq!(other_thread_recoveries["recoveries"], json!([]));
    let handled = call(
        &transport,
        &handle,
        &mut id,
        "chats.dispatch.markFailureHandled",
        json!({ "runId": "run" }),
    )
    .await;
    assert_eq!(handled["failureHandled"], json!(true));
    let requeued = call(
        &transport,
        &handle,
        &mut id,
        "chats.dispatch.requeueFailedTrigger",
        json!({ "triggerMessageId": "trigger", "runId": "run" }),
    )
    .await;
    let failed_pending = call(
        &transport,
        &handle,
        &mut id,
        "chats.dispatch.failPendingForThread",
        json!({ "threadId": "thread", "agentId": "default", "reason": "stop" }),
    )
    .await;
    assert_eq!(
        (requeued, failed_pending),
        (json!(true), json!(1)),
        "omit any Phase 2/3 registration or return legacy nullable fields -> roundtrip differs/fails."
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn thread_projection_read_only_notice_and_access_line_presence() {
    let scratch = ScratchDir::new().expect("scratch");
    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let handle = open_workspace(&transport, &scratch, 1, "rpc-b2-projection-access").await;
    let mut id = 10;
    call_with_idempotency(
        &transport,
        &handle,
        &mut id,
        "chats.threads.create",
        "projection-access-thread",
        json!({
            "threadId": "thread-access",
            "title": "Access",
            "linkedFile": {
                "objectId": "object-access",
                "pathHint": "secret/stored-only.md"
            },
            "nowMs": 10
        }),
    )
    .await;
    for kind in ["denied", "unknown"] {
        let projection = call(
            &transport,
            &handle,
            &mut id,
            "chats.threads.getProjection",
            json!({
                "threadId": "thread-access",
                "linkedFileAccess": { "kind": kind }
            }),
        )
        .await;
        let text = projection["text"].as_str().expect("projection text");
        assert!(text.contains("\nRead-only chat projection.\n"));
        assert!(text.contains("\nLinked file: unavailable\n"));
        assert!(!text.contains("secret/stored-only.md"));
    }
    let null_access = call_error(
        &transport,
        &handle,
        &mut id,
        "chats.threads.getProjection",
        json!({
            "threadId": "thread-access",
            "linkedFileAccess": null
        }),
    )
    .await;
    assert_eq!(null_access.code, ErrorCode::InvalidParams);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn polls_and_lanes_cross_the_rpc_boundary() {
    let scratch = ScratchDir::new().expect("scratch");
    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let handle = open_workspace(&transport, &scratch, 1, "rpc-polls-lanes").await;
    let mut id = 10;
    call(
        &transport,
        &handle,
        &mut id,
        "chats.channels.create",
        json!({
            "channelId": "channel",
            "name": "Launch",
            "kind": "channel",
            "type": "both",
            "nowMs": 10,
        }),
    )
    .await;
    call(
        &transport,
        &handle,
        &mut id,
        "chats.threads.start",
        json!({
            "channelId": "channel",
            "threadId": "poll-thread",
            "messageId": "poll",
            "authorKind": "agent",
            "authorDisplayName": "Nova",
            "body": "Which day do we ship?",
            "needsDecision": true,
            "options": ["Friday", "Monday"],
            "nowMs": 20,
        }),
    )
    .await;
    let listed = call(
        &transport,
        &handle,
        &mut id,
        "chats.decisions.listForThread",
        json!({ "threadId": "poll-thread" }),
    )
    .await;
    assert_eq!(
        listed["decisions"][0]["options"],
        json!(["Friday", "Monday"]),
        "dropping options from the decision DTO -> a poll lists as a bare question."
    );
    assert!(listed["decisions"][0].get("chosenOption").is_none());

    let wrong = call_error_with_idempotency(
        &transport,
        &handle,
        &mut id,
        "chats.decisions.resolve",
        "resolve-wrong",
        json!({
            "threadId": "poll-thread",
            "messageId": "poll",
            "resolvedByMessageId": "poll",
            "chosenOption": "Sunday",
            "nowMs": 30,
        }),
    )
    .await;
    assert_eq!(wrong.message, "invalid-poll-choice");

    let repeated_choice = call_error_with_idempotency(
        &transport,
        &handle,
        &mut id,
        "chats.messages.send",
        "send-repeated-choice",
        json!({
            "threadId": "poll-thread",
            "messageId": "repeated-choice",
            "authorKind": "human",
            "authorDisplayName": "Ada",
            "body": "Which day?",
            "options": ["Friday", " Friday "],
            "nowMs": 30,
        }),
    )
    .await;
    assert_eq!(repeated_choice.code, ErrorCode::InvalidParams);
    assert_eq!(repeated_choice.message, "Each choice appears once.");

    call_with_idempotency(
        &transport,
        &handle,
        &mut id,
        "chats.decisions.resolve",
        "resolve-good",
        json!({
            "threadId": "poll-thread",
            "messageId": "poll",
            "resolvedByMessageId": "poll",
            "chosenOption": "Monday",
            "nowMs": 31,
        }),
    )
    .await;
    let resolved = call(
        &transport,
        &handle,
        &mut id,
        "chats.decisions.listForThread",
        json!({ "threadId": "poll-thread" }),
    )
    .await;
    assert_eq!(resolved["decisions"][0]["state"], json!("resolved"));
    assert_eq!(
        resolved["decisions"][0]["chosenOption"],
        json!("Monday"),
        "dropping chosenOption from the decision DTO -> the answer never reaches a reader."
    );

    call(
        &transport,
        &handle,
        &mut id,
        "chats.threads.start",
        json!({
            "channelId": "channel",
            "threadId": "lane-thread",
            "messageId": "lane-opening",
            "authorKind": "human",
            "authorDisplayName": "Ada",
            "body": "quick word",
            "lane": "chat",
            "nowMs": 40,
        }),
    )
    .await;
    let posts = call(
        &transport,
        &handle,
        &mut id,
        "chats.threads.listForChannel",
        json!({ "channelId": "channel" }),
    )
    .await;
    let posts_ids: Vec<&Value> = posts["threads"]
        .as_array()
        .expect("threads")
        .iter()
        .map(|summary| &summary["thread"]["id"])
        .collect();
    assert_eq!(
        posts_ids,
        vec![&json!("poll-thread")],
        "listing without a lane must read the posts lane only."
    );
    let chat = call(
        &transport,
        &handle,
        &mut id,
        "chats.threads.listForChannel",
        json!({ "channelId": "channel", "lane": "chat" }),
    )
    .await;
    assert_eq!(chat["threads"][0]["thread"]["id"], json!("lane-thread"));
    assert_eq!(chat["threads"][0]["thread"]["lane"], json!("chat"));
    assert_eq!(chat["threads"].as_array().expect("threads").len(), 1);

    let unknown = call_error(
        &transport,
        &handle,
        &mut id,
        "chats.threads.listForChannel",
        json!({ "channelId": "channel", "lane": "feed" }),
    )
    .await;
    assert_eq!(unknown.message, "unknown chat thread lane");

    call(
        &transport,
        &handle,
        &mut id,
        "chats.threads.start",
        json!({
            "channelId": "channel",
            "threadId": "second-post",
            "messageId": "second-opening",
            "authorKind": "human",
            "authorDisplayName": "Ada",
            "body": "Second post",
            "nowMs": 50,
        }),
    )
    .await;
    let first_page = call(
        &transport,
        &handle,
        &mut id,
        "chats.threads.listForChannel",
        json!({ "channelId": "channel", "pageLimit": 1 }),
    )
    .await;
    let posts_cursor = first_page["nextCursor"]
        .as_str()
        .expect("posts cursor")
        .to_owned();
    let crossed = call_error(
        &transport,
        &handle,
        &mut id,
        "chats.threads.listForChannel",
        json!({ "channelId": "channel", "lane": "chat", "cursor": posts_cursor }),
    )
    .await;
    assert!(
        crossed.message.contains("cursor"),
        "a posts-lane cursor opened the chat lane: {}",
        crossed.message
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn local_chat_actor_key_survives_restart_and_never_enters_replication() {
    let scratch = ScratchDir::new().expect("scratch");
    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let handle = open_workspace(&transport, &scratch, 1, "actor-key").await;
    let mut id = 1;
    let installation_key = r#"{"kind":"installation","installationId":"device-a"}"#;
    let account_key = r#"{"kind":"account","issuer":"https://accounts.test","userId":"alice"}"#;
    call(
        &transport,
        &handle,
        &mut id,
        "chats.channels.create",
        json!({
            "channelId": "channel", "name": "General", "kind": "channel", "nowMs": 10,
        }),
    )
    .await;
    let opening = call(
        &transport,
        &handle,
        &mut id,
        "chats.threads.start",
        json!({
            "channelId": "channel", "threadId": "thread", "messageId": "opening",
            "authorKind": "human", "authorDisplayName": "Alice", "authorActorKey": installation_key,
            "body": "Offline", "nowMs": 20,
        }),
    )
    .await;
    assert_eq!(opening["message"]["authorActorKey"], installation_key);
    let signed_in = call(
        &transport,
        &handle,
        &mut id,
        "chats.messages.send",
        json!({
            "threadId": "thread", "messageId": "signed-in", "authorKind": "human",
            "authorDisplayName": "Alice", "authorUserId": "alice", "authorActorKey": account_key,
            "body": "Online", "nowMs": 21,
        }),
    )
    .await;
    assert_eq!(signed_in["authorActorKey"], account_key);
    call(&transport, &handle, &mut id, "workspace.close", json!({})).await;

    let db = engine_db_path(&scratch).expect("db");
    let mut store = EngineStore::open(&db, 30).expect("reopen own store");
    let payloads: Vec<String> = store
        .read_with(|conn| {
            let mut query = conn.prepare(
                "SELECT payload_json FROM replication_log WHERE workspace_id='actor-key'",
            )?;
            query.query_map([], |row| row.get(0))?.collect()
        })
        .expect("payloads");
    assert!(!payloads.is_empty());
    for payload in payloads {
        let value: Value = serde_json::from_str(&payload).expect("JSON payload");
        assert!(value.get("authorActorKey").is_none());
        assert!(value.get("author_actor_key").is_none());
        assert!(!payload.contains("device-a"));
        assert!(!payload.contains("https://accounts.test"));
    }
    for (seq, message_id, forged) in [(0, "received-keyless", false), (1, "received-forged", true)]
    {
        let mut payload = json!({
            "threadId": "thread", "messageId": message_id, "authorKind": "agent",
            "authorDisplayName": "Peer claim", "authorUserId": "peer", "body": "Received", "createdAtMs": 40 + seq,
        });
        if forged {
            payload["authorActorKey"] = json!(installation_key);
        }
        apply_chat_envelope(
            &mut store,
            &ReplicationEnvelope {
                workspace_id: "actor-key".to_owned(),
                origin_id: "peer-device".to_owned(),
                origin_seq: seq,
                relay_seq: Some(seq),
                admitted_author_snapshot: None,
                settlement_admission: None,
                op_kind: "chat.message.append".to_owned(),
                payload,
                recorded_at_ms: 40 + seq,
            },
            &NoFaults,
        )
        .expect("ingest");
    }
    assert!(
        store
            .read_with(|conn| {
                conn.execute(
                    "UPDATE chat_messages SET author_actor_key='broken' WHERE message_id='opening'",
                    [],
                )
            })
            .is_err(),
        "local chat actor keys must contain valid JSON"
    );
    let received_keys: Vec<Option<String>> = store
        .read_with(|conn| {
            let mut query = conn.prepare(
                "SELECT author_actor_key FROM chat_messages WHERE message_id LIKE 'received-%'",
            )?;
            query.query_map([], |row| row.get(0))?.collect()
        })
        .expect("received keys");
    assert_eq!(received_keys, vec![None, None]);
    drop(store);

    let reopened = open_workspace(&transport, &scratch, 100, "actor-key").await;
    let listed = call(
        &transport,
        &reopened,
        &mut id,
        "chats.messages.list",
        json!({ "threadId": "thread" }),
    )
    .await;
    let rows = listed["messages"].as_array().expect("messages");
    assert_eq!(
        rows.iter().find(|row| row["id"] == "opening").unwrap()["authorActorKey"],
        installation_key
    );
    assert_eq!(
        rows.iter().find(|row| row["id"] == "signed-in").unwrap()["authorActorKey"],
        account_key
    );
    for row in rows
        .iter()
        .filter(|row| row["id"].as_str().unwrap().starts_with("received-"))
    {
        assert!(row.get("authorActorKey").is_none());
    }
    call(&transport, &reopened, &mut id, "workspace.close", json!({})).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn passive_store_pulls_chat_rows_but_refuses_local_actor_key_admission() {
    use dohc_engine_domain::{
        ChatActorKind, ChatThreadLane, LinkedChatStore, SendMessage, StartChannelThread,
    };
    let source = ScratchDir::new().expect("source");
    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let handle = open_workspace(&transport, &source, 1, "actor-key-passive").await;
    let mut id = 1;
    call(
        &transport,
        &handle,
        &mut id,
        "chats.channels.create",
        json!({
            "channelId":"channel", "name":"General", "kind":"channel", "nowMs":10
        }),
    )
    .await;
    let key = r#"{"kind":"installation","installationId":"owner-device"}"#;
    call(
        &transport,
        &handle,
        &mut id,
        "chats.threads.start",
        json!({
            "channelId":"channel", "threadId":"pulled-thread", "messageId":"pulled-message",
            "authorKind":"human", "authorDisplayName":"Alice", "authorUserId":"alice", "authorActorKey":key,
            "body":"Pulled", "nowMs":20
        }),
    )
    .await;
    call(&transport, &handle, &mut id, "workspace.close", json!({})).await;
    let owner = EngineStore::open(&engine_db_path(&source).unwrap(), 30).unwrap();
    let envelopes: Vec<ReplicationEnvelope> = owner.read_with(|conn| {
        let mut query = conn.prepare("SELECT origin_id, origin_seq, op_kind, payload_json, recorded_at_ms FROM replication_log WHERE op_kind LIKE 'chat.%' ORDER BY origin_seq")?;
        query.query_map([], |row| {
            let payload: String = row.get(3)?;
            Ok(ReplicationEnvelope {
                workspace_id:"actor-key-passive".into(), origin_id:row.get(0)?, origin_seq:row.get(1)?,
                relay_seq:None, admitted_author_snapshot:None, settlement_admission:None, op_kind:row.get(2)?, payload:serde_json::from_str(&payload).unwrap(), recorded_at_ms:row.get(4)?
            })
        })?.collect()
    }).unwrap();
    assert!(!envelopes.is_empty());
    let replica = ScratchDir::new().expect("replica");
    let replica_db = engine_db_path(&replica).unwrap();
    let mut passive = EngineStore::open_passive(&replica_db, 1, None, None).unwrap();
    for mut envelope in envelopes {
        envelope.payload["authorActorKey"] = json!(key);
        apply_chat_envelope(&mut passive, &envelope, &NoFaults).expect("pulled row");
    }
    let mut start = StartChannelThread {
        workspace_id: "actor-key-passive".into(),
        channel_id: "channel".into(),
        thread_id: "local-thread".into(),
        message_id: "local-opening".into(),
        title: None,
        lane: ChatThreadLane::Posts,
        own_thread: false,
        author_kind: ChatActorKind::Human,
        author_display_name: "Alice".into(),
        author_owner_display_name: None,
        author_user_id: None,
        origin: None,
        body: "Local".into(),
        needs_decision: false,
        options: vec![],
        attachments: vec![],
        automation: None,
        author_agent_id: None,
        author_reported: None,
        work: None,
        wake_agent_ids: Vec::new(),
        now_ms: 40,
        request_id: Some("passive-start".into()),
    };
    let mut reply = SendMessage {
        workspace_id: "actor-key-passive".into(),
        thread_id: "pulled-thread".into(),
        message_id: "local-reply".into(),
        author_kind: ChatActorKind::Human,
        author_display_name: "Alice".into(),
        author_owner_display_name: None,
        author_user_id: None,
        parent_message_id: None,
        origin: None,
        body: "Local reply".into(),
        needs_decision: false,
        options: vec![],
        attachments: vec![],
        automation: None,
        author_agent_id: None,
        author_reported: None,
        work: None,
        wake_agent_ids: Vec::new(),
        now_ms: 41,
        request_id: Some("passive-send".into()),
    };
    let mut chats = LinkedChatStore::new(&mut passive);
    for author_user_id in [None, Some("alice".to_owned())] {
        start.author_user_id = author_user_id.clone();
        reply.author_user_id = author_user_id;
        for author_actor_key in [None, Some(key)] {
            let start_error = chats
                .start_admitted_channel_thread(&start, author_actor_key, &NoFaults)
                .unwrap_err();
            assert!(
                start_error
                    .to_string()
                    .contains("passive store cannot originate"),
                "{start_error:?}"
            );
            let send_error = chats
                .send_admitted_message(&reply, author_actor_key, &NoFaults)
                .unwrap_err();
            assert!(
                send_error
                    .to_string()
                    .contains("passive store cannot originate"),
                "{send_error:?}"
            );
        }
    }
    drop(passive);
    let passive = EngineStore::open_passive(&replica_db, 50, None, None).unwrap();
    passive.read_with(|conn| {
        let counts: (i64,i64,i64,i64,i64) = conn.query_row("SELECT (SELECT count(*) FROM chat_messages), (SELECT count(*) FROM chat_threads), (SELECT count(*) FROM chat_messages WHERE author_actor_key IS NOT NULL), (SELECT count(*) FROM replication_log WHERE imported=0), (SELECT count(*) FROM engine_requests WHERE request_id IN ('passive-start','passive-send'))", [], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?)))?;
        assert_eq!(counts, (1,1,0,0,0));
        Ok::<_,rusqlite::Error>(())
    }).unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn conversation_links_rpc_seeds_on_demand_and_pages_with_restart_errors() {
    let scratch = ScratchDir::new().unwrap();
    write_root_binding(scratch.path(), TOKEN).unwrap();
    let mut store = EngineStore::open(&engine_db_path(&scratch).unwrap(), 1).unwrap();
    store.bind_root_token(TOKEN, &NoFaults).unwrap();
    dohc_engine_domain::VersionedTextStore::new(&mut store)
        .ensure_main_version("conversation-links-rpc", "main", 1, &NoFaults)
        .unwrap();
    store.write_with(&NoFaults,|c| {
        c.execute_batch("INSERT INTO chat_channels(workspace_id,channel_id,name,slug,kind,created_at_ms,updated_at_ms) VALUES('conversation-links-rpc','c','C','c','channel',1,1);
        INSERT INTO chat_channel_wire_ids VALUES('conversation-links-rpc','wire','c');
        INSERT INTO chat_threads(workspace_id,thread_id,title,created_at_ms,updated_at_ms,channel_id) VALUES('conversation-links-rpc','t','T',1,1,'c');
        INSERT INTO chat_messages(workspace_id,thread_id,message_order,message_id,author_kind,author_display_name,body,created_at_ms) VALUES('conversation-links-rpc','t',0,'m','human','Ada','',1);").map_err(StorageError::persist_public)?;
        for i in 0..125 {
            let key=format!("f-{i:03}");
            c.execute("INSERT INTO file_objects VALUES('conversation-links-rpc',?1,1)",[&key]).map_err(StorageError::persist_public)?;
            c.execute("INSERT INTO path_aliases VALUES('conversation-links-rpc','main',?1,?2)",rusqlite::params![format!("notes/{key}.md"),key]).map_err(StorageError::persist_public)?;
            c.execute("INSERT INTO chat_attachments(workspace_id,attachment_id,thread_id,message_id,target_kind,object_id,created_at_ms) VALUES('conversation-links-rpc',?1,'t','m','file',?1,?2)",rusqlite::params![key,i]).map_err(StorageError::persist_public)?;
        }
        Ok::<_,StorageError>(())
    }).unwrap();
    drop(store);
    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let handle = open_workspace(&transport, &scratch, 1, "conversation-links-rpc").await;
    let mut id = 1;
    let params = json!({"channelWireId":"wire","scope":"owner","sharedChannelRowsUncovered":0});
    let first = tokio::time::timeout(std::time::Duration::from_secs(120), async {
        loop {
            let p = call(
                &transport,
                &handle,
                &mut id,
                "chats.conversations.listLinks",
                params.clone(),
            )
            .await;
            if p["indexBuilding"] == false {
                break p;
            }
            assert_eq!(p["complete"], false);
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("bounded seed finishes");
    assert_eq!(first["entries"].as_array().unwrap().len(), 100);
    assert!(first.to_string().len() <= 64 * 1024);
    let mut next = params.clone();
    next["cursor"] = first["nextCursor"].clone();
    let second = call(
        &transport,
        &handle,
        &mut id,
        "chats.conversations.listLinks",
        next.clone(),
    )
    .await;
    assert_eq!(second["entries"].as_array().unwrap().len(), 25);
    assert!(second["nextCursor"].is_null());
    next["scope"] = json!("changed");
    assert_eq!(
        call_error(
            &transport,
            &handle,
            &mut id,
            "chats.conversations.listLinks",
            next
        )
        .await
        .code,
        ErrorCode::Conflict
    );
    let mut invalid = params;
    invalid["limit"] = json!(1);
    assert_eq!(
        call_error(
            &transport,
            &handle,
            &mut id,
            "chats.conversations.listLinks",
            invalid
        )
        .await
        .code,
        ErrorCode::InvalidParams
    );
    call(&transport, &handle, &mut id, "workspace.close", json!({})).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn group_stream_and_thread_get_round_trip_with_agent_requests() {
    let scratch = ScratchDir::new().expect("scratch");
    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let handle = open_workspace(&transport, &scratch, 1, "rpc-stream").await;
    let mut id = 10;
    call(
        &transport,
        &handle,
        &mut id,
        "chats.channels.create",
        json!({ "channelId": "group", "name": "Team", "kind": "channel", "nowMs": 2 }),
    )
    .await;
    for (thread, message, lane, at) in [
        ("post-1", "p-1", "posts", 10),
        ("chat", "c-1", "chat", 20),
        ("chat-2", "c-2", "chat", 30),
        ("post-2", "p-2", "posts", 40),
    ] {
        call(
            &transport,
            &handle,
            &mut id,
            "chats.threads.start",
            json!({
                "channelId": "group", "threadId": thread, "messageId": message, "lane": lane,
                "authorKind": "agent", "authorDisplayName": "Scout", "body": message, "nowMs": at,
                "needsDecision": message == "p-1" || message == "c-1",
                "options": if message == "p-1" || message == "c-1" { vec!["Train", "Bus"] } else { vec![] },
            }),
        )
        .await;
    }
    let db_path = engine_db_path(&scratch).expect("db");
    let conn = rusqlite::Connection::open(db_path).expect("open db");
    conn.execute_batch(
        "INSERT INTO chat_dispatch_ledger (workspace_id, trigger_message_id, agent_id, thread_id, \
         state, run_id, failure_reason, attempt_count, created_at_ms, updated_at_ms) \
         VALUES ('rpc-stream', 'c-2', 'research', 'chat', 'pending', NULL, NULL, 0, 31, 31), \
                ('rpc-stream', 'c-2', 'default', 'chat', 'pending', NULL, NULL, 0, 31, 31);",
    )
    .expect("requests");
    drop(conn);

    let newest = call(
        &transport,
        &handle,
        &mut id,
        "chats.stream.list",
        json!({ "channelId": "group", "pageLimit": 2 }),
    )
    .await;
    let ids = |page: &Value| -> Vec<String> {
        page["items"]
            .as_array()
            .expect("items")
            .iter()
            .map(|item| item["message"]["id"].as_str().expect("id").to_owned())
            .collect()
    };
    assert_eq!(ids(&newest), ["c-2", "p-2"]);
    assert!(newest["items"][0].get("decision").is_none());
    assert!(newest["items"][1].get("decision").is_none());
    assert_eq!(
        newest["items"][0]["message"]["agentRequests"],
        json!([
            { "agentId": "default", "state": "waiting" },
            { "agentId": "research", "state": "waiting" },
        ])
    );
    assert_eq!(newest["items"][1]["post"]["replyCount"], json!(0));
    assert_eq!(
        newest["nextBefore"],
        json!({ "createdAtMs": 30, "lane": "chat", "id": "c-2" })
    );
    assert_eq!(newest["readPosition"], Value::Null);
    let older = call(
        &transport,
        &handle,
        &mut id,
        "chats.stream.list",
        json!({ "channelId": "group", "before": newest["nextBefore"].clone() }),
    )
    .await;
    assert_eq!(ids(&older), ["p-1", "c-1"]);
    for (index, thread, message, at) in [(0, "post-1", "p-1", 10), (1, "chat", "c-1", 20)] {
        assert_eq!(
            older["items"][index]["decision"],
            json!({
                "threadId": thread, "messageId": message, "state": "open", "atMs": at,
                "options": ["Train", "Bus"],
            })
        );
    }
    assert_eq!(older["nextBefore"], Value::Null);

    call_with_idempotency(
        &transport,
        &handle,
        &mut id,
        "chats.decisions.resolve",
        "resolve-stream-root",
        json!({
            "threadId": "post-1", "messageId": "p-1", "resolvedByMessageId": "p-1",
            "chosenOption": "Train", "nowMs": 50,
        }),
    )
    .await;
    let resolved = call(
        &transport,
        &handle,
        &mut id,
        "chats.stream.list",
        json!({ "channelId": "group", "before": newest["nextBefore"].clone() }),
    )
    .await;
    assert_eq!(
        resolved["items"][0]["decision"],
        json!({
            "threadId": "post-1", "messageId": "p-1", "state": "resolved", "atMs": 50,
            "options": ["Train", "Bus"], "chosenOption": "Train", "resolvedByMessageId": "p-1",
        })
    );
    assert_eq!(resolved["items"][0]["post"]["openDecisionCount"], json!(0));

    let messages = call(
        &transport,
        &handle,
        &mut id,
        "chats.messages.list",
        json!({ "threadId": "chat" }),
    )
    .await;
    assert_eq!(messages["messages"][0].get("agentRequests"), None);
    assert_eq!(
        messages["messages"][1]["agentRequests"][0]["state"],
        json!("waiting")
    );

    let found = call(
        &transport,
        &handle,
        &mut id,
        "chats.threads.get",
        json!({ "threadId": "chat" }),
    )
    .await;
    assert_eq!(found["thread"]["lane"], json!("chat"));
    assert_eq!(found["channel"]["channelId"], json!("group"));
    assert_eq!(found["messageCount"], json!(2));
    assert_eq!(found.get("work"), None);

    let report = call(
        &transport,
        &handle,
        &mut id,
        "chats.messages.send",
        json!({
            "threadId": "post-2", "messageId": "p-2-work", "authorKind": "agent",
            "authorDisplayName": "Scout", "authorOwnerDisplayName": "Ada", "body": "Opened a pull request",
            "work": { "status": "waiting", "url": "https://example.com/pull/7" }, "nowMs": 60,
        }),
    )
    .await;
    assert_eq!(
        report["work"],
        json!({ "status": "waiting", "url": "https://example.com/pull/7" })
    );
    let card = json!({
        "status": "waiting", "url": "https://example.com/pull/7", "messageId": "p-2-work",
        "author": { "kind": "agent", "displayName": "Scout" }, "authorOwnerDisplayName": "Ada",
        "reportedAtMs": 60,
    });
    let worked = call(
        &transport,
        &handle,
        &mut id,
        "chats.threads.get",
        json!({ "threadId": "post-2" }),
    )
    .await;
    assert_eq!(worked["work"], card);
    let stream = call(
        &transport,
        &handle,
        &mut id,
        "chats.stream.list",
        json!({ "channelId": "group" }),
    )
    .await;
    let posts: Vec<&serde_json::Value> = stream["items"]
        .as_array()
        .expect("items")
        .iter()
        .filter(|item| item.get("post").is_some())
        .collect();
    assert_eq!(posts.len(), 2);
    assert_eq!(posts[0]["post"].get("work"), None);
    assert_eq!(posts[1]["post"]["work"], card);
    let listed = call(
        &transport,
        &handle,
        &mut id,
        "chats.threads.listForChannel",
        json!({ "channelId": "group" }),
    )
    .await;
    let listed_work = |thread_id: &str| {
        listed["threads"]
            .as_array()
            .expect("threads")
            .iter()
            .find(|summary| summary["thread"]["id"] == json!(thread_id))
            .expect("listed thread")
            .get("work")
            .cloned()
    };
    assert_eq!(listed_work("post-1"), None);
    assert_eq!(listed_work("post-2"), Some(card.clone()));
    let refused = call_error(
        &transport,
        &handle,
        &mut id,
        "chats.messages.send",
        json!({
            "threadId": "post-2", "messageId": "p-2-person", "authorKind": "human",
            "authorDisplayName": "Ada", "body": "Mine", "work": { "status": "done" }, "nowMs": 70,
        }),
    )
    .await;
    assert_eq!(refused.code, ErrorCode::InvalidParams);

    let refused = call_error(
        &transport,
        &handle,
        &mut id,
        "chats.stream.list",
        json!({ "channelId": "group", "pageLimit": 101 }),
    )
    .await;
    assert_eq!(refused.code, ErrorCode::InvalidParams);
}
