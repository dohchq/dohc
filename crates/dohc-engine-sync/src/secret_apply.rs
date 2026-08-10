use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use dohc_engine_domain::{MAX_SECRET_FILE_BYTES, SECRET_IV_BYTES, SECRET_TAG_BYTES};
use dohc_engine_files::{PathClassification, classify_engine_file_path_normalized};
use dohc_engine_storage::{EngineStore, FaultInjector, StorageError};
use rusqlite::{OptionalExtension, Transaction, params};
use serde::Deserialize;
use std::collections::HashSet;

use crate::{ApplyOutcome, ReplicationEnvelope, SyncError};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Metadata {
    origin: String,
    summary: Option<String>,
    correlation_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SecretPut {
    version_id: String,
    path: String,
    metadata: Metadata,
    iv_base64: String,
    auth_tag_base64: String,
    ciphertext_sha256: String,
    byte_length: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SecretDelete {
    version_id: String,
    path: String,
    metadata: Metadata,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SecretFork {
    to_version_id: String,
    from_version_id: String,
    chunk_index: usize,
    total_rows: usize,
    rows: Vec<SecretForkRow>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SecretForkRow {
    path: String,
    iv_base64: String,
    auth_tag_base64: String,
    ciphertext_sha256: String,
    byte_length: i64,
    updated_at_ms: i64,
    latest_moment_id: String,
}

pub fn apply_secret_envelope(
    store: &mut EngineStore,
    envelope: &ReplicationEnvelope,
    faults: &dyn FaultInjector,
) -> Result<ApplyOutcome<()>, SyncError> {
    if !matches!(
        envelope.op_kind.as_str(),
        "secret.file.put" | "secret.file.delete" | "secret.version.fork"
    ) {
        return Err(SyncError::UnsupportedOperation);
    }
    crate::apply_envelope_with(store, envelope, faults, |tx, op| {
        match op.op_kind.as_str() {
            "secret.file.put" => apply_put(tx, op, decode(&op.payload)?),
            "secret.file.delete" => apply_delete(tx, op, decode(&op.payload)?),
            "secret.version.fork" => apply_fork(tx, op, decode(&op.payload)?),
            _ => Err(SyncError::UnsupportedOperation),
        }
    })
}

fn decode<T: for<'de> Deserialize<'de>>(value: &serde_json::Value) -> Result<T, SyncError> {
    serde_json::from_value(value.clone()).map_err(|_| SyncError::InvalidInput {
        reason: "secret replication payload is malformed",
    })
}

fn validate_common(
    tx: &Transaction<'_>,
    op: &ReplicationEnvelope,
    version_id: &str,
    path: &str,
    metadata: &Metadata,
) -> Result<(), SyncError> {
    crate::model::bounded(
        version_id,
        "secret version_id must be non-empty and bounded",
    )?;
    validate_canonical_secret_path(path)?;
    if !matches!(
        metadata.origin.as_str(),
        "api" | "local-file" | "restore" | "sync" | "unknown"
    ) {
        return Err(SyncError::InvalidInput {
            reason: "secret metadata origin is invalid",
        });
    }
    let version_exists: bool = tx
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM versions WHERE workspace_id=?1 AND version_id=?2)",
            params![op.workspace_id, version_id],
            |row| row.get(0),
        )
        .map_err(SyncError::corrupt)?;
    if !version_exists {
        return Err(SyncError::RetryableState {
            reason: "secret target version is missing",
        });
    }
    Ok(())
}

fn validate_canonical_secret_path(path: &str) -> Result<(), SyncError> {
    let (classification, normalized) = classify_engine_file_path_normalized(path);
    if classification != PathClassification::Secret {
        return Err(SyncError::InvalidInput {
            reason: "secret replication path is not secret-classified",
        });
    }
    if normalized.as_deref() != Some(path) {
        return Err(SyncError::InvalidInput {
            reason: "secret replication path must be canonical",
        });
    }
    Ok(())
}

fn apply_put(
    tx: &Transaction<'_>,
    op: &ReplicationEnvelope,
    p: SecretPut,
) -> Result<(), SyncError> {
    validate_common(tx, op, &p.version_id, &p.path, &p.metadata)?;
    let iv = STANDARD
        .decode(&p.iv_base64)
        .map_err(|_| SyncError::InvalidInput {
            reason: "secret iv is invalid",
        })?;
    let tag = STANDARD
        .decode(&p.auth_tag_base64)
        .map_err(|_| SyncError::InvalidInput {
            reason: "secret auth tag is invalid",
        })?;
    if iv.len() != SECRET_IV_BYTES
        || tag.len() != SECRET_TAG_BYTES
        || !is_secret_byte_length(p.byte_length)
    {
        return Err(SyncError::InvalidInput {
            reason: "secret ciphertext metadata is invalid",
        });
    }
    let ciphertext = load_ciphertext(tx, &p.ciphertext_sha256, p.byte_length)?;
    let ciphertext_base64 = STANDARD.encode(ciphertext);
    insert_moment(
        tx,
        op,
        &p.version_id,
        &p.path,
        &p.metadata,
        Some((
            &p.iv_base64,
            &p.auth_tag_base64,
            &ciphertext_base64,
            p.byte_length,
        )),
    )
}

fn apply_delete(
    tx: &Transaction<'_>,
    op: &ReplicationEnvelope,
    p: SecretDelete,
) -> Result<(), SyncError> {
    validate_common(tx, op, &p.version_id, &p.path, &p.metadata)?;
    insert_moment(tx, op, &p.version_id, &p.path, &p.metadata, None)
}

fn apply_fork(
    tx: &Transaction<'_>,
    op: &ReplicationEnvelope,
    payload: SecretFork,
) -> Result<(), SyncError> {
    validate_fork_versions(tx, op, &payload.from_version_id, &payload.to_version_id)?;
    validate_fork_rows(&payload.rows, payload.total_rows)?;

    if payload.chunk_index == 0 {
        tx.execute(
            "DELETE FROM secret_files WHERE workspace_id=?1 AND version_id=?2",
            params![op.workspace_id, payload.to_version_id],
        )
        .map_err(SyncError::persist)?;
        tx.execute(
            "DELETE FROM secret_fork_bases WHERE workspace_id=?1 AND version_id=?2",
            params![op.workspace_id, payload.to_version_id],
        )
        .map_err(SyncError::persist)?;
    }
    insert_fork_rows(tx, op, &payload.to_version_id, payload.rows)
}

fn validate_fork_versions(
    tx: &Transaction<'_>,
    op: &ReplicationEnvelope,
    from_version_id: &str,
    to_version_id: &str,
) -> Result<(), SyncError> {
    crate::model::bounded(
        from_version_id,
        "secret fork source version id must be non-empty and bounded",
    )?;
    crate::model::bounded(
        to_version_id,
        "secret fork destination version id must be non-empty and bounded",
    )?;
    if from_version_id == to_version_id {
        return Err(SyncError::InvalidInput {
            reason: "secret fork source and destination must differ",
        });
    }
    require_version(tx, &op.workspace_id, from_version_id)?;
    require_version(tx, &op.workspace_id, to_version_id)
}

fn validate_fork_rows(rows: &[SecretForkRow], total_rows: usize) -> Result<(), SyncError> {
    if rows.len() > total_rows {
        return Err(SyncError::InvalidInput {
            reason: "secret fork chunk claims more rows than its declared total",
        });
    }
    for row in rows {
        validate_fork_row(row)?;
    }
    let mut seen = HashSet::with_capacity(rows.len());
    for row in rows {
        if !seen.insert(row.path.as_str()) {
            return Err(SyncError::InvalidInput {
                reason: "secret fork contains duplicate paths",
            });
        }
    }
    Ok(())
}

fn insert_fork_rows(
    tx: &Transaction<'_>,
    op: &ReplicationEnvelope,
    to_version_id: &str,
    rows: Vec<SecretForkRow>,
) -> Result<(), SyncError> {
    for (index, row) in rows.into_iter().enumerate() {
        let ciphertext = load_ciphertext(tx, &row.ciphertext_sha256, row.byte_length)?;
        let ciphertext_base64 = STANDARD.encode(ciphertext);
        let latest_moment_id = format!("secret-sync-{}-{}-{index}", op.origin_id, op.origin_seq);
        tx.execute(
            "INSERT INTO secret_files \
             (workspace_id,version_id,path,iv_base64,auth_tag_base64,ciphertext_base64,byte_length,updated_at_ms,latest_moment_id) \
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
            params![
                op.workspace_id,
                to_version_id,
                row.path,
                row.iv_base64,
                row.auth_tag_base64,
                ciphertext_base64,
                row.byte_length,
                row.updated_at_ms,
                latest_moment_id
            ],
        )
        .map_err(SyncError::persist)?;
        tx.execute(
            "INSERT INTO secret_fork_bases \
             (workspace_id,version_id,path,iv_base64,auth_tag_base64,ciphertext_base64,byte_length) \
             VALUES (?1,?2,?3,?4,?5,?6,?7)",
            params![
                op.workspace_id,
                to_version_id,
                row.path,
                row.iv_base64,
                row.auth_tag_base64,
                ciphertext_base64,
                row.byte_length
            ],
        )
        .map_err(SyncError::persist)?;
    }
    Ok(())
}

fn require_version(
    tx: &Transaction<'_>,
    workspace_id: &str,
    version_id: &str,
) -> Result<(), SyncError> {
    let exists: bool = tx
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM versions WHERE workspace_id=?1 AND version_id=?2)",
            params![workspace_id, version_id],
            |row| row.get(0),
        )
        .map_err(SyncError::corrupt)?;
    if !exists {
        return Err(SyncError::RetryableState {
            reason: "secret fork version is missing",
        });
    }
    Ok(())
}

