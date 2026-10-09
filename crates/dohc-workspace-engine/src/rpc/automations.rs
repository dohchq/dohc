use crate::EngineService;
use crate::events::emit_automation_claimed;
use crate::lock;
use crate::rpc::error::map_runtime;
use crate::rpc::request::OperationCancellation;
use crate::rpc::request::deserialize_optional_non_null;
use crate::rpc::request::now_ms;
use crate::rpc::request::parse;
use dohc_engine_domain::AutomationChangeKind;
use dohc_engine_domain::AutomationClaim;
use dohc_engine_domain::AutomationClaimCursor;
use dohc_engine_domain::AutomationClaimLookup;
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
use dohc_engine_runtime::{ActorHandle, CancellationToken};
use serde::Deserialize;
use serde_json::Value;
use serde_json::json;
use std::sync::{Arc, Mutex};
use tokio::sync::oneshot;

struct DurabilityRequest {
    claim_id: Option<String>,
    token: CancellationToken,
    reply: oneshot::Sender<Result<(), WireError>>,
}

#[derive(Default)]
struct DurabilityState {
    running: bool,
    pending: Vec<DurabilityRequest>,
}

/// One active barrier and one following batch. A caller arriving during the
/// active sync waits for the following one, which covers its earlier writes.
#[derive(Clone, Default)]
pub(super) struct DurabilityQueue(Arc<Mutex<DurabilityState>>);

impl DurabilityQueue {
    fn submit(
        &self,
        actor: ActorHandle,
        workspace_id: String,
        claim_id: Option<String>,
        token: CancellationToken,
    ) -> oneshot::Receiver<Result<(), WireError>> {
        self.submit_with(claim_id, token, move |claims| {
            let actor = actor.clone();
            let workspace_id = workspace_id.clone();
            async move {
                actor
                    .automation_make_durable_batch(workspace_id, claims, Arc::new(NoFaults))
                    .await
                    .map(|results| {
                        results
                            .into_iter()
                            .map(|result| result.map_err(map_runtime))
                            .collect()
                    })
                    .map_err(map_runtime)
            }
        })
    }

    fn submit_with<F, Fut>(
        &self,
        claim_id: Option<String>,
        token: CancellationToken,
        mut work: F,
    ) -> oneshot::Receiver<Result<(), WireError>>
    where
        F: FnMut(Vec<(Option<String>, CancellationToken)>) -> Fut + Send + 'static,
        Fut: std::future::Future<Output = Result<Vec<Result<(), WireError>>, WireError>> + Send,
    {
        let (reply, receiver) = oneshot::channel();
        let mut state = lock(&self.0);
        state.pending.push(DurabilityRequest {
            claim_id,
            token,
            reply,
        });
        if !state.running {
            state.running = true;
            let queue = self.clone();
            tokio::spawn(async move {
                loop {
                    let requests = std::mem::take(&mut lock(&queue.0).pending);
                    let claims = requests
                        .iter()
                        .map(|request| (request.claim_id.clone(), request.token.clone()))
                        .collect();
                    let result = work(claims).await;
                    match result {
                        Ok(results) => {
                            for (request, result) in requests.into_iter().zip(results) {
                                let _ = request.reply.send(result);
                            }
                        }
                        Err(error) => {
                            for request in requests {
                                let _ = request.reply.send(Err(error.clone()));
                            }
                        }
                    }
                    let mut state = lock(&queue.0);
                    if state.pending.is_empty() {
                        state.running = false;
                        break;
                    }
                }
            });
        }
        receiver
    }
}

#[cfg(test)]
mod durability_tests {
    use super::*;
    type Batch = (
        Vec<(Option<String>, CancellationToken)>,
        oneshot::Sender<Result<Vec<Result<(), WireError>>, WireError>>,
    );

    fn enqueue(
        queue: &DurabilityQueue,
        batches: tokio::sync::mpsc::UnboundedSender<Batch>,
        claim: &str,
        token: CancellationToken,
    ) -> oneshot::Receiver<Result<(), WireError>> {
        queue.submit_with(Some(claim.into()), token, move |claims| {
            let batches = batches.clone();
            async move {
                let (finish, done) = oneshot::channel();
                batches.send((claims, finish)).unwrap();
                done.await.unwrap()
            }
        })
    }

