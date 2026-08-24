//! Replication of `ydoc.update` ops into the durable lineage: applying a remote
//! peer's update idempotently, with echo suppression at the boundary.
//!
//! The spike proved the two CRDT guarantees this layer relies on: re-applying an
//! already-integrated update is a strict no-op on both engines, and Yjs
//! transaction origins are a LOCAL API construct absent from the wire — so echo
//! suppression is an adapter-layer concern, not a CRDT one. Here it is enforced
//! by (a) content-addressed dedup — an update blob already in the log is an O(1)
//! idempotent no-op — and (b) tagging a remote-applied update with its peer
//! origin and returning `emit_outbound = false`, so a remote update is journaled
//! into the durable lineage but NEVER re-emitted as our own outbound op.
//!
//! DEDUP SPAN: the content-addressed fast-path spans the UN-FOLDED update log.
//! Once an update is folded into a snapshot by compaction its row is pruned, so a
//! redelivery of already-folded bytes is re-appended as a fresh row — but this is
//! a CRDT NO-OP (re-applying an integrated update changes nothing; convergence is
//! preserved, proven by the spike), and the redundant row is re-folded at the
//! next compaction, so the log stays bounded. Durable cross-compaction dedup by a
//! per-peer applied cursor is R11b's replication-drain job (the `origin_seq`
//! carried on [`RemoteUpdate`] is that cursor's input).

use dohc_engine_storage::{put_binary_blob_with_sha, EngineStore, FaultInjector, TxnOutcome};
use rusqlite::Transaction;

use crate::durable::{
    append_row, blob_seq_in_log, load_for_replay_gate, maybe_compact, query_marker,
    validate_update_bytes, Regime,
};
use crate::error::CollabError;
use crate::limits::DEFAULT_COMPACTION_THRESHOLD;
use crate::DocKey;

/// Who produced an update — the actor tag journaled into `ydoc_updates`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UpdateOrigin {
    /// This node's live editor. The actor id is NULL in the log (local edits are
    /// the implicit self origin).
    Local,
    /// A replicating peer; carries the peer's stable origin id so the durable
    /// row records provenance and echo suppression can key off it.
    Remote { origin_id: String },
}

impl UpdateOrigin {
    /// The `actor_origin_id` value stored in the log.
    pub fn actor_id(&self) -> Option<&str> {
        match self {
            UpdateOrigin::Local => None,
            UpdateOrigin::Remote { origin_id } => Some(origin_id.as_str()),
        }
    }
}

/// A remote `ydoc.update` op received from a peer.
#[derive(Debug, Clone)]
pub struct RemoteUpdate {
    /// The peer's stable origin id (journaled as the actor + used for echo
    /// suppression / provenance).
    pub origin_id: String,
    /// The peer's op sequence for this origin — a monotone cursor the boundary
    /// carries for ordering/telemetry. Durable idempotency keys off the
    /// content-addressed blob, so an out-of-order or duplicated delivery of the
    /// same bytes still converges.
    pub origin_seq: i64,
    /// The Yjs v1 update bytes.
    pub bytes: Vec<u8>,
}

/// The outcome of applying a remote update.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReplicationApplyOutcome {
    /// The update was newly journaled into the durable lineage at `seq`.
    /// `emit_outbound` is ALWAYS false — a remote update is not echoed.
    Applied { seq: i64, emit_outbound: bool },
    /// The update bytes were already in the log (content-addressed dedup): an
    /// idempotent no-op that was NOT re-journaled and is NOT re-emitted.
    Deduped { seq: i64 },
}

