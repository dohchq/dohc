fn native_tail_edit(f: &mut Fixture, source: &str, now: i64) -> owner_outbox::OwnerOutboxEntry {
    let update = f
        .doc
        .rewrite_content_to_markdown_preserving_source(ContentKind::Richdoc, source)
        .unwrap();
    let key = f.key.clone();
    let attribution = dohc_engine_domain::ChangeAttribution {
        actor_kind: dohc_engine_domain::ChangeActorKind::Agent,
        on_behalf_of: Some("owner".into()),
        depth: 1,
    };
    crate::record_local_update(
        &mut f.store,
        &mut WriterDocCache::new(),
        &f.key,
        &update,
        crate::LocalAppend {
            restore_generation: (f.binding.restore_fence_generation > 0)
                .then_some(f.binding.restore_fence_generation),
            actor_origin_id: Some("native-agent"),
            attribution: Some(&attribution),
            ..Default::default()
        },
        &NoFaults,
        now,
        |tx, outcome, _| {
            owner_outbox::append_adopted_local_update_in_tx(
                tx,
                &key,
                "owner.md",
                outcome.seq,
                &update,
                now,
            )
        },
    )
    .unwrap();
    let outbox: String = f
        .store
        .read_with(|conn| {
            conn.query_row(
                "SELECT outbox_id FROM owner_ydoc_outboxes WHERE restore_fence_generation=?1",
                [f.binding.restore_fence_generation],
                |r| r.get(0),
            )
        })
        .unwrap();
    owner_outbox::read_pending(&f.store, "workspace", &outbox)
        .unwrap()
        .entries
        .last()
        .unwrap()
        .clone()
}

fn native_tail_apply(
    f: &mut Fixture,
    bytes: Vec<u8>,
    delivery: String,
    cursor: i64,
) -> LiveUpdateHostApplicationAck {
    let event = AdmittedLiveUpdate {
        metadata: AdmittedLiveUpdateMetadata {
            accepted: RelayAcceptedLiveUpdate {
                receipt: LiveUpdateReceipt {
                    delivery_id: delivery,
                    update_digest: hex_sha256(&bytes),
                    journal_cursor: cursor,
                    accepting_host_epoch: 1,
                },
                binding: f.binding.clone(),
                authority: ServerDerivedLiveUpdateAuthority::Owner {
                    principal_id: "owner".into(),
                },
                received_at_ms: cursor,
            },
            first_seen: vec![],
        },
        update_bytes: bytes.clone(),
    };
    let ApplicationResult::Applied(ack) = apply_committed(
        &mut f.store,
        &mut WriterDocCache::new(),
        &f.handle,
        event,
        &NoFaults,
        100_000_000,
        |_, _, _, _| Ok(()),
    )
    .unwrap() else {
        panic!("application refused")
    };
    f.doc.apply(&bytes).unwrap();
    ack
}

fn native_tail_input(
    f: &mut Fixture,
    terminal: Option<LiveUpdateReceipt>,
    applied_sequence: i64,
) -> NativeRestorePreparation {
    let coordinate = f.handle.registration.lock().unwrap().coordinate.clone();
    let fence = f
        ._owner
        .fence_restore(
            &mut f.store,
            NativeRestoreFence {
                operation_id: if f.binding.restore_fence_generation == 0 {
                    "tail-restore".into()
                } else {
                    format!("tail-restore-{}", f.binding.restore_fence_generation + 1)
                },
                relay_database_namespace: "namespace".into(),
                old_binding: f.binding.clone(),
                host_id: "host".into(),
                new_fence: f.binding.restore_fence_generation + 1,
                origin: RestoreDeliveryOrigin::Owner {
                    id: f.cut.adoption_id.clone(),
                },
                terminal,
                applied_sequence,
            },
            coordinate,
            40,
            &NoFaults,
        )
        .unwrap();
    let point = Ydoc::wire();
    point.apply(&f.cut.baseline_bytes).unwrap();
    let projection = point.project(ContentKind::Richdoc).unwrap().content;
    let source = point
        .preserved_markdown_source(&projection)
        .unwrap_or_else(|| projection.clone());
    NativeRestorePreparation {
        fence,
        point: NativeRestorePoint {
            journal_cursor: 0,
            receipt_digest: f.binding.lineage_claim_id.clone(),
            markdown_digest: hex_sha256(source.as_bytes()),
            projection_digest: hex_sha256(projection.as_bytes()),
        },
    }
}

fn native_tail_prepare(
    f: &mut Fixture,
    input: NativeRestorePreparation,
) -> Result<NativeRestoreProposal, ApplicationError> {
    let coordinate = f.handle.registration.lock().unwrap().coordinate.clone();
    f._owner
        .prepare_restore(&mut f.store, input, coordinate, 2_000_000, 100, &NoFaults)
}

