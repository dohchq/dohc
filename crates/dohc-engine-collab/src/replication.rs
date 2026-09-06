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
//! into the durable lineage but never re-emitted as our own outbound op.
//!
//! DEDUP SPAN: the content-addressed fast-path spans the UN-FOLDED update log.
//! Once an update is folded into a snapshot by compaction its row is pruned, so a
//! redelivery of already-folded bytes is re-appended as a fresh row — but this is
//! a CRDT NO-OP (re-applying an integrated update changes nothing; convergence is
//! preserved, proven by the spike), and the redundant row is re-folded at the
//! next compaction, so the log stays bounded. Durable cross-compaction dedup by a
//! per-peer applied cursor is R11b's replication-drain job (the `origin_seq`
//! carried on [`RemoteUpdate`] is that cursor's input).

use dohc_engine_storage::{EngineStore, FaultInjector, TxnOutcome};
use rusqlite::Transaction;

use crate::doc_cache::{GateBaseSource, RemoteAppendProbe, ServedGateBase};
use dohc_engine_domain::ChangeAttribution;

use crate::durable::{
    append_validated_and_index_update, blob_seq_in_log, load_for_replay_gate, maybe_compact,
    query_marker, validate_update_bytes, CompactOutcome, Regime,
};
use crate::error::CollabError;
use crate::limits::DEFAULT_COMPACTION_THRESHOLD;
use crate::ydoc::{ContentKind, Ydoc};
use crate::{DocKey, WriterDocCache};

/// Who produced an update — the actor tag journaled into `ydoc_updates`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UpdateOrigin {
    /// This node's live editor. The actor id is NULL in the log (local edits are
    /// the implicit self origin).
    Local,
    /// The actor attributed to an update received from a replicating peer.
    /// Older payloads fall back to the peer's stable origin id.
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
    /// `emit_outbound` is always false — a remote update is not echoed.
    Applied { seq: i64, emit_outbound: bool },
    /// The update bytes were already in the log (content-addressed dedup): an
    /// idempotent no-op that was not re-journaled and is not re-emitted.
    Deduped { seq: i64 },
}

/// One remote admission result plus the gate's isolated post-candidate doc for
/// projection in the same transaction. The projection doc is never a cache
/// adoption candidate or a source of durable lineage bytes.
pub struct RemoteApplyProjection {
    pub outcome: ReplicationApplyOutcome,
    pub doc: Ydoc,
    pub content_kind: ContentKind,
    /// What this apply did to a bound collection record (`None` for a dedup,
    /// an unbound document, or an apply that changed no field). The record
    /// events every device emits at apply time derive from this.
    pub record_facts: Option<dohc_engine_domain::CollectionRecordApplyFacts>,
}

fn remote_update_origin(
    remote: &RemoteUpdate,
    actor_origin_id: Option<&str>,
) -> Result<UpdateOrigin, CollabError> {
    let actor_origin_id = actor_origin_id.unwrap_or(&remote.origin_id);
    if actor_origin_id.is_empty()
        || actor_origin_id.len() > dohc_engine_storage::MAX_IDENTIFIER_BYTES
    {
        return Err(CollabError::InvalidIdentifier {
            reason: "remote actor_origin_id must be non-empty and bounded".to_owned(),
        });
    }
    Ok(UpdateOrigin::Remote {
        origin_id: actor_origin_id.to_owned(),
    })
}

