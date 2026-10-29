//! A group's stream: where a new top-level message goes, and one listing of
//! posts and conversation messages in a single order.

use dohc_engine_domain::{
    AGENT_REPLY_EXCERPT_CHARS, ChatActorKind, ChatChannelKind, ChatThreadLane, LinkedChatStore,
    NoFaults, SendMessage, StartChannelThread, StreamAgentRequest, StreamAgentRequestState,
    StreamPage, StreamPosition,
};
use dohc_engine_storage::{EngineStore, StorageError};
use dohc_engine_testkit::{ScratchDir, engine_db_path};

const NO_FAULTS: NoFaults = NoFaults;
const WS: &str = "ws-stream";

fn store() -> (ScratchDir, EngineStore) {
    let scratch = ScratchDir::new().expect("scratch");
    let path = engine_db_path(&scratch).expect("db path");
    let store = EngineStore::open(&path, 1).expect("store");
    (scratch, store)
}

fn group(store: &mut EngineStore) {
    LinkedChatStore::new(store)
        .create_channel(WS, "group", "Team", ChatChannelKind::Channel, 1, &NO_FAULTS)
        .expect("group");
}

fn start_input(
    channel_id: &str,
    thread_id: &str,
    message_id: &str,
    lane: ChatThreadLane,
    at_ms: i64,
) -> StartChannelThread {
    StartChannelThread {
        automation: None,
        workspace_id: WS.to_owned(),
        channel_id: channel_id.to_owned(),
        thread_id: thread_id.to_owned(),
        message_id: message_id.to_owned(),
        title: None,
        lane,
        own_thread: false,
        author_kind: ChatActorKind::Agent,
        author_display_name: "Scout".to_owned(),
        author_owner_display_name: Some("Ada".to_owned()),
        author_user_id: Some("ada".to_owned()),
        origin: None,
        body: format!("opening {message_id}"),
        needs_decision: false,
        options: Vec::new(),
        attachments: Vec::new(),
        author_agent_id: None,
        named_agent_ids: Vec::new(),
        now_ms: at_ms,
        request_id: None,
    }
}

fn start(
    store: &mut EngineStore,
    channel_id: &str,
    thread_id: &str,
    message_id: &str,
    lane: ChatThreadLane,
    at_ms: i64,
) -> String {
    LinkedChatStore::new(store)
        .start_channel_thread(
            &start_input(channel_id, thread_id, message_id, lane, at_ms),
            &NO_FAULTS,
        )
        .expect("start")
        .0
        .thread_id
}

fn reply_input(thread_id: &str, message_id: &str, at_ms: i64) -> SendMessage {
    SendMessage {
        automation: None,
        workspace_id: WS.to_owned(),
        thread_id: thread_id.to_owned(),
        message_id: message_id.to_owned(),
        author_kind: ChatActorKind::Agent,
        author_display_name: "Scout".to_owned(),
        author_owner_display_name: Some("Ada".to_owned()),
        author_user_id: Some("ada".to_owned()),
        parent_message_id: None,
        origin: None,
        body: format!("reply {message_id}"),
        needs_decision: false,
        options: Vec::new(),
        attachments: Vec::new(),
        author_agent_id: None,
        named_agent_ids: Vec::new(),
        now_ms: at_ms,
        request_id: None,
    }
}

fn send(store: &mut EngineStore, input: SendMessage) {
    LinkedChatStore::new(store)
        .send_message(&input, &NO_FAULTS)
        .expect("send");
}

fn page(store: &mut EngineStore, before: Option<&StreamPosition>, limit: i64) -> StreamPage {
    LinkedChatStore::new(store)
        .list_group_stream(WS, "group", before, limit)
        .expect("stream")
}

fn ids(page: &StreamPage) -> Vec<String> {
    page.items
        .iter()
        .map(|item| item.message.message_id.clone())
        .collect()
}

