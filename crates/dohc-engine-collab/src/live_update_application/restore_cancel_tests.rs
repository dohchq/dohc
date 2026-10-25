/// The fixture's restore fence of `operation`, from its binding's generation
/// to the next, at the tip its current activation holds.
fn fence_next(f: &mut Fixture, operation: &str) -> Result<NativeRestoreFenceReceipt, ApplicationError> {
    let mut input = NativeRestoreFence {
        operation_id: operation.into(),
        relay_database_namespace: "namespace".into(),
        old_binding: f.binding.clone(),
        host_id: "host".into(),
        new_fence: f.binding.restore_fence_generation + 1,
        origin: RestoreDeliveryOrigin::Owner { id: f.cut.adoption_id.clone() },
        terminal: None,
        applied_sequence: 0,
    };
    let (terminal, sequence) = {
        let held = f.handle.registration.lock().unwrap();
        f.store.read_with(|conn| super::super::restore_fence::applied_tip(conn, &held, &input))?
    };
    input.terminal = terminal;
    input.applied_sequence = sequence;
    let coordinate = f.handle.registration.lock().unwrap().coordinate.clone();
    f._owner.fence_restore(&mut f.store, None, input, coordinate, 40, &NoFaults)
}

/// A restore of `fence` to the lineage's baseline.
fn baseline_preparation(f: &Fixture, fence: NativeRestoreFenceReceipt) -> NativeRestorePreparation {
    let point = Ydoc::wire();
    point.apply(&f.cut.baseline_bytes).unwrap();
    let projection = point.project(ContentKind::Richdoc).unwrap().content;
    let source = point.preserved_markdown_source(&projection).unwrap_or_else(|| projection.clone());
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

fn prepare(f: &mut Fixture, input: NativeRestorePreparation, max_bytes: usize) -> Result<NativeRestoreProposal, ApplicationError> {
    let coordinate = f.handle.registration.lock().unwrap().coordinate.clone();
    f._owner.prepare_restore(&mut f.store, None, input, coordinate, max_bytes, 100, &NoFaults)
}

/// The cancellation of `operation`'s fence from the fixture's generation.
fn cancel_named(f: &mut Fixture, operation: &str) -> Result<RestoreFenceCancellationOutcome, ApplicationError> {
    let input = cancellation(f, operation);
    cancel(f, &input)
}

/// The fence's terminal cancellation, which must be what `cancel` answers.
fn cancel_fenced(f: &mut Fixture, operation: &str) -> NativeRestoreCancellationReceipt {
    let RestoreFenceCancellationOutcome::FenceCancelled(cancelled) = cancel_named(f, operation).unwrap() else {
        panic!("the committed fence ends in its cancellation");
    };
    *cancelled
}

/// The fixture's application of `operation`'s prepared restore, admitted at
/// `cursor` under the fence's new binding.
fn restore_application(
    f: &Fixture,
    preparation: NativeRestorePreparation,
    proposal: &NativeRestoreProposal,
    cursor: i64,
) -> NativeRestoreApplication {
    let mut binding = f.binding.clone();
    binding.restore_fence_generation = preparation.fence.operation.new_fence;
    NativeRestoreApplication {
        preparation,
        candidate_digest: proposal.receipt().candidate_digest.clone(),
        native_source_manifest_digest: proposal.receipt().native_source_manifest_digest.clone(),
        admitted: AdmittedLiveUpdateMetadata {
            accepted: RelayAcceptedLiveUpdate {
                receipt: LiveUpdateReceipt {
                    delivery_id: format!("restore-{cursor}"),
                    update_digest: proposal.receipt().candidate_digest.clone(),
                    journal_cursor: cursor,
                    accepting_host_epoch: 2,
                },
                binding,
                authority: ServerDerivedLiveUpdateAuthority::Owner { principal_id: "restoring-owner".into() },
                received_at_ms: cursor,
            },
            first_seen: proposal.receipt().replacement_ranges.clone(),
            canonical_version: Some(2),
            author_snapshot: Some(vec![]),
            first_seen_deletes: Some(vec![]),
            checkpoint_coverage: None,
        },
    }
}

fn apply_restore(f: &mut Fixture, input: NativeRestoreApplication) -> Result<NativeRestoreApplicationReceipt, ApplicationError> {
    let coordinate = f.handle.registration.lock().unwrap().coordinate.clone();
    f._owner.apply_restore(&mut f.store, None, &mut WriterDocCache::new(), input, coordinate, 2_000_000, 100, 90, &NoFaults, |_, _, _, _| Ok(()))
}

/// What a cancellation leaves as the fence found it: the document's state
/// and native head, the lineage's origin, accepted history and endpoint,
/// and the retained outboxes and their quarantines.
fn preserved(f: &Fixture) -> (Vec<u8>, i64, Vec<String>, RetainedPrefixBody) {
    let head: i64 = f
        .store
        .read_with(|conn| conn.query_row("SELECT head_update_seq FROM ydoc_docs WHERE object_id='object'", [], |r| r.get(0)))
        .unwrap();
    let endpoint = f
        .store
        .read_with(|conn| retirement::accepted_endpoint(conn, "namespace", &f.key, &f.binding.lineage_claim_id))
        .unwrap();
    let kept = rows(
        f,
        &[
            "live_owner_adoptions",
            "live_accepted_updates",
            "live_accepted_checkpoints",
            "live_device_settlements",
            "owner_ydoc_outboxes",
            "owner_ydoc_outbox_entries",
            "ydoc_updates",
        ],
    );
    (full_state(f), head, kept, endpoint)
}

/// The released generation and cursor of `activation`.
fn released_generation(f: &Fixture, activation: &str) -> (i64, i64) {
    f.store
        .read_with(|conn| {
            conn.query_row(
                "SELECT released_restore_generation,released_accepted_cursor FROM live_owner_activations WHERE activation_id=?1",
                [activation],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
        })
        .unwrap()
}

fn reopen_store(f: &mut Fixture) {
    let path = f._scratch.join("engine.db");
    f.store = EngineStore::open(&path, 31).unwrap();
    f._owner = ApplicationOwner::new("workspace".into()).unwrap();
}

/// Sol's proof test 1: a fence, its cancellation before admission, a
/// restart and replay, then retirement and release at the fenced
/// generation. The cancellation leaves content, native head, lineage origin,
/// accepted endpoint and retained work as the fence left them, and the
/// relay's key at the generation before refuses. With nothing accepted
/// since the origin, the endpoint is the origin's.
#[test]
fn a_cancelled_restore_retires_and_releases_at_its_fenced_generation() {
    for edited in [false, true] {
        let mut f = Fixture::new();
        if edited {
            f.edit(true);
        }
        f.adopt().unwrap();
        let fence = fence_next(&mut f, "restore").unwrap();
        let fenced = preserved(&f);
        let cancelled = cancel_fenced(&mut f, "restore");
        assert_eq!(cancelled.fence, fence);
        assert_eq!(cancelled.endpoint, fenced.3, "edited={edited}");
        assert_eq!(cancelled.endpoint.event_count, i64::from(edited));
        assert_eq!(preserved(&f), fenced, "edited={edited}: only the generation moved");
        assert_eq!(bound(&f), (1, false));
        // The answer outlives a restart, and nothing revives the operation.
        reopen_store(&mut f);
        assert_eq!(
            cancel_named(&mut f, "restore").unwrap(),
            RestoreFenceCancellationOutcome::FenceCancelled(Box::new(cancelled.clone()))
        );
        let coordinate = retirement_host();
        assert!(matches!(
            f._owner.fence_restore_after_reconnect(&mut f.store, None, fence.operation.clone(), coordinate, 60, &NoFaults),
            Err(ApplicationError::Conflict)
        ));
        let preparation = baseline_preparation(&f, fence.clone());
        assert!(matches!(prepare(&mut f, preparation, 2_000_000), Err(ApplicationError::Conflict)));
        // The relay's key at the generation before refuses; the key at the
        // fenced generation retires and releases.
        assert!(matches!(begin(&mut f, 10), Err(ApplicationError::Conflict)), "edited={edited}");
        f.binding.restore_fence_generation = 1;
        assert!(!begin(&mut f, 10).unwrap().released);
        host_document(&mut f, true, true);
        let Release::Released { replayed: false, boundary: Some(boundary) } = release_through(&mut f, 10).unwrap() else {
            panic!("released at the fenced generation");
        };
        assert_eq!(boundary, cancelled.endpoint);
        assert_eq!(released_generation(&f, "adoption"), (1, 10));
        assert_eq!(f.store.table_row_count("live_device_application_bindings").unwrap(), 0);
        let released = preserved(&f);
        assert_eq!((&released.0, released.1, &released.3), (&fenced.0, fenced.1, &fenced.3), "edited={edited}");
        // A replayed cancellation still answers its receipt after the
        // release.
        f.binding.restore_fence_generation = 0;
        assert_eq!(
            cancel_named(&mut f, "restore").unwrap(),
            RestoreFenceCancellationOutcome::FenceCancelled(Box::new(cancelled))
        );
    }
}

/// Opus 1 and 5: with no binding, a cancellation holds only the lineage and
/// generation the document proves. After a release that is the released
/// generation; a document never registered proves nothing. A cancellation
/// replayed after a later restore moved the document answers its own base
/// generation, with no binding for the relay to record.
#[test]
fn a_cancellation_without_a_binding_holds_only_the_proven_generation() {
    let mut f = Fixture::new();
    f.adopt().unwrap();
    // A cancellation before any fence, then another restore moves the
    // document to generation 1.
    let early = cancellation(&f, "early");
    assert_eq!(
        cancel(&mut f, &early).unwrap(),
        RestoreFenceCancellationOutcome::Cancelled { generation: 0, binding: Some(f.binding.clone()) }
    );
    fence_next(&mut f, "later").unwrap();
    cancel_fenced(&mut f, "later");
    // Every answer, a replay's too, commits a write, so its FULL commit
    // syncs before the reply.
    let durable = |f: &Fixture| -> i64 {
        f.store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT result_seq FROM engine_requests WHERE kind='restore-cancellation-durability'",
                    [],
                    |r| r.get(0),
                )
            })
            .unwrap()
    };
    let before = durable(&f);
    assert_eq!(
        cancel(&mut f, &early).unwrap(),
        RestoreFenceCancellationOutcome::Cancelled { generation: 0, binding: None },
        "a replay names its base, and no binding"
    );
    assert_ne!(durable(&f), before, "the replay wrote its marker");
    f.binding.restore_fence_generation = 1;
    host_document(&mut f, true, true);
    release_through(&mut f, 10).unwrap();
    // Released at 1: only a key from 1 to 2, for this lineage, holds.
    let next = cancellation(&f, "after-release");
    let mut ahead = next.clone();
    ahead.new_fence = 7;
    let mut behind = next.clone();
    behind.new_fence = 1;
    let mut lineage = next.clone();
    lineage.lineage_claim_id = "f".repeat(64);
    let mut never = next.clone();
    never.object_id = "never-registered".into();
    for wrong in [ahead, behind, lineage, never] {
        assert!(matches!(cancel(&mut f, &wrong), Err(ApplicationError::Conflict)), "{wrong:?}");
    }
    assert_eq!(f.store.table_row_count("live_restore_cancellations").unwrap(), 1);
    assert_eq!(
        cancel(&mut f, &next).unwrap(),
        RestoreFenceCancellationOutcome::Cancelled { generation: 1, binding: None }
    );
    let mut elsewhere = next;
    elsewhere.operation_id = "elsewhere".into();
    elsewhere.host_id = "elsewhere".into();
    assert!(matches!(cancel(&mut f, &elsewhere), Err(ApplicationError::Conflict)), "another host");
    assert_eq!(f.store.table_row_count("live_restore_cancellations").unwrap(), 2);
}

