use dohc_engine_domain::{
    ChatActorKind, ChatChannelKind, CreateFileThread, LinkedChatStore, LocalAttachmentInput,
    MentionCursor, NoFaults, SendMessage, StartChannelThread, attachment_id_for,
    parse_mention_handles,
};
use dohc_engine_storage::{EngineStore, FaultPoint, StorageError};
use dohc_engine_testkit::{ScratchDir, ScriptedFaults};

const WS: &str = "b2-round2";
const NO_FAULTS: NoFaults = NoFaults;

fn store() -> (ScratchDir, EngineStore) {
    let scratch = ScratchDir::new().expect("scratch");
    let path = scratch.engine_db_path().expect("db path");
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

fn section(object: &str, anchor: &str, occurrence: i64) -> LocalAttachmentInput {
    LocalAttachmentInput {
        object_id: object.to_owned(),
        path_hint: Some(format!("notes/{object}.md")),
        heading_text: Some("Heading".to_owned()),
        heading_anchor: Some(anchor.to_owned()),
        heading_occurrence: Some(occurrence),
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

fn start_with(
    store: &mut EngineStore,
    thread_id: &str,
    message_id: &str,
    attachments: Vec<LocalAttachmentInput>,
    now_ms: i64,
) -> Result<(), dohc_engine_domain::DomainError> {
    LinkedChatStore::new(store)
        .start_channel_thread(
            &StartChannelThread {
                workspace_id: WS.to_owned(),
                channel_id: "channel".to_owned(),
                thread_id: thread_id.to_owned(),
                message_id: message_id.to_owned(),
                title: Some("Thread".to_owned()),
                author_kind: ChatActorKind::Human,
                author_display_name: "Ada".to_owned(),
                author_user_id: Some("ada".to_owned()),
                origin: None,
                body: "Opening".to_owned(),
                needs_decision: false,
                attachments,
                now_ms,
                request_id: None,
            },
            &NO_FAULTS,
        )
        .map(|_| ())
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
    LinkedChatStore::new(store)
        .start_channel_thread(
            &StartChannelThread {
                workspace_id: WS.to_owned(),
                channel_id: channel_id.to_owned(),
                thread_id: thread_id.to_owned(),
                message_id: message_id.to_owned(),
                title: None,
                author_kind: kind,
                author_display_name: "Ada".to_owned(),
                author_user_id: author_user_id.map(str::to_owned),
                origin: origin.map(str::to_owned),
                body: body.to_owned(),
                needs_decision: false,
                attachments: Vec::new(),
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
                workspace_id: WS.to_owned(),
                thread_id: thread_id.to_owned(),
                message_id: message_id.to_owned(),
                author_kind: kind,
                author_display_name: "Ada".to_owned(),
                author_user_id: author_user_id.map(str::to_owned),
                parent_message_id: None,
                origin: origin.map(str::to_owned),
                body: body.to_owned(),
                needs_decision: false,
                attachments: Vec::new(),
                now_ms,
                request_id: None,
            },
            &NO_FAULTS,
        )
        .expect("send text");
}

#[test]
fn attachment_heading_triplet_is_all_or_none() {
    let (_scratch, mut store) = store();
    seed_channel(&mut store);
    let mut malformed = attachment("object");
    malformed.heading_text = Some("Heading".to_owned());
    let result = start_with(&mut store, "thread", "message", vec![malformed], 20);
    // MUTATION: allowing a partial heading triplet -> malformed section target is persisted.
    assert!(matches!(
        result,
        Err(dohc_engine_domain::DomainError::Chat {
            code: "invalid-path",
            ..
        })
    ));
}

#[test]
fn attachment_targets_dedupe_before_insert_and_journal() {
    let (_scratch, mut store) = store();
    seed_channel(&mut store);
    let first = section("object", "anchor", 0);
    let mut duplicate = first.clone();
    duplicate.path_hint = Some("renamed/object.md".to_owned());
    start_with(&mut store, "thread", "message", vec![first, duplicate], 20).expect("start");
    let (rows, ops): (i64, i64) =
        store
            .read_with(|conn| {
                Ok::<_, StorageError>((
                conn.query_row("SELECT COUNT(*) FROM chat_attachments", [], |row| row.get(0))
                    .map_err(StorageError::corrupt_public)?,
                conn.query_row(
                    "SELECT COUNT(*) FROM replication_log WHERE op_kind = 'chat.attachment.add'",
                    [],
                    |row| row.get(0),
                )
                .map_err(StorageError::corrupt_public)?,
            ))
            })
            .expect("counts");
    // MUTATION: deduping only at INSERT (or not at all) -> a second replication op escapes.
    assert_eq!((rows, ops), (1, 1));
}

#[test]
fn attachment_id_matches_whole_file_and_section_oracles() {
    // MUTATION: adding separators to the legacy whole-file formula -> oracle hash differs.
    assert_eq!(
        attachment_id_for("message-1", "object-1", None, None),
        "98d07738824d67bb04e6d2656fc621fb6dcc9ea57c266624f13432e236d8ddac"
    );
    // MUTATION: omitting any NUL separator in the section formula -> oracle hash differs.
    assert_eq!(
        attachment_id_for("message-1", "object-1", Some("heading-anchor"), Some(3)),
        "0a93bfb0192c909a1498046c107c6f12f8fbe46415b0a7b9c3be59cc9d6699d9"
    );
}

#[test]
fn attachment_insert_and_replication_op_commit_together() {
    let (_scratch, mut store) = store();
    seed_channel(&mut store);
    let faults = ScriptedFaults::crash_at(FaultPoint::StorageBeforePersist);
    let result = LinkedChatStore::new(&mut store).start_channel_thread(
        &StartChannelThread {
            workspace_id: WS.to_owned(),
            channel_id: "channel".to_owned(),
            thread_id: "thread".to_owned(),
            message_id: "message".to_owned(),
            title: None,
            author_kind: ChatActorKind::Human,
            author_display_name: "Ada".to_owned(),
            author_user_id: None,
            origin: None,
            body: "Opening".to_owned(),
            needs_decision: false,
            attachments: vec![attachment("object")],
            now_ms: 20,
            request_id: Some("request".to_owned()),
        },
        faults.as_ref(),
    );
    assert!(result.is_err());
    let (attachments, ops): (i64, i64) = store
        .read_with(|conn| {
            Ok::<_, StorageError>((
                conn.query_row("SELECT COUNT(*) FROM chat_attachments", [], |row| {
                    row.get(0)
                })
                .map_err(StorageError::corrupt_public)?,
                conn.query_row("SELECT COUNT(*) FROM replication_log", [], |row| row.get(0))
                    .map_err(StorageError::corrupt_public)?,
            ))
        })
        .expect("counts");
    // MUTATION: attachment/log writes escape the enclosing transaction -> partial durable state.
    assert_eq!(
        (attachments, ops),
        (0, 1),
        "only the pre-existing channel op remains"
    );
}

#[test]
fn attachment_read_hides_orphans_without_deleting_them() {
    let (_scratch, mut store) = store();
    seed_channel(&mut store);
    start_with(&mut store, "thread", "message", vec![], 20).expect("start");
    store
        .write_with(&NO_FAULTS, |tx| {
            tx.execute(
                "INSERT INTO chat_attachments \
                 (workspace_id,attachment_id,thread_id,message_id,target_kind,object_id,created_at_ms) \
                 VALUES (?1,'orphan','thread','missing','file','object',30)",
                [WS],
            )
            .map_err(StorageError::persist_public)?;
            Ok::<_, StorageError>(())
        })
        .expect("orphan");
    let visible = LinkedChatStore::new(&mut store)
        .list_thread_attachments(WS, "thread", None, 10)
        .expect("list");
    let retained: i64 = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM chat_attachments WHERE attachment_id='orphan'",
                [],
                |row| row.get(0),
            )
        })
        .expect("retained");
    // MUTATION: removing the message inner join -> an orphan leaks through the read.
    assert!(visible.is_empty());
    assert_eq!(retained, 1);
}

