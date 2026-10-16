use super::*;

fn retain(store: &mut EngineStore, hold: &ReleaseHold, op: &ReplicationEnvelope) {
    let result = apply_replication_envelope_with_release_hold(
        store,
        &mut WriterDocCache::new(),
        op,
        &NoFaults,
        &NoLiveLeases,
        hold,
    )
    .unwrap();
    assert!(
        matches!(result.primary, ApplyDisposition::Applied(_)),
        "{result:?}"
    );
}

fn replay(
    store: &mut EngineStore,
    hold: &ReleaseHold,
    op: &ReplicationEnvelope,
) -> ApplyOutcome<RoutedApply> {
    replay_release_held_envelope(
        store,
        &mut WriterDocCache::new(),
        op,
        &NoFaults,
        &NoLiveLeases,
        hold,
    )
    .unwrap()
}

#[test]
fn dependency_transfers_do_not_hide_later_origins_or_prevent_closure() {
    let (dir, mut store, owner, checkpoint) = owner_publication::fixture();
    let hold = open(&mut store, &owner);
    let doc = Ydoc::wire();
    doc.apply(&checkpoint).unwrap();
    let prior = doc.richdoc_append_paragraph("B predecessor");
    for i in 0..70 {
        let op = update(
            &mut store,
            &owner,
            &doc.richdoc_append_paragraph(&format!("A dependent {i}")),
            i,
        );
        retain(&mut store, &hold, &op);
    }
    let mut b = update(&mut store, &owner, &prior, 0);
    b.origin_id = "later-B".into();
    b.relay_seq = Some(100);
    retain(&mut store, &hold, &b);
    released(&mut store, &owner, &hold);
    for expected in [64, 7] {
        let page = read_release_hold_page(&store, &hold).unwrap();
        assert_eq!(page.len(), expected);
        for op in page {
            replay(&mut store, &hold, &op);
        }
        drop(store);
        store = EngineStore::open(&engine_db_path(&dir).unwrap(), 4).unwrap();
        let recovered = read_release_hold_page(&store, &hold).unwrap();
        assert_eq!(recovered.len(), expected);
        for op in recovered {
            replay(&mut store, &hold, &op);
            ack(&mut store, &op);
        }
    }
    assert!(read_release_hold_page(&store, &hold).unwrap().is_empty());
    assert!(matches!(
        store
            .write_with(&NoFaults, |tx| close_release_hold_in(tx, &hold))
            .unwrap(),
        TxnOutcome::Committed(true)
    ));
    drop(store);
    let mut store = EngineStore::open(&engine_db_path(&dir).unwrap(), 4).unwrap();
    drain_deferred_ydoc_for_key(
        &mut store,
        &mut WriterDocCache::new(),
        &DocKey::new("ws", "main", "owner").unwrap(),
        &NoFaults,
    )
    .unwrap();
    assert!(text(&store).contains("A dependent 69"));
    assert_eq!(store.table_row_count("ydoc_deferred_updates").unwrap(), 0);
    assert_eq!(store.table_row_count("release_holds").unwrap(), 0);
}

#[test]
fn dependency_transfer_can_be_acknowledged_before_missing_predecessors_arrive() {
    let (dir, mut store, owner, checkpoint) = owner_publication::fixture();
    let hold = open(&mut store, &owner);
    let doc = Ydoc::wire();
    doc.apply(&checkpoint).unwrap();
    doc.richdoc_append_paragraph("missing predecessor");
    let op = update(
        &mut store,
        &owner,
        &doc.richdoc_append_paragraph("dependent"),
        0,
    );
    retain(&mut store, &hold, &op);
    released(&mut store, &owner, &hold);
    replay(&mut store, &hold, &op);
    drop(store);
    let mut store = EngineStore::open(&engine_db_path(&dir).unwrap(), 4).unwrap();
    ack(&mut store, &op);
    assert_eq!(store.table_row_count("release_held_ops").unwrap(), 0);
    assert_eq!(store.table_row_count("ydoc_deferred_updates").unwrap(), 1);
    assert!(matches!(
        store
            .write_with(&NoFaults, |tx| close_release_hold_in(tx, &hold))
            .unwrap(),
        TxnOutcome::Committed(true)
    ));
    assert!(
        store
            .get_binary_blob(op.payload["updateBlobSha256"].as_str().unwrap())
            .unwrap()
            .is_some()
    );
}

#[test]
fn unaudited_settlement_shaped_moment_is_retained_and_replays_ordinary() {
    let (_dir, mut store, owner, _) = owner_publication::fixture();
    let hold = open(&mut store, &owner);
    let mut op = moment(&mut store, 0, "write");
    op.payload["momentId"] = json!(format!("moment-ydoc-{}", "b".repeat(64)));
    retain(&mut store, &hold, &op);
    assert_eq!(
        store.table_row_count("owner_pending_settlements").unwrap(),
        0
    );
    released(&mut store, &owner, &hold);
    assert!(matches!(
        replay(&mut store, &hold, &op).primary,
        ApplyDisposition::Applied(_)
    ));
    assert_eq!(store.table_row_count("moments").unwrap(), 1);
    ack(&mut store, &op);
}

