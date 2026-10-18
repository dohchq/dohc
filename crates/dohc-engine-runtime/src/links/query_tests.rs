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
