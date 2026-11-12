use dohc_engine_domain::{
    ChatActorKind, ChatChannelKind, ChatCoordinateState, ChatReactionState, ChatStageOutcome,
    ChatThreadLane, CreateFileThread, FollowState, FollowTargetKind, LinkedChatStore,
    LocalAttachmentInput, NoFaults, ResolveDecision, SendMessage, SetFollow, SetReaction,
    StartChannelThread, attachment_id_for, reaction_id_for,
};
use dohc_engine_storage::{EngineStore, FaultPoint, StorageError};
use dohc_engine_testkit::{ScratchDir, ScriptedFaults, engine_db_path};
use rusqlite::{OptionalExtension, params};

const WS: &str = "b2-round3";
const NO_FAULTS: NoFaults = NoFaults;

fn store() -> (ScratchDir, EngineStore) {
    let scratch = ScratchDir::new().expect("scratch");
    let path = engine_db_path(&scratch).expect("db path");
    let store = EngineStore::open(&path, 1).expect("store");
    (scratch, store)
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

fn start(
    store: &mut EngineStore,
    thread_id: &str,
    message_id: &str,
    at_ms: i64,
    needs_decision: bool,
) {
    LinkedChatStore::new(store)
        .start_channel_thread(
            &StartChannelThread {
                automation: None,
                workspace_id: WS.to_owned(),
                channel_id: "channel".to_owned(),
                thread_id: thread_id.to_owned(),
                message_id: message_id.to_owned(),
                title: None,
                lane: ChatThreadLane::Posts,
                own_thread: false,
                author_kind: ChatActorKind::Human,
                author_display_name: "Ada".to_owned(),
                author_owner_display_name: None,
                author_user_id: Some("ada".to_owned()),
                origin: None,
                body: format!("opening {message_id}"),
                needs_decision,
                options: Vec::new(),
                attachments: Vec::new(),
                author_agent_id: None,
                author_reported: None,
                work: None,
                wake_agent_ids: Vec::new(),
                now_ms: at_ms,
                request_id: None,
            },
            &NO_FAULTS,
        )
        .expect("start");
}

fn send(
    store: &mut EngineStore,
    thread_id: &str,
    message_id: &str,
    at_ms: i64,
    needs_decision: bool,
) {
    send_with(
        store,
        thread_id,
        message_id,
        at_ms,
        needs_decision,
        Vec::new(),
    );
}

fn send_with(
    store: &mut EngineStore,
    thread_id: &str,
    message_id: &str,
    at_ms: i64,
    needs_decision: bool,
    attachments: Vec<LocalAttachmentInput>,
) {
    LinkedChatStore::new(store)
        .send_message(
            &SendMessage {
                automation: None,
                workspace_id: WS.to_owned(),
                thread_id: thread_id.to_owned(),
                message_id: message_id.to_owned(),
                author_kind: ChatActorKind::Agent,
                author_display_name: "Agent".to_owned(),
                author_owner_display_name: None,
                author_user_id: Some("agent".to_owned()),
                parent_message_id: None,
                origin: None,
                body: format!("message {message_id}"),
                needs_decision,
                options: Vec::new(),
                attachments,
                author_agent_id: None,
                author_reported: None,
                work: None,
                wake_agent_ids: Vec::new(),
                now_ms: at_ms,
                request_id: None,
            },
            &NO_FAULTS,
        )
        .expect("send");
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

#[allow(clippy::too_many_arguments)]
fn set_reaction(
    store: &mut EngineStore,
    request_id: &str,
    thread_id: &str,
    message_id: &str,
    emoji: &str,
    author_id: &str,
    state: ChatReactionState,
    now_ms: i64,
) -> Result<dohc_engine_domain::ChatReaction, dohc_engine_domain::DomainError> {
    LinkedChatStore::new(store).set_reaction(
        &SetReaction {
            workspace_id: WS.to_owned(),
            thread_id: thread_id.to_owned(),
            message_id: message_id.to_owned(),
            emoji: emoji.to_owned(),
            author_id: author_id.to_owned(),
            replication_author_id: Some(author_id.to_owned()),
            author_kind: ChatActorKind::Human,
            author_display_name: author_id.to_owned(),
            state,
            now_ms,
            request_id: request_id.to_owned(),
        },
        &NO_FAULTS,
    )
}

fn resolve(
    store: &mut EngineStore,
    request_id: &str,
    thread_id: &str,
    message_id: &str,
    resolver: &str,
    now_ms: i64,
) -> Result<dohc_engine_domain::ChatDecision, dohc_engine_domain::DomainError> {
    LinkedChatStore::new(store).resolve_decision(
        &ResolveDecision {
            workspace_id: WS.to_owned(),
            thread_id: thread_id.to_owned(),
            message_id: message_id.to_owned(),
            resolved_by_message_id: resolver.to_owned(),
            chosen_option: None,
            now_ms,
            request_id: request_id.to_owned(),
        },
        &NO_FAULTS,
    )
}

#[test]
fn reaction_id_is_deterministic_across_peers() {
    let first = reaction_id_for("m1", "👍", "alice");
    let second = reaction_id_for("m1", "👍", "alice");
    assert_eq!(
        first, "reaction_nxgdfvb2hr4vetwrk357dtmpb4",
        "deriving ids from local randomness or the mutation timestamp -> peers address different cells."
    );
    assert_eq!(first, second);
}

#[test]
fn reaction_local_toggle_bumps_past_prior_cell() {
    let (_scratch, mut store) = store();
    seed_channel(&mut store);
    start(&mut store, "thread", "message", 20, false);
    let removed = set_reaction(
        &mut store,
        "remove",
        "thread",
        "message",
        "👍",
        "Ada",
        ChatReactionState::Removed,
        100,
    )
    .expect("remove");
    let added = set_reaction(
        &mut store,
        "add",
        "thread",
        "message",
        "👍",
        "Ada",
        ChatReactionState::Added,
        100,
    )
    .expect("add");
    assert_eq!(
        removed.at_ms, 100,
        "using wall time without the per-cell +1 bump -> equal-time remove wins over the later re-add."
    );
    assert_eq!(added.at_ms, 101);
    assert_eq!(added.state, ChatReactionState::Added);
}

#[test]
fn reaction_set_requires_message_in_thread_and_workspace() {
    let (_scratch, mut store) = store();
    seed_channel(&mut store);
    start(&mut store, "thread", "message", 20, false);
    let missing = set_reaction(
        &mut store,
        "missing",
        "thread",
        "other",
        "👍",
        "Ada",
        ChatReactionState::Added,
        30,
    );
    assert!(
        matches!(
            missing,
            Err(dohc_engine_domain::DomainError::Chat {
                code: "message-not-found",
                ..
            })
        ),
        "checking only a message id or skipping the visibility head check -> an absent target receives a reaction."
    );
}

#[test]
fn reaction_set_rejects_non_emoji_graphemes() {
    let (_scratch, mut store) = store();
    seed_channel(&mut store);
    start(&mut store, "thread", "message", 20, false);
    let invalid = set_reaction(
        &mut store,
        "invalid",
        "thread",
        "message",
        "not-an-emoji",
        "Ada",
        ChatReactionState::Added,
        30,
    );
    assert!(
        matches!(
            invalid,
            Err(dohc_engine_domain::DomainError::Chat {
                code: "invalid-message-body",
                ..
            })
        ),
        "accepting arbitrary short strings as reaction keys -> hostile text renders as a reaction pill."
    );
}

#[test]
fn reaction_set_accepts_keycaps_and_subdivision_flags() {
    let (_scratch, mut store) = store();
    seed_channel(&mut store);
    start(&mut store, "thread", "message", 20, false);
    for (index, emoji) in [
        "1️⃣",
        "#️⃣",
        "*️⃣",
        "🏴\u{e0067}\u{e0062}\u{e0065}\u{e006e}\u{e0067}\u{e007f}",
        "🏴\u{e0067}\u{e0062}\u{e0073}\u{e0063}\u{e0074}\u{e007f}",
        "🏴\u{e0067}\u{e0062}\u{e0077}\u{e006c}\u{e0073}\u{e007f}",
    ]
    .into_iter()
    .enumerate()
    {
        set_reaction(
            &mut store,
            &format!("emoji-{index}"),
            "thread",
            "message",
            emoji,
            "Ada",
            ChatReactionState::Added,
            30,
        )
        .expect("reaction");
    }
    for invalid in [
        "1",
        "1\u{fe0f}",
        "🏴\u{e0067}\u{e0062}",
        "🏴\u{e0067}\u{e0062}\u{e0078}\u{e0078}\u{e0078}\u{e007f}",
    ] {
        assert!(!dohc_engine_domain::chats::is_reaction_emoji_verbatim(
            invalid
        ));
    }
}

#[test]
fn reaction_row_and_journal_share_origin_coordinate() {
    let (_scratch, mut store) = store();
    seed_channel(&mut store);
    start(&mut store, "thread", "message", 20, false);
    set_reaction(
        &mut store,
        "coordinate",
        "thread",
        "message",
        "👍",
        "Ada",
        ChatReactionState::Added,
        30,
    )
    .expect("reaction");
    let coordinates: ((String, i64), (String, i64)) = store
        .read_with(|conn| {
            let row = conn
                .query_row(
                    "SELECT origin_id, origin_seq FROM chat_reactions WHERE workspace_id = ?1",
                    [WS],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .map_err(StorageError::corrupt_public)?;
            let op = conn
                .query_row(
                    "SELECT origin_id, origin_seq FROM replication_log \
                     WHERE workspace_id = ?1 AND op_kind = 'chat.reaction.set'",
                    [WS],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .map_err(StorageError::corrupt_public)?;
            Ok::<_, StorageError>((row, op))
        })
        .expect("coordinates");
    assert_eq!(
        coordinates.0, coordinates.1,
        "allocating a second journal sequence after the row upsert -> the replicated tie-break differs from the stored cell."
    );
}

#[test]
fn reaction_without_verified_relay_author_stays_out_of_replication_log() {
    let (_scratch, mut store) = store();
    seed_channel(&mut store);
    start(&mut store, "thread", "message", 20, false);
    let input = SetReaction {
        workspace_id: WS.to_owned(),
        thread_id: "thread".to_owned(),
        message_id: "message".to_owned(),
        emoji: "👍".to_owned(),
        author_id: "local-user".to_owned(),
        replication_author_id: None,
        author_kind: ChatActorKind::Human,
        author_display_name: "Local user".to_owned(),
        state: ChatReactionState::Added,
        now_ms: 30,
        request_id: "local-only-reaction".to_owned(),
    };

    let reaction = LinkedChatStore::new(&mut store)
        .set_reaction(&input, &NO_FAULTS)
        .expect("local reaction");
    assert_eq!(reaction.author_id, "local-user");
    let reaction_ops: i64 = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM replication_log \
                 WHERE workspace_id = ?1 AND op_kind = 'chat.reaction.set'",
                [WS],
                |row| row.get(0),
            )
            .map_err(StorageError::corrupt_public)
        })
        .expect("reaction operation count");
    assert_eq!(reaction_ops, 0);
    assert_eq!(
        store
            .table_row_count("engine_requests")
            .expect("request ledger"),
        1
    );

    let mut verified = input;
    verified.replication_author_id = Some("local-user".to_owned());
    let mismatch = LinkedChatStore::new(&mut store).set_reaction(&verified, &NO_FAULTS);
    assert!(matches!(
        mismatch,
        Err(dohc_engine_domain::DomainError::IdempotencyKeyReuseMismatch)
    ));
}

#[test]
fn reaction_rejects_mismatched_relay_author_before_writing() {
    let (_scratch, mut store) = store();
    seed_channel(&mut store);
    start(&mut store, "thread", "message", 20, false);
    let result = LinkedChatStore::new(&mut store).set_reaction(
        &SetReaction {
            workspace_id: WS.to_owned(),
            thread_id: "thread".to_owned(),
            message_id: "message".to_owned(),
            emoji: "👍".to_owned(),
            author_id: "local-user".to_owned(),
            replication_author_id: Some("other-user".to_owned()),
            author_kind: ChatActorKind::Human,
            author_display_name: "Local user".to_owned(),
            state: ChatReactionState::Added,
            now_ms: 30,
            request_id: "mismatched-reaction".to_owned(),
        },
        &NO_FAULTS,
    );
    assert!(matches!(
        result,
        Err(dohc_engine_domain::DomainError::Chat {
            code: "invalid-sender",
            ..
        })
    ));
    let counts: (i64, i64) = store
        .read_with(|conn| {
            let rows = conn
                .query_row(
                    "SELECT COUNT(*) FROM chat_reactions WHERE workspace_id = ?1",
                    [WS],
                    |row| row.get(0),
                )
                .map_err(StorageError::corrupt_public)?;
            let ops = conn
                .query_row(
                    "SELECT COUNT(*) FROM replication_log \
                     WHERE workspace_id = ?1 AND op_kind = 'chat.reaction.set'",
                    [WS],
                    |row| row.get(0),
                )
                .map_err(StorageError::corrupt_public)?;
            Ok::<_, StorageError>((rows, ops))
        })
        .expect("reaction counts");
    assert_eq!(counts, (0, 0));
    assert_eq!(
        store
            .table_row_count("engine_requests")
            .expect("request ledger"),
        0
    );
}

#[test]
fn reaction_read_hides_tombstones_and_orphans() {
    let (_scratch, mut store) = store();
    seed_channel(&mut store);
    start(&mut store, "thread", "message", 20, false);
    set_reaction(
        &mut store,
        "tombstone",
        "thread",
        "message",
        "👍",
        "Ada",
        ChatReactionState::Removed,
        30,
    )
    .expect("tombstone");
    store
        .write_with(&NO_FAULTS, |tx| {
            tx.execute(
                "INSERT INTO chat_reactions \
                 (workspace_id,reaction_id,thread_id,message_id,emoji,author_id,author_kind,\
                  author_display_name,state,at_ms,origin_id,origin_seq) \
                 VALUES (?1,?2,'thread','orphan','🎉','Bob','human','Bob','added',31,'peer',0)",
                params![WS, reaction_id_for("orphan", "🎉", "Bob")],
            )
            .map_err(StorageError::persist_public)?;
            Ok::<_, StorageError>(())
        })
        .expect("orphan");
    let visible = LinkedChatStore::new(&mut store)
        .list_reactions(WS, "thread", None, 10)
        .expect("list");
    let durable: i64 = store
        .read_with(|conn| {
            conn.query_row("SELECT COUNT(*) FROM chat_reactions", [], |row| row.get(0))
                .map_err(StorageError::corrupt_public)
        })
        .expect("durable count");
    assert!(
        visible.is_empty(),
        "omitting the state filter or message inner join -> tombstones/orphans leak to readers."
    );
    assert_eq!(durable, 2);
}

#[test]
fn personal_feed_hydrates_active_reactions_per_item_in_stable_order() {
    let (_scratch, mut store) = store();
    seed_channel(&mut store);
    start(&mut store, "thread", "message", 20, false);
    LinkedChatStore::new(&mut store)
        .set_follow(
            &SetFollow {
                workspace_id: WS.to_owned(),
                owner_user_id: "viewer".to_owned(),
                replication_owner_user_id: None,
                target_kind: FollowTargetKind::Thread,
                target_id: "thread".to_owned(),
                state: FollowState::Following,
                now_ms: 21,
            },
            &NO_FAULTS,
        )
        .expect("follow");
    set_reaction(
        &mut store,
        "late",
        "thread",
        "message",
        "🎉",
        "Bob",
        ChatReactionState::Added,
        40,
    )
    .expect("late");
    set_reaction(
        &mut store,
        "early",
        "thread",
        "message",
        "👍",
        "Ada",
        ChatReactionState::Added,
        30,
    )
    .expect("early");
    let page = LinkedChatStore::new(&mut store)
        .list_personal_feed(WS, "viewer", Some(10), None)
        .expect("feed");
    assert_eq!(
        page.items[0]
            .reactions
            .iter()
            .map(|reaction| reaction.emoji.as_str())
            .collect::<Vec<_>>(),
        vec!["👍", "🎉"],
        "retaining the parked empty field or failing to sort per candidate -> feed reaction pills disappear or reorder.",
    );
}

#[test]
fn reaction_request_replay_does_not_mint_a_later_cell() {
    let (_scratch, mut store) = store();
    seed_channel(&mut store);
    start(&mut store, "thread", "message", 20, false);
    let first = set_reaction(
        &mut store,
        "replay",
        "thread",
        "message",
        "👍",
        "Ada",
        ChatReactionState::Added,
        30,
    )
    .expect("first");
    let replay = set_reaction(
        &mut store,
        "replay",
        "thread",
        "message",
        "👍",
        "Ada",
        ChatReactionState::Added,
        999,
    )
    .expect("replay");
    let ops: i64 = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM replication_log WHERE op_kind = 'chat.reaction.set'",
                [],
                |row| row.get(0),
            )
            .map_err(StorageError::corrupt_public)
        })
        .expect("ops");
    assert_eq!(
        replay.at_ms, first.at_ms,
        "fingerprinting nowMs or skipping the request ledger -> retry mints a later cell and second op."
    );
    assert_eq!(ops, 1);
}

