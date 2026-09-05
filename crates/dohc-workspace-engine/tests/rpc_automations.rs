//! The `automations.*` RPC surface: workspace-scoped subscribe/unsubscribe,
//! the claimNext/settle drain, settle-state validation, and the open-time
//! reaper's requeue-or-exhaust transitions, all observed through the real
//! in-process daemon request path over durable claims seeded in engine.db.

use dohc_engine_domain::{
    AUTOMATION_RECLAIM_EXHAUSTED, ChangeActorKind, ChangeAttribution, CollectionFieldChangeFact,
    CollectionRecordApplyFacts, NoFaults, claim_automation_triggers_in_tx,
    subscribe_automation_in_tx,
};
use dohc_engine_protocol::{
    error::ErrorCode,
    transport::{EngineTransport, InProcessTransport, RequestContext},
    wire::{Request, WorkspaceHandle},
};
use dohc_engine_storage::{EngineStore, StorageError};
use dohc_engine_testkit::ScratchDir;
use dohc_workspace_engine::{EngineService, root_binding::write_root_binding};
use serde_json::{Value, json};
use std::sync::Arc;

const TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const WORKSPACE_ID: &str = "ws-rpc-automations";
const AUTOMATION: &str = "plugin:triage";

fn request(id: u64, method: &str, workspace: Option<WorkspaceHandle>, params: Value) -> Request {
    Request {
        id,
        method: method.to_owned(),
        workspace,
        deadline_ms: None,
        idempotency_key: None,
        params,
    }
}

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
/// claims from real apply facts, and two stale running claims for the
/// open-time reaper — one with attempts left, one exhausted.
fn seed_claims(scratch: &ScratchDir) {
    let db = scratch.engine_db_path().expect("engine db path");
    let mut store = EngineStore::open(&db, 1).expect("open store");
    store.bind_root_token(TOKEN).expect("bind token");
    store
        .write_with(&NoFaults, |tx| {
            subscribe_automation_in_tx(tx, WORKSPACE_ID, AUTOMATION, "tasks", 10)?;
            claim_automation_triggers_in_tx(tx, WORKSPACE_ID, &facts(1), 20)?;
            claim_automation_triggers_in_tx(tx, WORKSPACE_ID, &facts(2), 30)?;
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
            json!({ "automationId": "plugin:x", "path": "tasks" }),
        ),
        (
            "automations.unsubscribe",
            json!({ "automationId": "plugin:x", "path": "tasks" }),
        ),
        ("automations.claimNext", json!({})),
        ("automations.failures", json!({})),
        (
            "automations.settle",
            json!({ "claimId": "atc_x", "state": "done" }),
        ),
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

    // Subscription round trip; the seeded pair already exists.
    let dup = call(
        &transport,
        &handle,
        &mut id,
        "automations.subscribe",
        json!({ "automationId": AUTOMATION, "path": "tasks" }),
    )
    .await;
    assert_eq!(dup, json!({ "subscribed": false }));
    let added = call(
        &transport,
        &handle,
        &mut id,
        "automations.subscribe",
        json!({ "automationId": "plugin:janitor", "path": "." }),
    )
    .await;
    assert_eq!(added, json!({ "subscribed": true }));
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
    let invalid = call_error(
        &transport,
        &handle,
        &mut id,
        "automations.subscribe",
        json!({ "automationId": "  ", "path": "tasks" }),
    )
    .await;
    assert_eq!(invalid.code, ErrorCode::InvalidParams);

    // The open-time reaper already ran: the stale running claim with an
    // attempt left is pending again (and, as the oldest row, drains first);
    // the exhausted one is terminally failed and never re-served.
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

    // Drain the two seeded pending claims oldest-first and walk both settle
    // arms.
    let first = call(
        &transport,
        &handle,
        &mut id,
        "automations.claimNext",
        json!({ "nowMs": 1002 }),
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
    let done = call(
        &transport,
        &handle,
        &mut id,
        "automations.settle",
        json!({ "claimId": first["claimId"], "state": "done", "nowMs": 1003 }),
    )
    .await;
    assert_eq!(done["state"], json!("done"));
    let resettle = call_error(
        &transport,
        &handle,
        &mut id,
        "automations.settle",
        json!({ "claimId": first["claimId"], "state": "done", "nowMs": 1004 }),
    )
    .await;
    assert_eq!(resettle.code, ErrorCode::InvalidParams);

    let second = call(
        &transport,
        &handle,
        &mut id,
        "automations.claimNext",
        json!({ "nowMs": 1005 }),
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
            "nowMs": 1006,
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

    // The failure surface aggregates the failed rows — the reaper-exhausted
    // claim and the failed settle above — into one row per automation with
    // the newest error and a generation that counts the failed claims. The
    // reaper ran at workspace.open with the real clock, so its failure is
    // the newest.
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
        json!(2),
        "the generation counts the failed claims"
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
