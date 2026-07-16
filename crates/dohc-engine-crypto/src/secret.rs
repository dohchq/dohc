//! [`SecretPlaintext`]: the redaction-safe carrier for decrypted secret bytes.
//!
//! This is the one type that ever holds cleartext in memory. It is engineered
//! so cleartext CANNOT leave by accident:
//!
//! - No `Display`, no `serde::Serialize`, no `ToString` — it cannot be
//!   formatted into a string or a wire/journal payload.
//! - Its `Debug` is redacted (prints only the byte length), so a struct that
//!   derives `Debug` and happens to contain one never spills the contents into
//!   a log line.
//! - It zeroizes its buffer on drop (`zeroize`), best-effort scrubbing the
//!   cleartext from memory as soon as the value falls out of scope.
//!
//! The only ways OUT are the explicit `as_bytes` / `into_utf8` accessors a
//! caller must deliberately reach for — never an implicit format/serialize.

use crate::error::CryptoError;
use zeroize::Zeroizing;

/// Decrypted secret bytes with zero-on-drop and no leaky formatting.
#[derive(Clone, PartialEq, Eq)]
pub struct SecretPlaintext(Zeroizing<Vec<u8>>);

impl SecretPlaintext {
    /// Wrap raw plaintext bytes.
    #[must_use]
    pub fn new(bytes: Vec<u8>) -> Self {
        SecretPlaintext(Zeroizing::new(bytes))
    }

    /// Borrow the raw bytes. Deliberately explicit — the only non-consuming way
    /// to reach cleartext.
    #[must_use]
    pub fn as_bytes(&self) -> &[u8] {
        &self.0
    }

    /// Plaintext byte length. Length is metadata the TS store also persists
    /// (`byteLength`), so exposing it leaks nothing the ciphertext row didn't.
    #[must_use]
    pub fn len(&self) -> usize {
        self.0.len()
    }

    /// Whether the plaintext is empty (a 0-byte secret file is valid).
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    /// Validate the bytes as UTF-8 and hand back an owned `String`. Secret files
    /// round-trip through UTF-8 (`normalizeSecretText`, `secretFileStore.ts`),
    /// so a non-UTF-8 payload is rejected rather than lossily decoded. The
    /// returned `String` is NOT zeroizing — a caller that needs the text as a
    /// string owns that exposure deliberately.
    pub fn into_utf8(self) -> Result<String, CryptoError> {
        // Validate IN PLACE (no copy): only the Ok path allocates the
        // deliberately caller-owned `String`. A non-UTF-8 payload never leaves a
        // second un-zeroized copy behind (the failing `FromUtf8Error` would),
        // and `self`'s zeroizing buffer scrubs on drop.
        std::str::from_utf8(self.as_bytes())
            .map(str::to_owned)
            .map_err(|_| CryptoError::PlaintextNotUtf8)
    }
}

/// Redacted debug: byte length only, never the contents.
impl core::fmt::Debug for SecretPlaintext {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        write!(f, "SecretPlaintext(<redacted>, {} bytes)", self.0.len())
    }
}

impl From<&str> for SecretPlaintext {
    fn from(value: &str) -> Self {
        SecretPlaintext::new(value.as_bytes().to_vec())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn debug_never_reveals_contents() {
        let secret = SecretPlaintext::from("hunter2-DB_PASSWORD");
        let rendered = format!("{secret:?}");
        assert!(
            !rendered.contains("hunter2"),
            "debug must not leak plaintext"
        );
        assert!(rendered.contains("redacted"));
        assert!(rendered.contains("19 bytes"));
    }

    #[test]
    fn into_utf8_round_trips() {
        let secret = SecretPlaintext::from("API_KEY=🔐");
        assert_eq!(secret.into_utf8().unwrap(), "API_KEY=🔐");
    }

    #[test]
    fn non_utf8_rejected() {
        let secret = SecretPlaintext::new(vec![0xff, 0xfe, 0x00]);
        assert_eq!(
            secret.into_utf8().unwrap_err(),
            CryptoError::PlaintextNotUtf8
        );
    }

    #[test]
    fn len_and_empty() {
        assert!(SecretPlaintext::new(vec![]).is_empty());
        assert_eq!(SecretPlaintext::from("abc").len(), 3);
    }
}
