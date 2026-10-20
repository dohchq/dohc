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
    let key = ProtectionKey { doc: &f.key, lineage_claim_id: &f.binding.lineage_claim_id, incoming };
    match f.store.read_with(|conn| protection(conn, &key)).unwrap() {
        Protection::Unprotected => None,
        Protection::Protected { binding, head } => {
            assert_eq!(binding.head_digest, hex_sha256(&head.encode_full_state()), "the head it names");
            Some(*binding)
        }
    }
}

/// Every protected tail the window names.
fn listed(binding: ReleasedLineageBinding) -> Vec<ProtectedTail> {
    match binding.tails {
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
            tails: ProtectedTails::Listed(vec![ProtectedTail {
                namespace: "namespace".into(),
                activation_id: "adoption".into(),
                release: owner_release(),
                coverage: RetainedCoverage::Unproven(unproven),
            }]),
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
        assert_eq!(binding.tails, ProtectedTails::Invalid, "{case}");
        assert!(binding.moved("owner.md"), "{case}");
    }
}
