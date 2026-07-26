//! Store-level durability and crash-recovery traces (CAL-1 calibration
//! signal). Each test is the oracle staple: mutate → (crash) → reopen →
//! compare, and where relevant, mutate again to prove the reopened store stays
//! writable.

use dohc_engine_storage::{
    CompoundWrite, EngineStore, FaultPoint, MAX_DOCUMENT_BODY_BYTES, NoFaults, StorageError,
    WriteOutcome,
};
use dohc_engine_testkit::ScratchDir;
use dohc_engine_testkit::harness::{
    crash_during_write, open_readonly_keeper, sample_write, wal_sidecar, write_fingerprint_db,
    write_foreign_unversioned_db,
};

const NO_FAULTS: NoFaults = NoFaults;

/// Assert that opening `db` fails with `expected_code` AND left the file's
/// bytes and WAL state untouched (the fence must never mutate a rejected store).
fn assert_rejected_without_mutation(db: &std::path::Path, expected_code: &str) {
    let before = std::fs::read(db).expect("read before");
    let wal = wal_sidecar(db);
    let wal_before = wal.exists();

    let err = EngineStore::open(db, 100).expect_err("open must be rejected");
    assert_eq!(err.code(), expected_code);

    let after = std::fs::read(db).expect("read after");
    assert_eq!(before, after, "rejected db must be byte-unchanged");
    assert_eq!(
        wal.exists(),
        wal_before,
        "the fence must not create a -wal sidecar on a rejected db"
    );
}

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
// rejected with the typed fence error, never migrated, and left byte-unchanged.
#[test]
fn v1_fingerprint_is_rejected_without_mutation() {
    let scratch = ScratchDir::new().expect("scratch dir");
    let db = scratch.engine_db_path().expect("db path");
    write_fingerprint_db(&db, 1).expect("write v1 db");

    // Typed variant carries the found/expected versions.
    match EngineStore::open(&db, 100).expect_err("must reject v1") {
        StorageError::UnsupportedFingerprint { found, expected } => {
            assert_eq!(found, 1);
            assert_eq!(expected, 2);
        }
        other => panic!("unexpected error: {other:?}"),
    }
    // And the rejection touched no bytes.
    assert_rejected_without_mutation(&db, "unsupported-fingerprint");
}

// oracle: storage init never writes over a non-empty foreign database, and
// leaves it byte-unchanged.
#[test]
fn foreign_unversioned_database_is_rejected_without_mutation() {
    let scratch = ScratchDir::new().expect("scratch dir");
    let db = scratch.engine_db_path().expect("db path");
    write_foreign_unversioned_db(&db).expect("write foreign db");

    assert_rejected_without_mutation(&db, "foreign-database");
}

// oracle: durability is pinned, not luck — `synchronous` reads back NORMAL, so
// a weakened configuration fails this test.
#[test]
fn synchronous_is_pinned_to_normal() {
    let scratch = ScratchDir::new().expect("scratch dir");
    let db = scratch.engine_db_path().expect("db path");
    let store = EngineStore::open(&db, 1).expect("open");
    assert_eq!(store.synchronous_setting().expect("synchronous"), 1);
}

// oracle: WAL replay on reopen — a committed write is recoverable from the WAL
// before any checkpoint folds it into the main file. A read-only keeper holds
// the database so the writer's close does not checkpoint.
#[test]
fn committed_write_replays_from_wal_on_reopen() {
    let scratch = ScratchDir::new().expect("scratch dir");
    let db = scratch.engine_db_path().expect("db path");

    let keeper = {
        let mut writer = EngineStore::open(&db, 1).expect("open writer");
        writer
            .commit_compound(&sample_write("r1", "d1", "replayed", 1), &NO_FAULTS)
            .expect("write");
        // Open the keeper and start an OPEN read transaction so it holds a
        // shared lock across the writer's close — that keeps SQLite from
        // checkpointing (and deleting) the WAL. A read-only connection that has
        // not yet queried holds no lock, so an explicit read snapshot is
        // required.
        let keeper = open_readonly_keeper(&db).expect("keeper");
        keeper.execute_batch("BEGIN").expect("begin read txn");
        let _seen: i64 = keeper
            .query_row("SELECT COUNT(*) FROM documents", [], |row| row.get(0))
            .expect("read snapshot");
        drop(writer);
        keeper
    };

    // Data still lives in the WAL, not yet checkpointed into the main file.
    let wal = wal_sidecar(&db);
    assert!(
        wal.exists(),
        "-wal sidecar must exist (data not checkpointed)"
    );
    assert!(
        std::fs::metadata(&wal).expect("wal meta").len() > 0,
        "-wal must hold the committed frame"
    );

    // A fresh connection recovers the committed state by replaying the WAL.
    let reopened = EngineStore::open(&db, 2).expect("reopen");
    let doc = reopened
        .read_document("d1")
        .expect("read")
        .expect("present");
    assert_eq!(doc.body, "replayed");

    drop(reopened);
    drop(keeper);
}

