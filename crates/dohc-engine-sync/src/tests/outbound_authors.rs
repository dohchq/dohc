use super::*;
use dohc_engine_domain::WriteText;

#[test]
fn solo_typing_journals_the_recorded_account_context() {
    use dohc_engine_domain::{ChangeActorKind, ChangeAttribution};
    let (_scratch, _path, mut engine) = open_store();
    seed_identity(&mut engine);
    let key = dohc_engine_collab::DocKey::new("ws", "main", "doc").unwrap();
    for is_base in [true, false] {
        let payload = crate::ydoc_update_payload(
            &key,
            "doc.md",
            dohc_engine_collab::ContentKind::Richdoc,
            &"a".repeat(64),
            &"b".repeat(64),
            Some("owner-account"),
            Some(&ChangeAttribution {
                actor_kind: ChangeActorKind::Human,
                on_behalf_of: Some("owner-account".into()),
                depth: 0,
                run: None,
            }),
            is_base,
        );
        engine
            .write_with(&NoFaults, |tx| {
                journal_local_op_in_tx(tx, "ws", "ydoc.update", &payload, 2000)
            })
            .unwrap();
    }
    let rows = list_replication_ops(&engine, "ws", "local", 0, 10).unwrap();
    assert_eq!(rows.len(), 2);
    for row in rows {
        assert_eq!(
            row.payload["authorContext"],
            json!({"kind":"account","accountId":"owner-account"})
        );
    }
}

#[test]
fn solo_file_moment_carries_only_its_recorded_local_person() {
    for (authors, expected) in [
        (
            json!([{"kind":"human","humanId":"owner-account"}]),
            json!({"kind":"account","accountId":"owner-account"}),
        ),
        (
            json!([{"kind":"human","humanId":"local:installation"}]),
            serde_json::Value::Null,
        ),
        (
            json!([{"kind":"human","humanId":"recipient","humanName":"Recipient","relayConfirmed":true}]),
            serde_json::Value::Null,
        ),
        (
            json!([{"kind":"human","humanId":"owner-account"},{"kind":"unattributed"}]),
            serde_json::Value::Null,
        ),
        (
            json!([{"kind":"agent","agentId":"writer","onBehalfOf":"owner-account"}]),
            serde_json::Value::Null,
        ),
    ] {
        let (_scratch, _path, mut engine) = open_store();
        queue_fresh_moment_as(&mut engine, "solo-moment", &authors);
        let rows = list_replication_ops(&engine, "ws", "local", 0, 10).unwrap();
        let row = rows
            .iter()
            .find(|row| row.op_kind == "moment.append")
            .unwrap();
        assert_eq!(row.payload["authorContext"], expected, "{authors}");
    }
}

#[test]
fn ordinary_update_context_does_not_infer_a_person_for_declared_work() {
    use dohc_engine_domain::{ChangeActorKind, ChangeAttribution};
    let key = dohc_engine_collab::DocKey::new("ws", "main", "doc").unwrap();
    for (actor, kind) in [
        (Some("local:installation"), ChangeActorKind::Human),
        (None, ChangeActorKind::Human),
        (Some("agent"), ChangeActorKind::Agent),
        (Some("automation"), ChangeActorKind::Automation),
    ] {
        let attribution = ChangeAttribution {
            actor_kind: kind,
            on_behalf_of: Some("owner-account".into()),
            depth: 0,
            run: None,
        };
        let payload = crate::ydoc_update_payload(
            &key,
            "doc.md",
            dohc_engine_collab::ContentKind::Richdoc,
            &"a".repeat(64),
            &"b".repeat(64),
            actor,
            Some(&attribution),
            false,
        );
        assert!(payload.get("authorContext").is_none());
        assert_eq!(
            payload["attribution"],
            serde_json::to_value(attribution).unwrap()
        );
    }
}

