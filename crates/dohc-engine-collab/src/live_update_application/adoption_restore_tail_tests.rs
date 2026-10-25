#[test]
fn history_recovery_keeps_compacted_adopted_private_tail_authors() {
    let mut f = Fixture::new();
    f.adopt().unwrap();
    native_tail_edit(&mut f, "# Private typing\n", 11);
    f.store
        .write_with(&NoFaults, |tx| {
            crate::author_coverage::advance_accepted_prefix_in(tx, &f.key, false)
        })
        .unwrap();
    durable::maybe_compact(&mut f.store, &f.key, 0, &NoFaults, 30).unwrap();
    assert_eq!(f.store.table_row_count("ydoc_updates").unwrap(), 0);
    let accepted = f.store
        .read_with(|conn| crate::author_coverage::interval_in(conn, &f.key, i64::MAX))
        .unwrap();
    assert_eq!(accepted.len(), 0, "private typing is not accepted coverage");
    let recovered = f.store
        .read_with(|conn| crate::author_coverage::recovery_in(conn, &f.key))
        .unwrap();
    assert!(recovered.json().contains("native-agent"));
}

#[test]
fn owner_adoption_keeps_unattributed_accepted_prefix_coverage() {
    let mut f = Fixture::new();
    f.edit(true);
    f.adopt().unwrap();
    let authors = f
        .store
        .read_with(|conn| crate::author_coverage::interval_in(conn, &f.key, i64::MAX))
        .unwrap();
    assert_eq!(
        authors.moment_json().unwrap(),
        r#"[{"kind":"unattributed"}]"#
    );
}

#[test]
fn adopted_settlement_preserves_unattributed_owner_and_recipient_contributions() {
    for contributor in ["owner", "recipient", "recipient-only"] {
        let mut f = Fixture::new();
        f.adopt().unwrap();
        assert!(
            f.store
                .read_with(|conn| crate::author_coverage::accepted_only_in(conn, &f.key))
                .unwrap()
        );
        let mut terminal = None;
        for cursor in 1..=if contributor == "recipient-only" {
            1
        } else {
            2
        } {
            let text = if cursor == 1 {
                "Recipient text"
            } else {
                contributor
            };
            let before = f.doc.state_vector();
            let bytes = f.doc.richdoc_append_paragraph(text);
            let mut first_seen: Vec<_> = f
                .doc
                .state_vector()
                .iter()
                .filter_map(|(client, clock)| {
                    let start = before.get(client);
                    (*clock > start).then_some(LiveUpdateStructRange {
                        client_id: client.get() as i64,
                        start_clock: i64::from(start),
                        end_clock: i64::from(*clock),
                    })
                })
                .collect();
            first_seen.sort_by_key(|range| range.client_id);
            let event = AdmittedLiveUpdate {
                metadata: AdmittedLiveUpdateMetadata {
                    accepted: RelayAcceptedLiveUpdate {
                        receipt: LiveUpdateReceipt {
                            delivery_id: format!("edit-{cursor}"),
                            update_digest: hex_sha256(&bytes),
                            journal_cursor: cursor,
                            accepting_host_epoch: 1,
                        },
                        binding: f.binding.clone(),
                        authority: if cursor == 2 && contributor == "owner" {
                            ServerDerivedLiveUpdateAuthority::Owner {
                                principal_id: "owner".into(),
                            }
                        } else {
                            ServerDerivedLiveUpdateAuthority::Named {
                                principal_id: "recipient".into(),
                                grant_id: "grant".into(),
                                grant_generation: 1,
                            }
                        },
                        received_at_ms: cursor,
                    },
                    first_seen,
                    canonical_version: Some(2),
                    author_snapshot: Some(if cursor == 1 {
                        vec![LiveAuthorEntry::Human {
                            human_id: "recipient".into(),
                            human_name: "Recipient".into(),
                        }]
                    } else {
                        vec![]
                    }),
                    first_seen_deletes: Some(vec![]),
                    checkpoint_coverage: None,
                },
                update_bytes: bytes,
            };
            terminal = Some(event.metadata.accepted.receipt.clone());
            assert!(matches!(
                apply_committed(
                    &mut f.store,
                    &mut WriterDocCache::new(),
                    &f.handle,
                    event,
                    &NoFaults,
                    100_000_000,
                    |_, _, _, _| Ok(())
                )
                .unwrap(),
                ApplicationResult::Applied(..)
            ));
        }
        crate::maybe_compact(&mut f.store, &f.key, 0, &NoFaults, 20).unwrap();
        drop(f.store);
        f.store = EngineStore::open(&f._scratch.join("engine.db"), 21).unwrap();
        let settlement = with_settlement(
            &mut f.store,
            &f.handle,
            terminal,
            128,
            NativeHistoryReconstruction {
                working_reserve_bytes: 8 * 1024 * 1024,
            },
            |store, audit| {
                let doc = store.read_with(|conn| durable::load_doc_in(conn, &f.key))?;
                let text = doc.project(ContentKind::Richdoc)?.content;
                let vector = hex_sha256(&doc.encode_state_vector());
                let result = store.write_with(&NoFaults, |tx| -> Result<_, ApplicationError> {
                    let authors =
                        crate::author_coverage::interval_in(tx, &f.key, i64::MAX)?.moment_json();
                    let written = dohc_engine_domain::write_projected_text_in_tx(
                        tx,
                        dohc_engine_domain::ProjectedWriteText {
                            workspace_id: "workspace",
                            version_id: "main",
                            object_id: "object",
                            path: std::borrow::Cow::Borrowed("owner.md"),
                            text: std::borrow::Cow::Borrowed(&text),
                            moment_id: "settled",
                            metadata_origin: "ydoc",
                            metadata_summary: None,
                            metadata_correlation_id: None,
                            author_json: authors.as_deref(),
                            now_ms: 30,
                            request_id: None,
                        },
                    )
                    .map_err(|_| ApplicationError::Corrupt)?;
                    tx.execute("UPDATE ydoc_docs SET last_settled_sha=?1 WHERE workspace_id='workspace' AND version_id='main' AND object_id='object'", [&written.snapshot.blob_sha256]).map_err(write_sql)?;
                    let id = audit.record_in_tx(
                        tx,
                        "settled",
                        &written.snapshot.blob_sha256,
                        &vector,
                        30,
                    )?;
                    crate::author_coverage::advance_in(tx, &f.key, false)?;
                    Ok(audit.result(id, "settled".into(), written.snapshot.blob_sha256, false))
                })?;
                let TxnOutcome::Committed(result) = result else {
                    return Err(ApplicationError::Interrupted);
                };
                Ok(result)
            },
        )
        .unwrap();
        let (authors, text): (String, String) = f.store.read_with(|conn| conn.query_row("SELECT m.author_json,b.text FROM moments m JOIN blobs b ON b.sha256=m.after_blob_sha256 WHERE m.moment_id=?1", [&settlement.moment_id], |row| Ok((row.get(0)?, row.get(1)?)))).unwrap();
        let authors: Value = serde_json::from_str(&authors).unwrap();
        // The relay's authority names the recipient once, in place of their
        // snapshot.
        let mut expected = vec![
            serde_json::json!({"kind":"named","userId":"recipient","grantId":"grant","grantGeneration":1}),
        ];
        if contributor != "recipient-only" {
            // The second edit carried no recording context, so its gap stays.
            expected.push(serde_json::json!({"kind":"unattributed"}));
            assert!(text.contains(contributor));
        }
        assert_eq!(authors, Value::Array(expected));
        assert!(text.contains("Recipient text"));
        assert!(
            f.store
                .read_with(|conn| crate::author_coverage::interval_in(conn, &f.key, i64::MAX))
                .unwrap()
                .is_empty()
        );
    }
}
fn native_tail_edit(f: &mut Fixture, source: &str, now: i64) -> owner_outbox::OwnerOutboxEntry {
    native_tail_edit_for(f, source, now, Some("owner"))
}

