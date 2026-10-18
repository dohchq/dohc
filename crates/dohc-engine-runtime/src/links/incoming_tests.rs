use super::*;
use crate::links::{incoming, resolver::Resolver};

fn lookup(s: &EngineStore, target: &str) -> incoming::Candidates {
    s.read_with(|c| incoming::candidates(c, "ws", "main", target))
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
    while seed_step(&mut s).unwrap() {}
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
        let resolver = Resolver::for_version(c, "ws", "fork")?;
        assert_eq!(resolver.resolve("source.md", "target"), Some("target.md"));
        let foreign = Resolver::for_version(c, "other", "main")?;
        assert_eq!(foreign.resolve("source.md", "target"), None);
        assert_eq!(
            incoming::candidates(c, "ws", "fork", "target.md")?
                .sources
                .len(),
            1
        );
        assert!(
            incoming::candidates(c, "other", "main", "target.md")?
                .sources
                .is_empty()
        );
        assert!(
            incoming::candidates(c, "ws", "other", "target.md")?
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
        .read_with(|c| Resolver::for_version(c, "ws", "main"))
        .unwrap();
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
    write_deferred(&mut s, "a", "a.md", "[[target]]", 1);
    while seed_step(&mut s).unwrap() {}
    while count(&s, "link_pending") > 0 {
        let mut staged = parsed(&s);
        while !staged.step(&mut s, &NoFaults).unwrap() {}
    }
    assert_eq!(count(&s, "link_sources"), 1);
    assert!(
        s.read_with(
            |c| c.query_row("SELECT seed_phase='ready' FROM link_index_state", [], |r| r
                .get::<_, bool>(0))
        )
        .unwrap()
    );
    assert!(reseed_step(&mut s).unwrap());
    assert_eq!(
        count(&s, "link_pending"),
        0,
        "the first seed already certified generation 2 keys"
    );
    assert!(!reseed_step(&mut s).unwrap());
}
