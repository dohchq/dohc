//! Files-into-daemon composition acceptance: once a root-bound workspace is
//! open, the watcher + reconcile driver notice EXTERNAL disk changes and
//! record them autonomously — no RPC involved — across text, binary, and
//! secret content; policy flips re-offer; teardown is clean and ordered.

use crate::common;

use common::*;
use dohc_engine_protocol::{
    ErrorCode, Retryability,
    transport::{EngineTransport, InProcessTransport, RequestContext},
    wire::WorkspaceHandle,
};
use dohc_engine_storage::EngineStore;
use dohc_engine_testkit::ScratchDir;
use dohc_workspace_engine::{
    CAPTURE_INITIAL_SETTLED_EVENT, CaptureApplyProbe, EARLY_IMPORT_MIN_ADDED_FILES,
    EngineEventNotice, EngineService, root_binding::write_root_binding,
};
use serde_json::json;
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

const FIRST_IMPORT_SUMMARY: &str = "Added existing files";

type BulkMoment = (String, Option<String>, Option<String>);

/// Every `bulk/` moment, oldest first: (path, summary, correlation id).
fn bulk_moments(db: &Path) -> Vec<BulkMoment> {
    let store = EngineStore::open(db, 100).expect("reopen store");
    store
        .read_with(|conn| {
            let mut statement = conn.prepare(
                "SELECT path, metadata_summary, metadata_correlation_id FROM moments \
                 WHERE workspace_id = ?1 AND path LIKE 'bulk/%' ORDER BY moment_order",
            )?;
            let rows = statement.query_map([WORKSPACE_ID], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })?;
            rows.collect::<rusqlite::Result<Vec<_>>>()
        })
        .expect("bulk moments")
}

/// The one correlation id that every moment carries under the import label.
fn single_import_id(moments: &[BulkMoment]) -> String {
    let ids: std::collections::BTreeSet<_> = moments
        .iter()
        .map(|(path, summary, id)| {
            assert_eq!(
                summary.as_deref(),
                Some(FIRST_IMPORT_SUMMARY),
                "{path} left the first import"
            );
            id.clone().expect("import moments carry a correlation id")
        })
        .collect();
    assert_eq!(
        ids.len(),
        1,
        "one first import, one correlation id: {ids:?}"
    );
    ids.into_iter().next().expect("one id")
}

/// Open a new workspace over a fresh import's worth of files and pause the
/// import after its first committed unit.
async fn open_paused_import(
    scratch: &ScratchDir,
    probe: &CaptureApplyProbe,
) -> (
    Arc<InProcessTransport<EngineService>>,
    WorkspaceHandle,
    tokio::sync::mpsc::Receiver<EngineEventNotice>,
) {
    write_root_binding(scratch.path(), TOKEN).expect("root binding");
    for index in 0..EARLY_IMPORT_MIN_ADDED_FILES {
        write_file(scratch.path(), &format!("bulk/seed-{index:04}.md"), b"seed");
    }
    probe.pause_after_next_import_commit();
    let service = Arc::new(EngineService::with_capture_apply_probe_for_harness(
        probe.clone(),
    ));
    let events = service.events().subscribe();
    let transport = Arc::new(InProcessTransport::new(service));
    let handle = tokio::time::timeout(WAIT, open_workspace(&transport, scratch, 1))
        .await
        .expect("a fresh open must not wait for its import");
    tokio::time::timeout(WAIT, probe.wait_until_import_commit_paused())
        .await
        .expect("the first import unit commits");
    (transport, handle, events)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_reopen_finishes_an_interrupted_first_import_under_its_id() {
    let scratch = ScratchDir::new().expect("scratch");
    let probe = CaptureApplyProbe::default();
    let (transport, handle, _events) = open_paused_import(&scratch, &probe).await;

    // Quit after the first committed unit: close cancels the import, then
    // waits for its worker.
    let closing = tokio::spawn({
        let transport = Arc::clone(&transport);
        async move { close_workspace(&transport, handle, 2).await }
    });
    tokio::time::timeout(WAIT, probe.wait_until_close_gate_waiting())
        .await
        .expect("close waits for the paused import");
    probe.release_import_commit();
    tokio::time::timeout(WAIT, closing)
        .await
        .expect("close ends the import")
        .expect("close task");

    let db = scratch.path().join(".dohc/engine/engine.db");
    let prefix = bulk_moments(&db);
    assert!(
        !prefix.is_empty() && prefix.len() < EARLY_IMPORT_MIN_ADDED_FILES,
        "close must leave the import unfinished; it recorded {} files",
        prefix.len()
    );
    let import_id = single_import_id(&prefix);

    let reopened = open_workspace(&transport, &scratch, 3).await;
    wait_until_capture_ready(&transport, &reopened, 4).await;
    write_file(scratch.path(), "live.md", b"after the import");
    wait_for_text(&transport, &reopened, "live.md", Some("after the import")).await;
    close_workspace(&transport, reopened, 9_100).await;

    let moments = bulk_moments(&db);
    assert_eq!(moments.len(), EARLY_IMPORT_MIN_ADDED_FILES);
    assert_eq!(single_import_id(&moments), import_id);
    assert_eq!(
        moment_metadata(&db, "live.md"),
        (None, None),
        "the reopen finished the import, so a new file is a live change"
    );

    write_file(scratch.path(), "closed.md", b"added while closed");
    let reopened = open_workspace(&transport, &scratch, 9_200).await;
    wait_for_text(
        &transport,
        &reopened,
        "closed.md",
        Some("added while closed"),
    )
    .await;
    close_workspace(&transport, reopened, 9_300).await;
    let (summary, _) = moment_metadata(&db, "closed.md");
    assert_eq!(summary.as_deref(), Some("Changed while dohc was closed"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_store_from_before_import_tracking_counts_its_import_finished() {
    let scratch = ScratchDir::new().expect("scratch");
    let (transport, handle, _events) = open_over_existing_files(&scratch).await;
    close_workspace(&transport, handle, 9_100).await;

    // Roll the store back to before the import table existed.
    let db = scratch.path().join(".dohc/engine/engine.db");
    rusqlite::Connection::open(&db)
        .expect("open store")
        .execute_batch(
            "DROP TABLE capture_first_imports; \
             DELETE FROM engine_migrations WHERE id = 'v2-capture-first-imports';",
        )
        .expect("roll back the import migration");

    write_file(scratch.path(), "added-while-closed.md", b"new offline");
    let handle = open_workspace(&transport, &scratch, 2_000).await;
    wait_for_text(
        &transport,
        &handle,
        "added-while-closed.md",
        Some("new offline"),
    )
    .await;
    close_workspace(&transport, handle, 9_101).await;

    let (summary, _) = moment_metadata(&db, "added-while-closed.md");
    assert_eq!(summary.as_deref(), Some("Changed while dohc was closed"));
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