#[test]
fn file_mentions_prefer_object_id_over_path_hint() {
    let (_scratch, mut store) = store();
    seed_channel(&mut store);
    start_with(&mut store, "t1", "m1", vec![attachment("wanted")], 20).expect("first");
    let mut reused = attachment("other");
    reused.path_hint = Some("notes/wanted.md".to_owned());
    start_with(&mut store, "t2", "m2", vec![reused], 30).expect("second");
    let mentions = LinkedChatStore::new(&mut store)
        .list_file_mentions(WS, Some("wanted"), Some("notes/wanted.md"), None, 10)
        .expect("mentions");
    // MUTATION: OR-combining object and path selectors -> the reused path broadens identity.
    assert_eq!(
        mentions
            .iter()
            .map(|mention| mention.message.message_id.as_str())
            .collect::<Vec<_>>(),
        ["m1"]
    );
}

#[test]
fn file_mentions_hydrate_all_message_attachments() {
    let (_scratch, mut store) = store();
    seed_channel(&mut store);
    start_with(
        &mut store,
        "thread",
        "message",
        vec![attachment("wanted"), attachment("also")],
        20,
    )
    .expect("start");
    let mentions = LinkedChatStore::new(&mut store)
        .list_file_mentions(WS, Some("wanted"), None, None, 10)
        .expect("mentions");
    // MUTATION: hydrating only the selected attachment -> Message.attachments is incomplete.
    assert_eq!(mentions[0].message.attachments.len(), 2);
}

