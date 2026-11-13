//! Collection reads through the real in-process daemon request path.

use crate::common;

use base64::Engine as _;
use common::*;
use dohc_engine_collab::{
    BaseRelayCoordinate, ClaimOutcome, ContentKind, DocKey, Ydoc, claim_base_at_relay,
};
use dohc_engine_domain::{
    AutomationChangeKind, AutomationSubscription, CaptureIngest, NoFaults, TxnOutcome,
    VersionedTextStore, reconcile_collections_in_tx, set_collection_adoption_state_in_tx,
    subscribe_automation_in_tx,
};
use dohc_engine_protocol::{
    error::ErrorCode,
    transport::{EngineService as ProtocolEngineService, InProcessTransport, RequestContext},
    wire::WorkspaceHandle,
};
use dohc_engine_storage::{EngineStore, hex_sha256};
use dohc_engine_sync::{
    AlwaysLive, ApplyDisposition, ApplyOutcome, NoLiveLeases, ReplicationEnvelope,
    apply_replication_envelope, apply_ydoc_envelope,
};
use dohc_engine_testkit::{ScratchDir, engine_db_path};
use dohc_workspace_engine::{
    AUTOMATION_CLAIMED_EVENT, EngineEventNotice, EngineService, RECORD_CREATED_EVENT,
    RECORD_FIELD_CHANGED_EVENT, RECORD_UPDATED_EVENT, root_binding::write_root_binding,
};
use serde_json::{Value, json};
use std::sync::Arc;

const WORKSPACE_ID: &str = "ws-rpc-collections";
const RECORD_ID: &str = "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa";

async fn expect_projection_commit(
    notices: &mut tokio::sync::mpsc::Receiver<EngineEventNotice>,
    path: &str,
) {
    tokio::time::timeout(std::time::Duration::from_secs(120), async {
        loop {
            let notice = notices.recv().await.unwrap();
            assert_ne!(notice.name, AUTOMATION_CLAIMED_EVENT);
            if notice.name == dohc_workspace_engine::COLLECTIONS_PROJECTED_EVENT
                && notice.payload["paths"]
                    .as_array()
                    .is_some_and(|paths| paths.contains(&json!(path)))
            {
                break;
            }
        }
    })
    .await
    .expect("projection commit event");
}

