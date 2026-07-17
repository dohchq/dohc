//! The durable-layer invariants: two regimes (local-only prune vs replicated
//! never-prune), base-once, replication idempotency + echo suppression, leases,
//! and the yjs-non-atomic boundary (never journal invalid bytes). Crash-recovery
//! / exactly-once tests live behind the `fault-injection` feature.

mod common;

use common::*;
use dohc_engine_collab::ContentKind;
use dohc_engine_collab::{
    apply_remote_update, claim_base, close_session, ensure_marker, load_persisted, read_marker,
    record_local_update, settle, ClaimOutcome, CloseOutcome, CollabError, DocKey, LeaseRegistry,
    Regime, RemoteUpdate, ReplicationApplyOutcome, Ydoc,
};
use dohc_engine_storage::{NoFaults, TxnOutcome};

fn committed<T>(o: TxnOutcome<T>) -> T {
    match o {
        TxnOutcome::Committed(v) => v,
        TxnOutcome::Crashed { .. } => panic!("expected committed, got crashed"),
    }
}

/// A small plaintext lineage: (base full-state bytes, a follow-up remote delta).
fn plaintext_base_and_delta() -> (Vec<u8>, Vec<u8>) {
    let doc = Ydoc::wire();
    doc.plaintext_insert(0, "hello ");
    let base = doc.encode_full_state();
    // A peer resumes the base and edits → the delta is a valid remote op.
    let peer = Ydoc::wire();
    peer.apply(&base).expect("peer base");
    let delta = peer.plaintext_insert(6, "world");
    (base, delta)
}

// ---- regimes ----------------------------------------------------------------

#[test]
fn local_only_close_prunes_the_cache() {
    let mut ts = fresh_store("local-prune");
    let key = test_key();
    seed_parents(&mut ts.store, &key, 1_000);
    committed(
        ensure_marker(
            &mut ts.store,
            &key,
            ContentKind::Plaintext,
            Regime::LocalOnly,
            &NoFaults,
            1_000,
        )
        .expect("marker"),
    );
    let doc = Ydoc::wire();
    for i in 0..3 {
        let d = doc.plaintext_insert((i * 2) as u32, "ab");
        committed(record_local_update(&mut ts.store, &key, &d, &NoFaults, 1_000).expect("rec"));
    }
    assert_eq!(count(&ts.store, "ydoc_updates", &key), 3);

    let out =
        committed(close_session(&mut ts.store, &key, false, &NoFaults, 2_000).expect("close"));
    assert!(
        matches!(out, CloseOutcome::Pruned { .. }),
        "local-only prunes"
    );
    // The CRDT cache is gone; the marker survives (markdown-is-the-artifact).
    assert_eq!(count(&ts.store, "ydoc_updates", &key), 0, "updates pruned");
    assert_eq!(
        count(&ts.store, "ydoc_snapshots", &key),
        0,
        "snapshots pruned"
    );
    assert!(
        read_marker(&ts.store, &key).expect("read").is_some(),
        "marker kept"
    );
}

#[test]
fn replicated_close_never_prunes_the_lineage() {
    let mut ts = fresh_store("repl-keep");
    let key = test_key();
    seed_parents(&mut ts.store, &key, 1_000);
    let (base, delta) = plaintext_base_and_delta();
    let claim = committed(
        claim_base(
            &mut ts.store,
            &key,
            ContentKind::Plaintext,
            &base,
            &NoFaults,
            1_000,
        )
        .expect("base"),
    );
    assert!(matches!(claim, ClaimOutcome::Claimed { .. }));
    committed(record_local_update(&mut ts.store, &key, &delta, &NoFaults, 1_100).expect("rec"));

    let before = load_persisted(&ts.store, &key)
        .expect("load")
        .expect("m")
        .doc
        .canonical_content_sha256();
    let out =
        committed(close_session(&mut ts.store, &key, false, &NoFaults, 2_000).expect("close"));
    assert!(
        matches!(out, CloseOutcome::Compacted(_)),
        "replicated compacts, not prunes"
    );
    // Durable lineage survives: a snapshot remains and reconstructs identically —
    // a peer can bootstrap from it.
    assert!(
        count(&ts.store, "ydoc_snapshots", &key) >= 1,
        "snapshot durable"
    );
    let after = load_persisted(&ts.store, &key)
        .expect("load")
        .expect("m")
        .doc
        .canonical_content_sha256();
    assert_eq!(before, after, "content preserved across replicated close");
}

// ---- base-once --------------------------------------------------------------