#[test]
fn ordinary_push_preserves_imported_device_and_recipient_credit() {
    for (peer, account) in [
        ("another-device", "owner-account"),
        ("recipient-device", "recipient"),
    ] {
        let (_scratch, _path, mut engine) = open_store();
        seed_identity(&mut engine);
        seed_replication_version(&mut engine, "main", "main");
        let doc = dohc_engine_collab::Ydoc::wire();
        doc.plaintext_insert(0, "Peer typing");
        let sha = engine.put_binary_blob(&doc.encode_full_state()).unwrap();
        let mut op = envelope(
            peer,
            0,
            "ydoc.update",
            json!({
                "versionId":"main", "objectId":"peer-doc", "path":"doc.txt", "contentKind":"plaintext",
                "updateBlobSha256":sha, "lineageClaimId":sha, "isBaseState":true,
                "authorContext":{"kind":"account","accountId":account}
            }),
        );
        op.admitted_author_snapshot =
            Some(json!([{"kind":"human","humanId":account,"humanName":"Peer"}]));
        let applied = apply_ydoc_envelope(
            &mut engine,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &op,
            &NoFaults,
            &NoLiveLeases,
        )
        .unwrap();
        assert!(applied.refusals.is_empty());
        let client = RelaySyncClient::new(FakeRelay::default());
        client
            .push_workspace(&mut engine, "ws", &NoFaults, &NoLiveLeases, 3000, 0)
            .unwrap();
        let sent: Vec<_> = client
            .transport()
            .pushed_requests()
            .into_iter()
            .flat_map(|request| request.ops)
            .collect();
        let stored = list_replication_ops(&engine, "ws", peer, -1, 10).unwrap();
        let replay = stored
            .iter()
            .find(|row| row.op_kind == "ydoc.update")
            .unwrap();
        assert_eq!(replay.payload, op.payload);
        assert!(!sent.iter().any(|sent| sent.op_kind == "ydoc.update"));
    }
}

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
            payload
                .as_object_mut()
                .unwrap()
                .remove("attributionUnavailable");
            payload["metadata"]["summary"] = serde_json::Value::Null;
            journal_local_op_in_tx(tx, "ws", "moment.append", &payload, recorded_at_ms)?;
            legacy = payload;
            Ok::<_, SyncError>(())
        })
        .unwrap();
    legacy
}

/// Writes a moment and journals it as the current build does.
fn queue_fresh_moment_as(engine: &mut EngineStore, moment_id: &str, authors: &serde_json::Value) {
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
                author_json: Some(authors.to_string()),
                now_ms: 2000,
                request_id: None,
            },
            &NoFaults,
        )
        .unwrap();
    engine
        .write_with(&NoFaults, |tx| {
            crate::journal_moment_append_in_tx(tx, "ws", moment_id)
        })
        .unwrap();
}

const PRIVATE_AUTHOR_FIELDS: [&str; 5] = [
    r#""named""#,
    r#""public""#,
    "grantId",
    "userId",
    "principalId",
];

/// A fresh journal never publishes the grant authority the relay credited a
/// shared change under. Without a settlement proof, both credentials publish
/// the moment as attribution unavailable, and no private field reaches the
/// wire. A live settlement's moment ID earns no exception. A moment without
/// relay credit keeps its authors.
#[test]
fn a_fresh_journal_publishes_unproved_shared_credit_as_unavailable() {
    let agent = json!({"kind":"agent","agentId":"writer","onBehalfOf":"owner","depth":0});
    let named = json!({"kind":"named","userId":"ana","grantId":"grant","grantGeneration":1});
    let link = json!({"kind":"link","grantId":"grant","grantGeneration":1,"principalId":"holder"});
    let public = json!({"kind":"public","principalId":"holder","grantId":"grant"});
    let person = json!({"kind":"human","humanId":"recipient","humanName":"Recipient"});
    let settlement = format!("moment-ydoc-{}", "a".repeat(64));
    for (moment_id, authors, published) in [
        (settlement.as_str(), json!([agent, named]), None),
        ("record-moment", json!([agent, link]), None),
        (settlement.as_str(), json!([public]), None),
        (settlement.as_str(), json!([person, agent, named]), None),
        // Without relay credit, the authors travel.
        (settlement.as_str(), json!([agent]), Some(json!([agent]))),
    ] {
        for native_settlements in [true, false] {
            let (_scratch, _path, mut engine) = open_store();
            queue_fresh_moment_as(&mut engine, moment_id, &authors);
            let mut ops = list_replication_ops(&engine, "ws", "local", -1, 10).unwrap();
            assert_eq!(ops[1].op_kind, "moment.append");
            let journaled = ops[1].payload.to_string();
            assert!(
                !PRIVATE_AUTHOR_FIELDS
                    .iter()
                    .any(|field| journaled.contains(field))
            );

            crate::outbound::repair_queued_moment_authors(
                &mut engine,
                &mut ops,
                &NoFaults,
                native_settlements,
            )
            .unwrap();
            assert_eq!(
                ops[1].payload.get("authors"),
                published.as_ref(),
                "{moment_id} {native_settlements}"
            );
            assert_eq!(
                ops[1].payload.get("attributionUnavailable").is_some(),
                published.is_none(),
                "{moment_id} {native_settlements}"
            );
            // The wire payload is durable before sending, so an echo matches.
            assert_eq!(
                list_replication_ops(&engine, "ws", "local", -1, 10).unwrap(),
                ops
            );
            let repaired = ops.clone();
            crate::outbound::repair_queued_moment_authors(
                &mut engine,
                &mut ops,
                &NoFaults,
                native_settlements,
            )
            .unwrap();
            assert_eq!(ops, repaired);
            let wire = ops[1].payload.to_string();
            for field in PRIVATE_AUTHOR_FIELDS {
                assert!(!wire.contains(field), "{field} in {wire}");
            }
            let history = VersionedTextStore::new(&mut engine)
                .get_moment("ws", moment_id)
                .unwrap()
                .unwrap();
            if published.is_some() {
                assert_eq!(
                    serde_json::from_str::<serde_json::Value>(
                        history.author_json.as_deref().unwrap()
                    )
                    .unwrap(),
                    authors
                );
            } else {
                assert_eq!(history.author_json, None);
                assert_eq!(
                    history.metadata_summary.as_deref(),
                    Some("Attribution unavailable")
                );
            }
        }
    }
}

