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

use dohc_engine_storage::{put_binary_blob, EngineStore, FaultInjector, TxnOutcome};
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
            reason: "remote origin_id must be non-empty and bounded",
        });
    }
    let sha = crate::hex_sha256(&remote.bytes);
    let origin = UpdateOrigin::Remote {
        origin_id: remote.origin_id.clone(),
    };

    let marker = query_marker(tx, key)?.ok_or(CollabError::NoMarker)?;
    if marker.regime != Regime::Replicated {
        return Err(CollabError::InvalidIdentifier {
            reason: "remote update applied to a non-replicated lineage",
        });
    }
    let base = load_for_replay_gate(tx, key)?;
    crate::validate_replay_parity(&base, &remote.bytes)?;
    if let Some(existing) = blob_seq_in_log(tx, key, &sha)? {
        return Ok(ReplicationApplyOutcome::Deduped { seq: existing });
    }
    put_binary_blob(tx, &remote.bytes)?;
    let seq = append_row(tx, key, &sha, origin.actor_id(), now_ms)?;
    Ok(ReplicationApplyOutcome::Applied {
        seq,
        emit_outbound: false,
    })
}
