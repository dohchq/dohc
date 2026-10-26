mod common;

use base64::Engine as _;
use common::*;
use dohc_engine_collab::Ydoc;
use dohc_engine_domain::{
    DomainError, RenameTextFile, VersionedTextStore, WriteText, rename_text_in_tx, write_text_in_tx,
};
use dohc_engine_protocol::{
    transport::{InProcessTransport, RequestContext},
    wire::WorkspaceHandle,
};
use dohc_engine_storage::{EngineStore, NoFaults};
use dohc_engine_testkit::{ScratchDir, engine_db_path};
use dohc_workspace_engine::{EngineService, root_binding::write_root_binding};
use serde_json::{Value, json};
use std::{collections::HashSet, sync::Arc, time::Instant};

const WS: &str = "history-round2";
const OP: &str = "dohc-operation:folder-move";

async fn fixture(
    n: usize,
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
                        metadata_correlation_id: Some(OP.into()),
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
async fn history_operation_large_summary_is_bounded() {
    let (_scratch, transport, handle) = fixture(5000).await;
    let result = call(
        &transport,
        &handle,
        20,
        "history.operations",
        json!({"operationId":OP}),
    )
    .await;
    let bytes = serde_json::to_vec(&result).unwrap().len();
    println!("5000-member operation summary: {bytes} bytes");
    assert!(
        bytes < 16 * 1024,
        "operation summary must not grow with group size"
    );
    assert_eq!(result["momentCount"], 5000);
    assert!(result.get("moments").is_none());
    call(&transport, &handle, 21, "workspace.close", json!({})).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn history_operation_large_undo_rpc_is_bounded_and_paged() {
    undo_rpc_proof(128).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "5000-member end-to-end measurement runs separately under the build budget"]
async fn history_operation_5000_member_undo_rpc_budget() {
    undo_rpc_proof(5000).await;
}

async fn undo_rpc_proof(n: usize) {
    let (scratch, transport, handle) = fixture(n).await;
    let start = Instant::now();
    let result = call_keyed(
        &transport,
        &handle,
        20,
        "history.undo",
        "undo",
        json!({"operationId":OP}),
    )
    .await;
    println!(
        "{n}-member Undo RPC request-to-result: {:.3} ms",
        start.elapsed().as_secs_f64() * 1000.0
    );
    let bytes = serde_json::to_vec(&result).unwrap().len();
    println!("{n}-member Undo summary: {bytes} bytes");
    assert!(bytes < 16 * 1024, "committed Undo response must be bounded");
    assert_eq!(result["momentCount"], n);
    assert_eq!(result["materialized"], false);
    wait_for_undo_placement(&transport, &handle, OP, "undo").await;
    assert!(result.get("moments").is_none());
    let compensation = result["compensationOperationId"].as_str().unwrap();
    let refused = call_with_busy_retry(
        &transport,
        RequestContext::unbounded(),
        keyed_request(
            24,
            "history.undo",
            Some(handle.clone()),
            "undo-the-undo",
            json!({"operationId":compensation}),
        ),
    )
    .await
    .unwrap_err();
    assert_eq!(refused.message, "invalid-input");

    let mut cursor: Option<Value> = None;
    let mut seen = HashSet::new();
    loop {
        let mut params = json!({"workspaceId":WS,"operationId":compensation,"limit":50});
        if let Some(c) = cursor {
            params["cursor"] = c;
        }
        let page = call(&transport, &handle, 21, "history.page", params).await;
        assert!(serde_json::to_vec(&page).unwrap().len() < 300 * 1024);
        assert!(page["protectedMoments"].as_array().unwrap().is_empty());
        assert!(page["versionMarkers"].as_array().unwrap().is_empty());
        for m in page["moments"].as_array().unwrap() {
            assert_eq!(m["metadataCorrelationId"], compensation);
            assert!(m["beforePath"].as_str().unwrap().starts_with("moved/"));
            assert!(scratch.path().join(m["path"].as_str().unwrap()).is_file());
            assert!(seen.insert(m["momentId"].as_str().unwrap().to_owned()));
        }
        if seen.len() == page["moments"].as_array().unwrap().len() && !page["nextCursor"].is_null()
        {
            let error = call_error(
                &transport,
                &handle,
                25,
                "history.page",
                json!({"workspaceId":WS,"operationId":OP,"cursor":page["nextCursor"]}),
            )
            .await;
            assert_eq!(error.message, "invalid-input");
        }
        cursor = page.get("nextCursor").filter(|c| !c.is_null()).cloned();
        if cursor.is_none() {
            break;
        }
    }
    assert_eq!(seen.len(), n);
    assert!(scratch.path().join("moved").is_dir());
    assert_eq!(
        std::fs::read_dir(scratch.path().join("moved"))
            .unwrap()
            .count(),
        0,
        "PR6 owns empty directory cleanup"
    );
    let replay = call_keyed(
        &transport,
        &handle,
        22,
        "history.undo",
        "undo",
        json!({"operationId":OP}),
    )
    .await;
    assert_eq!(replay["deduped"], true);
    assert_eq!(replay["compensationOperationId"], compensation);
    assert_eq!(replay["momentCount"], n);
    call(&transport, &handle, 23, "workspace.close", json!({})).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn history_operation_unknown_id_leaves_live_session_open() {
    let (_scratch, transport, handle) = fixture(1).await;
    let session = call(&transport,&handle,20,"ydoc.open",
        json!({"versionId":"main","path":"live.txt","contentKind":"plaintext","seedFromArtifact":false})).await;
    let error = call_with_busy_retry(
        &transport,
        RequestContext::unbounded(),
        keyed_request(
            21,
            "history.undo",
            Some(handle.clone()),
            "unknown",
            json!({"operationId":"dohc-operation:unknown"}),
        ),
    )
    .await
    .unwrap_err();
    assert!(error.message.contains("operation unavailable"));
    let doc = Ydoc::wire();
    let update =
        base64::engine::general_purpose::STANDARD.encode(doc.plaintext_insert(0, "Still open"));
    call(
        &transport,
        &handle,
        22,
        "ydoc.recordUpdate",
        json!({ "expectedLineageClaimId": session["lineageClaimId"], "sessionId":session["sessionId"],"updateBase64":update}),
    )
    .await;
    call(&transport, &handle, 23, "workspace.close", json!({})).await;
}