/// The unavailable mark a fresh journal gives unproved shared credit is what
/// the relay first received, so a retry after a lost acknowledgement and the
/// relay's echo both match it exactly.
#[test]
fn a_fresh_unavailable_mark_pushes_retries_and_echoes_exactly() {
    let authors = json!([
        {"kind":"agent","agentId":"writer","onBehalfOf":"owner","depth":0},
        {"kind":"named","userId":"ana","grantId":"grant","grantGeneration":1}
    ]);
    let (_scratch, path, mut engine) = open_store();
    queue_fresh_moment_as(&mut engine, "record-moment", &authors);
    let client = RelaySyncClient::new(FakeRelay::default());
    let faults = ScriptedFaults::crash_at(FaultPoint::SyncAfterPushBeforeCursorPersist);
    assert_eq!(
        client
            .push_workspace(&mut engine, "ws", faults.as_ref(), &NoLiveLeases, 2001, 0)
            .unwrap(),
        SyncPassOutcome::CrashedAfterRemoteCommit
    );
    let first = client.transport().pushes.lock().unwrap()[0].ops.clone();
    assert!(first[1].payload.get("authors").is_none());
    assert_eq!(
        first[1].payload["attributionUnavailable"]["reason"],
        "unproven-hosted-authors"
    );
    let wire = first[1].payload.to_string();
    for field in PRIVATE_AUTHOR_FIELDS {
        assert!(!wire.contains(field), "{field} in {wire}");
    }
    drop(engine);
    let mut engine = EngineStore::open(&path, 2002).unwrap();
    assert_eq!(
        list_replication_ops(&engine, "ws", "local", 0, 10).unwrap()[0].payload,
        first[1].payload
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
    let history = VersionedTextStore::new(&mut engine)
        .get_moment("ws", "record-moment")
        .unwrap()
        .unwrap();
    assert_eq!(history.author_json, None);
    assert_eq!(
        history.metadata_summary.as_deref(),
        Some("Attribution unavailable")
    );
}

#[test]
fn queued_human_and_shared_authors_are_durably_repaired_before_push_and_echo() {
    for authors in [
        json!([{"kind":"human","humanId":"person"}]),
        json!([{"kind":"human","humanId":"recipient","humanName":"Recipient"}]),
        json!([{"kind":"link","publicPrincipalId":"recipient","label":"Edit link"}]),
        json!([{"kind":"human","humanId":"recipient","humanName":"Recipient"},{"kind":"unattributed"}]),
        json!([{"kind":"link","linkId":"link"},{"kind":"named","userId":"recipient"}]),
        json!([{"kind":"human","humanId":"person"},{"kind":"agent","agentId":"agent","onBehalfOf":"owner"}]),
        // Without a settlement proof, the grant authority a shared change was
        // accepted under, and a relay-admitted snapshot, mark the moment unavailable.
        json!([{"kind":"named","userId":"ana","grantId":"grant","grantGeneration":1}]),
        json!([{"kind":"agent","agentId":"agent","onBehalfOf":"owner"},{"kind":"link","grantId":"grant","grantGeneration":1,"principalId":"holder"}]),
        json!([{"kind":"human","humanId":"owner","humanName":"Owner"},{"kind":"agent","agentId":"writer","onBehalfOf":"owner","depth":0}]),
        json!([{"kind":"link","publicPrincipalId":"public_1","label":"Anonymous"},{"kind":"agent","agentId":"writer","agentName":"Writer"}]),
    ] {
        let (_scratch, path, mut engine) = open_store();
        let original_authors = authors.clone();
        let mut expected = queue_legacy_moment(&mut engine, authors);
        crate::outbound::mark_unproven_hosted_authors(&mut expected);
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
        if expected.get("attributionUnavailable").is_some() {
            assert_eq!(history.author_json, None);
            assert_eq!(
                history.metadata_summary.as_deref(),
                Some("Attribution unavailable")
            );
        } else {
            assert_eq!(
                serde_json::from_str::<serde_json::Value>(history.author_json.as_deref().unwrap())
                    .unwrap(),
                original_authors
            );
        }
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
        serde_json::Value::Null
    );
    assert_eq!(
        client.transport().pushes.lock().unwrap()[0].ops[1].payload["attributionUnavailable"]["reason"],
        "unproven-hosted-authors"
    );
}

#[test]
fn service_host_author_repair_refuses_unproved_relay_identities() {
    // Even a native live settlement carries relay identities only with a proof.
    let settlement = format!("moment-ydoc-{}", "a".repeat(64));
    let (_scratch, _path, mut engine) = open_store();
    let public = json!([
        {"kind":"human","humanId":"recipient","humanName":"Recipient"},
        {"kind":"link","publicPrincipalId":"public_1","label":"Anonymous"},
        {"kind":"agent","agentId":"writer","agentName":"Writer","onBehalfOf":"recipient","depth":1},
        {"kind":"unattributed"}
    ]);
    // The grant authority this computer credited beside the public snapshot.
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
            assert!(payload.get("authors").is_none());
            assert_eq!(
                payload["attributionUnavailable"]["reason"],
                "unproven-hosted-authors"
            );
            Ok::<_, SyncError>(())
        })
        .unwrap();
    let mut ops = list_replication_ops(&engine, "ws", "local", -1, 10).unwrap();
    assert_eq!(ops[1].payload, legacy);
    crate::outbound::repair_queued_moment_authors(&mut engine, &mut ops, &NoFaults, true).unwrap();
    let mut expected = legacy;
    crate::outbound::mark_unproven_hosted_authors(&mut expected);
    assert_eq!(ops[1].payload, expected);
    assert_eq!(
        list_replication_ops(&engine, "ws", "local", -1, 10).unwrap(),
        ops
    );
    let moment = VersionedTextStore::new(&mut engine)
        .get_moment("ws", &settlement)
        .unwrap()
        .unwrap();
    assert_eq!(moment.author_json, None);
    assert_eq!(
        moment.metadata_summary.as_deref(),
        Some("Attribution unavailable")
    );
}

