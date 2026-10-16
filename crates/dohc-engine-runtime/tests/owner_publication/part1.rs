use super::*;
use dohc_engine_collab::{
    WriterDocCache,
    owner_outbox::{enrollment, prefix},
};
use dohc_engine_runtime::actor::OwnerReleaseLifecycle as Action;
use dohc_engine_storage::StorageError;
use dohc_engine_sync::{self as sync, NoLiveLeases, ReleaseHold, ReplicationEnvelope};
use rusqlite::params;

fn key() -> DocKey {
    DocKey::new("workspace", "main", "object").unwrap()
}

async fn lifecycle(
    actor: &ActorHandle,
    action: Action,
) -> Result<ReleaseHold, dohc_engine_runtime::RuntimeError> {
    actor
        .owner_release_lifecycle(action, 40, Arc::new(NoFaults), CancellationToken::new())
        .await
}

async fn begin(f: &Fixture, actor: &ActorHandle) -> ReleaseHold {
    lifecycle(
        actor,
        Action::Begin {
            binding: f.binding.clone(),
            namespace: "relay".into(),
            digest: "a".repeat(64),
        },
    )
    .await
    .unwrap()
}

fn seal(f: &mut Fixture, h: &ReleaseHold) {
    f.store
        .write_with(&NoFaults, |tx| {
            let cursor: i64 = tx
                .query_row("SELECT accepted_cursor FROM ydoc_owner_bindings", [], |r| {
                    r.get(0)
                })
                .unwrap();
            sync::seal_release_hold_cut_in(tx, h, cursor).map_err(StorageError::corrupt_public)?;
            prefix::seal_in_tx(tx, &f.binding, h.digest(), cursor, 50)
                .map_err(StorageError::corrupt_public)?;
            Ok::<_, StorageError>(())
        })
        .unwrap();
}

async fn save(f: &Fixture, actor: &ActorHandle, h: &ReleaseHold) {
    actor
        .owner_release_settle(
            h.clone(),
            f.root.path().to_owned(),
            Arc::new(()),
            60,
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .unwrap();
}

fn update(f: &mut Fixture, bytes: &[u8], origin: &str, seq: i64) -> ReplicationEnvelope {
    let sha = f.store.put_binary_blob(bytes).unwrap();
    ReplicationEnvelope {
        workspace_id: "workspace".into(),
        origin_id: origin.into(),
        origin_seq: seq,
        relay_seq: Some(seq + 1),
        recorded_at_ms: 100,
        op_kind: "ydoc.update".into(),
        settlement_admission: None,
        admitted_author_snapshot: None,
        payload: serde_json::json!({"versionId":"main","objectId":"object","path":f.binding.current_path,"contentKind":"richdoc","lineageClaimId":f.binding.lineage_claim_id,"updateBlobSha256":sha}),
    }
}

fn retain(f: &mut Fixture, h: &ReleaseHold, op: &ReplicationEnvelope) {
    let result = sync::apply_replication_envelope_with_release_hold(
        &mut f.store,
        &mut WriterDocCache::new(),
        op,
        &NoFaults,
        &NoLiveLeases,
        h,
    )
    .unwrap();
    assert!(
        matches!(result.primary, sync::ApplyDisposition::Applied(_)),
        "{result:?}"
    );
}

fn pending_settlement(f: &mut Fixture) -> ReplicationEnvelope {
    let sha = hex_sha256(f.text.as_bytes());
    let mut op = ReplicationEnvelope {
        workspace_id: "workspace".into(),
        origin_id: "host".into(),
        origin_seq: 0,
        relay_seq: Some(1),
        recorded_at_ms: 100,
        op_kind: "moment.append".into(),
        settlement_admission: None,
        admitted_author_snapshot: None,
        payload: serde_json::json!({
            "momentId":format!("moment-ydoc-{}","b".repeat(64)),"versionId":"main","objectId":"object","objectCreatedAtMs":1,
            "path":f.binding.current_path,"recordedAtMs":100,"operation":"write",
            "payloadBeforeBlobSha256":sha,"payloadBeforePath":f.binding.current_path,
            "payloadAfterBlobSha256":sha,"payloadAfterPath":f.binding.current_path,"metadata":{"origin":"sync"},
            "beforePresent":"present","beforeObjectId":"object","beforeVersionId":"main","beforePath":f.binding.current_path,
            "beforeBlobSha256":sha,"beforeUpdatedAtMs":1,"beforeLatestMomentId":"original","beforeMetadata":{"origin":"api"}
        }),
    };
    let checkpoint = f
        .store
        .read_with(|c| {
            c.query_row(
                "SELECT checkpoint_digest FROM ydoc_owner_bindings",
                [],
                |r| r.get::<_, String>(0),
            )
        })
        .unwrap();
    let record=serde_json::json!({"momentId":op.payload["momentId"],"binding":f.binding,"relayDatabaseNamespace":"relay","terminalCursor":1,"acceptedStateBlobSha256":checkpoint}).to_string();
    // Authenticated audit-import output; ingestion has its own proof tests.
    f.store
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT INTO live_audit_settlements VALUES('audit','workspace',?1,?2,?3)",
                params![hex_sha256(record.as_bytes()), record, sha],
            )
            .map_err(StorageError::persist_public)
        })
        .unwrap();
    op.payload.as_object_mut().unwrap().remove("authors");
    let result = sync::apply_replication_envelope(
        &mut f.store,
        &mut WriterDocCache::new(),
        &op,
        &NoFaults,
        &NoLiveLeases,
    )
    .unwrap();
    assert!(
        matches!(result.primary, sync::ApplyDisposition::Applied(_)),
        "{result:?}"
    );
    assert_eq!(
        f.store
            .table_row_count("owner_pending_settlements")
            .unwrap(),
        1
    );
    op
}

