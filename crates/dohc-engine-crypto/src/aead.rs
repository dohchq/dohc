//! AES-256-GCM secret-file AEAD, byte-exact with the TS oracle
//! (`secretFileStore.ts` `encryptSecretText`/`decryptSecretText`,
//! `LANGUAGE_SEMANTICS_MATRIX.md` §10.6).
//!
//! Parameters, fixed and non-negotiable for cross-engine parity:
//! - 256-bit key, 96-bit (12-byte) random IV per write, 128-bit (16-byte) tag.
//! - The tag is DETACHED: TS stores IV / tag / ciphertext in three separate
//!   base64 fields, so we use `encrypt_in_place_detached` rather than the
//!   append-tag `Aead::encrypt`.
//! - AAD is the UTF-8 bytes of `dohc-secret-v1\0<workspace>\0<path>` — binding
//!   ciphertext to its workspace AND path so rows cannot be spliced across
//!   files. Deliberately NOT version-bound (fork/merge/restore copy ciphertext
//!   across versions of the same path without re-encryption).
//! - Any open failure (wrong key, tampered ciphertext/tag, AAD mismatch) →
//!   [`CryptoError::DecryptFailed`], fail closed. Never a partial/garbage return.

use crate::base64;
use crate::error::CryptoError;
use crate::key::SecretDataKey;
use crate::secret::SecretPlaintext;
use aes_gcm::aead::{AeadInPlace, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce, Tag};

/// The AAD format prefix. Never change: it is part of the on-disk/cross-engine
/// contract.
pub const SECRET_AAD_PREFIX: &str = "dohc-secret-v1";
/// GCM nonce length in bytes.
pub const SECRET_IV_BYTES: usize = 12;
/// GCM tag length in bytes.
pub const SECRET_TAG_BYTES: usize = 16;
/// The 1 MiB secret-file plaintext cap (`MAX_SECRET_FILE_BYTES`).
pub const MAX_SECRET_FILE_BYTES: usize = 1024 * 1024;

/// Build the AEAD associated data: `dohc-secret-v1\0<workspace>\0<path>` as raw
/// UTF-8 bytes (NUL-separated). Byte-identical to `secretAad` in TS.
#[must_use]
pub fn secret_aad(workspace_id: &str, path: &str) -> Vec<u8> {
    let mut aad = Vec::with_capacity(SECRET_AAD_PREFIX.len() + workspace_id.len() + path.len() + 2);
    aad.extend_from_slice(SECRET_AAD_PREFIX.as_bytes());
    aad.push(0);
    aad.extend_from_slice(workspace_id.as_bytes());
    aad.push(0);
    aad.extend_from_slice(path.as_bytes());
    aad
}

/// A sealed secret: the three separate fields the store persists (IV, tag,
/// ciphertext) plus the declared plaintext byte length. GCM is length-
/// preserving, so `ciphertext.len() == byte_length`.
#[derive(Clone, PartialEq, Eq)]
pub struct SealedSecret {
    iv: [u8; SECRET_IV_BYTES],
    tag: [u8; SECRET_TAG_BYTES],
    ciphertext: Vec<u8>,
    byte_length: usize,
}

impl SealedSecret {
    /// Reconstruct from the base64 fields as stored in the DB / carried on the
    /// wire, validating each field strictly (canonical, exact length). Used when
    /// reading a secret row or a replication payload.
    pub fn from_base64(
        iv_base64: &str,
        auth_tag_base64: &str,
        ciphertext_base64: &str,
        byte_length: usize,
    ) -> Result<Self, CryptoError> {
        let iv_vec = base64::strict_decode_exact(iv_base64, SECRET_IV_BYTES)?;
        let tag_vec = base64::strict_decode_exact(auth_tag_base64, SECRET_TAG_BYTES)?;
        let ciphertext = base64::strict_decode_exact(ciphertext_base64, byte_length)?;
        let mut iv = [0u8; SECRET_IV_BYTES];
        iv.copy_from_slice(&iv_vec);
        let mut tag = [0u8; SECRET_TAG_BYTES];
        tag.copy_from_slice(&tag_vec);
        Ok(SealedSecret {
            iv,
            tag,
            ciphertext,
            byte_length,
        })
    }

