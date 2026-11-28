use crate::EngineService;
use dohc_engine_protocol::{
    error::{ErrorCode, WireError},
    transport::RequestContext,
    wire::{Request, WorkspaceHandle},
};
use dohc_engine_testkit::ScratchDir;
use serde_json::{Value, json};

async fn convert(service: &EngineService, handle: &WorkspaceHandle) -> Result<Value, WireError> {
    service
        .dispatch(
            RequestContext::unbounded(),
            Request {
                id: 1,
                method: "sync.convertNotes".into(),
                workspace: Some(handle.clone()),
                deadline_ms: None,
                idempotency_key: None,
                params: json!({"budget": 10, "relayLive": []}),
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
async fn an_engine_that_writes_format_one_notes_reports_the_pass_off() {
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
