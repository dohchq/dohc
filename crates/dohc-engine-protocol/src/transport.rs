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
use crate::wire::{Request, RequestId, Response};
use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, Weak};
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
    /// Owned reservation for these hydrated bytes. Framed transports keep it
    /// alive until the egress item is written or dropped, bounding aggregate
    /// queued blob memory by bytes rather than output-message count.
    #[cfg(feature = "supervisor")]
    pub byte_permit: Option<tokio::sync::OwnedSemaphorePermit>,
}

/// Transport-independent service output. In-process callers consume the
/// response directly; framed hosts additionally drain `blob_egress`.
#[derive(Debug)]
pub struct ServiceResponse {
    pub response: Response,
    pub blob_egress: Option<BlobEgress>,
    /// Retains input reservations and fences an acknowledgement at the writer.
    pub output_guard: Option<Arc<dyn OutputGuard>>,
}

impl ServiceResponse {
    pub fn response(response: Response) -> Self {
        ServiceResponse {
            response,
            blob_egress: None,
            output_guard: None,
        }
    }
}

/// A service-owned response lifetime, checked immediately before output.
pub trait OutputGuard: std::fmt::Debug + Send + Sync {
    fn is_current(&self) -> bool;
    fn cancel_signal(&self) -> CancelSignal;
    fn retirement_signal(&self) -> CancelSignal {
        self.cancel_signal()
    }
    /// Serialize one nonblocking output poll with synchronous owner retirement.
    fn with_current(&self, action: &mut dyn FnMut()) -> bool {
        if !self.is_current() {
            return false;
        }
        action();
        true
    }
    fn deadline(&self) -> Option<Instant> {
        None
    }
}

/// Resources that must retire synchronously when their connection closes.
pub trait ConnectionResource: std::fmt::Debug + Send + Sync {
    fn retire(&self);
}

#[derive(Debug, Default)]
struct ConnectionState {
    retired: bool,
    cancel: CancelSignal,
    resources: Vec<Weak<dyn ConnectionResource>>,
}

/// Unforgeable identity captured from an authenticated transport, never JSON.
#[derive(Debug, Clone)]
pub struct ConnectionHandle(Arc<Mutex<ConnectionState>>);

impl ConnectionHandle {
    pub fn cancel_signal(&self) -> CancelSignal {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .cancel
            .clone()
    }
    pub fn is_current(&self) -> bool {
        !self.0.lock().unwrap_or_else(|e| e.into_inner()).retired
    }

    pub fn same_connection(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.0, &other.0)
    }

    pub fn retain(&self, resource: &Arc<dyn ConnectionResource>) -> bool {
        let mut state = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if state.retired {
            drop(state);
            resource.retire();
            return false;
        }
        state
            .resources
            .retain(|resource| resource.strong_count() > 0);
        state.resources.push(Arc::downgrade(resource));
        true
    }
}

/// The transport alone owns retirement. Dropping it retires captured resources.
#[derive(Debug)]
pub struct ConnectionOwner(ConnectionHandle);

impl ConnectionOwner {
    pub fn authenticated() -> Self {
        Self(ConnectionHandle(Arc::new(Mutex::new(
            ConnectionState::default(),
        ))))
    }

    pub fn handle(&self) -> ConnectionHandle {
        self.0.clone()
    }

    pub fn retire(&self) {
        let resources = {
            let mut state = self.0.0.lock().unwrap_or_else(|e| e.into_inner());
            state.retired = true;
            state.cancel.cancel();
            std::mem::take(&mut state.resources)
        };
        for resource in resources
            .into_iter()
            .filter_map(|resource| resource.upgrade())
        {
            resource.retire();
        }
    }
}

impl Drop for ConnectionOwner {
    fn drop(&mut self) {
        self.retire();
    }
}

/// Where a request reports that its work moved, so a caller can tell a slow
/// request from a stuck one. The framed host makes an active sink for a
/// request that set `progress` on a session that negotiated the `progress`
/// capability. Every other request gets the inactive default, and a report to
/// it does nothing.
///
/// An active sink keeps at most one message waiting to be written: a report
/// while one waits is folded into it. After [`ProgressSink::finish`], which
/// the host calls before it queues the terminal response, reports go nowhere,
/// so no progress follows the response.
#[derive(Clone, Default)]
pub struct ProgressSink(Option<Arc<ProgressState>>);

