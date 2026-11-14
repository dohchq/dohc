use dohc_engine_domain::chats::MAX_REPORTED_AGENT_CHARS;
use dohc_engine_domain::{
    BookmarkMode, BookmarkTargetKind, ChannelGroup, ChatActorKind, ChatChannelKind,
    ChatChannelType, ChatDecisionState, ChatMessageAutomation, ChatReactionState,
    ChatReportedAgent, ChatThreadLane, CreateFileThread, DomainError, FeedCursorValue, FollowState,
    FollowTargetKind, GENERAL_CHANNEL_WIRE_ID, LinkedChatStore, LocalAttachmentInput,
    MarkAccountThreadRead, MarkThreadRead, NoFaults, ResolveDecision, SaveBookmark, SendMessage,
    SetFollow, SetReaction, StartChannelThread, channel_slug_for_name, decode_feed_cursor,
    encode_feed_cursor,
};
use dohc_engine_storage::{EngineStore, FaultPoint, StorageError};
use dohc_engine_testkit::{ScratchDir, ScriptedFaults, engine_db_path};
use serde_json::json;

const NO_FAULTS: NoFaults = NoFaults;
const WS: &str = "ws-1";

fn open(db: &std::path::Path, now: i64) -> EngineStore {
    EngineStore::open(db, now).expect("open")
}

fn start_thread(
    channel_id: &str,
    thread_id: &str,
    message_id: &str,
    body: &str,
    kind: ChatActorKind,
    now: i64,
) -> StartChannelThread {
    StartChannelThread {
        automation: None,
        workspace_id: WS.to_owned(),
        channel_id: channel_id.to_owned(),
        thread_id: thread_id.to_owned(),
        message_id: message_id.to_owned(),
        title: None,
        lane: ChatThreadLane::Posts,
        own_thread: false,
        author_kind: kind,
        author_display_name: "Ada".to_owned(),
        author_owner_display_name: None,
        author_user_id: Some("user-ada".to_owned()),
        origin: None,
        body: body.to_owned(),
        needs_decision: false,
        options: Vec::new(),
        attachments: Vec::new(),
        now_ms: now,
        request_id: None,
        author_agent_id: None,
        author_reported: None,
        work: None,
        wake_agent_ids: Vec::new(),
    }
}

fn read_mark(
    thread_id: &str,
    up_to_sequence: i64,
    expected_revision: Option<i64>,
    replication_owner_user_id: Option<&str>,
    now_ms: i64,
) -> MarkThreadRead {
    MarkThreadRead {
        workspace_id: WS.to_owned(),
        thread_id: thread_id.to_owned(),
        up_to_sequence,
        expected_revision,
        replication_owner_user_id: replication_owner_user_id.map(str::to_owned),
        now_ms,
    }
}

fn send_msg(
    thread_id: &str,
    message_id: &str,
    parent: Option<&str>,
    body: &str,
    now: i64,
) -> SendMessage {
    SendMessage {
        automation: None,
        workspace_id: WS.to_owned(),
        thread_id: thread_id.to_owned(),
        message_id: message_id.to_owned(),
        author_kind: ChatActorKind::Human,
        author_display_name: "Ada".to_owned(),
        author_owner_display_name: None,
        author_user_id: Some("user-ada".to_owned()),
        parent_message_id: parent.map(str::to_owned),
        origin: None,
        body: body.to_owned(),
        needs_decision: false,
        options: Vec::new(),
        attachments: Vec::new(),
        now_ms: now,
        request_id: None,
        author_agent_id: None,
        author_reported: None,
        work: None,
        wake_agent_ids: Vec::new(),
    }
}

#[test]
fn a_group_keeps_its_type_purpose_and_folder_and_journals_them() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = engine_db_path(&scratch).expect("db");
    let mut store = open(&db, 1);
    let mut chats = LinkedChatStore::new(&mut store);

    let group = chats
        .create_group(
            WS,
            "trip",
            "Lisbon trip",
            ChatChannelKind::Channel,
            ChannelGroup {
                channel_type: ChatChannelType::Both,
                purpose: "  Dates, flights, the flat.  ".to_owned(),
                folder_path: Some("trips/lisbon".to_owned()),
            },
            10,
            &NO_FAULTS,
        )
        .expect("create group");
    assert_eq!(group.group.channel_type, ChatChannelType::Both);
    assert_eq!(group.group.purpose, "Dates, flights, the flat.");
    assert_eq!(group.group.folder_path.as_deref(), Some("trips/lisbon"));

    let listed = chats.list_channels(WS).expect("list");
    assert_eq!(listed[0].channel.group, group.group);
    let found = chats
        .find_channel_by_slug(WS, "lisbon-trip")
        .expect("find")
        .expect("present");
    assert_eq!(found.group, group.group);

    let plain = chats
        .create_channel(
            WS,
            "plain",
            "Plain",
            ChatChannelKind::Channel,
            11,
            &NO_FAULTS,
        )
        .expect("create plain");
    assert_eq!(plain.group, ChannelGroup::default());

    let err = chats
        .create_group(
            WS,
            "dm",
            "someone@example.test",
            ChatChannelKind::Dm,
            ChannelGroup {
                folder_path: Some("people/someone".to_owned()),
                ..ChannelGroup::default()
            },
            12,
            &NO_FAULTS,
        )
        .expect_err("a dm has no folder");
    assert_eq!(err.code(), "invalid-channel-folder");

    for bad in [
        "../up",
        "/abs",
        "a//b",
        "a/./b",
        ".dohc/chats",
        ".git/config",
        "a/%2e%2e/b",
        "a/%2e/b",
        " team",
        "team ",
    ] {
        let err = chats
            .create_group(
                WS,
                &format!("bad-{}", bad.len()),
                &format!("Bad {}", bad.len()),
                ChatChannelKind::Channel,
                ChannelGroup {
                    folder_path: Some(bad.to_owned()),
                    ..ChannelGroup::default()
                },
                13,
                &NO_FAULTS,
            )
            .expect_err("bad folder");
        assert_eq!(err.code(), "invalid-channel-folder", "{bad}");
    }

    // The create op carries the group so a replica draws it the same way.
    let payload: String = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT payload_json FROM replication_log \
                 WHERE workspace_id = ?1 AND op_kind = 'chat.channel.create' \
                 ORDER BY origin_seq LIMIT 1",
                [WS],
                |row| row.get(0),
            )
            .map_err(StorageError::corrupt_public)
        })
        .expect("journaled create");
    let payload: serde_json::Value = serde_json::from_str(&payload).expect("json");
    assert_eq!(payload["type"], "both");
    assert_eq!(payload["purpose"], "Dates, flights, the flat.");
    assert_eq!(payload["folderPath"], "trips/lisbon");
}

#[test]
fn a_chat_lane_thread_stays_out_of_the_post_list_and_the_feed() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = engine_db_path(&scratch).expect("db");
    let mut store = open(&db, 1);
    let mut chats = LinkedChatStore::new(&mut store);
    chats
        .create_channel(
            WS,
            "chan-1",
            "General",
            ChatChannelKind::Channel,
            10,
            &NO_FAULTS,
        )
        .expect("channel");
    chats
        .ensure_default_channel_follows(WS, "user-ada", &NO_FAULTS)
        .expect("follows");

    let post = start_thread(
        "chan-1",
        "post-1",
        "post-msg",
        "A post",
        ChatActorKind::Human,
        20,
    );
    chats.start_channel_thread(&post, &NO_FAULTS).expect("post");
    let mut lane = start_thread(
        "chan-1",
        "lane-1",
        "lane-msg",
        "hey",
        ChatActorKind::Human,
        30,
    );
    lane.lane = ChatThreadLane::Chat;
    let (started, _) = chats
        .start_channel_thread(&lane, &NO_FAULTS)
        .expect("chat lane");
    assert_eq!(started.lane, ChatThreadLane::Chat);

    let posts = chats
        .list_channel_threads(WS, "chan-1", None, 10)
        .expect("posts");
    assert_eq!(
        posts
            .iter()
            .map(|row| row.thread.thread_id.as_str())
            .collect::<Vec<_>>(),
        vec!["post-1"]
    );
    let chat = chats
        .list_channel_threads_in_lane(WS, "chan-1", ChatThreadLane::Chat, None, 10)
        .expect("chat lane");
    assert_eq!(
        chat.iter()
            .map(|row| row.thread.thread_id.as_str())
            .collect::<Vec<_>>(),
        vec!["lane-1"]
    );
    assert_eq!(chat[0].thread.lane, ChatThreadLane::Chat);

    let feed = chats
        .list_personal_feed(WS, "user-ada", Some(10), None)
        .expect("feed");
    assert_eq!(
        feed.items
            .iter()
            .map(|item| item.thread.thread_id.as_str())
            .collect::<Vec<_>>(),
        vec!["post-1"]
    );

    let payload: String = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT payload_json FROM replication_log                  WHERE workspace_id = ?1 AND op_kind = 'chat.thread.create'                  ORDER BY origin_seq DESC LIMIT 1",
                [WS],
                |row| row.get(0),
            )
            .map_err(StorageError::corrupt_public)
        })
        .expect("journaled thread");
    let payload: serde_json::Value = serde_json::from_str(&payload).expect("json");
    assert_eq!(payload["lane"], "chat");
}

#[test]
fn a_poll_carries_its_choices_and_the_answer_names_one() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = engine_db_path(&scratch).expect("db");
    let mut store = open(&db, 1);
    let mut chats = LinkedChatStore::new(&mut store);
    chats
        .create_channel(
            WS,
            "chan-1",
            "General",
            ChatChannelKind::Channel,
            10,
            &NO_FAULTS,
        )
        .expect("channel");
    let mut question = start_thread(
        "chan-1",
        "poll-1",
        "poll-msg",
        "Which fare?",
        ChatActorKind::Agent,
        20,
    );
    question.options = vec![" 7am direct ".to_owned(), "2pm with a stop".to_owned()];
    chats
        .start_channel_thread(&question, &NO_FAULTS)
        .expect("poll");

    let open = chats
        .list_thread_decisions(WS, "poll-1", None, 10)
        .expect("decisions");
    assert_eq!(open.len(), 1);
    assert_eq!(open[0].state, ChatDecisionState::Open);
    assert_eq!(open[0].options, vec!["7am direct", "2pm with a stop"]);
    assert_eq!(open[0].chosen_option, None);

    for bad in [
        vec!["a".to_owned(), "a".to_owned()],
        vec!["".to_owned()],
        vec!["💥".repeat(101)],
        (0..13).map(|n| n.to_string()).collect::<Vec<_>>(),
    ] {
        let mut attempt = start_thread(
            "chan-1",
            &format!("bad-{}", bad.len()),
            &format!("bad-msg-{}", bad.len()),
            "?",
            ChatActorKind::Agent,
            21,
        );
        attempt.options = bad;
        let err = chats
            .start_channel_thread(&attempt, &NO_FAULTS)
            .expect_err("bad options");
        assert_eq!(err.code(), "invalid-poll-options");
    }

    let answer = send_msg(
        "poll-1",
        "answer-msg",
        Some("poll-msg"),
        "The early one.",
        30,
    );
    chats.send_message(&answer, &NO_FAULTS).expect("answer");
    let resolve = |chosen: Option<&str>, request: &str| ResolveDecision {
        workspace_id: WS.to_owned(),
        thread_id: "poll-1".to_owned(),
        message_id: "poll-msg".to_owned(),
        resolved_by_message_id: "answer-msg".to_owned(),
        chosen_option: chosen.map(str::to_owned),
        now_ms: 31,
        request_id: request.to_owned(),
    };
    let err = chats
        .resolve_decision(&resolve(None, "r-none"), &NO_FAULTS)
        .expect_err("a poll needs a choice");
    assert_eq!(err.code(), "invalid-poll-choice");
    let err = chats
        .resolve_decision(&resolve(Some("noon"), "r-noon"), &NO_FAULTS)
        .expect_err("not a choice");
    assert_eq!(err.code(), "invalid-poll-choice");
    let resolved = chats
        .resolve_decision(&resolve(Some("7am direct"), "r-ok"), &NO_FAULTS)
        .expect("answered");
    assert_eq!(resolved.state, ChatDecisionState::Resolved);
    assert_eq!(resolved.chosen_option.as_deref(), Some("7am direct"));
    assert_eq!(resolved.options, vec!["7am direct", "2pm with a stop"]);

    let payloads: Vec<String> = store
        .read_with(|conn| {
            let mut stmt = conn
                .prepare(
                    "SELECT payload_json FROM replication_log \
                     WHERE workspace_id = ?1 AND op_kind = 'chat.decision.set' \
                     ORDER BY origin_seq",
                )
                .map_err(StorageError::corrupt_public)?;
            let rows = stmt
                .query_map([WS], |row| row.get::<_, String>(0))
                .map_err(StorageError::corrupt_public)?;
            rows.collect::<rusqlite::Result<Vec<_>>>()
                .map_err(StorageError::corrupt_public)
        })
        .expect("journaled decisions");
    let last: serde_json::Value =
        serde_json::from_str(payloads.last().expect("one")).expect("json");
    assert_eq!(last["state"], "resolved");
    assert_eq!(
        last["options"],
        serde_json::json!(["7am direct", "2pm with a stop"])
    );
    assert_eq!(last["chosenOption"], "7am direct");
}

