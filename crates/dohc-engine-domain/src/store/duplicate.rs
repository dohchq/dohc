use super::*;

pub struct DuplicateFile {
    pub workspace_id: String,
    pub version_id: String,
    pub from_path: String,
    pub to_path: String,
    pub operation_id: String,
    pub author_json: Option<String>,
    pub now_ms: i64,
}

/// Copy immutable content, never document state, grants or automation claims.
pub fn duplicate_file_in_tx(
    tx: &Transaction<'_>,
    input: &DuplicateFile,
) -> Result<MomentRecord, DomainError> {
    let DuplicateFile {
        workspace_id: ws,
        version_id: version,
        from_path: from,
        to_path: to,
        operation_id: operation,
        author_json: author,
        now_ms: now,
    } = input;
    validate_operation_id(operation)?;
    validate_plaintext_storable_path(from)?;
    validate_plaintext_storable_path(to)?;
    validate_moment_metadata("api", None, Some(operation), author.as_deref())?;
    if !version_is_active(tx, ws, version)? {
        return Err(DomainError::VersionNotFound);
    }
    let request = format!("duplicate_{operation}");
    let fingerprint = hash_fields(&[
        b"file.duplicate",
        ws.as_bytes(),
        version.as_bytes(),
        from.as_bytes(),
        to.as_bytes(),
        author.as_deref().unwrap_or("").as_bytes(),
    ]);
    if let Some(recorded) = lookup_request(tx, &request)? {
        if recorded.payload_hash != fingerprint {
            return Err(DomainError::IdempotencyKeyReuseMismatch);
        }
        return moment_by_order(tx, ws, recorded.result_seq)?.ok_or(DomainError::FileNotFound);
    }
    if tx.query_row("SELECT EXISTS(SELECT 1 FROM moments WHERE workspace_id=?1 AND metadata_correlation_id=?2)", params![ws,operation], |r| r.get::<_,bool>(0)).map_err(DomainError::sql_corrupt)? {
        return Err(DomainError::InvalidInput { reason: "operation id already used" });
    }
    if alias_object_id(tx, ws, version, to)?.is_some() {
        return Err(DomainError::TargetPathExists);
    }
    let source = alias_object_id(tx, ws, version, from)?.ok_or(DomainError::FileNotFound)?;
    get_snapshot_meta(tx, ws, version, &source)?.ok_or(DomainError::FileNotFound)?;
    let object = format!(
        "duplicate_{}",
        hash_fields(&[ws.as_bytes(), operation.as_bytes()])
    );
    let moment = format!(
        "duplicate-moment_{}",
        hash_fields(&[ws.as_bytes(), operation.as_bytes()])
    );
    let summary = format!("Duplicated {from}");
    let order = next_moment_order(tx)?;
    tx.execute(
        "INSERT INTO file_objects(workspace_id,object_id,created_at_ms) VALUES(?1,?2,?3)",
        params![ws, object, now],
    )
    .map_err(DomainError::sql_persist)?;
    tx.execute(
        "INSERT INTO path_aliases(workspace_id,version_id,path,object_id) VALUES(?1,?2,?3,?4)",
        params![ws, version, to, object],
    )
    .map_err(DomainError::sql_persist)?;
    tx.execute("INSERT INTO snapshots(workspace_id,version_id,object_id,path,blob_sha256,binary_sha256,content_kind,updated_at_ms,latest_moment_id,metadata_origin,metadata_summary,metadata_correlation_id)
        SELECT workspace_id,version_id,?4,?5,blob_sha256,binary_sha256,content_kind,?6,?7,'api',?8,?9 FROM snapshots WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
        params![ws,version,source,object,to,now,moment,summary,operation]).map_err(DomainError::sql_persist)?;
    tx.execute("INSERT INTO moments(workspace_id,version_id,object_id,path,moment_id,moment_order,recorded_at_ms,operation,after_blob_sha256,after_binary_sha256,after_content_kind,before_present,metadata_origin,metadata_summary,metadata_correlation_id,author_json,payload_after_path,payload_after_content_kind,payload_after_blob_sha256)
        SELECT workspace_id,version_id,object_id,path,latest_moment_id,?4,?5,'write',blob_sha256,binary_sha256,content_kind,0,'api',metadata_summary,metadata_correlation_id,?6,path,content_kind,coalesce(blob_sha256,binary_sha256) FROM snapshots WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
        params![ws,version,object,order,now,author]).map_err(DomainError::sql_persist)?;
    record_request(
        tx,
        Some(&request),
        &fingerprint,
        order,
        *now,
        "file-duplicate",
    )?;
    get_moment(tx, ws, &moment)?.ok_or(DomainError::FileNotFound)
}

pub fn is_duplicate_in(
    conn: &Connection,
    ws: &str,
    operation: &str,
    order: i64,
) -> Result<bool, DomainError> {
    conn.query_row("SELECT EXISTS(SELECT 1 FROM engine_requests WHERE request_id=?1 AND kind='file-duplicate' AND result_seq=?2 AND EXISTS(SELECT 1 FROM moments WHERE workspace_id=?3 AND moment_order=?2 AND metadata_correlation_id=?4 AND before_present=0 AND operation='write'))",
        params![format!("duplicate_{operation}"),order,ws,operation], |r| r.get(0)).map_err(DomainError::sql_corrupt)
}
