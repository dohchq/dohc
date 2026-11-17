//! A joined copy closed for a visibility change is rebuilt by
//! `share.view.rebuild`: a new store is built from the relay and swapped in,
//! the files on disk converge to it, and everything of the member's the relay
//! hasn't taken is saved in a recovery folder.

use super::*;

const SHARE: &str = "membership";
const A_BYTES: &[u8] = b"open file body";
const B_BYTES: &[u8] = b"hidden file body";
const C_BYTES: &[u8] = b"file the member deletes";
const D_BYTES: &[u8] = b"file the member moves";

fn grant(signature: &str, visibility: &str) -> Value {
    json!({
        "paths": [], "access": "view", "wholeWorkspace": true,
        "reach": { "signature": signature, "visibilitySignature": visibility, "rootLevel": "view", "folders": [] },
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

/// The relay's log for the member under one visibility: `open/a.md`, `c.md`
/// and `d.md` always, and `hidden/b.md` when the member reaches it.
fn serve(relay: &FakeRelay, signature: &str, visibility: &str, with_hidden: bool) {
    serve_with(relay, signature, visibility, with_hidden, &[]);
}

/// `serve`, with more ops after those, each with its file's bytes.
fn serve_with(
    relay: &FakeRelay,
    signature: &str,
    visibility: &str,
    with_hidden: bool,
    more: &[(Value, &'static [u8])],
) {
    let mut state = relay.state.lock().expect("relay state");
    let mut ops = vec![
        moment(1, "moment-a", "object-a", "open/a.md", A_BYTES),
        moment(2, "moment-c", "object-c", "open/c.md", C_BYTES),
        moment(3, "moment-d", "object-d", "open/d.md", D_BYTES),
    ];
    if with_hidden {
        ops.push(moment(4, "moment-b", "object-b", "hidden/b.md", B_BYTES));
    }
    ops.extend(more.iter().map(|(op, _)| op.clone()));
    state.share_ops.insert(SHARE.to_owned(), ops);
    let more_bytes = more.iter().map(|(_, bytes)| *bytes);
    for bytes in [A_BYTES, B_BYTES, C_BYTES, D_BYTES]
        .into_iter()
        .chain(more_bytes)
    {
        state
            .share_blobs
            .insert((SHARE.to_owned(), hex_sha256(bytes)), bytes.to_vec());
    }
    state.share_signatures.insert(
        SHARE.to_owned(),
        (signature.to_owned(), visibility.to_owned()),
    );
}

struct ClosedCopy {
    relay: FakeRelay,
    scratch: ScratchDir,
    workspace_id: String,
    rebuild_id: String,
    /// The live drafts main passes the rebuild.
    live_drafts: Value,
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
    closed_copy_serving(workspace_id, hidden_before, hidden_after, &[], edit).await
}

/// `closed_copy_with`, with the relay serving `more` ops under both
/// visibilities.
async fn closed_copy_serving<F>(
    workspace_id: &str,
    hidden_before: bool,
    hidden_after: bool,
    more: &[(Value, &'static [u8])],
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
    serve_with(&relay, "r1", "v1", hidden_before, more);
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
    write("open/c.md", C_BYTES);
    write("open/d.md", D_BYTES);
    if hidden_before {
        write("hidden/b.md", B_BYTES);
    }
    edit(&transport, &handle, &scratch).await;

    serve_with(&relay, "r2", "v2", hidden_after, more);
    let closed = call(&transport, &handle, &mut id, "share.view.pull", pull).await;
    let rebuild_id = closed["rebuildId"].as_str().expect("closed").to_owned();
    close(&transport, &handle, &mut id).await;
    ClosedCopy {
        relay,
        scratch,
        workspace_id: workspace_id.to_owned(),
        rebuild_id,
        live_drafts: json!([]),
    }
}

fn rebuild_params(copy: &ClosedCopy) -> Value {
    let mut params = json!({
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
    });
    if copy
        .live_drafts
        .as_array()
        .is_some_and(|drafts| !drafts.is_empty())
    {
        params["liveDrafts"] = copy.live_drafts.clone();
    }
    params
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

async fn finish(copy: &ClosedCopy) -> Value {
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
        .expect("finish")
        .result
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
    assert_eq!(result["reach"]["visibilitySignature"], "v2");

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
        contents.contains("No longer shared with you."),
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
    assert_eq!(
        paths,
        vec!["open/d.md", "open/c.md", "open/a.md"],
        "History holds only shared files"
    );
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
    // Search and Comments don't find it either.
    let found = call(
        &transport,
        &handle,
        &mut id,
        "search.queryPage",
        json!({ "query": "hidden", "nowMs": 9_000 }),
    )
    .await;
    assert!(!found.to_string().contains("hidden/b.md"), "{found}");
    let comments = call(
        &transport,
        &handle,
        &mut id,
        "chats.threads.listForFile",
        json!({ "objectId": "object-b" }),
    )
    .await;
    assert!(!comments.to_string().contains("object-b"), "{comments}");
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

/// The names in a folder, sorted.
fn names_in(folder: &std::path::Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(folder)
        .expect("folder")
        .map(|entry| {
            entry
                .expect("entry")
                .file_name()
                .to_string_lossy()
                .into_owned()
        })
        .collect();
    names.sort();
    names
}

/// Narrowing a copy with an unsent edit, a new file, an unsent delete and an
/// unsent move: the disk ends equal to the new store, the edit and the new
/// file are in the recovery folder, and the delete and the move are undone
/// and listed.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_narrowing_saves_unsent_work_and_undoes_unsent_deletes_and_moves() {
    let copy = closed_copy_with(
        "rpc-rebuild-unsent",
        true,
        false,
        |transport, handle, scratch| {
            Box::pin(async move {
                let mut id = 50;
                let root = scratch.path();
                call(
                    transport,
                    handle,
                    &mut id,
                    "versionedText.write",
                    json!({
                        "versionId": "main", "objectId": "object-a", "path": "open/a.md",
                        "text": "my edit", "momentId": "edit-a", "origin": "api", "nowMs": 3_000,
                    }),
                )
                .await;
                std::fs::write(root.join("open/a.md"), "my edit").expect("edit");
                call(
                transport,
                handle,
                &mut id,
                "versionedText.write",
                json!({
                    "versionId": "main", "objectId": "mine", "path": "open/new.md",
                    "text": "my new file", "momentId": "new-file", "origin": "api", "nowMs": 3_001,
                }),
            )
            .await;
                std::fs::write(root.join("open/new.md"), "my new file").expect("new");
                call(
                    transport,
                    handle,
                    &mut id,
                    "versionedText.delete",
                    json!({ "versionId": "main", "path": "open/c.md", "origin": "api" }),
                )
                .await;
                std::fs::remove_file(root.join("open/c.md")).expect("delete");
                call(
                    transport,
                    handle,
                    &mut id,
                    "versionedText.rename",
                    json!({
                        "versionId": "main", "fromPath": "open/d.md", "toPath": "open/moved.md",
                        "origin": "api",
                    }),
                )
                .await;
                std::fs::rename(root.join("open/d.md"), root.join("open/moved.md")).expect("move");
            })
        },
    )
    .await;
    let result = rebuild(&copy).await;
    assert_eq!(result["state"], "rebuilt", "{result}");
    let root = copy.scratch.path();
    // The disk equals the new store.
    assert_eq!(std::fs::read(root.join("open/a.md")).expect("a"), A_BYTES);
    assert_eq!(std::fs::read(root.join("open/c.md")).expect("c"), C_BYTES);
    assert_eq!(std::fs::read(root.join("open/d.md")).expect("d"), D_BYTES);
    for gone in ["open/new.md", "open/moved.md", "hidden/b.md"] {
        assert!(!root.join(gone).exists(), "{gone}");
    }
    let recovery = root.join(result["recoveryFolder"].as_str().expect("recovery"));
    assert_eq!(
        names_in(&recovery),
        ["0001 b.md", "0002 a.md", "0003 new.md", "contents.md"]
    );
    assert_eq!(
        std::fs::read(recovery.join("0002 a.md")).expect("edit"),
        b"my edit"
    );
    assert_eq!(
        std::fs::read(recovery.join("0003 new.md")).expect("new"),
        b"my new file"
    );
    let contents = std::fs::read_to_string(recovery.join("contents.md")).expect("contents");
    for line in [
        "| 0001 b.md | hidden/b.md | No longer shared with you. |",
        "| 0002 a.md | open/a.md | Your change wasn't sent.",
        "| 0003 new.md | open/new.md | Not sent. |",
        "- `open/c.md`, which you deleted",
        "- `open/moved.md` moved back to `open/d.md`",
    ] {
        assert!(contents.contains(line), "{line}\n{contents}");
    }
    finish(&copy).await;
    assert_no_old_store(&copy.scratch);
}

/// The member copies a shared file into a folder the owner then hides. The new
/// store holds the copy's bytes under the original's path, but the copy is the
/// member's own and unsent: it goes to the recovery folder, not away.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_unsent_copy_of_a_held_file_in_a_hidden_folder_is_saved() {
    let copy = closed_copy_with(
        "rpc-rebuild-unsent-copy",
        true,
        false,
        |transport, handle, scratch| {
            Box::pin(async move {
                let mut id = 50;
                call(
                    transport,
                    handle,
                    &mut id,
                    "versionedText.write",
                    json!({
                        "versionId": "main", "objectId": "mine-copy", "path": "hidden/copy.md",
                        "text": "open file body", "momentId": "copy-a", "origin": "api", "nowMs": 3_000,
                    }),
                )
                .await;
                std::fs::write(scratch.path().join("hidden/copy.md"), A_BYTES).expect("copy");
            })
        },
    )
    .await;
    let result = rebuild(&copy).await;
    assert_eq!(result["state"], "rebuilt", "{result}");
    let root = copy.scratch.path();
    assert!(!root.join("hidden/copy.md").exists());
    let recovery = root.join(result["recoveryFolder"].as_str().expect("recovery"));
    assert_eq!(
        names_in(&recovery),
        ["0001 b.md", "0002 copy.md", "contents.md"]
    );
    assert_eq!(
        std::fs::read(recovery.join("0002 copy.md")).expect("copy"),
        A_BYTES
    );
    let contents = std::fs::read_to_string(recovery.join("contents.md")).expect("contents");
    assert!(
        contents.contains("| 0002 copy.md | hidden/copy.md | Not sent. |"),
        "{contents}"
    );
    finish(&copy).await;
}

/// The member writes a new file in a folder the owner then hides, and the copy
/// closes before the engine records it. Neither store holds it, so only the
/// disk knows it: it is the member's own and goes to the recovery folder.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_new_file_the_engine_never_recorded_in_a_hidden_folder_is_saved() {
    let copy = closed_copy_with("rpc-rebuild-unrecorded", true, false, |_, _, scratch| {
        Box::pin(async move {
            std::fs::write(scratch.path().join("hidden/ideas.md"), "a rain barrel").expect("ideas");
        })
    })
    .await;
    let result = rebuild(&copy).await;
    assert_eq!(result["state"], "rebuilt", "{result}");
    let root = copy.scratch.path();
    assert!(!root.join("hidden/ideas.md").exists());
    // The hidden folder holds nothing now, so it goes too.
    assert!(!root.join("hidden").exists());
    let recovery = root.join(result["recoveryFolder"].as_str().expect("recovery"));
    assert_eq!(
        names_in(&recovery),
        ["0001 b.md", "0002 ideas.md", "contents.md"]
    );
    assert_eq!(
        std::fs::read(recovery.join("0002 ideas.md")).expect("ideas"),
        b"a rain barrel"
    );
    let contents = std::fs::read_to_string(recovery.join("contents.md")).expect("contents");
    assert!(
        contents.contains("| 0002 ideas.md | hidden/ideas.md | Not sent. |"),
        "{contents}"
    );
    finish(&copy).await;
}

/// The member restores an older version of a shared file and doesn't send it.
/// The new store holds that version in History, but the restore is the
/// member's: it goes to the recovery folder before the shared version returns.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_unsent_restore_of_an_older_version_is_saved() {
    const A2_BYTES: &[u8] = b"open file body, edited by the owner";
    let copy = closed_copy_serving(
        "rpc-rebuild-unsent-restore",
        true,
        false,
        &[(
            moment(5, "moment-a2", "object-a", "open/a.md", A2_BYTES),
            A2_BYTES,
        )],
        |transport, handle, scratch| {
            Box::pin(async move {
                let mut id = 50;
                // The disk holds the older bytes, and the restore journals them.
                call(
                    transport,
                    handle,
                    &mut id,
                    "versionedText.write",
                    json!({
                        "versionId": "main", "objectId": "object-a", "path": "open/a.md",
                        "text": "open file body", "momentId": "restore-a", "origin": "api", "nowMs": 3_000,
                    }),
                )
                .await;
                assert_eq!(
                    std::fs::read(scratch.path().join("open/a.md")).expect("a"),
                    A_BYTES
                );
            })
        },
    )
    .await;
    let result = rebuild(&copy).await;
    assert_eq!(result["state"], "rebuilt", "{result}");
    let root = copy.scratch.path();
    assert_eq!(std::fs::read(root.join("open/a.md")).expect("a"), A2_BYTES);
    let recovery = root.join(result["recoveryFolder"].as_str().expect("recovery"));
    assert_eq!(
        names_in(&recovery),
        ["0001 b.md", "0002 a.md", "contents.md"]
    );
    assert_eq!(
        std::fs::read(recovery.join("0002 a.md")).expect("restore"),
        A_BYTES
    );
    let contents = std::fs::read_to_string(recovery.join("contents.md")).expect("contents");
    assert!(
        contents.contains("| 0002 a.md | open/a.md | Your change wasn't sent."),
        "{contents}"
    );
    finish(&copy).await;
}

/// The member restores an older version, then moves the file, and sends
/// neither. The source comes back with the owner's newer version, so the move
/// isn't undone: the restored bytes at the destination go to the recovery
/// folder.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_unsent_restore_then_move_is_saved() {
    const A2_BYTES: &[u8] = b"open file body, edited by the owner";
    let copy = closed_copy_serving(
        "rpc-rebuild-unsent-restore-move",
        true,
        false,
        &[(
            moment(5, "moment-a2", "object-a", "open/a.md", A2_BYTES),
            A2_BYTES,
        )],
        |transport, handle, scratch| {
            Box::pin(async move {
                let mut id = 50;
                let root = scratch.path();
                call(
                    transport,
                    handle,
                    &mut id,
                    "versionedText.write",
                    json!({
                        "versionId": "main", "objectId": "object-a", "path": "open/a.md",
                        "text": "open file body", "momentId": "restore-a", "origin": "api", "nowMs": 3_000,
                    }),
                )
                .await;
                call(
                    transport,
                    handle,
                    &mut id,
                    "versionedText.rename",
                    json!({
                        "versionId": "main", "fromPath": "open/a.md", "toPath": "open/moved.md",
                        "origin": "api",
                    }),
                )
                .await;
                std::fs::rename(root.join("open/a.md"), root.join("open/moved.md")).expect("move");
            })
        },
    )
    .await;
    let result = rebuild(&copy).await;
    assert_eq!(result["state"], "rebuilt", "{result}");
    let root = copy.scratch.path();
    assert_eq!(std::fs::read(root.join("open/a.md")).expect("a"), A2_BYTES);
    assert!(!root.join("open/moved.md").exists());
    let recovery = root.join(result["recoveryFolder"].as_str().expect("recovery"));
    assert_eq!(
        names_in(&recovery),
        ["0001 b.md", "0002 moved.md", "contents.md"]
    );
    assert_eq!(
        std::fs::read(recovery.join("0002 moved.md")).expect("restore"),
        A_BYTES
    );
    let contents = std::fs::read_to_string(recovery.join("contents.md")).expect("contents");
    assert!(
        contents.contains("| 0002 moved.md | open/moved.md | Not sent. |"),
        "{contents}"
    );
    assert!(!contents.contains("moved back"), "{contents}");
    finish(&copy).await;
}

/// A copy whose member renamed `open/d.md` to `open/D.md` and didn't send it.
async fn case_renamed_copy(workspace_id: &str) -> ClosedCopy {
    closed_copy_with(workspace_id, true, false, |transport, handle, scratch| {
        Box::pin(async move {
            let mut id = 50;
            let root = scratch.path();
            call(
                transport,
                handle,
                &mut id,
                "versionedText.rename",
                json!({
                    "versionId": "main", "fromPath": "open/d.md", "toPath": "open/D.md",
                    "origin": "api",
                }),
            )
            .await;
            std::fs::rename(root.join("open/d.md"), root.join("open/D.md")).expect("rename");
        })
    })
    .await
}

fn assert_case_rename_undone(copy: &ClosedCopy, result: &Value) {
    assert_eq!(result["state"], "rebuilt", "{result}");
    let root = copy.scratch.path();
    assert_eq!(names_in(&root.join("open")), ["a.md", "c.md", "d.md"]);
    assert_eq!(std::fs::read(root.join("open/d.md")).expect("d"), D_BYTES);
    let recovery = root.join(result["recoveryFolder"].as_str().expect("recovery"));
    assert_eq!(names_in(&recovery), ["0001 b.md", "contents.md"]);
    let contents = std::fs::read_to_string(recovery.join("contents.md")).expect("contents");
    assert!(
        contents.contains("- `open/D.md` moved back to `open/d.md`"),
        "{contents}"
    );
}

/// The member renames a file by case alone and doesn't send it. On a file
/// system that ignores case, both spellings read the one file, which must
/// not go to the recovery folder as an unsent file of its own: the rename is
/// undone like any other.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_unsent_rename_by_case_alone_is_undone() {
    let copy = case_renamed_copy("rpc-rebuild-unsent-case").await;
    let result = rebuild(&copy).await;
    assert_case_rename_undone(&copy, &result);
    finish(&copy).await;
}

/// The engine stops after a wave's jobs are stored and before they run. The
/// restarted rebuild's open must not settle them by the meaning an ordinary
/// open gives a pending job: the delete of `open/D.md` would then be retired,
/// because the new store's `open/d.md` reaches the same file.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_unsent_rename_by_case_alone_is_undone_after_a_stop_before_its_wave_runs() {
    let copy = case_renamed_copy("rpc-rebuild-unsent-case-stop").await;
    let service = Arc::new(EngineService::new());
    service.crash_rebuild_at_for_harness("added-1");
    let crashed = rebuild_on(&service, &copy).await.expect_err("crashed");
    assert_eq!(crashed.message, "rebuild-crash-for-harness");
    assert_eq!(manifest(&copy).expect("manifest")["phase"], "swapped");
    drop(service);
    let result = rebuild(&copy).await;
    assert_case_rename_undone(&copy, &result);
    finish(&copy).await;
}

/// The member edits `open/a.md` and doesn't send it, then changes the file
/// again while the rebuild downloads. The plan sees the newer bytes on disk,
/// so the stored edit is neither on disk nor in the new store: both go to the
/// recovery folder.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_unsent_version_the_disk_lost_during_the_download_is_saved() {
    let copy = edited_copy("rpc-rebuild-unsent-overwritten").await;
    let target = copy.scratch.path().join("open/a.md");
    copy.relay.state.lock().expect("relay state").on_share_log = Some(Box::new(move || {
        std::fs::write(target, "my newer draft").expect("newer draft");
    }));
    let result = rebuild(&copy).await;
    assert_eq!(result["state"], "rebuilt", "{result}");
    let root = copy.scratch.path();
    assert_eq!(std::fs::read(root.join("open/a.md")).expect("a"), A_BYTES);
    let recovery = root.join(result["recoveryFolder"].as_str().expect("recovery"));
    assert_eq!(
        names_in(&recovery),
        ["0001 b.md", "0002 a.md", "0003 a.md", "contents.md"]
    );
    assert_eq!(
        std::fs::read(recovery.join("0002 a.md")).expect("disk"),
        b"my newer draft"
    );
    assert_eq!(
        std::fs::read(recovery.join("0003 a.md")).expect("stored"),
        b"my edit"
    );
    finish(&copy).await;
}

/// A copy whose member edited `open/a.md` to "my edit" and didn't send it.
async fn edited_copy(workspace_id: &str) -> ClosedCopy {
    closed_copy_with(workspace_id, true, false, |transport, handle, scratch| {
        Box::pin(async move {
            let mut id = 50;
            call(
                transport,
                handle,
                &mut id,
                "versionedText.write",
                json!({
                    "versionId": "main", "objectId": "object-a", "path": "open/a.md",
                    "text": "my edit", "momentId": "edit-a", "origin": "api", "nowMs": 3_000,
                }),
            )
            .await;
            std::fs::write(scratch.path().join("open/a.md"), "my edit").expect("edit");
        })
    })
    .await
}

/// A file on disk whose bytes the new store holds is replaced in place, with
/// those bytes as its preimage, and nothing goes to the recovery folder.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_draft_the_new_store_holds_is_replaced_in_place() {
    let copy = closed_copy_with("rpc-rebuild-held-draft", false, true, |_, _, scratch| {
        Box::pin(async move {
            std::fs::write(scratch.path().join("open/a.md"), B_BYTES).expect("draft");
        })
    })
    .await;
    let result = rebuild(&copy).await;
    assert_eq!(result["state"], "rebuilt", "{result}");
    assert!(result["recoveryFolder"].is_null(), "{result}");
    let root = copy.scratch.path();
    assert_eq!(std::fs::read(root.join("open/a.md")).expect("a"), A_BYTES);
    assert_eq!(std::fs::read(root.join("hidden/b.md")).expect("b"), B_BYTES);
    assert!(!root.join(".dohc/local/recovery").exists());
    let plan = manifest(&copy).expect("manifest")["plan"].clone();
    let job = plan["jobs"]
        .as_array()
        .expect("jobs")
        .iter()
        .find(|job| job["path"] == "open/a.md")
        .expect("a's job")
        .clone();
    assert_eq!(job["preimage"], hex_sha256(B_BYTES), "{plan}");
    finish(&copy).await;
}