#[test]
fn file_mentions_fail_closed_on_missing_hydration_entity() {
    let (_scratch, mut store) = store();
    seed_channel(&mut store);
    start_with(
        &mut store,
        "thread",
        "message",
        vec![attachment("object")],
        20,
    )
    .expect("start");
    store
        .write_with(&NO_FAULTS, |tx| {
            tx.execute(
                "UPDATE chat_threads SET channel_id='missing-channel' \
                 WHERE workspace_id=?1 AND thread_id='thread'",
                [WS],
            )
            .map_err(StorageError::persist_public)?;
            Ok::<_, StorageError>(())
        })
        .expect("tamper");
    let result =
        LinkedChatStore::new(&mut store).list_file_mentions(WS, Some("object"), None, None, 10);
    // MUTATION: best-effort channel hydration -> corrupt ownership is returned as valid data.
    assert!(matches!(
        result,
        Err(dohc_engine_domain::DomainError::Chat {
            code: "state-corrupt",
            ..
        })
    ));
}

#[test]
fn file_thread_requires_exactly_one_linked_owner() {
    let (_scratch, mut store) = store();
    let result = LinkedChatStore::new(&mut store).create_thread(
        &CreateFileThread {
            workspace_id: WS.to_owned(),
            thread_id: "thread".to_owned(),
            title: "File thread".to_owned(),
            linked_object_id: "   ".to_owned(),
            linked_path_hint: None,
            now_ms: 20,
            request_id: "request".to_owned(),
        },
        &NO_FAULTS,
    );
    // MUTATION: accepting a missing linked identity -> ownerless thread is persisted.
    assert!(matches!(
        result,
        Err(dohc_engine_domain::DomainError::Chat {
            code: "invalid-path",
            ..
        })
    ));
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
    // MUTATION: splitting row/search/op across transactions -> any partial count becomes nonzero.
    assert_eq!(counts, (0, 0, 0));
}

#[test]
fn file_thread_create_request_replay_is_exact() {
    let (_scratch, mut store) = store();
    let input = CreateFileThread {
        workspace_id: WS.to_owned(),
        thread_id: "thread".to_owned(),
        title: "File thread".to_owned(),
        linked_object_id: "object".to_owned(),
        linked_path_hint: Some("notes/file.md".to_owned()),
        now_ms: 20,
        request_id: "request".to_owned(),
    };
    let first = LinkedChatStore::new(&mut store)
        .create_thread(&input, &NO_FAULTS)
        .expect("create");
    let second = LinkedChatStore::new(&mut store)
        .create_thread(
            &CreateFileThread {
                now_ms: 99,
                ..input
            },
            &NO_FAULTS,
        )
        .expect("replay");
    let ops: i64 = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM replication_log WHERE op_kind='chat.thread.create'",
                [],
                |row| row.get(0),
            )
        })
        .expect("ops");
    // MUTATION: replay reruns creation -> timestamp/result changes or a second op is appended.
    assert_eq!((first, ops), (second, 1));
}

