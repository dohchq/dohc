use crate::RuntimeError;
use dohc_engine_domain::{CaptureIngest, CaptureIngestBinary, DomainError};
use dohc_engine_files::materialize::read_publication_target;
use dohc_engine_storage::{
    EngineStore, FaultInjector, JobStatus, StorageError, TxnOutcome, hex_sha256,
};
use rusqlite::{OptionalExtension, Transaction, params};
use std::path::Path;

pub(super) enum ExportedDeleteRecovery {
    NotExported,
    Publish,
    Settled,
}

pub(super) fn recover_exported_on_store(
    store: &mut EngineStore,
    root: &Path,
    workspace_id: &str,
    job_id: &str,
    now_ms: i64,
    faults: &dyn FaultInjector,
) -> Result<ExportedDeleteRecovery, RuntimeError> {
    let moment_id =
        job_id
            .strip_prefix("restore-delete-mat_")
            .ok_or(DomainError::InvalidInput {
                reason: "not a checked delete job",
            })?;
    // Ordinary unpublished recovery needs no extra writer commit. Exported
    // settlement rechecks this reference together with the job inside its write.
    if !store.read_with(|conn| {
        dohc_engine_domain::moment_has_replication_dependents_in(conn, workspace_id, moment_id)
    })? {
        return Ok(ExportedDeleteRecovery::NotExported);
    }
    match store.write_with(faults, |tx| {
        recover_exported_in_tx(tx, root, workspace_id, job_id, now_ms)
    })? {
        TxnOutcome::Committed(decision) => Ok(decision),
        TxnOutcome::Crashed { .. } => Err(RuntimeError::OperationCrashed),
    }
}

/// The job, export, snapshot and disk observation share this writer transaction.
/// A later file is captured together with finishing D, without changing disk.
fn recover_exported_in_tx(
    tx: &Transaction<'_>,
    root: &Path,
    workspace_id: &str,
    job_id: &str,
    now_ms: i64,
) -> Result<ExportedDeleteRecovery, RuntimeError> {
    let Some(job) = dohc_engine_storage::materialize::load_job(tx, job_id)? else {
        return Ok(ExportedDeleteRecovery::Settled);
    };
    if job.workspace_id != workspace_id {
        return Err(DomainError::WorkspaceMismatch.into());
    }
    let moment_id =
        job_id
            .strip_prefix("restore-delete-mat_")
            .ok_or(DomainError::InvalidInput {
                reason: "not a checked delete job",
            })?;
    if !dohc_engine_domain::moment_has_replication_dependents_in(tx, workspace_id, moment_id)? {
        return Ok(ExportedDeleteRecovery::NotExported);
    }
    if dohc_engine_files::workspace_recovery_unavailable(root) {
        return Err(dohc_engine_files::MaterializeError::RecoveryUnavailable.into());
    }
    let (version_id, object_id): (String, String) = tx
        .query_row(
            "SELECT version_id,object_id FROM moments WHERE workspace_id=?1 AND moment_id=?2",
            params![workspace_id, moment_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(StorageError::corrupt_public)?;
    super::versioned::ensure_publication_version(tx, workspace_id, &version_id)?;
    let bytes = read_publication_target(root, &job.target_path)?;
    let snapshot: Option<(String, String)> = tx.query_row(
        "SELECT object_id,CASE content_kind WHEN 'binary' THEN binary_sha256 ELSE blob_sha256 END
         FROM snapshots WHERE workspace_id=?1 AND version_id=?2 AND path=?3",
        params![workspace_id, version_id, job.target_path], |row| Ok((row.get(0)?, row.get(1)?)),
    ).optional().map_err(StorageError::corrupt_public)?;
    let snapshot_matches = snapshot
        .as_ref()
        .is_some_and(|(id, sha)| id == &object_id && sha == &job.content_sha256);
    let canonical_matches = if snapshot_matches {
        match super::versioned::check_restore_content_in_tx(
            tx,
            workspace_id,
            &version_id,
            &job.target_path,
            &job.content_sha256,
        ) {
            Ok(()) => true,
            Err(RuntimeError::Domain(DomainError::WritePreconditionFailed { .. })) => false,
            Err(error) => return Err(error),
        }
    } else {
        false
    };
    let recreated = job.status == JobStatus::Complete && bytes.is_some();
    let disk_matches = bytes
        .as_ref()
        .is_none_or(|bytes| hex_sha256(bytes) == job.content_sha256);
    if canonical_matches && disk_matches && !recreated {
        // The materializer rechecks the preimage before it can remove the file.
        tx.execute(
            "UPDATE materialization_jobs SET status='pending',completed_at_ms=NULL
            WHERE workspace_id=?1 AND job_id=?2 AND status='conflict'",
            params![workspace_id, job_id],
        )
        .map_err(StorageError::persist_public)?;
        return Ok(ExportedDeleteRecovery::Publish);
    }

    // D is immutable on peers. Apply it in history, then record the later disk
    // state after D. Do not enqueue D's scene-asset deletions or any disk writes.
    super::versioned::finish_checked_delete_history_in_tx(tx, workspace_id, moment_id, true)?;
    if let Some(bytes) = bytes {
        capture_current_bytes_in_tx(
            tx,
            root,
            workspace_id,
            &version_id,
            &job.target_path,
            bytes,
            now_ms,
        )?;
    }
    Ok(ExportedDeleteRecovery::Settled)
}

fn capture_current_bytes_in_tx(
    tx: &Transaction<'_>,
    root: &Path,
    workspace_id: &str,
    version_id: &str,
    path: &str,
    bytes: Vec<u8>,
    now_ms: i64,
) -> Result<(), RuntimeError> {
    let media = dohc_engine_files::media::media_type_for_path(path);
    let text = dohc_engine_files::media::is_text_media_type(media, path)
        .then(|| std::str::from_utf8(&bytes).ok())
        .flatten()
        .filter(|text| text.len() <= dohc_engine_domain::MAX_TEXT_BYTES);
    let moment = if let Some(text) = text {
        let result = dohc_engine_domain::capture_ingest_in_tx(
            tx,
            &CaptureIngest {
                workspace_id: workspace_id.into(),
                version_id: version_id.into(),
                path: path.into(),
                text: text.into(),
                metadata_origin: "capture".into(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms,
                request_id: None,
                claim_foreign_head: true,
            },
        )?;
        crate::search::upsert_file_search_index(
            tx,
            root,
            workspace_id,
            version_id,
            &result.object.object_id,
            path,
            text,
        )?;
        result.moment.moment_id
    } else {
        dohc_engine_domain::capture_ingest_binary_in_tx(
            tx,
            &CaptureIngestBinary {
                workspace_id: workspace_id.into(),
                version_id: version_id.into(),
                path: path.into(),
                bytes,
                metadata_origin: "capture".into(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms,
                request_id: None,
                claim_foreign_head: true,
            },
        )?
        .moment_id
    };
    super::journal::journal_moment_outbound_in_tx(tx, workspace_id, &moment, false)?;
    Ok(())
}
