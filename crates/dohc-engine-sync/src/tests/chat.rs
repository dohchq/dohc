use super::*;

fn reaction_winner(engine: &EngineStore) -> (String, i64, String, i64) {
    engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT state, at_ms, origin_id, origin_seq FROM chat_reactions \
                 WHERE workspace_id = 'ws' AND message_id = 'message'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .map_err(dohc_engine_storage::StorageError::corrupt_public)
        })
        .expect("reaction winner")
}

fn decision_winner(engine: &EngineStore) -> (String, i64, String, i64) {
    engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT state, at_ms, origin_id, origin_seq FROM chat_decisions \
                 WHERE workspace_id = 'ws' AND message_id = 'message'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .map_err(dohc_engine_storage::StorageError::corrupt_public)
        })
        .expect("decision winner")
}

#[test]
fn decision_lww_is_permutation_convergent_and_resolved_wins_ties() {
    let ops = [
        envelope(
            "alpha",
            0,
            "chat.decision.set",
            decision_payload("open", 100, None),
        ),
        envelope(
            "beta",
            0,
            "chat.decision.set",
            decision_payload("resolved", 100, Some("resolver")),
        ),
        envelope(
            "omega",
            0,
            "chat.decision.set",
            decision_payload("open", 100, None),
        ),
    ];
    let permutations = [
        [0usize, 1, 2],
        [0, 2, 1],
        [1, 0, 2],
        [1, 2, 0],
        [2, 0, 1],
        [2, 1, 0],
    ];
    let mut winners = Vec::new();
    for order in permutations {
        let (_scratch, _path, mut engine) = open_store();
        for index in order {
            apply_chat_envelope(&mut engine, &ops[index], &NoFaults).expect("apply");
        }
        winners.push(decision_winner(&engine));
    }
    assert!(
        winners.iter().all(|winner| winner == &winners[0]),
        "using arrival order or origin before resolvedRank -> equal-time peers disagree or an open cell beats resolved."
    );
    assert_eq!(winners[0].0, "resolved");
    assert_eq!(winners[0].2, "beta");
}

#[test]
fn reaction_lww_is_permutation_convergent() {
    let ops = [
        envelope(
            "alpha",
            0,
            "chat.reaction.set",
            reaction_payload("added", "👍", 100, "Ada"),
        ),
        envelope(
            "beta",
            0,
            "chat.reaction.set",
            reaction_payload("removed", "👍", 100, "Ada"),
        ),
        envelope(
            "omega",
            0,
            "chat.reaction.set",
            reaction_payload("added", "👍", 101, "Ada"),
        ),
    ];
    let permutations = [
        [0usize, 1, 2],
        [0, 2, 1],
        [1, 0, 2],
        [1, 2, 0],
        [2, 0, 1],
        [2, 1, 0],
    ];
    let mut winners = Vec::new();
    for order in permutations {
        let (_scratch, _path, mut engine) = open_store();
        for index in order {
            apply_chat_envelope(&mut engine, &ops[index], &NoFaults).expect("apply");
        }
        winners.push(reaction_winner(&engine));
    }
    assert!(
        winners.iter().all(|winner| winner == &winners[0]),
        "replacing the total-order max with last-writer arrival -> permutations settle to different rows."
    );
    assert_eq!(winners[0], ("added".to_owned(), 101, "omega".to_owned(), 0));
}

#[test]
fn reaction_import_rejects_non_emoji_graphemes() {
    for hostile in ["hello", "http://evil.invalid", "👍 nice", "✁"] {
        let (_scratch, _path, mut engine) = open_store();
        let invalid = envelope(
            "mallory",
            0,
            "chat.reaction.set",
            reaction_payload("added", hostile, 100, "Mallory"),
        );
        let result = apply_chat_envelope(&mut engine, &invalid, &NoFaults);
        assert_invalid_refusal!(result);
    }
    let (_scratch, _path, mut engine) = open_store();
    let flag = envelope(
        "peer",
        0,
        "chat.reaction.set",
        reaction_payload("added", "🇺🇸", 100, "Ada"),
    );
    assert!(
        apply_chat_envelope(&mut engine, &flag, &NoFaults).is_ok(),
        "validating one scalar instead of one emoji grapheme -> a valid regional-indicator flag is rejected."
    );
}

#[test]
fn imported_channel_carries_its_group_and_an_older_op_still_applies() {
    let (_scratch, _path, mut engine) = open_store();
    let with_group = envelope(
        "group-fields",
        0,
        "chat.channel.create",
        json!({
            "channelId": "trip",
            "name": "Lisbon trip",
            "slug": "lisbon-trip",
            "kind": "channel",
            "type": "both",
            "purpose": "Dates and flights",
            "folderPath": "trips/lisbon",
            "createdAtMs": 10
        }),
    );
    // An op written before the groups migration names no group fields.
    let older = envelope(
        "group-fields",
        1,
        "chat.channel.create",
        json!({
            "channelId": "old",
            "name": "Old",
            "slug": "old",
            "kind": "channel",
            "createdAtMs": 11
        }),
    );
    for op in [&with_group, &older] {
        assert_eq!(
            apply_chat_envelope(&mut engine, op, &NoFaults).expect("apply channel"),
            ApplyOutcome::new(ApplyDisposition::Applied(Vec::new()))
        );
    }
    let rows: Vec<(String, String, String, Option<String>)> = engine
        .read_with(|conn| {
            let mut stmt = conn.prepare(
                "SELECT channel_id, type, purpose, folder_path FROM chat_channels \
                 WHERE workspace_id = 'ws' ORDER BY channel_id",
            )?;
            let rows = stmt.query_map([], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
            })?;
            rows.collect()
        })
        .expect("read channels");
    assert_eq!(
        rows,
        vec![
            ("old".to_owned(), "posts".to_owned(), String::new(), None),
            (
                "trip".to_owned(),
                "both".to_owned(),
                "Dates and flights".to_owned(),
                Some("trips/lisbon".to_owned())
            ),
        ]
    );

    // A group with a folder on a dm is refused.
    let bad = envelope(
        "group-fields-bad",
        0,
        "chat.channel.create",
        json!({
            "channelId": "dm-with-folder",
            "name": "someone",
            "slug": "someone",
            "kind": "dm",
            "folderPath": "people/someone",
            "createdAtMs": 12
        }),
    );
    assert_invalid_refusal!(apply_chat_envelope(&mut engine, &bad, &NoFaults));
}

#[test]
fn a_replicated_poll_names_its_answer_and_a_file_thread_has_no_chat_lane() {
    let (_scratch, _path, mut engine) = open_store();
    // A resolved poll with choices that names no choice is refused; the
    // domain never writes one, so a peer that sends one is malformed.
    let unanswered = envelope(
        "poll-no-answer",
        0,
        "chat.decision.set",
        json!({
            "threadId": "thread-poll",
            "messageId": "poll-message",
            "state": "resolved",
            "resolvedByMessageId": "answer-message",
            "atMs": 20,
            "options": ["Friday", "Monday"]
        }),
    );
    assert_invalid_refusal!(apply_chat_envelope(&mut engine, &unanswered, &NoFaults));
    // A bare question resolves with no choice, as before.
    let bare = envelope(
        "poll-no-answer",
        1,
        "chat.decision.set",
        json!({
            "threadId": "thread-poll",
            "messageId": "question-message",
            "state": "resolved",
            "resolvedByMessageId": "answer-message",
            "atMs": 21
        }),
    );
    assert_eq!(
        apply_chat_envelope(&mut engine, &bare, &NoFaults).expect("apply bare question"),
        ApplyOutcome::new(ApplyDisposition::Applied(Vec::new()))
    );

    // A file-linked thread is always a post, whatever lane the op claims.
    let file_chat_lane = envelope(
        "file-thread-lane",
        0,
        "chat.thread.create",
        json!({
            "threadId": "thread-file",
            "title": "About a file",
            "createdAtMs": 30,
            "linkedPath": "docs/plan.md",
            "linkedAtMs": 30,
            "lane": "chat"
        }),
    );
    assert_invalid_refusal!(apply_chat_envelope(&mut engine, &file_chat_lane, &NoFaults));
}

fn assert_imported_thread_rejected(payload: serde_json::Value) {
    let (_scratch, _path, mut engine) = open_store();
    let operation = envelope("invalid-thread", 0, "chat.thread.create", payload);
    assert_invalid_refusal!(apply_chat_envelope(&mut engine, &operation, &NoFaults));
    let thread_rows: i64 = engine
        .read_with(|conn| {
            conn.query_row("SELECT COUNT(*) FROM chat_threads", [], |row| row.get(0))
                .map_err(dohc_engine_storage::StorageError::corrupt_public)
        })
        .expect("thread row count");
    assert_eq!(
        thread_rows, 0,
        "a refused thread mutation must roll back before its ack is recorded"
    );
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "invalid-thread").expect("ack"),
        0
    );
}

#[test]
fn imported_thread_rejects_invalid_owner_shape_and_linked_path() {
    for payload in [
        json!({
            "threadId": "thread",
            "title": "",
            "createdAtMs": 1
        }),
        json!({
            "threadId": "thread",
            "title": "",
            "createdAtMs": 1,
            "linkedObjectId": "object",
            "channelSlug": "general"
        }),
        json!({
            "threadId": "thread",
            "title": "",
            "createdAtMs": 1,
            "channelSlug": "general",
            "linkedAtMs": 1
        }),
        json!({
            "threadId": "thread",
            "title": "",
            "createdAtMs": 1,
            "channelSlug": "general",
            "linkedPathHint": "notes/file.md"
        }),
        json!({
            "threadId": "thread",
            "title": "",
            "createdAtMs": 1,
            "linkedObjectId": "object",
            "linkedPathHint": "notes/../escape.md"
        }),
    ] {
        assert_imported_thread_rejected(payload);
    }
}

#[test]
fn imported_thread_with_forged_agent_slug_is_refused() {
    let (_scratch, _path, mut engine) = open_store();
    let operation = envelope(
        "forged-agent-slug",
        0,
        "chat.thread.create",
        json!({
            "threadId": "forged-agent-thread",
            "title": "",
            "createdAtMs": 20,
            "channelSlug": channel_slug_for_name(AGENT_CHANNEL_NAME)
        }),
    );
    assert_invalid_refusal!(apply_chat_envelope(&mut engine, &operation, &NoFaults));
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "forged-agent-slug").expect("ack"),
        0,
        "dropping the canonical-agent-slug iff reserved-wire invariant lets an ordinary channel impersonate the dispatch channel.",
    );
}

fn imported_chat_fixture(engine: &mut EngineStore, origin: &str) {
    let operations = [
        envelope(
            origin,
            0,
            "chat.channel.create",
            json!({
                "channelId": "channel-imported",
                "name": "Imported",
                "slug": "imported",
                "kind": "channel",
                "createdAtMs": 10
            }),
        ),
        envelope(
            origin,
            1,
            "chat.thread.create",
            json!({
                "threadId": "thread-imported",
                "title": "Imported thread",
                "createdAtMs": 20,
                "channelSlug": "imported",
                "channelWireId": "channel-imported"
            }),
        ),
        envelope(
            origin,
            2,
            "chat.message.append",
            json!({
                "messageId": "message-imported",
                "threadId": "thread-imported",
                "authorKind": "human",
                "authorDisplayName": "Ada",
                "body": "Opening",
                "createdAtMs": 20
            }),
        ),
    ];
    for operation in operations {
        apply_chat_envelope(engine, &operation, &NoFaults).expect("fixture operation");
    }
}

fn pending_chat_coordinate_count(engine: &EngineStore) -> i64 {
    engine
        .read_with(|conn| {
            conn.query_row("SELECT COUNT(*) FROM chat_pending_replication", [], |row| {
                row.get(0)
            })
            .map_err(dohc_engine_storage::StorageError::corrupt_public)
        })
        .expect("pending chat coordinate count")
}

fn chat_content_revision(engine: &EngineStore, thread_id: &str) -> i64 {
    engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT content_revision FROM chat_conversation_revisions \
                 WHERE workspace_id='ws' AND thread_id=?1",
                [thread_id],
                |row| row.get(0),
            )
            .optional()
            .map(|revision| revision.unwrap_or(0))
            .map_err(dohc_engine_storage::StorageError::corrupt_public)
        })
        .expect("chat content revision")
}

fn seed_unowned_chat_thread(engine: &mut EngineStore, thread_id: &str) {
    engine
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT INTO chat_threads \
                 (workspace_id,thread_id,title,created_at_ms,updated_at_ms) \
                 VALUES ('ws',?1,'',10,10)",
                [thread_id],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .expect("seed chat thread");
}