#[test]
fn posting_commenting_and_reacting_follow_the_thread_implicitly() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = engine_db_path(&scratch).expect("db");
    let mut store = open(&db, 1);
    let mut chats = LinkedChatStore::new(&mut store);
    chats
        .create_channel(
            WS,
            "chan-1",
            "General",
            ChatChannelKind::Channel,
            10,
            &NO_FAULTS,
        )
        .expect("channel");

    let post = start_thread(
        "chan-1",
        "post-1",
        "post-msg",
        "A post",
        ChatActorKind::Human,
        20,
    );
    chats.start_channel_thread(&post, &NO_FAULTS).expect("post");
    let follows = |chats: &LinkedChatStore<'_>, owner: &str| {
        chats
            .list_follows(WS, owner, Some("following"))
            .expect("follows")
            .into_iter()
            .filter(|f| f.target_kind == FollowTargetKind::Thread)
            .map(|f| f.target_id)
            .collect::<Vec<_>>()
    };
    assert_eq!(follows(&chats, "user-ada"), vec!["post-1"]);

    let mut comment = send_msg("post-1", "comment-msg", Some("post-msg"), "Nice", 30);
    comment.author_user_id = Some("user-bob".to_owned());
    chats.send_message(&comment, &NO_FAULTS).expect("comment");
    assert_eq!(follows(&chats, "user-bob"), vec!["post-1"]);

    chats
        .set_reaction(
            &SetReaction {
                workspace_id: WS.to_owned(),
                thread_id: "post-1".to_owned(),
                message_id: "post-msg".to_owned(),
                emoji: "👍".to_owned(),
                author_id: "user-cy".to_owned(),
                replication_author_id: Some("user-cy".to_owned()),
                author_kind: ChatActorKind::Human,
                author_display_name: "Cy".to_owned(),
                state: ChatReactionState::Added,
                now_ms: 40,
                request_id: "react-1".to_owned(),
            },
            &NO_FAULTS,
        )
        .expect("react");
    assert_eq!(follows(&chats, "user-cy"), vec!["post-1"]);

    let mut agent = send_msg("post-1", "agent-msg", None, "On it.", 50);
    agent.author_kind = ChatActorKind::Agent;
    agent.author_user_id = Some("user-ada".to_owned());
    chats.send_message(&agent, &NO_FAULTS).expect("agent reply");
    let mut local = send_msg("post-1", "local-msg", None, "offline", 60);
    local.author_user_id = None;
    chats.send_message(&local, &NO_FAULTS).expect("local reply");
    assert_eq!(follows(&chats, "user-ada"), vec!["post-1"]);

    chats
        .set_follow(
            &SetFollow {
                workspace_id: WS.to_owned(),
                owner_user_id: "user-bob".to_owned(),
                replication_owner_user_id: Some("user-bob".to_owned()),
                target_kind: FollowTargetKind::Thread,
                target_id: "post-1".to_owned(),
                state: FollowState::Unfollowed,
                now_ms: 70,
            },
            &NO_FAULTS,
        )
        .expect("unfollow");
    let mut again = send_msg("post-1", "comment-2", None, "Still here", 80);
    again.author_user_id = Some("user-bob".to_owned());
    chats
        .send_message(&again, &NO_FAULTS)
        .expect("comment again");
    assert!(follows(&chats, "user-bob").is_empty());

    let journaled: i64 = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM replication_log \
                 WHERE workspace_id = ?1 AND op_kind = 'chat.follow.set'",
                [WS],
                |row| row.get(0),
            )
            .map_err(StorageError::corrupt_public)
        })
        .expect("journaled follows");
    assert_eq!(journaled, 4, "three implicit follows and one unfollow");
}

#[test]
fn an_automation_posts_only_with_its_automation_and_keeps_it_on_this_computer() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = engine_db_path(&scratch).expect("db");
    let mut store = open(&db, 1);
    let mut chats = LinkedChatStore::new(&mut store);
    chats
        .ensure_general_channel(WS, "gen-1", 10, &NO_FAULTS)
        .expect("gen");
    let stamp = ChatMessageAutomation {
        automation_id: "collection:object-tasks#stamp".to_owned(),
        chain_depth: 1,
    };
    let automated =
        |message_id: &str, automation: Option<ChatMessageAutomation>| StartChannelThread {
            author_display_name: "Stamp the finish date".to_owned(),
            author_owner_display_name: Some("Ice".to_owned()),
            automation,
            ..start_thread(
                "gen-1",
                &format!("t-{message_id}"),
                message_id,
                "Done @ana",
                ChatActorKind::Automation,
                20,
            )
        };
    let named = |automation_id: &str, chain_depth: u32| {
        Some(ChatMessageAutomation {
            automation_id: automation_id.to_owned(),
            chain_depth,
        })
    };
    let refusals = [
        (
            automated("m0", None),
            "an automation message must name its automation",
        ),
        (
            StartChannelThread {
                automation: Some(stamp.clone()),
                ..start_thread("gen-1", "t-h", "m-h", "Hi", ChatActorKind::Human, 20)
            },
            "only an automation message names an automation",
        ),
        (
            StartChannelThread {
                automation: Some(stamp.clone()),
                ..start_thread("gen-1", "t-a", "m-a", "Hi", ChatActorKind::Agent, 20)
            },
            "only an automation message names an automation",
        ),
        (
            automated("m1", named("other:hello/triage", 1)),
            "automation id must be collection:<collection id>#<id>",
        ),
        (
            automated("m1", named("collection:Trip/Tasks", 1)),
            "automation id must be collection:<collection id>#<id>",
        ),
        (
            automated("m1", named("collection:#stamp", 1)),
            "automation id must be collection:<collection id>#<id>",
        ),
        (
            automated("m1", named("collection:object-tasks#", 1)),
            "automation id must be collection:<collection id>#<id>",
        ),
        (
            automated("m1", named(" collection:object-tasks#stamp", 1)),
            "automation id must be collection:<collection id>#<id>",
        ),
        (
            automated("m1", named("collection:object-tasks#stamp", 0)),
            "automation chain depth is invalid",
        ),
        (
            automated("m1", named("collection:../Secrets#stamp", 1)),
            "automation id must be collection:<collection id>#<id>",
        ),
        (
            automated("m1", named("collection:Trip/../../etc#stamp", 1)),
            "automation id must be collection:<collection id>#<id>",
        ),
        (
            automated("m1", named("collection:/etc/Tasks#stamp", 1)),
            "automation id must be collection:<collection id>#<id>",
        ),
        (
            automated("m1", named("collection:C:/Users/Tasks#stamp", 1)),
            "automation id must be collection:<collection id>#<id>",
        ),
        (
            automated("m1", named("collection:c:Tasks#stamp", 1)),
            "automation id must be collection:<collection id>#<id>",
        ),
        (
            automated("m1", named("collection:Trip\\Tasks#stamp", 1)),
            "automation id must be collection:<collection id>#<id>",
        ),
        (
            automated("m1", named("collection:Trip//Tasks#stamp", 1)),
            "automation id must be collection:<collection id>#<id>",
        ),
        (
            automated("m1", named("collection:./Tasks#stamp", 1)),
            "automation id must be collection:<collection id>#<id>",
        ),
        (
            automated("m1", named("collection:object-tasks#stamp", 65)),
            "automation chain depth is invalid",
        ),
    ];
    for (input, expected) in refusals {
        match chats.start_channel_thread(&input, &NO_FAULTS) {
            Err(DomainError::InvalidInput { reason }) => assert_eq!(reason, expected),
            other => panic!("expected {expected:?}, got {other:?}"),
        }
    }
    let human_owner = start_thread("gen-1", "t-o", "m-o", "Hi", ChatActorKind::Human, 20);
    let human_owner = StartChannelThread {
        author_owner_display_name: Some("Ice".to_owned()),
        ..human_owner
    };
    assert!(
        chats
            .start_channel_thread(&human_owner, &NO_FAULTS)
            .is_err(),
        "a human message names no owner"
    );

    let (_, opening) = chats
        .start_channel_thread(&automated("m1", Some(stamp.clone())), &NO_FAULTS)
        .expect("the executor posts");
    assert_eq!(opening.author_kind, ChatActorKind::Automation);
    assert_eq!(opening.author_owner_display_name.as_deref(), Some("Ice"));
    assert_eq!(opening.automation, Some(stamp.clone()));
    assert_eq!(
        chats
            .read_state(WS, "t-m1")
            .expect("read state")
            .last_read_sequence,
        0
    );

    let deeper = ChatMessageAutomation {
        chain_depth: 2,
        ..stamp.clone()
    };
    let reply = SendMessage {
        author_kind: ChatActorKind::Automation,
        author_display_name: "Stamp the finish date".to_owned(),
        author_owner_display_name: Some("Ice".to_owned()),
        automation: Some(deeper.clone()),
        ..send_msg("t-m1", "m2", Some("m1"), "Again", 30)
    };
    assert_eq!(
        chats
            .send_message(&reply, &NO_FAULTS)
            .expect("reply")
            .automation,
        Some(deeper.clone())
    );
    let unnamed = SendMessage {
        automation: None,
        ..reply.clone()
    };
    assert!(matches!(
        chats.send_message(&unnamed, &NO_FAULTS),
        Err(DomainError::InvalidInput {
            reason: "an automation message must name its automation"
        })
    ));
    let page = chats.list_messages(WS, "t-m1", 10, None).expect("messages");
    let read: Vec<_> = page
        .messages
        .iter()
        .map(|message| {
            (
                message.message_id.as_str(),
                message.author_kind,
                message.automation.clone(),
            )
        })
        .collect();
    assert_eq!(
        read,
        vec![
            ("m1", ChatActorKind::Automation, Some(stamp.clone())),
            ("m2", ChatActorKind::Automation, Some(deeper))
        ]
    );
    let mentions = chats
        .list_mentions_for_handle(WS, "ana", None, 10)
        .expect("mentions");
    assert_eq!(
        mentions
            .iter()
            .map(|mention| (mention.message_id.as_str(), mention.author_kind))
            .collect::<Vec<_>>(),
        vec![("m1", ChatActorKind::Automation)]
    );

    chats
        .start_channel_thread(
            &start_thread("gen-1", "t-ada", "m-ada", "Hi", ChatActorKind::Human, 35),
            &NO_FAULTS,
        )
        .expect("ada posts");
    chats
        .set_follow(
            &SetFollow {
                workspace_id: WS.to_owned(),
                owner_user_id: "reader".to_owned(),
                replication_owner_user_id: None,
                target_kind: FollowTargetKind::Person,
                target_id: "user-ada".to_owned(),
                state: FollowState::Following,
                now_ms: 40,
            },
            &NO_FAULTS,
        )
        .expect("follow ada");
    let feed = chats
        .list_personal_feed(WS, "reader", Some(10), None)
        .expect("feed");
    assert_eq!(
        feed.items
            .iter()
            .map(|item| item.message.message_id.as_str())
            .collect::<Vec<_>>(),
        vec!["m-ada"]
    );

    let keyed = StartChannelThread {
        request_id: Some("post-1".to_owned()),
        ..automated("m3", Some(stamp.clone()))
    };
    chats
        .start_channel_thread(&keyed, &NO_FAULTS)
        .expect("keyed post");
    chats
        .start_channel_thread(&keyed, &NO_FAULTS)
        .expect("the same retry replays");
    let changed = StartChannelThread {
        automation: Some(ChatMessageAutomation {
            chain_depth: 3,
            ..stamp.clone()
        }),
        ..keyed
    };
    assert!(matches!(
        chats.start_channel_thread(&changed, &NO_FAULTS),
        Err(DomainError::IdempotencyKeyReuseMismatch)
    ));

    let indexed: String = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT text FROM engine_search_chat_messages_fts \
                 WHERE workspace_id = ?1 AND message_id = 'm1'",
                [WS],
                |row| row.get(0),
            )
            .map_err(StorageError::corrupt_public)
        })
        .expect("indexed automation message");
    assert_eq!(
        indexed,
        "Stamp the finish date\nStamp the finish date (automation)\nDone @ana"
    );

    let payloads: Vec<serde_json::Value> = store
        .read_with(|conn| {
            let mut stmt = conn
                .prepare(
                    "SELECT payload_json FROM replication_log \
                     WHERE workspace_id = ?1 AND op_kind = 'chat.message.append' \
                     AND json_extract(payload_json, '$.authorKind') = 'automation' ORDER BY origin_seq",
                )
                .map_err(StorageError::corrupt_public)?;
            let rows = stmt
                .query_map([WS], |row| row.get::<_, String>(0))
                .map_err(StorageError::corrupt_public)?;
            rows.collect::<rusqlite::Result<Vec<_>>>()
                .map_err(StorageError::corrupt_public)
        })
        .expect("journaled messages")
        .iter()
        .map(|payload| serde_json::from_str(payload).expect("json"))
        .collect();
    assert_eq!(
        payloads
            .iter()
            .map(|payload| payload["chainDepth"].clone())
            .collect::<Vec<_>>(),
        vec![json!(1), json!(2), json!(1)],
        "the depth travels so a chain of automations stops across computers"
    );
    for payload in payloads {
        assert_eq!(payload["authorKind"], "automation");
        assert_eq!(payload["authorOwnerDisplayName"], "Ice");
        assert_eq!(payload["authorUserId"], "user-ada");
        assert!(
            payload.get("automation").is_none() && payload.get("automationId").is_none(),
            "{payload}"
        );
    }
}

