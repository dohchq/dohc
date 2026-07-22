//! R09 chats-domain traces: channel/thread/message round-trips, the atomic
//! thread+first-message boundary (crash mid-send strands no empty thread),
//! keyset pagination at limit-1/limit/limit+1, the mark-read CAS + monotonic
//! clamp, follows/feed/bookmark generation-CAS, dispatch claim idempotency, and
//! the NON-TAUTOLOGICAL parity differentials (channel slug, projection path,
//! base64url feed cursor) validated against real TS output — not Rust's own.

use dohc_engine_domain::{
    AGENT_CHANNEL_WIRE_ID, BookmarkMode, BookmarkTargetKind, ChatActorKind, ChatChannelKind,
    FeedCursorValue, FollowState, FollowTargetKind, GENERAL_CHANNEL_WIRE_ID, LinkedChatStore,
    NoFaults, SaveBookmark, SendMessage, SetFollow, StartChannelThread,
    base32_lowercase_no_padding, bookmark_id_for, channel_slug_for_name, decode_feed_cursor,
    encode_feed_cursor, linked_chat_projection_path,
};
use dohc_engine_storage::{EngineStore, FaultPoint, StorageError};
use dohc_engine_testkit::{ScratchDir, ScriptedFaults};
use serde_json::json;
use sha2::{Digest, Sha256};

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
        workspace_id: WS.to_owned(),
        channel_id: channel_id.to_owned(),
        thread_id: thread_id.to_owned(),
        message_id: message_id.to_owned(),
        title: None,
        author_kind: kind,
        author_display_name: "Ada".to_owned(),
        author_user_id: Some("user-ada".to_owned()),
        origin: None,
        body: body.to_owned(),
        now_ms: now,
        request_id: None,
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
        workspace_id: WS.to_owned(),
        thread_id: thread_id.to_owned(),
        message_id: message_id.to_owned(),
        author_kind: ChatActorKind::Human,
        author_display_name: "Ada".to_owned(),
        author_user_id: Some("user-ada".to_owned()),
        parent_message_id: parent.map(str::to_owned),
        origin: None,
        body: body.to_owned(),
        now_ms: now,
        request_id: None,
    }
}

// ------------------------------------------------------- channel round-trips

#[test]
fn create_list_find_channel_round_trip() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    let mut store = open(&db, 1);
    let mut chats = LinkedChatStore::new(&mut store);

    let ch = chats
        .create_channel(
            WS,
            "chan-1",
            "General Chat",
            ChatChannelKind::Channel,
            10,
            &NO_FAULTS,
        )
        .expect("create");
    assert_eq!(ch.slug, "general-chat");
    assert_eq!(ch.kind, ChatChannelKind::Channel);

    let listed = chats.list_channels(WS).expect("list");
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].channel.channel_id, "chan-1");
    assert_eq!(listed[0].thread_count, 0);
    assert_eq!(listed[0].unread_count, 0);

    let found = chats
        .find_channel_by_slug(WS, "general-chat")
        .expect("find");
    assert_eq!(found.map(|c| c.channel_id), Some("chan-1".to_owned()));
}

#[test]
fn reserved_channel_ids_refuse_and_wire_mapping_is_first_writer_wins() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    let mut store = open(&db, 1);
    {
        let mut chats = LinkedChatStore::new(&mut store);
        for reserved in [GENERAL_CHANNEL_WIRE_ID, AGENT_CHANNEL_WIRE_ID] {
            let err = chats
                .create_channel(
                    WS,
                    reserved,
                    &format!("Reserved {reserved}"),
                    ChatChannelKind::Channel,
                    2,
                    &NO_FAULTS,
                )
                .unwrap_err();
            assert_eq!(err.code(), "invalid-input");
        }
        chats
            .create_channel(
                WS,
                "original-channel",
                "Original",
                ChatChannelKind::Channel,
                3,
                &NO_FAULTS,
            )
            .expect("original channel");
    }
    store
        .write_with(&NO_FAULTS, |tx| {
            tx.execute(
                "INSERT INTO chat_channel_wire_ids (workspace_id, wire_id, channel_id) \
                 VALUES (?1, ?2, ?3)",
                rusqlite::params![WS, GENERAL_CHANNEL_WIRE_ID, "original-channel"],
            )
            .map_err(StorageError::persist_public)?;
            Ok::<_, StorageError>(())
        })
        .expect("plant first mapping");
    let mut chats = LinkedChatStore::new(&mut store);
    chats
        .ensure_general_channel(WS, "later-general", 4, &NO_FAULTS)
        .expect("ensure general");
    let mapped: String = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT channel_id FROM chat_channel_wire_ids \
                 WHERE workspace_id = ?1 AND wire_id = ?2",
                rusqlite::params![WS, GENERAL_CHANNEL_WIRE_ID],
                |row| row.get(0),
            )
            .map_err(StorageError::corrupt_public)
        })
        .expect("wire mapping");
    assert_eq!(mapped, "original-channel");
}

#[test]
fn list_channels_fails_closed_on_negative_read_state() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    let mut store = open(&db, 1);
    {
        let mut chats = LinkedChatStore::new(&mut store);
        chats
            .ensure_general_channel(WS, "gen-1", 10, &NO_FAULTS)
            .expect("general");
        chats
            .start_channel_thread(
                &start_thread("gen-1", "t1", "m1", "hello", ChatActorKind::Human, 20),
                &NO_FAULTS,
            )
            .expect("start");
    }

    // Deliberately bypass the domain validation to model a tampered persisted row.
    store
        .read_with(|conn| {
            conn.execute(
                "UPDATE chat_thread_read_state SET last_read_sequence = -1 \
                 WHERE workspace_id = ?1 AND thread_id = ?2",
                rusqlite::params![WS, "t1"],
            )
        })
        .expect("tamper read state");

    let chats = LinkedChatStore::new(&mut store);
    let error = chats.list_channels(WS).unwrap_err();
    assert_eq!(error.code(), "state-corrupt");
}

#[test]
fn duplicate_slug_and_reserved_name_and_agent_kind_fail_closed() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    let mut store = open(&db, 1);
    let mut chats = LinkedChatStore::new(&mut store);
    chats
        .create_channel(
            WS,
            "chan-1",
            "Planning",
            ChatChannelKind::Channel,
            10,
            &NO_FAULTS,
        )
        .expect("create");

    // Same slug (case/space-insensitive) → channel-exists.
    let dup = chats
        .create_channel(
            WS,
            "chan-2",
            "  planning  ",
            ChatChannelKind::Channel,
            11,
            &NO_FAULTS,
        )
        .unwrap_err();
    assert_eq!(dup.code(), "channel-exists");

    // Reserved "My agent" name → channel-exists.
    let reserved = chats
        .create_channel(
            WS,
            "chan-3",
            "My agent",
            ChatChannelKind::Channel,
            12,
            &NO_FAULTS,
        )
        .unwrap_err();
    assert_eq!(reserved.code(), "channel-exists");

    // agent kind is provisioned automatically → invalid-channel-kind.
    let agent = chats
        .create_channel(WS, "chan-4", "Bots", ChatChannelKind::Agent, 13, &NO_FAULTS)
        .unwrap_err();
    assert_eq!(agent.code(), "invalid-channel-kind");
}

#[test]
fn ensure_general_and_agent_channels_are_idempotent_with_wellknown_wire_ids() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    let mut store = open(&db, 1);
    let mut chats = LinkedChatStore::new(&mut store);

    let g1 = chats
        .ensure_general_channel(WS, "gen-1", 10, &NO_FAULTS)
        .expect("g1");
    let g2 = chats
        .ensure_general_channel(WS, "gen-2", 11, &NO_FAULTS)
        .expect("g2");
    assert_eq!(g1.channel_id, g2.channel_id, "general is idempotent");
    assert_eq!(g1.slug, "general");

    let a1 = chats
        .ensure_agent_channel(WS, "agent-1", 12, &NO_FAULTS)
        .expect("a1");
    let a2 = chats
        .ensure_agent_channel(WS, "agent-2", 13, &NO_FAULTS)
        .expect("a2");
    assert_eq!(a1.channel_id, a2.channel_id, "agent is idempotent");
    assert_eq!(a1.kind, ChatChannelKind::Agent);

    // Both well-known wire ids resolve to their converged channel.
    store
        .read_with(|conn| {
            let g: String = conn
                .query_row(
                    "SELECT channel_id FROM chat_channel_wire_ids WHERE workspace_id=?1 AND wire_id=?2",
                    rusqlite::params![WS, GENERAL_CHANNEL_WIRE_ID],
                    |r| r.get(0),
                )
                .expect("g wire");
            let a: String = conn
                .query_row(
                    "SELECT channel_id FROM chat_channel_wire_ids WHERE workspace_id=?1 AND wire_id=?2",
                    rusqlite::params![WS, AGENT_CHANNEL_WIRE_ID],
                    |r| r.get(0),
                )
                .expect("a wire");
            assert_eq!(g, g1.channel_id);
            assert_eq!(a, a1.channel_id);
            Ok::<_, rusqlite::Error>(())
        })
        .expect("wire lookups");
}

