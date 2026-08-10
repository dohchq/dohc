use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use dohc_engine_domain::{SecretMomentRecord, VersionRecord};
use dohc_engine_storage::{StorageError, hex_sha256};
use rusqlite::{Transaction, params};

use crate::{SyncError, journal_local_op_in_tx};

struct MomentPayloadRow {
    moment_id: String,
    version_id: String,
    object_id: String,
    object_created_at_ms: i64,
    path: String,
    recorded_at_ms: i64,
    operation: String,
    payload_before_blob_sha256: Option<String>,
    payload_before_path: Option<String>,
    payload_after_blob_sha256: String,
    payload_after_path: String,
    payload_before_content_kind: Option<String>,
    payload_before_byte_length: Option<i64>,
    payload_after_content_kind: Option<String>,
    payload_after_byte_length: Option<i64>,
    metadata_origin: String,
    metadata_summary: Option<String>,
    metadata_correlation_id: Option<String>,
    author_json: Option<String>,
    before_present: i64,
    before_object_id: Option<String>,
    before_version_id: Option<String>,
    before_path: Option<String>,
    before_blob_sha256: Option<String>,
    before_content_kind: Option<String>,
    before_byte_length: Option<i64>,
    before_updated_at_ms: Option<i64>,
    before_latest_moment_id: Option<String>,
    before_metadata_origin: Option<String>,
    before_metadata_summary: Option<String>,
    before_metadata_correlation_id: Option<String>,
}

