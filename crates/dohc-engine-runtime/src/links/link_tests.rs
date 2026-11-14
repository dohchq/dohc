use super::*;
use dohc_engine_domain::{CreateNamedVersion, DomainError, VersionedTextStore, WriteText};
use dohc_engine_storage::{FaultPoint, hex_sha256};
use dohc_engine_testkit::{ScratchDir, ScriptedFaults, engine_db_path};
use std::path::Path;

thread_local! {
    static WAL_THRESHOLD: std::cell::Cell<i32> = const { std::cell::Cell::new(0) };
    static WAL_CHECKPOINT_RAN: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

pub(super) fn observe_checkpoints(store: &mut EngineStore) {
    store
        .read_with(|c| {
            let threshold: i32 = c.query_row("PRAGMA wal_autocheckpoint", [], |r| r.get(0))?;
            WAL_THRESHOLD.set(threshold);
            Ok::<_, rusqlite::Error>(())
        })
        .unwrap();
    store
        .hooks_with(|c| {
            // Match sqlite3WalDefaultHook: same threshold, passive checkpoint,
            // and ignored checkpoint errors. This hook exists only in tests.
            c.wal_hook(Some(
                |wal: &mut rusqlite::hooks::Wal, frames: std::ffi::c_int| {
                    let threshold = WAL_THRESHOLD.get();
                    if threshold > 0 && frames >= threshold {
                        WAL_CHECKPOINT_RAN.set(true);
                        let _ = wal.checkpoint();
                    }
                    Ok(())
                },
            ))
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