/// A request hash as a build before this one recorded it: each field's
/// length, then its bytes, with the sender's name only trimmed.
fn recorded_hash(fields: &[&[u8]]) -> String {
    let mut bytes = Vec::new();
    for field in fields {
        bytes.extend_from_slice(&(field.len() as u64).to_le_bytes());
        bytes.extend_from_slice(field);
    }
    dohc_engine_storage::hex_sha256(&bytes)
}

fn record_hash_as_before(store: &mut EngineStore, request_id: &str, hash: &str) {
    store
        .write_with(&NO_FAULTS, |tx| {
            tx.execute(
                "UPDATE engine_requests SET payload_hash = ?2 WHERE request_id = ?1",
                params![request_id, hash],
            )
            .map_err(StorageError::corrupt_public)
        })
        .expect("record the hash");
}

/// A thread start, post or reaction recorded before names dropped hidden
/// characters returns its saved result when it is retried.
#[test]
fn a_request_recorded_before_names_were_cleaned_replays_its_saved_result() {
    let (_scratch, mut store) = store();
    seed_channel(&mut store);
    // The old hash held the name trimmed, so the spaces must not reach it.
    let name = " Ana\u{202E}lisa ";
    let start = StartChannelThread {
        automation: None,
        workspace_id: WS.to_owned(),
        channel_id: "channel".to_owned(),
        thread_id: "thread".to_owned(),
        message_id: "opening".to_owned(),
        title: None,
        lane: ChatThreadLane::Posts,
        own_thread: false,
        author_kind: ChatActorKind::Human,
        author_display_name: name.to_owned(),
        author_owner_display_name: None,
        author_user_id: Some("ana".to_owned()),
        origin: None,
        body: "Opening".to_owned(),
        needs_decision: false,
        options: Vec::new(),
        attachments: Vec::new(),
        author_agent_id: None,
        author_reported: None,
        work: None,
        wake_agent_ids: Vec::new(),
        now_ms: 20,
        request_id: Some("start".to_owned()),
    };
    let send = SendMessage {
        automation: None,
        workspace_id: WS.to_owned(),
        thread_id: "thread".to_owned(),
        message_id: "post".to_owned(),
        author_kind: ChatActorKind::Human,
        author_display_name: name.to_owned(),
        author_owner_display_name: None,
        author_user_id: Some("ana".to_owned()),
        parent_message_id: None,
        origin: None,
        body: "Hi".to_owned(),
        needs_decision: false,
        options: Vec::new(),
        attachments: Vec::new(),
        author_agent_id: None,
        author_reported: None,
        work: None,
        wake_agent_ids: Vec::new(),
        now_ms: 30,
        request_id: Some("post".to_owned()),
    };
    let react = SetReaction {
        workspace_id: WS.to_owned(),
        thread_id: "thread".to_owned(),
        message_id: "post".to_owned(),
        emoji: "👍".to_owned(),
        author_id: "ana".to_owned(),
        replication_author_id: Some("ana".to_owned()),
        author_kind: ChatActorKind::Human,
        author_display_name: name.to_owned(),
        state: ChatReactionState::Added,
        now_ms: 40,
        request_id: "react".to_owned(),
    };
    let mut chats = LinkedChatStore::new(&mut store);
    let (_, opening) = chats
        .start_channel_thread(&start, &NO_FAULTS)
        .expect("start");
    let post = chats.send_message(&send, &NO_FAULTS).expect("post");
    let reaction = chats.set_reaction(&react, &NO_FAULTS).expect("reaction");
    assert_eq!(opening.author_display_name, "Analisa");
    assert_eq!(post.author_display_name, "Analisa");

    // Fields in each request's hash order. A request with no attachments
    // hashes their count, eight zero bytes.
    let (name, none, no_attachments): (&[u8], &[u8], &[u8]) =
        (name.trim().as_bytes(), b"", &[0; 8]);
    let start_hash = recorded_hash(&[
        b"thread",
        b"opening",
        b"channel",
        none,
        b"Opening",
        b"human",
        name,
        none,
        b"ana",
        none,
        b"0",
        none,
        no_attachments,
        none,
        none,
        none,
        none,
        none,
    ]);
    let send_hash = recorded_hash(&[
        b"thread",
        b"post",
        b"Hi",
        b"human",
        name,
        none,
        b"ana",
        none,
        none,
        b"0",
        none,
        no_attachments,
        none,
        none,
        none,
        none,
        none,
    ]);
    let react_hash = recorded_hash(&[
        b"thread",
        b"post",
        "👍".as_bytes(),
        b"ana",
        b"ana",
        b"human",
        name,
        b"added",
    ]);
    record_hash_as_before(&mut store, "start", &start_hash);
    record_hash_as_before(&mut store, "post", &send_hash);
    record_hash_as_before(&mut store, "react", &react_hash);

    let mut chats = LinkedChatStore::new(&mut store);
    let (_, retried_opening) = chats
        .start_channel_thread(&start, &NO_FAULTS)
        .expect("a retried start returns its saved result");
    let retried_post = chats
        .send_message(&send, &NO_FAULTS)
        .expect("a retried post returns its saved result");
    let retried_reaction = chats
        .set_reaction(&react, &NO_FAULTS)
        .expect("a retried reaction returns its saved result");
    assert_eq!(retried_opening, opening);
    assert_eq!(retried_post, post);
    assert_eq!(retried_reaction, reaction);
}

