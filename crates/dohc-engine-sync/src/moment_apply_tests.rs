use dohc_engine_collab::{ContentKind as YdocContentKind, DocKey, LeaseRegistry, Regime, Ydoc};
use dohc_engine_domain::{
    CreateNamedVersion, ListMomentsQuery, MomentOp, RollbackTextFileMutation, VersionedTextStore,
    WriteText,
};
use dohc_engine_storage::{EngineStore, NoFaults, hex_sha256, put_binary_blob};
use dohc_engine_testkit::{ScratchDir, engine_db_path};
use rusqlite::{OptionalExtension, params};
use serde_json::{Value, json};

use crate::{
    ApplyDisposition, ApplyOutcome, NoLiveLeases, RefusalReason, ReplicationEnvelope,
    ReplicationRefusal, SyncError, apply_replication_envelope, apply_ydoc_envelope,
    read_replication_acked_seq,
};

fn test_store() -> (ScratchDir, EngineStore) {
    let scratch = ScratchDir::new().expect("scratch");
    let path = engine_db_path(&scratch).expect("db path");
    let mut store = EngineStore::open(&path, 1_000).expect("store");
    VersionedTextStore::new(&mut store)
        .ensure_main_version("ws", "main", 1_000, &NoFaults)
        .expect("main version");
    (scratch, store)
}

fn apply_moment_envelope(
    store: &mut EngineStore,
    envelope: &ReplicationEnvelope,
    faults: &dyn dohc_engine_storage::FaultInjector,
) -> Result<ApplyOutcome<i64>, SyncError> {
    crate::apply_moment_envelope(store, envelope, faults, &NoLiveLeases)
}

fn envelope(origin: &str, seq: i64, workspace_id: &str, payload: Value) -> ReplicationEnvelope {
    ReplicationEnvelope {
        settlement_admission: None,
        admitted_author_snapshot: None,
        workspace_id: workspace_id.to_owned(),
        origin_id: origin.to_owned(),
        origin_seq: seq,
        op_kind: "moment.append".to_owned(),
        payload,
        recorded_at_ms: 2_000 + seq,
        relay_seq: None,
    }
}

fn text_sha(text: &str) -> String {
    hex_sha256(text.as_bytes())
}

#[test]
fn imported_live_moment_preserves_public_author_snapshots() {
    for mut author in [
        json!({"kind":"unattributed"}),
        json!({"kind":"human", "humanId":"recipient", "humanName":"Recipient"}),
        json!({"kind":"link", "publicPrincipalId":"public-recipient", "label":"Edit link participant"}),
    ] {
        let (_scratch, mut store) = test_store();
        hydrate_texts(&mut store, &["record fields"]);
        let payload = with_author(
            absent_text_payload("live-settlement", "record", "record.md", "record fields"),
            author.clone(),
        );
        let mut op = envelope("native-service", 0, "ws", payload);
        if author["kind"] != "unattributed" {
            op.payload.as_object_mut().unwrap().remove("authors");
            op.payload["settlementReference"] = json!({"record": {
                "settlementId": "settlement", "momentId": "live-settlement",
                "binding": {"workspaceId": "ws"}
            }});
            op.relay_seq = Some(1);
            op.settlement_admission = Some(crate::SettlementAdmission::Accepted {
                settlement_id: "settlement".into(),
            });
            op.admitted_author_snapshot = Some(json!([author]));
        }
        assert!(matches!(
            apply_moment_envelope(&mut store, &op, &NoFaults)
                .unwrap()
                .primary,
            ApplyDisposition::Applied(_)
        ));
        let actual: String = store.read_with(|conn| conn.query_row(
            "SELECT author_json FROM moments WHERE workspace_id='ws' AND moment_id='live-settlement'", [], |row| row.get(0))).unwrap();
        if author["kind"] == "human" {
            author["relayConfirmed"] = json!(true);
        }
        assert_eq!(
            serde_json::from_str::<Value>(&actual).unwrap(),
            json!([author])
        );
    }
}

/// An older build captured Finder's `.DS_Store`. Its moment there applies as
/// nothing, without a refusal, and the origin's next moment still applies.
#[test]
fn an_older_peers_moment_at_an_ignored_path_applies_as_nothing() {
    let (_scratch, mut store) = test_store();
    hydrate_texts(&mut store, &["finder", "notes"]);
    let ignored = envelope(
        "older-peer",
        0,
        "ws",
        absent_text_payload("ds-store", "finder", ".DS_Store", "finder"),
    );
    assert!(matches!(
        apply_moment_envelope(&mut store, &ignored, &NoFaults).unwrap(),
        ApplyOutcome {
            primary: ApplyDisposition::Applied(0),
            ref refusals,
            ..
        } if refusals.is_empty()
    ));
    let next = envelope(
        "older-peer",
        1,
        "ws",
        absent_text_payload("notes", "notes", "notes.md", "notes"),
    );
    assert!(matches!(
        apply_moment_envelope(&mut store, &next, &NoFaults)
            .unwrap()
            .primary,
        ApplyDisposition::Applied(_)
    ));
    let ignored_rows: i64 = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT (SELECT COUNT(*) FROM path_aliases WHERE path='.DS_Store') \
                 + (SELECT COUNT(*) FROM moments WHERE moment_id='ds-store')",
                [],
                |row| row.get(0),
            )
        })
        .unwrap();
    assert_eq!(ignored_rows, 0);
}

#[test]
fn client_declared_human_cannot_preserve_relay_confirmation() {
    let (_scratch, mut store) = test_store();
    hydrate_texts(&mut store, &["local fields"]);
    let payload = with_author(
        absent_text_payload("local-settlement", "record", "record.md", "local fields"),
        json!({"kind":"human","humanId":"recipient","relayConfirmed":true}),
    );
    let op = envelope("local-device", 0, "ws", payload);
    assert!(matches!(
        apply_moment_envelope(&mut store, &op, &NoFaults)
            .unwrap()
            .primary,
        ApplyDisposition::Applied(_)
    ));
    let actual: String = store.read_with(|conn| conn.query_row(
        "SELECT author_json FROM moments WHERE workspace_id='ws' AND moment_id='local-settlement'", [], |row| row.get(0))).unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&actual).unwrap(),
        json!([{"kind":"human","humanId":"recipient"}])
    );
}

#[test]
fn maximum_live_author_summary_journals_with_payload_headroom() {
    let (_scratch, mut store) = test_store();
    crate::adopt_join_identity(&mut store, "ws", "source", "epoch", "stream", 1, &NoFaults)
        .expect("identity");
    let mut authors = dohc_engine_collab::author_coverage::Authors::default();
    let field = dohc_engine_domain::MAX_AUTHOR_FIELD_BYTES;
    for index in 0..dohc_engine_collab::author_coverage::MAX_INTERVAL_AUTHORS {
        let id = format!("{index:04}{}", "\"".repeat(field - 4));
        let entry = dohc_engine_domain::moment_author_json(
            Some(&id),
            Some(&dohc_engine_domain::ChangeAttribution {
                actor_kind: dohc_engine_domain::ChangeActorKind::Automation,
                on_behalf_of: Some("\"".repeat(field)),
                depth: dohc_engine_domain::MAX_CHANGE_ATTRIBUTION_DEPTH,
                run: None,
            }),
        )
        .expect("entry");
        let mut next = dohc_engine_collab::author_coverage::Authors::default();
        next.union_json(&authors.json()).expect("prior authors");
        next.union_json(&entry).expect("bounded entry");
        if next.journal_bytes() > dohc_engine_domain::MAX_AUTHOR_JSON_BYTES {
            break;
        }
        authors = next;
    }
    let author_json = authors.json();
    assert!(
        author_json.len()
            > dohc_engine_domain::MAX_AUTHOR_JSON_BYTES
                - dohc_engine_domain::MAX_AUTHOR_ENTRY_BYTES
                - 1
    );
    VersionedTextStore::new(&mut store)
        .write_text(
            &WriteText {
                workspace_id: "ws".into(),
                version_id: "main".into(),
                object_id: "author-limit".into(),
                path: "authors.md".into(),
                text: "all authors".into(),
                moment_id: "limit-moment".into(),
                metadata_origin: "ydoc".into(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: Some(author_json),
                now_ms: 2,
                request_id: None,
            },
            &NoFaults,
        )
        .expect("maximum author moment");
    store
        .write_with(&NoFaults, |tx| {
            crate::journal_moment_append_in_tx(tx, "ws", "limit-moment")
        })
        .expect("maximum author moment journals");
    let bytes: i64 = store.read_with(|conn| conn.query_row(
        "SELECT length(CAST(payload_json AS BLOB)) FROM replication_log WHERE op_kind='moment.append'",
        [], |row| row.get(0),
    ).map_err(dohc_engine_storage::StorageError::persist_public)).expect("payload bytes");
    assert!(bytes < crate::MAX_PAYLOAD_JSON_BYTES as i64);
    assert!(crate::MAX_PAYLOAD_JSON_BYTES as i64 - bytes > 120 * 1024);
}

#[test]
fn outbound_moment_authors_keep_local_people_and_replicate_agents_and_automations() {
    use dohc_engine_domain::{ChangeActorKind, ChangeAttribution, moment_author_json};
    for kind in [
        ChangeActorKind::Human,
        ChangeActorKind::Agent,
        ChangeActorKind::Automation,
    ] {
        for principal in [None, Some("owner")] {
            let (_source_scratch, mut source) = test_store();
            let (_peer_scratch, mut peer) = test_store();
            crate::adopt_join_identity(
                &mut source,
                "ws",
                "source",
                "epoch",
                "stream",
                1,
                &NoFaults,
            )
            .expect("source identity");
            let author = moment_author_json(
                Some(if kind == ChangeActorKind::Human {
                    "local:creator"
                } else {
                    "creator"
                }),
                Some(&ChangeAttribution {
                    actor_kind: kind,
                    on_behalf_of: principal.map(str::to_owned),
                    depth: if kind == ChangeActorKind::Automation {
                        4
                    } else {
                        0
                    },
                    run: None,
                }),
            )
            .expect("declared creator");
            VersionedTextStore::new(&mut source)
                .write_text(
                    &WriteText {
                        workspace_id: "ws".to_owned(),
                        version_id: "main".to_owned(),
                        object_id: "record-object".to_owned(),
                        path: "tasks/record.md".to_owned(),
                        text: "created by a live document".to_owned(),
                        moment_id: "created-moment".to_owned(),
                        metadata_origin: "ydoc".to_owned(),
                        metadata_summary: None,
                        metadata_correlation_id: None,
                        author_json: Some(author.clone()),
                        now_ms: 2_000,
                        request_id: None,
                    },
                    &NoFaults,
                )
                .expect("source moment");
            source
                .write_with(&NoFaults, |tx| {
                    crate::outbound::journal_moment_append_in_tx(tx, "ws", "created-moment")
                })
                .expect("journal source moment");
            let op = source
                .read_with(|conn| {
                    conn.query_row(
                        "SELECT workspace_id, origin_id, origin_seq, op_kind, payload_json, recorded_at_ms \
                         FROM replication_log WHERE workspace_id='ws' AND imported=0",
                        [],
                        |row| {
                            let payload: String = row.get(4)?;
                            Ok(ReplicationEnvelope {
                                settlement_admission: None,
                                admitted_author_snapshot: None,
                                workspace_id: row.get(0)?,
                                origin_id: row.get(1)?,
                                origin_seq: row.get(2)?,
                                op_kind: row.get(3)?,
                                payload: serde_json::from_str(&payload).expect("journal JSON"),
                                recorded_at_ms: row.get(5)?,
                                relay_seq: None,
                            })
                        },
                    )
                })
                .expect("read outbound journal");
            let local_history = VersionedTextStore::new(&mut source)
                .get_moment("ws", "created-moment")
                .unwrap()
                .unwrap();
            assert_eq!(local_history.author_json.as_deref(), Some(author.as_str()));
            assert!(op.payload.get("attributionUnavailable").is_none());
            if kind == ChangeActorKind::Human {
                assert!(op.payload.get("authors").is_none());
            } else {
                assert_eq!(
                    op.payload["authors"],
                    serde_json::from_str::<Value>(&author).unwrap()
                );
            }
            hydrate_texts(&mut peer, &["created by a live document"]);
            assert_eq!(
                apply_moment_envelope(&mut peer, &op, &NoFaults).expect("peer apply"),
                ApplyOutcome::new(ApplyDisposition::Applied(0)),
                "{kind:?}, principal {principal:?}",
            );
            let history = VersionedTextStore::new(&mut peer)
                .get_moment("ws", "created-moment")
                .expect("peer history")
                .expect("replicated moment");
            if kind == ChangeActorKind::Human {
                assert!(history.author_json.is_none());
            } else {
                assert_eq!(
                    serde_json::from_str::<Value>(history.author_json.as_deref().unwrap()).unwrap(),
                    serde_json::from_str::<Value>(&author).unwrap(),
                );
            }
        }
    }
}

/// An agent run an automation started names its chain depth on the moments
/// it writes, and a peer keeps it in history.
#[test]
fn a_peer_keeps_the_depth_an_agent_moment_names() {
    let author = json!({
        "kind": "agent",
        "agentId": "dohc-chat-runner",
        "onBehalfOf": "owner",
        "agentRunId": "run-woken",
        "depth": 3,
    });
    let (_scratch, mut peer) = test_store();
    let mut payload = absent_text_payload("woken", "object", "doc.md", "content");
    payload["authors"] = json!([author]);
    hydrate_texts(&mut peer, &["content"]);
    assert_eq!(
        apply_moment_envelope(&mut peer, &envelope("source", 0, "ws", payload), &NoFaults)
            .expect("peer apply"),
        ApplyOutcome::new(ApplyDisposition::Applied(0)),
    );
    let history = VersionedTextStore::new(&mut peer)
        .get_moment("ws", "woken")
        .expect("peer history")
        .expect("replicated moment");
    assert_eq!(
        serde_json::from_str::<Value>(history.author_json.as_deref().expect("author")).unwrap(),
        json!([author]),
    );
}

/// A second owner device imports a settled live moment through ordinary sync.
/// Its History keeps the name the snapshot declared for the agent, after a
/// restart too. A name outside the snapshot's bounds applies as none.
#[test]
fn an_owner_device_keeps_a_declared_agent_name_through_import_and_restart() {
    let agent = json!({
        "kind": "agent",
        "agentId": "trip-agent-hosted",
        "onBehalfOf": "owner",
        "depth": 1,
    });
    let longest = "n".repeat(dohc_engine_domain::MAX_AUTHOR_FIELD_BYTES);
    let over = format!("{longest}n");
    for (name, kept) in [
        (json!("Trip helper"), true),
        (json!(longest), true),
        (json!(over), false),
        (json!(""), false),
        (json!("Trip\nhelper"), false),
        (Value::Null, false),
        (json!(42), false),
    ] {
        let (scratch, mut device) = test_store();
        let mut declared = agent.clone();
        declared["agentName"] = name.clone();
        let mut payload = absent_text_payload("settled", "object", "trip.md", "content");
        payload["authors"] = json!([declared]);
        hydrate_texts(&mut device, &["content"]);
        assert_eq!(
            apply_moment_envelope(
                &mut device,
                &envelope("owner-a", 0, "ws", payload),
                &NoFaults
            )
            .expect("owner device import"),
            ApplyOutcome::new(ApplyDisposition::Applied(0)),
            "name {name}",
        );
        let expected = json!([if kept { declared } else { agent.clone() }]);
        let history_authors = |store: &mut EngineStore| {
            let page = VersionedTextStore::new(store)
                .list_moments(&ListMomentsQuery {
                    workspace_id: "ws".to_owned(),
                    version_id: Some("main".to_owned()),
                    object_id: Some("object".to_owned()),
                    limit: 10,
                    before_moment_order: None,
                })
                .expect("History");
            let moment = page.moments.first().expect("imported moment");
            serde_json::from_str::<Value>(moment.author_json.as_deref().expect("authors"))
                .expect("author JSON")
        };
        assert_eq!(history_authors(&mut device), expected, "name {name}");
        drop(device);
        let path = engine_db_path(&scratch).expect("db path");
        let mut restarted = EngineStore::open(&path, 1_000).expect("reopen store");
        assert_eq!(
            history_authors(&mut restarted),
            expected,
            "restarted {name}"
        );
    }
}

#[test]
fn a_peer_applies_pre_upgrade_control_character_authors() {
    let authors = json!([
        {"kind":"agent", "agentId":"old\nagent", "onBehalfOf":"old\u{0085}person"},
        {"kind":"human", "humanId":"old\u{0085}human"}
    ]);
    let (_scratch, mut peer) = test_store();
    let mut payload = absent_text_payload("legacy-authors", "object", "doc.md", "content");
    payload["authors"] = authors.clone();
    hydrate_texts(&mut peer, &["content"]);
    assert_eq!(
        apply_moment_envelope(&mut peer, &envelope("source", 0, "ws", payload), &NoFaults)
            .expect("peer applies legacy authors"),
        ApplyOutcome::new(ApplyDisposition::Applied(0)),
    );
    let history = VersionedTextStore::new(&mut peer)
        .get_moment("ws", "legacy-authors")
        .expect("peer history")
        .expect("moment");
    assert_eq!(
        serde_json::from_str::<Value>(history.author_json.as_deref().expect("authors"))
            .expect("author JSON"),
        authors
    );
}

/// An older computer stored an agent author with any depth it was given, 0
/// included. A newer peer applies the moment, reads such a depth as none in
/// its history, and keeps the replicated payload exactly as it arrived.
#[test]
fn a_peer_imports_an_older_computers_agent_moment_with_an_unchecked_depth() {
    for depth in [json!(0), json!(65), json!("3")] {
        let (_scratch, mut peer) = test_store();
        let mut payload = absent_text_payload("older", "object", "doc.md", "content");
        payload["authors"] = json!([{
            "kind": "agent",
            "agentId": "claude-code",
            "onBehalfOf": "owner",
            "depth": depth,
        }]);
        let op = envelope("older-peer", 0, "ws", payload);
        hydrate_texts(&mut peer, &["content"]);
        assert_eq!(
            apply_moment_envelope(&mut peer, &op, &NoFaults).expect("peer apply"),
            ApplyOutcome::new(ApplyDisposition::Applied(0)),
            "depth {depth}",
        );
        let history = VersionedTextStore::new(&mut peer)
            .get_moment("ws", "older")
            .expect("peer history")
            .expect("replicated moment");
        assert_eq!(
            serde_json::from_str::<Value>(history.author_json.as_deref().expect("author")).unwrap(),
            json!([{"kind": "agent", "agentId": "claude-code", "onBehalfOf": "owner"}]),
            "depth {depth}",
        );
        let kept: String = peer
            .read_with(|conn| {
                conn.query_row(
                    "SELECT payload_json FROM replication_log \
                     WHERE workspace_id = 'ws' AND origin_id = 'older-peer'",
                    [],
                    |row| row.get(0),
                )
            })
            .expect("replicated payload");
        assert_eq!(serde_json::from_str::<Value>(&kept).unwrap(), op.payload);
    }
}

#[test]
fn declared_moment_authors_refuse_a_null_empty_or_non_string_principal() {
    for author in [
        json!({"kind":"human", "humanId":"creator"}),
        json!({"kind":"agent", "agentId":"creator"}),
        json!({"kind":"automation", "automationId":"creator", "depth":4}),
    ] {
        for principal in [Value::Null, json!(""), json!(42)] {
            let (_scratch, mut peer) = test_store();
            let mut payload = absent_text_payload("bad-author", "object", "doc.md", "content");
            let mut author = author.clone();
            author["onBehalfOf"] = principal.clone();
            payload["authors"] = json!([author]);
            hydrate_texts(&mut peer, &["content"]);
            let result =
                apply_moment_envelope(&mut peer, &envelope("source", 0, "ws", payload), &NoFaults)
                    .expect("refusal is recorded");
            assert!(
                matches!(result.primary, ApplyDisposition::Refused(_)),
                "{author}, principal {principal}",
            );
            assert_eq!(peer.table_row_count("moments").unwrap(), 0);
            assert_eq!(peer.table_row_count("snapshots").unwrap(), 0);
        }
    }
}

#[test]
fn owner_binding_read_failure_does_not_acknowledge_moment() {
    let (_scratch, mut store) = test_store();
    hydrate_texts(&mut store, &["remote text"]);
    let op = envelope(
        "remote",
        0,
        "ws",
        absent_text_payload("remote-moment", "object", "owner.md", "remote text"),
    );
    store
        .read_with(|conn| {
            conn.execute_batch(
                "ALTER TABLE ydoc_owner_bindings \
                 RENAME COLUMN binding_json TO unavailable_binding_json",
            )
        })
        .unwrap();

    assert!(matches!(
        apply_moment_envelope(&mut store, &op, &NoFaults),
        Err(SyncError::Storage(_))
    ));
    assert_eq!(
        read_replication_acked_seq(&store, "ws", "remote").unwrap(),
        -1
    );
    for table in [
        "replication_log",
        "replication_pending_refusals",
        "moments",
        "snapshots",
    ] {
        assert_eq!(store.table_row_count(table).unwrap(), 0, "{table}");
    }

    store
        .read_with(|conn| {
            conn.execute_batch(
                "ALTER TABLE ydoc_owner_bindings \
                 RENAME COLUMN unavailable_binding_json TO binding_json",
            )
        })
        .unwrap();
    assert_eq!(
        apply_moment_envelope(&mut store, &op, &NoFaults).unwrap(),
        ApplyOutcome::new(ApplyDisposition::Applied(0))
    );
    assert_eq!(
        read_replication_acked_seq(&store, "ws", "remote").unwrap(),
        0
    );
    assert_eq!(store.table_row_count("moments").unwrap(), 1);
    assert_eq!(store.table_row_count("snapshots").unwrap(), 1);
    assert_eq!(
        store
            .table_row_count("replication_pending_refusals")
            .unwrap(),
        0
    );
}

#[test]
fn moment_only_record_write_and_undo_each_keep_their_field_history() {
    let (_scratch, mut store) = test_store();
    seed_text_moment(
        &mut store,
        "schema",
        "tasks/collection.yaml",
        "fields: {}\n",
        "schema",
        None,
        true,
    );
    let initial_text = "# Task\n";
    seed_text_moment(
        &mut store,
        "record",
        "tasks/task.md",
        initial_text,
        "initial",
        None,
        true,
    );
    store
        .write_with(&NoFaults, |tx| {
            dohc_engine_domain::reconcile_collections_in_tx(tx, "ws", "main")
        })
        .unwrap();
    let record_id: String = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT record_id FROM collection_records WHERE object_id='record'",
                [],
                |row| row.get(0),
            )
        })
        .unwrap();
    let written = format!("---\nid: {record_id}\nFinished on: 2026-10-05\n---\n# Task\n");
    let undone = format!("---\nid: {record_id}\nFinished on: null\n---\n# Task\n");
    hydrate_texts(&mut store, &[&written, &undone]);
    let write = envelope(
        "peer",
        0,
        "ws",
        present_text_payload(
            "written",
            "record",
            "write",
            "tasks/task.md",
            "tasks/task.md",
            initial_text,
            "initial",
            &written,
        ),
    );
    let undo = envelope(
        "peer",
        1,
        "ws",
        present_text_payload(
            "undone",
            "record",
            "write",
            "tasks/task.md",
            "tasks/task.md",
            &written,
            "written",
            &undone,
        ),
    );
    for op in [&write, &undo] {
        let result =
            crate::apply_moment_envelope_detailed(&mut store, op, &NoFaults, &NoLiveLeases)
                .unwrap();
        let ApplyDisposition::Applied(result) = result.primary else {
            panic!("moment-only field change must apply")
        };
        let facts = result.record_facts.unwrap();
        assert_eq!(facts.source, Some(("peer".into(), op.origin_seq)));
        assert_eq!(facts.fields.len(), 1);
        assert_eq!(facts.fields[0].field_name, "Finished on");
    }
    let history = store
        .read_with(|conn| {
            let mut stmt = conn.prepare(
                "SELECT previous_value_json,next_value_json,source_origin_id,source_origin_seq \
             FROM collection_field_history WHERE record_id=?1 ORDER BY history_id",
            )?;
            stmt.query_map([&record_id], |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()
        })
        .unwrap();
    assert_eq!(
        history,
        vec![
            (None, Some("\"2026-10-05\"".into()), "peer".into(), 0),
            (
                Some("\"2026-10-05\"".into()),
                Some("null".into()),
                "peer".into(),
                1
            ),
        ]
    );
    assert_eq!(store.table_row_count("ydoc_updates").unwrap(), 0);
    assert_eq!(
        apply_moment_envelope(&mut store, &undo, &NoFaults).unwrap(),
        ApplyOutcome::new(ApplyDisposition::Skipped)
    );
    assert_eq!(
        store.table_row_count("collection_field_history").unwrap(),
        2
    );
}

#[test]
fn observed_owner_imports_old_settlements_without_rewinding_accepted_state_or_pending_draft() {
    observed_owner_settlement_scenario(OwnerSettlementFields::NoCollection);
}

#[test]
fn observed_owner_settlement_keeps_one_history_row_for_an_accepted_field_write() {
    observed_owner_settlement_scenario(OwnerSettlementFields::Write);
}

#[test]
fn observed_owner_settlement_completes_adoption_without_reindexing_field_changes() {
    observed_owner_settlement_scenario(OwnerSettlementFields::Undo);
}

#[test]
fn observed_owner_settlements_keep_both_changes_when_a_field_returns_to_its_initial_value() {
    observed_owner_settlement_scenario(OwnerSettlementFields::TwoChanges(["A", "B", "A"]));
}

#[test]
fn observed_owner_settlements_keep_two_changes_to_one_field_between_settlements() {
    observed_owner_settlement_scenario(OwnerSettlementFields::TwoChanges(["A", "B", "C"]));
}

#[test]
fn observed_owner_first_enrollment_records_a_checkpoint_field_change_once() {
    observed_owner_settlement_scenario(OwnerSettlementFields::Enrollment);
}