#[test]
fn imported_chat_winners_bump_and_losing_lww_coordinates_do_not() {
    let (_scratch, _path, mut engine) = open_store();
    seed_unowned_chat_thread(&mut engine, "thread");
    assert_eq!(chat_content_revision(&engine, "thread"), 0);

    let message = envelope(
        "message-winner",
        0,
        "chat.message.append",
        json!({
            "messageId": "message",
            "threadId": "thread",
            "authorKind": "human",
            "authorDisplayName": "Ada",
            "body": "Imported",
            "createdAtMs": 20
        }),
    );
    assert!(matches!(
        apply_chat_envelope(&mut engine, &message, &NoFaults),
        Ok(ApplyOutcome {
            primary: ApplyDisposition::Applied(_),
            refusals: ref outcome_refusals,
            sharing_declined: ref outcome_sharing_declined,
        }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
    ));
    assert_eq!(chat_content_revision(&engine, "thread"), 1);

    let attachment_id = attachment_id_for("message", "object", None, None);
    let attachment = envelope(
        "attachment-winner",
        0,
        "chat.attachment.add",
        json!({
            "attachmentId": attachment_id,
            "threadId": "thread",
            "messageId": "message",
            "targetKind": "file",
            "objectId": "object",
            "pathHint": "notes/imported.md",
            "createdAtMs": 21
        }),
    );
    assert!(matches!(
        apply_chat_envelope(&mut engine, &attachment, &NoFaults),
        Ok(ApplyOutcome {
            primary: ApplyDisposition::Applied(_),
            refusals: ref outcome_refusals,
            sharing_declined: ref outcome_sharing_declined,
        }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
    ));
    assert_eq!(chat_content_revision(&engine, "thread"), 2);

    let reaction_winner = envelope(
        "reaction-winner",
        0,
        "chat.reaction.set",
        reaction_payload("added", "👍", 100, "ada"),
    );
    assert!(matches!(
        apply_chat_envelope(&mut engine, &reaction_winner, &NoFaults),
        Ok(ApplyOutcome {
            primary: ApplyDisposition::Applied(_),
            refusals: ref outcome_refusals,
            sharing_declined: ref outcome_sharing_declined,
        }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
    ));
    assert_eq!(chat_content_revision(&engine, "thread"), 3);
    let reaction_loser = envelope(
        "reaction-loser",
        0,
        "chat.reaction.set",
        reaction_payload("removed", "👍", 99, "ada"),
    );
    assert!(matches!(
        apply_chat_envelope(&mut engine, &reaction_loser, &NoFaults),
        Ok(ApplyOutcome {
            primary: ApplyDisposition::Applied(_),
            refusals: ref outcome_refusals,
            sharing_declined: ref outcome_sharing_declined,
        }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
    ));
    assert_eq!(
        chat_content_revision(&engine, "thread"),
        3,
        "a losing imported reaction must not invalidate the conversation"
    );

    let decision_winner = envelope(
        "decision-winner",
        0,
        "chat.decision.set",
        decision_payload("resolved", 100, Some("message")),
    );
    assert!(matches!(
        apply_chat_envelope(&mut engine, &decision_winner, &NoFaults),
        Ok(ApplyOutcome {
            primary: ApplyDisposition::Applied(_),
            refusals: ref outcome_refusals,
            sharing_declined: ref outcome_sharing_declined,
        }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
    ));
    assert_eq!(chat_content_revision(&engine, "thread"), 4);
    let decision_loser = envelope(
        "decision-loser",
        0,
        "chat.decision.set",
        decision_payload("open", 99, None),
    );
    assert!(matches!(
        apply_chat_envelope(&mut engine, &decision_loser, &NoFaults),
        Ok(ApplyOutcome {
            primary: ApplyDisposition::Applied(_),
            refusals: ref outcome_refusals,
            sharing_declined: ref outcome_sharing_declined,
        }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
    ));
    assert_eq!(
        chat_content_revision(&engine, "thread"),
        4,
        "a losing imported decision must not invalidate the conversation"
    );
}

#[test]
fn another_computers_automation_message_applies_without_its_automation() {
    let (_scratch, _path, mut engine) = open_store();
    imported_chat_fixture(&mut engine, "peer");
    let message = envelope(
        "peer",
        3,
        "chat.message.append",
        json!({
            "messageId": "automation-message",
            "threadId": "thread-imported",
            "authorKind": "automation",
            "authorDisplayName": "Stamp the finish date",
            "authorOwnerDisplayName": "Ana",
            "authorUserId": "ana",
            "body": "Done @ice",
            "createdAtMs": 30,
            "chainDepth": 2
        }),
    );
    apply_chat_envelope(&mut engine, &message, &NoFaults).expect("automation message");
    // Only an automation's or an agent's message carries a chain depth,
    // within the depth bound.
    for (seq, author_kind, owner, depth) in [
        (10, "human", None, json!(1)),
        (11, "automation", Some("Ana"), json!(0)),
        (12, "automation", Some("Ana"), json!(65)),
        (13, "automation", Some("Ana"), json!("2")),
        (14, "agent", Some("Ana"), json!(0)),
    ] {
        let mut payload = json!({
            "messageId": format!("bad-depth-{seq}"),
            "threadId": "thread-imported",
            "authorKind": author_kind,
            "authorDisplayName": "Ana",
            "body": "Hi",
            "createdAtMs": 31,
            "chainDepth": depth,
        });
        if let Some(owner) = owner {
            payload["authorOwnerDisplayName"] = json!(owner);
        }
        let refused = envelope(
            &format!("bad-depth-peer-{seq}"),
            0,
            "chat.message.append",
            payload,
        );
        assert_invalid_refusal!(apply_chat_envelope(&mut engine, &refused, &NoFaults));
    }
    let stored: (String, String, Option<String>, Option<i64>, String) = engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT m.author_kind, m.author_owner_display_name, m.automation_id, m.chain_depth, \
                        (SELECT author_kind FROM chat_mentions WHERE message_id = m.message_id AND handle = 'ice') \
                 FROM chat_messages m WHERE m.message_id = 'automation-message'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
            )
            .map_err(dohc_engine_storage::StorageError::corrupt_public)
        })
        .expect("stored automation message");
    assert_eq!(
        stored,
        (
            "automation".to_owned(),
            "Ana".to_owned(),
            None,
            None,
            "automation".to_owned()
        )
    );

    let reaction = envelope(
        "peer",
        4,
        "chat.reaction.set",
        json!({
            "reactionId": "reaction-automation",
            "messageId": "automation-message",
            "threadId": "thread-imported",
            "emoji": "👍",
            "authorId": "ana",
            "authorKind": "automation",
            "authorDisplayName": "Stamp the finish date",
            "atMs": 40,
            "state": "added",
        }),
    );
    assert_invalid_refusal!(apply_chat_envelope(&mut engine, &reaction, &NoFaults));

    // An automation message that arrives before its thread is parked, then replays with its person.
    let early = envelope(
        "early-peer",
        0,
        "chat.message.append",
        json!({
            "messageId": "early-automation-message",
            "threadId": "late-thread",
            "authorKind": "automation",
            "authorDisplayName": "Stamp the finish date",
            "authorOwnerDisplayName": "Ana",
            "authorUserId": "ana",
            "body": "Done",
            "createdAtMs": 50
        }),
    );
    apply_chat_envelope(&mut engine, &early, &NoFaults).expect("parked automation message");
    assert_eq!(pending_chat_coordinate_count(&engine), 1);
    let thread = envelope(
        "late-thread-peer",
        0,
        "chat.thread.create",
        json!({
            "threadId": "late-thread",
            "title": "Late thread",
            "createdAtMs": 40,
            "channelSlug": "imported"
        }),
    );
    apply_chat_envelope(&mut engine, &thread, &NoFaults).expect("thread");
    assert_eq!(pending_chat_coordinate_count(&engine), 0);
    let replayed: (String, String) = engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT author_kind, author_owner_display_name FROM chat_messages                  WHERE message_id = 'early-automation-message'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(dohc_engine_storage::StorageError::corrupt_public)
        })
        .expect("replayed automation message");
    assert_eq!(replayed, ("automation".to_owned(), "Ana".to_owned()));
}

/// The relay's origin for `link_message_payload`'s link principal.
const LINK_ORIGIN: &str = "relay:share-link:principal-1";

/// A link holder's post in the imported Group, as the relay writes it.
fn link_message_payload(message_id: &str, body: &str) -> serde_json::Value {
    json!({
        "messageId": message_id,
        "threadId": "thread-imported",
        "authorKind": "link",
        "authorDisplayName": "Guest",
        "linkGrantId": "grant-1",
        "linkPrincipalId": "principal-1",
        "body": body,
        "createdAtMs": 30,
    })
}

/// A link message replays with its link grant, link principal and name
/// snapshot, names no account, and reads back the same whether it applied
/// at once or waited for its thread.
#[test]
fn a_link_message_replays_with_its_link_and_no_account() {
    use dohc_engine_domain::{ChatActorKind, ChatMessageLinkAuthor, LinkedChatStore};

    let (_scratch, _path, mut engine) = open_store();
    imported_chat_fixture(&mut engine, "peer");
    let message = envelope(
        LINK_ORIGIN,
        0,
        "chat.message.append",
        link_message_payload("link-message:hi", "Hi @ice"),
    );
    assert_eq!(
        apply_chat_envelope(&mut engine, &message, &NoFaults).expect("link message"),
        ApplyOutcome::new(ApplyDisposition::Applied(Vec::new()))
    );
    let read = LinkedChatStore::new(&mut engine)
        .get_message("ws", "link-message:hi")
        .expect("read the link message");
    assert_eq!(read.author_kind, ChatActorKind::Link);
    assert_eq!(read.author_display_name, "Guest");
    assert_eq!(
        (
            read.author_user_id.as_deref(),
            read.author_owner_display_name.as_deref()
        ),
        (None, None)
    );
    let link = Some(ChatMessageLinkAuthor {
        grant_id: "grant-1".to_owned(),
        principal_id: "principal-1".to_owned(),
        agent_connection_id: None,
    });
    assert_eq!(read.link_author, link);
    let mention: String = engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT author_kind FROM chat_mentions WHERE message_id = 'link-message:hi' AND handle = 'ice'",
                [],
                |row| row.get(0),
            )
            .map_err(dohc_engine_storage::StorageError::corrupt_public)
        })
        .expect("link mention");
    assert_eq!(mention, "link");

    let mut early = link_message_payload("link-message:early", "Early");
    early["threadId"] = json!("late-thread");
    apply_chat_envelope(
        &mut engine,
        &envelope(LINK_ORIGIN, 1, "chat.message.append", early),
        &NoFaults,
    )
    .expect("parked link message");
    assert_eq!(pending_chat_coordinate_count(&engine), 1);
    let thread = envelope(
        "late-thread-peer",
        0,
        "chat.thread.create",
        json!({
            "threadId": "late-thread",
            "title": "Late thread",
            "createdAtMs": 20,
            "channelSlug": "imported"
        }),
    );
    apply_chat_envelope(&mut engine, &thread, &NoFaults).expect("thread");
    assert_eq!(pending_chat_coordinate_count(&engine), 0);
    let replayed = LinkedChatStore::new(&mut engine)
        .get_message("ws", "link-message:early")
        .expect("read the replayed link message");
    assert_eq!(
        (
            replayed.author_kind,
            replayed.author_user_id,
            replayed.link_author
        ),
        (ChatActorKind::Link, None, link)
    );
}

/// A link message names its link and nothing account-shaped, stays within
/// the link body cap, uses the link message id prefix and comes from its link
/// principal's relay origin; no other message names a link. Each refusal is
/// recorded and acked, and the next op applies.
#[test]
fn a_link_message_with_an_account_or_without_its_link_is_refused() {
    let (_scratch, _path, mut engine) = open_store();
    imported_chat_fixture(&mut engine, "peer");
    let mut forged = Vec::new();
    for (field, value) in [
        ("authorUserId", json!("ana")),
        ("authorOwnerDisplayName", json!("Ana")),
        ("origin", json!("cli")),
        ("chainDepth", json!(1)),
        ("work", json!({"status": "working"})),
        ("linkGrantId", json!(" grant-1")),
        ("linkPrincipalId", json!("")),
        ("linkPrincipalId", json!("principal-2")),
        ("agentConnectionId", json!("")),
        ("agentConnectionId", json!(" connection-1")),
        ("agentConnectionId", json!(1)),
        ("authorKind", json!("human")),
        ("messageId", json!("forged")),
    ] {
        let mut payload = link_message_payload("link-message:forged", "Hi");
        payload[field] = value;
        forged.push(payload);
    }
    for field in ["linkGrantId", "linkPrincipalId"] {
        let mut payload = link_message_payload("link-message:forged", "Hi");
        payload.as_object_mut().expect("payload").remove(field);
        forged.push(payload);
    }
    forged.push(link_message_payload(
        "link-message:forged",
        &"a".repeat(dohc_engine_domain::chats::MAX_LINK_MESSAGE_BODY_BYTES + 1),
    ));
    let next = forged.len() as i64;
    for (seq, payload) in forged.into_iter().enumerate() {
        let op = envelope(LINK_ORIGIN, seq as i64, "chat.message.append", payload);
        assert_invalid_refusal!(apply_chat_envelope(&mut engine, &op, &NoFaults));
    }
    // The relay's post itself, from any origin but its link principal's.
    for origin in [
        "relay-link",
        "relay:share-link:principal-2",
        "relay:share-link:",
    ] {
        let op = envelope(
            origin,
            0,
            "chat.message.append",
            link_message_payload("link-message:forged", "Hi"),
        );
        assert_invalid_refusal!(apply_chat_envelope(&mut engine, &op, &NoFaults));
    }
    let stored: i64 = engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM chat_messages WHERE message_id IN ('forged', 'link-message:forged')",
                [],
                |row| row.get(0),
            )
            .map_err(dohc_engine_storage::StorageError::corrupt_public)
        })
        .expect("forged count");
    assert_eq!(stored, 0);
    let at_cap = envelope(
        LINK_ORIGIN,
        next,
        "chat.message.append",
        link_message_payload(
            "link-message:at-cap",
            &"a".repeat(dohc_engine_domain::chats::MAX_LINK_MESSAGE_BODY_BYTES),
        ),
    );
    assert_eq!(
        apply_chat_envelope(&mut engine, &at_cap, &NoFaults).expect("link message at the cap"),
        ApplyOutcome::new(ApplyDisposition::Applied(Vec::new()))
    );
}

/// Only the relay names a message with the link message prefix. A device's
/// message that takes such an id first is refused, so the link post that
/// later arrives with it still applies.
#[test]
fn a_message_that_takes_a_link_message_id_is_refused() {
    let (_scratch, _path, mut engine) = open_store();
    imported_chat_fixture(&mut engine, "peer");
    let id = format!("{}taken", dohc_engine_domain::chats::LINK_MESSAGE_ID_PREFIX);
    let mut taken = link_message_payload(&id, "First");
    taken["authorKind"] = json!("human");
    let fields = taken.as_object_mut().expect("payload");
    fields.remove("linkGrantId");
    fields.remove("linkPrincipalId");
    let op = envelope("peer", 3, "chat.message.append", taken);
    assert_invalid_refusal!(apply_chat_envelope(&mut engine, &op, &NoFaults));

    let post = envelope(
        LINK_ORIGIN,
        0,
        "chat.message.append",
        link_message_payload(&id, "Hi"),
    );
    assert_eq!(
        apply_chat_envelope(&mut engine, &post, &NoFaults).expect("link post"),
        ApplyOutcome::new(ApplyDisposition::Applied(Vec::new()))
    );
    let stored: (String, String) = engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT author_kind, body FROM chat_messages WHERE message_id = ?1",
                [&id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(dohc_engine_storage::StorageError::corrupt_public)
        })
        .expect("link post");
    assert_eq!(stored, ("link".to_owned(), "Hi".to_owned()));
}

/// A personal agent, and the relay's origin for its chat.
const PERSONAL_AGENT: &str = "p-aaaaaaaaaaaaaaaaaaaaaaaaaa";
const PERSONAL_ORIGIN: &str = "relay:personal-agent:p-aaaaaaaaaaaaaaaaaaaaaaaaaa";

/// The personal agent's DM as the relay appends it when a workspace enters
/// the agent's reach.
fn personal_dm_payload(agent_id: &str) -> serde_json::Value {
    json!({
        "channelId": format!("personal-dm:{agent_id}"),
        "name": "Helper",
        "slug": format!("my-agent-{agent_id}"),
        "kind": "agent",
        "createdAtMs": 10,
        "wireId": format!("channel_wire_agent_v1_{agent_id}"),
    })
}

/// The personal agent's post in the imported Group, as the relay writes it.
fn personal_message_payload(message_id: &str, thread_id: &str) -> serde_json::Value {
    json!({
        "messageId": message_id,
        "threadId": thread_id,
        "authorKind": "agent",
        "authorDisplayName": "Helper",
        "authorUserId": "ana",
        "authorAgentId": PERSONAL_AGENT,
        "agentConnectionId": "connection-1",
        "body": "Done",
        "createdAtMs": 30,
    })
}

fn personal_thread_payload(thread_id: &str, wire_id: &str) -> serde_json::Value {
    json!({
        "threadId": thread_id,
        "title": "",
        "createdAtMs": 25,
        "channelWireId": wire_id,
        "lane": "chat"
    })
}

/// The stored connection columns of a message, link first.
fn message_connections(engine: &EngineStore, message_id: &str) -> (Option<String>, Option<String>) {
    engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT agent_connection_id, personal_agent_connection_id FROM chat_messages \
                 WHERE workspace_id = 'ws' AND message_id = ?1",
                [message_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(dohc_engine_storage::StorageError::corrupt_public)
        })
        .expect("message connections")
}

/// The chats of one agent in `ws`.
fn agent_chats(engine: &EngineStore, agent_id: &str) -> Vec<String> {
    engine
        .read_with(|conn| {
            let mut statement = conn
                .prepare("SELECT channel_id FROM chat_channels WHERE workspace_id = 'ws' AND agent_id = ?1")
                .map_err(dohc_engine_storage::StorageError::corrupt_public)?;
            let rows = statement
                .query_map([agent_id], |row| row.get(0))
                .map_err(dohc_engine_storage::StorageError::corrupt_public)?;
            rows.collect::<Result<Vec<String>, _>>()
                .map_err(dohc_engine_storage::StorageError::corrupt_public)
        })
        .expect("agent chats")
}

/// The relay writes a personal agent's DM, a new thread and a post from the
/// agent's origin. The post is the agent's for its account, names its
/// connection, and applies the same on a named recipient's computer and
/// after waiting for its thread.
#[test]
fn a_personal_agent_origin_writes_its_dm_threads_and_posts() {
    use dohc_engine_domain::LinkedChatStore;

    let (_scratch, _path, mut engine) = open_store();
    imported_chat_fixture(&mut engine, "peer");
    let wire = dohc_engine_domain::chats::agent_channel_wire_id(PERSONAL_AGENT);
    let applied = || ApplyOutcome::new(ApplyDisposition::Applied(Vec::new()));
    let ops = [
        envelope(
            PERSONAL_ORIGIN,
            0,
            "chat.channel.create",
            personal_dm_payload(PERSONAL_AGENT),
        ),
        envelope(
            PERSONAL_ORIGIN,
            1,
            "chat.thread.create",
            personal_thread_payload("personal-thread:t", &wire),
        ),
        envelope(
            PERSONAL_ORIGIN,
            2,
            "chat.message.append",
            personal_message_payload("personal-message:dm", "personal-thread:t"),
        ),
        envelope(
            PERSONAL_ORIGIN,
            3,
            "chat.message.append",
            personal_message_payload("personal-message:group", "thread-imported"),
        ),
    ];
    for op in &ops {
        assert_eq!(
            apply_chat_envelope(&mut engine, op, &NoFaults).expect(&op.op_kind),
            applied()
        );
    }
    assert_eq!(
        agent_chats(&engine, PERSONAL_AGENT),
        vec![format!("personal-dm:{PERSONAL_AGENT}")]
    );
    let read = LinkedChatStore::new(&mut engine)
        .get_message("ws", "personal-message:dm")
        .expect("read the personal post");
    assert_eq!(
        (
            read.author_kind,
            read.author_user_id.as_deref(),
            read.author_agent_id.as_deref(),
            read.link_author,
        ),
        (
            ChatActorKind::Agent,
            Some("ana"),
            Some(PERSONAL_AGENT),
            None
        )
    );
    for message_id in ["personal-message:dm", "personal-message:group"] {
        assert_eq!(
            message_connections(&engine, message_id),
            (None, Some("connection-1".to_owned())),
            "{message_id}"
        );
    }

    // A named recipient stores the owner's op under the share.
    let shared = envelope(
        &format!("shared:s:{PERSONAL_ORIGIN}"),
        0,
        "chat.message.append",
        personal_message_payload("personal-message:shared", "thread-imported"),
    );
    assert_eq!(
        apply_chat_envelope(&mut engine, &shared, &NoFaults).expect("shared"),
        applied()
    );

    // A post that waits for its thread replays with its connection.
    apply_chat_envelope(
        &mut engine,
        &envelope(
            PERSONAL_ORIGIN,
            4,
            "chat.message.append",
            personal_message_payload("personal-message:early", "personal-thread:late"),
        ),
        &NoFaults,
    )
    .expect("parked personal post");
    assert_eq!(pending_chat_coordinate_count(&engine), 1);
    apply_chat_envelope(
        &mut engine,
        &envelope(
            PERSONAL_ORIGIN,
            5,
            "chat.thread.create",
            personal_thread_payload("personal-thread:late", "channel-imported"),
        ),
        &NoFaults,
    )
    .expect("late thread");
    assert_eq!(pending_chat_coordinate_count(&engine), 0);
    assert_eq!(
        message_connections(&engine, "personal-message:early"),
        (None, Some("connection-1".to_owned()))
    );
}