fn native_tail_inventory(store: &EngineStore) -> Value {
    store.read_with(|conn| {
        let mut q=conn.prepare("SELECT outbox_id,sequence,append_key,delivery_id,update_digest,update_blob_digest,byte_length,created_at_ms,pending,native_source_json FROM owner_ydoc_outbox_entries ORDER BY outbox_id,sequence").unwrap();
        let entries=q.query_map([],|r|Ok(serde_json::json!([r.get::<_,String>(0)?,r.get::<_,i64>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?,r.get::<_,String>(4)?,r.get::<_,Option<String>>(5)?,r.get::<_,i64>(6)?,r.get::<_,i64>(7)?,r.get::<_,i64>(8)?,r.get::<_,Option<String>>(9)?]))).unwrap().collect::<Result<Vec<_>,_>>()?;
        Ok::<_,rusqlite::Error>(serde_json::json!(entries))
    }).unwrap()
}

#[test]
fn native_restore_classifies_a_lost_ack_before_the_accepted_checkpoint() {
    let mut f = Fixture::new();
    f.adopt().unwrap();
    let source = native_tail_edit(&mut f, "accepted native edit", 11);
    let ack = native_tail_apply(&mut f, source.update.clone(), source.delivery_id.clone(), 7);
    let old_receipt = LiveUpdateReceipt {
        delivery_id: ack.delivery_id,
        update_digest: ack.update_digest,
        journal_cursor: ack.journal_cursor,
        accepting_host_epoch: ack.accepting_host_epoch,
    };
    let held = f.handle.registration.lock().unwrap();
    let terminal = f
        .store
        .write_with(&NoFaults, |tx| -> Result<_, ApplicationError> {
            let mut terminal = old_receipt.clone();
            for ordinal in 2..=4095 {
                let event = AdmittedLiveUpdate {
                    metadata: AdmittedLiveUpdateMetadata {
                        accepted: RelayAcceptedLiveUpdate {
                            receipt: LiveUpdateReceipt {
                                delivery_id: format!("tail-history-{ordinal}"),
                                update_digest: hex_sha256(&[0, 0]),
                                journal_cursor: ordinal * 7,
                                accepting_host_epoch: 1,
                            },
                            binding: f.binding.clone(),
                            authority: ServerDerivedLiveUpdateAuthority::Owner {
                                principal_id: "owner".into(),
                            },
                            received_at_ms: ordinal,
                        },
                        first_seen: vec![],
                    },
                    update_bytes: vec![0, 0],
                };
                accepted_history::append(tx, &held, &event, 100_000_000)?;
                insert_application(tx, &held, &event, ack.local_ydoc_sequence)?;
                terminal = event.metadata.accepted.receipt;
            }
            Ok(terminal)
        })
        .unwrap();
    drop(held);
    let TxnOutcome::Committed(terminal) = terminal else {
        panic!("tail history interrupted")
    };
    let input = native_tail_input(&mut f, Some(terminal), ack.local_ydoc_sequence);
    let before = native_tail_inventory(&f.store);
    let proposal = native_tail_prepare(&mut f, input).unwrap();
    assert_eq!(
        proposal.receipt().accepted_history.checkpoint.event_count,
        4095
    );
    assert!(proposal.receipt().accepted_history.suffix.is_empty());
    assert_eq!(proposal.receipt().native_sources.len(), 1);
    assert_eq!(
        proposal.receipt().native_sources[0].accepted_receipt,
        Some(old_receipt)
    );
    assert_eq!(
        proposal.receipt().native_sources[0].source.native_sequence,
        1
    );
    assert!(
        matches!(&proposal.receipt().native_sources[0].source.origin,
        owner_outbox::OwnerOutboxNativeOrigin::NativeUpdate {actor_origin_id:Some(id), ..} if id=="native-agent")
    );
    assert_eq!(native_tail_inventory(&f.store), before);
}

