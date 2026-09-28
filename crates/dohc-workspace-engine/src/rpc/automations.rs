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
use dohc_engine_domain::AutomationGroupHandover;
use dohc_engine_domain::AutomationGroupHandoverAutomation;
use dohc_engine_domain::AutomationGroupRelayRecord;
use dohc_engine_domain::AutomationGroupSubscription;
use dohc_engine_domain::AutomationGroupWatch;
use dohc_engine_domain::AutomationPress;
use dohc_engine_domain::AutomationPressed;
use dohc_engine_domain::AutomationRetry;
use dohc_engine_domain::AutomationScheduleClaim;
use dohc_engine_domain::AutomationScheduleMark;
use dohc_engine_domain::AutomationSettle;
use dohc_engine_domain::AutomationSubscription;
use dohc_engine_domain::AutomationTrigger;
use dohc_engine_domain::PressActor;
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
struct AutomationReleaseGroupsParams {
    now_ms: Option<i64>,
}

/// Every Group subscription this computer watches, at the automation host
/// generation it runs at. Without `relay`, the caller has not asked the
/// relay.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AutomationWatchGroupsParams {
    generation: i64,
    subscriptions: Vec<AutomationGroupSubscriptionParams>,
    #[serde(default, deserialize_with = "deserialize_optional_non_null")]
    relay: Option<AutomationGroupRelayParams>,
    now_ms: Option<i64>,
}

