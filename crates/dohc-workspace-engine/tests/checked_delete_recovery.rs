mod common;
use common::*;
use dohc_engine_domain::{DeleteTextFile, VersionedTextStore, WriteBinary};
use dohc_engine_protocol::{
    ErrorCode,
    transport::{EngineTransport, InProcessTransport, RequestContext},
    wire::WorkspaceHandle,
};
use dohc_engine_storage::{EngineStore, MaterializationJobSpec, NoFaults, Preimage, hex_sha256};
use dohc_engine_testkit::{ScratchDir, engine_db_path};
use dohc_workspace_engine::{EngineService, root_binding::write_root_binding};
use serde_json::json;
use std::sync::Arc;

#[tokio::test]
async fn checked_delete_legacy_refusal_is_actionable_after_open() {
    legacy_recovery(false).await;
}

#[tokio::test]
async fn checked_delete_legacy_conflict_can_be_retried_after_open() {
    legacy_recovery(true).await;
}

async fn legacy_recovery(conflicted: bool) {
    let scratch = ScratchDir::new().unwrap();
    write_root_binding(scratch.path(), TOKEN).unwrap();
    let mut store = EngineStore::open(&engine_db_path(&scratch).unwrap(), 1).unwrap();
    store.bind_root_token(TOKEN, &NoFaults).unwrap();
    VersionedTextStore::new(&mut store)
        .ensure_main_version("workspace", "main", 1, &NoFaults)
        .unwrap();
    let bytes = b"\0original bytes";
    let expected = hex_sha256(bytes);
    write_file(scratch.path(), "file.bin", bytes);
    VersionedTextStore::new(&mut store)
        .write_binary(
            &WriteBinary {
                workspace_id: "workspace".into(),
                version_id: "main".into(),
                object_id: "document".into(),
                path: "file.bin".into(),
                bytes: bytes.to_vec(),
                moment_id: "create".into(),
                metadata_origin: "user".into(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 2,
                request_id: None,
            },
            &NoFaults,
        )
        .unwrap();
    dohc_engine_sync::adopt_join_identity(
        &mut store,
        "workspace",
        "local",
        "epoch",
        "stream",
        3,
        &NoFaults,
    )
    .unwrap();
    store
        .write_with(&NoFaults, |tx| {
            tx.execute("DELETE FROM materialization_jobs", []).unwrap();
            let result = dohc_engine_domain::prepare_checked_delete_in_tx(
                tx,
                &DeleteTextFile {
                    workspace_id: "workspace".into(),
                    version_id: "main".into(),
                    path: "file.bin".into(),
                    moment_id: "delete".into(),
                    request_id: Some("delete-request".into()),
                    metadata_origin: "restore".into(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: None,
                    now_ms: 4,
                },
                Some("document"),
                &expected,
            )
            .unwrap();
            // An older build exported this preparation without checking the job marker.
            dohc_engine_sync::journal_moment_append_in_tx(tx, "workspace", "delete").unwrap();
            dohc_engine_storage::enqueue_delete_job(
                tx,
                &MaterializationJobSpec {
                    job_id: "restore-delete-mat_delete".into(),
                    workspace_id: "workspace".into(),
                    target_path: "file.bin".into(),
                    content_sha256: expected.clone(),
                    preimage: Preimage::Present(expected.clone()),
                    target_generation: result.moment.moment_order,
                    now_ms: 4,
                },
            )
        })
        .unwrap();
    if conflicted {
        store
            .mark_materialization_conflict("restore-delete-mat_delete", 5)
            .unwrap();
    }
    drop(store);
    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let opened = transport.call(RequestContext::unbounded(), request(1, "workspace.open", None,
        json!({"rootDir": scratch.path().to_string_lossy(), "workspaceId": "workspace", "captureMode": "none"}))).await.unwrap();
    let handle: WorkspaceHandle =
        serde_json::from_value(opened.result["workspace"].clone()).unwrap();
    let pending = call(&transport, &handle, 2, "checkedDeletes.list", json!({})).await;
    assert_eq!(
        pending["deletions"][0]["reason"],
        "checked-delete-replication-dependents"
    );
    assert_eq!(pending["deletions"][0]["action"], "finish-delete");
    let error = call_error(
        &transport,
        &handle,
        3,
        "checkedDeletes.resolve",
        json!({"momentId": "delete", "expectedSha256": expected, "action": "retry"}),
    )
    .await;
    assert_eq!(error.code, ErrorCode::Conflict);
    assert_eq!(error.message, "checked-delete-replication-dependents");
    assert!(scratch.join("file.bin").exists());
    write_file(scratch.path(), "file.bin", b"outside edit");
    let changed = call_error(
        &transport,
        &handle,
        30,
        "checkedDeletes.resolve",
        json!({"momentId": "delete", "expectedSha256": expected, "action": "finish-delete"}),
    )
    .await;
    assert_eq!(changed.code, ErrorCode::Conflict);
    assert_eq!(
        std::fs::read(scratch.join("file.bin")).unwrap(),
        b"outside edit"
    );
    write_file(scratch.path(), "file.bin", bytes);

    assert_eq!(
        call(
            &transport,
            &handle,
            4,
            "checkedDeletes.resolve",
            json!({"momentId": "delete", "expectedSha256": expected, "action": "finish-delete"})
        )
        .await["settled"],
        true
    );
    assert!(!scratch.join("file.bin").exists());
    assert_eq!(
        call(&transport, &handle, 5, "checkedDeletes.list", json!({})).await,
        json!({"deletions": []})
    );
    call(&transport, &handle, 6, "workspace.close", json!({})).await;
}
