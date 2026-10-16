use super::*;
use dohc_engine_collab::{WriterDocCache, owner_outbox::prefix};
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