/// Project one committed domain moment into the relay-visible log.
///
/// The caller must check [`crate::workspace_replicates_with_relay_in_tx`]
/// before this function because the local journal requires a sync identity.
pub fn journal_moment_append_in_tx(
    tx: &Transaction<'_>,
    workspace_id: &str,
    moment_id: &str,
) -> Result<(), SyncError> {
    let row = tx
        .query_row(
            "SELECT m.moment_id, m.version_id, m.object_id, o.created_at_ms, m.path, \
                    m.recorded_at_ms, m.operation, m.payload_before_blob_sha256, \
                    m.payload_before_path, m.payload_after_blob_sha256, m.payload_after_path, \
                    m.payload_before_content_kind, \
                    CASE m.payload_before_content_kind \
                      WHEN 'binary' THEN (SELECT byte_length FROM binary_blobs WHERE sha256=m.payload_before_blob_sha256) \
                      ELSE (SELECT byte_length FROM blobs WHERE sha256=m.payload_before_blob_sha256) END, \
                    m.payload_after_content_kind, \
                    CASE m.payload_after_content_kind \
                      WHEN 'binary' THEN (SELECT byte_length FROM binary_blobs WHERE sha256=m.payload_after_blob_sha256) \
                      ELSE (SELECT byte_length FROM blobs WHERE sha256=m.payload_after_blob_sha256) END, \
                    m.metadata_origin, m.metadata_summary, m.metadata_correlation_id, \
                    m.author_json, m.before_present, \
                    COALESCE(m.before_object_id, CASE WHEN m.before_present=2 THEN m.object_id END), \
                    COALESCE(m.before_version_id, CASE WHEN m.before_present=2 THEN m.version_id END), \
                    COALESCE(m.before_path, m.payload_before_path), \
                    m.payload_before_blob_sha256, m.payload_before_content_kind, \
                    CASE m.payload_before_content_kind \
                      WHEN 'binary' THEN (SELECT byte_length FROM binary_blobs WHERE sha256=m.payload_before_blob_sha256) \
                      ELSE (SELECT byte_length FROM blobs WHERE sha256=m.payload_before_blob_sha256) END, \
                    COALESCE(m.before_updated_at_ms, \
                      (SELECT p.recorded_at_ms FROM moments p WHERE p.workspace_id=m.workspace_id AND p.moment_id=m.before_latest_moment_id), \
                      (SELECT f.updated_at_ms FROM fork_base_snapshots f WHERE f.workspace_id=m.workspace_id AND f.version_id=m.version_id AND f.object_id=m.object_id AND f.latest_moment_id=m.before_latest_moment_id)), \
                    m.before_latest_moment_id, \
                    COALESCE(m.before_metadata_origin, \
                      (SELECT p.metadata_origin FROM moments p WHERE p.workspace_id=m.workspace_id AND p.moment_id=m.before_latest_moment_id), \
                      (SELECT f.metadata_origin FROM fork_base_snapshots f WHERE f.workspace_id=m.workspace_id AND f.version_id=m.version_id AND f.object_id=m.object_id AND f.latest_moment_id=m.before_latest_moment_id)), \
                    COALESCE(m.before_metadata_summary, \
                      (SELECT p.metadata_summary FROM moments p WHERE p.workspace_id=m.workspace_id AND p.moment_id=m.before_latest_moment_id), \
                      (SELECT f.metadata_summary FROM fork_base_snapshots f WHERE f.workspace_id=m.workspace_id AND f.version_id=m.version_id AND f.object_id=m.object_id AND f.latest_moment_id=m.before_latest_moment_id)), \
                    COALESCE(m.before_metadata_correlation_id, \
                      (SELECT p.metadata_correlation_id FROM moments p WHERE p.workspace_id=m.workspace_id AND p.moment_id=m.before_latest_moment_id), \
                      (SELECT f.metadata_correlation_id FROM fork_base_snapshots f WHERE f.workspace_id=m.workspace_id AND f.version_id=m.version_id AND f.object_id=m.object_id AND f.latest_moment_id=m.before_latest_moment_id)) \
             FROM moments m JOIN file_objects o ON o.workspace_id=m.workspace_id AND o.object_id=m.object_id \
             WHERE m.workspace_id=?1 AND m.moment_id=?2",
            params![workspace_id, moment_id],
            |row| {
                Ok(MomentPayloadRow {
                    moment_id: row.get(0)?,
                    version_id: row.get(1)?,
                    object_id: row.get(2)?,
                    object_created_at_ms: row.get(3)?,
                    path: row.get(4)?,
                    recorded_at_ms: row.get(5)?,
                    operation: row.get(6)?,
                    payload_before_blob_sha256: row.get(7)?,
                    payload_before_path: row.get(8)?,
                    payload_after_blob_sha256: row.get(9)?,
                    payload_after_path: row.get(10)?,
                    payload_before_content_kind: row.get(11)?,
                    payload_before_byte_length: row.get(12)?,
                    payload_after_content_kind: row.get(13)?,
                    payload_after_byte_length: row.get(14)?,
                    metadata_origin: row.get(15)?,
                    metadata_summary: row.get(16)?,
                    metadata_correlation_id: row.get(17)?,
                    author_json: row.get(18)?,
                    before_present: row.get(19)?,
                    before_object_id: row.get(20)?,
                    before_version_id: row.get(21)?,
                    before_path: row.get(22)?,
                    before_blob_sha256: row.get(23)?,
                    before_content_kind: row.get(24)?,
                    before_byte_length: row.get(25)?,
                    before_updated_at_ms: row.get(26)?,
                    before_latest_moment_id: row.get(27)?,
                    before_metadata_origin: row.get(28)?,
                    before_metadata_summary: row.get(29)?,
                    before_metadata_correlation_id: row.get(30)?,
                })
            },
        )
        .map_err(SyncError::corrupt)?;
    let author = row
        .author_json
        .as_deref()
        .map(serde_json::from_str::<serde_json::Value>)
        .transpose()
        .map_err(|_| SyncError::InvalidInput {
            reason: "stored moment author is malformed",
        })?;
    let before_metadata = row.before_metadata_origin.as_ref().map(|origin| {
        serde_json::json!({
            "origin": replicated_moment_origin(origin),
            "summary": row.before_metadata_summary,
            "correlationId": row.before_metadata_correlation_id,
        })
    });
    let payload = serde_json::json!({
        "momentId": row.moment_id,
        "versionId": row.version_id,
        "objectId": row.object_id,
        "objectCreatedAtMs": row.object_created_at_ms,
        "path": row.path,
        "recordedAtMs": row.recorded_at_ms,
        "operation": row.operation,
        "payloadBeforeBlobSha256": row.payload_before_blob_sha256,
        "payloadBeforePath": row.payload_before_path,
        "payloadAfterBlobSha256": row.payload_after_blob_sha256,
        "payloadAfterPath": row.payload_after_path,
        "payloadBeforeContentKind": row.payload_before_content_kind,
        "payloadBeforeByteLength": row.payload_before_byte_length,
        "payloadAfterContentKind": row.payload_after_content_kind,
        "payloadAfterByteLength": row.payload_after_byte_length,
        "metadata": {
            "origin": replicated_moment_origin(&row.metadata_origin),
            "summary": row.metadata_summary,
            "correlationId": row.metadata_correlation_id,
        },
        "author": author,
        "beforePresent": if row.before_present == 2 { "present" } else { "null" },
        "beforeObjectId": row.before_object_id,
        "beforeVersionId": row.before_version_id,
        "beforePath": row.before_path,
        "beforeBlobSha256": row.before_blob_sha256,
        "beforeContentKind": row.before_content_kind,
        "beforeByteLength": row.before_byte_length,
        "beforeUpdatedAtMs": row.before_updated_at_ms,
        "beforeLatestMomentId": row.before_latest_moment_id,
        "beforeMetadata": before_metadata,
    });
    journal_local_op_in_tx(
        tx,
        workspace_id,
        "moment.append",
        &payload,
        row.recorded_at_ms,
    )
    .map(|_| ())
}

