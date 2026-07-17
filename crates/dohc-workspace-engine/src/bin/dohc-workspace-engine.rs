//! DOP1 stdio host for the shadow-only Rust workspace engine.

#![forbid(unsafe_code)]

use dohc_engine_protocol::{
    error::{ErrorCode, WireError},
    frame::{Frame, FrameDecoder},
    limits::WireLimits,
    supervisor::{Supervisor, SupervisorConfig},
    wire::{
        Envelope, ErrorEnvelope, Hello, HelloAck, PROTOCOL_VERSION, decode_control, encode_control,
    },
};
use dohc_workspace_engine::EngineService;
use std::{error::Error, io, sync::Arc};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const AUTH_TOKEN_ENV: &str = "DOHC_ENGINE_AUTH_TOKEN";
const OUTPUT_QUEUE_CAPACITY: usize = 64;
const READ_CHUNK_BYTES: usize = 64 * 1024;

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
    let limits = WireLimits::default();
    let service = Arc::new(EngineService::new());
    let supervisor = Arc::new(Supervisor::new(SupervisorConfig::default(), service));
    let (output_tx, mut output_rx) = tokio::sync::mpsc::channel(OUTPUT_QUEUE_CAPACITY);
    let writer_limits = limits.clone();
    let writer = tokio::spawn(async move {
        let mut stdout = tokio::io::stdout();
        while let Some(envelope) = output_rx.recv().await {
            let bytes = encode_control(&envelope, &writer_limits)
                .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "response too large"))?;
            stdout.write_all(&bytes).await?;
            stdout.flush().await?;
        }
        Ok::<(), io::Error>(())
    });

    let mut stdin = tokio::io::stdin();
    let mut decoder = FrameDecoder::new(limits);
    let mut read_buf = vec![0_u8; READ_CHUNK_BYTES];
    let mut authenticated = false;
    let mut keep_running = true;
    while keep_running {
        let read = stdin.read(&mut read_buf).await?;
        if read == 0 {
            break;
        }
        decoder.push(&read_buf[..read]);
        loop {
            let frame = match decoder.next_frame() {
                Ok(Some(frame)) => frame,
                Ok(None) => break,
                Err(_) => {
                    send_error(
                        &output_tx,
                        None,
                        ErrorCode::MalformedFrame,
                        "malformed frame",
                    )
                    .await;
                    keep_running = false;
                    break;
                }
            };
            let Frame::Control(payload) = frame else {
                send_error(
                    &output_tx,
                    None,
                    ErrorCode::InvalidEnvelope,
                    "blob streams are not supported by this method surface",
                )
                .await;
                keep_running = false;
                break;
            };
            let envelope = match decode_control(&payload, &WireLimits::default()) {
                Ok(envelope) => envelope,
                Err(_) => {
                    send_error(
                        &output_tx,
                        None,
                        ErrorCode::InvalidEnvelope,
                        "invalid envelope",
                    )
                    .await;
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
                        let _ = output_tx
                            .send(Envelope::Error(ErrorEnvelope { id: None, error }))
                            .await;
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
                if !dispatch_authenticated(envelope, &supervisor, &output_tx).await {
                    keep_running = false;
                    break;
                }
            }
        }
    }

    drop(output_tx);
    writer
        .await
        .map_err(|_| io::Error::other("stdout writer task failed"))??;
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
        session_generation: 1,
        capabilities: negotiated,
        limits: WireLimits::default(),
    })
}

async fn dispatch_authenticated(
    envelope: Envelope,
    supervisor: &Arc<Supervisor<EngineService>>,
    output: &tokio::sync::mpsc::Sender<Envelope>,
) -> bool {
    match envelope {
        Envelope::Request(request) => {
            let id = request.id;
            match supervisor.try_submit(request) {
                Ok(receiver) => {
                    let output = output.clone();
                    tokio::spawn(async move {
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
                        let _ = output.send(envelope).await;
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
            send_error(
                output,
                None,
                ErrorCode::InvalidEnvelope,
                "envelope is invalid after handshake",
            )
            .await;
            false
        }
        Envelope::BlobStart(_) => {
            send_error(
                output,
                None,
                ErrorCode::InvalidEnvelope,
                "blob streams are not supported by this method surface",
            )
            .await;
            false
        }
        Envelope::Response(_) | Envelope::Error(_) | Envelope::Event(_) => {
            send_error(
                output,
                None,
                ErrorCode::InvalidEnvelope,
                "client sent a server-only envelope",
            )
            .await;
            false
        }
    }
}

async fn send_error(
    output: &tokio::sync::mpsc::Sender<Envelope>,
    id: Option<u64>,
    code: ErrorCode,
    message: &'static str,
) {
    let _ = output
        .send(Envelope::Error(ErrorEnvelope {
            id,
            error: WireError::new(code, message),
        }))
        .await;
}
