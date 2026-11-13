/// The synced update each protection decision here is made for.
fn incoming() -> IncomingCoordinate {
    IncomingCoordinate {
        relay_namespace: Some("namespace".into()),
        replication_epoch: "epoch".into(),
        stream_identity: "stream".into(),
        origin_id: "desktop".into(),
        origin_seq: 4,
        relay_seq: 9,
    }
}

/// The binding a hold of the incoming update names, or none while nothing
/// protects the lineage.
fn protected(f: &Fixture) -> Option<ReleasedLineageBinding> {
    protected_from(f, &incoming())
}

fn protected_from(f: &Fixture, incoming: &IncomingCoordinate) -> Option<ReleasedLineageBinding> {
    protected_in(f, incoming, &ReleasedTails::default())
}

/// [`protected_from`], decided with the tails `tails` keeps for the
/// fixture's store.
fn protected_in(f: &Fixture, incoming: &IncomingCoordinate, tails: &ReleasedTails) -> Option<ReleasedLineageBinding> {
    let key = ProtectionKey { doc: &f.key, lineage_claim_id: &f.binding.lineage_claim_id, incoming };
    match decided(f, &key, tails) {
        Protection::Unprotected => None,
        Protection::Protected { binding, head } => {
            assert_eq!(binding.head_digest, hex_sha256(&head.encode_full_state()), "the head it names");
            Some(*binding)
        }
        Protection::Pending(_) => unreachable!("decided"),
    }
}

/// `key` decided on `tails` bound to the fixture's store, each decision in
/// a transaction of its own, waiting for every validation one asks for, as
/// the actor's relay coordinator does.
fn decided(f: &Fixture, key: &ProtectionKey<'_>, tails: &ReleasedTails) -> Protection {
    let tails = tails.bound_to(&f.store);
    loop {
        match f.store.read_with(|conn| protection(conn, key, &tails)).unwrap() {
            Protection::Pending(pending) => pending.validate().wait().expect("validated"),
            decided => return decided,
        }
    }
}

/// The validation one decision of the fixture's lineage waits for.
fn pending(f: &Fixture, tails: &ReleasedTails) -> PendingValidation {
    let key = ProtectionKey { doc: &f.key, lineage_claim_id: &f.binding.lineage_claim_id, incoming: &incoming() };
    let tails = tails.bound_to(&f.store);
    match f.store.read_with(|conn| protection(conn, &key, &tails)).unwrap() {
        Protection::Pending(pending) => *pending,
        _ => panic!("nothing kept answers the decision"),
    }
}

/// Every protected tail the window names.
fn listed(binding: ReleasedLineageBinding) -> Vec<ProtectedTail> {
    match std::sync::Arc::unwrap_or_clone(binding.tails) {
        ProtectedTails::Listed(tails) => tails,
        ProtectedTails::Invalid => panic!("a window that reads"),
    }
}

/// The coverage a binding names for exactly `unproven`.
fn committed(unproven: Vec<RetainedContribution>) -> RetainedCoverage {
    RetainedCoverage::Unproven(UnprovenCommitment::of(unproven).expect("unproven work"))
}

/// The work `tail` retains without proof, as its validation reads it, which
/// its binding names by commitment.
fn unproven_of(f: &Fixture, tail: &ProtectedTail) -> Vec<RetainedContribution> {
    let work = tail_work(f, tail);
    assert!(work.contradictions.is_empty(), "{}: {:?}", tail.namespace, work.contradictions);
    let unproven = work.contributions;
    assert_eq!(tail.coverage, committed(unproven.clone()), "{}: the binding commits to all of it", tail.namespace);
    unproven
}

/// What validating `tail` finds, contradictions included.
fn tail_work(f: &Fixture, tail: &ProtectedTail) -> released_protection::TailWork {
    f.store
        .read_with(|conn| {
            retirement::unproven_retained(
                conn,
                &tail.namespace,
                &f.key,
                &f.binding.lineage_claim_id,
                &tail.activation_id,
                Stop::NEVER,
                &mut Stop::NEVER.working(),
            )
        })
        .unwrap()
}

/// The unproven work of the one tail that protects the lineage.
fn only_unproven(f: &Fixture) -> Vec<RetainedContribution> {
    match <[ProtectedTail; 1]>::try_from(listed(protected(f).expect("protected"))) {
        Ok([tail]) if matches!(tail.coverage, RetainedCoverage::Unproven(_)) => unproven_of(f, &tail),
        other => panic!("one tail with readable evidence: {other:?}"),
    }
}

/// What the release of the fixture's tail bound.
fn owner_release() -> Option<TailRelease> {
    Some(TailRelease { path: "owner.md".into(), restore_generation: 0 })
}

/// A native update the fixture's agent made, Carried.
fn carried(delivery: &CarriedDelivery) -> RetainedContribution {
    carried_by(delivery, native_agent())
}

/// An acknowledged seed, Carried: it credits nobody.
fn carried_seed(delivery: &CarriedDelivery) -> RetainedContribution {
    carried_by(delivery, RetainedAuthors::credited(None, None).unwrap())
}

fn carried_by(delivery: &CarriedDelivery, authors: RetainedAuthors) -> RetainedContribution {
    let receipt = &delivery.receipt;
    RetainedContribution::Carried {
        delivery_id: receipt.delivery_id.clone(),
        update_digest: receipt.update_digest.clone(),
        journal_cursor: receipt.journal_cursor,
        authors,
    }
}

/// Who `native_tail_edit` credits: its agent, for the owner, at depth 1.
fn native_agent() -> RetainedAuthors {
    RetainedAuthors::credited(
        Some("native-agent"),
        Some(&dohc_engine_domain::ChangeAttribution {
            actor_kind: dohc_engine_domain::ChangeActorKind::Agent,
            on_behalf_of: Some("owner".into()),
            depth: 1,
            run: None,
            agent_run_id: None,
        }),
    )
    .unwrap()
}

