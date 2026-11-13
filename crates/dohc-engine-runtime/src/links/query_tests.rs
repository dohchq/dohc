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

