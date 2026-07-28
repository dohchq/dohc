//! R12 search traces: the index+query round-trip over REAL file snapshots and
//! chat messages (built through the versioning + chat domains, never hand-poked
//! FTS rows), policy-filtered visibility, the fail-closed FILE policy (scoped so
//! chat search survives a broken file policy), read-your-writes with no torn
//! mid-index visibility, durable index-state repair after a crash at the
//! index-commit boundary, the DoS bounds, and the FTS5-config parity checks.
//!
//! Fixtures are produced by `dohc-engine-domain` so the FTS index is fed the
//! same row shapes the product writes — the round-trip is non-tautological.

use dohc_engine_domain::{
    ChatActorKind, ChatChannelKind, DomainError, LinkedChatStore, SendMessage, StartChannelThread,
    VersionedTextStore, WriteBinaryFile, WriteText, write_binary_file_in_tx,
};
use dohc_engine_runtime::search::{
    CHAT_SEARCH_PAGE_SOURCE_BYTE_BUDGET, FILE_SEARCH_PAGE_SOURCE_BYTE_BUDGET,
    FILE_SEARCH_RESULT_SOURCE_BYTE_BUDGET, SearchCandidate, SearchPageDisposition, SearchSurface,
    ensure_search_index_for_version, query_chat_messages_granular,
    query_chat_messages_granular_bounded, query_search_index, query_search_index_keyset,
    search_workspace, search_workspace_page, upsert_file_search_index,
};
use dohc_engine_storage::{
    EngineStore, FaultPoint, NoFaults, Preimage, TxnOutcome, hex_sha256, put_binary_blob,
};
use dohc_engine_sync::{
    ApplyOutcome, ReplicationEnvelope, ShareBoundary, ShareSurface, apply_chat_envelope,
    apply_shared_envelope,
};
use dohc_engine_testkit::{ScratchDir, ScriptedFaults};
use serde_json::json;
use std::path::Path;

const WS: &str = "ws-1";
const V: &str = "v-main";
const NO_FAULTS: NoFaults = NoFaults;

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
        workspace_id: WS.to_owned(),
        origin_id: origin_id.to_owned(),
        origin_seq,
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
                workspace_id: WS.to_owned(),
                channel_id: channel_id.to_owned(),
                thread_id: thread_id.to_owned(),
                message_id: format!("{thread_id}-msg-0"),
                title: None,
                author_kind: ChatActorKind::Human,
                author_display_name: "Ada".to_owned(),
                author_user_id: Some("user-ada".to_owned()),
                origin: None,
                body: body.to_owned(),
                needs_decision: false,
                attachments: Vec::new(),
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
                workspace_id: WS.to_owned(),
                thread_id: thread_id.to_owned(),
                message_id: message_id.to_owned(),
                author_kind: ChatActorKind::Human,
                author_display_name: "Ada".to_owned(),
                author_user_id: Some("user-ada".to_owned()),
                parent_message_id: None,
                origin: None,
                body: body.to_owned(),
                needs_decision: false,
                attachments: Vec::new(),
                now_ms: now,
                request_id: None,
            },
            &NO_FAULTS,
        )
        .expect("send");
}

/// Build the index for the main version inside ONE transaction (atomic rebuild).
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
        .read_with(|conn| search_workspace(conn, root, WS, V, query, Some(100), 999))
        .expect("search")
}

#[test]
fn short_query_falls_back_to_a_bounded_linear_scan() {
    // MUTATION: convert query_search_index's short-query sentinel to an empty
    // candidate batch and both seeded two-character hits disappear.
    let scratch = ScratchDir::new().expect("scratch");
    let root = scratch.path().to_path_buf();
    let db = scratch.engine_db_path().expect("db");
    let mut store = open(&db, 1);
    write_file(&mut store, "obj-ai", "notes/ai.md", "AI operating plan", 10);
    start_thread(
        &mut store,
        "channel-ai",
        "thread-ai",
        "Discuss the AI plan",
        20,
    );
    ensure_index(&mut store, &root, 30);

    let results = run_search(&store, &root, "AI");
    assert!(
        results
            .iter()
            .any(|result| result.surface == SearchSurface::File && result.path == "notes/ai.md"),
        "short-query file fallback missing: {results:?}"
    );
    assert!(
        results.iter().any(|result| {
            result.surface == SearchSurface::Chat
                && result.thread_id.as_deref() == Some("thread-ai")
        }),
        "short-query chat fallback missing: {results:?}"
    );
}