/// Chat the relay hasn't taken is saved as one Markdown file per thread,
/// with what each message replies to, its decision and its attachments.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn unsent_chat_is_saved_with_its_replies_decisions_and_attachments() {
    let copy = closed_copy_with("rpc-rebuild-chat", true, false, |transport, handle, _| {
        Box::pin(async move {
            let mut id = 50;
            call(
                transport,
                handle,
                &mut id,
                "chats.channels.create",
                json!({ "channelId": "channel", "name": "General", "kind": "channel", "nowMs": 10 }),
            )
            .await;
            call(
                transport,
                handle,
                &mut id,
                "chats.threads.start",
                json!({
                    "channelId": "channel", "threadId": "thread", "messageId": "question",
                    "authorKind": "human", "authorDisplayName": "Ada", "authorUserId": "ada",
                    "body": "Which venue?", "needsDecision": true, "nowMs": 20,
                }),
            )
            .await;
            call(
                transport,
                handle,
                &mut id,
                "chats.messages.send",
                json!({
                    "threadId": "thread", "messageId": "reply", "parentMessageId": "question",
                    "authorKind": "human", "authorDisplayName": "Ada", "authorUserId": "ada",
                    "body": "The hall, see the plan", "nowMs": 21,
                    "attachments": [{ "objectId": "object-a", "pathHint": "open/a.md" }],
                }),
            )
            .await;
        })
    })
    .await;
    let result = rebuild(&copy).await;
    assert_eq!(result["state"], "rebuilt", "{result}");
    let recovery = copy
        .scratch
        .path()
        .join(result["recoveryFolder"].as_str().expect("recovery"));
    let names = names_in(&recovery);
    let chat = names
        .iter()
        .find(|name| name.starts_with("0002 chat "))
        .unwrap_or_else(|| panic!("no chat file in {names:?}"));
    let text = std::fs::read_to_string(recovery.join(chat)).expect("chat");
    for line in [
        "## Ada, 1970-01-01 00:00 UTC\n\nWhich venue?\n",
        "Decision: open",
        "The hall, see the plan",
        "Replying to Ada: \"Which venue?\"",
        "Attached: open/a.md",
    ] {
        assert!(text.contains(line), "{line}\n{text}");
    }
    let contents = std::fs::read_to_string(recovery.join("contents.md")).expect("contents");
    assert!(
        contents.contains("Chat messages that weren't sent."),
        "{contents}"
    );
    finish(&copy).await;
}