    #[tokio::test]
    async fn durability_queue_late_callers_share_the_following_barrier() {
        let queue = DurabilityQueue::default();
        let (send, mut batches) = tokio::sync::mpsc::unbounded_channel();
        let first = enqueue(&queue, send.clone(), "first", CancellationToken::new());
        let (claims, finish) = batches.recv().await.unwrap();
        assert_eq!(claims.len(), 1);
        let mut second = enqueue(&queue, send.clone(), "second", CancellationToken::new());
        let third = enqueue(&queue, send.clone(), "third", CancellationToken::new());
        finish.send(Ok(vec![Ok(())])).unwrap();
        first.await.unwrap().unwrap();
        let (claims, finish) = batches.recv().await.unwrap();
        assert_eq!(
            claims
                .iter()
                .map(|(claim, _)| claim.as_deref().unwrap())
                .collect::<Vec<_>>(),
            ["second", "third"]
        );
        assert!(matches!(
            second.try_recv(),
            Err(oneshot::error::TryRecvError::Empty)
        ));
        finish.send(Ok(vec![Ok(()), Ok(())])).unwrap();
        second.await.unwrap().unwrap();
        third.await.unwrap().unwrap();
        assert!(!lock(&queue.0).running);
        assert!(batches.try_recv().is_err());
    }

    #[tokio::test]
    async fn durability_queue_failure_and_cancelled_caller_do_not_strand_followers() {
        let queue = DurabilityQueue::default();
        let (send, mut batches) = tokio::sync::mpsc::unbounded_channel();
        let first = enqueue(&queue, send.clone(), "first", CancellationToken::new());
        let (_, finish) = batches.recv().await.unwrap();
        let cancelled = CancellationToken::new();
        let abandoned = enqueue(&queue, send.clone(), "cancelled", cancelled.clone());
        let follower = enqueue(&queue, send, "follower", CancellationToken::new());
        cancelled.cancel();
        drop(abandoned);
        finish
            .send(Err(WireError::new(ErrorCode::Internal, "sync failed")))
            .unwrap();
        assert_eq!(first.await.unwrap().unwrap_err().message, "sync failed");
        let (claims, finish) = batches.recv().await.unwrap();
        assert!(claims[0].1.is_cancelled());
        assert!(!claims[1].1.is_cancelled());
        finish
            .send(Ok(vec![
                Err(WireError::new(ErrorCode::Cancelled, "cancelled")),
                Ok(()),
            ]))
            .unwrap();
        follower.await.unwrap().unwrap();
        assert!(!lock(&queue.0).running);
    }

