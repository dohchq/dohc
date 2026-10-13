use super::*;
use dohc_engine_storage::NoFaults;
use dohc_test_scratch::ScratchDir;

fn setup(count: usize) -> (ScratchDir, EngineStore, Vec<DocKey>) {
    let scratch = ScratchDir::new_named("passive-transaction-cache").unwrap();
    let mut store = EngineStore::open_passive(&scratch.join("engine.db"), 0, None, None).unwrap();
    let keys: Vec<_> = (0..count)
        .map(|i| DocKey::new("ws", "main", format!("object-{i}")).unwrap())
        .collect();
    store.write_with(&NoFaults, |tx| {
        tx.execute("INSERT INTO versioned_workspaces(workspace_id,main_version_id) VALUES('ws','main')", []).map_err(map_sql)?;
        for key in &keys {
            tx.execute("INSERT INTO file_objects(workspace_id,object_id,created_at_ms) VALUES('ws',?1,0)", [&key.object_id]).map_err(map_sql)?;
        }
        Ok::<_, CollabError>(())
    }).unwrap();
    for key in &keys {
        ensure_marker(
            &mut store,
            key,
            ContentKind::Plaintext,
            Regime::Replicated,
            &NoFaults,
            0,
        )
        .unwrap();
    }
    (scratch, store, keys)
}

#[test]
fn appended_documents_need_no_page_end_cache_probe_after_eviction() {
    let (_scratch, mut store, keys) = setup(40);
    store
        .write_with(&NoFaults, |tx| {
            let mut cache = TransactionDocCache::new(tx);
            for key in &keys {
                assert!(
                    !cache
                        .append(key, &Ydoc::wire().plaintext_insert(0, "new"), 1)?
                        .deduped
                );
            }
            assert!(
                !cache.docs.contains_for_test(&keys[0]),
                "first document was evicted"
            );
            let before = cache.docs.stats();
            for key in &keys {
                assert!(!cache.has_missing_updates(key)?);
            }
            let after = cache.docs.stats();
            assert_eq!(
                after.misses, before.misses,
                "page-end check must not rebuild evicted appended documents"
            );
            assert_eq!(
                after.hits, before.hits,
                "page-end check uses the retained dependency result"
            );
            Ok::<_, CollabError>(())
        })
        .unwrap();
}

#[test]
fn evicted_pending_document_keeps_its_dependency_result() {
    let (_scratch, mut store, keys) = setup(40);
    let doc = Ydoc::wire();
    doc.plaintext_insert(0, "unreceived");
    let pending = doc.plaintext_insert(10, "successor");
    store
        .write_with(&NoFaults, |tx| {
            let mut cache = TransactionDocCache::new(tx);
            cache.append(&keys[0], &pending, 1)?;
            for key in &keys[1..] {
                cache.append(key, &Ydoc::wire().plaintext_insert(0, "new"), 1)?;
            }
            assert!(!cache.docs.contains_for_test(&keys[0]));
            assert!(cache.has_missing_updates(&keys[0])?);
            Ok::<_, CollabError>(())
        })
        .unwrap();
}

#[test]
fn dedupe_only_document_rebuilds_and_detects_missing_dependencies() {
    let (_scratch, mut store, keys) = setup(1);
    let doc = Ydoc::wire();
    doc.plaintext_insert(0, "unreceived");
    let pending = doc.plaintext_insert(10, "successor");
    store
        .write_with(&NoFaults, |tx| {
            TransactionDocCache::new(tx).append(&keys[0], &pending, 1)?;
            Ok::<_, CollabError>(())
        })
        .unwrap();
    store
        .write_with(&NoFaults, |tx| {
            let mut cache = TransactionDocCache::new(tx);
            assert!(cache.append(&keys[0], &pending, 1)?.deduped);
            assert!(!cache.docs.contains_for_test(&keys[0]));
            assert!(cache.has_missing_updates(&keys[0])?);
            Ok::<_, CollabError>(())
        })
        .unwrap();
}