#[test]
fn held_update_keeps_its_own_inactive_lineage_at_transfer() {
    let (_dir, mut store, owner, _) = owner_publication::fixture();
    let hold = open(&mut store, &owner);
    let doc = Ydoc::wire();
    doc.rewrite_content_to_markdown(ContentKind::Richdoc, "Other branch\n")
        .unwrap();
    let lineage = store.put_binary_blob(&doc.encode_full_state()).unwrap();
    let vector = store.put_binary_blob(&doc.encode_state_vector()).unwrap();
    store.read_with(|c| c.execute("INSERT INTO ydoc_inactive_lineages(workspace_id,version_id,object_id,lineage_claim_id,disposition,content_kind,path,full_state_blob_sha256,state_vector_blob_sha256,recorded_at_ms,updated_at_ms) VALUES('ws','main','owner',?1,'rejected-base','richdoc','owner.md',?1,?2,2,2)", params![lineage,vector])).unwrap();
    let mut op = update(
        &mut store,
        &owner,
        &doc.richdoc_append_paragraph("losing lineage"),
        0,
    );
    op.payload["lineageClaimId"] = json!(lineage);
    retain(&mut store, &hold, &op);
    released(&mut store, &owner, &hold);
    replay(&mut store, &hold, &op);
    let saved: String = store
        .read_with(|c| {
            c.query_row(
                "SELECT lineage_claim_id FROM ydoc_deferred_updates",
                [],
                |r| r.get(0),
            )
        })
        .unwrap();
    assert_eq!(saved, lineage);
    ack(&mut store, &op);
    let before = text(&store);
    crate::ydoc_apply::drain_inactive_ydoc_updates(&mut store, "ws", &NoFaults).unwrap();
    assert_eq!(store.table_row_count("ydoc_deferred_updates").unwrap(), 0);
    assert_eq!(text(&store), before);
    let sha: String = store.read_with(|c| c.query_row("SELECT full_state_blob_sha256 FROM ydoc_inactive_lineages WHERE lineage_claim_id=?1", [&lineage], |r|r.get(0))).unwrap();
    let recovered = Ydoc::wire();
    recovered
        .apply(&store.get_binary_blob(&sha).unwrap().unwrap())
        .unwrap();
    assert!(
        recovered
            .project(ContentKind::Richdoc)
            .unwrap()
            .content
            .contains("losing lineage")
    );
}

#[test]
fn invalid_base_is_held_then_refused_by_ordinary_replay() {
    let (_dir, mut store, owner, _) = owner_publication::fixture();
    let hold = open(&mut store, &owner);
    let mut op = update(&mut store, &owner, b"invalid Y.Doc base", 0);
    op.payload["isBaseState"] = json!(true);
    op.payload["lineageClaimId"] = op.payload["updateBlobSha256"].clone();
    retain(&mut store, &hold, &op);
    released(&mut store, &owner, &hold);
    assert!(matches!(
        replay(&mut store, &hold, &op).primary,
        ApplyDisposition::Refused(_)
    ));
    assert_eq!(store.table_row_count("ydoc_deferred_updates").unwrap(), 0);
    ack(&mut store, &op);
}

fn audited(
    store: &mut EngineStore,
    owner: &ObservedOwnerBinding,
    terminal: i64,
) -> ReplicationEnvelope {
    let mut op = moment(store, 0, "write");
    op.payload["momentId"] = json!(format!("moment-ydoc-{}", "b".repeat(64)));
    let record = json!({"momentId":op.payload["momentId"],"binding":owner.binding,"relayDatabaseNamespace":"relay","terminalCursor":terminal,"acceptedStateBlobSha256":owner.checkpoint_digest}).to_string();
    store
        .read_with(|c| {
            c.execute(
                "INSERT INTO live_audit_settlements VALUES('audit','ws',?1,?2,?3)",
                params![
                    dohc_engine_storage::hex_sha256(record.as_bytes()),
                    record,
                    op.payload["payloadAfterBlobSha256"].as_str().unwrap()
                ],
            )
        })
        .unwrap();
    op
}

#[test]
fn opening_hold_waits_for_preexisting_pending_settlements() {
    let (_dir, mut store, owner, _) = owner_publication::fixture();
    let op = audited(&mut store, &owner, 1);
    apply_replication_envelope(
        &mut store,
        &mut WriterDocCache::new(),
        &op,
        &NoFaults,
        &NoLiveLeases,
    )
    .unwrap();
    assert_eq!(
        store.table_row_count("owner_pending_settlements").unwrap(),
        1
    );
    assert!(matches!(
        store.write_with(&NoFaults, |tx| open_release_hold_in(
            tx,
            &owner.binding,
            "relay",
            &"a".repeat(64)
        )),
        Err(SyncError::RetryableState { .. })
    ));
    assert_eq!(store.table_row_count("release_holds").unwrap(), 0);
}

