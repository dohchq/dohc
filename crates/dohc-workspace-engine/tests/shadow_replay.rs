use base64::Engine as _;
use dohc_engine_collab::{ContentKind, DocKey, Ydoc, load_persisted};
use dohc_engine_domain::VersionedTextStore;
use dohc_engine_protocol::{
    error::ErrorCode,
    transport::{EngineTransport, InProcessTransport, RequestContext},
    wire::{Request, WorkspaceHandle},
};
use dohc_engine_storage::EngineStore;
use dohc_engine_testkit::{ScratchDir, harness::write_fingerprint_db};
use dohc_workspace_engine::{EngineService, shadow_fence::write_shadow_marker_for_harness};
use serde_json::{Value, json};
use std::sync::Arc;

const TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

fn request(id: u64, method: &str, workspace: Option<WorkspaceHandle>, params: Value) -> Request {
    Request {
        id,
        method: method.to_owned(),
        workspace,
        deadline_ms: None,
        idempotency_key: Some(format!("shadow-{id}")),
        params,
    }
}

fn root_string(scratch: &ScratchDir) -> String {
    scratch.path().to_string_lossy().into_owned()
}

async fn open_shadow(
    transport: &InProcessTransport<EngineService>,
    scratch: &ScratchDir,
    request_id: u64,
) -> WorkspaceHandle {
    let opened = transport
        .call(
            RequestContext::unbounded(),
            request(
                request_id,
                "workspace.open",
                None,
                json!({ "rootDir": root_string(scratch), "workspaceId": "ws-shadow" }),
            ),
        )
        .await
        .expect("workspace open");
    serde_json::from_value(opened.result["workspace"].clone()).expect("workspace handle")
}

#[tokio::test]
async fn clone_marked_shadow_replay_composes_real_domains_end_to_end() {
    let scratch = ScratchDir::new().expect("scratch");
    write_shadow_marker_for_harness(scratch.path(), TOKEN).expect("marker");
    let transport = InProcessTransport::new(Arc::new(EngineService::new()));

    let opened = transport
        .call(
            RequestContext::unbounded(),
            request(
                1,
                "workspace.open",
                None,
                json!({ "rootDir": root_string(&scratch), "workspaceId": "ws-shadow" }),
            ),
        )
        .await
        .expect("workspace open");
    let handle: WorkspaceHandle =
        serde_json::from_value(opened.result["workspace"].clone()).expect("workspace handle");

    transport
        .call(
            RequestContext::unbounded(),
            request(
                2,
                "versionedText.write",
                Some(handle.clone()),
                json!({
                    "versionId": "main",
                    "objectId": "object-1",
                    "path": "notes/hello.md",
                    "text": "hello shadow replay",
                    "momentId": "moment-1",
                    "metadataOrigin": "api",
                    "nowMs": 100
                }),
            ),
        )
        .await
        .expect("text write");

    let read = transport
        .call(
            RequestContext::unbounded(),
            request(
                3,
                "versionedText.read",
                Some(handle.clone()),
                json!({ "versionId": "main", "path": "notes/hello.md" }),
            ),
        )
        .await
        .expect("text read");
    assert_eq!(read.result["text"], "hello shadow replay");

    let doc = Ydoc::wire();
    let update = doc.plaintext_insert(0, "benign");
    transport
        .call(
            RequestContext::unbounded(),
            request(
                4,
                "ydoc.apply",
                Some(handle.clone()),
                json!({
                    "versionId": "main",
                    "objectId": "object-1",
                    "contentKind": "plaintext",
                    "updateBase64": base64::engine::general_purpose::STANDARD.encode(update),
                    "nowMs": 101
                }),
            ),
        )
        .await
        .expect("ydoc apply");

    let conflicts = transport
        .call(
            RequestContext::unbounded(),
            request(
                5,
                "conflicts.list",
                Some(handle.clone()),
                json!({ "status": "open" }),
            ),
        )
        .await
        .expect("conflict list");
    assert_eq!(conflicts.result, json!([]));

    let search = transport
        .call(
            RequestContext::unbounded(),
            request(
                6,
                "search.query",
                Some(handle.clone()),
                json!({ "versionId": "main", "query": "shadow", "nowMs": 102 }),
            ),
        )
        .await
        .expect("search");
    assert_eq!(search.result[0]["path"], "notes/hello.md");

    let closed = transport
        .call(
            RequestContext::unbounded(),
            request(7, "workspace.close", Some(handle), json!({})),
        )
        .await
        .expect("workspace close");
    assert_eq!(closed.result["closed"], true);

    let reopened = transport
        .call(
            RequestContext::unbounded(),
            request(
                8,
                "workspace.open",
                None,
                json!({ "rootDir": root_string(&scratch), "workspaceId": "ws-shadow" }),
            ),
        )
        .await
        .expect("matching shadow stamp must reopen");
    let reopened_handle: WorkspaceHandle =
        serde_json::from_value(reopened.result["workspace"].clone()).expect("reopened handle");
    transport
        .call(
            RequestContext::unbounded(),
            request(9, "workspace.close", Some(reopened_handle), json!({})),
        )
        .await
        .expect("reopened workspace close");

    let db_path = scratch.engine_db_path().expect("db path");
    let mut store = EngineStore::open(&db_path, 103).expect("reopen after actor close");
    assert!(!store.was_freshly_created());
    let shadow_token: String = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT token FROM shadow_clone WHERE rowid_guard = 1",
                [],
                |row| row.get(0),
            )
        })
        .expect("shadow token");
    assert_eq!(shadow_token, TOKEN);
    let snapshot = VersionedTextStore::new(&mut store)
        .read_text("ws-shadow", "main", "notes/hello.md")
        .expect("disk read")
        .expect("disk snapshot");
    assert_eq!(snapshot.text, "hello shadow replay");
    let key = DocKey::new("ws-shadow", "main", "object-1").expect("doc key");
    let persisted = load_persisted(&store, &key)
        .expect("persisted Y.Doc load")
        .expect("persisted Y.Doc lineage");
    assert_eq!(
        persisted.doc.project(ContentKind::Plaintext).markdown,
        "benign"
    );
}

