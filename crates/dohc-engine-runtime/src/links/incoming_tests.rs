use super::*;
use crate::links::{incoming, resolver::Resolver};

fn lookup(s: &EngineStore, target: &str) -> incoming::Candidates {
    s.read_with(|c| incoming::candidates(c, "ws", "main", target, &["wikilink"]))
        .unwrap()
}

fn read(s: &EngineStore, object: &str) -> parser::Parsed {
    let source = s
        .read_with(|c| incoming::read_source(c, "ws", "main", object))
        .unwrap()
        .unwrap();
    // Hydration finishes before parsing, as it must on the actor.
    std::thread::spawn(move || source.parse())
        .join()
        .unwrap()
        .unwrap()
}

#[test]
fn incoming_probes_only_certified_wikilinks_and_deduplicates_sources() {
    let scratch = ScratchDir::new().unwrap();
    let mut s = open(&engine_db_path(&scratch).unwrap());
    write(&mut s, "a", "a.md", "[[target]] [[target#part|label]]", 1);
    write(&mut s, "b", "b.md", "[markdown](target.md)", 2);
    write(&mut s, "c", "c.md", "[[unrelated]]", 3);
    drain(&mut s);
    assert_eq!(
        lookup(&s, "target.md"),
        incoming::Candidates {
            sources: vec![("a".into(), "a.md".into())],
            unchecked: vec![],
        }
    );
    assert!(lookup(&s, "absent.md").sources.is_empty());
    // Obsolete generations must not turn a Markdown-only source into a match.
    s.write_with(&NoFaults, |tx| {
        tx.execute(
            "UPDATE link_sources SET index_key='obsolete' WHERE object_id='a'",
            [],
        )
        .map_err(sql)?;
        Ok::<_, StorageError>(())
    })
    .unwrap();
    assert!(lookup(&s, "target.md").sources.is_empty());
}

#[test]
fn pending_heads_replace_stale_links_without_publishing_or_draining() {
    let scratch = ScratchDir::new().unwrap();
    let mut s = open(&engine_db_path(&scratch).unwrap());
    write(&mut s, "a", "a.md", "[[old]]", 1);
    drain(&mut s);
    write(
        &mut s,
        "a",
        "a.md",
        "[[new#part|label]] [markdown](new.md)",
        2,
    );
    // No old index key can find the newly typed target; pending work must.
    assert_eq!(
        lookup(&s, "new.md").sources,
        vec![("a".into(), "a.md".into())]
    );
    let parsed = read(&s, "a");
    assert!(parsed.work.id > 0);
    assert_eq!(parsed.reason, None);
    assert_eq!(
        parsed.head.unwrap().hash,
        hex_sha256(b"[[new#part|label]] [markdown](new.md)")
    );
    assert_eq!(parsed.occurrences[0].literal, "new#part");
    assert_eq!(parsed.occurrences[0].fragment.as_deref(), Some("part"));
    assert_eq!(count(&s, "link_pending"), 1);
    assert_eq!(source_hash(&s), hex_sha256(b"[[old]]"));
}

#[test]
fn unindexed_sources_are_unchecked_even_with_pending_work() {
    let scratch = ScratchDir::new().unwrap();
    let mut s = open(&engine_db_path(&scratch).unwrap());
    write(
        &mut s,
        "a",
        "large.md",
        &"x".repeat(parser::MAX_DOCUMENT_BYTES + 1),
        1,
    );
    write(&mut s, "b", "refused.md", &"[[target]] ".repeat(4097), 2);
    drain(&mut s);
    assert_eq!(
        lookup(&s, "target.md").unchecked,
        vec!["large.md", "refused.md"]
    );
    assert!(lookup(&s, "target.md").sources.is_empty());
    write(&mut s, "a", "large.md", "[[target]]", 3);
    let result = lookup(&s, "target.md");
    assert_eq!(result.unchecked.len(), 2);
    assert!(result.sources.is_empty());
}

#[test]
fn newly_pending_oversized_head_reports_parse_bound() {
    let scratch = ScratchDir::new().unwrap();
    let mut s = open(&engine_db_path(&scratch).unwrap());
    write(
        &mut s,
        "a",
        "a.md",
        &"x".repeat(parser::MAX_DOCUMENT_BYTES + 1),
        1,
    );
    assert_eq!(lookup(&s, "target.md").sources.len(), 1);
    assert_eq!(read(&s, "a").reason, Some("byte-bound"));
    assert_eq!(count(&s, "link_sources"), 0);
}

