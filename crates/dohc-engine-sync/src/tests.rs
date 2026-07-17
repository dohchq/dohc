use std::sync::Mutex;

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
