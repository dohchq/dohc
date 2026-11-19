use super::ActorHandle;
use super::journal::{
    journal_secret_delete_outbound_in_tx, journal_secret_fork_outbound_in_tx,
    journal_secret_moment_outbound_in_tx, journal_secret_put_outbound_in_tx,
};
use super::versions::projection_preimage;
use crate::error::RuntimeError;
use dohc_engine_crypto::{SecretDataKey, SecretPlaintext};
use dohc_engine_domain::{
    DomainError, InbandSecret, SecretComparePage, SecretDelete, SecretDiskIntent, SecretFileStat,
    SecretFileStore, SecretMomentPage, SecretMomentRecord, SecretRestoreResult, SecretWrite,
    SecretWriteResult, VersionedTextStore, apply_secret_file_from_version_with,
    compare_secret_files_page_keyless, delete_secret_file_keyless_with, fork_version_keyless_with,
    get_secret_moment_keyless, has_secret_state, list_secret_files_keyless_page,
    list_secret_moments_page_keyless, restore_secret_file_verbatim_with_metadata_and_after,
    secret_file_len_keyless, validate_secret_path,
};
use dohc_engine_files::{
    ProjectionTargetKind, floor::path_collision_key, may_share_entry, probe_projection_target,
};
use dohc_engine_storage::{FaultInjector, MaterializationOperation, Preimage, StorageError};
use rusqlite::Connection;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

/// Where a protected write's text stands against the workspace file.
#[derive(Debug, Clone)]
pub enum SecretWriteDisk {
    /// Queue a job that writes the file under `root_dir`, only while the file
    /// still holds what it holds when the write is recorded.
    Queue { root_dir: PathBuf },
    /// The text came from the file, so no job runs.
    AlreadyOnDisk,
}

/// What the protected file at `path` holds now. A folder, a link, or a file
/// that is unreadable, too large or not UTF-8 text refuses the change.
fn secret_file_on_disk(root_dir: &Path, path: &str) -> Result<Preimage, DomainError> {
    projection_preimage(&probe_projection_target(
        root_dir,
        path,
        ProjectionTargetKind::Secret,
    ))
    .ok_or(DomainError::InvalidPath {
        reason: "protected file on disk is not a readable text file",
    })
}

/// What a job queued now for the active version's protected file at `path`
/// expects when it reaches the file, as [`dohc_engine_domain::SecretDiskCheck`]
/// asks. A case-only rename queues a delete of one spelling and a write of
/// another over the same disk entry, in either order. Replay runs the delete
/// first, so it expects the bytes there now and the write expects no file:
/// a write queued after the delete expects no file, and a delete queued after
/// the write makes that pending write expect no file.
fn secret_job_preimage(
    conn: &Connection,
    root_dir: &Path,
    workspace_id: &str,
    version_id: &str,
    path: &str,
    operation: MaterializationOperation,
) -> Result<Preimage, DomainError> {
    let on_disk = secret_file_on_disk(root_dir, path)?;
    let Preimage::Present(on_disk_sha) = &on_disk else {
        return Ok(on_disk);
    };
    let other = match operation {
        MaterializationOperation::Write => "delete",
        MaterializationOperation::Delete => "write",
    };
    let mut statement = conn
        .prepare_cached(
            "SELECT j.job_id, j.target_path FROM materialization_jobs j \
             JOIN secret_moments m \
               ON j.workspace_id IN (m.workspace_id, '') AND m.moment_id = substr(j.job_id, 12) \
             WHERE j.status = 'pending' AND j.job_id GLOB 'secret-mat_*' AND j.operation = ?4 \
               AND m.workspace_id = ?1 AND m.version_id = ?2 AND j.target_path <> ?3 \
               AND j.preimage_present = 1 AND j.preimage_sha256 = ?5",
        )
        .map_err(StorageError::corrupt_public)?;
    let aliases = statement
        .query_map(
            rusqlite::params![workspace_id, version_id, path, other, on_disk_sha],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .map_err(StorageError::corrupt_public)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(StorageError::corrupt_public)?;
    let entry = path_collision_key(path);
    let mut aliases = aliases.into_iter().filter(|(_, spelling)| {
        path_collision_key(spelling) == entry && may_share_entry(root_dir, spelling, path)
    });
    match operation {
        MaterializationOperation::Write if aliases.next().is_some() => Ok(Preimage::Absent),
        MaterializationOperation::Write => Ok(on_disk),
        MaterializationOperation::Delete => {
            for (job_id, _) in aliases {
                conn.execute(
                    "UPDATE materialization_jobs \
                     SET preimage_present = 0, preimage_sha256 = NULL WHERE job_id = ?1",
                    [job_id],
                )
                .map_err(StorageError::persist_public)?;
            }
            Ok(on_disk)
        }
    }
}

/// [`secret_job_preimage`] for the workspace file tree at `root_dir`.
fn secret_disk_check<'a>(
    root_dir: &'a Path,
    workspace_id: &'a str,
) -> impl Fn(&Connection, &str, &str, MaterializationOperation) -> Result<Preimage, DomainError> + 'a
{
    move |conn, version_id, path, operation| {
        secret_job_preimage(conn, root_dir, workspace_id, version_id, path, operation)
    }
}