/// Only the relay writes a link message. Neither local write path takes a
/// link author, with or without an account, and a refusal writes nothing.
#[test]
fn local_writes_refuse_a_link_author() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = engine_db_path(&scratch).expect("db");
    let mut store = open(&db, 1);
    let mut chats = LinkedChatStore::new(&mut store);
    chats
        .ensure_general_channel(WS, "gen-1", 10, &NO_FAULTS)
        .expect("gen");
    let refused = |result: Result<_, DomainError>| {
        matches!(
            result,
            Err(DomainError::InvalidInput {
                reason: "only the relay writes a link message"
            })
        )
    };
    for author_user_id in [Some("user-ada".to_owned()), None] {
        let start = StartChannelThread {
            author_user_id,
            ..start_thread(
                "gen-1",
                "t-link",
                "m-link",
                "hello",
                ChatActorKind::Link,
                20,
            )
        };
        assert!(refused(
            chats.start_channel_thread(&start, &NO_FAULTS).map(|_| ())
        ));
    }
    chats
        .start_channel_thread(
            &start_thread("gen-1", "t1", "m1", "hello", ChatActorKind::Human, 20),
            &NO_FAULTS,
        )
        .expect("start");
    let reply = SendMessage {
        author_kind: ChatActorKind::Link,
        ..send_msg("t1", "m-link-reply", None, "hi", 30)
    };
    assert!(refused(chats.send_message(&reply, &NO_FAULTS).map(|_| ())));
    let page = chats.list_messages(WS, "t1", 10, None).expect("list");
    assert_eq!(
        page.messages
            .iter()
            .map(|message| message.message_id.as_str())
            .collect::<Vec<_>>(),
        ["m1"]
    );
    assert!(
        chats.get_message(WS, "m-link").is_err(),
        "no link thread was started"
    );
}

#[test]
fn conversation_revision_tracks_local_content_winners_but_not_read_state() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = engine_db_path(&scratch).expect("db");
    let mut store = open(&db, 1);
    let mut chats = LinkedChatStore::new(&mut store);

    assert_eq!(
        chats
            .conversation_revision(WS, "no-revision-row")
            .expect("absent revision"),
        0
    );
    chats
        .ensure_general_channel(WS, "gen-revision", 10, &NO_FAULTS)
        .expect("general");

    let mut opening = start_thread(
        "gen-revision",
        "thread-revision",
        "message-opening",
        "Choose",
        ChatActorKind::Agent,
        20,
    );
    opening.needs_decision = true;
    chats
        .start_channel_thread(&opening, &NO_FAULTS)
        .expect("start with open decision");
    assert_eq!(
        chats
            .conversation_revision(WS, "thread-revision")
            .expect("start revision"),
        2,
        "thread start/opening message and the opened decision each bump"
    );

    let mut reply = send_msg("thread-revision", "message-reply", None, "Resolve", 30);
    reply.author_kind = ChatActorKind::Agent;
    reply.attachments = vec![LocalAttachmentInput {
        object_id: "object-revision".to_owned(),
        path_hint: Some("notes/revision.md".to_owned()),
        heading_text: None,
        heading_anchor: None,
        heading_occurrence: None,
    }];
    chats
        .send_message(&reply, &NO_FAULTS)
        .expect("send with attachment");
    assert_eq!(
        chats
            .conversation_revision(WS, "thread-revision")
            .expect("send revision"),
        4,
        "message send and its local attachment each bump"
    );

    let reaction = SetReaction {
        workspace_id: WS.to_owned(),
        thread_id: "thread-revision".to_owned(),
        message_id: "message-opening".to_owned(),
        emoji: "👍".to_owned(),
        author_id: "user-ada".to_owned(),
        replication_author_id: Some("user-ada".to_owned()),
        author_kind: ChatActorKind::Human,
        author_display_name: "Ada".to_owned(),
        state: ChatReactionState::Added,
        now_ms: 40,
        request_id: "reaction-revision".to_owned(),
    };
    chats
        .set_reaction(&reaction, &NO_FAULTS)
        .expect("winning reaction");
    assert_eq!(
        chats
            .conversation_revision(WS, "thread-revision")
            .expect("reaction revision"),
        5
    );
    chats
        .set_reaction(&reaction, &NO_FAULTS)
        .expect("idempotent reaction retry");
    assert_eq!(
        chats
            .conversation_revision(WS, "thread-revision")
            .expect("reaction retry revision"),
        5
    );

    chats
        .resolve_decision(
            &ResolveDecision {
                workspace_id: WS.to_owned(),
                thread_id: "thread-revision".to_owned(),
                message_id: "message-opening".to_owned(),
                resolved_by_message_id: "message-reply".to_owned(),
                chosen_option: None,
                now_ms: 50,
                request_id: "decision-revision".to_owned(),
            },
            &NO_FAULTS,
        )
        .expect("resolve decision");
    assert_eq!(
        chats
            .conversation_revision(WS, "thread-revision")
            .expect("decision revision"),
        6
    );

    let read_state = chats
        .mark_thread_read(&read_mark("thread-revision", 2, None, None, 60), &NO_FAULTS)
        .expect("mark read");
    assert_eq!(read_state.last_read_sequence, 2);
    assert_eq!(read_state.revision, 1);
    let agent_read_state = chats
        .mark_thread_read_by_agent(
            WS,
            &dohc_engine_domain::AgentReader::Unnamed,
            "thread-revision",
            30,
            "message-reply",
            None,
            61,
            &NO_FAULTS,
        )
        .expect("mark agent read");
    assert_eq!(agent_read_state.last_read_message_id, "message-reply");
    assert_eq!(agent_read_state.revision, 1);
    assert_eq!(
        chats
            .conversation_revision(WS, "thread-revision")
            .expect("content revision after read"),
        6,
        "human and agent read state must not invalidate conversation content"
    );
}

#[test]
fn send_message_reply_parent_must_exist_in_thread() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = engine_db_path(&scratch).expect("db");
    let mut store = open(&db, 1);
    let mut chats = LinkedChatStore::new(&mut store);
    chats
        .ensure_general_channel(WS, "gen-1", 10, &NO_FAULTS)
        .expect("gen");
    chats
        .start_channel_thread(
            &start_thread("gen-1", "t1", "m0", "opening", ChatActorKind::Human, 20),
            &NO_FAULTS,
        )
        .expect("start");

    let bad = chats
        .send_message(
            &send_msg("t1", "m1", Some("does-not-exist"), "reply", 21),
            &NO_FAULTS,
        )
        .unwrap_err();
    assert_eq!(bad.code(), "message-not-found");

    let ok = chats
        .send_message(&send_msg("t1", "m1", Some("m0"), "reply", 22), &NO_FAULTS)
        .expect("send");
    assert_eq!(ok.message_order, 1);
    assert_eq!(ok.parent_message_id, Some("m0".to_owned()));
}

#[test]
fn mark_thread_read_cas_monotonic_and_over_count_repair() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = engine_db_path(&scratch).expect("db");
    let mut store = open(&db, 1);
    let mut chats = LinkedChatStore::new(&mut store);
    chats
        .ensure_general_channel(WS, "gen-1", 10, &NO_FAULTS)
        .expect("gen");
    // Agent authors so neither message auto-advances the cursor (a human's own
    // message catches the cursor up; agent messages are what unread surfaces).
    chats
        .start_channel_thread(
            &start_thread("gen-1", "t1", "m0", "opening", ChatActorKind::Agent, 20),
            &NO_FAULTS,
        )
        .expect("start");
    let mut second = send_msg("t1", "m1", None, "second", 21);
    second.author_kind = ChatActorKind::Agent;
    chats.send_message(&second, &NO_FAULTS).expect("send");

    let r1 = chats
        .mark_thread_read(&read_mark("t1", 1, None, None, 30), &NO_FAULTS)
        .expect("r1");
    assert_eq!(r1.last_read_sequence, 1);
    assert_eq!(r1.revision, 1);

    let r_low = chats
        .mark_thread_read(&read_mark("t1", 0, None, None, 31), &NO_FAULTS)
        .expect("low");
    assert_eq!(r_low.last_read_sequence, 1);
    assert_eq!(r_low.revision, 1);

    let r_clamp = chats
        .mark_thread_read(&read_mark("t1", 99, None, None, 32), &NO_FAULTS)
        .expect("clamp");
    assert_eq!(r_clamp.last_read_sequence, 2);
    assert_eq!(r_clamp.revision, 2);

    let stale = chats
        .mark_thread_read(&read_mark("t1", 2, Some(0), None, 33), &NO_FAULTS)
        .unwrap_err();
    assert_eq!(stale.code(), "read-state-revision-mismatch");

    let fresh = chats
        .mark_thread_read(&read_mark("t1", 2, Some(2), None, 34), &NO_FAULTS)
        .expect("fresh");
    assert_eq!(fresh.revision, 2);
}

