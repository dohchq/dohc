//! DOP1 stdio host for the workspace engine daemon.

#![forbid(unsafe_code)]

use dohc_engine_protocol::{
    cancel::CancelSignal,
    error::{ErrorCode, WireError},
    frame::{Frame, FrameDecoder, blob_chunks, encode_blob_chunk_frame},
    limits::WireLimits,
    supervisor::{Supervisor, SupervisorConfig},
    transport::{
        BlobEgress, ConnectionHandle, ConnectionOwner, EngineService as ProtocolEngineService,
        OutputGuard,
    },
    wire::{
        BlobStart, Envelope, ErrorEnvelope, Event, Hello, HelloAck, PROTOCOL_VERSION, Response,
        decode_control, encode_control,
    },
};
use dohc_engine_runtime::{RuntimeError, WorkspaceSupervisor};
use dohc_workspace_engine::live_application_ingress::LiveApplicationIngress;
use dohc_workspace_engine::{
    ConfiguredLiveHostConfig, EngineEventNotice, EngineService, LiveApplicationInput,
};
use std::sync::atomic::{AtomicU64, Ordering};
use std::{
    collections::{HashMap, HashSet},
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

#[cfg(test)]
#[path = "../../tests/support/live_application.rs"]
mod live_test_support;

#[cfg(test)]
#[path = "../../tests/support/ordered_consumer.rs"]
mod ordered_consumer_support;

enum OutputItem {
    Envelope(Envelope),
    Guarded {
        response: Response,
        guard: Arc<dyn OutputGuard>,
    },
    Blob {
        response: Response,
        egress: BlobEgress,
    },
}

impl From<Envelope> for OutputItem {
    fn from(envelope: Envelope) -> Self {
        OutputItem::Envelope(envelope)
    }
}

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
    let (service, live) = match std::env::var_os("DOHC_ENGINE_LIVE_HOST_CONFIG") {
        Some(path) => {
            let config = ConfiguredLiveHostConfig::read(std::path::Path::new(&path))?;
            let (service, owner, ingress) = EngineService::configured_live_host(config).await?;
            (service, Some((owner, ingress)))
        }
        None => match std::env::var_os("DOHC_ENGINE_OWNER_HOST_CONFIG") {
            Some(path) => {
                let config = dohc_workspace_engine::OrdinaryLiveHostConfig::read(std::path::Path::new(&path))?;
                let (service, owner, ingress) = EngineService::ordinary_live_host(config)?;
                (service, Some((owner, ingress)))
            }
            None => (Arc::new(EngineService::new()), None),
        },
    };
    let supervisor = Arc::new(Supervisor::new(
        SupervisorConfig::default(),
        service.clone(),
    ));
    let transport = run_transport_with_live(
        auth_token,
        tokio::io::stdin(),
        tokio::io::stdout(),
        supervisor,
        service.events().subscribe(),
        || WorkspaceSupervisor::global().close_all(),
        live,
    )
    .await;
    // Store actors are closed by the hook above; any in-flight capture write
    // failed contained and stays un-acked (the next start re-offers it). This
    // drain joins the watcher/files threads so the process exits clean.
    service.shutdown_all_capture().await;
    transport?;
    Ok(())
}

