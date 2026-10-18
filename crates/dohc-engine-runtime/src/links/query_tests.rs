use super::*;
use crate::{ActorHandle, CancellationToken, WorkspaceSupervisor};
use dohc_engine_domain::FileResolveTarget;
use serde_json::{Value, json};

async fn page(actor: &ActorHandle, path: &str, cursor: Option<String>) -> Value {
    actor
        .incoming_links(
            "ws".into(),
            FileResolveTarget::Path(path.into()),
            cursor,
            CancellationToken::new(),
        )
        .await
        .unwrap()
}

async fn invalid_cursor(actor: &ActorHandle, ws: &str, path: &str, cursor: String) {
    assert!(
        actor
            .incoming_links(
                ws.into(),
                FileResolveTarget::Path(path.into()),
                Some(cursor),
                CancellationToken::new(),
            )
            .await
            .is_err()
    );
}

#[tokio::test]
async fn incoming_pages_share_resolution_and_survive_settles_without_writing() {
    let scratch = ScratchDir::new().unwrap();
    let db = engine_db_path(&scratch).unwrap();
    let mut store = open(&db);
    write(&mut store, "target", "target.md", "# Target", 1);
    write(&mut store, "other", "near/target.md", "# Near", 2);
    write(&mut store, "false", "near/source.md", "[[target]]", 3);
    write(&mut store, "many", "many.md", &"[[target]] ".repeat(110), 4);
    write(
        &mut store,
        "markdown",
        "doc.md",
        "[go](target.md) [[#local]]",
        5,
    );
    drain(&mut store);
    drop(store);
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 1).unwrap().actor;
    let _hold = actor.hold_link_drain();
    let first = page(&actor, "target.md", None).await;
    assert_eq!(first["entries"].as_array().unwrap().len(), 100);
    assert!(first.to_string().len() <= 64 * 1024);
    assert_eq!(first["complete"], true);
    assert_eq!(first["entries"][0]["source"], "doc.md");
    assert!(
        !first["entries"]
            .as_array()
            .unwrap()
            .iter()
            .any(|row| row["source"] == "near/source.md")
    );
    let cursor = first["nextCursor"].as_str().unwrap().to_owned();
    assert!(!cursor.contains("many.md"));
    actor
        .run(|store, _| {
            write(store, "last", "z.md", "[[target]]", 6);
            Ok(())
        })
        .await
        .unwrap();
    let next = page(&actor, "target.md", Some(cursor.clone())).await;
    assert_eq!(next["entries"].as_array().unwrap().len(), 12);
    assert_eq!(next["complete"], false);
    assert_eq!(next["nextCursor"], Value::Null);
    assert_eq!(
        actor
            .run(|store, _| Ok(count(store, "link_pending")))
            .await
            .unwrap(),
        1
    );
    let resolved = actor
        .resolve_links(
            "ws".into(),
            "doc.md".into(),
            vec![
                ("markdown".into(), "target.md".into()),
                ("wikilink".into(), "target".into()),
                ("wikilink".into(), "#local".into()),
            ],
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(
        resolved["results"],
        json!([{"path":"target.md","fragment":null},{"path":"target.md","fragment":null},{"path":"doc.md","fragment":"local"}])
    );
    invalid_cursor(&actor, "ws", "near/target.md", cursor.clone()).await;
    invalid_cursor(&actor, "ws", "target.md", format!("{cursor}x")).await;
    assert_eq!(page(&actor, "missing.md", None).await, Value::Null);
    actor
        .run(|store, _| {
            drain(store);
            Ok(())
        })
        .await
        .unwrap();
    let fresh = page(&actor, "target.md", None).await;
    assert_eq!(fresh["complete"], true);
    assert_eq!(fresh["indexBuilding"], false);
}