enum OwnerSettlementFields {
    NoCollection,
    Write,
    Undo,
    TwoChanges([&'static str; 3]),
    Enrollment,
}

fn observed_owner_settlement_scenario(fields: OwnerSettlementFields) {
    let with_collection = !matches!(fields, OwnerSettlementFields::NoCollection);
    let undo_field = matches!(fields, OwnerSettlementFields::Undo);
    let enroll_field_change = matches!(fields, OwnerSettlementFields::Enrollment);
    let field_values = match fields {
        OwnerSettlementFields::TwoChanges(values) => Some(values),
        _ => None,
    };
    use dohc_engine_collab::live_object_binding::LiveObjectBinding;
    use dohc_engine_collab::owner_outbox::{
        OwnerOutboxLimits,
        accepted::{OwnerAcceptedFrameInput, apply_frame_in_tx},
        draft::{
            ObservedOwnerBinding, append_draft_in_tx, install_observed_binding_in_tx, open_draft_in,
        },
    };
    let (scratch, mut store) = test_store();
    crate::adopt_join_identity(&mut store, "ws", "local", "epoch", "stream", 1, &NoFaults).unwrap();
    let fixture: Value = serde_json::from_str(include_str!(
        "../../dohc-engine-collab/tests/owner-source/owner-source-seed.json"
    ))
    .unwrap();
    let mut original: Vec<u8> = serde_json::from_value(fixture["bytes"].clone()).unwrap();
    let mut initial_text = fixture["markdown"].as_str().unwrap().to_owned();
    if let Some(values) = field_values {
        let initial = Ydoc::wire();
        initial.apply(&original).unwrap();
        initial.frontmatter_set("Finished on", values[0]).unwrap();
        original = initial.encode_full_state();
        initial_text = initial.project(YdocContentKind::Richdoc).unwrap().content;
    }
    let initial_text = initial_text.as_str();
    let initial_moment = format!("moment-ydoc-{}", "a".repeat(64));
    seed_text_moment(
        &mut store,
        "object",
        "tasks/owner.md",
        initial_text,
        &initial_moment,
        None,
        true,
    );
    let record_id = if with_collection {
        seed_text_moment(
            &mut store,
            "schema",
            "tasks/collection.yaml",
            "fields: {}\n",
            "schema",
            None,
            true,
        );
        seed_text_moment(
            &mut store,
            "collection-other",
            "tasks/other.md",
            "# Other\n",
            "other",
            None,
            true,
        );
        store
            .write_with(&NoFaults, |tx| {
                dohc_engine_domain::reconcile_collections_in_tx(tx, "ws", "main")
            })
            .unwrap();
        let record_id: String = store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT record_id FROM collection_records WHERE object_id='object'",
                    [],
                    |row| row.get(0),
                )
            })
            .unwrap();
        Some(record_id)
    } else {
        None
    };
    let adoption_state = |store: &EngineStore, object: &str| -> String {
        store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT adoption_state FROM collection_records WHERE object_id=?1",
                    [object],
                    |row| row.get(0),
                )
            })
            .unwrap()
    };
    if with_collection {
        assert_eq!(adoption_state(&store, "object"), "pending-lossless");
    }
    let key = DocKey::new("ws", "main", "object").unwrap();
    dohc_engine_collab::claim_base(
        &mut store,
        &key,
        YdocContentKind::Richdoc,
        &original,
        &NoFaults,
        2,
    )
    .unwrap();
    store
        .read_with(|conn| conn.execute("UPDATE ydoc_docs SET path='tasks/owner.md'", []))
        .unwrap();
    let doc = store
        .read_with(|conn| dohc_engine_collab::load_doc_in(conn, &key))
        .unwrap();
    let checkpoint = doc.encode_full_state();
    let mut observed = ObservedOwnerBinding {
        binding: LiveObjectBinding {
            workspace_id: "ws".into(),
            main_version_id: "main".into(),
            object_id: "object".into(),
            lineage_claim_id: hex_sha256(&original),
            current_path: "tasks/owner.md".into(),
            selector_paths: vec!["tasks/owner.md".into()],
            restore_fence_generation: 0,
        },
        relay_database_namespace: "relay".into(),
        revision: 1,
        accepted_cursor: 0,
        native_head_sequence: store
            .read_with(|conn| dohc_engine_collab::read_marker_in(conn, &key))
            .unwrap()
            .unwrap()
            .head_update_seq,
        checkpoint_digest: hex_sha256(&checkpoint),
        limits: OwnerOutboxLimits {
            max_pending_bytes: 1_000_000,
            max_pending_age_ms: 60_000,
        },
    };
    if enroll_field_change {
        doc.frontmatter_set("Finished on", "2026-10-05").unwrap();
        let enrolled = enroll_restore(&mut store, &observed.binding, &doc, 0, &observed.limits);
        observed.revision = enrolled.revision;
        observed.native_head_sequence = enrolled.native_head_sequence;
        store.read_with(|conn| {
            let row = conn.query_row("SELECT previous_value_json,next_value_json,source_origin_id,source_origin_seq FROM collection_field_history WHERE field_name='Finished on'", [], |row| Ok((row.get::<_, Option<String>>(0)?, row.get::<_, Option<String>>(1)?, row.get::<_, Option<String>>(2)?, row.get::<_, Option<i64>>(3)?)))?;
            assert_eq!(row, (None, Some("\"2026-10-05\"".into()), None, None));
            assert_eq!(conn.query_row("SELECT count(*) FROM collection_field_history WHERE field_name='Finished on'", [], |row| row.get::<_, i64>(0))?, 1);
            Ok::<_, rusqlite::Error>(())
        }).unwrap();
    } else {
        store
            .write_with(&NoFaults, |tx| {
                install_observed_binding_in_tx(tx, "ws", &observed, &checkpoint)
            })
            .unwrap();
    }
    let mut texts = Vec::new();
    for (index, text) in ["first accepted edit", "second accepted edit"]
        .iter()
        .enumerate()
    {
        let before = doc.encode_state_vector();
        if index == 0 {
            if let Some(record_id) = &record_id {
                doc.frontmatter_set("id", record_id).unwrap();
            }
        }
        if with_collection && (index == 0 || undo_field || field_values.is_some()) {
            doc.frontmatter_set_value(
                "Finished on",
                if let Some(values) = field_values {
                    json!(values[index + 1])
                } else if index == 0 {
                    json!("2026-10-05")
                } else {
                    Value::Null
                },
            )
            .unwrap();
        }
        doc.richdoc_append_paragraph(text);
        let update = doc.diff(&before).unwrap();
        let result = store
            .write_with(&NoFaults, |tx| {
                apply_frame_in_tx(
                    tx,
                    "ws",
                    &OwnerAcceptedFrameInput {
                        binding: observed.binding.clone(),
                        relay_database_namespace: "relay".into(),
                        expected_revision: observed.revision,
                        expected_native_head_sequence: observed.native_head_sequence,
                        previous_accepted_cursor: observed.accepted_cursor,
                        journal_cursor: index as i64 + 1,
                        update_bytes: update.clone(),
                    },
                    index as i64 + 3,
                )
            })
            .unwrap();
        let dohc_engine_storage::TxnOutcome::Committed(result) = result else {
            panic!("frame must commit")
        };
        observed.revision = result.revision;
        observed.native_head_sequence = result.native_head_sequence;
        observed.accepted_cursor = result.accepted_cursor;
        texts.push(doc.project(YdocContentKind::Richdoc).unwrap().content);
    }
    let field_history = |store: &EngineStore| {
        store.read_with(|conn| {
            let mut stmt = conn.prepare(
                "SELECT history_id,previous_value_json,next_value_json,source_origin_id,source_origin_seq \
                 FROM collection_field_history WHERE workspace_id='ws' AND version_id='main' \
                   AND field_name='Finished on' ORDER BY history_id",
            )?;
            stmt.query_map([], |row| Ok((
                row.get::<_, i64>(0)?, row.get::<_, Option<String>>(1)?,
                row.get::<_, Option<String>>(2)?, row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<i64>>(4)?,
            )))?.collect::<Result<Vec<_>, _>>()
        }).unwrap()
    };
    let accepted_history = field_history(&store);
    if with_collection {
        assert_eq!(
            accepted_history.len(),
            if undo_field || field_values.is_some() {
                2
            } else {
                1
            }
        );
        if let Some(values) = field_values {
            for (index, row) in accepted_history.iter().enumerate() {
                assert_eq!(row.1, Some(serde_json::to_string(values[index]).unwrap()));
                assert_eq!(
                    row.2,
                    Some(serde_json::to_string(values[index + 1]).unwrap())
                );
            }
        } else {
            assert_eq!(accepted_history[0].1, None);
            assert_eq!(accepted_history[0].2.as_deref(), Some("\"2026-10-05\""));
        }
        if undo_field {
            assert_eq!(accepted_history[1].1.as_deref(), Some("\"2026-10-05\""));
            assert_eq!(accepted_history[1].2.as_deref(), Some("null"));
        }
    }
    let accepted_bytes = doc.encode_full_state();
    let pending_update = doc.richdoc_append_paragraph("private pending owner edit");
    store
        .write_with(&NoFaults, |tx| {
            append_draft_in_tx(
                tx,
                "ws",
                &observed.binding,
                observed.revision,
                "pending".into(),
                pending_update.clone(),
                5,
            )
        })
        .unwrap();
    let pending_bytes = doc.encode_full_state();
    hydrate_texts(&mut store, &[&texts[0], &texts[1]]);
    let old_id = format!("moment-ydoc-{}", "b".repeat(64));
    let latest_id = format!("moment-ydoc-{}", "c".repeat(64));
    let retain_audit = |store: &EngineStore, id: &str, text: &str, cursor: i64| {
        // The audit parser is covered separately. Seed its committed output,
        // with no accepted events to credit, to isolate ordinary moment
        // admission against native owner state.
        let binding = serde_json::to_string(&observed.binding).unwrap();
        let record = format!(
            "{{\"momentId\":{},\"relayDatabaseNamespace\":\"relay\",\"binding\":{},\"previousCursor\":{cursor},\"terminalCursor\":{cursor},\"acceptedEventCount\":0,\"acceptedIntervalDigest\":\"{}\"}}",
            serde_json::to_string(id).unwrap(),
            binding,
            "0".repeat(64)
        );
        store.read_with(|conn| conn.execute("INSERT INTO live_audit_settlements(settlement_id,workspace_id,record_digest,record_json,markdown_digest) VALUES (?1,'ws',?2,?3,?4)", params![id, hex_sha256(record.as_bytes()), record, text_sha(text)])).unwrap();
    };
    retain_audit(&store, &old_id, &texts[0], 1);
    retain_audit(&store, &latest_id, &texts[1], 2);
    let old = envelope(
        "host",
        0,
        "ws",
        present_text_payload(
            &old_id,
            "object",
            "write",
            "tasks/owner.md",
            "tasks/owner.md",
            initial_text,
            &initial_moment,
            &texts[0],
        ),
    );
    let latest = envelope(
        "host",
        1,
        "ws",
        present_text_payload(
            &latest_id,
            "object",
            "write",
            "tasks/owner.md",
            "tasks/owner.md",
            &texts[0],
            &old_id,
            &texts[1],
        ),
    );
    let before = snapshot(&store, "object");
    let log_count = store.table_row_count("replication_log").unwrap();
    let moment_count = store.table_row_count("moments").unwrap();
    // Malformed local binding data must not permanently refuse a valid settlement.
    store
        .read_with(|conn| conn.execute("UPDATE ydoc_owner_bindings SET binding_json='{}'", []))
        .unwrap();
    assert!(matches!(
        apply_moment_envelope(&mut store, &old, &NoFaults),
        Err(SyncError::Storage(_))
    ));
    assert_eq!(
        read_replication_acked_seq(&store, "ws", "host").unwrap(),
        -1
    );
    assert_eq!(store.table_row_count("replication_log").unwrap(), log_count);
    assert_eq!(store.table_row_count("moments").unwrap(), moment_count);
    assert_eq!(
        store
            .table_row_count("replication_pending_refusals")
            .unwrap(),
        0
    );
    assert_eq!(snapshot(&store, "object"), before);
    assert_eq!(field_history(&store), accepted_history);
    store
        .read_with(|conn| {
            conn.execute(
                "UPDATE ydoc_owner_bindings SET binding_json=?1",
                [serde_json::to_string(&observed.binding).unwrap()],
            )
        })
        .unwrap();
    let old_result =
        crate::apply_moment_envelope_detailed(&mut store, &old, &NoFaults, &NoLiveLeases).unwrap();
    assert!(
        matches!(old_result.primary, ApplyDisposition::Applied(ref result) if result.materialization_changes.is_empty() && result.conflicts_opened == 0)
    );
    assert_eq!(snapshot(&store, "object"), before);
    if with_collection {
        assert_eq!(field_history(&store), accepted_history);
        assert_eq!(adoption_state(&store, "object"), "pending-lossless");
    }
    assert_eq!(
        store
            .read_with(|conn| conn.query_row(
                "SELECT sync_record_only FROM moments WHERE moment_id=?1",
                [&old_id],
                |row| row.get::<_, i64>(0)
            ))
            .unwrap(),
        1
    );
    // An open owner editor does not defer the host's settlement, but a
    // settlement at the accepted cursor must still equal accepted state.
    let mismatch_text = "a settlement the host never accepted";
    hydrate_texts(&mut store, &[mismatch_text]);
    let mismatch_id = format!("moment-ydoc-{}", "f".repeat(64));
    retain_audit(&store, &mismatch_id, mismatch_text, 2);
    let mismatch = envelope(
        "mismatch",
        0,
        "ws",
        present_text_payload(
            &mismatch_id,
            "object",
            "write",
            "tasks/owner.md",
            "tasks/owner.md",
            &texts[0],
            &old_id,
            mismatch_text,
        ),
    );
    assert!(matches!(
        crate::apply_moment_envelope(&mut store, &mismatch, &NoFaults, &crate::AlwaysLive)
            .unwrap()
            .primary,
        ApplyDisposition::Refused(_)
    ));
    assert_eq!(snapshot(&store, "object"), before);
    let latest_result =
        crate::apply_moment_envelope_detailed(&mut store, &latest, &NoFaults, &crate::AlwaysLive)
            .unwrap();
    assert!(
        matches!(latest_result.primary, ApplyDisposition::Applied(ref result)
        if result.conflicts_opened == 0 && result.record_facts.is_none())
    );
    assert_eq!(field_history(&store), accepted_history);
    if with_collection {
        assert_eq!(adoption_state(&store, "object"), "adopted");
        assert_eq!(
            adoption_state(&store, "collection-other"),
            "pending-lossless"
        );
    }
    assert_eq!(
        store
            .read_with(|conn| conn.query_row(
                "SELECT blob_sha256 FROM snapshots WHERE object_id='object'",
                [],
                |row| row.get::<_, String>(0)
            ))
            .unwrap(),
        text_sha(&texts[1])
    );
    assert_eq!(
        store
            .read_with(|conn| dohc_engine_collab::load_doc_in(conn, &key))
            .unwrap()
            .encode_full_state(),
        accepted_bytes
    );
    assert_eq!(
        store
            .read_with(|conn| open_draft_in(conn, &observed.binding, observed.revision))
            .unwrap()
            .doc
            .encode_full_state(),
        pending_bytes
    );
    assert_eq!(store.table_row_count("conflicts").unwrap(), 0);
    assert_eq!(read_replication_acked_seq(&store, "ws", "host").unwrap(), 1);
    assert_eq!(
        apply_moment_envelope(&mut store, &old, &NoFaults).unwrap(),
        ApplyOutcome::new(ApplyDisposition::Skipped)
    );
    if with_collection {
        // Enrollment records the restore before a later accepted field edit
        // can advance the index and make the restore settlement history-only.
        let restored = store
            .read_with(|conn| dohc_engine_collab::load_doc_in(conn, &key))
            .unwrap();
        restored
            .frontmatter_set("Finished on", "2026-11-01")
            .unwrap();
        let restored_text = restored.project(YdocContentKind::Richdoc).unwrap().content;
        let restored_binding = dohc_engine_collab::live_object_binding::LiveObjectBinding {
            restore_fence_generation: 1,
            ..observed.binding.clone()
        };
        let advanced = enroll_restore(
            &mut store,
            &restored_binding,
            &restored,
            3,
            &observed.limits,
        );
        let restored_history = field_history(&store);
        assert_eq!(restored_history.len(), accepted_history.len() + 1);
        let before_frame = restored.encode_state_vector();
        restored.frontmatter_set("Status", "Done").unwrap();
        let latest_restored_text = restored.project(YdocContentKind::Richdoc).unwrap().content;
        store
            .write_with(&NoFaults, |tx| {
                apply_frame_in_tx(
                    tx,
                    "ws",
                    &OwnerAcceptedFrameInput {
                        binding: restored_binding.clone(),
                        relay_database_namespace: "relay".into(),
                        expected_revision: advanced.revision,
                        expected_native_head_sequence: advanced.native_head_sequence,
                        previous_accepted_cursor: advanced.accepted_cursor,
                        journal_cursor: 4,
                        update_bytes: restored.diff(&before_frame).unwrap(),
                    },
                    6,
                )
            })
            .unwrap();
        assert_eq!(field_history(&store), restored_history);
        hydrate_texts(&mut store, &[&restored_text]);
        let restored_id = format!("moment-ydoc-{}", "e".repeat(64));
        retain_restore_audit(
            &store,
            &restored_binding,
            "relay",
            &restored_id,
            &restored_text,
            3,
        );
        let restore = envelope(
            "restore-host",
            0,
            "ws",
            present_text_payload(
                &restored_id,
                "object",
                "write",
                "tasks/owner.md",
                "tasks/owner.md",
                &texts[1],
                &latest_id,
                &restored_text,
            ),
        );
        let result = crate::apply_moment_envelope_detailed(
            &mut store,
            &restore,
            &NoFaults,
            &crate::AlwaysLive,
        )
        .unwrap();
        assert!(
            matches!(result.primary, ApplyDisposition::Applied(ref result)
            if result.record_facts.is_none())
        );
        hydrate_texts(&mut store, &[&latest_restored_text]);
        let latest_restored_id = format!("moment-ydoc-{}", "1".repeat(64));
        retain_restore_audit(
            &store,
            &restored_binding,
            "relay",
            &latest_restored_id,
            &latest_restored_text,
            4,
        );
        let latest_restore = envelope(
            "restore-host",
            1,
            "ws",
            present_text_payload(
                &latest_restored_id,
                "object",
                "write",
                "tasks/owner.md",
                "tasks/owner.md",
                &restored_text,
                &restored_id,
                &latest_restored_text,
            ),
        );
        assert!(matches!(
            apply_moment_envelope(&mut store, &latest_restore, &NoFaults)
                .unwrap()
                .primary,
            ApplyDisposition::Applied(_)
        ));
        let history = field_history(&store);
        assert_eq!(history, restored_history);
        assert_eq!(history.len(), accepted_history.len() + 1);
        let last = history.last().unwrap();
        assert_eq!(last.1, accepted_history.last().unwrap().2);
        assert_eq!(last.2.as_deref(), Some("\"2026-11-01\""));
        assert_eq!(last.3, None);
        assert_eq!(last.4, None);
        let status_history = store.read_with(|conn| {
            let mut stmt = conn.prepare("SELECT previous_value_json,next_value_json FROM collection_field_history WHERE field_name='Status' ORDER BY history_id")?;
            stmt.query_map([], |row| Ok((row.get::<_, Option<String>>(0)?, row.get::<_, Option<String>>(1)?)))?.collect::<Result<Vec<_>, _>>()
        }).unwrap();
        assert_eq!(status_history, vec![(None, Some("\"Done\"".into()))]);
        return;
    }
    let renamed = envelope(
        "renamed",
        0,
        "ws",
        present_text_payload(
            &format!("moment-ydoc-{}", "d".repeat(64)),
            "object",
            "rename",
            "tasks/owner.md",
            "moved.md",
            &texts[1],
            &latest_id,
            &texts[1],
        ),
    );
    // Any other change to an open document still waits for its editor.
    assert!(matches!(
        crate::apply_moment_envelope(&mut store, &renamed, &NoFaults, &crate::AlwaysLive),
        Err(SyncError::RetryableState {
            reason: "ydoc-session-live"
        })
    ));
    assert!(matches!(
        apply_moment_envelope(&mut store, &renamed, &NoFaults)
            .unwrap()
            .primary,
        ApplyDisposition::Refused(_)
    ));
    assert_eq!(
        store
            .read_with(|conn| open_draft_in(conn, &observed.binding, observed.revision))
            .unwrap()
            .doc
            .encode_full_state(),
        pending_bytes
    );

    let future = Ydoc::wire();
    future.apply(&accepted_bytes).unwrap();
    let future_update = future.richdoc_append_paragraph("accepted after ordinary pull");
    let future_text = future.project(YdocContentKind::Richdoc).unwrap().content;
    hydrate_texts(&mut store, &[&future_text]);
    let future_id = format!("moment-ydoc-{}", "e".repeat(64));
    retain_audit(&store, &future_id, &future_text, 3);
    let future_moment = envelope(
        "host",
        2,
        "ws",
        present_text_payload(
            &future_id,
            "object",
            "write",
            "tasks/owner.md",
            "tasks/owner.md",
            &texts[1],
            &latest_id,
            &future_text,
        ),
    );
    hydrate_texts(&mut store, &["unrelated ordinary file"]);
    let unrelated = envelope(
        "host",
        3,
        "ws",
        absent_text_payload(
            "unrelated",
            "unrelated",
            "other.md",
            "unrelated ordinary file",
        ),
    );
    // So does an open document without an owner binding. Its own origin keeps
    // the host's sequence out of it: host seq 2 has not arrived yet.
    let unbound = ReplicationEnvelope {
        origin_id: "unbound".into(),
        origin_seq: 0,
        ..unrelated.clone()
    };
    assert!(matches!(
        crate::apply_moment_envelope(&mut store, &unbound, &NoFaults, &crate::AlwaysLive),
        Err(SyncError::RetryableState {
            reason: "ydoc-session-live"
        })
    ));
    let client = crate::RelaySyncClient::new(crate::tests::FakeRelay::default());
    *client.transport().pull.lock().unwrap() = Some(crate::PullResponse {
        ops: vec![future_moment.clone(), unrelated],
        next_cursor: 2,
        has_more: false,
    });
    let mut cache = dohc_engine_collab::WriterDocCache::default();
    let pulled = client
        .pull_chat_workspace(&mut store, &mut cache, "ws", &NoFaults, &NoLiveLeases, 7)
        .unwrap();
    let crate::SyncPassOutcome::Complete {
        pending_cursor: Some(waiting_cursor),
        changed_paths,
        has_more,
        ..
    } = pulled
    else {
        panic!("pull must complete");
    };
    assert!(!has_more);
    assert_eq!(changed_paths.len(), 1);
    assert_eq!(changed_paths[0].path, "other.md");
    assert_eq!(read_replication_acked_seq(&store, "ws", "host").unwrap(), 3);
    let mut collision = future_moment.clone();
    collision.origin_id = "collision".into();
    collision.origin_seq = 0;
    assert!(matches!(
        apply_moment_envelope(&mut store, &collision, &NoFaults)
            .unwrap()
            .primary,
        ApplyDisposition::Refused(_)
    ));
    assert_eq!(
        store.table_row_count("owner_pending_settlements").unwrap(),
        1
    );
    let waiting =
        crate::moment_apply::pending::drain_and_claim(&mut store, "ws", &NoFaults, &NoLiveLeases)
            .unwrap();
    assert!(waiting.report_id.is_none());
    assert!(!waiting.has_more);
    assert!(waiting.changes.is_empty());
    // Advancing ordinary sync and reopening must preserve the waiting row.
    crate::commit_relay_cursor(
        &mut store,
        "ws",
        &waiting_cursor,
        &NoFaults,
        &crate::NoLiveLeases,
        7,
    )
    .unwrap();
    assert_eq!(
        store.table_row_count("owner_pending_settlements").unwrap(),
        1
    );
    drop(store);
    let mut store = EngineStore::open(&engine_db_path(&scratch).unwrap(), 8).unwrap();
    assert_eq!(read_replication_acked_seq(&store, "ws", "host").unwrap(), 3);
    assert_eq!(
        crate::read_relay_cursor(&store, "ws")
            .unwrap()
            .unwrap()
            .cursor,
        2
    );
    let result = store
        .write_with(&NoFaults, |tx| {
            apply_frame_in_tx(
                tx,
                "ws",
                &OwnerAcceptedFrameInput {
                    binding: observed.binding.clone(),
                    relay_database_namespace: "relay".into(),
                    expected_revision: observed.revision,
                    expected_native_head_sequence: observed.native_head_sequence,
                    previous_accepted_cursor: observed.accepted_cursor,
                    journal_cursor: 3,
                    update_bytes: future_update.clone(),
                },
                6,
            )
        })
        .unwrap();
    let dohc_engine_storage::TxnOutcome::Committed(result) = result else {
        panic!("frame must commit")
    };
    // The parked settlement no longer waits for the owner's open editor. It
    // writes accepted state only; the pending draft stays out of the file.
    let leased = crate::moment_apply::pending::drain_and_claim(
        &mut store,
        "ws",
        &NoFaults,
        &crate::AlwaysLive,
    )
    .unwrap();
    assert_eq!(leased.changes.len(), 1);
    assert_eq!(leased.changes[0].path, "tasks/owner.md");
    assert!(leased.report_id.is_some());
    assert!(!leased.has_more);
    assert_eq!(
        store
            .read_with(|conn| conn.query_row(
                "SELECT blob_sha256 FROM snapshots WHERE object_id='object'",
                [],
                |row| row.get::<_, String>(0)
            ))
            .unwrap(),
        text_sha(&future_text)
    );
    *client.transport().pull.lock().unwrap() = Some(crate::PullResponse {
        ops: vec![],
        next_cursor: 2,
        has_more: false,
    });
    let caught_up = client
        .pull_chat_workspace(&mut store, &mut cache, "ws", &NoFaults, &NoLiveLeases, 8)
        .unwrap();
    let crate::SyncPassOutcome::Complete {
        pending_cursor: Some(mut applied_cursor),
        changed_paths: settled_changes,
        has_more,
        ..
    } = caught_up
    else {
        panic!("empty pull must publish");
    };
    assert!(!has_more);
    assert_eq!(settled_changes.len(), 1);
    assert_eq!(settled_changes[0].path, "tasks/owner.md");
    assert!(applied_cursor.settlement_report_id.is_some());
    assert_eq!(
        store
            .read_with(|conn| conn.query_row(
                "SELECT blob_sha256 FROM snapshots WHERE object_id='object'",
                [],
                |row| row.get::<_, String>(0)
            ))
            .unwrap(),
        text_sha(&future_text)
    );
    future.apply(&pending_update).unwrap();
    assert_eq!(
        store
            .read_with(|conn| open_draft_in(conn, &observed.binding, result.revision))
            .unwrap()
            .doc
            .encode_full_state(),
        future.encode_full_state()
    );
    // Crash after apply, before materialization/cursor commit: the next empty
    // pull reclaims the same disk decision. A stale cursor cannot delete it.
    drop(store);
    let mut store = EngineStore::open(&engine_db_path(&scratch).unwrap(), 9).unwrap();
    let replay =
        crate::moment_apply::pending::drain_and_claim(&mut store, "ws", &NoFaults, &NoLiveLeases)
            .unwrap();
    assert_eq!(replay.changes, settled_changes);
    assert_ne!(replay.report_id, applied_cursor.settlement_report_id);
    crate::commit_relay_cursor(
        &mut store,
        "ws",
        &applied_cursor,
        &NoFaults,
        &crate::NoLiveLeases,
        10,
    )
    .unwrap();
    assert_eq!(
        store.table_row_count("owner_pending_settlements").unwrap(),
        1
    );
    applied_cursor.settlement_report_id = replay.report_id;
    crate::commit_relay_cursor(
        &mut store,
        "ws",
        &applied_cursor,
        &NoFaults,
        &crate::NoLiveLeases,
        11,
    )
    .unwrap();
    assert_eq!(
        store.table_row_count("owner_pending_settlements").unwrap(),
        0
    );
    assert_eq!(
        store
            .table_row_count("owner_pending_settlement_blobs")
            .unwrap(),
        0
    );
}

#[test]
fn restore_settlement_imported_before_the_owner_reaches_its_generation_waits_then_materializes() {
    use dohc_engine_collab::live_object_binding::LiveObjectBinding;
    let RestoreOwner {
        _scratch,
        mut store,
        observed,
        checkpoint,
        initial_text,
        initial_moment,
    } = restore_owner();
    let (restored, restored_text) = restored_host(&checkpoint, "restored by the owner");
    let next = LiveObjectBinding {
        restore_fence_generation: 1,
        ..observed.binding.clone()
    };
    let retain_audit =
        |store: &EngineStore,
         binding: &LiveObjectBinding,
         namespace: &str,
         id: &str,
         text: &str| { retain_restore_audit(store, binding, namespace, id, text, 1) };
    let settlement = |origin: &str, id: &str, text: &str| {
        restore_settlement(origin, id, &initial_text, &initial_moment, text)
    };
    let before = snapshot(&store, "object");

    // Only an audited settlement of the owner's own document at a later
    // restore generation is a reason to wait. Anything else is still refused.
    let changed = |change: fn(&mut LiveObjectBinding)| {
        let mut binding = next.clone();
        change(&mut binding);
        binding
    };
    let same_generation = LiveObjectBinding {
        selector_paths: vec!["owner.md".into(), "other.md".into()],
        ..observed.binding.clone()
    };
    // Each payload names the restored text; only the audit differs.
    let other_text = "a restore with other content";
    let restored_audit = restored_text.as_str();
    let cases = vec![
        ("unaudited", None),
        (
            "same-generation",
            Some((same_generation, "relay", restored_audit)),
        ),
        (
            "other-path",
            Some((
                changed(|b| b.current_path = "moved.md".into()),
                "relay",
                restored_audit,
            )),
        ),
        (
            "other-lineage",
            Some((
                changed(|b| b.lineage_claim_id = "f".repeat(64)),
                "relay",
                restored_audit,
            )),
        ),
        (
            "other-workspace",
            Some((
                changed(|b| b.workspace_id = "other".into()),
                "relay",
                restored_audit,
            )),
        ),
        (
            "other-namespace",
            Some((next.clone(), "other-relay", restored_audit)),
        ),
        ("other-digest", Some((next.clone(), "relay", other_text))),
    ];
    hydrate_texts(&mut store, &[&restored_text, other_text]);
    for (index, (origin, audit)) in cases.into_iter().enumerate() {
        let id = format!("moment-ydoc-{index}{}", "1".repeat(63));
        if let Some((binding, namespace, audited)) = audit {
            retain_audit(&store, &binding, namespace, &id, audited);
        }
        assert!(
            matches!(
                apply_moment_envelope(
                    &mut store,
                    &settlement(origin, &id, &restored_text),
                    &NoFaults
                )
                .unwrap()
                .primary,
                ApplyDisposition::Refused(_)
            ),
            "{origin} must be refused"
        );
    }
    assert_eq!(
        store.table_row_count("owner_pending_settlements").unwrap(),
        0
    );
    assert_eq!(snapshot(&store, "object"), before);

    // Ordinary sync imports the restore's settlement before the authenticated
    // owner feed reaches generation 1. It waits instead of being refused.
    let restore_id = format!("moment-ydoc-{}", "b".repeat(64));
    retain_audit(&store, &next, "relay", &restore_id, &restored_text);
    // A settlement the host never accepted waits on the same binding.
    let forged_text = "a restore the host never accepted";
    hydrate_texts(&mut store, &[forged_text]);
    let forged_id = format!("moment-ydoc-{}", "c".repeat(64));
    retain_audit(&store, &next, "relay", &forged_id, forged_text);
    for (origin, id, text) in [
        ("host", &restore_id, restored_text.as_str()),
        ("forged", &forged_id, forged_text),
    ] {
        assert_eq!(
            apply_moment_envelope(&mut store, &settlement(origin, id, text), &NoFaults).unwrap(),
            ApplyOutcome::new(ApplyDisposition::Applied(0))
        );
    }
    let parked: Vec<String> = store
        .read_with(|conn| {
            conn.prepare("SELECT binding_json FROM owner_pending_settlements ORDER BY origin_id")?
                .query_map([], |row| row.get(0))?
                .collect()
        })
        .unwrap();
    assert_eq!(parked, vec![serde_json::to_string(&next).unwrap(); 2]);
    assert_eq!(snapshot(&store, "object"), before);
    let waiting =
        crate::moment_apply::pending::drain_and_claim(&mut store, "ws", &NoFaults, &NoLiveLeases)
            .unwrap();
    assert!(waiting.report_id.is_none());
    assert!(waiting.changes.is_empty());
    assert_eq!(snapshot(&store, "object"), before);

    // The authenticated owner feed reaches the restore generation.
    let advanced = enroll_restore(&mut store, &next, &restored, 1, &observed.limits);
    assert_eq!(
        (advanced.binding, advanced.accepted_cursor),
        (next.clone(), 1)
    );

    // The replay repeats every check against the authenticated binding: the
    // restore reaches the file, and audit alone never authorizes content.
    let settled =
        crate::moment_apply::pending::drain_and_claim(&mut store, "ws", &NoFaults, &NoLiveLeases)
            .unwrap();
    assert_eq!(settled.changes.len(), 1);
    assert_eq!(settled.changes[0].path, "owner.md");
    assert_eq!(
        snapshot(&store, "object").map(|(_, _, digest, moment)| (digest, moment)),
        Some((text_sha(&restored_text), restore_id.clone()))
    );
    assert_eq!(disposition(&store, "forged").as_deref(), Some("refused"));
    assert_ne!(disposition(&store, "host").as_deref(), Some("refused"));
}

#[test]
fn restore_settlement_skipped_by_a_later_generation_is_refused_and_released() {
    use dohc_engine_collab::live_object_binding::LiveObjectBinding;
    let RestoreOwner {
        _scratch,
        mut store,
        observed,
        checkpoint,
        initial_text,
        initial_moment,
    } = restore_owner();
    let generation = |restore_fence_generation| LiveObjectBinding {
        restore_fence_generation,
        ..observed.binding.clone()
    };
    let (_, skipped_text) = restored_host(&checkpoint, "restored at generation 1");
    let (latest, latest_text) = restored_host(&checkpoint, "restored at generation 2");
    hydrate_texts(&mut store, &[&skipped_text, &latest_text]);
    let skipped_id = format!("moment-ydoc-{}", "b".repeat(64));
    let latest_id = format!("moment-ydoc-{}", "c".repeat(64));
    retain_restore_audit(
        &store,
        &generation(1),
        "relay",
        &skipped_id,
        &skipped_text,
        1,
    );
    retain_restore_audit(&store, &generation(2), "relay", &latest_id, &latest_text, 2);
    let skipped = restore_settlement(
        "first-restore",
        &skipped_id,
        &initial_text,
        &initial_moment,
        &skipped_text,
    );
    assert_eq!(
        apply_moment_envelope(&mut store, &skipped, &NoFaults).unwrap(),
        ApplyOutcome::new(ApplyDisposition::Applied(0))
    );
    assert_eq!(
        store.table_row_count("owner_pending_settlements").unwrap(),
        1
    );
    let before = snapshot(&store, "object");

    // The authenticated owner feed skips generation 1, so its settlement can
    // never become ready. The drain refuses it instead of writing it.
    let advanced = enroll_restore(&mut store, &generation(2), &latest, 2, &observed.limits);
    assert_eq!(
        (advanced.binding, advanced.accepted_cursor),
        (generation(2), 2)
    );
    let report =
        crate::moment_apply::pending::drain_and_claim(&mut store, "ws", &NoFaults, &NoLiveLeases)
            .unwrap();
    assert!(report.changes.is_empty());
    assert!(report.report_id.is_some());
    assert_eq!(snapshot(&store, "object"), before);
    assert_eq!(
        disposition(&store, "first-restore").as_deref(),
        Some("refused")
    );
    assert_eq!(
        store
            .read_with(|conn| conn.query_row(
                "SELECT reason_message FROM replication_pending_refusals WHERE origin_id='first-restore'",
                [],
                |row| row.get::<_, String>(0)
            ))
            .unwrap(),
        crate::moment_apply::pending::SUPERSEDED
    );

    // Committing the report releases the queue row; the refused envelope
    // keeps its text for inspection.
    let committed = crate::commit_relay_cursor(
        &mut store,
        "ws",
        &crate::RelayCursor {
            bootstrap_complete: true,
            cursor: 1,
            replication_epoch: "epoch".into(),
            stream_identity: "stream".into(),
            settlement_report_id: report.report_id,
            ordinary_pull: None,
        },
        &NoFaults,
        &NoLiveLeases,
        4,
    )
    .unwrap();
    assert!(matches!(
        committed,
        dohc_engine_storage::TxnOutcome::Committed(_)
    ));
    assert_eq!(
        store.table_row_count("owner_pending_settlements").unwrap(),
        0
    );
    assert_eq!(
        store
            .table_row_count("owner_pending_settlement_blobs")
            .unwrap(),
        0
    );
    assert_eq!(
        store
            .read_with(|conn| conn.query_row(
                "SELECT COUNT(*) FROM replication_refused_moment_blobs \
                 WHERE origin_id='first-restore' AND role='payload-after' AND text_sha256=?1",
                [text_sha(&skipped_text)],
                |row| row.get::<_, i64>(0)
            ))
            .unwrap(),
        1
    );

    // The current generation's own settlement still applies at its exact binding.
    let latest_settlement = restore_settlement(
        "second-restore",
        &latest_id,
        &initial_text,
        &initial_moment,
        &latest_text,
    );
    assert_eq!(
        apply_moment_envelope(&mut store, &latest_settlement, &NoFaults).unwrap(),
        ApplyOutcome::new(ApplyDisposition::Applied(0))
    );
    assert_eq!(
        snapshot(&store, "object").map(|(_, _, digest, moment)| (digest, moment)),
        Some((text_sha(&latest_text), latest_id))
    );
}

#[test]
fn held_settlement_current_path_recovery_is_refused_and_released() {
    held_settlement_recovery(RecoveryBinding::Renamed, false);
}

#[test]
fn held_settlement_selector_paths_recovery_is_refused_and_released() {
    held_settlement_recovery(RecoveryBinding::Selectors, false);
}

#[test]
fn held_settlement_later_generation_after_rename_is_refused_and_released() {
    held_settlement_recovery(RecoveryBinding::Renamed, true);
}

#[test]
fn held_settlement_same_binding_recovery_applies_and_releases() {
    held_settlement_recovery(RecoveryBinding::Unchanged, false);
}

#[test]
fn held_settlement_rename_away_and_back_applies_and_releases() {
    held_settlement_recovery(RecoveryBinding::RenamedBack, false);
}

#[derive(Clone, Copy)]
enum RecoveryBinding {
    Renamed,
    Selectors,
    Unchanged,
    RenamedBack,
}

