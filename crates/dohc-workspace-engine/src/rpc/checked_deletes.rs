use super::{
    error::map_runtime,
    request::{OperationCancellation, now_ms, parse},
};
use crate::EngineService;
use dohc_engine_protocol::{
    error::{ErrorCode, WireError},
    transport::RequestContext,
    wire::WorkspaceHandle,
};
use dohc_engine_runtime::actor::{CheckedDeleteAction, CheckedDeleteResolution};
use serde::Deserialize;
use serde_json::{Value, json};
use std::sync::Arc;

#[derive(Deserialize)]
#[serde(rename_all = "kebab-case")]
enum ResolutionAction {
    Retry,
    FinishDelete,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ResolveParams {
    moment_id: String,
    expected_sha256: String,
    action: ResolutionAction,
}

impl EngineService {
    pub(super) async fn checked_deletes_list(
        &self,
        handle: Option<WorkspaceHandle>,
    ) -> Result<Value, WireError> {
        let open = self.open(handle.as_ref())?;
        if !open.is_local_owner() {
            return Err(WireError::new(
                ErrorCode::Forbidden,
                "checked-delete-owner-required",
            ));
        }
        let deletions = open
            .actor
            .pending_checked_deletes(open.workspace_id.clone())
            .await
            .map_err(map_runtime)?;
        let deletions: Vec<_> = deletions.into_iter().map(|row| json!({
            "momentId": row.moment_id, "versionId": row.version_id, "objectId": row.object_id,
            "path": row.path, "expectedSha256": row.expected_sha256, "reason": row.reason,
            "action": match row.action {CheckedDeleteAction::Retry => "retry", CheckedDeleteAction::FinishDelete => "finish-delete"},
        })).collect();
        Ok(json!({"deletions": deletions}))
    }

    pub(super) async fn checked_deletes_resolve(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let input: ResolveParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        if !open.is_local_owner() {
            return Err(WireError::new(
                ErrorCode::Forbidden,
                "checked-delete-owner-required",
            ));
        }
        let cancellation = OperationCancellation::new(ctx);
        let _session = self
            .mutation_session_guard(&open, &cancellation, "checkedDeletes.resolve (queued)")
            .await?;
        let rows = open
            .actor
            .pending_checked_deletes(open.workspace_id.clone())
            .await
            .map_err(map_runtime)?;
        if let Some(row) = rows.iter().find(|row| row.moment_id == input.moment_id) {
            self.ensure_path_not_leased(&open, &row.version_id, &row.path)
                .await?;
        }
        open.actor
            .resolve_checked_delete(
                open.root.clone(),
                open.workspace_id.clone(),
                CheckedDeleteResolution {
                    moment_id: input.moment_id,
                    expected_sha256: input.expected_sha256,
                    action: match input.action {
                        ResolutionAction::Retry => CheckedDeleteAction::Retry,
                        ResolutionAction::FinishDelete => CheckedDeleteAction::FinishDelete,
                    },
                },
                Arc::new(self.self_writes.scoped(&open.root)),
                now_ms()?,
            )
            .await
            .map_err(map_runtime)?;
        Ok(json!({"settled": true}))
    }
}
