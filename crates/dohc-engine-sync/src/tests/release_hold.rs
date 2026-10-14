use super::*;
use dohc_engine_collab::{
    ContentKind, DocKey, WriterDocCache, Ydoc,
    owner_outbox::{draft::ObservedOwnerBinding, release},
};

#[test]
fn pre_anchor_settlement_requires_state_inclusion_and_keeps_native_content() {
    for (included, point) in [
        (true, Some(FaultPoint::SyncBeforeApplyCommit)),
        (true, Some(FaultPoint::StorageAfterCommitBeforeAck)),
        (false, None),
    ] {
        let (dir, mut store, owner, checkpoint) = owner_publication::fixture();
        let hold = open(&mut store, &owner);
        let mut op = moment(&mut store, 0, "write");
        op.payload["momentId"] = json!(format!("moment-ydoc-{}", "b".repeat(64)));
        let audit_state = if included {
            checkpoint.clone()
        } else {
            let doc = Ydoc::wire();
            doc.apply(&checkpoint).unwrap();
            doc.richdoc_append_paragraph("not in accepted cut");
            doc.encode_full_state()
        };
        let sha = store.put_binary_blob(&audit_state).unwrap();
        let record=json!({"momentId":op.payload["momentId"],"binding":owner.binding,"relayDatabaseNamespace":"relay","terminalCursor":0,"acceptedStateBlobSha256":sha}).to_string();
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
        apply_replication_envelope_with_release_hold(
            &mut store,
            &mut WriterDocCache::new(),
            &op,
            &NoFaults,
            &NoLiveLeases,
            &hold,
        )
        .unwrap();
        assert_eq!(
            store.table_row_count("owner_pending_settlements").unwrap(),
            1
        );
        let accepted = Ydoc::wire();
        accepted.apply(&checkpoint).unwrap();
        let frame = dohc_engine_collab::owner_outbox::accepted::OwnerAcceptedFrameInput {
            binding: owner.binding.clone(),
            relay_database_namespace: "relay".into(),
            expected_revision: owner.revision,
            expected_native_head_sequence: owner.native_head_sequence,
            previous_accepted_cursor: owner.accepted_cursor,
            journal_cursor: 1,
            update_bytes: accepted.richdoc_append_paragraph("later accepted frame"),
        };
        store
            .write_with(&NoFaults, |tx| {
                dohc_engine_collab::owner_outbox::accepted::apply_frame_in_tx(tx, "ws", &frame, 10)
            })
            .unwrap();
        let before = text(&store);
        assert!(before.contains("later accepted frame"));
        // Activation's final commit will unbind with these held rows. Simulate
        // that boundary; #1926 deliberately refuses to unbind a pending row.
        store.write_with(&NoFaults,|tx| {
            seal_release_hold_cut_in(tx,&hold)?;
            release::request_in_tx(tx,&DocKey::new("ws","main","owner").unwrap(),20).map_err(SyncError::corrupt)?;
            tx.execute("DELETE FROM ydoc_owner_bindings",[]).map_err(SyncError::persist)?;
            tx.execute("UPDATE owner_live_stops SET state='released',binding_json=json_set(binding_json,'$.state','released')",[]).map_err(SyncError::persist)?;
            prepare_release_hold_replay_in(tx,&hold,true)
        }).unwrap();
        if let Some(point) = point {
            let faults = ScriptedFaults::crash_at(point);
            let out = replay_release_held_envelope(
                &mut store,
                &mut WriterDocCache::new(),
                &op,
                faults.as_ref(),
                &NoLiveLeases,
                &hold,
            )
            .unwrap();
            assert_eq!(
                out.primary,
                ApplyDisposition::Crashed {
                    committed: point == FaultPoint::StorageAfterCommitBeforeAck
                }
            );
            drop(store);
            store = EngineStore::open(&engine_db_path(&dir).unwrap(), 4).unwrap();
        }
        let out = replay_release_held_envelope(
            &mut store,
            &mut WriterDocCache::new(),
            &op,
            &NoFaults,
            &NoLiveLeases,
            &hold,
        );
        if included {
            assert!(
                matches!(out.unwrap().primary,ApplyDisposition::Applied(ref a) if a.materialization_changes.is_empty() && a.record_facts.is_empty())
            );
            assert_eq!(store.table_row_count("moments").unwrap(), 1);
            assert_eq!(
                store.table_row_count("owner_pending_settlements").unwrap(),
                0
            );
            ack(&mut store, &op);
        } else {
            assert!(matches!(out, Err(SyncError::RetryableState { .. })));
            assert_eq!(store.table_row_count("moments").unwrap(), 0);
            assert_eq!(
                store.table_row_count("owner_pending_settlements").unwrap(),
                1
            );
        }
        assert_eq!(text(&store), before);
    }
}

