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
    SecretWriteResult, apply_secret_file_from_version_with, compare_secret_files_page_keyless,
    delete_secret_file_keyless_with, fork_version_keyless_with, get_secret_moment_keyless,
    has_secret_state, list_secret_files_keyless_page, list_secret_moments_page_keyless,
    restore_secret_file_verbatim_with_metadata_and_after, secret_file_len_keyless,
    validate_secret_path,
};
use dohc_engine_files::{ProjectionTargetKind, floor::path_collision_key, probe_projection_target};
use dohc_engine_storage::{EngineStore, FaultInjector, MaterializationOperation, Preimage};
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

/// What the protected file at `path` holds when a job queued now reaches it:
/// what it holds now, or nothing when a pending delete of another spelling of
/// the same entry clears those bytes first.
fn secret_disk_preimage(
    store: &EngineStore,
    root_dir: &Path,
    workspace_id: &str,
    path: &str,
) -> Result<Preimage, RuntimeError> {
    let path = validate_secret_path(path)?;
    let on_disk = projection_preimage(&probe_projection_target(
        root_dir,
        &path,
        ProjectionTargetKind::Secret,
    ))
    .ok_or(DomainError::InvalidPath {
        reason: "protected file on disk is not a readable text file",
    })?;
    let entry = path_collision_key(&path);
    let cleared_first = store
        .list_pending_materialization_jobs()?
        .into_iter()
        .any(|job| {
            job.job_id.starts_with("secret-mat_")
                && job.operation == MaterializationOperation::Delete
                && job.workspace_id == workspace_id
                && job.target_path != path
                && job.preimage == on_disk
                && path_collision_key(&job.target_path) == entry
        });
    Ok(if cleared_first {
        Preimage::Absent
    } else {
        on_disk
    })
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
                let disk_intent = match disk {
                    SecretWriteDisk::Queue { root_dir } => SecretDiskIntent::Materialize {
                        expected: secret_disk_preimage(
                            store,
                            &root_dir,
                            &input.workspace_id,
                            &input.path,
                        )?,
                    },
                    SecretWriteDisk::AlreadyOnDisk => SecretDiskIntent::AlreadyOnDisk,
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
                let expected =
                    secret_disk_preimage(store, &root_dir, &input.workspace_id, &input.path)?;
                delete_secret_file_keyless_with(
                    store,
                    &input,
                    expected,
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
                let expected = secret_disk_preimage(store, &root_dir, &workspace_id, &path)?;
                apply_secret_file_from_version_with(
                    store,
                    &key,
                    &dohc_engine_domain::ApplySecretFileFromVersion {
                        workspace_id,
                        path,
                        from_version_id,
                        to_version_id,
                        moment_id,
                        metadata_origin,
                        metadata_summary,
                        metadata_correlation_id,
                        now_ms,
                    },
                    expected,
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
                let expected = secret_disk_preimage(store, &root_dir, &workspace_id, &path)?;
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
                    expected,
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
