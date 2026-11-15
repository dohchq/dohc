use super::{get_moment, next_moment_order, validate_identifier};
use crate::{DomainError, TextSnapshot};
use dohc_engine_storage::text;
use rusqlite::{Connection, Transaction, params};
use serde::Serialize;

pub const CAPTURE_RECOVERY_ORIGIN: &str = "capture-recovery";
pub const CLEARED_CAPTURE_RECOVERY_ORIGIN: &str = "capture-recovery-cleared";
/// Text someone else's change removed unseen when this engine merged it.
pub const MERGE_REMOVAL_ORIGIN: &str = "merge-removal";
pub const CLEARED_MERGE_REMOVAL_ORIGIN: &str = "merge-removal-cleared";

/// Kept text this engine wrote into its own History: capture recovery and
/// merge removal. Neither is a file change, and neither leaves this engine.
pub fn is_capture_recovery_origin(origin: &str) -> bool {
    matches!(
        origin,
        CAPTURE_RECOVERY_ORIGIN
            | CLEARED_CAPTURE_RECOVERY_ORIGIN
            | MERGE_REMOVAL_ORIGIN
            | CLEARED_MERGE_REMOVAL_ORIGIN
    )
}

/// Kept text is owner-local History, never a file transition or an export
/// preimage. Generic backfill and COVERED_HEADS_SQL use this exclusion.
#[macro_export]
macro_rules! exclude_capture_recovery_sql {
    () => {
        "metadata_origin NOT IN ('capture-recovery','capture-recovery-cleared','merge-removal','merge-removal-cleared')"
    };
    ($alias:literal) => {
        concat!($alias, ".", $crate::exclude_capture_recovery_sql!())
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
    pub deleted: bool,
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
    record_keyed_capture_recovery_in_tx(
        tx,
        workspace_id,
        captured,
        typing,
        &moment_id,
        author_json,
        now_ms,
    )
}

/// Imported checkpoint identity is independent of the current captured head.
pub fn record_keyed_capture_recovery_in_tx(
    tx: &Transaction<'_>,
    workspace_id: &str,
    captured: &TextSnapshot,
    typing: &str,
    moment_id: &str,
    author_json: Option<&str>,
    now_ms: i64,
) -> Result<Option<i64>, DomainError> {
    record_kept_text_in(
        tx,
        workspace_id,
        captured,
        typing,
        moment_id,
        CAPTURE_RECOVERY_ORIGIN,
        author_json,
        now_ms,
    )
}

/// Keep text a merge removed unseen. The before side holds the removed text,
/// the after side the file as last saved. `author_json` names the change
/// that deleted the line, when this engine knows it.
pub fn record_merge_removal_in(
    conn: &Connection,
    workspace_id: &str,
    captured: &TextSnapshot,
    removed: &str,
    moment_id: &str,
    author_json: Option<&str>,
    now_ms: i64,
) -> Result<Option<i64>, DomainError> {
    record_kept_text_in(
        conn,
        workspace_id,
        captured,
        removed,
        moment_id,
        MERGE_REMOVAL_ORIGIN,
        author_json,
        now_ms,
    )
}

#[allow(clippy::too_many_arguments)]
fn record_kept_text_in(
    tx: &Connection,
    workspace_id: &str,
    captured: &TextSnapshot,
    typing: &str,
    moment_id: &str,
    origin: &str,
    author_json: Option<&str>,
    now_ms: i64,
) -> Result<Option<i64>, DomainError> {
    let typing_sha = dohc_engine_storage::hex_sha256(typing.as_bytes());
    if get_moment(tx, workspace_id, moment_id)?.is_some() {
        return Ok(None);
    }
    text::insert(tx, &typing_sha, typing.len() as i64, typing, true)
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
            now_ms, captured.blob_sha256, typing_sha, origin, captured.latest_moment_id, author_json],
    ).map_err(DomainError::sql_persist)?;
    Ok(Some(order))
}

/// The most of a removal's text a status read carries, in UTF-16 units. The
/// notice quotes less than this; Copy text reads the whole text from History.
pub const MERGE_REMOVAL_QUOTE_UNITS: usize = 1024;
/// The most removals one status read lists, oldest first. Dismissing one
/// brings the next into the list.
pub const MERGE_REMOVALS_LISTED: i64 = 100;

/// Text a merge removed, kept until the person dismisses its notice.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeRemoval {
    pub moment_id: String,
    pub version_id: String,
    pub object_id: String,
    pub path: String,
    /// The text's start, at most [`MERGE_REMOVAL_QUOTE_UNITS`] long.
    pub quote: String,
    /// The whole text's length in UTF-16 units.
    pub length: usize,
    /// The record names the change that deleted the line.
    pub author_known: bool,
}

fn quote_of(text: &str) -> (String, usize) {
    let mut units = 0;
    let mut end = text.len();
    for (at, character) in text.char_indices() {
        if units + character.len_utf16() > MERGE_REMOVAL_QUOTE_UNITS {
            end = end.min(at);
        }
        units += character.len_utf16();
    }
    (text[..end].to_owned(), units)
}

