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
                    COALESCE(m.before_updated_at_ms, p.recorded_at_ms, f.updated_at_ms), \
                    m.before_latest_moment_id, \
                    COALESCE(m.before_metadata_origin, p.metadata_origin, f.metadata_origin), \
                    COALESCE(m.before_metadata_summary, p.metadata_summary, f.metadata_summary), \
                    COALESCE(m.before_metadata_correlation_id, p.metadata_correlation_id, f.metadata_correlation_id) \
             FROM moments m \
             JOIN file_objects o ON o.workspace_id=m.workspace_id AND o.object_id=m.object_id \
             LEFT JOIN moments p ON p.workspace_id=m.workspace_id AND p.moment_id=m.before_latest_moment_id \
             LEFT JOIN fork_base_snapshots f ON f.workspace_id=m.workspace_id AND f.version_id=m.version_id \
               AND f.object_id=m.object_id AND f.latest_moment_id=m.before_latest_moment_id \
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
                    before_updated_at_ms: row.get(23)?,
                    before_latest_moment_id: row.get(24)?,
                    before_metadata_origin: row.get(25)?,
                    before_metadata_summary: row.get(26)?,
                    before_metadata_correlation_id: row.get(27)?,
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
    let mut payload = serde_json::json!({
        "momentId": row.moment_id,
        "versionId": row.version_id,
        "objectId": row.object_id,
        "objectCreatedAtMs": row.object_created_at_ms,
        "path": row.path,
        "recordedAtMs": row.recorded_at_ms,
        "operation": row.operation,
        "payloadBeforeBlobSha256": &row.payload_before_blob_sha256,
        "payloadBeforePath": row.payload_before_path,
        "payloadAfterBlobSha256": row.payload_after_blob_sha256,
        "payloadAfterPath": row.payload_after_path,
        "payloadBeforeContentKind": &row.payload_before_content_kind,
        "payloadBeforeByteLength": &row.payload_before_byte_length,
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
        "beforeBlobSha256": &row.payload_before_blob_sha256,
        "beforeContentKind": &row.payload_before_content_kind,
        "beforeByteLength": &row.payload_before_byte_length,
        "beforeUpdatedAtMs": row.before_updated_at_ms,
        "beforeLatestMomentId": row.before_latest_moment_id,
        "beforeMetadata": before_metadata,
    });
    if measured_json_len(&payload)? > PAYLOAD_PACKING_TARGET_BYTES {
        payload["beforeMetadata"] = serde_json::Value::Null;
    }
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
    let header = serde_json::json!({
        "versionId": record.version_id,
        "name": record.name,
        "kind": record.kind.as_str(),
        "forkVersionId": record.fork_version_id,
        "forkMomentId": record.fork_moment_id,
        "createdAtMs": record.created_at_ms,
        "forkSnapshots": [],
    });
    // One op per packed group: a bigger fork costs more ops, never a refusal.
    for fork_snapshots in pack_fork_rows(&header, fork_snapshots)? {
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
        )?;
    }
    Ok(())
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
    let total_rows = rows.len();
    let packing_header = serde_json::json!({
        "toVersionId": to_version_id,
        "fromVersionId": from_version_id,
        "chunkIndex": usize::MAX,
        "totalRows": total_rows,
        "rows": [],
    });
    // The packing header carries the widest `chunkIndex` there can be, so every
    // real chunk header measures the same or smaller.
    for (chunk_index, rows) in pack_fork_rows(&packing_header, rows)?
        .into_iter()
        .enumerate()
    {
        let payload = serde_json::json!({
            "toVersionId": to_version_id,
            "fromVersionId": from_version_id,
            "chunkIndex": chunk_index,
            "totalRows": total_rows,
            "rows": rows,
        });
        journal_local_op_in_tx(
            tx,
            workspace_id,
            "secret.version.fork",
            &payload,
            recorded_at_ms,
        )?;
    }
    Ok(())
}

/// How far below the payload cap payload packing stops.
///
/// The relay re-measures every pushed payload with its own serializer
/// (`stableJsonStringify`, `services/sync-relay/src/server.ts`), so two
/// implementations decide one byte count. The headroom absorbs any drift
/// between them — a dependency upgrade or an escaping edge case — which would
/// otherwise refuse an op the engine had already journaled and wedge the
/// outbound queue. `journal_local_op_in_tx` remains the single enforced limit;
/// fork packing uses the target to split rows, and `moment.append` trimming
/// uses it to shed optional before-state metadata. Packing smaller never
/// refuses valid work.
const PAYLOAD_PACKING_HEADROOM_BYTES: usize = 4096;
const PAYLOAD_PACKING_TARGET_BYTES: usize =
    crate::MAX_PAYLOAD_JSON_BYTES - PAYLOAD_PACKING_HEADROOM_BYTES;

/// Split fork rows into payload-sized groups, measuring the header once and
/// each row once.
///
/// Every group this returns serializes at or below `PAYLOAD_PACKING_TARGET_BYTES`,
/// so a larger fork costs more operations and is never refused. The packer only
/// splits: `journal_local_op_in_tx` stays the single owner of the payload cap,
/// and refuses the one row a split cannot help — a row wider than a whole
/// payload.
///
/// `worst_case_fork_snapshot_row_fits` measures that no capped row reaches the
/// target. A row at every field's ceiling — 512-byte ids and paths
/// (`MAX_IDENTIFIER_BYTES`) and two 16 KiB metadata fields
/// (`MAX_METADATA_FIELD_BYTES`), each byte escaped at its worst — makes a
/// 203,572-byte payload against the 258,048-byte target, 54,476 bytes clear.
fn pack_fork_rows(
    empty_payload: &serde_json::Value,
    rows: Vec<serde_json::Value>,
) -> Result<Vec<Vec<serde_json::Value>>, SyncError> {
    let header_len = measured_json_len(empty_payload)?;
    let mut chunks = Vec::new();
    let mut chunk: Vec<serde_json::Value> = Vec::new();
    let mut chunk_len = header_len;
    for row in rows {
        let row_len = measured_json_len(&row)?;
        // The header already carries the empty `[]`, so a row costs its own
        // length plus the one comma that follows the row before it.
        if !chunk.is_empty() && chunk_len + 1 + row_len > PAYLOAD_PACKING_TARGET_BYTES {
            chunks.push(std::mem::take(&mut chunk));
            chunk_len = header_len;
        }
        chunk_len += usize::from(!chunk.is_empty()) + row_len;
        chunk.push(row);
    }
    // A fork with no rows still emits one operation, which is how a peer learns
    // about a version that forked empty.
    chunks.push(chunk);
    Ok(chunks)
}