/// A remote update applied outside the pull envelope, with the record facts
/// its append transaction committed: a drained parked update fires the same
/// events an ordinary pull does, or a subscriber would never learn of it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteUpdateApplied {
    pub outcome: TxnOutcome<ReplicationApplyOutcome>,
    pub record_facts: Option<dohc_engine_domain::CollectionRecordApplyFacts>,
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
///
/// The deferred replay gate runs cold because its transaction boundary cannot
/// satisfy the cache proof; an already-resident writer-cache entry is kept
/// aligned after the append commits.
#[allow(clippy::too_many_arguments)]
pub fn apply_remote_update(
    store: &mut EngineStore,
    cache: &mut WriterDocCache,
    key: &DocKey,
    remote: &RemoteUpdate,
    actor_origin_id: Option<&str>,
    attribution: Option<&ChangeAttribution>,
    faults: &dyn FaultInjector,
    now_ms: i64,
) -> Result<RemoteUpdateApplied, CollabError> {
    let mut candidate = None;
    let mut record_facts = None;
    let outcome = store.write_with(faults, |tx| {
        let (outcome, facts) = apply_remote_update_in_transaction(
            tx,
            key,
            remote,
            actor_origin_id,
            attribution,
            now_ms,
            &mut candidate,
        )?;
        // The record-event decision commits with the update: this
        // apply replays a parked coordinate, and if the drain's final
        // projection fails after this transaction, the retry's apply is a
        // no-op that derives no facts. The deferred row (deleted only when
        // the drain completes) carries the decision to that retry; a
        // coordinate no longer parked matches zero rows.
        if let Some(facts) = facts.as_ref() {
            let facts_json = serde_json::to_string(facts)
                .map_err(dohc_engine_storage::StorageError::persist_public)?;
            tx.execute(
                "UPDATE ydoc_deferred_updates SET record_facts_json = ?4 \
                 WHERE workspace_id = ?1 AND origin_id = ?2 AND origin_seq = ?3",
                rusqlite::params![
                    key.workspace_id,
                    remote.origin_id,
                    remote.origin_seq,
                    facts_json
                ],
            )
            .map_err(dohc_engine_storage::StorageError::persist_public)?;
        }
        record_facts = facts;
        Ok::<_, CollabError>(outcome)
    })?;
    cache.finish_deferred_remote_append(store, key, &outcome, &remote.bytes, candidate);
    // Self-bound the log: a genuinely-applied remote update folds the log once it
    // grows past the threshold (a replicated fold keeps a full-state snapshot,
    // never prunes — peers still bootstrap). A dedup/crash does nothing.
    if matches!(
        outcome,
        TxnOutcome::Committed(ReplicationApplyOutcome::Applied { .. })
    ) {
        match maybe_compact(store, key, DEFAULT_COMPACTION_THRESHOLD, faults, now_ms)? {
            TxnOutcome::Committed(CompactOutcome::Compacted {
                up_to_seq,
                snapshot_sha,
                ..
            }) => cache.note_compacted(store, key, up_to_seq, &snapshot_sha),
            TxnOutcome::Committed(CompactOutcome::Skipped { .. }) => {}
            TxnOutcome::Crashed { .. } => cache.remove(key),
        }
    }
    let record_facts = matches!(outcome, TxnOutcome::Committed(_))
        .then_some(record_facts)
        .flatten();
    Ok(RemoteUpdateApplied {
        outcome,
        record_facts,
    })
}

/// Per-origin FIFO does not order cross-origin dependencies, so missing-dependency
/// updates are durably parked; the parity gate rejects only proven divergence.
/// `candidate` receives the gated frontier delta so the caller can keep a
/// resident cache entry aligned after the commit.
fn apply_remote_update_in_transaction(
    tx: &Transaction<'_>,
    key: &DocKey,
    remote: &RemoteUpdate,
    actor_origin_id: Option<&str>,
    attribution: Option<&ChangeAttribution>,
    now_ms: i64,
    candidate: &mut Option<crate::replay_parity::IntegratedFrontierDelta>,
) -> Result<
    (
        ReplicationApplyOutcome,
        Option<dohc_engine_domain::CollectionRecordApplyFacts>,
    ),
    CollabError,
