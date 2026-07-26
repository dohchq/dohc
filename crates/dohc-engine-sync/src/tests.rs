use std::collections::BTreeMap;
use std::sync::Mutex;

use dohc_engine_domain::chats::{CHAT_THREAD_HEADER_MESSAGE_ID, upsert_chat_search_index_row};
use dohc_engine_domain::{
    AGENT_CHANNEL_NAME, AGENT_CHANNEL_WIRE_ID, BookmarkMode, BookmarkTargetKind, ChatActorKind,
    ChatChannelKind, ChatReactionState, CreateFileThread, FollowState, FollowTargetKind,
    GENERAL_CHANNEL_WIRE_ID, LinkedChatStore, MAX_SECRET_FILE_BYTES, ResolveDecision,
    SECRET_IV_BYTES, SECRET_TAG_BYTES, SaveBookmark, SetFollow, SetReaction, StartChannelThread,
    VersionedTextStore, attachment_id_for, channel_slug_for_name,
};
use dohc_engine_storage::{EngineStore, FaultPoint, NoFaults, TxnOutcome};
use dohc_engine_testkit::{ScratchDir, ScriptedFaults};
use rusqlite::{OptionalExtension, params};
use serde_json::json;
use sha2::{Digest, Sha256};

use crate::*;

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
fn imported_decision_refuses_unsafe_at_ms_without_row_or_ack() {
    let (_scratch, _path, mut engine) = store();
    let operation = envelope(
        "unsafe-decision-time",
        0,
        "chat.decision.set",
        decision_payload("open", i64::MAX, None),
    );

    // MUTATION: dropping the persisted-safe atMs bound journals a decision that
    // the cross-engine read contract cannot represent.
    assert!(matches!(
        apply_chat_envelope(&mut engine, &operation, &NoFaults),
        Err(SyncError::InvalidInput { .. })
    ));
    let row_count: i64 = engine
        .read_with(|conn| {
            conn.query_row("SELECT COUNT(*) FROM chat_decisions", [], |row| row.get(0))
                .map_err(dohc_engine_storage::StorageError::corrupt_public)
        })
        .expect("decision row count");
    assert_eq!(row_count, 0);
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "unsafe-decision-time").expect("ack"),
        -1
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
fn imported_reaction_refuses_unsafe_at_ms_without_row_or_ack() {
    let (_scratch, _path, mut engine) = store();
    let operation = envelope(
        "unsafe-reaction-time",
        0,
        "chat.reaction.set",
        reaction_payload("added", "👍", i64::MAX, "Ada"),
    );

    // MUTATION: dropping the persisted-safe atMs bound journals a reaction that
    // subsequently makes reaction reads state-corrupt.
    assert!(matches!(
        apply_chat_envelope(&mut engine, &operation, &NoFaults),
        Err(SyncError::InvalidInput { .. })
    ));
    let row_count: i64 = engine
        .read_with(|conn| {
            conn.query_row("SELECT COUNT(*) FROM chat_reactions", [], |row| row.get(0))
                .map_err(dohc_engine_storage::StorageError::corrupt_public)
        })
        .expect("reaction row count");
    assert_eq!(row_count, 0);
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "unsafe-reaction-time").expect("ack"),
        -1
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
        assert!(matches!(result, Err(SyncError::InvalidInput { .. })));
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
fn imported_channel_refuses_non_timestamp_created_at_ms_without_row_or_ack() {
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
        // though ChannelCreate.createdAtMs is a replicated timestamp.
        assert!(matches!(
            apply_chat_envelope(&mut engine, &operation, &NoFaults),
            Err(SyncError::InvalidInput { .. })
        ));
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
            -1
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
    assert!(matches!(
        apply_chat_envelope(&mut engine, &operation, &NoFaults),
        Err(SyncError::InvalidInput { .. })
    ));
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "invalid-thread").expect("ack"),
        -1
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
    assert!(matches!(
        apply_chat_envelope(&mut engine, &operation, &NoFaults),
        Err(SyncError::InvalidInput { .. })
    ));
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "forged-agent-slug").expect("ack"),
        -1
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

    assert!(matches!(
        apply_chat_envelope(&mut engine, &follow, &NoFaults),
        Err(SyncError::InvalidInput { .. })
    ));
    assert_eq!(pending_chat_coordinate_count(&engine), 0);
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "dm-follow-origin").expect("DM follow ack"),
        -1
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
        assert!(matches!(
            apply_chat_envelope(&mut engine, &operation, &NoFaults),
            Err(SyncError::InvalidInput { .. })
        ));
        assert_eq!(
            read_replication_acked_seq(&engine, "ws", "invalid-message").expect("ack"),
            2
        );
    }
}