#[test]
fn attachment_idempotency_fingerprint_includes_canonical_targets() {
    let (_scratch, mut store) = store();
    seed_channel(&mut store);
    let base = StartChannelThread {
        workspace_id: WS.to_owned(),
        channel_id: "channel".to_owned(),
        thread_id: "thread".to_owned(),
        message_id: "message".to_owned(),
        title: None,
        author_kind: ChatActorKind::Human,
        author_display_name: "Ada".to_owned(),
        author_user_id: None,
        origin: None,
        body: "Opening".to_owned(),
        needs_decision: false,
        attachments: vec![attachment("object-a")],
        now_ms: 20,
        request_id: Some("request".to_owned()),
    };
    LinkedChatStore::new(&mut store)
        .start_channel_thread(&base, &NO_FAULTS)
        .expect("first");
    let result = LinkedChatStore::new(&mut store).start_channel_thread(
        &StartChannelThread {
            attachments: vec![attachment("object-b")],
            ..base
        },
        &NO_FAULTS,
    );
    // MUTATION: omitting attachments from the request fingerprint -> mismatched replay succeeds.
    assert!(matches!(
        result,
        Err(dohc_engine_domain::DomainError::IdempotencyKeyReuseMismatch)
    ));
}

#[test]
fn send_message_returns_authoritative_attachments() {
    let (_scratch, mut store) = store();
    seed_channel(&mut store);
    start_with(&mut store, "thread", "opening", vec![], 20).expect("start");
    let message = LinkedChatStore::new(&mut store)
        .send_message(
            &SendMessage {
                workspace_id: WS.to_owned(),
                thread_id: "thread".to_owned(),
                message_id: "reply".to_owned(),
                author_kind: ChatActorKind::Human,
                author_display_name: "Ada".to_owned(),
                author_user_id: None,
                parent_message_id: None,
                origin: None,
                body: "Reply".to_owned(),
                needs_decision: false,
                attachments: vec![attachment("object")],
                now_ms: 30,
                request_id: None,
            },
            &NO_FAULTS,
        )
        .expect("send");
    // MUTATION: returning the pre-insert message DTO -> authoritative attachments remain empty.
    assert_eq!(message.attachments.len(), 1);
}

#[test]
fn mention_parser_matches_unicode_boundary_punctuation_and_case_oracle() {
    let body = "@YOU (@agent.ops_v2) [@you] ice@you.dev @unknown @K @ſ @agent...";
    // MUTATION: ASCII-only case folding or an email boundary match changes this oracle vector.
    assert_eq!(
        parse_mention_handles(body),
        vec!["you", "agent.ops_v2", "unknown", "k", "ſ", "agent"]
    );
}

#[test]
fn mention_parser_ignores_inline_and_fenced_code() {
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
    // MUTATION: scanning code spans/fences adds three inert handles.
    assert_eq!(parse_mention_handles(&body), vec!["you"]);
}

#[test]
fn mention_index_dedupes_handles_per_message() {
    let (_scratch, mut store) = store();
    seed_channel(&mut store);
    start_message(
        &mut store,
        "channel",
        "thread",
        "message",
        ChatActorKind::Human,
        None,
        None,
        "@Agent and (@agent) and @AGENT.",
        20,
    );
    let count: i64 = store
        .read_with(|conn| {
            conn.query_row("SELECT COUNT(*) FROM chat_mentions", [], |row| row.get(0))
        })
        .expect("count");
    // MUTATION: omitting per-message dedupe leaves multiple logical index cells.
    assert_eq!(count, 1);
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
    // MUTATION: indexing only one local insertion path loses one handle.
    assert_eq!(handles, vec!["one", "two"]);

    let failed = LinkedChatStore::new(&mut store).send_message(
        &SendMessage {
            workspace_id: WS.to_owned(),
            thread_id: "thread".to_owned(),
            message_id: "rolled-back".to_owned(),
            author_kind: ChatActorKind::Human,
            author_display_name: "Ada".to_owned(),
            author_user_id: None,
            parent_message_id: None,
            origin: None,
            body: "@three".to_owned(),
            needs_decision: false,
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
                "SELECT COUNT(*) FROM chat_mentions WHERE handle='three'",
                [],
                |row| row.get(0),
            )
        })
        .expect("leaked count");
    // MUTATION: indexing outside the message transaction leaks the failed send.
    assert_eq!(leaked, 0);
}

