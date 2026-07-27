//! Release gate for the desktop Y.Doc cutover.
//!
//! `apps/desktop/src/collab/ydocReplayParityGoldens.test.ts` authors real yjs
//! v1 update streams and computes normalized semantic-content goldens. This
//! test feeds those exact bytes, in their deliberately non-authored replay
//! order, through the daemon's production `ydoc.open` → `ydoc.recordUpdate` →
//! durable yrs reconstruction → `ydoc.resync` path and compares the resulting
//! typed-root state against the yjs oracle.

use base64::Engine as _;
use dohc_engine_collab::Ydoc;
use dohc_engine_protocol::{
    transport::{EngineTransport, InProcessTransport, RequestContext},
    wire::{Request, WorkspaceHandle},
};
use dohc_engine_testkit::ScratchDir;
use dohc_workspace_engine::{EngineService, shadow_fence::write_shadow_marker_for_harness};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use std::{collections::BTreeMap, sync::Arc};

const TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const FIXTURES: &str = include_str!("../../../tools/rust-engine-program/ydoc-replay-fixtures.json");
const GOLDENS: &str = include_str!("../../../tools/rust-engine-program/ydoc-replay-goldens.json");

#[derive(Debug, Deserialize)]
struct FixtureCorpus {
    scenarios: Vec<Scenario>,
}

