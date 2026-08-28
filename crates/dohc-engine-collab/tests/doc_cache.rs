//! WriterDocCache invariants (PR1 of the engine doc-cache design): the in-tx
//! tuple probe under hostile raw-SQL injection, the ABA and poison cases the
//! differential check must catch, rollback/crash semantics, compaction
//! re-base byte-equality, eviction, and the forced-close containment pin.

mod common;

use common::*;
use dohc_engine_collab::limits::DEFAULT_COMPACTION_THRESHOLD;
use dohc_engine_collab::{
    close_session, ensure_marker, load_persisted, maybe_compact, read_marker, record_local_update,
    record_local_update_creating_marker_guarded, record_update_in_tx, CollabError, CompactOutcome,
    ContentKind, DocKey, Regime, WriterDocCache, Ydoc,
};
use dohc_engine_storage::{EngineStore, NoFaults, TxnOutcome};

fn committed<T>(o: TxnOutcome<T>) -> T {
    match o {
        TxnOutcome::Committed(v) => v,
        TxnOutcome::Crashed { .. } => panic!("expected committed, got crashed"),
    }
}

/// A fresh store with a seeded, marked plaintext doc.
fn setup(tag: &str, regime: Regime) -> (TempStore, DocKey) {
    let mut ts = fresh_store(tag);
    let key = test_key();
    seed_parents(&mut ts.store, &key, 1_000);
    committed(
        ensure_marker(
            &mut ts.store,
            &key,
            ContentKind::Plaintext,
            regime,
            &NoFaults,
            1_000,
        )
        .expect("marker"),
    );
    (ts, key)
}

/// An insert-at-0 update from a fresh independent client: valid against any
/// base (no origin dependencies), so appends can be sequenced freely.
fn independent_insert(text: &str) -> Vec<u8> {
    Ydoc::wire().plaintext_insert(0, text)
}

/// Redefine an update's payload in place (same client, same clocks, different
/// content) — the hostile-redefinition shape the parity gate must reject.
fn flip_payload_byte(update: &[u8], from: u8, to: u8) -> Vec<u8> {
    let positions: Vec<usize> = update
        .iter()
        .enumerate()
        .filter_map(|(i, b)| (*b == from).then_some(i))
        .collect();
    assert_eq!(
        positions.len(),
        1,
        "payload byte must be unambiguous in the wire bytes"
    );
    let mut hostile = update.to_vec();
    hostile[positions[0]] = to;
    hostile
}

/// Append a row behind the cache's (and the durable API's) back: blob + log
/// row + head bump, exactly what a hostile writer or missed hook would leave.
fn inject_row(store: &mut EngineStore, key: &DocKey, bytes: &[u8], seq: i64) {
    let outcome = store
        .write_with(&NoFaults, |tx| -> Result<(), CollabError> {
            dohc_engine_storage::put_binary_blob(tx, bytes)?;
            tx.execute(
                "INSERT INTO ydoc_updates \
                 (workspace_id, version_id, object_id, seq, update_blob_sha256, recorded_at_ms) \
                 VALUES (?1, ?2, ?3, ?4, ?5, 0)",
                rusqlite::params![
                    key.workspace_id,
                    key.version_id,
                    key.object_id,
                    seq,
                    dohc_engine_collab::hex_sha256(bytes),
                ],
            )
            .map_err(|e| CollabError::Corrupt {
                reason: e.to_string(),
            })?;
            tx.execute(
                "UPDATE ydoc_docs SET head_update_seq = ?4 \
                 WHERE workspace_id = ?1 AND version_id = ?2 AND object_id = ?3",
                rusqlite::params![key.workspace_id, key.version_id, key.object_id, seq],
            )
            .map_err(|e| CollabError::Corrupt {
                reason: e.to_string(),
            })?;
            Ok(())
        })
        .expect("inject row");
    committed(outcome);
}