#[test]
fn held_moment_validates_before_metadata_without_changing_visible_content() {
    let (_dir, mut store, owner, _) = owner_publication::fixture();
    let hold = open(&mut store, &owner);
    let mut op = moment(&mut store, 0, "write");
    op.payload["beforeMetadata"] = json!({"origin":"bad"});
    let count = store.table_row_count("snapshots").unwrap();
    assert!(matches!(
        apply_replication_envelope_with_release_hold(
            &mut store,
            &mut WriterDocCache::new(),
            &op,
            &NoFaults,
            &NoLiveLeases,
            &hold
        )
        .unwrap()
        .primary,
        ApplyDisposition::Refused(_)
    ));
    assert_eq!(store.table_row_count("snapshots").unwrap(), count);
    assert_eq!(store.table_row_count("release_held_ops").unwrap(), 0);
}

#[test]
fn collection_visibility_and_credit_change_only_when_held_update_replays() {
    let (dir, mut store, owner, checkpoint) = record_fixture();
    let hold = open(&mut store, &owner);
    let peer = Ydoc::wire();
    peer.apply(&checkpoint).unwrap();
    let bytes = peer.frontmatter_set("title", "Remote").unwrap();
    let mut op = update(&mut store, &owner, &bytes, 0);
    op.payload["actorOriginId"] = json!("remote-author");
    let before = text(&store);
    let history = store.table_row_count("collection_field_history").unwrap();
    apply_replication_envelope_with_release_hold(
        &mut store,
        &mut WriterDocCache::new(),
        &op,
        &NoFaults,
        &NoLiveLeases,
        &hold,
    )
    .unwrap();
    assert_eq!(text(&store), before);
    assert_eq!(
        store.table_row_count("collection_field_history").unwrap(),
        history
    );
    released(&mut store, &owner, &hold);
    drop(store);
    let mut store = EngineStore::open(&engine_db_path(&dir).unwrap(), 4).unwrap();
    assert_eq!(text(&store), before);
    assert_eq!(
        store.table_row_count("collection_field_history").unwrap(),
        history
    );
    replay_release_held_envelope(
        &mut store,
        &mut WriterDocCache::new(),
        &op,
        &NoFaults,
        &NoLiveLeases,
        &hold,
    )
    .unwrap();
    assert_eq!(text(&store), before);
    let drained = drain_deferred_ydoc_for_key(
        &mut store,
        &mut WriterDocCache::new(),
        &DocKey::new("ws", "main", "owner").unwrap(),
        &NoFaults,
    )
    .unwrap();
    assert_eq!(drained.record_facts.len(), 1);
    assert_eq!(
        drained.record_facts[0].author_origin_id.as_deref(),
        Some("remote-author")
    );
    assert_eq!(drained.record_facts[0].fields[0].field_name, "title");
    assert!(text(&store).contains("Remote"));
    ack(&mut store, &op);
}

#[test]
fn held_replay_rechecks_native_restore_generation() {
    let (_dir, mut store, owner, checkpoint) = owner_publication::fixture();
    let hold = open(&mut store, &owner);
    let peer = Ydoc::wire();
    peer.apply(&checkpoint).unwrap();
    let op = update(
        &mut store,
        &owner,
        &peer.richdoc_append_paragraph("old generation"),
        0,
    );
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
    // Seed the durable native fence left by the concurrent restore adapter.
    store.read_with(|c| c.execute("INSERT INTO live_restore_fences(workspace_id,main_version_id,object_id,relay_database_namespace,operation_id,input_json,receipt_json) VALUES('ws','main','owner','relay','restore',?1,'{}')",
            [json!({"oldBinding":owner.binding,"newFence":1}).to_string()])).unwrap();
    assert!(matches!(
        replay_release_held_envelope(
            &mut store,
            &mut WriterDocCache::new(),
            &op,
            &NoFaults,
            &NoLiveLeases,
            &hold,
        ),
        Err(SyncError::RetryableState { .. })
    ));
    assert_eq!(store.table_row_count("release_held_ops").unwrap(), 1);
    assert_eq!(store.table_row_count("ydoc_deferred_updates").unwrap(), 0);
    assert!(!text(&store).contains("old generation"));
}