#[derive(Debug, Deserialize)]
struct Scenario {
    name: String,
    #[serde(rename = "contentKind")]
    content_kind: String,
    dimensions: Vec<String>,
    #[serde(rename = "authoredUpdates")]
    authored_updates: Vec<AuthoredUpdate>,
    #[serde(rename = "replayOrder")]
    replay_order: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct AuthoredUpdate {
    id: String,
    author: String,
    #[serde(rename = "updateBase64")]
    update_base64: String,
}

#[derive(Debug, Deserialize)]
struct GoldenCorpus {
    scenarios: BTreeMap<String, Value>,
}

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

async fn open_workspace(
    transport: &InProcessTransport<EngineService>,
    scratch: &ScratchDir,
    workspace_id: &str,
) -> WorkspaceHandle {
    let opened = transport
        .call(
            RequestContext::unbounded(),
            request(
                1,
                "workspace.open",
                None,
                json!({
                    "rootDir": scratch.path().to_string_lossy(),
                    "workspaceId": workspace_id,
                }),
            ),
        )
        .await
        .expect("workspace.open");
    serde_json::from_value(opened.result["workspace"].clone()).expect("workspace handle")
}

async fn call(
    transport: &InProcessTransport<EngineService>,
    handle: &WorkspaceHandle,
    id: u64,
    method: &str,
    params: Value,
) -> Value {
    transport
        .call(
            RequestContext::unbounded(),
            request(id, method, Some(handle.clone()), params),
        )
        .await
        .unwrap_or_else(|error| panic!("{method} failed: {error:?}"))
        .result
}

/// Replay one scenario through the real daemon Y.Doc surface and return the
/// semantic state reconstructed from the daemon's yrs full-state resync.
async fn replay_through_engine(scenario: &Scenario, ordinal: usize) -> Value {
    assert!(
        !scenario.dimensions.is_empty(),
        "{} must declare coverage dimensions",
        scenario.name
    );
    assert_ne!(
        scenario.replay_order,
        scenario
            .authored_updates
            .iter()
            .map(|update| update.id.clone())
            .collect::<Vec<_>>(),
        "{} must actually replay in a non-authored order",
        scenario.name
    );

    let scratch = ScratchDir::new().expect("scratch");
    write_shadow_marker_for_harness(scratch.path(), TOKEN).expect("shadow marker");
    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let handle = open_workspace(
        &transport,
        &scratch,
        &format!("ydoc-replay-parity-{ordinal}"),
    )
    .await;
    let opened = call(
        &transport,
        &handle,
        2,
        "ydoc.open",
        json!({
            "versionId": "main",
            "path": format!("parity/{ordinal}.md"),
            "contentKind": scenario.content_kind,
        }),
    )
    .await;
    assert_eq!(
        opened["lineage"],
        json!("absent"),
        "{} must start from an empty engine lineage",
        scenario.name
    );
    let session_id = opened["sessionId"].as_str().expect("session id");
    let updates: BTreeMap<&str, &AuthoredUpdate> = scenario
        .authored_updates
        .iter()
        .map(|update| (update.id.as_str(), update))
        .collect();
    assert_eq!(
        updates.len(),
        scenario.authored_updates.len(),
        "{} has duplicate authored update ids",
        scenario.name
    );

    let mut request_id = 3_u64;
    for update_id in &scenario.replay_order {
        let update = updates
            .get(update_id.as_str())
            .unwrap_or_else(|| panic!("{} references unknown update {update_id}", scenario.name));
        let recorded = call(
            &transport,
            &handle,
            request_id,
            "ydoc.recordUpdate",
            json!({
                "sessionId": session_id,
                "updateBase64": update.update_base64,
                "actorOriginId": update.author,
            }),
        )
        .await;
        assert_eq!(
            recorded["deduped"],
            json!(false),
            "{} update {} unexpectedly deduped",
            scenario.name,
            update.id
        );
        request_id += 1;
    }
    assert_eq!(
        scenario.replay_order.len(),
        scenario.authored_updates.len(),
        "{} must replay every authored update exactly once",
        scenario.name
    );

    let resynced = call(
        &transport,
        &handle,
        request_id,
        "ydoc.resync",
        json!({ "sessionId": session_id }),
    )
    .await;
    let state = base64::engine::general_purpose::STANDARD
        .decode(
            resynced["initialUpdateBase64"]
                .as_str()
                .expect("resync full-state update"),
        )
        .expect("resync base64");
    let replayed = Ydoc::wire();
    replayed
        .apply(&state)
        .unwrap_or_else(|error| panic!("{} resync state failed to apply: {error}", scenario.name));
    normalize(replayed.canonical_content())
}

/// Normalize identically to the TypeScript emitter:
///
/// - recursively sort JSON/map keys;
/// - remove empty `attrs` objects;
/// - merge adjacent string delta runs carrying identical attributes.
fn normalize(value: Value) -> Value {
    match value {
        Value::Array(values) => Value::Array(values.into_iter().map(normalize).collect()),
        Value::Object(values) => {
            let mut sorted = BTreeMap::new();
            for (key, value) in values {
                let value = normalize(value);
                if key == "attrs" && value.as_object().is_some_and(Map::is_empty) {
                    continue;
                }
                sorted.insert(key, value);
            }
            let mut normalized: Map<String, Value> = sorted.into_iter().collect();
            if let Some(delta) = normalized.get_mut("delta").and_then(Value::as_array_mut) {
                *delta = merge_delta_runs(std::mem::take(delta));
            }
            Value::Object(normalized)
        }
        scalar => scalar,
    }
}

fn merge_delta_runs(delta: Vec<Value>) -> Vec<Value> {
    let mut merged: Vec<Value> = Vec::with_capacity(delta.len());
    for item in delta {
        let can_merge = merged
            .last()
            .and_then(Value::as_object)
            .zip(item.as_object())
            .is_some_and(|(previous, current)| {
                previous.get("insert").and_then(Value::as_str).is_some()
                    && current.get("insert").and_then(Value::as_str).is_some()
                    && previous.get("attrs").unwrap_or(&Value::Null)
                        == current.get("attrs").unwrap_or(&Value::Null)
            });
        if can_merge {
            let suffix = item
                .get("insert")
                .and_then(Value::as_str)
                .expect("checked string insert");
            let previous = merged
                .last_mut()
                .and_then(Value::as_object_mut)
                .expect("checked delta object");
            let insert = previous
                .get_mut("insert")
                .and_then(|value| value.as_str())
                .expect("checked previous string insert");
            let mut joined = String::with_capacity(insert.len() + suffix.len());
            joined.push_str(insert);
            joined.push_str(suffix);
            previous.insert("insert".to_owned(), Value::String(joined));
        } else {
            merged.push(item);
        }
    }
    merged
}

fn compare_to_golden(scenario: &str, actual: &Value, expected: &Value) -> Result<(), String> {
    let actual = normalize(actual.clone());
    let expected = normalize(expected.clone());
    if actual == expected {
        return Ok(());
    }
    let actual_json = serde_json::to_string(&actual).expect("actual json");
    let expected_json = serde_json::to_string(&expected).expect("expected json");
    let divergence = actual_json
        .chars()
        .zip(expected_json.chars())
        .position(|(actual, expected)| actual != expected)
        .unwrap_or_else(|| {
            actual_json
                .chars()
                .count()
                .min(expected_json.chars().count())
        });
    let from = divergence.saturating_sub(100);
    let actual_context: String = actual_json.chars().skip(from).take(280).collect();
    let expected_context: String = expected_json.chars().skip(from).take(280).collect();
    Err(format!(
        "{scenario} diverged at normalized JSON character {divergence}\n\
         actual:   ...{}\n\
         expected: ...{}",
        actual_context, expected_context,
    ))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn daemon_yrs_replay_matches_yjs_goldens() {
    let fixtures: FixtureCorpus = serde_json::from_str(FIXTURES).expect("fixture corpus");
    let goldens: GoldenCorpus = serde_json::from_str(GOLDENS).expect("golden corpus");
    assert_eq!(
        fixtures.scenarios.len(),
        goldens.scenarios.len(),
        "every fixture must have exactly one golden"
    );
    assert!(
        fixtures.scenarios.len() >= 5,
        "the release corpus must retain all required dimensions"
    );

    for (ordinal, scenario) in fixtures.scenarios.iter().enumerate() {
        let expected = goldens
            .scenarios
            .get(&scenario.name)
            .unwrap_or_else(|| panic!("missing golden for {}", scenario.name));
        let actual = replay_through_engine(scenario, ordinal).await;
        compare_to_golden(&scenario.name, &actual, expected)
            .unwrap_or_else(|difference| panic!("{difference}"));
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn tampered_yjs_golden_is_rejected_by_the_real_comparator() {
    let fixtures: FixtureCorpus = serde_json::from_str(FIXTURES).expect("fixture corpus");
    let goldens: GoldenCorpus = serde_json::from_str(GOLDENS).expect("golden corpus");
    let scenario = fixtures
        .scenarios
        .first()
        .expect("at least one replay scenario");
    let actual = replay_through_engine(scenario, 10_000).await;
    let committed = goldens
        .scenarios
        .get(&scenario.name)
        .expect("committed golden");
    compare_to_golden(&scenario.name, &actual, committed).expect("untampered control must match");

    let mut tampered = committed.clone();
    tampered["plainText"]["delta"][0]["insert"] =
        Value::String("TAMPERED: the comparator must observe this".to_owned());
    let mismatch = compare_to_golden(&scenario.name, &actual, &tampered)
        .expect_err("a mutated visible-content golden must fail the parity comparison");
    assert!(
        mismatch.contains(&scenario.name) && mismatch.contains("diverged"),
        "tamper failure must identify the scenario and divergence: {mismatch}"
    );
}