/// Sol's 4b2i-1 ruling, the seam: a released tail protects its lineage while
/// retained work lacks proof of application. Its binding names the scope,
/// the incoming coordinate, the head and the tail's coverage. An acknowledged
/// seed the host never applied is Carried work too. Nothing retained, a
/// current activation, or no chain protects nothing.
#[test]
fn a_released_tail_protects_its_lineage_while_its_retained_work_lacks_proof() {
    let (f, _, c1, c2) = released_at_b();
    let mut unproven = vec![carried(&c1), carried(&c2)];
    unproven.sort();
    let binding = protected(&f).expect("Carried deliveries protect");
    assert_eq!(
        binding,
        ReleasedLineageBinding {
            workspace_id: f.key.workspace_id.clone(),
            main_version_id: f.key.version_id.clone(),
            object_id: f.key.object_id.clone(),
            lineage_claim_id: f.binding.lineage_claim_id.clone(),
            current_path: Some("owner.md".into()),
            restore_generation: Some(0),
            incoming: incoming(),
            head_digest: hex_sha256(&local_doc(&f).encode_full_state()),
            tails: std::sync::Arc::new(ProtectedTails::Listed(vec![ProtectedTail {
                namespace: "namespace".into(),
                activation_id: "adoption".into(),
                release: owner_release(),
                coverage: committed(unproven),
            }])),
        }
    );
    // A hold persists the binding as its canonical JSON, which reads back.
    assert_eq!(ReleasedLineageBinding::from_canonical_json(&binding.canonical_json()), Some(binding.clone()));
    // The feed's namespace is the binding's own: another names another hold.
    let elsewhere = IncomingCoordinate { relay_namespace: Some("elsewhere".into()), ..incoming() };
    let moved_feed = protected_from(&f, &elsewhere).expect("protected");
    assert_eq!(moved_feed.incoming, elsewhere);
    assert_ne!(moved_feed, binding, "only the incoming namespace changed");
    assert_eq!(ReleasedLineageBinding { incoming: incoming(), ..moved_feed }, binding);

    let (mut f, _, carried_deliveries) = resumed_after_catch_up(true, 1);
    let seed = accept_seed(&mut f, 7);
    apply_carried(&mut f, &carried_deliveries[0]);
    host_document(&mut f, true, true);
    retire_settled(&mut f, Some(carried_deliveries[0].receipt.clone()), "seed-retired").unwrap();
    release_parked(&mut f);
    returned(&mut f);
    let unproven = only_unproven(&f);
    let seed = carried_delivery(&f, &seed);
    assert!(unproven.contains(&carried_seed(&seed)), "an acknowledged seed: {unproven:?}");
    assert!(unproven.contains(&carried(&carried_deliveries[1])), "{unproven:?}");
    assert!(!unproven.contains(&carried(&carried_deliveries[0])), "applied: {unproven:?}");

    assert!(protected(&released_without_carried()).is_none(), "nothing retained");
    let (mut f, _, _, _) = released_at_b();
    write_unchecked(&mut f, "PRAGMA foreign_keys=OFF;
        CREATE TEMP TABLE current AS SELECT * FROM live_owner_activations WHERE activation_id='adoption';
        UPDATE current SET relay_database_namespace='other',released_at_ms=NULL,released_restore_generation=NULL,
          released_accepted_cursor=NULL,released_boundary_json=NULL,carried_manifest_json=NULL;
        INSERT INTO live_owner_activations SELECT * FROM current");
    assert!(protected(&f).is_none(), "current in another relay");
    let mut f = Fixture::new();
    f.adopt().unwrap();
    native_tail_edit(&mut f, "# Own edit\n", 11);
    assert!(protected(&f).is_none(), "an activation is current");
    assert!(protected(&Fixture::new()).is_none(), "no chain");
}

/// What inspecting `binding` finds of `f`, which must still be current.
fn inspected(f: &Fixture, binding: &ReleasedLineageBinding) -> Preservation {
    match f.store.read_with(|conn| inspect_held(conn, binding, Stop::NEVER)).unwrap() {
        HeldInspection::Current(preservation) => preservation,
        HeldInspection::Stale => panic!("the binding was just derived"),
    }
}

/// Sol's r2c Ruling A: evidence is validated before work is committed to.
/// A native update's journal row, its declarations, a draft's declarations,
/// a pending entry's receipt and application, and a Carried delivery's
/// journal row that contradict the rest each leave the whole tail invalid,
/// never a commitment to the work that still reads, so destructive ingress
/// stays held. Inspection names the work each concerns: malformed
/// authorship by where the work is alone, and evidence that does not
/// enumerate by its tail. A pending entry whose acknowledgement was lost
/// stays work like any other.
#[test]
fn contradictory_provenance_invalidates_the_whole_tail_and_names_its_work() {
    use PreservationReason::{ContradictoryEvidence, MalformedAuthorship};
    let unapplied = || {
        let mut f = released_without_carried();
        write_unchecked(&mut f, "PRAGMA foreign_keys=OFF;
            DELETE FROM live_device_update_applications; DELETE FROM live_accepted_updates");
        f
    };
    let [entry]: [RetainedContribution; 1] = only_unproven(&unapplied()).try_into().unwrap();
    assert_eq!(entry.authors(), &native_agent(), "the journal row's agent");
    // Each fixture names its delivery anew: where its native entry is, and
    // that delivery.
    let native_entry = |f: &Fixture| {
        let native: i64 = f.store.read_with(|conn| conn.query_row(
            "SELECT COUNT(*) FROM owner_ydoc_outbox_entries WHERE native_source_json IS NOT NULL", [], |row| row.get(0),
        )).unwrap();
        assert_eq!(native, 1, "the fixture's only native entry");
        let locator = f.store.read_with(|conn| conn.query_row(
            "SELECT outbox_id,sequence,delivery_id,update_digest FROM owner_ydoc_outbox_entries
             WHERE native_source_json IS NOT NULL",
            [],
            |row| Ok(ContributionLocator::Outbox {
                outbox_id: row.get(0)?, sequence: row.get(1)?, delivery_id: row.get(2)?, update_digest: row.get(3)?,
            }),
        )).unwrap();
        let ContributionLocator::Outbox { delivery_id, .. } = &locator else { unreachable!() };
        let delivery_id = delivery_id.clone();
        (locator, delivery_id)
    };
    let automation = r#"{"automationId":"sort","attribution":{"actorKind":"automation","depth":1}}"#;
    let damages: [(&str, PreservationReason, bool, String); 8] = [
        ("a journal row naming another author", ContradictoryEvidence, false,
            "UPDATE ydoc_updates SET actor_origin_id='impostor' WHERE seq IN
               (SELECT json_extract(native_source_json,'$.nativeSequence') FROM owner_ydoc_outbox_entries
                WHERE delivery_id=?1)".into()),
        ("a native entry declaring an automation", MalformedAuthorship, false,
            format!("UPDATE owner_ydoc_outbox_entries SET automation_declaration_json='{automation}' WHERE delivery_id=?1")),
        ("a native entry claiming a person's edit", MalformedAuthorship, false,
            "UPDATE owner_ydoc_outbox_entries SET person_edit=1 WHERE delivery_id=?1".into()),
        ("a native entry naming a run beside its source", MalformedAuthorship, false,
            "UPDATE owner_ydoc_outbox_entries SET agent_run_id='run-a' WHERE delivery_id=?1".into()),
        ("a draft declaring an agent and an automation", MalformedAuthorship, false,
            format!("UPDATE owner_ydoc_outbox_entries SET native_source_json=NULL,
               agent_declaration_json='{{\"agentId\":\"a\",\"onBehalfOf\":null,\"depth\":0}}',
               automation_declaration_json='{automation}' WHERE delivery_id=?1")),
        ("a draft whose declaration does not validate", MalformedAuthorship, false,
            "UPDATE owner_ydoc_outbox_entries SET native_source_json=NULL,
               agent_declaration_json='{\"agentId\":\"\",\"onBehalfOf\":null,\"depth\":0}' WHERE delivery_id=?1".into()),
        ("a pending entry that saved a receipt", ContradictoryEvidence, false,
            "UPDATE owner_ydoc_outbox_entries SET pending=1,update_blob_digest=update_digest WHERE delivery_id=?1".into()),
        ("a pending entry applied here with other bytes", ContradictoryEvidence, true,
            format!("UPDATE owner_ydoc_outbox_entries SET pending=1,update_blob_digest=update_digest,
               accepted_receipt_json=NULL WHERE delivery_id=?1;
             UPDATE live_device_update_applications SET update_digest='{}' WHERE delivery_id=?1", "0".repeat(64))),
    ];
    for (case, reason, applications_kept, damage) in damages {
        let mut f = if applications_kept { released_without_carried() } else { unapplied() };
        let (locator, delivery_id) = native_entry(&f);
        write_unchecked(&mut f, &format!("PRAGMA foreign_keys=OFF; {}", damage.replace("?1", &format!("'{delivery_id}'"))));
        let binding = protected(&f).unwrap_or_else(|| panic!("{case}: still protected"));
        assert_eq!(coverage_of(binding.clone()), [RetainedCoverage::Invalid], "{case}");
        let expected = [PreservationFinding {
            reason,
            namespace: Some("namespace".into()),
            contribution: Some(locator.clone()),
        }];
        let [tail] = <[ProtectedTail; 1]>::try_from(listed(binding.clone())).unwrap();
        let work = tail_work(&f, &tail);
        assert_eq!(work.contradictions, expected, "{case}");
        assert!(work.contributions.iter().all(|kept| kept.locator() != locator), "{case}: none made up");
        let preservation = inspected(&f, &binding);
        assert_eq!(preservation.status, PreservationStatus::InvalidEvidence, "{case}");
        assert_eq!(preservation.findings, expected, "{case}");
        assert!(preservation.covered.is_empty() && preservation.preserved.is_none(), "{case}");
    }

    // An acknowledgement lost before the entry recorded it: the relay
    // accepted it and the host applied it, and it is still work.
    let mut f = released_without_carried();
    let (locator, delivery_id) = native_entry(&f);
    write_unchecked(&mut f, &format!("PRAGMA foreign_keys=OFF;
        UPDATE owner_ydoc_outbox_entries SET pending=1,update_blob_digest=update_digest,accepted_receipt_json=NULL
        WHERE delivery_id='{delivery_id}'"));
    let [kept]: [RetainedContribution; 1] = only_unproven(&f).try_into().unwrap();
    assert_eq!((kept.locator(), kept.authors()), (locator, &native_agent()), "pending is no proof, and its acceptance no contradiction");

    let mut f = unapplied();
    let (locator, delivery_id) = native_entry(&f);
    write_unchecked(&mut f, &format!("PRAGMA foreign_keys=OFF;
        UPDATE owner_ydoc_outbox_entries SET native_source_json=NULL,
          agent_declaration_json='{{\"agentId\":\"draft-agent\",\"onBehalfOf\":\"owner\",\"depth\":1}}',
          agent_run_id='run-a' WHERE delivery_id='{delivery_id}'"));
    let in_run_a = RetainedAuthors::credited(
        Some("draft-agent"),
        Some(&dohc_engine_domain::ChangeAttribution {
            actor_kind: dohc_engine_domain::ChangeActorKind::Agent,
            on_behalf_of: Some("owner".into()),
            depth: 1,
            run: None,
            agent_run_id: Some("run-a".into()),
        }),
    )
    .unwrap();
    let [kept]: [RetainedContribution; 1] = only_unproven(&f).try_into().unwrap();
    assert_eq!((kept.locator(), kept.authors()), (locator, &in_run_a), "the draft's run");

    // One Carried delivery's journal row contradicts it; the other still
    // reads, and the tail commits to neither.
    let (mut f, _, c1, _) = released_at_b();
    write_unchecked(&mut f, &format!("PRAGMA foreign_keys=OFF;
        UPDATE ydoc_updates SET actor_origin_id='impostor' WHERE seq={}", c1.native_sequence));
    let binding = protected(&f).expect("protected");
    assert_eq!(coverage_of(binding.clone()), [RetainedCoverage::Invalid]);
    assert_eq!(
        inspected(&f, &binding).findings,
        [PreservationFinding {
            reason: ContradictoryEvidence,
            namespace: Some("namespace".into()),
            contribution: Some(carried(&c1).locator()),
        }]
    );

    // A tail record that does not read names no work: its tail is the finding.
    let mut f = released_without_carried();
    write_unchecked(&mut f, "UPDATE live_owner_activations SET released_boundary_json='{}' WHERE activation_id='adoption'");
    let binding = protected(&f).expect("protected");
    assert_eq!(
        inspected(&f, &binding).findings,
        [PreservationFinding { reason: ContradictoryEvidence, namespace: Some("namespace".into()), contribution: None }]
    );
}

/// Record, past the store's checks, that the host applied exactly `receipt`:
/// a copy of the covered delivery's application at cursor 3.
fn applied_exactly(f: &mut Fixture, receipt: &LiveUpdateReceipt) {
    write_unchecked(f, &format!("PRAGMA foreign_keys=OFF;
        CREATE TEMP TABLE applied AS SELECT * FROM live_device_update_applications WHERE journal_cursor=3;
        UPDATE applied SET delivery_id='{}',update_digest='{}',journal_cursor={},accepting_host_epoch={};
        INSERT INTO live_device_update_applications SELECT * FROM applied",
        receipt.delivery_id, receipt.update_digest, receipt.journal_cursor, receipt.accepting_host_epoch));
}

/// The tails `tails` answers for the fixture's lineage, decided now, and
/// whether a fresh validation reads the same.
fn kept_matches_fresh(f: &Fixture, tails: &ReleasedTails) -> Option<ReleasedLineageBinding> {
    let kept = protected_in(f, &incoming(), tails);
    assert_eq!(kept, protected_in(f, &incoming(), &ReleasedTails::uncached()), "kept tails read as fresh ones");
    kept
}

/// The fixture document's released tail generation.
fn tail_generation_of(f: &Fixture) -> Option<i64> {
    f.store
        .read_with(|conn| {
            conn.query_row(
                "SELECT generation FROM released_tail_generations WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
                params![f.key.workspace_id, f.key.version_id, f.key.object_id],
                |row| row.get(0),
            )
            .optional()
        })
        .unwrap()
}

/// Sol's tails-cache ruling: the actor keeps a lineage's validated tails
/// while the document's generation stands. Later decisions share the same
/// tails, with no copy of their lists, and each reads its own path. A changed
/// tail input, here both Carried deliveries applied, validates again. Sol's
/// binding-cost ruling: the worker commits to the unproven work as it
/// validates, and no decision commits to it again.
#[test]
fn validated_tails_stand_until_their_generation_moves() {
    let (mut f, _, c1, c2) = released_at_b();
    let tails = ReleasedTails::default();
    let commitments = released_tail_commitments_on_this_thread();
    let first = protected_in(&f, &incoming(), &tails).expect("protected");
    assert_eq!(tails.validations(), 1);
    write_unchecked(&mut f, "UPDATE path_aliases SET path='renamed.md' WHERE path='owner.md'");
    let later = protected_in(&f, &incoming(), &tails).expect("kept");
    assert!(std::sync::Arc::ptr_eq(&later.tails, &first.tails), "shared, never copied");
    assert_eq!(tails.validations(), 1, "a path is no tail input");
    assert_eq!(released_tail_commitments_on_this_thread(), commitments, "committed to on the worker only");
    assert_eq!(coverage_of(later.clone()), [committed(vec![carried(&c1), carried(&c2)])]);
    assert_eq!(later.current_path.as_deref(), Some("renamed.md"), "the path is each decision's own");
    applied_exactly(&mut f, &c1.receipt);
    applied_exactly(&mut f, &c2.receipt);
    assert!(kept_matches_fresh(&f, &tails).is_none(), "both applied");
    assert_eq!(tails.validations(), 2);
}

/// The coverage of each tail `binding` lists.
fn coverage_of(binding: ReleasedLineageBinding) -> Vec<RetainedCoverage> {
    listed(binding).into_iter().map(|tail| tail.coverage).collect()
}

/// Both Carried deliveries applied, in `tx`.
fn apply_both_in(tx: &rusqlite::Transaction<'_>, receipts: [&LiveUpdateReceipt; 2]) -> Result<(), ApplicationError> {
    for receipt in receipts {
        tx.execute_batch(&format!(
            "CREATE TEMP TABLE applied AS SELECT * FROM live_device_update_applications WHERE journal_cursor=3;
             UPDATE applied SET delivery_id='{}',update_digest='{}',journal_cursor={},accepting_host_epoch={};
             INSERT INTO live_device_update_applications SELECT * FROM applied;
             DROP TABLE applied",
            receipt.delivery_id, receipt.update_digest, receipt.journal_cursor, receipt.accepting_host_epoch
        ))
        .map_err(write_sql)?;
    }
    Ok(())
}

/// Sol's worker ruling: a write transaction that changed the tails never
/// decides on them. Its decision waits, and the worker, which reads only
/// committed state, refuses the generation that transaction read rather
/// than validate anything else for it. Back at committed state after its
/// savepoint rolls back, it reuses what was kept. A later change that
/// reaches the generation a rolled-back transaction read validates again.
#[test]
fn a_rolled_back_change_keeps_no_tails() {
    let (mut f, _, c1, c2) = released_at_b();
    let tails = ReleasedTails::default();
    let kept = kept_matches_fresh(&f, &tails).expect("protected");
    let key = ProtectionKey { doc: &f.key, lineage_claim_id: &f.binding.lineage_claim_id, incoming: &incoming() };
    let bound = tails.bound_to(&f.store);
    let mut aborted = None;
    let mut waiting = None;
    let rolled_back = f.store.write_with(&NoFaults, |tx| {
        tx.execute_batch("PRAGMA defer_foreign_keys=ON; SAVEPOINT tails").map_err(write_sql)?;
        apply_both_in(tx, [&c1.receipt, &c2.receipt])?;
        let Protection::Pending(pending) = protection(tx, &key, &bound)? else {
            panic!("its own state is never decided on");
        };
        waiting = Some(pending);
        tx.execute_batch("ROLLBACK TO tails; RELEASE tails").map_err(write_sql)?;
        let Protection::Protected { binding, .. } = protection(tx, &key, &bound)? else {
            panic!("committed state again");
        };
        assert!(std::sync::Arc::ptr_eq(&binding.tails, &kept.tails), "what committed state kept");
        apply_both_in(tx, [&c1.receipt, &c2.receipt])?;
        aborted = Some(tx.query_row(
            "SELECT generation FROM released_tail_generations WHERE object_id=?1",
            [&f.key.object_id],
            |row| row.get::<_, i64>(0),
        ).map_err(read_sql)?);
        Err::<(), _>(ApplicationError::Conflict)
    });
    assert!(matches!(rolled_back, Err(ApplicationError::Conflict)), "{rolled_back:?}");
    assert_eq!(waiting.unwrap().validate().wait(), Err(ValidationError::Uncommitted));
    assert_eq!(tails.validations(), 1, "no transaction's own state is kept");
    let aborted = aborted.unwrap();
    while tail_generation_of(&f).unwrap() < aborted {
        write_unchecked(&mut f, "PRAGMA foreign_keys=OFF;
            UPDATE live_owner_activations SET source_byte_length=source_byte_length");
    }
    assert_eq!(tail_generation_of(&f), Some(aborted), "the same generation, other rows");
    kept_matches_fresh(&f, &tails).expect("nothing applied");
    assert_eq!(tails.validations(), 2);
}

/// Bump the generation of whichever fixture's is lower until both read the
/// same.
fn same_generation(first: &mut Fixture, second: &mut Fixture) {
    loop {
        let (a, b) = (tail_generation_of(first).unwrap(), tail_generation_of(second).unwrap());
        let lower = match a.cmp(&b) {
            std::cmp::Ordering::Equal => return,
            std::cmp::Ordering::Less => &mut *first,
            std::cmp::Ordering::Greater => &mut *second,
        };
        write_unchecked(lower, "PRAGMA foreign_keys=OFF;
            UPDATE live_owner_activations SET source_byte_length=source_byte_length");
    }
}

/// Sol's tails-cache ruling: kept tails belong to one open store. Tails
/// bound to another store forget them, even where the document and its
/// generation coincide, and so does a reopen of the same file, whose
/// generations stand. Sol's worker ruling: a document never activated has no
/// generation and is unprotected without a scan, and an activated one
/// without its generation is corrupt, never unprotected.
#[test]
fn kept_tails_belong_to_one_open_store_and_one_recorded_generation() {
    let (mut first, _, _, _) = released_at_b();
    let (mut second, _, c1, c2) = released_at_b();
    applied_exactly(&mut second, &c1.receipt);
    applied_exactly(&mut second, &c2.receipt);
    same_generation(&mut first, &mut second);
    let tails = ReleasedTails::default();
    kept_matches_fresh(&first, &tails).expect("protected");
    assert!(kept_matches_fresh(&second, &tails).is_none(), "another store's tails");
    kept_matches_fresh(&first, &tails).expect("protected");
    assert_eq!(tails.validations(), 3, "each store forgets the other's");
    let generation = tail_generation_of(&first);
    let path = first.store.database_path().to_owned();
    first.store = EngineStore::open(&path, 0).unwrap();
    assert_eq!(tail_generation_of(&first), generation);
    kept_matches_fresh(&first, &tails).expect("protected");
    kept_matches_fresh(&first, &tails).expect("protected");
    assert_eq!(tails.validations(), 4, "a reopened store validates again, once");

    let (mut f, _, _, _) = released_at_b();
    write_unchecked(&mut f, "DROP TRIGGER released_tail_generation_kept; DELETE FROM released_tail_generations");
    let tails = ReleasedTails::default().bound_to(&f.store);
    let key = ProtectionKey { doc: &f.key, lineage_claim_id: &f.binding.lineage_claim_id, incoming: &incoming() };
    let decided = f.store.read_with(|conn| protection(conn, &key, &tails));
    assert!(matches!(decided, Err(ApplicationError::Storage(_))), "an activation without a generation");
    let f = Fixture::new();
    assert_eq!(tail_generation_of(&f), None);
    let key = ProtectionKey { doc: &f.key, lineage_claim_id: &f.binding.lineage_claim_id, incoming: &incoming() };
    let decided = f.store.read_with(|conn| protection(conn, &key, &tails.bound_to(&f.store))).unwrap();
    assert!(matches!(decided, Protection::Unprotected), "never activated");
    assert_eq!((tails.validation_requests(), tails.validations()), (0, 0));
}

/// Opus's 1a-2d finding 1: a kept verdict answers only the store it was
/// validated on. Tails bound to one store, asked through another store's
/// connection at the same document and generation, miss, and the bound
/// store's worker refuses to validate another store's decision.
#[test]
fn kept_tails_answer_only_the_store_they_were_validated_on() {
    let (mut first, _, _, _) = released_at_b();
    let (mut second, _, c1, c2) = released_at_b();
    applied_exactly(&mut second, &c1.receipt);
    applied_exactly(&mut second, &c2.receipt);
    same_generation(&mut first, &mut second);
    assert_ne!(first.store.engine_uuid().unwrap(), second.store.engine_uuid().unwrap());
    let tails = ReleasedTails::default();
    kept_matches_fresh(&first, &tails).expect("protected");
    let key = ProtectionKey { doc: &second.key, lineage_claim_id: &second.binding.lineage_claim_id, incoming: &incoming() };
    let bound = tails.bound_to(&first.store);
    let decided = second.store.read_with(|conn| protection(conn, &key, &bound)).unwrap();
    let Protection::Pending(pending) = decided else {
        panic!("nothing validated on the bound store answers it");
    };
    assert_eq!(pending.validate().wait(), Err(ValidationError::Failed), "another store's identity");
    assert_eq!(tails.validations(), 1);
}

/// Sol's worker ruling: identical requests share one validation, and one
/// whose result is already kept completes without asking the worker. A
/// waiter that first looks after the validation completed still sees it.
#[test]
fn identical_requests_share_one_validation_and_no_completion_is_lost() {
    let (f, _, _, _) = released_at_b();
    let tails = ReleasedTails::default();
    let (first, second) = (pending(&f, &tails), pending(&f, &tails));
    assert_eq!(first, second);
    tails.pause_validation();
    let late = first.validate();
    let joined = second.validate();
    tails.wait_for_paused_validation();
    tails.resume_validation();
    assert_eq!(joined.wait(), Ok(()));
    // `late` never registered before the validation completed.
    assert_eq!(late.wait(), Ok(()));
    assert_eq!((tails.validation_requests(), tails.validations()), (1, 1));
    assert_eq!(first.validate().wait(), Ok(()), "kept");
    assert_eq!(tails.validation_requests(), 1);
    assert!(protected(&f).is_some());
}

/// Sol's worker ruling: a generation that moves while the worker validates
/// an older snapshot leaves that result answering nothing current. The next
/// decision asks again, and the current state is what it decides on.
#[test]
fn a_generation_moved_during_validation_validates_current_state() {
    let (mut f, _, c1, c2) = released_at_b();
    let tails = ReleasedTails::default();
    let old = pending(&f, &tails);
    tails.pause_validation();
    let validation = old.validate();
    tails.wait_for_paused_validation();
    applied_exactly(&mut f, &c1.receipt);
    applied_exactly(&mut f, &c2.receipt);
    tails.resume_validation();
    assert_eq!(validation.wait(), Ok(()));
    assert_eq!(tails.validations(), 1, "the older snapshot");
    assert_ne!(pending(&f, &tails), old, "asked again at the current generation");
    assert!(protected_in(&f, &incoming(), &tails).is_none(), "both applied, as now committed");
    assert_eq!(tails.validations(), 2);
}

/// Sol's worker ruling: closing the tails cancels the validation running,
/// wakes its waiters, and returns only once the worker ended. Nothing
/// validates after.
#[test]
fn closing_cancels_validation_and_waits_for_the_worker() {
    let (f, _, _, _) = released_at_b();
    let tails = ReleasedTails::default();
    let request = pending(&f, &tails);
    tails.pause_validation();
    let running = request.validate();
    tails.wait_for_paused_validation();
    assert!(tails.validating());
    tails.close();
    assert!(!tails.validating(), "the worker ended");
    assert_eq!(running.wait(), Err(ValidationError::Closed));
    assert_eq!(request.validate().wait(), Err(ValidationError::Closed), "nothing new starts");
    assert_eq!((tails.validation_requests(), tails.validations()), (1, 0));
}

/// Move the fixture document's generation without changing what its tails
/// read.
fn bump_generation(f: &mut Fixture) {
    write_unchecked(f, "PRAGMA foreign_keys=OFF;
        UPDATE live_owner_activations SET source_byte_length=source_byte_length");
}

/// Sol's 1a-2g finding 1: a queued validation nobody waits for leaves the
/// queue, however many requests a cancelled caller abandons while the worker
/// is busy, and one a live waiter still shares stays and completes for it.
#[test]
fn abandoned_validations_leave_the_queue() {
    let (mut f, _, _, _) = released_at_b();
    let tails = ReleasedTails::default();
    tails.pause_validation();
    let running = pending(&f, &tails).validate();
    tails.wait_for_paused_validation();
    for _ in 0..32 {
        bump_generation(&mut f);
        drop(pending(&f, &tails).validate());
    }
    assert_eq!(tails.queued_validations(), 0, "every abandoned request left");
    bump_generation(&mut f);
    let request = pending(&f, &tails);
    let (kept, abandoned) = (request.validate(), request.validate());
    drop(abandoned);
    assert_eq!(tails.queued_validations(), 1, "shared with a live waiter");
    tails.resume_validation();
    assert_eq!(running.wait(), Ok(()));
    assert_eq!(kept.wait(), Ok(()));
    assert_eq!(tails.queued_validations(), 0);
    assert_eq!((tails.validation_requests(), tails.validations()), (34, 2));
}

/// `validation`'s result, or a failure once it has not completed for long
/// enough that it never will.
fn completed(validation: Validation) -> Result<(), ValidationError> {
    let (sent, received) = std::sync::mpsc::channel();
    std::thread::spawn(move || sent.send(validation.wait()));
    received.recv_timeout(std::time::Duration::from_secs(60)).expect("the validation completed")
}

/// Opus's 1a-2g finding 1: a validation that panics fails its waiters, and
/// the worker goes on to the next.
#[test]
fn a_panicking_validation_fails_its_waiters_and_the_worker_goes_on() {
    let (f, _, _, _) = released_at_b();
    let tails = ReleasedTails::default();
    let request = pending(&f, &tails);
    tails.panic_validations(1);
    assert_eq!(completed(request.validate()), Err(ValidationError::Failed));
    assert_eq!(tails.validations(), 0);
    assert_eq!(completed(request.validate()), Ok(()), "the worker goes on");
    assert!(protected_in(&f, &incoming(), &tails).is_some());
    assert_eq!((tails.validation_requests(), tails.validations()), (2, 1));
}

/// Sol's 4b2i-1 ruling 5: the binding lists every protected namespace's
/// tail, in namespace order, never only the first.
#[test]
fn a_binding_lists_every_protected_namespace() {
    let (mut f, _, c1, c2) = released_at_b();
    write_unchecked(&mut f, "PRAGMA foreign_keys=OFF;
        CREATE TEMP TABLE copied AS SELECT * FROM live_owner_activations WHERE activation_id='adoption';
        UPDATE copied SET relay_database_namespace='other';
        INSERT INTO live_owner_activations SELECT * FROM copied");
    let tails = listed(protected(&f).expect("protected"));
    let named: Vec<(&str, &str)> = tails.iter().map(|tail| (tail.namespace.as_str(), tail.activation_id.as_str())).collect();
    assert_eq!(named, [("namespace", "adoption"), ("other", "adoption")]);
    for tail in &tails {
        assert!(matches!(tail.coverage, RetainedCoverage::Unproven(_)), "{}: readable", tail.namespace);
        let unproven = unproven_of(&f, tail);
        assert!(unproven.contains(&carried(&c1)) && unproven.contains(&carried(&c2)), "{}: {unproven:?}", tail.namespace);
    }
}

/// What a protected remote apply adds over half a mebibyte of Markdown:
/// rebuilding the head, here from one snapshot, the full-state digest the
/// binding names, and structural inspection of a safe append and of a disk
/// fold. Only an apply in a protected lineage pays it.
#[test]
#[ignore = "measurement"]
fn measure_protected_inspection_over_half_a_mebibyte() {
    let paragraph = "A paragraph of prose someone wrote in their plan, long enough to be typical. ".repeat(4);
    let mut markdown = String::new();
    while markdown.len() < 512 * 1024 {
        markdown.push_str(&paragraph);
        markdown.push_str("\n\n");
    }
    let markdown = markdown.trim_end().to_owned();
    let doc = Ydoc::wire();
    doc.rewrite_content_to_markdown(ContentKind::Richdoc, &markdown).unwrap();
    let head = Ydoc::wire();
    head.apply(&doc.encode_full_state()).unwrap();
    let append = doc.richdoc_append_paragraph("Appended.");
    let fold = Ydoc::wire();
    fold.apply(&head.encode_full_state()).unwrap();
    // The disk edit changes the last paragraph, so the fold deletes it.
    let fold = fold.rewrite_content_to_markdown_for_fold(ContentKind::Richdoc, &format!("{markdown} A disk edit.")).unwrap();
    let time = |run: &dyn Fn()| {
        let mut samples: Vec<f64> = (0..7)
            .map(|_| {
                let started = std::time::Instant::now();
                run();
                started.elapsed().as_secs_f64() * 1000.0
            })
            .collect();
        samples.sort_by(f64::total_cmp);
        samples[samples.len() / 2]
    };
    let full_state = head.encode_full_state();
    let reconstruction = time(&|| {
        Ydoc::wire().apply(&full_state).unwrap();
    });
    let digest = time(&|| {
        hex_sha256(&head.encode_full_state());
    });
    let safe = time(&|| assert_eq!(crate::inspect_update(&head, &append), crate::UpdateInspection::Admissible));
    let destructive = time(&|| assert!(matches!(crate::inspect_update(&head, &fold), crate::UpdateInspection::Hold(_))));
    println!(
        "PROTECTED_INSPECTION_MEASUREMENT {}",
        serde_json::json!({
            "markdownBytes": markdown.len(),
            "fullStateBytes": full_state.len(),
            "headFromOneSnapshotMedianMs": reconstruction,
            "headDigestMedianMs": digest,
            "safeAppendInspectionMedianMs": safe,
            "diskFoldInspectionMedianMs": destructive,
            "samples": 7,
        })
    );
}

/// An update lands off a protected tail's binding at another path, or after
/// a restore its release did not bind. Invalid coverage keeps the release
/// binding; a release or window that does not read cannot show an update
/// stays on it.
#[test]
fn an_update_moves_off_a_tail_at_another_path_or_restore() {
    let (f, _, _, _) = released_at_b();
    let binding = protected(&f).unwrap();
    assert!(!binding.moved("owner.md"));
    assert!(binding.moved("other.md"), "another path");
    for (case, current_path, restore_generation) in [
        ("renamed", Some("renamed.md"), Some(0)),
        ("unaliased", None, Some(0)),
        ("restored", Some("owner.md"), Some(1)),
        ("restoring", Some("owner.md"), None),
    ] {
        let moved = ReleasedLineageBinding { current_path: current_path.map(str::to_owned), restore_generation, ..binding.clone() };
        assert!(moved.moved(current_path.unwrap_or("owner.md")), "{case}");
    }

    let (mut f, _, c1, _) = released_at_b();
    write_unchecked(&mut f, &format!("PRAGMA foreign_keys=OFF;
        DELETE FROM owner_ydoc_outbox_entries WHERE delivery_id='{}'", c1.receipt.delivery_id));
    let invalid = protected(&f).unwrap();
    let [tail] = listed(invalid.clone()).try_into().unwrap();
    assert_eq!((tail.release, tail.coverage), (owner_release(), RetainedCoverage::Invalid));
    assert!(!invalid.moved("owner.md"), "invalid coverage at its release");
    let restored = ReleasedLineageBinding { restore_generation: Some(1), ..invalid };
    assert!(restored.moved("owner.md"), "invalid coverage after a restore");

    let mut f = released_without_carried();
    write_unchecked(&mut f, "UPDATE live_owner_activations SET released_restore_generation=NULL WHERE activation_id='adoption'");
    let unbound = protected(&f).expect("a release that does not read protects");
    let [tail] = listed(unbound.clone()).try_into().unwrap();
    assert_eq!((tail.release, tail.coverage), (None, RetainedCoverage::Invalid));
    assert!(unbound.moved("owner.md"), "a release that does not read");
}

/// Opus's 1a-2 finding 3: evidence of the window itself that does not read,
/// two tails in one namespace or a current activation never adopted,
/// protects the lineage as invalid, and no update can show it stays on it.
/// Storage failures stay errors.
#[test]
fn a_window_that_does_not_read_protects_as_invalid() {
    let twin = |f: &mut Fixture, update: &str| {
        write_unchecked(f, &format!("PRAGMA foreign_keys=OFF;
            CREATE TEMP TABLE twin AS SELECT * FROM live_owner_activations WHERE activation_id='adoption';
            UPDATE twin SET activation_id='twin'{update};
            INSERT INTO live_owner_activations SELECT * FROM twin"));
    };
    let two_tails = || {
        let mut f = released_without_carried();
        twin(&mut f, "");
        f
    };
    let unadopted = || {
        let mut f = released_without_carried();
        twin(&mut f, ",released_at_ms=NULL,evidence_digest=NULL");
        f
    };
    for (case, f) in [("two tails in one namespace", two_tails()), ("a current activation never adopted", unadopted())] {
        let window = f.store.read_with(|conn| settled_base::released_window(conn, &f.key, &f.binding.lineage_claim_id));
        assert!(window.is_err(), "{case}: {window:?}");
        let binding = protected(&f).unwrap_or_else(|| panic!("{case}: protected"));
        assert_eq!(*binding.tails, ProtectedTails::Invalid, "{case}");
        assert!(binding.moved("owner.md"), "{case}");
    }
}

/// What a held proof's `read` of `f` answers within `capacity` bytes of
/// proof memory, with what it saw on the way.
struct WithinMemory<T> {
    answer: Result<T, ApplicationError>,
    stopped: Option<ProofStop>,
    windows: u64,
    activations: u64,
    checks: u64,
    peak: u64,
}

fn within_memory<T>(
    f: &Fixture,
    capacity: u64,
    read: impl FnOnce(&rusqlite::Connection, Stop<'_>) -> Result<T, ApplicationError>,
) -> WithinMemory<T> {
    let limit = HeldProofLimit::new(1, capacity, 0);
    let proofs: HeldProofs<(), ()> = HeldProofs::new(limit.clone());
    proofs.set_proof_deadline(std::time::Duration::from_secs(3_600));
    let HeldProofAdmission::Started(run, _wait) = proofs.admit(&f.store, "workspace", ()).unwrap() else {
        panic!("a free workspace starts its proof")
    };
    let mut observed = None;
    run.prove(|job| {
        let windows = settled_base::released_window_reads_on_this_thread();
        let activations = owner_activations::activation_reads_on_this_thread();
        let answer = f.store.read_with(|conn| Ok::<_, ApplicationError>(read(conn, job.stop()))).unwrap();
        observed = Some((
            answer,
            job.stopped(),
            settled_base::released_window_reads_on_this_thread() - windows,
            owner_activations::activation_reads_on_this_thread() - activations,
        ));
        ((), 0)
    });
    let (answer, stopped, windows, activations) = observed.expect("the proof ran");
    WithinMemory { answer, stopped, windows, activations, checks: proofs.checks_passed(), peak: limit.peak_reserved_bytes() }
}

/// What reading the fixture's window holds, what reading the activation of
/// each of `namespaces`' tails holds, and what validating each holds.
fn window_workloads(f: &Fixture, namespaces: &[&str]) -> (u64, Vec<(u64, u64)>) {
    let lineage = &f.binding.lineage_claim_id;
    f.store
        .read_with(|conn| {
            let evidence = released_protection::lineage_evidence(conn, &f.key, lineage)?;
            let tails = namespaces
                .iter()
                .map(|namespace| -> Result<(u64, u64), ApplicationError> {
                    Ok((
                        released_protection::activation_workload(conn, namespace, "adoption")?,
                        evidence.tail_workload(conn, namespace, &f.key, lineage, "adoption")?,
                    ))
                })
                .collect::<Result<Vec<_>, ApplicationError>>()?;
            Ok::<_, ApplicationError>((released_protection::window_workload(conn, &f.key, lineage)?, tails))
        })
        .unwrap()
}

/// The fixture's window as a held proof reads it.
fn window_of(conn: &rusqlite::Connection, f: &Fixture, stop: Stop<'_>) -> Result<Option<released_protection::WindowWork>, ApplicationError> {
    released_protection::window_work(conn, &f.key, &f.binding.lineage_claim_id, stop, &mut stop.working())
}

/// Sol's r2c-3c-8 finding 1: a held proof reserves what reading the
/// released window holds, and each tail's activation and its validation,
/// from stored lengths before it reads them. With room for less than the
/// window it reads no window and no activation; with room for the window
/// alone, no activation; with room for the window and the tail's
/// activation, that activation and nothing its validation reads, an
/// activation of its chain among them, and it passes no validation check.
/// Each refusal is too large. These counts are the evidence. Opus's
/// r2c-3c-10 finding 4: the tail's work is kept before its validation is
/// given back, so room for all of it holds both at once.
#[test]
fn a_held_proof_reserves_the_window_and_each_activation_before_it_reads_them() {
    let (f, _, _, _) = released_at_b();
    let (window, tails) = window_workloads(&f, &["namespace"]);
    let [(activation, validation)] = tails[..] else { unreachable!() };
    for (room, what, read) in [
        (window - 1, "the window", (0, 0, 0)),
        (window + activation - 1, "the tail's activation", (1, 0, 0)),
        (window + activation + validation - 1, "the tail's validation", (1, 1, 0)),
    ] {
        let within = within_memory(&f, room, |conn, stop| window_of(conn, &f, stop));
        assert!(matches!(within.answer, Err(ApplicationError::Cancelled)), "{what}: {:?}", within.answer.map(|_| ()));
        assert_eq!(within.stopped, Some(ProofStop::TooLarge), "{what}");
        assert_eq!((within.windows, within.activations, within.checks), read, "{what}: refused before it read");
    }
    let Ok(Some(released_protection::WindowWork::Listed(listed))) =
        within_memory(&f, 1 << 40, |conn, stop| window_of(conn, &f, stop)).answer
    else {
        panic!("one tail validates")
    };
    let [(tail, work)] = &listed[..] else { panic!("one tail: {}", listed.len()) };
    let kept = released_protection::tail_kept_bytes(tail, work);
    let within = within_memory(&f, window + activation + validation + kept, |conn, stop| window_of(conn, &f, stop));
    assert!(matches!(within.answer, Ok(Some(released_protection::WindowWork::Listed(_)))), "room for all of it");
    assert_eq!(within.stopped, None);
    assert!(within.activations > 1, "its validation read its chain's activations: {}", within.activations);
}

/// The fixture released with nothing Carried, then `count` entries of its
/// lineage's outbox queued and never sent, each one paragraph appended to
/// its head, written in one transaction with their bytes: retained work no
/// proof covers. They are pending entries, not drafts: none names a draft
/// binding. With the binding that protects it and the work its tail commits
/// to, in canonical order.
fn released_with_pending_entries(count: usize) -> (Fixture, ReleasedLineageBinding, Vec<RetainedContribution>) {
    let mut f = released_without_carried();
    let writer = Ydoc::wire();
    writer.apply(&local_doc(&f).encode_full_state()).unwrap();
    let updates: Vec<Vec<u8>> = (0..count)
        .map(|index| writer.richdoc_append_paragraph(&format!("Pending entry {index}")))
        .collect();
    let (outbox_id, sequence): (String, i64) = f
        .store
        .read_with(|conn| {
            conn.query_row(
                "SELECT e.outbox_id,max(e.sequence) FROM owner_ydoc_outbox_entries e
                 JOIN owner_ydoc_outboxes o ON o.outbox_id=e.outbox_id WHERE o.lineage_claim_id=?1",
                [&f.binding.lineage_claim_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
        })
        .unwrap();
    f.store
        .write_with(&NoFaults, |tx| {
            let mut entry = tx
                .prepare(
                    "INSERT INTO owner_ydoc_outbox_entries(outbox_id,sequence,append_key,delivery_id,update_digest,
                       update_blob_digest,byte_length,created_at_ms,pending,result_pending_bytes,
                       result_oldest_entry_at_ms,result_state)
                     VALUES (?1,?2,?3,?3,?4,?4,?5,20,1,?5,20,'active')",
                )
                .map_err(write_sql)?;
            for (index, update) in updates.iter().enumerate() {
                let sha = hex_sha256(update);
                dohc_engine_storage::put_binary_blob_with_sha(tx, update, &sha)?;
                entry
                    .execute(rusqlite::params![
                        outbox_id,
                        sequence + 1 + index as i64,
                        format!("pending-{index:06}"),
                        sha,
                        update.len() as i64,
                    ])
                    .map_err(write_sql)?;
            }
            Ok::<_, ApplicationError>(())
        })
        .unwrap();
    let entries: Vec<RetainedContribution> = updates
        .iter()
        .enumerate()
        .map(|(index, update)| RetainedContribution::Outbox {
            outbox_id: outbox_id.clone(),
            sequence: sequence + 1 + index as i64,
            delivery_id: format!("pending-{index:06}"),
            update_digest: hex_sha256(update),
            authors: RetainedAuthors::credited(None, None).unwrap(),
        })
        .collect();
    let binding = protected(&f).expect("its pending entries protect it");
    assert_eq!(coverage_of(binding.clone()), [committed(entries.clone())], "the tail commits to every entry");
    (f, binding, entries)
}

/// Sol's r2c-3c-10 finding 1: each contradiction validation keeps, its
/// namespace among it, is reserved before it is made. A tail in a namespace
/// of 1,000 bytes, whose 1,000 pending entries each declare an agent that
/// does not validate, reserves at its peak, beside the window, the other
/// tail's kept work and its own activation and validation, every
/// contradiction's namespace once as validation makes it and again in the
/// work it keeps.
#[test]
fn a_tail_reserves_each_contradiction_before_it_keeps_it() {
    let long = "n".repeat(1_000);
    let (mut f, _, _) = released_with_pending_entries(1_000);
    write_unchecked(&mut f, &format!("PRAGMA foreign_keys=OFF;
        UPDATE owner_ydoc_outbox_entries SET agent_declaration_json='{{\"agentId\":\"\",\"onBehalfOf\":null,\"depth\":0}}'
        WHERE delivery_id LIKE 'pending-%';
        CREATE TEMP TABLE copied AS SELECT * FROM live_owner_activations WHERE activation_id='adoption';
        UPDATE copied SET relay_database_namespace='{long}';
        INSERT INTO live_owner_activations SELECT * FROM copied"));
    let (window, tails) = window_workloads(&f, &["namespace", long.as_str()]);
    let within = within_memory(&f, 1 << 40, |conn, stop| window_of(conn, &f, stop));
    let Ok(Some(released_protection::WindowWork::Listed(listed))) = within.answer else {
        panic!("two tails validate")
    };
    let named: Vec<&str> = listed.iter().map(|(tail, _)| tail.namespace.as_str()).collect();
    assert_eq!(named, ["namespace", long.as_str()]);
    let (tail, work) = &listed[1];
    assert_eq!(tail.coverage, RetainedCoverage::Invalid);
    let found = work.contradictions.len() as u64;
    assert!(found >= 1_000, "every entry contradicts its tail: {found}");
    assert!(work.contradictions.iter().all(|contradiction| contradiction.namespace.as_deref() == Some(long.as_str())));
    let kept: Vec<u64> = listed.iter().map(|(tail, work)| released_protection::tail_kept_bytes(tail, work)).collect();
    let (activation, validation) = tails[1];
    assert!(
        within.peak >= window + kept[0] + activation + validation + found * long.len() as u64 + kept[1],
        "{} reserved, its contradictions' namespaces {} bytes",
        within.peak,
        found * long.len() as u64
    );
}
