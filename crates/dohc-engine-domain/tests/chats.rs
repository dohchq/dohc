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
    assert_eq!(listed[0].channel_id, "chan-1");

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
            &SendMessage {
                workspace_id: WS.to_owned(),
                thread_id: "t1".to_owned(),
                message_id: "m1".to_owned(),
                author_kind: ChatActorKind::Human,
                author_display_name: "Ada".to_owned(),
                author_user_id: Some("user-ada".to_owned()),
                parent_message_id: Some("does-not-exist".to_owned()),
                origin: None,
                body: "reply".to_owned(),
                now_ms: 21,
            },
            &NO_FAULTS,
        )
        .unwrap_err();
    assert_eq!(bad.code(), "message-not-found");

    // Existing parent in the same thread → ok, order increments.
    let ok = chats
        .send_message(
            &SendMessage {
                workspace_id: WS.to_owned(),
                thread_id: "t1".to_owned(),
                message_id: "m1".to_owned(),
                author_kind: ChatActorKind::Human,
                author_display_name: "Ada".to_owned(),
                author_user_id: Some("user-ada".to_owned()),
                parent_message_id: Some("m0".to_owned()),
                origin: None,
                body: "reply".to_owned(),
                now_ms: 22,
            },
            &NO_FAULTS,
        )
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
                &SendMessage {
                    workspace_id: WS.to_owned(),
                    thread_id: "t1".to_owned(),
                    message_id: format!("m{i}"),
                    author_kind: ChatActorKind::Human,
                    author_display_name: "Ada".to_owned(),
                    author_user_id: Some("user-ada".to_owned()),
                    parent_message_id: None,
                    origin: None,
                    body: format!("msg {i}"),
                    now_ms: 20 + i,
                },
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
    // Agent author so the opening message does NOT auto-advance the cursor.
    chats
        .start_channel_thread(
            &start_thread("gen-1", "t1", "m0", "opening", ChatActorKind::Agent, 20),
            &NO_FAULTS,
        )
        .expect("start");
    chats
        .send_message(
            &SendMessage {
                workspace_id: WS.to_owned(),
                thread_id: "t1".to_owned(),
                message_id: "m1".to_owned(),
                author_kind: ChatActorKind::Human,
                author_display_name: "Ada".to_owned(),
                author_user_id: Some("user-ada".to_owned()),
                parent_message_id: None,
                origin: None,
                body: "second".to_owned(),
                now_ms: 21,
            },
            &NO_FAULTS,
        )
        .expect("send");

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
        destination_path: ".dohc/bm.md".to_owned(),
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
        .mark_bookmark_ready(WS, "owner", "bm-1", 1, 40, &NO_FAULTS)
        .expect("stale ready");
    assert!(!stale.applied, "stale generation must not mark ready");
    assert_eq!(stale.bookmark.projection_state, "pending");

    // The current generation 2 wins.
    let fresh = chats
        .mark_bookmark_ready(WS, "owner", "bm-1", 2, 41, &NO_FAULTS)
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

    let claim = chats
        .claim_next_pending(WS, "run-1", "agent", None, 22, &NO_FAULTS)
        .expect("claim")
        .expect("some claim");
    assert_eq!(claim.trigger_message_id, "m0");
    assert_eq!(claim.run_id, "run-1");
    assert_eq!(claim.attempt_count, 1);

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
