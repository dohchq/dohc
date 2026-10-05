use super::*;
use dohc_engine_domain::WriteText;

#[test]
fn queued_author_repair_omits_people_and_shared_authors() {
    let human = json!({"kind":"human","humanId":"person","onBehalfOf":"owner"});
    // The relay mints these, and refuses them from a client.
    let named = json!({"kind":"named","userId":"ana","grantId":"grant","grantGeneration":2});
    let link = json!({"kind":"link","grantId":"grant","grantGeneration":2,"principalId":"holder"});
    let public = json!({"kind":"public","principalId":"holder","grantId":"grant"});
    // A relay-admitted live author snapshot names these. The relay refuses
    // them from a client too.
    let snapshot_human = json!({"kind":"human","humanId":"person","humanName":"Person"});
    let snapshot_link = json!({"kind":"link","publicPrincipalId":"public_1","label":"Anonymous"});
    let declared = json!({"kind":"agent","agentId":"writer","agentName":"Writer","onBehalfOf":"person","depth":0});
    let agent =
        json!({"kind":"agent","agentId":"agent","onBehalfOf":"owner","agentRunId":"run","depth":3});
    let automation =
        json!({"kind":"automation","automationId":"rule","onBehalfOf":"owner","depth":4});
    let local_agent = json!({"kind":"agent","agentId":"agent","onBehalfOf":"local:123","agentRunId":"run","depth":3});
    let local_automation =
        json!({"kind":"automation","automationId":"rule","onBehalfOf":"local:456","depth":4});
    for (authors, expected) in [
        (json!([human]), None),
        (json!([named]), None),
        (json!([human, named, link, public]), None),
        (json!([human, agent]), Some(json!([agent]))),
        (json!([agent, named, link]), Some(json!([agent]))),
        (json!([snapshot_human, named, snapshot_link, link]), None),
        // A hosted agent's live edit keeps only its declared agent.
        (json!([snapshot_human, declared]), Some(json!([declared]))),
        (json!([snapshot_link, declared]), Some(json!([declared]))),
        // An unknown kind is not this repair's to judge; validation refuses it.
        (
            json!([named, {"kind":"other"}]),
            Some(json!([{"kind":"other"}])),
        ),
        (json!([agent, automation]), Some(json!([agent, automation]))),
        (json!([local_agent]), Some(json!([local_agent]))),
        (json!([local_automation]), Some(json!([local_automation]))),
        (
            json!([human, local_agent, local_automation, agent, automation]),
            Some(json!([local_agent, local_automation, agent, automation])),
        ),
    ] {
        let mut payload = json!({"authors": authors, "momentId":"moment"});
        crate::outbound::omit_relay_attributed_authors(&mut payload);
        assert_eq!(payload.get("authors"), expected.as_ref());
        assert_eq!(payload["momentId"], "moment");
        let repaired = payload.clone();
        assert!(!crate::outbound::omit_relay_attributed_authors(
            &mut payload
        ));
        assert_eq!(payload, repaired);
    }
}

