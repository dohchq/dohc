use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use dohc_engine_domain::{MAX_SECRET_FILE_BYTES, SECRET_IV_BYTES, SECRET_TAG_BYTES};
use dohc_engine_files::{PathClassification, classify_engine_file_path_normalized};
use dohc_engine_storage::{EngineStore, FaultInjector, StorageError};
use rusqlite::{OptionalExtension, Transaction, params};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};

use crate::{ApplyOutcome, ReplicationEnvelope, SyncError};

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub(crate) struct SecretApplyResult {
    pub(crate) materialization_changes: Vec<crate::MomentMaterializationChange>,
}

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
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SecretForkAssembly {
    workspace_id: String,
    origin_id: String,
    start_origin_seq: i64,
    from_version_id: String,
    to_version_id: String,
    total_rows: usize,
    next_chunk_index: usize,
    previous_tips: Vec<SecretForkPreviousTip>,
    rows: Vec<SecretForkStagedRow>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SecretForkPreviousTip {
    path: String,
    latest_moment_id: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SecretForkStagedRow {
    path: String,
    iv_base64: String,
    auth_tag_base64: String,
    ciphertext_base64: String,
    byte_length: i64,
    updated_at_ms: i64,
}

pub fn apply_secret_envelope(
    store: &mut EngineStore,
    envelope: &ReplicationEnvelope,
    faults: &dyn FaultInjector,
) -> Result<ApplyOutcome<()>, SyncError> {
    apply_secret_envelope_detailed(store, envelope, faults).map(|outcome| outcome.map(|_| ()))
}

pub(crate) fn apply_secret_envelope_detailed(
    store: &mut EngineStore,
    envelope: &ReplicationEnvelope,
    faults: &dyn FaultInjector,
) -> Result<ApplyOutcome<SecretApplyResult>, SyncError> {
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

pub(crate) fn redelivered_materialization_changes(
    store: &EngineStore,
    envelope: &ReplicationEnvelope,
) -> Result<Vec<crate::MomentMaterializationChange>, SyncError> {
    if !matches!(
        envelope.op_kind.as_str(),
        "secret.file.put" | "secret.file.delete" | "secret.version.fork"
    ) {
        return Ok(Vec::new());
    }
    crate::moment_apply::stored_materialization_changes(store, envelope)
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
) -> Result<SecretApplyResult, SyncError> {
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
) -> Result<SecretApplyResult, SyncError> {
    validate_common(tx, op, &p.version_id, &p.path, &p.metadata)?;
    insert_moment(tx, op, &p.version_id, &p.path, &p.metadata, None)
}

fn apply_fork(
    tx: &Transaction<'_>,
    op: &ReplicationEnvelope,
    payload: SecretFork,
) -> Result<SecretApplyResult, SyncError> {
    validate_fork_versions(tx, op, &payload.from_version_id, &payload.to_version_id)?;
    validate_fork_rows(&payload.rows, payload.total_rows)?;
    let (assembly_id, start_origin_seq) = fork_assembly_id(op, payload.chunk_index)?;
    let was_stored = payload.chunk_index != 0;
    let mut assembly = if payload.chunk_index == 0 {
        SecretForkAssembly {
            workspace_id: op.workspace_id.clone(),
            origin_id: op.origin_id.clone(),
            start_origin_seq,
            from_version_id: payload.from_version_id.clone(),
            to_version_id: payload.to_version_id.clone(),
            total_rows: payload.total_rows,
            next_chunk_index: 0,
            previous_tips: read_secret_tips(tx, &op.workspace_id, &payload.to_version_id)?,
            rows: Vec::new(),
        }
    } else {
        load_fork_assembly(tx, &assembly_id)?
    };
    validate_fork_assembly(
        &assembly,
        op,
        start_origin_seq,
        &payload.from_version_id,
        &payload.to_version_id,
        payload.total_rows,
        payload.chunk_index,
    )?;
    append_fork_rows(tx, &mut assembly, payload.rows)?;
    assembly.next_chunk_index = assembly
        .next_chunk_index
        .checked_add(1)
        .ok_or(SyncError::CoordinateDiverged)?;
    if assembly.rows.len() < assembly.total_rows {
        store_fork_assembly(tx, op, &assembly_id, &assembly, was_stored)?;
        return Ok(SecretApplyResult::default());
    }

    let materialization_changes = finalize_fork(tx, op, assembly)?;
    if was_stored {
        let deleted = tx
            .execute(
                "DELETE FROM engine_requests \
                 WHERE request_id=?1 AND kind='sync-secret-fork-assembly'",
                [&assembly_id],
            )
            .map_err(SyncError::persist)?;
        if deleted != 1 {
            return Err(SyncError::CoordinateDiverged);
        }
    }
    crate::moment_apply::record_materialization_changes(tx, op, &materialization_changes)?;
    Ok(SecretApplyResult {
        materialization_changes,
    })
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
    if total_rows > 0 && rows.is_empty() {
        return Err(SyncError::InvalidInput {
            reason: "secret fork chunk must make progress toward its declared total",
        });
    }
    let mut seen = HashSet::with_capacity(rows.len());
    for row in rows {
        validate_fork_row(row)?;
        if !seen.insert(row.path.as_str()) {
            return Err(SyncError::InvalidInput {
                reason: "secret fork contains duplicate paths",
            });
        }
    }
    Ok(())
}

fn fork_assembly_id(
    op: &ReplicationEnvelope,
    chunk_index: usize,
) -> Result<(String, i64), SyncError> {
    let chunk_offset = i64::try_from(chunk_index).map_err(|_| SyncError::InvalidInput {
        reason: "secret fork chunk index is invalid",
    })?;
    let start_origin_seq = op
        .origin_seq
        .checked_sub(chunk_offset)
        .filter(|sequence| *sequence >= 0)
        .ok_or(SyncError::InvalidInput {
            reason: "secret fork chunk sequence is invalid",
        })?;
    let coordinate = format!(
        "{}\0{}\0{}",
        op.workspace_id, op.origin_id, start_origin_seq
    );
    Ok((
        format!(
            "sync-secret-fork-assembly:{}",
            dohc_engine_storage::hex_sha256(coordinate.as_bytes())
        ),
        start_origin_seq,
    ))
}

fn read_secret_tips(
    tx: &Transaction<'_>,
    workspace_id: &str,
    version_id: &str,
) -> Result<Vec<SecretForkPreviousTip>, SyncError> {
    tx.prepare(
        "SELECT path,latest_moment_id FROM secret_files \
         WHERE workspace_id=?1 AND version_id=?2 ORDER BY path",
    )
    .map_err(SyncError::corrupt)?
    .query_map(params![workspace_id, version_id], |row| {
        Ok(SecretForkPreviousTip {
            path: row.get(0)?,
            latest_moment_id: row.get(1)?,
        })
    })
    .map_err(SyncError::corrupt)?
    .collect::<Result<Vec<_>, _>>()
    .map_err(SyncError::corrupt)
}

fn load_fork_assembly(
    tx: &Transaction<'_>,
    assembly_id: &str,
) -> Result<SecretForkAssembly, SyncError> {
    let encoded = tx
        .query_row(
            "SELECT payload_hash FROM engine_requests \
             WHERE request_id=?1 AND kind='sync-secret-fork-assembly'",
            [assembly_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(SyncError::corrupt)?
        .ok_or(SyncError::InvalidInput {
            reason: "secret fork chunk has no matching assembly",
        })?;
    serde_json::from_str(&encoded).map_err(|_| SyncError::CoordinateDiverged)
}

#[allow(clippy::too_many_arguments)]
fn validate_fork_assembly(
    assembly: &SecretForkAssembly,
    op: &ReplicationEnvelope,
    start_origin_seq: i64,
    from_version_id: &str,
    to_version_id: &str,
    total_rows: usize,
    chunk_index: usize,
) -> Result<(), SyncError> {
    if assembly.workspace_id != op.workspace_id
        || assembly.origin_id != op.origin_id
        || assembly.start_origin_seq != start_origin_seq
        || assembly.from_version_id != from_version_id
        || assembly.to_version_id != to_version_id
        || assembly.total_rows != total_rows
        || assembly.next_chunk_index != chunk_index
    {
        return Err(SyncError::InvalidInput {
            reason: "secret fork chunk does not match its assembly",
        });
    }
    Ok(())
}

fn append_fork_rows(
    tx: &Transaction<'_>,
    assembly: &mut SecretForkAssembly,
    rows: Vec<SecretForkRow>,
) -> Result<(), SyncError> {
    let mut seen = assembly
        .rows
        .iter()
        .map(|row| row.path.as_str())
        .collect::<HashSet<_>>();
    for row in &rows {
        if !seen.insert(&row.path) {
            return Err(SyncError::InvalidInput {
                reason: "secret fork contains duplicate paths across chunks",
            });
        }
    }
    let next_len = assembly
        .rows
        .len()
        .checked_add(rows.len())
        .ok_or(SyncError::CoordinateDiverged)?;
    if next_len > assembly.total_rows {
        return Err(SyncError::InvalidInput {
            reason: "secret fork chunks exceed their declared total",
        });
    }
    for row in rows {
        let ciphertext = load_ciphertext(tx, &row.ciphertext_sha256, row.byte_length)?;
        assembly.rows.push(SecretForkStagedRow {
            path: row.path,
            iv_base64: row.iv_base64,
            auth_tag_base64: row.auth_tag_base64,
            ciphertext_base64: STANDARD.encode(ciphertext),
            byte_length: row.byte_length,
            updated_at_ms: row.updated_at_ms,
        });
    }
    Ok(())
}

fn store_fork_assembly(
    tx: &Transaction<'_>,
    op: &ReplicationEnvelope,
    assembly_id: &str,
    assembly: &SecretForkAssembly,
    already_stored: bool,
) -> Result<(), SyncError> {
    let encoded = serde_json::to_string(assembly).map_err(|_| SyncError::CoordinateDiverged)?;
    let changed = if already_stored {
        tx.execute(
            "UPDATE engine_requests SET payload_hash=?2,result_seq=?3,committed_at=?4 \
             WHERE request_id=?1 AND kind='sync-secret-fork-assembly'",
            params![assembly_id, encoded, op.origin_seq, op.recorded_at_ms],
        )
        .map_err(SyncError::persist)?
    } else {
        tx.execute(
            "INSERT OR IGNORE INTO engine_requests \
             (request_id,payload_hash,result_seq,committed_at,kind) \
             VALUES (?1,?2,?3,?4,'sync-secret-fork-assembly')",
            params![assembly_id, encoded, op.origin_seq, op.recorded_at_ms],
        )
        .map_err(SyncError::persist)?
    };
    if changed != 1 {
        return Err(SyncError::CoordinateDiverged);
    }
    Ok(())
}

fn finalize_fork(
    tx: &Transaction<'_>,
    op: &ReplicationEnvelope,
    mut assembly: SecretForkAssembly,
) -> Result<Vec<crate::MomentMaterializationChange>, SyncError> {
    assembly
        .rows
        .sort_by(|left, right| left.path.cmp(&right.path));
    let previous = assembly
        .previous_tips
        .into_iter()
        .map(|tip| (tip.path, tip.latest_moment_id))
        .collect::<BTreeMap<_, _>>();
    let mut current = read_secret_tips(tx, &op.workspace_id, &assembly.to_version_id)?
        .into_iter()
        .map(|tip| (tip.path, tip.latest_moment_id))
        .collect::<BTreeMap<_, _>>();
    let fork_paths = assembly
        .rows
        .iter()
        .map(|row| row.path.as_str())
        .collect::<HashSet<_>>();
    let active = is_active_version(tx, &op.workspace_id, &assembly.to_version_id)?;
    let mut materialization_changes = Vec::new();

    for (path, previous_tip) in &previous {
        if !fork_paths.contains(path.as_str()) && current.get(path) == Some(previous_tip) {
            let deleted = tx
                .execute(
                    "DELETE FROM secret_files \
                     WHERE workspace_id=?1 AND version_id=?2 AND path=?3 AND latest_moment_id=?4",
                    params![op.workspace_id, assembly.to_version_id, path, previous_tip],
                )
                .map_err(SyncError::persist)?;
            if deleted != 1 {
                return Err(SyncError::CoordinateDiverged);
            }
            current.remove(path);
            if active {
                materialization_changes.push(crate::MomentMaterializationChange {
                    version_id: assembly.to_version_id.clone(),
                    path: path.clone(),
                    operation: "delete",
                    content_kind: "secret",
                });
            }
        }
    }

    tx.execute(
        "DELETE FROM secret_fork_bases WHERE workspace_id=?1 AND version_id=?2",
        params![op.workspace_id, assembly.to_version_id],
    )
    .map_err(SyncError::persist)?;
    for (index, row) in assembly.rows.into_iter().enumerate() {
        tx.execute(
            "INSERT INTO secret_fork_bases \
             (workspace_id,version_id,path,iv_base64,auth_tag_base64,ciphertext_base64,byte_length,updated_at_ms) \
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
            params![
                op.workspace_id,
                assembly.to_version_id,
                row.path,
                row.iv_base64,
                row.auth_tag_base64,
                row.ciphertext_base64,
                row.byte_length,
                row.updated_at_ms,
            ],
        )
        .map_err(SyncError::persist)?;
        let unchanged_previous_tip = previous
            .get(&row.path)
            .is_some_and(|previous_tip| current.get(&row.path) == Some(previous_tip));
        let new_path = !previous.contains_key(&row.path) && !current.contains_key(&row.path);
        if !unchanged_previous_tip && !new_path {
            continue;
        }
        let latest_moment_id = format!("secret-sync-{}-{}-{index}", op.origin_id, op.origin_seq);
        tx.execute(
            "INSERT INTO secret_files \
             (workspace_id,version_id,path,iv_base64,auth_tag_base64,ciphertext_base64,byte_length,updated_at_ms,latest_moment_id) \
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9) \
             ON CONFLICT(workspace_id,version_id,path) DO UPDATE SET \
                 iv_base64=excluded.iv_base64, \
                 auth_tag_base64=excluded.auth_tag_base64, \
                 ciphertext_base64=excluded.ciphertext_base64, \
                 byte_length=excluded.byte_length, \
                 updated_at_ms=excluded.updated_at_ms, \
                 latest_moment_id=excluded.latest_moment_id",
            params![
                op.workspace_id,
                assembly.to_version_id,
                row.path,
                row.iv_base64,
                row.auth_tag_base64,
                row.ciphertext_base64,
                row.byte_length,
                row.updated_at_ms,
                latest_moment_id,
            ],
        )
        .map_err(SyncError::persist)?;
        if active {
            materialization_changes.push(crate::MomentMaterializationChange {
                version_id: assembly.to_version_id.clone(),
                path: row.path,
                operation: "write",
                content_kind: "secret",
            });
        }
    }
    materialization_changes.sort_by(|left, right| {
        left.path
            .cmp(&right.path)
            .then_with(|| left.operation.cmp(right.operation))
    });
    Ok(materialization_changes)
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
) -> Result<SecretApplyResult, SyncError> {
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
         (workspace_id,moment_order,moment_id,version_id,path,recorded_at_ms,operation,metadata_origin,metadata_summary,metadata_correlation_id,after_present,after_iv_base64,after_auth_tag_base64,after_ciphertext_base64,after_byte_length,source_origin_id,source_origin_seq) \
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17)",
        params![op.workspace_id,order,moment_id,version_id,path,op.recorded_at_ms,if present == 1 { "write" } else { "delete" },metadata.origin,metadata.summary,metadata.correlation_id,present,iv,tag,ciphertext,byte_length,op.origin_id,op.origin_seq],
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
    let won = remote_wins(tx, op, version_id, path, after)?;
    if won {
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
    let materialization_changes = if won && is_active_version(tx, &op.workspace_id, version_id)? {
        vec![crate::MomentMaterializationChange {
            version_id: version_id.to_owned(),
            path: path.to_owned(),
            operation: if after.is_some() { "write" } else { "delete" },
            content_kind: "secret",
        }]
    } else {
        Vec::new()
    };
    crate::moment_apply::record_materialization_changes(tx, op, &materialization_changes)?;
    Ok(SecretApplyResult {
        materialization_changes,
    })
}

fn is_active_version(
    tx: &Transaction<'_>,
    workspace_id: &str,
    version_id: &str,
) -> Result<bool, SyncError> {
    let active: Option<String> = tx
        .query_row(
            "SELECT COALESCE( \
               (SELECT version_id FROM active_versions WHERE workspace_id=?1), \
               (SELECT main_version_id FROM versioned_workspaces WHERE workspace_id=?1) \
             )",
            [workspace_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(SyncError::corrupt)?;
    Ok(active.as_deref() == Some(version_id))
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
