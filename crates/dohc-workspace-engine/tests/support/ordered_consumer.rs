use super::*;

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Config {
    root_dir: std::path::PathBuf,
    endpoint_path: std::path::PathBuf,
    auth_token: String,
    workspace_id: String,
    namespace: String,
    host: dohc_engine_collab::live_update_application::ApplicationHostCoordinate,
}

pub async fn run() {
    use dohc_engine_protocol::transport::RequestContext;
    use dohc_engine_protocol::wire::{Request, WorkspaceHandle};
    use dohc_engine_storage::{EngineStore, NoFaults};
    use dohc_workspace_engine::LiveApplicationHostConfig;
    let path = std::env::var_os("DOHC_ORDERED_CONSUMER_FIXTURE")
        .expect("explicit fixture config required");
    let config: Config = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    assert!(config.root_dir.is_absolute());
    assert!(config.endpoint_path.is_absolute());
    let database = config.root_dir.join(".dohc/engine/engine.db");
    if !database.exists() {
        std::fs::create_dir_all(database.parent().unwrap()).unwrap();
        let root_token =
            dohc_workspace_engine::root_binding::write_new_root_binding(&config.root_dir).unwrap();
        let mut store = EngineStore::open(&database, 0).unwrap();
        store.bind_root_token(&root_token, &NoFaults).unwrap();
        dohc_engine_domain::VersionedTextStore::new(&mut store)
            .ensure_main_version(&config.workspace_id, "main", 0, &NoFaults)
            .unwrap();
    }
    let service = Arc::new(EngineService::new());
    let response=service.call(RequestContext::unbounded(),Request {id:1,method:"workspace.open".into(),workspace:None,deadline_ms:None,idempotency_key:None,
        params:serde_json::json!({"rootDir":config.root_dir,"workspaceId":config.workspace_id,"captureMode":"none"})}).await.unwrap();
    let workspace = response.response.result["workspace"]
        .as_str()
        .unwrap()
        .to_owned();
    let owner = ConnectionOwner::authenticated();
    service
        .provision_live_application(
            owner.handle(),
            LiveApplicationHostConfig {
                workspace: WorkspaceHandle(workspace.clone()),
                namespace: config.namespace,
                coordinate: config.host,
                max_registrations: 16,
            },
        )
        .await
        .unwrap();
    let ingress =
        LiveApplicationIngress::new(service.clone(), live_test_support::config()).unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = serde_json::json!({"port":listener.local_addr().unwrap().port(),"workspace":workspace,"databasePath":database,"pid":std::process::id()});
    let temporary = config.endpoint_path.with_extension("tmp");
    std::fs::write(&temporary, serde_json::to_vec(&endpoint).unwrap()).unwrap();
    std::fs::rename(&temporary, &config.endpoint_path).unwrap();
    let (socket, _) = listener.accept().await.unwrap();
    drop(listener);
    let (input, output) = socket.into_split();
    let supervisor = Arc::new(Supervisor::new(
        SupervisorConfig::default(),
        service.clone(),
    ));
    let (_, events) = tokio::sync::mpsc::channel(1);
    let result = run_transport_with_live(
        config.auth_token,
        input,
        output,
        supervisor,
        events,
        || Ok(()),
        Some((owner, ingress)),
    )
    .await;
    service
        .call(
            RequestContext::unbounded(),
            Request {
                id: 2,
                method: "workspace.close".into(),
                workspace: Some(WorkspaceHandle(workspace)),
                deadline_ms: None,
                idempotency_key: None,
                params: serde_json::Value::Null,
            },
        )
        .await
        .unwrap();
    result.expect("fixture transport closes cleanly");
}
