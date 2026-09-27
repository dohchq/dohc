//! Durable storage core: blob dedup/integrity, verified
//! restore-tested backups (+ disk-full + crash boundaries), corruption
//! classification with evidence preservation, and the materialization-job
//! ledger (+ phase-1 atomicity). Crash-injection cases are gated on the
//! `fault-injection` feature (armed workspace-wide by the testkit under
//! `cargo test --workspace`).

use dohc_engine_storage::{
    BackupOutcome, CorruptionKind, DiagnosticBundle, DisplacementResolution, DisplacementSpec,
    DisplacementState, EngineStore, FreeSpaceProbe, JobStatus, MaterializationJobSpec, NoFaults,
    Preimage, StorageError, classify, create_verified_backup, enqueue_job, hex_sha256,
    load_valid_backup,
};
use dohc_test_scratch::ScratchDir;
use rusqlite::config::DbConfig;
use rusqlite::{Connection, OptionalExtension};
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

/// Store `text` under `name` in the text blob table (keyed by the sha of the
/// name so a test can read it back by name).
fn write_doc(store: &mut EngineStore, name: &str, text: &str) {
    let key = hex_sha256(name.as_bytes());
    let outcome = store
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT INTO blobs (sha256, byte_length, text) VALUES (?1, ?2, ?3) \
                 ON CONFLICT(sha256) DO UPDATE SET text = excluded.text, \
                 byte_length = excluded.byte_length",
                rusqlite::params![key, text.len() as i64, text],
            )
            .map_err(StorageError::persist_public)?;
            Ok::<_, StorageError>(())
        })
        .expect("write");
    assert!(matches!(
        outcome,
        dohc_engine_storage::TxnOutcome::Committed(())
    ));
}

fn read_doc(store: &EngineStore, name: &str) -> Option<String> {
    let key = hex_sha256(name.as_bytes());
    store
        .read_with(|conn| {
            conn.query_row("SELECT text FROM blobs WHERE sha256 = ?1", [key], |row| {
                row.get(0)
            })
            .optional()
        })
        .expect("read")
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
        write_doc(&mut store, "doc-a", "alpha");
        write_doc(&mut store, "doc-b", "beta");
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
    assert_eq!(read_doc(&restored, "doc-a"), Some("alpha".to_owned()));
    assert_eq!(read_doc(&restored, "doc-b"), Some("beta".to_owned()));
}

