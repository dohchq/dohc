use crate::error::DomainError;
use dohc_engine_storage::hex;
use rusqlite::{Connection, OptionalExtension, params};
use sha2::{Digest, Sha256};

/// A prior request recovered from the idempotency ledger.
pub(crate) struct RecordedRequest {
    pub(crate) payload_hash: String,
    pub(crate) result_seq: i64,
}

pub(crate) fn lookup_request(
    conn: &Connection,
    request_id: &str,
) -> Result<Option<RecordedRequest>, DomainError> {
    conn.query_row(
        "SELECT payload_hash, result_seq FROM engine_requests WHERE request_id = ?1",
        params![request_id],
        |row| {
            Ok(RecordedRequest {
                payload_hash: row.get(0)?,
                result_seq: row.get(1)?,
            })
        },
    )
    .optional()
    .map_err(DomainError::sql_corrupt)
}

pub(crate) fn record_request(
    tx: &Connection,
    request_id: Option<&str>,
    payload_hash: &str,
    result_seq: i64,
    now_ms: i64,
) -> Result<(), DomainError> {
    if let Some(request_id) = request_id {
        tx.execute(
            "INSERT INTO engine_requests \
             (request_id, payload_hash, result_seq, committed_at, kind) \
             VALUES (?1, ?2, ?3, ?4, 'versioned')",
            params![request_id, payload_hash, result_seq, now_ms],
        )
        .map_err(DomainError::sql_persist)?;
    }
    Ok(())
}

pub(crate) fn record_merge_request(
    tx: &Connection,
    request_id: Option<&str>,
    payload_hash: &str,
    result_seq: i64,
    now_ms: i64,
) -> Result<(), DomainError> {
    if let Some(request_id) = request_id {
        tx.execute(
            "INSERT INTO engine_requests \
             (request_id, payload_hash, result_seq, committed_at, kind) \
             VALUES (?1, ?2, ?3, ?4, 'merge')",
            params![request_id, payload_hash, result_seq, now_ms],
        )
        .map_err(DomainError::sql_persist)?;
    }
    Ok(())
}

/// Deterministic fingerprint over length-framed fields (idempotency
/// payloads). Length framing means a NUL or any other byte inside a
/// caller-supplied field can never shift field boundaries and collide two
/// different payloads.
pub(crate) fn hash_fields(fields: &[&[u8]]) -> String {
    let mut hasher = Sha256::new();
    for field in fields {
        hasher.update((field.len() as u64).to_le_bytes());
        hasher.update(field);
    }
    hex(&hasher.finalize())
}

pub(crate) fn hash_author_fields(author_json: Option<&str>) -> (&'static [u8], &[u8]) {
    match author_json {
        Some(author_json) => (b"some", author_json.as_bytes()),
        None => (b"none", b""),
    }
}

pub(crate) fn hash_optional_text_fields(value: Option<&str>) -> (&'static [u8], &[u8]) {
    match value {
        Some(value) => (b"some", value.as_bytes()),
        None => (b"none", b""),
    }
}