#[test]
fn short_query_scan_caps_every_row_examined_even_without_matches() {
    // MUTATION: restore the SQL instr(lower(text), ...) filter or remove the raw
    // row cap and this no-match page scans all three rows and reports no
    // continuation.
    let scratch = ScratchDir::new().expect("scratch");
    let root = scratch.path().to_path_buf();
    let db = scratch.engine_db_path().expect("db");
    let mut store = open(&db, 1);
    for index in 0..3 {
        let text = if index == 2 {
            "zz target beyond the first page"
        } else {
            "ordinary content"
        };
        write_file(
            &mut store,
            &format!("obj-row-budget-{index}"),
            &format!("notes/row-budget-{index}.md"),
            text,
            10 + index,
        );
    }
    ensure_index(&mut store, &root, 30);

    let first = store
        .read_with(|conn| {
            query_search_index_keyset(
                conn,
                &root,
                WS,
                V,
                "zz",
                100,
                None,
                FILE_SEARCH_RESULT_SOURCE_BYTE_BUDGET,
                FILE_SEARCH_PAGE_SOURCE_BYTE_BUDGET,
                2,
            )
        })
        .expect("bounded short scan")
        .expect("candidate batch");
    assert!(first.candidates.is_empty());
    assert!(first.has_more, "the two-row scan must expose continuation");
    let resume = first.resume_after.expect("exclusive scan cursor");
    assert!(!resume.inclusive);

    let second = store
        .read_with(|conn| {
            query_search_index_keyset(
                conn,
                &root,
                WS,
                V,
                "zz",
                100,
                Some(resume),
                FILE_SEARCH_RESULT_SOURCE_BYTE_BUDGET,
                FILE_SEARCH_PAGE_SOURCE_BYTE_BUDGET,
                2,
            )
        })
        .expect("continued short scan")
        .expect("candidate batch");
    assert_eq!(second.candidates.len(), 1);
    assert!(!second.has_more);
}

#[test]
fn regular_fts_file_page_bounds_source_before_materializing_all_hits() {
    // MUTATION: apply the file source-byte accounting only to TooShort queries
    // and all three matching bodies are owned by this regular FTS page.
    let scratch = ScratchDir::new().expect("scratch");
    let root = scratch.path().to_path_buf();
    let db = scratch.engine_db_path().expect("db");
    let mut store = open(&db, 1);
    let text = format!("needle {}", "x".repeat(64));
    for index in 0..3 {
        write_file(
            &mut store,
            &format!("obj-source-budget-{index}"),
            &format!("notes/source-budget-{index}.md"),
            &text,
            10 + index,
        );
    }
    ensure_index(&mut store, &root, 30);

    let page_budget = text.len().saturating_mul(2).saturating_sub(1);
    let batch = store
        .read_with(|conn| {
            query_search_index_keyset(
                conn,
                &root,
                WS,
                V,
                "needle",
                100,
                None,
                FILE_SEARCH_RESULT_SOURCE_BYTE_BUDGET,
                page_budget,
                100,
            )
        })
        .expect("bounded regular FTS query")
        .expect("candidate batch");
    let owned_source_bytes: usize = batch
        .candidates
        .iter()
        .filter_map(|candidate| match candidate {
            SearchCandidate::File { text, .. } => Some(text.len()),
            SearchCandidate::Chat { .. } => None,
        })
        .sum();
    assert_eq!(batch.candidates.len(), 1);
    assert!(batch.has_more);
    assert!(owned_source_bytes <= page_budget);
}

#[test]
fn short_query_fallback_preserves_unicode_case_matching() {
    let scratch = ScratchDir::new().expect("scratch");
    let root = scratch.path().to_path_buf();
    let db = scratch.engine_db_path().expect("db");
    let mut store = open(&db, 1);
    write_file(
        &mut store,
        "obj-unicode-short",
        "notes/unicode-short.md",
        "ÉA file plan",
        10,
    );
    start_thread(
        &mut store,
        "channel-unicode-short",
        "thread-unicode-short",
        "topic\nÉA chat plan",
        20,
    );
    ensure_index(&mut store, &root, 30);

    let results = run_search(&store, &root, "éa");
    assert!(results.iter().any(|result| {
        result.surface == SearchSurface::File && result.path == "notes/unicode-short.md"
    }));
    assert!(results.iter().any(|result| {
        result.surface == SearchSurface::Chat
            && result.thread_id.as_deref() == Some("thread-unicode-short")
    }));
}

#[test]
fn inclusive_result_anchor_keeps_the_candidate_after_an_exhausted_row() {
    // A wire page can cut an actor result after the first candidate and mint an
    // inclusive line cursor even though that candidate has no later matching
    // line. MUTATION: truncate the inclusive candidate probe to `limit` and the
    // exhausted anchor consumes the only slot, hiding the second file.
    let scratch = ScratchDir::new().expect("scratch");
    let root = scratch.path().to_path_buf();
    let db = scratch.engine_db_path().expect("db");
    let mut store = open(&db, 1);
    write_file(
        &mut store,
        "obj-inclusive-first",
        "notes/inclusive-first.md",
        "needle first",
        10,
    );
    write_file(
        &mut store,
        "obj-inclusive-second",
        "notes/inclusive-second.md",
        "needle second",
        20,
    );
    ensure_index(&mut store, &root, 30);

    let first = store
        .read_with(|conn| {
            search_workspace_page(conn, &root, WS, V, "needle", Some(1), 999, None, None)
        })
        .expect("first bounded search page");
    let inclusive_anchor = first.results.first().expect("first hit").key;
    assert_eq!(inclusive_anchor.line, 1);

    let second = store
        .read_with(|conn| {
            search_workspace_page(
                conn,
                &root,
                WS,
                V,
                "needle",
                Some(1),
                999,
                Some(first.generation),
                Some(inclusive_anchor),
            )
        })
        .expect("inclusive continuation page");
    assert_eq!(second.results.len(), 1);
    assert_eq!(second.results[0].result.path, "notes/inclusive-second.md");
}