#[test]
fn decision_open_is_atomic_with_start_and_send() {
    let (_scratch, mut store) = store();
    seed_channel(&mut store);
    start(&mut store, "thread", "opening", 20, true);
    send(&mut store, "thread", "reply", 30, true);
    let (cells, ops): (i64, i64) = store
        .read_with(|conn| {
            Ok::<_, StorageError>((
                conn.query_row("SELECT COUNT(*) FROM chat_decisions", [], |row| row.get(0))
                    .map_err(StorageError::corrupt_public)?,
                conn.query_row(
                    "SELECT COUNT(*) FROM replication_log WHERE op_kind = 'chat.decision.set'",
                    [],
                    |row| row.get(0),
                )
                .map_err(StorageError::corrupt_public)?,
            ))
        })
        .expect("counts");
    assert_eq!(
        (cells, ops),
        (2, 2),
        "omitting either in-transaction decision write -> a sent decision prompt has no matching cell/op."
    );

    let failed = LinkedChatStore::new(&mut store).send_message(
        &SendMessage {
            automation: None,
            workspace_id: WS.to_owned(),
            thread_id: "thread".to_owned(),
            message_id: "rolled-back".to_owned(),
            author_kind: ChatActorKind::Agent,
            author_display_name: "Agent".to_owned(),
            author_owner_display_name: None,
            author_user_id: None,
            parent_message_id: None,
            origin: None,
            body: "rolled back".to_owned(),
            needs_decision: true,
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
                "SELECT COUNT(*) FROM chat_decisions WHERE message_id = 'rolled-back'",
                [],
                |row| row.get(0),
            )
            .map_err(StorageError::corrupt_public)
        })
        .expect("leak count");
    assert_eq!(
        leaked, 0,
        "committing the decision outside the message transaction -> a failed send leaks an orphan open decision."
    );
}

#[test]
fn decision_resolve_malformed_resolver_is_invalid_message_body() {
    let (_scratch, mut store) = store();
    seed_channel(&mut store);
    start(&mut store, "thread", "decision", 20, true);
    let malformed = resolve(&mut store, "malformed", "thread", "decision", "", 30);
    assert!(
        matches!(
            malformed,
            Err(dohc_engine_domain::DomainError::Chat {
                code: "invalid-message-body",
                ..
            })
        ),
        "classifying malformed wire input as store corruption -> caller mistakes surface as INTERNAL."
    );
}

#[test]
fn decision_resolve_uses_monotonic_time_and_exact_journal_coordinate() {
    let (_scratch, mut store) = store();
    seed_channel(&mut store);
    start(&mut store, "thread", "decision", 30, true);
    let decision = resolve(
        &mut store,
        "resolve",
        "thread",
        "decision",
        "future-resolver",
        20,
    )
    .expect("resolve");
    let coordinates: ((String, i64), (String, i64)) = store
        .read_with(|conn| {
            let row = conn
                .query_row(
                    "SELECT origin_id, origin_seq FROM chat_decisions WHERE message_id = 'decision'",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .map_err(StorageError::corrupt_public)?;
            let op = conn
                .query_row(
                    "SELECT origin_id, origin_seq FROM replication_log \
                     WHERE op_kind = 'chat.decision.set' ORDER BY origin_seq DESC LIMIT 1",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .map_err(StorageError::corrupt_public)?;
            Ok::<_, StorageError>((row, op))
        })
        .expect("coordinates");
    assert_eq!(
        decision.at_ms, 31,
        "using the stale wall clock or a second sequence allocation -> resolve loses monotonicity or diverges on peers."
    );
    assert_eq!(coordinates.0, coordinates.1);
}

#[test]
fn decision_resolution_omits_a_local_only_resolver_from_relay_payload() {
    let (_scratch, mut store) = store();
    seed_channel(&mut store);
    start(&mut store, "thread", "decision", 20, true);
    LinkedChatStore::new(&mut store)
        .send_message(
            &SendMessage {
                automation: None,
                workspace_id: WS.to_owned(),
                thread_id: "thread".to_owned(),
                message_id: "local-resolver".to_owned(),
                author_kind: ChatActorKind::Human,
                author_display_name: "Local user".to_owned(),
                author_owner_display_name: None,
                author_user_id: None,
                parent_message_id: None,
                origin: None,
                body: "Resolved while signed out".to_owned(),
                needs_decision: false,
                options: Vec::new(),
                attachments: Vec::new(),
                author_agent_id: None,
                author_reported: None,
                work: None,
                wake_agent_ids: Vec::new(),
                now_ms: 30,
                request_id: None,
            },
            &NO_FAULTS,
        )
        .expect("local resolver");

    let decision = resolve(
        &mut store,
        "resolve-local",
        "thread",
        "decision",
        "local-resolver",
        40,
    )
    .expect("resolve");
    assert_eq!(
        decision.resolved_by_message_id.as_deref(),
        Some("local-resolver")
    );

    let payload: serde_json::Value = store
        .read_with(|conn| {
            let payload: String = conn.query_row(
                "SELECT payload_json FROM replication_log \
                 WHERE workspace_id = ?1 AND op_kind = 'chat.decision.set' \
                 ORDER BY origin_seq DESC LIMIT 1",
                [WS],
                |row| row.get(0),
            )?;
            serde_json::from_str(&payload)
                .map_err(|error| rusqlite::Error::ToSqlConversionFailure(error.into()))
        })
        .expect("replicated decision payload");
    assert_eq!(payload["state"], "resolved");
    assert!(payload.get("resolvedByMessageId").is_none());
}

#[test]
fn decision_resolve_returns_existing_winner_idempotently() {
    let (_scratch, mut store) = store();
    seed_channel(&mut store);
    start(&mut store, "thread", "decision", 20, true);
    let first = resolve(
        &mut store,
        "first",
        "thread",
        "decision",
        "resolver-one",
        30,
    )
    .expect("first");
    let second = resolve(
        &mut store,
        "second",
        "thread",
        "decision",
        "resolver-two",
        999,
    )
    .expect("second");
    assert_eq!(
        second, first,
        "writing another resolved cell for an already-resolved decision -> a later retry changes the winning resolver."
    );
    assert_eq!(
        second.resolved_by_message_id.as_deref(),
        Some("resolver-one")
    );
}

#[test]
fn decision_read_hides_orphan_cells() {
    let (_scratch, mut store) = store();
    seed_channel(&mut store);
    start(&mut store, "thread", "message", 20, false);
    store
        .write_with(&NO_FAULTS, |tx| {
            tx.execute(
                "INSERT INTO chat_decisions \
                 (workspace_id,thread_id,message_id,state,resolved_by_message_id,at_ms,origin_id,origin_seq) \
                 VALUES (?1,'thread','orphan','open',NULL,30,'peer',0)",
                [WS],
            )
            .map_err(StorageError::persist_public)?;
            Ok::<_, StorageError>(())
        })
        .expect("orphan");
    let visible = LinkedChatStore::new(&mut store)
        .list_thread_decisions(WS, "thread", None, 10)
        .expect("list");
    let durable: i64 = store
        .read_with(|conn| {
            conn.query_row("SELECT COUNT(*) FROM chat_decisions", [], |row| row.get(0))
                .map_err(StorageError::corrupt_public)
        })
        .expect("durable");
    assert!(
        visible.is_empty(),
        "removing the message inner join -> head-check-free imported decisions leak before their target arrives."
    );
    assert_eq!(durable, 1);
}

#[test]
fn decision_request_replay_does_not_append_a_second_op() {
    let (_scratch, mut store) = store();
    seed_channel(&mut store);
    start(&mut store, "thread", "decision", 20, true);
    let first = resolve(&mut store, "replay", "thread", "decision", "resolver", 30).expect("first");
    let replay =
        resolve(&mut store, "replay", "thread", "decision", "resolver", 999).expect("replay");
    let ops: i64 = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM replication_log WHERE op_kind = 'chat.decision.set'",
                [],
                |row| row.get(0),
            )
            .map_err(StorageError::corrupt_public)
        })
        .expect("ops");
    assert_eq!(
        replay, first,
        "failing to replay through the request ledger -> retry appends a second resolve op."
    );
    assert_eq!(ops, 2, "one open op plus one resolve op");
}

