use crate::common;

use common::*;
use dohc_engine_protocol::{
    transport::{EngineTransport, InProcessTransport, RequestContext},
    wire::WorkspaceHandle,
};
use dohc_engine_testkit::{EngineDbScan, ScratchDir};
use dohc_workspace_engine::EngineService;
use serde_json::json;
use std::sync::Arc;

async fn fixture(
    name: &str,
) -> (
    ScratchDir,
    InProcessTransport<EngineService>,
    WorkspaceHandle,
    String,
) {
    let scratch = ScratchDir::new().expect("scratch");
    let workspace_id = format!("ws-switch-{name}");
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
                "workspaceId": workspace_id,
            }),
        ),
    )
    .await
    .expect("open");
    let handle = serde_json::from_value(opened.result["workspace"].clone()).expect("handle");
    (scratch, transport, handle, workspace_id)
}

async fn write_text(
    transport: &InProcessTransport<EngineService>,
    handle: &WorkspaceHandle,
    id: u64,
    version_id: &str,
    path: &str,
    text: &str,
) {
    call_keyed(
        transport,
        handle,
        id,
        "versionedText.write",
        &format!("{id}-{version_id}-{path}"),
        json!({
            "versionId": version_id,
            "path": path,
            "text": text,
            "origin": "api",
        }),
    )
    .await;
}

async fn create_feature(
    transport: &InProcessTransport<EngineService>,
    handle: &WorkspaceHandle,
    id: u64,
    workspace_id: &str,
) -> String {
    call(
        transport,
        handle,
        id,
        "versions.createNamed",
        json!({
            "workspaceId": workspace_id,
            "name": format!("feature-{id}"),
            "fromVersionId": "main",
        }),
    )
    .await["id"]
        .as_str()
        .expect("feature id")
        .to_owned()
}

