//! Restricted, synchronous stdio surface. No runtime, configuration or workspace is opened.
use base64::{Engine as _, engine::general_purpose::STANDARD};
use dohc_engine_collab::ContentKind;
use dohc_engine_protocol::{
    error::{ErrorCode, WireError},
    frame::{Frame, FrameDecoder},
    limits::{MIN_NEGOTIABLE_FRAME_BYTES, WireLimits},
    wire::{
        Envelope, ErrorEnvelope, HelloAck, PROTOCOL_VERSION, Request, Response, decode_control,
        encode_control,
    },
};
use dohc_engine_sync::{UpdateProjectionError, project_ydoc_updates};
use serde::Deserialize;
use serde_json::{Value, json};
use std::io::{self, Read, Write};

pub const CAPABILITY: &str = "projection-only";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Params {
    content_kind: String,
    updates_base64: Vec<String>,
}

fn invalid(message: &str) -> WireError {
    WireError::new(ErrorCode::InvalidParams, message)
}

fn project(params: Value) -> Result<Value, WireError> {
    let params: Params =
        serde_json::from_value(params).map_err(|_| invalid("invalid projection parameters"))?;
    let kind = match params.content_kind.as_str() {
        "richdoc" => ContentKind::Richdoc,
        "plaintext" => ContentKind::Plaintext,
        _ => {
            return Err(invalid(
                "projection supports richdoc and plaintext; scenes require authorized assets",
            ));
        }
    };
    let updates: Vec<Vec<u8>> = params
        .updates_base64
        .iter()
        .map(|s| {
            STANDARD
                .decode(s)
                .map_err(|_| invalid("malformed base64 update"))
        })
        .collect::<Result<_, _>>()?;
    let projection = project_ydoc_updates(updates.iter().map(Vec::as_slice), kind).map_err(
        |error| match error {
            UpdateProjectionError::Invalid(message) => invalid(message),
            UpdateProjectionError::TooLarge(message) => {
                WireError::new(ErrorCode::PayloadTooLarge, message)
            }
        },
    )?;
    Ok(
        json!({"contentBase64": STANDARD.encode(projection.content), "sourceStateVectorSha256": projection.source_state_vector_sha256}),
    )
}

fn response(request: Request) -> Envelope {
    let result = if request.workspace.is_some() {
        Err(invalid("projection mode takes no workspace"))
    } else if request.idempotency_key.is_some() || request.progress {
        Err(invalid(
            "projection mode takes no mutation or progress options",
        ))
    } else {
        match request.method.as_str() {
            "engine.ping" if request.params == json!({}) => {
                Ok(json!({"ok": true, "mode": CAPABILITY}))
            }
            "ydoc.project" => project(request.params),
            _ => Err(WireError::new(
                ErrorCode::MethodNotFound,
                "method unavailable in projection mode",
            )),
        }
    };
    match result {
        Ok(result) => Envelope::Response(Response {
            id: request.id,
            result,
        }),
        Err(error) => Envelope::Error(ErrorEnvelope {
            id: Some(request.id),
            error,
        }),
    }
}

/// The inherited pipes are the only capability. Each process handles one projection.
pub fn run(input: &mut impl Read, output: &mut impl Write) -> io::Result<()> {
    let mut limits = WireLimits::default();
    let mut decoder = FrameDecoder::new(limits.clone());
    let mut chunk = [0u8; 64 * 1024];
    let mut authenticated = false;
    let mut frames = 0usize;
    loop {
        let read = input.read(&mut chunk)?;
        if read == 0 {
            return Ok(());
        }
        decoder.push(&chunk[..read]);
        while let Some(frame) = decoder.next_frame().map_err(io::Error::other)? {
            frames += 1;
            if frames > 3 {
                return Err(io::Error::other("projection request budget exceeded"));
            }
            let Frame::Control(payload) = frame else {
                return Err(io::Error::other("projection mode takes no blob streams"));
            };
            if payload.len() > limits.max_frame_bytes as usize {
                return Err(io::Error::other(
                    "projection frame exceeds negotiated limit",
                ));
            }
            let envelope = decode_control(&payload, &limits).map_err(io::Error::other)?;
            let (reply, done) = if !authenticated {
                let Envelope::Hello(hello) = envelope else {
                    return Err(io::Error::other("projection handshake required"));
                };
                if hello.protocol_version != PROTOCOL_VERSION
                    || !hello.capabilities.iter().any(|s| s == CAPABILITY)
                {
                    return Err(io::Error::other(
                        "projection protocol or capability mismatch",
                    ));
                }
                limits.max_frame_bytes = hello
                    .max_frame_bytes
                    .unwrap_or(limits.max_frame_bytes)
                    .clamp(MIN_NEGOTIABLE_FRAME_BYTES, limits.max_frame_bytes);
                authenticated = true;
                (
                    Envelope::HelloAck(HelloAck {
                        protocol_version: PROTOCOL_VERSION,
                        session_generation: 1,
                        capabilities: vec![CAPABILITY.to_owned()],
                        limits: limits.clone(),
                    }),
                    false,
                )
            } else {
                let Envelope::Request(request) = envelope else {
                    return Err(io::Error::other("projection mode accepts only requests"));
                };
                let done = request.method == "ydoc.project";
                (response(request), done)
            };
            let payload = encode_control(&reply, &limits).map_err(io::Error::other)?;
            output.write_all(&payload)?;
            output.flush()?;
            if done {
                return Ok(());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use dohc_engine_protocol::wire::{Hello, WorkspaceHandle};
    fn request(method: &str, workspace: Option<WorkspaceHandle>, params: Value) -> Request {
        Request {
            id: 1,
            method: method.to_owned(),
            workspace,
            params,
            deadline_ms: None,
            idempotency_key: None,
            progress: false,
        }
    }
    #[test]
    fn projection_surface_cannot_open_workspaces_or_accept_a_basis() {
        for req in [
            request("workspace.open", None, json!({"rootDir":"/"})),
            request(
                "ydoc.project",
                Some(WorkspaceHandle("owner".into())),
                json!({}),
            ),
            request(
                "ydoc.project",
                None,
                json!({"contentKind":"plaintext","updatesBase64":["AAA="],"snapshot":"forged"}),
            ),
        ] {
            assert!(matches!(response(req), Envelope::Error(_)));
        }
    }
    #[test]
    fn only_one_projection_runs_even_with_pipelined_input() {
        let limits = WireLimits::default();
        let hello = Envelope::Hello(Hello {
            protocol_version: 2,
            auth_token: String::new(),
            capabilities: vec![CAPABILITY.into()],
            last_session_generation: None,
            max_frame_bytes: None,
        });
        let project = Envelope::Request(request(
            "ydoc.project",
            None,
            json!({"contentKind":"plaintext","updatesBase64":["AAA="]}),
        ));
        let mut input = Vec::new();
        for envelope in [hello.clone(), project.clone(), project] {
            input.extend(encode_control(&envelope, &limits).unwrap());
        }
        let mut output = Vec::new();
        run(&mut std::io::Cursor::new(input), &mut output).unwrap();
        let mut decoder = FrameDecoder::new(limits);
        decoder.push(&output);
        assert!(decoder.next_frame().unwrap().is_some());
        assert!(decoder.next_frame().unwrap().is_some());
        assert!(decoder.next_frame().unwrap().is_none());
    }
}