> {
    validate_update_bytes(&remote.bytes)?;
    if remote.origin_id.is_empty()
        || remote.origin_id.len() > dohc_engine_storage::MAX_IDENTIFIER_BYTES
    {
        return Err(CollabError::InvalidIdentifier {
            reason: "remote origin_id must be non-empty and bounded".to_owned(),
        });
    }
    let sha = crate::hex_sha256(&remote.bytes);
    let origin = remote_update_origin(remote, actor_origin_id)?;

    let marker = query_marker(tx, key)?.ok_or(CollabError::NoMarker)?;
    if marker.regime != Regime::Replicated {
        return Err(CollabError::InvalidIdentifier {
            reason: "remote update applied to a non-replicated lineage".to_owned(),
        });
    }
    // Dedup before the gate — `blob_seq_in_log`'s doc explains the order.
    if let Some(existing) = blob_seq_in_log(tx, key, &sha, &remote.bytes)? {
        return Ok((ReplicationApplyOutcome::Deduped { seq: existing }, None));
    }
    let base = load_for_replay_gate(tx, key)?;
    *candidate = Some(crate::replay_parity::validate_replay_parity_with_delta(
        &base,
        &remote.bytes,
    )?);
    let (seq, record_facts) = append_validated_and_index_update(
        tx,
        key,
        marker.content_kind,
        &base,
        None,
        &remote.bytes,
        &sha,
        true,
        origin.actor_id(),
        attribution,
        Some((&remote.origin_id, remote.origin_seq)),
        now_ms,
    )?;
    Ok((
        ReplicationApplyOutcome::Applied {
            seq,
            emit_outbound: false,
        },
        record_facts,
    ))
}

/// Transaction-composable remote admission used by `dohc-engine-sync`: the
/// Y.Doc lineage mutation shares one commit with the imported replication
/// coordinate and peer ack. The frontier and persistent scratch serve only the
/// parity verdict. The returned projection remains a separate fresh
/// full-content document, while `probe` carries cache advancement evidence
/// out of the transaction.
#[allow(clippy::too_many_arguments)]
pub fn apply_remote_update_in_transaction_with_projection(
    tx: &Transaction<'_>,
    cache: &WriterDocCache,
    probe: &mut RemoteAppendProbe,
    key: &DocKey,
    remote: &RemoteUpdate,
    actor_origin_id: Option<&str>,
    attribution: Option<&ChangeAttribution>,
    now_ms: i64,
) -> Result<RemoteApplyProjection, CollabError> {
    validate_update_bytes(&remote.bytes)?;
    if remote.origin_id.is_empty()
        || remote.origin_id.len() > dohc_engine_storage::MAX_IDENTIFIER_BYTES
    {
        return Err(CollabError::InvalidIdentifier {
            reason: "remote origin_id must be non-empty and bounded".to_owned(),
        });
    }
    let sha = crate::hex_sha256(&remote.bytes);
    let origin = remote_update_origin(remote, actor_origin_id)?;
    let marker = query_marker(tx, key)?.ok_or(CollabError::NoMarker)?;
    if marker.regime != Regime::Replicated {
        return Err(CollabError::InvalidIdentifier {
            reason: "remote update applied to a non-replicated lineage".to_owned(),
        });
    }
    if let Some(existing) = blob_seq_in_log(tx, key, &sha, &remote.bytes)? {
        // A dedupe never reached the gate, so it has no gate scratch. Keep the
        // projection on the byte-replay-identical cold base; do not synthesize
        // an owned doc by applying a cached full-state encode.
        return Ok(RemoteApplyProjection {
            outcome: ReplicationApplyOutcome::Deduped { seq: existing },
            doc: load_for_replay_gate(tx, key)?,
            content_kind: marker.content_kind,
            record_facts: None,
        });
    }

    let (projection, validation, source, seq, record_facts) = match cache
        .base_frontier_and_scratch_for_gate(tx, key, &marker)?
    {
        Some((base, frontier, scratch)) => {
            let validation = crate::replay_parity::validate_replay_parity_for_cached_gate(
                base,
                Some(frontier),
                scratch,
                &mut probe.scratch_mutated,
                &remote.bytes,
            )?;
            let projection = crate::replay_parity::build_remote_projection(base, &remote.bytes)?;
            let (seq, record_facts) = append_validated_and_index_update(
                tx,
                key,
                marker.content_kind,
                base,
                Some(&projection),
                &remote.bytes,
                &sha,
                true,
                origin.actor_id(),
                attribution,
                Some((&remote.origin_id, remote.origin_seq)),
                now_ms,
            )?;
            (
                projection,
                validation,
                GateBaseSource::Hit,
                seq,
                record_facts,
            )
        }
        None => {
            let base = load_for_replay_gate(tx, key)?;
            let mut validation = crate::replay_parity::validate_replay_parity_for_cached_gate(
                &base,
                None,
                None,
                &mut probe.scratch_mutated,
                &remote.bytes,
            )?;
            let projection = crate::replay_parity::build_remote_projection(&base, &remote.bytes)?;
            let frontier = validation
                .rebuilt_frontier
                .take()
                .expect("a cold cached-remote gate rebuilds its frontier");
            let (seq, record_facts) = append_validated_and_index_update(
                tx,
                key,
                marker.content_kind,
                &base,
                Some(&projection),
                &remote.bytes,
                &sha,
                true,
                origin.actor_id(),
                attribution,
                Some((&remote.origin_id, remote.origin_seq)),
                now_ms,
            )?;
            (
                projection,
                validation,
                GateBaseSource::Rebuilt {
                    doc: base,
                    frontier,
                },
                seq,
                record_facts,
            )
        }
    };
    probe.served = Some(ServedGateBase {
        source,
        observed: marker.clone(),
    });
    probe.applied_seq = Some(seq);
    probe.candidate = Some(validation.candidate);
    probe.rebuilt_scratch = validation.rebuilt_scratch;
    Ok(RemoteApplyProjection {
        outcome: ReplicationApplyOutcome::Applied {
            seq,
            emit_outbound: false,
        },
        doc: projection,
        content_kind: marker.content_kind,
        record_facts,
    })
}

