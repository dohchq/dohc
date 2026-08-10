use dohc_engine_collab::DocKey;
use dohc_engine_domain::{SecretMomentRecord, SecretOp, VersionKind, VersionRecord};
use rusqlite::{Transaction, params};

use crate::{
    SyncError, journal_moment_append_in_tx, journal_secret_delete_in_tx, journal_secret_put_in_tx,
    journal_secret_version_fork_in_tx, journal_version_create_in_tx, originate_ydoc_base_in_tx,
};

pub(crate) fn backfill_enrolment_window_in_tx(
    tx: &Transaction<'_>,
    workspace_id: &str,
    now_ms: i64,
) -> Result<(), SyncError> {
    backfill_ydoc_bases(tx, workspace_id, now_ms)?;
    backfill_moments(tx, workspace_id)?;
    backfill_versions(tx, workspace_id)?;
    backfill_secret_moments(tx, workspace_id)
}

fn backfill_ydoc_bases(
    tx: &Transaction<'_>,
    workspace_id: &str,
    now_ms: i64,
) -> Result<(), SyncError> {
    let rows = {
        let mut statement = tx
            .prepare(
                "SELECT d.version_id, d.object_id, s.path FROM ydoc_docs d \
                 JOIN snapshots s ON s.workspace_id=d.workspace_id \
                   AND s.version_id=d.version_id AND s.object_id=d.object_id \
                 JOIN file_objects o ON o.workspace_id=s.workspace_id \
                   AND o.object_id=s.object_id \
                 WHERE d.workspace_id=?1 AND d.base_claimed=0 \
                 ORDER BY d.version_id, d.object_id",
            )
            .map_err(SyncError::corrupt)?;
        statement
            .query_map([workspace_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .map_err(SyncError::corrupt)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(SyncError::corrupt)?
    };
    for (version_id, object_id, path) in rows {
        let key = DocKey {
            workspace_id: workspace_id.to_owned(),
            version_id,
            object_id,
        };
        let _ = originate_ydoc_base_in_tx(tx, &key, &path, now_ms)?;
    }
    Ok(())
}

fn backfill_moments(tx: &Transaction<'_>, workspace_id: &str) -> Result<(), SyncError> {
    let moment_ids = collect_ids(
        tx,
        "SELECT moment_id FROM moments WHERE workspace_id=?1 \
         ORDER BY recorded_at_ms, moment_id",
        workspace_id,
    )?;
    for moment_id in moment_ids {
        journal_moment_append_in_tx(tx, workspace_id, &moment_id)?;
    }
    Ok(())
}

fn backfill_versions(tx: &Transaction<'_>, workspace_id: &str) -> Result<(), SyncError> {
    let records = {
        let mut statement = tx
            .prepare(
                "SELECT version_id, kind, name, created_at_ms, fork_version_id, fork_moment_id \
                 FROM versions WHERE workspace_id=?1 ORDER BY created_at_ms, version_id",
            )
            .map_err(SyncError::corrupt)?;
        statement
            .query_map([workspace_id], |row| {
                let raw_kind = row.get::<_, String>(1)?;
                let kind = match raw_kind.as_str() {
                    "main" => VersionKind::Main,
                    "named" => VersionKind::Named,
                    _ => {
                        return Err(rusqlite::Error::InvalidColumnType(
                            1,
                            "kind".to_owned(),
                            rusqlite::types::Type::Text,
                        ));
                    }
                };
                Ok(VersionRecord {
                    workspace_id: workspace_id.to_owned(),
                    version_id: row.get(0)?,
                    kind,
                    name: row.get(2)?,
                    created_at_ms: row.get(3)?,
                    fork_version_id: row.get(4)?,
                    fork_moment_id: row.get(5)?,
                })
            })
            .map_err(SyncError::corrupt)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(SyncError::corrupt)?
    };
    for record in records {
        journal_version_create_in_tx(tx, &record)?;
        if let Some(from_version_id) = &record.fork_version_id {
            journal_secret_version_fork_in_tx(
                tx,
                &record.workspace_id,
                from_version_id,
                &record.version_id,
                record.created_at_ms,
            )?;
        }
    }
    Ok(())
}

fn backfill_secret_moments(tx: &Transaction<'_>, workspace_id: &str) -> Result<(), SyncError> {
    let records = {
        let mut statement = tx
            .prepare(
                "SELECT moment_order, moment_id, workspace_id, version_id, path, recorded_at_ms, \
                 operation, metadata_origin, metadata_summary, metadata_correlation_id \
                 FROM secret_moments WHERE workspace_id=?1 ORDER BY moment_order",
            )
            .map_err(SyncError::corrupt)?;
        statement
            .query_map([workspace_id], |row| {
                let raw_operation = row.get::<_, String>(6)?;
                let operation = match raw_operation.as_str() {
                    "write" => SecretOp::Write,
                    "delete" => SecretOp::Delete,
                    _ => {
                        return Err(rusqlite::Error::InvalidColumnType(
                            6,
                            "operation".to_owned(),
                            rusqlite::types::Type::Text,
                        ));
                    }
                };
                Ok(SecretMomentRecord {
                    moment_order: row.get(0)?,
                    moment_id: row.get(1)?,
                    workspace_id: row.get(2)?,
                    version_id: row.get(3)?,
                    path: row.get(4)?,
                    recorded_at_ms: row.get(5)?,
                    operation,
                    metadata_origin: row.get(7)?,
                    metadata_summary: row.get(8)?,
                    metadata_correlation_id: row.get(9)?,
                })
            })
            .map_err(SyncError::corrupt)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(SyncError::corrupt)?
    };
    for record in records {
        match record.operation {
            SecretOp::Write => journal_secret_put_in_tx(tx, &record)?,
            SecretOp::Delete => journal_secret_delete_in_tx(tx, &record)?,
        }
    }
    Ok(())
}

fn collect_ids(
    tx: &Transaction<'_>,
    sql: &str,
    workspace_id: &str,
) -> Result<Vec<String>, SyncError> {
    let mut statement = tx.prepare(sql).map_err(SyncError::corrupt)?;
    statement
        .query_map(params![workspace_id], |row| row.get(0))
        .map_err(SyncError::corrupt)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(SyncError::corrupt)
}
