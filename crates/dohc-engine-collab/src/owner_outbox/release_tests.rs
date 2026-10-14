use dohc_engine_storage::{hex_sha256, put_binary_blob_with_sha, EngineStore, NoFaults};
use dohc_test_scratch::ScratchDir;
use yrs::updates::{decoder::Decode, encoder::Encode};
use yrs::{ReadTxn, Text, Transact};

#[test]
fn accepted_delete_is_contained_with_an_incomplete_checkpoint_delete_set() {
    let doc = yrs::Doc::with_options(yrs::Options {
        client_id: yrs::ClientID::new(777),
        offset_kind: yrs::OffsetKind::Utf16,
        skip_gc: false,
        ..yrs::Options::default()
    });
    let text = doc.get_or_insert_text("text");
    text.insert(&mut doc.transact_mut(), 0, "abc");
    let deletion = {
        let mut txn = doc.transact_mut();
        text.remove_range(&mut txn, 0, 1);
        txn.encode_update_v1()
    };
    let txn = doc.transact();
    let mut checkpoint = txn.encode_state_as_update_v1(&yrs::StateVector::default());
    let deleted = txn.snapshot().delete_set.encode_v1();
    assert!(checkpoint.ends_with(&deleted));
    checkpoint.truncate(checkpoint.len() - deleted.len());
    checkpoint.push(0);
    assert!(yrs::Update::decode_v1(&checkpoint)
        .unwrap()
        .delete_set()
        .is_empty());
    // GC retains deleted struct clocks even without the encoded delete set.
    let accepted = crate::Ydoc::wire();
    accepted.apply(&checkpoint).unwrap();
    assert_eq!(accepted.encode_delete_set(), deleted);

    let root = ScratchDir::new_named("release-delete-containment").unwrap();
    let mut store = EngineStore::open(&root.join("engine.db"), 0).unwrap();
    let digest = hex_sha256(&checkpoint);
    store
        .write_with(&NoFaults, |tx| {
            put_binary_blob_with_sha(tx, &checkpoint, &digest)
        })
        .unwrap();
    assert!(store
        .read_with(|conn| super::contains_pending_in(
            conn,
            &digest,
            [deletion.as_slice()].into_iter()
        ))
        .unwrap());
}

#[test]
fn accepted_unsorted_delete_set_is_contained() {
    let doc = yrs::Doc::with_options(yrs::Options {
        client_id: yrs::ClientID::new(777),
        offset_kind: yrs::OffsetKind::Utf16,
        skip_gc: true,
        ..yrs::Options::default()
    });
    let text = doc.get_or_insert_text("text");
    text.insert(&mut doc.transact_mut(), 0, "abcd");
    text.remove_range(&mut doc.transact_mut(), 2, 1);
    text.remove_range(&mut doc.transact_mut(), 0, 1);
    let checkpoint = doc
        .transact()
        .encode_state_as_update_v1(&yrs::StateVector::default());
    // V1: no structs, client 777, ranges 2..3, 0..1. Decode preserves order.
    let deletion = [0, 1, 137, 6, 2, 2, 1, 0, 1];
    let decoded = yrs::Update::decode_v1(&deletion).unwrap();
    assert_eq!(
        decoded
            .delete_set()
            .get(&yrs::ClientID::new(777))
            .unwrap()
            .iter()
            .map(|(range, _)| range.clone())
            .collect::<Vec<_>>(),
        vec![2..3, 0..1]
    );
    let root = ScratchDir::new_named("release-unsorted-delete-containment").unwrap();
    let mut store = EngineStore::open(&root.join("engine.db"), 0).unwrap();
    let digest = hex_sha256(&checkpoint);
    store
        .write_with(&NoFaults, |tx| {
            put_binary_blob_with_sha(tx, &checkpoint, &digest)
        })
        .unwrap();
    assert!(store
        .read_with(|conn| super::contains_pending_in(
            conn,
            &digest,
            [deletion.as_slice()].into_iter()
        ))
        .unwrap());
}