// ------------------------------------------- atomic thread + first message

#[test]
fn start_channel_thread_creates_thread_and_first_message_atomically() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    let mut store = open(&db, 1);
    let mut chats = LinkedChatStore::new(&mut store);
    chats
        .ensure_general_channel(WS, "gen-1", 10, &NO_FAULTS)
        .expect("gen");

    let (thread, message) = chats
        .start_channel_thread(
            &start_thread("gen-1", "t1", "m1", "hello world", ChatActorKind::Human, 20),
            &NO_FAULTS,
        )
        .expect("start");
    assert_eq!(thread.channel_id, Some("gen-1".to_owned()));
    assert_eq!(message.message_order, 0);
    assert_eq!(message.body, "hello world");

    // Human author's opening message advances the read cursor to 1.
    let rs = chats.read_state(WS, "t1").expect("read state");
    assert_eq!(rs.last_read_sequence, 1);
    assert_eq!(rs.revision, 1);
}

#[test]
fn untitled_thread_responses_and_listings_use_first_message_title() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    let mut store = open(&db, 1);
    {
        let mut chats = LinkedChatStore::new(&mut store);
        chats
            .ensure_general_channel(WS, "gen-1", 10, &NO_FAULTS)
            .expect("general");
        let (short, _) = chats
            .start_channel_thread(
                &start_thread(
                    "gen-1",
                    "short",
                    "short-message",
                    "line   one\nrest",
                    ChatActorKind::Human,
                    20,
                ),
                &NO_FAULTS,
            )
            .expect("short");
        assert_eq!(short.title, "line one");
        let long_body = "x".repeat(81);
        let (long, _) = chats
            .start_channel_thread(
                &start_thread(
                    "gen-1",
                    "long",
                    "long-message",
                    &long_body,
                    ChatActorKind::Human,
                    21,
                ),
                &NO_FAULTS,
            )
            .expect("long");
        assert_eq!(long.title, format!("{}…", "x".repeat(79)));
    }
    store
        .write_with(&NO_FAULTS, |tx| {
            tx.execute(
                "INSERT INTO chat_threads \
                 (workspace_id, thread_id, title, created_at_ms, updated_at_ms, channel_id) \
                 VALUES (?1, 'empty', '', 22, 22, 'gen-1')",
                [WS],
            )
            .map_err(StorageError::persist_public)?;
            Ok::<_, StorageError>(())
        })
        .expect("insert empty thread");
    let chats = LinkedChatStore::new(&mut store);
    let listed = chats.list_threads(WS).expect("list");
    assert_eq!(
        listed
            .iter()
            .find(|thread| thread.thread_id == "short")
            .expect("short listed")
            .title,
        "line one"
    );
    assert_eq!(
        listed
            .iter()
            .find(|thread| thread.thread_id == "long")
            .expect("long listed")
            .title,
        format!("{}…", "x".repeat(79))
    );
    assert_eq!(
        listed
            .iter()
            .find(|thread| thread.thread_id == "empty")
            .expect("empty listed")
            .title,
        "New chat"
    );
}

#[test]
fn thread_header_message_id_is_reserved_before_search_index_write() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    let mut store = open(&db, 1);
    let mut chats = LinkedChatStore::new(&mut store);
    chats
        .ensure_general_channel(WS, "gen-1", 10, &NO_FAULTS)
        .expect("general");
    let invalid_start = start_thread(
        "gen-1",
        "bad",
        "__thread__",
        "bad",
        ChatActorKind::Human,
        19,
    );
    assert_eq!(
        chats
            .start_channel_thread(&invalid_start, &NO_FAULTS)
            .unwrap_err()
            .code(),
        "invalid-input"
    );
    chats
        .start_channel_thread(
            &start_thread("gen-1", "t1", "m1", "opening", ChatActorKind::Human, 20),
            &NO_FAULTS,
        )
        .expect("valid start");
    let sentinel = send_msg("t1", "__thread__", None, "overwrite", 21);
    assert_eq!(
        chats
            .send_message(&sentinel, &NO_FAULTS)
            .unwrap_err()
            .code(),
        "invalid-input"
    );
    let header: String = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT text FROM engine_search_chat_messages_fts \
                 WHERE workspace_id = ?1 AND thread_id = 't1' AND message_id = '__thread__'",
                [WS],
                |row| row.get(0),
            )
        })
        .expect("thread header");
    assert_eq!(header, "opening");
}

#[test]
fn feed_cursor_message_id_cap_applies_to_start_and_send() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    let mut store = open(&db, 1);
    let mut chats = LinkedChatStore::new(&mut store);
    chats
        .ensure_general_channel(WS, "gen-1", 10, &NO_FAULTS)
        .expect("general");

    let too_long = "x".repeat(257);
    let too_many_bytes = "😀".repeat(200);
    let control_id = "m\n1";
    let invalid_start = start_thread(
        "gen-1",
        "too-long",
        &too_long,
        "opening",
        ChatActorKind::Human,
        20,
    );
    assert_eq!(
        chats
            .start_channel_thread(&invalid_start, &NO_FAULTS)
            .unwrap_err()
            .code(),
        "invalid-input"
    );
    let invalid_byte_heavy_start = start_thread(
        "gen-1",
        "too-many-bytes",
        &too_many_bytes,
        "opening",
        ChatActorKind::Human,
        20,
    );
    assert_eq!(
        chats
            .start_channel_thread(&invalid_byte_heavy_start, &NO_FAULTS)
            .unwrap_err()
            .code(),
        "invalid-input"
    );
    let invalid_control_start = start_thread(
        "gen-1",
        "control-id",
        control_id,
        "opening",
        ChatActorKind::Human,
        20,
    );
    assert_eq!(
        chats
            .start_channel_thread(&invalid_control_start, &NO_FAULTS)
            .unwrap_err()
            .code(),
        "invalid-input"
    );

    let max_id = format!("{}abc", "😀".repeat(89));
    assert_eq!(max_id.len(), 359);
    assert_eq!(
        encode_feed_cursor(&FeedCursorValue {
            created_at_ms: i64::MIN,
            message_id: max_id.clone(),
        })
        .len(),
        512
    );
    chats
        .start_channel_thread(
            &start_thread(
                "gen-1",
                "valid",
                &max_id,
                "opening",
                ChatActorKind::Human,
                21,
            ),
            &NO_FAULTS,
        )
        .expect("exact cursor byte-budget id");
    let invalid_send = send_msg("valid", &too_long, None, "reply", 22);
    assert_eq!(
        chats
            .send_message(&invalid_send, &NO_FAULTS)
            .unwrap_err()
            .code(),
        "invalid-input"
    );
    let invalid_byte_heavy_send = send_msg("valid", &too_many_bytes, None, "reply", 22);
    assert_eq!(
        chats
            .send_message(&invalid_byte_heavy_send, &NO_FAULTS)
            .unwrap_err()
            .code(),
        "invalid-input"
    );
    let invalid_control_send = send_msg("valid", control_id, None, "reply", 22);
    assert_eq!(
        chats
            .send_message(&invalid_control_send, &NO_FAULTS)
            .unwrap_err()
            .code(),
        "invalid-input"
    );
    chats
        .send_message(&send_msg("valid", "older", None, "older", 20), &NO_FAULTS)
        .expect("older message");
    chats
        .set_follow(
            &SetFollow {
                workspace_id: WS.to_owned(),
                owner_user_id: "cursor-owner".to_owned(),
                replication_owner_user_id: None,
                target_kind: FollowTargetKind::Thread,
                target_id: "valid".to_owned(),
                state: FollowState::Following,
                now_ms: 23,
            },
            &NO_FAULTS,
        )
        .expect("follow");
    let page = chats
        .list_personal_feed(WS, "cursor-owner", Some(1), None)
        .expect("feed page");
    assert_eq!(page.items[0].message.message_id, max_id);
    let next = page.next_cursor.expect("exact-budget next cursor");
    let seen = chats
        .mark_feed_seen(WS, "cursor-owner", None, &next, 24, &NO_FAULTS)
        .expect("next cursor marks seen");
    assert_eq!(seen.last_seen_message_id, max_id);
}