/// Sol's proof test 2: a successor captures and adopts from the predecessor
/// released at the cancelled generation, keeping the original lineage, the
/// exact prefix and the retained work, through consecutive cancellations.
/// A later genuine restore starts from the cancelled generations' real
/// endpoint, and its application crosses them to its own generation.
#[test]
fn a_successor_adopts_after_consecutive_cancellations_and_a_later_restore_applies() {
    let mut f = imported_fixture();
    let root = adopt_root(&mut f);
    let origin = root_adoption(&f);
    let history = rows(&f, &["live_accepted_updates", "live_accepted_checkpoints"]);
    let state = full_state(&f);
    let mut endpoint = None;
    for generation in 1..=2 {
        fence_next(&mut f, &format!("restore-{generation}")).unwrap();
        let cancelled = cancel_fenced(&mut f, &format!("restore-{generation}"));
        assert_eq!(cancelled.binding.restore_fence_generation, generation);
        assert!(endpoint.as_ref().is_none_or(|endpoint| *endpoint == cancelled.endpoint), "one endpoint");
        endpoint = Some(cancelled.endpoint.clone());
        f.binding.restore_fence_generation = generation;
        let boundary = release_parked(&mut f).expect("an adopted chain keeps its boundary");
        assert_eq!(boundary, cancelled.endpoint);
        returned(&mut f);
        let id = successor(&mut f);
        let ack = f.adopt().unwrap();
        assert!(!ack.adoption_replayed, "generation {generation}");
        assert_eq!(f.cut.retained_prefix.as_ref().unwrap().body(), cancelled.endpoint);
        assert_eq!(succession_row(&f, &id).0.as_deref(), Some(root.as_str()), "the original lineage origin");
        assert_eq!(root_adoption(&f), origin);
        assert_eq!(rows(&f, &["live_accepted_updates", "live_accepted_checkpoints"]), history);
        assert_eq!(full_state(&f), state);
        assert_eq!(binding_activation(&f), (Some(id), 1));
    }
    // The genuine restore fences from generation 2 at the endpoint the
    // cancellations kept, and its application crosses both.
    let fence = fence_next(&mut f, "genuine").unwrap();
    assert_eq!(fence.operation.terminal, endpoint.unwrap().terminal_receipt);
    let preparation = baseline_preparation(&f, fence);
    let proposal = prepare(&mut f, preparation.clone(), 2_000_000).unwrap();
    assert_eq!(proposal.receipt().accepted_history.event_count, 0);
    let input = restore_application(&f, preparation, &proposal, 21);
    apply_restore(&mut f, input).unwrap();
    let mut restored = f.binding.clone();
    restored.restore_fence_generation = 3;
    let held = Registration {
        workspace_id: "workspace".into(),
        namespace: "namespace".into(),
        coordinate: retirement_host(),
        binding: restored,
        activation_id: None,
        live: false,
    };
    f.store
        .read_with(|conn| {
            let read = accepted_history::read(conn, &held, 21, &mut restore_content::Budget { remaining: 2_000_000 }, 100)?;
            assert_eq!(read.proof.event_count, 1);
            assert_eq!(read.proof.checkpoint.restore_operation_id.as_deref(), Some("genuine"));
            accepted_history::read_state(conn, &held, 21, f.cut.reconstruction)?;
            Ok::<_, ApplicationError>(())
        })
        .unwrap();
    // A cancellation of the admitted restore refuses.
    f.binding.restore_fence_generation = 2;
    assert!(matches!(cancel_named(&mut f, "genuine"), Err(ApplicationError::Conflict)));
}

