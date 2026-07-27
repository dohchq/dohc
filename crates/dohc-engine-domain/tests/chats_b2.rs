use dohc_engine_domain::{
    BookmarkMode, BookmarkTargetKind, ChatActorKind, ChatChannelKind, LinkedChatStore, NoFaults,
    SaveBookmark, SendMessage, StartChannelThread,
};
use dohc_engine_storage::{EngineStore, StorageError};
use dohc_engine_testkit::ScratchDir;
use rusqlite::params;

const WS: &str = "b2-ws";
const OTHER_WS: &str = "b2-other";
const NO_FAULTS: NoFaults = NoFaults;

fn open_store() -> (ScratchDir, EngineStore) {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    let store = EngineStore::open(&db, 1).expect("open");
    (scratch, store)
}

fn start(
    chats: &mut LinkedChatStore<'_>,
    thread: &str,
    message: &str,
    kind: ChatActorKind,
    at: i64,
) {
    chats
        .start_channel_thread(
            &StartChannelThread {
                workspace_id: WS.to_owned(),
                channel_id: "channel".to_owned(),
                thread_id: thread.to_owned(),
                message_id: message.to_owned(),
                title: None,
                author_kind: kind,
                author_display_name: "Ada".to_owned(),
                author_user_id: Some("ada".to_owned()),
                origin: None,
                body: message.to_owned(),
                needs_decision: false,
                attachments: Vec::new(),
                now_ms: at,
                request_id: None,
            },
            &NO_FAULTS,
        )
        .expect("start");
}

fn send(
    chats: &mut LinkedChatStore<'_>,
    thread: &str,
    message: &str,
    kind: ChatActorKind,
    at: i64,
) {
    chats
        .send_message(
            &SendMessage {
                workspace_id: WS.to_owned(),
                thread_id: thread.to_owned(),
                message_id: message.to_owned(),
                author_kind: kind,
                author_display_name: "Ada".to_owned(),
                author_user_id: Some("ada".to_owned()),
                parent_message_id: None,
                origin: None,
                body: message.to_owned(),
                needs_decision: false,
                attachments: Vec::new(),
                now_ms: at,
                request_id: None,
            },
            &NO_FAULTS,
        )
        .expect("send");
}

fn base_chat(store: &mut EngineStore) {
    let mut chats = LinkedChatStore::new(store);
    chats
        .create_channel(
            WS,
            "channel",
            "Channel",
            ChatChannelKind::Channel,
            2,
            &NO_FAULTS,
        )
        .expect("channel");
}

fn bookmark_fixture(store: &mut EngineStore) -> String {
    let mut chats = LinkedChatStore::new(store);
    start(&mut chats, "thread", "message", ChatActorKind::Human, 10);
    chats
        .save_bookmark(
            &SaveBookmark {
                workspace_id: WS.to_owned(),
                owner_user_id: "owner".to_owned(),
                target_kind: BookmarkTargetKind::Thread,
                target_id: "thread".to_owned(),
                mode: BookmarkMode::Live,
                destination_path: "bookmarks/thread.md".to_owned(),
                now_ms: 20,
            },
            &NO_FAULTS,
        )
        .expect("bookmark")
        .bookmark_id
}

fn claimed_run(store: &mut EngineStore, trigger: &str, thread: &str, run: &str, at: i64) {
    let mut chats = LinkedChatStore::new(store);
    chats
        .enqueue_dispatch(WS, trigger, thread, at - 1, &NO_FAULTS)
        .expect("enqueue");
    chats
        .claim_next_pending(WS, run, "agent", None, at, &NO_FAULTS)
        .expect("claim")
        .expect("some claim");
}

#[test]
fn bookmark_find_is_owner_and_workspace_scoped() {
    let (_scratch, mut store) = open_store();
    base_chat(&mut store);
    let id = bookmark_fixture(&mut store);
    let chats = LinkedChatStore::new(&mut store);
    // MUTATION: remove owner/workspace predicates -> a foreign lookup reveals the bookmark.
    assert!(
        chats
            .find_bookmark(WS, "other", &id)
            .expect("find")
            .is_none()
    );
    assert!(
        chats
            .find_bookmark(OTHER_WS, "owner", &id)
            .expect("find")
            .is_none()
    );
}

