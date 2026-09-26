//! The automation claim ledger (ADR 0008): subscription filters, claim
//! insertion from apply facts (change kinds, field filters, prefix
//! containment, self-skip, depth cap, trigger-key dedupe, workspace
//! scoping), the facts a claim carries, per-executor draining, the
//! pending -> running -> done | failed machine with retry, the claim history
//! and its retention, the startup reaper's requeue-or-exhaust rule, and
//! Group message claims.

use dohc_engine_domain::{
    AUTOMATION_CHAIN_DEPTH_CAP, AUTOMATION_CHAIN_STOPPED, AUTOMATION_CLAIM_HISTORY_LIMIT,
    AUTOMATION_RECLAIM_EXHAUSTED, AutomationChange, AutomationChangeKind, AutomationClaim,
    AutomationClaimState, AutomationFactValue, AutomationFieldFact, AutomationGroupMessage,
    AutomationGroupSubscription, AutomationRetry, AutomationSettle, AutomationSubscription,
    AutomationTrigger, ChangeActorKind, ChangeAttribution, ChatActorKind, ChatChannelKind,
    ChatMessageAutomation, ChatThreadLane, CollectionFieldChangeFact, CollectionRecordApplyFacts,
    DomainError, LinkedChatStore, MAX_AUTOMATION_FIELD_FACTS_BYTES,
    MAX_AUTOMATION_SUBSCRIPTION_FIELDS, MAX_FIELD_FACT_VALUE_BYTES, MAX_MESSAGE_BODY_BYTES,
    NoFaults, SendMessage, StartChannelThread, TxnOutcome, claim_automation_triggers_in_tx,
    claim_group_message_in_tx, claim_next_pending_automation, list_automation_claims,
    list_automation_failures, reclaim_running_automations, release_automation_claim,
    retry_automation_claim, settle_automation_claim, subscribe_automation,
    subscribe_automation_group, unsubscribe_automation, unsubscribe_automation_group,
};
use dohc_engine_storage::EngineStore;
use dohc_engine_testkit::{ScratchDir, engine_db_path};
use serde_json::json;

const WS: &str = "ws-automations";
const NO_FAULTS: NoFaults = NoFaults;
const ADDED_AND_CHANGED: &[AutomationChangeKind] =
    &[AutomationChangeKind::Added, AutomationChangeKind::Changed];

fn open_store(scratch: &ScratchDir) -> EngineStore {
    let db = engine_db_path(scratch).expect("engine db path");
    EngineStore::open(&db, 1).expect("open store")
}

fn subscription(
    automation_id: &str,
    prefix: &str,
    kinds: &[AutomationChangeKind],
    fields: Option<&[&str]>,
) -> AutomationSubscription {
    AutomationSubscription {
        automation_id: automation_id.to_owned(),
        prefix: prefix.to_owned(),
        kinds: kinds.to_vec(),
        fields: fields.map(|fields| fields.iter().map(|field| (*field).to_owned()).collect()),
    }
}

/// Subscribe to added and changed records on any field, as plugin
/// automations do.
fn subscribe(store: &mut EngineStore, automation_id: &str, prefix: &str) -> bool {
    subscribe_automation(
        store,
        WS,
        &subscription(automation_id, prefix, ADDED_AND_CHANGED, None),
        10,
        &NO_FAULTS,
    )
    .expect("subscribe")
}

fn facts(
    collection_path: &str,
    source: Option<(&str, i64)>,
    history_ids: &[i64],
    author: Option<&str>,
    depth: Option<u32>,
) -> CollectionRecordApplyFacts {
    CollectionRecordApplyFacts {
        collection_path: collection_path.to_owned(),
        record_id: "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa".to_owned(),
        created: false,
        author_origin_id: author.map(str::to_owned),
        attribution: depth.map(|depth| ChangeAttribution {
            actor_kind: ChangeActorKind::Automation,
            on_behalf_of: Some("user:ice".to_owned()),
            depth,
        }),
        source: source.map(|(origin_id, origin_seq)| (origin_id.to_owned(), origin_seq)),
        recorded_at_ms: 50,
        fields: history_ids
            .iter()
            .map(|history_id| CollectionFieldChangeFact {
                field_name: format!("field-{history_id}"),
                previous_json: None,
                next_json: Some("\"done\"".to_owned()),
                history_id: *history_id,
            })
            .collect(),
    }
}

/// A changed-record apply on the named fields, keyed by `origin_seq`.
fn field_change(origin_seq: i64, fields: &[&str]) -> CollectionRecordApplyFacts {
    let mut applied = facts("tasks", Some(("origin-a", origin_seq)), &[], None, None);
    applied.fields = fields
        .iter()
        .enumerate()
        .map(|(index, field)| CollectionFieldChangeFact {
            field_name: (*field).to_owned(),
            previous_json: Some("\"open\"".to_owned()),
            next_json: Some("\"done\"".to_owned()),
            history_id: origin_seq * 100 + index as i64,
        })
        .collect();
    applied
}

fn claim_for(
    store: &mut EngineStore,
    workspace_id: &str,
    facts_value: &CollectionRecordApplyFacts,
    now_ms: i64,
) -> Vec<AutomationClaim> {
    match store
        .write_with(&NO_FAULTS, |tx| {
            claim_automation_triggers_in_tx(tx, workspace_id, facts_value, now_ms)
        })
        .expect("claim triggers")
    {
        TxnOutcome::Committed(claims) => claims,
        TxnOutcome::Crashed { .. } => unreachable!("no faults injected"),
    }
}

fn claimed_ids(claims: &[AutomationClaim]) -> Vec<&str> {
    claims
        .iter()
        .map(|claim| claim.automation_id.as_str())
        .collect()
}

fn claim_next(store: &mut EngineStore, prefix: &str, now_ms: i64) -> Option<AutomationClaim> {
    claim_next_pending_automation(store, WS, prefix, now_ms, &NO_FAULTS)
        .expect("claim next")
        .map(|(claim, _)| claim)
}

fn claim_rows(store: &EngineStore, workspace_id: &str) -> i64 {
    store
        .read_with(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM automation_claims WHERE workspace_id = ?1",
                [workspace_id],
                |row| row.get::<_, i64>(0),
            )
        })
        .expect("count claims")
}

