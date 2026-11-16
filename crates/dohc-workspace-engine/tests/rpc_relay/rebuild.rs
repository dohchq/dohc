//! A joined copy closed for a visibility change is rebuilt by
//! `share.view.rebuild`: the old store is checked for own work, a new store
//! is built from the relay, swapped in, and the files on disk converge to it.

use super::*;

const SHARE: &str = "membership";
const A_BYTES: &[u8] = b"open file body";
const B_BYTES: &[u8] = b"hidden file body";

fn grant(revision: &str, visibility: &str) -> Value {
    json!({
        "paths": [], "access": "view", "wholeWorkspace": true,
        "reach": { "revision": revision, "visibilityRevision": visibility, "rootLevel": "view", "folders": [] },
    })
}

fn moment(seq: i64, moment_id: &str, object_id: &str, path: &str, bytes: &[u8]) -> Value {
    share_row(
        seq,
        "granter",
        seq,
        "moment.append",
        absent_moment_payload(
            moment_id,
            object_id,
            path,
            &hex_sha256(bytes),
            "text",
            bytes.len(),
        ),
    )
}

/// The relay's log for the member under one visibility: `a.md` always, and
/// `hidden/b.md` when the member reaches it.
fn serve(relay: &FakeRelay, revision: &str, visibility: &str, with_hidden: bool) {
    let mut state = relay.state.lock().expect("relay state");
    let mut ops = vec![moment(1, "moment-a", "object-a", "open/a.md", A_BYTES)];
    if with_hidden {
        ops.push(moment(2, "moment-b", "object-b", "hidden/b.md", B_BYTES));
    }
    state.share_ops.insert(SHARE.to_owned(), ops);
    for bytes in [A_BYTES, B_BYTES] {
        state
            .share_blobs
            .insert((SHARE.to_owned(), hex_sha256(bytes)), bytes.to_vec());
    }
    state.share_revisions.insert(
        SHARE.to_owned(),
        (revision.to_owned(), visibility.to_owned()),
    );
}

struct ClosedCopy {
    relay: FakeRelay,
    scratch: ScratchDir,
    workspace_id: String,
    rebuild_id: String,
}

/// A copy that pulled under `v1`, holds its files on disk as main writes
/// them, and was closed by a pull the relay served under `v2`.
async fn closed_copy(workspace_id: &str, hidden_before: bool, hidden_after: bool) -> ClosedCopy {
    closed_copy_with(workspace_id, hidden_before, hidden_after, |_, _, _| {
        Box::pin(async {})
    })
    .await
}

async fn closed_copy_with<F>(
    workspace_id: &str,
    hidden_before: bool,
    hidden_after: bool,
    edit: F,
) -> ClosedCopy
where
    F: for<'b> FnOnce(
        &'b InProcessTransport<EngineService>,
        &'b WorkspaceHandle,
        &'b ScratchDir,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + 'b>>,
{
    let relay = FakeRelay::start(RelayState::default());
    serve(&relay, "r1", "v1", hidden_before);
    let scratch = ScratchDir::new().expect("scratch");
    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let handle = open_workspace(&transport, &scratch, &relay, 1, workspace_id).await;
    let mut id = 1;
    seed_main(&transport, &handle, &mut id, workspace_id).await;
    let pull = json!({ "workspaceId": workspace_id, "shareId": SHARE, "grantedSelector": grant("r1", "v1") });
    let pulled = call(
        &transport,
        &handle,
        &mut id,
        "share.view.pull",
        pull.clone(),
    )
    .await;
    call(
        &transport,
        &handle,
        &mut id,
        "sync.commitCursor",
        json!({ "workspaceId": workspace_id, "pendingCursor": pulled["pendingCursor"] }),
    )
    .await;
    // Main writes a share view's files itself.
    let write = |path: &str, bytes: &[u8]| {
        let target = scratch.path().join(path);
        std::fs::create_dir_all(target.parent().expect("parent")).expect("folder");
        std::fs::write(target, bytes).expect("file");
    };
    write("open/a.md", A_BYTES);
    if hidden_before {
        write("hidden/b.md", B_BYTES);
    }
    edit(&transport, &handle, &scratch).await;

    serve(&relay, "r2", "v2", hidden_after);
    let closed = call(&transport, &handle, &mut id, "share.view.pull", pull).await;
    let rebuild_id = closed["rebuildId"].as_str().expect("closed").to_owned();
    close(&transport, &handle, &mut id).await;
    ClosedCopy {
        relay,
        scratch,
        workspace_id: workspace_id.to_owned(),
        rebuild_id,
    }
}

