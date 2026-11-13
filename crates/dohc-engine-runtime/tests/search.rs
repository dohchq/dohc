//! Search: the index+query round-trip over real file snapshots and
//! chat messages (built through the versioning + chat domains, never hand-poked
//! FTS rows), policy-filtered visibility, the fail-closed FILE policy (scoped so
//! chat search survives a broken file policy), read-your-writes with no torn
//! mid-index visibility, durable index-state repair after a crash at the
//! index-commit boundary, the DoS bounds, and the FTS5-config parity checks.
//!
//! Fixtures are produced by `dohc-engine-domain` so the FTS index is fed the
//! same row shapes the product writes — the round-trip is non-tautological.

use dohc_engine_domain::{
    ChatActorKind, ChatChannelKind, ChatThreadLane, LinkedChatStore, SendMessage,
    StartChannelThread, VersionedTextStore, WriteText,
};
use dohc_engine_runtime::search::{
    FILE_SEARCH_PAGE_SOURCE_BYTE_BUDGET, FILE_SEARCH_RESULT_SOURCE_BYTE_BUDGET,
    SHORT_QUERY_PAGE_ROW_BUDGET, SearchCandidate, SearchPageDisposition, SearchSurface,
    WORKSPACE_ENGINE_SEARCH_MAX_PREVIEW_CHARS, ensure_search_index_for_version,
    query_chat_messages_granular_bounded, query_search_index_keyset, search_workspace_page,
};
use dohc_engine_storage::{EngineStore, FaultPoint, NoFaults, TxnOutcome};
use dohc_engine_sync::{
    ApplyDisposition, ApplyOutcome, ReplicationEnvelope, ShareBoundary, ShareSurface,
    apply_chat_envelope, apply_shared_envelope,
};
use dohc_engine_testkit::{ScratchDir, ScriptedFaults, engine_db_path};
use serde_json::json;
use std::path::Path;

const WS: &str = "ws-1";
const V: &str = "v-main";
const NO_FAULTS: NoFaults = NoFaults;
/// The daemon's granular chat response budget.
const GRANULAR_BYTE_BUDGET: usize = 256 * 1024;

#[test]
#[ignore = "manual actor search pagination benchmark; run without competing workloads"]
fn profiles_search_actor_first_and_late_pages() {
    use std::time::Instant;

    const PAGE_SIZE: usize = 25;
    for (surface, name, lines, spacing, unicode) in [
        (SearchSurface::File, "dense", 10_000, 1, false),
        (SearchSurface::File, "sparse", 100_000, 100, false),
        (
            SearchSurface::File,
            "unicode-mixed-newlines",
            10_000,
            10,
            true,
        ),
        (SearchSurface::Chat, "dense", 2_000, 1, false),
        (SearchSurface::Chat, "sparse", 5_000, 10, false),
        (
            SearchSurface::Chat,
            "unicode-mixed-newlines",
            2_000,
            4,
            true,
        ),
    ] {
        let scratch = ScratchDir::new().expect("scratch");
        let root = scratch.path();
        let db = engine_db_path(&scratch).expect("database path");
        let mut store = open(&db, 1);
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
        write_file(&mut store, "benchmark-object", "benchmark.txt", "setup", 10);
        match surface {
            SearchSurface::File => {
                write_file(&mut store, "benchmark-object", "benchmark.txt", &text, 20);
            }
            SearchSurface::Chat => {
                start_thread(
                    &mut store,
                    "benchmark-channel",
                    "benchmark-thread",
                    &text,
                    20,
                );
            }
        }
        ensure_index(&mut store, root, 30);
        let first = store
            .read_with(|conn| {
                search_workspace_page(
                    conn,
                    root,
                    WS,
                    V,
                    "needle",
                    Some(PAGE_SIZE as i64),
                    40,
                    None,
                    None,
                )
            })
            .expect("first page");
        let generation = first.generation;
        let mut cursor = first.continuation;
        let mut total = first.results.len();
        let mut late_cursor = None;
        while let Some(after) = cursor {
            let next = store
                .read_with(|conn| {
                    search_workspace_page(
                        conn,
                        root,
                        WS,
                        V,
                        "needle",
                        Some(PAGE_SIZE as i64),
                        40,
                        Some(generation),
                        Some(after),
                    )
                })
                .expect("continued page");
            assert_eq!(next.disposition, SearchPageDisposition::Results);
            assert!(!next.results.is_empty());
            late_cursor = Some(after);
            total += next.results.len();
            cursor = next.continuation;
        }
        assert_eq!(total, lines / spacing);
        let late_cursor = late_cursor.expect("late cursor");
        for (position, after) in [("first", None), ("late", Some(late_cursor))] {
            let mut expected = None;
            let mut samples_ms = Vec::new();
            for sample in 0..36 {
                let started = Instant::now();
                let page = store
                    .read_with(|conn| {
                        search_workspace_page(
                            conn,
                            root,
                            WS,
                            V,
                            "needle",
                            Some(PAGE_SIZE as i64),
                            40,
                            Some(generation),
                            after,
                        )
                    })
                    .expect("measured page");
                let elapsed_ms = started.elapsed().as_secs_f64() * 1_000.0;
                assert_eq!(page.disposition, SearchPageDisposition::Results);
                assert_eq!(page.results.len(), PAGE_SIZE);
                if let Some(expected) = &expected {
                    assert_eq!(&page.results, expected);
                } else {
                    expected = Some(page.results);
                }
                if sample >= 5 {
                    samples_ms.push(elapsed_ms);
                }
            }
            let mut sorted = samples_ms.clone();
            sorted.sort_by(f64::total_cmp);
            println!(
                "SEARCH_ACTOR_PROFILE {}",
                json!({
                    "entryPoint": "search_workspace_page",
                    "transport": "direct-store",
                    "surface": format!("{surface:?}"),
                    "fixture": name,
                    "position": position,
                    "sourceBytes": text.len(),
                    "sourceMatches": total,
                    "pageSize": PAGE_SIZE,
                    "anchorLine": after.map(|key| key.line),
                    "firstResultLine": expected.as_ref().expect("results")[0].result.line,
                    "samplesMs": samples_ms,
                    "medianMs": sorted[15],
                    "p95Ms": sorted[29],
                })
            );
        }
    }
}

