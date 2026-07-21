use std::sync::Mutex;

use dohc_engine_domain::{AGENT_CHANNEL_NAME, AGENT_CHANNEL_WIRE_ID, channel_slug_for_name};
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

struct AlwaysLive;

impl LeaseProbe for AlwaysLive {
    fn is_live(&self, _key: &dohc_engine_collab::DocKey) -> bool {
        true
    }
}

#[test]
fn leased_ydoc_envelope_acks_and_defers_without_mutating_the_ydoc_log() {
    let (_scratch, _path, mut engine) = store();
    let op = envelope(
        "peer",
        0,
        "ydoc.update",
        json!({
            "versionId": "main",
            "objectId": "object-1",
            "path": "notes/live.md",
            "contentKind": "plaintext",
            "updateBlobSha256": "not-read-while-live",
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
        .pull_chat_workspace(&mut engine, "ws", faults.as_ref())
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
        .pull_chat_workspace(&mut reopened, "ws", &NoFaults)
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
        client.pull_chat_workspace(&mut engine, "ws", &NoFaults),
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
    // apply_remote_update refuses NoMarker rather than conjuring one.
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