fn rebuild_params(copy: &ClosedCopy) -> Value {
    json!({
        "rootDir": copy.scratch.path().to_string_lossy(),
        "workspaceId": copy.workspace_id,
        "rebuildId": copy.rebuild_id,
        "shareId": SHARE,
        "grantedSelector": grant("r2", "v2"),
        "relay": {
            "baseUrl": copy.relay.base_url,
            "bearerToken": BEARER,
            "allowInsecureLoopbackForTests": true,
        },
    })
}

async fn rebuild_on(
    service: &Arc<EngineService>,
    copy: &ClosedCopy,
) -> Result<Value, WireErrorView> {
    let transport = InProcessTransport::new(Arc::clone(service));
    transport
        .call(
            RequestContext::unbounded(),
            request(90, "share.view.rebuild", None, rebuild_params(copy)),
        )
        .await
        .map(|response| response.result)
        .map_err(|error| WireErrorView {
            code: error.code,
            message: error.message,
        })
}

#[derive(Debug)]
struct WireErrorView {
    code: ErrorCode,
    message: String,
}

async fn rebuild(copy: &ClosedCopy) -> Value {
    rebuild_on(&Arc::new(EngineService::new()), copy)
        .await
        .expect("rebuild")
}

async fn finish(copy: &ClosedCopy) {
    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    transport
        .call(
            RequestContext::unbounded(),
            request(
                91,
                "share.view.rebuildFinish",
                None,
                json!({ "rootDir": copy.scratch.path().to_string_lossy(), "rebuildId": copy.rebuild_id }),
            ),
        )
        .await
        .expect("finish");
}

fn manifest(copy: &ClosedCopy) -> Option<Value> {
    std::fs::read(copy.scratch.path().join(".dohc/local/rebuild.json"))
        .ok()
        .map(|bytes| serde_json::from_slice(&bytes).expect("manifest json"))
}

/// Every text value anywhere in the store, so a test can say a path or hash
/// is in no table at all: History, search, file reads, Comments and Groups
/// all read these tables.
fn store_mentions(scratch: &ScratchDir, needle: &str) -> Vec<String> {
    let db = Connection::open(engine_db_path(scratch).expect("engine db")).expect("open db");
    let tables: Vec<String> = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .expect("tables")
        .query_map([], |row| row.get(0))
        .expect("table rows")
        .map(|row| row.expect("table"))
        .collect();
    let mut found = Vec::new();
    for table in tables {
        let columns: Vec<String> = db
            .prepare(&format!("SELECT name FROM pragma_table_info('{table}')"))
            .expect("columns")
            .query_map([], |row| row.get(0))
            .expect("column rows")
            .map(|row| row.expect("column"))
            .collect();
        for column in columns {
            let hits: i64 = db
                .query_row(
                    &format!(
                        "SELECT COUNT(*) FROM \"{table}\" WHERE CAST(\"{column}\" AS TEXT) LIKE ?1"
                    ),
                    [format!("%{needle}%")],
                    |row| row.get(0),
                )
                .unwrap_or(0);
            if hits > 0 {
                found.push(format!("{table}.{column}"));
            }
        }
    }
    found
}

/// The engine's folder holds no store but the live one.
fn assert_no_old_store(scratch: &ScratchDir) {
    let local = scratch.path().join(".dohc/local");
    for leftover in ["rebuild", "rebuild-aside"] {
        assert!(
            !local.join(leftover).exists(),
            "{leftover} is left after the rebuild"
        );
    }
}