fn held_settlement_recovery(case: RecoveryBinding, later_generation: bool) {
    use dohc_engine_collab::owner_outbox::{
        OwnerOutboxQuarantineInput,
        draft::append_draft_in_tx,
        enrollment::{OwnerEnrollmentInput, OwnerEnrollmentPreparation, enroll_in_tx, prepare_in},
    };
    let RestoreOwner {
        _scratch,
        mut store,
        mut observed,
        checkpoint,
        initial_text,
        initial_moment,
    } = restore_owner();
    let (host, text) = restored_host(&checkpoint, "held host settlement");
    hydrate_texts(&mut store, &[&text]);
    let id = format!("moment-ydoc-{}", "b".repeat(64));
    retain_restore_audit(&store, &observed.binding, "relay", &id, &text, 1);
    let settlement = restore_settlement("host", &id, &initial_text, &initial_moment, &text);
    assert_eq!(
        apply_moment_envelope(&mut store, &settlement, &NoFaults).unwrap(),
        ApplyOutcome::new(ApplyDisposition::Applied(0))
    );
    assert_eq!(
        store.table_row_count("owner_pending_settlements").unwrap(),
        1
    );
    let waiting =
        crate::moment_apply::pending::drain_and_claim(&mut store, "ws", &NoFaults, &NoLiveLeases)
            .unwrap();
    assert!(waiting.report_id.is_none());

    // Recovery requires a quarantined delivery parent. Use the real draft,
    // quarantine and enrollment APIs rather than rewriting binding_json.
    let original_binding = observed.binding.clone();
    let mut next = original_binding.clone();
    match case {
        RecoveryBinding::Renamed | RecoveryBinding::RenamedBack => {
            next.current_path = "renamed.md".into();
        }
        RecoveryBinding::Selectors => next.selector_paths = vec!["folder".into()],
        RecoveryBinding::Unchanged => {}
    }
    let bindings = if matches!(case, RecoveryBinding::RenamedBack) {
        vec![next, original_binding]
    } else {
        vec![next]
    };
    let recovery_host = Ydoc::wire();
    recovery_host.apply(&checkpoint).unwrap();
    if !later_generation {
        recovery_host.apply(&host.encode_full_state()).unwrap();
    }
    for (step, next) in bindings.iter().enumerate() {
        let dohc_engine_storage::TxnOutcome::Committed(parent) = store
            .write_with(&NoFaults, |tx| {
                append_draft_in_tx(
                    tx,
                    "ws",
                    &observed.binding,
                    observed.revision,
                    format!("before-rebind-{step}"),
                    checkpoint.clone(),
                    3,
                )
            })
            .unwrap()
        else {
            panic!("draft must commit")
        };
        dohc_engine_collab::owner_outbox::quarantine(
            &mut store,
            "ws",
            OwnerOutboxQuarantineInput {
                outbox_id: parent.outbox_id,
                reason: "binding-changed".into(),
                observed_binding: None,
            },
            4,
        )
        .unwrap();
        store
            .read_with(|conn| conn.execute("UPDATE ydoc_docs SET path=?1", [&next.current_path]))
            .unwrap();
        let OwnerEnrollmentPreparation::Capture { captured } = store
            .read_with(|conn| prepare_in(conn, next, "relay", true))
            .unwrap()
        else {
            panic!("recovery must capture")
        };
        let input = OwnerEnrollmentInput {
            binding: next.clone(),
            relay_database_namespace: "relay".into(),
            captured,
            journal_cursor: if later_generation || step + 1 < bindings.len() {
                0
            } else {
                1
            },
            checkpoint: recovery_host.encode_full_state(),
            host_vector: recovery_host.encode_state_vector(),
            recovery: true,
        };
        let dohc_engine_storage::TxnOutcome::Committed(recovered) = store
            .write_with(&NoFaults, |tx| {
                enroll_in_tx(tx, "ws", &input, &observed.limits, 5)
            })
            .unwrap()
        else {
            panic!("recovery must commit")
        };
        assert_eq!(&recovered.binding, next);
        assert_eq!(recovered.binding.restore_fence_generation, 0);
        observed.binding = recovered.binding;
        observed.revision = recovered.revision;
    }
    let mut next = observed.binding.clone();
    if later_generation {
        let waiting = crate::moment_apply::pending::drain_and_claim(
            &mut store,
            "ws",
            &NoFaults,
            &NoLiveLeases,
        )
        .unwrap();
        assert!(
            waiting.report_id.is_none(),
            "rename still waits for the cursor"
        );
        next.restore_fence_generation = 1;
        let advanced = enroll_restore(&mut store, &next, &host, 0, &observed.limits);
        assert_eq!(advanced.binding, next);
    }
    let before = snapshot(&store, "object");
    let mut report =
        crate::moment_apply::pending::drain_and_claim(&mut store, "ws", &NoFaults, &NoLiveLeases)
            .unwrap();
    assert!(
        report.report_id.is_some(),
        "a stale binding must reach a final decision"
    );
    let applies = matches!(
        case,
        RecoveryBinding::Unchanged | RecoveryBinding::RenamedBack
    );
    if applies {
        assert!(!report.changes.is_empty());
        assert_eq!(disposition(&store, "host").as_deref(), Some("applied"));
        assert_eq!(snapshot(&store, "object").unwrap().3, id);
        assert!(
            crate::list_refusal_notices(&store, "ws")
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            store
                .read_with(|conn| conn.query_row(
                    "SELECT COUNT(*) FROM moments WHERE moment_id=?1",
                    [&id],
                    |row| row.get::<_, i64>(0),
                ))
                .unwrap(),
            1
        );
        // A crash can leave an applied report to reclaim after another rename.
        let mut rebound = next.clone();
        rebound.current_path = "renamed-again.md".into();
        store
            .read_with(|conn| {
                conn.execute(
                    "UPDATE ydoc_owner_bindings SET binding_json=?1",
                    [serde_json::to_string(&rebound).unwrap()],
                )
            })
            .unwrap();
        report = crate::moment_apply::pending::drain_and_claim(
            &mut store,
            "ws",
            &NoFaults,
            &NoLiveLeases,
        )
        .unwrap();
        assert!(report.report_id.is_some());
        assert_eq!(disposition(&store, "host").as_deref(), Some("applied"));
        assert!(
            crate::list_refusal_notices(&store, "ws")
                .unwrap()
                .is_empty()
        );
    } else {
        assert!(report.changes.is_empty());
        assert_eq!(disposition(&store, "host").as_deref(), Some("refused"));
        let reason = store
            .read_with(|conn| {
                conn.query_row(
                "SELECT reason_message FROM replication_pending_refusals WHERE origin_id='host'",
                [],
                |row| row.get::<_, String>(0),
            )
            })
            .unwrap();
        assert_eq!(
            reason,
            if later_generation {
                crate::moment_apply::pending::SUPERSEDED
            } else {
                "This file's name, location, or sharing changed before this save arrived. Open the file to continue."
            }
        );
        assert_eq!(snapshot(&store, "object"), before);
        assert_eq!(
            store
                .read_with(|conn| conn.query_row(
                    "SELECT COUNT(*) FROM moments WHERE moment_id=?1",
                    [&id],
                    |row| row.get::<_, i64>(0),
                ))
                .unwrap(),
            0
        );
        if !later_generation {
            let notices = crate::list_refusal_notices(&store, "ws").unwrap();
            assert_eq!(
                notices[0].document.as_ref().unwrap().path.as_deref(),
                Some(next.current_path.as_str())
            );
        }
    }
    crate::commit_relay_cursor(
        &mut store,
        "ws",
        &crate::RelayCursor {
            bootstrap_complete: true,
            cursor: 1,
            replication_epoch: "epoch".into(),
            stream_identity: "stream".into(),
            settlement_report_id: report.report_id,
            ordinary_pull: None,
        },
        &NoFaults,
        &NoLiveLeases,
        6,
    )
    .unwrap();
    assert_eq!(
        store.table_row_count("owner_pending_settlements").unwrap(),
        0
    );
    assert_eq!(
        store
            .table_row_count("owner_pending_settlement_blobs")
            .unwrap(),
        0
    );
    if !applies {
        assert_eq!(store.read_with(|conn| conn.query_row(
        "SELECT COUNT(*) FROM replication_refused_moment_blobs WHERE origin_id='host' AND role='payload-after' AND text_sha256=?1",
        [text_sha(&text)], |row| row.get::<_, i64>(0),
    )).unwrap(), 1);
        if !later_generation {
            let notices = crate::list_refusal_notices(&store, "ws").unwrap();
            assert_eq!(
                notices[0].document.as_ref().unwrap().path.as_deref(),
                Some(next.current_path.as_str())
            );
            next.current_path = "moved-again.md".into();
            store
                .read_with(|conn| {
                    conn.execute(
                        "UPDATE ydoc_owner_bindings SET binding_json=?1",
                        [serde_json::to_string(&next).unwrap()],
                    )
                })
                .unwrap();
            let notices = crate::list_refusal_notices(&store, "ws").unwrap();
            assert_eq!(
                notices[0].document.as_ref().unwrap().path.as_deref(),
                Some("moved-again.md")
            );
            store
                .read_with(|conn| conn.execute("DELETE FROM ydoc_owner_bindings", []))
                .unwrap();
            let notices = crate::list_refusal_notices(&store, "ws").unwrap();
            assert!(notices[0].document.as_ref().unwrap().path.is_none());
        }
    }
}

/// An owner observed at restore generation 0 and accepted cursor 0.
struct RestoreOwner {
    _scratch: ScratchDir,
    store: EngineStore,
    observed: dohc_engine_collab::owner_outbox::draft::ObservedOwnerBinding,
    checkpoint: Vec<u8>,
    initial_text: String,
    initial_moment: String,
}

fn restore_owner() -> RestoreOwner {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../dohc-engine-collab/tests/owner-source/owner-source-seed.json"
    ))
    .unwrap();
    let original: Vec<u8> = serde_json::from_value(fixture["bytes"].clone()).unwrap();
    let initial_text = fixture["markdown"].as_str().unwrap().to_owned();
    restore_owner_from(&original, &initial_text, "owner.md")
}

fn restore_owner_from(original: &[u8], initial_text: &str, path: &str) -> RestoreOwner {
    use dohc_engine_collab::live_object_binding::LiveObjectBinding;
    use dohc_engine_collab::owner_outbox::{
        OwnerOutboxLimits,
        draft::{ObservedOwnerBinding, install_observed_binding_in_tx},
    };
    let (scratch, mut store) = test_store();
    crate::adopt_join_identity(&mut store, "ws", "local", "epoch", "stream", 1, &NoFaults).unwrap();
    let initial_moment = format!("moment-ydoc-{}", "a".repeat(64));
    seed_text_moment(
        &mut store,
        "object",
        path,
        initial_text,
        &initial_moment,
        None,
        true,
    );
    let key = DocKey::new("ws", "main", "object").unwrap();
    dohc_engine_collab::claim_base(
        &mut store,
        &key,
        YdocContentKind::Richdoc,
        original,
        &NoFaults,
        2,
    )
    .unwrap();
    store
        .read_with(|conn| conn.execute("UPDATE ydoc_docs SET path=?1", [path]))
        .unwrap();
    let checkpoint = store
        .read_with(|conn| dohc_engine_collab::load_doc_in(conn, &key))
        .unwrap()
        .encode_full_state();
    let observed = ObservedOwnerBinding {
        binding: LiveObjectBinding {
            workspace_id: "ws".into(),
            main_version_id: "main".into(),
            object_id: "object".into(),
            lineage_claim_id: hex_sha256(original),
            current_path: path.into(),
            selector_paths: vec![path.into()],
            restore_fence_generation: 0,
        },
        relay_database_namespace: "relay".into(),
        revision: 1,
        accepted_cursor: 0,
        native_head_sequence: store
            .read_with(|conn| dohc_engine_collab::read_marker_in(conn, &key))
            .unwrap()
            .unwrap()
            .head_update_seq,
        checkpoint_digest: hex_sha256(&checkpoint),
        limits: OwnerOutboxLimits {
            max_pending_bytes: 1_000_000,
            max_pending_age_ms: 60_000,
        },
    };
    store
        .write_with(&NoFaults, |tx| {
            install_observed_binding_in_tx(tx, "ws", &observed, &checkpoint)
        })
        .unwrap();
    RestoreOwner {
        _scratch: scratch,
        store,
        observed,
        checkpoint,
        initial_text: initial_text.into(),
        initial_moment,
    }
}

#[test]
fn observed_owner_settlement_preserves_pending_field_history_through_acceptance() {
    pending_field_settlement(false);
}

#[test]
fn observed_owner_settlement_replay_preserves_pending_field_history_through_acceptance() {
    pending_field_settlement(true);
}

fn apply_test_owner_frame(owner: &mut RestoreOwner, update: Vec<u8>, cursor: i64) {
    use dohc_engine_collab::owner_outbox::accepted::{OwnerAcceptedFrameInput, apply_frame_in_tx};
    let observed = &owner.observed;
    let dohc_engine_storage::TxnOutcome::Committed(result) = owner
        .store
        .write_with(&NoFaults, |tx| {
            apply_frame_in_tx(
                tx,
                "ws",
                &OwnerAcceptedFrameInput {
                    binding: observed.binding.clone(),
                    relay_database_namespace: "relay".into(),
                    expected_revision: observed.revision,
                    expected_native_head_sequence: observed.native_head_sequence,
                    previous_accepted_cursor: observed.accepted_cursor,
                    journal_cursor: cursor,
                    update_bytes: update,
                },
                10 + cursor,
            )
        })
        .unwrap()
    else {
        panic!("frame must commit")
    };
    owner.observed.revision = result.revision;
    owner.observed.native_head_sequence = result.native_head_sequence;
    owner.observed.accepted_cursor = result.accepted_cursor;
}