#[test]
fn native_restore_tail_retains_interleaved_pending_context_with_descending_terminal_ack() {
    for compact in [false, true] {
        let mut f = Fixture::new();
        f.adopt().unwrap();
        let peer = Ydoc::wire();
        peer.apply(&f.cut.baseline_bytes).unwrap();
        let remote = peer
            .rewrite_content_to_markdown_preserving_source(
                ContentKind::Richdoc,
                "# Accepted collaborator\n",
            )
            .unwrap();
        let first = native_tail_edit(&mut f, "# Owner admission\n", 11);
        native_tail_edit(
            &mut f,
            "---\ntitle: 'Unsent été 😀'\n---\n\n# Pending before\n",
            12,
        );
        let earlier = native_tail_apply(&mut f, remote, "remote".into(), 7);
        assert_eq!(earlier.local_ydoc_sequence, 3);
        native_tail_edit(&mut f, "# Pending after 🐱\n", 13);
        let terminal =
            native_tail_apply(&mut f, first.update.clone(), first.delivery_id.clone(), 11);
        assert_eq!(terminal.local_ydoc_sequence, 1);
        let before = native_tail_inventory(&f.store);
        if compact {
            durable::maybe_compact(&mut f.store, &f.key, 0, &NoFaults, 30).unwrap();
            assert_eq!(f.store.table_row_count("ydoc_updates").unwrap(), 0);
        }
        let input = native_tail_input(
            &mut f,
            Some(LiveUpdateReceipt {
                delivery_id: terminal.delivery_id,
                update_digest: terminal.update_digest,
                journal_cursor: terminal.journal_cursor,
                accepting_host_epoch: terminal.accepting_host_epoch,
            }),
            terminal.local_ydoc_sequence,
        );
        assert_eq!(input.fence.local_head_sequence, 4);
        let proposal = native_tail_prepare(&mut f, input.clone()).unwrap();
        assert_eq!(proposal.receipt().native_sources.len(), 3);
        assert_eq!(
            proposal
                .receipt()
                .native_sources
                .iter()
                .map(|s| s.source.native_sequence)
                .collect::<Vec<_>>(),
            vec![1, 2, 4]
        );
        assert_eq!(
            proposal
                .receipt()
                .native_sources
                .iter()
                .filter(|s| s.accepted_receipt.is_some())
                .count(),
            1
        );
        assert_eq!(proposal.receipt().accepted_history.suffix.len(), 2);
        assert_eq!(before, native_tail_inventory(&f.store));
        let queued = owner_outbox::read_pending(
            &f.store,
            "workspace",
            &proposal.receipt().native_sources[0].outbox_id,
        )
        .unwrap();
        assert_eq!(queued.state, owner_outbox::OwnerOutboxState::Quarantined);
        assert_eq!(
            queued
                .entries
                .iter()
                .map(|entry| entry.update.clone())
                .collect::<Vec<_>>(),
            proposal.native_source_bytes()
        );
        let admitted = proposal.receipt().native_sources[0]
            .accepted_receipt
            .as_ref()
            .unwrap();
        assert!(matches!(
            owner_outbox::acknowledge(
                &mut f.store,
                "workspace",
                &queued.outbox_id,
                &[owner_outbox::OwnerDeliveryReceipt {
                    delivery_id: admitted.delivery_id.clone(),
                    update_digest: admitted.update_digest.clone(),
                    journal_cursor: admitted.journal_cursor,
                    accepting_host_epoch: admitted.accepting_host_epoch
                }]
            ),
            Err(owner_outbox::OwnerOutboxError::Frozen)
        ));
        assert_eq!(before, native_tail_inventory(&f.store));
        let point = Ydoc::wire();
        point.apply(proposal.point_state_bytes()).unwrap();
        let restored = Ydoc::wire();
        restored.apply(proposal.frozen_state_bytes()).unwrap();
        restored.apply(proposal.candidate_bytes()).unwrap();
        assert_eq!(
            restored.project(ContentKind::Richdoc).unwrap().content,
            point.project(ContentKind::Richdoc).unwrap().content
        );
        assert_eq!(
            hex_sha256(
                restored
                    .preserved_markdown_source(
                        &restored.project(ContentKind::Richdoc).unwrap().content
                    )
                    .unwrap()
                    .as_bytes()
            ),
            input.point.markdown_digest
        );
        let expected = serde_json::to_vec(&proposal).unwrap();
        assert_eq!(
            expected,
            serde_json::to_vec(&native_tail_prepare(&mut f, input.clone()).unwrap()).unwrap()
        );
        use dohc_engine_storage::backup::{create_verified_backup, BackupOutcome, RealFreeSpace};
        let BackupOutcome::Verified(backup) = create_verified_backup(
            &f.store,
            &f._scratch.join("recovery"),
            "tail",
            "test",
            50,
            &RealFreeSpace,
            &NoFaults,
        )
        .unwrap() else {
            panic!("backup interrupted")
        };
        let mut restored_store = EngineStore::open(&backup.backup_path, 60).unwrap();
        let mut owner = ApplicationOwner::new("workspace".into()).unwrap();
        let coordinate = f.handle.registration.lock().unwrap().coordinate.clone();
        assert_eq!(
            expected,
            serde_json::to_vec(
                &owner
                    .prepare_restore(
                        &mut restored_store,
                        input.clone(),
                        coordinate,
                        2_000_000,
                        100,
                        &NoFaults
                    )
                    .unwrap()
            )
            .unwrap()
        );
        assert_eq!(before, native_tail_inventory(&restored_store));
        drop(f.store);
        f.store = EngineStore::open(&f._scratch.join("engine.db"), 70).unwrap();
        assert_eq!(
            expected,
            serde_json::to_vec(&native_tail_prepare(&mut f, input).unwrap()).unwrap()
        );
        assert_eq!(before, native_tail_inventory(&f.store));
        assert_eq!(
            f.store
                .table_row_count("live_device_update_applications")
                .unwrap(),
            2
        );
        assert_eq!(f.store.table_row_count("moments").unwrap(), 1);
    }
}

