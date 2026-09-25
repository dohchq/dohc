use super::*;

fn journal_test_op(engine: &mut EngineStore, op_kind: &str, payload: &serde_json::Value) -> i64 {
    match journal_local_replication_op(
        engine, "ws", "local", "epoch-1", "stream-1", op_kind, payload, 2_000, &NoFaults,
    )
    .expect("journal test op")
    {
        TxnOutcome::Committed(origin_seq) => origin_seq,
        TxnOutcome::Crashed { .. } => panic!("no faults were injected"),
    }
}

fn journal_lww_ops(engine: &mut EngineStore) -> (i64, i64, i64, i64) {
    let reaction_seq = journal_test_op(
        engine,
        "chat.reaction.set",
        &json!({
            "reactionId": "recovery-reaction",
            "messageId": "safe-message",
            "threadId": "recovery-thread",
            "emoji": "👍",
            "authorId": "user-1",
            "authorKind": "human",
            "authorDisplayName": "User 1",
            "atMs": 2_001,
            "state": "added"
        }),
    );
    journal_test_op(
        engine,
        "chat.decision.set",
        &json!({
            "messageId": "safe-message",
            "threadId": "recovery-thread",
            "state": "open",
            "atMs": 2_002
        }),
    );
    let follow_seq = journal_test_op(
        engine,
        "chat.follow.set",
        &json!({
            "ownerUserId": "user-1",
            "targetKind": "thread",
            "targetId": "recovery-thread",
            "state": "following",
            "atMs": 2_003
        }),
    );
    let feed_seq = journal_test_op(
        engine,
        "chat.feed.read.set",
        &json!({
            "ownerUserId": "user-1",
            "lastSeenCreatedAtMs": 2_000,
            "lastSeenMessageId": "safe-message",
            "atMs": 2_004
        }),
    );
    let decision_seq = journal_test_op(
        engine,
        "chat.decision.set",
        &json!({
            "messageId": "safe-message",
            "threadId": "recovery-thread",
            "state": "resolved",
            "resolvedByMessageId": "safe-message",
            "atMs": 2_005
        }),
    );
    (reaction_seq, decision_seq, follow_seq, feed_seq)
}

fn seed_lww_projections(
    engine: &mut EngineStore,
    origin_id: &str,
    reaction_seq: i64,
    decision_seq: i64,
    follow_seq: i64,
    feed_seq: i64,
) {
    engine
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT INTO chat_reactions \
                 (workspace_id,reaction_id,thread_id,message_id,emoji,author_id,author_kind, \
                  author_display_name,state,at_ms,origin_id,origin_seq) \
                 VALUES ('ws','recovery-reaction','recovery-thread','safe-message','👍','user-1', \
                         'human','User 1','added',2001,?1,?2)",
                params![origin_id, reaction_seq],
            )
            .map_err(SyncError::persist)?;
            tx.execute(
                "INSERT INTO chat_decisions \
                 (workspace_id,thread_id,message_id,state,resolved_by_message_id,at_ms,origin_id,origin_seq) \
                 VALUES ('ws','recovery-thread','safe-message','resolved','safe-message',2005,?1,?2)",
                params![origin_id, decision_seq],
            )
            .map_err(SyncError::persist)?;
            tx.execute(
                "INSERT INTO chat_follows \
                 (workspace_id,owner_user_id,target_kind,target_id,state,updated_at_ms,origin_id,origin_seq) \
                 VALUES ('ws','user-1','thread','recovery-thread','following',2003,?1,?2)",
                params![origin_id, follow_seq],
            )
            .map_err(SyncError::persist)?;
            tx.execute(
                "INSERT INTO chat_feed_read_state \
                 (workspace_id,owner_user_id,last_seen_created_at_ms,last_seen_message_id,updated_at_ms, \
                  origin_id,origin_seq) \
                 VALUES ('ws','user-1',2000,'safe-message',2004,?1,?2)",
                params![origin_id, feed_seq],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .expect("seed LWW projections");
}