#[test]
fn fix1_retain_refuses_pending_coordinate_with_different_ownership() {
    for mutation in [
        "UPDATE owner_pending_settlements SET relay_namespace='different'",
        "UPDATE owner_pending_settlements SET binding_json=json_set(binding_json,'$.restoreFenceGeneration',1)",
        "UPDATE owner_pending_settlements SET envelope_json=json_set(envelope_json,'$.recordedAtMs',99)",
    ] {
        let (_dir, mut store, owner, _) = owner_publication::fixture();
        let hold = open(&mut store, &owner);
        let op = audited(&mut store, &owner, 1);
        apply_replication_envelope(
            &mut store,
            &mut WriterDocCache::new(),
            &op,
            &NoFaults,
            &NoLiveLeases,
        )
        .unwrap();
        store.read_with(|c| c.execute(mutation, [])).unwrap();
        assert!(
            matches!(
                store.write_with(&NoFaults, |tx| hold.retain_in(tx, &op)),
                Err(SyncError::RetryableState { .. })
            ),
            "{mutation}"
        );
        assert_eq!(store.table_row_count("release_held_ops").unwrap(), 0);
        assert_eq!(store.table_row_count("release_held_blobs").unwrap(), 0);
        assert_eq!(
            store.table_row_count("owner_pending_settlements").unwrap(),
            1
        );
    }
}

#[test]
fn fix1_replication_retain_refuses_a_pending_coordinate_from_another_namespace() {
    let (_dir, mut store, mut owner, _) = owner_publication::fixture();
    let hold = open(&mut store, &owner);
    owner.relay_database_namespace = "different".into();
    store
        .read_with(|c| {
            c.execute(
                "UPDATE ydoc_owner_bindings SET relay_database_namespace='different'",
                [],
            )
        })
        .unwrap();
    let mut op = moment(&mut store, 0, "write");
    op.payload["momentId"] = json!(format!("moment-ydoc-{}", "b".repeat(64)));
    let record = json!({"momentId":op.payload["momentId"],"binding":owner.binding,"relayDatabaseNamespace":"different","terminalCursor":1,"acceptedStateBlobSha256":owner.checkpoint_digest}).to_string();
    store
        .read_with(|c| {
            c.execute(
                "INSERT INTO live_audit_settlements VALUES('audit','ws',?1,?2,?3)",
                params![
                    dohc_engine_storage::hex_sha256(record.as_bytes()),
                    record,
                    op.payload["payloadAfterBlobSha256"].as_str().unwrap()
                ],
            )
        })
        .unwrap();
    assert!(matches!(
        apply_replication_envelope_with_release_hold(
            &mut store,
            &mut WriterDocCache::new(),
            &op,
            &NoFaults,
            &NoLiveLeases,
            &hold
        ),
        Err(SyncError::RetryableState { .. })
    ));
    assert_eq!(
        store
            .read_with(|c| c.query_row(
                "SELECT count(*) FROM replication_log WHERE origin_id=?1",
                [&op.origin_id],
                |r| r.get::<_, i64>(0)
            ))
            .unwrap(),
        0
    );
    for table in [
        "release_held_ops",
        "release_held_blobs",
        "owner_pending_settlements",
    ] {
        assert_eq!(store.table_row_count(table).unwrap(), 0, "{table}");
    }
}

#[test]
fn unrelated_pending_coordinate_stays_ready_under_hold() {
    let (_dir, mut store, owner, _) = owner_publication::fixture();
    let _hold = open(&mut store, &owner);
    let op = audited(&mut store, &owner, 1);
    apply_replication_envelope(
        &mut store,
        &mut WriterDocCache::new(),
        &op,
        &NoFaults,
        &NoLiveLeases,
    )
    .unwrap();
    store
        .read_with(|c| c.execute("UPDATE ydoc_owner_bindings SET accepted_cursor=1", []))
        .unwrap();
    let report =
        crate::moment_apply::pending::drain_and_claim(&mut store, "ws", &NoFaults, &NoLiveLeases)
            .unwrap();
    assert!(report.report_id.is_some());
    assert_eq!(store.table_row_count("moments").unwrap(), 1);
}

fn seal_at(
    tx: &rusqlite::Transaction<'_>,
    hold: &ReleaseHold,
    expected: i64,
) -> Result<(), SyncError> {
    seal_release_hold_cut_in(tx, hold, expected)
}

#[test]
fn sealing_requires_the_relay_anchor_and_rechecks_an_existing_seal() {
    for reseal in [false, true] {
        let (_dir, mut store, owner, _) = owner_publication::fixture();
        let hold = open(&mut store, &owner);
        if reseal {
            store
                .write_with(&NoFaults, |tx| seal_at(tx, &hold, 0))
                .unwrap();
        }
        assert!(matches!(
            store.write_with(&NoFaults, |tx| seal_at(tx, &hold, 1)),
            Err(SyncError::RetryableState { .. })
        ));
    }
}