#[test]
fn an_agent_dm_puts_every_new_message_in_its_one_conversation() {
    let (_scratch, mut store) = store();
    let agent = LinkedChatStore::new(&mut store)
        .ensure_agent_channel(WS, "agent", "default", "My agent", 1, &NO_FAULTS)
        .expect("agent dm");

    // A post asked for in an agent DM still joins the conversation.
    let first = start(
        &mut store,
        &agent.channel_id,
        "thread-a",
        "m-1",
        ChatThreadLane::Posts,
        10,
    );
    let second = start(
        &mut store,
        &agent.channel_id,
        "thread-b",
        "m-2",
        ChatThreadLane::Posts,
        11,
    );
    assert_eq!(first, "thread-a");
    assert_eq!(
        second, "thread-a",
        "the second message joins the first's conversation"
    );

    let found = LinkedChatStore::new(&mut store)
        .get_thread(WS, "thread-a")
        .expect("thread");
    assert_eq!(found.thread.lane, ChatThreadLane::Chat);
    assert_eq!(found.message_count, 2);
    assert_eq!(found.channel.expect("channel").kind, ChatChannelKind::Agent);

    let mut titled = start_input(
        &agent.channel_id,
        "thread-c",
        "m-3",
        ChatThreadLane::Posts,
        12,
    );
    titled.title = Some("Plan".to_owned());
    let refused = LinkedChatStore::new(&mut store)
        .start_channel_thread(&titled, &NO_FAULTS)
        .unwrap_err();
    assert_eq!(refused.code(), "invalid-thread-title");

    // A group keeps the lane it is asked for.
    group(&mut store);
    let post = start(
        &mut store,
        "group",
        "post-1",
        "p-1",
        ChatThreadLane::Posts,
        20,
    );
    let found = LinkedChatStore::new(&mut store)
        .get_thread(WS, &post)
        .expect("post");
    assert_eq!(found.thread.lane, ChatThreadLane::Posts);
}

#[test]
fn a_wake_into_an_agent_dm_keeps_its_own_thread_beside_the_conversation() {
    let (_scratch, mut store) = store();
    let agent = LinkedChatStore::new(&mut store)
        .ensure_agent_channel(WS, "agent", "default", "My agent", 1, &NO_FAULTS)
        .expect("agent dm");
    let conversation = start(
        &mut store,
        &agent.channel_id,
        "conversation",
        "m-1",
        ChatThreadLane::Chat,
        10,
    );

    let mut wake = start_input(
        &agent.channel_id,
        "wake-1",
        "w-1",
        ChatThreadLane::Posts,
        20,
    );
    wake.own_thread = true;
    wake.title = Some("Daily digest".to_owned());
    let woken = LinkedChatStore::new(&mut store)
        .start_channel_thread(&wake, &NO_FAULTS)
        .expect("wake")
        .0
        .thread_id;
    assert_eq!(woken, "wake-1", "the trigger's recorded thread exists");
    let found = LinkedChatStore::new(&mut store)
        .get_thread(WS, "wake-1")
        .expect("wake thread");
    assert_eq!(found.thread.lane, ChatThreadLane::Posts);
    assert_eq!(found.message_count, 1);

    // A person's next message still joins the conversation, not the wake.
    let next = start(
        &mut store,
        &agent.channel_id,
        "thread-b",
        "m-2",
        ChatThreadLane::Posts,
        30,
    );
    assert_eq!(next, conversation);
}

#[test]
fn the_stream_merges_both_lanes_in_one_order_and_pages_from_the_newest_end() {
    let (_scratch, mut store) = store();
    group(&mut store);
    // Posts at 10, 30, 50; conversation messages at 20, 30, 40. At 30 the post
    // sorts first.
    start(
        &mut store,
        "group",
        "post-10",
        "p-10",
        ChatThreadLane::Posts,
        10,
    );
    let chat = start(
        &mut store,
        "group",
        "chat",
        "c-20",
        ChatThreadLane::Chat,
        20,
    );
    start(
        &mut store,
        "group",
        "post-30",
        "p-30",
        ChatThreadLane::Posts,
        30,
    );
    send(&mut store, reply_input(&chat, "c-30", 30));
    send(&mut store, reply_input(&chat, "c-40", 40));
    start(
        &mut store,
        "group",
        "post-50",
        "p-50",
        ChatThreadLane::Posts,
        50,
    );

    let all = page(&mut store, None, 10);
    assert_eq!(ids(&all), ["p-10", "c-20", "p-30", "c-30", "c-40", "p-50"]);
    assert!(!all.has_older);

    let newest = page(&mut store, None, 4);
    assert_eq!(ids(&newest), ["p-30", "c-30", "c-40", "p-50"]);
    assert!(newest.has_older);
    let older = page(&mut store, Some(&newest.items[0].position), 4);
    assert_eq!(ids(&older), ["p-10", "c-20"]);
    assert!(!older.has_older);

    // A cursor on a conversation message in a millisecond that also holds a
    // post keeps that post.
    let from_chat = page(&mut store, Some(&newest.items[1].position), 10);
    assert_eq!(ids(&from_chat), ["p-10", "c-20", "p-30"]);

    for item in &all.items {
        assert_eq!(
            item.post.is_some(),
            item.position.lane == ChatThreadLane::Posts,
            "only posts carry a summary"
        );
    }
}

