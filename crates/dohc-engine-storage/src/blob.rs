//! Content-addressed binary blob storage (`plan §Storage and recovery model`,
//! "blobs, integrity"). Blobs are filed under the lowercase-hex sha-256 of
//! their exact bytes, so identical content is stored once (dedup by hash) and
//! every read re-verifies the bytes against the key before returning them
//! (integrity on read — a bit-rotted row fails closed, never returns as valid).
//!
//! The text-blob table (`blobs`) is CAL-2's; this module owns the binary analog
//! (`binary_blobs`) and the shared hashing discipline. Both read and write are
//! bounded by [`crate::limits::MAX_BLOB_BYTES`].

use crate::error::StorageError;
use crate::limits::MAX_BLOB_BYTES;
use rusqlite::{Connection, OptionalExtension};
use sha2::{Digest, Sha256};

/// The lowercase-hex sha-256 of `bytes` — the content-address key. The same
/// discipline `dohc-engine-files` hashes scanned files with, so a scanned file
/// hash and a stored blob hash are byte-identical (`semantics/sha256-parity`).
pub fn hex_sha256(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut hex = String::with_capacity(digest.len() * 2);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(hex, "{byte:02x}");
    }
    hex
}

/// Store `bytes` as a content-addressed binary blob, returning its sha-256 key.
/// Dedup: a second put of identical content is a no-op that returns the same
/// key. Bounded by [`MAX_BLOB_BYTES`]; over-cap input is a typed error, never a
/// silent truncation. `conn` may be a plain connection or a `&Transaction`
/// (which derefs to `&Connection`), so a caller can put a blob in the SAME
/// transaction as the domain mutation that references it.
pub fn put_binary_blob(conn: &Connection, bytes: &[u8]) -> Result<String, StorageError> {
    if bytes.len() > MAX_BLOB_BYTES {
        return Err(StorageError::BlobTooLarge {
            actual: bytes.len(),
        });
    }
    let sha256 = hex_sha256(bytes);
    // INSERT OR IGNORE is the dedup: an existing row for this hash is kept
    // (identical bytes by definition of content-addressing).
    conn.execute(
        "INSERT OR IGNORE INTO binary_blobs (sha256, byte_length, bytes) VALUES (?1, ?2, ?3)",
        rusqlite::params![sha256, bytes.len() as i64, bytes],
    )
    .map_err(StorageError::persist)?;
    Ok(sha256)
}

/// Store bytes supplied with a claimed content address, rejecting the write if
/// the claim does not match the exact bytes. Replicated bundle importers can
/// use this before persisting rows that foreign-key the binary blob.
pub fn put_binary_blob_verified(
    conn: &Connection,
    claimed_sha256: &str,
    bytes: &[u8],
) -> Result<String, StorageError> {
    if hex_sha256(bytes) != claimed_sha256 {
        return Err(StorageError::BlobIntegrity {
            sha256: claimed_sha256.to_owned(),
        });
    }
    put_binary_blob(conn, bytes)
}

/// Fetch a binary blob by key, verifying integrity on read. Returns `None` if
/// no such blob exists. If the stored bytes do not hash to `sha256`, fails
/// closed with [`StorageError::BlobIntegrity`] rather than returning corrupt
/// bytes.
pub fn get_binary_blob(conn: &Connection, sha256: &str) -> Result<Option<Vec<u8>>, StorageError> {
    let row: Option<(i64, Vec<u8>)> = conn
        .query_row(
            "SELECT byte_length, bytes FROM binary_blobs WHERE sha256 = ?1",
            [sha256],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(StorageError::corrupt)?;

    let Some((byte_length, bytes)) = row else {
        return Ok(None);
    };

    // Two independent integrity checks: the recorded length and the re-hash.
    if byte_length as usize != bytes.len() || bytes.len() > MAX_BLOB_BYTES {
        return Err(StorageError::BlobIntegrity {
            sha256: sha256.to_owned(),
        });
    }
    if hex_sha256(&bytes) != sha256 {
        return Err(StorageError::BlobIntegrity {
            sha256: sha256.to_owned(),
        });
    }
    Ok(Some(bytes))
}

/// Whether a blob with this key exists (no integrity check; a cheap presence
/// probe used by the materialization pipeline's idempotent replay).
pub fn has_binary_blob(conn: &Connection, sha256: &str) -> Result<bool, StorageError> {
    let present: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM binary_blobs WHERE sha256 = ?1",
            [sha256],
            |r| r.get(0),
        )
        .optional()
        .map_err(StorageError::corrupt)?;
    Ok(present.is_some())
}

/// The number of distinct binary blobs (dedup count).
pub fn binary_blob_count(conn: &Connection) -> Result<i64, StorageError> {
    conn.query_row("SELECT COUNT(*) FROM binary_blobs", [], |r| r.get(0))
        .map_err(StorageError::corrupt)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verified_put_rejects_claimed_hash_mismatch() {
        let conn = Connection::open_in_memory().expect("open in-memory database");
        let claimed = hex_sha256(b"different bytes");

        let error = put_binary_blob_verified(&conn, &claimed, b"actual bytes")
            .expect_err("mismatched claimed hash must fail closed");

        assert!(matches!(
            error,
            StorageError::BlobIntegrity { sha256 } if sha256 == claimed
        ));
    }
}
