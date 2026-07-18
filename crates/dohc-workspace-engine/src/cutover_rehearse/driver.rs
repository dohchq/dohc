use super::backup::{
    create_restore_tested_backup, ensure_outside_root, fingerprint_backup,
    recorded_backup_engine_uuid, verify_protected_snapshots, verify_recorded_backup,
};
use super::faults::{FaultAction, FaultInjector, FaultPoint};
use super::fence::{
    validate_rehearsal_root, verify_live_clone_binding, verify_live_reset_identity,
};
use super::handles::{move_aside, moved_aside_store_retained};
use super::inventory::{load_inventory, load_or_record, scan};
use super::state::{self, RehearsalState, StableState, StateRecord};
use super::{Paths, RehearsalError};
use dohc_engine_storage::EngineStore;
use std::fs::{File, OpenOptions};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Duration;

const SETTLE_READ_BUFFER_BYTES: usize = 64 * 1024;
const ROOT_LOCK_ATTEMPTS: usize = 6;

use super::ROOT_LOCK_FILE;

pub struct RehearsalConfig<'a> {
    pub root: &'a Path,
    pub recovery_dir: &'a Path,
    pub now_ms: i64,
    pub faults: &'a dyn FaultInjector,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RehearsalOutcome {
    Complete(StateRecord),
    Failed(StateRecord),
    Crashed(StateRecord),
}

pub fn run_rehearsal(config: RehearsalConfig<'_>) -> Result<RehearsalOutcome, RehearsalError> {
    let validated = validate_rehearsal_root(config.root)?;
    let paths = Paths::new(validated.root.clone());

    // The recovery dir is proven valid — outside the clone root, creatable,
    // canonical — BEFORE any state is persisted, on every invocation. A
    // violation is a caller/configuration error: refuse with `Err` (retryable
    // with a correct dir) rather than poisoning the persisted state.
    ensure_outside_root(&paths.root, config.recovery_dir)?;
    let recovery_dir = canonical_recovery_dir(config.recovery_dir)?;

    // The fence resolves marker files THROUGH `.dohc`/`engine`, so an aliased
    // component would let the lock file below be created outside the clone.
    // Refuse before anything under the root is written.
    ensure_real_engine_dir(&paths)?;

    // One rehearsal per root at a time: an advisory cross-process lock held
    // from before the first state read until this function returns.
    let _root_lock = acquire_root_lock(&paths)?;

    let mut record = state::initialize(&paths.root)?;

    loop {
        match record.current {
            RehearsalState::Complete => {
                // A persisted Complete is only trusted once the artifacts it
                // implies — the recorded backups, the retained old store, and
                // the bound fresh live store — are re-proven on disk.
                verify_recorded_backup(&recovery_dir, record.backup.as_ref())?;
                if !moved_aside_store_retained(&paths)? {
                    return Err(RehearsalError::Io {
                        code: "complete-retained-store-missing",
                    });
                }
                verify_live_clone_binding(&paths.db, &validated.shadow_token)?;
                verify_live_reset_identity(
                    &paths.db,
                    record
                        .fresh_engine_uuid
                        .as_deref()
                        .ok_or(RehearsalError::Io {
                            code: "resume-reset-identity-unrecorded",
                        })?,
                )?;
                return Ok(RehearsalOutcome::Complete(record));
            }
            RehearsalState::Failed { .. } => return Ok(RehearsalOutcome::Failed(record)),
            RehearsalState::NotStarted => {
                if let Err(error) = settle_fixture_tree(&paths.root) {
                    return fail(&paths.root, &record, failure_code(&error));
                }
                record = state::transition(&paths.root, &record, StableState::Settled)?;
            }
            RehearsalState::Settled => {
                // Precondition (refusal, not terminal): the live db itself
                // must prove it is the clone the fence validated.
                verify_live_clone_binding(&paths.db, &validated.shadow_token)?;
                let backed_up = load_or_record(&paths.root)
                    .and_then(|_| {
                        create_restore_tested_backup(
                            &paths,
                            &recovery_dir,
                            &validated.shadow_token,
                            config.now_ms,
                            config.faults,
                        )
                    })
                    .and_then(|()| fingerprint_backup(&recovery_dir));
                let fingerprint = match backed_up {
                    Ok(fingerprint) => fingerprint,
                    Err(error) => return fail(&paths.root, &record, failure_code(&error)),
                };
                record = state::transition_backed_up(&paths.root, &record, fingerprint)?;
                if config.faults.poll(FaultPoint::AfterBackedUp) == FaultAction::Crash {
                    return Ok(RehearsalOutcome::Crashed(record));
                }
            }
            RehearsalState::BackedUp => {
                // Preconditions (refusals, not terminal — the operator can
                // restore the backup or pass the recorded dir and resume):
                // the recorded backup must re-validate at the recorded
                // recovery dir, and the live db must re-prove its binding. A
                // missing live db here (crash between the physical move and
                // the MovedAside marker) cannot be re-proven against the
                // recorded fingerprint, so it stays a refusal.
                verify_recorded_backup(&recovery_dir, record.backup.as_ref())?;
                verify_live_clone_binding(&paths.db, &validated.shadow_token)?;
                if let Err(error) = move_aside(&paths, &recovery_dir) {
                    return fail(&paths.root, &record, failure_code(&error));
                }
                record = state::transition(&paths.root, &record, StableState::MovedAside)?;
                if config.faults.poll(FaultPoint::AfterMovedAside) == FaultAction::Crash {
                    return Ok(RehearsalOutcome::Crashed(record));
                }
            }
            RehearsalState::MovedAside => {
                verify_recorded_backup(&recovery_dir, record.backup.as_ref())?;
                let fresh_engine_uuid = match initialize_fresh_store(
                    &paths,
                    &validated.shadow_token,
                    &recovery_dir,
                    config.now_ms,
                ) {
                    Ok(uuid) => uuid,
                    Err(error) => return fail(&paths.root, &record, failure_code(&error)),
                };
                record = state::transition_initialized(&paths.root, &record, fresh_engine_uuid)?;
                if config.faults.poll(FaultPoint::AfterInitialized) == FaultAction::Crash {
                    return Ok(RehearsalOutcome::Crashed(record));
                }
            }
            RehearsalState::Initialized => {
                // Precondition (refusal): the fresh live store must still
                // exist, prove its clone binding, AND carry the recorded
                // reset identity — the user-file inventory below skips
                // `.dohc`, and a stale same-clone copy shares the token.
                verify_live_clone_binding(&paths.db, &validated.shadow_token)?;
                verify_live_reset_identity(
                    &paths.db,
                    record
                        .fresh_engine_uuid
                        .as_deref()
                        .ok_or(RehearsalError::Io {
                            code: "resume-reset-identity-unrecorded",
                        })?,
                )?;
                let capture = load_inventory(&paths.root)
                    .and_then(|expected| {
                        let actual = scan(&paths.root)?;
                        if actual == expected {
                            Ok(())
                        } else {
                            Err(RehearsalError::Io {
                                code: "capture-inventory-mismatch",
                            })
                        }
                    })
                    .and_then(|()| verify_protected_snapshots(&paths, &recovery_dir));
                if let Err(error) = capture {
                    return fail(&paths.root, &record, failure_code(&error));
                }
                record = state::transition(&paths.root, &record, StableState::Capturing)?;
            }
            RehearsalState::Capturing => {
                record = state::transition(&paths.root, &record, StableState::Complete)?;
            }
        }
    }
}