#[tokio::test]
async fn incoming_reports_unchecked_bounds_sources_and_rejects_version_cursors() {
    let scratch = ScratchDir::new().unwrap();
    let db = engine_db_path(&scratch).unwrap();
    let mut store = open(&db);
    write(&mut store, "target", "target.md", "", 1);
    for i in 0..120 {
        write(
            &mut store,
            &format!("s-{i}"),
            &format!("s-{i:02}.md"),
            "[[target]]",
            i + 2,
        );
    }
    write(
        &mut store,
        "huge",
        "a.md",
        &"x".repeat(parser::MAX_DOCUMENT_BYTES + 1),
        30,
    );
    drain(&mut store);
    drop(store);
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 1).unwrap().actor;
    let _hold = actor.hold_link_drain();
    let first = page(&actor, "target.md", None).await;
    assert_eq!(first["unchecked"], json!(["a.md"]));
    assert_eq!(first["entries"].as_array().unwrap().len(), 99);
    assert_eq!(first["complete"], false);
    let mut cursor = first["nextCursor"].as_str().map(str::to_owned);
    let mut total = first["entries"].as_array().unwrap().len();
    while let Some(next) = cursor {
        let result = page(&actor, "target.md", Some(next)).await;
        total += result["entries"].as_array().unwrap().len();
        cursor = result["nextCursor"].as_str().map(str::to_owned);
    }
    assert_eq!(total, 120);
    actor
        .run(|store, _| {
            VersionedTextStore::new(store).create_named_version(
                &CreateNamedVersion {
                    workspace_id: "ws".into(),
                    new_version_id: "fork".into(),
                    from_version_id: "main".into(),
                    name: "Fork".into(),
                    now_ms: 40,
                    request_id: None,
                },
                &NoFaults,
            )?;
            Ok(())
        })
        .await
        .unwrap();
    // Cursor decryption binds the active version even when all paths are identical.
    actor
        .run(|store, _| {
            store.write_with(&NoFaults, |tx| {
                tx.execute(
                    "INSERT INTO active_versions(workspace_id,version_id) VALUES('ws','fork') ON CONFLICT(workspace_id) DO UPDATE SET version_id='fork'",
                    [],
                )
                .map_err(sql)?;
                Ok::<_, StorageError>(())
            })?;
            Ok(())
        })
        .await
        .unwrap();
    invalid_cursor(
        &actor,
        "ws",
        "target.md",
        first["nextCursor"].as_str().unwrap().to_owned(),
    )
    .await;
}