#[test]
fn replay_cannot_start_without_a_sealed_anchor() {
    let (_dir, mut store, owner, _) = owner_publication::fixture();
    let hold = open(&mut store, &owner);
    store
        .write_with(&NoFaults, |tx| {
            release::request_in_tx(tx, &DocKey::new("ws", "main", "owner").unwrap(), 20)?;
            release::release_in_tx(tx, &owner.binding, 0, 21, |_, _, _, _, _| Ok(()))
        })
        .unwrap();
    assert!(matches!(
        store.write_with(&NoFaults, |tx| prepare_release_hold_replay_in(
            tx, &hold, true
        )),
        Err(SyncError::RetryableState { .. })
    ));
}

fn simulated_final_unbind(store: &mut EngineStore, hold: &ReleaseHold) {
    store.write_with(&NoFaults, |tx| {
        seal_at(tx, hold, 0)?;
        release::request_in_tx(tx, &DocKey::new("ws", "main", "owner").unwrap(), 20).map_err(SyncError::corrupt)?;
        tx.execute("DELETE FROM ydoc_owner_bindings", []).map_err(SyncError::persist)?;
        tx.execute("UPDATE owner_live_stops SET state='released',binding_json=json_set(binding_json,'$.state','released')", []).map_err(SyncError::persist)?;
        prepare_release_hold_replay_in(tx, hold, true)
    }).unwrap();
}

fn unproven_inclusion(mismatch_text: bool) {
    let (_dir, mut store, owner, _) = owner_publication::fixture();
    let hold = open(&mut store, &owner);
    let op = audited(&mut store, &owner, if mismatch_text { 0 } else { 1 });
    retain(&mut store, &hold, &op);
    if mismatch_text {
        let sha = dohc_engine_storage::hex_sha256(b"different audit text");
        store
            .read_with(|c| {
                c.execute(
                    "INSERT INTO blobs VALUES(?1,20,'different audit text')",
                    [&sha],
                )?;
                c.execute(
                    "UPDATE live_audit_settlements SET markdown_digest=?1",
                    [&sha],
                )
            })
            .unwrap();
    }
    simulated_final_unbind(&mut store, &hold);
    let permit = crate::release_hold::ReplayPermit {
        hold: &hold,
        op: &op,
    };
    assert!(matches!(
        store
            .write_with(&NoFaults, |tx| permit.included_in(tx))
            .unwrap(),
        TxnOutcome::Committed(false)
    ));
    let out = replay(&mut store, &hold, &op);
    assert!(
        matches!(out.primary, ApplyDisposition::Applied(_)),
        "{out:?}"
    );
    assert_eq!(
        store.table_row_count("owner_pending_settlements").unwrap(),
        0
    );
    ack(&mut store, &op);
}

#[test]
fn settlement_beyond_anchor_replays_ordinary() {
    unproven_inclusion(false);
}

#[test]
fn settlement_audit_with_different_text_replays_ordinary() {
    unproven_inclusion(true);
}

#[test]
fn settlement_for_an_unreachable_successor_binding_replays_ordinary() {
    let (_dir, mut store, owner, _) = owner_publication::fixture();
    let hold = open(&mut store, &owner);
    let op = audited(&mut store, &owner, 0);
    retain(&mut store, &hold, &op);
    store.read_with(|c| c.execute("UPDATE owner_pending_settlements SET binding_json=json_set(binding_json,'$.restoreFenceGeneration',1)", [])).unwrap();
    simulated_final_unbind(&mut store, &hold);
    assert!(matches!(
        replay(&mut store, &hold, &op).primary,
        ApplyDisposition::Applied(_)
    ));
    assert_eq!(
        store.table_row_count("owner_pending_settlements").unwrap(),
        0
    );
    ack(&mut store, &op);
}

