use super::ActorHandle;
use crate::error::RuntimeError;
use crate::search::{
    GranularChatMessageSearchBatch, SearchPageBatch, SearchResultKey,
    ensure_search_index_for_version, query_chat_messages_granular_bounded, search_workspace_page,
};
use dohc_engine_storage::{FaultInjector, StorageError};
use std::path::PathBuf;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

impl ActorHandle {
    #[allow(clippy::too_many_arguments)]
    pub async fn search_page(
        &self,
        root_dir: PathBuf,
        workspace_id: String,
        version_id: String,
        query: String,
        limit: Option<i64>,
        now_ms: i64,
        expected_generation: Option<u64>,
        after: Option<SearchResultKey>,
        token: CancellationToken,
    ) -> Result<SearchPageBatch, RuntimeError> {
        self.run(move |store, _| {
            if token.is_cancelled() {
                Err(RuntimeError::Cancelled)
            } else {
                store
                    .read_with(|conn| {
                        search_workspace_page(
                            conn,
                            &root_dir,
                            &workspace_id,
                            &version_id,
                            &query,
                            limit,
                            now_ms,
                            expected_generation,
                            after,
                        )
                    })
                    .map_err(RuntimeError::from)
            }
        })
        .await
    }

    pub async fn search_query_chat_messages_granular(
        &self,
        workspace_id: String,
        query: String,
        limit: i64,
        materialized_byte_budget: usize,
    ) -> Result<GranularChatMessageSearchBatch, RuntimeError> {
        self.run(move |store, _| {
            store
                .read_with(|conn| {
                    query_chat_messages_granular_bounded(
                        conn,
                        &workspace_id,
                        &query,
                        limit,
                        materialized_byte_budget,
                    )
                })
                .map_err(RuntimeError::from)
        })
        .await
    }

    pub async fn ensure_search_index(
        &self,
        root_dir: PathBuf,
        workspace_id: String,
        version_id: String,
        now_ms: i64,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
    ) -> Result<(), RuntimeError> {
        self.run(move |store, _| {
            if token.is_cancelled() {
                Err(RuntimeError::Cancelled)
            } else {
                store
                    .read_with(|conn| {
                        ensure_search_index_for_version(
                            conn,
                            &root_dir,
                            &workspace_id,
                            &version_id,
                            now_ms,
                            faults.as_ref(),
                        )
                    })
                    .map_err(RuntimeError::from)
            }
        })
        .await
    }
}

pub(super) fn search_domain(error: crate::search::SearchError) -> dohc_engine_domain::DomainError {
    match error {
        crate::search::SearchError::Storage(error) => {
            dohc_engine_domain::DomainError::Storage(StorageError::persist_public(error))
        }
        crate::search::SearchError::Store(error) => dohc_engine_domain::DomainError::Storage(error),
        crate::search::SearchError::Corrupt(reason)
        | crate::search::SearchError::Bounds(reason) => {
            dohc_engine_domain::DomainError::StateCorrupt { reason }
        }
    }
}
