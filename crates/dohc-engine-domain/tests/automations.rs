//! The automation claim ledger (ADR 0008): subscription filters, claim
//! insertion from apply facts (change kinds, field filters, prefix
//! containment, self-skip, depth cap, trigger-key dedupe, workspace
//! scoping), the facts a claim carries, per-executor draining, the
//! pending -> running -> done | failed machine with retry, the claim history
//! and its retention, the startup reaper's requeue-or-exhaust rule, and
//! Group message claims.

use dohc_engine_domain::{
    AUTOMATION_CHAIN_DEPTH_CAP, AUTOMATION_CHAIN_STOPPED, AUTOMATION_GROUP_COVERAGE_MS,
    AUTOMATION_GROUP_FUTURE_MS, AUTOMATION_HISTORY_RETENTION_MS, AUTOMATION_RECLAIM_EXHAUSTED,
    AutomationChange, AutomationChangeKind, AutomationClaim, AutomationClaimLookup,
    AutomationClaimState, AutomationFactValue, AutomationFieldFact, AutomationGroupHandover,
    AutomationGroupHandoverAutomation, AutomationGroupMessage, AutomationGroupRelayRecord,
    AutomationGroupSkips, AutomationGroupSubscription, AutomationGroupWatch,
    AutomationGroupWatched, AutomationRetry, AutomationSettle, AutomationSubscription,
    AutomationTrigger, ChangeActorKind, ChangeAttribution, ChatActorKind, ChatChannelKind,
    ChatMessageAutomation, ChatThreadLane, CollectionFieldChangeFact, CollectionRecordApplyFacts,
    DispatchClaim, DomainError, LinkedChatStore, MAX_AUTOMATION_CLAIM_PAGE,
    MAX_AUTOMATION_FIELD_FACTS_BYTES, MAX_AUTOMATION_GROUP_HANDOVER_MESSAGES,
    MAX_AUTOMATION_SUBSCRIPTION_FIELDS, MAX_FIELD_FACT_VALUE_BYTES, MAX_MESSAGE_BODY_BYTES,
    NoFaults, SendMessage, SharedChangeAuthor, StartChannelThread, TxnOutcome,
    claim_automation_triggers_in_tx, claim_group_message_in_tx, claim_next_pending_automation,
    get_automation_claim, list_automation_claims, list_automation_failures,
    moment_author_attribution, moment_author_json, prune_automation_history,
    read_automation_group_skips, reclaim_running_automations, release_automation_claim,
    release_automation_groups, retry_automation_claim, settle_automation_claim,
    subscribe_automation, unsubscribe_automation, watch_automation_groups,
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

/// Subscribe to added and changed records on any field.
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
        shared_author: None,
        live_cursor: None,
        collection_path: collection_path.to_owned(),
        record_id: "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa".to_owned(),
        created: false,
        author_origin_id: author.map(str::to_owned),
        attribution: depth.map(|depth| ChangeAttribution {
            actor_kind: ChangeActorKind::Automation,
            on_behalf_of: Some("user:ice".to_owned()),
            depth,
            run: None,
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

    assert!(subscribe(&mut store, "collection:triage", "tasks"));
    assert!(
        !subscribe(&mut store, "collection:triage", "tasks"),
        "the same filter again changes nothing"
    );
    let narrowed = subscription(
        "collection:triage",
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
        unsubscribe_automation(&mut store, WS, "collection:triage", "tasks", &NO_FAULTS)
            .expect("unsubscribe")
    );
    assert!(
        !unsubscribe_automation(&mut store, WS, "collection:triage", "tasks", &NO_FAULTS)
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
            subscription("collection:", "tasks", ADDED_AND_CHANGED, None),
            "a bare namespace",
        ),
        (
            subscription("collection:triage", "", ADDED_AND_CHANGED, None),
            "a blank path",
        ),
        (
            subscription("collection:triage", "tasks", &[], None),
            "no change kind",
        ),
        (
            subscription("collection:triage", "tasks", ADDED_AND_CHANGED, Some(&[])),
            "an empty field list",
        ),
        (
            subscription("collection:triage", "tasks", ADDED_AND_CHANGED, Some(&[""])),
            "a blank field name",
        ),
        (
            subscription(
                "collection:triage",
                "tasks",
                ADDED_AND_CHANGED,
                Some(&["a\0b"]),
            ),
            "a NUL in a field name",
        ),
        (
            subscription(
                "collection:triage",
                "tasks",
                ADDED_AND_CHANGED,
                Some(&too_many),
            ),
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
        ("collection:triage", "tasks"),
        ("collection:triage", "."),
        ("collection:janitor", "."),
        ("collection:elsewhere", "notes"),
    ] {
        subscribe(&mut store, automation, prefix);
    }

    let applied = facts("tasks", Some(("origin-a", 41)), &[7], Some("alice"), None);
    let claims = claim_for(&mut store, WS, &applied, 20);
    assert_eq!(
        claimed_ids(&claims),
        vec!["collection:janitor", "collection:triage"],
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
        assert_eq!(claim.collection_path.as_deref(), Some("tasks"));
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
    subscribe(&mut store, "collection:triage", "tasks");

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
    subscribe(&mut store, "collection:triage", "tasks");

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
        run: None,
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
            shared_author: None,
            live_cursor: None,
            kind: AutomationChangeKind::Changed,
            author_origin_id: Some("agent-editor".to_owned()),
            actor_kind: Some(ChangeActorKind::Agent),
            on_behalf_of: Some("user:ice".to_owned()),
        }
    );

    let (served, served_facts) =
        claim_next_pending_automation(&mut store, WS, "collection:", 30, &NO_FAULTS)
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
fn a_claim_keeps_the_person_or_link_the_relay_accepted_its_change_from() {
    let scratch = ScratchDir::new().expect("scratch");
    let mut store = open_store(&scratch);
    assert!(subscribe(&mut store, "collection:tasks#stamp", "tasks"));
    let link = SharedChangeAuthor::Link {
        grant_id: "grant-link".to_owned(),
        grant_generation: 2,
        principal_id: "holder-1".to_owned(),
    };
    let named = SharedChangeAuthor::Named {
        user_id: "user-ana".to_owned(),
        grant_id: "grant-ana".to_owned(),
        grant_generation: 1,
    };
    // The person is the collaborator the relay accepted the change from,
    // never a link, and never what the frame declared.
    for (origin_seq, author, person) in [(1, link, None), (2, named, Some("user-ana"))] {
        let mut applied = field_change(origin_seq, &["status"]);
        applied.shared_author = Some(author.clone());
        applied.attribution = Some(ChangeAttribution {
            actor_kind: ChangeActorKind::Human,
            on_behalf_of: Some("claimed-person".to_owned()),
            depth: 0,
            run: None,
        });
        let claims = claim_for(&mut store, WS, &applied, 10 + origin_seq);
        assert_eq!(claims[0].change.shared_author.as_ref(), Some(&author));
        assert_eq!(claims[0].change.on_behalf_of.as_deref(), person);
        let (served, _) = claim_next_pending_automation(
            &mut store,
            WS,
            "collection:",
            20 + origin_seq,
            &NO_FAULTS,
        )
        .expect("claim next")
        .expect("the claim is pending");
        assert_eq!(
            served.change.shared_author,
            Some(author),
            "it survives the ledger"
        );
        assert_eq!(served.change.on_behalf_of.as_deref(), person);
    }
    // A shared author with a missing or unbounded id never reaches the ledger.
    let mut applied = field_change(3, &["status"]);
    applied.shared_author = Some(SharedChangeAuthor::Link {
        grant_id: "grant-link".to_owned(),
        grant_generation: 0,
        principal_id: "holder-1".to_owned(),
    });
    let refused = store.write_with(&NO_FAULTS, |tx| {
        claim_automation_triggers_in_tx(tx, WS, &applied, 40)
    });
    assert!(
        matches!(refused, Err(DomainError::InvalidInput { .. })),
        "{refused:?}"
    );
    assert_eq!(claim_rows(&store, WS), 2);
}

#[test]
fn a_claim_keeps_its_live_cursor_and_still_dedupes_on_its_change() {
    let scratch = ScratchDir::new().expect("scratch");
    let mut store = open_store(&scratch);
    assert!(subscribe(&mut store, "collection:tasks#stamp", "tasks"));
    let mut applied = field_change(1, &["status"]);
    applied.live_cursor = Some(41);
    let claims = claim_for(&mut store, WS, &applied, 10);
    assert_eq!(claims[0].change.live_cursor, Some(41));
    // The same change again, as a retried apply, claims nothing: the cursor
    // is not part of the key, whatever cursor the retry carries.
    applied.live_cursor = Some(42);
    assert!(claim_for(&mut store, WS, &applied, 11).is_empty());
    let (served, _) = claim_next_pending_automation(&mut store, WS, "collection:", 20, &NO_FAULTS)
        .expect("claim next")
        .expect("the claim is pending");
    assert_eq!(
        served.change.live_cursor,
        Some(41),
        "it survives the ledger"
    );
    // A cursor the relay never issues never reaches the ledger.
    let mut applied = field_change(2, &["status"]);
    applied.live_cursor = Some(0);
    let refused = store.write_with(&NO_FAULTS, |tx| {
        claim_automation_triggers_in_tx(tx, WS, &applied, 30)
    });
    assert!(
        matches!(refused, Err(DomainError::InvalidInput { .. })),
        "{refused:?}"
    );
    assert_eq!(claim_rows(&store, WS), 1);
}

#[test]
fn a_claims_field_facts_stay_within_their_budget() {
    let scratch = ScratchDir::new().expect("scratch");
    let mut store = open_store(&scratch);
    subscribe(&mut store, "collection:triage", "tasks");

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
        claim_next_pending_automation(&mut store, WS, "collection:", 30, &NO_FAULTS)
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
    subscribe(&mut store, "collection:triage", "tasks");

    let own_write = facts(
        "tasks",
        Some(("origin-a", 1)),
        &[1],
        Some("collection:triage"),
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
        Some("collection:other"),
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
        claim_next(&mut store, "collection:", 31).is_none(),
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
        Some("collection:triage"),
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
        Some("collection:other"),
        Some(AUTOMATION_CHAIN_DEPTH_CAP - 1),
    );
    let claims = claim_for(&mut store, WS, &below_cap, 40);
    assert_eq!(claims.len(), 1, "one below the cap still claims");
    assert_eq!(claims[0].depth, AUTOMATION_CHAIN_DEPTH_CAP - 1);
    assert_eq!(claims[0].state, AutomationClaimState::Pending);
}

#[test]
fn claim_next_drains_only_the_given_prefix() {
    let scratch = ScratchDir::new().expect("scratch");
    let mut store = open_store(&scratch);
    subscribe(&mut store, "collection:notes#triage", "tasks");
    subscribe(&mut store, "collection:tasks#stamp", "tasks");
    claim_for(&mut store, WS, &field_change(1, &["status"]), 20);
    claim_for(&mut store, WS, &field_change(2, &["status"]), 30);

    let stamp = claim_next(&mut store, "collection:tasks#", 40).expect("stamp claim");
    assert_eq!(stamp.automation_id, "collection:tasks#stamp");
    let triage = claim_next(&mut store, "collection:notes#", 41).expect("triage claim");
    assert_eq!(triage.automation_id, "collection:notes#triage");
    assert_eq!(
        triage.trigger, stamp.trigger,
        "each prefix takes the oldest of its own claims"
    );
    assert!(
        claim_next(&mut store, "other:", 42).is_none(),
        "another prefix serves nothing"
    );
    let second = claim_next(&mut store, "collection:notes#", 43).expect("second triage claim");
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
    subscribe(&mut store, "collection:triage", "tasks");

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
    claim_next(&mut store, "collection:", 21).expect("one pending claim");
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
        Some("collection:other"),
        Some(AUTOMATION_CHAIN_DEPTH_CAP),
    );
    let stopped = claim_for(&mut store, WS, &at_cap, 30);

    let failures = list_automation_failures(&store, WS).expect("list failures");
    assert_eq!(failures.len(), 1, "one row per automation");
    assert_eq!(failures[0].automation_id, "collection:triage");
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
    claim_next(&mut store, "collection:", 41).expect("one pending claim");
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
    subscribe(&mut store, "collection:triage", "tasks");
    let first = facts("tasks", Some(("origin-a", 1)), &[1], Some("alice"), None);
    let second = facts("tasks", Some(("origin-a", 2)), &[2], Some("alice"), None);
    claim_for(&mut store, WS, &first, 20);
    claim_for(&mut store, WS, &second, 30);

    let running = claim_next(&mut store, "collection:", 40).expect("a pending claim exists");
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
        claim_next(&mut store, "collection:", 60).expect("the second claim is pending");
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
        claim_next(&mut store, "collection:", 70).is_none(),
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
    subscribe(&mut store, "collection:triage", "tasks");
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
    let running = claim_next(&mut store, "collection:", 22).expect("served");
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
        claim_next_pending_automation(&mut store, WS, "collection:", 26, &NO_FAULTS)
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
    claim_next(&mut store, "collection:", 29).expect("served");
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
        Some("collection:other"),
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
    subscribe(&mut store, "collection:triage", "tasks");
    let claims = claim_for(&mut store, WS, &field_change(1, &["status"]), 20);
    let claim_id = claims[0].claim_id.clone();
    let reclaim = |store: &mut EngineStore, now_ms| {
        reclaim_running_automations(store, WS, None, 2, now_ms, now_ms, &NO_FAULTS)
            .expect("reclaim")
    };

    // Run 1 crashes: the reaper requeues it, and the next serve is the same
    // run, so its writes repeat under the same keys.
    let first = claim_next(&mut store, "collection:", 30).expect("served");
    assert_eq!((first.attempts, first.run), (1, 1));
    assert_eq!(
        reclaim(&mut store, 40)[0].state,
        AutomationClaimState::Pending
    );
    let requeued = claim_next(&mut store, "collection:", 50).expect("served again");
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
    let retried = claim_next(&mut store, "collection:", 80).expect("served");
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

/// Every claim of an automation, a page at a time, newest first.
fn every_claim(store: &EngineStore, automation_id: &str, limit: i64) -> Vec<AutomationClaim> {
    let mut claims = Vec::new();
    let mut before = None;
    loop {
        let page = list_automation_claims(store, WS, automation_id, before.as_ref(), limit)
            .expect("list claims");
        claims.extend(page.claims);
        match page.next {
            Some(next) => before = Some(next),
            None => return claims,
        }
    }
}

fn automation_claim_rows(store: &EngineStore, automation_id: &str) -> i64 {
    store
        .read_with(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM automation_claims \
                 WHERE workspace_id = ?1 AND automation_id = ?2",
                [WS, automation_id],
                |row| row.get(0),
            )
        })
        .expect("count claims")
}

