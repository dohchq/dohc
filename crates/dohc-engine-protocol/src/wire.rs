//! Wire envelope types: the typed contract between the desktop client and
//! the engine, independent of any particular transport or encoding.
//!
//! These structs are the in-process transport's native currency (portability
//! guardrail 3: an embedded engine never serializes to itself); the framed
//! transport encodes them as JSON control frames in protocol v1.

use crate::error::{EnvelopeDecodeError, LimitKind, LimitViolation, WireError};
use crate::limits::{MAX_WIRE_INTEGER, WireLimits};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Protocol compatibility version, negotiated in `hello`/`helloAck`.
/// Distinct from the storage schema version (`schema_version = 2`).
pub const PROTOCOL_VERSION: u32 = 1;

/// Client-assigned request id, unique within a session generation.
/// Bounded by [`MAX_WIRE_INTEGER`] so TypeScript can use plain `number`.
pub type RequestId = u64;

/// Opaque, server-issued workspace handle. Clients never fabricate one and
/// never learn filesystem paths from it; handles die with their session
/// generation.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "bindings", derive(schemars::JsonSchema, ts_rs::TS))]
#[cfg_attr(feature = "bindings", ts(export))]
pub struct WorkspaceHandle(pub String);

/// Every message that can cross the transport, tagged by `type`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "bindings", derive(schemars::JsonSchema, ts_rs::TS))]
#[cfg_attr(feature = "bindings", ts(export))]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Envelope {
    Hello(Hello),
    HelloAck(HelloAck),
    Request(Request),
    Response(Response),
    Error(ErrorEnvelope),
    Event(Event),
    Cancel(Cancel),
    BlobStart(BlobStart),
    Batch(Batch),
}

/// First message on a connection, client → engine. Authenticates the
/// parent-child session: the desktop main process spawns the engine with a
/// random token in its environment and must echo it here. Anything before a
/// valid `hello` is answered with `AUTH_FAILED` and the connection closes.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "bindings", derive(schemars::JsonSchema, ts_rs::TS))]
#[cfg_attr(feature = "bindings", ts(export))]
#[serde(rename_all = "camelCase")]
pub struct Hello {
    pub protocol_version: u32,
    pub auth_token: String,
    /// Capabilities the client understands (capability negotiation).
    pub capabilities: Vec<String>,
    /// On reconnect after an engine restart: the generation the client last
    /// saw, so the engine can tell resume-after-restart from first contact.
    /// The engine always issues a fresh generation in `helloAck`.
    #[cfg_attr(feature = "bindings", ts(type = "number | null"))]
    pub last_session_generation: Option<u64>,
}

/// Engine → client handshake acknowledgement.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "bindings", derive(schemars::JsonSchema, ts_rs::TS))]
#[cfg_attr(feature = "bindings", ts(export))]
#[serde(rename_all = "camelCase")]
pub struct HelloAck {
    pub protocol_version: u32,
    /// Fresh per accepted connection. Old workspace handles, request ids and
    /// event sequences are invalid under a new generation.
    #[cfg_attr(feature = "bindings", ts(type = "number"))]
    pub session_generation: u64,
    /// Intersection-negotiated capabilities in effect for this session.
    pub capabilities: Vec<String>,
    /// Bounds this engine enforces; the client must stay within them.
    pub limits: WireLimits,
}

/// A client request.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "bindings", derive(schemars::JsonSchema, ts_rs::TS))]
#[cfg_attr(feature = "bindings", ts(export))]
#[serde(rename_all = "camelCase")]
pub struct Request {
    #[cfg_attr(feature = "bindings", ts(type = "number"))]
    pub id: RequestId,
    /// Namespaced method name, e.g. `workspace.open`. Test-build fault
    /// injection uses the reserved `testkit.` namespace.
    pub method: String,
    /// Target workspace, when the method is workspace-scoped.
    pub workspace: Option<WorkspaceHandle>,
    /// Relative deadline. The engine clamps it to its maximum and fails the
    /// request with `DEADLINE_EXCEEDED` when it elapses.
    pub deadline_ms: Option<u32>,
    /// Required on retryable mutations: the engine deduplicates replays of
    /// the same key after timeouts/reconnects (exactly-once acknowledgement).
    pub idempotency_key: Option<String>,
    /// Method-specific parameters; validated per-method behind the envelope
    /// layer, bounded here as a JSON tree.
    pub params: Value,
}

/// A successful response to a request.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "bindings", derive(schemars::JsonSchema, ts_rs::TS))]
#[cfg_attr(feature = "bindings", ts(export))]
#[serde(rename_all = "camelCase")]
pub struct Response {
    #[cfg_attr(feature = "bindings", ts(type = "number"))]
    pub id: RequestId,
    pub result: Value,
}

/// A failed response, or a connection-level error when `id` is absent.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "bindings", derive(schemars::JsonSchema, ts_rs::TS))]
#[cfg_attr(feature = "bindings", ts(export))]
#[serde(rename_all = "camelCase")]
pub struct ErrorEnvelope {
    #[cfg_attr(feature = "bindings", ts(type = "number | null"))]
    pub id: Option<RequestId>,
    pub error: WireError,
}

