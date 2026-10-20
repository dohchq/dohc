use super::*;
use dohc_engine_collab::{ContentKind, DocKey, Regime, Ydoc};
use dohc_engine_testkit::{ScratchDir, engine_db_path};

fn edited_scene(scratch: &ScratchDir) -> (EngineStore, DocKey) {
    let mut store = EngineStore::open(&engine_db_path(scratch).unwrap(), 1).unwrap();
    dohc_engine_sync::create_hosted_replica(
        &mut store,
        "ws",
        "service-host:host",
        "epoch",
        "stream",
        1,
        &NoFaults,
    )
    .unwrap();
    dohc_engine_domain::VersionedTextStore::new(&mut store)
        .ensure_main_version("ws", "main", 1, &NoFaults)
        .unwrap();
    store.write_with(&NoFaults, |tx| {
        tx.execute("INSERT INTO file_objects (workspace_id,object_id,created_at_ms) VALUES ('ws','drawing',1)", [])
            .map_err(dohc_engine_storage::StorageError::persist_public)?;
        tx.execute("INSERT INTO hosted_documents (workspace_id,object_id,path,state,scope_generation) VALUES ('ws','drawing','drawing.excalidraw','ready',1)", [])
            .map_err(dohc_engine_storage::StorageError::persist_public)?;
        Ok::<_, dohc_engine_storage::StorageError>(())
    }).unwrap();
    let key = DocKey::new("ws", "main", "drawing").unwrap();
    dohc_engine_collab::ensure_marker(
        &mut store,
        &key,
        ContentKind::Scene,
        Regime::Replicated,
        &NoFaults,
        2,
    )
    .unwrap();
    let imported = dohc_engine_collab::import_portable_scene(
        &serde_json::json!({
            "type": "excalidraw",
            "elements": [{"id":"image", "type":"image", "version":1, "versionNonce":1,
                "index":"a0", "isDeleted":false, "fileId":"file"}],
            "files": {"file":{"id":"file", "mimeType":"image/png", "created":1,
                "dataURL":"data:image/png;base64,AQIDBA=="}}
        })
        .to_string(),
    )
    .unwrap();
    let sha = dohc_engine_storage::hex_sha256(&imported.files["file"].bytes);
    let path =
        dohc_engine_collab::scene_asset_ref("ws", "main", "drawing", &sha, "image/png").unwrap();
    let assets = std::collections::BTreeMap::from([(
        "file".into(),
        serde_json::json!({
            "id":"file", "mimeType":"image/png", "created":1, "ref":path, "sha256":sha
        })
        .to_string(),
    )]);
    let doc = Ydoc::wire();
    doc.apply(&imported.initial_update).unwrap();
    doc.apply(&dohc_engine_collab::encode_scene_asset_records(&assets).unwrap())
        .unwrap();
    assert_eq!(doc.fold_scene().assets.len(), 1);
    store
        .write_with(&NoFaults, |tx| {
            dohc_engine_collab::record_update_in_tx(
                tx,
                &key,
                &doc.encode_full_state(),
                None,
                None,
                3,
            )
        })
        .unwrap();
    (store, key)
}

fn assert_missing_asset_error<T: std::fmt::Debug>(result: Result<T, RuntimeError>) {
    assert!(
        matches!(&result,
        Err(RuntimeError::Sync(dohc_engine_sync::SyncError::RetryableState { reason }))
            if *reason == "scene asset head is pending"),
        "{result:?}"
    );
}

#[tokio::test]
async fn edited_scene_missing_asset_keeps_the_live_unload_error() {
    let scratch = ScratchDir::new().unwrap();
    let (store, key) = edited_scene(&scratch);
    drop(store);
    let db = engine_db_path(&scratch).unwrap();
    let supervisor = crate::WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 4).unwrap().actor;
    let owner = actor.live_application_owner("ws".into()).await.unwrap();
    let result = owner
        .unload("drawing".into(), vec![key], scratch.path().into(), 5)
        .await;
    supervisor.close(&db).unwrap();
    assert_missing_asset_error(result);
}

#[test]
fn edited_scene_missing_asset_keeps_the_departure_error() {
    let scratch = ScratchDir::new().unwrap();
    let (mut store, _) = edited_scene(&scratch);
    assert!(dohc_engine_sync::hosted_document_parkable(&store, "ws", "drawing").unwrap());
    let result = park_departed_hosted(
        &mut store,
        &mut WriterDocCache::new(),
        &LeaseRegistry::default(),
        "ws",
        scratch.path(),
        4,
    );
    assert_eq!(
        dohc_engine_sync::departed_hosted_object_ids(&store, "ws").unwrap(),
        ["drawing"]
    );
    assert_missing_asset_error(result);
}
