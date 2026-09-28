use crate::EngineService;
use crate::lock;
use crate::rpc::automations::automation_claim_json;
use dohc_engine_domain::AutomationClaim;
use serde_json::Value;
use serde_json::json;
use std::sync::Arc;
use std::sync::Mutex;

/// Emitted once per settled capture batch / reconcile pass that settled any
/// path — a repaint ping, not a moment ledger. Most emissions follow new
/// moment rows (ingests, retires, policy/non-ownable/secret untracks), but
/// content-equality dedupes and no-op retires fire it too: the renderer
/// re-lists cheaply, and under-notifying is the staleness bug this event
/// exists to prevent. In daemon mode no TS write path runs, so nothing else
/// announces these writes.
pub const CAPTURE_MOMENT_RECORDED_EVENT: &str = "capture.momentRecorded";

/// Advisory wake-up after initial capture leaves Starting or Importing.
/// The payload identifies the workspace; callers must retry their fenced read.
/// Delivery can be dropped, so subscribers retain their retry timer.
pub const CAPTURE_INITIAL_SETTLED_EVENT: &str = "capture.initialSettled";

/// Sent once per workspace per engine process when a placement there had to
/// fall back to a check-then-rename, because the drive has no atomic rename
/// that refuses to replace. The payload names the workspace. Delivery can be
/// dropped; `watcher.status` reports the same fact as `noAtomicPlacement`.
pub const CAPTURE_NO_ATOMIC_PLACEMENT_EVENT: &str = "capture.noAtomicPlacement";

/// Record events fire on every device as that device's engine applies an
/// update — local `ydoc.recordUpdate` and pulled replication alike. One
/// applied update emits together: `record.created` first, then
/// `record.field.changed` in field-name order, then one `record.updated`.
/// Delivery is at most once (the emitter drops under backpressure); every
/// `record.field.changed` carries the device's history row id so a
/// subscriber that missed events reads history past its last seen id.
pub const RECORD_CREATED_EVENT: &str = "record.created";

pub const RECORD_UPDATED_EVENT: &str = "record.updated";

pub const RECORD_FIELD_CHANGED_EVENT: &str = "record.field.changed";

/// Emitted post-commit, once per automation claim a local record apply
/// inserted (ADR 0008: only the origin device claims). A wake-up, not the
/// claim transport: delivery is at most once, and the durable claim row is
/// what `automations.claimNext` and `automations.failures` serve — a missed
/// event costs a poll, never a claim. The payload is the claim without its
/// field facts. A pending claim wakes the desktop's drain loop; a claim
/// inserted already failed (`chain-stopped`, the depth cap's stop report)
/// tells the owner surface to re-read `automations.failures`.
pub const AUTOMATION_CLAIMED_EVENT: &str = "automation.claimed";

/// An engine-initiated notification for the transport host to deliver as a
/// wire `Event` envelope. The service assigns only the NAME and PAYLOAD;
/// the per-session `seq`/`sessionGeneration` belong to the transport.
#[derive(Debug, Clone, PartialEq)]
pub struct EngineEventNotice {
    pub name: String,
    pub payload: Value,
}

/// How many undelivered notices the service-to-transport queue holds before
/// new ones are DROPPED. Subscribers recover through reads or retry timers;
/// a stalled transport must not grow the daemon without bound.
pub(super) const ENGINE_EVENT_QUEUE_CAPACITY: usize = 256;

/// Cloneable emitter handle shared between the service and its background
/// tasks (the capture driver). At most one subscriber (the stdio host); with
/// no subscriber, notices are dropped — an embedded in-process host that
/// never subscribes owes no drain.
#[derive(Clone, Default)]
pub struct EngineEvents {
    pub(super) subscriber: Arc<Mutex<Option<tokio::sync::mpsc::Sender<EngineEventNotice>>>>,
}

impl EngineEvents {
    /// Route subsequent notices to the returned receiver, replacing any
    /// previous subscriber. The channel is BOUNDED: a transport that stops
    /// draining (blocked Electron main thread) sheds notices instead of
    /// accumulating them, and the ones already queued make the eventual
    /// drain repaint anyway.
    pub fn subscribe(&self) -> tokio::sync::mpsc::Receiver<EngineEventNotice> {
        let (tx, rx) = tokio::sync::mpsc::channel(ENGINE_EVENT_QUEUE_CAPACITY);
        *lock(&self.subscriber) = Some(tx);
        rx
    }