#[test]
fn native_restore_tail_retains_adoption_seed_without_admitting_it() {
    let mut f = Fixture::new();
    f.local_edit_before_adoption();
    f.adopt().unwrap();
    let before = native_tail_inventory(&f.store);
    let input = native_tail_input(&mut f, None, 1);
    let proposal = native_tail_prepare(&mut f, input).unwrap();
    assert_eq!(proposal.receipt().native_sources.len(), 1);
    assert!(matches!(
        proposal.receipt().native_sources[0].source.origin,
        owner_outbox::OwnerOutboxNativeOrigin::AdoptionSeed
    ));
    assert!(proposal.receipt().native_sources[0]
        .accepted_receipt
        .is_none());
    assert_eq!(before, native_tail_inventory(&f.store));
}

#[test]
fn native_restore_tail_refuses_missing_or_changed_provenance_without_mutating_canonical_state() {
    let mutations=[
        "UPDATE owner_ydoc_outbox_entries SET native_source_json=NULL",
        "UPDATE owner_ydoc_outbox_entries SET native_source_json=json_set(native_source_json,'$.binding.objectId','other')",
        "UPDATE owner_ydoc_outbox_entries SET native_source_json=json_set(native_source_json,'$.adoptionId','other')",
        "UPDATE owner_ydoc_outbox_entries SET native_source_json=json_set(native_source_json,'$.nativeSequence',0)",
        "UPDATE owner_ydoc_outbox_entries SET native_source_json=json_set(native_source_json,'$.updateDigest',printf('%064d',0))",
        "UPDATE owner_ydoc_outbox_entries SET native_source_json=json_set(native_source_json,'$.origin.actorOriginId','other')",
        "UPDATE owner_ydoc_outbox_entries SET native_source_json=json_set(native_source_json,'$.origin.kind','foreign')",
        "UPDATE owner_ydoc_outbox_entries SET native_source_json=json_set(native_source_json,'$.unknown',1)",
        "UPDATE owner_ydoc_outbox_entries SET native_source_json=json_set(native_source_json,'$.origin.unknown',1)",
        "UPDATE owner_ydoc_outbox_entries SET delivery_id='foreign'",
        "UPDATE owner_ydoc_outbox_entries SET append_key='generic'",
        "DELETE FROM owner_ydoc_outbox_entries",
        "DELETE FROM ydoc_updates",
        "UPDATE binary_blobs SET bytes=zeroblob(byte_length) WHERE sha256 IN (SELECT update_digest FROM owner_ydoc_outbox_entries)",
        "UPDATE binary_blobs SET bytes=zeroblob(byte_length+1) WHERE sha256 IN (SELECT update_digest FROM owner_ydoc_outbox_entries)",
    ];
    for persisted in [false, true] {
        for mutation in mutations {
            let mut f = Fixture::new();
            f.adopt().unwrap();
            native_tail_edit(&mut f, "Pending", 11);
            let input = native_tail_input(&mut f, None, 0);
            if persisted {
                native_tail_prepare(&mut f, input.clone()).unwrap();
            }
            f.store
                .write_with(&NoFaults, |tx| tx.execute(mutation, []).map_err(write_sql))
                .unwrap();
            let inventory = native_tail_inventory(&f.store);
            assert!(
                native_tail_prepare(&mut f, input).is_err(),
                "accepted {mutation}; persisted={persisted}"
            );
            assert_eq!(native_tail_inventory(&f.store), inventory);
            assert_eq!(f.store.table_row_count("moments").unwrap(), 1);
            assert_eq!(
                f.store
                    .table_row_count("live_device_update_applications")
                    .unwrap(),
                0
            );
        }
    }
}

#[test]
fn native_restore_tail_replay_refuses_changed_retained_metadata_after_compaction() {
    let mut f = Fixture::new();
    f.adopt().unwrap();
    native_tail_edit(&mut f, "Pending", 11);
    durable::maybe_compact(&mut f.store, &f.key, 0, &NoFaults, 20).unwrap();
    let input = native_tail_input(&mut f, None, 0);
    native_tail_prepare(&mut f, input.clone()).unwrap();
    f.store.write_with(&NoFaults,|tx|tx.execute("UPDATE owner_ydoc_outbox_entries SET native_source_json=json_set(native_source_json,'$.origin.actorOriginId','other')",[]).map_err(write_sql)).unwrap();
    assert!(native_tail_prepare(&mut f, input).is_err());
}

