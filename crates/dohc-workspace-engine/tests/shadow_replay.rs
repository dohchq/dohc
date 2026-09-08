use base64::Engine as _;
use dohc_engine_collab::{ContentKind, DocKey, Ydoc, load_persisted};
use dohc_engine_domain::VersionedTextStore;
use dohc_engine_protocol::{
    error::ErrorCode,
    transport::{EngineTransport, InProcessTransport, RequestContext},
    wire::{Request, WorkspaceHandle},
};
use dohc_engine_storage::EngineStore;
use dohc_engine_testkit::{ScratchDir, engine_db_path, harness::write_fingerprint_db};
use dohc_workspace_engine::{EngineService, root_binding::read_root_binding};
use serde_json::{Value, json};
use std::sync::Arc;

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

async fn open_bound_root(
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
async fn root_bound_replay_composes_real_domains_end_to_end() {
    let scratch = ScratchDir::new().expect("scratch");
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
                    "origin": "api",
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
    let opened = transport
        .call(
            RequestContext::unbounded(),
            request(
                4,
                "ydoc.open",
                Some(handle.clone()),
                json!({
                    "versionId": "main",
                    "path": "notes/hello.md",
                    "contentKind": "plaintext"
                }),
            ),
        )
        .await
        .expect("ydoc open");
    let session_id = opened.result["sessionId"].as_str().expect("session id");
    transport
        .call(
            RequestContext::unbounded(),
            request(
                40,
                "ydoc.recordUpdate",
                Some(handle.clone()),
                json!({
                    "sessionId": session_id,
                    "updateBase64": base64::engine::general_purpose::STANDARD.encode(update)
                }),
            ),
        )
        .await
        .expect("record Y.Doc update");

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
    assert_eq!(
        conflicts.result,
        json!({ "conflicts": [], "nextAfterConflictId": null })
    );

    let search = transport
        .call(
            RequestContext::unbounded(),
            request(
                6,
                "search.queryPage",
                Some(handle.clone()),
                json!({ "query": "shadow", "nowMs": 102 }),
            ),
        )
        .await
        .expect("search");
    assert_eq!(search.result["results"][0]["path"], "notes/hello.md");

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

    let db_path = engine_db_path(&scratch).expect("db path");
    let mut store = EngineStore::open(&db_path, 103).expect("reopen after actor close");
    assert!(!store.was_freshly_created());
    let bound_token: String = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT token FROM shadow_clone WHERE rowid_guard = 1",
                [],
                |row| row.get(0),
            )
        })
        .expect("bound token");
    // The daemon minted the binding on first open and stamped the store with it.
    assert_eq!(
        read_root_binding(scratch.path()).expect("root binding"),
        Some(bound_token)
    );
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
        persisted
            .doc
            .project(ContentKind::Plaintext)
            .expect("bounded plaintext projection")
            .content,
        "benign"
    );
}

