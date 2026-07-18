//! Adversarial regression tests for the rehearsal state machine: crash-resume
//! preconditions, forged/torn state markers, backup integrity, fence shape
//! attacks, and the live db's own clone binding.

use super::backup::{db_backup_stem, load_valid_directory_backup};
use super::faults::{FaultPoint, NoFaults, ScriptedFaults};
use super::handles::{acquire_copy_hash_close, move_aside, moved_aside_path};
use super::state::BackupFingerprint;
use super::*;
use crate::shadow_fence::write_shadow_marker_for_harness;
use dohc_engine_storage::{EngineStore, load_valid_backup};
use dohc_engine_testkit::ScratchDir;
use std::path::{Path, PathBuf};

const SHADOW_TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const REHEARSAL_TOKEN: &str = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
const NOW_MS: i64 = 1_753_000_000_000;

struct Fixture {
    root: ScratchDir,
    recovery: ScratchDir,
    original_triplet: Vec<(&'static str, Vec<u8>)>,
}

impl Fixture {
    fn new() -> Self {
        let root = ScratchDir::new().expect("workspace scratch");
        let recovery = ScratchDir::new().expect("recovery scratch");
        write_shadow_marker_for_harness(root.path(), SHADOW_TOKEN).expect("shadow marker");
        write_rehearsal_token_for_harness(root.path(), REHEARSAL_TOKEN).expect("rehearsal marker");

        let db = root.engine_db_path().expect("engine path");
        let mut store = EngineStore::open(&db, NOW_MS).expect("fixture store");
        assert!(
            store
                .bind_shadow_clone_token(SHADOW_TOKEN)
                .expect("bind clone token")
        );
        drop(store);

        let dohc = root.join(".dohc");
        std::fs::write(dohc.join("registry.json"), br#"{"registry":true}"#).expect("registry");
        std::fs::write(dohc.join("dm-homing.json"), br#"{"homing":true}"#).expect("homing");
        std::fs::write(dohc.join("agent-runs.json"), br#"{"runs":[]}"#).expect("agent runs");

        let documents = root.join("documents");
        std::fs::create_dir(&documents).expect("documents directory");
        std::fs::write(documents.join("note.md"), b"fixture body\n").expect("user file");

        let original_triplet = snapshot_triplet(root.path());
        Self {
            root,
            recovery,
            original_triplet,
        }
    }

    fn run_with_recovery(&self, faults: &dyn FaultInjector, recovery: &Path) -> RehearsalOutcome {
        run_rehearsal(RehearsalConfig {
            root: self.root.path(),
            recovery_dir: recovery,
            now_ms: NOW_MS + 1,
            faults,
        })
        .expect("rehearsal result")
    }

    fn run(&self, faults: &dyn FaultInjector) -> RehearsalOutcome {
        self.run_with_recovery(faults, self.recovery.path())
    }

    fn paths(&self) -> Paths {
        Paths::new(self.root.path().to_path_buf())
    }

    fn engine_dir(&self) -> PathBuf {
        self.root.join(".dohc").join("engine")
    }

    fn state_dir(&self) -> PathBuf {
        self.engine_dir().join("CUTOVER_REHEARSAL_STATE")
    }
}

fn snapshot_triplet(root: &Path) -> Vec<(&'static str, Vec<u8>)> {
    let engine = root.join(".dohc").join("engine");
    ["engine.db", "engine.db-wal", "engine.db-shm"]
        .into_iter()
        .filter_map(|name| {
            let path = engine.join(name);
            path.exists()
                .then(|| (name, std::fs::read(path).expect("triplet snapshot")))
        })
        .collect()
}

fn assert_triplet_matches(directory: &Path, original: &[(&'static str, Vec<u8>)], context: &str) {
    for (name, bytes) in original {
        assert_eq!(
            std::fs::read(directory.join(name)).expect("retained triplet file"),
            *bytes,
            "{context}: {name}"
        );
    }
}

fn crash_at_backed_up(fixture: &Fixture) -> StateRecord {
    let faults = ScriptedFaults::crash_at(FaultPoint::AfterBackedUp);
    let outcome = fixture.run(faults.as_ref());
    assert!(faults.fired());
    match outcome {
        RehearsalOutcome::Crashed(record) => {
            assert_eq!(record.current, RehearsalState::BackedUp);
            record
        }
        other => panic!("expected crash after backed-up: {other:?}"),
    }
}

fn failure_reason(record: &StateRecord) -> &str {
    match &record.current {
        RehearsalState::Failed { reason, .. } => reason,
        other => panic!("expected failed state: {other:?}"),
    }
}

// ---------------------------------------------------------------------------
// Resume must re-prove the recorded backup before the destructive move.
// ---------------------------------------------------------------------------

#[test]
fn backed_up_record_carries_the_verified_backup_fingerprint() {
    let fixture = Fixture::new();
    let record = crash_at_backed_up(&fixture);
    let fingerprint = record.backup.expect("recorded fingerprint");
    let canonical = std::fs::canonicalize(fixture.recovery.path()).expect("canonical recovery");
    assert_eq!(fingerprint.recovery_dir, canonical.to_str().expect("utf8"));
    let db = load_valid_backup(fixture.recovery.path(), db_backup_stem())
        .expect("db backup")
        .expect("db backup valid");
    assert_eq!(fingerprint.db_checksum, db.manifest.checksum);
}

#[test]
fn resume_with_different_recovery_dir_fails_closed_before_move_aside() {
    let fixture = Fixture::new();
    crash_at_backed_up(&fixture);

    let empty_recovery = ScratchDir::new().expect("empty recovery");
    let outcome = fixture.run_with_recovery(&NoFaults, empty_recovery.path());
    let record = match outcome {
        RehearsalOutcome::Failed(record) => record,
        other => panic!("resume at a different recovery dir must fail closed: {other:?}"),
    };
    assert_eq!(failure_reason(&record), "resume-recovery-dir-mismatch");
    assert!(
        !moved_aside_path(&fixture.paths()).exists(),
        "nothing may be moved aside without a re-verified backup"
    );
    assert_triplet_matches(
        &fixture.engine_dir(),
        &fixture.original_triplet,
        "live triplet after refused resume",
    );
}

#[test]
fn resume_with_lost_backup_fails_closed_before_move_aside() {
    let fixture = Fixture::new();
    crash_at_backed_up(&fixture);

    // The backup vanishes from the recorded recovery dir between invocations.
    for entry in std::fs::read_dir(fixture.recovery.path()).expect("recovery entries") {
        let path = entry.expect("recovery entry").path();
        if path.is_dir() {
            std::fs::remove_dir_all(&path).expect("remove backup dir");
        } else {
            std::fs::remove_file(&path).expect("remove backup file");
        }
    }

    let outcome = fixture.run(&NoFaults);
    let record = match outcome {
        RehearsalOutcome::Failed(record) => record,
        other => panic!("resume with a lost backup must fail closed: {other:?}"),
    };
    assert_eq!(failure_reason(&record), "backup-db-not-valid");
    assert!(!moved_aside_path(&fixture.paths()).exists());
    assert_triplet_matches(
        &fixture.engine_dir(),
        &fixture.original_triplet,
        "live triplet after lost-backup resume",
    );
}

// ---------------------------------------------------------------------------
// The recovery dir must be outside the clone root on EVERY invocation.
// ---------------------------------------------------------------------------

#[test]
fn resume_refuses_recovery_dir_inside_root() {
    let fixture = Fixture::new();
    crash_at_backed_up(&fixture);

    let inside = fixture.root.join("recovery-inside-root");
    std::fs::create_dir(&inside).expect("inside recovery dir");
    let outcome = fixture.run_with_recovery(&NoFaults, &inside);
    let record = match outcome {
        RehearsalOutcome::Failed(record) => record,
        other => panic!("inside-root recovery must fail closed on resume: {other:?}"),
    };
    assert_eq!(failure_reason(&record), "backup-must-be-outside-root");
    assert!(
        !inside.join("triplet-proof").exists(),
        "no proof copies may be written inside the clone root"
    );
    assert_triplet_matches(
        &fixture.engine_dir(),
        &fixture.original_triplet,
        "live triplet after inside-root resume refusal",
    );
}

#[test]
fn fresh_start_refuses_recovery_dir_inside_root() {
    for relative in ["recovery", "deep/nested/recovery"] {
        let fixture = Fixture::new();
        let inside = fixture.root.join(relative);
        let outcome = fixture.run_with_recovery(&NoFaults, &inside);
        let record = match outcome {
            RehearsalOutcome::Failed(record) => record,
            other => panic!("inside-root recovery must fail ({relative}): {other:?}"),
        };
        assert_eq!(
            failure_reason(&record),
            "backup-must-be-outside-root",
            "unexpected failure ({relative})"
        );
        assert_triplet_matches(
            &fixture.engine_dir(),
            &fixture.original_triplet,
            "triplet after refused inside-root recovery",
        );
    }
}

// ---------------------------------------------------------------------------
// The directory backup must never carry live triplet files beside the
// vacuumed DB backup (a restored stale WAL would silently corrupt it).
// ---------------------------------------------------------------------------

#[test]
fn directory_backup_never_contains_live_triplet_files() {
    use dohc_engine_storage::{
        BackupOutcome, NoFaults as StorageNoFaults, RealFreeSpace, create_verified_backup,
    };

    let fixture = Fixture::new();
    // A prior attempt completed the DB backup (valid pair on disk), so the
    // directory backup on this run copies the engine dir without a store open
    // ever checkpointing away a leftover at-rest WAL.
    let store = EngineStore::open(&fixture.engine_dir().join("engine.db"), NOW_MS + 1)
        .expect("open for backup");
    let outcome = create_verified_backup(
        &store,
        fixture.recovery.path(),
        db_backup_stem(),
        "cutover-rehearsal",
        NOW_MS + 1,
        &RealFreeSpace,
        &StorageNoFaults,
    )
    .expect("db backup");
    assert!(matches!(outcome, BackupOutcome::Verified(_)));
    drop(store);

    std::fs::write(fixture.engine_dir().join("engine.db-wal"), vec![0_u8; 32]).expect("stale wal");

    let run = fixture.run(&NoFaults);
    let manifest = load_valid_directory_backup(fixture.recovery.path())
        .expect("manifest read")
        .unwrap_or_else(|| panic!("no manifest produced; outcome: {run:?}"));
    for name in ["engine.db", "engine.db-wal", "engine.db-shm"] {
        assert!(
            !manifest
                .files
                .iter()
                .any(|entry| entry.relative_path == format!("engine/{name}")),
            "directory backup must not manifest {name}"
        );
    }
}

// ---------------------------------------------------------------------------
// The live db itself must prove it is the clone the fence validated.
// ---------------------------------------------------------------------------

#[test]
fn live_db_bound_to_different_shadow_token_fails_closed_before_any_move() {
    let root = ScratchDir::new().expect("root");
    let recovery = ScratchDir::new().expect("recovery");
    // The plaintext markers advertise SHADOW_TOKEN, but the live engine.db is
    // bound to a different token — it is not the clone the markers claim.
    write_shadow_marker_for_harness(root.path(), SHADOW_TOKEN).expect("shadow marker");
    write_rehearsal_token_for_harness(root.path(), REHEARSAL_TOKEN).expect("rehearsal token");
    let other_token = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
    let db = root.engine_db_path().expect("engine db path");
    let mut store = EngineStore::open(&db, NOW_MS).expect("store");
    assert!(store.bind_shadow_clone_token(other_token).expect("bind"));
    drop(store);
    let dohc = root.join(".dohc");
    std::fs::write(dohc.join("registry.json"), br#"{}"#).expect("registry");
    std::fs::write(dohc.join("dm-homing.json"), br#"{}"#).expect("homing");
    std::fs::write(dohc.join("agent-runs.json"), br#"{}"#).expect("agent runs");
    let db_before = std::fs::read(&db).expect("db before");

    let outcome = run_rehearsal(RehearsalConfig {
        root: root.path(),
        recovery_dir: recovery.path(),
        now_ms: NOW_MS + 1,
        faults: &NoFaults,
    })
    .expect("rehearsal result");
    let record = match outcome {
        RehearsalOutcome::Failed(record) => record,
        other => panic!("binding mismatch must fail closed: {other:?}"),
    };
    assert_eq!(failure_reason(&record), "live-db-shadow-binding-mismatch");
    assert!(
        !root
            .join(".dohc/engine/moved-aside-cutover-rehearsal")
            .exists(),
        "a db not bound to the marker token must never be moved"
    );
    assert_eq!(std::fs::read(&db).expect("db after"), db_before);
}

#[test]
fn missing_engine_db_is_refused_not_fabricated() {
    let fixture = Fixture::new();
    let db = fixture.engine_dir().join("engine.db");
    std::fs::remove_file(&db).expect("remove live db");

    let outcome = fixture.run(&NoFaults);
    let record = match outcome {
        RehearsalOutcome::Failed(record) => record,
        other => panic!("missing db must fail closed: {other:?}"),
    };
    assert_eq!(failure_reason(&record), "live-db-missing");
    assert!(
        !db.exists(),
        "the backup step must never create a source db"
    );
}

// ---------------------------------------------------------------------------
// Forged and torn state markers.
// ---------------------------------------------------------------------------

fn forge_state_json(state_dir: &Path, generation: u64, value: &serde_json::Value) {
    std::fs::create_dir_all(state_dir).expect("state dir");
    std::fs::write(
        state_dir.join(format!("{generation:020}.json")),
        serde_json::to_vec(value).expect("forged json"),
    )
    .expect("forged marker");
}

#[test]
fn forged_complete_state_without_backup_fingerprint_is_refused() {
    let fixture = Fixture::new();
    let history = [
        "not-started",
        "settled",
        "backed-up",
        "moved-aside",
        "initialized",
        "capturing",
        "complete",
    ];
    forge_state_json(
        &fixture.state_dir(),
        (history.len() - 1) as u64,
        &serde_json::json!({
            "generation": history.len() - 1,
            "current": {"status": "complete"},
            "history": history,
        }),
    );

    let result = run_rehearsal(RehearsalConfig {
        root: fixture.root.path(),
        recovery_dir: fixture.recovery.path(),
        now_ms: NOW_MS + 1,
        faults: &NoFaults,
    });
    assert!(
        matches!(result, Err(RehearsalError::State)),
        "a Complete record with no recorded backup must be refused: {result:?}"
    );
    assert!(
        load_valid_backup(fixture.recovery.path(), db_backup_stem())
            .expect("db backup probe")
            .is_none()
    );
    assert_triplet_matches(
        &fixture.engine_dir(),
        &fixture.original_triplet,
        "live triplet after refused forged Complete",
    );
}

#[test]
fn forged_backed_up_state_without_backup_fingerprint_is_refused() {
    let fixture = Fixture::new();
    forge_state_json(
        &fixture.state_dir(),
        2,
        &serde_json::json!({
            "generation": 2,
            "current": {"status": "backed-up"},
            "history": ["not-started", "settled", "backed-up"],
        }),
    );

    let result = run_rehearsal(RehearsalConfig {
        root: fixture.root.path(),
        recovery_dir: fixture.recovery.path(),
        now_ms: NOW_MS + 1,
        faults: &NoFaults,
    });
    assert!(
        matches!(result, Err(RehearsalError::State)),
        "a BackedUp record with no recorded backup must be refused: {result:?}"
    );
    assert!(!moved_aside_path(&fixture.paths()).exists());
    assert_triplet_matches(
        &fixture.engine_dir(),
        &fixture.original_triplet,
        "live triplet after refused forged BackedUp",
    );
}

#[test]
fn forged_backed_up_state_with_fabricated_fingerprint_fails_closed() {
    let fixture = Fixture::new();
    let canonical = std::fs::canonicalize(fixture.recovery.path()).expect("canonical recovery");
    let forged = StateRecord {
        generation: 2,
        current: RehearsalState::BackedUp,
        history: vec![
            StableState::NotStarted,
            StableState::Settled,
            StableState::BackedUp,
        ],
        backup: Some(BackupFingerprint {
            recovery_dir: canonical.to_str().expect("utf8").to_owned(),
            db_checksum: "00".repeat(32),
            directory_manifest_sha256: "11".repeat(32),
        }),
    };
    forge_state_json(
        &fixture.state_dir(),
        forged.generation,
        &serde_json::to_value(&forged).expect("forged value"),
    );

    let outcome = fixture.run(&NoFaults);
    let record = match outcome {
        RehearsalOutcome::Failed(record) => record,
        other => panic!("fabricated fingerprint must fail closed: {other:?}"),
    };
    assert_eq!(failure_reason(&record), "backup-db-not-valid");
    assert!(
        !moved_aside_path(&fixture.paths()).exists(),
        "no move may run on a fingerprint that never matched a real backup"
    );
    assert_triplet_matches(
        &fixture.engine_dir(),
        &fixture.original_triplet,
        "live triplet after fabricated-fingerprint refusal",
    );
}

#[test]
fn forged_moved_aside_state_does_not_clobber_live_store() {
    let fixture = Fixture::new();
    let crashed = crash_at_backed_up(&fixture);
    let forged = StateRecord {
        generation: 3,
        current: RehearsalState::MovedAside,
        history: vec![
            StableState::NotStarted,
            StableState::Settled,
            StableState::BackedUp,
            StableState::MovedAside,
        ],
        backup: crashed.backup.clone(),
    };
    forge_state_json(
        &fixture.state_dir(),
        forged.generation,
        &serde_json::to_value(&forged).expect("forged value"),
    );

    let db_before = std::fs::read(fixture.engine_dir().join("engine.db")).expect("db before");
    let outcome = fixture.run(&NoFaults);
    let record = match outcome {
        RehearsalOutcome::Failed(record) => record,
        other => panic!("forged marker must fail closed: {other:?}"),
    };
    assert_eq!(failure_reason(&record), "initialize-not-fresh");
    let db_after = std::fs::read(fixture.engine_dir().join("engine.db")).expect("db after");
    assert_eq!(db_before, db_after, "live store must not be rewritten");
}

#[test]
fn torn_state_marker_fails_closed() {
    let fixture = Fixture::new();
    crash_at_backed_up(&fixture);
    std::fs::write(
        fixture.state_dir().join("00000000000000000003.json"),
        br#"{"generation":3,"current":{"status":"moved-as"#,
    )
    .expect("torn marker");

    let result = run_rehearsal(RehearsalConfig {
        root: fixture.root.path(),
        recovery_dir: fixture.recovery.path(),
        now_ms: NOW_MS + 2,
        faults: &NoFaults,
    });
    assert!(
        matches!(result, Err(RehearsalError::State)),
        "torn marker must refuse to run: {result:?}"
    );
    assert_triplet_matches(
        &fixture.engine_dir(),
        &fixture.original_triplet,
        "triplet after torn-marker refusal",
    );
}

// ---------------------------------------------------------------------------
// Crash windows around the move-aside and initialize steps.
// ---------------------------------------------------------------------------

#[test]
fn resume_after_phantom_move_aside_fails_closed() {
    let fixture = Fixture::new();
    crash_at_backed_up(&fixture);
    let paths = fixture.paths();

    // The crash window: move-aside physically completed but the MovedAside
    // marker was never persisted.
    move_aside(&paths, fixture.recovery.path()).expect("manual move-aside");
    assert!(!paths.db.exists());

    let outcome = fixture.run(&NoFaults);
    let record = match outcome {
        RehearsalOutcome::Failed(record) => record,
        other => panic!("resume after phantom move-aside must fail closed: {other:?}"),
    };
    assert!(
        matches!(
            &record.current,
            RehearsalState::Failed { at, .. } if *at == StableState::BackedUp
        ),
        "unexpected failure point: {record:?}"
    );
    assert_triplet_matches(
        &moved_aside_path(&paths),
        &fixture.original_triplet,
        "retained triplet after phantom-move resume",
    );
    assert!(matches!(
        fixture.run(&NoFaults),
        RehearsalOutcome::Failed(_)
    ));
}

#[test]
fn resume_after_partial_swap_preserves_split_triplet() {
    let fixture = Fixture::new();
    crash_at_backed_up(&fixture);
    let paths = fixture.paths();

    // Phase A completes, then the process dies after renaming only engine.db.
    let _verified = acquire_copy_hash_close(&paths, fixture.recovery.path()).expect("phase A");
    let moved = moved_aside_path(&paths);
    std::fs::create_dir(&moved).expect("moved dir");
    std::fs::rename(&paths.db, moved.join("engine.db")).expect("partial swap");

    let outcome = fixture.run(&NoFaults);
    assert!(
        matches!(outcome, RehearsalOutcome::Failed(_)),
        "resume after partial swap must fail closed: {outcome:?}"
    );
    let original_db = fixture
        .original_triplet
        .iter()
        .find(|(name, _)| *name == "engine.db")
        .map(|(_, bytes)| bytes.clone())
        .expect("original db bytes");
    assert_eq!(
        std::fs::read(moved.join("engine.db")).expect("moved db"),
        original_db
    );
    for (name, bytes) in &fixture.original_triplet {
        if *name == "engine.db" {
            continue;
        }
        assert_eq!(
            &std::fs::read(paths.engine.join(name)).expect("live residue"),
            bytes
        );
    }
}

#[test]
fn crash_before_initialized_marker_fails_closed_on_resume() {
    let fixture = Fixture::new();
    let faults = ScriptedFaults::crash_at(FaultPoint::AfterMovedAside);
    let first = fixture.run(faults.as_ref());
    assert!(matches!(first, RehearsalOutcome::Crashed(_)));
    let paths = fixture.paths();
    assert!(!paths.db.exists(), "triplet must be moved aside");

    // The crash window: the fresh store was created but the process died
    // before the Initialized marker.
    let store = EngineStore::open(&paths.db, NOW_MS + 2).expect("fresh store");
    assert!(store.was_freshly_created());
    drop(store);

    let outcome = fixture.run(&NoFaults);
    let record = match outcome {
        RehearsalOutcome::Failed(record) => record,
        other => panic!("initialize must not silently re-run over an existing db: {other:?}"),
    };
    assert!(
        matches!(
            &record.current,
            RehearsalState::Failed { reason, at }
                if reason == "initialize-not-fresh" && *at == StableState::MovedAside
        ),
        "unexpected failure: {record:?}"
    );
    assert_triplet_matches(
        &moved_aside_path(&paths),
        &fixture.original_triplet,
        "retained triplet after initialize-window crash",
    );
    assert!(matches!(
        fixture.run(&NoFaults),
        RehearsalOutcome::Failed(_)
    ));
}

// ---------------------------------------------------------------------------
// Prove-zero-handles and the close-to-rename window (Windows semantics).
// ---------------------------------------------------------------------------

#[cfg(windows)]
#[test]
fn preexisting_handle_fails_closed_without_touching_store() {
    use std::os::windows::fs::OpenOptionsExt as _;

    let fixture = Fixture::new();
    let db = fixture.engine_dir().join("engine.db");
    // Maximally permissive interloper: shares read/write/delete, holds READ.
    let interloper = std::fs::OpenOptions::new()
        .read(true)
        .share_mode(0x1 | 0x2 | 0x4)
        .open(&db)
        .expect("interloper handle");

    let outcome = fixture.run(&NoFaults);
    drop(interloper);

    let record = match outcome {
        RehearsalOutcome::Failed(record) => record,
        other => panic!("expected fail-closed with held handle: {other:?}"),
    };
    assert!(
        matches!(
            &record.current,
            RehearsalState::Failed { at, .. } if *at == StableState::BackedUp
        ),
        "unexpected failure point: {record:?}"
    );
    assert_triplet_matches(
        &fixture.engine_dir(),
        &fixture.original_triplet,
        "live triplet with interloper handle held",
    );
    assert!(
        !moved_aside_path(&fixture.paths()).exists(),
        "nothing may be moved aside when exclusivity cannot be proven"
    );
}

#[cfg(windows)]
#[test]
fn close_to_rename_window_write_is_caught_and_restored() {
    use std::io::Write as _;
    use std::os::windows::fs::OpenOptionsExt as _;

    let fixture = Fixture::new();
    let paths = fixture.paths();
    let recovery = ScratchDir::new().expect("window recovery");
    let verified = acquire_copy_hash_close(&paths, recovery.path()).expect("phase A");

    // Interloper opens with full sharing (so renames still succeed) and writes.
    let mut interloper = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .share_mode(0x1 | 0x2 | 0x4)
        .open(&paths.db)
        .expect("interloper rw handle");
    interloper
        .write_all(b"interloper wrote in the close-to-rename window")
        .expect("interloper write");
    interloper.flush().expect("interloper flush");
    drop(interloper);

    let error = super::handles::swap_and_verify(&paths, &verified)
        .expect_err("mutated bytes must fail the post-swap verify");
    assert!(
        matches!(
            error,
            RehearsalError::Io {
                code: "moved-aside-hash-mismatch"
            }
        ),
        "unexpected error: {error:?}"
    );
    assert_triplet_matches(
        &paths.engine,
        &fixture.original_triplet,
        "restored live triplet after window write",
    );
}

// ---------------------------------------------------------------------------
// Backup validation and inventory capture.
// ---------------------------------------------------------------------------

#[test]
fn corrupt_or_short_backup_copies_do_not_validate() {
    let fixture = Fixture::new();
    let outcome = fixture.run(&NoFaults);
    assert!(matches!(outcome, RehearsalOutcome::Complete(_)));

    // Flip one byte in the DB backup.
    let db_backup = fixture.recovery.join(format!("{}.db", db_backup_stem()));
    let mut bytes = std::fs::read(&db_backup).expect("db backup bytes");
    bytes[100] ^= 0xff;
    std::fs::write(&db_backup, &bytes).expect("corrupt db backup");
    assert!(
        load_valid_backup(fixture.recovery.path(), db_backup_stem())
            .expect("load corrupted db backup")
            .is_none(),
        "flipped byte in db backup must invalidate it"
    );

    // Truncate one directory-backup file (short copy).
    let manifest = load_valid_directory_backup(fixture.recovery.path())
        .expect("load manifest")
        .expect("manifest present");
    let first = manifest.files.first().expect("at least one entry");
    let target = fixture
        .recovery
        .join("cutover-files")
        .join(&first.relative_path);
    let original = std::fs::read(&target).expect("backup file");
    std::fs::write(&target, &original[..original.len().saturating_sub(1)])
        .expect("truncate backup file");
    assert!(
        load_valid_directory_backup(fixture.recovery.path())
            .expect("load truncated dir backup")
            .is_none(),
        "short copy must invalidate the directory backup"
    );

    // Same-length bit-flip must also be caught (hash, not just size).
    let mut flipped = original.clone();
    flipped[0] ^= 0x01;
    std::fs::write(&target, &flipped).expect("flip backup file");
    assert!(
        load_valid_directory_backup(fixture.recovery.path())
            .expect("load flipped dir backup")
            .is_none(),
        "same-size bit-flip must invalidate the directory backup"
    );
}

#[test]
fn directory_manifest_with_traversal_path_is_invalid() {
    let recovery = ScratchDir::new().expect("recovery");
    std::fs::create_dir(recovery.join("cutover-files")).expect("backup dir");
    for relative_path in ["../outside.txt", "/absolute.txt", "a/../../outside.txt"] {
        let manifest = serde_json::json!({
            "verified": true,
            "files": [{"relative_path": relative_path, "size_bytes": 1, "sha256": "00"}],
        });
        std::fs::write(
            recovery.join("cutover-files.manifest.json"),
            serde_json::to_vec(&manifest).expect("manifest json"),
        )
        .expect("write manifest");
        assert!(
            load_valid_directory_backup(recovery.path())
                .expect("load manifest")
                .is_none(),
            "a manifest path escaping the backup dir must invalidate it: {relative_path}"
        );
    }
}

#[test]
fn added_and_removed_files_fail_capture() {
    for variant in ["added", "removed"] {
        let fixture = Fixture::new();
        let faults = ScriptedFaults::crash_at(FaultPoint::AfterInitialized);
        let first = fixture.run(faults.as_ref());
        assert!(matches!(first, RehearsalOutcome::Crashed(_)));

        match variant {
            "added" => {
                std::fs::write(fixture.root.join("documents").join("sneaky.md"), b"new\n")
                    .expect("added file");
            }
            _ => {
                std::fs::remove_file(fixture.root.join("documents").join("note.md"))
                    .expect("removed file");
            }
        }
        let outcome = fixture.run(&NoFaults);
        let record = match outcome {
            RehearsalOutcome::Failed(record) => record,
            other => panic!("{variant}: capture must fail: {other:?}"),
        };
        assert_eq!(failure_reason(&record), "capture-inventory-mismatch");
    }
}

// ---------------------------------------------------------------------------
// Rehearsal-token shape attacks against the fence.
// ---------------------------------------------------------------------------

fn stamp_shadow_only(root: &Path) {
    write_shadow_marker_for_harness(root, SHADOW_TOKEN).expect("shadow marker");
}

/// Overwrite the token file with arbitrary bytes, bypassing the harness
/// writer's shape guard.
fn force_token_bytes(root: &Path, bytes: &[u8]) {
    let dir = root.join(".dohc").join("engine");
    std::fs::create_dir_all(&dir).expect("engine dir");
    std::fs::write(dir.join("CUTOVER_REHEARSAL_TOKEN"), bytes).expect("token bytes");
}

#[test]
fn token_uppercase_hex_is_refused() {
    let root = ScratchDir::new().expect("scratch");
    stamp_shadow_only(root.path());
    force_token_bytes(
        root.path(),
        b"ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789",
    );
    assert!(validate_rehearsal_root(root.path()).is_err());
}

#[test]
fn token_wrong_length_is_refused() {
    let short = ScratchDir::new().expect("scratch");
    stamp_shadow_only(short.path());
    force_token_bytes(short.path(), &[b'a'; 63]);
    assert!(validate_rehearsal_root(short.path()).is_err());

    let long = ScratchDir::new().expect("scratch");
    stamp_shadow_only(long.path());
    force_token_bytes(long.path(), &[b'a'; 65]);
    assert!(validate_rehearsal_root(long.path()).is_err());
}

#[test]
fn token_trailing_newline_is_refused() {
    let root = ScratchDir::new().expect("scratch");
    stamp_shadow_only(root.path());
    // 63 hex chars + newline == 64 bytes: passes the length gate but not hex.
    let mut bytes = vec![b'a'; 63];
    bytes.push(b'\n');
    force_token_bytes(root.path(), &bytes);
    assert!(validate_rehearsal_root(root.path()).is_err());
}

#[test]
fn token_non_hex_byte_is_refused() {
    let root = ScratchDir::new().expect("scratch");
    stamp_shadow_only(root.path());
    let mut bytes = vec![b'a'; 64];
    bytes[10] = b'g';
    force_token_bytes(root.path(), &bytes);
    assert!(validate_rehearsal_root(root.path()).is_err());
}

#[cfg(unix)]
#[test]
fn token_symlink_is_refused_even_if_target_is_valid() {
    use dohc_engine_testkit::try_make_file_symlink;

    let root = ScratchDir::new().expect("scratch");
    stamp_shadow_only(root.path());
    let dir = root.join(".dohc").join("engine");
    std::fs::create_dir_all(&dir).expect("engine dir");
    let real = dir.join("real-token");
    std::fs::write(&real, REHEARSAL_TOKEN).expect("real token");
    let link = dir.join("CUTOVER_REHEARSAL_TOKEN");
    if try_make_file_symlink(&real, &link).expect("symlink attempt") {
        assert!(
            validate_rehearsal_root(root.path()).is_err(),
            "a symlinked token must be refused"
        );
    }
}

#[test]
fn fence_refusal_writes_nothing_to_the_root() {
    // Shadow marker only, no rehearsal token: the fence must refuse before the
    // driver creates any rehearsal state or touches the recovery dir.
    let root = ScratchDir::new().expect("scratch");
    let recovery = ScratchDir::new().expect("recovery");
    stamp_shadow_only(root.path());

    let result = run_rehearsal(RehearsalConfig {
        root: root.path(),
        recovery_dir: recovery.path(),
        now_ms: NOW_MS,
        faults: &NoFaults,
    });
    assert!(result.is_err(), "fence must refuse a token-less root");
    assert!(
        !root.join(".dohc/engine/CUTOVER_REHEARSAL_STATE").exists(),
        "no CUTOVER_REHEARSAL_STATE may be created when the fence refuses"
    );
    assert!(
        std::fs::read_dir(recovery.path())
            .expect("recovery entries")
            .next()
            .is_none(),
        "recovery dir must stay empty when the fence refuses"
    );
}