/// The personal origin's post must be its agent's, for an account, through a
/// connection. The engine can't know the workspace owner, so the relay checks
/// the account. Each refusal is recorded and acked.
#[test]
fn a_personal_agent_post_that_is_not_the_agents_own_is_refused() {
    let (_scratch, _path, mut engine) = open_store();
    imported_chat_fixture(&mut engine, "peer");
    let post = || personal_message_payload("personal-message:forged", "thread-imported");
    let mut forged = Vec::new();
    for (field, value) in [
        ("authorKind", json!("human")),
        ("authorKind", json!("automation")),
        ("authorAgentId", json!("p-bbbbbbbbbbbbbbbbbbbbbbbbbb")),
        ("authorAgentId", json!("helper")),
        ("agentConnectionId", json!("")),
        ("agentConnectionId", json!(" connection-1")),
        ("authorOwnerDisplayName", json!("Ana")),
        ("origin", json!("cli")),
        ("chainDepth", json!(1)),
        ("linkGrantId", json!("grant-1")),
        ("messageId", json!("forged")),
        (
            "body",
            json!("a".repeat(dohc_engine_domain::chats::MAX_LINK_MESSAGE_BODY_BYTES + 1)),
        ),
    ] {
        let mut payload = post();
        payload[field] = value;
        forged.push(payload);
    }
    for field in ["authorUserId", "authorAgentId", "agentConnectionId"] {
        let mut payload = post();
        payload.as_object_mut().expect("payload").remove(field);
        forged.push(payload);
    }
    for (seq, payload) in forged.into_iter().enumerate() {
        let op = envelope(PERSONAL_ORIGIN, seq as i64, "chat.message.append", payload);
        assert_invalid_refusal!(apply_chat_envelope(&mut engine, &op, &NoFaults));
    }
    // The agent's post, from another agent's origin.
    let other = envelope(
        "relay:personal-agent:p-bbbbbbbbbbbbbbbbbbbbbbbbbb",
        0,
        "chat.message.append",
        post(),
    );
    assert_invalid_refusal!(apply_chat_envelope(&mut engine, &other, &NoFaults));
    let stored: i64 = engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM chat_messages WHERE message_id IN ('forged', 'personal-message:forged')",
                [],
                |row| row.get(0),
            )
            .map_err(dohc_engine_storage::StorageError::corrupt_public)
        })
        .expect("forged count");
    assert_eq!(stored, 0);
}

/// A personal agent posts in a Group, in its own chat, or on a file. A post in
/// a person's DM or another agent's chat is refused, and so is a waiting post
/// whose thread arrives in one.
#[test]
fn a_personal_agent_posts_only_where_the_relay_lets_it() {
    let (_scratch, _path, mut engine) = open_store();
    imported_chat_fixture(&mut engine, "peer");
    let applied = || ApplyOutcome::new(ApplyDisposition::Applied(Vec::new()));
    let other = "p-bbbbbbbbbbbbbbbbbbbbbbbbbb";
    let other_origin = format!("relay:personal-agent:{other}");
    let own_wire = dohc_engine_domain::chats::agent_channel_wire_id(PERSONAL_AGENT);
    let other_wire = dohc_engine_domain::chats::agent_channel_wire_id(other);
    let dm_thread = |thread_id: &str| {
        json!({
            "threadId": thread_id,
            "title": "",
            "createdAtMs": 21,
            "channelSlug": "ben",
            "channelWireId": "dm-person-wire"
        })
    };
    let setup = [
        envelope(
            "peer",
            3,
            "chat.channel.create",
            json!({
                "channelId": "dm-person",
                "name": "Ben",
                "slug": "ben",
                "kind": "dm",
                "createdAtMs": 11,
                "wireId": "dm-person-wire"
            }),
        ),
        envelope("peer", 4, "chat.thread.create", dm_thread("thread-dm")),
        envelope(
            "peer",
            5,
            "chat.thread.create",
            json!({
                "threadId": "thread-file",
                "title": "About a file",
                "createdAtMs": 22,
                "linkedObjectId": "object-a",
                "linkedAtMs": 22
            }),
        ),
        envelope(
            &other_origin,
            0,
            "chat.channel.create",
            personal_dm_payload(other),
        ),
        envelope(
            &other_origin,
            1,
            "chat.thread.create",
            personal_thread_payload("personal-thread:other", &other_wire),
        ),
        envelope(
            PERSONAL_ORIGIN,
            0,
            "chat.channel.create",
            personal_dm_payload(PERSONAL_AGENT),
        ),
        envelope(
            PERSONAL_ORIGIN,
            1,
            "chat.thread.create",
            personal_thread_payload("personal-thread:own", &own_wire),
        ),
    ];
    for op in &setup {
        assert_eq!(
            apply_chat_envelope(&mut engine, op, &NoFaults).expect(&op.op_kind),
            applied()
        );
    }
    for (seq, (message_id, thread_id)) in [
        ("personal-message:own", "personal-thread:own"),
        ("personal-message:group", "thread-imported"),
        ("personal-message:file", "thread-file"),
    ]
    .into_iter()
    .enumerate()
    {
        let op = envelope(
            PERSONAL_ORIGIN,
            2 + seq as i64,
            "chat.message.append",
            personal_message_payload(message_id, thread_id),
        );
        assert_eq!(
            apply_chat_envelope(&mut engine, &op, &NoFaults).expect(message_id),
            applied(),
            "{thread_id}"
        );
    }
    for (seq, (message_id, thread_id)) in [
        ("personal-message:dm", "thread-dm"),
        ("personal-message:other", "personal-thread:other"),
    ]
    .into_iter()
    .enumerate()
    {
        let op = envelope(
            PERSONAL_ORIGIN,
            5 + seq as i64,
            "chat.message.append",
            personal_message_payload(message_id, thread_id),
        );
        assert_invalid_refusal!(apply_chat_envelope(&mut engine, &op, &NoFaults));
    }

    // A post that waits for its thread is checked when the thread arrives.
    let early = envelope(
        PERSONAL_ORIGIN,
        7,
        "chat.message.append",
        personal_message_payload("personal-message:early", "thread-dm-late"),
    );
    assert_eq!(
        apply_chat_envelope(&mut engine, &early, &NoFaults).expect("waiting post"),
        applied()
    );
    assert_eq!(pending_chat_coordinate_count(&engine), 1);
    let late = envelope("peer", 6, "chat.thread.create", dm_thread("thread-dm-late"));
    let ApplyOutcome {
        primary,
        refusals,
        sharing_declined,
    } = apply_chat_envelope(&mut engine, &late, &NoFaults).expect("late DM thread");
    assert!(sharing_declined.is_empty());
    assert_eq!(primary, ApplyDisposition::Applied(Vec::new()));
    assert_eq!(
        refusals,
        vec![ReplicationRefusal {
            workspace_id: "ws".to_owned(),
            origin_id: PERSONAL_ORIGIN.to_owned(),
            origin_seq: 7,
            op_kind: "chat.message.append".to_owned(),
            reason: RefusalReason::InvalidInput {
                reason: "pending personal agent post is in a chat it can't post in".to_owned(),
            },
        }]
    );
    assert_eq!(pending_chat_coordinate_count(&engine), 0);

    // A thread that arrives before its chat stands in a Group until the
    // chat's create arrives, so a post there waits for the create.
    for (seq, (thread_id, wire_id)) in [
        ("thread-before-dm", "dm-later-wire"),
        ("thread-before-group", "group-later-wire"),
    ]
    .into_iter()
    .enumerate()
    {
        let thread = envelope(
            "peer",
            7 + seq as i64,
            "chat.thread.create",
            json!({
                "threadId": thread_id,
                "title": "Early",
                "createdAtMs": 23,
                "channelWireId": wire_id
            }),
        );
        assert_eq!(
            apply_chat_envelope(&mut engine, &thread, &NoFaults).expect(thread_id),
            applied()
        );
        let post = envelope(
            PERSONAL_ORIGIN,
            8 + seq as i64,
            "chat.message.append",
            personal_message_payload(&format!("personal-message:{thread_id}"), thread_id),
        );
        assert_eq!(
            apply_chat_envelope(&mut engine, &post, &NoFaults).expect(thread_id),
            applied()
        );
    }
    assert_eq!(pending_chat_coordinate_count(&engine), 2);
    let later_chat = |seq: i64, kind: &str, wire_id: &str| {
        envelope(
            "peer",
            seq,
            "chat.channel.create",
            json!({
                "channelId": wire_id,
                "name": "Later",
                "slug": wire_id,
                "kind": kind,
                "createdAtMs": 24,
                "wireId": wire_id
            }),
        )
    };
    let ApplyOutcome {
        primary,
        refusals,
        sharing_declined,
    } = apply_chat_envelope(
        &mut engine,
        &later_chat(9, "dm", "dm-later-wire"),
        &NoFaults,
    )
    .expect("the DM's create");
    assert!(sharing_declined.is_empty());
    assert_eq!(primary, ApplyDisposition::Applied(Vec::new()));
    assert_eq!(
        refusals,
        vec![ReplicationRefusal {
            workspace_id: "ws".to_owned(),
            origin_id: PERSONAL_ORIGIN.to_owned(),
            origin_seq: 8,
            op_kind: "chat.message.append".to_owned(),
            reason: RefusalReason::InvalidInput {
                reason: "pending personal agent post is in a chat it can't post in".to_owned(),
            },
        }],
        "a post in a thread whose DM hadn't arrived lands in the DM"
    );
    assert_eq!(pending_chat_coordinate_count(&engine), 1);
    assert_eq!(
        apply_chat_envelope(
            &mut engine,
            &later_chat(10, "channel", "group-later-wire"),
            &NoFaults
        )
        .expect("the Group's create"),
        applied()
    );
    assert_eq!(pending_chat_coordinate_count(&engine), 0);
    assert_eq!(
        message_connections(&engine, "personal-message:thread-before-group"),
        (None, Some("connection-1".to_owned()))
    );

    let stored: i64 = engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM chat_messages WHERE message_id IN \
                 ('personal-message:dm', 'personal-message:other', 'personal-message:early', \
                  'personal-message:thread-before-dm')",
                [],
                |row| row.get(0),
            )
            .map_err(dohc_engine_storage::StorageError::corrupt_public)
        })
        .expect("refused post count");
    assert_eq!(stored, 0);
}

/// The personal origin carries only its agent's DM, new threads under the
/// personal prefix, and posts. Anything else from it is refused.
#[test]
fn a_personal_agent_origin_carries_only_its_chat() {
    let (_scratch, _path, mut engine) = open_store();
    imported_chat_fixture(&mut engine, "peer");
    for (seq, (kind, payload)) in [
        ("moment.append", json!({"momentId": "moment-1"})),
        ("chat.reaction.set", json!({"messageId": "message-imported", "emoji": "👍", "authorId": "ana", "state": "on", "atMs": 1})),
        ("chat.decision.set", json!({"messageId": "message-imported", "state": "open", "atMs": 1})),
        ("chat.follow.set", json!({"ownerUserId": "ana", "targetKind": "thread", "targetId": "thread-imported", "state": "on", "atMs": 1})),
    ]
    .into_iter()
    .enumerate()
    {
        let op = envelope(PERSONAL_ORIGIN, seq as i64, kind, payload);
        assert_invalid_refusal!(apply_replication_envelope(
            &mut engine,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &op,
            &NoFaults,
            &NoLiveLeases,
        ));
    }
    // Only its own agent's DM, and only threads it names as the relay does.
    let mut group = personal_dm_payload(PERSONAL_AGENT);
    group["kind"] = json!("channel");
    group["slug"] = json!("helper");
    group.as_object_mut().expect("payload").remove("wireId");
    for (seq, (kind, payload)) in [
        (
            "chat.channel.create",
            personal_dm_payload("p-bbbbbbbbbbbbbbbbbbbbbbbbbb"),
        ),
        ("chat.channel.create", personal_dm_payload("helper")),
        ("chat.channel.create", group),
        (
            "chat.thread.create",
            personal_thread_payload("thread-forged", "channel-imported"),
        ),
    ]
    .into_iter()
    .enumerate()
    {
        let op = envelope(PERSONAL_ORIGIN, 4 + seq as i64, kind, payload);
        assert_invalid_refusal!(apply_chat_envelope(&mut engine, &op, &NoFaults));
    }
    let channels: i64 = engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM chat_channels WHERE workspace_id = 'ws' AND channel_id <> 'channel-imported'",
                [],
                |row| row.get(0),
            )
            .map_err(dohc_engine_storage::StorageError::corrupt_public)
        })
        .expect("channel count");
    assert_eq!(channels, 0);
    // The next op from the origin still applies.
    assert_eq!(
        apply_chat_envelope(
            &mut engine,
            &envelope(
                PERSONAL_ORIGIN,
                8,
                "chat.channel.create",
                personal_dm_payload(PERSONAL_AGENT)
            ),
            &NoFaults
        )
        .expect("the agent's DM"),
        ApplyOutcome::new(ApplyDisposition::Applied(Vec::new()))
    );
}

/// No other origin writes as a personal agent: not its id, a connection, or
/// either personal prefix. A thread a device takes first under the personal
/// prefix is refused, so the relay's own thread still applies.
#[test]
fn no_other_origin_writes_as_a_personal_agent() {
    let (_scratch, _path, mut engine) = open_store();
    imported_chat_fixture(&mut engine, "peer");
    let mut forged = Vec::new();
    // A device's agent post that names the personal agent, with or without
    // its connection.
    let mut named = personal_message_payload("forged-named", "thread-imported");
    named
        .as_object_mut()
        .expect("payload")
        .remove("agentConnectionId");
    forged.push(named);
    forged.push(personal_message_payload(
        "forged-connected",
        "thread-imported",
    ));
    // A device's own agent, naming a connection.
    let mut connected = personal_message_payload("forged-own", "thread-imported");
    connected["authorAgentId"] = json!("helper");
    forged.push(connected);
    // A human post that takes the personal message prefix.
    let mut taken = personal_message_payload("personal-message:taken", "thread-imported");
    taken["authorKind"] = json!("human");
    let fields = taken.as_object_mut().expect("payload");
    fields.remove("authorAgentId");
    fields.remove("agentConnectionId");
    forged.push(taken);
    // The fixture wrote the peer's first three ops.
    for (origin, first) in [("peer", 3), ("shared:s:peer", 0), (LINK_ORIGIN, 0)] {
        for (seq, payload) in forged.iter().enumerate() {
            let op = envelope(
                origin,
                first + seq as i64,
                "chat.message.append",
                payload.clone(),
            );
            assert_invalid_refusal!(apply_chat_envelope(&mut engine, &op, &NoFaults));
        }
    }
    let taken = envelope(
        "peer",
        7,
        "chat.thread.create",
        personal_thread_payload("personal-thread:taken", "channel-imported"),
    );
    assert_invalid_refusal!(apply_chat_envelope(&mut engine, &taken, &NoFaults));

    let applied = ApplyOutcome::new(ApplyDisposition::Applied(Vec::new()));
    let thread = envelope(
        PERSONAL_ORIGIN,
        0,
        "chat.thread.create",
        personal_thread_payload("personal-thread:taken", "channel-imported"),
    );
    assert_eq!(
        apply_chat_envelope(&mut engine, &thread, &NoFaults).expect("relay thread"),
        applied
    );
    // A computer's own agent still posts as itself.
    let mut own = personal_message_payload("own-agent", "personal-thread:taken");
    own["authorAgentId"] = json!("helper");
    own.as_object_mut()
        .expect("payload")
        .remove("agentConnectionId");
    assert_eq!(
        apply_chat_envelope(
            &mut engine,
            &envelope("peer", 8, "chat.message.append", own),
            &NoFaults
        )
        .expect("an agent you run"),
        applied
    );
    assert_eq!(message_connections(&engine, "own-agent"), (None, None));
}

