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
fn imported_decision_refuses_unsafe_at_ms_without_row_and_acks() {
    let (_scratch, _path, mut engine) = open_store();
    let operation = envelope(
        "unsafe-decision-time",
        0,
        "chat.decision.set",
        decision_payload("open", i64::MAX, None),
    );

    assert_invalid_refusal!(apply_chat_envelope(&mut engine, &operation, &NoFaults));
    let row_count: i64 = engine
        .read_with(|conn| {
            conn.query_row("SELECT COUNT(*) FROM chat_decisions", [], |row| row.get(0))
                .map_err(dohc_engine_storage::StorageError::corrupt_public)
        })
        .expect("decision row count");
    assert_eq!(
        row_count, 0,
        "dropping the persisted-safe atMs bound journals a decision that the cross-engine read contract cannot represent."
    );
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "unsafe-decision-time").expect("ack"),
        0
    );
}

#[test]
fn imported_decision_refuses_an_explicit_null_resolver() {
    let (_scratch, _path, mut engine) = open_store();
    let mut payload = decision_payload("resolved", 100, None);
    payload["resolvedByMessageId"] = serde_json::Value::Null;
    let operation = envelope("null-decision-resolver", 0, "chat.decision.set", payload);

    assert_invalid_refusal!(apply_chat_envelope(&mut engine, &operation, &NoFaults));
    let row_count: i64 = engine
        .read_with(|conn| {
            conn.query_row("SELECT COUNT(*) FROM chat_decisions", [], |row| row.get(0))
                .map_err(dohc_engine_storage::StorageError::corrupt_public)
        })
        .expect("decision row count");
    assert_eq!(row_count, 0);
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "null-decision-resolver").expect("ack"),
        0
    );
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
fn local_only_decision_resolver_producer_converges_through_apply() {
    let (_source_scratch, _source_path, mut source) = open_store();
    LinkedChatStore::new(&mut source)
        .create_channel(
            "ws",
            "decision-channel",
            "Decisions",
            ChatChannelKind::Channel,
            10,
            &NoFaults,
        )
        .expect("source channel");
    LinkedChatStore::new(&mut source)
        .start_channel_thread(
            &StartChannelThread {
                workspace_id: "ws".to_owned(),
                channel_id: "decision-channel".to_owned(),
                thread_id: "decision-thread".to_owned(),
                message_id: "decision-message".to_owned(),
                title: None,
                lane: ChatThreadLane::Posts,
                author_kind: ChatActorKind::Human,
                author_display_name: "Verified".to_owned(),
                author_user_id: Some("verified-user".to_owned()),
                origin: None,
                body: "Choose a launch date".to_owned(),
                needs_decision: true,
                attachments: Vec::new(),
                now_ms: 20,
                request_id: Some("decision-thread".to_owned()),
            },
            &NoFaults,
        )
        .expect("source decision");
    LinkedChatStore::new(&mut source)
        .send_message(
            &SendMessage {
                workspace_id: "ws".to_owned(),
                thread_id: "decision-thread".to_owned(),
                message_id: "local-resolver".to_owned(),
                author_kind: ChatActorKind::Human,
                author_display_name: "Local".to_owned(),
                author_user_id: None,
                parent_message_id: None,
                origin: None,
                body: "Resolve while signed out".to_owned(),
                needs_decision: false,
                attachments: Vec::new(),
                now_ms: 30,
                request_id: Some("local-resolver".to_owned()),
            },
            &NoFaults,
        )
        .expect("local-only resolver");
    let source_decision = LinkedChatStore::new(&mut source)
        .resolve_decision(
            &ResolveDecision {
                workspace_id: "ws".to_owned(),
                thread_id: "decision-thread".to_owned(),
                message_id: "decision-message".to_owned(),
                resolved_by_message_id: "local-resolver".to_owned(),
                now_ms: 40,
                request_id: "resolve-with-local-message".to_owned(),
            },
            &NoFaults,
        )
        .expect("resolve source decision");
    assert_eq!(
        source_decision.resolved_by_message_id.as_deref(),
        Some("local-resolver")
    );

    let outbound: Vec<ReplicationEnvelope> = source
        .read_with(|conn| {
            let mut statement = conn.prepare(
                "SELECT origin_id,origin_seq,op_kind,payload_json,recorded_at_ms \
                 FROM replication_log \
                 WHERE workspace_id='ws' AND imported=0 \
                 ORDER BY origin_seq",
            )?;
            statement
                .query_map([], |row| {
                    let payload_json: String = row.get(3)?;
                    Ok(ReplicationEnvelope {
                        workspace_id: "ws".to_owned(),
                        origin_id: row.get(0)?,
                        origin_seq: row.get(1)?,
                        op_kind: row.get(2)?,
                        payload: serde_json::from_str(&payload_json).map_err(|error| {
                            rusqlite::Error::FromSqlConversionFailure(
                                payload_json.len(),
                                rusqlite::types::Type::Text,
                                Box::new(error),
                            )
                        })?,
                        recorded_at_ms: row.get(4)?,
                        relay_seq: None,
                    })
                })?
                .collect::<rusqlite::Result<Vec<_>>>()
        })
        .expect("produced chat envelopes");
    let produced = outbound
        .iter()
        .find(|operation| {
            operation.op_kind == "chat.decision.set" && operation.payload["state"] == "resolved"
        })
        .expect("produced resolved decision envelope");
    assert_eq!(produced.payload["state"], "resolved");
    assert!(produced.payload.get("resolvedByMessageId").is_none());
    assert!(outbound.iter().all(|operation| {
        operation
            .payload
            .get("messageId")
            .and_then(|value| value.as_str())
            != Some("local-resolver")
    }));

    let (_target_scratch, _target_path, mut target) = open_store();
    for operation in &outbound {
        assert_eq!(
            apply_chat_envelope(&mut target, operation, &NoFaults)
                .expect("apply produced chat envelope"),
            ApplyOutcome::new(ApplyDisposition::Applied(()))
        );
    }
    let applied: (String, Option<String>) = target
        .read_with(|conn| {
            conn.query_row(
                "SELECT state,resolved_by_message_id FROM chat_decisions \
                 WHERE workspace_id='ws' AND message_id='decision-message'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(dohc_engine_storage::StorageError::corrupt_public)
        })
        .expect("applied decision state");
    assert_eq!(applied, ("resolved".to_owned(), None));

    let invalid_open = envelope(
        "invalid-open-resolver",
        0,
        "chat.decision.set",
        json!({
            "threadId": "decision-thread",
            "messageId": "decision-message",
            "state": "open",
            "resolvedByMessageId": "local-resolver",
            "atMs": 50
        }),
    );
    assert_invalid_refusal!(apply_chat_envelope(&mut target, &invalid_open, &NoFaults));
    let state_after_refusal: String = target
        .read_with(|conn| {
            conn.query_row(
                "SELECT state FROM chat_decisions \
                 WHERE workspace_id='ws' AND message_id='decision-message'",
                [],
                |row| row.get(0),
            )
            .map_err(dohc_engine_storage::StorageError::corrupt_public)
        })
        .expect("decision state after invalid open payload");
    assert_eq!(state_after_refusal, "resolved");
}

#[test]
fn reaction_lww_remove_wins_equal_time_and_origin_breaks_remaining_ties() {
    let (_scratch, _path, mut engine) = open_store();
    let added = envelope(
        "omega",
        0,
        "chat.reaction.set",
        reaction_payload("added", "👍", 100, "Ada"),
    );
    let removed = envelope(
        "alpha",
        0,
        "chat.reaction.set",
        reaction_payload("removed", "👍", 100, "Ada"),
    );
    apply_chat_envelope(&mut engine, &added, &NoFaults).expect("added");
    apply_chat_envelope(&mut engine, &removed, &NoFaults).expect("removed");
    assert_eq!(
        reaction_winner(&engine).0,
        "removed",
        "ranking origin before state -> lexically larger added beats an equal-time remove."
    );

    let low = envelope(
        "beta",
        0,
        "chat.reaction.set",
        reaction_payload("removed", "🎉", 200, "Bob"),
    );
    let high = envelope(
        "zeta",
        0,
        "chat.reaction.set",
        reaction_payload("removed", "🎉", 200, "Bob"),
    );
    apply_chat_envelope(&mut engine, &high, &NoFaults).expect("high");
    apply_chat_envelope(&mut engine, &low, &NoFaults).expect("low");
    let winner: String = engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT origin_id FROM chat_reactions WHERE emoji = '🎉'",
                [],
                |row| row.get(0),
            )
            .map_err(dohc_engine_storage::StorageError::corrupt_public)
        })
        .expect("winner");
    assert_eq!(
        winner, "zeta",
        "omitting the origin tie-break -> equal-time/equal-state application becomes arrival-dependent."
    );
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
fn reaction_import_preserves_remote_time_verbatim() {
    let (_scratch, _path, mut engine) = open_store();
    let future = envelope(
        "peer",
        0,
        "chat.reaction.set",
        reaction_payload("added", "👍", 9_999_999_999, "Ada"),
    );
    apply_chat_envelope(&mut engine, &future, &NoFaults).expect("apply");
    assert_eq!(
        reaction_winner(&engine).1,
        9_999_999_999,
        "receiver-clock clamping remote atMs -> identical envelopes store different total-order keys on different peers."
    );
}

#[test]
fn imported_reaction_refuses_unsafe_at_ms_without_row_and_acks() {
    let (_scratch, _path, mut engine) = open_store();
    let operation = envelope(
        "unsafe-reaction-time",
        0,
        "chat.reaction.set",
        reaction_payload("added", "👍", i64::MAX, "Ada"),
    );

    assert_invalid_refusal!(apply_chat_envelope(&mut engine, &operation, &NoFaults));
    let row_count: i64 = engine
        .read_with(|conn| {
            conn.query_row("SELECT COUNT(*) FROM chat_reactions", [], |row| row.get(0))
                .map_err(dohc_engine_storage::StorageError::corrupt_public)
        })
        .expect("reaction row count");
    assert_eq!(
        row_count, 0,
        "dropping the persisted-safe atMs bound journals a reaction that subsequently makes reaction reads state-corrupt."
    );
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "unsafe-reaction-time").expect("ack"),
        0
    );
}

