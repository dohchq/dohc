fn retirement_scope() -> RetirementScope<'static> {
    RetirementScope {
        namespace: "namespace",
        workspace_id: "workspace",
        max_deliveries: 8,
        max_applications: 8,
    }
}

fn retirement_key(f: &Fixture, through: i64) -> RetirementKey {
    RetirementKey {
        object_id: "object".into(),
        lineage_claim_id: f.binding.lineage_claim_id.clone(),
        activation_id: f.cut.adoption_id.clone(),
        restore_fence_generation: 0,
        accepted_through: through,
    }
}

fn reconcile(
    f: &mut Fixture,
    through: i64,
    after: Option<&LiveUpdateReceipt>,
    journal: Option<&JournalEvidence>,
) -> Result<Reconciliation, ApplicationError> {
    let key = retirement_key(f, through);
    reconcile_activation(&mut f.store, &retirement_scope(), &key, after, journal, &NoFaults)
}

/// Each native entry: delivery, pending, receipt, update blob, terminal blob, reason.
type EntryState = (
    String,
    bool,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
);

fn native_entries(f: &Fixture) -> Vec<EntryState> {
    f.store
        .read_with(|conn| {
            conn.prepare(
                "SELECT delivery_id,pending,accepted_receipt_json,update_blob_digest,terminal_blob_digest,terminal_reason
                 FROM owner_ydoc_outbox_entries WHERE native_source_json IS NOT NULL ORDER BY sequence",
            )?
            .query_map([], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()
        })
        .unwrap()
}

fn pending_bytes(f: &Fixture) -> i64 {
    f.store
        .read_with(|conn| conn.query_row("SELECT sum(pending_bytes) FROM owner_ydoc_outboxes", [], |r| r.get(0)))
        .unwrap()
}

fn write(f: &mut Fixture, sql: &str) {
    f.store
        .write_with(&NoFaults, |tx| tx.execute_batch(sql).map_err(write_sql))
        .unwrap();
}

fn receipt_of(delivery: &str, digest: &str, cursor: i64) -> LiveUpdateReceipt {
    LiveUpdateReceipt {
        delivery_id: delivery.into(),
        update_digest: digest.into(),
        journal_cursor: cursor,
        accepting_host_epoch: 1,
    }
}

fn acknowledge_entry(f: &mut Fixture, receipt: &LiveUpdateReceipt) {
    let outbox: String = f
        .store
        .read_with(|conn| {
            conn.query_row(
                "SELECT outbox_id FROM owner_ydoc_outbox_entries WHERE delivery_id=?1",
                [&receipt.delivery_id],
                |r| r.get(0),
            )
        })
        .unwrap();
    owner_outbox::acknowledge(
        &mut f.store,
        "workspace",
        &outbox,
        &[owner_outbox::OwnerDeliveryReceipt {
            delivery_id: receipt.delivery_id.clone(),
            update_digest: receipt.update_digest.clone(),
            journal_cursor: receipt.journal_cursor,
            accepting_host_epoch: receipt.accepting_host_epoch,
        }],
    )
    .unwrap();
}

fn apply_event(f: &mut Fixture, event: AdmittedLiveUpdate) -> Result<ApplicationResult, ApplicationError> {
    apply_committed(
        &mut f.store,
        &mut WriterDocCache::new(),
        &f.handle,
        event,
        &NoFaults,
        100_000_000,
        |_, _, _, _| Ok(()),
    )
}

fn full_state(f: &Fixture) -> Vec<u8> {
    full_state_of(f, &f.key)
}

fn full_state_of(f: &Fixture, key: &DocKey) -> Vec<u8> {
    f.store
        .read_with(|conn| durable::load_doc_in(conn, key))
        .unwrap()
        .encode_full_state()
}

fn pending_seed_delivery(f: &Fixture) -> String {
    f.store
        .read_with(|conn| {
            conn.query_row(
                "SELECT delivery_id FROM owner_ydoc_outbox_entries WHERE pending=1 AND json_extract(native_source_json,'$.origin.kind')='adoptionSeed'",
                [],
                |r| r.get(0),
            )
        })
        .unwrap()
}

fn applied_deliveries(f: &Fixture) -> Vec<String> {
    f.store
        .read_with(|conn| {
            conn.prepare("SELECT delivery_id FROM live_device_update_applications ORDER BY journal_cursor")?
                .query_map([], |r| r.get(0))?
                .collect::<rusqlite::Result<Vec<_>>>()
        })
        .unwrap()
}

/// A divergent adoption by a device host: it keeps no imported source, and
/// applies its seed before the relay's receipt for it is saved.
/// Returns the seed's delivery and bytes.
fn device_seeded() -> (Fixture, String, Vec<u8>) {
    let mut f = Fixture::new();
    f.local_edit_before_adoption();
    let full = full_state(&f);
    f.adopt().unwrap();
    let seed = pending_seed_delivery(&f);
    (f, seed, full)
}

/// The source a capture of the document at `owner.md` keeps, with `full`
/// as its captured state.
fn imported_source(f: &Fixture, full: &[u8]) -> ImportedOwnerSource {
    ImportedOwnerSource {
        version: 1,
        relay_database_namespace: "namespace".into(),
        workspace_id: "workspace".into(),
        main_version_id: "main".into(),
        object_id: "object".into(),
        lineage_claim_id: f.binding.lineage_claim_id.clone(),
        current_path: "owner.md".into(),
        replication_epoch: "epoch".into(),
        stream_identity: "stream".into(),
        committed_cursor: 9,
        base_origin_id: "remote".into(),
        base_origin_seq: 7,
        base_relay_seq: 9,
        source_moment_id: f.cut.source_moment_id.clone(),
        source_digest: f.cut.source_digest.clone(),
        source_byte_length: f.cut.source_byte_length,
        native_head_sequence: f.cut.expected_local_sequence,
        full_state_digest: hex_sha256(full),
        full_state_byte_length: full.len(),
    }
}

/// A divergent adoption of a native service activation: its source is
/// retained as a capture keeps it, and its seed waits for a receipt.
/// Returns the seed's delivery and bytes.
fn seeded() -> (Fixture, String, Vec<u8>) {
    let mut f = imported_fixture();
    f.local_edit_before_adoption();
    let full = full_state(&f);
    let source = imported_source(&f, &full);
    let descriptor = serde_json::to_string(&source).unwrap();
    f.cut.adoption_id = format!("ordinary-activation-{}", hex_sha256(descriptor.as_bytes()));
    f.store
        .write_with(&NoFaults, |tx| {
            dohc_engine_storage::put_binary_blob(tx, &full)?;
            tx.execute(
                "INSERT INTO ydoc_owner_activation_sources VALUES (?1,'namespace','workspace','main','object',?2,?3,?4,?5,?6)",
                params![f.cut.adoption_id, f.binding.lineage_claim_id, source.source_moment_id,
                    source.source_digest, source.full_state_digest, descriptor],
            )
            .map_err(write_sql)?;
            Ok::<_, ApplicationError>(())
        })
        .unwrap();
    f.adopt().unwrap();
    let seed = pending_seed_delivery(&f);
    (f, seed, full)
}

/// A captured source, `captured`, that no activation row records.
fn retain_captured(f: &mut Fixture) {
    let source = imported_source(f, &f.cut.baseline_bytes);
    let descriptor = serde_json::to_string(&source).unwrap();
    f.store
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT INTO ydoc_owner_activation_sources VALUES ('captured','namespace','workspace','main','object',?1,?2,?3,?4,?5)",
                params![source.lineage_claim_id, source.source_moment_id, source.source_digest,
                    source.full_state_digest, descriptor],
            )
            .map_err(write_sql)
        })
        .unwrap();
}