/// A live draft main passes and the old store's displaced folder are saved.
/// The folder moves with one rename, so its files keep their inodes.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_live_draft_and_the_displaced_folder_are_saved() {
    let mut copy = closed_copy_with("rpc-rebuild-displaced", true, false, |_, _, scratch| {
        Box::pin(async move {
            let displaced = scratch.path().join(".dohc/engine/displaced");
            std::fs::create_dir_all(&displaced).expect("displaced");
            std::fs::write(displaced.join("kept.md"), "set aside before").expect("kept");
        })
    })
    .await;
    copy.live_drafts =
        json!([{ "recordId": "draft-1", "path": "open/a.md", "text": "typed but not sent" }]);
    let root = copy.scratch.path().to_path_buf();
    #[cfg(unix)]
    let inode = {
        use std::os::unix::fs::MetadataExt;
        std::fs::metadata(root.join(".dohc/engine/displaced/kept.md"))
            .expect("kept")
            .ino()
    };
    let result = rebuild(&copy).await;
    assert_eq!(result["state"], "rebuilt", "{result}");
    assert_eq!(result["savedDrafts"], json!(["draft-1"]), "{result}");
    let recovery = root.join(result["recoveryFolder"].as_str().expect("recovery"));
    assert_eq!(
        names_in(&recovery),
        [
            "0001 b.md",
            "0002 a (open page).md",
            "0003 displaced",
            "contents.md"
        ]
    );
    assert_eq!(
        std::fs::read_to_string(recovery.join("0002 a (open page).md")).expect("draft"),
        "typed but not sent"
    );
    let kept = recovery.join("0003 displaced/kept.md");
    assert_eq!(
        std::fs::read_to_string(&kept).expect("kept"),
        "set aside before"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        assert_eq!(std::fs::metadata(&kept).expect("kept").ino(), inode);
    }
    assert!(!root.join(".dohc/engine/displaced").exists());
    // A finish main retries after losing the answer still names the drafts.
    assert_eq!(finish(&copy).await["savedDrafts"], json!(["draft-1"]));
}

