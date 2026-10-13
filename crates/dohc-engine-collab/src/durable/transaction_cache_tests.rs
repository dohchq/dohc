use super::*;
use dohc_engine_storage::NoFaults;
use dohc_test_scratch::ScratchDir;

#[test]
fn dependency_check_revalidates_changed_replay_coordinates() {
    let scratch = ScratchDir::new().unwrap();
    let mut store = EngineStore::open(&scratch.join("engine.db"), 1).unwrap();
    let key = DocKey::new("ws", "main", "object").unwrap();
    store
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT INTO versioned_workspaces(workspace_id,main_version_id) VALUES ('ws','main')",
                [],
            )
            .map_err(map_sql)?;
            tx.execute(
                "INSERT INTO file_objects(workspace_id,object_id,created_at_ms) VALUES ('ws','object',1)",
                [],
            )
            .map_err(map_sql)?;
            Ok::<_, CollabError>(())
        })
        .unwrap();
    ensure_marker(
        &mut store,
        &key,
        ContentKind::Plaintext,
        Regime::LocalOnly,
        &NoFaults,
        1,
    )
    .unwrap();
    let source = Ydoc::wire();
    source.plaintext_insert(0, "held");
    let pending = source.plaintext_insert(4, "successor");
    store
        .write_with(&NoFaults, |tx| {
            let mut cache = TransactionDocCache::new(tx);
            assert!(!cache.has_missing_updates(&key)?);
            assert!(!cache.has_missing_updates(&key)?);
            let sha = put_binary_blob(tx, &pending)?;
            tx.execute(
                "INSERT INTO ydoc_updates(workspace_id,version_id,object_id,seq,update_blob_sha256,recorded_at_ms) VALUES ('ws','main','object',1,?1,1)",
                [sha],
            )
            .map_err(map_sql)?;
            tx.execute("UPDATE ydoc_docs SET head_update_seq=1", [])
                .map_err(map_sql)?;
            assert!(cache.has_missing_updates(&key)?);
            Ok::<_, CollabError>(())
        })
        .unwrap();
}
