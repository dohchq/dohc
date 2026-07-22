//! DOP1 stdio host for the shadow-only Rust workspace engine.

#![forbid(unsafe_code)]

use dohc_engine_protocol::{
    error::{ErrorCode, WireError},
    frame::{Frame, FrameDecoder},
    limits::WireLimits,
    supervisor::{Supervisor, SupervisorConfig},
    transport::EngineService as ProtocolEngineService,
    wire::{
        Envelope, ErrorEnvelope, Hello, HelloAck, PROTOCOL_VERSION, decode_control, encode_control,
    },
};
use dohc_engine_runtime::{RuntimeError, WorkspaceSupervisor};
use dohc_workspace_engine::EngineService;
use std::sync::atomic::{AtomicU64, Ordering};
use std::{
    collections::HashSet,
    error::Error,
    io,
    sync::{Arc, Mutex, MutexGuard},
};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::task::JoinSet;

const AUTH_TOKEN_ENV: &str = "DOHC_ENGINE_AUTH_TOKEN";
const OUTPUT_QUEUE_CAPACITY: usize = 64;
const READ_CHUNK_BYTES: usize = 64 * 1024;
static NEXT_SESSION_GENERATION: AtomicU64 = AtomicU64::new(1);

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    let auth_token = std::env::var(AUTH_TOKEN_ENV)
        .ok()
        .filter(|token| !token.is_empty())
        .ok_or_else(|| {
            io::Error::new(io::ErrorKind::PermissionDenied, "engine auth token missing")
        })?;
    run_stdio(auth_token).await
}

async fn run_stdio(auth_token: String) -> Result<(), Box<dyn Error>> {
    let service = Arc::new(EngineService::new());
    let supervisor = Arc::new(Supervisor::new(
        SupervisorConfig::default(),
        service.clone(),
    ));
    let transport = run_transport(
        auth_token,
        tokio::io::stdin(),
        tokio::io::stdout(),
        supervisor,
        || WorkspaceSupervisor::global().close_all(),
    )
    .await;
    // Store actors are closed by the hook above; any in-flight capture write
    // failed contained and stays un-acked (the next start re-offers it). This
    // drain joins the watcher/files threads so the process exits clean.
    service.shutdown_all_capture().await;
    transport?;
    Ok(())
}