#[test]
fn replay_disposition_survives_notice_cleanup_and_an_ordinary_pull() {
    let (dir, mut store, owner, _) = owner_publication::fixture();
    let hold = open(&mut store, &owner);
    let op = moment(&mut store, 0, "write");
    retain(&mut store, &hold, &op);
    released(&mut store, &owner, &hold);
    let permit = crate::release_hold::ReplayPermit {
        hold: &hold,
        op: &op,
    };
    let faults = ScriptedFaults::crash_at(FaultPoint::StorageAfterCommitBeforeAck);
    let result = crate::apply::apply_envelope_with_replay::<()>(
        &mut store,
        &op,
        faults.as_ref(),
        Some(&permit),
        |_, _| {
            Err(SyncError::InvalidInput {
                reason: "refused replay fixture",
            })
        },
    )
    .unwrap();
    assert_eq!(
        result.primary,
        ApplyDisposition::Crashed { committed: true }
    );
    drop(store);
    let mut store = EngineStore::open(&engine_db_path(&dir).unwrap(), 4).unwrap();
    let notice = list_refusal_notices(&store, "ws").unwrap().remove(0);
    dismiss_refusal_notice(
        &mut store,
        "ws",
        &notice.notice_id,
        &notice.refusal_coordinates,
        &NoFaults,
    )
    .unwrap();
    let relay = FakeRelay::default();
    *relay.pull.lock().unwrap() = Some(PullResponse {
        ops: Vec::new(),
        next_cursor: 0,
        has_more: false,
    });
    let client = RelaySyncClient::new(relay);
    let outcome = client
        .pull_chat_workspace(
            &mut store,
            &mut WriterDocCache::new(),
            "ws",
            &NoFaults,
            &NoLiveLeases,
            100,
        )
        .unwrap();
    let SyncPassOutcome::Complete {
        pending_cursor: Some(cursor),
        ..
    } = outcome
    else {
        panic!("{outcome:?}")
    };
    client
        .commit_pull_cursor(&mut store, "ws", &cursor, &NoFaults, &NoLiveLeases, 100)
        .unwrap();
    assert_eq!(
        store
            .table_row_count("replication_pending_refusals")
            .unwrap(),
        0
    );
    assert!(matches!(
        replay(&mut store, &hold, &op).primary,
        ApplyDisposition::Refused(_)
    ));
}

#[test]
fn missing_replay_coordinate_is_divergence() {
    let (_dir, mut store, owner, checkpoint) = owner_publication::fixture();
    let hold = open(&mut store, &owner);
    let op = update(&mut store, &owner, &checkpoint, 0);
    released(&mut store, &owner, &hold);
    assert!(matches!(
        replay_release_held_envelope(
            &mut store,
            &mut WriterDocCache::new(),
            &op,
            &NoFaults,
            &NoLiveLeases,
            &hold
        ),
        Err(SyncError::CoordinateDiverged)
    ));
}

#[test]
fn another_documents_earlier_held_coordinate_does_not_block_replay() {
    let (_dir, mut store, owner, checkpoint) = owner_publication::fixture();
    let hold = open(&mut store, &owner);
    let first = update(&mut store, &owner, &checkpoint, 0);
    retain(&mut store, &hold, &first);
    // Another document's inert header and retained coordinate under this origin.
    store
        .read_with(|c| c.execute("UPDATE release_held_ops SET object_id='other'", []))
        .unwrap();
    let second = update(&mut store, &owner, &checkpoint, 1);
    retain(&mut store, &hold, &second);
    released(&mut store, &owner, &hold);
    assert!(matches!(
        replay(&mut store, &hold, &second).primary,
        ApplyDisposition::Applied(_)
    ));
}

#[test]
fn hold_capacity_defers_fetch_while_another_origin_advances() {
    let (dir, mut store, owner, checkpoint) = owner_publication::fixture();
    let hold = open(&mut store, &owner);
    let doc = Ydoc::wire();
    doc.apply(&checkpoint).unwrap();
    let mut op = update(
        &mut store,
        &owner,
        &doc.richdoc_append_paragraph("full hold"),
        0,
    );
    op.relay_seq = Some(1);
    store
        .read_with(|c| c.execute("INSERT INTO release_hold_usage VALUES('ws',10000,0)", []))
        .unwrap();
    let other_sha = dohc_engine_storage::hex_sha256(b"Another document's edit\n");
    store
        .read_with(|c| {
            c.execute(
                "INSERT INTO blobs VALUES(?1,24,?2)",
                params![other_sha, "Another document's edit\n"],
            )
        })
        .unwrap();
    let other = envelope(
        "other-origin",
        0,
        "moment.append",
        json!({"momentId":"other-document","versionId":"main","objectId":"other","path":"other.md","recordedAtMs":2000,"operation":"write","objectCreatedAtMs":1,
        "payloadAfterBlobSha256":other_sha,"payloadAfterPath":"other.md","metadata":{"origin":"sync"},"beforePresent":"absent","authors":[{"kind":"human","humanId":"person"}]}),
    );
    let relay = FakeRelay::default();
    *relay.pull.lock().unwrap() = Some(PullResponse {
        ops: vec![op.clone(), other],
        next_cursor: 2,
        has_more: false,
    });
    let client = RelaySyncClient::new(relay);
    crate::router::TEST_RELEASE_HOLD.with(|slot| *slot.borrow_mut() = Some(hold.clone()));
    let result = client.pull_chat_workspace(
        &mut store,
        &mut WriterDocCache::new(),
        "ws",
        &NoFaults,
        &NoLiveLeases,
        100,
    );
    crate::router::TEST_RELEASE_HOLD.with(|slot| *slot.borrow_mut() = None);
    let outcome = result.unwrap();
    let SyncPassOutcome::Complete {
        pending_cursor: Some(cursor),
        ..
    } = outcome
    else {
        panic!("{outcome:?}")
    };
    client
        .commit_pull_cursor(&mut store, "ws", &cursor, &NoFaults, &NoLiveLeases, 100)
        .unwrap();
    assert_eq!(
        read_replication_acked_seq(&store, "ws", "peer").unwrap(),
        -1
    );
    assert_eq!(
        read_replication_acked_seq(&store, "ws", "other-origin").unwrap(),
        0
    );
    assert_eq!(store.table_row_count("relay_deferred_ops").unwrap(), 1);
    let other_text: String = store.read_with(|c| c.query_row("SELECT b.text FROM snapshots s JOIN blobs b ON b.sha256=s.blob_sha256 WHERE s.object_id='other'", [], |r|r.get(0))).unwrap();
    assert_eq!(other_text, "Another document's edit\n");
    drop(store);
    let mut store = EngineStore::open(&engine_db_path(&dir).unwrap(), 4).unwrap();
    store
        .read_with(|c| c.execute("UPDATE release_hold_usage SET operation_count=0", []))
        .unwrap();
    *client.transport().pull.lock().unwrap() = Some(PullResponse {
        ops: Vec::new(),
        next_cursor: 2,
        has_more: false,
    });
    crate::router::TEST_RELEASE_HOLD.with(|slot| *slot.borrow_mut() = Some(hold.clone()));
    let result = client.pull_chat_workspace(
        &mut store,
        &mut WriterDocCache::new(),
        "ws",
        &NoFaults,
        &NoLiveLeases,
        101,
    );
    crate::router::TEST_RELEASE_HOLD.with(|slot| *slot.borrow_mut() = None);
    result.unwrap();
    assert_eq!(read_replication_acked_seq(&store, "ws", "peer").unwrap(), 0);
    assert_eq!(read_release_hold_page(&store, &hold).unwrap(), vec![op]);
}