#[test]
fn the_stream_lists_only_top_level_conversation_messages_and_reads_every_conversation() {
    let (_scratch, mut store) = store();
    group(&mut store);
    let chat = start(
        &mut store,
        "group",
        "chat-a",
        "a-1",
        ChatThreadLane::Chat,
        10,
    );
    let mut parented = reply_input(&chat, "a-reply", 11);
    parented.parent_message_id = Some("a-1".to_owned());
    send(&mut store, parented);
    send(&mut store, reply_input(&chat, "a-2", 12));

    // A second conversation thread, as when two devices started it before they
    // synced, still shows its messages.
    store
        .write_with(&NO_FAULTS, |tx| {
            tx.execute(
                "INSERT INTO chat_threads (workspace_id, thread_id, title, created_at_ms, \
                 updated_at_ms, channel_id, lane) \
                 SELECT workspace_id, 'chat-b', title, 11, 11, channel_id, lane \
                 FROM chat_threads WHERE workspace_id = ?1 AND thread_id = 'chat-a'",
                [WS],
            )
            .map_err(StorageError::persist_public)?;
            Ok::<_, StorageError>(())
        })
        .expect("second conversation");
    send(&mut store, reply_input("chat-b", "b-1", 11));

    let all = page(&mut store, None, 10);
    assert_eq!(ids(&all), ["a-1", "b-1", "a-2"]);
}

#[test]
fn a_post_summarises_its_replies_repliers_agent_reply_and_open_decisions() {
    let (_scratch, mut store) = store();
    group(&mut store);
    let mut opening = start_input("group", "post", "open", ChatThreadLane::Posts, 10);
    opening.author_kind = ChatActorKind::Human;
    opening.author_display_name = "Ada".to_owned();
    opening.author_owner_display_name = None;
    LinkedChatStore::new(&mut store)
        .start_channel_thread(&opening, &NO_FAULTS)
        .expect("post");

    for (index, (name, kind)) in [
        ("Bo", ChatActorKind::Human),
        ("Cy", ChatActorKind::Human),
        ("Scout", ChatActorKind::Agent),
        ("Di", ChatActorKind::Human),
        ("Bo", ChatActorKind::Human),
    ]
    .into_iter()
    .enumerate()
    {
        let mut reply = reply_input("post", &format!("r-{index}"), 20 + index as i64);
        reply.author_kind = kind;
        reply.author_display_name = name.to_owned();
        reply.author_user_id = Some(name.to_lowercase());
        reply.author_owner_display_name = (kind == ChatActorKind::Agent).then(|| "Ada".to_owned());
        if kind == ChatActorKind::Agent {
            reply.body = "é".repeat(AGENT_REPLY_EXCERPT_CHARS + 20);
        }
        if name == "Di" {
            reply.needs_decision = true;
        }
        send(&mut store, reply);
    }

    let stream = page(&mut store, None, 10);
    assert_eq!(ids(&stream), ["open"]);
    let post = stream.items[0].post.as_ref().expect("post summary");
    assert_eq!(post.reply_count, 5);
    assert_eq!(post.last_reply_at_ms, Some(24));
    assert_eq!(
        post.repliers
            .iter()
            .map(|replier| replier.author_display_name.as_str())
            .collect::<Vec<_>>(),
        ["Bo", "Di", "Scout"],
        "distinct repliers, newest first, at most three"
    );
    let agent = post.latest_agent_reply.as_ref().expect("agent reply");
    assert_eq!(agent.message_id, "r-2");
    assert_eq!(agent.author_owner_display_name.as_deref(), Some("Ada"));
    assert_eq!(
        agent.body_excerpt.chars().count(),
        AGENT_REPLY_EXCERPT_CHARS
    );
    assert_eq!(post.open_decision_count, 1);
}

