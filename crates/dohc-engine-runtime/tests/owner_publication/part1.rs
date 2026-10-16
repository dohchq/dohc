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
    assert!(matches!(
        lifecycle(&actor, Action::Unbind(h.clone())).await,
        Err(dohc_engine_runtime::RuntimeError::Sync(
            sync::SyncError::RetryableState { .. }
        ))
    ));
    lifecycle(&actor, Action::Adopt(h.clone())).await.unwrap();
    for sql in [
        "UPDATE release_held_ops SET release_digest=replace(release_digest,'a','c')",
        "UPDATE release_held_ops SET object_id='another'",
        "UPDATE release_held_ops SET envelope_json=json_set(envelope_json,'$.recordedAtMs',101)",
        "UPDATE release_holds SET relay_namespace='other-relay'",
        "UPDATE owner_pending_settlements SET binding_json=json_set(binding_json,'$.restoreFenceGeneration',1)",
    ] {
        f.store
            .write_with(&NoFaults, |tx| {
                tx.execute(sql, []).map_err(StorageError::persist_public)
            })
            .unwrap();
        assert!(
            matches!(
                lifecycle(&actor, Action::Unbind(h.clone())).await,
                Err(dohc_engine_runtime::RuntimeError::Sync(
                    sync::SyncError::RetryableState { .. }
                ))
            ),
            "{sql}"
        );
        assert_eq!(f.store.table_row_count("ydoc_owner_bindings").unwrap(), 1);
        f.store.write_with(&NoFaults,|tx| {
            tx.execute("UPDATE release_held_ops SET release_digest=?1,object_id='object',envelope_json=?2",params![h.digest(),serde_json::to_string(&op).unwrap()]).unwrap();
            tx.execute("UPDATE release_holds SET relay_namespace='relay'",[]).unwrap();
            tx.execute("UPDATE owner_pending_settlements SET relay_namespace='relay',binding_json=?1",[serde_json::to_string(&f.binding).unwrap()]).unwrap();
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
    actor
        .versioned_text_write(
            dohc_engine_domain::WriteText {
                workspace_id: "workspace".into(),
                version_id: "main".into(),
                object_id: "schema".into(),
                path: "notes/.collection.json".into(),
                text: r#"{"fields":{"status":{"type":"text"}}}"#.into(),
                moment_id: "schema-moment".into(),
                metadata_origin: "api".into(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 70,
                request_id: None,
            },
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    // The current Collection index must survive an older History-only arrival.
    f.store.write_with(&NoFaults, |tx| {
        tx.execute("INSERT INTO collections VALUES ('workspace','main','notes','notes/.collection.json','valid','[]') ON CONFLICT DO NOTHING", []).unwrap();
        tx.execute("INSERT INTO collection_records (workspace_id,version_id,record_id,collection_path,file_path,object_id,adoption_state,index_initialized) VALUES ('workspace','main','rec_00000000000000000000000000','notes','notes/owner.md','object','adopted',1)", []).unwrap();
        tx.execute("INSERT INTO collection_record_fields VALUES ('workspace','main','rec_00000000000000000000000000','status','\"kept\"','valid',NULL)", []).unwrap();
        Ok::<_, StorageError>(())
    }).unwrap();
    let before = dohc_engine_collab::load_persisted(&f.store, &key())
        .unwrap()
        .unwrap()
        .doc
        .encode_full_state();
    let moment = op.payload["momentId"].as_str().unwrap().to_owned();
    let indexed = f
        .store
        .read_with(|c| {
            dohc_engine_domain::collections::indexed_collection_record_frontmatter_in_tx(
                c,
                "workspace",
                "main",
                "object",
            )
        })
        .unwrap();
    assert_eq!(indexed, Some(serde_json::json!({"status":"kept"})));
    let replay = actor
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
    assert!(
        matches!(replay.0.primary,sync::ApplyDisposition::Applied(ref result) if result.record_facts.is_empty())
    );
    assert_eq!(
        f.store
            .read_with(|c| c.query_row(
                "SELECT count(*) FROM moments WHERE moment_id=?1",
                [moment],
                |r| r.get::<_, i64>(0)
            ))
            .unwrap(),
        1
    );
    assert_eq!(
        f.store
            .read_with(|c| {
                dohc_engine_domain::collections::indexed_collection_record_frontmatter_in_tx(
                    c,
                    "workspace",
                    "main",
                    "object",
                )
            })
            .unwrap(),
        indexed
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
    lifecycle(
        &actor,
        Action::Abandon {
            hold: h.clone(),
            resolved_digest: h.digest().into(),
        },
    )
    .await
    .unwrap();
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
        .is_ok()
    );
    assert!(
        sync::drain_deferred_ydoc_for_key(
            &mut f.store,
            &mut WriterDocCache::new(),
            &key(),
            &NoFaults
        )
        .is_ok()
    );
    assert!(matches!(
        actor
            .owner_release_replay(
                h.clone(),
                dependent.clone(),
                Arc::new(NoLiveLeases),
                Arc::new(NoFaults),
                CancellationToken::new()
            )
            .await,
        Err(dohc_engine_runtime::RuntimeError::Sync(
            sync::SyncError::RetryableState { .. }
        ))
    ));
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
        .is_ok()
    );
    assert_eq!(f.store.table_row_count("ydoc_deferred_updates").unwrap(), 1);
    let text = dohc_engine_collab::load_persisted(&f.store, &key())
        .unwrap()
        .unwrap()
        .doc
        .project(ContentKind::Richdoc)
        .unwrap()
        .content;
    assert!(!text.contains("dependent"));
    supervisor.close_all().unwrap();
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
    assert!(matches!(
        lifecycle(&actor, Action::FinishCleanup(h.clone())).await,
        Err(dohc_engine_runtime::RuntimeError::Sync(
            sync::SyncError::Storage(StorageError::StateCorrupt { .. })
        ))
    ));
    assert!(matches!(
        lifecycle(
            &actor,
            Action::CleanupSession {
                hold: h.clone(),
                outbox: outbox.clone()
            }
        )
        .await,
        Err(dohc_engine_runtime::RuntimeError::Sync(
            sync::SyncError::Storage(StorageError::StateCorrupt { .. })
        ))
    ));
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
    assert!(matches!(
        actor
            .owner_ydoc_outbox_append("workspace".into(), retry.clone(), CancellationToken::new())
            .await
            .unwrap(),
        Err(dohc_engine_collab::OwnerOutboxError::ParentMismatch)
    ));
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
    assert!(matches!(
        actor
            .owner_ydoc_outbox_append("workspace".into(), retry.clone(), CancellationToken::new())
            .await
            .unwrap(),
        Err(dohc_engine_collab::OwnerOutboxError::ParentMismatch)
    ));
    f.store
        .write_with(&NoFaults, |tx| {
            tx.execute("DELETE FROM owner_live_stops", [])
                .map_err(StorageError::persist_public)
        })
        .unwrap();
    assert!(matches!(
        actor
            .owner_ydoc_outbox_append("workspace".into(), retry, CancellationToken::new())
            .await
            .unwrap(),
        Err(dohc_engine_collab::OwnerOutboxError::ParentMismatch)
    ));
    assert_eq!(f.store.table_row_count("owner_ydoc_outboxes").unwrap(), 0);
    supervisor.close_all().unwrap();
}

#[tokio::test]
async fn fix1_abandoned_draft_remains_listed_open_and_writable_offline() {
    let (mut f, supervisor, actor) = pending_release_fixture(1).await;
    let h = begin(&f, &actor).await;
    seal(&mut f, &h);
    lifecycle(
        &actor,
        Action::Abandon {
            hold: h.clone(),
            resolved_digest: h.digest().into(),
        },
    )
    .await
    .unwrap();
    let drafts = actor
        .owner_ydoc_list_drafts(
            "workspace".into(),
            None,
            64,
            true,
            CancellationToken::new(),
            Arc::new(()),
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(drafts.len(), 1);
    actor
        .owner_ydoc_open_draft(f.binding.clone(), 1, CancellationToken::new(), Arc::new(()))
        .await
        .unwrap()
        .unwrap();
    actor
        .owner_ydoc_append_draft(
            "workspace".into(),
            dohc_engine_collab::owner_outbox::draft::OwnerDraftAppendInput {
                person_edit: true,
                binding: f.binding.clone(),
                expected_revision: 1,
                append_key: "offline".into(),
                update: f.doc.richdoc_append_paragraph("offline edit"),
                now_ms: 70,
                agent_declaration: None,
                automation_declaration: None,
            },
            CancellationToken::new(),
            Arc::new(()),
        )
        .await
        .unwrap()
        .unwrap();
    assert!(matches!(
        f.store
            .read_with(|c| prefix::commit_blocker_in(c, &f.binding, h.digest())),
        Err(dohc_engine_collab::OwnerOutboxError::Stopping)
    ));
    supervisor.close_all().unwrap();
}

#[tokio::test]
async fn fix1_abandon_requires_the_resolved_digest_without_mutating_the_draft() {
    let (mut f, supervisor, actor) = pending_release_fixture(1).await;
    let h = begin(&f, &actor).await;
    seal(&mut f, &h);
    assert!(matches!(
        lifecycle(
            &actor,
            Action::Abandon {
                hold: h.clone(),
                resolved_digest: "b".repeat(64),
            }
        )
        .await,
        Err(dohc_engine_runtime::RuntimeError::Sync(
            sync::SyncError::CoordinateDiverged
        ))
    ));
    assert!(
        f.store
            .read_with(|c| prefix::commit_blocker_in(c, &f.binding, h.digest()))
            .is_ok()
    );
    assert_eq!(
        f.store
            .table_row_count("owner_ydoc_outbox_entries")
            .unwrap(),
        1
    );
    assert!(
        !f.store
            .read_with(
                |c| c.query_row("SELECT abandoned FROM release_holds", [], |r| r
                    .get::<_, bool>(0))
            )
            .unwrap()
    );
    lifecycle(
        &actor,
        Action::Abandon {
            hold: h.clone(),
            resolved_digest: h.digest().into(),
        },
    )
    .await
    .unwrap();
    assert!(matches!(
        f.store
            .read_with(|c| prefix::commit_blocker_in(c, &f.binding, h.digest())),
        Err(dohc_engine_collab::OwnerOutboxError::Stopping)
    ));
    supervisor.close_all().unwrap();
}

#[tokio::test]
async fn fix1_closed_session_refuses_existing_entry_retry_before_and_after_cleanup() {
    let (mut f, supervisor, actor) = pending_release_fixture(2).await;
    let h = begin(&f, &actor).await;
    let (outbox, sha): (String, String) = f.store.read_with(|c| c.query_row(
        "SELECT outbox_id,update_digest FROM owner_ydoc_outbox_entries WHERE append_key='pending-1'",
        [], |r| Ok((r.get(0)?,r.get(1)?)))).unwrap();
    let retry = dohc_engine_collab::OwnerOutboxAppendInput {
        binding: f.binding.clone(),
        base_update: f.bytes.clone(),
        append_key: "pending-1".into(),
        update: f.store.get_binary_blob(&sha).unwrap().unwrap(),
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
    // Retain an acknowledged delivery beside the folded key, as session cleanup permits.
    f.store.write_with(&NoFaults, |tx| {
        tx.execute("INSERT INTO owner_ydoc_outbox_entries(outbox_id,sequence,append_key,delivery_id,update_digest,update_blob_digest,byte_length,created_at_ms,pending,result_pending_bytes,result_oldest_entry_at_ms,result_state) SELECT outbox_id,sequence,append_key,delivery_id,update_digest,NULL,2,10,0,result_pending_bytes,result_oldest_entry_at_ms,result_state FROM owner_prefix_consumed WHERE append_key='pending-1'",[]).map_err(StorageError::persist_public)
    }).unwrap();
    lifecycle(
        &actor,
        Action::CloseSession {
            hold: h.clone(),
            outbox: outbox.clone(),
        },
    )
    .await
    .unwrap();
    for cleaned in [false, true] {
        if cleaned {
            lifecycle(
                &actor,
                Action::CleanupSession {
                    hold: h.clone(),
                    outbox: outbox.clone(),
                },
            )
            .await
            .unwrap();
        }
        assert!(matches!(
            actor
                .owner_ydoc_outbox_append(
                    "workspace".into(),
                    retry.clone(),
                    CancellationToken::new()
                )
                .await
                .unwrap(),
            Err(dohc_engine_collab::OwnerOutboxError::ParentMismatch)
        ));
    }
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
        lifecycle(
            &actor,
            Action::Abandon {
                hold: h.clone(),
                resolved_digest: h.digest().into(),
            },
        )
        .await
        .unwrap();
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
    lifecycle(
        &actor,
        Action::Abandon {
            hold: h.clone(),
            resolved_digest: h.digest().into(),
        },
    )
    .await
    .unwrap();
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
    let before = dohc_engine_collab::load_persisted(&f.store, &key())
        .unwrap()
        .unwrap()
        .doc
        .encode_full_state();
    assert!(
        lifecycle(
            &actor,
            Action::Successor {
                hold: h.clone(),
                input: Box::new(input),
                digest: "b".repeat(64)
            }
        )
        .await
        .is_err()
    );
    assert_eq!(f.store.table_row_count("ydoc_owner_bindings").unwrap(), 0);
    assert_eq!(
        dohc_engine_collab::load_persisted(&f.store, &key())
            .unwrap()
            .unwrap()
            .doc
            .encode_full_state(),
        before
    );
    assert_eq!(
        actor
            .owner_release_deferred_wakes("workspace".into(), None)
            .await
            .unwrap(),
        vec![key()]
    );
    supervisor.close_all().unwrap();
}

fn successor_input(f: &Fixture) -> enrollment::OwnerEnrollmentInput {
    let local = dohc_engine_collab::load_persisted(&f.store, &key())
        .unwrap()
        .unwrap();
    let host = Ydoc::wire();
    host.apply(&f.bytes).unwrap();
    enrollment::OwnerEnrollmentInput {
        binding: f.binding.clone(),
        relay_database_namespace: "relay".into(),
        captured: enrollment::OwnerEnrollmentCapture {
            native_head_sequence: local.marker.head_update_seq,
            local_state_digest: hex_sha256(&local.doc.encode_full_state()),
        },
        journal_cursor: 0,
        checkpoint: f.bytes.clone(),
        host_vector: host.encode_state_vector(),
        recovery: true,
    }
}

#[tokio::test]
async fn fix1_successor_closes_folded_session_and_cleanup_survives_deleted_stop() {
    let (mut f, supervisor, actor) = pending_release_fixture(1).await;
    let (sibling, _) = add_sibling(&mut f);
    let h = begin(&f, &actor).await;
    seal(&mut f, &h);
    fold(&mut f, &h);
    fold(&mut f, &h);
    assert_eq!(f.store.table_row_count("owner_prefix_consumed").unwrap(), 2);
    let (outbox, sha): (String, String) = f
        .store
        .read_with(|c| {
            c.query_row(
                "SELECT outbox_id,update_digest FROM owner_prefix_consumed",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
        })
        .unwrap();
    let retry = dohc_engine_collab::OwnerOutboxAppendInput {
        binding: f.binding.clone(),
        base_update: f.bytes.clone(),
        append_key: "pending-0".into(),
        update: f.store.get_binary_blob(&sha).unwrap().unwrap(),
        limits: dohc_engine_collab::OwnerOutboxLimits {
            max_pending_bytes: 1_000_000,
            max_pending_age_ms: 100_000,
        },
        created_at_ms: 10,
    };
    lifecycle(
        &actor,
        Action::Abandon {
            hold: h.clone(),
            resolved_digest: h.digest().into(),
        },
    )
    .await
    .unwrap();
    let input = successor_input(&f);
    let next = lifecycle(
        &actor,
        Action::Successor {
            hold: h,
            input: Box::new(input),
            digest: "b".repeat(64),
        },
    )
    .await
    .unwrap();
    assert!(matches!(
        actor
            .owner_ydoc_outbox_append("workspace".into(), retry.clone(), CancellationToken::new())
            .await
            .unwrap(),
        Err(dohc_engine_collab::OwnerOutboxError::Frozen)
    ));
    lifecycle(
        &actor,
        Action::CleanupSession {
            hold: next.clone(),
            outbox,
        },
    )
    .await
    .unwrap();
    assert_eq!(f.store.table_row_count("owner_prefix_consumed").unwrap(), 1);
    lifecycle(
        &actor,
        Action::CleanupSession {
            hold: next.clone(),
            outbox: sibling,
        },
    )
    .await
    .unwrap();
    assert_eq!(f.store.table_row_count("owner_prefix_consumed").unwrap(), 0);
    assert!(matches!(
        actor
            .owner_ydoc_outbox_append("workspace".into(), retry.clone(), CancellationToken::new())
            .await
            .unwrap(),
        Err(dohc_engine_collab::OwnerOutboxError::Frozen)
    ));
    f.store
        .write_with(&NoFaults, |tx| {
            sync::prepare_release_hold_replay_in(tx, &next, true)?;
            assert!(sync::close_release_hold_in(tx, &next)?);
            Ok::<_, sync::SyncError>(())
        })
        .unwrap();
    stop_action(&actor, &f, "request").await.unwrap();
    stop_action(&actor, &f, "release").await.unwrap();
    assert!(matches!(
        actor
            .owner_ydoc_outbox_append("workspace".into(), retry, CancellationToken::new())
            .await
            .unwrap(),
        Err(dohc_engine_collab::OwnerOutboxError::ParentMismatch)
    ));
    supervisor.close_all().unwrap();
}

#[tokio::test]
async fn fix1_successor_roots_two_outbox_tails_across_later_short_stop() {
    let (mut f, supervisor, actor) = pending_release_fixture(1).await;
    let (_, sibling_bytes) = add_sibling(&mut f);
    let sha: String = f
        .store
        .read_with(|c| {
            c.query_row(
                "SELECT update_digest FROM owner_ydoc_outbox_entries LIMIT 1",
                [],
                |r| r.get(0),
            )
        })
        .unwrap();
    let h = begin(&f, &actor).await;
    lifecycle(
        &actor,
        Action::Abandon {
            hold: h.clone(),
            resolved_digest: h.digest().into(),
        },
    )
    .await
    .unwrap();
    let input = successor_input(&f);
    let next = lifecycle(
        &actor,
        Action::Successor {
            hold: h,
            input: Box::new(input),
            digest: "b".repeat(64),
        },
    )
    .await
    .unwrap();
    assert_eq!(
        f.store
            .read_with(|c| c.query_row(
                "SELECT sum(pending) FROM owner_ydoc_outbox_entries",
                [],
                |r| r.get::<_, i64>(0)
            ))
            .unwrap(),
        0
    );
    f.store
        .write_with(&NoFaults, |tx| {
            sync::seal_release_hold_cut_in(tx, &next, 0)?;
            sync::prepare_release_hold_replay_in(tx, &next, true)?;
            assert!(sync::close_release_hold_in(tx, &next)?);
            Ok::<_, sync::SyncError>(())
        })
        .unwrap();
    stop_action(&actor, &f, "request").await.unwrap();
    stop_action(&actor, &f, "release").await.unwrap();
    assert!(f.store.get_binary_blob(&sha).unwrap().is_some());
    assert_eq!(
        f.store
            .table_row_count("owner_release_recovery_entries")
            .unwrap(),
        2
    );
    let text = dohc_engine_collab::load_persisted(&f.store, &key())
        .unwrap()
        .unwrap()
        .doc
        .project(ContentKind::Richdoc)
        .unwrap()
        .content;
    assert!(!text.contains("Pending edit"));
    assert!(!text.contains("Sibling private tail"));
    let rows:Vec<(String,String)>=f.store.read_with(|c|c.prepare("SELECT blob_sha256,entry_json FROM owner_release_recovery_entries ORDER BY outbox_id,sequence")?.query_map([],|r|Ok((r.get(0)?,r.get(1)?)))?.collect::<Result<_,_>>()).unwrap();
    assert_eq!(rows.len(), 2);
    assert!(
        rows.iter()
            .any(|(sha, json)| sha == &hex_sha256(&sibling_bytes)
                && json.contains("agent-sibling")
                && json.contains("old.md"))
    );
    let root: String = f
        .store
        .read_with(|c| {
            c.query_row(
                "SELECT native_blob_sha256 FROM owner_release_recoveries",
                [],
                |r| r.get(0),
            )
        })
        .unwrap();
    let recovery = Ydoc::wire();
    recovery
        .apply(&f.store.get_binary_blob(&root).unwrap().unwrap())
        .unwrap();
    for (sha, _) in rows {
        recovery
            .apply(&f.store.get_binary_blob(&sha).unwrap().unwrap())
            .unwrap();
    }
    let private = recovery.project(ContentKind::Richdoc).unwrap().content;
    assert!(private.contains("Pending edit"));
    assert!(private.contains("Sibling private tail"));
    supervisor.close_all().unwrap();
}

#[tokio::test]
async fn fix1_adopted_settlement_keeps_history_only_replay_after_successor() {
    let (mut f, supervisor, actor) = pending_release_fixture(1).await;
    actor
        .versioned_text_write(
            dohc_engine_domain::WriteText {
                workspace_id: "workspace".into(),
                version_id: "main".into(),
                object_id: "schema".into(),
                path: "notes/.collection.json".into(),
                text: r#"{"fields":{"status":{"type":"text"}}}"#.into(),
                moment_id: "schema-moment".into(),
                metadata_origin: "api".into(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 4,
                request_id: None,
            },
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .unwrap();
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
    lifecycle(&actor, Action::Adopt(h.clone())).await.unwrap();
    fold(&mut f, &h);
    lifecycle(
        &actor,
        Action::Abandon {
            hold: h.clone(),
            resolved_digest: h.digest().into(),
        },
    )
    .await
    .unwrap();
    let mut input = successor_input(&f);
    let host = Ydoc::wire();
    host.apply(&f.bytes).unwrap();
    host.frontmatter_set("status", "successor").unwrap();
    host.richdoc_append_paragraph("Changed authenticated host cut");
    input.checkpoint = host.encode_full_state();
    input.host_vector = host.encode_state_vector();
    input.journal_cursor = 2;
    let next = lifecycle(
        &actor,
        Action::Successor {
            hold: h,
            input: Box::new(input),
            digest: "b".repeat(64),
        },
    )
    .await
    .unwrap();
    let before = dohc_engine_collab::load_persisted(&f.store, &key())
        .unwrap()
        .unwrap()
        .doc
        .encode_full_state();
    f.store.write_with(&NoFaults,|tx| {
        tx.execute("INSERT INTO collections VALUES ('workspace','main','notes','notes/.collection.json','valid','[]') ON CONFLICT DO NOTHING",[]).unwrap();
        tx.execute("INSERT INTO collection_records (workspace_id,version_id,record_id,collection_path,file_path,object_id,adoption_state,index_initialized) VALUES ('workspace','main','rec_00000000000000000000000000','notes','notes/owner.md','object','adopted',1) ON CONFLICT DO NOTHING",[]).unwrap();
        tx.execute("INSERT INTO collection_record_fields VALUES ('workspace','main','rec_00000000000000000000000000','status','\"successor\"','valid',NULL) ON CONFLICT DO NOTHING",[]).unwrap();
        Ok::<_,StorageError>(())
    }).unwrap();
    let indexed = f
        .store
        .read_with(|c| {
            dohc_engine_domain::collections::indexed_collection_record_frontmatter_in_tx(
                c,
                "workspace",
                "main",
                "object",
            )
        })
        .unwrap();
    assert_eq!(indexed, Some(serde_json::json!({"status":"successor"})));
    assert_eq!(
        f.store.table_row_count("owner_release_recoveries").unwrap(),
        1
    );
    assert_eq!(f.store.table_row_count("owner_prefix_consumed").unwrap(), 1);
    let field_history = f.store.table_row_count("collection_field_history").unwrap();
    let moment = op.payload["momentId"].as_str().unwrap().to_owned();
    let replay = actor
        .owner_release_replay(
            next,
            op,
            Arc::new(NoLiveLeases),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert!(
        matches!(replay.0.primary,sync::ApplyDisposition::Applied(ref result) if result.record_facts.is_empty()),
        "{replay:?}"
    );
    assert_eq!(
        f.store
            .read_with(|c| c.query_row(
                "SELECT count(*) FROM moments WHERE moment_id=?1",
                [moment],
                |r| r.get::<_, i64>(0)
            ))
            .unwrap(),
        1
    );
    assert_eq!(
        dohc_engine_collab::load_persisted(&f.store, &key())
            .unwrap()
            .unwrap()
            .doc
            .encode_full_state(),
        before
    );
    assert_eq!(
        f.store
            .read_with(|c| {
                dohc_engine_domain::collections::indexed_collection_record_frontmatter_in_tx(
                    c,
                    "workspace",
                    "main",
                    "object",
                )
            })
            .unwrap(),
        indexed
    );
    assert_eq!(
        f.store.table_row_count("collection_field_history").unwrap(),
        field_history
    );
    supervisor.close_all().unwrap();
}

#[tokio::test]
async fn part1b_restore_retiring() {
    real_restore("retiring", None, false).await;
}
#[tokio::test]
async fn part1b_released_takeover_refuses_without_recreating_binding() {
    let (mut f, supervisor, actor) = pending_release_fixture(1).await;
    let hold = begin(&f, &actor).await;
    seal(&mut f, &hold);
    fold(&mut f, &hold);
    save(&f, &actor, &hold).await;
    lifecycle(&actor, Action::Unbind(hold.clone()))
        .await
        .unwrap();
    let before = dohc_engine_collab::load_persisted(&f.store, &key())
        .unwrap()
        .unwrap()
        .doc
        .encode_full_state();
    lifecycle(
        &actor,
        Action::Abandon {
            hold: hold.clone(),
            resolved_digest: hold.digest().into(),
        },
    )
    .await
    .unwrap();
    assert!(
        lifecycle(
            &actor,
            Action::Successor {
                hold: hold.clone(),
                input: Box::new(successor_input(&f)),
                digest: "b".repeat(64)
            }
        )
        .await
        .is_err()
    );
    assert_eq!(f.store.table_row_count("ydoc_owner_bindings").unwrap(), 0);
    assert_eq!(
        f.store.table_row_count("owner_release_recoveries").unwrap(),
        0
    );
    assert_eq!(
        sync::read_release_hold(&f.store, &key()).unwrap().unwrap(),
        hold
    );
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
async fn part1b_restore_draining() {
    real_restore("draining", None, false).await;
}
#[tokio::test]
async fn part1b_restore_released() {
    real_restore("released", None, false).await;
}
#[tokio::test]
async fn part1b_restore_released_lost_ack() {
    real_restore(
        "released",
        Some(dohc_engine_storage::FaultPoint::StorageAfterCommitBeforeAck),
        false,
    )
    .await;
}
#[tokio::test]
async fn part1b_restore_released_rollback() {
    real_restore(
        "released",
        Some(dohc_engine_storage::FaultPoint::StorageBeforePersist),
        false,
    )
    .await;
}
#[tokio::test]
async fn part1b_restored_takeover_rollback() {
    real_restore(
        "draining",
        Some(dohc_engine_storage::FaultPoint::StorageBeforePersist),
        false,
    )
    .await;
}
#[tokio::test]
async fn part1b_restored_takeover_lost_ack() {
    real_restore(
        "draining",
        Some(dohc_engine_storage::FaultPoint::StorageAfterCommitBeforeAck),
        false,
    )
    .await;
}
#[tokio::test]
async fn part1b_restore_two_outboxes() {
    real_restore("draining", None, true).await;
}
async fn real_restore(stage: &str, fault: Option<dohc_engine_storage::FaultPoint>, sibling: bool) {
    {
        let (mut f, supervisor, mut actor) = restore_fixture().await;
        if sibling {
            let (_, bytes) = add_sibling(&mut f);
            f.doc.apply(&bytes).unwrap();
        }
        let h = begin(&f, &actor).await;
        let peer = Ydoc::wire();
        peer.apply(&f.bytes).unwrap();
        let op = update(
            &mut f,
            &peer.richdoc_append_paragraph("held across restore"),
            "peer",
            0,
        );
        retain(&mut f, &h, &op);
        let second = update(
            &mut f,
            &peer.richdoc_append_paragraph("second held arrival"),
            "peer",
            1,
        );
        retain(&mut f, &h, &second);
        if stage != "retiring" {
            seal(&mut f, &h);
            fold(&mut f, &h);
            if stage == "released" {
                while f
                    .store
                    .read_with(|c| prefix::pending_entries_in(c, &f.binding))
                    .unwrap()
                    > 0
                {
                    fold(&mut f, &h);
                }
            }
            save(&f, &actor, &h).await;
        }
        let mut acknowledged = None;
        if stage == "released" {
            lifecycle(&actor, Action::Unbind(h.clone())).await.unwrap();
            f.store
                .write_with(&NoFaults, |tx| {
                    sync::prepare_release_hold_replay_in(tx, &h, true)
                })
                .unwrap();
            let deferred = update(
                &mut f,
                &peer.richdoc_append_paragraph("acknowledged before restore"),
                "deferred-peer",
                0,
            );
            retain(&mut f, &h, &deferred);
            actor
                .owner_release_replay(
                    h.clone(),
                    deferred.clone(),
                    Arc::new(sync::AlwaysLive),
                    Arc::new(NoFaults),
                    CancellationToken::new(),
                )
                .await
                .unwrap();
            f.store
                .write_with(&NoFaults, |tx| {
                    sync::acknowledge_release_replay_in(tx, &deferred)
                })
                .unwrap();
            acknowledged = Some(deferred);
        }
        let owner = actor
            .live_application_owner("workspace".into())
            .await
            .unwrap();
        let coordinate = ApplicationHostCoordinate {
            host_id: "host".into(),
            host_epoch: 1,
            instance_id: "instance".into(),
            connection_id: "connection".into(),
        };
        let _handle = owner
            .register("relay".into(), coordinate.clone(), f.binding.clone())
            .await
            .unwrap();
        let baseline = Ydoc::wire();
        baseline.apply(&f.bytes).unwrap();
        let projected = baseline.project(ContentKind::Richdoc).unwrap().content;
        let source = baseline
            .preserved_markdown_source(&projected)
            .unwrap_or_else(|| projected.clone());
        let fence = owner
            .fence_restore(
                NativeRestoreFence {
                    operation_id: "restore".into(),
                    relay_database_namespace: "relay".into(),
                    old_binding: f.binding.clone(),
                    host_id: "host".into(),
                    new_fence: 1,
                    origin: RestoreDeliveryOrigin::Bootstrap {
                        id: "restore-baseline".into(),
                    },
                    terminal: None,
                    applied_sequence: 0,
                },
                coordinate.clone(),
                60,
                Arc::new(NoFaults),
            )
            .await
            .unwrap();
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
        let preparation = NativeRestorePreparation {
            fence,
            point: NativeRestorePoint {
                journal_cursor: 0,
                receipt_digest: f.binding.lineage_claim_id.clone(),
                markdown_digest: hex_sha256(source.as_bytes()),
                projection_digest: hex_sha256(projected.as_bytes()),
            },
        };
        let frozen_before = dohc_engine_collab::load_persisted(&f.store, &key())
            .unwrap()
            .unwrap()
            .doc
            .encode_full_state();
        let proposal = owner
            .prepare_restore(
                preparation.clone(),
                coordinate.clone(),
                2_000_000,
                100,
                Arc::new(NoFaults),
                Arc::new(()),
            )
            .await
            .unwrap();
        assert_eq!(proposal.frozen_state_bytes(), frozen_before);
        assert_eq!(
            proposal.receipt().folded_sources.len(),
            if stage == "retiring" {
                0
            } else if stage == "released" {
                34
            } else {
                32
            }
        );
        assert_eq!(
            proposal.receipt().native_sources.len(),
            usize::from(sibling)
                + if stage == "retiring" {
                    34
                } else if stage == "released" {
                    0
                } else {
                    2
                }
        );
        for source in &proposal.receipt().folded_sources {
            let i: usize = source
                .append_key
                .strip_prefix("private-")
                .unwrap()
                .parse()
                .unwrap();
            let actor = if i % 2 == 0 {
                "local-person"
            } else {
                "agent-A"
            };
            assert_eq!(source.publication["actorOriginId"], actor);
            let attribution = if i % 2 == 0 {
                ChangeAttribution {
                    actor_kind: ChangeActorKind::Human,
                    on_behalf_of: None,
                    depth: 0,
                    run: None,
                }
            } else {
                AgentDeclaration {
                    agent_id: "agent-A".into(),
                    on_behalf_of: Some("person-A".into()),
                    depth: 1,
                }
                .attribution()
            };
            assert_eq!(
                source.publication["attribution"],
                serde_json::to_value(attribution).unwrap()
            );
            let journal: String = f.store.read_with(|c|c.query_row("SELECT payload_json FROM replication_log WHERE workspace_id='workspace' AND origin_id=?1 AND origin_seq=?2",params![source.origin_id,source.origin_sequence],|r|r.get(0))).unwrap();
            assert_eq!(
                source.publication,
                serde_json::from_str::<serde_json::Value>(&journal).unwrap()
            );
            if i == 1 || i == 2 || i == 33 {
                use yrs::updates::decoder::Decode;
                let bytes = f
                    .store
                    .get_binary_blob(source.publication["updateBlobSha256"].as_str().unwrap())
                    .unwrap()
                    .unwrap();
                assert!(
                    !yrs::Update::decode_v1(&bytes)
                        .unwrap()
                        .delete_set()
                        .is_empty()
                );
            }
        }
        for source in &proposal.receipt().native_sources {
            if let Some(i) = source.append_key.strip_prefix("private-") {
                let i: usize = i.parse().unwrap();
                assert_eq!(source.person_edit, (i % 2 == 0).then_some(true));
                assert_eq!(source.accepted_receipt, None);
            }
        }
        let manifest = serde_json::to_string(proposal.receipt()).unwrap();
        assert!(manifest.contains("agent-A"));
        assert!(matches!(
            owner
                .prepare_restore(
                    preparation.clone(),
                    coordinate.clone(),
                    1,
                    100,
                    Arc::new(NoFaults),
                    Arc::new(())
                )
                .await,
            Err(dohc_engine_runtime::RuntimeError::LiveApplication(
                ApplicationError::ConfiguredByteBudgetExceeded
            ))
        ));
        assert!(matches!(
            owner
                .prepare_restore(
                    preparation.clone(),
                    coordinate.clone(),
                    2_000_000,
                    33,
                    Arc::new(NoFaults),
                    Arc::new(())
                )
                .await,
            Err(dohc_engine_runtime::RuntimeError::LiveApplication(
                ApplicationError::InvalidInput(_)
            ))
        ));
        let replay = owner
            .prepare_restore(
                preparation.clone(),
                coordinate.clone(),
                2_000_000,
                100,
                Arc::new(NoFaults),
                Arc::new(()),
            )
            .await
            .unwrap();
        assert_eq!(replay.receipt(), proposal.receipt());
        assert_eq!(replay.native_source_bytes(), proposal.native_source_bytes());
        if stage != "retiring" {
            let extra = Ydoc::wire();
            extra.apply(&frozen_before).unwrap();
            extra.richdoc_append_paragraph("unclassified native bytes");
            let sha = f.store.put_binary_blob(&extra.encode_full_state()).unwrap();
            let old: String = f
                .store
                .read_with(|c| {
                    c.query_row(
                        "SELECT update_blob_sha256 FROM ydoc_updates ORDER BY seq DESC LIMIT 1",
                        [],
                        |r| r.get(0),
                    )
                })
                .unwrap();
            f.store.write_with(&NoFaults,|tx|tx.execute("UPDATE ydoc_updates SET update_blob_sha256=?1 WHERE seq=(SELECT max(seq) FROM ydoc_updates)",[sha]).map_err(StorageError::persist_public)).unwrap();
            assert!(matches!(
                owner
                    .prepare_restore(
                        preparation.clone(),
                        coordinate.clone(),
                        2_000_000,
                        100,
                        Arc::new(NoFaults),
                        Arc::new(())
                    )
                    .await,
                Err(dohc_engine_runtime::RuntimeError::LiveApplication(
                    ApplicationError::InvalidInput(
                        "restore preparation requires classified native pending context"
                    )
                ))
            ));
            f.store.write_with(&NoFaults,|tx|tx.execute("UPDATE ydoc_updates SET update_blob_sha256=?1 WHERE seq=(SELECT max(seq) FROM ydoc_updates)",[old]).map_err(StorageError::persist_public)).unwrap();
        }
        let next = dohc_engine_collab::LiveObjectBinding {
            restore_fence_generation: 1,
            ..f.binding.clone()
        };
        let input = NativeRestoreApplication {
            preparation,
            candidate_digest: proposal.receipt().candidate_digest.clone(),
            native_source_manifest_digest: proposal.receipt().native_source_manifest_digest.clone(),
            admitted: AdmittedLiveUpdateMetadata {
                accepted: RelayAcceptedLiveUpdate {
                    receipt: LiveUpdateReceipt {
                        delivery_id: "restored".into(),
                        update_digest: proposal.receipt().candidate_digest.clone(),
                        journal_cursor: 10,
                        accepting_host_epoch: 1,
                    },
                    binding: next.clone(),
                    authority: ServerDerivedLiveUpdateAuthority::Owner {
                        principal_id: "owner".into(),
                    },
                    received_at_ms: 61,
                },
                first_seen: proposal.receipt().replacement_ranges.clone(),
                canonical_version: Some(2),
                author_snapshot: Some(vec![]),
                first_seen_deletes: Some(vec![]),
                checkpoint_coverage: None,
            },
        };
        owner
            .apply_restore(
                input.clone(),
                coordinate.clone(),
                2_000_000,
                100,
                62,
                Arc::new(NoFaults),
                Arc::new(()),
            )
            .await
            .unwrap();
        let settled = owner
            .settle_restore(
                input.clone(),
                coordinate.clone(),
                2_000_000,
                100,
                f.root.path().to_owned(),
                63,
                Arc::new(NoFaults),
                CancellationToken::new(),
                Arc::new(()),
            )
            .await
            .unwrap();
        owner
            .resume_restore(
                NativeRestoreResume {
                    application: input,
                    settlement_id: settled.settlement_id,
                },
                coordinate,
                2_000_000,
                100,
                f.root.path().to_owned(),
                64,
                Arc::new(NoFaults),
                CancellationToken::new(),
                Arc::new(()),
            )
            .await
            .unwrap();
        owner.close().await.unwrap();
        lifecycle(
            &actor,
            Action::Abandon {
                hold: h.clone(),
                resolved_digest: h.digest().into(),
            },
        )
        .await
        .unwrap();
        let local = dohc_engine_collab::load_persisted(&f.store, &key())
            .unwrap()
            .unwrap();
        let bytes = local.doc.encode_full_state();
        let before = held_state(&f);
        let input = enrollment::OwnerEnrollmentInput {
            binding: next,
            relay_database_namespace: "relay".into(),
            captured: enrollment::OwnerEnrollmentCapture {
                native_head_sequence: local.marker.head_update_seq,
                local_state_digest: hex_sha256(&bytes),
            },
            journal_cursor: 10,
            checkpoint: bytes,
            host_vector: local.doc.encode_state_vector(),
            recovery: true,
        };
        let command = || Action::Successor {
            hold: h.clone(),
            digest: "d".repeat(64),
            input: Box::new(input.clone()),
        };
        if stage == "released" {
            for mismatch in [
                "namespace",
                "path",
                "old-generation",
                "unresumed-generation",
            ] {
                let mut invalid = input.clone();
                match mismatch {
                    "namespace" => invalid.relay_database_namespace = "other-relay".into(),
                    "path" => invalid.binding.current_path = "other.md".into(),
                    "old-generation" => invalid.binding.restore_fence_generation = 0,
                    _ => invalid.binding.restore_fence_generation = 2,
                }
                assert!(
                    lifecycle(
                        &actor,
                        Action::Successor {
                            hold: h.clone(),
                            input: Box::new(invalid),
                            digest: "d".repeat(64),
                        }
                    )
                    .await
                    .is_err(),
                    "{mismatch}"
                );
                assert_eq!(held_state(&f), before);
                assert_eq!(f.store.table_row_count("ydoc_owner_bindings").unwrap(), 0);
                assert_eq!(
                    sync::read_release_hold(&f.store, &key()).unwrap().unwrap(),
                    h
                );
            }
        }
        let faults: Arc<dyn dohc_engine_storage::FaultInjector> = match fault {
            None => Arc::new(NoFaults),
            Some(point) => dohc_engine_testkit::ScriptedFaults::crash_at(point),
        };
        let mut next_hold = actor
            .owner_release_lifecycle(command(), 40, faults, CancellationToken::new())
            .await;
        if let Some(point) = fault {
            assert!(matches!(
                next_hold,
                Err(dohc_engine_runtime::RuntimeError::Sync(
                    sync::SyncError::FaultCrash
                ))
            ));
            supervisor.close_all().unwrap();
            actor = supervisor.open(&f.db, 50).unwrap().actor;
            let committed = point == dohc_engine_storage::FaultPoint::StorageAfterCommitBeforeAck;
            let current = sync::read_release_hold(&f.store, &key()).unwrap().unwrap();
            assert_eq!(
                current.digest(),
                if committed {
                    "d".repeat(64)
                } else {
                    h.digest().into()
                }
            );
            assert_eq!(held_state(&f), before);
            assert_eq!(
                f.store.table_row_count("owner_release_recoveries").unwrap(),
                if committed && stage != "released" {
                    1
                } else {
                    0
                }
            );
            next_hold = if committed {
                Ok(current)
            } else {
                lifecycle(&actor, command()).await
            };
        }
        if stage == "released" {
            let next_hold = next_hold.unwrap();
            assert_eq!(next_hold.binding().restore_fence_generation, 1);
            let namespace: String = f
                .store
                .read_with(|c| {
                    c.query_row("SELECT relay_namespace FROM release_holds", [], |r| {
                        r.get(0)
                    })
                })
                .unwrap();
            assert_eq!(namespace, "relay");
            assert_eq!(held_state(&f), before);
            assert_eq!(f.store.table_row_count("ydoc_owner_bindings").unwrap(), 0);
            assert_eq!(
                dohc_engine_collab::load_persisted(&f.store, &key())
                    .unwrap()
                    .unwrap()
                    .doc
                    .encode_full_state(),
                input.checkpoint
            );
            let deferred: (String, i64) = f
                .store
                .read_with(|c| {
                    c.query_row(
                        "SELECT release_digest,release_generation FROM ydoc_deferred_updates",
                        [],
                        |r| Ok((r.get(0)?, r.get(1)?)),
                    )
                })
                .unwrap();
            assert_eq!(deferred, (next_hold.digest().into(), 1));
            assert_eq!(
                sync::read_release_hold_page(&f.store, &next_hold).unwrap(),
                vec![op.clone(), second.clone()]
            );
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
            assert!(lifecycle(&actor, command()).await.is_err());
            f.store
                .write_with(&NoFaults, |tx| {
                    sync::prepare_release_hold_replay_in(tx, &next_hold, true)
                })
                .unwrap();
            for arrival in [&op, &second] {
                let (outcome, _) = actor
                    .owner_release_replay(
                        next_hold.clone(),
                        arrival.clone(),
                        Arc::new(NoLiveLeases),
                        Arc::new(NoFaults),
                        CancellationToken::new(),
                    )
                    .await
                    .unwrap();
                assert!(matches!(
                    outcome.primary,
                    sync::ApplyDisposition::Applied(_)
                ));
                f.store
                    .write_with(&NoFaults, |tx| {
                        sync::acknowledge_release_replay_in(tx, arrival)
                    })
                    .unwrap();
            }
            assert!(acknowledged.is_some());
            assert_eq!(f.store.table_row_count("ydoc_deferred_updates").unwrap(), 0);
            let restored = dohc_engine_collab::load_persisted(&f.store, &key())
                .unwrap()
                .unwrap();
            let content = restored.doc.project(ContentKind::Richdoc).unwrap().content;
            assert!(content.contains("held across restore"));
            assert!(content.contains("second held arrival"));
            assert!(content.contains("acknowledged before restore"));
            f.store
                .write_with(&NoFaults, |tx| {
                    assert!(sync::close_release_hold_in(tx, &next_hold)?);
                    Ok::<_, sync::SyncError>(())
                })
                .unwrap();
            let charges: (i64, i64) = f
                .store
                .read_with(|c| {
                    c.query_row(
                        "SELECT operation_count,retained_bytes FROM release_hold_usage",
                        [],
                        |r| Ok((r.get(0)?, r.get(1)?)),
                    )
                })
                .unwrap();
            assert_eq!(charges, (0, 0));
            assert_eq!(f.store.table_row_count("ydoc_owner_bindings").unwrap(), 0);
            assert!(
                actor
                    .owner_release_replay(
                        h,
                        op,
                        Arc::new(NoLiveLeases),
                        Arc::new(NoFaults),
                        CancellationToken::new()
                    )
                    .await
                    .is_err()
            );
            supervisor.close_all().unwrap();
            return;
        }
        let next_hold = next_hold.unwrap();
        assert_eq!(next_hold.binding().restore_fence_generation, 1);
        assert_eq!(held_state(&f), before);
        let (root,tails):(String,Vec<String>)=f.store.read_with(|c| {
            let root=c.query_row("SELECT native_blob_sha256 FROM owner_release_recoveries",[],|r|r.get(0))?;
            let tails=c.prepare("SELECT blob_sha256 FROM owner_release_recovery_entries ORDER BY outbox_id,sequence")?.query_map([],|r|r.get(0))?.collect::<Result<Vec<_>,_>>()?;
            Ok::<_,rusqlite::Error>((root,tails))
        }).unwrap();
        let recovered = Ydoc::wire();
        recovered
            .apply(&f.store.get_binary_blob(&root).unwrap().unwrap())
            .unwrap();
        assert_eq!(recovered.encode_full_state(), frozen_before);
        for sha in tails {
            recovered
                .apply(&f.store.get_binary_blob(&sha).unwrap().unwrap())
                .unwrap();
        }
        assert_eq!(recovered.encode_full_state(), f.doc.encode_full_state());
        assert!(
            actor
                .owner_release_replay(
                    h,
                    op,
                    Arc::new(NoLiveLeases),
                    Arc::new(NoFaults),
                    CancellationToken::new()
                )
                .await
                .is_err()
        );
        supervisor.close_all().unwrap();
    }
}

// Bootstrap provenance comes from the real runtime. As in the existing restore
// controls, model the non-host device by removing only an unavailable host registration.
async fn bootstrapped_nonhost_fixture_sized(size: usize) -> Fixture {
    let seed = Fixture::with_size(size);
    let root = ScratchDir::new().unwrap();
    let db = engine_db_path(&root).unwrap();
    let mut store = EngineStore::open(&db, 0).unwrap();
    dohc_engine_domain::VersionedTextStore::new(&mut store)
        .ensure_main_version("workspace", "main", 0, &NoFaults)
        .unwrap();
    store
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT INTO sync_identity (workspace_id,origin_id,replication_epoch,stream_identity,created_at_ms) VALUES ('workspace','origin','epoch','stream',1)",
                [],
            )
            .unwrap();
            tx.execute(
                "INSERT INTO sync_relay_push_state (workspace_id,origin_id,pushed_seq) VALUES ('workspace','origin',0)",
                [],
            )
            .unwrap();
            Ok::<_, StorageError>(())
        })
        .unwrap();
    let f = Fixture {
        root,
        db,
        store,
        binding: seed.binding.clone(),
        doc: seed.doc,
        bytes: seed.bytes,
        text: seed.text,
    };
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&f.db, 1).unwrap().actor;
    let owner = actor
        .live_application_owner("workspace".into())
        .await
        .unwrap();
    let handle = owner
        .register(
            "relay".into(),
            ApplicationHostCoordinate {
                host_id: "host".into(),
                host_epoch: 1,
                instance_id: "instance".into(),
                connection_id: "connection".into(),
            },
            f.binding.clone(),
        )
        .await
        .unwrap();
    let projected = f.doc.project(ContentKind::Richdoc).unwrap().content;
    let source = f
        .doc
        .preserved_markdown_source(&projected)
        .unwrap_or(projected);
    handle
        .bootstrap(
            LiveApplicationBootstrap {
                bootstrap_id: "restore-baseline".into(),
                bootstrap_moment_id: "original".into(),
                baseline_moment_relay_sequence: 0,
                baseline_registered_at_ms: 1,
                baseline_digest: hex_sha256(&f.bytes),
                baseline_byte_length: f.bytes.len() as i64,
                projected_markdown_digest: hex_sha256(source.as_bytes()),
                projected_markdown_byte_length: source.len() as i64,
            },
            f.bytes.clone(),
            f.root.path().to_owned(),
            Arc::new(NoFaults),
            None,
        )
        .await
        .unwrap();
    owner.close().await.unwrap();
    supervisor.close_all().unwrap();
    std::fs::create_dir_all(f.root.path().join("notes")).unwrap();
    std::fs::write(f.root.path().join("notes/owner.md"), &source).unwrap();
    let mut f = f;
    let bytes = dohc_engine_collab::load_persisted(&f.store, &key())
        .unwrap()
        .unwrap()
        .doc
        .encode_full_state();
    f.store
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "DELETE FROM live_device_application_bindings WHERE available=0",
                [],
            )
            .unwrap();
            dohc_engine_collab::owner_base_source::retain_owner_base_source_in_tx(
                tx,
                &key(),
                &f.binding.current_path,
                &f.binding.lineage_claim_id,
                &dohc_engine_collab::owner_base_source::OwnerSeedSource {
                    moment_id: "original".into(),
                    blob_sha256: hex_sha256(source.as_bytes()),
                },
            )
            .unwrap();
            dohc_engine_collab::owner_outbox::draft::install_observed_binding_in_tx(
                tx,
                "workspace",
                &dohc_engine_collab::owner_outbox::draft::ObservedOwnerBinding {
                    binding: f.binding.clone(),
                    relay_database_namespace: "relay".into(),
                    revision: 1,
                    accepted_cursor: 0,
                    native_head_sequence: 0,
                    checkpoint_digest: hex_sha256(&bytes),
                    limits: dohc_engine_collab::OwnerOutboxLimits {
                        max_pending_bytes: 1_000_000,
                        max_pending_age_ms: 100_000,
                    },
                },
                &bytes,
            )
        })
        .unwrap();
    f
}

async fn restore_fixture() -> (Fixture, WorkspaceSupervisor, ActorHandle) {
    restore_fixture_sized(0).await
}
async fn restore_fixture_sized(size: usize) -> (Fixture, WorkspaceSupervisor, ActorHandle) {
    let f = bootstrapped_nonhost_fixture_sized(size).await;
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&f.db, 3).unwrap().actor;
    for i in 0..34 {
        let update = if i == 1 || i == 2 || i == 33 {
            let u = backspace_updates(&f.doc.encode_full_state(), 1).remove(0);
            f.doc.apply(&u).unwrap();
            u
        } else {
            f.doc.richdoc_append_paragraph(&format!("private-{i}"))
        };
        actor
            .owner_ydoc_append_draft(
                "workspace".into(),
                dohc_engine_collab::owner_outbox::draft::OwnerDraftAppendInput {
                    person_edit: i % 2 == 0,
                    binding: f.binding.clone(),
                    expected_revision: 1,
                    append_key: format!("private-{i}"),
                    update,
                    now_ms: 10,
                    agent_declaration: (i % 2 == 1).then(|| AgentDeclaration {
                        agent_id: "agent-A".into(),
                        on_behalf_of: Some("person-A".into()),
                        depth: 1,
                    }),
                    automation_declaration: None,
                },
                CancellationToken::new(),
                Arc::new(()),
            )
            .await
            .unwrap()
            .unwrap();
    }
    stop_action(&actor, &f, "request").await.unwrap();
    (f, supervisor, actor)
}

fn held_state(f: &Fixture) -> String {
    f.store.read_with(|c|c.query_row("SELECT json_object('ops',(SELECT json_group_array(json_array(origin_id,origin_seq,arrival,envelope_json,retained_bytes,stage)) FROM (SELECT * FROM release_held_ops ORDER BY arrival)),'count',(SELECT operation_count FROM release_hold_usage),'bytes',(SELECT retained_bytes FROM release_hold_usage),'roots',(SELECT json_group_array(json_array(origin_id,origin_seq,sha256,is_text,text_sha256,binary_sha256)) FROM (SELECT * FROM release_held_blobs ORDER BY origin_id,origin_seq,sha256,is_text)))",[],|r|r.get(0))).unwrap()
}

#[tokio::test]
#[ignore = "manual bounded 1 MiB restore preparation measurement"]
async fn measure_part1b_restore_preparation() {
    for folded in [false, true] {
        let (mut f, supervisor, actor) = restore_fixture_sized(1_048_576).await;
        let h = begin(&f, &actor).await;
        if folded {
            seal(&mut f, &h);
            fold(&mut f, &h);
        }
        let owner = actor
            .live_application_owner("workspace".into())
            .await
            .unwrap();
        let coordinate = ApplicationHostCoordinate {
            host_id: "host".into(),
            host_epoch: 1,
            instance_id: "instance".into(),
            connection_id: "connection".into(),
        };
        let _handle = owner
            .register("relay".into(), coordinate.clone(), f.binding.clone())
            .await
            .unwrap();
        let baseline = Ydoc::wire();
        baseline.apply(&f.bytes).unwrap();
        let projection = baseline.project(ContentKind::Richdoc).unwrap().content;
        let source = baseline
            .preserved_markdown_source(&projection)
            .unwrap_or_else(|| projection.clone());
        let fence = owner
            .fence_restore(
                NativeRestoreFence {
                    operation_id: "restore".into(),
                    relay_database_namespace: "relay".into(),
                    old_binding: f.binding.clone(),
                    host_id: "host".into(),
                    new_fence: 1,
                    origin: RestoreDeliveryOrigin::Bootstrap {
                        id: "restore-baseline".into(),
                    },
                    terminal: None,
                    applied_sequence: 0,
                },
                coordinate.clone(),
                60,
                Arc::new(NoFaults),
            )
            .await
            .unwrap();
        let preparation = NativeRestorePreparation {
            fence,
            point: NativeRestorePoint {
                journal_cursor: 0,
                receipt_digest: f.binding.lineage_claim_id.clone(),
                markdown_digest: hex_sha256(source.as_bytes()),
                projection_digest: hex_sha256(projection.as_bytes()),
            },
        };
        let started = std::time::Instant::now();
        let proposal = owner
            .prepare_restore(
                preparation,
                coordinate,
                100_000_000,
                100,
                Arc::new(NoFaults),
                Arc::new(()),
            )
            .await
            .unwrap();
        let elapsed = started.elapsed().as_secs_f64() * 1000.0;
        assert_eq!(
            proposal.receipt().folded_sources.len(),
            if folded { 32 } else { 0 }
        );
        assert_eq!(
            proposal.receipt().native_sources.len(),
            if folded { 2 } else { 34 }
        );
        println!(
            "PART1B_RESTORE_COST {}",
            serde_json::json!({"documentBytes":1_048_576,"folded":folded,"elapsedMs":elapsed,"eventLimit":100,"byteLimit":100_000_000,"foldedSources":proposal.receipt().folded_sources.len(),"pendingSources":proposal.receipt().native_sources.len(),"frozenBytes":proposal.frozen_state_bytes().len(),"candidateBytes":proposal.candidate_bytes().len(),"manifestBytes":serde_json::to_vec(proposal.receipt()).unwrap().len()})
        );
        owner.close().await.unwrap();
        supervisor.close_all().unwrap();
    }
}

fn add_sibling(f: &mut Fixture) -> (String, Vec<u8>) {
    let binding = dohc_engine_collab::LiveObjectBinding {
        current_path: "old.md".into(),
        selector_paths: vec!["old.md".into()],
        ..f.binding.clone()
    };
    let identity = format!(
        "{}\0{}\0{}",
        binding.workspace_id,
        serde_json::to_string(&binding).unwrap(),
        binding.lineage_claim_id
    );
    let outbox = format!("owner-outbox-{}", hex_sha256(identity.as_bytes()));
    let peer = Ydoc::wire();
    peer.apply(&f.bytes).unwrap();
    let bytes = peer.richdoc_append_paragraph("Sibling private tail");
    let sha = f.store.put_binary_blob(&bytes).unwrap();
    let delivery = format!(
        "owner-delivery-{}",
        hex_sha256(format!("{outbox}\0{}\0{sha}", 1).as_bytes())
    );
    let agent = serde_json::to_string(&AgentDeclaration {
        agent_id: "agent-sibling".into(),
        on_behalf_of: Some("person-sibling".into()),
        depth: 1,
    })
    .unwrap();
    f.store.write_with(&NoFaults,|tx| {
        tx.execute("INSERT INTO owner_ydoc_outboxes (outbox_id,workspace_id,main_version_id,object_id,lineage_claim_id,current_path,selector_paths_json,restore_fence_generation,base_update_digest,base_blob_digest,base_byte_length,state,pending_bytes,oldest_entry_at_ms,next_sequence,quarantine_reason,created_at_ms) SELECT ?1,workspace_id,main_version_id,object_id,lineage_claim_id,'old.md','[\"old.md\"]',restore_fence_generation,base_update_digest,base_blob_digest,base_byte_length,'quarantined',?2,10,2,'stale-binding',11 FROM owner_ydoc_outboxes LIMIT 1",params![outbox,bytes.len() as i64]).map_err(StorageError::persist_public)?;
        tx.execute("INSERT INTO owner_ydoc_outbox_entries (outbox_id,sequence,append_key,delivery_id,update_digest,update_blob_digest,byte_length,created_at_ms,pending,result_pending_bytes,result_oldest_entry_at_ms,result_state,draft_binding_revision,person_edit,agent_declaration_json) VALUES (?1,1,'sibling-key',?2,?3,?3,?4,10,1,?4,10,'active',1,NULL,?5)",params![outbox,delivery,sha,bytes.len() as i64,agent]).map_err(StorageError::persist_public)?;
        Ok::<_,StorageError>(())
    }).unwrap();
    (outbox, bytes)
}

#[tokio::test]
async fn fix2_close_session_cannot_hide_an_abandoned_draft() {
    let (mut f, supervisor, actor) = pending_release_fixture(40).await;
    let h = begin(&f, &actor).await;
    seal(&mut f, &h);
    let outbox: String = f
        .store
        .read_with(|c| {
            c.query_row(
                "SELECT outbox_id FROM owner_ydoc_outboxes WHERE object_id='object'",
                [],
                |r| r.get(0),
            )
        })
        .unwrap();
    fold(&mut f, &h);
    lifecycle(
        &actor,
        Action::Abandon {
            hold: h.clone(),
            resolved_digest: h.digest().into(),
        },
    )
    .await
    .unwrap();
    assert!(matches!(
        lifecycle(
            &actor,
            Action::CloseSession {
                hold: h.clone(),
                outbox
            }
        )
        .await,
        Err(dohc_engine_runtime::RuntimeError::Sync(
            sync::SyncError::RetryableState { .. }
        ))
    ));
    let drafts = actor
        .owner_ydoc_list_drafts(
            "workspace".into(),
            None,
            64,
            true,
            CancellationToken::new(),
            Arc::new(()),
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(drafts.len(), 1);
    actor
        .owner_ydoc_open_draft(f.binding.clone(), 1, CancellationToken::new(), Arc::new(()))
        .await
        .unwrap()
        .unwrap();
    actor
        .owner_ydoc_append_draft(
            "workspace".into(),
            dohc_engine_collab::owner_outbox::draft::OwnerDraftAppendInput {
                person_edit: true,
                binding: f.binding.clone(),
                expected_revision: 1,
                append_key: "offline".into(),
                update: f.doc.richdoc_append_paragraph("offline edit"),
                now_ms: 70,
                agent_declaration: None,
                automation_declaration: None,
            },
            CancellationToken::new(),
            Arc::new(()),
        )
        .await
        .unwrap()
        .unwrap();
    assert!(matches!(
        f.store
            .read_with(|c| prefix::commit_blocker_in(c, &f.binding, h.digest())),
        Err(dohc_engine_collab::OwnerOutboxError::Stopping)
    ));
    supervisor.close_all().unwrap();
}

#[tokio::test]
async fn fix2_settlement_after_abandon_is_retryable_not_corruption() {
    let (mut f, supervisor, actor) = pending_release_fixture(1).await;
    let h = begin(&f, &actor).await;
    seal(&mut f, &h);
    fold(&mut f, &h);
    lifecycle(
        &actor,
        Action::Abandon {
            hold: h.clone(),
            resolved_digest: h.digest().into(),
        },
    )
    .await
    .unwrap();
    let error = actor
        .owner_release_settle(
            h,
            f.root.path().to_owned(),
            Arc::new(()),
            60,
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .unwrap_err();
    assert!(
        matches!(
            error,
            dohc_engine_runtime::RuntimeError::Sync(sync::SyncError::RetryableState { .. })
        ),
        "{error:?}"
    );
    supervisor.close_all().unwrap();
}