/// Prune every CRDT row and rewind the head to 0 WITHOUT touching the cache —
/// the raw shape of a local-only prune whose reset hook was skipped.
fn raw_prune(store: &mut EngineStore, key: &DocKey) {
    let outcome = store
        .write_with(&NoFaults, |tx| -> Result<(), CollabError> {
            for sql in [
                "DELETE FROM ydoc_updates \
                 WHERE workspace_id = ?1 AND version_id = ?2 AND object_id = ?3",
                "DELETE FROM ydoc_snapshots \
                 WHERE workspace_id = ?1 AND version_id = ?2 AND object_id = ?3",
                "UPDATE ydoc_docs SET head_update_seq = 0, head_snapshot_seq = 0 \
                 WHERE workspace_id = ?1 AND version_id = ?2 AND object_id = ?3",
            ] {
                tx.execute(
                    sql,
                    rusqlite::params![key.workspace_id, key.version_id, key.object_id],
                )
                .map_err(|e| CollabError::Corrupt {
                    reason: e.to_string(),
                })?;
            }
            Ok(())
        })
        .expect("raw prune");
    committed(outcome);
}

fn projected(store: &EngineStore, key: &DocKey) -> String {
    load_persisted(store, key)
        .expect("load")
        .expect("doc")
        .doc
        .project(ContentKind::Plaintext)
        .expect("project")
        .content
}

// ---- hit / advance behavior -------------------------------------------------

#[test]
fn local_appends_install_then_hit_and_advance_the_cache() {
    let (mut ts, key) = setup("cache-hit-advance", Regime::LocalOnly);
    // One producer client: a single-client lineage re-encodes
    // deterministically, so the cached-vs-cold comparison below can be
    // byte-for-byte.
    let producer = Ydoc::wire();
    let u1 = producer.plaintext_insert(0, "a");
    let u2 = producer.plaintext_insert(1, "b");
    committed(
        record_local_update(&mut ts.store, &mut ts.cache, &key, &u1, &NoFaults, 1_001).expect("u1"),
    );
    let s = ts.cache.stats();
    assert_eq!((s.hits, s.misses, s.installs), (0, 1, 1));

    committed(
        record_local_update(&mut ts.store, &mut ts.cache, &key, &u2, &NoFaults, 1_002).expect("u2"),
    );
    let s = ts.cache.stats();
    assert_eq!((s.hits, s.advances), (1, 1));

    // The entry is byte-identical to a cold reconstruction.
    let cold = load_persisted(&ts.store, &key).expect("load").expect("doc");
    assert_eq!(
        ts.cache.doc_full_state_for_test(&key),
        Some(cold.doc.encode_full_state()),
        "cached doc must equal the cold rebuild byte-for-byte"
    );

    // A dedupe resend changes no durable state and touches no counters.
    let before = ts.cache.stats();
    let resend = committed(
        record_local_update(&mut ts.store, &mut ts.cache, &key, &u2, &NoFaults, 1_003)
            .expect("resend"),
    );
    assert!(resend.deduped);
    assert_eq!(ts.cache.stats(), before);
}

#[test]
fn frontier_fold_retires_a_live_identity_covered_by_delete() {
    // MUTATION: drop identity retirement from the fold and the frontier no
    // longer equals the store re-encode after the delete.
    let (mut ts, key) = setup("frontier-retire-identity", Regime::LocalOnly);
    let producer = Ydoc::wire();
    let insert = producer.plaintext_insert(0, "ab");
    committed(
        record_local_update(
            &mut ts.store,
            &mut ts.cache,
            &key,
            &insert,
            &NoFaults,
            1_001,
        )
        .expect("insert"),
    );
    assert_eq!(
        ts.cache.frontier_fact_counts_for_test(&key),
        Some((2, 0, 0))
    );

    let delete = producer.plaintext_delete(0, 1);
    committed(
        record_local_update(
            &mut ts.store,
            &mut ts.cache,
            &key,
            &delete,
            &NoFaults,
            1_002,
        )
        .expect("delete"),
    );
    assert_eq!(
        ts.cache.frontier_fact_counts_for_test(&key),
        Some((1, 0, 2))
    );
    assert_eq!(
        ts.cache
            .frontier_matches_doc_for_test(&key)
            .expect("frontier comparison"),
        Some(true)
    );
}

