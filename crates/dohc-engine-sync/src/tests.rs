use std::sync::Mutex;

use dohc_engine_domain::{
    AGENT_CHANNEL_NAME, AGENT_CHANNEL_WIRE_ID, BookmarkMode, BookmarkTargetKind, ChatActorKind,
    ChatReactionState, FollowState, FollowTargetKind, LinkedChatStore, ResolveDecision,
    SaveBookmark, SetFollow, SetReaction, attachment_id_for, channel_slug_for_name,
};
use dohc_engine_storage::{EngineStore, FaultPoint, NoFaults, TxnOutcome};
use dohc_engine_testkit::{ScratchDir, ScriptedFaults};
use rusqlite::params;
use serde_json::json;

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
fn reaction_import_accepts_negative_time_and_empty_display_name_and_preserves_lww_order() {
    let (_scratch, _path, mut engine) = store();
    let mut winner_payload = reaction_payload("added", "👍", -10, "Ada");
    winner_payload["authorDisplayName"] = json!("");
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
    // MUTATION: re-adding either imported-value rejection stalls the envelope;
    // replacing the LWW comparison lets the later-arriving older row win.
    assert_eq!(stored, ("added".to_owned(), String::new(), -10));
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
    let outcome =
        apply_ydoc_envelope(&mut engine, &op, &NoFaults, &AlwaysLive).expect("live lineage defers");
    assert_eq!(
        outcome,
        ApplyOutcome::Applied(YdocApplyResult {
            deferred: true,
            reason: Some("ydoc-session-live"),
        })
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
fn imported_channel_refuses_unsafe_created_at_ms_without_row_or_ack() {
    let (_scratch, _path, mut engine) = store();
    let operation = envelope(
        "unsafe-channel-time",
        0,
        "chat.channel.create",
        json!({
            "channelId": "unsafe-channel",
            "name": "Unsafe",
            "slug": "unsafe",
            "kind": "channel",
            "createdAtMs": i64::MAX
        }),
    );

    // MUTATION: dropping the persisted-safe createdAtMs bound journals a
    // channel that the typed client cannot decode.
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
        read_replication_acked_seq(&engine, "ws", "unsafe-channel-time").expect("ack"),
        -1
    );
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

#[test]
fn imported_verbatim_chat_rows_remain_readable_and_locally_mutable() {
    let (_scratch, _path, mut engine) = store();
    imported_chat_fixture(&mut engine, "verbatim");

    let mut reaction = reaction_payload("added", "👍", -10, "Ada");
    reaction["threadId"] = json!("thread-imported");
    reaction["messageId"] = json!("message-imported");
    reaction["authorDisplayName"] = json!("");
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

    // MUTATION: re-tighten any verbatim row mapper -> its corresponding read fails here.
    assert_eq!(
        (
            reactions[0].at_ms,
            reactions[0].author_display_name.as_str()
        ),
        (-10, "")
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
fn imported_message_append_applies_verbatim_without_a_body_cap() {
    // Oracle parity (linkedChatStore.ts:4442-4464): the replicated
    // chat.message.append validator checks body only for `length === 0` — it
    // does NOT cap body size (the 64 KiB cap lives solely in the local-mint
    // normalizeBody). Adding an import-path cap here would STALL an origin's
    // ack stream on a body the oracle accepts. Oversized bodies are fronted by
    // the DOP1 64 KiB per-string wire bound and both engines' mint caps.
    let (_scratch, _path, mut engine) = store();
    imported_chat_fixture(&mut engine, "large-message");
    let operation = envelope(
        "large-message",
        3,
        "chat.message.append",
        json!({
            "messageId": "large",
            "threadId": "thread-imported",
            "authorKind": "human",
            "authorDisplayName": "Ada",
            "body": format!("@indexed {}", "x".repeat(64 * 1024)),
            "createdAtMs": 30
        }),
    );
    let result = apply_chat_envelope(&mut engine, &operation, &NoFaults);
    let (messages, mentions): (i64, i64) = engine
        .read_with(|conn| {
            Ok::<_, rusqlite::Error>((
                conn.query_row(
                    "SELECT COUNT(*) FROM chat_messages WHERE message_id = 'large'",
                    [],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*) FROM chat_mentions WHERE message_id = 'large' AND handle = 'indexed'",
                    [],
                    |row| row.get(0),
                )?,
            ))
        })
        .expect("large persistence counts");
    // MUTATION: re-add an import-path body cap -> this oracle-legal op refuses
    // and wedges the origin's ack stream instead of applying+indexing.
    assert!(matches!(result, Ok(ApplyOutcome::Applied(()))));
    assert_eq!((messages, mentions), (1, 1));
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "large-message").expect("ack"),
        3
    );
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
        let accepted = req
            .ops
            .last()
            .map(|op| op.origin_seq)
            .ok_or(RelayError::InvalidResponse)?;
        Ok(PushResponse {
            accepted_through_seq: accepted,
        })
    }
    fn pull(&self, _req: PullRequest) -> Result<PullResponse, RelayError> {
        self.pull
            .lock()
            .expect("pull lock")
            .clone()
            .ok_or(RelayError::InvalidResponse)
    }
    fn recover_origin(&self, _req: RecoverRequest) -> Result<RecoverResponse, RelayError> {
        Err(RelayError::InvalidResponse)
    }
    fn probe(&self, _req: ProbeRequest) -> Result<ProbeResponse, RelayError> {
        Ok(ProbeResponse { has_content: false })
    }
    fn claim_workspace(&self, _req: ClaimRequest) -> Result<ClaimResponse, RelayError> {
        Ok(ClaimResponse)
    }
    fn upload_key_envelope(
        &self,
        _req: KeyEnvelopeRequest,
    ) -> Result<KeyEnvelopeResponse, RelayError> {
        Ok(KeyEnvelopeResponse {
            etag: "etag".to_owned(),
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
            next_cursor: "cursor-1".to_owned(),
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
            next_cursor: "cursor-1".to_owned(),
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

    let iv = STANDARD.encode([0u8; 12]);
    let tag = STANDARD.encode([0u8; 16]);
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