#[cfg(test)]
async fn run_transport<R, W, S, C>(
    auth_token: String,
    input: R,
    output: W,
    supervisor: Arc<Supervisor<S>>,
    events_rx: tokio::sync::mpsc::Receiver<EngineEventNotice>,
    close_workspaces: C,
) -> Result<(), io::Error>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin + Send + 'static,
    S: ProtocolEngineService<Input = LiveApplicationInput> + 'static,
    C: FnOnce() -> Result<(), RuntimeError> + Send + 'static,
{
    run_transport_with_live(
        auth_token,
        input,
        output,
        supervisor,
        events_rx,
        close_workspaces,
        None,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn run_transport_with_live<R, W, S, C>(
    auth_token: String,
    mut input: R,
    output: W,
    supervisor: Arc<Supervisor<S>>,
    mut events_rx: tokio::sync::mpsc::Receiver<EngineEventNotice>,
    close_workspaces: C,
    live: Option<(ConnectionOwner, LiveApplicationIngress)>,
) -> Result<(), io::Error>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin + Send + 'static,
    S: ProtocolEngineService<Input = LiveApplicationInput> + 'static,
    C: FnOnce() -> Result<(), RuntimeError> + Send + 'static,
{
    let (connection, mut ingress) = match live {
        Some((owner, ingress)) => (Arc::new(owner), Some(ingress)),
        None => (Arc::new(ConnectionOwner::authenticated()), None),
    };
    let limits = WireLimits::default();
    let (output_tx, mut output_rx) =
        tokio::sync::mpsc::channel::<OutputItem>(OUTPUT_QUEUE_CAPACITY);
    let active_egress = Arc::new(Mutex::new(HashMap::<u64, CancelSignal>::new()));
    let (writer_gone_tx, mut writer_gone_rx) = tokio::sync::watch::channel(false);
    let writer_limits = limits.clone();
    let writer_signal = writer_gone_tx.clone();
    let writer_active_egress = Arc::clone(&active_egress);
    let writer_connection = Arc::clone(&connection);
    let writer = tokio::spawn(async move {
        let result =
            write_output(output, &mut output_rx, &writer_limits, writer_active_egress).await;
        writer_connection.retire();
        let _ = writer_signal.send(true);
        result
    });

    // Service-initiated notices become wire Event envelopes, sequenced per
    // session. Generation 0 = pre-handshake: no authenticated consumer exists
    // yet (nor can any workspace be open), so such notices are dropped rather
    // than delivered ahead of the helloAck. The generation is stored only
    // after the ack is queued on output_tx, so an event can never overtake it.
    //
    // One seq counter for the whole session's Event stream. Safe today
    // because the daemon emits only capture.momentRecorded and no consumer
    // enforces contiguity over it — but ydocLiveAdapter.receiveEvent marks a
    // session stale on any gap between consecutive ydoc.remoteUpdate seqs,
    // and it filters by name first, so interleaved capture events would read
    // as gaps. When daemon-side ydoc.remoteUpdate emission lands, it needs
    // its own per-session sequencing (or the adapter's gap rule must learn
    // about the shared stream) before reusing this counter.
    let session_generation = Arc::new(AtomicU64::new(0));
    let events_output = output_tx.clone();
    let events_generation = Arc::clone(&session_generation);
    let event_forwarder = tokio::spawn(async move {
        let mut seq: u64 = 0;
        while let Some(notice) = events_rx.recv().await {
            let generation = events_generation.load(Ordering::SeqCst);
            if generation == 0 {
                continue;
            }
            seq += 1;
            let envelope = Envelope::Event(Event {
                seq,
                session_generation: generation,
                name: notice.name,
                payload: notice.payload,
            });
            if events_output.send(envelope.into()).await.is_err() {
                break;
            }
        }
    });

    let mut decoder = FrameDecoder::new(limits);
    let mut read_buf = vec![0_u8; READ_CHUNK_BYTES];
    let mut authenticated = false;
    let mut negotiated_capabilities = HashSet::new();
    let mut negotiated_max_frame_bytes = WireLimits::default().max_frame_bytes;
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
        let upload_deadline = ingress
            .as_ref()
            .and_then(LiveApplicationIngress::next_deadline);
        let read = tokio::select! {
            () = async {
                match upload_deadline {
                    Some(deadline) => tokio::time::sleep_until(deadline.into()).await,
                    None => std::future::pending().await,
                }
            } => {
                if let Some(ingress) = &mut ingress {
                    for id in ingress.expire() {
                        lock(&active_requests).remove(&id);
                        if !send_error(&output_tx, Some(id), ErrorCode::DeadlineExceeded, "live-upload-expired").await {
                            keep_running = false;
                        }
                    }
                }
                continue;
            }
            changed = writer_gone_rx.changed() => {
                let _ = changed;
                break;
            }
            read = input.read(&mut read_buf) => read,
        };
        let read = match read {
            Ok(read) => read,
            Err(error) => {
                // A read error (e.g. ECONNRESET -- the normal close for a
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
        'frames: loop {
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
            let payload = match frame {
                Frame::Control(payload) => payload,
                Frame::BlobChunk {
                    stream_id,
                    fin,
                    bytes,
                } if authenticated
                    && negotiated_capabilities.contains("blobs")
                    && ingress.is_some() =>
                {
                    match ingress
                        .as_mut()
                        .expect("configured ingress")
                        .chunk(stream_id, fin, &bytes)
                    {
                        Ok(Some((request, input))) => {
                            lock(&active_requests).remove(&request.id);
                            if !dispatch_authenticated(
                                Envelope::Request(request),
                                &supervisor,
                                &output_tx,
                                &writer_gone_tx,
                                &active_requests,
                                &active_egress,
                                &mut request_tasks,
                                true,
                                negotiated_max_frame_bytes,
                                Some(connection.handle()),
                                Some(input),
                            )
                            .await
                            {
                                keep_running = false;
                            }
                        }
                        Ok(None) => {}
                        Err(error) => {
                            let _ = output_tx
                                .send(Envelope::Error(ErrorEnvelope { id: None, error }).into())
                                .await;
                            keep_running = false;
                        }
                    }
                    if !keep_running {
                        break;
                    }
                    continue;
                }
                Frame::BlobChunk { .. } => {
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
                }
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
                        negotiated_capabilities.extend(ack.capabilities.iter().cloned());
                        negotiated_max_frame_bytes = ack.limits.max_frame_bytes;
                        let generation = ack.session_generation;
                        if output_tx
                            .send(Envelope::HelloAck(ack).into())
                            .await
                            .is_err()
                        {
                            keep_running = false;
                        } else {
                            // Events unlock only once the ack is ordered on
                            // the output queue, so none can precede it.
                            session_generation.store(generation, Ordering::SeqCst);
                        }
                    }
                    Err(error) => {
                        if output_tx
                            .send(Envelope::Error(ErrorEnvelope { id: None, error }).into())
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
                if let Some(ingress) = &mut ingress {
                    match &envelope {
                        Envelope::Request(request)
                            if matches!(
                                request.method.as_str(),
                                "liveApplication.apply" | "liveApplication.bootstrap" | "liveApplication.adoptOwner"
                            ) =>
                        {
                            let id = request.id;
                            let result = if !negotiated_capabilities.contains("blobs")
                                || lock(&active_requests).contains(&id)
                                || lock(&active_egress).contains_key(&id)
                            {
                                Err(WireError::new(
                                    ErrorCode::InvalidParams,
                                    "invalid-live-upload-request",
                                ))
                            } else {
                                ingress.begin(request.clone(), &connection.handle())
                            };
                            match result {
                                Ok(()) => {
                                    lock(&active_requests).insert(id);
                                }
                                Err(error) => {
                                    if output_tx
                                        .send(
                                            Envelope::Error(ErrorEnvelope {
                                                id: Some(id),
                                                error,
                                            })
                                            .into(),
                                        )
                                        .await
                                        .is_err()
                                    {
                                        keep_running = false;
                                    }
                                }
                            }
                            continue;
                        }
                        Envelope::BlobStart(start) => {
                            if let Err(error) = ingress.start(start.clone()) {
                                let _ = output_tx
                                    .send(
                                        Envelope::Error(ErrorEnvelope {
                                            id: Some(start.request_id),
                                            error,
                                        })
                                        .into(),
                                    )
                                    .await;
                                keep_running = false;
                                break 'frames;
                            }
                            continue;
                        }
                        Envelope::Cancel(cancel) if ingress.cancel(cancel.id) => {
                            lock(&active_requests).remove(&cancel.id);
                        }
                        _ => {}
                    }
                }
                if !dispatch_authenticated(
                    envelope,
                    &supervisor,
                    &output_tx,
                    &writer_gone_tx,
                    &active_requests,
                    &active_egress,
                    &mut request_tasks,
                    negotiated_capabilities.contains("blobs"),
                    negotiated_max_frame_bytes,
                    Some(connection.handle()),
                    None,
                )
                .await
                {
                    keep_running = false;
                    break 'frames;
                }
            }
        }
    }

    connection.retire();
    if let Some(ingress) = &mut ingress {
        ingress.clear();
    }
    if *writer_gone_rx.borrow() {
        cancel_active_requests(&supervisor, &active_requests);
    }
    let close_result = drain_requests_then_close(&mut request_tasks, close_workspaces).await;
    // The forwarder holds an output_tx clone; end it before dropping ours or
    // the writer's channel never closes and the join below hangs forever.
    event_forwarder.abort();
    let _ = event_forwarder.await;
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
    output_rx: &mut tokio::sync::mpsc::Receiver<OutputItem>,
    limits: &WireLimits,
    active_egress: Arc<Mutex<HashMap<u64, CancelSignal>>>,
) -> Result<(), io::Error> {
    'items: while let Some(item) = output_rx.recv().await {
        match item {
            OutputItem::Guarded { response, guard } => {
                let request_id = response.id;
                let frame = encode_control(&Envelope::Response(response), limits)
                    .map_err(|error| io::Error::other(format!("response encode: {error:?}")))?;
                let cancel = guard.cancel_signal();
                let retired = guard.retirement_signal();
                let deadline = guard.deadline();
                let mut offset = 0;
                while offset < frame.len() {
                    let write = std::future::poll_fn(|cx| {
                        let mut result = std::task::Poll::Pending;
                        if !guard.with_current(&mut || {
                            result = std::pin::Pin::new(&mut output)
                                .poll_write(cx, &frame[offset..])
                                .map(|result| result.map(Some));
                        }) {
                            return std::task::Poll::Ready(Ok(None));
                        }
                        result
                    });
                    let mut interruption_kind = io::ErrorKind::ConnectionAborted;
                    let count = tokio::select! {
                        biased;
                        () = cancel.cancelled() => None,
                        () = retired.cancelled() => None,
                        () = async {
                            match deadline {
                                Some(deadline) => tokio::time::sleep_until(deadline.into()).await,
                                None => std::future::pending().await,
                            }
                        } => { interruption_kind = io::ErrorKind::TimedOut; None },
                        count = write => count?,
                    };
                    let Some(count) = count else {
                        if offset == 0 {
                            lock(&active_egress).remove(&request_id);
                            continue 'items;
                        }
                        if deadline.is_some_and(|deadline| std::time::Instant::now() >= deadline) {
                            interruption_kind = io::ErrorKind::TimedOut;
                        }
                        return Err(io::Error::new(
                            interruption_kind,
                            if interruption_kind == io::ErrorKind::TimedOut {
                                "live acknowledgement expired"
                            } else {
                                "live acknowledgement retired"
                            },
                        ));
                    };
                    if count == 0 {
                        return Err(io::Error::new(io::ErrorKind::WriteZero, "stdout closed"));
                    }
                    offset += count;
                }
                let flush = std::future::poll_fn(|cx| {
                    let mut result = std::task::Poll::Pending;
                    if !guard.with_current(&mut || {
                        result = std::pin::Pin::new(&mut output).poll_flush(cx);
                    }) {
                        let expired =
                            deadline.is_some_and(|deadline| std::time::Instant::now() >= deadline);
                        return std::task::Poll::Ready(Err(io::Error::new(
                            if expired {
                                io::ErrorKind::TimedOut
                            } else {
                                io::ErrorKind::ConnectionAborted
                            },
                            if expired {
                                "live acknowledgement expired"
                            } else {
                                "live acknowledgement retired"
                            },
                        )));
                    }
                    result
                });
                tokio::select! {
                    biased;
                    () = cancel.cancelled() => return Err(io::Error::new(io::ErrorKind::ConnectionAborted, "live acknowledgement retired")),
                    () = retired.cancelled() => return Err(io::Error::new(io::ErrorKind::ConnectionAborted, "live acknowledgement retired")),
                    () = async {
                        match deadline {
                            Some(deadline) => tokio::time::sleep_until(deadline.into()).await,
                            None => std::future::pending().await,
                        }
                    } => return Err(io::Error::new(io::ErrorKind::TimedOut, "live acknowledgement expired")),
                    result = flush => result?,
                }
                lock(&active_egress).remove(&request_id);
            }
            OutputItem::Envelope(envelope) => {
                // A service-initiated event the wire cannot carry is dropped
                // here, with its name on stderr, instead of ending the
                // transport: delivery is at most once and the subscriber
                // reconciles from history. A response is different: its
                // caller is waiting, so an unencodable one still fails loud.
                let bytes = match (encode_control(&envelope, limits), &envelope) {
                    (Ok(bytes), _) => bytes,
                    (Err(error), Envelope::Event(event)) => {
                        eprintln!(
                            "engine: dropped event {} it cannot encode: {error:?}",
                            event.name
                        );
                        continue;
                    }
                    (Err(_), _) => {
                        return Err(io::Error::new(
                            io::ErrorKind::InvalidData,
                            "response too large",
                        ));
                    }
                };
                output.write_all(&bytes).await?;
                output.flush().await?;
            }
            OutputItem::Blob { response, egress } => {
                let request_id = response.id;
                let outcome = write_blob_egress(&mut output, response, egress, limits).await;
                lock(&active_egress).remove(&request_id);
                outcome?;
            }
        }
    }
    Ok(())
}

async fn write_envelope<W: AsyncWrite + Unpin>(
    output: &mut W,
    envelope: &Envelope,
    limits: &WireLimits,
) -> Result<(), io::Error> {
    let bytes = encode_control(envelope, limits)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "response too large"))?;
    output.write_all(&bytes).await?;
    output.flush().await
}