#[test]
fn frontier_fold_retires_a_deleted_scalar_interior() {
    // MUTATION: drop unsafe-interior retirement and the retained interior clock
    // survives after the scalar itself is deleted.
    let (mut ts, key) = setup("frontier-retire-interior", Regime::LocalOnly);
    let producer = Ydoc::wire();
    let insert = producer.plaintext_insert(0, "😀");
    committed(
        record_local_update(
            &mut ts.store,
            &mut ts.cache,
            &key,
            &insert,
            &NoFaults,
            1_001,
        )
        .expect("insert"),
    );
    assert_eq!(
        ts.cache.frontier_fact_counts_for_test(&key),
        Some((2, 1, 0))
    );

    let delete = producer.plaintext_delete(0, 2);
    committed(
        record_local_update(
            &mut ts.store,
            &mut ts.cache,
            &key,
            &delete,
            &NoFaults,
            1_002,
        )
        .expect("delete"),
    );
    assert_eq!(
        ts.cache.frontier_fact_counts_for_test(&key),
        Some((0, 0, 2))
    );
    assert_eq!(
        ts.cache
            .frontier_matches_doc_for_test(&key)
            .expect("frontier comparison"),
        Some(true)
    );
}

#[test]
fn frontier_delete_endpoints_canonicalize_across_pending_integration() {
    // Two adjacent deletes arrive before their target insert. A raw endpoint
    // append would retain four endpoints; yrs IdSet and the fresh store encode
    // both emit the one canonical [0, 2) range before and after integration.
    let (mut ts, key) = setup("frontier-pending-delete-coverage", Regime::LocalOnly);
    let producer = Ydoc::wire();
    let dependency = producer.plaintext_insert(0, "abc");
    let delete_first = producer.plaintext_delete(0, 1);
    let delete_second = producer.plaintext_delete(0, 1);

    for (now_ms, update) in [(1_001, &delete_second), (1_002, &delete_first)] {
        committed(
            record_local_update(
                &mut ts.store,
                &mut ts.cache,
                &key,
                update,
                &NoFaults,
                now_ms,
            )
            .expect("parked delete"),
        );
        assert_eq!(
            ts.cache
                .frontier_matches_doc_for_test(&key)
                .expect("parked frontier comparison"),
            Some(true)
        );
        assert_eq!(
            ts.cache
                .frontier_fact_counts_for_test(&key)
                .map(|facts| facts.2),
            Some(2),
            "adjacent coverage must emit one canonical endpoint pair"
        );
    }
    assert_eq!(
        load_persisted(&ts.store, &key)
            .expect("parked load")
            .expect("parked doc")
            .doc
            .plaintext_string(),
        "",
        "the dependency-free base cannot yet expose the deleted content"
    );

    committed(
        record_local_update(
            &mut ts.store,
            &mut ts.cache,
            &key,
            &dependency,
            &NoFaults,
            1_003,
        )
        .expect("dependency"),
    );
    assert_eq!(
        load_persisted(&ts.store, &key)
            .expect("integrated load")
            .expect("integrated doc")
            .doc
            .plaintext_string(),
        "c",
        "the target insert releases both adjacent pending deletes"
    );
    assert_eq!(
        ts.cache.frontier_fact_counts_for_test(&key),
        Some((1, 0, 2))
    );
    assert_eq!(
        ts.cache
            .frontier_matches_doc_for_test(&key)
            .expect("integrated frontier comparison"),
        Some(true)
    );
}

// ---- T1: mutation-style stale-cache injection -------------------------------

#[test]
fn tuple_probe_rejects_a_hostile_candidate_after_raw_sql_injection() {
    // T1: U2 lands behind the cache's back; a hostile candidate that
    // redefines U2's clocks must be refused via the tuple-mismatch rebuild.
    // Delete the in-tx tuple check and this test fails: the gate would judge
    // the hostile bytes against the stale {U1} base, where U2's client is
    // unknown, and admit them.
    let (mut ts, key) = setup("cache-t1-injection", Regime::LocalOnly);
    let u1 = independent_insert("a");
    committed(
        record_local_update(&mut ts.store, &mut ts.cache, &key, &u1, &NoFaults, 1_001).expect("u1"),
    );

    let u2 = independent_insert("z");
    inject_row(&mut ts.store, &key, &u2, 2);

    let hostile = flip_payload_byte(&u2, b'z', b'y');
    let before = ts.cache.stats();
    let error = record_local_update(
        &mut ts.store,
        &mut ts.cache,
        &key,
        &hostile,
        &NoFaults,
        1_002,
    )
    .expect_err("a clock redefinition must be rejected");
    assert!(
        matches!(error, CollabError::ReplayParityViolation { .. }),
        "expected ReplayParityViolation, got {error:?}"
    );
    let after = ts.cache.stats();
    assert_eq!(
        after.hits, before.hits,
        "the stale entry must not serve the gate"
    );
    assert_eq!(
        after.misses,
        before.misses + 1,
        "the head mismatch must fall back to a full rebuild"
    );

    // A benign append still admits over the rebuilt lineage — including U2.
    let u3 = independent_insert("c");
    committed(
        record_local_update(&mut ts.store, &mut ts.cache, &key, &u3, &NoFaults, 1_003).expect("u3"),
    );
    let content = projected(&ts.store, &key);
    assert!(content.contains('z') && content.contains('c'));
}