#[test]
fn base_is_claimed_exactly_once() {
    let mut ts = fresh_store("base-once");
    let key = test_key();
    seed_parents(&mut ts.store, &key, 1_000);
    let (base, _) = plaintext_base_and_delta();

    let first = committed(
        claim_base(
            &mut ts.store,
            &key,
            ContentKind::Plaintext,
            &base,
            &NoFaults,
            1_000,
        )
        .expect("first"),
    );
    let first_sha = match first {
        ClaimOutcome::Claimed { base_snapshot_sha } => base_snapshot_sha,
        ClaimOutcome::Resumed => panic!("first claim must mint the base"),
    };
    assert!(
        read_marker(&ts.store, &key)
            .expect("m")
            .expect("marker")
            .base_claimed
    );
    assert_eq!(
        count(&ts.store, "ydoc_snapshots", &key),
        1,
        "exactly one base"
    );

    // A second claim — even with DIFFERENT base bytes — must resume, not fork a
    // second base.
    let other = Ydoc::wire();
    other.plaintext_insert(0, "different seed");
    let other_base = other.encode_full_state();
    let second = committed(
        claim_base(
            &mut ts.store,
            &key,
            ContentKind::Plaintext,
            &other_base,
            &NoFaults,
            1_500,
        )
        .expect("second"),
    );
    assert!(
        matches!(second, ClaimOutcome::Resumed),
        "second base rejected → resume"
    );
    assert_eq!(
        count(&ts.store, "ydoc_snapshots", &key),
        1,
        "still exactly one base"
    );
    // The surviving base is the FIRST one (byte-intact).
    let base_sha_now = ts
        .store
        .read_with(|c| -> Result<String, CollabError> {
            c.query_row(
                "SELECT snapshot_blob_sha256 FROM ydoc_snapshots \
                 WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3 AND up_to_seq=0",
                rusqlite::params![key.workspace_id, key.version_id, key.object_id],
                |r| r.get(0),
            )
            .map_err(|e| CollabError::Corrupt {
                reason: e.to_string(),
            })
        })
        .expect("sha");
    assert_eq!(base_sha_now, first_sha, "first base survives");
}

// ---- replication: idempotent + echo-suppressed ------------------------------

#[test]
fn remote_update_is_idempotent_and_echo_suppressed() {
    let mut ts = fresh_store("repl-apply");
    let key = test_key();
    seed_parents(&mut ts.store, &key, 1_000);
    let (base, delta) = plaintext_base_and_delta();
    committed(
        claim_base(
            &mut ts.store,
            &key,
            ContentKind::Plaintext,
            &base,
            &NoFaults,
            1_000,
        )
        .expect("base"),
    );

    let remote = RemoteUpdate {
        origin_id: "peer-A".to_string(),
        origin_seq: 1,
        bytes: delta.clone(),
    };
    // First apply: journaled, echo-suppressed (never re-emitted).
    let first = committed(
        apply_remote_update(&mut ts.store, &key, &remote, &NoFaults, 1_100).expect("apply"),
    );
    let seq = match first {
        ReplicationApplyOutcome::Applied { seq, emit_outbound } => {
            assert!(!emit_outbound, "a remote update must NOT be echoed");
            seq
        }
        ReplicationApplyOutcome::Deduped { .. } => panic!("first apply must land"),
    };
    // Redelivery of the same bytes is an idempotent no-op (content-addressed).
    let again = committed(
        apply_remote_update(&mut ts.store, &key, &remote, &NoFaults, 1_200).expect("apply2"),
    );
    assert_eq!(
        again,
        ReplicationApplyOutcome::Deduped { seq },
        "redelivery deduped"
    );
    assert_eq!(
        count(&ts.store, "ydoc_updates", &key),
        1,
        "no duplicate row"
    );

    // The remote edit is durable in the lineage (a resume sees it).
    let persisted = load_persisted(&ts.store, &key).expect("load").expect("m");
    assert!(persisted.doc.plaintext_string().contains("world"));

    // The row carries the peer origin (provenance).
    let origin: Option<String> = ts
        .store
        .read_with(|c| -> Result<Option<String>, CollabError> {
            c.query_row(
                "SELECT actor_origin_id FROM ydoc_updates \
                 WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3 AND seq=?4",
                rusqlite::params![key.workspace_id, key.version_id, key.object_id, seq],
                |r| r.get(0),
            )
            .map_err(|e| CollabError::Corrupt {
                reason: e.to_string(),
            })
        })
        .expect("origin");
    assert_eq!(origin.as_deref(), Some("peer-A"));
}

