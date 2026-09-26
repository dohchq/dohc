use super::*;

fn remote_changes(engine: &EngineStore) -> i64 {
    engine
        .read_with(|conn| dohc_engine_storage::remote_changes_applied_in(conn, "ws"))
        .expect("read the count")
}

fn apply(engine: &mut EngineStore, envelope: &ReplicationEnvelope) {
    apply_replication_envelope(
        engine,
        &mut dohc_engine_collab::WriterDocCache::new(),
        envelope,
        &NoFaults,
        &NoLiveLeases,
    )
    .expect("apply");
}

/// An op another computer made counts once when it applies. A redelivery,
/// and this computer's own op echoing back, count nothing, and the count
/// survives reopening the store.
#[test]
fn an_applied_op_from_elsewhere_counts_once_and_survives_reopening() {
    let (_scratch, path, mut engine) = open_store();
    seed_identity(&mut engine);
    let own = journal_local_replication_op(
        &mut engine,
        "ws",
        "local",
        "epoch-1",
        "stream-1",
        "workspace.init",
        &json!({}),
        1_000,
        &NoFaults,
    )
    .expect("journal an own op");
    assert_eq!(own, TxnOutcome::Committed(1));
    for (seq, kind) in [(0, "probe.local"), (1, "workspace.init")] {
        let echo = ReplicationEnvelope {
            recorded_at_ms: 1_000,
            ..envelope("local", seq, kind, json!({}))
        };
        apply(&mut engine, &echo);
    }
    assert_eq!(
        remote_changes(&engine),
        0,
        "this computer's own ops echoing back"
    );

    let peer = envelope("peer", 0, "workspace.init", json!({}));
    apply(&mut engine, &peer);
    assert_eq!(remote_changes(&engine), 1);
    apply(&mut engine, &peer);
    assert_eq!(remote_changes(&engine), 1, "a redelivered op");

    drop(engine);
    let reopened = EngineStore::open(&path, 2).expect("reopen");
    assert_eq!(remote_changes(&reopened), 1, "the count survives a restart");
}