fn assert_pending_status(owner: &RestoreOwner) {
    owner.store.read_with(|conn| {
        let indexed = dohc_engine_domain::collections::indexed_collection_record_frontmatter_in_tx(conn, "ws", "main", "object").unwrap().unwrap();
        let visible = dohc_engine_collab::owner_outbox::draft::open_draft_in(conn, &owner.observed.binding, owner.observed.revision).unwrap();
        assert_eq!(indexed["status"], json!("done"));
        assert_eq!(indexed["status"], visible.doc.frontmatter_json()["status"]);
        let mut stmt = conn.prepare("SELECT previous_value_json,next_value_json,author_origin_id FROM collection_field_history WHERE field_name='status' ORDER BY history_id")?;
        let history = stmt.query_map([], |r| Ok((r.get::<_, Option<String>>(0)?,r.get::<_, Option<String>>(1)?,r.get::<_, Option<String>>(2)?)))?.collect::<Result<Vec<_>, _>>()?;
        assert_eq!(history, vec![(Some("\"open\"".into()), Some("\"done\"".into()), None)]);
        Ok::<_, rusqlite::Error>(())
    }).unwrap();
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum PendingFieldSettlement {
    Direct,
    Replay,
    Quarantined,
    QuarantinedRefusal,
    StorageFailure,
    Oversize,
    ReplayFailure,
    NonFiniteFields,
    RequotedNonFinite,
}

#[test]
fn observed_owner_quarantine_refusal_then_settlement_keeps_checkpoint_history() {
    pending_field_settlement_case(PendingFieldSettlement::QuarantinedRefusal);
}

#[test]
fn observed_owner_settlement_replay_storage_error_rolls_back_the_moment() {
    pending_field_settlement_case(PendingFieldSettlement::StorageFailure);
}

#[test]
fn observed_owner_quarantine_then_settlement_preserves_history_actor() {
    pending_field_settlement_case(PendingFieldSettlement::Quarantined);
}

#[test]
fn observed_owner_oversize_checkpoint_and_drafts_do_not_fail_settlement() {
    pending_field_settlement_case(PendingFieldSettlement::Oversize);
}

#[test]
fn observed_owner_indexing_replay_failure_does_not_stop_frames_or_settlement() {
    pending_field_settlement_case(PendingFieldSettlement::ReplayFailure);
}

#[test]
fn observed_owner_settlement_flags_restored_source_beside_draft_values() {
    pending_field_settlement_case(PendingFieldSettlement::NonFiniteFields);
}

#[test]
fn observed_owner_settlement_keeps_draft_quoted_value_over_equal_checkpoint_value() {
    pending_field_settlement_case(PendingFieldSettlement::RequotedNonFinite);
}

fn pending_field_settlement(replay: bool) {
    pending_field_settlement_case(if replay {
        PendingFieldSettlement::Replay
    } else {
        PendingFieldSettlement::Direct
    });
}

fn pending_field_settlement_case(case: PendingFieldSettlement) {
    let replay = case == PendingFieldSettlement::Replay;

    use dohc_engine_collab::owner_outbox::draft::append_draft_in_tx;
    let fixture: Value = serde_json::from_str(include_str!(
        "../../dohc-engine-collab/tests/owner-source/owner-source-seed.json"
    ))
    .unwrap();
    let doc = Ydoc::wire();
    doc.apply(&serde_json::from_value::<Vec<u8>>(fixture["bytes"].clone()).unwrap())
        .unwrap();
    doc.frontmatter_set("id", "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa")
        .unwrap();
    doc.frontmatter_set("status", "open").unwrap();
    let requoted = case == PendingFieldSettlement::RequotedNonFinite;
    let non_finite = requoted || case == PendingFieldSettlement::NonFiniteFields;
    // The accepted `.nan` that the draft leaves alone.
    let untouched = if requoted { "effort" } else { "estimate" };
    let text = doc.project(YdocContentKind::Richdoc).unwrap().content;
    let mut owner = restore_owner_from(&doc.encode_full_state(), &text, "tasks/owner.md");
    seed_text_moment(
        &mut owner.store,
        "schema",
        "tasks/collection.yaml",
        if non_finite {
            "fields:\n  status:\n    type: text\n  estimate:\n    type: number\n  \
             effort:\n    type: number\n"
        } else {
            "fields:\n  status:\n    type: text\n"
        },
        "schema",
        None,
        true,
    );
    owner
        .store
        .write_with(&NoFaults, |tx| {
            dohc_engine_domain::reconcile_collections_in_tx(tx, "ws", "main")
        })
        .unwrap();
    let host = Ydoc::wire();
    host.apply(&owner.checkpoint).unwrap();
    apply_test_owner_frame(
        &mut owner,
        host.richdoc_append_paragraph("accepted body"),
        1,
    );
    if non_finite {
        // A restore keeps source text that the generated emitter would quote.
        let current = host.project(YdocContentKind::Richdoc).unwrap().content;
        let restored = current.replacen("---\n", "---\nestimate: .nan\neffort: .nan\n", 1);
        apply_test_owner_frame(
            &mut owner,
            host.rewrite_content_to_markdown(YdocContentKind::Richdoc, &restored)
                .unwrap(),
            2,
        );
    }
    let draft = Ydoc::wire();
    draft.apply(&host.encode_full_state()).unwrap();
    let vector = draft.encode_state_vector();
    draft.frontmatter_set("status", "done").unwrap();
    if requoted {
        // The draft quotes the accepted value. Its JSON value stays the same.
        let shown = draft.project(YdocContentKind::Richdoc).unwrap().content;
        let quoted = shown.replacen("\nestimate: .nan\n", "\nestimate: \".nan\"\n", 1);
        assert_ne!(quoted, shown);
        draft
            .frontmatter_set_preserving_markdown_source("estimate", ".nan", &quoted)
            .unwrap();
        assert_eq!(
            draft.frontmatter_json()["estimate"],
            host.frontmatter_json()["estimate"]
        );
    } else if non_finite {
        draft.frontmatter_set("effort", "7").unwrap();
    }
    if case == PendingFieldSettlement::Oversize {
        draft.richdoc_append_paragraph(&"pending body ".repeat(170_000));
        owner.observed.limits.max_pending_bytes = 3_000_000;
        owner
            .store
            .read_with(|conn| {
                conn.execute(
                    "UPDATE ydoc_owner_bindings SET max_pending_bytes=3000000",
                    [],
                )
            })
            .unwrap();
    }
    let pending = draft.diff(&vector).unwrap();
    owner
        .store
        .write_with(&NoFaults, |tx| {
            append_draft_in_tx(
                tx,
                "ws",
                &owner.observed.binding,
                owner.observed.revision,
                "pending-status".into(),
                pending.clone(),
                12,
            )
        })
        .unwrap();
    assert_pending_status(&owner);
    let draft_fields = non_finite.then(|| record_fields(&owner));
    if let Some(fields) = &draft_fields {
        // The draft indexed the restored value from JSON, without its source.
        let accepted = fields.iter().find(|field| field.0 == untouched).unwrap();
        assert!(
            !accepted
                .3
                .as_deref()
                .unwrap_or_default()
                .contains("number-not-finite")
        );
    }
    if requoted {
        let fields = draft_fields.as_ref().unwrap();
        let estimate = fields.iter().find(|field| field.0 == "estimate").unwrap();
        assert!(
            estimate
                .3
                .as_deref()
                .is_some_and(|code| code.contains("expected-number"))
        );
        let shown = visible_draft_text(&owner);
        assert!(shown.contains("\nestimate: \".nan\"\n"));
    }
    if matches!(
        case,
        PendingFieldSettlement::Quarantined | PendingFieldSettlement::QuarantinedRefusal
    ) {
        if case == PendingFieldSettlement::QuarantinedRefusal {
            // Refuse a body-only entry while an independent field edit survives.
            // It must not bring the frozen field edit back into the index.
            let independent = Ydoc::wire();
            independent.apply(&host.encode_full_state()).unwrap();
            owner
                .store
                .write_with(&NoFaults, |tx| {
                    append_draft_in_tx(
                        tx,
                        "ws",
                        &owner.observed.binding,
                        owner.observed.revision,
                        "pending-body".into(),
                        independent.richdoc_append_paragraph("in-flight body"),
                        13,
                    )
                })
                .unwrap();
        }
        let descriptor = owner
            .store
            .read_with(|conn| {
                dohc_engine_collab::owner_outbox::draft::descriptor_for_key_in(
                    conn,
                    &DocKey::new("ws", "main", "object").unwrap(),
                )
            })
            .unwrap()
            .unwrap();
        for _ in 0..2 {
            dohc_engine_collab::owner_outbox::quarantine(
                &mut owner.store,
                "ws",
                dohc_engine_collab::owner_outbox::OwnerOutboxQuarantineInput {
                    outbox_id: descriptor.outbox_id.clone().unwrap(),
                    reason: "restore-fenced".into(),
                    observed_binding: None,
                },
                20,
            )
            .unwrap();
        }
        assert_quarantined_status(&owner);
        if case == PendingFieldSettlement::QuarantinedRefusal {
            let outbox = descriptor.outbox_id.unwrap();
            let queued =
                dohc_engine_collab::owner_outbox::read_pending(&owner.store, "ws", &outbox)
                    .unwrap();
            let entry = queued
                .entries
                .iter()
                .find(|entry| entry.append_key == "pending-body")
                .unwrap();
            let refusal = dohc_engine_collab::owner_outbox::OwnerOutboxRefuseInput {
                outbox_id: outbox,
                delivery_id: entry.delivery_id.clone(),
                update_digest: entry.update_digest.clone(),
                reason: "access-revoked".into(),
            };
            for _ in 0..2 {
                owner
                    .store
                    .write_with(&NoFaults, |tx| {
                        dohc_engine_collab::owner_outbox::refuse_entry_in_tx(tx, "ws", &refusal, 21)
                    })
                    .unwrap();
            }
            assert_quarantined_status(&owner);
        }
    }
    if case == PendingFieldSettlement::Oversize {
        let vector = host.encode_state_vector();
        // Deleted CRDT payload stays in the checkpoint, but the settled text is small.
        host.richdoc_append_paragraph(&"x".repeat(19 * 1024 * 1024));
        host.rewrite_content_to_markdown_for_fold(YdocContentKind::Richdoc, &text)
            .unwrap();
        assert!(host.encode_full_state().len() < dohc_engine_collab::limits::MAX_YDOC_UPDATE_BYTES);
        apply_test_owner_frame(&mut owner, host.diff(&vector).unwrap(), 2);
        let visible = Ydoc::wire();
        visible.apply(&host.encode_full_state()).unwrap();
        visible.apply(&pending).unwrap();
        assert!(
            visible.encode_full_state().len() > dohc_engine_collab::limits::MAX_YDOC_UPDATE_BYTES
        );
    }
    if case == PendingFieldSettlement::ReplayFailure {
        // A retained entry can no longer be replayed. Indexing must not roll back sync.
        owner.store.read_with(|conn| conn.execute("UPDATE owner_ydoc_outbox_entries SET byte_length=byte_length+1 WHERE pending=1", [])).unwrap();
        apply_test_owner_frame(
            &mut owner,
            host.frontmatter_set("status", "remote").unwrap(),
            2,
        );
        assert_retained_status(&owner);
    }
    let later_frame = replay.then(|| host.richdoc_append_paragraph("settled before its frame"));
    let settled = host.project(YdocContentKind::Richdoc).unwrap().content;
    assert!(!non_finite || settled.contains("\nestimate: .nan\neffort: .nan\n"));
    let cursor = if replay {
        2
    } else {
        owner.observed.accepted_cursor
    };
    let id = format!("moment-ydoc-{}", "b".repeat(64));
    hydrate_texts(&mut owner.store, &[&settled]);
    retain_restore_audit(
        &owner.store,
        &owner.observed.binding,
        "relay",
        &id,
        &settled,
        cursor,
    );
    let settlement = envelope(
        "host",
        0,
        "ws",
        present_text_payload(
            &id,
            "object",
            "write",
            "tasks/owner.md",
            "tasks/owner.md",
            &owner.initial_text,
            &owner.initial_moment,
            &settled,
        ),
    );
    if case == PendingFieldSettlement::StorageFailure {
        use rusqlite::hooks::{AuthAction, AuthContext, Authorization};
        use std::sync::{
            Arc,
            atomic::{AtomicBool, Ordering},
        };
        let denied = Arc::new(AtomicBool::new(false));
        let captured = denied.clone();
        let before = snapshot(&owner.store, "object");
        let moments = owner.store.table_row_count("moments").unwrap();
        let log = owner.store.table_row_count("replication_log").unwrap();
        owner
            .store
            .read_with(|conn| {
                conn.authorizer(Some(move |ctx: AuthContext<'_>| {
                    if matches!(
                        ctx.action,
                        AuthAction::Read {
                            table_name: "owner_ydoc_outbox_entries",
                            column_name: "byte_length"
                        }
                    ) && !captured.swap(true, Ordering::SeqCst)
                    {
                        Authorization::Deny
                    } else {
                        Authorization::Allow
                    }
                }))
            })
            .unwrap();
        let result = crate::apply_moment_envelope_detailed(
            &mut owner.store,
            &settlement,
            &NoFaults,
            &crate::AlwaysLive,
        );
        owner
            .store
            .read_with(|conn| conn.authorizer(None::<fn(AuthContext<'_>) -> Authorization>))
            .unwrap();
        assert!(denied.load(Ordering::SeqCst));
        assert!(matches!(result, Err(SyncError::Storage(_))));
        assert_eq!(snapshot(&owner.store, "object"), before);
        assert_eq!(owner.store.table_row_count("moments").unwrap(), moments);
        assert_eq!(owner.store.table_row_count("replication_log").unwrap(), log);
        assert_pending_status(&owner);
    }
    let result = crate::apply_moment_envelope_detailed(
        &mut owner.store,
        &settlement,
        &NoFaults,
        &crate::AlwaysLive,
    )
    .unwrap();
    assert!(matches!(result.primary, ApplyDisposition::Applied(ref r) if r.record_facts.is_none()));
    if let Some(mut fields) = draft_fields {
        // Accepted `.nan` takes its parse flag. Draft values keep their index.
        let (accepted, others): (Vec<_>, Vec<_>) = record_fields(&owner)
            .into_iter()
            .partition(|field| field.0 == untouched);
        assert!(
            accepted[0]
                .3
                .as_deref()
                .is_some_and(|code| code.contains("number-not-finite"))
        );
        fields.retain(|field| field.0 != untouched);
        assert_eq!(others, fields);
    }
    if requoted {
        // The draft's quoted value still shows over the checkpoint's `.nan`.
        let shown = visible_draft_text(&owner);
        assert!(shown.contains("\nestimate: \".nan\"\n"));
    }
    if let Some(update) = later_frame {
        assert_eq!(
            owner
                .store
                .table_row_count("owner_pending_settlements")
                .unwrap(),
            1
        );
        apply_test_owner_frame(&mut owner, update, cursor);
        assert_pending_status(&owner);
        let drained = super::moment_apply::pending::drain_and_claim(
            &mut owner.store,
            "ws",
            &NoFaults,
            &crate::AlwaysLive,
        )
        .unwrap();
        assert!(drained.record_facts.is_empty());
        assert_eq!(drained.changes.len(), 1);
    }
    match case {
        PendingFieldSettlement::Quarantined | PendingFieldSettlement::QuarantinedRefusal => {
            assert_quarantined_status(&owner)
        }
        PendingFieldSettlement::ReplayFailure => assert_retained_status(&owner),
        PendingFieldSettlement::Oversize => {
            owner.store.read_with(|conn| {
                let visible = dohc_engine_collab::load_doc_in(conn, &DocKey::new("ws", "main", "object").unwrap()).unwrap();
                dohc_engine_collab::owner_outbox::draft::apply_pending_to_checkpoint_in(conn, &owner.observed.binding, &visible).unwrap();
                let indexed = dohc_engine_domain::collections::indexed_collection_record_frontmatter_in_tx(conn, "ws", "main", "object").unwrap().unwrap();
                assert_eq!(indexed["status"], visible.frontmatter_json()["status"]);
                Ok::<_, rusqlite::Error>(())
            }).unwrap();
        }
        _ => assert_pending_status(&owner),
    }
    assert_eq!(
        snapshot(&owner.store, "object").unwrap().2,
        text_sha(&settled)
    );
    if matches!(
        case,
        PendingFieldSettlement::Quarantined
            | PendingFieldSettlement::QuarantinedRefusal
            | PendingFieldSettlement::Oversize
            | PendingFieldSettlement::ReplayFailure
    ) {
        return;
    }
    let accepted_cursor = owner.observed.accepted_cursor + 1;
    apply_test_owner_frame(&mut owner, pending, accepted_cursor);
    assert_pending_status(&owner);
}

fn assert_quarantined_status(owner: &RestoreOwner) {
    owner.store.read_with(|conn| {
        let indexed = dohc_engine_domain::collections::indexed_collection_record_frontmatter_in_tx(conn, "ws", "main", "object").unwrap().unwrap();
        assert_eq!(indexed["status"], json!("open"));
        let mut stmt = conn.prepare("SELECT previous_value_json,next_value_json,author_origin_id FROM collection_field_history WHERE field_name='status' ORDER BY history_id")?;
        let history = stmt.query_map([], |r| Ok((r.get::<_, Option<String>>(0)?,r.get::<_, Option<String>>(1)?,r.get::<_, Option<String>>(2)?)))?.collect::<Result<Vec<_>, _>>()?;
        assert_eq!(history, vec![(Some("\"open\"".into()), Some("\"done\"".into()), None), (Some("\"done\"".into()), Some("\"open\"".into()), Some("owner-draft-quarantine".into()))]);
        assert!(matches!(dohc_engine_collab::owner_outbox::draft::open_draft_in(conn, &owner.observed.binding, owner.observed.revision), Err(dohc_engine_collab::OwnerOutboxError::Frozen)));
        Ok::<_, rusqlite::Error>(())
    }).unwrap();
}

fn assert_retained_status(owner: &RestoreOwner) {
    owner
        .store
        .read_with(|conn| {
            let indexed =
                dohc_engine_domain::collections::indexed_collection_record_frontmatter_in_tx(
                    conn, "ws", "main", "object",
                )
                .unwrap()
                .unwrap();
            assert_eq!(indexed["status"], json!("done"));
            let count: i64 = conn.query_row(
                "SELECT COUNT(*) FROM collection_field_history WHERE field_name='status'",
                [],
                |r| r.get(0),
            )?;
            assert_eq!(count, 1);
            Ok::<_, rusqlite::Error>(())
        })
        .unwrap();
}

fn record_fields(owner: &RestoreOwner) -> Vec<(String, String, String, Option<String>)> {
    owner
        .store
        .read_with(|conn| {
            let mut stmt = conn.prepare(
                "SELECT field_name,value_json,validation_status,validation_reason_json \
                 FROM collection_record_fields ORDER BY field_name",
            )?;
            let fields = stmt
                .query_map([], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, Option<String>>(3)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            Ok::<_, rusqlite::Error>(fields)
        })
        .unwrap()
}

fn visible_draft_text(owner: &RestoreOwner) -> String {
    owner
        .store
        .read_with(|conn| {
            let draft = dohc_engine_collab::owner_outbox::draft::open_draft_in(
                conn,
                &owner.observed.binding,
                owner.observed.revision,
            )
            .unwrap();
            let projection = draft.doc.project(YdocContentKind::Richdoc).unwrap();
            Ok::<_, rusqlite::Error>(projection.content)
        })
        .unwrap()
}

/// The host's state once a restore that appends `paragraph` is accepted.
fn restored_host(checkpoint: &[u8], paragraph: &str) -> (Ydoc, String) {
    let host = Ydoc::wire();
    host.apply(checkpoint).unwrap();
    let _ = host.richdoc_append_paragraph(paragraph);
    let text = host.project(YdocContentKind::Richdoc).unwrap().content;
    (host, text)
}

/// The audit parser is covered separately. Seed its committed output.
fn retain_restore_audit(
    store: &EngineStore,
    binding: &dohc_engine_collab::live_object_binding::LiveObjectBinding,
    namespace: &str,
    id: &str,
    text: &str,
    terminal_cursor: i64,
) {
    let record = format!(
        "{{\"momentId\":{},\"relayDatabaseNamespace\":{},\"binding\":{},\"previousCursor\":{terminal_cursor},\"terminalCursor\":{terminal_cursor},\"acceptedEventCount\":0,\"acceptedIntervalDigest\":\"{}\"}}",
        serde_json::to_string(id).unwrap(),
        serde_json::to_string(namespace).unwrap(),
        serde_json::to_string(binding).unwrap(),
        "0".repeat(64)
    );
    store.read_with(|conn| conn.execute("INSERT INTO live_audit_settlements(settlement_id,workspace_id,record_digest,record_json,markdown_digest) VALUES (?1,'ws',?2,?3,?4)", params![id, hex_sha256(record.as_bytes()), record, text_sha(text)])).unwrap();
}

fn restore_settlement(
    origin: &str,
    id: &str,
    initial_text: &str,
    initial_moment: &str,
    text: &str,
) -> ReplicationEnvelope {
    envelope(
        origin,
        0,
        "ws",
        present_text_payload(
            id,
            "object",
            "write",
            "owner.md",
            "owner.md",
            initial_text,
            initial_moment,
            text,
        ),
    )
}

/// The authenticated owner feed reaches `binding` at the host cut `cursor`.
fn enroll_restore(
    store: &mut EngineStore,
    binding: &dohc_engine_collab::live_object_binding::LiveObjectBinding,
    host: &Ydoc,
    cursor: i64,
    limits: &dohc_engine_collab::owner_outbox::OwnerOutboxLimits,
) -> dohc_engine_collab::owner_outbox::draft::OwnerDraftDescriptor {
    use dohc_engine_collab::owner_outbox::enrollment::{
        OwnerEnrollmentInput, OwnerEnrollmentPreparation, enroll_in_tx, prepare_in,
    };
    let captured = match store
        .read_with(|conn| prepare_in(conn, binding, "relay", false))
        .unwrap()
    {
        OwnerEnrollmentPreparation::Capture { captured } => captured,
        OwnerEnrollmentPreparation::Observed { .. } => panic!("a restore generation captures"),
    };
    let input = OwnerEnrollmentInput {
        binding: binding.clone(),
        relay_database_namespace: "relay".into(),
        captured,
        journal_cursor: cursor,
        checkpoint: host.encode_full_state(),
        host_vector: host.encode_state_vector(),
        recovery: false,
    };
    let advanced = store
        .write_with(&NoFaults, |tx| enroll_in_tx(tx, "ws", &input, limits, 3))
        .unwrap();
    let dohc_engine_storage::TxnOutcome::Committed(advanced) = advanced else {
        panic!("enrollment must commit")
    };
    advanced
}

fn disposition(store: &EngineStore, origin: &str) -> Option<String> {
    store
        .read_with(|conn| {
            conn.query_row(
                "SELECT apply_disposition FROM replication_log WHERE origin_id=?1",
                [origin],
                |row| row.get(0),
            )
        })
        .unwrap()
}

#[test]
fn public_create_author_survives_replay_but_is_not_republished_without_proof() {
    let (_scratch, mut store) = test_store();
    hydrate_texts(&mut store, &["---\nanswer: Lisbon\n---\n"]);
    let mut payload = absent_text_payload(
        "accepted-create",
        "response-object",
        "poll/response.md",
        "---\nanswer: Lisbon\n---\n",
    );
    let authors = json!([{"kind":"public", "principalId":"public-holder", "grantId":"grant"}]);
    payload["authors"] = authors.clone();
    let op = envelope("relay:collection-create:grant", 0, "ws", payload);
    assert_eq!(
        apply_moment_envelope(&mut store, &op, &NoFaults).expect("accept"),
        ApplyOutcome::new(ApplyDisposition::Applied(0))
    );
    apply_moment_envelope(&mut store, &op, &NoFaults).expect("idempotent replay");
    store
        .write_with(&NoFaults, |tx| {
            let count: i64 = tx
                .query_row(
                    "SELECT COUNT(*) FROM moments WHERE moment_id='accepted-create'",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(count, 1);
            let stored: String = tx
                .query_row(
                    "SELECT author_json FROM moments WHERE moment_id='accepted-create'",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(serde_json::from_str::<Value>(&stored).unwrap(), authors);
            let (exported, _) =
                crate::outbound::moment_append_payload_in_tx(tx, "ws", "accepted-create").unwrap();
            assert!(exported.get("authors").is_none());
            assert_eq!(
                exported["attributionUnavailable"]["reason"],
                "unproven-hosted-authors"
            );
            Ok::<_, SyncError>(())
        })
        .unwrap();
    let history = VersionedTextStore::new(&mut store)
        .get_moment("ws", "accepted-create")
        .unwrap()
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(history.author_json.as_deref().unwrap()).unwrap(),
        authors
    );
}

#[test]
fn public_author_is_refused_from_an_ordinary_origin() {
    let (_scratch, mut store) = test_store();
    hydrate_texts(&mut store, &["answer"]);
    let mut payload = absent_text_payload(
        "forged-public",
        "forged-object",
        "poll/response.md",
        "answer",
    );
    payload["authors"] = json!([{"kind":"public", "principalId":"holder", "grantId":"grant"}]);
    let result = apply_moment_envelope(
        &mut store,
        &envelope("device-origin", 0, "ws", payload),
        &NoFaults,
    )
    .expect("refusal is recorded");
    assert!(
        matches!(result.primary, ApplyDisposition::Refused(ref refusal) if matches!(refusal.reason, RefusalReason::InvalidInput { ref reason } if reason == "public moment author requires a relay collection origin"))
    );
}

const NAMED_ORIGIN: &str = "relay:collection-file:grant";
const TRIP_SCHEMA: &str = "name: Trip\n";

fn named_author(grant_id: &str) -> Value {
    json!({"kind":"named", "userId":"ana", "grantId":grant_id, "grantGeneration":1})
}

fn link_author(grant_id: &str) -> Value {
    json!({"kind":"link", "grantId":grant_id, "grantGeneration":2, "principalId":"holder"})
}

/// Both authors the relay mints for a direct write.
fn direct_write_authors(grant_id: &str) -> [Value; 2] {
    [named_author(grant_id), link_author(grant_id)]
}

fn with_author(mut payload: Value, author: Value) -> Value {
    payload["authors"] = json!([author]);
    payload
}

fn refusal_reason(outcome: ApplyOutcome<i64>) -> String {
    match outcome.primary {
        ApplyDisposition::Refused(ReplicationRefusal {
            reason: RefusalReason::InvalidInput { reason },
            ..
        }) => reason,
        other => panic!("expected a refusal, got {other:?}"),
    }
}

fn seed_trip_collection(store: &mut EngineStore) {
    seed_text_moment(
        store,
        "trip-schema",
        "trip/collection.yaml",
        TRIP_SCHEMA,
        "trip-schema-1",
        None,
        true,
    );
    seed_text_moment(
        store,
        "trip-record",
        "trip/lisbon.md",
        "Lisbon",
        "trip-record-1",
        None,
        true,
    );
}

#[test]
fn direct_write_authors_write_only_automations_beside_a_dataset_manifest() {
    for author in direct_write_authors("grant") {
        let (_scratch, mut store) = test_store();
        seed_text_moment(
            &mut store,
            "dataset",
            "data/dataset.json",
            "{}",
            "dataset-1",
            None,
            true,
        );
        seed_text_moment(
            &mut store,
            "record",
            "data/row.md",
            "row",
            "record-1",
            None,
            true,
        );
        seed_text_moment(
            &mut store,
            "rules",
            "data/rules.yaml",
            "rules",
            "rules-1",
            None,
            true,
        );
        hydrate_texts(
            &mut store,
            &["version: 1\n", "version: 2\n", "changed", "name: Data\n"],
        );
        let writes = [
            absent_text_payload(
                "auto-create",
                "auto",
                "data/automations.yaml",
                "version: 1\n",
            ),
            present_text_payload(
                "auto-edit",
                "auto",
                "write",
                "data/automations.yaml",
                "data/automations.yaml",
                "version: 1\n",
                "auto-create",
                "version: 2\n",
            ),
        ];
        for (seq, payload) in (0_i64..).zip(writes) {
            let op = envelope(
                NAMED_ORIGIN,
                seq,
                "ws",
                with_author(payload, author.clone()),
            );
            assert_eq!(
                apply_moment_envelope(&mut store, &op, &NoFaults).expect("apply automations"),
                ApplyOutcome::new(ApplyDisposition::Applied(0))
            );
        }
        let refused = [
            present_text_payload(
                "dataset-edit",
                "dataset",
                "write",
                "data/dataset.json",
                "data/dataset.json",
                "{}",
                "dataset-1",
                "changed",
            ),
            present_text_payload(
                "rules-edit",
                "rules",
                "write",
                "data/rules.yaml",
                "data/rules.yaml",
                "rules",
                "rules-1",
                "changed",
            ),
            present_text_payload(
                "record-edit",
                "record",
                "write",
                "data/row.md",
                "data/row.md",
                "row",
                "record-1",
                "changed",
            ),
            absent_text_payload("record-create", "new-record", "data/new.md", "changed"),
            absent_text_payload(
                "schema-create",
                "schema",
                "data/collection.yaml",
                "name: Data\n",
            ),
        ];
        for (seq, payload) in (2_i64..).zip(refused) {
            let op = envelope(
                NAMED_ORIGIN,
                seq,
                "ws",
                with_author(payload, author.clone()),
            );
            assert_eq!(
                refusal_reason(
                    apply_moment_envelope(&mut store, &op, &NoFaults).expect("record refusal")
                ),
                "direct-write author may write only a Collection's own files"
            );
        }
        assert_eq!(
            snapshot(&store, "auto").map(|head| head.3),
            Some("auto-edit".to_owned())
        );
        assert_eq!(
            snapshot(&store, "dataset").map(|head| head.3),
            Some("dataset-1".to_owned())
        );
        assert_eq!(
            snapshot(&store, "record").map(|head| head.3),
            Some("record-1".to_owned())
        );
        assert!(snapshot(&store, "schema").is_none());
    }
}

#[test]
fn direct_write_authors_write_a_collections_own_files_from_their_grant_origin() {
    let (_scratch, mut store) = test_store();
    seed_trip_collection(&mut store);
    let writes = [
        present_text_payload(
            "schema-edit",
            "trip-schema",
            "write",
            "trip/collection.yaml",
            "trip/collection.yaml",
            TRIP_SCHEMA,
            "trip-schema-1",
            "name: Trip plan\n",
        ),
        absent_text_payload(
            "automations-create",
            "trip-automations",
            "trip/automations.yaml",
            "version: 1\n",
        ),
        absent_text_payload("record-create", "trip-porto", "trip/porto.md", "Porto"),
        absent_text_payload(
            "new-collection",
            "food-schema",
            "trip/food/collection.yaml",
            "name: Food\n",
        ),
        absent_text_payload(
            "new-collection-record",
            "food-record",
            "trip/food/pastel.md",
            "Pastel",
        ),
    ];
    hydrate_texts(
        &mut store,
        &[
            "name: Trip plan\n",
            "version: 1\n",
            "Porto",
            "name: Food\n",
            "Pastel",
        ],
    );
    // The two authors take turns, so each writes every kind of own file.
    let author = |seq: i64| {
        if seq % 2 == 0 {
            named_author("grant")
        } else {
            link_author("grant")
        }
    };
    for (seq, payload) in (0_i64..).zip(writes) {
        let op = envelope(NAMED_ORIGIN, seq, "ws", with_author(payload, author(seq)));
        assert_eq!(
            apply_moment_envelope(&mut store, &op, &NoFaults).expect("apply"),
            ApplyOutcome::new(ApplyDisposition::Applied(0)),
            "{}",
            op.payload["path"]
        );
    }
    let authors = store
        .read_with(|conn| {
            let mut statement = conn.prepare(
                "SELECT author_json FROM moments WHERE author_json IS NOT NULL ORDER BY moment_order",
            )?;
            let rows = statement
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?;
            Ok::<_, rusqlite::Error>(rows)
        })
        .expect("read authors");
    assert_eq!(authors.len(), 5);
    for (seq, stored) in (0_i64..).zip(authors) {
        assert_eq!(
            serde_json::from_str::<Value>(&stored).expect("author JSON"),
            json!([author(seq)])
        );
    }
}

#[test]
fn moment_authors_are_a_nonempty_list_and_a_relay_author_stands_alone() {
    let agent = json!({"kind":"agent", "agentId":"runner", "onBehalfOf":"owner"});
    let person = json!({"kind":"human", "humanId":"ana"});
    let (_scratch, mut store) = test_store();
    hydrate_texts(&mut store, &["content"]);
    let mut payload = absent_text_payload("both", "object", "doc.md", "content");
    payload["authors"] = json!([person, agent]);
    assert_eq!(
        apply_moment_envelope(&mut store, &envelope("source", 0, "ws", payload), &NoFaults)
            .expect("apply"),
        ApplyOutcome::new(ApplyDisposition::Applied(0)),
    );
    let history = VersionedTextStore::new(&mut store)
        .get_moment("ws", "both")
        .expect("history")
        .expect("moment");
    assert_eq!(
        serde_json::from_str::<Value>(history.author_json.as_deref().expect("authors")).unwrap(),
        json!([person, agent]),
    );
    for (origin, authors) in [
        ("source", json!([])),
        ("source", agent.clone()),
        (NAMED_ORIGIN, json!([named_author("grant"), agent])),
        (
            "relay:collection-create:grant",
            json!([{"kind":"public", "principalId":"holder", "grantId":"grant"}, agent]),
        ),
    ] {
        let (_scratch, mut store) = test_store();
        hydrate_texts(&mut store, &["content"]);
        let mut payload = absent_text_payload("refused", "object", "doc.md", "content");
        payload["authors"] = authors.clone();
        let result =
            apply_moment_envelope(&mut store, &envelope(origin, 0, "ws", payload), &NoFaults)
                .expect("refusal is recorded");
        assert!(
            matches!(result.primary, ApplyDisposition::Refused(_)),
            "{authors}"
        );
        assert_eq!(store.table_row_count("moments").unwrap(), 0);
    }
}

#[test]
fn direct_write_author_and_collection_file_origin_travel_only_together() {
    let (_scratch, mut store) = test_store();
    seed_trip_collection(&mut store);
    hydrate_texts(&mut store, &["version: 1\n"]);
    let automations = || {
        absent_text_payload(
            "automations-create",
            "trip-automations",
            "trip/automations.yaml",
            "version: 1\n",
        )
    };
    let mut cases = vec![
        (NAMED_ORIGIN, Value::Null),
        (
            NAMED_ORIGIN,
            json!({"kind":"public", "principalId":"holder", "grantId":"grant"}),
        ),
        (
            NAMED_ORIGIN,
            json!({"kind":"agent", "agentId":"agent", "onBehalfOf":"owner"}),
        ),
    ];
    for author in direct_write_authors("grant") {
        cases.push(("device-origin", author.clone()));
        cases.push(("relay:collection-create:grant", author.clone()));
        cases.push(("relay:collection-file:other-grant", author));
    }
    cases.extend(direct_write_authors("other-grant").map(|author| (NAMED_ORIGIN, author)));
    for (origin, author) in cases {
        let seq = read_replication_acked_seq(&store, "ws", origin).expect("ack") + 1;
        let payload = if author.is_null() {
            automations()
        } else {
            with_author(automations(), author.clone())
        };
        let outcome =
            apply_moment_envelope(&mut store, &envelope(origin, seq, "ws", payload), &NoFaults)
                .expect("refusal is recorded");
        let expected = if matches!(author["kind"].as_str(), Some("public")) {
            "public moment author requires a relay collection origin"
        } else {
            "direct-write author requires its grant's relay collection-file origin"
        };
        assert_eq!(refusal_reason(outcome), expected, "{origin} {author}");
    }
    assert!(snapshot(&store, "trip-automations").is_none());
}

#[test]
fn link_author_is_refused_without_every_bounded_field() {
    let (_scratch, mut store) = test_store();
    seed_trip_collection(&mut store);
    hydrate_texts(&mut store, &["version: 1\n"]);
    let long = "p".repeat(501);
    let invalid = "moment.append payload is invalid";
    let malformed = "moment.append payload is malformed";
    let cases = [
        (
            json!({"kind":"link", "grantId":"grant", "grantGeneration":2}),
            malformed,
        ),
        (
            json!({"kind":"link", "grantId":"grant", "principalId":"holder"}),
            malformed,
        ),
        (
            json!({"kind":"link", "grantGeneration":2, "principalId":"holder"}),
            malformed,
        ),
        (
            json!({"kind":"link", "grantId":"grant", "grantGeneration":"2", "principalId":"holder"}),
            malformed,
        ),
        (
            json!({"kind":"link", "grantId":"grant", "grantGeneration":2.5, "principalId":"holder"}),
            malformed,
        ),
        (
            json!({"kind":"link", "grantId":"grant", "grantGeneration":0, "principalId":"holder"}),
            invalid,
        ),
        (
            json!({"kind":"link", "grantId":"grant", "grantGeneration":-1, "principalId":"holder"}),
            invalid,
        ),
        (
            json!({"kind":"link", "grantId":"grant", "grantGeneration":2, "principalId":""}),
            invalid,
        ),
        (
            json!({"kind":"link", "grantId":"grant", "grantGeneration":2, "principalId":long}),
            invalid,
        ),
    ];
    for (seq, (author, expected)) in (0_i64..).zip(cases) {
        let payload = with_author(
            absent_text_payload(
                "automations-create",
                "trip-automations",
                "trip/automations.yaml",
                "version: 1\n",
            ),
            author.clone(),
        );
        let outcome = apply_moment_envelope(
            &mut store,
            &envelope(NAMED_ORIGIN, seq, "ws", payload),
            &NoFaults,
        )
        .expect("refusal is recorded");
        assert_eq!(refusal_reason(outcome), expected, "{author}");
    }
    assert!(snapshot(&store, "trip-automations").is_none());
}

#[test]
fn direct_write_author_is_refused_with_any_field_beyond_its_own() {
    let (_scratch, mut store) = test_store();
    seed_trip_collection(&mut store);
    hydrate_texts(&mut store, &["version: 1\n"]);
    let mut cases = Vec::new();
    for author in direct_write_authors("grant") {
        for (key, value) in [
            ("displayName", json!("Ana")),
            ("email", json!("ana@example.com")),
            ("capability", json!("secret")),
            ("onBehalfOf", json!("owner")),
        ] {
            let mut extra = author.clone();
            extra[key] = value;
            cases.push(extra);
        }
    }
    let mut link_as_user = link_author("grant");
    link_as_user["userId"] = json!("ana");
    cases.push(link_as_user);
    let mut named_as_link = named_author("grant");
    named_as_link["principalId"] = json!("holder");
    cases.push(named_as_link);
    for (seq, author) in (0_i64..).zip(cases) {
        let payload = with_author(
            absent_text_payload(
                "automations-create",
                "trip-automations",
                "trip/automations.yaml",
                "version: 1\n",
            ),
            author.clone(),
        );
        let outcome = apply_moment_envelope(
            &mut store,
            &envelope(NAMED_ORIGIN, seq, "ws", payload),
            &NoFaults,
        )
        .expect("refusal is recorded");
        assert_eq!(
            refusal_reason(outcome),
            if author["kind"] == "link" {
                "moment.append payload is malformed"
            } else {
                "direct-write author carries only its own fields"
            },
            "{author}"
        );
    }
    assert!(snapshot(&store, "trip-automations").is_none());
}

#[test]
fn direct_write_authors_are_refused_outside_a_collections_own_files() {
    let (_scratch, mut store) = test_store();
    seed_trip_collection(&mut store);
    seed_text_moment(
        &mut store,
        "notes-page",
        "notes/page.md",
        "Notes",
        "notes-page-1",
        None,
        true,
    );
    seed_text_moment(
        &mut store,
        "archive-page",
        "archive/2025/old.md",
        "Old",
        "archive-page-1",
        None,
        true,
    );
    seed_text_moment(
        &mut store,
        "gone-object",
        "elsewhere/gone.md",
        "Gone",
        "gone-object-1",
        None,
        false,
    );
    hydrate_texts(
        &mut store,
        &["version: 1\n", "Changed", "name: Root\n", "code"],
    );
    let refused = [
        // A record update is live editing, never a direct write.
        present_text_payload(
            "record-edit",
            "trip-record",
            "write",
            "trip/lisbon.md",
            "trip/lisbon.md",
            "Lisbon",
            "trip-record-1",
            "Changed",
        ),
        present_text_payload(
            "schema-rename",
            "trip-schema",
            "rename",
            "trip/collection.yaml",
            "trip/schema.yaml",
            TRIP_SCHEMA,
            "trip-schema-1",
            TRIP_SCHEMA,
        ),
        present_text_payload(
            "schema-delete",
            "trip-schema",
            "delete",
            "trip/collection.yaml",
            "trip/collection.yaml",
            TRIP_SCHEMA,
            "trip-schema-1",
            TRIP_SCHEMA,
        ),
        // A record moved onto the schema path, stated as a write.
        {
            let mut moved = present_text_payload(
                "record-onto-schema",
                "trip-record",
                "write",
                "trip/collection.yaml",
                "trip/collection.yaml",
                "Lisbon",
                "trip-record-1",
                "name: Root\n",
            );
            moved["payloadBeforePath"] = json!("trip/lisbon.md");
            moved["beforePath"] = json!("trip/lisbon.md");
            moved
        },
        {
            let mut binary = absent_text_payload(
                "binary-automations",
                "binary-automations",
                "trip/automations.yaml",
                "version: 1\n",
            );
            binary["payloadAfterContentKind"] = json!("binary");
            binary
        },
        absent_text_payload(
            "root-schema",
            "root-schema",
            "collection.yaml",
            "name: Root\n",
        ),
        absent_text_payload(
            "plain-automations",
            "plain-automations",
            "notes/automations.yaml",
            "version: 1\n",
        ),
        absent_text_payload("plain-record", "plain-record", "notes/new.md", "Changed"),
        absent_text_payload(
            "nested-record",
            "nested-record",
            "trip/days/one.md",
            "Changed",
        ),
        absent_text_payload("code", "code", "trip/stamp.js", "code"),
        // Another file's object, with every declared path at the schema.
        present_text_payload(
            "foreign-object-edit",
            "trip-record",
            "write",
            "trip/collection.yaml",
            "trip/collection.yaml",
            "Lisbon",
            "trip-record-1",
            "name: Root\n",
        ),
        absent_text_payload(
            "foreign-object-create",
            "trip-record",
            "trip/automations.yaml",
            "version: 1\n",
        ),
        // An object this workspace held once, now without a head.
        absent_text_payload(
            "deleted-object-create",
            "gone-object",
            "trip/automations.yaml",
            "version: 1\n",
        ),
        // A schema created in a folder that holds files, directly or below.
        absent_text_payload(
            "schema-in-used-folder",
            "notes-schema",
            "notes/collection.yaml",
            "name: Root\n",
        ),
        absent_text_payload(
            "schema-above-files",
            "archive-schema",
            "archive/collection.yaml",
            "name: Root\n",
        ),
    ];
    let cases = direct_write_authors("grant")
        .into_iter()
        .flat_map(|author| {
            refused
                .clone()
                .map(move |payload| with_author(payload, author.clone()))
        });
    for (seq, payload) in (0_i64..).zip(cases) {
        let path = payload["path"].clone();
        let op = envelope(NAMED_ORIGIN, seq, "ws", payload);
        assert_eq!(
            refusal_reason(
                apply_moment_envelope(&mut store, &op, &NoFaults).expect("refusal is recorded")
            ),
            "direct-write author may write only a Collection's own files",
            "{path} {} {}",
            op.payload["momentId"],
            op.payload["authors"][0]["kind"]
        );
    }
    assert_eq!(
        snapshot(&store, "trip-record").map(|head| (head.0, head.3)),
        Some(("trip/lisbon.md".to_owned(), "trip-record-1".to_owned()))
    );
    assert_eq!(
        snapshot(&store, "trip-schema").map(|head| head.3),
        Some("trip-schema-1".to_owned())
    );
    assert!(snapshot(&store, "notes-schema").is_none());
    assert!(snapshot(&store, "archive-schema").is_none());
}

#[test]
fn named_schema_edit_on_a_stale_base_opens_a_conflict() {
    let (_scratch, mut store) = test_store();
    seed_trip_collection(&mut store);
    seed_text_moment(
        &mut store,
        "trip-schema",
        "trip/collection.yaml",
        "name: Owner\n",
        "trip-schema-2",
        Some(("trip-schema-1", TRIP_SCHEMA)),
        true,
    );
    hydrate_texts(&mut store, &["name: Ana\n"]);
    let stale = present_text_payload(
        "stale-schema-edit",
        "trip-schema",
        "write",
        "trip/collection.yaml",
        "trip/collection.yaml",
        TRIP_SCHEMA,
        "trip-schema-1",
        "name: Ana\n",
    );
    let op = envelope(
        NAMED_ORIGIN,
        0,
        "ws",
        with_author(stale, named_author("grant")),
    );
    assert_eq!(
        apply_moment_envelope(&mut store, &op, &NoFaults).expect("apply"),
        ApplyOutcome::new(ApplyDisposition::Applied(1))
    );
    assert_eq!(
        snapshot(&store, "trip-schema").map(|head| head.3),
        Some("trip-schema-2".to_owned())
    );
}

#[test]
fn named_write_to_an_unimported_version_waits_instead_of_refusing() {
    let (_scratch, mut store) = test_store();
    seed_trip_collection(&mut store);
    hydrate_texts(&mut store, &["version: 1\n"]);
    let mut payload = absent_text_payload(
        "draft-automations",
        "draft-automations",
        "trip/automations.yaml",
        "version: 1\n",
    );
    payload["versionId"] = json!("draft");
    let op = envelope(
        NAMED_ORIGIN,
        0,
        "ws",
        with_author(payload, named_author("grant")),
    );
    assert!(matches!(
        apply_moment_envelope(&mut store, &op, &NoFaults),
        Err(SyncError::RetryableState { .. })
    ));
    assert_eq!(
        read_replication_acked_seq(&store, "ws", NAMED_ORIGIN).expect("ack"),
        -1
    );
}

#[test]
fn collection_file_origin_carries_only_moment_append() {
    let (_scratch, mut store) = test_store();
    for (seq, op_kind) in (0_i64..).zip(["conflict.resolve", "conflict.open", "version.create"]) {
        let op = ReplicationEnvelope {
            op_kind: op_kind.to_owned(),
            ..envelope(NAMED_ORIGIN, seq, "ws", json!({}))
        };
        let outcome = apply_replication_envelope(
            &mut store,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &op,
            &NoFaults,
            &NoLiveLeases,
        )
        .expect("refusal is recorded");
        assert!(
            matches!(
                outcome.primary,
                ApplyDisposition::Refused(ReplicationRefusal {
                    reason: RefusalReason::InvalidInput { ref reason },
                    ..
                }) if reason == "relay collection-file origin carries only moment.append"
            ),
            "{op_kind}: {outcome:?}"
        );
    }
    assert_eq!(
        read_replication_acked_seq(&store, "ws", NAMED_ORIGIN).expect("ack"),
        2
    );
}

fn hydrate_texts(store: &mut EngineStore, texts: &[&str]) {
    store
        .read_with(|tx| {
            for text in texts {
                tx.execute(
                    "INSERT OR IGNORE INTO blobs (sha256,byte_length,text) VALUES (?1,?2,?3)",
                    params![text_sha(text), text.len() as i64, text],
                )?;
            }
            Ok::<_, rusqlite::Error>(())
        })
        .expect("hydrate text blobs");
}

fn seed_text_moment(
    store: &mut EngineStore,
    object_id: &str,
    path: &str,
    text: &str,
    moment_id: &str,
    before: Option<(&str, &str)>,
    materialize_head: bool,
) {
    hydrate_texts(store, &[text]);
    if let Some((_, before_text)) = before {
        hydrate_texts(store, &[before_text]);
    }
    store
        .read_with(|tx| {
            tx.execute(
                "INSERT OR IGNORE INTO file_objects (workspace_id,object_id,created_at_ms) \
                 VALUES ('ws',?1,1)",
                [object_id],
            )?;
            let order: i64 = tx.query_row(
                "SELECT COALESCE(MAX(moment_order),-1)+1 FROM moments WHERE workspace_id='ws'",
                [],
                |row| row.get(0),
            )?;
            let (before_present, before_sha, before_id) = before.map_or(
                (1_i64, None, None),
                |(before_id, before_text)| {
                    (
                        2_i64,
                        Some(text_sha(before_text)),
                        Some(before_id.to_owned()),
                    )
                },
            );
            tx.execute(
                "INSERT INTO moments (
                   workspace_id,moment_order,moment_id,version_id,object_id,path,recorded_at_ms,
                   operation,after_blob_sha256,before_present,before_blob_sha256,
                   before_latest_moment_id,metadata_origin,author_json,sync_record_only,
                   after_content_kind,after_binary_sha256,before_content_kind,before_binary_sha256
                 ) VALUES ('ws',?1,?2,'main',?3,?4,?5,'write',?6,?7,?8,?9,
                           'api',NULL,NULL,'text',NULL,'text',NULL)",
                params![
                    order,
                    moment_id,
                    object_id,
                    path,
                    100 + order,
                    text_sha(text),
                    before_present,
                    before_sha,
                    before_id
                ],
            )?;
            if materialize_head {
                tx.execute(
                    "INSERT INTO snapshots (
                       workspace_id,version_id,object_id,path,blob_sha256,updated_at_ms,
                       latest_moment_id,metadata_origin,content_kind,binary_sha256
                     ) VALUES ('ws','main',?1,?2,?3,?4,?5,'api','text',NULL)
                     ON CONFLICT(workspace_id,version_id,object_id) DO UPDATE SET
                       path=excluded.path,blob_sha256=excluded.blob_sha256,
                       updated_at_ms=excluded.updated_at_ms,
                       latest_moment_id=excluded.latest_moment_id,
                       metadata_origin=excluded.metadata_origin,content_kind='text',
                       binary_sha256=NULL",
                    params![object_id, path, text_sha(text), 100 + order, moment_id],
                )?;
                tx.execute(
                    "INSERT INTO path_aliases (workspace_id,version_id,path,object_id)
                     VALUES ('ws','main',?1,?2)
                     ON CONFLICT(workspace_id,version_id,path) DO UPDATE SET object_id=excluded.object_id",
                    params![path, object_id],
                )?;
            }
            Ok::<_, rusqlite::Error>(())
        })
        .expect("seed text moment");
}

fn seed_text_lineage(
    store: &mut EngineStore,
    object_id: &str,
    path: &str,
    base_text: &str,
    base_id: &str,
    head_text: &str,
    head_id: &str,
) {
    seed_text_moment(store, object_id, path, base_text, base_id, None, false);
    seed_text_moment(
        store,
        object_id,
        path,
        head_text,
        head_id,
        Some((base_id, base_text)),
        true,
    );
}

fn seed_binary_head(
    store: &mut EngineStore,
    object_id: &str,
    path: &str,
    bytes: &[u8],
    moment_id: &str,
) -> String {
    let actual = hex_sha256(bytes);
    let stored = store
        .read_with(|tx| {
            let stored = put_binary_blob(tx, bytes)?;
            tx.execute(
                "INSERT OR IGNORE INTO file_objects (workspace_id,object_id,created_at_ms) \
                 VALUES ('ws',?1,1)",
                [object_id],
            )
            .map_err(dohc_engine_storage::StorageError::persist_public)?;
            let order: i64 = tx
                .query_row(
                    "SELECT COALESCE(MAX(moment_order),-1)+1 FROM moments WHERE workspace_id='ws'",
                    [],
                    |row| row.get(0),
                )
                .map_err(dohc_engine_storage::StorageError::corrupt_public)?;
            tx.execute(
                "INSERT INTO moments (
                   workspace_id,moment_order,moment_id,version_id,object_id,path,recorded_at_ms,
                   operation,after_blob_sha256,before_present,before_blob_sha256,
                   before_latest_moment_id,metadata_origin,author_json,sync_record_only,
                   after_content_kind,after_binary_sha256,before_content_kind,before_binary_sha256
                 ) VALUES ('ws',?1,?2,'main',?3,?4,100,'write',NULL,1,NULL,NULL,
                           'api',NULL,NULL,'binary',?5,'text',NULL)",
                params![order, moment_id, object_id, path, stored],
            )
            .map_err(dohc_engine_storage::StorageError::persist_public)?;
            tx.execute(
                "INSERT INTO snapshots (
                   workspace_id,version_id,object_id,path,blob_sha256,updated_at_ms,
                   latest_moment_id,metadata_origin,content_kind,binary_sha256
                 ) VALUES ('ws','main',?1,?2,NULL,100,?3,'api','binary',?4)",
                params![object_id, path, moment_id, stored],
            )
            .map_err(dohc_engine_storage::StorageError::persist_public)?;
            tx.execute(
                "INSERT INTO path_aliases (workspace_id,version_id,path,object_id)
                 VALUES ('ws','main',?1,?2)",
                params![path, object_id],
            )
            .map_err(dohc_engine_storage::StorageError::persist_public)?;
            Ok::<_, dohc_engine_storage::StorageError>(stored)
        })
        .expect("seed binary head");
    assert_eq!(stored, actual);
    actual
}

fn absent_text_payload(moment_id: &str, object_id: &str, path: &str, text: &str) -> Value {
    json!({
        "momentId": moment_id,
        "versionId": "main",
        "objectId": object_id,
        "objectCreatedAtMs": 1,
        "path": path,
        "recordedAtMs": 2_000,
        "operation": "write",
        "payloadBeforeBlobSha256": null,
        "payloadBeforePath": null,
        "payloadAfterBlobSha256": text_sha(text),
        "payloadAfterPath": path,
        "metadata": {"origin": "sync"},
        "beforePresent": "absent"
    })
}

#[test]
fn replicated_moment_snapshot_origin_is_sync() {
    let (_scratch, mut store) = test_store();
    hydrate_texts(&mut store, &["peer capture"]);
    let mut payload = absent_text_payload(
        "peer-capture-moment",
        "peer-capture-object",
        "notes/peer.md",
        "peer capture",
    );
    payload["metadata"]["origin"] = json!("local-file");

    apply_moment_envelope(&mut store, &envelope("peer", 0, "ws", payload), &NoFaults)
        .expect("replicated moment");

    let origin: String = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT metadata_origin FROM snapshots \
                 WHERE workspace_id='ws' AND version_id='main' \
                   AND object_id='peer-capture-object'",
                [],
                |row| row.get(0),
            )
        })
        .expect("snapshot origin");
    assert_eq!(origin, "sync");
}

