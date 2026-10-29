//! DOP1 stdio host for the workspace engine daemon.

#![forbid(unsafe_code)]

use dohc_engine_protocol::{
    cancel::{CancelSignal, Cancelled},
    error::{EnvelopeDecodeError, ErrorCode, Retryability, WireError},
    frame::{Frame, FrameDecoder, blob_chunks, encode_blob_chunk_frame},
    limits::WireLimits,
    supervisor::{Supervisor, SupervisorConfig},
    transport::{
        BlobEgress, ConnectionHandle, ConnectionOwner, EngineService as ProtocolEngineService,
        OutputGuard, ProgressMessage, ProgressSink,
    },
    wire::{
        BlobStart, Envelope, ErrorEnvelope, Event, Hello, HelloAck, PROGRESS_CAPABILITY,
        PROTOCOL_VERSION, Progress, Response, decode_control, encode_control,
    },
};
use dohc_engine_runtime::{RuntimeError, WorkspaceSupervisor};
#[cfg(test)]
use dohc_workspace_engine::EngineEventNotice;
use dohc_workspace_engine::live_application_ingress::{
    LiveApplicationIngress, LiveApplicationIngressConfig, UploadCompletion,
};
use dohc_workspace_engine::{ConfiguredLiveHostConfig, EngineService, LiveApplicationInput};
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
    /// Written as a `progress` envelope. Dropping it lets its request report
    /// again, so each request has at most one of these queued.
    Progress(ProgressMessage),
    Guarded {
        response: Response,
        guard: Arc<dyn OutputGuard>,
    },
    Blob {
        response: Response,
        egress: BlobEgress,
    },
    GuardedBlob {
        response: Response,
        egress: BlobEgress,
        guard: Arc<dyn OutputGuard>,
    },
}

impl From<Envelope> for OutputItem {
    fn from(envelope: Envelope) -> Self {
        OutputItem::Envelope(envelope)
    }
}

fn main() -> Result<(), Box<dyn Error>> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    if args == ["--replica-sandbox-check"] {
        let mut random = [0u8; 16];
        getrandom::fill(&mut random)?;
        let store = std::env::temp_dir().join(format!(
            "dohc-sandbox-check-{:032x}",
            u128::from_le_bytes(random)
        ));
        std::fs::create_dir(&store)?;
        let result = std::process::Command::new(std::env::current_exe()?)
            .arg("--replica-sandbox-check-store")
            .arg(&store)
            .status();
        std::fs::remove_dir(&store)?;
        if !result?.success() {
            return Err(io::Error::other("replica sandbox check failed").into());
        }
        return Ok(());
    }
    if args.len() == 2 && args[0] == "--replica-sandbox-check-store" {
        println!(
            "Landlock policy ABI {}",
            dohc_workspace_engine::replica_sandbox::apply(std::path::Path::new(&args[1]))?
        );
        return Ok(());
    }
    if args == ["--projection-only"] {
        if std::env::var_os("DOHC_ENGINE_LIVE_HOST_CONFIG").is_some()
            || std::env::var_os("DOHC_ENGINE_OWNER_HOST_CONFIG").is_some()
        {
            return Err(io::Error::other("projection mode takes no configuration").into());
        }
        dohc_workspace_engine::projection_stdio::run(
            &mut io::stdin().lock(),
            &mut io::stdout().lock(),
        )?;
        return Ok(());
    }
    let replica = args == ["--replica"];
    if replica {
        dohc_workspace_engine::replica_sandbox::apply(&std::env::current_dir()?)?;
    }
    let passive = replica || args == ["--store-role", "passive"];
    if !args.is_empty() && !passive {
        return Err(io::Error::other("unknown engine arguments").into());
    }
    let auth_token = std::env::var(AUTH_TOKEN_ENV)
        .ok()
        .filter(|token| !token.is_empty())
        .ok_or_else(|| {
            io::Error::new(io::ErrorKind::PermissionDenied, "engine auth token missing")
        })?;
    let runtime = if replica {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .max_blocking_threads(4)
            .enable_all()
            .build()?
    } else {
        tokio::runtime::Runtime::new()?
    };
    runtime.block_on(run_stdio(auth_token, passive, replica))
}

fn passive_ingress(
    service: Arc<EngineService>,
    passive: bool,
) -> Result<Option<(ConnectionOwner, LiveApplicationIngress)>, Box<dyn Error>> {
    if !passive {
        return Ok(None);
    }
    let ingress = LiveApplicationIngress::new(
        service,
        LiveApplicationIngressConfig {
            aggregate_bytes: 2 * 1024 * 1024 * 1024,
            application_working_reserve_bytes: 32 * 1024 * 1024,
            max_uploads: 1,
            upload_deadline: std::time::Duration::from_secs(120),
        },
    )?;
    Ok(Some((ConnectionOwner::authenticated(), ingress)))
}

async fn run_stdio(auth_token: String, passive: bool, replica: bool) -> Result<(), Box<dyn Error>> {
    if passive
        && (std::env::var_os("DOHC_ENGINE_LIVE_HOST_CONFIG").is_some()
            || std::env::var_os("DOHC_ENGINE_OWNER_HOST_CONFIG").is_some())
    {
        return Err(io::Error::other("passive daemon takes no live host configuration").into());
    }
    if std::env::var_os("DOHC_ENGINE_LIVE_HOST_CONFIG").is_some()
        && std::env::var_os("DOHC_ENGINE_OWNER_HOST_CONFIG").is_some()
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "dedicated and ordinary live host configurations are mutually exclusive",
        )
        .into());
    }
    let mut reader = reader_config(
        replica,
        std::env::var_os("DOHC_ENGINE_READER_CONFIG"),
        |message| eprintln!("{message}"),
    );
    let (service, live) = match std::env::var_os("DOHC_ENGINE_LIVE_HOST_CONFIG") {
        Some(path) => {
            let config = ConfiguredLiveHostConfig::read(std::path::Path::new(&path))?;
            let service = EngineService::new();
            if let Some(config) = reader.take() {
                service.configure_reader(config);
            }
            let (service, owner, ingress) = service.configure_live_host(config).await?;
            (service, Some((owner, ingress)))
        }
        None => match std::env::var_os("DOHC_ENGINE_OWNER_HOST_CONFIG") {
            Some(path) => {
                let config = dohc_workspace_engine::OrdinaryLiveHostConfig::read(
                    std::path::Path::new(&path),
                )?;
                let (service, owner, ingress) = EngineService::ordinary_live_host(config)?;
                (service, Some((owner, ingress)))
            }
            None => {
                let service = Arc::new(if replica {
                    EngineService::replica(&std::env::current_dir()?)?
                } else {
                    EngineService::new()
                });
                let live = passive_ingress(service.clone(), passive)?;
                (service, live)
            }
        },
    };
    if let Some(config) = reader {
        service.configure_reader(config);
    }
    let supervisor = Arc::new(Supervisor::new(
        SupervisorConfig::default(),
        service.clone(),
    ));
    let transport = run_transport_with_live(
        auth_token,
        tokio::io::stdin(),
        tokio::io::stdout(),
        supervisor,
        service.events().subscribe_with_wakes(),
        || WorkspaceSupervisor::global().close_all(),
        live,
    )
    .await;
    // Earlier stores open for recovery close, and their copies go.
    service.close_recovery_stores().await;
    // Store actors are closed by the hook above; any in-flight capture write
    // failed contained and stays un-acked (the next start re-offers it). This
    // drain joins the watcher/files threads so the process exits clean.
    service.shutdown_all_capture().await;
    transport?;
    Ok(())
}

