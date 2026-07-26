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

impl Fixture {
    fn try_run_with_recovery(&self, recovery: &Path) -> Result<RehearsalOutcome, RehearsalError> {
        run_rehearsal(RehearsalConfig {
            root: self.root.path(),
            recovery_dir: recovery,
            now_ms: NOW_MS + 1,
            faults: &NoFaults,
        })
    }
}

fn snapshot_state_dir(root: &Path) -> Vec<(String, Vec<u8>)> {
    let dir = root
        .join(".dohc")
        .join("engine")
        .join("CUTOVER_REHEARSAL_STATE");
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut snapshot: Vec<(String, Vec<u8>)> = entries
        .map(|entry| {
            let entry = entry.expect("state entry");
            (
                entry.file_name().to_string_lossy().into_owned(),
                std::fs::read(entry.path()).expect("state bytes"),
            )
        })
        .collect();
    snapshot.sort();
    snapshot
}

#[track_caller]
fn assert_refusal_code(result: Result<RehearsalOutcome, RehearsalError>, code: &str) {
    match result {
        Err(RehearsalError::Io { code: actual }) => assert_eq!(actual, code),
        other => panic!("expected refusal {code}, got {other:?}"),
    }
}

/// The FIRST refusal on a fresh run may legitimately advance the state
/// machine before refusing, but it must never persist a terminal state.
#[track_caller]
fn assert_first_refusal(
    root: &Path,
    run: impl FnOnce() -> Result<RehearsalOutcome, RehearsalError>,
    code: &str,
) {
    assert_refusal_code(run(), code);
    if let Some(record) = load_state(root).expect("state loads") {
        assert!(
            !matches!(
                record.current,
                RehearsalState::Failed { .. } | RehearsalState::Complete
            ),
            "a refusal must not persist a terminal state: {record:?}"
        );
    }
}

