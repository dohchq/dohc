//! Shared test helpers: a self-cleaning scratch workspace and an independent
//! SHA-256 (a SECOND code path from the crate's streaming pooled hasher, so a
//! hash assertion is non-tautological), plus a best-effort symlink helper.
//!
//! Each integration test file is its own crate and uses a different subset of
//! these helpers, so unused-in-one-crate items are expected — allow dead code.
#![allow(dead_code)]

use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

static COUNTER: AtomicU64 = AtomicU64::new(0);

/// A unique temp directory, removed on `Drop`.
pub struct Scratch {
    path: PathBuf,
}

impl Scratch {
    pub fn new() -> Self {
        let unique = format!(
            "dohc-cal3-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        );
        let path = std::env::temp_dir().join(unique);
        std::fs::create_dir(&path).expect("create scratch dir");
        Scratch { path }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Write a file (creating parents), forward-slash relative path.
    pub fn write(&self, rel: &str, bytes: &[u8]) {
        let path = self
            .path
            .join(rel.replace('/', std::path::MAIN_SEPARATOR_STR));
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("create parents");
        }
        std::fs::write(&path, bytes).expect("write file");
    }

    /// Delete a file at a relative path.
    pub fn remove(&self, rel: &str) {
        let path = self
            .path
            .join(rel.replace('/', std::path::MAIN_SEPARATOR_STR));
        std::fs::remove_file(&path).expect("remove file");
    }

    /// Rename a file. Both paths are forward-slash relative.
    pub fn rename(&self, from: &str, to: &str) {
        let from = self
            .path
            .join(from.replace('/', std::path::MAIN_SEPARATOR_STR));
        let to = self
            .path
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
            .path
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
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
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