#[test]
fn native_restore_tail_first_prepare_refuses_changed_compacted_attribution() {
    for (field, replacement) in [
        ("$.origin.actorOriginId", serde_json::json!("other")),
        ("$.origin.actorOriginId", serde_json::Value::Null),
        ("$.origin.actorKind", serde_json::json!("automation")),
        ("$.origin.onBehalfOf", serde_json::json!("other-owner")),
        ("$.origin.chainDepth", serde_json::json!(2)),
        ("$.origin.recordedAtMs", serde_json::json!(12)),
        ("$.updateDigest", serde_json::json!("a".repeat(64))),
    ] {
        let mut f = Fixture::new();
        f.adopt().unwrap();
        native_tail_edit(&mut f, "Pending", 11);
        durable::maybe_compact(&mut f.store, &f.key, 0, &NoFaults, 20).unwrap();
        assert_eq!(f.store.table_row_count("ydoc_updates").unwrap(), 0);
        let input = native_tail_input(&mut f, None, 0);
        f.store.write_with(&NoFaults, |tx| tx.execute(
        "UPDATE owner_ydoc_outbox_entries SET native_source_json=json_set(native_source_json,?1,json(?2))",
        params![field, replacement.to_string()],
    ).map_err(write_sql)).unwrap();
        let before = native_tail_inventory(&f.store);
        assert!(
            native_tail_prepare(&mut f, input).is_err(),
            "accepted changed {field}"
        );
        assert_eq!(before, native_tail_inventory(&f.store));
    }
}

#[test]
fn native_restore_append_identity_survives_retries_restart_and_acknowledgement() {
    let mut f = Fixture::new();
    f.adopt().unwrap();
    let entry = native_tail_edit(&mut f, "Pending", 11);
    let key = f.key.clone();
    for acknowledged in [false, true] {
        if acknowledged {
            let ack = native_tail_apply(&mut f, entry.update.clone(), entry.delivery_id.clone(), 7);
            let outbox: String = f
                .store
                .read_with(|conn| {
                    conn.query_row(
                        "SELECT outbox_id FROM owner_ydoc_outbox_entries WHERE delivery_id=?1",
                        [&entry.delivery_id],
                        |row| row.get(0),
                    )
                })
                .unwrap();
            owner_outbox::acknowledge(
                &mut f.store,
                "workspace",
                &outbox,
                &[owner_outbox::OwnerDeliveryReceipt {
                    delivery_id: ack.delivery_id,
                    update_digest: ack.update_digest,
                    journal_cursor: ack.journal_cursor,
                    accepting_host_epoch: ack.accepting_host_epoch,
                }],
            )
            .unwrap();
        }
        let before = native_tail_inventory(&f.store);
        for now in [99, 111] {
            drop(f.store);
            f.store = EngineStore::open(&f._scratch.join("engine.db"), now).unwrap();
            f.store
                .write_with(&NoFaults, |tx| {
                    owner_outbox::append_adopted_local_update_in_tx(
                        tx,
                        &key,
                        "owner.md",
                        1,
                        &entry.update,
                        now,
                    )
                })
                .unwrap();
            assert_eq!(before, native_tail_inventory(&f.store));
            assert_eq!(
                f.store
                    .table_row_count("owner_ydoc_outbox_entries")
                    .unwrap(),
                1
            );
        }
    }
}

#[test]
fn native_restore_tail_budgets_count_pending_sources_on_first_prepare_and_replay() {
    let mut f = Fixture::new();
    f.adopt().unwrap();
    native_tail_edit(&mut f, "Pending one", 11);
    native_tail_edit(&mut f, "Pending two", 12);
    let input = native_tail_input(&mut f, None, 0);
    for persisted in [false, true] {
        if persisted {
            native_tail_prepare(&mut f, input.clone()).unwrap();
        }
        for (bytes, events) in [(2_000_000, 1), (1, 100)] {
            let coordinate = f.handle.registration.lock().unwrap().coordinate.clone();
            assert!(f
                ._owner
                .prepare_restore(
                    &mut f.store,
                    input.clone(),
                    coordinate,
                    bytes,
                    events,
                    &NoFaults
                )
                .is_err());
        }
    }
}

#[test]
fn native_restore_tail_does_not_infer_generic_pending_provenance_from_matching_bytes() {
    let mut f = Fixture::new();
    f.adopt().unwrap();
    let update = f
        .doc
        .rewrite_content_to_markdown_preserving_source(ContentKind::Richdoc, "Generic pending")
        .unwrap();
    crate::record_local_update(
        &mut f.store,
        &mut WriterDocCache::new(),
        &f.key,
        &update,
        crate::LocalAppend::default(),
        &NoFaults,
        11,
        |_, _, _| Ok(()),
    )
    .unwrap();
    owner_outbox::append(
        &mut f.store,
        "workspace",
        owner_outbox::OwnerOutboxAppendInput {
            binding: f.binding.clone(),
            base_update: f.cut.baseline_bytes.clone(),
            append_key: "generic-pending".into(),
            update,
            limits: f.cut.outbox_limits.clone(),
            created_at_ms: 11,
        },
    )
    .unwrap();
    let input = native_tail_input(&mut f, None, 0);
    let inventory = native_tail_inventory(&f.store);
    assert!(native_tail_prepare(&mut f, input).is_err());
    assert_eq!(inventory, native_tail_inventory(&f.store));
}

