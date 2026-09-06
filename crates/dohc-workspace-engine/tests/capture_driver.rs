//! Files-into-daemon composition acceptance: once a root-bound workspace is
//! open, the watcher + reconcile driver notice EXTERNAL disk changes and
//! record them autonomously — no RPC involved — across text, binary, and
//! secret content; policy flips re-offer; teardown is clean and ordered.

use dohc_engine_protocol::{
    ErrorCode,
    transport::{EngineTransport, InProcessTransport, RequestContext},
    wire::{Request, WorkspaceHandle},
};
use dohc_engine_storage::EngineStore;
use dohc_engine_testkit::ScratchDir;
use dohc_workspace_engine::{
    CAPTURE_MOMENT_RECORDED_EVENT, CaptureApplyProbe, EARLY_IMPORT_MIN_ADDED_FILES,
    EngineEventNotice, EngineService, root_binding::write_root_binding,
};
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

async fn wait_until_capture_ready(
    transport: &InProcessTransport<EngineService>,
    handle: &WorkspaceHandle,
    mut id: u64,
) {
    let deadline = tokio::time::Instant::now() + WAIT;
    loop {
        let status = transport
            .call(
                RequestContext::unbounded(),
                request(id, "watcher.status", Some(handle.clone()), json!({})),
            )
            .await
            .expect("watcher.status");
        id += 1;
        if status.result["phase"] == json!("ready") {
            return;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "capture never became ready: {}",
            status.result
        );
        tokio::task::yield_now().await;
    }
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
    // Before the first capture lands, the main version does not exist yet and
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
    write_root_binding(scratch.path(), TOKEN).expect("root binding");
    let db_path = scratch.path().join(".dohc/engine/engine.db");
    std::fs::create_dir_all(db_path.parent().expect("engine parent")).expect("engine directory");
    let mut store = EngineStore::open(&db_path, 1).expect("fixture store");
    assert!(store.bind_root_token(TOKEN).expect("bind root token"));
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
    write_root_binding(scratch.path(), TOKEN).expect("root binding");
    // Pre-existing content: the startup baseline scan must capture it.
    write_file(scratch.path(), "pre-existing.md", b"before open");

    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let handle = open_workspace(&transport, &scratch, 1).await;

    wait_for_text(&transport, &handle, "pre-existing.md", Some("before open")).await;

    // A file created after open, with no RPC: the watcher must drive it in.
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

/// Drain `capture.momentRecorded` events until one carries `path`, panicking
/// past the shared wait deadline.
async fn wait_for_moment_event(
    events: &mut tokio::sync::mpsc::Receiver<EngineEventNotice>,
    path: &str,
) -> EngineEventNotice {
    let deadline = tokio::time::Instant::now() + WAIT;
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        let notice = tokio::time::timeout(remaining, events.recv())
            .await
            .unwrap_or_else(|_| panic!("timed out waiting for a capture event carrying {path}"))
            .expect("event channel stays open");
        assert_eq!(notice.name, CAPTURE_MOMENT_RECORDED_EVENT);
        assert_eq!(notice.payload["workspaceId"], WORKSPACE_ID);
        if notice.payload["paths"]
            .as_array()
            .is_some_and(|paths| paths.iter().any(|entry| entry == path))
        {
            return notice;
        }
    }
}