/// A collaborator's paragraph on top of the host's current state.
fn remote_event(f: &mut Fixture, cursor: i64) -> AdmittedLiveUpdate {
    let bytes = f
        .doc
        .richdoc_append_paragraph(&format!("Remote paragraph {cursor}"));
    native_tail_event(f, bytes, format!("remote-{cursor}"), cursor)
}

#[test]
fn every_acknowledgement_keeps_its_real_receipt_without_an_observed_binding() {
    let mut f = Fixture::new();
    f.edit(true);
    let saved: (bool, Option<String>) = f
        .store
        .read_with(|conn| {
            conn.query_row(
                "SELECT pending,accepted_receipt_json FROM owner_ydoc_outbox_entries",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
        })
        .unwrap();
    let receipt = f.cut.terminal_receipt.clone().unwrap();
    assert_eq!(
        saved,
        (false, Some(serde_json::to_string(&receipt).unwrap())),
        "an unobserved outbox keeps the receipt it was acknowledged with"
    );
}

#[test]
fn the_service_seed_hold_admits_only_the_seed_and_replays() {
    let (mut f, seed, full) = seeded();
    let held = remote_event(&mut f, 2);
    assert!(matches!(
        apply_event(&mut f, held.clone()).unwrap(),
        ApplicationResult::Pending(ApplicationPending::DeliveryPending)
    ));
    assert_eq!(f.store.table_row_count("live_device_update_applications").unwrap(), 0);
    // The exact seed applies through its own delivery.
    let seed_event = native_tail_event(&f, full, seed.clone(), 1);
    let ApplicationResult::Applied(ack, _) = apply_event(&mut f, seed_event.clone()).unwrap() else {
        panic!("the seed's own delivery applies");
    };
    assert!(!ack.application_replayed);
    // Its application replays; other work still waits for the receipt.
    assert!(matches!(
        apply_event(&mut f, seed_event.clone()).unwrap(),
        ApplicationResult::Applied(ack, _) if ack.application_replayed
    ));
    assert!(matches!(
        apply_event(&mut f, held.clone()).unwrap(),
        ApplicationResult::Pending(ApplicationPending::DeliveryPending)
    ));
    acknowledge_entry(&mut f, &seed_event.metadata.accepted.receipt);
    assert!(matches!(
        apply_event(&mut f, held).unwrap(),
        ApplicationResult::Applied(..)
    ));
}

#[test]
fn a_device_seed_holds_nothing_and_applies_in_journal_order() {
    let (mut f, seed, full) = device_seeded();
    // Only a source retained for this activation's own namespace marks it
    // a service activation.
    let sql = format!(
        "INSERT INTO ydoc_owner_activation_sources VALUES ('{}','elsewhere','workspace','main','object','{}','original','{}','{}','{{}}')",
        f.cut.adoption_id, f.binding.lineage_claim_id, f.cut.source_digest, f.binding.lineage_claim_id
    );
    write(&mut f, &sql);
    // A collaborator's row the relay journaled before the seed's.
    let earlier = remote_event(&mut f, 1);
    assert!(matches!(
        apply_event(&mut f, earlier).unwrap(),
        ApplicationResult::Applied(ack, _) if !ack.application_replayed
    ));
    let seed_event = native_tail_event(&f, full, seed.clone(), 2);
    assert!(matches!(
        apply_event(&mut f, seed_event.clone()).unwrap(),
        ApplicationResult::Applied(ack, _) if !ack.application_replayed
    ));
    acknowledge_entry(&mut f, &seed_event.metadata.accepted.receipt);
    assert_eq!(applied_deliveries(&f), vec!["remote-1".to_owned(), seed]);
    assert_eq!(pending_bytes(&f), 0);
}

#[test]
fn a_quarantined_device_seed_holds_nothing() {
    let (mut f, seed, _) = device_seeded();
    let outbox: String = f
        .store
        .read_with(|conn| {
            conn.query_row(
                "SELECT outbox_id FROM owner_ydoc_outbox_entries WHERE delivery_id=?1",
                [&seed],
                |r| r.get(0),
            )
        })
        .unwrap();
    owner_outbox::quarantine(
        &mut f.store,
        "workspace",
        owner_outbox::OwnerOutboxQuarantineInput {
            outbox_id: outbox,
            reason: "refused".into(),
            observed_binding: None,
        },
        5,
    )
    .unwrap();
    // Delivery never retries or acknowledges a quarantined seed.
    assert_eq!(pending_seed_delivery(&f), seed);
    let event = remote_event(&mut f, 1);
    assert!(matches!(
        apply_event(&mut f, event).unwrap(),
        ApplicationResult::Applied(..)
    ));
    assert_eq!(applied_deliveries(&f), vec!["remote-1".to_owned()]);
}

#[test]
fn a_receipt_first_seed_applies_only_as_the_acceptance_it_kept() {
    let (mut f, seed, full) = seeded();
    let seed_event = native_tail_event(&f, full, seed, 1);
    acknowledge_entry(&mut f, &seed_event.metadata.accepted.receipt);
    // Acknowledged, the seed holds nothing, and other work need not wait for it.
    assert_eq!(pending_bytes(&f), 0);
    let mut elsewhere = seed_event.clone();
    elsewhere.metadata.accepted.receipt.journal_cursor = 5;
    assert!(matches!(
        apply_event(&mut f, elsewhere),
        Err(ApplicationError::Conflict)
    ));
    assert!(matches!(
        apply_event(&mut f, seed_event).unwrap(),
        ApplicationResult::Applied(..)
    ));
}

#[test]
fn reconciliation_reports_an_accepted_but_unapplied_seed_and_then_its_application() {
    let (mut f, seed, full) = seeded();
    let seed_event = native_tail_event(&f, full, seed, 1);
    let receipt = seed_event.metadata.accepted.receipt.clone();
    acknowledge_entry(&mut f, &receipt);
    let Reconciliation::Reconciled { adoption, applications, has_more_applications, settle } =
        reconcile(&mut f, 10, None, None).unwrap()
    else {
        panic!("an acknowledged seed needs no journal answer");
    };
    assert_eq!(adoption.unwrap().adoption_id, f.cut.adoption_id);
    assert!(applications.is_empty() && !has_more_applications && !settle);
    assert_eq!(native_entries(&f)[0].2, Some(serde_json::to_string(&receipt).unwrap()));
    apply_event(&mut f, seed_event).unwrap();
    let Reconciliation::Reconciled { applications, settle, .. } = reconcile(&mut f, 10, None, None).unwrap()
    else {
        panic!("reconciled");
    };
    assert_eq!(applications.len(), 1);
    assert_eq!(applications[0].delivery_id, receipt.delivery_id);
    assert!(settle, "the application passed the last settlement");
    // A page after the seed's own ACK is empty; F bounds every page.
    let Reconciliation::Reconciled { applications, .. } =
        reconcile(&mut f, 10, Some(&receipt), None).unwrap()
    else {
        panic!("reconciled");
    };
    assert!(applications.is_empty());
    assert!(matches!(
        reconcile(&mut f, 0, None, None),
        Err(ApplicationError::Conflict)
    ), "a receipt past F");
}

#[test]
fn a_lost_delivery_ack_is_proved_from_the_journal() {
    let mut f = Fixture::new();
    f.adopt().unwrap();
    let entry = native_tail_edit(&mut f, "# Unacknowledged\n", 11);
    assert_eq!(
        reconcile(&mut f, 10, None, None).unwrap(),
        Reconciliation::PendingDelivery(vec![entry.delivery_id.clone()])
    );
    let receipt = receipt_of(&entry.delivery_id, &entry.update_digest, 4);
    let evidence = JournalEvidence { receipts: vec![receipt.clone()], absent: vec![] };
    assert!(matches!(
        reconcile(&mut f, 10, None, Some(&evidence)).unwrap(),
        Reconciliation::Reconciled { .. }
    ));
    assert_eq!(
        native_entries(&f)[0],
        (entry.delivery_id, false, Some(serde_json::to_string(&receipt).unwrap()), None, None, None)
    );
    assert_eq!(pending_bytes(&f), 0);
}

#[test]
fn a_receipt_acknowledged_before_receipts_were_kept_is_recovered_or_refused() {
    // From the activation's own accepted history.
    let mut f = Fixture::new();
    f.adopt().unwrap();
    let entry = native_tail_edit(&mut f, "# Applied\n", 11);
    native_tail_apply(&mut f, entry.update.clone(), entry.delivery_id.clone(), 3);
    let receipt = receipt_of(&entry.delivery_id, &entry.update_digest, 3);
    acknowledge_entry(&mut f, &receipt);
    write(&mut f, "UPDATE owner_ydoc_outbox_entries SET accepted_receipt_json=NULL");
    assert!(matches!(
        reconcile(&mut f, 10, None, None).unwrap(),
        Reconciliation::Reconciled { .. }
    ));
    assert_eq!(native_entries(&f)[0].2, Some(serde_json::to_string(&receipt).unwrap()));

    // From the journal, when no history kept it; a mismatch writes nothing.
    let mut f = Fixture::new();
    f.adopt().unwrap();
    let entry = native_tail_edit(&mut f, "# Unapplied\n", 11);
    let receipt = receipt_of(&entry.delivery_id, &entry.update_digest, 3);
    acknowledge_entry(&mut f, &receipt);
    write(&mut f, "UPDATE owner_ydoc_outbox_entries SET accepted_receipt_json=NULL");
    assert_eq!(
        reconcile(&mut f, 10, None, None).unwrap(),
        Reconciliation::PendingDelivery(vec![entry.delivery_id.clone()]),
        "a cleared entry alone proves nothing"
    );
    let before = native_entries(&f);
    for evidence in [
        JournalEvidence { receipts: vec![receipt_of(&entry.delivery_id, &"f".repeat(64), 3)], absent: vec![] },
        JournalEvidence { receipts: vec![], absent: vec![entry.delivery_id.clone()] },
        JournalEvidence { receipts: vec![receipt_of(&entry.delivery_id, &entry.update_digest, 11)], absent: vec![] },
    ] {
        assert!(reconcile(&mut f, 10, None, Some(&evidence)).is_err(), "{evidence:?}");
        assert_eq!(native_entries(&f), before);
    }
    let evidence = JournalEvidence { receipts: vec![receipt.clone()], absent: vec![] };
    assert!(matches!(
        reconcile(&mut f, 10, None, Some(&evidence)).unwrap(),
        Reconciliation::Reconciled { .. }
    ));
    assert_eq!(native_entries(&f)[0].2, Some(serde_json::to_string(&receipt).unwrap()));
}

#[test]
fn an_absent_pending_native_update_is_refused_without_writes() {
    let mut f = Fixture::new();
    f.adopt().unwrap();
    // An entry whose missing receipt the same pass would fill, then one the journal never accepted.
    let first = native_tail_edit(&mut f, "# First\n", 11);
    let receipt = receipt_of(&first.delivery_id, &first.update_digest, 3);
    acknowledge_entry(&mut f, &receipt);
    write(&mut f, "UPDATE owner_ydoc_outbox_entries SET accepted_receipt_json=NULL");
    let second = native_tail_edit(&mut f, "# Second\n", 12);
    let before = (native_entries(&f), pending_bytes(&f));
    let evidence = JournalEvidence { receipts: vec![receipt], absent: vec![second.delivery_id] };
    assert!(matches!(
        reconcile(&mut f, 10, None, Some(&evidence)),
        Err(ApplicationError::Conflict)
    ));
    assert_eq!((native_entries(&f), pending_bytes(&f)), before);
}

#[test]
fn a_seed_the_journal_never_accepted_is_abandoned_once_and_recognized_after() {
    let (mut f, seed, _) = seeded();
    assert_eq!(
        reconcile(&mut f, 10, None, None).unwrap(),
        Reconciliation::PendingDelivery(vec![seed.clone()])
    );
    let absent = JournalEvidence { receipts: vec![], absent: vec![seed.clone()] };
    let Reconciliation::Reconciled { adoption, applications, settle, .. } =
        reconcile(&mut f, 10, None, Some(&absent)).unwrap()
    else {
        panic!("abandoned");
    };
    assert!(adoption.is_some() && applications.is_empty() && !settle);
    assert_eq!(
        native_entries(&f),
        vec![(seed.clone(), false, None, None, None, Some("activation-released".into()))]
    );
    assert_eq!(pending_bytes(&f), 0);
    // The abandoned seed is the same validated representation on every pass,
    // and only that representation.
    assert!(matches!(
        reconcile(&mut f, 10, None, None).unwrap(),
        Reconciliation::Reconciled { .. }
    ));
    write(&mut f, "UPDATE owner_ydoc_outbox_entries SET terminal_blob_digest=update_digest");
    assert!(matches!(reconcile(&mut f, 10, None, None), Err(ApplicationError::Conflict)));
    write(&mut f, "UPDATE owner_ydoc_outbox_entries SET terminal_blob_digest=NULL");
    assert!(matches!(
        reconcile(&mut f, 10, None, None).unwrap(),
        Reconciliation::Reconciled { .. }
    ));
}

/// Opus's round 2 F4: an application that races the abandonment lands only
/// before it, and then abandonment refuses. After it, the activation applies
/// nothing, not even the seed's own delivery, so every later pass still
/// recognizes the seed it abandoned.
#[test]
fn an_abandoned_seed_holds_every_later_application() {
    let (mut f, seed, full) = seeded();
    let absent = JournalEvidence { receipts: vec![], absent: vec![seed.clone()] };
    reconcile(&mut f, 10, None, Some(&absent)).unwrap();
    let event = remote_event(&mut f, 2);
    let seed_event = native_tail_event(&f, full, seed, 1);
    for held in [event, seed_event] {
        assert!(matches!(
            apply_event(&mut f, held).unwrap(),
            ApplicationResult::Pending(ApplicationPending::ApplicabilityUnavailable)
        ));
    }
    assert!(applied_deliveries(&f).is_empty());
    assert!(matches!(
        reconcile(&mut f, 10, None, None).unwrap(),
        Reconciliation::Reconciled { .. }
    ));
}

/// Opus's round 2 F2: a quarantined service seed is never retried, so its
/// hold says so, and reconciliation reports it apart from ordinary pending
/// delivery. The journal's answer still ends it as for any seed never delivered.
#[test]
fn a_quarantined_service_seed_is_reported_and_still_retires() {
    let (mut f, seed, _) = seeded();
    let outbox: String = f
        .store
        .read_with(|conn| {
            conn.query_row(
                "SELECT outbox_id FROM owner_ydoc_outbox_entries WHERE delivery_id=?1",
                [&seed],
                |r| r.get(0),
            )
        })
        .unwrap();
    owner_outbox::quarantine(
        &mut f.store,
        "workspace",
        owner_outbox::OwnerOutboxQuarantineInput {
            outbox_id: outbox,
            reason: "provenance-refused".into(),
            observed_binding: None,
        },
        5,
    )
    .unwrap();
    let held = remote_event(&mut f, 2);
    assert!(matches!(
        apply_event(&mut f, held).unwrap(),
        ApplicationResult::Pending(ApplicationPending::SeedQuarantined)
    ));
    assert_eq!(
        reconcile(&mut f, 10, None, None).unwrap(),
        Reconciliation::SeedQuarantined(vec![seed.clone()])
    );
    let absent = JournalEvidence { receipts: vec![], absent: vec![seed.clone()] };
    assert!(matches!(
        reconcile(&mut f, 10, None, Some(&absent)).unwrap(),
        Reconciliation::Reconciled { .. }
    ));
    assert_eq!(
        native_entries(&f),
        vec![(seed, false, None, None, None, Some("activation-released".into()))]
    );
}

/// Phase A ends one activation in its owner: only registrations tagged with
/// it, and only its document's cache entry. Its binding row stays, and it
/// never registers under this owner again.
#[test]
fn retiring_an_activation_ends_only_its_own_registrations_and_cache_entry() {
    let mut f = Fixture::new();
    f.adopt().unwrap();
    let coordinate = ApplicationHostCoordinate {
        host_id: "host".into(),
        host_epoch: 1,
        instance_id: "instance".into(),
        connection_id: "connection".into(),
    };
    // Another document, which serves no activation, with its own cache entry.
    let fixture: Value =
        serde_json::from_str(include_str!("../../tests/owner-source/owner-source-seed.json"))
            .unwrap();
    let bytes: Vec<u8> = serde_json::from_value(fixture["bytes"].clone()).unwrap();
    VersionedTextStore::new(&mut f.store)
        .write_text(
            &WriteText {
                workspace_id: "workspace".into(),
                version_id: "main".into(),
                object_id: "other".into(),
                path: "other.md".into(),
                text: fixture["markdown"].as_str().unwrap().to_owned(),
                moment_id: "other-original".into(),
                metadata_origin: "user".into(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 1,
                request_id: None,
            },
            &NoFaults,
        )
        .unwrap();
    let other = DocKey::new("workspace", "main", "other").unwrap();
    durable::claim_base(&mut f.store, &other, ContentKind::Richdoc, &bytes, &NoFaults, 2).unwrap();
    let other_binding = LiveObjectBinding {
        object_id: "other".into(),
        current_path: "other.md".into(),
        selector_paths: vec!["other.md".into()],
        ..f.binding.clone()
    };
    let other_handle = f
        ._owner
        .register(&mut f.store, "namespace".into(), coordinate.clone(), other_binding)
        .unwrap();
    assert_eq!(other_handle.activation_id(), None);
    let mut cache = WriterDocCache::new();
    for key in [f.key.clone(), other.clone()] {
        let doc = Ydoc::wire();
        doc.apply(&full_state_of(&f, &key)).unwrap();
        doc.rewrite_content_to_markdown(ContentKind::Richdoc, "cached").unwrap();
        crate::record_local_update(
            &mut f.store,
            &mut cache,
            &key,
            &doc.encode_full_state(),
            crate::LocalAppend::default(),
            &NoFaults,
            4,
            |_, _, _| Ok(()),
        )
        .unwrap();
    }
    assert!(cache.contains_for_test(&f.key) && cache.contains_for_test(&other));
    let binding_row = |f: &Fixture| -> (i64, Option<String>) {
        f.store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT available,activation_id FROM live_device_application_bindings WHERE object_id='object'",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
            })
            .unwrap()
    };
    let before = binding_row(&f);
    let key = f.key.clone();
    f._owner.retire_activation(&mut cache, "namespace", &coordinate, &key, "adoption");
    assert!(!cache.contains_for_test(&f.key), "its document's entry goes");
    assert!(cache.contains_for_test(&other), "another document's entry stays");
    let live: Vec<(String, bool)> = f
        ._owner
        .current
        .iter()
        .map(|current| {
            let held = current.lock().unwrap();
            (held.binding.object_id.clone(), held.live)
        })
        .collect();
    assert_eq!(live, [("other".to_owned(), true)]);
    assert!(f._owner.retired_activations().contains("adoption"));
    assert_eq!(binding_row(&f), before, "its binding stays");
    let event = remote_event(&mut f, 2);
    assert!(matches!(
        apply_event(&mut f, event).unwrap(),
        ApplicationResult::Pending(ApplicationPending::ApplicabilityUnavailable)
    ));
    // Neither an unnamed nor a named registration serves it again.
    let binding = f.binding.clone();
    for named in [None, Some("adoption".to_owned())] {
        let result = match named {
            None => f._owner.register(&mut f.store, "namespace".into(), coordinate.clone(), binding.clone()),
            Some(id) => f._owner.register_activation(&mut f.store, "namespace".into(), coordinate.clone(), binding.clone(), id),
        };
        assert!(matches!(result, Err(ApplicationError::Conflict)));
    }
    assert!(matches!(
        validate_registration_activation(&f.store, "namespace", &binding, None, &f._owner.retired_activations()),
        Err(ApplicationError::Conflict)
    ));
    assert_eq!(f._owner.current.len(), 1);
    assert_eq!(binding_row(&f), before);
}