impl ActorHandle {
    /// Whether the workspace holds any encrypted secret state — the async
    /// variant for RPC handlers (a missing key file over live secret rows
    /// must fail closed, never read as "no secrets").
    pub async fn secret_state_exists(&self, workspace_id: String) -> Result<bool, RuntimeError> {
        self.run(move |store, _cache| {
            has_secret_state(store, &workspace_id).map_err(RuntimeError::from)
        })
        .await
    }

    /// Whether the workspace holds any encrypted secret state. The capture
    /// layer consults this before ever minting a data key: a missing key file
    /// over live secret rows must fail closed, never silently strand the
    /// history under a fresh key.
    pub fn secret_state_exists_blocking(&self, workspace_id: String) -> Result<bool, RuntimeError> {
        self.run_blocking(move |store, _cache| {
            has_secret_state(store, &workspace_id).map_err(RuntimeError::from)
        })
    }

    /// Secret materialize with the cap decided in the same turn — an
    /// over-cap tip is never decrypted.
    pub async fn materialize_secret_inband(
        &self,
        workspace_id: String,
        version_id: String,
        path: String,
        key: SecretDataKey,
        cap: usize,
    ) -> Result<Option<InbandSecret>, RuntimeError> {
        self.run(move |store, _| {
            SecretFileStore::new(store, &key)
                .materialize_secret_file_inband(&workspace_id, &version_id, &path, cap)
                .map_err(RuntimeError::from)
        })
        .await
    }

    /// Whether protected History for `path`, in any version, holds `text`.
    pub async fn secret_text_recorded(
        &self,
        workspace_id: String,
        path: String,
        text: SecretPlaintext,
        key: SecretDataKey,
    ) -> Result<bool, RuntimeError> {
        self.run(move |store, _| {
            SecretFileStore::new(store, &key)
                .secret_text_recorded(&workspace_id, &path, text.as_bytes())
                .map_err(RuntimeError::from)
        })
        .await
    }

    /// Refuse a protected write to the active version's file at `path` when
    /// that file is a folder, a link, or unreadable, too large or not UTF-8
    /// text, before the write has any effect. Writes to other versions pass.
    pub async fn check_secret_write_target(
        &self,
        root_dir: PathBuf,
        workspace_id: String,
        version_id: String,
        path: String,
    ) -> Result<(), RuntimeError> {
        self.run(move |store, _| {
            let path = validate_secret_path(&path)?;
            if VersionedTextStore::new(store)
                .get_active_version(&workspace_id)?
                .version_id
                == version_id
            {
                secret_file_on_disk(&root_dir, &path)?;
            }
            Ok(())
        })
        .await
    }

    pub async fn write_secret_file(
        &self,
        input: SecretWrite,
        disk: SecretWriteDisk,
        key: SecretDataKey,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
    ) -> Result<SecretWriteResult, RuntimeError> {
        self.run(move |store, _| {
            if token.is_cancelled() {
                Err(RuntimeError::Cancelled)
            } else {
                let check = match &disk {
                    SecretWriteDisk::Queue { root_dir } => {
                        Some(secret_disk_check(root_dir, &input.workspace_id))
                    }
                    SecretWriteDisk::AlreadyOnDisk => None,
                };
                let disk_intent = match &check {
                    Some(check) => SecretDiskIntent::Materialize { check },
                    None => SecretDiskIntent::AlreadyOnDisk,
                };
                SecretFileStore::new(store, &key)
                    .write_secret_file_with(&input, disk_intent, faults.as_ref(), |tx, result| {
                        journal_secret_put_outbound_in_tx(tx, result)
                    })
                    .map_err(RuntimeError::from)
            }
        })
        .await
    }

    pub async fn delete_secret_file(
        &self,
        root_dir: PathBuf,
        input: SecretDelete,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
    ) -> Result<Option<SecretMomentRecord>, RuntimeError> {
        self.run(move |store, _| {
            if token.is_cancelled() {
                Err(RuntimeError::Cancelled)
            } else {
                delete_secret_file_keyless_with(
                    store,
                    &input,
                    &secret_disk_check(&root_dir, &input.workspace_id),
                    faults.as_ref(),
                    journal_secret_delete_outbound_in_tx,
                )
                .map_err(RuntimeError::from)
            }
        })
        .await
    }

    pub async fn fork_secret_version(
        &self,
        workspace_id: String,
        from_version_id: String,
        to_version_id: String,
        now_ms: i64,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
    ) -> Result<(), RuntimeError> {
        self.run(move |store, _| {
            if token.is_cancelled() {
                Err(RuntimeError::Cancelled)
            } else {
                fork_version_keyless_with(
                    store,
                    &workspace_id,
                    &from_version_id,
                    &to_version_id,
                    faults.as_ref(),
                    |tx| {
                        journal_secret_fork_outbound_in_tx(
                            tx,
                            &workspace_id,
                            &from_version_id,
                            &to_version_id,
                            now_ms,
                        )
                    },
                )
                .map_err(RuntimeError::from)
            }
        })
        .await
    }

