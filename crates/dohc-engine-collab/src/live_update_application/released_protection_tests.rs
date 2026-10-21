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
    let tails = tails.bound_to(&f.store);
    match f.store.read_with(|conn| protection(conn, &key, &tails)).unwrap() {
        Protection::Unprotected => None,
        Protection::Protected { binding, head } => {
            assert_eq!(binding.head_digest, hex_sha256(&head.encode_full_state()), "the head it names");
            Some(*binding)
        }
    }
}

/// Every protected tail the window names.
fn listed(binding: ReleasedLineageBinding) -> Vec<ProtectedTail> {
    match std::sync::Arc::unwrap_or_clone(binding.tails) {
        ProtectedTails::Listed(tails) => tails,
        ProtectedTails::Invalid => panic!("a window that reads"),
    }
}

fn coverage(f: &Fixture) -> Vec<RetainedCoverage> {
    listed(protected(f).expect("protected")).into_iter().map(|tail| tail.coverage).collect()
}

/// The unproven work of the one tail that protects the lineage.
fn only_unproven(f: &Fixture) -> Vec<RetainedContribution> {
    match <[RetainedCoverage; 1]>::try_from(coverage(f)) {
        Ok([RetainedCoverage::Unproven(unproven)]) => unproven,
        other => panic!("one tail with readable evidence: {other:?}"),
    }
}

/// What the release of the fixture's tail bound.
fn owner_release() -> Option<TailRelease> {
    Some(TailRelease { path: "owner.md".into(), restore_generation: 0 })
}

fn carried(delivery: &CarriedDelivery) -> RetainedContribution {
    let receipt = &delivery.receipt;
    RetainedContribution::Carried {
        delivery_id: receipt.delivery_id.clone(),
        update_digest: receipt.update_digest.clone(),
        journal_cursor: receipt.journal_cursor,
    }
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
                coverage: RetainedCoverage::Unproven(unproven),
            }])),
        }
    );
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
    assert!(unproven.contains(&carried(&seed)), "an acknowledged seed: {unproven:?}");
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