#[test]
fn tuple_probe_detects_a_replaced_head_row() {
    // Same head seq, same claim fields, DIFFERENT head-row bytes: only the
    // head-row sha probe can see this. Delete that probe and (in debug) the
    // differential check panics this test; the probe keeps it a plain miss.
    let (mut ts, key) = setup("cache-t1-head-row", Regime::LocalOnly);
    let u1 = independent_insert("z");
    committed(
        record_local_update(&mut ts.store, &mut ts.cache, &key, &u1, &NoFaults, 1_001).expect("u1"),
    );

    let u1b = independent_insert("q");
    let outcome = ts
        .store
        .write_with(&NoFaults, |tx| -> Result<(), CollabError> {
            tx.execute(
                "DELETE FROM ydoc_updates \
                 WHERE workspace_id = ?1 AND version_id = ?2 AND object_id = ?3 AND seq = 1",
                rusqlite::params![key.workspace_id, key.version_id, key.object_id],
            )
            .map_err(|e| CollabError::Corrupt {
                reason: e.to_string(),
            })?;
            dohc_engine_storage::put_binary_blob(tx, &u1b)?;
            tx.execute(
                "INSERT INTO ydoc_updates \
                 (workspace_id, version_id, object_id, seq, update_blob_sha256, recorded_at_ms) \
                 VALUES (?1, ?2, ?3, 1, ?4, 0)",
                rusqlite::params![
                    key.workspace_id,
                    key.version_id,
                    key.object_id,
                    dohc_engine_collab::hex_sha256(&u1b),
                ],
            )
            .map_err(|e| CollabError::Corrupt {
                reason: e.to_string(),
            })?;
            Ok(())
        })
        .expect("replace head row");
    committed(outcome);

    let before = ts.cache.stats();
    let u2 = independent_insert("w");
    committed(
        record_local_update(&mut ts.store, &mut ts.cache, &key, &u2, &NoFaults, 1_002).expect("u2"),
    );
    let after = ts.cache.stats();
    assert_eq!(
        after.hits, before.hits,
        "the replaced head row must not hit"
    );
    assert_eq!(after.misses, before.misses + 1);
    let content = projected(&ts.store, &key);
    assert!(content.contains('q') && content.contains('w') && !content.contains('z'));
}

// ---- T2: ABA and poisoning against the differential check -------------------

#[cfg(debug_assertions)]
#[test]
#[should_panic(expected = "CACHE-VALID")]
fn differential_check_catches_a_prune_aba_that_matches_the_tuple() {
    // A prune + re-append that reaches the SAME head coordinates with the
    // SAME head bytes over DIFFERENT earlier history is invisible to the
    // tuple — exactly why every prune path must call the remove hook. With
    // the hook deliberately skipped, the debug differential check is the
    // last line and must fire.
    let (mut ts, key) = setup("cache-t2-aba", Regime::LocalOnly);
    let u1a = independent_insert("a");
    let u2 = independent_insert("b");
    committed(
        record_local_update(&mut ts.store, &mut ts.cache, &key, &u1a, &NoFaults, 1_001)
            .expect("u1a"),
    );
    committed(
        record_local_update(&mut ts.store, &mut ts.cache, &key, &u2, &NoFaults, 1_002).expect("u2"),
    );

    raw_prune(&mut ts.store, &key); // reset hook deliberately skipped
    let u1b = independent_insert("c");
    let outcome = ts
        .store
        .write_with(&NoFaults, |tx| -> Result<(), CollabError> {
            record_update_in_tx(tx, &key, &u1b, 1_003)?;
            record_update_in_tx(tx, &key, &u2, 1_004)?;
            Ok(())
        })
        .expect("re-append");
    committed(outcome);

    // Tuple matches (head 2, same head-row sha, same claim fields) while the
    // replay bytes differ: the differential check must panic.
    let u3 = independent_insert("d");
    let _ = record_local_update(&mut ts.store, &mut ts.cache, &key, &u3, &NoFaults, 1_005);
}