#[test]
fn reaction_import_accepts_negative_time_and_preserves_lww_order() {
    let (_scratch, _path, mut engine) = open_store();
    let winner_payload = reaction_payload("added", "👍", -10, "Ada");
    let winner = envelope("peer", 0, "chat.reaction.set", winner_payload);
    apply_chat_envelope(&mut engine, &winner, &NoFaults).expect("negative-time reaction");

    let mut older_payload = reaction_payload("removed", "👍", -11, "Ada");
    older_payload["authorDisplayName"] = json!("Older");
    let older = envelope("peer", 1, "chat.reaction.set", older_payload);
    apply_chat_envelope(&mut engine, &older, &NoFaults).expect("older reaction");

    let stored: (String, String, i64) = engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT state, author_display_name, at_ms FROM chat_reactions \
                 WHERE workspace_id = 'ws' AND message_id = 'message'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .map_err(dohc_engine_storage::StorageError::corrupt_public)
        })
        .expect("stored reaction");
    assert_eq!(
        stored,
        ("added".to_owned(), "Ada".to_owned(), -10),
        "rejecting negative imported time stalls the envelope; replacing the LWW comparison lets the later-arriving older row win."
    );
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "peer").expect("ack"),
        1
    );
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
fn imported_opening_message_uses_zero_based_order() {
    let (_scratch, _path, mut engine) = open_store();
    let channel = envelope(
        "opening-order",
        0,
        "chat.channel.create",
        json!({
            "channelId": "channel-1",
            "name": "General",
            "slug": "general",
            "kind": "channel",
            "createdAtMs": 10
        }),
    );
    let thread = envelope(
        "opening-order",
        1,
        "chat.thread.create",
        json!({
            "threadId": "thread-1",
            "title": "",
            "createdAtMs": 20,
            "channelSlug": "general",
            "channelWireId": "channel-1"
        }),
    );
    let opening = envelope(
        "opening-order",
        2,
        "chat.message.append",
        json!({
            "messageId": "message-1",
            "threadId": "thread-1",
            "authorKind": "human",
            "authorDisplayName": "Alice",
            "body": "Opening",
            "createdAtMs": 20
        }),
    );
    for op in [&channel, &thread, &opening] {
        assert_eq!(
            apply_chat_envelope(&mut engine, op, &NoFaults).expect("apply chat op"),
            ApplyOutcome::new(ApplyDisposition::Applied(()))
        );
    }
    let order: i64 = engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT message_order FROM chat_messages \
                 WHERE workspace_id = 'ws' AND message_id = 'message-1'",
                [],
                |row| row.get(0),
            )
        })
        .expect("opening message order");
    assert_eq!(order, 0);
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
            ApplyOutcome::new(ApplyDisposition::Applied(()))
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
fn imported_channel_refuses_non_timestamp_created_at_ms_without_row_and_acks() {
    for (suffix, created_at_ms) in [("negative", -1), ("unsafe", i64::MAX)] {
        let (_scratch, _path, mut engine) = open_store();
        let origin = format!("{suffix}-channel-time");
        let operation = envelope(
            &origin,
            0,
            "chat.channel.create",
            json!({
                "channelId": format!("{suffix}-channel"),
                "name": "Invalid timestamp",
                "slug": "invalid-timestamp",
                "kind": "channel",
                "createdAtMs": created_at_ms
            }),
        );

        assert_invalid_refusal!(apply_chat_envelope(&mut engine, &operation, &NoFaults));
        let row_count: i64 = engine
            .read_with(|conn| {
                conn.query_row(
                    "SELECT COUNT(*) FROM chat_channels WHERE workspace_id='ws'",
                    [],
                    |row| row.get(0),
                )
                .map_err(dohc_engine_storage::StorageError::corrupt_public)
            })
            .expect("channel row count");
        assert_eq!(row_count, 0);
        assert_eq!(
            read_replication_acked_seq(&engine, "ws", &origin).expect("ack"),
            0
        );
    }
}

#[test]
fn imported_thread_rejects_linked_object_without_linked_timestamp() {
    // A file-linked thread must carry linkedAtMs. The oracle accepts this op
    // (storing linked_at_ms NULL) but then bricks its own read (threadFromRow
    // numberValue(null) throws corruptStore) — a latent oracle bug. We reject
    // the malformed op at apply, deliberately stricter than the oracle, so no
    // durable-unreadable linked thread is ever persisted. Honest mint always
    // pairs the fields; only a corrupt/hostile peer hits this.
    assert_imported_thread_rejected(json!({
        "threadId": "thread-half-linked",
        "title": "Half linked",
        "createdAtMs": 20,
        "linkedObjectId": "object-1"
    }));
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
fn imported_thread_rejects_negative_or_unsafe_timestamps() {
    for payload in [
        json!({
            "threadId": "thread",
            "title": "",
            "createdAtMs": -1,
            "linkedObjectId": "object"
        }),
        json!({
            "threadId": "thread",
            "title": "",
            "createdAtMs": MAX_WIRE_INTEGER + 1,
            "linkedObjectId": "object"
        }),
        json!({
            "threadId": "thread",
            "title": "",
            "createdAtMs": 1,
            "linkedObjectId": "object",
            "linkedAtMs": -1
        }),
        json!({
            "threadId": "thread",
            "title": "",
            "createdAtMs": 1,
            "linkedObjectId": "object",
            "linkedAtMs": MAX_WIRE_INTEGER + 1
        }),
    ] {
        assert_imported_thread_rejected(payload);
    }
}

#[test]
fn imported_thread_rejects_unbounded_untrimmed_or_control_identifiers() {
    for payload in [
        json!({
            "threadId": " thread",
            "title": "",
            "createdAtMs": 1,
            "linkedObjectId": "object"
        }),
        json!({
            "threadId": "thread",
            "title": "",
            "createdAtMs": 1,
            "linkedObjectId": "\u{FEFF}object"
        }),
        json!({
            "threadId": "thread",
            "title": "",
            "createdAtMs": 1,
            "channelSlug": "general",
            "channelWireId": "wire\u{7f}"
        }),
        json!({
            "threadId": "a".repeat(257),
            "title": "",
            "createdAtMs": 1,
            "linkedObjectId": "object"
        }),
    ] {
        assert_imported_thread_rejected(payload);
    }
}

#[test]
fn imported_thread_rejects_overlong_or_trim_unstable_titles() {
    for title in [
        " padded ".to_owned(),
        "\u{FEFF}title".to_owned(),
        "a".repeat(201),
    ] {
        assert_imported_thread_rejected(json!({
            "threadId": "thread",
            "title": title,
            "createdAtMs": 1,
            "linkedObjectId": "object"
        }));
    }
}

#[test]
fn imported_thread_rejects_channel_slugs_outside_oracle_grammar() {
    for channel_slug in [
        "General".to_owned(),
        "two--words".to_owned(),
        "-leading".to_owned(),
        "a".repeat(201),
    ] {
        assert_imported_thread_rejected(json!({
            "threadId": "thread",
            "title": "",
            "createdAtMs": 1,
            "channelSlug": channel_slug
        }));
    }
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
fn imported_slug_only_thread_binds_the_existing_channel() {
    let (_scratch, _path, mut engine) = open_store();
    let channel = envelope(
        "slug-only",
        0,
        "chat.channel.create",
        json!({
            "channelId": "existing-channel",
            "name": "Existing",
            "slug": "existing",
            "kind": "channel",
            "createdAtMs": 10
        }),
    );
    let thread = envelope(
        "slug-only",
        1,
        "chat.thread.create",
        json!({
            "threadId": "legacy-thread",
            "title": "",
            "createdAtMs": 20,
            "channelSlug": "existing"
        }),
    );
    apply_chat_envelope(&mut engine, &channel, &NoFaults).expect("channel");
    apply_chat_envelope(&mut engine, &thread, &NoFaults).expect("thread");
    let (channel_id, channel_count, placeholder_count): (String, i64, i64) = engine
        .read_with(|conn| {
            Ok::<_, rusqlite::Error>((
                conn.query_row(
                    "SELECT channel_id FROM chat_threads \
                     WHERE workspace_id = 'ws' AND thread_id = 'legacy-thread'",
                    [],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*) FROM chat_channels WHERE workspace_id = 'ws'",
                    [],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*) FROM chat_channel_placeholders WHERE workspace_id = 'ws'",
                    [],
                    |row| row.get(0),
                )?,
            ))
        })
        .expect("binding");
    assert_eq!(
        channel_id, "existing-channel",
        "treating channelSlug as a wire id mints a duplicate placeholder."
    );
    assert_eq!(channel_count, 1);
    assert_eq!(placeholder_count, 0);
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
            primary: ApplyDisposition::Applied(()),
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
            primary: ApplyDisposition::Applied(()),
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
            primary: ApplyDisposition::Applied(()),
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
            primary: ApplyDisposition::Applied(()),
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
            primary: ApplyDisposition::Applied(()),
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
            primary: ApplyDisposition::Applied(()),
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
fn imported_parent_arrival_repairs_the_child_and_bumps_the_conversation() {
    let (_scratch, _path, mut engine) = open_store();
    seed_unowned_chat_thread(&mut engine, "parent-thread");
    let child = envelope(
        "child-origin",
        0,
        "chat.message.append",
        json!({
            "messageId": "child",
            "threadId": "parent-thread",
            "authorKind": "human",
            "authorDisplayName": "Ada",
            "parentMessageId": "parent",
            "body": "Child first",
            "createdAtMs": 30
        }),
    );
    apply_chat_envelope(&mut engine, &child, &NoFaults).expect("child apply");
    assert_eq!(chat_content_revision(&engine, "parent-thread"), 1);

    let parent = envelope(
        "parent-origin",
        0,
        "chat.message.append",
        json!({
            "messageId": "parent",
            "threadId": "parent-thread",
            "authorKind": "human",
            "authorDisplayName": "Ada",
            "body": "Parent later",
            "createdAtMs": 20
        }),
    );
    apply_chat_envelope(&mut engine, &parent, &NoFaults).expect("parent apply");
    let repaired_parent: Option<String> = engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT parent_message_id FROM chat_messages \
                 WHERE workspace_id='ws' AND message_id='child'",
                [],
                |row| row.get(0),
            )
            .map_err(dohc_engine_storage::StorageError::corrupt_public)
        })
        .expect("repaired parent");
    assert_eq!(repaired_parent.as_deref(), Some("parent"));
    assert_eq!(chat_content_revision(&engine, "parent-thread"), 2);
}

