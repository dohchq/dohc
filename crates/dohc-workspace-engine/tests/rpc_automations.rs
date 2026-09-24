//! The `automations.*` RPC surface: workspace-scoped subscribe/unsubscribe
//! with change-kind and field filters, the claimNext/settle drain with
//! per-executor prefixes and field facts, retry, the claim history,
//! settle-state validation, and the open-time reaper's requeue-or-exhaust
//! transitions, all observed through the real in-process daemon request
//! path over durable claims seeded in engine.db.

mod common;

use common::*;
use dohc_engine_domain::{
    AUTOMATION_CHAIN_DEPTH_CAP, AUTOMATION_CHAIN_STOPPED, AUTOMATION_RECLAIM_EXHAUSTED,
    AutomationChangeKind, AutomationSubscription, ChangeActorKind, ChangeAttribution,
    CollectionFieldChangeFact, CollectionRecordApplyFacts, NoFaults,
    claim_automation_triggers_in_tx, subscribe_automation_in_tx,
};
use dohc_engine_protocol::{
    error::ErrorCode,
    transport::{EngineTransport, InProcessTransport, RequestContext},
    wire::WorkspaceHandle,
};
use dohc_engine_storage::{EngineStore, StorageError};
use dohc_engine_testkit::{ScratchDir, engine_db_path};
use dohc_workspace_engine::{EngineService, root_binding::write_root_binding};
use serde_json::{Value, json};
use std::sync::Arc;

const WORKSPACE_ID: &str = "ws-rpc-automations";
const AUTOMATION: &str = "plugin:triage";

async fn call(
    transport: &InProcessTransport<EngineService>,
    handle: &WorkspaceHandle,
    id: &mut u64,
    method: &str,
    params: Value,
) -> Value {
    *id += 1;
    transport
        .call(
            RequestContext::unbounded(),
            request(*id, method, Some(handle.clone()), params),
        )
        .await
        .unwrap_or_else(|error| panic!("{method} failed: {error:?}"))
        .result
}

async fn call_error(
    transport: &InProcessTransport<EngineService>,
    handle: &WorkspaceHandle,
    id: &mut u64,
    method: &str,
    params: Value,
) -> dohc_engine_protocol::error::WireError {
    *id += 1;
    transport
        .call(
            RequestContext::unbounded(),
            request(*id, method, Some(handle.clone()), params),
        )
        .await
        .unwrap_err()
}

fn facts(origin_seq: i64) -> CollectionRecordApplyFacts {
    CollectionRecordApplyFacts {
        collection_path: "tasks".to_owned(),
        record_id: "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa".to_owned(),
        created: false,
        author_origin_id: Some("alice".to_owned()),
        attribution: Some(ChangeAttribution {
            actor_kind: ChangeActorKind::Human,
            on_behalf_of: None,
            depth: 0,
        }),
        source: Some(("origin-a".to_owned(), origin_seq)),
        recorded_at_ms: 40,
        fields: vec![CollectionFieldChangeFact {
            field_name: "status".to_owned(),
            previous_json: Some("\"open\"".to_owned()),
            next_json: Some("\"done\"".to_owned()),
            history_id: origin_seq,
        }],
    }
}

