//! `files.replace` writes given bytes over a workspace file whole, through the
//! materializer's temp, flush and rename. The temp's macOS access, created
//! without the folder's inherited ACL entries and given the replaced file's
//! ACL, is covered by `create_uninherited` and `copy_acl` in
//! dohc-macos-files.

mod common;

use base64::Engine as _;
use common::*;
use dohc_engine_protocol::{
    transport::{InProcessTransport, RequestContext},
    wire::WorkspaceHandle,
};
use dohc_engine_testkit::ScratchDir;
use dohc_workspace_engine::{EngineService, root_binding::write_root_binding};
use serde_json::{Value, json};
use std::{path::Path, sync::Arc};

const TEMP: &str = ".dohc-write-0123456789abcdef.tmp";

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
                "workspaceId": format!("ws-files-replace-{name}"),
            }),
        ),
    )
    .await
    .expect("open");
    let handle = serde_json::from_value(opened.result["workspace"].clone()).expect("handle");
    (scratch, transport, handle)
}

fn params(path: &str, temporary: &str, bytes: &[u8]) -> Value {
    json!({
        "path": path,
        "temporary": temporary,
        "bytesBase64": base64::engine::general_purpose::STANDARD.encode(bytes),
    })
}

fn names(folder: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(folder)
        .expect("read folder")
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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn files_replace_writes_the_bytes_whole_and_leaves_no_temp() {
    let (scratch, transport, handle) = fixture("whole").await;
    write_file(scratch.path(), "notes/a.md", b"old");
    // A temp that a stopped write left at the same name goes first.
    write_file(scratch.path(), &format!("notes/{TEMP}"), b"left");
    let replaced = call(
        &transport,
        &handle,
        2,
        "files.replace",
        params("notes/a.md", TEMP, b"new\n"),
    )
    .await;
    assert_eq!(replaced, json!({ "replaced": true }));
    assert_eq!(
        std::fs::read(scratch.path().join("notes/a.md")).unwrap(),
        b"new\n"
    );
    assert_eq!(names(&scratch.path().join("notes")), ["a.md"]);

    // A file in folders that are not there yet.
    call(
        &transport,
        &handle,
        3,
        "files.replace",
        params("deep/er/b.bin", TEMP, &[0, 255]),
    )
    .await;
    assert_eq!(
        std::fs::read(scratch.path().join("deep/er/b.bin")).unwrap(),
        [0, 255]
    );
    assert_eq!(names(&scratch.path().join("deep/er")), ["b.bin"]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn files_replace_refuses_a_path_or_temp_outside_the_workspace_files() {
    let (scratch, transport, handle) = fixture("refusals").await;
    for (id, (path, temporary)) in [
        ("../outside.md", TEMP),
        ("/outside.md", TEMP),
        ("notes/../../outside.md", TEMP),
        (".dohc/settings.json", TEMP),
        ("a.md", "a.md"),
        ("a.md", "../.dohc-write-0123456789abcdef.tmp"),
        ("a.md", ".dohc-write-.tmp"),
        ("a.md", ".dohc-write-a/b.tmp"),
    ]
    .into_iter()
    .enumerate()
    {
        let error = call_error(
            &transport,
            &handle,
            10 + id as u64,
            "files.replace",
            params(path, temporary, b"x"),
        )
        .await;
        assert_eq!(error.message, "unsafe-target-path", "{path} {temporary}");
    }
    assert!(!scratch.path().join("a.md").exists());
    assert!(!scratch.path().join(".dohc/settings.json").exists());
    assert!(!scratch.path().parent().unwrap().join("outside.md").exists());
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn files_replace_refuses_a_link_at_the_file_or_a_folder_above_it() {
    let (scratch, transport, handle) = fixture("links").await;
    let outside = ScratchDir::new().expect("outside");
    write_file(outside.path(), "keep.md", b"keep");
    std::os::unix::fs::symlink(
        outside.path().join("keep.md"),
        scratch.path().join("link.md"),
    )
    .unwrap();
    std::os::unix::fs::symlink(outside.path(), scratch.path().join("folder")).unwrap();
    for (id, path) in ["link.md", "folder/keep.md", "folder/new.md"]
        .into_iter()
        .enumerate()
    {
        let error = call_error(
            &transport,
            &handle,
            10 + id as u64,
            "files.replace",
            params(path, TEMP, b"x"),
        )
        .await;
        assert_eq!(error.message, "symlink-target", "{path}");
    }
    assert_eq!(
        std::fs::read(outside.path().join("keep.md")).unwrap(),
        b"keep"
    );
    assert_eq!(names(outside.path()), ["keep.md"]);
    assert!(
        std::fs::symlink_metadata(scratch.path().join("link.md"))
            .unwrap()
            .file_type()
            .is_symlink()
    );
}