#[test]
fn imported_message_refuses_unsafe_created_at_ms_without_row_or_ack() {
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
    assert!(matches!(
        apply_chat_envelope(&mut engine, &operation, &NoFaults),
        Err(SyncError::InvalidInput { .. })
    ));
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
        2
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
    assert!(matches!(
        apply_chat_envelope(&mut engine, &oversized, &NoFaults),
        Err(SyncError::InvalidInput { .. })
    ));
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
        3
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
    assert!(matches!(result, Err(SyncError::InvalidInput { .. })));
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "read-peer").expect("ack"),
        0
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
    assert!(matches!(result, Err(SyncError::InvalidInput { .. })));
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
        assert!(matches!(
            apply_chat_envelope(&mut engine, &operation, &NoFaults),
            Err(SyncError::InvalidInput { .. })
        ));
        let channel_count: i64 = engine
            .read_with(|conn| {
                conn.query_row("SELECT COUNT(*) FROM chat_channels", [], |row| row.get(0))
            })
            .expect("channel count");
        assert_eq!(channel_count, 0);
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
        assert!(matches!(
            apply_chat_envelope(&mut engine, &operation, &NoFaults),
            Err(SyncError::InvalidInput { .. })
        ));
        let channel_count: i64 = engine
            .read_with(|conn| {
                conn.query_row("SELECT COUNT(*) FROM chat_channels", [], |row| row.get(0))
            })
            .expect("channel count");
        assert_eq!(channel_count, 0);
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
    assert!(matches!(
        apply_chat_envelope(&mut engine, &overlong, &NoFaults),
        Err(SyncError::InvalidInput { .. })
    ));
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
    assert!(matches!(
        apply_chat_envelope(&mut engine, &malformed_slug, &NoFaults),
        Err(SyncError::InvalidInput { .. })
    ));
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

    assert!(matches!(
        apply_chat_envelope(&mut engine, &attachment, &NoFaults),
        Err(SyncError::InvalidInput { .. })
    ));
    assert_eq!(pending_chat_coordinate_count(&engine), 0);
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
        assert!(matches!(
            apply_chat_envelope(&mut engine, &operation, &NoFaults),
            Err(SyncError::InvalidInput { .. })
        ));
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
        assert!(matches!(
            apply_chat_envelope(&mut engine, &operation, &NoFaults),
            Err(SyncError::InvalidInput { .. })
        ));
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
        assert!(matches!(
            apply_chat_envelope(&mut engine, &operation, &NoFaults),
            Err(SyncError::InvalidInput { .. })
        ));
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
        assert!(matches!(
            apply_chat_envelope(&mut engine, &operation, &NoFaults),
            Err(SyncError::InvalidInput { .. })
        ));
    }
}

#[test]
fn imported_follow_refuses_unsafe_at_ms_without_row_or_ack() {
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
    assert!(matches!(
        apply_chat_envelope(&mut engine, &operation, &NoFaults),
        Err(SyncError::InvalidInput { .. })
    ));
    let row_count: i64 = engine
        .read_with(|conn| {
            conn.query_row("SELECT COUNT(*) FROM chat_follows", [], |row| row.get(0))
                .map_err(dohc_engine_storage::StorageError::corrupt_public)
        })
        .expect("follow row count");
    assert_eq!(row_count, 0);
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "unsafe-follow-time").expect("ack"),
        -1
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
        assert!(matches!(
            apply_chat_envelope(&mut engine, &operation, &NoFaults),
            Err(SyncError::InvalidInput { .. })
        ));
    }
}

#[test]
fn imported_feed_read_refuses_unsafe_timestamps_without_row_or_ack() {
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
        assert!(matches!(
            apply_chat_envelope(&mut engine, &operation, &NoFaults),
            Err(SyncError::InvalidInput { .. })
        ));
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
            -1
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
    assert!(matches!(result, Err(SyncError::InvalidInput { .. })));
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "hostile-attachment").expect("ack"),
        -1
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
            matches!(result, Err(SyncError::InvalidInput { .. })),
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
        path_prefix: Some("shared/docs".to_owned()),
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
        path_prefix: None,
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
        path_prefix: None,
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
        path_prefix: None,
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
        path_prefix: None,
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
        path_prefix: None,
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
}

