//! `capture.hold` lets a caller change the disk and record the change under
//! its own author before capture sees it, so History keeps one row per change.

mod common;

use common::*;
use dohc_engine_protocol::{
    transport::{InProcessTransport, RequestContext},
    wire::WorkspaceHandle,
};
use dohc_engine_testkit::ScratchDir;
use dohc_workspace_engine::{EngineService, root_binding::write_root_binding};
use serde_json::{Value, json};
use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

const WORKSPACE_ID: &str = "ws-capture-hold";

async fn open(scratch: &ScratchDir) -> (InProcessTransport<EngineService>, WorkspaceHandle) {
    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let params =
        json!({ "rootDir": scratch.path().to_string_lossy(), "workspaceId": WORKSPACE_ID });
    let opened = call_with_busy_retry(
        &transport,
        RequestContext::unbounded(),
        request(1, "workspace.open", None, params),
    )
    .await
    .expect("open");
    let handle = serde_json::from_value(opened.result["workspace"].clone()).expect("handle");
    let params = json!({ "workspaceId": WORKSPACE_ID });
    call(&transport, &handle, 2, "versions.ensureMain", params).await;
    (transport, handle)
}

async fn moment_rows(
    transport: &InProcessTransport<EngineService>,
    handle: &WorkspaceHandle,
    id: u64,
) -> Vec<Value> {
    let params = json!({ "versionId": "main", "limit": 100 });
    let page = call(transport, handle, id, "moments.list", params).await;
    page["moments"].as_array().expect("moments").clone()
}