#[test]
fn native_restore_tail_keeps_adoption_seed_overlap_separate_from_admission() {
    let mut f = Fixture::new();
    f.local_edit_before_adoption();
    f.adopt().unwrap();
    let outbox: String = f
        .store
        .read_with(|conn| {
            conn.query_row("SELECT outbox_id FROM owner_ydoc_outboxes", [], |r| {
                r.get(0)
            })
        })
        .unwrap();
    let seed = owner_outbox::read_pending(&f.store, "workspace", &outbox)
        .unwrap()
        .entries[0]
        .clone();
    let ack = native_tail_apply(&mut f, seed.update, seed.delivery_id, 7);
    let receipt = LiveUpdateReceipt {
        delivery_id: ack.delivery_id,
        update_digest: ack.update_digest,
        journal_cursor: ack.journal_cursor,
        accepting_host_epoch: ack.accepting_host_epoch,
    };
    let input = native_tail_input(&mut f, Some(receipt.clone()), ack.local_ydoc_sequence);
    let inventory = native_tail_inventory(&f.store);
    let proposal = native_tail_prepare(&mut f, input).unwrap();
    assert_eq!(proposal.receipt().native_sources.len(), 1);
    assert_eq!(proposal.receipt().accepted_history.suffix.len(), 1);
    assert_eq!(
        proposal.receipt().native_sources[0].accepted_receipt,
        Some(receipt)
    );
    assert!(matches!(
        proposal.receipt().native_sources[0].source.origin,
        owner_outbox::OwnerOutboxNativeOrigin::AdoptionSeed
    ));
    assert_eq!(inventory, native_tail_inventory(&f.store));
}

#[test]
fn native_restore_tail_accepts_trusted_deduped_pre_adoption_source_as_overlapping_context() {
    let mut f = Fixture::new();
    f.local_edit_before_adoption();
    let original = f.doc.encode_full_state();
    f.adopt().unwrap();
    let key = f.key.clone();
    let appended = f
        .store
        .write_with(&NoFaults, |tx| {
            let outcome = durable::record_update_in_tx(tx, &key, &original, None, None, 11)?;
            owner_outbox::append_adopted_local_update_in_tx(
                tx,
                &key,
                "owner.md",
                outcome.seq,
                &original,
                11,
            )?;
            Ok::<_, crate::CollabError>(outcome)
        })
        .unwrap();
    let TxnOutcome::Committed(appended) = appended else {
        panic!("append interrupted")
    };
    assert_eq!(appended.seq, 1);
    let input = native_tail_input(&mut f, None, 1);
    let inventory = native_tail_inventory(&f.store);
    let proposal = native_tail_prepare(&mut f, input).unwrap();
    assert_eq!(proposal.receipt().native_sources.len(), 2);
    assert_eq!(
        proposal
            .receipt()
            .native_sources
            .iter()
            .map(|source| source.source.native_sequence)
            .collect::<Vec<_>>(),
        vec![1, 1]
    );
    assert!(matches!(
        proposal.receipt().native_sources[1].source.origin,
        owner_outbox::OwnerOutboxNativeOrigin::NativeUpdate { .. }
    ));
    assert!(proposal
        .receipt()
        .native_sources
        .iter()
        .all(|source| source.accepted_receipt.is_none()));
    assert!(proposal.receipt().accepted_history.suffix.is_empty());
    assert_eq!(inventory, native_tail_inventory(&f.store));
}

