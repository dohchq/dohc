use dohc_engine_domain::{
    AgentReader, ChatActorKind, ChatChannelKind, ChatThreadLane, CreateFileThread, LinkedChatStore,
    LocalAttachmentInput, NoFaults, SendMessage, StartChannelThread, parse_mention_handles,
};
use dohc_engine_storage::{EngineStore, FaultPoint, StorageError};
use dohc_engine_testkit::{ScratchDir, ScriptedFaults, engine_db_path};

const WS: &str = "b2-round2";
const NO_FAULTS: NoFaults = NoFaults;

fn store() -> (ScratchDir, EngineStore) {
    let scratch = ScratchDir::new().expect("scratch");
    let path = engine_db_path(&scratch).expect("db path");
    let store = EngineStore::open(&path, 1).expect("store");
    (scratch, store)
}

fn attachment(object: &str) -> LocalAttachmentInput {
    LocalAttachmentInput {
        object_id: object.to_owned(),
        path_hint: Some(format!("notes/{object}.md")),
        heading_text: None,
        heading_anchor: None,
        heading_occurrence: None,
    }
}

fn seed_channel(store: &mut EngineStore) {
    LinkedChatStore::new(store)
        .create_channel(
            WS,
            "channel",
            "General",
            ChatChannelKind::Channel,
            10,
            &NO_FAULTS,
        )
        .expect("channel");
}

#[allow(clippy::too_many_arguments)]
fn start_message(
    store: &mut EngineStore,
    channel_id: &str,
    thread_id: &str,
    message_id: &str,
    kind: ChatActorKind,
    author_user_id: Option<&str>,
    origin: Option<&str>,
    body: &str,
    now_ms: i64,
) {
    start_waking(
        store,
        channel_id,
        thread_id,
        message_id,
        kind,
        author_user_id,
        origin,
        &[],
        body,
        now_ms,
    );
}

#[allow(clippy::too_many_arguments)]
fn start_waking(
    store: &mut EngineStore,
    channel_id: &str,
    thread_id: &str,
    message_id: &str,
    kind: ChatActorKind,
    author_user_id: Option<&str>,
    origin: Option<&str>,
    wake_agent_ids: &[&str],
    body: &str,
    now_ms: i64,
) {
    LinkedChatStore::new(store)
        .start_channel_thread(
            &StartChannelThread {
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
                author_user_id: author_user_id.map(str::to_owned),
                origin: origin.map(str::to_owned),
                body: body.to_owned(),
                needs_decision: false,
                options: Vec::new(),
                attachments: Vec::new(),
                author_agent_id: None,
                author_reported: None,
                work: None,
                wake_agent_ids: wake_agent_ids.iter().map(|id| (*id).to_owned()).collect(),
                now_ms,
                request_id: None,
            },
            &NO_FAULTS,
        )
        .expect("start message");
}

#[allow(clippy::too_many_arguments)]
fn send_text(
    store: &mut EngineStore,
    thread_id: &str,
    message_id: &str,
    kind: ChatActorKind,
    author_user_id: Option<&str>,
    origin: Option<&str>,
    body: &str,
    now_ms: i64,
) {
    LinkedChatStore::new(store)
        .send_message(
            &SendMessage {
                automation: None,
                workspace_id: WS.to_owned(),
                thread_id: thread_id.to_owned(),
                message_id: message_id.to_owned(),
                author_kind: kind,
                author_display_name: "Ada".to_owned(),
                author_owner_display_name: None,
                author_user_id: author_user_id.map(str::to_owned),
                parent_message_id: None,
                origin: origin.map(str::to_owned),
                body: body.to_owned(),
                needs_decision: false,
                options: Vec::new(),
                attachments: Vec::new(),
                author_agent_id: None,
                author_reported: None,
                work: None,
                wake_agent_ids: Vec::new(),
                now_ms,
                request_id: None,
            },
            &NO_FAULTS,
        )
        .expect("send text");
}

