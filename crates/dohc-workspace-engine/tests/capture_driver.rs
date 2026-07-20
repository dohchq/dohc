//! Files-into-daemon composition acceptance: once a shadow-bound workspace is
//! open, the watcher + reconcile driver notice EXTERNAL disk changes and
//! record them autonomously — no RPC involved — across text, binary, and
//! secret content; policy flips re-offer; teardown is clean and ordered.

use dohc_engine_protocol::{
    transport::{EngineTransport, InProcessTransport, RequestContext},
    wire::{Request, WorkspaceHandle},
};
use dohc_engine_storage::EngineStore;
use dohc_engine_testkit::ScratchDir;
use dohc_workspace_engine::{EngineService, shadow_fence::write_shadow_marker_for_harness};
use serde_json::{Value, json};
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

const TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const WORKSPACE_ID: &str = "ws-capture-driver";
/// Generous: watcher settle + the 500ms drive interval + scan/hash time.
const WAIT: Duration = Duration::from_secs(20);

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

async fn open_workspace(
    transport: &InProcessTransport<EngineService>,
    scratch: &ScratchDir,
    id: u64,
) -> WorkspaceHandle {
    let opened = transport
        .call(
            RequestContext::unbounded(),
            request(
                id,
                "workspace.open",
                None,
                json!({
                    "rootDir": scratch.path().to_string_lossy(),
                    "workspaceId": WORKSPACE_ID,
                }),
            ),
        )
        .await
        .expect("workspace open");
    serde_json::from_value(opened.result["workspace"].clone()).expect("workspace handle")
}

async fn read_text(
    transport: &InProcessTransport<EngineService>,
    handle: &WorkspaceHandle,
    id: u64,
    path: &str,
) -> Option<String> {
    let response = transport
        .call(
            RequestContext::unbounded(),
            request(
                id,
                "versionedText.read",
                Some(handle.clone()),
                json!({ "versionId": "main", "path": path }),
            ),
        )
        .await;
    // Before the FIRST capture lands, the main version does not exist yet and
    // the read errors — that is simply "not captured yet" for the poll.
    let Ok(response) = response else {
        return None;
    };
    if response.result.is_null() {
        None
    } else {
        response.result["text"].as_str().map(str::to_owned)
    }
}