/// Stop the rebuild at `point` as a crash would, then run it again on a new
/// service, as after a restart. It must finish as if nothing had stopped it.
async fn crash_then_resume(workspace_id: &str, point: &str, phase: &str) -> ClosedCopy {
    let mut copy = closed_copy(workspace_id, true, false).await;
    copy.live_drafts =
        json!([{ "recordId": "draft-1", "path": "open/a.md", "text": "typed but not sent" }]);
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
    // Nothing lost and nothing twice.
    assert_eq!(
        names_in(&recovery),
        ["0001 b.md", "0002 a (open page).md", "contents.md"],
        "{point}"
    );
    assert_eq!(
        std::fs::read_to_string(recovery.join("0002 a (open page).md")).expect("draft"),
        "typed but not sent",
        "{point}"
    );
    assert_eq!(result["savedDrafts"], json!(["draft-1"]), "{point}");
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
async fn a_rebuild_stopped_in_planned_resumes() {
    crash_then_resume("rpc-rebuild-crash-planned", "planned", "planned").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_rebuild_stopped_in_converged_resumes() {
    crash_then_resume("rpc-rebuild-crash-converged", "converged", "converged").await;
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

/// An owner's move across the edge of the member's reach, which the relay
/// marks in the pull, closes a copy that holds earlier pages as a visibility
/// change does, though both signatures stay the same. Its rebuild applies the
/// marked page: it pulls from the start, where the move is History the reach
/// serves.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_pull_that_marks_a_move_across_the_reach_closes_the_copy_and_its_rebuild_applies_it() {
    let workspace_id = "rpc-relay-moved-across";
    let relay = FakeRelay::start(RelayState::default());
    serve(&relay, "r1", "v1", false);
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
    assert!(pulled.get("rebuildId").is_none(), "{pulled}");
    call(
        &transport,
        &handle,
        &mut id,
        "sync.commitCursor",
        json!({ "workspaceId": workspace_id, "pendingCursor": pulled["pendingCursor"] }),
    )
    .await;
    for (path, bytes) in [
        ("open/a.md", A_BYTES),
        ("open/c.md", C_BYTES),
        ("open/d.md", D_BYTES),
    ] {
        let target = scratch.path().join(path);
        std::fs::create_dir_all(target.parent().expect("parent")).expect("folder");
        std::fs::write(target, bytes).expect("file");
    }

    // The owner moves a file out of a hidden folder. The relay serves it as a
    // write and marks it.
    {
        let mut state = relay.state.lock().expect("relay state");
        let mut arrived = moment(5, "moment-e", "object-e", "open/e.md", B_BYTES);
        arrived["reachMove"] = json!("arrival");
        state.share_ops.get_mut(SHARE).expect("ops").push(arrived);
    }
    let closed = call(&transport, &handle, &mut id, "share.view.pull", pull).await;
    assert_eq!(
        closed["reachChanged"],
        json!({ "signature": "r1", "visibilitySignature": "v1" })
    );
    let rebuild_id = closed["rebuildId"]
        .as_str()
        .expect("a marked move closes the copy")
        .to_owned();
    assert!(closed.get("pendingCursor").is_none(), "{closed}");
    close(&transport, &handle, &mut id).await;

    let copy = ClosedCopy {
        relay,
        scratch,
        workspace_id: workspace_id.to_owned(),
        rebuild_id,
        live_drafts: json!([]),
    };
    let mut params = rebuild_params(&copy);
    params["grantedSelector"] = grant("r1", "v1");
    let rebuilt = InProcessTransport::new(Arc::new(EngineService::new()))
        .call(
            RequestContext::unbounded(),
            request(90, "share.view.rebuild", None, params),
        )
        .await
        .expect("rebuild")
        .result;
    assert_eq!(rebuilt["state"], json!("rebuilt"), "{rebuilt}");
    finish(&copy).await;
    assert_eq!(
        std::fs::read(copy.scratch.path().join("open/e.md")).expect("the moved file"),
        B_BYTES
    );
}

/// Main lost the answer that closed the copy: it quit, or failed to store the
/// id, before it recorded it. A restarted engine still names the rebuild from
/// the manifest, and the rebuild under that id finishes. Once it has, no
/// rebuild is named.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_restarted_engine_names_a_rebuild_whose_closing_answer_was_lost() {
    let mut copy = closed_copy("rpc-rebuild-lost-answer", true, false).await;
    let closed_with = std::mem::take(&mut copy.rebuild_id);
    let root = copy.scratch.path().to_string_lossy().into_owned();
    let status = || async {
        InProcessTransport::new(Arc::new(EngineService::new()))
            .call(
                RequestContext::unbounded(),
                request(
                    92,
                    "share.view.rebuildStatus",
                    None,
                    json!({ "rootDir": root }),
                ),
            )
            .await
            .expect("status")
            .result
    };
    let named = status().await;
    assert_eq!(
        named,
        json!({ "rebuildId": closed_with, "phase": "closed" })
    );
    copy.rebuild_id = named["rebuildId"].as_str().expect("id").to_owned();
    let result = rebuild(&copy).await;
    assert_eq!(result["state"], "rebuilt", "{result}");
    assert_eq!(
        status().await,
        json!({ "rebuildId": closed_with, "phase": "converged" })
    );
    finish(&copy).await;
    assert_eq!(status().await, json!({ "rebuildId": null, "phase": null }));
    assert!(!copy.scratch.path().join("hidden/b.md").exists());
}

/// A copy's first pull reads every page for the first time, and the relay
/// selects each one under the reach the member has now. So a later page of
/// that pull that marks a move applies, and the copy doesn't close and
/// download everything again. Once the copy has caught up, a marked page
/// closes it as before.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_first_pull_over_several_pages_applies_a_marked_later_page() {
    let workspace_id = "rpc-relay-first-pull-marked";
    let relay = FakeRelay::start(RelayState {
        share_page_limit: Some(2),
        ..RelayState::default()
    });
    let mut arrived = moment(5, "moment-e", "object-e", "open/e.md", B_BYTES);
    arrived["reachMove"] = json!("arrival");
    serve_with(&relay, "r1", "v1", false, &[(arrived, B_BYTES)]);
    let scratch = ScratchDir::new().expect("scratch");
    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let handle = open_workspace(&transport, &scratch, &relay, 1, workspace_id).await;
    let mut id = 1;
    seed_main(&transport, &handle, &mut id, workspace_id).await;
    let pull = json!({ "workspaceId": workspace_id, "shareId": SHARE, "grantedSelector": grant("r1", "v1") });
    // Two pages: seq 1 and 2, then seq 3 and the marked seq 5.
    for (page, more) in [(1, true), (2, false)] {
        let pulled = call(
            &transport,
            &handle,
            &mut id,
            "share.view.pull",
            pull.clone(),
        )
        .await;
        assert!(pulled.get("rebuildId").is_none(), "page {page}: {pulled}");
        assert_eq!(pulled["hasMore"], json!(more), "page {page}: {pulled}");
        call(
            &transport,
            &handle,
            &mut id,
            "sync.commitCursor",
            json!({ "workspaceId": workspace_id, "pendingCursor": pulled["pendingCursor"] }),
        )
        .await;
    }
    let text = call(
        &transport,
        &handle,
        &mut id,
        "versionedText.read",
        json!({ "versionId": "main", "path": "open/e.md" }),
    )
    .await;
    assert_eq!(text["text"], "hidden file body", "the marked page applied");

    // Caught up: the next marked page closes the copy.
    {
        let mut state = relay.state.lock().expect("relay state");
        let mut left = moment(6, "moment-f", "object-f", "open/f.md", C_BYTES);
        left["reachMove"] = json!("departure");
        state.share_ops.get_mut(SHARE).expect("ops").push(left);
    }
    let closed = call(&transport, &handle, &mut id, "share.view.pull", pull).await;
    assert!(closed["rebuildId"].is_string(), "{closed}");
    close(&transport, &handle, &mut id).await;
}