const ACCOUNT: &str = "user-ada";

fn account_mark(store: &EngineStore, thread_id: &str) -> Option<(i64, String)> {
    store
        .read_with(|conn| {
            rusqlite::OptionalExtension::optional(conn.query_row(
                "SELECT last_read_created_at_ms, last_read_message_id \
                 FROM chat_account_thread_read_state \
                 WHERE workspace_id = ?1 AND account_user_id = ?2 AND thread_id = ?3",
                rusqlite::params![WS, ACCOUNT, thread_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            ))
        })
        .expect("account mark")
}

fn thread_read_ops(store: &EngineStore) -> i64 {
    store
        .read_with(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM replication_log \
                 WHERE workspace_id = ?1 AND op_kind = 'chat.thread.read.set'",
                [WS],
                |row| row.get::<_, i64>(0),
            )
        })
        .expect("thread read ops")
}

fn set_local_count(store: &EngineStore, thread_id: &str, count: i64) {
    store
        .read_with(|conn| {
            conn.execute(
                "INSERT INTO chat_thread_read_state \
                 (workspace_id, thread_id, last_read_sequence, revision, updated_at_ms) \
                 VALUES (?1, ?2, ?3, 1, 1) \
                 ON CONFLICT(workspace_id, thread_id) DO UPDATE SET \
                   last_read_sequence = excluded.last_read_sequence",
                rusqlite::params![WS, thread_id, count],
            )
        })
        .expect("local count");
}

fn agent_message(thread_id: &str, message_id: &str, now: i64) -> SendMessage {
    SendMessage {
        author_kind: ChatActorKind::Agent,
        ..send_msg(thread_id, message_id, None, "agent", now)
    }
}

fn agent_thread(chats: &mut LinkedChatStore<'_>, thread_id: &str, messages: &[(&str, i64)]) {
    let ((first_id, first_at), rest) = messages.split_first().expect("a message");
    chats
        .start_channel_thread(
            &start_thread(
                "gen-1",
                thread_id,
                first_id,
                "agent",
                ChatActorKind::Agent,
                *first_at,
            ),
            &NO_FAULTS,
        )
        .expect("start");
    for (message_id, at) in rest {
        chats
            .send_message(&agent_message(thread_id, message_id, *at), &NO_FAULTS)
            .expect("send");
    }
}

#[test]
fn account_read_seed_never_hides_a_locally_unread_message() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = engine_db_path(&scratch).expect("db");
    let mut store = open(&db, 1);
    {
        let mut chats = LinkedChatStore::new(&mut store);
        chats
            .ensure_general_channel(WS, "gen-1", 1, &NO_FAULTS)
            .expect("gen");
        agent_thread(&mut chats, "zero", &[("z0", 10)]);
        agent_thread(&mut chats, "full", &[("f0", 10), ("f1", 30)]);
        // The read message is newer than the unread one that arrived after it.
        agent_thread(&mut chats, "late", &[("l0", 200), ("l1", 100)]);
        // Equal times: the unread message's id sorts first, then last.
        agent_thread(&mut chats, "tie", &[("t-z", 50), ("t-a", 50)]);
        agent_thread(&mut chats, "even", &[("e-a", 50), ("e-b", 50)]);
        agent_thread(&mut chats, "newer", &[("n0", 10), ("n1", 20)]);
    }
    set_local_count(&store, "full", 99);
    set_local_count(&store, "late", 1);
    set_local_count(&store, "tie", 1);
    set_local_count(&store, "even", 1);
    set_local_count(&store, "newer", 1);
    store
        .read_with(|conn| {
            conn.execute(
                "INSERT INTO chat_account_thread_read_state \
                 (workspace_id, account_user_id, thread_id, last_read_created_at_ms, \
                  last_read_message_id, updated_at_ms, origin_id, origin_seq) \
                 VALUES (?1, ?2, 'newer', 20, 'n1', 1, 'other-copy', 0)",
                rusqlite::params![WS, ACCOUNT],
            )
        })
        .expect("newer mark");

    assert!(
        LinkedChatStore::new(&mut store)
            .seed_account_reads(WS, ACCOUNT, true, 500, &NO_FAULTS)
            .expect("seed")
    );
    assert_eq!(account_mark(&store, "zero"), None);
    assert_eq!(account_mark(&store, "full"), Some((30, "f1".to_owned())));
    assert_eq!(account_mark(&store, "late"), None);
    assert_eq!(account_mark(&store, "tie"), None);
    assert_eq!(account_mark(&store, "even"), Some((50, "e-a".to_owned())));
    assert_eq!(account_mark(&store, "newer"), Some((20, "n1".to_owned())));
    assert_eq!(thread_read_ops(&store), 2);

    assert!(
        !LinkedChatStore::new(&mut store)
            .seed_account_reads(WS, ACCOUNT, true, 501, &NO_FAULTS)
            .expect("seed again")
    );
    assert_eq!(thread_read_ops(&store), 2);

    let summaries = LinkedChatStore::new(&mut store)
        .list_channel_threads(WS, "gen-1", None, 10)
        .expect("summaries");
    let unread = |thread_id: &str| {
        summaries
            .iter()
            .find(|summary| summary.thread.thread_id == thread_id)
            .map(|summary| summary.unread_count)
    };
    assert_eq!(
        unread("late"),
        Some(2),
        "a coordinate seed must not hide l1"
    );
    assert_eq!(unread("tie"), Some(2));
    assert_eq!(unread("even"), Some(1));
    assert_eq!(unread("full"), Some(0));
}

#[test]
fn an_empty_account_seed_still_records_completion() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = engine_db_path(&scratch).expect("db");
    let mut store = open(&db, 1);
    let mut chats = LinkedChatStore::new(&mut store);
    assert!(
        chats
            .seed_account_reads(WS, ACCOUNT, true, 5, &NO_FAULTS)
            .expect("empty seed")
    );
    assert!(
        !chats
            .seed_account_reads(WS, ACCOUNT, true, 6, &NO_FAULTS)
            .expect("seeded already")
    );
    assert_eq!(thread_read_ops(&store), 0);
}

#[test]
fn a_server_copy_seed_takes_no_local_count() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = engine_db_path(&scratch).expect("db");
    let mut store = open(&db, 1);
    {
        let mut chats = LinkedChatStore::new(&mut store);
        chats
            .ensure_general_channel(WS, "gen-1", 1, &NO_FAULTS)
            .expect("gen");
        agent_thread(&mut chats, "t1", &[("m0", 10)]);
    }
    set_local_count(&store, "t1", 1);
    assert!(
        LinkedChatStore::new(&mut store)
            .seed_account_reads(WS, ACCOUNT, false, 20, &NO_FAULTS)
            .expect("server seed")
    );
    assert_eq!(account_mark(&store, "t1"), None);
    assert_eq!(thread_read_ops(&store), 0);
    let state = LinkedChatStore::new(&mut store)
        .read_state(WS, "t1")
        .expect("read state");
    assert_eq!(state.last_read_sequence, 0, "the account read nothing yet");
}

#[test]
fn account_marks_move_forward_journal_with_the_owner_and_drive_every_human_reader() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = engine_db_path(&scratch).expect("db");
    let mut store = open(&db, 1);
    {
        let mut chats = LinkedChatStore::new(&mut store);
        chats
            .ensure_general_channel(WS, "gen-1", 1, &NO_FAULTS)
            .expect("gen");
        agent_thread(&mut chats, "t1", &[("m0", 100), ("m1", 300), ("m2", 200)]);
        chats
            .create_thread(
                &CreateFileThread {
                    workspace_id: WS.to_owned(),
                    thread_id: "file-thread".to_owned(),
                    title: "About a file".to_owned(),
                    linked_object_id: "object-1".to_owned(),
                    linked_path_hint: None,
                    now_ms: 5,
                    request_id: "file-thread".to_owned(),
                },
                &NO_FAULTS,
            )
            .expect("file thread");
        chats
            .send_message(&agent_message("file-thread", "fm0", 6), &NO_FAULTS)
            .expect("file message");
        assert!(
            chats
                .seed_account_reads(WS, ACCOUNT, true, 400, &NO_FAULTS)
                .expect("seed")
        );
    }
    let channel_unread = |store: &mut EngineStore| {
        LinkedChatStore::new(store)
            .list_channels(WS)
            .expect("channels")
            .into_iter()
            .find(|summary| summary.channel.channel_id == "gen-1")
            .map(|summary| summary.unread_count)
    };
    let summary = |store: &mut EngineStore| {
        let summary = LinkedChatStore::new(store)
            .list_channel_threads(WS, "gen-1", None, 10)
            .expect("summaries")
            .remove(0);
        (
            summary.message_count,
            summary.last_read_sequence,
            summary.unread_count,
        )
    };
    assert_eq!(channel_unread(&mut store), Some(3));

    // Read set m0; m2 is the earliest unread, so the mark stops at m0. The
    // place counts m0 and m1, the messages before m2 in arrival order.
    let marked = LinkedChatStore::new(&mut store)
        .mark_thread_read(&read_mark("t1", 1, None, None, 401), &NO_FAULTS)
        .expect("mark one");
    assert_eq!(marked.last_read_sequence, 2);
    assert_eq!(account_mark(&store, "t1"), Some((100, "m0".to_owned())));
    assert_eq!(summary(&mut store), (3, 2, 2));
    assert_eq!(channel_unread(&mut store), Some(2));
    assert_eq!(
        LinkedChatStore::new(&mut store)
            .read_state(WS, "t1")
            .expect("read state")
            .last_read_sequence,
        2
    );
    assert_eq!(thread_read_ops(&store), 0, "no owner context, no journal");

    LinkedChatStore::new(&mut store)
        .mark_thread_read(
            &read_mark("t1", 3, None, Some("someone-else"), 402),
            &NO_FAULTS,
        )
        .expect("mark all as someone else");
    assert_eq!(account_mark(&store, "t1"), Some((300, "m1".to_owned())));
    assert_eq!(thread_read_ops(&store), 0);
    assert_eq!(summary(&mut store), (3, 3, 0));
    assert_eq!(channel_unread(&mut store), Some(0));

    LinkedChatStore::new(&mut store)
        .send_message(&agent_message("t1", "m3", 500), &NO_FAULTS)
        .expect("newer message");
    assert_eq!(summary(&mut store), (4, 3, 1));
    LinkedChatStore::new(&mut store)
        .mark_thread_read(&read_mark("t1", 4, None, Some(ACCOUNT), 501), &NO_FAULTS)
        .expect("owner mark");
    assert_eq!(account_mark(&store, "t1"), Some((500, "m3".to_owned())));
    assert_eq!(thread_read_ops(&store), 1);
    LinkedChatStore::new(&mut store)
        .mark_thread_read(&read_mark("t1", 1, None, Some(ACCOUNT), 502), &NO_FAULTS)
        .expect("older mark");
    assert_eq!(account_mark(&store, "t1"), Some((500, "m3".to_owned())));
    assert_eq!(thread_read_ops(&store), 1);

    let unread_files = LinkedChatStore::new(&mut store)
        .list_unread_file_threads(WS, None, 10)
        .expect("unread files");
    assert_eq!(
        unread_files
            .iter()
            .map(|row| (
                row.thread_id.as_str(),
                row.message_count,
                row.last_read_sequence
            ))
            .collect::<Vec<_>>(),
        vec![("file-thread", 1, 0)]
    );
    LinkedChatStore::new(&mut store)
        .mark_thread_read(
            &read_mark("file-thread", 1, None, Some(ACCOUNT), 503),
            &NO_FAULTS,
        )
        .expect("file mark");
    assert!(
        LinkedChatStore::new(&mut store)
            .list_unread_file_threads(WS, None, 10)
            .expect("no unread files")
            .is_empty()
    );
}

