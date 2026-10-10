use super::{VersionedTextStore, get_version, map_version_row};
use crate::{DomainError, MomentOp, SecretMomentRecord, SecretOp, VersionRecord};
use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistoryMomentPosition {
    pub recorded_at_ms: i64,
    pub moment_order: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistoryMarkerPosition {
    pub created_at_ms: i64,
    pub version_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistoryCursor {
    pub format: u32,
    pub engine_uuid: String,
    pub workspace_id: String,
    pub version_id: String,
    pub object_id: Option<String>,
    pub text_fence: i64,
    pub protected_fence: i64,
    // Version rows are append-only. Their rowid fences imported old-dated forks too.
    pub marker_fence: i64,
    pub text: Option<HistoryMomentPosition>,
    pub protected: Option<HistoryMomentPosition>,
    pub marker: Option<HistoryMarkerPosition>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HistoryMomentMetadata {
    pub moment_order: i64,
    pub moment_id: String,
    pub version_id: String,
    pub object_id: String,
    pub path: String,
    pub recorded_at_ms: i64,
    pub operation: MomentOp,
    pub after_content_kind: String,
    pub after_byte_length: Option<i64>,
    pub metadata_origin: String,
    pub metadata_summary: Option<String>,
    pub metadata_correlation_id: Option<String>,
    pub author_json: Option<String>,
    pub sync_record_only: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HistoryPageRead {
    pub active_version: VersionRecord,
    pub cursor: HistoryCursor,
    // Each stream includes a limit+1 probe. RPC advances only rows it emits.
    pub moments: Vec<HistoryMomentMetadata>,
    pub protected_moments: Vec<SecretMomentRecord>,
    pub version_markers: Vec<VersionRecord>,
}

impl VersionedTextStore<'_> {
    pub fn history_page(
        &self,
        workspace_id: &str,
        version_id: Option<&str>,
        object_id: Option<&str>,
        limit: usize,
        cursor: Option<HistoryCursor>,
    ) -> Result<HistoryPageRead, DomainError> {
        if !(1..=50).contains(&limit) || object_id == Some("") {
            return Err(DomainError::InvalidInput {
                reason: "invalid history page scope or limit",
            });
        }
        let active_version = self.get_active_version(workspace_id)?;
        let selected_version_id = version_id.unwrap_or(&active_version.version_id).to_owned();
        let version_id = selected_version_id.as_str();
        let engine_uuid = self.store.engine_uuid().map_err(DomainError::from)?;
        self.store.read_with(|conn| {
            get_version(conn, workspace_id, version_id)?.ok_or(DomainError::VersionNotFound)?;
            let cursor = match cursor {
                Some(cursor) => {
                    let valid_position = |position: &Option<HistoryMomentPosition>, fence: i64| {
                        position
                            .as_ref()
                            .is_none_or(|p| p.moment_order >= 0 && p.moment_order <= fence)
                    };
                    let object_streams_empty = object_id.is_none()
                        || (cursor.protected_fence == -1
                            && cursor.marker_fence == -1
                            && cursor.protected.is_none()
                            && cursor.marker.is_none());
                    if cursor.format != 1
                        || cursor.engine_uuid != engine_uuid
                        || cursor.workspace_id != workspace_id
                        || cursor.version_id != version_id
                        || cursor.object_id.as_deref() != object_id
                        || cursor.text_fence < -1
                        || cursor.protected_fence < -1
                        || cursor.marker_fence < -1
                        || !valid_position(&cursor.text, cursor.text_fence)
                        || !valid_position(&cursor.protected, cursor.protected_fence)
                        || !object_streams_empty
                    {
                        return Err(DomainError::InvalidInput {
                            reason: "history cursor scope or store changed; refresh history",
                        });
                    }
                    cursor
                }
                None => {
                    HistoryCursor {
                        format: 1,
                        engine_uuid,
                        workspace_id: workspace_id.to_owned(),
                        version_id: version_id.to_owned(),
                        object_id: object_id.map(str::to_owned),
                        text_fence: conn
                            .query_row(
                                text_fence_query(object_id.is_some()),
                                rusqlite::params_from_iter(
                                    [Some(workspace_id), Some(version_id)]
                                        .into_iter()
                                        .chain(object_id.map(Some)),
                                ),
                                |r| r.get(0),
                            )
                            .map_err(DomainError::sql_corrupt)?,
                        protected_fence: if object_id.is_some() {
                            -1
                        } else {
                            conn.query_row(
                                "SELECT COALESCE(MAX(moment_order),-1) FROM secret_moments \
                             WHERE workspace_id=?1 AND version_id=?2",
                                params![workspace_id, version_id],
                                |r| r.get(0),
                            )
                            .map_err(DomainError::sql_corrupt)?
                        },
                        marker_fence: if object_id.is_some() {
                            -1
                        } else {
                            conn.query_row(
                            "SELECT COALESCE(MAX(rowid),-1) FROM versions WHERE workspace_id=?1",
                            [workspace_id], |r| r.get(0),
                        ).map_err(DomainError::sql_corrupt)?
                        },
                        text: None,
                        protected: None,
                        marker: None,
                    }
                }
            };
            let moments = read_text(conn, &cursor, limit + 1)?;
            let protected_moments = if object_id.is_some() {
                Vec::new()
            } else {
                read_protected(conn, &cursor, limit + 1)?
            };
            let version_markers = if object_id.is_some() {
                Vec::new()
            } else {
                read_markers(conn, &cursor, limit + 1)?
            };
            Ok(HistoryPageRead {
                active_version,
                cursor,
                moments,
                protected_moments,
                version_markers,
            })
        })
    }
}

fn text_fence_query(object: bool) -> &'static str {
    if object {
        "SELECT COALESCE(MAX(moment_order),-1) FROM moments WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3"
    } else {
        "SELECT COALESCE(MAX(moment_order),-1) FROM moments WHERE workspace_id=?1 AND version_id=?2"
    }
}

fn read_text(
    conn: &Connection,
    cursor: &HistoryCursor,
    limit: usize,
) -> Result<Vec<HistoryMomentMetadata>, DomainError> {
    let (sql, binds) = text_query(cursor, limit);
    let mut stmt = conn.prepare(&sql).map_err(DomainError::sql_corrupt)?;
    let refs = binds.iter().map(|b| b.as_ref()).collect::<Vec<_>>();
    let rows = stmt
        .query_map(refs.as_slice(), map_history_text_row)
        .map_err(DomainError::sql_corrupt)?;
    rows.map(|r| r.map_err(DomainError::sql_corrupt)?).collect()
}

fn text_query(cursor: &HistoryCursor, limit: usize) -> (String, Vec<Box<dyn rusqlite::ToSql>>) {
    // The admission fence must not make SQLite sort all eligible rows before LIMIT.
    let index = if cursor.object_id.is_some() {
        "idx_moments_object_history_time"
    } else {
        "idx_moments_history_time"
    };
    // No payload column is selected, including for oversized live-document blobs.
    let mut sql = format!(
        "SELECT m.moment_order,m.moment_id,m.version_id,m.object_id,m.path,m.recorded_at_ms,m.operation, \
         COALESCE(m.after_content_kind,'text'),COALESCE(b.byte_length,bb.byte_length), \
         m.metadata_origin,m.metadata_summary,m.metadata_correlation_id,m.author_json,COALESCE(m.sync_record_only,0) \
         FROM moments m INDEXED BY {index} \
         LEFT JOIN blobs b ON b.sha256=m.after_blob_sha256 \
         LEFT JOIN binary_blobs bb ON bb.sha256=m.after_binary_sha256 \
         WHERE m.workspace_id=?1 AND m.version_id=?2 AND m.moment_order<=?3 \
         AND NOT EXISTS (SELECT 1 FROM materialization_jobs j \
         WHERE j.workspace_id=m.workspace_id AND j.job_id='restore-delete-mat_'||m.moment_id)",
    );
    let mut binds: Vec<Box<dyn rusqlite::ToSql>> = vec![
        Box::new(cursor.workspace_id.clone()),
        Box::new(cursor.version_id.clone()),
        Box::new(cursor.text_fence),
    ];
    if let Some(object_id) = &cursor.object_id {
        sql.push_str(&format!(" AND m.object_id=?{}", binds.len() + 1));
        binds.push(Box::new(object_id.clone()));
    }
    if let Some(position) = &cursor.text {
        sql.push_str(&format!(
            " AND (m.recorded_at_ms,m.moment_order)<(?{},?{})",
            binds.len() + 1,
            binds.len() + 2
        ));
        binds.push(Box::new(position.recorded_at_ms));
        binds.push(Box::new(position.moment_order));
    }
    sql.push_str(&format!(
        " ORDER BY m.recorded_at_ms DESC,m.moment_order DESC LIMIT ?{}",
        binds.len() + 1
    ));
    binds.push(Box::new(limit as i64));
    (sql, binds)
}

fn map_history_text_row(
    r: &rusqlite::Row<'_>,
) -> rusqlite::Result<Result<HistoryMomentMetadata, DomainError>> {
    let operation: String = r.get(6)?;
    let mut moment = HistoryMomentMetadata {
        moment_order: r.get(0)?,
        moment_id: r.get(1)?,
        version_id: r.get(2)?,
        object_id: r.get(3)?,
        path: r.get(4)?,
        recorded_at_ms: r.get(5)?,
        operation: MomentOp::Write,
        after_content_kind: r.get(7)?,
        after_byte_length: r.get(8)?,
        metadata_origin: r.get(9)?,
        metadata_summary: r.get(10)?,
        metadata_correlation_id: r.get(11)?,
        author_json: r.get(12)?,
        sync_record_only: r.get::<_, i64>(13)? != 0,
    };
    Ok(MomentOp::from_db(&operation).map(|operation| {
        moment.operation = operation;
        moment
    }))
}

fn read_protected(
    conn: &Connection,
    cursor: &HistoryCursor,
    limit: usize,
) -> Result<Vec<SecretMomentRecord>, DomainError> {
    let mut sql = String::from(
        "SELECT moment_order,moment_id,workspace_id,version_id,path,recorded_at_ms,operation,metadata_origin,metadata_summary,metadata_correlation_id FROM secret_moments WHERE workspace_id=?1 AND version_id=?2 AND moment_order<=?3",
    );
    let mut binds: Vec<Box<dyn rusqlite::ToSql>> = vec![
        Box::new(cursor.workspace_id.clone()),
        Box::new(cursor.version_id.clone()),
        Box::new(cursor.protected_fence),
    ];
    if let Some(p) = &cursor.protected {
        sql.push_str(" AND (recorded_at_ms,moment_order)<(?4,?5)");
        binds.push(Box::new(p.recorded_at_ms));
        binds.push(Box::new(p.moment_order));
    }
    sql.push_str(&format!(
        " ORDER BY recorded_at_ms DESC,moment_order DESC LIMIT ?{}",
        binds.len() + 1
    ));
    binds.push(Box::new(limit as i64));
    let refs = binds.iter().map(|b| b.as_ref()).collect::<Vec<_>>();
    let mut stmt = conn.prepare(&sql).map_err(DomainError::sql_corrupt)?;
    let rows = stmt
        .query_map(refs.as_slice(), |r| {
            let operation: String = r.get(6)?;
            let mut moment = SecretMomentRecord {
                moment_order: r.get(0)?,
                moment_id: r.get(1)?,
                workspace_id: r.get(2)?,
                version_id: r.get(3)?,
                path: r.get(4)?,
                recorded_at_ms: r.get(5)?,
                operation: SecretOp::Write,
                metadata_origin: r.get(7)?,
                metadata_summary: r.get(8)?,
                metadata_correlation_id: r.get(9)?,
            };
            Ok(SecretOp::from_db(&operation).map(|operation| {
                moment.operation = operation;
                moment
            }))
        })
        .map_err(DomainError::sql_corrupt)?;
    rows.map(|r| r.map_err(DomainError::sql_corrupt)?).collect()
}
fn read_markers(
    conn: &Connection,
    cursor: &HistoryCursor,
    limit: usize,
) -> Result<Vec<VersionRecord>, DomainError> {
    let mut sql = String::from(
        "SELECT workspace_id,version_id,kind,name,created_at_ms,fork_version_id,fork_moment_id FROM versions WHERE workspace_id=?1 AND rowid<=?2",
    );
    let mut binds: Vec<Box<dyn rusqlite::ToSql>> = vec![
        Box::new(cursor.workspace_id.clone()),
        Box::new(cursor.marker_fence),
    ];
    if let Some(p) = &cursor.marker {
        sql.push_str(" AND (created_at_ms,version_id)<(?3,?4)");
        binds.push(Box::new(p.created_at_ms));
        binds.push(Box::new(p.version_id.clone()));
    }
    sql.push_str(&format!(
        " ORDER BY created_at_ms DESC,version_id DESC LIMIT ?{}",
        binds.len() + 1
    ));
    binds.push(Box::new(limit as i64));
    let refs = binds.iter().map(|b| b.as_ref()).collect::<Vec<_>>();
    let mut stmt = conn.prepare(&sql).map_err(DomainError::sql_corrupt)?;
    let rows = stmt
        .query_map(refs.as_slice(), map_version_row)
        .map_err(DomainError::sql_corrupt)?;
    rows.map(|r| r.map_err(DomainError::sql_corrupt)?).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn history_text_query_uses_the_time_index_without_a_sort() {
        let dir = dohc_engine_testkit::ScratchDir::new().unwrap();
        let store = dohc_engine_storage::EngineStore::open(
            &dohc_engine_testkit::engine_db_path(&dir).unwrap(),
            1,
        )
        .unwrap();
        for position in [
            None,
            Some(HistoryMomentPosition {
                recorded_at_ms: 100,
                moment_order: 10,
            }),
        ] {
            let cursor = HistoryCursor {
                format: 1,
                engine_uuid: "test".into(),
                workspace_id: "ws".into(),
                version_id: "main".into(),
                object_id: None,
                text_fence: 100,
                protected_fence: -1,
                marker_fence: -1,
                text: position,
                protected: None,
                marker: None,
            };
            let (sql, binds) = text_query(&cursor, 51);
            let plans: Vec<String> = store
                .read_with(|conn| {
                    let mut stmt = conn.prepare(&format!("EXPLAIN QUERY PLAN {sql}"))?;
                    let refs = binds.iter().map(|b| b.as_ref()).collect::<Vec<_>>();
                    stmt.query_map(refs.as_slice(), |r| r.get(3))?
                        .collect::<Result<Vec<String>, rusqlite::Error>>()
                })
                .unwrap();
            assert!(
                plans.iter().any(|p| p.contains("idx_moments_history_time")),
                "{plans:?}"
            );
            assert!(
                !plans.iter().any(|p| p.contains("TEMP B-TREE")),
                "{plans:?}"
            );
        }
    }

    #[test]
    fn object_history_page_and_fence_search_object_indexes_without_scanning() {
        let dir = dohc_engine_testkit::ScratchDir::new().unwrap();
        let store = dohc_engine_storage::EngineStore::open(
            &dohc_engine_testkit::engine_db_path(&dir).unwrap(),
            1,
        )
        .unwrap();
        for position in [
            None,
            Some(HistoryMomentPosition {
                recorded_at_ms: 100,
                moment_order: 10,
            }),
        ] {
            let cursor = HistoryCursor {
                format: 1,
                engine_uuid: "test".into(),
                workspace_id: "ws".into(),
                version_id: "main".into(),
                object_id: Some("object".into()),
                text_fence: 100,
                protected_fence: -1,
                marker_fence: -1,
                text: position,
                protected: None,
                marker: None,
            };
            let (sql, binds) = text_query(&cursor, 51);
            let plans: Vec<String> = store
                .read_with(|conn| {
                    let mut stmt = conn.prepare(&format!("EXPLAIN QUERY PLAN {sql}"))?;
                    let refs = binds.iter().map(|b| b.as_ref()).collect::<Vec<_>>();
                    stmt.query_map(refs.as_slice(), |r| r.get(3))?
                        .collect::<Result<Vec<String>, rusqlite::Error>>()
                })
                .unwrap();
            assert!(
                plans.iter().any(|p| p
                    .contains("SEARCH m USING INDEX idx_moments_object_history_time")
                    && p.contains("object_id=?")),
                "{plans:?}"
            );
            assert!(
                !plans
                    .iter()
                    .any(|p| p.contains("SCAN m") || p.contains("TEMP B-TREE")),
                "{plans:?}"
            );
        }
        let plans: Vec<String> = store
            .read_with(|conn| {
                let mut stmt =
                    conn.prepare(&format!("EXPLAIN QUERY PLAN {}", text_fence_query(true)))?;
                stmt.query_map(params!["ws", "main", "object"], |r| r.get(3))?
                    .collect::<Result<Vec<String>, rusqlite::Error>>()
            })
            .unwrap();
        assert!(
            plans.iter().any(|p| p.contains("SEARCH moments USING")
                && p.contains("idx_moments_object")
                && p.contains("object_id=?")),
            "{plans:?}"
        );
        assert!(
            !plans.iter().any(|p| p.contains("SCAN moments")),
            "{plans:?}"
        );
    }
}
