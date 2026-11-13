//! RPC-D sequencing steps 1-3: mutation guards exercised through the real
//! in-process transport and actor-owned store.

use crate::common;

use common::*;
use dohc_engine_protocol::{
    ErrorCode,
    transport::{
        EngineService as ProtocolEngineService, EngineTransport, InProcessTransport, RequestContext,
    },
    wire::WorkspaceHandle,
};
use dohc_engine_testkit::ScratchDir;
use dohc_workspace_engine::{EngineService, root_binding::write_root_binding};
use serde_json::{Value, json};
use std::{path::Path, sync::Arc};

async fn fixture(
    name: &str,
) -> (
    ScratchDir,
    InProcessTransport<EngineService>,
    WorkspaceHandle,
) {
    let scratch = ScratchDir::new().expect("scratch");
    write_root_binding(scratch.path(), TOKEN).expect("root binding");
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
                "workspaceId": format!("ws-rpcd-{name}"),
            }),
        ),
    )
    .await
    .expect("open");
    let handle = serde_json::from_value(opened.result["workspace"].clone()).expect("handle");
    (scratch, transport, handle)
}

async fn fixture_with_service(
    name: &str,
) -> (
    ScratchDir,
    Arc<EngineService>,
    InProcessTransport<EngineService>,
    WorkspaceHandle,
) {
    let scratch = ScratchDir::new().expect("scratch");
    write_root_binding(scratch.path(), TOKEN).expect("root binding");
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
                "workspaceId": format!("ws-rpcd-{name}"),
            }),
        ),
    )
    .await
    .expect("open");
    let handle = serde_json::from_value(opened.result["workspace"].clone()).expect("handle");
    (scratch, service, transport, handle)
}

/// The first `search.queryPage` page for the active version.
async fn search(
    transport: &InProcessTransport<EngineService>,
    handle: &WorkspaceHandle,
    id: u64,
    query: &str,
) -> Value {
    let mut page = call(
        transport,
        handle,
        id,
        "search.queryPage",
        json!({ "query": query }),
    )
    .await;
    page["results"].take()
}

async fn write(
    transport: &InProcessTransport<EngineService>,
    handle: &WorkspaceHandle,
    id: u64,
    path: &str,
    text: &str,
    request_id: &str,
) -> Value {
    call_keyed(
        transport,
        handle,
        id,
        "versionedText.write",
        request_id,
        json!({
            "versionId": "main",
            "path": path,
            "text": text,
            "origin": "api",
        }),
    )
    .await
}