fn open(db: &Path, now: i64) -> EngineStore {
    EngineStore::open(db, now).expect("open")
}

fn replicated_envelope(
    origin_id: &str,
    origin_seq: i64,
    op_kind: &str,
    payload: serde_json::Value,
) -> ReplicationEnvelope {
    ReplicationEnvelope {
        settlement_admission: None,
        admitted_author_snapshot: None,
        workspace_id: WS.to_owned(),
        origin_id: origin_id.to_owned(),
        origin_seq,
        relay_seq: Some(origin_seq),
        op_kind: op_kind.to_owned(),
        payload,
        recorded_at_ms: 1_000 + origin_seq,
    }
}

/// Write a text file into the main version through the versioning domain.
fn write_file(store: &mut EngineStore, object_id: &str, path: &str, text: &str, now: i64) {
    let mut vt = VersionedTextStore::new(store);
    vt.ensure_main_version(WS, V, now, &NO_FAULTS)
        .expect("ensure version");
    vt.write_text(
        &WriteText {
            workspace_id: WS.to_owned(),
            version_id: V.to_owned(),
            object_id: object_id.to_owned(),
            path: path.to_owned(),
            text: text.to_owned(),
            moment_id: format!("m-{object_id}-{now}"),
            metadata_origin: "test".to_owned(),
            metadata_summary: None,
            metadata_correlation_id: None,
            author_json: None,
            now_ms: now,
            request_id: None,
        },
        &NO_FAULTS,
    )
    .expect("write_text");
}

/// Create a channel + start a thread with a first message, returning the thread id.
fn start_thread(store: &mut EngineStore, channel_id: &str, thread_id: &str, body: &str, now: i64) {
    let mut chats = LinkedChatStore::new(store);
    chats
        .create_channel(
            WS,
            channel_id,
            &format!("Channel {channel_id}"),
            ChatChannelKind::Channel,
            now,
            &NO_FAULTS,
        )
        .expect("create channel");
    chats
        .start_channel_thread(
            &StartChannelThread {
                automation: None,
                workspace_id: WS.to_owned(),
                channel_id: channel_id.to_owned(),
                thread_id: thread_id.to_owned(),
                message_id: format!("{thread_id}-msg-0"),
                title: None,
                lane: ChatThreadLane::Posts,
                own_thread: false,
                author_kind: ChatActorKind::Human,
                author_display_name: "Ada".to_owned(),
                author_owner_display_name: None,
                author_user_id: Some("user-ada".to_owned()),
                origin: None,
                body: body.to_owned(),
                needs_decision: false,
                options: Vec::new(),
                attachments: Vec::new(),
                author_agent_id: None,
                author_reported: None,
                work: None,
                wake_agent_ids: Vec::new(),
                now_ms: now,
                request_id: None,
            },
            &NO_FAULTS,
        )
        .expect("start thread");
}