fn fail(
    root: &Path,
    record: &StateRecord,
    reason: &'static str,
) -> Result<RehearsalOutcome, RehearsalError> {
    let failed = state::fail(root, record, reason)?;
    Ok(RehearsalOutcome::Failed(failed))
}

fn canonical_recovery_dir(recovery_dir: &Path) -> Result<PathBuf, RehearsalError> {
    super::backup::create_private_dir_all(recovery_dir)?;
    std::fs::canonicalize(recovery_dir)
        .map_err(|e| RehearsalError::io("recovery-dir-canonicalize", e))
}

/// `.dohc` and `.dohc/engine` must be REAL directories: a symlinked component
/// would redirect every marker lookup — and the lock/state writes below —
/// into a directory outside the clone root.
fn ensure_real_engine_dir(paths: &Paths) -> Result<(), RehearsalError> {
    for dir in [&paths.root.join(".dohc"), &paths.engine] {
        match std::fs::symlink_metadata(dir) {
            Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
                return Err(RehearsalError::Io {
                    code: "engine-dir-alias-refused",
                });
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(RehearsalError::io("engine-dir-metadata", error)),
        }
    }
    Ok(())
}

/// Advisory single-writer guard: the OS releases the lock when the file
/// handle drops (function return, panic, or process death alike).
struct RootLock {
    _file: File,
}