#[test]
fn bookmark_archive_queues_generation_once() {
    let (_scratch, mut store) = open_store();
    base_chat(&mut store);
    let id = bookmark_fixture(&mut store);
    let mut chats = LinkedChatStore::new(&mut store);
    let first = chats
        .archive_bookmark(WS, "owner", &id, 30, &NO_FAULTS)
        .expect("archive");
    let second = chats
        .archive_bookmark(WS, "owner", &id, 31, &NO_FAULTS)
        .expect("replay");
    // MUTATION: queue on every archive call -> the replay advances generation again.
    assert_eq!((first.generation, second.generation), (2, 2));
}

#[test]
fn bookmark_failed_generation_cas_rejects_stale_worker() {
    let (_scratch, mut store) = open_store();
    base_chat(&mut store);
    let id = bookmark_fixture(&mut store);
    let mut chats = LinkedChatStore::new(&mut store);
    chats
        .mark_bookmark_pending(WS, "owner", &id, "req", 30, &NO_FAULTS)
        .expect("pending");
    let stale = chats
        .mark_bookmark_failed(WS, "owner", &id, 1, "old", 31, &NO_FAULTS)
        .expect("stale");
    // MUTATION: remove generation/state CAS -> a stale worker wins.
    assert!(!stale.applied);
}

#[test]
fn bookmark_stale_generation_cas_rejects_stale_worker() {
    let (_scratch, mut store) = open_store();
    base_chat(&mut store);
    let id = bookmark_fixture(&mut store);
    let mut chats = LinkedChatStore::new(&mut store);
    chats
        .mark_bookmark_pending(WS, "owner", &id, "req", 30, &NO_FAULTS)
        .expect("pending");
    let stale = chats
        .mark_bookmark_stale(WS, "owner", &id, 1, None, 31, &NO_FAULTS)
        .expect("stale");
    // MUTATION: remove generation/state CAS -> a stale access check wins.
    assert!(!stale.applied);
}

#[test]
fn bookmark_mark_pending_request_replay_does_not_double_increment() {
    let (_scratch, mut store) = open_store();
    base_chat(&mut store);
    let id = bookmark_fixture(&mut store);
    let mut chats = LinkedChatStore::new(&mut store);
    let first = chats
        .mark_bookmark_pending(WS, "owner", &id, "same", 30, &NO_FAULTS)
        .expect("first");
    let replay = chats
        .mark_bookmark_pending(WS, "owner", &id, "same", 31, &NO_FAULTS)
        .expect("replay");
    // MUTATION: skip request-ledger replay -> generation increments twice.
    assert_eq!((first.generation, replay.generation), (2, 2));
}

#[test]
fn pending_bookmarks_preserve_oracle_order_and_limit() {
    let (_scratch, mut store) = open_store();
    base_chat(&mut store);
    let _first = bookmark_fixture(&mut store);
    let second = {
        let mut chats = LinkedChatStore::new(&mut store);
        start(
            &mut chats,
            "thread-2",
            "message-2",
            ChatActorKind::Human,
            11,
        );
        chats
            .save_bookmark(
                &SaveBookmark {
                    workspace_id: WS.to_owned(),
                    owner_user_id: "owner".to_owned(),
                    target_kind: BookmarkTargetKind::Thread,
                    target_id: "thread-2".to_owned(),
                    mode: BookmarkMode::Live,
                    destination_path: "bookmarks/two.md".to_owned(),
                    now_ms: 19,
                },
                &NO_FAULTS,
            )
            .expect("second")
            .bookmark_id
    };
    let chats = LinkedChatStore::new(&mut store);
    let rows = chats
        .list_pending_bookmarks_page(WS, "owner", 1, None)
        .expect("page");
    // MUTATION: order by bookmark updated time or ignore limit -> wrong first row/count.
    assert_eq!(
        (rows.len(), rows[0].bookmark.bookmark_id.as_str()),
        (1, second.as_str())
    );
}