#[test]
fn channel_threads_order_by_newest_activity() {
    let (_scratch, mut store) = store();
    seed_channel(&mut store);
    start(&mut store, "alpha", "alpha-opening", 20, false);
    start(&mut store, "beta", "beta-opening", 30, false);
    send(&mut store, "alpha", "alpha-latest", 40, false);
    let summaries = LinkedChatStore::new(&mut store)
        .list_channel_threads(WS, "channel", None, 10)
        .expect("summaries");
    assert_eq!(
        summaries
            .iter()
            .map(|summary| summary.thread.thread_id.as_str())
            .collect::<Vec<_>>(),
        vec!["alpha", "beta"],
        "ordering by creation/opening message instead of thread activity -> the recently updated thread stays below beta.",
    );
}

#[test]
fn channel_summary_clamps_corrupt_overcount_cursor_and_rejects_negative_cursor() {
    let (_scratch, mut store) = store();
    seed_channel(&mut store);
    start(&mut store, "thread", "message", 20, false);
    store
        .write_with(&NO_FAULTS, |tx| {
            tx.execute(
                "UPDATE chat_thread_read_state SET last_read_sequence = 10 \
                 WHERE workspace_id = ?1 AND thread_id = 'thread'",
                [WS],
            )
            .map_err(StorageError::persist_public)?;
            Ok::<_, StorageError>(())
        })
        .expect("overcount");
    let summaries = LinkedChatStore::new(&mut store)
        .list_channel_threads(WS, "channel", None, 10)
        .expect("clamped");
    assert_eq!(
        summaries[0].last_read_sequence, 1,
        "trusting a persisted over-count cursor -> summary reports more reads than messages or a negative unread count."
    );
    assert_eq!(summaries[0].unread_count, 0);

    store
        .write_with(&NO_FAULTS, |tx| {
            tx.execute(
                "UPDATE chat_thread_read_state SET last_read_sequence = -1 \
                 WHERE workspace_id = ?1 AND thread_id = 'thread'",
                [WS],
            )
            .map_err(StorageError::persist_public)?;
            Ok::<_, StorageError>(())
        })
        .expect("negative");
    let corrupt = LinkedChatStore::new(&mut store).list_channel_threads(WS, "channel", None, 10);
    assert!(
        matches!(
            corrupt,
            Err(dohc_engine_domain::DomainError::StateCorrupt { .. })
        ),
        "clamping negative corruption to zero -> tampered state silently becomes a plausible unread summary."
    );
}

#[test]
fn channel_summary_counts_only_visible_open_decisions() {
    let (_scratch, mut store) = store();
    seed_channel(&mut store);
    start(&mut store, "thread", "visible", 20, true);
    store
        .write_with(&NO_FAULTS, |tx| {
            tx.execute(
                "INSERT INTO chat_decisions \
                 (workspace_id,thread_id,message_id,state,resolved_by_message_id,at_ms,origin_id,origin_seq) \
                 VALUES (?1,'thread','orphan','open',NULL,21,'peer',0)",
                [WS],
            )
            .map_err(StorageError::persist_public)?;
            Ok::<_, StorageError>(())
        })
        .expect("orphan");
    let summaries = LinkedChatStore::new(&mut store)
        .list_channel_threads(WS, "channel", None, 10)
        .expect("summaries");
    assert_eq!(
        summaries[0].open_decision_count, 1,
        "counting decision rows without joining present targets -> the orphan inflates openDecisionCount."
    );
}

#[test]
fn channel_summary_uses_earliest_message_and_500_char_snippet() {
    let (_scratch, mut store) = store();
    seed_channel(&mut store);
    start(&mut store, "thread", "later", 20, false);
    send(&mut store, "thread", "earlier", 10, false);
    let body = format!("{}  tail", "x".repeat(498));
    store
        .write_with(&NO_FAULTS, |tx| {
            tx.execute(
                "UPDATE chat_messages SET body = ?1 WHERE workspace_id = ?2 AND message_id = 'earlier'",
                params![body, WS],
            )
            .map_err(StorageError::persist_public)?;
            Ok::<_, StorageError>(())
        })
        .expect("body");
    let summaries = LinkedChatStore::new(&mut store)
        .list_channel_threads(WS, "channel", None, 10)
        .expect("summaries");
    let opening = summaries[0]
        .opening_message
        .as_ref()
        .expect("opening message");
    assert_eq!(
        opening.message_id, "earlier",
        "selecting message_order or truncating 500 units without trim-before-ellipsis -> wrong opening id/snippet bytes."
    );
    assert_eq!(opening.body_snippet, format!("{}…", "x".repeat(498)));
}

#[test]
fn channel_summary_names_the_agent_that_wrote_the_opening_message() {
    let (_scratch, mut store) = store();
    seed_channel(&mut store);
    LinkedChatStore::new(&mut store)
        .start_channel_thread(
            &StartChannelThread {
                automation: None,
                workspace_id: WS.to_owned(),
                channel_id: "channel".to_owned(),
                thread_id: "thread".to_owned(),
                message_id: "opening".to_owned(),
                title: None,
                lane: ChatThreadLane::Posts,
                own_thread: false,
                author_kind: ChatActorKind::Agent,
                author_display_name: "Codex".to_owned(),
                author_owner_display_name: None,
                author_user_id: None,
                origin: None,
                body: "Done".to_owned(),
                needs_decision: false,
                options: Vec::new(),
                attachments: Vec::new(),
                author_agent_id: Some("codex".to_owned()),
                author_reported: None,
                work: None,
                wake_agent_ids: Vec::new(),
                now_ms: 20,
                request_id: None,
            },
            &NO_FAULTS,
        )
        .expect("start");
    let summaries = LinkedChatStore::new(&mut store)
        .list_channel_threads(WS, "channel", None, 10)
        .expect("summaries");
    let opening = summaries[0]
        .opening_message
        .as_ref()
        .expect("opening message");
    assert_eq!(opening.author_agent_id.as_deref(), Some("codex"));
}

#[test]
fn channel_summary_returns_only_active_opening_reactions_in_stable_order() {
    let (_scratch, mut store) = store();
    seed_channel(&mut store);
    start(&mut store, "thread", "opening", 20, false);
    set_reaction(
        &mut store,
        "late",
        "thread",
        "opening",
        "🎉",
        "Bob",
        ChatReactionState::Added,
        40,
    )
    .expect("late");
    set_reaction(
        &mut store,
        "early",
        "thread",
        "opening",
        "👍",
        "Ada",
        ChatReactionState::Added,
        30,
    )
    .expect("early");
    set_reaction(
        &mut store,
        "removed",
        "thread",
        "opening",
        "👀",
        "Eve",
        ChatReactionState::Removed,
        35,
    )
    .expect("removed");
    send(&mut store, "thread", "reply", 50, false);
    set_reaction(
        &mut store,
        "reply-only",
        "thread",
        "reply",
        "👻",
        "Mallory",
        ChatReactionState::Added,
        60,
    )
    .expect("reply reaction");
    let summaries = LinkedChatStore::new(&mut store)
        .list_channel_threads(WS, "channel", None, 10)
        .expect("summaries");
    let opening = summaries[0]
        .opening_message
        .as_ref()
        .expect("opening message");
    assert_eq!(
        opening
            .reactions
            .iter()
            .map(|reaction| reaction.emoji.as_str())
            .collect::<Vec<_>>(),
        vec!["👍", "🎉"],
        "hydrating all thread reactions or tombstones without `(atMs,reactionId)` order -> reply/removed pills leak or reorder.",
    );
}

#[test]
fn channel_summary_batch_keeps_per_thread_aggregates_apart() {
    let (_scratch, mut store) = store();
    seed_channel(&mut store);
    start(&mut store, "full", "full-opening", 20, true);
    send(&mut store, "full", "full-reply", 30, false);
    set_reaction(
        &mut store,
        "full-react",
        "full",
        "full-opening",
        "👍",
        "Ada",
        ChatReactionState::Added,
        35,
    )
    .expect("reaction");
    start(&mut store, "pruned", "pruned-first", 40, false);
    send(&mut store, "pruned", "pruned-second", 50, false);
    start(&mut store, "empty", "empty-opening", 60, false);
    store
        .write_with(&NO_FAULTS, |tx| {
            tx.execute(
                "DELETE FROM chat_messages WHERE workspace_id = ?1 \
                 AND message_id IN ('pruned-first', 'empty-opening')",
                [WS],
            )
            .map_err(StorageError::persist_public)?;
            tx.execute(
                "DELETE FROM chat_thread_read_state WHERE workspace_id = ?1 \
                 AND thread_id = 'empty'",
                [WS],
            )
            .map_err(StorageError::persist_public)?;
            Ok::<_, StorageError>(())
        })
        .expect("fixture");
    let summaries = LinkedChatStore::new(&mut store)
        .list_channel_threads(WS, "channel", None, 10)
        .expect("summaries");
    assert_eq!(
        summaries
            .iter()
            .map(|summary| summary.thread.thread_id.as_str())
            .collect::<Vec<_>>(),
        vec!["empty", "pruned", "full"],
        "batching the per-thread aggregates without distributing by thread -> counts, read cursors, opening messages, or reactions leak across the page's threads, or a deleted/absent row breaks its neighbors.",
    );
    let empty = &summaries[0];
    assert_eq!(empty.message_count, 0);
    assert_eq!(empty.last_read_sequence, 0);
    assert_eq!(empty.unread_count, 0);
    assert_eq!(empty.open_decision_count, 0);
    assert!(empty.opening_message.is_none());
    let pruned = &summaries[1];
    assert_eq!(pruned.message_count, 1);
    assert_eq!(pruned.last_read_sequence, 1);
    assert_eq!(pruned.unread_count, 0);
    assert_eq!(pruned.open_decision_count, 0);
    let pruned_opening = pruned.opening_message.as_ref().expect("pruned opening");
    assert_eq!(pruned_opening.message_id, "pruned-second");
    assert_eq!(pruned_opening.body_snippet, "message pruned-second");
    assert!(pruned_opening.reactions.is_empty());
    let full = &summaries[2];
    assert_eq!(full.message_count, 2);
    assert_eq!(full.last_read_sequence, 1);
    assert_eq!(full.unread_count, 1);
    assert_eq!(full.open_decision_count, 1);
    let full_opening = full.opening_message.as_ref().expect("full opening");
    assert_eq!(full_opening.message_id, "full-opening");
    assert_eq!(
        full_opening
            .reactions
            .iter()
            .map(|reaction| reaction.emoji.as_str())
            .collect::<Vec<_>>(),
        vec!["👍"]
    );
}