fn validate_fork_row(row: &SecretForkRow) -> Result<(), SyncError> {
    validate_canonical_secret_path(&row.path)?;
    validate_base64(&row.iv_base64, SECRET_IV_BYTES, "secret fork iv is invalid")?;
    validate_base64(
        &row.auth_tag_base64,
        SECRET_TAG_BYTES,
        "secret fork auth tag is invalid",
    )?;
    if row.ciphertext_sha256.len() != 64
        || !row
            .ciphertext_sha256
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        || !is_secret_byte_length(row.byte_length)
        || row.latest_moment_id.is_empty()
    {
        return Err(SyncError::InvalidInput {
            reason: "secret fork row is malformed",
        });
    }
    Ok(())
}

/// The secret domain's own size cap, applied to every replicated byte length.
/// Secret ciphertext rides the shared binary-blob transport, whose 5 MiB limit
/// is far above this one; AES-GCM here is length-preserving (IV and tag travel
/// in their own fields), so the honest ciphertext length equals the plaintext
/// length and the domain cap applies unchanged.
fn is_secret_byte_length(byte_length: i64) -> bool {
    i64::try_from(MAX_SECRET_FILE_BYTES).is_ok_and(|max| (0..=max).contains(&byte_length))
}

fn validate_base64(
    encoded: &str,
    expected_len: usize,
    reason: &'static str,
) -> Result<(), SyncError> {
    let decoded = STANDARD
        .decode(encoded)
        .map_err(|_| SyncError::InvalidInput { reason })?;
    if decoded.len() != expected_len || STANDARD.encode(decoded) != encoded {
        return Err(SyncError::InvalidInput { reason });
    }
    Ok(())
}

