use crate::EngineService;
use crate::events::emit_automation_claimed;
use crate::rpc::request::OperationCancellation;
use crate::rpc::request::deserialize_optional_non_null;
use crate::rpc::request::now_ms;
use crate::rpc::request::parse;
use dohc_engine_domain::AutomationChangeKind;
use dohc_engine_domain::AutomationClaim;
use dohc_engine_domain::AutomationFailure;
use dohc_engine_domain::AutomationFieldFacts;
use dohc_engine_domain::AutomationRetry;
use dohc_engine_domain::AutomationSettle;
use dohc_engine_domain::AutomationSubscription;
use dohc_engine_domain::AutomationTrigger;
use dohc_engine_protocol::error::ErrorCode;
use dohc_engine_protocol::error::WireError;
use dohc_engine_protocol::transport::RequestContext;
use dohc_engine_protocol::wire::WorkspaceHandle;
use dohc_engine_runtime::NoFaults;
use serde::Deserialize;
use serde_json::Value;
use serde_json::json;
use std::sync::Arc;

pub(crate) const AUTOMATION_CLAIM_MAX_ATTEMPTS: i64 = 2;

/// Startup recovery only reclaims a running automation claim idle at least
/// this long. A desktop that outlives a daemon rebind may still be running
/// its handler; a claim younger than this bound is presumed alive and left
/// running rather than double-fired.
pub(crate) const AUTOMATION_CLAIM_REAP_IDLE_MS: i64 = 10 * 60 * 1000;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AutomationSubscribeParams {
    automation_id: String,
    path: String,
    kinds: Vec<AutomationChangeKind>,
    #[serde(default, deserialize_with = "deserialize_optional_non_null")]
    fields: Option<Vec<String>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AutomationUnsubscribeParams {
    automation_id: String,
    path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AutomationClaimNextParams {
    now_ms: Option<i64>,
    automation_id_prefix: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AutomationSettleParams {
    claim_id: String,
    state: String,
    #[serde(default, deserialize_with = "deserialize_optional_non_null")]
    error: Option<String>,
    now_ms: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AutomationRetryParams {
    claim_id: String,
    now_ms: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AutomationListClaimsParams {
    automation_id: String,
}

fn automation_failure_json(failure: &AutomationFailure) -> Value {
    json!({
        "automationId": failure.automation_id,
        "claimId": failure.claim_id,
        "chainStopped": failure.chain_stopped,
        "error": failure.error,
        "updatedAtMs": failure.updated_at_ms,
        "generation": failure.generation,
    })
}

/// A claim without its field facts: what `automation.claimed`, settle,
/// retry, and the claim history carry.
pub(crate) fn automation_claim_json(claim: &AutomationClaim) -> Value {
    let trigger = match &claim.trigger {
        AutomationTrigger::Coordinate {
            origin_id,
            origin_seq,
        } => json!({ "originId": origin_id, "originSeq": origin_seq }),
        AutomationTrigger::History { history_id } => json!({ "historyId": history_id }),
    };
    let mut value = json!({
        "claimId": claim.claim_id,
        "automationId": claim.automation_id,
        "trigger": trigger,
        "recordId": claim.record_id,
        "collectionPath": claim.collection_path,
        "depth": claim.depth,
        "change": {
            "kind": claim.change.kind.as_str(),
            "authorOriginId": claim.change.author_origin_id,
            "actorKind": claim.change.actor_kind.map(|kind| kind.as_str()),
            "onBehalfOf": claim.change.on_behalf_of,
        },
        "state": claim.state.as_str(),
        "attempts": claim.attempts,
        "run": claim.run,
        "createdAtMs": claim.created_at_ms,
        "updatedAtMs": claim.updated_at_ms,
    });
    if let Some(error) = &claim.error {
        let object = value.as_object_mut().expect("claim is an object");
        object.insert("error".to_owned(), json!(error));
    }
    value
}

/// A claim `claimNext` serves: the claim plus its change's field facts.
fn served_automation_claim_json(claim: &AutomationClaim, facts: &AutomationFieldFacts) -> Value {
    let mut value = automation_claim_json(claim);
    let change = value["change"]
        .as_object_mut()
        .expect("claim change is an object");
    change.insert("fields".to_owned(), json!(facts.fields));
    change.insert("fieldsOmitted".to_owned(), json!(facts.omitted));
    value
}

impl EngineService {
    pub(super) async fn automations_subscribe(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: AutomationSubscribeParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        let subscribed = Self::read_under_ctx(
            &cancellation,
            "automations.subscribe",
            open.actor.automation_subscribe(
                open.workspace_id.clone(),
                AutomationSubscription {
                    automation_id: params.automation_id,
                    prefix: params.path,
                    kinds: params.kinds,
                    fields: params.fields,
                },
                now_ms()?,
                Arc::new(NoFaults),
                cancellation.token(),
            ),
        )
        .await?;
        Ok(json!({ "subscribed": subscribed }))
    }

    pub(super) async fn automations_unsubscribe(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: AutomationUnsubscribeParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        let unsubscribed = Self::read_under_ctx(
            &cancellation,
            "automations.unsubscribe",
            open.actor.automation_unsubscribe(
                open.workspace_id.clone(),
                params.automation_id,
                params.path,
                Arc::new(NoFaults),
                cancellation.token(),
            ),
        )
        .await?;
        Ok(json!({ "unsubscribed": unsubscribed }))
    }

    pub(super) async fn automations_claim_next(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: AutomationClaimNextParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        let served = Self::read_under_ctx(
            &cancellation,
            "automations.claimNext",
            open.actor.automation_claim_next(
                open.workspace_id.clone(),
                params.automation_id_prefix,
                params.now_ms.unwrap_or(now_ms()?),
                Arc::new(NoFaults),
                cancellation.token(),
            ),
        )
        .await?;
        Ok(served
            .as_ref()
            .map(|(claim, facts)| served_automation_claim_json(claim, facts))
            .unwrap_or(Value::Null))
    }

    /// The owner-visible failure surface's read: one row per automation
    /// with at least one failed claim (chain-stopped, handler error, or
    /// reaper-exhausted), carrying the newest error and a generation the
    /// desktop acknowledges against. The generation counts every failure of
    /// the automation's claims, so it only grows.
    pub(super) async fn automations_failures(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
    ) -> Result<Value, WireError> {
        let open = self.open(handle.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        let failures = Self::read_under_ctx(
            &cancellation,
            "automations.failures",
            open.actor.automation_failures(open.workspace_id.clone()),
        )
        .await?;
        Ok(json!({
            "failures": failures
                .iter()
                .map(automation_failure_json)
                .collect::<Vec<_>>(),
        }))
    }

    /// One automation's run history: its newest claims in every state,
    /// newest first, without field facts.
    pub(super) async fn automations_list_claims(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: AutomationListClaimsParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        let claims = Self::read_under_ctx(
            &cancellation,
            "automations.listClaims",
            open.actor
                .automation_claims(open.workspace_id.clone(), params.automation_id),
        )
        .await?;
        Ok(json!({
            "claims": claims.iter().map(automation_claim_json).collect::<Vec<_>>(),
        }))
    }

    pub(super) async fn automations_settle(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: AutomationSettleParams = parse(params)?;
        let settle = match (params.state.as_str(), params.error) {
            ("done", None) => AutomationSettle::Done,
            ("done", Some(_)) => {
                return Err(WireError::new(
                    ErrorCode::InvalidParams,
                    "automation-settle-done-carries-error",
                ));
            }
            ("failed", Some(error)) => AutomationSettle::Failed { error },
            ("failed", None) => {
                return Err(WireError::new(
                    ErrorCode::InvalidParams,
                    "automation-settle-failed-needs-error",
                ));
            }
            _ => {
                return Err(WireError::new(
                    ErrorCode::InvalidParams,
                    "automation-settle-state-unknown",
                ));
            }
        };
        let open = self.open(handle.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        let claim = Self::read_under_ctx(
            &cancellation,
            "automations.settle",
            open.actor.automation_settle(
                open.workspace_id.clone(),
                params.claim_id,
                settle,
                params.now_ms.unwrap_or(now_ms()?),
                Arc::new(NoFaults),
                cancellation.token(),
            ),
        )
        .await?;
        Ok(automation_claim_json(&claim))
    }

    /// The owner's re-run: a failed claim goes back to pending as its next
    /// run, with the facts it already holds. A requeued claim announces
    /// itself post-commit like a new one, which wakes the executor and tells
    /// the failure surface to re-read.
    pub(super) async fn automations_retry(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: AutomationRetryParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        let retry = Self::read_under_ctx(
            &cancellation,
            "automations.retry",
            open.actor.automation_retry(
                open.workspace_id.clone(),
                params.claim_id,
                params.now_ms.unwrap_or(now_ms()?),
                Arc::new(NoFaults),
                cancellation.token(),
            ),
        )
        .await?;
        let claim = match retry {
            AutomationRetry::Requeued(claim) => {
                emit_automation_claimed(
                    &self.events,
                    &open.workspace_id,
                    std::slice::from_ref(&claim),
                );
                claim
            }
            AutomationRetry::Unchanged(claim) => claim,
        };
        Ok(automation_claim_json(&claim))
    }
}