    pub(crate) fn emit(&self, name: &str, payload: Value) {
        let mut subscriber = lock(&self.subscriber);
        let Some(tx) = subscriber.as_ref() else {
            return;
        };
        match tx.try_send(EngineEventNotice {
            name: name.to_owned(),
            payload,
        }) {
            // A full queue sheds the notice (see `subscribe`); the emitter
            // must never block a capture apply on a stalled transport.
            Ok(()) | Err(tokio::sync::mpsc::error::TrySendError::Full(_)) => {}
            Err(tokio::sync::mpsc::error::TrySendError::Closed(_)) => {
                // The receiver is gone; drop it so later emits stop cloning
                // payloads into a dead channel.
                *subscriber = None;
            }
        }
    }
}

/// One event value: the stored history JSON parsed whole, `null` for an
/// absent side of the change, or `{ "truncated": true, "bytes": N }` for a
/// value past the field fact bounds (`field_fact_value`): the subscriber
/// reads the record for the whole value.
fn record_event_value(json: Option<&str>) -> Value {
    let Some(json) = json else {
        return Value::Null;
    };
    dohc_engine_domain::field_fact_value(json)
        .unwrap_or_else(|| json!({ "truncated": true, "bytes": json.len() }))
}

/// Emit `automation.claimed` post-commit for each claim a local apply
/// inserted or a retry requeued, in order. The payload is the claim row plus its
/// workspace — enough for the desktop to route the wake-up without a read.
pub(super) fn emit_automation_claimed(
    events: &EngineEvents,
    workspace_id: &str,
    claims: &[AutomationClaim],
) {
    for claim in claims {
        let mut payload = automation_claim_json(claim);
        let object = payload.as_object_mut().expect("claim is an object");
        object.insert("workspaceId".to_owned(), json!(workspace_id));
        events.emit(AUTOMATION_CLAIMED_EVENT, payload);
    }
}

/// Emit one applied update's record events, post-commit, in the settled
/// order: created, field changes in field-name order, then updated.
pub(super) fn emit_record_events(
    events: &EngineEvents,
    workspace_id: &str,
    facts: &dohc_engine_domain::CollectionRecordApplyFacts,
) {
    let record = |payload: &mut serde_json::Map<String, Value>| {
        payload.insert("workspaceId".to_owned(), json!(workspace_id));
        payload.insert(
            "collectionPath".to_owned(),
            json!(facts.collection_path.clone()),
        );
        payload.insert("recordId".to_owned(), json!(facts.record_id.clone()));
        payload.insert("author".to_owned(), json!(facts.author_origin_id.clone()));
        payload.insert("timestamp".to_owned(), json!(facts.recorded_at_ms));
        // Declared attribution and the op's replication coordinate, `null`
        // when absent: the automation executor and loop guard read these, and
        // a subscriber must be able to tell "unattributed" from "missing".
        let attribution = facts.attribution.as_ref();
        payload.insert(
            "actorKind".to_owned(),
            json!(attribution.map(|attribution| attribution.actor_kind.as_str())),
        );
        payload.insert(
            "onBehalfOf".to_owned(),
            json!(attribution.and_then(|attribution| attribution.on_behalf_of.clone())),
        );
        payload.insert(
            "depth".to_owned(),
            json!(attribution.map(|attribution| attribution.depth)),
        );
        payload.insert(
            "source".to_owned(),
            json!(facts.source.as_ref().map(|(origin_id, origin_seq)| {
                json!({ "originId": origin_id, "originSeq": origin_seq })
            })),
        );
    };
    let record_payload = || {
        let mut payload = serde_json::Map::new();
        record(&mut payload);
        Value::Object(payload)
    };
    if facts.created {
        events.emit(RECORD_CREATED_EVENT, record_payload());
    }
    for field in &facts.fields {
        let mut payload = serde_json::Map::new();
        record(&mut payload);
        payload.insert("field".to_owned(), json!(field.field_name.clone()));
        payload.insert(
            "previous".to_owned(),
            record_event_value(field.previous_json.as_deref()),
        );
        payload.insert(
            "next".to_owned(),
            record_event_value(field.next_json.as_deref()),
        );
        payload.insert("historyId".to_owned(), json!(field.history_id));
        events.emit(RECORD_FIELD_CHANGED_EVENT, Value::Object(payload));
    }
    events.emit(RECORD_UPDATED_EVENT, record_payload());
}

