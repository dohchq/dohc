//! Files-into-daemon composition acceptance: once a root-bound workspace is
//! open, the watcher + reconcile driver notice EXTERNAL disk changes and
//! record them autonomously — no RPC involved — across text, binary, and
//! secret content; policy flips re-offer; teardown is clean and ordered.

mod common;

use common::*;
use dohc_engine_protocol::{
    ErrorCode, Retryability,
    transport::{EngineTransport, InProcessTransport, RequestContext},
    wire::WorkspaceHandle,
};
use dohc_engine_storage::{EngineStore, NoFaults};
use dohc_engine_sync::list_replication_ops;
use dohc_engine_testkit::ScratchDir;
use dohc_workspace_engine::{
    CAPTURE_IMPORT_PROGRESS_EVENT, CAPTURE_INITIAL_SETTLED_EVENT, CAPTURE_MOMENT_RECORDED_EVENT,
    CAPTURE_WRITE_DEFERRED_EVENT, CaptureApplyProbe, EARLY_IMPORT_MIN_ADDED_FILES,
    EngineEventNotice, EngineEventReceiver, EngineService, root_binding::write_root_binding,
};
use serde_json::{Value, json};
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

const WORKSPACE_ID: &str = "ws-capture-driver";
/// Generous: watcher settle + the 500ms drive interval + scan/hash time.
const WAIT: Duration = Duration::from_secs(20);