/// Failed claims past 30 days leave run history, except the automation's
/// newest failure, which its notice offers. An expired failure cannot run
/// again, and every failure stays counted.
#[test]
fn failed_claims_expire_after_30_days_except_the_newest() {
    let scratch = ScratchDir::new().expect("scratch");
    let mut store = open_store(&scratch);
    subscribe(&mut store, "collection:triage", "tasks");
    let fail = |store: &mut EngineStore, seq: i64, now_ms: i64| {
        claim_for(store, WS, &field_change(seq, &["status"]), now_ms);
        let claim = claim_next(store, "collection:", now_ms).expect("pending claim");
        settle_automation_claim(
            store,
            WS,
            &claim.claim_id,
            &AutomationSettle::Failed {
                error: "run threw".to_owned(),
            },
            now_ms,
            &NO_FAULTS,
        )
        .expect("settle");
        claim.claim_id
    };
    let count = 50;
    let failed = (1..=count)
        .map(|seq| fail(&mut store, seq, 1_000 + seq))
        .collect::<Vec<_>>();
    let generation =
        |store: &EngineStore| list_automation_failures(store, WS).expect("failures")[0].generation;
    assert_eq!(generation(&store), count);

    let later = 1_000 + count + AUTOMATION_HISTORY_RETENTION_MS + 1;
    let pruned = prune_automation_history(&mut store, WS, &[], later, &NO_FAULTS).expect("prune");
    assert_eq!((pruned.pruned as i64, pruned.more), (count - 1, false));
    let newest = failed.last().expect("a failure").clone();
    assert_eq!(
        every_claim(&store, "collection:triage", 20)
            .iter()
            .map(|claim| claim.claim_id.clone())
            .collect::<Vec<_>>(),
        vec![newest.clone()]
    );
    assert_eq!(generation(&store), count, "every failure stays counted");
    assert!(matches!(
        retry_automation_claim(&mut store, WS, &failed[0], later, &NO_FAULTS),
        Err(DomainError::InvalidInput { .. })
    ));

    // A newer failure takes over the notice, and the old newest expires.
    let newer = fail(&mut store, count + 1, later);
    let pruned = prune_automation_history(
        &mut store,
        WS,
        &[],
        later + AUTOMATION_HISTORY_RETENTION_MS,
        &NO_FAULTS,
    )
    .expect("prune");
    assert_eq!(pruned.pruned, 1);
    assert_eq!(
        list_automation_failures(&store, WS).expect("failures")[0].claim_id,
        newer
    );
    assert_eq!(generation(&store), count + 1);
}

