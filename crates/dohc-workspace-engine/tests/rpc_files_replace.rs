//! `files.replace` writes given bytes over a workspace file whole, through the
//! materializer's temp, flush and rename. On macOS the temp of a replaced file
//! or a secret is created without the folder's inherited ACL entries, and a
//! replaced ordinary file's ACL is copied to it. The macOS test here checks
//! that through the RPC; `create_uninherited` and `copy_acl` in
//! dohc-macos-files have their own tests.

use crate::common;

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
async fn files_replace_writes_a_secret_owner_only() {
    use std::os::unix::fs::PermissionsExt as _;
    let (scratch, transport, handle) = fixture("secret").await;
    // A secret this machine doesn't hold yet, and one that others could read.
    write_file(scratch.path(), "config/.env.local", b"TOKEN=old\n");
    std::fs::set_permissions(
        scratch.path().join("config/.env.local"),
        std::fs::Permissions::from_mode(0o644),
    )
    .unwrap();
    for (id, path) in [".env", "config/.env.local"].into_iter().enumerate() {
        call(
            &transport,
            &handle,
            10 + id as u64,
            "files.replace",
            params(path, TEMP, b"TOKEN=new\n"),
        )
        .await;
        let file = scratch.path().join(path);
        assert_eq!(std::fs::read(&file).unwrap(), b"TOKEN=new\n", "{path}");
        let mode = std::fs::metadata(&file).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "{path}");
    }
}

/// A folder that lets everyone read each new file in it, given that entry
/// after a private file was made, opens neither that file when it is
/// replaced nor a secret written there.
#[cfg(target_os = "macos")]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn files_replace_gives_a_file_none_of_its_folders_inherited_acl() {
    use std::os::unix::fs::PermissionsExt as _;
    // Whether `ls -le` lists any ACL entry for `path`.
    let has_entries = |path: &Path| {
        let listing = std::process::Command::new("/bin/ls")
            .arg("-led")
            .arg(path)
            .output()
            .unwrap();
        assert!(listing.status.success());
        String::from_utf8(listing.stdout).unwrap().lines().count() > 1
    };
    let (scratch, transport, handle) = fixture("acl").await;
    let folder = scratch.path().join("shared");
    write_file(scratch.path(), "shared/private.md", b"old\n");
    std::fs::set_permissions(
        folder.join("private.md"),
        std::fs::Permissions::from_mode(0o600),
    )
    .unwrap();
    let added = std::process::Command::new("/bin/chmod")
        .args(["+a", "group:everyone allow read,file_inherit"])
        .arg(&folder)
        .status()
        .unwrap();
    assert!(added.success());
    // A file made there the ordinary way takes the entry.
    write_file(scratch.path(), "shared/inheriting.md", b"");
    assert!(has_entries(&folder.join("inheriting.md")));
    assert!(!has_entries(&folder.join("private.md")));
    for (id, path) in ["shared/private.md", "shared/.env"].into_iter().enumerate() {
        call(
            &transport,
            &handle,
            10 + id as u64,
            "files.replace",
            params(path, TEMP, b"new\n"),
        )
        .await;
        let file = scratch.path().join(path);
        assert_eq!(std::fs::read(&file).unwrap(), b"new\n", "{path}");
        assert!(!has_entries(&file), "{path}");
        let mode = std::fs::metadata(&file).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "{path}");
    }
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