async fn switch_to(
    transport: &InProcessTransport<EngineService>,
    handle: &WorkspaceHandle,
    id: u64,
    workspace_id: &str,
    version_id: &str,
) {
    call(
        transport,
        handle,
        id,
        "versions.setActive",
        json!({ "workspaceId": workspace_id, "versionId": version_id }),
    )
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn post_commit_collection_reconcile_failure_does_not_mask_committed_switch() {
    let (scratch, transport, handle, workspace_id) = fixture("collection-reconcile-failure").await;
    let schema = "name: Tasks\nfields: {}\n";
    write_text(
        &transport,
        &handle,
        2,
        "main",
        "tasks/collection.yaml",
        schema,
    )
    .await;
    std::fs::create_dir_all(scratch.path().join("tasks")).expect("collection directory");
    std::fs::write(scratch.path().join("tasks/collection.yaml"), schema)
        .expect("collection schema");
    let feature = create_feature(&transport, &handle, 3, &workspace_id).await;

    let connection =
        rusqlite::Connection::open(scratch.path().join(".dohc/engine/engine.db")).expect("sqlite");
    connection
        .busy_timeout(std::time::Duration::from_secs(5))
        .expect("sqlite busy timeout");
    connection
        .execute_batch(&format!(
            "CREATE TRIGGER fail_post_switch_collection_reconcile \
             BEFORE INSERT ON collections \
             WHEN NEW.version_id = '{feature}' \
             BEGIN \
               SELECT RAISE(FAIL, 'injected post-switch collection reconcile failure'); \
             END;"
        ))
        .expect("install post-switch reconcile failure");

    let switched = transport
        .call(
            RequestContext::unbounded(),
            request(
                4,
                "versions.setActive",
                Some(handle.clone()),
                json!({ "workspaceId": workspace_id, "versionId": feature }),
            ),
        )
        .await;
    connection
        .execute_batch("DROP TRIGGER fail_post_switch_collection_reconcile")
        .expect("remove post-switch reconcile failure");

    let active = call(
        &transport,
        &handle,
        5,
        "versions.active",
        json!({ "workspaceId": workspace_id }),
    )
    .await;
    assert_eq!(
        active["id"], feature,
        "the active-version transaction committed before reconciliation failed"
    );
    let switched = switched.expect("post-commit work must not mask the committed switch");
    assert_eq!(switched.result["id"], feature);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn version_fork_replays_pending_secret_write_before_capture_scan() {
    let (scratch, transport, handle, workspace_id) = fixture("pending-secret-before-fork").await;
    call(
        &transport,
        &handle,
        2,
        "versions.ensureMain",
        json!({ "workspaceId": workspace_id }),
    )
    .await;
    call(
        &transport,
        &handle,
        3,
        "secrets.write",
        json!({
            "workspaceId": workspace_id,
            "versionId": "main",
            "path": ".env",
            "text": "MODE=old\n",
            "origin": "api",
            "momentId": "pending-before-fork-old",
        }),
    )
    .await;
    std::fs::write(scratch.path().join(".env"), "MODE=old\n").expect("seed old disk secret");
    call(&transport, &handle, 4, "capture.flush", json!({})).await;

    call(
        &transport,
        &handle,
        5,
        "secrets.write",
        json!({
            "workspaceId": workspace_id,
            "versionId": "main",
            "path": ".env",
            "text": "MODE=new\n",
            "origin": "api",
            "momentId": "pending-before-fork-new",
        }),
    )
    .await;
    let connection =
        rusqlite::Connection::open(scratch.path().join(".dohc/engine/engine.db")).expect("sqlite");
    let status: String = connection
        .query_row(
            "SELECT status FROM materialization_jobs WHERE job_id = ?1",
            ["secret-mat_pending-before-fork-new"],
            |row| row.get(0),
        )
        .expect("pending secret job");
    assert_eq!(status, "pending", "the regression requires stale disk");
    drop(connection);

    create_feature(&transport, &handle, 6, &workspace_id).await;

    assert_eq!(
        std::fs::read_to_string(scratch.path().join(".env")).expect("replayed disk secret"),
        "MODE=new\n"
    );
    let materialized = call(
        &transport,
        &handle,
        7,
        "secrets.materialize",
        json!({ "versionId": "main", "path": ".env" }),
    )
    .await;
    assert_eq!(
        materialized["text"], "MODE=new\n",
        "the stale scan must not roll back the committed API head"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn switching_does_not_clobber_untracked_content() {
    let (scratch, transport, handle, workspace_id) = fixture("foreign").await;
    write_text(&transport, &handle, 2, "main", "foreign.md", "tracked").await;
    let feature = create_feature(&transport, &handle, 3, &workspace_id).await;
    write_text(&transport, &handle, 4, &feature, "foreign.md", "target").await;
    let foreign = vec![b'x'; (dohc_engine_files::MAX_CAPTURE_TEXT_BYTES + 1) as usize];
    std::fs::write(scratch.path().join("foreign.md"), &foreign).expect("foreign disk");

    switch_to(&transport, &handle, 5, &workspace_id, &feature).await;

    assert_eq!(
        std::fs::read(scratch.path().join("foreign.md")).expect("foreign preserved"),
        foreign
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn plaintext_never_leaks_across_an_rpc_version_switch() {
    let main_marker = "MARKER_1c6a94fe_RPC_MAIN";
    let feature_marker = "MARKER_78b2de50_RPC_FEATURE";
    let main_text = format!("PASSWORD={main_marker}\n");
    let feature_text = format!("PASSWORD={feature_marker}\n");

    let (scratch, transport, handle, workspace_id) = fixture("secret-scan").await;
    call(
        &transport,
        &handle,
        2,
        "versions.ensureMain",
        json!({ "workspaceId": workspace_id }),
    )
    .await;
    call(
        &transport,
        &handle,
        3,
        "secrets.write",
        json!({
            "workspaceId": workspace_id,
            "versionId": "main",
            "path": ".env",
            "text": main_text,
            "origin": "api",
            "momentId": "scan-secret-main",
        }),
    )
    .await;
    let feature = create_feature(&transport, &handle, 4, &workspace_id).await;
    call(
        &transport,
        &handle,
        5,
        "secrets.write",
        json!({
            "workspaceId": workspace_id,
            "versionId": feature,
            "path": ".env",
            "text": feature_text,
            "origin": "api",
            "momentId": "scan-secret-feature",
        }),
    )
    .await;

    switch_to(&transport, &handle, 6, &workspace_id, &feature).await;
    assert_eq!(
        std::fs::read_to_string(scratch.path().join(".env")).expect("switched secret"),
        feature_text
    );
    switch_to(&transport, &handle, 7, &workspace_id, "main").await;
    assert_eq!(
        std::fs::read_to_string(scratch.path().join(".env")).expect("switched back"),
        main_text
    );

    let database = scratch.path().join(".dohc/engine/engine.db");
    // The WAL is part of the evidence, so the scan runs before the close: closing
    // the last connection checkpoints the WAL into the main file and normally
    // deletes it, and plaintext that reached a WAL page and was later overwritten
    // would be gone before this could look. `assert_scanned_wal` fails if that
    // ordering is ever undone.
    let scan = EngineDbScan::read(&database);
    scan.assert_secret_plaintext_absent(&main_text);
    scan.assert_secret_plaintext_absent(&feature_text);
    scan.assert_absent_in_every_form("main marker", main_marker);
    scan.assert_absent_in_every_form("feature marker", feature_marker);
    scan.assert_stored_ciphertext_scanned(&database);
    scan.assert_scanned_wal();

    transport
        .call(
            RequestContext::unbounded(),
            request(8, "workspace.close", Some(handle), json!({})),
        )
        .await
        .expect("workspace close");
}
