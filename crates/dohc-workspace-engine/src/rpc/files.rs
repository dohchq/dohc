use crate::EngineService;
use crate::rpc::request::{OperationCancellation, parse};
use dohc_engine_domain::FileResolveTarget;
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

const MAX_RESOLVE_TARGETS: usize = 128;
const MAX_RESOLVE_BYTES: usize = 48 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ResolveParams {
    version_id: Option<String>,
    targets: Vec<Value>,
}

pub(super) fn resolve_target(value: Value) -> FileResolveTarget {
    let Some(object) = value.as_object() else {
        return FileResolveTarget::Invalid;
    };
    if object.len() != 1 {
        return FileResolveTarget::Invalid;
    }
    if let Some(path) = object.get("path").and_then(Value::as_str) {
        FileResolveTarget::Path(path.to_owned())
    } else if let Some(id) = object.get("objectId").and_then(Value::as_str) {
        FileResolveTarget::ObjectId(id.to_owned())
    } else {
        FileResolveTarget::Invalid
    }
}

impl EngineService {
    pub(super) async fn files_resolve(
        &self,
        ctx: &RequestContext,
        workspace: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        if params.to_string().len() > MAX_RESOLVE_BYTES {
            return Err(WireError::new(
                ErrorCode::InvalidParams,
                "files.resolve exceeds 49152-byte cap",
            ));
        }
        let params: ResolveParams = parse(params)?;
        if params.targets.len() > MAX_RESOLVE_TARGETS {
            return Err(WireError::new(
                ErrorCode::InvalidParams,
                "files.resolve exceeds 128-target cap",
            ));
        }
        let open = self.open(workspace.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        let (version_id, results) = Self::read_under_ctx(
            &cancellation,
            "files.resolve",
            open.actor.resolve_files(
                open.workspace_id.clone(),
                params.version_id,
                params.targets.into_iter().map(resolve_target).collect(),
                cancellation.token(),
            ),
        )
        .await?;
        Ok(serde_json::json!({ "versionId": version_id, "results": results }))
    }

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
    async fn files_resolve_rpc_keeps_invalid_targets_local_and_rejects_unavailable_reads() {
        let root = dohc_engine_testkit::ScratchDir::new().unwrap();
        let supervisor = Box::leak(Box::new(WorkspaceSupervisor::new()));
        let service = EngineService::with_supervisor(supervisor);
        let ctx = RequestContext::unbounded();
        let opened = service.workspace_open(&ctx, json!({ "rootDir": root.path(), "workspaceId": "resolve-test", "captureMode": "none" })).await.unwrap();
        let handle: WorkspaceHandle = serde_json::from_value(opened["workspace"].clone()).unwrap();
        service
            .versions_ensure_main(&ctx, Some(handle.clone()), json!({}))
            .await
            .unwrap();
        let response = service.files_resolve(&ctx, Some(handle.clone()), json!({ "targets": [
            { "path": "missing.md" }, { "path": "../bad" }, { "objectId": "" }, { "path": 12 }, { "objectId": "id", "path": "hint" }, null
        ] })).await.unwrap();
        assert_eq!(
            response["results"],
            json!([{ "status": "absent" }, { "status": "invalid" }, { "status": "invalid" }, { "status": "invalid" }, { "status": "invalid" }, { "status": "invalid" }])
        );
        assert!(
            service
                .files_resolve(
                    &ctx,
                    Some(handle.clone()),
                    json!({ "versionId": "unknown", "targets": [{ "path": "../bad" }] })
                )
                .await
                .is_err()
        );
        assert!(
            service
                .files_resolve(
                    &ctx,
                    Some(handle.clone()),
                    json!({ "targets": vec![json!({"path": "missing"}); 129] })
                )
                .await
                .is_err()
        );
        assert!(
            service
                .files_resolve(
                    &ctx,
                    Some(handle.clone()),
                    json!({ "targets": [{ "path": "x".repeat(MAX_RESOLVE_BYTES) }] })
                )
                .await
                .is_err()
        );
        let cancelled = RequestContext::unbounded();
        cancelled.cancel.cancel();
        assert_eq!(
            service
                .files_resolve(&cancelled, Some(handle.clone()), json!({ "targets": [] }))
                .await
                .unwrap_err()
                .code,
            ErrorCode::Cancelled
        );
        let attached = service.workspace_open(&ctx, json!({ "rootDir": root.path(), "workspaceId": "resolve-test", "skipStartupMaintenance": true, "captureMode": "none" })).await.unwrap();
        let read_only: WorkspaceHandle =
            serde_json::from_value(attached["workspace"].clone()).unwrap();
        let denied = service
            .dispatch(
                RequestContext::unbounded(),
                dohc_engine_protocol::wire::Request {
                    id: 42,
                    method: "files.resolve".into(),
                    workspace: Some(read_only.clone()),
                    deadline_ms: None,
                    idempotency_key: None,
                    progress: false,
                    params: json!({ "targets": [{ "path": "missing.md" }] }),
                },
            )
            .await
            .unwrap_err();
        assert_eq!(denied.code, ErrorCode::InvalidParams);
        assert!(denied.message.contains("read-only"));
        service.workspace_close(Some(read_only)).await.unwrap();
        service.workspace_close(Some(handle.clone())).await.unwrap();
        assert!(
            service
                .files_resolve(&ctx, Some(handle), json!({ "targets": [] }))
                .await
                .is_err()
        );
    }

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
