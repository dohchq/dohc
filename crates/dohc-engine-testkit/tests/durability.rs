//! Store-level durability and crash-recovery traces (CAL-1 calibration
//! signal). Each test is the oracle staple: mutate → (crash) → reopen →
//! compare, and where relevant, mutate again to prove the reopened store stays
//! writable.

use dohc_engine_storage::{
    EngineStore, FaultPoint, MAX_DOCUMENT_BODY_BYTES, NoFaults, StorageError, WriteOutcome,
};
use dohc_engine_testkit::ScratchDir;
use dohc_engine_testkit::harness::{
    crash_during_write, sample_write, write_fingerprint_db, write_foreign_unversioned_db,
};

const NO_FAULTS: NoFaults = NoFaults;

// oracle: storage open→write→close→reopen→read-back proves durability.
#[test]
fn write_then_reopen_reads_back() {
    let scratch = ScratchDir::new().expect("scratch dir");
    let db = scratch.engine_db_path().expect("db path");

    {
        let mut store = EngineStore::open(&db, 1_000).expect("open fresh");
        let outcome = store
            .commit_compound(
                &sample_write("r1", "notes/today", "hello\n", 1_000),
                &NO_FAULTS,
            )
            .expect("write");
        assert_eq!(
            outcome,
            WriteOutcome::Acked {
                seq: 1,
                deduped: false
            }
        );
        // Store dropped here — the connection closes (simulated clean close).
    }

    let store = EngineStore::open(&db, 2_000).expect("reopen");
    let doc = store
        .read_document("notes/today")
        .expect("read")
        .expect("present");
    assert_eq!(doc.body, "hello\n");
    assert_eq!(doc.updated_at_ms, 1_000);
    assert_eq!(store.document_count().expect("count"), 1);
    assert_eq!(store.journal_len().expect("journal"), 1);
}

// oracle: storage.after-commit-before-ack — restart shows committed state;
// a retry is exactly-once (idempotency ledger), no duplicate journal entry.
#[test]
fn crash_after_commit_recovers_exactly_once() {
    let scratch = ScratchDir::new().expect("scratch dir");
    let db = scratch.engine_db_path().expect("db path");

    let write = sample_write("req-42", "doc/a", "committed body", 5);
    let outcome = crash_during_write(&db, 5, FaultPoint::StorageAfterCommitBeforeAck, &write)
        .expect("crash run");
    assert_eq!(outcome, WriteOutcome::Crashed { committed: true });

    // Restart: the committed state survives.
    let mut store = EngineStore::open(&db, 6).expect("reopen");
    let doc = store
        .read_document("doc/a")
        .expect("read")
        .expect("present");
    assert_eq!(doc.body, "committed body");
    assert_eq!(store.document_count().expect("docs"), 1);
    assert_eq!(store.journal_len().expect("journal"), 1);
    assert_eq!(store.request_ledger_len().expect("ledger"), 1);

    // Retry the same request id after recovery: exactly-once — replays to the
    // recorded result, no second document write and no second journal entry.
    let retry = store.commit_compound(&write, &NO_FAULTS).expect("retry");
    assert_eq!(
        retry,
        WriteOutcome::Acked {
            seq: 1,
            deduped: true
        }
    );
    assert_eq!(store.document_count().expect("docs"), 1);
    assert_eq!(store.journal_len().expect("journal"), 1);
    assert_eq!(store.request_ledger_len().expect("ledger"), 1);
}

// oracle: storage.before-persist — a mid-transaction crash rolls back;
// restart shows NO partial state (atomic rollback).
#[test]
fn crash_before_persist_leaves_no_partial_state() {
    let scratch = ScratchDir::new().expect("scratch dir");
    let db = scratch.engine_db_path().expect("db path");

    let write = sample_write("req-lost", "doc/ghost", "should vanish", 7);
    let outcome =
        crash_during_write(&db, 7, FaultPoint::StorageBeforePersist, &write).expect("crash run");
    assert_eq!(outcome, WriteOutcome::Crashed { committed: false });

    // Restart: nothing from the rolled-back transaction survived.
    let mut store = EngineStore::open(&db, 8).expect("reopen");
    assert_eq!(store.read_document("doc/ghost").expect("read"), None);
    assert_eq!(store.document_count().expect("docs"), 0);
    assert_eq!(store.journal_len().expect("journal"), 0);
    assert_eq!(store.request_ledger_len().expect("ledger"), 0);

    // The store is still writable after recovering from the rollback — the
    // same request id now legitimately applies exactly once.
    let redo = store.commit_compound(&write, &NO_FAULTS).expect("redo");
    assert_eq!(
        redo,
        WriteOutcome::Acked {
            seq: 1,
            deduped: false
        }
    );
    assert_eq!(store.document_count().expect("docs"), 1);
}