#[test]
fn hold_retains_more_than_1024_distinct_credits_without_a_history_author_limit() {
    let (_dir, mut store, owner, checkpoint) = owner_publication::fixture();
    let hold = open(&mut store, &owner);
    let peer = Ydoc::wire();
    peer.apply(&checkpoint).unwrap();
    let before = text(&store);
    for author in 0..1025 {
        let bytes = peer.richdoc_append_paragraph(&format!("edit from author {author}"));
        let mut op = update(&mut store, &owner, &bytes, 0);
        op.origin_id = format!("peer-{author}");
        op.payload["actorOriginId"] = json!(format!("author-{author}"));
        op.relay_seq = Some(author + 1);
        apply_replication_envelope_with_release_hold(
            &mut store,
            &mut WriterDocCache::new(),
            &op,
            &NoFaults,
            &NoLiveLeases,
            &hold,
        )
        .unwrap();
    }
    assert_eq!(store.table_row_count("release_held_ops").unwrap(), 1025);
    assert_eq!(text(&store), before);
    let authors:i64=store.read_with(|c|c.query_row("SELECT COUNT(DISTINCT json_extract(envelope_json,'$.payload.actorOriginId')) FROM release_held_ops",[],|r|r.get(0))).unwrap();
    assert_eq!(authors, 1025);
    let updates:i64=store.read_with(|c|c.query_row("SELECT COUNT(DISTINCT json_extract(envelope_json,'$.payload.updateBlobSha256')) FROM release_held_ops",[],|r|r.get(0))).unwrap();
    assert_eq!(updates, 1025);
}

fn open(store: &mut EngineStore, owner: &ObservedOwnerBinding) -> ReleaseHold {
    match store
        .write_with(&NoFaults, |tx| {
            open_release_hold_in(tx, &owner.binding, "relay", &"a".repeat(64))
        })
        .unwrap()
    {
        TxnOutcome::Committed(hold) => hold,
        _ => panic!("open"),
    }
}
fn released(store: &mut EngineStore, owner: &ObservedOwnerBinding, hold: &ReleaseHold) {
    store
        .write_with(&NoFaults, |tx| {
            seal_release_hold_cut_in(tx, hold)?;
            let key = DocKey::new("ws", "main", "owner").unwrap();
            release::request_in_tx(tx, &key, 20).map_err(SyncError::corrupt)?;
            release::release_in_tx(
                tx,
                &owner.binding,
                owner.accepted_cursor,
                21,
                |_, _, _, _, _| Ok(()),
            )
            .map_err(SyncError::corrupt)?;
            prepare_release_hold_replay_in(tx, hold, true)
        })
        .unwrap();
}
fn update(
    store: &mut EngineStore,
    owner: &ObservedOwnerBinding,
    bytes: &[u8],
    seq: i64,
) -> ReplicationEnvelope {
    let sha = store.put_binary_blob(bytes).unwrap();
    envelope(
        "peer",
        seq,
        "ydoc.update",
        json!({"versionId":"main","objectId":"owner","path":owner.binding.current_path,"contentKind":"richdoc","lineageClaimId":owner.binding.lineage_claim_id,"updateBlobSha256":sha}),
    )
}
fn text(store: &EngineStore) -> String {
    store
        .read_with(|c| {
            dohc_engine_collab::load_doc_in(c, &DocKey::new("ws", "main", "owner").unwrap())
                .map(|d| d.project(ContentKind::Richdoc).unwrap().content)
        })
        .unwrap()
}
fn ack(store: &mut EngineStore, op: &ReplicationEnvelope) {
    store
        .write_with(&NoFaults, |tx| acknowledge_release_replay_in(tx, op))
        .unwrap();
}
fn moment(store: &mut EngineStore, seq: i64, operation: &str) -> ReplicationEnvelope {
    let (before,head):(String,String)=store.read_with(|c|c.query_row("SELECT b.text,s.latest_moment_id FROM snapshots s JOIN blobs b ON b.sha256=s.blob_sha256 WHERE s.object_id='owner'",[],|r|Ok((r.get(0)?,r.get(1)?)))).unwrap();
    let after = if operation == "delete" {
        ""
    } else {
        before.as_str()
    };
    let sha = dohc_engine_storage::hex_sha256(after.as_bytes());
    store
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT OR IGNORE INTO blobs VALUES(?1,?2,?3)",
                params![sha, after.len() as i64, after],
            )
            .map_err(SyncError::persist)
        })
        .unwrap();
    let before_sha = dohc_engine_storage::hex_sha256(before.as_bytes());
    envelope(
        "peer",
        seq,
        "moment.append",
        json!({
            "momentId":format!("peer-{seq}"),"versionId":"main","objectId":"owner","objectCreatedAtMs":1,
            "path":"owner.md","recordedAtMs":2000,"operation":operation,
            "payloadBeforeBlobSha256":before_sha,"payloadBeforePath":"owner.md",
            "payloadAfterBlobSha256":sha,"payloadAfterPath":"owner.md","metadata":{"origin":"sync"},
            "beforePresent":"present","beforeObjectId":"owner","beforeVersionId":"main","beforePath":"owner.md",
            "beforeBlobSha256":before_sha,"beforeUpdatedAtMs":1,"beforeLatestMomentId":head,"beforeMetadata":{"origin":"api"},
            "authors":[{"kind":"human","humanId":"person"},{"kind":"agent","agentId":"agent","onBehalfOf":"person","agentRunId":"run"}]
        }),
    )
}