#[test]
fn seed_counts_unreached_objects_once_and_never_double_counts_pending() {
    let scratch = ScratchDir::new().unwrap();
    let mut s = open(&engine_db_path(&scratch).unwrap());
    write_deferred(&mut s, "a", "a.md", "[[target]]", 1);
    write_deferred(&mut s, "b", "b.md", "", 2);
    assert_eq!(lookup(&s, "target.md").unchecked, vec!["a.md", "b.md"]);
    assert!(lookup(&s, "target.md").sources.is_empty());
    while retry_file_locked("link drain seed_step", || seed_step(&mut s)) {}
    let pending = lookup(&s, "target.md");
    assert!(pending.unchecked.is_empty());
    assert_eq!(pending.sources.len(), 2);
    drain(&mut s);
    let ready = lookup(&s, "target.md");
    assert!(ready.unchecked.is_empty());
    assert_eq!(ready.sources, vec![("a".into(), "a.md".into())]);
    // A missing state is also incomplete, not silently ready.
    s.write_with(&NoFaults, |tx| {
        tx.execute("DELETE FROM link_index_state", []).map_err(sql)?;
        tx.execute("DELETE FROM link_sources WHERE object_id='b'", []).map_err(sql)?;
        tx.execute("INSERT INTO path_aliases(workspace_id,version_id,object_id,path) VALUES('ws','main','b','alias.md')", []).map_err(sql)?;
        tx.execute("DELETE FROM link_pending", []).map_err(sql)?;
        Ok::<_, StorageError>(())
    }).unwrap();
    assert_eq!(lookup(&s, "target.md").unchecked, vec!["alias.md"]);
}

#[test]
fn resolver_and_candidates_are_scoped_to_workspace_and_version() {
    let scratch = ScratchDir::new().unwrap();
    let mut s = open(&engine_db_path(&scratch).unwrap());
    write(&mut s, "a", "source.md", "[[target]]", 1);
    write(&mut s, "t", "target.md", "", 2);
    drain(&mut s);
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
    s.read_with(|c| {
        let resolver = Resolver::new(Resolver::paths_for_version(c, "ws", "fork")?);
        assert_eq!(resolver.resolve("source.md", "target"), Some("target.md"));
        let foreign = Resolver::new(Resolver::paths_for_version(c, "other", "main")?);
        assert_eq!(foreign.resolve("source.md", "target"), None);
        assert_eq!(
            incoming::candidates(c, "ws", "fork", "target.md", &["wikilink"])?
                .sources
                .len(),
            1
        );
        assert!(
            incoming::candidates(c, "other", "main", "target.md", &["wikilink"])?
                .sources
                .is_empty()
        );
        assert!(
            incoming::candidates(c, "ws", "other", "target.md", &["wikilink"])?
                .sources
                .is_empty()
        );
        let source = incoming::read_source(c, "ws", "fork", "a")?.unwrap();
        assert_eq!(source.parse()?.occurrences[0].literal, "target");
        assert!(incoming::read_source(c, "other", "main", "a")?.is_none());
        Ok::<_, StorageError>(())
    })
    .unwrap();
}

#[test]
fn removed_sources_are_ignored_and_candidate_matches_need_resolution() {
    let scratch = ScratchDir::new().unwrap();
    let mut s = open(&engine_db_path(&scratch).unwrap());
    write(&mut s, "a", "a.md", "[[target]]", 1);
    write(&mut s, "t", "notes/target.md", "", 2);
    write(&mut s, "u", "other/target.md", "", 3);
    drain(&mut s);
    assert_eq!(lookup(&s, "notes/target.md").sources.len(), 1);
    let resolver = s
        .read_with(|c| Resolver::paths_for_version(c, "ws", "main"))
        .unwrap();
    let resolver = Resolver::new(resolver);
    assert_eq!(resolver.resolve("a.md", "target"), None);
    s.write_with(&NoFaults, |tx| {
        tx.execute("DELETE FROM path_aliases WHERE object_id='a'", [])
            .map_err(sql)?;
        Ok::<_, StorageError>(())
    })
    .unwrap();
    assert!(lookup(&s, "notes/target.md").sources.is_empty());
    assert!(
        s.read_with(|c| incoming::read_source(c, "ws", "main", "a"))
            .unwrap()
            .is_none()
    );
}

#[test]
fn source_parsing_checks_blob_integrity() {
    let scratch = ScratchDir::new().unwrap();
    let mut s = open(&engine_db_path(&scratch).unwrap());
    write(&mut s, "a", "a.md", "[[target]]", 1);
    let source = s
        .read_with(|c| incoming::read_source(c, "ws", "main", "a"))
        .unwrap()
        .unwrap();
    // A captured source owns its bytes even after the head changes.
    write(&mut s, "a", "a.md", "[[other]]", 2);
    assert_eq!(source.parse().unwrap().occurrences[0].literal, "target");
    s.write_with(&NoFaults, |tx| {
        tx.execute(
            "UPDATE blobs SET text='corrupted' WHERE sha256=?1",
            [hex_sha256(b"[[other]]")],
        )
        .map_err(sql)?;
        Ok::<_, StorageError>(())
    })
    .unwrap();
    let source = s
        .read_with(|c| incoming::read_source(c, "ws", "main", "a"))
        .unwrap()
        .unwrap();
    assert!(matches!(
        source.parse(),
        Err(StorageError::BlobIntegrity { .. })
    ));
}