#[test]
fn the_claim_history_pages_newest_first_and_keeps_done_claims_30_days() {
    let scratch = ScratchDir::new().expect("scratch");
    let mut store = open_store(&scratch);
    subscribe(&mut store, "collection:triage", "tasks");
    subscribe(&mut store, "collection:other", "tasks");
    let count = MAX_AUTOMATION_CLAIM_PAGE + 5;
    for seq in 0..count {
        claim_for(
            &mut store,
            WS,
            &field_change(seq + 1, &["status"]),
            100 + seq,
        );
    }

    // The first two triage claims fail. The first then runs again and is
    // done; the second stays failed.
    let mut failed = Vec::new();
    for index in 0..2 * count {
        let claim = claim_next(&mut store, "collection:", 1_000 + index).expect("pending claim");
        let settle = if failed.len() < 2 && claim.automation_id == "collection:triage" {
            failed.push(claim.claim_id.clone());
            AutomationSettle::Failed {
                error: "run threw".to_owned(),
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
    retry_automation_claim(&mut store, WS, &failed[0], 2_000, &NO_FAULTS).expect("retry");
    let rerun = claim_next(&mut store, "collection:triage", 2_001).expect("the retried claim");
    settle_automation_claim(
        &mut store,
        WS,
        &rerun.claim_id,
        &AutomationSettle::Done,
        2_002,
        &NO_FAULTS,
    )
    .expect("settle the retry");
    let generation =
        |store: &EngineStore| list_automation_failures(store, WS).expect("failures")[0].generation;
    assert_eq!(generation(&store), 2);

    let history = every_claim(&store, "collection:triage", 20);
    assert_eq!(history.len() as i64, count);
    assert!(
        history
            .windows(2)
            .all(|pair| pair[0].created_at_ms > pair[1].created_at_ms),
        "newest first, across pages"
    );
    assert_eq!(
        history,
        every_claim(&store, "collection:triage", MAX_AUTOMATION_CLAIM_PAGE)
    );
    for limit in [0, MAX_AUTOMATION_CLAIM_PAGE + 1] {
        assert!(matches!(
            list_automation_claims(&store, WS, "collection:triage", None, limit),
            Err(DomainError::InvalidInput { .. })
        ));
    }
    let empty =
        list_automation_claims(&store, WS, "collection:missing", None, 20).expect("list claims");
    assert!(empty.claims.is_empty() && empty.next.is_none());

    // Within 30 days of settling, every claim stays.
    let pruned = prune_automation_history(
        &mut store,
        WS,
        &[],
        1_000 + AUTOMATION_HISTORY_RETENTION_MS,
        &NO_FAULTS,
    )
    .expect("prune");
    assert_eq!((pruned.pruned, pruned.more), (0, false));
    assert_eq!(automation_claim_rows(&store, "collection:triage"), count);

    // Past it, a done claim goes unless the prune keeps it. A failed claim
    // stays, and the retried claim's first failure still counts.
    let kept = every_claim(&store, "collection:other", 20)[0]
        .claim_id
        .clone();
    let pruned = prune_automation_history(
        &mut store,
        WS,
        std::slice::from_ref(&kept),
        2_002 + AUTOMATION_HISTORY_RETENTION_MS + 1,
        &NO_FAULTS,
    )
    .expect("prune");
    assert_eq!((pruned.pruned as i64, pruned.more), (2 * count - 2, false));
    assert_eq!(automation_claim_rows(&store, "collection:triage"), 1);
    assert_eq!(automation_claim_rows(&store, "collection:other"), 1);
    assert_eq!(
        generation(&store),
        2,
        "pruning never lowers the failure generation"
    );
    assert_eq!(
        get_automation_claim(&store, WS, &AutomationClaimLookup::Id(kept.clone()))
            .expect("get")
            .map(|claim| claim.claim_id),
        Some(kept)
    );
    assert_eq!(
        get_automation_claim(&store, WS, &AutomationClaimLookup::Id(failed[0].clone()))
            .expect("get"),
        None
    );
    assert_eq!(
        every_claim(&store, "collection:triage", 20)
            .iter()
            .map(|claim| claim.claim_id.as_str())
            .collect::<Vec<_>>(),
        vec![failed[1].as_str()]
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
    subscribe(&mut store, "collection:triage", "tasks");
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

    let served = claim_next(&mut store, "collection:", 22).expect("served");
    assert_eq!((served.attempts, served.run), (1, 1));
    let released = release(&mut store, 23).expect("release");
    assert_eq!(released.state, AutomationClaimState::Pending);
    assert_eq!(
        (released.attempts, released.run),
        (claims[0].attempts, 1),
        "a release is not an attempt"
    );

    let again = claim_next(&mut store, "collection:", 24).expect("served again");
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

    claim_next(&mut store, "collection:", 110).expect("served after the reaper");
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
    subscribe(&mut store, "collection:triage", "tasks");
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
    let first = claim_next(&mut store, "collection:", 30).expect("first");
    let second = claim_next(&mut store, "collection:", 30).expect("second");
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

    let fresh = claim_next(&mut store, "collection:", 200).expect("requeued or untouched pending");
    assert!(
        reclaim_running_automations(&mut store, WS, None, 2, 150, 210, &NO_FAULTS)
            .expect("reclaim again")
            .is_empty(),
        "a claim running since t=200 is younger than the bound and is left alone: {fresh:?}"
    );
}

// ------------------------------------------------------- Group messages

const GROUP: &str = "gen-1";
const TASK: &str = "collection:object-tasks#task";
const ALL: &str = "collection:object-tasks#all";

fn open_group(scratch: &ScratchDir) -> EngineStore {
    let mut store = open_store(scratch);
    LinkedChatStore::new(&mut store)
        .ensure_general_channel(WS, GROUP, 5, &NO_FAULTS)
        .expect("Group");
    store
}

/// Every Group subscription this store watches: (automation, Group, starting text).
type Watching<'a> = &'a [(&'a str, &'a str, Option<&'a str>)];

fn watch_at(
    store: &mut EngineStore,
    generation: i64,
    watching: Watching<'_>,
    relay: Option<AutomationGroupRelayRecord>,
    now_ms: i64,
) -> Result<AutomationGroupWatched, DomainError> {
    watch_automation_groups(
        store,
        WS,
        &AutomationGroupWatch {
            generation,
            subscriptions: watching
                .iter()
                .map(
                    |(automation_id, channel_id, starts_with)| AutomationGroupSubscription {
                        automation_id: (*automation_id).to_owned(),
                        channel_id: (*channel_id).to_owned(),
                        starts_with: starts_with.map(str::to_owned),
                    },
                )
                .collect(),
            relay,
        },
        now_ms,
        &NO_FAULTS,
    )
}

/// Watch these as a workspace that never synced, at time 10.
fn watch_groups(
    store: &mut EngineStore,
    watching: Watching<'_>,
) -> Result<AutomationGroupWatched, DomainError> {
    watch_at(store, 0, watching, None, 10)
}

/// The Group subscriptions a store holds: (automation, starts at, frozen).
fn group_rows(store: &EngineStore, workspace_id: &str) -> Vec<(String, i64, bool)> {
    store
        .read_with(|conn| {
            conn.prepare(
                "SELECT automation_id, created_at_ms, frozen FROM automation_group_subscriptions \
                 WHERE workspace_id = ?1 ORDER BY automation_id",
            )?
            .query_map([workspace_id], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })?
            .collect()
        })
        .expect("Group subscriptions")
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
                watch_groups(&mut store, &[(TASK, channel_id, None)]),
                Err(DomainError::InvalidInput {
                    reason: "A Group subscription names a Group on this computer."
                })
            ),
            "{channel_id}"
        );
    }
    watch_groups(&mut store, &[(TASK, GROUP, Some("/task"))]).expect("watch");
    assert_eq!(group_rows(&store, WS), vec![(TASK.to_owned(), 10, false)]);
    watch_groups(&mut store, &[(TASK, GROUP, None)]).expect("a new starting text");
    for (automation_id, starts_with) in [
        ("collection:triage", None),
        ("collection:../Secrets#task", None),
        (TASK, Some("")),
        (TASK, Some(" /task")),
    ] {
        assert!(
            matches!(
                watch_groups(&mut store, &[(automation_id, GROUP, starts_with)]),
                Err(DomainError::InvalidInput { .. })
            ),
            "{automation_id} {starts_with:?}"
        );
    }
    assert!(
        matches!(
            watch_groups(
                &mut store,
                &[(TASK, GROUP, None), (TASK, GROUP, Some("/x"))]
            ),
            Err(DomainError::InvalidInput {
                reason: "An automation watches one Group."
            })
        ),
        "one Group per automation"
    );
    assert_eq!(
        group_rows(&store, WS),
        vec![(TASK.to_owned(), 10, false)],
        "a refused watch changes nothing"
    );
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
    watch_groups(&mut store, &[]).expect("watch nothing");
    assert_eq!(group_rows(&store, WS), Vec::new());
}

/// A Group message claims once for each subscription whose starting text it
/// begins with, in the write that stores it, and the executor gets the
/// message with the claim. A removed subscription and a second store of the
/// same message claim nothing.
#[test]
fn a_group_message_claims_each_matching_subscription_once() {
    let scratch = ScratchDir::new().expect("scratch");
    let mut store = open_group(&scratch);
    watch_groups(
        &mut store,
        &[(TASK, GROUP, Some("/task")), (ALL, GROUP, None)],
    )
    .expect("watch");

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
    assert_eq!(claim.collection_path, None);
    assert_eq!(claim.depth, 0);
    assert_eq!(
        claim.change,
        AutomationChange {
            shared_author: None,
            live_cursor: None,
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

    // A message posted before the subscription starts claims nothing.
    assert!(posted(&mut store, &post("m-early", "/task Old", 9)).is_empty());

    watch_groups(&mut store, &[(ALL, GROUP, None)]).expect("only all");
    let claims = posted(&mut store, &post("m3", "/task Pack", 40));
    assert_eq!(claimed_ids(&claims), vec![ALL]);
}

/// Releasing freezes every Group subscription in the workspace at once: a
/// message stored after it claims nothing here, a repeated release answers
/// the same, and record subscriptions and another workspace's Group
/// subscriptions stay.
#[test]
fn releasing_group_subscriptions_stops_message_claims_here() {
    const OTHER: &str = "ws-other";
    let scratch = ScratchDir::new().expect("scratch");
    let mut store = open_group(&scratch);
    LinkedChatStore::new(&mut store)
        .ensure_general_channel(OTHER, GROUP, 5, &NO_FAULTS)
        .expect("the other workspace's Group");
    watch_groups(
        &mut store,
        &[(TASK, GROUP, Some("/task")), (ALL, GROUP, None)],
    )
    .expect("watch");
    watch_automation_groups(
        &mut store,
        OTHER,
        &AutomationGroupWatch {
            generation: 0,
            subscriptions: vec![AutomationGroupSubscription {
                automation_id: TASK.to_owned(),
                channel_id: GROUP.to_owned(),
                starts_with: None,
            }],
            relay: None,
        },
        10,
        &NO_FAULTS,
    )
    .expect("the other workspace's subscription");
    assert!(subscribe(&mut store, TASK, "Trip/Tasks"));
    let decided = claimed_ids(&posted(&mut store, &post("m1", "/task Buy tickets", 20)))
        .into_iter()
        .map(str::to_owned)
        .collect::<Vec<_>>();
    assert_eq!(decided, vec![ALL, TASK]);

    let released = release_automation_groups(&mut store, WS, 50, &NO_FAULTS).expect("release");
    assert_eq!(
        released.watched_generation, 0,
        "a workspace that never synced watches at 0"
    );
    let handover = released.handover;
    assert_eq!(
        group_rows(&store, WS),
        vec![(ALL.to_owned(), 10, true), (TASK.to_owned(), 10, true)]
    );
    assert!(posted(&mut store, &post("m2", "/task Pack", 60)).is_empty());
    assert_eq!(
        release_automation_groups(&mut store, WS, 50, &NO_FAULTS)
            .expect("again")
            .handover,
        handover,
        "a release repeated after a lost answer answers the same"
    );
    assert_eq!(
        handover.automations,
        vec![
            AutomationGroupHandoverAutomation {
                automation_id: ALL.to_owned(),
                since_ms: 10,
                decided: vec![("m1".to_owned(), 20)],
            },
            AutomationGroupHandoverAutomation {
                automation_id: TASK.to_owned(),
                since_ms: 10,
                decided: vec![("m1".to_owned(), 20)],
            },
        ]
    );
    assert_eq!(
        group_rows(&store, OTHER),
        vec![(TASK.to_owned(), 10, false)],
        "another workspace keeps its own"
    );
    assert!(
        !subscribe(&mut store, TASK, "Trip/Tasks"),
        "the record subscription stays"
    );
}

/// An automation's post never claims for that automation, carries its
/// depth, and at the cap records the stop instead of a run.
#[test]
fn an_automations_message_skips_its_writer_and_stops_at_the_cap() {
    let scratch = ScratchDir::new().expect("scratch");
    let mut store = open_group(&scratch);
    watch_groups(&mut store, &[(TASK, GROUP, None), (ALL, GROUP, None)]).expect("watch");
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
/// `get_message` reads it whole. Once run history expires a settled
/// message claim, it keeps its key without its message, so the message
/// never claims twice.
#[test]
fn a_long_message_travels_truncated_and_a_settled_claim_keeps_its_key() {
    let scratch = ScratchDir::new().expect("scratch");
    let mut store = open_group(&scratch);
    watch_groups(&mut store, &[(ALL, GROUP, None)]).expect("watch");
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

    let expire = |store: &mut EngineStore| {
        prune_automation_history(
            store,
            WS,
            &[],
            22 + AUTOMATION_HISTORY_RETENTION_MS + 1,
            &NO_FAULTS,
        )
        .expect("prune")
        .pruned
    };
    assert_eq!(expire(&mut store), 1);
    assert_eq!(expire(&mut store), 0, "an expired key is not read again");
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
    assert!(
        every_claim(&store, ALL, 20).is_empty(),
        "a key is not history"
    );
    assert_eq!(
        get_automation_claim(&store, WS, &AutomationClaimLookup::Id(claim.claim_id)).expect("get"),
        None
    );
}

// ------------------------------------------------- automations and agent runs

const STAMP: &str = "collection:tasks#stamp";
const ASK: &str = "collection:tasks#ask";
const MY_AGENT: &str = "agent-1";

/// A change to `field` on the task, made by `actor` at its depth, or by a
/// person when there is none.
fn changed_by(
    origin_seq: i64,
    field: &str,
    actor: Option<(&str, ChangeActorKind, u32)>,
) -> CollectionRecordApplyFacts {
    let mut applied = field_change(origin_seq, &[field]);
    if let Some((actor, actor_kind, depth)) = actor {
        applied.author_origin_id = Some(actor.to_owned());
        applied.attribution = Some(ChangeAttribution {
            actor_kind,
            on_behalf_of: Some("local".to_owned()),
            depth,
            run: None,
        });
    }
    applied
}

/// A message in My agent that the dispatch runs the agent for: a person's
/// request, or an automation's wake at its chain depth.
fn ask_agent(
    store: &mut EngineStore,
    message_id: &str,
    wake_depth: Option<u32>,
    now_ms: i64,
) -> DispatchClaim {
    let mut request = StartChannelThread {
        channel_id: MY_AGENT.to_owned(),
        author_user_id: None,
        ..post(message_id, "Plan the trip", now_ms)
    };
    if let Some(chain_depth) = wake_depth {
        request.author_kind = ChatActorKind::Automation;
        request.author_display_name = "Ask my agent".to_owned();
        request.author_owner_display_name = Some("Ice".to_owned());
        request.automation = Some(ChatMessageAutomation {
            automation_id: ASK.to_owned(),
            chain_depth,
        });
    }
    let mut chats = LinkedChatStore::new(store);
    chats
        .start_channel_thread(&request, &NO_FAULTS)
        .expect("message");
    chats
        .enqueue_dispatch(WS, message_id, &request.thread_id, now_ms, &NO_FAULTS)
        .expect("queue the agent");
    chats
        .claim_next_pending(
            WS,
            &format!("run-{message_id}"),
            "agent",
            None,
            now_ms,
            &NO_FAULTS,
        )
        .expect("claim the run")
        .expect("a run")
}

/// An automation that wakes the agent, and one that answers the agent's
/// change, share one depth counter with the agent's run. Each hop goes one
/// deeper, and the chain stops at the cap with a failed claim the owner sees
/// in Notices, instead of the three waking each other forever.
#[test]
fn an_automation_and_the_agent_it_wakes_stop_each_other_at_the_cap() {
    let scratch = ScratchDir::new().expect("scratch");
    let mut store = open_store(&scratch);
    for (automation_id, field) in [(STAMP, "Status"), (ASK, "Stamped")] {
        subscribe_automation(
            &mut store,
            WS,
            &subscription(
                automation_id,
                "tasks",
                &[AutomationChangeKind::Changed],
                Some(&[field]),
            ),
            10,
            &NO_FAULTS,
        )
        .expect("subscribe");
    }
    LinkedChatStore::new(&mut store)
        .ensure_agent_channel(WS, MY_AGENT, 5, &NO_FAULTS)
        .expect("My agent");

    // A person asks the agent directly: its writes start a chain at 0.
    let asked = ask_agent(&mut store, "m-person", None, 10);
    assert_eq!(asked.chain_depth, 0);
    LinkedChatStore::new(&mut store)
        .complete_dispatch(WS, &asked.run.run_id, 0, 11, &NO_FAULTS)
        .expect("the person's run ends");

    // A person changes Status; Stamp stamps the task one level deeper.
    let stamp = claim_for(&mut store, WS, &changed_by(1, "Status", None), 20);
    assert_eq!((claimed_ids(&stamp), stamp[0].depth), (vec![STAMP], 0));
    let ask = claim_for(
        &mut store,
        WS,
        &changed_by(2, "Stamped", Some((STAMP, ChangeActorKind::Automation, 1))),
        21,
    );
    assert_eq!((claimed_ids(&ask), ask[0].depth), (vec![ASK], 1));

    // Ask wakes the agent with a message one deeper; the run is one deeper still.
    let woken = ask_agent(&mut store, "m-wake", Some(2), 22);
    assert_eq!(woken.chain_depth, 3);

    // The agent changes Status during the run; Stamp answers at the run's depth.
    let stamp = claim_for(
        &mut store,
        WS,
        &changed_by(
            3,
            "Status",
            Some((
                "dohc-chat-runner",
                ChangeActorKind::Agent,
                woken.chain_depth,
            )),
        ),
        23,
    );
    assert_eq!((claimed_ids(&stamp), stamp[0].depth), (vec![STAMP], 3));
    assert!(!stamp[0].chain_stopped());

    // Stamp's write reaches the cap: Ask's claim records the stop instead of a run.
    let stopped = claim_for(
        &mut store,
        WS,
        &changed_by(
            4,
            "Stamped",
            Some((
                STAMP,
                ChangeActorKind::Automation,
                AUTOMATION_CHAIN_DEPTH_CAP,
            )),
        ),
        24,
    );
    assert_eq!(claimed_ids(&stopped), vec![ASK]);
    assert!(stopped[0].chain_stopped());
    let failures = list_automation_failures(&store, WS).expect("failures");
    assert_eq!(failures.len(), 1);
    assert_eq!(failures[0].automation_id, ASK);
    assert!(failures[0].chain_stopped);
    assert_eq!(failures[0].error, AUTOMATION_CHAIN_STOPPED);
}

/// A run that covers several wakes writes one deeper than the deepest.
#[test]
fn a_run_covering_several_wakes_takes_the_deepest() {
    let scratch = ScratchDir::new().expect("scratch");
    let mut store = open_store(&scratch);
    let mut chats = LinkedChatStore::new(&mut store);
    chats
        .ensure_agent_channel(WS, MY_AGENT, 5, &NO_FAULTS)
        .expect("My agent");
    let thread = StartChannelThread {
        channel_id: MY_AGENT.to_owned(),
        author_user_id: None,
        ..post("m-first", "Plan the trip", 10)
    };
    chats
        .start_channel_thread(&thread, &NO_FAULTS)
        .expect("a person's request");
    for (message_id, chain_depth) in [("m-deep", 3), ("m-shallow", 1)] {
        chats
            .send_message(
                &SendMessage {
                    workspace_id: WS.to_owned(),
                    thread_id: thread.thread_id.clone(),
                    message_id: message_id.to_owned(),
                    author_kind: ChatActorKind::Automation,
                    author_display_name: "Ask my agent".to_owned(),
                    author_owner_display_name: Some("Ice".to_owned()),
                    author_user_id: None,
                    parent_message_id: None,
                    origin: None,
                    body: "Plan the trip".to_owned(),
                    needs_decision: false,
                    options: Vec::new(),
                    attachments: Vec::new(),
                    automation: Some(ChatMessageAutomation {
                        automation_id: ASK.to_owned(),
                        chain_depth,
                    }),
                    now_ms: 11,
                    request_id: None,
                },
                &NO_FAULTS,
            )
            .expect("a wake");
    }
    for (message_id, now_ms) in [("m-first", 12), ("m-deep", 13), ("m-shallow", 14)] {
        chats
            .enqueue_dispatch(WS, message_id, &thread.thread_id, now_ms, &NO_FAULTS)
            .expect("queue");
    }
    let claim = chats
        .claim_next_pending(WS, "run-1", "agent", None, 15, &NO_FAULTS)
        .expect("claim")
        .expect("a run");
    assert_eq!(claim.run.trigger_message_id, "m-first");
    assert_eq!(claim.chain_depth, 4);
    let open = chats
        .list_open_dispatch_runs(WS, None, 10)
        .expect("open runs");
    assert_eq!(
        open.iter()
            .map(|claim| claim.chain_depth)
            .collect::<Vec<_>>(),
        vec![4]
    );

    // A restart interrupts the run, and every trigger it covered goes back to
    // the queue. A person's later request that sorts first starts the next
    // run, which still counts the wakes the interrupted run covered.
    chats
        .reclaim_running_dispatches(WS, 2, 16, &NO_FAULTS)
        .expect("reclaim");
    let pending = chats
        .list_pending_dispatches(WS, None, 10)
        .expect("pending");
    assert_eq!(pending.len(), 3, "{pending:?}");
    chats
        .send_message(
            &SendMessage {
                workspace_id: WS.to_owned(),
                thread_id: thread.thread_id.clone(),
                message_id: "m-early".to_owned(),
                author_kind: ChatActorKind::Human,
                author_display_name: "Ada".to_owned(),
                author_owner_display_name: None,
                author_user_id: None,
                parent_message_id: None,
                origin: None,
                body: "And book the train".to_owned(),
                needs_decision: false,
                options: Vec::new(),
                attachments: Vec::new(),
                automation: None,
                now_ms: 17,
                request_id: None,
            },
            &NO_FAULTS,
        )
        .expect("a person's request");
    chats
        .enqueue_dispatch(WS, "m-early", &thread.thread_id, 11, &NO_FAULTS)
        .expect("queue");
    let again = chats
        .claim_next_pending(WS, "run-2", "agent", None, 18, &NO_FAULTS)
        .expect("claim again")
        .expect("the requeued run");
    assert_eq!(again.run.trigger_message_id, "m-early");
    assert_eq!(again.chain_depth, 4);

    // A second restart gives back only what has attempts left.
    chats
        .reclaim_running_dispatches(WS, 2, 19, &NO_FAULTS)
        .expect("reclaim again");
    let pending: Vec<String> = chats
        .list_pending_dispatches(WS, None, 10)
        .expect("pending")
        .into_iter()
        .map(|row| row.trigger_message_id)
        .collect();
    assert_eq!(pending, vec!["m-early".to_owned()]);
}

/// An agent's post in a Group during a run claims at the run's depth, so the
/// agent cannot start a chain over by posting. After the run, an agent's post
/// claims at 0, as a person's does.
#[test]
fn an_agents_post_during_a_run_claims_at_the_runs_depth() {
    let scratch = ScratchDir::new().expect("scratch");
    let mut store = open_group(&scratch);
    watch_groups(&mut store, &[(ALL, GROUP, None)]).expect("all");
    LinkedChatStore::new(&mut store)
        .ensure_agent_channel(WS, MY_AGENT, 5, &NO_FAULTS)
        .expect("My agent");
    let woken = ask_agent(&mut store, "m-wake", Some(2), 10);
    let by_agent = |message_id: &str, now_ms: i64| StartChannelThread {
        author_kind: ChatActorKind::Agent,
        author_display_name: "Claude".to_owned(),
        author_owner_display_name: Some("Ice".to_owned()),
        origin: Some("cli".to_owned()),
        ..post(message_id, "Booked the train", now_ms)
    };

    let claims = posted(&mut store, &by_agent("m-agent", 11));
    assert_eq!(claimed_ids(&claims), vec![ALL]);
    assert_eq!(claims[0].depth, woken.chain_depth);
    assert_eq!(claims[0].change.actor_kind, Some(ChangeActorKind::Agent));
    // The depth travels with the post, so another computer's Group
    // automation counts it too.
    fn exported(store: &EngineStore, message_id: &str) -> serde_json::Value {
        let payload: String = store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT payload_json FROM replication_log \
                     WHERE workspace_id = ?1 AND op_kind = 'chat.message.append' \
                       AND json_extract(payload_json, '$.messageId') = ?2",
                    [WS, message_id],
                    |row| row.get(0),
                )
            })
            .expect("exported post");
        serde_json::from_str(&payload).expect("payload JSON")
    }
    assert_eq!(
        exported(&store, "m-agent")["chainDepth"],
        json!(woken.chain_depth)
    );

    LinkedChatStore::new(&mut store)
        .complete_dispatch(WS, &woken.run.run_id, 0, 12, &NO_FAULTS)
        .expect("the run ends");
    let after = posted(&mut store, &by_agent("m-later", 13));
    assert_eq!(after[0].depth, 0);
    assert_eq!(exported(&store, "m-later").get("chainDepth"), None);
}

/// An agent run's file writes name its chain depth, so the claims they cause
/// carry it. A run a person started names none, so its history reads as
/// before.
#[test]
fn an_agents_moment_author_carries_its_runs_depth() {
    for depth in [0, 3] {
        let attribution = ChangeAttribution {
            actor_kind: ChangeActorKind::Agent,
            on_behalf_of: Some("local".to_owned()),
            depth,
            run: None,
        };
        let author =
            moment_author_json(Some("dohc-chat-runner"), Some(&attribution)).expect("author");
        let named: serde_json::Value = serde_json::from_str(&author).expect("author JSON");
        assert_eq!(named[0].get("depth").is_some(), depth > 0, "{author}");
        assert_eq!(
            moment_author_attribution(Some(&author)),
            (Some("dohc-chat-runner".to_owned()), Some(attribution))
        );
    }
}

/// One of the owner's computers in a handover test, and every claim it took.
/// The store is declared before its directory, so it closes first and the
/// directory can go.
struct Computer {
    store: EngineStore,
    claimed: Vec<(String, String)>,
    _scratch: ScratchDir,
}

impl Computer {
    fn new() -> Self {
        let scratch = ScratchDir::new().expect("scratch");
        let store = open_group(&scratch);
        Computer {
            _scratch: scratch,
            store,
            claimed: Vec::new(),
        }
    }

    fn keep(&mut self, claims: Vec<AutomationClaim>) {
        for claim in claims {
            let AutomationTrigger::Key { key } = &claim.trigger else {
                panic!("a message claim keys on its message");
            };
            let message = key.strip_prefix("message:").expect("message key");
            self.claimed
                .push((claim.automation_id.clone(), message.to_owned()));
        }
    }

    /// A message reaches this computer: a post here, or one another computer
    /// sent, which stores the same way.
    fn store_message(&mut self, message: &StartChannelThread) {
        let claims = posted(&mut self.store, message);
        self.keep(claims);
    }

    fn watch(
        &mut self,
        generation: i64,
        relay: Option<AutomationGroupRelayRecord>,
        now_ms: i64,
    ) -> AutomationGroupWatched {
        let watched = watch_at(
            &mut self.store,
            generation,
            &[(TASK, GROUP, Some("/task")), (ALL, GROUP, None)],
            relay,
            now_ms,
        )
        .expect("watch");
        self.keep(watched.claims.clone());
        watched
    }
}

/// The relay's last release or take over at `generation`, 0 for none, with
/// no handover left for this computer.
fn recorded(generation: i64) -> Option<AutomationGroupRelayRecord> {
    Some(AutomationGroupRelayRecord {
        generation,
        handover: None,
    })
}

/// The handover a release at `generation` left for this computer.
fn fetched(
    generation: i64,
    handover: AutomationGroupHandover,
) -> Option<AutomationGroupRelayRecord> {
    Some(AutomationGroupRelayRecord {
        generation,
        handover: Some(handover),
    })
}

fn pairs(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
    let mut pairs: Vec<(String, String)> = pairs
        .iter()
        .map(|(automation, message)| ((*automation).to_owned(), (*message).to_owned()))
        .collect();
    pairs.sort();
    pairs
}

fn sorted(mut claimed: Vec<(String, String)>) -> Vec<(String, String)> {
    claimed.sort();
    claimed
}

/// Across a handover each Group message claims exactly once, whichever
/// computer a message reaches first and whether it reaches the new host
/// before or after it starts. The laptop hands over to the desk:
///
/// - m1 reaches both before the handover: the laptop claims it.
/// - m2 is the laptop's own post it had not pushed; it reaches the desk after
///   the desk starts: the laptop claimed it.
/// - m3 reaches the laptop after it stopped and the desk before it starts:
///   the desk claims it as it starts.
/// - m4 reaches both after the handover: the desk claims it.
/// - m5 is the laptop's automation's own post: it never claims for that
///   automation, on either computer.
/// - m0 was posted before the automations started: nothing claims it.
#[test]
fn each_group_message_claims_exactly_once_across_a_handover() {
    let mut laptop = Computer::new();
    let mut desk = Computer::new();
    assert!(!laptop.watch(1, recorded(0), 10).needs_handover);
    let m0 = post("m0", "/task Before", 5);
    let m1 = post("m1", "/task One", 20);
    let m2 = StartChannelThread {
        author_display_name: "Ice".to_owned(),
        author_user_id: Some("user-ice".to_owned()),
        ..post("m2", "/task Two", 21)
    };
    let m3 = post("m3", "/task Three", 22);
    let m4 = post("m4", "/task Four", 23);
    let m5 = StartChannelThread {
        author_kind: ChatActorKind::Automation,
        author_display_name: "Add a task".to_owned(),
        author_owner_display_name: Some("Ice".to_owned()),
        automation: Some(ChatMessageAutomation {
            automation_id: TASK.to_owned(),
            chain_depth: 1,
        }),
        ..post("m5", "/task Five", 24)
    };

    for message in [&m0, &m1, &m2, &m5] {
        laptop.store_message(message);
    }
    for message in [&m0, &m1, &m3] {
        desk.store_message(message);
    }
    assert!(desk.claimed.is_empty(), "the desk watches nothing yet");

    let released =
        release_automation_groups(&mut laptop.store, WS, 30, &NO_FAULTS).expect("release");
    assert_eq!(released.watched_generation, 1);
    let handover = released.handover;
    laptop.store_message(&m3);
    laptop.store_message(&m4);

    // The desk runs at the released generation: before it has the handover,
    // nothing changes and nothing it stores claims.
    assert!(desk.watch(3, None, 40).needs_handover);
    assert_eq!(group_rows(&desk.store, WS), Vec::new());
    desk.watch(3, fetched(3, handover), 40);
    for message in [&m2, &m4, &m5] {
        desk.store_message(message);
    }

    assert_eq!(
        sorted(laptop.claimed.clone()),
        pairs(&[
            (ALL, "m1"),
            (TASK, "m1"),
            (ALL, "m2"),
            (TASK, "m2"),
            (ALL, "m5")
        ])
    );
    assert_eq!(
        sorted(desk.claimed.clone()),
        pairs(&[(ALL, "m3"), (TASK, "m3"), (ALL, "m4"), (TASK, "m4")])
    );

    // Taking the same generation again changes nothing.
    let again = desk.watch(3, None, 41);
    assert_eq!(
        again,
        AutomationGroupWatched {
            needs_handover: false,
            claims: Vec::new()
        }
    );

    // Back to the laptop: what both decided travels on, so nothing claims twice.
    let back = release_automation_groups(&mut desk.store, WS, 50, &NO_FAULTS)
        .expect("release")
        .handover;
    let decided = |automation: &str| {
        back.automations
            .iter()
            .find(|entry| entry.automation_id == automation)
            .expect("automation")
            .decided
            .iter()
            .map(|(message_id, _)| message_id.clone())
            .collect::<Vec<_>>()
    };
    assert_eq!(decided(ALL), ["m1", "m2", "m3", "m4", "m5"]);
    assert_eq!(decided(TASK), ["m1", "m2", "m3", "m4", "m5"]);
    let before = laptop.claimed.len();
    laptop.watch(5, fetched(5, back), 60);
    laptop.store_message(&post("m6", "/task Six", 61));
    assert_eq!(
        sorted(laptop.claimed[before..].to_vec()),
        pairs(&[(ALL, "m6"), (TASK, "m6")]),
        "only the new message claims"
    );
}

/// The coverage window: a host keeps what it decided for a window, starts
/// every subscription no earlier than the window, and a handover carries the
/// window at most. A message older than the window claims on neither side.
#[test]
fn a_handover_carries_one_window_and_the_new_host_starts_there() {
    let window = AUTOMATION_GROUP_COVERAGE_MS;
    let mut laptop = Computer::new();
    let mut desk = Computer::new();
    laptop.watch(1, recorded(0), 10);
    let old = post("m-old", "/task Old", 20);
    let recent = post("m-recent", "/task Recent", window + 40);
    laptop.store_message(&old);
    laptop.store_message(&recent);
    let handover = release_automation_groups(&mut laptop.store, WS, window + 30, &NO_FAULTS)
        .expect("release")
        .handover;
    assert_eq!(handover.floor_ms, 30);
    for automation in &handover.automations {
        assert_eq!(automation.since_ms.max(handover.floor_ms), 30);
        assert_eq!(
            automation.decided,
            vec![("m-recent".to_owned(), window + 40)]
        );
    }
    desk.store_message(&old);
    desk.store_message(&recent);
    desk.watch(3, fetched(3, handover), window + 50);
    assert!(desk.claimed.is_empty(), "both were decided or are too old");
}

/// A handover carries at most its bound of decided messages, and starts
/// after the newest one it leaves out.
#[test]
fn a_handover_past_its_bound_starts_after_what_it_leaves_out() {
    let mut laptop = Computer::new();
    laptop.watch(1, recorded(0), 10);
    let bound = MAX_AUTOMATION_GROUP_HANDOVER_MESSAGES as i64;
    laptop
        .store
        .write_with(&NO_FAULTS, |tx| {
            for index in 0..=bound {
                tx.execute(
                    "INSERT INTO automation_group_coverage \
                     (workspace_id, automation_id, message_id, created_at_ms) \
                     VALUES (?1, ?2, ?3, ?4)",
                    rusqlite::params![WS, TASK, format!("m{index}"), 100 + index],
                )
                .map_err(dohc_engine_storage::StorageError::persist_public)?;
            }
            Ok::<_, dohc_engine_storage::StorageError>(())
        })
        .expect("decisions");
    let handover = release_automation_groups(&mut laptop.store, WS, 5_000, &NO_FAULTS)
        .expect("release")
        .handover;
    assert_eq!(handover.floor_ms, 101, "the oldest decision is left out");
    let task = handover
        .automations
        .iter()
        .find(|automation| automation.automation_id == TASK)
        .expect("task");
    assert_eq!(task.decided.len(), bound as usize);
    assert_eq!(
        task.since_ms, 10,
        "the start travels as it is, beside the floor"
    );

    // On the new host, a message posted after the start but before the floor
    // claims nothing, and the owner can hear why.
    let mut desk = Computer::new();
    desk.watch(3, fetched(3, handover), 6_000);
    desk.store_message(&post("m-offline", "/task Written offline", 50));
    assert!(desk.claimed.is_empty());
    assert!(
        read_automation_group_skips(&desk.store, WS)
            .expect("skips")
            .late_at_ms
            .is_some()
    );
}

/// An automation the handover names that the new host cannot watch yet, as
/// when its Group has not synced there, keeps its start. Once the new host
/// watches it, it claims each stored message nobody decided, from that start.
#[test]
fn an_automation_the_new_host_cannot_watch_yet_keeps_its_start() {
    let mut laptop = Computer::new();
    let mut desk = Computer::new();
    laptop.watch(1, recorded(0), 10);
    let handover = release_automation_groups(&mut laptop.store, WS, 30, &NO_FAULTS)
        .expect("release")
        .handover;
    desk.store_message(&post("m1", "/task One", 22));
    // The desk can watch only ALL for now.
    watch_at(
        &mut desk.store,
        3,
        &[(ALL, GROUP, None)],
        fetched(3, handover),
        40,
    )
    .map(|watched| desk.keep(watched.claims))
    .expect("watch what it can");
    assert_eq!(sorted(desk.claimed.clone()), pairs(&[(ALL, "m1")]));
    assert_eq!(
        group_rows(&desk.store, WS),
        vec![(ALL.to_owned(), 10, false), (TASK.to_owned(), 10, true)],
        "the task automation waits, frozen, with its start"
    );
    // Its Group arrives: it starts where the laptop started it.
    desk.watch(3, None, 50);
    assert_eq!(
        sorted(desk.claimed.clone()),
        pairs(&[(ALL, "m1"), (TASK, "m1")])
    );
}

/// A computer that never watched says so as it hands over; the relay keeps
/// the handover it holds. Taking its own handover back, the first computer
/// claims what reached it while it had stopped.
#[test]
fn a_computer_that_never_ran_its_generation_says_so_and_the_first_takes_its_own_back() {
    let mut laptop = Computer::new();
    let mut desk = Computer::new();
    laptop.watch(1, recorded(0), 10);
    laptop.store_message(&post("m1", "/task One", 20));
    let first = release_automation_groups(&mut laptop.store, WS, 30, &NO_FAULTS).expect("release");
    // The desk never watched at generation 3, and is asked to hand over at once.
    let desk_release =
        release_automation_groups(&mut desk.store, WS, 35, &NO_FAULTS).expect("release");
    assert_eq!(
        desk_release.watched_generation, 0,
        "older than the relay's generation 3"
    );
    laptop.store_message(&post("m2", "/task Two", 36));
    assert_eq!(
        sorted(laptop.claimed.clone()),
        pairs(&[(ALL, "m1"), (TASK, "m1")])
    );
    laptop.watch(5, fetched(5, first.handover), 40);
    assert_eq!(
        sorted(laptop.claimed.clone()),
        pairs(&[(ALL, "m1"), (TASK, "m1"), (ALL, "m2"), (TASK, "m2")])
    );
}

/// Each new decision keeps the host's coverage within its bound, with no
/// settle, and starts each subscription after what it leaves out.
#[test]
fn each_decision_keeps_the_coverage_bounded() {
    let mut laptop = Computer::new();
    laptop.watch(1, recorded(0), 10);
    let bound = MAX_AUTOMATION_GROUP_HANDOVER_MESSAGES as i64;
    laptop
        .store
        .write_with(&NO_FAULTS, |tx| {
            for index in 0..bound {
                tx.execute(
                    "INSERT INTO automation_group_coverage \
                     (workspace_id, automation_id, message_id, created_at_ms) \
                     VALUES (?1, ?2, ?3, ?4)",
                    rusqlite::params![WS, ALL, format!("old{index}"), 100 + index],
                )
                .map_err(dohc_engine_storage::StorageError::persist_public)?;
            }
            Ok::<_, dohc_engine_storage::StorageError>(())
        })
        .expect("decisions");
    laptop.store_message(&post("m-new", "/task New", 10_000));
    assert_eq!(
        sorted(laptop.claimed.clone()),
        pairs(&[(ALL, "m-new"), (TASK, "m-new")])
    );
    let coverage: i64 = laptop
        .store
        .read_with(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM automation_group_coverage WHERE workspace_id = ?1",
                [WS],
                |row| row.get(0),
            )
        })
        .expect("coverage");
    assert_eq!(coverage, bound, "the bound, and no more");
    let floor: i64 = laptop
        .store
        .read_with(|conn| {
            conn.query_row(
                "SELECT floor_ms FROM automation_group_state WHERE workspace_id = ?1",
                [WS],
                |row| row.get(0),
            )
        })
        .expect("floor");
    assert_eq!(floor, 102, "the floor passes what went");

    // A message from before the automations started is not theirs. One
    // posted after they started that arrives after the floor passed it
    // claims nothing, and the owner can hear why.
    // Watching again keeps each start where it was.
    laptop.watch(1, None, 10_001);
    assert!(
        group_rows(&laptop.store, WS)
            .iter()
            .all(|(_, since, _)| *since == 10)
    );
    laptop.store_message(&post("m-before", "/task Before", 5));
    assert_eq!(
        read_automation_group_skips(&laptop.store, WS).expect("skips"),
        AutomationGroupSkips::default()
    );
    laptop.store_message(&post("m-late", "/task Offline all day", 50));
    assert_eq!(laptop.claimed.len(), 2, "only m-new claimed");
    let skips = read_automation_group_skips(&laptop.store, WS).expect("skips");
    assert!(skips.late_at_ms.is_some());
    assert_eq!(skips.ahead_at_ms, None);
}