#[test]
fn mention_backfill_covers_all_existing_rust_and_imported_messages() {
    let (_scratch, mut store) = store();
    seed_channel(&mut store);
    start_message(
        &mut store,
        "channel",
        "thread",
        "rust-message",
        ChatActorKind::Human,
        None,
        None,
        "@rust",
        20,
    );
    send_text(
        &mut store,
        "thread",
        "imported-message",
        ChatActorKind::Human,
        None,
        None,
        "@imported",
        30,
    );
    store
        .write_with(&NO_FAULTS, |tx| {
            tx.execute("DELETE FROM chat_mentions", [])
                .map_err(StorageError::persist_public)?;
            Ok::<_, StorageError>(())
        })
        .expect("simulate pre-index rows");
    let inserted = LinkedChatStore::new(&mut store)
        .backfill_mentions(WS, &NO_FAULTS)
        .expect("backfill");
    let handles: Vec<String> = store
        .read_with(|conn| {
            let mut stmt = conn.prepare("SELECT handle FROM chat_mentions ORDER BY handle")?;
            stmt.query_map([], |row| row.get(0))?.collect()
        })
        .expect("handles");
    // MUTATION: filtering the backfill by writer/origin misses one pre-existing row.
    assert_eq!(
        (inserted, handles),
        (2, vec!["imported".to_owned(), "rust".to_owned()])
    );
}

#[test]
fn mention_backfill_is_idempotent() {
    let (_scratch, mut store) = store();
    seed_channel(&mut store);
    start_message(
        &mut store,
        "channel",
        "thread",
        "message",
        ChatActorKind::Human,
        None,
        None,
        "@agent",
        20,
    );
    store
        .write_with(&NO_FAULTS, |tx| {
            tx.execute("DELETE FROM chat_mentions", [])
                .map_err(StorageError::persist_public)?;
            Ok::<_, StorageError>(())
        })
        .expect("clear");
    let first = LinkedChatStore::new(&mut store)
        .backfill_mentions(WS, &NO_FAULTS)
        .expect("first");
    let second = LinkedChatStore::new(&mut store)
        .backfill_mentions(WS, &NO_FAULTS)
        .expect("second");
    // MUTATION: plain INSERT makes readiness fail on every reopen/retry.
    assert_eq!((first, second), (1, 0));
}

#[test]
fn mention_backfill_completes_before_first_read_and_scanner() {
    let (_scratch, mut store) = store();
    seed_channel(&mut store);
    start_message(
        &mut store,
        "channel",
        "thread",
        "message",
        ChatActorKind::Human,
        None,
        None,
        "@agent",
        20,
    );
    store
        .write_with(&NO_FAULTS, |tx| {
            tx.execute("DELETE FROM chat_mentions", [])
                .map_err(StorageError::persist_public)?;
            Ok::<_, StorageError>(())
        })
        .expect("simulate older database");
    LinkedChatStore::new(&mut store)
        .backfill_mentions(WS, &NO_FAULTS)
        .expect("readiness backfill");
    let mentions = LinkedChatStore::new(&mut store)
        .list_mentions_for_handle(WS, "agent", false, None, 10)
        .expect("read");
    let dispatched = LinkedChatStore::new(&mut store)
        .record_eligible_triggers(WS, None, 50, &NO_FAULTS)
        .expect("scan");
    // MUTATION: advancing the scan before readiness permanently skips this row.
    assert_eq!((mentions.len(), dispatched), (1, 1));
}

#[test]
fn mention_read_requires_present_message_and_thread() {
    let (_scratch, mut store) = store();
    seed_channel(&mut store);
    start_message(
        &mut store,
        "channel",
        "thread",
        "message",
        ChatActorKind::Human,
        None,
        None,
        "@agent",
        20,
    );
    store
        .write_with(&NO_FAULTS, |tx| {
            tx.execute("DELETE FROM chat_messages WHERE message_id='message'", [])
                .map_err(StorageError::persist_public)?;
            Ok::<_, StorageError>(())
        })
        .expect("orphan index");
    let rows = LinkedChatStore::new(&mut store)
        .list_mentions_for_handle(WS, "agent", false, None, 10)
        .expect("list");
    // MUTATION: dropping either inner join leaks a local derived orphan.
    assert!(rows.is_empty());
}

