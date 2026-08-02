use std::collections::BTreeMap;
use std::sync::Mutex;

use dohc_engine_domain::chats::{
    CHAT_THREAD_HEADER_MESSAGE_ID, chat_thread_display_title, upsert_chat_search_index_row,
};
use dohc_engine_domain::{
    AGENT_CHANNEL_NAME, AGENT_CHANNEL_WIRE_ID, BookmarkMode, BookmarkTargetKind, ChatActorKind,
    ChatChannelKind, ChatReactionState, CreateFileThread, FollowState, FollowTargetKind,
    GENERAL_CHANNEL_WIRE_ID, LinkedChatStore, MAX_SECRET_FILE_BYTES, MAX_TEXT_BYTES,
    ResolveDecision, SECRET_IV_BYTES, SECRET_TAG_BYTES, SaveBookmark, SendMessage, SetFollow,
    SetReaction, StartChannelThread, VersionedTextStore, attachment_id_for, channel_slug_for_name,
};
use dohc_engine_storage::{EngineStore, FaultPoint, NoFaults, TxnOutcome};
use dohc_engine_testkit::{ScratchDir, ScriptedFaults};
use rusqlite::{OptionalExtension, params};
use serde_json::json;
use sha2::{Digest, Sha256};

use crate::apply::apply_chat_tx;
use crate::*;

macro_rules! assert_invalid_refusal {
    ($result:expr) => {
        assert!(matches!(
            $result,
            Ok(ApplyOutcome::Refused(ReplicationRefusal {
                reason: RefusalReason::InvalidInput { .. },
                ..
            }))
        ))
    };
}

fn store() -> (ScratchDir, std::path::PathBuf, EngineStore) {
    let scratch = ScratchDir::new().expect("scratch");
    let path = scratch.engine_db_path().expect("db path");
    let store = EngineStore::open(&path, 1_000).expect("open");
    (scratch, path, store)
}

fn envelope(origin: &str, seq: i64, kind: &str, payload: serde_json::Value) -> ReplicationEnvelope {
    ReplicationEnvelope {
        workspace_id: "ws".to_owned(),
        origin_id: origin.to_owned(),
        origin_seq: seq,
        op_kind: kind.to_owned(),
        payload,
        recorded_at_ms: 2_000,
    }
}

fn decode_hex(encoded: &str) -> Vec<u8> {
    encoded
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| {
            let pair = std::str::from_utf8(pair).expect("hex utf8");
            u8::from_str_radix(pair, 16).expect("hex byte")
        })
        .collect()
}

fn clock_collision_pair() -> (Vec<u8>, Vec<u8>) {
    (
        decode_hex("01010c00040109706c61696e546578740461efbfbd00"),
        decode_hex("01010c00040109706c61696e546578740561f09f988000"),
    )
}

fn seed_text_head(engine: &mut EngineStore, object_id: &str, path: &str, text: &str) -> String {
    let sha = dohc_engine_storage::hex_sha256(text.as_bytes());
    engine
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT OR IGNORE INTO blobs (sha256,byte_length,text) VALUES (?1,?2,?3)",
                params![sha, text.len() as i64, text],
            )
            .map_err(SyncError::persist)?;
            tx.execute(
                "INSERT INTO file_objects (workspace_id,object_id,created_at_ms) \
                 VALUES ('ws',?1,1)",
                [object_id],
            )
            .map_err(SyncError::persist)?;
            tx.execute(
                "INSERT INTO snapshots \
                 (workspace_id,version_id,object_id,path,blob_sha256,updated_at_ms,latest_moment_id,metadata_origin,content_kind,binary_sha256) \
                 VALUES ('ws','main',?1,?2,?3,1,?4,'api','text',NULL)",
                params![object_id, path, sha, format!("seed-{object_id}")],
            )
            .map_err(SyncError::persist)?;
            tx.execute(
                "INSERT INTO path_aliases (workspace_id,version_id,path,object_id) \
                 VALUES ('ws','main',?1,?2)",
                params![path, object_id],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .expect("seed text head");
    sha
}

fn insert_probe(tx: &rusqlite::Transaction<'_>, op: &ReplicationEnvelope) -> Result<(), SyncError> {
    tx.execute(
        "INSERT OR REPLACE INTO documents (doc_id,body,updated_at_ms) VALUES (?1,?2,?3)",
        params![op.origin_id, op.op_kind, op.recorded_at_ms],
    )
    .map_err(SyncError::persist)?;
    Ok(())
}

fn reaction_payload(state: &str, emoji: &str, at_ms: i64, author_id: &str) -> serde_json::Value {
    json!({
        "reactionId": format!("reaction-{author_id}"),
        "messageId": "message",
        "threadId": "thread",
        "emoji": emoji,
        "authorId": author_id,
        "authorKind": "human",
        "authorDisplayName": author_id,
        "atMs": at_ms,
        "state": state,
    })
}

fn decision_payload(state: &str, at_ms: i64, resolver: Option<&str>) -> serde_json::Value {
    let mut payload = json!({
        "threadId": "thread",
        "messageId": "message",
        "state": state,
        "atMs": at_ms,
    });
    if let Some(resolver) = resolver {
        payload["resolvedByMessageId"] = json!(resolver);
    }
    payload
}

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
    let (_scratch, _path, mut engine) = store();
    let operation = envelope(
        "unsafe-decision-time",
        0,
        "chat.decision.set",
        decision_payload("open", i64::MAX, None),
    );

    // MUTATION: dropping the persisted-safe atMs bound journals a decision that
    // the cross-engine read contract cannot represent.
    assert_invalid_refusal!(apply_chat_envelope(&mut engine, &operation, &NoFaults));
    let row_count: i64 = engine
        .read_with(|conn| {
            conn.query_row("SELECT COUNT(*) FROM chat_decisions", [], |row| row.get(0))
                .map_err(dohc_engine_storage::StorageError::corrupt_public)
        })
        .expect("decision row count");
    assert_eq!(row_count, 0);
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "unsafe-decision-time").expect("ack"),
        0
    );
}

#[test]
fn imported_decision_refuses_an_explicit_null_resolver() {
    let (_scratch, _path, mut engine) = store();
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
        let (_scratch, _path, mut engine) = store();
        for index in order {
            apply_chat_envelope(&mut engine, &ops[index], &NoFaults).expect("apply");
        }
        winners.push(decision_winner(&engine));
    }
    // MUTATION: using arrival order or origin before resolvedRank -> equal-time peers disagree or an open cell beats resolved.
    assert!(winners.iter().all(|winner| winner == &winners[0]));
    assert_eq!(winners[0].0, "resolved");
    assert_eq!(winners[0].2, "beta");
}

#[test]
fn local_only_decision_resolver_producer_converges_through_apply() {
    let (_source_scratch, _source_path, mut source) = store();
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

    let (_target_scratch, _target_path, mut target) = store();
    for operation in &outbound {
        assert_eq!(
            apply_chat_envelope(&mut target, operation, &NoFaults)
                .expect("apply produced chat envelope"),
            ApplyOutcome::Applied(())
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
    let (_scratch, _path, mut engine) = store();
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
    // MUTATION: ranking origin before state -> lexically larger added beats an equal-time remove.
    assert_eq!(reaction_winner(&engine).0, "removed");

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
    // MUTATION: omitting the origin tie-break -> equal-time/equal-state application becomes arrival-dependent.
    assert_eq!(winner, "zeta");
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
        let (_scratch, _path, mut engine) = store();
        for index in order {
            apply_chat_envelope(&mut engine, &ops[index], &NoFaults).expect("apply");
        }
        winners.push(reaction_winner(&engine));
    }
    // MUTATION: replacing the total-order max with last-writer arrival -> permutations settle to different rows.
    assert!(winners.iter().all(|winner| winner == &winners[0]));
    assert_eq!(winners[0], ("added".to_owned(), 101, "omega".to_owned(), 0));
}

#[test]
fn reaction_import_preserves_remote_time_verbatim() {
    let (_scratch, _path, mut engine) = store();
    let future = envelope(
        "peer",
        0,
        "chat.reaction.set",
        reaction_payload("added", "👍", 9_999_999_999, "Ada"),
    );
    apply_chat_envelope(&mut engine, &future, &NoFaults).expect("apply");
    // MUTATION: receiver-clock clamping remote atMs -> identical envelopes store different total-order keys on different peers.
    assert_eq!(reaction_winner(&engine).1, 9_999_999_999);
}

#[test]
fn imported_reaction_refuses_unsafe_at_ms_without_row_and_acks() {
    let (_scratch, _path, mut engine) = store();
    let operation = envelope(
        "unsafe-reaction-time",
        0,
        "chat.reaction.set",
        reaction_payload("added", "👍", i64::MAX, "Ada"),
    );

    // MUTATION: dropping the persisted-safe atMs bound journals a reaction that
    // subsequently makes reaction reads state-corrupt.
    assert_invalid_refusal!(apply_chat_envelope(&mut engine, &operation, &NoFaults));
    let row_count: i64 = engine
        .read_with(|conn| {
            conn.query_row("SELECT COUNT(*) FROM chat_reactions", [], |row| row.get(0))
                .map_err(dohc_engine_storage::StorageError::corrupt_public)
        })
        .expect("reaction row count");
    assert_eq!(row_count, 0);
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "unsafe-reaction-time").expect("ack"),
        0
    );
}

#[test]
fn reaction_import_accepts_negative_time_and_preserves_lww_order() {
    let (_scratch, _path, mut engine) = store();
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
    // MUTATION: rejecting negative imported time stalls the envelope; replacing
    // the LWW comparison lets the later-arriving older row win.
    assert_eq!(stored, ("added".to_owned(), "Ada".to_owned(), -10));
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "peer").expect("ack"),
        1
    );
}

#[test]
fn reaction_import_rejects_non_emoji_graphemes() {
    for hostile in ["hello", "http://evil.invalid", "👍 nice", "✁"] {
        let (_scratch, _path, mut engine) = store();
        let invalid = envelope(
            "mallory",
            0,
            "chat.reaction.set",
            reaction_payload("added", hostile, 100, "Mallory"),
        );
        let result = apply_chat_envelope(&mut engine, &invalid, &NoFaults);
        // MUTATION: trusting peer-side IPC validation -> arbitrary text lands in the reaction cell key.
        assert_invalid_refusal!(result);
    }
    let (_scratch, _path, mut engine) = store();
    let flag = envelope(
        "peer",
        0,
        "chat.reaction.set",
        reaction_payload("added", "🇺🇸", 100, "Ada"),
    );
    // MUTATION: validating one scalar instead of one emoji grapheme -> a valid regional-indicator flag is rejected.
    assert!(apply_chat_envelope(&mut engine, &flag, &NoFaults).is_ok());
}

struct AlwaysLive;

impl LeaseProbe for AlwaysLive {
    fn is_live(&self, _key: &dohc_engine_collab::DocKey) -> bool {
        true
    }
}

#[test]
fn leased_ydoc_envelope_acks_and_defers_without_mutating_the_ydoc_log() {
    let (_scratch, _path, mut engine) = store();
    // The defer path refuses non-replicated lineages (they can never drain),
    // so the test needs the replicated marker scaffolding first.
    engine
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT OR IGNORE INTO versioned_workspaces (workspace_id, main_version_id)                  VALUES ('ws','main')",
                [],
            )
            .map_err(SyncError::persist)?;
            tx.execute(
                "INSERT OR IGNORE INTO file_objects (workspace_id, object_id, created_at_ms)                  VALUES ('ws','object-1',1_400)",
                [],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .expect("workspace scaffolding");
    let marker_key = dohc_engine_collab::DocKey::new("ws", "main", "object-1").expect("key");
    dohc_engine_collab::ensure_marker(
        &mut engine,
        &marker_key,
        dohc_engine_collab::ContentKind::Plaintext,
        dohc_engine_collab::Regime::Replicated,
        &NoFaults,
        1_500,
    )
    .expect("replicated marker");
    // A MISSING blob must refuse BEFORE any ack — a deferred coordinate is
    // already acknowledged, and a blob that can never load would strand the
    // drain forever while the peer cursor is past the row.
    let missing = envelope(
        "peer",
        0,
        "ydoc.update",
        json!({
            "versionId": "main",
            "objectId": "object-1",
            "path": "notes/live.md",
            "contentKind": "plaintext",
            "updateBlobSha256": "0000000000000000000000000000000000000000000000000000000000000000",
            "isBaseState": false
        }),
    );
    assert!(matches!(
        apply_ydoc_envelope(&mut engine, &missing, &NoFaults, &AlwaysLive),
        Err(SyncError::BlobInvalid)
    ));
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "peer").expect("ack"),
        -1,
        "an unloadable blob must leave the coordinate unacked"
    );
    let update_bytes = dohc_engine_collab::Ydoc::wire().plaintext_insert(0, "live edit");
    let blob_sha = engine.put_binary_blob(&update_bytes).expect("store blob");
    let op = envelope(
        "peer",
        0,
        "ydoc.update",
        json!({
            "versionId": "main",
            "objectId": "object-1",
            "path": "notes/live.md",
            "contentKind": "plaintext",
            "updateBlobSha256": blob_sha,
            "isBaseState": false
        }),
    );
    let outcome = apply_replication_envelope(&mut engine, &op, &NoFaults, &AlwaysLive)
        .expect("live lineage defers");
    assert_eq!(outcome, ApplyOutcome::Applied(RoutedApply::default()));
    let deferred_rows: i64 = engine
        .read_with(|conn| {
            conn.query_row("SELECT COUNT(*) FROM ydoc_deferred_updates", [], |row| {
                row.get(0)
            })
            .map_err(SyncError::corrupt)
        })
        .expect("count deferred Y.Doc coordinates");
    assert_eq!(
        deferred_rows, 1,
        "the durable replay marker replaces any routed caller action"
    );
    let update_rows: i64 = engine
        .read_with(|conn| {
            conn.query_row("SELECT COUNT(*) FROM ydoc_updates", [], |row| row.get(0))
                .map_err(SyncError::corrupt)
        })
        .expect("count Y.Doc updates");
    assert_eq!(update_rows, 0, "defer must not append remote Y.Doc bytes");
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "peer").expect("ack"),
        0,
        "the poison-pill coordinate is acknowledged"
    );
}

#[test]
fn fault_sync_during_journal_txn_rolls_back_domain_and_position() {
    let (_scratch, path, mut engine) = store();
    let faults = ScriptedFaults::crash_at(FaultPoint::SyncDuringJournalTxn);
    let outcome = journal_local_replication_op(
        &mut engine,
        "ws",
        "local",
        "epoch-1",
        "stream-1",
        "doc.put",
        &json!({"id":"doc"}),
        1_000,
        faults.as_ref(),
    )
    .expect("fault outcome");
    assert_eq!(outcome, TxnOutcome::Crashed { committed: false });
    drop(engine);
    let mut reopened = EngineStore::open(&path, 1_001).expect("reopen");
    assert!(
        read_sync_identity(&reopened, "ws")
            .expect("identity")
            .is_none()
    );
    let retried = journal_local_replication_op(
        &mut reopened,
        "ws",
        "local",
        "epoch-1",
        "stream-1",
        "doc.put",
        &json!({"id":"doc"}),
        1_000,
        &NoFaults,
    )
    .expect("retry");
    assert_eq!(retried, TxnOutcome::Committed(0));
}

#[test]
fn join_identity_adoption_creates_only_an_absent_coordinate_and_is_idempotent() {
    let (_scratch, _path, mut engine) = store();
    assert_eq!(
        adopt_join_identity(
            &mut engine,
            "ws",
            "origin-joined",
            "epoch-relay",
            "stream-relay",
            2,
            &NoFaults,
        )
        .expect("adopt relay identity"),
        TxnOutcome::Committed(AdoptJoinIdentityOutcome::Adopted)
    );
    assert_eq!(
        read_sync_identity(&engine, "ws").expect("identity"),
        Some(SyncIdentity {
            workspace_id: "ws".to_owned(),
            origin_id: "origin-joined".to_owned(),
            replication_epoch: "epoch-relay".to_owned(),
            stream_identity: "stream-relay".to_owned(),
        })
    );

    assert_eq!(
        adopt_join_identity(
            &mut engine,
            "ws",
            "origin-must-not-replace",
            "epoch-relay",
            "stream-relay",
            3,
            &NoFaults,
        )
        .expect("retry same coordinate"),
        TxnOutcome::Committed(AdoptJoinIdentityOutcome::AlreadyMatched)
    );
    assert_eq!(
        read_sync_identity(&engine, "ws")
            .expect("identity")
            .expect("present")
            .origin_id,
        "origin-joined"
    );
}

#[test]
fn join_identity_adoption_rejects_non_relay_identity_text_without_writing() {
    let (_scratch, _path, mut engine) = store();
    let cases = [
        ("ws-origin", " origin-joined", "epoch-relay", "stream-relay"),
        ("ws-epoch", "origin-joined", "epoch-relay ", "stream-relay"),
        (
            "ws-stream",
            "origin-joined",
            "epoch-relay",
            "stream\u{0000}relay",
        ),
        (
            "ws-bom",
            "origin-joined",
            "\u{feff}epoch-relay",
            "stream-relay",
        ),
    ];

    for (workspace_id, origin_id, replication_epoch, stream_identity) in cases {
        assert!(matches!(
            adopt_join_identity(
                &mut engine,
                workspace_id,
                origin_id,
                replication_epoch,
                stream_identity,
                2,
                &NoFaults,
            ),
            Err(SyncError::InvalidInput { .. })
        ));
        assert!(
            read_sync_identity(&engine, workspace_id)
                .expect("identity")
                .is_none(),
            "invalid identity text must not create a row for {workspace_id}"
        );
    }
}

#[test]
fn join_identity_adoption_refuses_a_different_existing_identity() {
    let (_scratch, _path, mut engine) = store();
    engine
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT INTO sync_identity \
                 (workspace_id,origin_id,replication_epoch,stream_identity,created_at_ms) \
                 VALUES ('ws','origin-old','epoch-old','stream-old',1)",
                [],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .expect("seed different identity");

    assert!(matches!(
        adopt_join_identity(
            &mut engine,
            "ws",
            "origin-joined",
            "epoch-relay",
            "stream-relay",
            2,
            &NoFaults,
        ),
        Err(SyncError::InvalidInput {
            reason: "join identity adoption found a different local sync identity"
        })
    ));
    let identity = read_sync_identity(&engine, "ws")
        .expect("identity")
        .expect("present");
    assert_eq!(identity.origin_id, "origin-old");
    assert_eq!(identity.replication_epoch, "epoch-old");
    assert_eq!(identity.stream_identity, "stream-old");
}

#[test]
fn join_identity_adoption_refuses_any_existing_replication_state() {
    let (_scratch, _path, mut engine) = store();
    engine
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT INTO replication_log \
                 (workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms,imported) \
                 VALUES ('ws-log','origin-old',0,'workspace.init','{}',1,0)",
                [],
            )
            .map_err(SyncError::persist)?;
            tx.execute(
                "INSERT INTO sync_relay_cursors \
                 (workspace_id,cursor,replication_epoch,stream_identity) \
                 VALUES ('ws-cursor','0','epoch-old','stream-old')",
                [],
            )
            .map_err(SyncError::persist)?;
            tx.execute(
                "INSERT INTO replication_peers (workspace_id,origin_id,acked_seq) \
                 VALUES ('ws-peer','origin-old',0)",
                [],
            )
            .map_err(SyncError::persist)?;
            tx.execute(
                "INSERT INTO sync_relay_push_state (workspace_id,origin_id,pushed_seq) \
                 VALUES ('ws-push','origin-old',0)",
                [],
            )
            .map_err(SyncError::persist)?;
            tx.execute(
                "INSERT INTO shared_channel_cursors (workspace_id,share_id,cursor) \
                 VALUES ('ws-channel-cursor','share-old','0')",
                [],
            )
            .map_err(SyncError::persist)?;
            tx.execute(
                "INSERT INTO shared_channel_peers \
                 (workspace_id,share_id,origin_id,applied_origin_seq,dense_seq) \
                 VALUES ('ws-channel-peer','share-old','origin-old',0,0)",
                [],
            )
            .map_err(SyncError::persist)?;
            tx.execute(
                "INSERT INTO shared_channel_push_state (workspace_id,share_id,pushed_seq) \
                 VALUES ('ws-channel-push','share-old',0)",
                [],
            )
            .map_err(SyncError::persist)?;
            tx.execute(
                "INSERT INTO share_view_cursors (workspace_id,share_id,cursor) \
                 VALUES ('ws-view-cursor','share-old','0')",
                [],
            )
            .map_err(SyncError::persist)?;
            tx.execute(
                "INSERT INTO chat_pending_replication \
                 (workspace_id,origin_id,origin_seq,dependency_kind,dependency_id) \
                 VALUES ('ws-chat-pending','origin-old',0,'message-thread','thread-old')",
                [],
            )
            .map_err(SyncError::persist)?;
            tx.execute(
                "INSERT INTO versioned_workspaces (workspace_id,main_version_id) \
                 VALUES ('ws-ydoc-pending','main')",
                [],
            )
            .map_err(SyncError::persist)?;
            tx.execute(
                "INSERT INTO file_objects (workspace_id,object_id,created_at_ms) \
                 VALUES ('ws-ydoc-pending','object-ydoc-pending',1)",
                [],
            )
            .map_err(SyncError::persist)?;
            tx.execute(
                "INSERT INTO ydoc_deferred_updates \
                 (workspace_id,version_id,object_id,origin_id,origin_seq,recorded_at_ms) \
                 VALUES ('ws-ydoc-pending','main','object-ydoc-pending','origin-old',0,1)",
                [],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .expect("seed non-pristine state");

    for workspace_id in [
        "ws-log",
        "ws-cursor",
        "ws-peer",
        "ws-push",
        "ws-channel-cursor",
        "ws-channel-peer",
        "ws-channel-push",
        "ws-view-cursor",
        "ws-chat-pending",
        "ws-ydoc-pending",
    ] {
        assert!(matches!(
            adopt_join_identity(
                &mut engine,
                workspace_id,
                "origin-joined",
                "epoch-relay",
                "stream-relay",
                2,
                &NoFaults,
            ),
            Err(SyncError::InvalidInput {
                reason: "join identity adoption requires pristine local replication state"
            })
        ));
        assert!(
            read_sync_identity(&engine, workspace_id)
                .expect("identity")
                .is_none()
        );
    }
}

#[test]
fn fault_sync_before_apply_commit_reopens_unapplied_and_unacked() {
    let (_scratch, path, mut engine) = store();
    let op = envelope("peer", 0, "probe.apply", json!({}));
    let faults = ScriptedFaults::crash_at(FaultPoint::SyncBeforeApplyCommit);
    let outcome = apply_envelope_with(&mut engine, &op, faults.as_ref(), insert_probe)
        .expect("fault outcome");
    assert_eq!(outcome, ApplyOutcome::Crashed { committed: false });
    drop(engine);
    let mut reopened = EngineStore::open(&path, 2_001).expect("reopen");
    assert!(reopened.read_document("peer").expect("read").is_none());
    assert_eq!(
        read_replication_acked_seq(&reopened, "ws", "peer").expect("ack"),
        -1
    );
    assert_eq!(
        apply_envelope_with(&mut reopened, &op, &NoFaults, insert_probe).expect("retry"),
        ApplyOutcome::Applied(())
    );
}

#[test]
fn fault_sync_before_blob_hydrate_commit_leaves_no_blob_or_cursor() {
    let (_scratch, path, mut engine) = store();
    let bytes = b"replicated bytes".to_vec();
    let blob = BlobHydration {
        sha256: dohc_engine_storage::hex_sha256(&bytes),
        content: BlobContent::Binary(bytes),
    };
    let faults = ScriptedFaults::crash_at(FaultPoint::SyncBeforeBlobHydrateCommit);
    assert_eq!(
        hydrate_blob_content(&mut engine, &blob, faults.as_ref()).expect("fault"),
        TxnOutcome::Crashed { committed: false }
    );
    drop(engine);
    let mut reopened = EngineStore::open(&path, 2_001).expect("reopen");
    assert!(!reopened.has_binary_blob(&blob.sha256).expect("blob absent"));
    assert!(
        read_relay_cursor(&reopened, "ws")
            .expect("cursor")
            .is_none()
    );
    assert_eq!(
        hydrate_blob_content(&mut reopened, &blob, &NoFaults).expect("retry"),
        TxnOutcome::Committed(())
    );
}

/// Ingest owns the text ceiling. Before this, nothing on the sync path checked
/// `MAX_TEXT_BYTES`: the HTTP transport's blob response bound sat near it by
/// coincidence, and any other `RelayTransport` could store an over-cap body.
///
/// MUTATION: delete the ceiling check in `hydrate_blob_content` and the over-cap
/// half of this test fails; raise the limit above `MAX_TEXT_BYTES` and the
/// refusal message stops naming the real bound.
#[test]
fn text_blob_over_the_text_ceiling_is_refused_at_ingest() {
    let (_scratch, _path, mut engine) = store();

    let at_cap = "a".repeat(MAX_TEXT_BYTES);
    let accepted = BlobHydration {
        sha256: dohc_engine_storage::hex_sha256(at_cap.as_bytes()),
        content: BlobContent::Text(at_cap),
    };
    assert_eq!(
        hydrate_blob_content(&mut engine, &accepted, &NoFaults).expect("at-cap text hydrates"),
        TxnOutcome::Committed(())
    );

    let over_cap = "a".repeat(MAX_TEXT_BYTES + 1);
    let refused = BlobHydration {
        sha256: dohc_engine_storage::hex_sha256(over_cap.as_bytes()),
        content: BlobContent::Text(over_cap),
    };
    let error = hydrate_blob_content(&mut engine, &refused, &NoFaults)
        .expect_err("over-cap text is refused");
    assert!(
        matches!(
            error,
            SyncError::BlobTooLarge {
                constraint: "MAX_TEXT_BYTES",
                limit_bytes: MAX_TEXT_BYTES,
                observed_bytes,
            } if observed_bytes == MAX_TEXT_BYTES + 1
        ),
        "unexpected refusal: {error:?}"
    );
    assert_eq!(
        error.to_string(),
        format!(
            "blob exceeds MAX_TEXT_BYTES: limit {MAX_TEXT_BYTES} bytes, observed {} bytes",
            MAX_TEXT_BYTES + 1
        )
    );

    let (stored, refused_rows) = engine
        .read_with(|conn| {
            Ok::<_, rusqlite::Error>((
                conn.query_row(
                    "SELECT COUNT(*) FROM blobs WHERE sha256=?1",
                    [&accepted.sha256],
                    |row| row.get::<_, i64>(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*) FROM blobs WHERE sha256=?1",
                    [&refused.sha256],
                    |row| row.get::<_, i64>(0),
                )?,
            ))
        })
        .expect("blob rows");
    assert_eq!(stored, 1);
    assert_eq!(refused_rows, 0);
}

/// The relay pull checks the ceiling on the undecoded response, before it
/// hashes the bytes and before it copies them into a `String`. The served
/// bytes deliberately do NOT hash to the requested sha256, so the refusal can
/// only be `BlobTooLarge` while the size check runs first.
///
/// MUTATION: move the check below `hex_sha256` and this refuses with
/// `BlobInvalid` instead; drop it and the refusal comes from the chokepoint
/// after the wasted hash and copy.
#[test]
fn oversized_relay_blob_is_refused_before_it_is_hashed_or_copied() {
    let (_scratch, _path, mut engine) = store();
    seed_identity(&mut engine);
    seed_replication_version(&mut engine, "main", "main");
    let sha256 = dohc_engine_storage::hex_sha256(b"an honest sha the relay does not serve");
    let op = version_create_with_shipped_snapshots(
        "oversized-blob-peer",
        "oversized-blob-version",
        vec![shipped_text_snapshot(
            "oversized-blob-object",
            "oversized-blob.md",
            &sha256,
        )],
    );
    let mut relay = PagedRelay::new([(
        0,
        PullResponse {
            ops: vec![op],
            next_cursor: 1,
            has_more: false,
        },
    )]);
    relay.blobs.insert(sha256, vec![b'a'; MAX_TEXT_BYTES + 1]);
    let client = RelaySyncClient::new(relay);

    assert_eq!(
        client.pull_chat_workspace(&mut engine, "ws", &NoFaults, &NoLiveLeases),
        Err(RelayError::BlobTooLarge {
            constraint: "MAX_TEXT_BYTES",
            limit_bytes: MAX_TEXT_BYTES,
            observed: ObservedBytes::Exact(MAX_TEXT_BYTES + 1),
        })
    );
    assert!(
        read_relay_cursor(&engine, "ws")
            .expect("read cursor")
            .is_none()
    );
}

#[test]
fn exact_duplicate_is_noop_and_gap_is_rejected() {
    let (_scratch, _path, mut engine) = store();
    let op = envelope("peer", 0, "probe.apply", json!({"v":1}));
    assert_eq!(
        apply_envelope_with(&mut engine, &op, &NoFaults, insert_probe).expect("apply"),
        ApplyOutcome::Applied(())
    );
    assert_eq!(
        apply_envelope_with(&mut engine, &op, &NoFaults, insert_probe).expect("dedup"),
        ApplyOutcome::Skipped
    );
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "peer").expect("ack"),
        0
    );
    let gap = envelope("peer", 2, "probe.apply", json!({}));
    assert!(matches!(
        apply_envelope_with(&mut engine, &gap, &NoFaults, insert_probe),
        Err(SyncError::SequenceGap)
    ));
}

#[test]
fn imported_opening_message_uses_zero_based_order() {
    let (_scratch, _path, mut engine) = store();
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
            ApplyOutcome::Applied(())
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
fn imported_channel_refuses_non_timestamp_created_at_ms_without_row_and_acks() {
    for (suffix, created_at_ms) in [("negative", -1), ("unsafe", i64::MAX)] {
        let (_scratch, _path, mut engine) = store();
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

        // MUTATION: using the signed persisted-safe bound accepts -1 even
        // though ChannelCreate.createdAtMs is a replicated timestamp; and
        // dropping the bound entirely journals a channel the typed client
        // cannot decode. Under refuse-and-ack the invalid op is refused,
        // rolled back, and ACKED so the origin is not wedged.
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
    // A file-linked thread MUST carry linkedAtMs. The oracle accepts this op
    // (storing linked_at_ms NULL) but then bricks its OWN read (threadFromRow
    // numberValue(null) throws corruptStore) — a latent oracle bug. We reject
    // the malformed op at apply, deliberately STRICTER than the oracle, so no
    // durable-unreadable linked thread is ever persisted. Honest mint always
    // pairs the fields; only a corrupt/hostile peer hits this.
    // MUTATION: drop the linkedObjectId-requires-linkedAtMs guard -> the op is
    // accepted, stored with linked_at_ms NULL, and every later thread read for
    // it throws state-corrupt.
    assert_imported_thread_rejected(json!({
        "threadId": "thread-half-linked",
        "title": "Half linked",
        "createdAtMs": 20,
        "linkedObjectId": "object-1"
    }));
}

fn assert_imported_thread_rejected(payload: serde_json::Value) {
    let (_scratch, _path, mut engine) = store();
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
        // MUTATION: accept signed i64 timestamps without the oracle's nonnegative safe-integer gate.
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
        // MUTATION: use the generic byte-only bounded check -> trim-unstable/control ids can persist.
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
        // MUTATION: omit the title UTF-16 length/JS-trim stability gate.
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
        // MUTATION: treat channelSlug as a generic non-empty id -> invalid aliases create placeholders.
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
        // MUTATION: relax exact-one-owner or normalized-path enforcement.
        assert_imported_thread_rejected(payload);
    }
}

#[test]
fn imported_slug_only_thread_binds_the_existing_channel() {
    let (_scratch, _path, mut engine) = store();
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
    // MUTATION: treating channelSlug as a wire id mints a duplicate placeholder.
    assert_eq!(channel_id, "existing-channel");
    assert_eq!(channel_count, 1);
    assert_eq!(placeholder_count, 0);
}

#[test]
fn imported_thread_with_forged_agent_slug_is_refused() {
    let (_scratch, _path, mut engine) = store();
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
    // MUTATION: dropping the canonical-agent-slug iff reserved-wire invariant
    // lets an ordinary channel impersonate the dispatch channel.
    assert_invalid_refusal!(apply_chat_envelope(&mut engine, &operation, &NoFaults));
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "forged-agent-slug").expect("ack"),
        0
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

#[test]
fn chat_message_before_thread_is_parked_and_replayed_after_thread_arrives() {
    let (_scratch, _path, mut engine) = store();
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
        Ok(ApplyOutcome::Applied(()))
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
        "MUTATION: missing-thread refusal loses the message instead of replaying it"
    );
}

#[test]
fn terminal_pending_chat_replay_is_persisted_and_returned_to_the_triggering_apply() {
    let (_scratch, _path, mut engine) = store();
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
        ApplyOutcome::Applied(())
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
    let (primary, refusals) = outcome.into_primary_and_refusals();
    assert_eq!(primary, ApplyOutcome::Applied(()));
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
        "MUTATION: deleting a terminal pending coordinate without returning it loses the disposition"
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
        "MUTATION: deleting without persistence makes the ACKed terminal coordinate unobservable"
    );
}

#[test]
fn imported_follow_parks_until_its_cross_origin_thread_arrives() {
    let (_scratch, _path, mut engine) = store();
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
        ApplyOutcome::Applied(())
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
    let (_scratch, _path, mut engine) = store();
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
        ApplyOutcome::Applied(())
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
    let (_scratch, _path, mut engine) = store();
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
        ApplyOutcome::Applied(())
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
    let (_scratch, _path, mut engine) = store();
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
        ApplyOutcome::Applied(())
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
    let (_scratch, _path, mut engine) = store();
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
        ApplyOutcome::Applied(())
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
        let (_scratch, _path, mut engine) = store();
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
        let (scratch, _path, mut engine) = store();
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
    let (_scratch, _path, mut engine) = store();
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
    let (_scratch, _path, mut engine) = store();
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
    let (_scratch, _path, mut engine) = store();
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
    let (_scratch, _path, mut engine) = store();
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
    let (_scratch, _path, mut engine) = store();
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
    let (_scratch, _path, mut engine) = store();
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
    let (_scratch, _path, mut engine) = store();
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
    format!("{bounded}-{:x}", hasher.finalize())
}

#[test]
fn overlong_wire_only_placeholder_slug_round_trips_through_local_thread_journal() {
    let (_scratch, _path, mut first_peer) = store();
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

    let (_second_scratch, _second_path, mut second_peer) = store();
    assert_eq!(
        apply_chat_envelope(&mut second_peer, &outbound, &NoFaults)
            .expect("second peer accepts bounded outbound channelSlug"),
        ApplyOutcome::Applied(())
    );
}

#[test]
fn collision_slug_truncation_is_bounded_and_does_not_leave_a_dash_boundary() {
    let (_scratch, _path, mut engine) = store();
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
    let (_scratch, _path, mut engine) = store();
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
    let (_scratch, _path, mut engine) = store();
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
    let (_scratch, path, mut engine) = store();
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
        ApplyOutcome::Applied(())
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
    let (_scratch, _path, mut engine) = store();
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

    // MUTATION: reject the still-permitted negative timestamps or tighten their
    // row mappers and the corresponding read fails here.
    assert_eq!(
        (
            reactions[0].at_ms,
            reactions[0].author_display_name.as_str()
        ),
        (-10, "Ada")
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
        let (_scratch, _path, mut engine) = store();
        imported_chat_fixture(&mut engine, "invalid-message");
        let operation = envelope("invalid-message", 3, "chat.message.append", payload);
        // MUTATION: omitting any message.append oracle predicate journals a
        // payload that the TypeScript receiver refuses.
        assert_invalid_refusal!(apply_chat_envelope(&mut engine, &operation, &NoFaults));
        assert_eq!(
            read_replication_acked_seq(&engine, "ws", "invalid-message").expect("ack"),
            3
        );
    }
}

#[test]
fn refused_message_log_cannot_export_local_derived_state_or_parent() {
    let (_scratch, _path, mut engine) = store();
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
    let (_scratch, _path, mut first_peer) = store();
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

    let (_second_scratch, _second_path, mut second_peer) = store();
    for operation in &outbound {
        assert_eq!(
            apply_chat_envelope(&mut second_peer, operation, &NoFaults)
                .expect("apply collision recovery envelope"),
            ApplyOutcome::Applied(())
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
    let (_scratch, _path, mut engine) = store();
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

    // MUTATION: dropping the persisted-safe createdAtMs bound journals a
    // message that makes every typed response carrying it undecodable.
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
    let (_scratch, _path, mut engine) = store();
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
        Ok(ApplyOutcome::Applied(()))
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
    let (_scratch, _path, mut engine) = store();
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
        Ok(ApplyOutcome::Applied(()))
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
    let (_scratch, _path, mut engine) = store();
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
    // MUTATION: without the reserved-id refusal this re-indexes the imported
    // collision, making the header-text assertion exercise the regression.
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
    let (_scratch, _path, mut engine) = store();
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
        Ok(ApplyOutcome::Applied(()))
    ));
    assert!(matches!(
        apply_chat_envelope(&mut engine, &message, &NoFaults),
        Ok(ApplyOutcome::Applied(()))
    ));
    assert!(matches!(
        apply_chat_envelope(&mut engine, &message, &NoFaults),
        Ok(ApplyOutcome::Skipped)
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
    let (_scratch, _path, mut engine) = store();
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
    let (_scratch, _path, mut engine) = store();
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
    let (_scratch, _path, mut engine) = store();
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
        let (_scratch, _path, mut engine) = store();
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
        let (_scratch, _path, mut engine) = store();
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
    let (_scratch, _path, mut engine) = store();
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
        Ok(ApplyOutcome::Applied(()))
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
    let (_scratch, _path, mut engine) = store();
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
        Ok(ApplyOutcome::Applied(()))
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
    let (_scratch, _path, mut engine) = store();
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
        ApplyOutcome::Applied(())
    );
    assert_eq!(pending_chat_coordinate_count(&engine), 1);
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "attachment-owner").expect("attachment ack"),
        3
    );
}

#[test]
fn imported_attachment_refuses_a_message_resolved_in_another_thread_without_parking() {
    let (_scratch, _path, mut engine) = store();
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
    let (_scratch, _path, mut engine) = store();
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
        ApplyOutcome::Applied(())
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
        ApplyOutcome::Applied(())
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
        let (_scratch, _path, mut engine) = store();
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
        let (_scratch, _path, mut engine) = store();
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
        let (_scratch, _path, mut engine) = store();
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
        // MUTATION: dropping either 1..=256 UTF-16 bound admits an oracle-invalid cell key.
        assert_invalid_refusal!(apply_chat_envelope(&mut engine, &operation, &NoFaults));
    }
}

#[test]
fn imported_follow_refuses_unsafe_at_ms_without_row_and_acks() {
    let (_scratch, _path, mut engine) = store();
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

    // MUTATION: dropping the persisted-safe bound persists an LWW value that
    // follow-bearing JavaScript responses cannot represent.
    assert_invalid_refusal!(apply_chat_envelope(&mut engine, &operation, &NoFaults));
    let row_count: i64 = engine
        .read_with(|conn| {
            conn.query_row("SELECT COUNT(*) FROM chat_follows", [], |row| row.get(0))
                .map_err(dohc_engine_storage::StorageError::corrupt_public)
        })
        .expect("follow row count");
    assert_eq!(row_count, 0);
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
        let (_scratch, _path, mut engine) = store();
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
        // MUTATION: dropping either 1..=256 UTF-16 bound admits an oracle-invalid read row.
        assert_invalid_refusal!(apply_chat_envelope(&mut engine, &operation, &NoFaults));
    }
}

#[test]
fn imported_feed_read_refuses_unsafe_timestamps_without_row_and_acks() {
    for (origin, last_seen_created_at_ms, at_ms) in [
        ("unsafe-feed-read-time", 1, i64::MAX),
        ("unsafe-feed-read-cursor", i64::MAX, 1),
    ] {
        let (_scratch, _path, mut engine) = store();
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

        // MUTATION: dropping either persisted-safe timestamp bound journals a
        // feed-read row that cannot cross the DOP1/JavaScript read contract.
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
    let (_scratch, _path, mut engine) = store();
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
    // MUTATION: omit the receiver-local bump from imported message apply -> stale generation/state remains.
    assert_eq!(state, (2, "pending".to_owned(), None, 40));
}

#[test]
fn imported_message_indexes_mentions_only_when_inserted() {
    let (_scratch, _path, mut engine) = store();
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
    // MUTATION: indexing before checking INSERT OR IGNORE admits the duplicate payload's handle.
    assert_eq!(handles, vec!["one"]);
}

#[test]
fn imported_attachment_cross_origin_duplicate_requeues_active_live_bookmarks() {
    let (_scratch, _path, mut engine) = store();
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
    // MUTATION: omit the receiver-local bump from imported attachment apply -> bookmark is not reprojected.
    assert_eq!(state, (2, "pending".to_owned(), 41));

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
    // MUTATION: gate the bump on INSERT OR IGNORE's affected-row count -> this reachable duplicate stays at 2.
    assert_eq!(duplicated, 3);
}

#[test]
fn imported_attachment_recomputes_id_and_rejects_mismatch() {
    let (_scratch, _path, mut engine) = store();
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
    // MUTATION: trust the peer's attachment id -> forged content identity is persisted and acked.
    assert_invalid_refusal!(result);
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "hostile-attachment").expect("ack"),
        0
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
        // MUTATION: drop the created_at_ms bound -> an at_ms beyond the JS-safe
        // range is accepted here, then map_attachment_row rejects the row and
        // every attachment read for the thread becomes state-corrupt.
        (
            "created_at_ms_bound",
            json!({"objectId":"object","createdAtMs": i64::MAX}),
        ),
    ];
    for (case, fields) in cases {
        let (_scratch, _path, mut engine) = store();
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
        // MUTATION: remove this hostile-peer heading/path guard -> the named malformed case applies.
        assert!(
            matches!(
                result,
                Ok(ApplyOutcome::Refused(ReplicationRefusal {
                    reason: RefusalReason::InvalidInput { .. },
                    ..
                }))
            ),
            "case {case}"
        );
    }
}

#[test]
fn chat_reaction_lww_converges_across_origin_arrival_order() {
    let (_a, _path_a, mut first) = store();
    let (_b, _path_b, mut second) = store();
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

#[test]
fn share_view_and_shared_channel_fail_closed_outside_boundary() {
    let (_scratch, _path, mut engine) = store();
    let view = ShareBoundary {
        share_id: "share-view".to_owned(),
        surface: ShareSurface::ShareView,
        channel_wire_id: None,
        granted: Some(ShareGrant {
            paths: vec!["shared/docs".to_owned()],
            version_id: None,
        }),
    };
    let secret = envelope(
        "peer",
        0,
        "moment.append",
        json!({"path":"shared/docs/.env"}),
    );
    assert!(matches!(
        apply_shared_envelope(&mut engine, &view, &secret, &NoFaults),
        Err(SyncError::ShareBoundaryViolation)
    ));
    let channel = ShareBoundary {
        share_id: "share-channel".to_owned(),
        surface: ShareSurface::SharedChannel,
        channel_wire_id: Some("wire-allowed".to_owned()),
        granted: None,
    };
    let private = envelope(
        "peer",
        0,
        "chat.follow.set",
        json!({"ownerUserId":"u","targetKind":"channel","targetId":"x","state":"following","atMs":1}),
    );
    assert!(matches!(
        apply_shared_envelope(&mut engine, &channel, &private, &NoFaults),
        Err(SyncError::ShareBoundaryViolation)
    ));
}

#[test]
fn shared_channel_channel_create_without_wire_id_is_rejected() {
    let (_scratch, _path, mut engine) = store();
    let boundary = ShareBoundary {
        share_id: "share-channel".to_owned(),
        surface: ShareSurface::SharedChannel,
        channel_wire_id: Some("wire-allowed".to_owned()),
        granted: None,
    };
    let op = envelope(
        "missing-wire",
        0,
        "chat.channel.create",
        json!({
            "channelId": "c-allow",
            "name": "Allowed",
            "slug": "allowed",
            "kind": "channel",
            "createdAtMs": 1
        }),
    );
    assert!(matches!(
        apply_shared_envelope(&mut engine, &boundary, &op, &NoFaults),
        Err(SyncError::ShareBoundaryViolation)
    ));
}

#[test]
fn shared_channel_cross_channel_thread_and_message_are_rejected() {
    let (_scratch, _path, mut engine) = store();
    let other = ShareBoundary {
        share_id: "share-other".to_owned(),
        surface: ShareSurface::SharedChannel,
        channel_wire_id: Some("wire-other".to_owned()),
        granted: None,
    };
    let channel = envelope(
        "cross-channel",
        0,
        "chat.channel.create",
        json!({
            "channelId": "c-other",
            "name": "Other",
            "slug": "other",
            "kind": "channel",
            "createdAtMs": 1,
            "wireId": "wire-other"
        }),
    );
    assert!(matches!(
        apply_shared_envelope(&mut engine, &other, &channel, &NoFaults),
        Ok(ApplyOutcome::Applied(_))
    ));
    let thread = envelope(
        "cross-channel",
        1,
        "chat.thread.create",
        json!({
            "threadId": "t-other",
            "title": "Other thread",
            "createdAtMs": 2,
            "channelWireId": "wire-other"
        }),
    );
    assert!(matches!(
        apply_shared_envelope(&mut engine, &other, &thread, &NoFaults),
        Ok(ApplyOutcome::Applied(_))
    ));

    let allowed = ShareBoundary {
        share_id: "share-allowed".to_owned(),
        surface: ShareSurface::SharedChannel,
        channel_wire_id: Some("wire-allowed".to_owned()),
        granted: None,
    };
    let foreign_thread = envelope(
        "cross-channel",
        2,
        "chat.thread.create",
        json!({
            "threadId": "t-foreign",
            "title": "Foreign thread",
            "createdAtMs": 3,
            "channelWireId": "wire-other"
        }),
    );
    assert!(matches!(
        apply_shared_envelope(&mut engine, &allowed, &foreign_thread, &NoFaults),
        Err(SyncError::ShareBoundaryViolation)
    ));
    let foreign_message = envelope(
        "cross-channel",
        2,
        "chat.message.append",
        json!({
            "messageId": "m-other",
            "threadId": "t-other",
            "authorKind": "human",
            "authorDisplayName": "User",
            "body": "Outside the grant",
            "createdAtMs": 4
        }),
    );
    assert!(matches!(
        apply_shared_envelope(&mut engine, &allowed, &foreign_message, &NoFaults),
        Err(SyncError::ShareBoundaryViolation)
    ));
}

#[test]
fn shared_channel_correctly_scoped_ops_apply() {
    let (_scratch, _path, mut engine) = store();
    let boundary = ShareBoundary {
        share_id: "share-allowed".to_owned(),
        surface: ShareSurface::SharedChannel,
        channel_wire_id: Some("wire-allowed".to_owned()),
        granted: None,
    };
    let channel = envelope(
        "allowed-channel",
        0,
        "chat.channel.create",
        json!({
            "channelId": "c-allow",
            "name": "Allowed",
            "slug": "allowed",
            "kind": "channel",
            "createdAtMs": 1,
            "wireId": "wire-allowed"
        }),
    );
    assert!(matches!(
        apply_shared_envelope(&mut engine, &boundary, &channel, &NoFaults),
        Ok(ApplyOutcome::Applied(_))
    ));
    let thread = envelope(
        "allowed-channel",
        1,
        "chat.thread.create",
        json!({
            "threadId": "t-allow",
            "title": "Allowed thread",
            "createdAtMs": 2,
            "channelWireId": "wire-allowed"
        }),
    );
    assert!(matches!(
        apply_shared_envelope(&mut engine, &boundary, &thread, &NoFaults),
        Ok(ApplyOutcome::Applied(_))
    ));
    let message = envelope(
        "allowed-channel",
        2,
        "chat.message.append",
        json!({
            "messageId": "m-allow",
            "threadId": "t-allow",
            "authorKind": "human",
            "authorDisplayName": "User",
            "body": "Inside the grant",
            "createdAtMs": 3
        }),
    );
    assert!(matches!(
        apply_shared_envelope(&mut engine, &boundary, &message, &NoFaults),
        Ok(ApplyOutcome::Applied(_))
    ));
    let rows: Vec<(String, String)> = engine
        .read_with(|conn| {
            let mut statement = conn.prepare(
                "SELECT message_id,text FROM engine_search_chat_messages_fts \
                 WHERE workspace_id='ws' AND thread_id='t-allow' ORDER BY message_id",
            )?;
            statement
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
                .collect::<rusqlite::Result<Vec<_>>>()
        })
        .expect("shared-channel search rows");
    assert_eq!(
        rows,
        vec![
            (
                CHAT_THREAD_HEADER_MESSAGE_ID.to_owned(),
                "Allowed thread".to_owned()
            ),
            ("m-allow".to_owned(), "User\nInside the grant".to_owned())
        ]
    );
}

#[test]
fn share_view_secondary_path_out_of_boundary_is_rejected() {
    let (_scratch, _path, mut engine) = store();
    let boundary = ShareBoundary {
        share_id: "share-view".to_owned(),
        surface: ShareSurface::ShareView,
        channel_wire_id: None,
        granted: Some(ShareGrant {
            paths: vec!["shared/docs".to_owned()],
            version_id: None,
        }),
    };
    let crossing = envelope(
        "view-paths",
        0,
        "moment.append",
        json!({
            "path": "shared/docs/a.md",
            "payloadAfterPath": "outside/b.md"
        }),
    );
    assert!(matches!(
        apply_shared_envelope(&mut engine, &boundary, &crossing, &NoFaults),
        Err(SyncError::ShareBoundaryViolation)
    ));
    let inside = envelope(
        "view-paths",
        0,
        "moment.append",
        json!({
            "path": "shared/docs/a.md",
            "payloadAfterPath": "shared/docs/b.md"
        }),
    );
    assert!(matches!(
        apply_shared_envelope(&mut engine, &boundary, &inside, &NoFaults),
        Ok(ApplyOutcome::Applied(_))
    ));
}

#[derive(Default)]
struct FakeRelay {
    pushes: Mutex<usize>,
    pull: Mutex<Option<PullResponse>>,
}

impl RelayTransport for FakeRelay {
    fn push(&self, req: PushRequest) -> Result<PushResponse, RelayError> {
        *self.pushes.lock().expect("push lock") += 1;
        let accepted = req.ops.len();
        let current_max_origin_seq = req.ops.last().map_or(req.after_seq, |op| op.origin_seq);
        Ok(PushResponse {
            accepted,
            inserted: accepted,
            skipped: 0,
            current_max_origin_seq,
        })
    }
    fn pull(&self, _req: PullRequest) -> Result<PullResponse, RelayError> {
        self.pull
            .lock()
            .expect("pull lock")
            .clone()
            .ok_or(RelayError::InvalidResponse)
    }
    fn probe(&self, _req: ProbeRequest) -> Result<ProbeResponse, RelayError> {
        Ok(ProbeResponse { has_content: false })
    }
    fn claim_workspace(&self, _req: ClaimRequest) -> Result<ClaimResponse, RelayError> {
        Ok(ClaimResponse)
    }
    fn rotate_epoch(&self, _req: EpochRequest) -> Result<EpochResponse, RelayError> {
        Err(RelayError::InvalidResponse)
    }
    fn blobs_have(&self, _req: BlobHaveRequest) -> Result<BlobHaveResponse, RelayError> {
        Ok(BlobHaveResponse {
            missing: Vec::new(),
        })
    }
    fn upload_blob(&self, _req: BlobUploadRequest) -> Result<(), RelayError> {
        Ok(())
    }
    fn download_blob(&self, _req: BlobDownloadRequest) -> Result<BlobDownloadResponse, RelayError> {
        Err(RelayError::BlobMissing)
    }
    fn upload_key_envelope(
        &self,
        _req: KeyEnvelopeRequest,
    ) -> Result<KeyEnvelopeResponse, RelayError> {
        Ok(KeyEnvelopeResponse {
            etag: "etag".to_owned(),
        })
    }
    fn download_key_envelope(
        &self,
        _req: KeyEnvelopeDownloadRequest,
    ) -> Result<KeyEnvelopeDownloadResponse, RelayError> {
        Err(RelayError::KeyEnvelopeMissing)
    }
    fn shared_channel_pull(
        &self,
        _req: SharedChannelRequest,
    ) -> Result<SharedChannelResponse, RelayError> {
        Err(RelayError::InvalidResponse)
    }
    fn shared_channel_push(
        &self,
        _req: SharedChannelRequest,
    ) -> Result<SharedChannelResponse, RelayError> {
        Err(RelayError::InvalidResponse)
    }
    fn share_view_pull(&self, _req: ShareViewRequest) -> Result<ShareViewResponse, RelayError> {
        Err(RelayError::InvalidResponse)
    }
    fn share_blob(&self, _req: ShareBlobRequest) -> Result<BlobDownloadResponse, RelayError> {
        Err(RelayError::ShareUnavailable)
    }
}

#[derive(Default)]
struct KeyConflictRelay {
    uploads: Mutex<Vec<KeyEnvelopeRequest>>,
    downloads: Mutex<usize>,
}

impl RelayTransport for KeyConflictRelay {
    fn push(&self, _req: PushRequest) -> Result<PushResponse, RelayError> {
        Err(RelayError::InvalidResponse)
    }
    fn pull(&self, _req: PullRequest) -> Result<PullResponse, RelayError> {
        Err(RelayError::InvalidResponse)
    }
    fn probe(&self, _req: ProbeRequest) -> Result<ProbeResponse, RelayError> {
        Err(RelayError::InvalidResponse)
    }
    fn claim_workspace(&self, _req: ClaimRequest) -> Result<ClaimResponse, RelayError> {
        Err(RelayError::InvalidResponse)
    }
    fn rotate_epoch(&self, _req: EpochRequest) -> Result<EpochResponse, RelayError> {
        Err(RelayError::InvalidResponse)
    }
    fn blobs_have(&self, _req: BlobHaveRequest) -> Result<BlobHaveResponse, RelayError> {
        Err(RelayError::InvalidResponse)
    }
    fn upload_blob(&self, _req: BlobUploadRequest) -> Result<(), RelayError> {
        Err(RelayError::InvalidResponse)
    }
    fn download_blob(&self, _req: BlobDownloadRequest) -> Result<BlobDownloadResponse, RelayError> {
        Err(RelayError::InvalidResponse)
    }
    fn upload_key_envelope(
        &self,
        req: KeyEnvelopeRequest,
    ) -> Result<KeyEnvelopeResponse, RelayError> {
        self.uploads.lock().expect("key uploads").push(req);
        Err(RelayError::Conflict)
    }
    fn download_key_envelope(
        &self,
        _req: KeyEnvelopeDownloadRequest,
    ) -> Result<KeyEnvelopeDownloadResponse, RelayError> {
        *self.downloads.lock().expect("key downloads") += 1;
        Ok(KeyEnvelopeDownloadResponse {
            envelope_json: r#"{"winner":true}"#.to_owned(),
            etag: "winner-etag".to_owned(),
        })
    }
    fn shared_channel_pull(
        &self,
        _req: SharedChannelRequest,
    ) -> Result<SharedChannelResponse, RelayError> {
        Err(RelayError::InvalidResponse)
    }
    fn shared_channel_push(
        &self,
        _req: SharedChannelRequest,
    ) -> Result<SharedChannelResponse, RelayError> {
        Err(RelayError::InvalidResponse)
    }
    fn share_view_pull(&self, _req: ShareViewRequest) -> Result<ShareViewResponse, RelayError> {
        Err(RelayError::InvalidResponse)
    }
    fn share_blob(&self, _req: ShareBlobRequest) -> Result<BlobDownloadResponse, RelayError> {
        Err(RelayError::InvalidResponse)
    }
}

#[test]
fn key_envelope_conflict_is_surfaced_without_rebasing_over_the_winner() {
    let client = RelaySyncClient::new(KeyConflictRelay::default());
    let request = KeyEnvelopeRequest {
        workspace_id: "ws".to_owned(),
        replication_epoch: "epoch".to_owned(),
        stream_identity: "stream".to_owned(),
        envelope_json: r#"{"stale":true}"#.to_owned(),
        if_match: Some("stale-etag".to_owned()),
    };
    assert_eq!(
        client.upload_key_envelope(request.clone()),
        Err(RelayError::Conflict)
    );
    assert_eq!(
        *client.transport().uploads.lock().expect("key uploads"),
        [request],
        "MUTATION: conflict rebasing sends the stale bytes a second time"
    );
    assert_eq!(
        *client.transport().downloads.lock().expect("key downloads"),
        0,
        "a strict CAS client must not fetch an ETag solely to overwrite its winner"
    );
}

#[test]
fn fresh_coordinate_does_not_canonicalize_payload_for_a_comparison_that_cannot_exist() {
    let (_scratch, _path, mut engine) = store();
    let incoming = envelope("canonical-peer", 0, "probe", json!({"z": 1, "a": [2, 3]}));
    let _ = crate::relay::take_canonical_json_call_count();
    assert!(matches!(
        apply_envelope_with(&mut engine, &incoming, &NoFaults, |_, _| Ok(())),
        Ok(ApplyOutcome::Applied(()))
    ));
    assert_eq!(
        crate::relay::take_canonical_json_call_count(),
        0,
        "MUTATION: eager canonicalization does unused work on every fresh coordinate"
    );
    assert!(matches!(
        apply_envelope_with(&mut engine, &incoming, &NoFaults, |_, _| Ok(())),
        Ok(ApplyOutcome::Skipped)
    ));
    assert_eq!(
        crate::relay::take_canonical_json_call_count(),
        2,
        "redelivery canonicalizes both the incoming and stored payload before comparing"
    );
}

struct PagedRelay {
    pages: BTreeMap<i64, PullResponse>,
    blobs: BTreeMap<String, Vec<u8>>,
    pulls: Mutex<Vec<(i64, usize)>>,
}

impl PagedRelay {
    fn new(pages: impl IntoIterator<Item = (i64, PullResponse)>) -> Self {
        Self {
            pages: pages.into_iter().collect(),
            blobs: BTreeMap::new(),
            pulls: Mutex::new(Vec::new()),
        }
    }
}

impl RelayTransport for PagedRelay {
    fn push(&self, _req: PushRequest) -> Result<PushResponse, RelayError> {
        Err(RelayError::InvalidResponse)
    }

    fn pull(&self, req: PullRequest) -> Result<PullResponse, RelayError> {
        self.pulls
            .lock()
            .expect("pull calls")
            .push((req.cursor, req.limit));
        self.pages
            .get(&req.cursor)
            .cloned()
            .ok_or(RelayError::InvalidResponse)
    }

    fn probe(&self, _req: ProbeRequest) -> Result<ProbeResponse, RelayError> {
        Ok(ProbeResponse { has_content: false })
    }

    fn claim_workspace(&self, _req: ClaimRequest) -> Result<ClaimResponse, RelayError> {
        Ok(ClaimResponse)
    }

    fn rotate_epoch(&self, _req: EpochRequest) -> Result<EpochResponse, RelayError> {
        Err(RelayError::InvalidResponse)
    }

    fn blobs_have(&self, _req: BlobHaveRequest) -> Result<BlobHaveResponse, RelayError> {
        Ok(BlobHaveResponse {
            missing: Vec::new(),
        })
    }

    fn upload_blob(&self, _req: BlobUploadRequest) -> Result<(), RelayError> {
        Ok(())
    }

    fn download_blob(&self, req: BlobDownloadRequest) -> Result<BlobDownloadResponse, RelayError> {
        self.blobs
            .get(&req.sha256)
            .cloned()
            .map(|bytes| BlobDownloadResponse { bytes })
            .ok_or(RelayError::BlobMissing)
    }

    fn upload_key_envelope(
        &self,
        _req: KeyEnvelopeRequest,
    ) -> Result<KeyEnvelopeResponse, RelayError> {
        Err(RelayError::InvalidResponse)
    }

    fn download_key_envelope(
        &self,
        _req: KeyEnvelopeDownloadRequest,
    ) -> Result<KeyEnvelopeDownloadResponse, RelayError> {
        Err(RelayError::KeyEnvelopeMissing)
    }

    fn shared_channel_pull(
        &self,
        _req: SharedChannelRequest,
    ) -> Result<SharedChannelResponse, RelayError> {
        Err(RelayError::InvalidResponse)
    }

    fn shared_channel_push(
        &self,
        _req: SharedChannelRequest,
    ) -> Result<SharedChannelResponse, RelayError> {
        Err(RelayError::InvalidResponse)
    }

    fn share_view_pull(&self, _req: ShareViewRequest) -> Result<ShareViewResponse, RelayError> {
        Err(RelayError::InvalidResponse)
    }

    fn share_blob(&self, _req: ShareBlobRequest) -> Result<BlobDownloadResponse, RelayError> {
        Err(RelayError::ShareUnavailable)
    }
}

struct PagedShareRelay {
    shared_pages: BTreeMap<i64, SharedChannelResponse>,
    view_pages: BTreeMap<i64, ShareViewResponse>,
    shared_pulls: Mutex<Vec<i64>>,
    shared_pushes: Mutex<Vec<SharedChannelRequest>>,
    view_pulls: Mutex<Vec<(i64, usize)>>,
    view_blobs: BTreeMap<String, Vec<u8>>,
    share_blob_calls: Mutex<Vec<String>>,
}

impl PagedShareRelay {
    fn new(
        shared_pages: impl IntoIterator<Item = (i64, SharedChannelResponse)>,
        view_pages: impl IntoIterator<Item = (i64, ShareViewResponse)>,
    ) -> Self {
        Self {
            shared_pages: shared_pages.into_iter().collect(),
            view_pages: view_pages.into_iter().collect(),
            shared_pulls: Mutex::new(Vec::new()),
            shared_pushes: Mutex::new(Vec::new()),
            view_pulls: Mutex::new(Vec::new()),
            view_blobs: BTreeMap::new(),
            share_blob_calls: Mutex::new(Vec::new()),
        }
    }

    fn with_view_blobs(mut self, blobs: impl IntoIterator<Item = (String, Vec<u8>)>) -> Self {
        self.view_blobs = blobs.into_iter().collect();
        self
    }
}

impl RelayTransport for PagedShareRelay {
    fn push(&self, _req: PushRequest) -> Result<PushResponse, RelayError> {
        Err(RelayError::InvalidResponse)
    }

    fn pull(&self, _req: PullRequest) -> Result<PullResponse, RelayError> {
        Err(RelayError::InvalidResponse)
    }

    fn probe(&self, _req: ProbeRequest) -> Result<ProbeResponse, RelayError> {
        Err(RelayError::InvalidResponse)
    }

    fn claim_workspace(&self, _req: ClaimRequest) -> Result<ClaimResponse, RelayError> {
        Err(RelayError::InvalidResponse)
    }

    fn rotate_epoch(&self, _req: EpochRequest) -> Result<EpochResponse, RelayError> {
        Err(RelayError::InvalidResponse)
    }

    fn blobs_have(&self, _req: BlobHaveRequest) -> Result<BlobHaveResponse, RelayError> {
        Err(RelayError::InvalidResponse)
    }

    fn upload_blob(&self, _req: BlobUploadRequest) -> Result<(), RelayError> {
        Err(RelayError::InvalidResponse)
    }

    fn download_blob(&self, _req: BlobDownloadRequest) -> Result<BlobDownloadResponse, RelayError> {
        Err(RelayError::InvalidResponse)
    }

    fn upload_key_envelope(
        &self,
        _req: KeyEnvelopeRequest,
    ) -> Result<KeyEnvelopeResponse, RelayError> {
        Err(RelayError::InvalidResponse)
    }

    fn download_key_envelope(
        &self,
        _req: KeyEnvelopeDownloadRequest,
    ) -> Result<KeyEnvelopeDownloadResponse, RelayError> {
        Err(RelayError::InvalidResponse)
    }

    fn shared_channel_pull(
        &self,
        req: SharedChannelRequest,
    ) -> Result<SharedChannelResponse, RelayError> {
        self.shared_pulls
            .lock()
            .expect("shared pull calls")
            .push(req.cursor);
        self.shared_pages
            .get(&req.cursor)
            .cloned()
            .ok_or(RelayError::InvalidResponse)
    }

    fn shared_channel_push(
        &self,
        req: SharedChannelRequest,
    ) -> Result<SharedChannelResponse, RelayError> {
        let accepted = req.ops.len();
        let current_max_origin_seq = req.ops.last().map_or(-1, |op| op.origin_seq);
        self.shared_pushes
            .lock()
            .expect("shared push calls")
            .push(req);
        Ok(SharedChannelResponse {
            ops: Vec::new(),
            next_cursor: 0,
            has_more: false,
            push: Some(PushResponse {
                accepted,
                inserted: accepted,
                skipped: 0,
                current_max_origin_seq,
            }),
        })
    }

    fn share_view_pull(&self, req: ShareViewRequest) -> Result<ShareViewResponse, RelayError> {
        self.view_pulls
            .lock()
            .expect("view pull calls")
            .push((req.cursor, req.limit));
        self.view_pages
            .get(&req.cursor)
            .cloned()
            .ok_or(RelayError::InvalidResponse)
    }

    fn share_blob(&self, req: ShareBlobRequest) -> Result<BlobDownloadResponse, RelayError> {
        self.share_blob_calls
            .lock()
            .expect("share blob calls")
            .push(req.sha256.clone());
        self.view_blobs
            .get(&req.sha256)
            .cloned()
            .map(|bytes| BlobDownloadResponse { bytes })
            .ok_or(RelayError::InvalidResponse)
    }
}

fn seed_identity(engine: &mut EngineStore) {
    let outcome = journal_local_replication_op(
        engine,
        "ws",
        "local",
        "epoch-1",
        "stream-1",
        "probe.local",
        &json!({}),
        1_000,
        &NoFaults,
    )
    .expect("identity");
    assert_eq!(outcome, TxnOutcome::Committed(0));
}

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
        ApplyOutcome::Applied(())
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
fn relay_pull_recovers_only_a_diverged_local_origin() {
    for (origin_id, expected) in [
        ("local", RelayError::OriginDiverged),
        ("peer", RelayError::InvalidResponse),
    ] {
        let (_scratch, _path, mut engine) = store();
        seed_identity(&mut engine);
        if origin_id == "peer" {
            engine
                .write_with(&NoFaults, |tx| {
                    tx.execute(
                        "INSERT INTO replication_log \
                         (workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms,imported) \
                         VALUES ('ws','peer',0,'probe.peer','{}',1000,1)",
                        [],
                    )
                    .map_err(SyncError::persist)?;
                    Ok::<_, SyncError>(())
                })
                .expect("seed imported coordinate");
        }
        let client = RelaySyncClient::new(FakeRelay {
            pushes: Mutex::new(0),
            pull: Mutex::new(Some(PullResponse {
                ops: vec![envelope(
                    origin_id,
                    0,
                    if origin_id == "local" {
                        "probe.local"
                    } else {
                        "probe.peer"
                    },
                    json!({"changed": true}),
                )],
                next_cursor: 1,
                has_more: false,
            })),
        });

        assert_eq!(
            client.pull_chat_workspace(&mut engine, "ws", &NoFaults, &NoLiveLeases),
            Err(expected),
            "{origin_id}"
        );
    }
}

#[test]
fn fault_sync_after_push_before_cursor_persist_repushes_without_local_double_advance() {
    let (_scratch, path, mut engine) = store();
    seed_identity(&mut engine);
    let client = RelaySyncClient::new(FakeRelay::default());
    let faults = ScriptedFaults::crash_at(FaultPoint::SyncAfterPushBeforeCursorPersist);
    assert_eq!(
        client
            .push_workspace(&mut engine, "ws", faults.as_ref())
            .expect("push fault"),
        SyncPassOutcome::CrashedAfterRemoteCommit
    );
    drop(engine);
    let mut reopened = EngineStore::open(&path, 2_000).expect("reopen");
    assert_eq!(
        read_pushed_seq(&reopened, "ws", "local").expect("cursor"),
        -1
    );
    client
        .push_workspace(&mut reopened, "ws", &NoFaults)
        .expect("retry push");
    assert_eq!(
        read_pushed_seq(&reopened, "ws", "local").expect("cursor"),
        0
    );
    assert_eq!(*client.transport().pushes.lock().expect("calls"), 2);
}

#[test]
fn journal_rejects_payloads_above_the_relay_contract() {
    // MUTATION: restoring the former 10 MiB journal limit accepts `oversized`.
    let (_scratch, _path, mut engine) = store();
    let overhead = br#"{"data":""}"#.len();
    let exact = json!({"data": "x".repeat(MAX_PAYLOAD_JSON_BYTES - overhead)});
    assert_eq!(
        serde_json::to_vec(&exact).expect("exact payload").len(),
        MAX_PAYLOAD_JSON_BYTES
    );
    assert_eq!(
        journal_local_replication_op(
            &mut engine,
            "ws",
            "local",
            "epoch-1",
            "stream-1",
            "probe.local",
            &exact,
            1_000,
            &NoFaults,
        )
        .expect("exact-limit payload"),
        TxnOutcome::Committed(0)
    );

    let oversized = json!({"data": "x".repeat(MAX_PAYLOAD_JSON_BYTES - overhead + 1)});
    assert!(matches!(
        journal_local_replication_op(
            &mut engine,
            "ws",
            "local",
            "epoch-1",
            "stream-1",
            "probe.local",
            &oversized,
            1_001,
            &NoFaults,
        ),
        Err(SyncError::InvalidInput {
            reason: "payload exceeds the relay limit"
        })
    ));
}

#[test]
fn canonical_json_matches_javascript_number_boundaries() {
    let cases = [
        (json!(1e21), "1e+21"),
        (json!(1e-6), "0.000001"),
        (json!(1e-7), "1e-7"),
        (json!(-0.0), "0"),
        (
            serde_json::from_str("9007199254740993").expect("integer above 2^53"),
            "9007199254740992",
        ),
    ];
    for (value, expected) in cases {
        assert_eq!(
            crate::relay::canonical_json_bytes(&value).expect("canonical number"),
            expected.as_bytes(),
            "JavaScript stableJsonStringify parity for {value}"
        );
    }
}

#[test]
fn fault_sync_between_apply_and_cursor_commit_refetches_and_dedups() {
    let (_scratch, path, mut engine) = store();
    seed_identity(&mut engine);
    let remote = envelope(
        "peer",
        0,
        "chat.reaction.set",
        json!({"reactionId":"r","messageId":"m","threadId":"t","emoji":"👍","authorId":"u","authorKind":"human","authorDisplayName":"U","atMs":10,"state":"added"}),
    );
    let fake = FakeRelay {
        pushes: Mutex::new(0),
        pull: Mutex::new(Some(PullResponse {
            ops: vec![remote],
            next_cursor: 1,
            has_more: false,
        })),
    };
    let client = RelaySyncClient::new(fake);
    let faults = ScriptedFaults::crash_at(FaultPoint::SyncBetweenApplyAndCursorCommit);
    let first = client
        .pull_chat_workspace(&mut engine, "ws", faults.as_ref(), &NoLiveLeases)
        .expect("pull fault");
    assert!(matches!(
        first,
        SyncPassOutcome::CrashedAfterApply { applied: 1, .. }
    ));
    drop(engine);
    let mut reopened = EngineStore::open(&path, 2_000).expect("reopen");
    assert!(
        read_relay_cursor(&reopened, "ws")
            .expect("cursor")
            .is_none()
    );
    let retry = client
        .pull_chat_workspace(&mut reopened, "ws", &NoFaults, &NoLiveLeases)
        .expect("retry pull");
    let pending = match retry {
        SyncPassOutcome::Complete {
            applied: 0,
            skipped: 1,
            pending_cursor: Some(cursor),
            ..
        } => cursor,
        other => panic!("unexpected retry outcome: {other:?}"),
    };
    assert_eq!(
        client
            .commit_pull_cursor(&mut reopened, "ws", &pending, &NoFaults)
            .expect("commit"),
        TxnOutcome::Committed(())
    );
}

#[derive(Debug, Clone, Copy)]
enum RelayFaultKind {
    Duplicate,
    Reorder,
    Drop,
    Partition,
    RestartMidPull,
}

#[test]
fn seeded_relay_fault_model_converges_without_double_apply() {
    let faults = [
        RelayFaultKind::Duplicate,
        RelayFaultKind::Reorder,
        RelayFaultKind::Drop,
        RelayFaultKind::Partition,
        RelayFaultKind::RestartMidPull,
    ];
    assert_eq!(faults.len(), 5);
    let ops = vec![
        envelope(
            "origin-a",
            0,
            "chat.reaction.set",
            json!({"reactionId":"r","messageId":"m","threadId":"t","emoji":"👍","authorId":"u","authorKind":"human","authorDisplayName":"U","atMs":10,"state":"added"}),
        ),
        envelope(
            "origin-b",
            0,
            "chat.reaction.set",
            json!({"reactionId":"r","messageId":"m","threadId":"t","emoji":"👍","authorId":"u","authorKind":"human","authorDisplayName":"U","atMs":20,"state":"removed"}),
        ),
        envelope(
            "origin-c",
            0,
            "chat.reaction.set",
            json!({"reactionId":"r","messageId":"m","threadId":"t","emoji":"👍","authorId":"u","authorKind":"human","authorDisplayName":"U","atMs":15,"state":"added"}),
        ),
    ];

    let (scratch_a, path_a, mut a) = store();
    let (_scratch_b, _path_b, mut b) = store();
    let (_scratch_c, _path_c, mut c) = store();

    // Seed 0xR10's deterministic schedule: reordered delivery, a dropped
    // packet, a partitioned peer, a duplicate, and a restart after a prefix.
    for op in ops.iter().rev() {
        apply_chat_envelope(&mut a, op, &NoFaults).expect("a reordered");
    }
    apply_chat_envelope(&mut a, &ops[1], &NoFaults).expect("a duplicate");

    apply_chat_envelope(&mut b, &ops[0], &NoFaults).expect("b prefix");
    drop(b);
    let mut b = EngineStore::open(&_path_b, 3_000).expect("b restart mid pull");
    apply_chat_envelope(&mut b, &ops[2], &NoFaults).expect("b after dropped middle");

    // c is partitioned during the first pass and receives nothing.
    assert_eq!(
        read_replication_acked_seq(&c, "ws", "origin-a").expect("partition ack"),
        -1
    );

    // Healing pass: every instance receives the complete relay log. Exact
    // duplicates are skipped; missing coordinates apply once.
    for engine in [&mut a, &mut b, &mut c] {
        for op in &ops {
            apply_chat_envelope(engine, op, &NoFaults).expect("healed delivery");
        }
    }

    let normalized = |engine: &EngineStore| {
        engine
            .read_with(|conn| {
                let cell = conn.query_row(
                    "SELECT state,at_ms,origin_id,origin_seq FROM chat_reactions WHERE workspace_id='ws'",
                    [],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?, row.get::<_, String>(2)?, row.get::<_, i64>(3)?)),
                )?;
                let log_count: i64 = conn.query_row(
                    "SELECT COUNT(*) FROM replication_log WHERE workspace_id='ws'",
                    [],
                    |row| row.get(0),
                )?;
                Ok::<_, rusqlite::Error>((cell, log_count))
            })
            .expect("normalized")
    };
    let expected = normalized(&a);
    assert_eq!(expected, normalized(&b));
    assert_eq!(expected, normalized(&c));
    assert_eq!(expected.0.0, "removed");
    assert_eq!(expected.1, 3, "duplicates never append a second coordinate");

    drop(a);
    let reopened = EngineStore::open(&path_a, 4_000).expect("a durable reopen");
    assert_eq!(expected, normalized(&reopened));
    drop(reopened);
    drop(scratch_a);
}

// -------------------------------------------------------------------- round 2
// Regression coverage for the Codex-bot review findings triaged in round 2.

/// #6 (apply dedup ordering): a redelivered coordinate at or below the ack with
/// a DIVERGENT payload must fail closed (never silently skip, never mutate).
#[test]
fn redelivered_divergent_coordinate_at_acked_seq_is_rejected() {
    let (_scratch, _path, mut engine) = store();
    let first = envelope(
        "peer",
        0,
        "chat.channel.create",
        json!({"channelId":"c1","name":"First","slug":"first","kind":"channel","createdAtMs":1}),
    );
    assert!(matches!(
        apply_chat_envelope(&mut engine, &first, &NoFaults),
        Ok(ApplyOutcome::Applied(()))
    ));
    // Same coordinate (origin peer, seq 0), different payload — a tamper/replay.
    let divergent = envelope(
        "peer",
        0,
        "chat.channel.create",
        json!({"channelId":"c1","name":"Tampered","slug":"first","kind":"channel","createdAtMs":1}),
    );
    assert!(matches!(
        apply_chat_envelope(&mut engine, &divergent, &NoFaults),
        Err(SyncError::CoordinateDiverged)
    ));
    // The original row is untouched — no partial mutation from the replay.
    let name: String = engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT name FROM chat_channels WHERE workspace_id='ws' AND channel_id='c1'",
                [],
                |row| row.get(0),
            )
            .map_err(SyncError::corrupt)
        })
        .expect("channel name");
    assert_eq!(name, "First");
    // An EXACT redelivery is still an idempotent skip (not a divergence).
    assert!(matches!(
        apply_chat_envelope(&mut engine, &first, &NoFaults),
        Ok(ApplyOutcome::Skipped)
    ));
}

/// #2 (relay pull workspace gating): a pulled op targeting a foreign workspace
/// must be rejected before apply, and the fetch cursor must not advance.
#[test]
fn pull_rejects_op_for_foreign_workspace() {
    let (_scratch, _path, mut engine) = store();
    seed_identity(&mut engine);
    let foreign = ReplicationEnvelope {
        workspace_id: "other".to_owned(),
        origin_id: "peer".to_owned(),
        origin_seq: 0,
        op_kind: "chat.channel.create".to_owned(),
        payload: json!({"channelId":"c1","name":"X","slug":"x","kind":"channel","createdAtMs":1}),
        recorded_at_ms: 2_000,
    };
    let fake = FakeRelay {
        pushes: Mutex::new(0),
        pull: Mutex::new(Some(PullResponse {
            ops: vec![foreign],
            next_cursor: 1,
            has_more: false,
        })),
    };
    let client = RelaySyncClient::new(fake);
    assert!(matches!(
        client.pull_chat_workspace(&mut engine, "ws", &NoFaults, &NoLiveLeases),
        Err(RelayError::InvalidResponse)
    ));
    // Fail closed: the cursor was never persisted, so the pass is retryable.
    assert!(read_relay_cursor(&engine, "ws").expect("cursor").is_none());
}

/// #4 (secret tombstone): once a delete wins, a later delivery of an OLDER put
/// must NOT resurrect the deleted secret (rank against tombstones, not the
/// materialized secret_files tip).
#[test]
fn secret_delete_tombstone_blocks_older_put_resurrection() {
    use base64::Engine as _;
    use base64::engine::general_purpose::STANDARD;

    let (_scratch, _path, mut engine) = store();
    let cipher_a: &[u8] = b"ciphertext-A-payload";
    let cipher_b: &[u8] = b"ciphertext-B-different-payload";
    let sha_a = dohc_engine_storage::hex_sha256(cipher_a);
    let sha_b = dohc_engine_storage::hex_sha256(cipher_b);
    // Prereqs: the target version must exist and the ciphertext blobs must be
    // hydrated (apply_put reads binary_blobs and checks the hash/length).
    let seeded = engine
        .write_with(&NoFaults, |tx| -> Result<(), SyncError> {
            tx.execute(
                "INSERT OR IGNORE INTO versioned_workspaces (workspace_id, main_version_id) VALUES ('ws','v1')",
                [],
            )
            .map_err(SyncError::persist)?;
            tx.execute(
                "INSERT OR IGNORE INTO versions (workspace_id, version_id, kind, name, created_at_ms) VALUES ('ws','v1','main','Main',1)",
                [],
            )
            .map_err(SyncError::persist)?;
            dohc_engine_storage::put_binary_blob(tx, cipher_a).map_err(SyncError::from)?;
            dohc_engine_storage::put_binary_blob(tx, cipher_b).map_err(SyncError::from)?;
            Ok(())
        })
        .expect("seed secret prereqs");
    assert_eq!(seeded, TxnOutcome::Committed(()));

    let iv = STANDARD.encode([0u8; SECRET_IV_BYTES]);
    let tag = STANDARD.encode([0u8; SECRET_TAG_BYTES]);
    let put = |seq: i64, at: i64, sha: &str, len: i64| ReplicationEnvelope {
        workspace_id: "ws".to_owned(),
        origin_id: "peer".to_owned(),
        origin_seq: seq,
        op_kind: "secret.file.put".to_owned(),
        payload: json!({
            "versionId":"v1","path":"app/.env","metadata":{"origin":"sync"},
            "ivBase64": iv, "authTagBase64": tag, "ciphertextSha256": sha, "byteLength": len
        }),
        recorded_at_ms: at,
    };
    // put @10 wins over an empty tip.
    assert!(matches!(
        apply_secret_envelope(
            &mut engine,
            &put(0, 10, &sha_a, cipher_a.len() as i64),
            &NoFaults
        ),
        Ok(ApplyOutcome::Applied(()))
    ));
    // delete @20 wins and removes the materialized secret_files row.
    let delete = ReplicationEnvelope {
        workspace_id: "ws".to_owned(),
        origin_id: "peer".to_owned(),
        origin_seq: 1,
        op_kind: "secret.file.delete".to_owned(),
        payload: json!({"versionId":"v1","path":"app/.env","metadata":{"origin":"sync"}}),
        recorded_at_ms: 20,
    };
    assert!(matches!(
        apply_secret_envelope(&mut engine, &delete, &NoFaults),
        Ok(ApplyOutcome::Applied(()))
    ));
    // A late delivery of an OLDER put (@5) must NOT resurrect the secret.
    assert!(matches!(
        apply_secret_envelope(
            &mut engine,
            &put(2, 5, &sha_b, cipher_b.len() as i64),
            &NoFaults
        ),
        Ok(ApplyOutcome::Applied(()))
    ));
    let materialized: i64 = engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM secret_files WHERE workspace_id='ws' AND version_id='v1' AND path='app/.env'",
                [],
                |row| row.get(0),
            )
            .map_err(SyncError::corrupt)
        })
        .expect("secret_files count");
    assert_eq!(
        materialized, 0,
        "delete tombstone must block the older-put resurrection"
    );
}

/// #5b (feed-read ranking): a delayed OLDER read receipt with a NEWER wall clock
/// must not move the read cursor backwards.
#[test]
fn feed_read_older_cursor_with_newer_clock_does_not_regress() {
    let (_scratch, _path, mut engine) = store();
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
        Ok(ApplyOutcome::Applied(()))
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
        Ok(ApplyOutcome::Applied(()))
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

/// #5c (reserved agent-channel): the agent kind/name/slug hold IFF the reserved
/// agent wire id is present; malformed shapes are rejected, a correct one applies.
#[test]
fn reserved_agent_channel_shapes_rejected() {
    let (_scratch, _path, mut engine) = store();
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
        Ok(ApplyOutcome::Applied(()))
    ));
}

#[test]
fn parked_ydoc_envelope_drains_into_the_lineage_and_redrains_deduped() {
    let (_scratch, _path, mut engine) = store();
    // The replicated lineage exists before envelopes arrive (base claim);
    // apply_remote_update refuses NoMarker rather than conjuring one. The
    // version row exists because the drain now PROJECTS drained content to
    // the visible head (a real workspace always has its version).
    dohc_engine_domain::VersionedTextStore::new(&mut engine)
        .ensure_main_version("ws", "main", 1_300, &NoFaults)
        .expect("main version");
    engine
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT OR IGNORE INTO versioned_workspaces (workspace_id, main_version_id)                  VALUES ('ws','main')",
                [],
            )
            .map_err(SyncError::persist)?;
            tx.execute(
                "INSERT OR IGNORE INTO file_objects (workspace_id, object_id, created_at_ms)                  VALUES ('ws','object-1',1_400)",
                [],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .expect("workspace scaffolding");
    let key = dohc_engine_collab::DocKey::new("ws", "main", "object-1").expect("key");
    dohc_engine_collab::ensure_marker(
        &mut engine,
        &key,
        dohc_engine_collab::ContentKind::Plaintext,
        dohc_engine_collab::Regime::Replicated,
        &NoFaults,
        1_500,
    )
    .expect("replicated marker");
    let update_bytes = dohc_engine_collab::Ydoc::wire().plaintext_insert(0, "parked edit");
    let blob_sha = engine.put_binary_blob(&update_bytes).expect("store blob");
    let op = envelope(
        "peer",
        0,
        "ydoc.update",
        json!({
            "versionId": "main",
            "objectId": "object-1",
            "path": "notes/live.md",
            "contentKind": "plaintext",
            "updateBlobSha256": blob_sha,
            "isBaseState": false
        }),
    );
    let outcome =
        apply_ydoc_envelope(&mut engine, &op, &NoFaults, &AlwaysLive).expect("live lineage defers");
    assert_eq!(
        outcome,
        ApplyOutcome::Applied(YdocApplyResult {
            deferred: true,
            reason: Some("ydoc-session-live"),
        })
    );

    // The lease is gone (close/eviction/crash — any teardown): the drain must
    // land the acked-but-parked envelope in the durable lineage.
    let drained = drain_deferred_ydoc_for_key(&mut engine, &key, &NoFaults).expect("drain");
    assert_eq!(drained.drained, 1, "the parked envelope must apply");
    assert!(drained.refusals.is_empty());
    // The drain PROJECTS: the drained content is the visible head, not just
    // CRDT rows (a redelivery of the acked coordinate skips the apply
    // closure, so nothing else would ever project it).
    let head_text: String = engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT b.text FROM path_aliases a                  JOIN snapshots s ON s.workspace_id = a.workspace_id AND s.object_id = a.object_id                  JOIN blobs b ON b.sha256 = s.blob_sha256                  WHERE a.workspace_id = 'ws' AND a.version_id = 'main'                    AND a.path = 'notes/live.md'",
                [],
                |r| r.get(0),
            )
            .map_err(SyncError::corrupt)
        })
        .expect("drained head");
    assert_eq!(head_text, "parked edit");
    let update_rows: i64 = engine
        .read_with(|conn| {
            conn.query_row("SELECT COUNT(*) FROM ydoc_updates", [], |row| row.get(0))
                .map_err(SyncError::corrupt)
        })
        .expect("count Y.Doc updates");
    assert_eq!(update_rows, 1, "the drained update reaches the Y.Doc log");

    let redrained = drain_deferred_ydoc_for_key(&mut engine, &key, &NoFaults).expect("redrain");
    assert_eq!(
        redrained.drained, 0,
        "replaying the parked row is content-deduped"
    );
    assert!(redrained.refusals.is_empty());
}

#[test]
fn applied_ydoc_envelopes_materialize_the_projection_with_the_cursorable_ack() {
    // Oracle parity (`projectYDocUpdate` → `writeTextFileInDb` → CRDT rows):
    // an APPLIED (non-deferred) ydoc envelope must advance the VISIBLE head
    // (moment + snapshot + pending materialization job) in the same
    // admission transaction as its ack — not just the CRDT log. Mutation
    // check: drop the `project_and_write_in_tx` calls in
    // `apply_ydoc_envelope`'s base/update arms — both head assertions below
    // fail while the ops still report applied.
    let (_scratch, _path, mut engine) = store();
    dohc_engine_domain::VersionedTextStore::new(&mut engine)
        .ensure_main_version("ws", "main", 1_300, &NoFaults)
        .expect("main version");
    engine
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT OR IGNORE INTO file_objects (workspace_id, object_id, created_at_ms)                  VALUES ('ws','object-mat',1_400)",
                [],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .expect("scaffolding");

    // Base envelope (fresh replica): the FILE head appears, not just rows.
    let base_doc = dohc_engine_collab::Ydoc::wire();
    let base_bytes = {
        base_doc.plaintext_insert(0, "base seed");
        base_doc.encode_full_state()
    };
    let base_sha = engine.put_binary_blob(&base_bytes).expect("base blob");
    let base_op = envelope(
        "peer",
        0,
        "ydoc.update",
        json!({
            "versionId": "main",
            "objectId": "object-mat",
            "path": "notes/replicated.md",
            "contentKind": "plaintext",
            "updateBlobSha256": base_sha,
            "isBaseState": true
        }),
    );
    apply_ydoc_envelope(&mut engine, &base_op, &NoFaults, &NoLiveLeases).expect("base applies");
    let (head_text, head_origin): (String, String) = engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT b.text, s.metadata_origin FROM path_aliases a \
                 JOIN snapshots s ON s.workspace_id = a.workspace_id AND s.object_id = a.object_id \
                 JOIN blobs b ON b.sha256 = s.blob_sha256 \
                 WHERE a.workspace_id = 'ws' AND a.version_id = 'main' \
                   AND a.path = 'notes/replicated.md'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(SyncError::corrupt)
        })
        .expect("base head");
    assert_eq!(head_text, "base seed", "the base must materialize a head");
    assert_eq!(head_origin, "ydoc");
    let pending_jobs: i64 = engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM materialization_jobs WHERE status = 'pending'",
                [],
                |r| r.get(0),
            )
            .map_err(SyncError::corrupt)
        })
        .expect("jobs");
    assert_eq!(pending_jobs, 1, "the disk write is durably enqueued");

    // Update envelope: the head advances to the merged projection.
    let delta = base_doc.plaintext_insert(0, "updated ");
    let delta_sha = engine.put_binary_blob(&delta).expect("delta blob");
    let update_op = envelope(
        "peer",
        1,
        "ydoc.update",
        json!({
            "versionId": "main",
            "objectId": "object-mat",
            "path": "notes/replicated.md",
            "contentKind": "plaintext",
            "updateBlobSha256": delta_sha,
            "isBaseState": false
        }),
    );
    apply_ydoc_envelope(&mut engine, &update_op, &NoFaults, &NoLiveLeases).expect("update applies");
    let updated_text: String = engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT b.text FROM path_aliases a \
                 JOIN snapshots s ON s.workspace_id = a.workspace_id AND s.object_id = a.object_id \
                 JOIN blobs b ON b.sha256 = s.blob_sha256 \
                 WHERE a.workspace_id = 'ws' AND a.version_id = 'main' \
                   AND a.path = 'notes/replicated.md'",
                [],
                |r| r.get(0),
            )
            .map_err(SyncError::corrupt)
        })
        .expect("updated head");
    assert_eq!(updated_text, "updated base seed");
}

#[test]
fn ydoc_storage_failure_is_hard_unacked_and_retryable() {
    let (_scratch, _path, mut engine) = store();
    let install_abort_trigger = |engine: &mut EngineStore, trigger_name: &str, table_name: &str| {
        let sql = format!(
            "CREATE TRIGGER {trigger_name} BEFORE INSERT ON {table_name} \
                 BEGIN SELECT RAISE(ABORT, 'injected Y.Doc storage failure'); END"
        );
        engine
            .write_with(&NoFaults, |tx| {
                tx.execute_batch(&sql).map_err(SyncError::persist)?;
                Ok::<_, SyncError>(())
            })
            .expect("install fault trigger");
    };
    let drop_trigger = |engine: &mut EngineStore, trigger_name: &str| {
        let sql = format!("DROP TRIGGER {trigger_name}");
        engine
            .write_with(&NoFaults, |tx| {
                tx.execute_batch(&sql).map_err(SyncError::persist)?;
                Ok::<_, SyncError>(())
            })
            .expect("clear fault trigger");
    };
    VersionedTextStore::new(&mut engine)
        .ensure_main_version("ws", "main", 1_300, &NoFaults)
        .expect("main version");
    engine
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT INTO file_objects (workspace_id, object_id, created_at_ms) \
                 VALUES ('ws', 'object-storage-fault', 1_400)",
                [],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .expect("file object");

    let doc = dohc_engine_collab::Ydoc::wire();
    doc.plaintext_insert(0, "base");
    let base_sha = engine
        .put_binary_blob(&doc.encode_full_state())
        .expect("base blob");
    let base = envelope(
        "storage-base-peer",
        0,
        "ydoc.update",
        json!({
            "versionId": "main",
            "objectId": "object-storage-fault",
            "path": "notes/storage-fault.md",
            "contentKind": "plaintext",
            "updateBlobSha256": base_sha,
            "isBaseState": true
        }),
    );
    install_abort_trigger(
        &mut engine,
        "inject_ydoc_base_storage_failure",
        "ydoc_snapshots",
    );
    assert!(matches!(
        apply_ydoc_envelope(&mut engine, &base, &NoFaults, &NoLiveLeases),
        Err(SyncError::Storage(_))
    ));
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "storage-base-peer").expect("base ack"),
        -1,
        "a base-claim storage failure must leave the coordinate retryable"
    );
    drop_trigger(&mut engine, "inject_ydoc_base_storage_failure");
    apply_ydoc_envelope(&mut engine, &base, &NoFaults, &NoLiveLeases).expect("base applies");

    let update_sha = engine
        .put_binary_blob(&doc.plaintext_insert(0, "updated "))
        .expect("update blob");
    let update = envelope(
        "storage-update-peer",
        0,
        "ydoc.update",
        json!({
            "versionId": "main",
            "objectId": "object-storage-fault",
            "path": "notes/storage-fault.md",
            "contentKind": "plaintext",
            "updateBlobSha256": update_sha,
            "isBaseState": false
        }),
    );
    for (trigger_name, table_name) in [
        ("inject_ydoc_update_storage_failure", "ydoc_updates"),
        ("inject_ydoc_projection_storage_failure", "moments"),
        (
            "inject_ydoc_materialization_storage_failure",
            "materialization_jobs",
        ),
    ] {
        install_abort_trigger(&mut engine, trigger_name, table_name);
        assert!(matches!(
            apply_ydoc_envelope(&mut engine, &update, &NoFaults, &NoLiveLeases),
            Err(SyncError::Storage(_))
        ));
        assert_eq!(
            read_replication_acked_seq(&engine, "ws", "storage-update-peer").expect("ack"),
            -1,
            "a local storage failure must not retire the remote coordinate"
        );
        let imported: i64 = engine
            .read_with(|conn| {
                conn.query_row(
                    "SELECT COUNT(*) FROM replication_log \
                     WHERE workspace_id='ws' AND origin_id='storage-update-peer'",
                    [],
                    |row| row.get(0),
                )
                .map_err(SyncError::corrupt)
            })
            .expect("imported row count");
        assert_eq!(imported, 0, "a hard failure must not be journaled");
        drop_trigger(&mut engine, trigger_name);
    }

    assert!(matches!(
        apply_ydoc_envelope(&mut engine, &update, &NoFaults, &NoLiveLeases),
        Ok(ApplyOutcome::Applied(YdocApplyResult {
            deferred: false,
            reason: None
        }))
    ));
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "storage-update-peer").expect("retry ack"),
        0
    );
}

#[test]
fn ydoc_update_before_base_is_parked_then_drained_when_lineage_arrives() {
    let (_scratch, _path, mut engine) = store();
    VersionedTextStore::new(&mut engine)
        .ensure_main_version("ws", "main", 1_300, &NoFaults)
        .expect("main version");

    let doc = dohc_engine_collab::Ydoc::wire();
    doc.plaintext_insert(0, "base");
    let base_sha = engine
        .put_binary_blob(&doc.encode_full_state())
        .expect("base blob");
    let update_sha = engine
        .put_binary_blob(&doc.plaintext_insert(0, "before "))
        .expect("dependent update blob");
    let update = envelope(
        "early-update-peer",
        0,
        "ydoc.update",
        json!({
            "versionId": "main",
            "objectId": "object-out-of-order",
            "path": "notes/out-of-order.md",
            "contentKind": "plaintext",
            "updateBlobSha256": update_sha,
            "isBaseState": false
        }),
    );
    assert_eq!(
        apply_ydoc_envelope(&mut engine, &update, &NoFaults, &NoLiveLeases)
            .expect("early update parks"),
        ApplyOutcome::Applied(YdocApplyResult {
            deferred: true,
            reason: Some("ydoc-lineage-absent")
        })
    );
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "early-update-peer").expect("update ack"),
        0
    );
    let parked: i64 = engine
        .read_with(|conn| {
            conn.query_row("SELECT COUNT(*) FROM ydoc_deferred_updates", [], |row| {
                row.get(0)
            })
            .map_err(SyncError::corrupt)
        })
        .expect("parked row count");
    assert_eq!(parked, 1);

    let base = envelope(
        "late-base-peer",
        0,
        "ydoc.update",
        json!({
            "versionId": "main",
            "objectId": "object-out-of-order",
            "path": "notes/out-of-order.md",
            "contentKind": "plaintext",
            "updateBlobSha256": base_sha,
            "isBaseState": true
        }),
    );
    apply_ydoc_envelope(&mut engine, &base, &NoFaults, &NoLiveLeases)
        .expect("base arrives and drains");
    let (parked, updates, head): (i64, i64, String) = engine
        .read_with(|conn| {
            Ok::<_, rusqlite::Error>((
                conn.query_row("SELECT COUNT(*) FROM ydoc_deferred_updates", [], |row| {
                    row.get(0)
                })?,
                conn.query_row("SELECT COUNT(*) FROM ydoc_updates", [], |row| row.get(0))?,
                conn.query_row(
                    "SELECT b.text FROM snapshots s \
                     JOIN blobs b ON b.sha256=s.blob_sha256 \
                     WHERE s.workspace_id='ws' AND s.version_id='main' \
                       AND s.path='notes/out-of-order.md'",
                    [],
                    |row| row.get(0),
                )?,
            ))
        })
        .expect("drained lineage");
    assert_eq!(parked, 0, "the base arrival drains the parked coordinate");
    assert_eq!(updates, 1, "the dependent update reaches the lineage");
    assert_eq!(head, "before base");
}

#[test]
fn ydoc_prebase_content_kind_refusal_retains_clocks_for_a_dependent_descendant() {
    for (case, base_kind, queued_kind) in [
        ("plaintext-base", "plaintext", "richdoc"),
        ("richdoc-base", "richdoc", "plaintext"),
    ] {
        let (_scratch, _path, mut engine) = store();
        VersionedTextStore::new(&mut engine)
            .ensure_main_version("ws", "main", 1_300, &NoFaults)
            .expect("main version");

        let base_doc = dohc_engine_collab::Ydoc::wire();
        match base_kind {
            "plaintext" => {
                base_doc.plaintext_insert(0, "base");
            }
            "richdoc" => {
                base_doc.richdoc_append_paragraph("base");
            }
            _ => unreachable!(),
        }
        let queued_doc = dohc_engine_collab::Ydoc::wire();
        let queued_bytes = match queued_kind {
            "plaintext" => queued_doc.plaintext_insert(0, "queued"),
            "richdoc" => queued_doc.richdoc_append_paragraph("queued"),
            _ => unreachable!(),
        };
        let descendant_bytes = match queued_kind {
            "plaintext" => queued_doc.plaintext_insert(6, "-descendant"),
            "richdoc" => queued_doc.richdoc_append_paragraph("descendant"),
            _ => unreachable!(),
        };
        let base_sha = engine
            .put_binary_blob(&base_doc.encode_full_state())
            .expect("base blob");
        let queued_sha = engine.put_binary_blob(&queued_bytes).expect("queued blob");
        let descendant_sha = engine
            .put_binary_blob(&descendant_bytes)
            .expect("descendant blob");
        let object_id = format!("object-kind-{case}");
        let path = format!("notes/{case}.md");
        let queued_origin = format!("queued-kind-{case}-peer");
        let queued = envelope(
            &queued_origin,
            0,
            "ydoc.update",
            json!({
                "versionId": "main",
                "objectId": object_id,
                "path": path,
                "contentKind": queued_kind,
                "updateBlobSha256": queued_sha,
                "isBaseState": false
            }),
        );
        assert!(matches!(
            apply_ydoc_envelope(&mut engine, &queued, &NoFaults, &NoLiveLeases),
            Ok(ApplyOutcome::Applied(YdocApplyResult {
                deferred: true,
                reason: Some("ydoc-lineage-absent")
            }))
        ));
        let descendant = envelope(
            &queued_origin,
            1,
            "ydoc.update",
            json!({
                "versionId": "main",
                "objectId": object_id,
                "path": path,
                "contentKind": base_kind,
                "updateBlobSha256": descendant_sha,
                "isBaseState": false
            }),
        );
        assert!(matches!(
            apply_ydoc_envelope(&mut engine, &descendant, &NoFaults, &NoLiveLeases),
            Ok(ApplyOutcome::Applied(YdocApplyResult {
                deferred: true,
                reason: Some("ydoc-lineage-absent")
            }))
        ));

        let base = envelope(
            &format!("base-kind-{case}-peer"),
            0,
            "ydoc.update",
            json!({
                "versionId": "main",
                "objectId": object_id,
                "path": path,
                "contentKind": base_kind,
                "updateBlobSha256": base_sha,
                "isBaseState": true
            }),
        );
        let outcome = apply_ydoc_envelope(&mut engine, &base, &NoFaults, &NoLiveLeases)
            .expect("base applies and mismatched kind is drained");
        let (primary, refusals) = outcome.into_primary_and_refusals();
        assert!(matches!(primary, ApplyOutcome::Applied(_)));
        assert_eq!(
            refusals,
            vec![ReplicationRefusal {
                workspace_id: "ws".to_owned(),
                origin_id: queued_origin.clone(),
                origin_seq: 0,
                op_kind: "ydoc.update".to_owned(),
                reason: RefusalReason::InvalidInput {
                    reason: "ydoc.update content kind does not match the established lineage"
                        .to_owned(),
                },
            }],
            "MUTATION ({case}): omitting the marker-kind comparison silently accepts the hidden-root edit"
        );

        let key = dohc_engine_collab::DocKey::new("ws", "main", &object_id).expect("doc key");
        let persisted = dohc_engine_collab::load_persisted(&engine, &key)
            .expect("load lineage")
            .expect("persisted lineage");
        let projected = persisted
            .doc
            .project(dohc_engine_collab::ContentKind::parse(base_kind))
            .expect("project established kind");
        assert!(projected.markdown.contains("base"));
        assert!(
            !projected.markdown.contains("queued"),
            "the refused alternate-root edit must not project through the established kind"
        );
        assert!(
            !persisted.doc.has_pending_dependencies(),
            "MUTATION ({case}): refusing before applying the mismatched coordinate strands its descendant"
        );
        let (deferred, updates, refusal_rows): (i64, i64, i64) = engine
            .read_with(|conn| {
                Ok::<_, rusqlite::Error>((
                    conn.query_row(
                        "SELECT COUNT(*) FROM ydoc_deferred_updates \
                         WHERE workspace_id='ws' AND version_id='main' AND object_id=?1",
                        [&object_id],
                        |row| row.get(0),
                    )?,
                    conn.query_row(
                        "SELECT COUNT(*) FROM ydoc_updates \
                         WHERE workspace_id='ws' AND version_id='main' AND object_id=?1",
                        [&object_id],
                        |row| row.get(0),
                    )?,
                    conn.query_row(
                        "SELECT COUNT(*) FROM replication_pending_refusals \
                         WHERE workspace_id='ws' AND origin_id=?1 AND origin_seq=0",
                        [&queued_origin],
                        |row| row.get(0),
                    )?,
                ))
            })
            .expect("mismatched-kind disposition");
        assert_eq!(
            (deferred, updates, refusal_rows),
            (0, 2, 1),
            "the refused clock and its dependent descendant must both enter the causal lineage"
        );
    }
}

#[test]
fn relay_pull_reports_applied_and_redelivered_ydoc_materialization_paths() {
    let (_scratch, _path, mut engine) = store();
    seed_identity(&mut engine);
    dohc_engine_domain::VersionedTextStore::new(&mut engine)
        .ensure_main_version("ws", "main", 1_300, &NoFaults)
        .expect("main version");
    engine
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT OR IGNORE INTO file_objects (workspace_id, object_id, created_at_ms) \
                 VALUES ('ws','object-relay-path',1_400)",
                [],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .expect("scaffolding");

    let doc = dohc_engine_collab::Ydoc::wire();
    doc.plaintext_insert(0, "remote projection");
    let bytes = doc.encode_full_state();
    let sha256 = dohc_engine_storage::hex_sha256(&bytes);
    let op = envelope(
        "ydoc-path-peer",
        0,
        "ydoc.update",
        json!({
            "versionId": "main",
            "objectId": "object-relay-path",
            "path": "notes/relay-path.md",
            "contentKind": "plaintext",
            "updateBlobSha256": sha256,
            "isBaseState": true
        }),
    );
    let mut relay = PagedRelay::new([(
        0,
        PullResponse {
            ops: vec![op],
            next_cursor: 1,
            has_more: false,
        },
    )]);
    relay.blobs.insert(sha256, bytes);
    let client = RelaySyncClient::new(relay);

    for (expected_applied, expected_skipped) in [(1, 0), (0, 1)] {
        let outcome = client
            .pull_chat_workspace(&mut engine, "ws", &NoFaults, &NoLiveLeases)
            .expect("pull ydoc projection");
        let SyncPassOutcome::Complete {
            applied,
            skipped,
            changed_paths,
            ..
        } = outcome
        else {
            panic!("ydoc pull must complete: {outcome:?}");
        };
        assert_eq!((applied, skipped), (expected_applied, expected_skipped));
        assert_eq!(
            changed_paths,
            [MomentMaterializationChange {
                path: "notes/relay-path.md".to_owned(),
                operation: "write",
                content_kind: "text",
            }],
            "MUTATION: dropping non-moment durable-intent reconstruction loses the owed path"
        );
    }
}

#[test]
fn ydoc_prebase_update_with_an_existing_other_alias_retries_before_parking() {
    let (_scratch, _path, mut engine) = store();
    seed_replication_version(&mut engine, "main", "main");
    let head_sha = dohc_engine_storage::hex_sha256(b"existing");
    engine
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT INTO blobs (sha256,byte_length,text) VALUES (?1,8,'existing')",
                [&head_sha],
            )
            .map_err(SyncError::persist)?;
            tx.execute(
                "INSERT INTO file_objects (workspace_id,object_id,created_at_ms) \
                 VALUES ('ws','object-prebase-path',1)",
                [],
            )
            .map_err(SyncError::persist)?;
            tx.execute(
                "INSERT INTO snapshots \
                 (workspace_id,version_id,object_id,path,blob_sha256,updated_at_ms,latest_moment_id,metadata_origin,content_kind,binary_sha256) \
                 VALUES ('ws','main','object-prebase-path','notes/a.md',?1,1,'existing-moment','api','text',NULL)",
                [&head_sha],
            )
            .map_err(SyncError::persist)?;
            tx.execute(
                "INSERT INTO path_aliases (workspace_id,version_id,path,object_id) \
                 VALUES ('ws','main','notes/a.md','object-prebase-path')",
                [],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .expect("existing identity");
    let update_sha = engine
        .put_binary_blob(&dohc_engine_collab::Ydoc::wire().plaintext_insert(0, "queued"))
        .expect("update blob");
    let update = envelope(
        "prebase-path-peer",
        0,
        "ydoc.update",
        json!({
            "versionId": "main",
            "objectId": "object-prebase-path",
            "path": "notes/b.md",
            "contentKind": "plaintext",
            "updateBlobSha256": update_sha,
            "isBaseState": false
        }),
    );

    assert!(matches!(
        apply_ydoc_envelope(&mut engine, &update, &NoFaults, &NoLiveLeases),
        Err(SyncError::RetryableState {
            reason: "ydoc.update object already occupies another path"
        })
    ));
    let (deferred, docs, updates): (i64, i64, i64) = engine
        .read_with(|conn| {
            Ok::<_, rusqlite::Error>((
                conn.query_row("SELECT COUNT(*) FROM ydoc_deferred_updates", [], |row| {
                    row.get(0)
                })?,
                conn.query_row("SELECT COUNT(*) FROM ydoc_docs", [], |row| row.get(0))?,
                conn.query_row("SELECT COUNT(*) FROM ydoc_updates", [], |row| row.get(0))?,
            ))
        })
        .expect("pre-base disposition");
    assert_eq!(
        (deferred, docs, updates),
        (0, 0, 0),
        "the transient identity race must not mutate or park"
    );
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "prebase-path-peer").expect("retryable ack"),
        -1,
        "MUTATION: classifying the local identity pin InvalidInput permanently ACKs the update"
    );

    engine
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "DELETE FROM snapshots
                 WHERE workspace_id='ws' AND version_id='main'
                   AND object_id='object-prebase-path'",
                [],
            )
            .map_err(SyncError::persist)?;
            tx.execute(
                "DELETE FROM path_aliases
                 WHERE workspace_id='ws' AND version_id='main'
                   AND object_id='object-prebase-path'",
                [],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .expect("later delete frees the identity");
    assert!(matches!(
        apply_ydoc_envelope(&mut engine, &update, &NoFaults, &NoLiveLeases),
        Ok(ApplyOutcome::Applied(YdocApplyResult {
            deferred: true,
            reason: Some("ydoc-lineage-absent")
        }))
    ));
    let deferred: i64 = engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM ydoc_deferred_updates
                 WHERE workspace_id='ws' AND origin_id='prebase-path-peer'
                   AND origin_seq=0",
                [],
                |row| row.get(0),
            )
        })
        .expect("parked after identity resolves");
    assert_eq!(deferred, 1);
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "prebase-path-peer").expect("park ack"),
        0
    );
}

#[test]
fn ydoc_base_retries_until_a_concurrent_binary_head_is_deleted_then_converges() {
    let (_scratch, _path, mut engine) = store();
    seed_replication_version(&mut engine, "main", "main");
    let binary = b"device X binary";
    let binary_sha = engine.put_binary_blob(binary).expect("binary payload");
    let binary_write = envelope(
        "device-x",
        0,
        "moment.append",
        json!({
            "momentId": "device-x-binary",
            "versionId": "main",
            "objectId": "device-x-object",
            "objectCreatedAtMs": 1,
            "path": "notes/a.md",
            "recordedAtMs": 2_000,
            "operation": "write",
            "payloadBeforeBlobSha256": null,
            "payloadBeforePath": null,
            "payloadAfterBlobSha256": binary_sha,
            "payloadAfterPath": "notes/a.md",
            "payloadAfterContentKind": "binary",
            "payloadAfterByteLength": binary.len(),
            "metadata": {"origin": "sync"},
            "beforePresent": "absent"
        }),
    );
    assert!(matches!(
        apply_replication_envelope(&mut engine, &binary_write, &NoFaults, &NoLiveLeases),
        Ok(ApplyOutcome::Applied(_))
    ));
    let binary_head: (String, String) = engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT object_id,content_kind FROM snapshots
                 WHERE workspace_id='ws' AND version_id='main' AND path='notes/a.md'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
        })
        .expect("device X binary head");
    assert_eq!(
        binary_head,
        ("device-x-object".to_owned(), "binary".to_owned())
    );

    let ydoc = dohc_engine_collab::Ydoc::wire();
    ydoc.plaintext_insert(0, "device Y document");
    let base_sha = engine
        .put_binary_blob(&ydoc.encode_full_state())
        .expect("device Y base");
    let base = envelope(
        "device-y",
        0,
        "ydoc.update",
        json!({
            "versionId": "main",
            "objectId": "device-y-object",
            "path": "notes/a.md",
            "contentKind": "plaintext",
            "updateBlobSha256": base_sha,
            "isBaseState": true
        }),
    );
    assert!(matches!(
        apply_ydoc_envelope(&mut engine, &base, &NoFaults, &NoLiveLeases),
        Err(SyncError::RetryableState {
            reason: "ydoc.update targets a binary head"
        })
    ));
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "device-y").expect("base retry ack"),
        -1,
        "MUTATION: InvalidInput would ACK and permanently lose device Y's base"
    );
    let ydoc_rows: i64 = engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM ydoc_docs
                 WHERE workspace_id='ws' AND object_id='device-y-object'",
                [],
                |row| row.get(0),
            )
        })
        .expect("no premature lineage");
    assert_eq!(ydoc_rows, 0);

    let binary_delete = envelope(
        "device-x",
        1,
        "moment.append",
        json!({
            "momentId": "device-x-delete",
            "versionId": "main",
            "objectId": "device-x-object",
            "objectCreatedAtMs": 1,
            "path": "notes/a.md",
            "recordedAtMs": 2_001,
            "operation": "delete",
            "payloadBeforeBlobSha256": binary_sha,
            "payloadBeforePath": "notes/a.md",
            "payloadBeforeContentKind": "binary",
            "payloadBeforeByteLength": binary.len(),
            "payloadAfterBlobSha256": binary_sha,
            "payloadAfterPath": "notes/a.md",
            "payloadAfterContentKind": "binary",
            "payloadAfterByteLength": binary.len(),
            "metadata": {"origin": "sync"},
            "beforePresent": "present",
            "beforeObjectId": "device-x-object",
            "beforeVersionId": "main",
            "beforePath": "notes/a.md",
            "beforeBlobSha256": binary_sha,
            "beforeContentKind": "binary",
            "beforeByteLength": binary.len(),
            "beforeUpdatedAtMs": 2_000,
            "beforeLatestMomentId": "device-x-binary",
            "beforeMetadata": {"origin": "sync"}
        }),
    );
    assert!(matches!(
        apply_replication_envelope(&mut engine, &binary_delete, &NoFaults, &NoLiveLeases),
        Ok(ApplyOutcome::Applied(_))
    ));

    assert!(matches!(
        apply_ydoc_envelope(&mut engine, &base, &NoFaults, &NoLiveLeases),
        Ok(ApplyOutcome::Applied(YdocApplyResult {
            deferred: false,
            reason: None
        }))
    ));
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "device-y").expect("base ack"),
        0
    );
    let key =
        dohc_engine_collab::DocKey::new("ws", "main", "device-y-object").expect("device Y key");
    let persisted = dohc_engine_collab::load_persisted(&engine, &key)
        .expect("load converged lineage")
        .expect("device Y lineage");
    assert_eq!(
        persisted
            .doc
            .project(dohc_engine_collab::ContentKind::Plaintext)
            .expect("project converged base")
            .markdown,
        "device Y document"
    );
}

#[test]
fn ydoc_prebase_update_for_missing_version_retries_then_parks_after_version_create() {
    let (_scratch, _path, mut engine) = store();
    let update_bytes = dohc_engine_collab::Ydoc::wire().plaintext_insert(0, "orphan");
    let update_sha = engine
        .put_binary_blob(&update_bytes)
        .expect("orphan update blob");
    let update = envelope(
        "missing-version-ydoc-peer",
        0,
        "ydoc.update",
        json!({
            "versionId": "never-created",
            "objectId": "object-never-created",
            "path": "notes/orphan.md",
            "contentKind": "plaintext",
            "updateBlobSha256": update_sha,
            "isBaseState": false
        }),
    );

    assert!(matches!(
        apply_ydoc_envelope(&mut engine, &update, &NoFaults, &NoLiveLeases),
        Err(SyncError::RetryableState {
            reason: "ydoc.update version is missing"
        })
    ));
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "missing-version-ydoc-peer").expect("retry ack"),
        -1
    );
    let (objects, deferred, refusal_rows): (i64, i64, i64) = engine
        .read_with(|conn| {
            Ok::<_, rusqlite::Error>((
                conn.query_row(
                    "SELECT COUNT(*) FROM file_objects \
                     WHERE workspace_id='ws' AND object_id='object-never-created'",
                    [],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*) FROM ydoc_deferred_updates \
                     WHERE workspace_id='ws' AND version_id='never-created'",
                    [],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*) FROM replication_pending_refusals \
                     WHERE workspace_id='ws' AND origin_id='missing-version-ydoc-peer' \
                       AND origin_seq=0 AND reason_message='ydoc.update version is missing'",
                    [],
                    |row| row.get(0),
                )?,
            ))
        })
        .expect("missing-version disposition");
    assert_eq!(
        (objects, deferred, refusal_rows),
        (0, 0, 0),
        "MUTATION: classifying the dependency as invalid input journals and retires the coordinate"
    );
    seed_replication_version(&mut engine, "never-created", "branch");
    assert!(matches!(
        apply_ydoc_envelope(&mut engine, &update, &NoFaults, &NoLiveLeases),
        Ok(ApplyOutcome::Applied(YdocApplyResult {
            deferred: true,
            reason: Some("ydoc-lineage-absent")
        }))
    ));
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "missing-version-ydoc-peer")
            .expect("applied ack"),
        0
    );
}

#[test]
fn ydoc_base_replaces_prebase_placeholder_timestamp_with_base_provenance() {
    let (_scratch, _path, mut engine) = store();
    VersionedTextStore::new(&mut engine)
        .ensure_main_version("ws", "main", 1_300, &NoFaults)
        .expect("main version");

    let doc = dohc_engine_collab::Ydoc::wire();
    doc.plaintext_insert(0, "base");
    let base_sha = engine
        .put_binary_blob(&doc.encode_full_state())
        .expect("base blob");
    let update_sha = engine
        .put_binary_blob(&doc.plaintext_insert(0, "updated "))
        .expect("dependent update blob");
    let mut update = envelope(
        "timestamp-update-peer",
        0,
        "ydoc.update",
        json!({
            "versionId": "main",
            "objectId": "object-base-timestamp",
            "path": "notes/base-timestamp.md",
            "contentKind": "plaintext",
            "updateBlobSha256": update_sha,
            "isBaseState": false
        }),
    );
    update.recorded_at_ms = 2_000;
    assert!(matches!(
        apply_ydoc_envelope(&mut engine, &update, &NoFaults, &NoLiveLeases),
        Ok(ApplyOutcome::Applied(YdocApplyResult {
            deferred: true,
            reason: Some("ydoc-lineage-absent")
        }))
    ));
    let placeholder_timestamp: i64 = engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT created_at_ms FROM file_objects \
                 WHERE workspace_id='ws' AND object_id='object-base-timestamp'",
                [],
                |row| row.get(0),
            )
        })
        .expect("placeholder timestamp");
    assert_eq!(placeholder_timestamp, 2_000);

    let mut base = envelope(
        "timestamp-base-peer",
        0,
        "ydoc.update",
        json!({
            "versionId": "main",
            "objectId": "object-base-timestamp",
            "path": "notes/base-timestamp.md",
            "contentKind": "plaintext",
            "updateBlobSha256": base_sha,
            "isBaseState": true
        }),
    );
    base.recorded_at_ms = 7_000;
    apply_ydoc_envelope(&mut engine, &base, &NoFaults, &NoLiveLeases).expect("base arrives");
    let created_at_ms: i64 = engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT created_at_ms FROM file_objects \
                 WHERE workspace_id='ws' AND object_id='object-base-timestamp'",
                [],
                |row| row.get(0),
            )
        })
        .expect("base timestamp");
    assert_eq!(
        created_at_ms, 7_000,
        "MUTATION: retaining the placeholder time (or only the earliest time) loses base provenance"
    );
}

#[test]
fn ydoc_prebase_drain_refuses_invalid_update_and_continues_in_order() {
    let (_scratch, _path, mut engine) = store();
    VersionedTextStore::new(&mut engine)
        .ensure_main_version("ws", "main", 1_300, &NoFaults)
        .expect("main version");

    // Both updates are individually valid, but they redefine client 12 clock
    // 0 with different content. The second must become a terminal refusal only
    // after the first arrives as the base.
    let (base_bytes, invalid_bytes) = clock_collision_pair();
    let valid_before = dohc_engine_collab::Ydoc::wire().plaintext_insert(0, "valid-before ");
    let valid_after = dohc_engine_collab::Ydoc::wire().plaintext_insert(0, " valid-after");
    let base_sha = engine.put_binary_blob(&base_bytes).expect("base blob");
    let updates = [
        (
            "a-valid-before",
            engine
                .put_binary_blob(&valid_before)
                .expect("first valid blob"),
        ),
        (
            "b-invalid-collision",
            engine
                .put_binary_blob(&invalid_bytes)
                .expect("invalid-against-base blob"),
        ),
        (
            "c-valid-after",
            engine
                .put_binary_blob(&valid_after)
                .expect("second valid blob"),
        ),
    ];
    for (origin, sha) in updates {
        let update = envelope(
            origin,
            0,
            "ydoc.update",
            json!({
                "versionId": "main",
                "objectId": "object-drain-refusal",
                "path": "notes/drain-refusal.md",
                "contentKind": "plaintext",
                "updateBlobSha256": sha,
                "isBaseState": false
            }),
        );
        assert!(matches!(
            apply_ydoc_envelope(&mut engine, &update, &NoFaults, &NoLiveLeases),
            Ok(ApplyOutcome::Applied(YdocApplyResult {
                deferred: true,
                reason: Some("ydoc-lineage-absent")
            }))
        ));
    }

    let base = envelope(
        "base-after-three",
        0,
        "ydoc.update",
        json!({
            "versionId": "main",
            "objectId": "object-drain-refusal",
            "path": "notes/drain-refusal.md",
            "contentKind": "plaintext",
            "updateBlobSha256": base_sha,
            "isBaseState": true
        }),
    );
    let base_outcome = apply_ydoc_envelope(&mut engine, &base, &NoFaults, &NoLiveLeases)
        .expect("base applies and drains");
    let (base_primary, drain_refusals) = base_outcome.into_primary_and_refusals();
    assert!(matches!(base_primary, ApplyOutcome::Applied(_)));
    assert_eq!(
        drain_refusals,
        vec![ReplicationRefusal {
            workspace_id: "ws".to_owned(),
            origin_id: "b-invalid-collision".to_owned(),
            origin_seq: 0,
            op_kind: "ydoc.update".to_owned(),
            reason: RefusalReason::InvalidInput {
                reason: "parked ydoc.update could not be applied".to_owned(),
            },
        }],
        "MUTATION: persisting without returning the drain refusal hides it from the base caller"
    );

    let key =
        dohc_engine_collab::DocKey::new("ws", "main", "object-drain-refusal").expect("doc key");
    let persisted = dohc_engine_collab::load_persisted(&engine, &key)
        .expect("load lineage")
        .expect("persisted lineage");
    let text = persisted.doc.plaintext_string();
    assert!(
        text.contains("valid-before "),
        "the valid update before the refusal must apply: {text:?}"
    );
    assert!(
        text.contains(" valid-after"),
        "the valid update after the refusal must still apply: {text:?}"
    );
    let (queued, applied_updates, refusal_rows, reason): (i64, i64, i64, String) = engine
        .read_with(|conn| {
            Ok::<_, rusqlite::Error>((
                conn.query_row("SELECT COUNT(*) FROM ydoc_deferred_updates", [], |row| {
                    row.get(0)
                })?,
                conn.query_row("SELECT COUNT(*) FROM ydoc_updates", [], |row| row.get(0))?,
                conn.query_row(
                    "SELECT COUNT(*) FROM replication_pending_refusals \
                     WHERE workspace_id='ws' AND origin_id='b-invalid-collision' AND origin_seq=0",
                    [],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT reason_message FROM replication_pending_refusals \
                     WHERE workspace_id='ws' AND origin_id='b-invalid-collision' AND origin_seq=0",
                    [],
                    |row| row.get(0),
                )?,
            ))
        })
        .expect("drain disposition");
    assert_eq!(queued, 0, "all three deferred markers must be consumed");
    assert_eq!(
        applied_updates, 2,
        "only the two valid parked updates may enter the lineage"
    );
    assert_eq!(
        refusal_rows, 1,
        "MUTATION: omitting refusal persistence loses the invalid coordinate"
    );
    assert_eq!(reason, "parked ydoc.update could not be applied");
    assert_eq!(
        drain_deferred_ydoc_for_key(&mut engine, &key, &NoFaults)
            .expect("redrain")
            .drained,
        0,
        "MUTATION: retaining the invalid marker wedges every later drain"
    );
}

#[test]
fn ydoc_prebase_path_mismatch_is_refused_but_retains_causal_bytes() {
    let (_scratch, _path, mut engine) = store();
    seed_replication_version(&mut engine, "main", "main");
    let base_doc = dohc_engine_collab::Ydoc::wire();
    base_doc.plaintext_insert(0, "base");
    let base_sha = engine
        .put_binary_blob(&base_doc.encode_full_state())
        .expect("base blob");
    let update_sha = engine
        .put_binary_blob(&dohc_engine_collab::Ydoc::wire().plaintext_insert(0, "queued"))
        .expect("pre-base blob");
    let update = envelope(
        "prebase-mismatch-peer",
        0,
        "ydoc.update",
        json!({
            "versionId": "main",
            "objectId": "object-prebase-mismatch",
            "path": "notes/b.md",
            "contentKind": "plaintext",
            "updateBlobSha256": update_sha,
            "isBaseState": false
        }),
    );
    assert!(matches!(
        apply_ydoc_envelope(&mut engine, &update, &NoFaults, &NoLiveLeases),
        Ok(ApplyOutcome::Applied(YdocApplyResult {
            deferred: true,
            reason: Some("ydoc-lineage-absent")
        }))
    ));
    let base = envelope(
        "prebase-mismatch-base-peer",
        0,
        "ydoc.update",
        json!({
            "versionId": "main",
            "objectId": "object-prebase-mismatch",
            "path": "notes/a.md",
            "contentKind": "plaintext",
            "updateBlobSha256": base_sha,
            "isBaseState": true
        }),
    );

    let outcome = apply_ydoc_envelope(&mut engine, &base, &NoFaults, &NoLiveLeases)
        .expect("base applies and mismatched path drains");
    let (primary, refusals) = outcome.into_primary_and_refusals();
    assert!(matches!(primary, ApplyOutcome::Applied(_)));
    assert_eq!(
        refusals,
        vec![ReplicationRefusal {
            workspace_id: "ws".to_owned(),
            origin_id: "prebase-mismatch-peer".to_owned(),
            origin_seq: 0,
            op_kind: "ydoc.update".to_owned(),
            reason: RefusalReason::InvalidInput {
                reason: "ydoc.update object already occupies another path".to_owned(),
            },
        }],
        "MUTATION: validating only after apply silently admits path B's bytes"
    );
    let key =
        dohc_engine_collab::DocKey::new("ws", "main", "object-prebase-mismatch").expect("doc key");
    let persisted = dohc_engine_collab::load_persisted(&engine, &key)
        .expect("load")
        .expect("lineage");
    let (deferred, updates, path_b): (i64, i64, i64) = engine
        .read_with(|conn| {
            Ok::<_, rusqlite::Error>((
                conn.query_row("SELECT COUNT(*) FROM ydoc_deferred_updates", [], |row| {
                    row.get(0)
                })?,
                conn.query_row("SELECT COUNT(*) FROM ydoc_updates", [], |row| row.get(0))?,
                conn.query_row(
                    "SELECT COUNT(*) FROM path_aliases \
                     WHERE workspace_id='ws' AND version_id='main' AND path='notes/b.md'",
                    [],
                    |row| row.get(0),
                )?,
            ))
        })
        .expect("drain state");
    let causal_text = persisted.doc.plaintext_string();
    assert!(
        causal_text.contains("base") && causal_text.contains("queued"),
        "the refused coordinate's clocks stay in the lineage without binding path B: {causal_text:?}"
    );
    assert_eq!(
        (deferred, updates, path_b),
        (0, 1, 0),
        "MUTATION: dropping refused CRDT bytes loses clocks needed by dependent descendants"
    );
}

#[test]
fn retried_identity_blocked_ydoc_base_does_not_drain_its_prebase_queue() {
    let (_scratch, _path, mut engine) = store();
    seed_replication_version(&mut engine, "main", "main");

    let source = dohc_engine_collab::Ydoc::wire();
    source.plaintext_insert(0, "base");
    let base_sha = engine
        .put_binary_blob(&source.encode_full_state())
        .expect("base blob");
    let queued_sha = engine
        .put_binary_blob(&source.plaintext_insert(4, " queued"))
        .expect("queued blob");
    let queued = envelope(
        "refused-base-queued-peer",
        0,
        "ydoc.update",
        json!({
            "versionId": "main",
            "objectId": "object-refused-base",
            "path": "notes/refused-base.md",
            "contentKind": "plaintext",
            "updateBlobSha256": queued_sha,
            "isBaseState": false
        }),
    );
    assert!(matches!(
        apply_ydoc_envelope(&mut engine, &queued, &NoFaults, &NoLiveLeases),
        Ok(ApplyOutcome::Applied(YdocApplyResult {
            deferred: true,
            ..
        }))
    ));
    seed_text_head(
        &mut engine,
        "object-refused-base-occupant",
        "notes/refused-base.md",
        "occupied",
    );
    let base = envelope(
        "refused-base-peer",
        0,
        "ydoc.update",
        json!({
            "versionId": "main",
            "objectId": "object-refused-base",
            "path": "notes/refused-base.md",
            "contentKind": "plaintext",
            "updateBlobSha256": base_sha,
            "isBaseState": true
        }),
    );

    assert!(matches!(
        apply_ydoc_envelope(&mut engine, &base, &NoFaults, &NoLiveLeases),
        Err(SyncError::RetryableState {
            reason: "ydoc.update path is occupied by another object"
        })
    ));
    assert!(matches!(
        apply_ydoc_envelope(&mut engine, &base, &NoFaults, &NoLiveLeases),
        Err(SyncError::RetryableState {
            reason: "ydoc.update path is occupied by another object"
        })
    ));
    let key = dohc_engine_collab::DocKey::new("ws", "main", "object-refused-base").expect("key");
    let (queued_rows, update_rows): (i64, i64) = engine
        .read_with(|conn| {
            Ok::<_, rusqlite::Error>((
                conn.query_row(
                    "SELECT COUNT(*) FROM ydoc_deferred_updates \
                     WHERE workspace_id='ws' AND version_id='main' \
                       AND object_id='object-refused-base'",
                    [],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*) FROM ydoc_updates \
                     WHERE workspace_id='ws' AND version_id='main' \
                       AND object_id='object-refused-base'",
                    [],
                    |row| row.get(0),
                )?,
            ))
        })
        .expect("refused base state");
    assert!(
        dohc_engine_collab::read_marker(&engine, &key)
            .expect("marker read")
            .is_none()
    );
    assert_eq!(
        (queued_rows, update_rows),
        (1, 0),
        "MUTATION: ACKing the identity-blocked base lets replay drain against a lineage that never materialized"
    );
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "refused-base-peer").expect("retryable ack"),
        -1
    );
}

#[test]
fn refused_ydoc_projection_retains_clocks_for_a_dependent_descendant() {
    let (_scratch, _path, mut engine) = store();
    seed_replication_version(&mut engine, "main", "main");

    let source = dohc_engine_collab::Ydoc::wire();
    source.plaintext_insert(0, "base");
    let base_sha = engine
        .put_binary_blob(&source.encode_full_state())
        .expect("base blob");
    let refused_sha = engine
        .put_binary_blob(&source.plaintext_insert(4, " refused-clock"))
        .expect("refused update blob");
    let descendant_sha = engine
        .put_binary_blob(&source.plaintext_insert(18, " descendant"))
        .expect("descendant update blob");
    let base = envelope(
        "clock-base-peer",
        0,
        "ydoc.update",
        json!({
            "versionId": "main",
            "objectId": "object-causal-refusal",
            "path": "notes/causal-refusal.md",
            "contentKind": "plaintext",
            "updateBlobSha256": base_sha,
            "isBaseState": true
        }),
    );
    assert!(matches!(
        apply_ydoc_envelope(&mut engine, &base, &NoFaults, &NoLiveLeases),
        Ok(ApplyOutcome::Applied(_))
    ));
    seed_text_head(
        &mut engine,
        "object-causal-occupant",
        "notes/occupied-causal.md",
        "occupied",
    );
    let refused = envelope(
        "clock-update-peer",
        0,
        "ydoc.update",
        json!({
            "versionId": "main",
            "objectId": "object-causal-refusal",
            "path": "notes/occupied-causal.md",
            "contentKind": "plaintext",
            "updateBlobSha256": refused_sha,
            "isBaseState": false
        }),
    );
    assert!(matches!(
        apply_ydoc_envelope(&mut engine, &refused, &NoFaults, &NoLiveLeases),
        Ok(ApplyOutcome::Refused(ReplicationRefusal {
            reason: RefusalReason::InvalidInput { .. },
            ..
        }))
    ));
    let descendant = envelope(
        "clock-update-peer",
        1,
        "ydoc.update",
        json!({
            "versionId": "main",
            "objectId": "object-causal-refusal",
            "path": "notes/causal-refusal.md",
            "contentKind": "plaintext",
            "updateBlobSha256": descendant_sha,
            "isBaseState": false
        }),
    );
    assert!(matches!(
        apply_ydoc_envelope(&mut engine, &descendant, &NoFaults, &NoLiveLeases),
        Ok(ApplyOutcome::Applied(_))
    ));

    let key = dohc_engine_collab::DocKey::new("ws", "main", "object-causal-refusal").expect("key");
    let persisted = dohc_engine_collab::load_persisted(&engine, &key)
        .expect("load")
        .expect("lineage");
    let causal_text = persisted.doc.plaintext_string();
    assert!(
        !persisted.doc.has_pending_dependencies(),
        "MUTATION: rolling back the refused update strands its descendant behind a missing clock"
    );
    assert!(
        causal_text.contains("refused-clock") && causal_text.contains("descendant"),
        "the causal bytes converge in the Y.Doc without projecting through the occupied path: {causal_text:?}"
    );
    let visible: String = engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT b.text FROM path_aliases a \
                 JOIN snapshots s ON s.workspace_id=a.workspace_id \
                   AND s.version_id=a.version_id AND s.object_id=a.object_id \
                 JOIN blobs b ON b.sha256=s.blob_sha256 \
                 WHERE a.workspace_id='ws' AND a.version_id='main' \
                   AND a.path='notes/causal-refusal.md'",
                [],
                |row| row.get(0),
            )
        })
        .expect("visible causal head");
    assert_eq!(visible, causal_text);
}

#[test]
fn divergent_second_ydoc_base_is_hard_unacked_and_unjournaled() {
    let (_scratch, _path, mut engine) = store();
    seed_replication_version(&mut engine, "main", "main");
    let first_doc = dohc_engine_collab::Ydoc::wire();
    first_doc.plaintext_insert(0, "first");
    let first_sha = engine
        .put_binary_blob(&first_doc.encode_full_state())
        .expect("first base");
    let second_doc = dohc_engine_collab::Ydoc::wire();
    second_doc.plaintext_insert(0, "second");
    let second_sha = engine
        .put_binary_blob(&second_doc.encode_full_state())
        .expect("second base");
    let base = |origin: &str, sha: &str| {
        envelope(
            origin,
            0,
            "ydoc.update",
            json!({
                "versionId": "main",
                "objectId": "object-divergent-base",
                "path": "notes/divergent-base.md",
                "contentKind": "plaintext",
                "updateBlobSha256": sha,
                "isBaseState": true
            }),
        )
    };
    assert!(matches!(
        apply_ydoc_envelope(
            &mut engine,
            &base("first-base-peer", &first_sha),
            &NoFaults,
            &NoLiveLeases
        ),
        Ok(ApplyOutcome::Applied(_))
    ));

    let second = apply_ydoc_envelope(
        &mut engine,
        &base("second-base-peer", &second_sha),
        &NoFaults,
        &NoLiveLeases,
    );
    assert!(matches!(second, Err(SyncError::CoordinateDiverged)));
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "second-base-peer").expect("second-base ack"),
        -1,
        "a divergent lineage must not advance the peer coordinate"
    );
    let journaled: i64 = engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM replication_log \
                 WHERE workspace_id='ws' AND origin_id='second-base-peer'",
                [],
                |row| row.get(0),
            )
        })
        .expect("divergent journal count");
    assert_eq!(
        journaled, 0,
        "MUTATION: mapping BaseStateDiverged to InvalidInput journals and ACKs the unusable lineage"
    );
    let key =
        dohc_engine_collab::DocKey::new("ws", "main", "object-divergent-base").expect("doc key");
    let persisted = dohc_engine_collab::load_persisted(&engine, &key)
        .expect("load")
        .expect("lineage");
    assert_eq!(
        persisted.doc.plaintext_string(),
        "first",
        "the refusal savepoint must preserve the originally claimed base"
    );
}

#[test]
fn live_lease_on_local_only_lineage_is_retryable_unacked_and_unjournaled() {
    let (_scratch, _path, mut engine) = store();
    VersionedTextStore::new(&mut engine)
        .ensure_main_version("ws", "main", 1_300, &NoFaults)
        .expect("main version");
    engine
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT INTO file_objects (workspace_id, object_id, created_at_ms) \
                 VALUES ('ws', 'object-local-lease', 1_400)",
                [],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .expect("file object");
    let key = dohc_engine_collab::DocKey::new("ws", "main", "object-local-lease").expect("doc key");
    dohc_engine_collab::ensure_marker(
        &mut engine,
        &key,
        dohc_engine_collab::ContentKind::Plaintext,
        dohc_engine_collab::Regime::LocalOnly,
        &NoFaults,
        1_500,
    )
    .expect("local marker");
    let sha = engine
        .put_binary_blob(&dohc_engine_collab::Ydoc::wire().plaintext_insert(0, "remote"))
        .expect("update blob");
    let update = envelope(
        "local-lease-peer",
        0,
        "ydoc.update",
        json!({
            "versionId": "main",
            "objectId": "object-local-lease",
            "path": "notes/local-lease.md",
            "contentKind": "plaintext",
            "updateBlobSha256": sha,
            "isBaseState": false
        }),
    );

    assert!(matches!(
        apply_ydoc_envelope(&mut engine, &update, &NoFaults, &AlwaysLive),
        Err(SyncError::RetryableState {
            reason: "live lease on a non-replicated Y.Doc lineage"
        })
    ));
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "local-lease-peer").expect("ack"),
        -1
    );
    let journaled: i64 = engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM replication_log \
                 WHERE workspace_id='ws' AND origin_id='local-lease-peer'",
                [],
                |row| row.get(0),
            )
        })
        .expect("lease-race journal count");
    assert_eq!(
        journaled, 0,
        "MUTATION: treating the lease race as a terminal refusal journals the coordinate"
    );
}

#[test]
fn a_pulled_base_over_leftover_local_rows_projects_the_merged_lineage() {
    // A crash can leave LOCAL-ONLY update rows before the base envelope
    // arrives; the claim promotes that lineage, and the projection must be
    // the RECONSTRUCTED doc plus the base — not the base alone, which would
    // drop durable local content from the visible head. Mutation check:
    // rebuild base_doc from `Ydoc::wire()` instead of `load_persisted` in
    // `apply_ydoc_envelope`'s base arm — the local-content assertion fails.
    let (_scratch, _path, mut engine) = store();
    dohc_engine_domain::VersionedTextStore::new(&mut engine)
        .ensure_main_version("ws", "main", 1_300, &NoFaults)
        .expect("main version");
    engine
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT OR IGNORE INTO file_objects (workspace_id, object_id, created_at_ms)                  VALUES ('ws','object-promote',1_400)",
                [],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .expect("scaffolding");
    let key = dohc_engine_collab::DocKey::new("ws", "main", "object-promote").expect("key");
    dohc_engine_collab::ensure_marker(
        &mut engine,
        &key,
        dohc_engine_collab::ContentKind::Plaintext,
        dohc_engine_collab::Regime::LocalOnly,
        &NoFaults,
        1_450,
    )
    .expect("local-only marker");
    let local_update = dohc_engine_collab::Ydoc::wire().plaintext_insert(0, "local-part ");
    dohc_engine_collab::record_local_update(&mut engine, &key, &local_update, &NoFaults, 1_460)
        .expect("local row");

    let base_doc = dohc_engine_collab::Ydoc::wire();
    base_doc.plaintext_insert(0, "base-part");
    let base_bytes = base_doc.encode_full_state();
    let base_sha = engine.put_binary_blob(&base_bytes).expect("base blob");
    let base_op = envelope(
        "peer",
        0,
        "ydoc.update",
        json!({
            "versionId": "main",
            "objectId": "object-promote",
            "path": "notes/promoted.md",
            "contentKind": "plaintext",
            "updateBlobSha256": base_sha,
            "isBaseState": true
        }),
    );
    apply_ydoc_envelope(&mut engine, &base_op, &NoFaults, &NoLiveLeases).expect("base applies");

    let head_text: String = engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT b.text FROM path_aliases a \
                 JOIN snapshots s ON s.workspace_id = a.workspace_id AND s.object_id = a.object_id \
                 JOIN blobs b ON b.sha256 = s.blob_sha256 \
                 WHERE a.workspace_id = 'ws' AND a.version_id = 'main' \
                   AND a.path = 'notes/promoted.md'",
                [],
                |r| r.get(0),
            )
            .map_err(SyncError::corrupt)
        })
        .expect("promoted head");
    assert!(
        head_text.contains("base-part"),
        "head must contain the base: {head_text}"
    );
    assert!(
        head_text.contains("local-part"),
        "head must keep the leftover local rows: {head_text}"
    );
}

fn seed_replication_version(engine: &mut EngineStore, version_id: &str, kind: &str) {
    seed_replication_version_in_workspace(engine, "ws", version_id, kind);
}

fn seed_replication_version_in_workspace(
    engine: &mut EngineStore,
    workspace_id: &str,
    version_id: &str,
    kind: &str,
) {
    engine
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT OR IGNORE INTO versioned_workspaces (workspace_id, main_version_id) \
                 VALUES (?1, 'main')",
                [workspace_id],
            )
            .map_err(SyncError::persist)?;
            tx.execute(
                "INSERT OR IGNORE INTO versions \
                 (workspace_id, version_id, kind, name, created_at_ms) \
                 VALUES (?1, ?2, ?3, ?2, 1)",
                params![workspace_id, version_id, kind],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .expect("seed replication version");
}

#[test]
fn secret_and_version_missing_dependencies_retry_and_apply_after_version_arrival() {
    use base64::Engine as _;
    use base64::engine::general_purpose::STANDARD;

    let (_secret_scratch, _secret_path, mut secret_engine) = store();
    let ciphertext = b"late secret";
    let sha = secret_engine
        .put_binary_blob(ciphertext)
        .expect("secret blob");
    let secret = envelope(
        "late-secret-peer",
        0,
        "secret.file.put",
        json!({
            "versionId": "late-secret-version",
            "path": "app/.env",
            "metadata": {"origin": "sync"},
            "ivBase64": STANDARD.encode([1_u8; SECRET_IV_BYTES]),
            "authTagBase64": STANDARD.encode([2_u8; SECRET_TAG_BYTES]),
            "ciphertextSha256": sha,
            "byteLength": ciphertext.len()
        }),
    );
    assert!(matches!(
        apply_secret_envelope(&mut secret_engine, &secret, &NoFaults),
        Err(SyncError::RetryableState {
            reason: "secret target version is missing"
        })
    ));
    assert_unacked_and_unjournaled(&secret_engine, "late-secret-peer");
    seed_replication_version(&mut secret_engine, "late-secret-version", "named");
    assert!(matches!(
        apply_secret_envelope(&mut secret_engine, &secret, &NoFaults),
        Ok(ApplyOutcome::Applied(()))
    ));

    let (_version_scratch, _version_path, mut version_engine) = store();
    seed_replication_version(&mut version_engine, "main", "main");
    let child = envelope(
        "late-version-child-peer",
        0,
        "version.create",
        json!({
            "versionId": "late-child",
            "name": "Late child",
            "kind": "named",
            "forkVersionId": "late-source",
            "forkMomentId": "late-source-tip",
            "createdAtMs": 30
        }),
    );
    assert!(matches!(
        apply_replication_envelope(&mut version_engine, &child, &NoFaults, &NoLiveLeases),
        Err(SyncError::RetryableState {
            reason: "version.create source version is missing"
        })
    ));
    assert_unacked_and_unjournaled(&version_engine, "late-version-child-peer");
    let source = envelope(
        "late-version-source-peer",
        0,
        "version.create",
        json!({
            "versionId": "late-source",
            "name": "Late source",
            "kind": "named",
            "createdAtMs": 20
        }),
    );
    assert!(matches!(
        apply_replication_envelope(&mut version_engine, &source, &NoFaults, &NoLiveLeases),
        Ok(ApplyOutcome::Applied(_))
    ));
    assert!(matches!(
        apply_replication_envelope(&mut version_engine, &child, &NoFaults, &NoLiveLeases),
        Ok(ApplyOutcome::Applied(_))
    ));
    let created: bool = version_engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM versions \
                 WHERE workspace_id='ws' AND version_id='late-child')",
                [],
                |row| row.get(0),
            )
        })
        .expect("late child version");
    assert!(
        created,
        "MUTATION: terminal missing-version classification prevents later dependency arrival from reviving the operation"
    );
}

fn assert_unacked_and_unjournaled(engine: &EngineStore, origin_id: &str) {
    assert_eq!(
        read_replication_acked_seq(engine, "ws", origin_id).expect("retry ack"),
        -1
    );
    let journaled: i64 = engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM replication_log \
                 WHERE workspace_id='ws' AND origin_id=?1",
                [origin_id],
                |row| row.get(0),
            )
        })
        .expect("retry journal");
    assert_eq!(
        journaled, 0,
        "MUTATION: a retryable dependency must not be journaled before it applies"
    );
}

#[test]
fn workspace_init_router_apply_is_idempotent_on_replay() {
    let (_scratch, _path, mut engine) = store();
    let seed = envelope("workspace-seed-peer", 0, "workspace.init", json!({}));
    assert!(matches!(
        apply_replication_envelope(&mut engine, &seed, &NoFaults, &NoLiveLeases),
        Ok(ApplyOutcome::Applied(RoutedApply { conflict: None, .. }))
    ));

    let operation = envelope("workspace-replay-peer", 0, "workspace.init", json!({}));
    assert!(matches!(
        apply_replication_envelope(&mut engine, &operation, &NoFaults, &NoLiveLeases),
        Ok(ApplyOutcome::Applied(RoutedApply { conflict: None, .. }))
    ));
    let main: (String, String, String, i64) = engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT w.main_version_id, v.kind, v.name, v.created_at_ms \
                 FROM versioned_workspaces w JOIN versions v \
                   ON v.workspace_id=w.workspace_id AND v.version_id=w.main_version_id \
                 WHERE w.workspace_id='ws'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .map_err(SyncError::corrupt)
        })
        .expect("main version");
    assert_eq!(main, ("main".into(), "main".into(), "Main".into(), 2_000));
    assert!(matches!(
        apply_replication_envelope(&mut engine, &operation, &NoFaults, &NoLiveLeases),
        Ok(ApplyOutcome::Skipped)
    ));
}

#[test]
fn workspace_init_repairs_a_workspace_row_missing_its_main_version() {
    let (_scratch, _path, mut engine) = store();
    engine
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT INTO versioned_workspaces (workspace_id,main_version_id) \
                 VALUES ('ws','main')",
                [],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .expect("seed partial workspace");

    let operation = envelope("partial-workspace-peer", 0, "workspace.init", json!({}));
    assert!(matches!(
        apply_replication_envelope(&mut engine, &operation, &NoFaults, &NoLiveLeases),
        Ok(ApplyOutcome::Applied(RoutedApply { conflict: None, .. }))
    ));
    let main: (String, String, String, i64) = engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT version_id,kind,name,created_at_ms FROM versions \
                 WHERE workspace_id='ws' AND version_id='main'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .map_err(SyncError::corrupt)
        })
        .expect("repaired main version");
    assert_eq!(main, ("main".into(), "main".into(), "Main".into(), 2_000));
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "partial-workspace-peer").expect("ack"),
        0
    );
}

#[test]
fn version_create_router_materializes_shipped_fork_snapshots_and_replays_idempotently() {
    let (_scratch, _path, mut engine) = store();
    seed_replication_version(&mut engine, "main", "main");

    let local_sha = dohc_engine_storage::hex_sha256(b"local source state");
    let shipped_text_sha = dohc_engine_storage::hex_sha256(b"origin fork state");
    let shipped_binary = b"\0origin-binary-fork-state";
    let shipped_binary_sha = engine
        .put_binary_blob(shipped_binary)
        .expect("shipped binary blob");
    engine
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT INTO blobs (sha256,byte_length,text) VALUES (?1,?2,?3)",
                params![local_sha, 18_i64, "local source state"],
            )
            .map_err(SyncError::persist)?;
            tx.execute(
                "INSERT INTO blobs (sha256,byte_length,text) VALUES (?1,?2,?3)",
                params![shipped_text_sha, 17_i64, "origin fork state"],
            )
            .map_err(SyncError::persist)?;
            tx.execute(
                "INSERT INTO file_objects (workspace_id,object_id,created_at_ms) \
                 VALUES ('ws','local-object',1)",
                [],
            )
            .map_err(SyncError::persist)?;
            tx.execute(
                "INSERT INTO snapshots \
                 (workspace_id,version_id,object_id,path,blob_sha256,updated_at_ms,latest_moment_id,metadata_origin,content_kind,binary_sha256) \
                 VALUES ('ws','main','local-object','local.md',?1,1,'local-moment','api','text',NULL)",
                [&local_sha],
            )
            .map_err(SyncError::persist)?;
            tx.execute(
                "INSERT INTO path_aliases (workspace_id,version_id,path,object_id) \
                 VALUES ('ws','main','local.md','local-object')",
                [],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .expect("seed fork state");

    let operation = envelope(
        "version-peer",
        0,
        "version.create",
        json!({
            "versionId": "feature",
            "name": "Feature",
            "kind": "named",
            "forkVersionId": "main",
            "forkMomentId": "origin-fork-moment",
            "createdAtMs": 1_500,
            "forkSnapshots": [
                {
                    "objectId": "origin-text-object",
                    "objectCreatedAtMs": 1_100,
                    "path": "origin.md",
                    "blobSha256": shipped_text_sha,
                    "byteLength": 17,
                    "updatedAtMs": 1_200,
                    "latestMomentId": "origin-text-moment",
                    "metadata": {"origin": "sync", "summary": "origin"}
                },
                {
                    "objectId": "origin-binary-object",
                    "objectCreatedAtMs": 1_101,
                    "path": "asset.bin",
                    "contentKind": "binary",
                    "blobSha256": shipped_binary_sha,
                    "byteLength": shipped_binary.len(),
                    "updatedAtMs": 1_201,
                    "latestMomentId": "origin-binary-moment",
                    "metadata": {"origin": "sync", "correlationId": "fork"}
                }
            ]
        }),
    );

    assert!(matches!(
        apply_replication_envelope(&mut engine, &operation, &NoFaults, &NoLiveLeases),
        Ok(ApplyOutcome::Applied(RoutedApply { conflict: None, .. }))
    ));
    type CopiedSnapshot = (
        String,
        String,
        String,
        Option<String>,
        Option<String>,
        String,
        Option<String>,
        Option<String>,
    );
    let copied: Vec<CopiedSnapshot> = engine
        .read_with(|conn| {
            let mut stmt = conn.prepare(
                "SELECT s.path,s.object_id,s.content_kind,s.blob_sha256,s.binary_sha256, \
                        s.metadata_origin,s.metadata_summary,s.metadata_correlation_id \
                 FROM snapshots s WHERE s.workspace_id='ws' AND s.version_id='feature' \
                 ORDER BY s.path",
            )?;
            stmt.query_map([], |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                    row.get(7)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()
        })
        .expect("copied snapshots");
    assert_eq!(
        copied,
        vec![
            (
                "asset.bin".into(),
                "origin-binary-object".into(),
                "binary".into(),
                None,
                Some(shipped_binary_sha),
                "sync".into(),
                None,
                Some("fork".into()),
            ),
            (
                "origin.md".into(),
                "origin-text-object".into(),
                "text".into(),
                Some(shipped_text_sha),
                None,
                "sync".into(),
                Some("origin".into()),
                None,
            )
        ]
    );
    let fork_base_metadata: Vec<(String, String, Option<String>, Option<String>)> = engine
        .read_with(|conn| {
            conn.prepare(
                "SELECT path,metadata_origin,metadata_summary,metadata_correlation_id \
                 FROM fork_base_snapshots \
                 WHERE workspace_id='ws' AND version_id='feature' ORDER BY path",
            )?
            .query_map([], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
            })?
            .collect()
        })
        .expect("shipped fork-base metadata");
    // MUTATION: the dynamic shipped-snapshot insert runs for both destination
    // tables; dropping either optional metadata binding changes these rows.
    assert_eq!(
        fork_base_metadata,
        vec![
            ("asset.bin".into(), "sync".into(), None, Some("fork".into())),
            (
                "origin.md".into(),
                "sync".into(),
                Some("origin".into()),
                None
            ),
        ]
    );
    let counts: (i64, i64, i64) = engine
        .read_with(|conn| {
            Ok::<_, rusqlite::Error>((
                conn.query_row(
                    "SELECT COUNT(*) FROM snapshots WHERE workspace_id='ws' AND version_id='feature'",
                    [],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*) FROM path_aliases WHERE workspace_id='ws' AND version_id='feature'",
                    [],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*) FROM fork_base_snapshots WHERE workspace_id='ws' AND version_id='feature'",
                    [],
                    |row| row.get(0),
                )?,
            ))
        })
        .expect("fork row counts");
    assert_eq!(counts, (2, 2, 2));
    let mut applier_replay = operation.clone();
    applier_replay.origin_id = "version-applier-replay-peer".into();
    assert!(matches!(
        apply_replication_envelope(&mut engine, &applier_replay, &NoFaults, &NoLiveLeases),
        Ok(ApplyOutcome::Applied(RoutedApply { conflict: None, .. }))
    ));
    let replay_counts: (i64, i64, i64) = engine
        .read_with(|conn| {
            Ok::<_, rusqlite::Error>((
                conn.query_row(
                    "SELECT COUNT(*) FROM snapshots \
                     WHERE workspace_id='ws' AND version_id='feature'",
                    [],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*) FROM path_aliases \
                     WHERE workspace_id='ws' AND version_id='feature'",
                    [],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*) FROM fork_base_snapshots \
                     WHERE workspace_id='ws' AND version_id='feature'",
                    [],
                    |row| row.get(0),
                )?,
            ))
        })
        .expect("replayed fork row counts");
    assert_eq!(replay_counts, (2, 2, 2));
    assert!(matches!(
        apply_replication_envelope(&mut engine, &applier_replay, &NoFaults, &NoLiveLeases),
        Ok(ApplyOutcome::Skipped)
    ));
}

fn shipped_text_snapshot(object_id: &str, path: &str, blob_sha256: &str) -> serde_json::Value {
    json!({
        "objectId": object_id,
        "objectCreatedAtMs": 1_100,
        "path": path,
        "blobSha256": blob_sha256,
        "byteLength": 7,
        "updatedAtMs": 1_200,
        "latestMomentId": format!("{object_id}-moment"),
        "metadata": {"origin": "sync"}
    })
}

fn version_create_with_shipped_snapshots(
    origin: &str,
    version_id: &str,
    snapshots: Vec<serde_json::Value>,
) -> ReplicationEnvelope {
    envelope(
        origin,
        0,
        "version.create",
        json!({
            "versionId": version_id,
            "name": version_id,
            "kind": "named",
            "forkVersionId": "main",
            "forkMomentId": "fork-moment",
            "createdAtMs": 1_500,
            "forkSnapshots": snapshots
        }),
    )
}

#[test]
fn version_create_shipped_snapshot_rejects_a_missing_blob_deliberately() {
    let (_scratch, _path, mut engine) = store();
    seed_replication_version(&mut engine, "main", "main");
    let missing_sha = dohc_engine_storage::hex_sha256(b"missing");
    let operation = version_create_with_shipped_snapshots(
        "missing-blob-peer",
        "missing-blob-version",
        vec![shipped_text_snapshot(
            "missing-object",
            "missing.md",
            &missing_sha,
        )],
    );

    assert!(matches!(
        apply_replication_envelope(&mut engine, &operation, &NoFaults, &NoLiveLeases),
        Err(SyncError::BlobInvalid)
    ));
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "missing-blob-peer").expect("ack"),
        -1
    );
    let version_exists: bool = engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM versions \
                 WHERE workspace_id='ws' AND version_id='missing-blob-version')",
                [],
                |row| row.get(0),
            )
        })
        .expect("version absence");
    assert!(!version_exists);
}

#[test]
fn version_create_shipped_snapshot_accepts_only_oracle_content_kinds() {
    for (index, content_kind) in [None, Some("text"), Some("binary")].into_iter().enumerate() {
        let (_scratch, _path, mut engine) = store();
        seed_replication_version(&mut engine, "main", "main");
        let text_sha = dohc_engine_storage::hex_sha256(b"content");
        engine
            .write_with(&NoFaults, |tx| {
                tx.execute(
                    "INSERT INTO blobs (sha256,byte_length,text) VALUES (?1,7,'content')",
                    [&text_sha],
                )
                .map_err(SyncError::persist)?;
                Ok::<_, SyncError>(())
            })
            .expect("seed text blob");
        let binary_sha = engine
            .put_binary_blob(b"content")
            .expect("seed binary blob");
        let mut snapshot = shipped_text_snapshot(
            &format!("valid-kind-object-{index}"),
            &format!("valid-kind-{index}.md"),
            if content_kind == Some("binary") {
                &binary_sha
            } else {
                &text_sha
            },
        );
        if let Some(kind) = content_kind {
            snapshot["contentKind"] = json!(kind);
        }
        let operation = version_create_with_shipped_snapshots(
            &format!("valid-kind-peer-{index}"),
            &format!("valid-kind-version-{index}"),
            vec![snapshot],
        );

        assert!(
            matches!(
                apply_replication_envelope(&mut engine, &operation, &NoFaults, &NoLiveLeases),
                Ok(ApplyOutcome::Applied(RoutedApply { conflict: None, .. }))
            ),
            "{content_kind:?} must remain accepted"
        );
    }
}

#[test]
fn version_create_unknown_content_kind_is_refused_and_acked() {
    let (_scratch, _path, mut engine) = store();
    seed_replication_version(&mut engine, "main", "main");
    let text_sha = dohc_engine_storage::hex_sha256(b"content");
    engine
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT INTO blobs (sha256,byte_length,text) VALUES (?1,7,'content')",
                [&text_sha],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .expect("seed text blob");
    let mut snapshot = shipped_text_snapshot("richdoc-object", "richdoc.md", &text_sha);
    snapshot["contentKind"] = json!("richdoc");
    let operation = version_create_with_shipped_snapshots(
        "richdoc-refusal-peer",
        "richdoc-refusal-version",
        vec![snapshot],
    );

    assert!(matches!(
        apply_replication_envelope(&mut engine, &operation, &NoFaults, &NoLiveLeases),
        Ok(ApplyOutcome::Refused(ReplicationRefusal {
            reason: RefusalReason::InvalidInput {
                ref reason
            },
            ..
        })) if reason == "version.create shipped snapshot content kind is invalid"
    ));
    let (journaled, versions, snapshots): (i64, i64, i64) = engine
        .read_with(|conn| {
            Ok::<_, rusqlite::Error>((
                conn.query_row(
                    "SELECT COUNT(*) FROM replication_log \
                     WHERE workspace_id='ws' AND origin_id='richdoc-refusal-peer' AND origin_seq=0",
                    [],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*) FROM versions \
                     WHERE workspace_id='ws' AND version_id='richdoc-refusal-version'",
                    [],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*) FROM snapshots \
                     WHERE workspace_id='ws' AND version_id='richdoc-refusal-version'",
                    [],
                    |row| row.get(0),
                )?,
            ))
        })
        .expect("refusal persistence");
    assert_eq!(journaled, 1, "the refused coordinate must be journaled");
    assert_eq!(
        versions, 0,
        "the pre-validation version insert must roll back"
    );
    assert_eq!(snapshots, 0, "the refused snapshot must roll back");
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "richdoc-refusal-peer").expect("ack"),
        0
    );

    let next = envelope(
        "richdoc-refusal-peer",
        1,
        "chat.channel.create",
        json!({
            "channelId": "after-richdoc-refusal",
            "name": "Still moving",
            "slug": "still-moving",
            "kind": "channel",
            "createdAtMs": 2_001
        }),
    );
    assert!(matches!(
        apply_replication_envelope(&mut engine, &next, &NoFaults, &NoLiveLeases),
        Ok(ApplyOutcome::Applied(_))
    ));
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "richdoc-refusal-peer").expect("ack"),
        1,
        "the refused operation must not wedge its origin"
    );
}

#[test]
fn version_create_shipped_snapshot_rejects_duplicate_paths_deliberately() {
    let (_scratch, _path, mut engine) = store();
    seed_replication_version(&mut engine, "main", "main");
    let sha = dohc_engine_storage::hex_sha256(b"content");
    engine
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT INTO blobs (sha256,byte_length,text) VALUES (?1,7,'content')",
                [&sha],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .expect("seed blob");
    let operation = version_create_with_shipped_snapshots(
        "duplicate-path-peer",
        "duplicate-path-version",
        vec![
            shipped_text_snapshot("first-object", "same.md", &sha),
            shipped_text_snapshot("second-object", "same.md", &sha),
        ],
    );

    assert!(matches!(
        apply_replication_envelope(&mut engine, &operation, &NoFaults, &NoLiveLeases),
        Ok(ApplyOutcome::Refused(ReplicationRefusal {
            reason: RefusalReason::InvalidInput {
                ref reason
            },
            ..
        })) if reason == "version.create shipped snapshot paths must be unique"
    ));
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "duplicate-path-peer").expect("ack"),
        0
    );
}

#[test]
fn version_create_shipped_snapshot_rejects_unsafe_and_secret_paths() {
    for (index, path) in ["../escape.md", "config/.env"].into_iter().enumerate() {
        let (_scratch, _path, mut engine) = store();
        seed_replication_version(&mut engine, "main", "main");
        let sha = dohc_engine_storage::hex_sha256(b"content");
        engine
            .write_with(&NoFaults, |tx| {
                tx.execute(
                    "INSERT INTO blobs (sha256,byte_length,text) VALUES (?1,7,'content')",
                    [&sha],
                )
                .map_err(SyncError::persist)?;
                Ok::<_, SyncError>(())
            })
            .expect("seed blob");
        let origin = format!("unsafe-path-peer-{index}");
        let version_id = format!("unsafe-path-version-{index}");
        let operation = version_create_with_shipped_snapshots(
            &origin,
            &version_id,
            vec![shipped_text_snapshot("unsafe-object", path, &sha)],
        );

        assert!(matches!(
            apply_replication_envelope(&mut engine, &operation, &NoFaults, &NoLiveLeases),
            Ok(ApplyOutcome::Refused(ReplicationRefusal {
                reason: RefusalReason::InvalidInput {
                    ref reason
                },
                ..
            })) if reason == "version.create shipped snapshot path must be tracked"
        ));
        assert_eq!(
            read_replication_acked_seq(&engine, "ws", &origin).expect("ack"),
            0,
            "{path}"
        );
    }
}

/// A `version.create` shipping a TEXT fork snapshot at a secret-classified path
/// is a DISCLOSURE op: `blobs`/`snapshots`/`path_aliases` are the ordinary
/// plaintext surface, and `read_text` deliberately admits secret paths so an
/// absence check answers honestly — so a persisted `.env` alias hands the
/// plaintext straight back through the normal read surface. Asserting the error
/// is not enough; this asserts the plaintext is NOT READABLE afterwards.
#[test]
fn version_create_secret_fork_snapshot_never_becomes_readable_plaintext() {
    let (_scratch, _path, mut engine) = store();
    seed_replication_version(&mut engine, "main", "main");
    let plaintext = "AWS_SECRET_ACCESS_KEY=hunter2";
    let sha = dohc_engine_storage::hex_sha256(plaintext.as_bytes());
    engine
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT INTO blobs (sha256,byte_length,text) VALUES (?1,?2,?3)",
                params![sha, plaintext.len() as i64, plaintext],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .expect("seed secret plaintext blob");

    let disclosure = version_create_with_shipped_snapshots(
        "secret-snapshot-peer",
        "feature",
        vec![shipped_text_snapshot("secret-object", "app/.env", &sha)],
    );
    let refusal = apply_replication_envelope(&mut engine, &disclosure, &NoFaults, &NoLiveLeases);

    // Create `feature` honestly. If the disclosure op had persisted anything,
    // this becomes a no-op over the already-created version and the secret
    // alias below is live.
    let honest = envelope(
        "honest-version-peer",
        0,
        "version.create",
        json!({
            "versionId": "feature",
            "name": "Feature",
            "kind": "named",
            "forkVersionId": "main",
            "createdAtMs": 1_500
        }),
    );
    assert!(matches!(
        apply_replication_envelope(&mut engine, &honest, &NoFaults, &NoLiveLeases),
        Ok(ApplyOutcome::Applied(RoutedApply { conflict: None, .. }))
    ));

    assert_eq!(
        VersionedTextStore::new(&mut engine)
            .read_text("ws", "feature", "app/.env")
            .expect("secret path read is answerable"),
        None,
        "a replicated fork snapshot must never make secret plaintext readable"
    );
    let alias_rows: i64 = engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT (SELECT COUNT(*) FROM path_aliases WHERE path='app/.env') \
                 + (SELECT COUNT(*) FROM snapshots WHERE path='app/.env') \
                 + (SELECT COUNT(*) FROM fork_base_snapshots WHERE path='app/.env') \
                 + (SELECT COUNT(*) FROM file_objects WHERE object_id='secret-object')",
                [],
                |row| row.get(0),
            )
        })
        .expect("secret alias rows");
    assert_eq!(alias_rows, 0, "nothing from the disclosure op may persist");
    assert!(matches!(
        refusal,
        Ok(ApplyOutcome::Refused(ReplicationRefusal {
            reason: RefusalReason::InvalidInput {
                ref reason
            },
            ..
        })) if reason == "version.create shipped snapshot path must be tracked"
    ));
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "secret-snapshot-peer").expect("ack"),
        0
    );
}

/// The local plaintext write path stores the CANONICAL path
/// (`validate_plaintext_storable_path` returns the normalized form). A
/// replicated fork snapshot persists its wire path verbatim, so a
/// non-canonical spelling of a tracked path would mint a second, shadow alias
/// for the same logical file that the canonical read surface cannot see.
#[test]
fn version_create_fork_snapshot_refuses_a_non_canonical_tracked_path() {
    for (index, path) in ["notes/./plan.md", "notes//plan.md", "notes\\plan.md"]
        .into_iter()
        .enumerate()
    {
        let (_scratch, _path, mut engine) = store();
        seed_replication_version(&mut engine, "main", "main");
        let sha = dohc_engine_storage::hex_sha256(b"content");
        engine
            .write_with(&NoFaults, |tx| {
                tx.execute(
                    "INSERT INTO blobs (sha256,byte_length,text) VALUES (?1,7,'content')",
                    [&sha],
                )
                .map_err(SyncError::persist)?;
                Ok::<_, SyncError>(())
            })
            .expect("seed blob");
        let origin = format!("shadow-alias-peer-{index}");
        let version_id = format!("shadow-alias-version-{index}");
        let operation = version_create_with_shipped_snapshots(
            &origin,
            &version_id,
            vec![shipped_text_snapshot("shadow-object", path, &sha)],
        );

        assert!(
            matches!(
                apply_replication_envelope(&mut engine, &operation, &NoFaults, &NoLiveLeases),
                Ok(ApplyOutcome::Refused(ReplicationRefusal {
                    reason: RefusalReason::InvalidInput {
                        ref reason
                    },
                    ..
                })) if reason == "version.create shipped snapshot path must be canonical"
            ),
            "{path}"
        );
        let (persisted, version_rows): (i64, i64) = engine
            .read_with(|conn| {
                Ok::<_, rusqlite::Error>((
                    conn.query_row(
                        "SELECT (SELECT COUNT(*) FROM path_aliases) \
                         + (SELECT COUNT(*) FROM snapshots)",
                        [],
                        |row| row.get(0),
                    )?,
                    conn.query_row(
                        "SELECT COUNT(*) FROM versions \
                         WHERE workspace_id='ws' AND version_id=?1",
                        [&version_id],
                        |row| row.get(0),
                    )?,
                ))
            })
            .expect("alias rows");
        assert_eq!(persisted, 0, "{path}");
        assert_eq!(
            version_rows, 0,
            "the version inserted before snapshot validation must roll back: {path}"
        );
        assert_eq!(
            read_replication_acked_seq(&engine, "ws", &origin).expect("ack"),
            0,
            "{path}"
        );
    }
}

#[test]
fn version_create_legacy_payload_copies_workspace_scoped_source_tables() {
    let (_scratch, _path, mut engine) = store();
    seed_replication_version(&mut engine, "main", "main");
    seed_replication_version_in_workspace(&mut engine, "foreign-ws", "main", "main");
    let source_sha = dohc_engine_storage::hex_sha256(b"legacy source");
    let foreign_sha = dohc_engine_storage::hex_sha256(b"foreign source");
    engine
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT INTO blobs (sha256,byte_length,text) VALUES (?1,13,'legacy source')",
                [&source_sha],
            )
            .map_err(SyncError::persist)?;
            tx.execute(
                "INSERT INTO blobs (sha256,byte_length,text) VALUES (?1,14,'foreign source')",
                [&foreign_sha],
            )
            .map_err(SyncError::persist)?;
            tx.execute(
                "INSERT INTO file_objects (workspace_id,object_id,created_at_ms) \
                 VALUES ('ws','legacy-object',1)",
                [],
            )
            .map_err(SyncError::persist)?;
            tx.execute(
                "INSERT INTO snapshots \
                 (workspace_id,version_id,object_id,path,blob_sha256,updated_at_ms,latest_moment_id, \
                  metadata_origin,metadata_summary,metadata_correlation_id,content_kind,binary_sha256) \
                 VALUES ('ws','main','legacy-object','legacy.md',?1,2,'legacy-moment', \
                         'sync','legacy summary','legacy correlation','text',NULL)",
                [&source_sha],
            )
            .map_err(SyncError::persist)?;
            tx.execute(
                "INSERT INTO path_aliases (workspace_id,version_id,path,object_id) \
                 VALUES ('ws','main','legacy.md','legacy-object')",
                [],
            )
            .map_err(SyncError::persist)?;
            tx.execute(
                "INSERT INTO file_objects (workspace_id,object_id,created_at_ms) \
                 VALUES ('foreign-ws','foreign-object',1)",
                [],
            )
            .map_err(SyncError::persist)?;
            tx.execute(
                "INSERT INTO snapshots \
                 (workspace_id,version_id,object_id,path,blob_sha256,updated_at_ms,latest_moment_id,metadata_origin,content_kind,binary_sha256) \
                 VALUES ('foreign-ws','main','foreign-object','foreign.md',?1,2,'foreign-moment','sync','text',NULL)",
                [&foreign_sha],
            )
            .map_err(SyncError::persist)?;
            tx.execute(
                "INSERT INTO path_aliases (workspace_id,version_id,path,object_id) \
                 VALUES ('foreign-ws','main','foreign.md','foreign-object')",
                [],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .expect("seed legacy source");
    let operation = envelope(
        "legacy-version-peer",
        0,
        "version.create",
        json!({
            "versionId": "legacy-feature",
            "name": "Legacy feature",
            "kind": "named",
            "forkVersionId": "main",
            "forkMomentId": "legacy-moment",
            "createdAtMs": 1_500
        }),
    );

    assert!(matches!(
        apply_replication_envelope(&mut engine, &operation, &NoFaults, &NoLiveLeases),
        Ok(ApplyOutcome::Applied(RoutedApply { conflict: None, .. }))
    ));
    let counts: (i64, i64, i64) = engine
        .read_with(|conn| {
            Ok::<_, rusqlite::Error>((
                conn.query_row(
                    "SELECT COUNT(*) FROM snapshots \
                     WHERE workspace_id='ws' AND version_id='legacy-feature' \
                       AND object_id='legacy-object' AND content_kind='text'",
                    [],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*) FROM path_aliases \
                     WHERE workspace_id='ws' AND version_id='legacy-feature' \
                       AND path='legacy.md' AND object_id='legacy-object'",
                    [],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*) FROM fork_base_snapshots \
                     WHERE workspace_id='ws' AND version_id='legacy-feature' \
                       AND object_id='legacy-object' AND content_kind='text'",
                    [],
                    |row| row.get(0),
                )?,
            ))
        })
        .expect("legacy copied rows");
    assert_eq!(counts, (1, 1, 1));
    type Metadata = (String, Option<String>, Option<String>);
    let copied_metadata: (Metadata, Metadata) = engine
        .read_with(|conn| {
            let read = |table: &str| {
                conn.query_row(
                    &format!(
                        "SELECT metadata_origin,metadata_summary,metadata_correlation_id \
                         FROM {table} WHERE workspace_id='ws' \
                         AND version_id='legacy-feature' AND object_id='legacy-object'"
                    ),
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
            };
            Ok::<_, rusqlite::Error>((read("snapshots")?, read("fork_base_snapshots")?))
        })
        .expect("legacy copied metadata");
    let expected_metadata = (
        "sync".to_owned(),
        Some("legacy summary".to_owned()),
        Some("legacy correlation".to_owned()),
    );
    // MUTATION: either legacy INSERT...SELECT dropping an ordinal-18 column
    // changes one half of this complete-tuple assertion.
    assert_eq!(
        copied_metadata,
        (expected_metadata.clone(), expected_metadata)
    );
    let foreign_destination_rows: (i64, i64, i64) = engine
        .read_with(|conn| {
            Ok::<_, rusqlite::Error>((
                conn.query_row(
                    "SELECT COUNT(*) FROM snapshots \
                     WHERE workspace_id='foreign-ws' AND version_id='legacy-feature'",
                    [],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*) FROM path_aliases \
                     WHERE workspace_id='foreign-ws' AND version_id='legacy-feature'",
                    [],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*) FROM fork_base_snapshots \
                     WHERE workspace_id='foreign-ws' AND version_id='legacy-feature'",
                    [],
                    |row| row.get(0),
                )?,
            ))
        })
        .expect("foreign destination rows");
    assert_eq!(foreign_destination_rows, (0, 0, 0));
}

#[test]
fn version_create_rejects_a_version_id_owned_by_another_workspace() {
    let (_scratch, _path, mut engine) = store();
    seed_replication_version(&mut engine, "main", "main");
    seed_replication_version_in_workspace(&mut engine, "foreign-ws", "foreign-version", "named");
    let operation = envelope(
        "collision-peer",
        0,
        "version.create",
        json!({
            "versionId": "foreign-version",
            "name": "Collision",
            "kind": "named",
            "createdAtMs": 1_500
        }),
    );

    assert!(matches!(
        apply_replication_envelope(&mut engine, &operation, &NoFaults, &NoLiveLeases),
        Ok(ApplyOutcome::Refused(ReplicationRefusal {
            reason: RefusalReason::InvalidInput {
                ref reason
            },
            ..
        })) if reason == "version id belongs to another workspace"
    ));
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "collision-peer").expect("ack"),
        0
    );
    let local_collision: bool = engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM versions \
                 WHERE workspace_id='ws' AND version_id='foreign-version')",
                [],
                |row| row.get(0),
            )
        })
        .expect("local collision");
    assert!(!local_collision);
}

fn seed_secret_fork_state(engine: &mut EngineStore, ciphertext: &[u8]) -> (String, String, String) {
    use base64::Engine as _;
    use base64::engine::general_purpose::STANDARD;

    seed_replication_version(engine, "main", "main");
    seed_replication_version(engine, "feature", "named");
    let sha = engine
        .put_binary_blob(ciphertext)
        .expect("secret ciphertext blob");
    let iv = STANDARD.encode([7_u8; SECRET_IV_BYTES]);
    let tag = STANDARD.encode([9_u8; SECRET_TAG_BYTES]);
    let ciphertext_base64 = STANDARD.encode(ciphertext);
    engine
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT INTO secret_files \
                 (workspace_id,version_id,path,iv_base64,auth_tag_base64,ciphertext_base64,byte_length,updated_at_ms,latest_moment_id) \
                 VALUES ('ws','main','app/.env',?1,?2,?3,?4,100,'source-tip')",
                params![iv, tag, ciphertext_base64, ciphertext.len() as i64],
            )
            .map_err(SyncError::persist)?;
            tx.execute(
                "INSERT INTO secret_files \
                 (workspace_id,version_id,path,iv_base64,auth_tag_base64,ciphertext_base64,byte_length,updated_at_ms,latest_moment_id) \
                 VALUES ('ws','main','config/prod.env',?1,?2,?3,?4,101,'source-tip-2')",
                params![iv, tag, ciphertext_base64, ciphertext.len() as i64],
            )
            .map_err(SyncError::persist)?;
            tx.execute(
                "INSERT INTO secret_files \
                 (workspace_id,version_id,path,iv_base64,auth_tag_base64,ciphertext_base64,byte_length,updated_at_ms,latest_moment_id) \
                 VALUES ('ws','feature','stale.env',?1,?2,?3,?4,1,'stale-tip')",
                params![iv, tag, ciphertext_base64, ciphertext.len() as i64],
            )
            .map_err(SyncError::persist)?;
            tx.execute(
                "INSERT INTO secret_fork_bases \
                 (workspace_id,version_id,path,iv_base64,auth_tag_base64,ciphertext_base64,byte_length) \
                 VALUES ('ws','feature','stale.env',?1,?2,?3,?4)",
                params![iv, tag, ciphertext_base64, ciphertext.len() as i64],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .expect("seed secret fork state");
    (sha, iv, tag)
}

#[test]
fn secret_version_fork_router_copies_the_complete_payload_and_replays_idempotently() {
    let (_scratch, _path, mut engine) = store();
    let ciphertext = b"sealed source bytes";
    let (sha, iv, tag) = seed_secret_fork_state(&mut engine, ciphertext);
    let operation = envelope(
        "secret-fork-peer",
        0,
        "secret.version.fork",
        json!({
            "fromVersionId": "main",
            "toVersionId": "feature",
            "rows": [{
                "path": "app/.env",
                "ivBase64": iv,
                "authTagBase64": tag,
                "ciphertextSha256": sha,
                "byteLength": ciphertext.len(),
                "updatedAtMs": 100,
                "latestMomentId": "source-tip"
            }, {
                "path": "config/prod.env",
                "ivBase64": iv,
                "authTagBase64": tag,
                "ciphertextSha256": sha,
                "byteLength": ciphertext.len(),
                "updatedAtMs": 101,
                "latestMomentId": "source-tip-2"
            }]
        }),
    );

    assert!(matches!(
        apply_replication_envelope(&mut engine, &operation, &NoFaults, &NoLiveLeases),
        Ok(ApplyOutcome::Applied(RoutedApply { conflict: None, .. }))
    ));
    let rows: (Vec<String>, Vec<String>) = engine
        .read_with(|conn| {
            let files = conn
                .prepare(
                    "SELECT path FROM secret_files WHERE workspace_id='ws' AND version_id='feature' ORDER BY path",
                )?
                .query_map([], |row| row.get(0))?
                .collect::<Result<Vec<_>, _>>()?;
            let bases = conn
                .prepare(
                    "SELECT path FROM secret_fork_bases WHERE workspace_id='ws' AND version_id='feature' ORDER BY path",
                )?
                .query_map([], |row| row.get(0))?
                .collect::<Result<Vec<_>, _>>()?;
            Ok::<_, rusqlite::Error>((files, bases))
        })
        .expect("secret fork rows");
    assert_eq!(
        rows,
        (
            vec!["app/.env".into(), "config/prod.env".into()],
            vec!["app/.env".into(), "config/prod.env".into()]
        )
    );
    let mut applier_replay = operation.clone();
    applier_replay.origin_id = "secret-fork-applier-replay-peer".into();
    assert!(matches!(
        apply_replication_envelope(&mut engine, &applier_replay, &NoFaults, &NoLiveLeases),
        Ok(ApplyOutcome::Applied(RoutedApply { conflict: None, .. }))
    ));
    let replayed_rows: (i64, i64) = engine
        .read_with(|conn| {
            Ok::<_, rusqlite::Error>((
                conn.query_row(
                    "SELECT COUNT(*) FROM secret_files \
                     WHERE workspace_id='ws' AND version_id='feature'",
                    [],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*) FROM secret_fork_bases \
                     WHERE workspace_id='ws' AND version_id='feature'",
                    [],
                    |row| row.get(0),
                )?,
            ))
        })
        .expect("replayed secret fork rows");
    assert_eq!(replayed_rows, (2, 2));
    assert!(matches!(
        apply_replication_envelope(&mut engine, &applier_replay, &NoFaults, &NoLiveLeases),
        Ok(ApplyOutcome::Skipped)
    ));
}

#[test]
fn secret_version_fork_retries_after_the_sealed_source_converges() {
    use base64::Engine as _;
    use base64::engine::general_purpose::STANDARD;

    let (_scratch, _path, mut engine) = store();
    let ciphertext = b"sealed source bytes";
    let (_sha, iv, tag) = seed_secret_fork_state(&mut engine, ciphertext);
    let poison_sha = engine
        .put_binary_blob(b"poison source bytes")
        .expect("poison ciphertext blob");
    let operation = envelope(
        "poison-fork-peer",
        0,
        "secret.version.fork",
        json!({
            "fromVersionId": "main",
            "toVersionId": "feature",
            "rows": [{
                "path": "app/.env",
                "ivBase64": iv,
                "authTagBase64": tag,
                "ciphertextSha256": poison_sha,
                "byteLength": ciphertext.len(),
                "updatedAtMs": 100,
                "latestMomentId": "source-tip"
            }, {
                "path": "config/prod.env",
                "ivBase64": iv,
                "authTagBase64": tag,
                "ciphertextSha256": dohc_engine_storage::hex_sha256(ciphertext),
                "byteLength": ciphertext.len(),
                "updatedAtMs": 101,
                "latestMomentId": "source-tip-2"
            }]
        }),
    );

    assert!(matches!(
        apply_replication_envelope(&mut engine, &operation, &NoFaults, &NoLiveLeases),
        Err(SyncError::RetryableState {
            reason: "secret fork payload does not match the local sealed source state"
        })
    ));
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "poison-fork-peer").expect("ack"),
        -1,
        "MUTATION: refusing a receiver-state mismatch permanently retires the fork coordinate"
    );
    let destination: Vec<String> = engine
        .read_with(|conn| {
            conn.prepare(
                "SELECT path FROM secret_files WHERE workspace_id='ws' AND version_id='feature' ORDER BY path",
            )?
            .query_map([], |row| row.get(0))?
            .collect::<Result<Vec<_>, _>>()
        })
        .expect("destination remains");
    assert_eq!(destination, vec!["stale.env"]);

    engine
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "UPDATE secret_files SET ciphertext_base64=?1,byte_length=?2 \
                 WHERE workspace_id='ws' AND version_id='main' AND path='app/.env'",
                params![
                    STANDARD.encode(b"poison source bytes"),
                    b"poison source bytes".len() as i64
                ],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .expect("converge source state");
    assert!(matches!(
        apply_replication_envelope(&mut engine, &operation, &NoFaults, &NoLiveLeases),
        Ok(ApplyOutcome::Applied(RoutedApply { conflict: None, .. }))
    ));
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "poison-fork-peer").expect("retry ack"),
        0
    );
    let destination: Vec<String> = engine
        .read_with(|conn| {
            conn.prepare(
                "SELECT path FROM secret_files \
                 WHERE workspace_id='ws' AND version_id='feature' ORDER BY path",
            )?
            .query_map([], |row| row.get(0))?
            .collect::<Result<Vec<_>, _>>()
        })
        .expect("destination after retry");
    assert_eq!(
        destination,
        vec!["app/.env", "config/prod.env"],
        "the same fork coordinate must apply after its source dependency arrives"
    );
}

#[test]
fn relay_page_applies_later_secret_source_before_retrying_an_early_fork() {
    let (_scratch, _path, mut engine) = store();
    let original = b"sealed source bytes";
    let (_original_sha, iv, tag) = seed_secret_fork_state(&mut engine, original);
    seed_identity(&mut engine);
    let converged = b"poison source bytes";
    let converged_sha = engine
        .put_binary_blob(converged)
        .expect("converged source blob");
    let fork = envelope(
        "page-fork-peer",
        0,
        "secret.version.fork",
        json!({
            "fromVersionId": "main",
            "toVersionId": "feature",
            "rows": [{
                "path": "app/.env",
                "ivBase64": iv,
                "authTagBase64": tag,
                "ciphertextSha256": converged_sha,
                "byteLength": converged.len(),
                "updatedAtMs": 2_000,
                "latestMomentId": "secret-sync-page-source-peer-0"
            }, {
                "path": "config/prod.env",
                "ivBase64": iv,
                "authTagBase64": tag,
                "ciphertextSha256": dohc_engine_storage::hex_sha256(original),
                "byteLength": original.len(),
                "updatedAtMs": 101,
                "latestMomentId": "source-tip-2"
            }]
        }),
    );
    let source = envelope(
        "page-source-peer",
        0,
        "secret.file.put",
        json!({
            "versionId": "main",
            "path": "app/.env",
            "metadata": {"origin": "sync"},
            "ivBase64": iv,
            "authTagBase64": tag,
            "ciphertextSha256": converged_sha,
            "byteLength": converged.len()
        }),
    );
    let client = RelaySyncClient::new(FakeRelay {
        pushes: Mutex::new(0),
        pull: Mutex::new(Some(PullResponse {
            ops: vec![fork, source],
            next_cursor: 2,
            has_more: false,
        })),
    });

    let outcome = client
        .pull_chat_workspace(&mut engine, "ws", &NoFaults, &NoLiveLeases)
        .expect("page-local dependency retry");
    let SyncPassOutcome::Complete {
        applied,
        refused,
        pending_cursor,
        ..
    } = outcome
    else {
        panic!("pull must complete");
    };
    assert_eq!(
        (applied, refused),
        (2, 0),
        "MUTATION: aborting on the first retryable fork never reaches its later source operation"
    );
    assert!(pending_cursor.is_some());
    let destination_present: bool = engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM secret_files \
                 WHERE workspace_id='ws' AND version_id='feature' AND path='app/.env' \
                   AND latest_moment_id='secret-sync-page-source-peer-0')",
                [],
                |row| row.get(0),
            )
        })
        .expect("fork destination");
    assert!(destination_present);
}

#[test]
fn secret_version_fork_mismatch_never_acks_without_source_progress() {
    use base64::Engine as _;
    use base64::engine::general_purpose::STANDARD;

    let (_scratch, _path, mut engine) = store();
    let ciphertext = b"sealed source bytes";
    let (sha, iv, tag) = seed_secret_fork_state(&mut engine, ciphertext);
    let operation = envelope(
        "bounded-fork-peer",
        0,
        "secret.version.fork",
        json!({
            "fromVersionId": "main",
            "toVersionId": "feature",
            "rows": [{
                "path": "app/.env",
                "ivBase64": STANDARD.encode([9_u8; SECRET_IV_BYTES]),
                "authTagBase64": tag,
                "ciphertextSha256": sha,
                "byteLength": ciphertext.len(),
                "updatedAtMs": 100,
                "latestMomentId": "source-tip"
            }, {
                "path": "config/prod.env",
                "ivBase64": iv,
                "authTagBase64": STANDARD.encode([8_u8; SECRET_TAG_BYTES]),
                "ciphertextSha256": sha,
                "byteLength": ciphertext.len(),
                "updatedAtMs": 101,
                "latestMomentId": "source-tip-2"
            }]
        }),
    );

    for _ in 0..5 {
        assert!(matches!(
            apply_replication_envelope(&mut engine, &operation, &NoFaults, &NoLiveLeases),
            Err(SyncError::RetryableState {
                reason: "secret fork payload does not match the local sealed source state"
            })
        ));
    }
    assert_unacked_and_unjournaled(&engine, "bounded-fork-peer");
    let refusal_count: i64 = engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM replication_pending_refusals \
                 WHERE workspace_id='ws' AND origin_id='bounded-fork-peer'",
                [],
                |row| row.get(0),
            )
        })
        .expect("fork refusal count");
    assert_eq!(
        refusal_count, 0,
        "MUTATION: a pull-count cutoff eventually retires an otherwise recoverable fork"
    );
}

#[test]
fn secret_version_fork_malformed_sealed_source_is_local_corruption_and_unacked() {
    let (_scratch, _path, mut engine) = store();
    let ciphertext = b"sealed source bytes";
    let (sha, iv, tag) = seed_secret_fork_state(&mut engine, ciphertext);
    engine
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "UPDATE secret_files SET ciphertext_base64='***' \
                 WHERE workspace_id='ws' AND version_id='main' AND path='app/.env'",
                [],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .expect("corrupt sealed source fixture");
    let operation = envelope(
        "corrupt-sealed-source-peer",
        0,
        "secret.version.fork",
        json!({
            "fromVersionId": "main",
            "toVersionId": "feature",
            "rows": [{
                "path": "app/.env",
                "ivBase64": iv,
                "authTagBase64": tag,
                "ciphertextSha256": sha,
                "byteLength": ciphertext.len(),
                "updatedAtMs": 100,
                "latestMomentId": "source-tip"
            }, {
                "path": "config/prod.env",
                "ivBase64": iv,
                "authTagBase64": tag,
                "ciphertextSha256": sha,
                "byteLength": ciphertext.len(),
                "updatedAtMs": 101,
                "latestMomentId": "source-tip-2"
            }]
        }),
    );

    assert!(matches!(
        apply_replication_envelope(&mut engine, &operation, &NoFaults, &NoLiveLeases),
        Err(SyncError::Storage(
            dohc_engine_storage::StorageError::StateCorrupt { .. }
        ))
    ));
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "corrupt-sealed-source-peer").expect("ack"),
        -1,
        "local sealed-source corruption must remain repairable and retryable"
    );
}

#[test]
fn secret_version_fork_defers_set_mismatches_but_refuses_duplicate_paths() {
    let (_scratch, _path, mut engine) = store();
    let ciphertext = b"sealed source bytes";
    let (sha, iv, tag) = seed_secret_fork_state(&mut engine, ciphertext);
    let row = |path: &str, updated_at_ms: i64, latest_moment_id: &str| {
        json!({
            "path": path,
            "ivBase64": iv,
            "authTagBase64": tag,
            "ciphertextSha256": sha,
            "byteLength": ciphertext.len(),
            "updatedAtMs": updated_at_ms,
            "latestMomentId": latest_moment_id
        })
    };
    let state_dependent_cases = [
        ("subset-fork-peer", vec![row("app/.env", 100, "source-tip")]),
        (
            "superset-fork-peer",
            vec![
                row("app/.env", 100, "source-tip"),
                row("config/prod.env", 101, "source-tip-2"),
                row("extra.env", 102, "extra-tip"),
            ],
        ),
    ];
    for (origin, rows) in state_dependent_cases {
        let operation = envelope(
            origin,
            0,
            "secret.version.fork",
            json!({
                "fromVersionId": "main",
                "toVersionId": "feature",
                "rows": rows
            }),
        );
        assert!(matches!(
            apply_replication_envelope(&mut engine, &operation, &NoFaults, &NoLiveLeases),
            Err(SyncError::RetryableState {
                reason: "secret fork payload does not match the local sealed source state"
            })
        ));
        assert_eq!(
            read_replication_acked_seq(&engine, "ws", origin).expect("ack"),
            -1,
            "MUTATION: {origin} is receiver-state-dependent and must stay retryable"
        );
        let destination: Vec<String> = engine
            .read_with(|conn| {
                conn.prepare(
                    "SELECT path FROM secret_files \
                     WHERE workspace_id='ws' AND version_id='feature' ORDER BY path",
                )?
                .query_map([], |row| row.get(0))?
                .collect::<Result<Vec<_>, _>>()
            })
            .expect("destination remains");
        assert_eq!(destination, vec!["stale.env"], "{origin}");
    }

    let duplicate = envelope(
        "duplicate-fork-peer",
        0,
        "secret.version.fork",
        json!({
            "fromVersionId": "main",
            "toVersionId": "feature",
            "rows": [
                row("app/.env", 100, "source-tip"),
                row("app/.env", 100, "source-tip")
            ]
        }),
    );
    assert!(matches!(
        apply_replication_envelope(&mut engine, &duplicate, &NoFaults, &NoLiveLeases),
        Ok(ApplyOutcome::Refused(ReplicationRefusal {
            reason: RefusalReason::InvalidInput { ref reason },
            ..
        })) if reason == "secret fork contains duplicate paths"
    ));
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "duplicate-fork-peer").expect("duplicate ack"),
        0,
        "a duplicate path is a payload fault, not a convergence race"
    );
}

/// An empty replicated fork satisfies the `rows.len() == source.len()`
/// bijection whenever the named SOURCE is empty, then falls through to the
/// UNCONDITIONAL destination wipe — erasing every secret tip and fork base the
/// destination already holds. An honest local fork with an empty source
/// journals no op at all (`fork_version_in_tx` only journals when it copied a
/// row), so an empty wire fork has no valid producer.
#[test]
fn secret_version_fork_with_no_rows_cannot_erase_the_destination_secrets() {
    let (_scratch, _path, mut engine) = store();
    let ciphertext = b"sealed source bytes";
    seed_secret_fork_state(&mut engine, ciphertext);
    seed_replication_version(&mut engine, "empty-source", "named");

    let operation = envelope(
        "empty-fork-peer",
        0,
        "secret.version.fork",
        json!({
            "fromVersionId": "empty-source",
            "toVersionId": "feature",
            "rows": []
        }),
    );

    let refusal = apply_replication_envelope(&mut engine, &operation, &NoFaults, &NoLiveLeases);
    assert!(matches!(
        refusal,
        Ok(ApplyOutcome::Refused(ReplicationRefusal {
            reason: RefusalReason::InvalidInput {
                ref reason
            },
            ..
        })) if reason == "secret fork must carry at least one row"
    ));
    let next = envelope(
        "empty-fork-peer",
        1,
        "chat.channel.create",
        json!({
            "channelId": "after-empty-fork",
            "name": "Still moving",
            "slug": "still-moving",
            "kind": "channel",
            "createdAtMs": 2_001
        }),
    );
    assert!(matches!(
        apply_replication_envelope(&mut engine, &next, &NoFaults, &NoLiveLeases),
        Ok(ApplyOutcome::Applied(_))
    ));
    let destination: (Vec<String>, Vec<String>) = engine
        .read_with(|conn| {
            let files = conn
                .prepare(
                    "SELECT path FROM secret_files \
                     WHERE workspace_id='ws' AND version_id='feature' ORDER BY path",
                )?
                .query_map([], |row| row.get(0))?
                .collect::<Result<Vec<_>, _>>()?;
            let bases = conn
                .prepare(
                    "SELECT path FROM secret_fork_bases \
                     WHERE workspace_id='ws' AND version_id='feature' ORDER BY path",
                )?
                .query_map([], |row| row.get(0))?
                .collect::<Result<Vec<_>, _>>()?;
            Ok::<_, rusqlite::Error>((files, bases))
        })
        .expect("destination secrets");
    assert_eq!(
        destination,
        (vec!["stale.env".to_owned()], vec!["stale.env".to_owned()]),
        "an empty wire fork must not wipe the destination"
    );
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "empty-fork-peer").expect("ack"),
        1,
        "the destructive refusal must preserve state without wedging its origin"
    );
}

/// Secret ciphertext refs ride the shared binary-blob transport (5 MiB cap),
/// which is far above the secret domain's own 1 MiB cap. AES-GCM here is
/// length-preserving — IV and tag travel in their own payload fields — so a
/// remote put referencing an oversized hydrated blob would park plaintext-sized
/// ciphertext the local secret write path would have refused.
#[test]
fn secret_put_over_the_domain_cap_is_refused_without_a_tip_or_moment() {
    use base64::Engine as _;
    use base64::engine::general_purpose::STANDARD;

    let (_scratch, _path, mut engine) = store();
    seed_replication_version(&mut engine, "main", "main");
    let oversized = vec![7_u8; MAX_SECRET_FILE_BYTES + 1];
    let sha = engine
        .put_binary_blob(&oversized)
        .expect("oversized ciphertext blob");

    let operation = envelope(
        "oversized-secret-peer",
        0,
        "secret.file.put",
        json!({
            "versionId": "main",
            "path": "app/.env",
            "metadata": {"origin": "sync"},
            "ivBase64": STANDARD.encode([1_u8; SECRET_IV_BYTES]),
            "authTagBase64": STANDARD.encode([2_u8; SECRET_TAG_BYTES]),
            "ciphertextSha256": sha,
            "byteLength": oversized.len()
        }),
    );

    let refusal = apply_replication_envelope(&mut engine, &operation, &NoFaults, &NoLiveLeases);
    let stored: (i64, i64) = engine
        .read_with(|conn| {
            Ok::<_, rusqlite::Error>((
                conn.query_row("SELECT COUNT(*) FROM secret_files", [], |row| row.get(0))?,
                conn.query_row("SELECT COUNT(*) FROM secret_moments", [], |row| row.get(0))?,
            ))
        })
        .expect("secret rows");
    assert_eq!(stored, (0, 0), "an over-cap put must persist nothing");
    assert!(matches!(
        refusal,
        Ok(ApplyOutcome::Refused(ReplicationRefusal {
            reason: RefusalReason::InvalidInput {
                ref reason
            },
            ..
        })) if reason == "secret ciphertext metadata is invalid"
    ));
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "oversized-secret-peer").expect("ack"),
        0
    );

    // The same put at exactly the cap is admitted, so the guard is a CAP and
    // not a blanket refusal of large secrets.
    let at_cap = vec![7_u8; MAX_SECRET_FILE_BYTES];
    let at_cap_sha = engine
        .put_binary_blob(&at_cap)
        .expect("at-cap ciphertext blob");
    let admitted = envelope(
        "at-cap-secret-peer",
        0,
        "secret.file.put",
        json!({
            "versionId": "main",
            "path": "app/.env",
            "metadata": {"origin": "sync"},
            "ivBase64": STANDARD.encode([1_u8; SECRET_IV_BYTES]),
            "authTagBase64": STANDARD.encode([2_u8; SECRET_TAG_BYTES]),
            "ciphertextSha256": at_cap_sha,
            "byteLength": at_cap.len()
        }),
    );
    assert!(matches!(
        apply_replication_envelope(&mut engine, &admitted, &NoFaults, &NoLiveLeases),
        Ok(ApplyOutcome::Applied(RoutedApply { conflict: None, .. }))
    ));
}

#[test]
fn secret_put_ciphertext_length_mismatch_is_refused_and_acked() {
    use base64::Engine as _;
    use base64::engine::general_purpose::STANDARD;

    let (_scratch, _path, mut engine) = store();
    seed_replication_version(&mut engine, "main", "main");
    let ciphertext = b"sealed";
    let sha = engine.put_binary_blob(ciphertext).expect("ciphertext blob");
    let operation = envelope(
        "length-mismatch-peer",
        0,
        "secret.file.put",
        json!({
            "versionId": "main",
            "path": "app/.env",
            "metadata": {"origin": "sync"},
            "ivBase64": STANDARD.encode([1_u8; SECRET_IV_BYTES]),
            "authTagBase64": STANDARD.encode([2_u8; SECRET_TAG_BYTES]),
            "ciphertextSha256": sha,
            "byteLength": ciphertext.len() - 1
        }),
    );

    assert!(matches!(
        apply_replication_envelope(&mut engine, &operation, &NoFaults, &NoLiveLeases),
        Ok(ApplyOutcome::Refused(ReplicationRefusal {
            reason: RefusalReason::InvalidInput {
                ref reason
            },
            ..
        })) if reason == "secret ciphertext blob does not match declared metadata"
    ));
    let stored: (i64, i64) = engine
        .read_with(|conn| {
            Ok::<_, rusqlite::Error>((
                conn.query_row("SELECT COUNT(*) FROM secret_files", [], |row| row.get(0))?,
                conn.query_row("SELECT COUNT(*) FROM secret_moments", [], |row| row.get(0))?,
            ))
        })
        .expect("secret rows");
    assert_eq!(stored, (0, 0));
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "length-mismatch-peer").expect("ack"),
        0
    );
}

#[test]
fn secret_put_corrupt_local_ciphertext_blob_is_hard_and_unacked() {
    use base64::Engine as _;
    use base64::engine::general_purpose::STANDARD;

    let (_scratch, _path, mut engine) = store();
    seed_replication_version(&mut engine, "main", "main");
    let honest_ciphertext = b"honest";
    let corrupt_ciphertext = b"sealed";
    assert_eq!(
        honest_ciphertext.len(),
        corrupt_ciphertext.len(),
        "the corruption fixture must isolate digest mismatch from byte-length mismatch"
    );
    let sha = dohc_engine_storage::hex_sha256(honest_ciphertext);
    engine
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT INTO binary_blobs (sha256, byte_length, bytes) VALUES (?1, ?2, ?3)",
                params![sha, corrupt_ciphertext.len() as i64, corrupt_ciphertext],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .expect("corrupt local blob fixture");
    let operation = envelope(
        "corrupt-secret-blob-peer",
        0,
        "secret.file.put",
        json!({
            "versionId": "main",
            "path": "app/.env",
            "metadata": {"origin": "sync"},
            "ivBase64": STANDARD.encode([1_u8; SECRET_IV_BYTES]),
            "authTagBase64": STANDARD.encode([2_u8; SECRET_TAG_BYTES]),
            "ciphertextSha256": sha,
            "byteLength": honest_ciphertext.len()
        }),
    );

    assert!(matches!(
        apply_replication_envelope(&mut engine, &operation, &NoFaults, &NoLiveLeases),
        Err(SyncError::Storage(
            dohc_engine_storage::StorageError::BlobIntegrity { .. }
        ))
    ));
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "corrupt-secret-blob-peer").expect("ack"),
        -1,
        "local blob corruption must leave the peer coordinate retryable"
    );
    let stored: (i64, i64, i64) = engine
        .read_with(|conn| {
            Ok::<_, rusqlite::Error>((
                conn.query_row("SELECT COUNT(*) FROM secret_files", [], |row| row.get(0))?,
                conn.query_row("SELECT COUNT(*) FROM secret_moments", [], |row| row.get(0))?,
                conn.query_row(
                    "SELECT COUNT(*) FROM replication_log \
                     WHERE workspace_id='ws' AND origin_id='corrupt-secret-blob-peer'",
                    [],
                    |row| row.get(0),
                )?,
            ))
        })
        .expect("corrupt refusal state");
    assert_eq!(stored, (0, 0, 0));
}

#[test]
fn secret_put_corrupt_local_ciphertext_length_is_hard_and_unacked() {
    use base64::Engine as _;
    use base64::engine::general_purpose::STANDARD;

    let (_scratch, _path, mut engine) = store();
    seed_replication_version(&mut engine, "main", "main");
    let ciphertext = b"honest";
    let sha = dohc_engine_storage::hex_sha256(ciphertext);
    engine
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT INTO binary_blobs (sha256, byte_length, bytes) VALUES (?1, 99, ?2)",
                params![sha, ciphertext],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .expect("corrupt local length fixture");
    let operation = envelope(
        "corrupt-secret-length-peer",
        0,
        "secret.file.put",
        json!({
            "versionId": "main",
            "path": "app/.env",
            "metadata": {"origin": "sync"},
            "ivBase64": STANDARD.encode([1_u8; SECRET_IV_BYTES]),
            "authTagBase64": STANDARD.encode([2_u8; SECRET_TAG_BYTES]),
            "ciphertextSha256": sha,
            "byteLength": ciphertext.len()
        }),
    );

    assert!(matches!(
        apply_replication_envelope(&mut engine, &operation, &NoFaults, &NoLiveLeases),
        Err(SyncError::Storage(
            dohc_engine_storage::StorageError::StateCorrupt { .. }
        ))
    ));
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "corrupt-secret-length-peer").expect("ack"),
        -1,
        "MUTATION: local length corruption must stay hard and retryable"
    );
}

#[test]
fn secret_put_rejects_noncanonical_shadow_path_but_accepts_canonical_spelling() {
    use base64::Engine as _;
    use base64::engine::general_purpose::STANDARD;

    let (_scratch, _path, mut engine) = store();
    seed_replication_version(&mut engine, "main", "main");
    let ciphertext = b"canonical-secret-ciphertext";
    let sha = engine
        .put_binary_blob(ciphertext)
        .expect("secret ciphertext blob");
    let payload = |path: &str| {
        json!({
            "versionId": "main",
            "path": path,
            "metadata": {"origin": "sync"},
            "ivBase64": STANDARD.encode([1_u8; SECRET_IV_BYTES]),
            "authTagBase64": STANDARD.encode([2_u8; SECRET_TAG_BYTES]),
            "ciphertextSha256": sha,
            "byteLength": ciphertext.len()
        })
    };

    let seed = envelope(
        "canonical-secret-seed",
        0,
        "secret.file.put",
        payload("a/b.env"),
    );
    assert!(matches!(
        apply_replication_envelope(&mut engine, &seed, &NoFaults, &NoLiveLeases),
        Ok(ApplyOutcome::Applied(RoutedApply { conflict: None, .. }))
    ));

    let shadow = envelope(
        "noncanonical-secret-peer",
        0,
        "secret.file.put",
        payload("a//b.env"),
    );
    let refusal = apply_replication_envelope(&mut engine, &shadow, &NoFaults, &NoLiveLeases);
    let paths = engine
        .read_with(|conn| {
            conn.prepare(
                "SELECT path FROM secret_files \
                 WHERE workspace_id='ws' AND version_id='main' ORDER BY path",
            )?
            .query_map([], |row| row.get(0))?
            .collect::<Result<Vec<String>, _>>()
        })
        .expect("secret paths");
    if matches!(
        refusal,
        Ok(ApplyOutcome::Applied(RoutedApply { conflict: None, .. }))
    ) {
        assert_eq!(
            paths,
            vec!["a//b.env", "a/b.env"],
            "current-code bug proof: the raw wire spelling persists beside its canonical alias"
        );
    }
    assert!(matches!(
        refusal,
        Ok(ApplyOutcome::Refused(ReplicationRefusal {
            reason: RefusalReason::InvalidInput {
                ref reason
            },
            ..
        })) if reason == "secret replication path must be canonical"
    ));
    assert_eq!(
        paths,
        vec!["a/b.env"],
        "MUTATION: without the canonical guard, the raw wire spelling persists as a shadow row"
    );
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "noncanonical-secret-peer").expect("ack"),
        0
    );

    let mut canonical = envelope(
        "canonical-secret-update",
        0,
        "secret.file.put",
        payload("a/b.env"),
    );
    canonical.recorded_at_ms = 3_000;
    assert!(matches!(
        apply_replication_envelope(&mut engine, &canonical, &NoFaults, &NoLiveLeases),
        Ok(ApplyOutcome::Applied(RoutedApply { conflict: None, .. }))
    ));
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "canonical-secret-update").expect("ack"),
        0
    );
}

#[test]
fn secret_put_rejects_synthesized_moment_id_owned_by_unrelated_local_history() {
    use base64::Engine as _;
    use base64::engine::general_purpose::STANDARD;

    let (_scratch, _path, mut engine) = store();
    seed_replication_version(&mut engine, "main", "main");
    let ciphertext = b"collision-secret-ciphertext";
    let sha = engine
        .put_binary_blob(ciphertext)
        .expect("secret ciphertext blob");
    engine
        .write_with(&NoFaults, |tx| -> Result<(), SyncError> {
            tx.execute(
                "INSERT INTO secret_moments \
                 (workspace_id,moment_order,moment_id,version_id,path,recorded_at_ms,operation,metadata_origin,after_present) \
                 VALUES ('ws',1,'secret-sync-collision-peer-0','main','unrelated.env',100,'delete','api',0)",
                [],
            )
            .map_err(SyncError::persist)?;
            Ok(())
        })
        .expect("seed colliding local secret moment");

    let operation = envelope(
        "collision-peer",
        0,
        "secret.file.put",
        json!({
            "versionId": "main",
            "path": "target.env",
            "metadata": {"origin": "sync"},
            "ivBase64": STANDARD.encode([1_u8; SECRET_IV_BYTES]),
            "authTagBase64": STANDARD.encode([2_u8; SECRET_TAG_BYTES]),
            "ciphertextSha256": sha,
            "byteLength": ciphertext.len()
        }),
    );
    let refusal = apply_replication_envelope(&mut engine, &operation, &NoFaults, &NoLiveLeases);
    let state = engine
        .read_with(|conn| {
            Ok::<_, rusqlite::Error>((
                conn.query_row(
                    "SELECT COUNT(*) FROM secret_files \
                     WHERE workspace_id='ws' AND version_id='main' AND path='target.env'",
                    [],
                    |row| row.get::<_, i64>(0),
                )?,
                conn.query_row(
                    "SELECT path FROM secret_moments \
                     WHERE workspace_id='ws' AND moment_id='secret-sync-collision-peer-0'",
                    [],
                    |row| row.get::<_, String>(0),
                )?,
            ))
        })
        .expect("secret collision state");
    if matches!(
        refusal,
        Ok(ApplyOutcome::Applied(RoutedApply { conflict: None, .. }))
    ) {
        assert_eq!(
            state,
            (1, "unrelated.env".to_owned()),
            "current-code bug proof: the tip references an unrelated pre-existing history row"
        );
    }
    assert!(matches!(
        refusal,
        Ok(ApplyOutcome::Refused(ReplicationRefusal {
            reason: RefusalReason::InvalidInput {
                ref reason
            },
            ..
        })) if reason == "replicated secret moment id collides with existing history"
    ));
    assert_eq!(
        state,
        (0, "unrelated.env".to_owned()),
        "the collision must roll back the incoming tip and preserve the existing owner"
    );
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "collision-peer").expect("ack"),
        0
    );
}

#[test]
fn secret_put_refuses_and_acks_synthesized_moment_id_owned_by_plaintext_history() {
    use base64::Engine as _;
    use base64::engine::general_purpose::STANDARD;

    let (_scratch, _path, mut engine) = store();
    seed_replication_version(&mut engine, "main", "main");
    let plaintext_sha = dohc_engine_storage::hex_sha256(b"plaintext owner");
    engine
        .write_with(&NoFaults, |tx| -> Result<(), SyncError> {
            tx.execute(
                "INSERT INTO blobs (sha256,byte_length,text) \
                 VALUES (?1,15,'plaintext owner')",
                [&plaintext_sha],
            )
            .map_err(SyncError::persist)?;
            tx.execute(
                "INSERT INTO file_objects (workspace_id,object_id,created_at_ms) \
                 VALUES ('ws','plaintext-owner',1)",
                [],
            )
            .map_err(SyncError::persist)?;
            tx.execute(
                "INSERT INTO moments \
                 (workspace_id,moment_order,moment_id,version_id,object_id,path, \
                  recorded_at_ms,operation,after_blob_sha256,before_present, \
                  metadata_origin,after_content_kind) \
                 VALUES ('ws',1,'secret-sync-plaintext-collision-peer-0','main', \
                         'plaintext-owner','owner.md',100,'write',?1,1,'api','text')",
                [&plaintext_sha],
            )
            .map_err(SyncError::persist)?;
            Ok(())
        })
        .expect("seed colliding plaintext moment");
    let ciphertext = b"cross-table-secret-ciphertext";
    let ciphertext_sha = engine
        .put_binary_blob(ciphertext)
        .expect("secret ciphertext blob");
    let operation = envelope(
        "plaintext-collision-peer",
        0,
        "secret.file.put",
        json!({
            "versionId": "main",
            "path": "target.env",
            "metadata": {"origin": "sync"},
            "ivBase64": STANDARD.encode([1_u8; SECRET_IV_BYTES]),
            "authTagBase64": STANDARD.encode([2_u8; SECRET_TAG_BYTES]),
            "ciphertextSha256": ciphertext_sha,
            "byteLength": ciphertext.len()
        }),
    );

    // MUTATION: checking only secret_moments permits the synthesized secret ID
    // to alias an unrelated plaintext row in the shared identity namespace.
    assert!(matches!(
        apply_replication_envelope(&mut engine, &operation, &NoFaults, &NoLiveLeases),
        Ok(ApplyOutcome::Refused(ReplicationRefusal {
            reason: RefusalReason::InvalidInput { ref reason },
            ..
        })) if reason == "replicated secret moment id collides with existing history"
    ));
    let state: (i64, i64, i64) = engine
        .read_with(|conn| {
            Ok::<_, rusqlite::Error>((
                conn.query_row(
                    "SELECT COUNT(*) FROM moments \
                     WHERE workspace_id='ws' \
                       AND moment_id='secret-sync-plaintext-collision-peer-0'",
                    [],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*) FROM secret_moments \
                     WHERE workspace_id='ws' \
                       AND moment_id='secret-sync-plaintext-collision-peer-0'",
                    [],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*) FROM secret_files \
                     WHERE workspace_id='ws' AND version_id='main' AND path='target.env'",
                    [],
                    |row| row.get(0),
                )?,
            ))
        })
        .expect("cross-table collision state");
    assert_eq!(state, (1, 0, 0));
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "plaintext-collision-peer").expect("ack"),
        0
    );
}

#[test]
fn secret_put_redelivery_skips_its_own_synthesized_moment() {
    use base64::Engine as _;
    use base64::engine::general_purpose::STANDARD;

    let (_scratch, _path, mut engine) = store();
    seed_replication_version(&mut engine, "main", "main");
    let ciphertext = b"redelivery-secret-ciphertext";
    let sha = engine
        .put_binary_blob(ciphertext)
        .expect("secret ciphertext blob");
    let operation = envelope(
        "redelivery-secret-peer",
        0,
        "secret.file.put",
        json!({
            "versionId": "main",
            "path": "app/.env",
            "metadata": {"origin": "sync"},
            "ivBase64": STANDARD.encode([1_u8; SECRET_IV_BYTES]),
            "authTagBase64": STANDARD.encode([2_u8; SECRET_TAG_BYTES]),
            "ciphertextSha256": sha,
            "byteLength": ciphertext.len()
        }),
    );
    assert!(matches!(
        apply_replication_envelope(&mut engine, &operation, &NoFaults, &NoLiveLeases),
        Ok(ApplyOutcome::Applied(RoutedApply { conflict: None, .. }))
    ));
    assert!(matches!(
        apply_replication_envelope(&mut engine, &operation, &NoFaults, &NoLiveLeases),
        Ok(ApplyOutcome::Skipped)
    ));
    let history_rows: i64 = engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM secret_moments \
                 WHERE workspace_id='ws' AND moment_id='secret-sync-redelivery-secret-peer-0'",
                [],
                |row| row.get(0),
            )
        })
        .expect("secret history count");
    assert_eq!(history_rows, 1);
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "redelivery-secret-peer").expect("ack"),
        0
    );
}

#[test]
fn central_router_recognizes_owned_kinds_and_refuses_unknown_kinds_forward_compatibly() {
    for kind in crate::router::owned_op_kinds() {
        let (_scratch, _path, mut engine) = store();
        let operation = envelope("router-peer", 0, kind, json!({}));
        assert!(
            !matches!(
                apply_replication_envelope(&mut engine, &operation, &NoFaults, &NoLiveLeases),
                Err(SyncError::UnsupportedOperation)
            ),
            "{kind} fell through the router"
        );
    }

    let (_scratch, _path, mut engine) = store();
    let workspace = envelope("router-workspace", 0, "workspace.init", json!({}));
    assert!(matches!(
        apply_replication_envelope(&mut engine, &workspace, &NoFaults, &NoLiveLeases),
        Ok(ApplyOutcome::Applied(_))
    ));
    // moment.append is no longer the not-implemented stub: it routes to the real
    // applier, so a malformed payload is rejected by that applier rather than by
    // the router.
    let moment = envelope("router-moment", 0, "moment.append", json!({}));
    assert!(matches!(
        apply_replication_envelope(&mut engine, &moment, &NoFaults, &NoLiveLeases),
        Ok(ApplyOutcome::Refused(ReplicationRefusal {
            reason: RefusalReason::InvalidInput { ref reason },
            ..
        })) if reason == "moment.append payload is malformed"
    ));
    let unknown = envelope("router-unknown", 0, "version.rename", json!({}));
    assert!(matches!(
        apply_replication_envelope(&mut engine, &unknown, &NoFaults, &NoLiveLeases),
        Ok(ApplyOutcome::Refused(ReplicationRefusal {
            reason: RefusalReason::InvalidInput { ref reason },
            ..
        })) if reason == "operation kind is not supported by this client"
    ));
    let next = envelope(
        "router-unknown",
        1,
        "chat.channel.create",
        json!({
            "channelId": "after-newer-op",
            "name": "After newer op",
            "slug": "after-newer-op",
            "kind": "channel",
            "createdAtMs": 2_001
        }),
    );
    assert!(matches!(
        apply_replication_envelope(&mut engine, &next, &NoFaults, &NoLiveLeases),
        Ok(ApplyOutcome::Applied(_))
    ));
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "router-unknown")
            .expect("forward-compatible ack"),
        1,
        "MUTATION: returning UnsupportedOperation hard-wedges an older client on a newer peer op"
    );
}

#[test]
fn relay_pull_routes_secret_and_conflict_ops_without_cursor_wedge() {
    let (_scratch, _path, mut engine) = store();
    seed_identity(&mut engine);
    seed_replication_version(&mut engine, "main", "main");
    let secret = envelope(
        "relay-secret-peer",
        0,
        "secret.file.delete",
        json!({"versionId":"main","path":"app/.env","metadata":{"origin":"sync"}}),
    );
    let conflict = envelope(
        "relay-conflict-peer",
        0,
        "conflict.resolve",
        json!({
            "conflictId": "missing-conflict",
            "status": "resolved",
            "chosenFrom": "current",
            "resolution": "keep-current",
            "updatedAtMs": 10,
            "path": "notes/missing.md"
        }),
    );
    let client = RelaySyncClient::new(FakeRelay {
        pushes: Mutex::new(0),
        pull: Mutex::new(Some(PullResponse {
            ops: vec![secret, conflict],
            next_cursor: 2,
            has_more: false,
        })),
    });

    let outcome = client
        .pull_chat_workspace(&mut engine, "ws", &NoFaults, &NoLiveLeases)
        .expect("pull");
    let SyncPassOutcome::Complete {
        applied,
        skipped,
        pending_cursor,
        pending_resolves,
        ..
    } = outcome
    else {
        panic!("pull must complete: {outcome:?}");
    };
    assert_eq!((applied, skipped), (2, 0));
    assert!(pending_cursor.is_some());
    // The unmatched resolve is ACKED — the cursor moves past it — so the only
    // place the peer's decision survives is this structured surface. Flattening
    // it into the applied count would lose it permanently.
    assert_eq!(
        pending_resolves,
        vec![PendingResolve {
            remote_conflict_id: "missing-conflict".to_owned(),
            local_conflict_id: None,
            path: Some("notes/missing.md".to_owned()),
            reason: PendingResolveReason::UnmatchedTarget,
        }]
    );
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "relay-secret-peer").expect("secret ack"),
        0
    );
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "relay-conflict-peer").expect("conflict ack"),
        0
    );
}

#[test]
fn relay_multi_page_pull_preserves_page_one_pending_resolve() {
    let (_scratch, _path, mut engine) = store();
    seed_identity(&mut engine);
    seed_replication_version(&mut engine, "main", "main");
    let resolve = envelope(
        "multi-page-resolve-peer",
        0,
        "conflict.resolve",
        json!({
            "conflictId": "missing-on-multi-page-receiver",
            "status": "resolved",
            "chosenFrom": "incoming",
            "resolution": "applied-incoming",
            "updatedAtMs": 10,
            "path": "notes/multi-page.md"
        }),
    );
    let normal = envelope(
        "multi-page-normal-peer",
        0,
        "chat.reaction.set",
        reaction_payload("added", "✅", 20, "multi-page-author"),
    );
    let client = RelaySyncClient::new(PagedRelay::new([
        (
            0,
            PullResponse {
                ops: vec![resolve],
                next_cursor: 1,
                has_more: true,
            },
        ),
        (
            1,
            PullResponse {
                ops: Vec::new(),
                next_cursor: 2,
                has_more: true,
            },
        ),
        (
            2,
            PullResponse {
                ops: vec![normal],
                next_cursor: 3,
                has_more: false,
            },
        ),
    ]));

    let outcome = client
        .pull_chat_workspace(&mut engine, "ws", &NoFaults, &NoLiveLeases)
        .expect("multi-page pull");
    let SyncPassOutcome::Complete {
        fetched,
        applied,
        pending_cursor: Some(pending_cursor),
        pending_resolves,
        ..
    } = outcome
    else {
        panic!("multi-page pull must complete: {outcome:?}");
    };
    assert_eq!((fetched, applied, pending_cursor.cursor), (2, 2, 3));
    assert_eq!(
        pending_resolves,
        vec![PendingResolve {
            remote_conflict_id: "missing-on-multi-page-receiver".to_owned(),
            local_conflict_id: None,
            path: Some("notes/multi-page.md".to_owned()),
            reason: PendingResolveReason::UnmatchedTarget,
        }],
        "page-one pending resolves must survive later page fetches"
    );
    assert_eq!(
        read_pushed_seq(&engine, "ws", "multi-page-resolve-peer").expect("resolve peer push state"),
        0
    );
    assert_eq!(
        read_pushed_seq(&engine, "ws", "multi-page-normal-peer").expect("normal peer push state"),
        0
    );
}

#[test]
fn relay_pull_operation_ceiling_returns_a_resumable_completed_page() {
    // MUTATION: removing the pass ceiling fetches cursor 500 in the first call
    // and advances the returned prefix through the second page.
    let (_scratch, _path, mut engine) = store();
    seed_identity(&mut engine);
    let first_page = (0..crate::model::MAX_PULL_OPS_PER_PASS)
        .map(|seq| {
            envelope(
                "bounded-pull-peer",
                i64::try_from(seq).expect("sequence"),
                "chat.reaction.set",
                reaction_payload(
                    "added",
                    "🧱",
                    i64::try_from(seq).expect("timestamp"),
                    &format!("bounded-{seq}"),
                ),
            )
        })
        .collect::<Vec<_>>();
    let second_page = envelope(
        "bounded-pull-second-peer",
        0,
        "chat.reaction.set",
        reaction_payload("added", "▶️", 1_000, "bounded-second"),
    );
    let client = RelaySyncClient::new(PagedRelay::new([
        (
            0,
            PullResponse {
                ops: first_page,
                next_cursor: i64::try_from(crate::model::MAX_PULL_OPS_PER_PASS).expect("cursor"),
                has_more: true,
            },
        ),
        (
            i64::try_from(crate::model::MAX_PULL_OPS_PER_PASS).expect("cursor"),
            PullResponse {
                ops: vec![second_page],
                next_cursor: i64::try_from(crate::model::MAX_PULL_OPS_PER_PASS + 1)
                    .expect("cursor"),
                has_more: false,
            },
        ),
    ]));

    let first = client
        .pull_chat_workspace(&mut engine, "ws", &NoFaults, &NoLiveLeases)
        .expect("bounded first pass");
    let SyncPassOutcome::Complete {
        fetched,
        has_more,
        pending_cursor: Some(pending),
        ..
    } = first
    else {
        panic!("first pass must return its completed-page cursor: {first:?}");
    };
    assert_eq!(fetched, crate::model::MAX_PULL_OPS_PER_PASS);
    assert!(
        has_more,
        "the operation ceiling must explicitly report that the relay is not drained"
    );
    assert_eq!(
        pending.cursor,
        i64::try_from(crate::model::MAX_PULL_OPS_PER_PASS).expect("cursor")
    );
    assert_eq!(
        *client.transport().pulls.lock().expect("pull calls"),
        [(0, crate::model::MAX_PULL_OPS_PER_PASS)]
    );
    client
        .commit_pull_cursor(&mut engine, "ws", &pending, &NoFaults)
        .expect("commit bounded prefix");

    let second = client
        .pull_chat_workspace(&mut engine, "ws", &NoFaults, &NoLiveLeases)
        .expect("resume after bounded prefix");
    assert!(matches!(
        second,
        SyncPassOutcome::Complete {
            fetched: 1,
            applied: 1,
            ..
        }
    ));
}

#[test]
fn relay_pull_page_ceiling_stops_an_advancing_empty_stream() {
    // MUTATION: removing the page ceiling walks the unbounded advancing stream.
    let (_scratch, _path, mut engine) = store();
    seed_identity(&mut engine);
    let mut pages = Vec::new();
    for cursor in 0..crate::model::MAX_PULL_PAGES_PER_PASS {
        let cursor = i64::try_from(cursor).expect("cursor");
        pages.push((
            cursor,
            PullResponse {
                ops: Vec::new(),
                next_cursor: cursor + 1,
                has_more: true,
            },
        ));
    }
    let resume_cursor =
        i64::try_from(crate::model::MAX_PULL_PAGES_PER_PASS).expect("resume cursor");
    pages.push((
        resume_cursor,
        PullResponse {
            ops: Vec::new(),
            next_cursor: resume_cursor + 1,
            has_more: false,
        },
    ));
    let client = RelaySyncClient::new(PagedRelay::new(pages));

    let first = client
        .pull_chat_workspace(&mut engine, "ws", &NoFaults, &NoLiveLeases)
        .expect("page-bounded pull");
    let SyncPassOutcome::Complete {
        fetched: 0,
        has_more,
        pending_cursor: Some(pending),
        ..
    } = first
    else {
        panic!("empty page prefix must complete: {first:?}");
    };
    assert_eq!(pending.cursor, resume_cursor);
    assert!(
        has_more,
        "the page ceiling must explicitly report that the relay is not drained"
    );
    assert_eq!(
        client.transport().pulls.lock().expect("pull calls").len(),
        crate::model::MAX_PULL_PAGES_PER_PASS
    );
}

#[test]
fn recover_origin_continues_an_advancing_stream_past_the_pull_page_ceiling() {
    let (_scratch, _path, mut engine) = store();
    seed_identity(&mut engine);
    let pages = (0..=crate::model::MAX_PULL_PAGES_PER_PASS)
        .map(|cursor| {
            let cursor = i64::try_from(cursor).expect("cursor");
            (
                cursor,
                PullResponse {
                    ops: Vec::new(),
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
        "MUTATION: restoring the recover page ceiling rejects before the terminal page"
    );
}

#[test]
fn recover_origin_rebases_each_current_lww_projection_coordinate() {
    let (_scratch, _path, mut engine) = store();
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
    let (_scratch, _path, mut engine) = store();
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
    let (_peer_scratch, _peer_path, mut peer) = store();
    assert_eq!(
        apply_chat_envelope(&mut peer, &peer_operation, &NoFaults).expect("apply peer winner"),
        ApplyOutcome::Applied(())
    );
    assert_eq!(
        apply_chat_envelope(&mut peer, &rebased_operation, &NoFaults)
            .expect("apply rebased losing decision"),
        ApplyOutcome::Applied(())
    );
    assert_eq!(conflicted_decision_projection(&peer), recovered_projection);
}

#[test]
fn recover_origin_recomputes_when_rebased_decision_loser_becomes_the_winner() {
    let (_scratch, _path, mut engine) = store();
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
    let (_peer_scratch, _peer_path, mut peer) = store();
    assert_eq!(
        apply_chat_envelope(&mut peer, &peer_operation, &NoFaults).expect("apply peer winner"),
        ApplyOutcome::Applied(())
    );
    assert_eq!(
        apply_chat_envelope(&mut peer, &rebased_operation, &NoFaults)
            .expect("apply rebased winning decision"),
        ApplyOutcome::Applied(())
    );
    assert_eq!(conflicted_decision_projection(&peer), recovered_projection);
}

#[test]
fn recover_origin_clears_shared_push_positions_before_rebased_ops_are_scanned() {
    let (_scratch, _path, mut engine) = store();
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
        "MUTATION: retaining the old physical cursor skips every renumbered operation"
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

#[test]
fn shared_channel_pull_stops_at_one_completed_page_and_resumes_from_its_cursor() {
    let (_scratch, _path, mut engine) = store();
    let client = RelaySyncClient::new(PagedShareRelay::new(
        [
            (
                0,
                SharedChannelResponse {
                    ops: Vec::new(),
                    next_cursor: 1,
                    has_more: true,
                    push: None,
                },
            ),
            (
                1,
                SharedChannelResponse {
                    ops: Vec::new(),
                    next_cursor: 2,
                    has_more: false,
                    push: None,
                },
            ),
        ],
        [],
    ));

    let first = client
        .pull_shared_channel(&mut engine, "ws", "share", "channel-wire", &NoFaults)
        .expect("bounded shared-channel page");
    assert_eq!((first.fetched, first.next_cursor), (0, 1));
    assert!(
        first.has_more,
        "MUTATION: dropping has_more prevents the desktop adapter from draining page two"
    );
    assert_eq!(
        *client
            .transport()
            .shared_pulls
            .lock()
            .expect("shared pull calls"),
        [0],
        "MUTATION: restoring the hasMore loop consumes the second page in one actor turn"
    );
    assert_eq!(
        read_share_cursor(&engine, "ws", "share", CursorKind::SharedChannel)
            .expect("committed shared cursor"),
        1
    );

    let second = client
        .pull_shared_channel(&mut engine, "ws", "share", "channel-wire", &NoFaults)
        .expect("resumed shared-channel page");
    assert_eq!(second.next_cursor, 2);
}

#[test]
fn shared_channel_boundary_rejection_commits_its_only_op_and_next_pull_proceeds() {
    let (_scratch, _path, mut engine) = store();
    let rejected = ShareReplicationEnvelope {
        origin_id: "shared-peer".to_owned(),
        origin_seq: 0,
        op_kind: "chat.channel.create".to_owned(),
        payload: json!({
            "channelId": "outside-channel",
            "wireId": "outside-wire",
            "name": "Outside",
            "slug": "outside",
            "kind": "channel",
            "createdAtMs": 10
        }),
        recorded_at_ms: 10,
    };
    let admitted = ShareReplicationEnvelope {
        origin_id: "shared-peer".to_owned(),
        origin_seq: 1,
        op_kind: "chat.channel.create".to_owned(),
        payload: json!({
            "channelId": "inside-channel",
            "wireId": "channel-wire",
            "name": "Inside",
            "slug": "inside",
            "kind": "channel",
            "createdAtMs": 20
        }),
        recorded_at_ms: 20,
    };
    let client = RelaySyncClient::new(PagedShareRelay::new(
        [
            (
                0,
                SharedChannelResponse {
                    ops: vec![rejected],
                    next_cursor: 1,
                    has_more: true,
                    push: None,
                },
            ),
            (
                1,
                SharedChannelResponse {
                    ops: vec![admitted],
                    next_cursor: 2,
                    has_more: false,
                    push: None,
                },
            ),
        ],
        [],
    ));

    let first = client
        .pull_shared_channel(&mut engine, "ws", "share", "channel-wire", &NoFaults)
        .expect("boundary rejection is a reported, acknowledged outcome");
    assert_eq!(
        first,
        SharedChannelPullOutcome {
            fetched: 1,
            has_more: true,
            applied: 0,
            refused: 1,
            rejections: vec![SharedChannelRejection {
                origin_id: "shared-peer".to_owned(),
                origin_seq: 0,
                op_kind: "chat.channel.create".to_owned(),
                reason: "share-boundary-violation".to_owned(),
            }],
            skipped: 0,
            next_cursor: 1,
        }
    );
    assert_eq!(
        read_share_cursor(&engine, "ws", "share", CursorKind::SharedChannel)
            .expect("rejected page cursor"),
        1,
        "MUTATION: returning ShareOperationRejected before commit leaves this at zero"
    );

    let second = client
        .pull_shared_channel(&mut engine, "ws", "share", "channel-wire", &NoFaults)
        .expect("the page after the rejected-only page must remain reachable");
    assert_eq!(
        (
            second.fetched,
            second.applied,
            second.refused,
            second.next_cursor
        ),
        (1, 1, 0, 2)
    );
    assert_eq!(
        *client
            .transport()
            .shared_pulls
            .lock()
            .expect("shared pull calls"),
        [0, 1],
        "MUTATION: failing to commit the rejected boundary refetches cursor zero"
    );
}

#[test]
fn shared_channel_push_resumes_from_durable_physical_and_dense_positions() {
    let (_scratch, _path, mut engine) = store();
    seed_identity(&mut engine);
    engine
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT INTO chat_channels \
                 (workspace_id,channel_id,name,slug,kind,created_at_ms,updated_at_ms) \
                 VALUES ('ws','channel','Channel','channel','channel',1,1)",
                [],
            )
            .map_err(SyncError::persist)?;
            tx.execute(
                "INSERT INTO chat_channel_wire_ids (workspace_id,wire_id,channel_id) \
                 VALUES ('ws','channel-wire','channel')",
                [],
            )
            .map_err(SyncError::persist)?;
            tx.execute(
                "INSERT INTO chat_threads \
                 (workspace_id,thread_id,title,created_at_ms,updated_at_ms,channel_id) \
                 VALUES ('ws','thread','Thread',1,1,'channel')",
                [],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .expect("shared channel fixture");
    assert_eq!(
        journal_local_replication_op(
            &mut engine,
            "ws",
            "local",
            "epoch-1",
            "stream-1",
            "chat.message.append",
            &json!({"threadId": "thread"}),
            1_001,
            &NoFaults,
        )
        .expect("journal first eligible op"),
        TxnOutcome::Committed(1)
    );
    let client = RelaySyncClient::new(PagedShareRelay::new([], []));
    assert_eq!(
        client
            .push_shared_channel(&mut engine, "ws", "share", "channel-wire", &NoFaults)
            .expect("first shared push")
            .pushed,
        1
    );

    engine
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "DELETE FROM chat_threads WHERE workspace_id='ws' AND thread_id='thread'",
                [],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .expect("remove historical eligibility fixture");
    assert_eq!(
        journal_local_replication_op(
            &mut engine,
            "ws",
            "local",
            "epoch-1",
            "stream-1",
            "chat.channel.create",
            &json!({"wireId": "channel-wire"}),
            1_002,
            &NoFaults,
        )
        .expect("journal next eligible op"),
        TxnOutcome::Committed(2)
    );
    assert_eq!(
        client
            .push_shared_channel(&mut engine, "ws", "share", "channel-wire", &NoFaults)
            .expect("incremental shared push")
            .pushed,
        1
    );

    let pushes = client
        .transport()
        .shared_pushes
        .lock()
        .expect("shared push calls");
    assert_eq!(pushes.len(), 2);
    assert_eq!(pushes[0].ops[0].origin_seq, 0);
    assert_eq!(
        pushes[1].ops[0].origin_seq, 1,
        "MUTATION: rescanning from -1 recomputes the removed op as ineligible and reuses dense zero"
    );
    drop(pushes);
    let state: (i64, Option<i64>) = engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT pushed_seq,dense_seq FROM shared_channel_push_state \
                 WHERE workspace_id='ws' AND share_id='share'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
        })
        .expect("durable shared push state");
    assert_eq!(state, (2, Some(1)));
}

#[test]
fn shared_channel_push_bootstraps_legacy_state_without_a_dense_position() {
    let (_scratch, _path, mut engine) = store();
    seed_identity(&mut engine);
    assert_eq!(
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
        )
        .expect("journal legacy eligible op"),
        TxnOutcome::Committed(1)
    );
    engine
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT INTO shared_channel_push_state \
                 (workspace_id,share_id,pushed_seq,dense_seq) \
                 VALUES ('ws','share',1,NULL)",
                [],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .expect("legacy shared push state");
    assert_eq!(
        journal_local_replication_op(
            &mut engine,
            "ws",
            "local",
            "epoch-1",
            "stream-1",
            "chat.channel.create",
            &json!({"wireId": "channel-wire"}),
            1_002,
            &NoFaults,
        )
        .expect("journal post-migration op"),
        TxnOutcome::Committed(2)
    );
    let client = RelaySyncClient::new(PagedShareRelay::new([], []));

    assert_eq!(
        client
            .push_shared_channel(&mut engine, "ws", "share", "channel-wire", &NoFaults)
            .expect("bootstrap shared push")
            .pushed,
        1
    );
    let pushes = client
        .transport()
        .shared_pushes
        .lock()
        .expect("shared push calls");
    assert_eq!(pushes.len(), 1);
    assert_eq!(
        pushes[0].ops[0].origin_seq, 1,
        "the migrated physical cursor must bootstrap its matching dense coordinate"
    );
}

#[test]
fn share_view_pull_returns_one_page_as_a_pending_resumable_cursor() {
    let (_scratch, _path, mut engine) = store();
    let client = RelaySyncClient::new(PagedShareRelay::new(
        [],
        [
            (
                0,
                ShareViewResponse {
                    ops: Vec::new(),
                    next_cursor: 1,
                    has_more: true,
                },
            ),
            (
                1,
                ShareViewResponse {
                    ops: Vec::new(),
                    next_cursor: 2,
                    has_more: false,
                },
            ),
        ],
    ));

    let first = client
        .pull_share_view(
            &mut engine,
            "ws",
            "share",
            &tracked_grant(["docs"]),
            &NoFaults,
        )
        .expect("bounded share-view page");
    assert_eq!((first.fetched, first.pending_cursor.cursor), (0, 1));
    assert!(
        first.has_more,
        "MUTATION: dropping has_more prevents the desktop adapter from draining page two"
    );
    assert_eq!(
        *client
            .transport()
            .view_pulls
            .lock()
            .expect("view pull calls"),
        [(0, crate::model::MAX_PULL_OPS_PER_PASS)],
        "MUTATION: restoring the hasMore loop accumulates the second page"
    );
    assert_eq!(
        read_share_cursor(&engine, "ws", "share", CursorKind::ShareView)
            .expect("uncommitted view cursor"),
        0
    );
    client
        .commit_share_view_cursor(&mut engine, "ws", &first.pending_cursor, &NoFaults)
        .expect("commit first view page");
    let second = client
        .pull_share_view(
            &mut engine,
            "ws",
            "share",
            &tracked_grant(["docs"]),
            &NoFaults,
        )
        .expect("resume view page");
    assert_eq!(second.pending_cursor.cursor, 2);
    assert!(!second.has_more);
}

#[test]
fn share_view_pull_accepts_every_tracked_path_selected_by_the_relay() {
    let (_scratch, _path, mut engine) = store();
    let op = |seq, path: &str| ShareReplicationEnvelope {
        origin_id: "peer".to_owned(),
        origin_seq: seq,
        op_kind: "moment.append".to_owned(),
        payload: json!({
            "path": path,
            "payloadAfterPath": path,
            "operation": "selector-only"
        }),
        recorded_at_ms: 10 + seq,
    };
    let client = RelaySyncClient::new(PagedShareRelay::new(
        [],
        [(
            0,
            ShareViewResponse {
                ops: vec![op(0, "docs/a.md"), op(1, "projects/b.md")],
                next_cursor: 2,
                has_more: false,
            },
        )],
    ));
    let granted = tracked_grant(["docs", "projects"]);
    let outcome = client
        .pull_share_view(&mut engine, "ws", "share", &granted, &NoFaults)
        .expect("pull multi-path share");
    assert_eq!(
        (outcome.fetched, outcome.skipped),
        (2, 0),
        "MUTATION: matching only the first granted path permanently drops the other selected path"
    );
}

fn share_view_write_op(seq: i64, path: &str, sha256: &str) -> ShareReplicationEnvelope {
    ShareReplicationEnvelope {
        origin_id: "peer".to_owned(),
        origin_seq: seq,
        op_kind: "moment.append".to_owned(),
        payload: json!({
            "operation": "write",
            "path": path,
            "payloadAfterPath": path,
            "payloadAfterBlobSha256": sha256,
            "payloadAfterContentKind": "text"
        }),
        recorded_at_ms: 10 + seq,
    }
}

/// The secret-path refusal itself is proven at the enforcement function by
/// `share_view_and_shared_channel_fail_closed_outside_boundary`. What this
/// proves is the WIRING: `pull_share_view` turns that refusal into a skip
/// BEFORE replay, so a misbehaving relay never gets the blob requested and no
/// secret plaintext lands.
#[test]
fn share_view_pull_skips_a_secret_path_write_before_requesting_its_blob() {
    let (_scratch, _path, mut engine) = store();
    seed_replication_version(&mut engine, "main", "main");
    let tracked = b"tracked body".to_vec();
    let secret = b"AWS_SECRET_ACCESS_KEY=hunter2".to_vec();
    let tracked_sha = dohc_engine_storage::hex_sha256(&tracked);
    let secret_sha = dohc_engine_storage::hex_sha256(&secret);
    let client = RelaySyncClient::new(
        PagedShareRelay::new(
            [],
            [(
                0,
                ShareViewResponse {
                    ops: vec![
                        share_view_write_op(0, "docs/a.md", &tracked_sha),
                        share_view_write_op(1, "app/.env", &secret_sha),
                    ],
                    next_cursor: 2,
                    has_more: false,
                },
            )],
        )
        .with_view_blobs([(tracked_sha.clone(), tracked), (secret_sha, secret)]),
    );

    // Both paths sit INSIDE the grant, so only the secret classification can
    // refuse `app/.env`.
    let result = client.pull_share_view(
        &mut engine,
        "ws",
        "share",
        &tracked_grant(["docs", "app"]),
        &NoFaults,
    );

    // Nothing landed. Two independent floors say so — the boundary refusal
    // here, and `write_text`'s storable-path floor in `store.rs` — so this
    // fires only when BOTH regress.
    assert_eq!(
        VersionedTextStore::new(&mut engine)
            .read_text("ws", "main", "app/.env")
            .expect("secret path read is answerable"),
        None,
        "MUTATION: losing the boundary refusal AND store.rs's storable floor lands secret plaintext on the read surface"
    );
    // And the blob was never even asked for. Replay downloads it BEFORE the
    // storable floor refuses the path, so a swallowed refusal discloses the
    // secret bytes to the client even though nothing lands. Asserted before
    // the outcome so this disclosure, not the later error, is what fails.
    assert_eq!(
        *client
            .transport()
            .share_blob_calls
            .lock()
            .expect("share blob calls"),
        [tracked_sha],
        "MUTATION: continuing into replay after the boundary refusal downloads the secret blob"
    );
    let outcome = result.expect("a secret op is skipped, not fatal");
    assert_eq!(
        (outcome.fetched, outcome.applied, outcome.skipped),
        (2, 1, 1),
        "the tracked op applies and the secret one is counted as skipped"
    );
    assert_eq!(
        outcome
            .changed_paths
            .iter()
            .map(|changed| changed.path.as_str())
            .collect::<Vec<_>>(),
        ["docs/a.md"]
    );
}

/// A share-view DELETE has no second floor. `replay_share_delete` reaches
/// `validate_addressable_plaintext_path`, which deliberately admits secret
/// paths so an absence check answers honestly, so `share.rs`'s boundary is the
/// only gate — a relay-sent delete for a secret path must leave the file.
#[test]
fn share_view_pull_skips_a_secret_path_delete_that_nothing_downstream_would_stop() {
    let (_scratch, _path, mut engine) = store();
    seed_replication_version(&mut engine, "main", "main");
    let plaintext = "AWS_SECRET_ACCESS_KEY=hunter2";
    seed_text_head(&mut engine, "secret-object", "app/.env", plaintext);
    let client = RelaySyncClient::new(PagedShareRelay::new(
        [],
        [(
            0,
            ShareViewResponse {
                ops: vec![ShareReplicationEnvelope {
                    origin_id: "peer".to_owned(),
                    origin_seq: 0,
                    op_kind: "moment.append".to_owned(),
                    payload: json!({"operation": "delete", "path": "app/.env"}),
                    recorded_at_ms: 10,
                }],
                next_cursor: 1,
                has_more: false,
            },
        )],
    ));

    let outcome = client
        // `app` is granted, so the secret classification is the only gate.
        .pull_share_view(
            &mut engine,
            "ws",
            "share",
            &tracked_grant(["app"]),
            &NoFaults,
        )
        .expect("a secret delete is skipped, not fatal");

    assert_eq!((outcome.applied, outcome.skipped), (0, 1));
    assert!(
        outcome.changed_paths.is_empty(),
        "MUTATION: continuing into replay reports the secret path as changed"
    );
    assert_eq!(
        VersionedTextStore::new(&mut engine)
            .read_text("ws", "main", "app/.env")
            .expect("secret path read is answerable")
            .map(|snapshot| snapshot.text),
        Some(plaintext.to_owned()),
        "MUTATION: continuing into replay lets a relay delete a secret-shadowed file"
    );
}

/// A path grant that follows the workspace's main version — what a recipient
/// pins for every share except a version share.
fn tracked_grant<'a>(paths: impl IntoIterator<Item = &'a str>) -> ShareGrant {
    ShareGrant {
        paths: paths.into_iter().map(str::to_owned).collect(),
        version_id: None,
    }
}

/// A version grant. NO paths selects every tracked path here — and only here,
/// because the relay serves nothing through a selector with neither dimension.
fn version_grant<'a>(paths: impl IntoIterator<Item = &'a str>, version_id: &str) -> ShareGrant {
    ShareGrant {
        paths: paths.into_iter().map(str::to_owned).collect(),
        version_id: Some(version_id.to_owned()),
    }
}

fn share_view_pull_changed(outcome: &ShareViewPullOutcome) -> Vec<&str> {
    outcome
        .changed_paths
        .iter()
        .map(|changed| changed.path.as_str())
        .collect()
}

/// The relay picks the page; the recipient re-checks it against the selector
/// the relay itself stated first. A compromised or buggy relay can address an
/// ORDINARY tracked path outside the granted share — no secret floor and no
/// storable floor stops that one, so the pinned scope is the only gate. It
/// must skip the op before replay, so the ungranted blob is never even
/// requested.
#[test]
fn share_view_pull_skips_a_tracked_path_outside_the_recorded_grant_before_requesting_its_blob() {
    let (_scratch, _path, mut engine) = store();
    seed_replication_version(&mut engine, "main", "main");
    let granted_body = b"the granted doc".to_vec();
    let ungranted_body = b"salary review: everyone".to_vec();
    let sibling_body = b"a sibling of the granted folder".to_vec();
    let granted_sha = dohc_engine_storage::hex_sha256(&granted_body);
    let ungranted_sha = dohc_engine_storage::hex_sha256(&ungranted_body);
    let sibling_sha = dohc_engine_storage::hex_sha256(&sibling_body);
    let client = RelaySyncClient::new(
        PagedShareRelay::new(
            [],
            [(
                0,
                ShareViewResponse {
                    ops: vec![
                        share_view_write_op(0, "docs/a.md", &granted_sha),
                        share_view_write_op(1, "private/hr.md", &ungranted_sha),
                        // "docs-private" only SHARES a prefix with "docs" —
                        // it is not beneath it.
                        share_view_write_op(2, "docs-private/leak.md", &sibling_sha),
                    ],
                    next_cursor: 3,
                    has_more: false,
                },
            )],
        )
        .with_view_blobs([
            (granted_sha.clone(), granted_body),
            (ungranted_sha, ungranted_body),
            (sibling_sha, sibling_body),
        ]),
    );

    let granted = tracked_grant(["docs"]);
    let result = client.pull_share_view(&mut engine, "ws", "share", &granted, &NoFaults);

    // The disclosure comes FIRST in the causal chain: replay downloads the
    // blob before anything downstream looks at the path, so an inert scope
    // check hands the recipient bytes the granter never shared with them —
    // whether or not the write then lands.
    assert_eq!(
        *client
            .transport()
            .share_blob_calls
            .lock()
            .expect("share blob calls"),
        [granted_sha],
        "MUTATION: passing None (or dropping the containment) downloads blobs the share never granted"
    );
    let text = VersionedTextStore::new(&mut engine);
    assert_eq!(
        text.read_text("ws", "main", "private/hr.md")
            .expect("an ungranted tracked path read is answerable"),
        None,
        "MUTATION: an ungranted ORDINARY path has no second floor — it lands"
    );
    assert_eq!(
        text.read_text("ws", "main", "docs-private/leak.md")
            .expect("a sibling-prefix read is answerable"),
        None,
        "MUTATION: matching the grant by bare string prefix admits a sibling folder"
    );
    let outcome = result.expect("an out-of-scope op is skipped, not fatal");
    assert_eq!(
        (outcome.fetched, outcome.applied, outcome.skipped),
        (3, 1, 2),
        "the in-scope op applies and both out-of-scope ops are counted as skipped"
    );
    assert_eq!(
        share_view_pull_changed(&outcome),
        ["docs/a.md"],
        "MUTATION: equality-only matching drops a file BENEATH the granted path"
    );
}

/// A version share can select NO paths, which grants the whole tracked
/// workspace — the relay's `pathVisibleThroughShare` answers
/// `selector.versionId !== null` for that selector, so the mirror admits every
/// tracked path too.
#[test]
fn share_view_pull_applies_every_tracked_path_under_a_whole_workspace_version_grant() {
    let (_scratch, _path, mut engine) = store();
    seed_replication_version(&mut engine, "main", "main");
    let first = b"first body".to_vec();
    let second = b"second body".to_vec();
    let first_sha = dohc_engine_storage::hex_sha256(&first);
    let second_sha = dohc_engine_storage::hex_sha256(&second);
    let client = RelaySyncClient::new(
        PagedShareRelay::new(
            [],
            [(
                0,
                ShareViewResponse {
                    ops: vec![
                        share_view_write_op(0, "docs/a.md", &first_sha),
                        share_view_write_op(1, "projects/b.md", &second_sha),
                    ],
                    next_cursor: 2,
                    has_more: false,
                },
            )],
        )
        .with_view_blobs([(first_sha, first), (second_sha, second)]),
    );

    let outcome = client
        .pull_share_view(
            &mut engine,
            "ws",
            "share",
            &version_grant([], "shared-version"),
            &NoFaults,
        )
        .expect("a whole-workspace version grant pulls");

    assert_eq!(
        (outcome.applied, outcome.skipped),
        (2, 0),
        "MUTATION: reading a versioned empty-path grant as 'nothing granted' refuses a whole-workspace share"
    );
    assert_eq!(
        share_view_pull_changed(&outcome),
        ["docs/a.md", "projects/b.md"]
    );
}

/// A selector with no paths AND no version selects NOTHING. The relay refuses
/// to create one (`validateShareSelector` -> `empty_selector`) and serves
/// nothing through one that exists anyway, so the mirror must admit nothing —
/// reading it as "the whole workspace" would turn the selector the relay is
/// emptiest about into the widest grant the recipient holds.
#[test]
fn share_view_pull_admits_nothing_under_a_grant_that_selects_nothing() {
    let (_scratch, _path, mut engine) = store();
    seed_replication_version(&mut engine, "main", "main");
    let body = b"pulled under a grant that selects nothing".to_vec();
    let sha = dohc_engine_storage::hex_sha256(&body);
    let client = RelaySyncClient::new(
        PagedShareRelay::new(
            [],
            [(
                0,
                ShareViewResponse {
                    ops: vec![share_view_write_op(0, "docs/a.md", &sha)],
                    next_cursor: 1,
                    has_more: false,
                },
            )],
        )
        .with_view_blobs([(sha.clone(), body)]),
    );

    let outcome = client
        .pull_share_view(&mut engine, "ws", "share", &tracked_grant([]), &NoFaults)
        .expect("an out-of-scope op is skipped, not fatal");

    assert_eq!(
        (outcome.applied, outcome.skipped),
        (0, 1),
        "MUTATION: reading no paths as 'the whole workspace' admits every path the relay would serve none of"
    );
    assert!(
        client
            .transport()
            .share_blob_calls
            .lock()
            .expect("share blob calls")
            .is_empty(),
        "MUTATION: the op's blob is downloaded before the empty grant refuses it"
    );
    assert_eq!(
        VersionedTextStore::new(&mut engine)
            .read_text("ws", "main", "docs/a.md")
            .expect("a tracked read is answerable"),
        None,
        "MUTATION: an op admitted by an empty grant lands on the read surface"
    );
}

/// A ShareView boundary with NO grant is not "unscoped", it is closed. The RPC
/// layer already requires a selector; this is the type-level backstop for any
/// caller that builds the boundary directly.
#[test]
fn share_view_boundary_without_a_grant_admits_nothing() {
    let (_scratch, _path, mut engine) = store();
    seed_replication_version(&mut engine, "main", "main");
    let boundary = crate::ShareBoundary {
        share_id: "share".to_owned(),
        surface: crate::ShareSurface::ShareView,
        channel_wire_id: None,
        granted: None,
    };
    let envelope = ReplicationEnvelope {
        workspace_id: "ws".to_owned(),
        origin_id: "peer".to_owned(),
        origin_seq: 0,
        op_kind: "moment.append".to_owned(),
        payload: json!({"path": "docs/a.md", "operation": "write"}),
        recorded_at_ms: 10,
    };

    assert!(
        matches!(
            crate::apply_shared_envelope(&mut engine, &boundary, &envelope, &NoFaults),
            Err(SyncError::ShareBoundaryViolation)
        ),
        "MUTATION: an absent grant reading as 'enforce nothing' admits every path"
    );
}

/// A grant is a SET of paths (the relay allows up to 100), and each one
/// selects itself and its children independently.
#[test]
fn share_view_pull_enforces_every_path_of_a_multi_path_grant() {
    let (_scratch, _path, mut engine) = store();
    seed_replication_version(&mut engine, "main", "main");
    let bodies = ["docs body", "projects body", "private body"];
    let shas = bodies
        .iter()
        .map(|body| dohc_engine_storage::hex_sha256(body.as_bytes()))
        .collect::<Vec<_>>();
    let client = RelaySyncClient::new(
        PagedShareRelay::new(
            [],
            [(
                0,
                ShareViewResponse {
                    ops: vec![
                        share_view_write_op(0, "docs/a.md", &shas[0]),
                        share_view_write_op(1, "projects/b.md", &shas[1]),
                        share_view_write_op(2, "private/c.md", &shas[2]),
                    ],
                    next_cursor: 3,
                    has_more: false,
                },
            )],
        )
        .with_view_blobs(
            shas.iter()
                .zip(bodies)
                .map(|(sha, body)| (sha.clone(), body.as_bytes().to_vec())),
        ),
    );

    let granted = tracked_grant(["docs", "projects"]);
    let outcome = client
        .pull_share_view(&mut engine, "ws", "share", &granted, &NoFaults)
        .expect("a multi-path grant pulls");

    assert_eq!(
        share_view_pull_changed(&outcome),
        ["docs/a.md", "projects/b.md"],
        "MUTATION: matching only the first granted path drops the second"
    );
    assert_eq!((outcome.applied, outcome.skipped), (2, 1));
    assert_eq!(
        *client
            .transport()
            .share_blob_calls
            .lock()
            .expect("share blob calls"),
        shas[..2],
        "MUTATION: the ungranted path's blob is downloaded before the scope is checked"
    );
}

fn share_view_version_create_op(
    seq: i64,
    version_id: &str,
    path: &str,
    sha: &str,
) -> ShareReplicationEnvelope {
    ShareReplicationEnvelope {
        origin_id: "peer".to_owned(),
        origin_seq: seq,
        op_kind: "version.create".to_owned(),
        payload: json!({
            "versionId": version_id,
            "forkSnapshots": [{ "path": path, "blobSha256": sha, "contentKind": "text" }]
        }),
        recorded_at_ms: 10 + seq,
    }
}

/// A version share grants ONE version. `version.create` is the only inbound op
/// that still carries a version identity — the relay minimizes a served
/// `moment.append` down to paths, blob and operation — so it is the only one
/// the recipient can check, and it must name the granted version.
#[test]
fn share_view_pull_skips_a_version_create_from_a_version_the_share_did_not_grant() {
    let (_scratch, _path, mut engine) = store();
    seed_replication_version(&mut engine, "main", "main");
    let granted_body = b"the granted version".to_vec();
    let other_body = b"a version nobody shared".to_vec();
    let granted_sha = dohc_engine_storage::hex_sha256(&granted_body);
    let other_sha = dohc_engine_storage::hex_sha256(&other_body);
    let client = RelaySyncClient::new(
        PagedShareRelay::new(
            [],
            [(
                0,
                ShareViewResponse {
                    ops: vec![
                        share_view_version_create_op(0, "v1", "docs/a.md", &granted_sha),
                        share_view_version_create_op(1, "v2", "docs/b.md", &other_sha),
                    ],
                    next_cursor: 2,
                    has_more: false,
                },
            )],
        )
        .with_view_blobs([(granted_sha.clone(), granted_body), (other_sha, other_body)]),
    );

    // A whole-workspace path scope: the version is the ONLY thing separating
    // these two ops, so nothing else can be what refuses the second.
    let granted = ShareGrant {
        paths: Vec::new(),
        version_id: Some("v1".to_owned()),
    };
    let outcome = client
        .pull_share_view(&mut engine, "ws", "share", &granted, &NoFaults)
        .expect("an ungranted version is skipped, not fatal");

    assert_eq!(
        *client
            .transport()
            .share_blob_calls
            .lock()
            .expect("share blob calls"),
        [granted_sha],
        "MUTATION: dropping the version check downloads a blob from a version the share never granted"
    );
    assert_eq!(
        share_view_pull_changed(&outcome),
        ["docs/a.md"],
        "the granted version applies and the other one lands nothing"
    );
    assert_eq!((outcome.applied, outcome.skipped), (1, 1));
}

/// A path share follows main and is never entitled to a `version.create` —
/// the relay refuses to serve one (`shareFilter.ts`: `selector.versionId ===
/// null` is `allowed: false`), so a recipient that replays one is trusting a
/// relay that just broke its own rule. The snapshot path here is INSIDE the
/// granted paths, so only the version rule can refuse it.
#[test]
fn share_view_pull_refuses_a_version_create_to_a_share_that_granted_only_paths() {
    let (_scratch, _path, mut engine) = store();
    seed_replication_version(&mut engine, "main", "main");
    let body = b"forked into a path share".to_vec();
    let sha = dohc_engine_storage::hex_sha256(&body);
    let client = RelaySyncClient::new(
        PagedShareRelay::new(
            [],
            [(
                0,
                ShareViewResponse {
                    ops: vec![share_view_version_create_op(0, "v1", "docs/a.md", &sha)],
                    next_cursor: 1,
                    has_more: false,
                },
            )],
        )
        .with_view_blobs([(sha, body)]),
    );

    let outcome = client
        .pull_share_view(
            &mut engine,
            "ws",
            "share",
            &tracked_grant(["docs"]),
            &NoFaults,
        )
        .expect("an unentitled version.create is skipped, not fatal");

    assert_eq!(
        (outcome.applied, outcome.skipped),
        (0, 1),
        "MUTATION: an unconstrained version reading as 'any version' replays a fork the share never granted"
    );
    assert!(
        client
            .transport()
            .share_blob_calls
            .lock()
            .expect("share blob calls")
            .is_empty(),
        "MUTATION: the fork's blob is downloaded before the version is checked"
    );
}

#[test]
fn workspace_push_excludes_origins_imported_from_share_views() {
    let (_scratch, _path, mut engine) = store();
    seed_identity(&mut engine);
    engine
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT INTO replication_log \
                 (workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms,imported) \
                 VALUES ('ws','shared:share:peer',0,'moment.append','{}',2,1)",
                [],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .expect("seed imported share origin");
    let client = RelaySyncClient::new(FakeRelay::default());
    client
        .push_workspace(&mut engine, "ws", &NoFaults)
        .expect("push owner lane");
    assert_eq!(
        *client.transport().pushes.lock().expect("push calls"),
        1,
        "MUTATION: an unfiltered origin scan sends the imported share row through the owner lane"
    );
}

#[test]
fn share_view_actor_replay_does_not_redownload_completed_blob_prefixes() {
    let (_scratch, _path, mut engine) = store();
    seed_replication_version(&mut engine, "main", "main");
    let blobs = [b"first".to_vec(), b"second".to_vec(), b"third".to_vec()];
    let snapshots = blobs
        .iter()
        .enumerate()
        .map(|(index, bytes)| {
            json!({
                "path": format!("docs/{index}.md"),
                "blobSha256": dohc_engine_storage::hex_sha256(bytes),
                "contentKind": "text"
            })
        })
        .collect::<Vec<_>>();
    let op = ShareReplicationEnvelope {
        origin_id: "peer".to_owned(),
        origin_seq: 0,
        op_kind: "version.create".to_owned(),
        payload: json!({"versionId": "shared-version", "forkSnapshots": snapshots}),
        recorded_at_ms: 10,
    };
    let relay = PagedShareRelay::new(
        [],
        [(
            0,
            ShareViewResponse {
                ops: vec![op],
                next_cursor: 1,
                has_more: false,
            },
        )],
    )
    .with_view_blobs(
        blobs
            .iter()
            .map(|bytes| (dohc_engine_storage::hex_sha256(bytes), bytes.clone())),
    );
    let client = RelaySyncClient::new(relay);

    client
        .pull_share_view(
            &mut engine,
            "ws",
            "share",
            &version_grant(["docs"], "shared-version"),
            &NoFaults,
        )
        .expect("initial multi-blob pull");
    client
        .pull_share_view(
            &mut engine,
            "ws",
            "share",
            &version_grant(["docs"], "shared-version"),
            &NoFaults,
        )
        .expect("actor-style replay without cursor commit");
    assert_eq!(
        client
            .transport()
            .share_blob_calls
            .lock()
            .expect("share blob calls")
            .len(),
        blobs.len(),
        "MUTATION: fetching before the idempotency lookup redownloads the completed prefix"
    );
}

#[test]
fn relay_redelivered_page_reconstructs_pending_resolve_without_committed_cursor() {
    let (_scratch, _path, mut engine) = store();
    seed_identity(&mut engine);
    seed_replication_version(&mut engine, "main", "main");
    let resolve = envelope(
        "redelivered-resolve-peer",
        0,
        "conflict.resolve",
        json!({
            "conflictId": "missing-on-redelivery",
            "status": "resolved",
            "chosenFrom": "current",
            "resolution": "keep-current",
            "updatedAtMs": 10,
            "path": "notes/redelivery.md"
        }),
    );
    let client = RelaySyncClient::new(PagedRelay::new([(
        0,
        PullResponse {
            ops: vec![resolve],
            next_cursor: 1,
            has_more: false,
        },
    )]));

    let faults = ScriptedFaults::crash_at(FaultPoint::SyncBetweenApplyAndCursorCommit);
    let first = client
        .pull_chat_workspace(&mut engine, "ws", faults.as_ref(), &NoLiveLeases)
        .expect("first pull");
    let SyncPassOutcome::CrashedAfterApply {
        applied,
        pending_resolves: first_pending,
        ..
    } = first
    else {
        panic!("first pull must stop before cursor commit: {first:?}");
    };
    assert_eq!(applied, 1);
    assert_eq!(first_pending.len(), 1);
    assert!(
        read_relay_cursor(&engine, "ws")
            .expect("read cursor")
            .is_none()
    );

    let retry = client
        .pull_chat_workspace(&mut engine, "ws", &NoFaults, &NoLiveLeases)
        .expect("redelivered pull");
    let SyncPassOutcome::Complete {
        applied,
        skipped,
        pending_resolves,
        ..
    } = retry
    else {
        panic!("redelivered pull must complete: {retry:?}");
    };
    assert_eq!((applied, skipped), (0, 1));
    assert_eq!(
        pending_resolves, first_pending,
        "the Skipped arm must reconstruct the persisted pending resolve"
    );
}

#[test]
fn relay_hydration_failure_mid_page_leaves_no_cursor_and_applies_nothing() {
    let (_scratch, _path, mut engine) = store();
    seed_identity(&mut engine);
    seed_replication_version(&mut engine, "main", "main");
    let normal = envelope(
        "hydrate-order-normal-peer",
        0,
        "chat.reaction.set",
        reaction_payload("added", "💧", 20, "hydrate-order-author"),
    );
    let missing_sha = dohc_engine_storage::hex_sha256(b"missing relay hydration");
    let missing = version_create_with_shipped_snapshots(
        "hydrate-order-missing-peer",
        "hydrate-order-version",
        vec![shipped_text_snapshot(
            "hydrate-order-object",
            "hydrate-order.md",
            &missing_sha,
        )],
    );
    let client = RelaySyncClient::new(PagedRelay::new([(
        0,
        PullResponse {
            ops: vec![normal, missing],
            next_cursor: 2,
            has_more: false,
        },
    )]));

    assert_eq!(
        client.pull_chat_workspace(&mut engine, "ws", &NoFaults, &NoLiveLeases),
        Err(RelayError::BlobMissing)
    );
    assert!(
        read_relay_cursor(&engine, "ws")
            .expect("read cursor")
            .is_none()
    );
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "hydrate-order-normal-peer").expect("normal ack"),
        -1,
        "hydration must complete before the first envelope applies"
    );
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "hydrate-order-missing-peer")
            .expect("missing ack"),
        -1
    );
}

#[test]
fn relay_hydrates_text_and_binary_rows_for_one_shared_digest() {
    // MUTATION: collapsing the digest to one BlobKind leaves one count at zero.
    let (_scratch, _path, mut engine) = store();
    seed_identity(&mut engine);
    seed_replication_version(&mut engine, "main", "main");
    // A canonical empty Yjs update is also valid UTF-8, so the same digest is
    // legal in both the text and binary stores.
    let bytes = vec![0_u8, 0_u8];
    let sha256 = dohc_engine_storage::hex_sha256(&bytes);
    let text = version_create_with_shipped_snapshots(
        "a-dual-kind-text-peer",
        "dual-kind-version",
        vec![json!({
            "objectId": "dual-kind-object",
            "objectCreatedAtMs": 1_100,
            "path": "dual-kind.md",
            "blobSha256": sha256,
            "byteLength": bytes.len(),
            "updatedAtMs": 1_200,
            "latestMomentId": "dual-kind-moment",
            "metadata": {"origin": "sync"}
        })],
    );
    let binary = envelope(
        "z-dual-kind-binary-peer",
        0,
        "ydoc.update",
        json!({
            "versionId": "dual-kind-version",
            "objectId": "dual-kind-object",
            "path": "dual-kind.md",
            "contentKind": "plaintext",
            "updateBlobSha256": sha256,
            "isBaseState": true
        }),
    );
    let mut relay = PagedRelay::new([(
        0,
        PullResponse {
            ops: vec![text, binary],
            next_cursor: 2,
            has_more: false,
        },
    )]);
    relay.blobs.insert(sha256.clone(), bytes);
    let client = RelaySyncClient::new(relay);

    let outcome = client.pull_chat_workspace(&mut engine, "ws", &NoFaults, &NoLiveLeases);
    assert!(
        matches!(outcome, Ok(SyncPassOutcome::Complete { .. })),
        "dual-kind hydration pass must complete: {outcome:?}"
    );
    let rows = engine
        .read_with(|conn| {
            Ok::<_, rusqlite::Error>((
                conn.query_row(
                    "SELECT COUNT(*) FROM blobs WHERE sha256=?1",
                    [&sha256],
                    |row| row.get::<_, i64>(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*) FROM binary_blobs WHERE sha256=?1",
                    [&sha256],
                    |row| row.get::<_, i64>(0),
                )?,
            ))
        })
        .expect("dual-kind blob rows");
    assert_eq!(
        rows,
        (1, 1),
        "one digest referenced by both kinds must hydrate both physical stores"
    );
}

#[test]
fn pull_blob_existence_probe_does_not_read_and_rehash_present_content() {
    let (_scratch, _path, mut engine) = store();
    seed_identity(&mut engine);
    seed_replication_version(&mut engine, "main", "main");
    let text = "already local";
    let sha256 = dohc_engine_storage::hex_sha256(text.as_bytes());
    engine
        .read_with(|conn| {
            conn.execute(
                "INSERT INTO blobs (sha256,byte_length,text) VALUES (?1,?2,?3)",
                params![sha256, text.len() as i64, text],
            )?;
            Ok::<_, rusqlite::Error>(())
        })
        .expect("seed local blob");
    let op = version_create_with_shipped_snapshots(
        "present-blob-peer",
        "present-blob-version",
        vec![shipped_text_snapshot(
            "present-blob-object",
            "present.md",
            &sha256,
        )],
    );
    let client = RelaySyncClient::new(PagedRelay::new([(
        0,
        PullResponse {
            ops: vec![op],
            next_cursor: 1,
            has_more: false,
        },
    )]));
    let _ = crate::relay::take_local_blob_bytes_call_count();
    assert!(matches!(
        client.pull_chat_workspace(&mut engine, "ws", &NoFaults, &NoLiveLeases),
        Ok(SyncPassOutcome::Complete { .. })
    ));
    assert_eq!(
        crate::relay::take_local_blob_bytes_call_count(),
        0,
        "MUTATION: using the blob reader as an existence probe reads and hashes present content"
    );
}

#[test]
fn relay_multi_page_pull_reports_conflicts_opened() {
    let (_scratch, _path, mut engine) = store();
    seed_identity(&mut engine);
    seed_replication_version(&mut engine, "main", "main");
    let normal = envelope(
        "multi-page-before-conflict-peer",
        0,
        "chat.reaction.set",
        reaction_payload("added", "⚔️", 20, "conflict-author"),
    );
    let side = |path: &str| {
        json!({
            "exists": false,
            "path": path,
            "contentKind": "text"
        })
    };
    let conflict = envelope(
        "multi-page-conflict-peer",
        0,
        "conflict.open",
        json!({
            "id": "multi-page-open-conflict",
            "workspaceId": "ws",
            "path": "doc.md",
            "targetVersionId": "main",
            "sourceVersionId": "peer",
            "createdAtMs": 2_000,
            "updatedAtMs": 2_000,
            "base": side("doc.md"),
            "current": side("doc.md"),
            "incoming": side("doc.md"),
            "status": "open",
            "chosenFrom": "current",
            "metadata": {"origin": "sync"}
        }),
    );
    let client = RelaySyncClient::new(PagedRelay::new([
        (
            0,
            PullResponse {
                ops: vec![normal],
                next_cursor: 1,
                has_more: true,
            },
        ),
        (
            1,
            PullResponse {
                ops: vec![conflict],
                next_cursor: 2,
                has_more: false,
            },
        ),
    ]));

    let outcome = client
        .pull_chat_workspace(&mut engine, "ws", &NoFaults, &NoLiveLeases)
        .expect("multi-page conflict pull");
    let SyncPassOutcome::Complete {
        fetched,
        applied,
        conflicts_opened,
        ..
    } = outcome
    else {
        panic!("multi-page conflict pull must complete: {outcome:?}");
    };
    assert_eq!((fetched, applied, conflicts_opened), (2, 2, 1));
}

#[test]
fn relay_pull_reports_conflicts_opened_by_a_divergent_moment_append() {
    let (_scratch, _path, mut engine) = store();
    seed_identity(&mut engine);
    seed_replication_version(&mut engine, "main", "main");
    let local_sha = dohc_engine_storage::hex_sha256(b"local");
    let base_sha = dohc_engine_storage::hex_sha256(b"base");
    let incoming_sha = dohc_engine_storage::hex_sha256(b"incoming");
    engine
        .read_with(|conn| {
            for (sha, text) in [
                (&local_sha, "local"),
                (&base_sha, "base"),
                (&incoming_sha, "incoming"),
            ] {
                conn.execute(
                    "INSERT INTO blobs (sha256,byte_length,text) VALUES (?1,?2,?3)",
                    params![sha, text.len() as i64, text],
                )?;
            }
            Ok::<_, rusqlite::Error>(())
        })
        .expect("hydrate moment blobs");
    let local = envelope(
        "local-moment-peer",
        0,
        "moment.append",
        json!({
            "momentId": "local-head",
            "versionId": "main",
            "objectId": "object",
            "objectCreatedAtMs": 1,
            "path": "doc.md",
            "recordedAtMs": 1_000,
            "operation": "write",
            "payloadBeforeBlobSha256": null,
            "payloadBeforePath": null,
            "payloadAfterBlobSha256": local_sha,
            "payloadAfterPath": "doc.md",
            "metadata": {"origin": "sync"},
            "beforePresent": "absent"
        }),
    );
    let divergent = envelope(
        "divergent-moment-peer",
        0,
        "moment.append",
        json!({
            "momentId": "incoming-head",
            "versionId": "main",
            "objectId": "object",
            "objectCreatedAtMs": 1,
            "path": "doc.md",
            "recordedAtMs": 2_000,
            "operation": "write",
            "payloadBeforeBlobSha256": base_sha,
            "payloadBeforePath": "doc.md",
            "payloadAfterBlobSha256": incoming_sha,
            "payloadAfterPath": "doc.md",
            "metadata": {"origin": "sync"},
            "beforePresent": "present",
            "beforeObjectId": "object",
            "beforeVersionId": "main",
            "beforePath": "doc.md",
            "beforeBlobSha256": base_sha,
            "beforeUpdatedAtMs": 500,
            "beforeLatestMomentId": "remote-base",
            "beforeMetadata": {"origin": "sync"}
        }),
    );
    let client = RelaySyncClient::new(FakeRelay {
        pushes: Mutex::new(0),
        pull: Mutex::new(Some(PullResponse {
            ops: vec![local, divergent],
            next_cursor: 2,
            has_more: false,
        })),
    });

    let outcome = client
        .pull_chat_workspace(&mut engine, "ws", &NoFaults, &NoLiveLeases)
        .expect("pull");
    let SyncPassOutcome::Complete {
        applied,
        conflicts_opened,
        ..
    } = outcome
    else {
        panic!("pull must complete: {outcome:?}");
    };
    assert_eq!(applied, 2);
    assert_eq!(
        conflicts_opened, 1,
        "discarding the routed moment result hides the newly opened conflict"
    );
}

#[test]
fn persisted_relay_and_share_cursors_never_regress_within_the_same_stream() {
    let (_scratch, _path, mut engine) = store();
    let relay = |cursor| RelayCursor {
        cursor,
        replication_epoch: "epoch".to_owned(),
        stream_identity: "stream".to_owned(),
        refusal_report_id: None,
    };
    assert!(matches!(
        commit_relay_cursor(&mut engine, "ws", &relay(10), &NoFaults),
        Ok(TxnOutcome::Committed(()))
    ));
    assert!(matches!(
        commit_relay_cursor(&mut engine, "ws", &relay(4), &NoFaults),
        Ok(TxnOutcome::Committed(()))
    ));
    assert_eq!(
        read_relay_cursor(&engine, "ws")
            .expect("read relay cursor")
            .expect("relay cursor")
            .cursor,
        10
    );
    let share = |cursor| ShareCursor {
        kind: CursorKind::ShareView,
        share_id: "share".to_owned(),
        cursor,
    };
    assert!(matches!(
        commit_share_cursor(&mut engine, "ws", &share(10), &NoFaults),
        Ok(TxnOutcome::Committed(()))
    ));
    assert!(matches!(
        commit_share_cursor(&mut engine, "ws", &share(4), &NoFaults),
        Ok(TxnOutcome::Committed(()))
    ));
    assert_eq!(
        read_share_cursor(&engine, "ws", "share", CursorKind::ShareView)
            .expect("read share cursor"),
        10,
        "MUTATION: unconditional conflict updates let an older acknowledgement regress the cursor"
    );
}

#[test]
fn relay_hydration_failure_before_apply_retries_and_surfaces_pending_resolve() {
    let (_scratch, _path, mut engine) = store();
    seed_identity(&mut engine);
    seed_replication_version(&mut engine, "main", "main");
    let resolve = envelope(
        "retry-pending-peer",
        0,
        "conflict.resolve",
        json!({
            "conflictId": "missing-on-receiver",
            "status": "resolved",
            "chosenFrom": "incoming",
            "resolution": "applied-incoming",
            "updatedAtMs": 10,
            "path": "notes/retry.md"
        }),
    );
    let missing_sha = dohc_engine_storage::hex_sha256(b"hydrate before retry");
    let later = version_create_with_shipped_snapshots(
        "retry-later-peer",
        "retry-later-version",
        vec![shipped_text_snapshot(
            "retry-later-object",
            "retry-later.md",
            &missing_sha,
        )],
    );
    let client = RelaySyncClient::new(FakeRelay {
        pushes: Mutex::new(0),
        pull: Mutex::new(Some(PullResponse {
            ops: vec![resolve, later],
            next_cursor: 2,
            has_more: false,
        })),
    });

    assert_eq!(
        client.pull_chat_workspace(&mut engine, "ws", &NoFaults, &NoLiveLeases),
        Err(RelayError::BlobMissing)
    );
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "retry-pending-peer").expect("resolve ack"),
        -1,
        "whole-page hydration must finish before the deferred resolve applies"
    );
    assert!(
        read_relay_cursor(&engine, "ws")
            .expect("relay cursor")
            .is_none(),
        "the failed batch must remain retryable"
    );

    engine
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT INTO blobs (sha256,byte_length,text) VALUES (?1,20,'hydrate before retry')",
                [&missing_sha],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .expect("hydrate later envelope");

    let retry = client
        .pull_chat_workspace(&mut engine, "ws", &NoFaults, &NoLiveLeases)
        .expect("retry pull");
    let SyncPassOutcome::Complete {
        applied,
        skipped,
        pending_resolves,
        ..
    } = retry
    else {
        panic!("retry must complete: {retry:?}");
    };
    assert_eq!((applied, skipped), (2, 0));
    assert_eq!(
        pending_resolves,
        vec![PendingResolve {
            remote_conflict_id: "missing-on-receiver".to_owned(),
            local_conflict_id: None,
            path: Some("notes/retry.md".to_owned()),
            reason: PendingResolveReason::UnmatchedTarget,
        }],
        "the retry must reconstruct the already-acked pending decision"
    );
}

#[test]
fn relay_retry_surfaces_refusal_acked_before_later_error() {
    let (_scratch, _path, mut engine) = store();
    seed_identity(&mut engine);
    seed_replication_version(&mut engine, "main", "main");
    // A mutation-level invalid input: the channel timestamp guard runs inside
    // the savepoint, so this refuses-and-acks. (moment.append with an empty
    // payload is NOT usable here: since #243 implemented that applier, its
    // payload deserialization fails pre-savepoint and stays a hard error.)
    let refused = envelope(
        "retry-refusal-peer",
        0,
        "chat.channel.create",
        json!({
            "channelId": "retry-refusal-channel",
            "name": "Refused",
            "slug": "refused",
            "kind": "channel",
            "createdAtMs": -1
        }),
    );
    let mut later = version_create_with_shipped_snapshots(
        "retry-refusal-later-peer",
        "retry-refusal-later-version",
        Vec::new(),
    );
    later.recorded_at_ms = refused.recorded_at_ms + 1;
    engine
        .write_with(&NoFaults, |tx| {
            tx.execute_batch(
                "CREATE TRIGGER inject_retry_refusal_later_failure \
                 BEFORE INSERT ON versions \
                 WHEN NEW.version_id='retry-refusal-later-version' \
                 BEGIN SELECT RAISE(ABORT, 'injected later apply failure'); END",
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .expect("install later apply failure");
    let client = RelaySyncClient::new(FakeRelay {
        pushes: Mutex::new(0),
        pull: Mutex::new(Some(PullResponse {
            ops: vec![refused, later],
            next_cursor: 2,
            has_more: false,
        })),
    });

    assert!(matches!(
        client.pull_chat_workspace(&mut engine, "ws", &NoFaults, &NoLiveLeases),
        Err(RelayError::Local(_))
    ));
    let persisted: i64 = engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM replication_pending_refusals \
                 WHERE workspace_id='ws' AND origin_id='retry-refusal-peer' AND origin_seq=0",
                [],
                |row| row.get(0),
            )
            .map_err(SyncError::corrupt)
        })
        .expect("persisted refusal count");
    assert_eq!(
        persisted, 1,
        "MUTATION: the refusal must persist before the later hard failure"
    );
    assert!(
        read_relay_cursor(&engine, "ws")
            .expect("relay cursor")
            .is_none()
    );

    engine
        .write_with(&NoFaults, |tx| {
            tx.execute_batch("DROP TRIGGER inject_retry_refusal_later_failure")
                .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .expect("clear later apply failure");

    let retry = client
        .pull_chat_workspace(&mut engine, "ws", &NoFaults, &NoLiveLeases)
        .expect("retry pull");
    let SyncPassOutcome::Complete {
        applied,
        refused: refused_count,
        skipped,
        refusals,
        ..
    } = retry
    else {
        panic!("retry must complete: {retry:?}");
    };
    assert_eq!((applied, refused_count, skipped), (1, 0, 1));
    assert_eq!(
        refusals,
        vec![ReplicationRefusal {
            workspace_id: "ws".to_owned(),
            origin_id: "retry-refusal-peer".to_owned(),
            origin_seq: 0,
            op_kind: "chat.channel.create".to_owned(),
            reason: RefusalReason::InvalidInput {
                reason: "chat channel timestamp is invalid".to_owned(),
            },
        }],
        "MUTATION: the Skipped path must reconstruct the persisted refusal"
    );
}

#[test]
fn relay_retry_surfaces_drain_refusal_from_an_earlier_cursor_page() {
    let (_scratch, _path, mut engine) = store();
    seed_identity(&mut engine);
    seed_replication_version(&mut engine, "main", "main");
    let (base_bytes, invalid_bytes) = clock_collision_pair();
    let base_sha = engine.put_binary_blob(&base_bytes).expect("base blob");
    let invalid_sha = engine
        .put_binary_blob(&invalid_bytes)
        .expect("pre-base update blob");
    let deferred = envelope(
        "prior-page-deferred-peer",
        0,
        "ydoc.update",
        json!({
            "versionId": "main",
            "objectId": "object-prior-page-drain",
            "path": "notes/prior-page-drain.md",
            "contentKind": "plaintext",
            "updateBlobSha256": invalid_sha,
            "isBaseState": false
        }),
    );
    assert!(matches!(
        apply_ydoc_envelope(&mut engine, &deferred, &NoFaults, &NoLiveLeases),
        Ok(ApplyOutcome::Applied(YdocApplyResult {
            deferred: true,
            reason: Some("ydoc-lineage-absent")
        }))
    ));

    let base = envelope(
        "current-page-base-peer",
        0,
        "ydoc.update",
        json!({
            "versionId": "main",
            "objectId": "object-prior-page-drain",
            "path": "notes/prior-page-drain.md",
            "contentKind": "plaintext",
            "updateBlobSha256": base_sha,
            "isBaseState": true
        }),
    );
    let mut later = version_create_with_shipped_snapshots(
        "current-page-later-peer",
        "current-page-later-version",
        Vec::new(),
    );
    later.recorded_at_ms = base.recorded_at_ms + 1;
    engine
        .write_with(&NoFaults, |tx| {
            tx.execute_batch(
                "CREATE TRIGGER inject_current_page_later_failure \
                 BEFORE INSERT ON versions \
                 WHEN NEW.version_id='current-page-later-version' \
                 BEGIN SELECT RAISE(ABORT, 'injected later apply failure'); END",
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .expect("install later apply failure");
    let client = RelaySyncClient::new(FakeRelay {
        pushes: Mutex::new(0),
        pull: Mutex::new(Some(PullResponse {
            ops: vec![base, later],
            next_cursor: 2,
            has_more: false,
        })),
    });

    assert!(matches!(
        client.pull_chat_workspace(&mut engine, "ws", &NoFaults, &NoLiveLeases),
        Err(RelayError::Local(_))
    ));
    assert!(
        read_relay_cursor(&engine, "ws")
            .expect("relay cursor")
            .is_none()
    );
    engine
        .write_with(&NoFaults, |tx| {
            tx.execute_batch("DROP TRIGGER inject_current_page_later_failure")
                .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .expect("clear later apply failure");

    let retry = client
        .pull_chat_workspace(&mut engine, "ws", &NoFaults, &NoLiveLeases)
        .expect("retry pull");
    let SyncPassOutcome::Complete {
        applied,
        refused,
        skipped,
        refusals,
        ..
    } = retry
    else {
        panic!("retry must complete: {retry:?}");
    };
    assert_eq!((applied, refused, skipped), (1, 0, 1));
    assert_eq!(
        refusals,
        vec![ReplicationRefusal {
            workspace_id: "ws".to_owned(),
            origin_id: "prior-page-deferred-peer".to_owned(),
            origin_seq: 0,
            op_kind: "ydoc.update".to_owned(),
            reason: RefusalReason::InvalidInput {
                reason: "parked ydoc.update could not be applied".to_owned(),
            },
        }],
        "MUTATION: reading refusals only for retried page coordinates loses the drain disposition"
    );
}

/// The pending-resolve reason vocabulary is written three times: the Rust
/// enum→string map, the string→enum parse, and the DDL CHECK constraint. If
/// they ever drift, `persist_pending_resolve` hits the CHECK, the envelope
/// rolls back unacked, and the pull wedges permanently on a resolve that used
/// to succeed — so every variant must round-trip through all three.
#[test]
fn every_pending_resolve_reason_round_trips_through_persist_and_read() {
    use crate::conflict_apply::{PendingResolveReason, persist_pending_resolve};

    let (_scratch, _path, mut engine) = store();
    let reasons = [
        PendingResolveReason::PathChange,
        PendingResolveReason::Merged,
        PendingResolveReason::StaleHead,
        PendingResolveReason::BinaryUnhydrated,
        PendingResolveReason::BinaryApplyFailed,
        PendingResolveReason::TextApplyRejected,
        PendingResolveReason::UnmatchedTarget,
    ];
    for (seq, reason) in reasons.into_iter().enumerate() {
        let op = envelope(
            "roundtrip-peer",
            seq as i64,
            "conflict.resolve",
            json!({ "conflictId": format!("c-{seq}") }),
        );
        let pending = PendingResolve {
            remote_conflict_id: format!("c-{seq}"),
            local_conflict_id: None,
            path: Some(format!("notes/{seq}.md")),
            reason,
        };
        engine
            .write_with(&NoFaults, |tx| {
                tx.execute(
                    "INSERT INTO replication_log \
                     (workspace_id, origin_id, origin_seq, op_kind, payload_json, recorded_at_ms, imported) \
                     VALUES (?1, ?2, ?3, 'conflict.resolve', '{}', 0, 1)",
                    params![op.workspace_id, op.origin_id, op.origin_seq],
                )
                .map_err(SyncError::persist)?;
                persist_pending_resolve(tx, &op, &pending)
            })
            .unwrap_or_else(|error| {
                panic!("persist must satisfy the DDL CHECK for {reason:?}: {error}")
            });
        let read = crate::conflict_apply::read_replayed_pending_resolve(&engine, &op)
            .expect("read back")
            .unwrap_or_else(|| panic!("a persisted decision must parse back for {reason:?}"));
        assert_eq!(read, pending, "round-trip must be lossless for {reason:?}");
    }
}

/// Persisted pending-resolve decisions exist only so a failed pull's retry can
/// re-surface them. Once the caller commits the pull cursor the stream never
/// replays those coordinates, so the rows are dead — and without the sweep in
/// `commit_relay_cursor` every deferred resolve leaves a row forever.
#[test]
fn committed_pull_cursor_clears_persisted_pending_resolves() {
    let (_scratch, _path, mut engine) = store();
    seed_identity(&mut engine);
    seed_replication_version(&mut engine, "main", "main");
    let resolve = envelope(
        "cursor-clear-peer",
        0,
        "conflict.resolve",
        json!({
            "conflictId": "missing-on-receiver",
            "status": "resolved",
            "chosenFrom": "incoming",
            "resolution": "applied-incoming",
            "updatedAtMs": 10,
            "path": "notes/cursor-clear.md"
        }),
    );
    let client = RelaySyncClient::new(FakeRelay {
        pushes: Mutex::new(0),
        pull: Mutex::new(Some(PullResponse {
            ops: vec![resolve],
            next_cursor: 1,
            has_more: false,
        })),
    });

    let outcome = client
        .pull_chat_workspace(&mut engine, "ws", &NoFaults, &NoLiveLeases)
        .expect("pull");
    let SyncPassOutcome::Complete {
        pending_cursor: Some(pending_cursor),
        ..
    } = outcome
    else {
        panic!("pull must complete with a cursor: {outcome:?}");
    };

    let persisted = |engine: &EngineStore| -> i64 {
        engine
            .read_with(|conn| {
                conn.query_row(
                    "SELECT COUNT(*) FROM replication_pending_resolves WHERE workspace_id='ws'",
                    [],
                    |row| row.get(0),
                )
                .map_err(SyncError::corrupt)
            })
            .expect("count pending resolves")
    };
    assert_eq!(persisted(&engine), 1, "the deferred decision is persisted");

    client
        .commit_pull_cursor(&mut engine, "ws", &pending_cursor, &NoFaults)
        .expect("commit cursor");
    assert_eq!(
        persisted(&engine),
        0,
        "a committed cursor makes retry reconstruction unreachable, so the rows must go"
    );
}

#[test]
fn committed_pull_cursor_clears_persisted_refusals() {
    let (_scratch, _path, mut engine) = store();
    seed_identity(&mut engine);
    let client = RelaySyncClient::new(FakeRelay {
        pushes: Mutex::new(0),
        pull: Mutex::new(Some(PullResponse {
            ops: vec![envelope(
                "cursor-clear-refusal-peer",
                0,
                "chat.channel.create",
                json!({
                    "channelId": "cursor-clear-refusal-channel",
                    "name": "Refused",
                    "slug": "refused",
                    "kind": "channel",
                    "createdAtMs": -1
                }),
            )],
            next_cursor: 1,
            has_more: false,
        })),
    });

    let outcome = client
        .pull_chat_workspace(&mut engine, "ws", &NoFaults, &NoLiveLeases)
        .expect("pull");
    let SyncPassOutcome::Complete {
        pending_cursor: Some(pending_cursor),
        ..
    } = outcome
    else {
        panic!("pull must complete with a cursor: {outcome:?}");
    };
    let persisted = |engine: &EngineStore| -> i64 {
        engine
            .read_with(|conn| {
                conn.query_row(
                    "SELECT COUNT(*) FROM replication_pending_refusals WHERE workspace_id='ws'",
                    [],
                    |row| row.get(0),
                )
                .map_err(SyncError::corrupt)
            })
            .expect("count pending refusals")
    };
    assert_eq!(persisted(&engine), 1, "the refusal is persisted");

    client
        .commit_pull_cursor(&mut engine, "ws", &pending_cursor, &NoFaults)
        .expect("commit cursor");
    assert_eq!(
        persisted(&engine),
        0,
        "MUTATION: cursor commit must sweep persisted refusal reports"
    );
}

#[test]
fn cursor_commit_preserves_an_unread_refusal_created_by_a_later_ydoc_drain() {
    let (_scratch, _path, mut engine) = store();
    seed_identity(&mut engine);
    seed_replication_version(&mut engine, "main", "main");
    let (base_bytes, invalid_bytes) = clock_collision_pair();
    let base_sha = engine.put_binary_blob(&base_bytes).expect("base blob");
    let invalid_sha = engine
        .put_binary_blob(&invalid_bytes)
        .expect("deferred blob");
    let deferred = envelope(
        "post-pull-drain-peer",
        0,
        "ydoc.update",
        json!({
            "versionId": "main",
            "objectId": "object-post-pull-drain",
            "path": "notes/post-pull-drain.md",
            "contentKind": "plaintext",
            "updateBlobSha256": invalid_sha,
            "isBaseState": false
        }),
    );
    assert!(matches!(
        apply_ydoc_envelope(&mut engine, &deferred, &NoFaults, &NoLiveLeases),
        Ok(ApplyOutcome::Applied(YdocApplyResult {
            deferred: true,
            ..
        }))
    ));

    let first_client = RelaySyncClient::new(FakeRelay {
        pushes: Mutex::new(0),
        pull: Mutex::new(Some(PullResponse {
            ops: vec![envelope(
                "first-report-peer",
                0,
                "chat.channel.create",
                json!({
                    "channelId": "first-report-channel",
                    "name": "Refused",
                    "slug": "refused",
                    "kind": "channel",
                    "createdAtMs": -1
                }),
            )],
            next_cursor: 1,
            has_more: false,
        })),
    });
    let first = first_client
        .pull_chat_workspace(&mut engine, "ws", &NoFaults, &NoLiveLeases)
        .expect("first pull");
    let SyncPassOutcome::Complete {
        pending_cursor: Some(first_cursor),
        refusals: first_refusals,
        ..
    } = first
    else {
        panic!("first pull must complete: {first:?}");
    };
    assert_eq!(first_refusals.len(), 1);
    assert!(
        first_cursor.refusal_report_id.is_some(),
        "a surfaced refusal must be owned by this pending cursor"
    );

    // This models open/resync/close draining after pull returns. Its structured
    // result is deliberately dropped by those runtime calls, so persistence is
    // the only path by which the next pull can surface the refusal.
    let base = envelope(
        "post-pull-base-peer",
        0,
        "ydoc.update",
        json!({
            "versionId": "main",
            "objectId": "object-post-pull-drain",
            "path": "notes/post-pull-drain.md",
            "contentKind": "plaintext",
            "updateBlobSha256": base_sha,
            "isBaseState": true
        }),
    );
    let _ignored_drain_result = apply_ydoc_envelope(&mut engine, &base, &NoFaults, &NoLiveLeases)
        .expect("base triggers drain refusal");
    let pending_before_commit: Vec<(String, Option<String>)> = engine
        .read_with(|conn| {
            let mut stmt = conn.prepare(
                "SELECT origin_id,report_id FROM replication_pending_refusals \
                 WHERE workspace_id='ws' ORDER BY origin_id",
            )?;
            stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
                .collect()
        })
        .expect("pending refusals");
    assert_eq!(pending_before_commit.len(), 2);
    assert!(
        pending_before_commit
            .iter()
            .any(|(origin, report)| origin == "post-pull-drain-peer" && report.is_none()),
        "a drain after pull must remain unowned by the earlier cursor"
    );

    first_client
        .commit_pull_cursor(&mut engine, "ws", &first_cursor, &NoFaults)
        .expect("commit first cursor");
    let survivors: Vec<(String, Option<String>)> = engine
        .read_with(|conn| {
            let mut stmt = conn.prepare(
                "SELECT origin_id,report_id FROM replication_pending_refusals \
                 WHERE workspace_id='ws' ORDER BY origin_id",
            )?;
            stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
                .collect()
        })
        .expect("surviving refusals");
    assert_eq!(
        survivors,
        vec![("post-pull-drain-peer".to_owned(), None)],
        "MUTATION: a workspace-wide cursor sweep destroys this unread drain refusal"
    );

    let second_client = RelaySyncClient::new(FakeRelay {
        pushes: Mutex::new(0),
        pull: Mutex::new(Some(PullResponse {
            ops: Vec::new(),
            next_cursor: 2,
            has_more: false,
        })),
    });
    let second = second_client
        .pull_chat_workspace(&mut engine, "ws", &NoFaults, &NoLiveLeases)
        .expect("next pull surfaces drain refusal");
    let SyncPassOutcome::Complete {
        pending_cursor: Some(second_cursor),
        refusals,
        ..
    } = second
    else {
        panic!("second pull must complete: {second:?}");
    };
    assert_eq!(
        refusals,
        vec![ReplicationRefusal {
            workspace_id: "ws".to_owned(),
            origin_id: "post-pull-drain-peer".to_owned(),
            origin_seq: 0,
            op_kind: "ydoc.update".to_owned(),
            reason: RefusalReason::InvalidInput {
                reason: "parked ydoc.update could not be applied".to_owned(),
            },
        }],
        "the next pull is the explicit reader for non-pull drain refusals"
    );
    second_client
        .commit_pull_cursor(&mut engine, "ws", &second_cursor, &NoFaults)
        .expect("commit second cursor");
    let remaining: i64 = engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM replication_pending_refusals WHERE workspace_id='ws'",
                [],
                |row| row.get(0),
            )
        })
        .expect("remaining refusals");
    assert_eq!(
        remaining, 0,
        "a refusal clears only after the cursor that actually surfaced it commits"
    );
}

#[test]
fn relay_claim_does_not_consume_a_direct_rpc_refusal() {
    let (_scratch, _path, mut engine) = store();
    let direct = envelope("direct-conflict-peer", 0, "conflict.open", json!({}));
    assert!(matches!(
        apply_conflict_envelope(&mut engine, &direct, &NoFaults),
        Ok(ApplyOutcome::Refused(_))
    ));
    retain_refusal_for_direct_retry(&mut engine, &direct, &NoFaults)
        .expect("protect direct refusal");

    let (claimed, report_id) = crate::apply::claim_pending_refusals(&mut engine, "ws", &NoFaults)
        .expect("unrelated relay claim");
    assert!(
        claimed.is_empty() && report_id.is_none(),
        "MUTATION: claiming every workspace row steals the direct RPC retry disposition"
    );
    let cursor = RelayCursor {
        cursor: 0,
        replication_epoch: "epoch".to_owned(),
        stream_identity: "stream".to_owned(),
        refusal_report_id: report_id,
    };
    commit_relay_cursor(&mut engine, "ws", &cursor, &NoFaults).expect("cursor commit");
    let replayed = read_replayed_refusal(&engine, &direct)
        .expect("read direct refusal")
        .expect("direct refusal survives");
    assert_eq!(
        replayed.reason,
        RefusalReason::InvalidInput {
            reason: "conflict.open payload is malformed".to_owned()
        }
    );
}

#[test]
fn relay_cursor_serializes_numeric_position_into_the_shipped_text_column() {
    let (_scratch, _path, mut engine) = store();
    let cursor = RelayCursor {
        cursor: 42,
        replication_epoch: "epoch-1".to_owned(),
        stream_identity: "stream-1".to_owned(),
        refusal_report_id: None,
    };
    assert!(matches!(
        commit_relay_cursor(&mut engine, "ws", &cursor, &NoFaults),
        Ok(TxnOutcome::Committed(()))
    ));
    let stored = engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT typeof(cursor), cursor FROM sync_relay_cursors WHERE workspace_id='ws'",
                [],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .map_err(SyncError::corrupt)
        })
        .expect("stored cursor");
    assert_eq!(stored, ("text".to_owned(), "42".to_owned()));
    assert_eq!(
        read_relay_cursor(&engine, "ws").expect("parsed cursor"),
        Some(cursor)
    );

    engine
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "UPDATE sync_relay_cursors SET cursor='not-a-number' WHERE workspace_id='ws'",
                [],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .expect("poison cursor");
    assert!(matches!(
        read_relay_cursor(&engine, "ws"),
        Err(SyncError::InvalidInput {
            reason: "persisted relay cursor is invalid"
        })
    ));
}

/// The router must hand back the applier's STRUCTURED result. A deferred
/// mirrored resolve is acked (the relay cursor advances past it), so a router
/// that flattens it into a plain applied count destroys the only record that
/// the peer's decision still needs handling.
#[test]
fn router_preserves_a_deferred_conflict_resolve_instead_of_flattening_it() {
    let (_scratch, _path, mut engine) = store();
    seed_replication_version(&mut engine, "main", "main");
    let resolve = envelope(
        "router-pending-peer",
        0,
        "conflict.resolve",
        json!({
            "conflictId": "no-such-conflict",
            "status": "resolved",
            "chosenFrom": "incoming",
            "resolution": "applied-incoming",
            "updatedAtMs": 3_000,
            "path": "notes/vanished.md"
        }),
    );

    let outcome = apply_replication_envelope(&mut engine, &resolve, &NoFaults, &NoLiveLeases)
        .expect("routed resolve");
    let ApplyOutcome::Applied(routed) = outcome else {
        panic!("resolve must apply: {outcome:?}");
    };
    assert_eq!(
        routed.pending_resolve(),
        Some(&PendingResolve {
            remote_conflict_id: "no-such-conflict".to_owned(),
            local_conflict_id: None,
            path: Some("notes/vanished.md".to_owned()),
            reason: PendingResolveReason::UnmatchedTarget,
        })
    );
    assert_eq!(
        routed.conflict.as_ref().map(ConflictApplyResult::deferred),
        Some(true)
    );
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "router-pending-peer").expect("ack"),
        0,
        "the envelope is acked, so the pending resolve exists only in the result"
    );
}

#[test]
fn router_counts_only_newly_inserted_replicated_open_conflicts() {
    let (_scratch, _path, mut engine) = store();
    seed_replication_version(&mut engine, "main", "main");
    let side = |path: &str| {
        json!({
            "exists": false,
            "path": path,
            "contentKind": "text"
        })
    };
    let payload = json!({
        "id": "router-open-conflict",
        "workspaceId": "ws",
        "path": "doc.md",
        "targetVersionId": "main",
        "sourceVersionId": "peer",
        "createdAtMs": 2_000,
        "updatedAtMs": 2_000,
        "base": side("doc.md"),
        "current": side("doc.md"),
        "incoming": side("doc.md"),
        "status": "open",
        "chosenFrom": "current",
        "metadata": {"origin": "sync"}
    });

    let first = envelope("router-open-a", 0, "conflict.open", payload.clone());
    let ApplyOutcome::Applied(first) =
        apply_replication_envelope(&mut engine, &first, &NoFaults, &NoLiveLeases)
            .expect("first routed open")
    else {
        panic!("first conflict.open did not apply");
    };
    assert_eq!(
        first.conflict.as_ref().and_then(|row| row.inserted),
        Some(true)
    );
    assert_eq!(first.conflicts_opened, 1);

    let duplicate = envelope("router-open-b", 0, "conflict.open", payload);
    let ApplyOutcome::Applied(duplicate) =
        apply_replication_envelope(&mut engine, &duplicate, &NoFaults, &NoLiveLeases)
            .expect("idempotent routed open")
    else {
        panic!("duplicate conflict.open did not apply");
    };
    assert_eq!(
        duplicate.conflict.as_ref().and_then(|row| row.inserted),
        Some(false)
    );
    // MUTATION: flattening the structured result yields 0 for the first
    // assertion; hardcoding every conflict.open as one breaks this assertion.
    assert_eq!(duplicate.conflicts_opened, 0);
}

#[test]
fn malformed_moment_append_router_refuses_and_acks() {
    let (_scratch, _path, mut engine) = store();
    let operation = envelope("moment-peer", 0, "moment.append", json!({}));
    assert!(matches!(
        apply_replication_envelope(&mut engine, &operation, &NoFaults, &NoLiveLeases),
        Ok(ApplyOutcome::Refused(ReplicationRefusal {
            reason: RefusalReason::InvalidInput { ref reason },
            ..
        })) if reason == "moment.append payload is malformed"
    ));
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "moment-peer").expect("ack"),
        0
    );
}

#[test]
fn refused_op_acks_and_the_next_same_origin_op_applies() {
    let (_scratch, _path, mut engine) = store();
    let refused = envelope(
        "progress-peer",
        0,
        "chat.decision.set",
        decision_payload("open", i64::MAX, None),
    );
    let outcome = apply_replication_envelope(&mut engine, &refused, &NoFaults, &NoLiveLeases);
    assert!(matches!(
        outcome,
        Ok(ApplyOutcome::Refused(ReplicationRefusal {
            reason: RefusalReason::InvalidInput { .. },
            ..
        }))
    ));

    let next = envelope("progress-peer", 1, "workspace.init", json!({}));
    assert!(matches!(
        apply_replication_envelope(&mut engine, &next, &NoFaults, &NoLiveLeases),
        Ok(ApplyOutcome::Applied(_))
    ));
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "progress-peer").expect("ack"),
        1
    );
}

#[test]
fn malformed_ydoc_op_is_refused_without_wedging_its_origin() {
    let (_scratch, _path, mut engine) = store();
    let malformed = envelope("ydoc-refusal-peer", 0, "ydoc.update", json!({}));
    assert!(matches!(
        apply_replication_envelope(&mut engine, &malformed, &NoFaults, &NoLiveLeases),
        Ok(ApplyOutcome::Refused(ReplicationRefusal {
            reason: RefusalReason::InvalidInput {
                ref reason
            },
            ..
        })) if reason == "ydoc.update payload is malformed"
    ));

    let next = envelope("ydoc-refusal-peer", 1, "workspace.init", json!({}));
    assert!(matches!(
        apply_replication_envelope(&mut engine, &next, &NoFaults, &NoLiveLeases),
        Ok(ApplyOutcome::Applied(_))
    ));
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "ydoc-refusal-peer").expect("ack"),
        1
    );
}

#[test]
fn relay_pull_surfaces_refusal_reason_to_the_caller() {
    let (_scratch, _path, mut engine) = store();
    seed_identity(&mut engine);
    let client = RelaySyncClient::new(FakeRelay {
        pushes: Mutex::new(0),
        pull: Mutex::new(Some(PullResponse {
            ops: vec![envelope(
                "reason-peer",
                0,
                "chat.channel.create",
                json!({
                    "channelId": "reason-channel",
                    "name": "Refused",
                    "slug": "refused",
                    "kind": "channel",
                    "createdAtMs": -1
                }),
            )],
            next_cursor: 1,
            has_more: false,
        })),
    });

    let outcome = client
        .pull_chat_workspace(&mut engine, "ws", &NoFaults, &NoLiveLeases)
        .expect("a refused operation must not fail the pull");
    let SyncPassOutcome::Complete {
        applied,
        refused,
        skipped,
        pending_cursor,
        refusals,
        ..
    } = outcome
    else {
        panic!("refused pull must complete: {outcome:?}");
    };
    assert_eq!((applied, refused, skipped), (0, 1, 0));
    assert!(pending_cursor.is_some());
    assert_eq!(
        refusals,
        vec![ReplicationRefusal {
            workspace_id: "ws".to_owned(),
            origin_id: "reason-peer".to_owned(),
            origin_seq: 0,
            op_kind: "chat.channel.create".to_owned(),
            reason: RefusalReason::InvalidInput {
                reason: "chat channel timestamp is invalid".to_owned(),
            },
        }]
    );
    assert_eq!(refusals[0].reason.code(), "invalid-input");
    assert_eq!(
        refusals[0].reason.message(),
        "chat channel timestamp is invalid"
    );
}

#[test]
fn coordinate_divergence_still_stops_a_pass_after_an_acked_refusal() {
    let (_scratch, _path, mut engine) = store();
    seed_identity(&mut engine);
    let first = envelope(
        "divergent-refusal-peer",
        0,
        "chat.channel.create",
        json!({
            "channelId": "divergent-refusal-channel",
            "name": "Refused",
            "slug": "refused",
            "kind": "channel",
            "createdAtMs": -1
        }),
    );
    let mut divergent = first.clone();
    divergent.payload = json!({"tampered": true});
    let client = RelaySyncClient::new(FakeRelay {
        pushes: Mutex::new(0),
        pull: Mutex::new(Some(PullResponse {
            ops: vec![
                first,
                divergent,
                envelope("divergent-refusal-peer", 1, "workspace.init", json!({})),
            ],
            next_cursor: 3,
            has_more: false,
        })),
    });

    assert!(matches!(
        client.pull_chat_workspace(&mut engine, "ws", &NoFaults, &NoLiveLeases),
        Err(RelayError::Local(_))
    ));
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "divergent-refusal-peer").expect("ack"),
        0,
        "the first refusal is durable, but divergence must stop the pass"
    );
    let initialized: bool = engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM versioned_workspaces WHERE workspace_id='ws')",
                [],
                |row| row.get(0),
            )
            .map_err(dohc_engine_storage::StorageError::corrupt_public)
        })
        .expect("workspace state");
    assert!(!initialized, "the op after divergence must not apply");
}

#[test]
fn structurally_invalid_envelope_remains_unrecorded_and_unacked() {
    let (_scratch, _path, mut engine) = store();
    let mut invalid = envelope("structural-peer", 0, "moment.append", json!({}));
    invalid.origin_seq = MAX_WIRE_INTEGER + 1;

    assert!(matches!(
        apply_replication_envelope(&mut engine, &invalid, &NoFaults, &NoLiveLeases),
        Err(SyncError::InvalidInput {
            reason: "origin_seq is outside the wire integer range"
        })
    ));
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "structural-peer").expect("ack"),
        -1
    );
    let recorded: i64 = engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM replication_log \
                 WHERE workspace_id='ws' AND origin_id='structural-peer'",
                [],
                |row| row.get(0),
            )
            .map_err(dohc_engine_storage::StorageError::corrupt_public)
        })
        .expect("journal rows");
    assert_eq!(recorded, 0);
}

#[test]
fn redelivered_refusal_is_recorded_once_and_skipped() {
    let (_scratch, _path, mut engine) = store();
    let refused = envelope(
        "refusal-replay-peer",
        0,
        "chat.channel.create",
        json!({
            "channelId": "refusal-replay-channel",
            "name": "Refused",
            "slug": "refused",
            "kind": "channel",
            "createdAtMs": -1
        }),
    );
    let first = apply_replication_envelope(&mut engine, &refused, &NoFaults, &NoLiveLeases);
    assert!(matches!(
        first,
        Ok(ApplyOutcome::Refused(ReplicationRefusal {
            reason: RefusalReason::InvalidInput { .. },
            ..
        }))
    ));
    assert!(matches!(
        apply_replication_envelope(&mut engine, &refused, &NoFaults, &NoLiveLeases),
        Ok(ApplyOutcome::Skipped)
    ));
    let recorded: i64 = engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM replication_log \
                 WHERE workspace_id='ws' AND origin_id='refusal-replay-peer' AND origin_seq=0",
                [],
                |row| row.get(0),
            )
            .map_err(dohc_engine_storage::StorageError::corrupt_public)
        })
        .expect("refusal journal row");
    assert_eq!(recorded, 1);
}

#[test]
fn every_refusal_reason_round_trips_through_persist_and_read() {
    let (_scratch, _path, mut engine) = store();
    for operation in [
        envelope("roundtrip-invalid-refusal", 0, "ydoc.update", json!({})),
        envelope(
            "roundtrip-chat-refusal",
            0,
            "chat.channel.create",
            json!({
                "channelId": "roundtrip-channel",
                "name": "Refused",
                "slug": "refused",
                "kind": "channel",
                "createdAtMs": -1
            }),
        ),
    ] {
        let ApplyOutcome::Refused(expected) =
            apply_replication_envelope(&mut engine, &operation, &NoFaults, &NoLiveLeases)
                .expect("refusal")
        else {
            panic!("operation must be refused");
        };
        assert_eq!(
            crate::apply::read_replayed_refusal(&engine, &operation)
                .expect("read refusal")
                .expect("persisted refusal"),
            expected,
            "the owned refusal message and variant must round-trip losslessly"
        );
        let exhaustively_matched_message = match &expected.reason {
            RefusalReason::InvalidInput { reason } => reason,
        };
        assert_eq!(
            exhaustively_matched_message,
            expected.reason.message(),
            "MUTATION: the exhaustive guard must execute for every persisted refusal variant"
        );
    }
}

#[test]
fn docs_refusal_contract_does_not_name_retired_variants() {
    let contract = include_str!("../../../docs/superpowers/plans/rust-engine/RPC_GAP.md");
    assert!(
        !contract.contains("MomentAppendNotImplemented"),
        "MUTATION: the executable refusal contract must not advertise a removed disposition"
    );
}

#[test]
fn local_corruption_constructor_has_one_shared_definition() {
    let sources = [
        include_str!("error.rs"),
        include_str!("apply.rs"),
        include_str!("conflict_apply.rs"),
        include_str!("ydoc_apply.rs"),
    ];
    let constructors = sources
        .iter()
        .map(|source| {
            source
                .matches(&["std::io::Error::other", "(reason)"].concat())
                .count()
        })
        .sum::<usize>();
    assert_eq!(
        constructors, 1,
        "MUTATION: local-corruption construction must stay centralized in error.rs"
    );
    assert!(sources[0].contains("pub(crate) fn local_corruption"));
}

#[test]
fn clock_collision_fixtures_are_shared() {
    let source = include_str!("tests.rs");
    assert_eq!(
        source.matches(&["fn decode", "_hex("].concat()).count(),
        1,
        "MUTATION: hex decoding belongs in one shared fixture helper"
    );
    assert_eq!(
        source
            .matches(&["fn clock_collision", "_pair("].concat())
            .count(),
        1,
        "MUTATION: the opaque collision payload pair belongs in one named fixture"
    );
    assert_eq!(
        source.matches(&["let decode", "_hex = |"].concat()).count(),
        0,
        "MUTATION: per-test decoder closures duplicate an opaque fixture"
    );
}

#[test]
fn accepted_content_kind_test_has_no_unknown_kind_tail() {
    let source = include_str!("tests.rs");
    let accepted = source
        .split_once("fn version_create_shipped_snapshot_accepts_only_oracle_content_kinds()")
        .expect("accepted-kind test")
        .1
        .split_once("fn version_create_unknown_content_kind_is_refused_and_acked()")
        .expect("dedicated unknown-kind test")
        .0;
    assert!(
        !accepted.contains("version.create shipped snapshot content kind is invalid"),
        "MUTATION: the accepted-kind test must not duplicate the dedicated refusal test"
    );
}

#[test]
fn corrupt_secret_fixture_asserts_equal_lengths() {
    let source = include_str!("tests.rs");
    let fixture = source
        .split_once("fn secret_put_corrupt_local_ciphertext_blob_is_hard_and_unacked()")
        .expect("corrupt-secret test")
        .1
        .split_once("#[test]")
        .expect("next test")
        .0;
    assert!(
        fixture.contains("honest_ciphertext.len(),")
            && fixture.contains("corrupt_ciphertext.len(),"),
        "MUTATION: the fixture must assert that only ciphertext content changed"
    );
}

fn share_view_binary_write_op(seq: i64, path: &str, sha256: &str) -> ShareReplicationEnvelope {
    ShareReplicationEnvelope {
        origin_id: "peer".to_owned(),
        origin_seq: seq,
        op_kind: "moment.append".to_owned(),
        payload: json!({
            "operation": "write",
            "path": path,
            "payloadAfterPath": path,
            "payloadAfterBlobSha256": sha256,
            "payloadAfterContentKind": "binary"
        }),
        recorded_at_ms: 10 + seq,
    }
}

fn share_view_binary_pull(
    engine: &mut EngineStore,
    path: &str,
    bytes: Vec<u8>,
) -> Result<ShareViewPullOutcome, RelayError> {
    let sha256 = dohc_engine_storage::hex_sha256(&bytes);
    let client = RelaySyncClient::new(
        PagedShareRelay::new(
            [],
            [(
                0,
                ShareViewResponse {
                    ops: vec![share_view_binary_write_op(0, path, &sha256)],
                    next_cursor: 1,
                    has_more: false,
                },
            )],
        )
        .with_view_blobs([(sha256, bytes)]),
    );
    // The write must sit INSIDE the grant, or the op is skipped and this helper
    // stops exercising the ceiling it exists to test. Granting the exact path
    // keeps that true whatever path a caller passes.
    client.pull_share_view(engine, "ws", "share", &tracked_grant([path]), &NoFaults)
}

/// A shared write reaches the store through `write_binary`, which never passes
/// the bytes through `hydrate_blob_content`. Nothing on that path applied the
/// binary ceiling, so the only floor left was the generic 64 MiB blob store —
/// a share could persist a binary an ordinary capture refuses.
///
/// MUTATION: delete the ceiling check in `replay_share_write` and the over-cap
/// half lands the blob; narrow it to the text ceiling and the at-cap half stops
/// refusing.
#[test]
fn an_oversized_shared_binary_is_refused_before_it_reaches_the_store() {
    let (_scratch, _path, mut engine) = store();
    seed_replication_version(&mut engine, "main", "main");
    let (constraint, limit_bytes) = blob_ceiling(BlobKind::Binary);

    let over_cap = vec![7u8; limit_bytes + 1];
    let over_cap_sha = dohc_engine_storage::hex_sha256(&over_cap);
    assert_eq!(
        share_view_binary_pull(&mut engine, "docs/over-cap.bin", over_cap)
            .expect_err("an over-cap shared binary is refused"),
        RelayError::BlobTooLarge {
            constraint,
            limit_bytes,
            observed: ObservedBytes::Exact(limit_bytes + 1),
        }
    );
    assert!(
        !engine
            .has_binary_blob(&over_cap_sha)
            .expect("binary blob presence"),
        "an over-cap shared binary must not persist under the 64 MiB store bound"
    );

    // The ceiling must not reject work the store accepts everywhere else.
    let at_cap = vec![7u8; limit_bytes];
    let at_cap_sha = dohc_engine_storage::hex_sha256(&at_cap);
    let outcome = share_view_binary_pull(&mut engine, "docs/at-cap.bin", at_cap)
        .expect("an at-cap shared binary replays");
    assert_eq!((outcome.fetched, outcome.applied), (1, 1));
    assert!(
        engine
            .has_binary_blob(&at_cap_sha)
            .expect("binary blob presence")
    );
}

/// The binary half of the same chokepoint. The text half is pinned above; this
/// one was not, so the ceiling could be deleted for `BlobKind::Binary` alone
/// and every other test stayed green.
///
/// MUTATION: skip the ceiling for binary content in `hydrate_blob_content` and
/// the over-cap half commits instead of refusing. The ceiling's own value is
/// pinned below, so widening it moves no expectation with it.
#[test]
fn binary_blob_over_the_binary_ceiling_is_refused_at_ingest() {
    let (_scratch, _path, mut engine) = store();
    let (constraint, limit_bytes) = blob_ceiling(BlobKind::Binary);
    // Pinned, not derived. Every other expectation here reads the ceiling from
    // `blob_ceiling`, so without this a widened ceiling would carry the whole
    // test with it and still report green.
    assert_eq!(
        (constraint, limit_bytes),
        ("MAX_CAPTURE_BINARY_FILE_BYTES", 5 * 1024 * 1024),
        "binary ingest is the tighter ceiling this test exists to hold"
    );

    let at_cap = vec![3u8; limit_bytes];
    let accepted = BlobHydration {
        sha256: dohc_engine_storage::hex_sha256(&at_cap),
        content: BlobContent::Binary(at_cap),
    };
    assert_eq!(
        hydrate_blob_content(&mut engine, &accepted, &NoFaults).expect("at-cap binary hydrates"),
        TxnOutcome::Committed(())
    );
    assert!(
        engine
            .has_binary_blob(&accepted.sha256)
            .expect("binary blob presence")
    );

    let over_cap = vec![3u8; limit_bytes + 1];
    let refused = BlobHydration {
        sha256: dohc_engine_storage::hex_sha256(&over_cap),
        content: BlobContent::Binary(over_cap),
    };
    let error = hydrate_blob_content(&mut engine, &refused, &NoFaults)
        .expect_err("over-cap binary is refused");
    assert!(
        matches!(
            error,
            SyncError::BlobTooLarge {
                constraint: named,
                limit_bytes: limit,
                observed_bytes,
            } if named == constraint && limit == limit_bytes && observed_bytes == limit_bytes + 1
        ),
        "unexpected refusal: {error:?}"
    );
    assert_eq!(
        error.to_string(),
        format!(
            "blob exceeds MAX_CAPTURE_BINARY_FILE_BYTES: limit {limit_bytes} bytes, observed {} bytes",
            limit_bytes + 1
        )
    );
    assert!(
        !engine
            .has_binary_blob(&refused.sha256)
            .expect("binary blob presence"),
        "an over-cap binary must not persist"
    );
}