async fn run_transport<R, W, S, C>(
    auth_token: String,
    mut input: R,
    output: W,
    supervisor: Arc<Supervisor<S>>,
    close_workspaces: C,
) -> Result<(), io::Error>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin + Send + 'static,
    S: ProtocolEngineService + 'static,
    C: FnOnce() -> Result<(), RuntimeError> + Send + 'static,
{
    let limits = WireLimits::default();
    let (output_tx, mut output_rx) = tokio::sync::mpsc::channel(OUTPUT_QUEUE_CAPACITY);
    let (writer_gone_tx, mut writer_gone_rx) = tokio::sync::watch::channel(false);
    let writer_limits = limits.clone();
    let writer_signal = writer_gone_tx.clone();
    let writer = tokio::spawn(async move {
        let result = write_output(output, &mut output_rx, &writer_limits).await;
        let _ = writer_signal.send(true);
        result
    });

    let mut decoder = FrameDecoder::new(limits);
    let mut read_buf = vec![0_u8; READ_CHUNK_BYTES];
    let mut authenticated = false;
    let mut keep_running = true;
    let mut read_error: Option<io::Error> = None;
    let active_requests = Arc::new(Mutex::new(HashSet::new()));
    let mut request_tasks = JoinSet::new();
    while keep_running {
        if *writer_gone_rx.borrow() {
            break;
        }
        // Reap completed forwarder tasks each iteration so the JoinSet cannot
        // retain one handle per request for the whole session (bounded memory
        // in a long-lived daemon). `try_join_next` is cheap and non-blocking.
        reap_completed(&mut request_tasks);
        let read = tokio::select! {
            changed = writer_gone_rx.changed() => {
                let _ = changed;
                break;
            }
            read = input.read(&mut read_buf) => read,
        };
        let read = match read {
            Ok(read) => read,
            Err(error) => {
                // A read error (e.g. ECONNRESET -- the NORMAL close for a
                // socket transport) must still fall through to the shared
                // cancel/drain/close tail below, never propagate straight out
                // and abort in-flight work + skip the workspace close.
                read_error = Some(error);
                break;
            }
        };
        if read == 0 {
            break;
        }
        decoder.push(&read_buf[..read]);
        loop {
            let frame = match decoder.next_frame() {
                Ok(Some(frame)) => frame,
                Ok(None) => break,
                Err(_) => {
                    if !send_error(
                        &output_tx,
                        None,
                        ErrorCode::MalformedFrame,
                        "malformed frame",
                    )
                    .await
                    {
                        let _ = writer_gone_tx.send(true);
                    }
                    keep_running = false;
                    break;
                }
            };
            let Frame::Control(payload) = frame else {
                if !send_error(
                    &output_tx,
                    None,
                    ErrorCode::InvalidEnvelope,
                    "blob streams are not supported by this method surface",
                )
                .await
                {
                    let _ = writer_gone_tx.send(true);
                }
                keep_running = false;
                break;
            };
            let envelope = match decode_control(&payload, &WireLimits::default()) {
                Ok(envelope) => envelope,
                Err(_) => {
                    if !send_error(
                        &output_tx,
                        None,
                        ErrorCode::InvalidEnvelope,
                        "invalid envelope",
                    )
                    .await
                    {
                        let _ = writer_gone_tx.send(true);
                    }
                    keep_running = false;
                    break;
                }
            };
            if !authenticated {
                match authenticate(envelope, &auth_token) {
                    Ok(ack) => {
                        authenticated = true;
                        if output_tx.send(Envelope::HelloAck(ack)).await.is_err() {
                            keep_running = false;
                        }
                    }
                    Err(error) => {
                        if output_tx
                            .send(Envelope::Error(ErrorEnvelope { id: None, error }))
                            .await
                            .is_err()
                        {
                            let _ = writer_gone_tx.send(true);
                        }
                        keep_running = false;
                    }
                }
                continue;
            }
            let envelopes = match envelope {
                Envelope::Batch(batch) => batch.envelopes,
                other => vec![other],
            };
            for envelope in envelopes {
                if !dispatch_authenticated(
                    envelope,
                    &supervisor,
                    &output_tx,
                    &writer_gone_tx,
                    &active_requests,
                    &mut request_tasks,
                )
                .await
                {
                    keep_running = false;
                    break;
                }
            }
        }
    }

    if *writer_gone_rx.borrow() {
        cancel_active_requests(&supervisor, &active_requests);
    }
    let close_result = drain_requests_then_close(&mut request_tasks, close_workspaces).await;
    drop(output_tx);
    drop(writer_gone_tx);
    let writer_result = writer
        .await
        .map_err(|_| io::Error::other("stdout writer task failed"))?;
    // Surface the guaranteed-run workspace close first (a resource/durability
    // failure), then the transport read error that triggered shutdown, then
    // any writer failure. All shutdown work above has already run regardless.
    close_result?;
    if let Some(error) = read_error {
        return Err(error);
    }
    writer_result
}

/// Non-blockingly drain every already-completed task from `tasks`. Called once
/// per read-loop iteration so a long-lived daemon does not accumulate a
/// finished-task handle per request until shutdown.
fn reap_completed(tasks: &mut JoinSet<()>) {
    while tasks.try_join_next().is_some() {}
}

async fn write_output<W: AsyncWrite + Unpin>(
    mut output: W,
    output_rx: &mut tokio::sync::mpsc::Receiver<Envelope>,
    limits: &WireLimits,
) -> Result<(), io::Error> {
    while let Some(envelope) = output_rx.recv().await {
        let bytes = encode_control(&envelope, limits)
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "response too large"))?;
        output.write_all(&bytes).await?;
        output.flush().await?;
    }
    Ok(())
}

