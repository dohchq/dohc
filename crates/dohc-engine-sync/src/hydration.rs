use dohc_engine_domain::{MAX_CAPTURE_BINARY_FILE_BYTES, MAX_TEXT_BYTES};
use dohc_engine_storage::{EngineStore, FaultInjector, FaultPoint, TxnOutcome, hex_sha256};
use rusqlite::{OptionalExtension, params};

use crate::SyncError;
use crate::journal::crashes;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum BlobKind {
    Text,
    Binary,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BlobContent {
    Text(String),
    Binary(Vec<u8>),
}

impl BlobContent {
    fn kind(&self) -> BlobKind {
        match self {
            BlobContent::Text(_) => BlobKind::Text,
            BlobContent::Binary(_) => BlobKind::Binary,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlobHydration {
    pub sha256: String,
    pub content: BlobContent,
}

/// The store's byte ceiling for a blob kind, as a named constraint and its
/// configured limit. Single source of truth for both ingest checks.
pub const fn blob_ceiling(kind: BlobKind) -> (&'static str, usize) {
    match kind {
        BlobKind::Text => ("MAX_TEXT_BYTES", MAX_TEXT_BYTES),
        BlobKind::Binary => (
            "MAX_CAPTURE_BINARY_FILE_BYTES",
            MAX_CAPTURE_BINARY_FILE_BYTES,
        ),
    }
}

/// Hash-verify and hydrate a bounded content-addressed blob in one transaction.
/// Existing content is re-verified; a hash collision or poisoned row fails
/// closed instead of being overwritten.
///
/// The ceiling is enforced here, not inherited from a transport response bound,
/// so every caller ingests under the same store invariants. Relay pulls bail
/// out earlier, on the undecoded response, to skip the hash and the copy.
pub fn hydrate_blob_content(
    store: &mut EngineStore,
    blob: &BlobHydration,
    faults: &dyn FaultInjector,
) -> Result<TxnOutcome<()>, SyncError> {
    let bytes = match &blob.content {
        BlobContent::Text(text) => text.as_bytes(),
        BlobContent::Binary(bytes) => bytes.as_slice(),
    };
    let (constraint, limit_bytes) = blob_ceiling(blob.content.kind());
    if bytes.len() > limit_bytes {
        return Err(SyncError::BlobTooLarge {
            constraint,
            limit_bytes,
            observed_bytes: bytes.len(),
        });
    }
    if hex_sha256(bytes) != blob.sha256 {
        return Err(SyncError::BlobInvalid);
    }
    let outcome = store.write_with(faults, |tx| {
        match &blob.content {
            BlobContent::Text(text) => {
                let existing: Option<(i64, String)> = tx
                    .query_row(
                        "SELECT byte_length,text FROM blobs WHERE sha256=?1",
                        [&blob.sha256],
                        |row| Ok((row.get(0)?, row.get(1)?)),
                    )
                    .optional()
                    .map_err(SyncError::corrupt)?;
                let byte_length = i64::try_from(text.len()).map_err(|_| SyncError::BlobInvalid)?;
                if let Some((stored_len, stored)) = existing {
                    if stored_len != byte_length || stored != text.as_str() {
                        return Err(SyncError::BlobInvalid);
                    }
                } else {
                    tx.execute(
                        "INSERT INTO blobs (sha256,byte_length,text) VALUES (?1,?2,?3)",
                        params![blob.sha256, byte_length, text],
                    )
                    .map_err(SyncError::persist)?;
                }
            }
            BlobContent::Binary(bytes) => {
                let existing: Option<(i64, Vec<u8>)> = tx
                    .query_row(
                        "SELECT byte_length,bytes FROM binary_blobs WHERE sha256=?1",
                        [&blob.sha256],
                        |row| Ok((row.get(0)?, row.get(1)?)),
                    )
                    .optional()
                    .map_err(SyncError::corrupt)?;
                let byte_length = i64::try_from(bytes.len()).map_err(|_| SyncError::BlobInvalid)?;
                if let Some((stored_len, stored)) = existing {
                    if stored_len != byte_length || stored.as_slice() != bytes.as_slice() {
                        return Err(SyncError::BlobInvalid);
                    }
                } else {
                    tx.execute(
                        "INSERT INTO binary_blobs (sha256,byte_length,bytes) VALUES (?1,?2,?3)",
                        params![blob.sha256, byte_length, bytes],
                    )
                    .map_err(SyncError::persist)?;
                }
            }
        }
        if crashes(faults, FaultPoint::SyncBeforeBlobHydrateCommit) {
            return Err(SyncError::FaultCrash);
        }
        Ok(())
    });
    match outcome {
        Err(SyncError::FaultCrash) => Ok(TxnOutcome::Crashed { committed: false }),
        other => other,
    }
}