/// A link holder's post starts no Group automation, even one whose prefix it
/// matches. A member's same post does.
#[test]
fn a_link_post_claims_no_group_automation() {
    let (_scratch, _path, mut engine) = open_store();
    imported_chat_fixture(&mut engine, "peer");
    subscribe_imported_group(&mut engine);
    let link = envelope(
        LINK_ORIGIN,
        0,
        "chat.message.append",
        link_message_payload("link-message:task", "/task Buy tickets"),
    );
    assert!(applied_claims(apply_chat_envelope(&mut engine, &link, &NoFaults)).is_empty());
    let member = group_message(
        "peer",
        3,
        "member-task",
        "thread-imported",
        "human",
        "/task Buy tickets",
    );
    assert_eq!(
        applied_claims(apply_chat_envelope(&mut engine, &member, &NoFaults)).len(),
        1
    );
}

fn applied_claims(
    outcome: Result<ApplyOutcome<Vec<dohc_engine_domain::AutomationClaim>>, SyncError>,
) -> Vec<dohc_engine_domain::AutomationClaim> {
    match outcome.expect("apply") {
        ApplyOutcome {
            primary: ApplyDisposition::Applied(claims),
            refusals,
            sharing_declined,
        } if refusals.is_empty() && sharing_declined.is_empty() => claims,
        other => panic!("expected an applied message: {other:?}"),
    }
}

/// Subscribe `collection:object-tasks#task` to the imported Group's messages
/// that start with `/task`.
fn subscribe_imported_group(engine: &mut EngineStore) {
    let channel_id: String = engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT channel_id FROM chat_threads WHERE thread_id = 'thread-imported'",
                [],
                |row| row.get(0),
            )
            .map_err(dohc_engine_storage::StorageError::corrupt_public)
        })
        .expect("imported Group");
    dohc_engine_domain::watch_automation_groups(
        engine,
        "ws",
        &dohc_engine_domain::AutomationGroupWatch {
            generation: 0,
            subscriptions: vec![dohc_engine_domain::AutomationGroupSubscription {
                automation_id: "collection:object-tasks#task".to_owned(),
                channel_id,
                starts_with: Some("/task".to_owned()),
            }],
            relay: None,
        },
        1,
        &NoFaults,
    )
    .expect("watch");
}

/// Another member's message in the imported Group.
fn group_message(
    origin: &str,
    seq: i64,
    message_id: &str,
    thread_id: &str,
    author_kind: &str,
    body: &str,
) -> ReplicationEnvelope {
    let mut payload = json!({
        "messageId": message_id,
        "threadId": thread_id,
        "authorKind": author_kind,
        "authorDisplayName": "Ana",
        "authorUserId": "ana",
        "body": body,
        "createdAtMs": 30 + seq,
    });
    if author_kind == "automation" {
        payload["authorOwnerDisplayName"] = json!("Ana");
    }
    envelope(origin, seq, "chat.message.append", payload)
}

/// A Group message claims in the transaction that applies it, dated when it
/// was written, however it arrives: from the relay, again from a second
/// lane, or parked until its thread lands. Another computer's automation
/// arrives without its depth and counts as depth 1.
#[test]
fn an_applied_group_message_claims_once_however_it_arrives() {
    use dohc_engine_domain::{AutomationChangeKind, AutomationTrigger, ChangeActorKind};

    let (_scratch, _path, mut engine) = open_store();
    imported_chat_fixture(&mut engine, "peer");
    subscribe_imported_group(&mut engine);

    let member = group_message(
        "peer",
        3,
        "m-ana",
        "thread-imported",
        "human",
        " /task Buy tickets",
    );
    let claims = applied_claims(apply_chat_envelope(&mut engine, &member, &NoFaults));
    assert_eq!(claims.len(), 1);
    assert_eq!(claims[0].automation_id, "collection:object-tasks#task");
    assert_eq!(
        claims[0].trigger,
        AutomationTrigger::Key {
            key: "message:m-ana".to_owned()
        }
    );
    assert_eq!(claims[0].record_id, None);
    assert_eq!(claims[0].created_at_ms, 33, "dated when it was written");
    assert_eq!(claims[0].depth, 0);
    assert_eq!(claims[0].change.kind, AutomationChangeKind::Message);
    assert_eq!(claims[0].change.actor_kind, Some(ChangeActorKind::Human));
    assert_eq!(claims[0].change.on_behalf_of.as_deref(), Some("ana"));

    let second_lane = group_message(
        "share-lane",
        0,
        "m-ana",
        "thread-imported",
        "human",
        " /task Buy tickets",
    );
    assert!(
        applied_claims(apply_chat_envelope(&mut engine, &second_lane, &NoFaults)).is_empty(),
        "the same message from a second lane claims nothing"
    );
    let other = group_message("peer", 4, "m-hello", "thread-imported", "human", "hello");
    assert!(applied_claims(apply_chat_envelope(&mut engine, &other, &NoFaults)).is_empty());

    let automated = group_message(
        "peer",
        5,
        "m-auto",
        "thread-imported",
        "automation",
        "/task From Ana's automation",
    );
    let claims = applied_claims(apply_chat_envelope(&mut engine, &automated, &NoFaults));
    assert_eq!(claims.len(), 1);
    assert_eq!(claims[0].depth, 1, "an automation message without a depth");
    assert_eq!(claims[0].change.author_origin_id, None);
    assert_eq!(
        claims[0].change.actor_kind,
        Some(ChangeActorKind::Automation)
    );

    // The depth another computer sends keeps a chain's count, within the cap,
    // so two people's automations answering each other stop at the cap.
    let mut deeper = group_message(
        "peer",
        6,
        "m-deeper",
        "thread-imported",
        "automation",
        "/task Deeper",
    );
    deeper.payload["chainDepth"] = json!(3);
    let claims = applied_claims(apply_chat_envelope(&mut engine, &deeper, &NoFaults));
    assert_eq!(claims[0].depth, 3);
    assert!(!claims[0].chain_stopped());
    let mut high = group_message(
        "peer",
        7,
        "m-high",
        "thread-imported",
        "automation",
        "/task High",
    );
    high.payload["chainDepth"] = json!(9);
    let claims = applied_claims(apply_chat_envelope(&mut engine, &high, &NoFaults));
    assert_eq!(
        claims[0].depth,
        dohc_engine_domain::AUTOMATION_CHAIN_DEPTH_CAP
    );
    assert!(
        claims[0].chain_stopped(),
        "a high depth only stops the chain"
    );
    // An agent an automation woke on another computer posts at its run's
    // depth, so the chain keeps its count here too.
    let mut woken = group_message(
        "peer",
        8,
        "m-woken",
        "thread-imported",
        "agent",
        "/task From Ana's agent",
    );
    woken.payload["authorOwnerDisplayName"] = json!("Ana");
    woken.payload["chainDepth"] = json!(3);
    let claims = applied_claims(apply_chat_envelope(&mut engine, &woken, &NoFaults));
    assert_eq!(claims[0].depth, 3);
    assert_eq!(claims[0].change.actor_kind, Some(ChangeActorKind::Agent));

    let early = group_message(
        "early-peer",
        0,
        "m-early",
        "late-thread",
        "human",
        "/task Later",
    );
    assert!(applied_claims(apply_chat_envelope(&mut engine, &early, &NoFaults)).is_empty());
    assert_eq!(pending_chat_coordinate_count(&engine), 1);
    let thread = envelope(
        "late-thread-peer",
        0,
        "chat.thread.create",
        json!({
            "threadId": "late-thread",
            "title": "Late thread",
            "createdAtMs": 25,
            "channelSlug": "imported"
        }),
    );
    let claims = applied_claims(apply_chat_envelope(&mut engine, &thread, &NoFaults));
    assert_eq!(
        claims
            .iter()
            .map(|claim| claim.trigger.clone())
            .collect::<Vec<_>>(),
        vec![AutomationTrigger::Key {
            key: "message:m-early".to_owned()
        }],
        "the parked message claims when its thread lands"
    );
}

fn claim_keys(claims: Vec<dohc_engine_domain::AutomationClaim>) -> Vec<String> {
    claims
        .into_iter()
        .map(|claim| match claim.trigger {
            dohc_engine_domain::AutomationTrigger::Key { key } => key,
            other => panic!("expected a message claim: {other:?}"),
        })
        .collect()
}

/// A relay pass keeps every claim its applies committed, even when a later
/// envelope fails the pass, so the wake still goes out. The retry finds the
/// first message stored and claims only the second.
#[test]
fn a_relay_pass_keeps_committed_claims_when_a_later_envelope_fails() {
    let (_scratch, _path, mut engine) = open_store();
    seed_identity(&mut engine);
    imported_chat_fixture(&mut engine, "peer");
    subscribe_imported_group(&mut engine);
    let trigger = |engine: &mut EngineStore, sql: &'static str| {
        engine
            .write_with(&NoFaults, |tx| {
                tx.execute_batch(sql).map_err(SyncError::persist)?;
                Ok::<_, SyncError>(())
            })
            .expect("change the failing trigger");
    };
    trigger(
        &mut engine,
        "CREATE TRIGGER fail_second_message BEFORE INSERT ON chat_messages \
         WHEN NEW.message_id = 'm-2' \
         BEGIN SELECT RAISE(ABORT, 'injected apply failure'); END",
    );
    let client = RelaySyncClient::new(FakeRelay {
        refuse_oversized_proofs: false,
        push_budget_limit: None,
        pushes: Mutex::new(Vec::new()),
        pull: Mutex::new(Some(PullResponse {
            work_references: Vec::new(),
            next_reference_after: None,
            reference_has_more: false,
            ops: vec![
                group_message("peer", 3, "m-1", "thread-imported", "human", "/task One"),
                group_message("peer", 4, "m-2", "thread-imported", "human", "/task Two"),
            ],
            next_cursor: 2,
            has_more: false,
        })),
        ..Default::default()
    });
    let pull = |engine: &mut EngineStore| {
        client.pull_chat_workspace(
            engine,
            &mut dohc_engine_collab::WriterDocCache::new(),
            "ws",
            &NoFaults,
            &NoLiveLeases,
            1_000,
        )
    };

    assert!(matches!(pull(&mut engine), Err(RelayError::Local(_))));
    assert_eq!(
        claim_keys(client.take_automation_claims()),
        vec!["message:m-1"],
        "the committed message's claim survives the failed pass"
    );

    trigger(&mut engine, "DROP TRIGGER fail_second_message");
    assert!(matches!(
        pull(&mut engine).expect("retry"),
        SyncPassOutcome::Complete { .. }
    ));
    assert_eq!(
        claim_keys(client.take_automation_claims()),
        vec!["message:m-2"],
        "the retry claims only the message it stored"
    );
}

#[test]
fn chat_message_before_thread_is_parked_and_replayed_after_thread_arrives() {
    let (_scratch, _path, mut engine) = open_store();
    let message = envelope(
        "early-message-peer",
        0,
        "chat.message.append",
        json!({
            "messageId": "early-message",
            "threadId": "late-thread",
            "authorKind": "agent",
            "authorDisplayName": "Nova",
            "authorOwnerDisplayName": "Sam",
            "authorUserId": "ice",
            "body": "@agent arrived first",
            "createdAtMs": 30
        }),
    );
    assert!(matches!(
        apply_chat_envelope(&mut engine, &message, &NoFaults),
        Ok(ApplyOutcome {
            primary: ApplyDisposition::Applied(_),
            refusals: ref outcome_refusals,
            sharing_declined: ref outcome_sharing_declined,
        }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
    ));
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "early-message-peer").expect("message ack"),
        0,
        "the durable pending row allows the cross-origin coordinate to ACK"
    );
    assert_eq!(pending_chat_coordinate_count(&engine), 1);

    let channel = envelope(
        "late-channel-peer",
        0,
        "chat.channel.create",
        json!({
            "channelId": "late-channel",
            "name": "Late",
            "slug": "late",
            "kind": "channel",
            "createdAtMs": 10
        }),
    );
    apply_chat_envelope(&mut engine, &channel, &NoFaults).expect("channel");
    let thread = envelope(
        "late-thread-peer",
        0,
        "chat.thread.create",
        json!({
            "threadId": "late-thread",
            "title": "Late thread",
            "createdAtMs": 20,
            "channelSlug": "late"
        }),
    );
    apply_chat_envelope(&mut engine, &thread, &NoFaults).expect("thread");

    let replayed: (String, String, i64, String) = engine
        .read_with(|conn| {
            Ok::<_, rusqlite::Error>((
                conn.query_row(
                    "SELECT body FROM chat_messages \
                     WHERE workspace_id='ws' AND thread_id='late-thread' \
                       AND message_id='early-message'",
                    [],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT text FROM engine_search_chat_messages_fts \
                     WHERE workspace_id='ws' AND thread_id='late-thread' \
                       AND message_id='early-message'",
                    [],
                    |row| row.get(0),
                )?,
                conn.query_row("SELECT COUNT(*) FROM chat_pending_replication", [], |row| {
                    row.get(0)
                })?,
                conn.query_row("SELECT author_owner_display_name FROM chat_messages WHERE message_id='early-message'", [], |row| row.get(0))?,
            ))
        })
        .expect("replayed message state");
    assert_eq!(
        replayed,
        (
            "@agent arrived first".to_owned(),
            "Nova\nNova (agent)\n@agent arrived first".to_owned(),
            0,
            "Sam".to_owned()
        ),
        "missing-thread refusal loses the message instead of replaying it"
    );
}

#[test]
fn terminal_pending_chat_replay_is_persisted_and_returned_to_the_triggering_apply() {
    let (_scratch, _path, mut engine) = open_store();
    let follow = envelope(
        "pending-terminal-follow",
        0,
        "chat.follow.set",
        json!({
            "ownerUserId": "owner",
            "targetKind": "channel",
            "targetId": "later-private-wire",
            "state": "following",
            "atMs": 20
        }),
    );
    assert_eq!(
        apply_chat_envelope(&mut engine, &follow, &NoFaults).expect("park follow"),
        ApplyOutcome::new(ApplyDisposition::Applied(Vec::new()))
    );
    let private_channel = envelope(
        "private-channel-source",
        0,
        "chat.channel.create",
        json!({
            "channelId": "later-private-channel",
            "name": "Later private",
            "slug": "later-private",
            "kind": "dm",
            "createdAtMs": 30,
            "wireId": "later-private-wire"
        }),
    );
    let outcome =
        apply_chat_envelope(&mut engine, &private_channel, &NoFaults).expect("private channel");
    let ApplyOutcome {
        primary,
        refusals,
        sharing_declined,
    } = outcome;
    assert!(sharing_declined.is_empty());
    assert_eq!(primary, ApplyDisposition::Applied(Vec::new()));
    assert_eq!(
        refusals,
        vec![ReplicationRefusal {
            workspace_id: "ws".to_owned(),
            origin_id: "pending-terminal-follow".to_owned(),
            origin_seq: 0,
            op_kind: "chat.follow.set".to_owned(),
            reason: RefusalReason::InvalidInput {
                reason: "chat follow target is not followable".to_owned(),
            },
        }],
        "deleting a terminal pending coordinate without returning it loses the disposition"
    );
    let disposition: (i64, i64) = engine
        .read_with(|conn| {
            Ok::<_, rusqlite::Error>((
                conn.query_row(
                    "SELECT COUNT(*) FROM chat_pending_replication \
                     WHERE workspace_id='ws' AND origin_id='pending-terminal-follow'",
                    [],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*) FROM replication_pending_refusals \
                     WHERE workspace_id='ws' AND origin_id='pending-terminal-follow' \
                       AND reason_message='chat follow target is not followable'",
                    [],
                    |row| row.get(0),
                )?,
            ))
        })
        .expect("pending terminal disposition");
    assert_eq!(
        disposition,
        (0, 1),
        "deleting without persistence makes the ACKed terminal coordinate unobservable"
    );
}

