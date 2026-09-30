use super::{
    MomentBeforeState, VersionedTextStore, alias_object_id, blob_text, committed, get_moment,
    get_version, hash_author_fields, hash_fields, lookup_request, map_moment_row, map_version_row,
    next_moment_order, record_request, upsert_snapshot, validate_addressable_plaintext_path,
    validate_identifier, validate_moment_metadata, version_exists, version_is_active,
};
use crate::conflicts::{
    binary_delete_job_id, binary_rename_delete_job_id, binary_rename_write_job_id,
};
use crate::error::DomainError;
use crate::records::{
    MomentOp, MomentRecord, RollbackTextFileMutation, SnapshotRecord, VersionRecord,
};
use dohc_engine_storage::{
    FaultInjector, MaterializationJobSpec, Preimage, enqueue_delete_job, enqueue_job,
    put_binary_blob,
};
use rusqlite::{Connection, OptionalExtension, Transaction, params};
use std::collections::{HashMap, HashSet};

impl<'a> VersionedTextStore<'a> {
    /// Remove one latest local mutation and restore its recorded preimage
    /// through a compensating moment. Returns `true` for matching request
    /// replay and `false` for a fresh rollback.
    ///
    /// This wrapper adds no outbound row. Runtime composition journals the
    /// compensating moment through [`Self::rollback_text_file_mutation_with`].
    pub fn rollback_text_file_mutation(
        &mut self,
        input: &RollbackTextFileMutation,
        faults: &dyn FaultInjector,
    ) -> Result<bool, DomainError> {
        self.rollback_text_file_mutation_with(input, faults, |_, _| Ok(()), |_, _, _, _, _| Ok(()))
    }