/// Apply a remote `ydoc.update` op into a replicated durable lineage.
///
/// - **Validated first** (constraint 5): empty/oversized/truncated bytes are
///   rejected before any blob put or journal.
/// - **Idempotent**: a redelivered/echoed update whose bytes are already in the
///   log is an O(1) no-op ([`ReplicationApplyOutcome::Deduped`]).
/// - **Echo-suppressed**: a newly-applied remote update is journaled with the
///   peer's origin id and returns `emit_outbound = false` — never re-broadcast.
///
/// Applying the same update twice therefore converges (dedup + the CRDT no-op
/// the spike verified), and the durable lineage the next resume reconstructs
/// includes the remote edit.
pub fn apply_remote_update(
    store: &mut EngineStore,
    key: &DocKey,
    remote: &RemoteUpdate,
    faults: &dyn FaultInjector,
    now_ms: i64,
) -> Result<TxnOutcome<ReplicationApplyOutcome>, CollabError> {
    let outcome = store.write_with(faults, |tx| {
        apply_remote_update_in_transaction(tx, key, remote, now_ms)
    })?;
    // Self-bound the log: a genuinely-applied remote update folds the log once it
    // grows past the threshold (a replicated fold keeps a full-state snapshot,
    // never prunes — peers still bootstrap). A dedup/crash does nothing.
    if matches!(
        outcome,
        TxnOutcome::Committed(ReplicationApplyOutcome::Applied { .. })
    ) {
        let _ = maybe_compact(store, key, DEFAULT_COMPACTION_THRESHOLD, faults, now_ms)?;
    }
    Ok(outcome)
}

/// Transaction-composable form used by `dohc-engine-sync`: the Y.Doc lineage
/// mutation can share one commit with the imported replication coordinate and
/// peer ack. Callers outside that envelope should use [`apply_remote_update`],
/// which also runs the post-commit compaction check.
/// Per-origin FIFO does not order cross-origin dependencies, so missing-dependency
/// updates are durably parked; the parity gate rejects only proven divergence.
pub fn apply_remote_update_in_transaction(
    tx: &Transaction<'_>,
    key: &DocKey,
    remote: &RemoteUpdate,
    now_ms: i64,
) -> Result<ReplicationApplyOutcome, CollabError> {
    validate_update_bytes(&remote.bytes)?;
    if remote.origin_id.is_empty()
        || remote.origin_id.len() > dohc_engine_storage::MAX_IDENTIFIER_BYTES
    {
        return Err(CollabError::InvalidIdentifier {
            reason: "remote origin_id must be non-empty and bounded".to_owned(),
        });
    }
    let sha = crate::hex_sha256(&remote.bytes);
    let origin = UpdateOrigin::Remote {
        origin_id: remote.origin_id.clone(),
    };

    let marker = query_marker(tx, key)?.ok_or(CollabError::NoMarker)?;
    if marker.regime != Regime::Replicated {
        return Err(CollabError::InvalidIdentifier {
            reason: "remote update applied to a non-replicated lineage".to_owned(),
        });
    }
    // Content-addressed dedup BEFORE the replay-parity gate: a sha hit means
    // these exact bytes are already an admitted row of the un-folded log — they
    // passed the gate against the base they extended, and re-applying them is a
    // CRDT no-op. Re-gating a redelivery against today's NEWER base could only
    // spuriously refuse bytes that remain durable. Folded bytes (row pruned by
    // compaction) miss this probe and take the full gate below — the DEDUP SPAN
    // in the module doc.
    if let Some(existing) = blob_seq_in_log(tx, key, &sha)? {
        return Ok(ReplicationApplyOutcome::Deduped { seq: existing });
    }
    let base = load_for_replay_gate(tx, key)?;
    crate::validate_replay_parity(&base, &remote.bytes)?;
    put_binary_blob_with_sha(tx, &remote.bytes, &sha)?;
    let seq = append_row(tx, key, &sha, origin.actor_id(), now_ms)?;
    Ok(ReplicationApplyOutcome::Applied {
        seq,
        emit_outbound: false,
    })
}

