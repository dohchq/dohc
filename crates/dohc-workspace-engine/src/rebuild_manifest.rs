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
    /// What the rebuild does to the files on disk, from `planned` on.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan: Option<RebuildPlan>,
    /// Whether `.dohc/local/share-refresh` existed when the swap began, from
    /// `swapping` on.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub share_refresh_existed: Option<bool>,
}

/// The plan for converging the files on disk to the new store.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RebuildPlan {
    /// The reach the new store was built under, as main stores it.
    pub reach: serde_json::Value,
    /// The recovery folder, relative to the root with `/` separators, when
    /// the plan saves anything.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recovery_folder: Option<String>,
    #[serde(default)]
    pub recovery: Vec<RecoveryItem>,
    /// The member's deletes and moves the relay never took, which the
    /// converge undoes.
    #[serde(default)]
    pub undone: Vec<UndoneChange>,
    /// The live draft records the recovery folder holds, which main deletes
    /// once the rebuild finishes.
    #[serde(default)]
    pub saved_drafts: Vec<String>,
    #[serde(default)]
    pub jobs: Vec<PlannedJob>,
    /// The last converge wave that finished, 0 before the first.
    #[serde(default)]
    pub waves_done: u8,
}

/// Where a recovery item comes from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RecoverySource {
    /// The file at `path` on disk, moved in the first converge wave.
    #[default]
    Disk,
    /// A copy `closed` wrote under the staging folder, moved in `planned`.
    Saved,
    /// The old store's `displaced` folder, moved whole in `planned`.
    Displaced,
}

/// A delete or move of the member's the converge undoes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UndoneChange {
    /// The path the file is back at.
    pub path: String,
    /// Where the member had moved it, or `None` for a delete.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub moved_to: Option<String>,
}

/// An item the plan saves in the recovery folder.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryItem {
    pub number: u32,
    #[serde(default)]
    pub source: RecoverySource,
    /// What it was: a path relative to the root, or what the copy holds.
    pub path: String,
    /// Its name in the recovery folder, `<number> <name>`.
    pub destination: String,
    pub reason: String,
    #[serde(default)]
    pub done: bool,
    /// Set once done: whether there was a file to move.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub found: Option<bool>,
}

/// A materialization job a converge wave adds.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlannedJob {
    /// 1 for deletes, 3 for writes.
    pub wave: u8,
    pub path: String,
    #[serde(default)]
    pub delete: bool,
    pub content_sha256: String,
    /// The bytes the file must hold for the job to replace them, `None` when
    /// there must be no file.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preimage: Option<String>,
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
            plan: None,
            share_refresh_existed: None,
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
        let held: Vec<_> = [Closed, Planned, Swapping, Swapped, Converged]
            .into_iter()
            .filter(|phase| phase.holds_old_store())
            .collect();
        assert_eq!(held, [Closed, Planned, Swapping]);
    }
}