#[test]
fn prior_generation_keys_are_candidates_until_reseeded() {
    let scratch = ScratchDir::new().unwrap();
    let mut s = open(&engine_db_path(&scratch).unwrap());
    write(&mut s, "a", "a.md", "[[report%20%zz]]", 1);
    drain(&mut s);
    // Generation 1 partially decoded malformed escapes, so its probe cannot
    // match the filename that the desktop resolver actually chooses.
    s.write_with(&NoFaults, |tx| {
        tx.execute(
            "UPDATE link_occurrence_keys SET key=replace(key,'%20',' ')",
            [],
        )
        .map_err(sql)?;
        tx.execute("UPDATE link_sources SET parser_generation=1", [])
            .map_err(sql)?;
        tx.execute("UPDATE link_index_state SET parser_generation=1", [])
            .map_err(sql)?;
        Ok::<_, StorageError>(())
    })
    .unwrap();
    assert_eq!(count(&s, "link_pending"), 0);
    assert_eq!(
        lookup(&s, "report%20%zz.md").sources,
        vec![("a".into(), "a.md".into())]
    );
    assert_eq!(read(&s, "a").occurrences[0].literal, "report%20%zz");
    drain(&mut s);
    assert_eq!(lookup(&s, "report%20%zz.md").sources.len(), 1);
    assert_eq!(count(&s, "link_pending"), 0);
    s.read_with(|c| {
        assert_eq!(
            c.query_row("SELECT parser_generation FROM link_sources", [], |r| r
                .get::<_, i64>(0))?,
            PARSER_GENERATION
        );
        assert_eq!(
            c.query_row(
                "SELECT COUNT(*) FROM link_occurrence_keys WHERE key LIKE '%20%zz%'",
                [],
                |r| r.get::<_, i64>(0)
            )?,
            3
        );
        Ok::<_, rusqlite::Error>(())
    })
    .unwrap();
}

#[test]
fn fresh_seed_does_not_queue_current_sources_again() {
    let scratch = ScratchDir::new().unwrap();
    let mut s = open(&engine_db_path(&scratch).unwrap());
    for n in 0..1000 {
        write_deferred(
            &mut s,
            &format!("n{n:04}"),
            &format!("n{n:04}.md"),
            "[[target]]",
            n + 1,
        );
    }
    while retry_file_locked("link drain seed_step", || seed_step(&mut s)) {}
    publish_pending(&mut s);
    assert_eq!(count(&s, "link_sources"), 1000);
    assert!(
        s.read_with(
            |c| c.query_row("SELECT seed_phase='ready' FROM link_index_state", [], |r| r
                .get::<_, bool>(0))
        )
        .unwrap()
    );
    assert!(!retry_file_locked(
        "link drain reseed_step",
        || reseed_step(&mut s)
    ));
    assert_eq!(
        count(&s, "link_pending"),
        0,
        "the first seed already certified generation 2 keys"
    );
    assert!(!retry_file_locked(
        "link drain reseed_step",
        || reseed_step(&mut s)
    ));
}

fn resolver_for(s: &EngineStore, ws: &str, version: &str) -> Resolver {
    let paths = s
        .read_with(|c| Resolver::paths_for_version(c, ws, version))
        .unwrap();
    // Index construction needs no connection and can leave the actor.
    std::thread::spawn(move || Resolver::new(paths))
        .join()
        .unwrap()
}

fn fork(s: &mut EngineStore) {
    VersionedTextStore::new(s)
        .create_named_version(
            &CreateNamedVersion {
                workspace_id: "ws".into(),
                new_version_id: "fork".into(),
                name: "fork".into(),
                from_version_id: "main".into(),
                now_ms: 1000,
                request_id: None,
            },
            &NoFaults,
        )
        .unwrap();
}

