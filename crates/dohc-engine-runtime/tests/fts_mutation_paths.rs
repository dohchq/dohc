use std::sync::Arc;

use dohc_engine_collab::{ContentKind, Regime};
use dohc_engine_domain::{CaptureIngest, CaptureIngestBinary, CaptureRetire, WriteBinary};
use dohc_engine_runtime::{
    CancellationToken, NoFaults, SearchResult, SelfWriteRecorder, WorkspaceSupervisor,
};
use dohc_engine_storage::EngineStore;
use dohc_engine_testkit::ScratchDir;

const VERSION: &str = "main";

struct NoRecorder;

impl SelfWriteRecorder for NoRecorder {
    fn record(&self, _workspace_id: &str, _path: &str, _sha256: &str) {}
    fn retract(&self, _workspace_id: &str, _path: &str, _sha256: &str) {}
}

fn capture_text(workspace_id: &str, path: &str, text: &str, now_ms: i64) -> CaptureIngest {
    CaptureIngest {
        workspace_id: workspace_id.to_owned(),
        version_id: VERSION.to_owned(),
        path: path.to_owned(),
        text: text.to_owned(),
        metadata_origin: "capture".to_owned(),
        author_json: None,
        now_ms,
        request_id: None,
        claim_foreign_head: true,
    }
}

async fn search(
    actor: &dohc_engine_runtime::ActorHandle,
    root: &std::path::Path,
    workspace_id: &str,
    query: &str,
    now_ms: i64,
) -> Vec<SearchResult> {
    actor
        .search(
            root.to_path_buf(),
            workspace_id.to_owned(),
            VERSION.to_owned(),
            query.to_owned(),
            Some(100),
            now_ms,
            CancellationToken::new(),
        )
        .await
        .expect("search")
}

