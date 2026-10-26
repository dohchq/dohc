//! The private folders where a configured host copies earlier stores for
//! their owners' recovery copies: `<root>/.recovery/<daemon>/<copy>`, under
//! the store root the host's operator configured, outside every workspace
//! store. Each daemon holds `<root>/.recovery/<daemon>.lock` while it runs,
//! so the next start can tell an abandoned folder from a running daemon's.

use dohc_engine_protocol::error::{ErrorCode, WireError};
use serde::Deserialize;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

/// The folder under the store root that holds every daemon's copies.
const COPIES: &str = ".recovery";

/// The longest a host may let one preparation take.
pub(super) const MAX_PREPARATION_DEADLINE: Duration = Duration::from_secs(300);

/// Trusted host configuration for recovery copies.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RecoveryConfig {
    /// The host's store root.
    root: PathBuf,
    /// How long preparing one earlier store may take, at most the longest
    /// request a host may make.
    preparation_deadline_ms: u64,
}

/// This daemon's copy folders.
pub(crate) struct RecoveryCopies {
    /// `<root>/.recovery`. No workspace root may contain it or sit in it.
    base: PathBuf,
    daemon: PathBuf,
    lock: PathBuf,
    /// Locked while this daemon runs.
    held: Mutex<Option<std::fs::File>>,
    pub(super) deadline: Duration,
    /// Copy folders whose removal failed, tried again before each copy and
    /// at shutdown.
    unremoved: Mutex<Vec<PathBuf>>,
}

fn unavailable(error: impl std::fmt::Display) -> WireError {
    WireError::new(
        ErrorCode::InvalidParams,
        format!("recovery copy folder unavailable: {error}"),
    )
}

/// A random lowercase hex name.
fn nonce() -> std::io::Result<String> {
    let mut bytes = [0_u8; 16];
    getrandom::fill(&mut bytes).map_err(std::io::Error::other)?;
    Ok(dohc_engine_storage::hex(&bytes))
}

/// Create the new folder `name` in `parent`, private to this user. An
/// existing one, a link included, is refused.
fn create_private(parent: &Path, name: &str) -> std::io::Result<PathBuf> {
    let folder = parent.join(name);
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut std::fs::DirBuilder::new(), 0o700)
        .create(&folder)?;
    #[cfg(not(unix))]
    std::fs::create_dir(&folder)?;
    let made = std::fs::symlink_metadata(&folder)?;
    if !made.is_dir() || made.file_type().is_symlink() {
        return Err(std::io::ErrorKind::AlreadyExists.into());
    }
    Ok(folder)
}

impl RecoveryCopies {
    /// Make `<root>/.recovery` private, remove the folders of daemons that
    /// are gone, and make this daemon's.
    pub(crate) fn start(config: RecoveryConfig) -> Result<Self, WireError> {
        let deadline = Duration::from_millis(config.preparation_deadline_ms);
        if config.preparation_deadline_ms == 0 || deadline > MAX_PREPARATION_DEADLINE {
            return Err(WireError::new(
                ErrorCode::InvalidParams,
                "invalid recovery preparation deadline",
            ));
        }
        if !config.root.is_absolute() {
            return Err(unavailable("root must be absolute"));
        }
        let root = std::fs::canonicalize(&config.root).map_err(unavailable)?;
        if root.to_str().is_none() || !root.is_dir() {
            return Err(unavailable("root must be a UTF-8 folder"));
        }
        crate::root_binding::ensure_private_folder(&root, COPIES).map_err(unavailable)?;
        let base = root.join(COPIES);
        remove_abandoned(&base);
        let name = nonce().map_err(unavailable)?;
        let lock = base.join(format!("{name}.lock"));
        let held = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&lock)
            .map_err(unavailable)?;
        fs4::FileExt::try_lock(&held).map_err(|_| unavailable("lock refused"))?;
        // The lock comes first, so no folder is ever without its owner's lock.
        let daemon = create_private(&base, &name).map_err(unavailable)?;
        Ok(Self {
            base,
            daemon,
            lock,
            held: Mutex::new(Some(held)),
            deadline,
            unremoved: Mutex::default(),
        })
    }

    /// Whether `root` contains the copies, or sits in them.
    pub(super) fn overlaps(&self, root: &Path) -> bool {
        self.base.starts_with(root) || root.starts_with(&self.base)
    }

    /// A new, empty, private folder for one copy.
    pub(super) fn folder(&self) -> std::io::Result<PathBuf> {
        self.retry_removals();
        create_private(&self.daemon, &nonce()?)
    }

    /// Remove a copy folder whose store closed, and everything in it. One
    /// that cannot go yet is tried again later.
    pub(super) fn remove(&self, folder: PathBuf) {
        if let Err(error) = remove(&folder) {
            eprintln!(
                "engine: recovery copy {} stays until it can be removed: {error}",
                folder.display()
            );
            crate::lock(&self.unremoved).push(folder);
        }
    }

    fn retry_removals(&self) {
        crate::lock(&self.unremoved).retain(|folder| remove(folder).is_err());
    }

    /// Remove this daemon's folder once every copy in it closed.
    pub(super) fn shutdown(&self) {
        self.retry_removals();
        if remove(&self.daemon).is_ok() {
            drop(crate::lock(&self.held).take());
            let _ = std::fs::remove_file(&self.lock);
        }
    }

    #[cfg(test)]
    pub(super) fn daemon(&self) -> &Path {
        &self.daemon
    }
}

fn remove(folder: &Path) -> std::io::Result<()> {
    match std::fs::remove_dir_all(folder) {
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(error),
        _ => Ok(()),
    }
}

/// Remove each daemon folder in `base` whose daemon is gone: its lock file is
/// missing, or this process can lock it. A running daemon holds its lock.
fn remove_abandoned(base: &Path) {
    let Ok(entries) = std::fs::read_dir(base) else {
        return;
    };
    for entry in entries.flatten() {
        let folder = entry.path();
        let Some(name) = folder.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if !entry.file_type().is_ok_and(|kind| kind.is_dir()) || name.contains('.') {
            continue;
        }
        let lock = base.join(format!("{name}.lock"));
        let held = match std::fs::OpenOptions::new().write(true).open(&lock) {
            Ok(file) => match fs4::FileExt::try_lock(&file) {
                Ok(()) => Some(file),
                Err(_) => continue,
            },
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(_) => continue,
        };
        if remove(&folder).is_ok() {
            drop(held);
            let _ = std::fs::remove_file(&lock);
        }
    }
}