#[tokio::test]
async fn part1_adopts_preexisting_pending_and_runtime_unbind_exempts_only_exact_ownership() {
    let (mut f, supervisor, actor) = pending_release_fixture(0).await;
    let op = pending_settlement(&mut f);
    actor
        .owner_ydoc_apply_accepted(
            "workspace".into(),
            dohc_engine_collab::owner_outbox::accepted::OwnerAcceptedFrameInput {
                binding: f.binding.clone(),
                relay_database_namespace: "relay".into(),
                expected_revision: 1,
                expected_native_head_sequence: 0,
                previous_accepted_cursor: 0,
                journal_cursor: 1,
                update_bytes: vec![0, 0],
            },
            45,
            CancellationToken::new(),
            Arc::new(()),
        )
        .await
        .unwrap()
        .unwrap();
    let h = begin(&f, &actor).await;
    seal(&mut f, &h);
    save(&f, &actor, &h).await;
    assert!(lifecycle(&actor, Action::Unbind(h.clone())).await.is_err());
    lifecycle(&actor, Action::Adopt(h.clone())).await.unwrap();
    for sql in [
        "UPDATE release_held_ops SET release_digest=replace(release_digest,'a','c')",
        "UPDATE release_held_ops SET object_id='another'",
        "UPDATE release_held_ops SET envelope_json=json_set(envelope_json,'$.recordedAtMs',101)",
        "UPDATE owner_pending_settlements SET binding_json=json_set(binding_json,'$.restoreFenceGeneration',1)",
    ] {
        f.store
            .write_with(&NoFaults, |tx| {
                tx.execute(sql, []).map_err(StorageError::persist_public)
            })
            .unwrap();
        assert!(
            lifecycle(&actor, Action::Unbind(h.clone())).await.is_err(),
            "{sql}"
        );
        assert_eq!(f.store.table_row_count("ydoc_owner_bindings").unwrap(), 1);
        f.store.write_with(&NoFaults,|tx| {
            tx.execute("UPDATE release_held_ops SET release_digest=?1,object_id='object',envelope_json=?2",params![h.digest(),serde_json::to_string(&op).unwrap()]).unwrap();
            tx.execute("UPDATE owner_pending_settlements SET binding_json=?1",[serde_json::to_string(&f.binding).unwrap()]).unwrap();
            Ok::<_,StorageError>(())
        }).unwrap();
    }
    lifecycle(&actor, Action::Unbind(h.clone())).await.unwrap();
    assert_eq!(f.store.table_row_count("ydoc_owner_bindings").unwrap(), 0);
    f.store
        .write_with(&NoFaults, |tx| {
            sync::prepare_release_hold_replay_in(tx, &h, true)
        })
        .unwrap();
    let before = dohc_engine_collab::load_persisted(&f.store, &key())
        .unwrap()
        .unwrap()
        .doc
        .encode_full_state();
    actor
        .owner_release_replay(
            h,
            op,
            Arc::new(NoLiveLeases),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(
        dohc_engine_collab::load_persisted(&f.store, &key())
            .unwrap()
            .unwrap()
            .doc
            .encode_full_state(),
        before
    );
    supervisor.close_all().unwrap();
}

#[tokio::test]
async fn part1_abandonment_fences_acknowledged_dependencies_and_retains_restart_wake() {
    let (mut f, supervisor, actor) = pending_release_fixture(0).await;
    let h = begin(&f, &actor).await;
    let peer = Ydoc::wire();
    peer.apply(&f.bytes).unwrap();
    let prior = peer.richdoc_append_paragraph("predecessor");
    let dependent = update(
        &mut f,
        &peer.richdoc_append_paragraph("dependent"),
        "peer",
        0,
    );
    retain(&mut f, &h, &dependent);
    seal(&mut f, &h);
    save(&f, &actor, &h).await;
    lifecycle(&actor, Action::Unbind(h.clone())).await.unwrap();
    f.store
        .write_with(&NoFaults, |tx| {
            sync::prepare_release_hold_replay_in(tx, &h, true)
        })
        .unwrap();
    actor
        .owner_release_replay(
            h.clone(),
            dependent.clone(),
            Arc::new(sync::AlwaysLive),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(f.store.table_row_count("ydoc_deferred_updates").unwrap(), 1);
    f.store
        .write_with(&NoFaults, |tx| {
            sync::acknowledge_release_replay_in(tx, &dependent)
        })
        .unwrap();
    lifecycle(&actor, Action::Abandon(h.clone())).await.unwrap();
    let prior = update(&mut f, &prior, "other-peer", 0);
    // The ordinary arrival also tries the deferred drain, which must observe abandonment.
    assert!(
        sync::apply_replication_envelope(
            &mut f.store,
            &mut WriterDocCache::new(),
            &prior,
            &NoFaults,
            &NoLiveLeases,
        )
        .is_err()
    );
    assert!(
        sync::drain_deferred_ydoc_for_key(
            &mut f.store,
            &mut WriterDocCache::new(),
            &key(),
            &NoFaults
        )
        .is_err()
    );
    assert!(
        actor
            .owner_release_replay(
                h.clone(),
                dependent.clone(),
                Arc::new(NoLiveLeases),
                Arc::new(NoFaults),
                CancellationToken::new()
            )
            .await
            .is_err()
    );
    supervisor.close_all().unwrap();
    let actor = supervisor.open(&f.db, 50).unwrap().actor;
    assert_eq!(
        actor
            .owner_release_deferred_wakes("workspace".into(), None)
            .await
            .unwrap(),
        vec![key()]
    );
    assert!(
        sync::drain_deferred_ydoc_for_key(
            &mut f.store,
            &mut WriterDocCache::new(),
            &key(),
            &NoFaults
        )
        .is_err()
    );
    assert_eq!(f.store.table_row_count("ydoc_deferred_updates").unwrap(), 1);
    supervisor.close_all().unwrap();
}

#[tokio::test]
async fn part1_same_generation_successor_rekeys_atomically_and_keeps_private_tail_nonpublishable() {
    for fault in [
        dohc_engine_storage::FaultPoint::StorageBeforePersist,
        dohc_engine_storage::FaultPoint::StorageAfterCommitBeforeAck,
    ] {
        let (mut f, supervisor, actor) = pending_release_fixture(1).await;
        let h = begin(&f, &actor).await;
        let peer = Ydoc::wire();
        peer.apply(&f.bytes).unwrap();
        let op = update(
            &mut f,
            &peer.richdoc_append_paragraph("held peer"),
            "peer",
            0,
        );
        retain(&mut f, &h, &op);
        lifecycle(&actor, Action::Abandon(h.clone())).await.unwrap();
        assert!(
            actor
                .owner_release_replay(
                    h.clone(),
                    op.clone(),
                    Arc::new(NoLiveLeases),
                    Arc::new(NoFaults),
                    CancellationToken::new()
                )
                .await
                .is_err()
        );
        let local = dohc_engine_collab::load_persisted(&f.store, &key())
            .unwrap()
            .unwrap();
        let input = enrollment::OwnerEnrollmentInput {
            binding: f.binding.clone(),
            relay_database_namespace: "relay".into(),
            captured: enrollment::OwnerEnrollmentCapture {
                native_head_sequence: local.marker.head_update_seq,
                local_state_digest: hex_sha256(&local.doc.encode_full_state()),
            },
            journal_cursor: 0,
            checkpoint: f.bytes.clone(),
            host_vector: f.doc.encode_state_vector(),
            recovery: true,
        };
        // The host cut is the baseline, not the editor's private pending document.
        let baseline = Ydoc::wire();
        baseline.apply(&f.bytes).unwrap();
        let input = enrollment::OwnerEnrollmentInput {
            host_vector: baseline.encode_state_vector(),
            ..input
        };
        let usage = f
            .store
            .read_with(|c| {
                c.query_row(
                    "SELECT operation_count,retained_bytes FROM release_hold_usage",
                    [],
                    |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)),
                )
            })
            .unwrap();
        let faults = dohc_engine_testkit::ScriptedFaults::crash_at(fault);
        let result = actor
            .owner_release_lifecycle(
                Action::Successor {
                    hold: h.clone(),
                    input: Box::new(input.clone()),
                    digest: "b".repeat(64),
                },
                40,
                faults,
                CancellationToken::new(),
            )
            .await;
        assert!(result.is_err());
        supervisor.close_all().unwrap();
        let actor = supervisor.open(&f.db, 50).unwrap().actor;
        let committed = fault == dohc_engine_storage::FaultPoint::StorageAfterCommitBeforeAck;
        let current = sync::read_release_hold(&f.store, &key()).unwrap().unwrap();
        assert_eq!(
            current.digest(),
            if committed {
                "b".repeat(64)
            } else {
                "a".repeat(64)
            }
        );
        let current = if committed {
            current
        } else {
            lifecycle(
                &actor,
                Action::Successor {
                    hold: h.clone(),
                    input: Box::new(input),
                    digest: "b".repeat(64),
                },
            )
            .await
            .unwrap()
        };
        assert_eq!(
            f.store
                .read_with(|c| c.query_row(
                    "SELECT operation_count,retained_bytes FROM release_hold_usage",
                    [],
                    |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?))
                ))
                .unwrap(),
            usage
        );
        assert_eq!(
            f.store.table_row_count("owner_release_recoveries").unwrap(),
            1
        );
        let doc = dohc_engine_collab::load_persisted(&f.store, &key())
            .unwrap()
            .unwrap()
            .doc;
        assert!(
            !doc.project(ContentKind::Richdoc)
                .unwrap()
                .content
                .contains("Pending edit")
        );
        let tail:i64=f.store.read_with(|c|c.query_row("SELECT count(*) FROM owner_ydoc_outbox_entries WHERE terminal_blob_digest IS NOT NULL AND pending=0",[],|r|r.get(0))).unwrap();
        assert_eq!(tail, 1);
        assert!(
            actor
                .owner_release_replay(
                    h,
                    op.clone(),
                    Arc::new(NoLiveLeases),
                    Arc::new(NoFaults),
                    CancellationToken::new()
                )
                .await
                .is_err()
        );
        assert_eq!(current.binding().restore_fence_generation, 0);
        supervisor.close_all().unwrap();
    }
}