/// Two file threads the relay serves with the files: one on `open/a.md`, and
/// one on `hidden/b.md` when the member reaches it.
fn serve_threads(relay: &FakeRelay, with_hidden: bool) {
    let mut state = relay.state.lock().expect("relay state");
    let ops = state.share_ops.get_mut(SHARE).expect("ops");
    let threads: &[(&str, &str)] = if with_hidden {
        &[
            ("thread-open", "open/a.md"),
            ("thread-hidden", "hidden/b.md"),
        ]
    } else {
        &[("thread-open", "open/a.md")]
    };
    let mut seq = 10;
    for (thread, path) in threads {
        ops.push(share_row(
            seq,
            "granter",
            seq,
            "chat.thread.create",
            json!({ "threadId": thread, "title": "About it", "createdAtMs": 5, "linkedAtMs": 5, "linkedPath": path }),
        ));
        ops.push(share_row(
            seq + 1,
            "granter",
            seq + 1,
            "chat.message.append",
            json!({
                "messageId": format!("{thread}-message"), "threadId": thread, "authorKind": "human",
                "authorDisplayName": "Owner", "authorUserId": "owner", "body": "Look here", "createdAtMs": 6,
            }),
        ));
        seq += 2;
    }
}

/// The member's own rows in each carried table, as `table: key`.
fn carried_rows(db: &Connection, workspace_id: &str) -> Vec<String> {
    let mut rows = Vec::new();
    for (table, key) in [
        ("chat_thread_read_state", "thread_id"),
        ("chat_agent_read_state", "thread_id"),
        ("chat_bookmarks", "target_id"),
        ("chat_bookmark_outbox", "bookmark_id"),
        ("chat_follows", "target_id"),
        ("chat_feed_read_state", "last_seen_message_id"),
    ] {
        let mut statement = db
            .prepare(&format!(
                "SELECT {key} FROM {table} WHERE workspace_id = ?1 ORDER BY 1"
            ))
            .expect("prepare");
        for key in statement
            .query_map([workspace_id], |row| row.get::<_, String>(0))
            .expect("query")
        {
            rows.push(format!("{table}: {}", key.expect("row")));
        }
    }
    rows
}

