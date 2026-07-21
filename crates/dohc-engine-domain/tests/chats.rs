//! R09 chats-domain traces: channel/thread/message round-trips, the atomic
//! thread+first-message boundary (crash mid-send strands no empty thread),
//! keyset pagination at limit-1/limit/limit+1, the mark-read CAS + monotonic
//! clamp, follows/feed/bookmark generation-CAS, dispatch claim idempotency, and
//! the NON-TAUTOLOGICAL parity differentials (channel slug, projection path,
//! base64url feed cursor) validated against real TS output — not Rust's own.

use dohc_engine_domain::{
    AGENT_CHANNEL_WIRE_ID, BookmarkMode, BookmarkTargetKind, ChatActorKind, ChatChannelKind,
    FeedCursorValue, FollowState, FollowTargetKind, GENERAL_CHANNEL_WIRE_ID, LinkedChatStore,
    NoFaults, SaveBookmark, SendMessage, SetFollow, StartChannelThread, channel_slug_for_name,
    decode_feed_cursor, encode_feed_cursor, linked_chat_projection_path,
};
use dohc_engine_storage::{EngineStore, FaultPoint};
use dohc_engine_testkit::{ScratchDir, ScriptedFaults};

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

    let follow = |ts: i64, state: FollowState, seq: i64| SetFollow {
        workspace_id: WS.to_owned(),
        owner_user_id: "owner".to_owned(),
        target_kind: FollowTargetKind::Thread,
        target_id: "t1".to_owned(),
        state,
        at_ms: ts,
        origin_id: "origin-a".to_owned(),
        origin_seq: seq,
    };
    chats
        .set_follow(&follow(10, FollowState::Following, 1), &NO_FAULTS)
        .expect("f1");
    // Older unfollow loses (LWW on updated_at_ms).
    chats
        .set_follow(&follow(5, FollowState::Unfollowed, 2), &NO_FAULTS)
        .expect("f2");
    let active = chats.list_follows(WS, "owner").expect("active");
    assert_eq!(active.len(), 1, "older unfollow does not win");
    assert_eq!(active[0].state, FollowState::Following);

    // Newer unfollow wins → no active follows.
    chats
        .set_follow(&follow(20, FollowState::Unfollowed, 3), &NO_FAULTS)
        .expect("f3");
    assert!(chats.list_follows(WS, "owner").expect("empty").is_empty());
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
                target_kind: FollowTargetKind::Thread,
                target_id: "t1".to_owned(),
                state: FollowState::Following,
                at_ms: 50,
                origin_id: "o".to_owned(),
                origin_seq: 1,
            },
            &NO_FAULTS,
        )
        .expect("follow t1");

    let page = chats
        .list_personal_feed(WS, "owner", Some(20), None)
        .expect("feed");
    let ids: Vec<&str> = page.items.iter().map(|i| i.message_id.as_str()).collect();
    assert_eq!(
        ids,
        vec!["m1"],
        "only the followed thread's message is visible"
    );

    // A followed CHANNEL surfaces its threads' opening messages.
    chats
        .set_follow(
            &SetFollow {
                workspace_id: WS.to_owned(),
                owner_user_id: "owner2".to_owned(),
                target_kind: FollowTargetKind::Channel,
                target_id: GENERAL_CHANNEL_WIRE_ID.to_owned(),
                state: FollowState::Following,
                at_ms: 51,
                origin_id: "o".to_owned(),
                origin_seq: 1,
            },
            &NO_FAULTS,
        )
        .expect("follow chan");
    let chan_feed = chats
        .list_personal_feed(WS, "owner2", Some(1), None)
        .expect("chan feed");
    assert_eq!(chan_feed.items.len(), 1);
    // With a limit of 1 and two visible opening messages, a keyset cursor is set.
    assert!(
        chan_feed.next_cursor.is_some(),
        "a following page yields a cursor"
    );
    let next = chan_feed.next_cursor.expect("cursor");
    // The Rust-minted cursor decodes back to the last item's coordinate.
    let decoded = decode_feed_cursor(&next).expect("decode");
    assert_eq!(decoded.message_id, chan_feed.items[0].message_id);
    // And continuing from it yields the remaining opening message.
    let page2 = chats
        .list_personal_feed(WS, "owner2", Some(1), Some(&next))
        .expect("feed page 2");
    assert_eq!(page2.items.len(), 1);
    assert_ne!(page2.items[0].message_id, chan_feed.items[0].message_id);
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

    let save = |id: &str, now: i64| SaveBookmark {
        workspace_id: WS.to_owned(),
        bookmark_id: id.to_owned(),
        owner_user_id: "owner".to_owned(),
        target_kind: BookmarkTargetKind::Thread,
        target_id: "t1".to_owned(),
        mode: BookmarkMode::Live,
        destination_path: "bookmarks/thread.md".to_owned(),
        now_ms: now,
    };
    let b1 = chats
        .save_bookmark(&save("bm-1", 30), &NO_FAULTS)
        .expect("save");
    assert_eq!(b1.generation, 1);
    assert_eq!(b1.projection_state, "pending");

    // A concurrent re-save bumps the generation to 2 (CAS token advances).
    let b2 = chats
        .save_bookmark(&save("bm-1", 31), &NO_FAULTS)
        .expect("resave");
    assert_eq!(b2.generation, 2);

    // A stale worker finishing generation 1 loses: no row matches → applied=false.
    let stale = chats
        .mark_bookmark_ready(WS, "owner", "bm-1", 1, 40, None, None, &NO_FAULTS)
        .expect("stale ready");
    assert!(!stale.applied, "stale generation must not mark ready");
    assert_eq!(stale.bookmark.projection_state, "pending");

    // The current generation 2 wins.
    let fresh = chats
        .mark_bookmark_ready(WS, "owner", "bm-1", 2, 41, None, None, &NO_FAULTS)
        .expect("fresh ready");
    assert!(fresh.applied, "current generation marks ready");
    assert_eq!(fresh.bookmark.projection_state, "ready");
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

    let claim = chats
        .claim_next_pending(WS, "run-1", "agent", None, 22, &NO_FAULTS)
        .expect("claim")
        .expect("some claim");
    assert_eq!(claim.trigger_message_id, "m0");
    assert_eq!(claim.run_id, "run-1");
    assert_eq!(claim.attempt_count, 1);

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
    assert_eq!(a.trigger_message_id, "mA");

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
    assert_eq!(b.trigger_message_id, "mB");

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
    assert_eq!(fresh.trigger_message_id, "mA");
    assert_eq!(fresh.run_id, "run-3");

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
        bookmark_id: "bm-x".to_owned(),
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
                bookmark_id: "bm-1".to_owned(),
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
    let after = chats.list_bookmarks(WS, "owner").expect("list");
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
    let err = chats
        .mark_feed_seen(WS, "owner", 100, "m0", 200, "o", 1, &NO_FAULTS)
        .unwrap_err();
    assert_eq!(err.code(), "invalid-follow-target");
    // After following the thread, the same coordinate is visible and accepted.
    chats
        .set_follow(
            &SetFollow {
                workspace_id: WS.to_owned(),
                owner_user_id: "owner".to_owned(),
                target_kind: FollowTargetKind::Thread,
                target_id: "t1".to_owned(),
                state: FollowState::Following,
                at_ms: 150,
                origin_id: "o".to_owned(),
                origin_seq: 1,
            },
            &NO_FAULTS,
        )
        .expect("follow");
    chats
        .mark_feed_seen(WS, "owner", 100, "m0", 200, "o", 1, &NO_FAULTS)
        .expect("now visible");
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
