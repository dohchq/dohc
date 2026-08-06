//! Shared test helpers: a self-cleaning scratch workspace and an independent
//! SHA-256 (a SECOND code path from the crate's streaming pooled hasher, so a
//! hash assertion is non-tautological), plus a best-effort symlink helper.
//!
//! Each integration test file is its own crate and uses a different subset of
//! these helpers, so unused items are expected in any one crate.
#![allow(dead_code)]

use dohc_test_scratch::ScratchDir;
use sha2::{Digest, Sha256};
use std::path::Path;

/// A unique temp directory, removed on `Drop`.
pub struct Scratch {
    inner: ScratchDir,
}

impl Scratch {
    pub fn new() -> Self {
        Scratch {
            inner: ScratchDir::new_named("cal3").expect("create scratch dir"),
        }
    }

    pub fn path(&self) -> &Path {
        self.inner.path()
    }

    /// Write a file (creating parents), forward-slash relative path.
    pub fn write(&self, rel: &str, bytes: &[u8]) {
        let path = self
            .inner
            .join(rel.replace('/', std::path::MAIN_SEPARATOR_STR));
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("create parents");
        }
        std::fs::write(&path, bytes).expect("write file");
    }

    /// Delete a file at a relative path.
    pub fn remove(&self, rel: &str) {
        let path = self
            .inner
            .join(rel.replace('/', std::path::MAIN_SEPARATOR_STR));
        std::fs::remove_file(&path).expect("remove file");
    }

    /// Rename a file. Both paths are forward-slash relative.
    pub fn rename(&self, from: &str, to: &str) {
        let from = self
            .inner
            .join(from.replace('/', std::path::MAIN_SEPARATOR_STR));
        let to = self
            .inner
            .join(to.replace('/', std::path::MAIN_SEPARATOR_STR));
        if let Some(parent) = to.parent() {
            std::fs::create_dir_all(parent).expect("create parents");
        }
        std::fs::rename(&from, &to).expect("rename file");
    }

    /// Best-effort file symlink; returns whether it was created (Windows without
    /// Developer Mode refuses, and the caller skips the symlink-specific
    /// expectation honestly).
    pub fn try_symlink(&self, rel: &str, target: &str) -> bool {
        let link = self
            .inner
            .join(rel.replace('/', std::path::MAIN_SEPARATOR_STR));
        if let Some(parent) = link.parent() {
            std::fs::create_dir_all(parent).expect("create parents");
        }
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(target, &link).is_ok()
        }
        #[cfg(windows)]
        {
            std::os::windows::fs::symlink_file(target, &link).is_ok()
        }
        #[cfg(not(any(unix, windows)))]
        {
            let _ = target;
            false
        }
    }

    /// Best-effort DIRECTORY symlink `rel` → absolute `target`; returns whether
    /// created (for symlink-cycle tests; skipped gracefully if unavailable).
    pub fn try_symlink_dir(&self, rel: &str, target: &Path) -> bool {
        let link = self
            .inner
            .join(rel.replace('/', std::path::MAIN_SEPARATOR_STR));
        if let Some(parent) = link.parent() {
            std::fs::create_dir_all(parent).expect("create parents");
        }
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(target, &link).is_ok()
        }
        #[cfg(windows)]
        {
            std::os::windows::fs::symlink_dir(target, &link).is_ok()
        }
        #[cfg(not(any(unix, windows)))]
        {
            let _ = target;
            false
        }
    }
}

/// Independent lowercase-hex SHA-256 for expected values in tests.
pub fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut hex = String::with_capacity(digest.len() * 2);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(hex, "{byte:02x}");
    }
    hex
}