/// An engine-initiated event. Events are totally ordered per session by
/// `seq`; a client that observes a gap must treat its state as stale and
/// resynchronize.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "bindings", derive(schemars::JsonSchema, ts_rs::TS))]
#[cfg_attr(feature = "bindings", ts(export))]
#[serde(rename_all = "camelCase")]
pub struct Event {
    #[cfg_attr(feature = "bindings", ts(type = "number"))]
    pub seq: u64,
    #[cfg_attr(feature = "bindings", ts(type = "number"))]
    pub session_generation: u64,
    /// Namespaced event name, e.g. `workspace.filesChanged`.
    pub name: String,
    pub payload: Value,
}

/// Cooperative cancellation of an in-flight request. The engine still sends
/// a terminal response for the id (`CANCELLED` if cancellation won).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "bindings", derive(schemars::JsonSchema, ts_rs::TS))]
#[cfg_attr(feature = "bindings", ts(export))]
#[serde(rename_all = "camelCase")]
pub struct Cancel {
    #[cfg_attr(feature = "bindings", ts(type = "number"))]
    pub id: RequestId,
}

/// Announces a binary blob stream whose bytes follow as blob-chunk frames
/// (never base64 inside an envelope). Sent by whichever side streams the
/// blob; `request_id` ties the stream to its request.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "bindings", derive(schemars::JsonSchema, ts_rs::TS))]
#[cfg_attr(feature = "bindings", ts(export))]
#[serde(rename_all = "camelCase")]
pub struct BlobStart {
    #[cfg_attr(feature = "bindings", ts(type = "number"))]
    pub request_id: RequestId,
    /// Stream id carried by each chunk frame; unique per session generation.
    #[cfg_attr(feature = "bindings", ts(type = "number"))]
    pub stream_id: u64,
    /// Total size when known up front, letting the receiver preflight bounds.
    #[cfg_attr(feature = "bindings", ts(type = "number | null"))]
    pub total_bytes: Option<u64>,
    /// Lowercase hex SHA-256 of the full blob, when known, for end-to-end
    /// integrity verification.
    pub sha256: Option<String>,
}

/// A bounded batch of envelopes, applied in order. Batches never nest.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "bindings", derive(schemars::JsonSchema, ts_rs::TS))]
#[cfg_attr(feature = "bindings", ts(export))]
#[serde(rename_all = "camelCase")]
pub struct Batch {
    pub envelopes: Vec<Envelope>,
}

/// Encode an envelope into a complete control frame (header + JSON payload),
/// validating bounds first so an oversized message is refused before it is
/// ever written to the wire.
pub fn encode_control(
    envelope: &Envelope,
    limits: &WireLimits,
) -> Result<Vec<u8>, EnvelopeDecodeError> {
    envelope.validate(limits)?;
    let payload = serde_json::to_vec(envelope).map_err(|error| EnvelopeDecodeError::Json {
        line: error.line(),
        column: error.column(),
    })?;
    crate::frame::encode_control_frame(&payload, limits).map_err(EnvelopeDecodeError::Limit)
}

/// Decode and validate a control-frame payload. Arbitrary input yields a
/// typed error; error values carry positions and bounds, never input content.
pub fn decode_control(
    payload: &[u8],
    limits: &WireLimits,
) -> Result<Envelope, EnvelopeDecodeError> {
    let envelope: Envelope =
        serde_json::from_slice(payload).map_err(|error| EnvelopeDecodeError::Json {
            line: error.line(),
            column: error.column(),
        })?;
    envelope.validate(limits)?;
    Ok(envelope)
}

impl Envelope {
    /// Enforce wire bounds on every string, collection, integer, and JSON
    /// tree in the envelope. Both encoder and decoder call this.
    pub fn validate(&self, limits: &WireLimits) -> Result<(), LimitViolation> {
        match self {
            Envelope::Hello(hello) => {
                check_string(&hello.auth_token, "hello.authToken", limits)?;
                check_capabilities(&hello.capabilities, "hello.capabilities", limits)?;
                check_opt_integer(hello.last_session_generation, "hello.lastSessionGeneration")
            }
            Envelope::HelloAck(ack) => {
                check_integer(ack.session_generation, "helloAck.sessionGeneration")?;
                check_capabilities(&ack.capabilities, "helloAck.capabilities", limits)
            }
            Envelope::Request(request) => {
                check_integer(request.id, "request.id")?;
                check_string(&request.method, "request.method", limits)?;
                if let Some(workspace) = &request.workspace {
                    check_string(&workspace.0, "request.workspace", limits)?;
                }
                if let Some(key) = &request.idempotency_key {
                    check_string(key, "request.idempotencyKey", limits)?;
                }
                check_json(&request.params, "request.params", limits)
            }
            Envelope::Response(response) => {
                check_integer(response.id, "response.id")?;
                check_json(&response.result, "response.result", limits)
            }
            Envelope::Error(error) => {
                check_opt_integer(error.id, "error.id")?;
                check_string(&error.error.message, "error.message", limits)
            }
            Envelope::Event(event) => {
                check_integer(event.seq, "event.seq")?;
                check_integer(event.session_generation, "event.sessionGeneration")?;
                check_string(&event.name, "event.name", limits)?;
                check_json(&event.payload, "event.payload", limits)
            }
            Envelope::Cancel(cancel) => check_integer(cancel.id, "cancel.id"),
            Envelope::BlobStart(blob) => {
                check_integer(blob.request_id, "blobStart.requestId")?;
                check_integer(blob.stream_id, "blobStart.streamId")?;
                check_opt_integer(blob.total_bytes, "blobStart.totalBytes")?;
                if let Some(sha256) = &blob.sha256 {
                    check_string(sha256, "blobStart.sha256", limits)?;
                }
                Ok(())
            }
            Envelope::Batch(batch) => {
                if batch.envelopes.len() as u64 > u64::from(limits.max_batch_len) {
                    return Err(LimitViolation {
                        limit: LimitKind::BatchLen,
                        field: "batch.envelopes",
                        actual: batch.envelopes.len() as u64,
                        max: u64::from(limits.max_batch_len),
                    });
                }
                for envelope in &batch.envelopes {
                    if matches!(envelope, Envelope::Batch(_)) {
                        return Err(LimitViolation {
                            limit: LimitKind::BatchLen,
                            field: "batch.envelopes (nested batch)",
                            actual: 2,
                            max: 1,
                        });
                    }
                    envelope.validate(limits)?;
                }
                Ok(())
            }
        }
    }