#[test]
fn oversized_chat_thread_hydration_stops_at_the_actor_page_budget() {
    // MUTATION: remove CHAT_SEARCH_PAGE_SOURCE_BYTE_BUDGET accounting and one
    // actor turn owns every 64 KiB body in this thread.
    let scratch = ScratchDir::new().expect("scratch");
    let root = scratch.path().to_path_buf();
    let db = scratch.engine_db_path().expect("db");
    let mut store = open(&db, 1);
    let prefix = "topic\nneedle ";
    let body = format!("{prefix}{}", "x".repeat(64 * 1024 - prefix.len()));
    start_thread(
        &mut store,
        "channel-oversized",
        "thread-oversized",
        &body,
        100,
    );
    for index in 1..10 {
        send(
            &mut store,
            "thread-oversized",
            &format!("oversized-message-{index}"),
            &body,
            100 + index,
        );
    }
    ensure_index(&mut store, &root, 200);

    let page = store
        .read_with(|conn| {
            search_workspace_page(conn, &root, WS, V, "needle", Some(100), 999, None, None)
        })
        .expect("bounded search page");
    assert_eq!(page.disposition, SearchPageDisposition::Results);
    assert!(
        page.has_more,
        "oversized thread must produce a continuation"
    );
    assert!(
        page.results.len() < 10,
        "one page hydrated the whole oversized thread: {:?}",
        page.results
    );
    assert_eq!(CHAT_SEARCH_PAGE_SOURCE_BYTE_BUDGET, 256 * 1024);

    let compatibility_results = run_search(&store, &root, "needle");
    assert_eq!(
        compatibility_results.len(),
        10,
        "the unpaged wrapper must consume every bounded actor page"
    );

    let mut cursor = page.continuation;
    let mut generation = Some(page.generation);
    let mut paged_results = page.results.len();
    while let Some(after) = cursor {
        let next = store
            .read_with(|conn| {
                search_workspace_page(
                    conn,
                    &root,
                    WS,
                    V,
                    "needle",
                    Some(100 - i64::try_from(paged_results).unwrap_or(100)),
                    999,
                    generation,
                    Some(after),
                )
            })
            .expect("continued bounded search page");
        paged_results = paged_results.saturating_add(next.results.len());
        generation = Some(next.generation);
        cursor = next.continuation;
        if !next.has_more {
            break;
        }
    }
    assert_eq!(
        paged_results, 10,
        "inclusive candidate anchors must not hide the following candidate"
    );
}

#[test]
fn chat_projection_lines_follow_canonical_replication_order() {
    // A replicated message can receive a later local message_order while
    // carrying an earlier source timestamp. MUTATION: order projection context
    // by message_order and the replicated hit moves from line 11 to line 15.
    let scratch = ScratchDir::new().expect("scratch");
    let root = scratch.path().to_path_buf();
    let db = scratch.engine_db_path().expect("db");
    let mut store = open(&db, 1);
    start_thread(
        &mut store,
        "channel-order",
        "thread-order",
        "opening message",
        100,
    );
    send(
        &mut store,
        "thread-order",
        "message-local-newer",
        "local newer body",
        200,
    );
    send(
        &mut store,
        "thread-order",
        "message-replicated-older",
        "replicated needle",
        150,
    );
    ensure_index(&mut store, &root, 300);

    let results = run_search(&store, &root, "replicated needle");
    let hit = results
        .iter()
        .find(|result| result.thread_id.as_deref() == Some("thread-order"))
        .expect("replicated message hit");
    assert_eq!(hit.line, 11);
}

#[test]
fn chat_projection_lines_include_prior_multiline_message_bodies() {
    let scratch = ScratchDir::new().expect("scratch");
    let root = scratch.path().to_path_buf();
    let db = scratch.engine_db_path().expect("db");
    let mut store = open(&db, 1);
    start_thread(
        &mut store,
        "channel-multiline",
        "thread-multiline",
        "opening line\nsecond line\nthird line",
        100,
    );
    send(
        &mut store,
        "thread-multiline",
        "message-after-multiline",
        "multiline offset needle",
        200,
    );
    ensure_index(&mut store, &root, 300);

    let results = run_search(&store, &root, "multiline offset needle");
    let hit = results
        .iter()
        .find(|result| result.thread_id.as_deref() == Some("thread-multiline") && result.line > 1)
        .expect("message hit");
    assert_eq!(hit.line, 13);
}