#[test]
fn incoming_placeholder_never_displaces_bootstrapped_general_regardless_of_clock() {
    let newcomer_wire = "stranger-general-wire";
    let expected_newcomer_slug = collision_slug_for_test("general", newcomer_wire, 0);

    for (local_created_at_ms, label) in [(1_000, "local-earlier"), (9_000, "local-later")] {
        let (_scratch, _path, mut engine) = open_store();
        let local_channel_id = format!("general-{label}");
        LinkedChatStore::new(&mut engine)
            .ensure_general_channel("ws", &local_channel_id, local_created_at_ms, &NoFaults)
            .expect("bootstrap local general");

        let incoming = envelope(
            &format!("incoming-{label}"),
            0,
            "chat.thread.create",
            json!({
                "threadId": format!("stranger-thread-{label}"),
                "title": "Stranger",
                "createdAtMs": 5_000,
                "channelSlug": "general",
                "channelWireId": newcomer_wire
            }),
        );
        apply_chat_envelope(&mut engine, &incoming, &NoFaults).expect("incoming placeholder");

        let (local_slug, newcomer_slug): (String, String) = engine
            .read_with(|conn| {
                Ok::<_, rusqlite::Error>((
                    conn.query_row(
                        "SELECT slug FROM chat_channels \
                         WHERE workspace_id='ws' AND channel_id=?1",
                        [&local_channel_id],
                        |row| row.get(0),
                    )?,
                    conn.query_row(
                        "SELECT c.slug FROM chat_channel_wire_ids w \
                         JOIN chat_channels c \
                           ON c.workspace_id=w.workspace_id AND c.channel_id=w.channel_id \
                         WHERE w.workspace_id='ws' AND w.wire_id=?1",
                        [newcomer_wire],
                        |row| row.get(0),
                    )?,
                ))
            })
            .expect("channel slugs");
        assert_eq!(
            local_slug, "general",
            "an incoming row must never rename the locally bootstrapped General channel"
        );
        assert_eq!(newcomer_slug, expected_newcomer_slug);
    }
}

#[test]
fn set_follow_returns_the_post_boundary_replay_winner() {
    let (_scratch, _path, mut engine) = open_store();
    LinkedChatStore::new(&mut engine)
        .create_channel(
            "ws",
            "follow-return-channel",
            "Follow return",
            ChatChannelKind::Channel,
            10,
            &NoFaults,
        )
        .expect("target channel");
    let remote = envelope(
        "follow-return-remote",
        0,
        "chat.follow.set",
        json!({
            "ownerUserId": "owner",
            "targetKind": "thread",
            "targetId": "follow-return-thread",
            "state": "unfollowed",
            "atMs": 100
        }),
    );
    apply_chat_envelope(&mut engine, &remote, &NoFaults).expect("park remote winner");
    assert_eq!(pending_chat_coordinate_count(&engine), 1);

    engine
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT INTO chat_threads \
                 (workspace_id,thread_id,title,created_at_ms,updated_at_ms,channel_id) \
                 VALUES ('ws','follow-return-thread','Target',20,20,'follow-return-channel')",
                [],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .expect("materialize dependency without a domain replay boundary");

    let returned = LinkedChatStore::new(&mut engine)
        .set_follow(
            &SetFollow {
                workspace_id: "ws".to_owned(),
                owner_user_id: "owner".to_owned(),
                replication_owner_user_id: None,
                target_kind: FollowTargetKind::Thread,
                target_id: "follow-return-thread".to_owned(),
                state: FollowState::Following,
                now_ms: 50,
            },
            &NoFaults,
        )
        .expect("local follow and boundary replay");
    assert_eq!(
        returned.state,
        FollowState::Unfollowed,
        "set_follow must return the committed remote LWW winner applied by its boundary replay"
    );
    assert_eq!(returned.updated_at_ms, 100);
    assert_eq!(pending_chat_coordinate_count(&engine), 0);
}

fn collision_slug_for_test(requested: &str, allocation_identity: &str, attempt: u64) -> String {
    let mut hasher = Sha256::new();
    hasher.update(requested.as_bytes());
    hasher.update([0]);
    hasher.update(allocation_identity.as_bytes());
    if attempt > 0 {
        hasher.update([0]);
        hasher.update(attempt.to_be_bytes());
    }
    let mut utf16_units = 0;
    let mut end = 0;
    for (index, ch) in requested.char_indices() {
        if utf16_units + ch.len_utf16() > 135 {
            break;
        }
        utf16_units += ch.len_utf16();
        end = index + ch.len_utf8();
    }
    let bounded = requested[..end].trim_end_matches('-');
    let suffix = dohc_engine_storage::hex(&hasher.finalize());
    format!("{bounded}-{suffix}")
}

#[test]
fn parked_chat_coordinate_survives_store_reopen() {
    let (_scratch, path, mut engine) = open_store();
    let follow = envelope(
        "reopen-follow-origin",
        0,
        "chat.follow.set",
        json!({
            "ownerUserId": "owner",
            "targetKind": "thread",
            "targetId": "reopen-thread",
            "state": "following",
            "atMs": 30
        }),
    );
    assert_eq!(
        apply_chat_envelope(&mut engine, &follow, &NoFaults).expect("park before reopen"),
        ApplyOutcome::new(ApplyDisposition::Applied(Vec::new()))
    );
    assert_eq!(pending_chat_coordinate_count(&engine), 1);
    drop(engine);

    let mut reopened = EngineStore::open(&path, 1_001).expect("reopen");
    assert_eq!(pending_chat_coordinate_count(&reopened), 1);
    let thread = envelope(
        "reopen-thread-origin",
        0,
        "chat.thread.create",
        json!({
            "threadId": "reopen-thread",
            "title": "Reopen target",
            "createdAtMs": 20,
            "linkedObjectId": "reopen-thread-object",
            "linkedAtMs": 20
        }),
    );
    apply_chat_envelope(&mut reopened, &thread, &NoFaults).expect("target after reopen");

    let follow_count: i64 = reopened
        .read_with(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM chat_follows \
                 WHERE workspace_id='ws' AND target_kind='thread' AND target_id='reopen-thread'",
                [],
                |row| row.get(0),
            )
            .map_err(dohc_engine_storage::StorageError::corrupt_public)
        })
        .expect("replayed follow after reopen");
    assert_eq!(follow_count, 1);
    assert_eq!(pending_chat_coordinate_count(&reopened), 0);
}

#[test]
fn imported_verbatim_chat_rows_remain_readable_and_locally_mutable() {
    let (_scratch, _path, mut engine) = open_store();
    imported_chat_fixture(&mut engine, "verbatim");

    let mut reaction = reaction_payload("added", "👍", -10, "Ada");
    reaction["threadId"] = json!("thread-imported");
    reaction["messageId"] = json!("message-imported");
    let operations = [
        envelope("verbatim", 3, "chat.reaction.set", reaction),
        envelope(
            "verbatim",
            4,
            "chat.decision.set",
            json!({
                "threadId": "thread-imported",
                "messageId": "message-imported",
                "state": "open",
                "atMs": -9
            }),
        ),
        envelope(
            "verbatim",
            5,
            "chat.message.append",
            json!({
                "messageId": "file-message-negative",
                "threadId": "thread-imported",
                "authorKind": "human",
                "authorDisplayName": "Ada",
                "body": "Imported negative attachment",
                "createdAtMs": -29
            }),
        ),
        envelope(
            "verbatim",
            6,
            "chat.attachment.add",
            json!({
                "attachmentId": attachment_id_for(
                    "file-message-negative",
                    "object-negative",
                    None,
                    None
                ),
                "threadId": "thread-imported",
                "messageId": "file-message-negative",
                "targetKind": "file",
                "objectId": "object-negative",
                "createdAtMs": -28
            }),
        ),
    ];
    for operation in operations {
        apply_chat_envelope(&mut engine, &operation, &NoFaults).expect("verbatim import");
    }

    LinkedChatStore::new(&mut engine)
        .set_follow(
            &SetFollow {
                workspace_id: "ws".to_owned(),
                owner_user_id: "viewer".to_owned(),
                replication_owner_user_id: None,
                target_kind: FollowTargetKind::Thread,
                target_id: "thread-imported".to_owned(),
                state: FollowState::Following,
                now_ms: 1,
            },
            &NoFaults,
        )
        .expect("follow imported thread");

    let reactions = LinkedChatStore::new(&mut engine)
        .list_reactions("ws", "thread-imported", None, 10)
        .expect("list imported reaction");
    let feed = LinkedChatStore::new(&mut engine)
        .list_personal_feed("ws", "viewer", Some(10), None)
        .expect("hydrate imported reaction");
    let decisions = LinkedChatStore::new(&mut engine)
        .list_thread_decisions("ws", "thread-imported", None, 10)
        .expect("list imported decision");
    let messages = LinkedChatStore::new(&mut engine)
        .list_messages("ws", "thread-imported", 10, None)
        .expect("list imported message");
    let attachments = LinkedChatStore::new(&mut engine)
        .list_thread_attachments("ws", "thread-imported", None, 10)
        .expect("list imported attachment");

    assert_eq!(
        (
            reactions[0].at_ms,
            reactions[0].author_display_name.as_str()
        ),
        (-10, "Ada"),
        "reject the still-permitted negative timestamps or tighten their row mappers and the corresponding read fails here.",
    );
    assert_eq!(feed.items[0].reactions[0].at_ms, -10);
    assert_eq!(decisions[0].at_ms, -9);
    assert_eq!(
        messages
            .messages
            .iter()
            .find(|message| message.message_id == "file-message-negative")
            .expect("negative message")
            .created_at_ms,
        -29
    );
    assert_eq!(attachments[0].created_at_ms, -28);

    let local_reaction = LinkedChatStore::new(&mut engine)
        .set_reaction(
            &SetReaction {
                workspace_id: "ws".to_owned(),
                thread_id: "thread-imported".to_owned(),
                message_id: "message-imported".to_owned(),
                emoji: "👍".to_owned(),
                author_id: "Ada".to_owned(),
                replication_author_id: Some("Ada".to_owned()),
                author_kind: ChatActorKind::Human,
                author_display_name: "Ada".to_owned(),
                state: ChatReactionState::Removed,
                now_ms: 0,
                request_id: "local-after-import".to_owned(),
            },
            &NoFaults,
        )
        .expect("local reaction after import");
    let local_decision = LinkedChatStore::new(&mut engine)
        .resolve_decision(
            &ResolveDecision {
                workspace_id: "ws".to_owned(),
                thread_id: "thread-imported".to_owned(),
                message_id: "message-imported".to_owned(),
                resolved_by_message_id: "message-imported".to_owned(),
                chosen_option: None,
                now_ms: 0,
                request_id: "local-decision-after-import".to_owned(),
            },
            &NoFaults,
        )
        .expect("local decision after import");
    assert_eq!(local_reaction.at_ms, 0);
    assert_eq!(local_decision.at_ms, 0);
}

#[test]
fn imported_message_append_refuses_each_oracle_invalid_field() {
    let invalid_payloads = [
        json!({
            "messageId": "",
            "threadId": "thread-imported",
            "authorKind": "human",
            "authorDisplayName": "Ada",
            "body": "Body",
            "createdAtMs": 20
        }),
        json!({
            "messageId": "message",
            "threadId": "",
            "authorKind": "human",
            "authorDisplayName": "Ada",
            "body": "Body",
            "createdAtMs": 20
        }),
        json!({
            "messageId": "message",
            "threadId": "thread-imported",
            "authorKind": "other",
            "authorDisplayName": "Ada",
            "body": "Body",
            "createdAtMs": 20
        }),
        json!({
            "messageId": "message",
            "threadId": "thread-imported",
            "authorKind": "human",
            "authorDisplayName": "",
            "body": "Body",
            "createdAtMs": 20
        }),
        json!({
            "messageId": "message",
            "threadId": "thread-imported",
            "authorKind": "human",
            "authorDisplayName": "Ada",
            "authorUserId": "",
            "body": "Body",
            "createdAtMs": 20
        }),
        json!({
            "messageId": "message",
            "threadId": "thread-imported",
            "authorKind": "human",
            "authorDisplayName": "Ada",
            "authorUserId": null,
            "body": "Body",
            "createdAtMs": 20
        }),
        json!({
            "messageId": "message",
            "threadId": "thread-imported",
            "authorKind": "human",
            "authorDisplayName": "Ada",
            "parentMessageId": "",
            "body": "Body",
            "createdAtMs": 20
        }),
        json!({
            "messageId": "message",
            "threadId": "thread-imported",
            "authorKind": "human",
            "authorDisplayName": "Ada",
            "parentMessageId": null,
            "body": "Body",
            "createdAtMs": 20
        }),
        json!({
            "messageId": "message",
            "threadId": "thread-imported",
            "authorKind": "human",
            "authorDisplayName": "Ada",
            "origin": "desktop",
            "body": "Body",
            "createdAtMs": 20
        }),
        json!({
            "messageId": "message",
            "threadId": "thread-imported",
            "authorKind": "human",
            "authorDisplayName": "Ada",
            "origin": null,
            "body": "Body",
            "createdAtMs": 20
        }),
        json!({
            "messageId": "message",
            "threadId": "thread-imported",
            "authorKind": "human",
            "authorDisplayName": "Ada",
            "body": "",
            "createdAtMs": 20
        }),
    ];
    for payload in invalid_payloads {
        let (_scratch, _path, mut engine) = open_store();
        imported_chat_fixture(&mut engine, "invalid-message");
        let operation = envelope("invalid-message", 3, "chat.message.append", payload);
        assert_invalid_refusal!(apply_chat_envelope(&mut engine, &operation, &NoFaults));
        assert_eq!(
            read_replication_acked_seq(&engine, "ws", "invalid-message").expect("ack"),
            3,
            "omitting any message.append oracle predicate journals a payload that the TypeScript receiver refuses.",
        );
    }
}

