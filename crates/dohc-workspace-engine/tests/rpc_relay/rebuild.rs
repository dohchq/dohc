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
    let mut state = relay.state.lock().expect("relay state");
    let mut ops = vec![
        moment(1, "moment-a", "object-a", "open/a.md", A_BYTES),
        moment(2, "moment-c", "object-c", "open/c.md", C_BYTES),
        moment(3, "moment-d", "object-d", "open/d.md", D_BYTES),
    ];
    if with_hidden {
        ops.push(moment(4, "moment-b", "object-b", "hidden/b.md", B_BYTES));
    }
    state.share_ops.insert(SHARE.to_owned(), ops);
    for bytes in [A_BYTES, B_BYTES, C_BYTES, D_BYTES] {
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
    write("open/c.md", C_BYTES);
    write("open/d.md", D_BYTES);
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
    finish(&copy).await;
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
