use super::*;

#[test]
fn outbound_authors_filter_only_people_and_omit_a_human_only_list() {
    let human = json!({"kind":"human","humanId":"person","onBehalfOf":"owner"});
    let agent =
        json!({"kind":"agent","agentId":"agent","onBehalfOf":"owner","agentRunId":"run","depth":3});
    let automation =
        json!({"kind":"automation","automationId":"rule","onBehalfOf":"owner","depth":4});
    for (authors, expected) in [
        (json!([human]), None),
        (json!([human, agent]), Some(json!([agent]))),
        (json!([agent, automation]), Some(json!([agent, automation]))),
    ] {
        let mut payload = json!({"authors": authors, "momentId":"moment"});
        crate::outbound::omit_human_authors(&mut payload);
        assert_eq!(payload.get("authors"), expected.as_ref());
        assert_eq!(payload["momentId"], "moment");
        let repaired = payload.clone();
        assert!(!crate::outbound::omit_human_authors(&mut payload));
        assert_eq!(payload, repaired);
    }
}

fn queue_legacy_moment(engine: &mut EngineStore, authors: serde_json::Value) {
    seed_identity(engine);
    engine
        .write_with(&NoFaults, |tx| {
            // A queued wire payload from the affected build, independent of History.
            journal_local_op_in_tx(
                tx,
                "ws",
                "moment.append",
                &json!({"versionId":"main","objectId":"record","authors":authors}),
                2000,
            )
        })
        .unwrap();
}

#[test]
fn queued_human_authors_are_durably_repaired_before_push_and_echo() {
    for authors in [
        json!([{"kind":"human","humanId":"person"}]),
        json!([{"kind":"human","humanId":"person"},{"kind":"agent","agentId":"agent","onBehalfOf":"owner"}]),
    ] {
        let (_scratch, path, mut engine) = open_store();
        queue_legacy_moment(&mut engine, authors);
        let client = RelaySyncClient::new(FakeRelay::default());
        let faults = ScriptedFaults::crash_at(FaultPoint::SyncAfterPushBeforeCursorPersist);
        assert_eq!(
            client
                .push_workspace(&mut engine, "ws", faults.as_ref(), &NoLiveLeases, 2001, 0)
                .unwrap(),
            SyncPassOutcome::CrashedAfterRemoteCommit
        );
        let first = client.transport().pushes.lock().unwrap()[0].ops.clone();
        let repaired = &first[1].payload;
        assert!(repaired.get("authors").is_none_or(|authors| {
            authors
                .as_array()
                .unwrap()
                .iter()
                .all(|author| author["kind"] == "agent")
        }));
        drop(engine);
        let mut engine = EngineStore::open(&path, 2002).unwrap();
        let stored = list_replication_ops(&engine, "ws", "local", 0, 10).unwrap();
        assert_eq!(&stored[0].payload, repaired);
        client
            .push_workspace(&mut engine, "ws", &NoFaults, &NoLiveLeases, 2003, 0)
            .unwrap();
        assert_eq!(client.transport().pushes.lock().unwrap()[1].ops, first);
        *client.transport().pull.lock().unwrap() = Some(PullResponse {
            ops: first,
            next_cursor: 2,
            has_more: false,
        });
        client
            .pull_chat_workspace(
                &mut engine,
                &mut WriterDocCache::new(),
                "ws",
                &NoFaults,
                &NoLiveLeases,
                2004,
            )
            .expect("exact own echo must not diverge");
    }
}

#[test]
fn queued_author_repair_leaves_imported_and_other_operation_payloads_unchanged() {
    let (_scratch, _path, mut engine) = open_store();
    queue_legacy_moment(&mut engine, json!([{"kind":"human","humanId":"person"}]));
    engine
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "UPDATE replication_log SET imported=1 WHERE origin_seq=1",
                [],
            )
            .map_err(SyncError::persist)?;
            journal_local_op_in_tx(
                tx,
                "ws",
                "probe.other",
                &json!({"authors":[{"kind":"human","humanId":"person"}]}),
                2001,
            )
        })
        .unwrap();
    let mut ops = list_replication_ops(&engine, "ws", "local", -1, 10).unwrap();
    let before = ops.clone();
    assert_eq!(
        crate::outbound::repair_queued_moment_authors(&mut engine, &mut ops, &NoFaults).unwrap(),
        TxnOutcome::Committed(())
    );
    assert_eq!(ops, before);
    assert_eq!(
        list_replication_ops(&engine, "ws", "local", -1, 10).unwrap(),
        before
    );
}

#[test]
fn a_crashed_queued_author_repair_sends_nothing_and_recovers_on_retry() {
    let (_scratch, path, mut engine) = open_store();
    queue_legacy_moment(&mut engine, json!([{"kind":"human","humanId":"person"}]));
    let client = RelaySyncClient::new(FakeRelay::default());
    let faults = ScriptedFaults::crash_at(FaultPoint::StorageBeforePersist);
    assert!(
        client
            .push_workspace(&mut engine, "ws", faults.as_ref(), &NoLiveLeases, 2001, 0)
            .is_err()
    );
    assert!(client.transport().pushes.lock().unwrap().is_empty());
    drop(engine);
    let mut engine = EngineStore::open(&path, 2002).unwrap();
    client
        .push_workspace(&mut engine, "ws", &NoFaults, &NoLiveLeases, 2003, 0)
        .unwrap();
    assert!(
        client.transport().pushes.lock().unwrap()[0].ops[1]
            .payload
            .get("authors")
            .is_none()
    );
}
