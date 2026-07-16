//! dohc engine crypto — R08 secrets capability shard.
//!
//! The security-critical core for secret-backed files: AES-256-GCM AEAD with
//! byte-exact cross-engine parity to the TS engine
//! (`packages/workspace-engine/src/secretFileStore.ts` +
//! `secretKeyEnvelope.ts`), the scrypt-wrapped workspace data-key envelope, and
//! the redaction-safe [`SecretPlaintext`] / [`SecretDataKey`] types that make
//! cleartext impossible to log or serialize by accident.
//!
//! Invariants this crate upholds (`plan §Product invariants`):
//! - **Plaintext never leaks.** The only cleartext carrier is
//!   [`SecretPlaintext`], which has no `Display`/`Serialize`, redacts under
//!   `Debug`, and zeroizes on drop. Everything persisted or replicated is
//!   ciphertext + IV + tag (base64) — proven byte-for-byte by the cross-engine
//!   fixtures and the plaintext-never-leaks scan in the domain shard.
//! - **Fail closed.** Any AEAD open failure — wrong key, tampered
//!   ciphertext/tag, or an AAD mismatch binding the wrong workspace/path —
//!   returns [`CryptoError::DecryptFailed`], never a partial or garbage value.
//! - **Cross-engine byte parity.** IV=12 bytes, tag=16 bytes, AAD =
//!   `dohc-secret-v1\0<workspace>\0<path>`, standard padded base64 storage. A
//!   TS-produced ciphertext decrypts here and vice versa.
//!
//! This crate is pure crypto: it depends on no storage, filesystem, or SQLite.
//! The secret domain ops (tables, write/read, fork, materialization) live in
//! `dohc-engine-domain`. The crate is dormant — not wired into the product.

#![forbid(unsafe_code)]

pub mod aead;
pub mod base64;
pub mod envelope;
pub mod error;
pub mod key;
pub mod secret;

pub use aead::{
    MAX_SECRET_FILE_BYTES, SECRET_AAD_PREFIX, SECRET_IV_BYTES, SECRET_TAG_BYTES, SealedSecret,
    open, seal, seal_with_iv, secret_aad,
};
pub use error::CryptoError;
pub use key::{SECRET_KEY_BYTES, SECRET_KEY_FILE_PREFIX, SecretDataKey};
pub use secret::SecretPlaintext;