#[test]
fn list_threads_for_file_is_workspace_object_scoped_and_stably_ordered() {
    let (_scratch, mut store) = open_store();
    store
        .write_with(&NO_FAULTS, |tx| {
            for (ws, id, object, at) in [
                (WS, "b", "object", 10), (WS, "a", "object", 10),
                (WS, "other", "other", 1), (OTHER_WS, "foreign", "object", 1),
            ] {
                tx.execute(
                    "INSERT INTO chat_threads (workspace_id,thread_id,title,created_at_ms,updated_at_ms,linked_object_id,linked_at_ms) VALUES (?1,?2,'',?4,?4,?3,?4)",
                    params![ws, id, object, at],
                ).map_err(StorageError::persist_public)?;
            }
            Ok::<_, StorageError>(())
        })
        .expect("seed");
    let chats = LinkedChatStore::new(&mut store);
    let rows = chats
        .list_threads_for_file(WS, "object", None, 10)
        .expect("list");
    // MUTATION: match path/foreign rows or omit the id tie-break -> ids differ.
    assert_eq!(
        rows.iter()
            .map(|row| row.thread_id.as_str())
            .collect::<Vec<_>>(),
        ["a", "b"]
    );
}

#[test]
fn find_thread_channel_id_hides_foreign_and_file_threads() {
    let (_scratch, mut store) = open_store();
    base_chat(&mut store);
    {
        let mut chats = LinkedChatStore::new(&mut store);
        start(
            &mut chats,
            "channel-thread",
            "message",
            ChatActorKind::Human,
            10,
        );
    }
    store.write_with(&NO_FAULTS, |tx| {
        tx.execute("INSERT INTO chat_threads (workspace_id,thread_id,title,created_at_ms,updated_at_ms,linked_object_id,linked_at_ms) VALUES (?1,'file','',1,1,'object',1)", params![WS]).map_err(StorageError::persist_public)?;
        Ok::<_, StorageError>(())
    }).expect("file");
    let chats = LinkedChatStore::new(&mut store);
    // MUTATION: drop workspace/owner semantics -> foreign or file threads return a channel.
    assert_eq!(
        chats
            .find_thread_channel_id(WS, "channel-thread")
            .expect("channel"),
        Some("channel".to_owned())
    );
    assert_eq!(
        chats.find_thread_channel_id(WS, "file").expect("file"),
        None
    );
    assert_eq!(
        chats
            .find_thread_channel_id(OTHER_WS, "channel-thread")
            .expect("foreign"),
        None
    );
}

#[test]
fn default_follows_exclude_dm_and_placeholders() {
    let (_scratch, mut store) = open_store();
    {
        let mut chats = LinkedChatStore::new(&mut store);
        chats
            .create_channel(
                WS,
                "channel",
                "Channel",
                ChatChannelKind::Channel,
                2,
                &NO_FAULTS,
            )
            .expect("channel");
        chats
            .create_channel(WS, "dm", "DM", ChatChannelKind::Dm, 3, &NO_FAULTS)
            .expect("dm");
        chats
            .create_channel(
                WS,
                "placeholder",
                "Placeholder",
                ChatChannelKind::Channel,
                4,
                &NO_FAULTS,
            )
            .expect("placeholder");
    }
    store.write_with(&NO_FAULTS, |tx| {
        tx.execute("INSERT INTO chat_channel_placeholders (workspace_id,channel_id,wire_id) VALUES (?1,'placeholder','placeholder')", params![WS]).map_err(StorageError::persist_public)?;
        Ok::<_, StorageError>(())
    }).expect("placeholder");
    LinkedChatStore::new(&mut store)
        .ensure_default_channel_follows(WS, "owner", &NO_FAULTS)
        .expect("ensure");
    let targets: Vec<String> = store
        .read_with(|conn| {
            let mut stmt = conn
                .prepare(
                    "SELECT target_id FROM chat_follows WHERE workspace_id=?1 ORDER BY target_id",
                )
                .map_err(StorageError::corrupt_public)?;
            stmt.query_map(params![WS], |row| row.get(0))
                .map_err(StorageError::corrupt_public)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(StorageError::corrupt_public)
        })
        .expect("targets");
    // MUTATION: omit DM/placeholder filters -> extra follow cells appear.
    assert_eq!(targets, ["channel"]);
}