    /// The IV bytes.
    #[must_use]
    pub fn iv(&self) -> &[u8; SECRET_IV_BYTES] {
        &self.iv
    }
    /// The auth tag bytes.
    #[must_use]
    pub fn tag(&self) -> &[u8; SECRET_TAG_BYTES] {
        &self.tag
    }
    /// The ciphertext bytes.
    #[must_use]
    pub fn ciphertext(&self) -> &[u8] {
        &self.ciphertext
    }
    /// The declared plaintext byte length.
    #[must_use]
    pub fn byte_length(&self) -> usize {
        self.byte_length
    }
    /// IV as standard padded base64 (the TS `ivBase64` column shape).
    #[must_use]
    pub fn iv_base64(&self) -> String {
        base64::encode_standard(&self.iv)
    }
    /// Tag as standard padded base64 (`authTagBase64`).
    #[must_use]
    pub fn auth_tag_base64(&self) -> String {
        base64::encode_standard(&self.tag)
    }
    /// Ciphertext as standard padded base64 (`ciphertextBase64`).
    #[must_use]
    pub fn ciphertext_base64(&self) -> String {
        base64::encode_standard(&self.ciphertext)
    }
}

/// Debug never prints ciphertext/tag/IV bytes — only lengths.
impl core::fmt::Debug for SealedSecret {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        write!(
            f,
            "SealedSecret(iv=12, tag=16, ciphertext={} bytes)",
            self.ciphertext.len()
        )
    }
}

fn cipher_for(key: &SecretDataKey) -> Result<Aes256Gcm, CryptoError> {
    Aes256Gcm::new_from_slice(key.as_bytes()).map_err(|_| CryptoError::InvalidKeyLength)
}

/// Encrypt `plaintext` under `key`, bound to `workspace_id`+`path`, using the
/// caller-supplied `iv`. Exposed for deterministic tests and cross-engine parity
/// (production uses [`seal`], which draws a random IV).
pub fn seal_with_iv(
    key: &SecretDataKey,
    workspace_id: &str,
    path: &str,
    plaintext: &[u8],
    iv: [u8; SECRET_IV_BYTES],
) -> Result<SealedSecret, CryptoError> {
    if plaintext.len() > MAX_SECRET_FILE_BYTES {
        return Err(CryptoError::PlaintextTooLarge);
    }
    let cipher = cipher_for(key)?;
    let aad = secret_aad(workspace_id, path);
    let mut buffer = plaintext.to_vec();
    let tag_ga = cipher
        .encrypt_in_place_detached(Nonce::from_slice(&iv), &aad, &mut buffer)
        // An in-place GCM encrypt only fails on absurd (>64 GiB) inputs, which
        // the size cap above already excludes; treat as a decrypt-class failure.
        .map_err(|_| CryptoError::DecryptFailed)?;
    let mut tag = [0u8; SECRET_TAG_BYTES];
    tag.copy_from_slice(tag_ga.as_slice());
    Ok(SealedSecret {
        iv,
        tag,
        byte_length: buffer.len(),
        ciphertext: buffer,
    })
}

/// Encrypt `plaintext` under `key` with a fresh random 96-bit IV. The
/// production path (`encryptSecretText`).
pub fn seal(
    key: &SecretDataKey,
    workspace_id: &str,
    path: &str,
    plaintext: &[u8],
) -> Result<SealedSecret, CryptoError> {
    let mut iv = [0u8; SECRET_IV_BYTES];
    getrandom::getrandom(&mut iv).map_err(|_| CryptoError::InvalidIvLength)?;
    seal_with_iv(key, workspace_id, path, plaintext, iv)
}

