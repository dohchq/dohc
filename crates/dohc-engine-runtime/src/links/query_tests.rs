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
        json!([{"path":"target.md","fragment":null},{"path":"target.md","fragment":null},null])
    );
    invalid_cursor(&actor, "ws", "near/target.md", cursor.clone()).await;
    invalid_cursor(&actor, "ws", "target.md", format!("{cursor}x")).await;
    assert_eq!(page(&actor, "missing.md", None).await, Value::Null);
    invalid_cursor(&actor, "other", "target.md", cursor).await;
    actor
        .run(|store, _| {
            drain(store);
            Ok(())
        })
        .await
        .unwrap();
    assert_eq!(page(&actor, "target.md", None).await["complete"], true);
}

#[tokio::test]
async fn incoming_reports_unchecked_bounds_sources_and_rejects_version_cursors() {
    let scratch = ScratchDir::new().unwrap();
    let db = engine_db_path(&scratch).unwrap();
    let mut store = open(&db);
    write(&mut store, "target", "target.md", "", 1);
    for i in 0..20 {
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
    assert_eq!(first["complete"], false);
    let mut cursor = first["nextCursor"].as_str().map(str::to_owned);
    let mut total = first["entries"].as_array().unwrap().len();
    while let Some(next) = cursor {
        let result = page(&actor, "target.md", Some(next)).await;
        total += result["entries"].as_array().unwrap().len();
        cursor = result["nextCursor"].as_str().map(str::to_owned);
    }
    assert_eq!(total, 20);
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
    write(&mut store, "source", "note-00001.md", "# Source\n\n[[target]]", 2);
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
        std::fs::write(path, json!({"method":"Debug Rust test, 5000 authoritative aliases, one indexed source; 4998 empty objects, no snapshots. Stage timings are diagnostic, not additive IPC samples.","rows":rows}).to_string()).unwrap();
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
            store
                .read_with(|c| {
                    c.execute(
                        "UPDATE path_aliases SET path='renamed.md' WHERE object_id='target'",
                        [],
                    )
                })
                .unwrap();
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
    assert_eq!(resolved["results"][0], Value::Null);
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