fn send(store: &mut EngineStore, thread_id: &str, message_id: &str, body: &str, now: i64) {
    let mut chats = LinkedChatStore::new(store);
    chats
        .send_message(
            &SendMessage {
                automation: None,
                workspace_id: WS.to_owned(),
                thread_id: thread_id.to_owned(),
                message_id: message_id.to_owned(),
                author_kind: ChatActorKind::Human,
                author_display_name: "Ada".to_owned(),
                author_owner_display_name: None,
                author_user_id: Some("user-ada".to_owned()),
                parent_message_id: None,
                origin: None,
                body: body.to_owned(),
                needs_decision: false,
                options: Vec::new(),
                attachments: Vec::new(),
                author_agent_id: None,
                author_reported: None,
                work: None,
                wake_agent_ids: Vec::new(),
                now_ms: now,
                request_id: None,
            },
            &NO_FAULTS,
        )
        .expect("send");
}

/// Build the index for the main version inside one transaction (atomic rebuild).
fn ensure_index(store: &mut EngineStore, root: &Path, now: i64) {
    let outcome = store
        .write_with(&NO_FAULTS, |tx| {
            ensure_search_index_for_version(tx, root, WS, V, now, &NO_FAULTS)
        })
        .expect("ensure index");
    assert!(matches!(outcome, TxnOutcome::Committed(())));
}

fn run_search(
    store: &EngineStore,
    root: &Path,
    query: &str,
) -> Vec<dohc_engine_runtime::SearchResult> {
    store
        .read_with(|conn| {
            search_workspace_page(conn, root, WS, V, query, Some(100), 999, None, None)
        })
        .expect("search")
        .results
        .into_iter()
        .map(|keyed| keyed.result)
        .collect()
}

/// First keyset page of policy-filtered candidates, with the daemon's budgets.
fn candidates(
    conn: &rusqlite::Connection,
    root: &Path,
    query: &str,
) -> Result<Vec<SearchCandidate>, dohc_engine_runtime::SearchError> {
    Ok(query_search_index_keyset(
        conn,
        root,
        WS,
        V,
        query,
        100,
        None,
        FILE_SEARCH_RESULT_SOURCE_BYTE_BUDGET,
        FILE_SEARCH_PAGE_SOURCE_BYTE_BUDGET,
        SHORT_QUERY_PAGE_ROW_BUDGET,
    )?
    .candidates)
}

fn granular(
    conn: &rusqlite::Connection,
    query: &str,
) -> Result<
    Vec<dohc_engine_runtime::search::GranularChatMessageSearchResult>,
    dohc_engine_runtime::SearchError,
> {
    Ok(query_chat_messages_granular_bounded(conn, WS, query, 100, GRANULAR_BYTE_BUDGET)?.results)
}

#[test]
fn short_query_file_scan_spends_its_row_budget_only_on_the_requested_scope() {
    let scratch = ScratchDir::new().expect("scratch");
    let root = scratch.path().to_path_buf();
    let db = engine_db_path(&scratch).expect("db");
    let mut store = open(&db, 1);
    write_file(
        &mut store,
        "obj-scoped-target",
        "notes/scoped-target.md",
        "AI target",
        10,
    );
    ensure_index(&mut store, &root, 20);

    let outcome = store
        .write_with(&NO_FAULTS, |tx| {
            tx.execute("DELETE FROM engine_search_files_fts", [])?;
            tx.execute(
                "INSERT INTO engine_search_files_fts \
                 (workspace_id, version_id, object_id, path, text) \
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                rusqlite::params![
                    "foreign-workspace",
                    V,
                    "foreign-object",
                    "foreign.md",
                    "ordinary"
                ],
            )?;
            tx.execute(
                "INSERT INTO engine_search_files_fts \
                 (workspace_id, version_id, object_id, path, text) \
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                rusqlite::params![
                    WS,
                    "foreign-version",
                    "foreign-version-object",
                    "foreign-version.md",
                    "ordinary"
                ],
            )?;
            tx.execute(
                "INSERT INTO engine_search_files_fts \
                 (workspace_id, version_id, object_id, path, text) \
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                rusqlite::params![
                    WS,
                    V,
                    "obj-scoped-target",
                    "notes/scoped-target.md",
                    "AI target"
                ],
            )?;
            Ok::<(), dohc_engine_runtime::SearchError>(())
        })
        .expect("seed scoped FTS rows");
    assert!(matches!(outcome, TxnOutcome::Committed(())));

    let batch = store
        .read_with(|conn| {
            query_search_index_keyset(
                conn,
                &root,
                WS,
                V,
                "AI",
                10,
                None,
                FILE_SEARCH_RESULT_SOURCE_BYTE_BUDGET,
                FILE_SEARCH_PAGE_SOURCE_BYTE_BUDGET,
                1,
            )
        })
        .expect("scoped short query");
    assert_eq!(batch.candidates.len(), 1);
    assert!(matches!(
        &batch.candidates[0],
        SearchCandidate::File { path, .. } if path == "notes/scoped-target.md"
    ));
}