/// Read markers, bookmarks, follows and feed read state for both threads, as
/// the member's own chat writes leave them.
fn mark_threads(db: &Connection, workspace_id: &str) {
    for thread in ["thread-open", "thread-hidden"] {
        for statement in [
            "INSERT INTO chat_thread_read_state (workspace_id, thread_id, last_read_sequence, revision, \
               updated_at_ms) VALUES (?1, ?2, 1, 1, 7)",
            "INSERT INTO chat_agent_read_state (workspace_id, agent_id, thread_id, last_read_created_at_ms, \
               last_read_message_id, revision, updated_at_ms) VALUES (?1, 'default', ?2, 6, ?2 || '-message', 1, 7)",
            "INSERT INTO chat_bookmarks (workspace_id, bookmark_id, owner_user_id, target_kind, target_id, \
               thread_id, message_id, mode, destination_path, state, created_at_ms, updated_at_ms) \
             VALUES (?1, 'bookmark-' || ?2, 'member', 'thread', ?2, ?2, NULL, 'live', \
               'Bookmarks/' || ?2 || '.md', 'active', 7, 7)",
            "INSERT INTO chat_bookmark_outbox (workspace_id, bookmark_id, generation, projected_generation, \
               projection_state, updated_at_ms) VALUES (?1, 'bookmark-' || ?2, 1, 1, 'ready', 7)",
            "INSERT INTO chat_follows (workspace_id, owner_user_id, target_kind, target_id, state, \
               updated_at_ms, origin_id, origin_seq) VALUES (?1, 'member', 'thread', ?2, 'following', 7, 'here', 1)",
        ] {
            db.execute(statement, [workspace_id, thread])
                .expect(statement);
        }
    }
    for statement in [
        "INSERT INTO chat_follows (workspace_id, owner_user_id, target_kind, target_id, state, \
           updated_at_ms, origin_id, origin_seq) VALUES (?1, 'member', 'person', 'owner', 'following', 7, 'here', 2)",
        "INSERT INTO chat_feed_read_state (workspace_id, owner_user_id, last_seen_created_at_ms, \
           last_seen_message_id, updated_at_ms, origin_id, origin_seq) \
         VALUES (?1, 'member', 6, 'thread-open-message', 7, 'here', 3)",
    ] {
        db.execute(statement, [workspace_id]).expect(statement);
    }
}