fn queue_legacy_moment(engine: &mut EngineStore, authors: serde_json::Value) -> serde_json::Value {
    seed_identity(engine);
    VersionedTextStore::new(engine)
        .ensure_main_version("ws", "main", 1000, &NoFaults)
        .unwrap();
    VersionedTextStore::new(engine)
        .write_text(
            &WriteText {
                workspace_id: "ws".into(),
                version_id: "main".into(),
                object_id: "record".into(),
                path: "tasks/record.md".into(),
                text: "hand-made record".into(),
                moment_id: "record-moment".into(),
                metadata_origin: "local-file".into(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: Some(serde_json::to_string(&authors).unwrap()),
                now_ms: 2000,
                request_id: None,
            },
            &NoFaults,
        )
        .unwrap();
    let mut legacy = serde_json::Value::Null;
    engine
        .write_with(&NoFaults, |tx| {
            let (mut payload, recorded_at_ms) =
                crate::outbound::moment_append_payload_in_tx(tx, "ws", "record-moment")?;
            // Restore the affected build's already-serialized author list.
            payload["authors"] = authors;
            journal_local_op_in_tx(tx, "ws", "moment.append", &payload, recorded_at_ms)?;
            legacy = payload;
            Ok::<_, SyncError>(())
        })
        .unwrap();
    legacy
}

#[test]
fn queued_human_and_shared_authors_are_durably_repaired_before_push_and_echo() {
    for authors in [
        json!([{"kind":"human","humanId":"person"}]),
        json!([{"kind":"human","humanId":"person"},{"kind":"agent","agentId":"agent","onBehalfOf":"owner"}]),
        // A live settlement names the collaborator the relay accepted the
        // edit from. This computer keeps it; the wire does not carry it.
        json!([{"kind":"named","userId":"ana","grantId":"grant","grantGeneration":1}]),
        json!([{"kind":"agent","agentId":"agent","onBehalfOf":"owner"},{"kind":"link","grantId":"grant","grantGeneration":1,"principalId":"holder"}]),
        // An enrolled owner's hosted agent edit settles with the relay-admitted
        // account holder beside the declared agent.
        json!([{"kind":"human","humanId":"owner","humanName":"Owner"},{"kind":"agent","agentId":"writer","onBehalfOf":"owner","depth":0}]),
        json!([{"kind":"link","publicPrincipalId":"public_1","label":"Anonymous"},{"kind":"agent","agentId":"writer","agentName":"Writer"}]),
    ] {
        let (_scratch, path, mut engine) = open_store();
        let original_authors = authors.clone();
        let mut expected = queue_legacy_moment(&mut engine, authors);
        crate::outbound::omit_relay_attributed_authors(&mut expected);
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
        assert_eq!(repaired, &expected);
        // The relay's log routes take only a client's own agents and automations.
        assert!(
            repaired
                .get("authors")
                .and_then(serde_json::Value::as_array)
                .is_none_or(|authors| authors
                    .iter()
                    .all(|author| matches!(author["kind"].as_str(), Some("agent" | "automation"))))
        );
        drop(engine);
        let mut engine = EngineStore::open(&path, 2002).unwrap();
        let stored = list_replication_ops(&engine, "ws", "local", 0, 10).unwrap();
        assert_eq!(&stored[0].payload, repaired);
        let history = VersionedTextStore::new(&mut engine)
            .get_moment("ws", "record-moment")
            .unwrap()
            .unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(history.author_json.as_deref().unwrap())
                .unwrap(),
            original_authors
        );
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
fn queued_agent_and_automation_authors_push_and_echo_unchanged() {
    for authors in [
        json!([{"kind":"agent","agentId":"agent","onBehalfOf":"local:123"}]),
        json!([{"kind":"automation","automationId":"rule","onBehalfOf":"local:456","depth":1}]),
    ] {
        let (_scratch, _path, mut engine) = open_store();
        let legacy = queue_legacy_moment(&mut engine, authors);
        let stored = list_replication_ops(&engine, "ws", "local", -1, 10).unwrap();
        let client = RelaySyncClient::new(FakeRelay::default());
        client
            .push_workspace(&mut engine, "ws", &NoFaults, &NoLiveLeases, 2001, 0)
            .unwrap();
        let pushed = client.transport().pushes.lock().unwrap()[0].ops.clone();
        assert_eq!(pushed, stored);
        assert_eq!(pushed[1].payload, legacy);
        *client.transport().pull.lock().unwrap() = Some(PullResponse {
            ops: stored,
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
                2002,
            )
            .expect("the relay's pre-upgrade echo must still match");
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
    let legacy = queue_legacy_moment(&mut engine, json!([{"kind":"human","humanId":"person"}]));
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
    assert_eq!(
        list_replication_ops(&engine, "ws", "local", 0, 10).unwrap()[0].payload,
        legacy
    );
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

#[test]
fn new_moment_payload_omits_installation_delegation_without_changing_history() {
    let (_scratch, _path, mut engine) = open_store();
    let authors = json!([
        {"kind":"human","humanId":"local:123"},
        {"kind":"human","humanId":"owner","humanName":"Owner"},
        {"kind":"link","publicPrincipalId":"public_1","label":"Anonymous"},
        {"kind":"agent","agentId":"agent","onBehalfOf":"local:123","depth":2},
        {"kind":"automation","automationId":"rule","onBehalfOf":"local:123","depth":3},
        {"kind":"agent","agentId":"account-agent","onBehalfOf":"account"}
    ]);
    queue_legacy_moment(&mut engine, authors.clone());
    engine
        .write_with(&NoFaults, |tx| {
            let (payload, _) =
                crate::outbound::moment_append_payload_in_tx(tx, "ws", "record-moment")?;
            assert_eq!(
                payload["authors"],
                json!([
                    {"kind":"agent","agentId":"agent","depth":2},
                    {"kind":"automation","automationId":"rule","depth":3},
                    {"kind":"agent","agentId":"account-agent","onBehalfOf":"account"}
                ])
            );
            Ok::<_, SyncError>(())
        })
        .unwrap();
    let history = VersionedTextStore::new(&mut engine)
        .get_moment("ws", "record-moment")
        .unwrap()
        .unwrap();
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(history.author_json.as_deref().unwrap()).unwrap(),
        authors
    );
}