    pub async fn list_secret_moments(
        &self,
        workspace_id: String,
        version_id: Option<String>,
        path: Option<String>,
        before_moment_order: Option<i64>,
        limit: usize,
    ) -> Result<SecretMomentPage, RuntimeError> {
        self.run(move |store, _| {
            list_secret_moments_page_keyless(
                store,
                &workspace_id,
                version_id.as_deref(),
                path.as_deref(),
                before_moment_order,
                limit,
            )
            .map_err(RuntimeError::from)
        })
        .await
    }

    pub async fn get_secret_moment(
        &self,
        workspace_id: String,
        moment_id: String,
    ) -> Result<Option<SecretMomentRecord>, RuntimeError> {
        self.run(move |store, _| {
            get_secret_moment_keyless(store, &workspace_id, &moment_id).map_err(RuntimeError::from)
        })
        .await
    }

    pub async fn compare_secret_files(
        &self,
        workspace_id: String,
        source_version_id: String,
        target_version_id: String,
        after_path: Option<String>,
        limit: usize,
        key: Option<SecretDataKey>,
    ) -> Result<SecretComparePage, RuntimeError> {
        self.run(move |store, _| {
            compare_secret_files_page_keyless(
                store,
                key.as_ref(),
                &workspace_id,
                &source_version_id,
                &target_version_id,
                after_path.as_deref(),
                limit,
            )
            .map_err(RuntimeError::from)
        })
        .await
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn apply_secret_file(
        &self,
        root_dir: PathBuf,
        workspace_id: String,
        path: String,
        from_version_id: String,
        to_version_id: String,
        moment_id: String,
        metadata_origin: String,
        metadata_summary: Option<String>,
        metadata_correlation_id: Option<String>,
        now_ms: i64,
        key: SecretDataKey,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
    ) -> Result<SecretWriteResult, RuntimeError> {
        self.run(move |store, _| {
            if token.is_cancelled() {
                Err(RuntimeError::Cancelled)
            } else {
                apply_secret_file_from_version_with(
                    store,
                    &key,
                    &dohc_engine_domain::ApplySecretFileFromVersion {
                        workspace_id: workspace_id.clone(),
                        path,
                        from_version_id,
                        to_version_id,
                        moment_id,
                        metadata_origin,
                        metadata_summary,
                        metadata_correlation_id,
                        now_ms,
                    },
                    &secret_disk_check(&root_dir, &workspace_id),
                    faults.as_ref(),
                    |tx, result| journal_secret_moment_outbound_in_tx(tx, result.moment.as_ref()),
                )
                .map_err(RuntimeError::from)
            }
        })
        .await
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn restore_secret_file(
        &self,
        root_dir: PathBuf,
        workspace_id: String,
        path: String,
        before_moment_id: String,
        moment_id: String,
        metadata_origin: String,
        metadata_summary: Option<String>,
        metadata_correlation_id: Option<String>,
        now_ms: i64,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
    ) -> Result<SecretRestoreResult, RuntimeError> {
        self.run(move |store, _| {
            if token.is_cancelled() {
                Err(RuntimeError::Cancelled)
            } else {
                restore_secret_file_verbatim_with_metadata_and_after(
                    store,
                    &workspace_id,
                    &path,
                    &before_moment_id,
                    &moment_id,
                    &metadata_origin,
                    metadata_summary,
                    metadata_correlation_id,
                    now_ms,
                    &secret_disk_check(&root_dir, &workspace_id),
                    faults.as_ref(),
                    |tx, result| journal_secret_moment_outbound_in_tx(tx, result.moment.as_ref()),
                )
                .map_err(RuntimeError::from)
            }
        })
        .await
    }

    /// One secret tip's recorded byte length — keyless, no decrypt.
    pub async fn secret_file_len(
        &self,
        workspace_id: String,
        version_id: String,
        path: String,
    ) -> Result<Option<i64>, RuntimeError> {
        self.run(move |store, _| {
            secret_file_len_keyless(store, &workspace_id, &version_id, &path)
                .map_err(RuntimeError::from)
        })
        .await
    }

    /// One page of secret-file tips (metadata only, keyset by path).
    pub async fn list_secret_files_page(
        &self,
        workspace_id: String,
        version_id: String,
        after_path: Option<String>,
        limit: usize,
    ) -> Result<Vec<SecretFileStat>, RuntimeError> {
        self.run(move |store, _| {
            list_secret_files_keyless_page(
                store,
                &workspace_id,
                &version_id,
                after_path.as_deref(),
                limit,
            )
            .map_err(RuntimeError::from)
        })
        .await
    }
}