fn fold(f: &mut Fixture, h: &ReleaseHold) {
    prefix::commit_prefix(
        &mut f.store,
        &mut WriterDocCache::new(),
        &f.binding,
        h.digest(),
        55,
        &NoFaults,
        |tx, bytes, actor, credit| {
            sync::journal_prefix_update_in_tx(tx, &f.binding, bytes, actor, credit, 55).map_err(
                |e| dohc_engine_collab::CollabError::Storage(StorageError::corrupt_public(e)),
            )
        },
    )
    .unwrap();
}

#[tokio::test]
async fn part1_cleanup_orders_closure_before_reclamation_and_fences_late_runtime_retries() {
    let (mut f, supervisor, actor) = pending_release_fixture(1).await;
    let h = begin(&f, &actor).await;
    let (outbox, update_sha): (String,String) = f.store.read_with(|c|c.query_row(
        "SELECT outbox_id,update_digest FROM owner_ydoc_outbox_entries WHERE append_key='pending-0'",[],|r|Ok((r.get(0)?,r.get(1)?)))).unwrap();
    let bytes = f.store.get_binary_blob(&update_sha).unwrap().unwrap();
    let retry = dohc_engine_collab::OwnerOutboxAppendInput {
        binding: f.binding.clone(),
        base_update: f.bytes.clone(),
        append_key: "pending-0".into(),
        update: bytes,
        limits: dohc_engine_collab::OwnerOutboxLimits {
            max_pending_bytes: 1_000_000,
            max_pending_age_ms: 100_000,
        },
        created_at_ms: 10,
    };
    seal(&mut f, &h);
    fold(&mut f, &h);
    save(&f, &actor, &h).await;
    lifecycle(&actor, Action::Unbind(h.clone())).await.unwrap();
    assert!(
        lifecycle(&actor, Action::FinishCleanup(h.clone()))
            .await
            .is_err()
    );
    assert!(
        lifecycle(
            &actor,
            Action::CleanupSession {
                hold: h.clone(),
                outbox: outbox.clone()
            }
        )
        .await
        .is_err()
    );
    // Parent cleanup is permitted while the consumed result still owns retry identity.
    f.store
        .write_with(&NoFaults, |tx| {
            prefix::cleanup_session_page_in_tx(tx, &f.binding)
        })
        .unwrap();
    assert_eq!(f.store.table_row_count("owner_ydoc_outboxes").unwrap(), 0);
    let first = actor
        .owner_ydoc_outbox_append("workspace".into(), retry.clone(), CancellationToken::new())
        .await
        .unwrap()
        .unwrap();
    let second = actor
        .owner_ydoc_outbox_append("workspace".into(), retry.clone(), CancellationToken::new())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(first, second);
    assert_eq!(f.store.table_row_count("owner_ydoc_outboxes").unwrap(), 0);
    lifecycle(
        &actor,
        Action::CloseSession {
            hold: h.clone(),
            outbox: outbox.clone(),
        },
    )
    .await
    .unwrap();
    lifecycle(
        &actor,
        Action::CleanupSession {
            hold: h.clone(),
            outbox,
        },
    )
    .await
    .unwrap();
    assert!(
        actor
            .owner_ydoc_outbox_append("workspace".into(), retry.clone(), CancellationToken::new())
            .await
            .unwrap()
            .is_err()
    );
    f.store
        .write_with(&NoFaults, |tx| {
            sync::prepare_release_hold_replay_in(tx, &h, true)?;
            assert!(sync::close_release_hold_in(tx, &h)?);
            // The transport ACK is fixture input; publication orchestration belongs to part 2.
            tx.execute("UPDATE sync_relay_push_state SET pushed_seq=1000000", [])
                .map_err(StorageError::persist_public)
                .map_err(sync::SyncError::Storage)?;
            Ok::<_, sync::SyncError>(())
        })
        .unwrap();
    lifecycle(&actor, Action::FinishCleanup(h)).await.unwrap();
    assert!(
        f.store
            .read_with(|c| prefix::progress_in(c, &key()))
            .unwrap()
            .is_none()
    );
    supervisor.close_all().unwrap();
    let actor = supervisor.open(&f.db, 60).unwrap().actor;
    assert!(
        actor
            .owner_ydoc_outbox_append("workspace".into(), retry.clone(), CancellationToken::new())
            .await
            .unwrap()
            .is_err()
    );
    f.store
        .write_with(&NoFaults, |tx| {
            tx.execute("DELETE FROM owner_live_stops", [])
                .map_err(StorageError::persist_public)
        })
        .unwrap();
    assert!(
        actor
            .owner_ydoc_outbox_append("workspace".into(), retry, CancellationToken::new())
            .await
            .unwrap()
            .is_err()
    );
    assert_eq!(f.store.table_row_count("owner_ydoc_outboxes").unwrap(), 0);
    supervisor.close_all().unwrap();
}