fn reader_config(
    replica: bool,
    value: Option<std::ffi::OsString>,
    warn: impl FnOnce(&str),
) -> Option<dohc_engine_reader::Config> {
    if replica {
        return None;
    }
    let value = value?;
    let config = value
        .to_str()
        .and_then(|value| serde_json::from_str(value).ok());
    if config.is_none() {
        warn("Invalid DOHC_ENGINE_READER_CONFIG; Markdown reader unavailable.");
    }
    config
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
        events_rx.into(),
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
    mut events_rx: dohc_workspace_engine::EngineEventReceiver,
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
    let active_egress: ActiveEgress = Arc::default();
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
    // because the daemon's ydoc.remoteUpdate notices only ask for a resync
    // and carry no update, and ydocLiveAdapter.receiveEvent reads those
    // before its gap rule. That rule marks a session stale on any gap between
    // consecutive ydoc.remoteUpdate seqs and filters by name first, so
    // interleaved events would read as gaps. A daemon notice that carries an
    // update needs its own per-session sequencing (or the adapter's gap rule
    // must learn about the shared stream) before reusing this counter.
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
                        Ok(Some(UploadCompletion::Admitted(request, input))) => {
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
                                negotiated_capabilities.contains(PROGRESS_CAPABILITY),
                                negotiated_max_frame_bytes,
                                Some(connection.handle()),
                                Some(input),
                            )
                            .await
                            {
                                keep_running = false;
                            }
                        }
                        Ok(Some(UploadCompletion::Refused(id, error))) => {
                            lock(&active_requests).remove(&id);
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
                                "replica.applyJournalPage"
                                    | "liveApplication.apply"
                                    | "ydoc.ownerDelivery.applyAcceptedFrame"
                                    | "ydoc.ownerDelivery.applyInitialSync"
                                    | "ydoc.ownerDelivery.enroll"
                                    | "ydoc.ownerDelivery.appendDraft"
                                    | "liveApplication.bootstrap"
                                    | "liveApplication.adoptOwner"
                                    | "liveApplication.prepareRestore"
                                    | "liveApplication.syncOpen"
                                    | "liveApplication.applyRestore"
                                    | "liveApplication.settleRestore"
                                    | "liveApplication.resumeRestore"
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
                    negotiated_capabilities.contains(PROGRESS_CAPABILITY),
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

/// The output still owed to each answered request, by request id, which keeps
/// the id in use until its output is written. A live acknowledgement's guard
/// signal is what a `Cancel` stops. A blob has none: its request answered, so
/// a later `Cancel` must not turn that answer into CANCELLED.
type ActiveEgress = Arc<Mutex<HashMap<u64, Option<CancelSignal>>>>;

async fn write_output<W: AsyncWrite + Unpin>(
    mut output: W,
    output_rx: &mut tokio::sync::mpsc::Receiver<OutputItem>,
    limits: &WireLimits,
    active_egress: ActiveEgress,
) -> Result<(), io::Error> {
    let mut negotiated_limits = limits.clone();
    'items: while let Some(item) = output_rx.recv().await {
        if let OutputItem::Envelope(Envelope::HelloAck(ack)) = &item {
            negotiated_limits = ack.limits.clone();
        }
        let limits = &negotiated_limits;
        match item {
            OutputItem::Guarded { response, guard } => {
                let request_id = response.id;
                let mut frame = encode_reply_or_limit_error(&Envelope::Response(response), limits)
                    .map_err(|error| io::Error::other(format!("response encode: {error:?}")))?;
                let length = frame.len();
                let last = [frame
                    .pop()
                    .ok_or_else(|| io::Error::other("empty response frame"))?];
                let cancel = guard.cancel_signal();
                let retired = guard.retirement_signal();
                let deadline = guard.deadline();
                // A Cancel withholds an acknowledgement only before its first
                // byte. A started frame must finish, or the broken stream ends
                // the connection, so the guard then ignores the Cancel. Every
                // poll still runs under the guard's own check: no byte goes
                // out once retirement, a workspace close, or the deadline has
                // ended the answer, except that a read's started frame
                // finishes unless its owner retired.
                let mut offset = 0;
                // Set once a read's started frame meets its deadline: it
                // finishes, and only retirement interrupts it.
                let mut finishing = false;
                loop {
                    let flushing = offset == length;
                    // The client cannot read the response before its last
                    // byte, so the frame and the reservations go just before it.
                    let bytes: &[u8] = if flushing {
                        &[]
                    } else if offset + 1 < length {
                        &frame[offset..]
                    } else {
                        frame = Vec::new();
                        guard.release();
                        &last[..]
                    };
                    let step = std::future::poll_fn(|cx| {
                        let mut result = std::task::Poll::Pending;
                        let mut poll = || {
                            let pinned = std::pin::Pin::new(&mut output);
                            result = if flushing {
                                pinned.poll_flush(cx).map(|result| result.map(|()| Some(0)))
                            } else {
                                pinned.poll_write(cx, bytes).map(|result| result.map(Some))
                            };
                        };
                        let admitted = if finishing {
                            guard.with_unretired(&mut poll)
                        } else {
                            guard.with_current(offset == 0, &mut poll)
                        };
                        if !admitted {
                            return std::task::Poll::Ready(Ok(None));
                        }
                        result
                    });
                    let mut interruption_kind = io::ErrorKind::ConnectionAborted;
                    let count = tokio::select! {
                        biased;
                        () = cancel.cancelled(), if offset == 0 => None,
                        () = retired.cancelled() => None,
                        () = async {
                            match deadline {
                                Some(deadline) => tokio::time::sleep_until(deadline.into()).await,
                                None => std::future::pending().await,
                            }
                        }, if !finishing => { interruption_kind = io::ErrorKind::TimedOut; None },
                        count = step => count?,
                    };
                    let Some(count) = count else {
                        if offset == 0 {
                            write_withheld_error(&mut output, &*guard, request_id, limits).await?;
                            lock(&active_egress).remove(&request_id);
                            continue 'items;
                        }
                        if !finishing && guard.withheld_error().is_some() {
                            finishing = true;
                            continue;
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
                    if flushing {
                        break;
                    }
                    if count == 0 {
                        return Err(io::Error::new(io::ErrorKind::WriteZero, "stdout closed"));
                    }
                    offset += count;
                }
                lock(&active_egress).remove(&request_id);
            }
            OutputItem::Progress(message) => {
                write_envelope(
                    &mut output,
                    &Envelope::Progress(Progress { id: message.id() }),
                    limits,
                )
                .await?;
            }
            OutputItem::Envelope(envelope) => {
                // A service-initiated event the wire cannot carry is dropped
                // here, with its name on stderr, instead of ending the
                // transport: delivery is at most once and the subscriber
                // reconciles from history. An oversized reply gets a bounded
                // error so its caller can continue using the connection.
                let bytes = match (encode_reply_or_limit_error(&envelope, limits), &envelope) {
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
                let outcome =
                    write_blob_egress(&mut output, response, egress, None, limits, || {}).await;
                lock(&active_egress).remove(&request_id);
                outcome?;
            }
            OutputItem::GuardedBlob {
                response,
                egress,
                guard,
            } => {
                let request_id = response.id;
                if !guard.is_current() {
                    write_withheld_error(&mut output, &*guard, request_id, limits).await?;
                    lock(&active_egress).remove(&request_id);
                    continue 'items;
                }
                let cancel = guard.cancel_signal();
                let retired = guard.retirement_signal();
                let deadline = guard.deadline();
                let mut fenced = GuardedBlobWriter {
                    output: &mut output,
                    guard: &guard,
                    cancelled: cancel.cancelled(),
                    expiry: deadline
                        .map(|deadline| Box::pin(tokio::time::sleep_until(deadline.into()))),
                    wrote: false,
                    frame_pending: false,
                };
                // Cancellation and the deadline end the stream between frames,
                // so the connection's other requests go on, and either wakes a
                // writer waiting to start one. Only retirement interrupts a
                // frame.
                let result = tokio::select! {
                    biased;
                    ()=retired.cancelled()=>Err(io::Error::new(io::ErrorKind::ConnectionAborted,"native restore output retired")),
                    result=write_blob_egress(&mut fenced,response,egress,Some(&*guard),limits,|| guard.release())=>result,
                };
                lock(&active_egress).remove(&request_id);
                if result.is_err() && !fenced.frame_pending && !guard.is_current() {
                    if fenced.wrote {
                        let error = if cancel.is_cancelled() {
                            WireError::new(ErrorCode::Cancelled, "native restore output cancelled")
                        } else if deadline
                            .is_some_and(|deadline| std::time::Instant::now() >= deadline)
                        {
                            WireError::new(
                                ErrorCode::DeadlineExceeded,
                                "native restore output expired",
                            )
                        } else {
                            WireError::new(
                                ErrorCode::WorkspaceUnavailable,
                                "native restore output retired",
                            )
                        };
                        // The interrupted write dropped the blob, and the
                        // client acts on this error, so the reservations go first.
                        guard.release();
                        write_envelope(
                            &mut output,
                            &Envelope::Error(ErrorEnvelope {
                                id: Some(request_id),
                                error,
                            }),
                            limits,
                        )
                        .await?;
                    } else {
                        write_withheld_error(&mut output, &*guard, request_id, limits).await?;
                    }
                    continue 'items;
                }
                result?;
            }
        }
    }
    Ok(())
}

fn response_limit_error(id: Option<u64>) -> Envelope {
    Envelope::Error(ErrorEnvelope {
        id,
        // Execution may have committed before encoding failed. Retrying a
        // mutation must retain its idempotency key; this is not input refusal.
        error: WireError {
            code: ErrorCode::Internal,
            message: "response-wire-limit-exceeded".to_owned(),
            retry: Retryability::AfterBackoff,
        },
    })
}

fn encode_reply_or_limit_error(
    envelope: &Envelope,
    limits: &WireLimits,
) -> Result<Vec<u8>, EnvelopeDecodeError> {
    match encode_control(envelope, limits) {
        Ok(bytes) => Ok(bytes),
        Err(error) => {
            let id = match envelope {
                Envelope::Response(response) => Some(response.id),
                Envelope::Error(error) => error.id,
                _ => return Err(error),
            };
            encode_control(&response_limit_error(id), limits)
        }
    }
}

async fn write_envelope<W: AsyncWrite + Unpin>(
    output: &mut W,
    envelope: &Envelope,
    limits: &WireLimits,
) -> Result<(), io::Error> {
    let bytes = encode_reply_or_limit_error(envelope, limits)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "response too large"))?;
    output.write_all(&bytes).await?;
    output.flush().await
}

/// Answers request `request_id` with what `guard` sends in place of output it
/// no longer admits, if anything.
async fn write_withheld_error<W: AsyncWrite + Unpin>(
    output: &mut W,
    guard: &dyn OutputGuard,
    request_id: u64,
    limits: &WireLimits,
) -> Result<(), io::Error> {
    let Some(error) = guard.withheld_error() else {
        return Ok(());
    };
    write_envelope(
        output,
        &Envelope::Error(ErrorEnvelope {
            id: Some(request_id),
            error,
        }),
        limits,
    )
    .await
}

struct GuardedBlobWriter<'a, W> {
    output: &'a mut W,
    guard: &'a Arc<dyn OutputGuard>,
    /// Wakes a writer waiting to start a frame when its request is cancelled.
    cancelled: Cancelled,
    /// Wakes a writer waiting to start a frame once the guard's deadline
    /// passes.
    expiry: Option<std::pin::Pin<Box<tokio::time::Sleep>>>,
    wrote: bool,
    /// Bytes from the current frame remain unflushed.
    frame_pending: bool,
}
impl<W: AsyncWrite + Unpin> AsyncWrite for GuardedBlobWriter<'_, W> {
    fn poll_write(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        bytes: &[u8],
    ) -> std::task::Poll<Result<usize, io::Error>> {
        let this = self.get_mut();
        let cancellable = !this.frame_pending;
        if cancellable {
            let _ = std::future::Future::poll(std::pin::Pin::new(&mut this.cancelled), cx);
            if let Some(expiry) = &mut this.expiry {
                let _ = std::future::Future::poll(expiry.as_mut(), cx);
            }
        }
        let mut result = std::task::Poll::Pending;
        let mut poll = || {
            result = std::pin::Pin::new(&mut *this.output).poll_write(cx, bytes);
        };
        // A frame's first byte waits for every check; a frame under way
        // stops only once its owner retired.
        let admitted = if cancellable {
            this.guard.with_current(true, &mut poll)
        } else {
            this.guard.with_unretired(&mut poll)
        };
        if !admitted {
            return std::task::Poll::Ready(Err(io::Error::new(
                io::ErrorKind::ConnectionAborted,
                "native restore output retired",
            )));
        }
        if matches!(&result,std::task::Poll::Ready(Ok(count)) if *count>0) {
            this.wrote = true;
            this.frame_pending = true;
        }
        result
    }
    fn poll_flush(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Result<(), io::Error>> {
        let this = self.get_mut();
        let mut result = std::task::Poll::Pending;
        if !this.guard.with_unretired(&mut || {
            result = std::pin::Pin::new(&mut *this.output).poll_flush(cx);
        }) {
            return std::task::Poll::Ready(Err(io::Error::new(
                io::ErrorKind::ConnectionAborted,
                "native restore output retired",
            )));
        }
        if matches!(result, std::task::Poll::Ready(Ok(()))) {
            this.frame_pending = false;
        }
        result
    }
    fn poll_shutdown(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Result<(), io::Error>> {
        self.poll_flush(cx)
    }
}

/// Streams `egress` and then `response`. Before each frame it stops, with an
/// error envelope, once the request or its `guard` was cancelled or expired;
/// a `guard` no longer current for another reason ends it with an error.
async fn write_blob_egress<W: AsyncWrite + Unpin>(
    output: &mut W,
    response: Response,
    egress: BlobEgress,
    guard: Option<&dyn OutputGuard>,
    limits: &WireLimits,
    release: impl FnOnce(),
) -> Result<(), io::Error> {
    let request_id = response.id;
    let interrupted = |egress: &BlobEgress| -> Result<Option<Envelope>, io::Error> {
        let expired = |deadline: Option<std::time::Instant>| {
            deadline.is_some_and(|deadline| std::time::Instant::now() >= deadline)
        };
        let error =
            if expired(egress.deadline) || guard.is_some_and(|guard| expired(guard.deadline())) {
                WireError::new(
                    ErrorCode::DeadlineExceeded,
                    "versionedBinary.readBlob egress deadline elapsed",
                )
            } else if egress.cancel.is_cancelled()
                || guard.is_some_and(|guard| guard.cancel_signal().is_cancelled())
            {
                WireError::new(
                    ErrorCode::Cancelled,
                    "versionedBinary.readBlob egress cancelled",
                )
            } else if guard.is_some_and(|guard| !guard.is_current()) {
                return Err(io::Error::new(
                    io::ErrorKind::ConnectionAborted,
                    "native restore output retired",
                ));
            } else {
                return Ok(None);
            };
        Ok(Some(Envelope::Error(ErrorEnvelope {
            id: Some(request_id),
            error,
        })))
    };
    let encode = |envelope: &Envelope| {
        encode_reply_or_limit_error(envelope, limits)
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "response too large"))
    };
    // The client finishes the request on the frame after the blob, its
    // response or an error, so the blob and the reservations go before it.
    let last = 'blob: {
        if let Some(error) = interrupted(&egress)? {
            break 'blob encode(&error)?;
        }
        let Ok(response_frame) = encode_control(&Envelope::Response(response), limits) else {
            break 'blob encode(&response_limit_error(Some(request_id)))?;
        };
        write_envelope(
            output,
            &Envelope::BlobStart(BlobStart {
                request_id,
                stream_id: egress.stream_id,
                total_bytes: Some(egress.bytes.len() as u64),
                sha256: Some(egress.sha256.clone()),
            }),
            limits,
        )
        .await?;
        let chunk_bytes = limits.max_blob_chunk_bytes as usize;
        for (fin, chunk) in blob_chunks(&egress.bytes, chunk_bytes) {
            if let Some(error) = interrupted(&egress)? {
                break 'blob encode(&error)?;
            }
            let frame = encode_blob_chunk_frame(egress.stream_id, fin, chunk, limits)
                .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "blob chunk too large"))?;
            output.write_all(&frame).await?;
            output.flush().await?;
        }
        response_frame
    };
    drop(egress);
    release();
    output.write_all(&last).await?;
    output.flush().await
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
        .filter(|capability| capability == "blobs" || capability == PROGRESS_CAPABILITY)
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
    active_egress: &ActiveEgress,
    request_tasks: &mut JoinSet<()>,
    blobs_negotiated: bool,
    progress_negotiated: bool,
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
            // Only a request that asked, on a session that negotiated it, pays
            // for progress. The sink holds a weak sender: a request that
            // outlives the writer cannot keep the output queue open.
            let progress = if request.progress && progress_negotiated {
                let output = output.downgrade();
                ProgressSink::new(id, move |message| {
                    if let Some(output) = output.upgrade() {
                        // A full queue drops the message, which lets the
                        // request report again later.
                        let _ = output.try_send(OutputItem::Progress(message));
                    }
                })
            } else {
                ProgressSink::default()
            };
            let finish_progress = progress.clone();
            let completion_egress = Arc::clone(active_egress);
            match supervisor.try_submit_input(
                request,
                capabilities,
                max_frame_bytes,
                connection,
                input,
                progress,
                move |outcome| {
                    // Before the terminal response is queued, so no progress
                    // message can follow it.
                    finish_progress.finish();
                    // The handoff runs before the supervisor drops its cancel
                    // registration. Cancel therefore always reaches either the
                    // request signal, this guard signal, or both.
                    if let Ok(service_response) = outcome {
                        if let Some(guard) = &service_response.output_guard {
                            lock(&completion_egress).insert(id, Some(guard.cancel_signal()));
                        } else if blobs_negotiated && service_response.blob_egress.is_some() {
                            lock(&completion_egress).insert(id, None);
                        }
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
                                    match service_response.blob_egress.take() {
                                        Some(egress) if blobs_negotiated => {
                                            OutputItem::GuardedBlob {
                                                response: service_response.response,
                                                egress,
                                                guard,
                                            }
                                        }
                                        Some(_) => {
                                            OutputItem::Envelope(Envelope::Error(ErrorEnvelope {
                                                id: Some(service_response.response.id),
                                                error: WireError::new(
                                                    ErrorCode::InvalidParams,
                                                    "blob-capability-required",
                                                ),
                                            }))
                                        }
                                        None => OutputItem::Guarded {
                                            response: service_response.response,
                                            guard,
                                        },
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
            if let Some(Some(signal)) = lock(active_egress).get(&cancel.id) {
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
        Envelope::Response(_) | Envelope::Error(_) | Envelope::Event(_) | Envelope::Progress(_) => {
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
    #[test]
    fn replica_startup_ignores_reader_environment() {
        for value in [
            "invalid",
            r#"{"node":"/runtime/node","bundle":"/reader/reader.cjs","manifest":"/reader/manifest.json"}"#,
        ] {
            assert!(
                super::reader_config(true, Some(value.into()), |_| {
                    panic!("replica must not parse reader configuration")
                })
                .is_none()
            );
        }
    }

    #[test]
    fn reader_environment_is_optional_and_invalid_values_warn_once() {
        let mut warnings = Vec::new();
        assert!(
            super::reader_config(false, None, |message| warnings.push(message.to_owned()))
                .is_none()
        );
        assert!(warnings.is_empty());
        let valid = r#"{"node":"/runtime/node","bundle":"/reader/reader.cjs","manifest":"/reader/manifest.json"}"#;
        let config =
            super::reader_config(false, Some(valid.into()), |_| panic!("valid config warned"))
                .unwrap();
        assert_eq!(config.bundle, std::path::Path::new("/reader/reader.cjs"));
        for value in [
            "",
            "secret invalid JSON",
            "{}",
            r#"{"node":"a","bundle":"b","manifest":"c","extra":true}"#,
        ] {
            warnings.clear();
            assert!(
                super::reader_config(false, Some(value.into()), |message| warnings
                    .push(message.to_owned()))
                .is_none()
            );
            assert_eq!(
                warnings,
                ["Invalid DOHC_ENGINE_READER_CONFIG; Markdown reader unavailable."]
            );
        }
        #[cfg(unix)]
        {
            use std::os::unix::ffi::OsStringExt;
            warnings.clear();
            assert!(
                super::reader_config(
                    false,
                    Some(std::ffi::OsString::from_vec(vec![255])),
                    |message| { warnings.push(message.to_owned()) }
                )
                .is_none()
            );
            assert_eq!(warnings.len(), 1);
        }
    }
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

    #[test]
    fn desktop_daemon_keeps_live_upload_methods_on_dispatch() {
        assert!(
            passive_ingress(Arc::new(EngineService::new()), false)
                .unwrap()
                .is_none()
        );
        assert!(
            passive_ingress(Arc::new(EngineService::new()), true)
                .unwrap()
                .is_some()
        );
    }

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
                no_events().into(),
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
                    progress: false,
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
        /// For a held read's answer rather than an acknowledgement, the
        /// connection it goes to, which ends when cancelled.
        read_connection: Option<CancelSignal>,
    }

    impl Drop for TestOutputGuard {
        fn drop(&mut self) {
            self.dropped.store(true, Ordering::SeqCst);
        }
    }

    impl OutputGuard for TestOutputGuard {
        fn is_current_ignoring_cancel(&self) -> bool {
            !self.retired.is_cancelled()
                && self
                    .deadline
                    .is_none_or(|deadline| std::time::Instant::now() < deadline)
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
        // As the live host's guard: a frame under way finishes unless its owner retired.
        fn with_unretired(&self, action: &mut dyn FnMut()) -> bool {
            if self.retired.is_cancelled() {
                return false;
            }
            action();
            true
        }
        // As the live host's read guard.
        fn withheld_error(&self) -> Option<WireError> {
            if self
                .read_connection
                .as_ref()
                .is_none_or(CancelSignal::is_cancelled)
            {
                return None;
            }
            if self.retired.is_cancelled() {
                return Some(WireError::new(ErrorCode::WorkspaceUnavailable, "retired"));
            }
            if self
                .deadline
                .is_some_and(|deadline| std::time::Instant::now() >= deadline)
            {
                return Some(WireError::new(ErrorCode::DeadlineExceeded, "expired"));
            }
            self.cancel
                .is_cancelled()
                .then(|| WireError::new(ErrorCode::Cancelled, "cancelled"))
        }
    }

    struct BlockedWriter {
        polled: Arc<Notify>,
        flush_only: bool,
        bytes: Arc<AtomicUsize>,
    }

    fn guarded_blob(guard: Arc<dyn OutputGuard>) -> OutputItem {
        let bytes = vec![42; 512 * 1024];
        OutputItem::GuardedBlob {
            response: WireResponse {
                id: 9,
                result: serde_json::json!({"status":"prepared"}),
            },
            egress: BlobEgress {
                stream_id: 9,
                sha256: dohc_engine_storage::hex_sha256(&bytes),
                bytes,
                cancel: guard.cancel_signal(),
                deadline: guard.deadline(),
                byte_permit: None,
            },
            guard,
        }
    }

    struct InterruptAfterFrame<W> {
        output: W,
        completed: usize,
        interrupt_after: usize,
        interrupt: CancelSignal,
        deadline: Option<std::time::Instant>,
    }

    impl<W: AsyncWrite + Unpin> AsyncWrite for InterruptAfterFrame<W> {
        fn poll_write(
            mut self: Pin<&mut Self>,
            cx: &mut TaskContext<'_>,
            bytes: &[u8],
        ) -> Poll<io::Result<usize>> {
            Pin::new(&mut self.output).poll_write(cx, bytes)
        }
        fn poll_flush(mut self: Pin<&mut Self>, cx: &mut TaskContext<'_>) -> Poll<io::Result<()>> {
            let result = Pin::new(&mut self.output).poll_flush(cx);
            if matches!(result, Poll::Ready(Ok(()))) {
                self.completed += 1;
                if self.completed == self.interrupt_after {
                    if let Some(deadline) = self.deadline {
                        // Expire inside the successful flush poll so the guard admits no later bytes.
                        while std::time::Instant::now() < deadline {
                            std::thread::yield_now();
                        }
                    } else {
                        self.interrupt.cancel();
                    }
                }
            }
            result
        }
        fn poll_shutdown(
            mut self: Pin<&mut Self>,
            cx: &mut TaskContext<'_>,
        ) -> Poll<io::Result<()>> {
            Pin::new(&mut self.output).poll_shutdown(cx)
        }
    }

    #[tokio::test]
    async fn guarded_blob_interruption_after_complete_frames_preserves_following_response() {
        for interrupt_after in [1, 2] {
            for expected in [
                ErrorCode::Cancelled,
                ErrorCode::WorkspaceUnavailable,
                ErrorCode::DeadlineExceeded,
            ] {
                let cancel = CancelSignal::new();
                let retired = CancelSignal::new();
                let dropped = Arc::new(AtomicBool::new(false));
                let deadline = (expected == ErrorCode::DeadlineExceeded)
                    .then(|| std::time::Instant::now() + Duration::from_secs(1));
                let guard = Arc::new(TestOutputGuard {
                    cancel: cancel.clone(),
                    retired: retired.clone(),
                    deadline,
                    dropped: dropped.clone(),
                    read_connection: None,
                });
                let (tx, mut rx) = tokio::sync::mpsc::channel(2);
                tx.send(guarded_blob(guard)).await.unwrap();
                tx.send(OutputItem::Envelope(Envelope::Response(WireResponse {
                    id: 10,
                    result: serde_json::json!({ "ok": true }),
                })))
                .await
                .unwrap();
                drop(tx);
                let active = Arc::new(Mutex::new(HashMap::from([(9, Some(cancel.clone()))])));
                let (writer, mut reader) = tokio::io::duplex(4096);
                let output = InterruptAfterFrame {
                    output: writer,
                    completed: 0,
                    interrupt_after,
                    interrupt: if expected == ErrorCode::WorkspaceUnavailable {
                        retired
                    } else {
                        cancel
                    },
                    deadline,
                };
                let limits = WireLimits {
                    max_blob_chunk_bytes: 1024,
                    ..WireLimits::default()
                };
                let task_limits = limits.clone();
                let task_active = active.clone();
                let task = tokio::spawn(async move {
                    write_output(output, &mut rx, &task_limits, task_active).await
                });
                let mut transcript = Vec::new();
                reader.read_to_end(&mut transcript).await.unwrap();
                task.await
                    .unwrap()
                    .expect("a complete frame permits request-scoped interruption");
                assert!(dropped.load(Ordering::SeqCst));
                assert!(lock(&active).is_empty());
                let mut decoder = FrameDecoder::new(limits.clone());
                decoder.push(&transcript);
                let Some(Frame::Control(payload)) = decoder.next_frame().unwrap() else {
                    panic!("BlobStart missing");
                };
                assert!(
                    matches!(decode_control(&payload, &limits).unwrap(), Envelope::BlobStart(start) if start.request_id == 9)
                );
                if interrupt_after == 2 {
                    let Some(Frame::BlobChunk {
                        stream_id,
                        fin,
                        bytes,
                    }) = decoder.next_frame().unwrap()
                    else {
                        panic!("completed chunk missing");
                    };
                    assert_eq!(stream_id, 9);
                    assert!(!fin);
                    assert_eq!(bytes, vec![42; limits.max_blob_chunk_bytes as usize]);
                }
                let Some(Frame::Control(payload)) = decoder.next_frame().unwrap() else {
                    panic!("request interruption missing");
                };
                let Envelope::Error(error) = decode_control(&payload, &limits).unwrap() else {
                    panic!("blob data continued after interruption");
                };
                assert_eq!(error.id, Some(9));
                assert_eq!(error.error.code, expected);
                let Some(Frame::Control(payload)) = decoder.next_frame().unwrap() else {
                    panic!("following response missing");
                };
                assert!(
                    matches!(decode_control(&payload, &limits).unwrap(), Envelope::Response(response) if response.id == 10 && response.result["ok"] == true)
                );
                assert!(decoder.next_frame().unwrap().is_none());
            }
        }
    }

    #[tokio::test]
    async fn guarded_blob_interruption_during_terminal_flush_preserves_success() {
        for interruption in [
            ErrorCode::Cancelled,
            ErrorCode::WorkspaceUnavailable,
            ErrorCode::DeadlineExceeded,
        ] {
            let cancel = CancelSignal::new();
            let retired = CancelSignal::new();
            let dropped = Arc::new(AtomicBool::new(false));
            let deadline = (interruption == ErrorCode::DeadlineExceeded)
                .then(|| std::time::Instant::now() + Duration::from_secs(1));
            let guard = Arc::new(TestOutputGuard {
                cancel: cancel.clone(),
                retired: retired.clone(),
                deadline,
                dropped: dropped.clone(),
                read_connection: None,
            });
            let (tx, mut rx) = tokio::sync::mpsc::channel(2);
            tx.send(guarded_blob(guard)).await.unwrap();
            tx.send(OutputItem::Envelope(Envelope::Response(WireResponse {
                id: 10,
                result: serde_json::json!({ "ok": true }),
            })))
            .await
            .unwrap();
            drop(tx);
            let active = Arc::new(Mutex::new(HashMap::from([(9, Some(cancel.clone()))])));
            let limits = WireLimits {
                max_blob_chunk_bytes: 512 * 1024,
                ..WireLimits::default()
            };
            let mut transcript = Vec::new();
            let output = InterruptAfterFrame {
                output: &mut transcript,
                completed: 0,
                // BlobStart, one FIN chunk, then the terminal Response.
                interrupt_after: 3,
                interrupt: if interruption == ErrorCode::WorkspaceUnavailable {
                    retired
                } else {
                    cancel
                },
                deadline,
            };
            write_output(output, &mut rx, &limits, active.clone())
                .await
                .expect("a successful terminal flush completes the request");
            assert!(dropped.load(Ordering::SeqCst));
            assert!(lock(&active).is_empty());
            let mut decoder = FrameDecoder::new(limits.clone());
            decoder.push(&transcript);
            let Some(Frame::Control(payload)) = decoder.next_frame().unwrap() else {
                panic!("BlobStart missing");
            };
            assert!(
                matches!(decode_control(&payload, &limits).unwrap(), Envelope::BlobStart(start) if start.request_id == 9)
            );
            let Some(Frame::BlobChunk {
                stream_id,
                fin,
                bytes,
            }) = decoder.next_frame().unwrap()
            else {
                panic!("completed blob missing");
            };
            assert_eq!(stream_id, 9);
            assert!(fin);
            assert_eq!(bytes, vec![42; 512 * 1024]);
            let Some(Frame::Control(payload)) = decoder.next_frame().unwrap() else {
                panic!("terminal response missing");
            };
            assert!(
                matches!(decode_control(&payload, &limits).unwrap(), Envelope::Response(response) if response.id == 9 && response.result["status"] == "prepared")
            );
            let Some(Frame::Control(payload)) = decoder.next_frame().unwrap() else {
                panic!("following response missing");
            };
            assert!(
                matches!(decode_control(&payload, &limits).unwrap(), Envelope::Response(response) if response.id == 10 && response.result["ok"] == true)
            );
            assert!(decoder.next_frame().unwrap().is_none());
        }
    }

    #[tokio::test]
    async fn guarded_blob_cancel_during_partial_frame_stops_at_frame_boundary() {
        for flushing in [false, true] {
            let cancel = CancelSignal::new();
            let dropped = Arc::new(AtomicBool::new(false));
            let (tx, mut rx) = tokio::sync::mpsc::channel(2);
            tx.send(guarded_blob(Arc::new(TestOutputGuard {
                cancel: cancel.clone(),
                retired: CancelSignal::new(),
                deadline: None,
                dropped: dropped.clone(),
                read_connection: None,
            })))
            .await
            .unwrap();
            tx.send(OutputItem::Envelope(Envelope::Response(WireResponse {
                id: 10,
                result: serde_json::Value::Null,
            })))
            .await
            .unwrap();
            drop(tx);
            let active = Arc::new(Mutex::new(HashMap::from([(9, Some(cancel.clone()))])));
            let limits = WireLimits {
                max_blob_chunk_bytes: 1024,
                ..WireLimits::default()
            };
            let (writer, mut reader) = eight_byte_pipe(flushing);
            let writer_limits = limits.clone();
            let writer_active = active.clone();
            let task = tokio::spawn(async move {
                write_output(writer, &mut rx, &writer_limits, writer_active).await
            });
            // Cancel once the first chunk's first byte is out.
            let header_len = dohc_engine_protocol::frame::FRAME_HEADER_LEN;
            let mut transcript = vec![0; header_len];
            reader.read_exact(&mut transcript).await.unwrap();
            let start_len =
                header_len + u32::from_le_bytes(transcript[8..12].try_into().unwrap()) as usize;
            transcript.resize(start_len + 1, 0);
            reader
                .read_exact(&mut transcript[header_len..])
                .await
                .unwrap();
            cancel.cancel();
            reader.read_to_end(&mut transcript).await.unwrap();
            task.await
                .unwrap()
                .expect("a Cancel lets the started frame finish");
            assert!(dropped.load(Ordering::SeqCst));
            assert!(lock(&active).is_empty());
            let mut decoder = FrameDecoder::new(limits.clone());
            decoder.push(&transcript);
            let Some(Frame::Control(payload)) = decoder.next_frame().unwrap() else {
                panic!("BlobStart missing");
            };
            assert!(
                matches!(decode_control(&payload, &limits).unwrap(), Envelope::BlobStart(start) if start.request_id == 9)
            );
            let Some(Frame::BlobChunk {
                stream_id,
                fin,
                bytes,
            }) = decoder.next_frame().unwrap()
            else {
                panic!("started chunk missing");
            };
            assert_eq!(stream_id, 9);
            assert!(!fin);
            assert_eq!(bytes, vec![42; limits.max_blob_chunk_bytes as usize]);
            let Some(Frame::Control(payload)) = decoder.next_frame().unwrap() else {
                panic!("request interruption missing");
            };
            let Envelope::Error(error) = decode_control(&payload, &limits).unwrap() else {
                panic!("blob data continued after the started chunk");
            };
            assert_eq!(error.id, Some(9));
            assert_eq!(error.error.code, ErrorCode::Cancelled);
            let Some(Frame::Control(payload)) = decoder.next_frame().unwrap() else {
                panic!("following response missing");
            };
            assert!(
                matches!(decode_control(&payload, &limits).unwrap(), Envelope::Response(response) if response.id == 10)
            );
            assert!(decoder.next_frame().unwrap().is_none());
        }
    }

    #[tokio::test]
    async fn guarded_blob_retirement_during_partial_frame_closes_output() {
        for cancelled in [false, true] {
            let cancel = CancelSignal::new();
            let retired = CancelSignal::new();
            let (tx, mut rx) = tokio::sync::mpsc::channel(2);
            tx.send(guarded_blob(Arc::new(TestOutputGuard {
                cancel: cancel.clone(),
                retired: retired.clone(),
                deadline: None,
                dropped: Arc::new(AtomicBool::new(false)),
                read_connection: None,
            })))
            .await
            .unwrap();
            tx.send(OutputItem::Envelope(Envelope::Response(WireResponse {
                id: 10,
                result: serde_json::Value::Null,
            })))
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
            if cancelled {
                cancel.cancel();
            }
            retired.cancel();
            assert_eq!(
                task.await.unwrap().unwrap_err().kind(),
                io::ErrorKind::ConnectionAborted
            );
            let mut transcript = prefix.to_vec();
            reader.read_to_end(&mut transcript).await.unwrap();
            let mut decoder = FrameDecoder::new(WireLimits::default());
            decoder.push(&transcript);
            assert!(
                decoder.next_frame().unwrap().is_none(),
                "partial frame must not be followed by another envelope"
            );
        }
    }

    /// Writes the first frame after `interrupt_after` complete ones in two
    /// parts: it interrupts after the first, then reports a full pipe once,
    /// as a slow reader makes the writer wait mid-frame.
    struct InterruptMidFrame<W> {
        output: W,
        completed: usize,
        interrupt_after: usize,
        interrupted: bool,
        waited: bool,
        interrupt: CancelSignal,
        deadline: Option<std::time::Instant>,
    }

    impl<W: AsyncWrite + Unpin> AsyncWrite for InterruptMidFrame<W> {
        fn poll_write(
            mut self: Pin<&mut Self>,
            cx: &mut TaskContext<'_>,
            bytes: &[u8],
        ) -> Poll<io::Result<usize>> {
            if self.completed < self.interrupt_after || self.waited {
                return Pin::new(&mut self.output).poll_write(cx, bytes);
            }
            if self.interrupted {
                self.waited = true;
                cx.waker().wake_by_ref();
                return Poll::Pending;
            }
            let half = bytes.len().div_ceil(2);
            let written = Pin::new(&mut self.output).poll_write(cx, &bytes[..half]);
            if matches!(written, Poll::Ready(Ok(_))) {
                self.interrupted = true;
                if let Some(deadline) = self.deadline {
                    while std::time::Instant::now() < deadline {
                        std::thread::yield_now();
                    }
                } else {
                    self.interrupt.cancel();
                }
            }
            written
        }
        fn poll_flush(mut self: Pin<&mut Self>, cx: &mut TaskContext<'_>) -> Poll<io::Result<()>> {
            let result = Pin::new(&mut self.output).poll_flush(cx);
            if matches!(result, Poll::Ready(Ok(()))) {
                self.completed += 1;
            }
            result
        }
        fn poll_shutdown(
            mut self: Pin<&mut Self>,
            cx: &mut TaskContext<'_>,
        ) -> Poll<io::Result<()>> {
            Pin::new(&mut self.output).poll_shutdown(cx)
        }
    }

    // A held contributions request cancelled, or past its deadline, mid-frame
    // finishes that frame and ends with its own error; the connection's next
    // answer still arrives. A lost owner still stops it mid-frame.
    #[tokio::test]
    async fn guarded_blob_cancel_or_deadline_mid_frame_ends_only_that_request() {
        for interruption in [
            ErrorCode::Cancelled,
            ErrorCode::DeadlineExceeded,
            ErrorCode::WorkspaceUnavailable,
        ] {
            let cancel = CancelSignal::new();
            let retired = CancelSignal::new();
            let dropped = Arc::new(AtomicBool::new(false));
            let deadline = (interruption == ErrorCode::DeadlineExceeded)
                .then(|| std::time::Instant::now() + Duration::from_secs(1));
            let guard = Arc::new(TestOutputGuard {
                cancel: cancel.clone(),
                retired: retired.clone(),
                deadline,
                dropped: dropped.clone(),
                read_connection: None,
            });
            let (tx, mut rx) = tokio::sync::mpsc::channel(2);
            tx.send(guarded_blob(guard)).await.unwrap();
            tx.send(OutputItem::Envelope(Envelope::Response(WireResponse {
                id: 10,
                result: serde_json::json!({ "ok": true }),
            })))
            .await
            .unwrap();
            drop(tx);
            let active = Arc::new(Mutex::new(HashMap::from([(9, Some(cancel.clone()))])));
            let limits = WireLimits {
                max_blob_chunk_bytes: 1024,
                ..WireLimits::default()
            };
            let mut transcript = Vec::new();
            let output = InterruptMidFrame {
                output: &mut transcript,
                completed: 0,
                // BlobStart whole, then the first chunk interrupted halfway.
                interrupt_after: 1,
                interrupted: false,
                waited: false,
                interrupt: if interruption == ErrorCode::WorkspaceUnavailable {
                    retired
                } else {
                    cancel
                },
                deadline,
            };
            let written = write_output(output, &mut rx, &limits, active.clone()).await;
            assert!(dropped.load(Ordering::SeqCst));
            let mut decoder = FrameDecoder::new(limits.clone());
            decoder.push(&transcript);
            let Some(Frame::Control(payload)) = decoder.next_frame().unwrap() else {
                panic!("BlobStart missing");
            };
            assert!(
                matches!(decode_control(&payload, &limits).unwrap(), Envelope::BlobStart(start) if start.request_id == 9)
            );
            if interruption == ErrorCode::WorkspaceUnavailable {
                assert_eq!(
                    written.unwrap_err().kind(),
                    io::ErrorKind::ConnectionAborted
                );
                assert!(
                    decoder.next_frame().unwrap().is_none(),
                    "partial frame must not be followed by another envelope"
                );
                continue;
            }
            written.expect("a request-scoped interruption leaves the connection writing");
            assert!(lock(&active).is_empty());
            let Some(Frame::BlobChunk {
                stream_id,
                fin,
                bytes,
            }) = decoder.next_frame().unwrap()
            else {
                panic!("interrupted chunk did not finish");
            };
            assert_eq!(stream_id, 9);
            assert!(!fin);
            assert_eq!(bytes, vec![42; limits.max_blob_chunk_bytes as usize]);
            let Some(Frame::Control(payload)) = decoder.next_frame().unwrap() else {
                panic!("request interruption missing");
            };
            let Envelope::Error(error) = decode_control(&payload, &limits).unwrap() else {
                panic!("blob data continued after interruption");
            };
            assert_eq!(error.id, Some(9));
            assert_eq!(error.error.code, interruption);
            let Some(Frame::Control(payload)) = decoder.next_frame().unwrap() else {
                panic!("following response missing");
            };
            assert!(
                matches!(decode_control(&payload, &limits).unwrap(), Envelope::Response(response) if response.id == 10 && response.result["ok"] == true)
            );
            assert!(decoder.next_frame().unwrap().is_none());
        }
    }

    #[tokio::test]
    async fn guarded_blob_releases_reservation_on_cancelled_write_and_flush() {
        for flush_only in [false, true] {
            for retire in [false, true] {
                if flush_only && !retire {
                    // A Cancel lets a started flush finish.
                    // `guarded_blob_cancel_during_partial_frame_stops_at_frame_boundary` covers it.
                    continue;
                }
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
                    read_connection: None,
                });
                let (tx, mut rx) = tokio::sync::mpsc::channel(1);
                tx.send(guarded_blob(guard)).await.unwrap();
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
                assert!(!dropped.load(Ordering::SeqCst));
                if retire {
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
                    assert_eq!(bytes.load(Ordering::SeqCst), 0);
                }
                assert!(dropped.load(Ordering::SeqCst));
            }
        }
    }

    /// Leaves its first write waiting with nothing to wake it, as a client
    /// that stopped reading leaves a full pipe, then writes through.
    struct StalledFirstWrite {
        output: Vec<u8>,
        deadline: std::time::Instant,
        /// Set by the first write: whether it waited before `deadline`.
        waited_in_time: Option<bool>,
    }

    impl AsyncWrite for StalledFirstWrite {
        fn poll_write(
            mut self: Pin<&mut Self>,
            cx: &mut TaskContext<'_>,
            bytes: &[u8],
        ) -> Poll<io::Result<usize>> {
            if self.waited_in_time.is_none() {
                self.waited_in_time = Some(std::time::Instant::now() < self.deadline);
                return Poll::Pending;
            }
            Pin::new(&mut self.output).poll_write(cx, bytes)
        }
        fn poll_flush(mut self: Pin<&mut Self>, cx: &mut TaskContext<'_>) -> Poll<io::Result<()>> {
            Pin::new(&mut self.output).poll_flush(cx)
        }
        fn poll_shutdown(
            mut self: Pin<&mut Self>,
            cx: &mut TaskContext<'_>,
        ) -> Poll<io::Result<()>> {
            Pin::new(&mut self.output).poll_shutdown(cx)
        }
    }

    // Sol's merge-review finding 4: a guarded blob waiting for its first byte
    // wakes at its deadline, with nothing else to wake it. It drops the blob
    // and its reservations, writes none of it, answers a read with its
    // expiry, and the connection's next answer still goes out.
    #[tokio::test]
    async fn guarded_blob_deadline_before_the_first_byte_releases_it() {
        for read in [false, true] {
            let dropped = Arc::new(AtomicBool::new(false));
            let deadline = std::time::Instant::now() + Duration::from_secs(1);
            let (tx, mut rx) = tokio::sync::mpsc::channel(2);
            tx.send(guarded_blob(Arc::new(TestOutputGuard {
                cancel: CancelSignal::new(),
                retired: CancelSignal::new(),
                deadline: Some(deadline),
                dropped: dropped.clone(),
                read_connection: read.then(CancelSignal::new),
            })))
            .await
            .unwrap();
            tx.send(OutputItem::Envelope(Envelope::Response(WireResponse {
                id: 10,
                result: serde_json::json!({ "ok": true }),
            })))
            .await
            .unwrap();
            drop(tx);
            let active = Arc::new(Mutex::new(HashMap::from([(9, None)])));
            let limits = WireLimits::default();
            let mut output = StalledFirstWrite {
                output: Vec::new(),
                deadline,
                waited_in_time: None,
            };
            // The timeout polls the writer when it fires, so only ending well
            // before it shows the deadline woke the blob.
            let started = std::time::Instant::now();
            tokio::time::timeout(
                Duration::from_secs(10),
                write_output(&mut output, &mut rx, &limits, active.clone()),
            )
            .await
            .expect("the deadline wakes the waiting blob")
            .expect("an expired blob leaves the connection writing");
            assert!(
                started.elapsed() < Duration::from_secs(5),
                "{read}: the deadline woke it, after {:?}",
                started.elapsed()
            );
            assert_eq!(
                output.waited_in_time,
                Some(true),
                "{read}: the first byte waited"
            );
            assert!(
                dropped.load(Ordering::SeqCst),
                "{read}: the reservations went"
            );
            assert!(lock(&active).is_empty());
            let mut decoder = FrameDecoder::new(limits.clone());
            decoder.push(&output.output);
            if read {
                let Some(Frame::Control(payload)) = decoder.next_frame().unwrap() else {
                    panic!("the read's expiry missing");
                };
                let Envelope::Error(error) = decode_control(&payload, &limits).unwrap() else {
                    panic!("the expired blob went out");
                };
                assert_eq!(error.id, Some(9));
                assert_eq!(error.error.code, ErrorCode::DeadlineExceeded);
            }
            let Some(Frame::Control(payload)) = decoder.next_frame().unwrap() else {
                panic!("following response missing");
            };
            assert!(
                matches!(decode_control(&payload, &limits).unwrap(), Envelope::Response(response) if response.id == 10 && response.result["ok"] == true),
                "{read}: the expired blob went out"
            );
            assert!(decoder.next_frame().unwrap().is_none());
        }
    }

    #[tokio::test]
    async fn guarded_blob_retired_before_first_frame_preserves_following_response() {
        for expired in [false, true] {
            let retired = CancelSignal::new();
            if !expired {
                retired.cancel();
            }
            let (tx, mut rx) = tokio::sync::mpsc::channel(2);
            tx.send(guarded_blob(Arc::new(TestOutputGuard {
                cancel: CancelSignal::new(),
                retired,
                deadline: expired.then(|| std::time::Instant::now() - Duration::from_secs(1)),
                dropped: Arc::new(AtomicBool::new(false)),
                read_connection: None,
            })))
            .await
            .unwrap();
            tx.send(OutputItem::Envelope(Envelope::Response(WireResponse {
                id: 10,
                result: serde_json::Value::Null,
            })))
            .await
            .unwrap();
            drop(tx);
            let mut output = Vec::new();
            let limits = WireLimits::default();
            write_output(
                &mut output,
                &mut rx,
                &limits,
                Arc::new(Mutex::new(HashMap::new())),
            )
            .await
            .unwrap();
            let mut decoder = FrameDecoder::new(limits.clone());
            decoder.push(&output);
            let Some(Frame::Control(payload)) = decoder.next_frame().unwrap() else {
                panic!("following response missing")
            };
            assert!(
                matches!(decode_control(&payload,&limits).unwrap(),Envelope::Response(response) if response.id==10)
            );
            assert!(decoder.next_frame().unwrap().is_none());
        }
    }

    #[derive(Debug)]
    struct ReleaseGuard {
        cancel: CancelSignal,
        released: Arc<AtomicBool>,
    }

    impl OutputGuard for ReleaseGuard {
        fn is_current_ignoring_cancel(&self) -> bool {
            true
        }
        fn cancel_signal(&self) -> CancelSignal {
            self.cancel.clone()
        }
        fn release(&self) {
            self.released.store(true, Ordering::SeqCst);
        }
    }

    /// Records how much of the transcript was written when the guard
    /// released. Each write waits once and takes at most 512 bytes.
    struct ReleaseRecorder {
        released: Arc<AtomicBool>,
        transcript: Vec<u8>,
        released_at: Option<usize>,
        ready: bool,
        /// Cancelled when the first frame is flushed.
        cancel: Option<CancelSignal>,
    }

    impl AsyncWrite for ReleaseRecorder {
        fn poll_write(
            mut self: Pin<&mut Self>,
            cx: &mut TaskContext<'_>,
            bytes: &[u8],
        ) -> Poll<io::Result<usize>> {
            if !std::mem::replace(&mut self.ready, false) {
                self.ready = true;
                cx.waker().wake_by_ref();
                return Poll::Pending;
            }
            if self.released_at.is_none() && self.released.load(Ordering::SeqCst) {
                self.released_at = Some(self.transcript.len());
            }
            let count = bytes.len().min(512);
            self.transcript.extend_from_slice(&bytes[..count]);
            Poll::Ready(Ok(count))
        }
        fn poll_flush(mut self: Pin<&mut Self>, _: &mut TaskContext<'_>) -> Poll<io::Result<()>> {
            if let Some(cancel) = self.cancel.take() {
                cancel.cancel();
            }
            Poll::Ready(Ok(()))
        }
        fn poll_shutdown(self: Pin<&mut Self>, _: &mut TaskContext<'_>) -> Poll<io::Result<()>> {
            Poll::Ready(Ok(()))
        }
    }

    /// Writes `item`, cancelled after its first frame if `cancel`, and
    /// returns the transcript after the guard released.
    async fn after_release(
        item: impl FnOnce(Arc<dyn OutputGuard>) -> OutputItem,
        cancel: bool,
    ) -> Vec<u8> {
        let released = Arc::new(AtomicBool::new(false));
        let signal = CancelSignal::new();
        let (tx, mut rx) = tokio::sync::mpsc::channel(1);
        tx.send(item(Arc::new(ReleaseGuard {
            cancel: signal.clone(),
            released: released.clone(),
        })))
        .await
        .unwrap();
        drop(tx);
        let mut output = ReleaseRecorder {
            released,
            transcript: Vec::new(),
            released_at: None,
            ready: false,
            cancel: cancel.then_some(signal),
        };
        write_output(
            &mut output,
            &mut rx,
            &WireLimits::default(),
            Arc::new(Mutex::new(HashMap::new())),
        )
        .await
        .unwrap();
        let released_at = output.released_at.expect("the guard released");
        output.transcript.split_off(released_at)
    }

    /// The one complete envelope in `bytes`.
    fn only_envelope(bytes: &[u8]) -> Envelope {
        let limits = WireLimits::default();
        let mut decoder = FrameDecoder::new(limits.clone());
        decoder.push(bytes);
        let Some(Frame::Control(payload)) = decoder.next_frame().unwrap() else {
            panic!("one control frame expected");
        };
        assert!(decoder.next_frame().unwrap().is_none());
        decode_control(&payload, &limits).unwrap()
    }

    #[tokio::test]
    async fn guarded_output_releases_reservations_before_the_client_can_read_the_response() {
        // A client acting on the answer must find its reservations free.
        let acknowledgement = |guard| OutputItem::Guarded {
            response: WireResponse {
                id: 9,
                result: serde_json::json!({"content": "x".repeat(1024)}),
            },
            guard,
        };
        assert_eq!(after_release(acknowledgement, false).await.len(), 1);
        assert!(matches!(
            only_envelope(&after_release(guarded_blob, false).await),
            Envelope::Response(response) if response.id == 9
        ));
        assert!(matches!(
            only_envelope(&after_release(guarded_blob, true).await),
            Envelope::Error(ErrorEnvelope { id: Some(9), .. })
        ));
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
                    read_connection: None,
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
            let active = Arc::new(Mutex::new(HashMap::from([(9, Some(CancelSignal::new()))])));
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
                read_connection: None,
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
                if flush_only && !retire_owner {
                    // A Cancel lets a started flush finish.
                    // `a_cancel_during_the_flush_finishes_the_acknowledgement` covers it.
                    continue;
                }
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
                    read_connection: None,
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

    /// Models `OwnerOutputGuard`: the retirement signal tracks only the
    /// connection, and the workspace is checked under the `handles` lock that
    /// closing it also takes.
    #[derive(Debug, Default)]
    struct OwnerTestGuard {
        cancel: CancelSignal,
        connection: CancelSignal,
        deadline: Option<std::time::Instant>,
        handles: Mutex<()>,
        workspace_closed: AtomicBool,
        close_waiting: AtomicBool,
    }

    impl OwnerTestGuard {
        /// Closes the workspace under `handles`. While an output poll holds
        /// the lock, the close waits and lands when that poll releases it.
        fn close_workspace(&self) {
            match self.handles.try_lock() {
                Ok(_handles) => self.workspace_closed.store(true, Ordering::SeqCst),
                Err(_) => self.close_waiting.store(true, Ordering::SeqCst),
            }
        }

        fn workspace_closed(&self) -> bool {
            self.workspace_closed.load(Ordering::SeqCst)
        }
    }

    impl OutputGuard for OwnerTestGuard {
        fn is_current_ignoring_cancel(&self) -> bool {
            !self.connection.is_cancelled()
                && !self.workspace_closed()
                && self
                    .deadline
                    .is_none_or(|deadline| std::time::Instant::now() < deadline)
        }
        fn cancel_signal(&self) -> CancelSignal {
            self.cancel.clone()
        }
        fn retirement_signal(&self) -> CancelSignal {
            self.connection.clone()
        }
        fn deadline(&self) -> Option<std::time::Instant> {
            self.deadline
        }
        fn with_current(&self, cancellable: bool, action: &mut dyn FnMut()) -> bool {
            let handles = lock(&self.handles);
            let current =
                self.is_current_ignoring_cancel() && !(cancellable && self.cancel.is_cancelled());
            if current {
                action();
            }
            drop(handles);
            if self.close_waiting.swap(false, Ordering::SeqCst) {
                self.workspace_closed.store(true, Ordering::SeqCst);
            }
            current
        }
    }

    /// Writes acknowledgement 9 under `guard`, then response 10. Returns the
    /// writer task and the egress map. Acknowledgement 9 is far larger than
    /// an 8-byte pipe.
    fn write_acknowledgement_then_response<W: AsyncWrite + Unpin + Send + 'static>(
        output: W,
        guard: Arc<OwnerTestGuard>,
    ) -> (tokio::task::JoinHandle<io::Result<()>>, ActiveEgress) {
        let (tx, mut rx) = tokio::sync::mpsc::channel(2);
        let active: ActiveEgress =
            Arc::new(Mutex::new(HashMap::from([(9, Some(guard.cancel.clone()))])));
        tx.try_send(OutputItem::Guarded {
            response: WireResponse {
                id: 9,
                result: serde_json::json!({"content": "x".repeat(1024)}),
            },
            guard,
        })
        .unwrap();
        tx.try_send(OutputItem::Envelope(Envelope::Response(WireResponse {
            id: 10,
            result: serde_json::Value::Null,
        })))
        .unwrap();
        let writer_active = active.clone();
        let task = tokio::spawn(async move {
            write_output(output, &mut rx, &WireLimits::default(), writer_active).await
        });
        (task, active)
    }

    /// The ids of the complete responses in `transcript`, in order.
    fn response_ids(transcript: &[u8]) -> Vec<u64> {
        let limits = WireLimits::default();
        let mut decoder = FrameDecoder::new(limits.clone());
        decoder.push(transcript);
        let mut ids = Vec::new();
        while let Some(Frame::Control(payload)) = decoder.next_frame().unwrap() {
            let Envelope::Response(response) = decode_control(&payload, &limits).unwrap() else {
                panic!("response expected");
            };
            ids.push(response.id);
        }
        ids
    }

    /// An 8-byte pipe, or the same pipe behind a buffer that takes the whole
    /// frame at once, so that only its flush waits on the pipe.
    fn eight_byte_pipe(
        flushing: bool,
    ) -> (Pin<Box<dyn AsyncWrite + Send>>, tokio::io::DuplexStream) {
        let (pipe, reader) = tokio::io::duplex(8);
        let output: Pin<Box<dyn AsyncWrite + Send>> = if flushing {
            Box::pin(tokio::io::BufWriter::with_capacity(64 * 1024, pipe))
        } else {
            Box::pin(pipe)
        };
        (output, reader)
    }

    #[tokio::test]
    async fn a_cancel_after_the_first_byte_finishes_the_acknowledgement() {
        let guard = Arc::new(OwnerTestGuard::default());
        let (writer, mut reader) = eight_byte_pipe(false);
        let (task, active) = write_acknowledgement_then_response(writer, guard.clone());
        let mut transcript = vec![0; 8];
        reader.read_exact(&mut transcript).await.unwrap();
        guard.cancel.cancel();
        reader.read_to_end(&mut transcript).await.unwrap();
        task.await.unwrap().unwrap();
        assert_eq!(response_ids(&transcript), [9, 10]);
        assert!(!lock(&active).contains_key(&9));
    }

    #[tokio::test]
    async fn a_cancel_during_the_flush_finishes_the_acknowledgement() {
        let guard = Arc::new(OwnerTestGuard::default());
        let (writer, mut reader) = eight_byte_pipe(true);
        let (task, _active) = write_acknowledgement_then_response(writer, guard.clone());
        let mut transcript = vec![0; 8];
        reader.read_exact(&mut transcript).await.unwrap();
        guard.cancel.cancel();
        reader.read_to_end(&mut transcript).await.unwrap();
        task.await.unwrap().unwrap();
        assert_eq!(response_ids(&transcript), [9, 10]);
    }

    #[tokio::test]
    async fn retirement_ends_a_started_acknowledgement_even_after_a_cancel() {
        for cancelled in [false, true] {
            let guard = Arc::new(OwnerTestGuard::default());
            let (writer, mut reader) = eight_byte_pipe(false);
            let (task, _active) = write_acknowledgement_then_response(writer, guard.clone());
            let mut transcript = vec![0; 8];
            reader.read_exact(&mut transcript).await.unwrap();
            if cancelled {
                guard.cancel.cancel();
            }
            guard.connection.cancel();
            assert_eq!(
                task.await.unwrap().unwrap_err().kind(),
                io::ErrorKind::ConnectionAborted
            );
            reader.read_to_end(&mut transcript).await.unwrap();
            assert!(response_ids(&transcript).is_empty());
        }
    }

    #[tokio::test]
    async fn closing_the_workspace_ends_a_cancelled_acknowledgement() {
        for flushing in [false, true] {
            let guard = Arc::new(OwnerTestGuard::default());
            let (writer, mut reader) = eight_byte_pipe(flushing);
            let (task, _active) = write_acknowledgement_then_response(writer, guard.clone());
            let mut transcript = vec![0; 8];
            reader.read_exact(&mut transcript).await.unwrap();
            guard.cancel.cancel();
            guard.close_workspace();
            reader.read_to_end(&mut transcript).await.unwrap();
            assert_eq!(
                task.await.unwrap().unwrap_err().kind(),
                io::ErrorKind::ConnectionAborted
            );
            assert_eq!(transcript.len(), 8, "no byte follows the close");
        }
    }

    /// Takes at most 8 bytes per write. The client cancels during the first
    /// write, and the workspace closes as the second write starts, as if
    /// another thread won the race to `handles`. Counts the bytes taken after
    /// the close landed.
    struct CloseDuringSecondWrite {
        guard: Arc<OwnerTestGuard>,
        writes: usize,
        late_bytes: Arc<AtomicUsize>,
    }

    impl AsyncWrite for CloseDuringSecondWrite {
        fn poll_write(
            mut self: Pin<&mut Self>,
            _: &mut TaskContext<'_>,
            bytes: &[u8],
        ) -> Poll<io::Result<usize>> {
            self.writes += 1;
            match self.writes {
                1 => self.guard.cancel.cancel(),
                2 => self.guard.close_workspace(),
                _ => {}
            }
            let count = bytes.len().min(8);
            if self.guard.workspace_closed() {
                self.late_bytes.fetch_add(count, Ordering::SeqCst);
            }
            Poll::Ready(Ok(count))
        }
        fn poll_flush(self: Pin<&mut Self>, _: &mut TaskContext<'_>) -> Poll<io::Result<()>> {
            Poll::Ready(Ok(()))
        }
        fn poll_shutdown(self: Pin<&mut Self>, _: &mut TaskContext<'_>) -> Poll<io::Result<()>> {
            Poll::Ready(Ok(()))
        }
    }

    #[tokio::test]
    async fn a_retirement_racing_a_cancelled_write_lets_no_byte_out() {
        let guard = Arc::new(OwnerTestGuard::default());
        let late_bytes = Arc::new(AtomicUsize::new(0));
        let writer = CloseDuringSecondWrite {
            guard: guard.clone(),
            writes: 0,
            late_bytes: late_bytes.clone(),
        };
        let (task, _active) = write_acknowledgement_then_response(writer, guard.clone());
        assert_eq!(
            task.await.unwrap().unwrap_err().kind(),
            io::ErrorKind::ConnectionAborted
        );
        assert!(guard.workspace_closed());
        assert_eq!(late_bytes.load(Ordering::SeqCst), 0);
    }

    #[tokio::test(start_paused = true)]
    async fn the_deadline_ends_a_started_acknowledgement_even_after_a_cancel() {
        let guard = Arc::new(OwnerTestGuard {
            deadline: Some(std::time::Instant::now() + Duration::from_secs(10)),
            ..OwnerTestGuard::default()
        });
        let (writer, mut reader) = eight_byte_pipe(false);
        let (task, _active) = write_acknowledgement_then_response(writer, guard.clone());
        let mut prefix = [0; 8];
        reader.read_exact(&mut prefix).await.unwrap();
        guard.cancel.cancel();
        tokio::time::advance(Duration::from_secs(11)).await;
        assert_eq!(
            task.await.unwrap().unwrap_err().kind(),
            io::ErrorKind::TimedOut
        );
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
                read_connection: None,
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

    // A held details answer cancelled mid-frame finishes that frame, and the
    // connection's next answer still arrives. A lost owner still stops it
    // mid-frame.
    #[tokio::test]
    async fn held_read_cancelled_mid_frame_finishes_its_answer() {
        for interruption in [ErrorCode::Cancelled, ErrorCode::WorkspaceUnavailable] {
            let cancel = CancelSignal::new();
            let retired = CancelSignal::new();
            let dropped = Arc::new(AtomicBool::new(false));
            // As large as a held answer gets, far more than a pipe holds.
            let details =
                serde_json::json!({ "status": "current", "padding": "x".repeat(200 * 1024) });
            let (tx, mut rx) = tokio::sync::mpsc::channel(2);
            tx.send(OutputItem::Guarded {
                response: WireResponse {
                    id: 9,
                    result: details.clone(),
                },
                guard: Arc::new(TestOutputGuard {
                    cancel: cancel.clone(),
                    retired: retired.clone(),
                    deadline: None,
                    dropped: dropped.clone(),
                    read_connection: Some(CancelSignal::new()),
                }),
            })
            .await
            .unwrap();
            tx.send(OutputItem::Envelope(Envelope::Response(WireResponse {
                id: 10,
                result: serde_json::json!({ "ok": true }),
            })))
            .await
            .unwrap();
            drop(tx);
            let active = Arc::new(Mutex::new(HashMap::from([(9, Some(cancel.clone()))])));
            let limits = WireLimits::default();
            let mut transcript = Vec::new();
            let output = InterruptMidFrame {
                output: &mut transcript,
                completed: 0,
                // The answer's own frame, interrupted halfway.
                interrupt_after: 0,
                interrupted: false,
                waited: false,
                interrupt: if interruption == ErrorCode::WorkspaceUnavailable {
                    retired
                } else {
                    cancel
                },
                deadline: None,
            };
            let written = write_output(output, &mut rx, &limits, active.clone()).await;
            assert!(dropped.load(Ordering::SeqCst));
            let mut decoder = FrameDecoder::new(limits.clone());
            decoder.push(&transcript);
            if interruption == ErrorCode::WorkspaceUnavailable {
                assert_eq!(
                    written.unwrap_err().kind(),
                    io::ErrorKind::ConnectionAborted
                );
                assert!(
                    decoder.next_frame().unwrap().is_none(),
                    "partial frame must not be followed by another envelope"
                );
                continue;
            }
            written.expect("a read's interrupted answer leaves the connection writing");
            assert!(lock(&active).is_empty());
            let Some(Frame::Control(payload)) = decoder.next_frame().unwrap() else {
                panic!("interrupted answer did not finish: {interruption:?}");
            };
            assert!(
                matches!(decode_control(&payload, &limits).unwrap(), Envelope::Response(response) if response.id == 9 && response.result == details)
            );
            let Some(Frame::Control(payload)) = decoder.next_frame().unwrap() else {
                panic!("following response missing");
            };
            assert!(
                matches!(decode_control(&payload, &limits).unwrap(), Envelope::Response(response) if response.id == 10 && response.result["ok"] == true)
            );
            assert!(decoder.next_frame().unwrap().is_none());
        }
    }

    /// Takes half of the first write and returns once `deadline` has passed,
    /// then reports a full pipe until `writable`, as a slow reader keeps the
    /// writer waiting mid-frame past its deadline. Signals `waiting` each
    /// time it reports a full pipe.
    struct PendingPastDeadline {
        output: Arc<Mutex<Vec<u8>>>,
        deadline: std::time::Instant,
        started: bool,
        writable: Arc<AtomicBool>,
        waiting: Arc<Notify>,
        waker: Arc<Mutex<Option<std::task::Waker>>>,
    }

    impl AsyncWrite for PendingPastDeadline {
        fn poll_write(
            mut self: Pin<&mut Self>,
            cx: &mut TaskContext<'_>,
            bytes: &[u8],
        ) -> Poll<io::Result<usize>> {
            if !self.started {
                self.started = true;
                let half = bytes.len().div_ceil(2);
                lock(&self.output).extend_from_slice(&bytes[..half]);
                while std::time::Instant::now() < self.deadline {
                    std::thread::yield_now();
                }
                return Poll::Ready(Ok(half));
            }
            if !self.writable.load(Ordering::SeqCst) {
                *lock(&self.waker) = Some(cx.waker().clone());
                self.waiting.notify_one();
                return Poll::Pending;
            }
            lock(&self.output).extend_from_slice(bytes);
            Poll::Ready(Ok(bytes.len()))
        }
        fn poll_flush(self: Pin<&mut Self>, _: &mut TaskContext<'_>) -> Poll<io::Result<()>> {
            Poll::Ready(Ok(()))
        }
        fn poll_shutdown(self: Pin<&mut Self>, _: &mut TaskContext<'_>) -> Poll<io::Result<()>> {
            Poll::Ready(Ok(()))
        }
    }

    // A held details answer whose deadline passes mid-frame finishes that
    // frame even when its writer waits past a timer tick after the deadline,
    // and the connection's next answer still arrives.
    #[tokio::test]
    async fn held_read_expired_mid_frame_finishes_once_its_writer_can() {
        let cancel = CancelSignal::new();
        let dropped = Arc::new(AtomicBool::new(false));
        let deadline = std::time::Instant::now() + Duration::from_secs(1);
        let details = serde_json::json!({ "status": "current", "padding": "x".repeat(200 * 1024) });
        let (tx, mut rx) = tokio::sync::mpsc::channel(2);
        tx.send(OutputItem::Guarded {
            response: WireResponse {
                id: 9,
                result: details.clone(),
            },
            guard: Arc::new(TestOutputGuard {
                cancel: cancel.clone(),
                retired: CancelSignal::new(),
                deadline: Some(deadline),
                dropped: dropped.clone(),
                read_connection: Some(CancelSignal::new()),
            }),
        })
        .await
        .unwrap();
        tx.send(OutputItem::Envelope(Envelope::Response(WireResponse {
            id: 10,
            result: serde_json::json!({ "ok": true }),
        })))
        .await
        .unwrap();
        drop(tx);
        let active: ActiveEgress = Arc::new(Mutex::new(HashMap::from([(9, Some(cancel))])));
        let transcript = Arc::new(Mutex::new(Vec::new()));
        let (writable, waiting) = (Arc::new(AtomicBool::new(false)), Arc::new(Notify::new()));
        let waker = Arc::new(Mutex::new(None));
        let output = PendingPastDeadline {
            output: transcript.clone(),
            deadline,
            started: false,
            writable: writable.clone(),
            waiting: waiting.clone(),
            waker: waker.clone(),
        };
        let writer_active = active.clone();
        let task = tokio::spawn(async move {
            write_output(output, &mut rx, &WireLimits::default(), writer_active).await
        });
        waiting.notified().await;
        // The timer has fired everything due by the deadline once this
        // returns, so a deadline the writer still waited on has fired too.
        tokio::time::sleep_until(deadline.into()).await;
        writable.store(true, Ordering::SeqCst);
        if let Some(waker) = lock(&waker).take() {
            waker.wake();
        }
        task.await
            .unwrap()
            .expect("an expired read's started answer leaves the connection writing");
        assert!(dropped.load(Ordering::SeqCst));
        assert!(lock(&active).is_empty());
        let limits = WireLimits::default();
        let mut decoder = FrameDecoder::new(limits.clone());
        decoder.push(&lock(&transcript));
        let Some(Frame::Control(payload)) = decoder.next_frame().unwrap() else {
            panic!("the expired answer did not finish");
        };
        assert!(
            matches!(decode_control(&payload, &limits).unwrap(), Envelope::Response(response) if response.id == 9 && response.result == details)
        );
        let Some(Frame::Control(payload)) = decoder.next_frame().unwrap() else {
            panic!("following response missing");
        };
        assert!(
            matches!(decode_control(&payload, &limits).unwrap(), Envelope::Response(response) if response.id == 10 && response.result["ok"] == true)
        );
        assert!(decoder.next_frame().unwrap().is_none());
    }

    // A held read cancelled, past its deadline, or whose owner retired, after
    // its handler answered but before a byte of the answer was written is
    // answered with that error, streamed or not, so its caller settles at
    // once. One whose connection ended (`None`) is withheld. The connection's
    // next answer arrives either way.
    #[tokio::test]
    async fn held_read_withheld_before_its_first_byte_answers_its_error() {
        for streamed in [false, true] {
            for interruption in [
                Some(ErrorCode::Cancelled),
                Some(ErrorCode::DeadlineExceeded),
                Some(ErrorCode::WorkspaceUnavailable),
                None,
            ] {
                let cancel = CancelSignal::new();
                let retired = CancelSignal::new();
                let connection = CancelSignal::new();
                match interruption {
                    Some(ErrorCode::Cancelled) => cancel.cancel(),
                    Some(ErrorCode::WorkspaceUnavailable) => retired.cancel(),
                    None => {
                        connection.cancel();
                        retired.cancel();
                    }
                    _ => {}
                }
                let guard = Arc::new(TestOutputGuard {
                    cancel: cancel.clone(),
                    retired,
                    deadline: (interruption == Some(ErrorCode::DeadlineExceeded))
                        .then(|| std::time::Instant::now() - Duration::from_secs(1)),
                    dropped: Arc::new(AtomicBool::new(false)),
                    read_connection: Some(connection),
                });
                let item = if streamed {
                    guarded_blob(guard)
                } else {
                    OutputItem::Guarded {
                        response: WireResponse {
                            id: 9,
                            result: serde_json::json!({ "status": "current" }),
                        },
                        guard,
                    }
                };
                let (tx, mut rx) = tokio::sync::mpsc::channel(2);
                tx.send(item).await.unwrap();
                tx.send(OutputItem::Envelope(Envelope::Response(WireResponse {
                    id: 10,
                    result: serde_json::Value::Null,
                })))
                .await
                .unwrap();
                drop(tx);
                let active = Arc::new(Mutex::new(HashMap::from([(9, Some(cancel))])));
                let mut output = Vec::new();
                let limits = WireLimits::default();
                write_output(&mut output, &mut rx, &limits, active.clone())
                    .await
                    .unwrap();
                assert!(lock(&active).is_empty());
                let mut decoder = FrameDecoder::new(limits.clone());
                decoder.push(&output);
                if let Some(interruption) = interruption {
                    let Some(Frame::Control(payload)) = decoder.next_frame().unwrap() else {
                        panic!("the read's error missing: {interruption:?}, streamed: {streamed}");
                    };
                    let Envelope::Error(error) = decode_control(&payload, &limits).unwrap() else {
                        panic!("a withheld read was answered");
                    };
                    assert_eq!(error.id, Some(9));
                    assert_eq!(error.error.code, interruption);
                }
                let Some(Frame::Control(payload)) = decoder.next_frame().unwrap() else {
                    panic!("following response missing");
                };
                assert!(
                    matches!(decode_control(&payload, &limits).unwrap(), Envelope::Response(response) if response.id == 10),
                    "{interruption:?}, streamed: {streamed}"
                );
                assert!(decoder.next_frame().unwrap().is_none());
            }
        }
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

    async fn next_envelope(
        decoder: &mut FrameDecoder,
        input: &mut (impl AsyncRead + Unpin),
        limits: &WireLimits,
    ) -> Envelope {
        tokio::time::timeout(Duration::from_secs(10), async {
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
        })
        .await
        .expect("control envelope arrives")
    }

    #[tokio::test]
    async fn lowered_frame_limit_refuses_escape_heavy_secret_then_accepts_ping() {
        use dohc_engine_protocol::transport::{EngineTransport, InProcessTransport};
        use dohc_engine_testkit::ScratchDir;
        use serde_json::json;

        let scratch = ScratchDir::new().expect("scratch");
        let service = Arc::new(EngineService::new());
        let direct = InProcessTransport::new(Arc::clone(&service));
        let request = |id, method: &str, workspace, params| WireRequest {
            id,
            method: method.to_owned(),
            workspace,
            deadline_ms: None,
            idempotency_key: None,
            progress: false,
            params,
        };
        let opened = direct
            .call(
                RequestContext::unbounded(),
                request(
                    1,
                    "workspace.open",
                    None,
                    json!({
                        "workspaceId": "frame-limit-secret",
                        "rootDir": scratch.path().to_string_lossy(),
                        "captureMode": "none",
                    }),
                ),
            )
            .await
            .expect("open local workspace");
        let handle: dohc_engine_protocol::wire::WorkspaceHandle =
            serde_json::from_value(opened.result["workspace"].clone()).expect("workspace handle");
        direct
            .call(
                RequestContext::unbounded(),
                request(
                    2,
                    "versions.ensureMain",
                    Some(handle.clone()),
                    json!({
                        "workspaceId": "frame-limit-secret",
                    }),
                ),
            )
            .await
            .expect("main version");
        let text = "\u{0001}".repeat(200_000);
        assert!(text.len() <= dohc_engine_domain::MAX_SECRET_FILE_BYTES);
        direct
            .call(
                RequestContext::unbounded(),
                request(
                    3,
                    "secrets.write",
                    Some(handle.clone()),
                    json!({
                        "workspaceId": "frame-limit-secret", "versionId": "main",
                        "path": ".env", "text": text, "origin": "api",
                        "momentId": "escape-heavy-secret",
                    }),
                ),
            )
            .await
            .expect("permitted secret write");
        let read = request(
            4,
            "secrets.materialize",
            Some(handle.clone()),
            json!({
                "versionId": "main", "path": ".env",
            }),
        );
        let materialized = direct
            .call(RequestContext::unbounded(), read.clone())
            .await
            .expect("secret read is permitted locally");
        assert_eq!(materialized.result["text"], text);
        let limits = WireLimits {
            max_frame_bytes: dohc_engine_protocol::limits::MIN_NEGOTIABLE_FRAME_BYTES,
            ..WireLimits::default()
        };
        let reply = Envelope::Response(materialized);
        assert!(encode_control(&reply, &WireLimits::default()).is_ok());
        assert!(encode_control(&reply, &limits).is_err());

        let supervisor = Arc::new(Supervisor::new(
            SupervisorConfig::default(),
            Arc::clone(&service),
        ));
        let (mut client_output, daemon_input) = tokio::io::duplex(4096);
        let (daemon_output, mut client_input) = tokio::io::duplex(4096);
        let run = tokio::spawn(run_transport(
            TEST_AUTH_TOKEN.to_owned(),
            daemon_input,
            daemon_output,
            supervisor,
            no_events(),
            || Ok(()),
        ));
        client_output
            .write_all(&encode_envelope(&Envelope::Hello(Hello {
                protocol_version: PROTOCOL_VERSION,
                auth_token: TEST_AUTH_TOKEN.to_owned(),
                capabilities: Vec::new(),
                last_session_generation: None,
                max_frame_bytes: Some(limits.max_frame_bytes),
            })))
            .await
            .expect("hello");
        let mut decoder = FrameDecoder::new(limits.clone());
        let Envelope::HelloAck(ack) = next_envelope(&mut decoder, &mut client_input, &limits).await
        else {
            panic!("hello acknowledgement");
        };
        assert_eq!(ack.limits.max_frame_bytes, limits.max_frame_bytes);
        client_output
            .write_all(&encode_envelope(&Envelope::Request(read)))
            .await
            .expect("secret request");
        let Envelope::Error(error) = next_envelope(&mut decoder, &mut client_input, &limits).await
        else {
            panic!("bounded secret error");
        };
        assert_eq!(error.id, Some(4));
        assert_eq!(error.error.code, ErrorCode::Internal);
        assert_eq!(error.error.message, "response-wire-limit-exceeded");
        assert_eq!(error.error.retry, Retryability::AfterBackoff);
        assert!(!error.error.message.contains('\u{0001}'));
        client_output
            .write_all(&encode_envelope(&Envelope::Request(request(
                5,
                "engine.ping",
                None,
                json!({}),
            ))))
            .await
            .expect("ping");
        assert!(
            matches!(next_envelope(&mut decoder, &mut client_input, &limits).await,
            Envelope::Response(response) if response.id == 5)
        );
        client_output
            .shutdown()
            .await
            .expect("close transport input");
        run.await
            .expect("transport task")
            .expect("transport stays usable");
        direct
            .call(
                RequestContext::unbounded(),
                request(6, "workspace.close", Some(handle), json!({})),
            )
            .await
            .expect("close local workspace");
        service.shutdown_all_capture().await;
    }

    #[tokio::test]
    async fn negotiated_writer_bounds_all_reply_forms_before_blob_egress() {
        let ack = authenticate(
            Envelope::Hello(Hello {
                protocol_version: PROTOCOL_VERSION,
                auth_token: TEST_AUTH_TOKEN.to_owned(),
                capabilities: vec!["blobs".to_owned()],
                last_session_generation: None,
                max_frame_bytes: Some(dohc_engine_protocol::limits::MIN_NEGOTIABLE_FRAME_BYTES),
            }),
            TEST_AUTH_TOKEN,
        )
        .expect("authenticate");
        let limits = ack.limits.clone();
        let oversized = serde_json::json!({"text": "\u{0001}".repeat(200_000)});
        let response = |id| WireResponse {
            id,
            result: oversized.clone(),
        };
        let guard = || {
            Arc::new(TestOutputGuard {
                cancel: CancelSignal::new(),
                retired: CancelSignal::new(),
                deadline: None,
                dropped: Arc::new(AtomicBool::new(false)),
                read_connection: None,
            }) as Arc<dyn OutputGuard>
        };
        let blob = |id| BlobEgress {
            stream_id: id,
            sha256: dohc_engine_storage::hex_sha256(b"must-not-send"),
            bytes: b"must-not-send".to_vec(),
            cancel: CancelSignal::new(),
            deadline: None,
            byte_permit: None,
        };
        let (output_tx, mut output_rx) = tokio::sync::mpsc::channel(16);
        let items = [
            OutputItem::Envelope(Envelope::HelloAck(ack)),
            OutputItem::Envelope(Envelope::Response(response(1))),
            OutputItem::Envelope(Envelope::Error(ErrorEnvelope {
                id: Some(2),
                error: WireError::new(ErrorCode::Internal, "\u{0001}".repeat(200_000)),
            })),
            OutputItem::Guarded {
                response: response(3),
                guard: guard(),
            },
            OutputItem::Blob {
                response: response(4),
                egress: blob(4),
            },
            OutputItem::GuardedBlob {
                response: response(5),
                egress: blob(5),
                guard: guard(),
            },
            OutputItem::Envelope(Envelope::Event(Event {
                seq: 1,
                session_generation: 1,
                name: "oversized".to_owned(),
                payload: oversized,
            })),
            OutputItem::Envelope(Envelope::Response(WireResponse {
                id: 6,
                result: serde_json::json!({"ok": true}),
            })),
        ];
        for item in items {
            output_tx.send(item).await.expect("queue output");
        }
        drop(output_tx);
        let active = Arc::new(Mutex::new(HashMap::from([
            (3, Some(CancelSignal::new())),
            (4, None),
            (5, Some(CancelSignal::new())),
        ])));
        let (output, mut input) = tokio::io::duplex(4096);
        let mut transcript = Vec::new();
        let default_limits = WireLimits::default();
        let (written, read) = tokio::time::timeout(Duration::from_secs(10), async {
            tokio::join!(
                write_output(output, &mut output_rx, &default_limits, Arc::clone(&active)),
                input.read_to_end(&mut transcript),
            )
        })
        .await
        .expect("writer and transcript settle");
        written.expect("bounded writer");
        read.expect("transcript");
        let mut decoder = FrameDecoder::new(limits.clone());
        decoder.push(&transcript);
        let Frame::Control(payload) = decoder.next_frame().unwrap().unwrap() else {
            panic!("hello ack");
        };
        assert!(matches!(
            decode_control(&payload, &limits).unwrap(),
            Envelope::HelloAck(_)
        ));
        for id in 1..=5 {
            let Frame::Control(payload) = decoder.next_frame().unwrap().unwrap() else {
                panic!("oversized blob metadata must not emit raw blob frames");
            };
            assert!(
                matches!(decode_control(&payload, &limits).unwrap(), Envelope::Error(error)
                if error.id == Some(id)
                    && error.error.code == ErrorCode::Internal
                    && error.error.message == "response-wire-limit-exceeded"
                    && error.error.retry == Retryability::AfterBackoff)
            );
        }
        let Frame::Control(payload) = decoder.next_frame().unwrap().unwrap() else {
            panic!("ping reply");
        };
        assert!(
            matches!(decode_control(&payload, &limits).unwrap(), Envelope::Response(response)
            if response.id == 6 && response.result["ok"] == true)
        );
        assert!(
            decoder.next_frame().unwrap().is_none(),
            "oversized event is dropped"
        );
        assert!(lock(&active).is_empty());
    }

    fn request_bytes(id: u64) -> Vec<u8> {
        encode_envelope(&Envelope::Request(WireRequest {
            id,
            method: "test.echo".to_owned(),
            workspace: None,
            deadline_ms: None,
            idempotency_key: None,
            progress: false,
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
                    progress: false,
                    params: serde_json::Value::Null
                }),
                &supervisor,
                &tx,
                &gone,
                &active,
                &egress,
                &mut tasks,
                true,
                false,
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

    /// A `Cancel` that arrives after a request answered with a blob, as a
    /// scene open whose assets landed does, is too late: the blob and the
    /// answer are still sent.
    #[tokio::test]
    async fn a_cancel_after_the_answer_still_delivers_its_blob() {
        let supervisor = Arc::new(Supervisor::new(
            SupervisorConfig::default(),
            Arc::new(BlobService),
        ));
        let (queued, mut answers) = tokio::sync::mpsc::channel(1);
        let (gone, _) = tokio::sync::watch::channel(false);
        let active = Arc::new(Mutex::new(HashSet::new()));
        let egress: ActiveEgress = Arc::default();
        let mut tasks = JoinSet::new();
        for envelope in [
            Envelope::Request(WireRequest {
                id: 31,
                method: "test.blob".into(),
                workspace: None,
                deadline_ms: None,
                idempotency_key: None,
                progress: false,
                params: serde_json::Value::Null,
            }),
            Envelope::Cancel(dohc_engine_protocol::wire::Cancel { id: 31 }),
        ] {
            let request = matches!(envelope, Envelope::Request(_));
            assert!(
                dispatch_authenticated(
                    envelope,
                    &supervisor,
                    &queued,
                    &gone,
                    &active,
                    &egress,
                    &mut tasks,
                    true,
                    false,
                    WireLimits::default().max_frame_bytes,
                    None,
                    None,
                )
                .await
            );
            if request {
                // The answer is queued for the writer before the cancel arrives.
                while answers.is_empty() {
                    tokio::task::yield_now().await;
                }
            }
        }
        drop(queued);
        let mut output = Vec::new();
        let limits = WireLimits::default();
        write_output(&mut output, &mut answers, &limits, Arc::clone(&egress))
            .await
            .expect("written");
        assert!(lock(&egress).is_empty());
        let mut decoder = FrameDecoder::new(limits.clone());
        decoder.push(&output);
        let Some(Frame::Control(start)) = decoder.next_frame().expect("frame") else {
            panic!("blob start");
        };
        assert!(matches!(
            decode_control(&start, &limits).expect("decode start"),
            Envelope::BlobStart(BlobStart { request_id: 31, .. })
        ));
        let Some(Frame::BlobChunk {
            fin: true, bytes, ..
        }) = decoder.next_frame().expect("frame")
        else {
            panic!("the blob is sent");
        };
        assert_eq!(bytes, vec![0x7a; 64 * 1024]);
        let Some(Frame::Control(response)) = decoder.next_frame().expect("frame") else {
            panic!("response");
        };
        assert!(matches!(
            decode_control(&response, &limits).expect("decode response"),
            Envelope::Response(response) if response.id == 31
        ));
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
        write_blob_egress(&mut output, response.clone(), egress, None, &limits, || {})
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
        write_blob_egress(&mut output, response.clone(), egress, None, &limits, || {})
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
        write_blob_egress(&mut output, response, egress, None, &limits, || {})
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
                progress: false,
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

    /// Reports progress while it works, and from a task that keeps reporting
    /// after the request has answered.
    struct ProgressService;

    impl ProtocolEngineService for ProgressService {
        type Input = LiveApplicationInput;
        async fn call(
            &self,
            ctx: RequestContext,
            request: WireRequest,
        ) -> Result<ServiceResponse, WireError> {
            ctx.progress.report();
            let late = ctx.progress.clone();
            tokio::spawn(async move {
                for _ in 0..1_000 {
                    late.report();
                    tokio::task::yield_now().await;
                }
            });
            tokio::task::yield_now().await;
            ctx.progress.report();
            Ok(ServiceResponse::response(WireResponse {
                id: request.id,
                result: serde_json::Value::Null,
            }))
        }
    }

    #[tokio::test]
    async fn progress_reaches_only_a_request_that_asked_on_a_session_that_negotiated_it() {
        for (id, negotiated, asked) in [(91, true, true), (92, false, true), (93, true, false)] {
            let mut input_bytes = encode_envelope(&Envelope::Hello(Hello {
                protocol_version: PROTOCOL_VERSION,
                auth_token: TEST_AUTH_TOKEN.to_owned(),
                capabilities: if negotiated {
                    vec![PROGRESS_CAPABILITY.to_owned()]
                } else {
                    Vec::new()
                },
                last_session_generation: None,
                max_frame_bytes: None,
            }));
            input_bytes.extend_from_slice(&encode_envelope(&Envelope::Request(WireRequest {
                id,
                method: "test.progress".to_owned(),
                workspace: None,
                deadline_ms: None,
                idempotency_key: None,
                progress: asked,
                params: serde_json::Value::Null,
            })));
            let (client, server) = tokio::io::duplex(64 * 1024);
            let (server_input, server_output) = tokio::io::split(server);
            let (mut client_input, mut client_output) = tokio::io::split(client);
            let supervisor = Arc::new(Supervisor::new(
                SupervisorConfig::default(),
                Arc::new(ProgressService),
            ));
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
            let mut envelopes = Vec::new();
            while let Some(frame) = decoder.next_frame().expect("frame") {
                let Frame::Control(payload) = frame else {
                    panic!("expected only control frames");
                };
                envelopes.push(decode_control(&payload, &limits).expect("decode envelope"));
            }
            let Some(Envelope::HelloAck(ack)) = envelopes.first() else {
                panic!("first envelope must be HelloAck");
            };
            assert_eq!(
                ack.capabilities.contains(&PROGRESS_CAPABILITY.to_owned()),
                negotiated
            );
            let Some(Envelope::Response(response)) = envelopes.last() else {
                panic!("the response must be the last envelope: {envelopes:?}");
            };
            assert_eq!(response.id, id);
            let between = &envelopes[1..envelopes.len() - 1];
            assert!(
                between
                    .iter()
                    .all(|envelope| matches!(envelope, Envelope::Progress(Progress { id: at }) if *at == id)),
                "only this request's progress may come before its response: {between:?}"
            );
            assert_eq!(
                !between.is_empty(),
                negotiated && asked,
                "progress for negotiated={negotiated} asked={asked}: {between:?}"
            );
        }
    }

    #[test]
    fn progress_capability_is_negotiated_only_when_requested() {
        let ack = authenticate(
            Envelope::Hello(Hello {
                protocol_version: PROTOCOL_VERSION,
                auth_token: TEST_AUTH_TOKEN.to_owned(),
                capabilities: vec!["blobs".to_owned(), PROGRESS_CAPABILITY.to_owned()],
                last_session_generation: None,
                max_frame_bytes: None,
            }),
            TEST_AUTH_TOKEN,
        )
        .expect("authenticated hello");
        assert_eq!(ack.capabilities, vec!["blobs", PROGRESS_CAPABILITY]);
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
