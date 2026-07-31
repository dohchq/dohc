//! The on-disk byte scan behind one security property: **a secret file's
//! plaintext never reaches the engine database.**
//!
//! Secrets are sealed before they are persisted, so the plaintext exists only
//! in memory and on the projected file. Nothing enforces that by construction —
//! any write site that stores the plaintext instead of the sealed ciphertext
//! would leak it into `engine.db`, its `-wal`, or its `-shm`. The only proof is
//! to read those files as bytes and look.
//!
//! Two rules make the scan a proof instead of a ritual:
//!
//! 1. **A scan that read nothing passes every absence assertion.** [`EngineDbScan::read`]
//!    fails when the main database is missing or empty, and every absence
//!    assertion must be paired with a positive control —
//!    [`EngineDbScan::assert_stored_ciphertext_scanned`] proves the scanned bytes
//!    hold the store's real data.
//! 2. **Closing the last connection destroys the evidence.** SQLite checkpoints
//!    the WAL into the main file on that close and normally deletes the WAL, so
//!    plaintext that reached a WAL page and was later overwritten leaves no trace
//!    and "never reaches disk" passes over erased bytes. Hold a
//!    [`crate::harness::open_readonly_keeper`] across the writer's close and
//!    assert with [`EngineDbScan::assert_scanned_wal`] that the WAL really was
//!    among the bytes read.
//! 3. **Ciphertext is stored as base64 `TEXT`.** A scan for the raw plaintext
//!    bytes alone would miss a plaintext that was base64-encoded on the way in,
//!    so [`EngineDbScan::assert_secret_plaintext_absent`] looks for both forms.

use crate::harness::{shm_sidecar, wal_sidecar};
use dohc_engine_crypto::base64::encode_standard;
use rusqlite::Connection;
use std::path::{Path, PathBuf};

/// Does `haystack` hold `needle` anywhere? The one implementation of that
/// question for every plaintext-leak scan, over file bytes or an in-memory blob.
///
/// An empty needle is never "found": it would match everything and turn an
/// absence assertion into a coin flip.
#[must_use]
pub fn bytes_contain(haystack: &[u8], needle: &[u8]) -> bool {
    if needle.is_empty() || haystack.len() < needle.len() {
        return false;
    }
    haystack
        .windows(needle.len())
        .any(|window| window == needle)
}

/// Every on-disk byte of an engine database: the main file plus its `-wal` and
/// `-shm` sidecars, each kept separately so a hit names the file it came from.
#[derive(Debug)]
pub struct EngineDbScan {
    files: Vec<(PathBuf, Vec<u8>)>,
}

impl EngineDbScan {
    /// Read `db_path` and its sidecars.
    ///
    /// Do NOT drop every connection first for a "never reaches disk" property:
    /// that close checkpoints the WAL into the main file and normally deletes the
    /// WAL, so an overwritten plaintext page is gone before this reads it. Hold a
    /// [`crate::harness::open_readonly_keeper`] across the writer's close and
    /// pair the scan with [`Self::assert_scanned_wal`].
    ///
    /// # Panics
    ///
    /// When the main database file cannot be read, or holds no bytes. Absence
    /// holds for every needle over zero bytes, so a scan that read nothing
    /// would pass while proving nothing.
    #[must_use]
    pub fn read(db_path: &Path) -> Self {
        let main = std::fs::read(db_path).unwrap_or_else(|error| {
            panic!(
                "engine database {} must be readable to scan it: {error}",
                db_path.display()
            )
        });
        assert!(
            !main.is_empty(),
            "engine database {} holds no bytes; a scan over nothing proves nothing",
            db_path.display()
        );
        let mut files = vec![(db_path.to_path_buf(), main)];
        // The sidecars are present only while the WAL is live. Their ABSENCE is
        // normal after a clean close; any OTHER read error is not, and must not
        // be swallowed. `if let Ok(..)` treated a permissions failure, an I/O
        // error or a Windows sharing violation as "no such file", so a leak
        // living only in an unreadable WAL would produce a passing security test
        // while the positive control still succeeded from the main database.
        for sidecar in [wal_sidecar(db_path), shm_sidecar(db_path)] {
            match std::fs::read(&sidecar) {
                Ok(bytes) => files.push((sidecar, bytes)),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => panic!(
                    "sidecar {} exists but could not be read ({error}); a scan that \
                     skips it cannot claim to have inspected persisted bytes",
                    sidecar.display()
                ),
            }
        }
        Self { files }
    }

    /// The total number of bytes scanned, across the database and its sidecars.
    #[must_use]
    pub fn byte_count(&self) -> usize {
        self.files.iter().map(|(_, bytes)| bytes.len()).sum()
    }

