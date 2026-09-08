use super::ActorHandle;
use super::journal::{
    journal_secret_delete_outbound_in_tx, journal_secret_fork_outbound_in_tx,
    journal_secret_moment_outbound_in_tx, journal_secret_put_outbound_in_tx,
};
use crate::error::RuntimeError;
use dohc_engine_crypto::SecretDataKey;
use dohc_engine_domain::{
    InbandSecret, SecretComparePage, SecretDelete, SecretFileStat, SecretFileStore,
    SecretMomentPage, SecretMomentRecord, SecretRestoreResult, SecretWrite, SecretWriteResult,
    apply_secret_file_from_version_with, compare_secret_files_page_keyless,
    delete_secret_file_keyless_with, fork_version_keyless_with, get_secret_moment_keyless,
    has_secret_state, list_secret_files_keyless_page, list_secret_moments_page_keyless,
    restore_secret_file_verbatim_with_metadata_and_after, secret_file_len_keyless,
};
use dohc_engine_storage::FaultInjector;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

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

    pub async fn write_secret_file(
        &self,
        input: SecretWrite,
        key: SecretDataKey,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
    ) -> Result<SecretWriteResult, RuntimeError> {
        self.run(move |store, _| {
            if token.is_cancelled() {
                Err(RuntimeError::Cancelled)
            } else {
                SecretFileStore::new(store, &key)
                    .write_secret_file_with(&input, faults.as_ref(), |tx, result| {
                        journal_secret_put_outbound_in_tx(tx, result)
                    })
                    .map_err(RuntimeError::from)
            }
        })
        .await
    }

    pub async fn delete_secret_file(
        &self,
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
