use super::backup::{
    create_restore_tested_backup, ensure_outside_root, fingerprint_backup, verify_recorded_backup,
};
use super::faults::{FaultAction, FaultInjector, FaultPoint};
use super::fence::{validate_rehearsal_root, verify_live_clone_binding};
use super::handles::{move_aside, moved_aside_db_present};
use super::inventory::{load_inventory, load_or_record, scan};
use super::state::{self, RehearsalState, StableState, StateRecord};
use super::{Paths, RehearsalError};
use dohc_engine_storage::EngineStore;
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};

const SETTLE_READ_BUFFER_BYTES: usize = 64 * 1024;

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
    let mut record = state::initialize(&paths.root)?;
    if let RehearsalState::Failed { .. } = record.current {
        return Ok(RehearsalOutcome::Failed(record));
    }

    // Every invocation — fresh or resumed — re-proves the recovery dir is
    // outside the clone root before any step may touch it.
    if let Err(error) = ensure_outside_root(&paths.root, config.recovery_dir) {
        return fail(&paths.root, &record, failure_code(&error));
    }
    let recovery_dir = match canonical_recovery_dir(config.recovery_dir) {
        Ok(dir) => dir,
        Err(error) => return fail(&paths.root, &record, failure_code(&error)),
    };

    loop {
        match record.current {
            RehearsalState::Complete => {
                // A persisted Complete is only trusted once the artifacts it
                // implies — the recorded backups and the retained old store —
                // are re-proven on disk.
                if let Err(error) = verify_recorded_backup(&recovery_dir, record.backup.as_ref()) {
                    return fail(&paths.root, &record, failure_code(&error));
                }
                if !moved_aside_db_present(&paths) {
                    return fail(&paths.root, &record, "complete-retained-store-missing");
                }
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
                let backed_up = verify_live_clone_binding(&paths.db, &validated.shadow_token)
                    .and_then(|()| load_or_record(&paths.root))
                    .and_then(|_| {
                        create_restore_tested_backup(
                            &paths,
                            &recovery_dir,
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
                // The destructive move runs only after (a) the recorded backup
                // re-validates at the recorded recovery dir and (b) the live db
                // itself proves it is the clone the fence validated.
                if let Err(error) = verify_recorded_backup(&recovery_dir, record.backup.as_ref())
                    .and_then(|()| verify_live_clone_binding(&paths.db, &validated.shadow_token))
                {
                    return fail(&paths.root, &record, failure_code(&error));
                }
                if let Err(error) = move_aside(&paths, &recovery_dir) {
                    return fail(&paths.root, &record, failure_code(&error));
                }
                record = state::transition(&paths.root, &record, StableState::MovedAside)?;
                if config.faults.poll(FaultPoint::AfterMovedAside) == FaultAction::Crash {
                    return Ok(RehearsalOutcome::Crashed(record));
                }
            }
            RehearsalState::MovedAside => {
                if let Err(error) =
                    initialize_fresh_store(&paths, &validated.shadow_token, config.now_ms)
                {
                    return fail(&paths.root, &record, failure_code(&error));
                }
                record = state::transition(&paths.root, &record, StableState::Initialized)?;
                if config.faults.poll(FaultPoint::AfterInitialized) == FaultAction::Crash {
                    return Ok(RehearsalOutcome::Crashed(record));
                }
            }
            RehearsalState::Initialized => {
                let capture = load_inventory(&paths.root).and_then(|expected| {
                    let actual = scan(&paths.root)?;
                    if actual == expected {
                        Ok(())
                    } else {
                        Err(RehearsalError::Io {
                            code: "capture-inventory-mismatch",
                        })
                    }
                });
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
    std::fs::create_dir_all(recovery_dir)
        .map_err(|e| RehearsalError::io("recovery-dir-create", e))?;
    std::fs::canonicalize(recovery_dir)
        .map_err(|e| RehearsalError::io("recovery-dir-canonicalize", e))
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
    settle_directory(root)
}

fn settle_directory(directory: &Path) -> Result<(), RehearsalError> {
    let entries =
        std::fs::read_dir(directory).map_err(|e| RehearsalError::io("settle-enumerate", e))?;
    for entry in entries {
        let entry = entry.map_err(|e| RehearsalError::io("settle-entry", e))?;
        let path = entry.path();
        let metadata = std::fs::symlink_metadata(&path)
            .map_err(|e| RehearsalError::io("settle-metadata", e))?;
        if metadata.file_type().is_symlink() {
            return Err(RehearsalError::Io {
                code: "settle-alias-refused",
            });
        }
        if metadata.is_dir() {
            settle_directory(&path)?;
        } else if metadata.is_file() {
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
    now_ms: i64,
) -> Result<(), RehearsalError> {
    let mut store = EngineStore::open(&paths.db, now_ms)?;
    if !store.was_freshly_created() || !store.bind_shadow_clone_token(shadow_token)? {
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
    Ok(())
}
