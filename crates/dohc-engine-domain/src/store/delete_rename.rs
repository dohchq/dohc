use super::{
    VersionedTextStore, alias_object_id, blob_text, committed, get_file_object, get_moment,
    get_snapshot, hash_author_fields, hash_fields, hash_optional_text_fields, lookup_request,
    moment_exists, next_moment_order, record_request, snapshot_text_view, upsert_snapshot,
    validate_addressable_plaintext_path, validate_identifier, validate_moment_id,
    validate_moment_metadata, validate_plaintext_storable_path, version_exists, version_is_active,
};
use crate::error::DomainError;
use crate::records::{
    DeleteResult, DeleteTextFile, MomentOp, MomentRecord, RenameResult, RenameTextFile,
    SnapshotRecord, TextSnapshot,
};
use dohc_engine_storage::{FaultInjector, cancel_pending_jobs_for_path};
use rusqlite::{Connection, Transaction, params};

impl<'a> VersionedTextStore<'a> {
    /// Delete a materialized text file from one version, preserving other
    /// versions of the same object and appending a `delete` moment
    /// (`versions-delete-text-file`).
    pub fn delete_text_file(
        &mut self,
        input: &DeleteTextFile,
        faults: &dyn FaultInjector,
    ) -> Result<DeleteResult, DomainError> {
        let outcome = self
            .store
            .write_with(faults, |tx| delete_text_in_tx(tx, input))?;
        committed(outcome)
    }

    /// Move a text file's version-local alias without changing its object or
    /// content, appending a `rename` moment (`versions-rename-text-file`).
    pub fn rename_text_file(
        &mut self,
        input: &RenameTextFile,
        faults: &dyn FaultInjector,
    ) -> Result<RenameResult, DomainError> {
        self.rename_text_file_with(input, faults, |_, _| Ok(()))
    }

