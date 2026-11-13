use dohc_engine_domain::{
    AgentReader, BookmarkMode, BookmarkTargetKind, ChatActorKind, ChatChannelKind,
    ChatMessageAutomation, ChatThreadLane, LinkedChatStore, NoFaults, SaveBookmark, SendMessage,
    StartChannelThread,
};
use dohc_engine_storage::{EngineStore, FaultPoint, StorageError};
use dohc_engine_testkit::{ScratchDir, ScriptedFaults, engine_db_path};
use rusqlite::params;

const WS: &str = "b2-ws";
const OTHER_WS: &str = "b2-other";
const NO_FAULTS: NoFaults = NoFaults;
const UNNAMED: AgentReader = AgentReader::Unnamed;

fn open_store() -> (ScratchDir, EngineStore) {
    let scratch = ScratchDir::new().expect("scratch");
    let db = engine_db_path(&scratch).expect("db");
    let store = dohc_engine_testkit::open_empty_store(&db, 1);
    (scratch, store)
}

fn start_input(thread: &str, message: &str, kind: ChatActorKind, at: i64) -> StartChannelThread {
    StartChannelThread {
        automation: None,
        workspace_id: WS.to_owned(),
        channel_id: "channel".to_owned(),
        thread_id: thread.to_owned(),
        message_id: message.to_owned(),
        title: None,
        lane: ChatThreadLane::Posts,
        own_thread: false,
        author_kind: kind,
        author_display_name: "Ada".to_owned(),
        author_owner_display_name: None,
        author_user_id: Some("ada".to_owned()),
        origin: None,
        body: message.to_owned(),
        needs_decision: false,
        options: Vec::new(),
        attachments: Vec::new(),
        author_agent_id: None,
        author_reported: None,
        work: None,
        wake_agent_ids: Vec::new(),
        now_ms: at,
        request_id: None,
    }
}

fn start(
    chats: &mut LinkedChatStore<'_>,
    thread: &str,
    message: &str,
    kind: ChatActorKind,
    at: i64,
) {
    chats
        .start_channel_thread(&start_input(thread, message, kind, at), &NO_FAULTS)
        .expect("start");
}

