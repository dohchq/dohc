use crate::common;

use common::*;
use dohc_engine_protocol::{
    error::ErrorCode,
    transport::{InProcessTransport, RequestContext},
    wire::WorkspaceHandle,
};
use dohc_engine_testkit::ScratchDir;
use dohc_workspace_engine::{EngineService, root_binding::write_root_binding};
use serde_json::{Value, json};
use std::sync::Arc;

async fn open_with(
    transport: &InProcessTransport<EngineService>,
    scratch: &ScratchDir,
    id: u64,
    workspace_id: &str,
    extra: Value,
) -> WorkspaceHandle {
    write_root_binding(scratch.path(), TOKEN).expect("root binding");
    let mut params = json!({
        "rootDir": scratch.path().to_string_lossy(),
        "workspaceId": workspace_id,
    });
    params
        .as_object_mut()
        .expect("object")
        .extend(extra.as_object().expect("extra").clone());
    let opened = call_with_busy_retry(
        transport,
        RequestContext::unbounded(),
        request(id, "workspace.open", None, params),
    )
    .await
    .expect("open");
    serde_json::from_value(opened.result["workspace"].clone()).expect("handle")
}

async fn write_text(
    transport: &InProcessTransport<EngineService>,
    handle: &WorkspaceHandle,
    id: u64,
    path: &str,
    text: &str,
) {
    call_keyed(
        transport,
        handle,
        id,
        "versionedText.write",
        &format!("write-{id}"),
        json!({
            "versionId": "main",
            "path": path,
            "text": text,
            "origin": "api",
        }),
    )
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn retrieval_query_ranks_pages_collections_datasets_and_chats_with_graph_and_policy_gates() {
    let scratch = ScratchDir::new().expect("scratch");
    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let workspace_id = "ws-rpc-retrieval";
    write_file(
        scratch.path(),
        ".dohc/visibility.toml",
        b"[[rule]]\npath = \"private/**\"\nvisibility = \"hidden\"\n",
    );
    let handle = open_with(&transport, &scratch, 1, workspace_id, json!({})).await;
    reconcile_until_settled(&transport, &handle, 2).await;

    write_text(
        &transport,
        &handle,
        3,
        "notes/kyoto-plan.md",
        "# Kyoto Trip Plan\n\nReserve [[notes/ryokan-guide]] for autumn foliage.\n",
    )
    .await;
    write_text(
        &transport,
        &handle,
        4,
        "notes/ryokan-guide.md",
        "# Ryokan Guide\n\nTraditional wooden inns in Arashiyama.\n",
    )
    .await;
    write_text(
        &transport,
        &handle,
        5,
        "private/kyoto-secrets.md",
        "# Secret Kyoto Notes\n\nTOP_SECRET_KYOTO_BUDGET\n",
    )
    .await;
    write_text(
        &transport,
        &handle,
        6,
        "data/expenses/dataset.json",
        r#"{"formatVersion":1,"name":"Kyoto Expenses","tables":[{"name":"expenses","fields":[{"name":"vendor","type":"text"},{"name":"yen","type":"number"}]}]}"#,
    )
    .await;
    call(
        &transport,
        &handle,
        7,
        "secrets.write",
        json!({
            "workspaceId": workspace_id,
            "versionId": "main",
            "path": ".env",
            "text": "KYOTO_API_KEY=secret-env-value",
            "origin": "api",
            "momentId": "secret-env-moment",
        }),
    )
    .await;

    call_keyed(
        &transport,
        &handle,
        8,
        "chats.channels.create",
        "create-ch-1",
        json!({
            "channelId": "travel-planning",
            "name": "Travel Planning",
            "kind": "channel",
            "nowMs": 1_000,
        }),
    )
    .await;
    call_keyed(
        &transport,
        &handle,
        9,
        "chats.threads.start",
        "start-th-1",
        json!({
            "channelId": "travel-planning",
            "threadId": "th-kyoto-1",
            "messageId": "msg-kyoto-1",
            "title": "Kyoto Shinkansen Tickets",
            "authorKind": "human",
            "authorUserId": "user-1",
            "authorDisplayName": "Ice",
            "body": "Book green car seats for Kyoto trip.",
            "nowMs": 2_000,
        }),
    )
    .await;

    // Owner retrieval across pages, datasets, and chats; hidden + secret files never appear.
    // Wait on the real link-drain condition so graph neighbors and complete=true are deterministic.
    let res = tokio::time::timeout(std::time::Duration::from_secs(15), async {
        let mut req_id = 100u64;
        loop {
            req_id += 1;
            let res = call(
                &transport,
                &handle,
                req_id,
                "retrieval.query",
                json!({ "query": "kyoto" }),
            )
            .await;
            if res["indexBuilding"] == json!(false) {
                return res;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("retrieval link index must finish draining");
    assert_eq!(res["versionId"], json!("main"));
    assert_eq!(res["complete"], json!(true));
    assert_eq!(res["indexBuilding"], json!(false));
    assert_eq!(res["policyDegraded"], json!(false));
    assert_eq!(res["mountsCovered"], json!(true));
    let results = res["results"].as_array().expect("results array");
    let kinds: Vec<&str> = results
        .iter()
        .filter_map(|hit| hit["kind"].as_str())
        .collect();
    assert!(kinds.contains(&"page"), "expected page hit in {results:?}");
    assert!(
        kinds.contains(&"collection"),
        "expected transactional dataset hit in {results:?}"
    );
    assert!(kinds.contains(&"chat"), "expected chat hit in {results:?}");
    let neighbors = res["neighbors"].as_array().expect("neighbors array");
    assert!(
        neighbors
            .iter()
            .any(|neighbor| neighbor["path"] == json!("notes/ryokan-guide.md")),
        "expected linked 1-hop neighbor notes/ryokan-guide.md in {neighbors:?}"
    );
    let serialized = res.to_string();
    assert!(!serialized.contains("kyoto-secrets"));
    assert!(!serialized.contains("TOP_SECRET_KYOTO_BUDGET"));
    assert!(!serialized.contains("KYOTO_API_KEY"));
    assert!(!serialized.contains(".env"));

    // Read-only attached handle can query retrieval.query cleanly, and must not
    // rebuild an uncertified index on the owner's writer store.
    let read_only = open_with(
        &transport,
        &scratch,
        10_001,
        workspace_id,
        json!({
            "recoverRunningDispatches": false,
            "skipStartupMaintenance": true,
        }),
    )
    .await;
    assert_ne!(read_only, handle);
    let ro_res = call(
        &transport,
        &read_only,
        10_002,
        "retrieval.query",
        json!({ "query": "kyoto", "surfaces": ["page"] }),
    )
    .await;
    assert_eq!(ro_res["results"].as_array().expect("ro results").len(), 1);
    assert_eq!(ro_res["results"][0]["path"], json!("notes/kyoto-plan.md"));

    let branch = call(
        &transport,
        &handle,
        10_120,
        "versions.createNamed",
        json!({
            "workspaceId": workspace_id,
            "name": "uncertified-ro-check",
            "fromVersionId": "main",
        }),
    )
    .await;
    let branch_id = branch["id"].as_str().expect("branch id").to_string();
    call(
        &transport,
        &handle,
        10_121,
        "versions.setActive",
        json!({ "workspaceId": workspace_id, "versionId": branch_id }),
    )
    .await;
    let ro_uncertified = call(
        &transport,
        &read_only,
        10_122,
        "retrieval.query",
        json!({ "query": "kyoto", "surfaces": ["page"] }),
    )
    .await;
    assert_eq!(ro_uncertified["versionId"], json!(branch_id));
    assert_eq!(ro_uncertified["indexBuilding"], json!(true));
    assert_eq!(ro_uncertified["complete"], json!(false));
    let db_path = dohc_engine_testkit::engine_db_path(&scratch).expect("db path");
    let conn =
        rusqlite::Connection::open_with_flags(&db_path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .expect("open db");
    let certified_rows: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM engine_search_index_state WHERE workspace_id = ?1 AND version_id = ?2",
            rusqlite::params![workspace_id, branch_id],
            |row| row.get(0),
        )
        .expect("count index state");
    assert_eq!(
        certified_rows, 0,
        "read-only attached handle must never certify or write engine_search_index_state"
    );

    let cancelled_ctx = RequestContext::unbounded();
    cancelled_ctx.cancel.cancel();
    let cancelled_err = call_with_busy_retry(
        &transport,
        cancelled_ctx,
        request(
            10_123,
            "retrieval.query",
            Some(handle.clone()),
            json!({ "query": "kyoto", "surfaces": ["chat"] }),
        ),
    )
    .await
    .expect_err("cancelled chat query must fail with Cancelled");
    assert_eq!(cancelled_err.code, ErrorCode::Cancelled);

    // Invalid params are rejected with InvalidParams.
    for bad in [
        json!({ "query": "   " }),
        json!({ "query": "???" }),
        json!({ "query": "kyoto", "limit": 0 }),
        json!({ "query": "kyoto", "limit": 51 }),
        json!({ "query": "kyoto", "pathPrefix": "../escape" }),
        json!({ "query": "kyoto", "pathPrefix": "shared-with-me/Team" }),
        json!({ "query": "kyoto", "collectionPath": "Shared-With-Me/Team/Tasks" }),
        json!({ "query": "kyoto", "surfaces": ["page", "page"] }),
        json!({ "query": "kyoto", "surfaces": ["page", "record", "collection", "chat", "page"] }),
        json!({ "query": "kyoto", "unknownField": true }),
    ] {
        let err = call_with_busy_retry(
            &transport,
            RequestContext::unbounded(),
            request(13, "retrieval.query", Some(handle.clone()), bad.clone()),
        )
        .await
        .expect_err(&format!("expected invalid params for {bad}"));
        assert_eq!(err.code, ErrorCode::InvalidParams, "for {bad}: {err:?}");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn retrieval_query_refuses_received_share_and_passive_handles() {
    // Declared before the transport so its stores close before their folders go.
    let share_scratch = ScratchDir::new().expect("share scratch");
    let durable_share_scratch = ScratchDir::new().expect("durable share scratch");
    let passive_scratch = ScratchDir::new().expect("passive scratch");
    let transport = InProcessTransport::new(Arc::new(EngineService::new()));

    let share_handle = open_with(
        &transport,
        &share_scratch,
        1,
        "ws-received-share",
        json!({ "captureMode": "none", "projectCollections": true }),
    )
    .await;
    let share_err = call_with_busy_retry(
        &transport,
        RequestContext::unbounded(),
        request(
            2,
            "retrieval.query",
            Some(share_handle),
            json!({ "query": "anything" }),
        ),
    )
    .await
    .expect_err("received share must be refused");
    assert_eq!(share_err.code, ErrorCode::Forbidden);

    // Even if a raw client reopens a store containing a durable share_view_cursors row
    // without setting projectCollections: true, retrieval.query must refuse with Forbidden.
    let durable_handle = open_with(
        &transport,
        &durable_share_scratch,
        10,
        "ws-durable-share",
        json!({ "captureMode": "none" }),
    )
    .await;
    {
        let db_path = dohc_engine_testkit::engine_db_path(&durable_share_scratch).expect("db");
        let conn = rusqlite::Connection::open(db_path).expect("open db");
        conn.execute(
            "INSERT INTO share_view_cursors (workspace_id, share_id, cursor) \
             VALUES ('ws-durable-share', 'sh-1', 'cur-1')",
            [],
        )
        .expect("seed share_view_cursors");
    }
    let durable_err = call_with_busy_retry(
        &transport,
        RequestContext::unbounded(),
        request(
            11,
            "retrieval.query",
            Some(durable_handle),
            json!({ "query": "anything" }),
        ),
    )
    .await
    .expect_err("durable received-share store must be refused even without projectCollections");
    assert_eq!(durable_err.code, ErrorCode::Forbidden);

    let passive_handle = open_with(
        &transport,
        &passive_scratch,
        3,
        "ws-passive",
        json!({ "captureMode": "none", "storeMode": "passive" }),
    )
    .await;
    let passive_err = call_with_busy_retry(
        &transport,
        RequestContext::unbounded(),
        request(
            4,
            "retrieval.query",
            Some(passive_handle),
            json!({ "query": "anything" }),
        ),
    )
    .await
    .expect_err("passive handle must be refused");
    assert_eq!(passive_err.code, ErrorCode::Forbidden);
}
