use dohc_engine_protocol::{
    transport::{EngineTransport, InProcessTransport, RequestContext},
    wire::{Request, WorkspaceHandle},
};
use dohc_engine_testkit::{EngineDbScan, ScratchDir};
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
        idempotency_key: None,
        params,
    }
}

async fn fixture(
    name: &str,
) -> (
    ScratchDir,
    InProcessTransport<EngineService>,
    WorkspaceHandle,
    String,
) {
    let scratch = ScratchDir::new().expect("scratch");
    write_shadow_marker_for_harness(scratch.path(), TOKEN).expect("marker");
    let workspace_id = format!("ws-switch-{name}");
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
                    "workspaceId": workspace_id,
                }),
            ),
        )
        .await
        .expect("open");
    let handle = serde_json::from_value(opened.result["workspace"].clone()).expect("handle");
    (scratch, transport, handle, workspace_id)
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
        .unwrap_or_else(|error| panic!("{method}: {error:?}"))
        .result
}

async fn write_text(
    transport: &InProcessTransport<EngineService>,
    handle: &WorkspaceHandle,
    id: u64,
    version_id: &str,
    path: &str,
    text: &str,
) {
    call(
        transport,
        handle,
        id,
        "versionedText.write",
        json!({
            "versionId": version_id,
            "path": path,
            "text": text,
            "origin": "api",
            "requestId": format!("{id}-{version_id}-{path}"),
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
async fn switching_versions_rewrites_different_plaintext() {
    // MUTATION: restore the database-only versions.setActive handler and the
    // final assertion observes "main".
    let (scratch, transport, handle, workspace_id) = fixture("plaintext").await;
    write_text(&transport, &handle, 2, "main", "notes.md", "main").await;
    std::fs::write(scratch.path().join("notes.md"), "main").expect("seed disk");
    let feature = create_feature(&transport, &handle, 3, &workspace_id).await;
    write_text(&transport, &handle, 4, &feature, "notes.md", "feature").await;

    switch_to(&transport, &handle, 5, &workspace_id, &feature).await;

    assert_eq!(
        std::fs::read_to_string(scratch.path().join("notes.md")).expect("switched disk"),
        "feature"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ordinary_binary_write_after_switch_is_not_superseded_by_switch_timestamp() {
    let (scratch, transport, handle, workspace_id) = fixture("post-switch-write").await;
    write_text(&transport, &handle, 2, "main", "notes.md", "main").await;
    std::fs::write(scratch.path().join("notes.md"), "main").expect("seed disk");
    let feature = create_feature(&transport, &handle, 3, &workspace_id).await;
    write_text(&transport, &handle, 4, &feature, "notes.md", "feature").await;
    switch_to(&transport, &handle, 5, &workspace_id, &feature).await;

    call(
        &transport,
        &handle,
        6,
        "versionedBinary.write",
        json!({
            "versionId": feature,
            "path": "notes.md",
            "bytes": [0, 1, 2, 3, 255],
            "origin": "api",
            "requestId": "ordinary-binary-after-switch",
        }),
    )
    .await;

    assert_eq!(
        std::fs::read(scratch.path().join("notes.md")).expect("post-write disk"),
        [0, 1, 2, 3, 255],
        "a switch job's epoch timestamp must not supersede later moment-order writes"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn switching_versions_rewrites_different_secret() {
    // MUTATION: restore the database-only versions.setActive handler and .env
    // remains the main version's plaintext.
    let (scratch, transport, handle, workspace_id) = fixture("secret").await;
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
            "text": "MODE=main\n",
            "origin": "api",
            "momentId": "switch-secret-main",
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
            "text": "MODE=feature\n",
            "origin": "api",
            "momentId": "switch-secret-feature",
        }),
    )
    .await;

    switch_to(&transport, &handle, 6, &workspace_id, &feature).await;

    assert_eq!(
        std::fs::read_to_string(scratch.path().join(".env")).expect("switched secret"),
        "MODE=feature\n"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn version_fork_replays_pending_secret_write_before_capture_scan() {
    // MUTATION: remove the fence-time pending-materialization replay and the
    // forced scan captures MODE=old back over the committed MODE=new API tip.
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
async fn capture_suppresses_a_secret_write_materialized_by_version_switch() {
    let (scratch, transport, handle, workspace_id) = fixture("secret-suppression").await;
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
            "text": "MODE=main\n",
            "origin": "api",
            "momentId": "suppression-secret-main",
        }),
    )
    .await;
    call(&transport, &handle, 4, "capture.flush", json!({})).await;
    let feature = create_feature(&transport, &handle, 5, &workspace_id).await;
    call(
        &transport,
        &handle,
        6,
        "secrets.write",
        json!({
            "workspaceId": workspace_id,
            "versionId": feature,
            "path": ".env",
            "text": "MODE=feature\n",
            "origin": "api",
            "momentId": "suppression-secret-feature",
        }),
    )
    .await;

    switch_to(&transport, &handle, 7, &workspace_id, &feature).await;
    call(&transport, &handle, 8, "capture.flush", json!({})).await;

    let connection =
        rusqlite::Connection::open(scratch.path().join(".dohc/engine/engine.db")).expect("sqlite");
    let capture_owned: i64 = connection
        .query_row(
            "SELECT m.capture_owned FROM secret_files f \
             JOIN secret_moments m ON m.workspace_id = f.workspace_id \
               AND m.moment_id = f.latest_moment_id \
             WHERE f.workspace_id = ?1 AND f.version_id = ?2 AND f.path = '.env'",
            rusqlite::params![workspace_id, feature],
            |row| row.get(0),
        )
        .expect("secret ownership");
    assert_eq!(
        capture_owned, 0,
        "capture must not claim an API tip from the engine's own switch write"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn switching_deletes_path_missing_from_target() {
    // MUTATION: restore the database-only versions.setActive handler and the
    // previous version's file remains on disk.
    let (scratch, transport, handle, workspace_id) = fixture("delete").await;
    write_text(&transport, &handle, 2, "main", "retired.md", "main").await;
    std::fs::write(scratch.path().join("retired.md"), "main").expect("seed disk");
    let feature = create_feature(&transport, &handle, 3, &workspace_id).await;
    call(
        &transport,
        &handle,
        4,
        "versionedText.delete",
        json!({
            "workspaceId": workspace_id,
            "versionId": feature,
            "path": "retired.md",
            "origin": "api",
            "requestId": "switch-delete-feature",
        }),
    )
    .await;

    switch_to(&transport, &handle, 5, &workspace_id, &feature).await;

    assert!(!scratch.path().join("retired.md").exists());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn switching_does_not_clobber_untracked_content() {
    let (scratch, transport, handle, workspace_id) = fixture("foreign").await;
    write_text(&transport, &handle, 2, "main", "foreign.md", "tracked").await;
    let feature = create_feature(&transport, &handle, 3, &workspace_id).await;
    write_text(&transport, &handle, 4, &feature, "foreign.md", "target").await;
    let foreign = vec![b'x'; (dohc_engine_files::MAX_CAPTURE_BINARY_BYTES + 1) as usize];
    std::fs::write(scratch.path().join("foreign.md"), &foreign).expect("foreign disk");

    switch_to(&transport, &handle, 5, &workspace_id, &feature).await;

    assert_eq!(
        std::fs::read(scratch.path().join("foreign.md")).expect("foreign preserved"),
        foreign
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn switching_skips_content_already_equal_to_target() {
    let (scratch, transport, handle, workspace_id) = fixture("equal").await;
    write_text(&transport, &handle, 2, "main", "same.md", "same").await;
    std::fs::write(scratch.path().join("same.md"), "same").expect("seed disk");
    let feature = create_feature(&transport, &handle, 3, &workspace_id).await;
    let before = std::fs::metadata(scratch.path().join("same.md"))
        .expect("before metadata")
        .modified()
        .expect("before modified");

    switch_to(&transport, &handle, 4, &workspace_id, &feature).await;

    let after = std::fs::metadata(scratch.path().join("same.md"))
        .expect("after metadata")
        .modified()
        .expect("after modified");
    assert_eq!(after, before, "equal target content must not be rewritten");
    let connection =
        rusqlite::Connection::open(scratch.path().join(".dohc/engine/engine.db")).expect("sqlite");
    let jobs: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM materialization_jobs \
             WHERE job_id LIKE 'version-switch-mat_%' AND target_path = 'same.md'",
            [],
            |row| row.get(0),
        )
        .expect("projection job count");
    assert_eq!(jobs, 0, "an equal path must not enqueue a write");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn plaintext_never_leaks_across_an_rpc_version_switch() {
    // The same property as the domain and runtime scans, proven at the daemon's
    // own surface: after a switch driven entirely through RPC, the closed
    // database holds no secret plaintext in either form.
    //
    // MUTATION: leave the decrypted plaintext behind as a stray blob in
    // `plan_secret_switch` (`put_binary_blob(tx, plaintext.as_bytes())`) and the
    // scan finds it while every other assertion here still passes.
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

    // Switch to the fork and back. The projected file proves each switch ran.
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
    // The WAL is part of the evidence, so the scan runs BEFORE the close: closing
    // the last connection checkpoints the WAL into the main file and normally
    // deletes it, and plaintext that reached a WAL page and was later overwritten
    // would be gone before this could look. `assert_scanned_wal` fails if that
    // ordering is ever undone.
    let scan = EngineDbScan::read(&database);
    scan.assert_secret_plaintext_absent(&main_text);
    scan.assert_secret_plaintext_absent(&feature_text);
    scan.assert_absent_in_every_form("main marker", main_marker);
    scan.assert_absent_in_every_form("feature marker", feature_marker);
    // Positive control: both stored ciphertexts ARE in the scanned bytes.
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