// Unit tests rather than integration tests because the proof rides the gate's
// `cfg(test)` seam, `with_armed_gate`.
#[cfg(test)]
mod dedupe_hoist_tests {
    use dohc_engine_storage::{EngineStore, NoFaults, TxnOutcome};
    use dohc_test_scratch::ScratchDir;

    use super::*;
    use crate::durable::{
        claim_base, record_local_update, record_local_update_creating_marker, CompactOutcome,
    };
    use crate::replay_parity::with_armed_gate;
    use crate::ydoc::{ContentKind, Ydoc};

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

    /// Rot the canonical stored blob for `bytes` out-of-band (bit-rot
    /// simulation). Returns the blob's sha.
    fn rot_stored_blob(store: &mut EngineStore, bytes: &[u8]) -> String {
        let sha = crate::hex_sha256(bytes);
        let outcome = store
            .write_with(&NoFaults, |tx| -> Result<usize, CollabError> {
                tx.execute(
                    "UPDATE binary_blobs SET bytes = ?2, byte_length = ?3 WHERE sha256 = ?1",
                    rusqlite::params![sha, b"rotted".as_slice(), 6_i64],
                )
                .map_err(|e| CollabError::Corrupt {
                    reason: e.to_string(),
                })
            })
            .expect("rot blob");
        assert_eq!(committed(outcome), 1, "the canonical blob row must exist");
        sha
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
            apply_remote_update(
                &mut store,
                &mut WriterDocCache::new(),
                &key,
                &remote,
                None,
                None,
                &NoFaults,
                1_100,
            )
            .expect("apply")
            .outcome,
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

        let again = with_armed_gate(|| {
            apply_remote_update(
                &mut store,
                &mut WriterDocCache::new(),
                &key,
                &remote,
                None,
                None,
                &NoFaults,
                1_200,
            )
        })
        .expect("an in-log redelivery must dedupe without invoking the gate")
        .outcome;
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
                &mut crate::WriterDocCache::new(),
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

        let again = with_armed_gate(|| {
            record_local_update(
                &mut store,
                &mut crate::WriterDocCache::new(),
                &key,
                &update,
                &NoFaults,
                1_100,
            )
        })
        .expect("a duplicate local append must dedupe without invoking the gate");
        let again = committed(again);
        assert_eq!(
            again,
            crate::durable::AppendOutcome {
                seq: first.seq,
                deduped: true,
                emit_outbound: false,
                record_facts: None,
            },
            "duplicate append outcome unchanged by the hoist"
        );
        assert_eq!(update_rows(&store, &key), 1, "no duplicate row");
    }