// oracle: idempotency — a same-payload retry replays exactly-once; a key reused
// with a DIFFERENT payload is rejected, never silently replayed.
#[test]
fn idempotency_key_reuse_is_guarded() {
    let scratch = ScratchDir::new().expect("scratch dir");
    let db = scratch.engine_db_path().expect("db path");
    let mut store = EngineStore::open(&db, 1).expect("open");

    let first = sample_write("req-k", "doc/k", "original", 1);
    let ack = store.commit_compound(&first, &NO_FAULTS).expect("first");
    assert_eq!(
        ack,
        WriteOutcome::Acked {
            seq: 1,
            deduped: false
        }
    );

    // Same key, same payload → exactly-once replay (no new journal entry).
    let retry = store.commit_compound(&first, &NO_FAULTS).expect("retry");
    assert_eq!(
        retry,
        WriteOutcome::Acked {
            seq: 1,
            deduped: true
        }
    );
    assert_eq!(store.journal_len().expect("journal"), 1);

    // Same key, DIFFERENT payload → typed mismatch, nothing written.
    let conflicting = CompoundWrite {
        request_id: "req-k".to_owned(),
        doc_id: "doc/k".to_owned(),
        body: "tampered".to_owned(),
        op_kind: "text.write".to_owned(),
        now_ms: 2,
    };
    let err = store
        .commit_compound(&conflicting, &NO_FAULTS)
        .expect_err("reuse must be rejected");
    assert_eq!(err.code(), "idempotency-key-reuse-mismatch");
    // The original document and single journal entry are untouched.
    assert_eq!(
        store
            .read_document("doc/k")
            .expect("read")
            .expect("doc")
            .body,
        "original"
    );
    assert_eq!(store.journal_len().expect("journal"), 1);
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

    // The rejected over-limit write left no trace in ANY compound-write
    // component (validation runs before the transaction opens).
    assert_eq!(store.document_count().expect("docs"), 2);
    assert_eq!(store.journal_len().expect("journal"), 2);
    assert_eq!(store.request_ledger_len().expect("ledger"), 2);
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
    // The migration ledger recorded the frozen list: the v2 baseline row, the
    // R08 secrets migration (ordinal 1), the R11a Y.Doc migration (ordinal 2),
    // the R09 chats migration (ordinal 3), the R12 search migration (ordinal 4),
    // the R05 moment-preimage-link migration (ordinal 5), the R10 sync
    // migration (ordinal 6), the R06 conflicts migration (ordinal 7), the
    // shadow-clone migration (ordinal 8), binary conflict sides (ordinal 9),
    // binary heads (ordinal 10), the path-aliases reverse-alias index
    // (ordinal 11), the deferred Y.Doc coordinates table (ordinal 12), the
    // request-ledger kind discriminator (ordinal 13), secret capture ownership
    // (ordinal 14), moment payload provenance (ordinal 15), replication
    // pending resolves (ordinal 16), deferred chat coordinates (ordinal 17),
    // and imported moment metadata provenance (ordinal 18).
    assert_eq!(store.migration_ledger_len().expect("ledger"), 19);
    let conflict_objects = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM sqlite_schema WHERE \
                 (type = 'table' AND name = 'conflicts') OR \
                 (type = 'index' AND name = 'idx_conflicts_workspace_status')",
                [],
                |row| row.get::<_, i64>(0),
            )
        })
        .expect("fresh conflicts table and index");
    assert_eq!(conflict_objects, 2);
}
