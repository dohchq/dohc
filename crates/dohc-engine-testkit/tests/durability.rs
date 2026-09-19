//! Store-level durability and crash-recovery traces: mutate, (crash), reopen,
//! compare, and where relevant mutate again to prove the reopened store stays
//! writable.

use dohc_engine_domain::{VersionedTextStore, WriteText};
use dohc_engine_storage::{EngineStore, FaultPoint, NoFaults, StorageError};
use dohc_engine_testkit::harness::{
    open_readonly_keeper, wal_sidecar, write_fingerprint_db, write_foreign_unversioned_db,
};
use dohc_engine_testkit::{ScratchDir, ScriptedFaults, engine_db_path};
use std::path::Path;

const WS: &str = "ws";
const NO_FAULTS: NoFaults = NoFaults;

fn open(db: &Path, now_ms: i64) -> EngineStore {
    let mut store = EngineStore::open(db, now_ms).expect("open");
    VersionedTextStore::new(&mut store)
        .ensure_main_version(WS, "main", now_ms, &NO_FAULTS)
        .expect("main version");
    store
}

fn write(path: &str, text: &str, moment: &str, request_id: Option<&str>, now_ms: i64) -> WriteText {
    WriteText {
        workspace_id: WS.to_owned(),
        version_id: "main".to_owned(),
        object_id: format!("object-{moment}"),
        path: path.to_owned(),
        text: text.to_owned(),
        moment_id: moment.to_owned(),
        metadata_origin: "user".to_owned(),
        metadata_summary: None,
        metadata_correlation_id: None,
        author_json: None,
        now_ms,
        request_id: request_id.map(str::to_owned),
    }
}

fn read(store: &mut EngineStore, path: &str) -> Option<String> {
    VersionedTextStore::new(store)
        .read_text(WS, "main", path)
        .expect("read")
        .map(|snapshot| snapshot.text)
}

fn moments(store: &EngineStore) -> i64 {
    store.table_row_count("moments").expect("count moments")
}

/// Assert that opening `db` fails with `expected_code` And left the file's
/// bytes and WAL state untouched (the fence must never mutate a rejected store).
fn assert_rejected_without_mutation(db: &Path, expected_code: &str) {
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
    let db = engine_db_path(&scratch).expect("db path");

    {
        let mut store = open(&db, 1_000);
        let written = VersionedTextStore::new(&mut store)
            .write_text(
                &write("notes/today.md", "hello\n", "m1", None, 1_000),
                &NO_FAULTS,
            )
            .expect("write");
        assert!(!written.deduped);
        // Store dropped here — the connection closes (simulated clean close).
    }

    let mut store = open(&db, 2_000);
    assert_eq!(
        read(&mut store, "notes/today.md").as_deref(),
        Some("hello\n")
    );
    assert_eq!(moments(&store), 1);
}

// oracle: storage.after-commit-before-ack — restart shows committed state;
// a retry is exactly-once (idempotency ledger), no duplicate moment.
#[test]
fn crash_after_commit_recovers_exactly_once() {
    let scratch = ScratchDir::new().expect("scratch dir");
    let db = engine_db_path(&scratch).expect("db path");
    let input = write("doc/a.md", "committed body", "m1", Some("req-42"), 5);

    {
        let mut store = open(&db, 5);
        let faults = ScriptedFaults::crash_at(FaultPoint::StorageAfterCommitBeforeAck);
        let err = VersionedTextStore::new(&mut store)
            .write_text(&input, faults.as_ref())
            .expect_err("crash after commit");
        assert_eq!(err.code(), "persist-failed");
        // Simulate process death: the writer connection is closed here.
    }

    // Restart: the committed state survives.
    let mut store = open(&db, 6);
    assert_eq!(
        read(&mut store, "doc/a.md").as_deref(),
        Some("committed body")
    );
    assert_eq!(moments(&store), 1);
    assert_eq!(store.table_row_count("engine_requests").expect("ledger"), 1);

    // Retry the same request id after recovery: exactly-once — replays to the
    // recorded result, no second moment.
    let retry = VersionedTextStore::new(&mut store)
        .write_text(&input, &NO_FAULTS)
        .expect("retry");
    assert!(retry.deduped);
    assert_eq!(moments(&store), 1);
    assert_eq!(store.table_row_count("engine_requests").expect("ledger"), 1);
}

// oracle: storage.before-persist — a mid-transaction crash rolls back;
// restart shows NO partial state (atomic rollback).
#[test]
fn crash_before_persist_leaves_no_partial_state() {
    let scratch = ScratchDir::new().expect("scratch dir");
    let db = engine_db_path(&scratch).expect("db path");
    let input = write("doc/ghost.md", "should vanish", "m1", Some("req-lost"), 7);

    {
        let mut store = open(&db, 7);
        let faults = ScriptedFaults::crash_at(FaultPoint::StorageBeforePersist);
        let err = VersionedTextStore::new(&mut store)
            .write_text(&input, faults.as_ref())
            .expect_err("crash before persist");
        assert_eq!(err.code(), "persist-failed");
    }

    // Restart: nothing from the rolled-back transaction survived.
    let mut store = open(&db, 8);
    assert_eq!(read(&mut store, "doc/ghost.md"), None);
    assert_eq!(moments(&store), 0);
    assert_eq!(store.table_row_count("file_objects").expect("objects"), 0);

    // The store is still writable after recovering from the rollback — the
    // same request id now legitimately applies exactly once.
    let redo = VersionedTextStore::new(&mut store)
        .write_text(&input, &NO_FAULTS)
        .expect("redo");
    assert!(!redo.deduped);
    assert_eq!(moments(&store), 1);
}