#[tokio::test]
async fn local_conflict_open_rejects_snapshot_hash_mismatch_without_persistence() {
    let scratch = ScratchDir::new().expect("scratch");
    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let handle = open_bound_root(&transport, &scratch, 1).await;
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

    let db_path = engine_db_path(&scratch).expect("db path");
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
async fn a_ts_v1_fingerprint_is_refused_before_binding() {
    let scratch = ScratchDir::new().expect("scratch");
    let db_path = engine_db_path(&scratch).expect("db path");
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
async fn an_existing_store_under_an_unbound_root_is_refused() {
    let scratch = ScratchDir::new().expect("scratch");
    let db_path = engine_db_path(&scratch).expect("db path");
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
                       (SELECT COUNT(*) FROM engine_requests)",
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
        .expect_err("an existing store under an unbound root must be refused");
    assert_eq!(error.code, ErrorCode::InvalidParams);
    assert_eq!(error.message, "engine database is bound to another root");

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
                   (SELECT COUNT(*) FROM engine_requests)",
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

/// A workspace's engine.db copied under another root is refused, whether the
/// other root has no binding or its own.
#[tokio::test]
async fn an_engine_db_copied_to_another_root_is_refused() {
    let source = ScratchDir::new().expect("source");
    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let handle = open_bound_root(&transport, &source, 1).await;
    transport
        .call(
            RequestContext::unbounded(),
            request(2, "workspace.close", Some(handle), json!({})),
        )
        .await
        .expect("close source");
    let source_db = engine_db_path(&source).expect("source db");

    let unbound = ScratchDir::new().expect("unbound root");
    std::fs::copy(&source_db, engine_db_path(&unbound).expect("unbound db")).expect("copy db");
    let error = transport
        .call(
            RequestContext::unbounded(),
            request(
                3,
                "workspace.open",
                None,
                json!({ "rootDir": root_string(&unbound), "workspaceId": "ws-shadow" }),
            ),
        )
        .await
        .expect_err("a copied database under an unbound root must be refused");
    assert_eq!(error.message, "engine database is bound to another root");

    let other = ScratchDir::new().expect("other root");
    let other_handle = open_bound_root(&transport, &other, 4).await;
    transport
        .call(
            RequestContext::unbounded(),
            request(5, "workspace.close", Some(other_handle), json!({})),
        )
        .await
        .expect("close other");
    std::fs::copy(&source_db, engine_db_path(&other).expect("other db")).expect("overwrite db");
    let error = transport
        .call(
            RequestContext::unbounded(),
            request(
                6,
                "workspace.open",
                None,
                json!({ "rootDir": root_string(&other), "workspaceId": "ws-shadow" }),
            ),
        )
        .await
        .expect_err("a copied database under another root's binding must be refused");
    assert_eq!(error.message, "engine database is bound to another root");
}

async fn open_error(
    transport: &InProcessTransport<EngineService>,
    scratch: &ScratchDir,
    request_id: u64,
    read_only: bool,
) -> dohc_engine_protocol::error::WireError {
    transport
        .call(
            RequestContext::unbounded(),
            request(
                request_id,
                "workspace.open",
                None,
                json!({
                    "rootDir": root_string(scratch),
                    "workspaceId": "ws-shadow",
                    "skipStartupMaintenance": read_only,
                }),
            ),
        )
        .await
        .expect_err("open must be refused")
}

fn engine_files(scratch: &ScratchDir) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(scratch.join(".dohc/engine"))
        .map(|entries| {
            entries
                .map(|entry| {
                    entry
                        .expect("entry")
                        .file_name()
                        .to_string_lossy()
                        .into_owned()
                })
                .collect()
        })
        .unwrap_or_default();
    names.sort();
    names
}

/// A fresh root whose binding is malformed refuses with the binding's
/// cause, both times, and leaves no engine.db behind to turn the second
/// open into a mismatch.
/// The persistent writer lock inode survives a refused open.
#[tokio::test]
async fn a_fresh_root_with_a_malformed_binding_refuses_twice_and_keeps_no_store() {
    let scratch = ScratchDir::new().expect("scratch");
    std::fs::create_dir_all(scratch.join(".dohc/engine")).expect("engine dir");
    std::fs::write(scratch.join(".dohc/engine/ROOT_BINDING"), "0123456789").expect("planted");
    let transport = InProcessTransport::new(Arc::new(EngineService::new()));

    for id in [1, 2] {
        let error = open_error(&transport, &scratch, id, false).await;
        assert_eq!(error.code, ErrorCode::InvalidParams);
        assert_eq!(error.message, "workspace root binding is malformed");
        assert_eq!(engine_files(&scratch), vec!["ROOT_BINDING".to_owned()]);
    }
}

/// A read-only open never binds. Under an unbound root with an existing
/// store it refuses, writes no binding, and leaves the store's bytes alone.
#[tokio::test]
async fn a_read_only_open_of_an_unbound_root_with_a_store_is_refused_untouched() {
    let scratch = ScratchDir::new().expect("scratch");
    let db_path = engine_db_path(&scratch).expect("db path");
    drop(EngineStore::open(&db_path, 50).expect("create store"));
    let before = std::fs::read(&db_path).expect("store bytes");

    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let error = open_error(&transport, &scratch, 1, true).await;
    assert_eq!(error.code, ErrorCode::InvalidParams);
    assert_eq!(error.message, "engine database is bound to another root");
    assert_eq!(read_root_binding(scratch.path()).expect("read"), None);
    assert_eq!(std::fs::read(&db_path).expect("store bytes"), before);
}
