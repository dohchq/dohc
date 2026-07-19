//! [`SecretDataKey`]: the 32-byte per-workspace AES-256-GCM data key, and the
//! versioned `.dohc/engine/secret.key` file format it round-trips through.
//!
//! Custody mirrors the TS store (`secretFileStore.ts:81-263`): the key lives in
//! a `0600` file as `dohc-secret-key-v1:<base64(32 bytes)>` plus a trailing
//! newline. The base64 parse is forgiving (Node parity, matrix §4.7); the real
//! guard is the exact 32-byte length. The key handle zeroizes on drop and
//! redacts under `Debug`, so it can never spill into a log or a serialized
//! payload (`STATE_OWNERSHIP.tsv` `secret-key-handle` → Rust row).

use crate::base64;
use crate::error::CryptoError;
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

/// The versioned prefix of the on-disk key file. The format is versioned so an
/// OS-keychain wrap can be layered on later without a migration.
pub const SECRET_KEY_FILE_PREFIX: &str = "dohc-secret-key-v1:";

/// AES-256 key size.
pub const SECRET_KEY_BYTES: usize = 32;

/// A 32-byte workspace data key. Zeroized on drop; `Debug` is redacted.
#[derive(Clone, PartialEq, Eq, Zeroize, ZeroizeOnDrop)]
pub struct SecretDataKey([u8; SECRET_KEY_BYTES]);

impl SecretDataKey {
    /// Wrap raw 32 bytes as a data key.
    pub fn from_bytes(bytes: &[u8]) -> Result<Self, CryptoError> {
        let arr: [u8; SECRET_KEY_BYTES] = bytes
            .try_into()
            .map_err(|_| CryptoError::InvalidKeyLength)?;
        Ok(SecretDataKey(arr))
    }

    /// Generate a fresh random data key from the OS CSPRNG. Used on the first
    /// secret capture for a workspace (`loadSecretDataKey` create branch).
    pub fn generate() -> Result<Self, CryptoError> {
        let mut bytes = [0u8; SECRET_KEY_BYTES];
        // A CSPRNG failure is unrecoverable for key generation; surface it as an
        // invalid-key error rather than panicking.
        getrandom::getrandom(&mut bytes).map_err(|_| CryptoError::InvalidKeyLength)?;
        Ok(SecretDataKey(bytes))
    }

    /// Borrow the raw key bytes (for the AEAD primitive only).
    #[must_use]
    pub(crate) fn as_bytes(&self) -> &[u8; SECRET_KEY_BYTES] {
        &self.0
    }

    /// Parse the versioned key-file content. Forgiving base64 (Node parity); the
    /// 32-byte length is the authoritative guard. A missing prefix or wrong
    /// length is `key-corrupt` — dohc never regenerates a key over an existing
    /// file, so a malformed file fails closed rather than orphaning snapshots.
    pub fn parse_key_file(content: &str) -> Result<Self, CryptoError> {
        let trimmed = content.trim();
        let encoded = trimmed
            .strip_prefix(SECRET_KEY_FILE_PREFIX)
            .ok_or(CryptoError::KeyFileMalformed)?;
        // Raw key material must only ever live in a zeroizing buffer — the
        // decoded bytes are scrubbed on drop whether or not the length check
        // passes.
        let bytes = Zeroizing::new(base64::forgiving_decode(encoded));
        if bytes.len() != SECRET_KEY_BYTES {
            return Err(CryptoError::KeyFileMalformed);
        }
        Self::from_bytes(&bytes)
    }

    /// Serialize to the versioned key-file content (with trailing newline),
    /// byte-identical to what the TS store writes.
    #[must_use]
    pub fn to_key_file(&self) -> String {
        format!(
            "{SECRET_KEY_FILE_PREFIX}{}\n",
            base64::encode_standard(&self.0)
        )
    }
}

/// Redacted debug: never prints key bytes.
impl core::fmt::Debug for SecretDataKey {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str("SecretDataKey(<redacted>)")
    }
}

/// Workspace-relative location of the key file.
pub const SECRET_KEY_FILE_RELATIVE: &str = ".dohc/engine/secret.key";

/// Load the workspace data key from `.dohc/engine/secret.key` under `root`,
/// creating a fresh one on first use. Ports `loadSecretDataKey`
/// (`secretFileStore.ts`): a MISSING file generates + persists a new key
/// (0600 on Unix); an EXISTING file is parsed and a malformed one fails
/// CLOSED (`key-corrupt`) — dohc never regenerates a key over an existing
/// file, because that would silently orphan every sealed snapshot.
pub fn load_or_create_key_file(root: &std::path::Path) -> Result<SecretDataKey, CryptoError> {
    match load_key_file(root)? {
        Some(key) => Ok(key),
        None => create_key_file(root),
    }
}

