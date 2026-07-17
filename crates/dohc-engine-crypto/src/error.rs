//! Redaction-safe error taxonomy for the secrets crypto core.
//!
//! Every message is a constant string — it never embeds plaintext, key
//! material, IVs, tags, or ciphertext. The `code()` accessor returns the exact
//! kebab-case strings the TS engine surfaces (`decrypt-failed`, `key-corrupt`,
//! `unwrap-failed`) so the ported store keeps error-code parity
//! (`LANGUAGE_SEMANTICS_MATRIX.md` §14.1).

use thiserror::Error;

/// A crypto operation failure. Deliberately coarse and content-free: a caller
/// (and any log line built from it) learns *that* an operation failed and its
/// stable code, never anything about the protected bytes.
#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum CryptoError {
    /// AEAD open failed: wrong key, tampered ciphertext/tag, or an AAD mismatch
    /// (wrong workspace/path). Always fail closed — never return partial or
    /// garbage plaintext. Mirrors the TS `decrypt-failed` code.
    #[error(
        "protected contents could not be decrypted (wrong key or tampered data); failing closed"
    )]
    DecryptFailed,

    /// A key buffer was not exactly 32 bytes. Mirrors the TS `key-corrupt` code.
    #[error("workspace secret key material has an invalid length")]
    InvalidKeyLength,

    /// The `.dohc/engine/secret.key` file did not match the versioned format or
    /// decoded to the wrong length. Mirrors the TS `key-corrupt` code.
    #[error("the workspace secret key file is malformed")]
    KeyFileMalformed,

    /// An IV was not exactly 12 bytes.
    #[error("secret IV has an invalid length")]
    InvalidIvLength,

    /// An auth tag was not exactly 16 bytes.
    #[error("secret auth tag has an invalid length")]
    InvalidTagLength,

    /// Plaintext exceeded the 1 MiB secret-file cap.
    #[error("protected contents exceed the secret file size limit")]
    PlaintextTooLarge,

    /// Plaintext was not valid UTF-8 (secret files round-trip through UTF-8).
    #[error("protected contents must round-trip through UTF-8")]
    PlaintextNotUtf8,

    /// A base64 field failed strict validation (wrong alphabet, wrong padding,
    /// wrong decoded length, or non-canonical). Used on the replication ingest
    /// path where TS applies the same strict guard.
    #[error("a base64 field is invalid")]
    InvalidBase64,

    /// The key envelope JSON was malformed or carried unexpected parameters.
    /// Normalized so nothing distinguishable about *why* it failed escapes —
    /// the TS envelope collapses every failure to one shape. Code `unwrap-failed`.
    #[error("workspace secret key envelope could not be unwrapped")]
    EnvelopeUnwrapFailed,
}

impl CryptoError {
    /// The stable kebab-case code, matching the TS store's tested contract.
    #[must_use]
    pub fn code(&self) -> &'static str {
        match self {
            CryptoError::DecryptFailed => "decrypt-failed",
            CryptoError::InvalidKeyLength | CryptoError::KeyFileMalformed => "key-corrupt",
            CryptoError::InvalidIvLength => "invalid-iv",
            CryptoError::InvalidTagLength => "invalid-tag",
            CryptoError::PlaintextTooLarge | CryptoError::PlaintextNotUtf8 => "invalid-text",
            CryptoError::InvalidBase64 => "invalid-input",
            CryptoError::EnvelopeUnwrapFailed => "unwrap-failed",
        }
    }
}