#[test]
fn subscriptions_round_trip_replace_their_filter_and_validate() {
    let scratch = ScratchDir::new().expect("scratch");
    let mut store = open_store(&scratch);

    assert!(subscribe(&mut store, "plugin:triage", "tasks"));
    assert!(
        !subscribe(&mut store, "plugin:triage", "tasks"),
        "the same filter again changes nothing"
    );
    let narrowed = subscription(
        "plugin:triage",
        "tasks",
        &[AutomationChangeKind::Changed],
        Some(&["status", "status"]),
    );
    assert!(
        subscribe_automation(&mut store, WS, &narrowed, 11, &NO_FAULTS).expect("narrow"),
        "a new filter for the same pair replaces the old one"
    );
    assert!(
        !subscribe_automation(&mut store, WS, &narrowed, 12, &NO_FAULTS).expect("narrow again"),
    );
    assert!(
        unsubscribe_automation(&mut store, WS, "plugin:triage", "tasks", &NO_FAULTS)
            .expect("unsubscribe")
    );
    assert!(
        !unsubscribe_automation(&mut store, WS, "plugin:triage", "tasks", &NO_FAULTS)
            .expect("second unsubscribe finds nothing"),
    );

    let too_many: Vec<String> = (0..=MAX_AUTOMATION_SUBSCRIPTION_FIELDS)
        .map(|index| format!("field-{index}"))
        .collect();
    let too_many: Vec<&str> = too_many.iter().map(String::as_str).collect();
    for (invalid, why) in [
        (
            subscription("  ", "tasks", ADDED_AND_CHANGED, None),
            "a blank automation id",
        ),
        (
            subscription("hello/triage", "tasks", ADDED_AND_CHANGED, None),
            "an id outside the executor namespaces",
        ),
        (
            subscription("plugin:", "tasks", ADDED_AND_CHANGED, None),
            "a bare namespace",
        ),
        (
            subscription("plugin:triage", "", ADDED_AND_CHANGED, None),
            "a blank path",
        ),
        (
            subscription("plugin:triage", "tasks", &[], None),
            "no change kind",
        ),
        (
            subscription("plugin:triage", "tasks", ADDED_AND_CHANGED, Some(&[])),
            "an empty field list",
        ),
        (
            subscription("plugin:triage", "tasks", ADDED_AND_CHANGED, Some(&[""])),
            "a blank field name",
        ),
        (
            subscription("plugin:triage", "tasks", ADDED_AND_CHANGED, Some(&["a\0b"])),
            "a NUL in a field name",
        ),
        (
            subscription("plugin:triage", "tasks", ADDED_AND_CHANGED, Some(&too_many)),
            "too many field names",
        ),
    ] {
        assert!(
            matches!(
                subscribe_automation(&mut store, WS, &invalid, 13, &NO_FAULTS),
                Err(DomainError::InvalidInput { .. })
            ),
            "{why} is refused"
        );
    }
}

#[test]
fn subscriptions_claim_only_the_change_kinds_and_fields_they_name() {
    let scratch = ScratchDir::new().expect("scratch");
    let mut store = open_store(&scratch);
    for filter in [
        subscription(
            "collection:tasks#added",
            "tasks",
            &[AutomationChangeKind::Added],
            None,
        ),
        subscription(
            "collection:tasks#any-field",
            "tasks",
            &[AutomationChangeKind::Changed],
            None,
        ),
        subscription(
            "collection:tasks#status",
            "tasks",
            &[AutomationChangeKind::Changed],
            Some(&["status"]),
        ),
        subscription(
            "collection:tasks#removed",
            "tasks",
            &[AutomationChangeKind::Removed],
            None,
        ),
        // Two subscriptions for one automation: a title change under
        // "tasks" misses the first filter and matches the second.
        subscription(
            "collection:tasks#split",
            "tasks",
            &[AutomationChangeKind::Changed],
            Some(&["status"]),
        ),
        subscription(
            "collection:tasks#split",
            ".",
            &[AutomationChangeKind::Changed],
            Some(&["title"]),
        ),
    ] {
        subscribe_automation(&mut store, WS, &filter, 10, &NO_FAULTS).expect("subscribe");
    }

    // A record is added when reconcile binds it. The apply that writes its
    // first fields is a field change like any other.
    let mut created = field_change(1, &["status", "title"]);
    created.created = true;
    let claims = claim_for(&mut store, WS, &created, 20);
    assert_eq!(
        claimed_ids(&claims),
        vec![
            "collection:tasks#any-field",
            "collection:tasks#split",
            "collection:tasks#status",
        ],
        "writing a record's first fields is a changed record"
    );
    assert!(
        claims
            .iter()
            .all(|claim| claim.change.kind == AutomationChangeKind::Changed)
    );

    let title = claim_for(&mut store, WS, &field_change(2, &["title"]), 30);
    assert_eq!(
        claimed_ids(&title),
        vec!["collection:tasks#any-field", "collection:tasks#split"]
    );
    assert!(
        title
            .iter()
            .all(|claim| claim.change.kind == AutomationChangeKind::Changed)
    );

    let status = claim_for(
        &mut store,
        WS,
        &field_change(3, &["priority", "status"]),
        40,
    );
    assert_eq!(
        claimed_ids(&status),
        vec![
            "collection:tasks#any-field",
            "collection:tasks#split",
            "collection:tasks#status",
        ],
        "one claim per automation, however many of its subscriptions match"
    );

    let unwatched = claim_for(&mut store, WS, &field_change(4, &["priority"]), 50);
    assert_eq!(claimed_ids(&unwatched), vec!["collection:tasks#any-field"]);
}

#[test]
fn a_local_apply_claims_once_per_subscribed_automation_and_replay_dedupes() {
    let scratch = ScratchDir::new().expect("scratch");
    let mut store = open_store(&scratch);
    for (automation, prefix) in [
        ("plugin:triage", "tasks"),
        ("plugin:triage", "."),
        ("plugin:janitor", "."),
        ("plugin:elsewhere", "notes"),
    ] {
        subscribe(&mut store, automation, prefix);
    }

    let applied = facts("tasks", Some(("origin-a", 41)), &[7], Some("alice"), None);
    let claims = claim_for(&mut store, WS, &applied, 20);
    assert_eq!(
        claimed_ids(&claims),
        vec!["plugin:janitor", "plugin:triage"],
        "one claim per matching automation, even with two matching prefixes"
    );
    for claim in &claims {
        assert_eq!(
            claim.trigger,
            AutomationTrigger::Coordinate {
                origin_id: "origin-a".to_owned(),
                origin_seq: 41,
            },
            "a synced-lineage change keys on its replication coordinate"
        );
        assert_eq!(claim.state, AutomationClaimState::Pending);
        assert_eq!(claim.collection_path, "tasks");
        assert_eq!(claim.depth, 0);
    }

    let replayed = claim_for(&mut store, WS, &applied, 30);
    assert!(replayed.is_empty(), "the same trigger is never taken twice");
    assert_eq!(claim_rows(&store, WS), 2);

    let elsewhere = claim_for(&mut store, "ws-other", &applied, 40);
    assert_eq!(
        elsewhere.len(),
        0,
        "subscriptions are workspace-scoped: another workspace has none"
    );
}

#[test]
fn a_never_synced_change_keys_on_its_history_row_id() {
    let scratch = ScratchDir::new().expect("scratch");
    let mut store = open_store(&scratch);
    subscribe(&mut store, "plugin:triage", "tasks");

    let applied = facts("tasks", None, &[9, 12], Some("alice"), None);
    let claims = claim_for(&mut store, WS, &applied, 20);
    assert_eq!(claims.len(), 1);
    assert_eq!(
        claims[0].trigger,
        AutomationTrigger::History { history_id: 9 },
        "the fallback key is the apply's first history row id"
    );
    assert!(
        claim_for(&mut store, WS, &applied, 30).is_empty(),
        "the history-key shape dedupes the same way"
    );

    let keyless = facts("tasks", None, &[], Some("alice"), None);
    assert!(
        claim_for(&mut store, WS, &keyless, 40).is_empty(),
        "an apply with no coordinate and no history rows has no durable key"
    );
}