/// A message another host decided for one automation stays decided while
/// the same message is decided for the next: the bound applies once every
/// subscription has decided it.
#[test]
fn a_message_at_the_bound_claims_nothing_its_last_host_decided() {
    let mut laptop = Computer::new();
    laptop.watch(1, recorded(0), 10);
    let bound = MAX_AUTOMATION_GROUP_HANDOVER_MESSAGES as i64;
    laptop
        .store
        .write_with(&NO_FAULTS, |tx| {
            tx.execute(
                "INSERT INTO automation_group_coverage \
                 (workspace_id, automation_id, message_id, created_at_ms) \
                 VALUES (?1, ?2, 'm-old', 100)",
                rusqlite::params![WS, TASK],
            )
            .map_err(dohc_engine_storage::StorageError::persist_public)?;
            for index in 1..bound {
                tx.execute(
                    "INSERT INTO automation_group_coverage \
                     (workspace_id, automation_id, message_id, created_at_ms) \
                     VALUES (?1, ?2, ?3, ?4)",
                    rusqlite::params![WS, ALL, format!("newer{index}"), 200 + index],
                )
                .map_err(dohc_engine_storage::StorageError::persist_public)?;
            }
            Ok::<_, dohc_engine_storage::StorageError>(())
        })
        .expect("decisions");
    laptop.store_message(&post("m-old", "/task Old", 100));
    assert_eq!(
        sorted(laptop.claimed.clone()),
        pairs(&[(ALL, "m-old")]),
        "the task automation decided it on the last host"
    );
}