/// (metadataSummary, metadataCorrelationId) of the latest moment for `path`,
/// read after workspace close through a fresh store connection.
fn moment_metadata(db: &Path, path: &str) -> (Option<String>, Option<String>) {
    let store = EngineStore::open(db, 100).expect("reopen store");
    store
        .read_with(|conn| {
            conn.query_row(
                "SELECT metadata_summary, metadata_correlation_id FROM moments \
                 WHERE workspace_id = ?1 AND path = ?2 ORDER BY moment_order DESC LIMIT 1",
                [WORKSPACE_ID, path],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
        })
        .expect("moment metadata")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_startup_baseline_stamps_reconcile_provenance_and_emits_one_event() {
    // The D1/D2 acceptance pair.
    let scratch = ScratchDir::new().expect("scratch");
    write_root_binding(scratch.path(), TOKEN).expect("root binding");
    write_file(scratch.path(), "offline-a.md", b"edited while closed a");
    write_file(scratch.path(), "offline-b.md", b"edited while closed b");

    let service = Arc::new(EngineService::new());
    let mut events = service.events().subscribe();
    let transport = InProcessTransport::new(Arc::clone(&service));
    let handle = open_workspace(&transport, &scratch, 1).await;
    wait_for_text(
        &transport,
        &handle,
        "offline-a.md",
        Some("edited while closed a"),
    )
    .await;
    wait_for_text(
        &transport,
        &handle,
        "offline-b.md",
        Some("edited while closed b"),
    )
    .await;

    // One batched event per settled reconcile pass covers both files.
    let notice = wait_for_moment_event(&mut events, "offline-a.md").await;
    let paths = notice.payload["paths"].as_array().expect("paths").clone();
    if !paths.iter().any(|entry| entry == "offline-b.md") {
        wait_for_moment_event(&mut events, "offline-b.md").await;
    }

    transport
        .call(
            RequestContext::unbounded(),
            request(9_100, "workspace.close", Some(handle), json!({})),
        )
        .await
        .expect("close");

    let db_path = scratch.path().join(".dohc/engine/engine.db");
    let (summary_a, correlation_a) = moment_metadata(&db_path, "offline-a.md");
    let (summary_b, correlation_b) = moment_metadata(&db_path, "offline-b.md");
    assert_eq!(summary_a.as_deref(), Some("Reconciled offline edits"));
    assert_eq!(summary_b.as_deref(), Some("Reconciled offline edits"));
    let correlation_a = correlation_a.expect("baseline moments carry a correlation id");
    assert_eq!(
        Some(correlation_a.as_str()),
        correlation_b.as_deref(),
        "one reconcile pass = ONE correlation id across its per-file moments"
    );

    // Second offline window: an edit and a DELETE reconcile in the same pass
    // and must stay one contiguous history group — history groups only
    // consecutive same-correlation moments, so the delete carrying NULL
    // provenance would split it.
    write_file(scratch.path(), "offline-a.md", b"edited offline again");
    std::fs::remove_file(scratch.path().join("offline-b.md")).expect("offline delete");
    let handle = open_workspace(&transport, &scratch, 2_000).await;
    wait_for_text(
        &transport,
        &handle,
        "offline-a.md",
        Some("edited offline again"),
    )
    .await;
    wait_for_text(&transport, &handle, "offline-b.md", None).await;
    transport
        .call(
            RequestContext::unbounded(),
            request(9_101, "workspace.close", Some(handle), json!({})),
        )
        .await
        .expect("second close");

    let (summary_a2, correlation_a2) = moment_metadata(&db_path, "offline-a.md");
    let (summary_b2, correlation_b2) = moment_metadata(&db_path, "offline-b.md");
    assert_eq!(summary_a2.as_deref(), Some("Reconciled offline edits"));
    assert_eq!(
        summary_b2.as_deref(),
        Some("Reconciled offline edits"),
        "the pass's DELETE moment carries the pass summary"
    );
    let correlation_a2 = correlation_a2.expect("second pass carries a correlation id");
    assert_eq!(
        Some(correlation_a2.as_str()),
        correlation_b2.as_deref(),
        "a delete recorded mid-pass shares the pass correlation id"
    );
    assert_ne!(correlation_a2, correlation_a, "each pass mints its own id");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_live_capture_emits_an_event_and_keeps_ts_live_labels() {
    // D2 for the watcher path: with no TS write in the loop, this event is
    // the only signal that tells the renderer a moment landed. D1 (TS
    // parity): a live TEXT capture carries NO summary — the renderer's copy
    // for null is "Edited <basename>" — while a live binary capture carries
    // "Updated <basename>". Neither mints a correlation id.
    let scratch = ScratchDir::new().expect("scratch");
    write_root_binding(scratch.path(), TOKEN).expect("root binding");

    let service = Arc::new(EngineService::new());
    let mut events = service.events().subscribe();
    let transport = InProcessTransport::new(Arc::clone(&service));
    let handle = open_workspace(&transport, &scratch, 1).await;

    write_file(scratch.path(), "notes/live.md", b"external edit");
    wait_for_text(&transport, &handle, "notes/live.md", Some("external edit")).await;
    wait_for_moment_event(&mut events, "notes/live.md").await;
    write_file(scratch.path(), "photo.png", &[0xff, 0x00, 0xfe]);
    wait_for_moment_event(&mut events, "photo.png").await;

    transport
        .call(
            RequestContext::unbounded(),
            request(9_200, "workspace.close", Some(handle), json!({})),
        )
        .await
        .expect("close");

    let db_path = scratch.path().join(".dohc/engine/engine.db");
    assert_eq!(
        moment_metadata(&db_path, "notes/live.md"),
        (None, None),
        "a live text capture must not rewrite the renderer's Edited label"
    );
    let (summary, correlation) = moment_metadata(&db_path, "photo.png");
    assert_eq!(summary.as_deref(), Some("Updated photo.png"));
    assert_eq!(correlation, None, "live captures mint no correlation id");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn open_capture_author_stamps_the_startup_baseline() {
    let scratch = ScratchDir::new().expect("scratch");
    write_root_binding(scratch.path(), TOKEN).expect("root binding");
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
    wait_until_capture_ready(&transport, &handle, 2).await;
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

    assert_eq!(
        captured_author, author,
        "initializing CaptureDriver with None makes this actor-neutral."
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn policy_flip_on_unchanged_files_retires_and_rewidens() {
    let scratch = ScratchDir::new().expect("scratch");
    write_root_binding(scratch.path(), TOKEN).expect("root binding");
    write_file(scratch.path(), "private/journal.md", b"personal");

    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let handle = open_workspace(&transport, &scratch, 1).await;
    wait_for_text(&transport, &handle, "private/journal.md", Some("personal")).await;

    // Narrow without touching the file: the policy fingerprint must trigger a
    // full re-offer and the unchanged path retires (the obligation).
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
async fn a_policy_retire_pass_emits_a_moment_event() {
    // A policy narrow retires an existing head through an ingest that settles
    // NotOwned. The "Stopped tracking by policy" delete moment is real, so
    // gating the event on applied_paths alone would leave the renderer stale
    // for exactly those moments.
    let scratch = ScratchDir::new().expect("scratch");
    write_root_binding(scratch.path(), TOKEN).expect("root binding");
    write_file(scratch.path(), "private/journal.md", b"personal");

    let service = Arc::new(EngineService::new());
    let mut events = service.events().subscribe();
    let transport = InProcessTransport::new(Arc::clone(&service));
    let handle = open_workspace(&transport, &scratch, 1).await;
    wait_for_text(&transport, &handle, "private/journal.md", Some("personal")).await;
    // Drain the baseline capture's own event(s) so the assertion below can
    // only be satisfied by the policy pass.
    while events.try_recv().is_ok() {}

    // Narrow without touching the file: the policy rebuild re-offers the
    // unchanged path and the sink retires it as NotOwned.
    write_file(
        scratch.path(),
        ".dohc/files.toml",
        b"[[rule]]\npath = \"private/**\"\ntracked = false\n",
    );
    wait_for_text(&transport, &handle, "private/journal.md", None).await;
    let notice = wait_for_moment_event(&mut events, "private/journal.md").await;
    assert!(
        notice.payload["notOwnedCount"].as_u64().unwrap_or(0) >= 1,
        "the policy retire settles NotOwned and must be counted: {:?}",
        notice.payload
    );

    transport
        .call(
            RequestContext::unbounded(),
            request(9_300, "workspace.close", Some(handle), json!({})),
        )
        .await
        .expect("close");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_over_cap_policy_retire_keeps_the_pass_provenance_and_emits() {
    // codex re-review P2s: the retained-over-cap retire runs through its own
    // sink and reports via not_owned_paths. With default provenance its
    // delete moment carried a NULL correlation id (splitting the reconcile
    // pass's history group), and gating the event on applied_paths
    // suppressed the announce entirely. Narrow-while-closed makes the
    // sequencing deterministic: the reopen baseline (which carries the
    // reconcile pass provenance) is the first pass to see the narrow, and
    // the over-cap path never emits a diff op, so the retained loop is the
    // only route that can retire it.
    let scratch = ScratchDir::new().expect("scratch");
    write_root_binding(scratch.path(), TOKEN).expect("root binding");
    write_file(scratch.path(), "big.md", b"small enough to capture");

    let service = Arc::new(EngineService::new());
    let transport = InProcessTransport::new(Arc::clone(&service));
    let handle = open_workspace(&transport, &scratch, 1).await;
    wait_for_text(
        &transport,
        &handle,
        "big.md",
        Some("small enough to capture"),
    )
    .await;
    transport
        .call(
            RequestContext::unbounded(),
            request(9_390, "workspace.close", Some(handle), json!({})),
        )
        .await
        .expect("close before offline window");

    // Offline: the file grows past the 64 MiB scan cap and the policy
    // narrows it out of ownership.
    write_file(scratch.path(), "big.md", &vec![0_u8; 65 * 1024 * 1024]);
    write_file(
        scratch.path(),
        ".dohc/files.toml",
        b"[[rule]]
path = \"big.md\"
tracked = false
",
    );

    let mut events = service.events().subscribe();
    let handle = open_workspace(&transport, &scratch, 2).await;
    wait_for_text(&transport, &handle, "big.md", None).await;
    let notice = wait_for_moment_event(&mut events, "big.md").await;
    assert!(
        notice.payload["notOwnedCount"].as_u64().unwrap_or(0) >= 1,
        "the over-cap retire reports via not_owned_paths and must be counted: {:?}",
        notice.payload
    );

    transport
        .call(
            RequestContext::unbounded(),
            request(9_400, "workspace.close", Some(handle), json!({})),
        )
        .await
        .expect("close");

    let db_path = scratch.path().join(".dohc/engine/engine.db");
    let (summary, correlation) = moment_metadata(&db_path, "big.md");
    assert_eq!(summary.as_deref(), Some("Stopped tracking by policy"));
    assert!(
        correlation.is_some(),
        "the over-cap retire must ride its reconcile pass's correlation id"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn binary_and_secret_content_capture_autonomously() {
    let scratch = ScratchDir::new().expect("scratch");
    write_root_binding(scratch.path(), TOKEN).expect("root binding");
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
    write_root_binding(scratch.path(), TOKEN).expect("root binding");

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
    write_root_binding(scratch.path(), TOKEN).expect("root binding");
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

    // Deleted while the daemon is down: only the rehydrated manifest can
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
    write_root_binding(scratch.path(), TOKEN).expect("root binding");
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

    // files.toml narrowed while the daemon was down: the policy-aware seed
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
    write_root_binding(scratch.path(), TOKEN).expect("root binding");
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
    // must not claim it — the manifest states what CAPTURE believes is on
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

    // Prove capture is live rather than merely sleeping: mutate the on-disk
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
    write_root_binding(scratch.path(), TOKEN).expect("root binding");
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

    // Both in the closed window: the file is deleted and policy narrows it.
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
    write_root_binding(scratch.path(), TOKEN).expect("root binding");
    write_file(scratch.path(), "witness.md", b"anchor");

    // Establish the workspace first (open binds the store to the root),
    // then inject the foreign tip — the realistic sequence for an
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

    // A genuinely foreign secret tip (origin "api") whose plaintext
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
    // Disk carries different bytes: a claim would show up as a changed tip.
    write_file(scratch.path(), ".env", b"TOKEN=from-disk");

    let handle = open_workspace(&transport, &scratch, 3).await;
    // Liveness proof: capture ran full cycles before we assert what it did.
    write_file(scratch.path(), "witness.md", b"second cycle");
    wait_for_text(&transport, &handle, "witness.md", Some("second cycle")).await;

    // And the destructive direction: delete the plaintext from disk, which
    // would drive a retire for a capture-owned tip.
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
    write_root_binding(scratch.path(), TOKEN).expect("root binding");
    write_file(scratch.path(), "seed.md", b"seeded before open");

    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let handle = open_workspace(&transport, &scratch, 1).await;

    // A fresh store may open while its all-Added baseline is importing. Wait
    // on the explicit phase before asserting baseline-dependent state.
    wait_until_capture_ready(&transport, &handle, 2).await;
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
    assert_eq!(status.result["phase"], json!("ready"));

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
async fn a_small_fresh_workspace_waits_for_its_complete_baseline() {
    let scratch = ScratchDir::new().expect("scratch");
    write_root_binding(scratch.path(), TOKEN).expect("root binding");
    write_file(scratch.path(), "seed.md", b"small baseline");

    let probe = CaptureApplyProbe::default();
    probe.pause_next_apply();
    let transport = Arc::new(InProcessTransport::new(Arc::new(
        EngineService::with_capture_apply_probe_for_harness(probe.clone()),
    )));
    let opening_transport = Arc::clone(&transport);
    let root = scratch.path().to_path_buf();
    let mut opening = tokio::spawn(async move {
        opening_transport
            .call(
                RequestContext::unbounded(),
                request(
                    1,
                    "workspace.open",
                    None,
                    json!({
                        "rootDir": root.to_string_lossy(),
                        "workspaceId": WORKSPACE_ID
                    }),
                ),
            )
            .await
    });
    probe.wait_until_paused().await;
    assert!(
        tokio::time::timeout(Duration::from_millis(100), &mut opening)
            .await
            .is_err(),
        "a small baseline must finish before workspace.open returns"
    );

    probe.release();
    let opened = opening
        .await
        .expect("open task")
        .expect("workspace open after baseline");
    let handle: WorkspaceHandle =
        serde_json::from_value(opened.result["workspace"].clone()).expect("handle");
    let status = transport
        .call(
            RequestContext::unbounded(),
            request(2, "watcher.status", Some(handle.clone()), json!({})),
        )
        .await
        .expect("watcher.status");
    assert_eq!(status.result["phase"], json!("ready"));
    transport
        .call(
            RequestContext::unbounded(),
            request(3, "workspace.close", Some(handle), json!({})),
        )
        .await
        .expect("close");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn fresh_import_opens_early_fences_partial_reads_and_preserves_foreign_heads() {
    let scratch = ScratchDir::new().expect("scratch");
    write_root_binding(scratch.path(), TOKEN).expect("root binding");
    write_file(scratch.path(), "same.md", b"same bytes");
    write_file(scratch.path(), "different.md", b"disk bytes");
    write_file(scratch.path(), ".env", b"TOKEN=baseline");
    write_file(
        scratch.path(),
        "tasks/collection.yaml",
        b"name: Tasks\nfields:\n  title:\n    type: text\n",
    );
    for index in 2..EARLY_IMPORT_MIN_ADDED_FILES {
        write_file(scratch.path(), &format!("bulk/seed-{index:04}.md"), b"seed");
    }

    let probe = CaptureApplyProbe::default();
    probe.pause_next_apply();
    let transport = InProcessTransport::new(Arc::new(
        EngineService::with_capture_apply_probe_for_harness(probe.clone()),
    ));
    let handle = tokio::time::timeout(
        Duration::from_secs(2),
        open_workspace(&transport, &scratch, 1),
    )
    .await
    .expect("fresh open must not wait for the paused import");
    probe.wait_until_paused().await;

    let status = transport
        .call(
            RequestContext::unbounded(),
            request(2, "watcher.status", Some(handle.clone()), json!({})),
        )
        .await
        .expect("watcher.status");
    assert_eq!(status.result["phase"], json!("importing"));

    let flush = transport
        .call(
            RequestContext::unbounded(),
            request(3, "capture.flush", Some(handle.clone()), json!({})),
        )
        .await
        .expect("capture.flush answers while importing");
    assert_eq!(flush.result["settled"], json!(false));

    let main = transport
        .call(
            RequestContext::unbounded(),
            request(4, "versions.ensureMain", Some(handle.clone()), json!({})),
        )
        .await
        .expect("idempotent main bootstrap stays available while importing");
    assert_eq!(main.result["id"], json!("main"));
    assert_eq!(main.result["kind"], json!("main"));

    for (id, method) in [
        (5, "history.page"),
        (6, "search.query"),
        (7, "versions.list"),
        (50, "collections.list"),
        (51, "collections.get"),
        (52, "collections.query"),
        (53, "collections.getRecord"),
        (54, "collections.listPendingAdoptions"),
    ] {
        let error = transport
            .call(
                RequestContext::unbounded(),
                request(id, method, Some(handle.clone()), json!({})),
            )
            .await
            .expect_err("partial baseline read must be fenced");
        assert_eq!(error.code, ErrorCode::Overloaded, "{method}");
        assert_eq!(error.message, "Workspace is still updating. Try again.");
    }

    let secret_delete = transport
        .call(
            RequestContext::unbounded(),
            request(
                55,
                "secrets.delete",
                Some(handle.clone()),
                json!({
                    "workspaceId": WORKSPACE_ID,
                    "versionId": "main",
                    "path": ".env",
                    "origin": "api",
                    "momentId": "secret-delete-during-import"
                }),
            ),
        )
        .await
        .expect_err("a secret delete must not race the pending baseline");
    assert_eq!(secret_delete.code, ErrorCode::Overloaded);
    assert_eq!(
        secret_delete.message,
        "Workspace is still updating. Try again."
    );

    let secret_materialize = transport
        .call(
            RequestContext::unbounded(),
            request(
                56,
                "secrets.materialize",
                Some(handle.clone()),
                json!({ "versionId": "main", "path": ".env" }),
            ),
        )
        .await
        .expect_err("secret materialization must not read a partial baseline");
    assert_eq!(secret_materialize.code, ErrorCode::Overloaded);
    assert_eq!(
        secret_materialize.message,
        "Workspace is still updating. Try again."
    );

    let secret_write = transport
        .call(
            RequestContext::unbounded(),
            request(
                57,
                "secrets.write",
                Some(handle.clone()),
                json!({
                    "workspaceId": WORKSPACE_ID,
                    "versionId": "main",
                    "path": ".env",
                    "text": "TOKEN=rpc",
                    "origin": "api",
                    "momentId": "secret-write-during-import"
                }),
            ),
        )
        .await
        .expect("a secret write may establish a foreign head during import");
    assert_eq!(secret_write.result["changed"], json!(true));
    assert_eq!(
        secret_write.result["moment"]["id"],
        json!("secret-write-during-import")
    );

    let existing_ydoc = transport
        .call(
            RequestContext::unbounded(),
            request(
                8,
                "ydoc.open",
                Some(handle.clone()),
                json!({
                    "versionId": "main",
                    "path": "same.md",
                    "contentKind": "plaintext"
                }),
            ),
        )
        .await
        .expect_err("a scanned artifact must not mint an absent lease");
    assert_eq!(existing_ydoc.code, ErrorCode::Overloaded);

    let absent_ydoc = transport
        .call(
            RequestContext::unbounded(),
            request(
                9,
                "ydoc.open",
                Some(handle.clone()),
                json!({
                    "versionId": "main",
                    "path": "new-live.md",
                    "contentKind": "plaintext"
                }),
            ),
        )
        .await
        .expect("a proven absent path stays available");
    assert_eq!(absent_ydoc.result["head"], json!("absent"));

    for (id, path, text, object, moment) in [
        (10, "same.md", "same bytes", "rpc-same", "moment-same"),
        (
            11,
            "different.md",
            "rpc bytes",
            "rpc-different",
            "moment-different",
        ),
    ] {
        transport
            .call(
                RequestContext::unbounded(),
                request(
                    id,
                    "versionedText.write",
                    Some(handle.clone()),
                    json!({
                        "versionId": "main",
                        "objectId": object,
                        "path": path,
                        "text": text,
                        "momentId": moment,
                        "metadataOrigin": "api"
                    }),
                ),
            )
            .await
            .expect("first RPC write while importing");
    }

    probe.release();
    wait_until_capture_ready(&transport, &handle, 20).await;
    assert_eq!(
        read_text(&transport, &handle, 30, "same.md")
            .await
            .as_deref(),
        Some("same bytes")
    );
    assert_eq!(
        read_text(&transport, &handle, 31, "different.md")
            .await
            .as_deref(),
        Some("rpc bytes"),
        "a later Added capture must not claim or overwrite a foreign head"
    );
    let collections = transport
        .call(
            RequestContext::unbounded(),
            request(32, "collections.list", Some(handle.clone()), json!({})),
        )
        .await
        .expect("collections become readable after the import");
    assert_eq!(collections.result["collections"][0]["path"], json!("tasks"));

    let captured_secrets = transport
        .call(
            RequestContext::unbounded(),
            request(
                34,
                "secrets.list",
                Some(handle.clone()),
                json!({ "versionId": "main" }),
            ),
        )
        .await
        .expect("baseline secret becomes readable after the import");
    assert_eq!(captured_secrets.result["secrets"][0]["path"], json!(".env"));
    assert_eq!(
        captured_secrets.result["secrets"][0]["latestMomentId"],
        json!("secret-write-during-import"),
        "the baseline capture must not overwrite the RPC head"
    );

    let materialized_secret = transport
        .call(
            RequestContext::unbounded(),
            request(
                33,
                "secrets.materialize",
                Some(handle.clone()),
                json!({ "versionId": "main", "path": ".env" }),
            ),
        )
        .await
        .expect("the authoritative secret materializes after the import");
    assert_eq!(materialized_secret.result["text"], json!("TOKEN=rpc"));

    let deleted = transport
        .call(
            RequestContext::unbounded(),
            request(
                35,
                "secrets.delete",
                Some(handle.clone()),
                json!({
                    "workspaceId": WORKSPACE_ID,
                    "versionId": "main",
                    "path": ".env",
                    "origin": "api",
                    "momentId": "secret-delete-after-import"
                }),
            ),
        )
        .await
        .expect("secret delete succeeds after the import");
    assert_eq!(
        deleted.result["moment"]["id"],
        json!("secret-delete-after-import")
    );
    let secrets_after_delete = transport
        .call(
            RequestContext::unbounded(),
            request(
                36,
                "secrets.list",
                Some(handle.clone()),
                json!({ "versionId": "main" }),
            ),
        )
        .await
        .expect("secrets remain readable after deletion");
    assert_eq!(secrets_after_delete.result["secrets"], json!([]));

    transport
        .call(
            RequestContext::unbounded(),
            request(37, "workspace.close", Some(handle), json!({})),
        )
        .await
        .expect("close");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn stalled_fresh_import_retry_exits_importing_without_detaching_settle() {
    let scratch = ScratchDir::new().expect("scratch");
    write_root_binding(scratch.path(), TOKEN).expect("root binding");
    for index in 0..EARLY_IMPORT_MIN_ADDED_FILES {
        write_file(
            scratch.path(),
            &format!("bulk/seed-{index:04}.md"),
            format!("seed {index}").as_bytes(),
        );
    }

    let probe = CaptureApplyProbe::default();
    probe.fail_next_apply_before_worker();
    probe.pause_next_apply_worker();
    probe.use_manual_initial_settle_deadline();
    let transport = InProcessTransport::new(Arc::new(
        EngineService::with_capture_apply_probe_for_harness(probe.clone()),
    ));
    let handle = tokio::time::timeout(
        Duration::from_secs(2),
        open_workspace(&transport, &scratch, 1),
    )
    .await
    .expect("fresh open must not wait for the initial apply");
    tokio::time::timeout(WAIT, probe.wait_until_apply_worker_paused())
        .await
        .expect("retry plain apply worker must reach the pause seam");

    let importing = transport
        .call(
            RequestContext::unbounded(),
            request(2, "watcher.status", Some(handle.clone()), json!({})),
        )
        .await
        .expect("watcher.status while apply worker is paused");
    assert_eq!(importing.result["phase"], json!("importing"));
    assert_eq!(importing.result["running"], json!(true));
    assert_eq!(
        importing.result["degraded"],
        json!(true),
        "the fast first failure must precede the paused retry"
    );

    probe.expire_initial_settle_deadline();
    let degraded = tokio::time::timeout(Duration::from_secs(2), async {
        let mut id = 3;
        loop {
            let status = transport
                .call(
                    RequestContext::unbounded(),
                    request(id, "watcher.status", Some(handle.clone()), json!({})),
                )
                .await
                .expect("watcher.status after initial apply deadline");
            id += 1;
            if status.result["phase"] == json!("degraded") {
                break status;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("manual apply deadline must leave importing before worker release");
    assert_eq!(degraded.result["running"], json!(false));
    assert_eq!(degraded.result["degraded"], json!(true));
    assert_eq!(degraded.result["terminal"], json!(false));
    assert_eq!(
        probe.layer_start_count(),
        0,
        "the deadline must keep the layer future attached until its worker drains"
    );

    probe.release_apply_worker();
    wait_until_capture_ready(&transport, &handle, 100).await;
    assert_eq!(
        read_text(&transport, &handle, 200, "bulk/seed-0000.md")
            .await
            .as_deref(),
        Some("seed 0")
    );
    let last_index = EARLY_IMPORT_MIN_ADDED_FILES - 1;
    let last_path = format!("bulk/seed-{last_index:04}.md");
    let last_text = format!("seed {last_index}");
    assert_eq!(
        read_text(&transport, &handle, 201, &last_path)
            .await
            .as_deref(),
        Some(last_text.as_str())
    );

    transport
        .call(
            RequestContext::unbounded(),
            request(202, "workspace.close", Some(handle), json!({})),
        )
        .await
        .expect("close after recovered import");

    let reopened = open_workspace(&transport, &scratch, 203).await;
    wait_until_capture_ready(&transport, &reopened, 204).await;
    assert_eq!(
        read_text(&transport, &reopened, 300, "bulk/seed-0000.md")
            .await
            .as_deref(),
        Some("seed 0")
    );
    assert_eq!(
        read_text(&transport, &reopened, 301, &last_path)
            .await
            .as_deref(),
        Some(last_text.as_str())
    );
    transport
        .call(
            RequestContext::unbounded(),
            request(302, "workspace.close", Some(reopened), json!({})),
        )
        .await
        .expect("close reopened workspace");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn existing_store_and_unreadable_policy_keep_the_strict_open_barrier() {
    for unreadable_policy in [false, true] {
        let scratch = ScratchDir::new().expect("scratch");
        write_root_binding(scratch.path(), TOKEN).expect("root binding");
        let probe = CaptureApplyProbe::default();
        let service = Arc::new(EngineService::with_capture_apply_probe_for_harness(
            probe.clone(),
        ));
        let transport = Arc::new(InProcessTransport::new(service));

        if !unreadable_policy {
            let seed = transport
                .call(
                    RequestContext::unbounded(),
                    request(
                        1,
                        "workspace.open",
                        None,
                        json!({
                            "rootDir": scratch.path().to_string_lossy(),
                            "workspaceId": WORKSPACE_ID,
                            "captureMode": "none"
                        }),
                    ),
                )
                .await
                .expect("seed existing store");
            let seed_handle: WorkspaceHandle =
                serde_json::from_value(seed.result["workspace"].clone()).expect("seed handle");
            transport
                .call(
                    RequestContext::unbounded(),
                    request(2, "workspace.close", Some(seed_handle), json!({})),
                )
                .await
                .expect("close seed");
        } else {
            std::fs::create_dir(scratch.path().join(".dohc/files.toml"))
                .expect("unreadable policy shape");
        }
        write_file(scratch.path(), "seed.md", b"baseline bytes");
        probe.pause_next_apply();

        let opening_transport = Arc::clone(&transport);
        let root = scratch.path().to_path_buf();
        let mut opening = tokio::spawn(async move {
            opening_transport
                .call(
                    RequestContext::unbounded(),
                    request(
                        3,
                        "workspace.open",
                        None,
                        json!({
                            "rootDir": root.to_string_lossy(),
                            "workspaceId": WORKSPACE_ID
                        }),
                    ),
                )
                .await
        });
        probe.wait_until_paused().await;
        assert!(
            tokio::time::timeout(Duration::from_millis(100), &mut opening)
                .await
                .is_err(),
            "{} must not release before its baseline",
            if unreadable_policy {
                "unknown policy"
            } else {
                "existing store"
            }
        );
        probe.release();
        let opened = opening
            .await
            .expect("open task")
            .expect("workspace open after baseline");
        let handle: WorkspaceHandle =
            serde_json::from_value(opened.result["workspace"].clone()).expect("handle");
        let status = transport
            .call(
                RequestContext::unbounded(),
                request(4, "watcher.status", Some(handle.clone()), json!({})),
            )
            .await
            .expect("watcher.status");
        assert_ne!(status.result["phase"], json!("importing"));
        if unreadable_policy {
            assert_eq!(status.result["phase"], json!("degraded"));
            let versions = transport
                .call(
                    RequestContext::unbounded(),
                    request(5, "versions.list", Some(handle.clone()), json!({})),
                )
                .await
                .expect("bounded degraded startup must release safe reads");
            assert_eq!(versions.result["versions"], json!([]));
            let main = transport
                .call(
                    RequestContext::unbounded(),
                    request(6, "versions.ensureMain", Some(handle.clone()), json!({})),
                )
                .await
                .expect("main version bootstrap remains available");
            assert_eq!(main.result["id"], json!("main"));
            let versions = transport
                .call(
                    RequestContext::unbounded(),
                    request(7, "versions.list", Some(handle.clone()), json!({})),
                )
                .await
                .expect("bootstrapped version must be readable");
            assert_eq!(versions.result["versions"][0]["versionId"], json!("main"));
            let files = transport
                .call(
                    RequestContext::unbounded(),
                    request(
                        8,
                        "versionedText.list",
                        Some(handle.clone()),
                        json!({ "versionId": "main" }),
                    ),
                )
                .await
                .expect("bounded degraded startup must release file reads");
            assert_eq!(files.result["files"], json!([]));

            // Restore a readable policy, then make the admitted Degraded
            // handle drive its own recovery. The renderer's fileObjectId
            // path is flush-dependent; returning `settled: false` directly
            // from the RPC gate until the background cadence happens to run
            // makes an already-open workspace unusable for Linked Chats.
            std::fs::remove_dir(scratch.path().join(".dohc/files.toml"))
                .expect("restore readable policy");
            let mut settled = false;
            for id in 80..84 {
                let flush = transport
                    .call(
                        RequestContext::unbounded(),
                        request(id, "capture.flush", Some(handle.clone()), json!({})),
                    )
                    .await
                    .expect("degraded capture flush");
                settled = flush.result["settled"] == json!(true);
                if settled {
                    break;
                }
            }
            assert!(
                settled,
                "an admitted degraded handle must let flush drive a clean recovery"
            );
            assert_eq!(
                read_text(&transport, &handle, 84, "seed.md")
                    .await
                    .as_deref(),
                Some("baseline bytes"),
                "the settling flush must install the baseline before dependent reads"
            );
        }
        transport
            .call(
                RequestContext::unbounded(),
                request(90, "workspace.close", Some(handle), json!({})),
            )
            .await
            .expect("close");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn close_cancels_a_paused_fresh_import_and_reopen_converges() {
    let scratch = ScratchDir::new().expect("scratch");
    write_root_binding(scratch.path(), TOKEN).expect("root binding");
    write_file(scratch.path(), "seed.md", b"survives restart");
    for index in 1..EARLY_IMPORT_MIN_ADDED_FILES {
        write_file(scratch.path(), &format!("bulk/seed-{index:04}.md"), b"seed");
    }
    let probe = CaptureApplyProbe::default();
    probe.pause_next_apply();
    let transport = InProcessTransport::new(Arc::new(
        EngineService::with_capture_apply_probe_for_harness(probe.clone()),
    ));
    let handle = open_workspace(&transport, &scratch, 1).await;
    probe.wait_until_paused().await;

    tokio::time::timeout(
        Duration::from_secs(2),
        transport.call(
            RequestContext::unbounded(),
            request(2, "workspace.close", Some(handle), json!({})),
        ),
    )
    .await
    .expect("close must cancel between bounded import chunks")
    .expect("close");

    let reopened = open_workspace(&transport, &scratch, 3).await;
    wait_for_text(&transport, &reopened, "seed.md", Some("survives restart")).await;
    transport
        .call(
            RequestContext::unbounded(),
            request(4, "workspace.close", Some(reopened), json!({})),
        )
        .await
        .expect("final close");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn capture_reconcile_forces_a_full_manifest_rebuild() {
    let scratch = ScratchDir::new().expect("scratch");
    write_root_binding(scratch.path(), TOKEN).expect("root binding");
    write_file(scratch.path(), "seed.md", b"seeded before open");

    let probe = CaptureApplyProbe::default();
    let transport = InProcessTransport::new(Arc::new(
        EngineService::with_capture_apply_probe_for_harness(probe.clone()),
    ));
    let handle = open_workspace(&transport, &scratch, 1).await;
    wait_until_capture_ready(&transport, &handle, 2).await;
    let starts_before = probe.layer_start_count();
    write_file(
        scratch.path(),
        "reconciled.md",
        b"written before forced reconcile",
    );
    let reconcile = transport
        .call(
            RequestContext::unbounded(),
            request(2, "capture.reconcile", Some(handle.clone()), json!({})),
        )
        .await
        .expect("capture.reconcile");

    // The driver can finish the forced rebuild before it receives this RPC's
    // flush request. In that case, the reconcile response is already settled.
    let deadline = tokio::time::Instant::now() + WAIT;
    let mut id = 2;
    let mut settled = reconcile.result["settled"]
        .as_bool()
        .expect("capture.reconcile settled flag");
    while !settled {
        id += 1;
        let flush = transport
            .call(
                RequestContext::unbounded(),
                request(id, "capture.flush", Some(handle.clone()), json!({})),
            )
            .await
            .expect("capture.flush");
        settled = flush.result["settled"]
            .as_bool()
            .expect("capture.flush settled flag");
        assert!(
            settled || tokio::time::Instant::now() < deadline,
            "forced manifest rebuild never settled"
        );
    }
    assert!(
        probe.layer_start_count() > starts_before,
        "capture.reconcile must replace the live files layer"
    );
    id += 1;
    assert_eq!(
        read_text(&transport, &handle, id, "reconciled.md")
            .await
            .as_deref(),
        Some("written before forced reconcile"),
        "the replacement layer must capture the current disk manifest"
    );

    transport
        .call(
            RequestContext::unbounded(),
            request(90_000, "workspace.close", Some(handle), json!({})),
        )
        .await
        .expect("close");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn capture_flush_turns_external_writes_into_read_your_writes() {
    let scratch = ScratchDir::new().expect("scratch");
    write_root_binding(scratch.path(), TOKEN).expect("root binding");

    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let handle = open_workspace(&transport, &scratch, 1).await;

    // An external write with no RPC involved. The only nondeterminism left
    // is the watcher noticing the write (the OS debounce); once it has, one
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
async fn e_rpcs_on_a_closed_handle_fail_cleanly() {
    let scratch = ScratchDir::new().expect("scratch");
    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    // On a CLOSED handle both RPCs fail cleanly (no hang, no panic, no
    // stale driver reached).
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
/// drives the real daemon path end to end; the unreadable file is a
/// genuinely share-locked handle (there is deliberately no fault-injection
/// seam at the daemon level), which is why the test is Windows-only.
#[cfg(windows)]
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_quarantined_path_keeps_capture_flush_unsettled() {
    use std::io::Write as _;
    use std::os::windows::fs::OpenOptionsExt as _;

    let scratch = ScratchDir::new().expect("scratch");
    write_root_binding(scratch.path(), TOKEN).expect("root binding");
    write_file(scratch.path(), "healthy.md", b"captured fine");

    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let handle = open_workspace(&transport, &scratch, 1).await;

    // The baseline must settle first, so the locked file below is the only
    // unclean thing in the workspace when the assertions run.
    let deadline = std::time::Instant::now() + WAIT;
    let mut id = 2_u64;
    loop {
        let baseline = transport
            .call(
                RequestContext::unbounded(),
                request(id, "capture.flush", Some(handle.clone()), json!({})),
            )
            .await
            .expect("baseline flush");
        id += 1;
        if baseline.result["settled"] == json!(true) {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "fresh startup import never became ready"
        );
        tokio::task::yield_now().await;
    }

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
    id = id.max(10);
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
    // failure. Without the converged-with-quarantine guard these would
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
