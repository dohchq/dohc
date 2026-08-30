//! Collection reads through the real in-process daemon request path.

use base64::Engine as _;
use dohc_engine_collab::{ContentKind, Ydoc};
use dohc_engine_domain::{
    CaptureIngest, NoFaults, TxnOutcome, VersionedTextStore, reconcile_collections_in_tx,
};
use dohc_engine_protocol::{
    limits::WireLimits,
    transport::{
        EngineService as ProtocolEngineService, EngineTransport, InProcessTransport, RequestContext,
    },
    wire::{Envelope, Request, WorkspaceHandle, encode_control},
};
use dohc_engine_storage::EngineStore;
use dohc_engine_testkit::ScratchDir;
use dohc_workspace_engine::{EngineService, shadow_fence::write_shadow_marker_for_harness};
use serde_json::{Value, json};
use std::{fmt::Write as _, sync::Arc};

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

fn seed_schema(scratch: &ScratchDir, schema: &str) {
    let db = scratch.engine_db_path().expect("engine db path");
    let mut store = EngineStore::open(&db, 1).expect("open store");
    store.bind_shadow_clone_token(TOKEN).expect("bind token");
    VersionedTextStore::new(&mut store)
        .ensure_main_version(WORKSPACE_ID, "main", 1, &NoFaults)
        .expect("main version");
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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn collections_get_caps_schema_arrays_at_the_wire_collection_limit() {
    const SCHEMA_LIMIT: usize = WireLimits::SPIKE_DEFAULTS.max_collection_len as usize;
    let scratch = ScratchDir::new().expect("scratch");
    write_shadow_marker_for_harness(scratch.path(), TOKEN).expect("marker");
    let mut schema = String::from("fields:\n");
    for index in 0..=SCHEMA_LIMIT {
        writeln!(schema, "  field{index:05}:\n    type: text").expect("append field");
    }
    schema.push_str("views:\n");
    for index in 0..=SCHEMA_LIMIT {
        if index == 0 {
            writeln!(
                schema,
                "  - name: view00000\n    kind: table\n    groupBy: field{SCHEMA_LIMIT:05}"
            )
            .expect("append referenced view");
        } else {
            writeln!(schema, "  - name: view{index:05}\n    kind: table").expect("append view");
        }
    }
    seed_schema(&scratch, &schema);

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
    let response = transport
        .call(
            RequestContext::unbounded(),
            request(
                2,
                "collections.get",
                Some(handle),
                json!({ "collectionPath": "tasks" }),
            ),
        )
        .await
        .expect("get capped collection");
    let collection = &response.result;
    assert_eq!(collection["status"], "degraded");
    assert_eq!(
        collection["schema"]["fields"].as_array().map(Vec::len),
        Some(SCHEMA_LIMIT)
    );
    assert_eq!(
        collection["schema"]["views"].as_array().map(Vec::len),
        Some(SCHEMA_LIMIT)
    );
    assert_eq!(
        collection["schema"]["views"][0]["groupBy"],
        Value::Null,
        "views must be validated against the capped field set"
    );
    assert_eq!(
        collection["reasons"],
        json!([
            { "code": "schema-collection-limit-exceeded", "path": "/fields" },
            { "code": "unknown-field-reference", "path": "/views/0/groupBy" },
            { "code": "schema-collection-limit-exceeded", "path": "/views" },
        ])
    );
    encode_control(&Envelope::Response(response), &WireLimits::SPIKE_DEFAULTS)
        .expect("capped collection response must fit the wire collection limit");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn get_record_pages_all_history_past_the_per_request_limit() {
    const SEEDED_HISTORY: usize = 501;
    let scratch = ScratchDir::new().expect("scratch");
    write_shadow_marker_for_harness(scratch.path(), TOKEN).expect("marker");
    seed_collection_state(&scratch);

    let db = scratch.engine_db_path().expect("engine db path");
    let mut connection = rusqlite::Connection::open(&db).expect("open history database");
    let tx = connection.transaction().expect("begin history seed");
    for recorded_at_ms in 0..SEEDED_HISTORY as i64 {
        tx.execute(
            "INSERT INTO collection_field_history \
             (workspace_id,version_id,record_id,field_name,previous_value_json,\
              next_value_json,author_origin_id,recorded_at_ms) \
             VALUES (?1,'main',?2,'Raw',NULL,'\"next\"','origin',?3)",
            rusqlite::params![WORKSPACE_ID, RECORD_ID, recorded_at_ms],
        )
        .expect("seed history row");
    }
    tx.commit().expect("commit history seed");
    let expected_count = connection
        .query_row(
            "SELECT COUNT(*) FROM collection_field_history \
             WHERE workspace_id=?1 AND version_id='main' AND record_id=?2",
            rusqlite::params![WORKSPACE_ID, RECORD_ID],
            |row| row.get::<_, i64>(0),
        )
        .expect("count seeded history");
    let expected_count = usize::try_from(expected_count).expect("non-negative history count");
    assert!(expected_count > 500);
    drop(connection);

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

    let mut before_history_id = None;
    let mut history = Vec::new();
    for request_id in 100..104 {
        let mut params = json!({
            "collectionPath": "broken",
            "recordId": RECORD_ID,
            "historyLimit": 500,
        });
        if let Some(history_id) = before_history_id {
            params["beforeHistoryId"] = json!(history_id);
        }
        let page = call(
            &transport,
            &handle,
            request_id,
            "collections.getRecord",
            params,
        )
        .await;
        let page = page["history"].as_array().expect("history page");
        let Some(last) = page.last() else {
            break;
        };
        before_history_id = Some(last["historyId"].as_i64().expect("history cursor"));
        history.extend(page.iter().cloned());
    }

    assert_eq!(history.len(), expected_count);
    assert!(history.windows(2).all(|entries| {
        let left = (
            entries[0]["recordedAtMs"].as_i64().expect("left time"),
            entries[0]["historyId"].as_i64().expect("left id"),
        );
        let right = (
            entries[1]["recordedAtMs"].as_i64().expect("right time"),
            entries[1]["historyId"].as_i64().expect("right id"),
        );
        left > right
    }));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn capture_authored_record_edit_keeps_the_agent_in_field_history() {
    let scratch = ScratchDir::new().expect("scratch");
    write_shadow_marker_for_harness(scratch.path(), TOKEN).expect("marker");
    seed_schema(
        &scratch,
        "name: Tasks\nfields:\n  status:\n    type: text\n",
    );
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

    let pending = call(
        &transport,
        &handle,
        61,
        "collections.listPendingAdoptions",
        json!({}),
    )
    .await;
    let object_id = pending["adoptions"][0]["objectId"]
        .as_str()
        .expect("pending object id");
    let seed_markdown =
        std::fs::read_to_string(collection_dir.join("alpha.md")).expect("pending record Markdown");
    let opened = call(
        &transport,
        &handle,
        62,
        "ydoc.open",
        json!({
            "versionId": "main",
            "path": "tasks/alpha.md",
            "contentKind": "richdoc",
            "expectedObjectId": object_id,
        }),
    )
    .await;
    assert_eq!(opened["lineage"], json!("absent"));
    assert_eq!(opened["seedContent"], json!(seed_markdown));
    let seed_doc = Ydoc::wire();
    // This Rust-only history test uses the limited helper for its plain fixture.
    // Production adoption seeds through @dohc/ydoc-projection in the desktop.
    seed_doc
        .rewrite_content_to_markdown(ContentKind::Richdoc, &seed_markdown)
        .expect("seed simple rich-document fixture");
    call(
        &transport,
        &handle,
        63,
        "ydoc.recordUpdate",
        json!({
            "sessionId": opened["sessionId"],
            "updateBase64": base64::engine::general_purpose::STANDARD
                .encode(seed_doc.encode_full_state()),
            "seed": true,
        }),
    )
    .await;
    call(
        &transport,
        &handle,
        64,
        "ydoc.evict",
        json!({ "sessionId": opened["sessionId"] }),
    )
    .await;
    reconcile_capture(&transport, &handle, 65).await;
    assert!(
        std::fs::read_to_string(collection_dir.join("alpha.md"))
            .expect("adopted record")
            .contains(&record_id),
        "shared-imported lineage must finish the pending adoption"
    );

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
async fn capture_adopts_whitespace_delimited_frontmatter_without_losing_fields() {
    let scratch = ScratchDir::new().expect("scratch");
    write_shadow_marker_for_harness(scratch.path(), TOKEN).expect("marker");
    seed_schema(
        &scratch,
        "name: Tasks\nfields:\n  done:\n    type: checkbox\n  priority:\n    type: number\n  status:\n    type: text\n",
    );
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
    let original = b"--- \r\ndone: false\r\npriority: 3\r\nstatus: open\r\n---\t\r\n\r\nbody text";
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
    assert!(record["id"].as_str().is_some(), "adopted record id");
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
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn capture_adopts_eof_frontmatter_without_rewriting_structure() {
    let scratch = ScratchDir::new().expect("scratch");
    write_shadow_marker_for_harness(scratch.path(), TOKEN).expect("marker");
    seed_schema(
        &scratch,
        "name: Tasks\nfields:\n  done:\n    type: checkbox\n  priority:\n    type: number\n  status:\n    type: text\n",
    );
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

    let record_path = scratch.path().join("tasks/eof.md");
    let original = format!("---\nid: {RECORD_ID}\ndone: false\npriority: 3\nstatus: open\n---");
    std::fs::write(&record_path, original.as_bytes()).expect("EOF record file");
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
    assert_eq!(record["id"], json!(RECORD_ID));
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
    assert_eq!(
        std::fs::read(&record_path).expect("read adopted record"),
        original.as_bytes(),
        "adoption must preserve the delimiter at EOF without a trailing newline"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn capture_adoption_leaves_rich_markdown_unmodified_until_shared_import() {
    let scratch = ScratchDir::new().expect("scratch");
    write_shadow_marker_for_harness(scratch.path(), TOKEN).expect("marker");
    seed_schema(
        &scratch,
        "name: Tasks\nfields:\n  status:\n    type: text\n",
    );
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

    const BODY: &str = concat!(
        "| Metric | Value |\n",
        "| ------ | ----- |\n",
        "| apples | 10    |\n",
        "\n",
        "- parent\n",
        "  - nested with **bold** and [details](https://example.com)",
    );
    let original = format!("---\nstatus: open\n---\n\n{BODY}");
    let record_path = scratch.path().join("tasks/rich.md");
    std::fs::write(&record_path, &original).expect("rich Markdown record");

    reconcile_capture(&transport, &handle, 10).await;

    let query = call(
        &transport,
        &handle,
        40,
        "collections.query",
        json!({ "collectionPath": "tasks" }),
    )
    .await;
    let record_id = query["records"][0]["id"]
        .as_str()
        .expect("pending record id");
    let pending = call(
        &transport,
        &handle,
        41,
        "collections.listPendingAdoptions",
        json!({}),
    )
    .await;
    assert_eq!(pending["adoptions"][0]["recordId"], record_id);
    assert_eq!(pending["adoptions"][0]["filePath"], "tasks/rich.md");
    let settled = std::fs::read_to_string(&record_path).expect("pending rich Markdown record");

    assert_eq!(
        settled, original,
        "Rust capture must not run its limited Markdown grammar while the shared importer is pending"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn collection_larger_than_frame_cap_pages_completely_in_sorted_order() {
    const LARGE_FIELD_BYTES: usize = 3 * 1024 * 1024;
    const RECORDS: [(&str, &str, i64); 3] = [
        ("zeta.md", "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa", 2),
        ("alpha.md", "rec_bbbbbbbbbbbbbbbbbbbbbbbbbb", 1),
        ("beta.md", "rec_cccccccccccccccccccccccccc", 1),
    ];
    assert!(
        LARGE_FIELD_BYTES * RECORDS.len() > WireLimits::SPIKE_DEFAULTS.max_frame_bytes as usize,
        "the fixture must exceed one response frame"
    );

    let scratch = ScratchDir::new().expect("scratch");
    write_shadow_marker_for_harness(scratch.path(), TOKEN).expect("marker");
    let db = scratch.engine_db_path().expect("engine db path");
    let mut store = EngineStore::open(&db, 1).expect("open store");
    store.bind_shadow_clone_token(TOKEN).expect("bind token");
    VersionedTextStore::new(&mut store)
        .ensure_main_version(WORKSPACE_ID, "main", 1, &NoFaults)
        .expect("main version");
    let schema =
        "name: Large tasks\nfields:\n  rank:\n    type: number\n  notes:\n    type: text\n";
    seed_text(&mut store, "large/collection.yaml", schema, 2);
    let collection_dir = scratch.path().join("large");
    std::fs::create_dir_all(&collection_dir).expect("large collection directory");
    std::fs::write(collection_dir.join("collection.yaml"), schema).expect("schema file");
    let large_value = "x".repeat(LARGE_FIELD_BYTES);
    for (index, (filename, record_id, rank)) in RECORDS.iter().enumerate() {
        let record = format!("---\nid: {record_id}\nrank: {rank}\nnotes: {large_value}\n---\n");
        seed_text(
            &mut store,
            &format!("large/{filename}"),
            &record,
            3 + index as i64,
        );
        std::fs::write(collection_dir.join(filename), record).expect("large record file");
    }
    let reconciled = store
        .write_with(&NoFaults, |tx| {
            reconcile_collections_in_tx(tx, WORKSPACE_ID, "main")
        })
        .expect("reconcile large collection");
    assert!(matches!(reconciled, TxnOutcome::Committed(_)));
    drop(store);

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

    let mut cursor = Value::Null;
    let mut record_paths = Vec::new();
    for request_id in 100..104 {
        let mut params = json!({
            "collectionPath": "large",
            "sort": [{ "field": "rank", "direction": "asc" }],
            "limit": 1,
        });
        if !cursor.is_null() {
            params["cursor"] = cursor.clone();
        }
        let page = call(&transport, &handle, request_id, "collections.query", params).await;
        let records = page["records"].as_array().expect("record page");
        if records.is_empty() {
            break;
        }
        assert_eq!(records.len(), 1, "the requested page bound must be honored");
        record_paths.push(records[0]["path"].as_str().expect("record path").to_owned());
        cursor = page["nextCursor"].clone();
        if cursor.is_null() {
            break;
        }
    }

    assert_eq!(
        record_paths,
        vec!["large/alpha.md", "large/beta.md", "large/zeta.md"]
    );
    assert_eq!(
        record_paths
            .iter()
            .collect::<std::collections::HashSet<_>>()
            .len(),
        RECORDS.len(),
        "exclusive page boundaries must not duplicate records"
    );
    assert!(cursor.is_null(), "the final page must terminate the cursor");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unsafe_integer_round_trips_through_query_and_get_record_wire_results() {
    const UNSAFE_INTEGER: i64 = 9_007_199_254_740_993;
    let scratch = ScratchDir::new().expect("scratch");
    write_shadow_marker_for_harness(scratch.path(), TOKEN).expect("marker");
    let db = scratch.engine_db_path().expect("engine db path");
    let mut store = EngineStore::open(&db, 1).expect("open store");
    store.bind_shadow_clone_token(TOKEN).expect("bind token");
    VersionedTextStore::new(&mut store)
        .ensure_main_version(WORKSPACE_ID, "main", 1, &NoFaults)
        .expect("main version");
    let schema = "fields:\n  exact:\n    type: number\n";
    let record = format!("---\nid: {RECORD_ID}\nexact: {UNSAFE_INTEGER}\n---\n");
    seed_text(&mut store, "integers/collection.yaml", schema, 2);
    seed_text(&mut store, "integers/record.md", &record, 3);
    store
        .write_with(&NoFaults, |tx| {
            reconcile_collections_in_tx(tx, WORKSPACE_ID, "main")
        })
        .expect("reconcile unsafe integer collection");
    drop(store);
    let collection_dir = scratch.path().join("integers");
    std::fs::create_dir_all(&collection_dir).expect("collection directory");
    std::fs::write(collection_dir.join("collection.yaml"), schema).expect("schema file");
    std::fs::write(collection_dir.join("record.md"), record).expect("record file");

    let service = Arc::new(EngineService::new());
    let transport = InProcessTransport::new(Arc::clone(&service));
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

    for (id, method, params) in [
        (
            10,
            "collections.query",
            json!({ "collectionPath": "integers" }),
        ),
        (
            11,
            "collections.getRecord",
            json!({
                "collectionPath": "integers",
                "recordId": RECORD_ID,
                "historyLimit": 10,
            }),
        ),
    ] {
        let output = ProtocolEngineService::call(
            service.as_ref(),
            RequestContext::unbounded().with_capability("blobs"),
            request(id, method, Some(handle.clone()), params),
        )
        .await
        .unwrap_or_else(|error| panic!("{method} failed: {error:?}"));
        assert!(output.blob_egress.is_none());
        let record = if method == "collections.query" {
            &output.response.result["records"][0]
        } else {
            &output.response.result["record"]
        };
        let exact = record["values"]
            .as_array()
            .expect("record values")
            .iter()
            .find(|value| value["field"] == "exact")
            .expect("exact indexed value");
        assert_eq!(
            exact["value"],
            json!({ "$dohcInt64": UNSAFE_INTEGER.to_string() })
        );
        assert_eq!(exact["validation"]["status"], json!("valid"));
        encode_control(
            &Envelope::Response(output.response),
            &WireLimits::SPIKE_DEFAULTS,
        )
        .unwrap_or_else(|error| panic!("{method} response must encode: {error:?}"));
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn near_limit_record_round_trips_via_query_and_get_record_blob_egress() {
    const LARGE_FIELD_BYTES: usize = dohc_engine_domain::MAX_TEXT_BYTES - 1024;
    let scratch = ScratchDir::new().expect("scratch");
    write_shadow_marker_for_harness(scratch.path(), TOKEN).expect("marker");
    let db = scratch.engine_db_path().expect("engine db path");
    let mut store = EngineStore::open(&db, 1).expect("open store");
    store.bind_shadow_clone_token(TOKEN).expect("bind token");
    VersionedTextStore::new(&mut store)
        .ensure_main_version(WORKSPACE_ID, "main", 1, &NoFaults)
        .expect("main version");
    let schema = "fields:\n  notes:\n    type: text\n";
    let large_value = "x".repeat(LARGE_FIELD_BYTES);
    let record = format!("---\nid: {RECORD_ID}\nnotes: {large_value}\n---\n");
    assert!(record.len() < dohc_engine_domain::MAX_TEXT_BYTES);
    seed_text(&mut store, "near-limit/collection.yaml", schema, 2);
    seed_text(&mut store, "near-limit/record.md", &record, 3);
    store
        .write_with(&NoFaults, |tx| {
            reconcile_collections_in_tx(tx, WORKSPACE_ID, "main")
        })
        .expect("reconcile near-limit collection");
    drop(store);
    let collection_dir = scratch.path().join("near-limit");
    std::fs::create_dir_all(&collection_dir).expect("collection directory");
    std::fs::write(collection_dir.join("collection.yaml"), schema).expect("schema file");
    std::fs::write(collection_dir.join("record.md"), &record).expect("record file");

    let service = Arc::new(EngineService::new());
    let transport = InProcessTransport::new(Arc::clone(&service));
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

    for (id, method, params) in [
        (
            20,
            "collections.query",
            json!({ "collectionPath": "near-limit", "limit": 1 }),
        ),
        (
            21,
            "collections.getRecord",
            json!({
                "collectionPath": "near-limit",
                "recordId": RECORD_ID,
                "historyLimit": 10,
            }),
        ),
    ] {
        let refusal = ProtocolEngineService::call(
            service.as_ref(),
            RequestContext::unbounded(),
            request(id + 100, method, Some(handle.clone()), params.clone()),
        )
        .await
        .expect_err("an over-limit collection response without blobs must be refused");
        assert_eq!(
            refusal.code,
            dohc_engine_protocol::error::ErrorCode::LimitExceeded
        );
        assert_eq!(refusal.message, "collection-response-exceeds-wire-limit");

        let output = ProtocolEngineService::call(
            service.as_ref(),
            RequestContext::unbounded().with_capability("blobs"),
            request(id, method, Some(handle.clone()), params),
        )
        .await
        .unwrap_or_else(|error| panic!("{method} failed: {error:?}"));
        assert_eq!(output.response.result["collectionJson"], Value::Null);
        encode_control(
            &Envelope::Response(output.response.clone()),
            &WireLimits::SPIKE_DEFAULTS,
        )
        .unwrap_or_else(|error| panic!("{method} metadata must encode: {error:?}"));
        let egress = output
            .blob_egress
            .unwrap_or_else(|| panic!("{method} must return blob egress"));
        assert_eq!(egress.stream_id, id);
        assert_eq!(
            output.response.result["blobSha256"].as_str(),
            Some(egress.sha256.as_str())
        );
        assert_eq!(
            output.response.result["byteLength"].as_u64(),
            Some(egress.bytes.len() as u64)
        );
        let hydrated: Value =
            serde_json::from_slice(&egress.bytes).expect("blob-backed collection JSON");
        let hydrated_record = if method == "collections.query" {
            &hydrated["records"][0]
        } else {
            &hydrated["record"]
        };
        let notes = hydrated_record["values"]
            .as_array()
            .expect("record values")
            .iter()
            .find(|value| value["field"] == "notes")
            .expect("notes indexed value");
        assert_eq!(
            notes["value"].as_str().expect("notes text").len(),
            LARGE_FIELD_BYTES
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn collection_get_uses_blob_egress_only_above_inband_limit() {
    const RESPONSE_CAP: usize = WireLimits::SPIKE_DEFAULTS.max_frame_bytes as usize - 64 * 1024;
    let response_with_empty_description = json!({
        "path": "at-limit",
        "status": "valid",
        "reasons": [],
        "schema": {
            "name": Value::Null,
            "description": "",
            "fields": [],
            "views": [],
        },
        "recordCount": 0,
    });
    let response_overhead = serde_json::to_vec(&response_with_empty_description)
        .expect("serialize collection response skeleton")
        .len();
    let exact_description = "x".repeat(RESPONSE_CAP - response_overhead);
    let over_description = "x".repeat(RESPONSE_CAP - response_overhead + 1);
    let exact_schema = format!("description: {exact_description}\n");
    let over_schema = format!("description: {over_description}\n");
    assert!(exact_schema.len() < dohc_engine_domain::MAX_TEXT_BYTES);
    assert!(over_schema.len() < dohc_engine_domain::MAX_TEXT_BYTES);

    let scratch = ScratchDir::new().expect("scratch");
    write_shadow_marker_for_harness(scratch.path(), TOKEN).expect("marker");
    let db = scratch.engine_db_path().expect("engine db path");
    let mut store = EngineStore::open(&db, 1).expect("open store");
    store.bind_shadow_clone_token(TOKEN).expect("bind token");
    VersionedTextStore::new(&mut store)
        .ensure_main_version(WORKSPACE_ID, "main", 1, &NoFaults)
        .expect("main version");
    seed_text(&mut store, "at-limit/collection.yaml", &exact_schema, 2);
    seed_text(&mut store, "over-cap/collection.yaml", &over_schema, 3);
    store
        .write_with(&NoFaults, |tx| {
            reconcile_collections_in_tx(tx, WORKSPACE_ID, "main")
        })
        .expect("reconcile boundary collections");
    drop(store);
    for (path, schema) in [("at-limit", &exact_schema), ("over-cap", &over_schema)] {
        let collection_dir = scratch.path().join(path);
        std::fs::create_dir_all(&collection_dir).expect("collection directory");
        std::fs::write(collection_dir.join("collection.yaml"), schema).expect("schema file");
    }

    let service = Arc::new(EngineService::new());
    let transport = InProcessTransport::new(Arc::clone(&service));
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

    let exact = ProtocolEngineService::call(
        service.as_ref(),
        RequestContext::unbounded().with_capability("blobs"),
        request(
            10,
            "collections.get",
            Some(handle.clone()),
            json!({ "collectionPath": "at-limit" }),
        ),
    )
    .await
    .expect("exact-limit collection");
    assert!(exact.blob_egress.is_none());
    assert_eq!(
        serde_json::to_vec(&exact.response.result)
            .expect("serialize exact-limit response")
            .len(),
        RESPONSE_CAP
    );

    let refusal = ProtocolEngineService::call(
        service.as_ref(),
        RequestContext::unbounded(),
        request(
            11,
            "collections.get",
            Some(handle.clone()),
            json!({ "collectionPath": "over-cap" }),
        ),
    )
    .await
    .expect_err("an over-limit collection without blobs must be refused");
    assert_eq!(
        refusal.code,
        dohc_engine_protocol::error::ErrorCode::LimitExceeded
    );
    assert_eq!(refusal.message, "collection-response-exceeds-wire-limit");

    let over = ProtocolEngineService::call(
        service.as_ref(),
        RequestContext::unbounded().with_capability("blobs"),
        request(
            12,
            "collections.get",
            Some(handle),
            json!({ "collectionPath": "over-cap" }),
        ),
    )
    .await
    .expect("over-limit collection with blobs");
    assert_eq!(over.response.result["collectionJson"], Value::Null);
    let egress = over.blob_egress.expect("collection blob egress");
    assert_eq!(egress.stream_id, 12);
    assert_eq!(egress.bytes.len(), RESPONSE_CAP + 1);
    assert_eq!(
        over.response.result["blobSha256"].as_str(),
        Some(egress.sha256.as_str())
    );
    let hydrated: Value =
        serde_json::from_slice(&egress.bytes).expect("blob-backed collection JSON");
    assert_eq!(
        hydrated["schema"]["description"]
            .as_str()
            .expect("hydrated description")
            .len(),
        over_description.len()
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn collection_query_refuses_a_ninth_sort_clause() {
    let scratch = ScratchDir::new().expect("scratch");
    write_shadow_marker_for_harness(scratch.path(), TOKEN).expect("marker");
    seed_schema(&scratch, "fields:\n  title:\n    type: text\n");
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
    let sorts = (0..9)
        .map(|index| json!({ "field": format!("sort-{index}"), "direction": "asc" }))
        .collect::<Vec<_>>();
    let error = transport
        .call(
            RequestContext::unbounded(),
            request(
                2,
                "collections.query",
                Some(handle),
                json!({ "collectionPath": "tasks", "sort": sorts }),
            ),
        )
        .await
        .expect_err("a ninth sort clause must be refused");
    assert_eq!(
        error.code,
        dohc_engine_protocol::error::ErrorCode::InvalidParams
    );
    assert_eq!(error.message, "collection-query-sort-limit-exceeded");
}
