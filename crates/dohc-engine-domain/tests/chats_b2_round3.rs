use dohc_engine_domain::{
    ChatActorKind, ChatChannelKind, ChatReactionState, CreateFileThread, FollowState,
    FollowTargetKind, LinkedChatStore, NoFaults, ResolveDecision, SendMessage, SetFollow,
    SetReaction, StartChannelThread, reaction_id_for,
};
use dohc_engine_storage::{EngineStore, FaultPoint, StorageError};
use dohc_engine_testkit::{ScratchDir, ScriptedFaults};
use rusqlite::params;

const WS: &str = "b2-round3";
const NO_FAULTS: NoFaults = NoFaults;

fn store() -> (ScratchDir, EngineStore) {
    let scratch = ScratchDir::new().expect("scratch");
    let path = scratch.engine_db_path().expect("db path");
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
                workspace_id: WS.to_owned(),
                channel_id: "channel".to_owned(),
                thread_id: thread_id.to_owned(),
                message_id: message_id.to_owned(),
                title: None,
                author_kind: ChatActorKind::Human,
                author_display_name: "Ada".to_owned(),
                author_user_id: Some("ada".to_owned()),
                origin: None,
                body: format!("opening {message_id}"),
                needs_decision,
                attachments: Vec::new(),
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
    LinkedChatStore::new(store)
        .send_message(
            &SendMessage {
                workspace_id: WS.to_owned(),
                thread_id: thread_id.to_owned(),
                message_id: message_id.to_owned(),
                author_kind: ChatActorKind::Agent,
                author_display_name: "Agent".to_owned(),
                author_user_id: Some("agent".to_owned()),
                parent_message_id: None,
                origin: None,
                body: format!("message {message_id}"),
                needs_decision,
                attachments: Vec::new(),
                now_ms: at_ms,
                request_id: None,
            },
            &NO_FAULTS,
        )
        .expect("send");
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
    // MUTATION: deriving ids from local randomness or the mutation timestamp -> peers address different cells.
    assert_eq!(first, "reaction_nxgdfvb2hr4vetwrk357dtmpb4");
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
    // MUTATION: using wall time without the per-cell +1 bump -> equal-time remove wins over the later re-add.
    assert_eq!(removed.at_ms, 100);
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
    // MUTATION: checking only a message id or skipping the visibility head check -> an absent target receives a reaction.
    assert!(matches!(
        missing,
        Err(dohc_engine_domain::DomainError::Chat {
            code: "message-not-found",
            ..
        })
    ));
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
    // MUTATION: accepting arbitrary short strings as reaction keys -> hostile text renders as a reaction pill.
    assert!(matches!(
        invalid,
        Err(dohc_engine_domain::DomainError::Chat {
            code: "invalid-message-body",
            ..
        })
    ));
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
    // MUTATION: allocating a second journal sequence after the row upsert -> the replicated tie-break differs from the stored cell.
    assert_eq!(coordinates.0, coordinates.1);
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
    assert_eq!(store.request_ledger_len().expect("request ledger"), 1);

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
    assert_eq!(store.request_ledger_len().expect("request ledger"), 0);
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
    // MUTATION: omitting the state filter or message inner join -> tombstones/orphans leak to readers.
    assert!(visible.is_empty());
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
    // MUTATION: retaining the parked empty field or failing to sort per candidate -> feed reaction pills disappear or reorder.
    assert_eq!(
        page.items[0]
            .reactions
            .iter()
            .map(|reaction| reaction.emoji.as_str())
            .collect::<Vec<_>>(),
        vec!["👍", "🎉"]
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
    // MUTATION: fingerprinting nowMs or skipping the request ledger -> retry mints a later cell and second op.
    assert_eq!(replay.at_ms, first.at_ms);
    assert_eq!(ops, 1);
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
    // MUTATION: omitting either in-transaction decision write -> a sent decision prompt has no matching cell/op.
    assert_eq!((cells, ops), (2, 2));

    let failed = LinkedChatStore::new(&mut store).send_message(
        &SendMessage {
            workspace_id: WS.to_owned(),
            thread_id: "thread".to_owned(),
            message_id: "rolled-back".to_owned(),
            author_kind: ChatActorKind::Agent,
            author_display_name: "Agent".to_owned(),
            author_user_id: None,
            parent_message_id: None,
            origin: None,
            body: "rolled back".to_owned(),
            needs_decision: true,
            attachments: Vec::new(),
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
    // MUTATION: committing the decision outside the message transaction -> a failed send leaks an orphan open decision.
    assert_eq!(leaked, 0);
}

#[test]
fn decision_resolve_malformed_resolver_is_invalid_message_body() {
    let (_scratch, mut store) = store();
    seed_channel(&mut store);
    start(&mut store, "thread", "decision", 20, true);
    let malformed = resolve(&mut store, "malformed", "thread", "decision", "", 30);
    // MUTATION: classifying malformed wire input as store corruption -> caller mistakes surface as INTERNAL.
    assert!(matches!(
        malformed,
        Err(dohc_engine_domain::DomainError::Chat {
            code: "invalid-message-body",
            ..
        })
    ));
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
    // MUTATION: using the stale wall clock or a second sequence allocation -> resolve loses monotonicity or diverges on peers.
    assert_eq!(decision.at_ms, 31);
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
                workspace_id: WS.to_owned(),
                thread_id: "thread".to_owned(),
                message_id: "local-resolver".to_owned(),
                author_kind: ChatActorKind::Human,
                author_display_name: "Local user".to_owned(),
                author_user_id: None,
                parent_message_id: None,
                origin: None,
                body: "Resolved while signed out".to_owned(),
                needs_decision: false,
                attachments: Vec::new(),
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
    // MUTATION: writing another resolved cell for an already-resolved decision -> a later retry changes the winning resolver.
    assert_eq!(second, first);
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
    // MUTATION: removing the message inner join -> head-check-free imported decisions leak before their target arrives.
    assert!(visible.is_empty());
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
    // MUTATION: failing to replay through the request ledger -> retry appends a second resolve op.
    assert_eq!(replay, first);
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
    // MUTATION: ordering by creation/opening message instead of thread activity -> the recently updated thread stays below beta.
    assert_eq!(
        summaries
            .iter()
            .map(|summary| summary.thread.thread_id.as_str())
            .collect::<Vec<_>>(),
        vec!["alpha", "beta"]
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
    // MUTATION: trusting a persisted over-count cursor -> summary reports more reads than messages or a negative unread count.
    assert_eq!(summaries[0].last_read_sequence, 1);
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
    // MUTATION: clamping negative corruption to zero -> tampered state silently becomes a plausible unread summary.
    assert!(matches!(
        corrupt,
        Err(dohc_engine_domain::DomainError::StateCorrupt { .. })
    ));
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
    // MUTATION: counting decision rows without joining present targets -> the orphan inflates openDecisionCount.
    assert_eq!(summaries[0].open_decision_count, 1);
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
    // MUTATION: selecting message_order or truncating 500 units without trim-before-ellipsis -> wrong opening id/snippet bytes.
    assert_eq!(opening.message_id, "earlier");
    assert_eq!(opening.body_snippet, format!("{}…", "x".repeat(498)));
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
    // MUTATION: hydrating all thread reactions or tombstones without `(atMs,reactionId)` order -> reply/removed pills leak or reorder.
    assert_eq!(
        opening
            .reactions
            .iter()
            .map(|reaction| reaction.emoji.as_str())
            .collect::<Vec<_>>(),
        vec!["👍", "🎉"]
    );
}

#[test]
fn js_trimmed_author_user_id_matches_person_follow() {
    let (_scratch, mut store) = store();
    seed_channel(&mut store);
    LinkedChatStore::new(&mut store)
        .start_channel_thread(
            &StartChannelThread {
                workspace_id: WS.to_owned(),
                channel_id: "channel".to_owned(),
                thread_id: "trimmed-author".to_owned(),
                message_id: "opening".to_owned(),
                title: None,
                author_kind: ChatActorKind::Human,
                author_display_name: "Ada".to_owned(),
                author_user_id: Some("\u{FEFF}ada\u{FEFF}".to_owned()),
                origin: None,
                body: "Opening".to_owned(),
                needs_decision: false,
                attachments: Vec::new(),
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
    // MUTATION: use Rust trim instead of JS trim -> the stored U+FEFF-edged id misses this follow.
    assert_eq!(feed.items.len(), 1);
    assert_eq!(feed.items[0].message.author_user_id.as_deref(), Some("ada"));
    assert_eq!(feed.items[0].matched_by, vec![FollowTargetKind::Person]);
}

#[test]
fn lone_bom_display_name_is_invalid_sender() {
    let (_scratch, mut store) = store();
    seed_channel(&mut store);
    let result = LinkedChatStore::new(&mut store).start_channel_thread(
        &StartChannelThread {
            workspace_id: WS.to_owned(),
            channel_id: "channel".to_owned(),
            thread_id: "invalid-display".to_owned(),
            message_id: "opening".to_owned(),
            title: None,
            author_kind: ChatActorKind::Human,
            author_display_name: "\u{FEFF}".to_owned(),
            author_user_id: None,
            origin: None,
            body: "Opening".to_owned(),
            needs_decision: false,
            attachments: Vec::new(),
            now_ms: 20,
            request_id: None,
        },
        &NO_FAULTS,
    );
    // MUTATION: use Rust trim -> U+FEFF survives as a non-empty display name.
    assert!(matches!(
        result,
        Err(dohc_engine_domain::DomainError::Chat {
            code: "invalid-sender",
            ..
        })
    ));
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
                workspace_id: WS.to_owned(),
                channel_id: "channel".to_owned(),
                thread_id: "untitled".to_owned(),
                message_id: "opening".to_owned(),
                title: Some("\u{FEFF}".to_owned()),
                author_kind: ChatActorKind::Human,
                author_display_name: "Ada".to_owned(),
                author_user_id: None,
                origin: None,
                body: "Opening".to_owned(),
                needs_decision: false,
                attachments: Vec::new(),
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
    // MUTATION: use Rust trim for either sibling -> BOMs remain in the name/title.
    assert_eq!(channel.name, "General");
    assert_eq!(stored_title, "");
}

#[test]
fn optional_thread_title_caps_utf16_units_before_journaling() {
    let (_scratch, mut store) = store();
    seed_channel(&mut store);
    let accepted = LinkedChatStore::new(&mut store).start_channel_thread(
        &StartChannelThread {
            workspace_id: WS.to_owned(),
            channel_id: "channel".to_owned(),
            thread_id: "title-boundary".to_owned(),
            message_id: "title-boundary-opening".to_owned(),
            title: Some("😀".repeat(100)),
            author_kind: ChatActorKind::Human,
            author_display_name: "Ada".to_owned(),
            author_user_id: None,
            origin: None,
            body: "Opening".to_owned(),
            needs_decision: false,
            attachments: Vec::new(),
            now_ms: 20,
            request_id: None,
        },
        &NO_FAULTS,
    );
    let rejected = LinkedChatStore::new(&mut store).start_channel_thread(
        &StartChannelThread {
            workspace_id: WS.to_owned(),
            channel_id: "channel".to_owned(),
            thread_id: "title-over-cap".to_owned(),
            message_id: "title-over-cap-opening".to_owned(),
            title: Some("😀".repeat(101)),
            author_kind: ChatActorKind::Human,
            author_display_name: "Ada".to_owned(),
            author_user_id: None,
            origin: None,
            body: "Opening".to_owned(),
            needs_decision: false,
            attachments: Vec::new(),
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
    // MUTATION: count Unicode scalar values instead of UTF-16 units -> the
    // 101-astral title journals a thread.create every TypeScript peer refuses.
    assert!(accepted.is_ok());
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
            workspace_id: WS.to_owned(),
            channel_id: "boundary-channel".to_owned(),
            thread_id: "sender-boundary".to_owned(),
            message_id: "sender-boundary-opening".to_owned(),
            title: None,
            author_kind: ChatActorKind::Human,
            author_display_name: format!("a{}b", "😀".repeat(99)),
            author_user_id: Some(format!("a{}b", "😀".repeat(99))),
            origin: None,
            body: "Opening".to_owned(),
            needs_decision: false,
            attachments: Vec::new(),
            now_ms: 20,
            request_id: None,
        },
        &NO_FAULTS,
    );
    let rejected_display = LinkedChatStore::new(&mut store).start_channel_thread(
        &StartChannelThread {
            workspace_id: WS.to_owned(),
            channel_id: "boundary-channel".to_owned(),
            thread_id: "display-over-cap".to_owned(),
            message_id: "display-over-cap-opening".to_owned(),
            title: None,
            author_kind: ChatActorKind::Human,
            author_display_name: format!("a{}", "😀".repeat(100)),
            author_user_id: None,
            origin: None,
            body: "Opening".to_owned(),
            needs_decision: false,
            attachments: Vec::new(),
            now_ms: 21,
            request_id: None,
        },
        &NO_FAULTS,
    );
    let rejected_author = LinkedChatStore::new(&mut store).start_channel_thread(
        &StartChannelThread {
            workspace_id: WS.to_owned(),
            channel_id: "boundary-channel".to_owned(),
            thread_id: "author-over-cap".to_owned(),
            message_id: "author-over-cap-opening".to_owned(),
            title: None,
            author_kind: ChatActorKind::Human,
            author_display_name: "Ada".to_owned(),
            author_user_id: Some(format!("a{}", "😀".repeat(100))),
            origin: None,
            body: "Opening".to_owned(),
            needs_decision: false,
            attachments: Vec::new(),
            now_ms: 22,
            request_id: None,
        },
        &NO_FAULTS,
    );
    // MUTATION: count Rust chars in any sibling normalizer -> its over-cap
    // astral input is accepted even though JavaScript length exceeds the cap.
    assert!(accepted_channel.is_ok());
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
            workspace_id: WS.to_owned(),
            channel_id: "channel".to_owned(),
            thread_id: "negative-channel-thread".to_owned(),
            message_id: "negative-opening".to_owned(),
            title: None,
            author_kind: ChatActorKind::Human,
            author_display_name: "Ada".to_owned(),
            author_user_id: None,
            origin: None,
            body: "Opening".to_owned(),
            needs_decision: false,
            attachments: Vec::new(),
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
    // MUTATION: allow either negative local timestamp -> Rust mints a thread op JS peers refuse.
    assert!(start_result.is_err());
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
            workspace_id: WS.to_owned(),
            channel_id: "channel".to_owned(),
            thread_id: "unsafe-channel-thread".to_owned(),
            message_id: "unsafe-opening".to_owned(),
            title: None,
            author_kind: ChatActorKind::Human,
            author_display_name: "Ada".to_owned(),
            author_user_id: None,
            origin: None,
            body: "Opening".to_owned(),
            needs_decision: false,
            attachments: Vec::new(),
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
    // MUTATION: check only the lower timestamp bound -> an unsafe integer is
    // journaled even though both strict receivers refuse it.
    assert!(start_result.is_err());
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
                workspace_id: WS.to_owned(),
                channel_id: "channel".to_owned(),
                thread_id: "thread".to_owned(),
                message_id: "opening".to_owned(),
                title: None,
                author_kind: ChatActorKind::Human,
                author_display_name: "Ada".to_owned(),
                author_user_id: None,
                origin: None,
                body: "Opening".to_owned(),
                needs_decision: false,
                attachments: Vec::new(),
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
        // MUTATION: trusting imported channel metadata lets a local start mint
        // a channelSlug/channelWireId that apply_thread rejects.
        assert!(matches!(
            result,
            Err(dohc_engine_domain::DomainError::StateCorrupt { .. })
        ));
        assert_eq!(journaled, 0);
    }
}

#[test]
fn agent_read_negative_coordinate_noops_without_revision() {
    let (_scratch, mut store) = store();
    seed_channel(&mut store);
    start(&mut store, "thread", "opening", 20, false);
    let state = LinkedChatStore::new(&mut store)
        .mark_thread_read_by_agent(WS, "thread", -1, "before", None, 30, &NO_FAULTS)
        .expect("negative coordinate");
    // MUTATION: retain the nonnegative cursor gate -> this oracle-valid clamp no-op errors.
    assert_eq!(state.last_read_created_at_ms, 0);
    assert_eq!(state.last_read_message_id, "");
    assert_eq!(state.revision, 0);
}