#[test]
fn hold_is_atomic_with_ack_and_journal_at_every_crash_boundary() {
    for (point, committed) in [
        (FaultPoint::SyncBeforeApplyCommit, false),
        (FaultPoint::StorageBeforePersist, false),
        (FaultPoint::StorageAfterCommitBeforeAck, true),
    ] {
        let (dir, mut store, owner, checkpoint) = owner_publication::fixture();
        let hold = open(&mut store, &owner);
        let before = text(&store);
        let doc = Ydoc::wire();
        doc.apply(&checkpoint).unwrap();
        let op = update(&mut store, &owner, &doc.richdoc_append_paragraph("held"), 0);
        let faults = ScriptedFaults::crash_at(point);
        let out = apply_replication_envelope_with_release_hold(
            &mut store,
            &mut WriterDocCache::new(),
            &op,
            faults.as_ref(),
            &NoLiveLeases,
            &hold,
        )
        .unwrap();
        assert!(faults.fired());
        assert_eq!(out.primary, ApplyDisposition::Crashed { committed });
        drop(store);
        let mut store = EngineStore::open(&engine_db_path(&dir).unwrap(), 3).unwrap();
        assert_eq!(
            store.table_row_count("release_held_ops").unwrap(),
            usize::from(committed) as i64
        );
        assert_eq!(
            read_replication_acked_seq(&store, "ws", "peer").unwrap(),
            if committed { 0 } else { -1 }
        );
        assert_eq!(text(&store), before);
        let restored = read_release_hold(&store, &DocKey::new("ws", "main", "owner").unwrap())
            .unwrap()
            .unwrap();
        assert_eq!(restored, hold);
        apply_replication_envelope_with_release_hold(
            &mut store,
            &mut WriterDocCache::new(),
            &op,
            &NoFaults,
            &NoLiveLeases,
            &hold,
        )
        .unwrap();
        assert_eq!(store.table_row_count("release_held_ops").unwrap(), 1);
    }
}