#[test]
fn file_thread_create_search_and_replication_are_atomic() {
    let (_scratch, mut store) = store();
    let faults = ScriptedFaults::crash_at(FaultPoint::StorageBeforePersist);
    let result = LinkedChatStore::new(&mut store).create_thread(
        &CreateFileThread {
            workspace_id: WS.to_owned(),
            thread_id: "thread".to_owned(),
            title: "File thread".to_owned(),
            linked_object_id: "object".to_owned(),
            linked_path_hint: Some("notes/file.md".to_owned()),
            now_ms: 20,
            request_id: "request".to_owned(),
        },
        faults.as_ref(),
    );
    assert!(result.is_err());
    let counts: (i64, i64, i64) = store
        .read_with(|conn| {
            Ok::<_, StorageError>((
                conn.query_row("SELECT COUNT(*) FROM chat_threads", [], |row| row.get(0))
                    .map_err(StorageError::corrupt_public)?,
                conn.query_row(
                    "SELECT COUNT(*) FROM engine_search_chat_messages_fts",
                    [],
                    |row| row.get(0),
                )
                .map_err(StorageError::corrupt_public)?,
                conn.query_row("SELECT COUNT(*) FROM replication_log", [], |row| row.get(0))
                    .map_err(StorageError::corrupt_public)?,
            ))
        })
        .expect("counts");
    assert_eq!(
        counts,
        (0, 0, 0),
        "splitting row/search/op across transactions -> any partial count becomes nonzero."
    );
}

#[test]
fn attachment_idempotency_fingerprint_includes_canonical_targets() {
    let (_scratch, mut store) = store();
    seed_channel(&mut store);
    let base = StartChannelThread {
        automation: None,
        workspace_id: WS.to_owned(),
        channel_id: "channel".to_owned(),
        thread_id: "thread".to_owned(),
        message_id: "message".to_owned(),
        title: None,
        lane: ChatThreadLane::Posts,
        own_thread: false,
        author_kind: ChatActorKind::Human,
        author_display_name: "Ada".to_owned(),
        author_owner_display_name: None,
        author_user_id: None,
        origin: None,
        body: "Opening".to_owned(),
        needs_decision: false,
        options: Vec::new(),
        attachments: vec![attachment("object-a")],
        author_agent_id: None,
        author_reported: None,
        work: None,
        wake_agent_ids: Vec::new(),
        now_ms: 20,
        request_id: Some("request".to_owned()),
    };
    LinkedChatStore::new(&mut store)
        .start_channel_thread(&base, &NO_FAULTS)
        .expect("first");
    let result = LinkedChatStore::new(&mut store).start_channel_thread(
        &StartChannelThread {
            automation: None,
            attachments: vec![attachment("object-b")],
            ..base
        },
        &NO_FAULTS,
    );
    assert!(
        matches!(
            result,
            Err(dohc_engine_domain::DomainError::IdempotencyKeyReuseMismatch)
        ),
        "omitting attachments from the request fingerprint -> mismatched replay succeeds."
    );
}

#[test]
fn mention_parser_ignores_inline_and_fenced_code() {
    // The oracle keeps the first opener armed and ignores different-length
    // runs, so neither pair of double/single runs becomes an independent span.
    assert_eq!(
        parse_mention_handles("` x `` @agent `` y"),
        vec!["agent"],
        "pairing each run with a later equal-length run hides @agent."
    );
    assert_eq!(parse_mention_handles("`` x ` @agent ` y"), vec!["agent"]);
    assert!(
        parse_mention_handles("` x `` @agent `` y `").is_empty(),
        "ignoring the armed opener makes a matched outer span visible."
    );

    let body = [
        "@you outside",
        "`@inline code`",
        "```ts",
        "@fenced backtick",
        "```",
        "~~~~",
        "@fenced-tilde",
        "~~~~",
    ]
    .join("\n");
    assert_eq!(
        parse_mention_handles(&body),
        vec!["you"],
        "scanning code spans/fences adds three inert handles."
    );
}