#[test]
fn a_claim_carries_the_change_kind_actor_and_bounded_field_facts() {
    let scratch = ScratchDir::new().expect("scratch");
    let mut store = open_store(&scratch);
    subscribe(&mut store, "plugin:triage", "tasks");

    let big = format!("\"{}\"", "x".repeat(MAX_FIELD_FACT_VALUE_BYTES));
    let deep = format!("{}1{}", "[".repeat(40), "]".repeat(40));
    let mut applied = facts(
        "tasks",
        Some(("origin-a", 1)),
        &[],
        Some("agent-editor"),
        None,
    );
    applied.attribution = Some(ChangeAttribution {
        actor_kind: ChangeActorKind::Agent,
        on_behalf_of: Some("user:ice".to_owned()),
        depth: 0,
    });
    applied.fields = vec![
        CollectionFieldChangeFact {
            field_name: "body".to_owned(),
            previous_json: Some(big.clone()),
            next_json: Some(deep.clone()),
            history_id: 11,
        },
        CollectionFieldChangeFact {
            field_name: "status".to_owned(),
            previous_json: None,
            next_json: Some("\"done\"".to_owned()),
            history_id: 12,
        },
    ];
    let claims = claim_for(&mut store, WS, &applied, 20);
    assert_eq!(
        claims[0].change,
        AutomationChange {
            kind: AutomationChangeKind::Changed,
            author_origin_id: Some("agent-editor".to_owned()),
            actor_kind: Some(ChangeActorKind::Agent),
            on_behalf_of: Some("user:ice".to_owned()),
        }
    );

    let (served, served_facts) =
        claim_next_pending_automation(&mut store, WS, "plugin:", 30, &NO_FAULTS)
            .expect("claim next")
            .expect("the claim is pending");
    assert_eq!(served.change, claims[0].change);
    assert_eq!(served_facts.omitted, 0);
    assert_eq!(
        served_facts.fields,
        vec![
            AutomationFieldFact {
                field_name: "body".to_owned(),
                history_id: Some(11),
                previous: Some(AutomationFactValue::Truncated {
                    truncated: true,
                    bytes: big.len(),
                }),
                next: Some(AutomationFactValue::Truncated {
                    truncated: true,
                    bytes: deep.len(),
                }),
            },
            AutomationFieldFact {
                field_name: "status".to_owned(),
                history_id: Some(12),
                previous: None,
                next: Some(AutomationFactValue::Whole {
                    value: json!("done"),
                }),
            },
        ],
        "a value too large or too deep travels as its size; an absent side is None"
    );
    assert_eq!(
        serde_json::to_value(&served_facts.fields[1]).expect("fact json"),
        json!({ "field": "status", "historyId": 12, "previous": null, "next": { "value": "done" } })
    );
    assert_eq!(
        serde_json::to_value(&served_facts.fields[0])
            .expect("fact json")
            .get("previous"),
        Some(&json!({ "truncated": true, "bytes": big.len() }))
    );
}

#[test]
fn a_claims_field_facts_stay_within_their_budget() {
    let scratch = ScratchDir::new().expect("scratch");
    let mut store = open_store(&scratch);
    subscribe(&mut store, "plugin:triage", "tasks");

    // Each value fits the per-value bound, but together they pass the
    // claim's budget; a field name longer than the budget cannot travel at
    // all.
    let value = format!("\"{}\"", "v".repeat(MAX_FIELD_FACT_VALUE_BYTES - 100));
    let mut applied = facts("tasks", Some(("origin-a", 1)), &[], None, None);
    applied.fields = (0..12)
        .map(|index| CollectionFieldChangeFact {
            field_name: format!("field-{index:02}"),
            previous_json: None,
            next_json: Some(value.clone()),
            history_id: index,
        })
        .chain([CollectionFieldChangeFact {
            field_name: "z".repeat(MAX_AUTOMATION_FIELD_FACTS_BYTES),
            previous_json: None,
            next_json: Some("1".to_owned()),
            history_id: 99,
        }])
        .collect();
    claim_for(&mut store, WS, &applied, 20);
    let (_, served_facts) =
        claim_next_pending_automation(&mut store, WS, "plugin:", 30, &NO_FAULTS)
            .expect("claim next")
            .expect("the claim is pending");

    assert_eq!(served_facts.fields.len(), 12);
    assert_eq!(served_facts.omitted, 1, "the huge field name is omitted");
    let whole = served_facts
        .fields
        .iter()
        .take_while(|fact| matches!(fact.next, Some(AutomationFactValue::Whole { .. })))
        .count();
    assert!(
        (1..12).contains(&whole),
        "early fields travel whole, later ones truncated: {whole}"
    );
    assert!(
        served_facts.fields[whole..]
            .iter()
            .all(|fact| matches!(fact.next, Some(AutomationFactValue::Truncated { .. })))
    );
    let bytes = serde_json::to_vec(&served_facts.fields)
        .expect("facts json")
        .len();
    assert!(bytes <= MAX_AUTOMATION_FIELD_FACTS_BYTES, "{bytes}");
}

#[test]
fn the_writing_automation_never_claims_and_the_depth_cap_records_the_stop() {
    let scratch = ScratchDir::new().expect("scratch");
    let mut store = open_store(&scratch);
    subscribe(&mut store, "plugin:triage", "tasks");

    let own_write = facts(
        "tasks",
        Some(("origin-a", 1)),
        &[1],
        Some("plugin:triage"),
        Some(1),
    );
    assert!(
        claim_for(&mut store, WS, &own_write, 20).is_empty(),
        "an automation never re-triggers itself"
    );

    // At the cap, the automation does not run — but the stop is recorded as
    // a failed `chain-stopped` claim, so the owner surface sees it.
    let at_cap = facts(
        "tasks",
        Some(("origin-a", 2)),
        &[2],
        Some("plugin:other"),
        Some(AUTOMATION_CHAIN_DEPTH_CAP),
    );
    let stopped = claim_for(&mut store, WS, &at_cap, 30);
    assert_eq!(
        stopped.len(),
        1,
        "the stop is recorded, once per automation"
    );
    assert_eq!(stopped[0].state, AutomationClaimState::Failed);
    assert_eq!(stopped[0].error.as_deref(), Some(AUTOMATION_CHAIN_STOPPED));
    assert!(stopped[0].chain_stopped());
    let stored_facts: String = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT change_fields_json FROM automation_claims WHERE claim_id = ?1",
                [&stopped[0].claim_id],
                |row| row.get(0),
            )
        })
        .expect("stopped claim facts");
    assert_eq!(stored_facts, "[]", "a stopped chain keeps no facts");
    assert!(
        claim_next(&mut store, "plugin:", 31).is_none(),
        "a chain-stopped row is never drained as work"
    );
    assert!(
        claim_for(&mut store, WS, &at_cap, 32).is_empty(),
        "a replayed at-cap apply dedupes on the same trigger key"
    );
    // The writing automation's own subscription records no stop either: it
    // would never have been triggered at any depth.
    let own_at_cap = facts(
        "tasks",
        Some(("origin-a", 4)),
        &[4],
        Some("plugin:triage"),
        Some(AUTOMATION_CHAIN_DEPTH_CAP),
    );
    assert!(
        claim_for(&mut store, WS, &own_at_cap, 33).is_empty(),
        "self-skip applies to the stop report too"
    );

    let below_cap = facts(
        "tasks",
        Some(("origin-a", 3)),
        &[3],
        Some("plugin:other"),
        Some(AUTOMATION_CHAIN_DEPTH_CAP - 1),
    );
    let claims = claim_for(&mut store, WS, &below_cap, 40);
    assert_eq!(claims.len(), 1, "one below the cap still claims");
    assert_eq!(claims[0].depth, AUTOMATION_CHAIN_DEPTH_CAP - 1);
    assert_eq!(claims[0].state, AutomationClaimState::Pending);
}

