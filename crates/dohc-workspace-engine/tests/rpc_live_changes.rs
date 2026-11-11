//! Who stopped or resumed live editing of an owner document, through the RPC.
mod common;

use common::*;
use dohc_engine_protocol::{
    error::ErrorCode,
    transport::{InProcessTransport, RequestContext},
    wire::WorkspaceHandle,
};
use dohc_engine_testkit::ScratchDir;
use dohc_workspace_engine::EngineService;
use serde_json::{Value, json};
use std::sync::Arc;

async fn open(
    transport: &InProcessTransport<EngineService>,
    scratch: &ScratchDir,
    received: bool,
) -> WorkspaceHandle {
    let response = call_with_busy_retry(
        transport,
        RequestContext::unbounded(),
        request(
            1,
            "workspace.open",
            None,
            json!({
                "rootDir": scratch.path().to_string_lossy(),
                "workspaceId": "workspace",
                "captureMode": "none",
                "projectCollections": received,
            }),
        ),
    )
    .await
    .expect("open handle");
    serde_json::from_value(response.result["workspace"].clone()).unwrap()
}

fn person() -> Value {
    json!({ "kind": "person", "personId": "person-1" })
}

fn agent() -> Value {
    json!({ "kind": "agent", "agentId": "agent-1", "agentName": "Planner", "onBehalfOf": "person-1", "depth": 1 })
}

async fn begin(
    transport: &InProcessTransport<EngineService>,
    handle: &WorkspaceHandle,
    object: &str,
    action: &str,
    author: Value,
    before: &str,
) -> Value {
    call(
        transport,
        handle,
        10,
        "ydoc.liveChange.begin",
        json!({ "objectId": object, "path": "notes/plan.md", "action": action, "author": author, "before": before }),
    )
    .await
}

async fn finish(
    transport: &InProcessTransport<EngineService>,
    handle: &WorkspaceHandle,
    object: &str,
    change: &Value,
    outcome: &str,
) -> bool {
    call(
        transport,
        handle,
        11,
        "ydoc.liveChange.finish",
        json!({ "objectId": object, "changeId": change["changeId"], "outcome": outcome }),
    )
    .await["finished"]
        .as_bool()
        .unwrap()
}

async fn list(
    transport: &InProcessTransport<EngineService>,
    handle: &WorkspaceHandle,
    objects: &[&str],
) -> Value {
    call(
        transport,
        handle,
        12,
        "ydoc.liveChange.list",
        json!({ "objectIds": objects }),
    )
    .await["changes"]
        .clone()
}

fn last(action: &str, author: Value, change: &Value) -> Value {
    json!({ "action": action, "path": "notes/plan.md", "atMs": change["atMs"], "author": author })
}

#[tokio::test]
async fn an_applied_change_becomes_the_last_and_a_refused_one_keeps_it() {
    let scratch = ScratchDir::new().unwrap();
    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let handle = open(&transport, &scratch, false).await;
    assert_eq!(list(&transport, &handle, &["doc"]).await, json!([]));

    let stop = begin(&transport, &handle, "doc", "stopped", person(), "ready").await;
    assert!(stop["changeId"].as_str().is_some_and(|id| !id.is_empty()));
    assert!(stop["atMs"].as_i64().is_some_and(|at| at > 0));
    assert_eq!(
        list(&transport, &handle, &[]).await,
        json!([{ "objectId": "doc", "pending": {
            "changeId": stop["changeId"], "action": "stopped", "path": "notes/plan.md",
            "atMs": stop["atMs"], "author": person(), "before": "ready",
        } }])
    );
    assert!(finish(&transport, &handle, "doc", &stop, "applied").await);
    let stopped = json!([{ "objectId": "doc", "last": last("stopped", person(), &stop) }]);
    assert_eq!(list(&transport, &handle, &["doc"]).await, stopped);
    // A finished change is not finished again.
    assert!(!finish(&transport, &handle, "doc", &stop, "refused").await);

    let resume = begin(&transport, &handle, "doc", "resumed", agent(), "retired").await;
    assert!(finish(&transport, &handle, "doc", &resume, "refused").await);
    assert_eq!(list(&transport, &handle, &["doc"]).await, stopped);
}