/// Load the workspace data key, returning `Ok(None)` when no key file exists.
/// A present-but-malformed/unreadable file fails CLOSED. On a successful load
/// the file's permissions are re-tightened to 0600 (Unix; TS parity —
/// `secretFileStore.ts` chmods existing key files after read, so a restored
/// or hand-copied key never stays world-readable).
pub fn load_key_file(root: &std::path::Path) -> Result<Option<SecretDataKey>, CryptoError> {
    let path = root.join(SECRET_KEY_FILE_RELATIVE);
    match std::fs::read_to_string(&path) {
        Ok(content) => {
            // The read succeeded, so the file holds (candidate) key material:
            // tighten permissions BEFORE parsing — a malformed-but-readable
            // file must not stay world-readable just because the parse fails
            // closed. The content buffer zeroizes on drop either way.
            let content = Zeroizing::new(content);
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
            }
            let key = SecretDataKey::parse_key_file(&content)?;
            Ok(Some(key))
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(CryptoError::KeyFileMalformed),
    }
}

/// Mint and durably publish a fresh workspace data key. CALLER CONTRACT: only
/// invoke when the workspace has NO existing secret state — minting over
/// orphaned ciphertext would strand it silently; the capture layer checks the
/// encrypted store first and fails closed instead (TS parity:
/// `loadSecretDataKey` checks protected rows before its create branch).
pub fn create_key_file(root: &std::path::Path) -> Result<SecretDataKey, CryptoError> {
    let path = root.join(SECRET_KEY_FILE_RELATIVE);
    let key = SecretDataKey::generate()?;
    if let Some(parent) = path.parent() {
        let mut builder = std::fs::DirBuilder::new();
        builder.recursive(true);
        // The key's directory must not advertise its existence to
        // other local users (the file itself is 0600 below).
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder
            .create(parent)
            .map_err(|_| CryptoError::KeyFileMalformed)?;
    }
    // DURABLE publish: temp (0600) + fsync + hard-link. The key file must
    // be durably on disk BEFORE any ciphertext is committed under it —
    // a crash that lost a visible-but-unflushed key would strand every
    // sealed snapshot, and a later restart would silently re-mint. The
    // link-publish also means a partially written key can never be visible
    // at the final path.
    let temp = path.with_extension(format!("tmp-{}", std::process::id()));
    let written = (|| -> std::io::Result<()> {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temp)?;
        use std::io::Write;
        // The serialized payload carries the key; it must zeroize on drop
        // like every other buffer holding key material.
        let payload = Zeroizing::new(key.to_key_file());
        file.write_all(payload.as_bytes())?;
        file.sync_all()?;
        Ok(())
    })();
    if written.is_err() {
        let _ = std::fs::remove_file(&temp);
        return Err(CryptoError::KeyFileMalformed);
    }
    // NO-CLOBBER publish: `hard_link` fails atomically when the destination
    // exists, so a concurrent minter can never REPLACE an already-published
    // key (a replaced key would instantly orphan every row sealed under it);
    // the losing racer adopts the winner instead. `rename` cannot give this
    // guarantee — it replaces the destination on both Unix and Windows.
    match std::fs::hard_link(&temp, &path) {
        Ok(()) => {
            let _ = std::fs::remove_file(&temp);
        }
        Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => {
            let _ = std::fs::remove_file(&temp);
            let content = Zeroizing::new(
                std::fs::read_to_string(&path).map_err(|_| CryptoError::KeyFileMalformed)?,
            );
            return SecretDataKey::parse_key_file(&content);
        }
        Err(_) => {
            // Filesystems without hard links (FAT/exFAT): best-effort
            // exists-check + rename. Non-atomic, documented — the engine's
            // single-actor-per-workspace locking makes one minter the
            // operating reality; this branch only serves exotic mounts.
            if path.exists() {
                let _ = std::fs::remove_file(&temp);
                let content = Zeroizing::new(
                    std::fs::read_to_string(&path).map_err(|_| CryptoError::KeyFileMalformed)?,
                );
                return SecretDataKey::parse_key_file(&content);
            }
            if std::fs::rename(&temp, &path).is_err() {
                let _ = std::fs::remove_file(&temp);
                return Err(CryptoError::KeyFileMalformed);
            }
        }
    }
    // Durability of the PUBLISH itself: fsync the parent directory
    // where the platform allows it (std cannot open directories on
    // Windows; NTFS metadata journaling is the best effort there).
    #[cfg(unix)]
    if let Some(parent) = path.parent()
        && let Ok(dir) = std::fs::File::open(parent)
    {
        let _ = dir.sync_all();
    }
    // Return what is DURABLY at the path — under any interleaving the
    // published file is the single source of truth.
    let content =
        Zeroizing::new(std::fs::read_to_string(&path).map_err(|_| CryptoError::KeyFileMalformed)?);
    SecretDataKey::parse_key_file(&content)
}