#[test]
fn refused_message_log_cannot_export_local_derived_state_or_parent() {
    let (_scratch, _path, mut engine) = open_store();
    imported_chat_fixture(&mut engine, "refused-message-collision");
    let refused = envelope(
        "refused-message-collision",
        3,
        "chat.message.append",
        json!({
            "messageId": "refused-message-id",
            "threadId": "thread-imported",
            "authorKind": "other",
            "authorDisplayName": "Remote",
            "authorUserId": "remote-user",
            "body": "This envelope is terminally refused.",
            "createdAtMs": 30
        }),
    );
    assert_invalid_refusal!(apply_chat_envelope(&mut engine, &refused, &NoFaults));

    LinkedChatStore::new(&mut engine)
        .send_message(
            &SendMessage {
                automation: None,
                workspace_id: "ws".to_owned(),
                thread_id: "thread-imported".to_owned(),
                message_id: "refused-message-id".to_owned(),
                author_kind: ChatActorKind::Human,
                author_display_name: "Local".to_owned(),
                author_owner_display_name: None,
                author_user_id: None,
                parent_message_id: None,
                origin: None,
                body: "This message stays local.".to_owned(),
                needs_decision: true,
                options: Vec::new(),
                attachments: Vec::new(),
                author_agent_id: None,
                author_reported: None,
                work: None,
                wake_agent_ids: Vec::new(),
                now_ms: 31,
                request_id: Some("local-message-after-refusal".to_owned()),
            },
            &NoFaults,
        )
        .expect("local message with a refused remote id");
    LinkedChatStore::new(&mut engine)
        .set_reaction(
            &SetReaction {
                workspace_id: "ws".to_owned(),
                thread_id: "thread-imported".to_owned(),
                message_id: "refused-message-id".to_owned(),
                emoji: "👍".to_owned(),
                author_id: "verified-user".to_owned(),
                replication_author_id: Some("verified-user".to_owned()),
                author_kind: ChatActorKind::Human,
                author_display_name: "Verified".to_owned(),
                state: ChatReactionState::Added,
                now_ms: 32,
                request_id: "reaction-after-refusal".to_owned(),
            },
            &NoFaults,
        )
        .expect("local reaction to a non-exported message");
    LinkedChatStore::new(&mut engine)
        .send_message(
            &SendMessage {
                automation: None,
                workspace_id: "ws".to_owned(),
                thread_id: "thread-imported".to_owned(),
                message_id: "authored-child".to_owned(),
                author_kind: ChatActorKind::Human,
                author_display_name: "Verified".to_owned(),
                author_owner_display_name: None,
                author_user_id: Some("verified-user".to_owned()),
                parent_message_id: Some("refused-message-id".to_owned()),
                origin: None,
                body: "This authored child must not export the local parent.".to_owned(),
                needs_decision: false,
                options: Vec::new(),
                attachments: Vec::new(),
                author_agent_id: None,
                author_reported: None,
                work: None,
                wake_agent_ids: Vec::new(),
                now_ms: 33,
                request_id: Some("authored-child-after-refusal".to_owned()),
            },
            &NoFaults,
        )
        .expect("authored child of a non-exported message");
    LinkedChatStore::new(&mut engine)
        .resolve_decision(
            &ResolveDecision {
                workspace_id: "ws".to_owned(),
                thread_id: "thread-imported".to_owned(),
                message_id: "refused-message-id".to_owned(),
                resolved_by_message_id: "authored-child".to_owned(),
                chosen_option: None,
                now_ms: 34,
                request_id: "resolve-after-refusal".to_owned(),
            },
            &NoFaults,
        )
        .expect("resolve the local-only decision");

    let (
        refused_log_rows,
        decision_op_rows,
        reaction_op_rows,
        decision_state,
        reaction_rows,
        child_parent_type,
    ): (i64, i64, i64, String, i64, Option<String>) = engine
        .read_with(|conn| {
            Ok::<_, rusqlite::Error>((
                conn.query_row(
                    "SELECT COUNT(*) FROM replication_log \
                     WHERE workspace_id='ws' AND op_kind='chat.message.append' \
                       AND json_extract(payload_json,'$.messageId')='refused-message-id'",
                    [],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*) FROM replication_log \
                     WHERE workspace_id='ws' AND op_kind='chat.decision.set' \
                       AND json_extract(payload_json,'$.messageId')='refused-message-id'",
                    [],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*) FROM replication_log \
                     WHERE workspace_id='ws' AND op_kind='chat.reaction.set' \
                       AND json_extract(payload_json,'$.messageId')='refused-message-id'",
                    [],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT state FROM chat_decisions \
                     WHERE workspace_id='ws' AND message_id='refused-message-id'",
                    [],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*) FROM chat_reactions \
                     WHERE workspace_id='ws' AND message_id='refused-message-id'",
                    [],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT json_type(payload_json,'$.parentMessageId') \
                     FROM replication_log \
                     WHERE workspace_id='ws' AND op_kind='chat.message.append' \
                       AND json_extract(payload_json,'$.messageId')='authored-child'",
                    [],
                    |row| row.get(0),
                )?,
            ))
        })
        .expect("read refused-message collision evidence");
    assert_eq!(refused_log_rows, 1, "the refused envelope remains durable");
    assert_eq!(decision_op_rows, 0, "local decisions must not export");
    assert_eq!(reaction_op_rows, 0, "local reactions must not export");
    assert_eq!(
        decision_state, "resolved",
        "local decision state remains usable"
    );
    assert_eq!(reaction_rows, 1, "local reaction state remains usable");
    assert_eq!(
        child_parent_type, None,
        "an authored child must not reference a non-exported parent"
    );
}

#[test]
fn imported_message_normalizes_before_enforcing_the_local_body_cap() {
    let (_scratch, _path, mut engine) = open_store();
    imported_chat_fixture(&mut engine, "body-validation");
    let boundary = envelope(
        "body-validation",
        3,
        "chat.message.append",
        json!({
            "messageId": "normalized-boundary",
            "threadId": "thread-imported",
            "authorKind": "human",
            "authorDisplayName": "Ada",
            "body": format!("{}\r\n", "x".repeat(64 * 1024 - 1)),
            "createdAtMs": 30
        }),
    );
    assert!(matches!(
        apply_chat_envelope(&mut engine, &boundary, &NoFaults),
        Ok(ApplyOutcome {
            primary: ApplyDisposition::Applied(_),
            refusals: ref outcome_refusals,
            sharing_declined: ref outcome_sharing_declined,
        }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
    ));
    let stored: String = engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT body FROM chat_messages WHERE workspace_id='ws' AND message_id='normalized-boundary'",
                [],
                |row| row.get(0),
            )
        })
        .expect("normalized body");
    assert_eq!(stored, "x".repeat(64 * 1024 - 1));

    let oversized = envelope(
        "body-validation",
        4,
        "chat.message.append",
        json!({
            "messageId": "oversized-after-normalization",
            "threadId": "thread-imported",
            "authorKind": "human",
            "authorDisplayName": "Ada",
            "body": format!("{}\r\n", "x".repeat(64 * 1024 + 1)),
            "createdAtMs": 31
        }),
    );
    assert_invalid_refusal!(apply_chat_envelope(&mut engine, &oversized, &NoFaults));
    let oversized_count: i64 = engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM chat_messages WHERE workspace_id='ws' AND message_id='oversized-after-normalization'",
                [],
                |row| row.get(0),
            )
        })
        .expect("oversized body count");
    assert_eq!(oversized_count, 0);
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "body-validation").expect("ack"),
        4
    );
}

#[test]
fn imported_feed_read_rejects_an_invisible_coordinate_without_changing_unread_state() {
    let (_scratch, _path, mut engine) = open_store();
    imported_chat_fixture(&mut engine, "feed-fixture");
    engine
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT INTO chat_follows \
                 (workspace_id,owner_user_id,target_kind,target_id,state,updated_at_ms,origin_id,origin_seq) \
                 VALUES ('ws','owner','thread','thread-imported','following',1,'seed',0)",
                [],
            )
            .map_err(SyncError::persist)?;
            tx.execute(
                "INSERT INTO chat_channels \
                 (workspace_id,channel_id,name,slug,kind,created_at_ms,updated_at_ms) \
                 VALUES ('ws','dm-channel','Private','private','dm',90,90)",
                [],
            )
            .map_err(SyncError::persist)?;
            tx.execute(
                "INSERT INTO chat_channel_wire_ids (workspace_id,wire_id,channel_id) \
                 VALUES ('ws','dm-wire','dm-channel')",
                [],
            )
            .map_err(SyncError::persist)?;
            tx.execute(
                "INSERT INTO chat_threads \
                 (workspace_id,thread_id,title,created_at_ms,updated_at_ms,channel_id) \
                 VALUES ('ws','dm-thread','Private',90,100,'dm-channel')",
                [],
            )
            .map_err(SyncError::persist)?;
            tx.execute(
                "INSERT INTO chat_messages \
                 (workspace_id,thread_id,message_order,message_id,author_kind,author_display_name,author_user_id,body,created_at_ms) \
                 VALUES ('ws','dm-thread',0,'dm-message','human','Private user','private-user','secret',100)",
                [],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .expect("feed visibility fixture");

    let visible = envelope(
        "read-peer",
        0,
        "chat.feed.read.set",
        json!({
            "ownerUserId": "owner",
            "lastSeenCreatedAtMs": 20,
            "lastSeenMessageId": "message-imported",
            "atMs": 30
        }),
    );
    assert!(matches!(
        apply_chat_envelope(&mut engine, &visible, &NoFaults),
        Ok(ApplyOutcome {
            primary: ApplyDisposition::Applied(_),
            refusals: ref outcome_refusals,
            sharing_declined: ref outcome_sharing_declined,
        }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
    ));
    let before: (i64, String, i64) = engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT last_seen_created_at_ms,last_seen_message_id,updated_at_ms \
                 FROM chat_feed_read_state WHERE workspace_id='ws' AND owner_user_id='owner'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
        })
        .expect("visible feed read state");

    let invisible_dm = envelope(
        "read-peer",
        1,
        "chat.feed.read.set",
        json!({
            "ownerUserId": "owner",
            "lastSeenCreatedAtMs": 100,
            "lastSeenMessageId": "dm-message",
            "atMs": 101
        }),
    );
    let result = apply_chat_envelope(&mut engine, &invisible_dm, &NoFaults);
    let after: (i64, String, i64) = engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT last_seen_created_at_ms,last_seen_message_id,updated_at_ms \
                 FROM chat_feed_read_state WHERE workspace_id='ws' AND owner_user_id='owner'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
        })
        .expect("feed read state after invisible coordinate");
    assert_eq!(
        after, before,
        "invisible content must not clear unread state"
    );
    assert_invalid_refusal!(result);
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "read-peer").expect("ack"),
        1
    );
}

#[test]
fn replicated_chat_writers_index_thread_title_message_and_redelivery_idempotently() {
    let (_scratch, _path, mut engine) = open_store();
    let thread = envelope(
        "search-peer",
        0,
        "chat.thread.create",
        json!({
            "threadId": "search-thread",
            "title": "Replicated roadmap",
            "createdAtMs": 10,
            "linkedObjectId": "search-object",
            "linkedAtMs": 10
        }),
    );
    let message = envelope(
        "search-peer",
        1,
        "chat.message.append",
        json!({
            "messageId": "search-message",
            "threadId": "search-thread",
            "authorKind": "agent",
            "authorDisplayName": "Planner",
            "body": "The synchronized quasar is visible",
            "createdAtMs": 20
        }),
    );

    assert!(matches!(
        apply_chat_envelope(&mut engine, &thread, &NoFaults),
        Ok(ApplyOutcome {
            primary: ApplyDisposition::Applied(_),
            refusals: ref outcome_refusals,
            sharing_declined: ref outcome_sharing_declined,
        }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
    ));
    assert!(matches!(
        apply_chat_envelope(&mut engine, &message, &NoFaults),
        Ok(ApplyOutcome {
            primary: ApplyDisposition::Applied(_),
            refusals: ref outcome_refusals,
            sharing_declined: ref outcome_sharing_declined,
        }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
    ));
    assert!(matches!(
        apply_chat_envelope(&mut engine, &message, &NoFaults),
        Ok(ApplyOutcome {
            primary: ApplyDisposition::Skipped,
            refusals: ref outcome_refusals,
            sharing_declined: ref outcome_sharing_declined,
        }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
    ));

    let rows: Vec<(String, String)> = engine
        .read_with(|conn| {
            let mut statement = conn.prepare(
                "SELECT message_id,text FROM engine_search_chat_messages_fts \
                 WHERE workspace_id='ws' AND thread_id='search-thread' ORDER BY message_id",
            )?;
            statement
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
                .collect::<rusqlite::Result<Vec<_>>>()
        })
        .expect("replicated chat search rows");
    assert_eq!(
        rows,
        vec![
            (
                CHAT_THREAD_HEADER_MESSAGE_ID.to_owned(),
                "Replicated roadmap".to_owned()
            ),
            (
                "search-message".to_owned(),
                "Planner\nPlanner (agent)\nThe synchronized quasar is visible".to_owned()
            )
        ],
        "replicated writers and duplicate delivery must leave exactly one row per indexed entity"
    );
}

#[test]
fn refused_chat_mutation_rolls_back_all_fts_rows() {
    let (_scratch, _path, mut engine) = open_store();
    let thread = envelope(
        "refused-search-peer",
        0,
        "chat.thread.create",
        json!({
            "threadId": "refused-search-thread",
            "title": "Must roll back",
            "createdAtMs": 10,
            "linkedObjectId": "refused-search-object",
            "linkedAtMs": 10
        }),
    );
    let outcome = apply_envelope_with(&mut engine, &thread, &NoFaults, |tx, op| {
        apply_chat_tx(tx, op)?;
        Err::<(), SyncError>(SyncError::InvalidInput {
            reason: "test refusal after chat index maintenance",
        })
    });
    assert_invalid_refusal!(outcome);

    let (thread_rows, fts_rows): (i64, i64) = engine
        .read_with(|conn| {
            Ok::<_, rusqlite::Error>((
                conn.query_row("SELECT COUNT(*) FROM chat_threads", [], |row| row.get(0))?,
                conn.query_row(
                    "SELECT COUNT(*) FROM engine_search_chat_messages_fts",
                    [],
                    |row| row.get(0),
                )?,
            ))
        })
        .expect("refusal residue counts");
    assert_eq!(thread_rows, 0, "the refused canonical write must roll back");
    assert_eq!(fts_rows, 0, "the refused FTS write must roll back");
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "refused-search-peer").expect("ack"),
        0
    );
}

#[test]
fn imported_attachment_refuses_a_message_resolved_in_another_thread_without_parking() {
    let (_scratch, _path, mut engine) = open_store();
    imported_chat_fixture(&mut engine, "attachment-cross-thread-owner");
    let other_thread = envelope(
        "attachment-cross-thread-target",
        0,
        "chat.thread.create",
        json!({
            "threadId": "attachment-other-thread",
            "title": "Other thread",
            "createdAtMs": 30,
            "linkedObjectId": "attachment-other-object",
            "linkedAtMs": 30
        }),
    );
    let other_message = envelope(
        "attachment-cross-thread-target",
        1,
        "chat.message.append",
        json!({
            "messageId": "attachment-other-message",
            "threadId": "attachment-other-thread",
            "authorKind": "human",
            "authorDisplayName": "Ada",
            "body": "Other",
            "createdAtMs": 31
        }),
    );
    apply_chat_envelope(&mut engine, &other_thread, &NoFaults).expect("other thread");
    apply_chat_envelope(&mut engine, &other_message, &NoFaults).expect("other message");
    let attachment = envelope(
        "attachment-cross-thread",
        0,
        "chat.attachment.add",
        json!({
            "attachmentId": attachment_id_for(
                "attachment-other-message",
                "object",
                None,
                None
            ),
            "threadId": "thread-imported",
            "messageId": "attachment-other-message",
            "targetKind": "file",
            "objectId": "object",
            "createdAtMs": 32
        }),
    );

    assert_invalid_refusal!(apply_chat_envelope(&mut engine, &attachment, &NoFaults));
    assert_eq!(pending_chat_coordinate_count(&engine), 0);
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "attachment-cross-thread")
            .expect("attachment refusal ack"),
        0
    );
}

#[test]
fn imported_follow_reuses_local_target_visibility_and_prevents_metadata_leaks() {
    let (_scratch, _path, mut engine) = open_store();
    imported_chat_fixture(&mut engine, "follow-fixture");
    engine
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT INTO chat_channels \
                 (workspace_id,channel_id,name,slug,kind,created_at_ms,updated_at_ms) \
                 VALUES ('ws','dm-channel','Private','private','dm',30,30)",
                [],
            )
            .map_err(SyncError::persist)?;
            tx.execute(
                "INSERT INTO chat_channel_wire_ids (workspace_id,wire_id,channel_id) \
                 VALUES ('ws','dm-wire','dm-channel')",
                [],
            )
            .map_err(SyncError::persist)?;
            tx.execute(
                "INSERT INTO chat_threads \
                 (workspace_id,thread_id,title,created_at_ms,updated_at_ms,channel_id) \
                 VALUES ('ws','dm-thread','Private',30,30,'dm-channel')",
                [],
            )
            .map_err(SyncError::persist)?;
            tx.execute(
                "INSERT INTO chat_messages \
                 (workspace_id,thread_id,message_order,message_id,author_kind,author_display_name,author_user_id,body,created_at_ms) \
                 VALUES ('ws','dm-thread',0,'dm-only-message','human','Private user','dm-only-user','secret',30)",
                [],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .expect("DM follow fixture");

    for (origin, target_kind, target_id) in [
        ("follow-dm-channel", "channel", "dm-wire"),
        ("follow-dm-thread", "thread", "dm-thread"),
    ] {
        let operation = envelope(
            origin,
            0,
            "chat.follow.set",
            json!({
                "ownerUserId": "owner",
                "targetKind": target_kind,
                "targetId": target_id,
                "state": "following",
                "atMs": 40
            }),
        );
        assert_invalid_refusal!(apply_chat_envelope(&mut engine, &operation, &NoFaults));
        assert_eq!(
            read_replication_acked_seq(&engine, "ws", origin).expect("follow refusal ack"),
            0
        );
    }
    let dm_only_person = envelope(
        "follow-dm-person",
        0,
        "chat.follow.set",
        json!({
            "ownerUserId": "owner",
            "targetKind": "person",
            "targetId": "dm-only-user",
            "state": "following",
            "atMs": 40
        }),
    );
    assert_eq!(
        apply_chat_envelope(&mut engine, &dm_only_person, &NoFaults)
            .expect("park DM-only person follow"),
        ApplyOutcome::new(ApplyDisposition::Applied(Vec::new()))
    );
    let unresolved = envelope(
        "follow-fabricated-channel",
        0,
        "chat.follow.set",
        json!({
            "ownerUserId": "owner",
            "targetKind": "channel",
            "targetId": "fabricated-dm-wire",
            "state": "following",
            "atMs": 40
        }),
    );
    assert_eq!(
        apply_chat_envelope(&mut engine, &unresolved, &NoFaults).expect("park unresolved follow"),
        ApplyOutcome::new(ApplyDisposition::Applied(Vec::new()))
    );
    assert_eq!(pending_chat_coordinate_count(&engine), 2);
    let leaked = LinkedChatStore::new(&mut engine)
        .list_follows("ws", "owner", None)
        .expect("list follows");
    assert!(
        leaked.is_empty(),
        "unvalidated target ids must not appear in list_follows"
    );
}
#[test]
fn imported_attachment_recomputes_id_and_rejects_mismatch() {
    let (_scratch, _path, mut engine) = open_store();
    let invalid = envelope(
        "hostile-attachment",
        0,
        "chat.attachment.add",
        json!({
            "attachmentId": "forged",
            "threadId": "thread",
            "messageId": "message",
            "targetKind": "file",
            "objectId": "object",
            "createdAtMs": 10
        }),
    );
    let result = apply_chat_envelope(&mut engine, &invalid, &NoFaults);
    assert_invalid_refusal!(result);
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "hostile-attachment").expect("ack"),
        0,
        "trust the peer's attachment id -> forged content identity is persisted and acked.",
    );
}