/// Hands one message to the output queue; `None` once the request finished.
type ProgressSend = Option<Box<dyn Fn(ProgressMessage) + Send>>;

struct ProgressState {
    id: RequestId,
    /// Cleared by `finish`, so a clone that gates costly counting on
    /// `is_active` stops paying once the request has answered.
    active: AtomicBool,
    waiting: AtomicBool,
    send: Mutex<ProgressSend>,
}

/// One progress message on its way to the writer. Dropping it, written or
/// not, lets the request report again.
pub struct ProgressMessage(Arc<ProgressState>);

impl ProgressMessage {
    pub fn id(&self) -> RequestId {
        self.0.id
    }
}

impl Drop for ProgressMessage {
    fn drop(&mut self) {
        self.0.waiting.store(false, Ordering::Release);
    }
}

impl std::fmt::Debug for ProgressMessage {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_tuple("ProgressMessage").field(&self.0.id).finish()
    }
}

impl ProgressSink {
    /// An active sink for request `id`. `send` hands each message to the
    /// output queue and must not block; a message it cannot queue it drops.
    pub fn new(id: RequestId, send: impl Fn(ProgressMessage) + Send + 'static) -> Self {
        ProgressSink(Some(Arc::new(ProgressState {
            id,
            active: AtomicBool::new(true),
            waiting: AtomicBool::new(false),
            send: Mutex::new(Some(Box::new(send))),
        })))
    }

    /// Whether a report can reach anyone: false for the inactive default and
    /// after [`ProgressSink::finish`]. Work that costs something only to
    /// report progress checks this first.
    pub fn is_active(&self) -> bool {
        self.0
            .as_ref()
            .is_some_and(|state| state.active.load(Ordering::Acquire))
    }

    pub fn report(&self) {
        let Some(state) = &self.0 else { return };
        if !state.active.load(Ordering::Acquire) || state.waiting.swap(true, Ordering::AcqRel) {
            return;
        }
        // A report that races `finish` finds no sender under the lock, so no
        // message can follow the response.
        if let Some(send) = state
            .send
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
        {
            send(ProgressMessage(Arc::clone(state)));
        }
    }

    /// End reporting for this request. Reports that already queued a message
    /// stay ahead of anything the caller queues after this returns.
    pub fn finish(&self) {
        if let Some(state) = &self.0 {
            state.active.store(false, Ordering::Release);
            state.send.lock().unwrap_or_else(|e| e.into_inner()).take();
        }
    }
}

impl std::fmt::Debug for ProgressSink {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match &self.0 {
            Some(state) => f.debug_tuple("ProgressSink").field(&state.id).finish(),
            None => f.write_str("ProgressSink(inactive)"),
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
    /// Capabilities negotiated by the framed session. Direct in-process calls
    /// default to none and may opt in explicitly.
    pub capabilities: Arc<[String]>,
    /// The largest control frame the session's client accepts, negotiated in
    /// `hello`. Direct in-process calls default to the engine default.
    pub max_frame_bytes: u32,
    pub connection: Option<ConnectionHandle>,
    /// Inactive unless the request asked for progress on a session that
    /// negotiated it.
    pub progress: ProgressSink,
}

impl RequestContext {
    pub fn unbounded() -> Self {
        RequestContext {
            cancel: CancelSignal::new(),
            deadline: None,
            capabilities: Arc::from([]),
            max_frame_bytes: crate::limits::WireLimits::SPIKE_DEFAULTS.max_frame_bytes,
            connection: None,
            progress: ProgressSink::default(),
        }
    }

    pub fn with_progress(mut self, progress: ProgressSink) -> Self {
        self.progress = progress;
        self
    }

    pub fn with_capability(mut self, capability: impl Into<String>) -> Self {
        let mut capabilities = self.capabilities.to_vec();
        capabilities.push(capability.into());
        self.capabilities = capabilities.into();
        self
    }

    pub fn with_max_frame_bytes(mut self, max_frame_bytes: u32) -> Self {
        self.max_frame_bytes = max_frame_bytes;
        self
    }