    /// The file `needle` was found in, if any.
    #[must_use]
    pub fn find(&self, needle: &[u8]) -> Option<&Path> {
        self.files
            .iter()
            .find(|(_, bytes)| bytes_contain(bytes, needle))
            .map(|(path, _)| path.as_path())
    }

    /// Fail unless `needle` is somewhere in the scanned bytes.
    ///
    /// This is the positive control. Pair it with every
    /// [`assert_absent`](Self::assert_absent): it is what distinguishes "the
    /// plaintext is not there" from "the scan looked at the wrong bytes".
    ///
    /// # Panics
    ///
    /// When `needle` is empty or is not found.
    pub fn assert_present(&self, label: &str, needle: &[u8]) {
        assert!(
            !needle.is_empty(),
            "positive control {label} is empty, so it proves nothing"
        );
        assert!(
            self.find(needle).is_some(),
            "positive control {label} was NOT found in the {} scanned bytes, so this scan \
             proves nothing about what is absent",
            self.byte_count()
        );
    }

    /// Fail when `needle` appears anywhere in the scanned bytes.
    ///
    /// # Panics
    ///
    /// When `needle` is empty (an empty needle is unfindable, so the assertion
    /// would be vacuous), or when it is found.
    pub fn assert_absent(&self, label: &str, needle: &[u8]) {
        assert!(
            !needle.is_empty(),
            "absence assertion for {label} has an empty needle, so it is vacuous"
        );
        if let Some(path) = self.find(needle) {
            panic!("{label} leaked into {}", path.display());
        }
    }

    /// A secret plaintext must appear in **neither** form: not as its raw
    /// bytes, and not base64-encoded. Ciphertext lands in `TEXT` columns as
    /// standard base64, so a raw-bytes scan alone would miss a plaintext that
    /// took the base64 path into the database.
    ///
    /// # Panics
    ///
    /// When either form is found, or when `plaintext` is empty.
    pub fn assert_secret_plaintext_absent(&self, plaintext: &str) {
        self.assert_absent("secret plaintext", plaintext.as_bytes());
        self.assert_absent(
            "base64 of the secret plaintext",
            encode_standard(plaintext.as_bytes()).as_bytes(),
        );
    }

    /// Positive control against the store's own data: every `ciphertext_base64`
    /// held in `secret_files` must be findable in the scanned bytes.
    ///
    /// This is stronger than counting rows. It proves the scan covered the very
    /// bytes the secret was written into, so an absence assertion over the same
    /// bytes is a real result.
    ///
    /// Assert a `-wal` sidecar was among the files read, and that it holds
    /// bytes. Without this, a scan whose WAL was checkpointed away still passes
    /// every absence assertion -- over the main file alone, which holds only the
    /// FINAL page image. The bytes a leak would have touched and then overwritten
    /// live in the WAL, so a scan that missed it proves nothing about them.
    ///
    /// # Panics
    ///
    /// When no `-wal` file was read, or the one read is empty.
    pub fn assert_scanned_wal(&self) {
        let wal = self
            .files
            .iter()
            .find(|(path, _)| path.to_string_lossy().ends_with("-wal"));
        let Some((path, bytes)) = wal else {
            panic!(
                "no -wal sidecar was scanned, so this proves nothing about bytes that \
                 reached the write-ahead log. It was checkpointed away before the scan: \
                 scan before the last connection closes, or hold an `open_readonly_keeper`"
            );
        };
        assert!(
            !bytes.is_empty(),
            "scanned {} holds no bytes; the WAL carried no evidence",
            path.display()
        );
    }

    /// # Panics
    ///
    /// When `secret_files` is empty (there would be nothing to prove), when the
    /// database cannot be read, or when a stored ciphertext is not found.
    pub fn assert_stored_ciphertext_scanned(&self, db_path: &Path) {
        let connection = Connection::open(db_path)
            .unwrap_or_else(|error| panic!("reopen {} to read tips: {error}", db_path.display()));
        let mut statement = connection
            .prepare("SELECT version_id, path, ciphertext_base64 FROM secret_files")
            .expect("prepare secret tip read");
        let tips: Vec<(String, String, String)> = statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .expect("query secret tips")
            .collect::<Result<Vec<_>, _>>()
            .expect("read secret tips");
        assert!(
            !tips.is_empty(),
            "no secret tips are stored, so this scan has no positive control"
        );
        for (version_id, path, ciphertext_base64) in tips {
            self.assert_present(
                &format!("stored ciphertext for {version_id}/{path}"),
                ciphertext_base64.as_bytes(),
            );
        }
    }
}