fn lww_projection_coordinates(engine: &EngineStore) -> BTreeMap<String, (String, i64)> {
    engine
        .read_with(|conn| {
            let mut coordinates = BTreeMap::new();
            for (op_kind, query) in [
                (
                    "chat.reaction.set",
                    "SELECT origin_id,origin_seq FROM chat_reactions \
                     WHERE workspace_id='ws' AND reaction_id='recovery-reaction'",
                ),
                (
                    "chat.decision.set",
                    "SELECT origin_id,origin_seq FROM chat_decisions \
                     WHERE workspace_id='ws' AND message_id='safe-message'",
                ),
                (
                    "chat.follow.set",
                    "SELECT origin_id,origin_seq FROM chat_follows \
                     WHERE workspace_id='ws' AND owner_user_id='user-1' \
                       AND target_kind='thread' AND target_id='recovery-thread'",
                ),
                (
                    "chat.feed.read.set",
                    "SELECT origin_id,origin_seq FROM chat_feed_read_state \
                     WHERE workspace_id='ws' AND owner_user_id='user-1'",
                ),
            ] {
                coordinates.insert(
                    op_kind.to_owned(),
                    conn.query_row(query, [], |row| Ok((row.get(0)?, row.get(1)?)))?,
                );
            }
            Ok::<_, rusqlite::Error>(coordinates)
        })
        .expect("read LWW projection coordinates")
}

fn lww_log_coordinates(engine: &EngineStore, origin_id: &str) -> BTreeMap<String, (String, i64)> {
    engine
        .read_with(|conn| {
            let mut statement = conn.prepare(
                "SELECT op_kind,payload_json,origin_seq FROM replication_log \
                 WHERE workspace_id='ws' AND origin_id=?1 ORDER BY origin_seq",
            )?;
            let rows = statement.query_map([origin_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            })?;
            let mut coordinates = BTreeMap::new();
            for row in rows {
                let (op_kind, payload_json, origin_seq) = row?;
                if !matches!(
                    op_kind.as_str(),
                    "chat.reaction.set"
                        | "chat.decision.set"
                        | "chat.follow.set"
                        | "chat.feed.read.set"
                ) {
                    continue;
                }
                let payload: serde_json::Value = serde_json::from_str(&payload_json)
                    .map_err(|error| rusqlite::Error::ToSqlConversionFailure(error.into()))?;
                if op_kind == "chat.decision.set" && payload["state"] != "resolved" {
                    continue;
                }
                coordinates.insert(op_kind, (origin_id.to_owned(), origin_seq));
            }
            Ok::<_, rusqlite::Error>(coordinates)
        })
        .expect("read LWW log coordinates")
}

fn seed_recovery_decision_conflict(
    engine: &mut EngineStore,
    peer_origin_id: &str,
    local_is_current_winner: bool,
) -> ReplicationEnvelope {
    seed_identity(engine);
    let peer_operation = envelope(
        peer_origin_id,
        0,
        "chat.decision.set",
        json!({
            "messageId": "conflicted-decision",
            "threadId": "recovery-thread",
            "state": "resolved",
            "resolvedByMessageId": "peer-resolver",
            "atMs": 2_100
        }),
    );
    assert_eq!(
        apply_chat_envelope(engine, &peer_operation, &NoFaults).expect("apply peer decision"),
        ApplyOutcome::new(ApplyDisposition::Applied(Vec::new()))
    );
    let local_seq = journal_test_op(
        engine,
        "chat.decision.set",
        &json!({
            "messageId": "conflicted-decision",
            "threadId": "recovery-thread",
            "state": "resolved",
            "resolvedByMessageId": "local-resolver",
            "atMs": 2_100
        }),
    );
    assert_eq!(local_seq, 1);
    if local_is_current_winner {
        engine
            .write_with(&NoFaults, |tx| {
                tx.execute(
                    "UPDATE chat_decisions SET resolved_by_message_id='local-resolver', \
                     origin_id='local',origin_seq=?1 \
                     WHERE workspace_id='ws' AND message_id='conflicted-decision'",
                    [local_seq],
                )
                .map_err(SyncError::persist)?;
                Ok::<_, SyncError>(())
            })
            .expect("seed local decision winner");
    }
    peer_operation
}