#[test]
fn untitled_chat_search_uses_the_complete_first_line_for_its_title() {
    let scratch = ScratchDir::new().expect("scratch");
    let root = scratch.path().to_path_buf();
    let db = scratch.engine_db_path().expect("db");
    let mut store = open(&db, 1);
    let body = format!("{}Actual topic\nsearchable detail", " ".repeat(160));
    start_thread(&mut store, "channel-title", "thread-title", &body, 100);
    ensure_index(&mut store, &root, 200);

    let results = run_search(&store, &root, "Actual topic");
    assert!(!results.is_empty());
    assert!(
        results.iter().all(|result| result.title == "Actual topic"),
        "search hydration diverged from the canonical thread title: {results:?}"
    );
}

#[test]
fn granular_chat_query_bounds_owned_rows_before_actor_delivery() {
    let scratch = ScratchDir::new().expect("scratch");
    let root = scratch.path().to_path_buf();
    let db = scratch.engine_db_path().expect("db");
    let mut store = open(&db, 1);
    let body = format!("needle {}", "x".repeat(8 * 1024));
    start_thread(&mut store, "channel-budget", "thread-budget", &body, 10);
    for index in 1..10 {
        send(
            &mut store,
            "thread-budget",
            &format!("message-budget-{index}"),
            &body,
            10 + index,
        );
    }
    ensure_index(&mut store, &root, 30);

    let byte_budget = 20 * 1024;
    let batch = store
        .read_with(|conn| {
            query_chat_messages_granular_bounded(conn, WS, "needle", 50_000, byte_budget)
        })
        .expect("bounded granular query");
    let owned_bytes: usize = batch
        .results
        .iter()
        .map(|row| {
            row.thread_id.len() + row.message_id.as_ref().map_or(0, String::len) + row.text.len()
        })
        .sum();

    assert!(
        batch.saturated_by_bytes,
        "the query must report that matching rows remain after the byte cut"
    );
    assert!(
        batch.results.len() < 10,
        "the actor result must not own every broad-query match"
    );
    assert!(
        owned_bytes <= byte_budget,
        "owned row bytes {owned_bytes} exceeded materialization budget {byte_budget}"
    );
}

// -------------------------------------------------------- 1. index+query round-trip

