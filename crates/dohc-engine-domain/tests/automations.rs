//! The automation claim ledger (ADR 0008): subscription round-trips, claim
//! insertion from apply facts (prefix containment, self-skip, depth cap,
//! trigger-key dedupe, workspace scoping), the pending -> running -> done |
//! failed machine, and the startup reaper's requeue-or-exhaust rule.

use dohc_engine_domain::{
    AUTOMATION_CHAIN_DEPTH_CAP, AUTOMATION_CHAIN_STOPPED, AUTOMATION_RECLAIM_EXHAUSTED,
    AutomationClaim, AutomationClaimState, AutomationSettle, AutomationTrigger, ChangeActorKind,
    ChangeAttribution, CollectionFieldChangeFact, CollectionRecordApplyFacts, DomainError,
    NoFaults, TxnOutcome, claim_automation_triggers_in_tx, claim_next_pending_automation,
    list_automation_failures, reclaim_running_automations, settle_automation_claim,
    subscribe_automation, unsubscribe_automation,
};
use dohc_engine_storage::EngineStore;
use dohc_engine_testkit::{ScratchDir, engine_db_path};

const WS: &str = "ws-automations";
const NO_FAULTS: NoFaults = NoFaults;

fn open_store(scratch: &ScratchDir) -> EngineStore {
    let db = engine_db_path(scratch).expect("engine db path");
    EngineStore::open(&db, 1).expect("open store")
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
fn subscriptions_round_trip_and_validate() {
    let scratch = ScratchDir::new().expect("scratch");
    let mut store = open_store(&scratch);

    assert!(
        subscribe_automation(&mut store, WS, "plugin:triage", "tasks", 10, &NO_FAULTS)
            .expect("subscribe")
    );
    assert!(
        !subscribe_automation(&mut store, WS, "plugin:triage", "tasks", 11, &NO_FAULTS)
            .expect("duplicate subscribe is a no-op"),
    );
    assert!(
        unsubscribe_automation(&mut store, WS, "plugin:triage", "tasks", &NO_FAULTS)
            .expect("unsubscribe")
    );
    assert!(
        !unsubscribe_automation(&mut store, WS, "plugin:triage", "tasks", &NO_FAULTS)
            .expect("second unsubscribe finds nothing"),
    );
    assert!(matches!(
        subscribe_automation(&mut store, WS, "  ", "tasks", 12, &NO_FAULTS),
        Err(DomainError::InvalidInput { .. })
    ));
    assert!(matches!(
        subscribe_automation(&mut store, WS, "plugin:triage", "", 13, &NO_FAULTS),
        Err(DomainError::InvalidInput { .. })
    ));
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
        subscribe_automation(&mut store, WS, automation, prefix, 10, &NO_FAULTS)
            .expect("subscribe");
    }

    let applied = facts("tasks", Some(("origin-a", 41)), &[7], Some("alice"), None);
    let claims = claim_for(&mut store, WS, &applied, 20);
    assert_eq!(
        claims
            .iter()
            .map(|claim| claim.automation_id.as_str())
            .collect::<Vec<_>>(),
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
    subscribe_automation(&mut store, WS, "plugin:triage", "tasks", 10, &NO_FAULTS)
        .expect("subscribe");

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
fn the_writing_automation_never_claims_and_the_depth_cap_records_the_stop() {
    let scratch = ScratchDir::new().expect("scratch");
    let mut store = open_store(&scratch);
    subscribe_automation(&mut store, WS, "plugin:triage", "tasks", 10, &NO_FAULTS)
        .expect("subscribe");

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
        claim_next_pending_automation(&mut store, WS, 31, &NO_FAULTS)
            .expect("claim next")
            .is_none(),
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
fn failures_list_one_row_per_automation_with_the_newest_error_and_a_counting_generation() {
    let scratch = ScratchDir::new().expect("scratch");
    let mut store = open_store(&scratch);
    subscribe_automation(&mut store, WS, "plugin:triage", "tasks", 10, &NO_FAULTS)
        .expect("subscribe");

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
    claim_next_pending_automation(&mut store, WS, 21, &NO_FAULTS)
        .expect("claim next")
        .expect("one pending claim");
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
        "the generation counts the failed claims"
    );

    // A done claim never appears, and another workspace's failures do not
    // leak in.
    let done = facts("tasks", Some(("origin-a", 3)), &[3], None, None);
    let done_claims = claim_for(&mut store, WS, &done, 40);
    claim_next_pending_automation(&mut store, WS, 41, &NO_FAULTS)
        .expect("claim next")
        .expect("one pending claim");
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
    subscribe_automation(&mut store, WS, "plugin:triage", "tasks", 10, &NO_FAULTS)
        .expect("subscribe");
    let first = facts("tasks", Some(("origin-a", 1)), &[1], Some("alice"), None);
    let second = facts("tasks", Some(("origin-a", 2)), &[2], Some("alice"), None);
    claim_for(&mut store, WS, &first, 20);
    claim_for(&mut store, WS, &second, 30);

    let running = claim_next_pending_automation(&mut store, WS, 40, &NO_FAULTS)
        .expect("claim next")
        .expect("a pending claim exists");
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

    let second_running = claim_next_pending_automation(&mut store, WS, 60, &NO_FAULTS)
        .expect("claim next")
        .expect("the second claim is pending");
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
        claim_next_pending_automation(&mut store, WS, 70, &NO_FAULTS)
            .expect("claim next")
            .is_none(),
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
fn the_reaper_requeues_with_attempts_left_and_exhausts_without() {
    let scratch = ScratchDir::new().expect("scratch");
    let mut store = open_store(&scratch);
    subscribe_automation(&mut store, WS, "plugin:triage", "tasks", 10, &NO_FAULTS)
        .expect("subscribe");
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
    let first = claim_next_pending_automation(&mut store, WS, 30, &NO_FAULTS)
        .expect("claim next")
        .expect("first");
    let second = claim_next_pending_automation(&mut store, WS, 30, &NO_FAULTS)
        .expect("claim next")
        .expect("second");
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

    let fresh = claim_next_pending_automation(&mut store, WS, 200, &NO_FAULTS)
        .expect("claim next")
        .expect("requeued or untouched pending");
    assert!(
        reclaim_running_automations(&mut store, WS, None, 2, 150, 210, &NO_FAULTS)
            .expect("reclaim again")
            .is_empty(),
        "a claim running since t=200 is younger than the bound and is left alone: {fresh:?}"
    );
}
