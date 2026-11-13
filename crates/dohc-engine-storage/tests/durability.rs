//! Durable storage core: blob dedup/integrity, verified
//! restore-tested backups (+ disk-full + crash boundaries), corruption
//! classification with evidence preservation, and the materialization-job
//! ledger (+ phase-1 atomicity). Crash-injection cases are gated on the
//! `fault-injection` feature (armed workspace-wide by the testkit under
//! `cargo test --workspace`).

use dohc_engine_storage::{
    BackupOutcome, CorruptionKind, DisplacementResolution, DisplacementSpec, DisplacementState,
    EngineStore, FreeSpaceProbe, JobStatus, MaterializationJobSpec, NoFaults, Preimage,
    StorageError, classify, create_verified_backup, enqueue_job, hex_sha256, load_valid_backup,
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
fn materialization_reads_text_without_copy_and_checks_integrity() {
    let scratch = Scratch::new("materialization-text");
    let store = EngineStore::open(&scratch.db_path(), 1).unwrap();
    let sha = hex_sha256(b"text");
    store
        .read_with(|conn| {
            conn.execute(
                "INSERT INTO blobs (sha256, byte_length, text) VALUES (?1, 4, 'text')",
                [&sha],
            )
        })
        .unwrap();
    assert_eq!(
        store.get_materialization_blob(&sha).unwrap(),
        Some(b"text".to_vec())
    );
    assert_eq!(store.binary_blob_count().unwrap(), 0);
    store
        .read_with(|conn| conn.execute("UPDATE blobs SET text='oops' WHERE sha256=?1", [&sha]))
        .unwrap();
    assert!(matches!(
        store.get_materialization_blob(&sha),
        Err(StorageError::BlobIntegrity { .. })
    ));
    store
        .read_with(|conn| {
            conn.execute(
                "UPDATE blobs SET text='text', byte_length=3 WHERE sha256=?1",
                [&sha],
            )
        })
        .unwrap();
    assert!(matches!(
        store.get_materialization_blob(&sha),
        Err(StorageError::BlobIntegrity { .. })
    ));
    let binary = store.put_binary_blob(&[0, 255]).unwrap();
    assert_eq!(
        store.get_materialization_blob(&binary).unwrap(),
        Some(vec![0, 255])
    );
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
}

// ---------------------------------------------------------------------------
// corruption classification + diagnostics
// ---------------------------------------------------------------------------

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
    assert!(
        store
            .displacement_names()
            .expect("names")
            .contains("6a31.0")
    );
    assert!(
        !store
            .displacement_names()
            .expect("names")
            .contains("6a31.1")
    );

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
    assert!(
        !store
            .displacement_names()
            .expect("names")
            .contains("6a31.0")
    );

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