#[test]
fn index_and_query_round_trip_files_and_chats() {
    let scratch = ScratchDir::new().expect("scratch");
    let root = scratch.path().to_path_buf();
    let db = scratch.engine_db_path().expect("db");
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
    let db = scratch.engine_db_path().expect("db");
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
    let db = scratch.engine_db_path().expect("db");
    let mut store = open(&db, 1);

    write_file(&mut store, "obj-ok", "notes/plan.md", "file needle", 10);
    start_thread(&mut store, "chan-1", "th-1", "chat needle here", 20);

    // A malformed files.toml → FILE search fails CLOSED (no file results), but
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
        .read_with(|conn| query_search_index(conn, &root, WS, V, "needle", 100))
        .expect("query")
        .expect("some");
    assert!(
        candidates
            .iter()
            .all(|c| matches!(c, SearchCandidate::Chat { .. }))
    );

    // Chat-only granular query is entirely unaffected by the file policy.
    let chat_hits = store
        .read_with(|conn| query_chat_messages_granular(conn, WS, "needle", 100))
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

#[test]
fn read_your_writes_same_txn_no_torn_index() {
    let scratch = ScratchDir::new().expect("scratch");
    let root = scratch.path().to_path_buf();
    let db = scratch.engine_db_path().expect("db");
    let mut store = open(&db, 1);

    // Seed three files, then in ONE transaction rebuild the index AND upsert a
    // fourth file, and immediately query WITHIN the same transaction: the query
    // must observe the whole committed generation (all four), never a partial.
    write_file(&mut store, "obj-a", "a.md", "alpha needle", 10);
    write_file(&mut store, "obj-b", "b.md", "beta needle", 11);
    write_file(&mut store, "obj-c", "c.md", "gamma needle", 12);
    ensure_index(&mut store, &root, 20);

    // Add a fourth file's snapshot (domain write), then index+read it inside one txn.
    write_file(&mut store, "obj-d", "d.md", "delta needle", 30);
    let outcome = store
        .write_with(&NO_FAULTS, |tx| {
            upsert_file_search_index(tx, &root, WS, V, "obj-d", "d.md", "delta needle")?;
            // Read-your-writes: the just-upserted row is visible in the same txn.
            let candidates =
                query_search_index(tx, &root, WS, V, "delta", 100)?.unwrap_or_default();
            Ok::<bool, dohc_engine_runtime::SearchError>(
                candidates
                    .iter()
                    .any(|c| matches!(c, SearchCandidate::File { path, .. } if path == "d.md")),
            )
        })
        .expect("txn");
    let found = match outcome {
        TxnOutcome::Committed(found) => found,
        TxnOutcome::Crashed { .. } => panic!("no fault armed"),
    };
    assert!(found, "a query in the indexing txn must see its own write");

    // After commit, all four "needle" files are present — no torn generation.
    let results = run_search(&store, &root, "needle");
    let file_paths: std::collections::HashSet<&str> = results
        .iter()
        .filter(|r| r.surface == SearchSurface::File)
        .map(|r| r.path.as_str())
        .collect();
    for p in ["a.md", "b.md", "c.md", "d.md"] {
        assert!(
            file_paths.contains(p),
            "missing {p} after commit: {file_paths:?}"
        );
    }
}

// -------------------------------------------- 5. crash at index-commit boundary repairs

#[test]
fn crash_mid_index_reopen_repairs() {
    let scratch = ScratchDir::new().expect("scratch");
    let root = scratch.path().to_path_buf();
    let db = scratch.engine_db_path().expect("db");

    {
        let mut store = open(&db, 1);
        write_file(&mut store, "obj-ok", "notes/plan.md", "needle here", 10);
        start_thread(&mut store, "chan-1", "th-1", "chat needle", 20);

        // Arm a crash BEFORE the index transaction persists: the whole rebuild
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

#[test]
fn bounds_query_length_and_limit() {
    let scratch = ScratchDir::new().expect("scratch");
    let root = scratch.path().to_path_buf();
    let db = scratch.engine_db_path().expect("db");
    let mut store = open(&db, 1);

    write_file(&mut store, "obj-ok", "a.md", "needle needle needle", 10);
    ensure_index(&mut store, &root, 20);

    // The orchestration consumes the primitive's fallback sentinel with a
    // bounded linear scan.
    assert!(
        run_search(&store, &root, "ne")
            .iter()
            .any(|result| result.path == "a.md")
    );

    // A pathologically long query is bounded (no results, no FTS blow-up).
    let long = "n".repeat(50_000);
    assert!(run_search(&store, &root, &long).is_empty());
    // At the primitive: an over-long query FAILS CLOSED (Some(empty)), never the
    // `None` fallback sentinel — so an adapter cannot turn it into a linear scan.
    let overlong = store
        .read_with(|conn| query_search_index(conn, &root, WS, V, &long, 100))
        .expect("q");
    assert_eq!(
        overlong,
        Some(Vec::new()),
        "over-long query must fail closed, not fall back"
    );
    // A too-short query under a healthy policy stays the fallback sentinel (None).
    let short = store
        .read_with(|conn| query_search_index(conn, &root, WS, V, "ne", 100))
        .expect("q");
    assert!(
        short.is_none(),
        "sub-trigram query keeps the None fallback sentinel"
    );

    // limit <= 0 short-circuits.
    let none = store
        .read_with(|conn| search_workspace(conn, &root, WS, V, "needle", Some(0), 30))
        .expect("search");
    assert!(none.is_empty());

    // A positive limit caps the result count.
    let capped = store
        .read_with(|conn| search_workspace(conn, &root, WS, V, "needle", Some(1), 30))
        .expect("search");
    assert_eq!(capped.len(), 1);
}

// ------------------------------------------------ 7. FTS5 config / trigram parity

#[test]
fn trigram_prefilter_is_case_insensitive_and_min_three() {
    let scratch = ScratchDir::new().expect("scratch");
    let root = scratch.path().to_path_buf();
    let db = scratch.engine_db_path().expect("db");
    let mut store = open(&db, 1);

    write_file(
        &mut store,
        "obj-ok",
        "a.md",
        "The Needle Is CAPITALISED",
        10,
    );
    ensure_index(&mut store, &root, 20);

    // Trigram tokenizer default is case-insensitive: a lowercase query matches
    // mixed-case text (the FTS prefilter must not drop the true match).
    let hits = store
        .read_with(|conn| query_search_index(conn, &root, WS, V, "needle", 100))
        .expect("query")
        .expect("some");
    assert!(
        hits.iter()
            .any(|c| matches!(c, SearchCandidate::File { path, .. } if path == "a.md"))
    );

    // A 3-char query is served (min trigram length); a 2-char one is not.
    let three = store
        .read_with(|conn| query_search_index(conn, &root, WS, V, "cap", 100))
        .expect("q3");
    assert!(three.is_some());
    let two = store
        .read_with(|conn| query_search_index(conn, &root, WS, V, "ca", 100))
        .expect("q2");
    assert!(
        two.is_none(),
        "sub-trigram query falls back (None) under a healthy policy"
    );
}

// -------------------------------- 8. read_with rebuild is atomic across a crash

/// The P1 regression: `search_workspace`/`ensure` can run on an autocommit
/// (`read_with`) connection. A crash MID-rebuild — after the chat FTS wipe,
/// before the rebuild inserts — must NOT leave a torn/empty generation. The
/// savepoint inside `ensure_search_index_for_version` is what guarantees this on
/// a connection with no enclosing transaction.
#[test]
fn read_with_rebuild_is_atomic_across_mid_rebuild_crash() {
    let scratch = ScratchDir::new().expect("scratch");
    let root = scratch.path().to_path_buf();
    let db = scratch.engine_db_path().expect("db");
    let mut store = open(&db, 1);

    write_file(&mut store, "obj-ok", "notes/plan.md", "needle here", 10);
    start_thread(&mut store, "chan-1", "th-1", "chat needle", 20);
    ensure_index(&mut store, &root, 30); // healthy: chat indexed, state row set

    let count_chat = |store: &EngineStore| -> i64 {
        store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT COUNT(*) FROM engine_search_chat_messages_fts WHERE workspace_id=?1",
                    rusqlite::params![WS],
                    |r| r.get(0),
                )
            })
            .expect("count")
    };
    let before = count_chat(&store);
    assert!(before > 0, "chat index should be populated");

    // Force a re-index by dropping the state row (mirrors a degraded-window
    // invalidation), then run ensure on a READ_WITH (autocommit) connection with
    // a mid-rebuild crash armed.
    store
        .write_with(&NO_FAULTS, |tx| {
            tx.execute(
                "DELETE FROM engine_search_index_state WHERE workspace_id=?1",
                rusqlite::params![WS],
            )?;
            Ok::<(), dohc_engine_runtime::SearchError>(())
        })
        .expect("drop state");

    let faults = ScriptedFaults::crash_at(FaultPoint::SearchIndexMidRebuild);
    store
        .read_with(|conn| ensure_search_index_for_version(conn, &root, WS, V, 40, faults.as_ref()))
        .expect("ensure on read_with");
    assert!(faults.fired(), "the mid-rebuild crash must have fired");

    // Atomicity: the chat wipe rolled back — the prior generation is intact, not
    // a torn/empty index, and no state row was certified.
    assert_eq!(
        count_chat(&store),
        before,
        "a mid-rebuild crash on the read_with path must preserve the prior generation"
    );
    let state_rows: i64 = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM engine_search_index_state WHERE workspace_id=?1",
                rusqlite::params![WS],
                |r| r.get(0),
            )
        })
        .expect("state count");
    assert_eq!(state_rows, 0, "no torn generation may be certified");
    // The granular reader (which never calls ensure) sees the intact rows.
    let hits = store
        .read_with(|conn| query_chat_messages_granular(conn, WS, "needle", 100))
        .expect("granular");
    assert!(
        !hits.is_empty(),
        "granular chat search sees no torn/partial state"
    );

    // A clean re-run repairs and certifies.
    store
        .read_with(|conn| ensure_search_index_for_version(conn, &root, WS, V, 50, &NO_FAULTS))
        .expect("repair");
    let repaired = run_search(&store, &root, "needle");
    assert!(repaired.iter().any(|r| r.surface == SearchSurface::Chat));
}

