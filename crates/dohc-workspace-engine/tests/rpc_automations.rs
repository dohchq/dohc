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
    CollectionFieldChangeFact, CollectionRecordApplyFacts, NoFaults, VersionedTextStore, WriteText,
    claim_automation_triggers_in_tx, claim_record_lifecycle_in_tx, reconcile_collections_in_tx,
    set_collection_adoption_state_in_tx, subscribe_automation_in_tx,
};
use dohc_engine_protocol::{
    error::ErrorCode,
    transport::{EngineTransport, InProcessTransport, RequestContext},
    wire::WorkspaceHandle,
};
use dohc_engine_storage::{EngineStore, StorageError};
use dohc_engine_testkit::{ScratchDir, engine_db_path};
use dohc_workspace_engine::{
    AUTOMATION_CLAIMED_EVENT, EngineService, root_binding::write_root_binding,
};
use serde_json::{Value, json};
use std::sync::Arc;

const WORKSPACE_ID: &str = "ws-rpc-automations";
const AUTOMATION: &str = "collection:tasks#triage";

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
            stopped.author_origin_id = Some("collection:tasks#other".to_owned());
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
    let service = Arc::new(EngineService::new());
    let mut notices = service.events().subscribe();
    let transport = InProcessTransport::new(service);
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
            json!({ "automationId": "collection:x#y", "path": "tasks", "kinds": ["changed"] }),
        ),
        (
            "automations.unsubscribe",
            json!({ "automationId": "collection:x#y", "path": "tasks" }),
        ),
        (
            "automations.claimNext",
            json!({ "automationIdPrefix": AUTOMATION }),
        ),
        ("automations.failures", json!({})),
        (
            "automations.listClaims",
            json!({ "automationId": "collection:x#y" }),
        ),
        (
            "automations.settle",
            json!({ "claimId": "atc_x", "state": "done" }),
        ),
        ("automations.retry", json!({ "claimId": "atc_x" })),
        ("automations.release", json!({ "claimId": "atc_x" })),
        (
            "automations.press",
            json!({
                "pressId": "p",
                "automationId": "collection:x#y",
                "recordId": "r",
                "pressedBy": "u",
            }),
        ),
        (
            "automations.claimSchedule",
            json!({ "automationId": "collection:x#y", "scheduleHash": "h", "run": [], "throughMs": 1 }),
        ),
        ("automations.scheduleMarks", json!({})),
        (
            "automations.runNow",
            json!({ "automationId": "collection:x#y", "noticeId": "n" }),
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
            "automationId": "collection:tasks#janitor",
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
        json!({ "automationId": "collection:tasks#janitor", "path": ".", "kinds": ["changed"] }),
    )
    .await;
    assert_eq!(replaced, json!({ "subscribed": true }));
    let removed = call(
        &transport,
        &handle,
        &mut id,
        "automations.unsubscribe",
        json!({ "automationId": "collection:tasks#janitor", "path": "." }),
    )
    .await;
    assert_eq!(removed, json!({ "unsubscribed": true }));
    let missing = call(
        &transport,
        &handle,
        &mut id,
        "automations.unsubscribe",
        json!({ "automationId": "collection:tasks#janitor", "path": "." }),
    )
    .await;
    assert_eq!(missing, json!({ "unsubscribed": false }));
    for (params, wrong) in [
        (
            json!({ "automationId": "  ", "path": "tasks", "kinds": ["changed"] }),
            "a blank automation id",
        ),
        (
            json!({ "automationId": "hello/triage", "path": "tasks", "kinds": ["changed"] }),
            "an id outside the executor namespaces",
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
        json!({ "nowMs": 1000, "automationIdPrefix": AUTOMATION }),
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
            "authorOriginId": null,
            "actorKind": null,
            "onBehalfOf": null,
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

    // A claim drains only under its own automation id prefix.
    let other_executor = call(
        &transport,
        &handle,
        &mut id,
        "automations.claimNext",
        json!({ "nowMs": 1002, "automationIdPrefix": "collection:notes#" }),
    )
    .await;
    assert_eq!(other_executor, Value::Null);
    for params in [
        json!({ "automationIdPrefix": "" }),
        json!({ "nowMs": 1002 }),
    ] {
        let error = call_error(
            &transport,
            &handle,
            &mut id,
            "automations.claimNext",
            params,
        )
        .await;
        assert_eq!(
            error.code,
            ErrorCode::InvalidParams,
            "claimNext needs a non-empty prefix"
        );
    }

    // Drain the two seeded pending claims oldest-first and walk both settle
    // arms. A served claim carries its change's facts.
    let first = call(
        &transport,
        &handle,
        &mut id,
        "automations.claimNext",
        json!({ "nowMs": 1003, "automationIdPrefix": AUTOMATION }),
    )
    .await;
    assert_eq!(first["automationId"], json!(AUTOMATION));
    assert_eq!(first["state"], json!("running"));
    assert_eq!(first["attempts"], json!(1));
    assert_eq!(first["run"], json!(1));
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
            "authorOriginId": "alice",
            "actorKind": "human",
            "onBehalfOf": null,
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
        json!({ "nowMs": 1006, "automationIdPrefix": AUTOMATION }),
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
        json!({ "automationIdPrefix": AUTOMATION }),
    )
    .await;
    assert_eq!(drained, Value::Null, "nothing pending remains");

    // The owner's re-run: the failed claim goes back to pending as run 2
    // with the same facts, and announces itself so the executor wakes and
    // the failure surface re-reads. Retrying it while it is pending changes
    // nothing and announces nothing.
    let failures = call(
        &transport,
        &handle,
        &mut id,
        "automations.failures",
        json!({}),
    )
    .await;
    assert_eq!(
        failures["failures"][0]["claimId"],
        json!("atc_exhaust"),
        "a failure row names its newest failed claim: the reaper's, which \
         ran at open with the real clock"
    );
    while notices.try_recv().is_ok() {}
    let retried = call(
        &transport,
        &handle,
        &mut id,
        "automations.retry",
        json!({ "claimId": second["claimId"], "nowMs": 1008 }),
    )
    .await;
    assert_eq!(retried["state"], json!("pending"));
    assert_eq!(retried["run"], json!(2));
    assert!(retried.get("error").is_none());
    let notice = notices.try_recv().expect("the retry announces the claim");
    assert_eq!(notice.name, AUTOMATION_CLAIMED_EVENT);
    assert_eq!(notice.payload["workspaceId"], json!(WORKSPACE_ID));
    assert_eq!(notice.payload["claimId"], second["claimId"]);
    assert_eq!(notice.payload["state"], json!("pending"));
    assert_eq!(notice.payload["run"], json!(2));
    let again = call(
        &transport,
        &handle,
        &mut id,
        "automations.retry",
        json!({ "claimId": second["claimId"], "nowMs": 1009 }),
    )
    .await;
    assert_eq!(again, retried, "a pending claim is returned unchanged");
    assert!(
        notices.try_recv().is_err(),
        "an unchanged retry announces nothing"
    );
    let rerun = call(
        &transport,
        &handle,
        &mut id,
        "automations.claimNext",
        json!({ "nowMs": 1010, "automationIdPrefix": AUTOMATION }),
    )
    .await;
    assert_eq!(rerun["claimId"], second["claimId"]);
    assert_eq!(
        (rerun["attempts"].clone(), rerun["run"].clone()),
        (json!(2), json!(2)),
        "attempts keep rising, and this is run 2"
    );
    assert_eq!(rerun["change"], second["change"]);

    // An executor that cannot run the claim yet hands it back: pending with
    // the attempts it had before this serve and the same run. It announces
    // nothing, so a held claim is not served straight back. Only a running
    // claim can be released.
    while notices.try_recv().is_ok() {}
    let released = call(
        &transport,
        &handle,
        &mut id,
        "automations.release",
        json!({ "claimId": rerun["claimId"], "nowMs": 1010 }),
    )
    .await;
    assert_eq!(
        (
            released["state"].clone(),
            released["attempts"].clone(),
            released["run"].clone()
        ),
        (json!("pending"), json!(1), json!(2))
    );
    assert!(notices.try_recv().is_err(), "a release announces nothing");
    let error = call_error(
        &transport,
        &handle,
        &mut id,
        "automations.release",
        json!({ "claimId": rerun["claimId"] }),
    )
    .await;
    assert_eq!(
        error.code,
        ErrorCode::InvalidParams,
        "a pending claim cannot be released"
    );
    let rerun = call(
        &transport,
        &handle,
        &mut id,
        "automations.claimNext",
        json!({ "nowMs": 1010, "automationIdPrefix": AUTOMATION }),
    )
    .await;
    assert_eq!(rerun["claimId"], second["claimId"]);
    assert_eq!(
        (rerun["attempts"].clone(), rerun["run"].clone()),
        (json!(2), json!(2)),
        "the released serve did not count"
    );
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
        rows[0]["chainStopped"],
        json!(false),
        "the newest failure ran and can be retried"
    );
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

