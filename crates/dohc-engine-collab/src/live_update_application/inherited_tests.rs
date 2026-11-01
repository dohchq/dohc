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
    carried_twice_at(6)
}

/// [`carried_twice`], with C2 accepted at `cursor`.
fn carried_twice_at(cursor: i64) -> (Fixture, LiveUpdateReceipt, CarriedDelivery, CarriedDelivery) {
    let (mut f, covered, c1, c2) = released_carrying_twice(cursor);
    successor(&mut f);
    f.adopt().unwrap();
    (f, covered, c1, c2)
}

/// [`carried_twice_at`] before its successor captures: the predecessor
/// released with C1 and C2 Carried, its document back in scope with the file
/// holding the local Y.Doc's text.
fn released_carrying_twice(cursor: i64) -> (Fixture, LiveUpdateReceipt, CarriedDelivery, CarriedDelivery) {
    let (mut f, covered, c1, _) = covered_and_carried();
    let second = native_tail_edit(&mut f, "# Carried again\n", 13);
    let c2 = receipt_of(&second.delivery_id, &second.update_digest, cursor);
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

/// A Carried delivery as the relay delivers it, at its own cursor.
fn carried_event(f: &Fixture, carried: &CarriedDelivery) -> AdmittedLiveUpdate {
    let delivery = carried.receipt.delivery_id.clone();
    native_tail_event(f, entry_update(f, &delivery), delivery, carried.receipt.journal_cursor)
}

/// The current activation applies a Carried delivery at its own cursor.
fn apply_carried(f: &mut Fixture, carried: &CarriedDelivery) {
    let event = carried_event(f, carried);
    applies(f, event);
}

/// `event` applies for the first time.
fn applies(f: &mut Fixture, event: AdmittedLiveUpdate) -> LiveUpdateHostApplicationAck {
    let ApplicationResult::Applied(ack, _) = apply_event(f, event).unwrap() else {
        panic!("applied");
    };
    assert!(!ack.application_replayed);
    ack
}

/// Everything an application could write.
const APPLICATION_WRITES: [&str; 12] = [
    "live_device_update_applications",
    "live_device_application_first_seen",
    "live_accepted_updates",
    "live_accepted_checkpoints",
    "ydoc_updates",
    "ydoc_docs",
    "ydoc_snapshots",
    "binary_blobs",
    "owner_ydoc_outboxes",
    "owner_ydoc_outbox_entries",
    "remote_changes",
    "collection_field_history",
];

/// `event` waits for an earlier delivery, and writes nothing.
fn held(f: &mut Fixture, event: AdmittedLiveUpdate) {
    let before = rows(f, &APPLICATION_WRITES);
    let delivery = event.metadata.accepted.receipt.delivery_id.clone();
    assert_eq!(
        apply_event(f, event).unwrap(),
        ApplicationResult::Pending(ApplicationPending::DeliveryPending),
        "{delivery}"
    );
    assert_eq!(rows(f, &APPLICATION_WRITES), before, "{delivery}");
}

/// The current activation's own seed, as the relay delivers it at `cursor`.
fn own_seed_event(f: &Fixture, cursor: i64) -> AdmittedLiveUpdate {
    let seed: String = f
        .store
        .read_with(|conn| {
            conn.query_row(
                "SELECT delivery_id FROM owner_ydoc_outbox_entries
                 WHERE json_extract(native_source_json,'$.origin.kind')='adoptionSeed'
                   AND json_extract(native_source_json,'$.adoptionId')=?1",
                [&f.cut.adoption_id],
                |r| r.get(0),
            )
        })
        .unwrap();
    native_tail_event(f, entry_update(f, &seed), seed, cursor)
}

/// Each delivery accepted history holds, in its order.
fn accepted_deliveries(f: &Fixture) -> Vec<String> {
    f.store
        .read_with(|conn| {
            conn.prepare("SELECT delivery_id FROM live_accepted_updates ORDER BY event_count")?
                .query_map([], |r| r.get(0))?
                .collect::<rusqlite::Result<Vec<_>>>()
        })
        .unwrap()
}

/// Each delivery, applied and recorded in accepted history in this order.
fn applied_in_order(f: &Fixture, deliveries: &[&str]) {
    let expected: Vec<String> = deliveries.iter().map(|delivery| (*delivery).to_owned()).collect();
    assert_eq!(applied_deliveries(f), expected);
    assert_eq!(accepted_deliveries(f), expected);
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
        assert_eq!(succession_row(&f, &second).4, coverage_digest(&f, &coverage), "{case}");
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

/// Sol's round 4b ruling, 2(c): the retained suffix drains while the
/// successor's seed waits for its receipt. C2 cannot overtake C1, each
/// applies once under its original delivery with its accepted history, and a
/// row past F still waits for the seed.
#[test]
fn the_retained_suffix_drains_in_journal_order_while_the_seed_waits() {
    let (mut f, covered, c1, c2) = carried_twice();
    let seed = pending_seed_delivery(&f);
    let early = carried_event(&f, &c2);
    held(&mut f, early);
    apply_carried(&mut f, &c1);
    apply_carried(&mut f, &c2);
    applied_in_order(&f, &[&covered.delivery_id, &c1.receipt.delivery_id, &c2.receipt.delivery_id]);
    assert_eq!(pending_seed_delivery(&f), seed, "the seed still waits for its receipt");
    let past = remote_event(&mut f, 11);
    held(&mut f, past);
}

/// Journal rows between Carried deliveries keep their order: a row before
/// the earliest unapplied one applies, and a row after it waits for it.
#[test]
fn rows_between_carried_deliveries_apply_in_journal_order() {
    let (mut f, covered, c1, c2) = carried_twice_at(8);
    let (r4, r7, r9) = (remote_event(&mut f, 4), remote_event(&mut f, 7), remote_event(&mut f, 9));
    applies(&mut f, r4);
    held(&mut f, r7.clone());
    apply_carried(&mut f, &c1);
    applies(&mut f, r7);
    held(&mut f, r9.clone());
    apply_carried(&mut f, &c2);
    applies(&mut f, r9);
    applied_in_order(&f, &[
        &covered.delivery_id,
        "remote-4",
        &c1.receipt.delivery_id,
        "remote-7",
        &c2.receipt.delivery_id,
        "remote-9",
    ]);
}

/// The successor's seed applies only after the retained suffix drains,
/// whether its receipt is still pending or was saved first.
#[test]
fn the_seed_cannot_overtake_the_retained_suffix() {
    for receipt_first in [false, true] {
        let (mut f, covered, c1, c2) = carried_twice();
        let seed = own_seed_event(&f, 11);
        if receipt_first {
            accept_seed(&mut f, 11);
        }
        held(&mut f, seed.clone());
        apply_carried(&mut f, &c1);
        held(&mut f, seed.clone());
        apply_carried(&mut f, &c2);
        let delivery = seed.metadata.accepted.receipt.delivery_id.clone();
        applies(&mut f, seed);
        applied_in_order(&f, &[&covered.delivery_id, &c1.receipt.delivery_id, &c2.receipt.delivery_id, &delivery]);
    }
}

/// Sol's 1a-2b finding: once every Carried delivery has an application, the
/// suffix still resolves each one and checks its application exactly. One
/// applied at another accepting epoch conflicts, so a later delivery refuses
/// with nothing written.
#[test]
fn a_conflicting_carried_application_refuses_after_every_carried_delivery_applied() {
    let (mut f, _, c1, c2) = carried_twice();
    apply_carried(&mut f, &c1);
    apply_carried(&mut f, &c2);
    let later = remote_event(&mut f, 11);
    held(&mut f, later.clone());
    write_unchecked(&mut f, &format!(
        "UPDATE live_device_update_applications SET accepting_host_epoch=2 WHERE delivery_id='{}'",
        c1.receipt.delivery_id
    ));
    let before = rows(&f, &APPLICATION_WRITES);
    assert!(matches!(apply_event(&mut f, later), Err(ApplicationError::Conflict)));
    assert_eq!(rows(&f, &APPLICATION_WRITES), before, "a refusal writes nothing");
}

/// An applied Carried delivery, delivered again exactly, returns its saved
/// ACK and writes nothing, before and after the suffix drains and after a
/// restart. A replay that changes its bytes, digest, receipt or cursor, or
/// names another delivery at its cursor, conflicts and writes nothing.
#[test]
fn an_applied_carried_delivery_replays_exactly_or_conflicts() {
    let (mut f, _, c1, c2) = carried_twice();
    let event = carried_event(&f, &c1);
    let ack = applies(&mut f, event.clone());
    let saved = LiveUpdateHostApplicationAck { application_replayed: true, ..ack };
    for drained in [false, true] {
        if drained {
            apply_carried(&mut f, &c2);
            reopen(&mut f);
        }
        let before = rows(&f, &APPLICATION_WRITES);
        assert_eq!(apply_event(&mut f, event.clone()).unwrap(), ApplicationResult::Applied(saved.clone(), vec![]));
        assert_eq!(rows(&f, &APPLICATION_WRITES), before, "drained={drained}: a retry writes nothing");
    }
    let other = entry_update(&f, &c2.receipt.delivery_id);
    let mut changes: Vec<(&str, AdmittedLiveUpdate)> = Vec::new();
    let mut cursor = event.clone();
    cursor.metadata.accepted.receipt.journal_cursor = 9;
    changes.push(("cursor", cursor));
    let mut epoch = event.clone();
    epoch.metadata.accepted.receipt.accepting_host_epoch = 2;
    changes.push(("receipt", epoch));
    changes.push(("bytes and digest", native_tail_event(&f, other, c1.receipt.delivery_id.clone(), 5)));
    changes.push(("another delivery at its cursor", native_tail_event(&f, entry_update(&f, &c1.receipt.delivery_id), "other".into(), 5)));
    for (case, changed) in changes {
        let before = rows(&f, &APPLICATION_WRITES);
        assert!(matches!(apply_event(&mut f, changed), Err(ApplicationError::Conflict)), "{case}");
        assert_eq!(rows(&f, &APPLICATION_WRITES), before, "{case}");
    }
}

/// A successor of a successor drains what both predecessors carried, in
/// journal order: C2 from the first, and the seed S1 had accepted at 7 but
/// never applied. Its own seed waits for both.
#[test]
fn a_second_successor_drains_both_predecessors_carried_deliveries() {
    let (mut f, covered, c1, c2) = carried_twice();
    let first = f.cut.adoption_id.clone();
    let accepted = accept_seed(&mut f, 7);
    apply_carried(&mut f, &c1);
    host_document(&mut f, true, true);
    retirement_settle_as(&mut f, 10, Some(c1.receipt.clone()), "first-retired").unwrap();
    release_parked(&mut f);
    let s1_seed = carried_delivery(&f, &accepted);
    assert_eq!(manifest(&f, &first), vec![c2.clone(), s1_seed.clone()]);
    returned(&mut f);
    file_matches_local(&mut f, "first-released");
    successor(&mut f);
    f.adopt().unwrap();
    let own = own_seed_event(&f, 11);
    let inherited_seed = carried_event(&f, &s1_seed);
    held(&mut f, inherited_seed);
    held(&mut f, own.clone());
    apply_carried(&mut f, &c2);
    held(&mut f, own.clone());
    apply_carried(&mut f, &s1_seed);
    let delivery = own.metadata.accepted.receipt.delivery_id.clone();
    applies(&mut f, own);
    applied_in_order(&f, &[
        &covered.delivery_id,
        &c1.receipt.delivery_id,
        &c2.receipt.delivery_id,
        &s1_seed.receipt.delivery_id,
        &delivery,
    ]);
}

/// A collaborator's paragraph `index`, as ordinary sync brings it while live
/// editing is stopped: a native row no live delivery applied.
fn catch_up_row(f: &mut Fixture, index: i64) {
    let bytes = f.doc.richdoc_append_paragraph(&format!("Caught up {index}"));
    let remote = crate::RemoteUpdate { origin_id: "peer".into(), origin_seq: index, bytes };
    let applied = crate::apply_remote_update(&mut f.store, &mut WriterDocCache::new(), &f.key, &remote, None, None, &NoFaults, 40 + index)
        .unwrap();
    assert!(matches!(applied.outcome, TxnOutcome::Committed(crate::ReplicationApplyOutcome::Applied { .. })));
}

/// A root whose native update the host applied at 3 and, with `carried`,
/// whose updates C1 and C2 the relay accepted at 5 and 6 without the host
/// applying them, released after its settlement through F. Ordinary sync then
/// adds `catch_up` rows before S1 captures and adopts, its seed pending.
/// Returns the covered receipt and the Carried deliveries.
fn resumed_after_catch_up(carried: bool, catch_up: i64) -> (Fixture, LiveUpdateReceipt, Vec<CarriedDelivery>) {
    let mut f = Fixture::new();
    f.adopt().unwrap();
    let covered = native_tail_edit(&mut f, "# Covered\n", 11);
    native_tail_apply(&mut f, covered.update.clone(), covered.delivery_id.clone(), 3);
    let covered = receipt_of(&covered.delivery_id, &covered.update_digest, 3);
    acknowledge_entry(&mut f, &covered);
    let mut accepted = Vec::new();
    if carried {
        for (text, cursor) in [("# Carried\n", 5), ("# Carried again\n", 6)] {
            let entry = native_tail_edit(&mut f, text, 10 + cursor);
            let receipt = receipt_of(&entry.delivery_id, &entry.update_digest, cursor);
            acknowledge_entry(&mut f, &receipt);
            accepted.push(receipt);
        }
    }
    host_document(&mut f, true, true);
    retirement_settle(&mut f, 10, Some(covered.clone())).unwrap();
    release_parked(&mut f);
    let carried: Vec<CarriedDelivery> = accepted.iter().map(|receipt| carried_delivery(&f, receipt)).collect();
    assert_eq!(manifest(&f, "adoption"), carried);
    importable(&mut f);
    returned(&mut f);
    for index in 1..=catch_up {
        catch_up_row(&mut f, index);
    }
    file_matches_local(&mut f, "returned");
    successor(&mut f);
    f.adopt().unwrap();
    (f, covered, carried)
}

/// The text a settlement recorded as `moment`.
fn moment_text(f: &Fixture, moment: &str) -> String {
    f.store
        .read_with(|conn| {
            conn.query_row(
                "SELECT b.text FROM moments m JOIN blobs b ON b.sha256=m.after_blob_sha256 WHERE m.moment_id=?1",
                [moment],
                |r| r.get(0),
            )
        })
        .unwrap()
}

/// The native head the current activation's adoption verified.
fn adopted_head(f: &Fixture) -> i64 {
    f.store
        .read_with(|conn| {
            conn.query_row(
                "SELECT local_ydoc_sequence FROM live_owner_activations WHERE activation_id=?1",
                [&f.cut.adoption_id],
                |r| r.get(0),
            )
        })
        .unwrap()
}

/// The native sequence a stored settlement's coverage started after.
fn coverage_floor(f: &Fixture, settlement: &str) -> i64 {
    f.store
        .read_with(|conn| {
            conn.query_row(
                "SELECT previous_ydoc_sequence FROM live_device_settlements WHERE settlement_id=?1",
                [settlement],
                |r| r.get(0),
            )
        })
        .unwrap()
}

/// Everything a settlement records.
const SETTLEMENT_WRITES: [&str; 4] = [
    "live_device_settlements",
    "live_settlement_attribution_unavailable",
    "live_settlement_publication_states",
    "moments",
];

/// `settle` replays `stored`, before and after a restart: the same result,
/// with no writes.
fn replays(f: &mut Fixture, stored: &LiveSettlementResult, settle: impl Fn(&mut Fixture) -> Result<LiveSettlementResult, ApplicationError>) {
    let stored = serde_json::to_value(stored).unwrap();
    for restart in [false, true] {
        if restart {
            reopen(f);
        }
        let before = rows(f, &SETTLEMENT_WRITES);
        assert_eq!(serde_json::to_value(settle(f).unwrap()).unwrap(), stored, "restart={restart}");
        assert_eq!(rows(f, &SETTLEMENT_WRITES), before, "restart={restart}: a replay writes nothing");
    }
}

/// Sol's round 4b ruling, 2(a): a successor's settlement projects accepted
/// state at its terminal, never a delivery it has not applied, whatever
/// receipt it saved. With C1 applied and C2 not, only C1's content settles;
/// once C2 applies, the next settlement holds it; once S1's own seed applies,
/// the next holds what ordinary sync brought before its capture. The seed's
/// receipt is saved before C1 applies or after it, before the suffix drains
/// either way, and ordinary sync adds rows before the capture or none.
#[test]
fn a_successor_settles_only_what_it_applied() {
    for (receipt_first, catch_up) in [(true, 0), (false, 0), (true, 2)] {
        let case = format!("receipt_first={receipt_first} catch_up={catch_up}");
        let (mut f, _, carried) = resumed_after_catch_up(true, catch_up);
        let (c1, c2) = (&carried[0], &carried[1]);
        let early = receipt_first.then(|| accept_seed(&mut f, 11));
        apply_carried(&mut f, c1);
        let seed = early.unwrap_or_else(|| accept_seed(&mut f, 11));
        let first = settle_as(&mut f, Some(c1.receipt.clone()), "first-settled").unwrap();
        assert_eq!((first.previous_cursor, first.terminal_cursor), (3, 5), "{case}");
        let text = moment_text(&f, "first-settled");
        assert!(text.contains("Carried") && !text.contains("again") && !text.contains("Caught up"), "{case}: {text}");
        apply_carried(&mut f, c2);
        settle_as(&mut f, Some(c2.receipt.clone()), "second-settled").unwrap();
        let text = moment_text(&f, "second-settled");
        assert!(text.contains("Carried again") && !text.contains("Caught up"), "{case}: {text}");
        let own = own_seed_event(&f, 11);
        applies(&mut f, own);
        settle_as(&mut f, Some(seed), "resumed").unwrap();
        assert_eq!(moment_text(&f, "resumed").contains("Caught up"), catch_up > 0, "{case}");
    }
}

/// The current activation's own native update stays out of its settlement
/// while the relay's receipt is all it has: acknowledgement alone exposes
/// nothing. Applied, it settles.
#[test]
fn an_acknowledged_own_update_settles_once_applied() {
    let mut f = Fixture::new();
    f.adopt().unwrap();
    let remote = remote_event(&mut f, 3);
    let terminal = remote.metadata.accepted.receipt.clone();
    applies(&mut f, remote);
    let own = native_tail_edit(&mut f, "# Own edit\n", 11);
    let accepted = receipt_of(&own.delivery_id, &own.update_digest, 5);
    acknowledge_entry(&mut f, &accepted);
    settle_as(&mut f, Some(terminal), "acknowledged").unwrap();
    let text = moment_text(&f, "acknowledged");
    assert!(text.contains("Remote paragraph 3") && !text.contains("Own edit"), "{text}");
    native_tail_apply(&mut f, own.update.clone(), own.delivery_id.clone(), 5);
    settle_as(&mut f, Some(accepted), "applied").unwrap();
    assert!(moment_text(&f, "applied").contains("Own edit"));
}

/// An unapplied inherited delivery keeps the tail private below the coverage
/// floor too. S1, its seed abandoned so nothing of its own is private, and
/// nothing applied: C1 and C2 alone make its tail private, and its settlement
/// at B projects only the accepted state its predecessor settled.
#[test]
fn an_inherited_delivery_below_the_floor_stays_private() {
    let (mut f, covered, carried) = resumed_after_catch_up(true, 0);
    abandon_seed(&mut f);
    let floor = adopted_head(&f);
    assert!(carried.iter().all(|delivery| delivery.native_sequence <= floor));
    let tail = {
        let held = f.handle.registration.lock().unwrap();
        f.store.read_with(|conn| settlement::private_tail(conn, &held, floor, floor, 0)).unwrap()
    };
    assert!(tail.any && tail.sequences.is_empty());
    let key = retirement_key(&f, 10);
    let projected = with_retirement_settlement(
        &mut f.store,
        &retirement_scope(),
        &key,
        &retirement_host(),
        Some(covered),
        128,
        NativeHistoryReconstruction { working_reserve_bytes: 8 * 1024 * 1024 },
        |_, audit| -> Result<_, ApplicationError> {
            Ok(audit.accepted_prefix().map(|doc| doc.project(ContentKind::Richdoc).map(|projection| projection.content)))
        },
    )
    .unwrap()
    .expect("an accepted prefix")
    .unwrap();
    assert_eq!(projected, moment_text(&f, "retired"));
    assert!(!projected.contains("Carried"), "{projected}");
}

/// The before-image is lineage-wide and a stored settlement keeps its
/// identity. A successor with nothing applied since its predecessor's
/// settlement at B, and nothing private, settles at B: that replays the
/// predecessor's settlement as stored, its coverage starting where the
/// predecessor's did rather than at the successor's adopted head, with no
/// writes, after a restart too.
#[test]
fn a_successor_replays_its_predecessors_settlement_as_stored() {
    let mut f = Fixture::new();
    f.adopt().unwrap();
    let remote = remote_event(&mut f, 3);
    let terminal = remote.metadata.accepted.receipt.clone();
    applies(&mut f, remote);
    host_document(&mut f, true, true);
    let settled = retirement_settle(&mut f, 10, Some(terminal.clone())).unwrap();
    release_parked(&mut f);
    importable(&mut f);
    returned(&mut f);
    successor(&mut f);
    f.adopt().unwrap();
    assert!(seeds(&f).is_empty());
    assert!(coverage_floor(&f, settled.settlement_id.as_deref().unwrap()) < adopted_head(&f));
    replays(&mut f, &settled, |f| settle_as(f, Some(terminal.clone()), "retired"));
}

/// Ordinary sync's rows between a release and the successor's adoption are
/// covered by the successor's verified capture, with Carried deliveries and
/// without. Its first settlement starts coverage at its adopted head and its
/// journal interval at its predecessor's settlement, and no application is
/// recorded for those rows. Replayed after a restart, it answers what it
/// stored and writes nothing.
#[test]
fn catch_up_rows_before_adoption_need_no_application() {
    for carried in [false, true] {
        let (mut f, covered, inherited) = resumed_after_catch_up(carried, 2);
        let adopted = adopted_head(&f);
        let seed = accept_seed(&mut f, 11);
        let terminal = if carried {
            apply_carried(&mut f, &inherited[0]);
            inherited[0].receipt.clone()
        } else {
            let own = own_seed_event(&f, 11);
            applies(&mut f, own);
            seed
        };
        let first = settle_as(&mut f, Some(terminal.clone()), "resumed").unwrap();
        assert_eq!(first.previous_cursor, 3, "carried={carried}");
        assert_eq!(coverage_floor(&f, first.settlement_id.as_deref().unwrap()), adopted, "carried={carried}");
        assert_eq!(applied_deliveries(&f), [covered.delivery_id.clone(), terminal.delivery_id.clone()], "carried={carried}");
        replays(&mut f, &first, |f| settle_as(f, Some(terminal.clone()), "resumed"));
    }
}

/// What a settlement audit at `terminal` projects, through the fixture's
/// handle or, with `retiring`, in the retirement form, recording nothing:
/// accepted state while its tail keeps anything private, otherwise none.
fn audited(f: &mut Fixture, retiring: bool, terminal: Option<LiveUpdateReceipt>) -> Result<Option<String>, ApplicationError> {
    fn project(_: &mut EngineStore, audit: &LiveSettlementAudit) -> Result<Option<String>, ApplicationError> {
        Ok(match audit.accepted_prefix() {
            Some(doc) => Some(doc.project(ContentKind::Richdoc)?.content),
            None => None,
        })
    }
    let reconstruction = NativeHistoryReconstruction { working_reserve_bytes: 8 * 1024 * 1024 };
    if retiring {
        let key = retirement_key(f, 10);
        with_retirement_settlement(&mut f.store, &retirement_scope(), &key, &retirement_host(), terminal, 128, reconstruction, project)
    } else {
        with_settlement(&mut f.store, &f.handle, terminal, 128, reconstruction, project)
    }
}

/// The settlement audit at the stored settlement's terminal B keeps the tail
/// private and projects what that settlement stored as `moment`, before and
/// after a restart, with no writes.
fn audits_as_stored(f: &mut Fixture, retiring: bool, terminal: LiveUpdateReceipt, moment: &str, case: &str) {
    let stored = moment_text(f, moment);
    for restart in [false, true] {
        if restart {
            reopen(f);
        }
        let before = rows(f, &SETTLEMENT_WRITES);
        let projected = audited(f, retiring, Some(terminal.clone()));
        assert_eq!(projected.as_ref().ok().and_then(Option::as_deref), Some(stored.as_str()), "{case} restart={restart}: {projected:?}");
        assert_eq!(rows(f, &SETTLEMENT_WRITES), before, "{case} restart={restart}: an audit writes nothing");
    }
}

/// `damage` leaves the settlement audit at B Corrupt, in the ordinary form,
/// with no writes.
fn audit_is_corrupt(f: &mut Fixture, terminal: Option<LiveUpdateReceipt>, damage: impl FnOnce(&mut Fixture), case: &str) {
    damage(f);
    let before = rows(f, &[&SETTLEMENT_WRITES[..], &APPLICATION_WRITES[..]].concat());
    let audit = audited(f, false, terminal);
    assert!(matches!(audit, Err(ApplicationError::Corrupt)), "{case}: {audit:?}");
    assert_eq!(rows(f, &[&SETTLEMENT_WRITES[..], &APPLICATION_WRITES[..]].concat()), before, "{case}");
}

/// The native sequence the entry `delivery` queued.
fn native_sequence_of(f: &Fixture, delivery: &str) -> i64 {
    f.store
        .read_with(|conn| {
            conn.query_row(
                "SELECT json_extract(native_source_json,'$.nativeSequence') FROM owner_ydoc_outbox_entries WHERE delivery_id=?1",
                [delivery],
                |r| r.get(0),
            )
        })
        .unwrap()
}

/// A root applies a remote prefix at 3. The relay accepts its `count` native
/// updates at 5 and on, and it settles the prefix at B with coverage starting
/// at its adopted head. It releases the later updates as Carried.
/// S1 then captures straight away, with no catch-up rows, and adopts: its
/// seed waits at the last Carried update's native sequence.
fn carried_since_the_floor(count: i64) -> (Fixture, LiveUpdateReceipt, Vec<CarriedDelivery>) {
    let mut f = Fixture::new();
    f.adopt().unwrap();
    let floor = adopted_head(&f);
    let remote = remote_event(&mut f, 3);
    let covered = remote.metadata.accepted.receipt.clone();
    applies(&mut f, remote);
    let mut accepted = Vec::new();
    for index in 0..count {
        let entry = native_tail_edit(&mut f, &format!("# Carried {index}\n"), 11 + index);
        let receipt = receipt_of(&entry.delivery_id, &entry.update_digest, 5 + index);
        acknowledge_entry(&mut f, &receipt);
        accepted.push(receipt);
    }
    host_document(&mut f, true, true);
    let settled = retirement_settle(&mut f, 10, Some(covered.clone())).unwrap();
    assert_eq!(coverage_floor(&f, settled.settlement_id.as_deref().unwrap()), floor);
    release_parked(&mut f);
    let carried: Vec<CarriedDelivery> = accepted.iter().map(|receipt| carried_delivery(&f, receipt)).collect();
    assert_eq!(manifest(&f, "adoption"), carried);
    importable(&mut f);
    returned(&mut f);
    file_matches_local(&mut f, "returned");
    successor(&mut f);
    f.adopt().unwrap();
    let last = carried.last().unwrap().native_sequence;
    assert_eq!(native_sequence_of(&f, &pending_seed_delivery(&f)), last, "the seed shares the last Carried sequence");
    (f, covered, carried)
}

/// Opus's and Sol's 4b1c reviews: coverage counts distinct native sequences.
/// S1's seed names its captured head, the native sequence of its
/// predecessor's last Carried update, and every row since the stored floor is
/// unapplied. Settled at B, in the ordinary and the retirement form, a
/// pending seed still refuses the settlement. Acknowledged, the settlement
/// replays the stored range and projects what the predecessor settled, before
/// and after a restart, with no writes. The seed keeps its own validation:
/// damaged, it is Corrupt though its sequence is already counted.
#[test]
fn a_seed_at_a_carried_sequence_settles_at_b() {
    for count in [1, 2] {
        for retiring in [false, true] {
            let case = format!("count={count} retiring={retiring}");
            let (mut f, covered, _) = carried_since_the_floor(count);
            let before = rows(&f, &SETTLEMENT_WRITES);
            let pending = audited(&mut f, retiring, Some(covered.clone()));
            assert!(
                matches!(pending, Err(ApplicationError::InvalidInput("the owner's adoption seed must be accepted before a settlement"))),
                "{case}: {pending:?}"
            );
            assert_eq!(rows(&f, &SETTLEMENT_WRITES), before, "{case}");
            accept_seed(&mut f, 11);
            audits_as_stored(&mut f, retiring, covered, "retired", &case);
            assert!(!moment_text(&f, "retired").contains("Carried"), "{case}");
        }
        let (mut f, covered, _) = carried_since_the_floor(count);
        let seed = pending_seed_delivery(&f);
        accept_seed(&mut f, 11);
        audit_is_corrupt(&mut f, Some(covered), |f| write(f, &format!(
            "UPDATE owner_ydoc_outbox_entries SET append_key='owner-adoption:'||printf('%.64c','f') WHERE delivery_id='{seed}'"
        )), &format!("count={count}: a damaged seed at a counted sequence"));
    }
}

/// A chain seed shares a native sequence with its predecessor's last update.
/// S1's seed, accepted and never applied, is Carried beside C2 at C2's
/// sequence; S2 inherits both and its own seed names that sequence too.
/// Acknowledged, S2's settlement at B replays the stored range, before and
/// after a restart, with no writes.
#[test]
fn a_chain_seed_shares_its_predecessors_last_sequence() {
    let (mut f, covered, carried) = carried_since_the_floor(2);
    let first = f.cut.adoption_id.clone();
    let accepted = accept_seed(&mut f, 7);
    release_parked(&mut f);
    let s1_seed = carried_delivery(&f, &accepted);
    assert_eq!(manifest(&f, &first), [carried.clone(), vec![s1_seed.clone()]].concat());
    assert_eq!(s1_seed.native_sequence, carried[1].native_sequence);
    returned(&mut f);
    successor(&mut f);
    f.adopt().unwrap();
    assert_eq!(native_sequence_of(&f, &pending_seed_delivery(&f)), s1_seed.native_sequence);
    accept_seed(&mut f, 11);
    audits_as_stored(&mut f, false, covered, "retired", "a chain seed");
}

/// P adopts with no seed, applies a remote prefix, and a host refuses its
/// native update. P settles the prefix at B and releases. S adopts through the Refused
/// coverage and its seed waits at the refused update's native sequence.
fn refused_then_resumed() -> (Fixture, LiveUpdateReceipt) {
    let (mut f, covered) = refused_root_with_accepted_prefix();
    host_document(&mut f, true, true);
    retirement_settle(&mut f, 10, Some(covered.clone())).unwrap();
    release_and_return(&mut f);
    successor(&mut f);
    f.adopt().unwrap();
    let refused: String = f
        .store
        .read_with(|conn| conn.query_row("SELECT delivery_id FROM owner_ydoc_outbox_entries WHERE sequence=1", [], |r| r.get(0)))
        .unwrap();
    assert_eq!(native_sequence_of(&f, &pending_seed_delivery(&f)), native_sequence_of(&f, &refused));
    (f, covered)
}

/// Sol's 4b1c review: a refusal the released chain left stays private on
/// replay. P's refused update lies above the stored floor and names P, not
/// S. Settled at B, it keeps the tail private, and the projection holds only
/// accepted state, never the refused content S's local Y.Doc still holds:
/// with S's seed acknowledged, and with it abandoned so that the refusal
/// alone keeps the tail private, below the floor too. Before and after a
/// restart, with no writes.
#[test]
fn a_predecessors_refusal_stays_private_on_replay() {
    for abandoned in [false, true] {
        let case = format!("abandoned={abandoned}");
        let (mut f, covered) = refused_then_resumed();
        if abandoned {
            abandon_seed(&mut f);
            let head = adopted_head(&f);
            let tail = {
                let held = f.handle.registration.lock().unwrap();
                f.store.read_with(|conn| settlement::private_tail(conn, &held, head, head, 0)).unwrap()
            };
            assert!(tail.any && tail.sequences.is_empty(), "{case}");
        } else {
            accept_seed(&mut f, 11);
        }
        audits_as_stored(&mut f, abandoned, covered, "retired", &case);
        assert!(!moment_text(&f, "retired").contains("Refused"), "{case}");
    }
}

/// A damage to the predecessor's refused entry.
type ChainRefusalDamage = (&'static str, fn(&mut Fixture));

/// Only a strict refusal by an activation of the released chain stays
/// private. One whose source names an activation outside the chain, or one
/// released only in another namespace, one failing the strict
/// representation, and another activation's pending entry leave the
/// settlement Corrupt, with no writes.
#[test]
fn another_activations_entry_outside_a_chain_refusal_is_corrupt() {
    let damages: [ChainRefusalDamage; 4] = [
        ("outside the chain", |f| {
            // Released activations of the lineage that follow each other, so
            // the chain keeps its one tail.
            release_unadopted(f, "namespace", "object", "stray", None);
            release_unadopted(f, "namespace", "object", "stray-back", Some("stray"));
            write(f, "UPDATE live_owner_activations SET predecessor_activation_id='stray-back' WHERE activation_id='stray'");
            rewrite_source(f, |source| source.adoption_id = "stray".into());
        }),
        ("another namespace", |f| {
            release_unadopted(f, "elsewhere", "object", "foreign", None);
            rewrite_source(f, |source| source.adoption_id = "foreign".into());
        }),
        ("invalid reason", |f| write(f, "UPDATE owner_ydoc_outbox_entries SET terminal_reason='refused'||char(10) WHERE sequence=1")),
        ("pending", |f| write_unchecked(f, "UPDATE owner_ydoc_outbox_entries SET pending=1 WHERE sequence=1")),
    ];
    for (case, damage) in damages {
        let (mut f, covered) = refused_then_resumed();
        accept_seed(&mut f, 11);
        audit_is_corrupt(&mut f, Some(covered), damage, case);
    }
}