/// N8: an unload names the activation it ends. A registration serving
/// another, or any while the unload names none, refuses it; an ordinary
/// registration serves none and goes with any unload of its document.
#[test]
fn an_unload_must_name_the_activation_its_registration_serves() {
    let mut f = Fixture::new();
    for named in [None, Some("adoption")] {
        assert!(f._owner.require_unload_activation("object", named).is_ok());
    }
    f.adopt().unwrap();
    for named in [None, Some("successor")] {
        assert!(matches!(
            f._owner.unregister(&mut f.store, "object", named),
            Err(ApplicationError::Conflict)
        ));
        assert_eq!(f._owner.current.len(), 1, "{named:?}");
    }
    f._owner.unregister(&mut f.store, "object", Some("adoption")).unwrap();
    assert!(f._owner.current.is_empty());
}

#[test]
fn a_seed_missing_any_condition_is_not_abandoned() {
    let damage: [(&str, &str); 12] = [
        ("not a seed", ""),
        ("source activation", ""),
        (
            "document",
            "UPDATE owner_ydoc_outbox_entries SET native_source_json=json_set(native_source_json,'$.binding.objectId','other')",
        ),
        (
            "append identity",
            "UPDATE owner_ydoc_outbox_entries SET append_key='owner-adoption:'||update_digest",
        ),
        (
            "receipt",
            "UPDATE owner_ydoc_outbox_entries SET accepted_receipt_json=json_object('deliveryId',delivery_id,
                'updateDigest',update_digest,'journalCursor',1,'acceptingHostEpoch',1)",
        ),
        (
            "adopted sequence",
            "UPDATE live_owner_activations SET local_ydoc_sequence=local_ydoc_sequence+1",
        ),
        ("retained source", "DELETE FROM ydoc_owner_activation_sources"),
        (
            "captured digest",
            "UPDATE ydoc_owner_activation_sources SET full_state_digest=lineage_claim_id",
        ),
        (
            "local sequence",
            "UPDATE ydoc_owner_activation_sources SET descriptor_json=json_set(descriptor_json,'$.nativeHeadSequence',99)",
        ),
        ("accepted history", ""),
        ("application", ""),
        ("later application", ""),
    ];
    for (condition, sql) in damage {
        let (mut f, seed, full) = seeded();
        match condition {
            "not a seed" | "source activation" => {
                // The same source as a native update, or as another
                // activation's seed, under its own consistent append key.
                let json: String = f
                    .store
                    .read_with(|conn| {
                        conn.query_row(
                            "SELECT native_source_json FROM owner_ydoc_outbox_entries WHERE delivery_id=?1",
                            [&seed],
                            |r| r.get(0),
                        )
                    })
                    .unwrap();
                let mut source: owner_outbox::OwnerOutboxNativeSource =
                    serde_json::from_str(&json).unwrap();
                let key = if condition == "not a seed" {
                    source.origin = owner_outbox::OwnerOutboxNativeOrigin::NativeUpdate {
                        actor_origin_id: None,
                        actor_kind: None,
                        on_behalf_of: None,
                        chain_depth: None,
                        recorded_at_ms: 1,
                    };
                    format!("adopted-local:{}", hex_sha256(&serde_json::to_vec(&source).unwrap()))
                } else {
                    source.adoption_id = "other".into();
                    format!(
                        "owner-adoption:{}",
                        hex_sha256(&serde_json::to_vec(&(&source.adoption_id, source.native_sequence,
                            &source.update_digest)).unwrap())
                    )
                };
                f.store
                    .write_with(&NoFaults, |tx| {
                        tx.execute(
                            "UPDATE owner_ydoc_outbox_entries SET native_source_json=?1,append_key=?2 WHERE delivery_id=?3",
                            params![serde_json::to_string(&source).unwrap(), key, seed],
                        )
                        .map_err(write_sql)
                    })
                    .unwrap();
            }
            "accepted history" | "application" => {
                // The host applied the seed: its accepted history and application name it.
                let event = native_tail_event(&f, full, seed.clone(), 1);
                apply_event(&mut f, event).unwrap();
                // Each keeps only its own evidence. The application sits at
                // the cut, so only its delivery names it.
                write(&mut f, if condition == "application" {
                    "DELETE FROM live_accepted_updates; UPDATE live_owner_activations SET terminal_cursor=1"
                } else {
                    "DELETE FROM live_device_application_first_seen; DELETE FROM live_device_update_applications"
                });
            }
            "later application" => {
                // Another delivery applied after the cut while the seed's hold was lifted.
                write(&mut f, "UPDATE owner_ydoc_outbox_entries SET pending=0,update_blob_digest=NULL");
                let event = remote_event(&mut f, 2);
                apply_event(&mut f, event).unwrap();
                write(&mut f, "UPDATE owner_ydoc_outbox_entries SET pending=1,update_blob_digest=update_digest");
            }
            _ => {
                f.store
                    .write_with(&NoFaults, |tx| {
                        tx.execute_batch("PRAGMA defer_foreign_keys=ON").map_err(write_sql)?;
                        tx.execute_batch(sql).map_err(write_sql)
                    })
                    .unwrap();
            }
        }
        let before = (native_entries(&f), pending_bytes(&f));
        let absent = JournalEvidence { receipts: vec![], absent: vec![seed.clone()] };
        let result = reconcile(&mut f, 10, None, Some(&absent));
        if condition == "source activation" {
            // Another activation's entry is not this retirement's to judge.
            assert!(result.is_ok(), "{condition}");
        } else {
            assert!(result.is_err(), "{condition}");
        }
        assert_eq!((native_entries(&f), pending_bytes(&f)), before, "{condition}");
    }
}