#[test]
fn moment_after_equivalent_ydoc_projection_fast_forwards() {
    let (_peer_scratch, mut peer) = test_store();
    let local_settle_id = format!("moment-ydoc-{}", "a".repeat(64));

    let doc = Ydoc::wire();
    doc.plaintext_insert(0, "settled text");
    let base_sha = peer
        .put_binary_blob(&doc.encode_full_state())
        .expect("Y.Doc base blob");
    let base = ReplicationEnvelope {
        settlement_admission: None,
        admitted_author_snapshot: None,
        workspace_id: "ws".to_owned(),
        origin_id: "ydoc-origin".to_owned(),
        origin_seq: 0,
        op_kind: "ydoc.update".to_owned(),
        payload: json!({
            "versionId": "main",
            "objectId": "ydoc-settle-object",
            "path": "notes/settled.md",
            "contentKind": "plaintext",
            "updateBlobSha256": base_sha.clone(),
            "lineageClaimId": base_sha.clone(),
            "isBaseState": true
        }),
        recorded_at_ms: 1_500,
        relay_seq: Some(0),
    };
    apply_ydoc_envelope(
        &mut peer,
        &mut dohc_engine_collab::WriterDocCache::new(),
        &base,
        &NoFaults,
        &NoLiveLeases,
    )
    .expect("peer Y.Doc projection");
    let peer_head: String = peer
        .read_with(|conn| {
            conn.query_row(
                "SELECT latest_moment_id FROM snapshots \
                 WHERE workspace_id='ws' AND version_id='main' \
                   AND object_id='ydoc-settle-object'",
                [],
                |row| row.get(0),
            )
        })
        .expect("peer projected head");
    assert!(peer_head.starts_with("moment-ydoc-apply-"));
    assert_ne!(peer_head, local_settle_id);

    let rewrite = [
        doc.plaintext_delete(0, "settled text".len() as u32),
        doc.plaintext_insert(0, "next edit"),
    ];
    for (index, update) in rewrite.into_iter().enumerate() {
        let update_sha = peer.put_binary_blob(&update).expect("Y.Doc rewrite blob");
        let delta = ReplicationEnvelope {
            settlement_admission: None,
            admitted_author_snapshot: None,
            workspace_id: "ws".to_owned(),
            origin_id: "ydoc-origin".to_owned(),
            origin_seq: index as i64 + 1,
            op_kind: "ydoc.update".to_owned(),
            payload: json!({
                "versionId": "main",
                "objectId": "ydoc-settle-object",
                "path": "notes/settled.md",
                "contentKind": "plaintext",
                "updateBlobSha256": update_sha,
                "lineageClaimId": base_sha.clone(),
                "isBaseState": false
            }),
            recorded_at_ms: 1_600 + index as i64,
            relay_seq: Some(index as i64 + 1),
        };
        apply_ydoc_envelope(
            &mut peer,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &delta,
            &NoFaults,
            &NoLiveLeases,
        )
        .expect("peer Y.Doc rewrite");
    }

    hydrate_texts(&mut peer, &["next edit"]);
    let next = envelope(
        "moment-origin",
        0,
        "ws",
        present_text_payload(
            "moment-after-settle",
            "ydoc-settle-object",
            "write",
            "notes/settled.md",
            "notes/settled.md",
            "settled text",
            &local_settle_id,
            "next edit",
        ),
    );
    assert_eq!(
        apply_moment_envelope(&mut peer, &next, &NoFaults).expect("next moment"),
        ApplyOutcome::new(ApplyDisposition::Applied(0))
    );
    let (latest_moment_id, conflicts): (String, i64) = peer
        .read_with(|conn| {
            let latest = conn.query_row(
                "SELECT latest_moment_id FROM snapshots \
                 WHERE workspace_id='ws' AND version_id='main' \
                   AND object_id='ydoc-settle-object'",
                [],
                |row| row.get(0),
            )?;
            let conflicts = conn.query_row(
                "SELECT COUNT(*) FROM conflicts WHERE workspace_id='ws'",
                [],
                |row| row.get(0),
            )?;
            Ok::<_, rusqlite::Error>((latest, conflicts))
        })
        .expect("peer result");
    assert!(latest_moment_id.starts_with("moment-ydoc-apply-"));
    assert_eq!(conflicts, 0);
}

#[allow(clippy::too_many_arguments)]
fn present_text_payload(
    moment_id: &str,
    object_id: &str,
    operation: &str,
    path: &str,
    after_path: &str,
    before_text: &str,
    before_head: &str,
    after_text: &str,
) -> Value {
    json!({
        "momentId": moment_id,
        "versionId": "main",
        "objectId": object_id,
        "objectCreatedAtMs": 1,
        "path": path,
        "recordedAtMs": 2_000,
        "operation": operation,
        "payloadBeforeBlobSha256": text_sha(before_text),
        "payloadBeforePath": path,
        "payloadAfterBlobSha256": text_sha(after_text),
        "payloadAfterPath": after_path,
        "metadata": {"origin": "sync", "summary": "peer"},
        "beforePresent": "present",
        "beforeObjectId": object_id,
        "beforeVersionId": "main",
        "beforePath": path,
        "beforeBlobSha256": text_sha(before_text),
        "beforeUpdatedAtMs": 100,
        "beforeLatestMomentId": before_head,
        "beforeMetadata": {"origin": "api"}
    })
}

fn stopped_binary_moment() -> (
    ScratchDir,
    EngineStore,
    ReplicationEnvelope,
    dohc_engine_collab::owner_outbox::OwnerOutboxAppendResult,
    Vec<u8>,
) {
    use dohc_engine_collab::live_object_binding::LiveObjectBinding;
    use dohc_engine_collab::live_update_application::{
        NativeRestoreFence, NativeRestoreFenceReceipt, RestoreDeliveryOrigin,
    };
    use dohc_engine_collab::owner_outbox::{self, OwnerOutboxAppendInput, OwnerOutboxLimits};
    let (scratch, mut store) = test_store();
    crate::adopt_join_identity(
        &mut store,
        "ws",
        "local-peer",
        "epoch",
        "stream",
        1_000,
        &NoFaults,
    )
    .expect("joined workspace identity");
    VersionedTextStore::new(&mut store)
        .write_text(
            &WriteText {
                workspace_id: "ws".into(),
                version_id: "main".into(),
                object_id: "object".into(),
                path: "shared.md".into(),
                text: "current".into(),
                moment_id: "current-moment".into(),
                metadata_origin: "api".into(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 100,
                request_id: None,
            },
            &NoFaults,
        )
        .expect("real current moment");
    let binding = LiveObjectBinding {
        workspace_id: "ws".into(),
        main_version_id: "main".into(),
        object_id: "object".into(),
        lineage_claim_id: "lineage".into(),
        current_path: "shared.md".into(),
        selector_paths: vec!["shared.md".into()],
        restore_fence_generation: 0,
    };
    let bytes = vec![0xff, 0x00, 0xfe, 0x01];
    let outbox = owner_outbox::append(
        &mut store,
        "ws",
        OwnerOutboxAppendInput {
            binding: LiveObjectBinding {
                object_id: "other".into(),
                current_path: "other.md".into(),
                selector_paths: vec!["other.md".into()],
                ..binding.clone()
            },
            base_update: b"different base".to_vec(),
            append_key: "other-update".into(),
            update: bytes.clone(),
            limits: OwnerOutboxLimits {
                max_pending_bytes: 10_000,
                max_pending_age_ms: 10_000,
            },
            created_at_ms: 1_000,
        },
    )
    .expect("independent outbox owns the shared digest");
    let operation = NativeRestoreFence {
        point: dohc_engine_collab::live_update_application::NativeRestoreSelection {
            journal_cursor: 0,
            receipt_digest: binding.lineage_claim_id.clone(),
        },
        operation_id: "restore".into(),
        relay_database_namespace: "relay".into(),
        old_binding: binding,
        host_id: "host".into(),
        new_fence: 1,
        origin: RestoreDeliveryOrigin::Bootstrap {
            id: "bootstrap".into(),
        },
        terminal: None,
        applied_sequence: 0,
    };
    let receipt = NativeRestoreFenceReceipt {
        operation: operation.clone(),
        local_head_sequence: 0,
        recorded_at_ms: 1_001,
    };
    store.read_with(|conn| conn.execute(
        "INSERT INTO live_restore_fences(workspace_id,main_version_id,object_id,relay_database_namespace,operation_id,input_json,receipt_json) VALUES ('ws','main','object','relay','restore',?1,?2)",
        params![serde_json::to_string(&operation).unwrap(), serde_json::to_string(&receipt).unwrap()],
    )).expect("seed the durable stopped-lineage guard");
    let mut payload = present_text_payload(
        "refused-moment",
        "object",
        "write",
        "shared.md",
        "shared.md",
        "current",
        "current-moment",
        "unused",
    );
    payload["payloadAfterBlobSha256"] = json!(hex_sha256(&bytes));
    payload["payloadAfterContentKind"] = json!("binary");
    payload["payloadAfterByteLength"] = json!(bytes.len());
    payload["authors"] =
        json!([{"kind":"agent","agentId":"original-agent","onBehalfOf":"original-owner"}]);
    (
        scratch,
        store,
        envelope("original-peer", 0, "ws", payload),
        outbox,
        bytes,
    )
}

#[test]
fn stopped_moment_retains_shared_blobs_after_outbox_ack_report_and_restart() {
    use dohc_engine_collab::owner_outbox::{self, OwnerDeliveryReceipt};
    let (_scratch, mut store, op, outbox, bytes) = stopped_binary_moment();
    let db = store.database_path().to_owned();
    let before = snapshot(&store, "object");
    let result = apply_moment_envelope(&mut store, &op, &NoFaults).unwrap();
    assert!(
        matches!(result.primary, ApplyDisposition::Refused(ReplicationRefusal {
        reason: RefusalReason::InvalidInput { ref reason }, ..
    }) if reason == "live document is stopped")
    );
    assert_eq!(
        read_replication_acked_seq(&store, "ws", "original-peer").unwrap(),
        0
    );
    assert_eq!(snapshot(&store, "object"), before);
    let ack = owner_outbox::acknowledge(
        &mut store,
        "ws",
        &outbox.outbox_id,
        &[OwnerDeliveryReceipt {
            delivery_id: outbox.delivery_id,
            update_digest: outbox.update_digest,
            journal_cursor: 1,
            accepting_host_epoch: 1,
        }],
    )
    .expect("unrelated outbox can release its ownership");
    assert_eq!(ack.pending_bytes, 0);
    assert_eq!(
        store.get_binary_blob(&hex_sha256(&bytes)).unwrap(),
        Some(bytes.clone())
    );
    let refusals = crate::apply::read_pending_refusals(&store, "ws").unwrap();
    assert_eq!(refusals.len(), 1);
    crate::commit_relay_cursor(
        &mut store,
        "ws",
        &crate::RelayCursor {
            bootstrap_complete: true,
            cursor: 1,
            replication_epoch: "epoch".into(),
            stream_identity: "stream".into(),
            settlement_report_id: None,
            ordinary_pull: None,
        },
        &NoFaults,
        &crate::NoLiveLeases,
        3_000,
    )
    .expect("report commit");
    drop(store);
    let mut store = EngineStore::open(&db, 4_000).unwrap();
    store.read_with(|conn| {
        let saved: (String, String, i64, i64, i64) = conn.query_row(
            "SELECT payload_json,apply_disposition,recorded_at_ms,imported,origin_seq FROM replication_log WHERE workspace_id='ws' AND origin_id='original-peer' AND origin_seq=0",
            [], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?)),
        )?;
        assert_eq!(serde_json::from_str::<Value>(&saved.0).unwrap(), op.payload);
        assert_eq!((saved.1, saved.2, saved.3, saved.4), ("refused".into(), op.recorded_at_ms, 1, 0));
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM replication_pending_refusals", [], |r| r.get::<_,i64>(0))?, 1);
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM replication_refused_moment_blobs", [], |r| r.get::<_,i64>(0))?, 3);
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM moments WHERE moment_id='refused-moment'", [], |r| r.get::<_,i64>(0))?, 0);
        assert!(conn.execute("DELETE FROM binary_blobs WHERE sha256=?1", [hex_sha256(&bytes)]).is_err());
        Ok::<_,rusqlite::Error>(())
    }).unwrap();
    assert_eq!(
        store.get_binary_blob(&hex_sha256(&bytes)).unwrap(),
        Some(bytes)
    );
    assert_eq!(snapshot(&store, "object"), before);
    assert!(matches!(
        apply_moment_envelope(&mut store, &op, &NoFaults)
            .unwrap()
            .primary,
        ApplyDisposition::Skipped
    ));
    assert_eq!(snapshot(&store, "object"), before);
}

#[test]
fn stopped_moment_retention_failure_does_not_ack_or_commit_refusal() {
    let (_scratch, mut store, op, _outbox, _bytes) = stopped_binary_moment();
    let before = snapshot(&store, "object");
    store.read_with(|conn| conn.execute_batch(
        "CREATE TEMP TRIGGER reject_retention BEFORE INSERT ON replication_refused_moment_blobs WHEN NEW.role='payload-after' BEGIN SELECT RAISE(ABORT,'retention unavailable'); END;"
    )).unwrap();
    assert!(matches!(
        apply_moment_envelope(&mut store, &op, &NoFaults),
        Err(SyncError::Storage(_))
    ));
    assert_eq!(
        read_replication_acked_seq(&store, "ws", "original-peer").unwrap(),
        -1
    );
    assert_eq!(snapshot(&store, "object"), before);
    store
        .read_with(|conn| {
            for table in [
                "replication_refused_moment_blobs",
                "replication_pending_refusals",
                "replication_log",
            ] {
                assert_eq!(
                    conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r
                        .get::<_, i64>(0))?,
                    0
                );
            }
            conn.execute_batch("DROP TRIGGER reject_retention")?;
            Ok::<_, rusqlite::Error>(())
        })
        .unwrap();
    assert!(matches!(
        apply_moment_envelope(&mut store, &op, &NoFaults)
            .unwrap()
            .primary,
        ApplyDisposition::Refused(_)
    ));
    assert_eq!(
        read_replication_acked_seq(&store, "ws", "original-peer").unwrap(),
        0
    );
}

fn snapshot(store: &EngineStore, object_id: &str) -> Option<(String, String, String, String)> {
    store
        .read_with(|conn| {
            conn.query_row(
                "SELECT path,COALESCE(content_kind,'text'),
                        COALESCE(blob_sha256,binary_sha256),latest_moment_id
                 FROM snapshots WHERE workspace_id='ws' AND version_id='main' AND object_id=?1",
                [object_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()
        })
        .expect("snapshot")
}

fn aliases(store: &EngineStore, object_id: &str) -> Vec<String> {
    store
        .read_with(|conn| {
            conn.prepare(
                "SELECT path FROM path_aliases WHERE workspace_id='ws' AND version_id='main' \
                 AND object_id=?1 ORDER BY path",
            )?
            .query_map([object_id], |row| row.get(0))?
            .collect()
        })
        .expect("aliases")
}

fn indexed(store: &EngineStore, object_id: &str) -> Vec<(String, String)> {
    store
        .read_with(|conn| {
            conn.prepare(
                "SELECT path,text FROM engine_search_files_fts \
                 WHERE workspace_id='ws' AND version_id='main' AND object_id=?1 ORDER BY path",
            )?
            .query_map([object_id], |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect()
        })
        .expect("search rows")
}

fn conflict_ids(store: &EngineStore) -> Vec<String> {
    store
        .read_with(|conn| {
            conn.prepare(
                "SELECT conflict_id FROM conflicts WHERE workspace_id='ws' ORDER BY conflict_id",
            )?
            .query_map([], |row| row.get(0))?
            .collect()
        })
        .expect("conflict ids")
}

#[test]
fn moment_delete_retires_the_receiver_ydoc_lineage() {
    let (_scratch, mut peer) = test_store();
    let local_settle_id = format!("moment-ydoc-{}", "b".repeat(64));
    let doc = Ydoc::wire();
    doc.plaintext_insert(0, "gone");
    let base_sha = peer
        .put_binary_blob(&doc.encode_full_state())
        .expect("Y.Doc base blob");
    apply_ydoc_envelope(
        &mut peer,
        &mut dohc_engine_collab::WriterDocCache::new(),
        &ReplicationEnvelope {
            settlement_admission: None,
            admitted_author_snapshot: None,
            workspace_id: "ws".to_owned(),
            origin_id: "ydoc-origin".to_owned(),
            origin_seq: 0,
            op_kind: "ydoc.update".to_owned(),
            payload: json!({
                "versionId": "main",
                "objectId": "ydoc-delete-object",
                "path": "notes/deleted.md",
                "contentKind": "plaintext",
                "updateBlobSha256": base_sha.clone(),
                "lineageClaimId": base_sha,
                "isBaseState": true
            }),
            recorded_at_ms: 1_500,
            relay_seq: Some(0),
        },
        &NoFaults,
        &NoLiveLeases,
    )
    .expect("project Y.Doc base");

    let delete = envelope(
        "moment-origin",
        0,
        "ws",
        present_text_payload(
            "moment-delete-ydoc",
            "ydoc-delete-object",
            "delete",
            "notes/deleted.md",
            "notes/deleted.md",
            "gone",
            &local_settle_id,
            "gone",
        ),
    );
    assert_eq!(
        apply_moment_envelope(&mut peer, &delete, &NoFaults).expect("apply delete"),
        ApplyOutcome::new(ApplyDisposition::Applied(0))
    );
    let (snapshots, markers): (i64, i64) = peer
        .read_with(|conn| {
            Ok::<_, rusqlite::Error>((
                conn.query_row(
                    "SELECT COUNT(*) FROM snapshots WHERE workspace_id='ws' \
                     AND version_id='main' AND object_id='ydoc-delete-object'",
                    [],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*) FROM ydoc_docs WHERE workspace_id='ws' \
                     AND version_id='main' AND object_id='ydoc-delete-object'",
                    [],
                    |row| row.get(0),
                )?,
            ))
        })
        .expect("inspect deleted object");
    assert_eq!(
        (snapshots, markers),
        (0, 0),
        "the inbound delete must remove the snapshot and canonical lineage together"
    );
}

#[test]
fn moment_delete_with_unsettled_lineage_stays_unacked() {
    let (_scratch, mut store) = test_store();
    store
        .read_with(|tx| {
            tx.execute(
                "INSERT INTO file_objects (workspace_id,object_id,created_at_ms) \
                 VALUES ('ws','unsettled-delete-object',1)",
                [],
            )?;
            Ok::<_, rusqlite::Error>(())
        })
        .expect("seed unsettled object");
    let key = DocKey::new("ws", "main", "unsettled-delete-object").expect("Y.Doc key");
    let doc = Ydoc::wire();
    let update = doc.plaintext_insert(0, "only durable draft");
    dohc_engine_collab::record_local_update(
        &mut store,
        &mut dohc_engine_collab::WriterDocCache::new(),
        &key,
        &update,
        dohc_engine_collab::LocalAppend {
            marker: Some(dohc_engine_collab::MarkerCreation {
                path: Some("notes/unsettled.md"),
                content_kind: YdocContentKind::Plaintext,
                regime: Regime::LocalOnly,
            }),
            ..Default::default()
        },
        &NoFaults,
        1_500,
        |_tx, _outcome, _update_sha| Ok(()),
    )
    .expect("seed unsettled lineage");
    hydrate_texts(&mut store, &["remote head", ""]);
    let delete = envelope(
        "unsettled-delete-peer",
        0,
        "ws",
        present_text_payload(
            "moment-delete-unsettled",
            "unsettled-delete-object",
            "delete",
            "notes/unsettled.md",
            "notes/unsettled.md",
            "remote head",
            "remote-head",
            "",
        ),
    );

    let outcome = apply_replication_envelope(
        &mut store,
        &mut dohc_engine_collab::WriterDocCache::new(),
        &delete,
        &NoFaults,
        &NoLiveLeases,
    );
    assert!(
        matches!(
            outcome,
            Err(SyncError::RetryableState {
                reason: "ydoc-lineage-unsettled"
            })
        ),
        "unexpected delete outcome: {outcome:?}"
    );
    assert_eq!(
        read_replication_acked_seq(&store, "ws", "unsettled-delete-peer").expect("ack"),
        -1
    );
    let (moments, log, updates, snapshots, deferred, docs): (i64, i64, i64, i64, i64, i64) = store
        .read_with(|conn| {
            Ok::<_, rusqlite::Error>((
                conn.query_row(
                    "SELECT COUNT(*) FROM moments WHERE workspace_id='ws' \
                         AND moment_id='moment-delete-unsettled'",
                    [],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*) FROM replication_log WHERE workspace_id='ws' \
                         AND origin_id='unsettled-delete-peer'",
                    [],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*) FROM ydoc_updates WHERE workspace_id='ws' \
                         AND version_id='main' AND object_id='unsettled-delete-object'",
                    [],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*) FROM ydoc_snapshots WHERE workspace_id='ws' \
                         AND version_id='main' AND object_id='unsettled-delete-object'",
                    [],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*) FROM ydoc_deferred_updates WHERE workspace_id='ws' \
                         AND version_id='main' AND object_id='unsettled-delete-object'",
                    [],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*) FROM ydoc_docs WHERE workspace_id='ws' \
                         AND version_id='main' AND object_id='unsettled-delete-object'",
                    [],
                    |row| row.get(0),
                )?,
            ))
        })
        .expect("inspect retryable delete");
    assert_eq!((moments, log), (0, 0));
    assert_eq!(
        (updates, snapshots, deferred, docs),
        (1, 0, 0, 1),
        "the only durable draft must remain byte-for-byte reachable"
    );
}

#[test]
fn moment_delete_with_orphan_scene_lineage_stays_unacked() {
    let (_scratch, mut store) = test_store();
    store
        .read_with(|tx| {
            tx.execute(
                "INSERT INTO file_objects (workspace_id,object_id,created_at_ms) \
                 VALUES ('ws','orphan-scene-object',1)",
                [],
            )?;
            Ok::<_, rusqlite::Error>(())
        })
        .expect("seed orphan scene object");
    let key = DocKey::new("ws", "main", "orphan-scene-object").expect("scene key");
    let imported = dohc_engine_collab::import_portable_scene(
        &json!({
            "type": "excalidraw",
            "version": 2,
            "source": "https://excalidraw.com",
            "elements": [],
            "appState": {},
            "files": {}
        })
        .to_string(),
    )
    .expect("import scene");
    dohc_engine_collab::record_local_update(
        &mut store,
        &mut dohc_engine_collab::WriterDocCache::new(),
        &key,
        &imported.initial_update,
        dohc_engine_collab::LocalAppend {
            marker: Some(dohc_engine_collab::MarkerCreation {
                path: Some("drawings/orphan.excalidraw"),
                content_kind: YdocContentKind::Scene,
                regime: Regime::LocalOnly,
            }),
            ..Default::default()
        },
        &NoFaults,
        1_500,
        |_tx, _outcome, _update_sha| Ok(()),
    )
    .expect("seed orphan scene lineage");
    hydrate_texts(&mut store, &["remote scene", ""]);
    let delete = envelope(
        "orphan-scene-delete-peer",
        0,
        "ws",
        present_text_payload(
            "moment-delete-orphan-scene",
            "orphan-scene-object",
            "delete",
            "drawings/orphan.excalidraw",
            "drawings/orphan.excalidraw",
            "remote scene",
            "remote-scene-head",
            "",
        ),
    );

    assert!(matches!(
        apply_replication_envelope(
            &mut store,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &delete,
            &NoFaults,
            &NoLiveLeases
        ),
        Err(SyncError::RetryableState {
            reason: "ydoc-lineage-unsettled"
        })
    ));
    assert_eq!(
        read_replication_acked_seq(&store, "ws", "orphan-scene-delete-peer").expect("ack"),
        -1
    );
    let (snapshots, authorities): (i64, i64) = store
        .read_with(|conn| {
            Ok::<_, rusqlite::Error>((
                conn.query_row(
                    "SELECT COUNT(*) FROM snapshots WHERE workspace_id='ws' \
                     AND version_id='main' AND object_id='orphan-scene-object'",
                    [],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*) FROM scene_asset_delete_authorities WHERE workspace_id='ws' \
                     AND version_id='main' AND drawing_object_id='orphan-scene-object'",
                    [],
                    |row| row.get(0),
                )?,
            ))
        })
        .expect("inspect orphan scene");
    assert_eq!((snapshots, authorities), (0, 0));
    assert!(
        dohc_engine_collab::read_marker(&store, &key)
            .expect("read orphan scene marker")
            .is_some(),
        "the unacknowledged delete must preserve the orphan scene"
    );
}

#[test]
fn moment_delete_from_absent_sender_head_preserves_unsettled_lineage() {
    let (_scratch, mut store) = test_store();
    store
        .read_with(|tx| {
            tx.execute(
                "INSERT INTO file_objects (workspace_id,object_id,created_at_ms) \
                 VALUES ('ws','absent-delete-object',1)",
                [],
            )?;
            Ok::<_, rusqlite::Error>(())
        })
        .expect("seed unsettled object");
    let key = DocKey::new("ws", "main", "absent-delete-object").expect("Y.Doc key");
    let doc = Ydoc::wire();
    let update = doc.plaintext_insert(0, "only durable draft");
    dohc_engine_collab::record_local_update(
        &mut store,
        &mut dohc_engine_collab::WriterDocCache::new(),
        &key,
        &update,
        dohc_engine_collab::LocalAppend {
            marker: Some(dohc_engine_collab::MarkerCreation {
                path: Some("notes/absent.md"),
                content_kind: YdocContentKind::Plaintext,
                regime: Regime::LocalOnly,
            }),
            ..Default::default()
        },
        &NoFaults,
        1_500,
        |_tx, _outcome, _update_sha| Ok(()),
    )
    .expect("seed unsettled lineage");
    hydrate_texts(&mut store, &[""]);
    let mut payload = absent_text_payload(
        "moment-delete-absent",
        "absent-delete-object",
        "notes/absent.md",
        "",
    );
    payload["operation"] = json!("delete");
    let delete = envelope("absent-delete-peer", 0, "ws", payload);

    assert!(matches!(
        apply_replication_envelope(
            &mut store,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &delete,
            &NoFaults,
            &NoLiveLeases
        ),
        Err(SyncError::RetryableState {
            reason: "ydoc-lineage-unsettled"
        })
    ));
    assert_eq!(
        read_replication_acked_seq(&store, "ws", "absent-delete-peer").expect("ack"),
        -1
    );
    let (moments, updates, docs): (i64, i64, i64) = store
        .read_with(|conn| {
            Ok::<_, rusqlite::Error>((
                conn.query_row(
                    "SELECT COUNT(*) FROM moments WHERE workspace_id='ws' \
                     AND moment_id='moment-delete-absent'",
                    [],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*) FROM ydoc_updates WHERE workspace_id='ws' \
                     AND version_id='main' AND object_id='absent-delete-object'",
                    [],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*) FROM ydoc_docs WHERE workspace_id='ws' \
                     AND version_id='main' AND object_id='absent-delete-object'",
                    [],
                    |row| row.get(0),
                )?,
            ))
        })
        .expect("preserved unsettled lineage");
    assert_eq!((moments, updates, docs), (0, 1, 1));
}

#[test]
fn malformed_moment_append_is_refused_and_acked_before_the_origin_continues() {
    let (_scratch, mut store) = test_store();
    let malformed = envelope("malformed-moment-peer", 0, "ws", json!({}));

    assert_eq!(
        apply_replication_envelope(
            &mut store,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &malformed,
            &NoFaults,
            &crate::NoLiveLeases
        )
        .expect("malformed per-operation payload is a disposition"),
        ApplyOutcome::new(ApplyDisposition::Refused(ReplicationRefusal {
            workspace_id: "ws".to_owned(),
            origin_id: "malformed-moment-peer".to_owned(),
            origin_seq: 0,
            op_kind: "moment.append".to_owned(),
            reason: RefusalReason::InvalidInput {
                reason: "moment.append payload is malformed".to_owned(),
            },
        })),
        "parsing before apply_envelope_with returns a hard error and leaves seq 0 unacked"
    );
    assert_eq!(
        read_replication_acked_seq(&store, "ws", "malformed-moment-peer").expect("refusal ack"),
        0
    );

    let next = ReplicationEnvelope {
        settlement_admission: None,
        admitted_author_snapshot: None,
        workspace_id: "ws".to_owned(),
        origin_id: "malformed-moment-peer".to_owned(),
        origin_seq: 1,
        op_kind: "chat.channel.create".to_owned(),
        payload: json!({
            "channelId": "after-malformed-moment",
            "name": "Still moving",
            "slug": "still-moving",
            "kind": "channel",
            "createdAtMs": 2_001
        }),
        recorded_at_ms: 2_001,
        relay_seq: Some(1),
    };
    assert!(matches!(
        apply_replication_envelope(
            &mut store,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &next,
            &NoFaults,
            &crate::NoLiveLeases
        ),
        Ok(ApplyOutcome {
            primary: ApplyDisposition::Applied(_),
            refusals: ref outcome_refusals,
            sharing_declined: ref outcome_sharing_declined,
        }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
    ));
    let channel_rows: i64 = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM chat_channels
                 WHERE workspace_id='ws' AND channel_id='after-malformed-moment'",
                [],
                |row| row.get(0),
            )
        })
        .expect("next operation mutation");
    assert_eq!(channel_rows, 1);
    assert_eq!(
        read_replication_acked_seq(&store, "ws", "malformed-moment-peer").expect("next ack"),
        1
    );
}