    #[tokio::test]
    #[ignore = "machine-local barrier contention measurement"]
    async fn durability_queue_contention_cost() {
        use dohc_engine_domain::WriteText;
        use dohc_engine_storage::FaultPoint;
        use dohc_engine_testkit::{GateFaults, ScratchDir};
        use std::future::{Future, poll_fn};
        use std::pin::Pin;
        use std::task::Poll;
        use std::time::Instant;

        let scratch = ScratchDir::new().unwrap();
        let service = EngineService::new();
        let ctx = RequestContext::unbounded();
        let opened = service.workspace_open(&ctx, json!({"rootDir": scratch.path().to_string_lossy(), "workspaceId": "contention", "captureMode": "none"})).await.unwrap();
        let handle: WorkspaceHandle = serde_json::from_value(opened["workspace"].clone()).unwrap();
        let open = service.open(Some(&handle)).unwrap();
        for pair in -1..30_i32 {
            let arms = if pair % 2 == 0 {
                ["A", "B"]
            } else {
                ["B", "A"]
            };
            for arm in arms {
                // Hold a NORMAL write so every request is queued before timing.
                let gate = GateFaults::at(FaultPoint::StorageBeforePersist);
                let actor = open.actor.clone();
                let held_gate = gate.clone();
                let held = tokio::spawn(async move {
                    actor
                        .versioned_text_write(
                            WriteText {
                                workspace_id: "contention".into(),
                                version_id: "main".into(),
                                object_id: "held".into(),
                                path: "held.md".into(),
                                text: format!("{pair}/{arm}"),
                                moment_id: format!("{pair}/{arm}"),
                                metadata_origin: "api".into(),
                                metadata_summary: None,
                                metadata_correlation_id: None,
                                author_json: None,
                                now_ms: 1,
                                request_id: None,
                            },
                            held_gate,
                            CancellationToken::new(),
                        )
                        .await
                        .unwrap();
                });
                let wait = gate.clone();
                tokio::task::spawn_blocking(move || wait.wait_until_reached())
                    .await
                    .unwrap();
                type Reply = Pin<Box<dyn Future<Output = Result<(), WireError>>>>;
                let mut replies: Vec<Reply> = Vec::new();
                if arm == "A" {
                    for _ in 0..16 {
                        let actor = open.actor.clone();
                        let mut reply: Reply = Box::pin(async move {
                            actor
                                .automation_make_durable_batch(
                                    "contention".into(),
                                    vec![(None, CancellationToken::new())],
                                    Arc::new(NoFaults),
                                )
                                .await
                                .map_err(map_runtime)?
                                .pop()
                                .unwrap()
                                .map_err(map_runtime)
                        });
                        poll_fn(|cx| {
                            assert!(reply.as_mut().poll(cx).is_pending());
                            Poll::Ready(())
                        })
                        .await;
                        replies.push(reply);
                    }
                } else {
                    let first = open.durability.submit(
                        open.actor.clone(),
                        "contention".into(),
                        None,
                        CancellationToken::new(),
                    );
                    tokio::task::yield_now().await;
                    assert!(lock(&open.durability.0).pending.is_empty());
                    replies.push(Box::pin(async move { first.await.unwrap() }));
                    for _ in 1..16 {
                        let reply = open.durability.submit(
                            open.actor.clone(),
                            "contention".into(),
                            None,
                            CancellationToken::new(),
                        );
                        replies.push(Box::pin(async move { reply.await.unwrap() }));
                    }
                }
                let mut read = Box::pin(open.actor.automation_claims(
                    "contention".into(),
                    "unrelated".into(),
                    None,
                    20,
                ));
                poll_fn(|cx| {
                    assert!(read.as_mut().poll(cx).is_pending());
                    Poll::Ready(())
                })
                .await;
                println!("contention_start={}", json!({"pair":pair,"arm":arm}));
                let start = Instant::now();
                gate.release();
                read.await.unwrap();
                let read_ms = start.elapsed().as_secs_f64() * 1000.0;
                for reply in replies {
                    reply.await.unwrap();
                }
                held.await.unwrap();
                println!(
                    "contention_sample={}",
                    json!({"pair":pair,"arm":arm,"readMs":read_ms,"allBarriersMs":start.elapsed().as_secs_f64()*1000.0,"barriers":if arm=="A"{16}else{2}})
                );
            }
        }
        drop(open);
        service.workspace_close(Some(handle)).await.unwrap();
    }
}

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
struct AutomationMakeDurableParams {
    #[serde(default, deserialize_with = "deserialize_optional_non_null")]
    claim_id: Option<String>,
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
    #[serde(default, deserialize_with = "deserialize_optional_non_null")]
    before: Option<String>,
    #[serde(default, deserialize_with = "deserialize_optional_non_null")]
    limit: Option<i64>,
}

// A claim by its id, or by the trigger key it claimed under.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AutomationGetClaimParams {
    #[serde(default, deserialize_with = "deserialize_optional_non_null")]
    claim_id: Option<String>,
    #[serde(default, deserialize_with = "deserialize_optional_non_null")]
    automation_id: Option<String>,
    #[serde(default, deserialize_with = "deserialize_optional_non_null")]
    key: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AutomationPruneHistoryParams {
    keep: Vec<String>,
    now_ms: Option<i64>,
}

/// The claims a page of run history holds when the caller names no limit.
const AUTOMATION_CLAIM_PAGE_DEFAULT: i64 = 20;

/// A run history cursor on the wire: `<created ms>:<claim id>`.
fn automation_claim_cursor_json(cursor: &AutomationClaimCursor) -> String {
    format!("{}:{}", cursor.created_at_ms, cursor.claim_id)
}

