use super::ActorHandle;
use crate::error::RuntimeError;
use dohc_engine_domain::live_changes::{
    BeginLiveChange, BegunLiveChange, LiveChangeOutcome, LiveDocumentChanges, begin_live_change,
    finish_live_change, list_live_changes,
};
use tokio_util::sync::CancellationToken;

impl ActorHandle {
    /// Record who asked to stop or resume live editing of a document, before
    /// the desktop acts. `None`, recording nothing, when the relay already
    /// shows the result or another change is under way; the desktop still acts.
    pub async fn begin_live_change(
        &self,
        workspace_id: String,
        input: BeginLiveChange,
        now_ms: i64,
        token: CancellationToken,
    ) -> Result<Option<BegunLiveChange>, RuntimeError> {
        self.run(move |store, _| {
            if token.is_cancelled() {
                return Err(RuntimeError::Cancelled);
            }
            begin_live_change(store, &workspace_id, &input, now_ms).map_err(RuntimeError::from)
        })
        .await
    }

    /// Settle the pending change `change_id` names; false when there is none.
    pub async fn finish_live_change(
        &self,
        workspace_id: String,
        object_id: String,
        change_id: String,
        outcome: LiveChangeOutcome,
        token: CancellationToken,
    ) -> Result<bool, RuntimeError> {
        self.run(move |store, _| {
            if token.is_cancelled() {
                return Err(RuntimeError::Cancelled);
            }
            finish_live_change(store, &workspace_id, &object_id, &change_id, outcome)
                .map_err(RuntimeError::from)
        })
        .await
    }

    /// The changes of `object_ids`, and every document with a pending change.
    pub async fn list_live_changes(
        &self,
        workspace_id: String,
        object_ids: Vec<String>,
        token: CancellationToken,
    ) -> Result<Vec<LiveDocumentChanges>, RuntimeError> {
        self.run(move |store, _| {
            if token.is_cancelled() {
                return Err(RuntimeError::Cancelled);
            }
            list_live_changes(store, &workspace_id, &object_ids).map_err(RuntimeError::from)
        })
        .await
    }
}