fn load_ciphertext(
    tx: &Transaction<'_>,
    sha256: &str,
    byte_length: i64,
) -> Result<Vec<u8>, SyncError> {
    let (stored_len, ciphertext): (i64, Vec<u8>) = tx
        .query_row(
            "SELECT byte_length,bytes FROM binary_blobs WHERE sha256=?1",
            [sha256],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(SyncError::corrupt)?
        .ok_or(SyncError::BlobInvalid)?;
    if ciphertext.len() as i64 != stored_len {
        return Err(SyncError::Storage(StorageError::corrupt_public(
            std::io::Error::other("secret ciphertext blob length metadata is corrupt"),
        )));
    }
    if stored_len != byte_length {
        return Err(SyncError::InvalidInput {
            reason: "secret ciphertext blob does not match declared metadata",
        });
    }
    if dohc_engine_storage::hex_sha256(&ciphertext) != sha256 {
        return Err(SyncError::Storage(
            dohc_engine_storage::StorageError::BlobIntegrity {
                sha256: sha256.to_owned(),
            },
        ));
    }
    Ok(ciphertext)
}

#[allow(clippy::too_many_arguments)]
fn insert_moment(
    tx: &Transaction<'_>,
    op: &ReplicationEnvelope,
    version_id: &str,
    path: &str,
    metadata: &Metadata,
    after: Option<(&str, &str, &str, i64)>,
) -> Result<(), SyncError> {
    let previous: i64 = tx
        .query_row(
            "SELECT COALESCE(MAX(moment_order),0) FROM secret_moments WHERE workspace_id=?1",
            [&op.workspace_id],
            |row| row.get(0),
        )
        .map_err(SyncError::corrupt)?;
    let order = previous
        .checked_add(1)
        .ok_or(SyncError::CoordinateDiverged)?;
    let moment_id = format!("secret-sync-{}-{}", op.origin_id, op.origin_seq);
    let collision: bool = tx
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM moments \
                           WHERE workspace_id=?1 AND moment_id=?2) \
                 OR EXISTS(SELECT 1 FROM secret_moments \
                           WHERE workspace_id=?1 AND moment_id=?2)",
            params![op.workspace_id, moment_id],
            |row| row.get(0),
        )
        .map_err(SyncError::corrupt)?;
    if collision {
        return Err(SyncError::InvalidInput {
            reason: "replicated secret moment id collides with existing history",
        });
    }
    let (present, iv, tag, ciphertext, byte_length) = match after {
        Some((iv, tag, ciphertext, byte_length)) => (
            1_i64,
            Some(iv),
            Some(tag),
            Some(ciphertext),
            Some(byte_length),
        ),
        None => (0_i64, None, None, None, None),
    };
    let inserted = tx
        .execute(
        "INSERT OR IGNORE INTO secret_moments \
         (workspace_id,moment_order,moment_id,version_id,path,recorded_at_ms,operation,metadata_origin,metadata_summary,metadata_correlation_id,after_present,after_iv_base64,after_auth_tag_base64,after_ciphertext_base64,after_byte_length) \
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)",
        params![op.workspace_id,order,moment_id,version_id,path,op.recorded_at_ms,if present == 1 { "write" } else { "delete" },metadata.origin,metadata.summary,metadata.correlation_id,present,iv,tag,ciphertext,byte_length],
    )
        .map_err(SyncError::persist)?;
    // Legitimate redelivery is resolved by `apply_envelope_with` against the
    // atomic replication log before this mutation runs. Reaching this insert
    // with an occupied synthesized ID therefore means unrelated local history
    // already owns the ID; do not let the tip reference that row.
    if inserted == 0 {
        return Err(SyncError::InvalidInput {
            reason: "replicated secret moment id collides with existing history",
        });
    }
    if remote_wins(tx, op, version_id, path, after)? {
        if let Some((iv, tag, ciphertext, byte_length)) = after {
            tx.execute(
                "INSERT INTO secret_files \
                 (workspace_id,version_id,path,iv_base64,auth_tag_base64,ciphertext_base64,byte_length,updated_at_ms,latest_moment_id) \
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9) ON CONFLICT(workspace_id,version_id,path) DO UPDATE SET \
                 iv_base64=excluded.iv_base64,auth_tag_base64=excluded.auth_tag_base64,ciphertext_base64=excluded.ciphertext_base64,
                 byte_length=excluded.byte_length,updated_at_ms=excluded.updated_at_ms,latest_moment_id=excluded.latest_moment_id",
                params![op.workspace_id,version_id,path,iv,tag,ciphertext,byte_length,op.recorded_at_ms,moment_id],
            )
            .map_err(SyncError::persist)?;
        } else {
            tx.execute(
                "DELETE FROM secret_files WHERE workspace_id=?1 AND version_id=?2 AND path=?3",
                params![op.workspace_id, version_id, path],
            )
            .map_err(SyncError::persist)?;
        }
    }
    Ok(())
}