async fn write_blob_egress<W: AsyncWrite + Unpin>(
    output: &mut W,
    response: Response,
    egress: BlobEgress,
    limits: &WireLimits,
) -> Result<(), io::Error> {
    let interruption = |deadline: Option<std::time::Instant>| {
        if deadline.is_some_and(|deadline| std::time::Instant::now() >= deadline) {
            WireError::new(
                ErrorCode::DeadlineExceeded,
                "versionedBinary.readBlob egress deadline elapsed",
            )
        } else {
            WireError::new(
                ErrorCode::Cancelled,
                "versionedBinary.readBlob egress cancelled",
            )
        }
    };
    if egress.cancel.is_cancelled()
        || egress
            .deadline
            .is_some_and(|deadline| std::time::Instant::now() >= deadline)
    {
        return write_envelope(
            output,
            &Envelope::Error(ErrorEnvelope {
                id: Some(response.id),
                error: interruption(egress.deadline),
            }),
            limits,
        )
        .await;
    }
    write_envelope(
        output,
        &Envelope::BlobStart(BlobStart {
            request_id: response.id,
            stream_id: egress.stream_id,
            total_bytes: Some(egress.bytes.len() as u64),
            sha256: Some(egress.sha256),
        }),
        limits,
    )
    .await?;

    let chunk_bytes = limits.max_blob_chunk_bytes as usize;
    for (fin, chunk) in blob_chunks(&egress.bytes, chunk_bytes) {
        if egress.cancel.is_cancelled()
            || egress
                .deadline
                .is_some_and(|deadline| std::time::Instant::now() >= deadline)
        {
            return write_envelope(
                output,
                &Envelope::Error(ErrorEnvelope {
                    id: Some(response.id),
                    error: interruption(egress.deadline),
                }),
                limits,
            )
            .await;
        }
        let frame = encode_blob_chunk_frame(egress.stream_id, fin, chunk, limits)
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "blob chunk too large"))?;
        output.write_all(&frame).await?;
        output.flush().await?;
    }
    write_envelope(output, &Envelope::Response(response), limits).await
}

