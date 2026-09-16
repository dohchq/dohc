use dohc_engine_collab::limits::MAX_YDOC_UPDATE_BYTES;
use dohc_engine_domain::{MAX_CAPTURE_BINARY_FILE_BYTES, MAX_TEXT_BYTES};
use dohc_engine_storage::{EngineStore, FaultInjector, FaultPoint, TxnOutcome, hex_sha256};
use rusqlite::{OptionalExtension, params};

use crate::SyncError;
use crate::journal::crashes;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum BlobKind {
    Text,
    Binary,
    /// A Y.Doc update or full-state base. Stored beside [`BlobKind::Binary`] in
    /// `binary_blobs`, but its own kind because it carries its own ceiling: a
    /// CRDT payload is not a captured binary file and must not inherit that
    /// file's cap.
    Ydoc,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BlobContent {
    Text(String),
    Binary(Vec<u8>),
    Ydoc(Vec<u8>),
}

impl BlobContent {
    fn kind(&self) -> BlobKind {
        match self {
            BlobContent::Text(_) => BlobKind::Text,
            BlobContent::Binary(_) => BlobKind::Binary,
            BlobContent::Ydoc(_) => BlobKind::Ydoc,
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
        BlobKind::Ydoc => ("MAX_YDOC_UPDATE_BYTES", MAX_YDOC_UPDATE_BYTES),
    }
}

/// The loosest ingest ceiling across blob kinds. A transport must deliver a
/// blob of this size whole, and one byte more, so ingest refuses an overage by
/// name instead of the transport refusing it as an unreadable response.
pub const MAX_INGEST_BLOB_BYTES: usize = {
    let text = blob_ceiling(BlobKind::Text).1;
    let binary = blob_ceiling(BlobKind::Binary).1;
    let ydoc = blob_ceiling(BlobKind::Ydoc).1;
    let widest = if text > binary { text } else { binary };
    if ydoc > widest { ydoc } else { widest }
};

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
        BlobContent::Binary(bytes) | BlobContent::Ydoc(bytes) => bytes.as_slice(),
    };
    check_ceiling(blob.content.kind(), bytes.len())?;
    let verified = VerifiedBlob::verify(&blob.sha256, bytes)?;
    let text = match &blob.content {
        BlobContent::Text(text) => Some(text.as_str()),
        BlobContent::Binary(_) | BlobContent::Ydoc(_) => None,
    };
    verified.persist(store, text, faults)
}

fn check_ceiling(kind: BlobKind, observed_bytes: usize) -> Result<(), SyncError> {
    let (constraint, limit_bytes) = blob_ceiling(kind);
    if observed_bytes > limit_bytes {
        return Err(SyncError::BlobTooLarge {
            constraint,
            limit_bytes,
            observed_bytes,
        });
    }
    Ok(())
}

/// Borrows an immutable response after its digest has been checked once.
pub(crate) struct VerifiedBlob<'a> {
    sha256: &'a str,
    bytes: &'a [u8],
}

impl<'a> VerifiedBlob<'a> {
    pub(crate) fn verify(sha256: &'a str, bytes: &'a [u8]) -> Result<Self, SyncError> {
        if hex_sha256(bytes) != sha256 {
            return Err(SyncError::BlobInvalid);
        }
        Ok(Self { sha256, bytes })
    }

    pub(crate) fn hydrate(
        &self,
        store: &mut EngineStore,
        kind: BlobKind,
        faults: &dyn FaultInjector,
    ) -> Result<TxnOutcome<()>, SyncError> {
        // Relay text decoding precedes the per-kind ceiling, as in owned ingestion.
        let text = match kind {
            BlobKind::Text => {
                Some(std::str::from_utf8(self.bytes).map_err(|_| SyncError::BlobInvalid)?)
            }
            BlobKind::Binary | BlobKind::Ydoc => None,
        };
        check_ceiling(kind, self.bytes.len())?;
        self.persist(store, text, faults)
    }

