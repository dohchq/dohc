//! The automation claim ledger (ADR 0008): subscription filters, claim
//! insertion from apply facts (change kinds, field filters, prefix
//! containment, self-skip, depth cap, trigger-key dedupe, workspace
//! scoping), the facts a claim carries, per-executor draining, the
//! pending -> running -> done | failed machine with retry, the claim history
//! and its retention, and the startup reaper's requeue-or-exhaust rule.

use dohc_engine_domain::{
    AUTOMATION_CHAIN_DEPTH_CAP, AUTOMATION_CHAIN_STOPPED, AUTOMATION_CLAIM_HISTORY_LIMIT,
    AUTOMATION_RECLAIM_EXHAUSTED, AutomationChange, AutomationChangeKind, AutomationClaim,
    AutomationClaimState, AutomationFactValue, AutomationFieldFact, AutomationSettle,
    AutomationSubscription, AutomationTrigger, ChangeActorKind, ChangeAttribution,
    CollectionFieldChangeFact, CollectionRecordApplyFacts, DomainError,
    MAX_AUTOMATION_FIELD_FACTS_BYTES, MAX_AUTOMATION_SUBSCRIPTION_FIELDS,
    MAX_FIELD_FACT_VALUE_BYTES, NoFaults, TxnOutcome, claim_automation_triggers_in_tx,
    claim_next_pending_automation, list_automation_claims, list_automation_failures,
    reclaim_running_automations, retry_automation_claim, settle_automation_claim,
    subscribe_automation, unsubscribe_automation,
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

fn claim_next(
    store: &mut EngineStore,
    prefix: Option<&str>,
    now_ms: i64,
) -> Option<AutomationClaim> {
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
        subscription("added", "tasks", &[AutomationChangeKind::Added], None),
        subscription("any-field", "tasks", &[AutomationChangeKind::Changed], None),
        subscription(
            "status",
            "tasks",
            &[AutomationChangeKind::Changed],
            Some(&["status"]),
        ),
        subscription("removed", "tasks", &[AutomationChangeKind::Removed], None),
        // Two subscriptions for one automation: a title change under
        // "tasks" misses the first filter and matches the second.
        subscription(
            "split",
            "tasks",
            &[AutomationChangeKind::Changed],
            Some(&["status"]),
        ),
        subscription(
            "split",
            ".",
            &[AutomationChangeKind::Changed],
            Some(&["title"]),
        ),
    ] {
        subscribe_automation(&mut store, WS, &filter, 10, &NO_FAULTS).expect("subscribe");
    }

    let mut created = field_change(1, &["status", "title"]);
    created.created = true;
    let claims = claim_for(&mut store, WS, &created, 20);
    assert_eq!(
        claimed_ids(&claims),
        vec!["added"],
        "the apply that writes a record's first fields is an added record"
    );
    assert_eq!(claims[0].change.kind, AutomationChangeKind::Added);

    let title = claim_for(&mut store, WS, &field_change(2, &["title"]), 30);
    assert_eq!(claimed_ids(&title), vec!["any-field", "split"]);
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
        vec!["any-field", "split", "status"],
        "one claim per automation, however many of its subscriptions match"
    );

    let unwatched = claim_for(&mut store, WS, &field_change(4, &["priority"]), 50);
    assert_eq!(claimed_ids(&unwatched), vec!["any-field"]);
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
            actor_kind: Some(ChangeActorKind::Agent),
            actor_id: Some("agent-editor".to_owned()),
        }
    );

    let (served, served_facts) =
        claim_next_pending_automation(&mut store, WS, None, 30, &NO_FAULTS)
            .expect("claim next")
            .expect("the claim is pending");
    assert_eq!(served.change, claims[0].change);
    assert_eq!(served_facts.omitted, 0);
    assert_eq!(
        served_facts.fields,
        vec![
            AutomationFieldFact {
                field_name: "body".to_owned(),
                history_id: 11,
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
                history_id: 12,
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
    let (_, served_facts) = claim_next_pending_automation(&mut store, WS, None, 30, &NO_FAULTS)
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
    assert!(
        claim_next(&mut store, None, 31).is_none(),
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
fn claim_next_with_a_prefix_drains_only_that_executors_claims() {
    let scratch = ScratchDir::new().expect("scratch");
    let mut store = open_store(&scratch);
    subscribe(&mut store, "hello-plugin/triage", "tasks");
    subscribe(&mut store, "collection:tasks#stamp", "tasks");
    claim_for(&mut store, WS, &field_change(1, &["status"]), 20);
    claim_for(&mut store, WS, &field_change(2, &["status"]), 30);

    let collection = claim_next(&mut store, Some("collection:"), 40).expect("collection claim");
    assert_eq!(collection.automation_id, "collection:tasks#stamp");
    let plugin = claim_next(&mut store, Some("hello-plugin/"), 41).expect("plugin claim");
    assert_eq!(plugin.automation_id, "hello-plugin/triage");
    assert_eq!(
        plugin.trigger, collection.trigger,
        "each executor takes the oldest of its own claims"
    );
    assert!(
        claim_next(&mut store, Some("other-plugin/"), 42).is_none(),
        "another executor's prefix serves nothing"
    );
    let oldest = claim_next(&mut store, None, 43).expect("any claim");
    assert_eq!(
        oldest.trigger,
        AutomationTrigger::Coordinate {
            origin_id: "origin-a".to_owned(),
            origin_seq: 2,
        },
        "without a prefix, the oldest pending claim of any automation"
    );
    for invalid in ["", "a\0b"] {
        assert!(matches!(
            claim_next_pending_automation(&mut store, WS, Some(invalid), 44, &NO_FAULTS),
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
    claim_next(&mut store, None, 21).expect("one pending claim");
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
    claim_for(&mut store, WS, &at_cap, 30);

    let failures = list_automation_failures(&store, WS).expect("list failures");
    assert_eq!(failures.len(), 1, "one row per automation");
    assert_eq!(failures[0].automation_id, "plugin:triage");
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
    claim_next(&mut store, None, 41).expect("one pending claim");
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

    let running = claim_next(&mut store, None, 40).expect("a pending claim exists");
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

    let second_running = claim_next(&mut store, None, 60).expect("the second claim is pending");
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
        claim_next(&mut store, None, 70).is_none(),
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
fn a_retried_claim_runs_again_as_a_new_attempt_and_its_failures_keep_counting() {
    let scratch = ScratchDir::new().expect("scratch");
    let mut store = open_store(&scratch);
    subscribe(&mut store, "plugin:triage", "tasks");
    let claims = claim_for(&mut store, WS, &field_change(1, &["status"]), 20);
    let claim_id = claims[0].claim_id.clone();
    let fail = |store: &mut EngineStore, now_ms| {
        settle_automation_claim(
            store,
            WS,
            &claim_id,
            &AutomationSettle::Failed {
                error: format!("threw at {now_ms}"),
            },
            now_ms,
            &NO_FAULTS,
        )
        .expect("settle failed")
    };

    let retried = retry_automation_claim(&mut store, WS, &claim_id, 21, &NO_FAULTS)
        .expect("retry a pending claim");
    assert_eq!(
        retried.state,
        AutomationClaimState::Pending,
        "a pending claim is returned unchanged"
    );
    let running = claim_next(&mut store, None, 22).expect("served");
    assert_eq!(running.attempts, 1);
    let unchanged = retry_automation_claim(&mut store, WS, &claim_id, 23, &NO_FAULTS)
        .expect("retry a running claim");
    assert_eq!(unchanged, running, "a running claim is returned unchanged");
    fail(&mut store, 24);
    assert_eq!(
        list_automation_failures(&store, WS).expect("failures")[0].generation,
        1
    );

    let retried = retry_automation_claim(&mut store, WS, &claim_id, 25, &NO_FAULTS)
        .expect("retry a failed claim");
    assert_eq!(retried.state, AutomationClaimState::Pending);
    assert_eq!(retried.error, None);
    assert_eq!(retried.attempts, 1, "a retry spends no attempt by itself");
    assert!(
        list_automation_failures(&store, WS)
            .expect("failures")
            .is_empty(),
        "a retried claim is no longer a failure"
    );
    let (again, again_facts) = claim_next_pending_automation(&mut store, WS, None, 26, &NO_FAULTS)
        .expect("claim next")
        .expect("the retried claim is served");
    assert_eq!(again.claim_id, claim_id);
    assert_eq!(again.attempts, 2, "the attempt count keeps rising");
    assert_eq!(again_facts.fields[0].field_name, "status", "with its facts");
    fail(&mut store, 27);
    assert_eq!(
        list_automation_failures(&store, WS).expect("failures")[0].generation,
        2,
        "a failure after a retry still raises the generation"
    );

    retry_automation_claim(&mut store, WS, &claim_id, 28, &NO_FAULTS).expect("retry");
    claim_next(&mut store, None, 29).expect("served");
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
        let claim = claim_next(&mut store, None, 1_000 + index).expect("pending claim");
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
    let first = claim_next(&mut store, None, 30).expect("first");
    let second = claim_next(&mut store, None, 30).expect("second");
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

    let fresh = claim_next(&mut store, None, 200).expect("requeued or untouched pending");
    assert!(
        reclaim_running_automations(&mut store, WS, None, 2, 150, 210, &NO_FAULTS)
            .expect("reclaim again")
            .is_empty(),
        "a claim running since t=200 is younger than the bound and is left alone: {fresh:?}"
    );
}