#[test]
fn native_restore_apply_preserves_quarantined_tail_and_survives_compaction_and_backup() {
    let mut f = Fixture::new();
    f.adopt().unwrap();
    native_tail_edit(&mut f, "Pending before", 11);
    native_tail_edit(&mut f, "Pending after", 12);
    let prep = native_tail_input(&mut f, None, 0);
    let proposal = native_tail_prepare(&mut f, prep.clone()).unwrap();
    let mut binding = f.binding.clone();
    binding.restore_fence_generation = 1;
    let input = NativeRestoreApplication {
        preparation: prep.clone(),
        candidate_digest: proposal.receipt().candidate_digest.clone(),
        native_source_manifest_digest: proposal.receipt().native_source_manifest_digest.clone(),
        admitted: AdmittedLiveUpdateMetadata {
            accepted: RelayAcceptedLiveUpdate {
                receipt: LiveUpdateReceipt {
                    delivery_id: "restore-tail".into(),
                    update_digest: proposal.receipt().candidate_digest.clone(),
                    journal_cursor: 71,
                    accepting_host_epoch: 2,
                },
                binding,
                authority: ServerDerivedLiveUpdateAuthority::Owner {
                    principal_id: "restoring-owner".into(),
                },
                received_at_ms: 80,
            },
            first_seen: proposal.receipt().replacement_ranges.clone(),
        },
    };
    let inventory = native_tail_inventory(&f.store);
    let coordinate = f.handle.registration.lock().unwrap().coordinate.clone();
    let receipt = f
        ._owner
        .apply_restore(
            &mut f.store,
            &mut WriterDocCache::new(),
            input.clone(),
            coordinate.clone(),
            2_000_000,
            100,
            90,
            &NoFaults,
        )
        .unwrap();
    assert_eq!(receipt.local_head_sequence, 3);
    assert_eq!(inventory, native_tail_inventory(&f.store));
    assert_eq!(
        f.store
            .table_row_count("live_device_update_applications")
            .unwrap(),
        1
    );
    assert!(matches!(
        f.store
            .write_with(&NoFaults, |tx| durable::record_update_in_tx(
                tx,
                &f.key,
                proposal.candidate_bytes(),
                None,
                None,
                100
            )),
        Err(CollabError::RestoreFenced)
    ));
    durable::maybe_compact(&mut f.store, &f.key, 0, &NoFaults, 100).unwrap();
    assert_eq!(f.store.table_row_count("ydoc_updates").unwrap(), 0);
    assert_eq!(
        receipt,
        f._owner
            .apply_restore(
                &mut f.store,
                &mut WriterDocCache::new(),
                input.clone(),
                coordinate.clone(),
                2_000_000,
                100,
                110,
                &NoFaults
            )
            .unwrap()
    );
    assert_eq!(
        f._owner
            .fence_restore(
                &mut f.store,
                prep.fence.operation.clone(),
                coordinate.clone(),
                110,
                &NoFaults
            )
            .unwrap(),
        prep.fence
    );
    use dohc_engine_storage::backup::{create_verified_backup, BackupOutcome, RealFreeSpace};
    let BackupOutcome::Verified(backup) = create_verified_backup(
        &f.store,
        &f._scratch.join("applied-recovery"),
        "apply",
        "test",
        120,
        &RealFreeSpace,
        &NoFaults,
    )
    .unwrap() else {
        panic!("backup interrupted")
    };
    let mut store = EngineStore::open(&backup.backup_path, 130).unwrap();
    let mut owner = ApplicationOwner::new("workspace".into()).unwrap();
    assert_eq!(
        receipt,
        owner
            .apply_restore(
                &mut store,
                &mut WriterDocCache::new(),
                input.clone(),
                coordinate.clone(),
                2_000_000,
                100,
                140,
                &NoFaults
            )
            .unwrap()
    );
    assert_eq!(inventory, native_tail_inventory(&store));
    assert_eq!(store.table_row_count("moments").unwrap(), 1);
    let settled = owner
        .with_restore_settlement(
            &mut store,
            input.clone(),
            coordinate.clone(),
            2_000_000,
            100,
            |store, audit| {
                restore_content::tests::record_test_projection(store, audit, "restored-tail-moment")
            },
        )
        .unwrap();
    assert!(!settled.materialized);
    assert_eq!(
        settled.markdown_digest,
        input.preparation.point.markdown_digest
    );
    assert_eq!(settled.application_count, 1);
    assert_eq!(settled.local_ydoc_sequence, 3);
    assert_eq!(inventory, native_tail_inventory(&store));
    assert_eq!(store.table_row_count("moments").unwrap(), 2);
    drop(store);
    let mut store = EngineStore::open(&backup.backup_path, 150).unwrap();
    let replay = owner
        .with_restore_settlement(
            &mut store,
            input,
            coordinate,
            2_000_000,
            100,
            |store, audit| {
                restore_content::tests::record_test_projection(store, audit, "restored-tail-moment")
            },
        )
        .unwrap();
    assert_eq!(settled.settlement_id, replay.settlement_id);
    assert_eq!(inventory, native_tail_inventory(&store));
    assert_eq!(store.table_row_count("moments").unwrap(), 2);
}