#[test]
fn default_follow_seed_is_insert_ignore_and_unjournaled() {
    let (_scratch, mut store) = open_store();
    base_chat(&mut store);
    let before: i64 = store
        .read_with(|conn| {
            conn.query_row("SELECT COUNT(*) FROM replication_journal", [], |r| r.get(0))
                .map_err(StorageError::corrupt_public)
        })
        .expect("before");
    let mut chats = LinkedChatStore::new(&mut store);
    chats
        .ensure_default_channel_follows(WS, "owner", &NO_FAULTS)
        .expect("first");
    chats
        .ensure_default_channel_follows(WS, "owner", &NO_FAULTS)
        .expect("second");
    let (count, after): (i64, i64) = store
        .read_with(|conn| {
            Ok::<_, StorageError>((
                conn.query_row(
                    "SELECT COUNT(*) FROM chat_follows WHERE workspace_id=?1",
                    params![WS],
                    |r| r.get(0),
                )
                .map_err(StorageError::corrupt_public)?,
                conn.query_row("SELECT COUNT(*) FROM replication_journal", [], |r| r.get(0))
                    .map_err(StorageError::corrupt_public)?,
            ))
        })
        .expect("counts");
    // MUTATION: replace insert-ignore or journal seeds -> duplicates/journal growth.
    assert_eq!((count, after), (1, before));
}

#[test]
fn agent_read_cursor_rejects_stale_revision() {
    let (_scratch, mut store) = open_store();
    base_chat(&mut store);
    let mut chats = LinkedChatStore::new(&mut store);
    start(&mut chats, "thread", "m1", ChatActorKind::Human, 10);
    chats
        .mark_thread_read_by_agent(WS, "thread", 10, "m1", None, 20, &NO_FAULTS)
        .expect("advance");
    let error = chats
        .mark_thread_read_by_agent(WS, "thread", 10, "m1", Some(0), 21, &NO_FAULTS)
        .unwrap_err();
    // MUTATION: remove expected-revision CAS -> stale caller succeeds.
    assert_eq!(error.code(), "read-state-revision-mismatch");
}

#[test]
fn agent_read_cursor_clamps_to_latest_and_never_moves_back() {
    let (_scratch, mut store) = open_store();
    base_chat(&mut store);
    let mut chats = LinkedChatStore::new(&mut store);
    start(&mut chats, "thread", "m1", ChatActorKind::Human, 10);
    send(&mut chats, "thread", "m2", ChatActorKind::Human, 20);
    let clamped = chats
        .mark_thread_read_by_agent(WS, "thread", 999, "z", None, 30, &NO_FAULTS)
        .expect("clamp");
    let backward = chats
        .mark_thread_read_by_agent(WS, "thread", 10, "m1", None, 31, &NO_FAULTS)
        .expect("backward");
    // MUTATION: remove latest clamp/backward comparison -> cursor escapes or regresses.
    assert_eq!(
        (
            clamped.last_read_message_id.as_str(),
            backward.last_read_message_id.as_str()
        ),
        ("m2", "m2")
    );
}

#[test]
fn agent_read_revision_bumps_only_on_advance() {
    let (_scratch, mut store) = open_store();
    base_chat(&mut store);
    let mut chats = LinkedChatStore::new(&mut store);
    start(&mut chats, "thread", "m1", ChatActorKind::Human, 10);
    let first = chats
        .mark_thread_read_by_agent(WS, "thread", 10, "m1", None, 20, &NO_FAULTS)
        .expect("first");
    let replay = chats
        .mark_thread_read_by_agent(WS, "thread", 10, "m1", Some(1), 21, &NO_FAULTS)
        .expect("replay");
    // MUTATION: increment revision for no-op coordinates -> replay revision becomes 2.
    assert_eq!((first.revision, replay.revision), (1, 1));
}

#[test]
fn agent_unread_requires_latest_human_message_beyond_cursor() {
    let (_scratch, mut store) = open_store();
    base_chat(&mut store);
    let mut chats = LinkedChatStore::new(&mut store);
    start(&mut chats, "human", "h1", ChatActorKind::Human, 10);
    start(&mut chats, "agent", "a1", ChatActorKind::Human, 11);
    send(&mut chats, "agent", "a2", ChatActorKind::Agent, 12);
    chats
        .mark_thread_read_by_agent(WS, "human", 10, "h1", None, 20, &NO_FAULTS)
        .expect("read");
    let rows = chats
        .list_agent_unread_threads(WS, None, 10)
        .expect("unread");
    // MUTATION: accept agent-latest or cursor-covered threads -> list is nonempty.
    assert!(rows.is_empty());
}