    #[test]
    fn a_rotted_canonical_blob_fails_the_remote_dedup_as_corrupt() {
        let (_dir, mut store, key, remote, _seq) =
            replicated_with_applied_delta("dedupe-hoist-rot-remote");
        let sha = rot_stored_blob(&mut store, &remote.bytes);

        let refused = apply_remote_update(
            &mut store,
            &mut WriterDocCache::new(),
            &key,
            &remote,
            None,
            None,
            &NoFaults,
            1_200,
        )
        .expect_err("a redelivery over a rotted blob must surface Corrupt, not a false ack");
        assert!(
            matches!(&refused, CollabError::Corrupt { reason } if reason.contains(&sha)),
            "expected Corrupt naming the sha: {refused:?}"
        );
    }

    #[test]
    fn a_rotted_canonical_blob_fails_the_local_dedup_as_corrupt() {
        let (_dir, mut store) = fresh_store("dedupe-hoist-rot-local");
        let key = seeded_key(&mut store);
        let doc = Ydoc::wire();
        let update = doc.plaintext_insert(0, "hello ");
        let first = committed(
            record_local_update_creating_marker(
                &mut store,
                &mut crate::WriterDocCache::new(),
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
        rot_stored_blob(&mut store, &update);

        let refused = record_local_update(
            &mut store,
            &mut crate::WriterDocCache::new(),
            &key,
            &update,
            &NoFaults,
            1_100,
        )
        .expect_err("a duplicate append over a rotted blob must surface Corrupt");
        assert!(
            matches!(refused, CollabError::Corrupt { .. }),
            "expected Corrupt: {refused:?}"
        );
    }

    #[test]
    fn redelivered_folded_bytes_take_the_full_gate_and_reappend() {
        let (_dir, mut store, key, remote, _seq) =
            replicated_with_applied_delta("dedupe-hoist-folded");

        // Fold the applied delta into a snapshot: its log row is pruned, so the
        // redelivery below is outside the dedup span.
        let folded =
            committed(maybe_compact(&mut store, &key, 1, &NoFaults, 1_300).expect("compact"));
        assert!(
            matches!(folded, CompactOutcome::Compacted { .. }),
            "the fold must fire: {folded:?}"
        );
        assert_eq!(update_rows(&store, &key), 0, "folded row pruned");

        // Armed gate: a folded redelivery must reach the gate, which the armed
        // seam turns into a fail-closed refusal.
        let refused = with_armed_gate(|| {
            apply_remote_update(
                &mut store,
                &mut WriterDocCache::new(),
                &key,
                &remote,
                None,
                None,
                &NoFaults,
                1_400,
            )
        })
        .expect_err("a folded redelivery must take the full gate");
        assert!(
            matches!(refused, CollabError::ReplayParityViolation { .. }),
            "expected the armed gate's fail-closed refusal: {refused:?}"
        );

        // Disarmed, the same redelivery passes the gate and re-appends as a
        // fresh row (a CRDT no-op; re-folded at the next compaction).
        let reapplied = committed(
            apply_remote_update(
                &mut store,
                &mut WriterDocCache::new(),
                &key,
                &remote,
                None,
                None,
                &NoFaults,
                1_500,
            )
            .expect("re-append")
            .outcome,
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
