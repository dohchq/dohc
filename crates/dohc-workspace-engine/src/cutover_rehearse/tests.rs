use super::backup::{db_backup_stem, load_valid_directory_backup};
use super::faults::{FaultPoint, NoFaults, ScriptedFaults};
use super::handles::{acquire_copy_hash_close, moved_aside_path, swap_and_verify};
use super::inventory::scan;
use super::*;
use crate::shadow_fence::write_shadow_marker_for_harness;
use dohc_engine_storage::{EngineStore, load_valid_backup};
use dohc_engine_testkit::ScratchDir;
use std::path::{Path, PathBuf};

const SHADOW_TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const REHEARSAL_TOKEN: &str = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
const NOW_MS: i64 = 1_753_000_000_000;
const COMPLETE_HISTORY: [StableState; 7] = [
    StableState::NotStarted,
    StableState::Settled,
    StableState::BackedUp,
    StableState::MovedAside,
    StableState::Initialized,
    StableState::Capturing,
    StableState::Complete,
];

struct Fixture {
    root: ScratchDir,
    recovery: ScratchDir,
    user_file: PathBuf,
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
        std::fs::write(dohc.join("registry.json"), br#"{"registry":true}"#)
            .expect("registry snapshot");
        std::fs::write(dohc.join("dm-homing.json"), br#"{"homing":true}"#)
            .expect("homing snapshot");
        std::fs::write(dohc.join("agent-runs.json"), br#"{"runs":[]}"#)
            .expect("agent runs snapshot");
        std::fs::write(
            root.join(".dohc").join("engine").join("engine-note.json"),
            br#"{"engine":"fixture"}"#,
        )
        .expect("engine companion");

        let documents = root.join("documents");
        std::fs::create_dir(&documents).expect("documents directory");
        let user_file = documents.join("note.md");
        std::fs::write(&user_file, b"fixture body\n").expect("user file");
        std::fs::write(root.join("readme.txt"), b"fixture readme\n").expect("second user file");

        let original_triplet = snapshot_triplet(root.path());
        Self {
            root,
            recovery,
            user_file,
            original_triplet,
        }
    }

    fn run(&self, faults: &dyn FaultInjector) -> RehearsalOutcome {
        run_rehearsal(RehearsalConfig {
            root: self.root.path(),
            recovery_dir: self.recovery.path(),
            now_ms: NOW_MS + 1,
            faults,
        })
        .expect("rehearsal result")
    }
}

#[test]
fn rehearsal_fence_requires_both_markers() {
    let neither = ScratchDir::new().expect("neither scratch");
    assert!(validate_rehearsal_root(neither.path()).is_err());

    let shadow_only = ScratchDir::new().expect("shadow-only scratch");
    write_shadow_marker_for_harness(shadow_only.path(), SHADOW_TOKEN).expect("shadow marker");
    assert!(validate_rehearsal_root(shadow_only.path()).is_err());

    let rehearsal_only = ScratchDir::new().expect("rehearsal-only scratch");
    write_rehearsal_token_for_harness(rehearsal_only.path(), REHEARSAL_TOKEN)
        .expect("rehearsal marker");
    assert!(validate_rehearsal_root(rehearsal_only.path()).is_err());

    let both = ScratchDir::new().expect("both scratch");
    write_shadow_marker_for_harness(both.path(), SHADOW_TOKEN).expect("shadow marker");
    write_rehearsal_token_for_harness(both.path(), REHEARSAL_TOKEN).expect("rehearsal marker");
    let validated = validate_rehearsal_root(both.path()).expect("both markers accepted");
    assert_eq!(validated.shadow_token, SHADOW_TOKEN);
    assert_eq!(validated.rehearsal_token, REHEARSAL_TOKEN);
}

#[test]
fn happy_path_reaches_complete_with_retained_store_and_verified_backups() {
    let fixture = Fixture::new();
    let outcome = fixture.run(&NoFaults);
    let record = match outcome {
        RehearsalOutcome::Complete(record) => record,
        other => panic!("expected complete outcome: {other:?}"),
    };
    assert_eq!(record.current, RehearsalState::Complete);
    assert_eq!(record.history, COMPLETE_HISTORY);
    assert_eq!(
        load_state(fixture.root.path()).expect("load state"),
        Some(record)
    );

    let paths = Paths::new(fixture.root.path().to_path_buf());
    assert_triplet_matches(
        &moved_aside_path(&paths),
        &fixture.original_triplet,
        "retained old triplet",
    );
    assert!(
        load_valid_backup(fixture.recovery.path(), db_backup_stem())
            .expect("load DB backup")
            .is_some()
    );
    assert!(
        load_valid_directory_backup(fixture.recovery.path())
            .expect("load directory backup")
            .is_some()
    );
    assert_eq!(
        load_inventory(fixture.root.path()).expect("load inventory"),
        scan(fixture.root.path()).expect("scan final tree")
    );
}

#[test]
fn backup_faults_fail_closed_without_valid_partial_backups() {
    let cases = [
        (FaultPoint::BackupAfterDatabaseCopy, false),
        (FaultPoint::BackupDuringDatabaseVerify, false),
        (FaultPoint::BackupDuringDirectoryCopy, true),
    ];
    for (point, completed_db_backup_is_valid) in cases {
        let fixture = Fixture::new();
        let faults = ScriptedFaults::crash_at(point);
        let outcome = fixture.run(faults.as_ref());
        assert!(faults.fired(), "fault did not fire: {}", point.as_str());
        let record = match outcome {
            RehearsalOutcome::Failed(record) => record,
            other => panic!("expected failed backup outcome at {point:?}: {other:?}"),
        };
        assert!(matches!(
            record.current,
            RehearsalState::Failed {
                at: StableState::Settled,
                ..
            }
        ));
        assert_triplet_matches(
            &fixture.root.join(".dohc").join("engine"),
            &fixture.original_triplet,
            "source triplet after backup failure",
        );
        assert_eq!(
            load_valid_backup(fixture.recovery.path(), db_backup_stem())
                .expect("load DB backup")
                .is_some(),
            completed_db_backup_is_valid,
            "only a fully completed DB sub-backup may validate at {point:?}"
        );
        assert!(
            load_valid_directory_backup(fixture.recovery.path())
                .expect("load directory backup")
                .is_none(),
            "a partial directory backup validated at {point:?}"
        );
    }
}

#[cfg(windows)]
#[test]
fn windows_move_aside_interloper_refuses_swap_and_preserves_triplet() {
    use std::os::windows::fs::OpenOptionsExt as _;

    let (root, recovery, paths, original) = plain_triplet_fixture();
    let verified = acquire_copy_hash_close(&paths, recovery.path()).expect("phase A proof");
    let interloper = std::fs::OpenOptions::new()
        .read(true)
        .share_mode(0x1 | 0x2)
        .open(&paths.db)
        .expect("interloper handle");
    let error = swap_and_verify(&paths, &verified).expect_err("sharing violation must fail");
    assert!(matches!(
        error,
        RehearsalError::Io {
            code: "triplet-swap-timeout"
        }
    ));
    drop(interloper);
    assert_triplet_matches(&paths.engine, &original, "live triplet after refused swap");
    drop(root);
}

#[cfg(unix)]
#[test]
fn unix_move_aside_interloper_hash_mismatch_restores_triplet() {
    let (root, recovery, paths, original) = plain_triplet_fixture();
    let verified = acquire_copy_hash_close(&paths, recovery.path()).expect("phase A proof");
    let interloper = b"tampered data";
    assert_eq!(
        interloper.len(),
        std::fs::metadata(&paths.db)
            .expect("original metadata")
            .len() as usize,
        "the interloper must preserve size so verification reaches the hash gate"
    );
    std::fs::write(&paths.db, interloper).expect("interloper write");
    let error = swap_and_verify(&paths, &verified).expect_err("hash mismatch must fail");
    assert!(
        matches!(
            error,
            RehearsalError::Io {
                code: "moved-aside-hash-mismatch"
            }
        ),
        "unexpected error: {error:?}"
    );
    assert_triplet_matches(&paths.engine, &original, "restored live triplet");
    assert!(moved_aside_path(&paths).join("engine.db").is_file());
    drop(root);
}

#[test]
fn capture_inventory_mismatch_is_terminal_and_never_retries() {
    let fixture = Fixture::new();
    let faults = ScriptedFaults::crash_at(FaultPoint::AfterInitialized);
    let first = fixture.run(faults.as_ref());
    assert!(faults.fired());
    let initialized = match first {
        RehearsalOutcome::Crashed(record) => record,
        other => panic!("expected crash after initialized: {other:?}"),
    };
    assert_eq!(initialized.current, RehearsalState::Initialized);

    std::fs::write(&fixture.user_file, b"mutated after initialized\n")
        .expect("mutate captured file");
    let second = fixture.run(&NoFaults);
    let failed = match second {
        RehearsalOutcome::Failed(record) => record,
        other => panic!("expected capture mismatch failure: {other:?}"),
    };
    assert!(matches!(
        &failed.current,
        RehearsalState::Failed { reason, at }
            if reason == "capture-inventory-mismatch" && *at == StableState::Initialized
    ));
    assert!(!failed.history.contains(&StableState::Complete));

    let third = fixture.run(&NoFaults);
    let still_failed = match third {
        RehearsalOutcome::Failed(record) => record,
        other => panic!("failed marker must remain terminal: {other:?}"),
    };
    assert_eq!(still_failed, failed);
}

#[test]
fn adjacent_state_crashes_resume_from_last_completed_state() {
    let cases = [
        (FaultPoint::AfterBackedUp, StableState::BackedUp),
        (FaultPoint::AfterMovedAside, StableState::MovedAside),
    ];
    for (point, expected_state) in cases {
        let fixture = Fixture::new();
        let faults = ScriptedFaults::crash_at(point);
        let first = fixture.run(faults.as_ref());
        assert!(faults.fired(), "fault did not fire: {}", point.as_str());
        let crashed = match first {
            RehearsalOutcome::Crashed(record) => record,
            other => panic!("expected crash at {point:?}: {other:?}"),
        };
        assert_eq!(crashed.current.stable(), Some(expected_state));
        assert_eq!(
            load_state(fixture.root.path()).expect("durable state"),
            Some(crashed)
        );

        let resumed = fixture.run(&NoFaults);
        let complete = match resumed {
            RehearsalOutcome::Complete(record) => record,
            other => panic!("expected resumed completion at {point:?}: {other:?}"),
        };
        assert_eq!(complete.history, COMPLETE_HISTORY);
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

#[cfg(any(windows, unix))]
type PlainTripletFixture = (ScratchDir, ScratchDir, Paths, Vec<(&'static str, Vec<u8>)>);

#[cfg(any(windows, unix))]
fn plain_triplet_fixture() -> PlainTripletFixture {
    let root = ScratchDir::new().expect("triplet root");
    let recovery = ScratchDir::new().expect("triplet recovery");
    let engine = root.join(".dohc").join("engine");
    std::fs::create_dir_all(&engine).expect("triplet engine dir");
    std::fs::write(engine.join("engine.db"), b"primary bytes").expect("primary");
    std::fs::write(engine.join("engine.db-wal"), b"wal bytes").expect("wal");
    std::fs::write(engine.join("engine.db-shm"), b"shm bytes").expect("shm");
    let original = snapshot_triplet(root.path());
    let paths = Paths::new(root.path().to_path_buf());
    (root, recovery, paths, original)
}