fn write_scoped(
    s: &mut EngineStore,
    ws: &str,
    version: &str,
    object: &str,
    path: &str,
    text: &str,
) {
    VersionedTextStore::new(s)
        .ensure_main_version(ws, "main", 1, &NoFaults)
        .unwrap();
    while retry_file_locked("link alias seeding", || seed_step(s)) {}
    VersionedTextStore::new(s)
        .write_text(
            &WriteText {
                workspace_id: ws.into(),
                version_id: version.into(),
                object_id: object.into(),
                path: path.into(),
                text: text.into(),
                moment_id: format!("{ws}-{version}-{object}"),
                metadata_origin: "test".into(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 1001,
                request_id: None,
            },
            &NoFaults,
        )
        .unwrap();
}

#[test]
fn authoritative_resolver_is_complete_during_deferred_and_partial_seed() {
    let scratch = ScratchDir::new().unwrap();
    let mut s = open(&engine_db_path(&scratch).unwrap());
    write_deferred(&mut s, "a", "a/report.md", "", 1);
    for n in 0..40 {
        write_deferred(
            &mut s,
            &format!("n{n:03}"),
            &format!("m/{n:03}.md"),
            "",
            n + 2,
        );
    }
    write_deferred(&mut s, "z", "z/report.md", "", 50);
    assert_eq!(count(&s, "link_aliases"), 0);
    assert_eq!(
        resolver_for(&s, "ws", "main").resolve("source.md", "report"),
        None
    );
    assert_eq!(
        resolver_for(&s, "ws", "main").resolve("source.md", "/z/report"),
        Some("z/report.md")
    );
    assert!(retry_file_locked("link drain seed_step", || seed_step(
        &mut s
    )));
    assert_eq!(count(&s, "link_aliases"), 32);
    assert_eq!(
        resolver_for(&s, "ws", "main").resolve("source.md", "report"),
        None
    );
    assert_eq!(
        resolver_for(&s, "ws", "main").resolve("source.md", "/z/report"),
        Some("z/report.md")
    );
}

#[test]
fn edited_fork_keeps_main_results_isolated() {
    let scratch = ScratchDir::new().unwrap();
    let mut s = open(&engine_db_path(&scratch).unwrap());
    write(&mut s, "a", "source.md", "[[target]]", 1);
    write(&mut s, "t", "target.md", "", 2);
    drain(&mut s);
    fork(&mut s);
    let before = lookup(&s, "target.md");
    write_scoped(&mut s, "ws", "fork", "a", "source.md", "[[fork-only]]");
    drain(&mut s);
    assert_eq!(lookup(&s, "target.md"), before);
    assert_eq!(before.sources, vec![("a".into(), "source.md".into())]);
    s.read_with(|c| {
        assert!(
            incoming::candidates(c, "ws", "fork", "target.md", &["wikilink"])?
                .sources
                .is_empty()
        );
        assert_eq!(
            incoming::candidates(c, "ws", "fork", "fork-only.md", &["wikilink"])?
                .sources
                .len(),
            1
        );
        assert_eq!(
            incoming::read_source(c, "ws", "fork", "a")?
                .unwrap()
                .parse()?
                .occurrences[0]
                .literal,
            "fork-only"
        );
        Ok::<_, StorageError>(())
    })
    .unwrap();
    assert_eq!(read(&s, "a").occurrences[0].literal, "target");
    // A target rename in the fork must not alter the main resolver.
    s.write_with(&NoFaults, |tx| {
        tx.execute("UPDATE path_aliases SET path='renamed.md' WHERE workspace_id='ws' AND version_id='fork' AND object_id='t'", []).map_err(sql)?;
        Ok::<_, StorageError>(())
    }).unwrap();
    assert_eq!(
        resolver_for(&s, "ws", "fork").resolve("source.md", "target"),
        None
    );
    assert_eq!(
        resolver_for(&s, "ws", "main").resolve("source.md", "target"),
        Some("target.md")
    );
}

fn upgrade_fixture(s: &mut EngineStore) {
    for n in 0..70 {
        write(
            s,
            &format!("n{n:03}"),
            &format!("n{n:03}.md"),
            "[[target]]",
            n + 1,
        );
    }
    drain(s);
    s.write_with(&NoFaults, |tx| {
        tx.execute("UPDATE link_sources SET parser_generation=1", [])
            .map_err(sql)?;
        tx.execute(
            "UPDATE link_index_state SET parser_generation=1,seed_after_object_id=''",
            [],
        )
        .map_err(sql)?;
        Ok::<_, StorageError>(())
    })
    .unwrap();
}

fn publish_pending(s: &mut EngineStore) {
    while count(s, "link_pending") > 0 {
        let jobs = prepare_batch(s, SOURCE_SLICE).unwrap();
        assert!(!jobs.is_empty());
        let mut staged = jobs
            .into_iter()
            .map(|(w, h)| Staged::new(parser::parse(w, h.unwrap()).unwrap()))
            .collect::<std::collections::VecDeque<_>>();
        while !staged.is_empty() {
            retry_file_locked("link batch staging", || {
                stage_batch(&mut staged, s, &NoFaults)
            });
        }
    }
}

fn reseed_state(s: &EngineStore, version: &str) -> (i64, String) {
    s.read_with(|c| c.query_row("SELECT parser_generation,seed_after_object_id FROM link_index_state WHERE workspace_id='ws' AND version_id=?1", [version], |r| Ok((r.get(0)?,r.get(1)?)))).unwrap()
}

#[test]
fn reseed_reopen_retains_cursor_and_queue_and_covers_mixed_generations() {
    let scratch = ScratchDir::new().unwrap();
    let db = engine_db_path(&scratch).unwrap();
    let mut s = open(&db);
    upgrade_fixture(&mut s);
    assert!(retry_file_locked("link drain reseed_step", || reseed_step(
        &mut s
    )));
    assert_eq!(reseed_state(&s, "main"), (1, "n031".into()));
    assert_eq!(count(&s, "link_pending"), 32);
    let queue = s
        .read_with(|c| {
            c.prepare("SELECT pending_id,object_id,revision FROM link_pending ORDER BY pending_id")?
                .query_map([], |r| {
                    Ok((
                        r.get::<_, i64>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, i64>(2)?,
                    ))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()
        })
        .unwrap();
    drop(s);
    let mut s = open(&db);
    assert_eq!(reseed_state(&s, "main"), (1, "n031".into()));
    let reopened = s
        .read_with(|c| {
            c.prepare("SELECT pending_id,object_id,revision FROM link_pending ORDER BY pending_id")?
                .query_map([], |r| {
                    Ok((
                        r.get::<_, i64>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, i64>(2)?,
                    ))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()
        })
        .unwrap();
    assert_eq!(reopened, queue);
    publish_pending(&mut s);
    assert_eq!(reseed_state(&s, "main"), (1, "n031".into()));
    let current: i64 = s
        .read_with(|c| {
            c.query_row(
                "SELECT COUNT(*) FROM link_sources WHERE parser_generation=?1",
                [PARSER_GENERATION],
                |r| r.get(0),
            )
        })
        .unwrap();
    assert_eq!(current, 32);
    assert_eq!(
        lookup(&s, "absent.md").sources.len(),
        38,
        "stale sources remain candidates between batches"
    );
    assert_eq!(lookup(&s, "target.md").sources.len(), 70);
    assert!(retry_file_locked("link drain reseed_step", || reseed_step(
        &mut s
    )));
    assert_eq!(reseed_state(&s, "main"), (1, "n063".into()));
    assert_eq!(count(&s, "link_pending"), 32);
    drain(&mut s);
    assert_eq!(reseed_state(&s, "main"), (PARSER_GENERATION, String::new()));
    assert!(lookup(&s, "absent.md").sources.is_empty());
    assert_eq!(lookup(&s, "target.md").sources.len(), 70);
}

#[test]
fn fork_mid_reseed_copies_cursor_and_work_and_resumes_independently() {
    let scratch = ScratchDir::new().unwrap();
    let db = engine_db_path(&scratch).unwrap();
    let mut s = open(&db);
    upgrade_fixture(&mut s);
    assert!(retry_file_locked("link drain reseed_step", || reseed_step(
        &mut s
    )));
    // Publish one source, leaving both current and old generations plus work.
    let mut staged = parsed(&s);
    while !retry_file_locked("link source staging", || staged.step(&mut s, &NoFaults)) {}
    fork(&mut s);
    assert_eq!(reseed_state(&s, "fork"), (1, "n031".into()));
    let pending: i64 = s
        .read_with(|c| {
            c.query_row(
                "SELECT COUNT(*) FROM link_pending WHERE version_id='fork'",
                [],
                |r| r.get(0),
            )
        })
        .unwrap();
    assert_eq!(pending, 31);
    drop(s);
    let mut s = open(&db);
    drain(&mut s);
    for version in ["main", "fork"] {
        assert_eq!(
            reseed_state(&s, version),
            (PARSER_GENERATION, String::new())
        );
        let current: i64 = s.read_with(|c| c.query_row("SELECT COUNT(*) FROM link_sources WHERE version_id=?1 AND parser_generation=?2",params![version,PARSER_GENERATION],|r|r.get(0))).unwrap();
        assert_eq!(current, 70);
        assert_eq!(
            s.read_with(|c| incoming::candidates(c, "ws", version, "target.md", &["wikilink"]))
                .unwrap()
                .sources
                .len(),
            70
        );
        assert!(
            s.read_with(|c| incoming::candidates(c, "ws", version, "absent.md", &["wikilink"]))
                .unwrap()
                .sources
                .is_empty()
        );
    }
}

#[test]
fn reseed_skips_edited_sources_ahead_and_triggers_requeue_behind_cursor() {
    let scratch = ScratchDir::new().unwrap();
    let mut s = open(&engine_db_path(&scratch).unwrap());
    upgrade_fixture(&mut s);
    assert!(retry_file_locked("link drain reseed_step", || reseed_step(
        &mut s
    )));
    publish_pending(&mut s);
    write(&mut s, "n040", "n040.md", "[[ahead]]", 100);
    publish_pending(&mut s);
    let key: String = s
        .read_with(|c| {
            c.query_row(
                "SELECT index_key FROM link_sources WHERE object_id='n040'",
                [],
                |r| r.get(0),
            )
        })
        .unwrap();
    write(&mut s, "n000", "n000.md", "[[behind]]", 101);
    assert_eq!(
        count(&s, "link_pending"),
        1,
        "edit behind the cursor is queued by the trigger"
    );
    assert_eq!(lookup(&s, "behind.md").sources[0].0, "n000");
    publish_pending(&mut s);
    assert!(retry_file_locked("link drain reseed_step", || reseed_step(
        &mut s
    )));
    assert_eq!(reseed_state(&s, "main"), (1, "n063".into()));
    let ahead_queued: bool = s
        .read_with(|c| {
            c.query_row(
                "SELECT EXISTS(SELECT 1 FROM link_pending WHERE object_id='n040')",
                [],
                |r| r.get(0),
            )
        })
        .unwrap();
    assert!(!ahead_queued);
    assert_eq!(count(&s, "link_pending"), 31);
    drain(&mut s);
    assert_eq!(
        s.read_with(|c| c.query_row(
            "SELECT index_key FROM link_sources WHERE object_id='n040'",
            [],
            |r| r.get::<_, String>(0)
        ))
        .unwrap(),
        key
    );
    assert_eq!(
        lookup(&s, "behind.md").sources,
        vec![("n000".into(), "n000.md".into())]
    );
    assert_eq!(
        lookup(&s, "ahead.md").sources,
        vec![("n040".into(), "n040.md".into())]
    );
}

#[test]
fn reseed_scan_bounds_include_current_sources_and_duplicate_aliases() {
    let scratch = ScratchDir::new().unwrap();
    let mut s = open(&engine_db_path(&scratch).unwrap());
    upgrade_fixture(&mut s);
    // The first 64 sources are already current. They still consume scan slots.
    s.write_with(&NoFaults, |tx| {
        tx.execute(
            "UPDATE link_sources SET parser_generation=?1 WHERE object_id<'n064'",
            [PARSER_GENERATION],
        )
        .map_err(sql)?;
        Ok::<_, StorageError>(())
    })
    .unwrap();
    for cursor in ["n031", "n063"] {
        assert!(retry_file_locked("link drain reseed_step", || reseed_step(
            &mut s
        )));
        assert_eq!(reseed_state(&s, "main"), (1, cursor.into()));
        assert_eq!(count(&s, "link_pending"), 0);
    }
    assert!(retry_file_locked("link drain reseed_step", || reseed_step(
        &mut s
    )));
    assert_eq!(count(&s, "link_pending"), 6);
    drain(&mut s);
    // One object with many aliases also consumes only one 32-row slice.
    s.write_with(&NoFaults,|tx| {
        for n in 0..40 {
            tx.execute("INSERT INTO path_aliases(workspace_id,version_id,object_id,path) VALUES('ws','main','n000',?1)",[format!("alias-{n:03}.md")]).map_err(sql)?;
        }
        Ok::<_,StorageError>(())
    }).unwrap();
    drain(&mut s);
    s.write_with(&NoFaults, |tx| {
        tx.execute("UPDATE link_index_state SET parser_generation=1", [])
            .map_err(sql)?;
        Ok::<_, StorageError>(())
    })
    .unwrap();
    assert!(retry_file_locked("link drain reseed_step", || reseed_step(
        &mut s
    )));
    assert_eq!(reseed_state(&s, "main"), (1, "n000".into()));
    assert_eq!(count(&s, "link_pending"), 0);
    drain(&mut s);
    assert_eq!(lookup(&s, "target.md").sources.len(), 70);
}

#[test]
fn incoming_read_model_isolates_populated_workspaces_with_colliding_ids() {
    // Authoritative file_objects makes IDs globally unique. This SQL fixture
    // tests the read boundary with collisions that normal writes cannot create.
    let c = rusqlite::Connection::open_in_memory().unwrap();
    c.execute_batch("CREATE TABLE path_aliases(workspace_id,version_id,object_id,path);
        CREATE INDEX idx_path_aliases_workspace_object ON path_aliases(workspace_id,object_id);
        CREATE TABLE link_sources(workspace_id,version_id,object_id,index_key,status,parser_generation);
        CREATE TABLE link_pending(workspace_id,version_id,object_id);
        CREATE TABLE link_occurrence_keys(workspace_id,version_id,object_id,index_key,ordinal,key_kind,key);
        CREATE INDEX link_occurrence_probe ON link_occurrence_keys(workspace_id,version_id,key_kind,key,object_id,ordinal);
        CREATE TABLE links(workspace_id,version_id,object_id,index_key,ordinal,kind);
        CREATE TABLE link_index_state(workspace_id,version_id,seed_phase,parser_generation);").unwrap();
    for (ws, literal) in [("ws", "target"), ("other", "foreign")] {
        for (object, path) in [("a", "source.md"), ("t", "target.md")] {
            c.execute(
                "INSERT INTO path_aliases VALUES(?1,'main',?2,?3)",
                params![ws, object, path],
            )
            .unwrap();
        }
        c.execute(
            "INSERT INTO link_sources VALUES(?1,'main','a','certified','indexed',?2)",
            params![ws, PARSER_GENERATION],
        )
        .unwrap();
        c.execute(
            "INSERT INTO links VALUES(?1,'main','a','certified',0,'wikilink')",
            [ws],
        )
        .unwrap();
        c.execute(
            "INSERT INTO link_occurrence_keys VALUES(?1,'main','a','certified',0,'stem',?2)",
            params![ws, literal],
        )
        .unwrap();
        c.execute(
            "INSERT INTO link_index_state VALUES(?1,'main','ready',?2)",
            params![ws, PARSER_GENERATION],
        )
        .unwrap();
    }
    // A second target alias makes only the foreign resolver ambiguous.
    c.execute(
        "INSERT INTO path_aliases VALUES('other','main','t','elsewhere/target.md')",
        [],
    )
    .unwrap();
    let main = Resolver::new(Resolver::paths_for_version(&c, "ws", "main").unwrap());
    let other = Resolver::new(Resolver::paths_for_version(&c, "other", "main").unwrap());
    assert_eq!(main.resolve("notes/source.md", "target"), Some("target.md"));
    assert_eq!(other.resolve("notes/source.md", "target"), None);
    assert_eq!(
        incoming::candidates(&c, "ws", "main", "target.md", &["wikilink"])
            .unwrap()
            .sources,
        vec![("a".into(), "source.md".into())]
    );
    assert!(
        incoming::candidates(&c, "other", "main", "target.md", &["wikilink"])
            .unwrap()
            .sources
            .is_empty()
    );
    assert_eq!(
        incoming::candidates(&c, "other", "main", "foreign.md", &["wikilink"])
            .unwrap()
            .sources,
        vec![("a".into(), "source.md".into())]
    );
    assert!(
        incoming::candidates(&c, "ws", "main", "foreign.md", &["wikilink"])
            .unwrap()
            .sources
            .is_empty()
    );
    // Changes to the foreign source cannot replace main's certification.
    c.execute(
        "UPDATE link_sources SET status='unindexed' WHERE workspace_id='other'",
        [],
    )
    .unwrap();
    assert_eq!(
        incoming::candidates(&c, "ws", "main", "target.md", &["wikilink"])
            .unwrap()
            .sources
            .len(),
        1
    );
    let other = incoming::candidates(&c, "other", "main", "target.md", &["wikilink"]).unwrap();
    assert!(other.sources.is_empty());
    assert_eq!(other.unchecked, vec!["source.md"]);
}

#[test]
fn incoming_pending_candidates_do_not_rescan_the_workspace_per_source() {
    use std::sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    };

    let scratch = ScratchDir::new().unwrap();
    let mut s = open(&engine_db_path(&scratch).unwrap());
    write(&mut s, "target", "target.md", "", 1);
    drain(&mut s);
    const SOURCES: u64 = 1024;
    s.write_with(&NoFaults, |tx| {
        for n in 0..SOURCES {
            let object = format!("pending-{n:04}");
            tx.execute(
                "INSERT INTO file_objects(workspace_id,object_id,created_at_ms) VALUES('ws',?1,1)",
                [&object],
            ).map_err(sql)?;
            tx.execute(
                "INSERT INTO path_aliases(workspace_id,version_id,object_id,path) VALUES('ws','main',?1,?2)",
                params![object, format!("pending-{n:04}.md")],
            ).map_err(sql)?;
        }
        Ok::<_, StorageError>(())
    }).unwrap();
    assert_eq!(count(&s, "link_pending"), SOURCES as i64);
    let work = Arc::new(AtomicU64::new(0));
    s.count_work(Some(Arc::downgrade(&work))).unwrap();
    let result = lookup(&s, "target.md");
    s.count_work(None).unwrap();
    assert!(result.unchecked.is_empty());
    let expected: Vec<_> = (0..SOURCES)
        .map(|n| (format!("pending-{n:04}"), format!("pending-{n:04}.md")))
        .collect();
    assert_eq!(result.sources, expected);
    let steps = work.load(Ordering::Relaxed) * 1000;
    assert!(
        steps < SOURCES * 256,
        "incoming candidates used {steps} SQLite VM steps for {SOURCES} pending sources"
    );
}

#[test]
fn incoming_indexed_probes_do_not_scan_unrelated_occurrence_keys() {
    use std::sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    };

    let scratch = ScratchDir::new().unwrap();
    let mut s = open(&engine_db_path(&scratch).unwrap());
    write(&mut s, "match", "match.md", "[[target]] [[target#part]]", 1);
    write(&mut s, "markdown", "markdown.md", "[target](target.md)", 2);
    drain(&mut s);
    const SOURCES: i64 = 1024;
    const LINKS: i64 = 20;
    // Populate only the derived read model after creating authoritative aliases.
    s.write_with(&NoFaults, |tx| {
        for n in 0..SOURCES {
            let object = format!("indexed-{n:04}");
            let path = format!("indexed-{n:04}.md");
            tx.execute(
                "INSERT INTO file_objects(workspace_id,object_id,created_at_ms) VALUES('ws',?1,1)",
                [&object],
            ).map_err(sql)?;
            tx.execute(
                "INSERT INTO path_aliases(workspace_id,version_id,object_id,path) VALUES('ws','main',?1,?2)",
                params![object, path],
            ).map_err(sql)?;
            tx.execute(
                "INSERT INTO link_sources(workspace_id,version_id,object_id,source_hash,path,title,parser_generation,status,index_key)
                 VALUES('ws','main',?1,'fixture',?2,'',?3,'indexed','fixture')",
                params![object, path, PARSER_GENERATION],
            ).map_err(sql)?;
        }
        tx.execute(
            "WITH RECURSIVE ordinals(n) AS (VALUES(0) UNION ALL SELECT n+1 FROM ordinals WHERE n+1<?1)
             INSERT INTO links(workspace_id,version_id,object_id,index_key,ordinal,literal,kind,start_utf16,end_utf16,line,snippet)
             SELECT workspace_id,version_id,object_id,index_key,n,'elsewhere','wikilink',n*14,n*14+13,n+1,'[[elsewhere]]'
             FROM link_sources CROSS JOIN ordinals WHERE index_key='fixture'",
            [LINKS],
        ).map_err(sql)?;
        for (kind, key) in occurrence_keys("indexed.md", "elsewhere", "wikilink") {
            tx.execute(
                "INSERT INTO link_occurrence_keys(workspace_id,version_id,object_id,index_key,ordinal,key_kind,key)
                 SELECT workspace_id,version_id,object_id,index_key,ordinal,?1,?2 FROM links WHERE index_key='fixture'",
                params![kind, key],
            ).map_err(sql)?;
        }
        tx.execute("DELETE FROM link_pending WHERE object_id LIKE 'indexed-%'", []).map_err(sql)?;
        Ok::<_, StorageError>(())
    }).unwrap();
    assert_eq!(count(&s, "link_pending"), 0);
    assert_eq!(count(&s, "links"), SOURCES * LINKS + 3);
    assert!(count(&s, "link_occurrence_keys") >= SOURCES * LINKS * 3);
    let work = Arc::new(AtomicU64::new(0));
    s.count_work(Some(Arc::downgrade(&work))).unwrap();
    let result = lookup(&s, "target.md");
    s.count_work(None).unwrap();
    assert_eq!(
        result,
        incoming::Candidates {
            sources: vec![("match".into(), "match.md".into())],
            unchecked: vec![],
        }
    );
    let steps = work.load(Ordering::Relaxed) * 1000;
    assert!(
        steps < SOURCES as u64 * 64,
        "incoming candidates used {steps} SQLite VM steps for {SOURCES} indexed sources with {LINKS} unrelated links each"
    );
    s.read_with(|c| {
        let keys = serde_json::to_string(&path_keys("target.md")).unwrap();
        let mut stmt = c.prepare(&format!("EXPLAIN QUERY PLAN {}", incoming::CANDIDATES_SQL)).map_err(sql)?;
        let plan = stmt.query_map(params!["ws", "main", keys, PARSER_GENERATION, "[\"wikilink\"]"], |r| r.get::<_, String>(3))
            .map_err(sql)?.collect::<Result<Vec<_>, _>>().map_err(sql)?;
        assert!(plan.iter().any(|row| row.contains("SEARCH k USING INDEX link_occurrence_probe (workspace_id=? AND version_id=? AND key_kind=? AND key=?)")), "{plan:#?}");
        Ok::<_, StorageError>(())
    }).unwrap();
}