#[tokio::test]
async fn part1_successor_rekeys_acknowledged_deferred_wake_and_replays_only_new_identity() {
    let (mut f, supervisor, actor) = pending_release_fixture(0).await;
    let h = begin(&f, &actor).await;
    let peer = Ydoc::wire();
    peer.apply(&f.bytes).unwrap();
    let op = update(
        &mut f,
        &peer.richdoc_append_paragraph("successor peer"),
        "peer",
        0,
    );
    retain(&mut f, &h, &op);
    seal(&mut f, &h);
    save(&f, &actor, &h).await;
    lifecycle(&actor, Action::Unbind(h.clone())).await.unwrap();
    f.store
        .write_with(&NoFaults, |tx| {
            sync::prepare_release_hold_replay_in(tx, &h, true)
        })
        .unwrap();
    actor
        .owner_release_replay(
            h.clone(),
            op.clone(),
            Arc::new(sync::AlwaysLive),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    f.store
        .write_with(&NoFaults, |tx| sync::acknowledge_release_replay_in(tx, &op))
        .unwrap();
    assert_eq!(f.store.table_row_count("release_held_ops").unwrap(), 0);
    assert_eq!(f.store.table_row_count("ydoc_deferred_updates").unwrap(), 1);
    lifecycle(&actor, Action::Abandon(h.clone())).await.unwrap();
    let input = enrollment::OwnerEnrollmentInput {
        binding: f.binding.clone(),
        relay_database_namespace: "relay".into(),
        captured: enrollment::OwnerEnrollmentCapture {
            native_head_sequence: 0,
            local_state_digest: hex_sha256(&f.bytes),
        },
        journal_cursor: 0,
        checkpoint: f.bytes.clone(),
        host_vector: f.doc.encode_state_vector(),
        recovery: true,
    };
    let mut restored = input.clone();
    restored.binding.restore_fence_generation += 1;
    assert!(
        lifecycle(
            &actor,
            Action::Successor {
                hold: h.clone(),
                input: Box::new(restored),
                digest: "b".repeat(64)
            }
        )
        .await
        .is_err()
    );
    let next = lifecycle(
        &actor,
        Action::Successor {
            hold: h.clone(),
            input: Box::new(input),
            digest: "b".repeat(64),
        },
    )
    .await
    .unwrap();
    assert_eq!(
        f.store
            .read_with(|c| c.query_row(
                "SELECT release_digest FROM ydoc_deferred_updates",
                [],
                |r| r.get::<_, String>(0)
            ))
            .unwrap(),
        next.digest()
    );
    assert!(
        actor
            .owner_release_replay(
                h,
                op.clone(),
                Arc::new(NoLiveLeases),
                Arc::new(NoFaults),
                CancellationToken::new()
            )
            .await
            .is_err()
    );
    supervisor.close_all().unwrap();
    let actor = supervisor.open(&f.db, 80).unwrap().actor;
    assert_eq!(
        actor
            .owner_release_deferred_wakes("workspace".into(), None)
            .await
            .unwrap(),
        vec![key()]
    );
    sync::drain_deferred_ydoc_for_ended_session(
        &mut f.store,
        &mut WriterDocCache::new(),
        &key(),
        &NoLiveLeases,
        &NoFaults,
    )
    .unwrap();
    assert_eq!(f.store.table_row_count("ydoc_deferred_updates").unwrap(), 1);
    assert_eq!(
        actor
            .owner_release_deferred_wakes("workspace".into(), None)
            .await
            .unwrap(),
        vec![key()]
    );
    let before = dohc_engine_collab::load_persisted(&f.store, &key())
        .unwrap()
        .unwrap()
        .doc;
    assert!(
        !before
            .project(ContentKind::Richdoc)
            .unwrap()
            .content
            .contains("successor peer")
    );
    // The successor's authenticated host frame admits this peer delta. A wake alone must not do so.
    actor
        .owner_ydoc_apply_accepted(
            "workspace".into(),
            dohc_engine_collab::owner_outbox::accepted::OwnerAcceptedFrameInput {
                binding: f.binding.clone(),
                relay_database_namespace: "relay".into(),
                expected_revision: 2,
                expected_native_head_sequence: 0,
                previous_accepted_cursor: 0,
                journal_cursor: 1,
                update_bytes: f
                    .store
                    .get_binary_blob(op.payload["updateBlobSha256"].as_str().unwrap())
                    .unwrap()
                    .unwrap(),
            },
            90,
            CancellationToken::new(),
            Arc::new(()),
        )
        .await
        .unwrap()
        .unwrap();
    let drained = sync::drain_deferred_ydoc_for_live_session(
        &mut f.store,
        &mut WriterDocCache::new(),
        &key(),
        Some(&f.binding.lineage_claim_id),
        &NoFaults,
    )
    .unwrap();
    assert!(drained.refusals.is_empty());
    assert_eq!(f.store.table_row_count("ydoc_deferred_updates").unwrap(), 0);
    let doc = dohc_engine_collab::load_persisted(&f.store, &key())
        .unwrap()
        .unwrap()
        .doc;
    assert!(
        doc.project(ContentKind::Richdoc)
            .unwrap()
            .content
            .contains("successor peer")
    );
    assert!(
        actor
            .owner_release_deferred_wakes("workspace".into(), None)
            .await
            .unwrap()
            .is_empty()
    );
    supervisor.close_all().unwrap();
}