#[tokio::test]
async fn local_conflict_open_rejects_snapshot_hash_mismatch_without_persistence() {
    let scratch = ScratchDir::new().expect("scratch");
    write_shadow_marker_for_harness(scratch.path(), TOKEN).expect("marker");
    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let handle = open_shadow(&transport, &scratch, 1).await;
    let error = transport
        .call(
            RequestContext::unbounded(),
            request(
                2,
                "conflicts.open",
                Some(handle.clone()),
                json!({
                    "conflict": {
                        "id": "bad-hash-conflict",
                        "workspaceId": "ws-shadow",
                        "path": "doc.md",
                        "targetVersionId": "main",
                        "sourceVersionId": "peer",
                        "createdAtMs": 100,
                        "updatedAtMs": 100,
                        "status": "open",
                        "chosenFrom": "current",
                        "metadata": { "origin": "merge" },
                        "base": { "path": "doc.md", "contentKind": "text" },
                        "current": {
                            "path": "doc.md",
                            "contentKind": "text",
                            "snapshot": {
                                "workspaceId": "ws-shadow",
                                "versionId": "main",
                                "objectId": "object-1",
                                "path": "doc.md",
                                "text": "trusted text",
                                "blobSha256": "not-the-text-hash",
                                "updatedAtMs": 100,
                                "latestMomentId": "moment-1",
                                "metadataOrigin": "merge"
                            }
                        },
                        "incoming": { "path": "doc.md", "contentKind": "text" }
                    }
                }),
            ),
        )
        .await
        .expect_err("mismatched snapshot hash must fail");
    assert_eq!(error.code, ErrorCode::InvalidParams);
    transport
        .call(
            RequestContext::unbounded(),
            request(3, "workspace.close", Some(handle), json!({})),
        )
        .await
        .expect("workspace close");

    let db_path = scratch.engine_db_path().expect("db path");
    let store = EngineStore::open(&db_path, 101).expect("store reopen");
    let counts = store
        .read_with(|conn| {
            Ok::<_, rusqlite::Error>((
                conn.query_row("SELECT COUNT(*) FROM blobs", [], |row| row.get::<_, i64>(0))?,
                conn.query_row("SELECT COUNT(*) FROM conflicts", [], |row| {
                    row.get::<_, i64>(0)
                })?,
            ))
        })
        .expect("row counts");
    assert_eq!(counts, (0, 0));
}