fn native_tail_edit_for(
    f: &mut Fixture,
    source: &str,
    now: i64,
    local_person: Option<&str>,
) -> owner_outbox::OwnerOutboxEntry {
    let update = f
        .doc
        .rewrite_content_to_markdown_preserving_source(ContentKind::Richdoc, source)
        .unwrap();
    native_tail_record_at_depth(f, update, now, local_person, 1)
}

fn native_tail_record_at_depth(
    f: &mut Fixture,
    update: Vec<u8>,
    now: i64,
    local_person: Option<&str>,
    depth: u32,
) -> owner_outbox::OwnerOutboxEntry {
    let key = f.key.clone();
    let attribution = dohc_engine_domain::ChangeAttribution {
        actor_kind: dohc_engine_domain::ChangeActorKind::Agent,
        on_behalf_of: local_person.map(str::to_owned),
        depth,
        run: None,
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

fn native_tail_event(
    f: &Fixture,
    bytes: Vec<u8>,
    delivery: String,
    cursor: i64,
) -> AdmittedLiveUpdate {
    // The relay binds the declared agent to the authenticated owner.
    let declared: Option<Option<String>> = f
        .store
        .read_with(|conn| {
            conn.query_row(
                "SELECT agent_declaration_json FROM owner_ydoc_outbox_entries WHERE delivery_id=?1",
                [&delivery],
                |r| r.get(0),
            )
            .optional()
        })
        .unwrap();
    let agent_declaration: Option<AgentDeclaration> = declared
        .flatten()
        .map(|json| serde_json::from_str(&json).unwrap());
    AdmittedLiveUpdate {
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
            canonical_version: Some(2),
            author_snapshot: Some(
                (agent_declaration)
                    .into_iter()
                    .map(|declaration| {
                        crate::live_update_application::LiveAuthorEntry::from(AgentDeclaration {
                            on_behalf_of: Some("owner".into()),
                            ..declaration
                        })
                    })
                    .collect(),
            ),
            first_seen_deletes: Some(vec![]),
            checkpoint_coverage: None,
        },
        update_bytes: bytes.clone(),
    }
}

fn native_tail_apply(
    f: &mut Fixture,
    bytes: Vec<u8>,
    delivery: String,
    cursor: i64,
) -> LiveUpdateHostApplicationAck {
    let event = native_tail_event(f, bytes.clone(), delivery, cursor);
    let ApplicationResult::Applied(ack, _) = apply_committed(
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
    native_tail_input_at(f, terminal, applied_sequence, 0)
}

fn native_tail_input_at(
    f: &mut Fixture,
    terminal: Option<LiveUpdateReceipt>,
    applied_sequence: i64,
    point_cursor: i64,
) -> NativeRestorePreparation {
    let receipt_digest = if point_cursor == 0 {
        f.binding.lineage_claim_id.clone()
    } else {
        terminal.as_ref().unwrap().update_digest.clone()
    };
    let coordinate = f.handle.registration.lock().unwrap().coordinate.clone();
    let fence = f
        ._owner
        .fence_restore(
            &mut f.store, None,
            NativeRestoreFence {
                point: crate::live_update_application::NativeRestoreSelection {
                    journal_cursor: point_cursor,
                    receipt_digest: receipt_digest.clone(),
                },
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
            journal_cursor: point_cursor,
            receipt_digest,
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
        .prepare_restore(&mut f.store, None, input, coordinate, 2_000_000, 100, &NoFaults)
}

fn native_tail_inventory(store: &EngineStore) -> Value {
    store.read_with(|conn| {
        let mut q=conn.prepare("SELECT outbox_id,sequence,append_key,delivery_id,update_digest,update_blob_digest,byte_length,created_at_ms,pending,native_source_json FROM owner_ydoc_outbox_entries ORDER BY outbox_id,sequence").unwrap();
        let entries=q.query_map([],|r|Ok(serde_json::json!([r.get::<_,String>(0)?,r.get::<_,i64>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?,r.get::<_,String>(4)?,r.get::<_,Option<String>>(5)?,r.get::<_,i64>(6)?,r.get::<_,i64>(7)?,r.get::<_,i64>(8)?,r.get::<_,Option<String>>(9)?]))).unwrap().collect::<Result<Vec<_>,_>>()?;
        Ok::<_,rusqlite::Error>(serde_json::json!(entries))
    }).unwrap()
}

#[test]
fn relay_bound_owner_agent_draft_applies_and_restores_with_local_or_absent_person() {
    for local_person in [Some("installation-person"), None] {
        let mut f = Fixture::new();
        f.adopt().unwrap();
        let first = native_tail_edit_for(&mut f, "first agent edit", 11, local_person);
        let ack = native_tail_apply(&mut f, first.update.clone(), first.delivery_id.clone(), 7);
        assert!(
            native_tail_apply(&mut f, first.update.clone(), first.delivery_id, 7)
                .application_replayed
        );
        assert_eq!(ack.local_ydoc_sequence, 1);
        let second = native_tail_edit_for(&mut f, "next agent edit", 12, local_person);
        let ack = native_tail_apply(&mut f, second.update, second.delivery_id, 8);
        assert_eq!(ack.local_ydoc_sequence, 2);
        let terminal = LiveUpdateReceipt {
            delivery_id: ack.delivery_id,
            update_digest: ack.update_digest,
            journal_cursor: ack.journal_cursor,
            accepting_host_epoch: ack.accepting_host_epoch,
        };
        let input = native_tail_input(&mut f, Some(terminal), ack.local_ydoc_sequence);
        let proposal = native_tail_prepare(&mut f, input).unwrap();
        assert_eq!(proposal.receipt().native_sources.len(), 2);
        for source in &proposal.receipt().native_sources {
            assert!(source.accepted_receipt.is_some());
            assert_eq!(
                source
                    .source
                    .native()
                    .unwrap()
                    .agent_declaration()
                    .unwrap()
                    .unwrap()
                    .on_behalf_of
                    .as_deref(),
                local_person
            );
        }
    }
}

#[test]
fn relay_bound_owner_agent_draft_applies_and_restores_after_same_client_depth_change() {
    let mut f = Fixture::new();
    f.adopt().unwrap();
    let baseline = f.doc.state_vector();
    let update = f.doc.richdoc_append_paragraph("first agent edit");
    let first = native_tail_record_at_depth(&mut f, update, 11, Some("owner"), 1);
    let first_vector = f.doc.state_vector();
    let clients: Vec<_> = first_vector
        .iter()
        .filter_map(|(&client, &clock)| (clock > baseline.get(&client)).then_some(client))
        .collect();
    assert_eq!(clients.len(), 1);
    let client = clients[0];
    let first_event = native_tail_event(&f, first.update, first.delivery_id, 7);
    let stored_snapshot = first_event.metadata.author_snapshot.clone();
    assert!(matches!(
        apply_committed(
            &mut f.store,
            &mut WriterDocCache::new(),
            &f.handle,
            first_event,
            &NoFaults,
            100_000_000,
            |_, _, _, _| Ok(())
        ),
        Ok(ApplicationResult::Applied(..))
    ));

    let update = f.doc.richdoc_append_paragraph("next agent edit");
    let second = native_tail_record_at_depth(&mut f, update, 12, Some("owner"), 2);
    let second_vector = f.doc.state_vector();
    assert_eq!(second_vector.len(), first_vector.len());
    assert!(second_vector.get(&client) > first_vector.get(&client));
    assert!(second_vector
        .iter()
        .all(|(&id, &clock)| id == client || clock == first_vector.get(&id)));
    let mut event = native_tail_event(&f, second.update, second.delivery_id, 8);
    assert_eq!(event.metadata.admitted_declaration().unwrap().depth, 2);
    // The relay keeps the first snapshot for this client's unchanged identity.
    event.metadata.author_snapshot = stored_snapshot;
    assert_eq!(event.metadata.admitted_declaration().unwrap().depth, 1);
    let before = native_tail_inventory(&f.store);
    for authority in [
        ServerDerivedLiveUpdateAuthority::Named {
            principal_id: "recipient".into(),
            grant_id: "grant".into(),
            grant_generation: 1,
        },
        ServerDerivedLiveUpdateAuthority::Link {
            principal_id: "recipient-link".into(),
            grant_id: "grant".into(),
            grant_generation: 1,
        },
    ] {
        let mut other = event.clone();
        other.metadata.accepted.authority = authority;
        let LiveAuthorEntry::Agent { on_behalf_of, .. } =
            &mut other.metadata.author_snapshot.as_mut().unwrap()[0]
        else {
            panic!("expected agent")
        };
        *on_behalf_of = Some("recipient".into());
        assert!(matches!(
            apply_committed(
                &mut f.store,
                &mut WriterDocCache::new(),
                &f.handle,
                other,
                &NoFaults,
                100_000_000,
                |_, _, _, _| Ok(())
            ),
            Err(ApplicationError::Conflict)
        ));
        assert_eq!(native_tail_inventory(&f.store), before);
        assert_eq!(
            f.store
                .table_row_count("live_device_update_applications")
                .unwrap(),
            1
        );
    }
    let ApplicationResult::Applied(ack, _) = apply_committed(
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
    assert_eq!(ack.local_ydoc_sequence, 2);
    let terminal = LiveUpdateReceipt {
        delivery_id: ack.delivery_id,
        update_digest: ack.update_digest,
        journal_cursor: ack.journal_cursor,
        accepting_host_epoch: ack.accepting_host_epoch,
    };
    let input = native_tail_input(&mut f, Some(terminal), ack.local_ydoc_sequence);
    let proposal = native_tail_prepare(&mut f, input).unwrap();
    let sources = &proposal.receipt().native_sources;
    assert_eq!(sources.len(), 2);
    for (source, depth) in sources.iter().zip([1, 2]) {
        assert!(source.accepted_receipt.is_some());
        assert_eq!(
            source
                .source
                .native()
                .unwrap()
                .agent_declaration()
                .unwrap()
                .unwrap()
                .depth,
            depth
        );
    }
}

#[test]
fn relay_bound_owner_agent_draft_refuses_other_principals_and_changed_agents() {
    let mut f = Fixture::new();
    f.adopt().unwrap();
    let source = native_tail_edit_for(&mut f, "agent edit", 11, Some("installation-person"));
    let original = native_tail_event(&f, source.update, source.delivery_id, 7);
    let before = native_tail_inventory(&f.store);
    for variant in ["named", "link", "wrong-person", "missing-person", "agent"] {
        let mut event = original.clone();
        let LiveAuthorEntry::Agent {
            agent_id,
            on_behalf_of,
            ..
        } = &mut event.metadata.author_snapshot.as_mut().unwrap()[0]
        else {
            panic!("expected agent")
        };
        match variant {
            "named" => {
                event.metadata.accepted.authority = ServerDerivedLiveUpdateAuthority::Named {
                    principal_id: "recipient".into(),
                    grant_id: "grant".into(),
                    grant_generation: 1,
                };
                *on_behalf_of = Some("recipient".into());
            }
            "link" => {
                event.metadata.accepted.authority = ServerDerivedLiveUpdateAuthority::Link {
                    principal_id: "private-link".into(),
                    grant_id: "grant".into(),
                    grant_generation: 1,
                };
                *on_behalf_of = Some("public-link".into());
            }
            "wrong-person" => *on_behalf_of = Some("recipient".into()),
            "missing-person" => *on_behalf_of = None,
            "agent" => *agent_id = "other-agent".into(),
            _ => unreachable!(),
        }
        assert!(
            matches!(
                apply_committed(
                    &mut f.store,
                    &mut WriterDocCache::new(),
                    &f.handle,
                    event,
                    &NoFaults,
                    100_000_000,
                    |_, _, _, _| Ok(())
                ),
                Err(ApplicationError::Conflict)
            ),
            "{variant}"
        );
        assert_eq!(native_tail_inventory(&f.store), before);
        assert_eq!(
            f.store
                .table_row_count("live_device_update_applications")
                .unwrap(),
            0
        );
    }
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
                        canonical_version: Some(2),
                        author_snapshot: Some(vec![]),
                        first_seen_deletes: Some(vec![]),
                        checkpoint_coverage: None,
                    },
                    update_bytes: vec![0, 0],
                };
                accepted_history::append_native(tx, &held, &event, 100_000_000)?;
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
    let native = proposal.receipt().native_sources[0]
        .source
        .native()
        .unwrap();
    assert_eq!(native.native_sequence, 1);
    assert!(matches!(&native.origin,
        owner_outbox::OwnerOutboxNativeOrigin::NativeUpdate {actor_origin_id:Some(id), ..} if id=="native-agent"));
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
                .map(|s| s.source.native().unwrap().native_sequence)
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
                        &mut restored_store, None,
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
        proposal.receipt().native_sources[0]
            .source
            .native()
            .unwrap()
            .origin,
        owner_outbox::OwnerOutboxNativeOrigin::AdoptionSeed
    ));
    assert!(proposal.receipt().native_sources[0]
        .accepted_receipt
        .is_none());
    assert_eq!(before, native_tail_inventory(&f.store));
}

#[test]
fn native_restore_tail_refuses_missing_or_changed_provenance_without_mutating_canonical_state() {
    let mutations = [
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
                    &mut f.store, None,
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

/// An adopted owner's native agent edit declares the agent its journal row
/// recorded, as an editor's draft declares it, with no draft proof. A retry
/// reads back the same entry. Restore verifies that native source declaration.
/// A person's or an automation's edit declares none.
#[test]
fn adopted_native_agent_edit_declares_its_recorded_agent() {
    let mut f = Fixture::new();
    f.adopt().unwrap();
    let entry = native_tail_edit(&mut f, "Agent pending", 11);
    let expected = dohc_engine_domain::AgentDeclaration {
        agent_id: "native-agent".into(),
        on_behalf_of: Some("owner".into()),
        depth: 1,
    };
    assert_eq!(entry.agent_declaration, Some(expected.clone()));
    let stored = |f: &Fixture| -> (Option<String>, Option<i64>, i64) {
        f.store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT agent_declaration_json,draft_binding_revision,json_extract(native_source_json,'$.nativeSequence') FROM owner_ydoc_outbox_entries WHERE delivery_id=?1",
                    [&entry.delivery_id],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
            })
            .unwrap()
    };
    let (declaration, revision, native_sequence) = stored(&f);
    assert_eq!(declaration, Some(serde_json::to_string(&expected).unwrap()));
    assert_eq!(revision, None);
    // The source derives the declaration, so a retry of the same native
    // update finds its entry unchanged.
    let key = f.key.clone();
    f.store
        .write_with(&NoFaults, |tx| {
            owner_outbox::append_adopted_local_update_in_tx(
                tx,
                &key,
                "owner.md",
                native_sequence,
                &entry.update,
                99,
            )
        })
        .unwrap();
    assert_eq!(stored(&f), (declaration, None, native_sequence));
    assert_eq!(
        f.store
            .table_row_count("owner_ydoc_outbox_entries")
            .unwrap(),
        1
    );
    // Restore classifies the native source with its derived declaration, and
    // refuses a stored one the source does not derive.
    let input = native_tail_input(&mut f, None, 0);
    let proposal = native_tail_prepare(&mut f, input.clone()).unwrap();
    assert_eq!(
        proposal.receipt().native_sources[0]
            .source
            .native()
            .unwrap()
            .agent_declaration()
            .unwrap(),
        Some(expected)
    );
    f.store
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "UPDATE owner_ydoc_outbox_entries SET agent_declaration_json=json_set(agent_declaration_json,'$.agentId','other-agent')",
                [],
            )
            .map_err(write_sql)
        })
        .unwrap();
    assert!(native_tail_prepare(&mut f, input).is_err());

    for kind in [
        dohc_engine_domain::ChangeActorKind::Human,
        dohc_engine_domain::ChangeActorKind::Automation,
    ] {
        let mut f = Fixture::new();
        f.adopt().unwrap();
        let update = f
            .doc
            .rewrite_content_to_markdown_preserving_source(ContentKind::Richdoc, "Not an agent")
            .unwrap();
        let key = f.key.clone();
        let attribution = dohc_engine_domain::ChangeAttribution {
            actor_kind: kind,
            on_behalf_of: Some("owner".into()),
            depth: 0,
            run: None,
        };
        crate::record_local_update(
            &mut f.store,
            &mut WriterDocCache::new(),
            &f.key,
            &update,
            crate::LocalAppend {
                actor_origin_id: Some("someone"),
                attribution: Some(&attribution),
                ..Default::default()
            },
            &NoFaults,
            11,
            |tx, outcome, _| {
                owner_outbox::append_adopted_local_update_in_tx(
                    tx,
                    &key,
                    "owner.md",
                    outcome.seq,
                    &update,
                    11,
                )
            },
        )
        .unwrap();
        let declared: Option<String> = f
            .store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT agent_declaration_json FROM owner_ydoc_outbox_entries",
                    [],
                    |r| r.get(0),
                )
            })
            .unwrap();
        assert_eq!(declared, None);
    }
}