#[test]
fn agent_unread_tie_breaks_equal_timestamps_by_message_id() {
    let (_scratch, mut store) = open_store();
    base_chat(&mut store);
    let mut chats = LinkedChatStore::new(&mut store);
    start(&mut chats, "thread", "a", ChatActorKind::Human, 10);
    send(&mut chats, "thread", "b", ChatActorKind::Human, 10);
    chats
        .mark_thread_read_by_agent(WS, "thread", 10, "a", None, 20, &NO_FAULTS)
        .expect("read a");
    let rows = chats
        .list_agent_unread_threads(WS, None, 10)
        .expect("unread");
    // MUTATION: compare timestamp only -> equal-time message b is missed.
    assert_eq!(rows[0].latest_message_id, "b");
}

#[test]
fn pending_dispatch_order_is_created_then_trigger() {
    let (_scratch, mut store) = open_store();
    let mut chats = LinkedChatStore::new(&mut store);
    for (trigger, at) in [("b", 10), ("a", 10), ("old", 9)] {
        chats
            .enqueue_dispatch(WS, trigger, "thread", at, &NO_FAULTS)
            .expect("enqueue");
    }
    let rows = chats
        .list_pending_dispatches(WS, None, 10)
        .expect("pending");
    // MUTATION: order by update/id only -> oracle order changes.
    assert_eq!(
        rows.iter()
            .map(|row| row.trigger_message_id.as_str())
            .collect::<Vec<_>>(),
        ["old", "a", "b"]
    );
}

#[test]
fn open_runs_requires_one_unended_run_per_running_ledger() {
    let (_scratch, mut store) = open_store();
    claimed_run(&mut store, "trigger", "thread", "run", 20);
    store
        .write_with(&NO_FAULTS, |tx| {
            tx.execute("DELETE FROM agent_run_records WHERE run_id='run'", [])
                .map_err(StorageError::persist_public)?;
            Ok::<_, StorageError>(())
        })
        .expect("delete run");
    let error = LinkedChatStore::new(&mut store)
        .list_open_dispatch_runs(WS, None, 10)
        .unwrap_err();
    // MUTATION: skip the one-run invariant preflight -> broken running ledger is omitted.
    assert_eq!(error.code(), "state-corrupt");
}

#[test]
fn open_runs_rejects_unmatched_unended_run() {
    let (_scratch, mut store) = open_store();
    store
        .write_with(&NO_FAULTS, |tx| {
            tx.execute(
                "INSERT INTO agent_run_records (workspace_id,run_id,thread_id,trigger_message_id,command,started_at_ms,failure_note_posted) VALUES (?1,'orphan','thread','trigger','',20,0)",
                params![WS],
            )
            .map_err(StorageError::persist_public)?;
            Ok::<_, StorageError>(())
        })
        .expect("orphan");
    let error = LinkedChatStore::new(&mut store)
        .list_open_dispatch_runs(WS, None, 10)
        .unwrap_err();
    // MUTATION: skip unmatched-run preflight -> orphan process state is hidden.
    assert_eq!(error.code(), "state-corrupt");
}

#[test]
fn get_run_record_rejects_duplicate_global_run_id() {
    let (_scratch, mut store) = open_store();
    store
        .write_with(&NO_FAULTS, |tx| {
            tx.execute("DROP INDEX idx_agent_run_records_run_id", [])
                .map_err(StorageError::persist_public)?;
            for ws in [WS, OTHER_WS] {
                tx.execute(
                    "INSERT INTO agent_run_records (workspace_id,run_id,thread_id,trigger_message_id,command,started_at_ms,failure_note_posted) VALUES (?1,'duplicate','thread','trigger','',20,0)",
                    params![ws],
                )
                .map_err(StorageError::persist_public)?;
            }
            Ok::<_, StorageError>(())
        })
        .expect("duplicates");
    let error = LinkedChatStore::new(&mut store)
        .get_run_record(WS, "duplicate")
        .unwrap_err();
    // MUTATION: take the first globally duplicated run -> corruption is returned as data.
    assert_eq!(error.code(), "state-corrupt");
}