#[test]
fn lowercase_expansion_highlights_survive_file_and_chat_page_continuations() {
    let scratch = ScratchDir::new().expect("scratch");
    let root = scratch.path();
    let db = engine_db_path(&scratch).expect("db");
    let mut store = open(&db, 1);
    let text = format!(
        "heading\nİ needle\nİx\n{}İ needle{}\n{}İx{}",
        "😀".repeat(120),
        "🚀".repeat(120),
        "😀".repeat(120),
        "🚀".repeat(120),
    );
    write_file(
        &mut store,
        "unicode-highlights",
        "notes/highlights.md",
        &text,
        10,
    );
    start_thread(
        &mut store,
        "unicode-highlights-channel",
        "unicode-highlights-thread",
        &text,
        20,
    );
    ensure_index(&mut store, root, 30);

    for (query, matched) in [("needle", "needle"), ("x", "x"), ("İx", "İx")] {
        let expected = store
            .read_with(|conn| {
                search_workspace_page(conn, root, WS, V, query, Some(100), 40, None, None)
            })
            .expect("all unicode matches");
        assert!(!expected.has_more);
        assert_eq!(expected.results.len(), 4, "query {query:?}");
        for surface in [SearchSurface::File, SearchSurface::Chat] {
            assert_eq!(
                expected
                    .results
                    .iter()
                    .filter(|hit| hit.result.surface == surface)
                    .count(),
                2
            );
        }
        for hit in &expected.results {
            let result = &hit.result;
            assert_eq!(
                &result.preview[result.match_start..result.match_end],
                matched,
                "query {query:?}, result {result:?}"
            );
            assert!(
                result.preview.encode_utf16().count() <= WORKSPACE_ENGINE_SEARCH_MAX_PREVIEW_CHARS
            );
        }

        for page_size in [1, 3] {
            let mut actual = Vec::new();
            let mut after = None;
            loop {
                let page = store
                    .read_with(|conn| {
                        search_workspace_page(
                            conn,
                            root,
                            WS,
                            V,
                            query,
                            Some(page_size),
                            40,
                            Some(expected.generation),
                            after,
                        )
                    })
                    .expect("continued unicode page");
                assert_eq!(page.disposition, SearchPageDisposition::Results);
                assert!(!page.results.is_empty());
                actual.extend(page.results);
                if !page.has_more {
                    break;
                }
                let next = page.continuation.expect("continuation");
                assert_ne!(after, Some(next), "cursor must advance");
                after = Some(next);
                assert!(actual.len() <= expected.results.len());
            }
            assert_eq!(
                actual, expected.results,
                "query {query:?}, page size {page_size}"
            );
        }
    }
}

// -------------------------------------------------------- 1. index+query round-trip

#[test]
fn index_and_query_round_trip_files_and_chats() {
    let scratch = ScratchDir::new().expect("scratch");
    let root = scratch.path().to_path_buf();
    let db = engine_db_path(&scratch).expect("db");
    let mut store = open(&db, 1);

    write_file(
        &mut store,
        "obj-notes",
        "notes/plan.md",
        "the needle is here",
        10,
    );
    start_thread(&mut store, "chan-1", "th-1", "chat needle in message", 20);
    // A later appended message with a distinct term must also be indexed.
    send(&mut store, "th-1", "th-1-msg-1", "haystack reply", 25);
    ensure_index(&mut store, &root, 30);

    let results = run_search(&store, &root, "needle");
    assert!(
        results
            .iter()
            .any(|r| r.surface == SearchSurface::File && r.path == "notes/plan.md"),
        "file result missing: {results:?}"
    );
    assert!(
        results
            .iter()
            .any(|r| r.surface == SearchSurface::Chat && r.thread_id.as_deref() == Some("th-1")),
        "chat result missing: {results:?}"
    );
    // The appended message's own term round-trips through the message index.
    let haystack = run_search(&store, &root, "haystack");
    assert!(
        haystack
            .iter()
            .any(|r| r.surface == SearchSurface::Chat && r.thread_id.as_deref() == Some("th-1")),
        "appended chat message missing: {haystack:?}"
    );
}