#[test]
fn a_persons_send_moves_the_account_mark_and_an_agents_does_not() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = engine_db_path(&scratch).expect("db");
    let mut store = open(&db, 1);
    let mut chats = LinkedChatStore::new(&mut store);
    chats
        .ensure_general_channel(WS, "gen-1", 1, &NO_FAULTS)
        .expect("gen");
    assert!(
        chats
            .seed_account_reads(WS, ACCOUNT, true, 2, &NO_FAULTS)
            .expect("seed")
    );
    agent_thread(&mut chats, "t1", &[("m0", 10)]);
    chats
        .send_message(&send_msg("t1", "m1", None, "mine", 20), &NO_FAULTS)
        .expect("own message");
    chats
        .send_message(&agent_message("t1", "m2", 30), &NO_FAULTS)
        .expect("agent reply");
    let local_only = SendMessage {
        author_user_id: None,
        ..send_msg("t1", "m3", None, "signed out", 40)
    };
    chats
        .send_message(&local_only, &NO_FAULTS)
        .expect("local send");
    let other = SendMessage {
        author_user_id: Some("user-bob".to_owned()),
        ..send_msg("t1", "m4", None, "someone else", 50)
    };
    chats.send_message(&other, &NO_FAULTS).expect("other send");
    chats
        .start_channel_thread(
            &start_thread("gen-1", "t2", "s0", "mine", ChatActorKind::Human, 60),
            &NO_FAULTS,
        )
        .expect("own start");
    drop(chats);

    // m1 journaled; the signed-out m3 moved the mark without a journal; the
    // other account's m4 left it; the agent's m2 never moved it.
    assert_eq!(account_mark(&store, "t1"), Some((40, "m3".to_owned())));
    assert_eq!(account_mark(&store, "t2"), Some((60, "s0".to_owned())));
    assert_eq!(thread_read_ops(&store), 2);
}

#[test]
fn a_joined_groups_threads_keep_local_counts_and_take_no_account_mark() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = engine_db_path(&scratch).expect("db");
    let mut store = open(&db, 1);
    {
        let mut chats = LinkedChatStore::new(&mut store);
        chats
            .ensure_general_channel(WS, "gen-1", 1, &NO_FAULTS)
            .expect("gen");
        chats
            .create_channel(
                WS,
                "joined-1",
                "Bob Group",
                ChatChannelKind::Channel,
                1,
                &NO_FAULTS,
            )
            .expect("joined group");
        agent_thread(&mut chats, "own", &[("o0", 10), ("o1", 20)]);
        chats
            .start_channel_thread(
                &start_thread(
                    "joined-1",
                    "theirs",
                    "b0",
                    "agent",
                    ChatActorKind::Agent,
                    10,
                ),
                &NO_FAULTS,
            )
            .expect("joined thread");
        chats
            .send_message(&agent_message("theirs", "b1", 20), &NO_FAULTS)
            .expect("joined reply");
    }
    // A shared lane applied Bob's Group, as it records on join.
    store
        .read_with(|conn| {
            conn.execute(
                "INSERT INTO chat_joined_channels (workspace_id, wire_id) VALUES (?1, 'joined-1')",
                [WS],
            )
        })
        .expect("joined");
    set_local_count(&store, "own", 2);
    set_local_count(&store, "theirs", 1);

    assert!(
        LinkedChatStore::new(&mut store)
            .seed_account_reads(WS, ACCOUNT, true, 100, &NO_FAULTS)
            .expect("seed")
    );
    assert_eq!(account_mark(&store, "own"), Some((20, "o1".to_owned())));
    assert_eq!(
        account_mark(&store, "theirs"),
        None,
        "a joined thread seeds nothing"
    );
    assert_eq!(thread_read_ops(&store), 1);

    let theirs = LinkedChatStore::new(&mut store)
        .list_channel_threads(WS, "joined-1", None, 10)
        .expect("joined summaries")
        .remove(0);
    assert_eq!(
        (
            theirs.message_count,
            theirs.last_read_sequence,
            theirs.unread_count
        ),
        (2, 1, 1)
    );
    let unread_by_channel = |store: &mut EngineStore| {
        LinkedChatStore::new(store)
            .list_channels(WS)
            .expect("channels")
            .into_iter()
            .map(|summary| (summary.channel.channel_id, summary.unread_count))
            .collect::<Vec<_>>()
    };
    let totals = unread_by_channel(&mut store);
    assert!(totals.contains(&("gen-1".to_owned(), 0)));
    assert!(totals.contains(&("joined-1".to_owned(), 1)));

    let mut chats = LinkedChatStore::new(&mut store);
    chats
        .send_message(&send_msg("theirs", "b2", None, "mine", 30), &NO_FAULTS)
        .expect("own message in a joined Group");
    assert_eq!(
        chats
            .read_state(WS, "theirs")
            .expect("read state")
            .last_read_sequence,
        3
    );
    let marked = chats
        .mark_thread_read(&read_mark("theirs", 3, None, Some(ACCOUNT), 40), &NO_FAULTS)
        .expect("joined mark");
    assert_eq!(marked.last_read_sequence, 3);
    drop(chats);
    assert_eq!(account_mark(&store, "theirs"), None);
    assert_eq!(thread_read_ops(&store), 1);
}

#[test]
fn an_owner_mark_publishes_a_coordinate_stored_without_a_record_once() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = engine_db_path(&scratch).expect("db");
    let mut store = open(&db, 1);
    let mut chats = LinkedChatStore::new(&mut store);
    chats
        .ensure_general_channel(WS, "gen-1", 1, &NO_FAULTS)
        .expect("gen");
    assert!(
        chats
            .seed_account_reads(WS, ACCOUNT, true, 2, &NO_FAULTS)
            .expect("seed")
    );
    agent_thread(&mut chats, "t1", &[("m0", 10), ("m1", 20)]);
    chats
        .mark_thread_read(&read_mark("t1", 2, None, None, 30), &NO_FAULTS)
        .expect("signed-out mark");
    drop(chats);
    assert_eq!(account_mark(&store, "t1"), Some((20, "m1".to_owned())));
    assert_eq!(thread_read_ops(&store), 0);

    LinkedChatStore::new(&mut store)
        .mark_thread_read(&read_mark("t1", 2, None, Some(ACCOUNT), 31), &NO_FAULTS)
        .expect("owner mark");
    assert_eq!(thread_read_ops(&store), 1);
    let marker: String = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT json_extract(payload_json, '$.ownerPrivateAccountId') FROM replication_log \
                 WHERE workspace_id = ?1 AND op_kind = 'chat.thread.read.set'",
                [WS],
                |row| row.get(0),
            )
        })
        .expect("owner-private marker");
    assert_eq!(marker, ACCOUNT);
    LinkedChatStore::new(&mut store)
        .mark_thread_read(&read_mark("t1", 2, None, Some(ACCOUNT), 32), &NO_FAULTS)
        .expect("owner retry");
    assert_eq!(thread_read_ops(&store), 1, "a record of the place exists");
    assert_eq!(account_mark(&store, "t1"), Some((20, "m1".to_owned())));
}

fn published_thread_reads(store: &EngineStore) -> Vec<(i64, String)> {
    store
        .read_with(|conn| {
            let mut stmt = conn
                .prepare(
                    "SELECT json_extract(payload_json, '$.lastReadCreatedAtMs'), \
                            json_extract(payload_json, '$.lastReadMessageId') \
                     FROM replication_log \
                     WHERE workspace_id = ?1 AND op_kind = 'chat.thread.read.set' \
                     ORDER BY origin_seq",
                )
                .map_err(StorageError::corrupt_public)?;
            let rows = stmt
                .query_map([WS], |row| {
                    Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
                })
                .map_err(StorageError::corrupt_public)?;
            rows.collect::<rusqlite::Result<Vec<_>>>()
                .map_err(StorageError::corrupt_public)
        })
        .expect("published thread reads")
}

fn account_read(
    thread_id: &str,
    message_id: &str,
    owner: Option<&str>,
    now_ms: i64,
) -> MarkAccountThreadRead {
    MarkAccountThreadRead {
        workspace_id: WS.to_owned(),
        thread_id: thread_id.to_owned(),
        message_id: message_id.to_owned(),
        replication_owner_user_id: owner.map(str::to_owned),
        now_ms,
    }
}

#[test]
fn a_signed_in_read_after_a_signed_out_message_publishes_the_newest_message_that_replicates() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = engine_db_path(&scratch).expect("db");
    let mut store = open(&db, 1);
    let mut chats = LinkedChatStore::new(&mut store);
    chats
        .ensure_general_channel(WS, "gen-1", 1, &NO_FAULTS)
        .expect("gen");
    assert!(
        chats
            .seed_account_reads(WS, ACCOUNT, true, 2, &NO_FAULTS)
            .expect("seed")
    );
    agent_thread(&mut chats, "t1", &[("m0", 10)]);
    let signed_out = SendMessage {
        author_user_id: None,
        ..send_msg("t1", "m1", None, "signed out", 20)
    };
    chats
        .send_message(&signed_out, &NO_FAULTS)
        .expect("signed-out send");
    chats
        .mark_thread_read(&read_mark("t1", 2, None, Some(ACCOUNT), 30), &NO_FAULTS)
        .expect("signed-in read");
    drop(chats);
    // The mark here stays on the signed-out message. The record names the
    // newest message the account's other copies can hold.
    assert_eq!(account_mark(&store, "t1"), Some((20, "m1".to_owned())));
    assert_eq!(published_thread_reads(&store), vec![(10, "m0".to_owned())]);

    let mut chats = LinkedChatStore::new(&mut store);
    chats
        .mark_thread_read(&read_mark("t1", 2, None, Some(ACCOUNT), 31), &NO_FAULTS)
        .expect("retry");
    chats
        .send_message(&agent_message("t1", "m2", 40), &NO_FAULTS)
        .expect("agent reply");
    chats
        .mark_thread_read(&read_mark("t1", 3, None, Some(ACCOUNT), 50), &NO_FAULTS)
        .expect("later read");
    drop(chats);
    assert_eq!(account_mark(&store, "t1"), Some((40, "m2".to_owned())));
    assert_eq!(
        published_thread_reads(&store),
        vec![(10, "m0".to_owned()), (40, "m2".to_owned())]
    );
}