/// Project one committed named-version fork into the relay-visible log.
pub fn journal_version_create_in_tx(
    tx: &Transaction<'_>,
    record: &VersionRecord,
) -> Result<(), SyncError> {
    let mut statement = tx
        .prepare(
            "SELECT s.object_id, o.created_at_ms, s.path, s.content_kind, \
                    CASE s.content_kind WHEN 'binary' THEN s.binary_sha256 ELSE s.blob_sha256 END, \
                    s.updated_at_ms, s.latest_moment_id, s.metadata_origin, \
                    s.metadata_summary, s.metadata_correlation_id \
             FROM snapshots s JOIN file_objects o \
               ON o.workspace_id=s.workspace_id AND o.object_id=s.object_id \
             WHERE s.workspace_id=?1 AND s.version_id=?2 ORDER BY s.path",
        )
        .map_err(SyncError::corrupt)?;
    let fork_snapshots = statement
        .query_map(params![record.workspace_id, record.version_id], |row| {
            Ok(serde_json::json!({
                "objectId": row.get::<_, String>(0)?,
                "objectCreatedAtMs": row.get::<_, i64>(1)?,
                "path": row.get::<_, String>(2)?,
                "contentKind": row.get::<_, String>(3)?,
                "blobSha256": row.get::<_, String>(4)?,
                "updatedAtMs": row.get::<_, i64>(5)?,
                "latestMomentId": row.get::<_, String>(6)?,
                "metadata": {
                    "origin": row.get::<_, String>(7)?,
                    "summary": row.get::<_, Option<String>>(8)?,
                    "correlationId": row.get::<_, Option<String>>(9)?,
                },
            }))
        })
        .map_err(SyncError::corrupt)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(SyncError::corrupt)?;
    let payload = serde_json::json!({
        "versionId": record.version_id,
        "name": record.name,
        "kind": record.kind.as_str(),
        "forkVersionId": record.fork_version_id,
        "forkMomentId": record.fork_moment_id,
        "createdAtMs": record.created_at_ms,
        "forkSnapshots": fork_snapshots,
    });
    journal_local_op_in_tx(
        tx,
        &record.workspace_id,
        "version.create",
        &payload,
        record.created_at_ms,
    )
    .map(|_| ())
}