#[test]
fn message_page_batch_keeps_attachments_with_their_own_messages() {
    let (_scratch, mut store) = store();
    seed_channel(&mut store);
    start(&mut store, "thread", "opening", 20, false);
    send_with(
        &mut store,
        "thread",
        "pair",
        30,
        false,
        vec![attachment("alpha"), attachment("beta")],
    );
    send(&mut store, "thread", "bare", 40, false);
    send_with(
        &mut store,
        "thread",
        "solo",
        50,
        false,
        vec![attachment("gamma")],
    );
    let page = LinkedChatStore::new(&mut store)
        .list_messages(WS, "thread", 10, None)
        .expect("page");
    let mut pair_objects = vec!["alpha", "beta"];
    pair_objects.sort_by_key(|object| attachment_id_for("pair", object, None, None));
    let by_message: Vec<(&str, Vec<&str>)> = page
        .messages
        .iter()
        .map(|message| {
            (
                message.message_id.as_str(),
                message
                    .attachments
                    .iter()
                    .map(|attachment| attachment.object_id.as_deref().expect("object id"))
                    .collect(),
            )
        })
        .collect();
    assert_eq!(
        by_message,
        vec![
            ("opening", Vec::new()),
            ("pair", pair_objects),
            ("bare", Vec::new()),
            ("solo", vec!["gamma"]),
        ]
    );
    for message in &page.messages {
        for attachment in &message.attachments {
            assert_eq!(attachment.message_id, message.message_id);
            assert_eq!(attachment.thread_id, "thread");
        }
    }
}

#[test]
fn js_trimmed_author_user_id_matches_person_follow() {
    let (_scratch, mut store) = store();
    seed_channel(&mut store);
    LinkedChatStore::new(&mut store)
        .start_channel_thread(
            &StartChannelThread {
                automation: None,
                workspace_id: WS.to_owned(),
                channel_id: "channel".to_owned(),
                thread_id: "trimmed-author".to_owned(),
                message_id: "opening".to_owned(),
                title: None,
                lane: ChatThreadLane::Posts,
                own_thread: false,
                author_kind: ChatActorKind::Human,
                author_display_name: "Ada".to_owned(),
                author_owner_display_name: None,
                author_user_id: Some("\u{FEFF}ada\u{FEFF}".to_owned()),
                origin: None,
                body: "Opening".to_owned(),
                needs_decision: false,
                options: Vec::new(),
                attachments: Vec::new(),
                author_agent_id: None,
                author_reported: None,
                work: None,
                wake_agent_ids: Vec::new(),
                now_ms: 20,
                request_id: None,
            },
            &NO_FAULTS,
        )
        .expect("thread");
    LinkedChatStore::new(&mut store)
        .set_follow(
            &SetFollow {
                workspace_id: WS.to_owned(),
                owner_user_id: "viewer".to_owned(),
                replication_owner_user_id: None,
                target_kind: FollowTargetKind::Person,
                target_id: "ada".to_owned(),
                state: FollowState::Following,
                now_ms: 21,
            },
            &NO_FAULTS,
        )
        .expect("follow");
    let feed = LinkedChatStore::new(&mut store)
        .list_personal_feed(WS, "viewer", Some(10), None)
        .expect("feed");
    assert_eq!(
        feed.items.len(),
        1,
        "use Rust trim instead of JS trim -> the stored U+FEFF-edged id misses this follow."
    );
    assert_eq!(feed.items[0].message.author_user_id.as_deref(), Some("ada"));
    assert_eq!(feed.items[0].matched_by, vec![FollowTargetKind::Person]);
}

#[test]
fn lone_bom_display_name_is_invalid_sender() {
    let (_scratch, mut store) = store();
    seed_channel(&mut store);
    let result = LinkedChatStore::new(&mut store).start_channel_thread(
        &StartChannelThread {
            automation: None,
            workspace_id: WS.to_owned(),
            channel_id: "channel".to_owned(),
            thread_id: "invalid-display".to_owned(),
            message_id: "opening".to_owned(),
            title: None,
            lane: ChatThreadLane::Posts,
            own_thread: false,
            author_kind: ChatActorKind::Human,
            author_display_name: "\u{FEFF}".to_owned(),
            author_owner_display_name: None,
            author_user_id: None,
            origin: None,
            body: "Opening".to_owned(),
            needs_decision: false,
            options: Vec::new(),
            attachments: Vec::new(),
            author_agent_id: None,
            author_reported: None,
            work: None,
            wake_agent_ids: Vec::new(),
            now_ms: 20,
            request_id: None,
        },
        &NO_FAULTS,
    );
    assert!(
        matches!(
            result,
            Err(dohc_engine_domain::DomainError::Chat {
                code: "invalid-sender",
                ..
            })
        ),
        "use Rust trim -> U+FEFF survives as a non-empty display name."
    );
}

#[test]
fn channel_name_and_optional_thread_title_use_js_trim() {
    let (_scratch, mut store) = store();
    let channel = LinkedChatStore::new(&mut store)
        .create_channel(
            WS,
            "channel",
            "\u{FEFF}General\u{FEFF}",
            ChatChannelKind::Channel,
            10,
            &NO_FAULTS,
        )
        .expect("channel");
    LinkedChatStore::new(&mut store)
        .start_channel_thread(
            &StartChannelThread {
                automation: None,
                workspace_id: WS.to_owned(),
                channel_id: "channel".to_owned(),
                thread_id: "untitled".to_owned(),
                message_id: "opening".to_owned(),
                title: Some("\u{FEFF}".to_owned()),
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
                attachments: Vec::new(),
                author_agent_id: None,
                author_reported: None,
                work: None,
                wake_agent_ids: Vec::new(),
                now_ms: 20,
                request_id: None,
            },
            &NO_FAULTS,
        )
        .expect("thread");
    let stored_title: String = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT title FROM chat_threads WHERE workspace_id = ?1 AND thread_id = 'untitled'",
                [WS],
                |row| row.get(0),
            )
            .map_err(StorageError::corrupt_public)
        })
        .expect("stored title");
    assert_eq!(
        channel.name, "General",
        "use Rust trim for either sibling -> BOMs remain in the name/title."
    );
    assert_eq!(stored_title, "");
}

#[test]
fn optional_thread_title_caps_utf16_units_before_journaling() {
    let (_scratch, mut store) = store();
    seed_channel(&mut store);
    let accepted = LinkedChatStore::new(&mut store).start_channel_thread(
        &StartChannelThread {
            automation: None,
            workspace_id: WS.to_owned(),
            channel_id: "channel".to_owned(),
            thread_id: "title-boundary".to_owned(),
            message_id: "title-boundary-opening".to_owned(),
            title: Some("😀".repeat(100)),
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
            attachments: Vec::new(),
            author_agent_id: None,
            author_reported: None,
            work: None,
            wake_agent_ids: Vec::new(),
            now_ms: 20,
            request_id: None,
        },
        &NO_FAULTS,
    );
    let rejected = LinkedChatStore::new(&mut store).start_channel_thread(
        &StartChannelThread {
            automation: None,
            workspace_id: WS.to_owned(),
            channel_id: "channel".to_owned(),
            thread_id: "title-over-cap".to_owned(),
            message_id: "title-over-cap-opening".to_owned(),
            title: Some("😀".repeat(101)),
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
            attachments: Vec::new(),
            author_agent_id: None,
            author_reported: None,
            work: None,
            wake_agent_ids: Vec::new(),
            now_ms: 21,
            request_id: None,
        },
        &NO_FAULTS,
    );
    let poisoned_ops: i64 = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM replication_log \
                 WHERE workspace_id = ?1 AND payload_json LIKE '%title-over-cap%'",
                [WS],
                |row| row.get(0),
            )
            .map_err(StorageError::corrupt_public)
        })
        .expect("poisoned op count");
    assert!(
        accepted.is_ok(),
        "count Unicode scalar values instead of UTF-16 units -> the 101-astral title journals a thread.create every TypeScript peer refuses."
    );
    assert!(rejected.is_err());
    assert_eq!(poisoned_ops, 0);
}

#[test]
fn channel_sender_and_author_caps_use_utf16_units() {
    let (_scratch, mut store) = store();
    let accepted_channel = LinkedChatStore::new(&mut store).create_channel(
        WS,
        "boundary-channel",
        &format!("a{}b", "😀".repeat(39)),
        ChatChannelKind::Channel,
        10,
        &NO_FAULTS,
    );
    let rejected_channel = LinkedChatStore::new(&mut store).create_channel(
        WS,
        "over-cap-channel",
        &format!("a{}", "😀".repeat(40)),
        ChatChannelKind::Channel,
        11,
        &NO_FAULTS,
    );
    let accepted_sender = LinkedChatStore::new(&mut store).start_channel_thread(
        &StartChannelThread {
            automation: None,
            workspace_id: WS.to_owned(),
            channel_id: "boundary-channel".to_owned(),
            thread_id: "sender-boundary".to_owned(),
            message_id: "sender-boundary-opening".to_owned(),
            title: None,
            lane: ChatThreadLane::Posts,
            own_thread: false,
            author_kind: ChatActorKind::Human,
            author_display_name: format!("a{}b", "😀".repeat(99)),
            author_owner_display_name: None,
            author_user_id: Some(format!("a{}b", "😀".repeat(99))),
            origin: None,
            body: "Opening".to_owned(),
            needs_decision: false,
            options: Vec::new(),
            attachments: Vec::new(),
            author_agent_id: None,
            author_reported: None,
            work: None,
            wake_agent_ids: Vec::new(),
            now_ms: 20,
            request_id: None,
        },
        &NO_FAULTS,
    );
    let rejected_display = LinkedChatStore::new(&mut store).start_channel_thread(
        &StartChannelThread {
            automation: None,
            workspace_id: WS.to_owned(),
            channel_id: "boundary-channel".to_owned(),
            thread_id: "display-over-cap".to_owned(),
            message_id: "display-over-cap-opening".to_owned(),
            title: None,
            lane: ChatThreadLane::Posts,
            own_thread: false,
            author_kind: ChatActorKind::Human,
            author_display_name: format!("a{}", "😀".repeat(100)),
            author_owner_display_name: None,
            author_user_id: None,
            origin: None,
            body: "Opening".to_owned(),
            needs_decision: false,
            options: Vec::new(),
            attachments: Vec::new(),
            author_agent_id: None,
            author_reported: None,
            work: None,
            wake_agent_ids: Vec::new(),
            now_ms: 21,
            request_id: None,
        },
        &NO_FAULTS,
    );
    let rejected_author = LinkedChatStore::new(&mut store).start_channel_thread(
        &StartChannelThread {
            automation: None,
            workspace_id: WS.to_owned(),
            channel_id: "boundary-channel".to_owned(),
            thread_id: "author-over-cap".to_owned(),
            message_id: "author-over-cap-opening".to_owned(),
            title: None,
            lane: ChatThreadLane::Posts,
            own_thread: false,
            author_kind: ChatActorKind::Human,
            author_display_name: "Ada".to_owned(),
            author_owner_display_name: None,
            author_user_id: Some(format!("a{}", "😀".repeat(100))),
            origin: None,
            body: "Opening".to_owned(),
            needs_decision: false,
            options: Vec::new(),
            attachments: Vec::new(),
            author_agent_id: None,
            author_reported: None,
            work: None,
            wake_agent_ids: Vec::new(),
            now_ms: 22,
            request_id: None,
        },
        &NO_FAULTS,
    );
    assert!(
        accepted_channel.is_ok(),
        "count Rust chars in any sibling normalizer -> its over-cap astral input is accepted even though JavaScript length exceeds the cap."
    );
    assert!(rejected_channel.is_err());
    assert!(accepted_sender.is_ok());
    assert!(rejected_display.is_err());
    assert!(rejected_author.is_err());
}