// ---------------------------------------------------- 2. policy-filtered visibility

#[test]
fn secret_ignored_and_hidden_paths_never_appear() {
    let scratch = ScratchDir::new().expect("scratch");
    let root = scratch.path().to_path_buf();
    let db = engine_db_path(&scratch).expect("db");
    let mut store = open(&db, 1);

    // R07 closes the store door before search sees a row at all: plaintext
    // versioning refuses a secret .env. Then seed a normally-tracked file and a
    // visibility-hidden file with the same needle; only tracked may surface.
    {
        let mut versions = VersionedTextStore::new(&mut store);
        versions
            .ensure_main_version(WS, V, 10, &NO_FAULTS)
            .expect("ensure version");
        let err = versions
            .write_text(
                &WriteText {
                    workspace_id: WS.to_owned(),
                    version_id: V.to_owned(),
                    object_id: "obj-env".to_owned(),
                    path: "config/app.env".to_owned(),
                    text: "SECRET=needle".to_owned(),
                    moment_id: "m-obj-env-10".to_owned(),
                    metadata_origin: "test".to_owned(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: None,
                    now_ms: 10,
                    request_id: None,
                },
                &NO_FAULTS,
            )
            .expect_err("secret path must not enter plaintext snapshots");
        assert_eq!(err.code(), "invalid-path");
    }
    write_file(&mut store, "obj-ok", "notes/plan.md", "public needle", 11);
    write_file(
        &mut store,
        "obj-hide",
        "notes/private.md",
        "hidden needle",
        12,
    );

    // visibility.toml hides notes/private.md even though it is otherwise tracked.
    std::fs::create_dir_all(root.join(".dohc")).expect("mkdir");
    std::fs::write(
        root.join(".dohc").join("visibility.toml"),
        "[[rule]]\npath = \"notes/private.md\"\nvisibility = \"hidden\"\n",
    )
    .expect("write visibility");

    ensure_index(&mut store, &root, 30);
    let results = run_search(&store, &root, "needle");
    let paths: Vec<&str> = results.iter().map(|r| r.path.as_str()).collect();
    assert!(
        paths.contains(&"notes/plan.md"),
        "tracked file must appear: {paths:?}"
    );
    assert!(
        !paths.contains(&"config/app.env"),
        "secret .env must never appear"
    );
    assert!(
        !paths.contains(&"notes/private.md"),
        "hidden file must never appear"
    );

    // The refused `.env` is never in the raw FTS table either: the defense is
    // at the domain store door, not merely filtered at query time.
    let env_indexed: i64 = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM engine_search_files_fts WHERE path = ?1",
                rusqlite::params!["config/app.env"],
                |r| r.get(0),
            )
        })
        .expect("count");
    assert_eq!(env_indexed, 0, "secret path must not be indexed at all");
}

// ------------------------------------------ 3. fail-closed FILE policy, chat survives

