use super::error::{map_runtime, workspace_unavailable};
use super::workspace::{OpenWorkspace, WorkspaceOpenMode};
use crate::EngineService;
use dohc_engine_collab::live_update_application::passive::ReplicaJournalEntry;
use dohc_engine_protocol::error::{ErrorCode, WireError};
use dohc_engine_protocol::transport::{RequestContext, ServiceResponse};
use dohc_engine_protocol::wire::{Request, Response, WorkspaceHandle};
use serde_json::json;
use std::sync::Arc;

#[derive(Clone)]
pub struct ReplicaInput {
    pub(crate) after: i64,
    pub(crate) epoch_log_floor: i64,
    pub(crate) rows: Vec<ReplicaJournalEntry>,
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

    pub(super) async fn replica_cut(
        &self,
        handle: Option<WorkspaceHandle>,
        params: serde_json::Value,
    ) -> Result<serde_json::Value, WireError> {
        let open = self.replica_open(handle.as_ref())?;
        let request = serde_json::from_value(params).map_err(|_| {
            WireError::new(ErrorCode::InvalidParams, "invalid current view request")
        })?;
        let view = open
            .actor
            .replica_current_view(open.workspace_id.clone(), request)
            .await
            .map_err(map_runtime)?;
        serde_json::to_value(view).map_err(|_| workspace_unavailable())
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
        let request = Request {
            id: 99,
            method: "replica.cut".into(),
            workspace: Some(handle.clone()),
            idempotency_key: None,
            progress: false,
            deadline_ms: None,
            params: json!({"incarnation":"test","selectors":[]}),
        };
        assert_eq!(
            service
                .dispatch(RequestContext::unbounded(), request)
                .await
                .err()
                .unwrap()
                .code,
            ErrorCode::Forbidden
        );
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
    #[tokio::test]
    async fn current_view_manifest_matches_reads_and_excludes_private_paths() {
        let scratch = ScratchDir::new().unwrap();
        let service = EngineService::new();
        let opened=service.workspace_open(&RequestContext::unbounded(),json!({"rootDir":scratch.path(),"workspaceId":"ws","storeMode":"passive","captureMode":"none"})).await.unwrap();
        let handle: WorkspaceHandle = serde_json::from_value(opened["workspace"].clone()).unwrap();
        service.workspace_close(Some(handle)).await.unwrap();
        let mut store = dohc_engine_storage::EngineStore::open_passive(
            &scratch.path().join(".dohc/engine/engine.db"),
            0,
            None,
            None,
        )
        .unwrap();
        store.write_with(&dohc_engine_storage::NoFaults,|tx| {
                tx.execute("INSERT OR IGNORE INTO versioned_workspaces VALUES('ws','main')",[]).map_err(dohc_engine_storage::StorageError::persist_public)?;
                tx.execute("INSERT OR IGNORE INTO versions(workspace_id,version_id,kind,name,created_at_ms) VALUES('ws','main','main','Main',0)",[]).map_err(dohc_engine_storage::StorageError::persist_public)?;
                for (object,path,text) in [("one","docs/one.md","é\n"),("two","docs/two.md","second"),("private",".env","secret"),("ignored","node_modules/a.md","ignored"),("outside","other/a.md","outside")] {
                    let sha=dohc_engine_storage::hex_sha256(text.as_bytes());
                    tx.execute("INSERT INTO blobs VALUES(?1,?2,?3)",rusqlite::params![sha,text.len() as i64,text]).map_err(dohc_engine_storage::StorageError::persist_public)?;
                    tx.execute("INSERT INTO file_objects VALUES('ws',?1,0)",[object]).map_err(dohc_engine_storage::StorageError::persist_public)?;
                    tx.execute("INSERT INTO path_aliases VALUES('ws','main',?1,?2)",rusqlite::params![path,object]).map_err(dohc_engine_storage::StorageError::persist_public)?;
                    tx.execute("INSERT INTO snapshots(workspace_id,version_id,object_id,path,blob_sha256,updated_at_ms,latest_moment_id,metadata_origin) VALUES('ws','main',?1,?2,?3,0,'m','test')",rusqlite::params![object,path,sha]).map_err(dohc_engine_storage::StorageError::persist_public)?;
                }
                dohc_engine_storage::replica::advance_frontiers(tx,"ws",7,11)?;
                Ok::<_,dohc_engine_storage::StorageError>(())
            }).unwrap();
        drop(store);
        let opened=service.workspace_open(&RequestContext::unbounded(),json!({"rootDir":scratch.path(),"workspaceId":"ws","storeMode":"passive","captureMode":"none"})).await.unwrap();
        let handle: WorkspaceHandle = serde_json::from_value(opened["workspace"].clone()).unwrap();
        let result = service
            .replica_cut(
                Some(handle.clone()),
                json!({"incarnation":"test","selectors":[{"versionId":"main","paths":["docs"]}]}),
            )
            .await
            .unwrap();
        assert_eq!(result["files"].as_array().unwrap().len(), 2);
        assert_eq!(result["logCursor"], 7);
        assert_eq!(result["journalCursor"], 11);
        for file in result["files"].as_array().unwrap() {
            let snapshot = service
                .versioned_text_read(
                    &RequestContext::unbounded(),
                    Some(handle.clone()),
                    json!({"versionId":file["versionId"],"path":file["path"]}),
                )
                .await
                .unwrap();
            for field in [
                "versionId",
                "objectId",
                "path",
                "sha256",
                "byteLength",
                "contentKind",
            ] {
                assert_eq!(file[field], snapshot[field], "{field}");
            }
            let text = result["texts"]
                .as_array()
                .unwrap()
                .iter()
                .find(|t| t["sha256"] == file["sha256"])
                .unwrap();
            assert_eq!(text["text"], snapshot["text"]);
        }
        let known = result["files"]
            .as_array()
            .unwrap()
            .iter()
            .map(|f| f["sha256"].clone())
            .collect::<Vec<_>>();
        let repeat=service.replica_cut(Some(handle.clone()),json!({"incarnation":"test","selectors":[{"versionId":"main","paths":["docs"]}],"knownTextShas":known.iter().map(|v|v.as_str().unwrap()).collect::<String>()})).await.unwrap();
        assert_eq!(repeat["texts"], json!([]));
        service.workspace_close(Some(handle)).await.unwrap();
    }
}