#[test]
fn hold_keeps_peer_work_through_local_release_and_report_ack() {
    let (dir, mut store, owner, checkpoint) = owner_publication::fixture();
    let hold = open(&mut store, &owner);
    let before = text(&store);
    let doc = Ydoc::wire();
    doc.apply(&checkpoint).unwrap();
    let op = update(
        &mut store,
        &owner,
        &doc.richdoc_append_paragraph("held until replay"),
        0,
    );
    let mut cache = WriterDocCache::new();
    apply_replication_envelope_with_release_hold(
        &mut store,
        &mut cache,
        &op,
        &NoFaults,
        &NoLiveLeases,
        &hold,
    )
    .unwrap();
    assert!(
        replay_release_held_envelope(&mut store, &mut cache, &op, &NoFaults, &NoLiveLeases, &hold)
            .is_err()
    );
    let other_text = "Another document's edit\n";
    let other_sha = dohc_engine_storage::hex_sha256(other_text.as_bytes());
    store
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT OR IGNORE INTO blobs VALUES(?1,?2,?3)",
                params![other_sha, other_text.len() as i64, other_text],
            )
            .map_err(SyncError::persist)
        })
        .unwrap();
    let unrelated = envelope(
        "peer",
        1,
        "moment.append",
        json!({"momentId":"other-document","versionId":"main","objectId":"other","path":"other.md","recordedAtMs":2000,"operation":"write","objectCreatedAtMs":1,
            "payloadAfterBlobSha256":other_sha,"payloadAfterPath":"other.md","metadata":{"origin":"sync"},"beforePresent":"absent","authors":[{"kind":"human","humanId":"person"}]}),
    );
    let ordinary = apply_replication_envelope_with_release_hold(
        &mut store,
        &mut cache,
        &unrelated,
        &NoFaults,
        &NoLiveLeases,
        &hold,
    )
    .unwrap();
    assert!(matches!(ordinary.primary, ApplyDisposition::Applied(_)));
    assert_eq!(read_replication_acked_seq(&store, "ws", "peer").unwrap(), 1);
    assert_eq!(store.table_row_count("release_held_ops").unwrap(), 1);
    let other:String=store.read_with(|c|c.query_row("SELECT b.text FROM snapshots s JOIN blobs b ON b.sha256=s.blob_sha256 WHERE s.object_id='other'",[],|r|r.get(0))).unwrap();
    assert_eq!(other, other_text);
    released(&mut store, &owner, &hold);
    assert_eq!(text(&store), before);
    drop(store);
    let mut store = EngineStore::open(&engine_db_path(&dir).unwrap(), 4).unwrap();
    replay_release_held_envelope(&mut store, &mut cache, &op, &NoFaults, &NoLiveLeases, &hold)
        .unwrap();
    assert_eq!(store.table_row_count("ydoc_deferred_updates").unwrap(), 1);
    assert!(
        store
            .write_with(&NoFaults, |tx| acknowledge_release_replay_in(tx, &op))
            .is_err()
    );
    assert!(matches!(
        store
            .write_with(&NoFaults, |tx| close_release_hold_in(tx, &hold))
            .unwrap(),
        TxnOutcome::Committed(false)
    ));
    drain_deferred_ydoc_for_key(
        &mut store,
        &mut cache,
        &DocKey::new("ws", "main", "owner").unwrap(),
        &NoFaults,
    )
    .unwrap();
    assert!(text(&store).contains("held until replay"));
    let later = update(
        &mut store,
        &owner,
        &doc.richdoc_append_paragraph("late during replay"),
        2,
    );
    apply_replication_envelope_with_release_hold(
        &mut store,
        &mut cache,
        &later,
        &NoFaults,
        &NoLiveLeases,
        &hold,
    )
    .unwrap();
    assert!(!text(&store).contains("late during replay"));
    ack(&mut store, &op);
    assert!(matches!(
        store
            .write_with(&NoFaults, |tx| close_release_hold_in(tx, &hold))
            .unwrap(),
        TxnOutcome::Committed(false)
    ));
    replay_release_held_envelope(
        &mut store,
        &mut cache,
        &later,
        &NoFaults,
        &NoLiveLeases,
        &hold,
    )
    .unwrap();
    drain_deferred_ydoc_for_key(
        &mut store,
        &mut cache,
        &DocKey::new("ws", "main", "owner").unwrap(),
        &NoFaults,
    )
    .unwrap();
    assert!(text(&store).contains("late during replay"));
    ack(&mut store, &later);
    assert!(matches!(
        store
            .write_with(&NoFaults, |tx| close_release_hold_in(tx, &hold))
            .unwrap(),
        TxnOutcome::Committed(true)
    ));
    assert_eq!(read_replication_acked_seq(&store, "ws", "peer").unwrap(), 2);
}