#[test]
fn claim_next_drains_only_the_executors_namespace() {
    let scratch = ScratchDir::new().expect("scratch");
    let mut store = open_store(&scratch);
    subscribe(&mut store, "plugin:hello/triage", "tasks");
    subscribe(&mut store, "collection:tasks#stamp", "tasks");
    claim_for(&mut store, WS, &field_change(1, &["status"]), 20);
    claim_for(&mut store, WS, &field_change(2, &["status"]), 30);

    let collection = claim_next(&mut store, "collection:", 40).expect("collection claim");
    assert_eq!(collection.automation_id, "collection:tasks#stamp");
    let plugin = claim_next(&mut store, "plugin:", 41).expect("plugin claim");
    assert_eq!(plugin.automation_id, "plugin:hello/triage");
    assert_eq!(
        plugin.trigger, collection.trigger,
        "each executor takes the oldest of its own claims"
    );
    assert!(
        claim_next(&mut store, "other:", 42).is_none(),
        "another namespace serves nothing"
    );
    let second = claim_next(&mut store, "plugin:", 43).expect("second plugin claim");
    assert_eq!(
        second.trigger,
        AutomationTrigger::Coordinate {
            origin_id: "origin-a".to_owned(),
            origin_seq: 2,
        }
    );
    for invalid in ["", "a\0b"] {
        assert!(matches!(
            claim_next_pending_automation(&mut store, WS, invalid, 44, &NO_FAULTS),
            Err(DomainError::InvalidInput { .. })
        ));
    }
}

#[test]
fn failures_list_one_row_per_automation_with_the_newest_error_and_a_counting_generation() {
    let scratch = ScratchDir::new().expect("scratch");
    let mut store = open_store(&scratch);
    subscribe(&mut store, "plugin:triage", "tasks");

    assert!(
        list_automation_failures(&store, WS)
            .expect("list failures")
            .is_empty(),
        "no failed claims, no rows"
    );

    // Two failures for the same automation: a settled handler error, then a
    // chain-stopped row inserted later.
    let first = facts("tasks", Some(("origin-a", 1)), &[1], None, None);
    let claims = claim_for(&mut store, WS, &first, 20);
    assert_eq!(claims.len(), 1);
    claim_next(&mut store, "plugin:", 21).expect("one pending claim");
    settle_automation_claim(
        &mut store,
        WS,
        &claims[0].claim_id,
        &AutomationSettle::Failed {
            error: "handler exploded".to_owned(),
        },
        22,
        &NO_FAULTS,
    )
    .expect("settle failed");
    let at_cap = facts(
        "tasks",
        Some(("origin-a", 2)),
        &[2],
        Some("plugin:other"),
        Some(AUTOMATION_CHAIN_DEPTH_CAP),
    );
    let stopped = claim_for(&mut store, WS, &at_cap, 30);

    let failures = list_automation_failures(&store, WS).expect("list failures");
    assert_eq!(failures.len(), 1, "one row per automation");
    assert_eq!(failures[0].automation_id, "plugin:triage");
    assert_eq!(
        failures[0].claim_id, stopped[0].claim_id,
        "the row names the newest failed claim"
    );
    assert!(
        failures[0].chain_stopped,
        "the newest failure is a chain stop"
    );
    assert_eq!(
        failures[0].error, AUTOMATION_CHAIN_STOPPED,
        "the newest failure's error wins"
    );
    assert_eq!(failures[0].updated_at_ms, 30);
    assert_eq!(
        failures[0].generation, 2,
        "the generation counts the failures"
    );

    // A done claim never appears, and another workspace's failures do not
    // leak in.
    let done = facts("tasks", Some(("origin-a", 3)), &[3], None, None);
    let done_claims = claim_for(&mut store, WS, &done, 40);
    claim_next(&mut store, "plugin:", 41).expect("one pending claim");
    settle_automation_claim(
        &mut store,
        WS,
        &done_claims[0].claim_id,
        &AutomationSettle::Done,
        42,
        &NO_FAULTS,
    )
    .expect("settle done");
    let failures = list_automation_failures(&store, WS).expect("list failures");
    assert_eq!(failures.len(), 1);
    assert_eq!(failures[0].generation, 2, "a done claim moves nothing");
    assert!(
        list_automation_failures(&store, "ws-other")
            .expect("list failures")
            .is_empty(),
        "failures are workspace-scoped"
    );
}

#[test]
fn claim_next_and_settle_walk_the_state_machine() {
    let scratch = ScratchDir::new().expect("scratch");
    let mut store = open_store(&scratch);
    subscribe(&mut store, "plugin:triage", "tasks");
    let first = facts("tasks", Some(("origin-a", 1)), &[1], Some("alice"), None);
    let second = facts("tasks", Some(("origin-a", 2)), &[2], Some("alice"), None);
    claim_for(&mut store, WS, &first, 20);
    claim_for(&mut store, WS, &second, 30);

    let running = claim_next(&mut store, "plugin:", 40).expect("a pending claim exists");
    assert_eq!(running.state, AutomationClaimState::Running);
    assert_eq!(running.attempts, 1);
    assert_eq!(
        running.trigger,
        AutomationTrigger::Coordinate {
            origin_id: "origin-a".to_owned(),
            origin_seq: 1,
        },
        "the oldest pending claim is served first"
    );

    let done = settle_automation_claim(
        &mut store,
        WS,
        &running.claim_id,
        &AutomationSettle::Done,
        50,
        &NO_FAULTS,
    )
    .expect("settle done");
    assert_eq!(done.state, AutomationClaimState::Done);
    assert!(
        matches!(
            settle_automation_claim(
                &mut store,
                WS,
                &running.claim_id,
                &AutomationSettle::Done,
                51,
                &NO_FAULTS,
            ),
            Err(DomainError::InvalidInput { .. })
        ),
        "a settled claim cannot settle again"
    );

    let second_running =
        claim_next(&mut store, "plugin:", 60).expect("the second claim is pending");
    assert!(
        matches!(
            settle_automation_claim(
                &mut store,
                WS,
                &second_running.claim_id,
                &AutomationSettle::Failed {
                    error: "  ".to_owned()
                },
                61,
                &NO_FAULTS,
            ),
            Err(DomainError::InvalidInput { .. })
        ),
        "a failed settle needs non-empty error text"
    );
    let failed = settle_automation_claim(
        &mut store,
        WS,
        &second_running.claim_id,
        &AutomationSettle::Failed {
            error: "handler threw".to_owned(),
        },
        62,
        &NO_FAULTS,
    )
    .expect("settle failed");
    assert_eq!(failed.state, AutomationClaimState::Failed);
    assert_eq!(failed.error.as_deref(), Some("handler threw"));

    assert!(
        claim_next(&mut store, "plugin:", 70).is_none(),
        "nothing pending remains"
    );
    assert!(
        matches!(
            settle_automation_claim(
                &mut store,
                WS,
                "atc_missing",
                &AutomationSettle::Done,
                71,
                &NO_FAULTS,
            ),
            Err(DomainError::InvalidInput { .. })
        ),
        "an unknown claim refuses cleanly"
    );
}