pub fn merge_removals_in(
    conn: &Connection,
    workspace_id: &str,
) -> Result<Vec<MergeRemoval>, DomainError> {
    validate_identifier(workspace_id, "workspace_id")?;
    let mut query = conn
        .prepare(
            "SELECT moment_id,version_id,object_id,path,payload_before_blob_sha256,author_json IS NOT NULL
             FROM moments WHERE workspace_id=?1 AND metadata_origin=?2 ORDER BY moment_order LIMIT ?3",
        )
        .map_err(DomainError::sql_corrupt)?;
    let rows = query
        .query_map(params![workspace_id, MERGE_REMOVAL_ORIGIN, MERGE_REMOVALS_LISTED], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, bool>(5)?,
            ))
        })
        .map_err(DomainError::sql_corrupt)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(DomainError::sql_corrupt)?;
    rows.into_iter()
        .map(
            |(moment_id, version_id, object_id, path, text_sha, author_known)| {
                let (quote, length) =
                    quote_of(&text::read(conn, &text_sha).map_err(DomainError::sql_corrupt)?);
                Ok(MergeRemoval {
                    quote,
                    length,
                    moment_id,
                    version_id,
                    object_id,
                    path,
                    author_known,
                })
            },
        )
        .collect()
}

pub fn capture_recoveries_in(
    conn: &Connection,
    workspace_id: &str,
) -> Result<Vec<CaptureRecovery>, DomainError> {
    validate_identifier(workspace_id, "workspace_id")?;
    let mut query = conn
        .prepare(
            "SELECT m.moment_id,m.version_id,m.object_id,m.path,m.metadata_correlation_id,
             EXISTS(SELECT 1 FROM moments c WHERE c.workspace_id=m.workspace_id AND c.moment_id=m.metadata_correlation_id AND c.operation='delete')
             FROM moments m WHERE m.workspace_id=?1 AND m.metadata_origin=?2 ORDER BY m.moment_order",
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
                deleted: row.get(5)?,
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
    // A merge removal's notice is dismissed the same way.
    conn.execute(
        "UPDATE moments SET metadata_origin=CASE metadata_origin WHEN ?3 THEN ?4 ELSE ?6 END
         WHERE workspace_id=?1 AND moment_id=?2 AND metadata_origin IN (?3,?5)",
        params![
            workspace_id,
            moment_id,
            CAPTURE_RECOVERY_ORIGIN,
            CLEARED_CAPTURE_RECOVERY_ORIGIN,
            MERGE_REMOVAL_ORIGIN,
            CLEARED_MERGE_REMOVAL_ORIGIN
        ],
    )
    .map_err(DomainError::sql_persist)?;
    Ok(())
}

/// A deleted object's History still holds its identity and delete moment.
#[allow(clippy::too_many_arguments)]
pub fn record_deleted_capture_recovery_in_tx(
    tx: &Transaction<'_>,
    workspace_id: &str,
    version_id: &str,
    object_id: &str,
    typing: &str,
    moment_id: &str,
    author_json: Option<&str>,
    now_ms: i64,
) -> Result<bool, DomainError> {
    use rusqlite::OptionalExtension;
    let deleted: Option<(String,String,String)> = tx.query_row(
        "SELECT path,moment_id,operation FROM moments WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3 AND metadata_origin NOT IN ('capture-recovery','capture-recovery-cleared','merge-removal','merge-removal-cleared') ORDER BY moment_order DESC LIMIT 1",
        params![workspace_id,version_id,object_id], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional().map_err(DomainError::sql_corrupt)?;
    let Some((path, delete_id, operation)) = deleted else {
        return Ok(false);
    };
    if operation != "delete" {
        return Ok(false);
    }
    let typing_sha = dohc_engine_storage::hex_sha256(typing.as_bytes());
    text::insert(tx, &typing_sha, typing.len() as i64, typing, true)
        .map_err(DomainError::sql_persist)?;
    let empty_sha = dohc_engine_storage::hex_sha256(b"");
    text::insert(tx, &empty_sha, 0, "", true).map_err(DomainError::sql_persist)?;
    let order = next_moment_order(tx)?;
    tx.execute("INSERT INTO moments(workspace_id,moment_order,moment_id,version_id,object_id,path,recorded_at_ms,operation,after_blob_sha256,before_present,before_blob_sha256,metadata_origin,metadata_correlation_id,author_json,before_content_kind,payload_before_path,payload_before_content_kind,payload_before_blob_sha256,after_content_kind,payload_after_path,payload_after_content_kind,payload_after_blob_sha256) VALUES(?1,?2,?3,?4,?5,?6,?7,'write',?12,2,?8,?9,?10,?11,'text',?6,'text',?8,'text',?6,'text',?12)",
        params![workspace_id,order,moment_id,version_id,object_id,path,now_ms,typing_sha,CAPTURE_RECOVERY_ORIGIN,delete_id,author_json,empty_sha]).map_err(DomainError::sql_persist)?;
    Ok(true)
}