/// A watch that replays several subscriptions keeps every decision until
/// all of them are in place: one automation's replay never pushes out what
/// the next one decided on the last host.
#[test]
fn a_replay_never_pushes_out_what_the_next_subscription_decided() {
    let mut laptop = Computer::new();
    let mut desk = Computer::new();
    laptop.watch(1, recorded(0), 10);
    let mut handover = release_automation_groups(&mut laptop.store, WS, 15, &NO_FAULTS)
        .expect("release")
        .handover;
    let bound = MAX_AUTOMATION_GROUP_HANDOVER_MESSAGES;
    for automation in &mut handover.automations {
        if automation.automation_id == ALL {
            automation.decided = (0..bound).map(|index| (format!("h{index}"), 20)).collect();
        }
    }
    for index in 0..3 {
        desk.store_message(&post(&format!("h{index}"), "Hello", 20));
    }
    desk.store_message(&post("m30", "/task New", 30));
    desk.watch(3, fetched(3, handover), 40);
    assert_eq!(
        sorted(desk.claimed.clone()),
        pairs(&[(ALL, "m30"), (TASK, "m30")]),
        "the laptop decided every hello for the all-messages automation"
    );
}

/// A handover carries every decision the host keeps, however it is dated:
/// one dated past the host's clock, as another computer's decision can be,
/// counts toward the bound like any other and is never left out.
#[test]
fn a_handover_carries_every_decision_it_keeps_however_it_is_dated() {
    let mut laptop = Computer::new();
    laptop.watch(1, recorded(0), 10);
    let bound = MAX_AUTOMATION_GROUP_HANDOVER_MESSAGES as i64;
    let later = 4_000_000_000_000;
    laptop
        .store
        .write_with(&NO_FAULTS, |tx| {
            for index in 0..bound {
                tx.execute(
                    "INSERT INTO automation_group_coverage \
                     (workspace_id, automation_id, message_id, created_at_ms) \
                     VALUES (?1, ?2, ?3, ?4)",
                    rusqlite::params![WS, TASK, format!("m{index}"), 100 + index],
                )
                .map_err(dohc_engine_storage::StorageError::persist_public)?;
            }
            tx.execute(
                "INSERT INTO automation_group_coverage \
                 (workspace_id, automation_id, message_id, created_at_ms) \
                 VALUES (?1, ?2, 'm-later', ?3)",
                rusqlite::params![WS, TASK, later],
            )
            .map_err(dohc_engine_storage::StorageError::persist_public)?;
            Ok::<_, dohc_engine_storage::StorageError>(())
        })
        .expect("decisions");
    let handover = release_automation_groups(&mut laptop.store, WS, 5_000, &NO_FAULTS)
        .expect("release")
        .handover;
    assert_eq!(handover.floor_ms, 101, "the oldest decision is left out");
    let task = handover
        .automations
        .iter()
        .find(|automation| automation.automation_id == TASK)
        .expect("task");
    assert_eq!(task.decided.len(), bound as usize);
    assert!(task.decided.contains(&("m-later".to_owned(), later)));
}

