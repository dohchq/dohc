use super::*;
use dohc_engine_storage::{NoFaults, StorageError};
use dohc_engine_testkit::ScratchDir;

fn fixture(count: usize) -> (ScratchDir, EngineStore) {
    let scratch = ScratchDir::new().unwrap();
    let mut store =
        EngineStore::open_passive(&scratch.path().join("replica.db"), 0, None, None).unwrap();
    store.write_with(&NoFaults, |tx| {
        tx.execute_batch("INSERT INTO versioned_workspaces VALUES('ws','main'); INSERT INTO versions(workspace_id,version_id,kind,name,created_at_ms) VALUES('ws','main','main','Main',0);").map_err(StorageError::persist_public)?;
        let sha = hex_sha256(b"");
        tx.execute("INSERT INTO blobs VALUES(?1,0,'')", [&sha]).map_err(StorageError::persist_public)?;
        for i in 0..count {
            let object = format!("o{i:06}"); let path = format!("docs/{i:06}.md");
            tx.execute("INSERT INTO file_objects VALUES('ws',?1,0)", [&object]).map_err(StorageError::persist_public)?;
            tx.execute("INSERT INTO path_aliases VALUES('ws','main',?1,?2)", params![path,object]).map_err(StorageError::persist_public)?;
            tx.execute("INSERT INTO snapshots(workspace_id,version_id,object_id,path,blob_sha256,updated_at_ms,latest_moment_id,metadata_origin) VALUES('ws','main',?1,?2,?3,0,'m','test')",params![object,path,sha]).map_err(StorageError::persist_public)?;
        }
        dohc_engine_storage::replica::advance_frontiers(tx,"ws",1,0)
    }).unwrap();
    (scratch, store)
}
fn request() -> CurrentViewRequest {
    serde_json::from_value(
        serde_json::json!({"selectors":[{"versionId":"main","paths":[]}],"incarnation":"one"}),
    )
    .unwrap()
}
fn position(view: &ReplicaCurrentView) -> CurrentViewPosition {
    CurrentViewPosition {
        revision: view.revision,
        log_cursor: view.log_cursor,
        journal_cursor: view.journal_cursor,
    }
}
fn edit(store: &mut EngineStore, cursor: i64) {
    store
        .write_with(&NoFaults, |tx| {
            let text = cursor.to_string();
            let sha = hex_sha256(text.as_bytes());
            tx.execute(
                "INSERT INTO blobs VALUES(?1,?2,?3)",
                params![sha, text.len() as i64, text],
            )
            .map_err(StorageError::persist_public)?;
            tx.execute(
                "UPDATE snapshots SET blob_sha256=?1 WHERE object_id='o000000'",
                [sha],
            )
            .map_err(StorageError::persist_public)?;
            dohc_engine_storage::replica::advance_frontiers(tx, "ws", cursor, 0)
        })
        .unwrap();
}
fn complete(
    store: &EngineStore,
    request: &mut CurrentViewRequest,
    cache: &mut CurrentViewCache,
) -> ReplicaCurrentView {
    let mut page = collect_current_view_cached(store, "ws", request, cache).unwrap();
    while let Some(cursor) = page.next_cursor.clone() {
        request.position = Some(position(&page));
        request.cursor = Some(cursor);
        let next = collect_current_view_cached(store, "ws", request, cache).unwrap();
        assert!(!next.moved);
        page.files.extend(next.files);
        page.removed.extend(next.removed);
        page.next_cursor = next.next_cursor;
    }
    request.position = None;
    request.cursor = None;
    page
}
#[test]
fn replica_delta_one_edit_in_twenty_thousand_and_all_base_fallbacks() {
    let (_scratch, mut store) = fixture(20_000);
    let mut cache = CurrentViewCache::default();
    let mut request = request();
    let first = complete(&store, &mut request, &mut cache);
    assert_eq!(first.files.len(), 20_000);
    request.since = Some(position(&first));
    edit(&mut store, 2);
    let changed = complete(&store, &mut request, &mut cache);
    assert!(changed.delta);
    assert_eq!(changed.files.len(), 1);
    assert_eq!(changed.files[0].object_id, "o000000");
    assert!(changed.removed.is_empty());
    request.since = Some(position(&first));
    assert_eq!(
        complete(&store, &mut request, &mut cache).files.len(),
        20_000
    );
    request.since = cache.position.clone();
    request.selectors[0].paths = vec!["docs".into()];
    assert!(!complete(&store, &mut request, &mut cache).delta);
    request.since = cache.position.clone();
    request.incarnation = "two".into();
    assert_eq!(
        complete(&store, &mut request, &mut cache).files.len(),
        20_000
    );
    request.since = cache.position.clone();
    let mut empty = CurrentViewCache::default();
    assert!(!complete(&store, &mut request, &mut empty).delta);
}
#[test]
fn replica_delta_pagination_rejects_movement_and_tracks_removals() {
    let (_scratch, mut store) = fixture(16_002);
    let mut cache = CurrentViewCache::default();
    let mut request = request();
    let first = collect_current_view_cached(&store, "ws", &request, &mut cache).unwrap();
    assert!(first.next_cursor.is_some());
    request.position = Some(position(&first));
    request.cursor = first.next_cursor;
    edit(&mut store, 2);
    let moved = collect_current_view_cached(&store, "ws", &request, &mut cache).unwrap();
    assert!(moved.moved);
    assert!(moved.files.is_empty());
    request.position = None;
    request.cursor = None;
    let full = complete(&store, &mut request, &mut cache);
    store
        .write_with(&NoFaults, |tx| {
            tx.execute("DELETE FROM path_aliases WHERE object_id='o000000'", [])
                .map_err(StorageError::persist_public)?;
            dohc_engine_storage::replica::advance_frontiers(tx, "ws", 3, 0)
        })
        .unwrap();
    request.since = Some(position(&full));
    let removed = complete(&store, &mut request, &mut cache);
    assert!(removed.delta);
    assert_eq!(removed.removed.len(), 1);
    assert!(removed.files.is_empty());
    request.since = Some(position(&removed));
    store
        .write_with(&NoFaults, |tx| {
            tx.execute("DELETE FROM path_aliases", [])
                .map_err(StorageError::persist_public)?;
            dohc_engine_storage::replica::advance_frontiers(tx, "ws", 4, 0)
        })
        .unwrap();
    let removed = complete(&store, &mut request, &mut cache);
    assert_eq!(removed.removed.len(), 16_001);
    assert!(cache.manifest.is_empty());
}