#[test]
fn ready_pending_replay_bumps_every_conversation_it_materializes() {
    let (_scratch, _path, mut engine) = open_store();
    for (origin, thread_id, message_id) in [
        ("pending-a", "thread-a", "message-a"),
        ("pending-b", "thread-b", "message-b"),
    ] {
        let operation = envelope(
            origin,
            0,
            "chat.message.append",
            json!({
                "messageId": message_id,
                "threadId": thread_id,
                "authorKind": "human",
                "authorDisplayName": "Ada",
                "body": format!("Pending for {thread_id}"),
                "createdAtMs": 20
            }),
        );
        apply_chat_envelope(&mut engine, &operation, &NoFaults).expect("park message");
    }
    assert_eq!(pending_chat_coordinate_count(&engine), 2);
    seed_unowned_chat_thread(&mut engine, "thread-a");
    seed_unowned_chat_thread(&mut engine, "thread-b");

    LinkedChatStore::new(&mut engine)
        .create_channel(
            "ws",
            "replay-trigger",
            "Replay trigger",
            ChatChannelKind::Channel,
            30,
            &NoFaults,
        )
        .expect("trigger ready replay");

    assert_eq!(pending_chat_coordinate_count(&engine), 0);
    assert_eq!(chat_content_revision(&engine, "thread-a"), 1);
    assert_eq!(chat_content_revision(&engine, "thread-b"), 1);
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
            "authorKind": "human",
            "authorDisplayName": "Ice",
            "authorUserId": "ice",
            "body": "arrived first",
            "createdAtMs": 30
        }),
    );
    assert!(matches!(
        apply_chat_envelope(&mut engine, &message, &NoFaults),
        Ok(ApplyOutcome {
            primary: ApplyDisposition::Applied(()),
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

    let replayed: (String, String, i64) = engine
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
            ))
        })
        .expect("replayed message state");
    assert_eq!(
        replayed,
        (
            "arrived first".to_owned(),
            "Ice\narrived first".to_owned(),
            0
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
        ApplyOutcome::new(ApplyDisposition::Applied(()))
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
    assert_eq!(primary, ApplyDisposition::Applied(()));
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
fn imported_follow_parks_until_its_cross_origin_thread_arrives() {
    let (_scratch, _path, mut engine) = open_store();
    let follow = envelope(
        "late-follow",
        0,
        "chat.follow.set",
        json!({
            "ownerUserId": "owner",
            "targetKind": "thread",
            "targetId": "late-thread",
            "state": "following",
            "atMs": 30
        }),
    );

    assert_eq!(
        apply_chat_envelope(&mut engine, &follow, &NoFaults).expect("park follow"),
        ApplyOutcome::new(ApplyDisposition::Applied(()))
    );
    assert_eq!(pending_chat_coordinate_count(&engine), 1);
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "late-follow").expect("follow ack"),
        0
    );

    let target = envelope(
        "late-thread-origin",
        0,
        "chat.thread.create",
        json!({
            "threadId": "late-thread",
            "title": "Late thread",
            "createdAtMs": 20,
            "linkedObjectId": "late-thread-object",
            "linkedAtMs": 20
        }),
    );
    apply_chat_envelope(&mut engine, &target, &NoFaults).expect("apply target thread");

    let state: String = engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT state FROM chat_follows \
                 WHERE workspace_id='ws' AND owner_user_id='owner' \
                   AND target_kind='thread' AND target_id='late-thread'",
                [],
                |row| row.get(0),
            )
            .map_err(dohc_engine_storage::StorageError::corrupt_public)
        })
        .expect("replayed follow");
    assert_eq!(state, "following");
    assert_eq!(pending_chat_coordinate_count(&engine), 0);
}

#[test]
fn imported_feed_read_parks_until_its_cross_origin_message_arrives() {
    let (_scratch, _path, mut engine) = open_store();
    let thread = envelope(
        "feed-thread-origin",
        0,
        "chat.thread.create",
        json!({
            "threadId": "feed-thread",
            "title": "Feed thread",
            "createdAtMs": 10,
            "linkedObjectId": "feed-thread-object",
            "linkedAtMs": 10
        }),
    );
    apply_chat_envelope(&mut engine, &thread, &NoFaults).expect("feed thread");
    let follow = envelope(
        "feed-follow-origin",
        0,
        "chat.follow.set",
        json!({
            "ownerUserId": "owner",
            "targetKind": "thread",
            "targetId": "feed-thread",
            "state": "following",
            "atMs": 15
        }),
    );
    apply_chat_envelope(&mut engine, &follow, &NoFaults).expect("feed thread follow");
    let feed_read = envelope(
        "late-feed-read",
        0,
        "chat.feed.read.set",
        json!({
            "ownerUserId": "owner",
            "lastSeenCreatedAtMs": 20,
            "lastSeenMessageId": "late-feed-message",
            "atMs": 30
        }),
    );

    assert_eq!(
        apply_chat_envelope(&mut engine, &feed_read, &NoFaults).expect("park feed read"),
        ApplyOutcome::new(ApplyDisposition::Applied(()))
    );
    assert_eq!(pending_chat_coordinate_count(&engine), 1);

    let message = envelope(
        "feed-message-origin",
        0,
        "chat.message.append",
        json!({
            "messageId": "late-feed-message",
            "threadId": "feed-thread",
            "authorKind": "human",
            "authorDisplayName": "Ada",
            "body": "Arrived later",
            "createdAtMs": 20
        }),
    );
    apply_chat_envelope(&mut engine, &message, &NoFaults).expect("feed message");

    let coordinate: (i64, String) = engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT last_seen_created_at_ms,last_seen_message_id \
                 FROM chat_feed_read_state \
                 WHERE workspace_id='ws' AND owner_user_id='owner'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(dohc_engine_storage::StorageError::corrupt_public)
        })
        .expect("replayed feed coordinate");
    assert_eq!(coordinate, (20, "late-feed-message".to_owned()));
    assert_eq!(pending_chat_coordinate_count(&engine), 0);
}

#[test]
fn imported_attachment_parks_until_its_cross_origin_message_arrives() {
    let (_scratch, _path, mut engine) = open_store();
    let thread = envelope(
        "attachment-thread-origin",
        0,
        "chat.thread.create",
        json!({
            "threadId": "attachment-thread",
            "title": "Attachment thread",
            "createdAtMs": 10,
            "linkedObjectId": "attachment-thread-object",
            "linkedAtMs": 10
        }),
    );
    apply_chat_envelope(&mut engine, &thread, &NoFaults).expect("attachment thread");
    let attachment_id = attachment_id_for("late-attachment-message", "object", None, None);
    let attachment = envelope(
        "late-attachment",
        0,
        "chat.attachment.add",
        json!({
            "attachmentId": attachment_id,
            "threadId": "attachment-thread",
            "messageId": "late-attachment-message",
            "targetKind": "file",
            "objectId": "object",
            "createdAtMs": 30
        }),
    );

    assert_eq!(
        apply_chat_envelope(&mut engine, &attachment, &NoFaults).expect("park attachment"),
        ApplyOutcome::new(ApplyDisposition::Applied(()))
    );
    assert_eq!(pending_chat_coordinate_count(&engine), 1);

    let message = envelope(
        "attachment-message-origin",
        0,
        "chat.message.append",
        json!({
            "messageId": "late-attachment-message",
            "threadId": "attachment-thread",
            "authorKind": "human",
            "authorDisplayName": "Ada",
            "body": "Arrived later",
            "createdAtMs": 20
        }),
    );
    apply_chat_envelope(&mut engine, &message, &NoFaults).expect("attachment message");

    let attachment_count: i64 = engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM chat_attachments \
                 WHERE workspace_id='ws' AND attachment_id=?1",
                [&attachment_id],
                |row| row.get(0),
            )
            .map_err(dohc_engine_storage::StorageError::corrupt_public)
        })
        .expect("replayed attachment");
    assert_eq!(attachment_count, 1);
    assert_eq!(pending_chat_coordinate_count(&engine), 0);
}

#[test]
fn imported_feed_read_waits_for_placeholder_channel_resolution() {
    let (_scratch, _path, mut engine) = open_store();
    let thread = envelope(
        "placeholder-feed-thread",
        0,
        "chat.thread.create",
        json!({
            "threadId": "placeholder-feed-thread",
            "title": "Placeholder feed",
            "createdAtMs": 10,
            "channelSlug": "placeholder-feed",
            "channelWireId": "placeholder-feed-wire"
        }),
    );
    let message = envelope(
        "placeholder-feed-thread",
        1,
        "chat.message.append",
        json!({
            "messageId": "placeholder-feed-message",
            "threadId": "placeholder-feed-thread",
            "authorKind": "human",
            "authorDisplayName": "Ada",
            "body": "Waiting for its channel",
            "createdAtMs": 20
        }),
    );
    apply_chat_envelope(&mut engine, &thread, &NoFaults).expect("placeholder thread");
    apply_chat_envelope(&mut engine, &message, &NoFaults).expect("placeholder message");
    engine
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT INTO chat_follows \
                 (workspace_id,owner_user_id,target_kind,target_id,state,updated_at_ms,origin_id,origin_seq) \
                 VALUES ('ws','owner','thread','placeholder-feed-thread','following',21,'fixture',0)",
                [],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .expect("enabling follow");

    let read = envelope(
        "placeholder-feed-read",
        0,
        "chat.feed.read.set",
        json!({
            "ownerUserId": "owner",
            "lastSeenCreatedAtMs": 20,
            "lastSeenMessageId": "placeholder-feed-message",
            "atMs": 30
        }),
    );
    assert_eq!(
        apply_chat_envelope(&mut engine, &read, &NoFaults).expect("defer placeholder feed read"),
        ApplyOutcome::new(ApplyDisposition::Applied(()))
    );
    assert_eq!(pending_chat_coordinate_count(&engine), 1);

    let channel = envelope(
        "placeholder-feed-channel",
        0,
        "chat.channel.create",
        json!({
            "channelId": "placeholder-feed-authoritative",
            "name": "Placeholder feed",
            "slug": "placeholder-feed",
            "kind": "channel",
            "createdAtMs": 5,
            "wireId": "placeholder-feed-wire"
        }),
    );
    apply_chat_envelope(&mut engine, &channel, &NoFaults).expect("authoritative channel");

    let coordinate: (i64, String) = engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT last_seen_created_at_ms,last_seen_message_id \
                 FROM chat_feed_read_state WHERE workspace_id='ws' AND owner_user_id='owner'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(dohc_engine_storage::StorageError::corrupt_public)
        })
        .expect("replayed placeholder feed read");
    assert_eq!(coordinate, (20, "placeholder-feed-message".to_owned()));
    assert_eq!(pending_chat_coordinate_count(&engine), 0);
}

