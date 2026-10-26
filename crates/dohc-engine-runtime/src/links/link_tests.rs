use super::*;
use dohc_engine_domain::{
    CreateNamedVersion, DomainError, RollbackTextFileMutation, VersionedTextStore, WriteText,
};
use dohc_engine_storage::{FaultPoint, hex_sha256};
use dohc_engine_testkit::{ScratchDir, ScriptedFaults, engine_db_path};
use std::path::Path;

thread_local! {
    static WAL_THRESHOLD: std::cell::Cell<i32> = const { std::cell::Cell::new(0) };
    static WAL_CHECKPOINT_RAN: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

pub(super) fn observe_checkpoints(store: &EngineStore) {
    store
        .read_with(|c| {
            let threshold: i32 = c.query_row("PRAGMA wal_autocheckpoint", [], |r| r.get(0))?;
            WAL_THRESHOLD.set(threshold);
            // Match sqlite3WalDefaultHook: same threshold, passive checkpoint,
            // and ignored checkpoint errors. This hook exists only in tests.
            c.wal_hook(Some(|wal, frames| {
                let threshold = WAL_THRESHOLD.get();
                if threshold > 0 && frames >= threshold {
                    WAL_CHECKPOINT_RAN.set(true);
                    let _ = wal.checkpoint();
                }
                Ok(())
            }));
            Ok::<_, rusqlite::Error>(())
        })
        .unwrap();
}

pub(super) fn begin_tick_measurement() {
    WAL_CHECKPOINT_RAN.set(false);
}

pub(super) fn report_slow_tick(duration: Duration, phase: &str) {
    if duration > ACTOR_SLICE_BUDGET {
        eprintln!(
            "slow links tick: phase={phase} actor_us={} wal_checkpoint_ran={}",
            duration.as_micros(),
            WAL_CHECKPOINT_RAN.get()
        );
    }
}

fn open(path: &Path) -> EngineStore {
    EngineStore::open_for_actor(path, 1, None, None).unwrap()
}
fn client_busy_budget() -> Duration {
    static BUDGET: std::sync::OnceLock<Duration> = std::sync::OnceLock::new();
    *BUDGET.get_or_init(|| {
        let policy: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../packages/workspace-engine-client/src/daemon/storeBusyRetry.json"
        ))
        .unwrap();
        Duration::from_millis(policy["engineStoreBusyRetryMs"].as_u64().unwrap())
    })
}
fn write(s: &mut EngineStore, object: &str, path: &str, text: &str, n: i64) {
    write_fixture(s, object, path, text, n, true);
}
fn write_deferred(s: &mut EngineStore, object: &str, path: &str, text: &str, n: i64) {
    write_fixture(s, object, path, text, n, false);
}
fn write_fixture(
    s: &mut EngineStore,
    object: &str,
    path: &str,
    text: &str,
    n: i64,
    seed_empty: bool,
) {
    // Ordinary invalidation fixtures begin with a completed empty seed. Tests
    // for startup use write_deferred and exercise the production obligation.
    let input = WriteText {
        workspace_id: "ws".into(),
        version_id: "main".into(),
        object_id: object.into(),
        path: path.into(),
        text: text.into(),
        moment_id: format!("m-{object}-{n}"),
        metadata_origin: "test".into(),
        metadata_summary: None,
        metadata_correlation_id: None,
        author_json: None,
        now_ms: n,
        request_id: None,
    };
    retry_file_locked("link fixture write", || {
        VersionedTextStore::new(s).ensure_main_version("ws", "main", 1, &NoFaults)?;
        if seed_empty {
            while seed_step(s)? {}
        }
        VersionedTextStore::new(s).write_text(&input, &NoFaults)
    });
}

fn count(s: &EngineStore, table: &str) -> i64 {
    s.read_with(|c| c.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0)))
        .unwrap()
}
fn parsed(s: &EngineStore) -> Staged {
    let (w, h) = prepare(s).unwrap().unwrap();
    Staged::new(parser::parse(w, h).unwrap())
}
fn retry_file_locked<T, E: Into<DomainError>>(
    label: &str,
    mut operation: impl FnMut() -> Result<T, E>,
) -> T {
    let deadline = Instant::now() + client_busy_budget();
    let mut backoff = Duration::from_millis(5);
    loop {
        match operation().map_err(Into::into) {
            Ok(value) => return value,
            Err(DomainError::Storage(StorageError::FileLocked)) => {
                let remaining = deadline.saturating_duration_since(Instant::now());
                assert!(
                    !remaining.is_zero(),
                    "{label} stayed FileLocked until the client busy deadline"
                );
                std::thread::sleep(backoff.min(remaining));
                backoff = (backoff * 2).min(Duration::from_millis(200));
            }
            Err(error) => panic!("{label} failed: {error:?}"),
        }
    }
}