#[test]
fn a_post_keeps_link_repliers_with_the_same_name_apart() {
    let (_scratch, mut store) = store();
    group(&mut store);
    start(
        &mut store,
        "group",
        "post",
        "open",
        ChatThreadLane::Posts,
        10,
    );
    for (index, principal) in ["p-1", "p-2"].into_iter().enumerate() {
        let message_id = format!("link-{index}");
        let mut reply = reply_input("post", &message_id, 20 + index as i64);
        reply.author_kind = ChatActorKind::Human;
        reply.author_display_name = "Guest".to_owned();
        reply.author_owner_display_name = None;
        reply.author_user_id = None;
        send(&mut store, reply);
        // Only the relay writes a link message, so the test plants one.
        store
            .write_with(&NO_FAULTS, |tx| {
                tx.execute(
                    "UPDATE chat_messages SET author_kind = 'link', \
                     link_grant_id = 'grant-1', link_principal_id = ?2 \
                     WHERE workspace_id = ?1 AND message_id = ?3",
                    [WS, principal, &message_id],
                )
                .map_err(StorageError::persist_public)?;
                Ok::<_, StorageError>(())
            })
            .expect("link reply");
    }

    let stream = page(&mut store, None, 10);
    let post = stream.items[0].post.as_ref().expect("post summary");
    assert_eq!(
        post.repliers
            .iter()
            .map(|replier| {
                let link = replier.link_author.as_ref().expect("link author");
                (
                    replier.author_display_name.as_str(),
                    link.grant_id.as_str(),
                    link.principal_id.as_str(),
                )
            })
            .collect::<Vec<_>>(),
        [("Guest", "grant-1", "p-2"), ("Guest", "grant-1", "p-1")]
    );
}

#[test]
fn the_page_carries_the_newest_read_item_across_both_lanes() {
    let (_scratch, mut store) = store();
    group(&mut store);
    start(
        &mut store,
        "group",
        "post-10",
        "p-10",
        ChatThreadLane::Posts,
        10,
    );
    let chat = start(
        &mut store,
        "group",
        "chat",
        "c-20",
        ChatThreadLane::Chat,
        20,
    );
    let mut parented = reply_input(&chat, "c-21", 21);
    parented.parent_message_id = Some("c-20".to_owned());
    send(&mut store, parented);
    send(&mut store, reply_input(&chat, "c-30", 30));
    start(
        &mut store,
        "group",
        "post-40",
        "p-40",
        ChatThreadLane::Posts,
        40,
    );

    assert_eq!(page(&mut store, None, 10).read_position, None);

    LinkedChatStore::new(&mut store)
        .mark_thread_read(WS, "post-10", 1, None, 50, &NO_FAULTS)
        .expect("read post");
    assert_eq!(
        page(&mut store, None, 10).read_position.map(|p| p.id),
        Some("post-10".to_owned())
    );

    // Reading the conversation through its parented reply covers c-20 only.
    LinkedChatStore::new(&mut store)
        .mark_thread_read(WS, &chat, 2, None, 51, &NO_FAULTS)
        .expect("read chat");
    assert_eq!(
        page(&mut store, None, 10).read_position.map(|p| p.id),
        Some("c-20".to_owned())
    );

    LinkedChatStore::new(&mut store)
        .mark_thread_read(WS, "post-40", 1, None, 52, &NO_FAULTS)
        .expect("read newest post");
    let read = page(&mut store, None, 10).read_position.expect("read");
    assert_eq!(
        (read.lane, read.id.as_str()),
        (ChatThreadLane::Posts, "post-40")
    );
}

#[test]
fn the_stream_refuses_bad_limits_and_cursors() {
    let (_scratch, mut store) = store();
    group(&mut store);
    let chats = LinkedChatStore::new(&mut store);
    for limit in [0, 101] {
        assert_eq!(
            chats
                .list_group_stream(WS, "group", None, limit)
                .unwrap_err()
                .code(),
            "invalid-cursor"
        );
    }
    let empty_id = StreamPosition {
        created_at_ms: 1,
        lane: ChatThreadLane::Chat,
        id: String::new(),
    };
    assert_eq!(
        chats
            .list_group_stream(WS, "group", Some(&empty_id), 10)
            .unwrap_err()
            .code(),
        "invalid-cursor"
    );
    assert!(chats.list_group_stream(WS, "missing", None, 10).is_err());
}

