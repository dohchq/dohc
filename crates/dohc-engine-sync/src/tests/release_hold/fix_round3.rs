use super::*;

#[test]
fn hold_page_work_stays_bounded_at_capacity_and_recovers_reports_first() {
    let (_dir, mut store, owner, _) = owner_publication::fixture();
    let hold = open(&mut store, &owner);
    // Seed retained coordinates directly: this proof measures paging, not admission.
    store.write_with(&NoFaults, |tx| {
        for seq in 0..10_000 {
            let op = envelope("peer", seq, "ydoc.update", json!({"versionId":"main","objectId":"owner"}));
            let json = serde_json::to_string(&op).unwrap();
            tx.execute("INSERT INTO replication_log(workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms,imported) VALUES ('ws','peer',?1,'ydoc.update',?2,0,1)", params![seq,op.payload_json().unwrap()]).unwrap();
            tx.execute("INSERT INTO release_held_ops(workspace_id,origin_id,origin_seq,version_id,object_id,release_digest,envelope_json,retained_bytes) VALUES ('ws','peer',?1,'main','owner',?2,?3,1)", params![seq,"a".repeat(64),json]).unwrap();
        }
        Ok::<_, SyncError>(())
    }).unwrap();
    for reports in [0, 7, 64, 130] {
        store
            .read_with(|c| {
                c.execute("UPDATE release_held_ops SET stage='held'", [])
                    .unwrap();
                for n in 0..reports {
                    c.execute(
                        "UPDATE release_held_ops SET stage=?2 WHERE origin_seq=?1",
                        params![9_999 - n, if n % 2 == 0 { "done" } else { "dependency" }],
                    )
                    .unwrap();
                }
                Ok::<_, rusqlite::Error>(())
            })
            .unwrap();
        let page = read_release_hold_page(&store, &hold).unwrap();
        let count = reports.min(64);
        let expected: Vec<i64> = (10_000 - reports..10_000 - reports + count)
            .chain(0..64 - count)
            .collect();
        assert_eq!(
            page.iter().map(|op| op.origin_seq).collect::<Vec<_>>(),
            expected
        );
        let steps = store
            .read_with(|c| {
                let mut stmt = c
                    .prepare(crate::release_hold::RELEASE_HOLD_PAGE_SQL)
                    .unwrap();
                let rows = stmt
                    .query_map(params!["ws", "main", "owner", "a".repeat(64)], |r| {
                        r.get::<_, String>(0)
                    })
                    .unwrap();
                assert_eq!(rows.collect::<Result<Vec<_>, _>>().unwrap().len(), 64);
                Ok::<_, rusqlite::Error>(stmt.get_status(rusqlite::StatementStatus::VmStep))
            })
            .unwrap();
        println!("hold-page reports={reports} vm-steps={steps}");
        assert!(
            steps < 10_000,
            "one page must not visit the full 10,000-row hold: {steps} VM steps"
        );
    }
}