#[test]
fn moment_append_head_fast_forward_write_delete_and_rename_updates_alias_snapshot_and_search() {
    let (_scratch, mut write_store) = test_store();
    hydrate_texts(&mut write_store, &["written"]);
    let write = envelope(
        "write-peer",
        0,
        "ws",
        absent_text_payload("remote-write", "object-write", "write.md", "written"),
    );
    assert_eq!(
        apply_moment_envelope(&mut write_store, &write, &NoFaults).expect("write"),
        ApplyOutcome::new(ApplyDisposition::Applied(0))
    );
    assert_eq!(
        snapshot(&write_store, "object-write"),
        Some((
            "write.md".to_owned(),
            "text".to_owned(),
            text_sha("written"),
            "remote-write".to_owned()
        ))
    );
    assert_eq!(aliases(&write_store, "object-write"), ["write.md"]);
    assert_eq!(
        indexed(&write_store, "object-write"),
        [("write.md".to_owned(), "written".to_owned())]
    );

    let (_scratch, mut delete_store) = test_store();
    seed_text_moment(
        &mut delete_store,
        "object-delete",
        "delete.md",
        "gone",
        "local-delete-head",
        None,
        true,
    );
    delete_store
        .read_with(|tx| {
            tx.execute(
                "INSERT INTO engine_search_files_fts \
                 (workspace_id,version_id,object_id,path,text) \
                 VALUES ('ws','main','object-delete','delete.md','gone')",
                [],
            )
        })
        .expect("seed search");
    let delete = envelope(
        "delete-peer",
        0,
        "ws",
        present_text_payload(
            "remote-delete",
            "object-delete",
            "delete",
            "delete.md",
            "delete.md",
            "gone",
            "local-delete-head",
            "gone",
        ),
    );
    assert_eq!(
        apply_moment_envelope(&mut delete_store, &delete, &NoFaults).expect("delete"),
        ApplyOutcome::new(ApplyDisposition::Applied(0))
    );
    assert_eq!(snapshot(&delete_store, "object-delete"), None);
    assert!(aliases(&delete_store, "object-delete").is_empty());
    assert!(indexed(&delete_store, "object-delete").is_empty());

    let (_scratch, mut rename_store) = test_store();
    seed_text_moment(
        &mut rename_store,
        "object-rename",
        "old.md",
        "same",
        "local-rename-head",
        None,
        true,
    );
    rename_store
        .read_with(|tx| {
            tx.execute(
                "INSERT INTO engine_search_files_fts \
                 (workspace_id,version_id,object_id,path,text) \
                 VALUES ('ws','main','object-rename','old.md','same')",
                [],
            )
        })
        .expect("seed search");
    let rename = envelope(
        "rename-peer",
        0,
        "ws",
        present_text_payload(
            "remote-rename",
            "object-rename",
            "rename",
            "peer-old.md",
            "new.md",
            "same",
            "local-rename-head",
            "same",
        ),
    );
    assert_eq!(
        apply_moment_envelope(&mut rename_store, &rename, &NoFaults).expect("rename"),
        ApplyOutcome::new(ApplyDisposition::Applied(0))
    );
    assert_eq!(
        aliases(&rename_store, "object-rename"),
        ["new.md"],
        "deleting the payloadBeforePath alias instead of the matched local head path leaves old.md behind beside the new live alias."
    );
    assert_eq!(
        snapshot(&rename_store, "object-rename").unwrap().0,
        "new.md"
    );
    assert_eq!(
        indexed(&rename_store, "object-rename"),
        [("new.md".to_owned(), "same".to_owned())]
    );
}

#[test]
fn fix1_remote_delete_releases_capture_hold() {
    let (_scratch, mut store) = test_store();
    seed_text_moment(
        &mut store,
        "object-delete",
        "delete.md",
        "before",
        "local-head",
        None,
        true,
    );
    let outside = format!("{} too deep\n", "> ".repeat(121));
    store.write_with(&NoFaults, |tx| tx.execute(
        "INSERT INTO capture_file_holds VALUES ('ws','main','object-delete','delete.md',?1,?2,'ydoc-resolution-not-representable',3,1,0)",
        params![text_sha(&outside), outside.len() as i64]).map_err(dohc_engine_storage::StorageError::persist_public)).unwrap();
    let delete = envelope(
        "delete-peer",
        0,
        "ws",
        present_text_payload(
            "remote-delete",
            "object-delete",
            "delete",
            "delete.md",
            "delete.md",
            "before",
            "local-head",
            "before",
        ),
    );
    assert_eq!(
        apply_moment_envelope(&mut store, &delete, &NoFaults).unwrap(),
        ApplyOutcome::new(ApplyDisposition::Applied(0))
    );
    assert!(
        store
            .read_with(|conn| dohc_engine_storage::capture_file_holds::hold_in(
                conn,
                "ws",
                "delete.md"
            ))
            .unwrap()
            .is_none()
    );
    let result = VersionedTextStore::new(&mut store)
        .capture_ingest(
            &dohc_engine_domain::CaptureIngest {
                workspace_id: "ws".into(),
                version_id: "main".into(),
                path: "delete.md".into(),
                text: "New outside file.\n".into(),
                metadata_origin: "capture".into(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 4_000,
                request_id: None,
                claim_foreign_head: false,
            },
            &NoFaults,
        )
        .unwrap();
    assert_eq!(result.snapshot.text, "New outside file.\n");
}

#[test]
fn moment_append_live_lease_blocks_all_mutations_and_write_waits_for_ydoc_rewrite() {
    for (operation, after_path, after_text) in [
        ("write", "head.md", "changed"),
        ("rename", "renamed.md", "before"),
        ("delete", "head.md", "before"),
    ] {
        let (_scratch, mut store) = test_store();
        let object_id = format!("live-{operation}-object");
        let origin_id = format!("live-{operation}-peer");
        let moment_id = format!("live-{operation}-moment");
        seed_text_moment(
            &mut store,
            &object_id,
            "head.md",
            "before",
            "local-head",
            None,
            true,
        );
        hydrate_texts(&mut store, &[after_text]);
        let key = DocKey::new("ws", "main", &object_id).expect("Y.Doc key");
        let doc = Ydoc::wire();
        let update = doc.plaintext_insert(0, "before");
        dohc_engine_collab::record_local_update(
            &mut store,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &key,
            &update,
            dohc_engine_collab::LocalAppend {
                marker: Some(dohc_engine_collab::MarkerCreation {
                    path: Some("head.md"),
                    content_kind: YdocContentKind::Plaintext,
                    regime: Regime::LocalOnly,
                }),
                ..Default::default()
            },
            &NoFaults,
            1_500,
            |_tx, _outcome, _update_sha| Ok(()),
        )
        .expect("seed live lineage");
        let op = envelope(
            &origin_id,
            0,
            "ws",
            present_text_payload(
                &moment_id,
                &object_id,
                operation,
                "head.md",
                after_path,
                "before",
                "local-head",
                after_text,
            ),
        );
        let before = (
            snapshot(&store, &object_id),
            aliases(&store, &object_id),
            indexed(&store, &object_id),
            store
                .read_with(|conn| {
                    Ok::<_, rusqlite::Error>((
                        conn.query_row(
                            "SELECT COUNT(*) FROM moments WHERE workspace_id='ws'",
                            [],
                            |row| row.get::<_, i64>(0),
                        )?,
                        conn.query_row(
                            "SELECT COUNT(*) FROM replication_log WHERE workspace_id='ws'",
                            [],
                            |row| row.get::<_, i64>(0),
                        )?,
                        conn.query_row(
                            "SELECT COUNT(*) FROM ydoc_updates WHERE workspace_id='ws' \
                             AND version_id='main' AND object_id=?1",
                            [&object_id],
                            |row| row.get::<_, i64>(0),
                        )?,
                        conn.query_row(
                            "SELECT COUNT(*) FROM ydoc_docs WHERE workspace_id='ws' \
                             AND version_id='main' AND object_id=?1",
                            [&object_id],
                            |row| row.get::<_, i64>(0),
                        )?,
                    ))
                })
                .expect("state before live apply"),
        );
        let leases = LeaseRegistry::new();
        let held = leases.acquire(&key).expect("hold document live");

        assert!(matches!(
            apply_replication_envelope(
                &mut store,
                &mut dohc_engine_collab::WriterDocCache::new(),
                &op,
                &NoFaults,
                &leases
            ),
            Err(SyncError::RetryableState {
                reason: "ydoc-session-live"
            })
        ));
        assert_eq!(
            read_replication_acked_seq(&store, "ws", &origin_id).expect("live ack"),
            -1,
            "{operation} must remain unacknowledged while its document is live"
        );
        let after_live = (
            snapshot(&store, &object_id),
            aliases(&store, &object_id),
            indexed(&store, &object_id),
            store
                .read_with(|conn| {
                    Ok::<_, rusqlite::Error>((
                        conn.query_row(
                            "SELECT COUNT(*) FROM moments WHERE workspace_id='ws'",
                            [],
                            |row| row.get::<_, i64>(0),
                        )?,
                        conn.query_row(
                            "SELECT COUNT(*) FROM replication_log WHERE workspace_id='ws'",
                            [],
                            |row| row.get::<_, i64>(0),
                        )?,
                        conn.query_row(
                            "SELECT COUNT(*) FROM ydoc_updates WHERE workspace_id='ws' \
                             AND version_id='main' AND object_id=?1",
                            [&object_id],
                            |row| row.get::<_, i64>(0),
                        )?,
                        conn.query_row(
                            "SELECT COUNT(*) FROM ydoc_docs WHERE workspace_id='ws' \
                             AND version_id='main' AND object_id=?1",
                            [&object_id],
                            |row| row.get::<_, i64>(0),
                        )?,
                    ))
                })
                .expect("state after live apply"),
        );
        assert_eq!(after_live, before, "live {operation} mutated durable state");

        drop(held);
        let closed = apply_replication_envelope(
            &mut store,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &op,
            &NoFaults,
            &leases,
        );
        if operation == "write" {
            assert!(matches!(
                closed,
                Err(SyncError::RetryableState {
                    reason: "ydoc-resulting-head-pending"
                })
            ));
            assert_eq!(
                read_replication_acked_seq(&store, "ws", &origin_id).expect("write ack"),
                -1,
                "the write must wait unacknowledged for its canonical Y.Doc rewrite"
            );
            assert_eq!(
                snapshot(&store, &object_id).unwrap().3,
                "local-head",
                "the premature write must roll back"
            );
            continue;
        }
        assert!(matches!(
            closed,
            Ok(ApplyOutcome {
                primary: ApplyDisposition::Applied(_),
                refusals: ref outcome_refusals,
                sharing_declined: ref outcome_sharing_declined,
            }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
        ));
        match operation {
            "delete" => assert_eq!(snapshot(&store, &object_id), None),
            "rename" => assert_eq!(snapshot(&store, &object_id).unwrap().0, "renamed.md"),
            _ => unreachable!(),
        }
    }
}

#[test]
fn open_document_covered_settlement_is_history_only_with_crash_replay() {
    assert_covered_artifact_crash_replay(true);
}

#[test]
fn covered_artifact_is_history_only_with_live_edits_and_crash_replay() {
    assert_covered_artifact_crash_replay(false);
}

fn assert_covered_artifact_crash_replay(changed: bool) {
    use dohc_engine_storage::FaultPoint;
    use dohc_engine_testkit::ScriptedFaults;
    for advanced in [false, true] {
        for point in [
            FaultPoint::SyncBeforeApplyCommit,
            FaultPoint::StorageAfterCommitBeforeAck,
        ] {
            let (scratch, mut store) = test_store();
            let key = DocKey::new("ws", "main", "object").unwrap();
            let doc = Ydoc::wire();
            doc.plaintext_insert(0, "artifact");
            let sha = store.put_binary_blob(&doc.encode_full_state()).unwrap();
            let base = ReplicationEnvelope {
                settlement_admission: None,
                admitted_author_snapshot: None,
                workspace_id: "ws".into(),
                origin_id: "peer".into(),
                origin_seq: 0,
                op_kind: "ydoc.update".into(),
                recorded_at_ms: 1_500,
                relay_seq: Some(1),
                payload: json!({"versionId":"main","objectId":"object","path":"head.md",
                    "contentKind":"plaintext","updateBlobSha256":sha,"lineageClaimId":sha,"isBaseState":true}),
            };
            apply_ydoc_envelope(
                &mut store,
                &mut Default::default(),
                &base,
                &NoFaults,
                &NoLiveLeases,
            )
            .unwrap();
            if advanced {
                VersionedTextStore::new(&mut store)
                    .write_text(
                        &WriteText {
                            workspace_id: "ws".into(),
                            version_id: "main".into(),
                            object_id: "object".into(),
                            path: "head.md".into(),
                            text: "artifact plus peer edits".into(),
                            moment_id: "peer-edit".into(),
                            metadata_origin: "ydoc".into(),
                            metadata_summary: None,
                            metadata_correlation_id: None,
                            author_json: None,
                            now_ms: 1_600,
                            request_id: None,
                        },
                        &NoFaults,
                    )
                    .unwrap();
                let foreign = envelope(
                    "other-lineage",
                    0,
                    "ws",
                    absent_text_payload("foreign-artifact", "object", "head.md", "artifact"),
                );
                assert!(matches!(
                    crate::apply_moment_envelope_detailed(
                        &mut store,
                        &foreign,
                        &NoFaults,
                        &crate::AlwaysLive
                    ),
                    Err(SyncError::RetryableState {
                        reason: "ydoc-session-live"
                    })
                ));
            }
            let disk = scratch.path().join("head.md");
            let disk_before = "artifact on disk";
            std::fs::write(&disk, disk_before).unwrap();
            let jobs = |store: &EngineStore| {
                store
                    .read_with(|conn| {
                        conn.query_row("SELECT COUNT(*) FROM materialization_jobs", [], |r| {
                            r.get::<_, i64>(0)
                        })
                    })
                    .unwrap()
            };
            let jobs_before = jobs(&store);
            let before = (
                snapshot(&store, "object"),
                aliases(&store, "object"),
                indexed(&store, "object"),
            );
            let leases = LeaseRegistry::new();
            let held = leases.acquire(&key).unwrap();
            held.bind_claim(base.payload["lineageClaimId"].as_str())
                .unwrap();
            let (seq, artifact) = if changed {
                let delta = doc.plaintext_insert(8, " settled on peer");
                let sha = store.put_binary_blob(&delta).unwrap();
                let mut update = base.clone();
                update.origin_seq = 1;
                update.payload["updateBlobSha256"] = json!(sha);
                update.payload["isBaseState"] = json!(false);
                apply_ydoc_envelope(
                    &mut store,
                    &mut Default::default(),
                    &update,
                    &NoFaults,
                    &leases,
                )
                .unwrap();
                hydrate_texts(&mut store, &["artifact settled on peer"]);
                (2, "artifact settled on peer")
            } else {
                (1, "artifact")
            };
            let op = envelope(
                "peer",
                seq,
                "ws",
                absent_text_payload(
                    "moment-ydoc-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                    "object",
                    "head.md",
                    artifact,
                ),
            );
            let faults = ScriptedFaults::crash_at(point);
            let result =
                crate::apply_moment_envelope_detailed(&mut store, &op, faults.as_ref(), &leases)
                    .unwrap();
            assert!(matches!(result.primary, ApplyDisposition::Crashed { .. }));
            assert!(faults.fired());
            drop(store);
            let mut store = EngineStore::open(&engine_db_path(&scratch).unwrap(), 2_100).unwrap();
            let committed: (i64, i64, i64) = store.read_with(|conn|conn.query_row("SELECT (SELECT COUNT(*) FROM moments WHERE moment_id='moment-ydoc-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), (SELECT COUNT(*) FROM replication_log WHERE origin_id='peer' AND origin_seq=?1), (SELECT COUNT(*) FROM ydoc_pending_artifacts)", [seq], |r|Ok((r.get(0)?,r.get(1)?,r.get(2)?)))).unwrap();
            let durable = point == FaultPoint::StorageAfterCommitBeforeAck;
            assert_eq!(
                committed,
                if durable {
                    (1, 1, i64::from(changed || advanced))
                } else {
                    (0, 0, 0)
                }
            );
            assert_eq!(
                read_replication_acked_seq(&store, "ws", "peer").unwrap(),
                if durable { seq } else { seq - 1 }
            );
            let result =
                crate::apply_moment_envelope_detailed(&mut store, &op, &NoFaults, &leases).unwrap();
            if let ApplyDisposition::Applied(applied) = result.primary {
                assert_eq!(applied.conflicts_opened, 0);
                assert!(applied.materialization_changes.is_empty());
            } else {
                assert!(matches!(result.primary, ApplyDisposition::Skipped));
            }
            assert_eq!(
                (
                    snapshot(&store, "object"),
                    aliases(&store, "object"),
                    indexed(&store, "object")
                ),
                before
            );
            assert_eq!(
                read_replication_acked_seq(&store, "ws", "peer").unwrap(),
                seq
            );
            assert!(conflict_ids(&store).is_empty());
            assert_eq!(std::fs::read_to_string(&disk).unwrap(), disk_before);
            assert_eq!(jobs(&store), jobs_before);
            let rows:i64 = store.read_with(|conn|conn.query_row(
                "SELECT COUNT(*) FROM moments WHERE moment_id='moment-ydoc-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' AND sync_record_only=1", [], |r|r.get(0))).unwrap();
            assert_eq!(rows, 1);
            assert!(matches!(
                crate::apply_moment_envelope_detailed(&mut store, &op, &NoFaults, &leases)
                    .unwrap()
                    .primary,
                ApplyDisposition::Skipped
            ));
            let journaled: i64 = store.read_with(|conn| conn.query_row("SELECT COUNT(*) FROM replication_log WHERE origin_id='peer' AND origin_seq=?1", [seq], |r| r.get(0))).unwrap();
            assert_eq!(journaled, 1);
            assert!(
                crate::moment_apply::stored_materialization_changes(&store, &op)
                    .unwrap()
                    .is_empty()
            );
            let persisted = store
                .read_with(|conn| dohc_engine_collab::load_doc_in(conn, &key))
                .unwrap();
            assert_eq!(
                persisted
                    .project(YdocContentKind::Plaintext)
                    .unwrap()
                    .content,
                "artifact"
            );
        }
    }
}

#[test]
fn open_document_uncovered_or_structural_moments_still_hold() {
    for case in [
        "rename",
        "write-path-change",
        "delete",
        "binary",
        "drawing",
        "refused",
        "foreign",
        "missing",
        "session-predecessor",
        "other-version",
        "bound-owner",
        "occupied",
        "unclaimed",
    ] {
        assert_open_document_exclusion(case);
    }
}

fn assert_open_document_exclusion(case: &str) {
    let (_scratch, mut store) = test_store();
    let mut owner_scratch = None;
    let key = DocKey::new("ws", "main", "object").unwrap();
    let doc = Ydoc::wire();
    let path = if case == "drawing" {
        "drawing.excalidraw"
    } else {
        "head.md"
    };
    let bytes = if case == "drawing" {
        dohc_engine_collab::import_portable_scene(&json!({"type":"excalidraw", "version":2, "source":"https://excalidraw.com", "elements":[], "appState":{}, "files":{}}).to_string()).unwrap().initial_update
    } else {
        doc.plaintext_insert(0, "before")
    };
    let sha = store.put_binary_blob(&bytes).unwrap();
    let base = ReplicationEnvelope {
        op_kind: "ydoc.update".into(),
        relay_seq: Some(1),
        payload: json!({"versionId":"main","objectId":"object","path":path,"contentKind":if case == "drawing" { "scene" } else { "plaintext" },"updateBlobSha256":sha,"lineageClaimId":sha,"isBaseState":true}),
        ..envelope("peer", 0, "ws", json!({}))
    };
    apply_ydoc_envelope(
        &mut store,
        &mut Default::default(),
        &base,
        &NoFaults,
        &NoLiveLeases,
    )
    .unwrap();
    hydrate_texts(&mut store, &["changed"]);
    let mut op = envelope(
        "peer",
        1,
        "ws",
        absent_text_payload(
            "moment-ydoc-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "object",
            path,
            "changed",
        ),
    );
    match case {
        "rename" => {
            let before = snapshot(&store, "object").unwrap();
            let text: String = store
                .read_with(|conn| {
                    conn.query_row("SELECT text FROM blobs WHERE sha256=?1", [&before.2], |r| {
                        r.get(0)
                    })
                })
                .unwrap();
            op.payload = present_text_payload(
                "moment-ydoc-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                "object",
                "rename",
                path,
                "renamed.md",
                &text,
                &before.3,
                &text,
            );
        }
        "write-path-change" => {
            op.payload["payloadBeforePath"] = json!("old.md");
            op.payload["payloadBeforeBlobSha256"] = json!(text_sha("changed"));
        }
        "delete" => {
            let before = snapshot(&store, "object").unwrap();
            let text: String = store
                .read_with(|conn| {
                    conn.query_row("SELECT text FROM blobs WHERE sha256=?1", [&before.2], |r| {
                        r.get(0)
                    })
                })
                .unwrap();
            op.payload = present_text_payload(
                "moment-ydoc-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                "object",
                "delete",
                path,
                path,
                &text,
                &before.3,
                &text,
            );
        }
        "binary" => {
            let binary = store.put_binary_blob(&[0, 255]).unwrap();
            op.payload["payloadAfterContentKind"] = json!("binary");
            op.payload["payloadAfterBlobSha256"] = json!(binary);
        }
        "refused" | "dismissed-refusal" | "foreign" | "session-predecessor" => {
            let mut latest = base.clone();
            latest.origin_seq = 1;
            latest.payload["isBaseState"] = json!(false);
            let successor = Ydoc::wire();
            successor.plaintext_insert(0, "successor");
            let successor_claim = store
                .put_binary_blob(&successor.encode_full_state())
                .unwrap();
            if !matches!(case, "refused" | "dismissed-refusal") {
                latest.payload["lineageClaimId"] = json!(successor_claim);
            }
            let result = crate::apply_envelope_with(&mut store, &latest, &NoFaults, |_, _| {
                if matches!(case, "refused" | "dismissed-refusal") {
                    Err(SyncError::LiveDocumentBindingActive)
                } else {
                    Ok(())
                }
            })
            .unwrap();
            assert!(matches!(
                result.primary,
                ApplyDisposition::Applied(()) | ApplyDisposition::Refused(_)
            ));
            if case == "session-predecessor" {
                store
                    .read_with(|conn| {
                        conn.execute(
                            "UPDATE ydoc_docs SET lineage_claim_id=?1 WHERE object_id='object'",
                            [successor_claim],
                        )
                    })
                    .unwrap();
            }
            op.origin_seq = 2;
        }
        "unclaimed" => {
            store.read_with(|conn|conn.execute("UPDATE ydoc_docs SET lineage_claim_status='unclaimed',lineage_claim_id=NULL WHERE object_id='object'", [])).unwrap();
        }
        "missing" => {
            op.origin_id = "other-peer".into();
            op.origin_seq = 0;
        }
        "bound-owner" => {
            op.payload["momentId"] = json!("bound-owner-held");
            let owner = restore_owner();
            store = owner.store;
            owner_scratch = Some(owner._scratch);
            let claim = dohc_engine_collab::read_marker(&store, &key)
                .unwrap()
                .unwrap()
                .lineage_claim_id
                .unwrap();
            let mut latest = base.clone();
            latest.payload["lineageClaimId"] = json!(claim);
            crate::apply_envelope_with(&mut store, &latest, &NoFaults, |_, _| Ok(())).unwrap();
            hydrate_texts(&mut store, &["changed"]);
            op.payload["path"] = json!("owner.md");
            op.payload["payloadAfterPath"] = json!("owner.md");
        }
        "occupied" => {
            store.read_with(|conn| conn.execute_batch("UPDATE snapshots SET path='elsewhere.md' WHERE object_id='object'; UPDATE path_aliases SET path='elsewhere.md' WHERE object_id='object';")).unwrap();
            seed_text_moment(
                &mut store,
                "occupant",
                path,
                "occupant",
                "occupant-head",
                None,
                true,
            );
        }
        _ => {}
    }
    if case == "bare-write" {
        op.payload["momentId"] = json!("bare-write");
    }
    if case == "dismissed-refusal" {
        store
            .read_with(|conn| conn.execute("DELETE FROM replication_pending_refusals", []))
            .unwrap();
    }

    let leases = LeaseRegistry::new();
    let held_key = if case == "other-version" {
        DocKey::new("ws", "fork", "object").unwrap()
    } else {
        key.clone()
    };
    let held = leases.acquire(&held_key).unwrap();
    let claim = dohc_engine_collab::read_marker(&store, &key)
        .unwrap()
        .unwrap()
        .lineage_claim_id
        .unwrap_or(sha.clone());
    held.bind_claim(Some(if case == "session-predecessor" {
        &sha
    } else {
        &claim
    }))
    .unwrap();
    if case == "parked-successor" {
        let successor = Ydoc::wire();
        successor.plaintext_insert(0, "successor");
        let successor_sha = store
            .put_binary_blob(&successor.encode_full_state())
            .unwrap();
        let foreign = ReplicationEnvelope {
            origin_id: "successor-peer".into(),
            origin_seq: 0,
            relay_seq: Some(2),
            payload: json!({"versionId":"main","objectId":"object","path":path,"contentKind":"plaintext",
                "updateBlobSha256":successor_sha,"lineageClaimId":successor_sha,"isBaseState":true}),
            ..base.clone()
        };
        apply_ydoc_envelope(
            &mut store,
            &mut Default::default(),
            &foreign,
            &NoFaults,
            &leases,
        )
        .unwrap();
        let delta_sha = store
            .put_binary_blob(&doc.plaintext_insert(6, " changed"))
            .unwrap();
        let queued = ReplicationEnvelope {
            origin_seq: 1,
            relay_seq: Some(3),
            payload: json!({"versionId":"main","objectId":"object","path":path,"contentKind":"plaintext",
                "updateBlobSha256":delta_sha,"lineageClaimId":sha,"isBaseState":false}),
            ..base.clone()
        };
        apply_ydoc_envelope(
            &mut store,
            &mut Default::default(),
            &queued,
            &NoFaults,
            &leases,
        )
        .unwrap();
        hydrate_texts(&mut store, &["before changed"]);
        op.origin_seq = 2;
        op.payload["payloadAfterBlobSha256"] = json!(text_sha("before changed"));
        let parked: i64 = store
            .read_with(|conn| {
                conn.query_row("SELECT COUNT(*) FROM ydoc_deferred_updates", [], |r| {
                    r.get(0)
                })
            })
            .unwrap();
        assert_eq!(parked, 2);
    }
    let before = (
        snapshot(&store, "object"),
        aliases(&store, "object"),
        indexed(&store, "object"),
    );
    let ack = read_replication_acked_seq(&store, "ws", &op.origin_id).unwrap();
    assert!(
        matches!(
            crate::apply_moment_envelope_detailed(&mut store, &op, &NoFaults, &leases),
            Err(SyncError::RetryableState {
                reason: "ydoc-session-live"
            })
        ),
        "{case}"
    );
    assert_eq!(
        read_replication_acked_seq(&store, "ws", &op.origin_id).unwrap(),
        ack,
        "{case}"
    );
    assert_eq!(
        (
            snapshot(&store, "object"),
            aliases(&store, "object"),
            indexed(&store, "object")
        ),
        before,
        "{case}"
    );
    assert!(conflict_ids(&store).is_empty(), "{case}");
    drop(store);
    drop(owner_scratch);
}

#[test]
fn moment_append_equal_text_for_bound_owner_keeps_live_binding_checks() {
    let RestoreOwner {
        _scratch,
        mut store,
        initial_text,
        initial_moment,
        ..
    } = restore_owner();
    let key = DocKey::new("ws", "main", "object").unwrap();
    let before = snapshot(&store, "object");
    let op = envelope(
        "unaudited-peer",
        0,
        "ws",
        present_text_payload(
            "unaudited-equal-moment",
            "object",
            "write",
            "owner.md",
            "owner.md",
            &initial_text,
            &initial_moment,
            &initial_text,
        ),
    );
    let leases = LeaseRegistry::new();
    let held = leases.acquire(&key).unwrap();
    assert!(matches!(
        crate::apply_moment_envelope_detailed(&mut store, &op, &NoFaults, &leases),
        Err(SyncError::RetryableState {
            reason: "ydoc-session-live"
        })
    ));
    assert_eq!(
        read_replication_acked_seq(&store, "ws", "unaudited-peer").unwrap(),
        -1
    );
    assert_eq!(store.table_row_count("moments").unwrap(), 1);

    drop(held);
    let result =
        crate::apply_moment_envelope_detailed(&mut store, &op, &NoFaults, &leases).unwrap();
    assert!(matches!(
        result.primary,
        ApplyDisposition::Refused(ReplicationRefusal {
            reason: RefusalReason::InvalidInput { ref reason },
            ..
        }) if reason == "live document binding is still active"
    ));
    assert_eq!(store.table_row_count("moments").unwrap(), 1);
    assert_eq!(
        store.table_row_count("owner_pending_settlements").unwrap(),
        0
    );
    assert_eq!(snapshot(&store, "object"), before);
}

#[test]
fn moment_append_equal_text_is_history_only_at_the_same_path() {
    let (_scratch, mut store) = test_store();
    seed_text_moment(
        &mut store,
        "object",
        "same.md",
        "converged",
        "local-head",
        None,
        true,
    );
    hydrate_texts(&mut store, &["remote-before", "converged"]);
    let op = envelope(
        "peer",
        0,
        "ws",
        present_text_payload(
            "remote-head",
            "object",
            "write",
            "same.md",
            "same.md",
            "remote-before",
            "remote-before-head",
            "converged",
        ),
    );
    assert_eq!(
        apply_moment_envelope(&mut store, &op, &NoFaults).expect("converge"),
        ApplyOutcome::new(ApplyDisposition::Applied(0))
    );
    assert_eq!(snapshot(&store, "object").unwrap().3, "local-head");
    assert!(conflict_ids(&store).is_empty());
}

#[test]
fn moment_append_equal_binary_is_history_only_at_the_same_path() {
    let (_scratch, mut store) = test_store();
    let bytes = b"\0same binary\xff";
    let sha = seed_binary_head(&mut store, "binary-object", "same.bin", bytes, "local-bin");
    let payload = json!({
        "momentId": "remote-bin",
        "versionId": "main",
        "objectId": "binary-object",
        "path": "same.bin",
        "recordedAtMs": 2_000,
        "operation": "write",
        "payloadBeforeBlobSha256": sha,
        "payloadBeforePath": "same.bin",
        "payloadBeforeContentKind": "binary",
        "payloadBeforeByteLength": bytes.len(),
        "payloadAfterBlobSha256": sha,
        "payloadAfterPath": "same.bin",
        "payloadAfterContentKind": "binary",
        "payloadAfterByteLength": bytes.len(),
        "metadata": {"origin": "sync"},
        "beforePresent": "present",
        "beforeObjectId": "binary-object",
        "beforeVersionId": "main",
        "beforePath": "same.bin",
        "beforeBlobSha256": sha,
        "beforeContentKind": "binary",
        "beforeByteLength": bytes.len(),
        "beforeUpdatedAtMs": 100,
        "beforeLatestMomentId": "remote-before-bin",
        "beforeMetadata": {"origin": "api"}
    });
    let op = envelope("peer", 0, "ws", payload);
    assert_eq!(
        apply_moment_envelope(&mut store, &op, &NoFaults).expect("binary converge"),
        ApplyOutcome::new(ApplyDisposition::Applied(0))
    );
    let head = snapshot(&store, "binary-object").unwrap();
    assert_eq!(head.0, "same.bin");
    assert_eq!(head.1, "binary");
    assert_eq!(head.2, sha);
    assert_eq!(head.3, "local-bin");
    assert!(indexed(&store, "binary-object").is_empty());
}

#[test]
fn file_successor_of_history_only_artifact_adopts_the_local_preimage() {
    let (_scratch, mut store) = test_store();
    seed_text_moment(
        &mut store,
        "object",
        "same.md",
        "agreed",
        "local-head",
        None,
        true,
    );
    hydrate_texts(&mut store, &["next"]);
    let artifact = envelope(
        "peer",
        0,
        "ws",
        absent_text_payload("remote-artifact", "object", "same.md", "agreed"),
    );
    apply_moment_envelope(&mut store, &artifact, &NoFaults).unwrap();
    assert_eq!(snapshot(&store, "object").unwrap().3, "local-head");
    let next = envelope(
        "peer",
        1,
        "ws",
        present_text_payload(
            "remote-next",
            "object",
            "write",
            "same.md",
            "same.md",
            "agreed",
            "remote-artifact",
            "next",
        ),
    );
    assert_eq!(
        apply_moment_envelope(&mut store, &next, &NoFaults).unwrap(),
        ApplyOutcome::new(ApplyDisposition::Applied(0))
    );
    assert_eq!(snapshot(&store, "object").unwrap().3, "remote-next");
    let before: String = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT before_latest_moment_id FROM moments WHERE moment_id='remote-next'",
                [],
                |r| r.get(0),
            )
        })
        .unwrap();
    assert_eq!(before, "local-head");
}