#[test]
fn hold_to_dependency_transfer_restarts_on_both_sides_of_commit() {
    for (point, committed) in [
        (FaultPoint::StorageBeforePersist, false),
        (FaultPoint::StorageAfterCommitBeforeAck, true),
    ] {
        let (dir, mut store, owner, checkpoint) = owner_publication::fixture();
        let hold = open(&mut store, &owner);
        let peer = Ydoc::wire();
        peer.apply(&checkpoint).unwrap();
        let predecessor = peer.richdoc_append_paragraph("predecessor");
        let dependent = peer.richdoc_append_paragraph("dependent");
        let op = update(&mut store, &owner, &dependent, 0);
        let mut cache = WriterDocCache::new();
        apply_replication_envelope_with_release_hold(
            &mut store,
            &mut cache,
            &op,
            &NoFaults,
            &NoLiveLeases,
            &hold,
        )
        .unwrap();
        released(&mut store, &owner, &hold);
        let faults = ScriptedFaults::crash_at(point);
        let out = replay_release_held_envelope(
            &mut store,
            &mut cache,
            &op,
            faults.as_ref(),
            &NoLiveLeases,
            &hold,
        )
        .unwrap();
        assert_eq!(out.primary, ApplyDisposition::Crashed { committed });
        drop(store);
        let mut store = EngineStore::open(&engine_db_path(&dir).unwrap(), 4).unwrap();
        replay_release_held_envelope(
            &mut store,
            &mut WriterDocCache::new(),
            &op,
            &NoFaults,
            &NoLiveLeases,
            &hold,
        )
        .unwrap();
        drain_deferred_ydoc_for_key(
            &mut store,
            &mut WriterDocCache::new(),
            &DocKey::new("ws", "main", "owner").unwrap(),
            &NoFaults,
        )
        .unwrap();
        assert!(!text(&store).contains("dependent"));
        assert!(
            store
                .write_with(&NoFaults, |tx| acknowledge_release_replay_in(tx, &op))
                .is_err()
        );
        let mut prior = update(&mut store, &owner, &predecessor, 0);
        prior.origin_id = "other-peer".into();
        prior.relay_seq = Some(3);
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
        assert!(text(&store).contains("dependent"));
        ack(&mut store, &op);
    }
}

#[test]
fn held_moments_replay_original_person_agent_credit_and_deletes_after_restart() {
    for operation in ["write", "delete"] {
        for (point, committed) in [
            (FaultPoint::SyncBeforeApplyCommit, false),
            (FaultPoint::StorageAfterCommitBeforeAck, true),
        ] {
            let (dir, mut store, owner, _) = owner_publication::fixture();
            let hold = open(&mut store, &owner);
            let op = moment(&mut store, 0, operation);
            let snapshots = store.table_row_count("snapshots").unwrap();
            apply_replication_envelope_with_release_hold(
                &mut store,
                &mut WriterDocCache::new(),
                &op,
                &NoFaults,
                &NoLiveLeases,
                &hold,
            )
            .unwrap();
            assert_eq!(store.table_row_count("snapshots").unwrap(), snapshots);
            assert_eq!(store.table_row_count("moments").unwrap(), 0);
            released(&mut store, &owner, &hold);
            let faults = ScriptedFaults::crash_at(point);
            let out = replay_release_held_envelope(
                &mut store,
                &mut WriterDocCache::new(),
                &op,
                faults.as_ref(),
                &NoLiveLeases,
                &hold,
            )
            .unwrap();
            assert_eq!(out.primary, ApplyDisposition::Crashed { committed });
            drop(store);
            let mut store = EngineStore::open(&engine_db_path(&dir).unwrap(), 4).unwrap();
            let out = replay_release_held_envelope(
                &mut store,
                &mut WriterDocCache::new(),
                &op,
                &NoFaults,
                &NoLiveLeases,
                &hold,
            )
            .unwrap();
            assert!(matches!(out.primary, ApplyDisposition::Applied(_)));
            assert_eq!(store.table_row_count("moments").unwrap(), 1);
            let credit: String = store
                .read_with(|c| {
                    c.query_row(
                        "SELECT author_json FROM moments WHERE moment_id='peer-0'",
                        [],
                        |r| r.get(0),
                    )
                })
                .unwrap();
            assert_eq!(
                serde_json::from_str::<serde_json::Value>(&credit).unwrap(),
                op.payload["authors"]
            );
            let again = replay_release_held_envelope(
                &mut store,
                &mut WriterDocCache::new(),
                &op,
                &NoFaults,
                &NoLiveLeases,
                &hold,
            )
            .unwrap();
            assert_eq!(out, again);
            ack(&mut store, &op);
            if operation == "delete" {
                assert_eq!(store.table_row_count("snapshots").unwrap(), 0);
            }
        }
    }
}