#[test]
fn each_lane_reads_its_stream_index() {
    let (_scratch, mut store) = store();
    group(&mut store);
    store
        .read_with(|conn| {
            for (sql, index) in [
                (
                    "EXPLAIN QUERY PLAN SELECT t.created_at_ms, t.thread_id FROM chat_threads t \
                     WHERE t.workspace_id = 'w' AND t.channel_id = 'c' AND t.lane = 'posts' \
                       AND (t.created_at_ms, t.thread_id) < (1, 'x') \
                     ORDER BY t.created_at_ms DESC, t.thread_id DESC LIMIT 51",
                    "idx_chat_threads_channel_lane_created",
                ),
                (
                    "EXPLAIN QUERY PLAN SELECT created_at_ms, message_id FROM chat_messages \
                     WHERE workspace_id = 'w' AND thread_id = 't' AND parent_message_id IS NULL \
                       AND (created_at_ms, message_id) < (1, 'x') \
                     ORDER BY created_at_ms DESC, message_id DESC LIMIT 51",
                    "idx_chat_messages_thread_top_created",
                ),
            ] {
                let plan: Vec<String> = conn
                    .prepare(sql)?
                    .query_map([], |row| row.get::<_, String>(3))?
                    .collect::<Result<_, _>>()?;
                let plan = plan.join("\n");
                assert!(plan.contains(index), "{index} unused:\n{plan}");
                assert!(
                    !plan.contains("TEMP B-TREE"),
                    "the page sorts rows:\n{plan}"
                );
            }
            Ok::<_, rusqlite::Error>(())
        })
        .expect("plans");
}

