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
    ) -> impl Future<Output = Result<Response, WireError>> + Send;
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
    fn call(
        &self,
        ctx: RequestContext,
        request: Request,
    ) -> impl Future<Output = Result<Response, WireError>> + Send {
        self.service.call(ctx, request)
    }
}
