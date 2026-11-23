//! A protected-file job queued before the workspace closes keeps an edit made
//! to the file while dohc was closed.

use crate::common;

use common::*;
use dohc_engine_protocol::{
    transport::{InProcessTransport, RequestContext},
    wire::WorkspaceHandle,
};
use dohc_engine_testkit::ScratchDir;
use dohc_workspace_engine::{EngineService, root_binding::write_root_binding};
use serde_json::{Value, json};
use std::sync::Arc;

struct Workspace {
    scratch: ScratchDir,
    transport: InProcessTransport<EngineService>,
    id: String,
    handle: Option<WorkspaceHandle>,
    next_request: u64,
}

impl Workspace {
    async fn open_new(name: &str) -> Self {
        let scratch = ScratchDir::new().expect("scratch");
        write_root_binding(scratch.path(), TOKEN).expect("root binding");
        let mut workspace = Workspace {
            scratch,
            transport: InProcessTransport::new(Arc::new(EngineService::new())),
            id: format!("ws-queued-{name}"),
            handle: None,
            next_request: 1,
        };
        workspace.open().await;
        workspace.secrets("versions.ensureMain", json!({})).await;
        workspace
    }

    async fn open(&mut self) {
        self.next_request += 1;
        let opened = call_with_busy_retry(
            &self.transport,
            RequestContext::unbounded(),
            request(
                self.next_request,
                "workspace.open",
                None,
                json!({
                    "rootDir": self.scratch.path().to_string_lossy(),
                    "workspaceId": self.id,
                }),
            ),
        )
        .await
        .expect("open");
        self.handle =
            Some(serde_json::from_value(opened.result["workspace"].clone()).expect("handle"));
    }

    async fn close(&mut self) {
        self.call("workspace.close", json!({})).await;
        self.handle = None;
    }

    async fn reopen(&mut self) {
        self.close().await;
        self.open().await;
    }

    async fn call(&mut self, method: &str, params: Value) -> Value {
        self.next_request += 1;
        let handle = self.handle.clone().expect("open workspace");
        call(&self.transport, &handle, self.next_request, method, params).await
    }

    async fn secrets(&mut self, method: &str, mut params: Value) -> Value {
        params["workspaceId"] = json!(self.id);
        self.call(method, params).await
    }

    async fn secrets_error(&mut self, method: &str, mut params: Value) -> String {
        params["workspaceId"] = json!(self.id);
        self.next_request += 1;
        let handle = self.handle.clone().expect("open workspace");
        format!(
            "{:?}",
            call_error(&self.transport, &handle, self.next_request, method, params).await
        )
    }

    async fn delete(&mut self, moment_id: &str) {
        self.secrets(
            "secrets.delete",
            json!({
                "versionId": "main",
                "path": ".env",
                "origin": "api",
                "momentId": moment_id,
            }),
        )
        .await;
    }

    async fn reconcile(&mut self) {
        let handle = self.handle.clone().expect("open workspace");
        reconcile_until_settled(&self.transport, &handle, self.next_request).await;
    }

    async fn recorded(&mut self, text: &str) -> bool {
        self.secrets("secrets.recorded", json!({ "path": ".env", "text": text }))
            .await["recorded"]
            .as_bool()
            .expect("recorded flag")
    }

    fn secret_rows(&self) -> i64 {
        rusqlite::Connection::open(self.scratch.path().join(".dohc/engine/engine.db"))
            .expect("sqlite")
            .query_row(
                "SELECT (SELECT count(*) FROM secret_moments) + \n                 (SELECT count(*) FROM materialization_jobs WHERE job_id GLOB 'secret-mat_*')",
                [],
                |row| row.get(0),
            )
            .expect("secret rows")
    }

    fn has_key(&self) -> bool {
        self.scratch.path().join(".dohc/engine/secret.key").exists()
    }