#[test]
fn imported_person_follow_waits_for_a_non_dm_message() {
    let (_scratch, _path, mut engine) = open_store();
    for operation in [
        envelope(
            "dm-person-source",
            0,
            "chat.channel.create",
            json!({
                "channelId": "dm-person-channel",
                "name": "Private person",
                "slug": "private-person",
                "kind": "dm",
                "createdAtMs": 10,
                "wireId": "dm-person-wire"
            }),
        ),
        envelope(
            "dm-person-source",
            1,
            "chat.thread.create",
            json!({
                "threadId": "dm-person-thread",
                "title": "Private person",
                "createdAtMs": 11,
                "channelSlug": "private-person",
                "channelWireId": "dm-person-wire"
            }),
        ),
        envelope(
            "dm-person-source",
            2,
            "chat.message.append",
            json!({
                "messageId": "dm-person-message",
                "threadId": "dm-person-thread",
                "authorKind": "human",
                "authorDisplayName": "Ada",
                "authorUserId": "person-delayed-public",
                "body": "Private first",
                "createdAtMs": 12
            }),
        ),
    ] {
        apply_chat_envelope(&mut engine, &operation, &NoFaults).expect("DM person fixture");
    }
    let follow = envelope(
        "dm-person-follow",
        0,
        "chat.follow.set",
        json!({
            "ownerUserId": "owner",
            "targetKind": "person",
            "targetId": "person-delayed-public",
            "state": "following",
            "atMs": 20
        }),
    );
    assert_eq!(
        apply_chat_envelope(&mut engine, &follow, &NoFaults).expect("defer DM-only person"),
        ApplyOutcome::new(ApplyDisposition::Applied(()))
    );
    assert_eq!(pending_chat_coordinate_count(&engine), 1);

    for operation in [
        envelope(
            "public-person-source",
            0,
            "chat.thread.create",
            json!({
                "threadId": "public-person-thread",
                "title": "Public person",
                "createdAtMs": 30,
                "linkedObjectId": "public-person-object",
                "linkedAtMs": 30
            }),
        ),
        envelope(
            "public-person-source",
            1,
            "chat.message.append",
            json!({
                "messageId": "public-person-message",
                "threadId": "public-person-thread",
                "authorKind": "human",
                "authorDisplayName": "Ada",
                "authorUserId": "person-delayed-public",
                "body": "Public later",
                "createdAtMs": 31
            }),
        ),
    ] {
        apply_chat_envelope(&mut engine, &operation, &NoFaults).expect("public person fixture");
    }

    let state: String = engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT state FROM chat_follows \
                 WHERE workspace_id='ws' AND owner_user_id='owner' \
                   AND target_kind='person' AND target_id='person-delayed-public'",
                [],
                |row| row.get(0),
            )
            .map_err(dohc_engine_storage::StorageError::corrupt_public)
        })
        .expect("replayed person follow");
    assert_eq!(state, "following");
    assert_eq!(pending_chat_coordinate_count(&engine), 0);
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
fn colliding_newcomer_hash_is_stable_across_local_occupancy_histories() {
    let newcomer_wire = "replicated-newcomer-wire";
    let newcomer = envelope(
        "replicated-newcomer",
        0,
        "chat.channel.create",
        json!({
            "channelId": "replicated-newcomer-channel",
            "name": "Contested",
            "slug": "contested",
            "kind": "channel",
            "createdAtMs": 50,
            "wireId": newcomer_wire
        }),
    );
    let expected = collision_slug_for_test("contested", newcomer_wire, 0);
    let mut newcomer_slugs = Vec::new();

    for (peer, incumbent_created_at_ms) in [("alpha", 10), ("omega", 90)] {
        let (scratch, _path, mut engine) = open_store();
        LinkedChatStore::new(&mut engine)
            .create_channel(
                "ws",
                &format!("{peer}-incumbent"),
                "Contested",
                ChatChannelKind::Channel,
                incumbent_created_at_ms,
                &NoFaults,
            )
            .expect("local incumbent");
        LinkedChatStore::new(&mut engine)
            .create_channel(
                "ws",
                &format!("{peer}-bystander"),
                &format!("{peer} bystander"),
                ChatChannelKind::Channel,
                incumbent_created_at_ms.saturating_add(1),
                &NoFaults,
            )
            .expect("different local occupancy history");

        apply_chat_envelope(&mut engine, &newcomer, &NoFaults).expect("replicated newcomer");
        let slug: String = engine
            .read_with(|conn| {
                conn.query_row(
                    "SELECT slug FROM chat_channels \
                     WHERE workspace_id='ws' AND channel_id='replicated-newcomer-channel'",
                    [],
                    |row| row.get(0),
                )
                .map_err(dohc_engine_storage::StorageError::corrupt_public)
            })
            .expect("newcomer slug");
        assert_eq!(
            slug, expected,
            "the collision hash must depend only on the newcomer's replicated wire identity"
        );
        newcomer_slugs.push((scratch, slug));
    }

    assert_eq!(newcomer_slugs[0].1, newcomer_slugs[1].1);
}

#[test]
fn authoritative_channel_materialization_only_reallocates_its_own_placeholder() {
    let (_scratch, _path, mut engine) = open_store();
    let occupied = envelope(
        "materialization-owner",
        0,
        "chat.channel.create",
        json!({
            "channelId": "materialization-owner-channel",
            "name": "Shared name",
            "slug": "shared-name",
            "kind": "channel",
            "createdAtMs": 1
        }),
    );
    let placeholder = envelope(
        "materialization-placeholder",
        0,
        "chat.thread.create",
        json!({
            "threadId": "materialization-placeholder-thread",
            "title": "Placeholder",
            "createdAtMs": 2,
            "channelSlug": "wire-alias",
            "channelWireId": "materialization-placeholder-wire"
        }),
    );
    let authoritative = envelope(
        "materialization-authoritative",
        0,
        "chat.channel.create",
        json!({
            "channelId": "materialization-authoritative-channel",
            "name": "Shared name",
            "slug": "wire-alias",
            "kind": "channel",
            "createdAtMs": 3,
            "wireId": "materialization-placeholder-wire"
        }),
    );
    for operation in [&occupied, &placeholder, &authoritative] {
        apply_chat_envelope(&mut engine, operation, &NoFaults).expect("channel operation");
    }

    let (owner_slug, materialized_slug): (String, String) = engine
        .read_with(|conn| {
            Ok::<_, rusqlite::Error>((
                conn.query_row(
                    "SELECT slug FROM chat_channels \
                     WHERE workspace_id='ws' AND channel_id='materialization-owner-channel'",
                    [],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT c.slug FROM chat_channel_wire_ids w \
                     JOIN chat_channels c \
                       ON c.workspace_id=w.workspace_id AND c.channel_id=w.channel_id \
                     WHERE w.workspace_id='ws' AND w.wire_id='materialization-placeholder-wire'",
                    [],
                    |row| row.get(0),
                )?,
            ))
        })
        .expect("materialized channel slugs");
    assert_eq!(owner_slug, "shared-name");
    assert_eq!(
        materialized_slug,
        collision_slug_for_test("shared-name", "materialization-placeholder-wire", 0)
    );
}

#[test]
fn noncolliding_channel_apply_does_not_rewrite_unchanged_slugs() {
    let (_scratch, _path, mut engine) = open_store();
    let first = envelope(
        "no-op-slug-first",
        0,
        "chat.channel.create",
        json!({
            "channelId": "no-op-channel-first",
            "name": "First",
            "slug": "first",
            "kind": "channel",
            "createdAtMs": 10
        }),
    );
    apply_chat_envelope(&mut engine, &first, &NoFaults).expect("first channel");
    engine
        .write_with(&NoFaults, |tx| {
            tx.execute_batch(
                "CREATE TABLE channel_slug_update_log (channel_id TEXT NOT NULL); \
                 CREATE TRIGGER channel_slug_update_probe AFTER UPDATE OF slug ON chat_channels \
                 BEGIN INSERT INTO channel_slug_update_log(channel_id) VALUES (OLD.channel_id); END;",
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .expect("slug update probe");

    let second = envelope(
        "no-op-slug-second",
        0,
        "chat.channel.create",
        json!({
            "channelId": "no-op-channel-second",
            "name": "Second",
            "slug": "second",
            "kind": "channel",
            "createdAtMs": 20
        }),
    );
    apply_chat_envelope(&mut engine, &second, &NoFaults).expect("second channel");
    let collider = envelope(
        "no-op-slug-collider",
        0,
        "chat.channel.create",
        json!({
            "channelId": "no-op-channel-collider",
            "name": "First",
            "slug": "first",
            "kind": "channel",
            "createdAtMs": 1,
            "wireId": "no-op-collider-wire"
        }),
    );
    apply_chat_envelope(&mut engine, &collider, &NoFaults).expect("colliding channel");
    let (updates, incumbent_slug): (i64, String) = engine
        .read_with(|conn| {
            Ok::<_, rusqlite::Error>((
                conn.query_row("SELECT COUNT(*) FROM channel_slug_update_log", [], |row| {
                    row.get(0)
                })?,
                conn.query_row(
                    "SELECT slug FROM chat_channels \
                     WHERE workspace_id='ws' AND channel_id='no-op-channel-first'",
                    [],
                    |row| row.get(0),
                )?,
            ))
        })
        .expect("slug update evidence");
    assert_eq!(
        updates, 0,
        "channel arrival must never update an existing row, even on collision"
    );
    assert_eq!(incumbent_slug, "first");
}

#[test]
fn local_thread_write_replays_a_parked_remote_follow() {
    let (_scratch, _path, mut engine) = open_store();
    let follow = envelope(
        "local-wakeup-follow",
        0,
        "chat.follow.set",
        json!({
            "ownerUserId": "owner",
            "targetKind": "thread",
            "targetId": "local-wakeup-thread",
            "state": "following",
            "atMs": 20
        }),
    );
    apply_chat_envelope(&mut engine, &follow, &NoFaults).expect("park remote follow");
    assert_eq!(pending_chat_coordinate_count(&engine), 1);

    LinkedChatStore::new(&mut engine)
        .create_thread(
            &CreateFileThread {
                workspace_id: "ws".to_owned(),
                thread_id: "local-wakeup-thread".to_owned(),
                title: "Local wakeup".to_owned(),
                linked_object_id: "local-wakeup-object".to_owned(),
                linked_path_hint: None,
                now_ms: 30,
                request_id: "local-wakeup-request".to_owned(),
            },
            &NoFaults,
        )
        .expect("local dependency write");

    let state: String = engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT state FROM chat_follows \
                 WHERE workspace_id='ws' AND owner_user_id='owner' \
                   AND target_kind='thread' AND target_id='local-wakeup-thread'",
                [],
                |row| row.get(0),
            )
            .map_err(dohc_engine_storage::StorageError::corrupt_public)
        })
        .expect("follow replayed by local write");
    assert_eq!(state, "following");
    assert_eq!(pending_chat_coordinate_count(&engine), 0);
}

#[test]
fn general_wire_backfill_replays_a_parked_remote_follow() {
    let (_scratch, _path, mut engine) = open_store();
    LinkedChatStore::new(&mut engine)
        .create_channel(
            "ws",
            "ordinary-general",
            "general",
            ChatChannelKind::Channel,
            10,
            &NoFaults,
        )
        .expect("ordinary general channel");
    let follow = envelope(
        "general-wire-follow",
        0,
        "chat.follow.set",
        json!({
            "ownerUserId": "owner",
            "targetKind": "channel",
            "targetId": GENERAL_CHANNEL_WIRE_ID,
            "state": "following",
            "atMs": 20
        }),
    );
    apply_chat_envelope(&mut engine, &follow, &NoFaults).expect("park general follow");
    assert_eq!(pending_chat_coordinate_count(&engine), 1);

    let general = LinkedChatStore::new(&mut engine)
        .ensure_general_channel("ws", "unused-general-id", 30, &NoFaults)
        .expect("backfill general wire id");
    assert_eq!(general.channel_id, "ordinary-general");

    let state: String = engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT state FROM chat_follows \
                 WHERE workspace_id='ws' AND owner_user_id='owner' \
                   AND target_kind='channel' AND target_id=?1",
                [GENERAL_CHANNEL_WIRE_ID],
                |row| row.get(0),
            )
            .map_err(dohc_engine_storage::StorageError::corrupt_public)
        })
        .expect("replayed general follow");
    assert_eq!(state, "following");
    assert_eq!(pending_chat_coordinate_count(&engine), 0);
}