fn assert_unproven_authors_marked_before_first_push(authors: serde_json::Value) {
    for native_settlements in [false, true] {
        let (_scratch, path, mut engine) = open_store();
        queue_legacy_moment(&mut engine, authors.clone());
        engine
            .write_with(&NoFaults, |tx| {
                let (payload, _) =
                    crate::outbound::moment_append_payload_in_tx(tx, "ws", "record-moment")?;
                assert!(payload.get("authors").is_none());
                assert_eq!(
                    payload["attributionUnavailable"]["reason"],
                    "unproven-hosted-authors"
                );
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
        assert!(ops[1].payload.get("authors").is_none());
        assert_eq!(
            ops[1].payload["attributionUnavailable"]["reason"],
            "unproven-hosted-authors"
        );
        drop(engine);
        let mut engine = EngineStore::open(&path, 2001).unwrap();
        assert_eq!(
            list_replication_ops(&engine, "ws", "local", -1, 10).unwrap(),
            ops
        );
        let moment = VersionedTextStore::new(&mut engine)
            .get_moment("ws", "record-moment")
            .unwrap()
            .unwrap();
        assert_eq!(moment.author_json, None);
        assert_eq!(
            moment.metadata_summary.as_deref(),
            Some("Attribution unavailable")
        );
        let client = RelaySyncClient::new(FakeRelay::default());
        client
            .push_workspace(&mut engine, "ws", &NoFaults, &NoLiveLeases, 2002, 0)
            .unwrap();
        let pushed = client.transport().pushes.lock().unwrap()[0].ops.clone();
        assert_eq!(pushed, ops);
        *client.transport().pull.lock().unwrap() = Some(PullResponse {
            ops: pushed,
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
                2003,
            )
            .expect("the first repaired push must have an exact own echo");
    }
}

#[test]
fn nameless_account_human_keeps_agent_coauthors_for_relay_stamping() {
    let account = "8b183289-9c6e-46e9-bc2d-2e08dc144ea2";
    let agent = json!({"kind":"agent","agentId":"agent","onBehalfOf":account,"agentRunId":"run"});
    let authors = json!([{"kind":"human","humanId":account}, agent]);
    let mut payload = json!({"authors":authors,"metadata":{"origin":"api","summary":"Edited"}});
    let original = payload.clone();
    assert!(!crate::outbound::mark_unproven_hosted_authors(&mut payload));
    assert_eq!(payload, original);
    assert!(crate::outbound::omit_local_person_authors(&mut payload));
    assert_eq!(payload["authors"], json!([agent]));
    assert!(payload.get("attributionUnavailable").is_none());
    assert_eq!(payload["metadata"]["summary"], "Edited");

    for native_settlements in [false, true] {
        let (_scratch, _path, mut engine) = open_store();
        queue_legacy_moment(&mut engine, authors.clone());
        engine
            .write_with(&NoFaults, |tx| {
                let (payload, _) =
                    crate::outbound::moment_append_payload_in_tx(tx, "ws", "record-moment")?;
                assert_eq!(payload["authors"], json!([agent]));
                assert!(payload.get("attributionUnavailable").is_none());
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
        assert_eq!(ops[1].payload["authors"], json!([agent]));
        assert!(ops[1].payload.get("attributionUnavailable").is_none());
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
        assert_eq!(moment.metadata_summary, None);
    }
}

#[test]
fn recipient_with_empty_relay_name_is_marked_before_first_push() {
    assert_unproven_authors_marked_before_first_push(json!([
        {"kind":"human","humanId":"8b183289-9c6e-46e9-bc2d-2e08dc144ea2","humanName":""}
    ]));
}

#[test]
fn unlabelled_link_is_marked_before_first_push() {
    for author in [
        json!({"kind":"link","publicPrincipalId":"recipient"}),
        json!({"kind":"link","grantId":"grant","grantGeneration":2,"principalId":"holder"}),
    ] {
        assert_unproven_authors_marked_before_first_push(json!([author]));
    }
}

#[test]
fn public_and_named_authors_are_marked_before_first_push() {
    for author in [
        json!({"kind":"public","principalId":"holder","grantId":"grant"}),
        json!({"kind":"named","userId":"recipient","grantId":"grant","grantGeneration":1}),
    ] {
        assert_unproven_authors_marked_before_first_push(json!([author]));
    }
}

#[test]
fn both_lanes_keep_nameless_local_history_and_remove_unproved_hosted_history() {
    let owner = json!({"kind":"human","humanId":"local:8b183289-9c6e-46e9-bc2d-2e08dc144ea2"});
    let recipient = json!({"kind":"human","humanId":"recipient","humanName":"Recipient"});
    // Even a native live settlement carries relay identities only with a proof.
    let settlement = format!("moment-ydoc-{}", "a".repeat(64));
    for native_settlements in [false, true] {
        for authors in [json!([owner]), json!([owner, recipient])] {
            let (_scratch, _path, mut engine) = open_store();
            queue_legacy_moment_as(&mut engine, &settlement, authors.clone());
            engine
                .write_with(&NoFaults, |tx| {
                    let (payload, _) =
                        crate::outbound::moment_append_payload_in_tx(tx, "ws", &settlement)?;
                    assert!(payload.get("authors").is_none());
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
            assert!(ops[1].payload.get("authors").is_none());
            if authors.as_array().unwrap().len() > 1 {
                assert_eq!(
                    ops[1].payload["attributionUnavailable"]["reason"],
                    "unproven-hosted-authors"
                );
            }
            assert_eq!(
                list_replication_ops(&engine, "ws", "local", -1, 10).unwrap(),
                ops
            );
            let moment = VersionedTextStore::new(&mut engine)
                .get_moment("ws", &settlement)
                .unwrap()
                .unwrap();
            if authors.as_array().unwrap().len() > 1 {
                assert_eq!(moment.author_json, None);
                assert_eq!(
                    moment.metadata_summary.as_deref(),
                    Some("Attribution unavailable")
                );
            } else {
                assert_eq!(
                    serde_json::from_str::<serde_json::Value>(
                        moment.author_json.as_deref().unwrap()
                    )
                    .unwrap(),
                    authors
                );
            }
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
