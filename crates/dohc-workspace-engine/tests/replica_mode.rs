mod common;

use common::service_call_with_busy_retry;
use dohc_engine_protocol::{
    error::ErrorCode,
    transport::{EngineService as _, RequestContext},
    wire::Request,
};
use dohc_engine_testkit::ScratchDir;
use dohc_workspace_engine::EngineService;
use serde_json::{Value, json};

fn request(method: &str, params: Value) -> Request {
    Request {
        id: 1,
        method: method.into(),
        workspace: None,
        deadline_ms: None,
        idempotency_key: None,
        progress: false,
        params,
    }
}

fn replica(root: &std::path::Path) -> EngineService {
    EngineService::replica(root).unwrap()
}

#[tokio::test]
async fn ordinary_open_refuses_socket_transport_and_requires_base_url() {
    for relay in [
        json!({"socketPath":"/private/relay.sock","bearerToken":"lease"}),
        json!({"baseUrl":"https://relay.test","socketPath":"/private/relay.sock","bearerToken":"lease"}),
        json!({"bearerToken":"owner"}),
    ] {
        let root = ScratchDir::new().unwrap();
        let result = service_call_with_busy_retry(&EngineService::new(),RequestContext::unbounded(), request("workspace.open",
            json!({"rootDir":root.path(),"workspaceId":"owner","captureMode":"none","relay":relay}))).await;
        assert_eq!(
            result.expect_err("ordinary transport must be refused").code,
            ErrorCode::InvalidParams
        );
        assert!(!root.path().join(".dohc").exists());
    }
}

#[tokio::test]
async fn replica_refuses_every_other_rpc_before_dispatch() {
    let root = ScratchDir::new().unwrap();
    let service = replica(root.path());
    let allowed = [
        "engine.ping",
        "workspace.open",
        "sync.adoptJoinIdentity",
        "sync.pull",
        "sync.commitCursor",
        "replica.frontiers",
        "replica.cut",
        "replica.applyJournalPage",
    ];
    let source = concat!(
        include_str!("../src/rpc/dispatch.rs"),
        include_str!("../src/live_application_ingress.rs"),
        include_str!("../src/live_application_ingress/restore.rs")
    );
    let methods: std::collections::BTreeSet<_> = source
        .split('"')
        .filter(|s| s.contains('.') && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '.'))
        .chain(["unknown.method", "sync.pullHosted", "workspace.close"])
        .collect();
    assert!(methods.len() > 200);
    for method in methods {
        if allowed.contains(&method) {
            continue;
        }
        let error = service
            .call(RequestContext::unbounded(), request(method, json!({})))
            .await
            .err()
            .unwrap_or_else(|| panic!("{method} unexpectedly succeeded"));
        assert_eq!(error.code, ErrorCode::Forbidden, "{method}: {error:?}");
        assert_eq!(error.message, "replica-method-refused", "{method}");
    }
}

#[tokio::test]
async fn replica_ping_reports_mode_and_unapplied_sandbox() {
    let root = ScratchDir::new().unwrap();
    let answer = replica(root.path())
        .call(
            RequestContext::unbounded(),
            request("engine.ping", json!({})),
        )
        .await
        .unwrap()
        .response
        .result;
    assert_eq!(
        answer,
        json!({"ok":true,"mode":"replica","landlockAbi":null})
    );
}

#[tokio::test]
async fn replica_open_refuses_foreign_roots_and_network_transports() {
    let root = ScratchDir::new().unwrap();
    let other = ScratchDir::new().unwrap();
    let service = replica(root.path());
    let valid = json!({"rootDir":root.path(),"workspaceId":"replica","captureMode":"none",
        "relay":{"socketPath":root.path().join("relay.sock"),"bearerToken":"lease"}});
    let mut cases = Vec::new();
    let mut p = valid.clone();
    p["rootDir"] = json!(other.path());
    cases.push(p);
    let mut p = valid.clone();
    p["relay"]["socketPath"] = json!(other.path().join("relay.sock"));
    cases.push(p);
    let mut p = valid.clone();
    p["relay"]["socketPath"] = json!(root.path().join("other.sock"));
    cases.push(p);
    let mut p = valid.clone();
    p["relay"] = json!({"baseUrl":"https://relay.test","bearerToken":"lease"});
    cases.push(p);
    let mut p = valid.clone();
    p["relay"]["baseUrl"] = json!("https://relay.test");
    cases.push(p);
    let mut p = valid;
    p.as_object_mut().unwrap().remove("relay");
    cases.push(p);
    for params in cases {
        let result = service_call_with_busy_retry(
            &service,
            RequestContext::unbounded(),
            request("workspace.open", params),
        )
        .await;
        let error = result.expect_err("open must refuse");
        assert_eq!(error.message, "replica-open-refused");
    }
    assert!(!root.path().join(".dohc").exists());
    assert!(!other.path().join(".dohc").exists());
}

#[tokio::test]
async fn replica_open_forces_passive_without_capture_or_dispatch_recovery() {
    let root = ScratchDir::new().unwrap();
    let service = replica(root.path());
    let answer = service_call_with_busy_retry(
        &service,
        RequestContext::unbounded(),
        request(
            "workspace.open",
            json!({
                "rootDir":root.path(),"workspaceId":"replica","recoverRunningDispatches":true,
                "relay":{"socketPath":root.path().join("relay.sock"),"bearerToken":"lease"}
            }),
        ),
    )
    .await
    .unwrap();
    let db = rusqlite::Connection::open(root.path().join(".dohc/engine/engine.db")).unwrap();
    let role: String = db
        .query_row("SELECT store_role FROM engine_ownership", [], |r| r.get(0))
        .unwrap();
    drop(db);
    dohc_engine_runtime::WorkspaceSupervisor::global()
        .close_all()
        .unwrap();
    assert_eq!(role, "passive");
    assert!(answer.response.result["workspace"].is_string());
    assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 1);
}

#[test]
fn replica_upload_ingress_refuses_non_replica_methods_before_parsing() {
    use dohc_engine_protocol::transport::ConnectionOwner;
    use dohc_workspace_engine::live_application_ingress::{
        LiveApplicationIngress, LiveApplicationIngressConfig,
    };
    let root = ScratchDir::new().unwrap();
    let mut ingress = LiveApplicationIngress::new(
        std::sync::Arc::new(replica(root.path())),
        LiveApplicationIngressConfig {
            aggregate_bytes: 2 * 1024 * 1024 * 1024,
            application_working_reserve_bytes: 32 * 1024 * 1024,
            max_uploads: 1,
            upload_deadline: std::time::Duration::from_secs(120),
        },
    )
    .unwrap();
    let connection = ConnectionOwner::authenticated();
    for method in [
        "liveApplication.apply",
        "liveApplication.prepareRestore",
        "liveApplication.applyRestore",
        "liveApplication.settleRestore",
        "liveApplication.resumeRestore",
        "ydoc.ownerDelivery.applyAcceptedFrame",
        "ydoc.ownerDelivery.applyInitialSync",
        "ydoc.ownerDelivery.enroll",
        "ydoc.ownerDelivery.appendDraft",
        "liveApplication.bootstrap",
        "liveApplication.adoptOwner",
        "liveApplication.syncOpen",
        "sync.push",
    ] {
        let error = ingress
            .begin(request(method, json!({})), &connection.handle())
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::Forbidden, "{method}");
        assert_eq!(error.message, "replica-method-refused");
    }
}