#[test]
fn replica_delta_path_replacement_removes_the_displaced_object() {
    let (_scratch, mut store) = fixture(2);
    let mut cache = CurrentViewCache::default();
    let mut request = request();
    let full = complete(&store, &mut request, &mut cache);
    request.since = Some(position(&full));
    store.write_with(&NoFaults,|tx| {
        tx.execute("INSERT OR REPLACE INTO path_aliases VALUES('ws','main','docs/000000.md','o000001')",[]).map_err(StorageError::persist_public)?;
        tx.execute("UPDATE snapshots SET path='docs/000000.md' WHERE object_id='o000001'",[]).map_err(StorageError::persist_public)?;
        dohc_engine_storage::replica::advance_frontiers(tx,"ws",2,0)
    }).unwrap();
    let delta = complete(&store, &mut request, &mut cache);
    assert!(delta.delta);
    assert_eq!(delta.files.len(), 1);
    assert_eq!(delta.files[0].object_id, "o000001");
    assert_eq!(delta.removed.len(), 1);
    assert_eq!(delta.removed[0].object_id, "o000000");
}

#[test]
fn replica_delta_keeps_writes_after_the_first_page() {
    let (_scratch, mut store) = fixture(16_002);
    let mut cache = CurrentViewCache::default();
    let mut request = request();
    let first = collect_current_view_cached(&store, "ws", &request, &mut cache).unwrap();
    request.position = Some(position(&first));
    request.cursor = first.next_cursor;
    // A tracked write at the same frontier must survive collection completion.
    edit(&mut store, 1);
    let full = complete(&store, &mut request, &mut cache);
    request.since = Some(position(&full));
    let delta = complete(&store, &mut request, &mut cache);
    assert!(delta.delta);
    assert_eq!(delta.files.len(), 1);
    assert_eq!(delta.files[0].object_id, "o000000");
}

#[test]
fn replica_delta_removal_page_retains_scene_dependencies() {
    let (_scratch, mut store) = fixture(16_002);
    let mut cache = CurrentViewCache::default();
    let mut request = request();
    let full = complete(&store, &mut request, &mut cache);
    let scene = ("main".to_string(), "o000000".to_string());
    // Exercise scene dependency scheduling independently of scene projection.
    cache.scenes.insert(scene.clone());
    *cache.manifest.get_mut(&scene).unwrap() = "old scene projection".into();
    store
        .write_with(&NoFaults, |tx| {
            tx.execute("DELETE FROM path_aliases WHERE object_id<>'o000000'", [])
                .map_err(StorageError::persist_public)?;
            dohc_engine_storage::replica::advance_frontiers(tx, "ws", 2, 0)
        })
        .unwrap();
    request.since = Some(position(&full));
    let delta = complete(&store, &mut request, &mut cache);
    assert_eq!(delta.removed.len(), 16_001);
    assert_eq!(
        delta.files.len(),
        1,
        "scene dependency survives the removal-only page"
    );
}