impl EngineService {
    /// The service's event emitter. The transport host subscribes once and
    /// forwards notices to the connected client as wire `Event` envelopes.
    pub fn events(&self) -> EngineEvents {
        self.events.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    use serde_json::json;

    #[tokio::test]
    async fn engine_events_shed_instead_of_growing_when_the_subscriber_stalls() {
        // An unbounded notice queue under a stalled transport
        // grows the daemon without bound. The channel is bounded and emit
        // never blocks: overflow is shed (the queued backlog already
        // guarantees a repaint on drain).
        let events = EngineEvents::default();
        let mut rx = events.subscribe();
        for i in 0..(ENGINE_EVENT_QUEUE_CAPACITY + 10) {
            events.emit(CAPTURE_MOMENT_RECORDED_EVENT, json!({ "i": i }));
        }
        let mut drained = 0usize;
        while rx.try_recv().is_ok() {
            drained += 1;
        }
        assert_eq!(
            drained, ENGINE_EVENT_QUEUE_CAPACITY,
            "emit must shed past the bound, not queue unboundedly"
        );
    }

    #[test]
    fn automation_claimed_events_carry_the_claim_and_its_workspace() {
        let events = EngineEvents::default();
        let mut rx = events.subscribe();
        let claims = vec![
            dohc_engine_domain::AutomationClaim {
                claim_id: "atc_one".to_owned(),
                automation_id: "collection:tasks#triage".to_owned(),
                trigger: dohc_engine_domain::AutomationTrigger::Coordinate {
                    origin_id: "origin-a".to_owned(),
                    origin_seq: 41,
                },
                record_id: Some("rec_a".to_owned()),
                collection_path: Some("tasks".to_owned()),
                depth: 1,
                change: dohc_engine_domain::AutomationChange {
                    shared_author: None,
                    live_cursor: None,
                    kind: dohc_engine_domain::AutomationChangeKind::Changed,
                    author_origin_id: Some("agent-editor".to_owned()),
                    actor_kind: Some(dohc_engine_domain::ChangeActorKind::Agent),
                    on_behalf_of: Some("user:ice".to_owned()),
                },
                state: dohc_engine_domain::AutomationClaimState::Pending,
                attempts: 0,
                run: 1,
                error: None,
                created_at_ms: 1_100,
                updated_at_ms: 1_100,
            },
            dohc_engine_domain::AutomationClaim {
                claim_id: "atc_two".to_owned(),
                automation_id: "collection:tasks#janitor".to_owned(),
                trigger: dohc_engine_domain::AutomationTrigger::History { history_id: 7 },
                record_id: Some("rec_a".to_owned()),
                collection_path: Some("tasks".to_owned()),
                depth: 0,
                change: dohc_engine_domain::AutomationChange {
                    shared_author: None,
                    live_cursor: None,
                    kind: dohc_engine_domain::AutomationChangeKind::Added,
                    author_origin_id: None,
                    actor_kind: None,
                    on_behalf_of: None,
                },
                state: dohc_engine_domain::AutomationClaimState::Pending,
                attempts: 0,
                run: 1,
                error: None,
                created_at_ms: 1_100,
                updated_at_ms: 1_100,
            },
        ];

        emit_automation_claimed(&events, "ws-1", &claims);

        let mut notices = Vec::new();
        while let Ok(notice) = rx.try_recv() {
            notices.push(notice);
        }
        assert_eq!(notices.len(), 2, "one event per inserted claim, in order");
        assert!(
            notices
                .iter()
                .all(|notice| notice.name == AUTOMATION_CLAIMED_EVENT)
        );
        assert_eq!(
            notices[0].payload,
            json!({
                "workspaceId": "ws-1",
                "claimId": "atc_one",
                "automationId": "collection:tasks#triage",
                "trigger": { "originId": "origin-a", "originSeq": 41 },
                "recordId": "rec_a",
                "collectionPath": "tasks",
                "depth": 1,
                "change": {
                    "kind": "changed",
                    "authorOriginId": "agent-editor",
                    "actorKind": "agent",
                    "onBehalfOf": "user:ice",
                    "sharedAuthor": null,
                    "liveCursor": null,
                },
                "state": "pending",
                "attempts": 0,
                "run": 1,
                "createdAtMs": 1_100,
                "updatedAtMs": 1_100,
            }),
            "the wake-up carries the claim without its field facts"
        );
        assert_eq!(
            notices[1].payload["trigger"],
            json!({ "historyId": 7 }),
            "a never-synced trigger names its history row id"
        );
        assert_eq!(
            notices[1].payload["change"],
            json!({
                "kind": "added",
                "authorOriginId": null,
                "actorKind": null,
                "onBehalfOf": null,
                "sharedAuthor": null,
                "liveCursor": null,
            }),
            "an undeclared actor travels as nulls"
        );
    }

    #[test]
    fn record_events_emit_in_settled_order_and_cap_oversized_values() {
        let events = EngineEvents::default();
        let mut rx = events.subscribe();
        let big = format!(
            "\"{}\"",
            "x".repeat(dohc_engine_domain::MAX_FIELD_FACT_VALUE_BYTES)
        );
        let facts = dohc_engine_domain::CollectionRecordApplyFacts {
            shared_author: None,
            live_cursor: None,
            collection_path: "tasks".to_owned(),
            record_id: "rec_a".to_owned(),
            created: true,
            author_origin_id: Some("alice".to_owned()),
            attribution: Some(dohc_engine_domain::ChangeAttribution {
                actor_kind: dohc_engine_domain::ChangeActorKind::Agent,
                on_behalf_of: Some("automation:triage".to_owned()),
                depth: 1,
            }),
            source: Some(("origin-a".to_owned(), 41)),
            recorded_at_ms: 1_100,
            fields: vec![
                dohc_engine_domain::CollectionFieldChangeFact {
                    field_name: "alpha".to_owned(),
                    previous_json: None,
                    next_json: Some(big.clone()),
                    history_id: 7,
                },
                dohc_engine_domain::CollectionFieldChangeFact {
                    field_name: "beta".to_owned(),
                    previous_json: Some("\"open\"".to_owned()),
                    next_json: Some("\"done\"".to_owned()),
                    history_id: 8,
                },
            ],
        };

        emit_record_events(&events, "ws-1", &facts);

        let mut notices = Vec::new();
        while let Ok(notice) = rx.try_recv() {
            notices.push(notice);
        }
        assert_eq!(
            notices
                .iter()
                .map(|notice| notice.name.as_str())
                .collect::<Vec<_>>(),
            vec![
                RECORD_CREATED_EVENT,
                RECORD_FIELD_CHANGED_EVENT,
                RECORD_FIELD_CHANGED_EVENT,
                RECORD_UPDATED_EVENT,
            ],
            "created first, field changes in field-name order, then updated"
        );
        assert_eq!(
            notices[0].payload,
            json!({
                "workspaceId": "ws-1",
                "collectionPath": "tasks",
                "recordId": "rec_a",
                "author": "alice",
                "timestamp": 1_100,
                "actorKind": "agent",
                "onBehalfOf": "automation:triage",
                "depth": 1,
                "source": { "originId": "origin-a", "originSeq": 41 },
            })
        );
        assert_eq!(
            notices[1].payload["actorKind"], "agent",
            "field events carry the declared attribution too"
        );
        assert_eq!(notices[1].payload["onBehalfOf"], "automation:triage");
        assert_eq!(notices[1].payload["depth"], 1);
        assert_eq!(
            notices[1].payload["source"],
            json!({ "originId": "origin-a", "originSeq": 41 })
        );
        assert_eq!(notices[1].payload["field"], "alpha");
        assert_eq!(
            notices[1].payload["previous"],
            Value::Null,
            "an absent side travels as null"
        );
        assert_eq!(
            notices[1].payload["next"],
            json!({ "truncated": true, "bytes": big.len() }),
            "an oversized value travels as the truncated marker"
        );
        assert_eq!(notices[1].payload["historyId"], 7);
        assert_eq!(notices[2].payload["field"], "beta");
        // A value deeper than the wire leaves room for travels as the marker
        // too: an unencodable event must never reach the transport.
        let deep = format!(
            "{}1{}",
            "[".repeat(dohc_engine_domain::MAX_FIELD_FACT_VALUE_DEPTH),
            "]".repeat(dohc_engine_domain::MAX_FIELD_FACT_VALUE_DEPTH)
        );
        assert_eq!(
            record_event_value(Some(&deep)),
            json!({ "truncated": true, "bytes": deep.len() })
        );
        // The helper counts the value itself as depth 1, so the deepest
        // value that still travels whole nests one level fewer than the cap.
        let shallow = format!(
            "{}1{}",
            "[".repeat(dohc_engine_domain::MAX_FIELD_FACT_VALUE_DEPTH - 1),
            "]".repeat(dohc_engine_domain::MAX_FIELD_FACT_VALUE_DEPTH - 1)
        );
        assert_eq!(
            record_event_value(Some(&shallow)),
            serde_json::from_str::<Value>(&shallow).unwrap()
        );
        assert_eq!(notices[2].payload["previous"], "open");
        assert_eq!(notices[2].payload["next"], "done");
        assert_eq!(notices[2].payload["historyId"], 8);
        assert_eq!(notices[3].payload, notices[0].payload);
    }

    #[test]
    fn record_event_values_at_the_cap_travel_whole() {
        let at_cap = format!(
            "\"{}\"",
            "x".repeat(dohc_engine_domain::MAX_FIELD_FACT_VALUE_BYTES - 2)
        );
        assert_eq!(at_cap.len(), dohc_engine_domain::MAX_FIELD_FACT_VALUE_BYTES);
        assert_eq!(
            record_event_value(Some(&at_cap)),
            Value::String("x".repeat(dohc_engine_domain::MAX_FIELD_FACT_VALUE_BYTES - 2)),
            "a value at the cap travels whole"
        );
    }
}
