//! Desktop workspace-search RPC: active-version scoping and bounded paging
//! through the real in-process daemon transport.

mod common;

use common::*;
use dohc_engine_domain::VersionedTextStore;
use dohc_engine_protocol::{
    transport::{EngineTransport, InProcessTransport, RequestContext},
    wire::WorkspaceHandle,
};
use dohc_engine_storage::{EngineStore, NoFaults, TxnOutcome};
use dohc_engine_testkit::{ScratchDir, engine_db_path};
use dohc_workspace_engine::{EngineService, root_binding::write_root_binding};
use serde_json::json;
use std::sync::Arc;

async fn open_workspace(
    transport: &InProcessTransport<EngineService>,
    scratch: &ScratchDir,
    id: u64,
    workspace_id: &str,
) -> WorkspaceHandle {
    write_root_binding(scratch.path(), TOKEN).expect("root binding");
    let opened = transport
        .call(
            RequestContext::unbounded(),
            request(
                id,
                "workspace.open",
                None,
                json!({
                    "rootDir": scratch.path().to_string_lossy(),
                    "workspaceId": workspace_id,
                }),
            ),
        )
        .await
        .expect("open");
    serde_json::from_value(opened.result["workspace"].clone()).expect("handle")
}

async fn write(
    transport: &InProcessTransport<EngineService>,
    handle: &WorkspaceHandle,
    id: u64,
    version_id: &str,
    path: &str,
    text: &str,
) {
    call(
        transport,
        handle,
        id,
        "versionedText.write",
        json!({
            "versionId": version_id,
            "path": path,
            "text": text,
            "origin": "api",
            "requestId": format!("write-{id}"),
        }),
    )
    .await;
}

