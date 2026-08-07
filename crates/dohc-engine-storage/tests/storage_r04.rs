//! R04 durable-storage-core integration tests: blob dedup/integrity, verified
//! restore-tested backups (+ disk-full + crash boundaries), corruption
//! classification with evidence preservation, and the materialization-job
//! ledger (+ phase-1 atomicity). Crash-injection cases are gated on the
//! `fault-injection` feature (armed workspace-wide by the testkit under
//! `cargo test --workspace`).

use dohc_engine_storage::{
    BackupOutcome, CorruptionKind, DiagnosticBundle, EngineStore, FreeSpaceProbe,
    MaterializationJobSpec, NoFaults, Preimage, StorageError, classify, create_verified_backup,
    enqueue_job, hex_sha256, load_valid_backup,
};
use dohc_test_scratch::ScratchDir;
use rusqlite::Connection;
use std::io::{Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

// ---------------------------------------------------------------------------
// scratch dir helper
// ---------------------------------------------------------------------------

struct Scratch {
    root: ScratchDir,
}
impl Scratch {
    fn new(tag: &str) -> Self {
        let root = ScratchDir::new_named(&format!("r04-{tag}")).expect("mkdir scratch");
        Scratch { root }
    }
    fn db_path(&self) -> PathBuf {
        self.root.join("engine.db")
    }
    fn sub(&self, name: &str) -> PathBuf {
        self.root.join(name)
    }
}
/// A free-space probe returning a fixed number, so disk-full is testable without
/// filling a disk.
struct FakeSpace(u64);
impl FreeSpaceProbe for FakeSpace {
    fn available_bytes(&self, _path: &Path) -> Result<u64, StorageError> {
        Ok(self.0)
    }
}

fn write_doc(store: &mut EngineStore, req: &str, doc: &str, body: &str, now: i64) {
    let write = dohc_engine_storage::CompoundWrite {
        request_id: req.to_owned(),
        doc_id: doc.to_owned(),
        body: body.to_owned(),
        op_kind: "text.write".to_owned(),
        now_ms: now,
    };
    store.commit_compound(&write, &NoFaults).expect("write");
}

// ---------------------------------------------------------------------------
// blobs
// ---------------------------------------------------------------------------

#[test]
fn binary_blob_dedup_and_readback() {
    let scratch = Scratch::new("blob");
    let store = EngineStore::open(&scratch.db_path(), 1).expect("open");

    let a = store.put_binary_blob(b"hello world").expect("put a");
    let a2 = store.put_binary_blob(b"hello world").expect("put a again");
    let b = store.put_binary_blob(b"different").expect("put b");

    assert_eq!(a, a2, "identical content dedups to one key");
    assert_ne!(a, b);
    assert_eq!(
        store.binary_blob_count().expect("count"),
        2,
        "dedup: 2 rows"
    );
    assert_eq!(
        store.get_binary_blob(&a).expect("get"),
        Some(b"hello world".to_vec())
    );
    assert_eq!(a, hex_sha256(b"hello world"), "key is the content sha-256");
    assert!(store.get_binary_blob("00").expect("miss").is_none());
}

#[test]
fn binary_blob_integrity_check_fails_closed_on_tampered_bytes() {
    let scratch = Scratch::new("blob-tamper");
    let key = hex_sha256(b"authentic");
    {
        let store = EngineStore::open(&scratch.db_path(), 1).expect("open");
        store.put_binary_blob(b"authentic").expect("put");
        drop(store);
    }
    // Tamper: overwrite the bytes under the same key via a raw connection.
    {
        let conn = Connection::open(scratch.db_path()).expect("raw open");
        conn.execute(
            "UPDATE binary_blobs SET bytes = ?1 WHERE sha256 = ?2",
            rusqlite::params![b"CORRUPTED".to_vec(), key],
        )
        .expect("tamper");
        conn.close().expect("close");
    }
    let store = EngineStore::open(&scratch.db_path(), 2).expect("reopen");
    let err = store.get_binary_blob(&key).unwrap_err();
    assert_eq!(err.code(), "blob-integrity");
}

// ---------------------------------------------------------------------------
// backups
// ---------------------------------------------------------------------------

#[test]
fn verified_backup_restore_roundtrips_the_data() {
    let scratch = Scratch::new("backup-ok");
    let recovery = scratch.sub("recovery"); // outside the (nonexistent) workspace root
    {
        let mut store = EngineStore::open(&scratch.db_path(), 1).expect("open");
        write_doc(&mut store, "r1", "doc-a", "alpha", 10);
        write_doc(&mut store, "r2", "doc-b", "beta", 20);
        store.put_binary_blob(b"blobby").expect("blob");

        let outcome = create_verified_backup(
            &store,
            &recovery,
            "snapshot",
            "periodic",
            999,
            &FakeSpace(1 << 30),
            &NoFaults,
        )
        .expect("backup");
        let record = match outcome {
            BackupOutcome::Verified(r) => r,
            other => panic!("expected verified backup, got {other:?}"),
        };
        assert!(record.manifest.verified);
        assert!(record.backup_path.exists(), "backup db present");
        assert!(record.manifest_path.exists(), "manifest present");
        assert!(!record.manifest.engine_uuid.is_empty());
    }
    // Open the backup copy as a full engine store and prove the data survived.
    let backup_db = recovery.join("snapshot.db");
    let restored = EngineStore::open(&backup_db, 1000).expect("open backup as store");
    assert_eq!(
        restored.read_document("doc-a").expect("a").map(|d| d.body),
        Some("alpha".to_owned())
    );
    assert_eq!(
        restored.read_document("doc-b").expect("b").map(|d| d.body),
        Some("beta".to_owned())
    );
}

#[test]
fn backup_disk_full_fails_closed_and_never_touches_source() {
    let scratch = Scratch::new("backup-full");
    let recovery = scratch.sub("recovery");
    let mut store = EngineStore::open(&scratch.db_path(), 1).expect("open");
    write_doc(&mut store, "r1", "doc-a", "important", 10);

    // A probe reporting almost no space forces disk-full BEFORE any copy.
    let err = create_verified_backup(
        &store,
        &recovery,
        "snapshot",
        "periodic",
        999,
        &FakeSpace(1),
        &NoFaults,
    )
    .unwrap_err();
    assert_eq!(err.code(), "disk-full");
    // The only valid source is untouched and still readable.
    assert_eq!(
        store.read_document("doc-a").expect("a").map(|d| d.body),
        Some("important".to_owned())
    );
    assert!(
        !recovery.join("snapshot.db").exists(),
        "no partial backup left"
    );
}

#[cfg(feature = "fault-injection")]
mod backup_crash {
    use super::*;
    use dohc_engine_storage::{FaultAction, FaultInjector, FaultPoint};
    use std::sync::atomic::{AtomicBool, Ordering};

    struct OneShot {
        point: FaultPoint,
        armed: AtomicBool,
    }
    impl OneShot {
        fn at(point: FaultPoint) -> Self {
            OneShot {
                point,
                armed: AtomicBool::new(true),
            }
        }
    }
    impl FaultInjector for OneShot {
        fn poll(&self, point: FaultPoint) -> FaultAction {
            if point == self.point && self.armed.swap(false, Ordering::AcqRel) {
                FaultAction::Crash
            } else {
                FaultAction::Continue
            }
        }
    }

    #[test]
    fn crash_after_copy_before_manifest_leaves_invalid_by_absence_then_retry_succeeds() {
        let scratch = Scratch::new("backup-crash-copy");
        let recovery = scratch.sub("recovery");
        let mut store = EngineStore::open(&scratch.db_path(), 1).expect("open");
        write_doc(&mut store, "r1", "doc-a", "data", 10);

        let faults = OneShot::at(FaultPoint::BackupAfterCopyBeforeManifest);
        let outcome = create_verified_backup(
            &store,
            &recovery,
            "snapshot",
            "periodic",
            999,
            &FakeSpace(1 << 30),
            &faults,
        )
        .expect("backup");
        assert!(matches!(
            outcome,
            BackupOutcome::Crashed { after_copy: true }
        ));
        // Bytes may exist, but with NO manifest the backup is invalid-by-absence.
        assert!(
            !recovery.join("snapshot.manifest.json").exists(),
            "no manifest"
        );
        // Source intact.
        assert_eq!(
            store.read_document("doc-a").expect("a").map(|d| d.body),
            Some("data".to_owned())
        );

        // Retry produces a fresh verified backup.
        let retry = create_verified_backup(
            &store,
            &recovery,
            "snapshot",
            "periodic",
            1001,
            &FakeSpace(1 << 30),
            &NoFaults,
        )
        .expect("retry");
        assert!(matches!(retry, BackupOutcome::Verified(_)));
        assert!(
            recovery.join("snapshot.manifest.json").exists(),
            "manifest after retry"
        );
    }

    #[test]
    fn crash_during_restore_verify_never_sets_verified_and_source_untouched() {
        let scratch = Scratch::new("backup-crash-verify");
        let recovery = scratch.sub("recovery");
        let mut store = EngineStore::open(&scratch.db_path(), 1).expect("open");
        write_doc(&mut store, "r1", "doc-a", "data", 10);

        let faults = OneShot::at(FaultPoint::BackupDuringRestoreVerify);
        let outcome = create_verified_backup(
            &store,
            &recovery,
            "snapshot",
            "periodic",
            999,
            &FakeSpace(1 << 30),
            &faults,
        )
        .expect("backup");
        assert!(matches!(outcome, BackupOutcome::Crashed { .. }));
        assert!(
            !recovery.join("snapshot.manifest.json").exists(),
            "verified flag never persisted"
        );
        assert_eq!(
            store.read_document("doc-a").expect("a").map(|d| d.body),
            Some("data".to_owned())
        );
    }
}

// ---------------------------------------------------------------------------
// corruption classification + diagnostics
// ---------------------------------------------------------------------------

#[test]
fn corruption_kinds_are_distinct_per_error_family() {
    let cases: &[(StorageError, CorruptionKind)] = &[
        (
            StorageError::UnsupportedFingerprint {
                found: 1,
                expected: 2,
            },
            CorruptionKind::UnsupportedFingerprint,
        ),
        (
            StorageError::MigrationFailed { source: None },
            CorruptionKind::MigrationFailure,
        ),
        (
            StorageError::DiskFull {
                needed: 10,
                available: 1,
            },
            CorruptionKind::DiskFull,
        ),
        (
            StorageError::PermissionDenied { source: None },
            CorruptionKind::Permission,
        ),
        (StorageError::FileLocked, CorruptionKind::TransientLock),
        (
            StorageError::StateCorrupt { source: None },
            CorruptionKind::Corruption,
        ),
        (StorageError::ForeignDatabase, CorruptionKind::Corruption),
    ];
    for (err, expected) in cases {
        assert_eq!(classify(err), *expected, "classify {}", err.code());
    }
    // Every kind has a distinct code.
    let codes = [
        CorruptionKind::UnsupportedFingerprint.code(),
        CorruptionKind::MigrationFailure.code(),
        CorruptionKind::Corruption.code(),
        CorruptionKind::Permission.code(),
        CorruptionKind::DiskFull.code(),
        CorruptionKind::TransientLock.code(),
    ];
    let unique: std::collections::HashSet<_> = codes.iter().collect();
    assert_eq!(unique.len(), codes.len(), "codes are distinct");
}

#[test]
fn unsupported_fingerprint_open_is_refused_and_preserves_evidence() {
    let scratch = Scratch::new("v1-fence");
    let db = scratch.db_path();
    // Build a v1 (foreign-fingerprint) database with a table.
    {
        let conn = Connection::open(&db).expect("raw");
        conn.execute_batch("CREATE TABLE legacy (x INTEGER);")
            .expect("ddl");
        conn.pragma_update(None, "user_version", 1).expect("uv");
        conn.close().expect("close");
    }
    let before = std::fs::read(&db).expect("read before");

    let err = EngineStore::open(&db, 1).unwrap_err();
    assert_eq!(err.code(), "unsupported-fingerprint");
    assert_eq!(classify(&err), CorruptionKind::UnsupportedFingerprint);

    // Original DB preserved byte-for-byte (never initialized-over).
    let after = std::fs::read(&db).expect("read after");
    assert_eq!(before, after, "rejected store left byte-unchanged");

    // Redacted diagnostic bundle: no absolute path, valid classification.
    let bundle = DiagnosticBundle::for_open_failure(&err, None, &db, 5);
    let json = bundle.to_json();
    assert!(json.contains("\"unsupported-fingerprint\""));
    let root_str = scratch.root.to_string_lossy().to_string();
    assert!(!json.contains(&root_str), "no absolute path in the bundle");
    // Evidence lists the file basename only.
    assert!(bundle.evidence.iter().any(|e| e == "engine.db"));
}

#[test]
fn corrupt_page1_header_classifies_as_corruption_not_unsupported() {
    let scratch = Scratch::new("corrupt-header");
    let db = scratch.db_path();
    // A real store with data, then a garbage user_version stamped on top.
    {
        let mut store = EngineStore::open(&db, 1).expect("open");
        write_doc(&mut store, "r1", "doc-a", "payload-for-pages", 10);
        drop(store);
    }
    {
        let conn = Connection::open(&db).expect("raw");
        conn.pragma_update(None, "user_version", 99).expect("uv");
        conn.close().expect("close");
    }
    // Corrupt page-2 bytes so integrity is genuinely broken (a garbled header
    // that merely changed user_version would otherwise read as a foreign
    // fingerprint). Wipe the WAL/SHM first so the main file is authoritative.
    let _ = std::fs::remove_file(scratch.root.join("engine.db-wal"));
    let _ = std::fs::remove_file(scratch.root.join("engine.db-shm"));
    {
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .open(&db)
            .expect("open db");
        f.seek(SeekFrom::Start(4096)).expect("seek");
        f.write_all(&[0xFFu8; 1024]).expect("corrupt");
        f.sync_all().expect("sync");
    }

    let err = EngineStore::open(&db, 2).unwrap_err();
    // A corrupt store must be classified corruption ("restore from backup"),
    // never unsupported-fingerprint ("export/reset").
    assert_eq!(
        classify(&err),
        CorruptionKind::Corruption,
        "err was {}",
        err.code()
    );
    assert_ne!(err.code(), "unsupported-fingerprint");
}

// ---------------------------------------------------------------------------
// backup validator
// ---------------------------------------------------------------------------

#[test]
fn load_valid_backup_enforces_manifest_presence_and_checksum() {
    let scratch = Scratch::new("backup-validate");
    let recovery = scratch.sub("recovery");
    {
        let mut store = EngineStore::open(&scratch.db_path(), 1).expect("open");
        write_doc(&mut store, "r1", "doc-a", "payload", 10);
        let outcome = create_verified_backup(
            &store,
            &recovery,
            "snap",
            "periodic",
            99,
            &FakeSpace(1 << 30),
            &NoFaults,
        )
        .expect("backup");
        assert!(matches!(outcome, BackupOutcome::Verified(_)));
    }
    // Valid pair loads.
    assert!(
        load_valid_backup(&recovery, "snap")
            .expect("load")
            .is_some()
    );

    // (a) Missing manifest ⇒ invalid-by-absence ⇒ None.
    std::fs::remove_file(recovery.join("snap.manifest.json")).expect("rm manifest");
    assert!(
        load_valid_backup(&recovery, "snap")
            .expect("load")
            .is_none()
    );

    // Recreate a fresh valid backup, then (b) tamper the db bytes ⇒ checksum
    // mismatch ⇒ None.
    {
        let store = EngineStore::open(&scratch.db_path(), 2).expect("reopen");
        create_verified_backup(
            &store,
            &recovery,
            "snap",
            "periodic",
            100,
            &FakeSpace(1 << 30),
            &NoFaults,
        )
        .expect("backup2");
    }
    assert!(
        load_valid_backup(&recovery, "snap")
            .expect("load")
            .is_some()
    );
    {
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .open(recovery.join("snap.db"))
            .expect("open backup");
        f.seek(SeekFrom::Start(4096)).expect("seek");
        f.write_all(&[0x00u8; 64]).expect("tamper");
        f.sync_all().expect("sync");
    }
    assert!(
        load_valid_backup(&recovery, "snap")
            .expect("load")
            .is_none(),
        "tampered bytes must fail the checksum check"
    );
}

// ---------------------------------------------------------------------------
// materialization job ledger
// ---------------------------------------------------------------------------

fn job_spec(id: &str, path: &str, content_sha: &str, now: i64) -> MaterializationJobSpec {
    MaterializationJobSpec {
        job_id: id.to_owned(),
        workspace_id: "ws".to_owned(),
        target_path: path.to_owned(),
        content_sha256: content_sha.to_owned(),
        preimage: Preimage::Absent,
        target_generation: 1,
        now_ms: now,
    }
}

#[test]
fn materialization_job_lifecycle_transitions() {
    let scratch = Scratch::new("job-life");
    let mut store = EngineStore::open(&scratch.db_path(), 1).expect("open");
    let sha = store.put_binary_blob(b"content").expect("blob");

    // Enqueue two jobs in one transaction (phase-1 atomicity is type-enforced:
    // `enqueue_job` demands a `&Transaction`, so this cannot compile on an
    // autocommit connection).
    store
        .write_with(&NoFaults, |tx| {
            enqueue_job(tx, &job_spec("j1", "notes/a.md", &sha, 10))?;
            enqueue_job(tx, &job_spec("j2", "notes/b.md", &sha, 11))?;
            Ok::<_, StorageError>(())
        })
        .expect("enqueue");

    assert_eq!(store.pending_materialization_count().expect("count"), 2);
    let pending = store.list_pending_materialization_jobs().expect("list");
    assert_eq!(pending.len(), 2);
    assert_eq!(pending[0].job_id, "j1", "oldest first");

    store
        .mark_materialization_complete("j1", 20)
        .expect("complete");
    assert_eq!(store.pending_materialization_count().expect("count2"), 1);
    store
        .mark_materialization_conflict("j2", 21)
        .expect("conflict");
    assert_eq!(store.pending_materialization_count().expect("count3"), 0);

    let j2 = store
        .load_materialization_job("j2")
        .expect("load")
        .expect("some");
    assert_eq!(j2.status, dohc_engine_storage::JobStatus::Conflict);
}

#[test]
fn completed_generation_watermarks_are_workspace_scoped() {
    let scratch = Scratch::new("job-workspace-watermark");
    let mut store = EngineStore::open(&scratch.db_path(), 1).expect("open");
    let sha = store.put_binary_blob(b"content").expect("blob");
    let mut workspace_a = job_spec("a-job", "shared.bin", &sha, 10);
    workspace_a.workspace_id = "workspace-a".to_owned();
    workspace_a.target_generation = 4;
    let mut workspace_b = job_spec("b-job", "shared.bin", &sha, 11);
    workspace_b.workspace_id = "workspace-b".to_owned();
    workspace_b.target_generation = 9;
    store
        .write_with(&NoFaults, |tx| {
            enqueue_job(tx, &workspace_a)?;
            enqueue_job(tx, &workspace_b)?;
            Ok::<_, StorageError>(())
        })
        .expect("enqueue");
    store
        .mark_materialization_complete("b-job", 12)
        .expect("complete B");

    assert_eq!(
        store
            .max_completed_generation_for_path("workspace-a", "shared.bin")
            .expect("workspace A watermark"),
        None
    );
    assert_eq!(
        store
            .max_completed_generation_for_path("workspace-b", "shared.bin")
            .expect("workspace B watermark"),
        Some(9)
    );

    store
        .mark_materialization_complete("a-job", 13)
        .expect("complete A");
    assert_eq!(
        store
            .max_completed_generation_for_path("workspace-a", "shared.bin")
            .expect("workspace A completed watermark"),
        Some(4)
    );
}

#[cfg(feature = "fault-injection")]
#[test]
fn job_and_canonical_state_commit_atomically() {
    use dohc_engine_storage::{FaultAction, FaultInjector, FaultPoint, TxnOutcome};
    use std::sync::atomic::{AtomicBool, Ordering};

    struct OneShot {
        armed: AtomicBool,
    }
    impl FaultInjector for OneShot {
        fn poll(&self, point: FaultPoint) -> FaultAction {
            if point == FaultPoint::StorageBeforePersist && self.armed.swap(false, Ordering::AcqRel)
            {
                FaultAction::Crash
            } else {
                FaultAction::Continue
            }
        }
    }

    let scratch = Scratch::new("job-atomic");
    let db = scratch.db_path();
    {
        let mut store = EngineStore::open(&db, 1).expect("open");
        let sha = store.put_binary_blob(b"content").expect("blob");
        let faults = OneShot {
            armed: AtomicBool::new(true),
        };
        // One transaction: upsert a document AND enqueue its materialization
        // job. A crash before commit must roll back BOTH.
        let outcome = store
            .write_with(&faults, |tx| {
                tx.execute(
                    "INSERT INTO documents (doc_id, body, updated_at_ms) VALUES ('d','x',1)",
                    [],
                )
                .map_err(StorageError::persist_public)?;
                enqueue_job(tx, &job_spec("jx", "a.md", &sha, 5))?;
                Ok::<_, StorageError>(())
            })
            .expect("write_with");
        assert!(matches!(outcome, TxnOutcome::Crashed { committed: false }));
        drop(store);
    }
    // Reopen: neither the document nor the job survived the rolled-back txn.
    let store = EngineStore::open(&db, 2).expect("reopen");
    assert!(
        store.read_document("d").expect("doc").is_none(),
        "doc rolled back"
    );
    assert_eq!(
        store.pending_materialization_count().expect("jobs"),
        0,
        "job rolled back"
    );
}

// ---------------------------------------------------------------------------
// transient contention (#658)
// ---------------------------------------------------------------------------

/// REAL contention, not an injected variant: a second connection holds the
/// write lock and the store's own transaction is refused.
///
/// `StorageError::FileLocked` had NO producer anywhere in the engine. Its
/// doc-comment described a busy SQLite handle, `diagnostics` classified it
/// `TransientLock`, and the whole taxonomy above it answered a condition
/// nothing ever raised — every genuine `SQLITE_BUSY` went to
/// `StorageError::persist` and reached callers as terminal `persist-failed`.
///
/// This test is the reachability proof, so it uses no fault injection and
/// builds no error by hand: it makes SQLite say BUSY and reads what the store
/// returns. The wait is the store's own `ENGINE_SQLITE_BUSY_TIMEOUT_MS`
/// budget, which is what "the retry budget was exhausted" means.
///
/// MUTATION: drop the `is_busy` check from `StorageError::persist` -> this
/// reports `persist-failed`, the answer that made the busy store terminal.
#[test]
fn a_genuinely_busy_database_is_reported_as_the_transient_lock() {
    let scratch = Scratch::new("busy-contention");
    let path = scratch.db_path();
    let mut store = EngineStore::open(&path, 1_000).expect("open the engine store");

    // A SECOND connection takes the write lock and keeps it.
    let blocker = Connection::open(&path).expect("open a second connection");
    blocker
        .execute_batch("BEGIN IMMEDIATE")
        .expect("the blocker takes the write lock");

    // The store's own write now waits out its busy budget and is refused.
    let refused = store
        .write_with(&NoFaults, |tx| {
            tx.execute_batch("CREATE TABLE IF NOT EXISTS r3_probe (id INTEGER)")
                .map_err(StorageError::persist_public)
        })
        .expect_err("a held write lock must refuse this transaction");

    assert!(
        matches!(refused, StorageError::FileLocked),
        "MUTATION: real SQLITE_BUSY is not the transient lock, it is {refused:?}"
    );
    assert_eq!(refused.code(), "file-locked");
    // The store is INTACT, which is the half that makes it retryable: the
    // same write succeeds once the blocker lets go.
    blocker
        .execute_batch("ROLLBACK")
        .expect("the blocker releases the write lock");
    store
        .write_with(&NoFaults, |tx| {
            tx.execute_batch("CREATE TABLE IF NOT EXISTS r3_probe (id INTEGER)")
                .map_err(StorageError::persist_public)
        })
        .expect("the same write lands once the contention clears");
}

/// The narrowness guard. `is_busy` reads the SQLite result code, so an
/// ordinary SQL failure must keep its terminal answer — otherwise every
/// persist failure would advertise a retry that cannot help.
///
/// MUTATION: return `true` unconditionally from `is_busy` -> this reports
/// `file-locked` for a plain syntax error.
#[test]
fn an_ordinary_sql_failure_is_still_terminal() {
    let scratch = Scratch::new("busy-narrowness");
    let mut store = EngineStore::open(&scratch.db_path(), 1_000).expect("open the engine store");
    let refused = store
        .write_with(&NoFaults, |tx| {
            tx.execute_batch("THIS IS NOT SQL")
                .map_err(StorageError::persist_public)
        })
        .expect_err("a malformed statement must fail");
    assert_eq!(refused.code(), "persist-failed");
}
