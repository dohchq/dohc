/// The Carried delivery `receipt` names, with its entry's native sequence.
fn carried_delivery(f: &Fixture, receipt: &LiveUpdateReceipt) -> CarriedDelivery {
    let native_sequence = f
        .store
        .read_with(|conn| {
            conn.query_row(
                "SELECT json_extract(native_source_json,'$.nativeSequence') FROM owner_ydoc_outbox_entries WHERE delivery_id=?1",
                [&receipt.delivery_id],
                |r| r.get(0),
            )
        })
        .unwrap();
    CarriedDelivery { receipt: receipt.clone(), native_sequence }
}

/// The Carried deliveries a released activation's manifest lists.
fn manifest(f: &Fixture, id: &str) -> Vec<CarriedDelivery> {
    f.store.read_with(|conn| retirement::released_tail(conn, "namespace", id)).unwrap().1
}

/// How many inherited entries the chain ending at `tail` resolves to.
fn resolve(f: &Fixture, tail: &str) -> Result<usize, ApplicationError> {
    f.store.read_with(|conn| {
        retirement::inherited_entries(conn, "namespace", &f.key, &f.binding.lineage_claim_id, Some(tail))
            .map(|entries| entries.len())
    })
}

/// A released predecessor, `adoption`, whose native updates C1 and C2 the
/// relay accepted at 5 and 6 after the update it applied at 3, and its
/// successor S1, adopted with its seed pending and nothing applied. Returns
/// the covered receipt and C1's and C2's Carried deliveries.
fn carried_twice() -> (Fixture, LiveUpdateReceipt, CarriedDelivery, CarriedDelivery) {
    let (mut f, covered, c1, _) = covered_and_carried();
    let second = native_tail_edit(&mut f, "# Carried again\n", 13);
    let c2 = receipt_of(&second.delivery_id, &second.update_digest, 6);
    acknowledge_entry(&mut f, &c2);
    host_document(&mut f, true, true);
    retirement_settle(&mut f, 10, Some(covered.clone())).unwrap();
    release_parked(&mut f);
    let (c1, c2) = (carried_delivery(&f, &c1), carried_delivery(&f, &c2));
    assert_eq!(manifest(&f, "adoption"), vec![c1.clone(), c2.clone()]);
    write(&mut f, "DELETE FROM ydoc_deferred_updates");
    importable(&mut f);
    returned(&mut f);
    file_matches_local(&mut f, "returned");
    successor(&mut f);
    f.adopt().unwrap();
    (f, covered, c1, c2)
}

/// The journal proves the current activation's seed absent, so
/// reconciliation abandons it.
fn abandon_seed(f: &mut Fixture) {
    let absent = JournalEvidence { receipts: vec![], absent: vec![pending_seed_delivery(f)] };
    reconcile(f, 10, None, Some(&absent)).unwrap();
}

/// The relay accepts the current activation's seed at `cursor`.
fn accept_seed(f: &mut Fixture, cursor: i64) -> LiveUpdateReceipt {
    let seed = pending_seed_delivery(f);
    let digest: String = f
        .store
        .read_with(|conn| {
            conn.query_row("SELECT update_digest FROM owner_ydoc_outbox_entries WHERE delivery_id=?1", [&seed], |r| r.get(0))
        })
        .unwrap();
    let accepted = receipt_of(&seed, &digest, cursor);
    acknowledge_entry(f, &accepted);
    accepted
}

/// The current activation applies a Carried delivery at its own cursor.
fn apply_carried(f: &mut Fixture, carried: &CarriedDelivery) {
    let delivery = carried.receipt.delivery_id.clone();
    let event = native_tail_event(f, entry_update(f, &delivery), delivery, carried.receipt.journal_cursor);
    assert!(matches!(apply_event(f, event).unwrap(), ApplicationResult::Applied(..)));
}

