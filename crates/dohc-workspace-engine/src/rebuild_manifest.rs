//! A joined workspace's rebuild manifest, `.dohc/local/rebuild.json`.
//!
//! When the relay changes what a member reaches, the member's copy is
//! rebuilt like a fresh join. The manifest is the single record of that
//! rebuild: its id and how far it got. From the moment it is written until
//! the new store is in place (`swapped`), the old store is never readable:
//! the engine refuses every request to the root except those that carry the
//! rebuild id and `workspace.close`, on every open and after any restart.
//! The store itself carries no mark.

use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::root_binding::LOCAL_STATE_RELATIVE_PATH;

const MANIFEST_NAME: &str = "rebuild.json";
const MANIFEST_TEMP_NAME: &str = "rebuild.json.tmp";

/// How far a rebuild got. Each phase is written, and flushed, before the step
/// that depends on it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RebuildPhase {
    Closed,
    Planned,
    Saved,
    Swapping,
    Swapped,
    Converged,
}

impl RebuildPhase {
    /// Before `swapped` the store on disk is the old one, which may hold
    /// History the relay now withholds.
    pub fn holds_old_store(self) -> bool {
        self < RebuildPhase::Swapped
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RebuildManifest {
    pub rebuild_id: String,
    pub phase: RebuildPhase,
    /// The share whose reach changed.
    pub share_id: String,
    /// The reach the relay served when the copy closed.
    pub revision: String,
    pub visibility_revision: String,
    pub closed_at_ms: i64,
}

#[derive(Debug, thiserror::Error)]
pub enum ManifestError {
    #[error("rebuild manifest unreadable: {0}")]
    Unreadable(String),
    #[error("rebuild manifest write failed: {0}")]
    Write(#[from] std::io::Error),
}

pub fn manifest_path(root: &Path) -> PathBuf {
    root.join(LOCAL_STATE_RELATIVE_PATH).join(MANIFEST_NAME)
}

/// The root's manifest, or `None` when no rebuild is under way. A manifest
/// that exists but can't be read is an error: the caller refuses the root,
/// because a rebuild may be under way.
pub fn read_manifest(root: &Path) -> Result<Option<RebuildManifest>, ManifestError> {
    let bytes = match std::fs::read(manifest_path(root)) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(ManifestError::Unreadable(error.to_string())),
    };
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|error| ManifestError::Unreadable(error.to_string()))
}

/// Replace the root's manifest and flush it before returning: the new bytes
/// go to a temporary file that is synced, then renamed over the manifest,
/// and on POSIX the folder is synced so the rename itself persists. Windows
/// exposes no folder sync; NTFS journals the rename.
pub fn write_manifest(root: &Path, manifest: &RebuildManifest) -> Result<(), ManifestError> {
    let folder = root.join(LOCAL_STATE_RELATIVE_PATH);
    let temp = folder.join(MANIFEST_TEMP_NAME);
    let bytes = serde_json::to_vec_pretty(manifest)
        .map_err(|error| ManifestError::Write(std::io::Error::other(error)))?;
    {
        let mut file = std::fs::File::create(&temp)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
    }
    std::fs::rename(&temp, manifest_path(root))?;
    sync_folder(&folder)?;
    Ok(())
}

#[cfg(unix)]
fn sync_folder(folder: &Path) -> std::io::Result<()> {
    std::fs::File::open(folder)?.sync_all()
}

#[cfg(not(unix))]
fn sync_folder(_folder: &Path) -> std::io::Result<()> {
    Ok(())
}

/// A rebuild id: random, so a restart never reuses one.
pub fn new_rebuild_id() -> Result<String, getrandom::Error> {
    let mut bytes = [0_u8; 16];
    getrandom::fill(&mut bytes)?;
    Ok(format!("rebuild_{}", dohc_engine_storage::hex(&bytes)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use dohc_engine_testkit::ScratchDir;

    fn manifest(phase: RebuildPhase) -> RebuildManifest {
        RebuildManifest {
            rebuild_id: "r1".to_owned(),
            phase,
            share_id: "share-1".to_owned(),
            revision: "rev-2".to_owned(),
            visibility_revision: "vis-2".to_owned(),
            closed_at_ms: 7,
        }
    }

    #[test]
    fn a_written_manifest_reads_back_and_a_missing_one_is_none() {
        let root = ScratchDir::new().expect("root");
        std::fs::create_dir_all(root.path().join(LOCAL_STATE_RELATIVE_PATH)).expect("local");
        assert!(read_manifest(root.path()).expect("read").is_none());
        write_manifest(root.path(), &manifest(RebuildPhase::Closed)).expect("write");
        write_manifest(root.path(), &manifest(RebuildPhase::Planned)).expect("rewrite");
        assert_eq!(
            read_manifest(root.path()).expect("read"),
            Some(manifest(RebuildPhase::Planned))
        );
        assert!(
            !root
                .path()
                .join(LOCAL_STATE_RELATIVE_PATH)
                .join(MANIFEST_TEMP_NAME)
                .exists()
        );
    }

    #[test]
    fn an_unreadable_manifest_is_an_error_not_an_absent_one() {
        let root = ScratchDir::new().expect("root");
        let folder = root.path().join(LOCAL_STATE_RELATIVE_PATH);
        std::fs::create_dir_all(&folder).expect("local");
        std::fs::write(folder.join(MANIFEST_NAME), b"{\"phase\":").expect("torn");
        assert!(matches!(
            read_manifest(root.path()),
            Err(ManifestError::Unreadable(_))
        ));
    }

    #[test]
    fn only_phases_before_swapped_hold_the_old_store() {
        use RebuildPhase::*;
        let held: Vec<_> = [Closed, Planned, Saved, Swapping, Swapped, Converged]
            .into_iter()
            .filter(|phase| phase.holds_old_store())
            .collect();
        assert_eq!(held, [Closed, Planned, Saved, Swapping]);
    }
}
