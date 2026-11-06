use super::ActorHandle;
use crate::error::RuntimeError;
use dohc_engine_domain::work_references::{
    MadeWorkReference, WorkReferenceResolution, WorkTargetInput, make_work_reference,
    resolve_work_reference,
};
use dohc_engine_storage::NoFaults;
use tokio_util::sync::CancellationToken;

impl ActorHandle {
    /// Return this device's reference for `target`, making one when there is
    /// none.
    pub async fn make_work_reference(
        &self,
        workspace_id: String,
        target: WorkTargetInput,
        now_ms: i64,
        token: CancellationToken,
    ) -> Result<MadeWorkReference, RuntimeError> {
        self.run(move |store, _| {
            if token.is_cancelled() {
                return Err(RuntimeError::Cancelled);
            }
            make_work_reference(store, &workspace_id, &target, now_ms, &NoFaults)
                .map_err(RuntimeError::from)
        })
        .await
    }

    /// Resolve `reference` to the work it names in this workspace.
    pub async fn resolve_work_reference(
        &self,
        workspace_id: String,
        reference: String,
        token: CancellationToken,
    ) -> Result<WorkReferenceResolution, RuntimeError> {
        self.run(move |store, _| {
            if token.is_cancelled() {
                return Err(RuntimeError::Cancelled);
            }
            resolve_work_reference(store, &workspace_id, &reference).map_err(RuntimeError::from)
        })
        .await
    }
}
