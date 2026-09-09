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
            conn.query_row("SELECT outbox_id FROM owner_ydoc_outboxes", [], |r| {
                r.get(0)
            })
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
                operation_id: "tail-restore".into(),
                relay_database_namespace: "namespace".into(),
                old_binding: f.binding.clone(),
                host_id: "host".into(),
                new_fence: 1,
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
        owner_origin: Some(f.cut.clone()),
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
        assert_eq!(proposal.receipt().accepted_sources.len(), 2);
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
    assert_eq!(proposal.receipt().accepted_sources.len(), 1);
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
    assert!(proposal.receipt().accepted_sources.is_empty());
    assert_eq!(inventory, native_tail_inventory(&f.store));
}
