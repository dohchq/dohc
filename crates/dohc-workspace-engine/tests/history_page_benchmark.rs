mod common;
use common::*;
use dohc_engine_protocol::{
    transport::{EngineTransport, InProcessTransport, RequestContext},
    wire::WorkspaceHandle,
};
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
    let result = transport
        .call(
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
#[ignore = "manual 100,000-moment benchmark; run through history-query-benchmark.mjs"]
async fn history_page_benchmark() {
    let entries = std::env::var("HISTORY_BENCH_ENTRIES")
        .unwrap_or_else(|_| "100000".into())
        .parse::<i64>()
        .unwrap();
    let mode = std::env::var("HISTORY_BENCH_MODE").unwrap_or_else(|_| "candidate".into());
    let scratch = ScratchDir::new().expect("scratch");
    write_root_binding(scratch.path(), TOKEN).unwrap();
    write_file(scratch.path(), "bench.md", b"benchmark body");
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
                "moment_order" => "n+1".into(),
                "moment_id" => "'bench-'||n".into(),
                "recorded_at_ms" => "n+1".into(),
                _ => format!("m.{col}"),
            })
            .collect::<Vec<String>>()
            .join(",");
        let tx = conn.transaction().unwrap();
        tx.execute(&format!("WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<?1) INSERT INTO moments ({}) SELECT {select} FROM seq JOIN moments m ON m.moment_id='template'",columns.join(",")),[entries-1]).unwrap();
        tx.commit().unwrap();
    }
    if mode == "candidate" {
        conn.execute_batch("DROP INDEX IF EXISTS idx_moments_history_time; DELETE FROM engine_migrations WHERE id='v2-moments-history-time';").unwrap();
    }
    drop(conn);
    let start = Instant::now();
    let handle = open(&transport, &scratch, 5, false).await;
    let first_launch_ms = start.elapsed().as_secs_f64() * 1000.0;
    let mut first = Vec::new();
    let mut later = Vec::new();
    let mut id = 10;
    for iteration in 0..110 {
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
    println!(
        "HISTORY_BENCH {}",
        json!({"mode":mode,"entries":entries,"limit":50,"build":"debug","firstLaunchMs":first_launch_ms,"settledFirst":stats(first),"settledLater":stats(later),"captureEnabledSettled":stats(flush_inclusive),"settledFlush":stats(flush_only)})
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
    conn.execute_batch("DROP INDEX idx_moments_history_time; DELETE FROM engine_migrations WHERE id='v2-moments-history-time';").unwrap();
    drop(conn);
    let handle = open(&transport, &scratch, 5, false).await;
    let conn = rusqlite::Connection::open(&db).unwrap();
    let count: i64 = conn.query_row("SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='idx_moments_history_time'", [], |r| r.get(0)).unwrap();
    assert_eq!(count, 1);
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