#[cfg(debug_assertions)]
#[test]
#[should_panic(expected = "CACHE-VALID")]
fn differential_check_catches_a_poisoned_entry() {
    let (mut ts, key) = setup("cache-t2-poison", Regime::LocalOnly);
    let u1 = independent_insert("a");
    committed(
        record_local_update(&mut ts.store, &mut ts.cache, &key, &u1, &NoFaults, 1_001).expect("u1"),
    );

    ts.cache.poison_doc_for_test(&key, Ydoc::wire());

    let u2 = independent_insert("b");
    let _ = record_local_update(&mut ts.store, &mut ts.cache, &key, &u2, &NoFaults, 1_002);
}

#[cfg(debug_assertions)]
#[test]
#[should_panic(expected = "FR1-VALID")]
fn frontier_oracle_catches_a_poisoned_identity() {
    let (mut ts, key) = setup("frontier-oracle-poison", Regime::LocalOnly);
    let u1 = independent_insert("a");
    committed(
        record_local_update(&mut ts.store, &mut ts.cache, &key, &u1, &NoFaults, 1_001).expect("u1"),
    );
    ts.cache.poison_frontier_for_test(&key);

    let u2 = independent_insert("b");
    let _ = record_local_update(&mut ts.store, &mut ts.cache, &key, &u2, &NoFaults, 1_002);
}

#[test]
fn a_pruned_lineage_with_the_reset_hook_rejects_a_hostile_re_encode() {
    // The healed counterpart of the ABA test: the prune calls the remove
    // hook (as every production reset path does), the lineage is re-seeded,
    // and a hostile re-encode of the new head's clocks is still rejected.
    let (mut ts, key) = setup("cache-t2-healed", Regime::LocalOnly);
    let u1a = independent_insert("a");
    let u2 = independent_insert("b");
    committed(
        record_local_update(&mut ts.store, &mut ts.cache, &key, &u1a, &NoFaults, 1_001)
            .expect("u1a"),
    );
    committed(
        record_local_update(&mut ts.store, &mut ts.cache, &key, &u2, &NoFaults, 1_002).expect("u2"),
    );

    raw_prune(&mut ts.store, &key);
    ts.cache.remove(&key); // the mandatory reset hook

    let u1b = independent_insert("c");
    committed(
        record_local_update(&mut ts.store, &mut ts.cache, &key, &u1b, &NoFaults, 1_003)
            .expect("u1b"),
    );
    committed(
        record_local_update(&mut ts.store, &mut ts.cache, &key, &u2, &NoFaults, 1_004)
            .expect("u2 again"),
    );

    let hostile = flip_payload_byte(&u2, b'b', b'x');
    let error = record_local_update(
        &mut ts.store,
        &mut ts.cache,
        &key,
        &hostile,
        &NoFaults,
        1_005,
    )
    .expect_err("a clock redefinition must be rejected on the hit path too");
    assert!(matches!(error, CollabError::ReplayParityViolation { .. }));
}

// ---- T3: rollback and crash semantics ---------------------------------------

