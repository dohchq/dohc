//! Canonical physical `engine.db` identity.
//!
//! The workspace actor is keyed by canonical file identity, **not** by lexical
//! path, workspace id, or session handle (`plan §Workspace actor model`).
//! Aliases — redundant path components, relative vs absolute forms, symlinks,
//! and Windows directory junctions / 8.3 short names — must converge on one
//! identity so they resolve to one actor and one writer connection.
//!
//! Resolution canonicalizes the deepest existing ancestor (the parent
//! directory) and rejoins the file name, mirroring the TS engine's
//! `canonicalEngineDbPath` (`versionedTextStore.ts:483-497`). `std::fs::
//! canonicalize` resolves symlinks/junctions and expands 8.3 short names (the
//! win32 finding in `LANGUAGE_SEMANTICS_MATRIX.md` §7.12), but on Windows it
//! returns a `\\?\`-prefixed path — stripped here before comparison so the
//! identity string matches Node-shaped identities (matrix §7.4).

use crate::error::RuntimeError;
use std::path::{Path, PathBuf};

/// A canonical `engine.db` identity. Two paths that address the same physical
/// database produce equal identities.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct EngineDbIdentity(String);

impl EngineDbIdentity {
    /// Resolve `db_path` to a canonical identity. The parent directory must
    /// already exist (the supervisor creates it before calling this).
    pub fn resolve(db_path: &Path) -> Result<Self, RuntimeError> {
        let parent = db_path.parent().ok_or(RuntimeError::Identity {
            reason: "engine.db path has no parent directory",
            source: None,
        })?;
        let file_name = db_path.file_name().ok_or(RuntimeError::Identity {
            reason: "engine.db path has no file name",
            source: None,
        })?;

        let canonical_parent =
            std::fs::canonicalize(parent).map_err(|err| RuntimeError::Identity {
                reason: "parent directory is not canonicalizable",
                source: Some(err),
            })?;

        let normalized_parent = strip_windows_verbatim_prefix(&canonical_parent);
        let full = normalized_parent.join(file_name);
        Ok(EngineDbIdentity(full.to_string_lossy().into_owned()))
    }

    /// The canonical identity string (stable, comparable).
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Strip the Windows `\\?\` verbatim prefix (`\\?\C:\…` → `C:\…`,
/// `\\?\UNC\srv\share` → `\\srv\share`) so identities match Node's
/// `realpathSync.native` shape (matrix §7.4). A no-op on non-Windows paths and
/// on already-plain paths.
fn strip_windows_verbatim_prefix(path: &Path) -> PathBuf {
    let text = path.to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    if let Some(rest) = text.strip_prefix(r"\\?\") {
        return PathBuf::from(rest);
    }
    path.to_path_buf()
}