async fn moments(
    transport: &InProcessTransport<EngineService>,
    handle: &WorkspaceHandle,
    id: u64,
) -> Vec<Value> {
    call(
        transport,
        handle,
        id,
        "moments.list",
        json!({ "versionId": "main", "limit": 100 }),
    )
    .await["moments"]
        .as_array()
        .expect("moments")
        .clone()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn aggregate_history_reads_no_capture_mounts_and_their_read_only_handles() {
    let scratch = ScratchDir::new().expect("scratch");
    write_root_binding(scratch.path(), TOKEN).expect("root binding");
    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let workspace_id = "no-capture-imported-history";
    let params = json!({"rootDir":scratch.path().to_string_lossy(),"workspaceId":workspace_id,"captureMode":"none"});
    let opened = call_with_busy_retry(
        &transport,
        RequestContext::unbounded(),
        request(1, "workspace.open", None, params.clone()),
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
        json!({"workspaceId":workspace_id}),
    )
    .await;
    let author =
        json!({"kind":"agent","agentId":"trip-agent-hosted","onBehalfOf":"opaque-relay-owner"});
    let written = call(
        &transport,
        &handle,
        3,
        "versionedText.write",
        json!({
            "versionId":"main","path":"notes/plan.md","text":"Agent edited while hosted.",
            "origin":"sync","author":author,"momentId":"imported-agent-moment",
        }),
    )
    .await;
    assert_eq!(written["moment"]["authors"], json!([author]));
    let check = |page: Value| {
        assert_eq!(page["activeVersion"]["id"], "main");
        let rows = page["moments"].as_array().unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["momentId"], "imported-agent-moment");
        assert_eq!(rows[0]["authors"], json!([author]));
        assert_eq!(page["protectedMoments"], json!([]));
        page
    };
    let first = check(
        call(
            &transport,
            &handle,
            4,
            "history.page",
            json!({"workspaceId":workspace_id}),
        )
        .await,
    );
    let attached = call_with_busy_retry(&transport,RequestContext::unbounded(), request(5, "workspace.open", None, json!({
        "rootDir":scratch.path().to_string_lossy(),"workspaceId":workspace_id,"skipStartupMaintenance":true,
    }))).await.unwrap();
    let attached_handle: WorkspaceHandle =
        serde_json::from_value(attached.result["workspace"].clone()).unwrap();
    assert_eq!(
        check(
            call(
                &transport,
                &attached_handle,
                6,
                "history.page",
                json!({"workspaceId":workspace_id})
            )
            .await
        ),
        first
    );
    let detail = call(
        &transport,
        &attached_handle,
        7,
        "moments.get",
        json!({"momentId":"imported-agent-moment"}),
    )
    .await;
    assert_eq!(detail["authors"], json!([author]));
    assert_eq!(detail["afterText"], "Agent edited while hosted.");
    call(
        &transport,
        &attached_handle,
        8,
        "workspace.close",
        json!({}),
    )
    .await;
    call(&transport, &handle, 9, "workspace.close", json!({})).await;

    // A standalone maintenance-free read intentionally creates no capture driver either.
    let read_only = call_with_busy_retry(&transport,RequestContext::unbounded(), request(10, "workspace.open", None, json!({
        "rootDir":scratch.path().to_string_lossy(),"workspaceId":workspace_id,"skipStartupMaintenance":true,
    }))).await.unwrap();
    let read_only_handle: WorkspaceHandle =
        serde_json::from_value(read_only.result["workspace"].clone()).unwrap();
    assert_eq!(
        check(
            call(
                &transport,
                &read_only_handle,
                11,
                "history.page",
                json!({"workspaceId":workspace_id})
            )
            .await
        ),
        first
    );
    let reopened_detail = call(
        &transport,
        &read_only_handle,
        12,
        "moments.get",
        json!({"momentId":"imported-agent-moment"}),
    )
    .await;
    assert_eq!(reopened_detail, detail);
    call(
        &transport,
        &read_only_handle,
        13,
        "workspace.close",
        json!({}),
    )
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn conflicted_binary_materialize_returns_the_committed_moment() {
    let (scratch, transport, handle) = fixture("binary-conflict-result").await;
    std::fs::write(scratch.path().join("occupied.bin"), b"external").expect("external file");
    let result = call(
        &transport,
        &handle,
        2,
        "versionedBinary.write",
        json!({
            "versionId": "main",
            "path": "occupied.bin",
            "bytes": [1, 2, 3],
            "origin": "api",
        }),
    )
    .await;
    assert_eq!(result["materializeEnqueued"], true);
    assert_eq!(result["materialized"], false);
    assert_eq!(result["materializeOutcome"], "conflict");
    assert!(result["moment"]["momentId"].is_string());
    assert_eq!(
        std::fs::read(scratch.path().join("occupied.bin")).unwrap(),
        b"external"
    );
    assert_eq!(moments(&transport, &handle, 3).await.len(), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn capture_sized_text_write_succeeds_and_over_cap_refuses_before_commit() {
    let (_scratch, transport, handle) = fixture("cap").await;
    write(&transport, &handle, 2, "seed.md", "seed", "cap-seed").await;
    let before = moments(&transport, &handle, 3).await.len();
    write(
        &transport,
        &handle,
        4,
        "capture-sized.md",
        &"x".repeat(128 * 1024),
        "capture-sized",
    )
    .await;
    assert_eq!(moments(&transport, &handle, 5).await.len(), before + 1);
    let refused = transport
        .call(
            RequestContext::unbounded(),
            keyed_request(
                6,
                "versionedText.write",
                Some(handle.clone()),
                "too-big",
                json!({
                    "versionId": "main",
                    "path": "too-big.md",
                    "text": "x".repeat(128 * 1024 + 1),
                    "origin": "api",
                }),
            ),
        )
        .await
        .expect_err("over cap");
    assert_eq!(refused.message, "content-exceeds-inband-cap");
    assert_eq!(moments(&transport, &handle, 7).await.len(), before + 1);
    let refused = transport
        .call(
            RequestContext::unbounded(),
            request(
                8,
                "versionedBinary.write",
                Some(handle.clone()),
                json!({
                    "versionId": "main",
                    "path": "too-big.bin",
                    "bytes": vec![7_u8; 49 * 1024],
                    "origin": "api",
                }),
            ),
        )
        .await
        .expect_err("over-cap binary");
    assert_eq!(refused.message, "content-exceeds-inband-cap");
    assert_eq!(moments(&transport, &handle, 9).await.len(), before + 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn secret_moments_version_wide_pages_across_paths_newest_first() {
    let (_scratch, transport, handle) = fixture("secret-version-history").await;
    call(
        &transport,
        &handle,
        2,
        "versions.ensureMain",
        json!({ "workspaceId": "ws-rpcd-secret-version-history" }),
    )
    .await;
    for (index, (path, text)) in [(".env", "one"), (".env.local", "two"), (".env", "three")]
        .into_iter()
        .enumerate()
    {
        call(
            &transport,
            &handle,
            3 + index as u64,
            "secrets.write",
            json!({
                "workspaceId": "ws-rpcd-secret-version-history",
                "versionId": "main",
                "path": path,
                "text": text,
                "origin": "api",
                "momentId": format!("secret-history-{index}"),
            }),
        )
        .await;
    }
    let first = call(
        &transport,
        &handle,
        6,
        "secrets.moments.list",
        json!({
            "workspaceId": "ws-rpcd-secret-version-history",
            "versionId": "main",
            "limit": 2,
        }),
    )
    .await;
    let first_rows = first["moments"].as_array().expect("first page");
    assert_eq!(first_rows.len(), 2);
    assert_eq!(first_rows[0]["id"], "secret-history-2");
    assert_eq!(first_rows[1]["id"], "secret-history-1");
    assert_eq!(first_rows[0]["path"], ".env");
    assert_eq!(first_rows[1]["path"], ".env.local");
    assert_eq!(first["nextBeforeMomentOrder"], first_rows[1]["momentOrder"]);

    let second = call(
        &transport,
        &handle,
        7,
        "secrets.moments.list",
        json!({
            "workspaceId": "ws-rpcd-secret-version-history",
            "versionId": "main",
            "beforeMomentOrder": first["nextBeforeMomentOrder"],
            "limit": 2,
        }),
    )
    .await;
    let second_rows = second["moments"].as_array().expect("second page");
    assert_eq!(second_rows.len(), 1);
    assert_eq!(second_rows[0]["id"], "secret-history-0");
    assert!(second["nextBeforeMomentOrder"].is_null());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn active_secret_delete_adopts_modified_disk_without_plaintext_conflict() {
    let (scratch, transport, handle) = fixture("secret-delete-adopts-disk").await;
    let workspace = "ws-rpcd-secret-delete-adopts-disk";
    call(
        &transport,
        &handle,
        20,
        "versions.ensureMain",
        json!({ "workspaceId": workspace }),
    )
    .await;
    call(
        &transport,
        &handle,
        2,
        "secrets.write",
        json!({
            "workspaceId": workspace,
            "versionId": "main",
            "path": ".env",
            "text": "TOKEN=original\n",
            "origin": "api",
            "momentId": "adopt-delete-write",
        }),
    )
    .await;
    call(&transport, &handle, 3, "workspace.close", json!({})).await;
    let materialized = call_with_busy_retry(
        &transport,
        RequestContext::unbounded(),
        request(
            4,
            "workspace.open",
            None,
            json!({
                "rootDir": scratch.path().to_string_lossy(),
                "workspaceId": workspace,
            }),
        ),
    )
    .await
    .expect("write replay");
    let materialized_handle: WorkspaceHandle =
        serde_json::from_value(materialized.result["workspace"].clone()).expect("handle");
    std::fs::write(scratch.path().join(".env"), "TOKEN=externally-modified\n")
        .expect("external modification");
    call(
        &transport,
        &materialized_handle,
        5,
        "secrets.delete",
        json!({
            "workspaceId": workspace,
            "versionId": "main",
            "path": ".env",
            "origin": "api",
            "momentId": "adopt-delete-active",
        }),
    )
    .await;
    call(
        &transport,
        &materialized_handle,
        6,
        "workspace.close",
        json!({}),
    )
    .await;

    let reopened = call_with_busy_retry(
        &transport,
        RequestContext::unbounded(),
        request(
            7,
            "workspace.open",
            None,
            json!({
                "rootDir": scratch.path().to_string_lossy(),
                "workspaceId": workspace,
            }),
        ),
    )
    .await
    .expect("adopt-current delete replay");
    let reopened_handle: WorkspaceHandle =
        serde_json::from_value(reopened.result["workspace"].clone()).expect("handle");
    assert!(!scratch.path().join(".env").exists());
    assert!(
        std::fs::read_dir(scratch.path())
            .expect("workspace root")
            .all(|entry| !entry
                .expect("workspace entry")
                .file_name()
                .to_string_lossy()
                .ends_with(".conflict")),
        "secret delete must never preserve plaintext in a conflict artifact"
    );
    call(
        &transport,
        &reopened_handle,
        8,
        "workspace.close",
        json!({}),
    )
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn non_active_secret_write_survives_until_activation_and_reopen() {
    let (scratch, transport, handle) = fixture("secret-non-active-write").await;
    let workspace = "ws-rpcd-secret-non-active-write";
    call(
        &transport,
        &handle,
        20,
        "versions.ensureMain",
        json!({ "workspaceId": workspace }),
    )
    .await;
    call(
        &transport,
        &handle,
        2,
        "secrets.write",
        json!({
            "workspaceId": workspace,
            "versionId": "main",
            "path": ".env",
            "text": "ACTIVE=main\n",
            "origin": "api",
            "momentId": "active-main-write",
        }),
    )
    .await;
    let named = call(
        &transport,
        &handle,
        3,
        "versions.createNamed",
        json!({
            "workspaceId": workspace,
            "name": "other",
            "fromVersionId": "main",
        }),
    )
    .await;
    call(
        &transport,
        &handle,
        4,
        "secrets.fork",
        json!({
            "workspaceId": workspace,
            "fromVersionId": "main",
            "toVersionId": named["id"],
        }),
    )
    .await;
    call(
        &transport,
        &handle,
        5,
        "secrets.write",
        json!({
            "workspaceId": workspace,
            "versionId": named["id"],
            "path": ".env",
            "text": "INACTIVE=other\n",
            "origin": "api",
            "momentId": "non-active-newer-write",
        }),
    )
    .await;
    call(&transport, &handle, 6, "workspace.close", json!({})).await;
    let reopened = call_with_busy_retry(
        &transport,
        RequestContext::unbounded(),
        request(
            7,
            "workspace.open",
            None,
            json!({
                "rootDir": scratch.path().to_string_lossy(),
                "workspaceId": workspace,
            }),
        ),
    )
    .await
    .expect("open replay");
    let reopened_handle: WorkspaceHandle =
        serde_json::from_value(reopened.result["workspace"].clone()).expect("handle");
    assert_eq!(
        std::fs::read_to_string(scratch.path().join(".env")).expect("active secret"),
        "ACTIVE=main\n"
    );
    let connection =
        rusqlite::Connection::open(scratch.path().join(".dohc/engine/engine.db")).expect("sqlite");
    let status: String = connection
        .query_row(
            "SELECT status FROM materialization_jobs \
             WHERE job_id = 'secret-mat_non-active-newer-write'",
            [],
            |row| row.get(0),
        )
        .expect("inactive secret job");
    assert_eq!(
        status, "pending",
        "inactive disk intent must survive for future activation"
    );
    drop(connection);
    call(
        &transport,
        &reopened_handle,
        8,
        "versions.setActive",
        json!({
            "workspaceId": workspace,
            "versionId": named["id"],
        }),
    )
    .await;
    call(
        &transport,
        &reopened_handle,
        9,
        "workspace.close",
        json!({}),
    )
    .await;
    let activated = call_with_busy_retry(
        &transport,
        RequestContext::unbounded(),
        request(
            10,
            "workspace.open",
            None,
            json!({
                "rootDir": scratch.path().to_string_lossy(),
                "workspaceId": workspace,
            }),
        ),
    )
    .await
    .expect("active version replays its pending secret");
    let activated_handle: WorkspaceHandle =
        serde_json::from_value(activated.result["workspace"].clone()).expect("handle");
    assert_eq!(
        std::fs::read_to_string(scratch.path().join(".env")).expect("activated secret"),
        "INACTIVE=other\n"
    );
    let connection =
        rusqlite::Connection::open(scratch.path().join(".dohc/engine/engine.db")).expect("sqlite");
    let status: String = connection
        .query_row(
            "SELECT status FROM materialization_jobs \
             WHERE job_id = 'secret-mat_non-active-newer-write'",
            [],
            |row| row.get(0),
        )
        .expect("activated secret job");
    assert_eq!(status, "complete");
    drop(connection);
    call(
        &transport,
        &activated_handle,
        11,
        "workspace.close",
        json!({}),
    )
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn tampered_secret_open_replay_fails_closed_without_writing_plaintext() {
    let (scratch, transport, handle) = fixture("secret-replay-tamper").await;
    let workspace = "ws-rpcd-secret-replay-tamper";
    call(
        &transport,
        &handle,
        20,
        "versions.ensureMain",
        json!({ "workspaceId": workspace }),
    )
    .await;
    call(
        &transport,
        &handle,
        2,
        "secrets.write",
        json!({
            "workspaceId": workspace,
            "versionId": "main",
            "path": ".env",
            "text": "TOKEN=auth-required\n",
            "origin": "api",
            "momentId": "tampered-secret-write",
        }),
    )
    .await;
    call(&transport, &handle, 3, "workspace.close", json!({})).await;
    let connection =
        rusqlite::Connection::open(scratch.path().join(".dohc/engine/engine.db")).expect("sqlite");
    connection
        .execute(
            "UPDATE secret_files SET auth_tag_base64 = ?1 \
             WHERE workspace_id = ?2 AND version_id = 'main' AND path = '.env'",
            rusqlite::params!["AAAAAAAAAAAAAAAAAAAAAA==", workspace],
        )
        .expect("tamper auth tag");
    drop(connection);
    let reopened = call_with_busy_retry(
        &transport,
        RequestContext::unbounded(),
        request(
            4,
            "workspace.open",
            None,
            json!({
                "rootDir": scratch.path().to_string_lossy(),
                "workspaceId": workspace,
            }),
        ),
    )
    .await
    .expect("tampered replay is skipped without bricking open");
    let reopened_handle: WorkspaceHandle =
        serde_json::from_value(reopened.result["workspace"].clone()).expect("handle");
    assert!(
        !scratch.path().join(".env").exists(),
        "failed authenticated decryption must not produce plaintext"
    );
    let connection =
        rusqlite::Connection::open(scratch.path().join(".dohc/engine/engine.db")).expect("sqlite");
    let status: String = connection
        .query_row(
            "SELECT status FROM materialization_jobs \
             WHERE job_id = 'secret-mat_tampered-secret-write'",
            [],
            |row| row.get(0),
        )
        .expect("tampered job status");
    assert_eq!(status, "pending");
    drop(connection);
    call(
        &transport,
        &reopened_handle,
        5,
        "workspace.close",
        json!({}),
    )
    .await;
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn secret_symlinked_parent_never_writes_outside_workspace() {
    let (scratch, transport, handle) = fixture("secret-replay-parent-symlink").await;
    let workspace = "ws-rpcd-secret-replay-parent-symlink";
    call(
        &transport,
        &handle,
        20,
        "versions.ensureMain",
        json!({ "workspaceId": workspace }),
    )
    .await;
    call(
        &transport,
        &handle,
        2,
        "secrets.write",
        json!({
            "workspaceId": workspace,
            "versionId": "main",
            "path": "config/.env",
            "text": "TOKEN=must-stay-in-workspace\n",
            "origin": "api",
            "momentId": "parent-symlink-secret-write",
        }),
    )
    .await;
    call(&transport, &handle, 3, "workspace.close", json!({})).await;

    let outside = ScratchDir::new().expect("external directory");
    std::os::unix::fs::symlink(outside.path(), scratch.path().join("config"))
        .expect("secret parent symlink");
    let reopened = call_with_busy_retry(
        &transport,
        RequestContext::unbounded(),
        request(
            4,
            "workspace.open",
            None,
            json!({
                "rootDir": scratch.path().to_string_lossy(),
                "workspaceId": workspace,
            }),
        ),
    )
    .await
    .expect("ancestor refusal only skips the secret replay job");
    let reopened_handle: WorkspaceHandle =
        serde_json::from_value(reopened.result["workspace"].clone()).expect("handle");
    assert!(
        !outside.path().join(".env").exists(),
        "plaintext must not escape through the symlinked parent"
    );
    assert!(
        std::fs::symlink_metadata(scratch.path().join("config"))
            .expect("parent symlink metadata")
            .file_type()
            .is_symlink(),
        "the refused parent symlink remains untouched"
    );
    let connection =
        rusqlite::Connection::open(scratch.path().join(".dohc/engine/engine.db")).expect("sqlite");
    let status: String = connection
        .query_row(
            "SELECT status FROM materialization_jobs \
             WHERE job_id = 'secret-mat_parent-symlink-secret-write'",
            [],
            |row| row.get(0),
        )
        .expect("parent-symlink job status");
    assert_eq!(status, "pending");
    drop(connection);
    call(
        &transport,
        &reopened_handle,
        5,
        "workspace.close",
        json!({}),
    )
    .await;
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn planted_secret_temp_symlink_is_never_followed() {
    let (scratch, transport, handle) = fixture("secret-replay-temp-symlink").await;
    let workspace = "ws-rpcd-secret-replay-temp-symlink";
    call(
        &transport,
        &handle,
        20,
        "versions.ensureMain",
        json!({ "workspaceId": workspace }),
    )
    .await;
    call(
        &transport,
        &handle,
        2,
        "secrets.write",
        json!({
            "workspaceId": workspace,
            "versionId": "main",
            "path": ".env",
            "text": "TOKEN=must-not-follow-temp\n",
            "origin": "api",
            "momentId": "temp-symlink-secret-write",
        }),
    )
    .await;
    call(&transport, &handle, 3, "workspace.close", json!({})).await;

    let outside = ScratchDir::new().expect("external directory");
    let outside_file = outside.path().join("outside.txt");
    std::fs::write(&outside_file, "outside stays intact\n").expect("outside sentinel");
    let temp = scratch
        .path()
        .join(".dohc-write-secret-mat-temp-symlink-secret-write.tmp");
    std::os::unix::fs::symlink(&outside_file, &temp).expect("planted temp symlink");
    let reopened = call_with_busy_retry(
        &transport,
        RequestContext::unbounded(),
        request(
            4,
            "workspace.open",
            None,
            json!({
                "rootDir": scratch.path().to_string_lossy(),
                "workspaceId": workspace,
            }),
        ),
    )
    .await
    .expect("temp refusal only skips the secret replay job");
    let reopened_handle: WorkspaceHandle =
        serde_json::from_value(reopened.result["workspace"].clone()).expect("handle");
    assert_eq!(
        std::fs::read_to_string(&outside_file).expect("outside content"),
        "outside stays intact\n",
        "secret plaintext must not be written through the planted temp symlink"
    );
    assert!(!scratch.path().join(".env").exists());
    assert!(
        std::fs::symlink_metadata(&temp)
            .expect("temp symlink metadata")
            .file_type()
            .is_symlink(),
        "exclusive-create refusal must not clobber the planted entry"
    );
    let connection =
        rusqlite::Connection::open(scratch.path().join(".dohc/engine/engine.db")).expect("sqlite");
    let status: String = connection
        .query_row(
            "SELECT status FROM materialization_jobs \
             WHERE job_id = 'secret-mat_temp-symlink-secret-write'",
            [],
            |row| row.get(0),
        )
        .expect("temp-symlink job status");
    assert_eq!(status, "pending");
    drop(connection);
    call(
        &transport,
        &reopened_handle,
        5,
        "workspace.close",
        json!({}),
    )
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn crashed_secret_write_recovers_after_reopen() {
    let (scratch, transport, handle) = fixture("secret-replay-crashed-temp").await;
    let workspace = "ws-rpcd-secret-replay-crashed-temp";
    call(
        &transport,
        &handle,
        20,
        "versions.ensureMain",
        json!({ "workspaceId": workspace }),
    )
    .await;
    call(
        &transport,
        &handle,
        2,
        "secrets.write",
        json!({
            "workspaceId": workspace,
            "versionId": "main",
            "path": ".env",
            "text": "TOKEN=recovered-after-crash\n",
            "origin": "api",
            "momentId": "crashed-temp-secret-write",
        }),
    )
    .await;
    call(&transport, &handle, 3, "workspace.close", json!({})).await;

    let temp = scratch
        .path()
        .join(".dohc-write-secret-mat-crashed-temp-secret-write.tmp");
    std::fs::write(&temp, "TOKEN=recovered-after-crash\n")
        .expect("model durable temp left after flush-before-rename crash");

    let reopened = call_with_busy_retry(
        &transport,
        RequestContext::unbounded(),
        request(
            4,
            "workspace.open",
            None,
            json!({
                "rootDir": scratch.path().to_string_lossy(),
                "workspaceId": workspace,
            }),
        ),
    )
    .await
    .expect("reopen recovers the durable crashed temp");
    let reopened_handle: WorkspaceHandle =
        serde_json::from_value(reopened.result["workspace"].clone()).expect("handle");
    assert_eq!(
        std::fs::read_to_string(scratch.path().join(".env")).expect("materialized secret"),
        "TOKEN=recovered-after-crash\n"
    );
    assert!(!temp.exists(), "crashed temp must be consumed by recovery");
    let connection =
        rusqlite::Connection::open(scratch.path().join(".dohc/engine/engine.db")).expect("sqlite");
    let status: String = connection
        .query_row(
            "SELECT status FROM materialization_jobs \
             WHERE job_id = 'secret-mat_crashed-temp-secret-write'",
            [],
            |row| row.get(0),
        )
        .expect("crashed-temp job status");
    assert_eq!(status, "complete");
    drop(connection);
    call(
        &transport,
        &reopened_handle,
        5,
        "workspace.close",
        json!({}),
    )
    .await;
}

// Windows runtime coverage for the ancestor-reparse rejection (the #[cfg(unix)]
// symlink test can't run on Windows). A junction (`mklink /J`) is a reparse point
// creatable without elevation, so it exercises FILE_ATTRIBUTE_REPARSE_POINT.
#[cfg(windows)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn secret_junctioned_parent_never_writes_outside_workspace() {
    let (scratch, transport, handle) = fixture("secret-replay-parent-junction").await;
    let workspace = "ws-rpcd-secret-replay-parent-junction";
    call(
        &transport,
        &handle,
        20,
        "versions.ensureMain",
        json!({ "workspaceId": workspace }),
    )
    .await;
    call(
        &transport,
        &handle,
        2,
        "secrets.write",
        json!({
            "workspaceId": workspace,
            "versionId": "main",
            "path": "config/.env",
            "text": "TOKEN=must-stay-in-workspace\n",
            "origin": "api",
            "momentId": "parent-junction-secret-write",
        }),
    )
    .await;
    call(&transport, &handle, 3, "workspace.close", json!({})).await;

    let outside = ScratchDir::new().expect("external directory");
    let link = scratch.path().join("config");
    let status = std::process::Command::new("cmd")
        .arg("/C")
        .arg("mklink")
        .arg("/J")
        .arg(&link)
        .arg(outside.path())
        .status()
        .expect("spawn mklink /J");
    assert!(
        status.success(),
        "junction creation must succeed without elevation"
    );
    let reopened = call_with_busy_retry(
        &transport,
        RequestContext::unbounded(),
        request(
            4,
            "workspace.open",
            None,
            json!({
                "rootDir": scratch.path().to_string_lossy(),
                "workspaceId": workspace,
            }),
        ),
    )
    .await
    .expect("ancestor reparse refusal only skips the secret replay job");
    let reopened_handle: WorkspaceHandle =
        serde_json::from_value(reopened.result["workspace"].clone()).expect("handle");
    assert!(
        !outside.path().join(".env").exists(),
        "plaintext must not escape through the junctioned parent"
    );
    let connection =
        rusqlite::Connection::open(scratch.path().join(".dohc/engine/engine.db")).expect("sqlite");
    let status: String = connection
        .query_row(
            "SELECT status FROM materialization_jobs \
             WHERE job_id = 'secret-mat_parent-junction-secret-write'",
            [],
            |row| row.get(0),
        )
        .expect("parent-junction job status");
    assert_eq!(status, "pending");
    drop(connection);
    call(
        &transport,
        &reopened_handle,
        5,
        "workspace.close",
        json!({}),
    )
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn request_id_replay_is_deduped_and_reuse_mismatch_is_refused() {
    let (_scratch, transport, handle) = fixture("request-id").await;
    let first = write(&transport, &handle, 2, "id.md", "same", "stable-id").await;
    let replay = write(&transport, &handle, 3, "id.md", "same", "stable-id").await;
    assert_eq!(
        replay["deduped"], true,
        "ignore the request ledger -> replay creates a second moment."
    );
    assert_eq!(replay["moment"]["momentId"], first["moment"]["momentId"]);
    assert_eq!(moments(&transport, &handle, 4).await.len(), 1);
    let origin_flip = transport
        .call(
            RequestContext::unbounded(),
            keyed_request(
                40,
                "versionedText.write",
                Some(handle.clone()),
                "stable-id",
                json!({ "versionId": "main", "path": "id.md", "text": "same", "origin": "sync" }),
            ),
        )
        .await
        .expect_err("write provenance mismatch");
    assert_eq!(origin_flip.message, "idempotency-key-reuse-mismatch");
    let mismatch = transport
        .call(
            RequestContext::unbounded(),
            keyed_request(
                5,
                "versionedText.write",
                Some(handle.clone()),
                "stable-id",
                json!({ "versionId": "main", "path": "id.md", "text": "different", "origin": "api" }),
            ),
        )
        .await
        .expect_err("reuse mismatch");
    assert_eq!(mismatch.message, "idempotency-key-reuse-mismatch");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn raw_text_and_secret_bodies_round_trip_byte_identical() {
    let (_scratch, transport, handle) = fixture("raw-bodies").await;
    let body = "  leading\r\ntrailing  ";
    let written = write(&transport, &handle, 2, "raw.md", body, "raw-body").await;
    assert_eq!(
        written["snapshot"]["text"], body,
        "re-add trimming, CRLF rewriting, or body NFC normalization -> either equality fails."
    );
    let read = call(
        &transport,
        &handle,
        3,
        "versionedText.read",
        json!({ "versionId": "main", "path": "raw.md" }),
    )
    .await;
    assert_eq!(read["text"], body);
    call(
        &transport,
        &handle,
        4,
        "secrets.write",
        json!({
            "workspaceId": "ws-rpcd-raw-bodies",
            "versionId": "main",
            "path": ".env",
            "text": body,
            "origin": "api",
            "momentId": "raw-secret",
        }),
    )
    .await;
    let materialized = call(
        &transport,
        &handle,
        5,
        "secrets.materialize",
        json!({
            "versionId": "main",
            "path": ".env",
        }),
    )
    .await;
    assert_eq!(materialized["text"], body);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn rename_is_one_moment_atomic_and_secret_floor_is_enforced() {
    let (_scratch, transport, handle) = fixture("rename").await;
    write(
        &transport,
        &handle,
        2,
        "old.md",
        "searchable",
        "rename-seed",
    )
    .await;
    let renamed = call_keyed(
        &transport,
        &handle,
        3,
        "versionedText.rename",
        "rename-1",
        json!({ "versionId": "main", "fromPath": "old.md", "toPath": "new.md", "origin": "api" }),
    )
    .await;
    assert_eq!(renamed["moment"]["operation"], "rename");
    assert_eq!(renamed["moment"]["beforePath"], "old.md");
    assert!(renamed["before"].get("text").is_none());
    assert!(renamed["after"].get("text").is_none());
    assert!(
        call(
            &transport,
            &handle,
            4,
            "versionedText.read",
            json!({ "versionId": "main", "path": "old.md" })
        )
        .await
        .is_null()
    );
    assert_eq!(
        call(
            &transport,
            &handle,
            5,
            "versionedText.read",
            json!({ "versionId": "main", "path": "new.md" })
        )
        .await["text"],
        "searchable"
    );
    assert_eq!(moments(&transport, &handle, 6).await.len(), 2);
    let secret = transport.call(RequestContext::unbounded(), keyed_request(7, "versionedText.rename", Some(handle.clone()), "rename-secret", json!({ "versionId": "main", "fromPath": "new.md", "toPath": ".env", "origin": "api" }))).await.expect_err("secret floor");
    assert_eq!(secret.message, "invalid-path");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn rollback_waits_for_sync_to_send_a_save_with_a_settlement_proof() {
    use dohc_engine_domain::{NoFaults, VersionedTextStore, WriteText};
    use dohc_engine_storage::{EngineStore, StorageError};

    const WS: &str = "ws-rpcd-unsent-proof";
    let scratch = ScratchDir::new().expect("scratch");
    write_root_binding(scratch.path(), TOKEN).expect("root binding");
    std::fs::write(scratch.path().join("signed.md"), "signed").expect("disk");
    let db_path = scratch.path().join(".dohc/engine/engine.db");
    std::fs::create_dir_all(db_path.parent().expect("engine dir")).expect("engine dir");
    {
        let mut store = EngineStore::open(&db_path, 1).expect("store");
        store.bind_root_token(TOKEN, &NoFaults).expect("bind token");
        VersionedTextStore::new(&mut store)
            .ensure_main_version(WS, "main", 1, &NoFaults)
            .expect("main");
        dohc_engine_sync::adopt_join_identity(
            &mut store, WS, "origin", "epoch", "stream", 1, &NoFaults,
        )
        .expect("identity");
        VersionedTextStore::new(&mut store)
            .write_text(
                &WriteText {
                    workspace_id: WS.to_owned(),
                    version_id: "main".to_owned(),
                    object_id: "signed-object".to_owned(),
                    path: "signed.md".to_owned(),
                    text: "signed".to_owned(),
                    moment_id: "signed-save".to_owned(),
                    metadata_origin: "api".to_owned(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: None,
                    now_ms: 2,
                    request_id: None,
                },
                &NoFaults,
            )
            .expect("write");
        store
            .write_with(&NoFaults, |tx| {
                dohc_engine_sync::journal_moment_append_in_tx(tx, WS, "signed-save")
                    .map_err(StorageError::persist_public)?;
                tx.execute(
                    "UPDATE replication_log SET payload_json=json_set(payload_json,'$.settlementReference',json('{}')) \
                     WHERE workspace_id=?1 AND op_kind='moment.append'",
                    [WS],
                )
                .map_err(StorageError::persist_public)?;
                tx.execute(
                    "INSERT INTO sync_relay_push_state(workspace_id,origin_id,pushed_seq) VALUES (?1,'origin',-1)",
                    [WS],
                )
                .map_err(StorageError::persist_public)?;
                Ok::<_, StorageError>(())
            })
            .expect("journal unsent save");
    }

    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let opened = call_with_busy_retry(
        &transport,
        RequestContext::unbounded(),
        request(
            1,
            "workspace.open",
            None,
            json!({ "rootDir": scratch.path().to_string_lossy(), "workspaceId": WS }),
        ),
    )
    .await
    .expect("open");
    let handle: WorkspaceHandle =
        serde_json::from_value(opened.result["workspace"].clone()).expect("handle");
    let error = transport
        .call(
            RequestContext::unbounded(),
            request(
                2,
                "versionedText.rollback",
                Some(handle.clone()),
                json!({
                    "versionId": "main",
                    "path": "signed.md",
                    "mutationMomentId": "signed-save",
                    "origin": "restore",
                }),
            ),
        )
        .await
        .expect_err("rollback before the relay answers");
    assert_eq!(error.code, ErrorCode::Overloaded);
    assert_eq!(
        error.message,
        "Sync hasn't sent this change yet. Turn sync on and let it finish, then roll the change back."
    );
    assert_eq!(
        call(
            &transport,
            &handle,
            3,
            "versionedText.read",
            json!({ "versionId": "main", "path": "signed.md" })
        )
        .await["text"],
        "signed"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn leased_doc_rejects_write_rename_delete_and_rollback() {
    let (_scratch, transport, handle) = fixture("leases").await;
    let seed = write(&transport, &handle, 2, "leased.md", "held", "lease-seed").await;
    let opened = call(
        &transport,
        &handle,
        3,
        "ydoc.open",
        json!({ "versionId": "main", "path": "leased.md" }),
    )
    .await;
    let calls = [
        (
            4,
            "versionedText.write",
            Some("lease-write"),
            json!({ "versionId": "main", "path": "leased.md", "text": "blocked", "origin": "api" }),
        ),
        (
            5,
            "versionedText.rename",
            Some("lease-rename"),
            json!({ "versionId": "main", "fromPath": "leased.md", "toPath": "other.md", "origin": "api" }),
        ),
        (
            6,
            "versionedText.delete",
            Some("lease-delete"),
            json!({ "versionId": "main", "path": "leased.md", "origin": "api" }),
        ),
        (
            7,
            "versionedText.rollback",
            None,
            json!({ "versionId": "main", "path": "leased.md", "mutationMomentId": seed["moment"]["momentId"], "origin": "restore" }),
        ),
    ];
    for (id, method, key, params) in calls {
        let mut leased = request(id, method, Some(handle.clone()), params);
        leased.idempotency_key = key.map(str::to_owned);
        let error = transport
            .call(RequestContext::unbounded(), leased)
            .await
            .expect_err("leased mutation");
        assert_eq!(error.message, "ydoc-session-busy", "{method}");
    }
    call(
        &transport,
        &handle,
        8,
        "ydoc.close",
        json!({ "sessionId": opened["sessionId"], "settle": false }),
    )
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fts_is_maintained_in_each_mutation_transaction() {
    let (scratch, transport, handle) = fixture("fts").await;
    write(
        &transport,
        &handle,
        2,
        "alpha.md",
        "uniqueterm",
        "fts-write",
    )
    .await;
    let hit = search(&transport, &handle, 3, "uniqueterm").await;
    assert!(!hit.as_array().expect("results").is_empty());
    call_keyed(&transport, &handle, 4, "versionedText.rename", "fts-rename", json!({ "versionId": "main", "fromPath": "alpha.md", "toPath": "beta.md", "origin": "api" })).await;
    let renamed = search(&transport, &handle, 5, "uniqueterm").await;
    assert_eq!(renamed[0]["path"], "beta.md");
    let deleted = call_keyed(
        &transport,
        &handle,
        6,
        "versionedText.delete",
        "fts-delete",
        json!({ "versionId": "main", "path": "beta.md", "origin": "api" }),
    )
    .await;
    let gone = search(&transport, &handle, 7, "uniqueterm").await;
    assert!(gone.as_array().expect("results").is_empty());
    call(&transport, &handle, 8, "versionedText.rollback", json!({ "versionId": "main", "path": "beta.md", "mutationMomentId": deleted["moment"]["momentId"], "origin": "restore" })).await;
    let restored = search(&transport, &handle, 9, "uniqueterm").await;
    assert_eq!(restored[0]["path"], "beta.md");
    std::fs::write(scratch.path().join("beta.md"), b"uniqueterm").expect("matching preimage");
    call(
        &transport,
        &handle,
        10,
        "versionedBinary.write",
        json!({ "versionId": "main", "path": "beta.md", "bytes": [0, 255], "origin": "api" }),
    )
    .await;
    let binary_gone = search(&transport, &handle, 11, "uniqueterm").await;
    assert!(binary_gone.as_array().expect("results").is_empty());
}

fn seed_versions(root: &Path, workspace_id: &str) {
    use dohc_engine_domain::{
        CreateNamedVersion, NoFaults, VersionedTextStore, WriteBinary, WriteText,
    };
    use dohc_engine_storage::EngineStore;

    std::fs::create_dir_all(root.join(".dohc/engine")).expect("engine dir");
    let mut store = EngineStore::open(&root.join(".dohc/engine/engine.db"), 1).expect("store");
    // The seed creates the engine db, so the binding token must bind here:
    // a pre-existing unbound db is exactly what workspace.open refuses.
    store.bind_root_token(TOKEN, &NoFaults).expect("bind token");
    let faults = NoFaults;
    let mut versioned = VersionedTextStore::new(&mut store);
    versioned
        .ensure_main_version(workspace_id, "main", 1, &faults)
        .expect("main");
    versioned
        .write_text(
            &WriteText {
                workspace_id: workspace_id.to_owned(),
                version_id: "main".to_owned(),
                object_id: "base-object".to_owned(),
                path: "merge.md".to_owned(),
                text: "base".to_owned(),
                moment_id: "base-moment".to_owned(),
                metadata_origin: "api".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 2,
                request_id: None,
            },
            &faults,
        )
        .expect("base");
    versioned
        .create_named_version(
            &CreateNamedVersion {
                workspace_id: workspace_id.to_owned(),
                new_version_id: "feature".to_owned(),
                name: "Feature".to_owned(),
                from_version_id: "main".to_owned(),
                now_ms: 3,
                request_id: None,
            },
            &faults,
        )
        .expect("fork");
    versioned
        .write_text(
            &WriteText {
                workspace_id: workspace_id.to_owned(),
                version_id: "feature".to_owned(),
                object_id: "ignored".to_owned(),
                path: "merge.md".to_owned(),
                text: "incoming".to_owned(),
                moment_id: "incoming-moment".to_owned(),
                metadata_origin: "api".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 4,
                request_id: None,
            },
            &faults,
        )
        .expect("incoming");
    versioned
        .write_binary(
            &WriteBinary {
                workspace_id: workspace_id.to_owned(),
                version_id: "feature".to_owned(),
                object_id: "binary-object".to_owned(),
                path: "asset.bin".to_owned(),
                bytes: vec![1, 2, 3],
                moment_id: "binary-moment".to_owned(),
                metadata_origin: "api".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 5,
                request_id: None,
            },
            &faults,
        )
        .expect("binary");
}

/// WS-G1 over the wire: a path holding bytes on one side compares as a present
/// binary head, a source-only change fast-forwards through the binary write
/// status, and divergent bytes open a conflict — each carrying the content
/// address and byte length the review surface renders.
///
/// `asset.bin` exists only in the source, so nothing on the target can be lost
/// and the merge takes it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn compare_and_merge_carry_a_binary_head_through_the_wire() {
    let scratch = ScratchDir::new().expect("scratch");
    write_root_binding(scratch.path(), TOKEN).expect("root binding");
    seed_versions(scratch.path(), "ws-rpcd-binary-merge-wire");
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
                "workspaceId": "ws-rpcd-binary-merge-wire"
            }),
        ),
    )
    .await
    .expect("open");
    let handle: WorkspaceHandle =
        serde_json::from_value(opened.result["workspace"].clone()).expect("handle");

    let sha256 = dohc_engine_storage::hex_sha256(&[1, 2, 3]);
    let compared = call(
        &transport,
        &handle,
        2,
        "versionedText.compare",
        json!({
            "path": "asset.bin",
            "sourceVersionId": "feature",
            "targetVersionId": "main"
        }),
    )
    .await;
    assert_eq!(compared["status"], "incoming-changed");
    assert_eq!(compared["current"], serde_json::Value::Null);
    assert_eq!(compared["incoming"]["contentKind"], "binary");
    assert_eq!(compared["incoming"]["text"], "");
    assert_eq!(compared["incoming"]["sha256"], sha256);
    assert_eq!(compared["incoming"]["blobSha256"], sha256);
    assert_eq!(compared["incoming"]["byteLength"], 3);

    let merged = call_keyed(
        &transport,
        &handle,
        3,
        "versionedText.merge",
        "binary-merge-wire",
        json!({
            "path": "asset.bin",
            "sourceVersionId": "feature",
            "targetVersionId": "main",
            "origin": "api"
        }),
    )
    .await;
    assert_eq!(merged["status"], "merged");
    assert_eq!(merged["writeKind"], "binary-write");
    assert_eq!(merged["snapshot"]["contentKind"], "binary");
    assert_eq!(merged["snapshot"]["sha256"], sha256);
    assert_eq!(merged["snapshot"]["byteLength"], 3);
    assert_eq!(merged["snapshot"]["path"], "asset.bin");
    assert_eq!(merged["snapshot"]["versionId"], "main");
    assert!(merged["snapshot"].get("text").is_none());
    assert!(merged["moment"]["momentId"].is_string());
    assert_eq!(merged["deduped"], false);
    assert_eq!(merged["conflictId"], serde_json::Value::Null);

    // Divergent bytes still go to the user, with both sides addressable. Both
    // sides change after the merge: bytes only Main changed are left alone.
    let other = dohc_engine_storage::hex_sha256(&[9, 9]);
    let newer = dohc_engine_storage::hex_sha256(&[7, 7, 7, 7]);
    for (id, version_id, bytes) in [(4, "main", vec![9, 9]), (40, "feature", vec![7, 7, 7, 7])] {
        call(
            &transport,
            &handle,
            id,
            "versionedBinary.write",
            json!({
                "versionId": version_id,
                "path": "asset.bin",
                "bytes": bytes,
                "origin": "api"
            }),
        )
        .await;
    }
    let conflicted = call_keyed(
        &transport,
        &handle,
        5,
        "versionedText.merge",
        "binary-merge-wire-conflict",
        json!({
            "path": "asset.bin",
            "sourceVersionId": "feature",
            "targetVersionId": "main",
            "origin": "api"
        }),
    )
    .await;
    assert_eq!(conflicted["status"], "conflict");
    let conflict_id = conflicted["conflictId"]
        .as_str()
        .expect("a divergent binary merge opens a conflict")
        .to_owned();

    let conflicts = call(
        &transport,
        &handle,
        6,
        "conflicts.list",
        json!({ "status": "open" }),
    )
    .await;
    let conflict = conflicts["conflicts"]
        .as_array()
        .expect("conflicts")
        .iter()
        .find(|conflict| conflict["id"] == conflict_id.as_str())
        .expect("the opened conflict is listed")
        .clone();
    assert_eq!(conflict["incoming"]["contentKind"], "binary");
    assert_eq!(conflict["incoming"]["binarySha256"], newer);
    assert_eq!(conflict["incoming"]["binaryByteLength"], 4);
    assert_eq!(conflict["incoming"]["snapshot"], serde_json::Value::Null);
    assert_eq!(conflict["current"]["contentKind"], "binary");
    assert_eq!(conflict["current"]["binarySha256"], other);
    assert_eq!(conflict["current"]["binaryByteLength"], 2);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn over_cap_text_read_blob_hydrates_a_workspace_referenced_store_write() {
    use dohc_engine_domain::{NoFaults, VersionedTextStore, WriteText};
    use dohc_engine_storage::EngineStore;

    let scratch = ScratchDir::new().expect("scratch");
    write_root_binding(scratch.path(), TOKEN).expect("root binding");
    let workspace = "ws-rpcd-text-blob";
    let other_workspace = "ws-rpcd-text-blob-other";
    let other_scratch = ScratchDir::new().expect("other workspace scratch");
    let db_path = scratch.path().join(".dohc/engine/engine.db");
    let other_db_path = other_scratch.path().join(".dohc/engine/engine.db");
    for path in [&db_path, &other_db_path] {
        std::fs::create_dir_all(path.parent().expect("engine dir")).expect("engine dir");
    }
    let text = "x".repeat(128 * 1024 + 1);
    let sha256 = dohc_engine_storage::hex_sha256(text.as_bytes());
    let other_text = "referenced only by the other workspace";
    let other_sha = dohc_engine_storage::hex_sha256(other_text.as_bytes());
    {
        let mut store = EngineStore::open(&db_path, 1).expect("store");
        store.bind_root_token(TOKEN, &NoFaults).expect("bind token");
        let faults = NoFaults;
        let mut versioned = VersionedTextStore::new(&mut store);
        versioned
            .ensure_main_version(workspace, "main", 1, &faults)
            .expect("main");
        versioned
            .write_text(
                &WriteText {
                    workspace_id: workspace.to_owned(),
                    version_id: "main".to_owned(),
                    object_id: "large-text-object".to_owned(),
                    path: "large.md".to_owned(),
                    text: text.clone(),
                    moment_id: "large-text-moment".to_owned(),
                    metadata_origin: "api".to_owned(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: None,
                    now_ms: 2,
                    request_id: None,
                },
                &faults,
            )
            .expect("normal text write");
    }
    {
        let mut store = EngineStore::open(&other_db_path, 1).expect("other store");
        store.bind_root_token(TOKEN, &NoFaults).expect("bind token");
        let faults = NoFaults;
        let mut versioned = VersionedTextStore::new(&mut store);
        versioned
            .ensure_main_version(other_workspace, "main", 3, &faults)
            .expect("other main");
        versioned
            .write_text(
                &WriteText {
                    workspace_id: other_workspace.to_owned(),
                    version_id: "main".to_owned(),
                    object_id: "other-text-object".to_owned(),
                    path: "private.md".to_owned(),
                    text: other_text.to_owned(),
                    moment_id: "other-text-moment".to_owned(),
                    metadata_origin: "api".to_owned(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: None,
                    now_ms: 4,
                    request_id: None,
                },
                &faults,
            )
            .expect("other workspace text write");
    }
    // The other workspace's text reaches this root only as a raw payload:
    // nothing versioned here references it.
    {
        let connection = rusqlite::Connection::open(&db_path).expect("sqlite");
        connection
            .execute(
                "ATTACH DATABASE ?1 AS other_root",
                [other_db_path.to_string_lossy().into_owned()],
            )
            .expect("attach other root");
        let copied = connection
            .execute(
                "INSERT INTO blobs SELECT * FROM other_root.blobs WHERE sha256 = ?1",
                [&other_sha],
            )
            .expect("copy unreferenced text payload");
        assert_eq!(copied, 1);
    }

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
                "workspaceId": workspace,
            }),
        ),
    )
    .await
    .expect("open");
    let handle: WorkspaceHandle =
        serde_json::from_value(opened.result["workspace"].clone()).expect("handle");
    let capped = call(
        &transport,
        &handle,
        2,
        "versionedText.read",
        json!({ "versionId": "main", "path": "large.md" }),
    )
    .await;
    assert_eq!(capped["text"], Value::Null);
    assert_eq!(capped["blobSha256"], sha256);

    let output = ProtocolEngineService::call(
        service.as_ref(),
        RequestContext::unbounded().with_capability("blobs"),
        request(
            3,
            "versionedText.readBlob",
            Some(handle.clone()),
            json!({ "workspaceId": workspace, "sha256": sha256 }),
        ),
    )
    .await
    .expect("text blob egress");
    assert_eq!(output.response.result["bytesBase64"], Value::Null);
    let egress = output.blob_egress.expect("over-cap text egress");
    assert_eq!(egress.sha256, sha256);
    assert_eq!(egress.bytes, text.as_bytes());

    let refused = ProtocolEngineService::call(
        service.as_ref(),
        RequestContext::unbounded(),
        request(
            4,
            "versionedText.readBlob",
            Some(handle.clone()),
            json!({ "workspaceId": workspace, "sha256": other_sha }),
        ),
    )
    .await
    .expect_err("other workspace's text blob refuses");
    assert_eq!(refused.message, "file-not-found");

    // Overwrite the path so the original digest is no longer any snapshot's
    // head: its only remaining reference is the moment that wrote it. Reading
    // over-cap text out of HISTORY is exactly what the moments branch of the
    // authorization exists for, and without this the snapshots branch alone
    // could carry the whole test.
    call(
        &transport,
        &handle,
        5,
        "versionedText.write",
        json!({
            "versionId": "main",
            "path": "large.md",
            "text": "small now",
            "origin": "api",
        }),
    )
    .await;
    let historical = ProtocolEngineService::call(
        service.as_ref(),
        RequestContext::unbounded().with_capability("blobs"),
        request(
            6,
            "versionedText.readBlob",
            Some(handle.clone()),
            json!({ "workspaceId": workspace, "sha256": sha256 }),
        ),
    )
    .await
    .expect("historical over-cap text stays readable");
    let historical_egress = historical.blob_egress.expect("history egress");
    assert_eq!(historical_egress.bytes, text.as_bytes());

    call(&transport, &handle, 7, "workspace.close", json!({})).await;
    let connection = rusqlite::Connection::open(&db_path).expect("sqlite");
    let (payloads, references): (i64, i64) = connection
        .query_row(
            "SELECT (SELECT COUNT(*) FROM blobs WHERE sha256 = ?1), \
                    (SELECT COUNT(*) FROM snapshots WHERE blob_sha256 = ?1) + \
                    (SELECT COUNT(*) FROM fork_base_snapshots WHERE blob_sha256 = ?1) + \
                    (SELECT COUNT(*) FROM moments \
                     WHERE after_blob_sha256 = ?1 OR before_blob_sha256 = ?1) + \
                    (SELECT COUNT(*) FROM conflicts \
                     WHERE base_blob_sha256 = ?1 OR current_blob_sha256 = ?1 \
                        OR incoming_blob_sha256 = ?1)",
            [&other_sha],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("count the refused payload and its references");
    assert_eq!(
        (payloads, references),
        (1, 0),
        "the refused text payload exists in this root without a reference"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn blob_capability_gate_prevents_unnegotiated_over_cap_hydration() {
    let (scratch, service, transport, handle) =
        fixture_with_service("blob-capability-hydration").await;
    let workspace = "ws-rpcd-blob-capability-hydration";
    let bytes = vec![0x31_u8; 49_153];
    call(
        &transport,
        &handle,
        2,
        "versionedBinary.write",
        json!({
            "versionId": "main",
            "path": "large.bin",
            "bytes": [0],
            "origin": "api",
        }),
    )
    .await;
    let connection =
        rusqlite::Connection::open(scratch.path().join(".dohc/engine/engine.db")).expect("sqlite");
    let sha256 = dohc_engine_storage::put_binary_blob(&connection, &bytes).expect("large blob");
    connection
        .execute(
            "UPDATE snapshots SET binary_sha256 = ?1 \
             WHERE workspace_id = ?2 AND version_id = 'main' AND path = 'large.bin'",
            rusqlite::params![sha256, workspace],
        )
        .expect("point snapshot at large blob");
    connection
        .execute(
            "UPDATE binary_blobs SET bytes = ?1 WHERE sha256 = ?2",
            rusqlite::params![vec![0x32_u8; bytes.len()], sha256],
        )
        .expect("plant same-length hash corruption");
    drop(connection);

    let metadata = ProtocolEngineService::call(
        service.as_ref(),
        RequestContext::unbounded(),
        request(
            3,
            "versionedBinary.readBlob",
            Some(handle.clone()),
            json!({ "workspaceId": workspace, "sha256": sha256 }),
        ),
    )
    .await
    .expect("non-negotiating client receives metadata");
    assert_eq!(metadata.response.result["bytesBase64"], Value::Null);
    assert_eq!(metadata.response.result["byteLength"], 49_153);
    assert!(metadata.blob_egress.is_none());

    let error = ProtocolEngineService::call(
        service.as_ref(),
        RequestContext::unbounded().with_capability("blobs"),
        request(
            4,
            "versionedBinary.readBlob",
            Some(handle),
            json!({ "workspaceId": workspace, "sha256": sha256 }),
        ),
    )
    .await
    .expect_err("negotiating client hydrates and verifies before streaming");
    assert_eq!(error.message, "persist-failed");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn read_blob_requires_a_reference_from_the_handle_workspace() {
    let (scratch, transport, handle_a) = fixture("blob-scope-a").await;
    let workspace_a = "ws-rpcd-blob-scope-a";
    call(
        &transport,
        &handle_a,
        2,
        "versions.ensureMain",
        json!({ "workspaceId": workspace_a }),
    )
    .await;
    let named = call(
        &transport,
        &handle_a,
        3,
        "versions.createNamed",
        json!({
            "workspaceId": workspace_a,
            "name": "private-binary",
            "fromVersionId": "main",
        }),
    )
    .await;
    let written = call_keyed(
        &transport,
        &handle_a,
        4,
        "versionedBinary.write",
        "private-binary-write",
        json!({
            "versionId": named["id"],
            "path": "private.bin",
            "bytes": [4, 3, 2, 1],
            "origin": "api",
        }),
    )
    .await;
    let sha256 = written["snapshot"]["sha256"].clone();
    let happy = call(
        &transport,
        &handle_a,
        5,
        "versionedBinary.readBlob",
        json!({ "workspaceId": workspace_a, "sha256": sha256 }),
    )
    .await;
    assert_eq!(happy["bytesBase64"], "BAMCAQ==");

    call(&transport, &handle_a, 6, "workspace.close", json!({})).await;
    let connection =
        rusqlite::Connection::open(scratch.path().join(".dohc/engine/engine.db")).expect("sqlite");
    let conflict_bytes = [8_u8, 6, 7, 5, 3, 0, 9];
    let conflict_sha =
        dohc_engine_storage::put_binary_blob(&connection, &conflict_bytes).expect("conflict blob");
    connection
        .execute(
            "INSERT INTO conflicts (\
                workspace_id, conflict_id, path, target_version_id, source_version_id, \
                created_at_ms, updated_at_ms, status, chosen_from, resolution, metadata_origin, \
                base_exists, base_path, current_exists, current_path, \
                incoming_exists, incoming_path, incoming_content_kind, incoming_binary_sha256\
             ) VALUES (?1, 'conflict-only-binary', 'conflict.bin', 'main', ?2, \
                10, 10, 'open', 'current', NULL, 'sync', \
                0, 'conflict.bin', 0, 'conflict.bin', 1, 'conflict.bin', 'binary', ?3)",
            rusqlite::params![
                workspace_a,
                named["id"].as_str().expect("named id"),
                conflict_sha
            ],
        )
        .expect("seed conflict-side-only binary reference");
    let ordinary_references: i64 = connection
        .query_row(
            "SELECT (SELECT COUNT(*) FROM snapshots WHERE binary_sha256 = ?1) + \
                    (SELECT COUNT(*) FROM moments \
                     WHERE after_binary_sha256 = ?1 OR before_binary_sha256 = ?1)",
            [&conflict_sha],
            |row| row.get(0),
        )
        .expect("count ordinary blob references");
    assert_eq!(
        ordinary_references, 0,
        "the conflict is the blob's only reference"
    );
    drop(connection);

    let reopened_a = call_with_busy_retry(
        &transport,
        RequestContext::unbounded(),
        request(
            7,
            "workspace.open",
            None,
            json!({
                "rootDir": scratch.path().to_string_lossy(),
                "workspaceId": workspace_a,
            }),
        ),
    )
    .await
    .expect("reopen workspace A");
    let handle_a: WorkspaceHandle = serde_json::from_value(reopened_a.result["workspace"].clone())
        .expect("reopened workspace A handle");
    let conflict_happy = call(
        &transport,
        &handle_a,
        8,
        "versionedBinary.readBlob",
        json!({ "workspaceId": workspace_a, "sha256": conflict_sha }),
    )
    .await;
    assert_eq!(conflict_happy["bytesBase64"], "CAYHBQMACQ==");
    call(&transport, &handle_a, 9, "workspace.close", json!({})).await;

    // Workspace B owns its own root. A's snapshot and conflict payload bytes
    // exist in B's blob table, but nothing versioned in B references them.
    let scratch_b = ScratchDir::new().expect("workspace B scratch");
    write_root_binding(scratch_b.path(), TOKEN).expect("workspace B root binding");
    let db_path_b = scratch_b.path().join(".dohc/engine/engine.db");
    let open_b = json!({
        "rootDir": scratch_b.path().to_string_lossy(),
        "workspaceId": "ws-rpcd-blob-scope-b",
    });
    let created_b = call_with_busy_retry(
        &transport,
        RequestContext::unbounded(),
        request(10, "workspace.open", None, open_b.clone()),
    )
    .await
    .expect("create workspace B");
    let created_b: WorkspaceHandle =
        serde_json::from_value(created_b.result["workspace"].clone()).expect("workspace B handle");
    call(&transport, &created_b, 11, "workspace.close", json!({})).await;
    let connection = rusqlite::Connection::open(&db_path_b).expect("sqlite");
    let snapshot_payload =
        dohc_engine_storage::put_binary_blob(&connection, &[4, 3, 2, 1]).expect("snapshot payload");
    assert_eq!(snapshot_payload, sha256.as_str().expect("snapshot sha"));
    let conflict_payload = dohc_engine_storage::put_binary_blob(&connection, &conflict_bytes)
        .expect("conflict payload");
    assert_eq!(conflict_payload, conflict_sha);
    drop(connection);

    let opened_b = call_with_busy_retry(
        &transport,
        RequestContext::unbounded(),
        request(12, "workspace.open", None, open_b),
    )
    .await
    .expect("open workspace B");
    let handle_b: WorkspaceHandle =
        serde_json::from_value(opened_b.result["workspace"].clone()).expect("workspace B handle");
    let refused = transport
        .call(
            RequestContext::unbounded(),
            request(
                13,
                "versionedBinary.readBlob",
                Some(handle_b.clone()),
                json!({
                    "workspaceId": "ws-rpcd-blob-scope-b",
                    "sha256": sha256,
                }),
            ),
        )
        .await
        .expect_err("workspace B must not read workspace A's blob");
    assert_eq!(refused.message, "file-not-found");
    let conflict_refused = transport
        .call(
            RequestContext::unbounded(),
            request(
                14,
                "versionedBinary.readBlob",
                Some(handle_b.clone()),
                json!({
                    "workspaceId": "ws-rpcd-blob-scope-b",
                    "sha256": conflict_sha,
                }),
            ),
        )
        .await
        .expect_err("workspace B must not read workspace A's conflict-only blob");
    assert_eq!(conflict_refused.message, "file-not-found");

    call(&transport, &handle_b, 15, "workspace.close", json!({})).await;
    let connection = rusqlite::Connection::open(&db_path_b).expect("sqlite");
    let (payloads, references): (i64, i64) = connection
        .query_row(
            "SELECT (SELECT COUNT(*) FROM binary_blobs WHERE sha256 IN (?1, ?2)), \
                    (SELECT COUNT(*) FROM snapshots WHERE binary_sha256 IN (?1, ?2)) + \
                    (SELECT COUNT(*) FROM moments \
                     WHERE after_binary_sha256 IN (?1, ?2) \
                        OR before_binary_sha256 IN (?1, ?2)) + \
                    (SELECT COUNT(*) FROM conflicts \
                     WHERE base_binary_sha256 IN (?1, ?2) \
                        OR current_binary_sha256 IN (?1, ?2) \
                        OR incoming_binary_sha256 IN (?1, ?2))",
            rusqlite::params![sha256.as_str().expect("snapshot sha"), conflict_sha],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("count B's payloads and references");
    assert_eq!(
        (payloads, references),
        (2, 0),
        "B holds both payloads without a reference to either"
    );
}