#[test]
fn an_account_mark_names_a_message_in_its_thread_and_journals_only_with_the_owner() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = engine_db_path(&scratch).expect("db");
    let mut store = open(&db, 1);
    let mut chats = LinkedChatStore::new(&mut store);
    chats
        .ensure_general_channel(WS, "gen-1", 1, &NO_FAULTS)
        .expect("gen");
    agent_thread(&mut chats, "t1", &[("m0", 10), ("m1", 20)]);
    agent_thread(&mut chats, "t2", &[("n0", 30)]);
    let local = chats
        .mark_account_thread_read(&account_read("t1", "m1", Some(ACCOUNT), 35), &NO_FAULTS)
        .expect("no account yet");
    assert_eq!(local.last_read_sequence, 0);
    assert!(
        chats
            .seed_account_reads(WS, ACCOUNT, false, 36, &NO_FAULTS)
            .expect("seed")
    );
    let refused = chats
        .mark_account_thread_read(&account_read("t1", "n0", Some(ACCOUNT), 40), &NO_FAULTS)
        .expect_err("another thread's message");
    assert_eq!(refused.code(), "message-not-found");
    let unowned = chats
        .mark_account_thread_read(&account_read("t1", "m0", None, 41), &NO_FAULTS)
        .expect("mark without the owner");
    assert_eq!(unowned.last_read_sequence, 1);
    let owned = chats
        .mark_account_thread_read(&account_read("t1", "m1", Some(ACCOUNT), 42), &NO_FAULTS)
        .expect("owner mark");
    assert_eq!(owned.last_read_sequence, 2);
    chats
        .mark_account_thread_read(&account_read("t1", "m0", Some(ACCOUNT), 43), &NO_FAULTS)
        .expect("older mark");
    drop(chats);
    assert_eq!(account_mark(&store, "t1"), Some((20, "m1".to_owned())));
    assert_eq!(account_mark(&store, "t2"), None);
    assert_eq!(published_thread_reads(&store), vec![(20, "m1".to_owned())]);
}

#[test]
fn a_workspace_without_an_account_keeps_local_counts_and_journals_no_mark() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = engine_db_path(&scratch).expect("db");
    let mut store = open(&db, 1);
    let mut chats = LinkedChatStore::new(&mut store);
    chats
        .ensure_general_channel(WS, "gen-1", 1, &NO_FAULTS)
        .expect("gen");
    agent_thread(&mut chats, "t1", &[("m0", 100), ("m1", 50)]);
    let state = chats
        .mark_thread_read(&read_mark("t1", 1, None, Some(ACCOUNT), 200), &NO_FAULTS)
        .expect("local mark");
    assert_eq!(state.last_read_sequence, 1);
    chats
        .send_message(&send_msg("t1", "m2", None, "mine", 300), &NO_FAULTS)
        .expect("own message");
    drop(chats);
    assert_eq!(account_mark(&store, "t1"), None);
    assert_eq!(thread_read_ops(&store), 0);
}

#[test]
fn follow_and_feed_read_journaling_require_matching_replication_owner() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = engine_db_path(&scratch).expect("db");
    let mut store = open(&db, 1);
    let follow_ops = |store: &EngineStore| {
        store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT COUNT(*) FROM replication_log \
                     WHERE workspace_id = ?1 AND op_kind = 'chat.follow.set'",
                    [WS],
                    |row| row.get::<_, i64>(0),
                )
            })
            .expect("follow op count")
    };
    let mut chats = LinkedChatStore::new(&mut store);
    chats
        .ensure_general_channel(WS, "gen-1", 1, &NO_FAULTS)
        .expect("general");
    chats
        .start_channel_thread(
            &start_thread("gen-1", "t1", "m1", "opening", ChatActorKind::Human, 2),
            &NO_FAULTS,
        )
        .expect("thread");

    let implicit_poster_follow_ops = follow_ops(&store);
    assert_eq!(implicit_poster_follow_ops, 1);
    let mut chats = LinkedChatStore::new(&mut store);
    let signed_out = chats
        .set_follow(
            &SetFollow {
                workspace_id: WS.to_owned(),
                owner_user_id: "owner".to_owned(),
                replication_owner_user_id: None,
                target_kind: FollowTargetKind::Thread,
                target_id: "t1".to_owned(),
                state: FollowState::Following,
                now_ms: 10,
            },
            &NO_FAULTS,
        )
        .expect("signed-out follow is durable");
    assert_eq!(signed_out.state, FollowState::Following);
    assert_eq!(follow_ops(&store), implicit_poster_follow_ops);

    let mut chats = LinkedChatStore::new(&mut store);
    let mismatch = chats
        .set_follow(
            &SetFollow {
                workspace_id: WS.to_owned(),
                owner_user_id: "owner".to_owned(),
                replication_owner_user_id: Some("someone-else".to_owned()),
                target_kind: FollowTargetKind::Thread,
                target_id: "t1".to_owned(),
                state: FollowState::Unfollowed,
                now_ms: 11,
            },
            &NO_FAULTS,
        )
        .unwrap_err();
    assert_eq!(mismatch.code(), "invalid-follow-target");
    assert_eq!(follow_ops(&store), 1);

    let mut chats = LinkedChatStore::new(&mut store);
    chats
        .set_follow(
            &SetFollow {
                workspace_id: WS.to_owned(),
                owner_user_id: "owner".to_owned(),
                replication_owner_user_id: Some("owner".to_owned()),
                target_kind: FollowTargetKind::Thread,
                target_id: "t1".to_owned(),
                state: FollowState::Following,
                now_ms: 12,
            },
            &NO_FAULTS,
        )
        .expect("verified follow");
    // The poster's implicit follow plus this one.
    assert_eq!(follow_ops(&store), 2);

    let mut chats = LinkedChatStore::new(&mut store);
    let head = chats
        .list_personal_feed(WS, "owner", Some(10), None)
        .expect("feed")
        .head_cursor
        .expect("head");
    chats
        .mark_feed_seen(WS, "owner", None, &head, 20, &NO_FAULTS)
        .expect("signed-out read is durable");
    let read_ops = |store: &EngineStore| {
        store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT COUNT(*) FROM replication_log \
                     WHERE workspace_id = ?1 AND op_kind = 'chat.feed.read.set'",
                    [WS],
                    |row| row.get::<_, i64>(0),
                )
            })
            .expect("feed-read op count")
    };
    assert_eq!(read_ops(&store), 0);
    let mut chats = LinkedChatStore::new(&mut store);
    let mismatch = chats
        .mark_feed_seen(WS, "owner", Some("someone-else"), &head, 21, &NO_FAULTS)
        .unwrap_err();
    assert_eq!(mismatch.code(), "invalid-follow-target");
    assert_eq!(read_ops(&store), 0);
    let mut chats = LinkedChatStore::new(&mut store);
    chats
        .mark_feed_seen(WS, "owner", Some("owner"), &head, 22, &NO_FAULTS)
        .expect("verified feed read");
    assert_eq!(read_ops(&store), 1);
}

#[test]
fn authorless_message_and_derived_state_stay_local() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = engine_db_path(&scratch).expect("db");
    let mut store = open(&db, 1);
    {
        let mut chats = LinkedChatStore::new(&mut store);
        chats
            .ensure_general_channel(WS, "gen-1", 10, &NO_FAULTS)
            .expect("general");
        let mut opening = start_thread(
            "gen-1",
            "local-thread",
            "local-message",
            "private before sign-in",
            ChatActorKind::Human,
            20,
        );
        opening.author_user_id = None;
        opening.needs_decision = true;
        opening.attachments = vec![LocalAttachmentInput {
            object_id: "private-file".to_owned(),
            path_hint: Some("private/file.md".to_owned()),
            heading_text: None,
            heading_anchor: None,
            heading_occurrence: None,
        }];

        let (thread, message) = chats
            .start_channel_thread(&opening, &NO_FAULTS)
            .expect("local thread");
        assert_eq!(thread.thread_id, "local-thread");
        assert_eq!(message.author_user_id, None);
        assert_eq!(message.attachments.len(), 1);
        assert_eq!(
            chats
                .list_thread_decisions(WS, "local-thread", None, 10)
                .expect("local decision")
                .len(),
            1
        );
        assert_eq!(
            chats
                .list_thread_attachments(WS, "local-thread", None, 10)
                .expect("local attachment")
                .len(),
            1
        );
        chats
            .set_reaction(
                &SetReaction {
                    workspace_id: WS.to_owned(),
                    thread_id: "local-thread".to_owned(),
                    message_id: "local-message".to_owned(),
                    emoji: "👍".to_owned(),
                    author_id: "user-ada".to_owned(),
                    replication_author_id: Some("user-ada".to_owned()),
                    author_kind: ChatActorKind::Human,
                    author_display_name: "Ada".to_owned(),
                    state: ChatReactionState::Added,
                    now_ms: 21,
                    request_id: "local-reaction".to_owned(),
                },
                &NO_FAULTS,
            )
            .expect("local reaction");
    }

    let unsafe_relay_ops: i64 = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM replication_log WHERE workspace_id = ?1 \
                 AND op_kind IN ('chat.thread.create', 'chat.message.append', \
                                 'chat.decision.set', 'chat.attachment.add', \
                                 'chat.reaction.set')",
                [WS],
                |row| row.get(0),
            )
        })
        .expect("relay-visible ops");
    assert_eq!(unsafe_relay_ops, 0);
}

#[test]
fn personal_feed_visibility_and_base64url_cursor_round_trip() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = engine_db_path(&scratch).expect("db");
    let mut store = open(&db, 1);
    let mut chats = LinkedChatStore::new(&mut store);
    chats
        .ensure_general_channel(WS, "gen-1", 10, &NO_FAULTS)
        .expect("gen");
    for (t, m, ms) in [("t1", "m1", 100), ("t2", "m2", 101)] {
        chats
            .start_channel_thread(
                &start_thread("gen-1", t, m, "body", ChatActorKind::Human, ms),
                &NO_FAULTS,
            )
            .expect("start");
    }
    chats
        .set_follow(
            &SetFollow {
                workspace_id: WS.to_owned(),
                owner_user_id: "owner".to_owned(),
                replication_owner_user_id: None,
                target_kind: FollowTargetKind::Thread,
                target_id: "t1".to_owned(),
                state: FollowState::Following,
                now_ms: 50,
            },
            &NO_FAULTS,
        )
        .expect("follow t1");

    let page = chats
        .list_personal_feed(WS, "owner", Some(20), None)
        .expect("feed");
    let ids: Vec<&str> = page
        .items
        .iter()
        .map(|i| i.message.message_id.as_str())
        .collect();
    assert_eq!(
        ids,
        vec!["m1"],
        "only the followed thread's message is visible"
    );
    assert_eq!(page.items[0].thread.thread_id, "t1");
    assert_eq!(
        page.items[0]
            .channel
            .as_ref()
            .expect("hydrated channel")
            .channel_id,
        "gen-1"
    );
    assert!(page.items[0].parent_message.is_none());
    assert!(page.items[0].opening_message.is_none());
    assert!(page.items[0].reactions.is_empty());
    assert_eq!(page.items[0].matched_by, vec![FollowTargetKind::Thread]);

    chats
        .set_follow(
            &SetFollow {
                workspace_id: WS.to_owned(),
                owner_user_id: "owner2".to_owned(),
                replication_owner_user_id: None,
                target_kind: FollowTargetKind::Channel,
                target_id: GENERAL_CHANNEL_WIRE_ID.to_owned(),
                state: FollowState::Following,
                now_ms: 51,
            },
            &NO_FAULTS,
        )
        .expect("follow chan");
    let chan_feed = chats
        .list_personal_feed(WS, "owner2", Some(1), None)
        .expect("chan feed");
    assert_eq!(chan_feed.items.len(), 1);
    assert_eq!(
        chan_feed.items[0].matched_by,
        vec![FollowTargetKind::Channel]
    );
    assert!(
        chan_feed.next_cursor.is_some(),
        "a following page yields a cursor"
    );
    let next = chan_feed.next_cursor.expect("cursor");
    let decoded = decode_feed_cursor(&next).expect("decode");
    assert_eq!(decoded.message_id, chan_feed.items[0].message.message_id);
    let page2 = chats
        .list_personal_feed(WS, "owner2", Some(1), Some(&next))
        .expect("feed page 2");
    assert_eq!(page2.items.len(), 1);
    assert_ne!(
        page2.items[0].message.message_id,
        chan_feed.items[0].message.message_id
    );
}