#[tokio::test]
async fn link_queries_on_read_only_handles_do_not_publish_or_drain() {
    let scratch = ScratchDir::new().unwrap();
    let db = engine_db_path(&scratch).unwrap();
    let mut store = open(&db);
    write(&mut store, "target", "target.md", "", 1);
    write(&mut store, "source", "source.md", "[[target]]", 2);
    let pending = count(&store, "link_pending");
    drop(store);
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open_read_only(&db).unwrap().actor;
    let result = page(&actor, "target.md", None).await;
    assert_eq!(result["entries"][0]["source"], "source.md");
    assert_eq!(result["complete"], false);
    assert_eq!(
        actor
            .run(move |store, _| Ok(count(store, "link_pending")))
            .await
            .unwrap(),
        pending
    );
    let resolved = actor
        .resolve_links(
            "ws".into(),
            "source.md".into(),
            vec![("wikilink".into(), "target".into())],
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(resolved["results"][0]["path"], "target.md");
    assert_eq!(actor.link_drain_metrics().actor_batches, 0);
}

#[test]
fn sparse_five_thousand_file_query_stage_profile() {
    let scratch = ScratchDir::new().unwrap();
    let db = engine_db_path(&scratch).unwrap();
    let mut store = open(&db);
    write(&mut store, "target", "target.md", "# Target", 1);
    write(
        &mut store,
        "source",
        "note-00001.md",
        "# Source\n\n[[target]]",
        2,
    );
    store
        .read_with(|c| {
            let tx = c.unchecked_transaction().unwrap();
            for n in 2..5000 {
                let id = format!("n{n}");
                tx.execute("INSERT INTO file_objects VALUES('ws',?1,1)", [&id])
                    .unwrap();
                tx.execute(
                    "INSERT INTO path_aliases VALUES('ws','main',?1,?2)",
                    params![format!("note-{n:05}.md"), id],
                )
                .unwrap();
                tx.execute("INSERT INTO snapshots(workspace_id,version_id,object_id,path,blob_sha256,updated_at_ms,latest_moment_id,metadata_origin) SELECT workspace_id,version_id,?1,?2,blob_sha256,updated_at_ms,latest_moment_id,metadata_origin FROM snapshots WHERE workspace_id='ws' AND version_id='main' AND object_id='target'", params![id, format!("note-{n:05}.md")]).unwrap();
            }
            tx.commit().unwrap();
            Ok::<_, rusqlite::Error>(())
        })
        .unwrap();
    drain(&mut store);
    let cache = std::sync::Arc::default();
    let mut rows = Vec::new();
    for _ in 0..100 {
        let start = Instant::now();
        let paths = store
            .read_with(|c| super::super::resolver::Resolver::paths_for_version(c, "ws", "main"))
            .unwrap();
        let aliases = start.elapsed().as_secs_f64() * 1000.0;
        assert_eq!(paths.len(), 5000);
        let start = Instant::now();
        let resolver = super::super::resolver::Resolver::new(paths);
        let maps = start.elapsed().as_secs_f64() * 1000.0;
        let start = Instant::now();
        let candidates = store
            .read_with(|c| {
                incoming::candidates(c, "ws", "main", "target.md", &["wikilink", "markdown"])
            })
            .unwrap();
        let query = start.elapsed().as_secs_f64() * 1000.0;
        assert_eq!(candidates.sources.len(), 1);
        let start = Instant::now();
        let source = store
            .read_with(|c| incoming::read_source(c, "ws", "main", "source"))
            .unwrap()
            .unwrap();
        let hydrate = start.elapsed().as_secs_f64() * 1000.0;
        let start = Instant::now();
        let parsed = source.parse().unwrap();
        assert_eq!(
            resolver.resolve("note-00001.md", &parsed.occurrences[0].literal),
            Some("target.md")
        );
        let snippets = start.elapsed().as_secs_f64() * 1000.0;
        let start = Instant::now();
        let prepared = store
            .read_with(|c| super::super::cache::prepare(c, &cache, "ws", "main"))
            .unwrap();
        prepared.build();
        rows.push(json!({"aliases":aliases,"maps":maps,"candidates":query,"hydrate":hydrate,"snippets":snippets,"cachedResolver":start.elapsed().as_secs_f64()*1000.0}));
    }
    if let Some(path) = std::env::var_os("DOHC_LINK_STAGE_PROFILE") {
        std::fs::write(path, json!({"method":"Debug Rust test, 5000 authoritative aliases, one linked source, 4998 small snapshots sharing the target blob. Stage timings are diagnostic, not additive IPC samples.","rows":rows}).to_string()).unwrap();
    }
}

#[tokio::test]
async fn incoming_and_resolve_share_alias_invalidation_and_close_releases_maps() {
    let scratch = ScratchDir::new().unwrap();
    let db = engine_db_path(&scratch).unwrap();
    let mut store = open(&db);
    write(&mut store, "target", "target.md", "", 1);
    write(&mut store, "source", "source.md", "[[target]]", 2);
    drain(&mut store);
    drop(store);
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 1).unwrap().actor;
    assert_eq!(
        page(&actor, "target.md", None).await["entries"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    actor
        .run(|store, _| {
            VersionedTextStore::new(store).rename_text_file(
                &dohc_engine_domain::RenameTextFile {
                    workspace_id: "ws".into(),
                    version_id: "main".into(),
                    from_path: "target.md".into(),
                    to_path: "renamed.md".into(),
                    moment_id: "rename-target".into(),
                    request_id: None,
                    metadata_origin: "test".into(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: None,
                    now_ms: 3,
                },
                &NoFaults,
            )?;
            Ok(())
        })
        .await
        .unwrap();
    let resolved = actor
        .resolve_links(
            "ws".into(),
            "source.md".into(),
            vec![
                ("wikilink".into(), "target".into()),
                ("wikilink".into(), "renamed".into()),
            ],
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(
        resolved["results"][0],
        json!({"path":null,"create":"target.md","fragment":null})
    );
    assert_eq!(resolved["results"][1]["path"], "renamed.md");
    assert!(
        page(&actor, "renamed.md", None).await["entries"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    supervisor.close(&db).unwrap();
    assert_eq!(std::sync::Arc::strong_count(&actor.link_resolvers), 1);
}

#[tokio::test]
async fn secret_floor_writes_never_become_incoming_sources() {
    let scratch = ScratchDir::new().unwrap();
    let db = engine_db_path(&scratch).unwrap();
    let mut store = open(&db);
    write(&mut store, "target", "target.md", "", 1);
    write(&mut store, "public", "public.md", "[[target]]", 2);
    let input = WriteText {
        workspace_id: "ws".into(),
        version_id: "main".into(),
        object_id: "secret".into(),
        path: "secrets/.env.local".into(),
        text: "TOKEN=private [[target]]".into(),
        moment_id: "secret-write".into(),
        metadata_origin: "test".into(),
        metadata_summary: None,
        metadata_correlation_id: None,
        author_json: None,
        now_ms: 3,
        request_id: None,
    };
    assert!(
        VersionedTextStore::new(&mut store)
            .write_text(&input, &NoFaults)
            .is_err()
    );
    drain(&mut store);
    drop(store);
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 1).unwrap().actor;
    let result = page(&actor, "target.md", None).await;
    assert_eq!(result["entries"].as_array().unwrap().len(), 1);
    assert_eq!(result["entries"][0]["source"], "public.md");
    assert!(!result.to_string().contains("private"));
    assert!(!result.to_string().contains(".env"));
    assert_eq!(result["unchecked"], json!([]));
}

#[tokio::test]
async fn resolve_uses_uncaptured_source_paths_and_returns_creation_paths() {
    let scratch = ScratchDir::new().unwrap();
    let db = engine_db_path(&scratch).unwrap();
    let mut store = open(&db);
    write(&mut store, "target", "target.md", "", 1);
    write(&mut store, "one", "a/ambiguous.md", "", 2);
    write(&mut store, "two", "b/ambiguous.md", "", 3);
    drop(store);
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 1).unwrap().actor;
    let cases = [
        (
            "wikilink",
            "folder/new",
            json!({"path":null,"create":"folder/new.md","fragment":null}),
        ),
        (
            "wikilink",
            "target",
            json!({"path":"target.md","fragment":null}),
        ),
        (
            "wikilink",
            "missing",
            json!({"path":null,"create":"notes/missing.md","fragment":null}),
        ),
        (
            "wikilink",
            "ambiguous",
            json!({"path":null,"create":"notes/ambiguous.md","fragment":null}),
        ),
        (
            "markdown",
            "./guide",
            json!({"path":null,"create":"notes/guide.md","fragment":null}),
        ),
        (
            "markdown",
            "./GUIDE.MARKDOWN",
            json!({"path":null,"create":"notes/GUIDE.MARKDOWN","fragment":null}),
        ),
        (
            "markdown",
            "./new%23release%231.md#decisions",
            json!({"path":null,"create":"notes/new#release#1.md","fragment":"decisions"}),
        ),
        (
            "markdown",
            "../new%20file.md",
            json!({"path":null,"create":"new file.md","fragment":null}),
        ),
        (
            "wikilink",
            "#local",
            json!({"path":"notes/uncaptured.md","fragment":"local"}),
        ),
        ("markdown", "https://example.com", Value::Null),
        ("markdown", "../../escape.md", Value::Null),
    ];
    for (kind, literal, expected) in cases {
        let result = actor
            .resolve_links(
                "ws".into(),
                "notes/uncaptured.md".into(),
                vec![(kind.into(), literal.into())],
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(result["results"][0], expected, "{kind} {literal}");
    }
}

#[tokio::test]
async fn incoming_excludes_the_subject_object() {
    let scratch = ScratchDir::new().unwrap();
    let db = engine_db_path(&scratch).unwrap();
    let mut store = open(&db);
    write(
        &mut store,
        "target",
        "target.md",
        "[[target]] [self](target.md)",
        1,
    );
    write(&mut store, "other", "other.md", "[[target]]", 2);
    drain(&mut store);
    drop(store);
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 1).unwrap().actor;
    let result = page(&actor, "target.md", None).await;
    assert_eq!(result["entries"].as_array().unwrap().len(), 1);
    assert_eq!(result["entries"][0]["source"], "other.md");
}

#[tokio::test]
async fn incoming_windows_snippets_around_each_link() {
    let scratch = ScratchDir::new().unwrap();
    let db = engine_db_path(&scratch).unwrap();
    let mut store = open(&db);
    write(&mut store, "target", "target.md", "", 1);
    let text = format!(
        "  short [[target]]\n  {} [[target]] {}",
        "😀".repeat(200),
        "x".repeat(200)
    );
    write(&mut store, "source", "source.md", &text, 2);
    drain(&mut store);
    drop(store);
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 1).unwrap().actor;
    let result = page(&actor, "target.md", None).await;
    let entries = result["entries"].as_array().unwrap();
    assert_eq!(entries.len(), 2);
    assert_eq!(entries[0]["snippet"], "short [[target]]");
    let snippet = entries[1]["snippet"].as_str().unwrap();
    assert!(snippet.starts_with('…') && snippet.ends_with('…'));
    assert!(snippet.chars().count() <= 162);
    for row in entries {
        let units: Vec<u16> = row["snippet"].as_str().unwrap().encode_utf16().collect();
        let start = row["highlightStart"].as_u64().unwrap() as usize;
        let end = row["highlightEnd"].as_u64().unwrap() as usize;
        assert_eq!(String::from_utf16(&units[start..end]).unwrap(), "[[target]]");
    }
}

#[tokio::test]
async fn cursor_keeps_incompleteness_when_the_index_catches_up() {
    let scratch = ScratchDir::new().unwrap();
    let db = engine_db_path(&scratch).unwrap();
    let mut store = open(&db);
    write(&mut store, "target", "target.md", "", 1);
    write(&mut store, "many", "many.md", &"[[target]] ".repeat(110), 2);
    drop(store);
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 1).unwrap().actor;
    let _hold = actor.hold_link_drain();
    let first = page(&actor, "target.md", None).await;
    assert_eq!(first["complete"], false);
    assert_eq!(first["indexBuilding"], true);
    actor
        .run(|store, _| {
            drain(store);
            Ok(())
        })
        .await
        .unwrap();
    let next = page(
        &actor,
        "target.md",
        first["nextCursor"].as_str().map(str::to_owned),
    )
    .await;
    assert_eq!(next["complete"], false);
    assert_eq!(next["indexBuilding"], true);
    assert_eq!(next["entries"].as_array().unwrap().len(), 10);
    assert_eq!(page(&actor, "target.md", None).await["complete"], true);
}

#[tokio::test]
async fn pages_bound_bytes_and_do_not_repeat_unchecked_sources() {
    let scratch = ScratchDir::new().unwrap();
    let db = engine_db_path(&scratch).unwrap();
    let mut store = open(&db);
    write(&mut store, "target", "target.md", "", 1);
    write(
        &mut store,
        "large",
        "a.md",
        &"x".repeat(parser::MAX_DOCUMENT_BYTES + 1),
        2,
    );
    let text = format!(
        "# {}\n{} [[target]] {}",
        "😀".repeat(160),
        "😀".repeat(200),
        "😀".repeat(200)
    );
    for i in 0..120 {
        write(
            &mut store,
            &format!("s{i}"),
            &format!("s{i:03}.md"),
            &text,
            i + 3,
        );
    }
    drain(&mut store);
    drop(store);
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 1).unwrap().actor;
    let mut cursor = None;
    let mut entries = std::collections::HashSet::new();
    let mut unchecked = Vec::new();
    let mut pages = 0;
    loop {
        let result = page(&actor, "target.md", cursor).await;
        pages += 1;
        assert!(pages < 10);
        assert!(result.to_string().len() <= 64 * 1024);
        assert_eq!(result["complete"], false);
        assert_eq!(result["indexBuilding"], false);
        for row in result["entries"].as_array().unwrap() {
            assert!(entries.insert(row["source"].as_str().unwrap().to_owned()));
        }
        unchecked.extend(result["unchecked"].as_array().unwrap().iter().cloned());
        cursor = result["nextCursor"].as_str().map(str::to_owned);
        if cursor.is_none() {
            break;
        }
    }
    assert!(pages > 1);
    assert_eq!(entries.len(), 120);
    assert_eq!(unchecked, vec![json!("a.md")]);
}

#[tokio::test]
async fn index_building_reports_missing_rows_even_after_seed_is_ready() {
    let scratch = ScratchDir::new().unwrap();
    let db = engine_db_path(&scratch).unwrap();
    let mut store = open(&db);
    write(&mut store, "target", "target.md", "", 1);
    write(&mut store, "source", "source.md", "[[target]]", 2);
    drain(&mut store);
    store
        .write_with(&NoFaults, |tx| {
            tx.execute("DELETE FROM link_sources WHERE object_id='source'", [])
                .map_err(sql)?;
            Ok::<_, StorageError>(())
        })
        .unwrap();
    drop(store);
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 1).unwrap().actor;
    let _hold = actor.hold_link_drain();
    let result = page(&actor, "target.md", None).await;
    assert_eq!(result["complete"], false);
    assert_eq!(result["indexBuilding"], true);
    actor
        .run(|store, _| {
            write(store, "source", "source.md", "[[target]] again", 3);
            drain(store);
            Ok(())
        })
        .await
        .unwrap();
    let result = page(&actor, "target.md", None).await;
    assert_eq!(result["indexBuilding"], false);
    assert_eq!(result["complete"], true);
}