/// Sol's proof test 3, as far as the engine reaches: after a cancellation
/// and a successor, a collaborator's update at the new generation appends on
/// the normal event count and digest chain and checkpoints there. After a
/// restart both readers, settlement and publication read it back. A session
/// from the generation before refuses.
#[test]
fn a_live_update_after_a_cancelled_generation_continues_the_accepted_chain() {
    let mut f = imported_fixture();
    adopt_root(&mut f);
    fence_next(&mut f, "restore").unwrap();
    let cancelled = cancel_fenced(&mut f, "restore");
    let stale = f.binding.clone();
    f.binding.restore_fence_generation = 1;
    release_parked(&mut f);
    returned(&mut f);
    successor(&mut f);
    f.adopt().unwrap();
    // The update carries checkpoint coverage, so it checkpoints at its count.
    let mut event = remote_event(&mut f, 11);
    event.metadata.checkpoint_coverage = Some(vec![]);
    let metadata = event.metadata.clone();
    let terminal = metadata.accepted.receipt.clone();
    apply_event(&mut f, event).unwrap();
    let evidence = accepted_history::next_digest(&cancelled.endpoint.history_evidence_digest, 1, &metadata).unwrap();
    let saved: (i64, String) = f
        .store
        .read_with(|conn| conn.query_row("SELECT event_count,evidence_digest FROM live_accepted_updates WHERE journal_cursor=11", [], |r| Ok((r.get(0)?, r.get(1)?))))
        .unwrap();
    assert_eq!(saved, (1, evidence.clone()));
    let checkpoint: (i64, String) = f
        .store
        .read_with(|conn| conn.query_row("SELECT event_count,evidence_digest FROM live_accepted_checkpoints WHERE journal_cursor=11", [], |r| Ok((r.get(0)?, r.get(1)?))))
        .unwrap();
    assert_eq!(checkpoint, (1, evidence.clone()));
    let coordinate = f.handle.registration.lock().unwrap().coordinate.clone();
    reopen_store(&mut f);
    let activation = binding_activation(&f).0.expect("the successor's activation");
    f.handle = f
        ._owner
        .register_activation(&mut f.store, "namespace".into(), coordinate, f.binding.clone(), activation)
        .unwrap();
    let held = Registration {
        workspace_id: "workspace".into(),
        namespace: "namespace".into(),
        coordinate: retirement_host(),
        binding: f.binding.clone(),
        activation_id: None,
        live: false,
    };
    f.store
        .read_with(|conn| {
            let read = accepted_history::read(conn, &held, 11, &mut restore_content::Budget { remaining: 2_000_000 }, 100)?;
            assert_eq!((read.proof.event_count, read.proof.evidence_digest.as_str()), (1, evidence.as_str()));
            assert_eq!(read.proof.checkpoint.event_count, 1, "read from its own checkpoint");
            accepted_history::read_state(conn, &held, 11, f.cut.reconstruction)?;
            Ok::<_, ApplicationError>(())
        })
        .unwrap();
    let settled = settle_as(&mut f, Some(terminal), "after-cancellation").unwrap();
    assert_eq!(settled.terminal_cursor, 11);
    assert!(moment_text(&f, "after-cancellation").contains("Remote paragraph 11"));
    f.store
        .read_with(|conn| {
            let (binding, namespace, doc) = publication::read_native_accepted_in(conn, &f.key, &mut 2_000_000)?.expect("a native accepted state");
            assert_eq!((&binding, namespace.as_str()), (&f.binding, "namespace"));
            assert!(doc.project(ContentKind::Richdoc)?.content.contains("Remote paragraph 11"));
            publication::require_restore_registration_in(conn, &f.key, "namespace", &f.binding, &mut 2_000_000)
        })
        .unwrap();
    // A session that captured the generation before the cancellation.
    let current = std::mem::replace(&mut f.binding, stale);
    let old = remote_event(&mut f, 12);
    f.binding = current;
    let refused = apply_event(&mut f, old);
    assert!(!matches!(refused, Ok(ApplicationResult::Applied(..))), "an old session's update refuses: {refused:?}");
    assert_eq!(f.store.table_row_count("live_accepted_updates").unwrap(), 1);
}