#[test]
fn broken_file_policy_fails_closed_but_chat_search_survives() {
    let scratch = ScratchDir::new().expect("scratch");
    let root = scratch.path().to_path_buf();
    let db = engine_db_path(&scratch).expect("db");
    let mut store = open(&db, 1);

    write_file(&mut store, "obj-ok", "notes/plan.md", "file needle", 10);
    start_thread(&mut store, "chan-1", "th-1", "chat needle here", 20);

    // A malformed files.toml → FILE search fails closed (no file results), but
    // chat search is independent and stays available.
    std::fs::create_dir_all(root.join(".dohc")).expect("mkdir");
    std::fs::write(
        root.join(".dohc").join("files.toml"),
        "this is not = valid toml [[[",
    )
    .expect("write");

    ensure_index(&mut store, &root, 30);
    let results = run_search(&store, &root, "needle");
    assert!(
        !results.iter().any(|r| r.surface == SearchSurface::File),
        "broken file policy must yield NO file results: {results:?}"
    );
    assert!(
        results.iter().any(|r| r.surface == SearchSurface::Chat),
        "chat search must survive a broken file policy: {results:?}"
    );

    // The raw candidate query also fails the file half closed while the chat
    // half is populated.
    let candidates = store
        .read_with(|conn| candidates(conn, &root, "needle"))
        .expect("query");
    assert!(
        candidates
            .iter()
            .all(|c| matches!(c, SearchCandidate::Chat { .. }))
    );

    // Chat-only granular query is entirely unaffected by the file policy.
    let chat_hits = store
        .read_with(|conn| granular(conn, "needle"))
        .expect("granular");
    assert!(
        !chat_hits.is_empty(),
        "granular chat search unaffected by file policy"
    );

    // Removing the broken policy (ENOENT = defaults) restores file search. The
    // frozen index_state was invalidated, so a fresh ensure rebuilds files.
    std::fs::remove_file(root.join(".dohc").join("files.toml")).expect("rm");
    ensure_index(&mut store, &root, 40);
    let restored = run_search(&store, &root, "needle");
    assert!(
        restored
            .iter()
            .any(|r| r.surface == SearchSurface::File && r.path == "notes/plan.md"),
        "removing the broken policy (ENOENT=defaults) restores file search: {restored:?}"
    );
}

// ------------------------------------------------------ 4. read-your-writes / no tear

// -------------------------------------------- 5. crash at index-commit boundary repairs

#[test]
fn crash_mid_index_reopen_repairs() {
    let scratch = ScratchDir::new().expect("scratch");
    let root = scratch.path().to_path_buf();
    let db = engine_db_path(&scratch).expect("db");

    {
        let mut store = open(&db, 1);
        write_file(&mut store, "obj-ok", "notes/plan.md", "needle here", 10);
        start_thread(&mut store, "chan-1", "th-1", "chat needle", 20);

        // Arm a crash before the index transaction persists: the whole rebuild
        // (FTS rows + index_state) rolls back.
        let faults = ScriptedFaults::crash_at(FaultPoint::StorageBeforePersist);
        let outcome = store
            .write_with(faults.as_ref(), |tx| {
                ensure_search_index_for_version(tx, &root, WS, V, 30, &NO_FAULTS)
            })
            .expect("write");
        assert!(matches!(outcome, TxnOutcome::Crashed { committed: false }));
        assert!(faults.fired());

        // The crash left NO durable index generation and NO leaked FTS rows.
        let (state_rows, fts_rows): (i64, i64) = store
            .read_with(|conn| {
                let s: i64 = conn.query_row(
                    "SELECT COUNT(*) FROM engine_search_index_state WHERE workspace_id=?1 AND version_id=?2",
                    rusqlite::params![WS, V],
                    |r| r.get(0),
                )?;
                let f: i64 = conn.query_row(
                    "SELECT COUNT(*) FROM engine_search_files_fts WHERE workspace_id=?1",
                    rusqlite::params![WS],
                    |r| r.get(0),
                )?;
                Ok::<(i64, i64), rusqlite::Error>((s, f))
            })
            .expect("counts");
        assert_eq!(
            state_rows, 0,
            "crashed rebuild must leave no index generation"
        );
        assert_eq!(fts_rows, 0, "crashed rebuild must leave no torn FTS rows");
        // simulated process death
    }

    // Reopen and rebuild cleanly: the repair produces a complete index.
    let mut store = open(&db, 100);
    ensure_index(&mut store, &root, 110);
    let results = run_search(&store, &root, "needle");
    assert!(results.iter().any(|r| r.surface == SearchSurface::File));
    assert!(results.iter().any(|r| r.surface == SearchSurface::Chat));
}

// ------------------------------------------------------------------- 6. bounds

// ------------------------------------------------ 7. FTS5 config / trigram parity

// -------------------------------- 8. read_with rebuild is atomic across a crash

// ---------------------------------------- 9. an orphan thread never breaks search

// ----------------------- 10. legacy certification heals replicated chat once

// ------------------------------ 11. degraded policy does not re-index chat per query

// ------------------------------------ 12. many chat threads all return (single fetch)

// ------------------------------ 13. replicated chat writes feed the real reader