// ---------------------------------------- 9. an orphan thread never breaks search

#[test]
fn orphan_thread_does_not_disable_all_search() {
    let scratch = ScratchDir::new().expect("scratch");
    let root = scratch.path().to_path_buf();
    let db = scratch.engine_db_path().expect("db");
    let mut store = open(&db, 1);

    write_file(&mut store, "obj-ok", "notes/plan.md", "needle here", 10);
    start_thread(&mut store, "chan-1", "th-1", "chat needle", 20);
    ensure_index(&mut store, &root, 30);

    // Delete the channel out from under its thread (chat_threads.channel_id has
    // no FK/cascade), orphaning th-1, and drop the state row to force a rebuild.
    store
        .write_with(&NO_FAULTS, |tx| {
            tx.execute(
                "DELETE FROM chat_channels WHERE workspace_id=?1 AND channel_id=?2",
                rusqlite::params![WS, "chan-1"],
            )?;
            tx.execute(
                "DELETE FROM engine_search_index_state WHERE workspace_id=?1",
                rusqlite::params![WS],
            )?;
            Ok::<(), dohc_engine_runtime::SearchError>(())
        })
        .expect("orphan");

    // The rebuild must SKIP the orphan thread's header, not hard-error the whole
    // search surface: file search still works.
    let results = run_search(&store, &root, "needle");
    assert!(
        results
            .iter()
            .any(|r| r.surface == SearchSurface::File && r.path == "notes/plan.md"),
        "an orphan thread must not disable file search: {results:?}"
    );
}

// ----------------------- 10. legacy certification heals replicated chat once