#[test]
fn each_message_carries_its_open_agent_requests_in_the_stream_and_the_thread() {
    let (_scratch, mut store) = store();
    group(&mut store);
    let chat = start(
        &mut store,
        "group",
        "chat",
        "m-wait",
        ChatThreadLane::Chat,
        10,
    );
    for (id, at) in [
        ("m-run", 11),
        ("m-fail", 12),
        ("m-done", 13),
        ("m-joined", 14),
        ("m-crash", 15),
        ("m-silent", 16),
    ] {
        send(&mut store, reply_input(&chat, id, at));
    }
    store
        .write_with(&NO_FAULTS, |tx| {
            for (message, state, run) in [
                ("m-wait", "pending", None),
                ("m-run", "running", Some("run-live")),
                ("m-fail", "failed", Some("run-failed")),
                ("m-done", "done", Some("run-done")),
                ("m-joined", "done", Some("run-live")),
                ("m-crash", "done", Some("run-crash")),
                ("m-silent", "done", Some("run-silent")),
            ] {
                tx.execute(
                    "INSERT INTO chat_dispatch_ledger (workspace_id, trigger_message_id, \
                     agent_id, thread_id, state, run_id, failure_reason, attempt_count, \
                     created_at_ms, updated_at_ms) VALUES (?1, ?2, 'default', ?3, ?4, ?5, \
                     CASE ?4 WHEN 'failed' THEN 'no-reply' END, 1, 20, 20)",
                    rusqlite::params![WS, message, chat, state, run],
                )
                .map_err(StorageError::persist_public)?;
            }
            // Desktop marks a completed run's failure handled when it exited
            // nonzero or left no reply.
            for (run, trigger, ended, exit, log, handled) in [
                ("run-live", "m-run", None, None, None, false),
                (
                    "run-failed",
                    "m-fail",
                    Some(40),
                    Some(0),
                    Some("runs/failed.log"),
                    true,
                ),
                (
                    "run-done",
                    "m-done",
                    Some(41),
                    Some(0),
                    Some("runs/done.log"),
                    false,
                ),
                (
                    "run-crash",
                    "m-crash",
                    Some(42),
                    Some(7),
                    Some("runs/crash.log"),
                    true,
                ),
                (
                    "run-silent",
                    "m-silent",
                    Some(43),
                    Some(0),
                    Some("runs/silent.log"),
                    true,
                ),
            ] {
                tx.execute(
                    "INSERT INTO agent_run_records (workspace_id, run_id, thread_id, \
                     trigger_message_id, command, started_at_ms, ended_at_ms, exit_code, \
                     log_path, failure_handled) VALUES (?1, ?2, ?3, ?4, 'agent', 30, ?5, ?6, ?7, ?8)",
                    rusqlite::params![WS, run, chat, trigger, ended, exit, log, handled],
                )
                .map_err(StorageError::persist_public)?;
            }
            Ok::<_, StorageError>(())
        })
        .expect("requests");

    let expected = |id: &str| -> Vec<StreamAgentRequest> {
        let request = |state, run: Option<&str>| StreamAgentRequest {
            agent_id: "default".to_owned(),
            state,
            run_id: run.map(str::to_owned),
            started_at_ms: run.map(|_| 30),
            failure_reason: None,
            exit_code: None,
            log_path: None,
        };
        match id {
            "m-wait" => vec![request(StreamAgentRequestState::Waiting, None)],
            "m-run" | "m-joined" => {
                vec![request(StreamAgentRequestState::Running, Some("run-live"))]
            }
            "m-fail" => vec![StreamAgentRequest {
                failure_reason: Some("no-reply".to_owned()),
                exit_code: Some(0),
                log_path: Some("runs/failed.log".to_owned()),
                ..request(StreamAgentRequestState::Failed, Some("run-failed"))
            }],
            "m-crash" => vec![StreamAgentRequest {
                exit_code: Some(7),
                log_path: Some("runs/crash.log".to_owned()),
                ..request(StreamAgentRequestState::Failed, Some("run-crash"))
            }],
            "m-silent" => vec![StreamAgentRequest {
                failure_reason: Some("no-reply".to_owned()),
                exit_code: Some(0),
                log_path: Some("runs/silent.log".to_owned()),
                ..request(StreamAgentRequestState::Failed, Some("run-silent"))
            }],
            _ => Vec::new(),
        }
    };

    let stream = page(&mut store, None, 10);
    assert_eq!(stream.items.len(), 7);
    for item in &stream.items {
        assert_eq!(item.agent_requests, expected(&item.message.message_id));
    }
    let thread = LinkedChatStore::new(&mut store)
        .list_messages(WS, &chat, 10, None)
        .expect("thread");
    for message in &thread.messages {
        assert_eq!(
            thread
                .agent_requests
                .get(&message.message_id)
                .cloned()
                .unwrap_or_default(),
            expected(&message.message_id)
        );
    }
}

#[test]
fn a_message_that_names_two_agents_shows_each_agents_own_request() {
    let (_scratch, mut store) = store();
    group(&mut store);
    let chat = start(
        &mut store,
        "group",
        "chat",
        "m-open",
        ChatThreadLane::Chat,
        10,
    );
    send(
        &mut store,
        SendMessage {
            author_kind: ChatActorKind::Human,
            author_display_name: "Ada".to_owned(),
            author_owner_display_name: None,
            named_agent_ids: vec!["research".to_owned(), "default".to_owned()],
            ..reply_input(&chat, "m-both", 11)
        },
    );
    let claim = LinkedChatStore::new(&mut store)
        .claim_next_pending(WS, "run-1", "agent", None, 12, &NO_FAULTS)
        .expect("claim")
        .expect("a request to claim");
    let other = if claim.run.agent_id == "default" {
        "research"
    } else {
        "default"
    };
    let request = |agent_id: &str| {
        let running = agent_id == claim.run.agent_id;
        StreamAgentRequest {
            agent_id: agent_id.to_owned(),
            state: if running {
                StreamAgentRequestState::Running
            } else {
                StreamAgentRequestState::Waiting
            },
            run_id: running.then(|| "run-1".to_owned()),
            started_at_ms: running.then_some(12),
            failure_reason: None,
            exit_code: None,
            log_path: None,
        }
    };
    // One request per agent, in agent id order. The run is the claimed
    // agent's alone, so the other agent still waits.
    let mut expected = vec![request(&claim.run.agent_id), request(other)];
    expected.sort_by(|left, right| left.agent_id.cmp(&right.agent_id));

    let stream = page(&mut store, None, 10);
    let both = stream
        .items
        .iter()
        .find(|item| item.message.message_id == "m-both")
        .expect("the message");
    assert_eq!(both.agent_requests, expected);
    let thread = LinkedChatStore::new(&mut store)
        .list_messages(WS, &chat, 10, None)
        .expect("thread");
    assert_eq!(thread.agent_requests.get("m-both"), Some(&expected));
}

