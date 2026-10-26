use super::*;
use crate::{CancellationToken, WorkspaceSupervisor};
use serde_json::{Value, json};

async fn edges(actor: &crate::ActorHandle, cursor: Option<String>) -> Value {
    actor
        .link_edges("ws".into(), cursor, CancellationToken::new())
        .await
        .unwrap()
}
fn bounded(page: &Value) {
    let records: usize = ["files", "entries", "unchecked"]
        .iter()
        .map(|name| page[name].as_array().unwrap().len())
        .sum();
    assert!(records <= 100, "{records}");
    assert!(page.to_string().len() <= 64 * 1024);
}

#[tokio::test]
async fn edge_walk_preserves_isolated_files_occurrences_and_targets_beyond_scan_limit() {
    let scratch = ScratchDir::new().unwrap();
    let db = engine_db_path(&scratch).unwrap();
    let mut store = open(&db);
    for i in 0..2005 {
        write(
            &mut store,
            &format!("o{i}"),
            &format!("n{i:04}.md"),
            if i == 2004 {
                "[go](n0000.md) [[n0000]] [[n0000]]"
            } else {
                "# Isolated"
            },
            i + 1,
        );
    }
    drain(&mut store);
    drop(store);
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 1).unwrap().actor;
    let _hold = actor.hold_link_drain();
    let before = actor
        .run(|s, _| Ok(s.read_with(|c| Ok::<_, StorageError>(c.total_changes()))?))
        .await
        .unwrap();
    let mut cursor = None;
    let mut files = std::collections::HashSet::new();
    let mut rows = Vec::new();
    let mut pages = 0;
    loop {
        let page = edges(&actor, cursor).await;
        bounded(&page);
        assert_eq!(page["complete"], true);
        for file in page["files"].as_array().unwrap() {
            assert!(files.insert(file["path"].as_str().unwrap().to_owned()));
        }
        rows.extend(page["entries"].as_array().unwrap().iter().cloned());
        cursor = page["nextCursor"].as_str().map(str::to_owned);
        pages += 1;
        assert!(pages < 30);
        if cursor.is_none() {
            break;
        }
    }
    assert_eq!(files.len(), 2005);
    assert_eq!(rows.len(), 3);
    assert!(
        rows.iter()
            .all(|r| r["source"] == "n2004.md" && r["target"] == "n0000.md")
    );
    assert_eq!(
        rows.iter()
            .map(|r| r["ordinal"].as_i64().unwrap())
            .collect::<Vec<_>>(),
        vec![0, 1, 2]
    );
    assert_eq!(
        actor
            .run(|s, _| Ok(s.read_with(|c| Ok::<_, StorageError>(c.total_changes()))?))
            .await
            .unwrap(),
        before
    );
}

#[tokio::test]
async fn edges_never_parse_pending_heads_and_refresh_only_after_certification() {
    let scratch = ScratchDir::new().unwrap();
    let db = engine_db_path(&scratch).unwrap();
    let mut store = open(&db);
    write(&mut store, "target", "target.md", "", 1);
    write(&mut store, "source", "a.md", "[[target]]", 2);
    drain(&mut store);
    write(&mut store, "source", "a.md", "[[target]] changed", 3);
    // Even before seed/certification, authoritative aliases must appear.
    write_deferred(&mut store, "new", "new.md", "[[target]]", 4);
    drop(store);
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 1).unwrap().actor;
    let _hold = actor.hold_link_drain();
    let pending = actor
        .run(|s, _| Ok(count(s, "link_pending")))
        .await
        .unwrap();
    let page = edges(&actor, None).await;
    bounded(&page);
    assert_eq!(page["entries"], json!([]));
    assert_eq!(page["unchecked"], json!(["a.md", "new.md"]));
    assert_eq!(page["complete"], false);
    assert_eq!(page["indexBuilding"], true);
    assert_eq!(
        actor
            .run(|s, _| Ok(count(s, "link_pending")))
            .await
            .unwrap(),
        pending
    );
    actor
        .run(|s, _| {
            drain(s);
            Ok(())
        })
        .await
        .unwrap();
    let fresh = edges(&actor, None).await;
    assert_eq!(fresh["entries"].as_array().unwrap().len(), 2);
    assert_eq!(fresh["complete"], true);
    assert_eq!(fresh["indexBuilding"], false);
}