/// The last release or take over the relay recorded, 0 for none, with the
/// handover when a release left it for this computer.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AutomationGroupRelayParams {
    generation: i64,
    handover: Option<AutomationGroupHandoverParams>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AutomationGroupHandoverParams {
    floor_ms: i64,
    automations: Vec<AutomationGroupHandoverAutomationParams>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AutomationGroupSubscriptionParams {
    automation_id: String,
    group_id: String,
    #[serde(default, deserialize_with = "deserialize_optional_non_null")]
    starts_with: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AutomationGroupHandoverAutomationParams {
    automation_id: String,
    since_ms: i64,
    decided: Vec<AutomationGroupDecidedParams>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AutomationGroupDecidedParams {
    message_id: String,
    created_at_ms: i64,
}

fn group_relay_record(params: AutomationGroupRelayParams) -> AutomationGroupRelayRecord {
    AutomationGroupRelayRecord {
        generation: params.generation,
        handover: params.handover.map(|handover| AutomationGroupHandover {
            floor_ms: handover.floor_ms,
            automations: handover
                .automations
                .into_iter()
                .map(|automation| AutomationGroupHandoverAutomation {
                    automation_id: automation.automation_id,
                    since_ms: automation.since_ms,
                    decided: automation
                        .decided
                        .into_iter()
                        .map(|decided| (decided.message_id, decided.created_at_ms))
                        .collect(),
                })
                .collect(),
        }),
    }
}

fn automation_group_handover_json(handover: &AutomationGroupHandover) -> Value {
    json!({
        "floorMs": handover.floor_ms,
        "automations": handover.automations.iter().map(|automation| json!({
            "automationId": automation.automation_id,
            "sinceMs": automation.since_ms,
            "decided": automation.decided.iter().map(|(message_id, created_at_ms)| json!({
                "messageId": message_id,
                "createdAtMs": created_at_ms,
            })).collect::<Vec<_>>(),
        })).collect::<Vec<_>>(),
    })
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
struct AutomationReleaseParams {
    claim_id: String,
    now_ms: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AutomationListClaimsParams {
    automation_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AutomationPressParams {
    press_id: String,
    automation_id: String,
    record_id: String,
    pressed_by: String,
    by: PressActorParams,
    now_ms: Option<i64>,
}

/// `{ "kind": "human" }`, or `{ "kind": "agent", "originId", "depth" }`.
#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "lowercase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum PressActorParams {
    // An empty struct, not a unit variant: serde's internally tagged unit
    // variant ignores unknown fields, and this one must refuse them.
    Human {},
    Agent { origin_id: String, depth: u32 },
}

impl From<PressActorParams> for PressActor {
    fn from(params: PressActorParams) -> Self {
        match params {
            PressActorParams::Human {} => PressActor::Human,
            PressActorParams::Agent { origin_id, depth } => PressActor::Agent { origin_id, depth },
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AutomationClaimScheduleParams {
    automation_id: String,
    schedule_hash: String,
    run: Vec<i64>,
    through_ms: i64,
    now_ms: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AutomationRunNowParams {
    automation_id: String,
    notice_id: String,
    now_ms: Option<i64>,
}

fn automation_schedule_mark_json(mark: &AutomationScheduleMark) -> Value {
    json!({
        "automationId": mark.automation_id,
        "scheduleHash": mark.schedule_hash,
        "throughMs": mark.through_ms,
    })
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
        AutomationTrigger::Moment { moment_order } => json!({ "momentOrder": moment_order }),
        AutomationTrigger::Key { key } => json!({ "key": key }),
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
            "sharedAuthor": claim.change.shared_author,
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
    if let Some(message) = &facts.message {
        change.insert("message".to_owned(), message.clone());
    }
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

    /// Stop every Group subscription here from claiming, and answer what the
    /// next host needs.
    pub(super) async fn automations_release_groups(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: AutomationReleaseGroupsParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        let released = Self::read_under_ctx(
            &cancellation,
            "automations.releaseGroups",
            open.actor.automation_release_groups(
                open.workspace_id.clone(),
                params.now_ms.unwrap_or(now_ms()?),
                Arc::new(NoFaults),
                cancellation.token(),
            ),
        )
        .await?;
        Ok(json!({
            "watchedGeneration": released.watched_generation,
            "handover": automation_group_handover_json(&released.handover),
        }))
    }

    /// Set every Group subscription this computer watches, taking a new host
    /// generation's handover. Claims for stored messages announce themselves
    /// post-commit.
    pub(super) async fn automations_watch_groups(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: AutomationWatchGroupsParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        let watch = AutomationGroupWatch {
            generation: params.generation,
            subscriptions: params
                .subscriptions
                .into_iter()
                .map(|subscription| AutomationGroupSubscription {
                    automation_id: subscription.automation_id,
                    channel_id: subscription.group_id,
                    starts_with: subscription.starts_with,
                })
                .collect(),
            relay: params.relay.map(group_relay_record),
        };
        let watched = Self::read_under_ctx(
            &cancellation,
            "automations.watchGroups",
            open.actor.automation_watch_groups(
                open.workspace_id.clone(),
                watch,
                params.now_ms.unwrap_or(now_ms()?),
                Arc::new(NoFaults),
                cancellation.token(),
            ),
        )
        .await?;
        emit_automation_claimed(&self.events, &open.workspace_id, &watched.claims);
        Ok(json!({ "needsHandover": watched.needs_handover }))
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

    /// When Group messages last started nothing here because they were
    /// dated ahead of this computer's clock, or arrived after the coverage
    /// floor passed them: this computer's time, or null.
    pub(super) async fn automations_group_skips(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
    ) -> Result<Value, WireError> {
        let open = self.open(handle.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        let skips = Self::read_under_ctx(
            &cancellation,
            "automations.groupSkips",
            open.actor.automation_group_skips(open.workspace_id.clone()),
        )
        .await?;
        Ok(json!({ "aheadAtMs": skips.ahead_at_ms, "lateAtMs": skips.late_at_ms }))
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

    /// An executor hands back a running claim it cannot run yet. The claim
    /// is pending again without an attempt counted. It announces nothing:
    /// the executor released it on purpose and drains again once what held
    /// it clears, so a wake here would only serve it straight back.
    pub(super) async fn automations_release(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: AutomationReleaseParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        let claim = Self::read_under_ctx(
            &cancellation,
            "automations.release",
            open.actor.automation_release(
                open.workspace_id.clone(),
                params.claim_id,
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

    /// A person pressed a Button field. Answers `{ busy, claim }`: the claim
    /// that runs the press, either a new pending claim, which announces
    /// itself post-commit to wake the executor, or the claim this person's
    /// earlier press of the same button on the same record holds. `busy` is
    /// true, with no claim, while the button runs on the record for someone
    /// else. `pressedBy` must be the person main checked, not a value the
    /// renderer sent.
    pub(super) async fn automations_press(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: AutomationPressParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        let pressed = Self::read_under_ctx(
            &cancellation,
            "automations.press",
            open.actor.automation_press(
                open.workspace_id.clone(),
                AutomationPress {
                    press_id: params.press_id,
                    automation_id: params.automation_id,
                    record_id: params.record_id,
                    pressed_by: params.pressed_by,
                    by: params.by.into(),
                },
                params.now_ms.unwrap_or(now_ms()?),
                Arc::new(NoFaults),
                cancellation.token(),
            ),
        )
        .await?;
        let claim = match pressed {
            AutomationPressed::Claimed(claim) => {
                emit_automation_claimed(
                    &self.events,
                    &open.workspace_id,
                    std::slice::from_ref(&claim),
                );
                claim
            }
            AutomationPressed::Joined(claim) => claim,
            AutomationPressed::Busy => {
                return Ok(json!({ "busy": true, "claim": null }));
            }
        };
        Ok(json!({ "busy": false, "claim": automation_claim_json(&claim) }))
    }

    /// The scheduler claims the due times it runs and moves the schedule's
    /// mark past the ones it skips, in one transaction. Answers the new
    /// claims, which announce themselves post-commit, and the mark after the
    /// step.
    pub(super) async fn automations_claim_schedule(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: AutomationClaimScheduleParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        let claimed = Self::read_under_ctx(
            &cancellation,
            "automations.claimSchedule",
            open.actor.automation_claim_schedule(
                open.workspace_id.clone(),
                AutomationScheduleClaim {
                    automation_id: params.automation_id,
                    schedule_hash: params.schedule_hash,
                    run: params.run,
                    through_ms: params.through_ms,
                },
                params.now_ms.unwrap_or(now_ms()?),
                Arc::new(NoFaults),
                cancellation.token(),
            ),
        )
        .await?;
        emit_automation_claimed(&self.events, &open.workspace_id, &claimed.claims);
        Ok(json!({
            "claims": claimed.claims.iter().map(automation_claim_json).collect::<Vec<_>>(),
            "mark": automation_schedule_mark_json(&claimed.mark),
        }))
    }

    /// Run now from a skipped-run notice, once this computer's dismissal was
    /// the notice's first. Answers the notice's claim: a new one announces
    /// itself post-commit, and a repeat answers the one it made before.
    pub(super) async fn automations_run_now(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: AutomationRunNowParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        let run_now = Self::read_under_ctx(
            &cancellation,
            "automations.runNow",
            open.actor.automation_run_now(
                open.workspace_id.clone(),
                params.automation_id,
                params.notice_id,
                params.now_ms.unwrap_or(now_ms()?),
                Arc::new(NoFaults),
                cancellation.token(),
            ),
        )
        .await?;
        if run_now.inserted {
            emit_automation_claimed(
                &self.events,
                &open.workspace_id,
                std::slice::from_ref(&run_now.claim),
            );
        }
        Ok(json!({ "claim": automation_claim_json(&run_now.claim) }))
    }

    /// Every schedule's mark: the scheduler reads them at start to tell the
    /// due times it missed.
    pub(super) async fn automations_schedule_marks(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
    ) -> Result<Value, WireError> {
        let open = self.open(handle.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        let marks = Self::read_under_ctx(
            &cancellation,
            "automations.scheduleMarks",
            open.actor
                .automation_schedule_marks(open.workspace_id.clone()),
        )
        .await?;
        Ok(json!({
            "marks": marks.iter().map(automation_schedule_mark_json).collect::<Vec<_>>(),
        }))
    }
}
