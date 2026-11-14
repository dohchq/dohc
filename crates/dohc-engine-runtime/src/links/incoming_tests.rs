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
fn source_parsing_checks_blob_integrity() {
    let scratch = ScratchDir::new().unwrap();
    let mut s = open(&engine_db_path(&scratch).unwrap());
    write(&mut s, "a", "a.md", "[[target]]", 1);
    let source = s
        .read_with(|c| incoming::read_source(c, "ws", "main", "a"))
        .unwrap()
        .unwrap();
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