fn drain(s: &mut EngineStore) {
    for _ in 0..10000 {
        if retry_file_locked("link alias seeding", || seed_step(s)) {
            continue;
        }
        let jobs = prepare_batch(s, SOURCE_SLICE).unwrap();
        if jobs.is_empty() {
            if retry_file_locked("link cleanup", || gc_step(s))
                || retry_file_locked("link reseeding", || reseed_step(s))
            {
                continue;
            }
            return;
        }
        let mut staged: std::collections::VecDeque<_> = jobs
            .into_iter()
            .map(|(w, h)| Staged::new(parser::parse(w, h.unwrap()).unwrap()))
            .collect();
        while !staged.is_empty() {
            retry_file_locked("link batch staging", || {
                stage_batch(&mut staged, s, &NoFaults)
            });
        }
    }
    panic!("drain did not make progress");
}
fn source_hash(s: &EngineStore) -> String {
    s.read_with(|c| {
        c.query_row(
            "SELECT source_hash FROM link_sources WHERE object_id='a'",
            [],
            |r| r.get(0),
        )
    })
    .unwrap()
}
fn certified_literals(s: &EngineStore) -> Vec<String> {
    s.read_with(|c|c.prepare("SELECT l.literal FROM links l JOIN link_sources s USING(workspace_id,version_id,object_id,index_key) WHERE l.object_id='a' ORDER BY ordinal")?.query_map([],|r|r.get(0))?.collect::<rusqlite::Result<_>>()).unwrap()
}
#[test]
fn staging_retries_a_locked_writer_without_losing_progress() {
    let scratch = ScratchDir::new().unwrap();
    let db = engine_db_path(&scratch).unwrap();
    let mut store = open(&db);
    let links = ROW_SLICE * 3;
    write(&mut store, "a", "a.md", &"[[target]] ".repeat(links), 2);
    let mut staged = std::collections::VecDeque::from([parsed(&store)]);
    retry_file_locked("link batch staging", || {
        stage_batch(&mut staged, &mut store, &NoFaults)
    });
    assert_eq!(staged.len(), 1);
    let committed_progress = (staged[0].offset, staged[0].target_offset);
    assert!(committed_progress.0 > 0 && committed_progress.0 < links);
    let committed_rows = count(&store, "links");
    assert_eq!(committed_rows, committed_progress.0 as i64);
    assert_eq!(count(&store, "link_sources"), 0);
    store.read_with(|c| c.busy_timeout(Duration::ZERO)).unwrap();
    let writer = rusqlite::Connection::open(&db).unwrap();
    writer.execute_batch("BEGIN IMMEDIATE").unwrap();
    let mut refusals = 0;
    while !staged.is_empty() {
        retry_file_locked("link batch staging", || {
            let result = stage_batch(&mut staged, &mut store, &NoFaults);
            if matches!(result, Err(StorageError::FileLocked)) {
                assert_eq!(refusals, 0);
                refusals += 1;
                assert_eq!(staged.len(), 1);
                assert_eq!(
                    (staged[0].offset, staged[0].target_offset),
                    committed_progress
                );
                assert_eq!(count(&store, "links"), committed_rows);
                writer.execute_batch("ROLLBACK").unwrap();
            }
            result
        });
    }
    assert_eq!(refusals, 1);
    assert_eq!(count(&store, "link_pending"), 0);
    assert_eq!(certified_literals(&store), vec!["target"; links]);
}
#[test]
fn persisted_queue_zero_links_and_metadata_only_updates() {
    let scratch = ScratchDir::new().unwrap();
    let db = engine_db_path(&scratch).unwrap();
    let mut s = open(&db);
    write(&mut s, "a", "a.md", "no links", 2);
    assert_eq!(count(&s, "link_pending"), 1);
    drop(s);
    let mut s = open(&db);
    drain(&mut s);
    assert_eq!(count(&s, "link_pending"), 0);
    assert_eq!(count(&s, "link_sources"), 1);
    assert_eq!(count(&s, "links"), 0);
    assert_eq!(count(&s, "link_target_keys"), 3);
    s.write_with(&NoFaults, |tx| {
        tx.execute("INSERT INTO snapshots(workspace_id,version_id,object_id,path,blob_sha256,binary_sha256,content_kind,updated_at_ms,latest_moment_id,metadata_origin)
            SELECT workspace_id,version_id,object_id,path,blob_sha256,binary_sha256,content_kind,8,latest_moment_id,metadata_origin FROM snapshots WHERE true
            ON CONFLICT(workspace_id,version_id,object_id) DO UPDATE SET path=excluded.path,blob_sha256=excluded.blob_sha256,binary_sha256=excluded.binary_sha256,content_kind=excluded.content_kind,updated_at_ms=excluded.updated_at_ms,metadata_summary='changed'", []).map_err(sql)?;
        Ok::<_, StorageError>(())
    }).unwrap();
    assert_eq!(count(&s, "link_pending"), 0);
    write(&mut s, "a", "a.md", "[[b]]", 3);
    write(&mut s, "a", "a.md", "[[c]]", 4);
    assert_eq!(count(&s, "link_pending"), 1);
    drain(&mut s);
    assert_eq!(certified_literals(&s), vec!["c"]);
}
#[test]
fn stale_parse_and_crash_preserve_last_certified_rows() {
    let scratch = ScratchDir::new().unwrap();
    let db = engine_db_path(&scratch).unwrap();
    let mut s = open(&db);
    write(&mut s, "a", "a.md", "[[old]]", 2);
    drain(&mut s);
    write(&mut s, "a", "a.md", "[[new]]", 3);
    let mut stale = parsed(&s);
    write(&mut s, "a", "a.md", "[[newest]]", 4);
    assert!(retry_file_locked("link source staging", || stale.step(&mut s, &NoFaults)));
    assert_eq!(certified_literals(&s), vec!["old"]);
    assert_eq!(count(&s, "link_pending"), 1);
    let mut latest = parsed(&s);
    assert!(retry_file_locked("link source staging", || latest.step(
        &mut s,
        &*ScriptedFaults::crash_at(FaultPoint::StorageBeforePersist)
    )));
    drop(s);
    let mut s = open(&db);
    assert_eq!(certified_literals(&s), vec!["old"]);
    assert_eq!(count(&s, "link_pending"), 1);
    drain(&mut s);
    assert_eq!(certified_literals(&s), vec!["newest"]);
}
#[test]
fn partial_batches_are_unpublished_and_resume_after_restart() {
    let scratch = ScratchDir::new().unwrap();
    let db = engine_db_path(&scratch).unwrap();
    let mut s = open(&db);
    write(&mut s, "a", "a.md", "[[old]]", 2);
    drain(&mut s);
    write(&mut s, "a", "a.md", &"[[new]] ".repeat(500), 3);
    let mut staged = parsed(&s);
    assert!(!retry_file_locked("link source staging", || staged.step(&mut s, &NoFaults)));
    assert_eq!(certified_literals(&s), vec!["old"]);
    drop(s);
    let mut s = open(&db);
    drain(&mut s);
    assert_eq!(certified_literals(&s).len(), 500);
    assert_eq!(count(&s, "links"), 500);
    assert_eq!(count(&s, "link_gc"), 0);
}

#[test]
fn interrupted_prior_parser_staging_does_not_certify_leftover_rows() {
    for prior_generation in [None, Some(PARSER_GENERATION - 1)] {
        let scratch = ScratchDir::new().unwrap();
        let db = engine_db_path(&scratch).unwrap();
        let mut s = open(&db);
        write(&mut s, "a", "a.md", &"[[x]] ".repeat(500), 2);
        let mut staged = parsed(&s);
        let w = staged.parsed.work.clone();
        let key = w.index_key();
        for _ in 0..5 {
            assert!(!retry_file_locked("link source staging", || staged.step(&mut s, &NoFaults)));
        }
        drop(staged);
        // Model committed slices from the preceding build, including the
        // legacy key that did not yet name its parser generation.
        let prior_key = prior_generation.map_or_else(
            || format!("{}:{}", w.id, w.revision),
            |generation| format!("{}:{}:{generation}", w.id, w.revision),
        );
        s.write_with(&NoFaults, |tx| {
            for table in ["links", "link_occurrence_keys", "link_target_keys", "link_gc"] {
                tx.execute(&format!("UPDATE {table} SET index_key=?1 WHERE index_key=?2"), params![prior_key, key]).map_err(sql)?;
            }
            tx.execute("INSERT INTO links VALUES('ws','main','a',?1,999,'ghost','wikilink',NULL,0,0,1,'ghost')", [&prior_key]).map_err(sql)?;
            tx.execute("INSERT INTO link_occurrence_keys VALUES('ws','main','a',?1,999,'folded-path','ghost.md')", [&prior_key]).map_err(sql)?;
            Ok::<_, StorageError>(())
        }).unwrap();
        drop(s);
        let mut s = open(&db);
        let mut worker = DrainWorker::new(SharedMetrics::default()).unwrap();
        let deadline = Instant::now() + Duration::from_secs(30);
        while count(&s, "link_pending") != 0 {
            worker.tick(&mut s);
            assert!(Instant::now() < deadline, "restart drain deadline");
            std::thread::yield_now();
        }
        assert_eq!(certified_literals(&s), vec!["x"; 500]);
        let probes: i64 = s.read_with(|c| c.query_row("SELECT COUNT(*) FROM link_occurrence_keys k JOIN link_sources s USING(workspace_id,version_id,object_id,index_key) WHERE ordinal=999", [], |r| r.get(0))).unwrap();
        assert_eq!(probes, 0);
        // Certification precedes cleanup of the interrupted generation.
        assert!(count(&s, "link_gc") > 0);
        drain(&mut s);
        assert_eq!(count(&s, "links"), 500);
        assert_eq!(count(&s, "link_gc"), 0);
    }
}
#[test]
fn unindexable_hashes_are_terminal_until_head_changes() {
    let scratch = ScratchDir::new().unwrap();
    let db = engine_db_path(&scratch).unwrap();
    let mut s = open(&db);
    let text = "x".repeat(MAX_DOCUMENT_BYTES + 1);
    write(&mut s, "a", "a.md", &text, 2);
    drain(&mut s);
    assert_eq!(count(&s, "link_pending"), 0);
    assert_eq!(source_hash(&s), hex_sha256(text.as_bytes()));
    let reason: String = s
        .read_with(|c| c.query_row("SELECT reason FROM link_sources", [], |r| r.get(0)))
        .unwrap();
    assert_eq!(reason, "byte-bound");
    drop(s);
    let mut s = open(&db);
    assert!(prepare(&s).unwrap().is_none());
    write(&mut s, "a", "a.md", &"[[x]] ".repeat(4097), 3);
    drain(&mut s);
    let reason: String = s
        .read_with(|c| c.query_row("SELECT reason FROM link_sources", [], |r| r.get(0)))
        .unwrap();
    assert_eq!(reason, "parse-refused");
    assert_eq!(count(&s, "link_pending"), 0);
    write(&mut s, "a", "a.md", "[[okay]]", 4);
    drain(&mut s);
    assert_eq!(certified_literals(&s), vec!["okay"]);
}
#[test]
fn fork_copies_certified_rows_and_pending_without_draining_source() {
    let scratch = ScratchDir::new().unwrap();
    let db = engine_db_path(&scratch).unwrap();
    let mut s = open(&db);
    write(&mut s, "a", "a.md", "[[old]]", 2);
    drain(&mut s);
    write(&mut s, "a", "a.md", "[[new]]", 3);
    write(&mut s, "b", "b.md", "never indexed", 4);
    VersionedTextStore::new(&mut s)
        .create_named_version(
            &CreateNamedVersion {
                workspace_id: "ws".into(),
                new_version_id: "fork".into(),
                name: "fork".into(),
                from_version_id: "main".into(),
                now_ms: 5,
                request_id: None,
            },
            &NoFaults,
        )
        .unwrap();
    assert_eq!(count(&s, "link_pending"), 4);
    assert_eq!(count(&s, "link_sources"), 2);
    let hashes: Vec<String> = s
        .read_with(|c| {
            c.prepare("SELECT source_hash FROM link_sources ORDER BY version_id")?
                .query_map([], |r| r.get(0))?
                .collect::<rusqlite::Result<_>>()
        })
        .unwrap();
    assert_eq!(hashes, vec![hex_sha256(b"[[old]]"); 2]);
    drain(&mut s);
    assert_eq!(count(&s, "link_sources"), 4);
    assert_eq!(count(&s, "links"), 2);
    let foreign_keys: i64 = s
        .read_with(|c| {
            c.query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |r| {
                r.get(0)
            })
        })
        .unwrap();
    assert_eq!(foreign_keys, 0);
}
#[test]
fn rollback_new_file_and_parent_cascades_leave_cleanup_work() {
    let scratch = ScratchDir::new().unwrap();
    let db = engine_db_path(&scratch).unwrap();
    let mut s = open(&db);
    write(&mut s, "a", "a.md", "[[b]]", 2);
    drain(&mut s);
    VersionedTextStore::new(&mut s)
        .rollback_text_file_mutation(
            &RollbackTextFileMutation {
                workspace_id: "ws".into(),
                version_id: "main".into(),
                path: "a.md".into(),
                mutation_moment_id: "m-a-2".into(),
                request_id: None,
                metadata_origin: "test".into(),
                author_json: None,
            },
            &NoFaults,
        )
        .unwrap();
    assert_eq!(count(&s, "snapshots"), 0);
    drain(&mut s);
    assert_eq!(count(&s, "link_sources"), 0);
    assert_eq!(count(&s, "links"), 0);
    write(&mut s, "c", "c.md", "[[b]]", 3);
    drain(&mut s);
    s.write_with(&NoFaults, |tx| {
        tx.execute("DELETE FROM file_objects WHERE object_id='c'", [])
            .map_err(sql)?;
        Ok::<_, StorageError>(())
    })
    .unwrap();
    assert_eq!(count(&s, "link_pending"), 1);
    drain(&mut s);
    assert_eq!(count(&s, "links"), 0);
}
#[test]
fn alias_displacement_and_moves_fence_inflight_work() {
    let scratch = ScratchDir::new().unwrap();
    let db = engine_db_path(&scratch).unwrap();
    let mut s = open(&db);
    write(&mut s, "a", "folder/a.md", "[[b]]", 2);
    write(&mut s, "b", "b.md", "", 3);
    drain(&mut s);
    write(&mut s, "a", "folder/a.md", "[[c]]", 4);
    let mut old = parsed(&s);
    s.write_with(&NoFaults, |tx| {
        tx.execute(
            "UPDATE path_aliases SET object_id='b' WHERE path='folder/a.md'",
            [],
        )
        .map_err(sql)?;
        Ok::<_, StorageError>(())
    })
    .unwrap();
    assert_eq!(count(&s, "link_pending"), 2);
    assert!(retry_file_locked("link source staging", || old.step(&mut s, &NoFaults)));
    drain(&mut s);
    assert!(certified_literals(&s).is_empty());
    let paths: Vec<String> = s
        .read_with(|c| {
            c.prepare("SELECT key FROM link_target_keys WHERE key_kind='folded-path' ORDER BY key")?
                .query_map([], |r| r.get(0))?
                .collect::<rusqlite::Result<_>>()
        })
        .unwrap();
    assert_eq!(paths, vec!["b.md", "folder/a.md"]);
}
#[test]
fn parser_generation_reseeds_without_rescanning_certified_bodies_on_reopen() {
    let scratch = ScratchDir::new().unwrap();
    let db = engine_db_path(&scratch).unwrap();
    let mut s = open(&db);
    write(&mut s, "a", "a.md", "[[b]]", 2);
    drain(&mut s);
    s.write_with(&NoFaults, |tx| {
        tx.execute("UPDATE link_index_state SET parser_generation=0", [])
            .map_err(sql)?;
        tx.execute("UPDATE link_sources SET parser_generation=0", [])
            .map_err(sql)?;
        Ok::<_, StorageError>(())
    })
    .unwrap();
    drain(&mut s);
    let generation: i64 = s
        .read_with(|c| {
            c.query_row("SELECT parser_generation FROM link_sources", [], |r| {
                r.get(0)
            })
        })
        .unwrap();
    assert_eq!(generation, PARSER_GENERATION);
    let key: String = s
        .read_with(|c| c.query_row("SELECT index_key FROM link_sources", [], |r| r.get(0)))
        .unwrap();
    drop(s);
    let mut s = open(&db);
    drain(&mut s);
    let reopened: String = s
        .read_with(|c| c.query_row("SELECT index_key FROM link_sources", [], |r| r.get(0)))
        .unwrap();
    assert_eq!(key, reopened);
}
#[test]
fn thousand_note_backlog_wakes_on_parser_completion() {
    const NOTES: u64 = 1000;
    let scratch = ScratchDir::new().unwrap();
    let db = engine_db_path(&scratch).unwrap();
    let mut s = open(&db);
    for n in 0..NOTES {
        write(
            &mut s,
            &format!("note-{n}"),
            &format!("note-{n}.md"),
            "[[target]]",
            n as i64 + 2,
        );
    }
    assert_eq!(count(&s, "link_pending"), NOTES as i64);
    let mut worker = DrainWorker::new(SharedMetrics::default()).unwrap();
    let delay = worker.tick(&mut s);
    assert!(worker.waiting_for_parser());
    assert_eq!(
        delay,
        Duration::MAX,
        "parser jobs must wait for completion, not a polling timer"
    );
    drop(worker);
    drop(s);
    let observer = EngineStore::open_read_only(&db).unwrap();
    let supervisor = crate::WorkspaceSupervisor::new();
    let began = Instant::now();
    let actor = supervisor.open(&db, 1).unwrap().actor;
    let deadline = began + Duration::from_secs(120);
    while actor.link_drain_metrics().certified_sources != NOTES
        || count(&observer, "link_pending") != 0
    {
        assert!(Instant::now() < deadline, "backlog drain deadline");
        std::thread::yield_now();
    }
    let elapsed = began.elapsed();
    let metrics = actor.link_drain_metrics();
    let ticks = Duration::from_micros(metrics.total_actor_us);
    eprintln!(
        "1000-note actor backlog: elapsed_ms={} summed_tick_ms={} elapsed_to_tick_ratio={:.2} metrics={metrics:?}",
        elapsed.as_millis(),
        ticks.as_millis(),
        elapsed.as_secs_f64() / ticks.as_secs_f64()
    );
    drop(observer);
    supervisor.close(&db).unwrap();
}