#[test]
fn moment_append_same_bytes_at_a_different_path_conflicts_instead_of_converging() {
    let (_scratch, mut store) = test_store();
    seed_text_moment(
        &mut store,
        "object",
        "local.md",
        "same bytes",
        "local-head",
        None,
        true,
    );
    hydrate_texts(&mut store, &["remote-before", "same bytes"]);
    let op = envelope(
        "peer",
        0,
        "ws",
        present_text_payload(
            "remote-head",
            "object",
            "rename",
            "remote-old.md",
            "remote.md",
            "remote-before",
            "remote-before-head",
            "same bytes",
        ),
    );
    assert_eq!(
        apply_moment_envelope(&mut store, &op, &NoFaults).expect("diverge"),
        ApplyOutcome::new(ApplyDisposition::Applied(1))
    );
    assert_eq!(snapshot(&store, "object").unwrap().0, "local.md");
    assert_eq!(conflict_ids(&store).len(), 1);
}

#[test]
fn moment_append_equal_content_keeps_remote_history_and_wire_payload() {
    let (_scratch, mut store) = test_store();
    seed_text_moment(
        &mut store,
        "object",
        "same.md",
        "agreed",
        "local-head",
        None,
        true,
    );
    hydrate_texts(&mut store, &["remote-old", "agreed"]);
    let op = envelope(
        "peer",
        0,
        "ws",
        present_text_payload(
            "remote-adopted",
            "object",
            "write",
            "same.md",
            "same.md",
            "remote-old",
            "remote-old-head",
            "agreed",
        ),
    );
    let wire = op.payload_json().expect("wire json");
    assert_eq!(
        apply_moment_envelope(&mut store, &op, &NoFaults).expect("adopt"),
        ApplyOutcome::new(ApplyDisposition::Applied(0))
    );
    store
        .read_with(|conn| {
            let before: (String, String, Option<i64>) = conn.query_row(
                "SELECT before_blob_sha256,before_latest_moment_id,sync_record_only \
                 FROM moments WHERE workspace_id='ws' AND moment_id='remote-adopted'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )?;
            assert_eq!(before.0, text_sha("remote-old"));
            assert_eq!(before.1, "remote-old-head");
            assert_eq!(before.2, Some(1));
            let journal: String = conn.query_row(
                "SELECT payload_json FROM replication_log \
                 WHERE workspace_id='ws' AND origin_id='peer' AND origin_seq=0",
                [],
                |row| row.get(0),
            )?;
            assert_eq!(journal, wire);
            Ok::<_, rusqlite::Error>(())
        })
        .expect("adopted row");
}

#[test]
fn moment_append_both_sides_deleted_is_record_only_and_touches_no_search_state() {
    let (_scratch, mut store) = test_store();
    hydrate_texts(&mut store, &["deleted"]);
    store
        .read_with(|tx| {
            tx.execute(
                "INSERT INTO engine_search_files_fts \
                 (workspace_id,version_id,object_id,path,text) \
                 VALUES ('ws','main','deleted-object','deleted.md','stale sentinel')",
                [],
            )
        })
        .expect("search sentinel");
    let op = envelope(
        "peer",
        0,
        "ws",
        present_text_payload(
            "remote-delete",
            "deleted-object",
            "delete",
            "deleted.md",
            "deleted.md",
            "deleted",
            "remote-before",
            "deleted",
        ),
    );
    assert_eq!(
        apply_moment_envelope(&mut store, &op, &NoFaults).expect("both deleted"),
        ApplyOutcome::new(ApplyDisposition::Applied(0))
    );
    assert_eq!(snapshot(&store, "deleted-object"), None);
    assert_eq!(
        indexed(&store, "deleted-object"),
        [("deleted.md".to_owned(), "stale sentinel".to_owned())]
    );
    let record_only: i64 = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT sync_record_only FROM moments \
                 WHERE workspace_id='ws' AND moment_id='remote-delete'",
                [],
                |row| row.get(0),
            )
        })
        .expect("record-only marker");
    assert_eq!(record_only, 1);
    assert!(conflict_ids(&store).is_empty());
}

#[test]
fn moment_append_divergence_opens_one_duplicate_envelope_skips_and_next_head_coalesces() {
    let (_scratch, mut store) = test_store();
    seed_text_lineage(
        &mut store,
        "object",
        "doc.md",
        "base",
        "base-moment",
        "local",
        "local-root",
    );
    hydrate_texts(
        &mut store,
        &["base", "payload-before", "remote-one", "remote-two"],
    );
    let mut first_payload = present_text_payload(
        "remote-root",
        "object",
        "write",
        "doc.md",
        "doc.md",
        "base",
        "base-moment",
        "remote-one",
    );
    first_payload["payloadBeforeBlobSha256"] = json!(text_sha("payload-before"));
    first_payload["payloadBeforePath"] = json!("payload-before.md");
    let first = envelope("peer", 0, "ws", first_payload);
    assert_eq!(
        apply_moment_envelope(&mut store, &first, &NoFaults).expect("first"),
        ApplyOutcome::new(ApplyDisposition::Applied(1))
    );
    store
        .read_with(|conn| {
            let base: (i64, String, Option<String>, String, Option<String>) = conn.query_row(
                "SELECT base_exists,base_path,base_object_id,base_blob_sha256,
                        base_latest_moment_id
                 FROM conflicts WHERE workspace_id='ws'",
                [],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )?;
            assert_eq!(
                base,
                (
                    1,
                    "doc.md".to_owned(),
                    Some("object".to_owned()),
                    text_sha("base"),
                    Some("base-moment".to_owned())
                )
            );
            Ok::<_, rusqlite::Error>(())
        })
        .expect("wire before conflict base");
    assert_eq!(
        apply_moment_envelope(&mut store, &first, &NoFaults).expect("duplicate envelope"),
        ApplyOutcome::new(ApplyDisposition::Skipped)
    );
    let second = envelope(
        "peer",
        1,
        "ws",
        present_text_payload(
            "remote-next",
            "object",
            "write",
            "doc.md",
            "doc.md",
            "remote-one",
            "remote-root",
            "remote-two",
        ),
    );
    assert_eq!(
        apply_moment_envelope(&mut store, &second, &NoFaults).expect("coalesce"),
        ApplyOutcome::new(ApplyDisposition::Applied(0))
    );
    assert_eq!(conflict_ids(&store).len(), 1);
    let incoming: String = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT incoming_latest_moment_id FROM conflicts WHERE workspace_id='ws'",
                [],
                |row| row.get(0),
            )
        })
        .expect("incoming head");
    assert_eq!(incoming, "remote-next");
}

#[test]
fn moment_append_deterministic_conflict_id_is_identical_when_branch_roots_are_swapped() {
    let (_a, mut left) = test_store();
    let (_b, mut right) = test_store();
    seed_text_lineage(
        &mut left,
        "object",
        "doc.md",
        "base",
        "base-moment",
        "left",
        "left-root",
    );
    seed_text_lineage(
        &mut right,
        "object",
        "doc.md",
        "base",
        "base-moment",
        "right",
        "right-root",
    );
    hydrate_texts(&mut left, &["base", "right"]);
    hydrate_texts(&mut right, &["base", "left"]);
    let right_into_left = envelope(
        "right-peer",
        0,
        "ws",
        present_text_payload(
            "right-root",
            "object",
            "write",
            "doc.md",
            "doc.md",
            "base",
            "base-moment",
            "right",
        ),
    );
    let left_into_right = envelope(
        "left-peer",
        0,
        "ws",
        present_text_payload(
            "left-root",
            "object",
            "write",
            "doc.md",
            "doc.md",
            "base",
            "base-moment",
            "left",
        ),
    );
    assert_eq!(
        apply_moment_envelope(&mut left, &right_into_left, &NoFaults).expect("left"),
        ApplyOutcome::new(ApplyDisposition::Applied(1))
    );
    assert_eq!(
        apply_moment_envelope(&mut right, &left_into_right, &NoFaults).expect("right"),
        ApplyOutcome::new(ApplyDisposition::Applied(1))
    );
    assert_eq!(conflict_ids(&left), conflict_ids(&right));
    assert_eq!(conflict_ids(&left).len(), 1);
}

#[test]
fn moment_append_occupancy_divergence_returns_two_distinct_conflicts() {
    let (_scratch, mut store) = test_store();
    seed_text_lineage(
        &mut store,
        "mover",
        "source.md",
        "base",
        "base-moment",
        "local mover",
        "local-root",
    );
    seed_text_moment(
        &mut store,
        "occupant",
        "destination.md",
        "occupied",
        "occupant-head",
        None,
        true,
    );
    hydrate_texts(&mut store, &["base", "incoming mover"]);
    let op = envelope(
        "peer",
        0,
        "ws",
        present_text_payload(
            "remote-move",
            "mover",
            "rename",
            "source.md",
            "destination.md",
            "base",
            "base-moment",
            "incoming mover",
        ),
    );
    assert_eq!(
        apply_moment_envelope(&mut store, &op, &NoFaults).expect("occupancy"),
        ApplyOutcome::new(ApplyDisposition::Applied(2))
    );
    let ids = conflict_ids(&store);
    assert_eq!(ids.len(), 2);
    assert_ne!(ids[0], ids[1]);
    assert_eq!(snapshot(&store, "mover").unwrap().0, "source.md");
    assert_eq!(snapshot(&store, "occupant").unwrap().0, "destination.md");
}

#[test]
fn moment_append_record_only_divergence_is_not_a_head_and_cannot_be_rolled_back() {
    let (_scratch, mut store) = test_store();
    seed_text_lineage(
        &mut store,
        "object",
        "doc.md",
        "base",
        "base-moment",
        "local",
        "local-root",
    );
    hydrate_texts(&mut store, &["base", "remote"]);
    let op = envelope(
        "peer",
        0,
        "ws",
        present_text_payload(
            "remote-record-only",
            "object",
            "write",
            "doc.md",
            "doc.md",
            "base",
            "base-moment",
            "remote",
        ),
    );
    assert_eq!(
        apply_moment_envelope(&mut store, &op, &NoFaults).expect("diverge"),
        ApplyOutcome::new(ApplyDisposition::Applied(1))
    );
    assert_eq!(snapshot(&store, "object").unwrap().3, "local-root");
    let record_only: i64 = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT sync_record_only FROM moments \
                 WHERE workspace_id='ws' AND moment_id='remote-record-only'",
                [],
                |row| row.get(0),
            )
        })
        .expect("record-only marker");
    assert_eq!(record_only, 1);
    let error = VersionedTextStore::new(&mut store)
        .rollback_text_file_mutation(
            &RollbackTextFileMutation {
                workspace_id: "ws".to_owned(),
                version_id: "main".to_owned(),
                path: "doc.md".to_owned(),
                mutation_moment_id: "remote-record-only".to_owned(),
                request_id: None,
                metadata_origin: "restore".to_owned(),
                author_json: None,
            },
            &NoFaults,
        )
        .expect_err("record-only rollback");
    assert_eq!(error.code(), "invalid-input");
}

#[test]
fn moment_append_after_a_shipped_fork_head_rolls_back_after_reopen() {
    let (scratch, mut store) = test_store();
    hydrate_texts(&mut store, &["shipped", "remote edit"]);
    let shipped_sha = text_sha("shipped");
    let version = ReplicationEnvelope {
        settlement_admission: None,
        admitted_author_snapshot: None,
        workspace_id: "ws".to_owned(),
        origin_id: "version-peer".to_owned(),
        origin_seq: 0,
        op_kind: "version.create".to_owned(),
        payload: json!({
            "versionId": "feature",
            "name": "Feature",
            "kind": "named",
            "forkVersionId": "main",
            "forkMomentId": "fork-point",
            "createdAtMs": 1_500,
            "forkSnapshots": [{
                "objectId": "shipped-object",
                "objectCreatedAtMs": 1_100,
                "path": "shipped.md",
                "blobSha256": shipped_sha,
                "updatedAtMs": 1_200,
                "latestMomentId": "shipped-head",
                "metadata": {
                    "origin": "sync",
                    "summary": "shipped summary",
                    "correlationId": "shipped correlation"
                }
            }]
        }),
        recorded_at_ms: 1_500,
        relay_seq: Some(0),
    };
    apply_replication_envelope(
        &mut store,
        &mut dohc_engine_collab::WriterDocCache::new(),
        &version,
        &NoFaults,
        &crate::NoLiveLeases,
    )
    .expect("materialize shipped fork");

    let mut payload = present_text_payload(
        "remote-after-shipped",
        "shipped-object",
        "write",
        "shipped.md",
        "shipped.md",
        "shipped",
        "shipped-head",
        "remote edit",
    );
    payload["versionId"] = json!("feature");
    payload["beforeVersionId"] = json!("feature");
    payload["beforeUpdatedAtMs"] = json!(1_200);
    payload["beforeMetadata"] = json!({
        "origin": "sync",
        "summary": "shipped summary",
        "correlationId": "shipped correlation"
    });
    let append = envelope("moment-peer", 0, "ws", payload);
    assert_eq!(
        apply_moment_envelope(&mut store, &append, &NoFaults).expect("append after shipped head"),
        ApplyOutcome::new(ApplyDisposition::Applied(0))
    );
    type StoredPreimage = (
        Option<String>,
        Option<String>,
        Option<String>,
        Option<i64>,
        Option<String>,
        Option<String>,
        Option<String>,
    );
    let stored_preimage: StoredPreimage = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT before_object_id, before_version_id, before_path,
                        before_updated_at_ms, before_metadata_origin,
                        before_metadata_summary, before_metadata_correlation_id
                   FROM moments
                  WHERE workspace_id = 'ws' AND moment_id = 'remote-after-shipped'",
                [],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                        row.get(6)?,
                    ))
                },
            )
        })
        .expect("stored rollback preimage");
    assert_eq!(
        stored_preimage,
        (
            Some("shipped-object".to_owned()),
            Some("feature".to_owned()),
            Some("shipped.md".to_owned()),
            Some(1_200),
            Some("sync".to_owned()),
            Some("shipped summary".to_owned()),
            Some("shipped correlation".to_owned()),
        ),
        "omit any identity/metadata binding from insert_moment and the durable preimage tuple no longer matches the shipped snapshot.",
    );

    let database_path = engine_db_path(&scratch).expect("database path");
    drop(store);
    let mut reopened = EngineStore::open(&database_path, 3_000).expect("reopen");
    VersionedTextStore::new(&mut reopened)
        .rollback_text_file_mutation(
            &RollbackTextFileMutation {
                workspace_id: "ws".to_owned(),
                version_id: "feature".to_owned(),
                path: "shipped.md".to_owned(),
                mutation_moment_id: "remote-after-shipped".to_owned(),
                request_id: None,
                metadata_origin: "restore".to_owned(),
                author_json: None,
            },
            &NoFaults,
        )
        .expect("rollback after reopen");
    let versioned = VersionedTextStore::new(&mut reopened);
    let restored = versioned
        .read_text("ws", "feature", "shipped.md")
        .expect("read restored head")
        .expect("restored head");
    assert_eq!(restored.text, "shipped");
    assert!(restored.latest_moment_id.starts_with("rollback-"));
    let compensation = versioned
        .get_moment("ws", &restored.latest_moment_id)
        .expect("read compensating moment")
        .expect("compensating moment");
    assert_eq!(compensation.operation, MomentOp::Write);
    assert_eq!(
        compensation.before_latest_moment_id.as_deref(),
        Some("remote-after-shipped")
    );
    assert_eq!(restored.updated_at_ms, 1_200);
    assert_eq!(restored.metadata_origin, "restore");
    assert_eq!(restored.metadata_summary, None);
    assert_eq!(restored.metadata_correlation_id, None);
}

#[test]
fn moment_append_first_delivery_refuses_and_acks_plaintext_id_collision_but_redelivery_skips() {
    let (_scratch, mut store) = test_store();
    hydrate_texts(&mut store, &["first"]);
    let first = envelope(
        "first-peer",
        0,
        "ws",
        absent_text_payload("shared-moment", "object", "doc.md", "first"),
    );
    assert_eq!(
        apply_moment_envelope(&mut store, &first, &NoFaults).expect("first"),
        ApplyOutcome::new(ApplyDisposition::Applied(0))
    );
    assert_eq!(
        apply_moment_envelope(&mut store, &first, &NoFaults).expect("redelivery"),
        ApplyOutcome::new(ApplyDisposition::Skipped)
    );
    let duplicate_id = envelope(
        "second-peer",
        0,
        "ws",
        absent_text_payload(
            "shared-moment",
            "other-object",
            "other.md",
            "missing blob is never hydrated",
        ),
    );
    assert!(
        matches!(
            apply_moment_envelope(&mut store, &duplicate_id, &NoFaults),
            Ok(ApplyOutcome { primary: ApplyDisposition::Refused(ReplicationRefusal {
                reason: RefusalReason::InvalidInput { ref reason },
                ..
            }), refusals: ref outcome_refusals, sharing_declined: ref outcome_sharing_declined, }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty() && (reason == "replicated plaintext moment id collides with existing history")
        ),
        "treating a same-table ID hit as idempotence lets this unrelated first-delivery coordinate claim another moment; true replay was already skipped above before entering the moment applier."
    );
    assert_eq!(
        read_replication_acked_seq(&store, "ws", "second-peer").expect("ack"),
        0
    );
    let journal_count: i64 = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM replication_log \
                 WHERE workspace_id='ws' AND op_kind='moment.append'",
                [],
                |row| row.get(0),
            )
        })
        .expect("journal count");
    assert_eq!(journal_count, 2);
}

#[test]
fn redelivered_moment_uses_the_durable_apply_time_materialization_decision() {
    let (_scratch, mut store) = test_store();
    hydrate_texts(&mut store, &["incoming"]);
    VersionedTextStore::new(&mut store)
        .create_named_version(
            &CreateNamedVersion {
                workspace_id: "ws".to_owned(),
                new_version_id: "feature".to_owned(),
                name: "Feature".to_owned(),
                from_version_id: "main".to_owned(),
                now_ms: 1_500,
                request_id: None,
            },
            &NoFaults,
        )
        .expect("feature version");
    let incoming = envelope(
        "materialization-peer",
        0,
        "ws",
        absent_text_payload(
            "materialization-moment",
            "materialization-object",
            "active-at-apply.md",
            "incoming",
        ),
    );
    let first = apply_replication_envelope(
        &mut store,
        &mut dohc_engine_collab::WriterDocCache::new(),
        &incoming,
        &NoFaults,
        &crate::NoLiveLeases,
    )
    .expect("apply active moment");
    assert_eq!(
        first,
        ApplyOutcome::new(ApplyDisposition::Applied(crate::RoutedApply {
            conflict: None,
            conflicts_opened: 0,
            materialization_changes: vec![crate::MomentMaterializationChange {
                version_id: "main".to_owned(),
                path: "active-at-apply.md".to_owned(),
                operation: "write",
                content_kind: "text",
            }],
            record_facts: Vec::new(),
            automation_claims: Vec::new(),
        }))
    );
    store
        .read_with(|conn| {
            conn.execute(
                "INSERT INTO active_versions (workspace_id,version_id) VALUES ('ws','feature') \
                 ON CONFLICT(workspace_id) DO UPDATE SET version_id=excluded.version_id",
                [],
            )?;
            Ok::<_, rusqlite::Error>(())
        })
        .expect("switch active version after apply");
    assert_eq!(
        crate::moment_apply::redelivered_materialization_changes(&store, &incoming)
            .expect("read durable decision"),
        [crate::MomentMaterializationChange {
            version_id: "main".to_owned(),
            path: "active-at-apply.md".to_owned(),
            operation: "write",
            content_kind: "text",
        }],
        "re-deriving from the live active version loses the apply-time disk change"
    );
}

#[test]
fn moment_append_refuses_and_acks_id_collision_with_secret_history() {
    let (_scratch, mut store) = test_store();
    hydrate_texts(&mut store, &["incoming"]);
    store
        .read_with(|tx| {
            tx.execute(
                "INSERT INTO secret_moments \
                 (workspace_id,moment_order,moment_id,version_id,path,recorded_at_ms, \
                  operation,metadata_origin,after_present) \
                 VALUES ('ws',1,'protected-id','main','app.env',100,'delete','api',0)",
                [],
            )
        })
        .expect("seed protected collision");
    let op = envelope(
        "plaintext-collision-peer",
        0,
        "ws",
        absent_text_payload("protected-id", "plaintext-object", "doc.md", "incoming"),
    );

    assert!(
        matches!(
            apply_moment_envelope(&mut store, &op, &NoFaults),
            Ok(ApplyOutcome { primary: ApplyDisposition::Refused(ReplicationRefusal {
                reason: RefusalReason::InvalidInput { ref reason },
                ..
            }), refusals: ref outcome_refusals, sharing_declined: ref outcome_sharing_declined, }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty() && (reason == "replicated plaintext moment id collides with existing history")
        ),
        "removing the secret_moments arm lets two unrelated histories claim the same workspace-wide moment identity."
    );
    let rows: (i64, i64) = store
        .read_with(|conn| {
            Ok::<_, rusqlite::Error>((
                conn.query_row(
                    "SELECT COUNT(*) FROM moments \
                     WHERE workspace_id='ws' AND moment_id='protected-id'",
                    [],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*) FROM secret_moments \
                     WHERE workspace_id='ws' AND moment_id='protected-id'",
                    [],
                    |row| row.get(0),
                )?,
            ))
        })
        .expect("collision state");
    assert_eq!(rows, (0, 1));
    assert_eq!(
        read_replication_acked_seq(&store, "ws", "plaintext-collision-peer").expect("ack"),
        0
    );
}

#[test]
fn moment_append_accepts_only_oracle_metadata_origins_and_acks_refusals() {
    let (_scratch, mut accepted_store) = test_store();
    hydrate_texts(&mut accepted_store, &["accepted"]);
    for (index, origin) in ["api", "local-file", "restore", "sync", "unknown"]
        .into_iter()
        .enumerate()
    {
        let mut payload = absent_text_payload(
            &format!("accepted-{index}"),
            &format!("accepted-object-{index}"),
            &format!("accepted-{index}.md"),
            "accepted",
        );
        payload["metadata"]["origin"] = json!(origin);
        let op = envelope(&format!("accepted-peer-{index}"), 0, "ws", payload);
        assert_eq!(
            apply_moment_envelope(&mut accepted_store, &op, &NoFaults)
                .expect("oracle origin must apply"),
            ApplyOutcome::new(ApplyDisposition::Applied(0)),
            "{origin}"
        );
    }

    for (field, reserved) in [
        ("metadata", "capture"),
        ("metadata", "ydoc"),
        ("beforeMetadata", "capture"),
        ("beforeMetadata", "ydoc"),
    ] {
        let (_scratch, mut store) = test_store();
        hydrate_texts(&mut store, &["before", "after"]);
        let mut payload = present_text_payload(
            "reserved-origin",
            "reserved-object",
            "write",
            "reserved.md",
            "reserved.md",
            "before",
            "remote-before",
            "after",
        );
        payload[field]["origin"] = json!(reserved);
        let peer = format!("{field}-{reserved}-peer");
        let op = envelope(&peer, 0, "ws", payload);

        assert!(
            matches!(
                apply_moment_envelope(&mut store, &op, &NoFaults),
                Ok(ApplyOutcome { primary: ApplyDisposition::Refused(ReplicationRefusal {
                    reason: RefusalReason::InvalidInput { ref reason },
                    ..
                }), refusals: ref outcome_refusals, sharing_declined: ref outcome_sharing_declined, }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty() && (reason == "moment.append payload is invalid")
            ),
            "an empty-only check accepts capture/ydoc ownership markers and can make the local capture reconciler claim replicated content."
        );
        let persisted: (i64, i64) = store
            .read_with(|conn| {
                Ok::<_, rusqlite::Error>((
                    conn.query_row(
                        "SELECT COUNT(*) FROM moments \
                         WHERE workspace_id='ws' AND moment_id='reserved-origin'",
                        [],
                        |row| row.get(0),
                    )?,
                    conn.query_row(
                        "SELECT COUNT(*) FROM snapshots \
                         WHERE workspace_id='ws' AND object_id='reserved-object'",
                        [],
                        |row| row.get(0),
                    )?,
                ))
            })
            .expect("reserved origin state");
        assert_eq!(persisted, (0, 0), "{field}={reserved}");
        assert_eq!(
            read_replication_acked_seq(&store, "ws", &peer).expect("ack"),
            0,
            "{field}={reserved}"
        );
    }
}

#[test]
fn moment_append_requires_version_create_ordering_and_never_acks_a_missing_target() {
    let (_scratch, mut store) = test_store();
    hydrate_texts(&mut store, &["content"]);
    let mut payload = absent_text_payload("moment", "object", "doc.md", "content");
    payload["versionId"] = json!("missing");
    let op = envelope("peer", 0, "ws", payload);
    assert!(matches!(
        apply_replication_envelope(
            &mut store,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &op,
            &NoFaults,
            &crate::NoLiveLeases
        ),
        Err(SyncError::RetryableState {
            reason: "moment.append target version is missing"
        })
    ));
    assert_eq!(
        read_replication_acked_seq(&store, "ws", "peer").expect("ack"),
        -1
    );
    let journaled: i64 = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM replication_log \
                 WHERE workspace_id='ws' AND origin_id='peer'",
                [],
                |row| row.get(0),
            )
        })
        .expect("missing-version journal count");
    assert_eq!(
        journaled, 0,
        "journaling the retryable failure permanently consumes the missing-version coordinate"
    );

    let version = ReplicationEnvelope {
        settlement_admission: None,
        admitted_author_snapshot: None,
        workspace_id: "ws".to_owned(),
        origin_id: "version-peer".to_owned(),
        origin_seq: 0,
        op_kind: "version.create".to_owned(),
        payload: json!({
            "versionId": "missing",
            "name": "Missing",
            "kind": "named",
            "forkVersionId": null,
            "forkMomentId": null,
            "createdAtMs": 1_500,
            "forkSnapshots": []
        }),
        recorded_at_ms: 1_500,
        relay_seq: Some(0),
    };
    assert!(matches!(
        apply_replication_envelope(
            &mut store,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &version,
            &NoFaults,
            &crate::NoLiveLeases
        ),
        Ok(ApplyOutcome {
            primary: ApplyDisposition::Applied(_),
            refusals: ref outcome_refusals,
            sharing_declined: ref outcome_sharing_declined,
        }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
    ));
    assert!(matches!(
        apply_replication_envelope(
            &mut store,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &op,
            &NoFaults,
            &crate::NoLiveLeases
        ),
        Ok(ApplyOutcome {
            primary: ApplyDisposition::Applied(_),
            refusals: ref outcome_refusals,
            sharing_declined: ref outcome_sharing_declined,
        }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
    ));
    assert_eq!(
        read_replication_acked_seq(&store, "ws", "peer").expect("retry ack"),
        0
    );
}

#[test]
fn moment_append_refuses_non_tracked_or_noncanonical_paths_without_rows_and_acks() {
    let mut secret_after = absent_text_payload(
        "secret-after",
        "secret-after-object",
        "docs/safe.md",
        "content",
    );
    secret_after["payloadAfterPath"] = json!("app/.env");

    let mut noncanonical_path = absent_text_payload(
        "noncanonical-path",
        "noncanonical-path-object",
        "docs/safe.md",
        "content",
    );
    noncanonical_path["path"] = json!("a//b.md");

    let mut noncanonical_after = absent_text_payload(
        "noncanonical-after",
        "noncanonical-after-object",
        "docs/safe.md",
        "content",
    );
    noncanonical_after["payloadAfterPath"] = json!("a//b.md");

    let mut secret_before = absent_text_payload(
        "secret-before",
        "secret-before-object",
        "docs/new.md",
        "content",
    );
    secret_before["payloadBeforePath"] = json!("app/.env");
    secret_before["payloadBeforeBlobSha256"] = json!(text_sha("content"));

    let mut secret_before_snapshot = present_text_payload(
        "secret-before-snapshot",
        "secret-before-snapshot-object",
        "write",
        "docs/safe.md",
        "docs/safe.md",
        "content",
        "remote-base",
        "content",
    );
    secret_before_snapshot["beforePath"] = json!("app/.env");

    let mut noncanonical_before_snapshot = present_text_payload(
        "noncanonical-before-snapshot",
        "noncanonical-before-snapshot-object",
        "write",
        "docs/safe.md",
        "docs/safe.md",
        "content",
        "remote-base",
        "content",
    );
    noncanonical_before_snapshot["beforePath"] = json!("a//b.md");

    for (case, payload, object_id) in [
        (
            "secret payloadAfterPath",
            secret_after,
            "secret-after-object",
        ),
        (
            "noncanonical path",
            noncanonical_path,
            "noncanonical-path-object",
        ),
        (
            "noncanonical payloadAfterPath",
            noncanonical_after,
            "noncanonical-after-object",
        ),
        (
            "secret payloadBeforePath",
            secret_before,
            "secret-before-object",
        ),
        (
            "secret beforePath",
            secret_before_snapshot,
            "secret-before-snapshot-object",
        ),
        (
            "noncanonical beforePath",
            noncanonical_before_snapshot,
            "noncanonical-before-snapshot-object",
        ),
    ] {
        let (_scratch, mut store) = test_store();
        hydrate_texts(&mut store, &["content"]);
        let op = envelope("peer", 0, "ws", payload);
        assert!(
            matches!(
                apply_moment_envelope(&mut store, &op, &NoFaults),
                Ok(ApplyOutcome {
                    primary: ApplyDisposition::Refused(ReplicationRefusal {
                        reason: RefusalReason::InvalidInput { .. },
                        ..
                    }),
                    refusals: ref outcome_refusals,
                    sharing_declined: ref outcome_sharing_declined,
                }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
            ),
            "{case} must be refused"
        );
        let persisted: (i64, i64, i64) = store
            .read_with(|conn| {
                Ok::<_, rusqlite::Error>((
                    conn.query_row(
                        "SELECT COUNT(*) FROM moments WHERE workspace_id='ws' AND object_id=?1",
                        [object_id],
                        |row| row.get(0),
                    )?,
                    conn.query_row(
                        "SELECT COUNT(*) FROM snapshots WHERE workspace_id='ws' AND object_id=?1",
                        [object_id],
                        |row| row.get(0),
                    )?,
                    conn.query_row(
                        "SELECT COUNT(*) FROM path_aliases WHERE workspace_id='ws' AND object_id=?1",
                        [object_id],
                        |row| row.get(0),
                    )?,
                ))
            })
            .expect("rejected path leaves no rows");
        assert_eq!(persisted, (0, 0, 0), "{case} persisted poisoned rows");
        assert_eq!(
            read_replication_acked_seq(&store, "ws", "peer").expect("ack"),
            0,
            "{case} did not advance the peer ack"
        );
    }

    let (_scratch, mut store) = test_store();
    hydrate_texts(&mut store, &["content"]);
    let canonical = envelope(
        "peer",
        0,
        "ws",
        absent_text_payload(
            "canonical",
            "canonical-object",
            "docs/canonical.md",
            "content",
        ),
    );
    assert_eq!(
        apply_moment_envelope(&mut store, &canonical, &NoFaults).expect("canonical tracked path"),
        ApplyOutcome::new(ApplyDisposition::Applied(0))
    );
    assert_eq!(
        snapshot(&store, "canonical-object").unwrap().0,
        "docs/canonical.md"
    );
    assert_eq!(
        aliases(&store, "canonical-object"),
        ["docs/canonical.md".to_owned()]
    );

    let canonical_before = envelope(
        "canonical-before-peer",
        0,
        "ws",
        present_text_payload(
            "canonical-before",
            "canonical-before-object",
            "write",
            "docs/canonical-before.md",
            "docs/canonical-after.md",
            "content",
            "remote-base",
            "content",
        ),
    );
    assert_eq!(
        apply_moment_envelope(&mut store, &canonical_before, &NoFaults)
            .expect("canonical tracked beforePath"),
        ApplyOutcome::new(ApplyDisposition::Applied(1))
    );
}

#[test]
fn moment_append_persists_full_wire_payload_provenance() {
    let (_scratch, mut store) = test_store();
    seed_text_moment(
        &mut store,
        "object",
        "docs/new.md",
        "agreed",
        "local-head",
        None,
        true,
    );
    let remote_before = b"\0remote binary preimage\xff";
    let remote_before_sha = store
        .read_with(|conn| put_binary_blob(conn, remote_before))
        .expect("remote before blob");
    let after_sha = text_sha("agreed");
    let payload = json!({
        "momentId": "remote-adopted",
        "versionId": "main",
        "objectId": "object",
        "objectCreatedAtMs": 1,
        "path": "remote/old.bin",
        "recordedAtMs": 2_000,
        "operation": "rename",
        "payloadBeforeBlobSha256": remote_before_sha,
        "payloadBeforePath": "remote/old.bin",
        "payloadBeforeContentKind": "binary",
        "payloadBeforeByteLength": remote_before.len(),
        "payloadAfterBlobSha256": after_sha,
        "payloadAfterPath": "docs/new.md",
        "payloadAfterContentKind": "text",
        "payloadAfterByteLength": "agreed".len(),
        "metadata": {
            "origin": "sync",
            "summary": "adopted from peer",
            "correlationId": "correlation-remote-adopted"
        },
        "beforePresent": "present",
        "beforeObjectId": "object",
        "beforeVersionId": "main",
        "beforePath": "remote/old.bin",
        "beforeBlobSha256": remote_before_sha,
        "beforeContentKind": "binary",
        "beforeByteLength": remote_before.len(),
        "beforeUpdatedAtMs": 100,
        "beforeLatestMomentId": "remote-before",
        "beforeMetadata": {"origin": "api"}
    });
    let op = envelope("peer", 0, "ws", payload);
    assert_eq!(
        apply_moment_envelope(&mut store, &op, &NoFaults).expect("content-convergent adoption"),
        ApplyOutcome::new(ApplyDisposition::Applied(0))
    );

    let provenance = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT payload_before_path,payload_before_content_kind,
                        payload_before_blob_sha256,payload_after_path,
                        payload_after_content_kind,payload_after_blob_sha256
                 FROM moments WHERE workspace_id='ws' AND moment_id='remote-adopted'",
                [],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                    ))
                },
            )
        })
        .expect("payload provenance");
    assert_eq!(
        provenance,
        (
            Some("remote/old.bin".to_owned()),
            Some("binary".to_owned()),
            Some(remote_before_sha),
            Some("docs/new.md".to_owned()),
            Some("text".to_owned()),
            Some(after_sha),
        )
    );

    let metadata = store
        .read_with(|conn| {
            let moment = conn.query_row(
                "SELECT metadata_origin,metadata_summary,metadata_correlation_id \
                 FROM moments WHERE workspace_id='ws' AND moment_id='remote-adopted'",
                [],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, Option<String>>(2)?,
                    ))
                },
            )?;
            let snapshot = conn.query_row(
                "SELECT metadata_origin,metadata_summary,metadata_correlation_id \
                 FROM snapshots WHERE workspace_id='ws' AND object_id='object'",
                [],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, Option<String>>(2)?,
                    ))
                },
            )?;
            Ok::<_, rusqlite::Error>((moment, snapshot))
        })
        .expect("replicated metadata");
    let expected = (
        "sync".to_owned(),
        Some("adopted from peer".to_owned()),
        Some("correlation-remote-adopted".to_owned()),
    );
    assert_eq!(
        metadata,
        (expected.clone(), expected),
        "dropping either optional field from the moment or snapshot insert makes one side of this round trip differ."
    );

    let versioned = VersionedTextStore::new(&mut store);
    let page = versioned
        .list_moments(&ListMomentsQuery {
            workspace_id: "ws".to_owned(),
            version_id: Some("main".to_owned()),
            object_id: Some("object".to_owned()),
            limit: 10,
            before_moment_order: None,
        })
        .expect("moment read model");
    let moment = page.moments.first().expect("imported moment");
    assert_eq!(
        moment.metadata_summary.as_deref(),
        Some("adopted from peer")
    );
    assert_eq!(
        moment.metadata_correlation_id.as_deref(),
        Some("correlation-remote-adopted")
    );
    let snapshot = versioned
        .read_text("ws", "main", "docs/new.md")
        .expect("snapshot read model")
        .expect("imported snapshot");
    assert_eq!(
        snapshot.metadata_summary.as_deref(),
        Some("adopted from peer")
    );
    assert_eq!(
        snapshot.metadata_correlation_id.as_deref(),
        Some("correlation-remote-adopted")
    );
    let listed = versioned
        .list_snapshot_metadata("ws", "main", None, 10)
        .expect("snapshot list read model");
    assert_eq!(
        listed[0].metadata_summary.as_deref(),
        Some("adopted from peer")
    );
    assert_eq!(
        listed[0].metadata_correlation_id.as_deref(),
        Some("correlation-remote-adopted")
    );
}