#[tokio::test]
async fn first_parity_rejected_ydoc_apply_is_atomic_and_valid_retry_creates_lineage() {
    let scratch = ScratchDir::new().expect("scratch");
    write_shadow_marker_for_harness(scratch.path(), TOKEN).expect("marker");
    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let handle = open_shadow(&transport, &scratch, 1).await;
    transport
        .call(
            RequestContext::unbounded(),
            request(
                2,
                "versionedText.write",
                Some(handle.clone()),
                json!({
                    "versionId": "main",
                    "objectId": "object-parity",
                    "path": "parity.md",
                    "text": "seed",
                    "momentId": "moment-parity",
                    "metadataOrigin": "api",
                    "nowMs": 100
                }),
            ),
        )
        .await
        .expect("seed parent object");
    let base = base64::engine::general_purpose::STANDARD
        .decode("AQH07uzvDQAEAQlwbGFpblRleHQE8J+YgAA=")
        .expect("surrogate base");
    let bypass = base64::engine::general_purpose::STANDARD
        .decode("AQH07uzvDQLE9O7s7w0A9O7s7w0BAVgA")
        .expect("surrogate bypass");
    let parity_rejected =
        yrs::merge_updates_v1([base.as_slice(), bypass.as_slice()]).expect("merge parity probe");
    let error = transport
        .call(
            RequestContext::unbounded(),
            request(
                3,
                "ydoc.apply",
                Some(handle.clone()),
                json!({
                    "versionId": "main",
                    "objectId": "object-parity",
                    "contentKind": "plaintext",
                    "updateBase64": base64::engine::general_purpose::STANDARD.encode(parity_rejected),
                    "nowMs": 101
                }),
            ),
        )
        .await
        .expect_err("parity probe must fail");
    assert_eq!(error.code, ErrorCode::InvalidParams);
    transport
        .call(
            RequestContext::unbounded(),
            request(4, "workspace.close", Some(handle), json!({})),
        )
        .await
        .expect("close after rejected apply");

    let db_path = scratch.engine_db_path().expect("db path");
    {
        let store = EngineStore::open(&db_path, 102).expect("inspect rejected apply");
        let counts = store
            .read_with(|conn| {
                Ok::<_, rusqlite::Error>((
                    conn.query_row("SELECT COUNT(*) FROM ydoc_docs", [], |row| {
                        row.get::<_, i64>(0)
                    })?,
                    conn.query_row("SELECT COUNT(*) FROM ydoc_updates", [], |row| {
                        row.get::<_, i64>(0)
                    })?,
                    conn.query_row("SELECT COUNT(*) FROM binary_blobs", [], |row| {
                        row.get::<_, i64>(0)
                    })?,
                ))
            })
            .expect("rejected row counts");
        assert_eq!(counts, (0, 0, 0));
    }

    let retried_handle = open_shadow(&transport, &scratch, 5).await;
    let valid_doc = Ydoc::wire();
    let valid_update = valid_doc.plaintext_insert(0, "valid");
    transport
        .call(
            RequestContext::unbounded(),
            request(
                6,
                "ydoc.apply",
                Some(retried_handle.clone()),
                json!({
                    "versionId": "main",
                    "objectId": "object-parity",
                    "contentKind": "plaintext",
                    "updateBase64": base64::engine::general_purpose::STANDARD.encode(valid_update),
                    "nowMs": 103
                }),
            ),
        )
        .await
        .expect("valid apply after rejected first apply");
    transport
        .call(
            RequestContext::unbounded(),
            request(7, "workspace.close", Some(retried_handle), json!({})),
        )
        .await
        .expect("close after valid apply");

    let store = EngineStore::open(&db_path, 104).expect("inspect valid apply");
    let counts = store
        .read_with(|conn| {
            Ok::<_, rusqlite::Error>((
                conn.query_row("SELECT COUNT(*) FROM ydoc_docs", [], |row| {
                    row.get::<_, i64>(0)
                })?,
                conn.query_row("SELECT COUNT(*) FROM ydoc_updates", [], |row| {
                    row.get::<_, i64>(0)
                })?,
                conn.query_row("SELECT COUNT(*) FROM binary_blobs", [], |row| {
                    row.get::<_, i64>(0)
                })?,
            ))
        })
        .expect("valid row counts");
    assert_eq!(counts, (1, 1, 1));
}