/// Project one committed secret put into the relay-visible log.
pub fn journal_secret_put_in_tx(
    tx: &Transaction<'_>,
    moment: &SecretMomentRecord,
) -> Result<(), SyncError> {
    let (iv_base64, auth_tag_base64, ciphertext_base64, byte_length) = tx
        .query_row(
            "SELECT iv_base64, auth_tag_base64, ciphertext_base64, byte_length \
             FROM secret_files WHERE workspace_id=?1 AND version_id=?2 AND path=?3",
            params![moment.workspace_id, moment.version_id, moment.path],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                ))
            },
        )
        .map_err(SyncError::corrupt)?;
    let ciphertext = decode_stored_ciphertext(&ciphertext_base64)?;
    let payload = serde_json::json!({
        "versionId": moment.version_id,
        "path": moment.path,
        "metadata": secret_metadata(moment),
        "ivBase64": iv_base64,
        "authTagBase64": auth_tag_base64,
        "ciphertextSha256": hex_sha256(&ciphertext),
        "byteLength": byte_length,
    });
    journal_local_op_in_tx(
        tx,
        &moment.workspace_id,
        "secret.file.put",
        &payload,
        moment.recorded_at_ms,
    )
    .map(|_| ())
}

/// Project one committed secret delete into the relay-visible log.
pub fn journal_secret_delete_in_tx(
    tx: &Transaction<'_>,
    moment: &SecretMomentRecord,
) -> Result<(), SyncError> {
    let payload = serde_json::json!({
        "versionId": moment.version_id,
        "path": moment.path,
        "metadata": secret_metadata(moment),
    });
    journal_local_op_in_tx(
        tx,
        &moment.workspace_id,
        "secret.file.delete",
        &payload,
        moment.recorded_at_ms,
    )
    .map(|_| ())
}

/// Project one committed secret-version fork into the relay-visible log.
pub fn journal_secret_version_fork_in_tx(
    tx: &Transaction<'_>,
    workspace_id: &str,
    from_version_id: &str,
    to_version_id: &str,
    recorded_at_ms: i64,
) -> Result<(), SyncError> {
    let mut statement = tx
        .prepare(
            "SELECT path, iv_base64, auth_tag_base64, ciphertext_base64, byte_length, \
                    updated_at_ms, latest_moment_id FROM secret_files \
             WHERE workspace_id=?1 AND version_id=?2 ORDER BY path",
        )
        .map_err(SyncError::corrupt)?;
    let stored = statement
        .query_map(params![workspace_id, to_version_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, i64>(5)?,
                row.get::<_, String>(6)?,
            ))
        })
        .map_err(SyncError::corrupt)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(SyncError::corrupt)?;
    if stored.is_empty() {
        return Ok(());
    }
    let rows = stored
        .into_iter()
        .map(
            |(
                path,
                iv_base64,
                auth_tag_base64,
                ciphertext_base64,
                byte_length,
                updated_at_ms,
                latest_moment_id,
            )| {
                let ciphertext = decode_stored_ciphertext(&ciphertext_base64)?;
                Ok(serde_json::json!({
                    "path": path,
                    "ivBase64": iv_base64,
                    "authTagBase64": auth_tag_base64,
                    "ciphertextSha256": hex_sha256(&ciphertext),
                    "byteLength": byte_length,
                    "updatedAtMs": updated_at_ms,
                    "latestMomentId": latest_moment_id,
                }))
            },
        )
        .collect::<Result<Vec<_>, SyncError>>()?;
    let payload = serde_json::json!({
        "toVersionId": to_version_id,
        "fromVersionId": from_version_id,
        "rows": rows,
    });
    journal_local_op_in_tx(
        tx,
        workspace_id,
        "secret.version.fork",
        &payload,
        recorded_at_ms,
    )
    .map(|_| ())
}

fn secret_metadata(moment: &SecretMomentRecord) -> serde_json::Value {
    serde_json::json!({
        "origin": moment.metadata_origin,
        "summary": moment.metadata_summary,
        "correlationId": moment.metadata_correlation_id,
    })
}

fn decode_stored_ciphertext(encoded: &str) -> Result<Vec<u8>, SyncError> {
    STANDARD.decode(encoded).map_err(|_| {
        SyncError::Storage(StorageError::corrupt_public(std::io::Error::other(
            "stored secret ciphertext is malformed",
        )))
    })
}

fn replicated_moment_origin(origin: &str) -> &str {
    match origin {
        "capture" | "ydoc" => "local-file",
        other => other,
    }
}