#[test]
fn fix1_restore_successor_settlement_cannot_be_retained_under_old_hold() {
    let (_dir, mut store, owner, _) = owner_publication::fixture();
    let hold = open(&mut store, &owner);
    let mut next = owner.clone();
    next.binding.restore_fence_generation += 1;
    let op = audited(&mut store, &next, 1);
    assert!(matches!(
        apply_replication_envelope_with_release_hold(
            &mut store,
            &mut WriterDocCache::new(),
            &op,
            &NoFaults,
            &NoLiveLeases,
            &hold
        ),
        Err(SyncError::RetryableState { .. })
    ));
    assert_eq!(store.table_row_count("release_held_ops").unwrap(), 0);
    assert_eq!(
        store.table_row_count("owner_pending_settlements").unwrap(),
        0
    );
}

#[test]
fn fix1_abandoned_inactive_lineage_keeps_row_without_stopping_workspace_drain() {
    let (_dir, mut store, owner, _) = owner_publication::fixture();
    let hold = open(&mut store, &owner);
    let doc = Ydoc::wire();
    doc.rewrite_content_to_markdown(ContentKind::Richdoc, "Other branch\n")
        .unwrap();
    let lineage = store.put_binary_blob(&doc.encode_full_state()).unwrap();
    let vector = store.put_binary_blob(&doc.encode_state_vector()).unwrap();
    store.read_with(|c|c.execute("INSERT INTO ydoc_inactive_lineages(workspace_id,version_id,object_id,lineage_claim_id,disposition,content_kind,path,full_state_blob_sha256,state_vector_blob_sha256,recorded_at_ms,updated_at_ms) VALUES('ws','main','owner',?1,'rejected-base','richdoc','owner.md',?1,?2,2,2)",params![lineage,vector])).unwrap();
    let mut op = update(
        &mut store,
        &owner,
        &doc.richdoc_append_paragraph("fenced inactive"),
        0,
    );
    op.payload["lineageClaimId"] = json!(lineage);
    retain(&mut store, &hold, &op);
    released(&mut store, &owner, &hold);
    replay(&mut store, &hold, &op);
    ack(&mut store, &op);
    store
        .write_with(&NoFaults, |tx| {
            abandon_release_hold_in(tx, &hold, hold.digest())
        })
        .unwrap();
    let other_text = "Another document's edit\n";
    let other_sha = dohc_engine_storage::hex_sha256(other_text.as_bytes());
    store
        .read_with(|c| {
            c.execute(
                "INSERT INTO blobs VALUES(?1,?2,?3)",
                params![other_sha, other_text.len() as i64, other_text],
            )
        })
        .unwrap();
    let mut other = envelope(
        "other-origin",
        0,
        "moment.append",
        json!({"momentId":"unrelated-document","versionId":"main","objectId":"other","path":"other.md","recordedAtMs":2000,"operation":"write","objectCreatedAtMs":1,
        "payloadAfterBlobSha256":other_sha,"payloadAfterPath":"other.md","metadata":{"origin":"sync"},"beforePresent":"absent","authors":[{"kind":"human","humanId":"person"}]}),
    );
    other.relay_seq = Some(2);
    let relay = FakeRelay::default();
    *relay.pull.lock().unwrap() = Some(PullResponse {
        ops: vec![op, other],
        next_cursor: 2,
        has_more: false,
    });
    let client = RelaySyncClient::new(relay);
    let outcome = client
        .pull_chat_workspace(
            &mut store,
            &mut WriterDocCache::new(),
            "ws",
            &NoFaults,
            &NoLiveLeases,
            100,
        )
        .unwrap();
    let SyncPassOutcome::Complete {
        pending_cursor: Some(cursor),
        ..
    } = outcome
    else {
        panic!("{outcome:?}")
    };
    client
        .commit_pull_cursor(&mut store, "ws", &cursor, &NoFaults, &NoLiveLeases, 101)
        .unwrap();
    let applied: String = store.read_with(|c| c.query_row("SELECT b.text FROM snapshots s JOIN blobs b ON b.sha256=s.blob_sha256 WHERE s.object_id='other'", [], |r|r.get(0))).unwrap();
    assert_eq!(applied, other_text);
    assert_eq!(store.table_row_count("ydoc_deferred_updates").unwrap(), 1);
    assert_eq!(release_deferred_wakes_in_for_test(&store).len(), 1);
    let mut ordinary = update(
        &mut store,
        &owner,
        &doc.richdoc_append_paragraph("R must survive"),
        1,
    );
    ordinary.payload["lineageClaimId"] = json!(lineage);
    let arrival = apply_replication_envelope(
        &mut store,
        &mut WriterDocCache::new(),
        &ordinary,
        &NoFaults,
        &NoLiveLeases,
    )
    .unwrap();
    assert!(
        matches!(arrival.primary, ApplyDisposition::Applied(_)),
        "{arrival:?}"
    );
    assert!(arrival.refusals.is_empty());
    let drained = drain_deferred_ydoc_for_key(
        &mut store,
        &mut WriterDocCache::new(),
        &DocKey::new("ws", "main", "owner").unwrap(),
        &NoFaults,
    )
    .unwrap();
    assert!(drained.refusals.is_empty());
    assert_eq!(store.table_row_count("ydoc_deferred_updates").unwrap(), 2);
    assert_eq!(release_deferred_wakes_in_for_test(&store).len(), 1);
    let sha:String=store.read_with(|c|c.query_row("SELECT full_state_blob_sha256 FROM ydoc_inactive_lineages WHERE lineage_claim_id=?1",[lineage],|r|r.get(0))).unwrap();
    let saved = Ydoc::wire();
    saved
        .apply(&store.get_binary_blob(&sha).unwrap().unwrap())
        .unwrap();
    assert!(
        !saved
            .project(ContentKind::Richdoc)
            .unwrap()
            .content
            .contains("fenced inactive")
    );
}
fn release_deferred_wakes_in_for_test(store: &EngineStore) -> Vec<DocKey> {
    store
        .read_with(|c| release_deferred_wakes_in(c, "ws", None))
        .unwrap()
}