#[tokio::test]
async fn received_collection_projection_follows_local_definition_writes_and_announces_commit() {
    let scratch = ScratchDir::new().unwrap();
    let service = Arc::new(EngineService::new());
    let mut notices = service.events().subscribe();
    let transport = InProcessTransport::new(service);
    let opened = call_with_busy_retry(
        &transport,
        RequestContext::unbounded(),
        request(
            1,
            "workspace.open",
            None,
            json!({ "rootDir": scratch.path().to_string_lossy(), "workspaceId": WORKSPACE_ID,
            "captureMode": "none", "projectCollections": true }),
        ),
    )
    .await
    .unwrap();
    let handle: WorkspaceHandle =
        serde_json::from_value(opened.result["workspace"].clone()).unwrap();
    call(
        &transport,
        &handle,
        2,
        "versions.ensureMain",
        json!({ "workspaceId": WORKSPACE_ID }),
    )
    .await;
    let db = engine_db_path(&scratch).unwrap();
    let mut connection = rusqlite::Connection::open(&db).unwrap();
    connection
        .execute(
            "INSERT INTO share_view_cursors (workspace_id,share_id,cursor) VALUES (?1,'share','0')",
            [WORKSPACE_ID],
        )
        .unwrap();
    let tx = connection.transaction().unwrap();
    subscribe_automation_in_tx(
        &tx,
        WORKSPACE_ID,
        &AutomationSubscription {
            automation_id: "collection:tasks#stamp".to_owned(),
            prefix: "tasks".to_owned(),
            kinds: vec![AutomationChangeKind::Added, AutomationChangeKind::Changed],
            fields: None,
        },
        1,
    )
    .unwrap();
    tx.commit().unwrap();
    drop(connection);
    for (id, path, text) in [
        (
            3,
            "tasks/collection.yaml",
            "name: Tasks\nfields:\n  Title:\n    type: text\n".to_owned(),
        ),
        (
            4,
            "tasks/a.md",
            format!("---\nid: {RECORD_ID}\nTitle: First\n---\n"),
        ),
        (
            5,
            "tasks/collection.yaml",
            "name: Tasks\nfields:\n  Title:\n    type: text\n  Note:\n    type: text\n".to_owned(),
        ),
        (
            6,
            "tasks/a.md",
            format!("---\nid: {RECORD_ID}\nTitle: Second\n---\n"),
        ),
    ] {
        call(
            &transport,
            &handle,
            id,
            "versionedText.write",
            json!({ "workspaceId": WORKSPACE_ID,
            "versionId": "main", "path": path, "text": text, "origin": "local-file" }),
        )
        .await;
        expect_projection_commit(&mut notices, path).await;
    }
    let listed = call(&transport, &handle, 7, "collections.list", json!({})).await;
    assert_eq!(listed["collections"][0]["path"], json!("tasks"));
    let details = call(
        &transport,
        &handle,
        8,
        "collections.get",
        json!({ "collectionPath": "tasks" }),
    )
    .await;
    assert_eq!(details["schema"]["fields"].as_array().unwrap().len(), 2);
    let queried = call(
        &transport,
        &handle,
        9,
        "collections.query",
        json!({ "collectionPath": "tasks" }),
    )
    .await;
    assert_eq!(queried["records"].as_array().unwrap().len(), 1);
    let record_path = scratch.path().join("tasks/a.md");
    std::fs::create_dir_all(record_path.parent().unwrap()).unwrap();
    let refusal = call_error(
        &transport,
        &handle,
        10,
        "ydoc.open",
        json!({
            "versionId": "main", "path": "tasks/a.md", "contentKind": "richdoc",
        }),
    )
    .await;
    assert_eq!(refusal.code, ErrorCode::Forbidden);
    assert_eq!(
        refusal.message,
        "received shares do not open live document sessions"
    );
    // Received writes still update the table after the live-session refusal.
    std::fs::write(
        &record_path,
        format!("---\nid: {RECORD_ID}\nTitle: Fourth\n---\n"),
    )
    .unwrap();
    call(
        &transport,
        &handle,
        14,
        "versionedText.write",
        json!({
            "workspaceId": WORKSPACE_ID, "versionId": "main", "path": "tasks/a.md",
            "text": format!("---\nid: {RECORD_ID}\nTitle: Fourth\n---\n"), "origin": "local-file",
        }),
    )
    .await;
    expect_projection_commit(&mut notices, "tasks/a.md").await;
    let queried = call(
        &transport,
        &handle,
        15,
        "collections.query",
        json!({ "collectionPath": "tasks" }),
    )
    .await;
    let title = queried["records"][0]["values"]
        .as_array()
        .unwrap()
        .iter()
        .find(|value| value["field"] == "Title")
        .unwrap();
    assert_eq!(title["value"], json!("Fourth"));
    let connection = rusqlite::Connection::open(&db).unwrap();
    for table in ["automation_claims", "collection_field_history"] {
        assert_eq!(
            connection
                .query_row(&format!("SELECT count(*) FROM {table}"), [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            0,
            "recipient writes created {table}"
        );
    }
    drop(connection);
    call(&transport, &handle, 16, "workspace.close", json!({})).await;
    let connection = rusqlite::Connection::open(&db).unwrap();
    for table in ["automation_claims", "collection_field_history"] {
        let count: i64 = connection
            .query_row(&format!("SELECT count(*) FROM {table}"), [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(count, 0, "recipient writes created {table}");
    }
}

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
    let db = engine_db_path(scratch).expect("engine db path");
    let mut store = EngineStore::open(&db, 1).expect("open store");
    store.bind_root_token(TOKEN, &NoFaults).expect("bind token");
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
    let db = engine_db_path(scratch).expect("engine db path");
    let mut store = EngineStore::open(&db, 1).expect("open store");
    store.bind_root_token(TOKEN, &NoFaults).expect("bind token");
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

async fn call_ydoc_with_blob(
    service: &EngineService,
    handle: &WorkspaceHandle,
    id: u64,
    method: &str,
    params: Value,
) -> (Value, Vec<u8>) {
    let output = service_call_with_busy_retry(
        service,
        RequestContext::unbounded().with_capability("blobs"),
        request(id, method, Some(handle.clone()), params),
    )
    .await
    .unwrap_or_else(|error| panic!("{method} failed: {error:?}"));
    let blob = output
        .blob_egress
        .unwrap_or_else(|| panic!("{method} did not return Y.Doc state"));
    (output.response.result, blob.bytes)
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
    write_root_binding(scratch.path(), TOKEN).expect("root binding");
    seed_collection_state(&scratch);
    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let opened = call_with_busy_retry(
        &transport,
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
async fn an_automation_write_names_its_run_in_record_history() {
    let scratch = ScratchDir::new().expect("scratch");
    write_root_binding(scratch.path(), TOKEN).expect("root binding");
    seed_schema(
        &scratch,
        "name: Tasks\nfields:\n  status:\n    type: text\n",
    );
    let markdown = format!("---\nid: {RECORD_ID}\nstatus: open\n---\n\nAlpha\n");
    let db = engine_db_path(&scratch).expect("engine db path");
    let mut store = EngineStore::open(&db, 1).expect("open store");
    store.bind_root_token(TOKEN, &NoFaults).expect("bind token");
    seed_text(&mut store, "tasks/alpha.md", &markdown, 3);
    store
        .write_with(&NoFaults, |tx| {
            reconcile_collections_in_tx(tx, WORKSPACE_ID, "main")?;
            set_collection_adoption_state_in_tx(
                tx,
                WORKSPACE_ID,
                "main",
                "tasks/alpha.md",
                RECORD_ID,
                "adopted",
            )
        })
        .expect("bind adopted collection record");
    drop(store);
    std::fs::write(scratch.path().join("tasks/alpha.md"), &markdown).expect("record file");

    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let opened = call_with_busy_retry(
        &transport,
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
    let session = call(
        &transport,
        &handle,
        10,
        "ydoc.open",
        json!({
            "versionId": "main",
            "path": "tasks/alpha.md",
            "contentKind": "richdoc",
        }),
    )
    .await;
    let doc = Ydoc::wire();
    doc.rewrite_content_to_markdown(ContentKind::Richdoc, &markdown)
        .expect("seed rich document");
    call(
        &transport,
        &handle,
        11,
        "ydoc.recordUpdate",
        json!({
            "expectedLineageClaimId": session["lineageClaimId"],
            "sessionId": session["sessionId"],
            "updateBase64": base64::engine::general_purpose::STANDARD
                .encode(doc.encode_full_state()),
            "seed": true,
        }),
    )
    .await;
    let automation_id = "collection:tasks-id#stamp";
    let run = json!({ "claimId": "atc_stamp_1", "automationName": "Stamp the finish date" });
    let record_update = |id: u64, field: &str, value: &str, attribution: Value| {
        let update = doc
            .frontmatter_set(field, value)
            .expect("frontmatter update");
        let transport = &transport;
        let handle = &handle;
        let session_id = session["sessionId"].clone();
        async move {
            call(
                transport,
                handle,
                id,
                "ydoc.recordUpdate",
                json!({
                    "expectedLineageClaimId": null,
                    "sessionId": session_id,
                    "updateBase64": base64::engine::general_purpose::STANDARD.encode(update),
                    "actorOriginId": automation_id,
                    "attribution": attribution,
                }),
            )
            .await
        }
    };
    record_update(
        12,
        "status",
        "done",
        json!({ "actorKind": "automation", "onBehalfOf": "local", "depth": 1, "run": run }),
    )
    .await;
    // An automation write recorded without its run names none.
    record_update(
        13,
        "owner",
        "ice",
        json!({ "actorKind": "automation", "onBehalfOf": "local", "depth": 1 }),
    )
    .await;
    // Only an automation's write names a run, and an unbounded one refuses.
    for (id, attribution) in [
        (
            14,
            json!({ "actorKind": "agent", "onBehalfOf": "local", "depth": 0, "run": run }),
        ),
        (
            15,
            json!({ "actorKind": "automation", "depth": 1, "run": { "claimId": "", "automationName": "Stamp" } }),
        ),
        (
            16,
            json!({ "actorKind": "automation", "depth": 1, "run": { "claimId": "atc", "automationName": " " } }),
        ),
        (
            17,
            json!({ "actorKind": "automation", "depth": 1, "run": { "claimId": "atc", "automationName": "Stamp", "extra": true } }),
        ),
    ] {
        let update = doc
            .frontmatter_set("note", "refused")
            .expect("frontmatter update");
        let refused = call_error(
            &transport,
            &handle,
            id,
            "ydoc.recordUpdate",
            json!({
                "expectedLineageClaimId": session["lineageClaimId"],
                "sessionId": session["sessionId"],
                "updateBase64": base64::engine::general_purpose::STANDARD.encode(update),
                "actorOriginId": automation_id,
                "attribution": attribution,
            }),
        )
        .await;
        assert_eq!(refused.code, ErrorCode::InvalidParams, "{refused:?}");
    }
    // Settling writes the record file; its capture keeps the run on the change.
    call(
        &transport,
        &handle,
        18,
        "ydoc.close",
        json!({ "sessionId": session["sessionId"] }),
    )
    .await;
    reconcile_capture(&transport, &handle, 19).await;
    let settled =
        std::fs::read_to_string(scratch.path().join("tasks/alpha.md")).expect("settled record");
    assert!(
        settled.contains("status: done"),
        "settled artifact: {settled}"
    );

    let record = call(
        &transport,
        &handle,
        20,
        "collections.getRecord",
        json!({
            "collectionPath": "tasks",
            "recordId": RECORD_ID,
            "historyLimit": 20,
        }),
    )
    .await;
    let history = record["history"].as_array().expect("history");
    let stamped = history
        .iter()
        .find(|entry| entry["field"] == json!("status") && entry["next"]["value"] == json!("done"))
        .expect("the automation's status write");
    assert_eq!(stamped["authorOriginId"], json!(automation_id));
    assert_eq!(stamped["actorKind"], json!("automation"));
    assert_eq!(stamped["depth"], json!(1));
    assert_eq!(stamped["automationRun"], run);
    assert_eq!(
        history
            .iter()
            .filter(|entry| {
                entry["field"] == json!("status") && entry["next"]["value"] == json!("done")
            })
            .count(),
        1,
        "the settled file's capture records the change once: {history:?}"
    );
    let unnamed = history
        .iter()
        .find(|entry| entry["field"] == json!("owner"))
        .expect("the write without its run");
    assert_eq!(unnamed["actorKind"], json!("automation"));
    assert_eq!(unnamed["automationRun"], Value::Null);
    assert!(
        history.iter().all(|entry| entry["field"] != json!("note")),
        "a refused attribution writes no history: {history:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn overdepth_sort_values_page_without_gaps_or_duplicates() {
    const RECORDS: [(&str, &str, &str); 3] = [
        ("zeta.md", "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa", "charlie"),
        ("alpha.md", "rec_bbbbbbbbbbbbbbbbbbbbbbbbbb", "alpha"),
        ("beta.md", "rec_cccccccccccccccccccccccccc", "bravo"),
    ];

    let scratch = ScratchDir::new().expect("scratch");
    write_root_binding(scratch.path(), TOKEN).expect("root binding");
    let db = engine_db_path(&scratch).expect("engine db path");
    let mut store = EngineStore::open(&db, 1).expect("open store");
    store.bind_root_token(TOKEN, &NoFaults).expect("bind token");
    VersionedTextStore::new(&mut store)
        .ensure_main_version(WORKSPACE_ID, "main", 1, &NoFaults)
        .expect("main version");
    let schema = "name: Deep values\n";
    seed_text(&mut store, "depth/collection.yaml", schema, 2);
    let collection_dir = scratch.path().join("depth");
    std::fs::create_dir_all(&collection_dir).expect("depth collection directory");
    std::fs::write(collection_dir.join("collection.yaml"), schema).expect("schema file");
    for (index, (filename, record_id, leaf)) in RECORDS.iter().enumerate() {
        let overdepth = format!("{}\"{leaf}\"{}", "[".repeat(24), "]".repeat(24));
        let record = format!("---\nid: {record_id}\ndeep: {overdepth}\n---\n");
        seed_text(
            &mut store,
            &format!("depth/{filename}"),
            &record,
            3 + index as i64,
        );
        std::fs::write(collection_dir.join(filename), record).expect("depth record file");
    }
    let reconciled = store
        .write_with(&NoFaults, |tx| {
            reconcile_collections_in_tx(tx, WORKSPACE_ID, "main")
        })
        .expect("reconcile depth collection");
    assert!(matches!(reconciled, TxnOutcome::Committed(_)));
    drop(store);

    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let opened = call_with_busy_retry(
        &transport,
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
    for request_id in 100..100 + RECORDS.len() as u64 {
        let mut params = json!({
            "collectionPath": "depth",
            "sort": [{ "field": "deep", "direction": "asc" }],
            "limit": 1,
        });
        if !cursor.is_null() {
            params["cursor"] = cursor.clone();
        }
        let page = call(&transport, &handle, request_id, "collections.query", params).await;
        let records = page["records"].as_array().expect("record page");
        assert_eq!(records.len(), 1, "each page must contain one record");
        let record = &records[0];
        let deep = record["values"]
            .as_array()
            .expect("record values")
            .iter()
            .find(|value| value["field"] == "deep")
            .expect("deep indexed value");
        assert_eq!(
            deep["validation"],
            json!({
                "status": "flagged",
                "reason": { "code": "value-depth-exceeded", "path": "" }
            }),
            "the sort fixture must exercise an over-depth flagged value"
        );
        record_paths.push(record["path"].as_str().expect("record path").to_owned());
        cursor = page["nextCursor"].clone();
        if !cursor.is_null() {
            assert_eq!(
                cursor["sortValues"],
                json!([{ "present": false, "value": null }]),
                "an over-depth sort key must not enter the continuation frame"
            );
            assert_eq!(cursor["recordPath"], record["path"]);
            assert_eq!(cursor["recordId"], record["id"]);
        }
    }

    assert_eq!(
        record_paths
            .iter()
            .collect::<std::collections::HashSet<_>>()
            .len(),
        RECORDS.len(),
        "exclusive page boundaries must not duplicate records"
    );
    assert_eq!(
        record_paths,
        vec!["depth/alpha.md", "depth/beta.md", "depth/zeta.md"],
        "sorted pagination must not leave gaps"
    );
    assert!(cursor.is_null(), "the final page must terminate the cursor");
}

/// Harness: an adopted, replicated collection record whose one synced
/// `status` update is durably parked behind the live session's lease, with an
/// automation subscribed to the collection so the drain's no-claim rule
/// (ADR 0008) is observable.
struct ParkedRecordUpdate {
    scratch: ScratchDir,
    service: Arc<EngineService>,
    transport: InProcessTransport<EngineService>,
    handle: WorkspaceHandle,
    live_session_id: String,
}

const PARKED_REMOTE_ORIGIN: &str = "remote-parked-editor";

async fn park_remote_status_update(
    service: Option<Arc<EngineService>>,
    base_relay_seq: i64,
) -> ParkedRecordUpdate {
    let markdown = format!("---\nid: {RECORD_ID}\nstatus: open\n---\n\nAlpha\n");
    let scratch = ScratchDir::new().expect("scratch");
    write_root_binding(scratch.path(), TOKEN).expect("root binding");
    seed_schema(
        &scratch,
        "name: Tasks\nfields:\n  status:\n    type: text\n",
    );
    let db = engine_db_path(&scratch).expect("engine db path");
    let mut store = EngineStore::open(&db, 1).expect("open store");
    store.bind_root_token(TOKEN, &NoFaults).expect("bind token");
    seed_text(&mut store, "tasks/alpha.md", &markdown, 3);
    store
        .write_with(&NoFaults, |tx| {
            reconcile_collections_in_tx(tx, WORKSPACE_ID, "main")?;
            set_collection_adoption_state_in_tx(
                tx,
                WORKSPACE_ID,
                "main",
                "tasks/alpha.md",
                RECORD_ID,
                "adopted",
            )
        })
        .expect("bind adopted collection record");
    drop(store);
    let connection = rusqlite::Connection::open(&db).expect("open identity connection");
    connection
        .execute(
            "INSERT INTO sync_identity \
             (workspace_id,origin_id,replication_epoch,stream_identity,created_at_ms) \
             VALUES (?1,'local-origin','epoch','stream',1)",
            [WORKSPACE_ID],
        )
        .expect("seed sync identity");
    connection
        .execute(
            "INSERT INTO sync_relay_push_state (workspace_id,origin_id,pushed_seq) \
             VALUES (?1,'local-origin',0)",
            [WORKSPACE_ID],
        )
        .expect("enable sync");
    drop(connection);
    std::fs::write(scratch.path().join("tasks/alpha.md"), &markdown).expect("record file");

    let service = service.unwrap_or_else(|| Arc::new(EngineService::new()));
    let transport = InProcessTransport::new(Arc::clone(&service));
    let opened = call_with_busy_retry(
        &transport,
        RequestContext::unbounded(),
        request(
            100,
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

    // Seed the local rich-document lineage from the captured artifact.
    let seed_doc = Ydoc::wire();
    seed_doc
        .rewrite_content_to_markdown(ContentKind::Richdoc, &markdown)
        .expect("seed shared rich document");
    let seeded = call(
        &transport,
        &handle,
        101,
        "ydoc.open",
        json!({ "versionId": "main", "path": "tasks/alpha.md", "contentKind": "richdoc" }),
    )
    .await;
    call(
        &transport,
        &handle,
        102,
        "ydoc.recordUpdate",
        json!({
            "expectedLineageClaimId": seeded["lineageClaimId"],
            "sessionId": seeded["sessionId"],
            "updateBase64":
                base64::engine::general_purpose::STANDARD.encode(seed_doc.encode_full_state()),
            "seed": true,
        }),
    )
    .await;
    call(
        &transport,
        &handle,
        103,
        "ydoc.close",
        json!({ "sessionId": seeded["sessionId"] }),
    )
    .await;

    // Resume the lineage at the relay so a synced update can enter it.
    let object_id = seeded["objectId"].as_str().expect("seeded object id");
    let key = DocKey::new(WORKSPACE_ID, "main", object_id).expect("document key");
    let mut store = EngineStore::open(&db, 2).expect("open base claim store");
    let persisted = dohc_engine_collab::load_persisted(&store, &key)
        .expect("load local collection lineage")
        .expect("collection lineage exists");
    let base = persisted.doc.encode_full_state();
    let base_origin = persisted.marker.base_origin_id.expect("local base origin");
    let base_seq = persisted
        .marker
        .base_origin_seq
        .expect("local base sequence");
    assert!(matches!(
        claim_base_at_relay(
            &mut store,
            &key,
            ContentKind::Richdoc,
            &base,
            &BaseRelayCoordinate::new(base_origin, base_seq, base_relay_seq)
                .expect("base coordinate"),
            &NoFaults,
            10,
        ),
        Ok(TxnOutcome::Committed(ClaimOutcome::Resumed))
    ));
    drop(store);

    // Park one synced frontmatter edit behind the live session's lease.
    let (live, initial_update) = call_ydoc_with_blob(
        service.as_ref(),
        &handle,
        104,
        "ydoc.open",
        json!({ "versionId": "main", "path": "tasks/alpha.md", "contentKind": "richdoc" }),
    )
    .await;
    let remote = Ydoc::wire();
    remote.apply(&initial_update).expect("load shared base");
    let update = remote.frontmatter_set("status", "remote").unwrap();
    let lineage_claim_id = live["lineageClaimId"]
        .as_str()
        .expect("replicated lineage claim")
        .to_owned();
    let mut store = EngineStore::open(&db, 2).expect("open remote apply store");
    let update_sha = store.put_binary_blob(&update).expect("store remote update");
    let envelope = ReplicationEnvelope {
        settlement_admission: None,
        admitted_author_snapshot: None,
        workspace_id: WORKSPACE_ID.to_owned(),
        origin_id: PARKED_REMOTE_ORIGIN.to_owned(),
        origin_seq: 0,
        relay_seq: Some(10),
        op_kind: "ydoc.update".to_owned(),
        payload: json!({
            "versionId": "main",
            "objectId": object_id,
            "path": "tasks/alpha.md",
            "contentKind": "richdoc",
            "updateBlobSha256": update_sha,
            "lineageClaimId": lineage_claim_id,
            "isBaseState": false,
            "actorOriginId": PARKED_REMOTE_ORIGIN,
        }),
        recorded_at_ms: 200,
    };
    let applied = apply_ydoc_envelope(
        &mut store,
        &mut dohc_engine_collab::WriterDocCache::new(),
        &envelope,
        &NoFaults,
        &AlwaysLive,
    )
    .expect("queue remote collection update");
    assert!(
        matches!(applied, ApplyOutcome { primary: ApplyDisposition::Applied(result), refusals: ref outcome_refusals, sharing_declined: ref outcome_sharing_declined, } if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty() && (result.deferred)),
        "the live device must defer the remote update"
    );
    // ADR 0008 pin: a subscribed automation must not be claimed by the drain
    // of this synced update; only its origin device claims.
    store
        .write_with(&NoFaults, |tx| {
            subscribe_automation_in_tx(
                tx,
                WORKSPACE_ID,
                &AutomationSubscription {
                    automation_id: "collection:tasks#triage".to_owned(),
                    prefix: "tasks".to_owned(),
                    kinds: vec![AutomationChangeKind::Added, AutomationChangeKind::Changed],
                    fields: None,
                },
                20,
            )
        })
        .expect("subscribe automation");
    drop(store);

    ParkedRecordUpdate {
        scratch,
        service,
        transport,
        handle,
        live_session_id: live["sessionId"].as_str().expect("session id").to_owned(),
    }
}

/// Record events named `record.*` (plus any `automation.claimed`) until the
/// first `record.updated`, panicking past the deadline.
async fn wait_for_record_events(
    events: &mut tokio::sync::mpsc::Receiver<EngineEventNotice>,
) -> Vec<EngineEventNotice> {
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(30);
    let mut seen = Vec::new();
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        let notice = tokio::time::timeout(remaining, events.recv())
            .await
            .expect("timed out waiting for record events")
            .expect("event channel stays open");
        let done = notice.name == RECORD_UPDATED_EVENT;
        if notice.name.starts_with("record.") || notice.name == AUTOMATION_CLAIMED_EVENT {
            seen.push(notice);
        }
        if done {
            return seen;
        }
    }
}

fn assert_parked_drain_events(notices: &[EngineEventNotice]) {
    assert_eq!(
        notices.len(),
        2,
        "one field change and one update: {notices:?}"
    );
    assert_eq!(
        notices
            .iter()
            .filter(|notice| notice.name == RECORD_UPDATED_EVENT)
            .count(),
        1,
        "exactly one record update fires: {notices:?}"
    );
    for notice in notices {
        assert_eq!(
            notice.payload["source"],
            json!({ "originId": PARKED_REMOTE_ORIGIN, "originSeq": 0 })
        );
    }
    assert!(
        notices
            .iter()
            .all(|notice| notice.name != AUTOMATION_CLAIMED_EVENT),
        "a drained synced update must not claim automation triggers (ADR 0008): {notices:?}"
    );
    assert!(
        notices
            .iter()
            .all(|notice| notice.name != RECORD_CREATED_EVENT),
        "an adopted record's parked edit is not a creation: {notices:?}"
    );
    let field_changed: Vec<_> = notices
        .iter()
        .filter(|notice| notice.name == RECORD_FIELD_CHANGED_EVENT)
        .collect();
    assert_eq!(
        field_changed.len(),
        1,
        "exactly one field change fires: {notices:?}"
    );
    let payload = &field_changed[0].payload;
    assert_eq!(payload["workspaceId"], json!(WORKSPACE_ID));
    assert_eq!(payload["collectionPath"], json!("tasks"));
    assert_eq!(payload["recordId"], json!(RECORD_ID));
    assert_eq!(payload["field"], json!("status"));
    assert_eq!(payload["previous"], json!("open"));
    assert_eq!(payload["next"], json!("remote"));
    assert_eq!(payload["author"], json!(PARKED_REMOTE_ORIGIN));
    assert_eq!(
        payload["source"],
        json!({ "originId": PARKED_REMOTE_ORIGIN, "originSeq": 0 })
    );
}

fn assert_no_automation_claims(scratch: &ScratchDir) {
    let db = engine_db_path(scratch).expect("engine db path");
    let store = EngineStore::open(&db, 9).expect("open claim probe store");
    let claims: i64 = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM automation_claims WHERE workspace_id=?1",
                [WORKSPACE_ID],
                |row| row.get(0),
            )
        })
        .expect("count automation claims");
    assert_eq!(
        claims, 0,
        "a drained synced update never inserts a claim (ADR 0008)"
    );
}

fn deferred_update_rows(scratch: &ScratchDir) -> i64 {
    let db = engine_db_path(scratch).expect("engine db path");
    let store = EngineStore::open(&db, 8).expect("open deferred probe store");
    store
        .read_with(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM ydoc_deferred_updates WHERE workspace_id=?1",
                [WORKSPACE_ID],
                |row| row.get::<_, i64>(0),
            )
        })
        .expect("count deferred updates")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn resync_emits_parked_record_events_once_after_a_claim_mismatch() {
    let parked = park_remote_status_update(None, 10).await;
    let db = engine_db_path(&parked.scratch).expect("engine db");
    let mut events = parked.service.events().subscribe();
    let connection = rusqlite::Connection::open(&db).expect("fixture connection");
    let claim: String = connection
        .query_row(
            "SELECT lineage_claim_id FROM ydoc_docs WHERE workspace_id=?1 AND path='tasks/alpha.md'",
            [WORKSPACE_ID],
            |row| row.get(0),
        )
        .expect("original claim");
    // As in the lineage replacement tests, move the durable claim ahead of
    // the session without letting that fixture write drain the queue.
    let replacement_doc = Ydoc::wire();
    replacement_doc
        .rewrite_content_to_markdown(
            ContentKind::Richdoc,
            &format!("---\nid: {RECORD_ID}\nstatus: open\n---\n\nAlpha\n"),
        )
        .expect("replacement base");
    let store = EngineStore::open(&db, 300).expect("open replacement store");
    let replacement = store
        .put_binary_blob(&replacement_doc.encode_full_state())
        .expect("store replacement base");
    drop(store);
    assert_ne!(replacement, claim);
    connection
        .execute(
            "UPDATE ydoc_docs SET lineage_claim_id=?1 WHERE workspace_id=?2 AND path='tasks/alpha.md'",
            rusqlite::params![replacement, WORKSPACE_ID],
        )
        .expect("replace claim");
    let (state, _) = call_ydoc_with_blob(
        parked.service.as_ref(),
        &parked.handle,
        300,
        "ydoc.resync",
        json!({ "sessionId": parked.live_session_id }),
    )
    .await;
    assert_eq!(state["lineageClaimId"], json!(replacement));
    assert_eq!(deferred_update_rows(&parked.scratch), 1);
    while let Ok(notice) = events.try_recv() {
        assert!(!notice.name.starts_with("record."), "{notice:?}");
        assert_ne!(notice.name, AUTOMATION_CLAIMED_EVENT);
    }
    connection
        .execute(
            "UPDATE ydoc_docs SET lineage_claim_id=?1 WHERE workspace_id=?2 AND path='tasks/alpha.md'",
            rusqlite::params![claim, WORKSPACE_ID],
        )
        .expect("restore original claim");
    drop(connection);
    // This handshake returns to the original claim without draining it.
    call_ydoc_with_blob(
        parked.service.as_ref(),
        &parked.handle,
        301,
        "ydoc.resync",
        json!({ "sessionId": parked.live_session_id }),
    )
    .await;
    assert_eq!(deferred_update_rows(&parked.scratch), 1);
    while let Ok(notice) = events.try_recv() {
        assert!(!notice.name.starts_with("record."), "{notice:?}");
        assert_ne!(notice.name, AUTOMATION_CLAIMED_EVENT);
    }

    let (_, bytes) = call_ydoc_with_blob(
        parked.service.as_ref(),
        &parked.handle,
        302,
        "ydoc.resync",
        json!({ "sessionId": parked.live_session_id }),
    )
    .await;
    let doc = Ydoc::wire();
    doc.apply(&bytes).expect("resynced document");
    assert!(
        doc.project(ContentKind::Richdoc)
            .unwrap()
            .content
            .contains("status: remote")
    );
    assert_eq!(deferred_update_rows(&parked.scratch), 0);
    let notices = wait_for_record_events(&mut events).await;
    assert_parked_drain_events(&notices);
    call(
        &parked.transport,
        &parked.handle,
        303,
        "ydoc.settle",
        json!({ "sessionId": parked.live_session_id }),
    )
    .await;
    call(
        &parked.transport,
        &parked.handle,
        304,
        "ydoc.close",
        json!({ "sessionId": parked.live_session_id, "settle": false }),
    )
    .await;
    while let Ok(notice) = events.try_recv() {
        assert!(
            !notice.name.starts_with("record."),
            "no repeated event: {notice:?}"
        );
        assert_ne!(notice.name, AUTOMATION_CLAIMED_EVENT);
    }
    assert_no_automation_claims(&parked.scratch);
    call(
        &parked.transport,
        &parked.handle,
        399,
        "workspace.close",
        json!({}),
    )
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn collection_responses_honor_a_negotiated_frame_limit_below_the_default() {
    const LARGE_FIELD_BYTES: usize = 2 * 1024 * 1024;
    const NEGOTIATED: u32 = dohc_engine_protocol::limits::MIN_NEGOTIABLE_FRAME_BYTES;
    let scratch = ScratchDir::new().expect("scratch");
    write_root_binding(scratch.path(), TOKEN).expect("root binding");
    let db = engine_db_path(&scratch).expect("engine db path");
    let mut store = EngineStore::open(&db, 1).expect("open store");
    store.bind_root_token(TOKEN, &NoFaults).expect("bind token");
    VersionedTextStore::new(&mut store)
        .ensure_main_version(WORKSPACE_ID, "main", 1, &NoFaults)
        .expect("main version");
    let schema = "fields:\n  notes:\n    type: text\n";
    let large_value = "x".repeat(LARGE_FIELD_BYTES);
    let record = format!("---\nid: {RECORD_ID}\nnotes: {large_value}\n---\n");
    seed_text(&mut store, "negotiated/collection.yaml", schema, 2);
    seed_text(&mut store, "negotiated/record.md", &record, 3);
    store
        .write_with(&NoFaults, |tx| {
            reconcile_collections_in_tx(tx, WORKSPACE_ID, "main")
        })
        .expect("reconcile negotiated collection");
    drop(store);
    let collection_dir = scratch.path().join("negotiated");
    std::fs::create_dir_all(&collection_dir).expect("collection directory");
    std::fs::write(collection_dir.join("collection.yaml"), schema).expect("schema file");
    std::fs::write(collection_dir.join("record.md"), &record).expect("record file");

    let service = Arc::new(EngineService::new());
    let transport = InProcessTransport::new(Arc::clone(&service));
    let opened = call_with_busy_retry(
        &transport,
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
    let params = json!({ "collectionPath": "negotiated", "limit": 1 });

    // At the daemon default the 2 MiB record travels in band.
    let in_band = ProtocolEngineService::call(
        service.as_ref(),
        RequestContext::unbounded(),
        request(
            10,
            "collections.query",
            Some(handle.clone()),
            params.clone(),
        ),
    )
    .await
    .expect("default-limit query");
    assert!(in_band.blob_egress.is_none());

    // At a negotiated 1 MiB frame the same response must ride blob egress
    // sized to the negotiated cap, not the daemon default.
    let negotiated_cap = NEGOTIATED as usize - 64 * 1024;
    let over = ProtocolEngineService::call(
        service.as_ref(),
        RequestContext::unbounded()
            .with_capability("blobs")
            .with_max_frame_bytes(NEGOTIATED),
        request(
            11,
            "collections.query",
            Some(handle.clone()),
            params.clone(),
        ),
    )
    .await
    .expect("negotiated-limit query with blobs");
    let egress = over.blob_egress.expect("negotiated blob egress");
    assert!(egress.bytes.len() > negotiated_cap);
    assert_eq!(
        over.response.result["inbandLimitBytes"].as_u64(),
        Some(negotiated_cap as u64)
    );
    let parsed: Value = serde_json::from_slice(&egress.bytes).expect("blob-backed collection JSON");
    assert_eq!(parsed["records"][0]["id"], json!(RECORD_ID));

    // Without blobs the negotiated limit refuses rather than over-framing.
    let refusal = ProtocolEngineService::call(
        service.as_ref(),
        RequestContext::unbounded().with_max_frame_bytes(NEGOTIATED),
        request(12, "collections.query", Some(handle.clone()), params),
    )
    .await
    .expect_err("a response past the negotiated limit without blobs must be refused");
    assert_eq!(refusal.message, "collection-response-exceeds-wire-limit");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn native_public_trip_poll_moment_materializes_adopts_and_dedupes() {
    use dohc_engine_runtime::{CancellationToken, WorkspaceSupervisor};

    const PATH: &str = "responses/accepted_00000000-0000-4000-8000-000000000001.md";
    const ACCEPTANCE: &str = "accepted_00000000-0000-4000-8000-000000000001";
    const MOMENT: &str = "00000000-0000-4000-8000-000000000002";
    const OBJECT: &str = "00000000-0000-4000-8000-000000000003";
    const PRINCIPAL: &str = "public_00000000-0000-4000-8000-000000000004";
    const GRANT: &str = "grant-trip-1";
    const OWNER: &str = "trip-owner-device";

    let scratch = ScratchDir::new().expect("scratch");
    write_root_binding(scratch.path(), TOKEN).expect("root binding");
    let db = engine_db_path(&scratch).expect("db");
    let mut store = EngineStore::open(&db, 1).expect("seed owner store");
    store.bind_root_token(TOKEN, &NoFaults).expect("bind token");
    VersionedTextStore::new(&mut store)
        .ensure_main_version(WORKSPACE_ID, "main", 1, &NoFaults)
        .expect("main version");
    let schema = "name: Responses\nfields:\n  destination:\n    type: text\n  name:\n    type: text\n  created_at:\n    type: number\n  created_by:\n    type: text\n  grant_id:\n    type: text\n  idempotency_key:\n    type: text\n  acceptance_id:\n    type: text\n";
    seed_text(&mut store, "responses/collection.yaml", schema, 2);
    write_file(
        scratch.path(),
        "responses/collection.yaml",
        schema.as_bytes(),
    );
    drop(store);

    // Match acceptAppCollection's JSON frontmatter. The relay has assigned an
    // acceptance and public principal; the owner has not assigned a record id.
    let text = format!(
        "---\n{{\"destination\":\"Tokyo\",\"name\":\"Sam\",\"created_at\":20,\"created_by\":\"{PRINCIPAL}\",\"grant_id\":\"{GRANT}\",\"idempotency_key\":\"vote-1\",\"acceptance_id\":\"{ACCEPTANCE}\"}}\n---\n"
    );
    let sha = hex_sha256(text.as_bytes());
    let author = json!({ "kind": "public", "principalId": PRINCIPAL, "grantId": GRANT });
    let envelope = ReplicationEnvelope {
        settlement_admission: None,
        admitted_author_snapshot: None,
        workspace_id: WORKSPACE_ID.to_owned(),
        origin_id: format!("relay:collection-create:{GRANT}"),
        origin_seq: 0,
        relay_seq: Some(1),
        op_kind: "moment.append".to_owned(),
        recorded_at_ms: 20,
        payload: json!({
            "momentId": MOMENT,
            "versionId": "main",
            "objectId": OBJECT,
            "path": PATH,
            "recordedAtMs": 20,
            "operation": "write",
            "beforePresent": "null",
            "payloadBeforeBlobSha256": null,
            "payloadBeforePath": null,
            "payloadBeforeContentKind": null,
            "payloadBeforeByteLength": null,
            "payloadAfterBlobSha256": sha,
            "payloadAfterPath": PATH,
            "payloadAfterContentKind": "text",
            "payloadAfterByteLength": text.len(),
            "metadata": { "origin": "sync" },
            "authors": [author],
        }),
    };
    let connection = rusqlite::Connection::open(&db).expect("seed replication connection");
    connection
        .execute(
            "INSERT INTO blobs (sha256,byte_length,text) VALUES (?1,?2,?3)",
            rusqlite::params![sha, text.len() as i64, text],
        )
        .expect("hydrate accepted response blob");
    connection
        .execute(
            "INSERT INTO sync_identity \
         (workspace_id,origin_id,replication_epoch,stream_identity,created_at_ms) \
         VALUES (?1,?2,'trip-epoch','trip-stream',1)",
            rusqlite::params![WORKSPACE_ID, OWNER],
        )
        .expect("seed owner sync identity");
    connection.execute(
        "INSERT INTO sync_relay_push_state (workspace_id,origin_id,pushed_seq) VALUES (?1,?2,0)",
        rusqlite::params![WORKSPACE_ID, OWNER],
    ).expect("enable owner settlement journal");
    drop(connection);
    let mut store = EngineStore::open(&db, 2).expect("replication store");
    let applied = apply_replication_envelope(
        &mut store,
        &mut dohc_engine_collab::WriterDocCache::new(),
        &envelope,
        &NoFaults,
        &NoLiveLeases,
    )
    .expect("apply accepted public response");
    assert!(applied.refusals.is_empty(), "{applied:?}");
    assert!(applied.sharing_declined.is_empty(), "{applied:?}");
    let routed = match applied.primary {
        ApplyDisposition::Applied(r) => r,
        other => panic!("unexpected apply: {other:?}"),
    };
    assert_eq!(routed.materialization_changes.len(), 1);
    let changes = routed.materialization_changes;
    let retry = apply_replication_envelope(
        &mut store,
        &mut dohc_engine_collab::WriterDocCache::new(),
        &envelope,
        &NoFaults,
        &NoLiveLeases,
    )
    .expect("retry accepted response before materialization");
    assert!(matches!(retry.primary, ApplyDisposition::Skipped));
    assert!(retry.refusals.is_empty());
    drop(store);
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 2).expect("open actor").actor;
    actor
        .materialize_relay_page(
            WORKSPACE_ID.to_owned(),
            scratch.path().to_path_buf(),
            changes.clone(),
            Arc::new(()),
            20,
            CancellationToken::new(),
        )
        .await
        .expect("materialize");
    actor
        .materialize_relay_page(
            WORKSPACE_ID.to_owned(),
            scratch.path().to_path_buf(),
            changes.clone(),
            Arc::new(()),
            21,
            CancellationToken::new(),
        )
        .await
        .expect("retry page materialization");
    supervisor.close(&db).expect("close actor");
    assert_eq!(
        std::fs::read_to_string(scratch.path().join(PATH)).expect("materialized accepted response"),
        text
    );
    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let opened = call_with_busy_retry(
        &transport,
        RequestContext::unbounded(),
        request(
            1,
            "workspace.open",
            None,
            json!({"rootDir":scratch.path().to_string_lossy(),"workspaceId":WORKSPACE_ID}),
        ),
    )
    .await
    .expect("open");
    let handle: WorkspaceHandle =
        serde_json::from_value(opened.result["workspace"].clone()).expect("handle");
    reconcile_capture(&transport, &handle, 10).await;
    let query = call(
        &transport,
        &handle,
        20,
        "collections.query",
        json!({"collectionPath":"responses"}),
    )
    .await;
    let record_id = query["records"][0]["id"]
        .as_str()
        .expect("adopted id")
        .to_owned();
    assert!(record_id.starts_with("rec_"));
    assert_eq!(query["records"].as_array().expect("records").len(), 1);
    let pending = call(
        &transport,
        &handle,
        21,
        "collections.listPendingAdoptions",
        json!({}),
    )
    .await;
    assert_eq!(
        pending["adoptions"]
            .as_array()
            .expect("pending adoptions")
            .len(),
        1
    );
    assert_eq!(pending["adoptions"][0]["recordId"], record_id);
    assert_eq!(pending["adoptions"][0]["objectId"], OBJECT);
    assert_eq!(pending["adoptions"][0]["filePath"], PATH);
    let seeded = call(
        &transport,
        &handle,
        22,
        "ydoc.open",
        json!({
            "versionId": "main", "path": PATH, "contentKind": "richdoc", "expectedObjectId": OBJECT,
        }),
    )
    .await;
    assert_eq!(seeded["lineage"], "absent");
    assert_eq!(seeded["seedContent"], text);
    let doc = Ydoc::wire();
    // The native fixture has only frontmatter. Desktop adoption uses the
    // shared Markdown importer to provide this seed through the same RPC.
    doc.rewrite_content_to_markdown(ContentKind::Richdoc, &text)
        .expect("seed response document");
    call(&transport, &handle, 23, "ydoc.recordUpdate", json!({
        "expectedLineageClaimId": seeded["lineageClaimId"],
        "sessionId": seeded["sessionId"],
        "updateBase64": base64::engine::general_purpose::STANDARD.encode(doc.encode_full_state()),
        "seed": true,
    })).await;
    call(
        &transport,
        &handle,
        24,
        "ydoc.evict",
        json!({ "sessionId": seeded["sessionId"] }),
    )
    .await;
    reconcile_capture(&transport, &handle, 30).await;
    let settled = std::fs::read_to_string(scratch.path().join(PATH)).expect("adopted Markdown");
    assert!(settled.contains(&record_id), "{settled}");
    let query = call(
        &transport,
        &handle,
        60,
        "collections.query",
        json!({ "collectionPath": "responses" }),
    )
    .await;
    assert_eq!(query["records"].as_array().expect("records").len(), 1);
    assert_eq!(query["records"][0]["id"], record_id);
    for (field, expected) in [
        ("destination", json!("Tokyo")),
        ("name", json!("Sam")),
        ("created_at", json!(20)),
        ("created_by", json!(PRINCIPAL)),
        ("grant_id", json!(GRANT)),
        ("idempotency_key", json!("vote-1")),
        ("acceptance_id", json!(ACCEPTANCE)),
    ] {
        let value = query["records"][0]["values"]
            .as_array()
            .expect("record values")
            .iter()
            .find(|value| value["field"] == field)
            .unwrap_or_else(|| panic!("missing {field}: {query}"));
        assert_eq!(value["value"], expected, "{field}");
    }
    let pending = call(
        &transport,
        &handle,
        61,
        "collections.listPendingAdoptions",
        json!({}),
    )
    .await;
    assert_eq!(pending["adoptions"], json!([]));
    let original = call(
        &transport,
        &handle,
        62,
        "moments.get",
        json!({ "momentId": MOMENT }),
    )
    .await;
    assert_eq!(original["authors"], json!([author]));
    assert_eq!(original["afterText"], text);
    call(&transport, &handle, 63, "workspace.close", json!({})).await;
    drop(transport);

    let outgoing = || {
        let connection = rusqlite::Connection::open(&db).expect("read owner journal");
        let mut statement = connection
            .prepare(
                "SELECT payload_json FROM replication_log \
             WHERE workspace_id=?1 AND origin_id=?2 AND imported=0 AND op_kind='moment.append' \
             AND json_extract(payload_json,'$.path')=?3 ORDER BY origin_seq",
            )
            .expect("owner moment query");
        statement
            .query_map(rusqlite::params![WORKSPACE_ID, OWNER, PATH], |row| {
                row.get::<_, String>(0)
            })
            .expect("owner moments")
            .map(|row| {
                serde_json::from_str::<Value>(&row.expect("owner moment")).expect("owner payload")
            })
            .collect::<Vec<_>>()
    };
    let before_retry = outgoing();
    assert_eq!(
        before_retry.len(),
        1,
        "adoption must publish exactly one ordinary file moment"
    );
    let adoption = before_retry
        .iter()
        .find(|op| op["payloadAfterBlobSha256"] == hex_sha256(settled.as_bytes()))
        .expect("owner adoption must enter the outgoing replication journal");
    assert_eq!(adoption["objectId"], OBJECT);
    assert_eq!(
        adoption["metadata"]["origin"], "local-file",
        "the adoption must use a valid ordinary replication origin"
    );
    assert_eq!(
        adoption["payloadAfterBlobSha256"],
        hex_sha256(settled.as_bytes())
    );
    assert_eq!(
        adoption["authors"],
        json!([{"kind":"unattributed"}]),
        "owner settlement must not impersonate the public voter"
    );
    let mut retry = EngineStore::open(&db, 3).expect("retry store");
    let again = apply_replication_envelope(
        &mut retry,
        &mut dohc_engine_collab::WriterDocCache::new(),
        &envelope,
        &NoFaults,
        &NoLiveLeases,
    )
    .expect("retry");
    assert!(matches!(again.primary, ApplyDisposition::Skipped));
    assert!(again.refusals.is_empty());
    drop(retry);
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 3).expect("reopen actor").actor;
    actor
        .materialize_relay_page(
            WORKSPACE_ID.to_owned(),
            scratch.path().to_path_buf(),
            changes,
            Arc::new(()),
            30,
            CancellationToken::new(),
        )
        .await
        .expect("materialization retry after adoption preserves current head");
    supervisor.close(&db).expect("close restarted actor");
    assert_eq!(
        std::fs::read_to_string(scratch.path().join(PATH)).expect("restarted Markdown"),
        settled
    );
    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let opened = call_with_busy_retry(
        &transport,
        RequestContext::unbounded(),
        request(
            70,
            "workspace.open",
            None,
            json!({ "rootDir": scratch.path().to_string_lossy(), "workspaceId": WORKSPACE_ID }),
        ),
    )
    .await
    .expect("restart workspace");
    let handle: WorkspaceHandle =
        serde_json::from_value(opened.result["workspace"].clone()).expect("restart handle");
    reconcile_capture(&transport, &handle, 80).await;
    let query = call(
        &transport,
        &handle,
        110,
        "collections.query",
        json!({ "collectionPath": "responses" }),
    )
    .await;
    assert_eq!(
        query["records"]
            .as_array()
            .expect("restarted records")
            .len(),
        1
    );
    assert_eq!(query["records"][0]["id"], record_id);
    call(&transport, &handle, 111, "workspace.close", json!({})).await;
    assert_eq!(
        outgoing(),
        before_retry,
        "retries and restart must not add owner settlements"
    );
    let connection = rusqlite::Connection::open(&db).expect("read durable imported moment");
    let counts: (i64, i64) = connection.query_row(
        "SELECT (SELECT count(*) FROM moments WHERE workspace_id=?1 AND moment_id=?2), \
         (SELECT count(*) FROM replication_log WHERE workspace_id=?1 AND origin_id=?3 AND imported=1)",
        rusqlite::params![WORKSPACE_ID, MOMENT, envelope.origin_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    ).expect("count imported response");
    assert_eq!(counts, (1, 1));
}

/// A watched workspace with an ordinary pull left unfinished. Capture still
/// records a new record's file, but its Collections update finds the pull and
/// changes nothing. Abandoning the pull on the open binding wakes capture, and
/// the record binds without a relay.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn capture_leaves_collections_to_an_unfinished_pull_until_it_is_abandoned() {
    let scratch = ScratchDir::new().expect("scratch");
    write_root_binding(scratch.path(), TOKEN).expect("root binding");
    seed_schema(&scratch, "name: Tasks\nfields:\n  Title:\n    type: text\n");
    let db = engine_db_path(&scratch).unwrap();
    rusqlite::Connection::open(&db)
        .unwrap()
        .execute(
            "INSERT INTO sync_identity \
             (workspace_id,origin_id,replication_epoch,stream_identity,created_at_ms,ordinary_pull_token) \
             VALUES (?1,'local-origin','epoch','stream',1,'unfinished')",
            [WORKSPACE_ID],
        )
        .unwrap();
    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let params =
        json!({ "rootDir": scratch.path().to_string_lossy(), "workspaceId": WORKSPACE_ID });
    let opened = call_with_busy_retry(
        &transport,
        RequestContext::unbounded(),
        request(1, "workspace.open", None, params.clone()),
    )
    .await
    .expect("open watched workspace");
    let handle: WorkspaceHandle =
        serde_json::from_value(opened.result["workspace"].clone()).unwrap();
    let count = |query: &str| -> i64 {
        rusqlite::Connection::open(&db)
            .unwrap()
            .query_row(query, [], |row| row.get(0))
            .unwrap()
    };
    let bound = || count("SELECT COUNT(*) FROM collection_records WHERE file_path='tasks/a.md'");

    write_file(
        scratch.path(),
        "tasks/a.md",
        format!("---\nid: {RECORD_ID}\nTitle: First\n---\n").as_bytes(),
    );
    reconcile_capture(&transport, &handle, 10).await;
    let status = call(&transport, &handle, 40, "capture.flush", json!({})).await;
    assert_eq!(status["degraded"], false, "{status}");
    assert_eq!(
        count("SELECT COUNT(*) FROM snapshots WHERE path='tasks/a.md'"),
        1,
        "capture saved the file"
    );
    assert_eq!(bound(), 0, "the Collections update waits for the pull");
    assert_eq!(
        call(
            &transport,
            &handle,
            41,
            "sync.collectionsWaiting",
            json!({})
        )
        .await,
        json!({ "waiting": true })
    );

    let mut abandoning = params;
    abandoning["abandonOrdinaryPull"] = json!(true);
    let reopened = call_with_busy_retry(
        &transport,
        RequestContext::unbounded(),
        request(42, "workspace.open", None, abandoning),
    )
    .await
    .expect("abandon on the open binding");
    assert_eq!(reopened.result["workspace"], json!(handle));
    assert_eq!(
        call(
            &transport,
            &handle,
            43,
            "sync.collectionsWaiting",
            json!({})
        )
        .await,
        json!({ "waiting": false })
    );
    let mut id = 50;
    while bound() == 0 {
        assert!(id < 90, "capture never ran the woken update");
        call(&transport, &handle, id, "capture.flush", json!({})).await;
        id += 1;
    }
}
