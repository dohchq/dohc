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
use rusqlite::OptionalExtension;
use serde_json::{Value, json};
use std::sync::Arc;

const WS: &str = "ws-file-holds";
const HELD: &str = "held.md";
const SEED: &str = "Before.\n";

#[cfg(windows)]
fn assert_stored_leaf(root: &std::path::Path, leaf: &str) {
    assert!(
        std::fs::read_dir(root)
            .unwrap()
            .any(|entry| entry.unwrap().file_name() == leaf),
        "the selected version must publish its own spelling: {leaf}"
    );
}

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
        Self::with_target(None).await
    }
    async fn with_target(target_path: Option<&str>) -> Self {
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
        if let Some(path) = target_path {
            VersionedTextStore::new(&mut store)
                .capture_ingest(
                    &CaptureIngest {
                        workspace_id: WS.into(),
                        version_id: "later".into(),
                        path: path.into(),
                        text: "Target version.\n".into(),
                        metadata_origin: "capture".into(),
                        metadata_summary: None,
                        metadata_correlation_id: None,
                        author_json: None,
                        now_ms: 5,
                        request_id: None,
                        claim_foreign_head: false,
                    },
                    &NoFaults,
                )
                .unwrap();
        }
        drop(store);
        write_file(scratch.path(), HELD, outside().as_bytes());
        write_file(scratch.path(), "sibling.txt", b"Sibling.\n");
        let transport = InProcessTransport::new(Arc::new(EngineService::new()));
        let opened = call_with_busy_retry(
            &transport,
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
    async fn reopen(&mut self) {
        self.close().await;
        self.transport = InProcessTransport::new(Arc::new(EngineService::new()));
        let opened = call_with_busy_retry(
            &self.transport,
            RequestContext::unbounded(),
            request(
                1,
                "workspace.open",
                None,
                json!({"rootDir":self.scratch.path().to_string_lossy(),"workspaceId":WS}),
            ),
        )
        .await
        .unwrap();
        self.handle = serde_json::from_value(opened.result["workspace"].clone()).unwrap();
        self.scan().await;
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
    let opened = call_with_busy_retry(
        &f.transport,
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
async fn capture_hold_named_version_keeps_the_outside_edit_pinned() {
    let f = Fixture::new().await;
    let result = call(
        &f.transport,
        &f.handle,
        30,
        "versions.createNamed",
        json!({"workspaceId":WS,"name":"Held fork","fromVersionId":"main"}),
    )
    .await;
    assert!(result.is_object(), "{result}");
    assert_eq!(f.status().await["heldFiles"][0]["path"], HELD);
    assert_eq!(
        std::fs::read_to_string(f.scratch.path().join(HELD)).unwrap(),
        outside()
    );
    f.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn capture_hold_switches_away_and_back_without_adopting_outside_bytes() {
    let f = Fixture::new().await;
    let before = f.status().await["heldFiles"].clone();
    let result = call(
        &f.transport,
        &f.handle,
        31,
        "versions.setActive",
        json!({"workspaceId":WS,"versionId":"later"}),
    )
    .await;
    assert!(result.is_object(), "{result}");
    let db = rusqlite::Connection::open(engine_db_path(&f.scratch).unwrap()).unwrap();
    let active: String = db
        .query_row(
            "SELECT COALESCE((SELECT version_id FROM active_versions WHERE workspace_id=?1), (SELECT main_version_id FROM versioned_workspaces WHERE workspace_id=?1))",
            [WS],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(active, "later");
    f.scan().await;
    assert_eq!(f.status().await["heldFiles"], before);
    let adopted: i64 = db.query_row("SELECT COUNT(*) FROM snapshots WHERE workspace_id=?1 AND version_id='later' AND path=?2", [WS, HELD], |r| r.get(0)).unwrap();
    assert_eq!(adopted, 0);
    assert_eq!(
        std::fs::read_to_string(f.scratch.path().join(HELD)).unwrap(),
        outside()
    );
    f.call(
        "versions.setActive",
        json!({"workspaceId":WS,"versionId":"main"}),
    )
    .await;
    f.scan().await;
    assert_eq!(f.status().await["heldFiles"], before);
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

async fn switch_hold_release(action: &str) {
    let mut f = Fixture::new().await;
    f.call(
        "versions.setActive",
        json!({"workspaceId":WS,"versionId":"later"}),
    )
    .await;
    let repaired = "Repaired in the source version.\n";
    match action {
        "delete" => std::fs::remove_file(f.scratch.path().join(HELD)).unwrap(),
        "rename" => std::fs::rename(
            f.scratch.path().join(HELD),
            f.scratch.path().join("renamed.md"),
        )
        .unwrap(),
        _ => {
            std::fs::write(f.scratch.path().join(HELD), repaired).unwrap();
            if action == "retry" {
                f.call("capture.retryHeld", json!({"path":HELD})).await;
            }
        }
    }
    f.scan().await;
    assert_eq!(f.status().await["heldFiles"], json!([]));
    let conn = rusqlite::Connection::open(engine_db_path(&f.scratch).unwrap()).unwrap();
    let texts: Vec<(String, String)> = conn.prepare("SELECT s.version_id,b.text FROM snapshots s JOIN blobs b ON b.sha256=s.blob_sha256 WHERE s.workspace_id=?1 AND s.path=?2 ORDER BY s.version_id").unwrap()
        .query_map([WS,HELD], |r| Ok((r.get(0)?,r.get(1)?))).unwrap().collect::<Result<_,_>>().unwrap();
    if action == "delete" || action == "rename" {
        assert!(texts.is_empty(), "{texts:?}");
    } else {
        assert_eq!(texts, vec![("main".to_owned(), repaired.to_owned())]);
    }
    let pending: i64 = conn.query_row("SELECT COUNT(*) FROM materialization_jobs WHERE workspace_id=?1 AND target_path=?2 AND status='pending'", [WS,HELD], |r| r.get(0)).unwrap();
    assert_eq!(pending, 0, "release must drain the parked delete");
    assert!(
        !f.scratch.path().join(HELD).exists(),
        "the selected version has no held path"
    );
    f.reopen().await;
    let target_count: i64 = conn.query_row("SELECT COUNT(*) FROM snapshots WHERE workspace_id=?1 AND version_id='later' AND path=?2", [WS,HELD], |r| r.get(0)).unwrap();
    assert_eq!(
        target_count, 0,
        "reseed must not adopt the source version's repaired bytes"
    );
    assert!(!f.scratch.path().join(HELD).exists());
    f.call(
        "versions.setActive",
        json!({"workspaceId":WS,"versionId":"main"}),
    )
    .await;
    if action == "change" || action == "retry" {
        assert_eq!(
            std::fs::read_to_string(f.scratch.path().join(HELD)).unwrap(),
            repaired
        );
    }
    f.reopen().await;
    let source_text: Option<String> = conn.query_row("SELECT b.text FROM snapshots s JOIN blobs b ON b.sha256=s.blob_sha256 WHERE s.workspace_id=?1 AND s.version_id='main' AND s.path=?2", [WS,HELD], |r| r.get(0)).optional().unwrap();
    assert_eq!(
        source_text.as_deref(),
        if action == "change" || action == "retry" {
            Some(repaired)
        } else {
            None
        }
    );
    assert_eq!(
        std::fs::read_to_string(f.scratch.path().join(HELD)).ok(),
        source_text
    );
    f.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn switch_hold_change_recovers_the_source_version() {
    switch_hold_release("change").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn switch_hold_delete_recovers_the_source_version() {
    switch_hold_release("delete").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn switch_hold_rename_recovers_the_source_version() {
    switch_hold_release("rename").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn switch_hold_retry_recovers_the_source_version() {
    switch_hold_release("retry").await;
}

async fn switch_hold_rewrite_release(target_path: &str) {
    let mut f = Fixture::with_target(Some(target_path)).await;
    if target_path != HELD && !f.scratch.path().join(target_path).exists() {
        f.close().await;
        return;
    }
    let before = f.status().await["heldFiles"].clone();
    f.call(
        "versions.setActive",
        json!({"workspaceId":WS,"versionId":"later"}),
    )
    .await;
    f.scan().await;
    assert_eq!(f.status().await["heldFiles"], before);
    assert_eq!(
        std::fs::read_to_string(f.scratch.path().join(HELD)).unwrap(),
        outside()
    );
    f.call(
        "versions.setActive",
        json!({"workspaceId":WS,"versionId":"main"}),
    )
    .await;
    assert_eq!(f.status().await["heldFiles"], before);
    assert_eq!(
        std::fs::read_to_string(f.scratch.path().join(HELD)).unwrap(),
        outside()
    );
    f.call(
        "versions.setActive",
        json!({"workspaceId":WS,"versionId":"later"}),
    )
    .await;
    let repaired = "Repaired outside edit.\n";
    std::fs::write(f.scratch.path().join(HELD), repaired).unwrap();
    f.scan().await;
    assert_eq!(f.status().await["heldFiles"], json!([]));
    assert_eq!(
        std::fs::read_to_string(f.scratch.path().join(HELD)).unwrap(),
        "Target version.\n"
    );
    let conn = rusqlite::Connection::open(engine_db_path(&f.scratch).unwrap()).unwrap();
    #[cfg(windows)]
    assert_stored_leaf(f.scratch.path(), target_path);
    let source: String = conn.query_row("SELECT b.text FROM snapshots s JOIN blobs b ON b.sha256=s.blob_sha256 WHERE s.workspace_id=?1 AND s.version_id='main' AND s.path=?2", [WS,HELD], |r| r.get(0)).unwrap();
    let target: String = conn.query_row("SELECT b.text FROM snapshots s JOIN blobs b ON b.sha256=s.blob_sha256 WHERE s.workspace_id=?1 AND s.version_id='later' AND s.path=?2", [WS,target_path], |r| r.get(0)).unwrap();
    assert_eq!(source, repaired);
    assert_eq!(target, "Target version.\n");
    let pending: i64 = conn.query_row("SELECT COUNT(*) FROM materialization_jobs WHERE workspace_id=?1 AND status='pending' AND job_id GLOB 'version-switch-mat_*'", [WS], |r| r.get(0)).unwrap();
    assert_eq!(pending, 0);
    let mut conflicts = Vec::new();
    for entry in std::fs::read_dir(f.scratch.path()).unwrap() {
        let entry = entry.unwrap();
        if entry.file_name().to_string_lossy().contains("conflict") {
            conflicts.push(std::fs::read_to_string(entry.path()).unwrap());
        }
    }
    assert!(
        conflicts.is_empty(),
        "captured bytes are safe in the source version: {conflicts:?}"
    );
    f.reopen().await;
    let target_after_restart: String = conn.query_row("SELECT b.text FROM snapshots s JOIN blobs b ON b.sha256=s.blob_sha256 WHERE s.workspace_id=?1 AND s.version_id='later' AND s.path=?2", [WS,target_path], |r| r.get(0)).unwrap();
    assert_eq!(target_after_restart, target);
    assert_eq!(
        std::fs::read_to_string(f.scratch.path().join(target_path)).unwrap(),
        target
    );
    if target_path == HELD {
        f.call(
            "versions.setActive",
            json!({"workspaceId":WS,"versionId":"main"}),
        )
        .await;
        assert_eq!(
            std::fs::read_to_string(f.scratch.path().join(HELD)).unwrap(),
            repaired
        );
    }
    if target_path == HELD {
        f.reopen().await;
        let source_after_restart: String = conn.query_row("SELECT b.text FROM snapshots s JOIN blobs b ON b.sha256=s.blob_sha256 WHERE s.workspace_id=?1 AND s.version_id='main' AND s.path=?2", [WS,HELD], |r| r.get(0)).unwrap();
        assert_eq!(source_after_restart, repaired);
        assert_eq!(
            std::fs::read_to_string(f.scratch.path().join(HELD)).unwrap(),
            source_after_restart
        );
    }
    f.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn switch_hold_rewrite_release_preserves_both_versions() {
    switch_hold_rewrite_release(HELD).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn switch_hold_case_alias_release_preserves_both_versions() {
    switch_hold_rewrite_release("HELD.MD").await;
}

#[cfg(windows)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn switching_versions_with_equal_bytes_preserves_the_selected_spelling() {
    let mut f = Fixture::with_target(Some("HELD.MD")).await;
    if !f.scratch.path().join("HELD.MD").exists() {
        f.close().await;
        return;
    }
    std::fs::write(f.scratch.path().join(HELD), "Target version.\n").unwrap();
    f.scan().await;
    assert_eq!(f.status().await["heldFiles"], json!([]));
    for (version, path) in [("later", "HELD.MD"), ("main", HELD)] {
        f.call(
            "versions.setActive",
            json!({"workspaceId":WS,"versionId":version}),
        )
        .await;
        assert_stored_leaf(f.scratch.path(), path);
        f.reopen().await;
        let conn = rusqlite::Connection::open(engine_db_path(&f.scratch).unwrap()).unwrap();
        let text: String = conn.query_row("SELECT b.text FROM snapshots s JOIN blobs b ON b.sha256=s.blob_sha256 WHERE s.workspace_id=?1 AND s.version_id=?2 AND s.path=?3", [WS,version,path], |r| r.get(0)).unwrap();
        assert_eq!(text, "Target version.\n");
    }
    f.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn review_round_trip_then_repair_makes_no_conflict_copies() {
    let mut f = Fixture::with_target(Some(HELD)).await;
    for version in ["later", "main"] {
        f.call(
            "versions.setActive",
            json!({"workspaceId":WS,"versionId":version}),
        )
        .await;
    }
    let repaired = "Repair while the source version is selected.\n";
    std::fs::write(f.scratch.path().join(HELD), repaired).unwrap();
    f.scan().await;
    assert_eq!(f.status().await["heldFiles"], json!([]));
    let conflicts: Vec<_> = std::fs::read_dir(f.scratch.path())
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .filter(|name| name.to_string_lossy().contains("conflict"))
        .collect();
    assert!(
        conflicts.is_empty(),
        "obsolete switch intents produced copies: {conflicts:?}"
    );
    f.reopen().await;
    assert_eq!(
        std::fs::read_to_string(f.scratch.path().join(HELD)).unwrap(),
        repaired
    );
    let conn = rusqlite::Connection::open(engine_db_path(&f.scratch).unwrap()).unwrap();
    let target: String=conn.query_row("SELECT b.text FROM snapshots s JOIN blobs b ON b.sha256=s.blob_sha256 WHERE s.workspace_id=?1 AND s.version_id='later' AND s.path=?2", [WS,HELD], |r| r.get(0)).unwrap();
    assert_eq!(target, "Target version.\n");
    f.close().await;
}

async fn review2_ancestor_release(repair: bool) {
    let child = "held.md/trip.md";
    let mut f = Fixture::with_target(Some(child)).await;
    f.call(
        "versions.setActive",
        json!({"workspaceId":WS,"versionId":"later"}),
    )
    .await;
    let conn = rusqlite::Connection::open(engine_db_path(&f.scratch).unwrap()).unwrap();
    let pending: i64 = conn.query_row("SELECT COUNT(*) FROM materialization_jobs WHERE workspace_id=?1 AND target_path=?2 AND status='pending'", [WS,child], |row| row.get(0)).unwrap();
    assert_eq!(pending, 1, "the descendant must wait as a durable job");
    if repair {
        std::fs::write(f.scratch.path().join(HELD), "Source repair.\n").unwrap();
    } else {
        std::fs::remove_file(f.scratch.path().join(HELD)).unwrap();
    }
    f.scan().await;
    assert_eq!(f.status().await["heldFiles"], json!([]));
    assert_eq!(
        std::fs::read_to_string(f.scratch.path().join(child)).unwrap(),
        "Target version.\n"
    );
    f.reopen().await;
    let selected: String = conn.query_row("SELECT b.text FROM snapshots s JOIN blobs b ON b.sha256=s.blob_sha256 WHERE s.workspace_id=?1 AND s.version_id='later' AND s.path=?2", [WS,child], |row| row.get(0)).unwrap();
    assert_eq!(selected, "Target version.\n");
    assert_eq!(
        std::fs::read_to_string(f.scratch.path().join(child)).unwrap(),
        selected
    );
    f.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn review2_retirement_places_held_descendant_before_restart() {
    review2_ancestor_release(false).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn review2_capture_places_held_descendant_before_restart() {
    review2_ancestor_release(true).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn history_operation_fence_scopes_capture_holds_and_preserves_ownership() {
    for affected in [true, false] {
        let f = Fixture::new().await;
        let from = if affected {
            write_file(f.scratch.path(), HELD, SEED.as_bytes());
            f.scan().await;
            HELD
        } else {
            "sibling.txt"
        };
        let op = "dohc-operation:held-fence";
        let hold = f.call("capture.hold", json!({"operationId":op})).await["holdId"].clone();
        std::fs::rename(
            f.scratch.path().join(from),
            f.scratch.path().join("moved.md"),
        )
        .unwrap();
        call_keyed(&f.transport, &f.handle, 20, "versionedText.rename", "rename-held", json!({
            "versionId":"main", "origin":"api", "fromPath":from, "toPath":"moved.md", "captureHoldId":hold
        })).await;
        f.call("capture.release", json!({"holdId":hold})).await;
        let db = rusqlite::Connection::open(engine_db_path(&f.scratch).unwrap()).unwrap();
        let count = || {
            db.query_row(
                "SELECT COUNT(*) FROM moments WHERE workspace_id=?1",
                [WS],
                |r| r.get::<_, i64>(0),
            )
            .unwrap()
        };
        let held_before = f.status().await["heldFiles"].clone();
        if affected {
            write_file(f.scratch.path(), "moved.md", outside().as_bytes());
            let before = count();
            let error = f
                .transport
                .call(
                    RequestContext::unbounded(),
                    keyed_request(
                        21,
                        "history.undo",
                        Some(f.handle.clone()),
                        "undo-held",
                        json!({"operationId":op}),
                    ),
                )
                .await
                .unwrap_err();
            assert!(
                error.message.contains("capture hold") && error.message.contains("moved.md"),
                "{error:?}"
            );
            assert_eq!(count(), before, "refused inverse appends no compensators");
            let held = f.status().await["heldFiles"].clone();
            let object: String = db
                .query_row(
                    "SELECT object_id FROM snapshots WHERE workspace_id=?1 AND path='moved.md'",
                    [WS],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(held[0]["objectId"], object);
            assert_eq!(held[0]["sourceVersionId"], "main");
            assert_eq!(
                held[0]["observedSha256"],
                dohc_engine_storage::hex_sha256(outside().as_bytes())
            );
            f.transport
                .call(
                    RequestContext::unbounded(),
                    keyed_request(
                        22,
                        "history.undo",
                        Some(f.handle.clone()),
                        "undo-held",
                        json!({"operationId":op}),
                    ),
                )
                .await
                .unwrap_err();
            assert_eq!(f.status().await["heldFiles"], held);
            assert_eq!(count(), before);
            assert_eq!(
                std::fs::read_to_string(f.scratch.path().join("moved.md")).unwrap(),
                outside()
            );
            assert!(!f.scratch.path().join(HELD).exists());
        } else {
            let result = call_keyed(
                &f.transport,
                &f.handle,
                21,
                "history.undo",
                "undo-unrelated",
                json!({"operationId":op}),
            )
            .await;
            assert_eq!(result["materialized"], false);
            wait_for_undo_placement(&f.transport, &f.handle, op, "undo-unrelated").await;
            assert_eq!(f.status().await["heldFiles"], held_before);
            assert_eq!(
                std::fs::read_to_string(f.scratch.path().join("sibling.txt")).unwrap(),
                "Sibling.\n"
            );
            assert_eq!(
                std::fs::read_to_string(f.scratch.path().join(HELD)).unwrap(),
                outside()
            );
        }
        f.close().await;
    }
}