#[test]
fn default_follow_seed_replays_a_parked_remote_feed_read() {
    let (_scratch, _path, mut engine) = open_store();
    LinkedChatStore::new(&mut engine)
        .create_channel(
            "ws",
            "default-channel",
            "Default channel",
            ChatChannelKind::Channel,
            10,
            &NoFaults,
        )
        .expect("default channel");
    LinkedChatStore::new(&mut engine)
        .start_channel_thread(
            &StartChannelThread {
                workspace_id: "ws".to_owned(),
                thread_id: "default-thread".to_owned(),
                message_id: "default-message".to_owned(),
                channel_id: "default-channel".to_owned(),
                title: Some("Default thread".to_owned()),
                lane: ChatThreadLane::Posts,
                body: "Default opening message".to_owned(),
                author_kind: ChatActorKind::Human,
                author_display_name: "Ada".to_owned(),
                author_user_id: Some("ada".to_owned()),
                origin: None,
                needs_decision: false,
                attachments: Vec::new(),
                now_ms: 20,
                request_id: Some("default-thread-request".to_owned()),
            },
            &NoFaults,
        )
        .expect("default opening message");
    let feed_read = envelope(
        "default-feed-read",
        0,
        "chat.feed.read.set",
        json!({
            "ownerUserId": "owner",
            "lastSeenCreatedAtMs": 20,
            "lastSeenMessageId": "default-message",
            "atMs": 30
        }),
    );
    apply_chat_envelope(&mut engine, &feed_read, &NoFaults).expect("park default feed read");
    assert_eq!(pending_chat_coordinate_count(&engine), 1);

    LinkedChatStore::new(&mut engine)
        .ensure_default_channel_follows("ws", "owner", &NoFaults)
        .expect("seed default follows");

    let coordinate: (i64, String) = engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT last_seen_created_at_ms,last_seen_message_id \
                 FROM chat_feed_read_state WHERE workspace_id='ws' AND owner_user_id='owner'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(dohc_engine_storage::StorageError::corrupt_public)
        })
        .expect("replayed default feed read");
    assert_eq!(coordinate, (20, "default-message".to_owned()));
    assert_eq!(pending_chat_coordinate_count(&engine), 0);
}