#[test]
fn share_view_secondary_path_out_of_boundary_is_rejected() {
    let (_scratch, _path, mut engine) = store();
    let boundary = ShareBoundary {
        share_id: "share-view".to_owned(),
        surface: ShareSurface::ShareView,
        channel_wire_id: None,
        path_prefix: Some("shared/docs".to_owned()),
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
    view_pulls: Mutex<Vec<(i64, usize)>>,
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
            view_pulls: Mutex::new(Vec::new()),
        }
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
        _req: SharedChannelRequest,
    ) -> Result<SharedChannelResponse, RelayError> {
        Err(RelayError::InvalidResponse)
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

    fn share_blob(&self, _req: ShareBlobRequest) -> Result<BlobDownloadResponse, RelayError> {
        Err(RelayError::InvalidResponse)
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
        "peer",
        0,
        "chat.channel.create",
        json!({"channelId":"c1","name":"My agent","slug":"my-agent","kind":"agent","createdAtMs":1,"wireId":"wire-not-agent"}),
    );
    assert!(matches!(
        apply_chat_envelope(&mut engine, &rogue_agent, &NoFaults),
        Err(SyncError::InvalidInput { .. })
    ));
    // A normal channel squatting the reserved name -> rejected (seq 0 still free;
    // the rejected op rolled back without advancing the ack).
    let name_squat = envelope(
        "peer",
        0,
        "chat.channel.create",
        json!({"channelId":"c2","name":"My agent","slug":"reserved-name","kind":"channel","createdAtMs":1}),
    );
    assert!(matches!(
        apply_chat_envelope(&mut engine, &name_squat, &NoFaults),
        Err(SyncError::InvalidInput { .. })
    ));
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
    assert_eq!(drained, 1, "the parked envelope must apply");
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
    assert_eq!(redrained, 0, "replaying the parked row is content-deduped");
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
    let mut malformed = shipped_text_snapshot("richdoc-object", "richdoc.md", &text_sha);
    malformed["contentKind"] = json!("richdoc");
    let operation = version_create_with_shipped_snapshots(
        "richdoc-kind-peer",
        "richdoc-kind-version",
        vec![malformed],
    );

    assert!(matches!(
        apply_replication_envelope(&mut engine, &operation, &NoFaults, &NoLiveLeases),
        Err(SyncError::InvalidInput {
            reason: "version.create shipped snapshot content kind is invalid"
        })
    ));
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "richdoc-kind-peer").expect("ack"),
        -1,
        "an unknown content kind must not be journaled or acknowledged"
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
        Err(SyncError::InvalidInput {
            reason: "version.create shipped snapshot paths must be unique"
        })
    ));
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "duplicate-path-peer").expect("ack"),
        -1
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
            Err(SyncError::InvalidInput {
                reason: "version.create shipped snapshot path must be tracked"
            })
        ));
        assert_eq!(
            read_replication_acked_seq(&engine, "ws", &origin).expect("ack"),
            -1,
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
        Err(SyncError::InvalidInput {
            reason: "version.create shipped snapshot path must be tracked"
        })
    ));
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "secret-snapshot-peer").expect("ack"),
        -1
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
        let operation = version_create_with_shipped_snapshots(
            &origin,
            &format!("shadow-alias-version-{index}"),
            vec![shipped_text_snapshot("shadow-object", path, &sha)],
        );

        assert!(
            matches!(
                apply_replication_envelope(&mut engine, &operation, &NoFaults, &NoLiveLeases),
                Err(SyncError::InvalidInput {
                    reason: "version.create shipped snapshot path must be canonical"
                })
            ),
            "{path}"
        );
        let persisted: i64 = engine
            .read_with(|conn| {
                conn.query_row(
                    "SELECT (SELECT COUNT(*) FROM path_aliases) + (SELECT COUNT(*) FROM snapshots)",
                    [],
                    |row| row.get(0),
                )
            })
            .expect("alias rows");
        assert_eq!(persisted, 0, "{path}");
        assert_eq!(
            read_replication_acked_seq(&engine, "ws", &origin).expect("ack"),
            -1,
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
        Err(SyncError::InvalidInput {
            reason: "version id belongs to another workspace"
        })
    ));
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "collision-peer").expect("ack"),
        -1
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
fn secret_version_fork_rejects_nonmatching_sealed_source_without_wipe_or_ack() {
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
        Err(SyncError::InvalidInput { .. })
    ));
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "poison-fork-peer").expect("ack"),
        -1
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
}