fn recover_local_origin(engine: &mut EngineStore, new_origin_id: &str) {
    RelaySyncClient::new(PagedRelay::new([(
        0,
        PullResponse {
            ops: vec![ReplicationEnvelope {
                workspace_id: "ws".to_owned(),
                origin_id: "local".to_owned(),
                origin_seq: 0,
                op_kind: "probe.local".to_owned(),
                payload: json!({}),
                recorded_at_ms: 1_000,
                relay_seq: Some(0),
            }],
            next_cursor: 1,
            has_more: false,
        },
    )]))
    .recover_origin(engine, "ws", new_origin_id, &NoFaults)
    .expect("recover conflicted decision origin");
}

fn conflicted_decision_projection(engine: &EngineStore) -> (Option<String>, String, i64) {
    engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT resolved_by_message_id,origin_id,origin_seq FROM chat_decisions \
                 WHERE workspace_id='ws' AND message_id='conflicted-decision'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
        })
        .expect("read conflicted decision projection")
}

fn rebased_decision_operation(engine: &EngineStore, origin_id: &str) -> ReplicationEnvelope {
    list_replication_ops(engine, "ws", origin_id, -1, 10)
        .expect("list rebased decision operation")
        .into_iter()
        .find(|operation| operation.op_kind == "chat.decision.set")
        .expect("rebased decision operation")
}

#[test]
fn recover_origin_continues_an_advancing_stream_past_the_pull_page_ceiling() {
    let (_scratch, _path, mut engine) = open_store();
    seed_identity(&mut engine);
    let pages = (0..=crate::model::MAX_PULL_PAGES_PER_PASS)
        .map(|cursor| {
            let cursor = i64::try_from(cursor).expect("cursor");
            (
                cursor,
                PullResponse {
                    ops: vec![envelope(
                        &format!("unrelated-{cursor}"),
                        0,
                        "opaque.test",
                        json!({}),
                    )],
                    next_cursor: cursor + 1,
                    has_more: cursor
                        < i64::try_from(crate::model::MAX_PULL_PAGES_PER_PASS)
                            .expect("page ceiling"),
                },
            )
        })
        .collect::<Vec<_>>();
    let client = RelaySyncClient::new(PagedRelay::new(pages));

    let recovered = client
        .recover_origin(&mut engine, "ws", "recovered-origin", &NoFaults)
        .expect("recovery must resume through every advancing page");
    assert_eq!(recovered.shared_prefix_length, 0);
    assert_eq!(
        client.transport().pulls.lock().expect("pull calls").len(),
        crate::model::MAX_PULL_PAGES_PER_PASS + 1,
        "restoring the recover page ceiling rejects before the terminal page"
    );
}