#[test]
fn crash_mid_send_strands_no_empty_thread() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    {
        let mut store = open(&db, 1);
        let mut chats = LinkedChatStore::new(&mut store);
        chats
            .ensure_general_channel(WS, "gen-1", 10, &NO_FAULTS)
            .expect("gen");
    }
    // Arm a crash BEFORE persist during the atomic thread+message write.
    {
        let mut store = open(&db, 2);
        let faults = ScriptedFaults::crash_at(FaultPoint::StorageBeforePersist);
        let mut chats = LinkedChatStore::new(&mut store);
        let result = chats.start_channel_thread(
            &start_thread("gen-1", "t1", "m1", "hi", ChatActorKind::Human, 20),
            faults.as_ref(),
        );
        assert!(result.is_err(), "crash surfaces as an error");
        assert!(faults.fired(), "the fault fired");
        // simulated process death
    }
    // Reopen: neither the thread nor the message is durable — no empty thread.
    let mut store = open(&db, 3);
    let chats = LinkedChatStore::new(&mut store);
    assert!(chats.list_threads(WS).expect("threads").is_empty());
    let count: i64 = store
        .read_with(|conn| conn.query_row("SELECT COUNT(*) FROM chat_messages", [], |r| r.get(0)))
        .expect("count");
    assert_eq!(count, 0, "no stranded message either");
}

// ------------------------------------------------ send + keyset pagination

#[test]
fn send_message_reply_parent_must_exist_in_thread() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
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

    // Unknown parent → message-not-found.
    let bad = chats
        .send_message(
            &send_msg("t1", "m1", Some("does-not-exist"), "reply", 21),
            &NO_FAULTS,
        )
        .unwrap_err();
    assert_eq!(bad.code(), "message-not-found");

    // Existing parent in the same thread → ok, order increments.
    let ok = chats
        .send_message(&send_msg("t1", "m1", Some("m0"), "reply", 22), &NO_FAULTS)
        .expect("send");
    assert_eq!(ok.message_order, 1);
    assert_eq!(ok.parent_message_id, Some("m0".to_owned()));
}

#[test]
fn list_messages_keyset_pagination_limit_minus_one_limit_plus_one() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
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
    for i in 1..=3 {
        chats
            .send_message(
                &send_msg("t1", &format!("m{i}"), None, &format!("msg {i}"), 20 + i),
                &NO_FAULTS,
            )
            .expect("send");
    }
    // 4 messages total (orders 0..=3).
    // limit-1 (3): a following page exists.
    let p3 = chats.list_messages(WS, "t1", 3, None).expect("p3");
    assert_eq!(p3.messages.len(), 3);
    assert_eq!(p3.next_after_message_order, Some(2));
    // limit (4): exactly the page, no cursor.
    let p4 = chats.list_messages(WS, "t1", 4, None).expect("p4");
    assert_eq!(p4.messages.len(), 4);
    assert_eq!(p4.next_after_message_order, None);
    // limit+1 (5): all four, no cursor.
    let p5 = chats.list_messages(WS, "t1", 5, None).expect("p5");
    assert_eq!(p5.messages.len(), 4);
    assert_eq!(p5.next_after_message_order, None);
    // Continue from the p3 cursor: the remaining message.
    let rest = chats.list_messages(WS, "t1", 3, Some(2)).expect("rest");
    assert_eq!(rest.messages.len(), 1);
    assert_eq!(rest.messages[0].message_order, 3);
}

// ------------------------------------------------- mark-read CAS + clamp

#[test]
fn mark_thread_read_cas_monotonic_and_over_count_repair() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
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

    // Advance to 1 (revision 0 -> 1).
    let r1 = chats
        .mark_thread_read(WS, "t1", 1, None, 30, &NO_FAULTS)
        .expect("r1");
    assert_eq!(r1.last_read_sequence, 1);
    assert_eq!(r1.revision, 1);

    // Monotonic: a lower target is a no-op (revision unchanged).
    let r_low = chats
        .mark_thread_read(WS, "t1", 0, None, 31, &NO_FAULTS)
        .expect("low");
    assert_eq!(r_low.last_read_sequence, 1);
    assert_eq!(r_low.revision, 1);

    // Clamp: target beyond the 2 messages clamps to 2 (revision -> 2).
    let r_clamp = chats
        .mark_thread_read(WS, "t1", 99, None, 32, &NO_FAULTS)
        .expect("clamp");
    assert_eq!(r_clamp.last_read_sequence, 2);
    assert_eq!(r_clamp.revision, 2);

    // Stale CAS: expected revision 0 while current is 2 → mismatch.
    let stale = chats
        .mark_thread_read(WS, "t1", 2, Some(0), 33, &NO_FAULTS)
        .unwrap_err();
    assert_eq!(stale.code(), "read-state-revision-mismatch");

    // Correct CAS: expected 2 → no-op advance (already at 2), revision holds.
    let fresh = chats
        .mark_thread_read(WS, "t1", 2, Some(2), 34, &NO_FAULTS)
        .expect("fresh");
    assert_eq!(fresh.revision, 2);
}

// -------------------------------------------------- follows + personal feed

#[test]
fn follow_lww_last_write_wins_and_lists_active() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    let mut store = open(&db, 1);
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

    let follow = |ts: i64, state: FollowState| SetFollow {
        workspace_id: WS.to_owned(),
        owner_user_id: "owner".to_owned(),
        replication_owner_user_id: None,
        target_kind: FollowTargetKind::Thread,
        target_id: "t1".to_owned(),
        state,
        now_ms: ts,
    };
    chats
        .set_follow(&follow(10, FollowState::Following), &NO_FAULTS)
        .expect("f1");
    // A local mutation advances past the prior register even if the wall clock
    // moved backward, matching the TS store's monotonic local path.
    chats
        .set_follow(&follow(5, FollowState::Unfollowed), &NO_FAULTS)
        .expect("f2");
    assert!(chats.list_follows(WS, "owner").expect("empty").is_empty());

    let active = chats
        .set_follow(&follow(20, FollowState::Following), &NO_FAULTS)
        .expect("f3");
    assert_eq!(active.state, FollowState::Following);
    assert!(active.origin_id.starts_with("origin_"));
    assert_eq!(active.origin_seq, 3);
}

#[test]
fn local_follow_uses_persisted_origin_and_next_journal_sequence() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    let mut store = open(&db, 1);
    {
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
    }
    store
        .read_with(|conn| {
            conn.execute(
                "UPDATE sync_identity SET origin_id = 'origin-fixed', \
                 replication_epoch = 'epoch-fixed', stream_identity = 'stream-fixed' \
                 WHERE workspace_id = ?1",
                [WS],
            )?;
            conn.execute(
                "INSERT INTO replication_log \
                 (workspace_id, origin_id, origin_seq, op_kind, payload_json, recorded_at_ms, imported) \
                 VALUES (?1, 'origin-fixed', 7, 'seed', '{}', 4, 0)",
                [WS],
            )
        })
        .expect("seed local replication coordinate");

    let mut chats = LinkedChatStore::new(&mut store);
    let follow = chats
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
        .expect("follow");
    assert_eq!(follow.origin_id, "origin-fixed");
    assert_eq!(follow.origin_seq, 8);
}