#[test]
fn mention_parser_skips_names_inside_file_links() {
    let link_with_escaped_closing_bracket = "@[a%5D @l] @m";
    // The expected handles are what chatMentionTokens in workspace-contracts reads.
    let cases: [(&str, &[&str]); 12] = [
        ("see @[trip @Nova notes.md]", &[]),
        ("see @[notes @Nova.md#Day 1]", &[]),
        (
            "@[trip @Nova notes.md] for @Nova, and @Ana@[x.md]",
            &["nova", "ana"],
        ),
        ("@[ ] @a @[ @b ]", &["a"]),
        ("@[x.md# @c] @[y.md# ] @d", &["d"]),
        ("@[a @h @[b] @g]", &["h", "g"]),
        ("@[a @i\nb]", &["i"]),
        ("`@[` @j]", &["j"]),
        ("`@[a @k]`", &[]),
        (link_with_escaped_closing_bracket, &["m"]),
        ("日本 @[ノート @Nova.md] @Ana", &["ana"]),
        ("@[ノート.md#見出し @Nova] @Bo", &["bo"]),
    ];
    for (body, handles) in cases {
        assert_eq!(parse_mention_handles(body), handles, "{body:?}");
    }
}

#[test]
fn local_start_and_send_index_mentions_atomically() {
    let (_scratch, mut store) = store();
    seed_channel(&mut store);
    start_message(
        &mut store,
        "channel",
        "thread",
        "opening",
        ChatActorKind::Human,
        None,
        None,
        "hello @one",
        20,
    );
    send_text(
        &mut store,
        "thread",
        "reply",
        ChatActorKind::Human,
        None,
        None,
        "hello @two",
        30,
    );
    let handles: Vec<String> = store
        .read_with(|conn| {
            let mut stmt = conn.prepare("SELECT handle FROM chat_mentions ORDER BY handle")?;
            stmt.query_map([], |row| row.get(0))?.collect()
        })
        .expect("handles");
    assert_eq!(
        handles,
        vec!["one", "two"],
        "indexing only one local insertion path loses one handle."
    );

    let failed = LinkedChatStore::new(&mut store).send_message(
        &SendMessage {
            automation: None,
            workspace_id: WS.to_owned(),
            thread_id: "thread".to_owned(),
            message_id: "rolled-back".to_owned(),
            author_kind: ChatActorKind::Human,
            author_display_name: "Ada".to_owned(),
            author_owner_display_name: None,
            author_user_id: None,
            parent_message_id: None,
            origin: None,
            body: "@three".to_owned(),
            needs_decision: false,
            options: Vec::new(),
            attachments: Vec::new(),
            author_agent_id: None,
            author_reported: None,
            work: None,
            wake_agent_ids: Vec::new(),
            now_ms: 40,
            request_id: None,
        },
        ScriptedFaults::crash_at(FaultPoint::StorageBeforePersist).as_ref(),
    );
    assert!(failed.is_err());
    let leaked: i64 = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM chat_mentions WHERE handle='three'",
                [],
                |row| row.get(0),
            )
        })
        .expect("leaked count");
    assert_eq!(
        leaked, 0,
        "indexing outside the message transaction leaks the failed send."
    );
}

#[allow(clippy::too_many_arguments)]
fn send_waking(
    store: &mut EngineStore,
    thread_id: &str,
    message_id: &str,
    kind: ChatActorKind,
    origin: Option<&str>,
    wake_agent_ids: &[&str],
    body: &str,
    now_ms: i64,
    faults: &dyn dohc_engine_storage::FaultInjector,
) -> Result<(), dohc_engine_domain::DomainError> {
    LinkedChatStore::new(store)
        .send_message(
            &SendMessage {
                automation: None,
                workspace_id: WS.to_owned(),
                thread_id: thread_id.to_owned(),
                message_id: message_id.to_owned(),
                author_kind: kind,
                author_display_name: "Ada".to_owned(),
                author_owner_display_name: None,
                author_user_id: None,
                parent_message_id: None,
                origin: origin.map(str::to_owned),
                body: body.to_owned(),
                needs_decision: false,
                options: Vec::new(),
                attachments: Vec::new(),
                author_agent_id: None,
                author_reported: None,
                work: None,
                wake_agent_ids: wake_agent_ids.iter().map(|id| (*id).to_owned()).collect(),
                now_ms,
                request_id: None,
            },
            faults,
        )
        .map(|_| ())
}