/// Sol's ingress ruling: `retained_suffix` alone is not enough, and missing
/// or invalid evidence never establishes nothing retained. A saved receipt
/// that never applied, with no Carried listing, protects; a tail record, a
/// Carried entry or a terminal entry that does not read protects as invalid.
/// So does evidence that would otherwise set work aside: a native source
/// without its activation, an application of the same delivery with other
/// bytes, and a saved receipt the matching proof contradicts.
#[test]
fn unproven_or_unreadable_retained_evidence_protects() {
    let mut f = released_without_carried();
    write_unchecked(&mut f, "PRAGMA foreign_keys=OFF;
        DELETE FROM live_device_update_applications; DELETE FROM live_accepted_updates");
    let suffix = f
        .store
        .read_with(|conn| retirement::retained_suffix(conn, "namespace", &f.key, &f.binding.lineage_claim_id))
        .unwrap()
        .unwrap();
    assert_eq!(suffix.earliest_carried, None, "the suffix sees nothing outstanding");
    let unproven = only_unproven(&f);
    assert!(matches!(unproven.as_slice(), [RetainedContribution::Outbox { .. }]), "{unproven:?}");

    type Damaged = (&'static str, fn() -> Fixture);
    let damages: [Damaged; 8] = [
        ("an unreadable tail record", || {
            let mut f = released_without_carried();
            write_unchecked(&mut f, "UPDATE live_owner_activations SET released_boundary_json='{}' WHERE activation_id='adoption'");
            f
        }),
        ("a Carried delivery without its entry", || {
            let (mut f, _, c1, _) = released_at_b();
            write_unchecked(&mut f, &format!("PRAGMA foreign_keys=OFF;
                DELETE FROM owner_ydoc_outbox_entries WHERE delivery_id='{}'", c1.receipt.delivery_id));
            f
        }),
        ("a terminal entry no strict representation explains", || {
            let mut f = released_without_carried();
            write_unchecked(&mut f, "PRAGMA foreign_keys=OFF;
                DELETE FROM live_device_update_applications; DELETE FROM live_accepted_updates;
                UPDATE owner_ydoc_outbox_entries SET accepted_receipt_json=NULL,terminal_reason='refused'");
            f
        }),
        ("a native source naming no activation", || {
            let mut f = released_without_carried();
            write_unchecked(&mut f, "UPDATE owner_ydoc_outbox_entries
                SET native_source_json=json_remove(native_source_json,'$.adoptionId') WHERE native_source_json IS NOT NULL");
            f
        }),
        ("a native source naming an activation the lineage no longer has", || {
            let mut f = released_without_carried();
            write_unchecked(&mut f, "PRAGMA foreign_keys=OFF;
                UPDATE live_owner_activations SET activation_id='renamed' WHERE activation_id='adoption'");
            f
        }),
        ("a Carried delivery applied with other bytes", || {
            let (mut f, _, c1, _) = released_at_b();
            write_unchecked(&mut f, &format!("PRAGMA foreign_keys=OFF;
                CREATE TEMP TABLE copied AS SELECT * FROM live_device_update_applications WHERE journal_cursor=3;
                UPDATE copied SET delivery_id='{}',journal_cursor={};
                INSERT INTO live_device_update_applications SELECT * FROM copied",
                c1.receipt.delivery_id, c1.receipt.journal_cursor));
            f
        }),
        ("an outbox entry applied with other bytes", || {
            let mut f = released_without_carried();
            write_unchecked(&mut f, &format!("PRAGMA foreign_keys=OFF;
                UPDATE live_device_update_applications SET update_digest='{}'", "0".repeat(64)));
            f
        }),
        ("a saved receipt its application and history contradict", || {
            let mut f = released_without_carried();
            write_unchecked(&mut f, "UPDATE owner_ydoc_outbox_entries
                SET accepted_receipt_json=json_set(accepted_receipt_json,'$.journalCursor',4) WHERE accepted_receipt_json IS NOT NULL");
            f
        }),
    ];
    for (case, damaged) in damages {
        let binding = protected(&damaged()).unwrap_or_else(|| panic!("{case}: protected"));
        let coverage: Vec<RetainedCoverage> = listed(binding).into_iter().map(|tail| tail.coverage).collect();
        assert_eq!(coverage, [RetainedCoverage::Invalid], "{case}");
    }
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
/// tail input, here both Carried deliveries applied, validates again.
#[test]
fn validated_tails_stand_until_their_generation_moves() {
    let (mut f, _, c1, c2) = released_at_b();
    let tails = ReleasedTails::default();
    let first = protected_in(&f, &incoming(), &tails).expect("protected");
    assert_eq!(tails.validations(), 1);
    write_unchecked(&mut f, "UPDATE path_aliases SET path='renamed.md' WHERE path='owner.md'");
    let later = protected_in(&f, &incoming(), &tails).expect("kept");
    assert!(std::sync::Arc::ptr_eq(&later.tails, &first.tails), "shared, never copied");
    assert_eq!(tails.validations(), 1, "a path is no tail input");
    assert_eq!(later.current_path.as_deref(), Some("renamed.md"), "the path is each decision's own");
    applied_exactly(&mut f, &c1.receipt);
    applied_exactly(&mut f, &c2.receipt);
    assert!(kept_matches_fresh(&f, &tails).is_none(), "both applied");
    assert_eq!(tails.validations(), 2);
}

/// Sol's tails-cache ruling: a change to a row of any table the tails read
/// moves the document's generation, so kept tails validate again and read as
/// fresh ones; terminal blobs, the ninth, have their own test below. Each
/// change here leaves the answer as it was, and an unrelated blob or a
/// journal row no entry names keeps the tails.
#[test]
fn every_tail_input_moves_the_generation() {
    let (mut f, _, _, _) = released_at_b();
    let tails = ReleasedTails::default();
    kept_matches_fresh(&f, &tails).expect("protected");
    let mut validations = tails.validations();
    let unrelated = [
        "INSERT INTO binary_blobs VALUES ('unrelated',1,X'00')",
        "INSERT INTO ydoc_updates(workspace_id,version_id,object_id,seq,update_blob_sha256,recorded_at_ms)
         SELECT workspace_id,version_id,object_id,seq+1000,update_blob_sha256,recorded_at_ms FROM ydoc_updates
         ORDER BY seq DESC LIMIT 1",
    ];
    for unrelated in unrelated {
        write_unchecked(&mut f, &format!("PRAGMA foreign_keys=OFF; {unrelated}"));
        kept_matches_fresh(&f, &tails).expect("protected");
        assert_eq!(tails.validations(), validations, "{unrelated}");
    }
    let inputs = [
        "UPDATE live_owner_activations SET source_byte_length=source_byte_length",
        "UPDATE owner_ydoc_outboxes SET created_at_ms=created_at_ms",
        "UPDATE owner_ydoc_outbox_entries SET created_at_ms=created_at_ms",
        "UPDATE live_device_update_applications SET received_at_ms=received_at_ms",
        "UPDATE live_accepted_updates SET suffix_count=suffix_count",
        "INSERT INTO ydoc_owner_activation_sources SELECT 'unnamed',relay_database_namespace,workspace_id,
           main_version_id,object_id,lineage_claim_id,source_moment_id,source_digest,source_digest,'{}'
         FROM live_owner_activations",
        "UPDATE ydoc_updates SET recorded_at_ms=recorded_at_ms WHERE seq IN
           (SELECT json_extract(native_source_json,'$.nativeSequence') FROM owner_ydoc_outbox_entries)",
        "UPDATE ydoc_docs SET head_snapshot_seq=head_snapshot_seq+1000;
         UPDATE ydoc_docs SET head_snapshot_seq=head_snapshot_seq-1000",
    ];
    for input in inputs {
        let generation = tail_generation_of(&f);
        write_unchecked(&mut f, &format!("PRAGMA foreign_keys=OFF; {input}"));
        assert!(tail_generation_of(&f) > generation, "{input}");
        kept_matches_fresh(&f, &tails).expect("protected");
        validations += 1;
        assert_eq!(tails.validations(), validations, "{input}");
    }
}

/// The coverage of each tail `binding` lists.
fn coverage_of(binding: ReleasedLineageBinding) -> Vec<RetainedCoverage> {
    listed(binding).into_iter().map(|tail| tail.coverage).collect()
}

/// Sol's tails-cache ruling: changed provenance invalidates what it proved.
/// A Carried delivery's journal row, an application of a Carried delivery
/// that claims another document, and an acknowledged seed's capture each
/// turn kept tails invalid, as fresh validation reads them.
#[test]
fn changed_provenance_invalidates_kept_tails() {
    let (mut f, _, c1, c2) = released_at_b();
    applied_exactly(&mut f, &c1.receipt);
    applied_exactly(&mut f, &c2.receipt);
    let tails = ReleasedTails::default();
    assert!(kept_matches_fresh(&f, &tails).is_none(), "proven");
    write_unchecked(&mut f, &format!("PRAGMA foreign_keys=OFF;
        UPDATE ydoc_updates SET recorded_at_ms=recorded_at_ms+1 WHERE seq={}", c1.native_sequence));
    let binding = kept_matches_fresh(&f, &tails).expect("a journal row that no longer proves the delivery");
    assert_eq!(coverage_of(binding), [RetainedCoverage::Invalid]);

    // The new row's own document is another, so only its delivery names
    // the document whose tails it contradicts.
    let (mut f, _, c1, c2) = released_at_b();
    applied_exactly(&mut f, &c1.receipt);
    let tails = ReleasedTails::default();
    let binding = kept_matches_fresh(&f, &tails).expect("protected");
    assert_eq!(coverage_of(binding), [RetainedCoverage::Unproven(vec![carried(&c2)])]);
    let generation = tail_generation_of(&f);
    write_unchecked(&mut f, &format!("PRAGMA foreign_keys=OFF;
        CREATE TEMP TABLE elsewhere AS SELECT * FROM live_device_update_applications WHERE journal_cursor=3;
        UPDATE elsewhere SET delivery_id='{}',update_digest='{}',journal_cursor={},accepting_host_epoch={},object_id='elsewhere';
        INSERT INTO live_device_update_applications SELECT * FROM elsewhere",
        c2.receipt.delivery_id, c2.receipt.update_digest, c2.receipt.journal_cursor, c2.receipt.accepting_host_epoch));
    assert!(tail_generation_of(&f) > generation, "its delivery names this document");
    let binding = kept_matches_fresh(&f, &tails).expect("an application of the delivery elsewhere");
    assert_eq!(coverage_of(binding), [RetainedCoverage::Invalid]);

    let (mut f, _, carried_deliveries) = resumed_after_catch_up(true, 1);
    accept_seed(&mut f, 7);
    apply_carried(&mut f, &carried_deliveries[0]);
    host_document(&mut f, true, true);
    retire_settled(&mut f, Some(carried_deliveries[0].receipt.clone()), "seed-retired").unwrap();
    release_parked(&mut f);
    returned(&mut f);
    let tails = ReleasedTails::default();
    kept_matches_fresh(&f, &tails).expect("the seed protects");
    write_unchecked(&mut f, &format!("PRAGMA foreign_keys=OFF;
        UPDATE ydoc_owner_activation_sources SET full_state_digest='{}'", "0".repeat(64)));
    let binding = kept_matches_fresh(&f, &tails).expect("protected");
    assert_eq!(coverage_of(binding), [RetainedCoverage::Invalid], "a seed its capture no longer proves");
}

/// Sol's tails-cache ruling: a terminal blob proves a refusal by its bytes.
/// Kept tails that set the refusal aside validate again when they change,
/// and an unrelated blob keeps them.
#[test]
fn a_refusals_terminal_blob_invalidates_kept_tails() {
    let mut f = refused_root(false);
    host_document(&mut f, true, true);
    retirement_settle(&mut f, 10, None).unwrap();
    release_and_return(&mut f);
    let tails = ReleasedTails::default();
    let before = kept_matches_fresh(&f, &tails);
    write_unchecked(&mut f, "INSERT INTO binary_blobs VALUES ('unrelated',1,X'00')");
    assert_eq!(kept_matches_fresh(&f, &tails), before);
    assert_eq!(tails.validations(), 1, "an unrelated blob");
    write_unchecked(&mut f, "PRAGMA foreign_keys=OFF;
        UPDATE binary_blobs SET byte_length=byte_length+1
        WHERE sha256 IN (SELECT terminal_blob_digest FROM owner_ydoc_outbox_entries)");
    let binding = kept_matches_fresh(&f, &tails).expect("a refusal its bytes no longer prove");
    assert_eq!(tails.validations(), 2);
    assert_eq!(coverage_of(binding), [RetainedCoverage::Invalid]);
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

/// Sol's tails-cache ruling: a write transaction that changed the tails
/// decides on its own state and keeps nothing, even after its savepoint
/// rolls back. Back at committed state it reuses what was kept. A later
/// change that reaches the generation a rolled-back transaction read never
/// reuses what that transaction decided.
#[test]
fn a_rolled_back_change_keeps_no_tails() {
    let (mut f, _, c1, c2) = released_at_b();
    let tails = ReleasedTails::default();
    let kept = kept_matches_fresh(&f, &tails).expect("protected");
    let key = ProtectionKey { doc: &f.key, lineage_claim_id: &f.binding.lineage_claim_id, incoming: &incoming() };
    let bound = tails.bound_to(&f.store);
    let mut aborted = None;
    let rolled_back = f.store.write_with(&NoFaults, |tx| {
        tx.execute_batch("PRAGMA defer_foreign_keys=ON; SAVEPOINT tails").map_err(write_sql)?;
        apply_both_in(tx, [&c1.receipt, &c2.receipt])?;
        assert!(matches!(protection(tx, &key, &bound)?, Protection::Unprotected), "its own state");
        tx.execute_batch("ROLLBACK TO tails; RELEASE tails").map_err(write_sql)?;
        let Protection::Protected { binding, .. } = protection(tx, &key, &bound)? else {
            panic!("committed state again");
        };
        assert!(std::sync::Arc::ptr_eq(&binding.tails, &kept.tails), "what committed state kept");
        apply_both_in(tx, [&c1.receipt, &c2.receipt])?;
        assert!(matches!(protection(tx, &key, &bound)?, Protection::Unprotected), "its own state");
        aborted = Some(tx.query_row(
            "SELECT generation FROM released_tail_generations WHERE object_id=?1",
            [&f.key.object_id],
            |row| row.get::<_, i64>(0),
        ).map_err(read_sql)?);
        Err::<(), _>(ApplicationError::Conflict)
    });
    assert!(matches!(rolled_back, Err(ApplicationError::Conflict)), "{rolled_back:?}");
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
/// generations stand. A store with no generation for the document validates
/// each decision and keeps nothing, never assuming one.
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

    let (mut f, _, c1, c2) = released_at_b();
    write_unchecked(&mut f, "DROP TRIGGER released_tail_generation_kept; DELETE FROM released_tail_generations");
    let tails = ReleasedTails::default();
    kept_matches_fresh(&f, &tails).expect("protected");
    applied_exactly(&mut f, &c1.receipt);
    applied_exactly(&mut f, &c2.receipt);
    assert!(kept_matches_fresh(&f, &tails).is_none(), "no generation keeps nothing");
    assert_eq!(tails.validations(), 0);
}

/// Opus's 1a-2b finding 3: a Carried delivery applied exactly is proven
/// only while its accepted history agrees. History of it at another
/// coordinate conflicts, and the tail protects as invalid.
#[test]
fn a_carried_application_its_accepted_history_contradicts_protects() {
    let with_history = |cursor_shift: i64| {
        let (mut f, _, c1, c2) = released_at_b();
        let receipt = &c1.receipt;
        applied_exactly(&mut f, receipt);
        let history = LiveUpdateReceipt { journal_cursor: receipt.journal_cursor + cursor_shift, ..receipt.clone() };
        write_unchecked(&mut f, &format!("PRAGMA foreign_keys=OFF;
            CREATE TEMP TABLE accepted AS SELECT * FROM live_accepted_updates WHERE journal_cursor=3;
            UPDATE accepted SET delivery_id='{}',update_sha256='{}',journal_cursor={},event_count=99,
              metadata_json=json_set(metadata_json,'$.accepted.receipt',json('{}'));
            INSERT INTO live_accepted_updates SELECT * FROM accepted",
            receipt.delivery_id,
            receipt.update_digest,
            receipt.journal_cursor,
            serde_json::to_string(&history).unwrap()));
        (f, c2)
    };
    let (f, c2) = with_history(0);
    assert_eq!(only_unproven(&f), vec![carried(&c2)], "applied, and its history agrees");
    let (f, _) = with_history(100);
    assert_eq!(coverage(&f), [RetainedCoverage::Invalid]);
}

/// Opus's 1a-2b finding 2: a namespace that holds activations of the lineage
/// but no tail, which only a damaged store can hold, does not drop out of the
/// window. The window does not read, so the lineage is protected as invalid.
#[test]
fn a_namespace_with_activations_and_no_tail_protects_as_invalid() {
    let mut f = released_without_carried();
    assert!(protected(&f).is_none(), "nothing retained");
    write_unchecked(&mut f, "PRAGMA foreign_keys=OFF;
        CREATE TEMP TABLE looped AS SELECT * FROM live_owner_activations WHERE activation_id='adoption';
        UPDATE looped SET relay_database_namespace='other',predecessor_activation_id='adoption';
        INSERT INTO live_owner_activations SELECT * FROM looped");
    let window = f.store.read_with(|conn| settled_base::released_window(conn, &f.key, &f.binding.lineage_claim_id));
    assert!(matches!(window, Err(ApplicationError::Corrupt)), "{window:?}");
    let binding = protected(&f).expect("protected");
    assert_eq!(*binding.tails, ProtectedTails::Invalid);
    assert!(binding.moved("owner.md"), "every update holds");
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
        let RetainedCoverage::Unproven(unproven) = &tail.coverage else {
            panic!("{}: readable", tail.namespace);
        };
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
    let fold = fold.rewrite_content_to_markdown_for_fold(ContentKind::Richdoc, &format!("{markdown}\n\nA disk edit.")).unwrap();
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
