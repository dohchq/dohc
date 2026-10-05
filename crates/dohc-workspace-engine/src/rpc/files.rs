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

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WorkStatsParams {}

impl EngineService {
    pub(super) fn files_work_stats(
        &self,
        workspace: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let _: WorkStatsParams = parse(params)?;
        let open = self.open(workspace.as_ref())?;
        Ok(serde_json::json!({
            "generation": open.observation.feed.generation(),
            "observation": open.observation.observation_work.snapshot(),
            "capture": open.observation.capture_work.snapshot(),
        }))
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
    async fn stats_are_read_only_binding_scoped_and_reject_stale_handles() {
        let first_root = dohc_engine_testkit::ScratchDir::new().unwrap();
        let second_root = dohc_engine_testkit::ScratchDir::new().unwrap();
        std::fs::write(first_root.path().join("note.md"), "first binding").unwrap();
        let supervisor = Box::leak(Box::new(WorkspaceSupervisor::new()));
        let service = EngineService::with_supervisor(supervisor);
        let ctx = RequestContext::unbounded();
        let mut handles = Vec::new();
        for (root, id) in [
            (first_root.path(), "stats-first"),
            (second_root.path(), "stats-second"),
        ] {
            let opened = service
                .workspace_open(
                    &ctx,
                    json!({ "rootDir": root, "workspaceId": id, "captureMode": "none" }),
                )
                .await
                .unwrap();
            let handle: WorkspaceHandle =
                serde_json::from_value(opened["workspace"].clone()).unwrap();
            let open = service.open(Some(&handle)).unwrap();
            let mut ready = open.observation.files.subscribe();
            let mut wake = open.observation.feed.subscribe();
            while !open.observation.changes_since(None).ready {
                tokio::select! {
                    changed = ready.changed() => changed.unwrap(),
                    changed = wake.changed() => changed.unwrap(),
                }
            }
            if let Some(shutdown) = open.observation.begin_shutdown() {
                shutdown.await.unwrap();
            }
            // Keep the workspace binding open with native workers stopped. Any
            // queued drain or actor request would fail instead of answering.
            let before = open.observation.observation_work.snapshot();
            let feed_before = open.observation.changes_since(None).cursor;
            let stats = service
                .files_work_stats(Some(handle.clone()), json!({}))
                .unwrap();
            assert_eq!(stats["observation"], serde_json::to_value(before).unwrap());
            assert_eq!(
                stats["capture"],
                serde_json::to_value(dohc_engine_files::NativeWorkSnapshot::default()).unwrap()
            );
            assert_eq!(stats["generation"], feed_before.generation);
            for _ in 0..3 {
                assert_eq!(
                    service
                        .files_work_stats(Some(handle.clone()), json!({}))
                        .unwrap(),
                    stats
                );
            }
            assert_eq!(open.observation.observation_work.snapshot(), before);
            assert_eq!(open.observation.changes_since(None).cursor, feed_before);
            handles.push((handle, stats));
        }
        assert_ne!(handles[0].1["generation"], handles[1].1["generation"]);
        assert!(
            handles[0].1["observation"]["filesEnumerated"]
                .as_u64()
                .unwrap()
                > 0
        );
        assert_eq!(handles[1].1["observation"]["filesEnumerated"], 0);
        assert!(service.files_work_stats(None, json!({})).is_err());
        assert!(
            service
                .files_work_stats(Some(WorkspaceHandle("foreign".into())), json!({}))
                .is_err()
        );
        assert!(
            service
                .files_work_stats(Some(handles[0].0.clone()), json!({ "drain": true }))
                .is_err()
        );
        let feed_generation = handles[0].1["generation"].clone();
        for (handle, _) in handles {
            service.workspace_close(Some(handle.clone())).await.unwrap();
            assert!(service.files_work_stats(Some(handle), json!({})).is_err());
        }
        let reopened = service.workspace_open(&ctx, json!({ "rootDir": first_root.path(), "workspaceId": "stats-first", "captureMode": "none" })).await.unwrap();
        let handle: WorkspaceHandle =
            serde_json::from_value(reopened["workspace"].clone()).unwrap();
        let stats = service
            .files_work_stats(Some(handle.clone()), json!({}))
            .unwrap();
        assert_ne!(stats["generation"], feed_generation);
        service.workspace_close(Some(handle)).await.unwrap();
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