#[tokio::test]
async fn an_action_the_relay_already_shows_records_nothing() {
    let scratch = ScratchDir::new().unwrap();
    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let handle = open(&transport, &scratch, false).await;
    let stop = begin(&transport, &handle, "doc", "stopped", person(), "ready").await;
    assert!(finish(&transport, &handle, "doc", &stop, "applied").await);
    let stopped = list(&transport, &handle, &["doc"]).await;

    // An agent's Stop of a document a person already stopped takes no credit.
    assert_eq!(
        begin(&transport, &handle, "doc", "stopped", agent(), "retired").await,
        Value::Null
    );
    for before in ["ready", "preparing"] {
        assert_eq!(
            begin(&transport, &handle, "doc", "resumed", agent(), before).await,
            Value::Null
        );
    }
    assert_eq!(list(&transport, &handle, &["doc"]).await, stopped);
    // Every other status leaves the action something to do.
    for before in ["paused", "unavailable", "absent"] {
        for action in ["stopped", "resumed"] {
            assert!(
                begin(&transport, &handle, "other", action, agent(), before).await["changeId"]
                    .is_string(),
                "{action} from {before}"
            );
        }
    }
    let resume = begin(&transport, &handle, "other", "resumed", agent(), "retired").await;
    assert!(resume["changeId"].is_string());
}

#[tokio::test]
async fn a_change_under_way_is_never_replaced() {
    let scratch = ScratchDir::new().unwrap();
    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let handle = open(&transport, &scratch, false).await;
    let first = begin(&transport, &handle, "doc", "stopped", person(), "ready").await;
    // A second actor's change while the first is under way records nothing,
    // so the first keeps its record if the relay applies it.
    assert_eq!(
        begin(&transport, &handle, "doc", "resumed", agent(), "retired").await,
        Value::Null
    );
    assert!(
        !finish(
            &transport,
            &handle,
            "doc",
            &json!({ "changeId": "other" }),
            "applied"
        )
        .await
    );
    assert!(finish(&transport, &handle, "doc", &first, "applied").await);
    let next = begin(&transport, &handle, "doc", "resumed", agent(), "retired").await;
    assert_ne!(next["changeId"], first["changeId"]);
    // A late finish of the settled change never settles the next one.
    assert!(!finish(&transport, &handle, "doc", &first, "refused").await);
    let listed = list(&transport, &handle, &["doc"]).await;
    assert_eq!(listed[0]["pending"]["changeId"], next["changeId"]);
    assert_eq!(listed[0]["last"], last("stopped", person(), &first));
}

#[tokio::test]
async fn an_interrupted_change_stays_pending_across_a_reopen() {
    let scratch = ScratchDir::new().unwrap();
    let change = {
        let transport = InProcessTransport::new(Arc::new(EngineService::new()));
        let handle = open(&transport, &scratch, false).await;
        let change = begin(&transport, &handle, "doc", "resumed", agent(), "retired").await;
        call(&transport, &handle, 13, "workspace.close", json!({})).await;
        change
    };
    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let handle = open(&transport, &scratch, false).await;
    // Listed with no object named, so the desktop finds it after a restart.
    let listed = list(&transport, &handle, &[]).await;
    assert_eq!(listed[0]["objectId"], "doc");
    assert_eq!(listed[0]["pending"]["changeId"], change["changeId"]);
    assert_eq!(listed[0]["pending"]["before"], "retired");
    assert!(finish(&transport, &handle, "doc", &change, "applied").await);
    assert_eq!(
        list(&transport, &handle, &["doc"]).await,
        json!([{ "objectId": "doc", "last": last("resumed", agent(), &change) }])
    );
}