#[test]
fn local_follow_write_replays_a_parked_remote_feed_read_at_the_domain_boundary() {
    let (_scratch, _path, mut engine) = open_store();
    imported_chat_fixture(&mut engine, "local-follow-fixture");
    let feed_read = envelope(
        "local-follow-feed-read",
        0,
        "chat.feed.read.set",
        json!({
            "ownerUserId": "owner",
            "lastSeenCreatedAtMs": 20,
            "lastSeenMessageId": "message-imported",
            "atMs": 30
        }),
    );
    apply_chat_envelope(&mut engine, &feed_read, &NoFaults).expect("park feed read");
    assert_eq!(pending_chat_coordinate_count(&engine), 1);

    LinkedChatStore::new(&mut engine)
        .set_follow(
            &SetFollow {
                workspace_id: "ws".to_owned(),
                owner_user_id: "owner".to_owned(),
                replication_owner_user_id: None,
                target_kind: FollowTargetKind::Thread,
                target_id: "thread-imported".to_owned(),
                state: FollowState::Following,
                now_ms: 40,
            },
            &NoFaults,
        )
        .expect("local follow");

    let coordinate: (i64, String) = engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT last_seen_created_at_ms,last_seen_message_id \
                 FROM chat_feed_read_state WHERE workspace_id='ws' AND owner_user_id='owner'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(dohc_engine_storage::StorageError::corrupt_public)
        })
        .expect("replayed feed read");
    assert_eq!(coordinate, (20, "message-imported".to_owned()));
    assert_eq!(pending_chat_coordinate_count(&engine), 0);
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
fn overlong_wire_only_placeholder_slug_round_trips_through_local_thread_journal() {
    let (_scratch, _path, mut first_peer) = open_store();
    let long_wire_id = "a".repeat(240);
    let seed = envelope(
        "long-wire-seed",
        0,
        "chat.thread.create",
        json!({
            "threadId": "long-wire-seed-thread",
            "title": "Seed",
            "createdAtMs": 10,
            "channelWireId": long_wire_id
        }),
    );
    apply_chat_envelope(&mut first_peer, &seed, &NoFaults).expect("wire-only placeholder");

    let (placeholder_channel_id, stored_slug): (String, String) = first_peer
        .read_with(|conn| {
            conn.query_row(
                "SELECT channel_id,slug FROM chat_channels WHERE workspace_id='ws'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
        })
        .expect("placeholder channel");
    assert!(
        crate::apply::is_replicated_channel_slug(&stored_slug),
        "the synthesized base must already satisfy the outbound channelSlug grammar"
    );
    assert_eq!(stored_slug.encode_utf16().count(), 200);

    LinkedChatStore::new(&mut first_peer)
        .start_channel_thread(
            &StartChannelThread {
                workspace_id: "ws".to_owned(),
                channel_id: placeholder_channel_id,
                thread_id: "long-wire-local-thread".to_owned(),
                message_id: "long-wire-local-message".to_owned(),
                title: Some("Local follow-up".to_owned()),
                lane: ChatThreadLane::Posts,
                author_kind: ChatActorKind::Human,
                author_display_name: "Ada".to_owned(),
                author_user_id: Some("ada".to_owned()),
                origin: None,
                body: "Replicate this".to_owned(),
                needs_decision: false,
                attachments: Vec::new(),
                now_ms: 20,
                request_id: Some("long-wire-local-request".to_owned()),
            },
            &NoFaults,
        )
        .expect("local thread in placeholder");

    let outbound: ReplicationEnvelope = first_peer
        .read_with(|conn| {
            conn.query_row(
                "SELECT origin_id,origin_seq,payload_json,recorded_at_ms \
                 FROM replication_log \
                 WHERE workspace_id='ws' AND op_kind='chat.thread.create' \
                   AND json_extract(payload_json,'$.threadId')='long-wire-local-thread'",
                [],
                |row| {
                    let payload_json: String = row.get(2)?;
                    Ok(ReplicationEnvelope {
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
        .expect("outbound local thread envelope");
    assert_eq!(
        outbound.payload["channelSlug"],
        json!(stored_slug),
        "the local thread must journal the bounded persisted slug"
    );

    let (_second_scratch, _second_path, mut second_peer) = open_store();
    assert_eq!(
        apply_chat_envelope(&mut second_peer, &outbound, &NoFaults)
            .expect("second peer accepts bounded outbound channelSlug"),
        ApplyOutcome::new(ApplyDisposition::Applied(()))
    );
}

#[test]
fn collision_slug_truncation_is_bounded_and_does_not_leave_a_dash_boundary() {
    let (_scratch, _path, mut engine) = open_store();
    let long_base = format!("{}-{}", "a".repeat(134), "b".repeat(20));
    assert!(long_base.len() > 135);
    for (origin, thread_id, wire_id, created_at_ms) in [
        (
            "long-base-owner",
            "long-base-owner-thread",
            "long-base-wire-1",
            1,
        ),
        (
            "long-base-newcomer",
            "long-base-newcomer-thread",
            "long-base-wire-2",
            2,
        ),
    ] {
        let operation = envelope(
            origin,
            0,
            "chat.thread.create",
            json!({
                "threadId": thread_id,
                "title": "Long base",
                "createdAtMs": created_at_ms,
                "channelSlug": long_base,
                "channelWireId": wire_id
            }),
        );
        apply_chat_envelope(&mut engine, &operation, &NoFaults).expect("long-base placeholder");
    }

    let newcomer_slug: String = engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT c.slug FROM chat_channel_wire_ids w \
                 JOIN chat_channels c \
                   ON c.workspace_id=w.workspace_id AND c.channel_id=w.channel_id \
                 WHERE w.workspace_id='ws' AND w.wire_id='long-base-wire-2'",
                [],
                |row| row.get(0),
            )
        })
        .expect("long-base newcomer slug");
    assert_eq!(
        newcomer_slug,
        collision_slug_for_test(&long_base, "long-base-wire-2", 0)
    );
    assert_eq!(newcomer_slug.encode_utf16().count(), 199);
    assert!(crate::apply::is_replicated_channel_slug(&newcomer_slug));
    assert!(
        !newcomer_slug.contains("--"),
        "truncating at the 135th unit must not leave an empty slug segment"
    );
}

#[test]
fn replay_only_touches_coordinates_for_the_changed_dependency() {
    let (_scratch, _path, mut engine) = open_store();
    for (origin, target) in [
        ("targeted-follow-a", "targeted-thread-a"),
        ("targeted-follow-b", "targeted-thread-b"),
    ] {
        let follow = envelope(
            origin,
            0,
            "chat.follow.set",
            json!({
                "ownerUserId": "owner",
                "targetKind": "thread",
                "targetId": target,
                "state": "following",
                "atMs": 20
            }),
        );
        apply_chat_envelope(&mut engine, &follow, &NoFaults).expect("park targeted follow");
    }
    engine
        .write_with(&NoFaults, |tx| {
            tx.execute_batch(
                "CREATE TABLE pending_touch_log (origin_id TEXT NOT NULL); \
                 CREATE TRIGGER pending_touch_probe AFTER DELETE ON chat_pending_replication \
                 BEGIN INSERT INTO pending_touch_log(origin_id) VALUES (OLD.origin_id); END;",
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .expect("pending replay probe");

    let target = envelope(
        "targeted-thread-source",
        0,
        "chat.thread.create",
        json!({
            "threadId": "targeted-thread-a",
            "title": "Target A",
            "createdAtMs": 30,
            "linkedObjectId": "targeted-object-a",
            "linkedAtMs": 30
        }),
    );
    apply_chat_envelope(&mut engine, &target, &NoFaults).expect("satisfy only target A");

    let touched: Vec<String> = engine
        .read_with(|conn| {
            let mut stmt = conn
                .prepare("SELECT origin_id FROM pending_touch_log ORDER BY origin_id")
                .map_err(dohc_engine_storage::StorageError::corrupt_public)?;
            let rows = stmt
                .query_map([], |row| row.get(0))
                .map_err(dohc_engine_storage::StorageError::corrupt_public)?;
            rows.collect::<rusqlite::Result<Vec<_>>>()
                .map_err(dohc_engine_storage::StorageError::corrupt_public)
        })
        .expect("touched pending coordinates");
    assert_eq!(touched, vec!["targeted-follow-a".to_owned()]);
    let still_pending: String = engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT origin_id FROM chat_pending_replication \
                 WHERE workspace_id='ws' AND dependency_id='targeted-thread-b'",
                [],
                |row| row.get(0),
            )
            .map_err(dohc_engine_storage::StorageError::corrupt_public)
        })
        .expect("unrelated coordinate remains parked");
    assert_eq!(still_pending, "targeted-follow-b");
}

#[test]
fn imported_follow_refuses_a_resolved_dm_without_parking() {
    let (_scratch, _path, mut engine) = open_store();
    let channel = envelope(
        "dm-target-origin",
        0,
        "chat.channel.create",
        json!({
            "channelId": "dm-target-channel",
            "name": "Private",
            "slug": "private",
            "kind": "dm",
            "createdAtMs": 10,
            "wireId": "dm-target-wire"
        }),
    );
    let thread = envelope(
        "dm-target-origin",
        1,
        "chat.thread.create",
        json!({
            "threadId": "dm-target-thread",
            "title": "Private thread",
            "createdAtMs": 20,
            "channelSlug": "private",
            "channelWireId": "dm-target-wire"
        }),
    );
    apply_chat_envelope(&mut engine, &channel, &NoFaults).expect("DM channel");
    apply_chat_envelope(&mut engine, &thread, &NoFaults).expect("DM thread");
    let follow = envelope(
        "dm-follow-origin",
        0,
        "chat.follow.set",
        json!({
            "ownerUserId": "owner",
            "targetKind": "thread",
            "targetId": "dm-target-thread",
            "state": "following",
            "atMs": 30
        }),
    );

    assert_invalid_refusal!(apply_chat_envelope(&mut engine, &follow, &NoFaults));
    assert_eq!(pending_chat_coordinate_count(&engine), 0);
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "dm-follow-origin").expect("DM follow ack"),
        0
    );
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
        ApplyOutcome::new(ApplyDisposition::Applied(()))
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
                workspace_id: "ws".to_owned(),
                thread_id: "thread-imported".to_owned(),
                message_id: "refused-message-id".to_owned(),
                author_kind: ChatActorKind::Human,
                author_display_name: "Local".to_owned(),
                author_user_id: None,
                parent_message_id: None,
                origin: None,
                body: "This message stays local.".to_owned(),
                needs_decision: true,
                attachments: Vec::new(),
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
                workspace_id: "ws".to_owned(),
                thread_id: "thread-imported".to_owned(),
                message_id: "authored-child".to_owned(),
                author_kind: ChatActorKind::Human,
                author_display_name: "Verified".to_owned(),
                author_user_id: Some("verified-user".to_owned()),
                parent_message_id: Some("refused-message-id".to_owned()),
                origin: None,
                body: "This authored child must not export the local parent.".to_owned(),
                needs_decision: false,
                attachments: Vec::new(),
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
fn refused_thread_log_cannot_suppress_the_current_thread_export() {
    let (_scratch, _path, mut first_peer) = open_store();
    imported_chat_fixture(&mut first_peer, "refused-thread-collision");
    let refused = envelope(
        "refused-thread-collision",
        3,
        "chat.thread.create",
        json!({
            "threadId": "refused-thread-id",
            "title": "Invalid owner shape",
            "createdAtMs": 30,
            "channelSlug": "imported",
            "linkedObjectId": "object-collision",
            "linkedAtMs": 30
        }),
    );
    assert_invalid_refusal!(apply_chat_envelope(&mut first_peer, &refused, &NoFaults));
    let (refused_rows, refused_projection_rows): (i64, i64) = first_peer
        .read_with(|conn| {
            Ok::<_, rusqlite::Error>((
                conn.query_row(
                    "SELECT COUNT(*) FROM replication_log \
                     WHERE workspace_id='ws' AND imported=1 \
                       AND op_kind='chat.thread.create' \
                       AND json_extract(payload_json,'$.threadId')='refused-thread-id'",
                    [],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*) FROM chat_threads \
                     WHERE workspace_id='ws' AND thread_id='refused-thread-id'",
                    [],
                    |row| row.get(0),
                )?,
            ))
        })
        .expect("durable refused-thread state");
    assert_eq!(refused_rows, 1, "the refused envelope remains durable");
    assert_eq!(
        refused_projection_rows, 0,
        "the refused envelope must not create a thread projection"
    );

    LinkedChatStore::new(&mut first_peer)
        .start_channel_thread(
            &StartChannelThread {
                workspace_id: "ws".to_owned(),
                channel_id: "channel-imported".to_owned(),
                thread_id: "refused-thread-id".to_owned(),
                message_id: "message-after-refused-thread".to_owned(),
                title: Some("Valid local thread".to_owned()),
                lane: ChatThreadLane::Posts,
                author_kind: ChatActorKind::Human,
                author_display_name: "Verified".to_owned(),
                author_user_id: Some("verified-user".to_owned()),
                origin: None,
                body: "The valid thread must reach peers first.".to_owned(),
                needs_decision: false,
                attachments: Vec::new(),
                now_ms: 31,
                request_id: Some("local-thread-after-refusal".to_owned()),
            },
            &NoFaults,
        )
        .expect("local thread with a refused remote id");
    LinkedChatStore::new(&mut first_peer)
        .send_message(
            &SendMessage {
                workspace_id: "ws".to_owned(),
                thread_id: "refused-thread-id".to_owned(),
                message_id: "second-message-after-refused-thread".to_owned(),
                author_kind: ChatActorKind::Human,
                author_display_name: "Verified".to_owned(),
                author_user_id: Some("verified-user".to_owned()),
                parent_message_id: None,
                origin: None,
                body: "The thread structure must export only once.".to_owned(),
                needs_decision: false,
                attachments: Vec::new(),
                now_ms: 32,
                request_id: Some("second-local-message-after-refusal".to_owned()),
            },
            &NoFaults,
        )
        .expect("second local message in the collision thread");

    let outbound: Vec<ReplicationEnvelope> = first_peer
        .read_with(|conn| {
            let mut statement = conn.prepare(
                "SELECT operation.origin_id,operation.origin_seq,operation.op_kind, \
                        operation.payload_json,operation.recorded_at_ms \
                 FROM replication_log AS operation \
                 JOIN sync_identity AS identity \
                   ON identity.workspace_id=operation.workspace_id \
                  AND identity.origin_id=operation.origin_id \
                 WHERE operation.workspace_id='ws' AND operation.imported=0 \
                   AND json_extract(operation.payload_json,'$.threadId')='refused-thread-id' \
                 ORDER BY operation.origin_seq",
            )?;
            statement
                .query_map([], |row| {
                    let payload_json: String = row.get(3)?;
                    Ok(ReplicationEnvelope {
                        workspace_id: "ws".to_owned(),
                        origin_id: row.get(0)?,
                        origin_seq: row.get(1)?,
                        op_kind: row.get(2)?,
                        payload: serde_json::from_str(&payload_json).map_err(|error| {
                            rusqlite::Error::FromSqlConversionFailure(
                                payload_json.len(),
                                rusqlite::types::Type::Text,
                                Box::new(error),
                            )
                        })?,
                        recorded_at_ms: row.get(4)?,
                        relay_seq: None,
                    })
                })?
                .collect::<rusqlite::Result<Vec<_>>>()
        })
        .expect("outbound thread and message envelopes");
    assert_eq!(
        outbound
            .iter()
            .map(|operation| operation.op_kind.as_str())
            .collect::<Vec<_>>(),
        vec![
            "chat.thread.create",
            "chat.message.append",
            "chat.message.append"
        ],
        "the current origin must export one valid structure before its messages"
    );

    let (_second_scratch, _second_path, mut second_peer) = open_store();
    for operation in &outbound {
        assert_eq!(
            apply_chat_envelope(&mut second_peer, operation, &NoFaults)
                .expect("apply collision recovery envelope"),
            ApplyOutcome::new(ApplyDisposition::Applied(()))
        );
    }
    let (message_body, message_rows, pending_rows): (String, i64, i64) = second_peer
        .read_with(|conn| {
            Ok::<_, rusqlite::Error>((
                conn.query_row(
                    "SELECT body FROM chat_messages \
                     WHERE workspace_id='ws' AND thread_id='refused-thread-id' \
                       AND message_id='message-after-refused-thread'",
                    [],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*) FROM chat_messages \
                     WHERE workspace_id='ws' AND thread_id='refused-thread-id'",
                    [],
                    |row| row.get(0),
                )?,
                conn.query_row("SELECT COUNT(*) FROM chat_pending_replication", [], |row| {
                    row.get(0)
                })?,
            ))
        })
        .expect("second-peer collision recovery state");
    assert_eq!(
        message_body, "The valid thread must reach peers first.",
        "the peer must apply the message after resolving its current thread"
    );
    assert_eq!(message_rows, 2, "both current-origin messages must apply");
    assert_eq!(pending_rows, 0, "the message must not remain parked");
}

#[test]
fn imported_message_refuses_unsafe_created_at_ms_without_row_and_acks() {
    let (_scratch, _path, mut engine) = open_store();
    imported_chat_fixture(&mut engine, "unsafe-message-time");
    let operation = envelope(
        "unsafe-message-time",
        3,
        "chat.message.append",
        json!({
            "messageId": "unsafe-message",
            "threadId": "thread-imported",
            "authorKind": "human",
            "authorDisplayName": "Ada",
            "body": "Unsafe timestamp",
            "createdAtMs": i64::MAX
        }),
    );

    assert_invalid_refusal!(apply_chat_envelope(&mut engine, &operation, &NoFaults));
    let row_count: i64 = engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM chat_messages WHERE workspace_id='ws' AND message_id='unsafe-message'",
                [],
                |row| row.get(0),
            )
            .map_err(dohc_engine_storage::StorageError::corrupt_public)
        })
        .expect("message row count");
    assert_eq!(row_count, 0);
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "unsafe-message-time").expect("ack"),
        3
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
            primary: ApplyDisposition::Applied(()),
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
            primary: ApplyDisposition::Applied(()),
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
fn imported_thread_header_message_id_cannot_replace_the_search_header() {
    let (_scratch, _path, mut engine) = open_store();
    imported_chat_fixture(&mut engine, "thread-header");
    engine
        .write_with(&NoFaults, |tx| {
            upsert_chat_search_index_row(
                tx,
                "ws",
                "thread-imported",
                CHAT_THREAD_HEADER_MESSAGE_ID,
                "Imported thread",
            )
            .map_err(SyncError::persist)
        })
        .expect("seed thread header search row");

    let collision = envelope(
        "thread-header",
        3,
        "chat.message.append",
        json!({
            "messageId": CHAT_THREAD_HEADER_MESSAGE_ID,
            "threadId": "thread-imported",
            "authorKind": "human",
            "authorDisplayName": "Attacker",
            "body": "replacement search text",
            "createdAtMs": 30
        }),
    );
    let result = apply_chat_envelope(&mut engine, &collision, &NoFaults);

    let imported_collision: Option<(String, String)> = engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT author_display_name,body FROM chat_messages \
                 WHERE workspace_id='ws' AND thread_id='thread-imported' AND message_id='__thread__'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
        })
        .expect("collision message lookup");
    if let Some((display_name, body)) = imported_collision {
        engine
            .write_with(&NoFaults, |tx| {
                upsert_chat_search_index_row(
                    tx,
                    "ws",
                    "thread-imported",
                    CHAT_THREAD_HEADER_MESSAGE_ID,
                    &format!("{display_name}\n{body}"),
                )
                .map_err(SyncError::persist)
            })
            .expect("run the message indexing primitive");
    }

    let header_text: String = engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT text FROM engine_search_chat_messages_fts \
                 WHERE workspace_id='ws' AND thread_id='thread-imported' AND message_id='__thread__'",
                [],
                |row| row.get(0),
            )
        })
        .expect("thread header search row");
    assert_eq!(header_text, "Imported thread");
    assert_invalid_refusal!(result);
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "thread-header").expect("ack"),
        3
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
            primary: ApplyDisposition::Applied(()),
            refusals: ref outcome_refusals,
            sharing_declined: ref outcome_sharing_declined,
        }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
    ));
    assert!(matches!(
        apply_chat_envelope(&mut engine, &message, &NoFaults),
        Ok(ApplyOutcome {
            primary: ApplyDisposition::Applied(()),
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
fn replicated_untitled_thread_without_messages_matches_rebuild_fallback() {
    let (_scratch, _path, mut engine) = open_store();
    let thread = envelope(
        "fallback-peer",
        0,
        "chat.thread.create",
        json!({
            "threadId": "fallback-thread",
            "title": "",
            "createdAtMs": 10,
            "channelSlug": "fallback"
        }),
    );
    apply_chat_envelope(&mut engine, &thread, &NoFaults).expect("thread");

    let header: String = engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT text FROM engine_search_chat_messages_fts \
                 WHERE workspace_id='ws' AND thread_id='fallback-thread' AND message_id='__thread__'",
                [],
                |row| row.get(0),
            )
        })
        .expect("fallback thread search header");
    let rebuild_fallback = chat_thread_display_title("", None);
    assert_eq!(
        header.as_bytes(),
        rebuild_fallback.as_bytes(),
        "write-time and rebuild headers must be byte-identical"
    );
}

#[test]
fn replicated_untitled_thread_indexes_its_first_message_snippet() {
    let (_scratch, _path, mut engine) = open_store();
    let thread = envelope(
        "snippet-peer",
        0,
        "chat.thread.create",
        json!({
            "threadId": "snippet-thread",
            "title": "",
            "createdAtMs": 10,
            "linkedObjectId": "snippet-object",
            "linkedAtMs": 10
        }),
    );
    let message = envelope(
        "snippet-peer",
        1,
        "chat.message.append",
        json!({
            "messageId": "snippet-message",
            "threadId": "snippet-thread",
            "authorKind": "human",
            "authorDisplayName": "Ice",
            "body": "First replicated snippet\nwith more detail",
            "createdAtMs": 20
        }),
    );
    apply_chat_envelope(&mut engine, &thread, &NoFaults).expect("thread");
    apply_chat_envelope(&mut engine, &message, &NoFaults).expect("message");

    let header: String = engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT text FROM engine_search_chat_messages_fts \
                 WHERE workspace_id='ws' AND thread_id='snippet-thread' AND message_id='__thread__'",
                [],
                |row| row.get(0),
            )
        })
        .expect("derived thread search header");
    assert_eq!(header, "First replicated snippet");
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
fn imported_channel_create_reuses_the_local_channel_id_rule() {
    for (origin, channel_id) in [
        ("long-channel-id", "x".repeat(257)),
        ("padded-channel-id", " padded-channel ".to_owned()),
    ] {
        let (_scratch, _path, mut engine) = open_store();
        let operation = envelope(
            origin,
            0,
            "chat.channel.create",
            json!({
                "channelId": channel_id,
                "name": "Bounded",
                "slug": "bounded",
                "kind": "channel",
                "createdAtMs": 1
            }),
        );
        assert_invalid_refusal!(apply_chat_envelope(&mut engine, &operation, &NoFaults));
        let channel_count: i64 = engine
            .read_with(|conn| {
                conn.query_row("SELECT COUNT(*) FROM chat_channels", [], |row| row.get(0))
            })
            .expect("channel count");
        assert_eq!(channel_count, 0);
        assert_eq!(
            read_replication_acked_seq(&engine, "ws", origin).expect("ack"),
            0
        );
    }
}