/// Sol's test 5 and Opus 6: a cancellation proof that is missing or altered
/// refuses each reader that crosses it, a restore already resumed refuses
/// cancellation, and a fence that only prepared cancels and drops its
/// proposal. A preparation past its limits fails; its cancellation does not.
#[test]
fn cancellation_proofs_refuse_when_missing_or_altered() {
    let setup = || {
        let mut f = imported_fixture();
        adopt_root(&mut f);
        fence_next(&mut f, "restore").unwrap();
        cancel_fenced(&mut f, "restore");
        f.binding.restore_fence_generation = 1;
        release_parked(&mut f);
        returned(&mut f);
        successor(&mut f);
        f.adopt().unwrap();
        f
    };
    for (case, sql) in [
        ("missing", "UPDATE live_restore_fences SET cancelled_json=NULL"),
        ("altered endpoint", "UPDATE live_restore_fences SET cancelled_json=json_set(cancelled_json,'$.endpoint.historyEvidenceDigest','ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff')"),
        ("altered binding", "UPDATE live_restore_fences SET cancelled_json=json_set(cancelled_json,'$.binding.restoreFenceGeneration',2)"),
        ("altered fence", "UPDATE live_restore_fences SET cancelled_json=json_set(cancelled_json,'$.fence.operation.newFence',2)"),
    ] {
        let mut f = setup();
        write(&mut f, sql);
        let event = remote_event(&mut f, 11);
        let refused = apply_event(&mut f, event);
        assert!(!matches!(refused, Ok(ApplicationResult::Applied(..))), "{case}: {refused:?}");
        assert_eq!(f.store.table_row_count("live_accepted_updates").unwrap(), 0, "{case}");
    }
    // A restore resumed before the cancellation arrives refuses it.
    let mut f = Fixture::new();
    f.adopt().unwrap();
    let prep = native_tail_input(&mut f, None, 0);
    let proposal = native_tail_prepare(&mut f, prep.clone()).unwrap();
    let input = restore_application(&f, prep, &proposal, 71);
    apply_restore(&mut f, input.clone()).unwrap();
    let coordinate = f.handle.registration.lock().unwrap().coordinate.clone();
    let settlement = f
        ._owner
        .with_restore_settlement(&mut f.store, None, input.clone(), coordinate.clone(), 2_000_000, 100, |store, audit| {
            restore_content::tests::record_test_projection(store, audit, "resumed-owner")
        })
        .unwrap();
    f._owner
        .resume_restore(
            &mut f.store,
            None,
            NativeRestoreResume { application: input, settlement_id: settlement.settlement_id },
            coordinate,
            2_000_000,
            100,
            100,
            &NoFaults,
            |_, _, _, _| Ok(()),
        )
        .unwrap();
    assert!(matches!(cancel_named(&mut f, "tail-restore"), Err(ApplicationError::Conflict)), "resumed");
    // A fence that only prepared cancels; its proposal goes, and neither a
    // replayed preparation nor an application revives it.
    let mut f = Fixture::new();
    f.adopt().unwrap();
    let prep = native_tail_input(&mut f, None, 0);
    let proposal = native_tail_prepare(&mut f, prep.clone()).unwrap();
    let blobs: [String; 3] = f
        .store
        .read_with(|conn| {
            conn.query_row(
                "SELECT proposal_candidate_sha256,proposal_frozen_sha256,proposal_point_sha256 FROM live_restore_fences",
                [],
                |r| Ok([r.get(0)?, r.get(1)?, r.get(2)?]),
            )
        })
        .unwrap();
    let cancelled = cancel_fenced(&mut f, "tail-restore");
    assert_eq!(cancelled.fence, prep.fence);
    let kept: bool = f
        .store
        .read_with(|conn| conn.query_row("SELECT proposal_json IS NOT NULL FROM live_restore_fences", [], |r| r.get(0)))
        .unwrap();
    assert!(!kept, "a cancelled row holds no proposal");
    // Each proposal blob nothing else holds goes in the same commit. Here the
    // frozen and point states are the lineage's baseline, which its claim
    // holds.
    assert_eq!([&blobs[1], &blobs[2]], [&f.binding.lineage_claim_id; 2]);
    let left: Vec<String> = f
        .store
        .read_with(|conn| {
            conn.prepare("SELECT sha256 FROM binary_blobs WHERE sha256 IN (?1,?2,?3)")?
                .query_map(rusqlite::params![blobs[0], blobs[1], blobs[2]], |r| r.get(0))?
                .collect::<Result<_, _>>()
        })
        .unwrap();
    assert_eq!(left, [f.binding.lineage_claim_id.clone()], "{blobs:?}");
    assert!(matches!(native_tail_prepare(&mut f, prep.clone()), Err(ApplicationError::Conflict)));
    let input = restore_application(&f, prep, &proposal, 71);
    assert!(apply_restore(&mut f, input).is_err());
    assert_eq!(f.store.table_row_count("live_device_update_applications").unwrap(), 0);
    // Limits that fail the restore's preparation never block its
    // cancellation.
    let mut f = Fixture::new();
    f.edit(true);
    f.adopt().unwrap();
    let fence = fence_next(&mut f, "restore").unwrap();
    let preparation = baseline_preparation(&f, fence);
    assert!(prepare(&mut f, preparation, 64).is_err(), "the preparation exceeds its limits");
    cancel_fenced(&mut f, "restore");
}