fn send(
    chats: &mut LinkedChatStore<'_>,
    thread: &str,
    message: &str,
    kind: ChatActorKind,
    parent: Option<&str>,
    at: i64,
) {
    chats
        .send_message(
            &SendMessage {
                automation: None,
                workspace_id: WS.to_owned(),
                thread_id: thread.to_owned(),
                message_id: message.to_owned(),
                author_kind: kind,
                author_display_name: "Ada".to_owned(),
                author_owner_display_name: None,
                author_user_id: Some("ada".to_owned()),
                parent_message_id: parent.map(str::to_owned),
                origin: None,
                body: message.to_owned(),
                needs_decision: false,
                options: Vec::new(),
                attachments: Vec::new(),
                author_agent_id: None,
                author_reported: None,
                work: None,
                wake_agent_ids: Vec::new(),
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

fn terminal(requesters: &[&str], unattributed_counts: bool) -> AgentReader {
    AgentReader::Connected {
        agent_id: "terminal".to_owned(),
        handle: "terminal".to_owned(),
        requesters: requesters.iter().map(|id| (*id).to_owned()).collect(),
        unattributed_counts,
    }
}

fn message_ids(rows: Vec<dohc_engine_domain::ChatAgentRequest>) -> Vec<String> {
    rows.into_iter().map(|row| row.message_id).collect()
}

fn requests_for(chats: &LinkedChatStore<'_>, reader: &AgentReader) -> Vec<String> {
    message_ids(
        chats
            .list_agent_unread_requests(WS, reader, None, 100)
            .expect("requests"),
    )
}

/// A post in `channel`'s `thread`, which the first post starts.
#[allow(clippy::too_many_arguments)]
fn post(
    chats: &mut LinkedChatStore<'_>,
    channel: &str,
    thread: &str,
    message: &str,
    kind: ChatActorKind,
    user: Option<&str>,
    agent: Option<&str>,
    at: i64,
) {
    let exists = chats
        .list_messages(WS, thread, 1, None)
        .is_ok_and(|page| !page.messages.is_empty());
    if exists {
        let mut input = send_input(thread, message, kind, at);
        input.author_user_id = user.map(str::to_owned);
        input.author_agent_id = agent.map(str::to_owned);
        chats.send_message(&input, &NO_FAULTS).expect("send");
    } else {
        let mut input = start_input(thread, message, kind, at);
        input.channel_id = channel.to_owned();
        input.author_user_id = user.map(str::to_owned);
        input.author_agent_id = agent.map(str::to_owned);
        chats
            .start_channel_thread(&input, &NO_FAULTS)
            .expect("start");
    }
}

/// A person's post, by `user` or with no account.
fn ask_by(
    chats: &mut LinkedChatStore<'_>,
    user: Option<&str>,
    channel: &str,
    thread: &str,
    message: &str,
    at: i64,
) {
    post(
        chats,
        channel,
        thread,
        message,
        ChatActorKind::Human,
        user,
        None,
        at,
    );
}

fn ask(chats: &mut LinkedChatStore<'_>, channel: &str, thread: &str, message: &str, at: i64) {
    ask_by(chats, Some("ada"), channel, thread, message, at);
}

/// A post by the agent you run.
fn answer(chats: &mut LinkedChatStore<'_>, channel: &str, thread: &str, message: &str, at: i64) {
    post(
        chats,
        channel,
        thread,
        message,
        ChatActorKind::Agent,
        None,
        Some("terminal"),
        at,
    );
}

fn send_input(thread: &str, message: &str, kind: ChatActorKind, at: i64) -> SendMessage {
    SendMessage {
        automation: None,
        workspace_id: WS.to_owned(),
        thread_id: thread.to_owned(),
        message_id: message.to_owned(),
        author_kind: kind,
        author_display_name: "Ada".to_owned(),
        author_owner_display_name: None,
        author_user_id: Some("ada".to_owned()),
        parent_message_id: None,
        origin: None,
        body: message.to_owned(),
        needs_decision: false,
        options: Vec::new(),
        attachments: Vec::new(),
        author_agent_id: None,
        author_reported: None,
        work: None,
        wake_agent_ids: Vec::new(),
        now_ms: at,
        request_id: None,
    }
}

fn agent_chats(chats: &mut LinkedChatStore<'_>) {
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
        .ensure_agent_channel(WS, "t", "terminal", "Terminal", 3, &NO_FAULTS)
        .expect("terminal's chat");
    chats
        .ensure_agent_channel(WS, "r", "research", "Research", 4, &NO_FAULTS)
        .expect("research's chat");
}

#[test]
fn connected_reader_reads_its_chat_its_mentions_and_threads_it_posted_in() {
    let (_scratch, mut store) = open_store();
    let mut chats = LinkedChatStore::new(&mut store);
    agent_chats(&mut chats);
    ask(&mut chats, "t", "dm", "dm-ask", 10);
    ask(&mut chats, "channel", "group", "ask @terminal", 20);
    ask(&mut chats, "channel", "posted", "opening", 25);
    answer(&mut chats, "channel", "posted", "terminal-post", 30);
    ask(&mut chats, "channel", "posted", "reply", 40);
    ask(&mut chats, "r", "other", "other-ask", 50);
    ask(&mut chats, "r", "other", "other @terminal", 55);
    answer(&mut chats, "t", "dm", "terminal-reply", 60);
    let mut cli = send_input("dm", "from-cli", ChatActorKind::Human, 70);
    cli.origin = Some("cli".to_owned());
    chats.send_message(&cli, &NO_FAULTS).expect("cli post");
    ask_by(&mut chats, Some("bob"), "t", "dm", "bob-ask", 80);
    ask(&mut chats, "channel", "group", "plain", 90);

    let reader = terminal(&["ada"], false);
    assert_eq!(
        requests_for(&chats, &reader),
        ["dm-ask", "ask @terminal", "reply", "other @terminal"],
        "a CLI post, an agent post, another person's post, a post before it joined a \
         thread, and another agent's chat without a mention do not ask it."
    );
    assert!(
        requests_for(&chats, &UNNAMED).is_empty(),
        "an unnamed agent does not read an agent's chat or its handle."
    );
}

#[test]
fn each_reader_keeps_its_own_place() {
    let (_scratch, mut store) = open_store();
    let mut chats = LinkedChatStore::new(&mut store);
    agent_chats(&mut chats);
    start(&mut chats, "group", "own", ChatActorKind::Agent, 10);
    ask(&mut chats, "channel", "group", "ask @terminal", 20);
    let reader = terminal(&["ada"], false);
    assert_eq!(requests_for(&chats, &reader), ["ask @terminal"]);
    assert_eq!(requests_for(&chats, &UNNAMED), ["ask @terminal"]);

    chats
        .mark_thread_read_by_agent(
            WS,
            &reader,
            "group",
            20,
            "ask @terminal",
            None,
            30,
            &NO_FAULTS,
        )
        .expect("connected read");
    assert!(requests_for(&chats, &reader).is_empty());
    assert_eq!(
        requests_for(&chats, &UNNAMED),
        ["ask @terminal"],
        "the agent you run reading leaves the unnamed place where it was."
    );
    assert_eq!(
        chats
            .list_agent_unread_threads(WS, &UNNAMED, None, 10)
            .expect("unnamed threads")
            .len(),
        1
    );
    assert!(
        chats
            .list_agent_unread_threads(WS, &reader, None, 10)
            .expect("connected threads")
            .is_empty()
    );

    ask(&mut chats, "channel", "group", "again @terminal", 40);
    chats
        .mark_thread_read_by_agent(
            WS,
            &UNNAMED,
            "group",
            40,
            "again @terminal",
            None,
            50,
            &NO_FAULTS,
        )
        .expect("unnamed read");
    assert_eq!(
        requests_for(&chats, &reader),
        ["again @terminal"],
        "the unnamed place does not move the agent you run's."
    );
    let state = chats
        .mark_thread_read_by_agent(
            WS,
            &reader,
            "group",
            40,
            "again @terminal",
            Some(1),
            60,
            &NO_FAULTS,
        )
        .expect("connected read again");
    assert_eq!(state.revision, 2);
}

#[test]
fn only_its_persons_posts_ask_an_agent_you_run() {
    let (_scratch, mut store) = open_store();
    let mut chats = LinkedChatStore::new(&mut store);
    agent_chats(&mut chats);
    ask_by(&mut chats, Some("me"), "t", "dm", "mine", 10);
    ask_by(&mut chats, Some("owner"), "t", "dm", "owners", 20);
    ask_by(&mut chats, None, "t", "dm", "no-account", 30);

    assert_eq!(
        requests_for(&chats, &terminal(&["me"], false)),
        ["mine"],
        "in a received workspace the owner's posts, and posts with no account, are not yours."
    );
    assert_eq!(
        requests_for(&chats, &terminal(&["me"], true)),
        ["mine", "no-account"],
        "in your own workspace a post with no account is yours."
    );
    assert!(
        requests_for(&chats, &terminal(&[], false)).is_empty(),
        "with no account recorded for you, no post asks it."
    );
    assert_eq!(
        requests_for(&chats, &terminal(&["me", "owner", "me"], false)),
        ["mine", "owners"]
    );
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
        .enqueue_dispatch(WS, trigger, "default", thread, at - 1, &NO_FAULTS)
        .expect("enqueue");
    chats
        .claim_next_pending(WS, "default", run, "agent", None, at, &NO_FAULTS)
        .expect("claim")
        .expect("some claim");
}

#[test]
fn bookmark_find_is_owner_and_workspace_scoped() {
    let (_scratch, mut store) = open_store();
    base_chat(&mut store);
    let id = bookmark_fixture(&mut store);
    let chats = LinkedChatStore::new(&mut store);
    assert!(
        chats
            .find_bookmark(WS, "other", &id)
            .expect("find")
            .is_none(),
        "remove owner/workspace predicates -> a foreign lookup reveals the bookmark.",
    );
    assert!(
        chats
            .find_bookmark(OTHER_WS, "owner", &id)
            .expect("find")
            .is_none()
    );
}

#[test]
fn bookmark_retry_queues_a_failed_projection_at_its_own_generation() {
    let (_scratch, mut store) = open_store();
    base_chat(&mut store);
    let id = bookmark_fixture(&mut store);
    let mut chats = LinkedChatStore::new(&mut store);
    let pending = chats
        .retry_failed_bookmark(WS, "owner", &id, 1, 30, &NO_FAULTS)
        .expect("pending");
    assert!(!pending.applied, "a pending projection is not failed.");
    chats
        .mark_bookmark_failed(WS, "owner", &id, 1, "disk unavailable", 31, &NO_FAULTS)
        .expect("failed");
    let stale = chats
        .retry_failed_bookmark(WS, "owner", &id, 2, 32, &NO_FAULTS)
        .expect("stale");
    assert!(
        !stale.applied,
        "drop the generation fence -> another generation is retried."
    );
    let retried = chats
        .retry_failed_bookmark(WS, "owner", &id, 1, 33, &NO_FAULTS)
        .expect("retried");
    assert!(retried.applied);
    assert_eq!(
        (
            retried.bookmark.generation,
            retried.bookmark.projection_state.as_str(),
            retried.bookmark.failure_reason.as_deref()
        ),
        (1, "pending", None),
        "queue the generation again -> the archive path moves."
    );
    let replay = chats
        .retry_failed_bookmark(WS, "owner", &id, 1, 34, &NO_FAULTS)
        .expect("replay");
    assert_eq!((replay.applied, replay.bookmark.generation), (false, 1));
}

#[test]
fn agent_read_cursor_rejects_stale_revision() {
    let (_scratch, mut store) = open_store();
    base_chat(&mut store);
    let mut chats = LinkedChatStore::new(&mut store);
    start(&mut chats, "thread", "m1", ChatActorKind::Human, 10);
    chats
        .mark_thread_read_by_agent(WS, &UNNAMED, "thread", 10, "m1", None, 20, &NO_FAULTS)
        .expect("advance");
    let error = chats
        .mark_thread_read_by_agent(WS, &UNNAMED, "thread", 10, "m1", Some(0), 21, &NO_FAULTS)
        .unwrap_err();
    assert_eq!(
        error.code(),
        "read-state-revision-mismatch",
        "remove expected-revision CAS -> stale caller succeeds."
    );
}

#[test]
fn agent_read_cursor_clamps_to_latest_and_never_moves_back() {
    let (_scratch, mut store) = open_store();
    base_chat(&mut store);
    let mut chats = LinkedChatStore::new(&mut store);
    start(&mut chats, "thread", "m1", ChatActorKind::Human, 10);
    send(&mut chats, "thread", "m2", ChatActorKind::Human, None, 20);
    let clamped = chats
        .mark_thread_read_by_agent(WS, &UNNAMED, "thread", 999, "z", None, 30, &NO_FAULTS)
        .expect("clamp");
    let backward = chats
        .mark_thread_read_by_agent(WS, &UNNAMED, "thread", 10, "m1", None, 31, &NO_FAULTS)
        .expect("backward");
    assert_eq!(
        (
            clamped.last_read_message_id.as_str(),
            backward.last_read_message_id.as_str()
        ),
        ("m2", "m2"),
        "remove latest clamp/backward comparison -> cursor escapes or regresses.",
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
    assert_eq!(
        error.code(),
        "state-corrupt",
        "skip the one-run invariant preflight -> broken running ledger is omitted."
    );
}

#[test]
fn fail_pending_is_workspace_thread_scoped() {
    let (_scratch, mut store) = open_store();
    let mut chats = LinkedChatStore::new(&mut store);
    chats
        .enqueue_dispatch(WS, "a", "default", "target", 1, &NO_FAULTS)
        .expect("a");
    chats
        .enqueue_dispatch(WS, "a", "codex", "target", 1, &NO_FAULTS)
        .expect("a for codex");
    chats
        .enqueue_dispatch(WS, "b", "default", "other", 2, &NO_FAULTS)
        .expect("b");
    chats
        .enqueue_dispatch(OTHER_WS, "c", "default", "target", 3, &NO_FAULTS)
        .expect("c");
    let changed = chats
        .fail_pending_for_thread(WS, "target", "default", "no runner", 4, &NO_FAULTS)
        .expect("fail");
    let pending = chats
        .list_pending_dispatches(WS, None, 10)
        .expect("pending");
    assert_eq!(
        (
            changed,
            pending
                .iter()
                .map(|dispatch| (
                    dispatch.trigger_message_id.as_str(),
                    dispatch.agent_id.as_str()
                ))
                .collect::<Vec<_>>()
        ),
        (1, vec![("a", "codex"), ("b", "default")]),
        "drop workspace/thread/agent/state predicate -> more than one row changes."
    );
}

#[test]
fn cover_delivered_takes_only_the_running_runs_agents_pending_requests() {
    let (_scratch, mut store) = open_store();
    base_chat(&mut store);
    // An automation's wake starts its own run, which can only reply.
    LinkedChatStore::new(&mut store)
        .start_channel_thread(
            &StartChannelThread {
                automation: Some(ChatMessageAutomation {
                    automation_id: "collection:board#stamp".to_owned(),
                    chain_depth: 1,
                }),
                author_owner_display_name: Some("Ada".to_owned()),
                ..start_input("stamped-thread", "stamped", ChatActorKind::Automation, 3)
            },
            &NO_FAULTS,
        )
        .expect("automation message");
    claimed_run(&mut store, "start", "thread", "run", 10);
    let mut chats = LinkedChatStore::new(&mut store);
    for (trigger, agent, at) in [
        ("reply", "default", 11),
        ("reply", "codex", 11),
        ("later", "default", 12),
        ("stamped", "default", 13),
    ] {
        chats
            .enqueue_dispatch(WS, trigger, agent, "thread", at, &NO_FAULTS)
            .expect("enqueue");
    }
    let delivered = [
        "reply".to_owned(),
        "start".to_owned(),
        "missing".to_owned(),
        "stamped".to_owned(),
    ];
    assert!(
        chats
            .cover_delivered_requests(OTHER_WS, "run", &delivered, 13, &NO_FAULTS)
            .is_err(),
        "another workspace's caller cannot cover this run's requests"
    );
    let covered = chats
        .cover_delivered_requests(WS, "run", &delivered, 13, &NO_FAULTS)
        .expect("cover");
    let pending = chats
        .list_pending_dispatches(WS, None, 10)
        .expect("pending");
    assert_eq!(
        (
            covered,
            pending
                .iter()
                .map(|dispatch| (
                    dispatch.trigger_message_id.as_str(),
                    dispatch.agent_id.as_str()
                ))
                .collect::<Vec<_>>()
        ),
        (
            1,
            vec![
                ("reply", "codex"),
                ("later", "default"),
                ("stamped", "default")
            ]
        ),
        "only the run agent's pending request from a person among the delivered ones is covered"
    );
    chats
        .complete_dispatch(WS, "run", 0, 14, &NO_FAULTS)
        .expect("complete");
    assert_eq!(
        chats
            .cover_delivered_requests(WS, "run", &["later".to_owned()], 15, &NO_FAULTS)
            .expect("cover after end"),
        0,
        "an ended run covers nothing"
    );
    let next = chats
        .claim_next_pending(WS, "default", "run-2", "agent", None, 16, &NO_FAULTS)
        .expect("claim")
        .expect("some claim");
    assert_eq!(
        next.dispatch.trigger_message_id, "later",
        "the next run skips the reply the first run already read"
    );
}

#[test]
fn every_failed_ending_can_requeue_once() {
    for (reason, exit_code) in [
        (None, Some(7)),
        (None, Some(0)),
        (Some("timed out after 15m"), Some(124)),
        (Some("runner failed to start: command missing"), None),
        (Some("app-quit"), Some(143)),
        (Some("app restart during run"), None),
    ] {
        let (_scratch, mut store) = open_store();
        claimed_run(&mut store, "trigger", "thread", "run-1", 20);
        let mut chats = LinkedChatStore::new(&mut store);
        for (run, attempt, at) in [("run-1", 1, 30), ("run-2", 2, 50)] {
            if let Some(reason) = reason {
                chats
                    .fail_dispatch(WS, run, reason, exit_code, at, &NO_FAULTS)
                    .expect("fail");
            } else {
                chats
                    .complete_dispatch(WS, run, exit_code.unwrap(), at, &NO_FAULTS)
                    .expect("complete");
                if exit_code == Some(0) {
                    chats
                        .mark_failure_handled(WS, run, &NO_FAULTS)
                        .expect("no reply");
                }
            }
            let rows = chats
                .list_failed_run_recoveries(WS, Some("thread"), None, 10)
                .expect("recoveries");
            assert_eq!(rows.len(), 1);
            assert_eq!(rows[0].run.run_id, run);
            assert_eq!(rows[0].attempt_count, attempt);
            assert!(
                !chats
                    .requeue_failed_trigger(OTHER_WS, "trigger", run, at + 1, &NO_FAULTS)
                    .expect("other workspace")
            );
            assert!(
                !chats
                    .requeue_failed_trigger(WS, "other", run, at + 1, &NO_FAULTS)
                    .expect("other trigger")
            );
            let requeued = chats
                .requeue_failed_trigger(WS, "trigger", run, at + 1, &NO_FAULTS)
                .expect("try again");
            assert_eq!(requeued, attempt == 1);
            if attempt == 1 {
                assert!(
                    chats
                        .list_failed_run_recoveries(WS, None, None, 10)
                        .expect("back in line")
                        .is_empty()
                );
                let claim = chats
                    .claim_next_pending(WS, "default", "run-2", "agent", None, 40, &NO_FAULTS)
                    .expect("claim")
                    .expect("second attempt");
                assert_eq!(claim.dispatch.attempt_count, 2);
                assert!(
                    !chats
                        .requeue_failed_trigger(WS, "trigger", "run-1", 41, &NO_FAULTS)
                        .expect("stale run")
                );
            } else {
                assert!(
                    chats
                        .list_pending_dispatches(WS, None, 10)
                        .expect("capped")
                        .is_empty()
                );
            }
        }
    }
}

#[test]
fn requeue_of_a_completed_failure_and_its_covered_requests_is_atomic() {
    for point in [
        FaultPoint::StorageBeforePersist,
        FaultPoint::StorageAfterCommitBeforeAck,
    ] {
        let (scratch, mut store) = open_store();
        let db = engine_db_path(&scratch).expect("db");
        let mut chats = LinkedChatStore::new(&mut store);
        for (trigger, at) in [("first", 10), ("covered", 11)] {
            chats
                .enqueue_dispatch(WS, trigger, "default", "thread", at, &NO_FAULTS)
                .expect("enqueue");
        }
        chats
            .claim_next_pending(WS, "default", "run", "agent", None, 20, &NO_FAULTS)
            .expect("claim")
            .expect("some claim");
        chats
            .complete_dispatch(WS, "run", 7, 30, &NO_FAULTS)
            .expect("complete");
        assert!(
            !chats
                .requeue_failed_trigger(WS, "covered", "run", 31, &NO_FAULTS)
                .expect("only the run's own trigger can requeue it")
        );
        let faults = ScriptedFaults::crash_at(point);
        assert!(
            chats
                .requeue_failed_trigger(WS, "first", "run", 32, faults.as_ref())
                .is_err()
        );
        drop(store);
        let mut store = EngineStore::open(&db, 33).expect("reopen");
        let mut chats = LinkedChatStore::new(&mut store);
        let committed = point == FaultPoint::StorageAfterCommitBeforeAck;
        let pending = chats
            .list_pending_dispatches(WS, None, 10)
            .expect("pending");
        assert_eq!(pending.len(), if committed { 2 } else { 0 });
        assert!(pending.iter().all(|row| {
            row.run_id.is_none() && row.failure_reason.is_none() && row.attempt_count == 1
        }));
        assert_eq!(
            chats
                .list_failed_run_recoveries(WS, None, None, 10)
                .expect("recoveries")
                .len(),
            usize::from(!committed)
        );
        assert_eq!(
            chats
                .requeue_failed_trigger(WS, "first", "run", 34, &NO_FAULTS)
                .expect("repeat"),
            !committed
        );
        assert_eq!(
            chats
                .list_pending_dispatches(WS, None, 10)
                .expect("both requests")
                .len(),
            2
        );
    }
}

#[test]
fn latest_run_includes_unlinked_runs_and_scopes_workspace_and_thread() {
    let (_scratch, mut store) = open_store();
    assert!(
        LinkedChatStore::new(&mut store)
            .latest_run_for_thread(WS, "thread", None)
            .expect("empty")
            .is_none()
    );
    claimed_run(&mut store, "trigger-1", "thread", "run-1", 20);
    LinkedChatStore::new(&mut store)
        .complete_dispatch(WS, "run-1", 0, 21, &NO_FAULTS)
        .expect("complete");
    claimed_run(&mut store, "trigger-2", "thread", "run-2", 30);
    LinkedChatStore::new(&mut store)
        .complete_dispatch(WS, "run-2", 7, 31, &NO_FAULTS)
        .expect("fail");
    let chats = LinkedChatStore::new(&mut store);
    let run = chats
        .latest_run_for_thread(WS, "thread", None)
        .expect("read")
        .expect("run");
    assert_eq!(run.run_id, "run-2");
    assert_eq!(run.exit_code, Some(7));
    assert!(
        chats
            .latest_run_for_thread(OTHER_WS, "thread", None)
            .expect("other workspace")
            .is_none()
    );
    assert!(
        chats
            .latest_run_for_thread(WS, "other-thread", None)
            .expect("other thread")
            .is_none()
    );
}

#[test]
fn claim_folds_pending_triggers_only_from_the_same_place() {
    let (_scratch, mut store) = open_store();
    base_chat(&mut store);
    let mut chats = LinkedChatStore::new(&mut store);
    start(&mut chats, "thread", "root-a", ChatActorKind::Human, 10);
    send(
        &mut chats,
        "thread",
        "root-b",
        ChatActorKind::Human,
        None,
        11,
    );
    for (message, parent, at) in [
        ("main-1", None, 12),
        ("main-2", None, 13),
        ("a-1", Some("root-a"), 14),
        ("a-2", Some("root-a"), 15),
        ("b-1", Some("root-b"), 16),
    ] {
        send(
            &mut chats,
            "thread",
            message,
            ChatActorKind::Human,
            parent,
            at,
        );
        chats
            .enqueue_dispatch(WS, message, "default", "thread", at, &NO_FAULTS)
            .expect("enqueue");
    }
    let mut runs = Vec::new();
    for (run, at) in [("run-1", 20), ("run-2", 30), ("run-3", 40)] {
        let claim = chats
            .claim_next_pending(WS, "default", run, "agent", None, at, &NO_FAULTS)
            .expect("claim")
            .expect("some claim");
        runs.push(claim.dispatch.trigger_message_id);
        chats
            .complete_dispatch(WS, run, 0, at + 1, &NO_FAULTS)
            .expect("complete");
    }
    assert_eq!(runs, ["main-1", "a-1", "b-1"]);
    let covered: Vec<(String, Option<String>)> = store
        .read_with(|conn| {
            let mut statement = conn.prepare(
                "SELECT trigger_message_id, run_id FROM chat_dispatch_ledger \
                 WHERE workspace_id = ?1 ORDER BY created_at_ms",
            )?;
            let rows = statement
                .query_map(params![WS], |row| Ok((row.get(0)?, row.get(1)?)))?
                .collect::<Result<_, _>>()?;
            Ok::<_, rusqlite::Error>(rows)
        })
        .expect("ledger");
    assert_eq!(
        covered,
        [
            ("main-1", "run-1"),
            ("main-2", "run-1"),
            ("a-1", "run-2"),
            ("a-2", "run-2"),
            ("b-1", "run-3"),
        ]
        .map(|(trigger, run)| (trigger.to_owned(), Some(run.to_owned()))),
        "two stream messages fold, two replies in one thread fold, and another thread's reply waits",
    );
}
