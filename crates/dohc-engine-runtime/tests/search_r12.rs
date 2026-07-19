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
    SearchCandidate, SearchSurface, ensure_search_index_for_version, query_chat_messages_granular,
    query_search_index, search_workspace, upsert_file_search_index,
};
use dohc_engine_storage::{
    EngineStore, FaultPoint, NoFaults, Preimage, TxnOutcome, hex_sha256, put_binary_blob,
};
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

    // A too-short query returns nothing from the index-backed search.
    assert!(run_search(&store, &root, "ne").is_empty());

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

// ------------------------------ 10. degraded policy does not re-index chat per query

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

// ------------------------------------ 11. many chat threads all return (single fetch)

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