#[test]
fn hold_caps_and_invalid_blobs_do_not_ack_or_refuse_content() {
    let (_dir, mut store, owner, checkpoint) = owner_publication::fixture();
    let hold = open(&mut store, &owner);
    let doc = Ydoc::wire();
    doc.apply(&checkpoint).unwrap();
    let op = update(
        &mut store,
        &owner,
        &doc.richdoc_append_paragraph("capacity"),
        0,
    );
    store
        .write_with(&NoFaults, |tx| {
            tx.execute("INSERT INTO release_hold_usage VALUES('ws',10000,0)", [])
                .map_err(SyncError::persist)
        })
        .unwrap();
    let out = apply_replication_envelope_with_release_hold(
        &mut store,
        &mut WriterDocCache::new(),
        &op,
        &NoFaults,
        &NoLiveLeases,
        &hold,
    );
    assert!(matches!(out, Err(SyncError::RetryableState { .. })));
    assert_eq!(
        read_replication_acked_seq(&store, "ws", "peer").unwrap(),
        -1
    );
    assert_eq!(store.table_row_count("release_held_ops").unwrap(), 0);
    assert_eq!(
        store
            .table_row_count("replication_pending_refusals")
            .unwrap(),
        0
    );
    store
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "UPDATE release_hold_usage SET operation_count=0,retained_bytes=536870912",
                [],
            )
            .map_err(SyncError::persist)
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
    store
        .write_with(&NoFaults, |tx| {
            tx.execute("UPDATE release_hold_usage SET retained_bytes=0", [])
                .map_err(SyncError::persist)
        })
        .unwrap();
    let mut missing = op.clone();
    missing.payload["updateBlobSha256"] = json!("b".repeat(64));
    assert!(matches!(
        apply_replication_envelope_with_release_hold(
            &mut store,
            &mut WriterDocCache::new(),
            &missing,
            &NoFaults,
            &NoLiveLeases,
            &hold
        ),
        Err(SyncError::BlobInvalid)
    ));
    assert_eq!(
        read_replication_acked_seq(&store, "ws", "peer").unwrap(),
        -1
    );
}

#[test]
fn hold_authority_and_redelivery_are_exact_and_replay_keeps_origin_order() {
    let (_dir, mut store, owner, checkpoint) = owner_publication::fixture();
    let hold = open(&mut store, &owner);
    let mut wrong = owner.binding.clone();
    wrong.restore_fence_generation += 1;
    assert!(
        store
            .write_with(&NoFaults, |tx| open_release_hold_in(
                tx,
                &wrong,
                "relay",
                &"a".repeat(64)
            ))
            .is_err()
    );
    assert!(
        store
            .write_with(&NoFaults, |tx| open_release_hold_in(
                tx,
                &owner.binding,
                "other-relay",
                &"a".repeat(64)
            ))
            .is_err()
    );
    let peer = Ydoc::wire();
    peer.apply(&checkpoint).unwrap();
    let first = update(
        &mut store,
        &owner,
        &peer.richdoc_append_paragraph("first"),
        0,
    );
    let second = update(
        &mut store,
        &owner,
        &peer.richdoc_append_paragraph("second"),
        1,
    );
    for op in [&first, &second] {
        apply_replication_envelope_with_release_hold(
            &mut store,
            &mut WriterDocCache::new(),
            op,
            &NoFaults,
            &NoLiveLeases,
            &hold,
        )
        .unwrap();
    }
    let mut changed = first.clone();
    changed.admitted_author_snapshot = Some(json!([]));
    assert!(matches!(
        apply_replication_envelope_with_release_hold(
            &mut store,
            &mut WriterDocCache::new(),
            &changed,
            &NoFaults,
            &NoLiveLeases,
            &hold
        ),
        Err(SyncError::CoordinateDiverged)
    ));
    released(&mut store, &owner, &hold);
    assert!(matches!(
        replay_release_held_envelope(
            &mut store,
            &mut WriterDocCache::new(),
            &second,
            &NoFaults,
            &NoLiveLeases,
            &hold
        ),
        Err(SyncError::SequenceGap)
    ));
    replay_release_held_envelope(
        &mut store,
        &mut WriterDocCache::new(),
        &first,
        &NoFaults,
        &NoLiveLeases,
        &hold,
    )
    .unwrap();
    replay_release_held_envelope(
        &mut store,
        &mut WriterDocCache::new(),
        &second,
        &NoFaults,
        &NoLiveLeases,
        &hold,
    )
    .unwrap();
    assert_eq!(
        read_release_hold_page(&store, &hold).unwrap(),
        vec![first, second]
    );
}