/// A record added on this computer and then written through
/// `versionedText.write` claims once for each change: the added claim keys
/// on the moment that created the file and lists its values, the field
/// write keys on its history row and carries previous and next values, and
/// a repeated or body-only write claims nothing. A write an automation
/// authors claims as that automation, never for itself, and a rollback
/// claims like any write. Each claim announces itself.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn records_added_and_written_on_this_computer_claim_once_through_rpc() {
    const RECORD: &str = "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa";
    const OBJECT: &str = "object-alpha";
    let scratch = ScratchDir::new().expect("scratch");
    write_root_binding(scratch.path(), TOKEN).expect("root binding");
    let record =
        |status: &str, body: &str| format!("---\nid: {RECORD}\nstatus: {status}\n---\n\n{body}");
    {
        let db = engine_db_path(&scratch).expect("engine db path");
        let mut store = EngineStore::open(&db, 1).expect("open store");
        store.bind_root_token(TOKEN, &NoFaults).expect("bind token");
        store
            .write_with(&NoFaults, |tx| {
                subscribe_automation_in_tx(
                    tx,
                    WORKSPACE_ID,
                    &AutomationSubscription {
                        automation_id: "collection:tasks#watch".to_owned(),
                        prefix: "tasks".to_owned(),
                        kinds: vec![AutomationChangeKind::Added, AutomationChangeKind::Changed],
                        fields: None,
                    },
                    5,
                )
            })
            .expect("subscribe");
        let mut versions = VersionedTextStore::new(&mut store);
        versions
            .ensure_main_version(WORKSPACE_ID, "main", 1, &NoFaults)
            .expect("main version");
        for (object_id, path, text, moment_id) in [
            (
                "object-schema",
                "tasks/collection.yaml",
                "fields:\n  status:\n    type: text\n".to_owned(),
                "schema",
            ),
            (
                OBJECT,
                "tasks/alpha.md",
                record("open", "Body"),
                "alpha-created",
            ),
        ] {
            versions
                .write_text(
                    &WriteText {
                        workspace_id: WORKSPACE_ID.to_owned(),
                        version_id: "main".to_owned(),
                        object_id: object_id.to_owned(),
                        path: path.to_owned(),
                        text,
                        moment_id: moment_id.to_owned(),
                        metadata_origin: "test".to_owned(),
                        metadata_summary: None,
                        metadata_correlation_id: None,
                        author_json: None,
                        now_ms: 10,
                        request_id: None,
                    },
                    &NoFaults,
                )
                .expect("seed collection file");
        }
        store
            .write_with(&NoFaults, |tx| {
                let reconciliation = reconcile_collections_in_tx(tx, WORKSPACE_ID, "main")?;
                set_collection_adoption_state_in_tx(
                    tx,
                    WORKSPACE_ID,
                    "main",
                    "tasks/alpha.md",
                    RECORD,
                    "adopted",
                )?;
                claim_record_lifecycle_in_tx(
                    tx,
                    WORKSPACE_ID,
                    "main",
                    &reconciliation.lifecycle,
                    20,
                )
            })
            .expect("bind the record and claim its addition");
    }
    let service = Arc::new(EngineService::new());
    let mut notices = service.events().subscribe();
    let transport = InProcessTransport::new(service);
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
                    "captureMode": "none",
                }),
            ),
        )
        .await
        .expect("open workspace");
    let handle: WorkspaceHandle =
        serde_json::from_value(opened.result["workspace"].clone()).expect("workspace handle");
    let mut id = 1;
    let claim_next = async |id: &mut u64| {
        call(
            &transport,
            &handle,
            id,
            "automations.claimNext",
            json!({ "automationIdPrefix": "collection:" }),
        )
        .await
    };

    let added = claim_next(&mut id).await;
    assert_eq!(added["recordId"], json!(RECORD));
    assert!(
        added["trigger"]["momentOrder"].is_i64(),
        "an added record keys on its creating moment: {added}"
    );
    assert_eq!(
        added["change"],
        json!({
            "kind": "added",
            "authorOriginId": null,
            "actorKind": null,
            "onBehalfOf": null,
            "fields": [{
                "field": "status",
                "historyId": null,
                "previous": null,
                "next": { "value": "open" },
            }],
            "fieldsOmitted": 0,
        })
    );
    call(
        &transport,
        &handle,
        &mut id,
        "automations.settle",
        json!({ "claimId": added["claimId"], "state": "done" }),
    )
    .await;

    let write = async |id: &mut u64, moment_id: &str, text: String| {
        call(
            &transport,
            &handle,
            id,
            "versionedText.write",
            json!({
                "versionId": "main",
                "objectId": OBJECT,
                "path": "tasks/alpha.md",
                "text": text,
                "momentId": moment_id,
                "origin": "api",
            }),
        )
        .await
    };
    while notices.try_recv().is_ok() {}
    write(&mut id, "alpha-done", record("done", "Body")).await;
    let notice = notices
        .try_recv()
        .expect("the field write announces its claim");
    assert_eq!(notice.name, AUTOMATION_CLAIMED_EVENT);
    assert_eq!(notice.payload["change"]["kind"], json!("changed"));
    let changed = claim_next(&mut id).await;
    assert!(changed["trigger"]["historyId"].is_i64(), "{changed}");
    assert_eq!(
        changed["change"]["fields"],
        json!([{
            "field": "status",
            "historyId": changed["change"]["fields"][0]["historyId"],
            "previous": { "value": "open" },
            "next": { "value": "done" },
        }])
    );
    assert!(changed["change"]["fields"][0]["historyId"].is_i64());

    write(&mut id, "alpha-again", record("done", "Body")).await;
    write(&mut id, "alpha-body", record("done", "New body")).await;
    assert_eq!(
        claim_next(&mut id).await,
        Value::Null,
        "a repeated or body-only write claims nothing"
    );
    assert!(notices.try_recv().is_err(), "and announces nothing");

    // An automation's write names it: the writer skips its own change, and
    // another automation's write claims at that writer's depth.
    let write_as = async |id: &mut u64, moment_id: &str, text: String, automation_id: &str| {
        call(
            &transport,
            &handle,
            id,
            "versionedText.write",
            json!({
                "versionId": "main",
                "objectId": OBJECT,
                "path": "tasks/alpha.md",
                "text": text,
                "momentId": moment_id,
                "origin": "api",
                "author": {
                    "kind": "automation",
                    "automationId": automation_id,
                    "onBehalfOf": "local",
                    "depth": 2,
                },
            }),
        )
        .await
    };
    write_as(
        &mut id,
        "alpha-own",
        record("blocked", "New body"),
        "collection:tasks#watch",
    )
    .await;
    assert_eq!(
        claim_next(&mut id).await,
        Value::Null,
        "an automation does not claim its own write"
    );
    let stamped = write_as(
        &mut id,
        "alpha-stamped",
        record("review", "New body"),
        "collection:tasks#stamp",
    )
    .await;
    let stamped_claim = claim_next(&mut id).await;
    assert_eq!(stamped_claim["depth"], json!(2));
    assert_eq!(
        stamped_claim["change"]["authorOriginId"],
        json!("collection:tasks#stamp")
    );
    assert_eq!(stamped_claim["change"]["actorKind"], json!("automation"));

    // Rolling a write back changes the record too, and wakes the executor.
    while notices.try_recv().is_ok() {}
    call(
        &transport,
        &handle,
        &mut id,
        "versionedText.rollback",
        json!({
            "versionId": "main",
            "path": "tasks/alpha.md",
            "mutationMomentId": stamped["moment"]["momentId"],
            "origin": "restore",
        }),
    )
    .await;
    let notice = notices
        .try_recv()
        .expect("the rollback announces its claim");
    assert_eq!(notice.name, AUTOMATION_CLAIMED_EVENT);
    let rolled_back = claim_next(&mut id).await;
    assert_eq!(
        rolled_back["change"]["fields"][0]["next"],
        json!({ "value": "blocked" })
    );
}