#[test]
fn local_follow_timestamp_advances_past_same_millisecond_unfollow() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    let mut store = open(&db, 1);
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
    let local = |state| SetFollow {
        workspace_id: WS.to_owned(),
        owner_user_id: "owner".to_owned(),
        replication_owner_user_id: Some("owner".to_owned()),
        target_kind: FollowTargetKind::Thread,
        target_id: "t1".to_owned(),
        state,
        now_ms: 100,
    };
    let unfollowed = chats
        .set_follow(&local(FollowState::Unfollowed), &NO_FAULTS)
        .expect("unfollow");
    let followed = chats
        .set_follow(&local(FollowState::Following), &NO_FAULTS)
        .expect("follow");
    assert_eq!(unfollowed.updated_at_ms, 100);
    assert_eq!(followed.updated_at_ms, 101);
    assert_eq!(followed.state, FollowState::Following);
    assert_eq!(unfollowed.origin_id, followed.origin_id);
    assert_eq!(followed.origin_seq, unfollowed.origin_seq + 1);
    let rows: Vec<(i64, String, i64)> = store
        .read_with(|conn| {
            let mut stmt = conn.prepare(
                "SELECT origin_seq, payload_json, imported FROM replication_log \
                 WHERE workspace_id = ?1 AND op_kind = 'chat.follow.set' ORDER BY origin_seq",
            )?;
            let mapped = stmt.query_map([WS], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?;
            mapped.collect()
        })
        .expect("follow replication rows");
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[1].0, rows[0].0 + 1);
    assert_eq!(rows[0].2, 0);
    assert_eq!(rows[1].2, 0);
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&rows[0].1).expect("unfollow payload"),
        json!({
            "ownerUserId": "owner",
            "targetKind": "thread",
            "targetId": "t1",
            "state": "unfollowed",
            "atMs": 100,
        })
    );
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&rows[1].1).expect("follow payload"),
        json!({
            "ownerUserId": "owner",
            "targetKind": "thread",
            "targetId": "t1",
            "state": "following",
            "atMs": 101,
        })
    );
}

#[test]
fn follow_and_feed_read_journaling_require_matching_replication_owner() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    let mut store = open(&db, 1);
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
    assert_eq!(follow_ops(&store), 0);

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
    assert_eq!(follow_ops(&store), 0);

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
    assert_eq!(follow_ops(&store), 1);

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
fn core_chat_creates_journal_exact_relay_payloads() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    let mut store = open(&db, 1);
    let mut chats = LinkedChatStore::new(&mut store);
    chats
        .ensure_general_channel(WS, "gen-1", 10, &NO_FAULTS)
        .expect("general");
    let mut opening = start_thread(
        "gen-1",
        "thread-1",
        "message-1",
        "opening",
        ChatActorKind::Human,
        20,
    );
    opening.title = Some("Launch".to_owned());
    opening.author_user_id = None;
    chats
        .start_channel_thread(&opening, &NO_FAULTS)
        .expect("thread");
    let mut reply = send_msg("thread-1", "message-2", Some("message-1"), "reply", 30);
    reply.origin = Some("cli".to_owned());
    chats.send_message(&reply, &NO_FAULTS).expect("reply");
    chats
        .set_follow(
            &SetFollow {
                workspace_id: WS.to_owned(),
                owner_user_id: "owner".to_owned(),
                replication_owner_user_id: None,
                target_kind: FollowTargetKind::Thread,
                target_id: "thread-1".to_owned(),
                state: FollowState::Following,
                now_ms: 31,
            },
            &NO_FAULTS,
        )
        .expect("follow thread");
    let feed = chats
        .list_personal_feed(WS, "owner", Some(10), None)
        .expect("hydrated feed");
    assert_eq!(feed.items[0].message.message_id, "message-2");
    assert_eq!(
        feed.items[0]
            .parent_message
            .as_ref()
            .expect("parent")
            .message_id,
        "message-1"
    );
    assert_eq!(
        feed.items[0]
            .opening_message
            .as_ref()
            .expect("opening")
            .message_id,
        "message-1"
    );
    assert_eq!(feed.items[0].matched_by, vec![FollowTargetKind::Thread]);

    let ops: Vec<(String, serde_json::Value)> = store
        .read_with(|conn| {
            let mut stmt = conn.prepare(
                "SELECT op_kind, payload_json FROM replication_log \
                 WHERE workspace_id = ?1 AND op_kind IN \
                   ('chat.channel.create', 'chat.thread.create', 'chat.message.append') \
                 ORDER BY origin_seq",
            )?;
            let rows = stmt.query_map([WS], |row| {
                let kind: String = row.get(0)?;
                let payload: String = row.get(1)?;
                Ok((kind, serde_json::from_str(&payload).expect("payload json")))
            })?;
            rows.collect()
        })
        .expect("core replication ops");
    assert_eq!(ops.len(), 4);
    assert_eq!(ops[0].0, "chat.channel.create");
    assert_eq!(
        ops[0].1,
        json!({
            "channelId": "gen-1",
            "name": "general",
            "slug": "general",
            "kind": "channel",
            "createdAtMs": 10,
            "wireId": GENERAL_CHANNEL_WIRE_ID,
        })
    );
    assert_eq!(ops[1].0, "chat.thread.create");
    assert_eq!(
        ops[1].1,
        json!({
            "threadId": "thread-1",
            "title": "Launch",
            "createdAtMs": 20,
            "channelSlug": "general",
            "channelWireId": GENERAL_CHANNEL_WIRE_ID,
        })
    );
    assert_eq!(ops[2].0, "chat.message.append");
    assert_eq!(
        ops[2].1,
        json!({
            "messageId": "message-1",
            "threadId": "thread-1",
            "authorKind": "human",
            "authorDisplayName": "Ada",
            "body": "opening",
            "createdAtMs": 20,
        })
    );
    assert!(ops[2].1.get("authorUserId").is_none());
    assert_eq!(ops[3].0, "chat.message.append");
    assert_eq!(
        ops[3].1,
        json!({
            "messageId": "message-2",
            "threadId": "thread-1",
            "authorKind": "human",
            "authorDisplayName": "Ada",
            "authorUserId": "user-ada",
            "parentMessageId": "message-1",
            "origin": "cli",
            "body": "reply",
            "createdAtMs": 30,
        })
    );
}

#[test]
fn personal_feed_visibility_and_base64url_cursor_round_trip() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    let mut store = open(&db, 1);
    let mut chats = LinkedChatStore::new(&mut store);
    chats
        .ensure_general_channel(WS, "gen-1", 10, &NO_FAULTS)
        .expect("gen");
    // Two threads; only t1 is followed by the owner.
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

    // A followed CHANNEL surfaces its threads' opening messages.
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
    // With a limit of 1 and two visible opening messages, a keyset cursor is set.
    assert!(
        chan_feed.next_cursor.is_some(),
        "a following page yields a cursor"
    );
    let next = chan_feed.next_cursor.expect("cursor");
    // The Rust-minted cursor decodes back to the last item's coordinate.
    let decoded = decode_feed_cursor(&next).expect("decode");
    assert_eq!(decoded.message_id, chan_feed.items[0].message.message_id);
    // And continuing from it yields the remaining opening message.
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
fn personal_feed_reads_normalize_owner_before_follow_matching() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    let mut store = open(&db, 1);
    let mut chats = LinkedChatStore::new(&mut store);
    chats
        .ensure_general_channel(WS, "gen-1", 10, &NO_FAULTS)
        .expect("general");
    chats
        .start_channel_thread(
            &start_thread("gen-1", "t1", "m1", "opening", ChatActorKind::Human, 20),
            &NO_FAULTS,
        )
        .expect("start");
    chats
        .set_follow(
            &SetFollow {
                workspace_id: WS.to_owned(),
                owner_user_id: "viewer".to_owned(),
                replication_owner_user_id: None,
                target_kind: FollowTargetKind::Thread,
                target_id: "t1".to_owned(),
                state: FollowState::Following,
                now_ms: 21,
            },
            &NO_FAULTS,
        )
        .expect("follow");

    let page = chats
        .list_personal_feed(WS, "  viewer  ", Some(10), None)
        .expect("padded-owner feed");
    assert_eq!(page.items.len(), 1);
    assert_eq!(page.items[0].matched_by, vec![FollowTargetKind::Thread]);
    let head = page.head_cursor.expect("feed head");
    let seen = chats
        .mark_feed_seen(WS, "  viewer  ", None, &head, 22, &NO_FAULTS)
        .expect("padded-owner mark seen");
    assert_eq!(seen.owner_user_id, "viewer");
}