#[test]
fn a_terminal_reason_alone_is_not_an_abandoned_seed() {
    let mut f = Fixture::new();
    f.adopt().unwrap();
    let entry = native_tail_edit(&mut f, "# Native\n", 11);
    acknowledge_entry(&mut f, &receipt_of(&entry.delivery_id, &entry.update_digest, 3));
    write(
        &mut f,
        "UPDATE owner_ydoc_outbox_entries SET accepted_receipt_json=NULL,terminal_reason='activation-released'",
    );
    assert!(matches!(
        reconcile(&mut f, 10, None, None),
        Err(ApplicationError::Conflict)
    ));
}

#[test]
fn retirement_validates_the_exact_activation_before_reading_its_entries() {
    let mut f = Fixture::new();
    f.adopt().unwrap();
    let mut key = retirement_key(&f, 10);
    let refused = |f: &mut Fixture, key: &RetirementKey| {
        matches!(
            reconcile_activation(&mut f.store, &retirement_scope(), key, None, None, &NoFaults),
            Err(ApplicationError::Conflict)
        )
    };
    for changed in ["activation", "lineage", "object", "generation"] {
        let mut wrong = key.clone();
        match changed {
            "activation" => wrong.activation_id = "unknown".into(),
            "lineage" => wrong.lineage_claim_id = "f".repeat(64),
            "object" => wrong.object_id = "other".into(),
            _ => wrong.restore_fence_generation = 1,
        }
        assert!(refused(&mut f, &wrong), "{changed}");
    }
    let foreign = RetirementScope { namespace: "elsewhere", ..retirement_scope() };
    assert!(matches!(
        reconcile_activation(&mut f.store, &foreign, &key, None, None, &NoFaults),
        Err(ApplicationError::Conflict)
    ));
    // The binding must name the activation it holds.
    write(&mut f, "UPDATE live_device_application_bindings SET activation_id=NULL");
    assert!(refused(&mut f, &key));
    write(&mut f, "UPDATE live_device_application_bindings SET activation_id='adoption'");
    // A source captured while another activation holds the lineage was overtaken.
    let source = RetirementKey { activation_id: "captured".into(), ..key.clone() };
    retain_captured(&mut f);
    assert!(refused(&mut f, &source), "its binding names another activation");
    write(&mut f, "UPDATE live_device_application_bindings SET activation_id='captured'");
    assert!(refused(&mut f, &source), "overtaken by the current activation");
    write(&mut f, "UPDATE live_device_application_bindings SET activation_id='adoption'");
    release(&mut f, "adoption");
    assert!(refused(&mut f, &key), "its release fenced another cursor");
    key.accepted_through = 0;
    assert!(matches!(
        reconcile_activation(&mut f.store, &retirement_scope(), &key, None, None, &NoFaults),
        Ok(Reconciliation::Reconciled { .. })
    ), "a released activation answers from its release");
    add_activation(&mut f, "successor", "adoption", false, 1);
    write(&mut f, "UPDATE live_device_application_bindings SET activation_id='captured'");
    assert!(refused(&mut f, &source), "overtaken by a successor");
}

