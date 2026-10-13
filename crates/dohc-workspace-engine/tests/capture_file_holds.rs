//! Outside Markdown refusal is an observed file hold, never a recorded edit.
mod common;

use common::*;
use dohc_engine_collab::{
    ContentKind, DocKey, LocalAppend, MarkerCreation, Regime, WriterDocCache, Ydoc,
};
use dohc_engine_domain::{CaptureIngest, VersionedTextStore};
use dohc_engine_protocol::{
    transport::{EngineTransport, InProcessTransport, RequestContext},
    wire::WorkspaceHandle,
};
use dohc_engine_storage::{EngineStore, NoFaults};
use dohc_engine_testkit::{ScratchDir, engine_db_path};
use dohc_workspace_engine::{EngineService, root_binding::write_root_binding};
use serde_json::{Value, json};
use std::sync::Arc;

const WS: &str = "ws-file-holds";
const HELD: &str = "held.md";
const SEED: &str = "Before.\n";

fn outside() -> String {
    format!("{} too deep\n", "> ".repeat(121))
}

struct Fixture {
    scratch: ScratchDir,
    transport: InProcessTransport<EngineService>,
    handle: WorkspaceHandle,
}

impl Fixture {
    async fn new() -> Self {
        let scratch = ScratchDir::new().unwrap();
        write_root_binding(scratch.path(), TOKEN).unwrap();
        let db = engine_db_path(&scratch).unwrap();
        let mut store = EngineStore::open(&db, 1).unwrap();
        store.bind_root_token(TOKEN, &NoFaults).unwrap();
        VersionedTextStore::new(&mut store)
            .ensure_main_version(WS, "main", 1, &NoFaults)
            .unwrap();
        let head = VersionedTextStore::new(&mut store)
            .capture_ingest(
                &CaptureIngest {
                    workspace_id: WS.into(),
                    version_id: "main".into(),
                    path: HELD.into(),
                    text: SEED.into(),
                    metadata_origin: "capture".into(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: None,
                    now_ms: 2,
                    request_id: None,
                    claim_foreign_head: false,
                },
                &NoFaults,
            )
            .unwrap()
            .snapshot;
        let key = DocKey::new(WS, "main", &head.object_id).unwrap();
        let doc = Ydoc::wire();
        doc.rewrite_content_to_markdown_preserving_source(ContentKind::Richdoc, SEED)
            .unwrap();
        dohc_engine_collab::record_local_update(
            &mut store,
            &mut WriterDocCache::new(),
            &key,
            &doc.encode_full_state(),
            LocalAppend {
                marker: Some(MarkerCreation {
                    path: Some(HELD),
                    content_kind: ContentKind::Richdoc,
                    regime: Regime::LocalOnly,
                }),
                is_seed: true,
                seed_source_sha256: Some(&head.blob_sha256),
                ..Default::default()
            },
            &NoFaults,
            3,
            |_tx, _outcome, _sha| Ok(()),
        )
        .unwrap();
        store.write_with(&NoFaults, |tx| tx.execute(
            "INSERT INTO versions(workspace_id,version_id,kind,name,created_at_ms) VALUES (?1,'later','named','Later',4)",
            [WS]).map_err(dohc_engine_storage::StorageError::persist_public)).unwrap();
        drop(store);
        write_file(scratch.path(), HELD, outside().as_bytes());
        write_file(scratch.path(), "sibling.txt", b"Sibling.\n");
        let transport = InProcessTransport::new(Arc::new(EngineService::new()));
        let opened = transport
            .call(
                RequestContext::unbounded(),
                request(
                    1,
                    "workspace.open",
                    None,
                    json!({"rootDir": scratch.path().to_string_lossy(), "workspaceId": WS}),
                ),
            )
            .await
            .unwrap();
        let handle = serde_json::from_value(opened.result["workspace"].clone()).unwrap();
        let fixture = Self {
            scratch,
            transport,
            handle,
        };
        fixture.scan().await;
        fixture
    }
    async fn scan(&self) -> Value {
        // A full reconcile is a deterministic barrier. Startup may still be
        // importing, so await its decision, without making a sleep a proof.
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(20);
        loop {
            let result = self.call("capture.reconcile", json!({})).await;
            let status = self.status().await;
            if status["phase"] != "starting"
                && status["phase"] != "importing"
                && (result["settled"] == true || status["degraded"] == true)
            {
                return result;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "startup did not decide: {status}"
            );
        }
    }
    async fn call(&self, method: &str, params: Value) -> Value {
        call(&self.transport, &self.handle, 10, method, params).await
    }
    async fn status(&self) -> Value {
        self.call("watcher.status", json!({})).await
    }
    async fn close(&self) {
        self.call("workspace.close", json!({})).await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn capture_hold_leaves_siblings_healthy() {
    let f = Fixture::new().await;
    let status = f.status().await;
    let db = rusqlite::Connection::open(engine_db_path(&f.scratch).unwrap()).unwrap();
    let sibling: String = db.query_row("SELECT b.text FROM snapshots s JOIN blobs b ON b.sha256=s.blob_sha256 WHERE s.workspace_id=?1 AND s.path='sibling.txt'", [WS], |r| r.get(0)).unwrap();
    assert_eq!(sibling, "Sibling.\n");
    assert_eq!(status["degraded"], false, "{status}");
    assert_eq!(status["heldFiles"][0]["path"], HELD);
    assert_eq!(
        status["heldFiles"][0]["observedSha256"],
        dohc_engine_storage::hex_sha256(outside().as_bytes())
    );
    let captured: String = db.query_row("SELECT b.text FROM snapshots s JOIN blobs b ON b.sha256=s.blob_sha256 WHERE s.workspace_id=?1 AND s.path=?2", [WS, HELD], |r| r.get(0)).unwrap();
    assert_eq!(captured, SEED);
    f.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fix1_capture_release_drains_parked_path_without_reopen() {
    let f = Fixture::new().await;
    let db = engine_db_path(&f.scratch).unwrap();
    let conn = rusqlite::Connection::open(&db).unwrap();
    let generation: i64 = conn.query_row("SELECT moment_order FROM moments WHERE workspace_id=?1 AND path=?2 ORDER BY moment_order DESC LIMIT 1", [WS,HELD], |r| r.get(0)).unwrap();
    // A real durable relay intent for the pre-hold head, parked by the same
    // boundary that an incoming relay page uses.
    conn.execute("INSERT INTO materialization_jobs(job_id,workspace_id,target_path,content_sha256,preimage_sha256,target_generation,status,created_at_ms,operation,preimage_present) VALUES ('relay-held-proof',?1,?2,?3,?4,?5,'pending',5,'write',1)",
        rusqlite::params![WS,HELD,dohc_engine_storage::hex_sha256(SEED.as_bytes()),dohc_engine_storage::hex_sha256(outside().as_bytes()),generation]).unwrap();
    std::fs::write(f.scratch.path().join(HELD), "Representable.\n").unwrap();
    f.scan().await;
    assert_eq!(f.status().await["heldFiles"], json!([]));
    let status: String = conn
        .query_row(
            "SELECT status FROM materialization_jobs WHERE job_id='relay-held-proof'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(
        status == "complete" || status == "cancelled",
        "parked job remained {status}"
    );
    assert_eq!(
        std::fs::read_to_string(f.scratch.path().join(HELD)).unwrap(),
        "Representable.\n"
    );
    f.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fix1_unheld_capture_supersedes_older_parked_intent() {
    let f = Fixture::new().await;
    std::fs::write(f.scratch.path().join(HELD), "Representable.\n").unwrap();
    f.scan().await;
    assert_eq!(f.status().await["heldFiles"], json!([]));
    let conn = rusqlite::Connection::open(engine_db_path(&f.scratch).unwrap()).unwrap();
    let (generation, sha): (i64, String) = conn.query_row(
        "SELECT m.moment_order,s.blob_sha256 FROM snapshots s JOIN moments m ON m.workspace_id=s.workspace_id AND m.moment_id=s.latest_moment_id WHERE s.workspace_id=?1 AND s.path=?2",
        [WS, HELD], |r| Ok((r.get(0)?, r.get(1)?)),
    ).unwrap();
    // The old intent's preimage deliberately matches the next outside edit.
    // Unknown-preimage protection alone cannot establish which write is newer.
    conn.execute("INSERT INTO materialization_jobs(job_id,workspace_id,target_path,content_sha256,preimage_sha256,target_generation,status,created_at_ms,operation,preimage_present) VALUES ('relay-unheld-proof',?1,?2,?3,?4,?5,'pending',5,'write',1)",
        rusqlite::params![WS,HELD,sha,dohc_engine_storage::hex_sha256(b"Latest.\n"),generation]).unwrap();
    std::fs::write(f.scratch.path().join(HELD), "Latest.\n").unwrap();
    f.scan().await;
    let status: String = conn
        .query_row(
            "SELECT status FROM materialization_jobs WHERE job_id='relay-unheld-proof'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(
        status == "complete" || status == "cancelled",
        "parked job remained {status}"
    );
    assert_eq!(
        std::fs::read_to_string(f.scratch.path().join(HELD)).unwrap(),
        "Latest.\n"
    );
    f.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn capture_hold_flush_reports_the_file_separately() {
    let f = Fixture::new().await;
    let flush = f.call("capture.flush", json!({})).await;
    assert_eq!(flush["settled"], true, "{flush}");
    assert_eq!(flush["degraded"], false);
    assert_eq!(flush["heldFiles"][0]["path"], HELD);
    f.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn capture_hold_survives_restart_without_another_attempt() {
    let mut f = Fixture::new().await;
    let before = f.status().await;
    f.close().await;
    let opened = f
        .transport
        .call(
            RequestContext::unbounded(),
            request(
                20,
                "workspace.open",
                None,
                json!({"rootDir": f.scratch.path().to_string_lossy(), "workspaceId": WS}),
            ),
        )
        .await
        .unwrap();
    f.handle = serde_json::from_value(opened.result["workspace"].clone()).unwrap();
    f.scan().await;
    let after = f.status().await;
    assert_eq!(after["heldFiles"][0]["path"], HELD, "{after}");
    assert_eq!(
        after["heldFiles"][0]["attemptCount"],
        before["heldFiles"][0]["attemptCount"]
    );
    assert_eq!(
        std::fs::read_to_string(f.scratch.path().join(HELD)).unwrap(),
        outside()
    );
    f.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn capture_hold_retries_changed_bytes() {
    let f = Fixture::new().await;
    assert_eq!(f.status().await["heldFiles"][0]["path"], HELD);
    write_file(f.scratch.path(), HELD, b"Representable now.\n");
    f.scan().await;
    assert_eq!(f.status().await["heldFiles"], json!([]));
    let db = rusqlite::Connection::open(engine_db_path(&f.scratch).unwrap()).unwrap();
    let captured: String = db.query_row("SELECT b.text FROM snapshots s JOIN blobs b ON b.sha256=s.blob_sha256 WHERE s.workspace_id=?1 AND s.path=?2", [WS, HELD], |r| r.get(0)).unwrap();
    assert_eq!(captured, "Representable now.\n");
    f.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn capture_hold_explicit_retry_reoffers_unchanged_bytes() {
    let f = Fixture::new().await;
    let before = f.status().await["heldFiles"][0]["attemptCount"]
        .as_u64()
        .unwrap_or(0);
    let retry = f.call("capture.retryHeld", json!({"path": HELD})).await;
    assert_eq!(retry["retried"], true);
    f.scan().await;
    let status = f.status().await;
    assert_eq!(status["heldFiles"][0]["attemptCount"], before + 1);
    assert_eq!(status["degraded"], false);
    assert_eq!(
        std::fs::read_to_string(f.scratch.path().join(HELD)).unwrap(),
        outside()
    );
    f.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn capture_hold_refuses_live_open() {
    let f = Fixture::new().await;
    let error = call_error(
        &f.transport,
        &f.handle,
        30,
        "ydoc.open",
        json!({"versionId":"main","path":HELD,"contentKind":"richdoc"}),
    )
    .await;
    assert!(
        error.message.contains("capture-file-held") && error.message.contains(HELD),
        "{error:?}"
    );
    assert_eq!(
        std::fs::read_to_string(f.scratch.path().join(HELD)).unwrap(),
        outside()
    );
    f.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn capture_hold_switch_refusal_names_the_file() {
    let f = Fixture::new().await;
    let error = call_error(
        &f.transport,
        &f.handle,
        30,
        "versions.createNamed",
        json!({"workspaceId":WS,"name":"Held fork","fromVersionId":"main"}),
    )
    .await;
    assert!(error.message.contains(HELD), "{error:?}");
    f.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn capture_hold_active_switch_refusal_names_the_file() {
    let f = Fixture::new().await;
    let error = call_error(
        &f.transport,
        &f.handle,
        31,
        "versions.setActive",
        json!({"workspaceId":WS,"versionId":"later"}),
    )
    .await;
    assert!(error.message.contains(HELD), "{error:?}");
    let db = rusqlite::Connection::open(engine_db_path(&f.scratch).unwrap()).unwrap();
    let active: String = db
        .query_row(
            "SELECT COALESCE((SELECT version_id FROM active_versions WHERE workspace_id=?1), (SELECT main_version_id FROM versioned_workspaces WHERE workspace_id=?1))",
            [WS],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(active, "main");
    assert_eq!(
        std::fs::read_to_string(f.scratch.path().join(HELD)).unwrap(),
        outside()
    );
    f.close().await;
}

#[cfg(windows)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fix1_released_path_drains_despite_sibling_io_failure() {
    use std::os::windows::fs::OpenOptionsExt;
    let f = Fixture::new().await;
    let conn = rusqlite::Connection::open(engine_db_path(&f.scratch).unwrap()).unwrap();
    let generation: i64 = conn.query_row("SELECT moment_order FROM moments WHERE workspace_id=?1 AND path=?2 ORDER BY moment_order DESC LIMIT 1", [WS,HELD], |r| r.get(0)).unwrap();
    conn.execute("INSERT INTO materialization_jobs(job_id,workspace_id,target_path,content_sha256,preimage_sha256,target_generation,status,created_at_ms,operation,preimage_present) VALUES ('relay-partial-proof',?1,?2,?3,?4,?5,'pending',5,'write',1)",
        rusqlite::params![WS,HELD,dohc_engine_storage::hex_sha256(SEED.as_bytes()),dohc_engine_storage::hex_sha256(outside().as_bytes()),generation]).unwrap();
    std::fs::write(f.scratch.path().join(HELD), "Representable.\n").unwrap();
    std::fs::write(
        f.scratch.path().join("sibling.txt"),
        "Changed, but unreadable.\n",
    )
    .unwrap();
    let locked = std::fs::OpenOptions::new()
        .read(true)
        .share_mode(0)
        .open(f.scratch.path().join("sibling.txt"))
        .unwrap();
    f.scan().await;
    let capture = f.status().await;
    let status: String = conn
        .query_row(
            "SELECT status FROM materialization_jobs WHERE job_id='relay-partial-proof'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let disk = std::fs::read_to_string(f.scratch.path().join(HELD)).unwrap();
    drop(locked);
    f.close().await;
    assert_eq!(capture["heldFiles"], json!([]), "{capture}");
    assert_eq!(
        capture["degraded"], true,
        "real I/O failure must remain degraded: {capture}"
    );
    assert!(
        status == "complete" || status == "cancelled",
        "released path's parked job remained {status}"
    );
    assert_eq!(disk, "Representable.\n");
}