fn seed_short_query_scan_rows(scratch: &ScratchDir, workspace_id: &str, nonmatching_rows: usize) {
    write_root_binding(scratch.path(), TOKEN).expect("root binding");
    let db = engine_db_path(scratch).expect("engine db path");
    let faults = NoFaults;
    let mut store = EngineStore::open(&db, 1).expect("seed store");
    assert!(
        store
            .bind_root_token(TOKEN, &NoFaults)
            .expect("bind root token")
    );
    VersionedTextStore::new(&mut store)
        .ensure_main_version(workspace_id, "main", 1, &faults)
        .expect("ensure main version");
    let outcome = store
        .write_with(&faults, |tx| {
            for index in 0..=nonmatching_rows {
                let is_target = index == nonmatching_rows;
                tx.execute(
                    "INSERT INTO engine_search_files_fts \
                     (workspace_id, version_id, object_id, path, text) \
                     VALUES (?1, 'main', ?2, ?3, ?4)",
                    rusqlite::params![
                        workspace_id,
                        format!("object-{index:04}"),
                        format!("notes/{index:04}.md"),
                        if is_target { "AI target" } else { "ordinary" },
                    ],
                )?;
            }
            // -2 is the current file-and-chat index certification sentinel.
            // An older generation or ordinary timestamp makes the next open
            // wipe these intentionally seeded rows in a heal rebuild.
            tx.execute(
                "INSERT INTO engine_search_index_state \
                 (workspace_id, version_id, indexed_at_ms, file_policy_degraded) \
                 VALUES (?1, 'main', -2, 0)",
                rusqlite::params![workspace_id],
            )?;
            Ok::<(), dohc_engine_runtime::SearchError>(())
        })
        .expect("seed search index");
    assert!(matches!(outcome, TxnOutcome::Committed(())));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn query_page_returns_ranked_snippets_from_the_active_version() {
    let scratch = ScratchDir::new().expect("scratch");
    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let workspace_id = "ws-search-page-active";
    let handle = open_workspace(&transport, &scratch, 1, workspace_id).await;
    write(
        &transport,
        &handle,
        2,
        "main",
        "notes/main.md",
        "first line\nprefix NEEDLE suffix\n",
    )
    .await;
    let feature = call(
        &transport,
        &handle,
        3,
        "versions.createNamed",
        json!({
            "workspaceId": workspace_id,
            "name": "feature",
            "fromVersionId": "main",
        }),
    )
    .await;
    let feature_id = feature["id"].as_str().expect("feature id");
    write(
        &transport,
        &handle,
        4,
        feature_id,
        "notes/feature.md",
        "active version needle",
    )
    .await;

    let before_switch = call(
        &transport,
        &handle,
        5,
        "search.queryPage",
        json!({ "query": "needle", "limit": 50 }),
    )
    .await;
    assert_eq!(before_switch["versionId"], "main");
    assert!(
        before_switch["results"]
            .as_array()
            .expect("results")
            .iter()
            .all(|row| row["path"] != "notes/feature.md")
    );

    call(
        &transport,
        &handle,
        6,
        "versions.setActive",
        json!({ "workspaceId": workspace_id, "versionId": feature_id }),
    )
    .await;
    let active = call(
        &transport,
        &handle,
        7,
        "search.queryPage",
        json!({ "query": "needle", "limit": 50 }),
    )
    .await;
    assert_eq!(active["versionId"], feature_id);
    let results = active["results"].as_array().expect("results");
    let feature_hit = results
        .iter()
        .find(|row| row["path"] == "notes/feature.md")
        .expect("feature hit");
    assert_eq!(feature_hit["surface"], "file");
    assert_eq!(feature_hit["title"], "notes/feature.md");
    assert_eq!(feature_hit["line"], 1);
    assert_eq!(feature_hit["preview"], "active version needle");
    assert_eq!(feature_hit["matchStart"], 15);
    assert_eq!(feature_hit["matchEnd"], 21);
    assert!(active["nextCursor"].is_null());

    call(
        &transport,
        &handle,
        8,
        "chats.channels.ensureGeneral",
        json!({ "channelId": "channel-general", "nowMs": 100 }),
    )
    .await;
    call(
        &transport,
        &handle,
        9,
        "chats.threads.start",
        json!({
            "channelId": "channel-general",
            "threadId": "projection-thread",
            "messageId": "projection-message",
            "authorKind": "human",
            "authorDisplayName": "Alice",
            "body": "projection sentinel\nrest",
            "nowMs": 101,
        }),
    )
    .await;
    let chat = call(
        &transport,
        &handle,
        10,
        "search.queryPage",
        json!({ "query": "projection sentinel", "limit": 50 }),
    )
    .await;
    let chat_results = chat["results"].as_array().expect("chat results");
    assert_eq!(chat_results.len(), 2);
    assert_eq!(chat_results[0]["surface"], "chat");
    assert_eq!(chat_results[0]["threadId"], "projection-thread");
    assert_eq!(chat_results[0]["line"], 1);
    assert_eq!(chat_results[0]["preview"], "projection sentinel");
    assert!(
        chat_results[0]["path"]
            .as_str()
            .expect("projection path")
            .starts_with(".dohc/chats/v1-")
    );
    assert_eq!(chat_results[1]["line"], 7);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn query_page_resolves_every_search_through_its_opaque_workspace_handle() {
    let service = Arc::new(EngineService::new());
    let transport = InProcessTransport::new(service);
    let scratch_a = ScratchDir::new().expect("scratch a");
    let scratch_b = ScratchDir::new().expect("scratch b");
    let handle_a = open_workspace(&transport, &scratch_a, 1, "workspace-search-a").await;
    let handle_b = open_workspace(&transport, &scratch_b, 2, "workspace-search-b").await;
    write(
        &transport,
        &handle_a,
        3,
        "main",
        "only-a.md",
        "scoped needle alpha",
    )
    .await;
    write(
        &transport,
        &handle_b,
        4,
        "main",
        "only-b.md",
        "scoped needle beta",
    )
    .await;

    let from_a = call(
        &transport,
        &handle_a,
        5,
        "search.queryPage",
        json!({ "query": "scoped needle", "limit": 50 }),
    )
    .await;
    let from_b = call(
        &transport,
        &handle_b,
        6,
        "search.queryPage",
        json!({ "query": "scoped needle", "limit": 50 }),
    )
    .await;
    assert_eq!(from_a["results"][0]["path"], "only-a.md");
    assert_eq!(from_b["results"][0]["path"], "only-b.md");
    assert!(
        from_a["results"]
            .as_array()
            .expect("a results")
            .iter()
            .all(|row| row["path"] != "only-b.md")
    );
    assert!(
        from_b["results"]
            .as_array()
            .expect("b results")
            .iter()
            .all(|row| row["path"] != "only-a.md")
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn query_page_byte_budget_pages_an_oversized_result_set() {
    let scratch = ScratchDir::new().expect("scratch");
    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let handle = open_workspace(&transport, &scratch, 1, "workspace-search-paging").await;
    let text = std::iter::repeat_n("needle", 1_000)
        .collect::<Vec<_>>()
        .join("\n");
    let oversized_path = format!("{}.md", "oversized-path-".repeat(10));
    write(&transport, &handle, 2, "main", &oversized_path, &text).await;

    let mut cursor: Option<String> = None;
    let mut total = 0usize;
    let mut page_count = 0usize;
    loop {
        let page = call(
            &transport,
            &handle,
            3 + page_count as u64,
            "search.queryPage",
            json!({
                "query": "needle",
                "limit": 1_000,
                "cursor": cursor,
            }),
        )
        .await;
        let rows = page["results"].as_array().expect("results");
        let serialized_row_bytes: usize = rows
            .iter()
            .map(|row| serde_json::to_vec(row).expect("serialize row").len())
            .sum();
        assert!(
            serialized_row_bytes <= 256 * 1024,
            "serialized search page exceeded its byte budget"
        );
        if page_count == 0 {
            assert!(rows.len() < 1_000, "first page was not byte-cut");
            assert!(page["nextCursor"].is_string(), "missing continuation");
        }
        total += rows.len();
        page_count += 1;
        cursor = page["nextCursor"].as_str().map(ToOwned::to_owned);
        if cursor.is_none() {
            break;
        }
    }
    assert!(page_count > 1);
    assert_eq!(total, 1_000);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn query_page_short_query_finds_seeded_content() {
    let scratch = ScratchDir::new().expect("scratch");
    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let handle = open_workspace(&transport, &scratch, 1, "workspace-search-short").await;
    write(
        &transport,
        &handle,
        2,
        "main",
        "notes/ai.md",
        "AI planning notes",
    )
    .await;

    let page = call(
        &transport,
        &handle,
        3,
        "search.queryPage",
        json!({ "query": "AI", "limit": 50 }),
    )
    .await;
    assert_eq!(page["results"][0]["path"], "notes/ai.md");
    assert_eq!(page["restartRequired"], false);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn query_page_resumes_an_empty_bounded_scan_page() {
    let scratch = ScratchDir::new().expect("scratch");
    let workspace_id = "workspace-search-empty-page";
    seed_short_query_scan_rows(&scratch, workspace_id, 1_024);
    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let handle = open_workspace(&transport, &scratch, 1, workspace_id).await;

    let first = call(
        &transport,
        &handle,
        2,
        "search.queryPage",
        json!({ "query": "AI", "limit": 50 }),
    )
    .await;
    assert!(
        first["results"]
            .as_array()
            .expect("first results")
            .is_empty(),
        "the first 1,024 rows should contain no match"
    );
    let cursor = first["nextCursor"]
        .as_str()
        .expect("exclusive scan continuation")
        .to_owned();

    let second = call(
        &transport,
        &handle,
        3,
        "search.queryPage",
        json!({ "query": "AI", "limit": 50, "cursor": cursor }),
    )
    .await;
    assert_eq!(second["results"][0]["path"], "notes/1024.md");
    assert!(second["nextCursor"].is_null());
    assert_eq!(second["restartRequired"], false);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn query_page_cursor_signals_restart_after_index_mutation() {
    let scratch = ScratchDir::new().expect("scratch");
    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let handle = open_workspace(&transport, &scratch, 1, "workspace-search-generation").await;
    let text = std::iter::repeat_n("needle", 1_000)
        .collect::<Vec<_>>()
        .join("\n");
    let oversized_path = format!("{}.md", "generation-path-".repeat(12));
    write(&transport, &handle, 2, "main", &oversized_path, &text).await;

    let first = call(
        &transport,
        &handle,
        3,
        "search.queryPage",
        json!({ "query": "needle", "limit": 1_000 }),
    )
    .await;
    let cursor = first["nextCursor"]
        .as_str()
        .expect("byte-cut first page cursor")
        .to_owned();
    write(
        &transport,
        &handle,
        4,
        "main",
        "inserted-between-pages.md",
        "needle inserted",
    )
    .await;

    let continuation = call(
        &transport,
        &handle,
        5,
        "search.queryPage",
        json!({ "query": "needle", "limit": 1_000, "cursor": cursor }),
    )
    .await;
    assert_eq!(continuation["restartRequired"], true);
    assert!(
        continuation["results"]
            .as_array()
            .expect("results")
            .is_empty()
    );
    assert!(continuation["nextCursor"].is_null());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn query_page_cursor_signals_restart_after_active_version_switch() {
    let scratch = ScratchDir::new().expect("scratch");
    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let workspace_id = "workspace-search-version-restart";
    let handle = open_workspace(&transport, &scratch, 1, workspace_id).await;
    let text = std::iter::repeat_n("needle", 1_000)
        .collect::<Vec<_>>()
        .join("\n");
    let oversized_path = format!("{}.md", "version-restart-path-".repeat(12));
    write(&transport, &handle, 2, "main", &oversized_path, &text).await;
    let feature = call(
        &transport,
        &handle,
        3,
        "versions.createNamed",
        json!({
            "workspaceId": workspace_id,
            "name": "feature",
            "fromVersionId": "main",
        }),
    )
    .await;
    let feature_id = feature["id"].as_str().expect("feature id").to_owned();

    let first = call(
        &transport,
        &handle,
        4,
        "search.queryPage",
        json!({ "query": "needle", "limit": 1_000 }),
    )
    .await;
    let cursor = first["nextCursor"]
        .as_str()
        .expect("byte-cut first page cursor")
        .to_owned();
    call(
        &transport,
        &handle,
        5,
        "versions.setActive",
        json!({ "workspaceId": workspace_id, "versionId": feature_id }),
    )
    .await;

    let continuation = call(
        &transport,
        &handle,
        6,
        "search.queryPage",
        json!({ "query": "needle", "limit": 1_000, "cursor": cursor }),
    )
    .await;
    assert_eq!(continuation["versionId"], feature_id);
    assert_eq!(continuation["restartRequired"], true);
    assert!(
        continuation["results"]
            .as_array()
            .expect("results")
            .is_empty()
    );
    assert!(continuation["nextCursor"].is_null());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn query_page_astral_preview_fits_renderer_utf16_contract() {
    let scratch = ScratchDir::new().expect("scratch");
    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let handle = open_workspace(&transport, &scratch, 1, "workspace-search-astral").await;
    let text = format!("{}needle{}", "😀".repeat(120), "🚀".repeat(120));
    write(&transport, &handle, 2, "main", "notes/astral.md", &text).await;

    let page = call(
        &transport,
        &handle,
        3,
        "search.queryPage",
        json!({ "query": "needle", "limit": 50 }),
    )
    .await;
    let hit = &page["results"][0];
    let preview = hit["preview"].as_str().expect("preview");
    assert!(preview.encode_utf16().count() <= 180);
    let start = hit["matchStart"].as_u64().expect("start") as usize;
    let end = hit["matchEnd"].as_u64().expect("end") as usize;
    assert_eq!(&preview[start..end], "needle");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn query_page_reads_a_write_committed_through_rpc_immediately() {
    let scratch = ScratchDir::new().expect("scratch");
    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let handle = open_workspace(&transport, &scratch, 1, "workspace-search-rwyw").await;
    call(
        &transport,
        &handle,
        2,
        "versions.ensureMain",
        json!({ "workspaceId": "workspace-search-rwyw" }),
    )
    .await;
    let empty = call(
        &transport,
        &handle,
        3,
        "search.queryPage",
        json!({ "query": "freshly searchable", "limit": 50 }),
    )
    .await;
    assert!(empty["results"].as_array().expect("results").is_empty());

    write(
        &transport,
        &handle,
        4,
        "main",
        "fresh.md",
        "freshly searchable content",
    )
    .await;
    let after = call(
        &transport,
        &handle,
        5,
        "search.queryPage",
        json!({ "query": "freshly searchable", "limit": 50 }),
    )
    .await;
    assert_eq!(after["results"][0]["path"], "fresh.md");
}

/// Includes RPC dispatch, actor queueing, SQLite, and response construction.
/// InProcessTransport excludes process startup and framed pipe transport.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "manual search pagination benchmark; run without competing workloads"]
async fn profiles_search_rpc_first_and_late_pages() {
    use std::time::Instant;

    const RESULT_LIMIT: usize = 1_000;
    for (surface, name, lines, spacing, unicode) in [
        ("file", "dense", 10_000, 1, false),
        ("file", "sparse", 10_000, 20, false),
        ("file", "unicode-mixed-newlines", 5_000, 10, true),
        ("chat", "dense", 2_000, 1, false),
        ("chat", "sparse", 5_000, 10, false),
        ("chat", "unicode-mixed-newlines", 2_000, 4, true),
    ] {
        let scratch = ScratchDir::new().expect("scratch");
        let service = Arc::new(EngineService::new());
        let transport = InProcessTransport::new(Arc::clone(&service));
        let handle = open_workspace(&transport, &scratch, 1, "search-benchmark").await;
        call(
            &transport,
            &handle,
            4,
            "versions.ensureMain",
            json!({ "workspaceId": "search-benchmark" }),
        )
        .await;
        let mut text = String::from("Benchmark\n");
        for index in 0..lines {
            text.push_str(if index % spacing == 0 {
                if unicode {
                    "😀 É NEEDLE 🚀"
                } else {
                    "needle"
                }
            } else {
                "ordinary"
            });
            text.push_str(match index % 3 {
                0 => "\r\n",
                1 => "\r",
                _ => "\n",
            });
        }
        if surface == "file" {
            let path = format!("{}.txt", "long-path-".repeat(20));
            write(&transport, &handle, 2, "main", &path, &text).await;
        } else {
            call(
                &transport,
                &handle,
                2,
                "chats.channels.ensureGeneral",
                json!({ "channelId": "benchmark-channel", "nowMs": 100 }),
            )
            .await;
            call(
                &transport,
                &handle,
                3,
                "chats.threads.start",
                json!({
                    "channelId": "benchmark-channel",
                    "threadId": "benchmark-thread",
                    "messageId": "benchmark-message",
                    "title": "界".repeat(200),
                    "authorKind": "human",
                    "authorDisplayName": "Alice",
                    "body": text,
                    "nowMs": 101,
                }),
            )
            .await;
        }

        reconcile_until_settled(&transport, &handle, 10_000).await;

        // Obtain opaque continuation cursors by walking actual RPC pages.
        // Seeding, index ensure, and this walk are outside measured samples.
        let expected_total = (lines / spacing).min(RESULT_LIMIT);
        let mut cursor: Option<String> = None;
        let mut late_cursor = None;
        let mut total = 0;
        let mut request_id = 10;
        let mut previous_line = 0;
        loop {
            if cursor.is_some() {
                late_cursor = cursor.clone();
            }
            let page = call(
                &transport,
                &handle,
                request_id,
                "search.queryPage",
                json!({ "query": "needle", "limit": RESULT_LIMIT, "cursor": cursor }),
            )
            .await;
            request_id += 1;
            assert_eq!(page["restartRequired"], false);
            let rows = page["results"].as_array().expect("results");
            assert!(!rows.is_empty());
            for row in rows {
                assert_eq!(row["surface"], surface);
                let line = row["line"].as_u64().expect("line");
                assert!(line > previous_line, "duplicate or reordered search hit");
                previous_line = line;
            }
            total += rows.len();
            cursor = page["nextCursor"].as_str().map(ToOwned::to_owned);
            if cursor.is_none() {
                break;
            }
        }
        assert_eq!(total, expected_total);
        let late_cursor = late_cursor.expect("late page cursor");
        for (position, cursor) in [("first", None), ("late", Some(late_cursor))] {
            let params = json!({ "query": "needle", "limit": RESULT_LIMIT, "cursor": cursor });
            let mut expected_rows = None;
            let mut samples_ms = Vec::new();
            for sample in 0..36 {
                let started = Instant::now();
                let page = call(
                    &transport,
                    &handle,
                    request_id,
                    "search.queryPage",
                    params.clone(),
                )
                .await;
                let elapsed_ms = started.elapsed().as_secs_f64() * 1_000.0;
                request_id += 1;
                assert_eq!(page["restartRequired"], false);
                let rows = page["results"].as_array().expect("results");
                assert!(!rows.is_empty() && rows.len() <= RESULT_LIMIT);
                if let Some(expected) = &expected_rows {
                    assert_eq!(rows, expected);
                } else {
                    expected_rows = Some(rows.clone());
                }
                if sample >= 5 {
                    samples_ms.push(elapsed_ms);
                }
            }
            let mut sorted = samples_ms.clone();
            sorted.sort_by(f64::total_cmp);
            println!(
                "SEARCH_RPC_PROFILE {}",
                json!({
                    "transport": "in-process",
                    "surface": surface,
                    "fixture": name,
                    "position": position,
                    "sourceBytes": text.len(),
                    "sourceMatches": lines / spacing,
                    "totalReturnedMatches": total,
                    "queryResultLimit": RESULT_LIMIT,
                    "pageResultCount": expected_rows.as_ref().expect("rows").len(),
                    "firstResultLine": expected_rows.as_ref().expect("rows")[0]["line"],
                    "samplesMs": samples_ms,
                    "medianMs": sorted[15],
                    "p95Ms": sorted[29],
                })
            );
        }
        call(
            &transport,
            &handle,
            request_id,
            "workspace.close",
            json!({}),
        )
        .await;
        drop(transport);
        drop(service);
    }
}
