//! Filesystem fixtures: the self-cleaning scratch workspace, the engine-db
//! location under it, and cross-platform directory-alias helpers (symlink on
//! POSIX, junction/symlink on Windows) used to prove canonical-identity
//! convergence.

use std::io;
use std::path::{Path, PathBuf};

pub use dohc_test_scratch::ScratchDir;

/// The canonical engine-db location under a workspace root
/// (`.dohc/engine/engine.db`). The parent directories are created so the
/// path is ready for [`dohc_engine_storage::EngineStore::open`] and for
/// identity resolution.
pub fn engine_db_path(root: &Path) -> io::Result<PathBuf> {
    let engine_dir = root.join(".dohc").join("engine");
    std::fs::create_dir_all(&engine_dir)?;
    Ok(engine_dir.join("engine.db"))
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
            nonce.chars().all(|c| c.is_ascii_hexdigit()),
            "nonce must be hex, got {nonce}"
        );
        nonce.to_string()
    }

    /// The nonce is 4 hex digits so a socket path in a scratch directory stays
    /// under macOS's 104 bytes. It only keeps retries rare: `create_dir`
    /// refuses a name that already exists, such as one a stale process with
    /// the same pid left, and the next attempt takes a new sequence and nonce.
    #[test]
    fn scratch_names_carry_a_short_nonce_and_never_repeat() {
        let first = ScratchDir::new().unwrap();
        let second = ScratchDir::new().unwrap();

        assert_eq!(nonce_of(&first).len(), 4, "nonce must be 4 hex digits");
        assert_eq!(nonce_of(&second).len(), 4, "nonce must be 4 hex digits");
        assert_ne!(
            first.path().file_name(),
            second.path().file_name(),
            "two allocations never share a name"
        );
    }
}