// T5 (dedupe hoist): the content-addressed dedup runs BEFORE the replay-parity
// gate on both admission paths, and folded bytes still take the full gate — the
// DEDUP SPAN in the module doc. Unit tests, not integration tests, because the
// proof rides the gate's `cfg(test)` panic seam: while armed, ANY gate
// invocation fails closed, so an outcome other than that failure proves the
// path never reached the gate.
#[cfg(test)]
mod dedupe_hoist_tests {
    use dohc_engine_storage::{EngineStore, NoFaults, TxnOutcome};
    use dohc_test_scratch::ScratchDir;

    use super::*;
    use crate::durable::{
        claim_base, record_local_update, record_local_update_creating_marker, CompactOutcome,
    };
    use crate::replay_parity::PANIC_INJECT;
    use crate::ydoc::{ContentKind, Ydoc};

    /// Run `f` with the replay gate armed to fail closed on invocation.
    fn with_armed_gate<T>(f: impl FnOnce() -> T) -> T {
        PANIC_INJECT.with(|cell| cell.set(true));
        let result = f();
        PANIC_INJECT.with(|cell| cell.set(false));
        result
    }

    fn committed<T>(outcome: TxnOutcome<T>) -> T {
        match outcome {
            TxnOutcome::Committed(value) => value,
            TxnOutcome::Crashed { .. } => panic!("expected committed, got crashed"),
        }
    }

    fn fresh_store(tag: &str) -> (ScratchDir, EngineStore) {
        let dir = ScratchDir::new_named(tag).expect("scratch dir");
        let store = EngineStore::open(&dir.join("engine.db"), 1_000).expect("open store");
        (dir, store)
    }

    fn seeded_key(store: &mut EngineStore) -> DocKey {
        let key = DocKey::new("ws-1", "ver-1", "obj-1").expect("key");
        let sql_err = |e: rusqlite::Error| CollabError::Corrupt {
            reason: e.to_string(),
        };
        let outcome = store
            .write_with(&NoFaults, |tx| -> Result<(), CollabError> {
                tx.execute(
                    "INSERT INTO versioned_workspaces (workspace_id, main_version_id) \
                     VALUES (?1, ?2)",
                    rusqlite::params![key.workspace_id, key.version_id],
                )
                .map_err(sql_err)?;
                tx.execute(
                    "INSERT INTO file_objects (workspace_id, object_id, created_at_ms) \
                     VALUES (?1, ?2, 1000)",
                    rusqlite::params![key.workspace_id, key.object_id],
                )
                .map_err(sql_err)?;
                Ok(())
            })
            .expect("seed parent rows");
        assert!(matches!(outcome, TxnOutcome::Committed(())));
        key
    }

    fn update_rows(store: &EngineStore, key: &DocKey) -> i64 {
        store
            .read_with(|conn| -> Result<i64, CollabError> {
                conn.query_row(
                    "SELECT COUNT(*) FROM ydoc_updates \
                     WHERE workspace_id = ?1 AND version_id = ?2 AND object_id = ?3",
                    rusqlite::params![key.workspace_id, key.version_id, key.object_id],
                    |row| row.get(0),
                )
                .map_err(|e| CollabError::Corrupt {
                    reason: e.to_string(),
                })
            })
            .expect("count update rows")
    }

    /// A replicated lineage with one applied remote delta: (store guard, store,
    /// key, the delta as a redeliverable remote op, the delta's admitted seq).
    fn replicated_with_applied_delta(
        tag: &str,
    ) -> (ScratchDir, EngineStore, DocKey, RemoteUpdate, i64) {
        let (dir, mut store) = fresh_store(tag);
        let key = seeded_key(&mut store);
        let doc = Ydoc::wire();
        doc.plaintext_insert(0, "hello ");
        let base = doc.encode_full_state();
        let peer = Ydoc::wire();
        peer.apply(&base).expect("peer base");
        let delta = peer.plaintext_insert(6, "world");
        committed(
            claim_base(
                &mut store,
                &key,
                ContentKind::Plaintext,
                &base,
                &NoFaults,
                1_000,
            )
            .expect("claim base"),
        );
        let remote = RemoteUpdate {
            origin_id: "peer-A".to_owned(),
            origin_seq: 1,
            bytes: delta,
        };
        let seq = match committed(
            apply_remote_update(&mut store, &key, &remote, &NoFaults, 1_100).expect("apply"),
        ) {
            ReplicationApplyOutcome::Applied { seq, .. } => seq,
            ReplicationApplyOutcome::Deduped { .. } => panic!("first apply must land"),
        };
        (dir, store, key, remote, seq)
    }

