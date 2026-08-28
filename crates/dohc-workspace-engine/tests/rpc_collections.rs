//! Collection reads through the real in-process daemon request path.

use dohc_engine_domain::{
    CaptureIngest, NoFaults, TxnOutcome, VersionedTextStore, reconcile_collections_in_tx,
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
        .capture_ingest(
            &CaptureIngest {
                workspace_id: WORKSPACE_ID.to_owned(),
                version_id: "main".to_owned(),
                path: path.to_owned(),
                text: text.to_owned(),
                metadata_origin: dohc_engine_domain::store::CAPTURE_ORIGIN.to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: sequence,
                request_id: None,
                claim_foreign_head: false,
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

fn seed_valid_collection_schema(scratch: &ScratchDir) {
    let db = scratch.engine_db_path().expect("engine db path");
    let mut store = EngineStore::open(&db, 1).expect("open store");
    store.bind_shadow_clone_token(TOKEN).expect("bind token");
    VersionedTextStore::new(&mut store)
        .ensure_main_version(WORKSPACE_ID, "main", 1, &NoFaults)
        .expect("main version");
    let schema = "name: Tasks\nfields:\n  status:\n    type: text\n";
    seed_text(&mut store, "tasks/collection.yaml", schema, 2);
    let reconciled = store
        .write_with(&NoFaults, |tx| {
            reconcile_collections_in_tx(tx, WORKSPACE_ID, "main")
        })
        .expect("reconcile collection state");
    assert!(matches!(reconciled, TxnOutcome::Committed(_)));
    let collection_dir = scratch.path().join("tasks");
    std::fs::create_dir_all(&collection_dir).expect("collection directory");
    std::fs::write(collection_dir.join("collection.yaml"), schema).expect("schema file");
}

fn seed_crlf_collection_schema(scratch: &ScratchDir) {
    let db = scratch.engine_db_path().expect("engine db path");
    let mut store = EngineStore::open(&db, 1).expect("open store");
    store.bind_shadow_clone_token(TOKEN).expect("bind token");
    VersionedTextStore::new(&mut store)
        .ensure_main_version(WORKSPACE_ID, "main", 1, &NoFaults)
        .expect("main version");
    let schema = "name: Tasks\nfields:\n  done:\n    type: checkbox\n  priority:\n    type: number\n  status:\n    type: text\n";
    seed_text(&mut store, "tasks/collection.yaml", schema, 2);
    let reconciled = store
        .write_with(&NoFaults, |tx| {
            reconcile_collections_in_tx(tx, WORKSPACE_ID, "main")
        })
        .expect("reconcile collection state");
    assert!(matches!(reconciled, TxnOutcome::Committed(_)));
    let collection_dir = scratch.path().join("tasks");
    std::fs::create_dir_all(&collection_dir).expect("collection directory");
    std::fs::write(collection_dir.join("collection.yaml"), schema).expect("schema file");
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

async fn reconcile_capture(
    transport: &InProcessTransport<EngineService>,
    handle: &WorkspaceHandle,
    mut id: u64,
) {
    let mut status = call(transport, handle, id, "capture.reconcile", json!({})).await;
    for _ in 0..20 {
        if status["settled"] == json!(true) {
            return;
        }
        id += 1;
        status = call(transport, handle, id, "capture.flush", json!({})).await;
    }
    panic!("capture did not settle: {status}");
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

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn capture_authored_record_edit_keeps_the_agent_in_field_history() {
    let scratch = ScratchDir::new().expect("scratch");
    write_shadow_marker_for_harness(scratch.path(), TOKEN).expect("marker");
    seed_valid_collection_schema(&scratch);
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

    let collection_dir = scratch.path().join("tasks");
    let collections = call(&transport, &handle, 30, "collections.list", json!({})).await;
    assert_eq!(collections["collections"][0]["path"], json!("tasks"));

    std::fs::write(
        collection_dir.join("alpha.md"),
        "---\nstatus: open\n---\n\nAlpha",
    )
    .expect("record file");
    reconcile_capture(&transport, &handle, 40).await;
    let query = call(
        &transport,
        &handle,
        60,
        "collections.query",
        json!({ "collectionPath": "tasks" }),
    )
    .await;
    let record_id = query["records"][0]["id"]
        .as_str()
        .expect("adopted record id")
        .to_owned();

    let agent_id = "agent-collection-capture";
    call(
        &transport,
        &handle,
        61,
        "capture.setAuthor",
        json!({
            "author": {
                "kind": "agent",
                "agentId": agent_id,
                "onBehalfOf": "local",
                "agentRunId": "run-collection-capture",
            }
        }),
    )
    .await;
    let record_path = collection_dir.join("alpha.md");
    let edited = std::fs::read_to_string(&record_path)
        .expect("read adopted record")
        .replace("status: open", "status: done");
    std::fs::write(&record_path, edited).expect("agent edits record file");
    reconcile_capture(&transport, &handle, 70).await;

    let record = call(
        &transport,
        &handle,
        100,
        "collections.getRecord",
        json!({
            "collectionPath": "tasks",
            "recordId": record_id,
            "historyLimit": 20,
        }),
    )
    .await;
    let authored_edit = record["history"]
        .as_array()
        .expect("field history")
        .iter()
        .find(|entry| entry["field"] == json!("status") && entry["next"]["value"] == json!("done"))
        .expect("captured status edit in history");
    assert_eq!(authored_edit["authorOriginId"], json!(agent_id));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn capture_adopts_crlf_record_without_rewriting_its_frontmatter_shape() {
    let scratch = ScratchDir::new().expect("scratch");
    write_shadow_marker_for_harness(scratch.path(), TOKEN).expect("marker");
    seed_crlf_collection_schema(&scratch);
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

    let record_path = scratch.path().join("tasks/crlf.md");
    let original = b"---\r\ndone: false\r\npriority: 3\r\nstatus: open\r\n---\r\n\r\nbody text";
    std::fs::write(&record_path, original).expect("CRLF record file");
    reconcile_capture(&transport, &handle, 10).await;

    let query = call(
        &transport,
        &handle,
        40,
        "collections.query",
        json!({ "collectionPath": "tasks" }),
    )
    .await;
    let record = &query["records"][0];
    let record_id = record["id"].as_str().expect("adopted record id");
    for (field, expected) in [
        ("done", json!(false)),
        ("priority", json!(3)),
        ("status", json!("open")),
    ] {
        let value = record["values"]
            .as_array()
            .expect("indexed values")
            .iter()
            .find(|value| value["field"] == field)
            .unwrap_or_else(|| panic!("missing indexed field {field}"));
        assert_eq!(value["value"], expected, "typed value for {field}");
        assert_eq!(value["validation"]["status"], json!("valid"), "{field}");
    }

    let expected = format!(
        "---\r\ndone: false\r\nid: {record_id}\r\npriority: 3\r\nstatus: open\r\n---\r\n\r\nbody text"
    );
    assert_eq!(
        std::fs::read(&record_path).expect("adopted record bytes"),
        expected.as_bytes(),
        "adoption may insert the id but must retain the CRLF byte shape"
    );
}