fn remote_wins(
    tx: &Transaction<'_>,
    op: &ReplicationEnvelope,
    version_id: &str,
    path: &str,
    after: Option<(&str, &str, &str, i64)>,
) -> Result<bool, SyncError> {
    // Rank against the latest `secret_moments` row for the path — delete
    // TOMBSTONES INCLUDED — never the materialized `secret_files` tip, which is
    // gone after a winning delete and would let a later older put resurrect a
    // deleted secret. Deterministic content rank
    // (recorded_at_ms, after_present, ciphertext, iv, tag), mirroring
    // secretFileStore.ts. The incoming moment is already in the table, so
    // `incoming >= latest` materializes iff incoming is the winner (>= keeps a
    // byte-identical redelivery idempotent).
    let latest: Option<(i64, i64, String, String, String)> = tx
        .query_row(
            "SELECT recorded_at_ms,after_present,COALESCE(after_ciphertext_base64,''),COALESCE(after_iv_base64,''),COALESCE(after_auth_tag_base64,'') \
             FROM secret_moments \
             WHERE workspace_id=?1 AND version_id=?2 AND path=?3 \
             ORDER BY recorded_at_ms DESC, after_present DESC, \
               COALESCE(after_ciphertext_base64,'') DESC, \
               COALESCE(after_iv_base64,'') DESC, \
               COALESCE(after_auth_tag_base64,'') DESC \
             LIMIT 1",
            params![op.workspace_id, version_id, path],
            |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?)),
        )
        .optional()
        .map_err(SyncError::corrupt)?;
    let Some(latest) = latest else {
        return Ok(true);
    };
    let incoming = match after {
        Some((iv, tag, ciphertext, _)) => (op.recorded_at_ms, 1_i64, ciphertext, iv, tag),
        None => (op.recorded_at_ms, 0_i64, "", "", ""),
    };
    Ok(incoming
        >= (
            latest.0,
            latest.1,
            latest.2.as_str(),
            latest.3.as_str(),
            latest.4.as_str(),
        ))
}