fn authenticate(envelope: Envelope, auth_token: &str) -> Result<HelloAck, WireError> {
    let Envelope::Hello(Hello {
        protocol_version,
        auth_token: candidate,
        capabilities,
        ..
    }) = envelope
    else {
        return Err(WireError::new(
            ErrorCode::AuthFailed,
            "hello required before requests",
        ));
    };
    if candidate != auth_token {
        return Err(WireError::new(
            ErrorCode::AuthFailed,
            "authentication failed",
        ));
    }
    if protocol_version != PROTOCOL_VERSION {
        return Err(WireError::new(
            ErrorCode::ProtocolVersionUnsupported,
            "unsupported protocol version",
        ));
    }
    let negotiated = capabilities
        .into_iter()
        .filter(|capability| capability == "shadow-r13")
        .collect();
    Ok(HelloAck {
        protocol_version: PROTOCOL_VERSION,
        session_generation: NEXT_SESSION_GENERATION.fetch_add(1, Ordering::Relaxed),
        capabilities: negotiated,
        limits: WireLimits::default(),
    })
}

#[allow(clippy::too_many_arguments)]
async fn dispatch_authenticated<S: ProtocolEngineService + 'static>(
    envelope: Envelope,
    supervisor: &Arc<Supervisor<S>>,
    output: &tokio::sync::mpsc::Sender<Envelope>,
    writer_gone: &tokio::sync::watch::Sender<bool>,
    active_requests: &Arc<Mutex<HashSet<u64>>>,
    request_tasks: &mut JoinSet<()>,
) -> bool {
    if *writer_gone.borrow() {
        return false;
    }
    match envelope {
        Envelope::Request(request) => {
            let id = request.id;
            match supervisor.try_submit(request) {
                Ok(receiver) => {
                    let output = output.clone();
                    let writer_gone = writer_gone.clone();
                    let active_requests = Arc::clone(active_requests);
                    lock(&active_requests).insert(id);
                    request_tasks.spawn(async move {
                        let envelope = match receiver.await {
                            Ok(Ok(response)) => Envelope::Response(response),
                            Ok(Err(error)) => Envelope::Error(ErrorEnvelope {
                                id: Some(id),
                                error,
                            }),
                            Err(_) => Envelope::Error(ErrorEnvelope {
                                id: Some(id),
                                error: WireError::new(
                                    ErrorCode::Internal,
                                    "request supervisor unavailable",
                                ),
                            }),
                        };
                        if output.send(envelope).await.is_err() {
                            let _ = writer_gone.send(true);
                        }
                        lock(&active_requests).remove(&id);
                    });
                }
                Err(error) => {
                    if output
                        .send(Envelope::Error(ErrorEnvelope {
                            id: Some(id),
                            error,
                        }))
                        .await
                        .is_err()
                    {
                        let _ = writer_gone.send(true);
                        return false;
                    }
                }
            }
            true
        }
        Envelope::Cancel(cancel) => {
            let _ = supervisor.cancel(cancel.id);
            true
        }
        Envelope::Hello(_) | Envelope::HelloAck(_) | Envelope::Batch(_) => {
            if !send_error(
                output,
                None,
                ErrorCode::InvalidEnvelope,
                "envelope is invalid after handshake",
            )
            .await
            {
                let _ = writer_gone.send(true);
            }
            false
        }
        Envelope::BlobStart(_) => {
            if !send_error(
                output,
                None,
                ErrorCode::InvalidEnvelope,
                "blob streams are not supported by this method surface",
            )
            .await
            {
                let _ = writer_gone.send(true);
            }
            false
        }
        Envelope::Response(_) | Envelope::Error(_) | Envelope::Event(_) => {
            if !send_error(
                output,
                None,
                ErrorCode::InvalidEnvelope,
                "client sent a server-only envelope",
            )
            .await
            {
                let _ = writer_gone.send(true);
            }
            false
        }
    }
}

