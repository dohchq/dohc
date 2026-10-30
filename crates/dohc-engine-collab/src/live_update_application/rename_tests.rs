/// The document renamed to `to` while no activation holds it, through the
/// domain's rename: its alias, snapshot and a rename moment move together,
/// and its lineage follows to the new path in the same transaction, keeping
/// its claim, as the engine's fold of an unchanged resulting head does. The
/// fixture's binding follows it.
fn rename(f: &mut Fixture, to: &str, moment: &str) {
    let input = dohc_engine_domain::RenameTextFile {
        workspace_id: "workspace".into(),
        version_id: "main".into(),
        from_path: f.binding.current_path.clone(),
        to_path: to.into(),
        moment_id: moment.into(),
        request_id: None,
        metadata_origin: "user".into(),
        metadata_summary: None,
        metadata_correlation_id: None,
        author_json: None,
        now_ms: 50,
    };
    VersionedTextStore::new(&mut f.store)
        .rename_text_file_with(&input, &NoFaults, |tx, _| {
            tx.execute("UPDATE ydoc_docs SET path=?1 WHERE workspace_id='workspace' AND version_id='main' AND object_id='object'", [to])
                .map_err(dohc_engine_storage::StorageError::persist_public)?;
            Ok(())
        })
        .unwrap();
    f.binding.current_path = to.into();
    f.binding.selector_paths = vec![to.into()];
}

