use crate::EngineService;
use dohc_engine_protocol::{
    error::{ErrorCode, WireError},
    transport::RequestContext,
    wire::{Request, WorkspaceHandle},
};
use dohc_engine_storage::{EngineStore, NoFaults, StorageError};
use dohc_engine_testkit::{ScratchDir, engine_db_path};
use serde_json::{Value, json};

async fn convert(service: &EngineService, handle: &WorkspaceHandle) -> Result<Value, WireError> {
    convert_with(service, handle, json!({"budget": 10, "relayLive": []})).await
}

async fn convert_with(
    service: &EngineService,
    handle: &WorkspaceHandle,
    params: Value,
) -> Result<Value, WireError> {
    service
        .dispatch(
            RequestContext::unbounded(),
            Request {
                id: 1,
                method: "sync.convertNotes".into(),
                workspace: Some(handle.clone()),
                deadline_ms: None,
                idempotency_key: None,
                params,
                progress: false,
            },
        )
        .await
        .map(|served| served.response.result)
}

async fn open(service: &EngineService, params: Value) -> WorkspaceHandle {
    let opened = service
        .workspace_open(&RequestContext::unbounded(), params)
        .await
        .unwrap();
    serde_json::from_value(opened["workspace"].clone()).unwrap()
}

#[tokio::test]
async fn only_the_owner_on_this_computer_can_convert_notes() {
    for received in [false, true] {
        let scratch = ScratchDir::new().unwrap();
        let service = EngineService::new();
        let params = json!({"rootDir":scratch.path(), "workspaceId":"convert-permission",
            "captureMode":"none", "projectCollections":received});
        let owner = open(&service, params.clone()).await;
        let handle = if received {
            owner.clone()
        } else {
            let mut read_only = params;
            read_only["skipStartupMaintenance"] = json!(true);
            open(&service, read_only).await
        };
        let refused = convert(&service, &handle).await.unwrap_err();
        let expected = if received {
            ErrorCode::Forbidden
        } else {
            ErrorCode::InvalidParams
        };
        assert_eq!(refused.code, expected, "{refused:?}");
        if !received {
            service.workspace_close(Some(handle)).await.unwrap();
        }
        service.workspace_close(Some(owner)).await.unwrap();
    }
}

#[tokio::test]
async fn an_engine_that_does_not_read_format_two_reports_the_pass_off() {
    let scratch = ScratchDir::new().unwrap();
    let service = EngineService::new();
    let owner = open(
        &service,
        json!({"rootDir":scratch.path(), "workspaceId":"convert-off", "captureMode":"none"}),
    )
    .await;
    let result = convert(&service, &owner).await.unwrap();
    assert_eq!(result["off"], json!(true), "{result}");
    assert_eq!(result["converted"], json!(0), "{result}");
    assert_eq!(result["resumeAfter"], Value::Null, "{result}");
    service.workspace_close(Some(owner)).await.unwrap();
}

#[tokio::test]
async fn a_replicating_workspace_refuses_a_pass_with_no_relay_check() {
    let scratch = ScratchDir::new().unwrap();
    let token = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    crate::root_binding::write_root_binding(scratch.path(), token).unwrap();
    let mut store = EngineStore::open(&engine_db_path(&scratch).unwrap(), 1).unwrap();
    store.bind_root_token(token, &NoFaults).unwrap();
    store
        .write_with(&NoFaults, |tx| {
            tx.execute_batch(
                "INSERT INTO sync_identity(workspace_id,origin_id,replication_epoch,stream_identity,created_at_ms) VALUES('w','origin','epoch','stream',1);
                 INSERT INTO sync_relay_push_state(workspace_id,origin_id,pushed_seq) VALUES('w','origin',0);",
            )
            .map_err(StorageError::persist_public)
        })
        .unwrap();
    drop(store);
    let service = EngineService::new();
    let owner = open(
        &service,
        json!({"rootDir":scratch.path(), "workspaceId":"w", "captureMode":"none"}),
    )
    .await;
    let refused = convert_with(&service, &owner, json!({"budget": 10}))
        .await
        .unwrap_err();
    assert_eq!(refused.code, ErrorCode::Conflict, "{refused:?}");
    assert_eq!(refused.message, "note-format-two-relay-unchecked");
    service.workspace_close(Some(owner)).await.unwrap();
}