fn acquire_root_lock(paths: &Paths) -> Result<RootLock, RehearsalError> {
    std::fs::create_dir_all(&paths.engine)
        .map_err(|e| RehearsalError::io("rehearsal-lock-dir", e))?;
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(paths.engine.join(ROOT_LOCK_FILE))
        .map_err(|e| RehearsalError::io("rehearsal-lock-open", e))?;
    for attempt in 0..ROOT_LOCK_ATTEMPTS {
        // fs4 rather than std's `File::try_lock`: same OS lock, but available
        // at the workspace MSRV (std stabilized it in 1.89).
        match fs4::FileExt::try_lock(&file) {
            Ok(()) => return Ok(RootLock { _file: file }),
            Err(fs4::TryLockError::Error(error)) => {
                return Err(RehearsalError::io("rehearsal-lock", error));
            }
            Err(fs4::TryLockError::WouldBlock) => {
                if attempt + 1 < ROOT_LOCK_ATTEMPTS {
                    std::thread::sleep(Duration::from_millis(10_u64 << attempt));
                }
            }
        }
    }
    Err(RehearsalError::Io {
        code: "rehearsal-lock-contended",
    })
}

fn failure_code(error: &RehearsalError) -> &'static str {
    match error {
        RehearsalError::Fence(_) => "fence-refused",
        RehearsalError::State => "state-invalid",
        RehearsalError::Io { code } => code,
        RehearsalError::Storage(_) => "storage-failed",
        RehearsalError::Files(_) => "file-hash-failed",
    }
}

fn settle_fixture_tree(root: &Path) -> Result<(), RehearsalError> {
    // The real Y.Doc force-settle and projection-freshness proof run in the
    // TypeScript desktop app before this Rust rehearsal. R15-REHEARSE only
    // verifies that its clone fixture tree is readable and contains no aliases.
    let lock = root.join(".dohc").join("engine").join(ROOT_LOCK_FILE);
    settle_directory(root, &lock)
}

fn settle_directory(directory: &Path, lock: &Path) -> Result<(), RehearsalError> {
    let entries =
        std::fs::read_dir(directory).map_err(|e| RehearsalError::io("settle-enumerate", e))?;
    for entry in entries {
        let entry = entry.map_err(|e| RehearsalError::io("settle-entry", e))?;
        let path = entry.path();
        if path == *lock {
            continue;
        }
        let metadata = std::fs::symlink_metadata(&path)
            .map_err(|e| RehearsalError::io("settle-metadata", e))?;
        if metadata.file_type().is_symlink() {
            return Err(RehearsalError::Io {
                code: "settle-alias-refused",
            });
        }
        if metadata.is_dir() {
            settle_directory(&path, lock)?;
        } else if metadata.is_file() {
            if super::metadata_is_hard_linked(&metadata) {
                return Err(RehearsalError::Io {
                    code: "settle-hardlink-refused",
                });
            }
            prove_readable(&path)?;
        } else {
            return Err(RehearsalError::Io {
                code: "settle-special-file-refused",
            });
        }
    }
    Ok(())
}

fn prove_readable(path: &Path) -> Result<(), RehearsalError> {
    let mut file = File::open(path).map_err(|e| RehearsalError::io("settle-open", e))?;
    let mut buffer = vec![0_u8; SETTLE_READ_BUFFER_BYTES];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|e| RehearsalError::io("settle-read", e))?;
        if read == 0 {
            return Ok(());
        }
    }
}

fn initialize_fresh_store(
    paths: &Paths,
    shadow_token: &str,
    recovery_dir: &Path,
    now_ms: i64,
) -> Result<String, RehearsalError> {
    // The retained moved-aside store is the proof that MovedAside really
    // happened. Without it (forged marker, lost sibling) nothing may be
    // created or opened — `EngineStore::open` would fabricate a fresh db.
    if !moved_aside_store_retained(paths)? {
        return Err(RehearsalError::Io {
            code: "initialize-retained-store-missing",
        });
    }
    let mut store = EngineStore::open(&paths.db, now_ms)?;
    // A fresh store is bound here; an EXISTING store is acceptable only when
    // already bound to this clone (the crash window between a completed
    // initialize and its marker).
    if !store.bind_shadow_clone_token(shadow_token)? {
        return Err(RehearsalError::Io {
            code: "initialize-not-fresh",
        });
    }
    let (engine_uuid, engine_build) = store.ownership()?;
    if engine_uuid.is_empty() || engine_build.is_empty() {
        return Err(RehearsalError::Io {
            code: "initialize-ownership-missing",
        });
    }
    // The freshness proof: the backed-up ORIGINAL identity may not reappear
    // as the live store — a stale same-clone copy (old store or backup
    // restored over engine.db) shares the shadow token but not a new uuid.
    if engine_uuid == recorded_backup_engine_uuid(recovery_dir)? {
        return Err(RehearsalError::Io {
            code: "initialize-stale-store",
        });
    }
    Ok(engine_uuid)
}
