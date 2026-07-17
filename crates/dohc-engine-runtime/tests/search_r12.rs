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
    ChatActorKind, ChatChannelKind, LinkedChatStore, SendMessage, StartChannelThread,
    VersionedTextStore, WriteText,
};
use dohc_engine_runtime::search::{
    SearchCandidate, SearchSurface, ensure_search_index_for_version, query_chat_messages_granular,
    query_search_index, search_workspace, upsert_file_search_index,
};
use dohc_engine_storage::{EngineStore, FaultPoint, NoFaults, TxnOutcome};
use dohc_engine_testkit::{ScratchDir, ScriptedFaults};
use std::path::Path;

const WS: &str = "ws-1";
const V: &str = "v-main";
const NO_FAULTS: NoFaults = NoFaults;

fn open(db: &Path, now: i64) -> EngineStore {
    EngineStore::open(db, now).expect("open")
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
            "General",
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
            ensure_search_index_for_version(tx, root, WS, V, now)
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

    // A secret .env, a normally-tracked file, and a visibility-hidden file, all
    // containing the same needle. Only the tracked one may surface.
    write_file(&mut store, "obj-env", "config/app.env", "SECRET=needle", 10);
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

    // A direct `.env` write is never in the raw FTS table either (defense in
    // depth: not merely filtered at read time, never indexed).
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
                ensure_search_index_for_version(tx, &root, WS, V, 30)
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

    // A too-short query returns nothing from the index-backed search.
    assert!(run_search(&store, &root, "ne").is_empty());

    // A pathologically long query is bounded (no results, no FTS blow-up).
    let long = "n".repeat(50_000);
    assert!(run_search(&store, &root, &long).is_empty());

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