/// Times a group's stream over 10,000 items, with and without the stream
/// indexes. Run it in release:
/// `cargo test --release -p dohc-engine-domain --test chats_stream -- --ignored --nocapture stream_timings`
#[test]
#[ignore = "timing, run by hand"]
fn stream_timings() {
    use std::time::{Duration, Instant};

    const ITEMS: i64 = 10_000;
    const RUNS: usize = 25;

    fn median(store: &mut EngineStore, before: Option<&StreamPosition>) -> Duration {
        let mut times: Vec<Duration> = (0..RUNS)
            .map(|_| {
                let started = Instant::now();
                let page = page(store, before, 50);
                let elapsed = started.elapsed();
                assert_eq!(page.items.len(), 50);
                elapsed
            })
            .collect();
        times.sort();
        times[RUNS / 2]
    }

    fn time(name: &str, store: &mut EngineStore, items: i64) {
        // An older page starts halfway back.
        let mut before: Option<StreamPosition> = None;
        for _ in 0..items / 2 / 100 {
            before = Some(page(store, before.as_ref(), 100).items[0].position.clone());
        }
        let older = before.expect("an older page");
        let indexed = (median(store, None), median(store, Some(&older)));
        let dropped = store
            .write_with(&NO_FAULTS, |tx| {
                tx.execute_batch(
                    "DROP INDEX idx_chat_threads_channel_lane_created; \
                     DROP INDEX idx_chat_messages_thread_top_created;",
                )
                .map_err(StorageError::persist_public)?;
                Ok::<_, StorageError>(())
            })
            .expect("drop indexes");
        assert!(matches!(
            dropped,
            dohc_engine_storage::TxnOutcome::Committed(())
        ));
        let unindexed = (median(store, None), median(store, Some(&older)));
        println!(
            "{name}: first page {:?} without the indexes, {:?} with; older page {:?} without, {:?} with",
            unindexed.0, indexed.0, unindexed.1, indexed.1
        );
    }

    // 10,000 posts, each with two replies.
    {
        let (_scratch, mut store) = store();
        group(&mut store);
        for index in 0..ITEMS {
            let thread = start(
                &mut store,
                "group",
                &format!("post-{index:05}"),
                &format!("p-{index:05}"),
                ChatThreadLane::Posts,
                index * 10,
            );
            for reply in 0..2 {
                send(
                    &mut store,
                    reply_input(
                        &thread,
                        &format!("r-{index:05}-{reply}"),
                        index * 10 + reply + 1,
                    ),
                );
            }
        }
        time("posts", &mut store, ITEMS);
    }

    // One conversation of 10,000 messages.
    {
        let (_scratch, mut store) = store();
        group(&mut store);
        let chat = start(
            &mut store,
            "group",
            "chat",
            "c-00000",
            ChatThreadLane::Chat,
            0,
        );
        for index in 1..ITEMS {
            send(
                &mut store,
                reply_input(&chat, &format!("c-{index:05}"), index * 10),
            );
        }
        time("conversation messages", &mut store, ITEMS);
    }

    // A conversation of 1,000 messages with 10,000 replies under them.
    {
        let (_scratch, mut store) = store();
        group(&mut store);
        let chat = start(
            &mut store,
            "group",
            "chat",
            "c-00000",
            ChatThreadLane::Chat,
            0,
        );
        for index in 1..1_000 {
            send(
                &mut store,
                reply_input(&chat, &format!("c-{index:05}"), index * 100),
            );
        }
        for index in 0..ITEMS {
            let parent = index % 1_000;
            send(
                &mut store,
                SendMessage {
                    parent_message_id: Some(format!("c-{parent:05}")),
                    ..reply_input(
                        &chat,
                        &format!("r-{index:05}"),
                        parent * 100 + 1 + index / 1_000,
                    )
                },
            );
        }
        time("a conversation with many replies", &mut store, 1_000);
    }
}