#[test]
fn cloned_engines_capture_distinct_moments_and_converge_after_origin_recovery() {
    let (source_scratch, source_path, mut source) = open_store();
    seed_identity(&mut source);
    VersionedTextStore::new(&mut source)
        .ensure_main_version("ws", "main", 1_000, &NoFaults)
        .expect("main version");
    let capture = |engine: &mut EngineStore, text: &str, now_ms: i64| {
        let result = VersionedTextStore::new(engine)
            .capture_ingest(
                &dohc_engine_domain::CaptureIngest {
                    workspace_id: "ws".to_owned(),
                    version_id: "main".to_owned(),
                    path: "notes/cloned.md".to_owned(),
                    text: text.to_owned(),
                    metadata_origin: "capture".to_owned(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: None,
                    now_ms,
                    request_id: None,
                    claim_foreign_head: true,
                },
                &NoFaults,
            )
            .expect("capture cloned path");
        let journaled = engine
            .write_with(&NoFaults, |tx| {
                journal_moment_append_in_tx(tx, "ws", &result.moment.moment_id)
            })
            .expect("journal captured moment");
        assert_eq!(journaled, TxnOutcome::Committed(()));
        result
    };
    capture(&mut source, "shared base", 1_100);
    drop(source);

    let clone_scratch = ScratchDir::new().expect("clone scratch");
    let clone_path = engine_db_path(&clone_scratch).expect("clone db path");
    std::fs::copy(&source_path, &clone_path).expect("clone engine database");
    let mut left = EngineStore::open(&source_path, 1_200).expect("open original engine");
    let mut right = EngineStore::open(&clone_path, 1_200).expect("open cloned engine");

    let left_capture = capture(&mut left, "edit from original", 1_200);
    let right_capture = capture(&mut right, "edit from clone", 1_200);
    assert_eq!(
        left_capture.moment.moment_order,
        right_capture.moment.moment_order
    );
    assert_ne!(
        left_capture.moment.moment_id, right_capture.moment.moment_id,
        "the content-bound capture id must separate divergent cloned writes before recovery"
    );

    let original_stream =
        list_replication_ops(&left, "ws", "local", -1, 10).expect("original stream");
    let recovery = RelaySyncClient::new(PagedRelay::new([(
        0,
        PullResponse {
            next_cursor: i64::try_from(original_stream.len()).expect("stream cursor"),
            has_more: false,
            ops: original_stream.clone(),
        },
    )]));
    let recovered = recovery
        .recover_origin(&mut right, "ws", "recovered-clone", &NoFaults)
        .expect("recover cloned origin");
    assert_eq!(recovered.shared_prefix_length, 2);
    assert_eq!(recovered.preserved_ops, 1);

    let recovered_op = list_replication_ops(&right, "ws", "recovered-clone", -1, 10)
        .expect("recovered clone stream")
        .into_iter()
        .next()
        .expect("recovered clone moment");
    let shared_probe = original_stream[0].clone();
    let shared_base = original_stream[1].clone();
    let original_op = original_stream
        .iter()
        .find(|operation| operation.origin_seq == 2)
        .cloned()
        .expect("original divergent moment");
    assert_ne!(
        recovered_op.payload["momentId"],
        original_op.payload["momentId"]
    );

    let (_peer_a_scratch, _peer_a_path, mut peer_a) = open_store();
    let (_peer_b_scratch, _peer_b_path, mut peer_b) = open_store();
    for engine in [&mut peer_a, &mut peer_b] {
        seed_replication_version(engine, "main", "main");
        engine
            .read_with(|conn| {
                for text in ["shared base", "edit from clone", "edit from original"] {
                    let sha = dohc_engine_storage::hex_sha256(text.as_bytes());
                    conn.execute(
                        "INSERT OR IGNORE INTO blobs (sha256,byte_length,text) VALUES (?1,?2,?3)",
                        params![sha, text.len() as i64, text],
                    )?;
                }
                Ok::<_, rusqlite::Error>(())
            })
            .expect("hydrate peer text");
        assert!(matches!(
            apply_envelope_with(engine, &shared_probe, &NoFaults, insert_probe),
            Ok(ApplyOutcome {
                primary: ApplyDisposition::Applied(()),
                refusals: ref outcome_refusals,
                sharing_declined: ref outcome_sharing_declined,
            }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
        ));
        assert!(matches!(
            apply_moment_envelope(engine, &shared_base, &NoFaults, &NoLiveLeases),
            Ok(ApplyOutcome {
                primary: ApplyDisposition::Applied(_),
                refusals: ref outcome_refusals,
                sharing_declined: ref outcome_sharing_declined,
            }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
        ));
    }
    assert!(matches!(
        apply_moment_envelope(&mut peer_a, &original_op, &NoFaults, &NoLiveLeases),
        Ok(ApplyOutcome {
            primary: ApplyDisposition::Applied(_),
            refusals: ref outcome_refusals,
            sharing_declined: ref outcome_sharing_declined,
        }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
    ));
    assert!(matches!(
        apply_moment_envelope(&mut peer_a, &recovered_op, &NoFaults, &NoLiveLeases),
        Ok(ApplyOutcome {
            primary: ApplyDisposition::Applied(_),
            refusals: ref outcome_refusals,
            sharing_declined: ref outcome_sharing_declined,
        }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
    ));
    assert!(matches!(
        apply_moment_envelope(&mut peer_b, &recovered_op, &NoFaults, &NoLiveLeases),
        Ok(ApplyOutcome {
            primary: ApplyDisposition::Applied(_),
            refusals: ref outcome_refusals,
            sharing_declined: ref outcome_sharing_declined,
        }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
    ));
    assert!(matches!(
        apply_moment_envelope(&mut peer_b, &original_op, &NoFaults, &NoLiveLeases),
        Ok(ApplyOutcome {
            primary: ApplyDisposition::Applied(_),
            refusals: ref outcome_refusals,
            sharing_declined: ref outcome_sharing_declined,
        }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
    ));
    let conflict_ids = |engine: &EngineStore| {
        engine
            .read_with(|conn| {
                let mut statement = conn.prepare(
                    "SELECT conflict_id FROM conflicts WHERE workspace_id='ws' ORDER BY conflict_id",
                )?;
                statement
                    .query_map([], |row| row.get::<_, String>(0))?
                    .collect::<Result<Vec<_>, _>>()
            })
            .expect("conflict ids")
    };
    assert_eq!(conflict_ids(&peer_a), conflict_ids(&peer_b));
    assert_eq!(conflict_ids(&peer_a).len(), 1);

    drop((left, right));
    drop((source_scratch, clone_scratch));
}

#[test]
fn recover_origin_rebases_ydoc_suffix_coordinates_before_repair_and_arbitration() {
    let (_scratch, _path, mut engine) = open_store();
    seed_identity(&mut engine);
    seed_replication_version(&mut engine, "main", "main");
    seed_text_head(
        &mut engine,
        "object-recovered-base",
        "notes/recovered-base.md",
        "restored draft",
    );
    assert!(matches!(
        journal_local_replication_op(
            &mut engine,
            "ws",
            "local",
            "epoch-1",
            "stream-1",
            "probe.shared",
            &json!({}),
            1_001,
            &NoFaults,
        ),
        Ok(TxnOutcome::Committed(1))
    ));

    let key =
        dohc_engine_collab::DocKey::new("ws", "main", "object-recovered-base").expect("doc key");
    let restored = dohc_engine_collab::Ydoc::wire();
    restored.plaintext_insert(0, "restored draft");
    let restored_base = restored.encode_full_state();
    let restored_claim = match dohc_engine_collab::claim_base(
        &mut engine,
        &key,
        dohc_engine_collab::ContentKind::Plaintext,
        &restored_base,
        &NoFaults,
        1_100,
    )
    .expect("claim restored base")
    {
        TxnOutcome::Committed(dohc_engine_collab::ClaimOutcome::Claimed { base_snapshot_sha }) => {
            base_snapshot_sha
        }
        other => panic!("unexpected base claim: {other:?}"),
    };
    let base_payload = crate::ydoc_update_payload(
        &key,
        "notes/recovered-base.md",
        dohc_engine_collab::ContentKind::Plaintext,
        &restored_claim,
        &restored_claim,
        None,
        None,
        true,
    );
    let base_seq = journal_local_replication_op(
        &mut engine,
        "ws",
        "local",
        "epoch-1",
        "stream-1",
        "ydoc.update",
        &base_payload,
        1_100,
        &NoFaults,
    )
    .expect("journal restored base");
    assert_eq!(base_seq, TxnOutcome::Committed(2));
    let delta_bytes = restored.plaintext_insert(14, " plus local delta");
    let delta_sha = engine
        .put_binary_blob(&delta_bytes)
        .expect("store local delta");
    let delta_payload = crate::ydoc_update_payload(
        &key,
        "notes/recovered-base.md",
        dohc_engine_collab::ContentKind::Plaintext,
        &delta_sha,
        &restored_claim,
        None,
        None,
        false,
    );
    let delta_seq = journal_local_replication_op(
        &mut engine,
        "ws",
        "local",
        "epoch-1",
        "stream-1",
        "ydoc.update",
        &delta_payload,
        1_101,
        &NoFaults,
    )
    .expect("journal local delta");
    assert_eq!(delta_seq, TxnOutcome::Committed(3));
    engine
        .write_with(&NoFaults, |tx| {
            dohc_engine_collab::record_base_coordinate_in_tx(
                tx,
                dohc_engine_collab::BaseCoordinateRecord {
                    key: &key,
                    lineage_claim_id: &restored_claim,
                    origin_id: "local",
                    origin_seq: 2,
                    relay_seq: Some(99),
                    now_ms: 1_100,
                },
            )
            .map_err(SyncError::corrupt)?;
            tx.execute(
                "INSERT INTO ydoc_base_relay_candidates (
                     workspace_id,version_id,object_id,lineage_claim_id,origin_id,origin_seq
                 ) VALUES ('ws','main','object-recovered-base',?1,'local',2)",
                [&restored_claim],
            )
            .map_err(SyncError::persist)?;
            tx.execute(
                "INSERT INTO ydoc_deferred_updates (
                     workspace_id,version_id,object_id,origin_id,origin_seq,
                     recorded_at_ms,lineage_claim_id,relay_seq
                 ) VALUES ('ws','main','object-recovered-base','local',3,1101,?1,101)",
                [&restored_claim],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .expect("seed suffix coordinate sidecars");

    let shared_prefix = vec![
        ReplicationEnvelope {
            workspace_id: "ws".to_owned(),
            origin_id: "local".to_owned(),
            origin_seq: 0,
            relay_seq: Some(0),
            op_kind: "probe.local".to_owned(),
            payload: json!({}),
            recorded_at_ms: 1_000,
        },
        ReplicationEnvelope {
            workspace_id: "ws".to_owned(),
            origin_id: "local".to_owned(),
            origin_seq: 1,
            relay_seq: Some(1),
            op_kind: "probe.shared".to_owned(),
            payload: json!({}),
            recorded_at_ms: 1_001,
        },
    ];
    let relay = PagedRelay::new([(
        0,
        PullResponse {
            ops: shared_prefix,
            next_cursor: 2,
            has_more: false,
        },
    )]);
    let client = RelaySyncClient::new(relay);
    let recovered = client
        .recover_origin(&mut engine, "ws", "recovered-ydoc", &NoFaults)
        .expect("recover Y.Doc suffix");
    assert_eq!(
        (recovered.shared_prefix_length, recovered.preserved_ops),
        (2, 2)
    );

    let rebased = engine
        .read_with(|conn| {
            let marker = conn.query_row(
                "SELECT base_origin_id,base_origin_seq,base_relay_seq,
                        base_relay_confirmed_absent
                   FROM ydoc_docs
                  WHERE workspace_id='ws' AND version_id='main'
                    AND object_id='object-recovered-base'",
                [],
                |row| {
                    Ok((
                        row.get::<_, Option<String>>(0)?,
                        row.get::<_, Option<i64>>(1)?,
                        row.get::<_, Option<i64>>(2)?,
                        row.get::<_, i64>(3)?,
                    ))
                },
            )?;
            let candidate = conn.query_row(
                "SELECT origin_id,origin_seq FROM ydoc_base_relay_candidates
                  WHERE workspace_id='ws' AND version_id='main'
                    AND object_id='object-recovered-base'",
                [],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
            )?;
            let deferred = conn.query_row(
                "SELECT origin_id,origin_seq,relay_seq FROM ydoc_deferred_updates
                  WHERE workspace_id='ws' AND version_id='main'
                    AND object_id='object-recovered-base'",
                [],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, Option<i64>>(2)?,
                    ))
                },
            )?;
            Ok::<_, rusqlite::Error>((marker, candidate, deferred))
        })
        .expect("rebased Y.Doc coordinates");
    assert_eq!(
        rebased,
        (
            (Some("recovered-ydoc".to_owned()), Some(0), None, 0),
            ("recovered-ydoc".to_owned(), 0),
            ("recovered-ydoc".to_owned(), 1, None),
        ),
        "every local suffix coordinate must move with the replication log and lose stale relay metadata"
    );

    client
        .push_workspace(&mut engine, "ws", &NoFaults, 1_200, 0)
        .expect("push recovered suffix");
    client
        .pull_chat_workspace(
            &mut engine,
            &mut dohc_engine_collab::WriterDocCache::new(),
            "ws",
            &NoFaults,
            &NoLiveLeases,
            1_300,
        )
        .expect("stamp recovered base relay position");
    let winner = dohc_engine_collab::Ydoc::wire();
    winner.plaintext_insert(0, "relay winner");
    let winner_bytes = winner.encode_full_state();
    let winner_claim = engine
        .put_binary_blob(&winner_bytes)
        .expect("store competing base");
    let mut competing = envelope(
        "winning-peer",
        0,
        "ydoc.update",
        crate::ydoc_update_payload(
            &key,
            "notes/recovered-base.md",
            dohc_engine_collab::ContentKind::Plaintext,
            &winner_claim,
            &winner_claim,
            None,
            None,
            true,
        ),
    );
    competing.relay_seq = Some(50);
    let applied = apply_ydoc_envelope(
        &mut engine,
        &mut dohc_engine_collab::WriterDocCache::new(),
        &competing,
        &NoFaults,
        &NoLiveLeases,
    )
    .expect("apply lower relay base");
    assert!(matches!(
        applied,
        ApplyOutcome { primary: ApplyDisposition::Applied(YdocApplyResult {
            lineage_replacement: Some(YdocLineageReplacement {
                winner_lineage_claim_id,
                ..
            }),
            ..
        }), refusals: ref outcome_refusals, sharing_declined: ref outcome_sharing_declined, } if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty() && (winner_lineage_claim_id == winner_claim)
    ));
}

#[test]
fn recover_origin_rebases_each_current_lww_projection_coordinate() {
    let (_scratch, _path, mut engine) = open_store();
    seed_identity(&mut engine);
    let (reaction_seq, decision_seq, follow_seq, feed_seq) = journal_lww_ops(&mut engine);
    seed_lww_projections(
        &mut engine,
        "local",
        reaction_seq,
        decision_seq,
        follow_seq,
        feed_seq,
    );
    let recovery = RelaySyncClient::new(PagedRelay::new([(
        0,
        PullResponse {
            ops: vec![ReplicationEnvelope {
                workspace_id: "ws".to_owned(),
                origin_id: "local".to_owned(),
                origin_seq: 0,
                op_kind: "probe.local".to_owned(),
                payload: json!({}),
                recorded_at_ms: 1_000,
                relay_seq: Some(0),
            }],
            next_cursor: 1,
            has_more: false,
        },
    )]));

    let recovered = recovery
        .recover_origin(&mut engine, "ws", "recovered-lww", &NoFaults)
        .expect("recover LWW suffix");
    assert_eq!(recovered.shared_prefix_length, 1);

    let projection_coordinates = lww_projection_coordinates(&engine);
    let log_coordinates = lww_log_coordinates(&engine, "recovered-lww");
    assert_eq!(projection_coordinates, log_coordinates);
    for (op_kind, expected_seq) in [
        ("chat.reaction.set", 0),
        ("chat.decision.set", 4),
        ("chat.follow.set", 2),
        ("chat.feed.read.set", 3),
    ] {
        assert_eq!(
            projection_coordinates.get(op_kind),
            Some(&("recovered-lww".to_owned(), expected_seq)),
            "{op_kind} must point at its exact recovered replication_log row"
        );
    }
}

#[test]
fn recover_origin_recomputes_when_rebased_decision_winner_becomes_a_loser() {
    let (_scratch, _path, mut engine) = open_store();
    let peer_operation = seed_recovery_decision_conflict(&mut engine, "k-peer", true);
    assert_eq!(
        conflicted_decision_projection(&engine),
        (Some("local-resolver".to_owned()), "local".to_owned(), 1)
    );

    recover_local_origin(&mut engine, "a-recovered");
    let recovered_projection = conflicted_decision_projection(&engine);
    assert_eq!(
        recovered_projection,
        (Some("peer-resolver".to_owned()), "k-peer".to_owned(), 0)
    );

    let rebased_operation = rebased_decision_operation(&engine, "a-recovered");
    let (_peer_scratch, _peer_path, mut peer) = open_store();
    assert_eq!(
        apply_chat_envelope(&mut peer, &peer_operation, &NoFaults).expect("apply peer winner"),
        ApplyOutcome::new(ApplyDisposition::Applied(Vec::new()))
    );
    assert_eq!(
        apply_chat_envelope(&mut peer, &rebased_operation, &NoFaults)
            .expect("apply rebased losing decision"),
        ApplyOutcome::new(ApplyDisposition::Applied(Vec::new()))
    );
    assert_eq!(conflicted_decision_projection(&peer), recovered_projection);
}

#[test]
fn recover_origin_recomputes_when_rebased_decision_loser_becomes_the_winner() {
    let (_scratch, _path, mut engine) = open_store();
    let peer_operation = seed_recovery_decision_conflict(&mut engine, "middle-peer", false);
    assert_eq!(
        conflicted_decision_projection(&engine),
        (
            Some("peer-resolver".to_owned()),
            "middle-peer".to_owned(),
            0
        )
    );

    recover_local_origin(&mut engine, "z-recovered");
    let recovered_projection = conflicted_decision_projection(&engine);
    assert_eq!(
        recovered_projection,
        (
            Some("local-resolver".to_owned()),
            "z-recovered".to_owned(),
            0
        )
    );

    let rebased_operation = rebased_decision_operation(&engine, "z-recovered");
    let (_peer_scratch, _peer_path, mut peer) = open_store();
    assert_eq!(
        apply_chat_envelope(&mut peer, &peer_operation, &NoFaults).expect("apply peer winner"),
        ApplyOutcome::new(ApplyDisposition::Applied(Vec::new()))
    );
    assert_eq!(
        apply_chat_envelope(&mut peer, &rebased_operation, &NoFaults)
            .expect("apply rebased winning decision"),
        ApplyOutcome::new(ApplyDisposition::Applied(Vec::new()))
    );
    assert_eq!(conflicted_decision_projection(&peer), recovered_projection);
}

#[test]
fn recover_origin_clears_shared_push_positions_before_rebased_ops_are_scanned() {
    let (_scratch, _path, mut engine) = open_store();
    seed_identity(&mut engine);
    assert!(matches!(
        journal_local_replication_op(
            &mut engine,
            "ws",
            "local",
            "epoch-1",
            "stream-1",
            "chat.channel.create",
            &json!({"wireId": "channel-wire"}),
            1_001,
            &NoFaults,
        ),
        Ok(TxnOutcome::Committed(1))
    ));
    engine
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT INTO shared_channel_push_state \
                 (workspace_id,share_id,pushed_seq,dense_seq) VALUES ('ws','share',99,99)",
                [],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .expect("seed stale shared push state");
    let recovery = RelaySyncClient::new(PagedRelay::new([(
        0,
        PullResponse {
            ops: Vec::new(),
            next_cursor: 0,
            has_more: false,
        },
    )]));
    recovery
        .recover_origin(&mut engine, "ws", "recovered", &NoFaults)
        .expect("recover origin");
    let retained: bool = engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM shared_channel_push_state \
                 WHERE workspace_id='ws')",
                [],
                |row| row.get(0),
            )
            .map_err(SyncError::corrupt)
        })
        .expect("read shared state");
    assert!(
        !retained,
        "retaining the old physical cursor skips every renumbered operation"
    );

    let pushing = RelaySyncClient::new(PagedShareRelay::new([], []));
    assert_eq!(
        pushing
            .push_shared_channel(&mut engine, "ws", "share", "channel-wire", &NoFaults)
            .expect("push rebased share lane")
            .pushed,
        1
    );
}