#[test]
fn imported_channel_create_refuses_reserved_local_channel_ids() {
    for (origin, channel_id) in [
        ("reserved-general-id", GENERAL_CHANNEL_WIRE_ID),
        ("reserved-agent-id", AGENT_CHANNEL_WIRE_ID),
    ] {
        let (_scratch, _path, mut engine) = open_store();
        let operation = envelope(
            origin,
            0,
            "chat.channel.create",
            json!({
                "channelId": channel_id,
                "name": "Ordinary",
                "slug": "ordinary",
                "kind": "channel",
                "createdAtMs": 1
            }),
        );
        assert_invalid_refusal!(apply_chat_envelope(&mut engine, &operation, &NoFaults));
        let channel_count: i64 = engine
            .read_with(|conn| {
                conn.query_row("SELECT COUNT(*) FROM chat_channels", [], |row| row.get(0))
            })
            .expect("channel count");
        assert_eq!(channel_count, 0);
        assert_eq!(
            read_replication_acked_seq(&engine, "ws", origin).expect("ack"),
            0
        );
    }
}

#[test]
fn imported_channel_name_uses_local_nfc_and_utf16_validation() {
    let (_scratch, _path, mut engine) = open_store();
    let decomposed = envelope(
        "channel-name",
        0,
        "chat.channel.create",
        json!({
            "channelId": "channel-nfc",
            "name": "Cafe\u{301}",
            "slug": "cafe",
            "kind": "channel",
            "createdAtMs": 1
        }),
    );
    assert!(matches!(
        apply_chat_envelope(&mut engine, &decomposed, &NoFaults),
        Ok(ApplyOutcome {
            primary: ApplyDisposition::Applied(()),
            refusals: ref outcome_refusals,
            sharing_declined: ref outcome_sharing_declined,
        }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
    ));
    let stored_name: String = engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT name FROM chat_channels WHERE workspace_id='ws' AND channel_id='channel-nfc'",
                [],
                |row| row.get(0),
            )
        })
        .expect("normalized channel name");
    assert_eq!(stored_name, "Café");

    let overlong = envelope(
        "overlong-channel-name",
        0,
        "chat.channel.create",
        json!({
            "channelId": "channel-overlong",
            "name": "x".repeat(81),
            "slug": "x".repeat(81),
            "kind": "channel",
            "createdAtMs": 1
        }),
    );
    assert_invalid_refusal!(apply_chat_envelope(&mut engine, &overlong, &NoFaults));
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "overlong-channel-name").expect("ack"),
        0
    );
}

#[test]
fn imported_channel_slug_is_validated_but_derived_from_the_normalized_name() {
    let (_scratch, _path, mut engine) = open_store();
    let caller_slug = envelope(
        "derived-channel-slug",
        0,
        "chat.channel.create",
        json!({
            "channelId": "channel-derived",
            "name": "Canonical Name",
            "slug": "attacker-chosen",
            "kind": "channel",
            "createdAtMs": 1
        }),
    );
    assert!(matches!(
        apply_chat_envelope(&mut engine, &caller_slug, &NoFaults),
        Ok(ApplyOutcome {
            primary: ApplyDisposition::Applied(()),
            refusals: ref outcome_refusals,
            sharing_declined: ref outcome_sharing_declined,
        }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
    ));
    let stored_slug: String = engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT slug FROM chat_channels WHERE workspace_id='ws' AND channel_id='channel-derived'",
                [],
                |row| row.get(0),
            )
        })
        .expect("derived channel slug");
    assert_eq!(stored_slug, "canonical-name");

    let malformed_slug = envelope(
        "invalid-channel-slug",
        0,
        "chat.channel.create",
        json!({
            "channelId": "channel-invalid-slug",
            "name": "Valid Name",
            "slug": "NOT VALID",
            "kind": "channel",
            "createdAtMs": 1
        }),
    );
    assert_invalid_refusal!(apply_chat_envelope(&mut engine, &malformed_slug, &NoFaults));
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "invalid-channel-slug").expect("ack"),
        0
    );
}

#[test]
fn imported_attachment_requires_its_workspace_thread_message_without_fabricating_a_row() {
    let (_scratch, _path, mut engine) = open_store();
    imported_chat_fixture(&mut engine, "attachment-owner");
    let fabricated = envelope(
        "attachment-owner",
        3,
        "chat.attachment.add",
        json!({
            "attachmentId": attachment_id_for("missing-message", "object", None, None),
            "threadId": "thread-imported",
            "messageId": "missing-message",
            "targetKind": "file",
            "objectId": "object",
            "createdAtMs": 30
        }),
    );
    let result = apply_chat_envelope(&mut engine, &fabricated, &NoFaults);
    let attachment_count: i64 = engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM chat_attachments \
                 WHERE workspace_id='ws' AND thread_id='thread-imported' AND message_id='missing-message'",
                [],
                |row| row.get(0),
            )
        })
        .expect("fabricated attachment count");
    assert_eq!(
        attachment_count, 0,
        "no fabricated attachment row may survive"
    );
    assert_eq!(
        result.expect("park missing attachment"),
        ApplyOutcome::new(ApplyDisposition::Applied(()))
    );
    assert_eq!(pending_chat_coordinate_count(&engine), 1);
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "attachment-owner").expect("attachment ack"),
        3
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
        ApplyOutcome::new(ApplyDisposition::Applied(()))
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
        ApplyOutcome::new(ApplyDisposition::Applied(()))
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
fn imported_authored_fields_reuse_local_display_and_author_id_bounds() {
    for (origin, field, value) in [
        (
            "message-display-bound",
            "authorDisplayName",
            "x".repeat(201),
        ),
        ("message-author-bound", "authorUserId", "x".repeat(201)),
    ] {
        let (_scratch, _path, mut engine) = open_store();
        imported_chat_fixture(&mut engine, origin);
        let mut payload = json!({
            "messageId": format!("message-{origin}"),
            "threadId": "thread-imported",
            "authorKind": "human",
            "authorDisplayName": "Ada",
            "authorUserId": "user",
            "body": "Body",
            "createdAtMs": 30
        });
        payload[field] = json!(value);
        let operation = envelope(origin, 3, "chat.message.append", payload);
        assert_invalid_refusal!(apply_chat_envelope(&mut engine, &operation, &NoFaults));
        assert_eq!(
            read_replication_acked_seq(&engine, "ws", origin).expect("message refusal ack"),
            3
        );
    }

    for (origin, field, value) in [
        (
            "reaction-display-bound",
            "authorDisplayName",
            "x".repeat(201),
        ),
        ("reaction-author-bound", "authorId", "x".repeat(201)),
    ] {
        let (_scratch, _path, mut engine) = open_store();
        let mut payload = reaction_payload("added", "👍", 1, "user");
        payload[field] = json!(value);
        let operation = envelope(origin, 0, "chat.reaction.set", payload);
        assert_invalid_refusal!(apply_chat_envelope(&mut engine, &operation, &NoFaults));
        assert_eq!(
            read_replication_acked_seq(&engine, "ws", origin).expect("reaction refusal ack"),
            0
        );
    }
}

