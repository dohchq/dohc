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

/// Retry only a transaction's busy refusal; other errors retain their meaning.
/// Test hosts may be loaded, so allow a minute with the client's 100–1000 ms ladder.
pub async fn retry_engine_store_busy<T, F>(mut operation: impl FnMut() -> F) -> Result<T, WireError>
where
    F: std::future::Future<Output = Result<T, WireError>>,
{
    let deadline = tokio::time::Instant::now() + Duration::from_secs(60);
    let mut delay = Duration::from_millis(100);
    loop {
        match operation().await {
            Err(error)
                if error.code == dohc_engine_protocol::error::ErrorCode::Overloaded
                    && error.message == "engine-store-busy" =>
            {
                let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
                if remaining.is_zero() {
                    return Err(error);
                }
                tokio::time::sleep(delay.min(remaining)).await;
                if tokio::time::Instant::now() >= deadline {
                    return Err(error);
                }
                delay = (delay * 2).min(Duration::from_secs(1));
            }
            result => return result,
        }
    }
}

pub async fn call_with_busy_retry<S: dohc_engine_protocol::transport::EngineService>(
    transport: &InProcessTransport<S>,
    context: RequestContext,
    input: Request,
) -> Result<dohc_engine_protocol::wire::Response, WireError> {
    retry_engine_store_busy(|| transport.call(context.clone(), input.clone())).await
}

pub async fn service_call_with_busy_retry(
    service: &EngineService,
    context: RequestContext,
    input: Request,
) -> Result<dohc_engine_protocol::transport::ServiceResponse, WireError> {
    retry_engine_store_busy(|| {
        dohc_engine_protocol::transport::EngineService::call(
            service,
            context.clone(),
            input.clone(),
        )
    })
    .await
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

/// A request whose envelope carries the retry key `key`.
pub fn keyed_request(
    id: u64,
    method: &str,
    workspace: Option<WorkspaceHandle>,
    key: &str,
    params: Value,
) -> Request {
    Request {
        idempotency_key: Some(key.to_owned()),
        ..request(id, method, workspace, params)
    }
}

pub async fn call(
    transport: &InProcessTransport<EngineService>,
    handle: &WorkspaceHandle,
    id: u64,
    method: &str,
    params: Value,
) -> Value {
    call_with_busy_retry(
        transport,
        RequestContext::unbounded(),
        request(id, method, Some(handle.clone()), params),
    )
    .await
    .unwrap_or_else(|error| panic!("{method} request {id} failed: {error:?}"))
    .result
}

pub async fn call_keyed<S: dohc_engine_protocol::transport::EngineService>(
    transport: &InProcessTransport<S>,
    handle: &WorkspaceHandle,
    id: u64,
    method: &str,
    key: &str,
    params: Value,
) -> Value {
    call_with_busy_retry(
        transport,
        RequestContext::unbounded(),
        keyed_request(id, method, Some(handle.clone()), key, params),
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
    call_with_busy_retry(
        transport,
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

/// Wait on the durable placement outcome, independently of Undo's committed reply.
pub async fn wait_for_undo_placement(
    transport: &InProcessTransport<EngineService>,
    handle: &WorkspaceHandle,
    operation: &str,
    key: &str,
) -> Value {
    tokio::time::timeout(Duration::from_secs(600), async {
        loop {
            let result = call_keyed(
                transport,
                handle,
                900,
                "history.undo",
                key,
                json!({"operationId":operation}),
            )
            .await;
            if result["materialized"] == true {
                return result;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("Undo placement must finish")
}
