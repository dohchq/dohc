mod common;

use base64::Engine as _;
use common::*;
use dohc_engine_collab::Ydoc;
use dohc_engine_domain::{
    DomainError, RenameTextFile, VersionedTextStore, WriteText, rename_text_in_tx, write_text_in_tx,
};
use dohc_engine_protocol::{
    error::ErrorCode,
    transport::{InProcessTransport, RequestContext},
    wire::WorkspaceHandle,
};
use dohc_engine_storage::{EngineStore, NoFaults};
use dohc_engine_testkit::{ScratchDir, engine_db_path};
use dohc_workspace_engine::{EngineService, root_binding::write_root_binding};
use serde_json::json;
use std::{sync::Arc, time::Instant};

const WS: &str = "history-round2";
const OP: &str = "dohc-operation:folder-move";

async fn fixture(
    n: usize,
    separate: bool,
) -> (
    ScratchDir,
    InProcessTransport<EngineService>,
    WorkspaceHandle,
) {
    let scratch = ScratchDir::new().unwrap();
    write_root_binding(scratch.path(), TOKEN).unwrap();
    let mut store = EngineStore::open(&engine_db_path(&scratch).unwrap(), 1).unwrap();
    store.bind_root_token(TOKEN, &NoFaults).unwrap();
    VersionedTextStore::new(&mut store)
        .ensure_main_version(WS, "main", 1, &NoFaults)
        .unwrap();
    store
        .write_with(&NoFaults, |tx| -> Result<(), DomainError> {
            for i in 0..n {
                let name = format!("{i:05}-{}.md", "long-path".repeat(8));
                let old = format!("old/{name}");
                let new = format!("moved/{name}");
                write_text_in_tx(
                    tx,
                    &WriteText {
                        workspace_id: WS.into(),
                        version_id: "main".into(),
                        object_id: format!("object-{i}"),
                        path: old.clone(),
                        text: format!("Content {i}"),
                        moment_id: format!("seed-{i}"),
                        request_id: None,
                        metadata_origin: "api".into(),
                        metadata_summary: None,
                        metadata_correlation_id: None,
                        author_json: None,
                        now_ms: 2,
                    },
                )?;
                rename_text_in_tx(
                    tx,
                    &RenameTextFile {
                        workspace_id: WS.into(),
                        version_id: "main".into(),
                        from_path: old,
                        to_path: new.clone(),
                        moment_id: format!("move-{i}"),
                        request_id: None,
                        metadata_origin: "api".into(),
                        metadata_summary: None,
                        metadata_correlation_id: Some(if separate {
                            format!("dohc-operation:move-{i}")
                        } else {
                            OP.into()
                        }),
                        author_json: None,
                        now_ms: 3,
                    },
                    |_, _| Ok(()),
                )?;
                write_file(scratch.path(), &new, format!("Content {i}").as_bytes());
            }
            Ok(())
        })
        .unwrap();
    store
        .write_with(&NoFaults, |tx| {
            dohc_engine_runtime::search::ensure_search_index_for_version(
                tx,
                scratch.path(),
                WS,
                "main",
                4,
                &NoFaults,
            )
        })
        .unwrap();
    assert_eq!(
        store
            .read_with(|conn| conn.query_row(
                "SELECT COUNT(*) FROM engine_search_files_fts",
                [],
                |r| r.get::<_, i64>(0)
            ))
            .unwrap(),
        n as i64
    );
    drop(store);
    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let response = call_with_busy_retry(
        &transport,
        RequestContext::unbounded(),
        request(
            1,
            "workspace.open",
            None,
            json!({"rootDir":scratch.path().to_string_lossy(),"workspaceId":WS}),
        ),
    )
    .await
    .unwrap();
    let handle = serde_json::from_value(response.result["workspace"].clone()).unwrap();
    reconcile_until_settled(&transport, &handle, 10).await;
    (scratch, transport, handle)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "release RPC measurement run separately under the host build budget"]
async fn history_operation_release_budget_one_in_5000() {
    let (scratch, transport, handle) = fixture(5000, true).await;
    let mut samples = Vec::new();
    for i in 0..20 {
        let operation = format!("dohc-operation:move-{i}");
        let start = Instant::now();
        let result = call_keyed(
            &transport,
            &handle,
            100 + i,
            "history.undo",
            &format!("undo-{i}"),
            json!({"operationId":operation}),
        )
        .await;
        samples.push(start.elapsed().as_secs_f64() * 1000.0);
        assert_eq!(result["momentCount"], 1);
        assert_eq!(result["materialized"], false);
        wait_for_undo_placement(&transport, &handle, &operation, &format!("undo-{i}")).await;
        let name = format!("{i:05}-{}.md", "long-path".repeat(8));
        assert_eq!(
            std::fs::read_to_string(scratch.path().join(format!("old/{name}"))).unwrap(),
            format!("Content {i}")
        );
    }
    println!(
        "ONE_IN_5000_SAMPLES {}",
        serde_json::to_string(&samples).unwrap()
    );
    samples.sort_by(f64::total_cmp);
    println!(
        "ONE_IN_5000 p50_ms={:.3} p95_ms={:.3}",
        samples[9], samples[18]
    );
    call(&transport, &handle, 200, "workspace.close", json!({})).await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "release RPC phase measurement run separately under the host build budget"]
