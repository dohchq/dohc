mod common;

use common::*;
use dohc_engine_protocol::{
    transport::{InProcessTransport, RequestContext},
    wire::WorkspaceHandle,
};
use dohc_engine_testkit::ScratchDir;
use dohc_workspace_engine::{EngineService, root_binding::write_root_binding};
use serde_json::{Value, json};
use std::sync::Arc;

async fn open(scratch: &ScratchDir) -> (InProcessTransport<EngineService>, WorkspaceHandle) {
    write_root_binding(scratch.path(), TOKEN).expect("root binding");
    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let opened = call_with_busy_retry(
        &transport,
        RequestContext::unbounded(),
        request(
            1,
            "workspace.open",
            None,
            json!({"rootDir": scratch.path().to_string_lossy(), "workspaceId": "history-object"}),
        ),
    )
    .await
    .expect("open");
    let handle = serde_json::from_value(opened.result["workspace"].clone()).expect("handle");
    (transport, handle)
}

async fn seed(
    transport: &InProcessTransport<EngineService>,
    handle: &WorkspaceHandle,
    index: u64,
    at: i64,
) {
    call(transport, handle, 100+index, "versionedText.write", json!({"versionId":"main","path":format!("{index}.md"),"text":"body must stay out of pages","origin":"api","momentId":format!("text-{index}"),"nowMs":at})).await;
}
async fn page(
    transport: &InProcessTransport<EngineService>,
    handle: &WorkspaceHandle,
    cursor: Option<Value>,
    limit: usize,
) -> Value {
    let mut params = json!({"workspaceId":"history-object","limit":limit});
    if let Some(cursor) = cursor {
        params["cursor"] = cursor;
    }
    call(transport, handle, 1000, "history.page", params).await
}
async fn collect(
    transport: &InProcessTransport<EngineService>,
    handle: &WorkspaceHandle,
    first: Value,
    limit: usize,
) -> (Vec<String>, Vec<String>, Vec<String>) {
    let mut page = first;
    let (mut text, mut protected, mut markers) = (Vec::new(), Vec::new(), Vec::new());
    for _ in 0..1000 {
        for m in page["moments"].as_array().unwrap() {
            assert!(
                m.get("afterText").is_none()
                    && m.get("beforeText").is_none()
                    && m.get("afterBlobSha256").is_none()
            );
            text.push(m["momentId"].as_str().unwrap().to_owned());
        }
        for m in page["protectedMoments"].as_array().unwrap() {
            protected.push(m["id"].as_str().unwrap().to_owned());
        }
        for v in page["versionMarkers"].as_array().unwrap() {
            markers.push(v["id"].as_str().unwrap().to_owned());
        }
        if page["nextCursor"].is_null() {
            return (text, protected, markers);
        }
        let cursor = page["nextCursor"].clone();
        page = self::page(transport, handle, Some(cursor), limit).await;
    }
    panic!("history failed to progress");
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fenced_pages_do_not_repeat_or_skip_under_concurrent_writes_and_tip_rollback() {
    let scratch = ScratchDir::new().unwrap();
    let (transport, handle) = open(&scratch).await;
    for i in 0..8 {
        seed(&transport, &handle, i, 100 + i as i64 / 2).await;
    }
    let first = page(&transport, &handle, None, 1).await;
    assert_eq!(first["moments"][0]["momentId"], "text-7");
    let fence = first["startCursor"]["textFence"].clone();
    // The position stays literal even after its row is removed.
    call(
        &transport,
        &handle,
        50,
        "versionedText.rollback",
        json!({"versionId":"main","path":"7.md","mutationMomentId":"text-7","origin":"restore"}),
    )
    .await;
    tokio::join!(
        seed(&transport, &handle, 20, 10000),
        seed(&transport, &handle, 21, 99)
    );
    let (text, _, _) = collect(&transport, &handle, first, 1).await;
    assert_eq!(
        text,
        vec![
            "text-7", "text-6", "text-5", "text-4", "text-3", "text-2", "text-1", "text-0"
        ]
    );
    let refreshed = page(&transport, &handle, None, 50).await;
    assert!(refreshed["startCursor"]["textFence"].as_i64().unwrap() > fence.as_i64().unwrap());
    let refreshed = collect(&transport, &handle, refreshed, 50).await.0;
    assert!(refreshed.contains(&"text-20".into()) && refreshed.contains(&"text-21".into()));
    assert!(!refreshed.contains(&"text-7".into()));
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn protected_positions_progress_independently_and_markers_are_workspace_only() {
    let scratch = ScratchDir::new().unwrap();
    let (transport, handle) = open(&scratch).await;
    seed(&transport, &handle, 0, i64::MAX - 1).await;
    for i in 0..5 {
        call(&transport,&handle,10+i,"secrets.write",json!({"workspaceId":"history-object","versionId":"main","path":".env","text":format!("KEY={i}"),"origin":"api","momentId":format!("protected-{i}")})).await;
    }
    let version = call(
        &transport,
        &handle,
        30,
        "versions.createNamed",
        json!({"workspaceId":"history-object","name":"Draft","fromVersionId":"main"}),
    )
    .await;
    let first = page(&transport, &handle, None, 1).await;
    assert!(first["nextCursor"]["text"].is_object());
    assert!(first["nextCursor"]["protected"].is_null());
    let second = page(&transport, &handle, Some(first["nextCursor"].clone()), 1).await;
    assert_eq!(second["nextCursor"]["text"], first["nextCursor"]["text"]);
    let (texts, protected, markers) = collect(&transport, &handle, first, 1).await;
    assert_eq!(texts, vec!["text-0"]);
    assert_eq!(protected.len(), 5);
    assert_eq!(
        protected
            .iter()
            .collect::<std::collections::BTreeSet<_>>()
            .len(),
        5
    );
    assert_eq!(markers.len(), 2);
    assert!(markers.contains(&version["id"].as_str().unwrap().to_owned()));
    assert!(markers.contains(&"main".into()));
    let object = call(
        &transport,
        &handle,
        40,
        "history.page",
        json!({"workspaceId":"history-object","objectId":"obj_0","limit":1}),
    )
    .await;
    assert_eq!(object["versionMarkers"], json!([]));
    assert_eq!(object["protectedMoments"], json!([]));
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn metadata_byte_cut_advances_only_emitted_rows_without_losing_protected_activity() {
    let scratch = ScratchDir::new().unwrap();
    let (transport, handle) = open(&scratch).await;
    call(
        &transport,
        &handle,
        2,
        "versions.ensureMain",
        json!({"workspaceId":"history-object"}),
    )
    .await;
    for i in 0..20u64 {
        call(&transport,&handle,10+i,"secrets.write",json!({"workspaceId":"history-object","versionId":"main","path":".env","text":format!("KEY={i}"),"origin":"api","momentId":format!("protected-{i}"),"summary":"x".repeat(dohc_engine_domain::MAX_METADATA_FIELD_BYTES)})).await;
    }
    let first = page(&transport, &handle, None, 50).await;
    let count = first["protectedMoments"].as_array().unwrap().len();
    assert!(count > 0 && count < 20);
    assert!(serde_json::to_vec(&first).unwrap().len() <= 256 * 1024);
    assert!(first.get("protectedTruncated").is_none());
    let (_, protected, _) = collect(&transport, &handle, first, 50).await;
    assert_eq!(protected.len(), 20);
    assert_eq!(
        protected
            .iter()
            .collect::<std::collections::BTreeSet<_>>()
            .len(),
        20
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn old_sync_arrival_waits_for_refresh_on_rpc_pages() {
    use dohc_engine_storage::{EngineStore, NoFaults, hex_sha256};
    use dohc_engine_sync::{NoLiveLeases, ReplicationEnvelope, apply_moment_envelope};
    let scratch = ScratchDir::new().unwrap();
    let (transport, handle) = open(&scratch).await;
    for i in 0..4 {
        seed(&transport, &handle, i, 100 + i as i64).await;
    }
    let first = page(&transport, &handle, None, 1).await;
    call(
        &transport,
        &handle,
        50,
        "versionedText.rollback",
        json!({"versionId":"main","path":"3.md","mutationMomentId":"text-3","origin":"restore"}),
    )
    .await;
    let mut store = EngineStore::open(&scratch.path().join(".dohc/engine/engine.db"), 1).unwrap();
    let sha = hex_sha256(b"remote");
    store
        .read_with(|conn| {
            conn.execute(
                "INSERT INTO blobs(sha256,byte_length,text) VALUES(?1,6,'remote')",
                [&sha],
            )
        })
        .unwrap();
    apply_moment_envelope(&mut store,&ReplicationEnvelope {
        workspace_id:"history-object".into(),origin_id:"peer".into(),origin_seq:0,op_kind:"moment.append".into(),recorded_at_ms:50,relay_seq:None,settlement_admission:None,admitted_author_snapshot:None,
        payload:json!({"momentId":"old-import","versionId":"main","objectId":"remote-object","objectCreatedAtMs":1,"path":"remote.md","recordedAtMs":50,"operation":"write","payloadBeforeBlobSha256":null,"payloadBeforePath":null,"payloadAfterBlobSha256":sha,"payloadAfterPath":"remote.md","metadata":{"origin":"sync"},"beforePresent":"absent"}),
    },&NoFaults,&NoLiveLeases,&dohc_engine_collab::live_update_application::ReleasedTails::default()).unwrap();
    drop(store);
    assert_eq!(
        collect(&transport, &handle, first, 1).await.0,
        vec!["text-3", "text-2", "text-1", "text-0"]
    );
    let refreshed = page(&transport, &handle, None, 50).await;
    assert_eq!(
        refreshed["moments"].as_array().unwrap().last().unwrap()["momentId"],
        "old-import"
    );
}
#[test]
fn history_migration_provides_the_time_index() {
    let scratch = ScratchDir::new().unwrap();
    let store = dohc_engine_storage::EngineStore::open(
        &dohc_engine_testkit::engine_db_path(&scratch).unwrap(),
        1,
    )
    .unwrap();
    let plan:String=store.read_with(|conn|conn.query_row("EXPLAIN QUERY PLAN SELECT moment_id FROM moments INDEXED BY idx_moments_history_time WHERE workspace_id='ws' AND version_id='main' AND moment_order<=100 AND (recorded_at_ms,moment_order)<(100,10) ORDER BY recorded_at_ms DESC,moment_order DESC LIMIT 51",[],|r|r.get(3))).unwrap();
    assert!(plan.contains("idx_moments_history_time"), "{plan}");
}

fn insert_markers(scratch: &ScratchDir, markers: &[(&str, i64)]) {
    let conn = rusqlite::Connection::open(scratch.path().join(".dohc/engine/engine.db")).unwrap();
    conn.execute(
        "UPDATE versions SET created_at_ms=1000 WHERE version_id='main'",
        [],
    )
    .unwrap();
    for (id, at) in markers {
        conn.execute("INSERT INTO versions(workspace_id,version_id,kind,name,created_at_ms,fork_version_id) VALUES('history-object',?1,'named',?1,?2,'main')", rusqlite::params![id, at]).unwrap();
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn marker_order_is_newest_first_and_fenced_across_pages() {
    let scratch = ScratchDir::new().unwrap();
    let (transport, handle) = open(&scratch).await;
    call(
        &transport,
        &handle,
        2,
        "versions.ensureMain",
        json!({"workspaceId":"history-object"}),
    )
    .await;
    insert_markers(&scratch, &[("old", 100), ("middle", 200), ("new", 300)]);
    let first = page(&transport, &handle, None, 1).await;
    insert_markers(&scratch, &[("late-middle", 250)]);
    assert_eq!(
        collect(&transport, &handle, first, 1).await.2,
        vec!["main", "new", "middle", "old"]
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn old_dated_version_arriving_mid_chain_waits_for_refresh() {
    let scratch = ScratchDir::new().unwrap();
    let (transport, handle) = open(&scratch).await;
    call(
        &transport,
        &handle,
        2,
        "versions.ensureMain",
        json!({"workspaceId":"history-object"}),
    )
    .await;
    insert_markers(&scratch, &[("before", 300)]);
    let first = page(&transport, &handle, None, 1).await;
    insert_markers(&scratch, &[("old-import", 1)]);
    assert_eq!(
        collect(&transport, &handle, first, 1).await.2,
        vec!["main", "before"]
    );
    let refreshed = page(&transport, &handle, None, 1).await;
    assert_eq!(
        collect(&transport, &handle, refreshed, 1).await.2,
        vec!["main", "before", "old-import"]
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn equal_millisecond_versions_use_id_order_and_an_admission_fence() {
    let scratch = ScratchDir::new().unwrap();
    let (transport, handle) = open(&scratch).await;
    call(
        &transport,
        &handle,
        2,
        "versions.ensureMain",
        json!({"workspaceId":"history-object"}),
    )
    .await;
    insert_markers(&scratch, &[("a", 300), ("z", 300)]);
    let first = page(&transport, &handle, None, 1).await;
    insert_markers(&scratch, &[("y", 300)]);
    assert_eq!(
        collect(&transport, &handle, first, 1).await.2,
        vec!["main", "z", "a"]
    );
    let refreshed = page(&transport, &handle, None, 1).await;
    assert_eq!(
        collect(&transport, &handle, refreshed, 1).await.2,
        vec!["main", "z", "y", "a"]
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn history_rejects_cursors_from_another_workspace_engine_version_or_object() {
    let scratch = ScratchDir::new().unwrap();
    let (transport, handle) = open(&scratch).await;
    seed(&transport, &handle, 0, 100).await;
    let first = page(&transport, &handle, None, 1).await;
    for (field, value) in [
        ("workspaceId", "other-workspace"),
        ("engineUuid", "other-engine"),
        ("versionId", "other-version"),
        ("objectId", "other-object"),
    ] {
        let mut cursor = first["startCursor"].clone();
        cursor[field] = json!(value);
        let error = call_error(
            &transport,
            &handle,
            2000,
            "history.page",
            json!({"workspaceId":"history-object","limit":1,"cursor":cursor}),
        )
        .await;
        assert_eq!(
            error.code,
            dohc_engine_protocol::error::ErrorCode::InvalidParams,
            "{field}: {error:?}"
        );
        assert_eq!(error.message, "invalid-input", "{field}: {error:?}");
    }
}