fn measured_json_len(value: &serde_json::Value) -> Result<usize, SyncError> {
    serde_json::to_vec(value)
        .map(|encoded| encoded.len())
        .map_err(|_| SyncError::InvalidInput {
            reason: "fork replication payload is malformed",
        })
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn worst_case_fork_snapshot_row_fits() {
        const MAX_METADATA_FIELD_BYTES: usize = 16 * 1024;
        let identifier = "\"".repeat(crate::model::MAX_IDENTIFIER_BYTES);
        let path = format!("{}.md", "\"".repeat(crate::model::MAX_IDENTIFIER_BYTES - 3));
        let metadata = "\0".repeat(MAX_METADATA_FIELD_BYTES);
        let row = serde_json::json!({
            "objectId": identifier,
            "objectCreatedAtMs": i64::MIN,
            "path": path,
            "contentKind": "binary",
            "blobSha256": "f".repeat(64),
            "updatedAtMs": i64::MIN,
            "latestMomentId": identifier,
            "metadata": {
                "origin": "local-file",
                "summary": metadata,
                "correlationId": metadata,
            },
        });
        let header = serde_json::json!({
            "versionId": identifier,
            "name": "\"".repeat(200),
            "kind": "named",
            "forkVersionId": identifier,
            "forkMomentId": identifier,
            "createdAtMs": i64::MIN,
            "forkSnapshots": [],
        });
        let row_len = serde_json::to_vec(&row).expect("serialize worst row").len();
        let payload_len = serde_json::to_vec(&header)
            .expect("serialize worst header")
            .len()
            + row_len;
        assert_eq!(row_len, 199_968);
        assert_eq!(payload_len, 203_572);
        // Measured against the packing target, not the cap: the target is the
        // bound a row has to clear for a fork to split instead of refuse.
        assert_eq!(PAYLOAD_PACKING_TARGET_BYTES, 258_048);
        assert!(payload_len <= PAYLOAD_PACKING_TARGET_BYTES);
        assert_eq!(PAYLOAD_PACKING_TARGET_BYTES - payload_len, 54_476);
        assert_eq!(
            pack_fork_rows(&header, vec![row]).expect("pack row").len(),
            1
        );
    }

    #[test]
    fn worst_case_moment_metadata_fits_after_shedding_before_metadata() {
        const MAX_METADATA_FIELD_BYTES: usize = 16 * 1024;
        let identifier = "\"".repeat(crate::model::MAX_IDENTIFIER_BYTES);
        let path = format!("{}.md", "\"".repeat(crate::model::MAX_IDENTIFIER_BYTES - 3));
        let blob_sha = "f".repeat(64);
        let metadata = "\0".repeat(MAX_METADATA_FIELD_BYTES);
        let mut payload = serde_json::json!({
            "momentId": &identifier,
            "versionId": &identifier,
            "objectId": &identifier,
            "objectCreatedAtMs": 1,
            "path": &path,
            "recordedAtMs": 2,
            "operation": "write",
            "payloadBeforeBlobSha256": &blob_sha,
            "payloadBeforePath": &path,
            "payloadAfterBlobSha256": &blob_sha,
            "payloadAfterPath": &path,
            "payloadBeforeContentKind": "text",
            "payloadBeforeByteLength": 1,
            "payloadAfterContentKind": "text",
            "payloadAfterByteLength": 1,
            "metadata": {
                "origin": "api",
                "summary": &metadata,
                "correlationId": &metadata,
            },
            "author": null,
            "beforePresent": "present",
            "beforeObjectId": &identifier,
            "beforeVersionId": &identifier,
            "beforePath": &path,
            "beforeBlobSha256": &blob_sha,
            "beforeContentKind": "text",
            "beforeByteLength": 1,
            "beforeUpdatedAtMs": 1,
            "beforeLatestMomentId": &identifier,
            "beforeMetadata": {
                "origin": "api",
                "summary": &metadata,
                "correlationId": &metadata,
            },
        });

        let with_before_metadata = measured_json_len(&payload).expect("measure full payload");
        payload["beforeMetadata"] = serde_json::Value::Null;
        let without_before_metadata = measured_json_len(&payload).expect("measure trimmed payload");
        assert_eq!(PAYLOAD_PACKING_HEADROOM_BYTES, 4_096);
        assert_eq!(PAYLOAD_PACKING_TARGET_BYTES, 258_048);
        assert_eq!(with_before_metadata, 404_314);
        assert_eq!(without_before_metadata, 207_662);
        assert!(with_before_metadata > PAYLOAD_PACKING_TARGET_BYTES);
        assert!(without_before_metadata < PAYLOAD_PACKING_TARGET_BYTES);
        assert_eq!(
            PAYLOAD_PACKING_TARGET_BYTES - without_before_metadata,
            50_386
        );
    }
}
