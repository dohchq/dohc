//! Transport seams.
//!
//! The typed structs in [`crate::wire`] are the contract; serialization is a
//! property of one transport, not of the protocol. Two transports exist by
//! design:
//!
//! - **Framed IPC** (desktop sidecar): envelopes ride length-framed JSON
//!   control frames (see [`crate::frame`]). Built out in the supervisor/host
//!   shards.
//! - **In-process direct call** ([`InProcessTransport`]): an embedded engine
//!   (future mobile FFI / WASM host, and unit tests) invokes the service
//!   with the typed structs directly. No serde in the call path — a
//!   same-process caller never serializes to itself.

use crate::cancel::CancelSignal;
use crate::error::WireError;
use crate::wire::{Request, Response};
use std::future::Future;
use std::sync::Arc;
use std::time::Instant;

/// Raw blob bytes attached to a successful service response for framed
/// transports to emit as `BlobStart` + `BlobChunk` frames.
#[derive(Debug)]
pub struct BlobEgress {
    pub stream_id: u64,
    pub sha256: String,
    pub bytes: Vec<u8>,
    pub cancel: CancelSignal,
    pub deadline: Option<Instant>,
}

/// Transport-independent service output. In-process callers consume the
/// response directly; framed hosts additionally drain `blob_egress`.
#[derive(Debug)]
pub struct ServiceResponse {
    pub response: Response,
    pub blob_egress: Option<BlobEgress>,
}

impl ServiceResponse {
    pub fn response(response: Response) -> Self {
        ServiceResponse {
            response,
            blob_egress: None,
        }
    }
}

/// Per-request context handed to service implementations.
#[derive(Debug, Clone)]
pub struct RequestContext {
    /// Cooperative cancellation: long-running handlers must observe this
    /// between units of work and at await points.
    pub cancel: CancelSignal,
    /// Absolute deadline, when the request carries one. The supervisor also
    /// enforces it non-cooperatively.
    pub deadline: Option<Instant>,
}

impl RequestContext {
    pub fn unbounded() -> Self {
        RequestContext {
            cancel: CancelSignal::new(),
            deadline: None,
        }
    }
}

/// The engine's request-handling surface, transport-independent.
pub trait EngineService: Send + Sync {
    fn call(
        &self,
        ctx: RequestContext,
        request: Request,
    ) -> impl Future<Output = Result<ServiceResponse, WireError>> + Send;
}

/// A client-side transport: something a generated client can issue typed
/// requests through.
pub trait EngineTransport: Send + Sync {
    fn call(
        &self,
        ctx: RequestContext,
        request: Request,
    ) -> impl Future<Output = Result<Response, WireError>> + Send;
}

/// Direct-call transport for same-process hosts: forwards the typed structs
/// to the service without any encoding step.
#[derive(Debug)]
pub struct InProcessTransport<S> {
    service: Arc<S>,
}

impl<S: EngineService> InProcessTransport<S> {
    pub fn new(service: Arc<S>) -> Self {
        InProcessTransport { service }
    }
}

impl<S: EngineService> EngineTransport for InProcessTransport<S> {
    async fn call(&self, ctx: RequestContext, request: Request) -> Result<Response, WireError> {
        self.service
            .call(ctx, request)
            .await
            .map(|output| output.response)
    }
}