#[test]
fn a_guarded_error_after_the_gate_leaves_the_entry_valid() {
    // (a) The guarded closure fails AFTER the gate passed: the transaction
    // rolls back, the cache must not advance, and the untouched entry still
    // matches the durable state (the retry hits it).
    let (mut ts, key) = setup("cache-t3-guarded-err", Regime::LocalOnly);
    let u1 = independent_insert("a");
    committed(
        record_local_update(&mut ts.store, &mut ts.cache, &key, &u1, &NoFaults, 1_001).expect("u1"),
    );

    let u2 = independent_insert("b");
    let before = ts.cache.stats();
    record_local_update_creating_marker_guarded(
        &mut ts.store,
        &mut ts.cache,
        &key,
        None,
        ContentKind::Plaintext,
        Regime::LocalOnly,
        &u2,
        None,
        false,
        false,
        None,
        &NoFaults,
        1_002,
        |_tx, _outcome| {
            Err(CollabError::Corrupt {
                reason: "injected post-append failure".to_owned(),
            })
        },
    )
    .expect_err("the hook failure must roll the append back");
    assert_eq!(
        ts.cache.stats().advances,
        before.advances,
        "no advance on rollback"
    );
    assert_eq!(
        read_marker(&ts.store, &key)
            .expect("marker")
            .expect("row")
            .head_update_seq,
        1,
        "the append rolled back"
    );

    let retry = committed(
        record_local_update(&mut ts.store, &mut ts.cache, &key, &u2, &NoFaults, 1_003)
            .expect("retry"),
    );
    assert!(!retry.deduped);
    assert_eq!(
        ts.cache.stats().hits,
        before.hits + 2,
        "the entry stayed valid: the rolled-back attempt and the retry both hit"
    );
}

#[test]
fn the_commit_token_observes_updates_appended_by_the_post_append_hook() {
    let (mut ts, key) = setup("cache-commit-token-extra", Regime::LocalOnly);
    let u1 = independent_insert("a");
    committed(
        record_local_update(&mut ts.store, &mut ts.cache, &key, &u1, &NoFaults, 1_001).expect("u1"),
    );
    let u2 = independent_insert("b");
    let extra = independent_insert("c");
    let before = ts.cache.stats();

    committed(
        record_local_update_creating_marker_guarded(
            &mut ts.store,
            &mut ts.cache,
            &key,
            None,
            ContentKind::Plaintext,
            Regime::LocalOnly,
            &u2,
            None,
            false,
            false,
            None,
            &NoFaults,
            1_002,
            |tx, _outcome| {
                let appended = record_update_in_tx(tx, &key, &extra, 1_003)?;
                assert!(!appended.deduped, "the hook must append another row");
                Ok(())
            },
        )
        .expect("append with extra update"),
    );

    assert_eq!(
        read_marker(&ts.store, &key)
            .expect("marker")
            .expect("row")
            .head_update_seq,
        3,
        "both updates committed"
    );
    assert_eq!(
        ts.cache.stats().advances,
        before.advances,
        "the cache must not advance by only the first update"
    );
    assert!(
        !ts.cache.contains_for_test(&key),
        "the final in-transaction tuple must reject the partial advancement"
    );
}

#[cfg(feature = "fault-injection")]
#[test]
fn a_pre_persist_crash_keeps_the_entry_valid() {
    // (b) StorageBeforePersist rolls back: durable state is unchanged, so
    // the entry survives and the retry hits it.
    use dohc_engine_storage::FaultPoint;
    let (mut ts, key) = setup("cache-t3-crash-rollback", Regime::LocalOnly);
    let u1 = independent_insert("a");
    committed(
        record_local_update(&mut ts.store, &mut ts.cache, &key, &u1, &NoFaults, 1_001).expect("u1"),
    );

    let u2 = independent_insert("b");
    let faults = OneShotCrash::at(FaultPoint::StorageBeforePersist);
    let outcome = record_local_update(&mut ts.store, &mut ts.cache, &key, &u2, &faults, 1_002)
        .expect("crash surfaces as an outcome");
    assert!(matches!(outcome, TxnOutcome::Crashed { committed: false }));
    assert!(ts.cache.contains_for_test(&key), "rollback keeps the entry");

    let before = ts.cache.stats();
    let retry = committed(
        record_local_update(&mut ts.store, &mut ts.cache, &key, &u2, &NoFaults, 1_003)
            .expect("retry"),
    );
    assert!(!retry.deduped);
    assert_eq!(
        ts.cache.stats().hits,
        before.hits + 1,
        "the retry hit the surviving entry"
    );
}