// ---------------------------------------------- bookmark generation-CAS

#[test]
fn bookmark_generation_cas_stale_worker_loses() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
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

    // A concurrent re-save bumps the generation to 2 (CAS token advances).
    let b2 = chats.save_bookmark(&save(31), &NO_FAULTS).expect("resave");
    assert_eq!(b2.generation, 2);

    // A stale worker finishing generation 1 loses: no row matches → applied=false.
    let stale = chats
        .mark_bookmark_ready(WS, "owner", &b1.bookmark_id, 1, 40, None, None, &NO_FAULTS)
        .expect("stale ready");
    assert!(!stale.applied, "stale generation must not mark ready");
    assert_eq!(stale.bookmark.projection_state, "pending");

    // The current generation 2 wins.
    let fresh = chats
        .mark_bookmark_ready(WS, "owner", &b1.bookmark_id, 2, 41, None, None, &NO_FAULTS)
        .expect("fresh ready");
    assert!(fresh.applied, "current generation marks ready");
    assert_eq!(fresh.bookmark.projection_state, "ready");
}

#[test]
fn bookmark_lifecycle_lookups_normalize_owner() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    let mut store = open(&db, 1);
    let mut chats = LinkedChatStore::new(&mut store);
    chats
        .ensure_general_channel(WS, "gen-1", 10, &NO_FAULTS)
        .expect("general");
    chats
        .start_channel_thread(
            &start_thread("gen-1", "t1", "m1", "opening", ChatActorKind::Human, 20),
            &NO_FAULTS,
        )
        .expect("start");
    let save = |now_ms| SaveBookmark {
        workspace_id: WS.to_owned(),
        owner_user_id: "alice".to_owned(),
        target_kind: BookmarkTargetKind::Thread,
        target_id: "t1".to_owned(),
        mode: BookmarkMode::Live,
        destination_path: "bookmarks/alice.md".to_owned(),
        now_ms,
    };

    let first = chats.save_bookmark(&save(30), &NO_FAULTS).expect("save");
    let archived = chats
        .archive_bookmark(WS, "  alice  ", &first.bookmark_id, 31, &NO_FAULTS)
        .expect("padded-owner archive");
    assert_eq!(archived.state, "archived");
    assert_eq!(
        chats
            .list_bookmarks(WS, "  alice  ", None)
            .expect("padded-owner list")
            .len(),
        1
    );
    let ready = chats
        .mark_bookmark_ready(
            WS,
            "  alice  ",
            &first.bookmark_id,
            2,
            32,
            None,
            None,
            &NO_FAULTS,
        )
        .expect("padded-owner ready");
    assert!(ready.applied);

    let third = chats
        .save_bookmark(&save(33), &NO_FAULTS)
        .expect("reactivate");
    let failed = chats
        .mark_bookmark_failed(
            WS,
            "  alice  ",
            &first.bookmark_id,
            third.generation,
            "projection failed",
            34,
            &NO_FAULTS,
        )
        .expect("padded-owner failed");
    assert!(failed.applied);

    let fourth = chats.save_bookmark(&save(35), &NO_FAULTS).expect("resave");
    let stale = chats
        .mark_bookmark_stale(
            WS,
            "  alice  ",
            &first.bookmark_id,
            fourth.generation,
            None,
            36,
            &NO_FAULTS,
        )
        .expect("padded-owner stale");
    assert!(stale.applied);
}

#[test]
fn bookmark_ids_match_sha256_base32_oracle() {
    assert_eq!(base32_lowercase_no_padding(b"foobar"), "mzxw6ytboi");
    let mut hasher = Sha256::new();
    hasher.update(b"owner\0thread\0thread-1");
    let digest = hasher.finalize();
    let expected = format!("bookmark_{}", base32_lowercase_no_padding(&digest[..16]));
    assert_eq!(
        bookmark_id_for("owner", BookmarkTargetKind::Thread, "thread-1"),
        expected
    );
    assert_eq!(expected, "bookmark_lvasdmkz5istkol3a6oyjw63i4");
}

#[test]
fn bookmark_destination_change_clears_projection_ownership() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    let mut store = open(&db, 1);
    let mut chats = LinkedChatStore::new(&mut store);
    chats
        .ensure_general_channel(WS, "gen-1", 10, &NO_FAULTS)
        .expect("general");
    chats
        .start_channel_thread(
            &start_thread("gen-1", "t1", "m0", "opening", ChatActorKind::Human, 20),
            &NO_FAULTS,
        )
        .expect("start");
    let save = |destination: &str, now_ms| SaveBookmark {
        workspace_id: WS.to_owned(),
        owner_user_id: "owner".to_owned(),
        target_kind: BookmarkTargetKind::Thread,
        target_id: "t1".to_owned(),
        mode: BookmarkMode::Live,
        destination_path: destination.to_owned(),
        now_ms,
    };
    let first = chats
        .save_bookmark(&save("bookmarks/a.md", 30), &NO_FAULTS)
        .expect("save a");
    let ready_a = chats
        .mark_bookmark_ready(
            WS,
            "owner",
            &first.bookmark_id,
            1,
            31,
            Some("object-a"),
            Some("bookmarks/a.md"),
            &NO_FAULTS,
        )
        .expect("ready a");
    assert!(ready_a.applied);
    let moved = chats
        .save_bookmark(&save("bookmarks/b.md", 32), &NO_FAULTS)
        .expect("save b");
    assert_eq!(moved.projection_object_id, None);
    let ready_b = chats
        .mark_bookmark_ready(
            WS,
            "owner",
            &first.bookmark_id,
            2,
            33,
            Some("object-b"),
            Some("bookmarks/b.md"),
            &NO_FAULTS,
        )
        .expect("ready b");
    assert!(ready_b.applied);
    assert_eq!(
        ready_b.bookmark.projection_object_id.as_deref(),
        Some("object-b")
    );
}

// ------------------------------------------------ dispatch claim idempotency

#[test]
fn dispatch_claim_is_single_writer_idempotent() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    let mut store = open(&db, 1);
    let mut chats = LinkedChatStore::new(&mut store);
    chats
        .ensure_agent_channel(WS, "agent-1", 10, &NO_FAULTS)
        .expect("agent");
    chats
        .start_channel_thread(
            &start_thread(
                "agent-1",
                "t1",
                "m0",
                "@agent do it",
                ChatActorKind::Human,
                20,
            ),
            &NO_FAULTS,
        )
        .expect("start");
    chats
        .enqueue_dispatch(WS, "m0", "t1", 21, &NO_FAULTS)
        .expect("enqueue");

    for invalid in [String::new(), "bad\0run".to_owned(), "x".repeat(513)] {
        assert!(
            chats
                .claim_next_pending(WS, &invalid, "agent", None, 22, &NO_FAULTS)
                .is_err(),
            "invalid run id must be refused"
        );
    }

    // Whitespace-only commands are VALID (the oracle's `normalizeCommand`
    // preserves them verbatim; an omitted command is the empty string) —
    // only NUL and the metadata length cap refuse.
    for invalid_command in ["bad\0command".to_owned(), "x".repeat(16_385)] {
        assert_eq!(
            chats
                .claim_next_pending(WS, "run-1", &invalid_command, None, 22, &NO_FAULTS)
                .unwrap_err()
                .code(),
            "invalid-input"
        );
    }
    for invalid_path in ["   ".to_owned(), "bad\0path".to_owned(), "x".repeat(16_385)] {
        assert_eq!(
            chats
                .claim_next_pending(WS, "run-1", "agent", Some(&invalid_path), 22, &NO_FAULTS,)
                .unwrap_err()
                .code(),
            "invalid-input"
        );
    }

    let claim = chats
        .claim_next_pending(
            WS,
            "run-1",
            "  agent --run  ",
            Some("  logs/run-1.log  "),
            22,
            &NO_FAULTS,
        )
        .expect("claim")
        .expect("some claim");
    assert_eq!(claim.dispatch.trigger_message_id, "m0");
    assert_eq!(claim.run.run_id, "run-1");
    assert_eq!(claim.dispatch.attempt_count, 1);
    assert_eq!(claim.dispatch.workspace_id, WS);
    assert_eq!(claim.dispatch.thread_id, "t1");
    assert_eq!(claim.dispatch.state, "running");
    assert_eq!(claim.dispatch.run_id.as_deref(), Some("run-1"));
    assert_eq!(claim.dispatch.failure_reason, None);
    assert_eq!(claim.dispatch.created_at_ms, 21);
    assert_eq!(claim.dispatch.updated_at_ms, 22);
    assert_eq!(claim.run.workspace_id, WS);
    assert_eq!(claim.run.thread_id, "t1");
    assert_eq!(claim.run.trigger_message_id, "m0");
    assert_eq!(claim.run.command, "  agent --run  ");
    assert_eq!(claim.run.started_at_ms, 22);
    assert_eq!(claim.run.ended_at_ms, None);
    assert_eq!(claim.run.exit_code, None);
    assert_eq!(claim.run.failure_reason, None);
    assert_eq!(claim.run.log_path.as_deref(), Some("  logs/run-1.log  "));
    assert!(!claim.run.failure_note_posted);

    for invalid in [String::new(), "bad\0run".to_owned(), "x".repeat(513)] {
        assert!(
            chats
                .complete_dispatch(WS, &invalid, 0, 22, &NO_FAULTS)
                .is_err()
        );
        assert!(
            chats
                .fail_dispatch(WS, &invalid, "failed", None, 22, &NO_FAULTS)
                .is_err()
        );
    }

    // A second claim while run-1 is RUNNING returns None (single-writer).
    let second = chats
        .claim_next_pending(WS, "run-2", "agent", None, 23, &NO_FAULTS)
        .expect("second");
    assert!(second.is_none(), "no double-claim while a run is active");

    // The run record exists.
    let runs: i64 = store
        .read_with(|conn| {
            conn.query_row("SELECT COUNT(*) FROM agent_run_records", [], |r| r.get(0))
        })
        .expect("runs");
    assert_eq!(runs, 1);
}