    pub fn has_capability(&self, capability: &str) -> bool {
        self.capabilities
            .iter()
            .any(|negotiated| negotiated == capability)
    }
}

/// The engine's request-handling surface, transport-independent.
pub trait EngineService: Send + Sync {
    /// A move-owned attachment defined by the service, outside control JSON.
    type Input: Send + 'static;

    fn call(
        &self,
        ctx: RequestContext,
        request: Request,
    ) -> impl Future<Output = Result<ServiceResponse, WireError>> + Send;

    fn call_with_input(
        &self,
        ctx: RequestContext,
        request: Request,
        input: Option<Self::Input>,
    ) -> impl Future<Output = Result<ServiceResponse, WireError>> + Send {
        async move {
            if input.is_some() {
                return Err(WireError::new(
                    crate::error::ErrorCode::InvalidParams,
                    "input attachment unsupported",
                ));
            }
            self.call(ctx, request).await
        }
    }
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

#[cfg(test)]
mod connection_tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};

    #[derive(Debug)]
    struct Resource(AtomicBool);
    impl ConnectionResource for Resource {
        fn retire(&self) {
            self.0.store(true, Ordering::SeqCst);
        }
    }

    #[test]
    fn connection_retirement_is_synchronous_and_identity_is_not_a_visible_name() {
        let owner = ConnectionOwner::authenticated();
        let captured = owner.handle();
        let replacement = ConnectionOwner::authenticated();
        let resource = Arc::new(Resource(AtomicBool::new(false)));
        assert!(captured.retain(&(resource.clone() as Arc<dyn ConnectionResource>)));
        assert!(!captured.same_connection(&replacement.handle()));
        drop(owner);
        assert!(!captured.is_current());
        assert!(resource.0.load(Ordering::SeqCst));
        assert!(captured.cancel_signal().is_cancelled());
        let late = Arc::new(Resource(AtomicBool::new(false)));
        assert!(!captured.retain(&(late.clone() as Arc<dyn ConnectionResource>)));
        assert!(late.0.load(Ordering::SeqCst));
        assert!(replacement.handle().is_current());
    }
}

#[cfg(test)]
mod progress_tests {
    use super::*;

    /// A sink whose messages land in a queue the test drains by hand.
    fn queued(id: RequestId) -> (ProgressSink, Arc<Mutex<Vec<ProgressMessage>>>) {
        let queue = Arc::new(Mutex::new(Vec::new()));
        let sent = Arc::clone(&queue);
        let sink = ProgressSink::new(id, move |message| sent.lock().unwrap().push(message));
        (sink, queue)
    }

    #[test]
    fn an_inactive_sink_reports_nothing() {
        let sink = ProgressSink::default();
        assert!(!sink.is_active());
        sink.report();
        sink.finish();
        assert!(!RequestContext::unbounded().progress.is_active());
    }

    #[test]
    fn at_most_one_message_waits_per_request() {
        let (sink, queue) = queued(7);
        sink.report();
        sink.clone().report();
        sink.report();
        assert_eq!(queue.lock().unwrap().len(), 1);
        assert_eq!(queue.lock().unwrap()[0].id(), 7);
        // The writer takes the message: the next report queues another.
        drop(queue.lock().unwrap().pop());
        sink.report();
        assert_eq!(queue.lock().unwrap().len(), 1);
    }

    #[test]
    fn a_message_the_queue_refused_lets_the_request_report_again() {
        let refused = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let count = Arc::clone(&refused);
        let sink = ProgressSink::new(1, move |message| {
            count.fetch_add(1, Ordering::SeqCst);
            drop(message);
        });
        sink.report();
        sink.report();
        assert_eq!(refused.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn nothing_is_sent_after_finish() {
        let (sink, queue) = queued(3);
        let clone = sink.clone();
        sink.report();
        assert!(clone.is_active());
        sink.finish();
        assert!(!clone.is_active(), "every clone sees the request finished");
        // A waiting message stays ahead of the response; it is not recalled.
        assert_eq!(queue.lock().unwrap().len(), 1);
        drop(queue.lock().unwrap().pop());
        sink.report();
        sink.clone().report();
        assert!(queue.lock().unwrap().is_empty());
    }
}