/// A precondition refusal: the given error code AND a byte-identical state
/// dir before and after — a refusal must never mutate rehearsal state.
#[track_caller]
fn assert_refused(
    root: &Path,
    run: impl FnOnce() -> Result<RehearsalOutcome, RehearsalError>,
    code: &str,
) {
    let before = snapshot_state_dir(root);
    assert_refusal_code(run(), code);
    assert_eq!(
        snapshot_state_dir(root),
        before,
        "a refusal must not mutate the rehearsal state dir"
    );
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
fn resume_with_different_recovery_dir_is_refused_before_move_aside() {
    let fixture = Fixture::new();
    crash_at_backed_up(&fixture);

    let empty_recovery = ScratchDir::new().expect("empty recovery");
    assert_refused(
        fixture.root.path(),
        || fixture.try_run_with_recovery(empty_recovery.path()),
        "resume-recovery-dir-mismatch",
    );
    assert!(
        !moved_aside_path(&fixture.paths()).exists(),
        "nothing may be moved aside without a re-verified backup"
    );
    assert_triplet_matches(
        &fixture.engine_dir(),
        &fixture.original_triplet,
        "live triplet after refused resume",
    );
    // The refusal is not terminal: the recorded dir still resumes to Complete.
    assert!(matches!(
        fixture.run(&NoFaults),
        RehearsalOutcome::Complete(_)
    ));
}

#[test]
fn resume_with_lost_backup_is_refused_before_move_aside() {
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

    assert_refused(
        fixture.root.path(),
        || fixture.try_run_with_recovery(fixture.recovery.path()),
        "backup-db-not-valid",
    );
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
    assert_refused(
        fixture.root.path(),
        || fixture.try_run_with_recovery(&inside),
        "backup-must-be-outside-root",
    );
    assert!(
        !inside.join("triplet-proof").exists(),
        "no proof copies may be written inside the clone root"
    );
    assert_triplet_matches(
        &fixture.engine_dir(),
        &fixture.original_triplet,
        "live triplet after inside-root resume refusal",
    );
    // The refusal is not terminal: a valid recovery dir still resumes.
    assert!(matches!(
        fixture.run(&NoFaults),
        RehearsalOutcome::Complete(_)
    ));
}

#[test]
fn fresh_start_refuses_recovery_dir_inside_root() {
    for relative in ["recovery", "deep/nested/recovery"] {
        let fixture = Fixture::new();
        let inside = fixture.root.join(relative);
        assert_refused(
            fixture.root.path(),
            || fixture.try_run_with_recovery(&inside),
            "backup-must-be-outside-root",
        );
        assert!(
            !fixture.state_dir().exists(),
            "no state may be persisted for an invalid recovery dir ({relative})"
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

    let attempt = || {
        run_rehearsal(RehearsalConfig {
            root: root.path(),
            recovery_dir: recovery.path(),
            now_ms: NOW_MS + 1,
            faults: &NoFaults,
        })
    };
    // The first attempt legitimately advances to Settled before refusing; it
    // must not persist a terminal state, and the repeated refusal must not
    // mutate state further.
    assert_first_refusal(root.path(), attempt, "live-db-shadow-binding-mismatch");
    assert_refused(root.path(), attempt, "live-db-shadow-binding-mismatch");
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

    // The first attempt legitimately advances to Settled before refusing; it
    // must not persist a terminal state, and the repeated refusal must not
    // mutate state further.
    assert_first_refusal(
        fixture.root.path(),
        || fixture.try_run_with_recovery(fixture.recovery.path()),
        "live-db-missing",
    );
    assert_refused(
        fixture.root.path(),
        || fixture.try_run_with_recovery(fixture.recovery.path()),
        "live-db-missing",
    );
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
        fresh_engine_uuid: None,
    };
    forge_state_json(
        &fixture.state_dir(),
        forged.generation,
        &serde_json::to_value(&forged).expect("forged value"),
    );

    assert_refused(
        fixture.root.path(),
        || fixture.try_run_with_recovery(fixture.recovery.path()),
        "backup-db-not-valid",
    );
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
        fresh_engine_uuid: None,
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
    assert_eq!(failure_reason(&record), "initialize-retained-store-missing");
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
fn resume_after_phantom_move_aside_is_refused() {
    let fixture = Fixture::new();
    crash_at_backed_up(&fixture);
    let paths = fixture.paths();

    // The crash window: move-aside physically completed but the MovedAside
    // marker was never persisted. The moved bytes cannot be re-proven against
    // the recorded fingerprint, so this stays a refusal.
    move_aside(&paths, fixture.recovery.path()).expect("manual move-aside");
    assert!(!paths.db.exists());

    assert_refused(
        fixture.root.path(),
        || fixture.try_run_with_recovery(fixture.recovery.path()),
        "live-db-missing",
    );
    assert_triplet_matches(
        &moved_aside_path(&paths),
        &fixture.original_triplet,
        "retained triplet after phantom-move resume",
    );
    assert_refused(
        fixture.root.path(),
        || fixture.try_run_with_recovery(fixture.recovery.path()),
        "live-db-missing",
    );
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

    assert_refused(
        fixture.root.path(),
        || fixture.try_run_with_recovery(fixture.recovery.path()),
        "live-db-missing",
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

#[test]
fn completed_initialize_without_marker_resumes_to_complete() {
    let fixture = Fixture::new();
    let faults = ScriptedFaults::crash_at(FaultPoint::AfterMovedAside);
    assert!(matches!(
        fixture.run(faults.as_ref()),
        RehearsalOutcome::Crashed(_)
    ));
    let paths = fixture.paths();

    // The crash window AFTER initialize fully completed (fresh store created
    // AND bound) but before the Initialized marker persisted: the retained
    // moved-aside store proves the window, so resume continues.
    let mut store = EngineStore::open(&paths.db, NOW_MS + 2).expect("fresh store");
    assert!(store.was_freshly_created());
    assert!(store.bind_shadow_clone_token(SHADOW_TOKEN).expect("bind"));
    drop(store);

    let outcome = fixture.run(&NoFaults);
    assert!(
        matches!(outcome, RehearsalOutcome::Complete(_)),
        "a completed-but-unmarked initialize must resume: {outcome:?}"
    );
    assert_triplet_matches(
        &moved_aside_path(&paths),
        &fixture.original_triplet,
        "retained triplet after resumed initialize",
    );
}

#[test]
fn stale_triplet_proof_from_crashed_attempt_is_cleared_on_resume() {
    let fixture = Fixture::new();
    crash_at_backed_up(&fixture);
    let paths = fixture.paths();

    // The crash window: Phase A completed (proof exists, handles closed) but
    // the process died before any rename. The live triplet is intact, so the
    // resume must rebuild the proof and finish, not wedge on the leftover.
    let _ = acquire_copy_hash_close(&paths, fixture.recovery.path()).expect("phase A");

    let outcome = fixture.run(&NoFaults);
    assert!(
        matches!(outcome, RehearsalOutcome::Complete(_)),
        "a stale proof dir must not wedge the resume: {outcome:?}"
    );
}

#[test]
fn missing_fresh_store_on_initialized_resume_is_refused() {
    let fixture = Fixture::new();
    let faults = ScriptedFaults::crash_at(FaultPoint::AfterInitialized);
    assert!(matches!(
        fixture.run(faults.as_ref()),
        RehearsalOutcome::Crashed(_)
    ));
    let paths = fixture.paths();

    // The fresh live store vanishes after the Initialized marker; the capture
    // resume must notice (the user-file inventory skips `.dohc`) and refuse.
    std::fs::remove_file(&paths.db).expect("remove fresh store");
    assert_refused(
        fixture.root.path(),
        || fixture.try_run_with_recovery(fixture.recovery.path()),
        "live-db-missing",
    );
    assert!(
        !paths.db.exists(),
        "the capture path must never fabricate a live store"
    );
}

#[test]
fn missing_retained_store_on_moved_aside_resume_is_refused() {
    let fixture = Fixture::new();
    let faults = ScriptedFaults::crash_at(FaultPoint::AfterMovedAside);
    assert!(matches!(
        fixture.run(faults.as_ref()),
        RehearsalOutcome::Crashed(_)
    ));
    let paths = fixture.paths();

    std::fs::remove_dir_all(moved_aside_path(&paths)).expect("lose retained store");
    let outcome = fixture.run(&NoFaults);
    let record = match outcome {
        RehearsalOutcome::Failed(record) => record,
        other => panic!("initialize without the retained store must fail: {other:?}"),
    };
    assert_eq!(failure_reason(&record), "initialize-retained-store-missing");
    assert!(
        !paths.db.exists(),
        "initialize must not fabricate a fresh store without the retained proof"
    );
}

#[test]
fn empty_stale_moved_aside_dir_is_reused_on_resume() {
    let fixture = Fixture::new();
    crash_at_backed_up(&fixture);
    let paths = fixture.paths();

    // The crash window right after create_dir: the dir exists, nothing moved.
    std::fs::create_dir(moved_aside_path(&paths)).expect("empty stale dir");
    let outcome = fixture.run(&NoFaults);
    assert!(
        matches!(outcome, RehearsalOutcome::Complete(_)),
        "an empty stale moved-aside dir must be reused: {outcome:?}"
    );
    assert_triplet_matches(
        &moved_aside_path(&paths),
        &fixture.original_triplet,
        "retained triplet after reused empty dir",
    );
}

#[test]
fn non_empty_stale_moved_aside_dir_fails_closed() {
    let fixture = Fixture::new();
    crash_at_backed_up(&fixture);
    let moved = moved_aside_path(&fixture.paths());
    std::fs::create_dir(&moved).expect("stale dir");
    std::fs::write(moved.join("engine.db"), b"partial residue").expect("residue");

    let outcome = fixture.run(&NoFaults);
    let record = match outcome {
        RehearsalOutcome::Failed(record) => record,
        other => panic!("a non-empty moved-aside dir must fail closed: {other:?}"),
    };
    assert_eq!(failure_reason(&record), "moved-aside-not-clean");
    assert_triplet_matches(
        &fixture.engine_dir(),
        &fixture.original_triplet,
        "live triplet after refused dirty moved-aside dir",
    );
}

#[test]
fn sidecar_appearing_after_proof_is_refused() {
    let root = ScratchDir::new().expect("root");
    let recovery = ScratchDir::new().expect("recovery");
    let engine = root.join(".dohc").join("engine");
    std::fs::create_dir_all(&engine).expect("engine dir");
    std::fs::write(engine.join("engine.db"), b"primary bytes").expect("db");
    let paths = Paths::new(root.path().to_path_buf());

    let verified = acquire_copy_hash_close(&paths, recovery.path()).expect("phase A");
    // A WAL appears between the proof and the swap: refuse before any move.
    std::fs::write(engine.join("engine.db-wal"), b"appeared").expect("late sidecar");

    let error = super::handles::swap_and_verify(&paths, &verified)
        .expect_err("an unverified sidecar must refuse the swap");
    assert!(
        matches!(
            error,
            RehearsalError::Io {
                code: "triplet-unverified-sidecar"
            }
        ),
        "unexpected error: {error:?}"
    );
    assert!(paths.db.exists(), "nothing may be moved");
    assert!(!moved_aside_path(&paths).exists());
}

#[cfg(unix)]
#[test]
fn sidecar_metadata_error_fails_closed_without_moving() {
    use std::os::unix::fs::PermissionsExt as _;

    let root = ScratchDir::new().expect("root");
    let recovery = ScratchDir::new().expect("recovery");
    let engine = root.join(".dohc").join("engine");
    std::fs::create_dir_all(&engine).expect("engine dir");
    std::fs::write(engine.join("engine.db"), b"primary bytes").expect("db");
    let paths = Paths::new(root.path().to_path_buf());
    let verified = acquire_copy_hash_close(&paths, recovery.path()).expect("phase A");

    // Deny traversal: sidecar metadata now errors with EACCES, not NotFound.
    let restore = std::fs::metadata(&paths.engine)
        .expect("engine metadata")
        .permissions();
    std::fs::set_permissions(&paths.engine, std::fs::Permissions::from_mode(0o000))
        .expect("revoke traversal");
    let result = super::handles::swap_and_verify(&paths, &verified);
    std::fs::set_permissions(&paths.engine, restore).expect("restore perms");

    let error = result.expect_err("a sidecar metadata error must fail closed");
    assert!(
        matches!(
            error,
            RehearsalError::Io {
                code: "triplet-sidecar-metadata"
            }
        ),
        "unexpected error: {error:?}"
    );
    assert!(paths.db.exists(), "nothing may be moved");
    assert!(!moved_aside_path(&paths).exists());
}

#[test]
fn concurrent_rehearsal_is_refused_while_root_lock_held() {
    let fixture = Fixture::new();
    let lock_path = fixture.engine_dir().join("CUTOVER_REHEARSAL_LOCK");
    let holder = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&lock_path)
        .expect("lock file");
    fs4::FileExt::try_lock(&holder).expect("hold the root lock");

    assert_refused(
        fixture.root.path(),
        || fixture.try_run_with_recovery(fixture.recovery.path()),
        "rehearsal-lock-contended",
    );

    drop(holder);
    assert!(matches!(
        fixture.run(&NoFaults),
        RehearsalOutcome::Complete(_)
    ));
}

#[test]
fn directory_backup_reuse_requires_matching_live_source() {
    use super::backup::create_restore_tested_backup;

    let fixture = Fixture::new();
    let paths = fixture.paths();
    create_restore_tested_backup(
        &paths,
        fixture.recovery.path(),
        SHADOW_TOKEN,
        NOW_MS + 1,
        &NoFaults,
    )
    .expect("first backup");
    // Unchanged source: the recorded artifacts are reusable.
    create_restore_tested_backup(
        &paths,
        fixture.recovery.path(),
        SHADOW_TOKEN,
        NOW_MS + 2,
        &NoFaults,
    )
    .expect("reuse for an unchanged source");

    // A protected source changes: the first-pass artifacts are now stale and
    // must never be recorded as this run's restore point.
    std::fs::write(
        fixture.root.join(".dohc").join("registry.json"),
        br#"{"registry":"changed"}"#,
    )
    .expect("mutate protected source");
    let error = create_restore_tested_backup(
        &paths,
        fixture.recovery.path(),
        SHADOW_TOKEN,
        NOW_MS + 3,
        &NoFaults,
    )
    .expect_err("a stale directory backup must be refused");
    assert!(
        matches!(
            error,
            RehearsalError::Io {
                code: "prior-directory-backup-stale"
            }
        ),
        "unexpected error: {error:?}"
    );
}

#[cfg(unix)]
#[test]
fn backup_accepts_symlinked_ancestor_directories() {
    use super::backup::{create_restore_tested_backup, recorded_backup_engine_uuid};
    use std::os::unix::fs::symlink;

    let fixture = Fixture::new();
    let aliases = ScratchDir::new().expect("alias scratch");
    let workspace_alias = aliases.join("workspace");
    let recovery_alias = aliases.join("recovery");
    symlink(fixture.root.path(), &workspace_alias).expect("workspace ancestor alias");
    symlink(fixture.recovery.path(), &recovery_alias).expect("recovery ancestor alias");
    let aliased_paths = Paths::new(workspace_alias);

    create_restore_tested_backup(
        &aliased_paths,
        &recovery_alias,
        SHADOW_TOKEN,
        NOW_MS + 1,
        &NoFaults,
    )
    .expect("backup through symlinked ancestors");
    create_restore_tested_backup(
        &aliased_paths,
        &recovery_alias,
        SHADOW_TOKEN,
        NOW_MS + 2,
        &NoFaults,
    )
    .expect("backup reuse through symlinked ancestors");
    recorded_backup_engine_uuid(&recovery_alias)
        .expect("backup identity through symlinked ancestor");
}

#[cfg(unix)]
#[test]
fn backup_refuses_symlinked_engine_db_final_component() {
    use super::backup::create_restore_tested_backup;
    use std::os::unix::fs::symlink;

    let fixture = Fixture::new();
    let paths = fixture.paths();
    let external = fixture.recovery.join("external-engine.db");
    std::fs::copy(&paths.db, &external).expect("external database copy");
    let external_before = std::fs::read(&external).expect("external database bytes");
    std::fs::remove_file(&paths.db).expect("remove real database");
    symlink(&external, &paths.db).expect("symlink final engine.db");

    let error = create_restore_tested_backup(
        &paths,
        fixture.recovery.path(),
        SHADOW_TOKEN,
        NOW_MS + 1,
        &NoFaults,
    )
    .expect_err("a symlinked final engine.db must be refused");
    assert!(
        matches!(
            error,
            RehearsalError::Io {
                code: "backup-source-open-read-only-failed"
            }
        ),
        "unexpected error: {error:?}"
    );
    assert_eq!(
        std::fs::read(&external).expect("external database bytes after refusal"),
        external_before,
        "the symlink target must not be modified"
    );
}

// ---------------------------------------------------------------------------
// Alias escapes and reset-freshness proofs.
// ---------------------------------------------------------------------------

#[test]
fn aliased_engine_dir_is_refused_before_lock_creation() {
    use dohc_engine_testkit::try_make_dir_alias;

    let root = ScratchDir::new().expect("root");
    let target = ScratchDir::new().expect("alias target");
    // Valid marker files live in the TARGET; the clone's `.dohc/engine` is an
    // alias pointing at it, so the fence lookups succeed through the alias.
    std::fs::write(target.join("SHADOW_CLONE"), SHADOW_TOKEN).expect("shadow marker");
    std::fs::write(target.join("CUTOVER_REHEARSAL_TOKEN"), REHEARSAL_TOKEN)
        .expect("rehearsal token");
    let dohc = root.join(".dohc");
    std::fs::create_dir(&dohc).expect("dohc dir");
    if !try_make_dir_alias(target.path(), &dohc.join("engine")).expect("alias attempt") {
        return; // platform cannot create directory aliases — skip honestly
    }

    let recovery = ScratchDir::new().expect("recovery");
    let result = run_rehearsal(RehearsalConfig {
        root: root.path(),
        recovery_dir: recovery.path(),
        now_ms: NOW_MS,
        faults: &NoFaults,
    });
    assert_refusal_code(result, "engine-dir-alias-refused");
    assert!(
        !target.join("CUTOVER_REHEARSAL_LOCK").exists(),
        "the lock must never be created through the alias"
    );
    assert!(
        !target.join("CUTOVER_REHEARSAL_STATE").exists(),
        "no state may be created through the alias"
    );
}

#[test]
fn symlinked_retained_store_is_refused() {
    use dohc_engine_testkit::try_make_file_symlink;

    let fixture = Fixture::new();
    let faults = ScriptedFaults::crash_at(FaultPoint::AfterMovedAside);
    assert!(matches!(
        fixture.run(faults.as_ref()),
        RehearsalOutcome::Crashed(_)
    ));
    let paths = fixture.paths();

    // The retained engine.db is replaced by a symlink to a stashed copy: the
    // followed bytes are identical, but the retained store is no longer real.
    let moved_db = moved_aside_path(&paths).join("engine.db");
    let stash = fixture.recovery.join("stashed-retained.db");
    std::fs::copy(&moved_db, &stash).expect("stash retained db");
    std::fs::remove_file(&moved_db).expect("remove retained db");
    if !try_make_file_symlink(&stash, &moved_db).expect("symlink attempt") {
        return; // platform cannot create file symlinks — skip honestly
    }

    let outcome = fixture.run(&NoFaults);
    let record = match outcome {
        RehearsalOutcome::Failed(record) => record,
        other => panic!("a symlinked retained store must be refused: {other:?}"),
    };
    assert_eq!(failure_reason(&record), "initialize-retained-store-missing");
    assert!(
        !paths.db.exists(),
        "initialize must not fabricate a fresh store over an untrusted sibling"
    );
}

#[test]
fn stale_same_clone_db_at_moved_aside_resume_is_refused() {
    let fixture = Fixture::new();
    let faults = ScriptedFaults::crash_at(FaultPoint::AfterMovedAside);
    assert!(matches!(
        fixture.run(faults.as_ref()),
        RehearsalOutcome::Crashed(_)
    ));
    let paths = fixture.paths();

    // The ORIGINAL store (bound to the same shadow token) is copied back over
    // engine.db: the token check alone would accept it as "reset".
    std::fs::copy(moved_aside_path(&paths).join("engine.db"), &paths.db)
        .expect("copy stale store back");

    let outcome = fixture.run(&NoFaults);
    let record = match outcome {
        RehearsalOutcome::Failed(record) => record,
        other => panic!("a stale same-clone db must not pass as a reset: {other:?}"),
    };
    assert_eq!(failure_reason(&record), "initialize-stale-store");
}

#[test]
fn stale_same_clone_db_at_initialized_resume_is_refused() {
    let fixture = Fixture::new();
    let faults = ScriptedFaults::crash_at(FaultPoint::AfterInitialized);
    assert!(matches!(
        fixture.run(faults.as_ref()),
        RehearsalOutcome::Crashed(_)
    ));
    let paths = fixture.paths();

    // The fresh store is replaced by the stale same-clone original AFTER the
    // Initialized marker: the shared token passes, the recorded reset
    // identity must not.
    std::fs::remove_file(&paths.db).expect("drop fresh store");
    std::fs::copy(moved_aside_path(&paths).join("engine.db"), &paths.db)
        .expect("copy stale store back");

    assert_refused(
        fixture.root.path(),
        || fixture.try_run_with_recovery(fixture.recovery.path()),
        "live-db-reset-identity-mismatch",
    );
}

#[test]
fn new_protected_sibling_after_backup_fails_capture() {
    let fixture = Fixture::new();
    // No agent-runs.json at backup time.
    std::fs::remove_file(fixture.root.join(".dohc").join("agent-runs.json"))
        .expect("remove sibling before backup");
    let faults = ScriptedFaults::crash_at(FaultPoint::AfterInitialized);
    assert!(matches!(
        fixture.run(faults.as_ref()),
        RehearsalOutcome::Crashed(_)
    ));

    // The protected sibling APPEARS before the capture resume: it has no
    // restore point, so Complete must be refused.
    std::fs::write(
        fixture.root.join(".dohc").join("agent-runs.json"),
        br#"{"runs":["late"]}"#,
    )
    .expect("late sibling");

    let outcome = fixture.run(&NoFaults);
    let record = match outcome {
        RehearsalOutcome::Failed(record) => record,
        other => panic!("an unprotected new sibling must fail capture: {other:?}"),
    };
    assert_eq!(failure_reason(&record), "capture-snapshot-unprotected");
}

#[test]
fn aliased_moved_aside_dir_is_refused_before_any_triplet_leaves_the_clone() {
    use dohc_engine_testkit::try_make_dir_alias;

    let fixture = Fixture::new();
    crash_at_backed_up(&fixture);
    let paths = fixture.paths();

    // The moved-aside dir is an ALIAS pointing outside the clone: accepting
    // it would move the live triplet into the target.
    let target = ScratchDir::new().expect("alias target");
    if !try_make_dir_alias(target.path(), &moved_aside_path(&paths)).expect("alias attempt") {
        return; // platform cannot create directory aliases — skip honestly
    }

    let outcome = fixture.run(&NoFaults);
    let record = match outcome {
        RehearsalOutcome::Failed(record) => record,
        other => panic!("an aliased moved-aside dir must be refused: {other:?}"),
    };
    assert_eq!(failure_reason(&record), "moved-aside-alias-refused");
    assert!(
        std::fs::read_dir(target.path())
            .expect("target entries")
            .next()
            .is_none(),
        "no triplet byte may land outside the clone root"
    );
    assert_triplet_matches(
        &fixture.engine_dir(),
        &fixture.original_triplet,
        "live triplet after aliased moved-aside refusal",
    );
}

#[test]
fn symlinked_protected_snapshot_fails_capture() {
    use dohc_engine_testkit::try_make_file_symlink;

    let fixture = Fixture::new();
    let faults = ScriptedFaults::crash_at(FaultPoint::AfterInitialized);
    assert!(matches!(
        fixture.run(faults.as_ref()),
        RehearsalOutcome::Crashed(_)
    ));

    // The protected snapshot is replaced by a SAME-CONTENT symlink: the bytes
    // hash identically but the workspace file is now an external alias.
    let live = fixture.root.join(".dohc").join("registry.json");
    let stash = fixture.recovery.join("stashed-registry.json");
    std::fs::copy(&live, &stash).expect("stash snapshot");
    std::fs::remove_file(&live).expect("remove snapshot");
    if !try_make_file_symlink(&stash, &live).expect("symlink attempt") {
        return; // platform cannot create file symlinks — skip honestly
    }

    let outcome = fixture.run(&NoFaults);
    let record = match outcome {
        RehearsalOutcome::Failed(record) => record,
        other => panic!("an aliased protected snapshot must fail capture: {other:?}"),
    };
    assert_eq!(failure_reason(&record), "capture-snapshot-alias-refused");
}

#[test]
fn aliased_existing_live_db_is_refused_before_open() {
    use dohc_engine_testkit::try_make_file_symlink;

    let fixture = Fixture::new();
    let faults = ScriptedFaults::crash_at(FaultPoint::AfterMovedAside);
    assert!(matches!(
        fixture.run(faults.as_ref()),
        RehearsalOutcome::Crashed(_)
    ));
    let paths = fixture.paths();

    // engine.db reappears as a symlink to an EXTERNAL database: the RW open
    // would bind/migrate the target before any post-open check could refuse.
    let external = fixture.recovery.join("external.db");
    std::fs::copy(moved_aside_path(&paths).join("engine.db"), &external).expect("external db");
    let external_before = std::fs::read(&external).expect("external bytes");
    if !try_make_file_symlink(&external, &paths.db).expect("symlink attempt") {
        return; // platform cannot create file symlinks — skip honestly
    }

    let outcome = fixture.run(&NoFaults);
    let record = match outcome {
        RehearsalOutcome::Failed(record) => record,
        other => panic!("an aliased live db must be refused before open: {other:?}"),
    };
    assert_eq!(failure_reason(&record), "initialize-live-db-alias-refused");
    assert_eq!(
        std::fs::read(&external).expect("external bytes after"),
        external_before,
        "the external database must never be opened or mutated"
    );
}

#[test]
fn capturing_resume_reruns_the_capture_proofs() {
    let fixture = Fixture::new();
    let faults = ScriptedFaults::crash_at(FaultPoint::AfterInitialized);
    assert!(matches!(
        fixture.run(faults.as_ref()),
        RehearsalOutcome::Crashed(_)
    ));
    let crashed = load_state(fixture.root.path())
        .expect("state")
        .expect("crashed record");

    // The crash window between Capturing and Complete, forged from the real
    // Initialized record; then a user file mutates AFTER the capture check.
    let mut history = crashed.history.clone();
    history.push(StableState::Capturing);
    let forged = StateRecord {
        generation: crashed.generation + 1,
        current: RehearsalState::Capturing,
        history,
        backup: crashed.backup.clone(),
        fresh_engine_uuid: crashed.fresh_engine_uuid.clone(),
    };
    forge_state_json(
        &fixture.state_dir(),
        forged.generation,
        &serde_json::to_value(&forged).expect("forged value"),
    );
    std::fs::write(
        fixture.root.join("documents").join("note.md"),
        b"mutated after capture\n",
    )
    .expect("mutate user file");

    let outcome = fixture.run(&NoFaults);
    let record = match outcome {
        RehearsalOutcome::Failed(record) => record,
        other => panic!("a Capturing resume must re-run the proofs: {other:?}"),
    };
    assert_eq!(failure_reason(&record), "capture-inventory-mismatch");
}

#[test]
fn aliased_inventory_file_fails_capture() {
    use dohc_engine_testkit::try_make_file_symlink;

    let fixture = Fixture::new();
    let faults = ScriptedFaults::crash_at(FaultPoint::AfterInitialized);
    assert!(matches!(
        fixture.run(faults.as_ref()),
        RehearsalOutcome::Crashed(_)
    ));

    // The recorded inventory is replaced by a SAME-CONTENT symlink: capture
    // would compare against mutable JSON outside the clone.
    let inventory = fixture
        .engine_dir()
        .join("CUTOVER_REHEARSAL_INVENTORY.json");
    let stash = fixture.recovery.join("stashed-inventory.json");
    std::fs::copy(&inventory, &stash).expect("stash inventory");
    std::fs::remove_file(&inventory).expect("remove inventory");
    if !try_make_file_symlink(&stash, &inventory).expect("symlink attempt") {
        return; // platform cannot create file symlinks — skip honestly
    }

    let outcome = fixture.run(&NoFaults);
    let record = match outcome {
        RehearsalOutcome::Failed(record) => record,
        other => panic!("an aliased inventory must fail capture: {other:?}"),
    };
    assert_eq!(failure_reason(&record), "inventory-alias-refused");
}

#[test]
fn junk_retained_store_is_refused() {
    let fixture = Fixture::new();
    let faults = ScriptedFaults::crash_at(FaultPoint::AfterMovedAside);
    assert!(matches!(
        fixture.run(faults.as_ref()),
        RehearsalOutcome::Crashed(_)
    ));
    let paths = fixture.paths();

    // The retained engine.db is overwritten with junk: a regular file with
    // the right name, but not the preserved old store.
    std::fs::write(
        moved_aside_path(&paths).join("engine.db"),
        b"not a database",
    )
    .expect("junk retained file");

    let outcome = fixture.run(&NoFaults);
    let record = match outcome {
        RehearsalOutcome::Failed(record) => record,
        other => panic!("a junk retained store must be refused: {other:?}"),
    };
    assert_eq!(failure_reason(&record), "initialize-retained-store-missing");
    assert!(
        !paths.db.exists(),
        "initialize must not fabricate a fresh store over a junk retained proof"
    );
}

#[test]
fn transient_backup_read_failure_during_capture_is_not_terminal() {
    let fixture = Fixture::new();
    let faults = ScriptedFaults::crash_at(FaultPoint::AfterInitialized);
    assert!(matches!(
        fixture.run(faults.as_ref()),
        RehearsalOutcome::Crashed(_)
    ));

    // The directory-backup manifest is transiently unavailable (e.g. the
    // recovery volume is being restored): capture must refuse WITHOUT
    // persisting a terminal Failed.
    let manifest = fixture.recovery.join("cutover-files.manifest.json");
    let parked = fixture.recovery.join("parked-manifest.json");
    std::fs::rename(&manifest, &parked).expect("park manifest");
    assert_refused(
        fixture.root.path(),
        || fixture.try_run_with_recovery(fixture.recovery.path()),
        "backup-directory-not-valid",
    );

    // Restored: the rehearsal resumes to Complete.
    std::fs::rename(&parked, &manifest).expect("restore manifest");
    assert!(matches!(
        fixture.run(&NoFaults),
        RehearsalOutcome::Complete(_)
    ));
}

#[test]
fn deleted_db_backup_after_initialized_never_persists_complete() {
    let fixture = Fixture::new();
    let faults = ScriptedFaults::crash_at(FaultPoint::AfterInitialized);
    assert!(matches!(
        fixture.run(faults.as_ref()),
        RehearsalOutcome::Crashed(_)
    ));

    // The recorded DB backup vanishes after Initialized: the Complete marker
    // must never be persisted without a re-proven restore point.
    std::fs::remove_file(fixture.recovery.join(format!("{}.db", db_backup_stem())))
        .expect("delete db backup");

    assert_first_refusal(
        fixture.root.path(),
        || fixture.try_run_with_recovery(fixture.recovery.path()),
        "backup-db-not-valid",
    );

    // The refusal stays non-terminal and repeatable.
    assert_refused(
        fixture.root.path(),
        || fixture.try_run_with_recovery(fixture.recovery.path()),
        "backup-db-not-valid",
    );
}

#[test]
fn aliased_wal_sidecar_is_refused_before_binding_open() {
    use dohc_engine_testkit::try_make_file_symlink;

    let fixture = Fixture::new();
    crash_at_backed_up(&fixture);

    // A WAL sidecar appears as a symlink to an external file: the read-only
    // WAL-mode binding open would consume it.
    let external = fixture.recovery.join("external-wal");
    std::fs::write(&external, vec![0_u8; 32]).expect("external wal bytes");
    let wal = fixture.engine_dir().join("engine.db-wal");
    if !try_make_file_symlink(&external, &wal).expect("symlink attempt") {
        return; // platform cannot create file symlinks — skip honestly
    }

    assert_refused(
        fixture.root.path(),
        || fixture.try_run_with_recovery(fixture.recovery.path()),
        "live-db-sidecar-alias-refused",
    );

    // Removing the alias resumes to Complete.
    std::fs::remove_file(&wal).expect("remove aliased sidecar");
    assert!(matches!(
        fixture.run(&NoFaults),
        RehearsalOutcome::Complete(_)
    ));
}

#[test]
fn malformed_directory_manifest_is_retryable_at_capture() {
    let fixture = Fixture::new();
    let faults = ScriptedFaults::crash_at(FaultPoint::AfterInitialized);
    assert!(matches!(
        fixture.run(faults.as_ref()),
        RehearsalOutcome::Crashed(_)
    ));

    // The directory manifest is transiently malformed (torn restore of the
    // recovery volume): refuse WITHOUT persisting a terminal Failed.
    let manifest = fixture.recovery.join("cutover-files.manifest.json");
    let original = std::fs::read(&manifest).expect("manifest bytes");
    std::fs::write(&manifest, b"{torn").expect("malform manifest");
    assert_refused(
        fixture.root.path(),
        || fixture.try_run_with_recovery(fixture.recovery.path()),
        "directory-manifest-malformed",
    );

    // Restored: the rehearsal resumes to Complete.
    std::fs::write(&manifest, &original).expect("restore manifest");
    assert!(matches!(
        fixture.run(&NoFaults),
        RehearsalOutcome::Complete(_)
    ));
}

#[test]
fn edited_backup_manifest_uuid_cannot_evade_stale_store_refusal() {
    let fixture = Fixture::new();
    let faults = ScriptedFaults::crash_at(FaultPoint::AfterMovedAside);
    assert!(matches!(
        fixture.run(faults.as_ref()),
        RehearsalOutcome::Crashed(_)
    ));
    let paths = fixture.paths();

    // The stale ORIGINAL store is copied back over engine.db, and the DB
    // backup manifest's engine_uuid field is edited (the DB checksum field is
    // untouched, so the pair still validates). The identity must come from
    // the backup DB bytes, so the stale copy is still refused.
    std::fs::copy(moved_aside_path(&paths).join("engine.db"), &paths.db)
        .expect("copy stale store back");
    let manifest_path = fixture
        .recovery
        .join(format!("{}.manifest.json", db_backup_stem()));
    let mut manifest: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&manifest_path).expect("manifest bytes"))
            .expect("manifest json");
    manifest["engine_uuid"] = serde_json::Value::String("forged-other-identity".to_owned());
    std::fs::write(
        &manifest_path,
        serde_json::to_vec(&manifest).expect("edited manifest"),
    )
    .expect("write edited manifest");

    let outcome = fixture.run(&NoFaults);
    let record = match outcome {
        RehearsalOutcome::Failed(record) => record,
        other => panic!("an edited manifest uuid must not evade the refusal: {other:?}"),
    };
    assert_eq!(failure_reason(&record), "initialize-stale-store");
}

#[test]
fn planted_backup_wal_sidecar_refuses_the_backup_pair() {
    let fixture = Fixture::new();
    let faults = ScriptedFaults::crash_at(FaultPoint::AfterMovedAside);
    assert!(matches!(
        fixture.run(faults.as_ref()),
        RehearsalOutcome::Crashed(_)
    ));

    // `VACUUM INTO` never produces a WAL: one planted beside the backup DB
    // could feed rows outside the recorded checksum into the identity read.
    let wal = fixture
        .recovery
        .join(format!("{}.db-wal", db_backup_stem()));
    std::fs::write(&wal, vec![0_u8; 32]).expect("planted wal");
    assert_refused(
        fixture.root.path(),
        || fixture.try_run_with_recovery(fixture.recovery.path()),
        "backup-db-sidecar-refused",
    );

    // Removing the planted sidecar resumes to Complete.
    std::fs::remove_file(&wal).expect("remove planted wal");
    assert!(matches!(
        fixture.run(&NoFaults),
        RehearsalOutcome::Complete(_)
    ));
}

#[test]
fn empty_engine_subdir_is_recorded_in_backup() {
    use super::backup::create_restore_tested_backup;

    let fixture = Fixture::new();
    std::fs::create_dir(fixture.engine_dir().join("empty-subdir")).expect("empty subdir");
    let paths = fixture.paths();
    create_restore_tested_backup(
        &paths,
        fixture.recovery.path(),
        SHADOW_TOKEN,
        NOW_MS + 1,
        &NoFaults,
    )
    .expect("backup with empty subdir");

    let manifest = load_valid_directory_backup(fixture.recovery.path())
        .expect("manifest")
        .expect("backup validates");
    assert!(
        manifest
            .directories
            .iter()
            .any(|dir| dir == "engine/empty-subdir"),
        "the empty subdir must be manifested: {:?}",
        manifest.directories
    );
    assert!(
        fixture
            .recovery
            .join("cutover-files")
            .join("engine")
            .join("empty-subdir")
            .is_dir(),
        "the empty subdir must exist in the backup"
    );
}

// ---------------------------------------------------------------------------
// Backup reuse, hygiene, and crash-recoverable publishes.
// ---------------------------------------------------------------------------

#[test]
fn foreign_db_backup_in_recovery_dir_is_refused() {
    use dohc_engine_storage::{
        BackupOutcome, NoFaults as StorageNoFaults, RealFreeSpace, create_verified_backup,
    };

    let fixture = Fixture::new();
    // A valid backup pair already sits in the recovery dir — but it was taken
    // from a DIFFERENT clone (bound to another shadow token).
    let foreign_root = ScratchDir::new().expect("foreign root");
    let foreign_db = foreign_root.engine_db_path().expect("foreign db path");
    let mut foreign = EngineStore::open(&foreign_db, NOW_MS).expect("foreign store");
    let other_token = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
    assert!(foreign.bind_shadow_clone_token(other_token).expect("bind"));
    let outcome = create_verified_backup(
        &foreign,
        fixture.recovery.path(),
        db_backup_stem(),
        "cutover-rehearsal",
        NOW_MS,
        &RealFreeSpace,
        &StorageNoFaults,
    )
    .expect("foreign backup");
    assert!(matches!(outcome, BackupOutcome::Verified(_)));
    drop(foreign);

    let outcome = fixture.run(&NoFaults);
    let record = match outcome {
        RehearsalOutcome::Failed(record) => record,
        other => panic!("a foreign backup must never be adopted: {other:?}"),
    };
    assert_eq!(failure_reason(&record), "backup-reuse-foreign-clone");
    assert!(
        load_valid_directory_backup(fixture.recovery.path())
            .expect("directory backup probe")
            .is_none(),
        "no directory backup may be built over a foreign safety net"
    );
    assert_triplet_matches(
        &fixture.engine_dir(),
        &fixture.original_triplet,
        "live triplet after foreign-backup refusal",
    );
}

#[test]
fn directory_backup_with_extras_or_empty_manifest_is_invalid() {
    let fixture = Fixture::new();
    assert!(matches!(
        fixture.run(&NoFaults),
        RehearsalOutcome::Complete(_)
    ));
    let recovery = fixture.recovery.path();
    assert!(
        load_valid_directory_backup(recovery)
            .expect("valid")
            .is_some()
    );

    // An undeclared extra file inside the backup dir invalidates it.
    let extra = fixture
        .recovery
        .join("cutover-files")
        .join("undeclared.txt");
    std::fs::write(&extra, b"extra").expect("extra file");
    assert!(
        load_valid_directory_backup(recovery)
            .expect("extra probe")
            .is_none(),
        "an undeclared extra file must invalidate the directory backup"
    );
    std::fs::remove_file(&extra).expect("remove extra");
    assert!(
        load_valid_directory_backup(recovery)
            .expect("restored")
            .is_some()
    );

    // An undeclared EMPTY directory invalidates it too.
    let extra_dir = fixture
        .recovery
        .join("cutover-files")
        .join("undeclared-dir");
    std::fs::create_dir(&extra_dir).expect("extra dir");
    assert!(
        load_valid_directory_backup(recovery)
            .expect("extra dir probe")
            .is_none(),
        "an undeclared empty directory must invalidate the directory backup"
    );
    std::fs::remove_dir(&extra_dir).expect("remove extra dir");
    assert!(
        load_valid_directory_backup(recovery)
            .expect("restored again")
            .is_some()
    );

    // An empty manifest never validates.
    std::fs::write(
        fixture.recovery.join("cutover-files.manifest.json"),
        br#"{"verified":true,"files":[]}"#,
    )
    .expect("empty manifest");
    assert!(
        load_valid_directory_backup(recovery)
            .expect("empty probe")
            .is_none(),
        "an empty manifest must never validate"
    );
}

#[test]
fn stale_directory_backup_artifacts_are_cleared_and_rebuilt() {
    let fixture = Fixture::new();
    // Crash leftovers: a staging dir and an unmanifested published dir.
    let staging = fixture.recovery.join("cutover-files.staging");
    std::fs::create_dir(&staging).expect("staging dir");
    std::fs::write(staging.join("garbage"), b"x").expect("staging garbage");
    let published = fixture.recovery.join("cutover-files");
    std::fs::create_dir(&published).expect("published dir");
    std::fs::write(published.join("stale"), b"y").expect("published garbage");

    let outcome = fixture.run(&NoFaults);
    assert!(
        matches!(outcome, RehearsalOutcome::Complete(_)),
        "stale uncommitted backup artifacts must not wedge the run: {outcome:?}"
    );
    assert!(!staging.exists(), "staging must be cleared");
    let manifest = load_valid_directory_backup(fixture.recovery.path())
        .expect("manifest")
        .expect("rebuilt backup validates");
    assert!(
        !manifest
            .files
            .iter()
            .any(|entry| entry.relative_path == "stale"),
        "the rebuilt backup must not adopt stale garbage"
    );
}

#[test]
fn stale_inventory_temp_does_not_wedge_the_run() {
    let fixture = Fixture::new();
    // The crash window: a torn inventory temp exists, no inventory published.
    let temp = fixture
        .engine_dir()
        .join("CUTOVER_REHEARSAL_INVENTORY.json.tmp");
    std::fs::write(&temp, b"{torn").expect("stale temp");

    let outcome = fixture.run(&NoFaults);
    assert!(
        matches!(outcome, RehearsalOutcome::Complete(_)),
        "a stale inventory temp must not wedge the run: {outcome:?}"
    );
    assert!(!temp.exists(), "the stale temp must be cleared by publish");
    assert!(load_inventory(fixture.root.path()).is_ok());
}

#[test]
fn absent_optional_sibling_snapshot_is_allowed() {
    let fixture = Fixture::new();
    std::fs::remove_file(fixture.root.join(".dohc").join("agent-runs.json"))
        .expect("remove optional sibling");

    let outcome = fixture.run(&NoFaults);
    assert!(
        matches!(outcome, RehearsalOutcome::Complete(_)),
        "an absent optional sibling snapshot must not fail the backup: {outcome:?}"
    );
    let manifest = load_valid_directory_backup(fixture.recovery.path())
        .expect("manifest")
        .expect("backup validates");
    assert!(
        !manifest
            .files
            .iter()
            .any(|entry| entry.relative_path == "dohc/agent-runs.json"),
        "an absent sibling must simply not be manifested"
    );
}

#[test]
fn tampered_migration_ledger_same_length_is_refused_before_backup() {
    let fixture = Fixture::new();
    // Same LENGTH, different identity: the last expected migration row is
    // replaced by an unrelated one, so a count compare would pass.
    {
        let conn = rusqlite::Connection::open(fixture.engine_dir().join("engine.db"))
            .expect("open rw for tamper");
        conn.execute(
            "UPDATE engine_migrations SET id = 'v1-bogus', checksum = 'beef' \
             WHERE ordinal = (SELECT MAX(ordinal) FROM engine_migrations)",
            [],
        )
        .expect("tamper ledger");
    }

    let outcome = fixture.run(&NoFaults);
    let record = match outcome {
        RehearsalOutcome::Failed(record) => record,
        other => panic!("a tampered ledger must refuse the backup: {other:?}"),
    };
    assert_eq!(failure_reason(&record), "backup-source-pending-migrations");
    assert!(
        load_valid_backup(fixture.recovery.path(), db_backup_stem())
            .expect("db backup probe")
            .is_none(),
        "no backup may be taken from a source the build would migrate"
    );
}

#[cfg(unix)]
#[test]
fn hard_linked_workspace_file_is_refused() {
    use dohc_engine_testkit::make_hardlink;

    let fixture = Fixture::new();
    make_hardlink(
        &fixture.root.join("documents").join("note.md"),
        &fixture.root.join("documents").join("alias.md"),
    )
    .expect("hard link");

    let outcome = fixture.run(&NoFaults);
    let record = match outcome {
        RehearsalOutcome::Failed(record) => record,
        other => panic!("a hard-linked workspace file must be refused: {other:?}"),
    };
    assert_eq!(failure_reason(&record), "settle-hardlink-refused");
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

/// An IO ERROR (not a mismatch) inside the post-move verification must route
/// through the rollback exactly like a mismatch — never bypass it and leave
/// the live triplet absent.
#[cfg(windows)]
#[test]
fn post_move_verification_error_restores_live_triplet() {
    use std::os::windows::fs::OpenOptionsExt as _;

    let root = ScratchDir::new().expect("root");
    let recovery = ScratchDir::new().expect("recovery");
    let engine = root.join(".dohc").join("engine");
    std::fs::create_dir_all(&engine).expect("engine dir");
    std::fs::write(engine.join("engine.db"), b"primary bytes").expect("db");
    std::fs::write(engine.join("engine.db-wal"), b"wal bytes").expect("wal");
    std::fs::write(engine.join("engine.db-shm"), b"shm bytes").expect("shm");
    let original = snapshot_triplet(root.path());
    let paths = Paths::new(root.path().to_path_buf());

    let verified = acquire_copy_hash_close(&paths, recovery.path()).expect("phase A");
    // Shares only DELETE: Phase B's rename succeeds, but the post-move hash
    // open is denied — an IO error inside verification.
    let interloper = std::fs::OpenOptions::new()
        .read(true)
        .share_mode(0x4)
        .open(&paths.db)
        .expect("delete-only handle");

    let error = super::handles::swap_and_verify(&paths, &verified)
        .expect_err("verification must error while the handle denies reads");
    drop(interloper);

    assert!(
        matches!(
            error,
            RehearsalError::Io {
                code: "triplet-verify-open"
            }
        ),
        "unexpected error: {error:?}"
    );
    assert_triplet_matches(
        &paths.engine,
        &original,
        "restored live triplet after verification IO error",
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
