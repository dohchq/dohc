use super::error::{map_runtime, workspace_unavailable};
use super::workspace::{OpenWorkspace, WorkspaceOpenMode};
use crate::EngineService;
use dohc_engine_collab::live_update_application::passive::ReplicaJournalRow;
use dohc_engine_protocol::error::{ErrorCode, WireError};
use dohc_engine_protocol::transport::{RequestContext, ServiceResponse};
use dohc_engine_protocol::wire::{Request, Response, WorkspaceHandle};
use serde_json::json;
use std::sync::Arc;

#[derive(Clone)]
pub struct ReplicaInput {
    pub(crate) after: i64,
    pub(crate) epoch_log_floor: i64,
    pub(crate) rows: Vec<ReplicaJournalRow>,
    pub(crate) reservation: Arc<dyn Send + Sync>,
}

impl EngineService {
    pub(crate) fn replica_open(
        &self,
        handle: Option<&WorkspaceHandle>,
    ) -> Result<Arc<OpenWorkspace>, WireError> {
        let open = self.open(handle)?;
        if open.mode != WorkspaceOpenMode::Passive {
            return Err(WireError::new(
                ErrorCode::Forbidden,
                "journal application requires a passive store",
            ));
        }
        Ok(open)
    }

    pub(super) async fn replica_frontiers(
        &self,
        handle: Option<WorkspaceHandle>,
    ) -> Result<serde_json::Value, WireError> {
        let open = self.replica_open(handle.as_ref())?;
        let workspace = open.workspace_id.clone();
        let frontiers = open
            .actor
            .replica_frontiers(workspace)
            .await
            .map_err(map_runtime)?;
        Ok(
            json!({"revision": frontiers.revision, "logCursor": frontiers.log_cursor, "journalCursor": frontiers.journal_cursor}),
        )
    }

    pub(super) async fn replica_apply(
        &self,
        ctx: RequestContext,
        request: Request,
        input: ReplicaInput,
    ) -> Result<ServiceResponse, WireError> {
        let open = self.replica_open(request.workspace.as_ref())?;
        if ctx.cancel.is_cancelled() || ctx.connection.as_ref().is_none_or(|c| !c.is_current()) {
            return Err(workspace_unavailable());
        }
        let workspace = open.workspace_id.clone();
        let result = open
            .actor
            .apply_replica_page(
                workspace,
                input.after,
                input.epoch_log_floor,
                input.rows,
                input.reservation,
            )
            .await
            .map_err(map_runtime)?;
        Ok(ServiceResponse::response(Response {
            id: request.id,
            result: serde_json::to_value(result).map_err(|_| workspace_unavailable())?,
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::live_application_ingress::{LiveApplicationIngress, LiveApplicationIngressConfig};
    use dohc_engine_protocol::transport::ConnectionOwner;
    use dohc_engine_testkit::ScratchDir;

    #[tokio::test]
    async fn an_owner_store_refuses_the_journal_rpc_before_accepting_bytes() {
        let scratch = ScratchDir::new().unwrap();
        let service = Arc::new(EngineService::new());
        let opened = service
            .workspace_open(
                &RequestContext::unbounded(),
                json!({"rootDir":scratch.path(),"workspaceId":"ws","captureMode":"none"}),
            )
            .await
            .unwrap();
        let handle: WorkspaceHandle = serde_json::from_value(opened["workspace"].clone()).unwrap();
        let owner = ConnectionOwner::authenticated();
        let mut ingress = LiveApplicationIngress::new(
            service.clone(),
            LiveApplicationIngressConfig {
                aggregate_bytes: 2 * 1024 * 1024 * 1024,
                application_working_reserve_bytes: 32 * 1024 * 1024,
                max_uploads: 1,
                upload_deadline: std::time::Duration::from_secs(120),
            },
        )
        .unwrap();
        let request = Request {
            id: 1,
            method: "replica.applyJournalPage".into(),
            workspace: Some(handle.clone()),
            idempotency_key: None,
            progress: false,
            deadline_ms: Some(1000),
            params: json!({"after":0,"epochLogFloor":0,"streamId":1,"byteLength":6,"digest":dohc_engine_storage::hex_sha256(b"page")}),
        };
        assert_eq!(
            ingress.begin(request, &owner.handle()).unwrap_err().code,
            ErrorCode::Forbidden
        );
        assert_eq!(
            service
                .replica_frontiers(Some(handle.clone()))
                .await
                .unwrap_err()
                .code,
            ErrorCode::Forbidden
        );
        service.workspace_close(Some(handle)).await.unwrap();
    }
}
