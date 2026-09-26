use crate::EngineService;
use crate::rpc::error::map_runtime;
use dohc_engine_protocol::error::ErrorCode;
use dohc_engine_protocol::error::WireError;
use dohc_engine_protocol::transport::RequestContext;
use dohc_engine_runtime::CancellationToken;
use dohc_engine_runtime::RuntimeError;
use serde::Deserialize;
use serde_json::Value;
use sha2::Digest;
use sha2::Sha256;
use std::sync::Arc;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

pub(super) const MAX_METADATA_FIELD_BYTES: usize = dohc_engine_domain::MAX_METADATA_FIELD_BYTES;

pub(super) struct OperationCancellation {
    pub(super) token: CancellationToken,
    /// Whether the deadline (not a client cancel) is what fired the token —
    /// the two report different wire codes with different retryability.
    deadline_hit: Arc<std::sync::atomic::AtomicBool>,
    bridge: tokio::task::JoinHandle<()>,
}

impl OperationCancellation {
    pub(super) fn new(ctx: &RequestContext) -> Self {
        let token = CancellationToken::new();
        if ctx.cancel.is_cancelled() {
            token.cancel();
        }
        let signal = ctx.cancel.clone();
        let deadline = ctx.deadline;
        let deadline_hit = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let hit = Arc::clone(&deadline_hit);
        let child = token.clone();
        let bridge = tokio::spawn(async move {
            // The supervisor enforces deadlines non-cooperatively for wire
            // requests; embedded callers (InProcessTransport, future
            // mobile/WASM hosts) have no supervisor, so the deadline arms
            // the same token here.
            match deadline {
                Some(deadline) => {
                    tokio::select! {
                        () = signal.cancelled() => {}
                        () = tokio::time::sleep_until(tokio::time::Instant::from_std(deadline)) => {
                            hit.store(true, std::sync::atomic::Ordering::Relaxed);
                        }
                    }
                }
                None => signal.cancelled().await,
            }
            child.cancel();
        });
        OperationCancellation {
            token,
            deadline_hit,
            bridge,
        }
    }

    /// The wire error for an interrupted wait: DEADLINE_EXCEEDED when the
    /// deadline fired, cancelled for a client cancel — retryability differs.
    pub(super) fn interruption(&self, what: &str) -> WireError {
        if self.deadline_hit.load(std::sync::atomic::Ordering::Relaxed) {
            WireError::new(
                ErrorCode::DeadlineExceeded,
                format!("{what} deadline elapsed"),
            )
        } else {
            WireError::new(ErrorCode::Cancelled, format!("{what} cancelled"))
        }
    }

    pub(super) fn token(&self) -> CancellationToken {
        self.token.clone()
    }
}

impl Drop for OperationCancellation {
    fn drop(&mut self) {
        self.token.cancel();
        self.bridge.abort();
    }
}

pub(super) fn required_idempotency_key(request_id: Option<String>) -> Result<String, WireError> {
    request_id
        .filter(|request_id| !request_id.is_empty())
        .ok_or_else(|| WireError::new(ErrorCode::InvalidParams, "idempotency-key-required"))
}

pub(super) fn deserialize_optional_non_null<'de, D, T>(
    deserializer: D,
) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}

pub(super) fn validate_metadata_fields(
    summary: Option<&str>,
    correlation_id: Option<&str>,
) -> Result<(), WireError> {
    if [summary, correlation_id]
        .into_iter()
        .flatten()
        .any(|field| field.len() > MAX_METADATA_FIELD_BYTES)
    {
        return Err(WireError::new(ErrorCode::InvalidParams, "invalid-metadata"));
    }
    Ok(())
}

pub(super) fn validated_origin(origin: Option<&str>) -> Result<String, WireError> {
    match origin {
        Some(value @ ("api" | "local-file" | "restore" | "sync" | "unknown")) => {
            Ok(value.to_owned())
        }
        _ => Err(WireError::new(ErrorCode::InvalidParams, "invalid-metadata")),
    }
}

pub(super) fn validated_author(author: Option<&Value>) -> Result<Option<String>, WireError> {
    let Some(value) = author else {
        return Ok(None);
    };
    let object = value
        .as_object()
        .ok_or_else(|| WireError::new(ErrorCode::InvalidParams, "invalid-metadata"))?;
    let nonempty = |field: &str| {
        object
            .get(field)
            .and_then(Value::as_str)
            .is_some_and(|value| !value.is_empty())
    };
    let valid = match object.get("kind").and_then(Value::as_str) {
        Some("agent") => {
            nonempty("agentId")
                && nonempty("onBehalfOf")
                && object
                    .get("agentRunId")
                    .is_none_or(|value| value.as_str().is_some_and(|value| !value.is_empty()))
        }
        // An automation writing a file, so the moment carries its identity
        // and chain depth into the claims the write causes.
        Some("automation") => {
            nonempty("automationId")
                && nonempty("onBehalfOf")
                && object.len() == 4
                && object
                    .get("depth")
                    .and_then(Value::as_u64)
                    .is_some_and(|depth| {
                        depth <= u64::from(dohc_engine_domain::MAX_CHANGE_ATTRIBUTION_DEPTH)
                    })
        }
        _ => false,
    };
    if !valid {
        return Err(WireError::new(ErrorCode::InvalidParams, "invalid-metadata"));
    }
    serde_json::to_string(&value)
        .map(Some)
        .map_err(|_| WireError::new(ErrorCode::InvalidParams, "invalid-metadata"))
}

pub(super) fn parse<T: for<'de> Deserialize<'de>>(value: Value) -> Result<T, WireError> {
    serde_json::from_value(value)
        .map_err(|_| WireError::new(ErrorCode::InvalidParams, "invalid parameters"))
}

pub(crate) fn now_ms() -> Result<i64, WireError> {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| WireError::new(ErrorCode::Internal, "system clock unavailable"))?;
    i64::try_from(duration.as_millis())
        .map_err(|_| WireError::new(ErrorCode::Internal, "system clock unavailable"))
}

impl EngineService {
    pub(super) fn generated_rpc_id(
        &self,
        prefix: &str,
        wire_request_id: u64,
        request_id: Option<&str>,
        path: &str,
    ) -> String {
        let mut digest = Sha256::new();
        let wire_request_id = wire_request_id.to_string();
        let fields: Vec<&[u8]> = match request_id {
            Some(request_id) => vec![request_id.as_bytes(), path.as_bytes()],
            None => vec![
                self.session_epoch.as_bytes(),
                wire_request_id.as_bytes(),
                path.as_bytes(),
            ],
        };
        for field in fields {
            digest.update((field.len() as u64).to_le_bytes());
            digest.update(field);
        }
        format!("{prefix}-{}", dohc_engine_storage::hex(&digest.finalize()))
    }

    /// Await an actor read under the request's cancellation/deadline — the
    /// wait is abandoned (the actor's work completes and is discarded),
    /// the same shape capture.flush uses. Read commands carry no token, so
    /// abandoning the wait IS the cancellation semantics.
    pub(super) async fn read_under_ctx<T>(
        cancellation: &OperationCancellation,
        what: &str,
        read: impl std::future::Future<Output = Result<T, RuntimeError>>,
    ) -> Result<T, WireError> {
        tokio::select! {
            biased;
            () = cancellation.token.cancelled() => Err(cancellation.interruption(what)),
            result = read => result.map_err(map_runtime),
        }
    }
}
