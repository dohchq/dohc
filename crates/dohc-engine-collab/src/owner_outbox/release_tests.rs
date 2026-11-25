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

#[test]
fn relay_history_counts_a_settlement_that_names_an_earlier_moment_held_here() {
    use dohc_engine_domain::{VersionedTextStore, WriteText};
    let root = ScratchDir::new_named("release-relay-history").unwrap();
    let mut store = EngineStore::open(&root.join("engine.db"), 0).unwrap();
    VersionedTextStore::new(&mut store)
        .ensure_main_version("ws", "main", 1, &NoFaults)
        .unwrap();
    VersionedTextStore::new(&mut store)
        .write_text(
            &WriteText {
                workspace_id: "ws".into(),
                version_id: "main".into(),
                object_id: "object".into(),
                path: "note.md".into(),
                text: "settled words".into(),
                moment_id: "settled-moment".into(),
                metadata_origin: "sync".into(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 2,
                request_id: None,
            },
            &NoFaults,
        )
        .unwrap();
    let binding = crate::LiveObjectBinding {
        workspace_id: "ws".into(),
        main_version_id: "main".into(),
        object_id: "object".into(),
        lineage_claim_id: "lineage".into(),
        current_path: "note.md".into(),
        selector_paths: vec!["note.md".into()],
        restore_fence_generation: 0,
    };
    let settle = |store: &mut EngineStore, id: &str, moment: &str, cursor: i64| {
        let record = serde_json::json!({
            "binding": binding,
            "relayDatabaseNamespace": "relay",
            "terminalCursor": cursor,
            "momentId": moment,
        })
        .to_string();
        store
            .write_with(&NoFaults, |tx| {
                tx.execute(
                    "INSERT INTO live_audit_settlements(settlement_id,workspace_id,record_digest,record_json,markdown_digest)
                     SELECT ?1,'ws',?2,?3,after_blob_sha256 FROM moments WHERE moment_id='settled-moment'",
                    rusqlite::params![id, hex_sha256(record.as_bytes()), record],
                )
                .map(|_| ())
                .map_err(dohc_engine_storage::StorageError::persist_public)
            })
            .unwrap();
    };
    let arrived = |store: &EngineStore, namespace: &str, cursor: i64| {
        store
            .read_with(|conn| super::relay_history_arrived_in(conn, &binding, namespace, cursor))
            .unwrap()
    };

    assert!(arrived(&store, "relay", 0));
    assert!(!arrived(&store, "relay", 1));
    settle(&mut store, "absent", "moment-not-here", 4);
    assert!(!arrived(&store, "relay", 1));
    settle(&mut store, "first", "settled-moment", 1);
    assert!(arrived(&store, "relay", 1));
    assert!(!arrived(&store, "relay", 2));
    settle(&mut store, "unchanged", "settled-moment", 2);
    assert!(arrived(&store, "relay", 2));
    assert!(!arrived(&store, "relay", 3));
    assert!(!arrived(&store, "other-relay", 1));
}
