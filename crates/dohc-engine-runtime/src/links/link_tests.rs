use super::*;
use dohc_engine_domain::{
    CreateNamedVersion, RollbackTextFileMutation, VersionedTextStore, WriteText,
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
fn write(s: &mut EngineStore, object: &str, path: &str, text: &str, n: i64) {
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
    let deadline = Instant::now() + Duration::from_secs(60);
    let mut backoff = Duration::from_millis(5);
    loop {
        let mut versions = VersionedTextStore::new(s);
        let result = versions
            .ensure_main_version("ws", "main", 1, &NoFaults)
            .and_then(|_| versions.write_text(&input, &NoFaults));
        match result {
            Ok(_) => return,
            Err(dohc_engine_domain::DomainError::Storage(
                dohc_engine_storage::StorageError::FileLocked,
            )) => {
                let remaining = deadline.saturating_duration_since(Instant::now());
                assert!(
                    !remaining.is_zero(),
                    "link fixture write stayed locked until its deadline"
                );
                std::thread::sleep(backoff.min(remaining));
                assert!(
                    Instant::now() < deadline,
                    "link fixture write stayed locked until its deadline"
                );
                backoff = (backoff * 2).min(Duration::from_millis(200));
            }
            Err(error) => panic!("link fixture write failed: {error:?}"),
        }
    }
}

fn count(s: &EngineStore, table: &str) -> i64 {
    s.read_with(|c| c.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0)))
        .unwrap()
}
fn parsed(s: &EngineStore) -> Staged {
    let (w, h) = prepare(s).unwrap().unwrap();
    Staged::new(parser::parse(w, h).unwrap())
}
fn drain(s: &mut EngineStore) {
    for _ in 0..10000 {
        let jobs = prepare_batch(s, SOURCE_SLICE).unwrap();
        if jobs.is_empty() {
            if gc_step(s).unwrap() || reseed_step(s).unwrap() {
                continue;
            }
            return;
        }
        let mut staged: std::collections::VecDeque<_> = jobs
            .into_iter()
            .map(|(w, h)| Staged::new(parser::parse(w, h.unwrap()).unwrap()))
            .collect();
        while !staged.is_empty() {
            stage_batch(&mut staged, s, &NoFaults).unwrap();
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
    assert!(stale.step(&mut s, &NoFaults).unwrap());
    assert_eq!(certified_literals(&s), vec!["old"]);
    assert_eq!(count(&s, "link_pending"), 1);
    let mut latest = parsed(&s);
    assert!(
        latest
            .step(
                &mut s,
                &*ScriptedFaults::crash_at(FaultPoint::StorageBeforePersist)
            )
            .unwrap()
    );
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
    assert!(!staged.step(&mut s, &NoFaults).unwrap());
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
            assert!(!staged.step(&mut s, &NoFaults).unwrap());
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
    assert!(old.step(&mut s, &NoFaults).unwrap());
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
    while !staged.step(&mut s, &NoFaults).unwrap() {}
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
    assert_eq!(count(&s, "link_pending"), 1);
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
        let target = path_keys(fixture["target"].as_str().unwrap());
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
fn capture_holds_pause_the_actor_and_last_release_resumes_it() {
    let scratch = ScratchDir::new().unwrap();
    let db = engine_db_path(&scratch).unwrap();
    let supervisor = crate::WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 1).unwrap().actor;
    let outer = actor.defer_link_drain_for_capture();
    let inner = actor.defer_link_drain_for_capture();
    for n in 0..32 {
        actor
            .capture_ingest_blocking(
                dohc_engine_domain::CaptureIngest {
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
                dohc_engine_collab::LeaseRegistry::new(),
                std::sync::Arc::new(NoFaults),
            )
            .unwrap();
    }
    let observer = EngineStore::open_read_only(&db).unwrap();
    assert_eq!(count(&observer, "link_pending"), 32);
    assert_eq!(count(&observer, "link_sources"), 0);
    drop(inner);
    // A foreground command provides an actor barrier, with the outer hold live.
    actor
        .capture_ingest_blocking(
            dohc_engine_domain::CaptureIngest {
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
            dohc_engine_collab::LeaseRegistry::new(),
            std::sync::Arc::new(NoFaults),
        )
        .unwrap();
    assert_eq!(count(&observer, "link_sources"), 0);
    drop(outer);
    let deadline = Instant::now() + Duration::from_secs(30);
    while count(&observer, "link_pending") != 0 {
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
        stage_batch(&mut batch, &mut s, &*ScriptedFaults::crash_at(point)).unwrap();
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
        jobs.into_iter().map(|w| { let h=head(c,&w,true)?; Ok(Staged::new(parser::parse(w,h)?)) }).collect::<Result<std::collections::VecDeque<_>,StorageError>>()
    }).unwrap();
    write(&mut s, "stale", "stale.md", "[[new]]", 5);
    stage_batch(&mut staged, &mut s, &NoFaults).unwrap();
    while staged.len() > 1 || staged.front().unwrap().offset == 0 {
        stage_batch(&mut staged, &mut s, &NoFaults).unwrap();
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
        stage_batch(&mut staged, &mut store, &NoFaults).unwrap();
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