#[test]
fn resumed_owner_retains_old_pending_sources_and_creates_an_independent_generation_queue() {
    let mut f = Fixture::new();
    f.adopt().unwrap();
    let old = native_tail_edit(&mut f, "Unaccepted owner edit", 11);
    let prep = native_tail_input(&mut f, None, 0);
    let proposal = native_tail_prepare(&mut f, prep.clone()).unwrap();
    let coordinate = f.handle.registration.lock().unwrap().coordinate.clone();
    let mut binding = f.binding.clone();
    binding.restore_fence_generation = 1;
    let input = NativeRestoreApplication {
        preparation: prep,
        candidate_digest: proposal.receipt().candidate_digest.clone(),
        native_source_manifest_digest: proposal.receipt().native_source_manifest_digest.clone(),
        admitted: AdmittedLiveUpdateMetadata {
            accepted: RelayAcceptedLiveUpdate {
                receipt: LiveUpdateReceipt {
                    delivery_id: "resume-owner".into(),
                    update_digest: proposal.receipt().candidate_digest.clone(),
                    journal_cursor: 71,
                    accepting_host_epoch: 2,
                },
                binding: binding.clone(),
                authority: ServerDerivedLiveUpdateAuthority::Owner {
                    principal_id: "restoring-owner".into(),
                },
                received_at_ms: 80,
            },
            first_seen: proposal.receipt().replacement_ranges.clone(),
        },
    };
    f._owner
        .apply_restore(
            &mut f.store,
            &mut WriterDocCache::new(),
            input.clone(),
            coordinate.clone(),
            2_000_000,
            100,
            90,
            &NoFaults,
        )
        .unwrap();
    let canonical = f
        .store
        .read_with(|conn| durable::load_doc_in(conn, &f.key))
        .unwrap();
    let without_native = Ydoc::wire();
    without_native.apply(&f.cut.baseline_bytes).unwrap();
    without_native.apply(proposal.candidate_bytes()).unwrap();
    assert!(!crate::replay_parity::structurally_equal_v2(&without_native, &canonical).unwrap());
    let held = f.handle.registration.lock().unwrap();
    f.store
        .read_with(|conn| -> Result<(), ApplicationError> {
            let history = accepted_history::read(
                conn,
                &held,
                71,
                &mut restore_content::Budget {
                    remaining: 2_000_000,
                },
                100,
            )?;
            assert_eq!(history.proof.event_count, 1);
            assert_eq!(
                history.proof.checkpoint.restore_operation_id.as_deref(),
                Some("tail-restore")
            );
            assert!(crate::replay_parity::structurally_equal_v2(
                &history.doc,
                &canonical
            )?);
            Ok(())
        })
        .unwrap();
    drop(held);
    let settlement = f
        ._owner
        .with_restore_settlement(
            &mut f.store,
            input.clone(),
            coordinate.clone(),
            2_000_000,
            100,
            |store, audit| {
                restore_content::tests::record_test_projection(store, audit, "resumed-owner")
            },
        )
        .unwrap();
    let resume = NativeRestoreResume {
        application: input,
        settlement_id: settlement.settlement_id,
    };
    f._owner
        .resume_restore(
            &mut f.store,
            resume.clone(),
            coordinate.clone(),
            2_000_000,
            100,
            100,
            &NoFaults,
            |_, _, _, _| Ok(()),
        )
        .unwrap();
    f.binding = binding;
    f.doc = canonical;
    f.handle = f
        ._owner
        .register(
            &mut f.store,
            "namespace".into(),
            coordinate.clone(),
            f.binding.clone(),
        )
        .unwrap();
    let old_inventory = native_tail_inventory(&f.store);
    let stale = f.doc.richdoc_append_paragraph("stale writer");
    assert!(matches!(
        crate::record_local_update(
            &mut f.store,
            &mut WriterDocCache::new(),
            &f.key,
            &stale,
            crate::LocalAppend::default(),
            &NoFaults,
            110,
            |_, _, _| Ok(())
        ),
        Err(CollabError::RestoreFenced)
    ));
    f.doc = f
        .store
        .read_with(|conn| durable::load_doc_in(conn, &f.key))
        .unwrap();
    let fresh = native_tail_edit(&mut f, "New generation pending", 120);
    assert_ne!(fresh.delivery_id, old.delivery_id);
    assert_eq!(fresh.sequence, 1);
    let ack = native_tail_apply(&mut f, fresh.update.clone(), fresh.delivery_id.clone(), 82);
    let terminal = LiveUpdateReceipt {
        delivery_id: ack.delivery_id,
        update_digest: ack.update_digest,
        journal_cursor: ack.journal_cursor,
        accepting_host_epoch: ack.accepting_host_epoch,
    };
    let second = native_tail_input(&mut f, Some(terminal), ack.local_ydoc_sequence);
    let next = native_tail_prepare(&mut f, second).unwrap();
    assert_eq!(next.receipt().accepted_history.event_count, 2);
    assert_eq!(next.receipt().native_sources.len(), 1);
    assert_eq!(
        next.receipt().native_sources[0]
            .binding
            .restore_fence_generation,
        1
    );
    let inventory = native_tail_inventory(&f.store);
    for entry in old_inventory.as_array().unwrap() {
        assert!(inventory.as_array().unwrap().contains(entry));
    }
    let historic = f
        ._owner
        .resume_restore(
            &mut f.store,
            resume,
            coordinate,
            2_000_000,
            100,
            130,
            &NoFaults,
            |_, _, _, _| panic!("old retry must not resume new fence"),
        )
        .unwrap();
    assert_eq!(historic.binding.restore_fence_generation, 1);
}