// oracle: storage.open-version-fingerprint-mismatch — a v1 database is
// rejected with the typed fence error, never migrated, and left byte-unchanged.
#[test]
fn v1_fingerprint_is_rejected_without_mutation() {
    let scratch = ScratchDir::new().expect("scratch dir");
    let db = engine_db_path(&scratch).expect("db path");
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
    let db = engine_db_path(&scratch).expect("db path");
    write_foreign_unversioned_db(&db).expect("write foreign db");

    assert_rejected_without_mutation(&db, "foreign-database");
}

// oracle: durability is pinned, not luck — `synchronous` reads back normal, so
// a weakened configuration fails this test.
#[test]
fn synchronous_is_pinned_to_normal() {
    let scratch = ScratchDir::new().expect("scratch dir");
    let db = engine_db_path(&scratch).expect("db path");
    let store = EngineStore::open(&db, 1).expect("open");
    assert_eq!(store.synchronous_setting().expect("synchronous"), 1);
}

// oracle: WAL replay on reopen — a committed write is recoverable from the WAL
// before any checkpoint folds it into the main file. A read-only keeper holds
// the database so the writer's close does not checkpoint.
#[test]
fn committed_write_replays_from_wal_on_reopen() {
    let scratch = ScratchDir::new().expect("scratch dir");
    let db = engine_db_path(&scratch).expect("db path");

    let keeper = {
        let mut writer = open(&db, 1);
        VersionedTextStore::new(&mut writer)
            .write_text(&write("d1.md", "replayed", "m1", None, 1), &NO_FAULTS)
            .expect("write");
        // The keeper holds an open read transaction across the writer's close,
        // which keeps SQLite from checkpointing (and deleting) the WAL.
        let keeper = open_readonly_keeper(&db).expect("keeper");
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
    let mut reopened = open(&db, 2);
    assert_eq!(read(&mut reopened, "d1.md").as_deref(), Some("replayed"));

    drop(reopened);
    drop(keeper);
}

// oracle: idempotency — a same-payload retry replays exactly-once; a key reused
// with a different payload is rejected, never silently replayed.
#[test]
fn idempotency_key_reuse_is_guarded() {
    let scratch = ScratchDir::new().expect("scratch dir");
    let db = engine_db_path(&scratch).expect("db path");
    let mut store = open(&db, 1);

    let first = write("doc/k.md", "original", "m1", Some("req-k"), 1);
    let ack = VersionedTextStore::new(&mut store)
        .write_text(&first, &NO_FAULTS)
        .expect("first");
    assert!(!ack.deduped);

    // Same key, same payload → exactly-once replay (no new moment).
    let retry = VersionedTextStore::new(&mut store)
        .write_text(&first, &NO_FAULTS)
        .expect("retry");
    assert!(retry.deduped);
    assert_eq!(moments(&store), 1);

    // Same key, different payload → typed mismatch, nothing written.
    let conflicting = write("doc/k.md", "tampered", "m1", Some("req-k"), 2);
    let err = VersionedTextStore::new(&mut store)
        .write_text(&conflicting, &NO_FAULTS)
        .expect_err("reuse must be rejected");
    assert_eq!(err.code(), "idempotency-key-reuse-mismatch");
    // The original text and single moment are untouched.
    assert_eq!(read(&mut store, "doc/k.md").as_deref(), Some("original"));
    assert_eq!(moments(&store), 1);
}

// oracle: close/reopen/mutate cycle — the reopened store stays writable and
// accumulates across sessions.
#[test]
fn close_reopen_mutate_cycle_stays_writable() {
    let scratch = ScratchDir::new().expect("scratch dir");
    let db = engine_db_path(&scratch).expect("db path");

    for round in 0..3_i64 {
        let mut store = open(&db, round + 1);
        let path = format!("doc-{round}.md");
        let moment = format!("m-{round}");
        let written = VersionedTextStore::new(&mut store)
            .write_text(&write(&path, "body", &moment, None, round + 1), &NO_FAULTS)
            .expect("write");
        assert!(!written.deduped);
        // Reopening never wipes: the row count grows by one each round.
        assert_eq!(moments(&store), round + 1);
        // Store dropped → connection closed before the next round reopens.
    }

    let store = open(&db, 99);
    assert_eq!(moments(&store), 3);
    // The ledger holds the baseline, groups, and agent-owner migrations once each.
    assert_eq!(
        store.table_row_count("engine_migrations").expect("ledger"),
        3
    );
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