#[test]
fn imported_attachment_rejects_invalid_heading_and_bounds() {
    let cases = [
        ("heading_triplet_partial", json!({"headingText":"Heading"})),
        (
            "heading_requires_object",
            json!({"headingText":"Heading","headingAnchor":"anchor","headingOccurrence":0}),
        ),
        (
            "heading_text_bound",
            json!({"objectId":"object","headingText":"x".repeat(301),"headingAnchor":"anchor","headingOccurrence":0}),
        ),
        (
            "heading_control_character",
            json!({"objectId":"object","headingText":"bad\u{0007}","headingAnchor":"anchor","headingOccurrence":0}),
        ),
        (
            "heading_occurrence_nonnegative",
            json!({"objectId":"object","headingText":"Heading","headingAnchor":"anchor","headingOccurrence":-1}),
        ),
        (
            "path_must_be_normalized",
            json!({"objectId":"object","pathHint":"notes/./file.md"}),
        ),
        (
            "heading_anchor_bound",
            json!({"objectId":"object","headingText":"Heading","headingAnchor":"a".repeat(401),"headingOccurrence":0}),
        ),
        ("object_id_bound", json!({"objectId":"o".repeat(201)})),
        (
            "created_at_ms_bound",
            json!({"objectId":"object","createdAtMs": i64::MAX}),
        ),
    ];
    for (case, fields) in cases {
        let (_scratch, _path, mut engine) = open_store();
        let mut payload = json!({
            "attachmentId": "placeholder",
            "threadId": "thread",
            "messageId": "message",
            "targetKind": "file",
            "createdAtMs": 10
        });
        payload
            .as_object_mut()
            .expect("payload")
            .extend(fields.as_object().expect("fields").clone());
        if let Some(object_id) = payload.get("objectId").and_then(serde_json::Value::as_str) {
            let heading_anchor = payload
                .get("headingAnchor")
                .and_then(serde_json::Value::as_str);
            let occurrence = payload
                .get("headingOccurrence")
                .and_then(serde_json::Value::as_i64);
            payload["attachmentId"] = json!(attachment_id_for(
                "message",
                object_id,
                heading_anchor,
                occurrence
            ));
        }
        let operation = envelope(case, 0, "chat.attachment.add", payload);
        let result = apply_chat_envelope(&mut engine, &operation, &NoFaults);
        assert!(
            matches!(
                &result,
                Ok(ApplyOutcome {
                    primary: ApplyDisposition::Refused(ReplicationRefusal {
                        reason: RefusalReason::InvalidInput { .. },
                        ..
                    }),
                    refusals: outcome_refusals,
                    sharing_declined: outcome_sharing_declined,
                }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
            ),
            "case {case}"
        );
    }
}

/// #5b (feed-read ranking): a delayed older read receipt with a newer wall clock
/// must not move the read cursor backwards.
#[test]
fn feed_read_older_cursor_with_newer_clock_does_not_regress() {
    let (_scratch, _path, mut engine) = open_store();
    imported_chat_fixture(&mut engine, "feed-rank-fixture");
    engine
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT INTO chat_messages \
                 (workspace_id,thread_id,message_order,message_id,author_kind,author_display_name,body,created_at_ms) \
                 VALUES ('ws','thread-imported',1,'m1','human','Ada','Older',50), \
                        ('ws','thread-imported',2,'m2','human','Ada','Ahead',100)",
                [],
            )
            .map_err(SyncError::persist)?;
            tx.execute(
                "INSERT INTO chat_follows \
                 (workspace_id,owner_user_id,target_kind,target_id,state,updated_at_ms,origin_id,origin_seq) \
                 VALUES ('ws','u','thread','thread-imported','following',1,'seed',0)",
                [],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .expect("visible feed coordinates");
    let ahead = envelope(
        "peer",
        0,
        "chat.feed.read.set",
        json!({"ownerUserId":"u","lastSeenCreatedAtMs":100,"lastSeenMessageId":"m2","atMs":10}),
    );
    assert!(matches!(
        apply_chat_envelope(&mut engine, &ahead, &NoFaults),
        Ok(ApplyOutcome {
            primary: ApplyDisposition::Applied(_),
            refusals: ref outcome_refusals,
            sharing_declined: ref outcome_sharing_declined,
        }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
    ));
    // Older read position (50 < 100) but a newer clock (20 > 10).
    let behind = envelope(
        "peer",
        1,
        "chat.feed.read.set",
        json!({"ownerUserId":"u","lastSeenCreatedAtMs":50,"lastSeenMessageId":"m1","atMs":20}),
    );
    assert!(matches!(
        apply_chat_envelope(&mut engine, &behind, &NoFaults),
        Ok(ApplyOutcome {
            primary: ApplyDisposition::Applied(_),
            refusals: ref outcome_refusals,
            sharing_declined: ref outcome_sharing_declined,
        }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
    ));
    let last_seen: i64 = engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT last_seen_created_at_ms FROM chat_feed_read_state WHERE workspace_id='ws' AND owner_user_id='u'",
                [],
                |row| row.get(0),
            )
            .map_err(SyncError::corrupt)
        })
        .expect("feed read state");
    assert_eq!(
        last_seen, 100,
        "a newer-clock older read must not move the cursor back"
    );
}