#[test]
fn local_overwrite_clears_imported_snapshot_metadata() {
    let (_scratch, mut store) = test_store();
    hydrate_texts(&mut store, &["imported", "local"]);
    let mut payload = absent_text_payload(
        "imported-head",
        "metadata-object",
        "metadata.md",
        "imported",
    );
    payload["metadata"] = json!({
        "origin": "sync",
        "summary": "peer summary",
        "correlationId": "peer correlation"
    });
    apply_moment_envelope(
        &mut store,
        &envelope("metadata-peer", 0, "ws", payload),
        &NoFaults,
    )
    .expect("import metadata");

    VersionedTextStore::new(&mut store)
        .write_text(
            &WriteText {
                workspace_id: "ws".to_owned(),
                version_id: "main".to_owned(),
                object_id: "metadata-object".to_owned(),
                path: "metadata.md".to_owned(),
                text: "local".to_owned(),
                moment_id: "local-head".to_owned(),
                metadata_origin: "api".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 3_000,
                request_id: None,
            },
            &NoFaults,
        )
        .expect("local overwrite");

    let metadata = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT metadata_origin,metadata_summary,metadata_correlation_id \
                 FROM snapshots WHERE workspace_id='ws' AND version_id='main' \
                 AND object_id='metadata-object'",
                [],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, Option<String>>(2)?,
                    ))
                },
            )
        })
        .expect("local snapshot metadata");
    assert_eq!(
        metadata,
        ("api".to_owned(), None, None),
        "omitting either optional metadata assignment from the local upsert leaves the imported value attached to the newer local head."
    );
}

#[test]
fn moment_append_search_index_respects_files_and_visibility_policy() {
    let (scratch, mut store) = test_store();
    std::fs::write(
        scratch.path().join(".dohc/files.toml"),
        "[[rule]]\npath = \"private/**\"\nsearchable = false\n",
    )
    .expect("files policy");
    std::fs::write(
        scratch.path().join(".dohc/visibility.toml"),
        "[[rule]]\npath = \"hidden/**\"\nvisibility = \"hidden\"\n",
    )
    .expect("visibility policy");
    hydrate_texts(
        &mut store,
        &["private needle", "hidden needle", "public needle"],
    );

    for (origin, moment_id, object_id, path, text) in [
        (
            "private-peer",
            "private-moment",
            "private-object",
            "private/doc.md",
            "private needle",
        ),
        (
            "hidden-peer",
            "hidden-moment",
            "hidden-object",
            "hidden/doc.md",
            "hidden needle",
        ),
        (
            "public-peer",
            "public-moment",
            "public-object",
            "public/doc.md",
            "public needle",
        ),
    ] {
        let op = envelope(
            origin,
            0,
            "ws",
            absent_text_payload(moment_id, object_id, path, text),
        );
        assert_eq!(
            apply_moment_envelope(&mut store, &op, &NoFaults).expect("policy-aware apply"),
            ApplyOutcome::new(ApplyDisposition::Applied(0))
        );
    }

    assert!(
        indexed(&store, "private-object").is_empty(),
        "removing or inverting either policy predicate indexes one of the excluded rows; skipping the healthy insert loses the public row."
    );
    assert!(indexed(&store, "hidden-object").is_empty());
    assert_eq!(
        indexed(&store, "public-object"),
        [("public/doc.md".to_owned(), "public needle".to_owned())]
    );

    std::fs::write(
        scratch.path().join(".dohc/files.toml"),
        "rule = \"not-an-array\"\n",
    )
    .expect("degraded files policy");
    hydrate_texts(&mut store, &["updated needle"]);
    let degraded = envelope(
        "public-peer",
        1,
        "ws",
        present_text_payload(
            "public-degraded-moment",
            "public-object",
            "write",
            "public/doc.md",
            "public/doc.md",
            "public needle",
            "public-moment",
            "updated needle",
        ),
    );
    assert_eq!(
        apply_moment_envelope(&mut store, &degraded, &NoFaults).expect("degraded-policy apply"),
        ApplyOutcome::new(ApplyDisposition::Applied(0))
    );
    // A degraded policy freezes FILE indexing: the prior row remains until a
    // healthy policy can safely decide whether to replace or remove it.
    assert_eq!(
        indexed(&store, "public-object"),
        [("public/doc.md".to_owned(), "public needle".to_owned())]
    );
}

#[test]
fn moment_append_refuses_each_incomplete_payload_before_tuple_without_rows_and_acks() {
    for (case, before_path, before_sha) in [
        ("path only", Some("doc.md"), None),
        ("digest only", None, Some(text_sha("before"))),
    ] {
        let (_scratch, mut store) = test_store();
        hydrate_texts(&mut store, &["before", "after"]);
        let mut payload = absent_text_payload("tuple-moment", "tuple-object", "doc.md", "after");
        payload["payloadBeforePath"] = before_path.map_or(Value::Null, |path| json!(path));
        payload["payloadBeforeBlobSha256"] = before_sha.map_or(Value::Null, |sha| json!(sha));
        let op = envelope("tuple-peer", 0, "ws", payload);

        assert!(
            matches!(
                apply_moment_envelope(&mut store, &op, &NoFaults),
                Ok(ApplyOutcome {
                    primary: ApplyDisposition::Refused(ReplicationRefusal {
                        reason: RefusalReason::InvalidInput { .. },
                        ..
                    }),
                    refusals: ref outcome_refusals,
                    sharing_declined: ref outcome_sharing_declined,
                }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
            ),
            "{case} must be refused"
        );
        let rows: i64 = store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT COUNT(*) FROM moments WHERE workspace_id='ws' \
                     AND object_id='tuple-object'",
                    [],
                    |row| row.get(0),
                )
            })
            .expect("moment count");
        assert_eq!(rows, 0, "{case} mutated moment history");
        assert_eq!(
            read_replication_acked_seq(&store, "ws", "tuple-peer").expect("ack"),
            0,
            "{case} did not advance the peer ack"
        );
    }
}

#[test]
fn replicated_delete_after_path_divergent_rename_removes_the_live_alias() {
    let (_scratch, mut store) = test_store();
    hydrate_texts(&mut store, &["same"]);
    seed_text_moment(
        &mut store,
        "rename-delete-object",
        "old.md",
        "same",
        "local-head",
        None,
        true,
    );
    let rename = envelope(
        "rename-delete-peer",
        0,
        "ws",
        present_text_payload(
            "remote-rename",
            "rename-delete-object",
            "rename",
            "old.md",
            "new.md",
            "same",
            "local-head",
            "same",
        ),
    );
    assert_eq!(
        apply_moment_envelope(&mut store, &rename, &NoFaults).expect("rename"),
        ApplyOutcome::new(ApplyDisposition::Applied(0))
    );
    assert_eq!(
        aliases(&store, "rename-delete-object"),
        ["new.md".to_owned()]
    );

    let delete = envelope(
        "rename-delete-peer",
        1,
        "ws",
        present_text_payload(
            "remote-delete",
            "rename-delete-object",
            "delete",
            "old.md",
            "old.md",
            "same",
            "remote-rename",
            "same",
        ),
    );
    assert_eq!(
        apply_moment_envelope(&mut store, &delete, &NoFaults).expect("delete"),
        ApplyOutcome::new(ApplyDisposition::Applied(0))
    );
    assert!(
        aliases(&store, "rename-delete-object").is_empty(),
        "deleting by the remote payload path leaves `new.md` behind."
    );
    assert_eq!(snapshot(&store, "rename-delete-object"), None);
}

#[test]
fn moment_append_refuses_overlong_moment_and_object_ids_with_ack() {
    for (case, field) in [("moment id", "momentId"), ("object id", "objectId")] {
        let (_scratch, mut store) = test_store();
        hydrate_texts(&mut store, &["content"]);
        let mut payload =
            absent_text_payload("bounded-moment", "bounded-object", "doc.md", "content");
        payload[field] = json!("x".repeat(crate::model::MAX_IDENTIFIER_BYTES + 1));
        let op = envelope("bounded-peer", 0, "ws", payload);

        assert!(
            matches!(
                apply_moment_envelope(&mut store, &op, &NoFaults),
                Ok(ApplyOutcome {
                    primary: ApplyDisposition::Refused(ReplicationRefusal {
                        reason: RefusalReason::InvalidInput { .. },
                        ..
                    }),
                    refusals: ref outcome_refusals,
                    sharing_declined: ref outcome_sharing_declined,
                }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
            ),
            "overlong {case} must be refused"
        );
        assert_eq!(
            read_replication_acked_seq(&store, "ws", "bounded-peer").expect("ack"),
            0,
            "overlong {case} must not wedge the origin"
        );
    }
}

#[test]
fn moment_append_rejects_a_poisoned_binary_blob_as_storage_corruption_before_mutation() {
    let (_scratch, mut store) = test_store();
    let claimed = hex_sha256(b"honest binary");
    store
        .read_with(|conn| {
            conn.execute(
                "INSERT INTO binary_blobs (sha256,byte_length,bytes) VALUES (?1,?2,?3)",
                params![claimed, b"poisoned".len() as i64, b"poisoned".as_slice()],
            )
        })
        .expect("poison binary blob");
    let payload = json!({
        "momentId": "binary-moment",
        "versionId": "main",
        "objectId": "binary-object",
        "objectCreatedAtMs": 1,
        "path": "assets/file.bin",
        "recordedAtMs": 2_000,
        "operation": "write",
        "payloadBeforeBlobSha256": null,
        "payloadBeforePath": null,
        "payloadAfterBlobSha256": claimed,
        "payloadAfterPath": "assets/file.bin",
        "payloadAfterContentKind": "binary",
        "payloadAfterByteLength": b"honest binary".len(),
        "metadata": {"origin": "sync"},
        "beforePresent": "absent"
    });
    let op = envelope("peer", 0, "ws", payload);
    let error = apply_moment_envelope(&mut store, &op, &NoFaults)
        .expect_err("poisoned binary blob must fail closed");
    assert!(
        matches!(
            error,
            SyncError::Storage(dohc_engine_storage::StorageError::BlobIntegrity { .. })
        ),
        "local blob corruption must remain a hard storage error, got {error:?}"
    );
    let persisted: (i64, i64, i64) = store
        .read_with(|conn| {
            Ok::<_, rusqlite::Error>((
                conn.query_row(
                    "SELECT COUNT(*) FROM moments WHERE workspace_id='ws' AND moment_id='binary-moment'",
                    [],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*) FROM snapshots WHERE workspace_id='ws' AND object_id='binary-object'",
                    [],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*) FROM path_aliases WHERE workspace_id='ws' AND object_id='binary-object'",
                    [],
                    |row| row.get(0),
                )?,
            ))
        })
        .expect("failed binary apply leaves no rows");
    assert_eq!(persisted, (0, 0, 0));
    assert_eq!(
        read_replication_acked_seq(&store, "ws", "peer").expect("ack"),
        -1
    );
}

#[test]
fn moment_append_require_blob_text_rejects_a_poisoned_address_before_ack() {
    let (_scratch, mut store) = test_store();
    let claimed = text_sha("honest");
    store
        .read_with(|conn| {
            conn.execute(
                "INSERT INTO blobs (sha256,byte_length,text) VALUES (?1,?2,'poisoned')",
                params![claimed, "poisoned".len() as i64],
            )
        })
        .expect("poison blob");
    let op = envelope(
        "peer",
        0,
        "ws",
        absent_text_payload("moment", "object", "doc.md", "honest"),
    );
    assert!(matches!(
        apply_moment_envelope(&mut store, &op, &NoFaults),
        Err(SyncError::BlobInvalid)
    ));
    assert_eq!(
        read_replication_acked_seq(&store, "ws", "peer").expect("ack"),
        -1
    );
}

#[test]
fn moment_append_rejects_a_corrupt_text_blob_length_before_mutation_and_ack() {
    let (_scratch, mut store) = test_store();
    let claimed = text_sha("honest");
    store
        .read_with(|conn| {
            conn.execute(
                "INSERT INTO blobs (sha256,byte_length,text) VALUES (?1,?2,'honest')",
                params![claimed, "honest".len() as i64 + 1],
            )
        })
        .expect("poison blob length");
    let op = envelope(
        "peer",
        0,
        "ws",
        absent_text_payload(
            "corrupt-length-moment",
            "corrupt-length-object",
            "doc.md",
            "honest",
        ),
    );
    let error = apply_moment_envelope(&mut store, &op, &NoFaults)
        .expect_err("corrupt text blob length must fail closed");
    assert!(
        matches!(
            error,
            SyncError::Storage(dohc_engine_storage::StorageError::StateCorrupt { .. })
        ),
        "local length corruption must remain a hard storage error, got {error:?}"
    );
    let persisted: (i64, i64, i64) = store
        .read_with(|conn| {
            Ok::<_, rusqlite::Error>((
                conn.query_row(
                    "SELECT COUNT(*) FROM moments \
                     WHERE workspace_id='ws' AND moment_id='corrupt-length-moment'",
                    [],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*) FROM snapshots \
                     WHERE workspace_id='ws' AND object_id='corrupt-length-object'",
                    [],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*) FROM path_aliases \
                     WHERE workspace_id='ws' AND object_id='corrupt-length-object'",
                    [],
                    |row| row.get(0),
                )?,
            ))
        })
        .expect("failed text apply leaves no rows");
    assert_eq!(persisted, (0, 0, 0));
    assert_eq!(
        read_replication_acked_seq(&store, "ws", "peer").expect("ack"),
        -1
    );
}

#[test]
fn moment_append_rejects_an_empty_binary_digest_as_storage_corruption_even_if_hydrated() {
    let (_scratch, mut store) = test_store();
    store
        .read_with(|conn| {
            conn.execute(
                "INSERT INTO binary_blobs (sha256,byte_length,bytes) VALUES ('',0,X'')",
                [],
            )
        })
        .expect("empty-key binary row");
    let payload = json!({
        "momentId": "bad-binary",
        "versionId": "main",
        "objectId": "binary-object",
        "path": "bad.bin",
        "recordedAtMs": 2_000,
        "operation": "write",
        "payloadBeforeBlobSha256": null,
        "payloadBeforePath": null,
        "payloadAfterBlobSha256": "",
        "payloadAfterPath": "bad.bin",
        "payloadAfterContentKind": "binary",
        "payloadAfterByteLength": 0,
        "metadata": {"origin": "sync"},
        "beforePresent": "absent"
    });
    let op = envelope("peer", 0, "ws", payload);
    assert!(matches!(
        apply_moment_envelope(&mut store, &op, &NoFaults),
        Err(SyncError::Storage(
            dohc_engine_storage::StorageError::BlobIntegrity { .. }
        ))
    ));
    assert_eq!(
        read_replication_acked_seq(&store, "ws", "peer").expect("ack"),
        -1
    );
}

#[test]
fn open_document_bare_write_still_holds() {
    assert_open_document_exclusion("bare-write");
}
#[test]
fn open_document_dismissed_refusal_still_holds() {
    assert_open_document_exclusion("dismissed-refusal");
}
#[test]
fn open_document_parked_successor_still_holds() {
    assert_open_document_exclusion("parked-successor");
}

pub(crate) fn ended_recovery_fixture() -> (ScratchDir, EngineStore, DocKey, Ydoc, String) {
    let (scratch, mut store) = test_store();
    let key = DocKey::new("ws", "main", "object").unwrap();
    let doc = Ydoc::wire();
    doc.plaintext_insert(0, "before");
    let claim = store.put_binary_blob(&doc.encode_full_state()).unwrap();
    let mut base = envelope(
        "peer",
        0,
        "ws",
        json!({"versionId":"main","objectId":"object","path":"head.md","contentKind":"plaintext","updateBlobSha256":claim,"lineageClaimId":claim,"isBaseState":true}),
    );
    base.op_kind = "ydoc.update".into();
    base.relay_seq = Some(1);
    apply_ydoc_envelope(
        &mut store,
        &mut Default::default(),
        &base,
        &NoFaults,
        &NoLiveLeases,
    )
    .unwrap();
    let leases = LeaseRegistry::new();
    let held = leases.acquire(&key).unwrap();
    held.bind_claim(Some(&claim)).unwrap();
    let delta = doc.plaintext_insert(6, " remote");
    base.origin_seq = 1;
    base.relay_seq = Some(2);
    base.payload["isBaseState"] = json!(false);
    base.payload["updateBlobSha256"] = json!(store.put_binary_blob(&delta).unwrap());
    apply_ydoc_envelope(
        &mut store,
        &mut Default::default(),
        &base,
        &NoFaults,
        &leases,
    )
    .unwrap();
    hydrate_texts(&mut store, &["before remote"]);
    let moment = envelope(
        "peer",
        2,
        "ws",
        absent_text_payload(
            &format!("moment-ydoc-{}", "a".repeat(64)),
            "object",
            "head.md",
            "before remote",
        ),
    );
    crate::apply_moment_envelope_detailed(&mut store, &moment, &NoFaults, &leases).unwrap();
    drop(held);
    (scratch, store, key, doc, claim)
}

fn recover_ended(store: &mut EngineStore) -> Result<crate::OpenArtifactDrain, SyncError> {
    crate::drain_open_document_artifacts(
        store,
        &mut Default::default(),
        "ws",
        &NoLiveLeases,
        &NoFaults,
    )
}

#[test]
fn ended_recovery_storage_failure_propagates_without_notice_or_fingerprint() {
    let (_scratch, mut store, _, _, _) = ended_recovery_fixture();
    store.write_with(&NoFaults, |tx| {
        tx.execute_batch("CREATE TRIGGER fail_projection BEFORE INSERT ON moments WHEN NEW.moment_id GLOB 'moment-ydoc-apply-*' BEGIN SELECT RAISE(ABORT,'projection unavailable'); END;").unwrap();
        Ok::<_,SyncError>(())
    }).unwrap();
    assert!(matches!(
        recover_ended(&mut store),
        Err(SyncError::Storage(
            dohc_engine_storage::StorageError::PersistFailed { .. }
        ))
    ));
    store
        .read_with(|conn| {
            assert_eq!(
                conn.query_row(
                    "SELECT COUNT(*) FROM replication_pending_refusals",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
                0
            );
            assert_eq!(
                conn.query_row(
                    "SELECT last_attempt_state FROM ydoc_pending_artifacts",
                    [],
                    |r| r.get::<_, Option<String>>(0)
                )
                .unwrap(),
                None
            );
            Ok::<_, SyncError>(())
        })
        .unwrap();
}

#[test]
fn ended_recovery_append_storage_failure_propagates() {
    let (_scratch, mut store, _, _, _) = ended_recovery_fixture();
    store.write_with(&NoFaults, |tx| {
        tx.execute_batch("CREATE TRIGGER fail_append BEFORE INSERT ON ydoc_updates BEGIN SELECT RAISE(ABORT,'append unavailable'); END;").unwrap();
        Ok::<_,SyncError>(())
    }).unwrap();
    assert!(matches!(
        recover_ended(&mut store),
        Err(SyncError::Storage(
            dohc_engine_storage::StorageError::PersistFailed { .. }
        ))
    ));
    store
        .read_with(|conn| {
            assert_eq!(
                conn.query_row("SELECT COUNT(*) FROM ydoc_deferred_updates", [], |r| r
                    .get::<_, i64>(0))
                    .unwrap(),
                1
            );
            assert_eq!(
                conn.query_row(
                    "SELECT COUNT(*) FROM replication_pending_refusals",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
                0
            );
            assert_eq!(
                conn.query_row(
                    "SELECT last_attempt_state FROM ydoc_pending_artifacts",
                    [],
                    |r| r.get::<_, Option<String>>(0)
                )
                .unwrap(),
                None
            );
            Ok::<_, SyncError>(())
        })
        .unwrap();
}

#[test]
fn ended_recovery_notice_persist_failure_propagates() {
    let (_scratch, mut store, _, _, _) = ended_recovery_fixture();
    store.write_with(&NoFaults, |tx| {
        tx.execute("UPDATE replication_log SET payload_json='{}' WHERE origin_seq=1", []).unwrap();
        tx.execute_batch("CREATE TRIGGER fail_notice BEFORE INSERT ON replication_pending_refusals BEGIN SELECT RAISE(ABORT,'notice unavailable'); END;").unwrap();
        Ok::<_,SyncError>(())
    }).unwrap();
    assert!(matches!(
        recover_ended(&mut store),
        Err(SyncError::Storage(
            dohc_engine_storage::StorageError::PersistFailed { .. }
        ))
    ));
    let state: Option<String> = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT last_attempt_state FROM ydoc_pending_artifacts",
                [],
                |r| r.get(0),
            )
        })
        .unwrap();
    assert_eq!(
        state, None,
        "notice and fingerprint must roll back together"
    );
}

#[test]
fn ended_recovery_pending_materialization_keeps_queue_and_unattempted_mark() {
    let (_scratch, mut store, _, _, _) = ended_recovery_fixture();
    store.write_with(&NoFaults, |tx| {
        tx.execute("UPDATE ydoc_docs SET settle_prior_update_seq=0,settle_seq=(SELECT m.moment_order FROM moments m JOIN snapshots s ON s.latest_moment_id=m.moment_id WHERE s.object_id='object')", []).unwrap();
        tx.execute("INSERT INTO materialization_jobs(job_id,target_path,content_sha256,preimage_present,target_generation,created_at_ms,workspace_id) SELECT 'ydoc-mat_'||latest_moment_id,path,blob_sha256,1,999,0,workspace_id FROM snapshots WHERE object_id='object' ON CONFLICT(job_id) DO UPDATE SET status='pending',completed_at_ms=NULL", []).unwrap();
        Ok::<_,SyncError>(())
    }).unwrap();
    recover_ended(&mut store).unwrap();
    store
        .read_with(|conn| {
            assert_eq!(
                conn.query_row("SELECT COUNT(*) FROM ydoc_deferred_updates", [], |r| r
                    .get::<_, i64>(0))
                    .unwrap(),
                1
            );
            assert_eq!(
                conn.query_row(
                    "SELECT COUNT(*) FROM replication_pending_refusals",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
                0
            );
            assert_eq!(
                conn.query_row(
                    "SELECT last_attempt_state FROM ydoc_pending_artifacts",
                    [],
                    |r| r.get::<_, Option<String>>(0)
                )
                .unwrap(),
                None
            );
            Ok::<_, SyncError>(())
        })
        .unwrap();
}

#[test]
fn ended_recovery_notice_identity_survives_wording_change() {
    let (_scratch, mut store, _, _, _) = ended_recovery_fixture();
    store
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "UPDATE replication_log SET payload_json='{}' WHERE origin_seq=1",
                [],
            )
            .unwrap();
            Ok::<_, SyncError>(())
        })
        .unwrap();
    recover_ended(&mut store).unwrap();
    store
        .write_with(&NoFaults, |tx| {
            let code: String = tx
                .query_row(
                    "SELECT reason_code FROM replication_pending_refusals",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(code, "document-artifact-recovery-failed");
            tx.execute(
                "UPDATE replication_pending_refusals SET reason_message='Translated notice'",
                [],
            )
            .unwrap();
            Ok::<_, SyncError>(())
        })
        .unwrap();
    let notices = crate::refusal_notices::list_refusal_notices(&store, "ws");
    // The document association and cleanup must use the code, not English copy.
    assert_eq!(
        notices.unwrap()[0].document.as_ref().unwrap().object_id,
        "object"
    );
    store.write_with(&NoFaults, |tx| {
        tx.execute("UPDATE ydoc_docs SET settled_update_seq=head_update_seq,last_settled_sha=(SELECT blob_sha256 FROM snapshots WHERE object_id='object')", []).unwrap();
        assert_eq!(tx.query_row("SELECT COUNT(*) FROM replication_pending_refusals", [], |r|r.get::<_,i64>(0)).unwrap(),0);
        Ok::<_,SyncError>(())
    }).unwrap();
}

#[test]
fn ended_recovery_retries_inserted_durable_update_blob() {
    let (_scratch, mut store, key, doc, claim) = ended_recovery_fixture();
    let (sha, bytes): (String,Vec<u8>)=store.read_with(|conn|conn.query_row("SELECT b.sha256,b.bytes FROM binary_blobs b JOIN replication_log r ON b.sha256=json_extract(r.payload_json,'$.updateBlobSha256') WHERE r.origin_seq=1", [], |r|Ok((r.get(0)?,r.get(1)?)))).unwrap();
    dohc_engine_collab::apply_remote_update(
        &mut store,
        &mut Default::default(),
        &key,
        &dohc_engine_collab::RemoteUpdate {
            origin_id: "peer".into(),
            origin_seq: 1,
            bytes: bytes.clone(),
        },
        None,
        None,
        &NoFaults,
        2000,
    )
    .unwrap();
    store
        .write_with(&NoFaults, |tx| {
            tx.execute("DELETE FROM ydoc_deferred_updates WHERE origin_seq=1", [])
                .unwrap();
            Ok::<_, SyncError>(())
        })
        .unwrap();
    let tail = doc.plaintext_insert(13, " tail");
    let tail_sha = store.put_binary_blob(&tail).unwrap();
    let mut update = envelope(
        "peer",
        3,
        "ws",
        json!({"versionId":"main","objectId":"object","path":"head.md","contentKind":"plaintext","updateBlobSha256":tail_sha,"lineageClaimId":claim,"isBaseState":false}),
    );
    update.op_kind = "ydoc.update".into();
    update.relay_seq = Some(4);
    apply_ydoc_envelope(
        &mut store,
        &mut Default::default(),
        &update,
        &NoFaults,
        &crate::AlwaysLive,
    )
    .unwrap();
    // Model a missing durable blob while preserving the parked tail's blob.
    store
        .read_with(|conn| conn.execute_batch("PRAGMA foreign_keys=OFF"))
        .unwrap();
    store
        .write_with(&NoFaults, |tx| {
            tx.execute("DELETE FROM binary_blobs WHERE sha256=?1", [&sha])
                .unwrap();
            Ok::<_, SyncError>(())
        })
        .unwrap();
    recover_ended(&mut store).unwrap();
    let attempted: String = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT last_attempt_state FROM ydoc_pending_artifacts",
                [],
                |r| r.get(0),
            )
        })
        .unwrap();
    recover_ended(&mut store).unwrap();
    assert_eq!(
        store
            .read_with(|conn| conn.query_row(
                "SELECT last_attempt_state FROM ydoc_pending_artifacts",
                [],
                |r| r.get::<_, String>(0)
            ))
            .unwrap(),
        attempted
    );
    store.put_binary_blob(&bytes).unwrap();
    store
        .read_with(|conn| conn.execute_batch("PRAGMA foreign_keys=ON"))
        .unwrap();
    recover_ended(&mut store).unwrap();
    assert_eq!(
        snapshot(&store, "object").unwrap().2,
        text_sha("before remote tail")
    );
    let remaining:i64=store.read_with(|conn|conn.query_row("SELECT (SELECT COUNT(*) FROM ydoc_pending_artifacts)+(SELECT COUNT(*) FROM ydoc_deferred_updates)+(SELECT COUNT(*) FROM replication_pending_refusals)", [], |r|r.get(0))).unwrap();
    assert_eq!(remaining, 0);
}

#[test]
fn ended_recovery_notice_is_not_an_operation_refusal() {
    let (_scratch, mut store, _, _, _) = ended_recovery_fixture();
    store
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "UPDATE replication_log SET payload_json='{}' WHERE origin_seq=1",
                [],
            )
            .unwrap();
            Ok::<_, SyncError>(())
        })
        .unwrap();
    recover_ended(&mut store).unwrap();
    assert_eq!(
        crate::refusal_notices::list_refusal_notices(&store, "ws")
            .unwrap()
            .len(),
        1
    );
    assert!(
        crate::apply::read_pending_refusals(&store, "ws")
            .unwrap()
            .is_empty()
    );
}

#[test]
fn ended_recovery_restore_fence_waits_without_notice_or_fingerprint() {
    let (_scratch, mut store, _, _, _) = ended_recovery_fixture();
    store.write_with(&NoFaults, |tx| {
        tx.execute("INSERT INTO live_restore_fences(workspace_id,main_version_id,object_id,relay_database_namespace,operation_id,input_json,receipt_json) VALUES ('ws','main','object','relay','restore','{}','{}')",[]).unwrap();
        Ok::<_,SyncError>(())
    }).unwrap();
    recover_ended(&mut store).unwrap();
    let result:(i64,Option<String>,i64)=store.read_with(|conn| conn.query_row("SELECT (SELECT COUNT(*) FROM replication_pending_refusals),last_attempt_state,(SELECT COUNT(*) FROM ydoc_deferred_updates) FROM ydoc_pending_artifacts",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?)))).unwrap();
    assert_eq!(result, (0, None, 1));
}
