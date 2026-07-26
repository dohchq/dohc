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
#[cfg(any(test, feature = "harness"))]
pub use fence::write_rehearsal_token_for_harness;
pub use fence::{
    FenceError, REHEARSAL_TOKEN_RELATIVE_PATH, ValidatedRehearsalRoot, validate_rehearsal_root,
};
pub use inventory::{Inventory, InventoryEntry, load_inventory};
pub use state::{BackupFingerprint, RehearsalState, StableState, StateRecord, load_state};

use rusqlite::{Connection, OpenFlags};
use std::path::{Path, PathBuf};

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

/// The per-root advisory lock file. Held exclusively for a whole rehearsal
/// invocation, so every traversal must SKIP it — reading a locked range fails
/// on Windows, and its bytes are never part of the workspace.
pub(crate) const ROOT_LOCK_FILE: &str = "CUTOVER_REHEARSAL_LOCK";

/// Make a just-published rename durable by syncing its directory. Windows std
/// cannot open directory handles; NTFS metadata durability is accepted there.
pub(crate) fn fsync_dir(dir: &std::path::Path) -> Result<(), RehearsalError> {
    #[cfg(unix)]
    {
        let handle =
            std::fs::File::open(dir).map_err(|e| RehearsalError::io("dir-sync-open", e))?;
        handle
            .sync_all()
            .map_err(|e| RehearsalError::io("dir-sync", e))?;
    }
    #[cfg(not(unix))]
    let _ = dir;
    Ok(())
}

/// NOTE on the residual check-then-use window: these gates validate by
/// PATHNAME and callers then re-open/hash/rename by pathname, so a concurrent
/// replacement between check and use remains possible. That residue is
/// bounded by the per-root `CUTOVER_REHEARSAL_LOCK` (rehearsals are
/// serialized) and the shadow-rehearsal threat model (trusted local machine,
/// clone-marked fixture — an attacker racing writes INSIDE the fixture
/// mid-run is out of scope). The DB opens are additionally atomic via
/// `SQLITE_OPEN_NOFOLLOW`; full fd-based atomicity for every operation is
/// deferred to the real signed `--cutover` tier, where it matters.
///
/// The alias-safe file gate: `Ok(Some(metadata))` for a REAL regular file —
/// not a symlink, not a special file, and (Unix) not hard-linked — `Ok(None)`
/// when absent, `Err(code)` for an alias/special file or a metadata error.
/// Every attacker-influenceable file the rehearsal opens, hashes, copies, or
/// renames must pass through this BEFORE the operation.
pub(crate) fn require_real_file(
    path: &std::path::Path,
    code: &'static str,
) -> Result<Option<std::fs::Metadata>, RehearsalError> {
    match std::fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(RehearsalError::io(code, error)),
        Ok(metadata) => {
            if metadata.file_type().is_symlink()
                || !metadata.file_type().is_file()
                || metadata_is_hard_linked(&metadata)
            {
                Err(RehearsalError::Io { code })
            } else {
                Ok(Some(metadata))
            }
        }
    }
}

/// The alias-safe directory gate: `Ok(true)` for a REAL directory (never a
/// symlink/junction), `Ok(false)` when absent, `Err(code)` otherwise.
pub(crate) fn require_real_dir(
    path: &std::path::Path,
    code: &'static str,
) -> Result<bool, RehearsalError> {
    match std::fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(RehearsalError::io(code, error)),
        Ok(metadata) => {
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                Err(RehearsalError::Io { code })
            } else {
                Ok(true)
            }
        }
    }
}

/// Open a SQLite database read-only without letting `SQLITE_OPEN_NOFOLLOW`
/// reject an otherwise-safe path merely because an ANCESTOR is a symlink.
///
/// SQLite defines NOFOLLOW against the whole supplied pathname. Resolve only
/// the parent first, lstat-gate the untouched final component as a real file,
/// then retain NOFOLLOW on the canonical-parent path so a final-component
/// symlink swap is still rejected atomically by SQLite.
pub(crate) fn open_sqlite_read_only_nofollow(
    path: &Path,
    code: &'static str,
) -> Result<Connection, RehearsalError> {
    let parent = path
        .parent()
        .ok_or(RehearsalError::Io { code })
        .and_then(|parent| {
            std::fs::canonicalize(parent).map_err(|error| RehearsalError::io(code, error))
        })?;
    let file_name = path.file_name().ok_or(RehearsalError::Io { code })?;
    let canonical_path = parent.join(file_name);
    if require_real_file(&canonical_path, code)?.is_none() {
        return Err(RehearsalError::Io { code });
    }
    Connection::open_with_flags(
        canonical_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )
    .map_err(|_| RehearsalError::Io { code })
}

/// Flush a just-published file's CONTENTS (rename durability alone is not
/// enough when the writer never synced the bytes).
pub(crate) fn fsync_file(path: &std::path::Path, code: &'static str) -> Result<(), RehearsalError> {
    let file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .map_err(|e| RehearsalError::io(code, e))?;
    file.sync_all().map_err(|e| RehearsalError::io(code, e))?;
    Ok(())
}

/// Hard links alias content reachable outside the tree being walked. The link
/// count is only exposed by stable std on Unix; on Windows the file-identity
/// query needs Win32 calls that require `unsafe` (forbidden by this crate),
/// and failing closed would reject EVERY Windows file and break the shard —
/// so Windows hard links pass undetected: acceptable for a trusted local
/// fixture rehearsal, with real identity checks deferred to the `--cutover`
/// tier.
pub(crate) fn metadata_is_hard_linked(metadata: &std::fs::Metadata) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt as _;
        metadata.nlink() > 1
    }
    #[cfg(not(unix))]
    {
        let _ = metadata;
        false
    }
}

#[cfg(test)]
mod probe_tests;
#[cfg(test)]
mod tests;
