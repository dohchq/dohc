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
}
