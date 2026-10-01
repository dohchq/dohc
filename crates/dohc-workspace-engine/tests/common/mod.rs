//! Helpers every RPC test binary shares. Each binary compiles this module on
//! its own and uses a different subset, so unused items are expected.
#![allow(dead_code)]

use dohc_engine_protocol::{
    error::WireError,
    transport::{EngineTransport, InProcessTransport, RequestContext},
    wire::{Request, WorkspaceHandle},
};
use dohc_workspace_engine::EngineService;
use serde_json::{Value, json};
use std::path::Path;
use std::time::Duration;

pub const TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

pub const AUTHOR_CONTEXT_SECRET: &str =
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

pub fn authored_service() -> EngineService {
    let service = EngineService::new();
    service
        .provision_author_context_secret(AUTHOR_CONTEXT_SECRET.into())
        .unwrap();
    service
}

// Success-path fixtures declare their person through the private host seam.
// Spoofing tests call the transport directly and do not use this helper.
pub async fn trusted_fixture_params(
    transport: &InProcessTransport<EngineService>,
    handle: &WorkspaceHandle,
    mut params: Value,
) -> Value {
    if params.get("authorContext").is_some() {
        return params;
    }
    let person = params
        .get("author")
        .or_else(|| params.get("attribution"))
        .and_then(|author| author.get("onBehalfOf"))
        .and_then(Value::as_str)
        .filter(|person| {
            !person.is_empty()
                && person.len() <= dohc_engine_domain::MAX_AUTHOR_FIELD_BYTES
                && !person.chars().any(char::is_control)
        })
        .map(str::to_owned);
    if let Some(person) = person {
        let admitted = transport
            .call(
                RequestContext::unbounded(),
                request(
                    u64::MAX - 1,
                    "authorContext.admit",
                    Some(handle.clone()),
                    json!({"hostCredential":AUTHOR_CONTEXT_SECRET,"personId":person}),
                ),
            )
            .await
            .expect("trusted fixture admission");
        params["authorContext"] = admitted.result["authorContext"].clone();
    }
    params
}

pub fn request(
    id: u64,
    method: &str,
    workspace: Option<WorkspaceHandle>,
    params: Value,
) -> Request {
    Request {
        id,
        method: method.to_owned(),
        workspace,
        deadline_ms: None,
        idempotency_key: None,
        progress: false,
        params,
    }
}

pub async fn call(
    transport: &InProcessTransport<EngineService>,
    handle: &WorkspaceHandle,
    id: u64,
    method: &str,
    params: Value,
) -> Value {
    let params = trusted_fixture_params(transport, handle, params).await;
    transport
        .call(
            RequestContext::unbounded(),
            request(id, method, Some(handle.clone()), params),
        )
        .await
        .unwrap_or_else(|error| panic!("{method} request {id} failed: {error:?}"))
        .result
}

pub async fn call_error(
    transport: &InProcessTransport<EngineService>,
    handle: &WorkspaceHandle,
    id: u64,
    method: &str,
    params: Value,
) -> WireError {
    let params = trusted_fixture_params(transport, handle, params).await;
    transport
        .call(
            RequestContext::unbounded(),
            request(id, method, Some(handle.clone()), params),
        )
        .await
        .unwrap_err()
}

pub fn write_file(root: &Path, path: &str, bytes: &[u8]) {
    let absolute = root.join(path);
    if let Some(parent) = absolute.parent() {
        std::fs::create_dir_all(parent).expect("create parent");
    }
    std::fs::write(absolute, bytes).expect("write file");
}

/// Force a full capture scan, then flush until the driver reports the scan
/// settled. Request ids start high so they cannot collide with the test's.
pub async fn reconcile_until_settled(
    transport: &InProcessTransport<EngineService>,
    handle: &WorkspaceHandle,
    id_base: u64,
) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    let mut id = id_base.saturating_add(1_000_000);
    let mut settled = call(transport, handle, id, "capture.reconcile", json!({})).await["settled"]
        .as_bool()
        .expect("capture.reconcile settled flag");
    while !settled {
        assert!(
            tokio::time::Instant::now() < deadline,
            "forced capture scan never settled"
        );
        id += 1;
        settled = call(transport, handle, id, "capture.flush", json!({})).await["settled"]
            .as_bool()
            .expect("capture.flush settled flag");
    }
}