#[test]
fn dispatch_failure_reason_is_validated_and_stored_verbatim() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    let mut store = open(&db, 1);
    let mut chats = LinkedChatStore::new(&mut store);
    chats
        .ensure_agent_channel(WS, "agent-1", 10, &NO_FAULTS)
        .expect("agent");
    chats
        .start_channel_thread(
            &start_thread("agent-1", "t1", "m0", "@agent", ChatActorKind::Human, 20),
            &NO_FAULTS,
        )
        .expect("start");
    chats
        .enqueue_dispatch(WS, "m0", "t1", 21, &NO_FAULTS)
        .expect("enqueue");
    chats
        .claim_next_pending(WS, "run-1", "agent", None, 22, &NO_FAULTS)
        .expect("claim")
        .expect("some");
    for invalid in ["   ".to_owned(), "x".repeat(16_385)] {
        let error = chats
            .fail_dispatch(WS, "run-1", &invalid, None, 23, &NO_FAULTS)
            .unwrap_err();
        assert_eq!(error.code(), "invalid-input");
    }
    let verbatim = "  durable failure  ";
    chats
        .fail_dispatch(WS, "run-1", verbatim, Some(7), 24, &NO_FAULTS)
        .expect("fail");
    let stored: (Option<String>, Option<String>) = store
        .read_with(|conn| {
            let run_reason = conn.query_row(
                "SELECT failure_reason FROM agent_run_records WHERE workspace_id = ?1 AND run_id = 'run-1'",
                [WS],
                |row| row.get(0),
            )?;
            let dispatch_reason = conn.query_row(
                "SELECT failure_reason FROM chat_dispatch_ledger \
                 WHERE workspace_id = ?1 AND trigger_message_id = 'm0'",
                [WS],
                |row| row.get(0),
            )?;
            Ok::<_, rusqlite::Error>((run_reason, dispatch_reason))
        })
        .expect("failure reasons");
    assert_eq!(
        stored,
        (Some(verbatim.to_owned()), Some(verbatim.to_owned()))
    );
}

#[test]
fn dispatch_completes_then_next_trigger_is_claimable() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    let mut store = open(&db, 1);
    let mut chats = LinkedChatStore::new(&mut store);
    chats
        .ensure_agent_channel(WS, "agent-1", 10, &NO_FAULTS)
        .expect("agent");
    // Two triggers in two threads (a claim marks only same-thread pendings done).
    chats
        .start_channel_thread(
            &start_thread("agent-1", "t1", "mA", "@agent A", ChatActorKind::Human, 20),
            &NO_FAULTS,
        )
        .expect("t1");
    chats
        .start_channel_thread(
            &start_thread("agent-1", "t2", "mB", "@agent B", ChatActorKind::Human, 21),
            &NO_FAULTS,
        )
        .expect("t2");
    chats
        .enqueue_dispatch(WS, "mA", "t1", 22, &NO_FAULTS)
        .expect("enq A");
    chats
        .enqueue_dispatch(WS, "mB", "t2", 23, &NO_FAULTS)
        .expect("enq B");

    let a = chats
        .claim_next_pending(WS, "run-A", "agent", None, 24, &NO_FAULTS)
        .expect("claim A")
        .expect("some A");
    assert_eq!(a.dispatch.trigger_message_id, "mA");

    let retry = chats
        .claim_next_pending(WS, "run-A", "ignored retry command", None, 25, &NO_FAULTS)
        .expect("retry claim")
        .expect("same running claim");
    assert_eq!(retry, a);

    // Before completion, B is NOT claimable (single-writer guard).
    assert!(
        chats
            .claim_next_pending(WS, "run-B", "agent", None, 25, &NO_FAULTS)
            .expect("blocked")
            .is_none()
    );

    // Complete A → the running row leaves 'running'; B becomes claimable.
    chats
        .complete_dispatch(WS, "run-A", 0, 26, &NO_FAULTS)
        .expect("complete A");
    let b = chats
        .claim_next_pending(WS, "run-B", "agent", None, 27, &NO_FAULTS)
        .expect("claim B")
        .expect("some B");
    assert_eq!(b.dispatch.trigger_message_id, "mB");

    // A DIFFERENT workspace can neither complete nor fail this run — the
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

    // Completing an already-done run is an idempotent no-op.
    chats
        .complete_dispatch(WS, "run-A", 0, 28, &NO_FAULTS)
        .expect("idempotent complete");

    // A's run record is ended with its ORIGINAL exit code timestamp (26), not
    // the idempotent no-op's (28).
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
    let db = scratch.engine_db_path().expect("db");
    {
        let mut store = open(&db, 1);
        let mut chats = LinkedChatStore::new(&mut store);
        chats
            .ensure_agent_channel(WS, "agent-1", 10, &NO_FAULTS)
            .expect("agent");
        chats
            .start_channel_thread(
                &start_thread("agent-1", "t1", "mA", "@agent", ChatActorKind::Human, 20),
                &NO_FAULTS,
            )
            .expect("start");
        chats
            .enqueue_dispatch(WS, "mA", "t1", 21, &NO_FAULTS)
            .expect("enqueue");
        chats
            .claim_next_pending(WS, "run-1", "agent", None, 22, &NO_FAULTS)
            .expect("claim")
            .expect("some");
        // Simulated process death: the run never completes; store dropped.
    }
    // Reopen: the 'running' row survived the crash and wedges new claims.
    let mut store = open(&db, 2);
    let mut chats = LinkedChatStore::new(&mut store);
    assert!(
        chats
            .claim_next_pending(WS, "run-2", "agent", None, 30, &NO_FAULTS)
            .expect("still wedged")
            .is_none(),
        "a dead 'running' row blocks claims until reclaimed"
    );
    // Reclaim the crashed run → its trigger is requeued to pending.
    let requeued = chats
        .reclaim_running_dispatches(WS, 2, 31, &NO_FAULTS)
        .expect("reclaim");
    assert_eq!(requeued, vec!["mA".to_owned()]);
    // A fresh worker can now claim the reclaimed trigger.
    let fresh = chats
        .claim_next_pending(WS, "run-3", "agent", None, 32, &NO_FAULTS)
        .expect("fresh claim")
        .expect("some");
    assert_eq!(fresh.dispatch.trigger_message_id, "mA");
    assert_eq!(fresh.run.run_id, "run-3");

    // The crashed run record is ended-with-failure.
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

