use super::*;
use dohc_engine_collab::{WriterDocCache, Ydoc, owner_outbox::draft::ObservedOwnerBinding};

// The base comparison replaces only this adapter: base has no hold capability.
fn admission(
    store: &mut EngineStore,
    owner: &ObservedOwnerBinding,
    op: &ReplicationEnvelope,
) -> ApplyOutcome<RoutedApply> {
    let TxnOutcome::Committed(hold) = store
        .write_with(&NoFaults, |tx| {
            open_release_hold_in(tx, &owner.binding, "relay", &"a".repeat(64))
        })
        .unwrap()
    else {
        panic!("hold");
    };
    apply_replication_envelope_with_release_hold(
        store,
        &mut WriterDocCache::new(),
        op,
        &NoFaults,
        &NoLiveLeases,
        &hold,
    )
    .unwrap()
}

#[test]
fn new_hold_admission_does_not_terminally_refuse_ordinary_peer_update() {
    let (_dir, mut store, owner, checkpoint) = owner_publication::fixture();
    let doc = Ydoc::wire();
    doc.apply(&checkpoint).unwrap();
    let bytes = doc.richdoc_append_paragraph("held peer");
    let sha = store.put_binary_blob(&bytes).unwrap();
    let op = envelope(
        "peer",
        0,
        "ydoc.update",
        json!({"versionId":"main","objectId":"owner","path":"owner.md","contentKind":"richdoc","lineageClaimId":owner.binding.lineage_claim_id,"updateBlobSha256":sha}),
    );
    let out = admission(&mut store, &owner, &op);
    assert!(
        matches!(out.primary, ApplyDisposition::Applied(_)),
        "{out:?}"
    );
    assert_eq!(read_replication_acked_seq(&store, "ws", "peer").unwrap(), 0);
    assert_eq!(
        store
            .table_row_count("replication_pending_refusals")
            .unwrap(),
        0
    );
}

#[test]
fn new_hold_admission_does_not_terminally_refuse_ordinary_peer_delete() {
    let (_dir, mut store, owner, _) = owner_publication::fixture();
    let sha = dohc_engine_storage::hex_sha256(b"");
    store
        .read_with(|c| c.execute("INSERT OR IGNORE INTO blobs VALUES(?1,0,'')", [&sha]))
        .unwrap();
    let op = envelope(
        "peer",
        0,
        "moment.append",
        json!({"momentId":"delete","versionId":"main","objectId":"owner","path":"owner.md","recordedAtMs":2000,"operation":"delete","payloadAfterBlobSha256":sha,"payloadAfterPath":"owner.md","metadata":{"origin":"sync"},"beforePresent":"absent","authors":[{"kind":"agent","agentId":"agent"}]}),
    );
    let out = admission(&mut store, &owner, &op);
    assert!(
        matches!(out.primary, ApplyDisposition::Applied(_)),
        "{out:?}"
    );
    assert_eq!(store.table_row_count("snapshots").unwrap(), 1);
    assert_eq!(
        store
            .table_row_count("replication_pending_refusals")
            .unwrap(),
        0
    );
}
