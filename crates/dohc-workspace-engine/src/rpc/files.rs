use crate::EngineService;
use crate::rpc::request::{OperationCancellation, parse};
use dohc_engine_files::observation::ObservationCursor;
use dohc_engine_protocol::error::{ErrorCode, WireError};
use dohc_engine_protocol::transport::RequestContext;
use dohc_engine_protocol::wire::WorkspaceHandle;
use serde::Deserialize;
use serde_json::Value;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ChangesParams {
    cursor: Option<ObservationCursor>,
}

impl EngineService {
    pub(super) async fn files_changes_since(
        &self,
        ctx: &RequestContext,
        workspace: Option<WorkspaceHandle>,
        params: Value,
        drain: bool,
    ) -> Result<Value, WireError> {
        let params: ChangesParams = parse(params)?;
        let open = self.open(workspace.as_ref())?;
        if drain {
            let cancellation = OperationCancellation::new(ctx);
            tokio::select! {
                () = cancellation.token.cancelled() => return Err(cancellation.interruption("files.drain")),
                result = open.observation.drain(cancellation.token()) => { result.map_err(|_| WireError::new(ErrorCode::WorkspaceUnavailable, "file-observation-unavailable"))?; }
            }
        }
        serde_json::to_value(open.observation.changes_since(params.cursor.as_ref()))
            .map_err(|_| WireError::new(ErrorCode::Internal, "file-observation-encoding-failed"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use dohc_engine_runtime::WorkspaceSupervisor;
    use serde_json::json;

    #[tokio::test]
    async fn file_observation_rpc_runs_without_capture_and_drains_before_answering() {
        observation_drain("none").await;
    }
    #[tokio::test]
    async fn file_observation_rpc_drains_with_capture_and_a_busy_apply_gate() {
        observation_drain("owned").await;
    }
    async fn observation_drain(mode: &str) {
        let root = dohc_engine_testkit::ScratchDir::new().unwrap();
        let supervisor = Box::leak(Box::new(WorkspaceSupervisor::new()));
        let service = EngineService::with_supervisor(supervisor);
        let ctx = RequestContext::unbounded();
        let opened = service.workspace_open(&ctx, json!({ "rootDir": root.path(), "workspaceId": "observation-disabled", "captureMode": if mode == "none" { Some("none") } else { None } })).await.unwrap();
        let handle: WorkspaceHandle = serde_json::from_value(opened["workspace"].clone()).unwrap();
        let open = service.open(Some(&handle)).unwrap();
        assert_eq!(crate::lock(&open.capture).is_none(), mode == "none");
        let mut ready = open.observation.files.subscribe();
        let mut wake = open.observation.feed.subscribe();
        while !open.observation.changes_since(None).ready {
            tokio::select! {
                changed = ready.changed() => changed.unwrap(),
                changed = wake.changed() => changed.unwrap(),
            }
        }
        let capture_gate = open.capture_apply_gate.lock().await;
        let before = open.observation.changes_since(None).cursor;
        std::fs::write(root.path().join("instant.md"), "before request").unwrap();
        let response = service
            .files_changes_since(
                &ctx,
                Some(handle.clone()),
                json!({ "cursor": before }),
                true,
            )
            .await
            .unwrap();
        assert_eq!(response["resync"], false);
        assert_eq!(
            response["facts"],
            json!([{ "path": "instant.md", "kind": "appeared" }])
        );
        drop(capture_gate);
        service.workspace_close(Some(handle.clone())).await.unwrap();
        assert!(
            service
                .files_changes_since(&ctx, Some(handle), json!({}), false)
                .await
                .is_err()
        );
    }
}
