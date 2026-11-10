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
    let store = EngineStore::open(&db, 1).expect("open");
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

fn outside_requests(chats: &LinkedChatStore<'_>) -> Vec<String> {
    chats
        .list_agent_unread_requests(WS, &UNNAMED, None, 100)
        .expect("requests")
        .into_iter()
        .map(|row| row.message_id)
        .collect()
}

#[test]
fn outside_requests_include_mentions_and_posted_thread_replies_once() {
    let (_scratch, mut store) = open_store();
    base_chat(&mut store);
    let mut chats = LinkedChatStore::new(&mut store);
    start(&mut chats, "thread", "own", ChatActorKind::Agent, 10);
    send(
        &mut chats,
        "thread",
        "reply @agent",
        ChatActorKind::Human,
        Some("own"),
        20,
    );
    start(
        &mut chats,
        "mention",
        "hello @agent",
        ChatActorKind::Human,
        30,
    );
    send(
        &mut chats,
        "thread",
        "own @agent",
        ChatActorKind::Agent,
        Some("own"),
        40,
    );
    assert_eq!(outside_requests(&chats), ["reply @agent", "hello @agent"]);
    send(
        &mut chats,
        "thread",
        "plain reply",
        ChatActorKind::Human,
        Some("own"),
        50,
    );
    assert_eq!(
        outside_requests(&chats),
        ["reply @agent", "hello @agent", "plain reply"]
    );
    // Reading requests leaves the shared read coordinate unchanged.
    assert_eq!(
        outside_requests(&chats),
        ["reply @agent", "hello @agent", "plain reply"]
    );
    let page = chats
        .list_agent_unread_requests(WS, &UNNAMED, Some((20, "reply @agent".into())), 1)
        .expect("page");
    assert_eq!(page[0].message_id, "hello @agent");
}

#[test]
fn unnamed_reader_skips_agent_chats_that_a_run_still_reads() {
    let (_scratch, mut store) = open_store();
    let mut chats = LinkedChatStore::new(&mut store);
    chats
        .ensure_agent_channel(WS, "channel", "default", "Agent", 2, &NO_FAULTS)
        .expect("agent chat");
    let mut first = start_input("thread", "first", ChatActorKind::Human, 10);
    first.wake_agent_ids = vec!["default".to_owned()];
    chats
        .start_channel_thread(&first, &NO_FAULTS)
        .expect("start");
    send(
        &mut chats,
        "thread",
        "own",
        ChatActorKind::Agent,
        Some("first"),
        20,
    );
    let mut later = send_input("thread", "later @agent", ChatActorKind::Human, 30);
    later.parent_message_id = Some("own".to_owned());
    later.wake_agent_ids = vec!["default".to_owned()];
    chats.send_message(&later, &NO_FAULTS).expect("send");
    assert!(
        outside_requests(&chats).is_empty(),
        "an agent chat belongs to its agent, even where an unnamed agent posted."
    );
    assert!(
        chats
            .list_agent_unread_threads(WS, &UNNAMED, None, 10)
            .expect("threads")
            .is_empty()
    );
    chats
        .claim_next_pending(WS, "default", "run", "agent", None, 40, &NO_FAULTS)
        .expect("claim")
        .expect("the chat's agent has a request");
    let run = run_reader("run");
    assert_eq!(
        message_ids(
            chats
                .list_agent_unread_requests(WS, &run, None, 100)
                .expect("run requests")
        ),
        ["first", "later @agent"]
    );
    assert_eq!(
        chats
            .list_agent_unread_threads(WS, &run, None, 10)
            .expect("run threads")
            .len(),
        1
    );
}