#[test]
fn adopted_native_agent_edit_accepts_a_capped_snapshot_without_agent_credit() {
    let mut f = Fixture::new();
    f.adopt().unwrap();
    let entry = native_tail_edit(&mut f, "Agent pending", 11);
    let undeclared = AdmittedLiveUpdate {
        metadata: AdmittedLiveUpdateMetadata {
            accepted: RelayAcceptedLiveUpdate {
                receipt: LiveUpdateReceipt {
                    delivery_id: entry.delivery_id.clone(),
                    update_digest: entry.update_digest.clone(),
                    journal_cursor: 7,
                    accepting_host_epoch: 1,
                },
                binding: f.binding.clone(),
                authority: ServerDerivedLiveUpdateAuthority::Owner {
                    principal_id: "owner".into(),
                },
                received_at_ms: 7,
            },
            first_seen: vec![],

            canonical_version: Some(2),

            author_snapshot: Some(vec![]),

            first_seen_deletes: Some(vec![]),

            checkpoint_coverage: None,
        },
        update_bytes: entry.update.clone(),
    };
    let result = apply_committed(
        &mut f.store,
        &mut WriterDocCache::new(),
        &f.handle,
        undeclared,
        &NoFaults,
        100_000_000,
        |_, _, _, _| Ok(()),
    )
    .unwrap();
    assert!(matches!(result, ApplicationResult::Applied(..)));
    assert_eq!(
        f.store
            .table_row_count("live_device_update_applications")
            .unwrap(),
        1
    );
}