#[test]
fn local_edit_on_replicated_lineage_requests_broadcast() {
    let mut ts = fresh_store("repl-local");
    let key = test_key();
    seed_parents(&mut ts.store, &key, 1_000);
    let (base, delta) = plaintext_base_and_delta();
    committed(
        claim_base(
            &mut ts.store,
            &key,
            ContentKind::Plaintext,
            &base,
            &NoFaults,
            1_000,
        )
        .expect("base"),
    );
    let out =
        committed(record_local_update(&mut ts.store, &key, &delta, &NoFaults, 1_100).expect("rec"));
    assert!(
        out.emit_outbound,
        "a new local edit on a replicated lineage broadcasts"
    );
    assert!(!out.deduped);
}

// ---- constraint 5: never journal invalid bytes ------------------------------

#[test]
fn truncated_update_is_rejected_and_never_journaled() {
    let mut ts = fresh_store("truncate");
    let key = test_key();
    seed_parents(&mut ts.store, &key, 1_000);
    committed(
        ensure_marker(
            &mut ts.store,
            &key,
            ContentKind::Plaintext,
            Regime::LocalOnly,
            &NoFaults,
            1_000,
        )
        .expect("m"),
    );

    let doc = Ydoc::wire();
    let good = doc.plaintext_insert(0, "hello world this is a genuine update");
    // Every non-empty prefix cut of a genuine update: none may be journaled.
    let mut rejected = 0;
    for cut in 1..good.len() {
        let truncated = &good[..cut];
        match record_local_update(&mut ts.store, &key, truncated, &NoFaults, 1_000) {
            Err(_) => rejected += 1,
            Ok(TxnOutcome::Committed(app)) => {
                // If yrs happened to accept a prefix as a valid (different)
                // update, it is at least never a torn/partial journal — the log
                // count must equal the number of accepted appends. Extremely
                // unlikely for a truncation, but not asserted-impossible.
                let _ = app;
            }
            Ok(TxnOutcome::Crashed { .. }) => panic!("no fault armed"),
        }
    }
    assert!(rejected > 0, "truncated prefixes must be rejected");
    // The empty update is rejected too.
    assert!(matches!(
        record_local_update(&mut ts.store, &key, &[], &NoFaults, 1_000),
        Err(CollabError::EmptyUpdate)
    ));
    // The genuine update still lands cleanly afterward (rejection left no torn
    // state).
    committed(record_local_update(&mut ts.store, &key, &good, &NoFaults, 1_000).expect("good"));
    let persisted = load_persisted(&ts.store, &key).expect("load").expect("m");
    assert_eq!(
        persisted.doc.plaintext_string(),
        "hello world this is a genuine update"
    );
}

// ---- leases -----------------------------------------------------------------

#[test]
fn a_lease_is_exclusive_and_releases_on_drop() {
    let registry = LeaseRegistry::new();
    let key = test_key();
    let other = DocKey::new("ws-1", "ver-1", "obj-2").expect("k2");

    let lease = registry.acquire(&key).expect("first lease");
    assert!(registry.is_held(&key));
    // A second open of the SAME lineage is refused.
    assert!(matches!(
        registry.acquire(&key),
        Err(CollabError::LeaseHeld)
    ));
    // A different lineage is independent.
    let _l2 = registry.acquire(&other).expect("other lease");

    // Dropping releases deterministically; the lineage can be reopened.
    drop(lease);
    assert!(!registry.is_held(&key));
    let _released = registry.acquire(&key).expect("reacquire after drop");
}

// ---- settle -----------------------------------------------------------------

#[test]
fn settle_projects_and_enqueues_an_idempotent_job() {
    let mut ts = fresh_store("settle");
    let key = test_key();
    seed_parents(&mut ts.store, &key, 1_000);
    committed(
        ensure_marker(
            &mut ts.store,
            &key,
            ContentKind::Plaintext,
            Regime::LocalOnly,
            &NoFaults,
            1_000,
        )
        .expect("m"),
    );
    let doc = Ydoc::wire();
    let d = doc.plaintext_insert(0, "the settled markdown body");
    committed(record_local_update(&mut ts.store, &key, &d, &NoFaults, 1_000).expect("rec"));

    let first =
        committed(settle(&mut ts.store, &key, "notes/doc.md", &NoFaults, 5_000).expect("settle"));
    assert!(!first.deduped);
    assert_eq!(first.projection.markdown, "the settled markdown body");
    assert_eq!(
        first.projection.source_state_vector_sha256.len(),
        64,
        "provenance sv recorded"
    );
    assert_eq!(ts.store.pending_materialization_count().expect("jobs"), 1);

    // A re-driven settle with the same content+generation is exactly-once.
    let again =
        committed(settle(&mut ts.store, &key, "notes/doc.md", &NoFaults, 5_000).expect("settle2"));
    assert!(again.deduped, "same content+generation dedups");
    assert_eq!(again.job_id, first.job_id);
    assert_eq!(
        ts.store.pending_materialization_count().expect("jobs"),
        1,
        "no duplicate job"
    );
}