    async fn write(&mut self, text: &str, moment_id: &str) {
        self.secrets(
            "secrets.write",
            json!({
                "versionId": "main",
                "path": ".env",
                "text": text,
                "origin": "api",
                "momentId": moment_id,
            }),
        )
        .await;
    }

    fn env(&self) -> Option<String> {
        std::fs::read_to_string(self.scratch.path().join(".env")).ok()
    }

    fn assert_no_conflict_sibling(&self) {
        let siblings: Vec<String> = std::fs::read_dir(self.scratch.path())
            .expect("workspace root")
            .map(|entry| {
                entry
                    .expect("entry")
                    .file_name()
                    .to_string_lossy()
                    .into_owned()
            })
            .filter(|name| name.starts_with(".env") && name != ".env")
            .collect();
        assert!(siblings.is_empty(), "plaintext siblings: {siblings:?}");
    }

    fn job_status(&self, moment_id: &str) -> String {
        rusqlite::Connection::open(self.scratch.path().join(".dohc/engine/engine.db"))
            .expect("sqlite")
            .query_row(
                "SELECT status FROM materialization_jobs WHERE job_id = ?1",
                [format!("secret-mat_{moment_id}")],
                |row| row.get(0),
            )
            .expect("job status")
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_queued_restore_keeps_an_edit_made_while_closed() {
    let mut workspace = Workspace::open_new("restore").await;
    workspace.write("VALUE=first\n", "first").await;
    workspace.reopen().await;
    workspace.write("VALUE=second\n", "second").await;
    workspace.reopen().await;
    assert_eq!(workspace.env().as_deref(), Some("VALUE=second\n"));
    workspace
        .secrets(
            "secrets.restore",
            json!({
                "path": ".env",
                "beforeMomentId": "second",
                "momentId": "restore-first",
                "origin": "api",
            }),
        )
        .await;
    workspace.close().await;
    std::fs::write(workspace.scratch.path().join(".env"), "VALUE=edited\n").expect("edit");

    workspace.open().await;

    assert_eq!(workspace.env().as_deref(), Some("VALUE=edited\n"));
    workspace.assert_no_conflict_sibling();
    assert_eq!(workspace.job_status("restore-first"), "conflict");
    workspace.reconcile().await;
    assert!(workspace.recorded("VALUE=edited\n").await);
    workspace.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_queued_delete_keeps_an_edit_made_while_closed() {
    let mut workspace = Workspace::open_new("delete").await;
    workspace.write("VALUE=first\n", "first").await;
    workspace.reopen().await;
    assert_eq!(workspace.env().as_deref(), Some("VALUE=first\n"));
    workspace
        .secrets(
            "secrets.delete",
            json!({
                "versionId": "main",
                "path": ".env",
                "origin": "api",
                "momentId": "delete",
            }),
        )
        .await;
    workspace.close().await;
    std::fs::write(workspace.scratch.path().join(".env"), "VALUE=edited\n").expect("edit");

    workspace.open().await;

    assert_eq!(workspace.env().as_deref(), Some("VALUE=edited\n"));
    workspace.assert_no_conflict_sibling();
    assert_eq!(workspace.job_status("delete"), "conflict");
    workspace.reconcile().await;
    assert!(workspace.recorded("VALUE=edited\n").await);
    workspace.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_queued_write_keeps_a_file_created_while_closed() {
    let mut workspace = Workspace::open_new("create").await;
    workspace.write("VALUE=queued\n", "queued").await;
    workspace.close().await;
    assert_eq!(workspace.env(), None);
    std::fs::write(workspace.scratch.path().join(".env"), "VALUE=created\n").expect("create");

    workspace.open().await;

    assert_eq!(workspace.env().as_deref(), Some("VALUE=created\n"));
    workspace.assert_no_conflict_sibling();
    assert_eq!(workspace.job_status("queued"), "conflict");
    workspace.reconcile().await;
    assert!(workspace.recorded("VALUE=created\n").await);
    workspace.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn queued_writes_land_the_newest_text_on_reopen() {
    let mut workspace = Workspace::open_new("writes").await;
    workspace.write("VALUE=first\n", "first").await;
    workspace.write("VALUE=second\n", "second").await;
    workspace.write("VALUE=third\n", "third").await;
    workspace.close().await;
    assert_eq!(workspace.env(), None);

    workspace.open().await;

    assert_eq!(workspace.env().as_deref(), Some("VALUE=third\n"));
    workspace.assert_no_conflict_sibling();
    for moment_id in ["first", "second", "third"] {
        assert_eq!(workspace.job_status(moment_id), "complete", "{moment_id}");
    }
    workspace.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_queued_write_then_delete_leaves_no_file_on_reopen() {
    let mut workspace = Workspace::open_new("write-delete").await;
    workspace.write("VALUE=first\n", "first").await;
    workspace.delete("delete").await;
    workspace.close().await;

    workspace.open().await;

    assert_eq!(workspace.env(), None);
    workspace.assert_no_conflict_sibling();
    assert_eq!(workspace.job_status("first"), "complete");
    assert_eq!(workspace.job_status("delete"), "complete");
    workspace.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_restore_after_a_pending_write_lands_on_reopen() {
    let mut workspace = Workspace::open_new("write-restore").await;
    workspace.write("VALUE=first\n", "first").await;
    workspace.reopen().await;
    workspace.write("VALUE=second\n", "second").await;
    workspace
        .secrets(
            "secrets.restore",
            json!({
                "path": ".env",
                "beforeMomentId": "second",
                "momentId": "restore-first",
                "origin": "api",
            }),
        )
        .await;
    workspace.close().await;

    workspace.open().await;

    assert_eq!(workspace.env().as_deref(), Some("VALUE=first\n"));
    workspace.assert_no_conflict_sibling();
    assert_eq!(workspace.job_status("second"), "complete");
    assert_eq!(workspace.job_status("restore-first"), "complete");
    workspace.close().await;
}

async fn a_write_over_an_unreadable_file_records_nothing(name: &str, contents: Vec<u8>) {
    let mut workspace = Workspace::open_new(name).await;
    std::fs::write(workspace.scratch.path().join(".env"), &contents).expect("place file");

    let error = workspace
        .secrets_error(
            "secrets.write",
            json!({
                "versionId": "main",
                "path": ".env",
                "text": "VALUE=new\n",
                "origin": "api",
                "momentId": "new",
            }),
        )
        .await;

    assert!(error.contains("invalid-path"), "{error}");
    assert_eq!(workspace.secret_rows(), 0);
    assert!(!workspace.has_key());
    assert_eq!(
        std::fs::read(workspace.scratch.path().join(".env")).expect("file"),
        contents
    );
    workspace.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_write_over_a_non_text_file_records_nothing() {
    a_write_over_an_unreadable_file_records_nothing("non-text", vec![0xff, 0xfe, b'\n']).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_write_over_an_oversized_file_records_nothing() {
    a_write_over_an_unreadable_file_records_nothing(
        "oversized",
        vec![b'a'; dohc_engine_files::MAX_CAPTURE_TEXT_BYTES as usize + 1],
    )
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_version_fence_keeps_an_edit_over_a_queued_write() {
    let mut workspace = Workspace::open_new("fence").await;
    workspace.write("VALUE=queued\n", "queued").await;
    std::fs::write(workspace.scratch.path().join(".env"), "VALUE=edited\n").expect("edit");

    let id = workspace.id.clone();
    workspace
        .call(
            "versions.createNamed",
            json!({ "workspaceId": id, "name": "Draft", "fromVersionId": "main" }),
        )
        .await;

    assert_eq!(workspace.env().as_deref(), Some("VALUE=edited\n"));
    workspace.assert_no_conflict_sibling();
    assert_eq!(workspace.job_status("queued"), "conflict");
    assert!(workspace.recorded("VALUE=edited\n").await);
    workspace.close().await;
}