#[test]
fn bookmark_generation_cas_stale_worker_loses() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = engine_db_path(&scratch).expect("db");
    let mut store = open(&db, 1);
    let mut chats = LinkedChatStore::new(&mut store);
    chats
        .ensure_general_channel(WS, "gen-1", 10, &NO_FAULTS)
        .expect("gen");
    chats
        .start_channel_thread(
            &start_thread("gen-1", "t1", "m0", "opening", ChatActorKind::Human, 20),
            &NO_FAULTS,
        )
        .expect("start");

    let save = |now: i64| SaveBookmark {
        workspace_id: WS.to_owned(),
        owner_user_id: "owner".to_owned(),
        target_kind: BookmarkTargetKind::Thread,
        target_id: "t1".to_owned(),
        mode: BookmarkMode::Live,
        destination_path: "bookmarks/thread.md".to_owned(),
        now_ms: now,
    };
    let b1 = chats.save_bookmark(&save(30), &NO_FAULTS).expect("save");
    assert_eq!(b1.generation, 1);
    assert_eq!(b1.projection_state, "pending");

    let b2 = chats.save_bookmark(&save(31), &NO_FAULTS).expect("resave");
    assert_eq!(b2.generation, 2);

    let stale = chats
        .mark_bookmark_ready(WS, "owner", &b1.bookmark_id, 1, 40, None, None, &NO_FAULTS)
        .expect("stale ready");
    assert!(!stale.applied, "stale generation must not mark ready");
    assert_eq!(stale.bookmark.projection_state, "pending");

    let fresh = chats
        .mark_bookmark_ready(WS, "owner", &b1.bookmark_id, 2, 41, None, None, &NO_FAULTS)
        .expect("fresh ready");
    assert!(fresh.applied, "current generation marks ready");
    assert_eq!(fresh.bookmark.projection_state, "ready");
}

#[test]
fn dispatch_completes_then_next_trigger_is_claimable() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = engine_db_path(&scratch).expect("db");
    let mut store = open(&db, 1);
    let mut chats = LinkedChatStore::new(&mut store);
    chats
        .ensure_agent_channel(WS, "agent-1", "default", "My agent", 10, &NO_FAULTS)
        .expect("agent");
    // Two triggers in two threads (a claim marks only same-thread pendings done).
    // An agent DM keeps one conversation, so each asks for its own thread.
    for (thread_id, message_id, body, now) in
        [("t1", "mA", "@agent A", 20), ("t2", "mB", "@agent B", 21)]
    {
        chats
            .start_channel_thread(
                &StartChannelThread {
                    own_thread: true,
                    ..start_thread(
                        "agent-1",
                        thread_id,
                        message_id,
                        body,
                        ChatActorKind::Human,
                        now,
                    )
                },
                &NO_FAULTS,
            )
            .expect(thread_id);
    }
    chats
        .enqueue_dispatch(WS, "mA", "default", "t1", 22, &NO_FAULTS)
        .expect("enq A");
    chats
        .enqueue_dispatch(WS, "mB", "default", "t2", 23, &NO_FAULTS)
        .expect("enq B");

    let a = chats
        .claim_next_pending(WS, "default", "run-A", "agent", None, 24, &NO_FAULTS)
        .expect("claim A")
        .expect("some A");
    assert_eq!(a.dispatch.trigger_message_id, "mA");

    let retry = chats
        .claim_next_pending(
            WS,
            "default",
            "run-A",
            "ignored retry command",
            None,
            25,
            &NO_FAULTS,
        )
        .expect("retry claim")
        .expect("same running claim");
    assert_eq!(retry, a);

    assert!(
        chats
            .claim_next_pending(WS, "default", "run-B", "agent", None, 25, &NO_FAULTS)
            .expect("blocked")
            .is_none()
    );

    chats
        .complete_dispatch(WS, "run-A", 0, 26, &NO_FAULTS)
        .expect("complete A");
    let b = chats
        .claim_next_pending(WS, "default", "run-B", "agent", None, 27, &NO_FAULTS)
        .expect("claim B")
        .expect("some B");
    assert_eq!(b.dispatch.trigger_message_id, "mB");

    // A different workspace can neither complete nor fail this run — the
    // lookup is workspace-scoped at the SQL, not just at the RPC layer.
    assert!(
        chats
            .complete_dispatch("other-workspace", "run-B", 0, 27, &NO_FAULTS)
            .is_err(),
        "cross-workspace completion must refuse"
    );
    assert!(
        chats
            .fail_dispatch("other-workspace", "run-B", "nope", None, 27, &NO_FAULTS)
            .is_err(),
        "cross-workspace failure must refuse"
    );

    chats
        .complete_dispatch(WS, "run-A", 0, 28, &NO_FAULTS)
        .expect("idempotent complete");

    let ended: Option<i64> = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT ended_at_ms FROM agent_run_records WHERE run_id = 'run-A'",
                [],
                |r| r.get(0),
            )
        })
        .expect("run A ended");
    assert_eq!(ended, Some(26));
}

#[test]
fn dispatch_crash_leaves_running_row_then_reclaim_makes_claimable() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = engine_db_path(&scratch).expect("db");
    {
        let mut store = open(&db, 1);
        let mut chats = LinkedChatStore::new(&mut store);
        chats
            .ensure_agent_channel(WS, "agent-1", "default", "My agent", 10, &NO_FAULTS)
            .expect("agent");
        chats
            .start_channel_thread(
                &start_thread("agent-1", "t1", "mA", "@agent", ChatActorKind::Human, 20),
                &NO_FAULTS,
            )
            .expect("start");
        chats
            .enqueue_dispatch(WS, "mA", "default", "t1", 21, &NO_FAULTS)
            .expect("enqueue");
        chats
            .claim_next_pending(WS, "default", "run-1", "agent", None, 22, &NO_FAULTS)
            .expect("claim")
            .expect("some");
    }
    let mut store = open(&db, 2);
    let mut chats = LinkedChatStore::new(&mut store);
    assert!(
        chats
            .claim_next_pending(WS, "default", "run-2", "agent", None, 30, &NO_FAULTS)
            .expect("still wedged")
            .is_none(),
        "a dead 'running' row blocks claims until reclaimed"
    );
    let requeued = chats
        .reclaim_running_dispatches(WS, 2, 31, &NO_FAULTS)
        .expect("reclaim");
    assert_eq!(requeued, vec!["mA".to_owned()]);
    let fresh = chats
        .claim_next_pending(WS, "default", "run-3", "agent", None, 32, &NO_FAULTS)
        .expect("fresh claim")
        .expect("some");
    assert_eq!(fresh.dispatch.trigger_message_id, "mA");
    assert_eq!(fresh.run.run_id, "run-3");

    let failed: Option<String> = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT failure_reason FROM agent_run_records WHERE run_id = 'run-1'",
                [],
                |r| r.get(0),
            )
        })
        .expect("run-1 row");
    assert_eq!(failed, Some("reclaimed-crashed".to_owned()));
}

#[test]
fn save_bookmark_rejects_unsafe_destination_path() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = engine_db_path(&scratch).expect("db");
    let mut store = open(&db, 1);
    let mut chats = LinkedChatStore::new(&mut store);
    chats
        .ensure_general_channel(WS, "gen-1", 10, &NO_FAULTS)
        .expect("gen");
    chats
        .start_channel_thread(
            &start_thread("gen-1", "t1", "m0", "opening", ChatActorKind::Human, 20),
            &NO_FAULTS,
        )
        .expect("start");
    let unsafe_save = SaveBookmark {
        workspace_id: WS.to_owned(),
        owner_user_id: "owner".to_owned(),
        target_kind: BookmarkTargetKind::Thread,
        target_id: "t1".to_owned(),
        mode: BookmarkMode::Live,
        destination_path: "../outside.md".to_owned(),
        now_ms: 30,
    };
    assert_eq!(
        chats
            .save_bookmark(&unsafe_save, &NO_FAULTS)
            .unwrap_err()
            .code(),
        "invalid-path"
    );
}

#[test]
fn mark_feed_seen_rejects_non_visible_coordinate() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = engine_db_path(&scratch).expect("db");
    let mut store = open(&db, 1);
    let mut chats = LinkedChatStore::new(&mut store);
    chats
        .ensure_general_channel(WS, "gen-1", 10, &NO_FAULTS)
        .expect("gen");
    chats
        .start_channel_thread(
            &start_thread("gen-1", "t1", "m0", "opening", ChatActorKind::Human, 100),
            &NO_FAULTS,
        )
        .expect("start");
    let head = encode_feed_cursor(&FeedCursorValue {
        created_at_ms: 100,
        message_id: "m0".to_owned(),
    });
    let err = chats
        .mark_feed_seen(WS, "owner", None, &head, 200, &NO_FAULTS)
        .unwrap_err();
    assert_eq!(err.code(), "invalid-follow-target");
    chats
        .set_follow(
            &SetFollow {
                workspace_id: WS.to_owned(),
                owner_user_id: "owner".to_owned(),
                replication_owner_user_id: None,
                target_kind: FollowTargetKind::Thread,
                target_id: "t1".to_owned(),
                state: FollowState::Following,
                now_ms: 150,
            },
            &NO_FAULTS,
        )
        .expect("follow");
    let state = chats
        .mark_feed_seen(WS, "owner", Some("owner"), &head, 200, &NO_FAULTS)
        .expect("now visible");
    assert_eq!(state.last_seen_created_at_ms, 100);
    assert_eq!(state.last_seen_message_id, "m0");
    let repeated = chats
        .mark_feed_seen(WS, "owner", Some("owner"), &head, 200, &NO_FAULTS)
        .expect("repeat mark");
    assert_eq!(repeated.updated_at_ms, 201);
    let rows: Vec<(i64, String, i64)> = store
        .read_with(|conn| {
            let mut stmt = conn.prepare(
                "SELECT origin_seq, payload_json, imported FROM replication_log \
                 WHERE workspace_id = ?1 AND op_kind = 'chat.feed.read.set' ORDER BY origin_seq",
            )?;
            let mapped = stmt.query_map([WS], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?;
            mapped.collect()
        })
        .expect("feed-read replication rows");
    assert_eq!(rows.len(), 2);
    assert_ne!(rows[0].0, rows[1].0);
    assert_eq!(rows[0].2, 0);
    assert_eq!(rows[1].2, 0);
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&rows[0].1).expect("first read payload"),
        json!({
            "ownerUserId": "owner",
            "lastSeenCreatedAtMs": 100,
            "lastSeenMessageId": "m0",
            "atMs": 200,
            "ownerPrivateAccountId": "owner",
        })
    );
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&rows[1].1).expect("second read payload"),
        json!({
            "ownerUserId": "owner",
            "lastSeenCreatedAtMs": 100,
            "lastSeenMessageId": "m0",
            "atMs": 201,
            "ownerPrivateAccountId": "owner",
        })
    );
}

#[test]
fn channel_slug_matches_ts_output() {
    // Node oracle (String.normalize NFC + the TS regex chain):
    assert_eq!(channel_slug_for_name("General Chat"), "general-chat");
    assert_eq!(channel_slug_for_name("  Hello_World  "), "hello-world");
    assert_eq!(channel_slug_for_name("Café Room"), "café-room");
    assert_eq!(channel_slug_for_name("Ünïcode 123!!"), "ünïcode-123");
    assert_eq!(channel_slug_for_name("---a--b---"), "a-b");
}