fn parse_automation_claim_cursor(cursor: &str) -> Result<AutomationClaimCursor, WireError> {
    cursor
        .split_once(':')
        .and_then(|(created_at_ms, claim_id)| {
            Some(AutomationClaimCursor {
                created_at_ms: created_at_ms.parse().ok()?,
                claim_id: claim_id.to_owned(),
            })
        })
        .filter(|cursor| !cursor.claim_id.is_empty())
        .ok_or_else(|| WireError::new(ErrorCode::InvalidParams, "automation-claim-cursor-invalid"))
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
            "liveCursor": claim.change.live_cursor,
        },
        "state": claim.state.as_str(),
        "attempts": claim.attempts,
        "run": claim.run,
        "createdAtMs": claim.created_at_ms,
        "updatedAtMs": claim.updated_at_ms,
    });
    if let Some(parent) = &claim.parent_claim_id {
        value
            .as_object_mut()
            .expect("claim is an object")
            .insert("parentClaimId".to_owned(), json!(parent));
    }
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

    /// One page of an automation's run history: its claims in every state,
    /// newest first, without field facts, and the cursor of the next page.
    pub(super) async fn automations_list_claims(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: AutomationListClaimsParams = parse(params)?;
        let before = params
            .before
            .as_deref()
            .map(parse_automation_claim_cursor)
            .transpose()?;
        let open = self.open(handle.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        let page = Self::read_under_ctx(
            &cancellation,
            "automations.listClaims",
            open.actor.automation_claims(
                open.workspace_id.clone(),
                params.automation_id,
                before,
                params.limit.unwrap_or(AUTOMATION_CLAIM_PAGE_DEFAULT),
            ),
        )
        .await?;
        Ok(json!({
            "claims": page.claims.iter().map(automation_claim_json).collect::<Vec<_>>(),
            "next": page.next.as_ref().map(automation_claim_cursor_json),
        }))
    }

    /// One claim in run history, by its id or by its automation and trigger
    /// key, however old: `{ claim }`, null when history has none.
    pub(super) async fn automations_get_claim(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: AutomationGetClaimParams = parse(params)?;
        let lookup = match (params.claim_id, params.automation_id, params.key) {
            (Some(claim_id), None, None) => AutomationClaimLookup::Id(claim_id),
            (None, Some(automation_id), Some(key)) => {
                AutomationClaimLookup::Key { automation_id, key }
            }
            _ => {
                return Err(WireError::new(
                    ErrorCode::InvalidParams,
                    "automation-get-claim-names-one-claim",
                ));
            }
        };
        let open = self.open(handle.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        let claim = Self::read_under_ctx(
            &cancellation,
            "automations.getClaim",
            open.actor
                .automation_claim(open.workspace_id.clone(), lookup),
        )
        .await?;
        Ok(json!({ "claim": claim.as_ref().map(automation_claim_json) }))
    }

    /// Expire the workspace's done claims past 30 days, one batch, except
    /// those `keep` names: `{ pruned, more }`. Call again while `more`.
    pub(super) async fn automations_prune_history(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: AutomationPruneHistoryParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        let pruned = Self::read_under_ctx(
            &cancellation,
            "automations.pruneHistory",
            open.actor.automation_prune_history(
                open.workspace_id.clone(),
                params.keep,
                params.now_ms.unwrap_or(now_ms()?),
                Arc::new(NoFaults),
                cancellation.token(),
            ),
        )
        .await?;
        Ok(json!({ "pruned": pruned.pruned, "more": pruned.more }))
    }

    pub(super) async fn automations_make_durable(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: AutomationMakeDurableParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        let reply = open.durability.submit(
            open.actor.clone(),
            open.workspace_id.clone(),
            params.claim_id,
            cancellation.token(),
        );
        let token = cancellation.token();
        tokio::select! {
            biased;
            () = token.cancelled() => return Err(cancellation.interruption("automations.makeDurable")),
            result = reply => result.map_err(|_| WireError::new(ErrorCode::WorkspaceUnavailable, "workspace actor is unavailable"))??,
        }
        Ok(json!({}))
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