async fn history_operation_release_folder_5000() {
    let (scratch, transport, handle) = fixture(5000, false).await;
    let start = Instant::now();
    let result = call_keyed(
        &transport,
        &handle,
        100,
        "history.undo",
        "undo",
        json!({"operationId":OP}),
    )
    .await;
    println!(
        "FOLDER_5000_RPC ms={:.3}",
        start.elapsed().as_secs_f64() * 1000.0
    );
    assert_eq!(result["momentCount"], 5000);
    assert_eq!(result["materialized"], false);
    wait_for_undo_placement(&transport, &handle, OP, "undo").await;
    for i in 0..5000 {
        let name = format!("{i:05}-{}.md", "long-path".repeat(8));
        assert_eq!(
            std::fs::read_to_string(scratch.path().join(format!("old/{name}"))).unwrap(),
            format!("Content {i}")
        );
    }
    call(&transport, &handle, 200, "workspace.close", json!({})).await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn history_operation_leaves_unrelated_session_and_disk_edit_alone() {
    let (scratch, transport, handle) = fixture(2, true).await;
    let unrelated = format!("moved/{:05}-{}.md", 1, "long-path".repeat(8));
    let session=call(&transport,&handle,20,"ydoc.open",json!({"versionId":"main","path":"live.txt","contentKind":"plaintext","seedFromArtifact":false})).await;
    std::fs::write(scratch.path().join(&unrelated), "Unrelated outside edit").unwrap();
    let result = call_keyed(
        &transport,
        &handle,
        21,
        "history.undo",
        "undo",
        json!({"operationId":"dohc-operation:move-0"}),
    )
    .await;
    assert_eq!(result["materialized"], false);
    wait_for_undo_placement(&transport, &handle, "dohc-operation:move-0", "undo").await;
    let doc = Ydoc::wire();
    let update =
        base64::engine::general_purpose::STANDARD.encode(doc.plaintext_insert(0, "Still open"));
    let response = call_with_busy_retry(&transport,
            RequestContext::unbounded(),
            request(
                22,
                "ydoc.recordUpdate",
                Some(handle.clone()),
                json!({ "expectedLineageClaimId": session["lineageClaimId"], "sessionId":session["sessionId"],"updateBase64":update}),
            ),
        )
        .await;
    assert!(
        response.is_ok(),
        "Undo must leave unrelated live sessions open"
    );
    let target = format!("old/{:05}-{}.md", 1, "long-path".repeat(8));
    let target_session = call(
        &transport,
        &handle,
        23,
        "ydoc.open",
        json!({
            "versionId":"main","path":target,"contentKind":"plaintext","seedFromArtifact":false
        }),
    )
    .await;
    let target_doc = Ydoc::wire();
    let target_update = base64::engine::general_purpose::STANDARD
        .encode(target_doc.plaintext_insert(0, "Unsaved target"));
    call(
        &transport,
        &handle,
        24,
        "ydoc.recordUpdate",
        json!({ "expectedLineageClaimId": target_session["lineageClaimId"], "sessionId":target_session["sessionId"],"updateBase64":target_update}),
    )
    .await;
    let refusal = call_with_busy_retry(
        &transport,
        RequestContext::unbounded(),
        keyed_request(
            25,
            "history.undo",
            Some(handle.clone()),
            "undo-target",
            json!({"operationId":"dohc-operation:move-1"}),
        ),
    )
    .await;
    assert!(
        refusal.is_err(),
        "a live restoration endpoint must settle before Undo preflight"
    );
    let retired_session = call_with_busy_retry(&transport,
            RequestContext::unbounded(),
            request(
                26,
                "ydoc.recordUpdate",
                Some(handle.clone()),
                json!({ "expectedLineageClaimId": target_session["lineageClaimId"], "sessionId":target_session["sessionId"],"updateBase64":target_update}),
            ),
        )
        .await;
    let retired_session =
        retired_session.expect_err("the affected endpoint session must be closed");
    assert_eq!(retired_session.code, ErrorCode::InvalidParams);
    assert_eq!(retired_session.message, "ydoc-session-not-found");
    assert_eq!(
        std::fs::read_to_string(scratch.path().join(target)).unwrap(),
        "Unsaved target"
    );
    assert_eq!(
        std::fs::read_to_string(scratch.path().join(unrelated)).unwrap(),
        "Unrelated outside edit"
    );
    call(&transport, &handle, 27, "workspace.close", json!({})).await;
}