#[tokio::test]
async fn capture_text_ingest_and_retire_update_certified_search_index() {
    const WS: &str = "ws-capture-fts";
    const PATH: &str = "notes/captured.md";
    const NEEDLE: &str = "capturemutationneedle";
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 1).expect("open actor").actor;

    actor
        .capture_ingest(
            capture_text(WS, "notes/baseline.md", "baseline", 10),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("seed capture");
    actor
        .ensure_search_index(
            scratch.path().to_path_buf(),
            WS.to_owned(),
            VERSION.to_owned(),
            20,
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("certify index before tested mutation");

    actor
        .capture_ingest_indexed(
            capture_text(WS, PATH, NEEDLE, 30),
            scratch.path().to_path_buf(),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("capture indexed text");
    let ingested = search(&actor, scratch.path(), WS, NEEDLE, 40).await;
    assert_eq!(
        ingested
            .iter()
            .map(|result| result.path.as_str())
            .collect::<Vec<_>>(),
        [PATH],
        "capture ingest must become visible without relying on an index rebuild"
    );

    actor
        .capture_retire(
            CaptureRetire {
                workspace_id: WS.to_owned(),
                version_id: VERSION.to_owned(),
                path: PATH.to_owned(),
                now_ms: 50,
                request_id: None,
                only_if_text_head: false,
                only_if_capture_origin: true,
            },
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("retire captured text");
    let retired = search(&actor, scratch.path(), WS, NEEDLE, 60).await;
    assert!(
        retired.is_empty(),
        "capture retire must remove the stale search result, got {retired:?}"
    );

    supervisor.close(&db).expect("close actor");
}

#[tokio::test]
async fn aliased_database_capture_uses_session_root_and_indexes() {
    const WS: &str = "ws-aliased-capture-fts";
    const PATH: &str = "notes/aliased.md";
    const NEEDLE: &str = "aliasedcapturemutationneedle";
    let scratch = ScratchDir::new().expect("scratch");
    let canonical_db = scratch.engine_db_path().expect("canonical db");
    drop(EngineStore::open(&canonical_db, 1).expect("create canonical db"));
    let alias_dir = scratch.path().join("database-alias");
    std::fs::create_dir_all(&alias_dir).expect("alias dir");
    let aliased_db = alias_dir.join("not-the-canonical-name.db");
    std::fs::hard_link(&canonical_db, &aliased_db).expect("hard-link database alias");

    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor
        .open(&aliased_db, 2)
        .expect("open actor through alias")
        .actor;
    actor
        .ensure_search_index(
            scratch.path().to_path_buf(),
            WS.to_owned(),
            VERSION.to_owned(),
            10,
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("certify index");

    let captured = actor
        .capture_ingest_indexed(
            capture_text(WS, PATH, NEEDLE, 20),
            scratch.path().to_path_buf(),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("capture through aliased database");
    assert_eq!(captured.snapshot.path, PATH);
    assert_eq!(
        search(&actor, scratch.path(), WS, NEEDLE, 30)
            .await
            .iter()
            .map(|result| result.path.as_str())
            .collect::<Vec<_>>(),
        [PATH],
        "capture must use the session root instead of parsing the database alias"
    );

    supervisor.close(&aliased_db).expect("close aliased actor");
}

#[tokio::test]
async fn ydoc_settle_replaces_old_search_content_with_projected_text() {
    const WS: &str = "ws-ydoc-settle-fts";
    const PATH: &str = "notes/live.md";
    const OLD: &str = "oldsettlemutationneedle";
    const NEW: &str = "newsettlemutationneedle";
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    std::fs::create_dir_all(scratch.path().join("notes")).expect("notes dir");
    std::fs::write(scratch.path().join(PATH), OLD).expect("seed disk preimage");

    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 1).expect("open actor").actor;
    actor
        .capture_ingest(
            capture_text(WS, PATH, OLD, 10),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("seed captured head");
    actor
        .ensure_search_index(
            scratch.path().to_path_buf(),
            WS.to_owned(),
            VERSION.to_owned(),
            20,
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("certify old index");
    assert_eq!(search(&actor, scratch.path(), WS, OLD, 21).await.len(), 1);

    let open = actor
        .ydoc_open_state(
            WS.to_owned(),
            30,
            true,
            None,
            VERSION.to_owned(),
            PATH.to_owned(),
            Some(ContentKind::Plaintext),
            CancellationToken::new(),
        )
        .await
        .expect("open ydoc");
    let update = dohc_engine_collab::Ydoc::wire().plaintext_insert(0, NEW);
    actor
        .ydoc_record_update(
            open.key.clone(),
            PATH.to_owned(),
            ContentKind::Plaintext,
            Regime::LocalOnly,
            update,
            None,
            true,
            None,
            40,
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("record ydoc edit");
    actor
        .ydoc_settle(
            scratch.path().to_path_buf(),
            open.key,
            PATH.to_owned(),
            ContentKind::Plaintext,
            open.head_blob_sha256,
            "fts-settle-session".to_owned(),
            Arc::new(NoRecorder),
            50,
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("settle ydoc");

    let new_hits = search(&actor, scratch.path(), WS, NEW, 60).await;
    assert_eq!(
        new_hits
            .iter()
            .map(|result| result.path.as_str())
            .collect::<Vec<_>>(),
        [PATH],
        "settle must index the projected text in its mutation transaction"
    );
    let old_hits = search(&actor, scratch.path(), WS, OLD, 61).await;
    assert!(
        old_hits.is_empty(),
        "settle must remove the old indexed body, got {old_hits:?}"
    );

    supervisor.close(&db).expect("close actor");
}

#[tokio::test]
async fn binary_capture_matches_rpc_binary_write_search_index_behavior() {
    const WS: &str = "ws-binary-capture-fts";
    const CAPTURE_PATH: &str = "capture.bin.md";
    const RPC_PATH: &str = "rpc.bin.md";
    const NEEDLE: &str = "binaryconversionmutationneedle";
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    std::fs::write(scratch.path().join(CAPTURE_PATH), NEEDLE).expect("capture disk preimage");
    std::fs::write(scratch.path().join(RPC_PATH), NEEDLE).expect("rpc disk preimage");

    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 1).expect("open actor").actor;
    let capture_head = actor
        .capture_ingest(
            capture_text(WS, CAPTURE_PATH, NEEDLE, 10),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("seed capture path");
    let rpc_head = actor
        .capture_ingest(
            capture_text(WS, RPC_PATH, NEEDLE, 11),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("seed rpc path");
    let capture_object_id = capture_head.snapshot.object_id.clone();
    let rpc_object_id = rpc_head.snapshot.object_id.clone();
    actor
        .ensure_search_index(
            scratch.path().to_path_buf(),
            WS.to_owned(),
            VERSION.to_owned(),
            20,
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("certify text index");
    assert_eq!(
        search(&actor, scratch.path(), WS, NEEDLE, 21).await.len(),
        2
    );

    actor
        .capture_ingest_binary(
            CaptureIngestBinary {
                workspace_id: WS.to_owned(),
                version_id: VERSION.to_owned(),
                path: CAPTURE_PATH.to_owned(),
                bytes: vec![0xff, 0x00, 0x01],
                metadata_origin: "capture".to_owned(),
                author_json: None,
                now_ms: 30,
                request_id: None,
                claim_foreign_head: true,
            },
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("binary capture");
    actor
        .versioned_binary_write(
            WriteBinary {
                workspace_id: WS.to_owned(),
                version_id: VERSION.to_owned(),
                object_id: rpc_object_id.clone(),
                path: RPC_PATH.to_owned(),
                bytes: vec![0xfe, 0x02, 0x03],
                moment_id: "rpc-binary-conversion".to_owned(),
                metadata_origin: "api".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 31,
                request_id: None,
            },
            scratch.path().to_path_buf(),
            Arc::new(NoRecorder),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("rpc binary write");

    let hits = search(&actor, scratch.path(), WS, NEEDLE, 40).await;
    assert!(
        hits.is_empty(),
        "binary capture must delete its text FTS row just like RPC binary write; \
         capture object {}, hits {hits:?}",
        capture_object_id
    );

    supervisor.close(&db).expect("close actor");
    let store = EngineStore::open(&db, 50).expect("reopen store");
    let indexed_rows = store
        .read_with(|connection| {
            connection.query_row(
                "SELECT \
                   COALESCE(SUM(CASE WHEN object_id=?1 THEN 1 ELSE 0 END), 0), \
                   COALESCE(SUM(CASE WHEN object_id=?2 THEN 1 ELSE 0 END), 0) \
                 FROM engine_search_files_fts WHERE workspace_id=?3 AND version_id=?4",
                rusqlite::params![capture_object_id, rpc_object_id, WS, VERSION],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
            )
        })
        .expect("inspect binary FTS rows");
    assert_eq!(
        indexed_rows,
        (0, 0),
        "capture and RPC binary writes must both delete the prior text FTS row"
    );
}