    /// Rename with a caller-supplied same-transaction side effect (the runtime
    /// uses this for FTS maintenance).
    pub fn rename_text_file_with<F>(
        &mut self,
        input: &RenameTextFile,
        faults: &dyn FaultInjector,
        after: F,
    ) -> Result<RenameResult, DomainError>
    where
        F: FnOnce(&Transaction<'_>, &RenameResult) -> Result<(), DomainError>,
    {
        validate_identifier(&input.workspace_id, "workspace_id")?;
        validate_identifier(&input.version_id, "version_id")?;
        validate_moment_id(&input.moment_id)?;
        validate_moment_metadata(
            input.metadata_origin.as_str(),
            input.metadata_summary.as_deref(),
            input.metadata_correlation_id.as_deref(),
            input.author_json.as_deref(),
        )?;
        let mut normalized_input = input.clone();
        normalized_input.from_path = validate_addressable_plaintext_path(&input.from_path)?;
        normalized_input.to_path = validate_plaintext_storable_path(&input.to_path)?;
        let input = &normalized_input;
        if input.from_path == input.to_path {
            return Err(DomainError::InvalidPath {
                reason: "rename source and destination must differ",
            });
        }

        let (author_kind, author_json) = hash_author_fields(input.author_json.as_deref());
        let (summary_kind, summary) = hash_optional_text_fields(input.metadata_summary.as_deref());
        let (correlation_kind, correlation_id) =
            hash_optional_text_fields(input.metadata_correlation_id.as_deref());
        let payload_hash = hash_fields(&[
            input.workspace_id.as_bytes(),
            input.version_id.as_bytes(),
            input.from_path.as_bytes(),
            input.to_path.as_bytes(),
            input.moment_id.as_bytes(),
            input.metadata_origin.as_bytes(),
            summary_kind,
            summary,
            correlation_kind,
            correlation_id,
            author_kind,
            author_json,
        ]);

        let ws = &input.workspace_id;
        if let Some(request_id) = &input.request_id
            && let Some(recorded) = self
                .store
                .read_with(|conn| lookup_request(conn, request_id))?
        {
            if recorded.payload_hash != payload_hash {
                return Err(DomainError::IdempotencyKeyReuseMismatch);
            }
            return self.store.read_with(|conn| reconstruct_rename(conn, input));
        }
        let (object, before) = self.store.read_with(|conn| {
            if !version_exists(conn, ws, &input.version_id)? {
                return Err(DomainError::VersionNotFound);
            }
            let object_id = alias_object_id(conn, ws, &input.version_id, &input.from_path)?
                .ok_or(DomainError::FileNotFound)?;
            let before = get_snapshot(conn, ws, &input.version_id, &object_id)?
                .ok_or(DomainError::FileNotFound)?;
            if let Some(target_object_id) =
                alias_object_id(conn, ws, &input.version_id, &input.to_path)?
                && target_object_id != object_id
            {
                return Err(DomainError::TargetPathExists);
            }
            if moment_exists(conn, ws, &input.moment_id)? {
                return Err(DomainError::DuplicateMomentId);
            }
            let object =
                get_file_object(conn, ws, &object_id)?.ok_or(DomainError::StateCorrupt {
                    reason: "snapshot points at a missing object",
                })?;
            Ok((object, before))
        })?;

        let after_snapshot = SnapshotRecord {
            workspace_id: ws.clone(),
            version_id: input.version_id.clone(),
            object_id: before.object_id.clone(),
            path: input.to_path.clone(),
            text: before.text.clone(),
            blob_sha256: before.blob_sha256.clone(),
            content_kind: before.content_kind.clone(),
            binary_sha256: before.binary_sha256.clone(),
            updated_at_ms: input.now_ms,
            latest_moment_id: input.moment_id.clone(),
            metadata_origin: input.metadata_origin.clone(),
            metadata_summary: input.metadata_summary.clone(),
            metadata_correlation_id: input.metadata_correlation_id.clone(),
        };
        let outcome = self.store.write_with(faults, |tx| {
            let moment_order = next_moment_order(tx)?;
            tx.execute(
                "INSERT INTO moments \
                 (workspace_id, moment_order, moment_id, version_id, object_id, path, \
                  recorded_at_ms, operation, after_blob_sha256, before_present, \
                  before_blob_sha256, before_latest_moment_id, metadata_origin, \
                  metadata_summary, metadata_correlation_id, author_json, \
                  sync_record_only, after_content_kind, after_binary_sha256, \
                  before_content_kind, before_binary_sha256, \
                  payload_before_path, payload_before_content_kind, \
                  payload_before_blob_sha256, \
                  payload_after_path, payload_after_content_kind, \
                  payload_after_blob_sha256) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'rename', ?8, 2, ?8, ?9, ?10, \
                         ?11, ?12, ?13, NULL, ?14, ?15, ?14, ?15, ?16, ?14, \
                         CASE ?14 WHEN 'binary' THEN ?15 ELSE ?8 END, ?6, ?14, \
                         CASE ?14 WHEN 'binary' THEN ?15 ELSE ?8 END)",
                params![
                    ws,
                    moment_order,
                    input.moment_id,
                    input.version_id,
                    before.object_id,
                    input.to_path,
                    input.now_ms,
                    before.blob_sha256,
                    before.latest_moment_id,
                    input.metadata_origin,
                    input.metadata_summary,
                    input.metadata_correlation_id,
                    input.author_json,
                    before.content_kind,
                    before.binary_sha256,
                    // The payload a rename carries moved FROM here; the row's
                    // own path is where it landed.
                    input.from_path,
                ],
            )
            .map_err(DomainError::sql_persist)?;
            crate::collections::index_historical_record_owner_moment_in_tx(tx, ws, moment_order)?;
            tx.execute(
                "DELETE FROM path_aliases WHERE workspace_id = ?1 AND version_id = ?2 \
                 AND path = ?3 AND object_id = ?4",
                params![ws, input.version_id, input.from_path, before.object_id],
            )
            .map_err(DomainError::sql_persist)?;
            tx.execute(
                "INSERT INTO path_aliases (workspace_id, version_id, path, object_id) \
                 VALUES (?1, ?2, ?3, ?4) ON CONFLICT(workspace_id, version_id, path) \
                 DO UPDATE SET object_id = excluded.object_id",
                params![ws, input.version_id, input.to_path, before.object_id],
            )
            .map_err(DomainError::sql_persist)?;
            upsert_snapshot(tx, &after_snapshot)?;

            let result = RenameResult {
                object: object.clone(),
                before: snapshot_text_view(&before),
                after: snapshot_text_view(&after_snapshot),
                moment: get_moment(tx, ws, &input.moment_id)?.ok_or(DomainError::StateCorrupt {
                    reason: "moment vanished within its own write transaction",
                })?,
                deduped: false,
            };
            after(tx, &result)?;
            record_request(
                tx,
                input.request_id.as_deref(),
                &payload_hash,
                moment_order,
                input.now_ms,
            )?;
            Ok::<_, DomainError>(result)
        })?;
        committed(outcome)
    }
}

/// Validate a delete and return the input with its path normalized through the
/// R07 addressable-plaintext floor (only an ignored path is rejected — an
/// existing tracked or secret-shadowed file is still deletable).
fn normalized_delete_input(input: &DeleteTextFile) -> Result<DeleteTextFile, DomainError> {
    validate_identifier(&input.workspace_id, "workspace_id")?;
    validate_identifier(&input.version_id, "version_id")?;
    validate_moment_id(&input.moment_id)?;
    validate_moment_metadata(
        input.metadata_origin.as_str(),
        input.metadata_summary.as_deref(),
        input.metadata_correlation_id.as_deref(),
        input.author_json.as_deref(),
    )?;
    let mut normalized = input.clone();
    normalized.path = validate_addressable_plaintext_path(&input.path)?;
    Ok(normalized)
}

#[doc(hidden)]
pub fn validate_delete_input(input: &DeleteTextFile) -> Result<(), DomainError> {
    normalized_delete_input(input).map(|_| ())
}

fn reconstruct_rename(
    conn: &Connection,
    input: &RenameTextFile,
) -> Result<RenameResult, DomainError> {
    let moment = get_moment(conn, &input.workspace_id, &input.moment_id)?.ok_or(
        DomainError::StateCorrupt {
            reason: "deduped rename has no moment",
        },
    )?;
    if moment.operation != MomentOp::Rename
        || moment.version_id != input.version_id
        || moment.path != input.to_path
        || !moment.before_present
    {
        return Err(DomainError::StateCorrupt {
            reason: "deduped rename moment does not match its request",
        });
    }
    let object = get_file_object(conn, &input.workspace_id, &moment.object_id)?.ok_or(
        DomainError::StateCorrupt {
            reason: "deduped rename points at a missing object",
        },
    )?;
    let before = snapshot_from_moment_before(conn, &input.workspace_id, &moment, &input.from_path)?;
    let after = snapshot_from_moment_after(conn, &input.workspace_id, &moment, &input.to_path)?;
    Ok(RenameResult {
        object,
        before,
        after,
        moment,
        deduped: true,
    })
}

fn snapshot_from_moment_before(
    conn: &Connection,
    workspace_id: &str,
    moment: &MomentRecord,
    path: &str,
) -> Result<TextSnapshot, DomainError> {
    let producer_id =
        moment
            .before_latest_moment_id
            .as_deref()
            .ok_or(DomainError::StateCorrupt {
                reason: "deduped mutation has no preimage producer",
            })?;
    let producer =
        get_moment(conn, workspace_id, producer_id)?.ok_or(DomainError::StateCorrupt {
            reason: "deduped mutation preimage producer is missing",
        })?;
    let (text, sha) = snapshot_content_from_moment_side(
        conn,
        &moment.before_content_kind,
        moment.before_blob_sha256.as_deref(),
        moment.before_binary_sha256.as_deref(),
    )?;
    Ok(TextSnapshot {
        workspace_id: workspace_id.to_owned(),
        version_id: moment.version_id.clone(),
        object_id: moment.object_id.clone(),
        path: path.to_owned(),
        text,
        blob_sha256: sha,
        updated_at_ms: producer.recorded_at_ms,
        latest_moment_id: producer.moment_id,
        metadata_origin: producer.metadata_origin,
        metadata_summary: producer.metadata_summary,
        metadata_correlation_id: producer.metadata_correlation_id,
    })
}

fn snapshot_from_moment_after(
    conn: &Connection,
    workspace_id: &str,
    moment: &MomentRecord,
    path: &str,
) -> Result<TextSnapshot, DomainError> {
    let (text, sha) = snapshot_content_from_moment_side(
        conn,
        &moment.after_content_kind,
        moment.after_blob_sha256.as_deref(),
        moment.after_binary_sha256.as_deref(),
    )?;
    Ok(TextSnapshot {
        workspace_id: workspace_id.to_owned(),
        version_id: moment.version_id.clone(),
        object_id: moment.object_id.clone(),
        path: path.to_owned(),
        text,
        blob_sha256: sha,
        updated_at_ms: moment.recorded_at_ms,
        latest_moment_id: moment.moment_id.clone(),
        metadata_origin: moment.metadata_origin.clone(),
        metadata_summary: moment.metadata_summary.clone(),
        metadata_correlation_id: moment.metadata_correlation_id.clone(),
    })
}

fn snapshot_content_from_moment_side(
    conn: &Connection,
    content_kind: &str,
    text_sha: Option<&str>,
    binary_sha: Option<&str>,
) -> Result<(String, String), DomainError> {
    match content_kind {
        "text" => {
            let sha = text_sha.ok_or(DomainError::StateCorrupt {
                reason: "deduped mutation text side has no blob",
            })?;
            let text = blob_text(conn, sha)?.ok_or(DomainError::StateCorrupt {
                reason: "deduped mutation text blob is missing",
            })?;
            Ok((text, sha.to_owned()))
        }
        "binary" => Ok((
            String::new(),
            binary_sha
                .ok_or(DomainError::StateCorrupt {
                    reason: "deduped mutation binary side has no blob",
                })?
                .to_owned(),
        )),
        _ => Err(DomainError::StateCorrupt {
            reason: "deduped mutation has an unknown content kind",
        }),
    }
}

/// Apply a text delete inside a caller-owned compound transaction.
#[doc(hidden)]
pub fn delete_text_in_tx(
    tx: &Transaction<'_>,
    input: &DeleteTextFile,
) -> Result<DeleteResult, DomainError> {
    let normalized_input = normalized_delete_input(input)?;
    let input = &normalized_input;
    let ws = &input.workspace_id;
    let (author_kind, author_json) = hash_author_fields(input.author_json.as_deref());
    let (summary_kind, summary) = hash_optional_text_fields(input.metadata_summary.as_deref());
    let (correlation_kind, correlation_id) =
        hash_optional_text_fields(input.metadata_correlation_id.as_deref());
    let payload_hash = hash_fields(&[
        input.workspace_id.as_bytes(),
        input.version_id.as_bytes(),
        input.path.as_bytes(),
        input.moment_id.as_bytes(),
        input.metadata_origin.as_bytes(),
        summary_kind,
        summary,
        correlation_kind,
        correlation_id,
        author_kind,
        author_json,
    ]);
    if let Some(request_id) = &input.request_id
        && let Some(recorded) = lookup_request(tx, request_id)?
    {
        if recorded.payload_hash != payload_hash {
            return Err(DomainError::IdempotencyKeyReuseMismatch);
        }
        return reconstruct_delete(tx, input);
    }
    if !version_exists(tx, ws, &input.version_id)? {
        return Err(DomainError::VersionNotFound);
    }
    let object_id = alias_object_id(tx, ws, &input.version_id, &input.path)?
        .ok_or(DomainError::FileNotFound)?;
    let before =
        get_snapshot(tx, ws, &input.version_id, &object_id)?.ok_or(DomainError::FileNotFound)?;
    if moment_exists(tx, ws, &input.moment_id)? {
        return Err(DomainError::DuplicateMomentId);
    }
    let object = get_file_object(tx, ws, &object_id)?.ok_or(DomainError::StateCorrupt {
        reason: "snapshot points at a missing object",
    })?;
    let moment_order = next_moment_order(tx)?;
    tx.execute(
        "INSERT INTO moments \
         (workspace_id, moment_order, moment_id, version_id, object_id, path, recorded_at_ms, \
           operation, after_blob_sha256, before_present, before_blob_sha256, \
           before_latest_moment_id, metadata_origin, metadata_summary, \
           metadata_correlation_id, author_json, sync_record_only, \
           after_content_kind, after_binary_sha256, before_content_kind, before_binary_sha256, \
           payload_before_path, payload_before_content_kind, payload_before_blob_sha256, \
           payload_after_path, payload_after_content_kind, \
           payload_after_blob_sha256) \
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'delete', ?8, 2, ?8, ?9, ?10, \
                  ?11, ?12, ?13, NULL, ?14, ?15, ?14, ?15, ?6, ?14, \
                  CASE ?14 WHEN 'binary' THEN ?15 ELSE ?8 END, ?6, ?14, \
                  CASE ?14 WHEN 'binary' THEN ?15 ELSE ?8 END)",
        params![
            ws,
            moment_order,
            input.moment_id,
            input.version_id,
            before.object_id,
            input.path,
            input.now_ms,
            before.blob_sha256,
            before.latest_moment_id,
            input.metadata_origin,
            input.metadata_summary,
            input.metadata_correlation_id,
            input.author_json,
            before.content_kind,
            before.binary_sha256,
        ],
    )
    .map_err(DomainError::sql_persist)?;
    crate::collections::index_historical_record_owner_moment_in_tx(tx, ws, moment_order)?;
    tx.execute(
        "DELETE FROM path_aliases WHERE workspace_id = ?1 AND version_id = ?2 \
         AND path = ?3 AND object_id = ?4",
        params![ws, input.version_id, input.path, before.object_id],
    )
    .map_err(DomainError::sql_persist)?;
    tx.execute(
        "DELETE FROM snapshots WHERE workspace_id = ?1 AND version_id = ?2 AND object_id = ?3",
        params![ws, input.version_id, before.object_id],
    )
    .map_err(DomainError::sql_persist)?;
    // Must run in this same transaction as the path_aliases removal
    // above — see `cancel_pending_jobs_for_path` for why. Materialization
    // jobs carry no version identity — they mirror the active version's
    // working tree only, the same gate `enqueue_binary_delete` applies to
    // its own job — so an inactive version's delete must not touch them: a
    // named version deleting its own `note.md` must never cancel a pending
    // job that belongs to `main`'s `note.md` of the same name.
    if version_is_active(tx, ws, &input.version_id)? {
        cancel_pending_jobs_for_path(tx, ws, &input.path, input.now_ms)?;
    }

    let result = DeleteResult {
        object,
        before: snapshot_text_view(&before),
        moment: get_moment(tx, ws, &input.moment_id)?.ok_or(DomainError::StateCorrupt {
            reason: "moment vanished within its own write transaction",
        })?,
        deduped: false,
    };
    record_request(
        tx,
        input.request_id.as_deref(),
        &payload_hash,
        moment_order,
        input.now_ms,
    )?;
    Ok(result)
}

fn reconstruct_delete(
    conn: &Connection,
    input: &DeleteTextFile,
) -> Result<DeleteResult, DomainError> {
    let moment = get_moment(conn, &input.workspace_id, &input.moment_id)?.ok_or(
        DomainError::StateCorrupt {
            reason: "deduped delete has no moment",
        },
    )?;
    if moment.version_id != input.version_id || moment.path != input.path {
        return Err(DomainError::StateCorrupt {
            reason: "deduped delete moment does not match its request",
        });
    }
    delete_result_from_moment(conn, &input.workspace_id, moment, true)
}

pub(crate) fn delete_result_from_moment(
    conn: &Connection,
    workspace_id: &str,
    moment: MomentRecord,
    deduped: bool,
) -> Result<DeleteResult, DomainError> {
    if moment.operation != MomentOp::Delete || !moment.before_present {
        return Err(DomainError::StateCorrupt {
            reason: "deduped delete points at a non-delete moment",
        });
    }
    let object = get_file_object(conn, workspace_id, &moment.object_id)?.ok_or(
        DomainError::StateCorrupt {
            reason: "deduped capture retire points at a missing object",
        },
    )?;
    let producer_id =
        moment
            .before_latest_moment_id
            .as_deref()
            .ok_or(DomainError::StateCorrupt {
                reason: "deduped capture retire has no preimage producer",
            })?;
    let producer =
        get_moment(conn, workspace_id, producer_id)?.ok_or(DomainError::StateCorrupt {
            reason: "deduped capture retire preimage producer is missing",
        })?;
    let (text, blob_sha256) = match moment.before_content_kind.as_str() {
        "text" => {
            let sha = moment
                .before_blob_sha256
                .clone()
                .ok_or(DomainError::StateCorrupt {
                    reason: "deduped capture retire has no text preimage",
                })?;
            let text = blob_text(conn, &sha)?.ok_or(DomainError::StateCorrupt {
                reason: "deduped capture retire preimage blob is missing",
            })?;
            (text, sha)
        }
        "binary" => (
            String::new(),
            moment
                .before_binary_sha256
                .clone()
                .ok_or(DomainError::StateCorrupt {
                    reason: "deduped capture retire has no binary preimage",
                })?,
        ),
        _ => {
            return Err(DomainError::StateCorrupt {
                reason: "deduped capture retire has an unknown preimage kind",
            });
        }
    };
    Ok(DeleteResult {
        object,
        before: TextSnapshot {
            workspace_id: workspace_id.to_owned(),
            version_id: moment.version_id.clone(),
            object_id: moment.object_id.clone(),
            path: moment.path.clone(),
            text,
            blob_sha256,
            updated_at_ms: producer.recorded_at_ms,
            latest_moment_id: producer.moment_id,
            metadata_origin: producer.metadata_origin,
            metadata_summary: producer.metadata_summary,
            metadata_correlation_id: producer.metadata_correlation_id,
        },
        moment,
        deduped,
    })
}