#[tokio::test]
async fn the_last_change_outlives_its_stop_and_its_document() {
    let scratch = ScratchDir::new().unwrap();
    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let handle = open(&transport, &scratch, false).await;
    call(
        &transport,
        &handle,
        2,
        "versionedText.write",
        json!({ "versionId": "main", "path": "notes/plan.md", "text": "Plan.", "origin": "api" }),
    )
    .await;
    let stops = call(
        &transport,
        &handle,
        3,
        "ydoc.ownerStop.request",
        json!({ "path": "notes/plan.md" }),
    )
    .await;
    let object = stops["stops"][0]["document"]["objectId"]
        .as_str()
        .unwrap()
        .to_owned();
    let stop = begin(&transport, &handle, &object, "stopped", person(), "ready").await;
    assert!(finish(&transport, &handle, &object, &stop, "applied").await);
    let recorded = list(&transport, &handle, &[&object]).await;
    assert_eq!(recorded[0]["last"]["action"], "stopped");

    call(
        &transport,
        &handle,
        4,
        "ydoc.ownerStop.clear",
        json!({ "path": "notes/plan.md" }),
    )
    .await;
    assert_eq!(list(&transport, &handle, &[&object]).await, recorded);
    call(
        &transport,
        &handle,
        5,
        "versionedText.delete",
        json!({ "versionId": "main", "path": "notes/plan.md", "origin": "api" }),
    )
    .await;
    assert_eq!(list(&transport, &handle, &[&object]).await, recorded);
}

#[tokio::test]
async fn a_received_share_records_no_live_changes() {
    let scratch = ScratchDir::new().unwrap();
    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let handle = open(&transport, &scratch, true).await;
    for (method, params) in [
        (
            "ydoc.liveChange.begin",
            json!({ "objectId": "doc", "path": "a.md", "action": "stopped", "author": person(), "before": "ready" }),
        ),
        (
            "ydoc.liveChange.finish",
            json!({ "objectId": "doc", "changeId": "c", "outcome": "applied" }),
        ),
        ("ydoc.liveChange.list", json!({ "objectIds": [] })),
    ] {
        let error = call_error(&transport, &handle, 20, method, params).await;
        assert_eq!(error.code, ErrorCode::Forbidden, "{method}");
    }
}

#[tokio::test]
async fn malformed_requests_are_refused_without_echoing_the_author() {
    let scratch = ScratchDir::new().unwrap();
    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let handle = open(&transport, &scratch, false).await;
    let secret = "person-name-that-must-not-appear";
    let base = json!({ "objectId": "doc", "path": "a.md", "action": "stopped", "before": "ready" });
    let with = |author: Value| {
        let mut params = base.clone();
        params["author"] = author;
        params
    };
    for params in [
        with(json!({ "kind": "person", "personId": secret, "extra": true })),
        with(json!({ "kind": "robot", "personId": secret })),
        with(json!({ "kind": "person", "personId": "" })),
        with(
            json!({ "kind": "agent", "agentId": secret, "agentName": "x".repeat(65), "onBehalfOf": "p", "depth": 0 }),
        ),
        with(json!({ "kind": "agent", "agentId": secret, "onBehalfOf": "p", "depth": -1 })),
        json!({ "objectId": "doc", "path": "../a.md", "action": "stopped", "author": person(), "before": "ready" }),
        json!({ "objectId": "doc", "path": "a.md", "action": "paused", "author": person(), "before": "ready" }),
        json!({ "objectId": "doc", "path": "a.md", "action": "stopped", "author": person(), "before": "gone" }),
    ] {
        let error = call_error(
            &transport,
            &handle,
            21,
            "ydoc.liveChange.begin",
            params.clone(),
        )
        .await;
        assert_eq!(error.code, ErrorCode::InvalidParams, "{params}");
        assert!(!error.message.contains(secret), "{}", error.message);
    }
    let ids: Vec<String> = (0..201).map(|index| format!("doc-{index}")).collect();
    let error = call_error(
        &transport,
        &handle,
        22,
        "ydoc.liveChange.list",
        json!({ "objectIds": ids }),
    )
    .await;
    assert_eq!(error.code, ErrorCode::InvalidParams);
    assert_eq!(list(&transport, &handle, &[]).await, json!([]));
}