/// Open the rebuilt copy as main does and read it.
async fn reopen(copy: &ClosedCopy) -> (InProcessTransport<EngineService>, WorkspaceHandle) {
    // The new store carries its own root binding, so this open writes none.
    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let opened = transport
        .call(
            RequestContext::unbounded(),
            request(
                1,
                "workspace.open",
                None,
                json!({ "rootDir": copy.scratch.path().to_string_lossy(), "workspaceId": copy.workspace_id }),
            ),
        )
        .await
        .expect("reopen");
    let handle = serde_json::from_value(opened.result["workspace"].clone()).expect("handle");
    (transport, handle)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_narrowed_clean_copy_is_rebuilt_and_the_hidden_file_keeps_only_its_copy() {
    let copy = closed_copy("rpc-rebuild-narrow", true, false).await;
    let result = rebuild(&copy).await;
    assert_eq!(result["state"], "rebuilt", "{result}");
    assert_eq!(result["reach"]["visibilityRevision"], "v2");

    // The file the member still reaches stays; the hidden one moved, bytes
    // and all, to the recovery folder the result names.
    let root = copy.scratch.path();
    assert_eq!(std::fs::read(root.join("open/a.md")).expect("a"), A_BYTES);
    assert!(!root.join("hidden/b.md").exists());
    let recovery = root.join(result["recoveryFolder"].as_str().expect("recovery folder"));
    assert!(recovery.starts_with(root.join(".dohc/local/recovery")));
    assert_eq!(
        std::fs::read(recovery.join("0001 b.md")).expect("recovered"),
        B_BYTES
    );
    let contents = std::fs::read_to_string(recovery.join("contents.md")).expect("contents");
    assert!(contents.contains("0001 b.md"), "{contents}");
    assert!(contents.contains("hidden/b.md"), "{contents}");
    assert!(
        contents.contains("left reach, unchanged copy"),
        "{contents}"
    );

    finish(&copy).await;
    assert!(manifest(&copy).is_none());
    assert_no_old_store(&copy.scratch);

    // No read of the new store knows the hidden file.
    for needle in ["hidden/b.md", "moment-b", "object-b", &hex_sha256(B_BYTES)] {
        assert_eq!(
            store_mentions(&copy.scratch, needle),
            Vec::<String>::new(),
            "{needle}"
        );
    }
    let (transport, handle) = reopen(&copy).await;
    let mut id = 10;
    let moments = call(
        &transport,
        &handle,
        &mut id,
        "moments.list",
        json!({ "versionId": "main", "limit": 10 }),
    )
    .await;
    let paths: Vec<&str> = moments["moments"]
        .as_array()
        .expect("moments")
        .iter()
        .filter_map(|moment| moment["path"].as_str())
        .collect();
    assert_eq!(paths, vec!["open/a.md"]);
    id += 1;
    let read = transport
        .call(
            RequestContext::unbounded(),
            request(
                id,
                "versionedText.read",
                Some(handle.clone()),
                json!({ "versionId": "main", "path": "hidden/b.md" }),
            ),
        )
        .await;
    assert_eq!(
        read.expect("read").result,
        Value::Null,
        "the hidden file reads"
    );
    let text = call(
        &transport,
        &handle,
        &mut id,
        "versionedText.read",
        json!({ "versionId": "main", "path": "open/a.md" }),
    )
    .await;
    assert_eq!(text["text"], "open file body");
    close(&transport, &handle, &mut id).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_widened_clean_copy_is_rebuilt_and_writes_the_new_file() {
    let copy = closed_copy("rpc-rebuild-widen", false, true).await;
    let result = rebuild(&copy).await;
    assert_eq!(result["state"], "rebuilt", "{result}");
    assert!(result["recoveryFolder"].is_null(), "{result}");
    let root = copy.scratch.path();
    assert_eq!(std::fs::read(root.join("open/a.md")).expect("a"), A_BYTES);
    assert_eq!(std::fs::read(root.join("hidden/b.md")).expect("b"), B_BYTES);
    assert!(!root.join(".dohc/local/recovery").exists());
    finish(&copy).await;
    assert!(manifest(&copy).is_none());
    assert_no_old_store(&copy.scratch);
    let (transport, handle) = reopen(&copy).await;
    let mut id = 10;
    let text = call(
        &transport,
        &handle,
        &mut id,
        "versionedText.read",
        json!({ "versionId": "main", "path": "hidden/b.md" }),
    )
    .await;
    assert_eq!(text["text"], "hidden file body");
    close(&transport, &handle, &mut id).await;
}

/// A copy that holds the member's own work stays closed and loses nothing:
/// the old store, its files and the manifest are as they were.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_copy_with_own_work_stays_closed_and_loses_nothing() {
    for (workspace_id, own) in [
        ("rpc-rebuild-own-moment", "moment"),
        ("rpc-rebuild-own-disk", "disk"),
    ] {
        let copy = closed_copy_with(workspace_id, true, false, move |transport, handle, scratch| {
            Box::pin(async move {
                let mut id = 50;
                if own == "moment" {
                    call(
                        transport,
                        handle,
                        &mut id,
                        "versionedText.write",
                        json!({
                            "versionId": "main", "objectId": "mine", "path": "hidden/mine.md",
                            "text": "my own note", "momentId": "mine-moment", "origin": "api", "nowMs": 3_000,
                        }),
                    )
                    .await;
                    std::fs::write(scratch.path().join("hidden/mine.md"), "my own note").expect("mine");
                } else {
                    std::fs::write(scratch.path().join("hidden/b.md"), "edited outside dohc").expect("edit");
                }
            })
        })
        .await;
        let db_before =
            std::fs::read(engine_db_path(&copy.scratch).expect("db")).expect("db bytes");
        let result = rebuild(&copy).await;
        assert_eq!(result["state"], "ownWork", "{own}: {result}");
        assert!(
            !result["kinds"].as_array().expect("kinds").is_empty(),
            "{result}"
        );
        assert_eq!(manifest(&copy).expect("manifest")["phase"], "closed");
        let root = copy.scratch.path();
        assert!(!root.join(".dohc/local/rebuild").exists());
        assert!(!root.join(".dohc/local/recovery").exists());
        assert_eq!(std::fs::read(root.join("open/a.md")).expect("a"), A_BYTES);
        if own == "moment" {
            assert_eq!(
                std::fs::read(root.join("hidden/mine.md")).expect("mine"),
                b"my own note"
            );
            assert_eq!(std::fs::read(root.join("hidden/b.md")).expect("b"), B_BYTES);
        } else {
            assert_eq!(
                std::fs::read(root.join("hidden/b.md")).expect("b"),
                b"edited outside dohc"
            );
        }
        // The old store still answers its rebuild, with everything it held.
        assert!(!store_mentions(&copy.scratch, "hidden/b.md").is_empty());
        let db_after = std::fs::read(engine_db_path(&copy.scratch).expect("db")).expect("db bytes");
        assert_eq!(db_before.len(), db_after.len(), "{own}: the old store grew");
    }
}

/// Stop the rebuild at `point` as a crash would, then run it again on a new
/// service, as after a restart. It must finish as if nothing had stopped it.
async fn crash_then_resume(workspace_id: &str, point: &str, phase: &str) -> ClosedCopy {
    let copy = closed_copy(workspace_id, true, false).await;
    let service = Arc::new(EngineService::new());
    service.crash_rebuild_at_for_harness(point);
    let crashed = rebuild_on(&service, &copy).await.expect_err("crashed");
    assert_eq!(crashed.message, "rebuild-crash-for-harness", "{point}");
    assert_eq!(
        manifest(&copy).expect("manifest")["phase"],
        phase,
        "{point}"
    );
    drop(service);
    let result = rebuild(&copy).await;
    assert_eq!(result["state"], "rebuilt", "{point}: {result}");
    let root = copy.scratch.path();
    assert_eq!(
        std::fs::read(root.join("open/a.md")).expect("a"),
        A_BYTES,
        "{point}"
    );
    assert!(!root.join("hidden/b.md").exists(), "{point}");
    let recovery = root.join(result["recoveryFolder"].as_str().expect("recovery"));
    assert_eq!(
        std::fs::read(recovery.join("0001 b.md")).expect("recovered"),
        B_BYTES,
        "{point}"
    );
    assert_eq!(
        std::fs::read_dir(root.join(".dohc/local/recovery"))
            .expect("recovery root")
            .count(),
        1,
        "{point}: a restart made a second recovery folder"
    );
    finish(&copy).await;
    assert_no_old_store(&copy.scratch);
    assert_eq!(
        store_mentions(&copy.scratch, "hidden/b.md"),
        Vec::<String>::new(),
        "{point}"
    );
    copy
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_rebuild_stopped_in_closed_resumes() {
    crash_then_resume("rpc-rebuild-crash-closed", "built", "closed").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_rebuild_stopped_in_swapping_resumes_from_each_valid_state() {
    // Before either store rename: live and staging. After the first: staging
    // and aside. After the second: live and aside.
    for (index, point) in ["rename-0", "rename-1", "rename-2"].into_iter().enumerate() {
        crash_then_resume(
            &format!("rpc-rebuild-crash-swapping-{index}"),
            point,
            "swapping",
        )
        .await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_rebuild_stopped_in_swapped_resumes() {
    for (index, point) in ["swapped", "wave-1"].into_iter().enumerate() {
        crash_then_resume(
            &format!("rpc-rebuild-crash-swapped-{index}"),
            point,
            "swapped",
        )
        .await;
    }
}

/// In `swapping`, folders in no state the renames pass through stop the
/// rebuild and change nothing.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_swap_in_an_unknown_state_stops_and_changes_nothing() {
    let copy = closed_copy("rpc-rebuild-swap-unknown", true, false).await;
    let service = Arc::new(EngineService::new());
    service.crash_rebuild_at_for_harness("rename-0");
    rebuild_on(&service, &copy).await.expect_err("crashed");
    let root = copy.scratch.path();
    // Only the live store is left.
    std::fs::remove_dir_all(root.join(".dohc/local/rebuild")).expect("drop staging");
    let refused = rebuild_on(&Arc::new(EngineService::new()), &copy)
        .await
        .expect_err("refused");
    assert_eq!(
        (refused.code, refused.message.as_str()),
        (ErrorCode::Conflict, "share-view-rebuild-swap-unrecognized")
    );
    assert_eq!(manifest(&copy).expect("manifest")["phase"], "swapping");
    assert!(root.join(".dohc/engine").is_dir());
    assert_eq!(std::fs::read(root.join("hidden/b.md")).expect("b"), B_BYTES);
}