#[test]
fn legacy_certified_store_backfills_missing_chat_fts_on_first_search() {
    let scratch = ScratchDir::new().expect("scratch");
    let root = scratch.path().to_path_buf();
    let db = scratch.engine_db_path().expect("db");
    let mut store = open(&db, 1);

    start_thread(
        &mut store,
        "legacy-channel",
        "legacy-thread",
        "Legacy replicated backfill needle",
        20,
    );
    ensure_index(&mut store, &root, 30);

    store
        .write_with(&NO_FAULTS, |tx| {
            tx.execute(
                "DELETE FROM engine_search_chat_messages_fts WHERE workspace_id=?1",
                rusqlite::params![WS],
            )?;
            tx.execute(
                "UPDATE engine_search_index_state SET indexed_at_ms=30 \
                 WHERE workspace_id=?1 AND version_id=?2",
                rusqlite::params![WS, V],
            )?;
            Ok::<(), dohc_engine_runtime::SearchError>(())
        })
        .expect("simulate legacy certified store");

    let before = store
        .read_with(|conn| query_chat_messages_granular(conn, WS, "backfill", 100))
        .expect("pre-upgrade granular query");
    assert!(
        before.is_empty(),
        "fixture must begin without a chat FTS row"
    );

    let results = run_search(&store, &root, "backfill");
    assert!(
        results
            .iter()
            .any(|result| result.surface == SearchSurface::Chat
                && result.thread_id.as_deref() == Some("legacy-thread")),
        "the first search after upgrade must rebuild legacy-certified chat rows: {results:?}"
    );
}

// ------------------------------ 11. degraded policy does not re-index chat per query

#[test]
fn degraded_policy_does_not_reindex_chat_per_query() {
    let scratch = ScratchDir::new().expect("scratch");
    let root = scratch.path().to_path_buf();
    let db = scratch.engine_db_path().expect("db");
    let mut store = open(&db, 1);

    start_thread(&mut store, "chan-1", "th-1", "chat needle", 20);
    std::fs::create_dir_all(root.join(".dohc")).expect("mkdir");
    std::fs::write(root.join(".dohc").join("files.toml"), "not = valid [[[").expect("write");

    ensure_index(&mut store, &root, 30); // degraded: chat built, state row degraded=1

    // FTS rowid is monotonic on insert, so a re-wipe+rebuild would advance
    // MAX(rowid). Capture it, run several searches, and assert it is UNCHANGED —
    // proving the stable degraded window does not re-index chat per query.
    let max_rowid = |store: &EngineStore| -> i64 {
        store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT COALESCE(MAX(rowid), 0) FROM engine_search_chat_messages_fts WHERE workspace_id=?1",
                    rusqlite::params![WS],
                    |r| r.get(0),
                )
            })
            .expect("max rowid")
    };
    let baseline = max_rowid(&store);
    assert!(baseline > 0, "chat index built once under degraded policy");

    for _ in 0..4 {
        let results = run_search(&store, &root, "needle");
        assert!(results.iter().any(|r| r.surface == SearchSurface::Chat));
        assert!(
            !results.iter().any(|r| r.surface == SearchSurface::File),
            "file search stays closed under a broken files.toml"
        );
    }
    assert_eq!(
        max_rowid(&store),
        baseline,
        "chat must not be re-indexed on every query during a stable degraded window"
    );
}

// ------------------------------------ 12. many chat threads all return (single fetch)

#[test]
fn multiple_chat_threads_all_return() {
    let scratch = ScratchDir::new().expect("scratch");
    let root = scratch.path().to_path_buf();
    let db = scratch.engine_db_path().expect("db");
    let mut store = open(&db, 1);

    // Several threads each matching the query; the grouped single-fetch preview
    // must surface every one.
    start_thread(&mut store, "chan-1", "th-1", "alpha needle one", 20);
    start_thread(&mut store, "chan-2", "th-2", "beta needle two", 21);
    start_thread(&mut store, "chan-3", "th-3", "gamma needle three", 22);
    ensure_index(&mut store, &root, 30);

    let results = run_search(&store, &root, "needle");
    for th in ["th-1", "th-2", "th-3"] {
        assert!(
            results
                .iter()
                .any(|r| r.surface == SearchSurface::Chat && r.thread_id.as_deref() == Some(th)),
            "thread {th} missing from grouped chat previews: {results:?}"
        );
    }
}

