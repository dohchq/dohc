//! Collection reads through the real in-process daemon request path.

use dohc_engine_domain::{
    NoFaults, TxnOutcome, VersionedTextStore, WriteText, reconcile_collections_in_tx,
};
use dohc_engine_protocol::{
    transport::{EngineTransport, InProcessTransport, RequestContext},
    wire::{Request, WorkspaceHandle},
};
use dohc_engine_storage::EngineStore;
use dohc_engine_testkit::ScratchDir;
use dohc_workspace_engine::{EngineService, shadow_fence::write_shadow_marker_for_harness};
use serde_json::{Value, json};
use std::sync::Arc;

const TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const WORKSPACE_ID: &str = "ws-rpc-collections";
const RECORD_ID: &str = "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa";

fn seed_text(store: &mut EngineStore, path: &str, text: &str, sequence: i64) {
    VersionedTextStore::new(store)
        .write_text(
            &WriteText {
                workspace_id: WORKSPACE_ID.to_owned(),
                version_id: "main".to_owned(),
                object_id: format!("collection-object-{sequence}"),
                path: path.to_owned(),
                text: text.to_owned(),
                moment_id: format!("collection-moment-{sequence}"),
                metadata_origin: "test".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: sequence,
                request_id: None,
            },
            &NoFaults,
        )
        .expect("seed collection text");
}

fn seed_collection_state(scratch: &ScratchDir) {
    let db = scratch.engine_db_path().expect("engine db path");
    let mut store = EngineStore::open(&db, 1).expect("open store");
    store.bind_shadow_clone_token(TOKEN).expect("bind token");
    VersionedTextStore::new(&mut store)
        .ensure_main_version(WORKSPACE_ID, "main", 1, &NoFaults)
        .expect("main version");
    let schema = "fields: [";
    let record = format!("---\nid: {RECORD_ID}\nRaw: survives\n---\n");
    seed_text(&mut store, "broken/collection.yaml", schema, 2);
    seed_text(&mut store, "broken/record.md", &record, 3);
    let reconciled = store
        .write_with(&NoFaults, |tx| {
            reconcile_collections_in_tx(tx, WORKSPACE_ID, "main")
        })
        .expect("reconcile collection state");
    assert!(matches!(reconciled, TxnOutcome::Committed(_)));
    let collection_dir = scratch.path().join("broken");
    std::fs::create_dir_all(&collection_dir).expect("collection directory");
    std::fs::write(collection_dir.join("collection.yaml"), schema).expect("schema file");
    std::fs::write(collection_dir.join("record.md"), record).expect("record file");
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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn every_collection_request_answers_for_a_degraded_schema() {
    let scratch = ScratchDir::new().expect("scratch");
    write_shadow_marker_for_harness(scratch.path(), TOKEN).expect("marker");
    seed_collection_state(&scratch);
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

    let listed = call(&transport, &handle, 100, "collections.list", json!({})).await;

    assert_eq!(listed["collections"][0]["path"], json!("broken"));
    assert_eq!(listed["collections"][0]["status"], json!("degraded"));
    assert_eq!(
        listed["collections"][0]["reasons"][0]["code"],
        json!("invalid-yaml")
    );

    let collection = call(
        &transport,
        &handle,
        101,
        "collections.get",
        json!({ "collectionPath": "broken" }),
    )
    .await;
    assert_eq!(collection["status"], json!("degraded"));
    assert_eq!(collection["recordCount"], json!(1));

    let query = call(
        &transport,
        &handle,
        102,
        "collections.query",
        json!({
            "collectionPath": "broken",
            "groupBy": "Raw",
            "resolveRelations": true,
        }),
    )
    .await;
    assert_eq!(query["collection"]["status"], json!("degraded"));
    let raw_value = query["records"][0]["values"]
        .as_array()
        .expect("indexed values")
        .iter()
        .find(|value| value["field"] == "Raw")
        .expect("Raw indexed value");
    assert_eq!(raw_value["value"], json!("survives"));
    assert_eq!(raw_value["validation"]["status"], json!("untyped"));
    assert_eq!(query["groups"][0]["value"], json!("survives"));

    let record = call(
        &transport,
        &handle,
        103,
        "collections.getRecord",
        json!({
            "collectionPath": "broken",
            "recordId": RECORD_ID,
            "historyLimit": 10,
        }),
    )
    .await;
    assert_eq!(record["collection"]["status"], json!("degraded"));
    assert_eq!(record["record"]["id"], json!(RECORD_ID));
    assert_eq!(record["history"], json!([]));

    let named = call(
        &transport,
        &handle,
        104,
        "versions.createNamed",
        json!({
            "workspaceId": WORKSPACE_ID,
            "name": "collection-copy",
            "fromVersionId": "main",
        }),
    )
    .await;
    let named_id = named["id"].as_str().expect("named version id");
    call(
        &transport,
        &handle,
        105,
        "versions.setActive",
        json!({ "workspaceId": WORKSPACE_ID, "versionId": named_id }),
    )
    .await;
    let switched_list = call(&transport, &handle, 106, "collections.list", json!({})).await;
    assert_eq!(switched_list["collections"][0]["path"], json!("broken"));
    let switched_query = call(
        &transport,
        &handle,
        107,
        "collections.query",
        json!({ "collectionPath": "broken" }),
    )
    .await;
    assert_eq!(switched_query["records"][0]["id"], json!(RECORD_ID));
}