/// A message dated more than the allowance past this computer's clock
/// decides nothing as it arrives, so a forged date cannot hold the coverage,
/// and the owner can hear why.
#[test]
fn a_message_dated_past_the_clock_decides_nothing() {
    let mut laptop = Computer::new();
    laptop.watch(1, recorded(0), 10);
    let far = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock")
        .as_millis() as i64
        + 2 * AUTOMATION_GROUP_FUTURE_MS;
    laptop.store_message(&post("m-far", "/task Far", far));
    assert!(laptop.claimed.is_empty());
    let coverage: i64 = laptop
        .store
        .read_with(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM automation_group_coverage WHERE workspace_id = ?1",
                [WS],
                |row| row.get(0),
            )
        })
        .expect("coverage");
    assert_eq!(coverage, 0);
    let skips = read_automation_group_skips(&laptop.store, WS).expect("skips");
    assert!(skips.ahead_at_ms.is_some());
    assert_eq!(skips.late_at_ms, None);
}

/// A handover called off before any other computer ran: taking up again,
/// this computer starts what it froze where it was, and claims what reached
/// it while it had stopped. A handover it took already is not taken again.
#[test]
fn a_called_off_handover_starts_what_was_frozen_where_it_was() {
    let mut laptop = Computer::new();
    laptop.watch(1, recorded(0), 10);
    laptop.store_message(&post("m1", "/task One", 20));
    let released =
        release_automation_groups(&mut laptop.store, WS, 30, &NO_FAULTS).expect("release");
    laptop.store_message(&post("m2", "/task Two", 31));
    laptop.watch(3, recorded(0), 40);
    assert_eq!(
        sorted(laptop.claimed.clone()),
        pairs(&[(ALL, "m1"), (TASK, "m1"), (ALL, "m2"), (TASK, "m2")])
    );

    // Taking its own handover, then seeing it again at a later generation.
    let mut desk = Computer::new();
    desk.watch(5, fetched(5, released.handover.clone()), 50);
    release_automation_groups(&mut desk.store, WS, 55, &NO_FAULTS).expect("release");
    desk.store_message(&post("m3", "/task Three", 56));
    desk.watch(7, fetched(5, released.handover), 60);
    assert_eq!(
        sorted(desk.claimed.clone()),
        pairs(&[(ALL, "m3"), (TASK, "m3")]),
        "the same handover is not taken twice; what it froze starts where it was"
    );
}