    #[test]
    fn redelivered_in_log_remote_bytes_dedupe_without_the_gate() {
        let (_dir, mut store, key, remote, seq) =
            replicated_with_applied_delta("dedupe-hoist-remote");

        let again =
            with_armed_gate(|| apply_remote_update(&mut store, &key, &remote, &NoFaults, 1_200))
                .expect("an in-log redelivery must dedupe without invoking the gate");
        assert_eq!(
            committed(again),
            ReplicationApplyOutcome::Deduped { seq },
            "a redelivery acks the original coordinate"
        );
        assert_eq!(update_rows(&store, &key), 1, "no duplicate row");
    }

    #[test]
    fn duplicate_local_append_dedupes_without_the_gate() {
        let (_dir, mut store) = fresh_store("dedupe-hoist-local");
        let key = seeded_key(&mut store);
        let doc = Ydoc::wire();
        let update = doc.plaintext_insert(0, "hello ");

        let first = committed(
            record_local_update_creating_marker(
                &mut store,
                &key,
                None,
                ContentKind::Plaintext,
                crate::durable::Regime::LocalOnly,
                &update,
                None,
                &NoFaults,
                1_000,
            )
            .expect("first append"),
        );
        assert!(!first.deduped, "first append must land");

        let again =
            with_armed_gate(|| record_local_update(&mut store, &key, &update, &NoFaults, 1_100))
                .expect("a duplicate local append must dedupe without invoking the gate");
        let again = committed(again);
        assert_eq!(
            again,
            crate::durable::AppendOutcome {
                seq: first.seq,
                deduped: true,
                emit_outbound: false,
            },
            "duplicate append outcome unchanged by the hoist"
        );
        assert_eq!(update_rows(&store, &key), 1, "no duplicate row");
    }

    #[test]
    fn redelivered_folded_bytes_take_the_full_gate_and_reappend() {
        let (_dir, mut store, key, remote, _seq) =
            replicated_with_applied_delta("dedupe-hoist-folded");

        // Fold the applied delta into a snapshot: its log row is pruned, so the
        // redelivery below is OUTSIDE the dedup span.
        let folded =
            committed(maybe_compact(&mut store, &key, 1, &NoFaults, 1_300).expect("compact"));
        assert!(
            matches!(folded, CompactOutcome::Compacted { .. }),
            "the fold must fire: {folded:?}"
        );
        assert_eq!(update_rows(&store, &key), 0, "folded row pruned");

        // Armed gate: a folded redelivery MUST reach the gate, which the armed
        // seam turns into a fail-closed refusal.
        let refused =
            with_armed_gate(|| apply_remote_update(&mut store, &key, &remote, &NoFaults, 1_400))
                .expect_err("a folded redelivery must take the full gate");
        assert!(
            matches!(refused, CollabError::ReplayParityViolation { .. }),
            "expected the armed gate's fail-closed refusal: {refused:?}"
        );

        // Disarmed, the same redelivery passes the gate and re-appends as a
        // fresh row (a CRDT no-op; re-folded at the next compaction).
        let reapplied = committed(
            apply_remote_update(&mut store, &key, &remote, &NoFaults, 1_500).expect("re-append"),
        );
        assert!(
            matches!(
                reapplied,
                ReplicationApplyOutcome::Applied {
                    emit_outbound: false,
                    ..
                }
            ),
            "folded bytes re-append: {reapplied:?}"
        );
        assert_eq!(update_rows(&store, &key), 1, "re-appended as a fresh row");
    }
}