// ------------------------------------------------ exactly-once idempotency

#[test]
fn start_thread_after_commit_before_ack_retry_replays_exactly_once() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    {
        let mut store = open(&db, 1);
        let mut chats = LinkedChatStore::new(&mut store);
        chats
            .ensure_general_channel(WS, "gen-1", 10, &NO_FAULTS)
            .expect("gen");
    }
    // Arm a crash AFTER commit, before ack — the write IS durable but surfaces
    // as an error to the caller (who does not learn it succeeded).
    {
        let mut store = open(&db, 2);
        let faults = ScriptedFaults::crash_at(FaultPoint::StorageAfterCommitBeforeAck);
        let mut chats = LinkedChatStore::new(&mut store);
        let mut input = start_thread("gen-1", "t1", "m0", "hello", ChatActorKind::Human, 20);
        input.request_id = Some("req-1".to_owned());
        let err = chats
            .start_channel_thread(&input, faults.as_ref())
            .unwrap_err();
        assert_eq!(err.code(), "persist-failed");
        assert!(faults.fired());
    }
    // Retry with the SAME ids + request_id: replays the recorded result exactly
    // once (does NOT hit the message PK and fail a write that succeeded).
    let mut store = open(&db, 3);
    let mut chats = LinkedChatStore::new(&mut store);
    let mut input = start_thread("gen-1", "t1", "m0", "hello", ChatActorKind::Human, 20);
    input.request_id = Some("req-1".to_owned());
    let (thread, message) = chats
        .start_channel_thread(&input, &NO_FAULTS)
        .expect("replay");
    assert_eq!(thread.thread_id, "t1");
    assert_eq!(message.message_id, "m0");
    // A same-key retry with a DIFFERENT payload is a reuse mismatch.
    let mut reused = start_thread("gen-1", "t1", "m0", "DIFFERENT", ChatActorKind::Human, 20);
    reused.request_id = Some("req-1".to_owned());
    assert_eq!(
        chats
            .start_channel_thread(&reused, &NO_FAULTS)
            .unwrap_err()
            .code(),
        "idempotency-key-reuse-mismatch"
    );
    // Exactly one thread + message durably exist (no duplicate from the retry).
    let counts: (i64, i64) = store
        .read_with(|conn| {
            let t: i64 = conn.query_row("SELECT COUNT(*) FROM chat_threads", [], |r| r.get(0))?;
            let m: i64 = conn.query_row("SELECT COUNT(*) FROM chat_messages", [], |r| r.get(0))?;
            Ok::<_, rusqlite::Error>((t, m))
        })
        .expect("counts");
    assert_eq!(counts, (1, 1));
}

// ---------------------------------------------- write-side fail-closed CHECK

#[test]
fn author_kind_check_constraint_rejects_bogus_wire_value() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    let store = open(&db, 1);
    // A wrong-case / bogus author_kind (as a future R10 replication-apply might
    // receive over the wire) is rejected AT WRITE by the CHECK, not stored to
    // trip later on read.
    let result = store.read_with(|conn| {
        conn.execute(
            "INSERT INTO chat_mentions \
             (workspace_id, thread_id, message_id, handle, author_kind, created_at_ms) \
             VALUES ('ws-1', 't1', 'm1', 'ada', 'Agent', 1)",
            [],
        )
    });
    assert!(result.is_err(), "bogus author_kind must fail the CHECK");
}

// ------------------------------------------------ JS trimEnd body parity

#[test]
fn normalize_body_matches_js_trimend_including_zwnbsp() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    let mut store = open(&db, 1);
    let mut chats = LinkedChatStore::new(&mut store);
    chats
        .ensure_general_channel(WS, "gen-1", 10, &NO_FAULTS)
        .expect("gen");
    // A body ending in U+FEFF (ZWNBSP): JS `.trimEnd()` strips it; Rust
    // `.trim_end()` would NOT. The stored body must match TS: "hi".
    let (_t, m) = chats
        .start_channel_thread(
            &start_thread("gen-1", "t1", "m0", "hi\u{FEFF}", ChatActorKind::Human, 20),
            &NO_FAULTS,
        )
        .expect("start");
    assert_eq!(m.body, "hi", "ZWNBSP trailing trimmed like JS trimEnd");
}

// ---------------------------------------------------------- bounded reads

#[test]
fn list_messages_huge_limit_is_bounded_no_overflow() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
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
    // i64::MAX must not overflow the probe (limit is clamped to MAX_MESSAGE_PAGE)
    // and returns the small page without a cursor.
    let page = chats
        .list_messages(WS, "t1", i64::MAX, None)
        .expect("huge limit");
    assert_eq!(page.messages.len(), 1);
    assert_eq!(page.next_after_message_order, None);
}

// -------------------------------------------- codex review round 2 fixes

#[test]
fn create_channel_preserves_requested_dm_kind() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    let mut store = open(&db, 1);
    let mut chats = LinkedChatStore::new(&mut store);
    let ch = chats
        .create_channel(WS, "dm-1", "Ada & Bee", ChatChannelKind::Dm, 10, &NO_FAULTS)
        .expect("dm");
    assert_eq!(
        ch.kind,
        ChatChannelKind::Dm,
        "requested DM kind is persisted"
    );
    let listed = chats.list_channels(WS).expect("list");
    assert_eq!(listed[0].channel.kind, ChatChannelKind::Dm);
}

#[test]
fn find_channel_by_slug_normalizes_display_name_input() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    let mut store = open(&db, 1);
    let mut chats = LinkedChatStore::new(&mut store);
    chats
        .create_channel(
            WS,
            "c1",
            "Client ACME  Launch",
            ChatChannelKind::Channel,
            10,
            &NO_FAULTS,
        )
        .expect("create");
    // A display-name-like lookup resolves the stored slug (client-acme-launch).
    let found = chats
        .find_channel_by_slug(WS, "Client ACME  Launch")
        .expect("find");
    assert_eq!(found.map(|c| c.channel_id), Some("c1".to_owned()));
}

#[test]
fn human_reply_advances_read_cursor_agent_reply_does_not() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    let mut store = open(&db, 1);
    let mut chats = LinkedChatStore::new(&mut store);
    chats
        .ensure_general_channel(WS, "gen-1", 10, &NO_FAULTS)
        .expect("gen");
    // Agent opening → cursor stays 0.
    chats
        .start_channel_thread(
            &start_thread("gen-1", "t1", "m0", "opening", ChatActorKind::Agent, 20),
            &NO_FAULTS,
        )
        .expect("start");
    assert_eq!(
        chats.read_state(WS, "t1").expect("rs0").last_read_sequence,
        0
    );
    // Agent reply → cursor still 0 (unread is what agent messages surface).
    let mut agent = send_msg("t1", "m1", None, "agent reply", 21);
    agent.author_kind = ChatActorKind::Agent;
    chats.send_message(&agent, &NO_FAULTS).expect("agent send");
    assert_eq!(
        chats.read_state(WS, "t1").expect("rs1").last_read_sequence,
        0
    );
    // Human reply → cursor catches up to its own sequence (3 messages now → 3).
    chats
        .send_message(&send_msg("t1", "m2", None, "human reply", 22), &NO_FAULTS)
        .expect("human send");
    assert_eq!(
        chats.read_state(WS, "t1").expect("rs2").last_read_sequence,
        3
    );
}

#[test]
fn list_messages_unknown_thread_fails_closed() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    let mut store = open(&db, 1);
    let chats = LinkedChatStore::new(&mut store);
    let err = chats.list_messages(WS, "nope", 10, None).unwrap_err();
    assert_eq!(err.code(), "thread-not-found");
}

#[test]
fn save_bookmark_rejects_unsafe_destination_path() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
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
fn message_append_requeues_active_live_bookmark() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
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
    let bm = chats
        .save_bookmark(
            &SaveBookmark {
                workspace_id: WS.to_owned(),
                owner_user_id: "owner".to_owned(),
                target_kind: BookmarkTargetKind::Thread,
                target_id: "t1".to_owned(),
                mode: BookmarkMode::Live,
                destination_path: "bookmarks/t1.md".to_owned(),
                now_ms: 30,
            },
            &NO_FAULTS,
        )
        .expect("save");
    assert_eq!(bm.generation, 1);
    // A later message on the thread bumps the live bookmark's generation so the
    // projection reprojects (else it goes permanently stale).
    chats
        .send_message(&send_msg("t1", "m1", None, "more", 31), &NO_FAULTS)
        .expect("send");
    let after = chats.list_bookmarks(WS, "owner", None).expect("list");
    assert_eq!(
        after[0].generation, 2,
        "live bookmark requeued after a message"
    );
    assert_eq!(after[0].projection_state, "pending");
}