    fn persist(
        &self,
        store: &mut EngineStore,
        text: Option<&str>,
        faults: &dyn FaultInjector,
    ) -> Result<TxnOutcome<()>, SyncError> {
        let sha256 = self.sha256;
        let bytes = self.bytes;
        let outcome = store.write_with(faults, |tx| {
            match text {
                Some(text) => {
                    let existing: Option<(i64, String)> = tx
                        .query_row(
                            "SELECT byte_length,text FROM blobs WHERE sha256=?1",
                            [sha256],
                            |row| Ok((row.get(0)?, row.get(1)?)),
                        )
                        .optional()
                        .map_err(SyncError::corrupt)?;
                    let byte_length =
                        i64::try_from(text.len()).map_err(|_| SyncError::BlobInvalid)?;
                    if let Some((stored_len, stored)) = existing {
                        if stored_len != byte_length || stored != text {
                            return Err(SyncError::BlobInvalid);
                        }
                    } else {
                        tx.execute(
                            "INSERT INTO blobs (sha256,byte_length,text) VALUES (?1,?2,?3)",
                            params![sha256, byte_length, text],
                        )
                        .map_err(SyncError::persist)?;
                    }
                }
                // A Y.Doc payload shares `binary_blobs` with a captured file: the
                // table is content-addressed and kind-free. Only the CEILING is
                // per-kind, and that was already applied above.
                None => {
                    let existing: Option<(i64, Vec<u8>)> = tx
                        .query_row(
                            "SELECT byte_length,bytes FROM binary_blobs WHERE sha256=?1",
                            [sha256],
                            |row| Ok((row.get(0)?, row.get(1)?)),
                        )
                        .optional()
                        .map_err(SyncError::corrupt)?;
                    let byte_length =
                        i64::try_from(bytes.len()).map_err(|_| SyncError::BlobInvalid)?;
                    if let Some((stored_len, stored)) = existing {
                        if stored_len != byte_length || stored.as_slice() != bytes {
                            return Err(SyncError::BlobInvalid);
                        }
                    } else {
                        tx.execute(
                            "INSERT INTO binary_blobs (sha256,byte_length,bytes) VALUES (?1,?2,?3)",
                            params![sha256, byte_length, bytes],
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
}

#[cfg(test)]
mod tests {
    use super::*;
    use dohc_engine_storage::NoFaults;
    use dohc_engine_testkit::open_store;

    #[test]
    fn public_hydration_still_rejects_wrong_digests_for_every_kind() {
        let (_scratch, _path, mut store) = open_store();
        for content in [
            BlobContent::Text("body".to_owned()),
            BlobContent::Binary(b"body".to_vec()),
            BlobContent::Ydoc(b"body".to_vec()),
        ] {
            assert!(matches!(
                hydrate_blob_content(
                    &mut store,
                    &BlobHydration {
                        sha256: hex_sha256(b"other"),
                        content,
                    },
                    &NoFaults
                ),
                Err(SyncError::BlobInvalid)
            ));
        }
    }

    #[test]
    fn verified_hydration_checks_utf8_and_each_requested_kind_ceiling() {
        let (_scratch, _path, mut store) = open_store();
        let bytes = [0xff];
        let sha256 = hex_sha256(&bytes);
        let blob = VerifiedBlob::verify(&sha256, &bytes).expect("valid digest");
        assert!(matches!(
            blob.hydrate(&mut store, BlobKind::Text, &NoFaults),
            Err(SyncError::BlobInvalid)
        ));
        assert_eq!(
            blob.hydrate(&mut store, BlobKind::Binary, &NoFaults)
                .expect("binary"),
            TxnOutcome::Committed(())
        );
        let bytes = vec![b'a'; MAX_TEXT_BYTES + 1];
        let sha256 = hex_sha256(&bytes);
        let blob = VerifiedBlob::verify(&sha256, &bytes).expect("valid digest");
        assert!(matches!(
            blob.hydrate(&mut store, BlobKind::Text, &NoFaults),
            Err(SyncError::BlobTooLarge {
                constraint: "MAX_TEXT_BYTES",
                ..
            })
        ));
        let mut bytes = bytes;
        bytes[0] = 0xff;
        let sha256 = hex_sha256(&bytes);
        let blob = VerifiedBlob::verify(&sha256, &bytes).expect("valid digest");
        assert!(
            matches!(
                blob.hydrate(&mut store, BlobKind::Text, &NoFaults),
                Err(SyncError::BlobInvalid)
            ),
            "invalid UTF-8 still precedes the per-kind ceiling"
        );
    }

    #[test]
    fn verified_hydration_rejects_poisoned_rows_without_replacing_them() {
        for kind in [BlobKind::Text, BlobKind::Binary, BlobKind::Ydoc] {
            for wrong_length in [false, true] {
                let (_scratch, _path, mut store) = open_store();
                let bytes = b"body";
                let sha256 = hex_sha256(bytes);
                let stored = if wrong_length { b"body" } else { b"fake" };
                let length = if wrong_length { 99 } else { 4 };
                store
                    .read_with(|conn| match kind {
                        BlobKind::Text => conn.execute(
                            "INSERT INTO blobs(sha256,byte_length,text) VALUES (?1,?2,?3)",
                            params![sha256, length, std::str::from_utf8(stored).expect("text")],
                        ),
                        BlobKind::Binary | BlobKind::Ydoc => conn.execute(
                            "INSERT INTO binary_blobs(sha256,byte_length,bytes) VALUES (?1,?2,?3)",
                            params![sha256, length, stored.as_slice()],
                        ),
                    })
                    .expect("seed poisoned row");
                let blob = VerifiedBlob::verify(&sha256, bytes).expect("valid digest");
                assert!(matches!(
                    blob.hydrate(&mut store, kind, &NoFaults),
                    Err(SyncError::BlobInvalid)
                ));
                store
                    .read_with(|conn| {
                        let (actual_length, actual): (i64, Vec<u8>) = match kind {
                            BlobKind::Text => conn.query_row(
                                "SELECT byte_length,CAST(text AS BLOB) FROM blobs WHERE sha256=?1",
                                [&sha256],
                                |row| Ok((row.get(0)?, row.get(1)?)),
                            ),
                            BlobKind::Binary | BlobKind::Ydoc => conn.query_row(
                                "SELECT byte_length,bytes FROM binary_blobs WHERE sha256=?1",
                                [&sha256],
                                |row| Ok((row.get(0)?, row.get(1)?)),
                            ),
                        }?;
                        assert_eq!(actual_length, length);
                        assert_eq!(actual, stored);
                        Ok::<_, rusqlite::Error>(())
                    })
                    .expect("poison unchanged");
            }
        }
    }
}