fn authenticate(envelope: Envelope, auth_token: &str) -> Result<HelloAck, WireError> {
    let Envelope::Hello(Hello {
        protocol_version,
        auth_token: candidate,
        capabilities,
        max_frame_bytes,
        ..
    }) = envelope
    else {
        return Err(WireError::new(
            ErrorCode::AuthFailed,
            "hello required before requests",
        ));
    };
    if !constant_time_eq(candidate.as_bytes(), auth_token.as_bytes()) {
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
        .filter(|capability| capability == "blobs")
        .collect();
    // A client may lower its receive limit; the engine clamps the request
    // into the negotiable range and echoes the effective value, which sizes
    // this connection's in-band responses.
    let default_limits = WireLimits::default();
    let effective_max_frame_bytes =
        max_frame_bytes.map_or(default_limits.max_frame_bytes, |requested| {
            requested.clamp(
                dohc_engine_protocol::limits::MIN_NEGOTIABLE_FRAME_BYTES,
                default_limits.max_frame_bytes,
            )
        });
    Ok(HelloAck {
        protocol_version: PROTOCOL_VERSION,
        session_generation: NEXT_SESSION_GENERATION.fetch_add(1, Ordering::Relaxed),
        capabilities: negotiated,
        limits: WireLimits {
            max_frame_bytes: effective_max_frame_bytes,
            ..default_limits
        },
    })
}

#[allow(clippy::too_many_arguments)]
async fn dispatch_authenticated<
    S: ProtocolEngineService<Input = LiveApplicationInput> + 'static,
>(
    envelope: Envelope,
    supervisor: &Arc<Supervisor<S>>,
    output: &tokio::sync::mpsc::Sender<OutputItem>,
    writer_gone: &tokio::sync::watch::Sender<bool>,
    active_requests: &Arc<Mutex<HashSet<u64>>>,
    active_egress: &Arc<Mutex<HashMap<u64, CancelSignal>>>,
    request_tasks: &mut JoinSet<()>,
    blobs_negotiated: bool,
    max_frame_bytes: u32,
    connection: Option<ConnectionHandle>,
    input: Option<LiveApplicationInput>,
) -> bool {
    if *writer_gone.borrow() {
        return false;
    }
    match envelope {
        Envelope::Request(request) => {
            let id = request.id;
            if lock(active_requests).contains(&id) || lock(active_egress).contains_key(&id) {
                return send_error(
                    output,
                    Some(id),
                    ErrorCode::InvalidParams,
                    "duplicate-request-id",
                )
                .await;
            }
            let capabilities: Arc<[String]> = if blobs_negotiated {
                Arc::from(["blobs".to_owned()])
            } else {
                Arc::from([])
            };
            let completion_egress = Arc::clone(active_egress);
            match supervisor.try_submit_input(
                request,
                capabilities,
                max_frame_bytes,
                connection,
                input,
                move |outcome| {
                    if let Ok(service_response) = outcome
                        && let Some(guard) = &service_response.output_guard
                    {
                        debug_assert!(service_response.blob_egress.is_none());
                        lock(&completion_egress).insert(id, guard.cancel_signal());
                    }
                    // The handoff runs before the supervisor drops its cancel
                    // registration. Cancel therefore always reaches either the
                    // request signal, this egress signal, or both.
                    if blobs_negotiated
                        && let Ok(service_response) = outcome
                        && let Some(egress) = &service_response.blob_egress
                    {
                        lock(&completion_egress).insert(id, egress.cancel.clone());
                    }
                },
            ) {
                Ok(receiver) => {
                    let output = output.clone();
                    let writer_gone = writer_gone.clone();
                    let active_requests = Arc::clone(active_requests);
                    let active_egress = Arc::clone(active_egress);
                    lock(&active_requests).insert(id);
                    request_tasks.spawn(async move {
                        let item = match receiver.await {
                            Ok(Ok(mut service_response)) => {
                                if let Some(guard) = service_response.output_guard.take() {
                                    OutputItem::Guarded {
                                        response: service_response.response,
                                        guard,
                                    }
                                } else {
                                    match service_response.blob_egress.take() {
                                        Some(egress) => {
                                            if blobs_negotiated {
                                                OutputItem::Blob {
                                                    response: service_response.response,
                                                    egress,
                                                }
                                            } else {
                                                // An attached blob is part of this
                                                // successful result. Never turn it
                                                // into a metadata-only success for
                                                // a client that cannot receive it.
                                                OutputItem::Envelope(Envelope::Error(
                                                    ErrorEnvelope {
                                                        id: Some(service_response.response.id),
                                                        error: WireError::new(
                                                            ErrorCode::InvalidParams,
                                                            "blob-capability-required",
                                                        ),
                                                    },
                                                ))
                                            }
                                        }
                                        None => OutputItem::Envelope(Envelope::Response(
                                            service_response.response,
                                        )),
                                    }
                                }
                            }
                            Ok(Err(error)) => {
                                OutputItem::Envelope(Envelope::Error(ErrorEnvelope {
                                    id: Some(id),
                                    error,
                                }))
                            }
                            Err(_) => OutputItem::Envelope(Envelope::Error(ErrorEnvelope {
                                id: Some(id),
                                error: WireError::new(
                                    ErrorCode::Internal,
                                    "request supervisor unavailable",
                                ),
                            })),
                        };
                        if output.send(item).await.is_err() {
                            lock(&active_egress).remove(&id);
                            let _ = writer_gone.send(true);
                        }
                        lock(&active_requests).remove(&id);
                    });
                }
                Err(error) => {
                    if output
                        .send(
                            Envelope::Error(ErrorEnvelope {
                                id: Some(id),
                                error,
                            })
                            .into(),
                        )
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
            if let Some(signal) = lock(active_egress).get(&cancel.id) {
                signal.cancel();
            }
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
                ErrorCode::InvalidParams,
                "blob-ingest-unsupported",
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
    output: &tokio::sync::mpsc::Sender<OutputItem>,
    id: Option<u64>,
    code: ErrorCode,
    message: &'static str,
) -> bool {
    output
        .send(
            Envelope::Error(ErrorEnvelope {
                id,
                error: WireError::new(code, message),
            })
            .into(),
        )
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
    // Join every forwarder to completion. A JoinError on one must not
    // short-circuit and skip the guaranteed workspace close below, so record
    // the first one and keep draining.
    let mut forwarder_error: Option<io::Error> = None;
    while let Some(result) = request_tasks.join_next().await {
        if result.is_err() && forwarder_error.is_none() {
            forwarder_error = Some(io::Error::other("request forwarder task failed"));
        }
    }
    // Close workspaces unconditionally -- the drain-before-close guarantee
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

/// Compare the presented token against the expected one without leaking how far
/// they matched. A plain `==` returns as soon as two bytes differ, so a caller
/// able to retry can recover the token a byte at a time from the timing.
///
/// Length is not hidden and does not need to be: the token is a fixed-width
/// value chosen by the parent process, not a secret whose size carries meaning.
fn constant_time_eq(candidate: &[u8], expected: &[u8]) -> bool {
    use subtle::ConstantTimeEq;
    candidate.ct_eq(expected).into()
}

/// Regression coverage for the two deferred R13 daemon-liveness items (R14
/// hardening): halting admission when the response writer is broken (no
/// silent black hole), and draining in-flight work before the daemon closes
/// workspaces. Cancellable admission for `workspace.open` is covered in
/// `dohc_workspace_engine::tests` (the `open_lock` seam lives in `lib.rs`).
#[cfg(test)]
mod tests {
    use super::*;
    use dohc_engine_protocol::transport::{RequestContext, ServiceResponse};
    use dohc_engine_protocol::wire::{BlobStart, Request as WireRequest, Response as WireResponse};
    use std::pin::Pin;
    use std::sync::atomic::{AtomicBool, AtomicUsize};
    use std::task::{Context as TaskContext, Poll};
    use std::time::Duration;
    use tokio::io::ReadBuf;
    use tokio::sync::Notify;

    const TEST_AUTH_TOKEN: &str = "r14-test-token";

    #[tokio::test]
    #[ignore = "requires an owned external consumer fixture"]
    async fn ordered_consumer_fixture() {
        ordered_consumer_support::run().await;
    }

    #[tokio::test]
    async fn live_transport_applies_client_frames_before_ack_and_recovers_the_record() {
        use dohc_engine_collab::Ydoc;
        use dohc_engine_storage::hex_sha256;
        let (scratch, service, owner, workspace, registration, binding) =
            live_test_support::fixture().await;
        let fixture = std::env::var_os("DOHC_LIVE_APPLICATION_CLIENT_FIXTURE");
        let (frames, expected_digest, expected_bytes, expected_ranges, auth) =
            if let Some(path) = fixture {
                let frames = std::fs::read(path).unwrap();
                let mut decoder = FrameDecoder::new(WireLimits::default());
                decoder.push(&frames);
                let mut expected = None;
                while let Some(frame) = decoder.next_frame().unwrap() {
                    if let Frame::Control(payload) = frame
                        && let Envelope::Request(request) =
                            decode_control(&payload, &WireLimits::default()).unwrap()
                    {
                        assert_eq!(request.workspace.as_ref().unwrap().0, workspace);
                        assert_eq!(request.params["registrationId"], registration);
                        assert_eq!(
                            request.params["accepted"]["binding"],
                            serde_json::to_value(&binding).unwrap()
                        );
                        assert_eq!(request.params["updateByteLength"], 20 * 1024 * 1024);
                        assert_eq!(request.params["rangeCount"], 16_385);
                        expected = Some(
                            request.params["accepted"]["receipt"]["updateDigest"]
                                .as_str()
                                .unwrap()
                                .to_owned(),
                        );
                    }
                }
                (
                    frames,
                    expected.unwrap(),
                    20 * 1024 * 1024,
                    16_385,
                    "parent-secret",
                )
            } else {
                let bytes = Ydoc::wire().plaintext_insert(0, "real framed update");
                let request =
                    live_test_support::request(&workspace, registration, &binding, &bytes, &[]);
                let mut frames = encode_envelope(&Envelope::Hello(Hello {
                    protocol_version: PROTOCOL_VERSION,
                    auth_token: TEST_AUTH_TOKEN.into(),
                    capabilities: vec!["blobs".into()],
                    last_session_generation: None,
                    max_frame_bytes: None,
                }));
                frames.extend(encode_envelope(&Envelope::Request(request)));
                for (id, bytes) in [(1, bytes.as_slice()), (2, &[][..])] {
                    frames.extend(encode_envelope(&Envelope::BlobStart(BlobStart {
                        request_id: 3,
                        stream_id: id,
                        total_bytes: Some(bytes.len() as u64),
                        sha256: Some(hex_sha256(bytes)),
                    })));
                    frames.extend(
                        encode_blob_chunk_frame(id, true, bytes, &WireLimits::default()).unwrap(),
                    );
                }
                (frames, hex_sha256(&bytes), bytes.len(), 0, TEST_AUTH_TOKEN)
            };
        let mut source_decoder = FrameDecoder::new(WireLimits::default());
        source_decoder.push(&frames);
        let mut source_update = Vec::new();
        while let Some(frame) = source_decoder.next_frame().unwrap() {
            if let Frame::BlobChunk {
                stream_id: 1,
                bytes,
                ..
            } = frame
            {
                source_update.extend(bytes);
            }
        }
        assert_eq!(source_update.len(), expected_bytes);
        let source_doc = Ydoc::wire();
        source_doc.apply(&source_update).unwrap();
        let expected_content = source_doc.canonical_content_sha256();
        drop(source_doc);
        drop(source_update);
        let ingress =
            LiveApplicationIngress::new(service.clone(), live_test_support::config()).unwrap();
        let supervisor = Arc::new(Supervisor::new(
            SupervisorConfig::default(),
            service.clone(),
        ));
        let (mut sender, input) = tokio::io::duplex(64 * 1024);
        let (output, mut receiver) = tokio::io::duplex(64 * 1024);
        let service_for_close = service.clone();
        let workspace_for_close = workspace.clone();
        let task = tokio::spawn(async move {
            run_transport_with_live(
                auth.into(),
                input,
                output,
                supervisor,
                no_events(),
                || Ok(()),
                Some((owner, ingress)),
            )
            .await
        });
        let send = tokio::spawn(async move {
            sender.write_all(&frames).await.unwrap();
            sender
        });
        let mut decoder = FrameDecoder::new(WireLimits::default());
        let mut read = [0; 8192];
        let response = tokio::time::timeout(Duration::from_secs(60), async {
            'response: loop {
                let count = receiver.read(&mut read).await.unwrap();
                assert_ne!(
                    count, 0,
                    "transport closed before application acknowledgement"
                );
                decoder.push(&read[..count]);
                while let Some(Frame::Control(payload)) = decoder.next_frame().unwrap() {
                    match decode_control(&payload, &WireLimits::default()).unwrap() {
                        Envelope::Response(response) => break 'response response,
                        Envelope::Error(error) => {
                            panic!("transport refused valid application: {error:?}")
                        }
                        _ => {}
                    }
                }
            }
        })
        .await
        .unwrap();
        assert_eq!(response.result["status"], "applied");
        let ack = dohc_engine_collab::live_update_application::parse_application_ack(
            response.result["ack"].clone(),
        )
        .unwrap();
        let raw =
            rusqlite::Connection::open(scratch.path().join(".dohc/engine/engine.db")).unwrap();
        let digest: String = raw
            .query_row(
                "SELECT update_digest FROM live_device_update_applications",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(digest, expected_digest);
        let stored_ranges: i64 = raw
            .query_row(
                "SELECT COUNT(*) FROM live_device_application_first_seen",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(stored_ranges, expected_ranges);
        let receipt: (String, String, i64, i64, i64) = raw.query_row("SELECT delivery_id,update_digest,journal_cursor,accepting_host_epoch,local_ydoc_sequence FROM live_device_update_applications", [], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?))).unwrap();
        assert_eq!(
            receipt,
            (
                ack.delivery_id,
                ack.update_digest,
                ack.journal_cursor,
                ack.accepting_host_epoch,
                ack.local_ydoc_sequence
            )
        );
        assert!(!ack.application_replayed);
        drop(raw);
        drop(send.await.unwrap());
        task.await.unwrap().unwrap();
        service_for_close
            .call(
                RequestContext::unbounded(),
                WireRequest {
                    id: 99,
                    method: "workspace.close".into(),
                    workspace: Some(dohc_engine_protocol::wire::WorkspaceHandle(
                        workspace_for_close,
                    )),
                    deadline_ms: None,
                    idempotency_key: None,
                    params: serde_json::Value::Null,
                },
            )
            .await
            .unwrap();
        let reopened = dohc_engine_storage::EngineStore::open(
            &scratch.path().join(".dohc/engine/engine.db"),
            0,
        )
        .unwrap();
        let reconstructed = reopened
            .read_with(|conn| {
                dohc_engine_collab::durable::load_doc_in(
                    conn,
                    &dohc_engine_collab::DocKey::new("workspace", "main", "one").unwrap(),
                )
            })
            .unwrap();
        assert!(!reconstructed.has_pending_dependencies());
        assert_eq!(reconstructed.canonical_content_sha256(), expected_content);
        let recovered_sequence = reopened
            .read_with(|conn| {
                conn.query_row(
                    "SELECT local_ydoc_sequence FROM live_device_update_applications",
                    [],
                    |row| row.get::<_, i64>(0),
                )
            })
            .unwrap();
        assert_eq!(recovered_sequence, ack.local_ydoc_sequence);
        drop(reopened);
    }

    #[derive(Debug)]
    struct TestOutputGuard {
        cancel: CancelSignal,
        retired: CancelSignal,
        deadline: Option<std::time::Instant>,
        dropped: Arc<AtomicBool>,
    }

    impl Drop for TestOutputGuard {
        fn drop(&mut self) {
            self.dropped.store(true, Ordering::SeqCst);
        }
    }

    impl OutputGuard for TestOutputGuard {
        fn is_current(&self) -> bool {
            !self.cancel.is_cancelled() && !self.retired.is_cancelled()
        }
        fn cancel_signal(&self) -> CancelSignal {
            self.cancel.clone()
        }
        fn retirement_signal(&self) -> CancelSignal {
            self.retired.clone()
        }
        fn deadline(&self) -> Option<std::time::Instant> {
            self.deadline
        }
    }

    struct BlockedWriter {
        polled: Arc<Notify>,
        flush_only: bool,
        bytes: Arc<AtomicUsize>,
    }

    impl AsyncWrite for BlockedWriter {
        fn poll_write(
            self: Pin<&mut Self>,
            _: &mut TaskContext<'_>,
            bytes: &[u8],
        ) -> Poll<io::Result<usize>> {
            if self.flush_only {
                self.bytes.fetch_add(bytes.len(), Ordering::SeqCst);
                Poll::Ready(Ok(bytes.len()))
            } else {
                self.polled.notify_one();
                Poll::Pending
            }
        }
        fn poll_flush(self: Pin<&mut Self>, _: &mut TaskContext<'_>) -> Poll<io::Result<()>> {
            self.polled.notify_one();
            Poll::Pending
        }
        fn poll_shutdown(self: Pin<&mut Self>, _: &mut TaskContext<'_>) -> Poll<io::Result<()>> {
            Poll::Ready(Ok(()))
        }
    }

    #[tokio::test]
    async fn unwritten_retired_or_expired_acknowledgements_preserve_following_output() {
        for expired in [false, true] {
            let retired = CancelSignal::new();
            if !expired {
                retired.cancel();
            }
            let (tx, mut rx) = tokio::sync::mpsc::channel(2);
            tx.send(OutputItem::Guarded {
                response: WireResponse {
                    id: 9,
                    result: serde_json::Value::Null,
                },
                guard: Arc::new(TestOutputGuard {
                    cancel: CancelSignal::new(),
                    retired,
                    deadline: expired.then(|| std::time::Instant::now() - Duration::from_secs(1)),
                    dropped: Arc::new(AtomicBool::new(false)),
                }),
            })
            .await
            .unwrap();
            tx.send(OutputItem::Envelope(Envelope::Response(WireResponse {
                id: 10,
                result: serde_json::Value::Null,
            })))
            .await
            .unwrap();
            drop(tx);
            let active = Arc::new(Mutex::new(HashMap::from([(9, CancelSignal::new())])));
            let mut output = Vec::new();
            let limits = WireLimits::default();
            write_output(&mut output, &mut rx, &limits, active.clone())
                .await
                .unwrap();
            assert!(!lock(&active).contains_key(&9));
            let mut decoder = FrameDecoder::new(limits.clone());
            decoder.push(&output);
            let Some(Frame::Control(payload)) = decoder.next_frame().unwrap() else {
                panic!("following response missing");
            };
            assert!(
                matches!(decode_control(&payload, &limits).unwrap(), Envelope::Response(response) if response.id == 10)
            );
            assert!(decoder.next_frame().unwrap().is_none());
        }
    }

    #[tokio::test(start_paused = true)]
    async fn partially_written_acknowledgement_expiry_closes_output() {
        let (tx, mut rx) = tokio::sync::mpsc::channel(1);
        tx.send(OutputItem::Guarded {
            response: WireResponse {
                id: 9,
                result: serde_json::json!({"content":"larger than the output buffer"}),
            },
            guard: Arc::new(TestOutputGuard {
                cancel: CancelSignal::new(),
                retired: CancelSignal::new(),
                deadline: Some(std::time::Instant::now() + Duration::from_secs(10)),
                dropped: Arc::new(AtomicBool::new(false)),
            }),
        })
        .await
        .unwrap();
        drop(tx);
        let (writer, mut reader) = tokio::io::duplex(8);
        let task = tokio::spawn(async move {
            write_output(
                writer,
                &mut rx,
                &WireLimits::default(),
                Arc::new(Mutex::new(HashMap::new())),
            )
            .await
        });
        let mut prefix = [0; 8];
        reader.read_exact(&mut prefix).await.unwrap();
        tokio::time::advance(Duration::from_secs(11)).await;
        assert_eq!(
            task.await.unwrap().unwrap_err().kind(),
            io::ErrorKind::TimedOut
        );
    }

    #[tokio::test]
    async fn guarded_output_retires_while_write_or_flush_is_blocked() {
        for flush_only in [false, true] {
            for retire_owner in [false, true] {
                let cancel = CancelSignal::new();
                let retired = CancelSignal::new();
                let dropped = Arc::new(AtomicBool::new(false));
                let polled = Arc::new(Notify::new());
                let bytes = Arc::new(AtomicUsize::new(0));
                let guard = Arc::new(TestOutputGuard {
                    cancel: cancel.clone(),
                    retired: retired.clone(),
                    deadline: None,
                    dropped: dropped.clone(),
                });
                let (tx, mut rx) = tokio::sync::mpsc::channel(1);
                tx.send(OutputItem::Guarded {
                    response: WireResponse {
                        id: 9,
                        result: serde_json::json!({"status":"applied"}),
                    },
                    guard,
                })
                .await
                .unwrap();
                drop(tx);
                let writer = BlockedWriter {
                    polled: polled.clone(),
                    flush_only,
                    bytes: bytes.clone(),
                };
                let task = tokio::spawn(async move {
                    write_output(
                        writer,
                        &mut rx,
                        &WireLimits::default(),
                        Arc::new(Mutex::new(HashMap::new())),
                    )
                    .await
                });
                polled.notified().await;
                if retire_owner {
                    retired.cancel();
                } else {
                    cancel.cancel();
                }
                let result = tokio::time::timeout(Duration::from_secs(2), task)
                    .await
                    .unwrap()
                    .unwrap();
                if flush_only {
                    assert_eq!(result.unwrap_err().kind(), io::ErrorKind::ConnectionAborted);
                } else {
                    result.unwrap();
                }
                assert!(
                    dropped.load(Ordering::SeqCst),
                    "response disposal releases its reservation"
                );
                if !flush_only {
                    assert_eq!(bytes.load(Ordering::SeqCst), 0);
                }
            }
        }
    }

    #[tokio::test(start_paused = true)]
    async fn guarded_output_deadline_wakes_a_blocked_writer() {
        let polled = Arc::new(Notify::new());
        let dropped = Arc::new(AtomicBool::new(false));
        let (tx, mut rx) = tokio::sync::mpsc::channel(1);
        tx.send(OutputItem::Guarded {
            response: WireResponse {
                id: 1,
                result: serde_json::Value::Null,
            },
            guard: Arc::new(TestOutputGuard {
                cancel: CancelSignal::new(),
                retired: CancelSignal::new(),
                deadline: Some(std::time::Instant::now() + Duration::from_secs(10)),
                dropped: dropped.clone(),
            }),
        })
        .await
        .unwrap();
        drop(tx);
        let writer = BlockedWriter {
            polled: polled.clone(),
            flush_only: false,
            bytes: Arc::new(AtomicUsize::new(0)),
        };
        let task = tokio::spawn(async move {
            write_output(
                writer,
                &mut rx,
                &WireLimits::default(),
                Arc::new(Mutex::new(HashMap::new())),
            )
            .await
        });
        polled.notified().await;
        tokio::time::advance(Duration::from_secs(11)).await;
        task.await.unwrap().unwrap();
        assert!(dropped.load(Ordering::SeqCst));
    }

    /// A pre-closed events channel for transports whose test does not
    /// exercise event delivery.
    fn no_events() -> tokio::sync::mpsc::Receiver<EngineEventNotice> {
        tokio::sync::mpsc::channel(1).1
    }

    fn encode_envelope(envelope: &Envelope) -> Vec<u8> {
        // `encode_control` already returns a complete frame (header + JSON
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
            max_frame_bytes: None,
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

    #[tokio::test]
    async fn a_reserved_upload_id_cannot_dispatch_an_ordinary_request() {
        let calls = Arc::new(AtomicUsize::new(0));
        let supervisor = Arc::new(Supervisor::new(
            SupervisorConfig::default(),
            Arc::new(CountingService {
                calls: calls.clone(),
            }),
        ));
        let (tx, mut rx) = tokio::sync::mpsc::channel(1);
        let (gone, _) = tokio::sync::watch::channel(false);
        let active = Arc::new(Mutex::new(HashSet::from([7])));
        let egress = Arc::new(Mutex::new(HashMap::new()));
        let mut tasks = JoinSet::new();
        assert!(
            dispatch_authenticated(
                Envelope::Request(WireRequest {
                    id: 7,
                    method: "test.echo".into(),
                    workspace: None,
                    deadline_ms: None,
                    idempotency_key: None,
                    params: serde_json::Value::Null
                }),
                &supervisor,
                &tx,
                &gone,
                &active,
                &egress,
                &mut tasks,
                true,
                WireLimits::default().max_frame_bytes,
                None,
                None
            )
            .await
        );
        assert!(
            matches!(rx.recv().await, Some(OutputItem::Envelope(Envelope::Error(error))) if error.error.message == "duplicate-request-id")
        );
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert!(lock(&active).contains(&7));
    }

    impl ProtocolEngineService for CountingService {
        type Input = LiveApplicationInput;
        async fn call(
            &self,
            _ctx: RequestContext,
            request: WireRequest,
        ) -> Result<ServiceResponse, WireError> {
            self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Ok(ServiceResponse::response(WireResponse {
                id: request.id,
                result: serde_json::Value::Null,
            }))
        }
    }

    struct BlobService;

    impl ProtocolEngineService for BlobService {
        type Input = LiveApplicationInput;
        async fn call(
            &self,
            _ctx: RequestContext,
            request: WireRequest,
        ) -> Result<ServiceResponse, WireError> {
            let bytes = vec![0x7a; 64 * 1024];
            Ok(ServiceResponse {
                output_guard: None,
                response: WireResponse {
                    id: request.id,
                    result: serde_json::json!({
                        "bytesBase64": null,
                        "byteLength": bytes.len(),
                        "inbandLimitBytes": 48 * 1024,
                    }),
                },
                blob_egress: Some(BlobEgress {
                    stream_id: request.id,
                    sha256: "blob-capability-test".to_owned(),
                    bytes,
                    cancel: CancelSignal::new(),
                    deadline: None,
                    byte_permit: None,
                }),
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
        type Input = LiveApplicationInput;
        async fn call(
            &self,
            _ctx: RequestContext,
            request: WireRequest,
        ) -> Result<ServiceResponse, WireError> {
            self.started.notify_one();
            self.release.notified().await;
            Ok(ServiceResponse::response(WireResponse {
                id: request.id,
                result: serde_json::Value::Null,
            }))
        }
    }

    #[tokio::test]
    async fn inbound_blob_start_is_refused_as_unsupported_ingest() {
        let service = Arc::new(CountingService {
            calls: Arc::new(AtomicUsize::new(0)),
        });
        let supervisor = Arc::new(Supervisor::new(SupervisorConfig::default(), service));
        let (output, mut received) = tokio::sync::mpsc::channel(1);
        let (writer_gone, _) = tokio::sync::watch::channel(false);
        let active_requests = Arc::new(Mutex::new(HashSet::new()));
        let active_egress = Arc::new(Mutex::new(HashMap::new()));
        let mut request_tasks = JoinSet::new();
        let keep_running = dispatch_authenticated(
            Envelope::BlobStart(BlobStart {
                request_id: 7,
                stream_id: 9,
                total_bytes: Some(3),
                sha256: None,
            }),
            &supervisor,
            &output,
            &writer_gone,
            &active_requests,
            &active_egress,
            &mut request_tasks,
            false,
            WireLimits::default().max_frame_bytes,
            None,
            None,
        )
        .await;
        assert!(!keep_running);
        let OutputItem::Envelope(Envelope::Error(error)) =
            received.recv().await.expect("error envelope")
        else {
            panic!("BlobStart must produce an error envelope");
        };
        assert_eq!(error.error.code, ErrorCode::InvalidParams);
        assert_eq!(error.error.message, "blob-ingest-unsupported");
    }

    #[tokio::test]
    async fn daemon_blob_writer_emits_start_bounded_chunks_fin_then_response() {
        let bytes = vec![0xa5; 2 * 256 * 1024 + 17];
        let response = WireResponse {
            id: 71,
            result: serde_json::json!({
                "bytesBase64": null,
                "byteLength": bytes.len(),
                "inbandLimitBytes": 48 * 1024,
            }),
        };
        let egress = BlobEgress {
            stream_id: 71,
            sha256: "abc123".to_owned(),
            bytes: bytes.clone(),
            cancel: CancelSignal::new(),
            deadline: None,
            byte_permit: None,
        };
        let limits = WireLimits::default();
        let (mut output, mut input) = tokio::io::duplex(bytes.len() + 4096);
        write_blob_egress(&mut output, response.clone(), egress, &limits)
            .await
            .expect("write blob egress");
        output.shutdown().await.expect("close transcript");
        let mut transcript = Vec::new();
        input
            .read_to_end(&mut transcript)
            .await
            .expect("read transcript");

        let mut decoder = FrameDecoder::new(limits.clone());
        decoder.push(&transcript);
        let Frame::Control(start) = decoder.next_frame().expect("frame").expect("start") else {
            panic!("first frame must be BlobStart");
        };
        assert_eq!(
            decode_control(&start, &limits).expect("decode start"),
            Envelope::BlobStart(BlobStart {
                request_id: 71,
                stream_id: 71,
                total_bytes: Some(bytes.len() as u64),
                sha256: Some("abc123".to_owned()),
            })
        );

        let mut rebuilt = Vec::new();
        let mut fins = Vec::new();
        for _ in 0..3 {
            let Frame::BlobChunk {
                stream_id,
                fin,
                bytes,
            } = decoder.next_frame().expect("frame").expect("chunk")
            else {
                panic!("middle frames must be BlobChunk");
            };
            assert_eq!(stream_id, 71);
            assert!(bytes.len() <= 256 * 1024);
            fins.push(fin);
            rebuilt.extend(bytes);
        }
        assert_eq!(rebuilt, bytes);
        assert_eq!(fins, vec![false, false, true]);

        let Frame::Control(response_frame) =
            decoder.next_frame().expect("frame").expect("response")
        else {
            panic!("last frame must be Response");
        };
        assert_eq!(
            decode_control(&response_frame, &limits).expect("decode response"),
            Envelope::Response(response)
        );
        assert!(decoder.next_frame().expect("frame").is_none());
    }

    #[tokio::test]
    async fn daemon_blob_writer_emits_one_empty_fin_before_response() {
        let response = WireResponse {
            id: 73,
            result: serde_json::json!({ "empty": true }),
        };
        let egress = BlobEgress {
            stream_id: 73,
            sha256: dohc_engine_storage::hex_sha256(&[]),
            bytes: Vec::new(),
            cancel: CancelSignal::new(),
            deadline: None,
            byte_permit: None,
        };
        let limits = WireLimits::default();
        let (mut output, mut input) = tokio::io::duplex(4096);
        write_blob_egress(&mut output, response.clone(), egress, &limits)
            .await
            .expect("write empty blob egress");
        output.shutdown().await.expect("close transcript");
        let mut transcript = Vec::new();
        input
            .read_to_end(&mut transcript)
            .await
            .expect("read transcript");

        let mut decoder = FrameDecoder::new(limits.clone());
        decoder.push(&transcript);
        let Frame::Control(start) = decoder.next_frame().expect("frame").expect("start") else {
            panic!("first frame must be BlobStart");
        };
        assert!(matches!(
            decode_control(&start, &limits).expect("decode start"),
            Envelope::BlobStart(BlobStart {
                request_id: 73,
                stream_id: 73,
                total_bytes: Some(0),
                ..
            })
        ));
        let Frame::BlobChunk {
            stream_id,
            fin,
            bytes,
        } = decoder
            .next_frame()
            .expect("frame")
            .expect("empty final chunk")
        else {
            panic!("second frame must be the empty final BlobChunk");
        };
        assert_eq!(stream_id, 73);
        assert!(fin);
        assert!(bytes.is_empty());
        let Frame::Control(response_frame) =
            decoder.next_frame().expect("frame").expect("response")
        else {
            panic!("last frame must be Response");
        };
        assert_eq!(
            decode_control(&response_frame, &limits).expect("decode response"),
            Envelope::Response(response)
        );
        assert!(decoder.next_frame().expect("frame").is_none());
    }

    #[tokio::test]
    async fn cancelled_daemon_blob_writer_emits_no_blob_bytes() {
        let cancel = CancelSignal::new();
        cancel.cancel();
        let response = WireResponse {
            id: 72,
            result: serde_json::Value::Null,
        };
        let egress = BlobEgress {
            stream_id: 72,
            sha256: "cancelled".to_owned(),
            bytes: vec![0x5c; 64 * 1024],
            cancel,
            deadline: None,
            byte_permit: None,
        };
        let limits = WireLimits::default();
        let (mut output, mut input) = tokio::io::duplex(4096);
        write_blob_egress(&mut output, response, egress, &limits)
            .await
            .expect("write cancellation");
        output.shutdown().await.expect("close transcript");
        let mut transcript = Vec::new();
        input
            .read_to_end(&mut transcript)
            .await
            .expect("read transcript");

        let mut decoder = FrameDecoder::new(limits.clone());
        decoder.push(&transcript);
        let Frame::Control(error_frame) = decoder.next_frame().expect("frame").expect("error")
        else {
            panic!("cancelled egress must emit only an Error envelope");
        };
        let Envelope::Error(error) =
            decode_control(&error_frame, &limits).expect("decode cancellation")
        else {
            panic!("cancelled egress must emit an Error envelope");
        };
        assert_eq!(error.id, Some(72));
        assert_eq!(error.error.code, ErrorCode::Cancelled);
        assert!(decoder.next_frame().expect("frame").is_none());
    }

    #[tokio::test]
    async fn blob_egress_requires_negotiated_blobs_capability() {
        for (id, blobs_negotiated) in [(81, false), (82, true)] {
            let mut input_bytes = encode_envelope(&Envelope::Hello(Hello {
                protocol_version: PROTOCOL_VERSION,
                auth_token: TEST_AUTH_TOKEN.to_owned(),
                capabilities: if blobs_negotiated {
                    vec!["blobs".to_owned()]
                } else {
                    Vec::new()
                },
                last_session_generation: None,
                max_frame_bytes: None,
            }));
            input_bytes.extend_from_slice(&encode_envelope(&Envelope::Request(WireRequest {
                id,
                method: "test.blob".to_owned(),
                workspace: None,
                deadline_ms: None,
                idempotency_key: None,
                params: serde_json::Value::Null,
            })));
            let (client, server) = tokio::io::duplex(256 * 1024);
            let (server_input, server_output) = tokio::io::split(server);
            let (mut client_input, mut client_output) = tokio::io::split(client);
            let service = Arc::new(BlobService);
            let supervisor = Arc::new(Supervisor::new(SupervisorConfig::default(), service));
            let run = tokio::spawn(run_transport(
                TEST_AUTH_TOKEN.to_owned(),
                server_input,
                server_output,
                supervisor,
                no_events(),
                || Ok(()),
            ));
            client_output
                .write_all(&input_bytes)
                .await
                .expect("write client transcript");
            client_output.shutdown().await.expect("close client input");
            let mut transcript = Vec::new();
            client_input
                .read_to_end(&mut transcript)
                .await
                .expect("read daemon transcript");
            run.await
                .expect("transport task")
                .expect("transport succeeds");

            let limits = WireLimits::default();
            let mut decoder = FrameDecoder::new(limits.clone());
            decoder.push(&transcript);
            let Frame::Control(ack_frame) = decoder.next_frame().expect("frame").expect("ack")
            else {
                panic!("first frame must be HelloAck");
            };
            let Envelope::HelloAck(ack) = decode_control(&ack_frame, &limits).expect("decode ack")
            else {
                panic!("first envelope must be HelloAck");
            };
            assert_eq!(
                ack.capabilities,
                if blobs_negotiated {
                    vec!["blobs"]
                } else {
                    Vec::<&str>::new()
                }
            );
            if blobs_negotiated {
                let Frame::Control(start_frame) =
                    decoder.next_frame().expect("frame").expect("blob start")
                else {
                    panic!("negotiated client must receive BlobStart");
                };
                assert!(matches!(
                    decode_control(&start_frame, &limits).expect("decode start"),
                    Envelope::BlobStart(BlobStart { request_id, .. }) if request_id == id
                ));
                let Frame::BlobChunk {
                    stream_id,
                    fin,
                    bytes,
                } = decoder.next_frame().expect("frame").expect("blob chunk")
                else {
                    panic!("negotiated client must receive BlobChunk");
                };
                assert_eq!(stream_id, id);
                assert!(fin);
                assert_eq!(bytes, vec![0x7a; 64 * 1024]);
            } else {
                let Frame::Control(error_frame) =
                    decoder.next_frame().expect("frame").expect("error")
                else {
                    panic!("non-negotiating client must receive an error");
                };
                let Envelope::Error(error) =
                    decode_control(&error_frame, &limits).expect("decode error")
                else {
                    panic!("non-negotiating client received a non-error envelope");
                };
                assert_eq!(error.id, Some(id));
                assert_eq!(error.error.code, ErrorCode::InvalidParams);
                assert_eq!(error.error.message, "blob-capability-required");
                assert!(decoder.next_frame().expect("frame").is_none());
                continue;
            }
            let Frame::Control(response_frame) =
                decoder.next_frame().expect("frame").expect("response")
            else {
                panic!("last frame must be Response");
            };
            let Envelope::Response(response) =
                decode_control(&response_frame, &limits).expect("decode response")
            else {
                panic!("last envelope must be Response");
            };
            assert_eq!(response.id, id);
            assert_eq!(response.result["bytesBase64"], serde_json::Value::Null);
            assert!(decoder.next_frame().expect("frame").is_none());
        }
    }

    #[tokio::test]
    async fn service_events_flow_as_event_envelopes_only_after_hello_ack() {
        let service = Arc::new(CountingService {
            calls: Arc::new(AtomicUsize::new(0)),
        });
        let supervisor = Arc::new(Supervisor::new(SupervisorConfig::default(), service));
        let (events_tx, events_rx) = tokio::sync::mpsc::channel(8);
        // Queued before the handshake: must be dropped, never delivered ahead
        // of the helloAck.
        events_tx
            .try_send(EngineEventNotice {
                name: "capture.momentRecorded".to_owned(),
                payload: serde_json::json!({ "marker": "pre-handshake" }),
            })
            .expect("queue pre-handshake notice");

        let (client, server) = tokio::io::duplex(64 * 1024);
        let (server_input, server_output) = tokio::io::split(server);
        let (mut client_input, mut client_output) = tokio::io::split(client);
        let run = tokio::spawn(run_transport(
            TEST_AUTH_TOKEN.to_owned(),
            server_input,
            server_output,
            supervisor,
            events_rx,
            || Ok(()),
        ));
        // This test uses one executor thread. The forwarder reads generation
        // 0 and drops the notice before yielding with an empty channel.
        tokio::time::timeout(Duration::from_secs(10), async {
            while events_tx.capacity() < events_tx.max_capacity() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("pre-handshake notice consumed");
        client_output
            .write_all(&hello_bytes())
            .await
            .expect("send hello");

        let limits = WireLimits::default();
        let mut decoder = FrameDecoder::new(limits.clone());
        async fn next_envelope(
            decoder: &mut FrameDecoder,
            input: &mut (impl AsyncRead + Unpin),
            limits: &WireLimits,
        ) -> Envelope {
            loop {
                if let Some(frame) = decoder.next_frame().expect("frame") {
                    let Frame::Control(payload) = frame else {
                        panic!("expected a control frame");
                    };
                    return decode_control(&payload, limits).expect("decode envelope");
                }
                let mut buf = [0_u8; 4096];
                let read = input.read(&mut buf).await.expect("read");
                assert!(read > 0, "transport closed before the expected frame");
                decoder.push(&buf[..read]);
            }
        }
        let Envelope::HelloAck(ack) = next_envelope(&mut decoder, &mut client_input, &limits).await
        else {
            panic!("first envelope must be HelloAck");
        };

        events_tx
            .try_send(EngineEventNotice {
                name: "capture.momentRecorded".to_owned(),
                payload: serde_json::json!({ "marker": "post-handshake" }),
            })
            .expect("queue post-handshake notice");
        let event = tokio::time::timeout(
            Duration::from_secs(10),
            next_envelope(&mut decoder, &mut client_input, &limits),
        )
        .await
        .expect("event envelope arrives");
        let Envelope::Event(event) = event else {
            panic!("second envelope must be the Event");
        };
        assert_eq!(event.name, "capture.momentRecorded");
        assert_eq!(event.payload["marker"], "post-handshake");
        assert_eq!(
            event.seq, 1,
            "the dropped pre-handshake notice must not consume a seq"
        );
        assert_eq!(event.session_generation, ack.session_generation);

        client_output.shutdown().await.expect("close client input");
        run.await
            .expect("transport task")
            .expect("transport succeeds");
    }

    #[test]
    fn blob_capability_is_negotiated_only_when_requested() {
        let ack = authenticate(
            Envelope::Hello(Hello {
                protocol_version: PROTOCOL_VERSION,
                auth_token: TEST_AUTH_TOKEN.to_owned(),
                capabilities: vec!["unknown".to_owned(), "blobs".to_owned()],
                last_session_generation: None,
                max_frame_bytes: None,
            }),
            TEST_AUTH_TOKEN,
        )
        .expect("authenticated hello");
        assert_eq!(ack.capabilities, vec!["blobs"]);
    }

    #[test]
    fn hello_frame_limit_clamps_into_the_negotiable_range_and_echoes() {
        let ack_for = |requested: Option<u32>| {
            authenticate(
                Envelope::Hello(Hello {
                    protocol_version: PROTOCOL_VERSION,
                    auth_token: TEST_AUTH_TOKEN.to_owned(),
                    capabilities: vec![],
                    last_session_generation: None,
                    max_frame_bytes: requested,
                }),
                TEST_AUTH_TOKEN,
            )
            .expect("authenticated hello")
            .limits
            .max_frame_bytes
        };
        let default = WireLimits::default().max_frame_bytes;
        let floor = dohc_engine_protocol::limits::MIN_NEGOTIABLE_FRAME_BYTES;
        assert_eq!(ack_for(None), default);
        assert_eq!(ack_for(Some(2 * 1024 * 1024)), 2 * 1024 * 1024);
        assert_eq!(ack_for(Some(1024)), floor);
        assert_eq!(ack_for(Some(u32::MAX)), default);
    }

    #[tokio::test]
    async fn fatal_envelope_stops_requests_in_the_same_read() {
        for fatal in [
            hello_bytes(),
            encode_envelope(&Envelope::Response(WireResponse {
                id: 1,
                result: serde_json::Value::Null,
            })),
        ] {
            let calls = Arc::new(AtomicUsize::new(0));
            let service = Arc::new(CountingService {
                calls: calls.clone(),
            });
            let supervisor = Arc::new(Supervisor::new(SupervisorConfig::default(), service));
            let mut bytes = hello_bytes();
            bytes.extend(fatal);
            bytes.extend(request_bytes(2));
            run_transport(
                TEST_AUTH_TOKEN.to_owned(),
                HelloThenRequests { bytes, pos: 0 },
                SinkWriter,
                supervisor,
                no_events(),
                || Ok(()),
            )
            .await
            .expect("fatal response is written");
            assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 0);
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
                no_events(),
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
            no_events(),
            move || {
                close_witness.store(true, std::sync::atomic::Ordering::SeqCst);
                Ok(())
            },
        ));

        // The request is now in flight (its handler is parked on `release`)
        // and the finite reader has already hit EOF, so the daemon is
        // already past `while keep_running` and into its shutdown path.
        // Closing workspaces must not have happened yet.
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
    /// the cancel/drain/close tail -- it must not propagate straight out,
    /// abandoning in-flight work and skipping the workspace close. Socket
    /// transports report ECONNRESET as their normal close.
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
                no_events(),
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

    /// Pins the functional half of the contract: a correct prefix must not pass,
    /// and a last-byte difference must be as rejected as a first-byte one.
    ///
    /// The timing half cannot be pinned by a unit test — swapping `ct_eq` back
    /// for `==` keeps every assertion below green. Constant-time behavior comes
    /// from `subtle`, not from this test; the test exists so a future edit
    /// cannot quietly turn the comparison into a prefix match.
    #[test]
    fn token_comparison_rejects_prefixes_and_late_differences() {
        let expected = "b7f3a1c0d9e2f4a6b8c1d3e5f7a9b2c4d6e8f0a1b3c5d7e9f1a3b5c7d9e1f3a5";
        assert!(constant_time_eq(expected.as_bytes(), expected.as_bytes()));
        assert!(!constant_time_eq(
            &expected.as_bytes()[..63],
            expected.as_bytes()
        ));
        assert!(!constant_time_eq(b"", expected.as_bytes()));
        let mut last_differs = expected.as_bytes().to_vec();
        *last_differs.last_mut().expect("non-empty") ^= 0x01;
        assert!(!constant_time_eq(&last_differs, expected.as_bytes()));
        let mut first_differs = expected.as_bytes().to_vec();
        first_differs[0] ^= 0x01;
        assert!(!constant_time_eq(&first_differs, expected.as_bytes()));
    }
}
