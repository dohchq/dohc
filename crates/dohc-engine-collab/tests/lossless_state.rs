mod common;

use common::*;
use dohc_engine_collab::{
    ensure_marker, load_persisted, maybe_compact, record_local_update, CompactOutcome, ContentKind,
    LocalAppend, Regime, WriterDocCache, Ydoc,
};
use dohc_engine_storage::{NoFaults, TxnOutcome};
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Fixture {
    updates: Vec<Vec<u8>>,
    retained_state: Vec<u8>,
    collected_state: Vec<u8>,
}

#[test]
fn deleted_yjs_payload_survives_native_replay_compaction_and_restart() {
    let fixture: Fixture =
        serde_json::from_str(include_str!("lossless-fixtures/deleted-history.json")).unwrap();
    assert_ne!(fixture.retained_state, fixture.collected_state);
    let doc = Ydoc::wire();
    for update in &fixture.updates {
        doc.apply(update).unwrap();
    }
    assert_eq!(doc.encode_full_state(), fixture.retained_state);
    let dir = unique_dir("lossless-compaction");
    let mut store = open_at(&dir, 1_000);
    let key = test_key();
    seed_parents(&mut store, &key, 1_000);
    ensure_marker(
        &mut store,
        &key,
        ContentKind::Richdoc,
        Regime::Replicated,
        &NoFaults,
        1_000,
    )
    .unwrap();
    let mut cache = WriterDocCache::new();
    for (index, update) in fixture.updates.iter().enumerate() {
        record_local_update(
            &mut store,
            &mut cache,
            &key,
            update,
            LocalAppend::default(),
            &NoFaults,
            1_001 + index as i64,
            |_, _, _| Ok(()),
        )
        .unwrap();
    }
    assert_eq!(
        load_persisted(&store, &key)
            .unwrap()
            .unwrap()
            .doc
            .encode_full_state(),
        fixture.retained_state
    );
    let compacted = maybe_compact(&mut store, &key, 0, &NoFaults, 1_010).unwrap();
    let TxnOutcome::Committed(CompactOutcome::Compacted {
        up_to_seq,
        snapshot_sha,
        ..
    }) = compacted
    else {
        panic!("forced compaction must fold the updates");
    };
    cache.note_compacted(&store, &key, up_to_seq, &snapshot_sha);
    assert_eq!(
        cache.doc_full_state_for_test(&key).unwrap(),
        fixture.retained_state
    );
    assert_eq!(count(&store, "ydoc_updates", &key), 0);
    assert_eq!(
        store.get_binary_blob(&snapshot_sha).unwrap().unwrap(),
        fixture.retained_state
    );
    drop(cache);
    drop(store);
    let reopened = reopen(&dir);
    assert_eq!(
        load_persisted(&reopened, &key)
            .unwrap()
            .unwrap()
            .doc
            .encode_full_state(),
        fixture.retained_state
    );
    // Existing collected bytes cannot recover their deleted values by reloading.
    let collected = Ydoc::wire();
    collected.apply(&fixture.collected_state).unwrap();
    assert_ne!(collected.encode_full_state(), fixture.retained_state);
}