fn moment_id(row: &Value) -> String {
    row["momentId"].as_str().expect("moment id").to_owned()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn held_capture_leaves_one_authored_row_per_moved_or_deleted_file() {
    let scratch = ScratchDir::new().expect("scratch");
    write_root_binding(scratch.path(), TOKEN).expect("root binding");
    let root = scratch.path();
    write_file(root, "notes.txt", b"notes");
    write_file(root, "photo.bin", &[0, 1, 2, 3, 255]);
    write_file(root, "docs/a.txt", b"a");
    let (transport, handle) = open(&scratch).await;
    reconcile_until_settled(&transport, &handle, 10).await;
    let seen: HashSet<String> = moment_rows(&transport, &handle, 11)
        .await
        .iter()
        .map(moment_id)
        .collect();
    let author = json!({ "kind": "agent", "agentId": "Test agent", "onBehalfOf": "person-1" });

    let hold = call(&transport, &handle, 12, "capture.hold", json!({})).await["holdId"].clone();
    std::fs::rename(root.join("notes.txt"), root.join("moved.txt")).expect("move text");
    std::fs::rename(root.join("photo.bin"), root.join("photo-moved.bin")).expect("move binary");
    std::fs::create_dir_all(root.join(".dohc/local/trash")).expect("trash");
    std::fs::rename(root.join("docs"), root.join(".dohc/local/trash/docs")).expect("trash folder");
    let moves = [("notes.txt", "moved.txt"), ("photo.bin", "photo-moved.bin")];
    for (id, (from, to)) in (13_u64..).zip(moves) {
        let params = json!({
            "versionId": "main", "fromPath": from, "toPath": to, "origin": "api", "author": author,
            "captureHoldId": hold,
        });
        call(&transport, &handle, id, "versionedText.rename", params).await;
    }
    let params = json!({
        "versionId": "main", "path": "docs/a.txt", "onlyIfAbsentOnDisk": true,
        "origin": "api", "author": author, "captureHoldId": hold,
    });
    call(&transport, &handle, 15, "versionedText.delete", params).await;
    let params = json!({ "holdId": hold });
    let released = call(&transport, &handle, 16, "capture.release", params).await;
    assert_eq!(released["released"], json!(true));
    reconcile_until_settled(&transport, &handle, 17).await;

    let mut changes = Vec::new();
    for row in moment_rows(&transport, &handle, 18).await {
        if seen.contains(&moment_id(&row)) {
            continue;
        }
        assert_eq!(
            row["authors"],
            json!([author]),
            "every new row names the agent: {row}"
        );
        let operation = row["operation"].as_str().expect("operation");
        changes.push(format!(
            "{operation} {}",
            row["path"].as_str().expect("path")
        ));
    }
    changes.sort();
    assert_eq!(
        changes,
        [
            "delete docs/a.txt",
            "rename moved.txt",
            "rename photo-moved.bin"
        ]
    );
    let moved = std::fs::read(root.join("photo-moved.bin")).expect("binary");
    assert_eq!(moved, [0, 1, 2, 3, 255]);
    assert!(!root.join("photo.bin").exists());
    let trashed = std::fs::read(root.join(".dohc/local/trash/docs/a.txt")).expect("trashed");
    assert_eq!(trashed, b"a");

    let params = json!({ "holdId": hold });
    let again = call(&transport, &handle, 19, "capture.release", params).await;
    assert_eq!(again["released"], json!(false));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_hold_keeps_capture_out_until_release_and_a_write_under_an_ended_hold_refuses() {
    let scratch = ScratchDir::new().expect("scratch");
    write_root_binding(scratch.path(), TOKEN).expect("root binding");
    write_file(scratch.path(), "note.txt", b"note");
    let (transport, handle) = open(&scratch).await;
    reconcile_until_settled(&transport, &handle, 10).await;

    let hold = call(&transport, &handle, 11, "capture.hold", json!({})).await["holdId"].clone();
    write_file(scratch.path(), "outside.txt", b"a person's edit");
    // Capture cannot pass while the hold lasts, however long the change runs.
    let flush = call(&transport, &handle, 12, "capture.flush", json!({}));
    assert!(
        tokio::time::timeout(Duration::from_secs(3), flush)
            .await
            .is_err(),
        "capture ran during the hold"
    );
    let params = json!({ "holdId": hold });
    call(&transport, &handle, 13, "capture.release", params).await;

    std::fs::remove_file(scratch.path().join("note.txt")).expect("remove note");
    let params = json!({
        "versionId": "main", "path": "note.txt", "onlyIfAbsentOnDisk": true,
        "origin": "api", "captureHoldId": hold,
    });
    let refused = call_error(&transport, &handle, 14, "versionedText.delete", params).await;
    assert_eq!(refused.message, "capture-hold-ended");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn check_move_refuses_an_author_history_would_refuse_before_anything_changes() {
    let scratch = ScratchDir::new().expect("scratch");
    write_root_binding(scratch.path(), TOKEN).expect("root binding");
    write_file(scratch.path(), "notes.txt", b"notes");
    let (transport, handle) = open(&scratch).await;
    reconcile_until_settled(&transport, &handle, 10).await;

    let oversized = "x".repeat(dohc_engine_domain::MAX_AUTHOR_FIELD_BYTES + 1);
    let invalid = [
        json!({ "kind": "agent", "agentId": "Test\u{0085}agent", "onBehalfOf": "person-1" }),
        json!({ "kind": "agent", "agentId": "Test agent", "onBehalfOf": "person\n1" }),
        json!({ "kind": "agent", "agentId": oversized, "onBehalfOf": "person-1" }),
    ];
    for (id, author) in (11_u64..).zip(invalid) {
        let params = json!({ "versionId": "main", "path": "notes.txt", "author": author });
        let refused = call_error(
            &transport,
            &handle,
            id,
            "versionedText.checkMove",
            params.clone(),
        )
        .await;
        assert_eq!(refused.message, "invalid-metadata", "{params}");
    }
    let author = json!({ "kind": "agent", "agentId": "Test agent", "onBehalfOf": "person-1" });
    let params = json!({ "versionId": "main", "path": "notes.txt", "author": author });
    let allowed = call(&transport, &handle, 14, "versionedText.checkMove", params).await;
    assert_eq!(allowed, json!({ "allowed": true }));
    assert_eq!(
        std::fs::read(scratch.path().join("notes.txt")).expect("notes"),
        b"notes"
    );
}

/// An overwrite that fails puts the staged destination back, then rolls its
/// delete back. The rollback's restore finds the same bytes already there,
/// so the file keeps them and capture finds nothing to record.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_binary_delete_rolled_back_after_its_file_returns_keeps_its_bytes_without_a_row() {
    let scratch = ScratchDir::new().expect("scratch");
    write_root_binding(scratch.path(), TOKEN).expect("root binding");
    let root = scratch.path();
    write_file(root, "photo.bin", &[0, 1, 2, 3, 255]);
    let (transport, handle) = open(&scratch).await;
    reconcile_until_settled(&transport, &handle, 10).await;
    let seen: HashSet<String> = moment_rows(&transport, &handle, 11)
        .await
        .iter()
        .map(moment_id)
        .collect();
    let author = json!({ "kind": "agent", "agentId": "Test agent", "onBehalfOf": "person-1" });

    let hold = call(&transport, &handle, 12, "capture.hold", json!({})).await["holdId"].clone();
    std::fs::create_dir_all(root.join(".dohc/local/trash")).expect("trash");
    std::fs::rename(
        root.join("photo.bin"),
        root.join(".dohc/local/trash/photo.bin"),
    )
    .expect("stage");
    let params = json!({
        "versionId": "main", "path": "photo.bin", "onlyIfAbsentOnDisk": true,
        "origin": "api", "author": author, "captureHoldId": hold,
    });
    let deleted = call(&transport, &handle, 13, "versionedText.delete", params).await;
    std::fs::rename(
        root.join(".dohc/local/trash/photo.bin"),
        root.join("photo.bin"),
    )
    .expect("put back");
    let params = json!({
        "versionId": "main", "path": "photo.bin", "mutationMomentId": deleted["moment"]["momentId"],
        "origin": "api", "author": author,
    });
    call(&transport, &handle, 14, "versionedText.rollback", params).await;
    let params = json!({ "holdId": hold });
    call(&transport, &handle, 15, "capture.release", params).await;
    reconcile_until_settled(&transport, &handle, 16).await;

    assert_eq!(
        std::fs::read(root.join("photo.bin")).expect("photo"),
        [0, 1, 2, 3, 255]
    );
    for row in moment_rows(&transport, &handle, 17).await {
        if !seen.contains(&moment_id(&row)) {
            assert_eq!(
                row["authors"],
                json!([author]),
                "capture recorded a row of its own: {row}"
            );
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_change_made_during_a_hold_is_captured_after_release_and_close_does_not_wait() {
    let scratch = ScratchDir::new().expect("scratch");
    write_root_binding(scratch.path(), TOKEN).expect("root binding");
    let (transport, handle) = open(&scratch).await;
    reconcile_until_settled(&transport, &handle, 10).await;

    let hold = call(&transport, &handle, 11, "capture.hold", json!({})).await["holdId"].clone();
    write_file(scratch.path(), "outside.txt", b"a person's edit");
    let params = json!({ "holdId": hold });
    call(&transport, &handle, 12, "capture.release", params).await;
    reconcile_until_settled(&transport, &handle, 13).await;
    let rows = moment_rows(&transport, &handle, 14).await;
    let outside = rows
        .iter()
        .find(|row| row["path"] == json!("outside.txt"))
        .expect("the outside edit is captured after release");
    assert!(
        outside["authors"].is_null(),
        "an outside edit stays neutral: {outside}"
    );

    call(&transport, &handle, 15, "capture.hold", json!({})).await;
    let close = call(&transport, &handle, 16, "workspace.close", json!({}));
    tokio::time::timeout(Duration::from_secs(15), close)
        .await
        .expect("close does not wait for an unreleased hold");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn history_operation_minted_group_refuses_forged_and_reused_ids() {
    let scratch = ScratchDir::new().unwrap();
    write_root_binding(scratch.path(), TOKEN).unwrap();
    write_file(scratch.path(), "old.md", b"Before.\n");
    let (transport, handle) = open(&scratch).await;
    reconcile_until_settled(&transport, &handle, 100).await;
    let op = "dohc-operation:minted";
    let hold = call(
        &transport,
        &handle,
        101,
        "capture.hold",
        json!({"operationId":op}),
    )
    .await["holdId"]
        .clone();
    std::fs::rename(scratch.path().join("old.md"), scratch.path().join("new.md")).unwrap();
    call_keyed(
        &transport,
        &handle,
        102,
        "versionedText.rename",
        "caller-request",
        json!({"versionId":"main","origin":"api","fromPath":"old.md","toPath":"new.md","captureHoldId":hold}),
    )
    .await;
    call(
        &transport,
        &handle,
        103,
        "capture.release",
        json!({"holdId":hold}),
    )
    .await;
    let forged = call_error(
        &transport,
        &handle,
        104,
        "versionedText.write",
        json!({"versionId":"main","origin":"api","path":"new.md","text":"Forged","correlationId":op}),
    )
    .await;
    assert_eq!(forged.message, "reserved-operation-id");
    let reuse = call_error(
        &transport,
        &handle,
        105,
        "capture.hold",
        json!({"operationId":op}),
    )
    .await;
    assert_eq!(reuse.message, "invalid-input");
    // A caller's request key is permitted but never joins the operation.
    call_keyed(
        &transport,
        &handle,
        106,
        "versionedText.write",
        op,
        json!({"versionId":"main","origin":"api","path":"other.md","text":"Unrelated"}),
    )
    .await;
    let group = call(
        &transport,
        &handle,
        107,
        "history.operations",
        json!({"operationId":op}),
    )
    .await;
    assert_eq!(group["momentCount"], 1, "caller id must not form a group");
    assert!(group.get("moments").is_none());
    let members = call(
        &transport,
        &handle,
        109,
        "history.page",
        json!({"workspaceId":WORKSPACE_ID,"operationId":op}),
    )
    .await;
    assert_eq!(members["moments"][0]["operation"], "rename");
    assert_eq!(members["moments"][0]["beforePath"], "old.md");
    assert!(members["moments"][0].get("beforeText").is_none());
    assert!(members["moments"][0].get("afterText").is_none());
    call(&transport, &handle, 108, "workspace.close", json!({})).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn history_operation_rpc_fence_reconciles_typing_and_uses_envelope_key() {
    let scratch = ScratchDir::new().unwrap();
    write_root_binding(scratch.path(), TOKEN).unwrap();
    write_file(scratch.path(), "old.md", b"Before.\n");
    let (transport, handle) = open(&scratch).await;
    reconcile_until_settled(&transport, &handle, 100).await;
    let op = "dohc-operation:rename";
    let hold = call(
        &transport,
        &handle,
        101,
        "capture.hold",
        json!({"operationId":op}),
    )
    .await["holdId"]
        .clone();
    std::fs::rename(scratch.path().join("old.md"), scratch.path().join("new.md")).unwrap();
    call_keyed(
        &transport,
        &handle,
        102,
        "versionedText.rename",
        "rename",
        json!({"versionId":"main","origin":"api","fromPath":"old.md","toPath":"new.md","captureHoldId":hold}),
    )
    .await;
    call(
        &transport,
        &handle,
        103,
        "capture.release",
        json!({"holdId":hold}),
    )
    .await;
    write_file(scratch.path(), "new.md", b"Later typing.\n");
    assert!(
        call_error(
            &transport,
            &handle,
            104,
            "history.undo",
            json!({"operationId":op})
        )
        .await
        .message
        .contains("idempotency")
    );
    let result = call_keyed(
        &transport,
        &handle,
        105,
        "history.undo",
        "undo",
        json!({"operationId":op}),
    )
    .await;
    assert_eq!(result["materialized"], false);
    wait_for_undo_placement(&transport, &handle, op, "undo").await;
    assert_eq!(result["deduped"], false);
    assert_eq!(
        std::fs::read_to_string(scratch.path().join("old.md")).unwrap(),
        "Later typing.\n"
    );
    assert!(!scratch.path().join("new.md").exists());
    let replay = call_keyed(
        &transport,
        &handle,
        106,
        "history.undo",
        "undo",
        json!({"operationId":op}),
    )
    .await;
    assert_eq!(replay["deduped"], true);
    assert_eq!(replay["momentCount"], result["momentCount"]);
    assert_eq!(
        replay["compensationOperationId"],
        result["compensationOperationId"]
    );
    call(&transport, &handle, 107, "workspace.close", json!({})).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn undo_after_outside_write_at_old_path_refuses_without_stalling_capture() {
    let scratch = ScratchDir::new().unwrap();
    write_root_binding(scratch.path(), TOKEN).unwrap();
    write_file(scratch.path(), "old.md", b"Moved content.\n");
    let (transport, handle) = open(&scratch).await;
    reconcile_until_settled(&transport, &handle, 100).await;
    let operation = "dohc-operation:outside-write";
    let hold = call(
        &transport,
        &handle,
        101,
        "capture.hold",
        json!({"operationId":operation}),
    )
    .await["holdId"]
        .clone();
    std::fs::rename(scratch.path().join("old.md"), scratch.path().join("new.md")).unwrap();
    call_keyed(
        &transport,
        &handle,
        102,
        "versionedText.rename",
        "rename",
        json!({"versionId":"main","origin":"api","fromPath":"old.md","toPath":"new.md","captureHoldId":hold}),
    )
    .await;
    call(
        &transport,
        &handle,
        103,
        "capture.release",
        json!({"holdId":hold}),
    )
    .await;
    write_file(scratch.path(), "old.md", b"Outside content KEEP.\n");

    // Desktop Undo reads the operation's History page before attempting Undo.
    let started = std::time::Instant::now();
    let page = call(
        &transport,
        &handle,
        104,
        "history.page",
        json!({"workspaceId":WORKSPACE_ID,"operationId":operation}),
    )
    .await;
    println!("History page after outside write: {:?}", started.elapsed());
    assert_eq!(page["moments"].as_array().unwrap().len(), 1);
    let started = std::time::Instant::now();
    let refusal = call_with_busy_retry(
        &transport,
        RequestContext::unbounded(),
        keyed_request(
            105,
            "history.undo",
            Some(handle.clone()),
            "undo-outside-write",
            json!({"operationId":operation}),
        ),
    )
    .await
    .expect_err("the outside file occupies the old path");
    println!(
        "Undo after outside write: {:?} {refusal:?}",
        started.elapsed()
    );
    assert!(refusal.message.contains("old path occupied"), "{refusal:?}");
    assert_eq!(
        std::fs::read_to_string(scratch.path().join("old.md")).unwrap(),
        "Outside content KEEP.\n"
    );
    assert_eq!(
        std::fs::read_to_string(scratch.path().join("new.md")).unwrap(),
        "Moved content.\n"
    );
    call(&transport, &handle, 106, "workspace.close", json!({})).await;
}
