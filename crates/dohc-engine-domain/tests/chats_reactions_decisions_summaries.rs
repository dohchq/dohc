use dohc_engine_domain::{
    ChatActorKind, ChatChannelKind, ChatCoordinateState, ChatReactionState, ChatStageOutcome,
    ChatThreadLane, LinkedChatStore, LocalAttachmentInput, NoFaults, ResolveDecision, SendMessage,
    SetReaction, StartChannelThread, attachment_id_for, reaction_id_for,
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
fn a_receipted_post_that_publishes_nothing_rolls_back_its_writes() {
    let (_scratch, mut store) = store();
    seed_channel(&mut store);
    let mut post = keyed_post("local-post", "thread", "opening", 20);
    post.author_user_id = None;
    post.needs_decision = false;
    let journal = local_journal(&store);

    let failed = receipted(&mut store).start_channel_thread(&post, &NO_FAULTS);
    assert!(
        matches!(
            failed,
            Err(dohc_engine_domain::DomainError::InvalidInput {
                reason: "stage-not-published"
            })
        ),
        "a local-only post receipted as written -> the phone reports saved for a post no copy sees."
    );
    let (threads, messages, ledger): (i64, i64, i64) = store
        .read_with(|conn| {
            let count = |sql: &str| conn.query_row(sql, [WS], |row| row.get::<_, i64>(0));
            Ok::<_, rusqlite::Error>((
                count("SELECT COUNT(*) FROM chat_threads WHERE workspace_id = ?1")?,
                count("SELECT COUNT(*) FROM chat_messages WHERE workspace_id = ?1")?,
                conn.query_row(
                    "SELECT COUNT(*) FROM engine_requests WHERE request_id = 'local-post'",
                    [],
                    |row| row.get(0),
                )?,
            ))
        })
        .expect("counts");
    assert_eq!(
        (threads, messages, ledger),
        (0, 0, 0),
        "a refusal after the thread and message writes -> those writes must roll back with it."
    );
    assert_eq!(receipt(&store, "local-post"), None);
    assert_eq!(local_journal(&store), journal);
}
