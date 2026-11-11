//! `ydoc.liveChange.*`: who stopped or resumed live editing of an owner
//! document. Only the owner's desktop records them; a received share refuses.
//! The author is the desktop's provenance and is never logged.
use crate::EngineService;
use crate::rpc::request::{OperationCancellation, now_ms, parse};
use dohc_engine_domain::live_changes::{BeginLiveChange, LiveChangeOutcome};
use dohc_engine_protocol::error::{ErrorCode, WireError};
use dohc_engine_protocol::transport::RequestContext;
use dohc_engine_protocol::wire::WorkspaceHandle;
use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FinishParams {
    object_id: String,
    change_id: String,
    outcome: LiveChangeOutcome,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ListParams {
    object_ids: Vec<String>,
}

fn encode(value: impl serde::Serialize) -> Result<Value, WireError> {
    serde_json::to_value(value).map_err(|_| WireError::new(ErrorCode::Internal, "encode"))
}

impl EngineService {
    pub(super) async fn live_change(
        &self,
        ctx: &RequestContext,
        workspace: Option<WorkspaceHandle>,
        params: Value,
        action: &str,
    ) -> Result<Value, WireError> {
        let open = self.open(workspace.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        let workspace_id = open.workspace_id.clone();
        match action {
            "begin" => {
                let input: BeginLiveChange = parse(params)?;
                let begun = Self::read_under_ctx(
                    &cancellation,
                    "ydoc.liveChange.begin",
                    open.actor.begin_live_change(
                        workspace_id,
                        input,
                        now_ms()?,
                        cancellation.token(),
                    ),
                )
                .await?;
                encode(begun)
            }
            "finish" => {
                let input: FinishParams = parse(params)?;
                let finished = Self::read_under_ctx(
                    &cancellation,
                    "ydoc.liveChange.finish",
                    open.actor.finish_live_change(
                        workspace_id,
                        input.object_id,
                        input.change_id,
                        input.outcome,
                        cancellation.token(),
                    ),
                )
                .await?;
                Ok(json!({ "finished": finished }))
            }
            "list" => {
                let input: ListParams = parse(params)?;
                let changes = Self::read_under_ctx(
                    &cancellation,
                    "ydoc.liveChange.list",
                    open.actor.list_live_changes(
                        workspace_id,
                        input.object_ids,
                        cancellation.token(),
                    ),
                )
                .await?;
                Ok(json!({ "changes": encode(changes)? }))
            }
            _ => Err(WireError::new(ErrorCode::MethodNotFound, "unknown method")),
        }
    }
}
