use super::{
    alias_object_id, blob_text, get_moment, get_snapshot, hash_fields, lookup_request,
    record_request, rename_text_in_tx, validate_identifier, validate_moment_metadata,
    validate_plaintext_storable_path, write_history_text_in_tx,
};
use crate::{DomainError, MomentRecord, RenameTextFile, WriteText};
use rusqlite::{Connection, Transaction, params};
use serde::{Deserialize, Serialize};

pub const OPERATION_ID_PREFIX: &str = "dohc-operation:";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationMoment {
    pub moment_id: String,
    pub object_id: String,
    pub operation: String,
    pub path: String,
    pub before_path: Option<String>,
    pub moment_order: i64,
}

pub fn operation_moments_in(
    conn: &Connection,
    ws: &str,
    version: &str,
    operation: &str,
) -> Result<Vec<OperationMoment>, DomainError> {
    validate_identifier(operation, "operation_id")?;
    if !operation.starts_with(OPERATION_ID_PREFIX) {
        return Err(DomainError::InvalidInput {
            reason: "invalid operation id",
        });
    }
    let mut stmt = conn.prepare_cached("SELECT m.moment_id,m.object_id,m.operation,m.path,m.payload_before_path,m.moment_order FROM moments m
        WHERE m.workspace_id=?1 AND m.metadata_correlation_id=?2 AND m.version_id=?3 AND coalesce(m.sync_record_only,0)=0
        AND NOT EXISTS (SELECT 1 FROM replication_log r WHERE r.workspace_id=m.workspace_id AND r.imported=1
            AND r.op_kind='moment.append' AND json_extract(r.payload_json,'$.momentId')=m.moment_id)
        AND NOT EXISTS (SELECT 1 FROM materialization_jobs j WHERE j.workspace_id=m.workspace_id AND j.job_id='restore-delete-mat_'||m.moment_id)
        ORDER BY m.moment_order DESC").map_err(DomainError::sql_corrupt)?;
    stmt.query_map(params![ws, operation, version], |r| {
        Ok(OperationMoment {
            moment_id: r.get(0)?,
            object_id: r.get(1)?,
            operation: r.get(2)?,
            path: r.get(3)?,
            before_path: r.get(4)?,
            moment_order: r.get(5)?,
        })
    })
    .map_err(DomainError::sql_corrupt)?
    .collect::<Result<Vec<_>, _>>()
    .map_err(DomainError::sql_corrupt)
}

pub fn undo_correlation_id(ws: &str, operation: &str, request: &str) -> String {
    format!(
        "{OPERATION_ID_PREFIX}undo:{}",
        hash_fields(&[ws.as_bytes(), operation.as_bytes(), request.as_bytes()])
    )
}

#[allow(clippy::too_many_arguments)]
pub fn undo_operation_in_tx<F>(
    tx: &Transaction<'_>,
    ws: &str,
    version: &str,
    operation: &str,
    request: &str,
    author: Option<&str>,
    now: i64,
    mut after: F,
) -> Result<(Vec<OperationMoment>, bool), DomainError>
where
    F: FnMut(&Transaction<'_>, &MomentRecord) -> Result<(), DomainError>,
{
    validate_identifier(request, "request_id")?;
    validate_moment_metadata("restore", Some("Undo"), Some(operation), author)?;
    let correlation = undo_correlation_id(ws, operation, request);
    let fingerprint = hash_fields(&[
        b"history.undo",
        ws.as_bytes(),
        operation.as_bytes(),
        author.unwrap_or("").as_bytes(),
    ]);
    if let Some(recorded) = lookup_request(tx, request)? {
        if recorded.payload_hash != fingerprint {
            return Err(DomainError::IdempotencyKeyReuseMismatch);
        }
        let original_version: String = tx
            .query_row(
                "SELECT version_id FROM moments WHERE workspace_id=?1 AND moment_order=?2",
                params![ws, recorded.result_seq],
                |r| r.get(0),
            )
            .map_err(DomainError::sql_corrupt)?;
        return Ok((
            operation_moments_in(tx, ws, &original_version, &correlation)?,
            true,
        ));
    }
    let originals = operation_moments_in(tx, ws, version, operation)?;
    if originals.is_empty() {
        return Err(DomainError::UndoRefused {
            path: operation.into(),
            reason: "operation unavailable",
        });
    }
    let mut objects = std::collections::HashSet::new();
    for effect in &originals {
        if !objects.insert(&effect.object_id) {
            return Err(DomainError::UndoRefused {
                path: effect.path.clone(),
                reason: "multiple changes to one object",
            });
        }
        let old = if effect.operation == "rename" {
            effect
                .before_path
                .as_deref()
                .ok_or(DomainError::StateCorrupt {
                    reason: "rename has no old path",
                })?
        } else {
            &effect.path
        };
        validate_plaintext_storable_path(old)?;
        if let Some(occupant) = alias_object_id(tx, ws, version, old)? {
            return Err(DomainError::UndoRefused {
                path: old.into(),
                reason: if occupant == effect.object_id {
                    "object already restored"
                } else {
                    "old path occupied"
                },
            });
        }
        let current = get_snapshot(tx, ws, version, &effect.object_id)?;
        match effect.operation.as_str() {
            "rename"
                if current
                    .as_ref()
                    .is_some_and(|head| head.path == effect.path) => {}
            "delete" if current.is_none() => {}
            "rename" | "delete" => {
                return Err(DomainError::UndoRefused {
                    path: current.map_or(effect.path.clone(), |h| h.path),
                    reason: "object moved or removed",
                });
            }
            _ => {
                return Err(DomainError::UndoRefused {
                    path: effect.path.clone(),
                    reason: "unsupported inverse",
                });
            }
        }
    }
    let mut last_order = -1;
    for effect in originals {
        let id = format!(
            "undo-{}",
            hash_fields(&[correlation.as_bytes(), effect.moment_id.as_bytes()])
        );
        let moment = if effect.operation == "rename" {
            rename_text_in_tx(
                tx,
                &RenameTextFile {
                    workspace_id: ws.into(),
                    version_id: version.into(),
                    from_path: effect.path,
                    to_path: effect.before_path.unwrap(),
                    moment_id: id,
                    request_id: None,
                    metadata_origin: "restore".into(),
                    metadata_summary: Some("Undo".into()),
                    metadata_correlation_id: Some(correlation.clone()),
                    author_json: author.map(str::to_owned),
                    now_ms: now,
                },
                |_, _| Ok(()),
            )?
            .moment
        } else {
            let source = get_moment(tx, ws, &effect.moment_id)?.ok_or(DomainError::FileNotFound)?;
            if !source.before_present {
                return Err(DomainError::UndoRefused {
                    path: effect.path,
                    reason: "retained content unavailable",
                });
            }
            if source.before_content_kind == "binary" {
                let sha =
                    source
                        .before_binary_sha256
                        .as_deref()
                        .ok_or(DomainError::UndoRefused {
                            path: effect.path.clone(),
                            reason: "retained content unavailable",
                        })?;
                tx.execute("INSERT INTO path_aliases(workspace_id,version_id,path,object_id) VALUES (?1,?2,?3,?4)",params![ws,version,effect.path,effect.object_id]).map_err(DomainError::sql_persist)?;
                crate::conflicts::persist_binary_head_in_tx(
                    tx,
                    &crate::conflicts::PersistBinaryHead {
                        workspace_id: ws,
                        version_id: version,
                        object_id: &effect.object_id,
                        path: &effect.path,
                        binary_sha256: sha,
                        moment_id: &id,
                        metadata_origin: "restore",
                        metadata_summary: Some("Undo"),
                        metadata_correlation_id: Some(&correlation),
                        author_json: author,
                        now_ms: now,
                    },
                    None,
                )?;
                get_moment(tx, ws, &id)?.ok_or(DomainError::StateCorrupt {
                    reason: "binary inverse lost moment",
                })?
            } else {
                let text = blob_text(
                    tx,
                    source
                        .before_blob_sha256
                        .as_deref()
                        .ok_or(DomainError::StateCorrupt {
                            reason: "delete has no preimage",
                        })?,
                )?
                .ok_or(DomainError::UndoRefused {
                    path: effect.path.clone(),
                    reason: "retained content unavailable",
                })?;
                write_history_text_in_tx(
                    tx,
                    &WriteText {
                        workspace_id: ws.into(),
                        version_id: version.into(),
                        object_id: effect.object_id,
                        path: effect.path,
                        text,
                        moment_id: id,
                        request_id: None,
                        metadata_origin: "restore".into(),
                        metadata_summary: Some("Undo".into()),
                        metadata_correlation_id: Some(correlation.clone()),
                        author_json: author.map(str::to_owned),
                        now_ms: now,
                    },
                    &source.moment_id,
                )?
                .moment
            }
        };
        after(tx, &moment)?;
        last_order = moment.moment_order;
    }
    record_request(tx, Some(request), &fingerprint, last_order, now)?;
    Ok((operation_moments_in(tx, ws, version, &correlation)?, false))
}