#[test]
fn thread_mutations_reject_negative_timestamps_before_journaling() {
    let (_scratch, mut store) = store();
    seed_channel(&mut store);
    let start_result = LinkedChatStore::new(&mut store).start_channel_thread(
        &StartChannelThread {
            automation: None,
            workspace_id: WS.to_owned(),
            channel_id: "channel".to_owned(),
            thread_id: "negative-channel-thread".to_owned(),
            message_id: "negative-opening".to_owned(),
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
            attachments: Vec::new(),
            author_agent_id: None,
            author_reported: None,
            work: None,
            wake_agent_ids: Vec::new(),
            now_ms: -1,
            request_id: None,
        },
        &NO_FAULTS,
    );
    let create_result = LinkedChatStore::new(&mut store).create_thread(
        &CreateFileThread {
            workspace_id: WS.to_owned(),
            thread_id: "negative-file-thread".to_owned(),
            title: "File thread".to_owned(),
            linked_object_id: "object".to_owned(),
            linked_path_hint: None,
            now_ms: -1,
            request_id: "negative-file-thread".to_owned(),
        },
        &NO_FAULTS,
    );
    let journaled: i64 = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM replication_log WHERE workspace_id = ?1 AND op_kind = 'chat.thread.create'",
                [WS],
                |row| row.get(0),
            )
            .map_err(StorageError::corrupt_public)
        })
        .expect("journal count");
    assert!(
        start_result.is_err(),
        "allow either negative local timestamp -> Rust mints a thread op JS peers refuse."
    );
    assert!(create_result.is_err());
    assert_eq!(journaled, 0);
}

#[test]
fn thread_mutations_reject_timestamps_above_the_wire_integer_max() {
    let (_scratch, mut store) = store();
    seed_channel(&mut store);
    let above_max = 9_007_199_254_740_992;
    let start_result = LinkedChatStore::new(&mut store).start_channel_thread(
        &StartChannelThread {
            automation: None,
            workspace_id: WS.to_owned(),
            channel_id: "channel".to_owned(),
            thread_id: "unsafe-channel-thread".to_owned(),
            message_id: "unsafe-opening".to_owned(),
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
            attachments: Vec::new(),
            author_agent_id: None,
            author_reported: None,
            work: None,
            wake_agent_ids: Vec::new(),
            now_ms: above_max,
            request_id: None,
        },
        &NO_FAULTS,
    );
    let create_result = LinkedChatStore::new(&mut store).create_thread(
        &CreateFileThread {
            workspace_id: WS.to_owned(),
            thread_id: "unsafe-file-thread".to_owned(),
            title: "File thread".to_owned(),
            linked_object_id: "object".to_owned(),
            linked_path_hint: None,
            now_ms: above_max,
            request_id: "unsafe-file-thread".to_owned(),
        },
        &NO_FAULTS,
    );
    let journaled: i64 = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM replication_log \
                 WHERE workspace_id = ?1 AND op_kind = 'chat.thread.create'",
                [WS],
                |row| row.get(0),
            )
            .map_err(StorageError::corrupt_public)
        })
        .expect("journal count");
    assert!(
        start_result.is_err(),
        "check only the lower timestamp bound -> an unsafe integer is journaled even though both strict receivers refuse it."
    );
    assert!(create_result.is_err());
    assert_eq!(journaled, 0);
}

#[test]
fn channel_thread_start_refuses_unreplicable_stored_channel_identity() {
    for corrupt_wire_id in [false, true] {
        let (_scratch, mut store) = store();
        seed_channel(&mut store);
        store
            .write_with(&NO_FAULTS, |tx| {
                if corrupt_wire_id {
                    tx.execute(
                        "UPDATE chat_channel_wire_ids SET wire_id = ' padded-wire ' \
                         WHERE workspace_id = ?1 AND channel_id = 'channel'",
                        [WS],
                    )
                    .map_err(StorageError::persist_public)?;
                } else {
                    tx.execute(
                        "UPDATE chat_channels SET slug = 'invalid slug' \
                         WHERE workspace_id = ?1 AND channel_id = 'channel'",
                        [WS],
                    )
                    .map_err(StorageError::persist_public)?;
                }
                Ok::<_, StorageError>(())
            })
            .expect("corrupt imported channel identity");
        let result = LinkedChatStore::new(&mut store).start_channel_thread(
            &StartChannelThread {
                automation: None,
                workspace_id: WS.to_owned(),
                channel_id: "channel".to_owned(),
                thread_id: "thread".to_owned(),
                message_id: "opening".to_owned(),
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
                attachments: Vec::new(),
                author_agent_id: None,
                author_reported: None,
                work: None,
                wake_agent_ids: Vec::new(),
                now_ms: 20,
                request_id: None,
            },
            &NO_FAULTS,
        );
        let journaled: i64 = store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT COUNT(*) FROM replication_log \
                     WHERE workspace_id = ?1 AND op_kind = 'chat.thread.create'",
                    [WS],
                    |row| row.get(0),
                )
                .map_err(StorageError::corrupt_public)
            })
            .expect("journal count");
        assert!(
            matches!(
                result,
                Err(dohc_engine_domain::DomainError::StateCorrupt { .. })
            ),
            "trusting imported channel metadata lets a local start mint a channelSlug/channelWireId that apply_thread rejects."
        );
        assert_eq!(journaled, 0);
    }
}

#[test]
fn agent_read_negative_coordinate_noops_without_revision() {
    let (_scratch, mut store) = store();
    seed_channel(&mut store);
    start(&mut store, "thread", "opening", 20, false);
    let state = LinkedChatStore::new(&mut store)
        .mark_thread_read_by_agent(
            WS,
            &dohc_engine_domain::AgentReader::Unnamed,
            "thread",
            -1,
            "before",
            None,
            30,
            &NO_FAULTS,
        )
        .expect("negative coordinate");
    assert_eq!(
        state.last_read_created_at_ms, 0,
        "retain the nonnegative cursor gate -> this oracle-valid clamp no-op errors."
    );
    assert_eq!(state.last_read_message_id, "");
    assert_eq!(state.revision, 0);
}

// ------------------------------------------------------------ stage receipts

/// A chat handle that records a stage receipt for each keyed write.
fn receipted(store: &mut EngineStore) -> LinkedChatStore<'_> {
    let mut chats = LinkedChatStore::new(store);
    chats.record_stage_receipts(true);
    chats
}

type JournalRow = (String, i64, String);
type Receipt = (String, String, Option<String>, Vec<(String, i64)>);

fn local_journal(store: &EngineStore) -> Vec<JournalRow> {
    store
        .read_with(|conn| {
            let mut stmt = conn.prepare(
                "SELECT origin_id, origin_seq, op_kind FROM replication_log \
                 WHERE workspace_id = ?1 AND imported = 0 ORDER BY origin_id, origin_seq",
            )?;
            stmt.query_map([WS], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
                .collect::<Result<Vec<_>, _>>()
        })
        .expect("journal")
}

fn added_rows(before: &[JournalRow], after: &[JournalRow]) -> Vec<JournalRow> {
    after
        .iter()
        .filter(|row| !before.contains(row))
        .cloned()
        .collect()
}

fn coordinates_of(rows: &[JournalRow]) -> Vec<(String, i64)> {
    rows.iter()
        .map(|(origin_id, origin_seq, _)| (origin_id.clone(), *origin_seq))
        .collect()
}

fn kinds_of(rows: &[JournalRow]) -> Vec<&str> {
    rows.iter().map(|(_, _, kind)| kind.as_str()).collect()
}

fn receipt(store: &EngineStore, stage_key: &str) -> Option<Receipt> {
    let row: Option<(String, String, Option<String>, String)> = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT outcome, thread_id, winner_message_id, coordinates_json \
                 FROM chat_stage_receipts WHERE workspace_id = ?1 AND stage_key = ?2",
                params![WS, stage_key],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()
        })
        .expect("receipt");
    row.map(|(outcome, thread_id, winner, coordinates)| {
        let coordinates: Vec<serde_json::Value> =
            serde_json::from_str(&coordinates).expect("coordinates");
        let coordinates = coordinates
            .iter()
            .map(|coordinate| {
                (
                    coordinate["originId"].as_str().expect("origin").to_owned(),
                    coordinate["originSeq"].as_i64().expect("sequence"),
                )
            })
            .collect();
        (outcome, thread_id, winner, coordinates)
    })
}

fn receipt_count(store: &EngineStore) -> i64 {
    store
        .read_with(|conn| {
            conn.query_row("SELECT COUNT(*) FROM chat_stage_receipts", [], |row| {
                row.get(0)
            })
        })
        .expect("receipt count")
}