#[test]
fn a_retried_claim_runs_again_as_its_next_run_and_its_failures_keep_counting() {
    let scratch = ScratchDir::new().expect("scratch");
    let mut store = open_store(&scratch);
    subscribe(&mut store, "plugin:triage", "tasks");
    let claims = claim_for(&mut store, WS, &field_change(1, &["status"]), 20);
    let claim_id = claims[0].claim_id.clone();
    assert_eq!(claims[0].run, 1);
    let fail = |store: &mut EngineStore, error: &str, now_ms| {
        settle_automation_claim(
            store,
            WS,
            &claim_id,
            &AutomationSettle::Failed {
                error: error.to_owned(),
            },
            now_ms,
            &NO_FAULTS,
        )
        .expect("settle failed")
    };
    let retry = |store: &mut EngineStore, now_ms| {
        retry_automation_claim(store, WS, &claim_id, now_ms, &NO_FAULTS).expect("retry")
    };

    assert!(
        matches!(
            retry(&mut store, 21),
            AutomationRetry::Unchanged(claim) if claim.state == AutomationClaimState::Pending
        ),
        "a pending claim is returned unchanged"
    );
    let running = claim_next(&mut store, "plugin:", 22).expect("served");
    assert_eq!((running.attempts, running.run), (1, 1));
    assert_eq!(
        retry(&mut store, 23),
        AutomationRetry::Unchanged(running),
        "a running claim is returned unchanged"
    );
    // A handler whose error text reads like a chain stop is still a handler
    // failure: the stop is structural, not a string.
    fail(&mut store, AUTOMATION_CHAIN_STOPPED, 24);
    assert_eq!(
        list_automation_failures(&store, WS).expect("failures")[0].generation,
        1
    );

    let AutomationRetry::Requeued(retried) = retry(&mut store, 25) else {
        panic!("a failed claim is requeued");
    };
    assert_eq!(retried.state, AutomationClaimState::Pending);
    assert_eq!(retried.error, None);
    assert_eq!(
        (retried.attempts, retried.run),
        (1, 2),
        "a retry starts the next run and spends no attempt"
    );
    assert!(
        list_automation_failures(&store, WS)
            .expect("failures")
            .is_empty(),
        "a retried claim is no longer a failure"
    );
    let (again, again_facts) =
        claim_next_pending_automation(&mut store, WS, "plugin:", 26, &NO_FAULTS)
            .expect("claim next")
            .expect("the retried claim is served");
    assert_eq!(again.claim_id, claim_id);
    assert_eq!((again.attempts, again.run), (2, 2));
    assert_eq!(again_facts.fields[0].field_name, "status", "with its facts");
    fail(&mut store, "threw again", 27);
    assert_eq!(
        list_automation_failures(&store, WS).expect("failures")[0].generation,
        2,
        "a failure after a retry still raises the generation"
    );

    retry(&mut store, 28);
    claim_next(&mut store, "plugin:", 29).expect("served");
    settle_automation_claim(
        &mut store,
        WS,
        &claim_id,
        &AutomationSettle::Done,
        30,
        &NO_FAULTS,
    )
    .expect("settle done");
    assert!(matches!(
        retry_automation_claim(&mut store, WS, &claim_id, 31, &NO_FAULTS),
        Err(DomainError::InvalidInput { .. })
    ));

    let at_cap = facts(
        "tasks",
        Some(("origin-a", 9)),
        &[9],
        Some("plugin:other"),
        Some(AUTOMATION_CHAIN_DEPTH_CAP),
    );
    let stopped = claim_for(&mut store, WS, &at_cap, 40);
    assert!(
        matches!(
            retry_automation_claim(&mut store, WS, &stopped[0].claim_id, 41, &NO_FAULTS),
            Err(DomainError::InvalidInput { .. })
        ),
        "a chain the depth cap stopped stays stopped"
    );
    assert!(matches!(
        retry_automation_claim(&mut store, WS, "atc_missing", 42, &NO_FAULTS),
        Err(DomainError::InvalidInput { .. })
    ));
}

#[test]
fn a_crash_requeue_keeps_the_run_and_a_retried_run_that_crashes_is_exhausted() {
    let scratch = ScratchDir::new().expect("scratch");
    let mut store = open_store(&scratch);
    subscribe(&mut store, "plugin:triage", "tasks");
    let claims = claim_for(&mut store, WS, &field_change(1, &["status"]), 20);
    let claim_id = claims[0].claim_id.clone();
    let reclaim = |store: &mut EngineStore, now_ms| {
        reclaim_running_automations(store, WS, None, 2, now_ms, now_ms, &NO_FAULTS)
            .expect("reclaim")
    };

    // Run 1 crashes: the reaper requeues it, and the next serve is the same
    // run, so its writes repeat under the same keys.
    let first = claim_next(&mut store, "plugin:", 30).expect("served");
    assert_eq!((first.attempts, first.run), (1, 1));
    assert_eq!(
        reclaim(&mut store, 40)[0].state,
        AutomationClaimState::Pending
    );
    let requeued = claim_next(&mut store, "plugin:", 50).expect("served again");
    assert_eq!((requeued.attempts, requeued.run), (2, 1));
    settle_automation_claim(
        &mut store,
        WS,
        &claim_id,
        &AutomationSettle::Failed {
            error: "threw".to_owned(),
        },
        60,
        &NO_FAULTS,
    )
    .expect("settle failed");

    // The owner's retry starts run 2, under new keys. Attempts keep counting
    // across runs, so a crash in the retried run already meets the attempt
    // bound: the reaper fails it instead of requeueing it, and the owner can
    // retry again.
    retry_automation_claim(&mut store, WS, &claim_id, 70, &NO_FAULTS).expect("retry");
    let retried = claim_next(&mut store, "plugin:", 80).expect("served");
    assert_eq!((retried.attempts, retried.run), (3, 2));
    let exhausted = reclaim(&mut store, 90);
    assert_eq!(exhausted[0].state, AutomationClaimState::Failed);
    assert_eq!(
        exhausted[0].error.as_deref(),
        Some(AUTOMATION_RECLAIM_EXHAUSTED)
    );
    assert_eq!(
        list_automation_failures(&store, WS).expect("failures")[0].generation,
        2
    );
    let AutomationRetry::Requeued(third) =
        retry_automation_claim(&mut store, WS, &claim_id, 100, &NO_FAULTS).expect("retry")
    else {
        panic!("an exhausted claim can be retried");
    };
    assert_eq!(third.run, 3);
}

