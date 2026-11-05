use crate::EngineService;
use crate::rpc::request::{OperationCancellation, now_ms, parse};
use dohc_engine_domain::work_references::WorkTargetInput;
use dohc_engine_protocol::error::{ErrorCode, WireError};
use dohc_engine_protocol::transport::RequestContext;
use dohc_engine_protocol::wire::WorkspaceHandle;
use serde::Deserialize;
use serde_json::Value;

/// A target is a handful of ids and at most one path.
const MAX_MAKE_BYTES: usize = 16 * 1024;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct MakeParams {
    target: WorkTargetInput,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ResolveParams {
    reference: String,
}

impl EngineService {
    pub(super) async fn work_references_make(
        &self,
        ctx: &RequestContext,
        workspace: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        if params.to_string().len() > MAX_MAKE_BYTES {
            return Err(WireError::new(
                ErrorCode::InvalidParams,
                "workReferences.make exceeds 16 KiB",
            ));
        }
        let params: MakeParams = parse(params)?;
        let open = self.open(workspace.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        let made = Self::read_under_ctx(
            &cancellation,
            "workReferences.make",
            open.actor.make_work_reference(
                open.workspace_id.clone(),
                params.target,
                now_ms()?,
                cancellation.token(),
            ),
        )
        .await?;
        serde_json::to_value(made).map_err(|_| WireError::new(ErrorCode::Internal, "encode"))
    }

    pub(super) async fn work_references_resolve(
        &self,
        ctx: &RequestContext,
        workspace: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: ResolveParams = parse(params)?;
        let open = self.open(workspace.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        let resolution = Self::read_under_ctx(
            &cancellation,
            "workReferences.resolve",
            open.actor.resolve_work_reference(
                open.workspace_id.clone(),
                params.reference,
                cancellation.token(),
            ),
        )
        .await?;
        serde_json::to_value(resolution).map_err(|_| WireError::new(ErrorCode::Internal, "encode"))
    }
}

#[cfg(test)]
mod tests {
    use crate::EngineService;
    use dohc_engine_protocol::error::ErrorCode;
    use dohc_engine_protocol::transport::RequestContext;
    use dohc_engine_protocol::wire::{Request, WorkspaceHandle};
    use dohc_engine_runtime::WorkspaceSupervisor;
    use serde_json::{Value, json};

    async fn call(
        service: &EngineService,
        handle: &WorkspaceHandle,
        method: &str,
        params: Value,
    ) -> Result<Value, ErrorCode> {
        service
            .dispatch(
                RequestContext::unbounded(),
                Request {
                    id: 1,
                    method: method.to_owned(),
                    workspace: Some(handle.clone()),
                    deadline_ms: None,
                    idempotency_key: None,
                    progress: false,
                    params,
                },
            )
            .await
            .map(|answer| answer.response.result)
            .map_err(|error| error.code)
    }

    #[tokio::test]
    async fn the_engine_makes_and_resolves_references_over_rpc() {
        let root = dohc_engine_testkit::ScratchDir::new().unwrap();
        let supervisor = Box::leak(Box::new(WorkspaceSupervisor::new()));
        let service = EngineService::with_supervisor(supervisor);
        let ctx = RequestContext::unbounded();
        let opened = service
            .workspace_open(
                &ctx,
                json!({ "rootDir": root.path(), "workspaceId": "refs", "captureMode": "none" }),
            )
            .await
            .unwrap();
        let handle: WorkspaceHandle = serde_json::from_value(opened["workspace"].clone()).unwrap();
        service
            .versions_ensure_main(&ctx, Some(handle.clone()), json!({}))
            .await
            .unwrap();
        call(
            &service,
            &handle,
            "versionedText.write",
            json!({
                "versionId": "main", "path": "notes/plan.md", "text": "Plan",
                "objectId": "plan", "origin": "api",
            }),
        )
        .await
        .unwrap();

        // Requests in flight together still share one reference.
        let make = || {
            call(
                &service,
                &handle,
                "workReferences.make",
                json!({ "target": { "kind": "file", "path": "notes/plan.md" } }),
            )
        };
        let (a, b, c, d) = tokio::join!(make(), make(), make(), make());
        let made = [a.unwrap(), b.unwrap(), c.unwrap(), d.unwrap()];
        let reference = made[0]["reference"].as_str().unwrap().to_owned();
        assert_eq!(reference.len(), 43);
        assert!(made.iter().all(|answer| answer["reference"] == reference));
        assert_eq!(
            made.iter()
                .filter(|answer| answer["created"] == json!(true))
                .count(),
            1
        );

        let resolved = call(
            &service,
            &handle,
            "workReferences.resolve",
            json!({ "reference": reference }),
        )
        .await
        .unwrap();
        assert!(resolved["createdAtMs"].as_i64().unwrap() > 0);
        assert_eq!(
            resolved,
            json!({
                "status": "found",
                "reference": reference,
                "target": { "kind": "file", "versionId": "main", "objectId": "plan" },
                "state": "live",
                "path": "notes/plan.md",
                "createdAtMs": resolved["createdAtMs"],
                "registration": "pending",
            })
        );

        for unknown in [String::new(), "not-a-reference".to_owned(), "A".repeat(43)] {
            assert_eq!(
                call(
                    &service,
                    &handle,
                    "workReferences.resolve",
                    json!({ "reference": unknown }),
                )
                .await,
                Ok(json!({ "status": "unknown" }))
            );
        }
        for refused in [
            json!({ "target": { "kind": "file", "path": "missing.md" } }),
            json!({ "target": { "kind": "file", "path": "notes/plan.md", "objectId": "plan" } }),
            json!({ "target": { "kind": "file", "path": "notes/plan.md", "name": "Plan" } }),
            json!({ "target": { "kind": "folder", "path": "notes" } }),
            json!({ "target": { "kind": "message", "messageId": "missing" } }),
            json!({ "target": { "kind": "transactionalCollection", "datasetId": "x", "tableId": "y" } }),
            json!({ "target": { "kind": "file", "path": "x".repeat(super::MAX_MAKE_BYTES) } }),
        ] {
            assert_eq!(
                call(&service, &handle, "workReferences.make", refused.clone()).await,
                Err(ErrorCode::InvalidParams),
                "{refused}"
            );
        }
        service.workspace_close(Some(handle)).await.unwrap();
    }

    #[tokio::test]
    async fn a_received_share_resolves_but_does_not_make_references() {
        let root = dohc_engine_testkit::ScratchDir::new().unwrap();
        let supervisor = Box::leak(Box::new(WorkspaceSupervisor::new()));
        let service = EngineService::with_supervisor(supervisor);
        let opened = service
            .workspace_open(
                &RequestContext::unbounded(),
                json!({ "rootDir": root.path(), "workspaceId": "received",
                    "captureMode": "none", "projectCollections": true }),
            )
            .await
            .unwrap();
        let handle: WorkspaceHandle = serde_json::from_value(opened["workspace"].clone()).unwrap();
        assert_eq!(
            call(
                &service,
                &handle,
                "workReferences.make",
                json!({ "target": { "kind": "message", "messageId": "m" } }),
            )
            .await,
            Err(ErrorCode::Forbidden)
        );
        assert_eq!(
            call(
                &service,
                &handle,
                "workReferences.resolve",
                json!({ "reference": "A".repeat(43) }),
            )
            .await,
            Ok(json!({ "status": "unknown" }))
        );
        service.workspace_close(Some(handle)).await.unwrap();
    }
}