// =====================================================================
// NON-TAUTOLOGICAL differentials — validated against REAL TS output.
// Fixtures produced by running the exact TS algorithms under Node/V8
// (channelSlugForName, linkedChatProjectionPath, encodeFeedCursor).
// =====================================================================

#[test]
fn claim_refuses_a_run_id_already_used_anywhere() {
    // Run ids are globally unique by schema (idx_agent_run_records_run_id).
    // A caller-supplied id that already exists — an ended run in this
    // workspace, or any run in another — must refuse cleanly. Mutation
    // check: drop the run_id_taken probe in `claim_next_pending` — both
    // claims below then hit the UNIQUE violation mid-transaction and
    // surface a storage error instead of "invalid-input".
    const OTHER_WS: &str = "ws-2";
    let scratch = ScratchDir::new().expect("scratch");
    let db = engine_db_path(&scratch).expect("db");
    let mut store = open(&db, 1);
    let mut chats = LinkedChatStore::new(&mut store);
    for ws in [WS, OTHER_WS] {
        chats
            .ensure_agent_channel(ws, "agent-x", "default", "My agent", 10, &NO_FAULTS)
            .expect("agent");
        let mut start = start_thread("agent-x", "t-x", "m-x", "@agent", ChatActorKind::Human, 20);
        start.workspace_id = ws.to_owned();
        chats
            .start_channel_thread(&start, &NO_FAULTS)
            .expect("start");
        chats
            .enqueue_dispatch(ws, "m-x", "default", "t-x", 21, &NO_FAULTS)
            .expect("enqueue");
    }

    chats
        .claim_next_pending(WS, "default", "run-taken", "agent", None, 22, &NO_FAULTS)
        .expect("claim")
        .expect("some");
    chats
        .complete_dispatch(WS, "run-taken", 0, 23, &NO_FAULTS)
        .expect("complete");
    let start_y = {
        let mut start = start_thread("agent-x", "t-y", "m-y", "@agent", ChatActorKind::Human, 24);
        start.workspace_id = WS.to_owned();
        // Its own thread, not t-x's conversation in the same agent DM.
        start.own_thread = true;
        start
    };
    chats
        .start_channel_thread(&start_y, &NO_FAULTS)
        .expect("start y");
    chats
        .enqueue_dispatch(WS, "m-y", "default", "t-y", 24, &NO_FAULTS)
        .expect("enqueue y");
    assert_eq!(
        chats
            .claim_next_pending(WS, "default", "run-taken", "agent", None, 25, &NO_FAULTS)
            .expect_err("ended-run id reuse must refuse")
            .code(),
        "invalid-input"
    );

    // ws-2 reusing ws-1's live id also refuses (instead of colliding with
    // the global unique index inside the claim transaction).
    chats
        .claim_next_pending(WS, "default", "run-fresh", "agent", None, 26, &NO_FAULTS)
        .expect("fresh claim")
        .expect("some");
    assert_eq!(
        chats
            .claim_next_pending(
                OTHER_WS,
                "default",
                "run-fresh",
                "agent",
                None,
                27,
                &NO_FAULTS,
            )
            .expect_err("cross-workspace id reuse must refuse")
            .code(),
        "invalid-input"
    );
}

#[test]
fn local_actor_key_commits_with_the_message_and_replays_its_original_admission() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = engine_db_path(&scratch).expect("db");
    let key = r#"{"kind":"installation","installationId":"device"}"#;
    let later_key = r#"{"kind":"account","issuer":"https://accounts.test","userId":"alice"}"#;
    {
        let mut store = open(&db, 1);
        LinkedChatStore::new(&mut store)
            .ensure_general_channel(WS, "gen", 10, &NO_FAULTS)
            .expect("channel");
    }
    for point in [
        FaultPoint::StorageBeforePersist,
        FaultPoint::StorageAfterCommitBeforeAck,
    ] {
        let mut input = start_thread(
            "gen",
            "key-thread",
            "key-opening",
            "Hello",
            ChatActorKind::Human,
            20,
        );
        input.author_user_id = None;
        input.request_id = Some("key-start".to_owned());
        {
            let mut store = open(&db, 2);
            let faults = ScriptedFaults::crash_at(point);
            let result = LinkedChatStore::new(&mut store).start_admitted_channel_thread(
                &input,
                Some(key),
                faults.as_ref(),
            );
            assert!(result.is_err());
            assert!(faults.fired());
        }
        let mut store = open(&db, 3);
        let saved: Vec<Option<String>> = store
            .read_with(|conn| {
                let mut query = conn.prepare("SELECT author_actor_key FROM chat_messages")?;
                query.query_map([], |row| row.get(0))?.collect()
            })
            .expect("saved keys");
        if point == FaultPoint::StorageBeforePersist {
            assert!(saved.is_empty());
            continue;
        }
        assert_eq!(saved, vec![Some(key.to_owned())]);
        let (_, replay) = LinkedChatStore::new(&mut store)
            .start_admitted_channel_thread(&input, Some(later_key), &NO_FAULTS)
            .expect("replay");
        assert_eq!(replay.author_actor_key.as_deref(), Some(key));
    }
    let mut reply = send_msg("key-thread", "key-reply", None, "Reply", 25);
    reply.request_id = Some("key-send".to_owned());
    {
        let mut store = open(&db, 4);
        let faults = ScriptedFaults::crash_at(FaultPoint::StorageAfterCommitBeforeAck);
        assert!(
            LinkedChatStore::new(&mut store)
                .send_admitted_message(&reply, Some(later_key), faults.as_ref())
                .is_err()
        );
        assert!(faults.fired());
    }
    let mut store = open(&db, 5);
    let replay = LinkedChatStore::new(&mut store)
        .send_admitted_message(&reply, Some(key), &NO_FAULTS)
        .expect("reply replay");
    assert_eq!(replay.author_actor_key.as_deref(), Some(later_key));
}

#[test]
fn an_agent_message_keeps_what_it_reported_and_sends_it_to_other_computers() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = engine_db_path(&scratch).expect("db");
    let mut store = open(&db, 1);
    let reported = ChatReportedAgent {
        product: Some("Claude Code".to_owned()),
        version: Some("2.1".to_owned()),
        model: Some("Claude Opus 5.5".to_owned()),
    };
    {
        let mut chats = LinkedChatStore::new(&mut store);
        chats
            .ensure_general_channel(WS, "gen", 10, &NO_FAULTS)
            .expect("channel");
        let mut post = start_thread("gen", "t1", "m1", "Opened a PR", ChatActorKind::Agent, 20);
        post.author_owner_display_name = Some("Ice".to_owned());
        post.author_reported = Some(reported.clone());
        let (_, opening) = chats.start_channel_thread(&post, &NO_FAULTS).expect("post");
        assert_eq!(opening.author_reported.as_ref(), Some(&reported));

        let mut reply = send_msg("t1", "m2", None, "Checks pass", 30);
        reply.author_kind = ChatActorKind::Agent;
        reply.author_owner_display_name = Some("Ice".to_owned());
        reply.author_reported = Some(ChatReportedAgent {
            product: Some("Claude Code".to_owned()),
            ..ChatReportedAgent::default()
        });
        chats.send_message(&reply, &NO_FAULTS).expect("reply");
        assert_eq!(
            chats.get_message(WS, "m2").expect("read").author_reported,
            Some(ChatReportedAgent {
                product: Some("Claude Code".to_owned()),
                ..ChatReportedAgent::default()
            })
        );

        let mut silent = send_msg("t1", "m3", None, "Done", 40);
        silent.author_kind = ChatActorKind::Agent;
        silent.author_reported = Some(ChatReportedAgent::default());
        chats.send_message(&silent, &NO_FAULTS).expect("silent");
        assert_eq!(
            chats.get_message(WS, "m3").expect("read").author_reported,
            None
        );

        let listed = chats
            .list_channel_threads(WS, "gen", None, 10)
            .expect("posts");
        assert_eq!(
            listed[0]
                .opening_message
                .as_ref()
                .and_then(|opening| opening.author_reported.as_ref()),
            Some(&reported)
        );
    }

    let payloads: Vec<serde_json::Value> = store
        .read_with(|conn| {
            let mut query = conn.prepare(
                "SELECT payload_json FROM replication_log \
                 WHERE workspace_id = ?1 AND op_kind = 'chat.message.append' ORDER BY origin_seq",
            )?;
            query
                .query_map([WS], |row| row.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<String>>>()
        })
        .expect("journaled messages")
        .iter()
        .map(|payload: &String| serde_json::from_str(payload).expect("json"))
        .collect();
    assert_eq!(
        payloads
            .iter()
            .map(|payload| payload.get("authorReported").cloned())
            .collect::<Vec<_>>(),
        vec![
            Some(json!({"product": "Claude Code", "version": "2.1", "model": "Claude Opus 5.5"})),
            Some(json!({"product": "Claude Code"})),
            None,
        ],
    );
}

#[test]
fn only_a_valid_agent_report_is_kept() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = engine_db_path(&scratch).expect("db");
    let mut store = open(&db, 1);
    let mut chats = LinkedChatStore::new(&mut store);
    chats
        .ensure_general_channel(WS, "gen", 10, &NO_FAULTS)
        .expect("channel");
    chats
        .start_channel_thread(
            &start_thread("gen", "t1", "m1", "Hello", ChatActorKind::Human, 20),
            &NO_FAULTS,
        )
        .expect("post");
    let product = |value: &str| ChatReportedAgent {
        product: Some(value.to_owned()),
        ..ChatReportedAgent::default()
    };
    let refused = [
        (ChatActorKind::Human, product("Claude Code")),
        (ChatActorKind::Agent, product("")),
        (ChatActorKind::Agent, product(" Claude Code")),
        (ChatActorKind::Agent, product("Claude\nCode")),
        (
            ChatActorKind::Agent,
            product(&"x".repeat(MAX_REPORTED_AGENT_CHARS + 1)),
        ),
        // JavaScript counts an emoji as two units, so 40 of them are 80.
        (
            ChatActorKind::Agent,
            ChatReportedAgent {
                model: Some("\u{1F600}".repeat(40)),
                ..ChatReportedAgent::default()
            },
        ),
        // JavaScript's trim strips a byte order mark; Rust's does not.
        (ChatActorKind::Agent, product("\u{FEFF}Claude Code")),
        (
            ChatActorKind::Agent,
            ChatReportedAgent {
                version: Some("2.1".to_owned()),
                ..ChatReportedAgent::default()
            },
        ),
    ];
    for (index, (kind, reported)) in refused.into_iter().enumerate() {
        let mut message = send_msg("t1", &format!("bad-{index}"), None, "Hi", 30);
        message.author_kind = kind;
        message.author_reported = Some(reported);
        assert!(
            matches!(
                chats.send_message(&message, &NO_FAULTS),
                Err(DomainError::InvalidInput { .. })
            ),
            "case {index} is refused"
        );
    }
    let mut longest = send_msg("t1", "longest", None, "Hi", 40);
    longest.author_kind = ChatActorKind::Agent;
    longest.author_reported = Some(product(&"x".repeat(MAX_REPORTED_AGENT_CHARS)));
    chats
        .send_message(&longest, &NO_FAULTS)
        .expect("the longest product fits");
    let mut emoji = send_msg("t1", "emoji", None, "Hi", 50);
    emoji.author_kind = ChatActorKind::Agent;
    emoji.author_reported = Some(ChatReportedAgent {
        model: Some("\u{1F600}".repeat(MAX_REPORTED_AGENT_CHARS / 2)),
        ..ChatReportedAgent::default()
    });
    chats
        .send_message(&emoji, &NO_FAULTS)
        .expect("64 units of emoji fit");
}