#[test]
fn an_upgraded_plugin_claim_drains_and_retries_in_the_plugin_namespace() {
    let scratch = ScratchDir::new().expect("scratch");
    let mut store = open_store(&scratch);
    // Claims as the change facts migration leaves them: only the columns a
    // claim held before it, and the legacy id moved into `plugin:`.
    store
        .write_with(&NO_FAULTS, |tx| {
            tx.execute(
                "INSERT INTO automation_claims \
                 (workspace_id, claim_id, automation_id, trigger_history_id, record_id, \
                  collection_path, depth, state, attempts, error, created_at_ms, updated_at_ms) \
                 VALUES (?1, 'atc_failed', 'plugin:hello/triage', 1, 'rec', 'tasks', 0, \
                         'failed', 1, 'threw', 5, 5), \
                        (?1, 'atc_pending', 'plugin:hello/triage', 2, 'rec', 'tasks', 0, \
                         'pending', 0, NULL, 6, 6)",
                [WS],
            )
            .map_err(dohc_engine_storage::StorageError::persist_public)?;
            Ok::<_, dohc_engine_storage::StorageError>(())
        })
        .expect("seed upgraded claim rows");
    let failures = list_automation_failures(&store, WS).expect("failures");
    assert_eq!(failures[0].generation, 1, "the old failure still counts");
    assert_eq!(failures[0].claim_id, "atc_failed");
    assert!(!failures[0].chain_stopped, "it ran, so it is no chain stop");

    let (served, facts) = claim_next_pending_automation(&mut store, WS, "plugin:", 10, &NO_FAULTS)
        .expect("claim next")
        .expect("the pending upgraded claim drains in the plugin namespace");
    assert_eq!(served.claim_id, "atc_pending");
    assert_eq!(
        (served.run, served.change.kind),
        (1, AutomationChangeKind::Changed)
    );
    assert!(facts.fields.is_empty(), "an upgraded claim has no facts");

    let AutomationRetry::Requeued(retried) =
        retry_automation_claim(&mut store, WS, "atc_failed", 20, &NO_FAULTS).expect("retry")
    else {
        panic!("the upgraded failed claim is retryable");
    };
    assert_eq!(retried.run, 2);
    let again = claim_next(&mut store, "plugin:", 30).expect("the retried claim drains");
    assert_eq!((again.claim_id.as_str(), again.run), ("atc_failed", 2));
}

#[test]
fn the_claim_history_lists_newest_first_and_settle_prunes_old_done_claims() {
    let scratch = ScratchDir::new().expect("scratch");
    let mut store = open_store(&scratch);
    subscribe(&mut store, "plugin:triage", "tasks");
    subscribe(&mut store, "plugin:other", "tasks");
    let limit = AUTOMATION_CLAIM_HISTORY_LIMIT;

    // The oldest triage claim fails and must survive pruning; the rest
    // succeed.
    for seq in 0..limit + 5 {
        claim_for(
            &mut store,
            WS,
            &field_change(seq + 1, &["status"]),
            100 + seq,
        );
    }
    let mut failed_one = false;
    for index in 0..2 * (limit + 5) {
        let claim = claim_next(&mut store, "plugin:", 1_000 + index).expect("pending claim");
        let settle = if !failed_one && claim.automation_id == "plugin:triage" {
            failed_one = true;
            AutomationSettle::Failed {
                error: "first run threw".to_owned(),
            }
        } else {
            AutomationSettle::Done
        };
        settle_automation_claim(
            &mut store,
            WS,
            &claim.claim_id,
            &settle,
            1_000 + index,
            &NO_FAULTS,
        )
        .expect("settle");
    }

    let history = list_automation_claims(&store, WS, "plugin:triage").expect("list claims");
    assert_eq!(history.len(), limit as usize);
    assert!(
        history
            .windows(2)
            .all(|pair| pair[0].created_at_ms > pair[1].created_at_ms),
        "newest first"
    );
    assert!(
        history
            .iter()
            .all(|claim| claim.automation_id == "plugin:triage")
    );
    let rows = |automation: &str| -> i64 {
        store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT COUNT(*) FROM automation_claims \
                     WHERE workspace_id = ?1 AND automation_id = ?2",
                    [WS, automation],
                    |row| row.get(0),
                )
            })
            .expect("count claims")
    };
    assert_eq!(
        rows("plugin:triage"),
        limit + 1,
        "done claims past the limit are pruned; the failed one stays"
    );
    assert_eq!(rows("plugin:other"), limit);
    assert_eq!(
        list_automation_failures(&store, WS).expect("failures")[0].generation,
        1,
        "pruning never lowers the failure generation"
    );
    assert!(
        list_automation_claims(&store, WS, "plugin:missing")
            .expect("list claims")
            .is_empty()
    );
}

/// An executor that cannot run a claim yet hands it back: pending again,
/// with the attempts it had before the serve and the same run, and served
/// again by the next `claimNext`. Only a running claim can be released, and
/// a claim whose holder dies after being served again still goes to the
/// reaper.
#[test]
fn a_released_claim_is_pending_again_without_an_attempt() {
    let scratch = ScratchDir::new().expect("scratch");
    let mut store = open_store(&scratch);
    subscribe(&mut store, "plugin:triage", "tasks");
    let claims = claim_for(&mut store, WS, &field_change(1, &["status"]), 20);
    let claim_id = claims[0].claim_id.clone();
    let release = |store: &mut EngineStore, now_ms| {
        release_automation_claim(store, WS, &claim_id, now_ms, &NO_FAULTS)
    };
    let refused = |result: Result<AutomationClaim, DomainError>| {
        matches!(result, Err(DomainError::InvalidInput { .. }))
    };
    assert!(
        refused(release(&mut store, 21)),
        "a pending claim is refused"
    );

    let served = claim_next(&mut store, "plugin:", 22).expect("served");
    assert_eq!((served.attempts, served.run), (1, 1));
    let released = release(&mut store, 23).expect("release");
    assert_eq!(released.state, AutomationClaimState::Pending);
    assert_eq!(
        (released.attempts, released.run),
        (claims[0].attempts, 1),
        "a release is not an attempt"
    );

    let again = claim_next(&mut store, "plugin:", 24).expect("served again");
    assert_eq!(again.claim_id, claim_id);
    assert_eq!((again.attempts, again.run), (1, 1));
    let reclaimed = reclaim_running_automations(&mut store, WS, None, 3, 24, 100, &NO_FAULTS)
        .expect("reclaim running");
    assert_eq!(
        reclaimed
            .iter()
            .map(|claim| (claim.claim_id.as_str(), claim.state))
            .collect::<Vec<_>>(),
        vec![(claim_id.as_str(), AutomationClaimState::Pending)],
        "the reaper requeues a claim whose holder died"
    );

    claim_next(&mut store, "plugin:", 110).expect("served after the reaper");
    settle_automation_claim(
        &mut store,
        WS,
        &claim_id,
        &AutomationSettle::Done,
        111,
        &NO_FAULTS,
    )
    .expect("settle done");
    assert!(refused(release(&mut store, 112)), "a done claim is refused");
}

#[test]
fn the_reaper_requeues_with_attempts_left_and_exhausts_without() {
    let scratch = ScratchDir::new().expect("scratch");
    let mut store = open_store(&scratch);
    subscribe(&mut store, "plugin:triage", "tasks");
    for seq in 1..=3 {
        let applied = facts(
            "tasks",
            Some(("origin-a", seq)),
            &[seq],
            Some("alice"),
            None,
        );
        claim_for(&mut store, WS, &applied, 20 + seq);
    }
    // First and second claims start running at t=30; the second exhausts its
    // attempts through a settle-less reclaim cycle below. The third stays
    // pending and must be untouched.
    let first = claim_next(&mut store, "plugin:", 30).expect("first");
    let second = claim_next(&mut store, "plugin:", 30).expect("second");
    store
        .write_with(&NO_FAULTS, |tx| {
            tx.execute(
                "UPDATE automation_claims SET attempts = 2 \
                 WHERE workspace_id = ?1 AND claim_id = ?2",
                rusqlite::params![WS, second.claim_id],
            )
            .map_err(dohc_engine_storage::StorageError::persist_public)?;
            Ok::<_, dohc_engine_storage::StorageError>(())
        })
        .expect("exhaust the second claim's attempts");

    let reclaimed = reclaim_running_automations(&mut store, WS, None, 2, 30, 100, &NO_FAULTS)
        .expect("reclaim running");
    assert_eq!(reclaimed.len(), 2, "only stale running claims transition");
    let requeued = reclaimed
        .iter()
        .find(|claim| claim.claim_id == first.claim_id)
        .expect("first reclaimed");
    assert_eq!(
        requeued.state,
        AutomationClaimState::Pending,
        "attempts remain, so the claim requeues"
    );
    let exhausted = reclaimed
        .iter()
        .find(|claim| claim.claim_id == second.claim_id)
        .expect("second reclaimed");
    assert_eq!(exhausted.state, AutomationClaimState::Failed);
    assert_eq!(
        exhausted.error.as_deref(),
        Some(AUTOMATION_RECLAIM_EXHAUSTED)
    );
    assert_eq!(
        list_automation_failures(&store, WS).expect("failures")[0].generation,
        1,
        "an exhausted claim counts as a failure"
    );

    let fresh = claim_next(&mut store, "plugin:", 200).expect("requeued or untouched pending");
    assert!(
        reclaim_running_automations(&mut store, WS, None, 2, 150, 210, &NO_FAULTS)
            .expect("reclaim again")
            .is_empty(),
        "a claim running since t=200 is younger than the bound and is left alone: {fresh:?}"
    );
}