fn run_reader(run_id: &str) -> AgentReader {
    AgentReader::Run {
        run_id: run_id.to_owned(),
    }
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

/// A person's post that starts its own thread in an agent's chat. Without
/// it, a post there joins the chat's one conversation.
fn ask_in_own_thread(
    chats: &mut LinkedChatStore<'_>,
    user: Option<&str>,
    channel: &str,
    thread: &str,
    message: &str,
    at: i64,
) {
    let input = StartChannelThread {
        channel_id: channel.to_owned(),
        author_user_id: user.map(str::to_owned),
        own_thread: true,
        ..start_input(thread, message, ChatActorKind::Human, at)
    };
    chats
        .start_channel_thread(&input, &NO_FAULTS)
        .expect("own thread");
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
fn a_plain_at_agent_asks_an_agent_named_agent_and_unnamed_agents_apart() {
    let (_scratch, mut store) = open_store();
    let mut chats = LinkedChatStore::new(&mut store);
    agent_chats(&mut chats);
    ask(&mut chats, "channel", "group", "@agent", 10);
    let helper = AgentReader::Connected {
        agent_id: "helper".to_owned(),
        handle: "agent".to_owned(),
        requesters: vec!["ada".to_owned()],
        unattributed_counts: false,
    };
    assert_eq!(requests_for(&chats, &helper), ["@agent"]);
    assert_eq!(requests_for(&chats, &UNNAMED), ["@agent"]);

    chats
        .mark_thread_read_by_agent(WS, &helper, "group", 10, "@agent", None, 20, &NO_FAULTS)
        .expect("connected read");
    assert!(requests_for(&chats, &helper).is_empty());
    assert_eq!(
        requests_for(&chats, &UNNAMED),
        ["@agent"],
        "the agent you run reading leaves the unnamed place where it was."
    );
    chats
        .mark_thread_read_by_agent(WS, &UNNAMED, "group", 10, "@agent", None, 30, &NO_FAULTS)
        .expect("unnamed read");
    assert!(requests_for(&chats, &UNNAMED).is_empty());
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

#[test]
fn a_request_from_before_signing_out_stays_until_its_thread_is_read() {
    let (_scratch, mut store) = open_store();
    let mut chats = LinkedChatStore::new(&mut store);
    agent_chats(&mut chats);
    let reader = terminal(&["me"], true);
    ask_by(&mut chats, Some("me"), "t", "t1", "signed-in", 10);
    ask_in_own_thread(&mut chats, None, "t", "t2", "signed-out", 20);
    assert_eq!(requests_for(&chats, &reader), ["signed-in", "signed-out"]);
    answer(&mut chats, "t", "t2", "answer", 25);
    chats
        .mark_thread_read_by_agent(WS, &reader, "t2", 25, "answer", None, 26, &NO_FAULTS)
        .expect("reply acknowledged");
    assert_eq!(
        requests_for(&chats, &reader),
        ["signed-in"],
        "a reply in one thread never passes over a request in another."
    );
    chats
        .mark_thread_read_by_agent(WS, &reader, "t1", 10, "signed-in", None, 30, &NO_FAULTS)
        .expect("acknowledged");
    assert!(requests_for(&chats, &reader).is_empty());

    ask_in_own_thread(&mut chats, Some("me"), "t", "t3", "first", 40);
    ask_by(&mut chats, None, "t", "t3", "second", 50);
    let page = chats
        .list_agent_unread_requests(WS, &reader, None, 1)
        .expect("first request");
    assert_eq!(
        message_ids(page),
        ["first"],
        "the older request in a thread comes first, so a reply past the later one \
         never passes one the agent was not shown."
    );
    chats
        .mark_thread_read_by_agent(WS, &reader, "t3", 40, "first", None, 60, &NO_FAULTS)
        .expect("acknowledged first");
    assert_eq!(requests_for(&chats, &reader), ["second"]);
}

#[test]
fn a_connected_reader_is_checked() {
    let (_scratch, mut store) = open_store();
    let chats = LinkedChatStore::new(&mut store);
    let bad_id = AgentReader::Connected {
        agent_id: "Terminal".to_owned(),
        handle: "terminal".to_owned(),
        requesters: Vec::new(),
        unattributed_counts: true,
    };
    assert!(matches!(
        chats.list_agent_unread_requests(WS, &bad_id, None, 10),
        Err(dohc_engine_domain::DomainError::InvalidInput { .. })
    ));
    let bad_handle = AgentReader::Connected {
        agent_id: "terminal".to_owned(),
        handle: "@".to_owned(),
        requesters: Vec::new(),
        unattributed_counts: true,
    };
    assert_eq!(
        chats
            .list_agent_unread_requests(WS, &bad_handle, None, 10)
            .unwrap_err()
            .code(),
        "invalid-message-body"
    );
    let too_many = AgentReader::Connected {
        agent_id: "terminal".to_owned(),
        handle: "terminal".to_owned(),
        requesters: (0..65).map(|index| format!("account-{index}")).collect(),
        unattributed_counts: false,
    };
    assert!(matches!(
        chats.list_agent_unread_threads(WS, &too_many, None, 10),
        Err(dohc_engine_domain::DomainError::InvalidInput { .. })
    ));
    assert_eq!(
        chats
            .list_agent_unread_requests(WS, &run_reader("no-such-run"), None, 10)
            .unwrap_err()
            .code(),
        "run-not-found"
    );
}

#[test]
fn a_requests_page_filters_by_group_and_thread_and_carries_what_a_wait_shows() {
    let (_scratch, mut store) = open_store();
    let mut chats = LinkedChatStore::new(&mut store);
    agent_chats(&mut chats);
    ask(&mut chats, "t", "dm", "dm-ask", 10);
    ask(&mut chats, "channel", "group", "ask @terminal", 20);
    ask(&mut chats, "channel", "group", "more @terminal", 20);
    let reader = terminal(&["ada"], false);
    let page = |channel: Option<&str>, thread: Option<&str>, after: Option<(i64, String)>| {
        chats
            .list_agent_requests_page(WS, &reader, channel, thread, after, 10)
            .expect("page")
            .into_iter()
            .map(|row| row.request.message_id)
            .collect::<Vec<_>>()
    };
    assert_eq!(
        page(None, None, None),
        ["dm-ask", "ask @terminal", "more @terminal"]
    );
    assert_eq!(
        page(Some("channel"), None, None),
        ["ask @terminal", "more @terminal"]
    );
    assert_eq!(page(None, Some("dm"), None), ["dm-ask"]);
    assert!(page(Some("t"), Some("group"), None).is_empty());
    assert_eq!(
        page(None, None, Some((20, "ask @terminal".to_owned()))),
        ["more @terminal"],
        "a page continues after the coordinate, ties broken by message id."
    );

    let detail = chats
        .list_agent_requests_page(WS, &reader, None, Some("dm"), None, 10)
        .expect("detail")
        .remove(0);
    assert_eq!(detail.request.author_kind, ChatActorKind::Human);
    assert_eq!(detail.request.created_at_ms, 10);
    assert_eq!(detail.author_display_name, "Ada");
    assert_eq!(detail.body, "dm-ask");
    let channel = detail.channel.expect("the thread's Group");
    assert_eq!(channel.channel_id, "t");
    assert_eq!(channel.kind, ChatChannelKind::Agent);
    assert_eq!(channel.name, "Terminal");
}

#[test]
fn outside_posted_thread_reply_still_counts_when_it_names_a_dohc_agent() {
    let (_scratch, mut store) = open_store();
    base_chat(&mut store);
    let mut chats = LinkedChatStore::new(&mut store);
    start(&mut chats, "thread", "own", ChatActorKind::Agent, 10);
    chats
        .send_message(
            &SendMessage {
                workspace_id: WS.to_owned(),
                thread_id: "thread".to_owned(),
                message_id: "reply".to_owned(),
                author_kind: ChatActorKind::Human,
                author_display_name: "Ada".to_owned(),
                author_user_id: Some("ada".to_owned()),
                author_owner_display_name: None,
                author_agent_id: None,
                author_reported: None,
                work: None,
                parent_message_id: Some("own".to_owned()),
                origin: None,
                body: "@Research, please also look".to_owned(),
                wake_agent_ids: vec!["research".to_owned()],
                automation: None,
                needs_decision: false,
                options: Vec::new(),
                attachments: Vec::new(),
                now_ms: 20,
                request_id: None,
            },
            &NO_FAULTS,
        )
        .expect("reply");
    assert_eq!(
        chats
            .list_pending_dispatches(WS, None, 10)
            .expect("dispatch")
            .len(),
        1
    );
    assert_eq!(outside_requests(&chats), ["reply"]);
}

#[test]
fn outside_participation_excludes_prior_replies_and_named_agents() {
    let (_scratch, mut store) = open_store();
    base_chat(&mut store);
    let mut chats = LinkedChatStore::new(&mut store);
    start(&mut chats, "thread", "root", ChatActorKind::Human, 10);
    send(
        &mut chats,
        "thread",
        "earlier",
        ChatActorKind::Human,
        Some("root"),
        20,
    );
    let mut input = start_input("named", "named-own", ChatActorKind::Agent, 21);
    input.author_agent_id = Some("research".into());
    chats
        .start_channel_thread(&input, &NO_FAULTS)
        .expect("named post");
    send(
        &mut chats,
        "named",
        "named-reply",
        ChatActorKind::Human,
        Some("named-own"),
        22,
    );
    send(
        &mut chats,
        "thread",
        "own",
        ChatActorKind::Agent,
        Some("root"),
        30,
    );
    send(
        &mut chats,
        "thread",
        "later",
        ChatActorKind::Human,
        Some("root"),
        40,
    );
    assert_eq!(outside_requests(&chats), ["later"]);
    assert!(
        chats
            .list_agent_unread_requests(OTHER_WS, &UNNAMED, None, 100)
            .expect("other workspace")
            .is_empty()
    );
    chats
        .mark_thread_read_by_agent(WS, &UNNAMED, "thread", 40, "later", None, 41, &NO_FAULTS)
        .expect("read");
    assert!(outside_requests(&chats).is_empty());
}

#[test]
fn outside_reply_cursor_tie_breaks_by_message_id() {
    let (_scratch, mut store) = open_store();
    base_chat(&mut store);
    let mut chats = LinkedChatStore::new(&mut store);
    start(&mut chats, "thread", "own", ChatActorKind::Agent, 10);
    send(
        &mut chats,
        "thread",
        "a",
        ChatActorKind::Human,
        Some("own"),
        20,
    );
    send(
        &mut chats,
        "thread",
        "b",
        ChatActorKind::Human,
        Some("own"),
        20,
    );
    let first = chats
        .list_agent_unread_requests(WS, &UNNAMED, None, 1)
        .expect("first page");
    assert_eq!(first[0].message_id, "a");
    let second = chats
        .list_agent_unread_requests(WS, &UNNAMED, Some((20, "a".into())), 1)
        .expect("second page");
    assert_eq!(second[0].message_id, "b");
    chats
        .mark_thread_read_by_agent(WS, &UNNAMED, "thread", 20, "a", None, 30, &NO_FAULTS)
        .expect("read");
    assert_eq!(outside_requests(&chats), ["b"]);
}

#[test]
fn outside_requests_keep_mentions_from_a_named_agent() {
    let (_scratch, mut store) = open_store();
    base_chat(&mut store);
    let mut chats = LinkedChatStore::new(&mut store);
    let mut input = start_input("named", "named-mention", ChatActorKind::Agent, 10);
    input.author_agent_id = Some("research".into());
    input.body = "A question for @agent".into();
    chats
        .start_channel_thread(&input, &NO_FAULTS)
        .expect("mention");
    assert_eq!(outside_requests(&chats), ["named-mention"]);
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
fn claim_takes_only_the_listed_agents_oldest_request() {
    let (_scratch, mut store) = open_store();
    let mut chats = LinkedChatStore::new(&mut store);
    for (trigger, agent, at) in [
        ("other-first", "other", 10),
        ("listed-first", "default", 20),
        ("listed-later", "default", 30),
    ] {
        chats
            .enqueue_dispatch(WS, trigger, agent, "thread", at, &NO_FAULTS)
            .expect("enqueue");
    }
    let claim = chats
        .claim_next_pending(WS, "default", "run", "listed-cli", None, 40, &NO_FAULTS)
        .expect("claim")
        .expect("listed agent has a request");
    assert_eq!(claim.dispatch.trigger_message_id, "listed-first");
    assert_eq!(claim.dispatch.agent_id, "default");
    assert_eq!(claim.run.agent_id, "default");
    assert_eq!(claim.run.command, "listed-cli");
    assert_eq!(claim.dispatch.attempt_count, 1);
    chats
        .complete_dispatch(WS, "run", 0, 50, &NO_FAULTS)
        .expect("complete");
    assert!(
        chats
            .claim_next_pending(
                WS,
                "default",
                "run-empty",
                "listed-cli",
                None,
                60,
                &NO_FAULTS,
            )
            .expect("claim without a request for this agent")
            .is_none()
    );
    let pending = chats
        .list_pending_dispatches(WS, None, 10)
        .expect("pending");
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].trigger_message_id, "other-first");
    assert_eq!(pending[0].agent_id, "other");
    assert_eq!(pending[0].attempt_count, 0);
}

#[test]
fn claim_rejects_invalid_agent_ids() {
    let (_scratch, mut store) = open_store();
    let mut chats = LinkedChatStore::new(&mut store);
    for agent in ["", "Not an id", "bad\0id"] {
        let error = chats
            .claim_next_pending(WS, agent, "run", "command", None, 20, &NO_FAULTS)
            .unwrap_err();
        assert_eq!(error.code(), "invalid-input");
    }
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
    assert_eq!(
        (first.generation, second.generation),
        (2, 2),
        "queue on every archive call -> the replay advances generation again."
    );
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
    assert!(
        !stale.applied,
        "remove generation/state CAS -> a stale worker wins."
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
    assert!(
        !stale.applied,
        "remove generation/state CAS -> a stale access check wins."
    );
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
    assert_eq!(
        (first.generation, replay.generation),
        (2, 2),
        "skip request-ledger replay -> generation increments twice."
    );
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
    assert_eq!(
        (rows.len(), rows[0].bookmark.bookmark_id.as_str()),
        (1, second.as_str()),
        "order by bookmark updated time or ignore limit -> wrong first row/count.",
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
    assert_eq!(
        rows.iter()
            .map(|row| row.thread_id.as_str())
            .collect::<Vec<_>>(),
        ["a", "b"],
        "match path/foreign rows or omit the id tie-break -> ids differ.",
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
    assert_eq!(
        chats
            .find_thread_channel_id(WS, "channel-thread")
            .expect("channel"),
        Some("channel".to_owned()),
        "drop workspace/owner semantics -> foreign or file threads return a channel.",
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
    assert_eq!(
        targets,
        ["channel"],
        "omit DM/placeholder filters -> extra follow cells appear."
    );
}

#[test]
fn default_follow_seed_is_insert_ignore() {
    let (_scratch, mut store) = open_store();
    base_chat(&mut store);
    let mut chats = LinkedChatStore::new(&mut store);
    chats
        .ensure_default_channel_follows(WS, "owner", &NO_FAULTS)
        .expect("first");
    chats
        .ensure_default_channel_follows(WS, "owner", &NO_FAULTS)
        .expect("second");
    let count: i64 = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM chat_follows WHERE workspace_id=?1",
                params![WS],
                |r| r.get(0),
            )
            .map_err(StorageError::corrupt_public)
        })
        .expect("count");
    assert_eq!(count, 1, "replace insert-ignore -> duplicates.");
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
fn agent_read_revision_bumps_only_on_advance() {
    let (_scratch, mut store) = open_store();
    base_chat(&mut store);
    let mut chats = LinkedChatStore::new(&mut store);
    start(&mut chats, "thread", "m1", ChatActorKind::Human, 10);
    let first = chats
        .mark_thread_read_by_agent(WS, &UNNAMED, "thread", 10, "m1", None, 20, &NO_FAULTS)
        .expect("first");
    let replay = chats
        .mark_thread_read_by_agent(WS, &UNNAMED, "thread", 10, "m1", Some(1), 21, &NO_FAULTS)
        .expect("replay");
    assert_eq!(
        (first.revision, replay.revision),
        (1, 1),
        "increment revision for no-op coordinates -> replay revision becomes 2."
    );
}

#[test]
fn agent_unread_requires_latest_human_message_beyond_cursor() {
    let (_scratch, mut store) = open_store();
    base_chat(&mut store);
    let mut chats = LinkedChatStore::new(&mut store);
    start(&mut chats, "human", "h1", ChatActorKind::Human, 10);
    start(&mut chats, "agent", "a1", ChatActorKind::Human, 11);
    send(&mut chats, "agent", "a2", ChatActorKind::Agent, None, 12);
    chats
        .mark_thread_read_by_agent(WS, &UNNAMED, "human", 10, "h1", None, 20, &NO_FAULTS)
        .expect("read");
    let rows = chats
        .list_agent_unread_threads(WS, &UNNAMED, None, 10)
        .expect("unread");
    assert!(
        rows.is_empty(),
        "accept agent-latest or cursor-covered threads -> list is nonempty."
    );
}

#[test]
fn agent_unread_tie_breaks_equal_timestamps_by_message_id() {
    let (_scratch, mut store) = open_store();
    base_chat(&mut store);
    let mut chats = LinkedChatStore::new(&mut store);
    start(&mut chats, "thread", "a", ChatActorKind::Human, 10);
    send(&mut chats, "thread", "b", ChatActorKind::Human, None, 10);
    chats
        .mark_thread_read_by_agent(WS, &UNNAMED, "thread", 10, "a", None, 20, &NO_FAULTS)
        .expect("read a");
    let rows = chats
        .list_agent_unread_threads(WS, &UNNAMED, None, 10)
        .expect("unread");
    assert_eq!(
        rows[0].latest_message_id, "b",
        "compare timestamp only -> equal-time message b is missed."
    );
    assert_eq!(rows[0].last_read_created_at_ms, 10);
    assert_eq!(rows[0].last_read_message_id, "a");
}

#[test]
fn pending_dispatch_order_is_created_then_trigger() {
    let (_scratch, mut store) = open_store();
    let mut chats = LinkedChatStore::new(&mut store);
    for (trigger, at) in [("b", 10), ("a", 10), ("old", 9)] {
        chats
            .enqueue_dispatch(WS, trigger, "default", "thread", at, &NO_FAULTS)
            .expect("enqueue");
    }
    let rows = chats
        .list_pending_dispatches(WS, None, 10)
        .expect("pending");
    assert_eq!(
        rows.iter()
            .map(|row| row.trigger_message_id.as_str())
            .collect::<Vec<_>>(),
        ["old", "a", "b"],
        "order by update/id only -> oracle order changes.",
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
fn open_runs_rejects_unmatched_unended_run() {
    let (_scratch, mut store) = open_store();
    store
        .write_with(&NO_FAULTS, |tx| {
            tx.execute(
                "INSERT INTO agent_run_records (workspace_id,run_id,thread_id,trigger_message_id,command,started_at_ms,failure_handled) VALUES (?1,'orphan','thread','trigger','',20,0)",
                params![WS],
            )
            .map_err(StorageError::persist_public)?;
            Ok::<_, StorageError>(())
        })
        .expect("orphan");
    let error = LinkedChatStore::new(&mut store)
        .list_open_dispatch_runs(WS, None, 10)
        .unwrap_err();
    assert_eq!(
        error.code(),
        "state-corrupt",
        "skip unmatched-run preflight -> orphan process state is hidden."
    );
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
                    "INSERT INTO agent_run_records (workspace_id,run_id,thread_id,trigger_message_id,command,started_at_ms,failure_handled) VALUES (?1,'duplicate','thread','trigger','',20,0)",
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
    assert_eq!(
        error.code(),
        "state-corrupt",
        "take the first globally duplicated run -> corruption is returned as data."
    );
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
    assert_eq!(
        rows.iter()
            .map(|row| row.message_id.as_str())
            .collect::<Vec<_>>(),
        ["message-2a", "message-2b"],
        "apply limit after joining links -> only one message from newest run survives.",
    );
}

#[test]
fn recent_dispatch_count_includes_since_boundary() {
    let (_scratch, mut store) = open_store();
    claimed_run(&mut store, "trigger", "thread", "run", 20);
    let count = LinkedChatStore::new(&mut store)
        .recent_dispatch_count(WS, "thread", 20.0)
        .expect("count");
    assert_eq!(count, 1, "change >= to > -> boundary run disappears.");
}

#[test]
fn recent_dispatch_count_skips_runs_a_person_started_in_their_agent_dm_conversation() {
    let (_scratch, mut store) = open_store();
    base_chat(&mut store);
    let conversation = {
        let mut chats = LinkedChatStore::new(&mut store);
        chats
            .ensure_agent_channel(WS, "agent", "default", "My agent", 3, &NO_FAULTS)
            .expect("agent DM");
        let opening = StartChannelThread {
            channel_id: "agent".to_owned(),
            lane: ChatThreadLane::Chat,
            ..start_input("dm", "person-1", ChatActorKind::Human, 10)
        };
        let conversation = chats
            .start_channel_thread(&opening, &NO_FAULTS)
            .expect("person's message")
            .0
            .thread_id;
        send(
            &mut chats,
            &conversation,
            "agent-1",
            ChatActorKind::Agent,
            None,
            11,
        );
        start(&mut chats, "post", "group-1", ChatActorKind::Human, 12);
        // A wake keeps its own post in the DM, and a person's reply there counts.
        let wake = StartChannelThread {
            channel_id: "agent".to_owned(),
            own_thread: true,
            ..start_input("wake", "wake-1", ChatActorKind::Agent, 13)
        };
        chats.start_channel_thread(&wake, &NO_FAULTS).expect("wake");
        send(
            &mut chats,
            "wake",
            "wake-reply",
            ChatActorKind::Human,
            None,
            14,
        );
        conversation
    };
    for (index, (trigger, thread)) in [
        ("person-1", conversation.as_str()),
        ("agent-1", conversation.as_str()),
        ("group-1", "post"),
        ("wake-reply", "wake"),
    ]
    .into_iter()
    .enumerate()
    {
        let run = format!("run-{index}");
        let at = 20 + 10 * index as i64;
        claimed_run(&mut store, trigger, thread, &run, at);
        LinkedChatStore::new(&mut store)
            .complete_dispatch(WS, &run, 0, at + 1, &NO_FAULTS)
            .expect("complete");
    }
    let chats = LinkedChatStore::new(&mut store);
    assert_eq!(
        chats
            .recent_dispatch_count(WS, &conversation, 0.0)
            .expect("DM count"),
        1,
        "only the agent's run counts in the DM"
    );
    assert_eq!(
        chats
            .recent_dispatch_count(WS, "post", 0.0)
            .expect("group count"),
        1,
        "a person's run in a group still counts"
    );
    assert_eq!(
        chats
            .recent_dispatch_count(WS, "wake", 0.0)
            .expect("post count"),
        1,
        "a person's run in a post in the DM still counts"
    );
}

#[test]
fn recent_dispatch_count_accepts_finite_negative_since() {
    let (_scratch, mut store) = open_store();
    claimed_run(&mut store, "trigger", "thread", "run", 20);
    let count = LinkedChatStore::new(&mut store)
        .recent_dispatch_count(WS, "thread", -1.5)
        .expect("count");
    assert_eq!(
        count, 1,
        "impose a nonnegative DTO/domain bound -> this finite oracle input fails."
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
fn record_run_message_rejects_foreign_workspace_run() {
    let (_scratch, mut store) = open_store();
    claimed_run(&mut store, "trigger", "thread", "run", 20);
    let error = LinkedChatStore::new(&mut store)
        .record_run_message(OTHER_WS, "message", "run", &NO_FAULTS)
        .unwrap_err();
    assert_eq!(
        error.code(),
        "run-not-found",
        "trust globally unique run id without workspace check -> foreign link inserts."
    );
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
        tx.execute("INSERT INTO agent_run_records (workspace_id,run_id,thread_id,trigger_message_id,command,started_at_ms,failure_handled) VALUES (?1,'other-run','thread','other-trigger','',30,0)", params![WS]).map_err(StorageError::persist_public)?;
        Ok::<_, StorageError>(())
    }).expect("other run");
    let error = LinkedChatStore::new(&mut store)
        .record_run_message(WS, "message", "other-run", &NO_FAULTS)
        .unwrap_err();
    assert_eq!(
        error.code(),
        "state-corrupt",
        "treat insert-ignore as same-link replay -> collision returns false."
    );
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
    assert_eq!(
        (cleared.paused, cleared.reason),
        (false, None),
        "preserve reason while paused=false -> invalid stale reason remains."
    );
}

#[test]
fn requeue_requires_ended_matching_failed_run_below_attempt_cap() {
    let (_scratch, mut store) = open_store();
    claimed_run(&mut store, "trigger", "thread", "run", 20);
    let requeued = LinkedChatStore::new(&mut store)
        .requeue_failed_trigger(WS, "trigger", "run", 21, &NO_FAULTS)
        .expect("requeue");
    assert!(
        !requeued,
        "remove ended/state/attempt guards -> live running trigger requeues."
    );
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
    assert!(
        requeued && row.run_id.is_none() && row.failure_reason.is_none(),
        "clear only state -> stale run/failure survives the transition."
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
fn completed_error_with_a_reply_is_not_listed_or_requeued() {
    for handled in [false, true] {
        let (_scratch, mut store) = open_store();
        claimed_run(&mut store, "trigger", "thread", "run", 20);
        let mut chats = LinkedChatStore::new(&mut store);
        chats
            .complete_dispatch(WS, "run", 7, 30, &NO_FAULTS)
            .expect("complete");
        chats
            .record_run_message(WS, "reply", "run", &NO_FAULTS)
            .expect("reply");
        if handled {
            chats
                .mark_failure_handled(WS, "run", &NO_FAULTS)
                .expect("handled");
        }
        assert!(
            chats
                .list_failed_run_recoveries(WS, None, None, 10)
                .expect("no recovery")
                .is_empty()
        );
        assert!(
            !chats
                .requeue_failed_trigger(WS, "trigger", "run", 31, &NO_FAULTS)
                .expect("no second reply")
        );
    }
}

#[test]
fn clean_exit_needs_a_confirmed_missing_reply_before_requeue() {
    let (_scratch, mut store) = open_store();
    claimed_run(&mut store, "trigger", "thread", "run", 20);
    let mut chats = LinkedChatStore::new(&mut store);
    chats
        .complete_dispatch(WS, "run", 0, 30, &NO_FAULTS)
        .expect("complete");
    for handled in [false, true] {
        if handled {
            chats
                .mark_failure_handled(WS, "run", &NO_FAULTS)
                .expect("handled");
            chats
                .record_run_message(WS, "reply", "run", &NO_FAULTS)
                .expect("late reply");
        }
        assert!(
            chats
                .list_failed_run_recoveries(WS, None, None, 10)
                .expect("not failed")
                .is_empty()
        );
        assert!(
            !chats
                .requeue_failed_trigger(WS, "trigger", "run", 31, &NO_FAULTS)
                .expect("not failed")
        );
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
fn requeue_returns_the_interrupted_runs_covered_triggers_to_the_queue() {
    let (_scratch, mut store) = open_store();
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
        .fail_dispatch(WS, "run", "app-quit", Some(143), 30, &NO_FAULTS)
        .expect("fail");
    assert!(
        chats
            .requeue_failed_trigger(WS, "first", "run", 31, &NO_FAULTS)
            .expect("requeue")
    );
    let pending: Vec<String> = chats
        .list_pending_dispatches(WS, None, 10)
        .expect("pending")
        .into_iter()
        .map(|row| row.trigger_message_id)
        .collect();
    assert_eq!(
        pending,
        vec!["first".to_owned(), "covered".to_owned()],
        "the next run covers what the interrupted run never answered"
    );
}

#[test]
fn app_quit_failure_remains_durably_recoverable_after_handling() {
    let (_scratch, mut store) = open_store();
    claimed_run(&mut store, "trigger", "thread", "run", 20);
    LinkedChatStore::new(&mut store)
        .mark_failure_handled(WS, "run", &NO_FAULTS)
        .expect("mark failure handled");
    LinkedChatStore::new(&mut store)
        .fail_dispatch(WS, "run", "app-quit", Some(143), 30, &NO_FAULTS)
        .expect("fail");
    let rows = LinkedChatStore::new(&mut store)
        .list_failed_run_recoveries(WS, None, None, 10)
        .expect("recoveries");
    assert_eq!(
        (rows.len(), rows[0].attempt_count),
        (1, 1),
        "A crash after marking the failure handled but before requeue must leave the app-quit run recoverable."
    );
}

#[test]
fn app_quit_recoveries_for_a_thread_skip_other_threads() {
    let (_scratch, mut store) = open_store();
    claimed_run(&mut store, "trigger-1", "thread", "run-1", 20);
    LinkedChatStore::new(&mut store)
        .fail_dispatch(WS, "run-1", "app-quit", Some(143), 21, &NO_FAULTS)
        .expect("fail run-1");
    claimed_run(&mut store, "trigger-2", "other-thread", "run-2", 30);
    LinkedChatStore::new(&mut store)
        .fail_dispatch(WS, "run-2", "app-quit", Some(143), 31, &NO_FAULTS)
        .expect("fail run-2");
    let chats = LinkedChatStore::new(&mut store);
    let runs = |thread_id| {
        chats
            .list_failed_run_recoveries(WS, thread_id, None, 10)
            .expect("recoveries")
            .into_iter()
            .map(|recovery| recovery.run.run_id)
            .collect::<Vec<_>>()
    };
    assert_eq!(runs(None), ["run-1", "run-2"]);
    assert_eq!(
        runs(Some("thread")),
        ["run-1"],
        "drop the thread filter -> a thread lists another thread's stopped runs."
    );
    assert_eq!(runs(Some("absent")), Vec::<String>::new());
}

#[test]
fn restart_failure_remains_durably_recoverable_before_requeue() {
    let (_scratch, mut store) = open_store();
    claimed_run(&mut store, "trigger", "thread", "run", 20);
    LinkedChatStore::new(&mut store)
        .mark_failure_handled(WS, "run", &NO_FAULTS)
        .expect("mark failure handled");
    LinkedChatStore::new(&mut store)
        .fail_dispatch(WS, "run", "app restart during run", None, 30, &NO_FAULTS)
        .expect("fail");
    let rows = LinkedChatStore::new(&mut store)
        .list_failed_run_recoveries(WS, None, None, 10)
        .expect("recoveries");
    assert_eq!(
        rows.first()
            .map(|row| (row.run.failure_reason.as_deref(), row.attempt_count,)),
        Some((Some("app restart during run"), 1)),
        "Marking the failure handled before failing the run must leave it recoverable if requeue never commits.",
    );
}

#[test]
fn failure_handled_mark_is_idempotent_and_requires_one_transition() {
    let (_scratch, mut store) = open_store();
    claimed_run(&mut store, "trigger", "thread", "run", 20);
    let mut chats = LinkedChatStore::new(&mut store);
    let first = chats
        .mark_failure_handled(WS, "run", &NO_FAULTS)
        .expect("first");
    let replay = chats
        .mark_failure_handled(WS, "run", &NO_FAULTS)
        .expect("replay");
    assert!(
        first.failure_handled && replay.failure_handled,
        "require/update more than the one false->true transition -> replay fails or false remains."
    );
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
fn latest_run_for_an_agent_skips_other_agents_runs_in_the_thread() {
    let (_scratch, mut store) = open_store();
    claimed_run(&mut store, "trigger", "thread", "run-default", 20);
    let mut chats = LinkedChatStore::new(&mut store);
    chats
        .complete_dispatch(WS, "run-default", 143, 21, &NO_FAULTS)
        .expect("complete");
    chats
        .enqueue_dispatch(WS, "trigger", "nova", "thread", 19, &NO_FAULTS)
        .expect("enqueue nova");
    chats
        .claim_next_pending(WS, "nova", "run-nova", "agent", None, 30, &NO_FAULTS)
        .expect("claim nova")
        .expect("nova claim");
    let latest = |agent_id| {
        chats
            .latest_run_for_thread(WS, "thread", agent_id)
            .expect("read")
            .map(|run| run.run_id)
    };
    assert_eq!(latest(None).as_deref(), Some("run-nova"));
    assert_eq!(
        latest(Some("default")).as_deref(),
        Some("run-default"),
        "drop the agent filter -> another agent's later run hides this agent's latest run."
    );
    assert_eq!(latest(Some("nova")).as_deref(), Some("run-nova"));
    assert_eq!(latest(Some("absent")), None);
    assert!(
        chats
            .latest_run_for_thread(WS, "thread", Some("Not an id"))
            .is_err()
    );
}

/// A run dohc's quit stopped, in a store from before agent ids, belongs to the
/// default agent after the migration, and Try again runs its request once.
#[test]
fn try_again_runs_a_request_from_before_agent_ids_once() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = engine_db_path(&scratch).expect("db");
    dohc_engine_storage::recovery::create_store_before_migration_for_test(&db, "v2-agent-ids")
        .expect("earlier store");
    let conn = rusqlite::Connection::open(&db).expect("open earlier store");
    conn.execute_batch(
        "INSERT INTO chat_channels (workspace_id, channel_id, name, slug, kind, created_at_ms, updated_at_ms) \
             VALUES ('b2-ws', 'agent', 'My agent', 'my-agent', 'agent', 1, 1); \
         INSERT INTO chat_threads (workspace_id, thread_id, title, created_at_ms, updated_at_ms, channel_id) \
             VALUES ('b2-ws', 'thread', 'Thread', 10, 10, 'agent'); \
         INSERT INTO chat_messages \
             (workspace_id, thread_id, message_order, message_id, author_kind, author_display_name, body, created_at_ms) \
             VALUES ('b2-ws', 'thread', 0, 'trigger', 'human', 'Ada', 'Hi', 10); \
         INSERT INTO chat_dispatch_ledger \
             (workspace_id, trigger_message_id, thread_id, state, run_id, failure_reason, attempt_count, created_at_ms, updated_at_ms) \
             VALUES ('b2-ws', 'trigger', 'thread', 'failed', 'run', 'app-quit', 1, 10, 30); \
         INSERT INTO agent_run_records \
             (workspace_id, run_id, thread_id, trigger_message_id, command, started_at_ms, ended_at_ms, exit_code, failure_reason) \
             VALUES ('b2-ws', 'run', 'thread', 'trigger', 'agent', 20, 30, 143, 'app-quit');",
    )
    .expect("seed the earlier store");
    drop(conn);

    let mut store = EngineStore::open(&db, 1).expect("migrate");
    let mut chats = LinkedChatStore::new(&mut store);
    let recoveries = chats
        .list_failed_run_recoveries(WS, None, None, 10)
        .expect("recoveries");
    assert_eq!(
        recoveries
            .iter()
            .map(|row| (
                row.run.run_id.as_str(),
                row.run.agent_id.as_str(),
                row.attempt_count
            ))
            .collect::<Vec<_>>(),
        vec![("run", "default", 1)]
    );
    assert!(
        chats
            .requeue_failed_trigger(WS, "trigger", "run", 40, &NO_FAULTS)
            .expect("try again")
    );
    assert!(
        !chats
            .requeue_failed_trigger(WS, "trigger", "run", 41, &NO_FAULTS)
            .expect("try again twice"),
        "a second Try again must not queue the request again"
    );
    let claim = chats
        .claim_next_pending(WS, "default", "run-2", "agent", None, 42, &NO_FAULTS)
        .expect("claim")
        .expect("the request runs again");
    assert_eq!(
        (
            claim.dispatch.trigger_message_id.as_str(),
            claim.dispatch.agent_id.as_str(),
            claim.run.agent_id.as_str(),
        ),
        ("trigger", "default", "default")
    );
    chats
        .complete_dispatch(WS, "run-2", 0, 50, &NO_FAULTS)
        .expect("complete");
    assert!(
        chats
            .claim_next_pending(WS, "default", "run-3", "agent", None, 51, &NO_FAULTS)
            .expect("claim")
            .is_none(),
        "the request ran once"
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