/// Sol 1: a restore completes and resumes at generation 1, then one or two
/// restores fence and cancel. The lineage registers at the last generation,
/// accepts an update and settles from the completed restore's settlement,
/// crossing only the cancellations after it.
#[test]
fn a_settlement_after_a_completed_restore_crosses_the_cancellations_after_it() {
    for cancellations in 1..=2 {
        let mut f = Fixture::new();
        f.adopt().unwrap();
        let prep = native_tail_input(&mut f, None, 0);
        let proposal = native_tail_prepare(&mut f, prep.clone()).unwrap();
        let input = restore_application(&f, prep, &proposal, 71);
        let input_receipt = input.admitted.accepted.receipt.clone();
        apply_restore(&mut f, input.clone()).unwrap();
        let coordinate = f.handle.registration.lock().unwrap().coordinate.clone();
        let restored = f
            ._owner
            .with_restore_settlement(&mut f.store, None, input.clone(), coordinate.clone(), 2_000_000, 100, |store, audit| {
                restore_content::tests::record_test_projection(store, audit, "resumed-owner")
            })
            .unwrap();
        f._owner
            .resume_restore(
                &mut f.store,
                None,
                NativeRestoreResume { application: input, settlement_id: restored.settlement_id.clone() },
                coordinate.clone(),
                2_000_000,
                100,
                100,
                &NoFaults,
                |_, _, _, _| Ok(()),
            )
            .unwrap();
        f.binding.restore_fence_generation = 1;
        f.doc = f.store.read_with(|conn| durable::load_doc_in(conn, &f.key)).unwrap();
        f.handle = f._owner.register(&mut f.store, "namespace".into(), coordinate.clone(), f.binding.clone()).unwrap();
        for _ in 0..cancellations {
            let operation = format!("cancelled-{}", f.binding.restore_fence_generation + 1);
            fence_next(&mut f, &operation).unwrap();
            cancel_fenced(&mut f, &operation);
            f.binding.restore_fence_generation += 1;
            f.handle = f._owner.register(&mut f.store, "namespace".into(), coordinate.clone(), f.binding.clone()).unwrap();
        }
        // Before any update, a settlement at the restore's terminal replays
        // the restore's own settlement.
        let saved: (String, String, String) = f
            .store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT moment_id,markdown_digest,source_state_vector_digest FROM live_device_settlements WHERE settlement_id=?1",
                    [&restored.settlement_id],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
            })
            .unwrap();
        let replayed = with_settlement(
            &mut f.store,
            &f.handle,
            Some(input_receipt.clone()),
            128,
            NativeHistoryReconstruction { working_reserve_bytes: 8 * 1024 * 1024 },
            |store, audit| {
                let outcome = store.write_with(&NoFaults, |tx| audit.record_in_tx(tx, &saved.0, &saved.1, &saved.2, 30))?;
                let TxnOutcome::Committed(id) = outcome else {
                    return Err(ApplicationError::Interrupted);
                };
                Ok::<_, ApplicationError>(id)
            },
        )
        .unwrap();
        assert_eq!(replayed, restored.settlement_id, "{cancellations}: the restore's own settlement");
        let event = remote_event(&mut f, 80);
        let terminal = event.metadata.accepted.receipt.clone();
        assert!(matches!(apply_event(&mut f, event).unwrap(), ApplicationResult::Applied(..)));
        let settled = settle_as(&mut f, Some(terminal), "after-cancellations").unwrap();
        assert_eq!(
            (settled.previous_cursor, settled.terminal_cursor, settled.application_count),
            (71, 80, 1),
            "{cancellations}: from the completed restore"
        );
        assert!(moment_text(&f, "after-cancellations").contains("Remote paragraph 80"));
        // The completed restore keeps its own binding and identity.
        let kept: (String, i64) = f
            .store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT settlement_kind,json_extract(binding_json,'$.restoreFenceGeneration') FROM live_device_settlements WHERE settlement_id=?1",
                    [&restored.settlement_id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
            })
            .unwrap();
        assert_eq!(kept, ("restore".to_owned(), 1));
    }
}

