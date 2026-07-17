use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use dohc_engine_storage::{EngineStore, FaultInjector};
use rusqlite::{OptionalExtension, Transaction, params};
use serde::Deserialize;

use crate::{ApplyOutcome, PathClass, ReplicationEnvelope, SyncError};

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

pub fn apply_secret_envelope(
    store: &mut EngineStore,
    envelope: &ReplicationEnvelope,
    faults: &dyn FaultInjector,
) -> Result<ApplyOutcome<()>, SyncError> {
    if !matches!(
        envelope.op_kind.as_str(),
        "secret.file.put" | "secret.file.delete"
    ) {
        return Err(SyncError::UnsupportedOperation);
    }
    crate::apply_envelope_with(store, envelope, faults, |tx, op| {
        match op.op_kind.as_str() {
            "secret.file.put" => apply_put(tx, op, decode(&op.payload)?),
            "secret.file.delete" => apply_delete(tx, op, decode(&op.payload)?),
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
    if crate::classify_share_path(path) != PathClass::Secret {
        return Err(SyncError::InvalidInput {
            reason: "secret replication path is not secret-classified",
        });
    }
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
        return Err(SyncError::InvalidInput {
            reason: "secret target version is missing",
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
    if iv.len() != 12 || tag.len() != 16 || p.byte_length < 0 {
        return Err(SyncError::InvalidInput {
            reason: "secret ciphertext metadata is invalid",
        });
    }
    let (stored_len, ciphertext): (i64, Vec<u8>) = tx
        .query_row(
            "SELECT byte_length,bytes FROM binary_blobs WHERE sha256=?1",
            [&p.ciphertext_sha256],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(SyncError::corrupt)?
        .ok_or(SyncError::BlobInvalid)?;
    if stored_len != p.byte_length
        || dohc_engine_storage::hex_sha256(&ciphertext) != p.ciphertext_sha256
    {
        return Err(SyncError::BlobInvalid);
    }
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
    tx.execute(
        "INSERT OR IGNORE INTO secret_moments \
         (workspace_id,moment_order,moment_id,version_id,path,recorded_at_ms,operation,metadata_origin,metadata_summary,metadata_correlation_id,after_present,after_iv_base64,after_auth_tag_base64,after_ciphertext_base64,after_byte_length) \
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)",
        params![op.workspace_id,order,moment_id,version_id,path,op.recorded_at_ms,if present == 1 { "write" } else { "delete" },metadata.origin,metadata.summary,metadata.correlation_id,present,iv,tag,ciphertext,byte_length],
    )
    .map_err(SyncError::persist)?;
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