    /// Convenience: a terminal `error` envelope for a request id.
    pub fn request_error(id: RequestId, error: WireError) -> Envelope {
        Envelope::Error(ErrorEnvelope {
            id: Some(id),
            error,
        })
    }
}

fn check_string(
    value: &str,
    field: &'static str,
    limits: &WireLimits,
) -> Result<(), LimitViolation> {
    if value.len() as u64 > u64::from(limits.max_string_bytes) {
        return Err(LimitViolation {
            limit: LimitKind::StringBytes,
            field,
            actual: value.len() as u64,
            max: u64::from(limits.max_string_bytes),
        });
    }
    Ok(())
}

fn check_capabilities(
    capabilities: &[String],
    field: &'static str,
    limits: &WireLimits,
) -> Result<(), LimitViolation> {
    if capabilities.len() as u64 > u64::from(limits.max_collection_len) {
        return Err(LimitViolation {
            limit: LimitKind::CollectionLen,
            field,
            actual: capabilities.len() as u64,
            max: u64::from(limits.max_collection_len),
        });
    }
    for capability in capabilities {
        check_string(capability, field, limits)?;
    }
    Ok(())
}

fn check_integer(value: u64, field: &'static str) -> Result<(), LimitViolation> {
    if value > MAX_WIRE_INTEGER {
        return Err(LimitViolation {
            limit: LimitKind::IntegerRange,
            field,
            actual: value,
            max: MAX_WIRE_INTEGER,
        });
    }
    Ok(())
}

fn check_opt_integer(value: Option<u64>, field: &'static str) -> Result<(), LimitViolation> {
    match value {
        Some(value) => check_integer(value, field),
        None => Ok(()),
    }
}

/// Iteratively (explicit stack, no recursion) bound a JSON tree: depth,
/// string bytes, collection lengths, and integer range.
fn check_json(
    value: &Value,
    field: &'static str,
    limits: &WireLimits,
) -> Result<(), LimitViolation> {
    let mut stack: Vec<(&Value, u32)> = vec![(value, 1)];
    while let Some((value, depth)) = stack.pop() {
        if depth > limits.max_json_depth {
            return Err(LimitViolation {
                limit: LimitKind::JsonDepth,
                field,
                actual: u64::from(depth),
                max: u64::from(limits.max_json_depth),
            });
        }
        match value {
            Value::Null | Value::Bool(_) => {}
            Value::Number(number) => {
                if let Some(unsigned) = number.as_u64() {
                    check_integer(unsigned, field)?;
                } else if let Some(signed) = number.as_i64() {
                    check_integer(signed.unsigned_abs(), field)?;
                }
                // Finite f64 values are within JSON number range by
                // construction (serde_json rejects NaN/Infinity).
            }
            Value::String(string) => check_string(string, field, limits)?,
            Value::Array(items) => {
                if items.len() as u64 > u64::from(limits.max_collection_len) {
                    return Err(LimitViolation {
                        limit: LimitKind::CollectionLen,
                        field,
                        actual: items.len() as u64,
                        max: u64::from(limits.max_collection_len),
                    });
                }
                for item in items {
                    stack.push((item, depth + 1));
                }
            }
            Value::Object(entries) => {
                if entries.len() as u64 > u64::from(limits.max_collection_len) {
                    return Err(LimitViolation {
                        limit: LimitKind::CollectionLen,
                        field,
                        actual: entries.len() as u64,
                        max: u64::from(limits.max_collection_len),
                    });
                }
                for (key, item) in entries {
                    check_string(key, field, limits)?;
                    stack.push((item, depth + 1));
                }
            }
        }
    }
    Ok(())
}