fn run(run_id: &str) -> AgentReader {
    AgentReader::Run {
        run_id: run_id.to_owned(),
    }
}

fn requests(store: &EngineStore) -> Vec<(String, String, String, i64, i64)> {
    store
        .read_with(|conn| {
            let mut stmt = conn
                .prepare(
                    "SELECT trigger_message_id, agent_id, state, created_at_ms, updated_at_ms \
                     FROM chat_dispatch_ledger WHERE workspace_id=?1 \
                     ORDER BY trigger_message_id, agent_id",
                )
                .map_err(StorageError::corrupt_public)?;
            stmt.query_map([WS], |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            })
            .map_err(StorageError::corrupt_public)?
            .collect::<Result<_, _>>()
            .map_err(StorageError::corrupt_public)
        })
        .expect("requests")
}

#[test]
fn each_agent_sees_a_message_that_named_it_until_that_agent_reads_it() {
    let (_scratch, mut store) = store();
    seed_channel(&mut store);
    LinkedChatStore::new(&mut store)
        .ensure_agent_channel(WS, "research-chat", "research", "Research", 11, &NO_FAULTS)
        .expect("agent chat");
    start_waking(
        &mut store,
        "research-chat",
        "agent-thread",
        "direct",
        ChatActorKind::Human,
        None,
        None,
        &["research"],
        "hello",
        20,
    );
    start_message(
        &mut store,
        "channel",
        "group-thread",
        "opening",
        ChatActorKind::Human,
        None,
        None,
        "Opening",
        21,
    );
    send_waking(
        &mut store,
        "group-thread",
        "asks-both",
        ChatActorKind::Human,
        None,
        &["research", "default"],
        "Can you both look?",
        30,
        &NO_FAULTS,
    )
    .expect("send");
    let unread = |store: &mut EngineStore, run_id: &str, after: Option<(i64, String)>| {
        LinkedChatStore::new(store)
            .list_agent_unread_requests(WS, &run(run_id), after, 10)
            .map(|requests| {
                requests
                    .into_iter()
                    .map(|request| request.message_id)
                    .collect::<Vec<_>>()
            })
    };
    let read = |store: &mut EngineStore, reader: AgentReader| {
        LinkedChatStore::new(store)
            .mark_thread_read_by_agent(
                WS,
                &reader,
                "group-thread",
                30,
                "asks-both",
                None,
                40,
                &NO_FAULTS,
            )
            .expect("read");
    };

    let research = LinkedChatStore::new(&mut store)
        .claim_next_pending(WS, "research", "run-1", "", None, 35, &NO_FAULTS)
        .expect("claim")
        .expect("research's run");
    assert_eq!(research.run.agent_id, "research");
    assert_eq!(
        unread(&mut store, "run-1", None).expect("requests"),
        vec!["direct", "asks-both"]
    );
    assert_eq!(
        unread(&mut store, "run-1", Some((20, "direct".to_owned()))).expect("requests"),
        vec!["asks-both"]
    );
    read(&mut store, AgentReader::Unnamed);
    assert_eq!(
        unread(&mut store, "run-1", None).expect("requests"),
        vec!["direct", "asks-both"],
        "an agent outside a run keeps its own place."
    );
    read(&mut store, run("run-1"));
    assert_eq!(
        unread(&mut store, "run-1", None).expect("requests"),
        vec!["direct"]
    );
    LinkedChatStore::new(&mut store)
        .complete_dispatch(WS, "run-1", 0, 50, &NO_FAULTS)
        .expect("complete");
    assert_eq!(
        unread(&mut store, "run-1", None).unwrap_err().code(),
        "run-not-found",
        "a run that ended no longer reads as its agent."
    );

    let default = LinkedChatStore::new(&mut store)
        .claim_next_pending(WS, "default", "run-2", "", None, 60, &NO_FAULTS)
        .expect("claim")
        .expect("the default agent's run");
    assert_eq!(default.run.agent_id, "default");
    assert_eq!(
        unread(&mut store, "run-2", None).expect("requests"),
        vec!["asks-both"],
        "research reading the message leaves it unread for the default agent."
    );
    read(&mut store, run("run-2"));
    assert!(
        unread(&mut store, "run-2", None)
            .expect("requests")
            .is_empty()
    );
    assert_eq!(
        unread(&mut store, "no-such-run", None).unwrap_err().code(),
        "run-not-found"
    );
}