/// Poll until the captured text for `path` matches `expected` (None =
/// expect the head absent/retired).
async fn wait_for_text(
    transport: &InProcessTransport<EngineService>,
    handle: &WorkspaceHandle,
    path: &str,
    expected: Option<&str>,
) {
    let deadline = tokio::time::Instant::now() + WAIT;
    let mut id = 10_000;
    loop {
        id += 1;
        let current = read_text(transport, handle, id, path).await;
        if current.as_deref() == expected {
            return;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "timed out waiting for {path} to become {expected:?}; last saw {current:?}"
        );
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

fn write_file(root: &Path, path: &str, bytes: &[u8]) {
    let absolute = root.join(path);
    if let Some(parent) = absolute.parent() {
        std::fs::create_dir_all(parent).expect("create parent");
    }
    std::fs::write(absolute, bytes).expect("write file");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn autonomous_capture_notices_external_disk_changes() {
    let scratch = ScratchDir::new().expect("scratch");
    write_shadow_marker_for_harness(scratch.path(), TOKEN).expect("marker");
    // Pre-existing content: the startup baseline scan must capture it.
    write_file(scratch.path(), "pre-existing.md", b"before open");

    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let handle = open_workspace(&transport, &scratch, 1).await;

    wait_for_text(&transport, &handle, "pre-existing.md", Some("before open")).await;

    // A file created AFTER open, with no RPC: the watcher must drive it in.
    write_file(scratch.path(), "notes/external.md", b"external edit");
    wait_for_text(
        &transport,
        &handle,
        "notes/external.md",
        Some("external edit"),
    )
    .await;

    // An update coalesces to the latest bytes.
    write_file(scratch.path(), "notes/external.md", b"updated");
    wait_for_text(&transport, &handle, "notes/external.md", Some("updated")).await;

    // A delete retires the head.
    std::fs::remove_file(scratch.path().join("notes/external.md")).expect("delete");
    wait_for_text(&transport, &handle, "notes/external.md", None).await;

    transport
        .call(
            RequestContext::unbounded(),
            request(9_000, "workspace.close", Some(handle), json!({})),
        )
        .await
        .expect("close");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn policy_flip_on_unchanged_files_retires_and_rewidens() {
    let scratch = ScratchDir::new().expect("scratch");
    write_shadow_marker_for_harness(scratch.path(), TOKEN).expect("marker");
    write_file(scratch.path(), "private/journal.md", b"personal");

    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let handle = open_workspace(&transport, &scratch, 1).await;
    wait_for_text(&transport, &handle, "private/journal.md", Some("personal")).await;

    // Narrow WITHOUT touching the file: the policy fingerprint must trigger a
    // full re-offer and the unchanged path retires (the #205 obligation).
    write_file(
        scratch.path(),
        ".dohc/files.toml",
        b"[[rule]]\npath = \"private/**\"\ntracked = false\n",
    );
    wait_for_text(&transport, &handle, "private/journal.md", None).await;

    // Widen again: the path re-ingests with the same on-disk bytes.
    write_file(scratch.path(), ".dohc/files.toml", b"");
    wait_for_text(&transport, &handle, "private/journal.md", Some("personal")).await;

    transport
        .call(
            RequestContext::unbounded(),
            request(9_000, "workspace.close", Some(handle), json!({})),
        )
        .await
        .expect("close");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn binary_and_secret_content_capture_autonomously() {
    let scratch = ScratchDir::new().expect("scratch");
    write_shadow_marker_for_harness(scratch.path(), TOKEN).expect("marker");
    write_file(scratch.path(), "photo.png", &[0x89, 0x50, 0x4e, 0x47]);
    write_file(scratch.path(), ".env", b"TOKEN=alpha");
    write_file(scratch.path(), "witness.md", b"same scan");

    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let handle = open_workspace(&transport, &scratch, 1).await;
    // The text witness proves the baseline scan cycle completed.
    wait_for_text(&transport, &handle, "witness.md", Some("same scan")).await;

    let db_path = scratch.path().join(".dohc/engine/engine.db");
    transport
        .call(
            RequestContext::unbounded(),
            request(9_000, "workspace.close", Some(handle), json!({})),
        )
        .await
        .expect("close");

    // Offline inspection after a clean close: the binary head and the
    // encrypted secret tip landed; the secret never touched plaintext tables.
    let store = EngineStore::open(&db_path, 100).expect("reopen store");
    let (binary_heads, secret_tips, env_moments): (i64, i64, i64) = store
        .read_with(|conn| {
            let binary = conn.query_row(
                "SELECT COUNT(*) FROM snapshots s \
                 JOIN path_aliases a ON a.workspace_id = s.workspace_id \
                   AND a.version_id = s.version_id AND a.object_id = s.object_id \
                 WHERE a.path = 'photo.png' AND s.content_kind = 'binary'",
                [],
                |row| row.get(0),
            )?;
            let secret = conn.query_row(
                "SELECT COUNT(*) FROM secret_files WHERE path = '.env'",
                [],
                |row| row.get(0),
            )?;
            let env_moments = conn.query_row(
                "SELECT COUNT(*) FROM moments WHERE path = '.env'",
                [],
                |row| row.get(0),
            )?;
            Ok::<_, rusqlite::Error>((binary, secret, env_moments))
        })
        .expect("offline inspection");
    assert_eq!(binary_heads, 1, "binary head captured");
    assert_eq!(secret_tips, 1, "encrypted secret tip captured");
    assert_eq!(env_moments, 0, "secret never entered plaintext tables");
    assert!(
        scratch.path().join(".dohc/engine/secret.key").exists(),
        "workspace key minted on first secret capture"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn immediate_close_after_write_drains_cleanly_and_reopen_converges() {
    let scratch = ScratchDir::new().expect("scratch");
    write_shadow_marker_for_harness(scratch.path(), TOKEN).expect("marker");

    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let handle = open_workspace(&transport, &scratch, 1).await;

    // Race a disk write against an immediate close: the close must drain the
    // driver without panicking or racing the actor teardown; the capture may
    // or may not have landed.
    write_file(scratch.path(), "raced.md", b"raced content");
    transport
        .call(
            RequestContext::unbounded(),
            request(2, "workspace.close", Some(handle), json!({})),
        )
        .await
        .expect("clean close");

    // Reopen: the startup baseline reconcile converges the raced write.
    let handle = open_workspace(&transport, &scratch, 3).await;
    wait_for_text(&transport, &handle, "raced.md", Some("raced content")).await;
    transport
        .call(
            RequestContext::unbounded(),
            request(9_000, "workspace.close", Some(handle), json!({})),
        )
        .await
        .expect("close");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn files_deleted_while_closed_retire_on_reopen() {
    let scratch = ScratchDir::new().expect("scratch");
    write_shadow_marker_for_harness(scratch.path(), TOKEN).expect("marker");
    write_file(
        scratch.path(),
        "doomed.md",
        b"captured then deleted offline",
    );
    write_file(scratch.path(), "survivor.md", b"stays");

    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let handle = open_workspace(&transport, &scratch, 1).await;
    wait_for_text(
        &transport,
        &handle,
        "doomed.md",
        Some("captured then deleted offline"),
    )
    .await;
    transport
        .call(
            RequestContext::unbounded(),
            request(2, "workspace.close", Some(handle), json!({})),
        )
        .await
        .expect("close");

    // Deleted while the daemon is DOWN: only the rehydrated manifest can
    // know this path was captured — an empty baseline would leave the stale
    // head readable forever.
    std::fs::remove_file(scratch.path().join("doomed.md")).expect("offline delete");

    let handle = open_workspace(&transport, &scratch, 3).await;
    wait_for_text(&transport, &handle, "doomed.md", None).await;
    wait_for_text(&transport, &handle, "survivor.md", Some("stays")).await;
    transport
        .call(
            RequestContext::unbounded(),
            request(9_000, "workspace.close", Some(handle), json!({})),
        )
        .await
        .expect("close");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn policy_narrowed_while_closed_retires_on_reopen() {
    let scratch = ScratchDir::new().expect("scratch");
    write_shadow_marker_for_harness(scratch.path(), TOKEN).expect("marker");
    write_file(scratch.path(), "private/journal.md", b"personal");

    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let handle = open_workspace(&transport, &scratch, 1).await;
    wait_for_text(&transport, &handle, "private/journal.md", Some("personal")).await;
    transport
        .call(
            RequestContext::unbounded(),
            request(2, "workspace.close", Some(handle), json!({})),
        )
        .await
        .expect("close");

    // files.toml narrowed while the daemon was DOWN: the policy-aware seed
    // must re-offer the unchanged path so the sink retires it on reopen.
    write_file(
        scratch.path(),
        ".dohc/files.toml",
        b"[[rule]]\npath = \"private/**\"\ntracked = false\n",
    );

    let handle = open_workspace(&transport, &scratch, 3).await;
    wait_for_text(&transport, &handle, "private/journal.md", None).await;
    transport
        .call(
            RequestContext::unbounded(),
            request(9_000, "workspace.close", Some(handle), json!({})),
        )
        .await
        .expect("close");
}
