//! A group's stream: where a new top-level message goes, and one listing of
//! posts and conversation messages in a single order.

use dohc_engine_domain::{
    ChatActorKind, ChatChannelKind, ChatThreadLane, ChatWorkReport, ChatWorkStatus, DomainError,
    LinkedChatStore, NoFaults, SendMessage, StartChannelThread, StreamAgentRequest,
    StreamAgentRequestState, StreamPage, StreamPosition, ThreadWork,
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
        author_reported: None,
        work: None,
        wake_agent_ids: Vec::new(),
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
        author_reported: None,
        work: None,
        wake_agent_ids: Vec::new(),
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

/// A thread's Work card is its newest work report: that report's status and
/// that report's own link. The stream, the thread listing and a thread read
/// serve the same card.
#[test]
fn a_threads_work_card_is_its_newest_report_with_that_reports_own_link() {
    let (_scratch, mut store) = store();
    group(&mut store);
    let report = |status, url: Option<&str>| {
        Some(ChatWorkReport {
            status,
            url: url.map(str::to_owned),
        })
    };
    let mut opening = start_input("group", "post", "open", ChatThreadLane::Posts, 10);
    opening.work = report(
        ChatWorkStatus::Working,
        Some("https://example.com/threads/1"),
    );
    LinkedChatStore::new(&mut store)
        .start_channel_thread(&opening, &NO_FAULTS)
        .expect("post");
    start(
        &mut store,
        "group",
        "plain",
        "plain-open",
        ChatThreadLane::Posts,
        11,
    );

    let card = |store: &mut EngineStore| -> ThreadWork {
        let stream = page(store, None, 10);
        assert_eq!(ids(&stream), ["open", "plain-open"]);
        assert_eq!(stream.items[1].post.as_ref().expect("post").work, None);
        let chats = LinkedChatStore::new(store);
        assert_eq!(chats.get_thread(WS, "plain").expect("thread").work, None);
        let from_stream = stream.items[0]
            .post
            .as_ref()
            .expect("post")
            .work
            .clone()
            .expect("the post's work card");
        let from_thread = chats.get_thread(WS, "post").expect("thread").work;
        assert_eq!(from_thread.as_ref(), Some(&from_stream));
        let mut listed: Vec<(String, Option<ThreadWork>)> = chats
            .list_channel_threads(WS, "group", None, 10)
            .expect("threads")
            .into_iter()
            .map(|summary| (summary.thread.thread_id, summary.work))
            .collect();
        listed.sort_by(|left, right| left.0.cmp(&right.0));
        assert_eq!(
            listed,
            [
                ("plain".to_owned(), None),
                ("post".to_owned(), Some(from_stream.clone()))
            ]
        );
        from_stream
    };
    let facts = |work: &ThreadWork| {
        (
            work.status,
            work.url.clone(),
            work.message_id.clone(),
            work.reported_at_ms,
        )
    };

    let first = card(&mut store);
    assert_eq!(
        facts(&first),
        (
            ChatWorkStatus::Working,
            Some("https://example.com/threads/1".to_owned()),
            "open".to_owned(),
            10
        )
    );
    assert_eq!(first.author_display_name, "Scout");
    assert_eq!(first.author_owner_display_name.as_deref(), Some("Ada"));

    // A reply with no report changes nothing. Another agent's report with no
    // link shows no link: the card never puts one report's link under
    // another report's author.
    send(&mut store, reply_input("post", "talk", 20));
    let mut done = reply_input("post", "done", 30);
    done.author_display_name = "Nova".to_owned();
    done.work = report(ChatWorkStatus::Done, None);
    send(&mut store, done);
    let newest = card(&mut store);
    assert_eq!(
        facts(&newest),
        (ChatWorkStatus::Done, None, "done".to_owned(), 30)
    );
    assert_eq!(newest.author_display_name, "Nova");
    assert_eq!(
        LinkedChatStore::new(&mut store)
            .get_message(WS, "done")
            .expect("message")
            .work,
        report(ChatWorkStatus::Done, None),
        "each message keeps its own report"
    );

    // An older report that arrives late changes nothing.
    let mut late = reply_input("post", "late", 25);
    late.work = report(ChatWorkStatus::Failed, Some("http://example.com/threads/2"));
    send(&mut store, late);
    assert_eq!(
        facts(&card(&mut store)),
        (ChatWorkStatus::Done, None, "done".to_owned(), 30)
    );
}

/// Only an agent's message reports work, and a report's link is a web
/// address within the length JavaScript counts.
#[test]
fn a_work_report_from_a_person_or_with_a_bad_link_is_refused() {
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
    let report = |url: Option<String>| {
        Some(ChatWorkReport {
            status: ChatWorkStatus::Working,
            url,
        })
    };
    let longest = format!("https://example.com/{}", "a".repeat(2048 - 20));
    assert_eq!(longest.len(), 2048);

    let mut person = reply_input("post", "person", 20);
    person.author_kind = ChatActorKind::Human;
    person.author_owner_display_name = None;
    person.work = report(None);
    let mut refused = vec![person];
    for (index, url) in [
        "ftp://example.com/file",
        "javascript:alert(1)",
        "https://",
        "HTTPS://example.com",
        " https://example.com",
        "https://example.com/a b",
        "https://example.com/\u{7}",
        // A right-to-left override would draw the address as another one.
        "https://\u{202E}x/moc.buhtig",
        "https://example.com/caf\u{e9}",
        &format!("{longest}a"),
    ]
    .into_iter()
    .enumerate()
    {
        let mut bad = reply_input("post", &format!("bad-{index}"), 30);
        bad.work = report(Some(url.to_owned()));
        refused.push(bad);
    }
    for message in refused {
        assert!(
            matches!(
                LinkedChatStore::new(&mut store).send_message(&message, &NO_FAULTS),
                Err(DomainError::InvalidInput { .. })
            ),
            "{} is refused",
            message.message_id
        );
    }
    let mut opening = start_input("group", "bad-post", "bad-open", ChatThreadLane::Posts, 40);
    opening.work = report(Some("mailto:ada@example.com".to_owned()));
    assert!(matches!(
        LinkedChatStore::new(&mut store).start_channel_thread(&opening, &NO_FAULTS),
        Err(DomainError::InvalidInput { .. })
    ));

    let mut fits = reply_input("post", "fits", 50);
    fits.work = report(Some(longest));
    send(&mut store, fits);
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
            wake_agent_ids: vec!["research".to_owned(), "default".to_owned()],
            ..reply_input(&chat, "m-both", 11)
        },
    );
    let claim = LinkedChatStore::new(&mut store)
        .claim_next_pending(WS, "default", "run-1", "agent", None, 12, &NO_FAULTS)
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