#[test]
fn writable_actor_drains_mount_store_and_read_only_actor_leaves_queue() {
    use crate::WorkspaceSupervisor;
    let scratch = ScratchDir::new().unwrap();
    let db = engine_db_path(&scratch).unwrap();
    let mut s = open(&db);
    write(&mut s, "a", "a.md", "[[b]]", 2);
    drop(s);
    let supervisor = WorkspaceSupervisor::new();
    let read = supervisor.open_read_only(&db).unwrap().actor;
    let observer = EngineStore::open_read_only(&db).unwrap();
    assert_eq!(count(&observer, "link_pending"), 1);
    assert_eq!(read.link_drain_metrics().actor_batches, 0);
    drop(observer);
    supervisor.close(&db).unwrap();
    let mut s = open(&db);
    drain(&mut s);
    drop(s);
    let actor = supervisor.open(&db, 1).unwrap().actor;
    let deadline = Instant::now() + Duration::from_secs(30);
    let observer = EngineStore::open_read_only(&db).unwrap();
    while actor.link_drain_metrics().actor_batches == 0 {
        assert!(Instant::now() < deadline, "actor idle deadline");
        std::thread::yield_now();
    }
    assert_eq!(actor.link_drain_metrics().certified_sources, 0);
    // A normal actor mutation wakes a parked drain without an external poll.
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let settled = Instant::now();
    runtime
        .block_on(actor.versioned_text_write(
            WriteText {
                workspace_id: "ws".into(),
                version_id: "main".into(),
                object_id: "a".into(),
                path: "a.md".into(),
                text: "[[changed]]".into(),
                moment_id: "after-idle".into(),
                metadata_origin: "test".into(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 3,
                request_id: None,
            },
            std::sync::Arc::new(NoFaults),
            crate::CancellationToken::new(),
        ))
        .unwrap();
    while count(&observer, "link_pending") != 0 || actor.link_drain_metrics().certified_sources != 1
    {
        assert!(Instant::now() < deadline, "idle actor drain deadline");
        std::thread::yield_now();
    }
    eprintln!(
        "after-idle settle-to-index: {} ms; whole-tick metrics: {:?}",
        settled.elapsed().as_millis(),
        actor.link_drain_metrics()
    );
    assert_eq!(certified_literals(&observer), vec!["changed"]);
    drop(observer);
    supervisor.close(&db).unwrap();
}
#[test]
fn terminal_refusal_reuses_hash_after_alias_only_change() {
    let scratch = ScratchDir::new().unwrap();
    let db = engine_db_path(&scratch).unwrap();
    let mut s = open(&db);
    write(&mut s, "a", "a.md", &"[[x]] ".repeat(4097), 2);
    drain(&mut s);
    s.write_with(&NoFaults, |tx| {
        tx.execute(
            "UPDATE path_aliases SET path='renamed.md' WHERE object_id='a'",
            [],
        )
        .map_err(sql)?;
        Ok::<_, StorageError>(())
    })
    .unwrap();
    let (w, h) = prepare(&s).unwrap().unwrap();
    assert!(h.as_ref().unwrap().text.is_none());
    assert_eq!(h.as_ref().unwrap().unindexed_reason, Some("parse-refused"));
    let mut staged = Staged::new(parser::parse(w, h).unwrap());
    while !retry_file_locked("link source staging", || staged.step(&mut s, &NoFaults)) {}
    assert_eq!(count(&s, "link_pending"), 0);
    let reason: String = s
        .read_with(|c| c.query_row("SELECT reason FROM link_sources", [], |r| r.get(0)))
        .unwrap();
    assert_eq!(reason, "parse-refused");
}
#[test]
fn binary_heads_and_fork_fallback_receive_target_keys_only() {
    use dohc_engine_domain::WriteBinary;
    let scratch = ScratchDir::new().unwrap();
    let db = engine_db_path(&scratch).unwrap();
    let mut s = open(&db);
    VersionedTextStore::new(&mut s)
        .ensure_main_version("ws", "main", 1, &NoFaults)
        .unwrap();
    VersionedTextStore::new(&mut s)
        .write_binary(
            &WriteBinary {
                workspace_id: "ws".into(),
                version_id: "main".into(),
                object_id: "bin".into(),
                path: "asset.png".into(),
                bytes: b"[[fake]]".to_vec(),
                moment_id: "bin-m".into(),
                metadata_origin: "test".into(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 2,
                request_id: None,
            },
            &NoFaults,
        )
        .unwrap();
    drain(&mut s);
    assert_eq!(count(&s, "link_sources"), 1);
    assert_eq!(count(&s, "links"), 0);
    assert_eq!(count(&s, "link_target_keys"), 3);
    VersionedTextStore::new(&mut s)
        .create_named_version(
            &CreateNamedVersion {
                workspace_id: "ws".into(),
                new_version_id: "fork".into(),
                name: "fork".into(),
                from_version_id: "main".into(),
                now_ms: 3,
                request_id: None,
            },
            &NoFaults,
        )
        .unwrap();
    s.write_with(&NoFaults, |tx| {
        tx.execute("DELETE FROM snapshots WHERE version_id='fork'", [])
            .map_err(sql)?;
        Ok::<_, StorageError>(())
    })
    .unwrap();
    drain(&mut s);
    assert_eq!(count(&s, "link_sources"), 2);
    assert_eq!(count(&s, "link_target_keys"), 6);
    s.write_with(&NoFaults, |tx| {
        tx.execute("DELETE FROM versions WHERE version_id='fork'", [])
            .map_err(sql)?;
        Ok::<_, StorageError>(())
    })
    .unwrap();
    drain(&mut s);
    assert_eq!(count(&s, "link_sources"), 1);
    assert_eq!(count(&s, "link_target_keys"), 3);
}
#[test]
fn five_hundred_links_publish_atomically_in_bounded_actor_slices() {
    let scratch = ScratchDir::new().unwrap();
    let db = engine_db_path(&scratch).unwrap();
    let mut s = open(&db);
    write(&mut s, "a", "a.md", &"[[target]] ".repeat(500), 2);
    let mut staged = parsed(&s);
    observe_checkpoints(&s);
    let mut batches = 0;
    let mut durations = Vec::new();
    let began = Instant::now();
    loop {
        begin_tick_measurement();
        let start = Instant::now();
        let done = staged.step(&mut s, &NoFaults).unwrap();
        let duration = start.elapsed();
        report_slow_tick(duration, if done { "certify" } else { "stage" });
        durations.push(duration);
        batches += 1;
        if done {
            break;
        }
        assert_eq!(count(&s, "link_sources"), 0);
    }
    durations.sort();
    eprintln!(
        "500-link staged drain: batches={batches} p95_actor_us={} max_actor_us={} elapsed_ms={}",
        durations[(durations.len() - 1) * 95 / 100].as_micros(),
        durations.last().unwrap().as_micros(),
        began.elapsed().as_millis()
    );
    assert!(batches >= 32);
    assert_eq!(certified_literals(&s).len(), 500);
}
#[test]
fn fork_index_copy_failure_keeps_authoritative_version_and_backfill() {
    let scratch = ScratchDir::new().unwrap();
    let db = engine_db_path(&scratch).unwrap();
    let mut s = open(&db);
    write(&mut s, "a", "a.md", "[[b]]", 2);
    drain(&mut s);
    s.write_with(&NoFaults,|tx|{tx.execute_batch("CREATE TRIGGER refuse_link_copy BEFORE INSERT ON link_sources WHEN NEW.version_id='fork' BEGIN SELECT RAISE(ABORT,'test copy refusal'); END;").map_err(sql)?;Ok::<_,StorageError>(())}).unwrap();
    VersionedTextStore::new(&mut s)
        .create_named_version(
            &CreateNamedVersion {
                workspace_id: "ws".into(),
                new_version_id: "fork".into(),
                name: "fork".into(),
                from_version_id: "main".into(),
                now_ms: 3,
                request_id: None,
            },
            &NoFaults,
        )
        .unwrap();
    assert_eq!(count(&s, "versions"), 2);
    assert_eq!(count(&s, "snapshots"), 2);
    assert_eq!(count(&s, "link_pending"), 0);
    assert_eq!(count(&s, "link_sources"), 1);
    s.write_with(&NoFaults, |tx| {
        tx.execute_batch("DROP TRIGGER refuse_link_copy")
            .map_err(sql)?;
        Ok::<_, StorageError>(())
    })
    .unwrap();
    drain(&mut s);
    assert_eq!(count(&s, "link_sources"), 2);
    assert_eq!(count(&s, "links"), 2);
}

#[test]
fn extractor_matches_renderer_fixtures() {
    let fixtures: serde_json::Value = serde_json::from_str(include_str!("parity.json")).unwrap();
    for fixture in fixtures["extract"].as_array().unwrap() {
        let text = fixture["text"].as_str().unwrap();
        let mut actual: Vec<_> = parser::extract(text)
            .unwrap()
            .into_iter()
            .map(|o| (o.kind.to_owned(), o.literal))
            .collect();
        let mut expected: Vec<_> = fixture["links"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| {
                (
                    v[0].as_str().unwrap().to_owned(),
                    v[1].as_str().unwrap().to_owned(),
                )
            })
            .collect();
        actual.sort();
        expected.sort();
        assert_eq!(actual, expected, "{}", fixture["name"]);
    }
}
#[test]
fn resolution_keys_cover_renderer_resolved_targets() {
    let fixtures: serde_json::Value = serde_json::from_str(include_str!("parity.json")).unwrap();
    for fixture in fixtures["resolve"].as_array().unwrap() {
        let occurrence = occurrence_keys(
            fixture["source"].as_str().unwrap(),
            fixture["literal"].as_str().unwrap(),
            fixture["kind"].as_str().unwrap(),
        );
        let Some(path) = fixture["target"].as_str() else {
            continue;
        };
        let target = path_keys(path);
        assert!(
            occurrence.iter().any(|k| target.contains(k)),
            "no candidate for {fixture}"
        );
        assert!(!occurrence.iter().any(|(kind, _)| *kind == "path"));
    }
}
#[test]
fn half_megabyte_document_is_indexed() {
    let scratch = ScratchDir::new().unwrap();
    let db = engine_db_path(&scratch).unwrap();
    let mut s = open(&db);
    let text = format!("{}[[last]]", "x".repeat(512 * 1024 - 8));
    assert_eq!(text.len(), 512 * 1024);
    write(&mut s, "a", "a.md", &text, 2);
    drain(&mut s);
    assert_eq!(certified_literals(&s), vec!["last"]);
}
#[test]
fn one_slice_certifies_without_an_extra_transaction() {
    let scratch = ScratchDir::new().unwrap();
    let db = engine_db_path(&scratch).unwrap();
    let mut s = open(&db);
    write(&mut s, "a", "a.md", "[[b]]", 2);
    let mut staged = parsed(&s);
    // Isolate the final occurrence slice from target-key timing on a busy host.
    staged.targets.clear();
    assert!(staged.step(&mut s, &NoFaults).unwrap());
    assert_eq!(certified_literals(&s), vec!["b"]);
}
#[test]
fn queue_bumps_and_forks_start_a_new_latency_window() {
    let scratch = ScratchDir::new().unwrap();
    let db = engine_db_path(&scratch).unwrap();
    let mut s = open(&db);
    write(&mut s, "a", "a.md", "[[old]]", 2);
    s.write_with(&NoFaults, |tx| {
        tx.execute(
            "UPDATE link_pending SET queued_at_ms=1,retry_after_ms=9999999999999",
            [],
        )
        .map_err(sql)?;
        Ok::<_, StorageError>(())
    })
    .unwrap();
    let began = now_ms();
    write(&mut s, "a", "a.md", "[[new]]", 3);
    let (w, _) = prepare(&s).unwrap().unwrap();
    assert!(w.queued_at_ms >= began - 2);
    s.write_with(&NoFaults, |tx| {
        tx.execute(
            "UPDATE link_pending SET queued_at_ms=1,retry_after_ms=9999999999999",
            [],
        )
        .map_err(sql)?;
        Ok::<_, StorageError>(())
    })
    .unwrap();
    let began = now_ms();
    VersionedTextStore::new(&mut s)
        .create_named_version(
            &CreateNamedVersion {
                workspace_id: "ws".into(),
                new_version_id: "fork".into(),
                name: "fork".into(),
                from_version_id: "main".into(),
                now_ms: 5,
                request_id: None,
            },
            &NoFaults,
        )
        .unwrap();
    let (w, _) = prepare(&s).unwrap().unwrap();
    assert_eq!(w.version, "fork");
    assert!(w.queued_at_ms >= began - 2);
}
#[test]
fn small_note_certifies_before_obsolete_large_document_cleanup() {
    let scratch = ScratchDir::new().unwrap();
    let db = engine_db_path(&scratch).unwrap();
    let mut s = open(&db);
    write(&mut s, "a", "a.md", &"[[old]] ".repeat(500), 2);
    drain(&mut s);
    let metrics = SharedMetrics::default();
    let mut worker = DrainWorker::new(metrics.clone()).unwrap();
    assert_eq!(worker.tick(&mut s), Duration::MAX);
    write(&mut s, "a", "a.md", &"[[new]] ".repeat(500), 3);
    write(&mut s, "small", "small.md", "[[target]]", 4);
    let began = Instant::now();
    let deadline = began + Duration::from_secs(30);
    let mut durations = Vec::new();
    loop {
        let tick_start = Instant::now();
        let delay = worker.tick(&mut s);
        let duration = tick_start.elapsed();
        if delay == Duration::ZERO {
            durations.push(duration);
        }
        if count(&s, "link_pending") == 0 {
            break;
        }
        assert!(Instant::now() < deadline, "worker drain deadline");
        std::thread::yield_now();
    }
    // The old 500 occurrences and their probes still await cleanup.
    assert!(count(&s, "link_gc") > 0);
    assert_eq!(count(&s, "links"), 1001);
    durations.sort();
    eprintln!(
        "large reindex then small note: settle_to_index_ms={} active_ticks={} p95_whole_tick_us={} max_active_tick_us={} metrics={:?}",
        began.elapsed().as_millis(),
        durations.len(),
        durations[(durations.len() - 1) * 95 / 100].as_micros(),
        durations.last().unwrap().as_micros(),
        metrics.lock().unwrap()
    );
    while worker.tick(&mut s) != Duration::MAX {
        assert!(Instant::now() < deadline, "cleanup deadline");
    }
    assert_eq!(count(&s, "link_gc"), 0);
    assert_eq!(count(&s, "links"), 501);
}

#[test]
fn link_drain_holds_pause_the_actor_and_last_release_resumes_it() {
    let scratch = ScratchDir::new().unwrap();
    let db = engine_db_path(&scratch).unwrap();
    let supervisor = crate::WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 1).unwrap().actor;
    let policy = std::sync::Arc::new(crate::search::read_engine_search_policy(scratch.path()));
    let outer = actor.hold_link_drain();
    let inner = actor.hold_link_drain();
    for n in 0..32 {
        actor
            .capture_ingest_with_search_policy_blocking(
                &dohc_engine_domain::CaptureIngest {
                    workspace_id: "ws".into(),
                    version_id: "main".into(),
                    path: format!("note-{n}.md"),
                    text: "[[target]]".into(),
                    metadata_origin: "capture".into(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: None,
                    now_ms: n + 2,
                    request_id: None,
                    claim_foreign_head: false,
                },
                scratch.path().to_owned(),
                std::sync::Arc::clone(&policy),
                dohc_engine_collab::LeaseRegistry::new(),
                std::sync::Arc::new(NoFaults),
            )
            .unwrap();
    }
    let observer = EngineStore::open_read_only(&db).unwrap();
    assert_eq!(count(&observer, "link_pending"), 0);
    assert_eq!(count(&observer, "link_aliases"), 0);
    assert_eq!(seed_phase(&observer), "deferred");
    assert_eq!(count(&observer, "link_sources"), 0);
    drop(inner);
    // A foreground command provides an actor barrier, with the outer hold live.
    actor
        .capture_ingest_with_search_policy_blocking(
            &dohc_engine_domain::CaptureIngest {
                workspace_id: "ws".into(),
                version_id: "main".into(),
                path: "target.md".into(),
                text: "target".into(),
                metadata_origin: "capture".into(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 40,
                request_id: None,
                claim_foreign_head: false,
            },
            scratch.path().to_owned(),
            std::sync::Arc::clone(&policy),
            dohc_engine_collab::LeaseRegistry::new(),
            std::sync::Arc::new(NoFaults),
        )
        .unwrap();
    assert_eq!(count(&observer, "link_sources"), 0);
    drop(outer);
    let deadline = Instant::now() + Duration::from_secs(30);
    while seed_phase(&observer) != "ready" {
        assert!(Instant::now() < deadline);
        std::thread::yield_now();
    }
    assert_eq!(count(&observer, "link_sources"), 33);
    let backlinks:i64=observer.read_with(|c| c.query_row("SELECT count(*) FROM links l JOIN link_sources s USING(workspace_id,version_id,object_id,index_key) JOIN link_occurrence_keys k USING(workspace_id,version_id,object_id,index_key,ordinal) WHERE k.key_kind='stem' AND k.key='target'",[],|r|r.get(0))).unwrap();
    assert_eq!(backlinks, 32);
    drop(observer);
    supervisor.close(&db).unwrap();
}

#[test]
fn source_batches_resume_on_both_sides_of_the_commit_boundary() {
    for point in [
        FaultPoint::StorageBeforePersist,
        FaultPoint::StorageAfterCommitBeforeAck,
    ] {
        let scratch = ScratchDir::new().unwrap();
        let db = engine_db_path(&scratch).unwrap();
        let mut s = open(&db);
        for n in 0..16 {
            write(
                &mut s,
                &format!("note-{n}"),
                &format!("note-{n}.md"),
                "[[target]]",
                n + 2,
            );
        }
        let mut batch = prepare_batch(&s, 16)
            .unwrap()
            .into_iter()
            .map(|(w, h)| Staged::new(parser::parse(w, h.unwrap()).unwrap()))
            .collect();
        retry_file_locked("link batch staging", || {
            stage_batch(&mut batch, &mut s, &*ScriptedFaults::crash_at(point))
        });
        drop(s);
        let mut s = open(&db);
        assert_eq!(count(&s, "link_sources") + count(&s, "link_pending"), 16);
        if point == FaultPoint::StorageBeforePersist {
            assert_eq!(count(&s, "link_sources"), 0);
        }
        drain(&mut s);
        assert_eq!(count(&s, "link_pending"), 0);
        assert_eq!(count(&s, "link_sources"), 16);
        assert_eq!(count(&s, "links"), 16);
    }
}

#[test]
fn malformed_source_is_deferred_without_blocking_healthy_sources() {
    let scratch = ScratchDir::new().unwrap();
    let db = engine_db_path(&scratch).unwrap();
    let mut s = open(&db);
    write(&mut s, "first", "first.md", "[[target]]", 2);
    write(&mut s, "bad", "bad.md", "[[target]]", 3);
    write(&mut s, "last", "last.md", "[[target]]", 4);
    s.write_with(&NoFaults, |tx| {
        for n in 0..65 {
            tx.execute(
                "INSERT INTO path_aliases VALUES('ws','main',?1,'bad')",
                [format!("alias-{n}.md")],
            )
            .map_err(sql)?;
        }
        Ok::<_, StorageError>(())
    })
    .unwrap();
    let mut worker = DrainWorker::new(SharedMetrics::default()).unwrap();
    let deadline = Instant::now() + Duration::from_secs(30);
    while count(&s, "link_sources") != 2 {
        worker.tick(&mut s);
        assert!(Instant::now() < deadline);
        std::thread::yield_now();
    }
    assert_eq!(count(&s, "link_pending"), 1);
    let deferred: bool = s
        .read_with(|c| {
            c.query_row(
                "SELECT retry_after_ms>0 FROM link_pending WHERE object_id='bad'",
                [],
                |r| r.get(0),
            )
        })
        .unwrap();
    assert!(deferred);
    assert_eq!(count(&s, "links"), 2);
}

#[test]
fn batch_rechecks_stale_items_and_retains_partial_suffix_progress() {
    let scratch = ScratchDir::new().unwrap();
    let db = engine_db_path(&scratch).unwrap();
    let mut s = open(&db);
    write(&mut s, "first", "first.md", "[[target]]", 2);
    write(&mut s, "stale", "stale.md", "[[old]]", 3);
    write(&mut s, "large", "large.md", &"[[target]] ".repeat(100), 4);
    let mut staged = s.read_with(|c| {
        let mut stmt = c.prepare("SELECT pending_id,revision,workspace_id,version_id,object_id,queued_at_ms FROM link_pending ORDER BY pending_id").map_err(sql)?;
        let jobs = stmt.query_map([], |r| Ok(Work { id:r.get(0)?,revision:r.get(1)?,workspace:r.get(2)?,version:r.get(3)?,object:r.get(4)?,queued_at_ms:r.get(5)? })).map_err(sql)?.collect::<Result<Vec<_>,_>>().map_err(sql)?;
        jobs.into_iter().map(|w| { let h=head(c,&w,true,false)?; Ok(Staged::new(parser::parse(w,h)?)) }).collect::<Result<std::collections::VecDeque<_>,StorageError>>()
    }).unwrap();
    write(&mut s, "stale", "stale.md", "[[new]]", 5);
    retry_file_locked("link batch staging", || {
        stage_batch(&mut staged, &mut s, &NoFaults)
    });
    while staged.len() > 1 || staged.front().unwrap().offset == 0 {
        retry_file_locked("link batch staging", || {
            stage_batch(&mut staged, &mut s, &NoFaults)
        });
    }
    assert_eq!(staged.front().unwrap().parsed.work.object, "large");
    assert!(staged.front().unwrap().offset > 0);
    assert!(staged.front().unwrap().offset < 100);
    drop(s);
    let mut s = open(&db);
    drain(&mut s);
    assert_eq!(count(&s, "link_sources"), 3);
    assert_eq!(count(&s, "links"), 102);
    let stale:String=s.read_with(|c|c.query_row("SELECT literal FROM links l JOIN link_sources s USING(workspace_id,version_id,object_id,index_key) WHERE object_id='stale'",[],|r|r.get(0))).unwrap();
    assert_eq!(stale, "new");
}

#[test]
fn drain_resumes_after_abrupt_process_exit() {
    const CHILD_ROOT: &str = "DOHC_LINK_DRAIN_CRASH_CHILD_ROOT";
    if let Some(root) = std::env::var_os(CHILD_ROOT) {
        let db = std::path::PathBuf::from(root).join("engine.db");
        let mut store = open(&db);
        for n in 0..32 {
            write(
                &mut store,
                &format!("note-{n}"),
                &format!("note-{n}.md"),
                "[[target]]",
                n + 2,
            );
        }
        write(&mut store, "target", "target.md", "target", 40);
        let mut staged = prepare_batch(&store, SOURCE_SLICE)
            .unwrap()
            .into_iter()
            .map(|(w, h)| Staged::new(parser::parse(w, h.unwrap()).unwrap()))
            .collect();
        retry_file_locked("link batch staging", || {
            stage_batch(&mut staged, &mut store, &NoFaults)
        });
        assert!(count(&store, "link_sources") > 0);
        assert!(count(&store, "link_pending") > 0);
        // No destructors or close-time checkpoint: leave committed WAL and pending work.
        std::process::exit(73);
    }
    let scratch = ScratchDir::new().unwrap();
    let status = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "links::tests::drain_resumes_after_abrupt_process_exit",
            "--nocapture",
        ])
        .env(CHILD_ROOT, scratch.path())
        .status()
        .unwrap();
    assert_eq!(status.code(), Some(73));
    let mut store = open(&scratch.path().join("engine.db"));
    assert!(count(&store, "link_pending") > 0);
    drain(&mut store);
    assert_eq!(count(&store, "link_pending"), 0);
    assert_eq!(count(&store, "link_sources"), 33);
    let actual:Vec<(String,String)>=store.read_with(|c| {
        c.prepare("SELECT source.object_id,target.object_id FROM link_sources target JOIN link_target_keys t USING(workspace_id,version_id,object_id,index_key) JOIN link_occurrence_keys k ON k.workspace_id=t.workspace_id AND k.version_id=t.version_id AND k.key_kind=t.key_kind AND k.key=t.key JOIN link_sources source ON source.workspace_id=k.workspace_id AND source.version_id=k.version_id AND source.object_id=k.object_id AND source.index_key=k.index_key WHERE t.key_kind='stem' ORDER BY source.object_id,target.object_id")?
            .query_map([],|row|Ok((row.get(0)?,row.get(1)?)))?.collect::<rusqlite::Result<_>>()
    }).unwrap();
    let mut expected = (0..32)
        .map(|n| (format!("note-{n}"), "target".to_string()))
        .collect::<Vec<_>>();
    expected.sort();
    assert_eq!(actual, expected);
}

#[test]
fn maximal_writes_checkpoint_within_the_client_busy_budget() {
    let budget = client_busy_budget();
    fn handoff(store: &mut EngineStore, label: &str, budget: Duration) -> Duration {
        let began = Instant::now();
        let mut refusals = 0;
        loop {
            match store.write_with(&NoFaults, |_| Ok::<_, StorageError>(())) {
                Ok(TxnOutcome::Committed(())) => break,
                Err(StorageError::FileLocked) => {
                    refusals += 1;
                    std::thread::sleep(Duration::from_millis(1));
                }
                result => panic!("unexpected admission result: {result:?}"),
            }
            assert!(
                began.elapsed() < budget,
                "{label} catch-up exceeded client busy budget"
            );
        }
        let elapsed = began.elapsed();
        if label == "MAX_TEXT_BYTES" {
            eprintln!(
                "BUSY_BUDGET {label} catch_up_us={} refusals={refusals} budget_ms={}",
                elapsed.as_micros(),
                budget.as_millis()
            );
        }
        assert!(
            elapsed * 4 < budget,
            "{label} needs at least fourfold catch-up headroom"
        );
        elapsed
    }
    let scratch = ScratchDir::new().unwrap();
    let db = engine_db_path(&scratch).unwrap();
    let mut store = open(&db);
    write(&mut store, "seed", "seed.md", "seed", 2);
    let reader =
        rusqlite::Connection::open_with_flags(&db, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .unwrap();
    reader
        .execute_batch("BEGIN; SELECT count(*) FROM moments;")
        .unwrap();
    let mut random = 7_u32;
    let mut maximum_text: String = (0..dohc_engine_domain::MAX_TEXT_BYTES)
        .map(|i| {
            random ^= random << 13;
            random ^= random >> 17;
            random ^= random << 5;
            if i % 17 == 16 {
                '\n'
            } else {
                (b'a' + (random % 26) as u8) as char
            }
        })
        .collect();
    // Today's maximal writes add 2,579–2,588 frames. Keep fixed headroom
    // independently of the startup prefix, so per-write growth cannot hide.
    const MAXIMAL_WRITE_FRAME_CEILING: i64 = 2700;
    let mut previous_frames: i64 = store
        .read_with(|c| c.query_row("PRAGMA wal_checkpoint(NOOP)", [], |r| r.get(1)))
        .unwrap();
    for (n, first) in [(3, None), (4, Some("Z")), (5, Some("Q"))] {
        if let Some(first) = first {
            maximum_text.replace_range(0..1, first);
        }
        write(&mut store, "maximum", "maximum.md", &maximum_text, n);
        let frames: i64 = store
            .read_with(|c| c.query_row("PRAGMA wal_checkpoint(NOOP)", [], |r| r.get(1)))
            .unwrap();
        let delta = frames - previous_frames;
        eprintln!(
            "MAXIMAL_WRITE n={n} frames={frames} delta={delta} ceiling={MAXIMAL_WRITE_FRAME_CEILING}"
        );
        assert!(
            (1..=MAXIMAL_WRITE_FRAME_CEILING).contains(&delta),
            "maximal write WAL growth exceeded its fixed ceiling: delta={delta}, ceiling={MAXIMAL_WRITE_FRAME_CEILING}"
        );
        previous_frames = frames;
    }
    let frames: i64 = store
        .read_with(|c| c.query_row("PRAGMA wal_checkpoint(NOOP)", [], |r| r.get(1)))
        .unwrap();
    assert!(
        frames > 6000,
        "maximum text must exercise refused admission, frames={frames}"
    );
    reader.execute_batch("COMMIT").unwrap();
    handoff(&mut store, "MAX_TEXT_BYTES", budget);
    drop(reader);
    // Sixteen maximal parser inputs exercise the row, source and time bounds
    // through the production batch writer, including replacing prior indexes.
    let mut text = "[[target]]\n".repeat(4096);
    text.push_str(&"x".repeat(parser::MAX_DOCUMENT_BYTES - text.len()));
    for n in 0..SOURCE_SLICE {
        write(
            &mut store,
            &format!("links-{n}"),
            &format!("links-{n}.md"),
            &text,
            n as i64 + 4,
        );
    }
    let mut maximum = Duration::ZERO;
    for pass in 0..2 {
        if pass == 1 {
            for n in 0..SOURCE_SLICE {
                write(
                    &mut store,
                    &format!("links-{n}"),
                    &format!("links-{n}.md"),
                    &text.replace("target", "second"),
                    n as i64 + 30,
                );
            }
        }
        loop {
            let jobs = prepare_batch(&store, SOURCE_SLICE).unwrap();
            if jobs.is_empty() {
                break;
            }
            let mut staged: std::collections::VecDeque<_> = jobs
                .into_iter()
                .map(|(w, h)| Staged::new(parser::parse(w, h.unwrap()).unwrap()))
                .collect();
            while !staged.is_empty() {
                handoff(&mut store, "before_link_batch", budget);
                stage_batch(&mut staged, &mut store, &NoFaults).unwrap();
                maximum = maximum.max(handoff(&mut store, "link_batch", budget));
            }
        }
        assert_eq!(
            count(&store, "links"),
            (SOURCE_SLICE * 4096 * (pass + 1)) as i64
        );
    }
    // Maximum literals stress key-row bytes as well as the occurrence count.
    let literal = "a".repeat(2048);
    let mut long_links = format!("[[{literal}]]\n").repeat(parser::MAX_DOCUMENT_BYTES / 2053);
    long_links.push_str(&"x".repeat(parser::MAX_DOCUMENT_BYTES - long_links.len()));
    for n in 0..SOURCE_SLICE {
        handoff(&mut store, "before_long_literal", budget);
        write(
            &mut store,
            &format!("long-{n}"),
            &format!("long-{n}.md"),
            &long_links,
            n as i64 + 60,
        );
    }
    loop {
        let jobs = prepare_batch(&store, SOURCE_SLICE).unwrap();
        if jobs.is_empty() {
            break;
        }
        let mut staged: std::collections::VecDeque<_> = jobs
            .into_iter()
            .map(|(w, h)| Staged::new(parser::parse(w, h.unwrap()).unwrap()))
            .collect();
        while !staged.is_empty() {
            handoff(&mut store, "before_long_literal_batch", budget);
            stage_batch(&mut staged, &mut store, &NoFaults).unwrap();
            maximum = maximum.max(handoff(&mut store, "long_literal_batch", budget));
        }
    }
    assert_eq!(count(&store, "link_pending"), 0);
    eprintln!(
        "BUSY_BUDGET maximal_link_reindex max_catch_up_us={}",
        maximum.as_micros()
    );
}

fn seed_phase(s: &EngineStore) -> String {
    s.read_with(|c| {
        c.query_row(
            "SELECT seed_phase FROM link_index_state WHERE workspace_id='ws' AND version_id='main'",
            [],
            |r| r.get(0),
        )
    })
    .unwrap()
}
#[test]
fn initial_capture_defers_all_link_rows_and_restart_reseeds() {
    let scratch = ScratchDir::new().unwrap();
    let db = engine_db_path(&scratch).unwrap();
    let mut s = open(&db);
    for n in 0..65 {
        write_deferred(
            &mut s,
            &format!("note-{n}"),
            &format!("note-{n:03}.md"),
            "[[target]]",
            n + 2,
        );
    }
    write_deferred(&mut s, "target", "target.md", "target", 100);
    assert_eq!(seed_phase(&s), "deferred");
    assert_eq!(count(&s, "link_pending"), 0);
    assert_eq!(count(&s, "link_aliases"), 0);
    assert!(prepare_batch(&s, SOURCE_SLICE).unwrap().is_empty());
    let old_index: i64 = s
        .read_with(|c| {
            c.query_row(
                "SELECT count(*) FROM sqlite_schema WHERE name='link_alias_object'",
                [],
                |r| r.get(0),
            )
        })
        .unwrap();
    assert_eq!(old_index, 0);
    drop(s);
    let mut s = open(&db);
    assert_eq!(seed_phase(&s), "deferred");
    assert!(retry_file_locked("link drain seed_step", || seed_step(
        &mut s
    )));
    assert_eq!(count(&s, "link_aliases"), 32);
    assert!(prepare_batch(&s, SOURCE_SLICE).unwrap().is_empty());
    drain(&mut s);
    assert_eq!(seed_phase(&s), "ready");
    assert_eq!(count(&s, "link_sources"), 66);
    let pairs: Vec<(String,String)> = s.read_with(|c| c.prepare("SELECT source.object_id,target.object_id FROM link_sources target JOIN link_target_keys t USING(workspace_id,version_id,object_id,index_key) JOIN link_occurrence_keys k ON k.workspace_id=t.workspace_id AND k.version_id=t.version_id AND k.key_kind=t.key_kind AND k.key=t.key JOIN link_sources source ON source.workspace_id=k.workspace_id AND source.version_id=k.version_id AND source.object_id=k.object_id AND source.index_key=k.index_key WHERE t.key_kind='stem' ORDER BY source.object_id,target.object_id")?.query_map([], |r| Ok((r.get(0)?,r.get(1)?)))?.collect::<rusqlite::Result<_>>()).unwrap();
    let mut expected = (0..65)
        .map(|n| (format!("note-{n}"), "target".to_owned()))
        .collect::<Vec<_>>();
    expected.sort();
    assert_eq!(pairs, expected);
}
#[test]
fn outside_edits_behind_and_ahead_of_the_seed_cursor_are_captured() {
    let scratch = ScratchDir::new().unwrap();
    let db = engine_db_path(&scratch).unwrap();
    let mut s = open(&db);
    for n in 0..65 {
        write_deferred(
            &mut s,
            &format!("note-{n}"),
            &format!("note-{n:03}.md"),
            "[[old]]",
            n + 2,
        );
    }
    assert!(retry_file_locked("link drain seed_step", || seed_step(
        &mut s
    )));
    let revision_before: i64 = s.read_with(|c| c.query_row(
        "SELECT revision FROM link_pending WHERE workspace_id='ws' AND version_id='main' AND object_id='note-0'", [], |r| r.get(0))).unwrap();
    // Capture newer disk bytes while the cursor is between these paths.
    for (path, now_ms) in [("note-000.md", 100), ("note-064.md", 101)] {
        let disk = scratch.path().join(path);
        std::fs::write(&disk, "[[new]]").unwrap();
        VersionedTextStore::new(&mut s)
            .capture_ingest(
                &dohc_engine_domain::CaptureIngest {
                    workspace_id: "ws".into(),
                    version_id: "main".into(),
                    path: path.into(),
                    text: std::fs::read_to_string(disk).unwrap(),
                    metadata_origin: "test".into(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: None,
                    now_ms,
                    request_id: None,
                    claim_foreign_head: false,
                },
                &NoFaults,
            )
            .unwrap();
    }
    let revision_after: i64 = s.read_with(|c| c.query_row(
        "SELECT revision FROM link_pending WHERE workspace_id='ws' AND version_id='main' AND object_id='note-0'", [], |r| r.get(0))).unwrap();
    // The scan already queued note-0. Only snapshot invalidation bumps its
    // revision twice for OLD and NEW; parsing newer bytes alone cannot prove it.
    assert_eq!(revision_after, revision_before + 2);
    write_deferred(&mut s, "added", "aaa.md", "[[added]]", 102);
    s.write_with(&NoFaults, |tx| {
        tx.execute("DELETE FROM path_aliases WHERE workspace_id='ws' AND version_id='main' AND path='note-001.md'", []).map_err(sql)?;
        tx.execute("UPDATE path_aliases SET path='renamed.md' WHERE workspace_id='ws' AND version_id='main' AND path='note-002.md'", []).map_err(sql)?;
        Ok::<_,StorageError>(())
    }).unwrap();
    drain(&mut s);
    assert_eq!(seed_phase(&s), "ready");
    assert_eq!(count(&s, "link_sources"), 65);
    let rows: Vec<(String,String)> = s.read_with(|c| c.prepare("SELECT s.path,l.literal FROM link_sources s JOIN links l USING(workspace_id,version_id,object_id,index_key) WHERE s.object_id IN ('note-0','note-64','added','note-2') ORDER BY s.path")?.query_map([], |r| Ok((r.get(0)?,r.get(1)?)))?.collect::<rusqlite::Result<_>>()).unwrap();
    assert_eq!(
        rows,
        vec![
            ("aaa.md".into(), "added".into()),
            ("note-000.md".into(), "new".into()),
            ("note-064.md".into(), "new".into()),
            ("renamed.md".into(), "old".into())
        ]
    );
}
#[test]
fn seed_cursor_and_last_certification_obligation_commit_atomically() {
    for point in [
        FaultPoint::StorageBeforePersist,
        FaultPoint::StorageAfterCommitBeforeAck,
    ] {
        let scratch = ScratchDir::new().unwrap();
        let db = engine_db_path(&scratch).unwrap();
        let mut s = open(&db);
        write_deferred(&mut s, "a", "a.md", "[[b]]", 2);
        assert!(!retry_file_locked("link drain seed_step_with", || {
            seed_step_with(&mut s, &*ScriptedFaults::crash_at(point))
        }));
        assert_eq!(
            count(&s, "link_aliases"),
            i64::from(point == FaultPoint::StorageAfterCommitBeforeAck)
        );
        drop(s);
        let mut s = open(&db);
        while retry_file_locked("link drain seed_step", || seed_step(&mut s)) {}
        assert_eq!(seed_phase(&s), "draining");
        let staged = parsed(&s);
        // Keep the publication boundary independent of the host's slice clock.
        retry_file_locked("link source publication", || {
            s.write_with(&*ScriptedFaults::crash_at(point), |tx| {
                staged.step_in_tx(tx, Instant::now() + Duration::from_secs(60))
            })
        });
        drop(s);
        let mut s = open(&db);
        assert_eq!(
            seed_phase(&s),
            if point == FaultPoint::StorageBeforePersist {
                "draining"
            } else {
                "ready"
            }
        );
        drain(&mut s);
        assert_eq!(seed_phase(&s), "ready");
        assert_eq!(certified_literals(&s), vec!["b"]);
    }
}
#[test]
fn alias_seeding_resumes_after_abrupt_process_exit() {
    const CHILD: &str = "DOHC_LINK_SEED_CRASH_CHILD";
    if let Some(root) = std::env::var_os(CHILD) {
        let db = Path::new(&root).join("engine.db");
        let mut s = open(&db);
        for n in 0..65 {
            write_deferred(
                &mut s,
                &format!("note-{n}"),
                &format!("note-{n:03}.md"),
                "[[target]]",
                n + 2,
            );
        }
        assert!(retry_file_locked("link drain seed_step", || seed_step(
            &mut s
        )));
        assert_eq!(count(&s, "link_aliases"), 32);
        std::process::exit(73);
    }
    let scratch = ScratchDir::new().unwrap();
    let status = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "links::tests::alias_seeding_resumes_after_abrupt_process_exit",
            "--nocapture",
        ])
        .env(CHILD, scratch.path())
        .status()
        .unwrap();
    assert_eq!(status.code(), Some(73));
    let mut s = open(&scratch.path().join("engine.db"));
    assert_eq!(seed_phase(&s), "aliases");
    assert_eq!(count(&s, "link_aliases"), 32);
    drain(&mut s);
    assert_eq!(seed_phase(&s), "ready");
    assert_eq!(count(&s, "link_sources"), 65);
    assert_eq!(count(&s, "links"), 65);
}

#[test]
fn restored_snapshot_retains_the_deferred_seed_obligation() {
    let scratch = ScratchDir::new().unwrap();
    let db = engine_db_path(&scratch).unwrap();
    let mut s = open(&db);
    write_deferred(&mut s, "a", "a.md", "[[b]]", 2);
    let restored = scratch.path().join("restored.db");
    s.read_with(|c| c.execute("VACUUM INTO ?1", [restored.to_str().unwrap()]))
        .unwrap();
    drop(s);
    let mut s = open(&restored);
    assert_eq!(seed_phase(&s), "deferred");
    drain(&mut s);
    assert_eq!(seed_phase(&s), "ready");
    assert_eq!(certified_literals(&s), vec!["b"]);
}
#[test]
fn fork_of_a_partial_seed_preserves_its_cursor_and_obligation() {
    let scratch = ScratchDir::new().unwrap();
    let db = engine_db_path(&scratch).unwrap();
    let mut s = open(&db);
    for n in 0..65 {
        write_deferred(
            &mut s,
            &format!("note-{n}"),
            &format!("note-{n:03}.md"),
            "[[target]]",
            n + 2,
        );
    }
    retry_file_locked("link drain seed_step", || seed_step(&mut s));
    VersionedTextStore::new(&mut s)
        .create_named_version(
            &CreateNamedVersion {
                workspace_id: "ws".into(),
                new_version_id: "fork".into(),
                name: "fork".into(),
                from_version_id: "main".into(),
                now_ms: 100,
                request_id: None,
            },
            &NoFaults,
        )
        .unwrap();
    assert_eq!(count(&s, "link_aliases"), 64);
    drain(&mut s);
    assert_eq!(count(&s, "link_sources"), 130);
    assert_eq!(count(&s, "links"), 130);
    let obligations: i64 = s
        .read_with(|c| {
            c.query_row(
                "SELECT count(*) FROM link_index_state WHERE seed_phase<>'ready'",
                [],
                |r| r.get(0),
            )
        })
        .unwrap();
    assert_eq!(obligations, 0);
}

#[test]
fn passive_links_never_queue_seed_or_drain_even_with_leftover_work() {
    let scratch = ScratchDir::new().unwrap();
    let db = engine_db_path(&scratch).unwrap();
    let mut store = EngineStore::open_passive(&db, 1, None, None).unwrap();
    VersionedTextStore::new(&mut store)
        .ensure_main_version("ws", "main", 1, &NoFaults)
        .unwrap();
    assert_eq!(
        count(&store, "link_index_state"),
        0,
        "passive versions create no seed obligation"
    );
    for phase in ["deferred", "aliases", "draining", "ready"] {
        store.read_with(|c| {
            c.execute("INSERT INTO link_index_state(workspace_id,version_id,parser_generation,seed_phase) VALUES('ws','main',0,?1) ON CONFLICT(workspace_id,version_id) DO UPDATE SET seed_phase=excluded.seed_phase", [phase])?;
            c.execute_batch("INSERT OR IGNORE INTO file_objects VALUES('ws','note',1); INSERT OR IGNORE INTO blobs VALUES('hash',10,'[[target]]'); INSERT INTO path_aliases VALUES('ws','main','note.md','note'); INSERT INTO snapshots(workspace_id,version_id,object_id,path,blob_sha256,updated_at_ms,latest_moment_id,metadata_origin) VALUES('ws','main','note','note.md','hash',1,'m','sync'); INSERT INTO fork_base_snapshots(workspace_id,version_id,object_id,path,blob_sha256,updated_at_ms,latest_moment_id,metadata_origin) VALUES('ws','main','note','note.md','hash',1,'m','sync'); UPDATE snapshots SET path='renamed.md'; UPDATE fork_base_snapshots SET path='renamed.md'; UPDATE path_aliases SET path='renamed.md'; DELETE FROM snapshots; DELETE FROM fork_base_snapshots; DELETE FROM path_aliases;")?;
            Ok::<_, rusqlite::Error>(())
        }).unwrap();
        assert_eq!(count(&store, "link_pending"), 0, "phase={phase}");
        assert_eq!(count(&store, "link_aliases"), 0, "phase={phase}");
    }
    // Leftover derived work must remain inert on a passive store as well.
    store.read_with(|c| c.execute_batch("UPDATE link_index_state SET seed_phase='aliases'; INSERT INTO link_pending(workspace_id,version_id,object_id,queued_at_ms) VALUES('ws','main','note',1); INSERT INTO link_gc VALUES('ws','main','note','old');")).unwrap();
    let before = store
        .read_with(|c| Ok::<_, rusqlite::Error>(c.total_changes()))
        .unwrap();
    assert!(!retry_file_locked("link drain seed_step", || seed_step(
        &mut store
    )));
    assert!(!retry_file_locked(
        "link drain reseed_step",
        || reseed_step(&mut store)
    ));
    assert!(!retry_file_locked("link drain gc_step", || gc_step(
        &mut store
    )));
    assert!(prepare_batch(&store, SOURCE_SLICE).unwrap().is_empty());
    let metrics = SharedMetrics::default();
    let mut worker = DrainWorker::new(metrics.clone()).unwrap();
    assert_eq!(worker.tick(&mut store), Duration::MAX);
    assert_eq!(metrics.lock().unwrap().actor_batches, 0);
    store
        .write_with(&NoFaults, |tx| {
            dohc_engine_storage::links::copy_version_in_tx(tx, "ws", "main", "fork")
                .map_err(sql)?;
            Ok::<_, StorageError>(())
        })
        .unwrap();
    assert_eq!(
        store
            .read_with(|c| Ok::<_, rusqlite::Error>(c.total_changes()))
            .unwrap(),
        before
    );
    assert_eq!(count(&store, "link_pending"), 1);
    assert_eq!(count(&store, "link_index_state"), 1);
    assert_eq!(count(&store, "link_gc"), 1);
}

#[path = "incoming_tests.rs"]
mod incoming_tests;

#[path = "query_tests.rs"]
mod query_tests;

#[path = "edges_tests.rs"]
mod edges_tests;