/// An enrolled owner's pending draft names no native journal update. Restore
/// keeps it as an owner draft source with its delivery identity and declared
/// agent; an accepted draft also carries its own receipt, whose declaration
/// must be the draft's.
#[test]
fn native_restore_keeps_enrolled_owner_drafts_as_truthful_sources() {
    let declaration = dohc_engine_domain::AgentDeclaration {
        agent_id: "trip-agent 旅行".into(),
        on_behalf_of: Some("owner".into()),
        depth: 1,
    };
    for accepted in [false, true] {
        let mut f = Fixture::new();
        f.adopt().unwrap();
        let update = f
            .doc
            .rewrite_content_to_markdown_preserving_source(ContentKind::Richdoc, "Agent draft")
            .unwrap();
        let entry = owner_outbox::append(
            &mut f.store,
            "workspace",
            owner_outbox::OwnerOutboxAppendInput {
                binding: f.binding.clone(),
                base_update: f.cut.baseline_bytes.clone(),
                append_key: "agent-draft".into(),
                update: update.clone(),
                limits: f.cut.outbox_limits.clone(),
                created_at_ms: 11,
            },
        )
        .unwrap();
        let (terminal, applied_sequence) = if accepted {
            let receipt = LiveUpdateReceipt {
                delivery_id: entry.delivery_id.clone(),
                update_digest: entry.update_digest.clone(),
                journal_cursor: 7,
                accepting_host_epoch: 1,
            };
            let event = AdmittedLiveUpdate {
                metadata: AdmittedLiveUpdateMetadata {
                    accepted: RelayAcceptedLiveUpdate {
                        receipt: receipt.clone(),
                        binding: f.binding.clone(),
                        authority: ServerDerivedLiveUpdateAuthority::Owner {
                            principal_id: "owner".into(),
                        },
                        received_at_ms: 7,
                    },
                    first_seen: vec![],

                    canonical_version: Some(2),

                    author_snapshot: Some(
                        (Some(declaration.clone()))
                            .into_iter()
                            .map(crate::live_update_application::LiveAuthorEntry::from)
                            .collect(),
                    ),

                    first_seen_deletes: Some(vec![]),

                    checkpoint_coverage: None,
                },
                update_bytes: update.clone(),
            };
            let ApplicationResult::Applied(ack, _) = apply_committed(
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
            (Some(receipt), ack.local_ydoc_sequence)
        } else {
            let key = f.key.clone();
            f.store
                .write_with(&NoFaults, |tx| {
                    durable::record_authorized_update_in_tx(
                        tx, &key, &update, true, None, None, false, 11,
                    )
                })
                .unwrap();
            (None, 0)
        };
        // An enrollment observes this binding, and the entry keeps the agent
        // its editor declared. Its draft proof is set below.
        let namespace = f.handle.registration.lock().unwrap().namespace.clone();
        let binding_json = serde_json::to_string(&f.binding).unwrap();
        let declaration_json = serde_json::to_string(&declaration).unwrap();
        let b = f.binding.clone();
        f.store
            .write_with(&NoFaults, |tx| {
                tx.execute(
                    "UPDATE owner_ydoc_outbox_entries SET agent_declaration_json=?1 WHERE delivery_id=?2",
                    params![declaration_json, entry.delivery_id],
                )
                .map_err(write_sql)?;
                tx.execute(
                    "INSERT INTO ydoc_owner_bindings (workspace_id,main_version_id,object_id,lineage_claim_id,binding_json,relay_database_namespace,binding_revision,accepted_cursor,native_head_sequence,checkpoint_digest,max_pending_bytes,max_pending_age_ms) VALUES (?1,?2,?3,?4,?5,?6,1,0,0,?4,1000000,60000)",
                    params![b.workspace_id, b.main_version_id, b.object_id, b.lineage_claim_id, binding_json, namespace],
                )
                .map_err(write_sql)?;
                Ok::<_, ApplicationError>(())
            })
            .unwrap();
        let input = native_tail_input(&mut f, terminal.clone(), applied_sequence);
        let inventory = native_tail_inventory(&f.store);
        // A generic entry queued before enrollment carries no draft proof.
        // Neither does a revision the enrollment never reached, another
        // relay's enrollment, or an enrollment observing another binding.
        let path = f.binding.current_path.clone();
        for mutation in [
            String::new(),
            "UPDATE owner_ydoc_outbox_entries SET draft_binding_revision=2".into(),
            "UPDATE owner_ydoc_outbox_entries SET draft_binding_revision=1; \
             UPDATE ydoc_owner_bindings SET relay_database_namespace='other-relay'"
                .into(),
            format!(
                "UPDATE ydoc_owner_bindings SET relay_database_namespace='{namespace}', \
                 binding_json=json_set(binding_json,'$.currentPath','elsewhere.md')"
            ),
        ] {
            f.store
                .write_with(&NoFaults, |tx| {
                    tx.execute_batch(&mutation).map_err(write_sql)
                })
                .unwrap();
            assert!(
                native_tail_prepare(&mut f, input.clone()).is_err(),
                "accepted {mutation:?}"
            );
            assert_eq!(inventory, native_tail_inventory(&f.store));
        }
        f.store
            .write_with(&NoFaults, |tx| {
                tx.execute(
                    "UPDATE ydoc_owner_bindings SET binding_json=json_set(binding_json,'$.currentPath',?1)",
                    [&path],
                )
                .map_err(write_sql)
            })
            .unwrap();
        let proposal = native_tail_prepare(&mut f, input.clone()).unwrap();
        let sources = &proposal.receipt().native_sources;
        assert_eq!(sources.len(), 1);
        assert_eq!(sources[0].delivery_id, entry.delivery_id);
        assert_eq!(sources[0].append_key, "agent-draft");
        assert_eq!(sources[0].accepted_receipt, terminal);
        assert!(sources[0].source.native().is_none());
        assert_eq!(
            serde_json::to_value(&sources[0].source).unwrap(),
            serde_json::json!({
                "binding": f.binding,
                "updateDigest": entry.update_digest,
                "origin": {
                    "kind": "ownerDraft",
                    "agentDeclaration": {"agentId": "trip-agent 旅行", "onBehalfOf": "owner", "depth": 1},
                },
            })
        );
        assert_eq!(inventory, native_tail_inventory(&f.store));
        // The draft's declaration is part of its identity: a changed one
        // no longer matches its accepted receipt or the saved proposal.
        f.store
            .write_with(&NoFaults, |tx| {
                tx.execute(
                    "UPDATE owner_ydoc_outbox_entries SET agent_declaration_json=json_set(agent_declaration_json,'$.agentId','other-agent')",
                    [],
                )
                .map_err(write_sql)
            })
            .unwrap();
        assert!(native_tail_prepare(&mut f, input).is_err());
    }
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
        proposal.receipt().native_sources[0]
            .source
            .native()
            .unwrap()
            .origin,
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
    // Retain trusted overlapping context even when the update itself deduplicates.
    let appended = f
        .store
        .write_with(&NoFaults, |tx| {
            let outcome = durable::record_authorized_update_in_tx(
                tx, &key, &original, true, None, None, false, 11,
            )?;
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
            .map(|source| source.source.native().unwrap().native_sequence)
            .collect::<Vec<_>>(),
        vec![1, 1]
    );
    assert!(matches!(
        proposal.receipt().native_sources[1]
            .source
            .native()
            .unwrap()
            .origin,
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
            canonical_version: Some(2),
            author_snapshot: Some(vec![]),
            first_seen_deletes: Some(vec![]),
            checkpoint_coverage: None,
        },
    };
    let inventory = native_tail_inventory(&f.store);
    let coordinate = f.handle.registration.lock().unwrap().coordinate.clone();
    let receipt = f
        ._owner
        .apply_restore(
            &mut f.store, None,
            &mut WriterDocCache::new(),
            input.clone(),
            coordinate.clone(),
            2_000_000,
            100,
            90,
            &NoFaults,
            |_, _, _, _| Ok(()),
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
                &mut f.store, None,
                &mut WriterDocCache::new(),
                input.clone(),
                coordinate.clone(),
                2_000_000,
                100,
                110,
                &NoFaults,
                |_, _, _, _| Ok(()),
            )
            .unwrap()
    );
    assert_eq!(
        f._owner
            .fence_restore(
                &mut f.store, None,
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
                &mut store, None,
                &mut WriterDocCache::new(),
                input.clone(),
                coordinate.clone(),
                2_000_000,
                100,
                140,
                &NoFaults,
                |_, _, _, _| Ok(()),
            )
            .unwrap()
    );
    assert_eq!(inventory, native_tail_inventory(&store));
    assert_eq!(store.table_row_count("moments").unwrap(), 1);
    let settled = owner
        .with_restore_settlement(
            &mut store, None,
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
            &mut store, None,
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
            canonical_version: Some(2),
            author_snapshot: Some(vec![]),
            first_seen_deletes: Some(vec![]),
            checkpoint_coverage: None,
        },
    };
    f._owner
        .apply_restore(
            &mut f.store, None,
            &mut WriterDocCache::new(),
            input.clone(),
            coordinate.clone(),
            2_000_000,
            100,
            90,
            &NoFaults,
            |_, _, _, _| Ok(()),
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
            &mut f.store, None,
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
            &mut f.store, None,
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
            &mut f.store, None,
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

/// Twice the rescue's 8 MiB working reserve, so the rescue cannot hold the proof.
const LARGE_PROOF_BYTES: usize = 16 * 1024 * 1024;

#[test]
fn restored_owner_capacity_rescue_streams_past_a_large_prior_proof_and_private_tail() {
    restored_owner_capacity_rescue(100, true);
}

#[test]
fn restored_owner_capacity_rescue_streams_past_a_large_baseline_restore_proof_and_private_tail() {
    restored_owner_capacity_rescue(200, false);
}

fn restored_owner_capacity_rescue(events: i64, select_terminal: bool) {
    let started = std::time::Instant::now();
    let mark = |phase| {
        if std::env::var_os("DOHC_RUST_PROFILE").is_some() {
            eprintln!(
                "RUST_PROFILE restored-{events}-{select_terminal} {phase} {:.3}s",
                started.elapsed().as_secs_f64()
            );
        }
    };
    mark("fixture-start");
    let seed = Fixture::new();
    let baseline = seed.cut.baseline_bytes.clone();
    let source: String = seed
        .store
        .read_with(|conn| {
            conn.query_row(
                "SELECT text FROM blobs WHERE sha256=?1",
                [&seed.cut.source_digest],
                |r| r.get(0),
            )
        })
        .unwrap();
    drop(seed);
    let mut selectors = vec!["owner.md".into()];
    selectors.extend((0..99).map(|i| format!("z{i:02}{}", "x".repeat(1020))));
    selectors.sort();
    let mut f = Fixture::with_source_selectors(source, baseline.clone(), selectors);
    f.adopt().unwrap();
    mark("fixture");
    let mut terminal = None;
    let mut sequence = 0;
    for cursor in 1..=events {
        let ack = native_tail_apply(&mut f, baseline.clone(), format!("proof-{cursor}"), cursor);
        sequence = ack.local_ydoc_sequence;
        terminal = Some(LiveUpdateReceipt {
            delivery_id: ack.delivery_id,
            update_digest: ack.update_digest,
            journal_cursor: cursor,
            accepting_host_epoch: 1,
        });
    }
    mark("ingress");
    // The selected current point retains a second authentic copy of the
    // accepted suffix: a large proof with half as many ingress operations.
    let preparation = native_tail_input_at(
        &mut f,
        terminal,
        sequence,
        if select_terminal { events } else { 0 },
    );
    let coordinate = f.handle.registration.lock().unwrap().coordinate.clone();
    const PROOF_BYTES: usize = 512 * 1024 * 1024;
    let proposal = f
        ._owner
        .prepare_restore(
            &mut f.store, None,
            preparation.clone(),
            coordinate.clone(),
            PROOF_BYTES,
            1000,
            &NoFaults,
        )
        .unwrap();
    let proof_length: i64 = f
        .store
        .read_with(|conn| {
            conn.query_row(
                "SELECT length(CAST(proposal_json AS BLOB)) FROM live_restore_fences",
                [],
                |r| r.get(0),
            )
        })
        .unwrap();
    assert!(proof_length > LARGE_PROOF_BYTES as i64);
    mark("prepare-proof");
    let mut binding = f.binding.clone();
    binding.restore_fence_generation = 1;
    let input = NativeRestoreApplication {
        preparation,
        candidate_digest: proposal.receipt().candidate_digest.clone(),
        native_source_manifest_digest: proposal.receipt().native_source_manifest_digest.clone(),
        admitted: AdmittedLiveUpdateMetadata {
            accepted: RelayAcceptedLiveUpdate {
                receipt: LiveUpdateReceipt {
                    delivery_id: "proof-restore".into(),
                    update_digest: proposal.receipt().candidate_digest.clone(),
                    journal_cursor: events + 1,
                    accepting_host_epoch: 1,
                },
                binding: binding.clone(),
                authority: ServerDerivedLiveUpdateAuthority::Owner {
                    principal_id: "owner".into(),
                },
                received_at_ms: events + 1,
            },
            first_seen: proposal.receipt().replacement_ranges.clone(),

            canonical_version: Some(2),

            author_snapshot: Some(vec![]),

            first_seen_deletes: Some(vec![]),

            checkpoint_coverage: None,
        },
    };
    drop(proposal);
    f._owner
        .apply_restore(
            &mut f.store, None,
            &mut WriterDocCache::new(),
            input.clone(),
            coordinate.clone(),
            PROOF_BYTES,
            1000,
            events + 2,
            &NoFaults,
            |_, _, _, _| Ok(()),
        )
        .unwrap();
    mark("apply-restore");
    let settled = f
        ._owner
        .with_restore_settlement(
            &mut f.store, None,
            input.clone(),
            coordinate.clone(),
            PROOF_BYTES,
            1000,
            |store, audit| {
                restore_content::tests::record_test_projection(store, audit, "large-proof-restored")
            },
        )
        .unwrap();
    mark("settle-restore");
    f._owner
        .resume_restore(
            &mut f.store, None,
            NativeRestoreResume {
                application: input,
                settlement_id: settled.settlement_id,
            },
            coordinate.clone(),
            PROOF_BYTES,
            1000,
            events + 3,
            &NoFaults,
            |_, _, _, _| Ok(()),
        )
        .unwrap();
    mark("resume-restore");
    f.binding = binding;
    f.doc = f
        .store
        .read_with(|conn| durable::load_doc_in(conn, &f.key))
        .unwrap();
    f.handle = f
        ._owner
        .register(
            &mut f.store,
            "namespace".into(),
            coordinate,
            f.binding.clone(),
        )
        .unwrap();
    {
        let held = f.handle.registration.lock().unwrap();
        let resumed = f
            .store
            .read_with(|conn| restore_resume::generation(conn, &held))
            .unwrap()
            .unwrap();
        assert_eq!(resumed.application_receipt.journal_cursor, events + 1);
        assert_eq!(resumed.binding, f.binding);
    }
    mark("register-resumed");
    let peer = Ydoc::wire();
    peer.apply(&f.doc.encode_full_state()).unwrap();
    native_tail_edit(&mut f, "Private after restore", events + 4);
    let remote = peer.richdoc_append_paragraph("Accepted after restore");
    let mut cursor = events + 2;
    let mut terminal = None;
    let blocked = loop {
        assert!(cursor < events + 82);
        let event = AdmittedLiveUpdate {
            metadata: AdmittedLiveUpdateMetadata {
                accepted: RelayAcceptedLiveUpdate {
                    receipt: LiveUpdateReceipt {
                        delivery_id: format!("post-restore-{cursor}"),
                        update_digest: hex_sha256(&remote),
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

                canonical_version: Some(2),

                author_snapshot: Some(
                    (Some(AgentDeclaration {
                        agent_id: format!("{cursor:03}{}", "\"".repeat(509)),
                        on_behalf_of: Some("\"".repeat(512)),
                        depth: 1,
                    }))
                    .into_iter()
                    .map(crate::live_update_application::LiveAuthorEntry::from)
                    .collect(),
                ),

                first_seen_deletes: Some(vec![]),

                checkpoint_coverage: None,
            },
            update_bytes: remote.clone(),
        };
        let result = apply_committed(
            &mut f.store,
            &mut WriterDocCache::new(),
            &f.handle,
            event.clone(),
            &NoFaults,
            8 * 1024 * 1024,
            |_, _, _, _| Ok(()),
        )
        .unwrap();
        match result {
            ApplicationResult::Applied(..) => {
                terminal = Some(event.metadata.accepted.receipt);
                cursor += 1;
            }
            ApplicationResult::Pending(ApplicationPending::SettlementRequired) => break event,
            other => panic!("unexpected {other:?}"),
        }
    };
    mark("fill-capacity");
    let rescue = with_settlement(
        &mut f.store,
        &f.handle,
        terminal.clone(),
        128,
        NativeHistoryReconstruction {
            working_reserve_bytes: 8 * 1024 * 1024,
        },
        |store, audit| {
            let doc = audit
                .accepted_prefix()
                .expect("private tail needs accepted state");
            let text = doc.project(ContentKind::Richdoc)?.content;
            assert!(text.contains("Accepted after restore"));
            assert!(!text.contains("Private after restore"));
            restore_content::tests::record_test_projection(store, audit, "rescued-after-restore")
        },
    )
    .unwrap();
    mark("rescue");
    let text: String = f
        .store
        .read_with(|conn| {
            conn.query_row(
                "SELECT text FROM blobs WHERE sha256=?1",
                [&rescue.markdown_digest],
                |r| r.get(0),
            )
        })
        .unwrap();
    assert!(text.contains("Accepted after restore"));
    assert!(!text.contains("Private after restore"));
    let held = f.handle.registration.lock().unwrap();
    assert!(matches!(
        f.store.read_with(|conn| accepted_history::read(
            conn,
            &held,
            terminal.unwrap().journal_cursor,
            &mut restore_content::Budget {
                remaining: LARGE_PROOF_BYTES
            },
            4095
        )),
        Err(ApplicationError::ConfiguredByteBudgetExceeded)
    ));
    drop(held);
    mark("proof-budget-refusal");
    let retry = apply_committed(
        &mut f.store,
        &mut WriterDocCache::new(),
        &f.handle,
        blocked,
        &NoFaults,
        8 * 1024 * 1024,
        |_, _, _, _| Ok(()),
    )
    .unwrap();
    assert!(matches!(retry, ApplicationResult::Applied(..)));
    mark("complete");
}
