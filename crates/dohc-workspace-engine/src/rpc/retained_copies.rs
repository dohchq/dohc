use crate::EngineService;
use crate::rpc::request::parse;
use crate::rpc::workspace::OpenWorkspace;
use dohc_engine_protocol::error::ErrorCode;
use dohc_engine_protocol::error::WireError;
use dohc_engine_protocol::wire::WorkspaceHandle;
use dohc_engine_storage::RetainedSummary;
use serde::Deserialize;
use serde_json::Value;
use serde_json::json;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(
    not(unix),
    expect(dead_code, reason = "only Unix retains copies to delete")
)]
struct RetainedCopyParam {
    id: i64,
    revision: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RetainedCopiesDeleteParams {
    copies: Vec<RetainedCopyParam>,
    accept_late_write_risk: bool,
}

pub(super) fn summary_json(summary: RetainedSummary) -> Value {
    json!({ "count": summary.count, "bytes": summary.bytes })
}

/// The workspace's retained originals the sweep can never release. Read from
/// the engine's rows; no file is opened. Elsewhere than on Unix, a replace
/// deletes its original at once and retains none.
pub(super) async fn retained_summary(open: &OpenWorkspace) -> Result<RetainedSummary, WireError> {
    #[cfg(unix)]
    {
        open.actor
            .retained_copies_summary(open.workspace_id.clone())
            .await
            .map_err(crate::rpc::error::map_runtime)
    }
    #[cfg(not(unix))]
    {
        let _ = open;
        Ok(RetainedSummary::default())
    }
}

impl EngineService {
    /// `retainedCopies.list`: the old versions of files a replace set aside on
    /// a volume that cannot tell dohc whether a program still has one open,
    /// so dohc never deletes them itself. `copies` names those an explicit
    /// `retainedCopies.delete` may delete now, oldest first, each with the
    /// revision its delete must match; `more` says there are others past
    /// these. `total` counts every such copy and its logical size, including
    /// copies changed in the last 30 seconds or whose file is held.
    pub(super) async fn retained_copies_list(
        &self,
        handle: Option<WorkspaceHandle>,
    ) -> Result<Value, WireError> {
        let open = self.open(handle.as_ref())?;
        #[cfg(unix)]
        let (copies, more) = {
            let (copies, more) = open
                .actor
                .list_retained_copies(open.workspace_id.clone())
                .await
                .map_err(crate::rpc::error::map_runtime)?;
            let copies: Vec<Value> = copies
                .iter()
                .map(|copy| json!({ "id": copy.id, "revision": copy.revision }))
                .collect();
            (copies, more)
        };
        #[cfg(not(unix))]
        let (copies, more) = (Vec::<Value>::new(), false);
        let total = retained_summary(&open).await?;
        Ok(json!({
            "copies": copies,
            "more": more,
            "total": summary_json(total),
        }))
    }

    /// `retainedCopies.delete`: delete listed copies. Their volume cannot
    /// tell whether a program still has one open, so a program that does may
    /// lose what it writes next: `acceptLateWriteRisk` must be true. A copy
    /// that changed since it was listed, whose file is held, or that recovery
    /// may still need is skipped. Answers how many were deleted, skipped and
    /// failed, and what remains.
    pub(super) async fn retained_copies_delete(
        &self,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: RetainedCopiesDeleteParams = parse(params)?;
        if !params.accept_late_write_risk {
            return Err(WireError::new(
                ErrorCode::InvalidParams,
                "retainedCopies.delete needs acceptLateWriteRisk: true. A program that still has one of these copies open may lose what it writes next",
            ));
        }
        #[cfg(unix)]
        let limit = dohc_engine_runtime::RETAINED_COPIES_DELETE_LIMIT;
        #[cfg(not(unix))]
        let limit = 100;
        if params.copies.len() > limit {
            return Err(WireError::new(
                ErrorCode::InvalidParams,
                format!("retainedCopies.delete takes at most {limit} copies"),
            ));
        }
        let open = self.open(handle.as_ref())?;
        if !open.is_local_owner() {
            return Err(WireError::new(
                ErrorCode::Forbidden,
                "retainedCopies.delete needs the workspace's owning handle",
            ));
        }
        #[cfg(unix)]
        let outcome = open
            .actor
            .delete_retained_copies(
                open.root.clone(),
                open.workspace_id.clone(),
                params
                    .copies
                    .iter()
                    .map(|copy| dohc_engine_runtime::RetainedCandidate {
                        id: copy.id,
                        revision: copy.revision,
                    })
                    .collect(),
            )
            .await
            .map_err(crate::rpc::error::map_runtime)?;
        #[cfg(unix)]
        let (deleted, skipped, failed, remaining) = (
            outcome.deleted,
            outcome.skipped,
            outcome.failed,
            outcome.remaining,
        );
        #[cfg(not(unix))]
        let (deleted, skipped, failed, remaining) = (
            0u64,
            params.copies.len() as u64,
            0u64,
            retained_summary(&open).await?,
        );
        Ok(json!({
            "deleted": deleted,
            "skipped": skipped,
            "failed": failed,
            "remaining": summary_json(remaining),
        }))
    }
}