/// Sol 2: every reader binds a cancellation to the fence row it ends and to
/// the accepted history at its endpoint. One that names another host, origin
/// or native head than its fence, or an endpoint the lineage never held,
/// refuses retirement, adoption and both history readers.
#[test]
fn a_cancellation_its_fence_row_disagrees_with_refuses_every_reader() {
    let alterations = [
        ("host", "json_set(cancelled_json,'$.fence.operation.hostId','elsewhere')".to_owned()),
        ("origin", "json_set(cancelled_json,'$.fence.operation.origin.id','elsewhere')".to_owned()),
        ("head", "json_set(cancelled_json,'$.fence.localHeadSequence',json_extract(cancelled_json,'$.fence.localHeadSequence')+1)".to_owned()),
        ("endpoint", format!("json_set(cancelled_json,'$.endpoint.historyEvidenceDigest','{}')", "f".repeat(64))),
    ];
    let cancelled = || {
        let mut f = imported_fixture();
        adopt_root(&mut f);
        fence_next(&mut f, "restore").unwrap();
        cancel_fenced(&mut f, "restore");
        f.binding.restore_fence_generation = 1;
        f
    };
    for (case, altered) in &alterations {
        let alter = |f: &mut Fixture| write(f, &format!("UPDATE live_restore_fences SET cancelled_json={altered}"));
        // Retirement at the fenced generation.
        let mut f = cancelled();
        alter(&mut f);
        let retired = match begin(&mut f, 10) {
            Ok(_) => {
                host_document(&mut f, true, true);
                release_through(&mut f, 10).map(|_| ())
            }
            Err(error) => Err(error),
        };
        assert!(retired.is_err(), "{case}: retirement");
        // A successor's adoption across the cancelled generation.
        let mut f = cancelled();
        release_parked(&mut f);
        returned(&mut f);
        successor(&mut f);
        alter(&mut f);
        assert!(f.adopt().is_err(), "{case}: adoption");
        // Both history readers, for the first event after it.
        let mut f = cancelled();
        release_parked(&mut f);
        returned(&mut f);
        successor(&mut f);
        f.adopt().unwrap();
        let event = remote_event(&mut f, 11);
        apply_event(&mut f, event).unwrap();
        alter(&mut f);
        let held = Registration {
            workspace_id: "workspace".into(),
            namespace: "namespace".into(),
            coordinate: retirement_host(),
            binding: f.binding.clone(),
            activation_id: None,
            live: false,
        };
        f.store
            .read_with(|conn| {
                let budget = &mut restore_content::Budget { remaining: 2_000_000 };
                assert!(accepted_history::read(conn, &held, 11, budget, 100).is_err(), "{case}: history");
                assert!(accepted_history::read_state(conn, &held, 11, f.cut.reconstruction).is_err(), "{case}: state");
                Ok::<_, ApplicationError>(())
            })
            .unwrap();
    }
}