#[test]
fn backup_disk_full_fails_closed_and_never_touches_source() {
    let scratch = Scratch::new("backup-full");
    let recovery = scratch.sub("recovery");
    let mut store = EngineStore::open(&scratch.db_path(), 1).expect("open");
    write_doc(&mut store, "doc-a", "important");

    // A probe reporting almost no space forces disk-full before any copy.
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
    assert_eq!(read_doc(&store, "doc-a"), Some("important".to_owned()));
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
        write_doc(&mut store, "doc-a", "data");

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
        assert_eq!(read_doc(&store, "doc-a"), Some("data".to_owned()));

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
        write_doc(&mut store, "doc-a", "data");

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
        assert_eq!(read_doc(&store, "doc-a"), Some("data".to_owned()));
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
            StorageError::MigratedByNewerBuild {
                ordinal: 5,
                id: "from-a-newer-build".to_owned(),
            },
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

/// The rows a newer build's migration commits: its table and a completed
/// ledger row after the last one this build defines.
const NEWER_BUILD_MIGRATION: &str = "
    BEGIN;
    CREATE TABLE from_a_newer_build (x INTEGER);
    INSERT INTO engine_migrations
        (ordinal, id, checksum, engine_build, protocol_version,
         transactional, started_at, completed_at, integrity_ok)
    SELECT MAX(ordinal) + 1, 'from-a-newer-build', 'newer', 'newer', 1, 1, 2, 2, 1
    FROM engine_migrations;
    COMMIT;";

/// A store a newer build migrated stops this build before any write, so a
/// newer build still opens it.
#[test]
fn a_store_a_newer_build_migrated_is_refused_and_left_byte_identical() {
    let scratch = Scratch::new("newer-build-fence");
    let db = scratch.db_path();
    {
        let mut store = EngineStore::open(&db, 1).expect("open");
        write_doc(&mut store, "doc-a", "kept");
    }
    {
        let conn = Connection::open(&db).expect("raw");
        conn.execute_batch(NEWER_BUILD_MIGRATION)
            .expect("a newer build migrates");
        conn.close().expect("close");
    }
    let wal = scratch.sub("engine.db-wal");
    assert!(!wal.exists(), "the last close checkpointed the WAL");
    let before = std::fs::read(&db).expect("read before");

    for refused in [
        EngineStore::open(&db, 2).unwrap_err(),
        EngineStore::open_read_only(&db).unwrap_err(),
    ] {
        assert_eq!(refused.code(), "migrated-by-newer-build");
        assert_eq!(classify(&refused), CorruptionKind::MigrationFailure);
    }

    let after = std::fs::read(&db).expect("read after");
    assert_eq!(before, after, "refused store left byte-identical");
    assert!(
        std::fs::metadata(&wal).map_or(true, |wal| wal.len() == 0),
        "no WAL frames left behind"
    );
}

/// A newer build that also stamps another schema version, zero included, is
/// still a newer build. Its store needs an update, never the rebuild that an
/// unsupported fingerprint or a foreign database offers.
#[test]
fn a_newer_build_that_restamps_the_schema_version_is_named_as_newer() {
    for version in [3, 0] {
        let scratch = Scratch::new(&format!("newer-build-version-{version}"));
        let db = scratch.db_path();
        drop(EngineStore::open(&db, 1).expect("open"));
        {
            let conn = Connection::open(&db).expect("raw");
            conn.execute_batch(NEWER_BUILD_MIGRATION)
                .expect("a newer build migrates");
            conn.pragma_update(None, "user_version", version)
                .expect("and stamps its own version");
            conn.close().expect("close");
        }
        let before = std::fs::read(&db).expect("read before");

        for refused in [
            EngineStore::open(&db, 2).unwrap_err(),
            EngineStore::open_read_only(&db).unwrap_err(),
        ] {
            assert_eq!(
                refused.code(),
                "migrated-by-newer-build",
                "user_version {version}"
            );
        }
        assert_eq!(
            std::fs::read(&db).expect("read after"),
            before,
            "refused store left byte-identical at user_version {version}"
        );
    }
}

/// A newer build that crashed leaves its last commit in the WAL. Refusing
/// its store must not checkpoint that commit into engine.db: both files stay
/// byte-identical, so no frame is lost or moved.
#[test]
fn refusing_a_newer_store_leaves_its_wal_frames_in_place() {
    let scratch = Scratch::new("newer-build-wal");
    let db = scratch.db_path();
    let wal = scratch.sub("engine.db-wal");
    drop(EngineStore::open(&db, 1).expect("open"));
    {
        let conn = Connection::open(&db).expect("raw");
        // The newer build crashes, so nothing checkpoints its commit.
        conn.set_db_config(DbConfig::SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE, true)
            .expect("no checkpoint on close");
        conn.execute_batch(NEWER_BUILD_MIGRATION)
            .expect("a newer build migrates");
        conn.close().expect("close");
    }
    let wal_before = std::fs::read(&wal).expect("the newer build's WAL");
    assert!(
        !wal_before.is_empty(),
        "the newer build's commit is in the WAL"
    );
    let before = std::fs::read(&db).expect("read before");

    let refused = EngineStore::open(&db, 2).unwrap_err();
    assert_eq!(refused.code(), "migrated-by-newer-build");

    assert_eq!(
        std::fs::read(&db).expect("read after"),
        before,
        "engine.db left byte-identical"
    );
    assert_eq!(
        std::fs::read(&wal).expect("the WAL after"),
        wal_before,
        "the WAL keeps every frame"
    );
}

#[test]
fn corrupt_page1_header_classifies_as_corruption_not_unsupported() {
    let scratch = Scratch::new("corrupt-header");
    let db = scratch.db_path();
    // A real store with data, then a garbage user_version stamped on top.
    {
        let mut store = EngineStore::open(&db, 1).expect("open");
        write_doc(&mut store, "doc-a", "payload-for-pages");
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
        write_doc(&mut store, "doc-a", "payload");
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
        // One transaction: upsert a document and enqueue its materialization
        // job. A crash before commit must roll back BOTH.
        let outcome = store
            .write_with(&faults, |tx| {
                tx.execute(
                    "INSERT INTO blobs (sha256, byte_length, text) VALUES ('d', 1, 'x')",
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
    let rows: i64 = store
        .read_with(|conn| {
            conn.query_row("SELECT COUNT(*) FROM blobs WHERE sha256 = 'd'", [], |row| {
                row.get(0)
            })
        })
        .expect("count");
    assert_eq!(rows, 0, "row rolled back");
    assert_eq!(
        store.pending_materialization_count().expect("jobs"),
        0,
        "job rolled back"
    );
}

// ---------------------------------------------------------------------------
// transient contention
// ---------------------------------------------------------------------------

/// Real contention, not an injected variant: a second connection holds the
/// write lock and the store's own transaction is refused.
///
/// `StorageError::FileLocked` had NO producer anywhere in the engine. Its
/// doc-comment described a busy SQLite handle, `diagnostics` classified it
/// `TransientLock`, and the whole taxonomy above it answered a condition
/// nothing ever raised — every genuine `SQLITE_BUSY` went to
/// `StorageError::persist` and reached callers as terminal `persist-failed`.
///
/// This test is the reachability proof, so it uses no fault injection and
/// builds no error by hand: it makes SQLite say busy and reads what the store
/// returns. The wait is the store's own `ENGINE_SQLITE_BUSY_TIMEOUT_MS`
/// budget, which is what "the retry budget was exhausted" means.
///
#[test]
fn a_genuinely_busy_database_is_reported_as_the_transient_lock() {
    let scratch = Scratch::new("busy-contention");
    let path = scratch.db_path();
    let mut store = EngineStore::open(&path, 1_000).expect("open the engine store");

    // A second connection takes the write lock and keeps it.
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
        "real SQLITE_BUSY is not the transient lock, it is {refused:?}"
    );
    assert_eq!(refused.code(), "file-locked");
    // The store is intact, which is the half that makes it retryable: the
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

// ---------------------------------------------------------------------------
// materialization displacements
// ---------------------------------------------------------------------------

fn displacement_spec(job_id: &str, displaced_name: &str) -> DisplacementSpec {
    DisplacementSpec {
        job_id: job_id.to_owned(),
        workspace_id: "ws".to_owned(),
        target_path: "notes/a.md".to_owned(),
        displaced_name: displaced_name.to_owned(),
        expected_sha256: hex_sha256(b"preimage"),
        content_sha256: Some(hex_sha256(b"content")),
        now_ms: 5,
    }
}

#[test]
fn displacement_group_commit_rolls_back_every_row_on_failure() {
    let sc = Scratch::new("displacement-batch");
    let store = EngineStore::open(&sc.db_path(), 1).expect("open");
    let one = displacement_spec("j1", "6a31.0");
    let mut invalid = displacement_spec("j2", "6a32.0");
    invalid.displaced_name = one.displaced_name.clone();
    // Duplicate names may not be unique in old stores; force a trigger error
    // after the first insertion to prove transaction-wide rollback.
    let conn = Connection::open(sc.db_path()).expect("connection");
    conn.execute_batch("CREATE TRIGGER reject_second BEFORE INSERT ON materialization_displacements WHEN NEW.job_id = 'j2' BEGIN SELECT RAISE(ABORT, 'injected'); END;").expect("trigger");
    assert!(store.open_displacements(&[one.clone(), invalid]).is_err());
    assert!(
        store
            .list_unsettled_displacements()
            .expect("rows")
            .is_empty()
    );
    conn.execute_batch("DROP TRIGGER reject_second")
        .expect("drop trigger");
    let ids = store
        .open_displacements(&[one, displacement_spec("j2", "6a32.0")])
        .expect("batch");
    assert_eq!(ids.len(), 2);
    assert_eq!(store.list_unsettled_displacements().expect("rows").len(), 2);
}

/// A row moves open, then kept or deleted, and its job's status changes in
/// the same transaction as the row's end. A row can also start kept.
#[test]
fn a_displacement_resolves_with_its_job_in_one_transaction() {
    let sc = Scratch::new("displacements");
    let mut store = EngineStore::open(&sc.db_path(), 1).expect("open");
    let content = b"content";
    let sha = store.put_binary_blob(content).expect("blob");
    store
        .write_with(&NoFaults, |tx| {
            enqueue_job(
                tx,
                &MaterializationJobSpec {
                    job_id: "j1".to_owned(),
                    workspace_id: "ws".to_owned(),
                    target_path: "notes/a.md".to_owned(),
                    content_sha256: sha.clone(),
                    preimage: Preimage::Absent,
                    target_generation: 1,
                    now_ms: 1,
                },
            )?;
            Ok::<_, StorageError>(())
        })
        .expect("enqueue");
    let returned = store
        .open_displacement(&displacement_spec("j1", "6a31.0"))
        .expect("open returned");
    let kept = store
        .open_displacement(&displacement_spec("j2", "6a32.0"))
        .expect("open kept");
    assert!(
        store
            .path_is_displaced("ws", "notes/a.md")
            .expect("displaced")
    );
    assert_eq!(
        store.synchronous_setting().expect("synchronous"),
        1,
        "opening a row syncs that one commit and leaves the session at NORMAL"
    );
    assert_eq!(
        store.list_displacements_for_job("j1").expect("for job")[0].state,
        DisplacementState::Open
    );
    assert!(store.displacement_named("6a31.0").expect("named"));
    assert!(!store.displacement_named("6a31.1").expect("named"));

    store
        .resolve_displacement(
            returned,
            DisplacementResolution::Discard,
            Some(("j1", JobStatus::Complete)),
            9,
        )
        .expect("discard");
    assert_eq!(
        store
            .load_materialization_job("j1")
            .expect("load")
            .expect("job")
            .status,
        JobStatus::Complete
    );
    let outside = hex_sha256(b"outside");
    store
        .resolve_displacement(
            kept,
            DisplacementResolution::Keep {
                displaced_sha256: Some(&outside),
            },
            None,
            10,
        )
        .expect("keep");
    assert!(!store.displacement_named("6a31.0").expect("named"));

    assert!(
        !store
            .path_is_displaced("ws", "notes/a.md")
            .expect("displaced")
    );
    assert!(
        store
            .list_unsettled_displacements()
            .expect("unsettled")
            .is_empty()
    );

    // A staged file that stays where it is starts kept, in an ordinary
    // commit. With no hash it stays unsettled, so a sweep reads it again.
    store
        .keep_displacement(&displacement_spec("j3", "6a33.0"), None)
        .expect("keep unread");
    assert_eq!(
        store.list_unsettled_displacements().expect("unsettled")[0].job_id,
        "j3"
    );
    assert!(
        !store
            .path_is_displaced("ws", "notes/a.md")
            .expect("displaced"),
        "a kept file is not going back"
    );
    let evidence = store.list_kept_displacements("ws").expect("kept");
    assert_eq!(evidence.len(), 2);
    assert_eq!(evidence[0].displacement_id, kept);
    assert_eq!(
        evidence[0].displaced_sha256.as_deref(),
        Some(outside.as_str())
    );
    assert_eq!(evidence[1].state, DisplacementState::Kept);
    assert_eq!(evidence[1].displaced_sha256, None);
    assert!(
        store
            .list_kept_displacements("other")
            .expect("other")
            .is_empty()
    );
    assert!(store.holds_content(&sha).expect("holds"));
    assert!(!store.holds_content(&outside).expect("holds"));
}
