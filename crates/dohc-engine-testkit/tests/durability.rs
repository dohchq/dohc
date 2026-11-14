//! Store-level durability and crash-recovery traces: mutate, (crash), reopen,
//! compare, and where relevant mutate again to prove the reopened store stays
//! writable.

use dohc_engine_domain::{VersionedTextStore, WriteText};
use dohc_engine_storage::{EngineStore, FaultPoint, NoFaults};
use dohc_engine_testkit::harness::{wal_sidecar, write_foreign_unversioned_db};
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

// oracle: storage init never writes over a non-empty foreign database, and
// leaves it byte-unchanged.
#[test]
fn foreign_unversioned_database_is_rejected_without_mutation() {
    let scratch = ScratchDir::new().expect("scratch dir");
    let db = engine_db_path(&scratch).expect("db path");
    write_foreign_unversioned_db(&db).expect("write foreign db");

    assert_rejected_without_mutation(&db, "foreign-database");
}