#[tokio::test]
async fn shadow_replay_without_marker_is_refused_before_workspace_open() {
    let scratch = ScratchDir::new().expect("scratch");
    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let error = transport
        .call(
            RequestContext::unbounded(),
            request(
                1,
                "workspace.open",
                None,
                json!({ "rootDir": root_string(&scratch), "workspaceId": "ws-shadow" }),
            ),
        )
        .await
        .expect_err("missing marker must fail");
    assert_eq!(error.code, ErrorCode::InvalidParams);
    assert!(!scratch.join(".dohc/engine/engine.db").exists());
}

#[tokio::test]
async fn clone_marker_cannot_bypass_ts_v1_fingerprint_refusal() {
    let scratch = ScratchDir::new().expect("scratch");
    write_shadow_marker_for_harness(scratch.path(), TOKEN).expect("marker");
    let db_path = scratch.engine_db_path().expect("db path");
    write_fingerprint_db(&db_path, 1).expect("foreign v1 fixture");
    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let error = transport
        .call(
            RequestContext::unbounded(),
            request(
                1,
                "workspace.open",
                None,
                json!({ "rootDir": root_string(&scratch), "workspaceId": "ws-shadow" }),
            ),
        )
        .await
        .expect_err("foreign fingerprint must fail");
    assert_eq!(error.code, ErrorCode::Internal);
}

#[tokio::test]
async fn valid_marker_cannot_claim_an_unstamped_existing_v2_store() {
    let scratch = ScratchDir::new().expect("scratch");
    let db_path = scratch.engine_db_path().expect("db path");
    let initial = {
        let store = EngineStore::open(&db_path, 50).expect("create real v2 store");
        assert!(store.was_freshly_created());
        let ownership = store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT engine_uuid, created_at_ms, engine_build, schema_version \
                     FROM engine_ownership WHERE rowid_guard = 1",
                    [],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, i64>(1)?,
                            row.get::<_, String>(2)?,
                            row.get::<_, i64>(3)?,
                        ))
                    },
                )
            })
            .expect("ownership");
        let first_write_rows: i64 = store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT \
                       (SELECT COUNT(*) FROM versioned_workspaces) + \
                       (SELECT COUNT(*) FROM documents) + \
                       (SELECT COUNT(*) FROM engine_requests) + \
                       (SELECT COUNT(*) FROM replication_journal)",
                    [],
                    |row| row.get(0),
                )
            })
            .expect("first-write rows");
        let shadow_rows = store.table_row_count("shadow_clone").expect("shadow rows");
        (ownership, first_write_rows, shadow_rows)
    };
    assert_eq!(initial.1, 0);
    assert_eq!(initial.2, 0);
    write_shadow_marker_for_harness(scratch.path(), TOKEN).expect("marker");

    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let error = transport
        .call(
            RequestContext::unbounded(),
            request(
                1,
                "workspace.open",
                None,
                json!({ "rootDir": root_string(&scratch), "workspaceId": "ws-shadow" }),
            ),
        )
        .await
        .expect_err("unstamped existing v2 store must be refused");
    assert_eq!(error.code, ErrorCode::InvalidParams);

    let store = EngineStore::open(&db_path, 60).expect("reopen refused store");
    assert!(!store.was_freshly_created());
    let ownership = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT engine_uuid, created_at_ms, engine_build, schema_version \
                 FROM engine_ownership WHERE rowid_guard = 1",
                [],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, i64>(3)?,
                    ))
                },
            )
        })
        .expect("ownership after refusal");
    let first_write_rows: i64 = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT \
                   (SELECT COUNT(*) FROM versioned_workspaces) + \
                   (SELECT COUNT(*) FROM documents) + \
                   (SELECT COUNT(*) FROM engine_requests) + \
                   (SELECT COUNT(*) FROM replication_journal)",
                [],
                |row| row.get(0),
            )
        })
        .expect("first-write rows after refusal");
    assert_eq!(ownership, initial.0);
    assert_eq!(first_write_rows, initial.1);
    assert_eq!(
        store.table_row_count("shadow_clone").expect("shadow rows"),
        0
    );
}