/// Where the entry for `delivery` sits: its outbox and sequence, and the
/// journal cursor of the receipt it saved.
fn entry_of(f: &Fixture, delivery: &str) -> (String, i64, Option<i64>) {
    f.store
        .read_with(|conn| {
            conn.query_row(
                "SELECT outbox_id,sequence,json_extract(accepted_receipt_json,'$.journalCursor')
                 FROM owner_ydoc_outbox_entries WHERE delivery_id=?1",
                [delivery],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
        })
        .unwrap()
}

/// Sol's round 4b ruling, rename: P carried C1 and C2 when it released, and
/// a person renamed the document before S captured it at its new path. S's
/// coverage takes P's outbox at the old path, which the rename proves, and
/// names each entry by its original outbox and sequence. S's seed opens the
/// outbox at its own binding, whose high-water mark the coverage keeps. C1
/// and C2 stay where P queued them, with their receipts, and still resolve.
#[test]
fn a_successor_covers_its_predecessors_outbox_across_a_rename() {
    let (mut f, covered, c1, c2) = released_carrying_twice(6);
    let original = outbox_at(&f, "owner.md");
    rename(&mut f, "notes/renamed.md", "renamed");
    let id = successor(&mut f);
    f.adopt().unwrap();
    let coverage = vec![
        (original.clone(), 1, Disposition::Receipt { receipt: covered }),
        (original.clone(), 2, Disposition::Receipt { receipt: c1.receipt.clone() }),
        (original.clone(), 3, Disposition::Receipt { receipt: c2.receipt.clone() }),
    ];
    assert_eq!(succession_row(&f, &id).4, outboxes_digest(&coverage));
    assert_eq!(covered_sequence(&f, &id), 0);
    let renamed = outbox_at(&f, "notes/renamed.md");
    assert_ne!(renamed, original);
    assert_eq!(seeds(&f), [(id, 1)]);
    assert_eq!(entry_of(&f, &pending_seed_delivery(&f)), (renamed, 1, None));
    for (sequence, carried) in [(2, &c1), (3, &c2)] {
        assert_eq!(
            entry_of(&f, &carried.receipt.delivery_id),
            (original.clone(), sequence, Some(carried.receipt.journal_cursor))
        );
    }
    assert_eq!(resolve(&f, "adoption").unwrap(), 2);
}

/// P at owner.md, with its update covered at 3 and C1 Carried at 5, releases,
/// and the document is renamed to first.md. S1 adopts there; the relay
/// accepts its seed at 7 and its own update C2 at 8, and it releases before
/// applying any of them. The document is renamed to second.md and S2
/// registers there. Returns S2's expected coverage, ordered by outbox and
/// sequence.
fn carried_across_two_renames() -> (Fixture, Vec<(String, i64, Disposition)>) {
    carried_across_renames_to("second.md")
}

/// [`carried_across_two_renames`], with the second rename to `second`.
fn carried_across_renames_to(second: &str) -> (Fixture, Vec<(String, i64, Disposition)>) {
    let (mut f, covered, c1, _) = covered_and_carried();
    host_document(&mut f, true, true);
    retirement_settle(&mut f, 10, Some(covered.clone())).unwrap();
    release_parked(&mut f);
    let c1 = carried_delivery(&f, &c1);
    write(&mut f, "DELETE FROM ydoc_deferred_updates");
    importable(&mut f);
    returned(&mut f);
    file_matches_local(&mut f, "returned");
    let original = outbox_at(&f, "owner.md");
    rename(&mut f, "first.md", "first-renamed");
    let first = successor(&mut f);
    f.adopt().unwrap();
    let seed = accept_seed(&mut f, 7);
    let seed = carried_delivery(&f, &seed);
    let edit = native_tail_edit(&mut f, "# Carried again\n", 13);
    let c2 = receipt_of(&edit.delivery_id, &edit.update_digest, 8);
    acknowledge_entry(&mut f, &c2);
    let c2 = carried_delivery(&f, &c2);
    release_parked(&mut f);
    assert_eq!(manifest(&f, &first), vec![c1.clone(), seed.clone(), c2.clone()]);
    returned(&mut f);
    file_matches_local(&mut f, "first-released");
    let earlier = outbox_at(&f, "first.md");
    rename(&mut f, second, "second-renamed");
    successor(&mut f);
    let mut coverage = vec![
        (original.clone(), 1, Disposition::Receipt { receipt: covered }),
        (original, 2, Disposition::Receipt { receipt: c1.receipt }),
        (earlier.clone(), 1, Disposition::Receipt { receipt: seed.receipt }),
        (earlier, 2, Disposition::Receipt { receipt: c2.receipt }),
    ];
    coverage.sort_by(|a, b| (&a.0, a.1).cmp(&(&b.0, b.1)));
    (f, coverage)
}

/// A successor of a successor covers outboxes at two earlier bindings: S2
/// takes P's outbox at owner.md and S1's at first.md, both proved by the
/// renames, with each entry under its original outbox, sequence and receipt.
#[test]
fn a_second_successor_covers_outboxes_at_two_earlier_paths() {
    let (mut f, coverage) = carried_across_two_renames();
    let id = f.cut.adoption_id.clone();
    f.adopt().unwrap();
    assert_eq!(succession_row(&f, &id).4, outboxes_digest(&coverage));
    assert_eq!(covered_sequence(&f, &id), 0);
    assert_eq!(entry_of(&f, &pending_seed_delivery(&f)), (outbox_at(&f, "second.md"), 1, None));
    for (outbox, sequence, disposition) in &coverage {
        let Disposition::Receipt { receipt } = disposition else { panic!("receipts") };
        assert_eq!(entry_of(&f, &receipt.delivery_id), (outbox.clone(), *sequence, Some(receipt.journal_cursor)));
    }
}

/// The same retained outboxes give the same coverage, whatever order they
/// are named in, and the adoption stores its digest.
#[test]
fn coverage_does_not_depend_on_the_order_outboxes_are_named() {
    let (mut f, coverage) = carried_across_two_renames();
    let prefix = f.cut.retained_prefix.clone().unwrap();
    let mut outboxes: Vec<String> = coverage.iter().map(|(outbox, ..)| outbox.clone()).collect();
    outboxes.dedup();
    assert_eq!(outboxes.len(), 2);
    let covered = |f: &Fixture, outboxes: &[String]| {
        f.store
            .read_with(|conn| {
                let (lineage, tail) = (&f.binding.lineage_claim_id, &prefix.predecessor_activation_id);
                let chain = chain_bindings(conn, "namespace", &f.key, lineage, tail, 100)?.activations;
                let carried = retirement::inherited_in_chain(conn, "namespace", &f.key, lineage, tail, &chain)?;
                retirement::retained_coverage(conn, "namespace", &f.key, lineage, outboxes, &prefix, &carried, &chain, 100)
            })
            .unwrap()
    };
    let forward = covered(&f, &outboxes);
    outboxes.reverse();
    assert_eq!(covered(&f, &outboxes), forward);
    assert_eq!(forward, coverage);
    let id = f.cut.adoption_id.clone();
    f.adopt().unwrap();
    assert_eq!(succession_row(&f, &id).4, outboxes_digest(&forward));
}

/// One budget bounds coverage across every outbox: S2's four entries, two in
/// each outbox, refuse it at three, with no writes, though either outbox
/// alone fits. At four it adopts.
#[test]
fn coverage_across_outboxes_has_one_budget() {
    let (mut f, coverage) = carried_across_two_renames();
    assert_eq!(coverage.len(), 4);
    let adopt = |f: &mut Fixture, max_events| {
        adopt_owner_committed(&mut f.store, &f.handle, f.cut.clone(), 1_000_000, max_events, 10, &NoFaults, None, |_, _, _, _| Ok(()))
    };
    let before = rows(&f, &SUCCESSION_WRITES);
    let refused = adopt(&mut f, 3);
    assert!(
        matches!(refused, Err(ApplicationError::InvalidInput("owner adoption retained outbox coverage exceeds its budget"))),
        "{refused:?}"
    );
    assert_eq!(rows(&f, &SUCCESSION_WRITES), before);
    adopt(&mut f, 4).unwrap();
}

/// A damage to the evidence that the successor's coverage relies on, given
/// C2's Carried delivery.
type CoverageDamage = (&'static str, fn(&mut Fixture, &CarriedDelivery));

/// Only a binding the chain held, which a rename proves, is coverage. Each
/// refuses S's adoption at the renamed path with no writes:
/// - an outbox no activation of the chain held, at a path the document never
///   had, though it holds C2 whole;
/// - an arbitrary historical binding: P's binding and outbox at such a path;
/// - a forged rename: the moment at the new path is a write, names another
///   source path, or changed the text.
#[test]
fn coverage_refuses_unproved_bindings_without_writes() {
    let damages: [CoverageDamage; 5] = [
        ("an unrelated outbox", |f, c2| {
            write(f, &format!(
                "CREATE TEMP TABLE moved AS SELECT * FROM owner_ydoc_outboxes;
                 UPDATE moved SET outbox_id='moved',current_path='elsewhere.md',selector_paths_json='[\"elsewhere.md\"]',next_sequence=2;
                 INSERT INTO owner_ydoc_outboxes SELECT * FROM moved;
                 DROP TABLE moved;
                 UPDATE owner_ydoc_outbox_entries SET outbox_id='moved',sequence=1 WHERE delivery_id='{}'",
                c2.receipt.delivery_id
            ));
        }),
        ("an arbitrary historical binding", |f, _| write(f,
            "UPDATE live_owner_activations SET binding_json=json_set(binding_json,'$.currentPath','elsewhere.md',
               '$.selectorPaths',json_array('elsewhere.md')) WHERE activation_id='adoption';
             UPDATE owner_ydoc_outboxes SET current_path='elsewhere.md',selector_paths_json='[\"elsewhere.md\"]'
               WHERE current_path='owner.md'",
        )),
        ("a write, not a rename", |f, _| write(f, "UPDATE moments SET operation='write' WHERE moment_id='renamed'")),
        ("a rename from another path", |f, _| write(f,
            "UPDATE moments SET payload_before_path='elsewhere.md' WHERE moment_id='renamed'",
        )),
        ("a rename that changed the text", |f, _| write(f,
            "UPDATE moments SET before_blob_sha256=(SELECT after_blob_sha256 FROM moments WHERE moment_id='original')
             WHERE moment_id='renamed'",
        )),
    ];
    for (case, damage) in damages {
        let (mut f, _, _, c2) = released_carrying_twice(6);
        rename(&mut f, "notes/renamed.md", "renamed");
        successor(&mut f);
        damage(&mut f, &c2);
        let before = rows(&f, &SUCCESSION_WRITES);
        let adopted = f.adopt();
        assert!(matches!(adopted, Err(ApplicationError::Conflict)), "{case}: {adopted:?}");
        assert_eq!(rows(&f, &SUCCESSION_WRITES), before, "{case}");
    }
}

/// P applies a collaborator's update at 3, settles there and releases with
/// nothing Carried, and S registers at the same binding.
fn released_with_nothing_carried() -> Fixture {
    let mut f = released_unregistered();
    successor(&mut f);
    f
}

/// [`released_with_nothing_carried`] before S captures. P never queued
/// anything, so it left no outbox.
fn released_unregistered() -> Fixture {
    let mut f = Fixture::new();
    f.adopt().unwrap();
    let remote = remote_event(&mut f, 3);
    let terminal = remote.metadata.accepted.receipt.clone();
    applies(&mut f, remote);
    host_document(&mut f, true, true);
    retirement_settle(&mut f, 10, Some(terminal)).unwrap();
    release_parked(&mut f);
    importable(&mut f);
    returned(&mut f);
    f
}

/// The adoption half of a restore after release: a binding the chain held at
/// another restore generation counts only when resumed restores led from it
/// to the registration's. Claimed with none, it refuses S's adoption with no
/// writes, though nothing is Carried; unchanged, S adopts.
#[test]
fn another_restore_generation_needs_its_restore() {
    let mut f = released_with_nothing_carried();
    f.adopt().unwrap();
    let mut f = released_with_nothing_carried();
    write(&mut f, "UPDATE live_owner_activations SET binding_json=json_set(binding_json,'$.restoreFenceGeneration',1)
        WHERE activation_id='adoption'");
    let before = rows(&f, &SUCCESSION_WRITES);
    let adopted = f.adopt();
    assert!(matches!(adopted, Err(ApplicationError::Conflict)), "{adopted:?}");
    assert_eq!(rows(&f, &SUCCESSION_WRITES), before);
}

/// Whether the registration's coverage proves `binding` a binding this
/// document held before it.
fn proves(f: &Fixture, binding: &LiveObjectBinding) -> Result<(), ApplicationError> {
    let held = f.handle.registration.lock().unwrap();
    f.store.read_with(|conn| require_historical(conn, &held, &f.key, &[binding], 100))
}

/// A real restore proves the generation it fenced. P adopts at generation 0;
/// a restore fences it and resumes it at 1. Registered at 1, the coverage
/// proves P's binding at 0, and no other: neither a generation no restore
/// led from, nor P's binding at a path the document never had.
#[test]
fn a_resumed_restore_proves_the_generation_it_fenced() {
    let (f, original) = resumed_at_one();
    proves(&f, &original).unwrap();
    let mut unrestored = original.clone();
    unrestored.restore_fence_generation = 5;
    assert!(matches!(proves(&f, &unrestored), Err(ApplicationError::Conflict)));
    let mut elsewhere = original;
    elsewhere.current_path = "elsewhere.md".into();
    elsewhere.selector_paths = vec!["elsewhere.md".into()];
    assert!(matches!(proves(&f, &elsewhere), Err(ApplicationError::Conflict)));
}

/// P adopts at generation 0, and a real restore fences it and resumes it at
/// 1, where the fixture registers. Returns P's binding.
fn resumed_at_one() -> (Fixture, LiveObjectBinding) {
    let mut f = Fixture::new();
    f.adopt().unwrap();
    let original = f.binding.clone();
    native_tail_edit(&mut f, "Unaccepted owner edit", 11);
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
                authority: ServerDerivedLiveUpdateAuthority::Owner { principal_id: "restoring-owner".into() },
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
        .apply_restore(&mut f.store, None, &mut WriterDocCache::new(), input.clone(), coordinate.clone(), 2_000_000, 100, 90, &NoFaults, |_, _, _, _| Ok(()))
        .unwrap();
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
            NativeRestoreResume { application: input, settlement_id: settlement.settlement_id.unwrap() },
            coordinate.clone(),
            2_000_000,
            100,
            100,
            &NoFaults,
            |_, _, _, _| Ok(()),
        )
        .unwrap();
    f.binding = binding.clone();
    f.handle = f._owner.register(&mut f.store, "namespace".into(), coordinate, binding).unwrap();
    (f, original)
}
