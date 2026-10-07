use super::{get_moment, next_moment_order, validate_identifier};
use crate::{DomainError, TextSnapshot};
use rusqlite::{Connection, Transaction, params};
use serde::Serialize;

pub const CAPTURE_RECOVERY_ORIGIN: &str = "capture-recovery";
pub const CLEARED_CAPTURE_RECOVERY_ORIGIN: &str = "capture-recovery-cleared";

pub fn is_capture_recovery_origin(origin: &str) -> bool {
    matches!(
        origin,
        CAPTURE_RECOVERY_ORIGIN | CLEARED_CAPTURE_RECOVERY_ORIGIN
    )
}

/// Recovery is owner-local History, never a file transition or an export preimage.
/// Generic backfill and COVERED_HEADS_SQL use this exclusion. #1711 must adopt it
/// in backfill_file_versions_in_tx, file_version_is_publishable_in_tx,
/// LAST_FILE_EXPORT_SQL and file_version_before_in_tx's bootstrap preimage.
#[macro_export]
macro_rules! exclude_capture_recovery_sql {
    ($alias:literal) => {
        concat!(
            $alias,
            ".metadata_origin NOT IN ('capture-recovery','capture-recovery-cleared')"
        )
    };
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureRecovery {
    pub moment_id: String,
    pub version_id: String,
    pub object_id: String,
    pub path: String,
    pub capture_moment_id: String,
}

/// The preimage is a document projection, not a former file head. Its producer
/// link and rollback identity stay NULL. Both blobs are rooted by the moment.
pub fn record_capture_recovery_in_tx(
    tx: &Transaction<'_>,
    workspace_id: &str,
    captured: &TextSnapshot,
    typing: &str,
    state_vector_sha: &str,
    author_json: Option<&str>,
    now_ms: i64,
) -> Result<Option<i64>, DomainError> {
    let typing_sha = dohc_engine_storage::hex_sha256(typing.as_bytes());
    let fingerprint = format!(
        "{workspace_id}\0{}\0{}\0{}\0{state_vector_sha}\0{typing_sha}",
        captured.version_id, captured.object_id, captured.latest_moment_id
    );
    let moment_id = format!(
        "moment-capture-recovery-{}",
        dohc_engine_storage::hex_sha256(fingerprint.as_bytes())
    );
    if get_moment(tx, workspace_id, &moment_id)?.is_some() {
        return Ok(None);
    }
    tx.execute(
        "INSERT OR IGNORE INTO blobs (sha256,byte_length,text) VALUES (?1,?2,?3)",
        params![typing_sha, typing.len() as i64, typing],
    )
    .map_err(DomainError::sql_persist)?;
    let order = next_moment_order(tx)?;
    tx.execute(
        "INSERT INTO moments (workspace_id,moment_order,moment_id,version_id,object_id,path,recorded_at_ms,operation,
          after_blob_sha256,before_present,before_blob_sha256,before_latest_moment_id,metadata_origin,
          metadata_correlation_id,author_json,after_content_kind,before_content_kind,
          payload_before_path,payload_before_content_kind,payload_before_blob_sha256,
          payload_after_path,payload_after_content_kind,payload_after_blob_sha256)
         VALUES (?1,?2,?3,?4,?5,?6,?7,'write',?8,2,?9,NULL,?10,?11,?12,'text','text',?6,'text',?9,?6,'text',?8)",
        params![workspace_id, order, moment_id, captured.version_id, captured.object_id, captured.path,
            now_ms, captured.blob_sha256, typing_sha, CAPTURE_RECOVERY_ORIGIN, captured.latest_moment_id, author_json],
    ).map_err(DomainError::sql_persist)?;
    Ok(Some(order))
}

pub fn capture_recoveries_in(
    conn: &Connection,
    workspace_id: &str,
) -> Result<Vec<CaptureRecovery>, DomainError> {
    validate_identifier(workspace_id, "workspace_id")?;
    let mut query = conn
        .prepare(
            "SELECT moment_id,version_id,object_id,path,metadata_correlation_id FROM moments
         WHERE workspace_id=?1 AND metadata_origin=?2 ORDER BY moment_order",
        )
        .map_err(DomainError::sql_corrupt)?;
    query
        .query_map(params![workspace_id, CAPTURE_RECOVERY_ORIGIN], |row| {
            Ok(CaptureRecovery {
                moment_id: row.get(0)?,
                version_id: row.get(1)?,
                object_id: row.get(2)?,
                path: row.get(3)?,
                capture_moment_id: row.get(4)?,
            })
        })
        .map_err(DomainError::sql_corrupt)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(DomainError::sql_corrupt)
}

pub fn clear_capture_recovery_in(
    conn: &Connection,
    workspace_id: &str,
    moment_id: &str,
) -> Result<(), DomainError> {
    validate_identifier(workspace_id, "workspace_id")?;
    validate_identifier(moment_id, "moment_id")?;
    conn.execute("UPDATE moments SET metadata_origin=?3 WHERE workspace_id=?1 AND moment_id=?2 AND metadata_origin=?4",
        params![workspace_id, moment_id, CLEARED_CAPTURE_RECOVERY_ORIGIN, CAPTURE_RECOVERY_ORIGIN])
        .map_err(DomainError::sql_persist)?;
    Ok(())
}