// ------------------------------------------------------- Group messages

const GROUP: &str = "gen-1";
const TASK: &str = "collection:Trip/Tasks#task";
const ALL: &str = "collection:Trip/Tasks#all";

fn open_group(scratch: &ScratchDir) -> EngineStore {
    let mut store = open_store(scratch);
    LinkedChatStore::new(&mut store)
        .ensure_general_channel(WS, GROUP, 5, &NO_FAULTS)
        .expect("Group");
    store
}

fn subscribe_group(
    store: &mut EngineStore,
    automation_id: &str,
    channel_id: &str,
    starts_with: Option<&str>,
) -> Result<bool, DomainError> {
    subscribe_automation_group(
        store,
        WS,
        &AutomationGroupSubscription {
            automation_id: automation_id.to_owned(),
            channel_id: channel_id.to_owned(),
            starts_with: starts_with.map(str::to_owned),
        },
        10,
        &NO_FAULTS,
    )
}

/// Ada's new post in the Group.
fn post(message_id: &str, body: &str, now_ms: i64) -> StartChannelThread {
    StartChannelThread {
        workspace_id: WS.to_owned(),
        channel_id: GROUP.to_owned(),
        thread_id: format!("t-{message_id}"),
        message_id: message_id.to_owned(),
        title: None,
        lane: ChatThreadLane::Posts,
        author_kind: ChatActorKind::Human,
        author_display_name: "Ada".to_owned(),
        author_owner_display_name: None,
        author_user_id: Some("user-ada".to_owned()),
        origin: None,
        body: body.to_owned(),
        needs_decision: false,
        options: Vec::new(),
        attachments: Vec::new(),
        automation: None,
        now_ms,
        request_id: None,
    }
}

/// Store a post and return the claims its write took.
fn posted(store: &mut EngineStore, input: &StartChannelThread) -> Vec<AutomationClaim> {
    let mut chats = LinkedChatStore::new(store);
    chats.start_channel_thread(input, &NO_FAULTS).expect("post");
    chats.take_automation_claims()
}

fn settle_done(store: &mut EngineStore, claim_id: &str, now_ms: i64) {
    settle_automation_claim(
        store,
        WS,
        claim_id,
        &AutomationSettle::Done,
        now_ms,
        &NO_FAULTS,
    )
    .expect("settle");
}

#[test]
fn group_subscriptions_belong_to_collection_automations_and_validate() {
    let scratch = ScratchDir::new().expect("scratch");
    let mut store = open_group(&scratch);
    {
        let mut chats = LinkedChatStore::new(&mut store);
        chats
            .create_channel(WS, "dm-1", "Ana", ChatChannelKind::Dm, 5, &NO_FAULTS)
            .expect("DM");
        chats
            .ensure_agent_channel(WS, "agent-1", 5, &NO_FAULTS)
            .expect("agent channel");
    }
    // Only a Group this computer has can be watched: not a DM, the agent
    // channel, or an id nothing names.
    for channel_id in ["dm-1", "agent-1", "no-such-group"] {
        assert!(
            matches!(
                subscribe_group(&mut store, TASK, channel_id, None),
                Err(DomainError::InvalidInput {
                    reason: "A Group subscription names a Group on this computer."
                })
            ),
            "{channel_id}"
        );
    }
    assert!(subscribe_group(&mut store, TASK, GROUP, Some("/task")).expect("subscribe"));
    assert!(
        !subscribe_group(&mut store, TASK, GROUP, Some("/task")).expect("again"),
        "the same subscription again changes nothing"
    );
    assert!(
        subscribe_group(&mut store, TASK, GROUP, None).expect("replace"),
        "a new starting text replaces the old one"
    );
    for (automation_id, starts_with) in [
        ("plugin:triage", None),
        ("collection:../Secrets#task", None),
        (TASK, Some("")),
        (TASK, Some(" /task")),
    ] {
        assert!(
            matches!(
                subscribe_group(&mut store, automation_id, GROUP, starts_with),
                Err(DomainError::InvalidInput { .. })
            ),
            "{automation_id} {starts_with:?}"
        );
    }
    assert!(
        matches!(
            subscribe_automation(
                &mut store,
                WS,
                &subscription(TASK, "Trip/Tasks", &[AutomationChangeKind::Message], None),
                10,
                &NO_FAULTS,
            ),
            Err(DomainError::InvalidInput { .. })
        ),
        "a record subscription cannot name messages"
    );
    assert!(unsubscribe_automation_group(&mut store, WS, TASK, GROUP, &NO_FAULTS).expect("remove"));
    assert!(!unsubscribe_automation_group(&mut store, WS, TASK, GROUP, &NO_FAULTS).expect("again"));
}