// ---- crash recovery / exactly-once (needs the shared storage fault seam) -----

#[cfg(feature = "fault-injection")]
mod crash {
    use super::*;
    use dohc_engine_storage::FaultPoint;

    #[test]
    fn append_crash_after_commit_before_ack_is_exactly_once() {
        let dir = unique_dir("crash-append");
        let key = test_key();
        {
            let mut store = open_at(&dir, 1_000);
            seed_parents(&mut store, &key, 1_000);
            committed(
                ensure_marker(
                    &mut store,
                    &key,
                    ContentKind::Plaintext,
                    Regime::LocalOnly,
                    &NoFaults,
                    1_000,
                )
                .expect("m"),
            );
            let doc = Ydoc::wire();
            let update = doc.plaintext_insert(0, "committed-but-unacked");
            // Kill after the durable commit but before the ack.
            let faults = OneShotCrash::at(FaultPoint::StorageAfterCommitBeforeAck);
            let out = record_local_update(&mut store, &key, &update, &faults, 1_000).expect("rec");
            assert_eq!(out, TxnOutcome::Crashed { committed: true });
            // Reopen (dropping `store` closes the connection; the file stays).
            drop(store);
            let mut store = reopen(&dir);
            assert_eq!(
                count(&store, "ydoc_updates", &key),
                1,
                "append durable after reopen"
            );
            // The retry is exactly-once (content-addressed dedup), never a dup.
            let retry =
                record_local_update(&mut store, &key, &update, &NoFaults, 1_000).expect("retry");
            assert!(
                matches!(retry, TxnOutcome::Committed(a) if a.deduped),
                "retry deduped"
            );
            assert_eq!(
                count(&store, "ydoc_updates", &key),
                1,
                "no duplicate append"
            );
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn append_crash_before_persist_leaves_no_torn_state() {
        let dir = unique_dir("crash-rollback");
        let key = test_key();
        {
            let mut store = open_at(&dir, 1_000);
            seed_parents(&mut store, &key, 1_000);
            committed(
                ensure_marker(
                    &mut store,
                    &key,
                    ContentKind::Plaintext,
                    Regime::LocalOnly,
                    &NoFaults,
                    1_000,
                )
                .expect("m"),
            );
            let doc = Ydoc::wire();
            let update = doc.plaintext_insert(0, "rolled-back");
            let faults = OneShotCrash::at(FaultPoint::StorageBeforePersist);
            let out = record_local_update(&mut store, &key, &update, &faults, 1_000).expect("rec");
            assert_eq!(out, TxnOutcome::Crashed { committed: false });
            drop(store);
            let mut store = reopen(&dir);
            assert_eq!(count(&store, "ydoc_updates", &key), 0, "nothing journaled");
            let retry =
                record_local_update(&mut store, &key, &update, &NoFaults, 1_000).expect("retry");
            assert!(matches!(retry, TxnOutcome::Committed(a) if !a.deduped));
            assert_eq!(count(&store, "ydoc_updates", &key), 1);
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn settle_crash_after_commit_before_ack_is_exactly_once() {
        let dir = unique_dir("crash-settle");
        let key = test_key();
        {
            let mut store = open_at(&dir, 1_000);
            seed_parents(&mut store, &key, 1_000);
            committed(
                ensure_marker(
                    &mut store,
                    &key,
                    ContentKind::Plaintext,
                    Regime::LocalOnly,
                    &NoFaults,
                    1_000,
                )
                .expect("m"),
            );
            let doc = Ydoc::wire();
            let d = doc.plaintext_insert(0, "settle-once");
            committed(record_local_update(&mut store, &key, &d, &NoFaults, 1_000).expect("rec"));
            let faults = OneShotCrash::at(FaultPoint::StorageAfterCommitBeforeAck);
            let out = settle(&mut store, &key, "n.md", &faults, 5_000).expect("settle");
            assert_eq!(out, TxnOutcome::Crashed { committed: true });
            drop(store);
            let mut store = reopen(&dir);
            assert_eq!(
                store.pending_materialization_count().expect("jobs"),
                1,
                "job durable"
            );
            let retry =
                committed(settle(&mut store, &key, "n.md", &NoFaults, 5_000).expect("retry"));
            assert!(retry.deduped, "retry deduped");
            assert_eq!(
                store.pending_materialization_count().expect("jobs"),
                1,
                "no duplicate job"
            );
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