fn keyed_post(key: &str, thread_id: &str, message_id: &str, at_ms: i64) -> StartChannelThread {
    StartChannelThread {
        automation: None,
        workspace_id: WS.to_owned(),
        channel_id: "channel".to_owned(),
        thread_id: thread_id.to_owned(),
        message_id: message_id.to_owned(),
        title: None,
        lane: ChatThreadLane::Posts,
        own_thread: false,
        author_kind: ChatActorKind::Human,
        author_display_name: "Ada".to_owned(),
        author_owner_display_name: None,
        author_user_id: Some("ada".to_owned()),
        origin: None,
        body: format!("opening {message_id}"),
        needs_decision: true,
        options: Vec::new(),
        attachments: Vec::new(),
        author_agent_id: None,
        author_reported: None,
        work: None,
        wake_agent_ids: Vec::new(),
        now_ms: at_ms,
        request_id: Some(key.to_owned()),
    }
}

fn keyed_reply(key: &str, message_id: &str, author: &str, at_ms: i64) -> SendMessage {
    SendMessage {
        automation: None,
        workspace_id: WS.to_owned(),
        thread_id: "thread".to_owned(),
        message_id: message_id.to_owned(),
        author_kind: ChatActorKind::Human,
        author_display_name: author.to_owned(),
        author_owner_display_name: None,
        author_user_id: Some(author.to_owned()),
        parent_message_id: Some("opening".to_owned()),
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
        request_id: Some(key.to_owned()),
    }
}

fn keyed_resolve(key: &str, resolver: &str, at_ms: i64) -> ResolveDecision {
    ResolveDecision {
        workspace_id: WS.to_owned(),
        thread_id: "thread".to_owned(),
        message_id: "opening".to_owned(),
        resolved_by_message_id: resolver.to_owned(),
        chosen_option: None,
        now_ms: at_ms,
        request_id: key.to_owned(),
    }
}

fn keyed_reaction(key: &str, author: &str, state: ChatReactionState, at_ms: i64) -> SetReaction {
    SetReaction {
        workspace_id: WS.to_owned(),
        thread_id: "thread".to_owned(),
        message_id: "opening".to_owned(),
        emoji: "👍".to_owned(),
        author_id: author.to_owned(),
        replication_author_id: Some(author.to_owned()),
        author_kind: ChatActorKind::Human,
        author_display_name: author.to_owned(),
        state,
        now_ms: at_ms,
        request_id: key.to_owned(),
    }
}

#[test]
fn keyed_post_receipt_lists_every_journal_row_the_post_added() {
    let (_scratch, mut store) = store();
    seed_channel(&mut store);
    let before = local_journal(&store);
    let (thread, _) = receipted(&mut store)
        .start_channel_thread(&keyed_post("post", "thread", "opening", 20), &NO_FAULTS)
        .expect("post");
    let added = added_rows(&before, &local_journal(&store));
    for kind in [
        "chat.message.append",
        "chat.follow.set",
        "chat.decision.set",
    ] {
        assert!(
            kinds_of(&added).contains(&kind),
            "{kind} missing from {added:?}"
        );
    }
    assert_eq!(
        receipt(&store, "post"),
        Some((
            "written".to_owned(),
            thread.thread_id,
            None,
            coordinates_of(&added)
        )),
        "counting only the message row -> the structure, follow, and decision rows publish unwatched."
    );

    start(&mut store, "unkeyed", "unkeyed-opening", 30, false);
    assert_eq!(
        receipt_count(&store),
        1,
        "an unkeyed write has no stage to receipt"
    );
}

#[test]
fn keyed_chat_lane_post_receipt_names_the_thread_it_joined() {
    let (_scratch, mut store) = store();
    seed_channel(&mut store);
    let mut first = keyed_post("first", "lane-a", "first-message", 20);
    first.lane = ChatThreadLane::Chat;
    first.needs_decision = false;
    let mut second = keyed_post("second", "lane-b", "second-message", 30);
    second.lane = ChatThreadLane::Chat;
    second.needs_decision = false;
    let mut chats = receipted(&mut store);
    chats
        .start_channel_thread(&first, &NO_FAULTS)
        .expect("first");
    let (joined, _) = chats
        .start_channel_thread(&second, &NO_FAULTS)
        .expect("second");
    assert_eq!(joined.thread_id, "lane-a");
    assert_eq!(
        receipt(&store, "second").map(|receipt| receipt.1),
        Some("lane-a".to_owned()),
        "recording the requested thread id -> recovery looks for a thread that never existed."
    );
}

#[test]
fn keyed_reply_receipts_list_their_own_follow_and_attachment_rows() {
    let (_scratch, mut store) = store();
    seed_channel(&mut store);
    start(&mut store, "thread", "opening", 20, false);

    let before = local_journal(&store);
    let mut first = keyed_reply("reply-1", "bea-1", "bea", 30);
    first.attachments = vec![attachment("alpha")];
    receipted(&mut store)
        .send_message(&first, &NO_FAULTS)
        .expect("first reply");
    let first_rows = added_rows(&before, &local_journal(&store));
    for kind in [
        "chat.message.append",
        "chat.follow.set",
        "chat.attachment.add",
    ] {
        assert!(
            kinds_of(&first_rows).contains(&kind),
            "{kind} missing from {first_rows:?}"
        );
    }
    assert_eq!(
        receipt(&store, "reply-1").map(|receipt| receipt.3),
        Some(coordinates_of(&first_rows))
    );

    let before = local_journal(&store);
    receipted(&mut store)
        .send_message(&keyed_reply("reply-2", "bea-2", "bea", 40), &NO_FAULTS)
        .expect("second reply");
    let second_rows = added_rows(&before, &local_journal(&store));
    assert_eq!(kinds_of(&second_rows), vec!["chat.message.append"]);
    assert_eq!(
        receipt(&store, "reply-2"),
        Some((
            "written".to_owned(),
            "thread".to_owned(),
            None,
            coordinates_of(&second_rows)
        )),
        "listing a follow the author already had -> the stage waits on another stage's row."
    );
}

#[test]
fn reaction_receipt_replays_its_original_cell_after_a_later_change() {
    let (_scratch, mut store) = store();
    seed_channel(&mut store);
    start(&mut store, "thread", "opening", 20, false);
    let before = local_journal(&store);
    let added = receipted(&mut store)
        .set_reaction(
            &keyed_reaction("add", "cy", ChatReactionState::Added, 30),
            &NO_FAULTS,
        )
        .expect("add");
    let rows = added_rows(&before, &local_journal(&store));
    assert_eq!(
        kinds_of(&rows),
        vec!["chat.reaction.set", "chat.follow.set"]
    );
    let recorded = receipt(&store, "add");
    assert_eq!(
        recorded,
        Some((
            "written".to_owned(),
            "thread".to_owned(),
            None,
            coordinates_of(&rows)
        ))
    );

    receipted(&mut store)
        .set_reaction(
            &keyed_reaction("remove", "cy", ChatReactionState::Removed, 40),
            &NO_FAULTS,
        )
        .expect("remove");
    let journal = local_journal(&store);
    let receipts = receipt_count(&store);
    let replayed = receipted(&mut store)
        .set_reaction(
            &keyed_reaction("add", "cy", ChatReactionState::Added, 999),
            &NO_FAULTS,
        )
        .expect("replay");
    assert_eq!(
        replayed, added,
        "replaying the current cell -> a retried add answers the later remove."
    );
    assert_eq!(local_journal(&store), journal);
    assert_eq!(receipt_count(&store), receipts);
    assert_eq!(receipt(&store, "add"), recorded);
}

#[test]
fn resolve_receipts_keep_written_lost_and_no_op_after_the_cell_changes() {
    let (_scratch, mut store) = store();
    seed_channel(&mut store);
    start(&mut store, "thread", "opening", 20, true);

    let before = local_journal(&store);
    let written = receipted(&mut store)
        .resolve_decision(&keyed_resolve("answer-one", "reply-one", 30), &NO_FAULTS)
        .expect("written");
    let rows = added_rows(&before, &local_journal(&store));
    assert_eq!(kinds_of(&rows), vec!["chat.decision.set"]);
    assert_eq!(
        receipt(&store, "answer-one"),
        Some((
            "written".to_owned(),
            "thread".to_owned(),
            None,
            coordinates_of(&rows)
        ))
    );

    let journal = local_journal(&store);
    let lost = receipted(&mut store)
        .resolve_decision(&keyed_resolve("answer-two", "reply-two", 40), &NO_FAULTS)
        .expect("lost");
    assert_eq!(lost, written);
    assert_eq!(
        receipt(&store, "answer-two"),
        Some((
            "lost".to_owned(),
            "thread".to_owned(),
            Some("reply-one".to_owned()),
            Vec::new()
        )),
        "recording an existing winner as written -> the losing answer reports saved."
    );
    receipted(&mut store)
        .resolve_decision(&keyed_resolve("answer-again", "reply-one", 50), &NO_FAULTS)
        .expect("no-op");
    assert_eq!(
        receipt(&store, "answer-again"),
        Some(("no-op".to_owned(), "thread".to_owned(), None, Vec::new())),
        "the reply that already won did not lose"
    );
    assert_eq!(local_journal(&store), journal);

    // Another copy's later resolution replaces the cell.
    store
        .write_with(&NO_FAULTS, |tx| {
            tx.execute(
                "UPDATE chat_decisions SET resolved_by_message_id = 'reply-three', at_ms = 500 \
                 WHERE workspace_id = ?1 AND message_id = 'opening'",
                [WS],
            )
            .map_err(StorageError::persist_public)?;
            Ok::<_, StorageError>(())
        })
        .expect("later resolution");
    let receipts = receipt_count(&store);
    let mut chats = receipted(&mut store);
    assert_eq!(
        chats
            .resolve_decision(&keyed_resolve("answer-two", "reply-two", 999), &NO_FAULTS)
            .expect("replayed lost"),
        written,
        "replaying the current cell -> a lost answer names a winner it never saw."
    );
    assert_eq!(
        chats
            .resolve_decision(&keyed_resolve("answer-one", "reply-one", 999), &NO_FAULTS)
            .expect("replayed written"),
        written
    );
    assert_eq!(local_journal(&store), journal);
    assert_eq!(receipt_count(&store), receipts);
    assert_eq!(
        receipt(&store, "answer-two").and_then(|receipt| receipt.2),
        Some("reply-one".to_owned())
    );
}

