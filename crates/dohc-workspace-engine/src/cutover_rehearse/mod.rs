//! Clone-only rehearsal of the atomic cutover reset state machine.
//!
//! This module deliberately has no real-cutover entry point. The future
//! `--cutover` tier and Ice-signed Gate 6 authorization belong to R15.

mod backup;
mod driver;
mod faults;
mod fence;
mod handles;
mod inventory;
mod state;

pub use backup::{DirectoryBackupManifest, load_valid_directory_backup};
pub use driver::{RehearsalConfig, RehearsalOutcome, run_rehearsal};
pub use faults::{FaultAction, FaultInjector, FaultPoint, NoFaults};
pub use fence::{
    REHEARSAL_TOKEN_RELATIVE_PATH, ValidatedRehearsalRoot, validate_rehearsal_root,
    write_rehearsal_token_for_harness,
};
pub use inventory::{Inventory, InventoryEntry, load_inventory};
pub use state::{RehearsalState, StableState, StateRecord, load_state};

use std::path::PathBuf;

#[derive(Debug, thiserror::Error)]
pub enum RehearsalError {
    #[error("rehearsal fence refused the workspace root")]
    Fence(#[from] fence::FenceError),
    #[error("rehearsal state is unreadable or inconsistent")]
    State,
    #[error("rehearsal filesystem operation failed: {code}")]
    Io { code: &'static str },
    #[error("rehearsal storage operation failed")]
    Storage(#[from] dohc_engine_storage::StorageError),
    #[error("rehearsal file hashing failed")]
    Files(#[from] dohc_engine_files::FilesError),
}

impl RehearsalError {
    fn io(code: &'static str, _source: std::io::Error) -> Self {
        Self::Io { code }
    }
}

#[derive(Debug, Clone)]
struct Paths {
    root: PathBuf,
    engine: PathBuf,
    db: PathBuf,
}

impl Paths {
    fn new(root: PathBuf) -> Self {
        let engine = root.join(".dohc").join("engine");
        let db = engine.join("engine.db");
        Self { root, engine, db }
    }
}

#[cfg(test)]
mod tests;
