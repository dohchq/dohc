//! The in-process direct-call transport: typed structs pass straight to the
//! service — no serde in the call path (portability guardrail 3).

use dohc_engine_protocol::error::WireError;
use dohc_engine_protocol::transport::{
    EngineService, EngineTransport, InProcessTransport, RequestContext,
};
use dohc_engine_protocol::wire::{Request, Response};
use serde_json::{Value, json};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

struct EchoService {
    calls: AtomicUsize,
}

impl EngineService for EchoService {
    async fn call(&self, _ctx: RequestContext, request: Request) -> Result<Response, WireError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Ok(Response {
            id: request.id,
            result: json!({ "echo": request.params, "method": request.method }),
        })
    }
}

#[tokio::test]
async fn direct_call_passes_typed_structs_through() {
    let service = Arc::new(EchoService {
        calls: AtomicUsize::new(0),
    });
    let transport = InProcessTransport::new(service.clone());
    let request = Request {
        id: 11,
        method: "workspace.status".to_string(),
        workspace: None,
        deadline_ms: None,
        idempotency_key: None,
        params: json!({ "verbose": true }),
    };
    let response = transport
        .call(RequestContext::unbounded(), request)
        .await
        .expect("echo succeeds");
    assert_eq!(response.id, 11);
    assert_eq!(response.result["echo"]["verbose"], Value::Bool(true));
    assert_eq!(service.calls.load(Ordering::SeqCst), 1);
}
