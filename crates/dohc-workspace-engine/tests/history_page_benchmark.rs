mod common;
use common::*;
use dohc_engine_protocol::{
    transport::{InProcessTransport, RequestContext},
    wire::WorkspaceHandle,
};
use dohc_engine_storage::{EngineStore, NoFaults, hex_sha256};
use dohc_engine_sync::{NoLiveLeases, ReplicationEnvelope, apply_moment_envelope};
use dohc_engine_testkit::ScratchDir;
use dohc_workspace_engine::{EngineService, root_binding::write_root_binding};
use serde_json::{Value, json};
use std::{sync::Arc, time::Instant};

async fn open(
    transport: &InProcessTransport<EngineService>,
    scratch: &ScratchDir,
    id: u64,
    capture: bool,
) -> WorkspaceHandle {
    let mut params =
        json!({"rootDir":scratch.path().to_string_lossy(),"workspaceId":"history-benchmark"});
    if !capture {
        params["captureMode"] = json!("none");
    }
    let result = call_with_busy_retry(
        transport,
        RequestContext::unbounded(),
        request(id, "workspace.open", None, params),
    )
    .await
    .expect("open");
    serde_json::from_value(result.result["workspace"].clone()).unwrap()
}
fn stats(mut values: Vec<f64>) -> Value {
    values.sort_by(f64::total_cmp);
    json!({"p50Ms":values[values.len()/2],"p95Ms":values[(values.len()*95/100).min(values.len()-1)],"samples":values.len()})
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "manual benchmark; see tools/perf-profiling/README.md"]
async fn history_page_benchmark() {
    let entries = std::env::var("HISTORY_BENCH_ENTRIES")
        .unwrap_or_else(|_| "100000".into())
        .parse::<i64>()
        .unwrap();
    let mode = std::env::var("HISTORY_BENCH_MODE").unwrap_or_else(|_| "candidate".into());
    assert!(entries >= 100);
    assert!(matches!(mode.as_str(), "baseline" | "candidate"));
    let scratch = ScratchDir::new().expect("scratch");
    write_root_binding(scratch.path(), TOKEN).unwrap();
    write_file(scratch.path(), "bench.md", b"benchmark body");
    write_file(scratch.path(), "sparse.md", b"third");
    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let handle = open(&transport, &scratch, 1, false).await;
    call(
        &transport,
        &handle,
        2,
        "versions.ensureMain",
        json!({"workspaceId":"history-benchmark"}),
    )
    .await;
    call(&transport,&handle,3,"versionedText.write",json!({"versionId":"main","path":"bench.md","text":"benchmark body","origin":"api","momentId":"template","nowMs":1})).await;
    for i in 0..3 {
        call(&transport, &handle, 1000+i, "versionedText.write", json!({"versionId":"main","path":"sparse.md","text":(["first","second","third"][i as usize]),"origin":"api","momentId":format!("sparse-{i}"),"nowMs":i+2})).await;
    }
    call(&transport, &handle, 4, "workspace.close", json!({})).await;
    let mut conn =
        rusqlite::Connection::open(scratch.path().join(".dohc/engine/engine.db")).unwrap();
    {
        let columns: Vec<String> = conn
            .prepare("PRAGMA table_info(moments)")
            .unwrap()
            .query_map([], |row| row.get(1))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        let select = columns
            .iter()
            .map(|col| match col.as_str() {
                "moment_order" => "n+4".into(),
                "moment_id" => "'bench-'||n".into(),
                "recorded_at_ms" => "n+1".into(),
                _ => format!("m.{col}"),
            })
            .collect::<Vec<String>>()
            .join(",");
        let tx = conn.transaction().unwrap();
        tx.execute(&format!("WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<?1) INSERT INTO moments ({}) SELECT {select} FROM seq JOIN moments m ON m.moment_id='template'",columns.join(",")),[entries-4]).unwrap();
        tx.commit().unwrap();
    }
    conn.execute("WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<1000) INSERT INTO secret_moments(workspace_id,moment_order,moment_id,version_id,path,recorded_at_ms,operation,metadata_origin,after_present) SELECT 'history-benchmark',n,'protected-'||n,'main','.env',?1+n,'delete','api',0 FROM seq", [entries]).unwrap();
    conn.execute("WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<100) INSERT INTO versions(workspace_id,version_id,kind,name,created_at_ms,fork_version_id) SELECT 'history-benchmark','marker-'||n,'named','Marker '||n,?1+n,'main' FROM seq", [entries+1000]).unwrap();
    let object_id: String = conn
        .query_row(
            "SELECT object_id FROM moments WHERE path='sparse.md' LIMIT 1",
            [],
            |r| r.get(0),
        )
        .unwrap();
    if mode == "candidate" {
        conn.execute_batch("DROP INDEX IF EXISTS idx_moments_history_time; DROP INDEX IF EXISTS idx_moments_object_history_time; DELETE FROM engine_migrations WHERE id='v2-moments-history-time';").unwrap();
    }
    drop(conn);
    let start = Instant::now();
    let handle = open(&transport, &scratch, 5, false).await;
    let first_launch_ms = start.elapsed().as_secs_f64() * 1000.0;
    let mut first = Vec::new();
    let mut later = Vec::new();
    let mut object = Vec::new();
    let mut later_text = Vec::new();
    let mut id = 10;
    let later_text_params = if mode == "baseline" {
        let first = call(
            &transport,
            &handle,
            id,
            "history.page",
            json!({"workspaceId":"history-benchmark","limit":50}),
        )
        .await;
        id += 1;
        json!({"workspaceId":"history-benchmark","limit":50,"beforeMomentOrder":first["textMomentPage"]["nextBeforeMomentOrder"]})
    } else {
        let mut params = json!({"workspaceId":"history-benchmark","limit":50});
        let mut saw_protected = false;
        let mut saw_markers = false;
        loop {
            let page = call(&transport, &handle, id, "history.page", params.clone()).await;
            id += 1;
            saw_protected |= !page["protectedMoments"].as_array().unwrap().is_empty();
            saw_markers |= !page["versionMarkers"].as_array().unwrap().is_empty();
            assert!(
                !page["nextCursor"].is_null(),
                "fixture exhausted before reaching text"
            );
            params["cursor"] = page["nextCursor"].clone();
            if !page["moments"].as_array().unwrap().is_empty() {
                assert!(saw_protected && saw_markers);
                break params;
            }
        }
    };
    for iteration in 0..110 {
        let start = Instant::now();
        call(
            &transport,
            &handle,
            id,
            "history.page",
            later_text_params.clone(),
        )
        .await;
        id += 1;
        if iteration >= 10 {
            later_text.push(start.elapsed().as_secs_f64() * 1000.0);
        }
        let start = Instant::now();
        let object_page = call(
            &transport,
            &handle,
            id,
            "history.page",
            json!({"workspaceId":"history-benchmark","objectId":object_id,"limit":50}),
        )
        .await;
        id += 1;
        if iteration >= 10 {
            object.push(start.elapsed().as_secs_f64() * 1000.0);
        }
        let count = if mode == "baseline" {
            &object_page["textMomentPage"]["moments"]
        } else {
            &object_page["moments"]
        };
        assert_eq!(count.as_array().unwrap().len(), 3);
        let start = Instant::now();
        let page = call(
            &transport,
            &handle,
            id,
            "history.page",
            json!({"workspaceId":"history-benchmark","limit":50}),
        )
        .await;
        id += 1;
        if iteration >= 10 {
            first.push(start.elapsed().as_secs_f64() * 1000.0);
        }
        let params = if mode == "baseline" {
            json!({"workspaceId":"history-benchmark","limit":50,"beforeMomentOrder":page["textMomentPage"]["nextBeforeMomentOrder"]})
        } else {
            json!({"workspaceId":"history-benchmark","limit":50,"cursor":page["nextCursor"]})
        };
        let start = Instant::now();
        call(&transport, &handle, id, "history.page", params).await;
        id += 1;
        if iteration >= 10 {
            later.push(start.elapsed().as_secs_f64() * 1000.0);
        }
    }
    call(&transport, &handle, id, "workspace.close", json!({})).await;
    id += 1;
    let handle = open(&transport, &scratch, id, true).await;
    id += 1;
    reconcile_until_settled(&transport, &handle, id + 10000).await;
    let mut flush_inclusive = Vec::new();
    let mut flush_only = Vec::new();
    for _ in 0..100 {
        let start = Instant::now();
        call(&transport, &handle, id, "capture.flush", json!({})).await;
        id += 1;
        flush_only.push(start.elapsed().as_secs_f64() * 1000.0);
        let start = Instant::now();
        call(
            &transport,
            &handle,
            id,
            "history.page",
            json!({"workspaceId":"history-benchmark","limit":50}),
        )
        .await;
        id += 1;
        flush_inclusive.push(start.elapsed().as_secs_f64() * 1000.0);
    }
    call(&transport, &handle, id, "workspace.close", json!({})).await;
    id += 1;
    let handle = open(&transport, &scratch, id, false).await;
    id += 1;
    let mut saves = Vec::new();
    for iteration in 0..110 {
        let params = json!({"versionId":"main","path":"bench.md","text":format!("save {iteration}"),"origin":"api","momentId":format!("save-{iteration}"),"nowMs":entries+2000+iteration});
        let start = Instant::now();
        call(&transport, &handle, id, "versionedText.write", params).await;
        id += 1;
        if iteration >= 10 {
            saves.push(start.elapsed().as_secs_f64() * 1000.0);
        }
    }
    call(&transport, &handle, id, "workspace.close", json!({})).await;
    let mut store = EngineStore::open(&scratch.path().join(".dohc/engine/engine.db"), 1).unwrap();
    let sha = hex_sha256(b"remote");
    store
        .read_with(|conn| {
            conn.execute(
                "INSERT OR IGNORE INTO blobs(sha256,byte_length,text) VALUES(?1,6,'remote')",
                [&sha],
            )?;
            let count: i64 = conn.query_row(
                "SELECT COUNT(*) FROM moments WHERE moment_id LIKE 'save-%'",
                [],
                |r| r.get(0),
            )?;
            assert_eq!(count, 110, "every save must append a moment");
            Ok::<(), rusqlite::Error>(())
        })
        .unwrap();
    // Prepare envelopes outside timing. Each uses the production sync transaction.
    let import_batch_size = 100;
    let envelopes: Vec<_> = (0..11*import_batch_size).map(|n| ReplicationEnvelope {
        workspace_id: "history-benchmark".into(), origin_id: "benchmark-peer".into(), origin_seq: n,
        op_kind: "moment.append".into(), recorded_at_ms: 50, relay_seq: None,
        settlement_admission: None, admitted_author_snapshot: None,
        payload: json!({"momentId":format!("import-{n}"),"versionId":"main","objectId":format!("remote-object-{n}"),"objectCreatedAtMs":1,"path":format!("remote-{n}.md"),"recordedAtMs":50,"operation":"write","payloadBeforeBlobSha256":null,"payloadBeforePath":null,"payloadAfterBlobSha256":sha,"payloadAfterPath":format!("remote-{n}.md"),"metadata":{"origin":"sync"},"beforePresent":"absent"}),
    }).collect();
    let mut import_per_moment = Vec::new();
    for (batch, envelopes) in envelopes.chunks(import_batch_size as usize).enumerate() {
        let start = Instant::now();
        for envelope in envelopes {
            apply_moment_envelope(
                &mut store,
                envelope,
                &NoFaults,
                &NoLiveLeases,
                &dohc_engine_collab::live_update_application::ReleasedTails::default(),
            )
            .unwrap();
        }
        if batch > 0 {
            import_per_moment
                .push(start.elapsed().as_secs_f64() * 1000.0 / import_batch_size as f64);
        }
    }
    let imported: i64 = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM moments WHERE moment_id LIKE 'import-%'",
                [],
                |r| r.get(0),
            )
        })
        .unwrap();
    assert_eq!(
        imported,
        11 * import_batch_size,
        "every imported envelope must append a moment"
    );
    drop(store);
    println!(
        "HISTORY_BENCH {}",
        json!({"mode":mode,"entries":entries,"limit":50,"build":if cfg!(debug_assertions) {"debug"} else {"release"},"protectedRows":1000,"versionMarkers":100,"objectFirst":stats(object),"settledLaterText":stats(later_text),"firstLaunchMs":first_launch_ms,"settledFirst":stats(first),"settledLater":stats(later),"captureEnabledSettled":stats(flush_inclusive),"settledFlush":stats(flush_only),"save":stats(saves),"importPerMoment":stats(import_per_moment),"importBatchSize":import_batch_size,"importTransactions":"one per moment"})
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn benchmark_open_seeds_and_applies_the_pending_index_migration() {
    let scratch = ScratchDir::new().unwrap();
    write_root_binding(scratch.path(), TOKEN).unwrap();
    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let handle = open(&transport, &scratch, 1, false).await;
    call(
        &transport,
        &handle,
        2,
        "versions.ensureMain",
        json!({"workspaceId":"history-benchmark"}),
    )
    .await;
    call(&transport, &handle, 3, "versionedText.write", json!({"versionId":"main","path":"bench.md","text":"body","origin":"api","momentId":"template","nowMs":1})).await;
    call(&transport, &handle, 4, "workspace.close", json!({})).await;
    let db = scratch.path().join(".dohc/engine/engine.db");
    let conn = rusqlite::Connection::open(&db).unwrap();
    conn.execute_batch("DROP INDEX idx_moments_history_time; DROP INDEX idx_moments_object_history_time; DELETE FROM engine_migrations WHERE id='v2-moments-history-time';").unwrap();
    drop(conn);
    let handle = open(&transport, &scratch, 5, false).await;
    let conn = rusqlite::Connection::open(&db).unwrap();
    let count: i64 = conn.query_row("SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name IN ('idx_moments_history_time','idx_moments_object_history_time')", [], |r| r.get(0)).unwrap();
    assert_eq!(count, 2);
    drop(conn);
    let page = call(
        &transport,
        &handle,
        6,
        "history.page",
        json!({"workspaceId":"history-benchmark","limit":50}),
    )
    .await;
    assert_eq!(page["moments"].as_array().unwrap().len(), 1);
    call(&transport, &handle, 7, "workspace.close", json!({})).await;
}
