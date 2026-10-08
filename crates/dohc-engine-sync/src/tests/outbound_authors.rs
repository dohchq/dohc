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

#[test]
fn journaled_payload_keeps_public_snapshot_authors_and_omits_private_ones() {
    let human = json!({"kind":"human","humanId":"person","onBehalfOf":"owner"});
    // The relay mints these from the grant it accepted a change under, and
    // this computer keeps them in its own history only.
    let named = json!({"kind":"named","userId":"ana","grantId":"grant","grantGeneration":2});
    let link = json!({"kind":"link","grantId":"grant","grantGeneration":2,"principalId":"holder"});
    let public = json!({"kind":"public","principalId":"holder","grantId":"grant"});
    // A relay-admitted live author snapshot names these. The publishing
    // route decides whether they travel.
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
    let unattributed = json!({"kind":"unattributed"});
    let recipient = json!({"kind":"human","humanId":"recipient","humanName":"Recipient"});
    for (authors, expected) in [
        (json!([unattributed]), Some(json!([unattributed]))),
        (json!([human, unattributed]), Some(json!([unattributed]))),
        (
            json!([unattributed, agent]),
            Some(json!([unattributed, agent])),
        ),
        (
            json!([recipient, unattributed]),
            Some(json!([recipient, unattributed])),
        ),
        (json!([human]), None),
        (json!([named]), None),
        (json!([human, named, link, public]), None),
        (json!([human, agent]), Some(json!([agent]))),
        (json!([agent, named, link]), Some(json!([agent]))),
        (
            json!([snapshot_human, named, snapshot_link, link]),
            Some(json!([snapshot_human, snapshot_link])),
        ),
        (
            json!([snapshot_human, declared]),
            Some(json!([snapshot_human, declared])),
        ),
        (
            json!([snapshot_link, declared]),
            Some(json!([snapshot_link, declared])),
        ),
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
        crate::outbound::omit_private_authors(&mut payload);
        assert_eq!(payload.get("authors"), expected.as_ref());
        assert_eq!(payload["momentId"], "moment");
        let repaired = payload.clone();
        assert!(!crate::outbound::omit_private_authors(&mut payload));
        assert_eq!(payload, repaired);
    }
}

#[test]
fn publishing_route_carries_public_authors_only_for_a_native_live_settlement() {
    let snapshot_human = json!({"kind":"human","humanId":"recipient","humanName":"Recipient"});
    let snapshot_link = json!({"kind":"link","publicPrincipalId":"public_1","label":"Anonymous"});
    let declared = json!({"kind":"agent","agentId":"writer","agentName":"Writer","onBehalfOf":"recipient","depth":1});
    let unattributed = json!({"kind":"unattributed"});
    let named = json!({"kind":"named","userId":"recipient","grantId":"grant","grantGeneration":1});
    let link = json!({"kind":"link","grantId":"grant","grantGeneration":1,"principalId":"holder"});
    let public = json!({"kind":"public","principalId":"holder","grantId":"grant"});
    let authors = json!([snapshot_human, snapshot_link, declared, unattributed]);
    let client = json!([unattributed, declared]);
    let settlement = format!("moment-ydoc-{}", "a".repeat(64));
    for (moment_id, native_settlements, authors, expected) in [
        (settlement.clone(), true, authors.clone(), authors.clone()),
        // Grant authority never travels, not even from the native service.
        (
            settlement.clone(),
            true,
            json!([snapshot_human, named, link, public, declared]),
            json!([snapshot_human, declared]),
        ),
        // An ordinary credential publishes the client rule.
        (settlement.clone(), false, authors.clone(), client.clone()),
        // The relay checks the native settlement ID, so any other moment
        // follows the client rule on the native credential too.
        (
            "record-moment".to_owned(),
            true,
            authors.clone(),
            client.clone(),
        ),
        (
            format!("moment-ydoc-{}", "A".repeat(64)),
            true,
            authors.clone(),
            client.clone(),
        ),
        (
            format!("moment-ydoc-{}", "a".repeat(63)),
            true,
            authors.clone(),
            client.clone(),
        ),
        (
            format!("{settlement}x"),
            true,
            authors.clone(),
            client.clone(),
        ),
    ] {
        let mut payload = json!({"authors": authors, "momentId": moment_id});
        crate::outbound::omit_unpublishable_authors(&mut payload, native_settlements);
        assert_eq!(
            payload["authors"], expected,
            "{moment_id} {native_settlements}"
        );
        let repaired = payload.clone();
        assert!(!crate::outbound::omit_unpublishable_authors(
            &mut payload,
            native_settlements
        ));
        assert_eq!(payload, repaired);
    }
}