async fn open_workspace(
    transport: &InProcessTransport<EngineService>,
    scratch: &ScratchDir,
    id: u64,
) -> WorkspaceHandle {
    let opened = call_with_busy_retry(
        transport,
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
        let status = call_with_busy_retry(
            transport,
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
    let response = call_with_busy_retry(
        transport,
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

/// Poll until a successful read matches `expected`. Retirement requires a
/// null result; an RPC failure cannot prove that a head is absent.
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
        let current = call_with_busy_retry(
            transport,
            RequestContext::unbounded(),
            request(
                id,
                "versionedText.read",
                Some(handle.clone()),
                json!({ "versionId": "main", "path": path }),
            ),
        )
        .await;
        let matches = current.as_ref().is_ok_and(|response| match expected {
            Some(text) => response.result["text"].as_str() == Some(text),
            None => response.result.is_null(),
        });
        if matches {
            return;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "timed out waiting for {path} to become {expected:?}; last saw {current:?}"
        );
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn workspace_open_without_startup_maintenance_does_not_capture_disk() {
    let scratch = ScratchDir::new().expect("scratch");
    write_root_binding(scratch.path(), TOKEN).expect("root binding");
    let db_path = scratch.path().join(".dohc/engine/engine.db");
    std::fs::create_dir_all(db_path.parent().expect("engine parent")).expect("engine directory");
    let mut store = EngineStore::open(&db_path, 1).expect("fixture store");
    assert!(
        store
            .bind_root_token(TOKEN, &NoFaults)
            .expect("bind root token")
    );
    drop(store);
    write_file(scratch.path(), "must-stay-on-disk.md", b"typescript-owned");

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
        assert_eq!(notice.payload["workspaceId"], WORKSPACE_ID);
        if notice.name == CAPTURE_INITIAL_SETTLED_EVENT {
            continue;
        }
        assert_eq!(notice.name, CAPTURE_MOMENT_RECORDED_EVENT);
        if notice.payload["paths"]
            .as_array()
            .is_some_and(|paths| paths.iter().any(|entry| entry == path))
        {
            return notice;
        }
    }
}

async fn wait_for_initial_settled_event(
    events: &mut tokio::sync::mpsc::Receiver<EngineEventNotice>,
) {
    tokio::time::timeout(WAIT, async {
        loop {
            let notice = events.recv().await.expect("event channel stays open");
            if notice.name == CAPTURE_INITIAL_SETTLED_EVENT {
                assert_eq!(notice.payload, json!({ "workspaceId": WORKSPACE_ID }));
                return;
            }
        }
    })
    .await
    .expect("initial capture must announce its phase transition");
}

fn assert_no_initial_settled_event(events: &mut tokio::sync::mpsc::Receiver<EngineEventNotice>) {
    while let Ok(notice) = events.try_recv() {
        assert_ne!(notice.name, CAPTURE_INITIAL_SETTLED_EVENT);
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

/// Open a new workspace over two existing files and wait for its first
/// import to record both.
async fn open_over_existing_files(
    scratch: &ScratchDir,
) -> (
    InProcessTransport<EngineService>,
    WorkspaceHandle,
    tokio::sync::mpsc::Receiver<EngineEventNotice>,
) {
    write_root_binding(scratch.path(), TOKEN).expect("root binding");
    write_file(scratch.path(), "existing-a.md", b"already here a");
    write_file(scratch.path(), "existing-b.md", b"already here b");

    let service = Arc::new(EngineService::new());
    let events = service.events().subscribe();
    let transport = InProcessTransport::new(Arc::clone(&service));
    let handle = open_workspace(&transport, scratch, 1).await;
    wait_for_text(&transport, &handle, "existing-a.md", Some("already here a")).await;
    wait_for_text(&transport, &handle, "existing-b.md", Some("already here b")).await;
    (transport, handle, events)
}

async fn close_workspace(
    transport: &InProcessTransport<EngineService>,
    handle: WorkspaceHandle,
    id: u64,
) {
    transport
        .call(
            RequestContext::unbounded(),
            request(id, "workspace.close", Some(handle), json!({})),
        )
        .await
        .expect("close");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_new_workspace_baseline_records_one_added_existing_files_pass() {
    let scratch = ScratchDir::new().expect("scratch");
    let (transport, handle, mut events) = open_over_existing_files(&scratch).await;

    // One batched event per settled pass covers both files.
    let notice = wait_for_moment_event(&mut events, "existing-a.md").await;
    let paths = notice.payload["paths"].as_array().expect("paths").clone();
    if !paths.iter().any(|entry| entry == "existing-b.md") {
        wait_for_moment_event(&mut events, "existing-b.md").await;
    }
    close_workspace(&transport, handle, 9_100).await;

    let db_path = scratch.path().join(".dohc/engine/engine.db");
    let (summary_a, correlation_a) = moment_metadata(&db_path, "existing-a.md");
    let (summary_b, correlation_b) = moment_metadata(&db_path, "existing-b.md");
    assert_eq!(summary_a.as_deref(), Some("Added existing files"));
    assert_eq!(summary_b.as_deref(), Some("Added existing files"));
    let correlation_a = correlation_a.expect("baseline moments carry a correlation id");
    assert_eq!(
        Some(correlation_a.as_str()),
        correlation_b.as_deref(),
        "one startup pass = ONE correlation id across its per-file moments"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_reopened_workspace_baseline_records_changes_made_while_closed() {
    let scratch = ScratchDir::new().expect("scratch");
    let (transport, handle, _events) = open_over_existing_files(&scratch).await;
    close_workspace(&transport, handle, 9_100).await;
    let db_path = scratch.path().join(".dohc/engine/engine.db");
    let (_, first_correlation) = moment_metadata(&db_path, "existing-a.md");

    // An edit and a DELETE made while closed reconcile in the same pass and
    // must stay one contiguous history group — history groups only
    // consecutive same-correlation moments, so the delete carrying NULL
    // provenance would split it.
    write_file(scratch.path(), "existing-a.md", b"edited offline");
    std::fs::remove_file(scratch.path().join("existing-b.md")).expect("offline delete");
    let handle = open_workspace(&transport, &scratch, 2_000).await;
    wait_for_text(&transport, &handle, "existing-a.md", Some("edited offline")).await;
    wait_for_text(&transport, &handle, "existing-b.md", None).await;
    close_workspace(&transport, handle, 9_101).await;

    let (summary_a, correlation_a) = moment_metadata(&db_path, "existing-a.md");
    let (summary_b, correlation_b) = moment_metadata(&db_path, "existing-b.md");
    assert_eq!(summary_a.as_deref(), Some("Changed while dohc was closed"));
    assert_eq!(
        summary_b.as_deref(),
        Some("Changed while dohc was closed"),
        "the pass's DELETE moment carries the pass summary"
    );
    let correlation_a = correlation_a.expect("the reopened pass carries a correlation id");
    assert_eq!(
        Some(correlation_a.as_str()),
        correlation_b.as_deref(),
        "a delete recorded mid-pass shares the pass correlation id"
    );
    assert_ne!(
        Some(correlation_a),
        first_correlation,
        "each pass mints its own id"
    );
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
    let opened = call_with_busy_retry(
        &transport,
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
        captured_author,
        json!([author]),
        "initializing CaptureDriver with None makes this actor-neutral."
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn capture_authors_are_declared_agents_never_a_person() {
    let scratch = ScratchDir::new().expect("scratch");
    write_root_binding(scratch.path(), TOKEN).expect("root binding");
    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let handle = open_workspace(&transport, &scratch, 1).await;
    let person = json!({"kind":"human", "humanId":"local"});
    let automation = json!({"kind":"automation", "automationId":"collection:tasks#a", "depth":1});
    for (id, author) in [(3, &person), (4, &automation)] {
        let refused = transport
            .call(
                RequestContext::unbounded(),
                request(
                    id,
                    "capture.setAuthor",
                    Some(handle.clone()),
                    json!({ "author": author }),
                ),
            )
            .await
            .expect_err("only a declared agent run authors capture");
        assert_eq!(refused.message, "person-author-refused", "request {id}");
    }
    call(
        &transport,
        &handle,
        7,
        "capture.setAuthor",
        json!({"author": null}),
    )
    .await;
    let mut params = json!({"captureAuthor": person});
    params["rootDir"] = json!(scratch.path().to_string_lossy());
    params["workspaceId"] = json!(WORKSPACE_ID);
    let refused = call_with_busy_retry(
        &transport,
        RequestContext::unbounded(),
        request(8, "workspace.open", None, params),
    )
    .await
    .expect_err("an open never makes a person its capture author");
    assert_eq!(refused.message, "person-author-refused");
    transport
        .call(
            RequestContext::unbounded(),
            request(10, "workspace.close", Some(handle), json!({})),
        )
        .await
        .expect("close");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn outside_edits_stay_unattributed_once_the_agent_capture_author_clears() {
    let scratch = ScratchDir::new().expect("scratch");
    write_root_binding(scratch.path(), TOKEN).expect("root binding");
    let agent = json!({
        "kind": "agent",
        "agentId": "agent",
        "onBehalfOf": "local",
        "agentRunId": "run",
    });
    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let handle = open_workspace(&transport, &scratch, 1).await;
    wait_until_capture_ready(&transport, &handle, 2).await;
    call(
        &transport,
        &handle,
        100,
        "capture.setAuthor",
        json!({"author": agent}),
    )
    .await;
    write_file(scratch.path(), "by-agent.md", b"agent edit");
    reconcile_until_settled(&transport, &handle, 200).await;
    call(
        &transport,
        &handle,
        300,
        "capture.setAuthor",
        json!({"author": null}),
    )
    .await;
    write_file(scratch.path(), "outside.md", b"outside edit");
    reconcile_until_settled(&transport, &handle, 400).await;
    transport
        .call(
            RequestContext::unbounded(),
            request(500, "workspace.close", Some(handle), json!({})),
        )
        .await
        .expect("close");

    let store = EngineStore::open(&scratch.path().join(".dohc/engine/engine.db"), 100)
        .expect("reopen store");
    let author_json = |path: &str| -> Option<String> {
        store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT author_json FROM moments WHERE path = ?1",
                    [path],
                    |row| row.get(0),
                )
            })
            .expect("captured moment")
    };
    let by_agent: Value = serde_json::from_str(
        author_json("by-agent.md")
            .as_deref()
            .expect("the agent's edit keeps its author"),
    )
    .expect("valid author json");
    assert_eq!(by_agent, json!([agent]));
    assert_eq!(author_json("outside.md"), None);
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

    // The re-ingest came from a rebuild while open, so it can't claim the
    // edits were made while dohc was closed.
    let db_path = scratch.path().join(".dohc/engine/engine.db");
    let (summary, _) = moment_metadata(&db_path, "private/journal.md");
    assert_eq!(summary.as_deref(), Some("Found changes in the folder"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_sink_policy_hold_recovers_when_the_original_policy_bytes_return() {
    let scratch = ScratchDir::new().expect("scratch");
    write_root_binding(scratch.path(), TOKEN).expect("root binding");
    let policy = b"[[rule]]\npath = \"private/**\"\ntracked = false\n";
    write_file(scratch.path(), ".dohc/files.toml", policy);
    write_file(scratch.path(), "kept.md", b"captured before hold");
    let probe = CaptureApplyProbe::default();
    let transport = Arc::new(InProcessTransport::new(Arc::new(
        EngineService::with_capture_apply_probe_for_harness(probe.clone()),
    )));
    let handle = open_workspace(&transport, &scratch, 1).await;
    wait_until_capture_ready(&transport, &handle, 2).await;
    wait_for_text(&transport, &handle, "kept.md", Some("captured before hold")).await;

    probe.pause_next_apply_worker();
    write_file(
        scratch.path(),
        "kept.md",
        b"held edit without another disk change",
    );
    let flush_transport = Arc::clone(&transport);
    let flush_handle = handle.clone();
    let held_flush = tokio::spawn(async move {
        tokio::time::timeout(WAIT, async {
            for id in 20_000.. {
                let flush = flush_transport
                    .call(
                        RequestContext::unbounded(),
                        request(id, "capture.flush", Some(flush_handle.clone()), json!({})),
                    )
                    .await
                    .expect("flush held capture");
                if flush.result["degraded"] == json!(true) {
                    return;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("sink policy hold must surface as degraded");
    });
    tokio::time::timeout(WAIT, probe.wait_until_apply_worker_paused())
        .await
        .expect("pause before the sink reads its policy snapshot");
    let policy_path = scratch.path().join(".dohc/files.toml");
    std::fs::remove_file(&policy_path).expect("remove readable policy");
    std::fs::create_dir(&policy_path).expect("make policy unreadable");
    probe.release_apply_worker();
    held_flush.await.expect("held flush task");
    assert_eq!(
        read_text(&transport, &handle, 30_000, "kept.md")
            .await
            .as_deref(),
        Some("captured before hold"),
        "an unreadable policy must preserve the previously captured head"
    );

    std::fs::remove_dir(&policy_path).expect("remove unreadable policy");
    std::fs::write(&policy_path, policy).expect("restore exact original policy bytes");
    assert_eq!(
        std::fs::read(&policy_path).expect("restored policy"),
        policy
    );
    tokio::time::timeout(WAIT, async {
        for id in 40_000.. {
            let flush = transport
                .call(
                    RequestContext::unbounded(),
                    request(id, "capture.flush", Some(handle.clone()), json!({})),
                )
                .await
                .expect("flush policy recovery");
            if flush.result["settled"] == json!(true)
                && flush.result["degraded"] == json!(false)
                && read_text(&transport, &handle, id + 100_000, "kept.md")
                    .await
                    .as_deref()
                    == Some("held edit without another disk change")
            {
                return;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("the same policy fingerprint must recover the held edit");
    transport
        .call(
            RequestContext::unbounded(),
            request(900_000, "workspace.close", Some(handle), json!({})),
        )
        .await
        .expect("close");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn narrowing_path_policy_journals_the_retirement_delete() {
    let scratch = ScratchDir::new().expect("scratch");
    write_root_binding(scratch.path(), TOKEN).expect("root binding");
    write_file(scratch.path(), "notes/a.md", b"tracked history");
    let service = Arc::new(EngineService::new());
    let transport = InProcessTransport::new(service);
    let handle = open_workspace(&transport, &scratch, 1).await;
    wait_for_text(&transport, &handle, "notes/a.md", Some("tracked history")).await;
    let db_path = scratch.path().join(".dohc/engine/engine.db");
    {
        let conn = rusqlite::Connection::open(&db_path).expect("open sync setup");
        conn.execute("INSERT INTO sync_identity (workspace_id, origin_id, replication_epoch, stream_identity, created_at_ms) VALUES (?1, 'owner-device', 'epoch', 'stream', 1)", [WORKSPACE_ID]).expect("owner identity");
        conn.execute("INSERT INTO sync_relay_push_state (workspace_id, origin_id, pushed_seq) VALUES (?1, 'owner-device', 0)", [WORKSPACE_ID]).expect("enable outgoing journal");
    }
    write_file(
        scratch.path(),
        ".dohc/files.toml",
        b"[[rule]]\npath = \"notes/**\"\ntracked = false\n",
    );
    wait_for_text(&transport, &handle, "notes/a.md", None).await;
    transport
        .call(
            RequestContext::unbounded(),
            request(9_290, "workspace.close", Some(handle), json!({})),
        )
        .await
        .expect("close");
    let store = EngineStore::open_read_only(&db_path).expect("read journal");
    let ops =
        list_replication_ops(&store, WORKSPACE_ID, "owner-device", -1, 100).expect("outgoing ops");
    assert!(
        ops.iter().any(|op| op.op_kind == "moment.append"
            && op.payload["path"] == "notes/a.md"
            && op.payload["operation"] == "delete"),
        "the actual policy narrow must journal its delete: {ops:?}"
    );
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

    let db_path = scratch.path().join(".dohc/engine/engine.db");
    let (summary, correlation) = moment_metadata(&db_path, "private/journal.md");
    assert_eq!(summary.as_deref(), Some("Stopped tracking by policy"));
    assert!(
        correlation.is_some(),
        "the policy retire must carry its reconcile pass's correlation id"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_over_cap_policy_retire_keeps_the_pass_provenance_and_emits() {
    // codex re-review P2s: the retained-unread retire runs through its own
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
                    "origin": "api",
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
    let key = create_key_file(&scratch.path().join(".dohc/engine")).expect("mint key");
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
    // An ordinary filesystem has an atomic no-replace rename.
    assert_eq!(status.result["noAtomicPlacement"], json!(false));

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
async fn an_empty_baseline_emits_initial_settled_without_a_capture_moment() {
    let scratch = ScratchDir::new().expect("scratch");
    write_root_binding(scratch.path(), TOKEN).expect("root binding");
    let service = Arc::new(EngineService::default());
    let mut events = service.events().subscribe();
    let transport = InProcessTransport::new(service);

    let handle = open_workspace(&transport, &scratch, 1).await;
    let notice = events.try_recv().expect("initial transition precedes open");
    assert_eq!(notice.name, CAPTURE_INITIAL_SETTLED_EVENT);
    assert_eq!(notice.payload, json!({ "workspaceId": WORKSPACE_ID }));
    assert!(
        events.try_recv().is_err(),
        "empty capture has no moment event"
    );
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
    assert_no_initial_settled_event(&mut events);
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
    let opening = tokio::spawn(async move {
        call_with_busy_retry(
            &opening_transport,
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
    tokio::time::timeout(WAIT, async {
        probe.wait_until_paused().await;
        probe.wait_until_open_waiting().await;
    })
    .await
    .expect("open must park at the readiness barrier while the baseline is paused");
    assert!(
        !probe.is_open_ready(),
        "the paused small baseline must keep the readiness barrier closed"
    );
    assert!(
        !opening.is_finished(),
        "a small baseline must finish before workspace.open returns"
    );

    probe.release();
    let opened = tokio::time::timeout(WAIT, opening)
        .await
        .expect("open must finish after releasing the baseline")
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
    let service = Arc::new(EngineService::with_capture_apply_probe_for_harness(
        probe.clone(),
    ));
    let mut events = service.events().subscribe();
    let transport = InProcessTransport::new(service);
    let handle = tokio::time::timeout(WAIT, open_workspace(&transport, &scratch, 1))
        .await
        .expect("fresh open must not wait for the paused import");
    tokio::time::timeout(WAIT, probe.wait_until_paused())
        .await
        .expect("initial apply must reach the pause seam");

    let status = transport
        .call(
            RequestContext::unbounded(),
            request(2, "watcher.status", Some(handle.clone()), json!({})),
        )
        .await
        .expect("watcher.status");
    assert_eq!(status.result["phase"], json!("importing"));
    assert_no_initial_settled_event(&mut events);

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
    let active = transport
        .call(
            RequestContext::unbounded(),
            request(58, "versions.active", Some(handle.clone()), json!({})),
        )
        .await
        .expect("a document open reads the active version while importing");
    assert_eq!(active.result["id"], json!("main"));

    for (id, method) in [
        (5, "history.page"),
        (6, "search.queryPage"),
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
    assert_eq!(existing_ydoc.retry, Retryability::AfterBackoff);

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
                        "origin": "api"
                    }),
                ),
            )
            .await
            .expect("first RPC write while importing");
    }

    assert_no_initial_settled_event(&mut events);
    probe.release();
    wait_for_initial_settled_event(&mut events).await;
    let status = transport
        .call(
            RequestContext::unbounded(),
            request(19, "watcher.status", Some(handle.clone()), json!({})),
        )
        .await
        .expect("capture status is readable after settlement");
    assert_eq!(status.result["phase"], json!("ready"));
    transport
        .call(
            RequestContext::unbounded(),
            request(20, "versions.active", Some(handle.clone()), json!({})),
        )
        .await
        .expect("the advisory event follows the read admission transition");
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

async fn wait_for_wake(events: &mut EngineEventReceiver, name: &str) {
    tokio::time::timeout(WAIT, async {
        loop {
            let notice = events.recv().await.expect("event channel stays open");
            if notice.name == name {
                assert_eq!(notice.payload, json!({ "workspaceId": WORKSPACE_ID }));
                return;
            }
        }
    })
    .await
    .unwrap_or_else(|_| panic!("timed out waiting for {name}"));
}

/// The restored document of a new folder opens once its own file is
/// captured, not once the whole import is. Its refused open moves the file
/// ahead of the lexically earlier remainder, and the import's progress wake
/// tells the caller to open again. An edit saved while the import still runs
/// survives the rest of the import.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_refused_document_is_captured_next_and_opens_while_the_import_runs() {
    use base64::Engine as _;

    let scratch = ScratchDir::new().expect("scratch");
    write_root_binding(scratch.path(), TOKEN).expect("root binding");
    for index in 0..EARLY_IMPORT_MIN_ADDED_FILES {
        write_file(scratch.path(), &format!("bulk/seed-{index:04}.md"), b"seed");
    }
    // Sorts after every other file, like the benchmark's restored small.md.
    write_file(scratch.path(), "zz-restored.md", b"restored text");

    let probe = CaptureApplyProbe::default();
    probe.pause_after_next_import_commit();
    let service = Arc::new(EngineService::with_capture_apply_probe_for_harness(
        probe.clone(),
    ));
    let mut events = service.events().subscribe_with_wakes();
    let transport = InProcessTransport::new(service);
    let handle = tokio::time::timeout(WAIT, open_workspace(&transport, &scratch, 1))
        .await
        .expect("a fresh open must not wait for its import");
    tokio::time::timeout(WAIT, probe.wait_until_import_commit_paused())
        .await
        .expect("the first import batch commits");
    wait_for_wake(&mut events, CAPTURE_IMPORT_PROGRESS_EVENT).await;

    let open_document = |id: u64, path: &str| {
        request(
            id,
            "ydoc.open",
            Some(handle.clone()),
            json!({ "versionId": "main", "path": path, "contentKind": "plaintext" }),
        )
    };
    let refused = transport
        .call(
            RequestContext::unbounded(),
            open_document(2, "zz-restored.md"),
        )
        .await
        .expect_err("an uncaptured file must not mint an absent lease");
    assert_eq!(refused.code, ErrorCode::Overloaded);
    assert_eq!(refused.retry, Retryability::AfterBackoff);

    probe.pause_after_next_import_commit();
    probe.release_import_commit();
    tokio::time::timeout(WAIT, probe.wait_until_import_commit_paused())
        .await
        .expect("the requested file commits as the next unit");
    wait_for_wake(&mut events, CAPTURE_IMPORT_PROGRESS_EVENT).await;

    let opened = transport
        .call(
            RequestContext::unbounded(),
            open_document(3, "zz-restored.md"),
        )
        .await
        .expect("a captured file opens while the import runs");
    assert_eq!(opened.result["head"], json!("present"));
    let last_seed = format!("bulk/seed-{:04}.md", EARLY_IMPORT_MIN_ADDED_FILES - 1);
    let earlier = transport
        .call(RequestContext::unbounded(), open_document(4, &last_seed))
        .await
        .expect_err("the lexically earlier remainder is still importing");
    assert_eq!(earlier.code, ErrorCode::Overloaded);
    let status = transport
        .call(
            RequestContext::unbounded(),
            request(5, "watcher.status", Some(handle.clone()), json!({})),
        )
        .await
        .expect("watcher.status");
    assert_eq!(status.result["phase"], json!("importing"));

    // Edit and save the document while the rest of the import still waits.
    let session = opened.result["sessionId"].clone();
    let doc = dohc_engine_collab::Ydoc::wire();
    let record = |update: Vec<u8>, seed: bool| {
        json!({
            "expectedLineageClaimId": opened.result["lineageClaimId"],
            "sessionId": session,
            "updateBase64": base64::engine::general_purpose::STANDARD.encode(update),
            "seed": seed,
        })
    };
    let seed = doc.plaintext_insert(0, "restored text");
    call(
        &transport,
        &handle,
        6,
        "ydoc.recordUpdate",
        record(seed, true),
    )
    .await;
    let edit = doc.plaintext_insert(13, " edited early");
    call(
        &transport,
        &handle,
        7,
        "ydoc.recordUpdate",
        record(edit, false),
    )
    .await;
    let settled = call(
        &transport,
        &handle,
        8,
        "ydoc.settle",
        json!({ "sessionId": session }),
    )
    .await;
    assert_eq!(settled["materialized"], json!(true));
    assert_eq!(settled["content"], json!("restored text edited early"));
    let on_disk = || std::fs::read_to_string(scratch.path().join("zz-restored.md")).unwrap();
    assert_eq!(on_disk(), "restored text edited early");
    let status = transport
        .call(
            RequestContext::unbounded(),
            request(9, "watcher.status", Some(handle.clone()), json!({})),
        )
        .await
        .expect("watcher.status");
    assert_eq!(status.result["phase"], json!("importing"));

    probe.release_import_commit();
    wait_for_wake(&mut events, CAPTURE_INITIAL_SETTLED_EVENT).await;
    assert_eq!(
        read_text(&transport, &handle, 10, &last_seed)
            .await
            .as_deref(),
        Some("seed")
    );
    call(
        &transport,
        &handle,
        11,
        "ydoc.close",
        json!({ "sessionId": session }),
    )
    .await;
    // The rest of the import, and the watcher pass over the saved file, keep
    // the saved text in the head and on disk.
    let flush = call(&transport, &handle, 12, "capture.flush", json!({})).await;
    assert_eq!(flush["settled"], json!(true));
    assert_eq!(
        read_text(&transport, &handle, 13, "zz-restored.md")
            .await
            .as_deref(),
        Some("restored text edited early")
    );
    assert_eq!(on_disk(), "restored text edited early");
    transport
        .call(
            RequestContext::unbounded(),
            request(14, "workspace.close", Some(handle), json!({})),
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
    let service = Arc::new(EngineService::with_capture_apply_probe_for_harness(
        probe.clone(),
    ));
    let mut events = service.events().subscribe();
    let transport = InProcessTransport::new(service);
    let handle = tokio::time::timeout(WAIT, open_workspace(&transport, &scratch, 1))
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

    assert_no_initial_settled_event(&mut events);
    probe.expire_initial_settle_deadline();
    wait_for_initial_settled_event(&mut events).await;
    let degraded = transport
        .call(
            RequestContext::unbounded(),
            request(3, "watcher.status", Some(handle.clone()), json!({})),
        )
        .await
        .expect("watcher.status after the initial timeout event");
    assert_eq!(degraded.result["phase"], json!("degraded"));
    assert_eq!(degraded.result["running"], json!(false));
    assert_eq!(degraded.result["degraded"], json!(true));
    assert_eq!(degraded.result["terminal"], json!(false));
    assert_eq!(
        probe.layer_start_count(),
        0,
        "the deadline must keep the layer future attached until its worker drains"
    );
    let uncaptured = transport
        .call(
            RequestContext::unbounded(),
            request(
                4,
                "ydoc.open",
                Some(handle.clone()),
                json!({
                    "versionId": "main",
                    "path": "bulk/seed-0000.md",
                    "contentKind": "plaintext"
                }),
            ),
        )
        .await
        .expect_err("a degraded import must not mint an absent lease over disk bytes");
    assert_eq!(uncaptured.code, ErrorCode::Overloaded);
    assert_eq!(
        uncaptured.retry,
        Retryability::No,
        "no capture wake follows a degraded import, so waiting must not be offered"
    );
    assert_eq!(
        uncaptured.message,
        "dohc has not read this file yet. Open it again once dohc has read it."
    );

    probe.release_apply_worker();
    wait_until_capture_ready(&transport, &handle, 100).await;
    assert_no_initial_settled_event(&mut events);
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
            let seed = call_with_busy_retry(
                &transport,
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
        let opening = tokio::spawn(async move {
            call_with_busy_retry(
                &opening_transport,
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
        tokio::time::timeout(WAIT, async {
            probe.wait_until_paused().await;
            probe.wait_until_open_waiting().await;
        })
        .await
        .expect("strict open must park at the readiness barrier while the baseline is paused");
        assert!(
            !probe.is_open_ready(),
            "the paused strict baseline must keep the readiness barrier closed"
        );
        assert!(
            !opening.is_finished(),
            "{} must not release before its baseline",
            if unreadable_policy {
                "unknown policy"
            } else {
                "existing store"
            }
        );
        probe.release();
        let opened = tokio::time::timeout(WAIT, opening)
            .await
            .expect("strict open must finish after releasing the baseline")
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
    let handle = tokio::time::timeout(WAIT, open_workspace(&transport, &scratch, 1))
        .await
        .expect("fresh open must not wait for the paused import");
    tokio::time::timeout(WAIT, probe.wait_until_paused())
        .await
        .expect("initial apply must reach the pause seam");

    // Keep the pause held: close must cancel it without a test-side release.
    tokio::time::timeout(
        WAIT,
        transport.call(
            RequestContext::unbounded(),
            request(2, "workspace.close", Some(handle), json!({})),
        ),
    )
    .await
    .expect("close must cancel between bounded import chunks")
    .expect("close");
    assert!(
        !probe.is_apply_blocked(),
        "close cancelled the paused initial apply without releasing its gate"
    );

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

/// APFS keeps finding a file through its old spelling after a rename that
/// changes only case or Unicode normalization (Finder, `mv`, `git mv`). The
/// old spelling must retire, or a case-sensitive peer receives both files.
/// That holds inside a folder too, and Finder metadata beside the files is
/// never captured. Skips where the disk keeps case apart, since a rename
/// there changes the stored name.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn outside_renames_that_only_respell_retire_the_old_spelling() {
    let scratch = ScratchDir::new().expect("scratch");
    write_file(scratch.path(), "probe.md", b"");
    let ignores_case = scratch.path().join("PROBE.md").exists();
    std::fs::remove_file(scratch.path().join("probe.md")).expect("remove probe");
    if !ignores_case {
        eprintln!("SKIP: this disk keeps case apart");
        return;
    }
    write_root_binding(scratch.path(), TOKEN).expect("root binding");
    let renames = [
        ("notes.md", "Notes.md", "case"),
        ("Drafts/plan.md", "Drafts/Plan.md", "case in a folder"),
        ("caf\u{e9}.md", "cafe\u{301}.md", "normalization"),
    ];
    for (before, _, text) in renames {
        write_file(scratch.path(), before, text.as_bytes());
    }
    write_file(scratch.path(), ".DS_Store", b"finder view state");
    write_file(scratch.path(), "Drafts/._plan.md", b"appledouble");

    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let handle = open_workspace(&transport, &scratch, 1).await;
    for (before, _, text) in renames {
        wait_for_text(&transport, &handle, before, Some(text)).await;
    }

    std::fs::rename(
        scratch.path().join("notes.md"),
        scratch.path().join("Notes.md"),
    )
    .expect("respell file");
    std::fs::rename(
        scratch.path().join("Drafts/plan.md"),
        scratch.path().join("Drafts/Plan.md"),
    )
    .expect("respell file in a folder");
    std::fs::rename(
        scratch.path().join("caf\u{e9}.md"),
        scratch.path().join("cafe\u{301}.md"),
    )
    .expect("renormalize file");

    for (before, after, text) in renames {
        wait_for_text(&transport, &handle, after, Some(text)).await;
        wait_for_text(&transport, &handle, before, None).await;
    }
    let flush = transport
        .call(
            RequestContext::unbounded(),
            request(2, "capture.flush", Some(handle.clone()), json!({})),
        )
        .await
        .expect("capture.flush");
    assert_eq!(flush.result["settled"], json!(true), "{}", flush.result);
    assert_eq!(flush.result["degraded"], json!(false), "{}", flush.result);
    transport
        .call(
            RequestContext::unbounded(),
            request(3, "workspace.close", Some(handle), json!({})),
        )
        .await
        .expect("close");

    let store = EngineStore::open(&scratch.path().join(".dohc/engine/engine.db"), 100)
        .expect("reopen store");
    let mut aliases: Vec<String> = store
        .read_with(|conn| {
            conn.prepare("SELECT path FROM path_aliases WHERE workspace_id = ?1")?
                .query_map([WORKSPACE_ID], |row| row.get(0))?
                .collect::<Result<_, rusqlite::Error>>()
        })
        .expect("aliases");
    aliases.sort();
    let mut expected: Vec<String> = renames
        .iter()
        .map(|(_, after, _)| (*after).to_owned())
        .collect();
    expected.sort();
    assert_eq!(
        aliases, expected,
        "one alias per file, none for OS metadata"
    );
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
async fn deferred_write_events_fire_only_when_a_held_path_gains_an_outside_write() {
    async fn reconcile(
        transport: &InProcessTransport<EngineService>,
        handle: &WorkspaceHandle,
    ) -> Value {
        tokio::time::timeout(WAIT, async {
            let mut result = call(transport, handle, 10, "capture.reconcile", json!({})).await;
            loop {
                assert_eq!(result["degraded"], json!(false), "{result}");
                if result["settled"] == json!(true) {
                    return result;
                }
                tokio::task::yield_now().await;
                result = call(transport, handle, 11, "capture.flush", json!({})).await;
            }
        })
        .await
        .expect("capture settles")
    }

    fn deferred_events(events: &mut tokio::sync::mpsc::Receiver<EngineEventNotice>) -> Vec<Value> {
        let mut payloads = Vec::new();
        while let Ok(notice) = events.try_recv() {
            if notice.name == CAPTURE_WRITE_DEFERRED_EVENT {
                payloads.push(notice.payload);
            }
        }
        payloads
    }

    let scratch = ScratchDir::new().expect("scratch");
    write_root_binding(scratch.path(), TOKEN).expect("root binding");
    write_file(scratch.path(), "note.md", b"Before.\n");
    let service = Arc::new(EngineService::new());
    let mut events = service.events().subscribe();
    let transport = InProcessTransport::new(service);
    let handle = open_workspace(&transport, &scratch, 1).await;
    wait_until_capture_ready(&transport, &handle, 100).await;

    write_file(scratch.path(), "unheld.md", b"No open session.\n");
    assert_eq!(
        reconcile(&transport, &handle).await["deferredWrites"],
        json!([])
    );
    assert!(deferred_events(&mut events).is_empty());
    assert_eq!(
        read_text(&transport, &handle, 2, "unheld.md")
            .await
            .as_deref(),
        Some("No open session.\n")
    );

    for (text, held) in [
        ("First outside write.\n", "Still held.\n"),
        // Not the first round's recorded text, which matches the head and holds nothing.
        ("A new outside write.\n", "Held again.\n"),
    ] {
        let opened = call(
            &transport,
            &handle,
            3,
            "ydoc.open",
            json!({ "versionId": "main", "path": "note.md", "contentKind": "plaintext" }),
        )
        .await;
        write_file(scratch.path(), "note.md", text.as_bytes());
        assert_eq!(
            reconcile(&transport, &handle).await["deferredWrites"],
            json!(["note.md"])
        );
        assert_eq!(
            deferred_events(&mut events),
            vec![json!({ "workspaceId": WORKSPACE_ID, "path": "note.md" })]
        );

        // A second write and full scan leave the path deferred without another wake.
        write_file(scratch.path(), "note.md", held.as_bytes());
        assert_eq!(
            reconcile(&transport, &handle).await["deferredWrites"],
            json!(["note.md"])
        );
        assert!(deferred_events(&mut events).is_empty());

        call(
            &transport,
            &handle,
            4,
            "ydoc.evict",
            json!({ "sessionId": opened["sessionId"] }),
        )
        .await;
        assert_eq!(
            reconcile(&transport, &handle).await["deferredWrites"],
            json!([])
        );
        assert!(deferred_events(&mut events).is_empty());
        assert_eq!(
            read_text(&transport, &handle, 5, "note.md")
                .await
                .as_deref(),
            Some(held)
        );
    }
    call(&transport, &handle, 6, "workspace.close", json!({})).await;
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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn successful_first_capture_releases_hold_and_drains_exact_backlink_pairs() {
    let scratch = ScratchDir::new().unwrap();
    write_root_binding(scratch.path(), TOKEN).unwrap();
    for n in 0..8 {
        write_file(
            scratch.path(),
            &format!("note-{n}.md"),
            format!("[[note-{}]]", (n + 1) % 8).as_bytes(),
        );
    }
    let service = Arc::new(EngineService::new());
    let mut events = service.events().subscribe();
    let transport = InProcessTransport::new(service);
    let handle = open_workspace(&transport, &scratch, 1).await;
    wait_for_initial_settled_event(&mut events).await;
    let observer =
        EngineStore::open_read_only(&scratch.path().join(".dohc/engine/engine.db")).unwrap();
    tokio::time::timeout(WAIT, async {
        let mut poll = tokio::time::interval(Duration::from_millis(10));
        while observer.table_row_count("link_pending").unwrap() != 0
            || observer.table_row_count("link_sources").unwrap() != 8
        {
            poll.tick().await;
        }
    })
    .await
    .unwrap();
    let actual:Vec<(String,String)>=observer.read_with(|c| {
        c.prepare("SELECT source.path,target.path FROM link_sources ts JOIN link_target_keys t USING(workspace_id,version_id,object_id,index_key) JOIN link_occurrence_keys k ON k.workspace_id=t.workspace_id AND k.version_id=t.version_id AND k.key_kind=t.key_kind AND k.key=t.key JOIN link_sources ss ON ss.workspace_id=k.workspace_id AND ss.version_id=k.version_id AND ss.object_id=k.object_id AND ss.index_key=k.index_key JOIN snapshots source ON source.workspace_id=ss.workspace_id AND source.version_id=ss.version_id AND source.object_id=ss.object_id JOIN snapshots target ON target.workspace_id=ts.workspace_id AND target.version_id=ts.version_id AND target.object_id=ts.object_id WHERE t.key_kind='stem' ORDER BY source.path,target.path")?
            .query_map([],|row|Ok((row.get(0)?,row.get(1)?)))?.collect::<rusqlite::Result<_>>()
    }).unwrap();
    let expected = (0..8)
        .map(|n| (format!("note-{n}.md"), format!("note-{}.md", (n + 1) % 8)))
        .collect::<Vec<_>>();
    assert_eq!(actual, expected);
    drop(observer);
    transport
        .call(
            RequestContext::unbounded(),
            request(100, "workspace.close", Some(handle), json!({})),
        )
        .await
        .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn large_first_capture_retries_checkpoint_backpressure_without_losing_files() {
    let scratch = ScratchDir::new().unwrap();
    write_root_binding(scratch.path(), TOKEN).unwrap();
    let body = |n| format!("{n}:{}", "x".repeat(5 * 1024 * 1024 - 2));
    for n in 0..8 {
        write_file(scratch.path(), &format!("large-{n}.md"), body(n).as_bytes());
    }
    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let handle = open_workspace(&transport, &scratch, 1).await;
    wait_until_capture_ready(&transport, &handle, 100).await;
    let mut observer =
        EngineStore::open_read_only(&scratch.path().join(".dohc/engine/engine.db")).unwrap();
    assert_eq!(observer.table_row_count("snapshots").unwrap(), 8);
    for n in 0..8 {
        let snapshot = dohc_engine_domain::VersionedTextStore::new(&mut observer)
            .read_text_inband(
                WORKSPACE_ID,
                "main",
                &format!("large-{n}.md"),
                6 * 1024 * 1024,
            )
            .unwrap()
            .unwrap();
        assert!(
            snapshot.text.as_deref() == Some(body(n).as_str()),
            "wrong body for file {n}"
        );
    }
    drop(observer);
    transport
        .call(
            RequestContext::unbounded(),
            request(300, "workspace.close", Some(handle), json!({})),
        )
        .await
        .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn five_thousand_file_capture_has_no_link_writes_at_initial_settled() {
    let scratch = ScratchDir::new().unwrap();
    write_root_binding(scratch.path(), TOKEN).unwrap();
    for n in 0..5_000 {
        write_file(scratch.path(), &format!("note-{n:04}.md"), b"[[target]]");
    }
    let probe = CaptureApplyProbe::default();
    probe.pause_at_initial_settled();
    let service = Arc::new(EngineService::with_capture_apply_probe_for_harness(
        probe.clone(),
    ));
    let mut events = service.events().subscribe();
    let transport = InProcessTransport::new(service);
    let handle = open_workspace(&transport, &scratch, 1).await;
    tokio::time::timeout(Duration::from_secs(120), async {
        loop {
            if events.recv().await.unwrap().name == CAPTURE_INITIAL_SETTLED_EVENT {
                break;
            }
        }
        probe.wait_at_initial_settled().await;
    })
    .await
    .unwrap();
    // The driver's real hold is still owned at the event edge; the probe only
    // pauses its release, so the observation cannot race the deferred drain.
    let db = scratch.path().join(".dohc/engine/engine.db");
    let actor = dohc_engine_runtime::WorkspaceSupervisor::global()
        .open(&db, 1)
        .unwrap()
        .actor;
    let observer = EngineStore::open_read_only(&db).unwrap();
    assert_eq!(observer.table_row_count("snapshots").unwrap(), 5_000);
    let phase: String = observer
        .read_with(|c| {
            c.query_row(
        "SELECT seed_phase FROM link_index_state WHERE workspace_id=?1 AND version_id='main'",
        [WORKSPACE_ID], |r| r.get(0))
        })
        .unwrap();
    assert_eq!(
        phase, "deferred",
        "seed started before the initial fence closed"
    );
    assert_eq!(observer.table_row_count("link_pending").unwrap(), 0);
    assert_eq!(observer.table_row_count("link_aliases").unwrap(), 0);
    assert_eq!(
        actor
            .capture_phase_totals_for_harness()
            .await
            .unwrap()
            .count("link_pending_row_writes"),
        0
    );
    probe.release_initial_settled();
    tokio::time::timeout(Duration::from_secs(120), async {
        let mut poll = tokio::time::interval(Duration::from_millis(10));
        loop {
            let ready: bool = observer.read_with(|c| c.query_row(
                "SELECT seed_phase='ready' FROM link_index_state WHERE workspace_id=?1 AND version_id='main'",
                [WORKSPACE_ID], |r| r.get(0))).unwrap();
            if ready { break; }
            poll.tick().await;
        }
    }).await.unwrap();
    assert_eq!(observer.table_row_count("link_aliases").unwrap(), 5_000);
    assert_eq!(observer.table_row_count("link_sources").unwrap(), 5_000);
    assert_eq!(observer.table_row_count("link_pending").unwrap(), 0);
    drop(observer);
    transport
        .call(
            RequestContext::unbounded(),
            request(100, "workspace.close", Some(handle), json!({})),
        )
        .await
        .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "manual quiet-host 5000-file initial capture measurement"]
async fn measure_five_thousand_file_initial_capture() {
    measure_initial_capture(true).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "manual matched-profile 5000-file capture comparison"]
async fn measure_five_thousand_file_capture_only() {
    measure_initial_capture(false).await;
}

async fn measure_initial_capture(measure_typing: bool) {
    for n in 0..3 {
        let scratch = ScratchDir::new().unwrap();
        write_root_binding(scratch.path(), TOKEN).unwrap();
        for i in 0..5_000 {
            write_file(
                scratch.path(),
                &format!("note-{i:04}.md"),
                format!("# Note {i}\n[[note-{:04}]]\n", (i + 1) % 5_000).as_bytes(),
            );
        }
        let service = Arc::new(EngineService::new());
        let mut events = service.events().subscribe();
        let transport = InProcessTransport::new(Arc::clone(&service));
        let began = std::time::Instant::now();
        let handle = open_workspace(&transport, &scratch, 1).await;
        tokio::time::timeout(Duration::from_secs(120), async {
            loop {
                if events.recv().await.unwrap().name == CAPTURE_INITIAL_SETTLED_EVENT {
                    break;
                }
            }
        })
        .await
        .unwrap();
        let elapsed = began.elapsed();
        let db = scratch.path().join(".dohc/engine/engine.db");
        let actor = dohc_engine_runtime::WorkspaceSupervisor::global()
            .open(&db, 1)
            .unwrap()
            .actor;
        let commits = actor.commit_count_for_harness().await.unwrap();
        let observer = EngineStore::open_read_only(&db).unwrap();
        let snapshots = observer.table_row_count("snapshots").unwrap();
        eprintln!(
            "DRIVER_CAPTURE run={n} files={snapshots} capture_ms={} commits={commits}",
            elapsed.as_millis()
        );
        assert_eq!(snapshots, 5_000);
        if measure_typing && n == 0 {
            use base64::Engine as _;
            let opened = service_call_with_busy_retry(
                service.as_ref(),
                RequestContext::unbounded().with_capability("blobs"),
                request(
                    200,
                    "ydoc.open",
                    Some(handle.clone()),
                    json!({"versionId":"main","path":"note-0000.md","contentKind":"plaintext"}),
                ),
            )
            .await
            .unwrap();
            let session = opened.response.result["sessionId"].clone();
            let doc = dohc_engine_collab::Ydoc::wire();
            doc.apply(&opened.blob_egress.unwrap().bytes).unwrap();
            let mut samples = Vec::new();
            for draining in [true, false] {
                let pending = observer.table_row_count("link_pending").unwrap();
                let certified = actor.link_drain_metrics().certified_sources;
                let seeding = observer.read_with(|c| c.query_row("SELECT EXISTS(SELECT 1 FROM link_index_state WHERE seed_phase<>'ready')", [], |r| r.get::<_,bool>(0))).unwrap();
                assert_eq!(pending > 0 || seeding, draining);
                let mut timings = Vec::new();
                for i in 0..200 {
                    let update = doc.plaintext_insert(0, "x");
                    let start = std::time::Instant::now();
                    call_with_busy_retry(&transport,RequestContext::unbounded(),request(300+i,"ydoc.recordUpdate",Some(handle.clone()),json!({ "expectedLineageClaimId": null, "sessionId":session,"updateBase64":base64::engine::general_purpose::STANDARD.encode(update)}))).await.unwrap();
                    timings.push(start.elapsed().as_micros());
                }
                if draining {
                    assert!(
                        actor.link_drain_metrics().certified_sources > certified,
                        "typing did not overlap drain progress"
                    );
                }
                timings.sort();
                eprintln!(
                    "DRAIN_TYPING draining={draining} pending_before={pending} certified_during={} p95_us={} max_us={}",
                    actor.link_drain_metrics().certified_sources - certified,
                    timings[189],
                    timings[199]
                );
                samples.push(timings);
                let deadline = std::time::Instant::now() + Duration::from_secs(120);
                let mut poll = tokio::time::interval(Duration::from_millis(10));
                while observer.table_row_count("link_pending").unwrap() != 0 || observer.read_with(|c| c.query_row("SELECT EXISTS(SELECT 1 FROM link_index_state WHERE seed_phase<>'ready')", [], |r| r.get::<_,bool>(0))).unwrap() {
                    assert!(std::time::Instant::now() < deadline, "drain deadline");
                    poll.tick().await;
                }
            }
            eprintln!(
                "DRAIN_FINISHED commits={} metrics={:?}",
                actor.commit_count_for_harness().await.unwrap(),
                actor.link_drain_metrics()
            );
            let backlinks:i64=observer.read_with(|c|c.query_row("SELECT count(*) FROM (SELECT target.object_id FROM link_sources target JOIN link_target_keys t USING(workspace_id,version_id,object_id,index_key) JOIN link_occurrence_keys k ON k.workspace_id=t.workspace_id AND k.version_id=t.version_id AND k.key_kind=t.key_kind AND k.key=t.key JOIN link_sources source ON source.workspace_id=k.workspace_id AND source.version_id=k.version_id AND source.object_id=k.object_id AND source.index_key=k.index_key WHERE t.key_kind='stem' GROUP BY target.object_id HAVING count(*)=1)",[],|r|r.get(0))).unwrap();
            assert_eq!(backlinks, 5_000);
            assert!(
                samples[0][189] <= samples[1][189] + 5_000,
                "typing p95 exceeds the drain slice"
            );
            assert!(
                samples[0][199] < 50_000,
                "drain caused a long typing request"
            );
            call_with_busy_retry(
                &transport,
                RequestContext::unbounded(),
                request(
                    900,
                    "ydoc.close",
                    Some(handle.clone()),
                    json!({"sessionId":session}),
                ),
            )
            .await
            .unwrap();
        }
        let deadline = std::time::Instant::now() + Duration::from_secs(120);
        let mut drain_poll = tokio::time::interval(Duration::from_millis(10));
        while observer.table_row_count("link_pending").unwrap() != 0
            || observer
                .read_with(|c| {
                    c.query_row(
                        "SELECT EXISTS(SELECT 1 FROM link_index_state WHERE seed_phase<>'ready')",
                        [],
                        |r| r.get::<_, bool>(0),
                    )
                })
                .unwrap()
        {
            assert!(std::time::Instant::now() < deadline);
            drain_poll.tick().await;
        }
        assert_eq!(observer.table_row_count("link_sources").unwrap(), 5_000);
        drop(observer);
        transport
            .call(
                RequestContext::unbounded(),
                request(100, "workspace.close", Some(handle), json!({})),
            )
            .await
            .unwrap();
    }
}
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn open_and_edited_document_settle_retry_a_huge_first_capture_transaction() {
    use base64::Engine as _;
    use dohc_engine_protocol::transport::EngineService as Service;

    let scratch = ScratchDir::new().unwrap();
    write_root_binding(scratch.path(), TOKEN).unwrap();
    for n in 0..EARLY_IMPORT_MIN_ADDED_FILES {
        write_file(scratch.path(), &format!("seed-{n:04}.md"), b"captured");
    }
    let probe = CaptureApplyProbe::default();
    probe.pause_next_apply();
    let service = Arc::new(EngineService::with_capture_apply_probe_for_harness(
        probe.clone(),
    ));
    let transport = InProcessTransport::new(Arc::clone(&service));
    let handle = tokio::time::timeout(WAIT, open_workspace(&transport, &scratch, 1))
        .await
        .unwrap();
    tokio::time::timeout(WAIT, probe.wait_until_paused())
        .await
        .unwrap();
    let opened = Service::call(
        service.as_ref(),
        RequestContext::unbounded().with_capability("blobs"),
        request(
            2,
            "ydoc.open",
            Some(handle.clone()),
            json!({"versionId":"main","path":"draft.md","contentKind":"plaintext"}),
        ),
    )
    .await
    .unwrap();
    let session = opened.response.result["sessionId"].clone();
    let doc = dohc_engine_collab::Ydoc::wire();
    doc.apply(&opened.blob_egress.unwrap().bytes).unwrap();
    let update = doc.plaintext_insert(0, "edit survives capture backfill");
    call(&transport, &handle, 3, "ydoc.recordUpdate", json!({ "expectedLineageClaimId": null, "sessionId":session,"updateBase64":base64::engine::general_purpose::STANDARD.encode(update)})).await;

    let db = scratch.path().join(".dohc/engine/engine.db");
    let observer = rusqlite::Connection::open(&db).unwrap();
    // Enlarge one real capture transaction deterministically, without a load run.
    // The snapshot trigger's payload commits atomically with the captured file.
    observer
        .execute_batch(
            "CREATE TABLE capture_checkpoint_payload(body BLOB);
        CREATE TRIGGER huge_capture AFTER INSERT ON snapshots WHEN NEW.path='seed-0000.md'
        BEGIN INSERT INTO capture_checkpoint_payload VALUES(zeroblob(28*1024*1024)); END;",
        )
        .unwrap();
    observer
        .execute_batch("BEGIN; SELECT count(*) FROM snapshots;")
        .unwrap();
    probe.release();
    tokio::time::timeout(WAIT, async {
        loop {
            let probe_connection = rusqlite::Connection::open(&db).unwrap();
            let log: i64 = probe_connection
                .query_row("PRAGMA wal_checkpoint(NOOP)", [], |r| r.get(1))
                .unwrap();
            drop(probe_connection);
            if log > 6000 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("one capture transaction must exceed 6000 frames");
    let busy = transport
        .call(
            RequestContext::unbounded(),
            request(
                4,
                "ydoc.settle",
                Some(handle.clone()),
                json!({"sessionId":session}),
            ),
        )
        .await
        .unwrap_err();
    assert_eq!(busy.message, "engine-store-busy");
    let opening = transport
        .call(
            RequestContext::unbounded(),
            request(
                5,
                "ydoc.open",
                Some(handle.clone()),
                json!({"versionId":"main","path":"seed-0999.md","contentKind":"plaintext"}),
            ),
        )
        .await;
    match opening {
        Ok(response) => assert_eq!(response.result["head"], json!("present")),
        Err(error) => assert!(
            error.message == "engine-store-busy"
                || error.message == "Workspace is still updating. Try again.",
            "{error:?}"
        ),
    }

    observer.execute_batch("ROLLBACK").unwrap();
    drop(observer);

    // Both renderer-style callers retain the same request after a refusal.
    for (method, params) in [
        ("ydoc.settle", json!({"sessionId":session})),
        (
            "ydoc.open",
            json!({"versionId":"main","path":"seed-0999.md","contentKind":"plaintext"}),
        ),
    ] {
        tokio::time::timeout(WAIT, async {
            loop {
                match transport
                    .call(
                        RequestContext::unbounded(),
                        request(6, method, Some(handle.clone()), params.clone()),
                    )
                    .await
                {
                    Ok(_) => break,
                    Err(error) => {
                        assert!(
                            error.message == "engine-store-busy"
                                || error.message == "Workspace is still updating. Try again.",
                            "{error:?}"
                        );
                        tokio::time::sleep(Duration::from_millis(10)).await;
                    }
                }
            }
        })
        .await
        .unwrap();
    }
    wait_until_capture_ready(&transport, &handle, 100).await;
    assert_eq!(
        std::fs::read_to_string(scratch.path().join("draft.md")).unwrap(),
        "edit survives capture backfill"
    );
    wait_for_text(
        &transport,
        &handle,
        "draft.md",
        Some("edit survives capture backfill"),
    )
    .await;
    call(&transport, &handle, 101, "workspace.close", json!({})).await;
}