// oracle: storage.open-version-fingerprint-mismatch — a v1 database is
// rejected with the typed fence error, never migrated.
#[test]
fn v1_fingerprint_is_rejected() {
    let scratch = ScratchDir::new().expect("scratch dir");
    let db = scratch.engine_db_path().expect("db path");
    write_fingerprint_db(&db, 1).expect("write v1 db");

    let err = EngineStore::open(&db, 100).expect_err("must reject v1");
    assert_eq!(err.code(), "unsupported-fingerprint");
    match err {
        StorageError::UnsupportedFingerprint { found, expected } => {
            assert_eq!(found, 1);
            assert_eq!(expected, 2);
        }
        other => panic!("unexpected error: {other:?}"),
    }
}

// oracle: storage init never writes over a non-empty foreign database.
#[test]
fn foreign_unversioned_database_is_rejected() {
    let scratch = ScratchDir::new().expect("scratch dir");
    let db = scratch.engine_db_path().expect("db path");
    write_foreign_unversioned_db(&db).expect("write foreign db");

    let err = EngineStore::open(&db, 100).expect_err("must refuse foreign db");
    assert_eq!(err.code(), "foreign-database");
}

// oracle: bounded parameter — limit-1 / limit / limit+1 on the document body.
#[test]
fn document_body_bound_is_enforced_at_the_edge() {
    let scratch = ScratchDir::new().expect("scratch dir");
    let db = scratch.engine_db_path().expect("db path");
    let mut store = EngineStore::open(&db, 1).expect("open");

    let at_limit = "a".repeat(MAX_DOCUMENT_BODY_BYTES);
    let below = "a".repeat(MAX_DOCUMENT_BODY_BYTES - 1);
    let over = "a".repeat(MAX_DOCUMENT_BODY_BYTES + 1);

    assert!(matches!(
        store.commit_compound(&sample_write("b1", "d1", &below, 1), &NO_FAULTS),
        Ok(WriteOutcome::Acked { .. })
    ));
    assert!(matches!(
        store.commit_compound(&sample_write("b2", "d2", &at_limit, 1), &NO_FAULTS),
        Ok(WriteOutcome::Acked { .. })
    ));
    let err = store
        .commit_compound(&sample_write("b3", "d3", &over, 1), &NO_FAULTS)
        .expect_err("over-limit must fail");
    assert_eq!(err.code(), "document-too-large");

    // The rejected over-limit write left no trace (validation before the txn).
    assert_eq!(store.document_count().expect("docs"), 2);
}

// oracle: close/reopen/mutate cycle — the reopened store stays writable and
// accumulates across sessions (the plan's oracle staple).
#[test]
fn close_reopen_mutate_cycle_stays_writable() {
    let scratch = ScratchDir::new().expect("scratch dir");
    let db = scratch.engine_db_path().expect("db path");

    for round in 0..3_i64 {
        let mut store = EngineStore::open(&db, round).expect("open round");
        let req = format!("req-{round}");
        let doc = format!("doc-{round}");
        let outcome = store
            .commit_compound(&sample_write(&req, &doc, "body", round), &NO_FAULTS)
            .expect("write");
        assert!(matches!(
            outcome,
            WriteOutcome::Acked { deduped: false, .. }
        ));
        // Reopening never wipes: the row count grows by one each round.
        assert_eq!(store.document_count().expect("docs"), round + 1);
        // Store dropped → connection closed before the next round reopens.
    }

    let store = EngineStore::open(&db, 99).expect("final reopen");
    assert_eq!(store.document_count().expect("docs"), 3);
    // The eager migration ledger recorded exactly the v2 baseline row.
    assert_eq!(store.migration_ledger_len().expect("ledger"), 1);
}