/// Sol's round 4b ruling, 2(b): the current activation answers for its
/// released chain's Carried deliveries until it applies them. S1 adopts
/// after a predecessor that carried C1 and C2, and is stopped before applying
/// either, or after applying C1 alone. Its release lists the unapplied ones
/// under their original identities and proves the applied one Covered. A
/// capture of the lineage released without adopting keeps them, and S2's
/// coverage accepts them. S1's release replays from what it stored, with no
/// writes, once S2 holds the lineage and applied the earliest of them.
#[test]
fn a_repeated_stop_keeps_the_chains_carried_deliveries() {
    for (applied, captured) in [(false, false), (false, true), (true, false), (true, true)] {
        let case = format!("applied={applied} captured={captured}");
        let (mut f, covered, c1, c2) = carried_twice();
        let first = f.cut.adoption_id.clone();
        let (expected, seed) = if applied {
            let accepted = accept_seed(&mut f, 7);
            apply_carried(&mut f, &c1);
            host_document(&mut f, true, true);
            retirement_settle_as(&mut f, 10, Some(c1.receipt.clone()), "first-retired").unwrap();
            let seed = carried_delivery(&f, &accepted);
            (vec![c2.clone(), seed.clone()], Disposition::Receipt { receipt: seed.receipt })
        } else {
            abandon_seed(&mut f);
            (vec![c1.clone(), c2.clone()], Disposition::Abandoned)
        };
        let boundary = release_parked(&mut f);
        assert_eq!(
            boundary.as_ref().and_then(|boundary| boundary.terminal_receipt.as_ref()),
            Some(if applied { &c1.receipt } else { &covered }),
            "{case}"
        );
        assert_eq!(manifest(&f, &first), expected, "{case}: the chain's deliveries under their original identities");
        let reconciled = reconcile(&mut f, 10, None, None).unwrap();
        returned(&mut f);
        file_matches_local(&mut f, "first-released");
        if captured {
            let capture = capture_imported(&mut f, 1_000_000).unwrap();
            assert_eq!(capture.source.predecessor_activation_id.as_deref(), Some(first.as_str()), "{case}");
            f.cut.adoption_id = capture.activation_id.clone();
            begin(&mut f, 10).unwrap();
            host_document(&mut f, true, false);
            assert!(matches!(release_through(&mut f, 10).unwrap(), Release::Released { .. }), "{case}");
            assert_eq!(manifest(&f, &capture.activation_id), expected, "{case}: a never-adopted release keeps them");
            returned(&mut f);
        }
        let second = successor(&mut f);
        f.adopt().unwrap();
        let coverage = vec![
            (1, Disposition::Receipt { receipt: covered.clone() }),
            (2, Disposition::Receipt { receipt: c1.receipt.clone() }),
            (3, Disposition::Receipt { receipt: c2.receipt.clone() }),
            (4, seed),
        ];
        assert_eq!(succession_row(&f, &second).4, coverage_digest(&coverage), "{case}");
        assert_eq!(seeds(&f).last(), Some(&(second, 5)), "{case}");
        // S2 applies the earliest it inherited, which a recomputed release of
        // S1 would count.
        accept_seed(&mut f, 8);
        apply_carried(&mut f, &expected[0]);
        f.cut.adoption_id = first;
        let before = rows(&f, &RELEASE_WRITES);
        assert_eq!(
            release_through(&mut f, 10).unwrap(),
            Release::Released { replayed: true, boundary },
            "{case}"
        );
        assert_eq!(reconcile(&mut f, 10, None, None).unwrap(), reconciled, "{case}");
        assert_eq!(rows(&f, &RELEASE_WRITES), before, "{case}: a released replay writes nothing");
    }
}

/// A seed the relay accepted and its activation never applied is Carried
/// too, and its activation's capture proves it: S1's seed, once S1 released,
/// resolves for S2 only while that capture holds its full state. Damaged, it
/// refuses the resolution and S2's adoption with no writes.
#[test]
fn an_inherited_seed_is_proven_by_its_capture() {
    for intact in [true, false] {
        let (mut f, _, _, _) = carried_twice();
        let first = f.cut.adoption_id.clone();
        let accepted = accept_seed(&mut f, 7);
        let seed = carried_delivery(&f, &accepted);
        release_parked(&mut f);
        assert_eq!(manifest(&f, &first).last(), Some(&seed));
        returned(&mut f);
        successor(&mut f);
        if !intact {
            write(&mut f, &format!(
                "UPDATE ydoc_owner_activation_sources SET full_state_digest=lineage_claim_id WHERE activation_id='{first}'"
            ));
            assert!(resolve(&f, &first).is_err());
            let before = rows(&f, &SUCCESSION_WRITES);
            assert!(f.adopt().is_err());
            assert_eq!(rows(&f, &SUCCESSION_WRITES), before);
            continue;
        }
        assert_eq!(resolve(&f, &first).unwrap(), 3);
        f.adopt().unwrap();
    }
}