#[cfg(feature = "fault-injection")]
#[test]
fn a_post_commit_crash_removes_the_entry_and_a_rebuild_matches_the_durable_head() {
    // (c) StorageAfterCommitBeforeAck: durable-but-unacked. The entry is
    // removed fail-safe; the byte retry dedupes (installing nothing), and
    // the next genuinely-new append rebuilds to the durable head.
    use dohc_engine_storage::FaultPoint;
    let (mut ts, key) = setup("cache-t3-crash-committed", Regime::LocalOnly);
    // Single-client lineage: the final cached-vs-cold comparison is
    // byte-for-byte only when the re-encode is deterministic.
    let producer = Ydoc::wire();
    let u1 = producer.plaintext_insert(0, "a");
    let u2 = producer.plaintext_insert(1, "b");
    let u3 = producer.plaintext_insert(2, "c");
    committed(
        record_local_update(&mut ts.store, &mut ts.cache, &key, &u1, &NoFaults, 1_001).expect("u1"),
    );

    let faults = OneShotCrash::at(FaultPoint::StorageAfterCommitBeforeAck);
    let outcome = record_local_update(&mut ts.store, &mut ts.cache, &key, &u2, &faults, 1_002)
        .expect("crash surfaces as an outcome");
    assert!(matches!(outcome, TxnOutcome::Crashed { committed: true }));
    assert!(
        !ts.cache.contains_for_test(&key),
        "a durable-but-unacked append removes the entry"
    );

    let retry = committed(
        record_local_update(&mut ts.store, &mut ts.cache, &key, &u2, &NoFaults, 1_003)
            .expect("retry"),
    );
    assert!(retry.deduped, "the committed bytes dedupe on retry");
    assert!(
        !ts.cache.contains_for_test(&key),
        "a dedupe installs nothing"
    );

    committed(
        record_local_update(&mut ts.store, &mut ts.cache, &key, &u3, &NoFaults, 1_004).expect("u3"),
    );
    let cold = load_persisted(&ts.store, &key).expect("load").expect("doc");
    assert_eq!(
        ts.cache.doc_full_state_for_test(&key),
        Some(cold.doc.encode_full_state()),
        "the rebuilt entry matches the durable head byte-for-byte"
    );
}

// ---- T4: compaction re-base and eviction ------------------------------------

#[test]
fn compaction_rebases_the_entry_to_the_snapshot_byte_for_byte() {
    let (mut ts, key) = setup("cache-t4-compaction", Regime::LocalOnly);
    // Single-client lineage for the byte-for-byte comparison below.
    let producer = Ydoc::wire();
    for i in 0..DEFAULT_COMPACTION_THRESHOLD {
        let update = producer.plaintext_insert(i, "x");
        committed(
            record_local_update(
                &mut ts.store,
                &mut ts.cache,
                &key,
                &update,
                &NoFaults,
                1_001 + i64::from(i),
            )
            .expect("append"),
        );
    }
    let marker = read_marker(&ts.store, &key).expect("marker").expect("row");
    assert_eq!(
        marker.head_snapshot_seq, marker.head_update_seq,
        "the self-bounding fold fired"
    );
    let cold = load_persisted(&ts.store, &key).expect("load").expect("doc");
    assert_eq!(
        ts.cache.doc_full_state_for_test(&key),
        Some(cold.doc.encode_full_state()),
        "the re-based entry equals the cold reconstruction byte-for-byte"
    );
    assert_eq!(
        ts.cache
            .frontier_matches_doc_for_test(&key)
            .expect("compacted frontier comparison"),
        Some(true),
        "compaction rebuilds the frontier from the exact snapshot bytes"
    );

    // The re-based entry serves the next append as a hit.
    let before = ts.cache.stats();
    let update = producer.plaintext_insert(0, "y");
    committed(
        record_local_update(
            &mut ts.store,
            &mut ts.cache,
            &key,
            &update,
            &NoFaults,
            2_000,
        )
        .expect("append"),
    );
    assert_eq!(ts.cache.stats().hits, before.hits + 1);
}