#[cfg(test)]
mod tests {
    use super::*;
    use zeroize::Zeroize;

    #[test]
    fn key_file_round_trips_byte_exact() {
        let key = SecretDataKey::from_bytes(&[0xABu8; SECRET_KEY_BYTES]).unwrap();
        let file = key.to_key_file();
        assert!(file.starts_with(SECRET_KEY_FILE_PREFIX));
        assert!(file.ends_with('\n'));
        let parsed = SecretDataKey::parse_key_file(&file).unwrap();
        assert_eq!(parsed, key);
    }

    #[test]
    fn parse_tolerates_surrounding_whitespace() {
        let key = SecretDataKey::from_bytes(&[3u8; SECRET_KEY_BYTES]).unwrap();
        let file = key.to_key_file();
        let padded = format!("  \n{}\n\t ", file.trim_end());
        assert_eq!(SecretDataKey::parse_key_file(&padded).unwrap(), key);
    }

    #[test]
    fn malformed_prefix_or_length_fails_closed() {
        assert_eq!(
            SecretDataKey::parse_key_file("nope:AAAA").unwrap_err(),
            CryptoError::KeyFileMalformed
        );
        // Right prefix, wrong length.
        let short = format!(
            "{SECRET_KEY_FILE_PREFIX}{}",
            base64::encode_standard(&[1u8; 16])
        );
        assert_eq!(
            SecretDataKey::parse_key_file(&short).unwrap_err(),
            CryptoError::KeyFileMalformed
        );
    }

    #[test]
    fn wrong_length_bytes_rejected() {
        assert_eq!(
            SecretDataKey::from_bytes(&[0u8; 31]).unwrap_err(),
            CryptoError::InvalidKeyLength
        );
    }

    #[test]
    fn generate_produces_distinct_keys() {
        let a = SecretDataKey::generate().unwrap();
        let b = SecretDataKey::generate().unwrap();
        assert_ne!(a, b, "two fresh keys must differ (CSPRNG)");
    }

    #[test]
    fn explicit_zeroize_scrubs_key_bytes() {
        // Best-effort zeroization proof without unsafe: the same `Zeroize` impl
        // that runs on drop (via `ZeroizeOnDrop`) zeros the buffer here.
        let mut key = SecretDataKey::from_bytes(&[0xFFu8; SECRET_KEY_BYTES]).unwrap();
        key.zeroize();
        assert_eq!(key.as_bytes(), &[0u8; SECRET_KEY_BYTES]);
    }

    #[test]
    fn load_or_create_mints_once_then_reuses_and_fails_closed_on_corruption() {
        let dir = std::env::temp_dir().join(format!(
            "dohc-keyfile-test-{}-{:x}",
            std::process::id(),
            std::ptr::from_ref(&()) as usize
        ));
        std::fs::create_dir_all(&dir).unwrap();

        let first = load_or_create_key_file(&dir).expect("mint");
        let file = dir.join(SECRET_KEY_FILE_RELATIVE);
        let content = std::fs::read_to_string(&file).expect("key file written");
        assert!(content.starts_with(SECRET_KEY_FILE_PREFIX));

        let second = load_or_create_key_file(&dir).expect("reuse");
        assert_eq!(first, second, "an existing key is loaded, never re-minted");

        // A malformed existing file fails CLOSED — regenerating over it would
        // silently orphan every sealed snapshot.
        std::fs::write(&file, "garbage").unwrap();
        assert!(load_or_create_key_file(&dir).is_err());

        std::fs::remove_dir_all(&dir).ok();
    }

    #[cfg(unix)]
    #[test]
    fn load_retightens_lax_permissions_to_0600() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!(
            "dohc-keyperm-test-{}-{:x}",
            std::process::id(),
            std::ptr::from_ref(&()) as usize
        ));
        let key = create_key_file(&dir).expect("mint");
        let path = dir.join(SECRET_KEY_FILE_RELATIVE);
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();

        let loaded = load_key_file(&dir).expect("load").expect("present");
        assert_eq!(loaded, key);
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "a restored/hand-copied key is re-tightened");
        std::fs::remove_dir_all(&dir).ok();
    }
}