/// A record an automation creates through `versionedText.write`, as the
/// desktop's `collections.createRecord` does, is added as that
/// automation's change: the moment records the author, and the added claim
/// names it at its depth.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_record_an_automation_writes_through_rpc_is_added_as_its_change() {
    const STAMP: &str = "collection:tasks#stamp";
    let scratch = ScratchDir::new().expect("scratch");
    write_root_binding(scratch.path(), TOKEN).expect("root binding");
    let db = engine_db_path(&scratch).expect("engine db path");
    {
        let mut store = EngineStore::open(&db, 1).expect("open store");
        store.bind_root_token(TOKEN, &NoFaults).expect("bind token");
        store
            .write_with(&NoFaults, |tx| {
                subscribe_automation_in_tx(
                    tx,
                    WORKSPACE_ID,
                    &AutomationSubscription {
                        automation_id: "collection:tasks#watch".to_owned(),
                        prefix: "tasks".to_owned(),
                        kinds: vec![AutomationChangeKind::Added],
                        fields: None,
                    },
                    5,
                )
            })
            .expect("subscribe");
        let mut versions = VersionedTextStore::new(&mut store);
        versions
            .ensure_main_version(WORKSPACE_ID, "main", 1, &NoFaults)
            .expect("main version");
        versions
            .write_text(
                &WriteText {
                    workspace_id: WORKSPACE_ID.to_owned(),
                    version_id: "main".to_owned(),
                    object_id: "object-schema".to_owned(),
                    path: "tasks/collection.yaml".to_owned(),
                    text: "fields:\n  status:\n    type: text\n".to_owned(),
                    moment_id: "schema".to_owned(),
                    metadata_origin: "test".to_owned(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: None,
                    now_ms: 10,
                    request_id: None,
                },
                &NoFaults,
            )
            .expect("seed the schema");
    }
    let service = Arc::new(EngineService::new());
    let transport = InProcessTransport::new(service);
    let mut id = 0;
    let open = async |id: &mut u64| -> WorkspaceHandle {
        *id += 1;
        let opened = transport
            .call(
                RequestContext::unbounded(),
                request(
                    *id,
                    "workspace.open",
                    None,
                    json!({
                        "rootDir": scratch.path().to_string_lossy(),
                        "workspaceId": WORKSPACE_ID,
                        "captureMode": "none",
                    }),
                ),
            )
            .await
            .expect("open workspace");
        serde_json::from_value(opened.result["workspace"].clone()).expect("workspace handle")
    };
    let handle = open(&mut id).await;
    call(
        &transport,
        &handle,
        &mut id,
        "versionedText.write",
        json!({
            "versionId": "main",
            "createOnly": true,
            "objectId": "object-beta",
            "path": "tasks/beta.md",
            "text": "---\nid: rec_bbbbbbbbbbbbbbbbbbbbbbbbbb\nstatus: open\n---\n\nBody",
            "momentId": "beta-created",
            "origin": "api",
            "author": {
                "kind": "automation",
                "automationId": STAMP,
                "onBehalfOf": "local",
                "depth": 2,
            },
        }),
    )
    .await;
    assert!(
        std::fs::read_to_string(scratch.path().join("tasks/beta.md"))
            .expect("published record")
            .contains("rec_bbbbbbbbbbbbbbbbbbbbbbbbbb")
    );
    let before = std::fs::read(scratch.path().join("tasks/beta.md")).expect("before collision");
    let collision = call_error(
        &transport,
        &handle,
        &mut id,
        "versionedText.write",
        json!({
            "versionId": "main", "createOnly": true, "path": "tasks/beta.md",
            "text": "must not replace beta", "momentId": "collision-loser", "origin": "api",
        }),
    )
    .await;
    assert_eq!(collision.message, "target-path-exists");
    assert_eq!(
        std::fs::read(scratch.path().join("tasks/beta.md")).expect("after collision"),
        before
    );
    call(&transport, &handle, &mut id, "workspace.close", json!({})).await;
    {
        let mut store = EngineStore::open(&db, 2).expect("reopen store");
        assert!(
            VersionedTextStore::new(&mut store)
                .get_moment(WORKSPACE_ID, "collision-loser")
                .expect("loser history")
                .is_none()
        );
        store
            .write_with(&NoFaults, |tx| {
                let reconciliation = reconcile_collections_in_tx(tx, WORKSPACE_ID, "main")?;
                claim_record_lifecycle_in_tx(
                    tx,
                    WORKSPACE_ID,
                    "main",
                    &reconciliation.lifecycle,
                    20,
                )
            })
            .expect("bind the record and claim its addition");
    }
    let handle = open(&mut id).await;
    let added = call(
        &transport,
        &handle,
        &mut id,
        "automations.claimNext",
        json!({ "automationIdPrefix": "collection:" }),
    )
    .await;
    assert_eq!(added["automationId"], json!("collection:tasks#watch"));
    assert_eq!(added["change"]["kind"], json!("added"));
    assert_eq!(added["change"]["authorOriginId"], json!(STAMP));
    assert_eq!(added["change"]["actorKind"], json!("automation"));
    assert_eq!(added["depth"], json!(2));
}