fn record_fixture() -> (ScratchDir, EngineStore, ObservedOwnerBinding, Vec<u8>) {
    let (dir, _, mut store) = open_store();
    seed_identity(&mut store);
    VersionedTextStore::new(&mut store)
        .ensure_main_version("ws", "main", 0, &NoFaults)
        .unwrap();
    let markdown = "---\nid: rec_aaaaaaaaaaaaaaaaaaaaaaaaaa\ntitle: Original\n---\n\nBody\n";
    seed_text_head(
        &mut store,
        "schema",
        "tasks/collection.yaml",
        "fields:\n  title:\n    type: text\n",
    );
    seed_text_head(&mut store, "owner", "tasks/owner.md", markdown);
    store
        .write_with(&NoFaults, |tx| {
            dohc_engine_domain::reconcile_collections_in_tx(tx, "ws", "main")?;
            dohc_engine_domain::set_collection_adoption_state_in_tx(
                tx,
                "ws",
                "main",
                "tasks/owner.md",
                "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa",
                "adopted",
            )
        })
        .unwrap();
    let seed = Ydoc::wire();
    seed.rewrite_content_to_markdown(ContentKind::Richdoc, markdown)
        .unwrap();
    let original = seed.encode_full_state();
    let key = DocKey::new("ws", "main", "owner").unwrap();
    dohc_engine_collab::claim_base(
        &mut store,
        &key,
        ContentKind::Richdoc,
        &original,
        &NoFaults,
        2,
    )
    .unwrap();
    let doc = Ydoc::wire();
    doc.apply(&original).unwrap();
    let checkpoint = doc.encode_full_state();
    let head = store
        .read_with(|conn| dohc_engine_collab::read_marker_in(conn, &key))
        .unwrap()
        .unwrap()
        .head_update_seq;
    let observed = ObservedOwnerBinding {
        binding: dohc_engine_collab::LiveObjectBinding {
            workspace_id: "ws".into(),
            main_version_id: "main".into(),
            object_id: "owner".into(),
            lineage_claim_id: dohc_engine_storage::hex_sha256(&original),
            current_path: "tasks/owner.md".into(),
            selector_paths: vec!["tasks/owner.md".into()],
            restore_fence_generation: 0,
        },
        relay_database_namespace: "relay".into(),
        revision: 1,
        accepted_cursor: 0,
        native_head_sequence: head,
        checkpoint_digest: dohc_engine_storage::hex_sha256(&checkpoint),
        limits: dohc_engine_collab::owner_outbox::OwnerOutboxLimits {
            max_pending_bytes: 1_000_000,
            max_pending_age_ms: 60_000,
        },
    };
    store
        .write_with(&NoFaults, |tx| {
            tx.execute("UPDATE ydoc_docs SET path='tasks/owner.md'", [])
                .unwrap();
            dohc_engine_collab::owner_outbox::draft::install_observed_binding_in_tx(
                tx,
                "ws",
                &observed,
                &checkpoint,
            )
        })
        .unwrap();
    (dir, store, observed, checkpoint)
}