#[test]
fn mark_feed_seen_rejects_non_visible_coordinate() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
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
    // owner follows nothing → m0 is NOT visible; marking it seen fails closed.
    let head = encode_feed_cursor(&FeedCursorValue {
        created_at_ms: 100,
        message_id: "m0".to_owned(),
    });
    let err = chats
        .mark_feed_seen(WS, "owner", None, &head, 200, &NO_FAULTS)
        .unwrap_err();
    assert_eq!(err.code(), "invalid-follow-target");
    // After following the thread, the same coordinate is visible and accepted.
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
        })
    );
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&rows[1].1).expect("second read payload"),
        json!({
            "ownerUserId": "owner",
            "lastSeenCreatedAtMs": 100,
            "lastSeenMessageId": "m0",
            "atMs": 201,
        })
    );
}

// ------------------------------------------------------ migration presence

#[test]
fn chats_migration_and_deferred_parent_repair_applied() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    let store = open(&db, 1);
    store
        .read_with(|conn| {
            let has: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM engine_migrations WHERE id = 'v1-chats'",
                    [],
                    |r| r.get(0),
                )
                .expect("migration row");
            assert_eq!(has, 1, "v1-chats migration is recorded");
            // The repair table exists and is empty on a fresh store.
            let pending: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM chat_pending_message_parents",
                    [],
                    |r| r.get(0),
                )
                .expect("pending");
            assert_eq!(pending, 0);
            Ok::<_, rusqlite::Error>(())
        })
        .expect("reads");
}

// =====================================================================
// NON-TAUTOLOGICAL differentials — validated against REAL TS output.
// Fixtures produced by running the exact TS algorithms under Node/V8
// (channelSlugForName, linkedChatProjectionPath, encodeFeedCursor).
// =====================================================================

#[test]
fn channel_slug_matches_ts_output() {
    // Node oracle (String.normalize NFC + the TS regex chain):
    assert_eq!(channel_slug_for_name("General Chat"), "general-chat");
    assert_eq!(channel_slug_for_name("  Hello_World  "), "hello-world");
    assert_eq!(channel_slug_for_name("Café Room"), "caf-room");
    assert_eq!(channel_slug_for_name("Ünïcode 123!!"), "ncode-123");
    assert_eq!(channel_slug_for_name("---a--b---"), "a-b");
}

#[test]
fn projection_path_matches_ts_and_is_nfc_identity() {
    // Node oracle: createHash("sha256").update("v1\0ws-1\0thread-1\0thread") then
    // base32-lowercase-no-pad, wrapped as `.dohc/chats/v1-<b32>.md`.
    assert_eq!(
        linked_chat_projection_path("ws-1", "thread-1", None).expect("path"),
        ".dohc/chats/v1-x5aa42flcljlxiwvesxm73hmnhyz6uzkqvro7jelswuchp27m6ha.md"
    );
    // NFD input yields the byte-identical path as the NFC input (matrix 4.1b):
    // NFC "café" = caf\u{e9}; NFD "café" = cafe\u{301}.
    let nfc_path = linked_chat_projection_path("ws-1", "caf\u{e9}", None).expect("nfc");
    let nfd_path = linked_chat_projection_path("ws-1", "cafe\u{301}", None).expect("nfd");
    assert_eq!(nfc_path, nfd_path);
    assert_eq!(
        nfc_path,
        ".dohc/chats/v1-ib63bruu7myh44awyugdyxv46ivaechoo3mww7jo2ueoux2rx5dq.md"
    );
}

#[test]
fn feed_cursor_encode_matches_ts_and_ts_cursor_decodes() {
    // Node oracle: Buffer.from(JSON.stringify([n, id]), "utf8").toString("base64url").
    assert_eq!(
        encode_feed_cursor(&FeedCursorValue {
            created_at_ms: 5,
            message_id: "msg-1".to_owned()
        }),
        "WzUsIm1zZy0xIl0"
    );
    assert_eq!(
        encode_feed_cursor(&FeedCursorValue {
            created_at_ms: 1_720_000_000_000,
            message_id: "m-abc".to_owned(),
        }),
        "WzE3MjAwMDAwMDAwMDAsIm0tYWJjIl0"
    );
    assert_eq!(
        encode_feed_cursor(&FeedCursorValue {
            created_at_ms: 0,
            message_id: "x".to_owned()
        }),
        "WzAsIngiXQ"
    );

    // A TS-minted cursor decodes back to its coordinate (round-trip parity).
    let decoded = decode_feed_cursor("WzE3MjAwMDAwMDAwMDAsIm0tYWJjIl0").expect("decode");
    assert_eq!(decoded.created_at_ms, 1_720_000_000_000);
    assert_eq!(decoded.message_id, "m-abc");

    // Garbage fails closed as invalid-follow-target.
    assert_eq!(
        decode_feed_cursor("!!!not-base64!!!").unwrap_err().code(),
        "invalid-follow-target"
    );
    // An over-long cursor fails closed.
    let long = "A".repeat(600);
    assert_eq!(
        decode_feed_cursor(&long).unwrap_err().code(),
        "invalid-follow-target"
    );
}

#[test]
fn claim_refuses_a_run_id_already_used_anywhere() {
    // Run ids are globally unique by schema (idx_agent_run_records_run_id).
    // A caller-supplied id that already exists — an ENDED run in this
    // workspace, or any run in another — must refuse cleanly. Mutation
    // check: drop the run_id_taken probe in `claim_next_pending` — both
    // claims below then hit the UNIQUE violation mid-transaction and
    // surface a storage error instead of "invalid-input".
    const OTHER_WS: &str = "ws-2";
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    let mut store = open(&db, 1);
    let mut chats = LinkedChatStore::new(&mut store);
    for ws in [WS, OTHER_WS] {
        chats
            .ensure_agent_channel(ws, "agent-x", 10, &NO_FAULTS)
            .expect("agent");
        let mut start = start_thread("agent-x", "t-x", "m-x", "@agent", ChatActorKind::Human, 20);
        start.workspace_id = ws.to_owned();
        chats
            .start_channel_thread(&start, &NO_FAULTS)
            .expect("start");
        chats
            .enqueue_dispatch(ws, "m-x", "t-x", 21, &NO_FAULTS)
            .expect("enqueue");
    }

    // ws-1 claims and finishes run-taken; reusing it in ws-1 refuses.
    chats
        .claim_next_pending(WS, "run-taken", "agent", None, 22, &NO_FAULTS)
        .expect("claim")
        .expect("some");
    chats
        .complete_dispatch(WS, "run-taken", 0, 23, &NO_FAULTS)
        .expect("complete");
    let start_y = {
        let mut start = start_thread("agent-x", "t-y", "m-y", "@agent", ChatActorKind::Human, 24);
        start.workspace_id = WS.to_owned();
        start
    };
    chats
        .start_channel_thread(&start_y, &NO_FAULTS)
        .expect("start y");
    chats
        .enqueue_dispatch(WS, "m-y", "t-y", 24, &NO_FAULTS)
        .expect("enqueue y");
    assert_eq!(
        chats
            .claim_next_pending(WS, "run-taken", "agent", None, 25, &NO_FAULTS)
            .expect_err("ended-run id reuse must refuse")
            .code(),
        "invalid-input"
    );

    // ws-2 reusing ws-1's live id also refuses (instead of colliding with
    // the global unique index inside the claim transaction).
    chats
        .claim_next_pending(WS, "run-fresh", "agent", None, 26, &NO_FAULTS)
        .expect("fresh claim")
        .expect("some");
    assert_eq!(
        chats
            .claim_next_pending(OTHER_WS, "run-fresh", "agent", None, 27, &NO_FAULTS)
            .expect_err("cross-workspace id reuse must refuse")
            .code(),
        "invalid-input"
    );
}