#[test]
fn cli_messages_wake_no_agent_and_only_people_name_agents() {
    let (_scratch, mut store) = store();
    seed_channel(&mut store);
    LinkedChatStore::new(&mut store)
        .ensure_agent_channel(WS, "agent-chat", "default", "My agent", 11, &NO_FAULTS)
        .expect("agent chat");
    start_message(
        &mut store,
        "agent-chat",
        "thread",
        "cli",
        ChatActorKind::Human,
        None,
        Some("cli"),
        "from the terminal",
        20,
    );
    send_waking(
        &mut store,
        "thread",
        "cli-named",
        ChatActorKind::Human,
        Some("cli"),
        &["research"],
        "@Research",
        21,
        &NO_FAULTS,
    )
    .expect("cli send");
    assert!(requests(&store).is_empty());
    let agent_naming = send_waking(
        &mut store,
        "thread",
        "agent-named",
        ChatActorKind::Agent,
        None,
        &["research"],
        "@Research",
        22,
        &NO_FAULTS,
    );
    assert!(matches!(
        agent_naming,
        Err(dohc_engine_domain::DomainError::InvalidInput { .. })
    ));
    let bad_id = send_waking(
        &mut store,
        "thread",
        "bad-id",
        ChatActorKind::Human,
        None,
        &["Research"],
        "@Research",
        23,
        &NO_FAULTS,
    );
    assert!(matches!(
        bad_id,
        Err(dohc_engine_domain::DomainError::InvalidInput { .. })
    ));
    assert!(requests(&store).is_empty());
}

#[test]
fn a_mention_that_woke_a_dohc_agent_is_not_in_the_agent_inbox() {
    let (_scratch, mut store) = store();
    seed_channel(&mut store);
    start_message(
        &mut store,
        "channel",
        "thread",
        "opening",
        ChatActorKind::Human,
        None,
        None,
        "Opening",
        20,
    );
    // A dohc agent named "Agent": the sender resolves @Agent to its id.
    send_waking(
        &mut store,
        "thread",
        "named",
        ChatActorKind::Human,
        None,
        &["helper"],
        "@Agent please look",
        30,
        &NO_FAULTS,
    )
    .expect("send");
    assert_eq!(
        requests(&store)
            .into_iter()
            .map(|(trigger, agent, ..)| (trigger, agent))
            .collect::<Vec<_>>(),
        vec![("named".to_owned(), "helper".to_owned())],
        "the named agent wakes exactly once."
    );
    let inbox = LinkedChatStore::new(&mut store)
        .list_agent_unread_requests(WS, &AgentReader::Unnamed, None, 10)
        .expect("inbox");
    assert!(
        inbox.is_empty(),
        "an outside agent reading @agent must not pick up a dohc agent's request."
    );
}

#[test]
fn a_plain_agent_mention_stays_in_the_agent_inbox() {
    let (_scratch, mut store) = store();
    seed_channel(&mut store);
    start_message(
        &mut store,
        "channel",
        "thread",
        "plain",
        ChatActorKind::Human,
        None,
        None,
        "@agent please look",
        20,
    );
    assert!(requests(&store).is_empty(), "@agent wakes no dohc agent.");
    let inbox = LinkedChatStore::new(&mut store)
        .list_agent_unread_requests(WS, &AgentReader::Unnamed, None, 10)
        .expect("inbox");
    assert_eq!(
        inbox
            .iter()
            .map(|row| row.message_id.as_str())
            .collect::<Vec<_>>(),
        vec!["plain"]
    );
}
