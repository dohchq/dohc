use crate::EngineService;
use crate::rpc::request::{OperationCancellation, now_ms, parse};
use dohc_engine_protocol::{
    error::{ErrorCode, WireError},
    transport::RequestContext,
    wire::WorkspaceHandle,
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::HashSet;
use std::sync::Arc;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Params {
    after: Option<String>,
    budget: usize,
    relay_live: HashSet<String>,
}

impl EngineService {
    pub(super) async fn sync_convert_notes(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: Params = parse(params)?;
        let open = self.open(handle.as_ref())?;
        if !open.is_local_owner() || open.projects_collections() {
            return Err(WireError::new(
                ErrorCode::Forbidden,
                "Only the owner on this computer can convert notes.",
            ));
        }
        if params.budget == 0 {
            return Err(WireError::new(
                ErrorCode::InvalidParams,
                "note-format-two-budget-zero",
            ));
        }
        let cancellation = OperationCancellation::new(ctx);
        let total = Self::read_under_ctx(
            &cancellation,
            "sync.convertNotes",
            open.actor.main_note_count(open.workspace_id.clone()),
        )
        .await?;
        let here = self.leases.scoped(&open.root);
        let relay_live = Arc::new(params.relay_live);
        let mut after = params.after;
        let (mut off, mut converted, mut unchanged) = (false, 0, 0);
        let (mut skipped, mut does_not_fit, mut failed) = (Vec::new(), Vec::new(), Vec::new());
        for _ in 0..params.budget {
            let _serial = tokio::select! {
                biased;
                () = cancellation.token.cancelled() => {
                    return Err(cancellation.interruption("sync.convertNotes (queued)"));
                }
                serial = Arc::clone(&open.session_ops).lock_owned() => serial,
            };
            let pass = Self::read_under_ctx(
                &cancellation,
                "sync.convertNotes",
                open.actor.convert_next_note(
                    open.workspace_id.clone(),
                    open.root.clone(),
                    after.clone(),
                    here.clone(),
                    Arc::clone(&relay_live),
                    now_ms()?,
                ),
            )
            .await?;
            off = pass.off;
            converted += pass.converted.len();
            unchanged += pass.unchanged;
            skipped.extend(pass.skipped.into_iter().map(|(key, path, reason)| {
                json!({"objectId": key.object_id, "path": path, "reason": reason})
            }));
            does_not_fit.extend(pass.does_not_fit.into_iter().map(|(key, path, over)| {
                let limit = over.map(|over| {
                    let (limit, unit) = (over.limit, over.unit);
                    json!({"limit": limit, "unit": unit, "used": over.used, "max": over.max})
                });
                json!({"objectId": key.object_id, "path": path, "limit": limit})
            }));
            failed.extend(pass.failed.into_iter().map(|(object_id, path, reason)| {
                json!({"objectId": object_id, "path": path, "reason": reason})
            }));
            after = pass.resume_after;
            if off || after.is_none() {
                break;
            }
        }
        Ok(json!({
            "off": off,
            "converted": converted,
            "unchanged": unchanged,
            "skipped": skipped,
            "doesNotFit": does_not_fit,
            "failed": failed,
            "resumeAfter": after,
            "total": total,
        }))
    }
}
