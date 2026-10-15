use super::*;
use dohc_engine_storage::NoFaults;
use dohc_test_scratch::ScratchDir;

thread_local! {
    static RECONSTRUCTIONS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

pub(super) fn record_reconstruction() {
    RECONSTRUCTIONS.with(|count| count.set(count.get() + 1));
}

fn reset_reconstructions() {
    RECONSTRUCTIONS.with(|count| count.set(0));
}

fn reconstructions() -> usize {
    RECONSTRUCTIONS.with(std::cell::Cell::get)
}

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

#[test]
fn removed_entry_defers_dependency_reconstruction_until_page_end() {
    let (_scratch, mut store, keys) = setup(1);
    let key = &keys[0];
    let doc = Ydoc::wire();
    doc.plaintext_insert(0, "unreceived");
    let pending: Vec<_> = (0..3).map(|i| doc.plaintext_insert(10 + i, "x")).collect();
    let outcome = store
        .write_with(&NoFaults, |tx| {
            let mut cache = TransactionDocCache::new(tx);
            cache.append(key, &Ydoc::wire().plaintext_insert(0, "resident"), 1)?;
            assert!(!cache.has_missing_updates(key)?);
            // Model a document larger than the byte budget, including a stale
            // dependency result from its earlier resident append.
            cache.docs = WriterDocCache::with_limits_for_test(16, 0);
            for update in &pending {
                reset_reconstructions();
                assert!(!cache.append(key, update, 1)?.deduped);
                assert!(!cache.docs.contains_for_test(key));
                assert_eq!(
                    reconstructions(),
                    1,
                    "only the append gate reconstructs; dependency checking waits"
                );
            }
            reset_reconstructions();
            assert!(cache.has_missing_updates(key)?);
            assert_eq!(reconstructions(), 1, "page end reconstructs once");
            Err::<(), _>(CollabError::MissingDependencies)
        })
        .unwrap_err();
    assert!(matches!(outcome, CollabError::MissingDependencies));
    assert_eq!(
        read_marker(&store, key).unwrap().unwrap().head_update_seq,
        0
    );
}