#[tokio::test]
async fn occurrence_work_and_bytes_are_bounded_and_partial_source_changes_reject_the_cursor() {
    let scratch = ScratchDir::new().unwrap();
    let db = engine_db_path(&scratch).unwrap();
    let mut store = open(&db);
    write(
        &mut store,
        "source",
        "a.md",
        &format!("{} [[target]]", "[[absent]] ".repeat(600)),
        1,
    );
    write(&mut store, "target", "target.md", "", 2);
    drain(&mut store);
    drop(store);
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 1).unwrap().actor;
    let _hold = actor.hold_link_drain();
    let first = edges(&actor, None).await;
    bounded(&first);
    assert_eq!(first["entries"], json!([]));
    assert_eq!(first["files"].as_array().unwrap().len(), 1);
    let cursor = first["nextCursor"].as_str().unwrap().to_owned();
    let next = edges(&actor, Some(cursor.clone())).await;
    bounded(&next);
    assert_eq!(next["entries"][0]["ordinal"], 600);
    assert!(
        !next["files"]
            .as_array()
            .unwrap()
            .iter()
            .any(|f| f["path"] == "a.md")
    );
    assert!(
        actor
            .link_edges(
                "other".into(),
                Some(cursor.clone()),
                CancellationToken::new()
            )
            .await
            .is_err()
    );
    let mut tampered = cursor.clone().into_bytes();
    tampered[10] = if tampered[10] == b'A' { b'B' } else { b'A' };
    assert!(
        actor
            .link_edges(
                "ws".into(),
                Some(String::from_utf8(tampered).unwrap()),
                CancellationToken::new()
            )
            .await
            .is_err()
    );
    actor
        .run(|s, _| {
            write(s, "source", "a.md", "[[target]]", 3);
            Ok(())
        })
        .await
        .unwrap();
    assert!(matches!(
        actor
            .link_edges("ws".into(), Some(cursor), CancellationToken::new())
            .await,
        Err(crate::RuntimeError::LinksEdgesSourceChanged)
    ));
}

#[tokio::test]
async fn terminal_unchecked_is_sticky_and_escaped_metadata_stays_within_the_envelope() {
    let scratch = ScratchDir::new().unwrap();
    let db = engine_db_path(&scratch).unwrap();
    let mut store = open(&db);
    for i in 0..125 {
        let title = format!("# {}", "😀\\\"".repeat(80));
        write(
            &mut store,
            &format!("o{i}"),
            &format!("a{i:03}.md"),
            &title,
            i + 1,
        );
    }
    drain(&mut store);
    store.write_with(&NoFaults, |tx| {
        tx.execute("UPDATE link_sources SET status='unindexed',reason='parse-refused' WHERE object_id='o0'",[]).map_err(sql)?;
        Ok::<_,StorageError>(())
    }).unwrap();
    drop(store);
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 1).unwrap().actor;
    let _hold = actor.hold_link_drain();
    let mut cursor = None;
    let mut files = 0;
    loop {
        let page = edges(&actor, cursor).await;
        bounded(&page);
        assert_eq!(page["complete"], false);
        assert_eq!(page["indexBuilding"], false);
        files += page["files"].as_array().unwrap().len();
        cursor = page["nextCursor"].as_str().map(str::to_owned);
        if cursor.is_none() {
            break;
        }
    }
    assert_eq!(files, 125);
}

#[tokio::test]
async fn edges_resume_a_source_after_the_shared_record_budget_without_repeating_its_file() {
    let scratch = ScratchDir::new().unwrap();
    let db = engine_db_path(&scratch).unwrap();
    let mut store = open(&db);
    write(&mut store, "a", "a.md", &"[[target]] ".repeat(150), 1);
    write(&mut store, "target", "target.md", "", 2);
    drain(&mut store);
    drop(store);
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 1).unwrap().actor;
    let _hold = actor.hold_link_drain();
    let first = edges(&actor, None).await;
    bounded(&first);
    assert_eq!(first["files"].as_array().unwrap().len(), 1);
    assert_eq!(first["entries"].as_array().unwrap().len(), 99);
    let cursor = first["nextCursor"].as_str().unwrap().to_owned();
    let last = edges(&actor, Some(cursor)).await;
    bounded(&last);
    assert_eq!(last["entries"][0]["ordinal"], 99);
    assert_eq!(last["entries"].as_array().unwrap().len(), 51);
    assert_eq!(
        last["files"],
        json!([{"objectId":"target","path":"target.md","title":"target.md"}])
    );
    assert_eq!(last["nextCursor"], Value::Null);
    assert!(
        actor
            .link_edges(
                "ws".into(),
                Some("x".repeat(32769)),
                CancellationToken::new()
            )
            .await
            .is_err()
    );
    let cancelled = CancellationToken::new();
    cancelled.cancel();
    assert!(matches!(
        actor.link_edges("ws".into(), None, cancelled).await,
        Err(crate::RuntimeError::Cancelled)
    ));
}

#[tokio::test]
async fn edges_exclude_self_ambiguous_and_unresolved_literals() {
    let scratch = ScratchDir::new().unwrap();
    let db = engine_db_path(&scratch).unwrap();
    let mut store = open(&db);
    write(
        &mut store,
        "source",
        "source.md",
        "[[source]] [self](source.md) [[shared]] [[absent]] [missing](missing.md) [[target]]",
        1,
    );
    write(&mut store, "a", "a/shared.md", "", 2);
    write(&mut store, "b", "b/shared.md", "", 3);
    write(&mut store, "target", "target.md", "", 4);
    drain(&mut store);
    drop(store);
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 1).unwrap().actor;
    let _hold = actor.hold_link_drain();
    let page = edges(&actor, None).await;
    bounded(&page);
    assert_eq!(
        page["entries"],
        json!([{"source":"source.md","target":"target.md","kind":"wikilink","ordinal":5}])
    );
    assert_eq!(page["nextCursor"], Value::Null);
}