/// #5c (reserved agent-channel): the agent kind/name/slug hold iff the reserved
/// agent wire id is present; malformed shapes are rejected, a correct one applies.
#[test]
fn reserved_agent_channel_shapes_rejected() {
    let (_scratch, _path, mut engine) = open_store();
    // kind=agent but a non-agent wire id -> rejected.
    let rogue_agent = envelope(
        "rogue-agent-peer",
        0,
        "chat.channel.create",
        json!({"channelId":"c1","name":"My agent","slug":"my-agent","kind":"agent","createdAtMs":1,"wireId":"wire-not-agent"}),
    );
    assert_invalid_refusal!(apply_chat_envelope(&mut engine, &rogue_agent, &NoFaults));
    // A normal channel squatting the reserved name is also retired as a
    // refusal under its own origin.
    let name_squat = envelope(
        "squat-peer",
        0,
        "chat.channel.create",
        json!({"channelId":"c2","name":"My agent","slug":"reserved-name","kind":"channel","createdAtMs":1}),
    );
    assert_invalid_refusal!(apply_chat_envelope(&mut engine, &name_squat, &NoFaults));
    // The canonical agent channel (agent kind + reserved wire id + reserved
    // name + canonical slug) applies.
    let canonical = envelope(
        "peer",
        0,
        "chat.channel.create",
        json!({
            "channelId":"c-agent","name": AGENT_CHANNEL_NAME,
            "slug": channel_slug_for_name(AGENT_CHANNEL_NAME),
            "kind":"agent","createdAtMs":1,"wireId": AGENT_CHANNEL_WIRE_ID
        }),
    );
    assert!(matches!(
        apply_chat_envelope(&mut engine, &canonical, &NoFaults),
        Ok(ApplyOutcome {
            primary: ApplyDisposition::Applied(_),
            refusals: ref outcome_refusals,
            sharing_declined: ref outcome_sharing_declined,
        }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
    ));
}

/// A thread whose agent's wire id maps to a group is refused, and the next op
/// from its device still applies.
#[test]
fn a_thread_for_an_agent_wire_id_that_maps_to_a_group_is_refused() {
    let (_scratch, _path, mut engine) = open_store();
    engine
        .write_with(&NoFaults, |tx| {
            tx.execute_batch(
                "INSERT INTO chat_channels \
                 (workspace_id, channel_id, name, slug, kind, created_at_ms, updated_at_ms) \
                 VALUES ('ws', 'group', 'Group', 'group', 'channel', 1, 1); \
                 INSERT INTO chat_channel_wire_ids (workspace_id, wire_id, channel_id) \
                 VALUES ('ws', 'channel_wire_agent_v1_codex', 'group');",
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .expect("a group mapped from codex's wire id");
    let refused = envelope(
        "device-a",
        0,
        "chat.thread.create",
        json!({
            "threadId": "codex-thread", "title": "Codex", "createdAtMs": 20,
            "channelSlug": "my-agent-codex", "channelWireId": "channel_wire_agent_v1_codex"
        }),
    );
    assert_invalid_refusal!(apply_chat_envelope(&mut engine, &refused, &NoFaults));
    let next = envelope(
        "device-a",
        1,
        "chat.thread.create",
        json!({
            "threadId": "group-thread", "title": "Group", "createdAtMs": 21, "channelSlug": "group"
        }),
    );
    assert_eq!(
        apply_chat_envelope(&mut engine, &next, &NoFaults).expect("the next thread"),
        ApplyOutcome::new(ApplyDisposition::Applied(Vec::new()))
    );
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "device-a").expect("ack"),
        1
    );
}

/// An earlier build's group named "My agent notes".
fn seed_notes_group(engine: &mut EngineStore) {
    engine
        .write_with(&NoFaults, |tx| {
            tx.execute_batch(
                "INSERT INTO chat_channels \
                 (workspace_id, channel_id, name, slug, kind, created_at_ms, updated_at_ms) \
                 VALUES ('ws', 'notes-group', 'My agent notes', 'my-agent-notes', 'channel', 1, 1)",
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .expect("an earlier build's group");
}

fn name_and_slug(engine: &EngineStore, channel_id: &str) -> (String, String) {
    engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT name, slug FROM chat_channels WHERE workspace_id = 'ws' AND channel_id = ?1",
                [channel_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
        })
        .expect("the chat")
}

fn moved_notes_group() -> (String, String) {
    (
        "My agent notes".to_owned(),
        dohc_engine_domain::chats::channel_collision_slug("my-agent-notes", "notes-group", 0),
    )
}

/// Start a thread in `channel_id` and return the thread create it journaled.
fn journaled_thread(engine: &mut EngineStore, channel_id: &str) -> ReplicationEnvelope {
    LinkedChatStore::new(engine)
        .start_channel_thread(
            &StartChannelThread {
                automation: None,
                workspace_id: "ws".to_owned(),
                channel_id: channel_id.to_owned(),
                thread_id: "notes-thread".to_owned(),
                message_id: "notes-message".to_owned(),
                title: None,
                lane: ChatThreadLane::Posts,
                own_thread: false,
                author_kind: ChatActorKind::Human,
                author_display_name: "Ada".to_owned(),
                author_owner_display_name: None,
                author_user_id: Some("ada".to_owned()),
                origin: None,
                body: "Can you tidy these?".to_owned(),
                needs_decision: false,
                options: Vec::new(),
                attachments: Vec::new(),
                author_agent_id: None,
                author_reported: None,
                work: None,
                wake_agent_ids: Vec::new(),
                now_ms: 20,
                request_id: Some("notes-request".to_owned()),
            },
            &NoFaults,
        )
        .expect("a thread in the notes agent's chat");
    engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT origin_id, origin_seq, payload_json, recorded_at_ms \
                 FROM replication_log \
                 WHERE workspace_id = 'ws' AND op_kind = 'chat.thread.create' \
                   AND json_extract(payload_json, '$.threadId') = 'notes-thread'",
                [],
                |row| {
                    let payload_json: String = row.get(2)?;
                    Ok(ReplicationEnvelope {
                        settlement_admission: None,
                        admitted_author_snapshot: None,
                        workspace_id: "ws".to_owned(),
                        origin_id: row.get(0)?,
                        origin_seq: row.get(1)?,
                        op_kind: "chat.thread.create".to_owned(),
                        payload: serde_json::from_str(&payload_json).map_err(|error| {
                            rusqlite::Error::FromSqlConversionFailure(
                                payload_json.len(),
                                rusqlite::types::Type::Text,
                                Box::new(error),
                            )
                        })?,
                        recorded_at_ms: row.get(3)?,
                        relay_seq: None,
                    })
                },
            )
        })
        .expect("the journaled thread")
}

/// Two computers hold an earlier build's group named "My agent notes". The
/// notes agent's chat arrives here before this computer makes it, takes its
/// agent's slug, and the group moves off it. A thread made here in the chat
/// reaches the other computer, whose hidden copy of the chat does the same.
#[test]
fn an_agent_chat_from_sync_takes_its_slug_from_a_group() {
    let (_scratch, _path, mut engine) = open_store();
    seed_notes_group(&mut engine);
    let create = envelope(
        "device-a",
        0,
        "chat.channel.create",
        json!({
            "channelId": "notes-chat", "name": "Notes", "slug": "my-agent-notes",
            "kind": "agent", "createdAtMs": 5, "wireId": "channel_wire_agent_v1_notes"
        }),
    );
    apply_chat_envelope(&mut engine, &create, &NoFaults).expect("the notes agent's chat");
    assert_eq!(
        name_and_slug(&engine, "notes-chat"),
        ("Notes".to_owned(), "my-agent-notes".to_owned())
    );
    assert_eq!(name_and_slug(&engine, "notes-group"), moved_notes_group());

    let thread = journaled_thread(&mut engine, "notes-chat");
    let (_peer_scratch, _peer_path, mut peer) = open_store();
    seed_notes_group(&mut peer);
    assert_eq!(
        apply_chat_envelope(&mut peer, &thread, &NoFaults).expect("the other computer"),
        ApplyOutcome::new(ApplyDisposition::Applied(Vec::new()))
    );
    let peer_chat: (String, String) = peer
        .read_with(|conn| {
            conn.query_row(
                "SELECT kind, slug FROM chat_channels WHERE workspace_id = 'ws' AND agent_id = 'notes'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
        })
        .expect("the other computer's hidden chat");
    assert_eq!(peer_chat, ("agent".to_owned(), "my-agent-notes".to_owned()));
    assert_eq!(name_and_slug(&peer, "notes-group"), moved_notes_group());
}

/// A name from another device reaches chat without characters that hide or
/// reorder text, for a person, an agent and the person it acts for, a
/// reaction, and a post that waited for its thread. Joining characters and
/// variation selectors stay.
#[test]
fn imported_chat_names_drop_characters_that_hide_or_reorder_text() {
    let (_scratch, _path, mut engine) = open_store();
    imported_chat_fixture(&mut engine, "peer");
    let posts = [
        (
            3,
            "person",
            "human",
            "Ana\u{202E}lisa",
            None,
            "thread-imported",
        ),
        (
            4,
            "agent",
            "agent",
            "No\u{200B}va\u{2066}",
            Some("Sam\u{0007}"),
            "thread-imported",
        ),
        (
            5,
            "joined",
            "human",
            "Ali\u{200C}reza 👩\u{200D}💻 ❤\u{FE0F}",
            None,
            "thread-imported",
        ),
        (
            6,
            "parked",
            "agent",
            "\u{3164}Sc\u{2028}out",
            Some("A\u{2069}da"),
            "late-thread",
        ),
    ];
    for (seq, id, author_kind, name, owner, thread_id) in posts {
        let mut payload = json!({
            "messageId": id, "threadId": thread_id, "authorKind": author_kind,
            "authorDisplayName": name, "body": "Hi", "createdAtMs": 30
        });
        if let Some(owner) = owner {
            payload["authorOwnerDisplayName"] = json!(owner);
        }
        apply_chat_envelope(
            &mut engine,
            &envelope("peer", seq, "chat.message.append", payload),
            &NoFaults,
        )
        .expect("a post with such a name applies");
    }
    let reaction = envelope(
        "peer",
        7,
        "chat.reaction.set",
        json!({
            "reactionId": "reaction-hidden", "messageId": "person", "threadId": "thread-imported",
            "emoji": "👍", "authorId": "ana", "authorKind": "human",
            "authorDisplayName": "Ana\u{2067}lisa", "atMs": 40, "state": "added"
        }),
    );
    apply_chat_envelope(&mut engine, &reaction, &NoFaults).expect("reaction");
    let thread = envelope(
        "late-thread-peer",
        0,
        "chat.thread.create",
        json!({ "threadId": "late-thread", "title": "Late thread", "createdAtMs": 20, "channelSlug": "imported" }),
    );
    apply_chat_envelope(&mut engine, &thread, &NoFaults).expect("thread");
    assert_eq!(pending_chat_coordinate_count(&engine), 0);
    let name = |id: &str| -> (String, Option<String>) {
        engine
            .read_with(|conn| {
                conn.query_row(
                    "SELECT author_display_name, author_owner_display_name FROM chat_messages WHERE message_id = ?1",
                    [id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .map_err(dohc_engine_storage::StorageError::corrupt_public)
            })
            .expect("stored post")
    };
    assert_eq!(name("person"), ("Analisa".to_owned(), None));
    assert_eq!(name("agent"), ("Nova".to_owned(), Some("Sam".to_owned())));
    assert_eq!(
        name("joined"),
        ("Ali\u{200C}reza 👩\u{200D}💻 ❤\u{FE0F}".to_owned(), None)
    );
    assert_eq!(name("parked"), ("Scout".to_owned(), Some("Ada".to_owned())));
    let reacted: String = engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT author_display_name FROM chat_reactions WHERE reaction_id = 'reaction-hidden'",
                [],
                |row| row.get(0),
            )
            .map_err(dohc_engine_storage::StorageError::corrupt_public)
        })
        .expect("stored reaction");
    assert_eq!(reacted, "Analisa");

    // A name with nothing visible left is no name, for a post and for the
    // person an agent posts for.
    for (seq, name, owner) in [
        (8, "\u{200B}\u{3164}", None),
        (9, "\u{200C}", None),
        (10, "\u{200D}\u{FE0F}", None),
        (11, " \u{E0100} ", None),
        (12, "Nova", Some("\u{200D}")),
    ] {
        let author_kind = if owner.is_some() { "agent" } else { "human" };
        let mut payload = json!({
            "messageId": format!("blank-{seq}"), "threadId": "thread-imported",
            "authorKind": author_kind, "authorDisplayName": name, "body": "Hi", "createdAtMs": 31
        });
        if let Some(owner) = owner {
            payload["authorOwnerDisplayName"] = json!(owner);
        }
        let blank = envelope("peer", seq, "chat.message.append", payload);
        assert_invalid_refusal!(apply_chat_envelope(&mut engine, &blank, &NoFaults));
    }
}

#[test]
fn received_and_parked_messages_wake_no_agent_here() {
    let (_scratch, _path, mut engine) = open_store();
    imported_chat_fixture(&mut engine, "peer");
    applied_claims(apply_chat_envelope(
        &mut engine,
        &group_message(
            "peer",
            3,
            "received-old",
            "thread-imported",
            "human",
            "@agent",
        ),
        &NoFaults,
    ));
    applied_claims(apply_chat_envelope(
        &mut engine,
        &group_message(
            "parked-peer",
            0,
            "parked-old",
            "late-thread",
            "human",
            "@agent",
        ),
        &NoFaults,
    ));
    assert_eq!(pending_chat_coordinate_count(&engine), 1);
    applied_claims(apply_chat_envelope(
        &mut engine,
        &envelope(
            "late-thread-peer",
            0,
            "chat.thread.create",
            json!({
                "threadId": "late-thread", "title": "Late thread", "createdAtMs": 25,
                "channelSlug": "imported", "channelWireId": "channel-imported",
            }),
        ),
        &NoFaults,
    ));
    assert_eq!(pending_chat_coordinate_count(&engine), 0);
    let counts: (i64, i64) = engine.read_with(|conn| {
        Ok::<_, dohc_engine_storage::StorageError>((
            conn.query_row("SELECT COUNT(*) FROM chat_messages WHERE workspace_id='ws' AND message_id IN ('received-old','parked-old')", [], |row| row.get(0))
                .map_err(dohc_engine_storage::StorageError::corrupt_public)?,
            conn.query_row("SELECT COUNT(*) FROM chat_dispatch_ledger WHERE workspace_id='ws'", [], |row| row.get(0))
                .map_err(dohc_engine_storage::StorageError::corrupt_public)?,
        ))
    }).unwrap();
    assert_eq!(
        counts,
        (2, 0),
        "only the sender's computer records a request"
    );
}

/// An agent message that arrives before its thread keeps its work report when
/// it replays. A build that did not know the field parked any value, so
/// replay checks it and refuses a bad one instead of failing the thread.
#[test]
fn a_parked_agent_message_keeps_its_work_report_and_a_bad_parked_report_is_refused() {
    use dohc_engine_domain::{ChatWorkReport, ChatWorkStatus, LinkedChatStore};
    let channel = envelope(
        "channel-peer",
        0,
        "chat.channel.create",
        json!({"channelId": "channel-1", "name": "General", "slug": "general", "kind": "channel", "createdAtMs": 10}),
    );
    let message = envelope(
        "message-peer",
        0,
        "chat.message.append",
        json!({
            "messageId": "message-1",
            "threadId": "thread-1",
            "authorKind": "agent",
            "authorDisplayName": "Nova",
            "authorOwnerDisplayName": "Ice",
            "body": "Opened a PR",
            "createdAtMs": 20,
            "work": {"status": "done"},
        }),
    );
    let thread = envelope(
        "thread-peer",
        0,
        "chat.thread.create",
        json!({"threadId": "thread-1", "title": "", "createdAtMs": 20, "channelSlug": "general", "channelWireId": "channel-1"}),
    );
    let park = |engine: &mut EngineStore| {
        for op in [&channel, &message] {
            assert_eq!(
                apply_chat_envelope(engine, op, &NoFaults).expect("apply or park"),
                ApplyOutcome::new(ApplyDisposition::Applied(Vec::new()))
            );
        }
    };
    let stored = |engine: &EngineStore| -> i64 {
        engine
            .read_with(|conn| {
                conn.query_row(
                    "SELECT COUNT(*) FROM chat_messages WHERE message_id = 'message-1'",
                    [],
                    |row| row.get(0),
                )
                .map_err(dohc_engine_storage::StorageError::corrupt_public)
            })
            .expect("count messages")
    };

    let (_scratch, _path, mut engine) = open_store();
    park(&mut engine);
    assert_eq!(stored(&engine), 0, "the message waits for its thread");
    assert_eq!(
        apply_chat_envelope(&mut engine, &thread, &NoFaults).expect("thread"),
        ApplyOutcome::new(ApplyDisposition::Applied(Vec::new()))
    );
    assert_eq!(
        LinkedChatStore::new(&mut engine)
            .get_message("ws", "message-1")
            .expect("replayed message")
            .work,
        Some(ChatWorkReport {
            status: ChatWorkStatus::Done,
            url: None,
        })
    );

    for bad in [
        json!({"status": "paused"}),
        json!({"status": "done", "url": "ftp://example.com"}),
        json!("done"),
        json!(42),
    ] {
        let (_scratch, _path, mut engine) = open_store();
        park(&mut engine);
        engine
            .write_with(&NoFaults, |tx| {
                tx.execute(
                    "UPDATE replication_log \
                     SET payload_json=json_set(payload_json,'$.work',json(?1)) \
                     WHERE origin_id='message-peer' AND origin_seq=0",
                    [bad.to_string()],
                )
                .map_err(SyncError::persist)?;
                Ok::<_, SyncError>(())
            })
            .expect("park the report an older build kept");
        let ApplyOutcome {
            primary,
            refusals,
            sharing_declined,
        } = apply_chat_envelope(&mut engine, &thread, &NoFaults).expect("thread applies");
        assert!(sharing_declined.is_empty());
        assert_eq!(primary, ApplyDisposition::Applied(Vec::new()), "{bad}");
        assert_eq!(
            refusals,
            vec![ReplicationRefusal {
                workspace_id: "ws".to_owned(),
                origin_id: "message-peer".to_owned(),
                origin_seq: 0,
                op_kind: "chat.message.append".to_owned(),
                reason: RefusalReason::InvalidInput {
                    reason: "pending chat message work report is invalid".to_owned(),
                },
            }],
            "{bad}"
        );
        assert_eq!(stored(&engine), 0, "{bad}");
    }
}

/// An agent message that arrives before its thread keeps its report when it
/// replays. A build that did not know the field parked any value, so replay
/// checks it and refuses a bad one instead of failing the thread.
#[test]
fn a_parked_agent_message_keeps_its_report_and_a_bad_parked_report_is_refused() {
    use dohc_engine_domain::{ChatReportedAgent, LinkedChatStore};
    let channel = envelope(
        "channel-peer",
        0,
        "chat.channel.create",
        json!({"channelId": "channel-1", "name": "General", "slug": "general", "kind": "channel", "createdAtMs": 10}),
    );
    let message = envelope(
        "message-peer",
        0,
        "chat.message.append",
        json!({
            "messageId": "message-1",
            "threadId": "thread-1",
            "authorKind": "agent",
            "authorDisplayName": "Nova",
            "authorOwnerDisplayName": "Ice",
            "body": "Opened a PR",
            "createdAtMs": 20,
            "authorReported": {"product": "Claude Code", "version": "2.1"},
        }),
    );
    let thread = envelope(
        "thread-peer",
        0,
        "chat.thread.create",
        json!({"threadId": "thread-1", "title": "", "createdAtMs": 20, "channelSlug": "general", "channelWireId": "channel-1"}),
    );
    let park = |engine: &mut EngineStore| {
        for op in [&channel, &message] {
            assert_eq!(
                apply_chat_envelope(engine, op, &NoFaults).expect("apply or park"),
                ApplyOutcome::new(ApplyDisposition::Applied(Vec::new()))
            );
        }
    };
    let stored = |engine: &EngineStore| -> i64 {
        engine
            .read_with(|conn| {
                conn.query_row(
                    "SELECT COUNT(*) FROM chat_messages WHERE message_id = 'message-1'",
                    [],
                    |row| row.get(0),
                )
                .map_err(dohc_engine_storage::StorageError::corrupt_public)
            })
            .expect("count messages")
    };

    let (_scratch, _path, mut engine) = open_store();
    park(&mut engine);
    assert_eq!(stored(&engine), 0, "the message waits for its thread");
    assert_eq!(
        apply_chat_envelope(&mut engine, &thread, &NoFaults).expect("thread"),
        ApplyOutcome::new(ApplyDisposition::Applied(Vec::new()))
    );
    assert_eq!(
        LinkedChatStore::new(&mut engine)
            .get_message("ws", "message-1")
            .expect("replayed message")
            .author_reported,
        Some(ChatReportedAgent {
            product: Some("Claude Code".to_owned()),
            version: Some("2.1".to_owned()),
            model: None,
        })
    );

    for bad in [
        json!({"product": "\u{FEFF}Claude Code"}),
        json!({"version": "2.1"}),
        json!("Claude Code"),
        json!(42),
    ] {
        let (_scratch, _path, mut engine) = open_store();
        park(&mut engine);
        engine
            .write_with(&NoFaults, |tx| {
                tx.execute(
                    "UPDATE replication_log \
                     SET payload_json=json_set(payload_json,'$.authorReported',json(?1)) \
                     WHERE origin_id='message-peer' AND origin_seq=0",
                    [bad.to_string()],
                )
                .map_err(SyncError::persist)?;
                Ok::<_, SyncError>(())
            })
            .expect("park the report an older build kept");
        let ApplyOutcome {
            primary,
            refusals,
            sharing_declined,
        } = apply_chat_envelope(&mut engine, &thread, &NoFaults).expect("thread applies");
        assert!(sharing_declined.is_empty());
        assert_eq!(primary, ApplyDisposition::Applied(Vec::new()), "{bad}");
        assert_eq!(
            refusals,
            vec![ReplicationRefusal {
                workspace_id: "ws".to_owned(),
                origin_id: "message-peer".to_owned(),
                origin_seq: 0,
                op_kind: "chat.message.append".to_owned(),
                reason: RefusalReason::InvalidInput {
                    reason: "pending chat message reported agent is invalid".to_owned(),
                },
            }],
            "{bad}"
        );
        assert_eq!(stored(&engine), 0, "{bad}");
    }
}

/// A build that did not know `agentConnectionId` parked it unchecked. Replay
/// keeps a good one on a link message, and refuses one on another message or
/// one not in its stored form instead of failing the thread.
#[test]
fn a_parked_agent_connection_stays_on_a_link_message_and_a_bad_one_is_refused() {
    use dohc_engine_domain::{ChatMessageLinkAuthor, LinkedChatStore};

    // Parks `message` before its thread exists, then plants `connection`
    // in its payload as an older build kept it.
    fn park(engine: &mut EngineStore, message: &ReplicationEnvelope, connection: &str) {
        imported_chat_fixture(engine, "peer");
        assert_eq!(
            apply_chat_envelope(engine, message, &NoFaults).expect("park"),
            ApplyOutcome::new(ApplyDisposition::Applied(Vec::new()))
        );
        assert_eq!(pending_chat_coordinate_count(engine), 1);
        engine
            .write_with(&NoFaults, |tx| {
                tx.execute(
                    "UPDATE replication_log \
                     SET payload_json=json_set(payload_json,'$.agentConnectionId',?1) \
                     WHERE origin_id=?2 AND origin_seq=0",
                    params![connection, message.origin_id],
                )
                .map_err(SyncError::persist)?;
                Ok::<_, SyncError>(())
            })
            .expect("park the connection an older build kept");
    }

    let thread = envelope(
        "late-thread-peer",
        0,
        "chat.thread.create",
        json!({
            "threadId": "late-thread",
            "title": "Late thread",
            "createdAtMs": 20,
            "channelSlug": "imported"
        }),
    );
    let mut link_payload = link_message_payload("link-message:parked", "Early");
    link_payload["threadId"] = json!("late-thread");
    let link = envelope(LINK_ORIGIN, 0, "chat.message.append", link_payload);
    let human = envelope(
        "message-peer",
        0,
        "chat.message.append",
        json!({
            "messageId": "parked",
            "threadId": "late-thread",
            "authorKind": "human",
            "authorDisplayName": "Ada",
            "body": "Early",
            "createdAtMs": 30
        }),
    );
    let stored = |engine: &EngineStore| -> i64 {
        engine
            .read_with(|conn| {
                conn.query_row(
                    "SELECT COUNT(*) FROM chat_messages WHERE thread_id = 'late-thread'",
                    [],
                    |row| row.get(0),
                )
                .map_err(dohc_engine_storage::StorageError::corrupt_public)
            })
            .expect("count messages")
    };

    let (_scratch, _path, mut engine) = open_store();
    park(&mut engine, &link, "connection-1");
    assert_eq!(
        apply_chat_envelope(&mut engine, &thread, &NoFaults).expect("thread"),
        ApplyOutcome::new(ApplyDisposition::Applied(Vec::new()))
    );
    assert_eq!(
        LinkedChatStore::new(&mut engine)
            .get_message("ws", "link-message:parked")
            .expect("replayed link message")
            .link_author,
        Some(ChatMessageLinkAuthor {
            grant_id: "grant-1".to_owned(),
            principal_id: "principal-1".to_owned(),
            agent_connection_id: Some("connection-1".to_owned()),
        })
    );

    for (message, bad) in [
        (&human, "connection-1"),
        (&link, " connection-1"),
        (&link, "connection-\u{1}"),
    ] {
        let (_scratch, _path, mut engine) = open_store();
        park(&mut engine, message, bad);
        let ApplyOutcome {
            primary,
            refusals,
            sharing_declined,
        } = apply_chat_envelope(&mut engine, &thread, &NoFaults).expect("thread applies");
        assert!(sharing_declined.is_empty());
        assert_eq!(primary, ApplyDisposition::Applied(Vec::new()), "{bad:?}");
        assert_eq!(
            refusals,
            vec![ReplicationRefusal {
                workspace_id: "ws".to_owned(),
                origin_id: message.origin_id.clone(),
                origin_seq: 0,
                op_kind: "chat.message.append".to_owned(),
                reason: RefusalReason::InvalidInput {
                    reason: "pending chat message link author is invalid".to_owned(),
                },
            }],
            "{bad:?}"
        );
        assert_eq!(stored(&engine), 0, "{bad:?}");
    }
}
