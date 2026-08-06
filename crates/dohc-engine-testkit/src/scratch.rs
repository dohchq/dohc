//! Filesystem fixtures: a self-cleaning scratch workspace and a cross-platform
//! directory-alias helper (symlink on POSIX, junction/symlink on Windows) used
//! to prove canonical-identity convergence.

use std::io;
use std::path::{Path, PathBuf};

/// A unique temporary directory, removed on `Drop`. It lives under the shared
/// run tree in the OS temp directory.
pub struct ScratchDir {
    inner: dohc_test_scratch::ScratchDir,
}

impl ScratchDir {
    /// Create a fresh unique scratch directory.
    pub fn new() -> io::Result<Self> {
        Ok(Self {
            inner: dohc_test_scratch::ScratchDir::new_named("cal1")?,
        })
    }

    /// The root of the scratch directory.
    pub fn path(&self) -> &Path {
        self.inner.path()
    }

    /// The canonical engine-db location under this workspace
    /// (`.dohc/engine/engine.db`). The parent directories are created so the
    /// path is ready for [`dohc_engine_storage::EngineStore::open`] and for
    /// identity resolution.
    pub fn engine_db_path(&self) -> io::Result<PathBuf> {
        let engine_dir = self.inner.join(".dohc").join("engine");
        std::fs::create_dir_all(&engine_dir)?;
        Ok(engine_dir.join("engine.db"))
    }

    /// A sub-path under the scratch root (not created).
    pub fn join(&self, rel: impl AsRef<Path>) -> PathBuf {
        self.inner.join(rel)
    }
}

/// Attempt to create a directory alias `link` pointing at `target`.
///
/// Returns `Ok(true)` if the alias was created, `Ok(false)` if the platform
/// refused it (e.g. Windows without symlink privilege and `mklink /J`
/// unavailable) so the caller can skip the alias assertion honestly rather
/// than fail. `Err` is reserved for genuine I/O errors.
pub fn try_make_dir_alias(target: &Path, link: &Path) -> io::Result<bool> {
    #[cfg(unix)]
    {
        match std::os::unix::fs::symlink(target, link) {
            Ok(()) => Ok(true),
            Err(err) if err.kind() == io::ErrorKind::PermissionDenied => Ok(false),
            Err(err) => Err(err),
        }
    }
    #[cfg(windows)]
    {
        // Prefer a real directory symlink (needs Developer Mode / privilege).
        match std::os::windows::fs::symlink_dir(target, link) {
            Ok(()) => return Ok(true),
            Err(err)
                if err.kind() == io::ErrorKind::PermissionDenied
                    || err.raw_os_error() == Some(1314) => {}
            Err(err) => return Err(err),
        }
        // Fall back to an NTFS junction, which needs no privilege.
        let status = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()?;
        Ok(status.success())
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = (target, link);
        Ok(false)
    }
}

/// Attempt to create a **file** symlink `link` → `target`.
///
/// Returns `Ok(true)` if created, `Ok(false)` if the platform refused it
/// (Windows without symlink privilege). File symlinks address the same bytes,
/// so opening through one must converge on the target's file identity.
pub fn try_make_file_symlink(target: &Path, link: &Path) -> io::Result<bool> {
    #[cfg(unix)]
    {
        match std::os::unix::fs::symlink(target, link) {
            Ok(()) => Ok(true),
            Err(err) if err.kind() == io::ErrorKind::PermissionDenied => Ok(false),
            Err(err) => Err(err),
        }
    }
    #[cfg(windows)]
    {
        match std::os::windows::fs::symlink_file(target, link) {
            Ok(()) => Ok(true),
            Err(err)
                if err.kind() == io::ErrorKind::PermissionDenied
                    || err.raw_os_error() == Some(1314) =>
            {
                Ok(false)
            }
            Err(err) => Err(err),
        }
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = (target, link);
        Ok(false)
    }
}

/// Create a hard link `link` → `target` (same inode / file index, so the same
/// file identity). Hard links are unprivileged on all supported platforms.
pub fn make_hardlink(target: &Path, link: &Path) -> io::Result<()> {
    std::fs::hard_link(target, link)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn nonce_of(dir: &ScratchDir) -> String {
        let name = dir.path().file_name().unwrap().to_str().unwrap();
        let (_, nonce) = name.rsplit_once('-').expect("name carries a nonce segment");
        assert!(
            u64::from_str_radix(nonce, 16).is_ok(),
            "nonce must be hex, got {nonce}"
        );
        nonce.to_string()
    }

    #[test]
    fn scratch_names_carry_a_per_allocation_nonce() {
        let first = ScratchDir::new().unwrap();
        let second = ScratchDir::new().unwrap();

        // MUTATION: drop the nonce and the trailing segment is the counter,
        // which is not 16 hex digits — the width assertion is what bites.
        assert_eq!(
            nonce_of(&first).len(),
            16,
            "nonce must be a full u64 in hex"
        );
        assert_ne!(
            nonce_of(&first),
            nonce_of(&second),
            "each allocation draws fresh entropy, so a stale same-pid directory cannot collide"
        );
    }
}