#[test]
fn mention_unread_filter_uses_agent_coordinate_tie_break() {
    let (_scratch, mut store) = store();
    seed_channel(&mut store);
    start_message(
        &mut store,
        "channel",
        "thread",
        "a-message",
        ChatActorKind::Human,
        None,
        None,
        "@agent",
        20,
    );
    send_text(
        &mut store,
        "thread",
        "b-message",
        ChatActorKind::Human,
        None,
        None,
        "@agent",
        20,
    );
    LinkedChatStore::new(&mut store)
        .mark_thread_read_by_agent(WS, "thread", 20, "a-message", None, 30, &NO_FAULTS)
        .expect("mark read");
    let rows = LinkedChatStore::new(&mut store)
        .list_mentions_for_handle(
            WS,
            "agent",
            true,
            Some(MentionCursor {
                created_at_ms: 19,
                message_id: "z".to_owned(),
            }),
            10,
        )
        .expect("unread mentions");
    // MUTATION: timestamp-only unread comparison hides the equal-time later id.
    assert_eq!(
        rows.iter()
            .map(|row| row.message_id.as_str())
            .collect::<Vec<_>>(),
        vec!["b-message"]
    );
}

#[test]
fn eligible_scan_overlaps_high_water_timestamp_by_one_ms() {
    let (_scratch, mut store) = store();
    seed_channel(&mut store);
    start_message(
        &mut store,
        "channel",
        "thread",
        "first",
        ChatActorKind::Human,
        None,
        None,
        "no mention",
        20,
    );
    assert_eq!(
        LinkedChatStore::new(&mut store)
            .record_eligible_triggers(WS, None, 30, &NO_FAULTS)
            .expect("first scan"),
        0
    );
    send_text(
        &mut store,
        "thread",
        "same-time",
        ChatActorKind::Human,
        None,
        None,
        "@agent",
        20,
    );
    let inserted = LinkedChatStore::new(&mut store)
        .record_eligible_triggers(WS, None, 40, &NO_FAULTS)
        .expect("overlap scan");
    // MUTATION: scanning strictly after the prior maximum misses a late equal-time row.
    assert_eq!(inserted, 1);
}

#[test]
fn eligible_scan_ledger_pk_makes_overlap_idempotent() {
    let (_scratch, mut store) = store();
    seed_channel(&mut store);
    start_message(
        &mut store,
        "channel",
        "thread",
        "message",
        ChatActorKind::Human,
        None,
        None,
        "@agent",
        20,
    );
    let first = LinkedChatStore::new(&mut store)
        .record_eligible_triggers(WS, None, 30, &NO_FAULTS)
        .expect("first");
    let second = LinkedChatStore::new(&mut store)
        .record_eligible_triggers(WS, None, 40, &NO_FAULTS)
        .expect("retry");
    // MUTATION: losing INSERT OR IGNORE makes overlap create or count a duplicate.
    assert_eq!((first, second), (1, 0));
}

#[test]
fn eligible_scan_accepts_agent_channel_or_indexed_agent_mention() {
    let (_scratch, mut store) = store();
    seed_channel(&mut store);
    LinkedChatStore::new(&mut store)
        .ensure_agent_channel(WS, "agent-channel", 11, &NO_FAULTS)
        .expect("agent channel");
    start_message(
        &mut store,
        "agent-channel",
        "agent-thread",
        "direct",
        ChatActorKind::Human,
        None,
        None,
        "hello",
        20,
    );
    start_message(
        &mut store,
        "channel",
        "mention-thread",
        "mentioned",
        ChatActorKind::Human,
        None,
        None,
        "hello @agent",
        21,
    );
    let inserted = LinkedChatStore::new(&mut store)
        .record_eligible_triggers(WS, None, 30, &NO_FAULTS)
        .expect("scan");
    // MUTATION: requiring both predicates, or only one, changes the union cardinality.
    assert_eq!(inserted, 2);
}