fn queue_legacy_moment(engine: &mut EngineStore, authors: serde_json::Value) -> serde_json::Value {
    queue_legacy_moment_as(engine, "record-moment", authors)
}

fn queue_legacy_moment_as(
    engine: &mut EngineStore,
    moment_id: &str,
    authors: serde_json::Value,
) -> serde_json::Value {
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
                moment_id: moment_id.into(),
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
                crate::outbound::moment_append_payload_in_tx(tx, "ws", moment_id)?;
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
        json!([{"kind":"human","humanId":"recipient","humanName":"Recipient"}]),
        json!([{"kind":"human","humanId":"recipient","humanName":"Recipient"},{"kind":"unattributed"}]),
        json!([{"kind":"link","linkId":"link"},{"kind":"named","userId":"recipient"}]),
        json!([{"kind":"human","humanId":"person"},{"kind":"agent","agentId":"agent","onBehalfOf":"owner"}]),
        // A live settlement names the collaborator the relay accepted the
        // edit from. This computer keeps it; the wire carries only the marker.
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
        // The relay's log routes take only a client's own agents and
        // automations, and the exact unattributed marker.
        assert!(
            repaired
                .get("authors")
                .and_then(serde_json::Value::as_array)
                .is_none_or(|authors| authors.iter().all(|author| {
                    matches!(author["kind"].as_str(), Some("agent" | "automation"))
                        || author == &json!({"kind":"unattributed"})
                }))
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
fn service_host_author_repair_keeps_a_live_settlement_public_snapshot() {
    let settlement = format!("moment-ydoc-{}", "a".repeat(64));
    let (_scratch, _path, mut engine) = open_store();
    let public = json!([
        {"kind":"human","humanId":"recipient","humanName":"Recipient"},
        {"kind":"link","publicPrincipalId":"public_1","label":"Anonymous"},
        {"kind":"agent","agentId":"writer","agentName":"Writer","onBehalfOf":"recipient","depth":1},
        {"kind":"unattributed"}
    ]);
    // The grant authority this computer credited stays in its own history.
    let mut authors = public.clone();
    authors.as_array_mut().unwrap().extend([
        json!({"kind":"named","userId":"recipient","grantId":"grant","grantGeneration":1}),
        json!({"kind":"link","grantId":"grant","grantGeneration":1,"principalId":"holder"}),
        json!({"kind":"public","principalId":"holder","grantId":"grant"}),
    ]);
    let legacy = queue_legacy_moment_as(&mut engine, &settlement, authors.clone());
    engine
        .write_with(&NoFaults, |tx| {
            let (payload, _) = crate::outbound::moment_append_payload_in_tx(tx, "ws", &settlement)?;
            assert_eq!(payload["authors"], public);
            Ok::<_, SyncError>(())
        })
        .unwrap();
    let mut ops = list_replication_ops(&engine, "ws", "local", -1, 10).unwrap();
    assert_eq!(ops[1].payload, legacy);
    crate::outbound::repair_queued_moment_authors(&mut engine, &mut ops, &NoFaults, true).unwrap();
    assert_eq!(ops[1].payload["authors"], public);
    assert_eq!(
        list_replication_ops(&engine, "ws", "local", -1, 10).unwrap(),
        ops
    );
    let moment = VersionedTextStore::new(&mut engine)
        .get_moment("ws", &settlement)
        .unwrap()
        .unwrap();
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(moment.author_json.as_deref().unwrap()).unwrap(),
        authors
    );
}

#[test]
fn nameless_account_owner_is_omitted_on_both_lanes_without_changing_history() {
    let owner = json!({"kind":"human","humanId":"8b183289-9c6e-46e9-bc2d-2e08dc144ea2"});
    let recipient = json!({"kind":"human","humanId":"recipient","humanName":"Recipient"});
    // The native lane carries public authors only for a live settlement.
    let settlement = format!("moment-ydoc-{}", "a".repeat(64));
    for native_settlements in [false, true] {
        for authors in [json!([owner]), json!([owner, recipient])] {
            let (_scratch, _path, mut engine) = open_store();
            queue_legacy_moment_as(&mut engine, &settlement, authors.clone());
            engine
                .write_with(&NoFaults, |tx| {
                    let (payload, _) =
                        crate::outbound::moment_append_payload_in_tx(tx, "ws", &settlement)?;
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
                .get_moment("ws", &settlement)
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
            // The relay-admitted snapshot authors wait for the publishing
            // route; this computer's person does not.
            assert_eq!(
                payload["authors"],
                json!([
                    {"kind":"human","humanId":"owner","humanName":"Owner"},
                    {"kind":"link","publicPrincipalId":"public_1","label":"Anonymous"},
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
