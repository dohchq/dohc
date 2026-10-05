//! Off-writer inspection of staged POSIX originals.
//! Changed bytes must be durably imported before the quiet clock restarts.
use super::materialize::{
    MAX_MATERIALIZE_BYTES, MaterializeError, ensure_target_symlink_free, open_displaced,
};
use dohc_engine_storage::{DisplacementSpec, EngineStore, RetainedDisplacement, hex_sha256};
use std::io::Read;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
pub const QUIET_PERIOD_MS: i64 = 30_000;
type Stamp = (String, String, i64, String, String);
fn stamp(metadata: &std::fs::Metadata) -> Stamp {
    (
        metadata.dev().to_string(),
        metadata.ino().to_string(),
        metadata.len().min(i64::MAX as u64) as i64,
        format!("{}:{}", metadata.mtime(), metadata.mtime_nsec()),
        format!("{}:{}", metadata.ctime(), metadata.ctime_nsec()),
    )
}
pub(super) fn retain_known(
    store: &EngineStore,
    root: &Path,
    path: &Path,
    file: &std::fs::File,
    digest: &str,
    spec: &DisplacementSpec,
    now_ms: i64,
) -> Result<(), MaterializeError> {
    let meta = file
        .metadata()
        .map_err(|e| MaterializeError::io(path, &e))?;
    let (device, inode, size, mtime, ctime) = stamp(&meta);
    let source_path = path
        .strip_prefix(root)
        .map_err(|_| MaterializeError::UnsafeTargetPath)?
        .to_string_lossy()
        .replace('\\', "/");
    let id = store.retain_displacement(&RetainedDisplacement {
        displacement_id: 0,
        job_id: spec.job_id.clone(),
        workspace_id: spec.workspace_id.clone(),
        target_path: spec.target_path.clone(),
        source_path,
        device,
        inode,
        digest: digest.to_owned(),
        size,
        mtime,
        ctime,
        changed_at_ms: now_ms,
    })?;
    if meta.nlink() > 1 {
        // Unlinking this staged name leaves the other hard link reachable.
        std::fs::remove_file(path).map_err(|e| MaterializeError::io(path, &e))?;
        store.release_retained(id)?;
    }
    Ok(())
}

pub enum Inspection {
    Missing,
    Keep,
    /// Keep the complete source through the kept-copy API; do not read a prefix.
    Oversized,
    Changed {
        current: RetainedDisplacement,
        bytes: Vec<u8>,
    },
    Release(Release),
}
/// Owns the descriptor until the last identity check and unlink.
pub struct Release {
    path: PathBuf,
    file: std::fs::File,
    stamp: Stamp,
}
impl Release {
    pub fn remove(self) -> Result<bool, MaterializeError> {
        let current = match std::fs::symlink_metadata(&self.path) {
            Ok(m) => m,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(true),
            Err(e) => return Err(MaterializeError::io(&self.path, &e)),
        };
        if stamp(&current) != self.stamp
            || stamp(
                &self
                    .file
                    .metadata()
                    .map_err(|e| MaterializeError::io(&self.path, &e))?,
            ) != self.stamp
        {
            return Ok(false);
        }
        std::fs::remove_file(&self.path).map_err(|e| MaterializeError::io(&self.path, &e))?;
        Ok(true)
    }
}

pub fn inspect(
    root: &Path,
    row: &RetainedDisplacement,
    now_ms: i64,
) -> Result<Inspection, MaterializeError> {
    let rel = Path::new(&row.source_path);
    if rel.is_absolute()
        || rel
            .components()
            .any(|c| !matches!(c, std::path::Component::Normal(_)))
    {
        return Err(MaterializeError::UnsafeTargetPath);
    }
    let root = std::fs::canonicalize(root).map_err(|e| MaterializeError::io(root, &e))?;
    let path = root.join(rel);
    ensure_target_symlink_free(&root, &path)?;
    let file = match open_displaced(&path) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Inspection::Missing),
        Err(e) => return Err(MaterializeError::io(&path, &e)),
    };
    let meta = file
        .metadata()
        .map_err(|e| MaterializeError::io(&path, &e))?;
    let initial = stamp(&meta);
    let (device, inode, size, mtime, ctime) = initial.clone();
    if !meta.is_file() {
        return Err(MaterializeError::BlockedTarget);
    }
    // The descriptor was reopened by path. Device numbers can change on remount;
    // compare content instead of treating the old identity as an eternal fence.
    let identity_changed = device != row.device || inode != row.inode;
    if !identity_changed && meta.nlink() > 1 {
        return Ok(Inspection::Release(Release {
            path,
            file,
            stamp: initial,
        }));
    }
    let quiet = now_ms.saturating_sub(row.changed_at_ms) >= QUIET_PERIOD_MS;
    let changed = (size, mtime.as_str(), ctime.as_str())
        != (row.size, row.mtime.as_str(), row.ctime.as_str());
    if !identity_changed && !quiet && !changed {
        return Ok(Inspection::Keep);
    }
    if meta.len() > MAX_MATERIALIZE_BYTES as u64 {
        return Ok(Inspection::Oversized);
    }
    #[cfg(target_os = "linux")]
    let lease_checked = !identity_changed && !changed;
    #[cfg(target_os = "linux")]
    if lease_checked && writer_present(&file, &path)? {
        return Ok(Inspection::Keep);
    }
    let mut bytes = Vec::new();
    (&file)
        .take(MAX_MATERIALIZE_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| MaterializeError::io(&path, &e))?;
    if bytes.len() > MAX_MATERIALIZE_BYTES {
        return Ok(Inspection::Oversized);
    }
    let digest = hex_sha256(&bytes);
    // Even an unstable read is kept. Its new clock forces another comparison.
    if digest != row.digest
        || (!identity_changed && changed)
        || stamp(
            &file
                .metadata()
                .map_err(|e| MaterializeError::io(&path, &e))?,
        ) != initial
    {
        let mut current = row.clone();
        current.device = device;
        current.inode = inode;
        current.digest = digest;
        current.size = size;
        current.mtime = mtime;
        current.ctime = ctime;
        return Ok(Inspection::Changed { current, bytes });
    }
    if identity_changed && !quiet {
        return Ok(Inspection::Keep);
    }
    #[cfg(target_os = "linux")]
    if !lease_checked && writer_present(&file, &path)? {
        return Ok(Inspection::Keep);
    }
    Ok(Inspection::Release(Release {
        path,
        file,
        stamp: initial,
    }))
}

#[cfg(target_os = "linux")]
fn writer_present(file: &std::fs::File, path: &Path) -> Result<bool, MaterializeError> {
    Ok(
        dohc_linux_files::probe(file).map_err(|e| MaterializeError::io(path, &e))?
            == dohc_linux_files::LeaseProbe::WriterPresent,
    )
}
