use super::*;
use dohc_engine_domain::{
    CreateNamedVersion, RollbackTextFileMutation, VersionedTextStore, WriteText,
};
use dohc_engine_storage::{FaultPoint, hex_sha256};
use dohc_engine_testkit::{ScratchDir, ScriptedFaults, engine_db_path};
use std::path::Path;

fn open(path: &Path) -> EngineStore {
    EngineStore::open(path, 1).unwrap()
}
fn write(s: &mut EngineStore, object: &str, path: &str, text: &str, n: i64) {
    let mut v = VersionedTextStore::new(s);
    v.ensure_main_version("ws", "main", 1, &NoFaults).unwrap();
    v.write_text(
        &WriteText {
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
        },
        &NoFaults,
    )
    .unwrap();
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
        if gc_step(s).unwrap() || reseed_step(s).unwrap() {
            continue;
        }
        let Some((w, h)) = prepare(s).unwrap() else {
            return;
        };
        let mut p = Staged::new(parser::parse(w, h).unwrap());
        while !p.step(s, &NoFaults).unwrap() {}
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
    assert_eq!(count(&s, "link_target_keys"), 4);
    s.write_with(&NoFaults, |tx| {
        tx.execute(
            "UPDATE snapshots SET metadata_summary='changed',updated_at_ms=8",
            [],
        )
        .map_err(sql)?;
        Ok::<_, StorageError>(())
    })
    .unwrap();
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
            c.prepare("SELECT key FROM link_target_keys WHERE key_kind='path' ORDER BY key")?
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
    let actor = supervisor.open(&db, 1).unwrap().actor;
    let deadline = Instant::now() + Duration::from_secs(30);
    let observer = EngineStore::open_read_only(&db).unwrap();
    while count(&observer, "link_pending") != 0 || actor.link_drain_metrics().certified_sources != 1
    {
        assert!(Instant::now() < deadline, "actor drain deadline");
        std::thread::yield_now();
    }
    let metrics = actor.link_drain_metrics();
    eprintln!("link drain metrics: {metrics:?}");
    // A normal actor mutation wakes a parked drain without an external poll.
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
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
    while count(&observer, "link_pending") != 0 || actor.link_drain_metrics().certified_sources != 2
    {
        assert!(Instant::now() < deadline, "idle actor drain deadline");
        std::thread::yield_now();
    }
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
    assert_eq!(count(&s, "link_target_keys"), 4);
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
    assert_eq!(count(&s, "link_target_keys"), 8);
    s.write_with(&NoFaults, |tx| {
        tx.execute("DELETE FROM versions WHERE version_id='fork'", [])
            .map_err(sql)?;
        Ok::<_, StorageError>(())
    })
    .unwrap();
    drain(&mut s);
    assert_eq!(count(&s, "link_sources"), 1);
    assert_eq!(count(&s, "link_target_keys"), 4);
}
#[test]
fn five_hundred_links_publish_atomically_in_bounded_actor_slices() {
    let scratch = ScratchDir::new().unwrap();
    let db = engine_db_path(&scratch).unwrap();
    let mut s = open(&db);
    write(&mut s, "a", "a.md", &"[[target]] ".repeat(500), 2);
    let mut staged = parsed(&s);
    let mut batches = 0;
    let mut durations = Vec::new();
    let began = Instant::now();
    loop {
        let start = Instant::now();
        let done = staged.step(&mut s, &NoFaults).unwrap();
        durations.push(start.elapsed());
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
    assert!(batches >= 34);
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
