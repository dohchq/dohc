use crate::RuntimeError;
use dohc_engine_domain::{CaptureIngest, CaptureIngestBinary, DomainError};
use dohc_engine_files::materialize::{PublicationTarget, read_publication_target};
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

#[allow(clippy::too_many_arguments)]
pub(super) fn recover_exported_on_store(
    store: &mut EngineStore,
    root: &Path,
    workspace_id: &str,
    job_id: &str,
    moment_id: &str,
    now_ms: i64,
    faults: &dyn FaultInjector,
    holds: Option<&dohc_engine_files::PlacementHolds>,
) -> Result<ExportedDeleteRecovery, RuntimeError> {
    // Ordinary unpublished recovery needs no extra writer commit. Exported
    // settlement rechecks this reference together with the job inside its write.
    if !store.read_with(|conn| {
        dohc_engine_domain::moment_has_replication_dependents_in(conn, workspace_id, moment_id)
    })? {
        return Ok(ExportedDeleteRecovery::NotExported);
    }
    match store.write_with(faults, |tx| {
        recover_exported_in_tx(tx, root, workspace_id, job_id, moment_id, now_ms, holds)
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
    moment_id: &str,
    now_ms: i64,
    holds: Option<&dohc_engine_files::PlacementHolds>,
) -> Result<ExportedDeleteRecovery, RuntimeError> {
    let Some(job) = dohc_engine_storage::materialize::load_job(tx, job_id)? else {
        return Ok(ExportedDeleteRecovery::Settled);
    };
    if job.workspace_id != workspace_id {
        return Err(DomainError::WorkspaceMismatch.into());
    }
    if !dohc_engine_domain::moment_has_replication_dependents_in(tx, workspace_id, moment_id)? {
        return Ok(ExportedDeleteRecovery::NotExported);
    }
    let (version_id, object_id): (String, String) = tx
        .query_row(
            "SELECT version_id,object_id FROM moments WHERE workspace_id=?1 AND moment_id=?2",
            params![workspace_id, moment_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(StorageError::corrupt_public)?;
    super::versioned::ensure_publication_version(tx, workspace_id, &version_id)?;
    let snapshot: Option<(String, String)> = tx
        .query_row(
            "SELECT path,CASE content_kind WHEN 'binary' THEN binary_sha256 ELSE blob_sha256 END
         FROM snapshots WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
            params![workspace_id, version_id, object_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(StorageError::corrupt_public)?;
    let Some((path, snapshot_sha)) = snapshot else {
        // A later deletion already removed this object. Its old path may now
        // belong to someone else and must not participate in settlement.
        super::versioned::settle_checked_delete_in_tx(tx, workspace_id, moment_id, true, false)?;
        return Ok(ExportedDeleteRecovery::Settled);
    };
    // Recovery uses the object's current path. A hold on its old path may
    // belong to another object and must not prevent this job from settling.
    if holds.is_some_and(|holds| holds.blocks(&path)) {
        return Err(RuntimeError::CaptureFileHeld { path });
    }
    if dohc_engine_files::workspace_recovery_unavailable(root) {
        return Err(dohc_engine_files::MaterializeError::RecoveryUnavailable.into());
    }
    let key = dohc_engine_collab::DocKey::new(workspace_id, &version_id, &object_id)?;
    if !dohc_engine_sync::current_ydoc_content_matches_in_tx(tx, &key, &path, &snapshot_sha)? {
        return Err(DomainError::WritePreconditionFailed {
            current_sha256: Some(snapshot_sha),
        }
        .into());
    }
    let target = read_publication_target(root, &path)?;
    let disk_sha256 = match &target {
        PublicationTarget::Bytes(bytes) => Some(hex_sha256(bytes)),
        PublicationTarget::Absent | PublicationTarget::Untracked => None,
    };
    let recreated =
        job.status == JobStatus::Complete && !matches!(target, PublicationTarget::Absent);
    let prepared = path == job.target_path && snapshot_sha == job.content_sha256;
    let disk_matches = matches!(target, PublicationTarget::Absent)
        || disk_sha256.as_deref() == Some(snapshot_sha.as_str());
    if prepared && disk_matches && !recreated {
        // The materializer rechecks the preimage before it can remove the file.
        tx.execute(
            "UPDATE materialization_jobs SET status='pending',completed_at_ms=NULL
            WHERE workspace_id=?1 AND job_id=?2 AND status='conflict'",
            params![workspace_id, job_id],
        )
        .map_err(StorageError::persist_public)?;
        return Ok(ExportedDeleteRecovery::Publish);
    }
    let bytes = match target {
        PublicationTarget::Bytes(bytes) if capturable(&path, &bytes) => Some(bytes),
        PublicationTarget::Absent => None,
        PublicationTarget::Bytes(_) | PublicationTarget::Untracked => {
            let blocked_write: bool = tx
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM materialization_jobs
                 WHERE (workspace_id=?1 OR workspace_id='') AND target_path=?2
                   AND operation='write' AND status IN ('pending','conflict'))",
                    params![workspace_id, path],
                    |row| row.get(0),
                )
                .map_err(StorageError::corrupt_public)?;
            if blocked_write {
                return Err(DomainError::WritePreconditionFailed {
                    current_sha256: Some(snapshot_sha),
                }
                .into());
            }
            // Capture cannot represent this target. Preserve disk and any live
            // draft or blocked write, then record D without a replacement.
            super::versioned::settle_checked_delete_in_tx(
                tx,
                workspace_id,
                moment_id,
                true,
                false,
            )?;
            eprintln!(
                "engine: exported checked deletion settled without capture: target is not a capturable file ({path})"
            );
            return Ok(ExportedDeleteRecovery::Settled);
        }
    };
    // Ordinary replay runs first. A parked write, an uncaptured disk edit, or
    // an absent projection of a newer head must not retire canonical state.
    if disk_sha256.is_none() || !disk_matches {
        return Err(DomainError::WritePreconditionFailed {
            current_sha256: Some(snapshot_sha),
        }
        .into());
    }
    // D is immutable on peers. Apply it in history, then record the agreed
    // later state after D, without deleting assets or changing disk.
    super::versioned::settle_checked_delete_in_tx(tx, workspace_id, moment_id, true, false)?;
    if let Some(bytes) = bytes {
        capture_current_bytes_in_tx(tx, root, workspace_id, &version_id, &path, bytes, now_ms)?;
    }
    Ok(ExportedDeleteRecovery::Settled)
}

fn capturable(path: &str, bytes: &[u8]) -> bool {
    let media = dohc_engine_files::media::media_type_for_path(path);
    if dohc_engine_files::media::is_text_media_type(media, path)
        && let Ok(text) = std::str::from_utf8(bytes)
        && text.len() <= dohc_engine_domain::MAX_TEXT_BYTES
    {
        return true;
    }
    bytes.len() <= dohc_engine_domain::MAX_CAPTURE_BINARY_FILE_BYTES
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
