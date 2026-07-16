//! Canonical physical `engine.db` identity, keyed on **OS file identity**.
//!
//! The workspace actor is keyed by true file identity — POSIX `(st_dev,
//! st_ino)`, Windows `(volume serial, file index)` — **not** by a lexical or
//! canonicalized path string (`plan §Workspace actor model`). This is the
//! correct enforcement of the rewrite's core invariant (one writer per
//! physical database): a path-based key silently forks a second writer for
//! filename-case aliases (`engine.db` vs `ENGINE.DB` on case-insensitive
//! volumes), file symlinks, and hard links — each of which addresses the *same*
//! bytes. File identity collapses all of them onto one key.
//!
//! Identity is obtained via a metadata-only probe (a short-lived read handle
//! closed immediately — it does NOT open a second writer connection). The
//! `file-id` crate performs the platform-specific call behind a safe API, so
//! these crates keep `#![forbid(unsafe_code)]`.

use crate::error::RuntimeError;
use file_id::FileId;
use std::path::Path;

/// A canonical `engine.db` identity. Two paths that address the same physical
/// database — via case-alias, symlink, junction, or hard link — produce equal
/// identities.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct EngineDbIdentity(FileId);

impl EngineDbIdentity {
    /// Resolve the identity of an **existing** file. Returns
    /// [`RuntimeError::Identity`] if it cannot be probed (e.g. missing).
    pub fn of_existing(path: &Path) -> Result<Self, RuntimeError> {
        let id = file_id::get_file_id(path).map_err(|err| RuntimeError::Identity {
            reason: "could not read file identity",
            source: Some(err),
        })?;
        Ok(EngineDbIdentity(id))
    }

    /// Resolve the identity of `path`, creating an empty file first if it does
    /// not yet exist so a brand-new database still gets a stable identity.
    ///
    /// The caller must hold the registry lock across this call: the
    /// create-then-probe is the point where two concurrent opens of the same
    /// new path must not both win.
    pub(crate) fn resolve_or_create(path: &Path) -> Result<Self, RuntimeError> {
        if !path.exists() {
            // Create an empty file (no truncation if a race beat us to it).
            std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .create(true)
                .truncate(false)
                .open(path)
                .map_err(|err| RuntimeError::Identity {
                    reason: "could not create engine.db for identity resolution",
                    source: Some(err),
                })?;
        }
        Self::of_existing(path)
    }

    /// Resolve the identity of `path` only if it already exists (never
    /// creates). Used by close/status lookups so a stray path cannot
    /// materialize a database.
    pub(crate) fn resolve_existing_opt(path: &Path) -> Result<Option<Self>, RuntimeError> {
        if !path.exists() {
            return Ok(None);
        }
        Self::of_existing(path).map(Some)
    }
}