#[test]
fn secret_version_fork_rejects_subset_superset_and_duplicate_path_payloads() {
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
    let cases = [
        ("subset-fork-peer", vec![row("app/.env", 100, "source-tip")]),
        (
            "superset-fork-peer",
            vec![
                row("app/.env", 100, "source-tip"),
                row("config/prod.env", 101, "source-tip-2"),
                row("extra.env", 102, "extra-tip"),
            ],
        ),
        (
            "duplicate-fork-peer",
            vec![
                row("app/.env", 100, "source-tip"),
                row("app/.env", 100, "source-tip"),
            ],
        ),
    ];
    for (origin, rows) in cases {
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
        assert!(
            matches!(
                apply_replication_envelope(&mut engine, &operation, &NoFaults, &NoLiveLeases),
                Err(SyncError::InvalidInput {
                    reason: "secret fork payload does not match the local sealed source state"
                })
            ),
            "{origin}"
        );
        assert_eq!(
            read_replication_acked_seq(&engine, "ws", origin).expect("ack"),
            -1,
            "{origin}"
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
    assert!(matches!(
        refusal,
        Err(SyncError::InvalidInput {
            reason: "secret fork must carry at least one row"
        })
    ));
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "empty-fork-peer").expect("ack"),
        -1
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
        Err(SyncError::InvalidInput {
            reason: "secret ciphertext metadata is invalid"
        })
    ));
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "oversized-secret-peer").expect("ack"),
        -1
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
        Err(SyncError::InvalidInput {
            reason: "secret replication path must be canonical"
        })
    ));
    assert_eq!(
        paths,
        vec!["a/b.env"],
        "MUTATION: without the canonical guard, the raw wire spelling persists as a shadow row"
    );
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "noncanonical-secret-peer").expect("ack"),
        -1
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
        Err(SyncError::InvalidInput {
            reason: "replicated secret moment id collides with existing history"
        })
    ));
    assert_eq!(
        state,
        (0, "unrelated.env".to_owned()),
        "the collision must roll back the incoming tip and preserve the existing owner"
    );
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "collision-peer").expect("ack"),
        -1
    );
}

#[test]
fn secret_put_rejects_synthesized_moment_id_owned_by_plaintext_history() {
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
        Err(SyncError::InvalidInput {
            reason: "replicated secret moment id collides with existing history"
        })
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
        -1
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
fn central_router_recognizes_every_owned_kind_and_fails_unknown_closed() {
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
        Err(SyncError::InvalidInput { .. })
    ));
    let unknown = envelope("router-unknown", 0, "version.rename", json!({}));
    assert!(matches!(
        apply_replication_envelope(&mut engine, &unknown, &NoFaults, &NoLiveLeases),
        Err(SyncError::UnsupportedOperation)
    ));
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
        pending_cursor: Some(pending),
        ..
    } = first
    else {
        panic!("first pass must return its completed-page cursor: {first:?}");
    };
    assert_eq!(fetched, crate::model::MAX_PULL_OPS_PER_PASS);
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
        pending_cursor: Some(pending),
        ..
    } = first
    else {
        panic!("empty page prefix must complete: {first:?}");
    };
    assert_eq!(pending.cursor, resume_cursor);
    assert_eq!(
        client.transport().pulls.lock().expect("pull calls").len(),
        crate::model::MAX_PULL_PAGES_PER_PASS
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
        .pull_share_view(&mut engine, "ws", "share", "docs", &NoFaults)
        .expect("bounded share-view page");
    assert_eq!((first.fetched, first.pending_cursor.cursor), (0, 1));
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
        .pull_share_view(&mut engine, "ws", "share", "docs", &NoFaults)
        .expect("resume view page");
    assert_eq!(second.pending_cursor.cursor, 2);
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
    let bytes = b"shared".to_vec();
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
            "isBaseState": false
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

    let _ = client.pull_chat_workspace(&mut engine, "ws", &NoFaults, &NoLiveLeases);
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
fn relay_cursor_serializes_numeric_position_into_the_shipped_text_column() {
    let (_scratch, _path, mut engine) = store();
    let cursor = RelayCursor {
        cursor: 42,
        replication_epoch: "epoch-1".to_owned(),
        stream_identity: "stream-1".to_owned(),
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
fn malformed_moment_append_router_error_never_acks() {
    let (_scratch, _path, mut engine) = store();
    let operation = envelope("moment-peer", 0, "moment.append", json!({}));
    assert!(matches!(
        apply_replication_envelope(&mut engine, &operation, &NoFaults, &NoLiveLeases),
        Err(SyncError::InvalidInput { .. })
    ));
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "moment-peer").expect("ack"),
        -1
    );
}