/// A damage to C2's inherited evidence, given the tail whose manifest lists
/// it.
type InheritedDamage = (&'static str, fn(&mut Fixture, &str, &CarriedDelivery));

/// C2's entry, moved to a copy of its outbox that `change` rewrites.
fn move_entry(f: &mut Fixture, c2: &CarriedDelivery, change: &str) {
    write_unchecked(f, &format!(
        "CREATE TEMP TABLE moved AS SELECT * FROM owner_ydoc_outboxes;
         UPDATE moved SET outbox_id='moved',{change};
         INSERT INTO owner_ydoc_outboxes SELECT * FROM moved;
         DROP TABLE moved;
         UPDATE owner_ydoc_outbox_entries SET outbox_id='moved' WHERE delivery_id='{}'",
        c2.receipt.delivery_id
    ));
}

/// Each requirement of an inherited Carried entry, failing alone for C2,
/// refuses the shared resolution, S1's release, and S2's adoption after it,
/// with no writes: no terminal evidence beside its receipt, the listed
/// receipt saved in full, its own digest, its native sequence and that
/// sequence's provenance, its document and lineage, a source in the released
/// chain, and one listing.
#[test]
fn inherited_carried_evidence_refuses_without_writes() {
    let damages: [InheritedDamage; 9] = [
        ("terminal beside a receipt", |f, _, c2| write_unchecked(f, &format!(
            "UPDATE owner_ydoc_outbox_entries SET terminal_reason='authority-refused' WHERE delivery_id='{}'",
            c2.receipt.delivery_id
        ))),
        ("receipt", |f, tail, _| write(f, &format!(
            "UPDATE live_owner_activations SET carried_manifest_json=json_set(carried_manifest_json,
               '$[1].receipt.acceptingHostEpoch',2) WHERE activation_id='{tail}'"
        ))),
        ("digest", |f, tail, c2| {
            // The saved receipt and the manifest agree on bytes the entry never held.
            let other = "a".repeat(64);
            write(f, &format!(
                "UPDATE owner_ydoc_outbox_entries SET accepted_receipt_json=json_set(accepted_receipt_json,
                   '$.updateDigest','{other}') WHERE delivery_id='{}';
                 UPDATE live_owner_activations SET carried_manifest_json=json_set(carried_manifest_json,
                   '$[1].receipt.updateDigest','{other}') WHERE activation_id='{tail}'",
                c2.receipt.delivery_id
            ))
        }),
        ("native sequence", |f, tail, _| write(f, &format!(
            "UPDATE live_owner_activations SET carried_manifest_json=json_set(carried_manifest_json,'$[1].nativeSequence',
               json_extract(carried_manifest_json,'$[1].nativeSequence')+1) WHERE activation_id='{tail}'"
        ))),
        ("native provenance", |f, _, c2| write(f, &format!(
            "UPDATE ydoc_updates SET recorded_at_ms=recorded_at_ms+1 WHERE object_id='object' AND seq={}",
            c2.native_sequence
        ))),
        ("document", |f, _, c2| move_entry(f, c2, "object_id='other'")),
        ("lineage", |f, _, c2| move_entry(f, c2, &format!("lineage_claim_id='{}'", "f".repeat(64)))),
        ("outside the chain", |f, _, c2| {
            // Released activations of the lineage that follow each other, so
            // the chain keeps its one tail.
            release_unadopted(f, "namespace", "object", "stray", None);
            release_unadopted(f, "namespace", "object", "stray-back", Some("stray"));
            write(f, "UPDATE live_owner_activations SET predecessor_activation_id='stray-back' WHERE activation_id='stray'");
            let (sequence, json): (i64, String) = f
                .store
                .read_with(|conn| {
                    conn.query_row(
                        "SELECT sequence,native_source_json FROM owner_ydoc_outbox_entries WHERE delivery_id=?1",
                        [&c2.receipt.delivery_id],
                        |r| Ok((r.get(0)?, r.get(1)?)),
                    )
                })
                .unwrap();
            let mut source: owner_outbox::OwnerOutboxNativeSource = serde_json::from_str(&json).unwrap();
            source.adoption_id = "stray".into();
            write_source(f, sequence, &source);
        }),
        ("listed twice", |f, tail, _| write(f, &format!(
            "UPDATE live_owner_activations SET carried_manifest_json=json_insert(carried_manifest_json,'$[#]',
               json_extract(carried_manifest_json,'$[1]')) WHERE activation_id='{tail}'"
        ))),
    ];
    for (case, damage) in damages {
        // S1's release, while its predecessor's manifest lists C1 and C2.
        let (mut f, _, _, c2) = carried_twice();
        abandon_seed(&mut f);
        assert_eq!(resolve(&f, "adoption").unwrap(), 2, "{case}");
        damage(&mut f, "adoption", &c2);
        assert!(resolve(&f, "adoption").is_err(), "{case}");
        host_document(&mut f, true, true);
        let before = rows(&f, &RELEASE_WRITES);
        let released = release_through(&mut f, 10);
        assert!(matches!(released, Err(ApplicationError::Conflict | ApplicationError::Corrupt)), "{case}: {released:?}");
        assert_eq!(rows(&f, &RELEASE_WRITES), before, "{case}");
        // S2's adoption, once S1's release lists them.
        let (mut f, _, _, c2) = carried_twice();
        let first = f.cut.adoption_id.clone();
        abandon_seed(&mut f);
        release_parked(&mut f);
        returned(&mut f);
        successor(&mut f);
        assert_eq!(resolve(&f, &first).unwrap(), 2, "{case}");
        damage(&mut f, &first, &c2);
        assert!(resolve(&f, &first).is_err(), "{case}");
        let before = rows(&f, &SUCCESSION_WRITES);
        let adopted = f.adopt();
        assert!(matches!(adopted, Err(ApplicationError::Conflict | ApplicationError::Corrupt)), "{case}: {adopted:?}");
        assert_eq!(rows(&f, &SUCCESSION_WRITES), before, "{case}");
    }
}
