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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn workspace_open_without_startup_maintenance_does_not_capture_disk() {
    let scratch = ScratchDir::new().expect("scratch");
    write_shadow_marker_for_harness(scratch.path(), TOKEN).expect("marker");
    let db_path = scratch.path().join(".dohc/engine/engine.db");
    std::fs::create_dir_all(db_path.parent().expect("engine parent")).expect("engine directory");
    let mut store = EngineStore::open(&db_path, 1).expect("fixture store");
    assert!(
        store
            .bind_shadow_clone_token(TOKEN)
            .expect("bind shadow token")
    );
    drop(store);
    write_file(scratch.path(), "must-stay-on-disk.md", b"typescript-owned");

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
                    "workspaceId": WORKSPACE_ID,
                    "recoverRunningDispatches": false,
                    "skipStartupMaintenance": true,
                }),
            ),
        )
        .await
        .expect("maintenance-free workspace open");
    let handle: WorkspaceHandle =
        serde_json::from_value(opened.result["workspace"].clone()).expect("workspace handle");

    transport
        .call(
            RequestContext::unbounded(),
            request(2, "workspace.close", Some(handle), json!({})),
        )
        .await
        .expect("workspace close");

    let store = EngineStore::open_read_only(&db_path).expect("reopen read-only");
    let captured: i64 = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM snapshots WHERE path = 'must-stay-on-disk.md'",
                [],
                |row| row.get(0),
            )
        })
        .expect("captured snapshot count");
    assert_eq!(
        captured, 0,
        "a daemon-only read open must not baseline-capture TypeScript-owned disk state"
    );
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
async fn open_capture_author_stamps_the_startup_baseline() {
    let scratch = ScratchDir::new().expect("scratch");
    write_shadow_marker_for_harness(scratch.path(), TOKEN).expect("marker");
    write_file(scratch.path(), "during-restart.md", b"closed-period edit");
    let author = json!({
        "kind": "agent",
        "agentId": "agent",
        "onBehalfOf": "local",
        "agentRunId": "run",
    });

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
                    "workspaceId": WORKSPACE_ID,
                    "captureAuthor": author,
                }),
            ),
        )
        .await
        .expect("workspace open");
    let handle: WorkspaceHandle =
        serde_json::from_value(opened.result["workspace"].clone()).expect("workspace handle");
    let db_path = scratch.path().join(".dohc/engine/engine.db");
    transport
        .call(
            RequestContext::unbounded(),
            request(2, "workspace.close", Some(handle), json!({})),
        )
        .await
        .expect("close");

    let store = EngineStore::open(&db_path, 100).expect("reopen store");
    let author_json: Option<String> = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT author_json FROM moments WHERE path = 'during-restart.md'",
                [],
                |row| row.get(0),
            )
        })
        .expect("baseline moment");
    let captured_author: Value = serde_json::from_str(
        author_json
            .as_deref()
            .expect("startup baseline must retain the open author"),
    )
    .expect("valid author json");

    // MUTATION: initializing CaptureDriver with None makes this actor-neutral.
    assert_eq!(captured_author, author);
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

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn rpc_written_content_without_a_disk_file_is_never_retired_by_capture() {
    let scratch = ScratchDir::new().expect("scratch");
    write_shadow_marker_for_harness(scratch.path(), TOKEN).expect("marker");
    // A real captured file anchors the version and proves capture is live.
    write_file(scratch.path(), "on-disk.md", b"captured from disk");

    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let handle = open_workspace(&transport, &scratch, 1).await;
    wait_for_text(
        &transport,
        &handle,
        "on-disk.md",
        Some("captured from disk"),
    )
    .await;

    // DB-only content: written by RPC, never materialized to disk. Capture
    // must NOT claim it — the manifest states what CAPTURE believes is on
    // disk, so a path it never captured can never be diffed as removed.
    transport
        .call(
            RequestContext::unbounded(),
            request(
                2,
                "versionedText.write",
                Some(handle.clone()),
                json!({
                    "versionId": "main",
                    "objectId": "object-rpc",
                    "path": "rpc-only.md",
                    "text": "written by RPC",
                    "momentId": "moment-rpc",
                    "metadataOrigin": "api",
                }),
            ),
        )
        .await
        .expect("rpc write");

    // PROVE capture is live rather than merely sleeping: mutate the on-disk
    // sentinel and wait for the driver to record it. Only then is "rpc-only.md
    // survived" evidence about capture's behavior.
    write_file(scratch.path(), "on-disk.md", b"second capture cycle");
    wait_for_text(
        &transport,
        &handle,
        "on-disk.md",
        Some("second capture cycle"),
    )
    .await;
    assert_eq!(
        read_text(&transport, &handle, 3, "rpc-only.md")
            .await
            .as_deref(),
        Some("written by RPC"),
        "capture must not retire DB-only content it never captured"
    );

    // The same holds across a reopen (the rehydration seed is capture-only).
    transport
        .call(
            RequestContext::unbounded(),
            request(4, "workspace.close", Some(handle), json!({})),
        )
        .await
        .expect("close");
    let handle = open_workspace(&transport, &scratch, 5).await;
    // Same liveness proof after the reopen: the rehydrated baseline must have
    // actually run before "survived" means anything.
    write_file(scratch.path(), "on-disk.md", b"after reopen");
    wait_for_text(&transport, &handle, "on-disk.md", Some("after reopen")).await;
    assert_eq!(
        read_text(&transport, &handle, 6, "rpc-only.md")
            .await
            .as_deref(),
        Some("written by RPC"),
        "the rehydration seed must be capture-origin only"
    );
    transport
        .call(
            RequestContext::unbounded(),
            request(9_000, "workspace.close", Some(handle), json!({})),
        )
        .await
        .expect("close");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn offline_delete_and_narrow_in_the_same_window_still_retires() {
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

    // BOTH in the closed window: the file is deleted AND policy narrows it.
    // A seed that dropped narrowed entries would leave this head orphaned —
    // the path appears in neither the scan listing (deleted) nor the
    // manifest (dropped), so nothing could ever emit its Retire.
    std::fs::remove_file(scratch.path().join("private/journal.md")).expect("offline delete");
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

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn foreign_origin_secret_tip_is_never_claimed_or_retired_by_capture() {
    use dohc_engine_crypto::create_key_file;
    use dohc_engine_domain::{
        NoFaults, SecretDiskIntent, SecretFileStore, SecretWrite, VersionedTextStore,
    };

    let scratch = ScratchDir::new().expect("scratch");
    write_shadow_marker_for_harness(scratch.path(), TOKEN).expect("marker");
    write_file(scratch.path(), "witness.md", b"anchor");

    // Establish the workspace first (the shadow fence binds the store on
    // open), then inject the foreign tip — the realistic sequence for an
    // API/replication write into a live workspace.
    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let handle = open_workspace(&transport, &scratch, 1).await;
    wait_for_text(&transport, &handle, "witness.md", Some("anchor")).await;
    transport
        .call(
            RequestContext::unbounded(),
            request(2, "workspace.close", Some(handle), json!({})),
        )
        .await
        .expect("close before seeding");

    // A genuinely FOREIGN secret tip (origin "api") whose plaintext
    // deliberately differs from what will be on disk — capture must neither
    // overwrite nor retire it.
    let db_path = scratch.path().join(".dohc/engine/engine.db");
    let key = create_key_file(scratch.path()).expect("mint key");
    {
        let mut store = EngineStore::open(&db_path, 1).expect("open store");
        VersionedTextStore::new(&mut store)
            .ensure_main_version(WORKSPACE_ID, "main", 1, &NoFaults)
            .expect("main version");
        SecretFileStore::new(&mut store, &key)
            .write_secret_file(
                &SecretWrite {
                    workspace_id: WORKSPACE_ID.to_owned(),
                    version_id: "main".to_owned(),
                    path: ".env".to_owned(),
                    text: "TOKEN=written-by-api".to_owned(),
                    moment_id: "api-secret-moment".to_owned(),
                    metadata_origin: "api".to_owned(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    now_ms: 5,
                    disk_intent: SecretDiskIntent::Materialize,
                },
                &NoFaults,
            )
            .expect("foreign secret write");
    }
    // Disk carries DIFFERENT bytes: a claim would show up as a changed tip.
    write_file(scratch.path(), ".env", b"TOKEN=from-disk");

    let handle = open_workspace(&transport, &scratch, 3).await;
    // Liveness proof: capture ran full cycles before we assert what it did.
    write_file(scratch.path(), "witness.md", b"second cycle");
    wait_for_text(&transport, &handle, "witness.md", Some("second cycle")).await;

    // And the destructive direction: delete the plaintext from disk, which
    // WOULD drive a retire for a capture-owned tip.
    std::fs::remove_file(scratch.path().join(".env")).expect("delete .env");
    write_file(scratch.path(), "witness.md", b"third cycle");
    wait_for_text(&transport, &handle, "witness.md", Some("third cycle")).await;

    transport
        .call(
            RequestContext::unbounded(),
            request(9_000, "workspace.close", Some(handle), json!({})),
        )
        .await
        .expect("close");

    let mut store = EngineStore::open(&db_path, 100).expect("reopen");
    let (origin, moment_id): (String, String) = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT m.metadata_origin, f.latest_moment_id FROM secret_files f \
                 JOIN secret_moments m ON m.workspace_id = f.workspace_id \
                   AND m.moment_id = f.latest_moment_id \
                 WHERE f.path = '.env'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
        })
        .expect("the foreign tip must still exist");
    assert_eq!(origin, "api", "capture must not claim a foreign secret tip");
    assert_eq!(
        moment_id, "api-secret-moment",
        "the foreign tip must be untouched, not superseded"
    );
    let plaintext = SecretFileStore::new(&mut store, &key)
        .materialize_secret_file(WORKSPACE_ID, "main", ".env")
        .expect("materialize")
        .expect("tip present");
    assert_eq!(
        plaintext.into_utf8().expect("utf8"),
        "TOKEN=written-by-api",
        "the foreign writer's plaintext must survive disk bytes AND a disk delete"
    );
}
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn watcher_status_reports_a_live_driver_and_flush_settles() {
    let scratch = ScratchDir::new().expect("scratch");
    write_shadow_marker_for_harness(scratch.path(), TOKEN).expect("marker");
    write_file(scratch.path(), "seed.md", b"seeded before open");

    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let handle = open_workspace(&transport, &scratch, 1).await;

    // The open barrier guarantees the startup baseline applied, so status
    // reports a LIVE, non-terminal driver immediately — no polling.
    let status = transport
        .call(
            RequestContext::unbounded(),
            request(2, "watcher.status", Some(handle.clone()), json!({})),
        )
        .await
        .expect("watcher.status");
    assert_eq!(status.result["running"], json!(true));
    assert_eq!(status.result["terminal"], json!(false));
    assert_eq!(status.result["degraded"], json!(false));

    // And a flush on the quiescent workspace settles: the baseline content
    // is already captured and acknowledged.
    let flush = transport
        .call(
            RequestContext::unbounded(),
            request(3, "capture.flush", Some(handle.clone()), json!({})),
        )
        .await
        .expect("capture.flush");
    assert_eq!(flush.result["settled"], json!(true));
    assert_eq!(flush.result["running"], json!(true));
    assert_eq!(
        read_text(&transport, &handle, 4, "seed.md")
            .await
            .as_deref(),
        Some("seeded before open"),
        "a settled flush means the baseline capture is READABLE, not pending"
    );

    transport
        .call(
            RequestContext::unbounded(),
            request(5, "workspace.close", Some(handle), json!({})),
        )
        .await
        .expect("close");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn capture_flush_turns_external_writes_into_read_your_writes() {
    let scratch = ScratchDir::new().expect("scratch");
    write_shadow_marker_for_harness(scratch.path(), TOKEN).expect("marker");

    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let handle = open_workspace(&transport, &scratch, 1).await;

    // An external write with no RPC involved. The only nondeterminism left
    // is the watcher noticing the write (the OS debounce); once it has, ONE
    // settled flush is sufficient — the loop below never needs to sleep for
    // capture itself, which is exactly what the differential harness relies
    // on.
    write_file(scratch.path(), "flush-me.md", b"written behind the daemon");
    let deadline = tokio::time::Instant::now() + WAIT;
    let mut id = 20_000;
    loop {
        id += 1;
        let flush = transport
            .call(
                RequestContext::unbounded(),
                request(id, "capture.flush", Some(handle.clone()), json!({})),
            )
            .await
            .expect("capture.flush");
        assert_eq!(
            flush.result["settled"],
            json!(true),
            "a quiet workspace must always settle"
        );
        id += 1;
        if read_text(&transport, &handle, id, "flush-me.md")
            .await
            .as_deref()
            == Some("written behind the daemon")
        {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "flush settled repeatedly but the external write never surfaced"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }

    transport
        .call(
            RequestContext::unbounded(),
            request(90_000, "workspace.close", Some(handle), json!({})),
        )
        .await
        .expect("close");
}
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn e_rpcs_on_a_closed_handle_fail_cleanly_and_unmarked_roots_never_reach_them() {
    // SHADOW-SCOPE ACCEPTANCE for the E surface. Two properties:
    //
    // 1. An UNMARKED root cannot reach watcher.status/capture.flush at all —
    //    workspace.open refuses at the shadow fence, so no handle ever
    //    exists and no watcher can have spawned.
    let scratch = ScratchDir::new().expect("scratch");
    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let refused = transport
        .call(
            RequestContext::unbounded(),
            request(
                1,
                "workspace.open",
                None,
                json!({
                    "rootDir": scratch.path().to_string_lossy(),
                    "workspaceId": WORKSPACE_ID,
                }),
            ),
        )
        .await;
    assert!(refused.is_err(), "an unmarked root must not open");
    assert!(
        !scratch.path().join(".dohc/engine/engine.db").exists(),
        "the refused open must leave no engine state behind"
    );

    // 2. On a CLOSED handle both RPCs fail cleanly (no hang, no panic, no
    //    stale driver reached).
    write_shadow_marker_for_harness(scratch.path(), TOKEN).expect("marker");
    let handle = open_workspace(&transport, &scratch, 2).await;
    transport
        .call(
            RequestContext::unbounded(),
            request(3, "workspace.close", Some(handle.clone()), json!({})),
        )
        .await
        .expect("close");
    for (id, method) in [(4, "watcher.status"), (5, "capture.flush")] {
        let stale = transport
            .call(
                RequestContext::unbounded(),
                request(id, method, Some(handle.clone()), json!({})),
            )
            .await;
        assert!(
            stale.is_err(),
            "{method} on a closed handle must error cleanly"
        );
    }
}

/// A workspace whose reconciler has PARKED a persistently failing path (a
/// non-empty quarantine) must keep answering `capture.flush`
/// `settled: false`: after DEGRADED_RESCAN_BACKOFF identical degraded
/// passes the controller stops self-forcing rescans, so "nothing dirty"
/// coexists with "capture has not recovered" — and reading that as settled
/// would launder live failures into a clean differential baseline. This
/// drives the REAL daemon path end to end; the unreadable file is a
/// genuinely share-locked handle (there is deliberately no fault-injection
/// seam at the daemon level), which is why the test is Windows-only.
#[cfg(windows)]
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_quarantined_path_keeps_capture_flush_unsettled() {
    use std::io::Write as _;
    use std::os::windows::fs::OpenOptionsExt as _;

    let scratch = ScratchDir::new().expect("scratch");
    write_shadow_marker_for_harness(scratch.path(), TOKEN).expect("marker");
    write_file(scratch.path(), "healthy.md", b"captured fine");

    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let handle = open_workspace(&transport, &scratch, 1).await;

    // The baseline must settle first, so the locked file below is the ONLY
    // unclean thing in the workspace when the assertions run.
    let baseline = transport
        .call(
            RequestContext::unbounded(),
            request(2, "capture.flush", Some(handle.clone()), json!({})),
        )
        .await
        .expect("baseline flush");
    assert_eq!(baseline.result["settled"], json!(true));

    // A file every capture read genuinely fails on: created and written
    // through a NO-SHARE handle that stays open for the whole test
    // (ERROR_SHARING_VIOLATION on every scanner open).
    let mut lock = std::fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .share_mode(0)
        .open(scratch.path().join("locked.md"))
        .expect("share-locked file");
    lock.write_all(b"unreadable while locked")
        .expect("locked write");
    lock.flush().expect("locked flush");

    // Wait (bounded) for the watcher to notice and the first capture
    // failure to surface: the first flush answered after that is unsettled.
    let deadline = std::time::Instant::now() + WAIT;
    let mut id = 10_u64;
    loop {
        let flush = transport
            .call(
                RequestContext::unbounded(),
                request(id, "capture.flush", Some(handle.clone()), json!({})),
            )
            .await
            .expect("probe flush");
        id += 1;
        if flush.result["settled"] == json!(false) {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "the locked file was never noticed as a capture failure"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }

    // Each flush drives up to MAX_FLUSH_CYCLES reconcile passes, and the
    // quarantine parks the path after DEGRADED_RESCAN_BACKOFF identical
    // degraded passes — so by these flushes the controller has stopped
    // self-forcing rescans and the workspace is "converged" over a live
    // failure. WITHOUT the converged-with-quarantine guard these would
    // flip to settled:true.
    for _ in 0..3 {
        let flush = transport
            .call(
                RequestContext::unbounded(),
                request(id, "capture.flush", Some(handle.clone()), json!({})),
            )
            .await
            .expect("quarantined flush");
        id += 1;
        assert_eq!(
            flush.result["settled"],
            json!(false),
            "a non-empty quarantine is not quiescence"
        );
        assert_eq!(flush.result["degraded"], json!(true));
        assert_eq!(flush.result["running"], json!(true));
    }

    // Control: the healthy baseline capture is still readable — the
    // workspace is degraded, not wedged.
    assert_eq!(
        read_text(&transport, &handle, id, "healthy.md")
            .await
            .as_deref(),
        Some("captured fine")
    );

    drop(lock);
    transport
        .call(
            RequestContext::unbounded(),
            request(id + 1, "workspace.close", Some(handle), json!({})),
        )
        .await
        .expect("close");
}