#[test]
fn run_records_limit_selects_runs_before_joining_messages() {
    let (_scratch, mut store) = open_store();
    claimed_run(&mut store, "trigger-1", "thread", "run-1", 20);
    {
        let mut chats = LinkedChatStore::new(&mut store);
        chats
            .record_run_message(WS, "message-1", "run-1", &NO_FAULTS)
            .expect("link 1");
        chats
            .complete_dispatch(WS, "run-1", 0, 21, &NO_FAULTS)
            .expect("complete 1");
    }
    claimed_run(&mut store, "trigger-2", "thread", "run-2", 30);
    {
        let mut chats = LinkedChatStore::new(&mut store);
        chats
            .record_run_message(WS, "message-2a", "run-2", &NO_FAULTS)
            .expect("link 2a");
        chats
            .record_run_message(WS, "message-2b", "run-2", &NO_FAULTS)
            .expect("link 2b");
    }
    let rows = LinkedChatStore::new(&mut store)
        .run_records_for_thread(WS, "thread", Some(1), None, 10)
        .expect("records");
    // MUTATION: apply limit after joining links -> only one message from newest run survives.
    assert_eq!(
        rows.iter()
            .map(|row| row.message_id.as_str())
            .collect::<Vec<_>>(),
        ["message-2a", "message-2b"]
    );
}

#[test]
fn recent_dispatch_count_includes_since_boundary() {
    let (_scratch, mut store) = open_store();
    claimed_run(&mut store, "trigger", "thread", "run", 20);
    let count = LinkedChatStore::new(&mut store)
        .recent_dispatch_count(WS, "thread", 20.0)
        .expect("count");
    // MUTATION: change >= to > -> boundary run disappears.
    assert_eq!(count, 1);
}

#[test]
fn recent_dispatch_count_accepts_finite_negative_since() {
    let (_scratch, mut store) = open_store();
    claimed_run(&mut store, "trigger", "thread", "run", 20);
    let count = LinkedChatStore::new(&mut store)
        .recent_dispatch_count(WS, "thread", -1.5)
        .expect("count");
    // MUTATION: impose a nonnegative DTO/domain bound -> this finite oracle input fails.
    assert_eq!(count, 1);
}

#[test]
fn fail_pending_is_workspace_thread_scoped() {
    let (_scratch, mut store) = open_store();
    let mut chats = LinkedChatStore::new(&mut store);
    chats
        .enqueue_dispatch(WS, "a", "target", 1, &NO_FAULTS)
        .expect("a");
    chats
        .enqueue_dispatch(WS, "b", "other", 2, &NO_FAULTS)
        .expect("b");
    chats
        .enqueue_dispatch(OTHER_WS, "c", "target", 3, &NO_FAULTS)
        .expect("c");
    let changed = chats
        .fail_pending_for_thread(WS, "target", "no runner", 4, &NO_FAULTS)
        .expect("fail");
    let pending = chats
        .list_pending_dispatches(WS, None, 10)
        .expect("pending");
    // MUTATION: drop workspace/thread/state predicate -> more than one row changes.
    assert_eq!((changed, pending[0].trigger_message_id.as_str()), (1, "b"));
}

#[test]
fn record_run_message_rejects_foreign_workspace_run() {
    let (_scratch, mut store) = open_store();
    claimed_run(&mut store, "trigger", "thread", "run", 20);
    let error = LinkedChatStore::new(&mut store)
        .record_run_message(OTHER_WS, "message", "run", &NO_FAULTS)
        .unwrap_err();
    // MUTATION: trust globally unique run id without workspace check -> foreign link inserts.
    assert_eq!(error.code(), "run-not-found");
}

#[test]
fn record_run_message_rejects_different_run_collision() {
    let (_scratch, mut store) = open_store();
    claimed_run(&mut store, "trigger", "thread", "run", 20);
    {
        let mut chats = LinkedChatStore::new(&mut store);
        chats
            .record_run_message(WS, "message", "run", &NO_FAULTS)
            .expect("link");
    }
    store.write_with(&NO_FAULTS, |tx| {
        tx.execute("INSERT INTO agent_run_records (workspace_id,run_id,thread_id,trigger_message_id,command,started_at_ms,failure_note_posted) VALUES (?1,'other-run','thread','other-trigger','',30,0)", params![WS]).map_err(StorageError::persist_public)?;
        Ok::<_, StorageError>(())
    }).expect("other run");
    let error = LinkedChatStore::new(&mut store)
        .record_run_message(WS, "message", "other-run", &NO_FAULTS)
        .unwrap_err();
    // MUTATION: treat insert-ignore as same-link replay -> collision returns false.
    assert_eq!(error.code(), "state-corrupt");
}

