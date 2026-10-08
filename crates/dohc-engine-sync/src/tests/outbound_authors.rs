use super::*;
use dohc_engine_domain::WriteText;

#[test]
fn client_author_repair_preserves_work_authors_and_one_exact_marker() {
    let human =
        json!({"kind":"human","humanId":"person","humanName":"Person","onBehalfOf":"owner"});
    let agent =
        json!({"kind":"agent","agentId":"agent","onBehalfOf":"owner","agentRunId":"run","depth":3});
    let automation =
        json!({"kind":"automation","automationId":"rule","onBehalfOf":"owner","depth":4});
    let local_agent = json!({"kind":"agent","agentId":"agent","onBehalfOf":"local:123","agentRunId":"run","depth":3});
    let local_automation =
        json!({"kind":"automation","automationId":"rule","onBehalfOf":"local:456","depth":4});
    let unattributed = json!({"kind":"unattributed"});
    let recipient = json!({"kind":"human","humanId":"recipient","humanName":"Recipient"});
    let owner = json!({"kind":"human","humanId":"local:owner"});
    for (authors, expected) in [
        (json!([unattributed]), Some(json!([unattributed]))),
        (json!([human, unattributed]), Some(json!([unattributed]))),
        (
            json!([unattributed, agent]),
            Some(json!([unattributed, agent])),
        ),
        (
            json!([recipient, unattributed]),
            Some(json!([unattributed])),
        ),
        (json!([recipient]), Some(json!([unattributed]))),
        (
            json!([recipient, agent]),
            Some(json!([unattributed, agent])),
        ),
        (json!([human]), Some(json!([unattributed]))),
        (json!([human, agent]), Some(json!([unattributed, agent]))),
        (json!([owner]), None),
        (
            json!([{"kind":"link","linkId":"link"}]),
            Some(json!([unattributed])),
        ),
        (
            json!([{"kind":"named","userId":"recipient"}]),
            Some(json!([unattributed])),
        ),
        (
            json!([{"kind":"public","name":"Guest"}, recipient, {"kind":"unattributed","name":"stale"}, unattributed]),
            Some(json!([unattributed])),
        ),
        (json!([agent, automation]), Some(json!([agent, automation]))),
        (json!([local_agent]), Some(json!([local_agent]))),
        (json!([local_automation]), Some(json!([local_automation]))),
        (
            json!([human, local_agent, local_automation, agent, automation]),
            Some(json!([
                unattributed,
                local_agent,
                local_automation,
                agent,
                automation
            ])),
        ),
    ] {
        let mut payload = json!({"authors": authors, "momentId":"moment"});
        crate::outbound::omit_client_identity_authors(&mut payload);
        assert_eq!(payload.get("authors"), expected.as_ref());
        assert_eq!(payload["momentId"], "moment");
        let repaired = payload.clone();
        assert!(!crate::outbound::omit_client_identity_authors(&mut payload));
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
fn queued_human_authors_are_durably_repaired_before_push_and_echo() {
    for authors in [
        json!([{"kind":"human","humanId":"person"}]),
        json!([{"kind":"human","humanId":"recipient","humanName":"Recipient"}]),
        json!([{"kind":"human","humanId":"recipient","humanName":"Recipient"},{"kind":"unattributed"}]),
        json!([{"kind":"link","linkId":"link"},{"kind":"named","userId":"recipient"}]),
        json!([{"kind":"human","humanId":"person"},{"kind":"agent","agentId":"agent","onBehalfOf":"owner"}]),
    ] {
        let (_scratch, path, mut engine) = open_store();
        let original_authors = authors.clone();
        let mut expected = queue_legacy_moment(&mut engine, authors);
        crate::outbound::omit_client_identity_authors(&mut expected);
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
        crate::outbound::repair_queued_moment_authors(&mut engine, &mut ops, &NoFaults, false)
            .unwrap(),
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
    let legacy = queue_legacy_moment(
        &mut engine,
        json!([{"kind":"human","humanId":"person","humanName":"Person"}]),
    );
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
    assert_eq!(
        client.transport().pushes.lock().unwrap()[0].ops[1].payload["authors"],
        json!([{"kind":"unattributed"}])
    );
}

#[test]
fn service_host_author_repair_keeps_relay_identities() {
    let (_scratch, _path, mut engine) = open_store();
    let authors = json!([
        {"kind":"human","humanId":"recipient","humanName":"Recipient"},
        {"kind":"public","name":"Guest"},
        {"kind":"named","userId":"recipient"},
        {"kind":"link","linkId":"link"}
    ]);
    let legacy = queue_legacy_moment(&mut engine, authors.clone());
    engine
        .write_with(&NoFaults, |tx| {
            let (payload, _) =
                crate::outbound::moment_append_payload_in_tx(tx, "ws", "record-moment")?;
            assert_eq!(payload["authors"], authors);
            Ok::<_, SyncError>(())
        })
        .unwrap();
    let mut ops = list_replication_ops(&engine, "ws", "local", -1, 10).unwrap();
    crate::outbound::repair_queued_moment_authors(&mut engine, &mut ops, &NoFaults, true).unwrap();
    assert_eq!(ops[1].payload, legacy);
    assert_eq!(
        list_replication_ops(&engine, "ws", "local", -1, 10).unwrap(),
        ops
    );
}

#[test]
fn nameless_account_owner_is_omitted_on_both_lanes_without_changing_history() {
    let owner = json!({"kind":"human","humanId":"8b183289-9c6e-46e9-bc2d-2e08dc144ea2"});
    let recipient = json!({"kind":"human","humanId":"recipient","humanName":"Recipient"});
    for native_settlements in [false, true] {
        for authors in [json!([owner]), json!([owner, recipient])] {
            let (_scratch, _path, mut engine) = open_store();
            queue_legacy_moment(&mut engine, authors.clone());
            engine
                .write_with(&NoFaults, |tx| {
                    let (payload, _) =
                        crate::outbound::moment_append_payload_in_tx(tx, "ws", "record-moment")?;
                    let expected =
                        (authors.as_array().unwrap().len() > 1).then(|| json!([recipient]));
                    assert_eq!(payload.get("authors"), expected.as_ref());
                    Ok::<_, SyncError>(())
                })
                .unwrap();
            let mut ops = list_replication_ops(&engine, "ws", "local", -1, 10).unwrap();
            crate::outbound::repair_queued_moment_authors(
                &mut engine,
                &mut ops,
                &NoFaults,
                native_settlements,
            )
            .unwrap();
            let expected = (authors.as_array().unwrap().len() > 1).then(|| {
                if native_settlements {
                    json!([recipient])
                } else {
                    json!([{"kind":"unattributed"}])
                }
            });
            assert_eq!(ops[1].payload.get("authors"), expected.as_ref());
            assert_eq!(
                list_replication_ops(&engine, "ws", "local", -1, 10).unwrap(),
                ops
            );
            let moment = VersionedTextStore::new(&mut engine)
                .get_moment("ws", "record-moment")
                .unwrap()
                .unwrap();
            assert_eq!(
                serde_json::from_str::<serde_json::Value>(moment.author_json.as_deref().unwrap())
                    .unwrap(),
                authors
            );
        }
    }
}

#[test]
fn new_moment_payload_omits_installation_delegation_without_changing_history() {
    let (_scratch, _path, mut engine) = open_store();
    let authors = json!([
        {"kind":"human","humanId":"local:123"},
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
