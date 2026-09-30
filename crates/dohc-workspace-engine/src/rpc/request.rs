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

/// A write declares one author; the moment records it as a list of one.
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
    let depth_within = |value: &Value, least: u64| {
        value.as_u64().is_some_and(|depth| {
            (least..=u64::from(dohc_engine_domain::MAX_CHANGE_ATTRIBUTION_DEPTH)).contains(&depth)
        })
    };
    let valid = match object.get("kind").and_then(Value::as_str) {
        // An agent run an automation started names its chain depth, so the
        // claims its writes cause carry the chain on and stop at the cap. A
        // run a person started names none: absent means 0.
        Some("agent") => {
            nonempty("agentId")
                && nonempty("onBehalfOf")
                && object
                    .get("agentRunId")
                    .is_none_or(|value| value.as_str().is_some_and(|value| !value.is_empty()))
                && object
                    .get("depth")
                    .is_none_or(|value| depth_within(value, 1))
        }
        // An automation writing a file, so the moment carries its identity
        // and chain depth into the claims the write causes. It names the
        // person its run acts for, and a run with nobody names nobody.
        Some("automation") => {
            nonempty("automationId")
                && object
                    .get("onBehalfOf")
                    .is_none_or(|value| value.as_str().is_some_and(|value| !value.is_empty()))
                && object.len() == 3 + usize::from(object.contains_key("onBehalfOf"))
                && object
                    .get("depth")
                    .is_some_and(|value| depth_within(value, 0))
        }
        _ => false,
    };
    if !valid
        || object
            .values()
            .filter_map(Value::as_str)
            .any(|value| value.chars().any(char::is_control))
    {
        return Err(WireError::new(ErrorCode::InvalidParams, "invalid-metadata"));
    }
    for field in [
        "agentId",
        "automationId",
        "humanId",
        "onBehalfOf",
        "agentRunId",
        "principalId",
        "grantId",
    ] {
        if object
            .get(field)
            .and_then(Value::as_str)
            .is_some_and(|value| value.len() > dohc_engine_domain::MAX_AUTHOR_FIELD_BYTES)
        {
            return Err(WireError::new(ErrorCode::InvalidParams, "invalid-metadata"));
        }
    }
    let authors = dohc_engine_domain::moment_author_list_json(value);
    if authors.len() > dohc_engine_domain::MAX_AUTHOR_JSON_BYTES {
        return Err(WireError::new(ErrorCode::InvalidParams, "invalid-metadata"));
    }
    Ok(Some(authors))
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

#[cfg(test)]
mod tests {
    use super::validated_author;
    use serde_json::json;

    #[test]
    fn locally_supplied_author_fields_refuse_control_characters() {
        let agent = json!({"kind":"agent", "agentId":"runner", "onBehalfOf":"person"});
        assert!(validated_author(Some(&agent)).is_ok());
        for field in ["agentId", "onBehalfOf", "agentRunId", "name"] {
            for control in ['\0', '\n', '\u{0085}', '\u{009f}'] {
                let mut invalid = agent.clone();
                invalid[field] = json!(format!("local{control}author"));
                let error = validated_author(Some(&invalid)).expect_err("local controls refused");
                assert_eq!(error.message, "invalid-metadata");
            }
        }
        let automation = json!({"kind":"automation", "automationId":"stamp\u{0085}", "depth":1});
        assert!(validated_author(Some(&automation)).is_err());
    }

    #[test]
    fn locally_supplied_authors_fit_the_moment_identity_and_json_budgets() {
        let agent = json!({"kind":"agent", "agentId":"runner", "onBehalfOf":"person"});
        for field in [
            "agentId",
            "onBehalfOf",
            "agentRunId",
            "principalId",
            "grantId",
        ] {
            let mut bounded = agent.clone();
            bounded[field] = json!("é".repeat(dohc_engine_domain::MAX_AUTHOR_FIELD_BYTES / 2));
            assert!(validated_author(Some(&bounded)).is_ok());
            bounded[field] = json!(format!("{}x", bounded[field].as_str().unwrap()));
            assert!(validated_author(Some(&bounded)).is_err(), "{field}");
        }
        let automation = json!({"kind":"automation", "automationId":"x".repeat(dohc_engine_domain::MAX_AUTHOR_FIELD_BYTES + 1), "depth":1});
        assert!(validated_author(Some(&automation)).is_err());
        let mut oversized = agent;
        oversized["name"] = json!("x".repeat(dohc_engine_domain::MAX_AUTHOR_JSON_BYTES));
        assert!(validated_author(Some(&oversized)).is_err());
    }

    #[test]
    fn an_agent_author_may_name_a_bounded_chain_depth() {
        let agent = json!({"kind": "agent", "agentId": "runner", "onBehalfOf": "local"});
        assert_eq!(
            validated_author(Some(&agent)).expect("a valid agent"),
            Some(json!([agent]).to_string()),
            "the moment records a list of one"
        );
        let mut woken = agent.clone();
        woken["depth"] = json!(3);
        assert!(validated_author(Some(&woken)).is_ok());
        for depth in [
            json!(0),
            json!(-1),
            json!(1.5),
            json!("3"),
            json!(u64::from(dohc_engine_domain::MAX_CHANGE_ATTRIBUTION_DEPTH) + 1),
        ] {
            let mut invalid = agent.clone();
            invalid["depth"] = depth;
            assert!(validated_author(Some(&invalid)).is_err(), "{invalid}");
        }
        let automation = json!({"kind": "automation", "automationId": "collection:Tasks#a", "onBehalfOf": "local"});
        assert!(
            validated_author(Some(&automation)).is_err(),
            "an automation always names its depth"
        );
        let for_nobody =
            json!({"kind": "automation", "automationId": "collection:Tasks#a", "depth": 1});
        assert!(
            validated_author(Some(&for_nobody)).is_ok(),
            "a run with nobody names nobody"
        );
        for invalid in [
            json!({"kind": "automation", "automationId": "collection:Tasks#a", "onBehalfOf": "", "depth": 1}),
            json!({"kind": "automation", "automationId": "collection:Tasks#a", "onBehalfOf": null, "depth": 1}),
            json!({"kind": "automation", "automationId": "collection:Tasks#a", "extra": "x", "depth": 1}),
        ] {
            assert!(validated_author(Some(&invalid)).is_err(), "{invalid}");
        }
    }
}
