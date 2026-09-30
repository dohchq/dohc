use crate::EngineService;
use crate::rpc::error::map_runtime;
use crate::rpc::request::OperationCancellation;
use crate::rpc::request::now_ms;
use crate::rpc::request::parse;
use dohc_engine_files::KeptCopySave;
use dohc_engine_protocol::error::WireError;
use dohc_engine_protocol::transport::RequestContext;
use dohc_engine_protocol::wire::WorkspaceHandle;
use serde::Deserialize;
use serde_json::Value;
use serde_json::json;

/// The most kept copies one list returns. Each one is a file a person has
/// not looked at yet, so a workspace holds a few; `more` says when there are
/// others past these.
const KEPT_COPIES_LIST_LIMIT: usize = 100;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct KeptCopiesSaveParams {
    id: i64,
}

impl EngineService {
    /// `keptCopies.list`: files a replace moved aside because another program
    /// changed them meanwhile, oldest first. Each stays in staging until `keptCopies.save` makes it a visible copy.
    pub(super) async fn kept_copies_list(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
    ) -> Result<Value, WireError> {
        let open = self.open(handle.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        let kept = Self::read_under_ctx(
            &cancellation,
            "keptCopies.list",
            open.actor
                .list_kept_displacements(open.workspace_id.clone()),
        )
        .await?;
        // Orphans have no path to save beside. The recovery-folder notice
        // exposes them through watcher.status; they must not consume this page.
        let kept: Vec<_> = kept
            .into_iter()
            .filter(|row| !row.target_path.is_empty())
            .collect();
        let rows: Vec<Value> = kept
            .iter()
            .take(KEPT_COPIES_LIST_LIMIT)
            .map(|row| {
                json!({
                    "id": row.displacement_id,
                    "path": row.target_path,
                    "keptAtMs": row.created_at_ms,
                })
            })
            .collect();
        Ok(json!({
            "keptCopies": rows,
            "more": kept.len() > KEPT_COPIES_LIST_LIMIT,
        }))
    }

    /// `keptCopies.save`: move one kept copy to `name (kept copy).ext` beside
    /// its path. The answer's `status` is `saved` with the copy's `path`,
    /// `gone` when nothing is kept under that id any more, or `no-valid-name`
    /// when no name beside the file fits the engine's path limits and the copy
    /// stays kept.
    pub(super) async fn kept_copies_save(
        &self,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: KeptCopiesSaveParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        let saved = open
            .actor
            .save_kept_displacement(
                open.root.clone(),
                open.workspace_id.clone(),
                params.id,
                now_ms()?,
            )
            .await
            .map_err(map_runtime)?;
        Ok(match saved {
            KeptCopySave::Saved(path) => json!({ "status": "saved", "path": path }),
            KeptCopySave::Gone => json!({ "status": "gone" }),
            KeptCopySave::NoValidName => json!({ "status": "no-valid-name" }),
        })
    }
}