/// A cancellation's endpoint receipt is read from the leading bytes of its
/// event's metadata, so a long metadata tail does not change the answer, and
/// a receipt that differs there refuses every generation read.
#[test]
fn a_cancellation_endpoint_receipt_is_read_exactly_from_its_metadata_head() {
    let mut f = imported_fixture();
    adopt_root(&mut f);
    let event = remote_event(&mut f, 11);
    apply_event(&mut f, event).unwrap();
    fence_next(&mut f, "restore").unwrap();
    cancel_fenced(&mut f, "restore");
    f.binding.restore_fence_generation = 1;
    let reads = |f: &Fixture| {
        f.store.read_with(|conn| {
            super::super::restore_fence::require_registration(conn, &f.key, "namespace", &f.binding)?;
            assert_eq!(super::super::restore_fence::resumed_binding(conn, &f.key)?, Some(f.binding.clone()));
            Ok::<_, ApplicationError>(())
        })
    };
    for (case, sql) in [
        ("padded", "UPDATE live_accepted_updates SET metadata_json=substr(metadata_json,1,length(metadata_json)-1)||printf('%600000s','')||'}'"),
        ("epoch", "UPDATE live_accepted_updates SET metadata_json=json_set(metadata_json,'$.accepted.receipt.acceptingHostEpoch',2)"),
    ] {
        write(&mut f, sql);
        match case {
            "padded" => reads(&f).unwrap(),
            _ => assert!(reads(&f).is_err(), "{case}"),
        }
    }
}