#[test]
fn eviction_prefers_unpinned_lru_and_holds_the_entry_cap() {
    let mut ts = fresh_store("cache-t4-eviction");
    let mut cache = WriterDocCache::with_limits_for_test(2, usize::MAX);
    let keys: Vec<DocKey> = (1..=3)
        .map(|i| DocKey::new("ws-1", "ver-1", format!("obj-{i}")).expect("key"))
        .collect();
    for key in &keys {
        seed_parents(&mut ts.store, key, 1_000);
        committed(
            ensure_marker(
                &mut ts.store,
                key,
                ContentKind::Plaintext,
                Regime::LocalOnly,
                &NoFaults,
                1_000,
            )
            .expect("marker"),
        );
    }
    cache.pin(&keys[0]);
    for (i, key) in keys.iter().enumerate() {
        let update = independent_insert(&format!("k{i}"));
        committed(
            record_local_update(&mut ts.store, &mut cache, key, &update, &NoFaults, 1_001)
                .expect("append"),
        );
    }
    assert!(
        cache.contains_for_test(&keys[0]),
        "the pinned entry survives"
    );
    assert!(
        !cache.contains_for_test(&keys[1]),
        "the unpinned LRU entry is evicted"
    );
    assert!(cache.contains_for_test(&keys[2]));
}

#[test]
fn the_byte_budget_bounds_residency_without_affecting_appends() {
    let (mut ts, key) = setup("cache-t4-byte-budget", Regime::LocalOnly);
    let mut cache = WriterDocCache::with_limits_for_test(16, 1);
    let u1 = independent_insert("a");
    committed(
        record_local_update(&mut ts.store, &mut cache, &key, &u1, &NoFaults, 1_001).expect("u1"),
    );
    assert!(
        !cache.contains_for_test(&key),
        "over-budget entries are not installed"
    );
    assert_eq!(
        cache.stats().installs,
        0,
        "the rejected install is not counted"
    );
    let u2 = independent_insert("b");
    committed(
        record_local_update(&mut ts.store, &mut cache, &key, &u2, &NoFaults, 1_002).expect("u2"),
    );
    let content = projected(&ts.store, &key);
    assert!(content.contains('a') && content.contains('b'));
}

// ---- forced-close containment (#851) ----------------------------------------

#[test]
fn a_warmed_cache_does_not_change_forced_close_corruption_detection() {
    // Forced compaction (threshold 0 — the call close_session makes on a
    // replicated lineage) must ALWAYS fully reconstruct: close is the audit
    // point where blob corruption surfaces. A warm cache entry for the same
    // lineage must not change that verdict.
    let (mut ts, key) = setup("cache-forced-close-pin", Regime::Replicated);
    let u1 = independent_insert("x");
    committed(
        record_local_update(&mut ts.store, &mut ts.cache, &key, &u1, &NoFaults, 1_001).expect("u1"),
    );
    assert!(ts.cache.contains_for_test(&key), "the cache is warm");

    committed(maybe_compact(&mut ts.store, &key, 0, &NoFaults, 1_002).expect("forced fold"));

    // Corrupt the snapshot reference (FKs off for one connection-level
    // statement, mirroring durable_regimes' forced-compaction test).
    ts.store
        .read_with(|conn| -> rusqlite::Result<()> {
            conn.pragma_update(None, "foreign_keys", false)?;
            conn.execute(
                "UPDATE ydoc_snapshots SET snapshot_blob_sha256 = 'deadbeef' \
                 WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
                rusqlite::params![key.workspace_id, key.version_id, key.object_id],
            )?;
            conn.pragma_update(None, "foreign_keys", true)?;
            Ok(())
        })
        .expect("corrupt the snapshot reference");

    let error = close_session(&mut ts.store, &key, false, None, &NoFaults, 1_003)
        .expect_err("forced close must surface the corruption, warm cache or not");
    assert!(
        matches!(error, CollabError::Corrupt { .. }),
        "expected Corrupt, got {error:?}"
    );
}

#[test]
fn a_compact_outcome_is_what_the_forced_close_reports_when_healthy() {
    // Companion assertion: a healthy warmed close still reports the same
    // Skipped/Compacted shape as before the cache existed.
    let (mut ts, key) = setup("cache-forced-close-healthy", Regime::Replicated);
    let u1 = independent_insert("x");
    committed(
        record_local_update(&mut ts.store, &mut ts.cache, &key, &u1, &NoFaults, 1_001).expect("u1"),
    );
    let first = committed(maybe_compact(&mut ts.store, &key, 0, &NoFaults, 1_002).expect("fold"));
    assert!(matches!(first, CompactOutcome::Compacted { .. }));
    let second = committed(maybe_compact(&mut ts.store, &key, 0, &NoFaults, 1_003).expect("fold"));
    assert!(matches!(second, CompactOutcome::Skipped { pending: 0 }));
}