fn claimed_events(
    notices: &mut tokio::sync::mpsc::Receiver<dohc_workspace_engine::EngineEventNotice>,
) -> Vec<Value> {
    let mut claimed = Vec::new();
    while let Ok(notice) = notices.try_recv() {
        if notice.name == AUTOMATION_CLAIMED_EVENT {
            claimed.push(notice.payload);
        }
    }
    claimed
}

/// A Group subscription made through RPC claims each matching message a
/// local write stores, announces each claim, and serves the message with
/// it. `chats.messages.get` reads the whole message.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn group_messages_written_here_claim_through_rpc() {
    const TASK: &str = "collection:Trip/Tasks#task";
    let scratch = ScratchDir::new().expect("scratch");
    write_root_binding(scratch.path(), TOKEN).expect("root binding");
    let service = Arc::new(EngineService::new());
    let mut notices = service.events().subscribe();
    let transport = InProcessTransport::new(service);
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
                    "captureMode": "none",
                }),
            ),
        )
        .await
        .expect("open workspace");
    let handle: WorkspaceHandle =
        serde_json::from_value(opened.result["workspace"].clone()).expect("workspace handle");
    let mut id = 1;
    call(
        &transport,
        &handle,
        &mut id,
        "chats.channels.create",
        json!({ "channelId": "trip", "name": "Trip", "kind": "channel", "nowMs": 10 }),
    )
    .await;

    let mixed = call_error(
        &transport,
        &handle,
        &mut id,
        "automations.subscribe",
        json!({ "automationId": TASK, "groupId": "trip", "path": "Trip", "kinds": ["added"] }),
    )
    .await;
    assert_eq!(
        mixed.code,
        ErrorCode::InvalidParams,
        "a record subscription names no Group; Groups are watched"
    );
    let watch = |subscriptions: Value| json!({ "generation": 0, "subscriptions": subscriptions, "nowMs": 10 });
    let missing = call_error(
        &transport,
        &handle,
        &mut id,
        "automations.watchGroups",
        watch(json!([{ "automationId": TASK, "groupId": "no-such-group" }])),
    )
    .await;
    assert_eq!(missing.code, ErrorCode::InvalidParams, "only a Group here");
    let watched = call(
        &transport,
        &handle,
        &mut id,
        "automations.watchGroups",
        watch(json!([{ "automationId": TASK, "groupId": "trip", "startsWith": "/task" }])),
    )
    .await;
    assert_eq!(watched, json!({ "needsHandover": false }));

    claimed_events(&mut notices);
    call(
        &transport,
        &handle,
        &mut id,
        "chats.threads.start",
        json!({
            "channelId": "trip",
            "threadId": "t1",
            "messageId": "m1",
            "authorKind": "human",
            "authorDisplayName": "Ada",
            "authorUserId": "ada",
            "body": "/task Buy tickets",
            "nowMs": 20,
        }),
    )
    .await;
    let claimed = claimed_events(&mut notices);
    assert_eq!(claimed.len(), 1, "{claimed:?}");
    assert_eq!(claimed[0]["trigger"], json!({ "key": "message:m1" }));
    assert_eq!(claimed[0]["recordId"], Value::Null);
    assert_eq!(claimed[0]["collectionPath"], json!("Trip/Tasks"));
    assert_eq!(claimed[0]["workspaceId"], json!(WORKSPACE_ID));

    let send = async |id: &mut u64, message_id: &str, body: &str| {
        call(
            &transport,
            &handle,
            id,
            "chats.messages.send",
            json!({
                "threadId": "t1",
                "messageId": message_id,
                "parentMessageId": "m1",
                "authorKind": "human",
                "authorDisplayName": "Ana",
                "body": body,
                "nowMs": 30,
            }),
        )
        .await
    };
    send(&mut id, "m2", "/task Pack").await;
    assert_eq!(claimed_events(&mut notices).len(), 1, "a matching reply");
    send(&mut id, "m3", "hello").await;
    assert!(claimed_events(&mut notices).is_empty(), "no starting text");

    let served = call(
        &transport,
        &handle,
        &mut id,
        "automations.claimNext",
        json!({ "automationIdPrefix": "collection:" }),
    )
    .await;
    assert_eq!(
        served["change"],
        json!({
            "kind": "message",
            "authorOriginId": null,
            "actorKind": "human",
            "onBehalfOf": "ada",
            "fields": [],
            "fieldsOmitted": 0,
            "message": {
                "id": "m1",
                "threadId": "t1",
                "groupId": "trip",
                "lane": "posts",
                "authorKind": "human",
                "authorDisplayName": "Ada",
                "authorUserId": "ada",
                "createdAtMs": 20,
                "body": "/task Buy tickets",
            },
        })
    );
    let read = call(
        &transport,
        &handle,
        &mut id,
        "chats.messages.get",
        json!({ "messageId": "m1" }),
    )
    .await;
    assert_eq!(read["message"]["body"], json!("/task Buy tickets"));

    call(
        &transport,
        &handle,
        &mut id,
        "automations.watchGroups",
        watch(json!([])),
    )
    .await;
    send(&mut id, "m4", "/task Again").await;
    assert!(claimed_events(&mut notices).is_empty(), "no longer watched");

    // A handover: releasing freezes every Group subscription and answers what
    // the next host needs.
    call(
        &transport,
        &handle,
        &mut id,
        "automations.watchGroups",
        json!({
            "generation": 0,
            "subscriptions": [{ "automationId": TASK, "groupId": "trip", "startsWith": "/task" }],
            "nowMs": 35,
        }),
    )
    .await;
    let stray = call_error(
        &transport,
        &handle,
        &mut id,
        "automations.releaseGroups",
        json!({ "groupId": "trip" }),
    )
    .await;
    assert_eq!(stray.code, ErrorCode::InvalidParams, "it names no Group");
    let released = call(
        &transport,
        &handle,
        &mut id,
        "automations.releaseGroups",
        json!({ "nowMs": 36 }),
    )
    .await;
    assert_eq!(released["takenGeneration"], json!(0));
    let handover = released["handover"].clone();
    assert_eq!(handover["automations"][0]["automationId"], json!(TASK));
    assert_eq!(
        handover["automations"][0]["decided"],
        json!([
            { "messageId": "m1", "createdAtMs": 20 },
            { "messageId": "m2", "createdAtMs": 30 },
        ])
    );
    send(&mut id, "m5", "/task Once more").await;
    assert!(
        claimed_events(&mut notices).is_empty(),
        "a frozen subscription claims nothing"
    );

    // The next generation asks for its handover, then takes it.
    let next = |handover: Option<Value>| {
        let mut params = json!({
            "generation": 2,
            "subscriptions": [{ "automationId": TASK, "groupId": "trip", "startsWith": "/task" }],
            "nowMs": 40,
        });
        if let Some(handover) = handover {
            params["handover"] = handover;
        }
        params
    };
    let asks = call(
        &transport,
        &handle,
        &mut id,
        "automations.watchGroups",
        next(None),
    )
    .await;
    assert_eq!(asks, json!({ "needsHandover": true }));
    let took = call(
        &transport,
        &handle,
        &mut id,
        "automations.watchGroups",
        next(Some(json!({
            "state": "fetched",
            "generation": 2,
            "floorMs": handover["floorMs"],
            "automations": handover["automations"],
        }))),
    )
    .await;
    assert_eq!(took, json!({ "needsHandover": false }));
    let unknown = call_error(
        &transport,
        &handle,
        &mut id,
        "automations.watchGroups",
        next(Some(json!({ "state": "lost" }))),
    )
    .await;
    assert_eq!(
        unknown.code,
        ErrorCode::InvalidParams,
        "only the relay's three answers"
    );
}