/// The member's read markers, bookmarks, follows and feed read state carry
/// into the rebuilt store, except where they name a thread the new reach
/// hides. So a rebuild doesn't mark every thread unread.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn read_markers_bookmarks_follows_and_feed_state_carry_across_a_rebuild() {
    let workspace_id = "rpc-rebuild-carried";
    let relay = FakeRelay::start(RelayState::default());
    serve(&relay, "r1", "v1", true);
    serve_threads(&relay, true);
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
    close(&transport, &handle, &mut id).await;
    for (path, bytes) in [
        ("open/a.md", A_BYTES),
        ("open/c.md", C_BYTES),
        ("open/d.md", D_BYTES),
        ("hidden/b.md", B_BYTES),
    ] {
        let target = scratch.path().join(path);
        std::fs::create_dir_all(target.parent().expect("parent")).expect("folder");
        std::fs::write(target, bytes).expect("file");
    }
    {
        let db = Connection::open(engine_db_path(&scratch).expect("db path")).expect("db");
        let threads: i64 = db
            .query_row(
                "SELECT COUNT(*) FROM chat_threads WHERE workspace_id = ?1",
                [workspace_id],
                |row| row.get(0),
            )
            .expect("threads");
        assert_eq!(threads, 2, "the pull applied both threads");
        mark_threads(&db, workspace_id);
    }

    // The narrowing hides `hidden/b.md` and its thread.
    serve(&relay, "r2", "v2", false);
    serve_threads(&relay, false);
    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let handle = open_workspace(&transport, &scratch, &relay, 2, workspace_id).await;
    let closed = call(&transport, &handle, &mut id, "share.view.pull", pull).await;
    let rebuild_id = closed["rebuildId"].as_str().expect("closed").to_owned();
    close(&transport, &handle, &mut id).await;
    let copy = ClosedCopy {
        relay,
        scratch,
        workspace_id: workspace_id.to_owned(),
        rebuild_id,
        live_drafts: json!([]),
    };
    let result = rebuild(&copy).await;
    assert_eq!(result["state"], "rebuilt", "{result}");
    finish(&copy).await;

    let db = Connection::open(engine_db_path(&copy.scratch).expect("db path")).expect("db");
    assert_eq!(
        carried_rows(&db, workspace_id),
        [
            "chat_thread_read_state: thread-open",
            "chat_agent_read_state: thread-open",
            "chat_bookmarks: thread-open",
            "chat_bookmark_outbox: bookmark-thread-open",
            "chat_follows: owner",
            "chat_follows: thread-open",
            "chat_feed_read_state: thread-open-message",
        ]
    );
}