/// After a take over, which has no handover, what this computer froze in an
/// earlier turn starts from now: it replays nothing the last host may have
/// decided. So it does after the relay lost what it recorded.
#[test]
fn after_a_take_over_what_was_frozen_starts_from_now() {
    let mut desk = Computer::new();
    desk.watch(1, recorded(0), 10);
    release_automation_groups(&mut desk.store, WS, 20, &NO_FAULTS).expect("release");
    // Another computer ran for a while and stopped answering.
    desk.store_message(&post("m1", "/task Decided elsewhere", 30));
    desk.watch(5, recorded(4), 100);
    assert!(desk.claimed.is_empty());
    assert_eq!(
        group_rows(&desk.store, WS),
        vec![(ALL.to_owned(), 100, false), (TASK.to_owned(), 100, false)]
    );

    release_automation_groups(&mut desk.store, WS, 110, &NO_FAULTS).expect("release");
    desk.store_message(&post("m2", "/task Also elsewhere", 120));
    desk.watch(1, recorded(0), 200);
    assert!(
        desk.claimed.is_empty(),
        "a generation below the last watched"
    );
    assert_eq!(
        group_rows(&desk.store, WS),
        vec![(ALL.to_owned(), 200, false), (TASK.to_owned(), 200, false)]
    );
}

/// A computer that took over and never watched after it ran nothing since;
/// the host it took over from did. A called-off handover later still finds
/// the take over newer than its last watch, so it starts from now and
/// replays nothing that host decided.
#[test]
fn a_take_over_this_computer_never_watched_after_still_starts_from_now() {
    let mut laptop = Computer::new();
    let mut desk = Computer::new();
    laptop.watch(1, recorded(0), 10);
    let handover = release_automation_groups(&mut laptop.store, WS, 20, &NO_FAULTS)
        .expect("release")
        .handover;
    desk.watch(2, fetched(2, handover), 25);
    let m1 = post("m1", "/task Decided by the desk", 30);
    desk.store_message(&m1);
    laptop.store_message(&m1);
    assert_eq!(
        sorted(desk.claimed.clone()),
        pairs(&[(ALL, "m1"), (TASK, "m1")])
    );

    // The laptop took over at 4 and never watched there; a handover to the
    // desk at 5 was called off at 6.
    laptop.watch(6, recorded(4), 100);
    assert!(laptop.claimed.is_empty());
    assert_eq!(
        group_rows(&laptop.store, WS),
        vec![(ALL.to_owned(), 100, false), (TASK.to_owned(), 100, false)]
    );
}