/// A button press and a schedule step claim through RPC: a new press
/// announces its claim and the same press sent again answers it without a
/// second, a schedule starts its mark before it claims, and the marks read
/// back.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn presses_and_schedule_steps_claim_through_rpc() {
    const PAY: &str = "collection:Invoices#mark-paid";
    const REPORT: &str = "collection:Invoices#weekday-report";
    let scratch = ScratchDir::new().expect("scratch");
    write_root_binding(scratch.path(), TOKEN).expect("root binding");
    let service = Arc::new(EngineService::new());
    let mut notices = service.events().subscribe();
    let transport = InProcessTransport::new(service);
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
                    "captureMode": "none",
                }),
            ),
        )
        .await
        .expect("open workspace");
    let handle: WorkspaceHandle =
        serde_json::from_value(opened.result["workspace"].clone()).expect("workspace handle");
    let mut id = 1;
    claimed_events(&mut notices);

    let press = json!({
        "pressId": "press-1",
        "automationId": PAY,
        "recordId": "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa",
        "pressedBy": "user:ada",
        "nowMs": 100,
    });
    let answer = call(
        &transport,
        &handle,
        &mut id,
        "automations.press",
        press.clone(),
    )
    .await;
    assert_eq!(answer["busy"], json!(false));
    let pressed = &answer["claim"];
    assert_eq!(pressed["trigger"], json!({ "key": "press:press-1" }));
    assert_eq!(pressed["recordId"], json!("rec_aaaaaaaaaaaaaaaaaaaaaaaaaa"));
    assert_eq!(pressed["collectionPath"], json!("Invoices"));
    assert_eq!(pressed["depth"], json!(0));
    assert_eq!(
        pressed["change"],
        json!({
            "kind": "button",
            "authorOriginId": null,
            "actorKind": "human",
            "onBehalfOf": "user:ada",
        })
    );
    assert_eq!(pressed["state"], json!("pending"));
    let claimed = claimed_events(&mut notices);
    assert_eq!(claimed.len(), 1, "{claimed:?}");
    assert_eq!(claimed[0]["claimId"], pressed["claimId"]);

    let again = call(&transport, &handle, &mut id, "automations.press", press).await;
    assert_eq!(again["claim"]["claimId"], pressed["claimId"]);
    let busy = call(
        &transport,
        &handle,
        &mut id,
        "automations.press",
        json!({
            "pressId": "press-bo",
            "automationId": PAY,
            "recordId": "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa",
            "pressedBy": "user:bo",
        }),
    )
    .await;
    assert_eq!(busy, json!({ "busy": true, "claim": null }));
    assert!(
        claimed_events(&mut notices).is_empty(),
        "a remembered or busy press announces nothing"
    );
    let not_collection = call_error(
        &transport,
        &handle,
        &mut id,
        "automations.press",
        json!({
            "pressId": "press-2",
            "automationId": "collection:triage",
            "recordId": "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa",
            "pressedBy": "user:ada",
        }),
    )
    .await;
    assert_eq!(not_collection.code, ErrorCode::InvalidParams);

    let started = call(
        &transport,
        &handle,
        &mut id,
        "automations.claimSchedule",
        json!({ "automationId": REPORT, "scheduleHash": "h1", "run": [], "throughMs": 1_000 }),
    )
    .await;
    assert_eq!(
        started,
        json!({
            "claims": [],
            "mark": { "automationId": REPORT, "scheduleHash": "h1", "throughMs": 1_000 },
        })
    );
    let refused = call_error(
        &transport,
        &handle,
        &mut id,
        "automations.claimSchedule",
        json!({ "automationId": REPORT, "scheduleHash": "h1", "run": [1_000], "throughMs": 2_000 }),
    )
    .await;
    assert_eq!(refused.code, ErrorCode::InvalidParams);
    let ran = call(
        &transport,
        &handle,
        &mut id,
        "automations.claimSchedule",
        json!({
            "automationId": REPORT,
            "scheduleHash": "h1",
            "run": [2_000],
            "throughMs": 3_000,
            "nowMs": 3_100,
        }),
    )
    .await;
    assert_eq!(ran["claims"].as_array().map(Vec::len), Some(1), "{ran}");
    assert_eq!(
        ran["claims"][0]["trigger"],
        json!({ "key": "schedule:2000" })
    );
    assert_eq!(ran["claims"][0]["recordId"], Value::Null);
    assert_eq!(ran["claims"][0]["change"]["kind"], json!("schedule"));
    assert_eq!(ran["mark"]["throughMs"], json!(3_000));
    assert_eq!(claimed_events(&mut notices).len(), 1);

    let marks = call(
        &transport,
        &handle,
        &mut id,
        "automations.scheduleMarks",
        json!({}),
    )
    .await;
    assert_eq!(
        marks,
        json!({ "marks": [{ "automationId": REPORT, "scheduleHash": "h1", "throughMs": 3_000 }] })
    );

    let notice = "schedule-skipped:ws:collection:Invoices#weekday-report:2000";
    let run_now = json!({ "automationId": REPORT, "noticeId": notice, "nowMs": 4_000 });
    let first = call(
        &transport,
        &handle,
        &mut id,
        "automations.runNow",
        run_now.clone(),
    )
    .await;
    assert_eq!(
        first["claim"]["trigger"],
        json!({ "key": format!("run-now:{notice}") }),
        "{first}"
    );
    assert_eq!(first["claim"]["recordId"], Value::Null);
    assert_eq!(first["claim"]["change"]["kind"], json!("schedule"));
    assert_eq!(claimed_events(&mut notices).len(), 1);
    let again = call(&transport, &handle, &mut id, "automations.runNow", run_now).await;
    assert_eq!(
        again,
        json!({ "claim": first["claim"].clone() }),
        "a repeat answers the claim it made"
    );
    assert!(
        claimed_events(&mut notices).is_empty(),
        "and announces nothing"
    );
}