#[test]
fn imported_follow_set_refuses_unbounded_or_empty_identities() {
    for (owner, target) in [
        ("".to_owned(), "target".to_owned()),
        ("owner".to_owned(), "".to_owned()),
        ("😀".repeat(129), "target".to_owned()),
        ("owner".to_owned(), "😀".repeat(129)),
    ] {
        let (_scratch, _path, mut engine) = open_store();
        let operation = envelope(
            "invalid-follow",
            0,
            "chat.follow.set",
            json!({
                "ownerUserId": owner,
                "targetKind": "person",
                "targetId": target,
                "state": "following",
                "atMs": -1
            }),
        );
        assert_invalid_refusal!(apply_chat_envelope(&mut engine, &operation, &NoFaults));
    }
}

#[test]
fn imported_follow_refuses_unsafe_at_ms_without_row_and_acks() {
    let (_scratch, _path, mut engine) = open_store();
    let operation = envelope(
        "unsafe-follow-time",
        0,
        "chat.follow.set",
        json!({
            "ownerUserId": "owner",
            "targetKind": "person",
            "targetId": "target",
            "state": "following",
            "atMs": i64::MAX
        }),
    );

    assert_invalid_refusal!(apply_chat_envelope(&mut engine, &operation, &NoFaults));
    let row_count: i64 = engine
        .read_with(|conn| {
            conn.query_row("SELECT COUNT(*) FROM chat_follows", [], |row| row.get(0))
                .map_err(dohc_engine_storage::StorageError::corrupt_public)
        })
        .expect("follow row count");
    assert_eq!(
        row_count, 0,
        "dropping the persisted-safe bound persists an LWW value that follow-bearing JavaScript responses cannot represent."
    );
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "unsafe-follow-time").expect("ack"),
        0
    );
}

#[test]
fn imported_feed_read_set_refuses_unbounded_or_empty_identities() {
    for (owner, message) in [
        ("".to_owned(), "message".to_owned()),
        ("owner".to_owned(), "".to_owned()),
        ("😀".repeat(129), "message".to_owned()),
        ("owner".to_owned(), "😀".repeat(129)),
    ] {
        let (_scratch, _path, mut engine) = open_store();
        let operation = envelope(
            "invalid-feed-read",
            0,
            "chat.feed.read.set",
            json!({
                "ownerUserId": owner,
                "lastSeenCreatedAtMs": -2,
                "lastSeenMessageId": message,
                "atMs": -1
            }),
        );
        assert_invalid_refusal!(apply_chat_envelope(&mut engine, &operation, &NoFaults));
    }
}

#[test]
fn imported_feed_read_refuses_unsafe_timestamps_without_row_and_acks() {
    for (origin, last_seen_created_at_ms, at_ms) in [
        ("unsafe-feed-read-time", 1, i64::MAX),
        ("unsafe-feed-read-cursor", i64::MAX, 1),
    ] {
        let (_scratch, _path, mut engine) = open_store();
        let operation = envelope(
            origin,
            0,
            "chat.feed.read.set",
            json!({
                "ownerUserId": "owner",
                "lastSeenCreatedAtMs": last_seen_created_at_ms,
                "lastSeenMessageId": "message",
                "atMs": at_ms
            }),
        );

        assert_invalid_refusal!(apply_chat_envelope(&mut engine, &operation, &NoFaults));
        let row_count: i64 = engine
            .read_with(|conn| {
                conn.query_row("SELECT COUNT(*) FROM chat_feed_read_state", [], |row| {
                    row.get(0)
                })
                .map_err(dohc_engine_storage::StorageError::corrupt_public)
            })
            .expect("feed read row count");
        assert_eq!(row_count, 0);
        assert_eq!(
            read_replication_acked_seq(&engine, "ws", origin).expect("ack"),
            0
        );
    }
}

fn live_bookmark(engine: &mut EngineStore) -> String {
    LinkedChatStore::new(engine)
        .save_bookmark(
            &SaveBookmark {
                workspace_id: "ws".to_owned(),
                owner_user_id: "owner".to_owned(),
                target_kind: BookmarkTargetKind::Thread,
                target_id: "thread-imported".to_owned(),
                mode: BookmarkMode::Live,
                destination_path: "bookmarks/imported.md".to_owned(),
                now_ms: 30,
            },
            &NoFaults,
        )
        .expect("bookmark")
        .bookmark_id
}

#[test]
fn imported_message_requeues_active_live_bookmarks() {
    let (_scratch, _path, mut engine) = open_store();
    imported_chat_fixture(&mut engine, "message-bookmark");
    let bookmark_id = live_bookmark(&mut engine);
    engine
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "UPDATE chat_bookmark_outbox SET projection_state='failed',failure_reason='old' \
                 WHERE workspace_id='ws' AND bookmark_id=?1",
                [&bookmark_id],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .expect("failed outbox");
    let message = envelope(
        "message-bookmark",
        3,
        "chat.message.append",
        json!({
            "messageId": "message-imported-2",
            "threadId": "thread-imported",
            "authorKind": "human",
            "authorDisplayName": "Ada",
            "body": "Reply",
            "createdAtMs": 40
        }),
    );
    apply_chat_envelope(&mut engine, &message, &NoFaults).expect("message");
    let state: (i64, String, Option<String>, i64) = engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT generation,projection_state,failure_reason,updated_at_ms \
                 FROM chat_bookmark_outbox WHERE workspace_id='ws' AND bookmark_id=?1",
                [&bookmark_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
        })
        .expect("outbox");
    assert_eq!(
        state,
        (2, "pending".to_owned(), None, 40),
        "omit the receiver-local bump from imported message apply -> stale generation/state remains."
    );
}

#[test]
fn imported_message_indexes_mentions_only_when_inserted() {
    let (_scratch, _path, mut engine) = open_store();
    imported_chat_fixture(&mut engine, "mention-index");
    let first = envelope(
        "mention-index",
        3,
        "chat.message.append",
        json!({
            "messageId": "mention-message",
            "threadId": "thread-imported",
            "authorKind": "human",
            "authorDisplayName": "Ada",
            "body": "hello @one",
            "createdAtMs": 40
        }),
    );
    let duplicate_id = envelope(
        "mention-index",
        4,
        "chat.message.append",
        json!({
            "messageId": "mention-message",
            "threadId": "thread-imported",
            "authorKind": "human",
            "authorDisplayName": "Ada",
            "body": "hostile duplicate @two",
            "createdAtMs": 50
        }),
    );
    apply_chat_envelope(&mut engine, &first, &NoFaults).expect("first message");
    apply_chat_envelope(&mut engine, &duplicate_id, &NoFaults).expect("duplicate id");
    let handles: Vec<String> = engine
        .read_with(|conn| {
            let mut stmt = conn.prepare(
                "SELECT handle FROM chat_mentions WHERE message_id='mention-message' ORDER BY handle",
            )?;
            stmt.query_map([], |row| row.get(0))?.collect()
        })
        .expect("mention handles");
    assert_eq!(
        handles,
        vec!["one"],
        "indexing before checking INSERT OR IGNORE admits the duplicate payload's handle."
    );
}

#[test]
fn imported_attachment_cross_origin_duplicate_requeues_active_live_bookmarks() {
    let (_scratch, _path, mut engine) = open_store();
    imported_chat_fixture(&mut engine, "attachment-bookmark");
    let bookmark_id = live_bookmark(&mut engine);
    let attachment = envelope(
        "attachment-peer",
        0,
        "chat.attachment.add",
        json!({
            "attachmentId": attachment_id_for("message-imported", "object", None, None),
            "threadId": "thread-imported",
            "messageId": "message-imported",
            "targetKind": "file",
            "objectId": "object",
            "pathHint": "notes/file.md",
            "createdAtMs": 41
        }),
    );
    apply_chat_envelope(&mut engine, &attachment, &NoFaults).expect("attachment");
    let state: (i64, String, i64) = engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT generation,projection_state,updated_at_ms FROM chat_bookmark_outbox \
                 WHERE workspace_id='ws' AND bookmark_id=?1",
                [&bookmark_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
        })
        .expect("outbox");
    assert_eq!(
        state,
        (2, "pending".to_owned(), 41),
        "omit the receiver-local bump from imported attachment apply -> bookmark is not reprojected."
    );

    let cross_origin_duplicate = envelope(
        "attachment-peer-two",
        0,
        "chat.attachment.add",
        attachment.payload.clone(),
    );
    apply_chat_envelope(&mut engine, &cross_origin_duplicate, &NoFaults)
        .expect("cross-origin duplicate");
    let duplicated: i64 = engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT generation FROM chat_bookmark_outbox \
                 WHERE workspace_id='ws' AND bookmark_id=?1",
                [&bookmark_id],
                |row| row.get(0),
            )
        })
        .expect("outbox after cross-origin duplicate");
    assert_eq!(
        duplicated, 3,
        "gate the bump on INSERT OR IGNORE's affected-row count -> this reachable duplicate stays at 2."
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

#[test]
fn chat_reaction_lww_converges_across_origin_arrival_order() {
    let (_a, _path_a, mut first) = open_store();
    let (_b, _path_b, mut second) = open_store();
    let low = envelope(
        "a",
        0,
        "chat.reaction.set",
        json!({"reactionId":"r","messageId":"m","threadId":"t","emoji":"👍","authorId":"u","authorKind":"human","authorDisplayName":"U","atMs":10,"state":"added"}),
    );
    let high = envelope(
        "b",
        0,
        "chat.reaction.set",
        json!({"reactionId":"r","messageId":"m","threadId":"t","emoji":"👍","authorId":"u","authorKind":"human","authorDisplayName":"U","atMs":20,"state":"removed"}),
    );
    apply_chat_envelope(&mut first, &high, &NoFaults).expect("high first");
    apply_chat_envelope(&mut first, &low, &NoFaults).expect("low second");
    apply_chat_envelope(&mut second, &low, &NoFaults).expect("low first");
    apply_chat_envelope(&mut second, &high, &NoFaults).expect("high second");
    let read = |store: &EngineStore| {
        store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT state,at_ms,origin_id,origin_seq FROM chat_reactions WHERE workspace_id='ws'",
                    [],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?, row.get::<_, String>(2)?, row.get::<_, i64>(3)?)),
                )
            })
            .expect("reaction")
    };
    assert_eq!(read(&first), read(&second));
    assert_eq!(read(&first).0, "removed");
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
            primary: ApplyDisposition::Applied(()),
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
            primary: ApplyDisposition::Applied(()),
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
            primary: ApplyDisposition::Applied(()),
            refusals: ref outcome_refusals,
            sharing_declined: ref outcome_sharing_declined,
        }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
    ));
}