fn fenced_inactive_stall(
    fenced_rows: i64,
    fenced_bytes: usize,
    ordinary_bytes: usize,
    tagged_last: bool,
) {
    let (_dir, mut store, owner, _) = owner_publication::fixture();
    let hold = open(&mut store, &owner);
    let doc = Ydoc::wire();
    doc.rewrite_content_to_markdown(ContentKind::Richdoc, "Other branch\n")
        .unwrap();
    let lineage = store.put_binary_blob(&doc.encode_full_state()).unwrap();
    let vector = store.put_binary_blob(&doc.encode_state_vector()).unwrap();
    store.read_with(|c| c.execute("INSERT INTO ydoc_inactive_lineages(workspace_id,version_id,object_id,lineage_claim_id,disposition,content_kind,path,full_state_blob_sha256,state_vector_blob_sha256,recorded_at_ms,updated_at_ms) VALUES('ws','main','owner',?1,'rejected-base','richdoc','owner.md',?1,?2,2,2)", params![lineage,vector])).unwrap();
    let mut tagged = update(
        &mut store,
        &owner,
        &doc.richdoc_append_paragraph(&"f".repeat(fenced_bytes)),
        0,
    );
    tagged.payload["lineageClaimId"] = json!(lineage);
    if tagged_last {
        tagged.relay_seq = Some(fenced_rows);
    }
    retain(&mut store, &hold, &tagged);
    released(&mut store, &owner, &hold);
    replay(&mut store, &hold, &tagged);
    ack(&mut store, &tagged);
    store
        .write_with(&NoFaults, |tx| {
            abandon_release_hold_in(tx, &hold, hold.digest())
        })
        .unwrap();
    for seq in 1..fenced_rows {
        let mut op = update(
            &mut store,
            &owner,
            &doc.richdoc_append_paragraph("queued lineage mate"),
            seq,
        );
        if tagged_last {
            op.origin_id = "earlier-mates".into();
            op.origin_seq = seq - 1;
        }
        op.payload["lineageClaimId"] = json!(lineage);
        let result = apply_replication_envelope(
            &mut store,
            &mut WriterDocCache::new(),
            &op,
            &NoFaults,
            &NoLiveLeases,
        )
        .unwrap();
        assert!(
            matches!(result.primary, ApplyDisposition::Applied(_)),
            "{result:?}"
        );
        assert!(result.refusals.is_empty());
    }
    // A second inactive lineage of another document must get past the fenced group.
    let other = Ydoc::wire();
    other
        .rewrite_content_to_markdown(ContentKind::Richdoc, "Independent branch\n")
        .unwrap();
    let base = other.encode_full_state();
    let other_lineage = store.put_binary_blob(&base).unwrap();
    let other_vector = store.put_binary_blob(&other.encode_state_vector()).unwrap();
    store.read_with(|c| {
        c.execute("INSERT INTO file_objects(workspace_id,object_id,created_at_ms) VALUES('ws','other',1)", [])?;
        c.execute("INSERT INTO ydoc_inactive_lineages(workspace_id,version_id,object_id,lineage_claim_id,disposition,content_kind,path,full_state_blob_sha256,state_vector_blob_sha256,recorded_at_ms,updated_at_ms) VALUES('ws','main','other',?1,'rejected-base','richdoc','other.md',?1,?2,2,2)", params![other_lineage,other_vector])
    }).unwrap();
    let mut op = update(
        &mut store,
        &owner,
        &other.richdoc_append_paragraph(&"o".repeat(ordinary_bytes)),
        0,
    );
    op.origin_id = "other-origin".into();
    op.relay_seq = Some(1000);
    op.payload["objectId"] = json!("other");
    op.payload["path"] = json!("other.md");
    op.payload["lineageClaimId"] = json!(other_lineage);
    let result = apply_replication_envelope(
        &mut store,
        &mut WriterDocCache::new(),
        &op,
        &NoFaults,
        &NoLiveLeases,
    )
    .unwrap();
    assert!(
        matches!(result.primary, ApplyDisposition::Applied(_)),
        "{result:?}"
    );
    assert!(result.refusals.is_empty());
    let queued: i64 = store
        .read_with(|c| {
            c.query_row(
                "SELECT count(*) FROM ydoc_deferred_updates WHERE object_id='other'",
                [],
                |r| r.get(0),
            )
        })
        .unwrap();
    assert_eq!(queued, 0, "ordinary inactive row must drain past the fence");
    assert_eq!(
        store.table_row_count("ydoc_deferred_updates").unwrap(),
        fenced_rows
    );
    let sha: String = store
        .read_with(|c| {
            c.query_row(
                "SELECT full_state_blob_sha256 FROM ydoc_inactive_lineages WHERE object_id='other'",
                [],
                |r| r.get(0),
            )
        })
        .unwrap();
    let saved = Ydoc::wire();
    saved
        .apply(&store.get_binary_blob(&sha).unwrap().unwrap())
        .unwrap();
    assert!(
        saved
            .project(ContentKind::Richdoc)
            .unwrap()
            .content
            .contains(&"o".repeat(ordinary_bytes))
    );
    assert_eq!(release_deferred_wakes_in_for_test(&store).len(), 1);
    if tagged_last {
        let earlier: i64 = store.read_with(|c| c.query_row(
            "SELECT count(*) FROM ydoc_deferred_updates WHERE release_digest IS NULL AND relay_seq<?1",
            [fenced_rows], |r| r.get(0),
        )).unwrap();
        assert_eq!(earlier, 256, "F is beyond the first unfiltered page");
        #[derive(Default)]
        struct Commits(AtomicUsize);
        impl FaultInjector for Commits {
            fn poll(&self, point: FaultPoint) -> dohc_engine_storage::FaultAction {
                if point == FaultPoint::StorageAfterCommitBeforeAck {
                    self.0.fetch_add(1, Ordering::Relaxed);
                }
                dohc_engine_storage::FaultAction::Continue
            }
        }
        let commits = Commits::default();
        let drained = drain_deferred_ydoc_for_key(
            &mut store,
            &mut WriterDocCache::new(),
            &DocKey::new("ws", "main", "owner").unwrap(),
            &commits,
        )
        .unwrap();
        assert!(drained.refusals.is_empty());
        assert_eq!(
            store.table_row_count("ydoc_deferred_updates").unwrap(),
            fenced_rows
        );
        assert_eq!(release_deferred_wakes_in_for_test(&store).len(), 1);
        // One initial batch and one for the first mate; later mates only check their key.
        assert_eq!(commits.0.load(Ordering::Relaxed), 2);
    }
}

#[test]
fn fix2_inactive_drain_passes_a_full_page_of_fenced_rows() {
    fenced_inactive_stall(257, 1, 1, false);
}

#[test]
fn fix2_inactive_drain_does_not_charge_fenced_bytes() {
    fenced_inactive_stall(1, 17 * 1024 * 1024, 8 * 1024 * 1024, false);
}

#[test]
fn fix3_inactive_drain_checks_earlier_fenced_mates_once() {
    fenced_inactive_stall(257, 1, 1, true);
}