#[test]
fn pause_false_clears_reason_and_missing_pause_defaults_false() {
    let (_scratch, mut store) = open_store();
    let mut chats = LinkedChatStore::new(&mut store);
    assert!(
        !chats
            .thread_dispatch_paused(WS, "missing")
            .expect("missing")
    );
    chats
        .set_thread_dispatch_paused(WS, "thread", true, Some("manual"), 10, &NO_FAULTS)
        .expect("pause");
    let cleared = chats
        .set_thread_dispatch_paused(WS, "thread", false, Some("ignored"), 11, &NO_FAULTS)
        .expect("clear");
    // MUTATION: preserve reason while paused=false -> invalid stale reason remains.
    assert_eq!((cleared.paused, cleared.reason), (false, None));
}

#[test]
fn requeue_requires_ended_matching_failed_run_below_attempt_cap() {
    let (_scratch, mut store) = open_store();
    claimed_run(&mut store, "trigger", "thread", "run", 20);
    let requeued = LinkedChatStore::new(&mut store)
        .requeue_failed_trigger(WS, "trigger", "run", 21, &NO_FAULTS)
        .expect("requeue");
    // MUTATION: remove ended/state/attempt guards -> live running trigger requeues.
    assert!(!requeued);
}

#[test]
fn requeue_clears_run_and_failure_atomically() {
    let (_scratch, mut store) = open_store();
    claimed_run(&mut store, "trigger", "thread", "run", 20);
    LinkedChatStore::new(&mut store)
        .fail_dispatch(WS, "run", "app-quit", Some(143), 30, &NO_FAULTS)
        .expect("fail");
    let requeued = LinkedChatStore::new(&mut store)
        .requeue_failed_trigger(WS, "trigger", "run", 31, &NO_FAULTS)
        .expect("requeue");
    let row = LinkedChatStore::new(&mut store)
        .list_pending_dispatches(WS, None, 10)
        .expect("pending")
        .remove(0);
    // MUTATION: clear only state -> stale run/failure survives the transition.
    assert!(requeued && row.run_id.is_none() && row.failure_reason.is_none());
}

#[test]
fn app_quit_recovery_requires_every_filter_and_hydrates_attempt_count() {
    let (_scratch, mut store) = open_store();
    claimed_run(&mut store, "trigger", "thread", "run", 20);
    LinkedChatStore::new(&mut store)
        .fail_dispatch(WS, "run", "app-quit", Some(143), 30, &NO_FAULTS)
        .expect("fail");
    let rows = LinkedChatStore::new(&mut store)
        .list_app_quit_recoveries(WS, None, 10)
        .expect("recoveries");
    // MUTATION: omit join/filter or attempt hydration -> wrong row/count metadata.
    assert_eq!((rows.len(), rows[0].attempt_count), (1, 1));
}

#[test]
fn restart_failure_remains_durably_recoverable_before_requeue() {
    let (_scratch, mut store) = open_store();
    claimed_run(&mut store, "trigger", "thread", "run", 20);
    LinkedChatStore::new(&mut store)
        .fail_dispatch(WS, "run", "app restart during run", None, 30, &NO_FAULTS)
        .expect("fail");
    let rows = LinkedChatStore::new(&mut store)
        .list_app_quit_recoveries(WS, None, 10)
        .expect("recoveries");
    // MUTATION: keep the recovery query restricted to app-quit -> a crash
    // between fail_dispatch and requeue_failed_trigger strands this row.
    assert_eq!(
        rows.first()
            .map(|row| (row.run.failure_reason.as_deref(), row.attempt_count,)),
        Some((Some("app restart during run"), 1)),
    );
}

#[test]
fn failure_note_mark_is_idempotent_and_requires_one_transition() {
    let (_scratch, mut store) = open_store();
    claimed_run(&mut store, "trigger", "thread", "run", 20);
    let mut chats = LinkedChatStore::new(&mut store);
    let first = chats
        .mark_failure_note_posted(WS, "run", &NO_FAULTS)
        .expect("first");
    let replay = chats
        .mark_failure_note_posted(WS, "run", &NO_FAULTS)
        .expect("replay");
    // MUTATION: require/update more than the one false->true transition -> replay fails or false remains.
    assert!(first.failure_note_posted && replay.failure_note_posted);
}