/// Seed engine.db before the workspace opens: one subscription, two pending
/// claims from real apply facts, one chain-stopped claim, and two stale
/// running claims for the open-time reaper — one with attempts left, one
/// exhausted.
fn seed_claims(scratch: &ScratchDir) {
    let db = engine_db_path(scratch).expect("engine db path");
    let mut store = EngineStore::open(&db, 1).expect("open store");
    store.bind_root_token(TOKEN, &NoFaults).expect("bind token");
    store
        .write_with(&NoFaults, |tx| {
            subscribe_automation_in_tx(
                tx,
                WORKSPACE_ID,
                &AutomationSubscription {
                    automation_id: AUTOMATION.to_owned(),
                    prefix: "tasks".to_owned(),
                    kinds: vec![AutomationChangeKind::Added, AutomationChangeKind::Changed],
                    fields: None,
                },
                10,
            )?;
            claim_automation_triggers_in_tx(tx, WORKSPACE_ID, &facts(1), 20)?;
            claim_automation_triggers_in_tx(tx, WORKSPACE_ID, &facts(2), 30)?;
            let mut stopped = facts(3);
            stopped.author_origin_id = Some("plugin:other".to_owned());
            stopped.attribution = Some(ChangeAttribution {
                actor_kind: ChangeActorKind::Automation,
                on_behalf_of: None,
                depth: AUTOMATION_CHAIN_DEPTH_CAP,
            });
            claim_automation_triggers_in_tx(tx, WORKSPACE_ID, &stopped, 40)?;
            Ok::<_, dohc_engine_domain::DomainError>(())
        })
        .expect("seed subscription and pending claims");
    store
        .write_with(&NoFaults, |tx| {
            for (claim_id, history_id, attempts, created_at_ms) in [
                ("atc_requeue", 100, 1_i64, 5_i64),
                ("atc_exhaust", 101, 2, 6),
            ] {
                tx.execute(
                    "INSERT INTO automation_claims \
                     (workspace_id, claim_id, automation_id, trigger_history_id, record_id, \
                      collection_path, depth, state, attempts, created_at_ms, updated_at_ms) \
                     VALUES (?1, ?2, ?3, ?4, 'rec_aaaaaaaaaaaaaaaaaaaaaaaaaa', 'tasks', 0, \
                             'running', ?5, ?6, 1)",
                    rusqlite::params![
                        WORKSPACE_ID,
                        claim_id,
                        AUTOMATION,
                        history_id,
                        attempts,
                        created_at_ms
                    ],
                )
                .map_err(StorageError::persist_public)?;
            }
            Ok::<_, StorageError>(())
        })
        .expect("seed stale running claims");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn automation_rpc_surface_is_scoped_validates_and_drains_the_ledger() {
    let scratch = ScratchDir::new().expect("scratch");
    write_root_binding(scratch.path(), TOKEN).expect("root binding");
    seed_claims(&scratch);
    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let opened = transport
        .call(
            RequestContext::unbounded(),
            request(
                1,
                "workspace.open",
                None,
                json!({
                    "rootDir": scratch.path().to_string_lossy(),
                    "workspaceId": WORKSPACE_ID,
                }),
            ),
        )
        .await
        .expect("open workspace");
    let handle: WorkspaceHandle =
        serde_json::from_value(opened.result["workspace"].clone()).expect("workspace handle");
    let mut id = 1;

    // Workspace scoping: every automations method refuses a request without
    // a live workspace handle.
    for (method, params) in [
        (
            "automations.subscribe",
            json!({ "automationId": "plugin:x", "path": "tasks", "kinds": ["changed"] }),
        ),
        (
            "automations.unsubscribe",
            json!({ "automationId": "plugin:x", "path": "tasks" }),
        ),
        ("automations.claimNext", json!({})),
        ("automations.failures", json!({})),
        (
            "automations.listClaims",
            json!({ "automationId": "plugin:x" }),
        ),
        (
            "automations.settle",
            json!({ "claimId": "atc_x", "state": "done" }),
        ),
        ("automations.retry", json!({ "claimId": "atc_x" })),
    ] {
        id += 1;
        let error = transport
            .call(
                RequestContext::unbounded(),
                request(id, method, None, params),
            )
            .await
            .unwrap_err();
        assert_eq!(
            error.code,
            ErrorCode::WorkspaceUnavailable,
            "{method} must be workspace-scoped"
        );
    }

    // Subscription round trip; the seeded pair already exists with this
    // filter, and a new filter for the same pair replaces it.
    let dup = call(
        &transport,
        &handle,
        &mut id,
        "automations.subscribe",
        json!({ "automationId": AUTOMATION, "path": "tasks", "kinds": ["added", "changed"] }),
    )
    .await;
    assert_eq!(dup, json!({ "subscribed": false }));
    let added = call(
        &transport,
        &handle,
        &mut id,
        "automations.subscribe",
        json!({
            "automationId": "plugin:janitor",
            "path": ".",
            "kinds": ["changed", "removed"],
            "fields": ["status"],
        }),
    )
    .await;
    assert_eq!(added, json!({ "subscribed": true }));
    let replaced = call(
        &transport,
        &handle,
        &mut id,
        "automations.subscribe",
        json!({ "automationId": "plugin:janitor", "path": ".", "kinds": ["changed"] }),
    )
    .await;
    assert_eq!(replaced, json!({ "subscribed": true }));
    let removed = call(
        &transport,
        &handle,
        &mut id,
        "automations.unsubscribe",
        json!({ "automationId": "plugin:janitor", "path": "." }),
    )
    .await;
    assert_eq!(removed, json!({ "unsubscribed": true }));
    let missing = call(
        &transport,
        &handle,
        &mut id,
        "automations.unsubscribe",
        json!({ "automationId": "plugin:janitor", "path": "." }),
    )
    .await;
    assert_eq!(missing, json!({ "unsubscribed": false }));
    for (params, wrong) in [
        (
            json!({ "automationId": "  ", "path": "tasks", "kinds": ["changed"] }),
            "a blank automation id",
        ),
        (
            json!({ "automationId": AUTOMATION, "path": "tasks" }),
            "no kinds",
        ),
        (
            json!({ "automationId": AUTOMATION, "path": "tasks", "kinds": [] }),
            "an empty kind list",
        ),
        (
            json!({ "automationId": AUTOMATION, "path": "tasks", "kinds": ["moved"] }),
            "an unknown kind",
        ),
        (
            json!({ "automationId": AUTOMATION, "path": "tasks", "kinds": ["changed"], "fields": null }),
            "null fields",
        ),
        (
            json!({ "automationId": AUTOMATION, "path": "tasks", "kinds": ["changed"], "fields": [] }),
            "an empty field list",
        ),
    ] {
        let error = call_error(
            &transport,
            &handle,
            &mut id,
            "automations.subscribe",
            params,
        )
        .await;
        assert_eq!(error.code, ErrorCode::InvalidParams, "{wrong}");
    }

    // The open-time reaper already ran: the stale running claim with an
    // attempt left is pending again (and, as the oldest row, drains first);
    // the exhausted one is terminally failed and never re-served. Neither
    // was written through a change, so their facts are empty.
    let requeued = call(
        &transport,
        &handle,
        &mut id,
        "automations.claimNext",
        json!({ "nowMs": 1000 }),
    )
    .await;
    assert_eq!(requeued["claimId"], json!("atc_requeue"));
    assert_eq!(requeued["state"], json!("running"));
    assert_eq!(requeued["attempts"], json!(2), "the reclaim retry counts");
    assert_eq!(requeued["trigger"], json!({ "historyId": 100 }));
    assert_eq!(
        requeued["change"],
        json!({
            "kind": "changed",
            "actor": { "kind": null, "id": null },
            "fields": [],
            "fieldsOmitted": 0,
        })
    );
    let exhausted_settle = call_error(
        &transport,
        &handle,
        &mut id,
        "automations.settle",
        json!({ "claimId": "atc_exhaust", "state": "done", "nowMs": 1001 }),
    )
    .await;
    assert_eq!(
        exhausted_settle.code,
        ErrorCode::InvalidParams,
        "a claim the reaper terminally failed ({AUTOMATION_RECLAIM_EXHAUSTED}) is not running"
    );

    // An executor drains only its own automation id prefix.
    let other_executor = call(
        &transport,
        &handle,
        &mut id,
        "automations.claimNext",
        json!({ "nowMs": 1002, "automationIdPrefix": "collection:" }),
    )
    .await;
    assert_eq!(other_executor, Value::Null);
    let prefix_error = call_error(
        &transport,
        &handle,
        &mut id,
        "automations.claimNext",
        json!({ "automationIdPrefix": "" }),
    )
    .await;
    assert_eq!(prefix_error.code, ErrorCode::InvalidParams);

    // Drain the two seeded pending claims oldest-first and walk both settle
    // arms. A served claim carries its change's facts.
    let first = call(
        &transport,
        &handle,
        &mut id,
        "automations.claimNext",
        json!({ "nowMs": 1003, "automationIdPrefix": "plugin:" }),
    )
    .await;
    assert_eq!(first["automationId"], json!(AUTOMATION));
    assert_eq!(first["state"], json!("running"));
    assert_eq!(first["attempts"], json!(1));
    assert_eq!(first["collectionPath"], json!("tasks"));
    assert_eq!(
        first["trigger"],
        json!({ "originId": "origin-a", "originSeq": 1 }),
        "the trigger key is the change's replication coordinate"
    );
    assert_eq!(
        first["change"],
        json!({
            "kind": "changed",
            "actor": { "kind": "human", "id": "alice" },
            "fields": [{
                "field": "status",
                "historyId": 1,
                "previous": { "value": "open" },
                "next": { "value": "done" },
            }],
            "fieldsOmitted": 0,
        })
    );
    let done = call(
        &transport,
        &handle,
        &mut id,
        "automations.settle",
        json!({ "claimId": first["claimId"], "state": "done", "nowMs": 1004 }),
    )
    .await;
    assert_eq!(done["state"], json!("done"));
    assert!(
        done["change"].get("fields").is_none(),
        "a settle answers the claim without its field facts"
    );
    let resettle = call_error(
        &transport,
        &handle,
        &mut id,
        "automations.settle",
        json!({ "claimId": first["claimId"], "state": "done", "nowMs": 1005 }),
    )
    .await;
    assert_eq!(resettle.code, ErrorCode::InvalidParams);

    let second = call(
        &transport,
        &handle,
        &mut id,
        "automations.claimNext",
        json!({ "nowMs": 1006 }),
    )
    .await;
    assert_eq!(
        second["trigger"],
        json!({ "originId": "origin-a", "originSeq": 2 })
    );
    let failed = call(
        &transport,
        &handle,
        &mut id,
        "automations.settle",
        json!({
            "claimId": second["claimId"],
            "state": "failed",
            "error": "handler threw",
            "nowMs": 1007,
        }),
    )
    .await;
    assert_eq!(failed["state"], json!("failed"));
    assert_eq!(failed["error"], json!("handler threw"));

    let drained = call(
        &transport,
        &handle,
        &mut id,
        "automations.claimNext",
        json!({}),
    )
    .await;
    assert_eq!(drained, Value::Null, "nothing pending remains");

    // The owner's re-run: the failed claim goes back to pending and runs
    // again as a new attempt with the same facts. Retrying it while it is
    // pending changes nothing.
    let retried = call(
        &transport,
        &handle,
        &mut id,
        "automations.retry",
        json!({ "claimId": second["claimId"], "nowMs": 1008 }),
    )
    .await;
    assert_eq!(retried["state"], json!("pending"));
    assert!(retried.get("error").is_none());
    let again = call(
        &transport,
        &handle,
        &mut id,
        "automations.retry",
        json!({ "claimId": second["claimId"], "nowMs": 1009 }),
    )
    .await;
    assert_eq!(again, retried, "a pending claim is returned unchanged");
    let rerun = call(
        &transport,
        &handle,
        &mut id,
        "automations.claimNext",
        json!({ "nowMs": 1010 }),
    )
    .await;
    assert_eq!(rerun["claimId"], second["claimId"]);
    assert_eq!(
        rerun["attempts"],
        json!(2),
        "the attempt count keeps rising"
    );
    assert_eq!(rerun["change"], second["change"]);
    call(
        &transport,
        &handle,
        &mut id,
        "automations.settle",
        json!({ "claimId": rerun["claimId"], "state": "done", "nowMs": 1011 }),
    )
    .await;
    let stopped_claim_id = {
        let history = call(
            &transport,
            &handle,
            &mut id,
            "automations.listClaims",
            json!({ "automationId": AUTOMATION }),
        )
        .await;
        let claims = history["claims"].as_array().expect("claims array").clone();
        assert_eq!(
            claims
                .iter()
                .map(|claim| claim["createdAtMs"].as_i64().expect("created"))
                .collect::<Vec<_>>(),
            vec![40, 30, 20, 6, 5],
            "the history lists every state, newest first"
        );
        assert_eq!(
            claims
                .iter()
                .map(|claim| claim["state"].as_str().expect("state"))
                .collect::<Vec<_>>(),
            vec!["failed", "done", "done", "failed", "running"]
        );
        assert!(
            claims
                .iter()
                .all(|claim| claim["change"].get("fields").is_none()),
            "the history carries no field facts"
        );
        assert_eq!(claims[0]["error"], json!(AUTOMATION_CHAIN_STOPPED));
        claims[0]["claimId"].clone()
    };
    for (claim_id, wrong) in [
        (stopped_claim_id, "a claim the chain depth cap stopped"),
        (first["claimId"].clone(), "a done claim"),
        (json!("atc_missing"), "an unknown claim"),
    ] {
        let error = call_error(
            &transport,
            &handle,
            &mut id,
            "automations.retry",
            json!({ "claimId": claim_id }),
        )
        .await;
        assert_eq!(
            error.code,
            ErrorCode::InvalidParams,
            "{wrong} cannot run again"
        );
    }

    // The failure surface aggregates the failed rows — the chain stop, the
    // reaper-exhausted claim, and the settled failure that was retried —
    // into one row per automation with the newest error and a generation
    // that counts every failure. The reaper ran at workspace.open with the
    // real clock, so its failure is the newest.
    let failures = call(
        &transport,
        &handle,
        &mut id,
        "automations.failures",
        json!({}),
    )
    .await;
    let rows = failures["failures"].as_array().expect("failures array");
    assert_eq!(rows.len(), 1, "one row per automation: {rows:?}");
    assert_eq!(rows[0]["automationId"], json!(AUTOMATION));
    assert_eq!(
        rows[0]["generation"],
        json!(3),
        "the generation counts every failure, including a retried one"
    );
    assert_eq!(
        rows[0]["error"],
        json!(AUTOMATION_RECLAIM_EXHAUSTED),
        "the newest failure's error wins"
    );

    // Settle-state validation refuses the malformed combinations before any
    // write.
    for (params, wrong) in [
        (
            json!({ "claimId": "atc_x", "state": "done", "error": "boom" }),
            "done carries error text",
        ),
        (
            json!({ "claimId": "atc_x", "state": "failed" }),
            "failed without error text",
        ),
        (
            json!({ "claimId": "atc_x", "state": "paused" }),
            "unknown settle state",
        ),
    ] {
        let error = call_error(&transport, &handle, &mut id, "automations.settle", params).await;
        assert_eq!(error.code, ErrorCode::InvalidParams, "{wrong}");
    }
}