fn recover_replay_commit(dependency: bool) {
    let (dir, mut store, owner, checkpoint) = owner_publication::fixture();
    let hold = open(&mut store, &owner);
    let mut predecessor = None;
    let op = if dependency {
        let doc = Ydoc::wire();
        doc.apply(&checkpoint).unwrap();
        predecessor = Some(doc.richdoc_append_paragraph("missing predecessor"));
        update(
            &mut store,
            &owner,
            &doc.richdoc_append_paragraph("dependent"),
            0,
        )
    } else {
        moment(&mut store, 0, "delete")
    };
    apply_replication_envelope_with_release_hold(
        &mut store,
        &mut WriterDocCache::new(),
        &op,
        &NoFaults,
        &NoLiveLeases,
        &hold,
    )
    .unwrap();
    released(&mut store, &owner, &hold);
    let faults = ScriptedFaults::crash_at(FaultPoint::StorageAfterCommitBeforeAck);
    let out = replay_release_held_envelope(
        &mut store,
        &mut WriterDocCache::new(),
        &op,
        faults.as_ref(),
        &NoLiveLeases,
        &hold,
    )
    .unwrap();
    assert!(faults.fired());
    assert_eq!(out.primary, ApplyDisposition::Crashed { committed: true });
    drop(op);
    drop(hold);
    drop(store);

    let mut store = EngineStore::open(&engine_db_path(&dir).unwrap(), 4).unwrap();
    let hold = read_release_hold(&store, &DocKey::new("ws", "main", "owner").unwrap())
        .unwrap()
        .unwrap();
    let page = read_release_hold_page(&store, &hold).unwrap();
    assert_eq!(page.len(), 1, "committed report must remain discoverable");
    assert!(matches!(
        store
            .write_with(&NoFaults, |tx| close_release_hold_in(tx, &hold))
            .unwrap(),
        TxnOutcome::Committed(false)
    ));
    for op in page {
        let report = replay_release_held_envelope(
            &mut store,
            &mut WriterDocCache::new(),
            &op,
            &NoFaults,
            &NoLiveLeases,
            &hold,
        )
        .unwrap();
        let ApplyDisposition::Applied(applied) = &report.primary else {
            panic!("{report:?}");
        };
        if dependency {
            assert_eq!(applied, &RoutedApply::default());
            assert_eq!(store.table_row_count("ydoc_deferred_updates").unwrap(), 1);
        } else {
            assert!(!applied.materialization_changes.is_empty());
            assert_eq!(
                applied.materialization_changes,
                crate::moment_apply::stored_materialization_changes(&store, &op).unwrap()
            );
            assert_eq!(store.table_row_count("moments").unwrap(), 1);
        }
        assert_eq!(
            replay_release_held_envelope(
                &mut store,
                &mut WriterDocCache::new(),
                &op,
                &NoFaults,
                &NoLiveLeases,
                &hold,
            )
            .unwrap(),
            report
        );
        ack(&mut store, &op);
    }
    assert!(read_release_hold_page(&store, &hold).unwrap().is_empty());
    let usage: (i64, i64) = store
        .read_with(|c| {
            c.query_row(
                "SELECT COALESCE(SUM(operation_count),0),COALESCE(SUM(retained_bytes),0) FROM release_hold_usage",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
        })
        .unwrap();
    assert_eq!(usage, (0, 0));
    assert!(matches!(
        store
            .write_with(&NoFaults, |tx| close_release_hold_in(tx, &hold))
            .unwrap(),
        TxnOutcome::Committed(true)
    ));
    if let Some(bytes) = predecessor {
        let mut prior = update(&mut store, &owner, &bytes, 0);
        prior.origin_id = "predecessor".into();
        apply_replication_envelope(
            &mut store,
            &mut WriterDocCache::new(),
            &prior,
            &NoFaults,
            &NoLiveLeases,
        )
        .unwrap();
        drain_deferred_ydoc_for_key(
            &mut store,
            &mut WriterDocCache::new(),
            &DocKey::new("ws", "main", "owner").unwrap(),
            &NoFaults,
        )
        .unwrap();
        assert_eq!(store.table_row_count("ydoc_deferred_updates").unwrap(), 0);
    }
    assert_eq!(store.table_row_count("release_holds").unwrap(), 0);
}

#[test]
fn completed_moment_report_survives_crash_and_closes_from_recovered_page() {
    recover_replay_commit(false);
}

#[test]
fn dependency_report_survives_crash_and_closes_from_recovered_page() {
    recover_replay_commit(true);
}

fn pending_settlement(
    store: &mut EngineStore,
    owner: &ObservedOwnerBinding,
) -> ReplicationEnvelope {
    let mut op = moment(store, 0, "write");
    op.payload["momentId"] = json!(format!("moment-ydoc-{}", "b".repeat(64)));
    let record = json!({"momentId":op.payload["momentId"],"binding":owner.binding,"relayDatabaseNamespace":"relay","terminalCursor":1,"acceptedStateBlobSha256":owner.checkpoint_digest}).to_string();
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
fn reopening_hold_with_its_pending_settlement_is_idempotent_after_restart() {
    let (dir, mut store, owner, _) = owner_publication::fixture();
    let hold = open(&mut store, &owner);
    let op = pending_settlement(&mut store, &owner);
    apply_replication_envelope_with_release_hold(
        &mut store,
        &mut WriterDocCache::new(),
        &op,
        &NoFaults,
        &NoLiveLeases,
        &hold,
    )
    .unwrap();
    drop(store);
    let mut store = EngineStore::open(&engine_db_path(&dir).unwrap(), 4).unwrap();
    assert_eq!(
        store.table_row_count("owner_pending_settlements").unwrap(),
        1
    );
    for _ in 0..2 {
        assert_eq!(open(&mut store, &owner), hold);
        assert_eq!(store.table_row_count("release_holds").unwrap(), 1);
        assert_eq!(
            read_release_hold_page(&store, &hold).unwrap(),
            vec![op.clone()]
        );
    }
}

#[test]
fn opening_hold_ignores_unheld_pending_settlement_on_another_lineage() {
    opening_ignores_other_pending("lineage_claim_id", &"c".repeat(64));
}

#[test]
fn opening_hold_ignores_unheld_pending_settlement_on_another_relay() {
    opening_ignores_other_pending("relay_namespace", "other-relay");
}

fn opening_ignores_other_pending(column: &str, value: &str) {
    let (_dir, mut store, owner, _) = owner_publication::fixture();
    let op = pending_settlement(&mut store, &owner);
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
    store
        .read_with(|c| {
            c.execute(
                &format!("UPDATE owner_pending_settlements SET {column}=?1"),
                [value],
            )
        })
        .unwrap();
    let hold = open(&mut store, &owner);
    assert!(read_release_hold_page(&store, &hold).unwrap().is_empty());
    assert_eq!(
        store.table_row_count("owner_pending_settlements").unwrap(),
        1
    );
}