async fn send_error(
    output: &tokio::sync::mpsc::Sender<Envelope>,
    id: Option<u64>,
    code: ErrorCode,
    message: &'static str,
) -> bool {
    output
        .send(Envelope::Error(ErrorEnvelope {
            id,
            error: WireError::new(code, message),
        }))
        .await
        .is_ok()
}

fn cancel_active_requests<S: ProtocolEngineService + 'static>(
    supervisor: &Supervisor<S>,
    active_requests: &Mutex<HashSet<u64>>,
) {
    let ids: Vec<u64> = lock(active_requests).iter().copied().collect();
    for id in ids {
        let _ = supervisor.cancel(id);
    }
}

async fn drain_requests_then_close<C>(
    request_tasks: &mut JoinSet<()>,
    close_workspaces: C,
) -> Result<(), io::Error>
where
    C: FnOnce() -> Result<(), RuntimeError> + Send + 'static,
{
    // Join EVERY forwarder to completion. A JoinError on one must NOT
    // short-circuit and skip the guaranteed workspace close below, so record
    // the first one and keep draining.
    let mut forwarder_error: Option<io::Error> = None;
    while let Some(result) = request_tasks.join_next().await {
        if result.is_err() && forwarder_error.is_none() {
            forwarder_error = Some(io::Error::other("request forwarder task failed"));
        }
    }
    // Close workspaces UNCONDITIONALLY -- the drain-before-close guarantee
    // must hold even when a forwarder panicked.
    let close_result = tokio::task::spawn_blocking(close_workspaces)
        .await
        .map_err(|_| io::Error::other("workspace close task failed"))
        .and_then(|inner| inner.map_err(|_| io::Error::other("workspace close failed")));
    // A close failure (resource/durability) outranks a forwarder JoinError.
    match (close_result, forwarder_error) {
        (Err(close_error), _) => Err(close_error),
        (Ok(()), Some(forwarder_error)) => Err(forwarder_error),
        (Ok(()), None) => Ok(()),
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Regression coverage for the two deferred R13 daemon-liveness items (R14
/// hardening): halting admission when the response writer is broken (no
/// silent black hole), and draining in-flight work before the daemon closes
/// workspaces. Cancellable admission for `workspace.open` is covered in
/// `dohc_workspace_engine::tests` (the `open_lock` seam lives in `lib.rs`).
#[cfg(test)]
mod tests {
    use super::*;
    use dohc_engine_protocol::transport::RequestContext;
    use dohc_engine_protocol::wire::{Request as WireRequest, Response as WireResponse};
    use std::pin::Pin;
    use std::sync::atomic::{AtomicBool, AtomicUsize};
    use std::task::{Context as TaskContext, Poll};
    use std::time::Duration;
    use tokio::io::ReadBuf;
    use tokio::sync::Notify;

    const TEST_AUTH_TOKEN: &str = "r14-test-token";

    fn encode_envelope(envelope: &Envelope) -> Vec<u8> {
        // `encode_control` already returns a COMPLETE frame (header + JSON
        // payload) -- it calls `frame::encode_control_frame` internally. Do
        // not wrap it again here.
        encode_control(envelope, &WireLimits::default()).expect("envelope encodes")
    }

    fn hello_bytes() -> Vec<u8> {
        encode_envelope(&Envelope::Hello(Hello {
            protocol_version: PROTOCOL_VERSION,
            auth_token: TEST_AUTH_TOKEN.to_owned(),
            capabilities: Vec::new(),
            last_session_generation: None,
        }))
    }

    fn request_bytes(id: u64) -> Vec<u8> {
        encode_envelope(&Envelope::Request(WireRequest {
            id,
            method: "test.echo".to_owned(),
            workspace: None,
            deadline_ms: None,
            idempotency_key: None,
            params: serde_json::Value::Null,
        }))
    }

    /// A reader that yields one `hello` frame, then a single encoded request
    /// frame FOREVER. Stands in for a client that never stops sending: only
    /// the daemon halting admission (not reader EOF) can make a run against
    /// this source terminate.
    struct HelloThenEndlessRequests {
        hello: Vec<u8>,
        hello_pos: usize,
        request: Vec<u8>,
        request_pos: usize,
    }

    impl HelloThenEndlessRequests {
        fn new() -> Self {
            HelloThenEndlessRequests {
                hello: hello_bytes(),
                hello_pos: 0,
                request: request_bytes(1),
                request_pos: 0,
            }
        }
    }

    impl AsyncRead for HelloThenEndlessRequests {
        fn poll_read(
            self: Pin<&mut Self>,
            _cx: &mut TaskContext<'_>,
            buf: &mut ReadBuf<'_>,
        ) -> Poll<io::Result<()>> {
            let this = self.get_mut();
            if this.hello_pos < this.hello.len() {
                let take = (this.hello.len() - this.hello_pos).min(buf.remaining());
                buf.put_slice(&this.hello[this.hello_pos..this.hello_pos + take]);
                this.hello_pos += take;
                return Poll::Ready(Ok(()));
            }
            let remaining = buf.remaining();
            let mut written = 0;
            while written < remaining {
                let take = (this.request.len() - this.request_pos).min(remaining - written);
                buf.put_slice(&this.request[this.request_pos..this.request_pos + take]);
                this.request_pos = (this.request_pos + take) % this.request.len();
                written += take;
            }
            Poll::Ready(Ok(()))
        }
    }

    /// A finite reader: `hello` plus `n` request frames, then EOF (`Ok(0)`).
    struct HelloThenRequests {
        bytes: Vec<u8>,
        pos: usize,
    }

    impl HelloThenRequests {
        fn new(request_ids: &[u64]) -> Self {
            let mut bytes = hello_bytes();
            for id in request_ids {
                bytes.extend_from_slice(&request_bytes(*id));
            }
            HelloThenRequests { bytes, pos: 0 }
        }
    }

    impl AsyncRead for HelloThenRequests {
        fn poll_read(
            self: Pin<&mut Self>,
            _cx: &mut TaskContext<'_>,
            buf: &mut ReadBuf<'_>,
        ) -> Poll<io::Result<()>> {
            let this = self.get_mut();
            let take = (this.bytes.len() - this.pos).min(buf.remaining());
            buf.put_slice(&this.bytes[this.pos..this.pos + take]);
            this.pos += take;
            Poll::Ready(Ok(()))
        }
    }

    /// A reader that yields `hello` + `n` request frames on its first poll,
    /// then returns a read ERROR (simulating e.g. a socket ECONNRESET -- the
    /// normal close for a stream transport). Proves the error path still
    /// drains/closes.
    struct HelloThenRequestsThenError {
        bytes: Vec<u8>,
        pos: usize,
    }

    impl HelloThenRequestsThenError {
        fn new(request_ids: &[u64]) -> Self {
            let mut bytes = hello_bytes();
            for id in request_ids {
                bytes.extend_from_slice(&request_bytes(*id));
            }
            HelloThenRequestsThenError { bytes, pos: 0 }
        }
    }

    impl AsyncRead for HelloThenRequestsThenError {
        fn poll_read(
            self: Pin<&mut Self>,
            _cx: &mut TaskContext<'_>,
            buf: &mut ReadBuf<'_>,
        ) -> Poll<io::Result<()>> {
            let this = self.get_mut();
            if this.pos < this.bytes.len() {
                let take = (this.bytes.len() - this.pos).min(buf.remaining());
                buf.put_slice(&this.bytes[this.pos..this.pos + take]);
                this.pos += take;
                return Poll::Ready(Ok(()));
            }
            Poll::Ready(Err(io::Error::new(
                io::ErrorKind::ConnectionReset,
                "simulated connection reset",
            )))
        }
    }

    /// A writer that fails every write — simulates a broken stdout pipe.
    struct FailingWriter;

    impl AsyncWrite for FailingWriter {
        fn poll_write(
            self: Pin<&mut Self>,
            _cx: &mut TaskContext<'_>,
            _buf: &[u8],
        ) -> Poll<io::Result<usize>> {
            Poll::Ready(Err(io::Error::other("simulated broken pipe")))
        }

        fn poll_flush(self: Pin<&mut Self>, _cx: &mut TaskContext<'_>) -> Poll<io::Result<()>> {
            Poll::Ready(Ok(()))
        }

        fn poll_shutdown(self: Pin<&mut Self>, _cx: &mut TaskContext<'_>) -> Poll<io::Result<()>> {
            Poll::Ready(Ok(()))
        }
    }

    /// A well-behaved writer that discards its bytes but always succeeds —
    /// used where the test cares about ordering, not the transcript.
    struct SinkWriter;

    impl AsyncWrite for SinkWriter {
        fn poll_write(
            self: Pin<&mut Self>,
            _cx: &mut TaskContext<'_>,
            buf: &[u8],
        ) -> Poll<io::Result<usize>> {
            Poll::Ready(Ok(buf.len()))
        }

        fn poll_flush(self: Pin<&mut Self>, _cx: &mut TaskContext<'_>) -> Poll<io::Result<()>> {
            Poll::Ready(Ok(()))
        }

        fn poll_shutdown(self: Pin<&mut Self>, _cx: &mut TaskContext<'_>) -> Poll<io::Result<()>> {
            Poll::Ready(Ok(()))
        }
    }

    /// Counts every call it receives and answers instantly. Used to prove
    /// admission actually stops instead of running forever unobserved.
    struct CountingService {
        calls: Arc<AtomicUsize>,
    }

    impl ProtocolEngineService for CountingService {
        async fn call(
            &self,
            _ctx: RequestContext,
            request: WireRequest,
        ) -> Result<WireResponse, WireError> {
            self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Ok(WireResponse {
                id: request.id,
                result: serde_json::Value::Null,
            })
        }
    }

    /// Reports when its call starts, then blocks until released — lets a
    /// test hold a request "in flight" across the daemon's shutdown path.
    struct GatedService {
        started: Arc<Notify>,
        release: Arc<Notify>,
    }

    impl ProtocolEngineService for GatedService {
        async fn call(
            &self,
            _ctx: RequestContext,
            request: WireRequest,
        ) -> Result<WireResponse, WireError> {
            self.started.notify_one();
            self.release.notified().await;
            Ok(WireResponse {
                id: request.id,
                result: serde_json::Value::Null,
            })
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn writer_failure_halts_admission_instead_of_running_forever() {
        let calls = Arc::new(AtomicUsize::new(0));
        let service = Arc::new(CountingService {
            calls: Arc::clone(&calls),
        });
        let supervisor = Arc::new(Supervisor::new(SupervisorConfig::default(), service));

        // The input never ends on its own; only halted admission can make
        // this terminate. Without the fix, the daemon would read forever and
        // this `timeout` would fire.
        let outcome = tokio::time::timeout(
            Duration::from_secs(10),
            run_transport(
                TEST_AUTH_TOKEN.to_owned(),
                HelloThenEndlessRequests::new(),
                FailingWriter,
                supervisor,
                || Ok(()),
            ),
        )
        .await
        .expect("daemon halted instead of running forever against a broken writer");

        assert!(
            outcome.is_err(),
            "a permanently broken writer must surface as an error, not a silent success"
        );
        let observed = calls.load(std::sync::atomic::Ordering::SeqCst);
        assert!(
            observed < 10_000,
            "admission kept accepting requests after the writer broke: {observed} calls"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn shutdown_drains_in_flight_request_before_closing_workspaces() {
        let started = Arc::new(Notify::new());
        let release = Arc::new(Notify::new());
        let service = Arc::new(GatedService {
            started: Arc::clone(&started),
            release: Arc::clone(&release),
        });
        let supervisor = Arc::new(Supervisor::new(SupervisorConfig::default(), service));

        let closed = Arc::new(AtomicBool::new(false));
        let close_witness = Arc::clone(&closed);

        let run = tokio::spawn(run_transport(
            TEST_AUTH_TOKEN.to_owned(),
            HelloThenRequests::new(&[1]),
            SinkWriter,
            supervisor,
            move || {
                close_witness.store(true, std::sync::atomic::Ordering::SeqCst);
                Ok(())
            },
        ));

        // The request is now in flight (its handler is parked on `release`)
        // and the finite reader has already hit EOF, so the daemon is
        // already past `while keep_running` and into its shutdown path.
        // Closing workspaces must NOT have happened yet.
        tokio::time::timeout(Duration::from_secs(5), started.notified())
            .await
            .expect("request started");
        assert!(
            !closed.load(std::sync::atomic::Ordering::SeqCst),
            "workspaces were closed before the in-flight request drained"
        );

        release.notify_one();
        let result = tokio::time::timeout(Duration::from_secs(5), run)
            .await
            .expect("daemon shut down")
            .expect("run_transport task did not panic");
        assert!(result.is_ok(), "clean shutdown must not surface an error");
        assert!(
            closed.load(std::sync::atomic::Ordering::SeqCst),
            "workspaces must be closed once the in-flight request has drained"
        );
    }

    /// F2 regression: a read ERROR (not just EOF) must still fall through to
    /// the cancel/drain/close tail -- it must NOT propagate straight out,
    /// abandoning in-flight work and skipping the workspace close. Socket
    /// transports report ECONNRESET as their NORMAL close.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn read_error_still_drains_and_closes_workspaces() {
        let calls = Arc::new(AtomicUsize::new(0));
        let service = Arc::new(CountingService {
            calls: Arc::clone(&calls),
        });
        let supervisor = Arc::new(Supervisor::new(SupervisorConfig::default(), service));

        let closed = Arc::new(AtomicBool::new(false));
        let close_witness = Arc::clone(&closed);

        let outcome = tokio::time::timeout(
            Duration::from_secs(5),
            run_transport(
                TEST_AUTH_TOKEN.to_owned(),
                HelloThenRequestsThenError::new(&[1]),
                SinkWriter,
                supervisor,
                move || {
                    close_witness.store(true, std::sync::atomic::Ordering::SeqCst);
                    Ok(())
                },
            ),
        )
        .await
        .expect("daemon shut down after a read error");

        assert!(
            outcome.is_err(),
            "a read error must ultimately surface, after a clean shutdown"
        );
        assert!(
            closed.load(std::sync::atomic::Ordering::SeqCst),
            "workspaces must be closed even when shutdown was triggered by a read error"
        );
        assert_eq!(
            calls.load(std::sync::atomic::Ordering::SeqCst),
            1,
            "the in-flight request must have drained (been processed), not been abandoned"
        );
    }

    /// F3 regression: completed forwarder tasks are reaped from the JoinSet
    /// instead of accumulating a finished-handle per request. Proves
    /// `reap_completed` drops finished tasks while retaining pending ones (the
    /// bounded-memory invariant the read loop relies on each iteration).
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn reap_completed_drops_finished_tasks_and_retains_pending() {
        let mut tasks: JoinSet<()> = JoinSet::new();
        for _ in 0..8 {
            tasks.spawn(async {});
        }
        let gate = Arc::new(Notify::new());
        let pending_gate = Arc::clone(&gate);
        tasks.spawn(async move {
            pending_gate.notified().await;
        });

        // Let the eight instant tasks finish.
        for _ in 0..50 {
            if tasks.len() <= 1 {
                break;
            }
            reap_completed(&mut tasks);
            if tasks.len() <= 1 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        reap_completed(&mut tasks);

        assert_eq!(
            tasks.len(),
            1,
            "completed tasks must be reaped; only the still-pending task should remain"
        );
        gate.notify_one();
        let _ = tasks.join_next().await.expect("pending task completes");
        reap_completed(&mut tasks);
        assert_eq!(tasks.len(), 0, "the set is empty once all tasks are reaped");
    }
}