#[test]
fn replicated_chat_apply_is_findable_through_the_real_search_reader() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = engine_db_path(&scratch).expect("db");
    let mut store = open(&db, 1);
    let thread = replicated_envelope(
        "search-peer",
        0,
        "chat.thread.create",
        json!({
            "threadId": "replicated-thread",
            "title": "Replicated roadmap",
            "createdAtMs": 10,
            "linkedObjectId": "replicated-object",
            "linkedAtMs": 10
        }),
    );
    let message = replicated_envelope(
        "search-peer",
        1,
        "chat.message.append",
        json!({
            "messageId": "replicated-message",
            "threadId": "replicated-thread",
            "authorKind": "human",
            "authorDisplayName": "Sam",
            "body": "Synchronized quasar content",
            "createdAtMs": 20
        }),
    );

    assert!(matches!(
        apply_chat_envelope(&mut store, &thread, &NO_FAULTS),
        Ok(ApplyOutcome {
            primary: ApplyDisposition::Applied(_),
            refusals: ref outcome_refusals,
            sharing_declined: ref outcome_sharing_declined,
        }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
    ));
    assert!(matches!(
        apply_chat_envelope(&mut store, &message, &NO_FAULTS),
        Ok(ApplyOutcome {
            primary: ApplyDisposition::Applied(_),
            refusals: ref outcome_refusals,
            sharing_declined: ref outcome_sharing_declined,
        }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
    ));
    assert!(matches!(
        apply_chat_envelope(&mut store, &message, &NO_FAULTS),
        Ok(ApplyOutcome {
            primary: ApplyDisposition::Skipped,
            refusals: ref outcome_refusals,
            sharing_declined: ref outcome_sharing_declined,
        }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
    ));

    let title_hits = store
        .read_with(|conn| granular(conn, "roadmap"))
        .expect("thread-title search");
    assert_eq!(title_hits.len(), 1);
    assert_eq!(title_hits[0].thread_id, "replicated-thread");
    assert_eq!(title_hits[0].message_id, None);

    let message_hits = store
        .read_with(|conn| granular(conn, "quasar"))
        .expect("message search");
    assert_eq!(
        message_hits.len(),
        1,
        "duplicate delivery must not duplicate the FTS result"
    );
    assert_eq!(
        message_hits[0].message_id.as_deref(),
        Some("replicated-message")
    );
}

#[test]
fn shared_channel_replicated_chat_is_findable_through_the_real_search_reader() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = engine_db_path(&scratch).expect("db");
    let mut store = open(&db, 1);
    let boundary = ShareBoundary {
        share_id: "search-share".to_owned(),
        surface: ShareSurface::SharedChannel,
        channel_wire_id: Some("search-wire".to_owned()),
        granted: None,
    };
    let channel = replicated_envelope(
        "shared-peer",
        0,
        "chat.channel.create",
        json!({
            "channelId": "shared-channel",
            "name": "Search channel",
            "slug": "search-channel",
            "kind": "channel",
            "createdAtMs": 1,
            "wireId": "search-wire"
        }),
    );
    let thread = replicated_envelope(
        "shared-peer",
        1,
        "chat.thread.create",
        json!({
            "threadId": "shared-thread",
            "title": "Shared constellation",
            "createdAtMs": 2,
            "channelWireId": "search-wire"
        }),
    );
    let message = replicated_envelope(
        "shared-peer",
        2,
        "chat.message.append",
        json!({
            "messageId": "shared-message",
            "threadId": "shared-thread",
            "authorKind": "human",
            "authorDisplayName": "Sam",
            "body": "Shared supernova content",
            "createdAtMs": 3
        }),
    );

    for operation in [&channel, &thread, &message] {
        assert!(matches!(
            apply_shared_envelope(&mut store, &boundary, operation, &NO_FAULTS),
            Ok(ApplyOutcome {
                primary: ApplyDisposition::Applied(_),
                refusals: ref outcome_refusals,
                sharing_declined: ref outcome_sharing_declined,
            }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
        ));
    }

    let title_hits = store
        .read_with(|conn| granular(conn, "constellation"))
        .expect("shared title search");
    assert_eq!(title_hits.len(), 1);
    assert_eq!(title_hits[0].message_id, None);
    let message_hits = store
        .read_with(|conn| granular(conn, "supernova"))
        .expect("shared message search");
    assert_eq!(message_hits.len(), 1);
    assert_eq!(
        message_hits[0].message_id.as_deref(),
        Some("shared-message")
    );
}