/// Sol 4 and Opus 5: a fence that would leave its lineage a cancelled chain longer
/// than an event can cross refuses at admission. The chain counts from the
/// generation of the lineage's accepted tip.
#[test]
fn a_fence_past_the_readable_cancelled_chain_refuses() {
    let mut f = imported_fixture();
    adopt_root(&mut f);
    fence_next(&mut f, "restore").unwrap();
    cancel_fenced(&mut f, "restore");
    let mut b = f.binding.clone();
    b.restore_fence_generation = 1;
    let limit = accepted_history::CHECKPOINT_EVENTS;
    f.store
        .read_with(|conn| {
            super::super::restore_fence::require_chain_room(conn, "namespace", &b, limit)?;
            assert!(matches!(
                super::super::restore_fence::require_chain_room(conn, "namespace", &b, limit + 1),
                Err(ApplicationError::Conflict)
            ));
            Ok::<_, ApplicationError>(())
        })
        .unwrap();
}

/// Opus 4: with no binding, a released lineage proves only the generation
/// it released at. A later settled restore of another lineage of the
/// document moves the document, not this lineage.
#[test]
fn a_released_lineage_proves_its_own_generation_after_another_lineage_restores() {
    let mut f = imported_fixture();
    adopt_root(&mut f);
    fence_next(&mut f, "restore").unwrap();
    cancel_fenced(&mut f, "restore");
    f.binding.restore_fence_generation = 1;
    release_parked(&mut f);
    // Another lineage of the document fenced from 4 to 5 and cancelled
    // there, at the origin this lineage's history starts from.
    let ours = f.binding.lineage_claim_id.clone();
    let other = "e".repeat(64);
    let relineaged = |column: &str, path: &str| {
        format!(
            "json_set(replace({column},'{ours}','{other}'),'{path}oldBinding.restoreFenceGeneration',4,'{path}newFence',5,'{path}operationId','other')"
        )
    };
    write(
        &mut f,
        &format!(
            "INSERT INTO live_accepted_checkpoints(relay_database_namespace,workspace_id,main_version_id,object_id,lineage_claim_id,
                event_count,journal_cursor,terminal_json,binding_json,origin_stamp,state_sha256,evidence_digest)
             SELECT relay_database_namespace,workspace_id,main_version_id,object_id,'{other}',event_count,journal_cursor,
                terminal_json,replace(binding_json,'{ours}','{other}'),origin_stamp,state_sha256,evidence_digest
             FROM live_accepted_checkpoints WHERE event_count=0;
             INSERT INTO live_restore_fences(workspace_id,main_version_id,object_id,relay_database_namespace,operation_id,
                input_json,receipt_json,cancelled_json)
             SELECT workspace_id,main_version_id,object_id,relay_database_namespace,'other',{},{},
                json_set({},'$.binding.restoreFenceGeneration',5)
             FROM live_restore_fences WHERE operation_id='restore'",
            relineaged("input_json", "$."),
            relineaged("receipt_json", "$.operation."),
            relineaged("cancelled_json", "$.fence.operation."),
        ),
    );
    assert_eq!(
        f.store.read_with(|conn| super::super::restore_fence::current_generation(conn, &f.key)).unwrap(),
        Some(5),
        "the other lineage settled at 5"
    );
    // A key from 5 is the other lineage's generation, not this one's.
    let mut beyond = cancellation(&f, "beyond");
    beyond.new_fence = 6;
    assert!(matches!(cancel(&mut f, &beyond), Err(ApplicationError::Conflict)));
    assert_eq!(f.store.table_row_count("live_restore_cancellations").unwrap(), 0);
}

/// Sol 5 and Opus 6: a fence's answer, and a replay's, is durable before it is sent;
/// a replay, which changes nothing, commits its marker.
#[test]
fn a_replayed_fence_commits_a_durable_answer() {
    let mut f = Fixture::new();
    f.adopt().unwrap();
    let fence = fence_next(&mut f, "restore").unwrap();
    let marker = |f: &Fixture| -> Option<i64> {
        f.store
            .read_with(|conn| {
                conn.query_row("SELECT result_seq FROM engine_requests WHERE kind='restore-fence-durability'", [], |r| r.get(0))
                    .optional()
            })
            .unwrap()
    };
    let before = marker(&f);
    let coordinate = f.handle.registration.lock().unwrap().coordinate.clone();
    let replayed = f._owner.fence_restore(&mut f.store, None, fence.operation.clone(), coordinate, 41, &NoFaults).unwrap();
    assert_eq!(replayed, fence);
    assert!(marker(&f).is_some() && marker(&f) != before, "the replay wrote its marker");
}