/// A Group message claims once for each subscription whose starting text it
/// begins with, in the write that stores it, and the executor gets the
/// message with the claim. A removed subscription and a second store of the
/// same message claim nothing.
#[test]
fn a_group_message_claims_each_matching_subscription_once() {
    let scratch = ScratchDir::new().expect("scratch");
    let mut store = open_group(&scratch);
    subscribe_group(&mut store, TASK, GROUP, Some("/task")).expect("task");
    subscribe_group(&mut store, ALL, GROUP, None).expect("all");

    let claims = posted(&mut store, &post("m1", "  /task Buy tickets", 20));
    assert_eq!(claimed_ids(&claims), vec![ALL, TASK]);
    let claim = claims[1].clone();
    assert_eq!(
        claim.trigger,
        AutomationTrigger::Key {
            key: "message:m1".to_owned()
        }
    );
    assert_eq!(claim.record_id, None);
    assert_eq!(claim.collection_path, "Trip/Tasks");
    assert_eq!(claim.depth, 0);
    assert_eq!(
        claim.change,
        AutomationChange {
            kind: AutomationChangeKind::Message,
            author_origin_id: None,
            actor_kind: Some(ChangeActorKind::Human),
            on_behalf_of: Some("user-ada".to_owned()),
        }
    );
    assert_eq!(claim.state, AutomationClaimState::Pending);
    assert_eq!(claim.created_at_ms, 20);

    // The starting text is case-sensitive, and a reply claims like a post.
    let mut chats = LinkedChatStore::new(&mut store);
    chats
        .send_message(
            &SendMessage {
                workspace_id: WS.to_owned(),
                thread_id: "t-m1".to_owned(),
                message_id: "m2".to_owned(),
                author_kind: ChatActorKind::Human,
                author_display_name: "Ana".to_owned(),
                author_owner_display_name: None,
                author_user_id: Some("user-ana".to_owned()),
                parent_message_id: Some("m1".to_owned()),
                origin: None,
                body: "/Task later".to_owned(),
                needs_decision: false,
                options: Vec::new(),
                attachments: Vec::new(),
                automation: None,
                now_ms: 25,
                request_id: None,
            },
            &NO_FAULTS,
        )
        .expect("reply");
    let reply_claims = chats.take_automation_claims();
    assert_eq!(claimed_ids(&reply_claims), vec![ALL]);
    assert_eq!(
        reply_claims[0].change.on_behalf_of.as_deref(),
        Some("user-ana")
    );

    let (served, facts) = claim_next_pending_automation(&mut store, WS, TASK, 30, &NO_FAULTS)
        .expect("claim next")
        .expect("the task claim");
    assert_eq!(served.claim_id, claim.claim_id);
    assert!(facts.fields.is_empty());
    assert_eq!(
        facts.message,
        Some(json!({
            "id": "m1",
            "threadId": "t-m1",
            "groupId": GROUP,
            "lane": "posts",
            "authorKind": "human",
            "authorDisplayName": "Ada",
            "authorUserId": "user-ada",
            "createdAtMs": 20,
            "body": "  /task Buy tickets",
        }))
    );
    let (_, reply_facts) = claim_next_pending_automation(&mut store, WS, ALL, 31, &NO_FAULTS)
        .expect("claim next")
        .expect("the first all claim");
    assert_eq!(reply_facts.message.expect("message")["id"], "m1");
    let (_, reply_facts) = claim_next_pending_automation(&mut store, WS, ALL, 32, &NO_FAULTS)
        .expect("claim next")
        .expect("the reply's claim");
    assert_eq!(
        reply_facts.message.expect("message")["parentMessageId"],
        "m1"
    );

    // The same message stored again, by an echo or a second lane, claims
    // nothing.
    let again = store
        .write_with(&NO_FAULTS, |tx| {
            claim_group_message_in_tx(
                tx,
                WS,
                &AutomationGroupMessage {
                    message_id: "m1",
                    thread_id: "t-m1",
                    parent_message_id: None,
                    author_kind: "human",
                    author_display_name: "Ada",
                    author_owner_display_name: None,
                    author_user_id: Some("user-ada"),
                    body: "  /task Buy tickets",
                    created_at_ms: 20,
                    automation_id: None,
                    chain_depth: None,
                },
            )
        })
        .expect("claim again");
    assert!(matches!(again, TxnOutcome::Committed(claims) if claims.is_empty()));

    unsubscribe_automation_group(&mut store, WS, TASK, GROUP, &NO_FAULTS).expect("unsubscribe");
    let claims = posted(&mut store, &post("m3", "/task Pack", 40));
    assert_eq!(claimed_ids(&claims), vec![ALL]);
}

/// An automation's post never claims for that automation, carries its
/// depth, and at the cap records the stop instead of a run.
#[test]
fn an_automations_message_skips_its_writer_and_stops_at_the_cap() {
    let scratch = ScratchDir::new().expect("scratch");
    let mut store = open_group(&scratch);
    subscribe_group(&mut store, TASK, GROUP, None).expect("task");
    subscribe_group(&mut store, ALL, GROUP, None).expect("all");
    let by_task = |message_id: &str, chain_depth: u32| StartChannelThread {
        author_kind: ChatActorKind::Automation,
        author_display_name: "Add a task".to_owned(),
        author_owner_display_name: Some("Ice".to_owned()),
        automation: Some(ChatMessageAutomation {
            automation_id: TASK.to_owned(),
            chain_depth,
        }),
        ..post(message_id, "Added", 20)
    };

    let claims = posted(&mut store, &by_task("m1", 1));
    assert_eq!(claimed_ids(&claims), vec![ALL]);
    assert_eq!(claims[0].depth, 1);
    assert_eq!(claims[0].change.author_origin_id.as_deref(), Some(TASK));
    assert_eq!(
        claims[0].change.actor_kind,
        Some(ChangeActorKind::Automation)
    );

    let stopped = posted(&mut store, &by_task("m2", AUTOMATION_CHAIN_DEPTH_CAP));
    assert_eq!(claimed_ids(&stopped), vec![ALL]);
    assert!(stopped[0].chain_stopped());
    assert_eq!(stopped[0].error.as_deref(), Some(AUTOMATION_CHAIN_STOPPED));
    let kept: Option<String> = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT message_json FROM automation_claims WHERE claim_id = ?1",
                [&stopped[0].claim_id],
                |row| row.get(0),
            )
        })
        .expect("stopped claim");
    assert_eq!(kept, None, "a stopped chain keeps no message");
    assert_eq!(
        claim_next(&mut store, ALL, 30).map(|claim| claim.claim_id),
        Some(claims[0].claim_id.clone())
    );
    assert!(
        claim_next(&mut store, ALL, 31).is_none(),
        "a stopped claim never runs"
    );
}

/// A body too long for the claim budget travels as its size, and
/// `get_message` reads it whole. Past the claim history, a settled message
/// claim keeps its key without its message, so the message never claims
/// twice.
#[test]
fn a_long_message_travels_truncated_and_a_settled_claim_keeps_its_key() {
    let scratch = ScratchDir::new().expect("scratch");
    let mut store = open_group(&scratch);
    subscribe_group(&mut store, ALL, GROUP, None).expect("all");
    let long = "x".repeat(MAX_MESSAGE_BODY_BYTES);
    posted(&mut store, &post("m-long", &long, 20));
    let (claim, facts) = claim_next_pending_automation(&mut store, WS, ALL, 21, &NO_FAULTS)
        .expect("claim next")
        .expect("the long claim");
    let message = facts.message.expect("message");
    assert_eq!(
        message["body"],
        json!({ "truncated": true, "bytes": MAX_MESSAGE_BODY_BYTES })
    );
    assert_eq!(message["id"], "m-long");
    assert!(serde_json::to_vec(&message).expect("json").len() <= MAX_AUTOMATION_FIELD_FACTS_BYTES);
    assert_eq!(
        LinkedChatStore::new(&mut store)
            .get_message(WS, "m-long")
            .expect("the whole message")
            .body,
        long
    );
    settle_done(&mut store, &claim.claim_id, 22);

    for index in 0..AUTOMATION_CLAIM_HISTORY_LIMIT {
        posted(&mut store, &post(&format!("m{index}"), "Hi", 30 + index));
        let claim = claim_next(&mut store, ALL, 1_000 + index).expect("pending claim");
        settle_done(&mut store, &claim.claim_id, 1_000 + index);
    }
    let kept: (i64, Option<String>) = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT COUNT(*), MAX(message_json) FROM automation_claims \
                 WHERE workspace_id = ?1 AND trigger_key = 'message:m-long'",
                [WS],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
        })
        .expect("kept claim");
    assert_eq!(kept, (1, None));
    assert_eq!(
        list_automation_claims(&store, WS, ALL)
            .expect("history")
            .len(),
        AUTOMATION_CLAIM_HISTORY_LIMIT as usize
    );
}