/// Every row a refused never-adopted retirement could have written.
type NeverAdoptedInventory = (Vec<i64>, (String, String, Option<String>), i64, i64);

fn never_adopted_inventory(f: &Fixture) -> NeverAdoptedInventory {
    let binding = f
        .store
        .read_with(|conn| {
            conn.query_row(
                "SELECT lineage_claim_id,current_path,activation_id FROM live_device_application_bindings",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
        })
        .unwrap();
    (
        f.counts(),
        binding,
        f.store.table_row_count("live_owner_activations").unwrap(),
        f.store.table_row_count("ydoc_owner_activation_sources").unwrap(),
    )
}

/// A source `captured` no activation recorded, on a lineage never adopted.
fn never_adopted() -> Fixture {
    let mut f = Fixture::new();
    f.cut.adoption_id = "captured".into();
    retain_captured(&mut f);
    f
}

#[test]
fn a_never_adopted_source_reconciles_only_against_its_own_binding() {
    let other = "f".repeat(64);
    let cases = [
        ("unnamed, on another lineage", format!("lineage_claim_id='{other}'")),
        ("named, on another lineage", format!("lineage_claim_id='{other}',activation_id='captured'")),
        ("unnamed, at another path", "current_path='other.md'".to_owned()),
        ("named, at another path", "current_path='other.md',activation_id='captured'".to_owned()),
        ("named for another activation", "activation_id='adoption'".to_owned()),
    ];
    for (case, set) in cases {
        let mut f = never_adopted();
        write(&mut f, &format!("UPDATE live_device_application_bindings SET {set}"));
        let before = never_adopted_inventory(&f);
        assert!(
            matches!(reconcile(&mut f, 10, None, None), Err(ApplicationError::Conflict)),
            "{case}"
        );
        assert_eq!(never_adopted_inventory(&f), before, "{case}");
    }
    // Its own binding, unnamed or naming it, has nothing to prove.
    for named in [false, true] {
        let mut f = never_adopted();
        if named {
            write(&mut f, "UPDATE live_device_application_bindings SET activation_id='captured'");
        }
        assert_eq!(
            reconcile(&mut f, 10, None, None).unwrap(),
            Reconciliation::Reconciled {
                adoption: None,
                applications: vec![],
                has_more_applications: false,
                settle: false
            },
            "named={named}"
        );
    }
    // An unnamed binding is its own only while its lineage was never adopted.
    let mut f = Fixture::new();
    f.adopt().unwrap();
    release(&mut f, "adoption");
    retain_captured(&mut f);
    write(&mut f, "UPDATE live_device_application_bindings SET activation_id=NULL");
    f.cut.adoption_id = "captured".into();
    let before = never_adopted_inventory(&f);
    assert!(matches!(
        reconcile(&mut f, 10, None, None),
        Err(ApplicationError::Conflict)
    ));
    assert_eq!(never_adopted_inventory(&f), before);
}