    /// Roll back with callbacks in the same transaction. Before removal, the
    /// first callback receives the original moment. The second receives
    /// the mutated object id, the restored text head, if present, the
    /// compensating moment id, and its recorded time.
    ///
    /// Matching request replay skips both callbacks. Fresh rollback invokes the
    /// second after restoring state and inserting the compensating moment,
    /// before recording the request and committing. A callback error aborts the
    /// transaction; callback effects outside the database cannot be rolled back.
    /// The runtime composes Y.Doc/FTS reconciliation and outbound journaling here.
    /// See [`Self::rollback_text_file_mutation`] for the boolean return value.
    pub fn rollback_text_file_mutation_with<B, F>(
        &mut self,
        input: &RollbackTextFileMutation,
        faults: &dyn FaultInjector,
        before_remove: B,
        after: F,
    ) -> Result<bool, DomainError>
    where
        B: FnOnce(&Transaction<'_>, &MomentRecord) -> Result<(), DomainError>,
        F: FnOnce(
            &Transaction<'_>,
            &str,
            Option<(&str, &str)>,
            &str,
            i64,
        ) -> Result<(), DomainError>,
    {
        validate_identifier(&input.workspace_id, "workspace_id")?;
        validate_identifier(&input.version_id, "version_id")?;
        validate_identifier(&input.mutation_moment_id, "moment_id")?;
        validate_moment_metadata(
            input.metadata_origin.as_str(),
            None,
            None,
            input.author_json.as_deref(),
        )?;
        let mut normalized_input = input.clone();
        normalized_input.path = validate_addressable_plaintext_path(&input.path)?;
        let input = &normalized_input;

        let (author_kind, author_json) = hash_author_fields(input.author_json.as_deref());
        let payload_hash = hash_fields(&[
            input.workspace_id.as_bytes(),
            input.version_id.as_bytes(),
            input.path.as_bytes(),
            input.mutation_moment_id.as_bytes(),
            input.metadata_origin.as_bytes(),
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
            return Ok(true);
        }
        let prep = self.store.read_with(|conn| {
            if !version_exists(conn, ws, &input.version_id)? {
                return Err(DomainError::VersionNotFound);
            }
            let moment = get_moment(conn, ws, &input.mutation_moment_id)?
                .filter(|m| m.version_id == input.version_id && m.path == input.path)
                .ok_or(DomainError::FileNotFound)?;
            if moment.sync_record_only {
                return Err(DomainError::InvalidInput {
                    reason: "sync record-only moments cannot be rolled back",
                });
            }

            let before_state = moment_before_state(conn, ws, &input.mutation_moment_id)?;
            let before = resolve_rollback_before(conn, input, &moment, before_state)?;
            if let Some(before) = &before {
                if before.version_id != input.version_id
                    || before.object_id != moment.object_id
                    || (before.path != input.path && moment.operation != MomentOp::Rename)
                {
                    return Err(DomainError::InvalidInput {
                        reason: "rollback snapshot does not match the target file",
                    });
                }
            }
            if later_materialized_object_moment_exists(conn, ws, &moment)? {
                return Err(DomainError::InvalidInput {
                    reason: "mutation moment is not the latest mutation for the object",
                });
            }
            if rollback_moment_has_dependents(conn, ws, &moment)? {
                return Err(DomainError::InvalidInput {
                    reason: "mutation moment has dependent versions",
                });
            }
            if let Some(before) = &before
                && let Some(target_object_id) =
                    alias_object_id(conn, ws, &input.version_id, &before.path)?
                && target_object_id != before.object_id
            {
                return Err(DomainError::TargetPathExists);
            }
            Ok(RollbackPrep { moment, before })
        })?;
        let compensating_moment_id = rollback_compensating_moment_id(
            &input.workspace_id,
            &input.version_id,
            &input.mutation_moment_id,
        );

        let outcome = self.store.write_with(faults, |tx| {
            // Rollback replaces the target mutation with a compensating moment.
            // Any compensating disk intent needs a fresh store-global generation.
            // Reserve it while the rolled-back moment is still present. Reusing
            // that moment's historical generation lets any later completed job for the same
            // path supersede the compensator before it can restore disk.
            let restore_generation = next_moment_order(tx)?;
            before_remove(tx, &prep.moment)?;
            tx.execute(
                "DELETE FROM moments WHERE workspace_id = ?1 AND moment_id = ?2",
                params![ws, input.mutation_moment_id],
            )
            .map_err(DomainError::sql_persist)?;
            tx.execute(
                "DELETE FROM engine_requests WHERE result_seq = ?1 AND kind IN ('versioned', 'merge')",
                params![prep.moment.moment_order],
            )
            .map_err(DomainError::sql_persist)?;
            tx.execute(
                "DELETE FROM path_aliases WHERE workspace_id = ?1 AND version_id = ?2 \
                 AND path = ?3 AND object_id = ?4",
                params![ws, input.version_id, input.path, prep.moment.object_id],
            )
            .map_err(DomainError::sql_persist)?;
            tx.execute(
                "DELETE FROM snapshots WHERE workspace_id = ?1 AND version_id = ?2 AND object_id = ?3",
                params![ws, input.version_id, prep.moment.object_id],
            )
            .map_err(DomainError::sql_persist)?;
            // Cancel every pending disk intent produced by the moment being
            // removed. This is deliberately not active-version-gated: a job was
            // enqueued while this version was active and can otherwise replay
            // after another version becomes active. Match the moment generation,
            // path, and content so a malformed same-id row is never swept.
            let merge_sha = match prep.moment.operation {
                MomentOp::Write if prep.moment.after_content_kind == "text" => {
                    prep.moment.after_blob_sha256.as_deref()
                }
                MomentOp::Delete if prep.moment.before_content_kind == "text" => {
                    prep.moment.before_blob_sha256.as_deref()
                }
                MomentOp::Write | MomentOp::Delete | MomentOp::Rename => None,
            };
            if let Some(sha256) = merge_sha {
                cancel_pending_materialization(
                    tx,
                    &format!("merge-mat_{}", input.mutation_moment_id),
                    &prep.moment.path,
                    prep.moment.moment_order,
                    sha256,
                )?;
            }
            if prep.moment.operation == MomentOp::Delete
                && prep.moment.before_content_kind == "binary"
                && let Some(sha256) = prep.moment.before_binary_sha256.as_deref()
            {
                cancel_pending_materialization(
                    tx,
                    &binary_delete_job_id(input.mutation_moment_id.as_str()),
                    &prep.moment.path,
                    prep.moment.moment_order,
                    sha256,
                )?;
            }
            if prep.moment.operation == MomentOp::Rename
                && prep.moment.after_content_kind == "binary"
                && let Some(sha256) = prep.moment.after_binary_sha256.as_deref()
            {
                cancel_pending_materialization(
                    tx,
                    &binary_rename_write_job_id(input.mutation_moment_id.as_str()),
                    &prep.moment.path,
                    prep.moment.moment_order,
                    sha256,
                )?;
                if let Some(before) = &prep.before {
                    cancel_pending_materialization(
                        tx,
                        &binary_rename_delete_job_id(input.mutation_moment_id.as_str()),
                        &before.path,
                        prep.moment.moment_order,
                        sha256,
                    )?;
                }
            }

            // A completed binary delete/rename already changed disk, so
            // cancelling the original pending intent is insufficient. Commit
            // the inverse intent beside the restored DB head. These jobs are
            // durable even when the version is currently inactive; the
            // runtime executes them only while their restored state is active,
            // otherwise activation/open replay leaves them PENDING.
            if prep.moment.operation == MomentOp::Delete
                && prep.moment.before_content_kind == "binary"
            {
                let before = prep.before.as_ref().ok_or(DomainError::StateCorrupt {
                    reason: "binary delete rollback has no restored snapshot",
                })?;
                enqueue_binary_delete_rollback_restore(
                    tx,
                    input,
                    before,
                    restore_generation,
                    prep.moment.recorded_at_ms,
                )?;
            }
            if prep.moment.operation == MomentOp::Rename
                && prep.moment.after_content_kind == "binary"
            {
                let before = prep.before.as_ref().ok_or(DomainError::StateCorrupt {
                    reason: "binary rename rollback has no restored snapshot",
                })?;
                enqueue_binary_rename_rollback_restore(
                    tx,
                    input,
                    before,
                    &prep.moment.path,
                    restore_generation,
                    prep.moment.recorded_at_ms,
                )?;
            }

            // Reconcile disk with an active-version rolled-back published write:
            //   * a pending job does not prove disk is clean — the materializer
            //     can crash after the atomic rename lands but before marking the
            //     job complete (`MaterializeAfterRenameBeforeComplete`), leaving
            //     the written bytes ON DISK with a still-pending job. So always
            //     enqueue the compensating restore (delete for a first write, else
            //     the previous content); it is a harmless preimage-guarded no-op
            //     if the bytes never actually reached disk.
            //   * additionally cancel a still-pending original job so it can never
            //     race the compensator and re-materialize the rolled-back bytes.
            if prep.moment.operation == MomentOp::Write
                && let Some(written_moment_sha) = prep.moment.after_binary_sha256.as_deref().or(prep.moment.after_blob_sha256.as_deref())
            {
                let publication_job_id = if prep.moment.after_content_kind == "binary" {
                    input.mutation_moment_id.clone()
                } else { format!("authored-mat_{}", input.mutation_moment_id) };
                let active = version_is_active(tx, ws, &input.version_id)?;
                let job: Option<(String, i64, String, String, String)> = tx
                    .query_row(
                        "SELECT status, target_generation, content_sha256, target_path, operation \
                         FROM materialization_jobs WHERE job_id = ?1",
                        params![publication_job_id],
                        |row| {
                            Ok((
                                row.get(0)?,
                                row.get(1)?,
                                row.get(2)?,
                                row.get(3)?,
                                row.get(4)?,
                            ))
                        },
                    )
                    .optional()
                    .map_err(DomainError::sql_corrupt)?;
                match job {
                    // Only cancel/compensate against a job whose content is
                    // exactly this write's bytes — never an unrelated
                    // same-id job.
                    Some((status, generation, written_sha256, target_path, operation))
                        if generation == prep.moment.moment_order
                            && written_sha256.as_str() == written_moment_sha
                            && target_path == prep.moment.path
                            && operation == "write" =>
                    {
                        if active {
                            enqueue_binary_rollback_restore(
                                tx,
                                input,
                                &prep.before,
                                restore_generation,
                                &written_sha256,
                                prep.moment.recorded_at_ms,
                            )?;
                        }
                        if status == "pending" {
                            tx.execute(
                                "DELETE FROM materialization_jobs WHERE job_id = ?1",
                                params![publication_job_id],
                            )
                            .map_err(DomainError::sql_persist)?;
                        }
                    }
                    Some(_) => {}
                    // No job at all: a CAPTURE-origin binary write (its bytes
                    // came FROM disk, so nothing was ever enqueued). The
                    // rolled-back head still must be reconciled TO disk —
                    // without a restore, disk keeps the newer bytes while the
                    // reconcile manifest records them as already captured, so
                    // the DB head would silently diverge forever. Restore
                    // against the write's own generation (the same peer rule
                    // BINHEAD uses for its compensators).
                    None if active && prep.moment.after_content_kind == "binary" => {
                        enqueue_binary_rollback_restore(
                            tx,
                            input,
                            &prep.before,
                            restore_generation,
                            written_moment_sha,
                            prep.moment.recorded_at_ms,
                        )?;
                    }
                    None => {}
                }
            }

            if let Some(before) = &prep.before {
                if before.content_kind == "text" {
                    let blob_sha256 = before.blob_sha256.as_ref().ok_or(
                        DomainError::StateCorrupt {
                            reason: "text rollback snapshot has no text blob",
                        },
                    )?;
                    tx.execute(
                        "INSERT OR IGNORE INTO blobs (sha256, byte_length, text) VALUES (?1, ?2, ?3)",
                        params![blob_sha256, before.text.len() as i64, before.text],
                    )
                    .map_err(DomainError::sql_persist)?;
                }
                tx.execute(
                    "INSERT INTO path_aliases (workspace_id, version_id, path, object_id) \
                     VALUES (?1, ?2, ?3, ?4) ON CONFLICT(workspace_id, version_id, path) \
                     DO UPDATE SET object_id = excluded.object_id",
                    params![ws, input.version_id, before.path, before.object_id],
                )
                .map_err(DomainError::sql_persist)?;
                upsert_snapshot(tx, before)?;
            }

            let current_present = prep.moment.operation != MomentOp::Delete;
            let restored = prep.before.as_ref();
            let restored_path = restored
                .map(|snapshot| snapshot.path.as_str())
                .unwrap_or(prep.moment.path.as_str());
            let restored_kind = restored
                .map(|snapshot| snapshot.content_kind.as_str())
                .unwrap_or(prep.moment.after_content_kind.as_str());
            let restored_text_sha = restored
                .and_then(|snapshot| snapshot.blob_sha256.as_deref())
                .or(prep.moment.after_blob_sha256.as_deref());
            let restored_binary_sha = restored
                .and_then(|snapshot| snapshot.binary_sha256.as_deref())
                .or(prep.moment.after_binary_sha256.as_deref());
            let restored_digest = if restored_kind == "binary" {
                restored_binary_sha
            } else {
                restored_text_sha
            };
            let operation = if restored.is_none() {
                "delete"
            } else if restored_path != prep.moment.path {
                "rename"
            } else {
                "write"
            };
            let current_digest = if prep.moment.after_content_kind == "binary" {
                prep.moment.after_binary_sha256.as_deref()
            } else {
                prep.moment.after_blob_sha256.as_deref()
            };
            tx.execute(
                "INSERT INTO moments \
                 (workspace_id,moment_order,moment_id,version_id,object_id,path,recorded_at_ms, \
                  operation,after_blob_sha256,before_present,before_blob_sha256, \
                  before_latest_moment_id,metadata_origin,metadata_summary, \
                  metadata_correlation_id,author_json,sync_record_only,after_content_kind, \
                  after_binary_sha256,before_content_kind,before_binary_sha256, \
                  before_object_id,before_version_id,before_path,before_updated_at_ms, \
                  before_metadata_origin,before_metadata_summary,before_metadata_correlation_id, \
                  payload_before_path,payload_before_content_kind,payload_before_blob_sha256, \
                  payload_after_path,payload_after_content_kind,payload_after_blob_sha256) \
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,NULL,NULL,?14,NULL, \
                         ?15,?16,?17,?18,?19,?20,?21,?22,?23,?24,?25,?26,?27,?28,?6,?15,?29)",
                params![
                    ws,
                    restore_generation,
                    compensating_moment_id,
                    input.version_id,
                    prep.moment.object_id,
                    restored_path,
                    prep.moment.recorded_at_ms,
                    operation,
                    (restored_kind == "text").then_some(restored_text_sha).flatten(),
                    if current_present { 2 } else { 1 },
                    current_present
                        .then_some(prep.moment.after_blob_sha256.as_deref())
                        .flatten(),
                    current_present.then_some(input.mutation_moment_id.as_str()),
                    input.metadata_origin,
                    input.author_json,
                    restored_kind,
                    (restored_kind == "binary")
                        .then_some(restored_binary_sha)
                        .flatten(),
                    prep.moment.after_content_kind,
                    current_present
                        .then_some(prep.moment.after_binary_sha256.as_deref())
                        .flatten(),
                    current_present.then_some(prep.moment.object_id.as_str()),
                    current_present.then_some(prep.moment.version_id.as_str()),
                    current_present.then_some(prep.moment.path.as_str()),
                    current_present.then_some(prep.moment.recorded_at_ms),
                    current_present.then_some(prep.moment.metadata_origin.as_str()),
                    current_present
                        .then_some(prep.moment.metadata_summary.as_deref())
                        .flatten(),
                    current_present
                        .then_some(prep.moment.metadata_correlation_id.as_deref())
                        .flatten(),
                    current_present.then_some(prep.moment.path.as_str()),
                    current_present.then_some(prep.moment.after_content_kind.as_str()),
                    current_present.then_some(current_digest).flatten(),
                    restored_digest,
                ],
            )
            .map_err(DomainError::sql_persist)?;
            crate::collections::index_historical_record_owner_moment_in_tx(
                tx,
                ws,
                restore_generation,
            )?;
            if restored.is_some() {
                tx.execute(
                    "UPDATE snapshots SET latest_moment_id=?1,metadata_origin=?2, \
                     metadata_summary=NULL,metadata_correlation_id=NULL \
                     WHERE workspace_id=?3 AND version_id=?4 AND object_id=?5",
                    params![
                        compensating_moment_id,
                        input.metadata_origin,
                        ws,
                        input.version_id,
                        prep.moment.object_id,
                    ],
                )
                .map_err(DomainError::sql_persist)?;
            }

            if !object_has_references(tx, ws, &prep.moment.object_id)? {
                tx.execute(
                    "DELETE FROM file_objects WHERE workspace_id = ?1 AND object_id = ?2",
                    params![ws, prep.moment.object_id],
                )
                .map_err(DomainError::sql_persist)?;
            }
            let restored_text = prep.before.as_ref().and_then(|before| {
                (before.content_kind == "text").then_some((before.path.as_str(), before.text.as_str()))
            });
            after(
                tx,
                &prep.moment.object_id,
                restored_text,
                &compensating_moment_id,
                prep.moment.recorded_at_ms,
            )?;
            record_request(
                tx,
                input.request_id.as_deref(),
                &payload_hash,
                0,
                prep.moment.recorded_at_ms,
            )?;
            Ok::<_, DomainError>(false)
        })?;
        committed(outcome)
    }
}

struct RollbackPrep {
    moment: MomentRecord,
    before: Option<SnapshotRecord>,
}

/// Enqueue the compensating materialization job that restores disk to the
/// rolled-back-to state after a binary write whose original job already reached
/// disk (complete) or was preserved-both (CONFLICT). Mirrors the text write/
/// resolve path (`enqueue_write`/`enqueue_delete`): content bytes live in
/// `binary_blobs` (what the materializer reads) and the job carries the current
/// store-global mutation generation so the newest-wins gate cannot discard an
/// active restore behind a later completed job from another lineage.
///
/// The preimage is the written bytes (`written_sha256`): the compensator only
/// acts if disk still holds exactly what the rolled-back write put there, so an
/// external edit after materialization is preserved (conflict), never clobbered.
fn enqueue_binary_rollback_restore(
    tx: &Transaction<'_>,
    input: &RollbackTextFileMutation,
    before: &Option<SnapshotRecord>,
    generation: i64,
    written_sha256: &str,
    now_ms: i64,
) -> Result<(), DomainError> {
    let job_id = binary_rollback_job_identity(
        &input.workspace_id,
        &input.version_id,
        &input.mutation_moment_id,
    );
    let preimage = Preimage::Present(written_sha256.to_owned());
    match before {
        // First write: the rolled-back-to state is absent → delete the file.
        // `content_sha256` must reference an existing `binary_blobs` row (FK); the
        // written bytes still qualify and are unused by a delete job.
        None => enqueue_delete_job(
            tx,
            &MaterializationJobSpec {
                job_id,
                workspace_id: input.workspace_id.clone(),
                target_path: input.path.clone(),
                content_sha256: written_sha256.to_owned(),
                preimage,
                target_generation: generation,
                now_ms,
            },
        )
        .map_err(DomainError::from)?,
        // Overwrite: restore the previous content. Text lives in `blobs`; copy its
        // bytes into `binary_blobs` (mirroring `enqueue_write`) and materialize
        // that sha. A previous binary head's bytes are already in `binary_blobs`.
        Some(before) => {
            let content_sha256 = if before.content_kind == "binary" {
                before
                    .binary_sha256
                    .clone()
                    .ok_or(DomainError::StateCorrupt {
                        reason: "binary rollback snapshot has no binary hash",
                    })?
            } else {
                put_binary_blob(tx, before.text.as_bytes()).map_err(DomainError::from)?
            };
            enqueue_job(
                tx,
                &MaterializationJobSpec {
                    job_id,
                    workspace_id: input.workspace_id.clone(),
                    target_path: input.path.clone(),
                    content_sha256,
                    preimage,
                    target_generation: generation,
                    now_ms,
                },
            )
            .map_err(DomainError::from)?;
        }
    }
    Ok(())
}

fn enqueue_binary_delete_rollback_restore(
    tx: &Transaction<'_>,
    input: &RollbackTextFileMutation,
    before: &SnapshotRecord,
    generation: i64,
    now_ms: i64,
) -> Result<(), DomainError> {
    let sha256 = before
        .binary_sha256
        .clone()
        .ok_or(DomainError::StateCorrupt {
            reason: "binary delete rollback snapshot has no binary hash",
        })?;
    enqueue_job(
        tx,
        &MaterializationJobSpec {
            job_id: binary_rollback_job_identity(
                &input.workspace_id,
                &input.version_id,
                &input.mutation_moment_id,
            ),
            workspace_id: input.workspace_id.clone(),
            target_path: before.path.clone(),
            content_sha256: sha256,
            preimage: Preimage::Absent,
            target_generation: generation,
            now_ms,
        },
    )
    .map_err(DomainError::from)
}

fn enqueue_binary_rename_rollback_restore(
    tx: &Transaction<'_>,
    input: &RollbackTextFileMutation,
    before: &SnapshotRecord,
    renamed_path: &str,
    generation: i64,
    now_ms: i64,
) -> Result<(), DomainError> {
    let sha256 = before
        .binary_sha256
        .clone()
        .ok_or(DomainError::StateCorrupt {
            reason: "binary rename rollback snapshot has no binary hash",
        })?;
    let rollback_id = binary_rollback_job_identity(
        &input.workspace_id,
        &input.version_id,
        &input.mutation_moment_id,
    );
    enqueue_job(
        tx,
        &MaterializationJobSpec {
            job_id: binary_rename_write_job_id(&rollback_id),
            workspace_id: input.workspace_id.clone(),
            target_path: before.path.clone(),
            content_sha256: sha256.clone(),
            preimage: Preimage::Absent,
            target_generation: generation,
            now_ms,
        },
    )
    .map_err(DomainError::from)?;
    enqueue_delete_job(
        tx,
        &MaterializationJobSpec {
            job_id: binary_rename_delete_job_id(&rollback_id),
            workspace_id: input.workspace_id.clone(),
            target_path: renamed_path.to_owned(),
            content_sha256: sha256.clone(),
            preimage: Preimage::Present(sha256),
            target_generation: generation,
            now_ms,
        },
    )
    .map_err(DomainError::from)
}

/// Keep binary rollback materialization identities outside caller namespaces
/// and bind them to the version whose disk state they compensate.
pub fn binary_rollback_job_identity(
    workspace_id: &str,
    version_id: &str,
    mutation_moment_id: &str,
) -> String {
    format!(
        "{}{mutation_moment_id}",
        binary_rollback_job_version_prefix(workspace_id, version_id)
    )
}

/// Derive the moment that records a text mutation rollback's compensating
/// state. Callers use this identity to find only work owned by that rollback.
pub fn rollback_compensating_moment_id(
    workspace_id: &str,
    version_id: &str,
    mutation_moment_id: &str,
) -> String {
    format!(
        "rollback-{}",
        hash_fields(&[
            workspace_id.as_bytes(),
            version_id.as_bytes(),
            mutation_moment_id.as_bytes(),
        ])
    )
}

/// Recover the workspace, version, and mutation moment bound into a rollback
/// materialization identity.
pub fn decode_binary_rollback_job_identity(job_id: &str) -> Option<(&str, &str, &str)> {
    let encoded = job_id.strip_prefix("rollback-restore_\u{1f}")?;
    let (workspace_len, encoded) = encoded.split_once(':')?;
    let workspace_len = workspace_len.parse::<usize>().ok()?;
    let workspace_id = encoded.get(..workspace_len)?;
    let encoded = encoded.get(workspace_len..)?;
    let (version_len, encoded) = encoded.split_once(':')?;
    let version_len = version_len.parse::<usize>().ok()?;
    let version_id = encoded.get(..version_len)?;
    let mutation_moment_id = encoded.get(version_len..)?.strip_prefix(':')?;
    if mutation_moment_id.is_empty() {
        return None;
    }
    Some((workspace_id, version_id, mutation_moment_id))
}

pub(super) fn binary_rollback_job_version_prefix(workspace_id: &str, version_id: &str) -> String {
    format!(
        "rollback-restore_\u{1f}{}:{workspace_id}{}:{version_id}:",
        workspace_id.len(),
        version_id.len()
    )
}

/// Remove a still-replayable disk intent only when it is provably owned by the
/// moment being rolled back. Terminal rows remain as generation evidence.
fn cancel_pending_materialization(
    tx: &Transaction<'_>,
    job_id: &str,
    target_path: &str,
    target_generation: i64,
    content_sha256: &str,
) -> Result<(), DomainError> {
    tx.execute(
        "DELETE FROM materialization_jobs \
         WHERE job_id = ?1 AND target_path = ?2 AND target_generation = ?3 \
           AND content_sha256 = ?4 AND status = 'pending'",
        params![job_id, target_path, target_generation, content_sha256],
    )
    .map_err(DomainError::sql_persist)?;
    Ok(())
}

fn select_moment_by_order(
    conn: &Connection,
    workspace_id: &str,
    version_id: &str,
    object_id: &str,
    max_order: i64,
) -> Result<Option<MomentRecord>, DomainError> {
    let row = conn
        .query_row(
            "SELECT moment_order, moment_id, version_id, object_id, path, recorded_at_ms, \
             operation, after_blob_sha256, before_present, before_blob_sha256, \
             before_latest_moment_id, metadata_origin, metadata_summary, \
             metadata_correlation_id, author_json, sync_record_only, \
             COALESCE(after_content_kind, 'text'), after_binary.sha256, \
             COALESCE(before_content_kind, 'text'), before_binary.sha256, \n             CASE WHEN after_text_blob.byte_length <= 131072 AND LENGTH(CAST(after_text_blob.text AS BLOB)) <= 131072 THEN after_text_blob.text END, \n             COALESCE(after_text_blob.byte_length, after_binary.byte_length), \n             CASE WHEN before_text_blob.byte_length <= 131072 AND LENGTH(CAST(before_text_blob.text AS BLOB)) <= 131072 THEN before_text_blob.text END, \n             COALESCE(before_text_blob.byte_length, before_binary.byte_length), \
             COALESCE(LENGTH(CAST(after_text_blob.text AS BLOB)), LENGTH(after_binary.bytes)), \
             COALESCE(LENGTH(CAST(before_text_blob.text AS BLOB)), LENGTH(before_binary.bytes)), \
             m.payload_before_path \
             FROM moments m \
             LEFT JOIN binary_blobs after_binary ON after_binary.sha256 = m.after_binary_sha256 \
             LEFT JOIN binary_blobs before_binary ON before_binary.sha256 = m.before_binary_sha256 \n             LEFT JOIN blobs after_text_blob ON after_text_blob.sha256 = m.after_blob_sha256 \n             LEFT JOIN blobs before_text_blob ON before_text_blob.sha256 = m.before_blob_sha256 \
             WHERE workspace_id = ?1 AND version_id = ?2 AND object_id = ?3 \
               AND moment_order <= ?4 AND (sync_record_only IS NULL OR sync_record_only = 0) \
             ORDER BY moment_order DESC LIMIT 1",
            params![workspace_id, version_id, object_id, max_order],
            map_moment_row,
        )
        .optional()
        .map_err(DomainError::sql_corrupt)?;
    row.transpose()
}

fn inherited_object_moment(
    conn: &Connection,
    workspace_id: &str,
    version_id: &str,
    object_id: &str,
    seen: &mut HashSet<String>,
) -> Result<Option<MomentRecord>, DomainError> {
    if !seen.insert(version_id.to_owned()) {
        return Err(DomainError::StateCorrupt {
            reason: "version fork lineage contains a cycle",
        });
    }
    let version =
        get_version(conn, workspace_id, version_id)?.ok_or(DomainError::StateCorrupt {
            reason: "fork lineage points at a missing version",
        })?;
    let Some(parent_id) = version.fork_version_id else {
        return Ok(None);
    };
    let fork_order = match version.fork_moment_id {
        Some(moment_id) => conn
            .query_row(
                "SELECT moment_order FROM moments WHERE workspace_id = ?1 AND moment_id = ?2",
                params![workspace_id, moment_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(DomainError::sql_corrupt)?
            .ok_or(DomainError::StateCorrupt {
                reason: "fork lineage points at a missing moment",
            })?,
        None => -1,
    };
    if let Some(moment) =
        select_moment_by_order(conn, workspace_id, &parent_id, object_id, fork_order)?
    {
        return Ok(Some(moment));
    }
    inherited_object_moment(conn, workspace_id, &parent_id, object_id, seen)
}

struct RollbackPreimageIdentity {
    object_id: String,
    version_id: String,
    path: String,
    updated_at_ms: i64,
    latest_moment_id: String,
    metadata_origin: String,
    metadata_summary: Option<String>,
    metadata_correlation_id: Option<String>,
}

fn persisted_rollback_preimage_identity(
    conn: &Connection,
    workspace_id: &str,
    moment: &MomentRecord,
) -> Result<Option<RollbackPreimageIdentity>, DomainError> {
    type StoredIdentity = (
        Option<String>,
        Option<String>,
        Option<String>,
        Option<i64>,
        Option<String>,
        Option<String>,
        Option<String>,
    );
    let stored: StoredIdentity = conn
        .query_row(
            "SELECT before_object_id, before_version_id, before_path, \
             before_updated_at_ms, before_metadata_origin, before_metadata_summary, \
             before_metadata_correlation_id FROM moments \
             WHERE workspace_id = ?1 AND moment_id = ?2",
            params![workspace_id, moment.moment_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                ))
            },
        )
        .map_err(DomainError::sql_corrupt)?;
    let (object_id, version_id, path, updated_at_ms, metadata_origin, summary, correlation_id) =
        stored;
    if path.is_none() && updated_at_ms.is_none() && metadata_origin.is_none() {
        return Ok(None);
    }
    let identity = RollbackPreimageIdentity {
        object_id: object_id.ok_or(DomainError::StateCorrupt {
            reason: "stored moment preimage is missing its object",
        })?,
        version_id: version_id.ok_or(DomainError::StateCorrupt {
            reason: "stored moment preimage is missing its version",
        })?,
        path: path.ok_or(DomainError::StateCorrupt {
            reason: "stored moment preimage is missing its path",
        })?,
        updated_at_ms: updated_at_ms.ok_or(DomainError::StateCorrupt {
            reason: "stored moment preimage is missing its timestamp",
        })?,
        latest_moment_id: moment.before_latest_moment_id.clone().ok_or(
            DomainError::StateCorrupt {
                reason: "stored moment preimage is missing its head",
            },
        )?,
        metadata_origin: metadata_origin.ok_or(DomainError::StateCorrupt {
            reason: "stored moment preimage is missing its metadata origin",
        })?,
        metadata_summary: summary,
        metadata_correlation_id: correlation_id,
    };
    Ok(Some(identity))
}

fn resolve_rollback_before(
    conn: &Connection,
    input: &RollbackTextFileMutation,
    moment: &MomentRecord,
    before_state: MomentBeforeState,
) -> Result<Option<SnapshotRecord>, DomainError> {
    if before_state == MomentBeforeState::Present {
        let identity =
            match persisted_rollback_preimage_identity(conn, &input.workspace_id, moment)? {
                Some(identity) => identity,
                None => {
                    let producer =
                        match &moment.before_latest_moment_id {
                            Some(before_latest_moment_id) => {
                                get_moment(conn, &input.workspace_id, before_latest_moment_id)?
                                    .ok_or(DomainError::StateCorrupt {
                                        reason: "moment preimage producer is missing",
                                    })?
                            }
                            None => previous_object_moment_for_rollback(conn, input, moment)?
                                .ok_or(DomainError::StateCorrupt {
                                    reason: "moment preimage is missing its producer",
                                })?,
                        };
                    RollbackPreimageIdentity {
                        object_id: producer.object_id,
                        version_id: input.version_id.clone(),
                        path: producer.path,
                        updated_at_ms: producer.recorded_at_ms,
                        latest_moment_id: producer.moment_id,
                        metadata_origin: producer.metadata_origin,
                        metadata_summary: producer.metadata_summary,
                        metadata_correlation_id: producer.metadata_correlation_id,
                    }
                }
            };
        if identity.object_id != moment.object_id {
            return Err(DomainError::StateCorrupt {
                reason: "moment preimage producer belongs to another object",
            });
        }
        if identity.version_id != input.version_id {
            return Err(DomainError::StateCorrupt {
                reason: "moment preimage belongs to another version",
            });
        }
        let (text, blob_sha256, binary_sha256) = match moment.before_content_kind.as_str() {
            "text" => {
                let sha = moment
                    .before_blob_sha256
                    .clone()
                    .ok_or(DomainError::StateCorrupt {
                        reason: "text moment preimage is missing its blob",
                    })?;
                let text = blob_text(conn, &sha)?.ok_or(DomainError::StateCorrupt {
                    reason: "moment preimage blob is missing",
                })?;
                (text, Some(sha), None)
            }
            "binary" => {
                let sha = moment
                    .before_binary_sha256
                    .clone()
                    .ok_or(DomainError::StateCorrupt {
                        reason: "binary moment preimage is missing its blob",
                    })?;
                let exists: Option<i64> = conn
                    .query_row(
                        "SELECT 1 FROM binary_blobs WHERE sha256 = ?1",
                        params![sha],
                        |row| row.get(0),
                    )
                    .optional()
                    .map_err(DomainError::sql_corrupt)?;
                if exists.is_none() {
                    return Err(DomainError::StateCorrupt {
                        reason: "binary moment preimage blob is missing",
                    });
                }
                (String::new(), None, Some(sha))
            }
            _ => {
                return Err(DomainError::StateCorrupt {
                    reason: "moment preimage has an unknown content kind",
                });
            }
        };
        return Ok(Some(SnapshotRecord {
            workspace_id: input.workspace_id.clone(),
            version_id: input.version_id.clone(),
            object_id: moment.object_id.clone(),
            path: identity.path,
            text,
            blob_sha256,
            content_kind: moment.before_content_kind.clone(),
            binary_sha256,
            updated_at_ms: identity.updated_at_ms,
            latest_moment_id: identity.latest_moment_id,
            metadata_origin: identity.metadata_origin,
            metadata_summary: identity.metadata_summary,
            metadata_correlation_id: identity.metadata_correlation_id,
        }));
    }
    if before_state == MomentBeforeState::Absent {
        return Ok(None);
    }
    Err(DomainError::InvalidInput {
        reason: "mutation has no rollback preimage",
    })
}

fn previous_object_moment_for_rollback(
    conn: &Connection,
    input: &RollbackTextFileMutation,
    moment: &MomentRecord,
) -> Result<Option<MomentRecord>, DomainError> {
    let previous = select_moment_by_order(
        conn,
        &input.workspace_id,
        &input.version_id,
        &moment.object_id,
        moment.moment_order.saturating_sub(1),
    )?;
    let previous = match previous {
        Some(previous) => Some(previous),
        None => inherited_object_moment(
            conn,
            &input.workspace_id,
            &input.version_id,
            &moment.object_id,
            &mut HashSet::new(),
        )?,
    };
    Ok(previous)
}

fn moment_before_state(
    conn: &Connection,
    workspace_id: &str,
    moment_id: &str,
) -> Result<MomentBeforeState, DomainError> {
    let value: i64 = conn
        .query_row(
            "SELECT before_present FROM moments WHERE workspace_id = ?1 AND moment_id = ?2",
            params![workspace_id, moment_id],
            |row| row.get(0),
        )
        .map_err(DomainError::sql_corrupt)?;
    MomentBeforeState::from_db(value)
}

fn later_materialized_object_moment_exists(
    conn: &Connection,
    workspace_id: &str,
    moment: &MomentRecord,
) -> Result<bool, DomainError> {
    let found: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM moments WHERE workspace_id = ?1 AND version_id = ?2 \
             AND object_id = ?3 AND moment_order > ?4 \
             AND (sync_record_only IS NULL OR sync_record_only = 0) LIMIT 1",
            params![
                workspace_id,
                moment.version_id,
                moment.object_id,
                moment.moment_order
            ],
            |row| row.get(0),
        )
        .optional()
        .map_err(DomainError::sql_corrupt)?;
    Ok(found.is_some())
}

struct ObjectMomentDependency {
    version_id: String,
    moment_order: i64,
    before_present: bool,
}

fn rollback_moment_has_dependents(
    conn: &Connection,
    workspace_id: &str,
    moment: &MomentRecord,
) -> Result<bool, DomainError> {
    let snapshot_reference: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM snapshots WHERE workspace_id = ?1 AND version_id <> ?2 \
             AND latest_moment_id = ?3 LIMIT 1",
            params![workspace_id, moment.version_id, moment.moment_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(DomainError::sql_corrupt)?;
    if snapshot_reference.is_some() {
        return Ok(true);
    }
    let fork_base_reference: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM fork_base_snapshots WHERE workspace_id = ?1 \
             AND latest_moment_id = ?2 LIMIT 1",
            params![workspace_id, moment.moment_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(DomainError::sql_corrupt)?;
    if fork_base_reference.is_some() {
        return Ok(true);
    }
    let moment_reference: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM moments WHERE workspace_id = ?1 AND moment_id <> ?2 \
             AND object_id = ?3 AND before_latest_moment_id = ?2 \
             AND (sync_record_only IS NULL OR sync_record_only = 0) LIMIT 1",
            params![workspace_id, moment.moment_id, moment.object_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(DomainError::sql_corrupt)?;
    if moment_reference.is_some() {
        return Ok(true);
    }
    // Fail closed if a concrete preimage has no resolved producer link.
    let unresolved_reference: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM moments WHERE workspace_id = ?1 AND object_id = ?2 \
             AND before_present = 2 AND before_latest_moment_id IS NULL LIMIT 1",
            params![workspace_id, moment.object_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(DomainError::sql_corrupt)?;
    if unresolved_reference.is_some() {
        return Ok(true);
    }

    let mut versions = HashMap::new();
    let mut version_stmt = conn
        .prepare_cached(
            "SELECT workspace_id, version_id, kind, name, created_at_ms, fork_version_id, \
             fork_moment_id FROM versions WHERE workspace_id = ?1",
        )
        .map_err(DomainError::sql_corrupt)?;
    let version_rows = version_stmt
        .query_map(params![workspace_id], map_version_row)
        .map_err(DomainError::sql_corrupt)?;
    for row in version_rows {
        let version = row.map_err(DomainError::sql_corrupt)??;
        versions.insert(version.version_id.clone(), version);
    }

    let fork_moment_ids: HashSet<&str> = versions
        .values()
        .filter_map(|version| version.fork_moment_id.as_deref())
        .collect();
    let mut moment_orders = HashMap::with_capacity(fork_moment_ids.len());
    let mut order_stmt = conn
        .prepare_cached(
            "SELECT moment_order FROM moments WHERE workspace_id = ?1 AND moment_id = ?2",
        )
        .map_err(DomainError::sql_corrupt)?;
    for moment_id in fork_moment_ids {
        let moment_order = order_stmt
            .query_row(params![workspace_id, moment_id], |row| row.get(0))
            .optional()
            .map_err(DomainError::sql_corrupt)?;
        if let Some(moment_order) = moment_order {
            moment_orders.insert(moment_id.to_owned(), moment_order);
        }
    }

    let mut object_moments = Vec::new();
    let mut object_stmt = conn
        .prepare_cached(
            "SELECT version_id, moment_order, before_present FROM moments \
             WHERE workspace_id = ?1 AND object_id = ?2 \
               AND (sync_record_only IS NULL OR sync_record_only = 0) ORDER BY moment_order",
        )
        .map_err(DomainError::sql_corrupt)?;
    let object_rows = object_stmt
        .query_map(params![workspace_id, moment.object_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })
        .map_err(DomainError::sql_corrupt)?;
    for row in object_rows {
        let (version_id, moment_order, before_present) = row.map_err(DomainError::sql_corrupt)?;
        object_moments.push(ObjectMomentDependency {
            version_id,
            moment_order,
            before_present: MomentBeforeState::from_db(before_present)?
                == MomentBeforeState::Present,
        });
    }

    for version in versions.values() {
        if version.version_id == moment.version_id {
            continue;
        }
        let Some(fork_order) =
            fork_order_from_version(version, &versions, &moment_orders, &moment.version_id)
        else {
            continue;
        };
        if fork_order >= moment.moment_order
            && (fork_order == moment.moment_order
                || !lineage_has_independent_object_mutation(
                    &version.version_id,
                    fork_order,
                    &moment.version_id,
                    &versions,
                    &moment_orders,
                    &object_moments,
                ))
        {
            return Ok(true);
        }
    }
    Ok(false)
}

fn fork_order_from_version(
    version: &VersionRecord,
    versions: &HashMap<String, VersionRecord>,
    moment_orders: &HashMap<String, i64>,
    target_version_id: &str,
) -> Option<i64> {
    let mut cursor = Some(version);
    let mut seen = HashSet::new();
    while let Some(version) = cursor {
        let parent_id = version.fork_version_id.as_deref()?;
        if !seen.insert(version.version_id.as_str()) {
            return None;
        }
        if parent_id == target_version_id {
            return version
                .fork_moment_id
                .as_ref()
                .and_then(|id| moment_orders.get(id).copied());
        }
        cursor = versions.get(parent_id);
    }
    None
}

fn lineage_has_independent_object_mutation(
    candidate_version_id: &str,
    after_order: i64,
    target_version_id: &str,
    versions: &HashMap<String, VersionRecord>,
    moment_orders: &HashMap<String, i64>,
    object_moments: &[ObjectMomentDependency],
) -> bool {
    let mut cursor = versions.get(candidate_version_id);
    let mut at_or_before_order = i64::MAX;
    let mut seen = HashSet::new();
    while let Some(version) = cursor {
        if !seen.insert(version.version_id.as_str()) {
            return false;
        }
        // TS value 2 is a concrete preimage (reachable for R05 update/delete/
        // rename); Rust's bool represents it as `true`. Rust intentionally
        // collapses TS unrecorded (0) and explicit-absent (1) to `false`;
        // this dependency check only needs the concrete-preimage distinction.
        if object_moments.iter().any(|candidate| {
            candidate.version_id == version.version_id
                && candidate.moment_order > after_order
                && candidate.moment_order <= at_or_before_order
                && candidate.before_present
        }) {
            return true;
        }
        let Some(parent_id) = version.fork_version_id.as_deref() else {
            return false;
        };
        if parent_id == target_version_id {
            return false;
        }
        at_or_before_order = version
            .fork_moment_id
            .as_ref()
            .and_then(|id| moment_orders.get(id).copied())
            .unwrap_or(-1);
        cursor = versions.get(parent_id);
    }
    false
}

fn object_has_references(
    conn: &Connection,
    workspace_id: &str,
    object_id: &str,
) -> Result<bool, DomainError> {
    let found: Option<i64> = conn
        .query_row(
            "SELECT 1 WHERE \
             EXISTS (SELECT 1 FROM path_aliases WHERE workspace_id = ?1 AND object_id = ?2) OR \
             EXISTS (SELECT 1 FROM snapshots WHERE workspace_id = ?1 AND object_id = ?2) OR \
             EXISTS (SELECT 1 FROM fork_base_snapshots WHERE workspace_id = ?1 AND object_id = ?2) OR \
             EXISTS (SELECT 1 FROM moments WHERE workspace_id = ?1 AND object_id = ?2) OR \
             EXISTS (SELECT 1 FROM ydoc_docs \
                     WHERE workspace_id = ?1 AND object_id = ?2) OR \
             EXISTS (SELECT 1 FROM ydoc_deferred_updates \
                     WHERE workspace_id = ?1 AND object_id = ?2) OR \
             EXISTS (SELECT 1 FROM ydoc_inactive_lineages \
                     WHERE workspace_id = ?1 AND object_id = ?2) LIMIT 1",
            params![workspace_id, object_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(DomainError::sql_corrupt)?;
    Ok(found.is_some())
}

#[cfg(test)]
mod tests {
    use super::object_has_references;
    use rusqlite::Connection;

    #[test]
    fn inactive_ydoc_lineage_keeps_file_object_referenced() {
        let conn = Connection::open_in_memory().expect("open in-memory database");
        conn.execute_batch(
            "CREATE TABLE path_aliases (workspace_id TEXT, object_id TEXT); \
             CREATE TABLE snapshots (workspace_id TEXT, object_id TEXT); \
             CREATE TABLE fork_base_snapshots (workspace_id TEXT, object_id TEXT); \
             CREATE TABLE moments (workspace_id TEXT, object_id TEXT); \
             CREATE TABLE ydoc_docs (workspace_id TEXT, object_id TEXT); \
             CREATE TABLE ydoc_deferred_updates (workspace_id TEXT, object_id TEXT); \
             CREATE TABLE ydoc_inactive_lineages (workspace_id TEXT, object_id TEXT);",
        )
        .expect("create object-reference tables");

        for table in [
            "ydoc_docs",
            "ydoc_deferred_updates",
            "ydoc_inactive_lineages",
        ] {
            conn.execute(
                &format!("INSERT INTO {table} (workspace_id, object_id) VALUES ('ws', 'obj')"),
                [],
            )
            .expect("seed the sole Y.Doc object reference");
            assert!(
                object_has_references(&conn, "ws", "obj").expect("check object references"),
                "{table} must keep its file object referenced"
            );
            conn.execute(&format!("DELETE FROM {table}"), [])
                .expect("clear the reference before the next case");
        }
    }
}