/// Decrypt `sealed` under `key`, bound to `workspace_id`+`path`. Any failure —
/// wrong key, tampered ciphertext/tag, or an AAD mismatch (wrong workspace or
/// path) — returns [`CryptoError::DecryptFailed`], fail closed. The plaintext is
/// returned only inside a zeroizing [`SecretPlaintext`].
pub fn open(
    key: &SecretDataKey,
    workspace_id: &str,
    path: &str,
    sealed: &SealedSecret,
) -> Result<SecretPlaintext, CryptoError> {
    let cipher = cipher_for(key)?;
    let aad = secret_aad(workspace_id, path);
    let mut buffer = sealed.ciphertext.clone();
    let tag = Tag::from_slice(&sealed.tag);
    cipher
        .decrypt_in_place_detached(Nonce::from_slice(&sealed.iv), &aad, &mut buffer, tag)
        .map_err(|_| CryptoError::DecryptFailed)?;
    Ok(SecretPlaintext::new(buffer))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::key::SECRET_KEY_BYTES;

    fn key() -> SecretDataKey {
        SecretDataKey::from_bytes(&[7u8; SECRET_KEY_BYTES]).unwrap()
    }

    #[test]
    fn round_trips_secret_content() {
        let k = key();
        let text = b"API_KEY=super-secret-\xf0\x9f\x94\x90";
        let sealed = seal(&k, "ws1", ".env", text).unwrap();
        assert_eq!(sealed.iv().len(), SECRET_IV_BYTES);
        assert_eq!(sealed.tag().len(), SECRET_TAG_BYTES);
        assert_eq!(
            sealed.ciphertext().len(),
            text.len(),
            "GCM is length-preserving"
        );
        let opened = open(&k, "ws1", ".env", &sealed).unwrap();
        assert_eq!(opened.as_bytes(), text);
    }

    #[test]
    fn empty_plaintext_seals_and_opens() {
        let k = key();
        let sealed = seal(&k, "ws1", ".env", b"").unwrap();
        assert_eq!(sealed.byte_length(), 0);
        assert!(sealed.ciphertext().is_empty());
        assert_eq!(
            sealed.tag().len(),
            SECRET_TAG_BYTES,
            "tag present even for empty"
        );
        assert!(open(&k, "ws1", ".env", &sealed).unwrap().is_empty());
    }

    #[test]
    fn wrong_key_fails_closed() {
        let sealed = seal(&key(), "ws1", ".env", b"secret").unwrap();
        let other = SecretDataKey::from_bytes(&[9u8; SECRET_KEY_BYTES]).unwrap();
        assert_eq!(
            open(&other, "ws1", ".env", &sealed).unwrap_err(),
            CryptoError::DecryptFailed
        );
    }

    #[test]
    fn tampered_ciphertext_byte_fails_closed() {
        let k = key();
        let sealed = seal(&k, "ws1", ".env", b"secret").unwrap();
        let mut ct = sealed.ciphertext().to_vec();
        ct[0] ^= 0x01;
        let tampered = SealedSecret::from_base64(
            &sealed.iv_base64(),
            &sealed.auth_tag_base64(),
            &crate::base64::encode_standard(&ct),
            sealed.byte_length(),
        )
        .unwrap();
        assert_eq!(
            open(&k, "ws1", ".env", &tampered).unwrap_err(),
            CryptoError::DecryptFailed
        );
    }

    #[test]
    fn tampered_tag_byte_fails_closed() {
        let k = key();
        let sealed = seal(&k, "ws1", ".env", b"secret").unwrap();
        let mut tag = sealed.tag().to_vec();
        tag[0] ^= 0x80;
        let tampered = SealedSecret::from_base64(
            &sealed.iv_base64(),
            &crate::base64::encode_standard(&tag),
            &sealed.ciphertext_base64(),
            sealed.byte_length(),
        )
        .unwrap();
        assert_eq!(
            open(&k, "ws1", ".env", &tampered).unwrap_err(),
            CryptoError::DecryptFailed
        );
    }

    #[test]
    fn aad_is_byte_exact() {
        assert_eq!(secret_aad("ws", "p"), b"dohc-secret-v1\0ws\0p".to_vec());
    }

    #[test]
    fn oversize_plaintext_rejected() {
        let k = key();
        let big = vec![0u8; MAX_SECRET_FILE_BYTES + 1];
        assert_eq!(
            seal_with_iv(&k, "ws1", ".env", &big, [0u8; SECRET_IV_BYTES]).unwrap_err(),
            CryptoError::PlaintextTooLarge
        );
    }

    #[test]
    fn debug_is_redacted() {
        let sealed = seal(&key(), "ws1", ".env", b"topsecret").unwrap();
        let dbg = format!("{sealed:?}");
        assert!(!dbg.contains("topsecret"));
        assert!(dbg.contains("SealedSecret"));
    }
}
