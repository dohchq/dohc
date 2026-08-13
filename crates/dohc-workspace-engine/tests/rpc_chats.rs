//! RPC-B acceptance: the complete R09 chat read/write surface through the
//! in-process protocol transport, backed only by real domain writes.

use dohc_engine_protocol::{
    error::ErrorCode,
    transport::{EngineTransport, InProcessTransport, RequestContext},
    wire::{Request, WorkspaceHandle},
};
use dohc_engine_storage::{EngineStore, NoFaults, StorageError};
use dohc_engine_sync::{ReplicationEnvelope, apply_chat_envelope};
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
async fn chats_feed_list_personal_refuses_limit_above_cap() {
    let scratch = ScratchDir::new().expect("scratch");
    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let handle = open_workspace(&transport, &scratch, 1, "feed-limit-cap").await;
    let mut id = 1;

    // MUTATION: clamp an over-cap feed limit at the RPC boundary -> the caller
    // gets a successful, semantically different page instead of invalid input.
    let error = call_error(
        &transport,
        &handle,
        &mut id,
        "chats.feed.listPersonal",
        json!({ "ownerUserId": "owner", "limit": 101 }),
    )
    .await;
    assert_eq!(error.code, ErrorCode::InvalidParams);
    assert_eq!(error.message, "invalid-follow-target");
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
    transport
        .call(RequestContext::unbounded(), request)
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
    transport
        .call(RequestContext::unbounded(), request)
        .await
        .unwrap_err()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn rpc_b2_reactions_decisions_and_personal_feed_hydration() {
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
    // MUTATION: omitting needsDecision from the strict DTO/domain input -> the opening decision is absent over DOP1.
    assert_eq!(decisions["decisions"][0]["state"], json!("open"));

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
    // MUTATION: requiring the resolver row to exist -> a valid head-check-free resolver is rejected.
    assert_eq!(resolved["resolvedByMessageId"], json!("not-present-yet"));
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
    // MUTATION: mapping malformed resolver input to state-corrupt -> wire code becomes INTERNAL.
    assert_eq!(malformed.code, ErrorCode::InvalidParams);
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
    // MUTATION: routing an unknown wire literal through persisted-row decoding -> caller input is mislabeled INTERNAL.
    assert_eq!(invalid_state.code, ErrorCode::InvalidParams);
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
    // MUTATION: serializing the parked `reactions: []` placeholder -> active feed reactions vanish at the wire boundary.
    assert_eq!(feed["items"][0]["reactions"][0]["emoji"], json!("👍"));

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
    // MUTATION: shipping a prefix-only channel list or omitting the full aggregate -> older page/full opening reaction is unavailable.
    assert_eq!(summary["thread"]["id"], json!("thread"));
    assert_eq!(summary["messageCount"], json!(1));
    assert_eq!(summary["openDecisionCount"], json!(0));
    assert_eq!(
        summary["openingMessage"]["reactions"][0]["emoji"],
        json!("👍")
    );
    assert!(second_page["nextCursor"].is_null());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn rpc_b2_reactions_and_decisions_accept_max_page_limit() {
    let scratch = ScratchDir::new().expect("scratch");
    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let handle = open_workspace(&transport, &scratch, 1, "rpc-b2-max-page").await;
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
            "messageId": "message",
            "authorKind": "human",
            "authorDisplayName": "Ada",
            "body": "Choose",
            "needsDecision": true,
            "nowMs": 20,
        }),
    )
    .await;
    call_with_idempotency(
        &transport,
        &handle,
        &mut id,
        "chats.reactions.set",
        "reaction",
        json!({
            "threadId": "thread",
            "messageId": "message",
            "emoji": "👍",
            "author": {
                "authorId": "ada",
                "kind": "human",
                "displayName": "Ada",
            },
            "replicationAuthorId": "ada",
            "state": "added",
            "nowMs": 30,
        }),
    )
    .await;

    let decisions = call(
        &transport,
        &handle,
        &mut id,
        "chats.decisions.listForThread",
        json!({ "threadId": "thread", "pageLimit": 500 }),
    )
    .await;
    let reactions = call(
        &transport,
        &handle,
        &mut id,
        "chats.reactions.list",
        json!({ "threadId": "thread", "pageLimit": 500 }),
    )
    .await;
    // MUTATION: keeping the domain probe cap at 500 rejects the RPC's 501-row probe.
    assert_eq!(
        decisions["decisions"].as_array().expect("decisions").len(),
        1
    );
    assert_eq!(
        reactions["reactions"].as_array().expect("reactions").len(),
        1
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn rpc_b2_negative_reaction_cursor_boundary_round_trips() {
    let scratch = ScratchDir::new().expect("scratch");
    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let handle = open_workspace(&transport, &scratch, 1, "rpc-b2-negative-cursor").await;
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
            "messageId": "message",
            "authorKind": "human",
            "authorDisplayName": "Ada",
            "body": "Opening",
            "nowMs": 20,
        }),
    )
    .await;

    let conn = rusqlite::Connection::open(scratch.engine_db_path().expect("engine database path"))
        .expect("open database");
    for (reaction_id, emoji, author_id, at_ms, origin_seq) in [
        ("reaction-negative-a", "👍", "ada", -10_i64, 0_i64),
        ("reaction-negative-b", "🎉", "bob", -9_i64, 1_i64),
    ] {
        conn.execute(
            "INSERT INTO chat_reactions \
             (workspace_id,reaction_id,thread_id,message_id,emoji,author_id,author_kind,\
              author_display_name,state,at_ms,origin_id,origin_seq) \
             VALUES ('rpc-b2-negative-cursor',?1,'thread','message',?2,?3,'human','',\
                     'added',?4,'peer',?5)",
            rusqlite::params![reaction_id, emoji, author_id, at_ms, origin_seq],
        )
        .expect("insert imported reaction");
    }
    drop(conn);

    let first = call(
        &transport,
        &handle,
        &mut id,
        "chats.reactions.list",
        json!({ "threadId": "thread", "pageLimit": 1 }),
    )
    .await;
    let cursor = first["nextCursor"]
        .as_str()
        .expect("negative boundary cursor");
    let second = call(
        &transport,
        &handle,
        &mut id,
        "chats.reactions.list",
        json!({ "threadId": "thread", "pageLimit": 1, "cursor": cursor }),
    )
    .await;
    // MUTATION: restore the cursor.first nonnegative guard -> the second request refuses.
    assert_eq!(first["reactions"][0]["atMs"], json!(-10));
    assert_eq!(first["reactions"][0]["author"]["displayName"], json!(""));
    assert_eq!(second["reactions"][0]["atMs"], json!(-9));
    assert!(second["nextCursor"].is_null());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn rpc_b2_single_oversize_row_fails_instead_of_truncating() {
    let scratch = ScratchDir::new().expect("scratch");
    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let handle = open_workspace(&transport, &scratch, 1, "rpc-b2-oversize-row").await;
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
            "messageId": "message",
            "authorKind": "human",
            "authorDisplayName": "Ada",
            "body": "Opening",
            "nowMs": 20,
        }),
    )
    .await;

    let conn = rusqlite::Connection::open(scratch.engine_db_path().expect("engine database path"))
        .expect("open database");
    let oversize_title = "x".repeat(700 * 1024 + 1);
    conn.execute(
        "UPDATE chat_threads SET title = ?1 \
         WHERE workspace_id = 'rpc-b2-oversize-row' AND thread_id = 'thread'",
        rusqlite::params![oversize_title],
    )
    .expect("compose oversize persisted row");
    drop(conn);

    let error = call_error(
        &transport,
        &handle,
        &mut id,
        "chats.threads.listForChannel",
        json!({ "channelId": "channel", "pageLimit": 1 }),
    )
    .await;
    // MUTATION: treating the first oversize row as a normal byte-budget cut
    // returns an empty/truncated page instead of a stable refusal.
    assert_eq!(error.code, ErrorCode::LimitExceeded);
    assert_eq!(error.message, "row-exceeds-wire-limit");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn rpc_b2_attachment_and_file_thread_contracts() {
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
    // MUTATION: omit linked owner hydration -> canonical Thread loses its stable file identity.
    assert_eq!(
        thread,
        json!({
            "id": "file-thread",
            "workspaceId": "rpc-b2-attachments",
            "title": "File thread",
            "createdAtMs": 20,
            "updatedAtMs": 20,
            "linkedFile": {
                "objectId": "object-1",
                "pathHint": "notes/file.md",
                "linkedAtMs": 20,
            }
        })
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
    // MUTATION: omit authoritative attachment hydration from send -> result is incomplete.
    assert_eq!(
        sent["attachments"].as_array().expect("attachments").len(),
        1
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
    let mentions = call(
        &transport,
        &handle,
        &mut id,
        "chats.attachments.listFileMentions",
        json!({
            "objectId": "object-1",
            "pathHint": "notes/reused.md",
            "pageLimit": 10
        }),
    )
    .await;
    // MUTATION: hydrate only the selected attachment -> nested message attachment list is empty.
    assert_eq!(
        mentions["mentions"][0]["message"]["attachments"]
            .as_array()
            .expect("hydrated attachments")
            .len(),
        1
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
    // MUTATION: route Feed through the legacy slim serializers -> both of
    // these authoritative B2 fields disappear.
    assert_eq!(
        feed["items"][0]["message"]["attachments"]
            .as_array()
            .expect("feed message attachments")
            .len(),
        1
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
async fn file_mentions_cap_at_2000_newest_and_hydrate_all_message_attachments() {
    let scratch = ScratchDir::new().expect("scratch");
    write_shadow_marker_for_harness(scratch.path(), TOKEN).expect("shadow marker");
    let db_path = scratch.engine_db_path().expect("db path");
    let mut store = EngineStore::open(&db_path, 1).expect("store");
    store.bind_shadow_clone_token(TOKEN).expect("bind token");
    store
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT INTO chat_channels \
                 (workspace_id,channel_id,name,slug,kind,created_at_ms,updated_at_ms) \
                 VALUES ('rpc-b2-cap','channel','Channel','channel','channel',1,1)",
                [],
            )
            .map_err(StorageError::persist_public)?;
            for index in 0..=2_000_i64 {
                let thread_id = format!("thread-{index:04}");
                let message_id = format!("message-{index:04}");
                let attachment_id = format!("attachment-{index:04}");
                tx.execute(
                    "INSERT INTO chat_threads \
                     (workspace_id,thread_id,title,created_at_ms,updated_at_ms,channel_id) \
                     VALUES ('rpc-b2-cap',?1,'Thread',?2,?2,'channel')",
                    rusqlite::params![thread_id, index],
                )
                .map_err(StorageError::persist_public)?;
                tx.execute(
                    "INSERT INTO chat_messages \
                     (workspace_id,thread_id,message_order,message_id,author_kind,author_display_name,body,created_at_ms) \
                     VALUES ('rpc-b2-cap',?1,0,?2,'human','Ada','Body',?3)",
                    rusqlite::params![thread_id, message_id, index],
                )
                .map_err(StorageError::persist_public)?;
                tx.execute(
                    "INSERT INTO chat_attachments \
                     (workspace_id,attachment_id,thread_id,message_id,target_kind,object_id,created_at_ms) \
                     VALUES ('rpc-b2-cap',?1,?2,?3,'file','wanted',?4)",
                    rusqlite::params![attachment_id, thread_id, message_id, index],
                )
                .map_err(StorageError::persist_public)?;
            }
            tx.execute(
                "INSERT INTO chat_attachments \
                 (workspace_id,attachment_id,thread_id,message_id,target_kind,object_id,created_at_ms) \
                 VALUES ('rpc-b2-cap','other-target','thread-2000','message-2000','file','other',2000)",
                [],
            )
            .map_err(StorageError::persist_public)?;
            Ok::<_, StorageError>(())
        })
        .expect("seed");
    drop(store);

    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let handle = open_workspace(&transport, &scratch, 1, "rpc-b2-cap").await;
    let mut id = 10;
    let mut cursor: Option<String> = None;
    let mut mentions = Vec::new();
    loop {
        let mut params = json!({ "objectId": "wanted", "pageLimit": 500 });
        if let Some(value) = &cursor {
            params["cursor"] = json!(value);
        }
        let page = call(
            &transport,
            &handle,
            &mut id,
            "chats.attachments.listFileMentions",
            params,
        )
        .await;
        mentions.extend(
            page["mentions"]
                .as_array()
                .expect("mention page")
                .iter()
                .cloned(),
        );
        cursor = page["nextCursor"].as_str().map(str::to_owned);
        if cursor.is_none() {
            break;
        }
    }
    // MUTATION: omit the logical 2,000 cap -> the oldest selected row is exposed.
    assert_eq!(mentions.len(), 2_000);
    assert_eq!(mentions[0]["message"]["id"], json!("message-2000"));
    assert!(
        mentions
            .iter()
            .all(|mention| mention["message"]["id"] != json!("message-0000"))
    );
    // MUTATION: hydrate only matching attachments -> the newest message loses its other target.
    assert_eq!(
        mentions[0]["message"]["attachments"]
            .as_array()
            .expect("all attachments")
            .len(),
        2
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn rpc_b2_mentions_backfill_marker_makes_second_open_a_noop() {
    let scratch = ScratchDir::new().expect("scratch");
    write_shadow_marker_for_harness(scratch.path(), TOKEN).expect("shadow marker");
    let db_path = scratch.engine_db_path().expect("db path");
    let mut store = EngineStore::open(&db_path, 1).expect("store");
    store.bind_shadow_clone_token(TOKEN).expect("bind token");
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
        json!({ "handle": "AGENT", "unreadByAgentOnly": false, "pageLimit": 10 }),
    )
    .await;
    // MUTATION: handing out the workspace before backfill makes this first read empty.
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
        })
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
            json!({ "handle": query, "unreadByAgentOnly": false, "pageLimit": 10 }),
        )
        .await;
        // MUTATION: retain the narrow ASCII alphanumeric/hyphen validator -> this indexed row is unqueryable.
        assert_eq!(mentions["mentions"][0]["handle"], json!(normalized));
        assert_eq!(mentions["mentions"][0]["messageId"], json!("message"));
    }
    let first = call(
        &transport,
        &handle,
        &mut id,
        "chats.dispatch.recordEligibleTriggers",
        json!({}),
    )
    .await;
    let retry = call(
        &transport,
        &handle,
        &mut id,
        "chats.dispatch.recordEligibleTriggers",
        json!({}),
    )
    .await;
    // MUTATION: scan-before-backfill or a non-idempotent ledger changes this pair.
    assert_eq!((first, retry), (json!(1), json!(0)));

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
        json!({ "handle": "raw", "unreadByAgentOnly": false, "pageLimit": 10 }),
    )
    .await;
    // MUTATION: drop or ignore the durable completion marker -> the second
    // open reparses this raw fixture row and hides the write-time-indexing
    // invariant by making it visible.
    assert!(
        raw_mentions["mentions"]
            .as_array()
            .expect("raw mentions")
            .is_empty()
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn synced_negative_agent_read_cursor_round_trips_over_the_wire() {
    let scratch = ScratchDir::new().expect("scratch");
    write_shadow_marker_for_harness(scratch.path(), TOKEN).expect("shadow marker");
    let db_path = scratch.engine_db_path().expect("db path");
    let mut store = EngineStore::open(&db_path, 1).expect("store");
    store.bind_shadow_clone_token(TOKEN).expect("bind token");
    store
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT INTO chat_threads \
                 (workspace_id,thread_id,title,created_at_ms,updated_at_ms,linked_object_id,linked_at_ms) \
                 VALUES ('rpc-negative-agent-read','negative-thread','Imported',0,0,'negative-object',0)",
                [],
            )
            .map_err(StorageError::persist_public)?;
            Ok::<_, StorageError>(())
        })
        .expect("seed local thread");
    let operation = ReplicationEnvelope {
        workspace_id: "rpc-negative-agent-read".to_owned(),
        origin_id: "peer".to_owned(),
        origin_seq: 0,
        relay_seq: Some(0),
        op_kind: "chat.message.append".to_owned(),
        payload: json!({
            "messageId": "negative-message",
            "threadId": "negative-thread",
            "authorKind": "human",
            "authorDisplayName": "Peer",
            "body": "Imported",
            "createdAtMs": -10,
        }),
        recorded_at_ms: 1,
    };
    apply_chat_envelope(&mut store, &operation, &NoFaults).expect("apply synced chat row");
    drop(store);

    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let handle = open_workspace(&transport, &scratch, 1, "rpc-negative-agent-read").await;
    let mut id = 10;
    let state = call(
        &transport,
        &handle,
        &mut id,
        "chats.agentReadState.markThreadRead",
        json!({
            "threadId": "negative-thread",
            "upTo": { "createdAtMs": 0, "messageId": "after" },
        }),
    )
    .await;
    // Oracle parity (linkedChatStore.ts:3101-3109): the clamped target is the
    // negative latest, which sits below the fresh (0, "") cursor floor, so the
    // mark is a NO-OP — the thread stays unread-but-unmarkable exactly like the
    // oracle. The read/serialization chain must still accept the signed
    // coordinate the daemon reads back (no state-corrupt).
    // MUTATION: advance onto the negative coordinate -> the no-op assertions fail.
    assert_eq!(state["lastReadCreatedAtMs"], json!(0));
    assert_eq!(state["lastReadMessageId"], json!(""));
    assert_eq!(state["revision"], json!(0));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn review_round_7_normalizes_persisted_chat_identities() {
    let scratch = ScratchDir::new().expect("scratch");
    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let handle = open_workspace(&transport, &scratch, 1, "rpc-chat-round-7").await;
    let mut id = 10;

    let channel = call(
        &transport,
        &handle,
        &mut id,
        "chats.channels.create",
        json!({
            "channelId": "  channel-round-7  ",
            "name": "Round Seven",
            "kind": "channel",
            "nowMs": 10,
        }),
    )
    .await;
    assert_eq!(channel["channelId"], json!("channel-round-7"));
    for (index, invalid_channel_id) in [
        format!("bad{}channel", '\u{0001}'),
        "x".repeat(257),
        "界".repeat(200),
    ]
    .into_iter()
    .enumerate()
    {
        let invalid_name = format!("Invalid channel {index}");
        let error = call_error(
            &transport,
            &handle,
            &mut id,
            "chats.channels.create",
            json!({
                "channelId": invalid_channel_id,
                "name": invalid_name,
                "kind": "channel",
                "nowMs": 11,
            }),
        )
        .await;
        assert_eq!(error.code, ErrorCode::InvalidParams);
    }

    let missing = call_error(
        &transport,
        &handle,
        &mut id,
        "chats.channels.getWireId",
        json!({ "channelId": "missing-channel" }),
    )
    .await;
    assert_eq!(missing.code, ErrorCode::InvalidParams);

    let db_path = scratch.engine_db_path().expect("engine db path");
    let conn = rusqlite::Connection::open(&db_path).expect("open engine db");
    conn.execute(
        "DELETE FROM chat_channel_wire_ids WHERE workspace_id = ?1 AND channel_id = ?2",
        ["rpc-chat-round-7", "channel-round-7"],
    )
    .expect("delete channel wire mapping");
    drop(conn);
    let unmapped = call(
        &transport,
        &handle,
        &mut id,
        "chats.channels.getWireId",
        json!({ "channelId": "channel-round-7" }),
    )
    .await;
    assert_eq!(unmapped["wireId"], Value::Null);

    let started = call(
        &transport,
        &handle,
        &mut id,
        "chats.threads.start",
        json!({
            "channelId": "channel-round-7",
            "threadId": "  thread-round-7  ",
            "messageId": "message-round-7",
            "authorKind": "human",
            "authorDisplayName": "Alice",
            "authorUserId": "  user-round-7  ",
            "body": "round seven",
            "nowMs": 20,
        }),
    )
    .await;
    assert_eq!(started["thread"]["id"], json!("thread-round-7"));
    assert_eq!(started["message"]["threadId"], json!("thread-round-7"));
    assert_eq!(started["message"]["authorUserId"], json!("user-round-7"));
    for (thread_id, message_id) in [
        (format!("bad{}thread", '\u{0001}'), "bad-control"),
        ("x".repeat(257), "bad-overlong"),
    ] {
        let error = call_error(
            &transport,
            &handle,
            &mut id,
            "chats.threads.start",
            json!({
                "channelId": "channel-round-7",
                "threadId": thread_id,
                "messageId": message_id,
                "authorKind": "human",
                "authorDisplayName": "Alice",
                "body": "must fail",
                "nowMs": 21,
            }),
        )
        .await;
        assert_eq!(error.code, ErrorCode::InvalidParams);
    }

    let padded_bookmark = call(
        &transport,
        &handle,
        &mut id,
        "chats.bookmarks.save",
        json!({
            "ownerUserId": "  owner-round-7  ",
            "targetKind": "thread",
            "targetId": "  thread-round-7  ",
            "mode": "live",
            "destinationPath": "bookmarks/round-7.md",
            "nowMs": 30,
        }),
    )
    .await;
    assert_eq!(padded_bookmark["ownerUserId"], json!("owner-round-7"));
    assert_eq!(padded_bookmark["targetId"], json!("thread-round-7"));
    let plain_bookmark = call(
        &transport,
        &handle,
        &mut id,
        "chats.bookmarks.save",
        json!({
            "ownerUserId": "owner-round-7",
            "targetKind": "thread",
            "targetId": "thread-round-7",
            "mode": "live",
            "destinationPath": "bookmarks/round-7.md",
            "nowMs": 31,
        }),
    )
    .await;
    assert_eq!(plain_bookmark["bookmarkId"], padded_bookmark["bookmarkId"]);
    let bookmarks = call(
        &transport,
        &handle,
        &mut id,
        "chats.bookmarks.list",
        json!({ "ownerUserId": "owner-round-7" }),
    )
    .await;
    assert_eq!(
        bookmarks["bookmarks"].as_array().expect("bookmarks").len(),
        1
    );

    let enqueued = call(
        &transport,
        &handle,
        &mut id,
        "chats.dispatch.enqueue",
        json!({
            "triggerMessageId": "  trigger-round-7  ",
            "threadId": "  thread-round-7  ",
            "nowMs": 40,
        }),
    )
    .await;
    assert_eq!(enqueued["enqueued"], json!(true));
    let claim = call(
        &transport,
        &handle,
        &mut id,
        "chats.dispatch.claimNextPending",
        json!({ "runId": "run-round-7", "nowMs": 41 }),
    )
    .await;
    assert_eq!(
        claim["dispatch"]["triggerMessageId"],
        json!("trigger-round-7")
    );
    assert_eq!(claim["dispatch"]["threadId"], json!("thread-round-7"));
    for (trigger_message_id, thread_id) in [
        ("   ".to_owned(), "thread-round-7".to_owned()),
        ("x".repeat(513), "thread-round-7".to_owned()),
        ("bad\0trigger".to_owned(), "thread-round-7".to_owned()),
        ("another-trigger".to_owned(), "   ".to_owned()),
    ] {
        let error = call_error(
            &transport,
            &handle,
            &mut id,
            "chats.dispatch.enqueue",
            json!({
                "triggerMessageId": trigger_message_id,
                "threadId": thread_id,
                "nowMs": 42,
            }),
        )
        .await;
        assert_eq!(error.code, ErrorCode::InvalidParams);
    }

    let conn = rusqlite::Connection::open(db_path).expect("reopen engine db");
    let payload: String = conn
        .query_row(
            "SELECT payload_json FROM replication_log WHERE workspace_id = ?1 \
             AND op_kind = 'chat.thread.create' ORDER BY origin_seq DESC LIMIT 1",
            ["rpc-chat-round-7"],
            |row| row.get(0),
        )
        .expect("thread replication payload");
    let payload: Value = serde_json::from_str(&payload).expect("valid replication payload");
    assert_eq!(payload["threadId"], json!("thread-round-7"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn second_service_cannot_attach_to_a_live_workspace_actor() {
    // MUTATION: accept `created_actor == false` in workspace.open -> the
    // second service receives a handle to the first service's actor.
    let scratch = ScratchDir::new().expect("scratch");
    let first_transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let second_transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let first_handle = open_workspace(&first_transport, &scratch, 1, "rpc-chat-round-8").await;
    let mut id = 10;

    call(
        &first_transport,
        &first_handle,
        &mut id,
        "chats.channels.ensureAgent",
        json!({ "channelId": "agent-round-8", "nowMs": 10 }),
    )
    .await;
    call(
        &first_transport,
        &first_handle,
        &mut id,
        "chats.threads.start",
        json!({
            "channelId": "agent-round-8",
            "threadId": "thread-round-8",
            "messageId": "message-round-8",
            "authorKind": "human",
            "authorDisplayName": "Alice",
            "body": "@agent keep running",
            "nowMs": 20,
        }),
    )
    .await;
    call(
        &first_transport,
        &first_handle,
        &mut id,
        "chats.dispatch.enqueue",
        json!({
            "triggerMessageId": "message-round-8",
            "threadId": "thread-round-8",
            "nowMs": 21,
        }),
    )
    .await;
    let running = call(
        &first_transport,
        &first_handle,
        &mut id,
        "chats.dispatch.claimNextPending",
        json!({ "runId": "run-round-8", "nowMs": 22 }),
    )
    .await;
    assert_eq!(running["dispatch"]["state"], json!("running"));

    let refused = second_transport
        .call(
            RequestContext::unbounded(),
            request(
                100,
                "workspace.open",
                None,
                json!({
                    "rootDir": scratch.path().to_string_lossy(),
                    "workspaceId": "rpc-chat-round-8",
                }),
            ),
        )
        .await;
    let refused = refused.expect_err("a second service must not attach to the shared actor");
    assert_eq!(refused.code, ErrorCode::WorkspaceUnavailable);
    assert_eq!(refused.message, "workspace database is already attached");

    let retried = call(
        &first_transport,
        &first_handle,
        &mut id,
        "chats.dispatch.claimNextPending",
        json!({ "runId": "run-round-8", "nowMs": 24 }),
    )
    .await;
    assert_eq!(retried, running);

    call(
        &first_transport,
        &first_handle,
        &mut id,
        "chats.dispatch.complete",
        json!({ "runId": "run-round-8", "exitCode": 0, "nowMs": 25 }),
    )
    .await;
    call(
        &first_transport,
        &first_handle,
        &mut id,
        "workspace.close",
        json!({}),
    )
    .await;
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
        // Ids are bounded (256 UTF-16 units) since round 7, so the byte
        // pressure comes from LARGE MESSAGE BODIES — hydrated feed items
        // embed the opening message body, so ~60 KiB bodies trip the
        // 256 KiB page budget after a handful of items.
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
    for invalid_command in [json!("bad\0command"), json!("x".repeat(16_385))] {
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

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn review_round_11_bookmark_state_filter_command_default_and_path_floor() {
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

    // Canonical Check-A floor: a percent-DISGUISED traversal has no literal
    // ".." bytes, so the old `validate_path` floor accepted it. Mutation
    // check: restore `crate::store::validate_path` in `save_bookmark` — this
    // refusal fails (the save succeeds) and the dotted destination below
    // persists un-normalized.
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

    // An omitted claim command is the oracle's EMPTY-string default, and a
    // whitespace-only command is preserved verbatim. Mutation check: restore
    // `unwrap_or_else(|| "agent".to_owned())` in the claim arm — the empty
    // command assertion fails.
    call(
        &transport,
        &handle,
        &mut id,
        "chats.dispatch.enqueue",
        json!({ "triggerMessageId": "message-r11", "threadId": "thread-r11", "nowMs": 20 }),
    )
    .await;
    let claimed = call(
        &transport,
        &handle,
        &mut id,
        "chats.dispatch.claimNextPending",
        json!({ "runId": "run-r11", "nowMs": 21 }),
    )
    .await;
    assert_eq!(claimed["run"]["command"], json!(""));
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
        json!({ "triggerMessageId": "message-r11b", "threadId": "thread-r11b", "nowMs": 23 }),
    )
    .await;
    let whitespace = call(
        &transport,
        &handle,
        &mut id,
        "chats.dispatch.claimNextPending",
        json!({ "runId": "run-r11b", "command": "   ", "nowMs": 24 }),
    )
    .await;
    assert_eq!(whitespace["run"]["command"], json!("   "));

    call(&transport, &handle, &mut id, "workspace.close", json!({})).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn review_round_12_rejects_malformed_ready_generation_and_null_claim_metadata() {
    let scratch = ScratchDir::new().expect("scratch");
    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let handle = open_workspace(&transport, &scratch, 1, "rpc-chat-r12").await;
    let mut id = 10;

    call(
        &transport,
        &handle,
        &mut id,
        "chats.channels.create",
        json!({ "channelId": "channel-r12", "name": "R12", "kind": "channel", "nowMs": 10 }),
    )
    .await;
    call(
        &transport,
        &handle,
        &mut id,
        "chats.threads.start",
        json!({
            "channelId": "channel-r12",
            "threadId": "thread-r12",
            "messageId": "message-r12",
            "authorKind": "human",
            "authorDisplayName": "Alice",
            "body": "r12",
            "nowMs": 11,
        }),
    )
    .await;
    let bookmark = call(
        &transport,
        &handle,
        &mut id,
        "chats.bookmarks.save",
        json!({
            "ownerUserId": "owner-1",
            "targetKind": "thread",
            "targetId": "thread-r12",
            "mode": "live",
            "destinationPath": "bookmarks/r12.md",
            "nowMs": 12,
        }),
    )
    .await;
    let bookmark_id = bookmark["bookmarkId"].as_str().expect("id").to_owned();

    // A generation above JS Number.MAX_SAFE_INTEGER is a malformed coordinate
    // and must REFUSE like the failed/stale transitions, not read as merely
    // stale. Mutation check: restore the bare `generation < 1` floor in
    // `mark_bookmark_ready` — the call then succeeds with applied:false and
    // this refusal assertion fails.
    let unsafe_generation = call_error(
        &transport,
        &handle,
        &mut id,
        "chats.bookmarks.markReady",
        json!({
            "ownerUserId": "owner-1",
            "bookmarkId": &bookmark_id,
            "generation": 9_007_199_254_740_992_i64,
            "projectedAtMs": 13,
        }),
    )
    .await;
    assert_eq!(unsafe_generation.code, ErrorCode::InvalidParams);

    // Explicit JSON null is malformed runner metadata, distinct from omission.
    // Mutation check: drop the non-null deserializers on
    // ChatDispatchClaimParams — null then reads as None and the claim
    // proceeds, failing both refusal assertions.
    for field in ["command", "logPath"] {
        let mut params = serde_json::Map::new();
        params.insert("runId".into(), json!("run-r12"));
        params.insert(field.into(), Value::Null);
        params.insert("nowMs".into(), json!(20));
        let error = call_error(
            &transport,
            &handle,
            &mut id,
            "chats.dispatch.claimNextPending",
            Value::Object(params),
        )
        .await;
        assert_eq!(error.code, ErrorCode::InvalidParams);
    }

    call(&transport, &handle, &mut id, "workspace.close", json!({})).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn rpc_b2_reshapes_six_existing_arms_without_truncated() {
    let scratch = ScratchDir::new().expect("scratch");
    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let handle = open_workspace(&transport, &scratch, 1, "rpc-chat-r16").await;
    let mut id = 10;

    // Reserved wire ids refuse on the ENSURE paths exactly like create.
    // Mutation check: drop the reserved guard from ensure_well_known_channel
    // — both refusals below fail.
    for (method, reserved) in [
        ("chats.channels.ensureGeneral", "channel_wire_general_v1"),
        ("chats.channels.ensureAgent", "channel_wire_agent_v1"),
    ] {
        let error = call_error(
            &transport,
            &handle,
            &mut id,
            method,
            json!({ "channelId": reserved, "nowMs": 10 }),
        )
        .await;
        assert_eq!(error.code, ErrorCode::InvalidParams);
    }

    // follows.list: omitted state returns ALL rows (tombstones included),
    // a state filter narrows, an invalid state refuses. Mutation check:
    // parse ChatOwnerParams again (or restore the hardcoded
    // state='following' SQL) — the tombstone and filter assertions fail.
    call(
        &transport,
        &handle,
        &mut id,
        "chats.channels.create",
        json!({ "channelId": "channel-r16", "name": "R16", "kind": "channel", "nowMs": 11 }),
    )
    .await;
    call(
        &transport,
        &handle,
        &mut id,
        "chats.follows.set",
        json!({
            "ownerUserId": "owner-1",
            "targetKind": "channel",
            "targetId": "channel-r16",
            "state": "following",
            "nowMs": 12,
        }),
    )
    .await;
    call(
        &transport,
        &handle,
        &mut id,
        "chats.follows.set",
        json!({
            "ownerUserId": "owner-1",
            "targetKind": "channel",
            "targetId": "channel-r16",
            "state": "unfollowed",
            "nowMs": 13,
        }),
    )
    .await;
    let all = call(
        &transport,
        &handle,
        &mut id,
        "chats.follows.list",
        json!({ "ownerUserId": "owner-1" }),
    )
    .await;
    assert_eq!(all["follows"].as_array().expect("all").len(), 1);
    assert_eq!(all["follows"][0]["state"], json!("unfollowed"));
    let following = call(
        &transport,
        &handle,
        &mut id,
        "chats.follows.list",
        json!({ "ownerUserId": "owner-1", "state": "following" }),
    )
    .await;
    assert_eq!(following["follows"].as_array().expect("following").len(), 0);
    let bogus = call_error(
        &transport,
        &handle,
        &mut id,
        "chats.follows.list",
        json!({ "ownerUserId": "owner-1", "state": "bogus" }),
    )
    .await;
    assert_eq!(bogus.code, ErrorCode::InvalidParams);

    // Bookmark polling: listPending sees the pending outbox generation,
    // find returns the row (and null for a miss). Mutation check: route
    // listPending to the plain list (drop the projection_state filter) —
    // the post-markReady emptiness assertion fails.
    call(
        &transport,
        &handle,
        &mut id,
        "chats.threads.start",
        json!({
            "channelId": "channel-r16",
            "threadId": "thread-r16",
            "messageId": "message-r16",
            "authorKind": "human",
            "authorDisplayName": "Alice",
            "body": "r16",
            "nowMs": 14,
        }),
    )
    .await;
    let bookmark = call(
        &transport,
        &handle,
        &mut id,
        "chats.bookmarks.save",
        json!({
            "ownerUserId": "owner-1",
            "targetKind": "thread",
            "targetId": "thread-r16",
            "mode": "live",
            "destinationPath": "bookmarks/r16.md",
            "nowMs": 15,
        }),
    )
    .await;
    let bookmark_id = bookmark["bookmarkId"].as_str().expect("id").to_owned();
    let pending = call(
        &transport,
        &handle,
        &mut id,
        "chats.bookmarks.listPending",
        json!({ "ownerUserId": "owner-1" }),
    )
    .await;
    // MUTATION: restore the RPC-B `{bookmarks,truncated}` response -> the
    // cursor-page contract exposes the removed field and omits nextCursor.
    assert!(pending.get("truncated").is_none());
    assert_eq!(pending["nextCursor"], Value::Null);
    assert_eq!(pending["bookmarks"].as_array().expect("pending").len(), 1);
    assert_eq!(pending["bookmarks"][0]["bookmarkId"], json!(&bookmark_id));
    let bad_limit = call_error(
        &transport,
        &handle,
        &mut id,
        "chats.bookmarks.listPending",
        json!({ "ownerUserId": "owner-1", "limit": 0 }),
    )
    .await;
    assert_eq!(bad_limit.code, ErrorCode::InvalidParams);
    let found = call(
        &transport,
        &handle,
        &mut id,
        "chats.bookmarks.find",
        json!({ "ownerUserId": "owner-1", "bookmarkId": &bookmark_id }),
    )
    .await;
    // MUTATION: wrap `find` in the old `{bookmark: ...}` object -> consumers
    // no longer receive the design's direct `Bookmark | null` result.
    assert_eq!(found["bookmarkId"], json!(&bookmark_id));
    let missing = call(
        &transport,
        &handle,
        &mut id,
        "chats.bookmarks.find",
        json!({ "ownerUserId": "owner-1", "bookmarkId": "bookmark_nope" }),
    )
    .await;
    assert_eq!(missing, Value::Null);
    call(
        &transport,
        &handle,
        &mut id,
        "chats.bookmarks.markReady",
        json!({
            "ownerUserId": "owner-1",
            "bookmarkId": &bookmark_id,
            "generation": 1,
            "projectedAtMs": 16,
        }),
    )
    .await;
    let drained = call(
        &transport,
        &handle,
        &mut id,
        "chats.bookmarks.listPending",
        json!({ "ownerUserId": "owner-1" }),
    )
    .await;
    assert_eq!(drained["bookmarks"].as_array().expect("drained").len(), 0);

    call(&transport, &handle, &mut id, "workspace.close", json!({})).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn named_chat_lists_page_without_losing_rows() {
    let scratch = ScratchDir::new().expect("scratch");
    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let handle = open_workspace(&transport, &scratch, 1, "rpc-chat-named-pages").await;
    let mut id = 10;

    for (channel_id, now_ms) in [("channel-1", 10), ("channel-2", 11)] {
        call(
            &transport,
            &handle,
            &mut id,
            "chats.channels.create",
            json!({
                "channelId": channel_id,
                "name": channel_id,
                "kind": "channel",
                "nowMs": now_ms,
            }),
        )
        .await;
    }
    for (channel_id, thread_id, message_id, now_ms) in [
        ("channel-1", "thread-1", "message-1", 12),
        ("channel-2", "thread-2", "message-2", 13),
    ] {
        call(
            &transport,
            &handle,
            &mut id,
            "chats.threads.start",
            json!({
                "channelId": channel_id,
                "threadId": thread_id,
                "messageId": message_id,
                "authorKind": "human",
                "authorDisplayName": "Ice",
                "body": thread_id,
                "nowMs": now_ms,
            }),
        )
        .await;
        call(
            &transport,
            &handle,
            &mut id,
            "chats.follows.set",
            json!({
                "ownerUserId": "owner",
                "targetKind": "thread",
                "targetId": thread_id,
                "state": "following",
                "nowMs": now_ms,
            }),
        )
        .await;
    }
    let mut bookmark_ids = Vec::new();
    for (thread_id, now_ms) in [("thread-1", 14), ("thread-2", 15)] {
        let bookmark = call(
            &transport,
            &handle,
            &mut id,
            "chats.bookmarks.save",
            json!({
                "ownerUserId": "owner",
                "targetKind": "thread",
                "targetId": thread_id,
                "mode": "live",
                "destinationPath": format!("bookmarks/{thread_id}.md"),
                "nowMs": now_ms,
            }),
        )
        .await;
        bookmark_ids.push(
            bookmark["bookmarkId"]
                .as_str()
                .expect("bookmark id")
                .to_owned(),
        );
    }

    for (method, params, row_key, id_key, expected) in [
        (
            "chats.channels.list",
            json!({}),
            "channels",
            "channelId",
            vec!["channel-1".to_owned(), "channel-2".to_owned()],
        ),
        (
            "chats.threads.list",
            json!({}),
            "threads",
            "threadId",
            vec!["thread-1".to_owned(), "thread-2".to_owned()],
        ),
        (
            "chats.follows.list",
            json!({ "ownerUserId": "owner" }),
            "follows",
            "targetId",
            vec!["thread-1".to_owned(), "thread-2".to_owned()],
        ),
        (
            "chats.bookmarks.list",
            json!({ "ownerUserId": "owner" }),
            "bookmarks",
            "bookmarkId",
            bookmark_ids.into_iter().rev().collect(),
        ),
    ] {
        let mut first_params = params.clone();
        first_params["pageLimit"] = json!(1);
        let first = call(&transport, &handle, &mut id, method, first_params).await;
        assert!(first.get("truncated").is_none());
        let cursor = first["nextCursor"]
            .as_str()
            .expect("first page continuation");
        let mut second_params = params;
        second_params["pageLimit"] = json!(1);
        second_params["cursor"] = json!(cursor);
        let second = call(&transport, &handle, &mut id, method, second_params).await;
        assert_eq!(second["nextCursor"], Value::Null);
        let actual = [first, second]
            .into_iter()
            .flat_map(|page| {
                page[row_key]
                    .as_array()
                    .expect("page rows")
                    .iter()
                    .map(|row| row[id_key].as_str().expect("row id").to_owned())
                    .collect::<Vec<_>>()
            })
            .collect::<Vec<_>>();
        assert_eq!(actual, expected, "{method} must return every row once");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn rpc_b2_page_adapter_drains_without_overlap_or_omission() {
    let scratch = ScratchDir::new().expect("scratch");
    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let handle = open_workspace(&transport, &scratch, 1, "rpc-b2-pages").await;
    let mut id = 10;
    for (trigger, created_at_ms) in [("b", 20), ("a", 20), ("old", 10)] {
        call(
            &transport,
            &handle,
            &mut id,
            "chats.dispatch.enqueue",
            json!({
                "triggerMessageId": trigger,
                "threadId": "thread",
                "nowMs": created_at_ms,
            }),
        )
        .await;
    }
    let mut cursor: Option<String> = None;
    let mut ids = Vec::new();
    loop {
        let mut params = json!({ "pageLimit": 1 });
        if let Some(cursor) = &cursor {
            params["cursor"] = json!(cursor);
        }
        let page = call(
            &transport,
            &handle,
            &mut id,
            "chats.dispatch.listPending",
            params,
        )
        .await;
        ids.extend(
            page["dispatches"]
                .as_array()
                .expect("dispatches")
                .iter()
                .map(|row| row["triggerMessageId"].as_str().expect("id").to_owned()),
        );
        cursor = page["nextCursor"].as_str().map(str::to_owned);
        if cursor.is_none() {
            break;
        }
    }
    // MUTATION: use inclusive/offset pagination -> rows overlap or disappear.
    assert_eq!(ids, ["old", "a", "b"]);

    let invalid_cursor = call_error(
        &transport,
        &handle,
        &mut id,
        "chats.dispatch.openRuns",
        json!({ "cursor": "eyJ2ZXJzaW9uIjoxfQ" }),
    )
    .await;
    assert_eq!(
        (invalid_cursor.code, invalid_cursor.message.as_str()),
        (ErrorCode::InvalidParams, "invalid-cursor")
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn rpc_b2_rejects_unknown_fields_and_null_optionals() {
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
    // MUTATION: remove deny_unknown/non-null optional decoders -> malformed calls enter domain.
    assert_eq!(
        (unknown.code, null_optional.code),
        (ErrorCode::InvalidParams, ErrorCode::InvalidParams)
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn rpc_b2_workspace_handle_overrides_spoofed_workspace_identity() {
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
    // MUTATION: trust a params workspace id -> caller can select foreign rows.
    assert_eq!(spoofed.code, ErrorCode::InvalidParams);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn rpc_b2_small_ports_round_trip_strict_shapes_and_recovery_mutations() {
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
    let db_path = scratch.engine_db_path().expect("db");
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
        json!({}),
    )
    .await;
    assert_eq!(unread["threads"][0]["id"], json!("thread"));
    let read = call(
        &transport,
        &handle,
        &mut id,
        "chats.agentReadState.markThreadRead",
        json!({ "threadId": "thread", "upTo": { "createdAtMs": 999, "messageId": "z" } }),
    )
    .await;
    assert_eq!(
        (
            read["lastReadCreatedAtMs"].as_i64(),
            read["lastReadMessageId"].as_str()
        ),
        (Some(10), Some("message"))
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
        json!({ "triggerMessageId": "trigger", "threadId": "thread", "nowMs": 20 }),
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
        json!({ "runId": "run", "command": "agent" }),
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
        json!({ "runId": "run", "command": "agent" }),
    )
    .await;
    assert_eq!(claim["run"]["runId"], json!("run"));
    assert!(claim["run"].get("endedAtMs").is_none());
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
        "chats.dispatch.listAppQuitRecoveries",
        json!({}),
    )
    .await;
    assert_eq!(recoveries["recoveries"][0]["attemptCount"], json!(1));
    let noted = call(
        &transport,
        &handle,
        &mut id,
        "chats.dispatch.markFailureNotePosted",
        json!({ "runId": "run" }),
    )
    .await;
    assert_eq!(noted["failureNotePosted"], json!(true));
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
        json!({ "threadId": "thread", "reason": "stop" }),
    )
    .await;
    // MUTATION: omit any Phase 2/3 registration or return legacy nullable fields -> roundtrip differs/fails.
    assert_eq!((requeued, failed_pending), (json!(true), json!(1)));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn thread_projection_matches_exact_markdown_bytes() {
    let scratch = ScratchDir::new().expect("scratch");
    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let handle = open_workspace(&transport, &scratch, 1, "rpc-b2-projection-bytes").await;
    let mut id = 10;
    call_with_idempotency(
        &transport,
        &handle,
        &mut id,
        "chats.threads.create",
        "projection-thread",
        json!({
            "threadId": "thread-projection",
            "title": "Project thread",
            "linkedFile": {
                "objectId": "object-1",
                "pathHint": "private/stored-hint.md"
            },
            "nowMs": 10
        }),
    )
    .await;
    for (message_id, kind, name, body, now_ms) in [
        (
            "human-message",
            "human",
            "Ada",
            "First line\nsecond line",
            20,
        ),
        ("agent-message", "agent", "Helper", "Agent body", 30),
    ] {
        call(
            &transport,
            &handle,
            &mut id,
            "chats.messages.send",
            json!({
                "threadId": "thread-projection",
                "messageId": message_id,
                "authorKind": kind,
                "authorDisplayName": name,
                "body": body,
                "nowMs": now_ms
            }),
        )
        .await;
    }
    let projection = call(
        &transport,
        &handle,
        &mut id,
        "chats.threads.getProjection",
        json!({
            "threadId": "thread-projection",
            "linkedFileAccess": {
                "kind": "allowed",
                "path": "docs/current.md"
            }
        }),
    )
    .await;
    let expected = "# Project thread\n\nRead-only chat projection.\n\n\
Linked file: docs/current.md\n\n## Ada\n\nFirst line\nsecond line\n\n\
## Helper (agent)\n\nAgent body\n";
    assert_eq!(projection["text"].as_str(), Some(expected));
    assert_eq!(projection["readOnly"], json!(true));
    assert_eq!(projection["threadId"], json!("thread-projection"));
    assert!(
        projection["path"]
            .as_str()
            .expect("projection path")
            .starts_with(".dohc/chats/v1-")
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn thread_projection_over_wire_limit_fails_without_partial_text() {
    let scratch = ScratchDir::new().expect("scratch");
    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let handle = open_workspace(&transport, &scratch, 1, "rpc-b2-projection-cap").await;
    let mut id = 10;
    call_with_idempotency(
        &transport,
        &handle,
        &mut id,
        "chats.threads.create",
        "projection-cap-thread",
        json!({
            "threadId": "thread-cap",
            "title": "Large thread",
            "linkedFile": { "objectId": "object-large" },
            "nowMs": 10
        }),
    )
    .await;
    call(
        &transport,
        &handle,
        &mut id,
        "chats.messages.send",
        json!({
            "threadId": "thread-cap",
            "messageId": "large-message",
            "authorKind": "human",
            "authorDisplayName": "Ada",
            "body": "x".repeat(50 * 1024),
            "nowMs": 20
        }),
    )
    .await;
    let error = call_error(
        &transport,
        &handle,
        &mut id,
        "chats.threads.getProjection",
        json!({ "threadId": "thread-cap" }),
    )
    .await;
    // MUTATION: truncate instead of refusing -> this call succeeds with partial Markdown.
    assert_eq!(
        (error.code, error.message.as_str()),
        (ErrorCode::LimitExceeded, "projection-exceeds-inband-limit")
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
async fn granular_chat_search_arm_preserves_header_mapping_and_cli_saturation() {
    let scratch = ScratchDir::new().expect("scratch");
    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let handle = open_workspace(&transport, &scratch, 1, "rpc-cli-granular-search").await;
    let mut id = 10;

    let mut conn =
        rusqlite::Connection::open(scratch.engine_db_path().expect("engine database path"))
            .expect("open database");
    let tx = conn.transaction().expect("begin FTS seed");
    {
        let mut insert = tx
            .prepare(
                "INSERT INTO engine_search_chat_messages_fts \
                 (workspace_id, thread_id, message_id, text) VALUES (?1, ?2, ?3, ?4)",
            )
            .expect("prepare FTS seed");
        insert
            .execute(rusqlite::params![
                "rpc-cli-granular-search",
                "thread-header",
                "__thread__",
                "needle header"
            ])
            .expect("insert header");
        for index in 0..50_000 {
            insert
                .execute(rusqlite::params![
                    "rpc-cli-granular-search",
                    format!("thread-{index}"),
                    format!("message-{index}"),
                    "needle"
                ])
                .expect("insert candidate");
        }
    }
    tx.commit().expect("commit FTS seed");
    drop(conn);

    let header = call(
        &transport,
        &handle,
        &mut id,
        "search.queryChatMessagesGranular",
        json!({ "query": "needle header", "limit": 10 }),
    )
    .await;
    assert_eq!(
        header,
        json!({
            "results": [{
                "threadId": "thread-header",
                "messageId": null,
                "text": "needle header",
            }],
            "saturated": false,
        })
    );
    assert_eq!(
        call(
            &transport,
            &handle,
            &mut id,
            "search.queryChatMessagesGranular",
            json!({ "query": "ne", "limit": 50_000 }),
        )
        .await,
        json!({
            "results": [],
            "saturated": false,
        })
    );

    let saturated = call(
        &transport,
        &handle,
        &mut id,
        "search.queryChatMessagesGranular",
        json!({ "query": "needle", "limit": 50_000 }),
    )
    .await;
    // MUTATION: return the 50,000 queried rows directly -> the response exceeds
    // the control-frame contract instead of telling the CLI to full-scan.
    assert_eq!(saturated["saturated"], json!(true));
    let results = saturated["results"].as_array().expect("candidate array");
    assert!(!results.is_empty());
    assert!(results.len() < 50_000);
    assert!(
        serde_json::to_vec(&saturated)
            .expect("serialize granular response")
            .len()
            < 1024 * 1024
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn unread_file_thread_arm_coalesces_missing_state_and_tracks_mutations() {
    let scratch = ScratchDir::new().expect("scratch");
    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let handle = open_workspace(&transport, &scratch, 1, "rpc-cli-unread-files").await;
    let mut id = 10;

    for (thread_id, object_id) in [
        ("unread-file", "object-unread"),
        ("empty-file", "object-empty"),
    ] {
        call_with_idempotency(
            &transport,
            &handle,
            &mut id,
            "chats.threads.create",
            thread_id,
            json!({
                "threadId": thread_id,
                "title": thread_id,
                "linkedFile": { "objectId": object_id },
                "nowMs": 10,
            }),
        )
        .await;
    }
    for (message_id, now_ms) in [("message-1", 20), ("message-2", 30)] {
        call(
            &transport,
            &handle,
            &mut id,
            "chats.messages.send",
            json!({
                "threadId": "unread-file",
                "messageId": message_id,
                "authorKind": "agent",
                "authorDisplayName": "Agent",
                "body": message_id,
                "nowMs": now_ms,
            }),
        )
        .await;
    }

    let absent_state = call(
        &transport,
        &handle,
        &mut id,
        "chats.readState.listUnreadFileThreads",
        json!({}),
    )
    .await;
    // MUTATION: use an inner read-state join or omit COALESCE(..., 0) -> this
    // unread thread with no read-state row disappears.
    assert_eq!(
        absent_state,
        json!([{
            "threadId": "unread-file",
            "messageCount": 2,
            "lastReadSequence": 0,
        }])
    );

    call(
        &transport,
        &handle,
        &mut id,
        "chats.readState.markThreadRead",
        json!({
            "threadId": "unread-file",
            "upToSequence": 1,
            "nowMs": 40,
        }),
    )
    .await;
    assert_eq!(
        call(
            &transport,
            &handle,
            &mut id,
            "chats.readState.listUnreadFileThreads",
            json!({}),
        )
        .await,
        json!([{
            "threadId": "unread-file",
            "messageCount": 2,
            "lastReadSequence": 1,
        }])
    );

    call(
        &transport,
        &handle,
        &mut id,
        "chats.readState.markThreadRead",
        json!({
            "threadId": "unread-file",
            "upToSequence": 2,
            "nowMs": 50,
        }),
    )
    .await;
    assert_eq!(
        call(
            &transport,
            &handle,
            &mut id,
            "chats.readState.listUnreadFileThreads",
            json!({}),
        )
        .await,
        json!([])
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn unread_file_threads_are_keyset_paginated() {
    let scratch = ScratchDir::new().expect("scratch");
    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let handle = open_workspace(&transport, &scratch, 1, "rpc-cli-unread-pages").await;
    let mut id = 10;

    for index in 1..=3 {
        let thread_id = format!("file-thread-{index}");
        call_with_idempotency(
            &transport,
            &handle,
            &mut id,
            "chats.threads.create",
            &format!("create-{thread_id}"),
            json!({
                "threadId": thread_id,
                "title": format!("File thread {index}"),
                "linkedFile": { "objectId": format!("object-{index}") },
                "nowMs": 10 + index,
            }),
        )
        .await;
        call_with_idempotency(
            &transport,
            &handle,
            &mut id,
            "chats.messages.send",
            &format!("send-{thread_id}"),
            json!({
                "threadId": thread_id,
                "messageId": format!("message-{index}"),
                "authorKind": "agent",
                "authorDisplayName": "Agent",
                "body": "unread",
                "nowMs": 20 + index,
            }),
        )
        .await;
    }

    let first = call(
        &transport,
        &handle,
        &mut id,
        "chats.readState.listUnreadFileThreads",
        json!({ "pageLimit": 2 }),
    )
    .await;
    assert_eq!(
        first
            .as_array()
            .expect("first unread page")
            .iter()
            .map(|row| row["threadId"].as_str().expect("thread id"))
            .collect::<Vec<_>>(),
        vec!["file-thread-1", "file-thread-2"],
        "the first response must stop at its bounded page size"
    );

    let second = call(
        &transport,
        &handle,
        &mut id,
        "chats.readState.listUnreadFileThreads",
        json!({
            "pageLimit": 2,
            "afterThreadId": "file-thread-2",
        }),
    )
    .await;
    assert_eq!(
        second
            .as_array()
            .expect("second unread page")
            .iter()
            .map(|row| row["threadId"].as_str().expect("thread id"))
            .collect::<Vec<_>>(),
        vec!["file-thread-3"],
        "the keyset coordinate must continue without overlap"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn unread_file_thread_arm_fails_closed_on_non_safe_read_state() {
    let scratch = ScratchDir::new().expect("scratch");
    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let handle = open_workspace(&transport, &scratch, 1, "rpc-cli-unread-corrupt").await;
    let mut id = 10;
    call_with_idempotency(
        &transport,
        &handle,
        &mut id,
        "chats.threads.create",
        "corrupt-file-thread",
        json!({
            "threadId": "corrupt-file-thread",
            "title": "Corrupt",
            "linkedFile": { "objectId": "object-corrupt" },
            "nowMs": 10,
        }),
    )
    .await;
    call(
        &transport,
        &handle,
        &mut id,
        "chats.messages.send",
        json!({
            "threadId": "corrupt-file-thread",
            "messageId": "message",
            "authorKind": "agent",
            "authorDisplayName": "Agent",
            "body": "message",
            "nowMs": 20,
        }),
    )
    .await;
    call(
        &transport,
        &handle,
        &mut id,
        "chats.readState.markThreadRead",
        json!({
            "threadId": "corrupt-file-thread",
            "upToSequence": 1,
            "nowMs": 30,
        }),
    )
    .await;

    let conn = rusqlite::Connection::open(scratch.engine_db_path().expect("engine database path"))
        .expect("open database");
    conn.execute(
        "UPDATE chat_thread_read_state SET last_read_sequence = ?1 \
         WHERE workspace_id = ?2 AND thread_id = ?3",
        rusqlite::params![
            9_007_199_254_740_992_i64,
            "rpc-cli-unread-corrupt",
            "corrupt-file-thread"
        ],
    )
    .expect("corrupt read state");
    drop(conn);

    let error = call_error(
        &transport,
        &handle,
        &mut id,
        "chats.readState.listUnreadFileThreads",
        json!({}),
    )
    .await;
    assert_eq!(error.code, ErrorCode::Internal);
    assert_eq!(error.message, "state-corrupt");
}