#[test]
fn eligible_scan_rejects_agent_authored_and_cli_messages() {
    let (_scratch, mut store) = store();
    seed_channel(&mut store);
    start_message(
        &mut store,
        "channel",
        "agent-thread",
        "agent",
        ChatActorKind::Agent,
        None,
        None,
        "@agent",
        20,
    );
    start_message(
        &mut store,
        "channel",
        "cli-thread",
        "cli",
        ChatActorKind::Human,
        None,
        Some("cli"),
        "@agent",
        21,
    );
    let inserted = LinkedChatStore::new(&mut store)
        .record_eligible_triggers(WS, None, 30, &NO_FAULTS)
        .expect("scan");
    // MUTATION: removing either author/origin gate admits an invalid trigger.
    assert_eq!(inserted, 0);
}

#[test]
fn eligible_scan_enforces_verified_author_when_present() {
    let (_scratch, mut store) = store();
    seed_channel(&mut store);
    start_message(
        &mut store,
        "channel",
        "owned-thread",
        "owned",
        ChatActorKind::Human,
        Some("alice"),
        None,
        "@agent",
        20,
    );
    start_message(
        &mut store,
        "channel",
        "anonymous-thread",
        "anonymous",
        ChatActorKind::Human,
        None,
        None,
        "@agent",
        20,
    );
    let bob = LinkedChatStore::new(&mut store)
        .record_eligible_triggers(WS, Some("bob"), 30, &NO_FAULTS)
        .expect("bob scan");
    let alice = LinkedChatStore::new(&mut store)
        .record_eligible_triggers(WS, Some("alice"), 40, &NO_FAULTS)
        .expect("alice overlap");
    // MUTATION: trusting display name or requiring identity for NULL changes these counts.
    assert_eq!((bob, alice), (1, 1));
}

#[test]
fn eligible_scan_advances_over_ineligible_messages() {
    let (_scratch, mut store) = store();
    seed_channel(&mut store);
    start_message(
        &mut store,
        "channel",
        "thread",
        "message",
        ChatActorKind::Human,
        None,
        None,
        "ordinary",
        123,
    );
    let inserted = LinkedChatStore::new(&mut store)
        .record_eligible_triggers(WS, None, 200, &NO_FAULTS)
        .expect("scan");
    let cursor: i64 = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT max_created_at_ms FROM chat_dispatch_scan_cursor WHERE workspace_id=?1",
                [WS],
                |row| row.get(0),
            )
        })
        .expect("cursor");
    // MUTATION: MAX over eligible-only rows leaves the scanner pinned behind noise.
    assert_eq!((inserted, cursor), (0, 123));
}

#[test]
fn eligible_trigger_created_time_is_message_time_and_updated_time_is_scan_time() {
    let (_scratch, mut store) = store();
    seed_channel(&mut store);
    start_message(
        &mut store,
        "channel",
        "thread",
        "message",
        ChatActorKind::Human,
        None,
        None,
        "@agent",
        123,
    );
    LinkedChatStore::new(&mut store)
        .record_eligible_triggers(WS, None, 900, &NO_FAULTS)
        .expect("scan");
    let times: (i64, i64) = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT created_at_ms, updated_at_ms FROM chat_dispatch_ledger",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
        })
        .expect("times");
    // MUTATION: stamping both fields with scan time breaks pending ordering semantics.
    assert_eq!(times, (123, 900));
}

#[test]
fn eligible_scan_rolls_back_ledger_and_cursor_together() {
    let (_scratch, mut store) = store();
    seed_channel(&mut store);
    start_message(
        &mut store,
        "channel",
        "thread",
        "message",
        ChatActorKind::Human,
        None,
        None,
        "@agent",
        20,
    );
    let result = LinkedChatStore::new(&mut store).record_eligible_triggers(
        WS,
        None,
        30,
        ScriptedFaults::crash_at(FaultPoint::StorageBeforePersist).as_ref(),
    );
    assert!(result.is_err());
    let counts: (i64, i64) = store
        .read_with(|conn| {
            Ok::<_, StorageError>((
                conn.query_row("SELECT COUNT(*) FROM chat_dispatch_ledger", [], |row| {
                    row.get(0)
                })
                .map_err(StorageError::corrupt_public)?,
                conn.query_row(
                    "SELECT COUNT(*) FROM chat_dispatch_scan_cursor",
                    [],
                    |row| row.get(0),
                )
                .map_err(StorageError::corrupt_public)?,
            ))
        })
        .expect("counts");
    // MUTATION: splitting ledger/cursor writes can strand exactly one durable half.
    assert_eq!(counts, (0, 0));
}