#[test]
fn each_keyed_chat_write_commits_its_receipt_with_the_write() {
    let scratch = ScratchDir::new().expect("scratch");
    let path = engine_db_path(&scratch).expect("db path");
    let mut store = EngineStore::open(&path, 1).expect("store");
    seed_channel(&mut store);
    let post = keyed_post("post", "thread", "opening", 20);
    let reply = keyed_reply("reply", "bea-reply", "bea", 30);
    let answer = keyed_resolve("answer", "bea-reply", 40);
    let reaction = keyed_reaction("react", "cy", ChatReactionState::Added, 50);
    let stages = ["post", "reply", "answer", "react"];
    for (index, stage) in stages.into_iter().enumerate() {
        for point in [
            FaultPoint::StorageBeforePersist,
            FaultPoint::StorageAfterCommitBeforeAck,
        ] {
            let faults = ScriptedFaults::crash_at(point);
            let before = local_journal(&store);
            let mut chats = receipted(&mut store);
            let failed = match index {
                0 => chats
                    .start_channel_thread(&post, faults.as_ref())
                    .map(|_| ()),
                1 => chats.send_message(&reply, faults.as_ref()).map(|_| ()),
                2 => chats.resolve_decision(&answer, faults.as_ref()).map(|_| ()),
                _ => chats.set_reaction(&reaction, faults.as_ref()).map(|_| ()),
            };
            assert_eq!(failed.unwrap_err().code(), "persist-failed");
            assert!(faults.fired());
            let committed = point == FaultPoint::StorageAfterCommitBeforeAck;
            assert_eq!(
                receipt(&store, stage).is_some(),
                committed,
                "writing {stage}'s receipt outside its transaction -> a crash keeps one without the other."
            );
            assert_eq!(local_journal(&store) != before, committed, "{stage}");
        }
    }
    drop(store);

    let mut store = EngineStore::open(&path, 2).expect("reopen");
    let journal = local_journal(&store);
    let receipts: Vec<Option<Receipt>> =
        stages.iter().map(|stage| receipt(&store, stage)).collect();
    let mut chats = receipted(&mut store);
    chats
        .start_channel_thread(&post, &NO_FAULTS)
        .expect("post retry");
    chats.send_message(&reply, &NO_FAULTS).expect("reply retry");
    chats
        .resolve_decision(&answer, &NO_FAULTS)
        .expect("answer retry");
    chats
        .set_reaction(&reaction, &NO_FAULTS)
        .expect("reaction retry");
    assert_eq!(
        local_journal(&store),
        journal,
        "a retry after reopen writes nothing"
    );
    for (stage, recorded) in stages.iter().zip(receipts) {
        let recorded = recorded.expect("receipt after reopen");
        assert_eq!(recorded.0, "written", "{stage}");
        assert!(!recorded.3.is_empty(), "{stage}");
        assert_eq!(receipt(&store, stage), Some(recorded));
    }
}

#[test]
fn publication_state_reads_each_coordinate_against_its_origin_cursor_and_refusals() {
    let (_scratch, mut store) = store();
    seed_channel(&mut store);
    receipted(&mut store)
        .start_channel_thread(&keyed_post("post", "thread", "opening", 20), &NO_FAULTS)
        .expect("post");
    let mut chats = receipted(&mut store);
    chats
        .resolve_decision(&keyed_resolve("answer-one", "reply-one", 30), &NO_FAULTS)
        .expect("answer");
    chats
        .resolve_decision(&keyed_resolve("answer-two", "reply-two", 40), &NO_FAULTS)
        .expect("lost answer");
    let posted = receipt(&store, "post").expect("post receipt").3;
    assert!(posted.len() >= 3, "{posted:?}");
    let origin = posted[0].0.clone();

    let keys = |keys: &[&str]| keys.iter().map(|key| (*key).to_owned()).collect::<Vec<_>>();
    let states = |store: &mut EngineStore, key: &str| {
        let answer = receipted(store)
            .publication_state(WS, &keys(&[key]))
            .expect("publication state");
        answer[0]
            .receipt
            .as_ref()
            .expect("present")
            .coordinates
            .iter()
            .map(|coordinate| coordinate.state)
            .collect::<Vec<_>>()
    };

    let answer = receipted(&mut store)
        .publication_state(WS, &keys(&["post", "answer-two", "missing"]))
        .expect("publication state");
    assert_eq!(
        answer
            .iter()
            .map(|stage| stage.stage_key.as_str())
            .collect::<Vec<_>>(),
        vec!["post", "answer-two", "missing"]
    );
    assert!(
        answer[2].receipt.is_none(),
        "a stage that never committed is absent"
    );
    let lost = answer[1].receipt.as_ref().expect("lost receipt");
    assert_eq!(lost.outcome, ChatStageOutcome::Lost);
    assert_eq!(lost.winner_message_id.as_deref(), Some("reply-one"));
    assert!(
        lost.coordinates.is_empty(),
        "a lost stage needs no publication"
    );
    let post = answer[0].receipt.as_ref().expect("post receipt");
    assert_eq!(post.outcome, ChatStageOutcome::Written);
    assert_eq!(post.thread_id, "thread");
    assert!(
        post.coordinates
            .iter()
            .all(|coordinate| coordinate.state == ChatCoordinateState::Pending),
        "an origin without a push cursor has pushed nothing"
    );

    // Pushed through the second row: the first is below the cursor, the
    // second equal to it, and the rest above.
    store
        .write_with(&NO_FAULTS, |tx| {
            tx.execute(
                "INSERT INTO sync_relay_push_state (workspace_id, origin_id, pushed_seq) VALUES (?1, ?2, ?3)",
                params![WS, origin, posted[1].1],
            )
            .map_err(StorageError::persist_public)?;
            Ok::<_, StorageError>(())
        })
        .expect("cursor");
    let mut expected = vec![ChatCoordinateState::Pushed, ChatCoordinateState::Pushed];
    expected.resize(posted.len(), ChatCoordinateState::Pending);
    assert_eq!(states(&mut store, "post"), expected);

    // A refusal wins over the cursor, from a notice or from a settlement
    // admission that outlives the notice.
    let last = posted.len() - 1;
    store
        .write_with(&NO_FAULTS, |tx| {
            tx.execute(
                "INSERT INTO replication_pending_refusals \
                 (workspace_id, origin_id, origin_seq, op_kind, reason_code, reason_message) \
                 SELECT workspace_id, origin_id, origin_seq, op_kind, 'invalid-input', 'refused' \
                 FROM replication_log WHERE workspace_id = ?1 AND origin_id = ?2 AND origin_seq = ?3",
                params![WS, origin, posted[0].1],
            )
            .map_err(StorageError::persist_public)?;
            tx.execute(
                "INSERT INTO live_settlement_publication_admissions \
                 (workspace_id, origin_id, origin_seq, moment_id, admission_json) \
                 VALUES (?1, ?2, ?3, 'moment', '{\"status\":\"refused\",\"settlementId\":\"s\",\"reason\":\"r\"}')",
                params![WS, origin, posted[last].1],
            )
            .map_err(StorageError::persist_public)?;
            Ok::<_, StorageError>(())
        })
        .expect("refusals");
    expected[0] = ChatCoordinateState::Refused;
    expected[last] = ChatCoordinateState::Refused;
    assert_eq!(states(&mut store, "post"), expected);

    // Each coordinate reads its own origin's cursor, and a receipt belongs
    // to its workspace.
    store
        .write_with(&NO_FAULTS, |tx| {
            tx.execute_batch(&format!(
                "INSERT INTO chat_stage_receipts \
                 (workspace_id, stage_key, outcome, thread_id, coordinates_json) VALUES \
                 ('{WS}', 'multi', 'written', 'thread', \
                  '[{{\"originId\":\"other-a\",\"originSeq\":4}},{{\"originId\":\"other-b\",\"originSeq\":0}}]'), \
                 ('another-workspace', 'missing', 'written', 'thread', '[]'); \
                 INSERT INTO sync_relay_push_state (workspace_id, origin_id, pushed_seq) VALUES \
                 ('{WS}', 'other-a', 4), ('another-workspace', 'other-b', 9);"
            ))
            .map_err(StorageError::persist_public)?;
            Ok::<_, StorageError>(())
        })
        .expect("other origins");
    assert_eq!(
        states(&mut store, "multi"),
        vec![ChatCoordinateState::Pushed, ChatCoordinateState::Pending],
        "reading one cursor for every origin -> another origin's row reads as pushed."
    );
    let scoped = receipted(&mut store)
        .publication_state(WS, &keys(&["missing"]))
        .expect("scoped");
    assert!(
        scoped[0].receipt.is_none(),
        "another workspace's receipt is not this one's"
    );
    let elsewhere = receipted(&mut store)
        .publication_state("another-workspace", &keys(&["post"]))
        .expect("elsewhere");
    assert!(elsewhere[0].receipt.is_none());

    let too_many: Vec<String> = (0..=dohc_engine_domain::MAX_PUBLICATION_STAGE_KEYS)
        .map(|index| format!("stage-{index}"))
        .collect();
    assert!(matches!(
        receipted(&mut store).publication_state(WS, &too_many),
        Err(dohc_engine_domain::DomainError::InvalidInput { .. })
    ));
}

#[test]
fn a_keyed_write_without_a_stage_receipt_records_none() {
    let (_scratch, mut store) = store();
    seed_channel(&mut store);
    let mut chats = LinkedChatStore::new(&mut store);
    chats
        .start_channel_thread(&keyed_post("post", "thread", "opening", 20), &NO_FAULTS)
        .expect("post");
    chats
        .send_message(&keyed_reply("reply", "bea-reply", "bea", 30), &NO_FAULTS)
        .expect("reply");
    chats
        .resolve_decision(&keyed_resolve("answer", "bea-reply", 40), &NO_FAULTS)
        .expect("answer");
    chats
        .set_reaction(
            &keyed_reaction("react", "cy", ChatReactionState::Added, 50),
            &NO_FAULTS,
        )
        .expect("reaction");
    assert_eq!(
        receipt_count(&store),
        0,
        "recording a receipt for every keyed write -> each desktop post pays for phone publication state."
    );
    let keys: Vec<String> = ["post", "reply", "answer", "react"]
        .iter()
        .map(|key| (*key).to_owned())
        .collect();
    let answer = LinkedChatStore::new(&mut store)
        .publication_state(WS, &keys)
        .expect("publication state");
    assert!(answer.iter().all(|stage| stage.receipt.is_none()));
}