/// Finding C (search correctness): when a binary write overwrites an
/// already-indexed TEXT file, the file FTS row is frozen (the lazy index never
/// rebuilds, and the rebuild-time binary exclusion never cleans an already-built
/// index). The query reader must therefore drop a candidate whose LIVE head is
/// now binary — otherwise the binary file stays searchable by its stale former
/// text.
#[test]
fn binary_overwrite_of_indexed_text_is_no_longer_searchable() {
    let scratch = ScratchDir::new().expect("scratch");
    let root = scratch.path().to_path_buf();
    let db = scratch.engine_db_path().expect("db");
    let mut store = open(&db, 1);

    write_file(
        &mut store,
        "obj-notes",
        "notes/plan.md",
        "the needle is here",
        10,
    );
    ensure_index(&mut store, &root, 30);
    assert!(
        run_search(&store, &root, "needle")
            .iter()
            .any(|r| r.surface == SearchSurface::File && r.path == "notes/plan.md"),
        "text file must be searchable before the binary overwrite"
    );

    // Overwrite the SAME path/object with a BINARY head (no index rebuild).
    let bytes = b"\x00binary now\xff".as_slice();
    let sha = hex_sha256(bytes);
    store
        .write_with(&NO_FAULTS, |tx| {
            put_binary_blob(tx, bytes).map_err(DomainError::from)?;
            write_binary_file_in_tx(
                tx,
                &WriteBinaryFile {
                    workspace_id: WS.to_owned(),
                    version_id: V.to_owned(),
                    object_id: "obj-notes".to_owned(),
                    path: "notes/plan.md".to_owned(),
                    binary_sha256: sha,
                    moment_id: "bin-overwrite".to_owned(),
                    metadata_origin: "sync".to_owned(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: None,
                    materialize: Some(Preimage::Absent),
                    now_ms: 40,
                },
            )?;
            Ok::<_, DomainError>(())
        })
        .expect("binary overwrite");

    // The stale text FTS row is still present, but the reader must not serve it.
    let after = run_search(&store, &root, "needle");
    assert!(
        !after
            .iter()
            .any(|r| r.surface == SearchSurface::File && r.path == "notes/plan.md"),
        "a binary-overwritten path must not be served by its stale former text: {after:?}"
    );
}

// ------------------------------ 13. replicated chat writes feed the real reader

#[test]
fn replicated_chat_apply_is_findable_through_the_real_search_reader() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
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
            "authorDisplayName": "Ice",
            "body": "Synchronized quasar content",
            "createdAtMs": 20
        }),
    );

    assert!(matches!(
        apply_chat_envelope(&mut store, &thread, &NO_FAULTS),
        Ok(ApplyOutcome::Applied(()))
    ));
    assert!(matches!(
        apply_chat_envelope(&mut store, &message, &NO_FAULTS),
        Ok(ApplyOutcome::Applied(()))
    ));
    assert!(matches!(
        apply_chat_envelope(&mut store, &message, &NO_FAULTS),
        Ok(ApplyOutcome::Skipped)
    ));

    let title_hits = store
        .read_with(|conn| query_chat_messages_granular(conn, WS, "roadmap", 100))
        .expect("thread-title search");
    assert_eq!(title_hits.len(), 1);
    assert_eq!(title_hits[0].thread_id, "replicated-thread");
    assert_eq!(title_hits[0].message_id, None);

    let message_hits = store
        .read_with(|conn| query_chat_messages_granular(conn, WS, "quasar", 100))
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
fn parked_replicated_message_is_findable_after_thread_promotion() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    let mut store = open(&db, 1);
    let message = replicated_envelope(
        "early-peer",
        0,
        "chat.message.append",
        json!({
            "messageId": "parked-message",
            "threadId": "late-thread",
            "authorKind": "human",
            "authorDisplayName": "Ice",
            "body": "Parked comet content",
            "createdAtMs": 20
        }),
    );
    let thread = replicated_envelope(
        "late-peer",
        0,
        "chat.thread.create",
        json!({
            "threadId": "late-thread",
            "title": "Late arrival",
            "createdAtMs": 10,
            "linkedObjectId": "late-object",
            "linkedAtMs": 10
        }),
    );

    apply_chat_envelope(&mut store, &message, &NO_FAULTS).expect("park message");
    apply_chat_envelope(&mut store, &thread, &NO_FAULTS).expect("promote message");

    let hits = store
        .read_with(|conn| query_chat_messages_granular(conn, WS, "comet", 100))
        .expect("promoted message search");
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].message_id.as_deref(), Some("parked-message"));
}

#[test]
fn shared_channel_replicated_chat_is_findable_through_the_real_search_reader() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    let mut store = open(&db, 1);
    let boundary = ShareBoundary {
        share_id: "search-share".to_owned(),
        surface: ShareSurface::SharedChannel,
        channel_wire_id: Some("search-wire".to_owned()),
        path_prefix: None,
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
            "authorDisplayName": "Ice",
            "body": "Shared supernova content",
            "createdAtMs": 3
        }),
    );

    for operation in [&channel, &thread, &message] {
        assert!(matches!(
            apply_shared_envelope(&mut store, &boundary, operation, &NO_FAULTS),
            Ok(ApplyOutcome::Applied(_))
        ));
    }

    let title_hits = store
        .read_with(|conn| query_chat_messages_granular(conn, WS, "constellation", 100))
        .expect("shared title search");
    assert_eq!(title_hits.len(), 1);
    assert_eq!(title_hits[0].message_id, None);
    let message_hits = store
        .read_with(|conn| query_chat_messages_granular(conn, WS, "supernova", 100))
        .expect("shared message search");
    assert_eq!(message_hits.len(), 1);
    assert_eq!(
        message_hits[0].message_id.as_deref(),
        Some("shared-message")
    );
}
