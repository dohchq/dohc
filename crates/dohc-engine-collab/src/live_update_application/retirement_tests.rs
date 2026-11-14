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
        restore_fence_generation: f.binding.restore_fence_generation,
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

fn device_seeded() -> (Fixture, String, Vec<u8>) {
    let mut f = Fixture::new();
    f.local_edit_before_adoption();
    let full = full_state(&f);
    f.adopt().unwrap();
    let seed = pending_seed_delivery(&f);
    (f, seed, full)
}

fn imported_source(f: &Fixture, full: &[u8]) -> ImportedOwnerSource {
    ImportedOwnerSource {
        version: 1,
        reader_source: false,
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
        predecessor_activation_id: None,
    }
}

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

fn remote_event(f: &mut Fixture, cursor: i64) -> AdmittedLiveUpdate {
    let bytes = f
        .doc
        .richdoc_append_paragraph(&format!("Remote paragraph {cursor}"));
    native_tail_event(f, bytes, format!("remote-{cursor}"), cursor)
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
    let seed_event = native_tail_event(&f, full, seed.clone(), 1);
    let ApplicationResult::Applied(ack, _) = apply_event(&mut f, seed_event.clone()).unwrap() else {
        panic!("the seed's own delivery applies");
    };
    assert!(!ack.application_replayed);
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
    let sql = format!(
        "INSERT INTO ydoc_owner_activation_sources VALUES ('{}','elsewhere','workspace','main','object','{}','original','{}','{}','{{}}')",
        f.cut.adoption_id, f.binding.lineage_claim_id, f.cut.source_digest, f.binding.lineage_claim_id
    );
    write(&mut f, &sql);
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
    assert!(applications.is_empty() && !has_more_applications);
    // The edit before adoption named no author, so the interval names the
    // unknown author and the document parks only after a settlement.
    assert!(settle, "the interval names the edit before adoption");
    assert_eq!(native_entries(&f)[0].2, Some(serde_json::to_string(&receipt).unwrap()));
    let applied_past_settlement = |f: &Fixture| {
        f.store
            .read_with(|conn| settlement_pending(conn, "namespace", &f.key, &f.binding.lineage_claim_id, Some(10)))
            .unwrap()
    };
    assert!(!applied_past_settlement(&f), "an acknowledged seed applies nothing");
    apply_event(&mut f, seed_event).unwrap();
    let Reconciliation::Reconciled { applications, settle, .. } = reconcile(&mut f, 10, None, None).unwrap()
    else {
        panic!("reconciled");
    };
    assert_eq!(applications.len(), 1);
    assert_eq!(applications[0].delivery_id, receipt.delivery_id);
    assert!(settle && applied_past_settlement(&f), "the application passed the last settlement");
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
fn a_receipt_acknowledged_before_receipts_were_kept_is_recovered_or_refused() {
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

/// Native updates carry their own source and authors, so they never join a
/// delivery group: however many wait behind the head, each is delivered
/// alone under its own delivery id.
#[test]
fn native_updates_waiting_behind_the_head_are_each_delivered_alone() {
    let mut f = Fixture::new();
    f.adopt().unwrap();
    let waiting = [
        native_tail_edit(&mut f, "# First\n", 11),
        native_tail_edit(&mut f, "# Second\n", 12),
        native_tail_edit(&mut f, "# Third\n", 13),
    ];
    let outbox = outbox_of(&f, &waiting[0].delivery_id);
    let pending = owner_outbox::read_pending(&f.store, "workspace", &outbox).unwrap();
    assert!(
        pending.entries.ends_with(&waiting),
        "each native update is its own entry: {:?}",
        pending.entries.iter().map(|entry| &entry.delivery_id).collect::<Vec<_>>()
    );
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
    assert!(adoption.is_some() && applications.is_empty());
    assert!(settle, "the interval names the edit before adoption");
    assert_eq!(
        native_entries(&f),
        vec![(seed.clone(), false, None, None, None, Some("activation-released".into()))]
    );
    assert_eq!(pending_bytes(&f), 0);
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

fn outbox_of(f: &Fixture, delivery: &str) -> String {
    f.store
        .read_with(|conn| {
            conn.query_row(
                "SELECT outbox_id FROM owner_ydoc_outbox_entries WHERE delivery_id=?1",
                [delivery],
                |r| r.get(0),
            )
        })
        .unwrap()
}

fn refuse_head(f: &mut Fixture, delivery: &str, reason: &str) -> String {
    let outbox = outbox_of(f, delivery);
    owner_outbox::record_refusal(
        &mut f.store,
        "workspace",
        owner_outbox::OwnerOutboxQuarantineInput {
            outbox_id: outbox.clone(),
            reason: reason.into(),
            observed_binding: None,
        },
        owner_outbox::OwnerOutboxRefusal {
            delivery_id: delivery.into(),
            key: format!("refusal-{delivery}"),
        },
        5,
    )
    .unwrap();
    outbox
}

fn quarantine_state(f: &Fixture, outbox: &str) -> (String, i64) {
    f.store
        .read_with(|conn| {
            conn.query_row(
                "SELECT state,(SELECT COUNT(*) FROM owner_ydoc_outbox_refusals r WHERE r.outbox_id=o.outbox_id)
                 FROM owner_ydoc_outboxes o WHERE outbox_id=?1",
                [outbox],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
        })
        .unwrap()
}

/// The relay refused an ordinary edit, and nothing grants it a Try again.
/// Once the journal proves it and the edit behind it absent, retirement
/// keeps both with their bytes, and the outbox keeps its quarantine and
/// refusal for the owner's recovery copy.
#[test]
fn a_kept_refusal_retires_with_its_bytes() {
    let mut f = Fixture::new();
    f.adopt().unwrap();
    let first = native_tail_edit(&mut f, "# Refused\n", 11);
    let second = native_tail_edit(&mut f, "# Behind\n", 12);
    let outbox = refuse_head(&mut f, &first.delivery_id, "delivery-conflict");
    assert_eq!(
        reconcile(&mut f, 10, None, None).unwrap(),
        Reconciliation::PendingDelivery(vec![
            first.delivery_id.clone(),
            second.delivery_id.clone()
        ])
    );
    let absent = JournalEvidence {
        receipts: vec![],
        absent: vec![first.delivery_id.clone(), second.delivery_id.clone()],
    };
    assert!(matches!(
        reconcile(&mut f, 10, None, Some(&absent)).unwrap(),
        Reconciliation::Reconciled { .. }
    ));
    let kept = |entry: &owner_outbox::OwnerOutboxEntry| {
        (
            entry.delivery_id.clone(),
            false,
            None,
            None,
            Some(entry.update_digest.clone()),
            Some("retirement-kept".to_owned()),
        )
    };
    assert_eq!(native_entries(&f), vec![kept(&first), kept(&second)]);
    assert_eq!(pending_bytes(&f), 0);
    assert_eq!(quarantine_state(&f, &outbox), ("quarantined".to_owned(), 1));
    assert_eq!(entry_update(&f, &first.delivery_id), first.update);
    assert!(matches!(
        reconcile(&mut f, 10, None, None).unwrap(),
        Reconciliation::Reconciled { .. }
    ));
}

/// A refused seed with work applied after it may still have reached a
/// collaborator, so retirement holds without abandoning it or failing.
#[test]
fn a_refused_seed_with_later_applied_work_holds_its_retirement() {
    let (mut f, seed, _) = device_seeded();
    refuse_head(&mut f, &seed, "delivery-conflict");
    let event = remote_event(&mut f, 1);
    assert!(matches!(
        apply_event(&mut f, event).unwrap(),
        ApplicationResult::Applied(..)
    ));
    let before = (native_entries(&f), pending_bytes(&f));
    let absent = JournalEvidence {
        receipts: vec![],
        absent: vec![seed.clone()],
    };
    assert_eq!(
        reconcile(&mut f, 10, None, Some(&absent)).unwrap(),
        Reconciliation::SeedQuarantined(vec![seed])
    );
    assert_eq!((native_entries(&f), pending_bytes(&f)), before);
}

fn other_document(f: &mut Fixture) -> LiveObjectBinding {
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
    LiveObjectBinding {
        object_id: "other".into(),
        current_path: "other.md".into(),
        selector_paths: vec!["other.md".into()],
        ..f.binding.clone()
    }
}

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
    let other_binding = other_document(&mut f);
    let other = DocKey::new("workspace", "main", "other").unwrap();
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
                        agent_run_id: None,
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
    write(&mut f, "UPDATE live_device_application_bindings SET activation_id=NULL");
    assert!(refused(&mut f, &key));
    write(&mut f, "UPDATE live_device_application_bindings SET activation_id='adoption'");
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

fn never_adopted() -> Fixture {
    let mut f = Fixture::new();
    f.cut.adoption_id = "captured".into();
    retain_captured(&mut f);
    f
}

fn retirement_host() -> ApplicationHostCoordinate {
    ApplicationHostCoordinate {
        host_id: "host".into(),
        host_epoch: 1,
        instance_id: "instance".into(),
        connection_id: "connection".into(),
    }
}

/// The document as a hosted replica holds it: in its scope or departed
/// from it, and parked or not. It parks only with an empty interval, so a
/// settlement took in what its interval named first.
fn host_document(f: &mut Fixture, departed: bool, parked: bool) {
    if parked {
        settle_accepted_prefix(f);
    }
    let sql = format!(
        "INSERT OR IGNORE INTO sync_identity(workspace_id,origin_id,replication_epoch,stream_identity,created_at_ms)
           VALUES ('workspace','origin','epoch','stream',0);
         INSERT OR IGNORE INTO hosted_replicas(workspace_id,scope_generation,created_at_ms) VALUES ('workspace',1,0);
         INSERT OR REPLACE INTO hosted_documents(workspace_id,object_id,path,state,scope_generation)
           VALUES ('workspace','object','owner.md','{}',{})",
        if parked { "parked" } else { "ready" },
        if departed { 0 } else { 1 }
    );
    write(f, &sql);
}

fn release_through(f: &mut Fixture, through: i64) -> Result<Release, ApplicationError> {
    let key = retirement_key(f, through);
    release_activation(
        &mut f.store,
        &mut WriterDocCache::new(),
        &retirement_scope(),
        &key,
        &retirement_host(),
        30,
        &NoFaults,
    )
}

fn retirement_settle(
    f: &mut Fixture,
    through: i64,
    terminal: Option<LiveUpdateReceipt>,
) -> Result<LiveSettlementResult, ApplicationError> {
    retirement_settle_as(f, through, terminal, "retired")
}

fn retirement_settle_as(
    f: &mut Fixture,
    through: i64,
    terminal: Option<LiveUpdateReceipt>,
    moment: &str,
) -> Result<LiveSettlementResult, ApplicationError> {
    let key = retirement_key(f, through);
    let doc_key = f.key.clone();
    with_retirement_settlement(
        &mut f.store,
        &retirement_scope(),
        &key,
        &retirement_host(),
        terminal,
        128,
        NativeHistoryReconstruction {
            working_reserve_bytes: 8 * 1024 * 1024,
        },
        |store, audit| record_projection(store, audit, &doc_key, moment),
    )
}

fn settle_as(
    f: &mut Fixture,
    terminal: Option<LiveUpdateReceipt>,
    moment: &str,
) -> Result<LiveSettlementResult, ApplicationError> {
    let doc_key = f.key.clone();
    with_settlement(
        &mut f.store,
        &f.handle,
        terminal,
        128,
        NativeHistoryReconstruction {
            working_reserve_bytes: 8 * 1024 * 1024,
        },
        |store, audit| record_projection(store, audit, &doc_key, moment),
    )
}

fn record_projection(
    store: &mut EngineStore,
    audit: &LiveSettlementAudit,
    doc_key: &DocKey,
    moment: &str,
) -> Result<LiveSettlementResult, ApplicationError> {
    let (text, vector) = match audit.accepted_prefix() {
        Some(doc) => (
            doc.project(ContentKind::Richdoc)?.content,
            hex_sha256(&doc.encode_state_vector()),
        ),
        None => {
            let doc = store.read_with(|conn| durable::load_doc_in(conn, doc_key))?;
            (
                doc.project(ContentKind::Richdoc)?.content,
                hex_sha256(&doc.encode_state_vector()),
            )
        }
    };
    record_text(store, audit, moment, &text, &vector)
}

/// Write `text` as the settled file and record the settlement as `moment`,
/// with `vector` the state vector digest of the document it projects. As the
/// host's settlement does, it takes in the interval.
fn record_text(
    store: &mut EngineStore,
    audit: &LiveSettlementAudit,
    moment: &str,
    text: &str,
    vector: &str,
) -> Result<LiveSettlementResult, ApplicationError> {
    let key = DocKey::new("workspace", "main", "object")?;
    let result = store.write_with(&NoFaults, |tx| -> Result<_, ApplicationError> {
        let written = dohc_engine_domain::write_projected_text_in_tx(
            tx,
            dohc_engine_domain::ProjectedWriteText {
                workspace_id: "workspace",
                version_id: "main",
                object_id: "object",
                path: std::borrow::Cow::Borrowed("owner.md"),
                text: std::borrow::Cow::Borrowed(text),
                moment_id: moment,
                metadata_origin: "ydoc",
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 30,
                request_id: None,
            },
        )
        .map_err(|_| ApplicationError::Corrupt)?;
        tx.execute(
            "UPDATE ydoc_docs SET last_settled_sha=?1 WHERE object_id='object'",
            [&written.snapshot.blob_sha256],
        )
        .map_err(write_sql)?;
        crate::author_coverage::advance_moment_in(
            tx,
            &key,
            moment,
            audit.accepted_prefix().is_some(),
        )?;
        let id = audit.record_in_tx(tx, moment, &written.snapshot.blob_sha256, vector, 30)?;
        Ok(audit.result(Some(id), moment.into(), written.snapshot.blob_sha256, false))
    })?;
    let TxnOutcome::Committed(result) = result else {
        return Err(ApplicationError::Interrupted);
    };
    Ok(result)
}

fn rows(f: &Fixture, tables: &[&str]) -> Vec<String> {
    f.store
        .read_with(|conn| {
            let mut rows = Vec::new();
            for table in tables {
                let mut statement = conn.prepare(&format!("SELECT * FROM {table} ORDER BY 1"))?;
                let columns = statement.column_count();
                let mut query = statement.query([])?;
                while let Some(row) = query.next()? {
                    let values = (0..columns)
                        .map(|column| row.get::<_, rusqlite::types::Value>(column))
                        .collect::<Result<Vec<_>, _>>()?;
                    rows.push(format!("{table} {values:?}"));
                }
            }
            Ok::<_, rusqlite::Error>(rows)
        })
        .unwrap()
}

const RELEASE_KEEPS: [&str; 11] = [
    "live_owner_adoptions",
    "ydoc_owner_activation_sources",
    "live_device_update_applications",
    "live_accepted_updates",
    "live_accepted_checkpoints",
    "live_device_settlements",
    "live_restore_fences",
    "ydoc_deferred_updates",
    "owner_ydoc_outboxes",
    "owner_ydoc_outbox_entries",
    "moments",
];

const RELEASE_WRITES: [&str; 13] = [
    "live_owner_activations",
    "live_device_application_bindings",
    "live_owner_adoptions",
    "ydoc_owner_activation_sources",
    "live_device_update_applications",
    "live_accepted_updates",
    "live_accepted_checkpoints",
    "live_device_settlements",
    "live_restore_fences",
    "ydoc_deferred_updates",
    "owner_ydoc_outboxes",
    "owner_ydoc_outbox_entries",
    "moments",
];

fn entry_update(f: &Fixture, delivery: &str) -> Vec<u8> {
    f.store
        .read_with(|conn| {
            conn.query_row(
                "SELECT b.bytes FROM owner_ydoc_outbox_entries e JOIN binary_blobs b
                   ON b.sha256=COALESCE(e.update_blob_digest,e.terminal_blob_digest,e.update_digest)
                 WHERE e.delivery_id=?1",
                [delivery],
                |r| r.get(0),
            )
        })
        .unwrap()
}

fn covered_and_carried() -> (Fixture, LiveUpdateReceipt, LiveUpdateReceipt, i64) {
    let mut f = Fixture::new();
    f.adopt().unwrap();
    let covered = native_tail_edit(&mut f, "# Covered\n", 11);
    native_tail_apply(&mut f, covered.update.clone(), covered.delivery_id.clone(), 3);
    let covered = receipt_of(&covered.delivery_id, &covered.update_digest, 3);
    acknowledge_entry(&mut f, &covered);
    let carried_entry = native_tail_edit(&mut f, "# Carried\n", 12);
    let carried = receipt_of(&carried_entry.delivery_id, &carried_entry.update_digest, 5);
    acknowledge_entry(&mut f, &carried);
    let sequence: i64 = f
        .store
        .read_with(|conn| {
            conn.query_row(
                "SELECT json_extract(native_source_json,'$.nativeSequence') FROM owner_ydoc_outbox_entries WHERE delivery_id=?1",
                [&carried.delivery_id],
                |r| r.get(0),
            )
        })
        .unwrap();
    retain_captured(&mut f);
    write(
        &mut f,
        "INSERT INTO ydoc_deferred_updates(workspace_id,version_id,object_id,origin_id,origin_seq,recorded_at_ms)
           VALUES ('workspace','main','object','remote-origin',1,5)",
    );
    (f, covered, carried, sequence)
}

#[test]
fn an_adopted_activation_releases_once_parked_and_reconciled() {
    let (mut f, covered, carried, sequence) = covered_and_carried();
    host_document(&mut f, false, false);
    let before = rows(&f, &RELEASE_WRITES);
    assert!(matches!(release_through(&mut f, 10), Err(ApplicationError::Conflict)), "still in the scope");
    host_document(&mut f, true, false);
    assert_eq!(release_through(&mut f, 10).unwrap(), Release::Pending(ReleasePending::Parking));
    assert_eq!(rows(&f, &RELEASE_WRITES), before);
    host_document(&mut f, true, true);
    assert_eq!(
        release_through(&mut f, 10).unwrap(),
        Release::Pending(ReleasePending::Reconciliation),
        "its application at 3 is not settled"
    );
    assert!(matches!(
        retirement_settle(&mut f, 10, Some(carried.clone())),
        Err(ApplicationError::InvalidInput(_))
    ), "only the latest application is its terminal");
    let settled = retirement_settle(&mut f, 10, Some(covered.clone())).unwrap();
    assert_eq!((settled.previous_cursor, settled.terminal_cursor), (0, 3));
    let text: String = f
        .store
        .read_with(|conn| conn.query_row("SELECT b.text FROM moments m JOIN blobs b ON b.sha256=m.after_blob_sha256 WHERE m.moment_id='retired'", [], |r| r.get(0)))
        .unwrap();
    assert!(text.contains("Covered") && !text.contains("Carried"), "{text}");
    let kept = rows(&f, &RELEASE_KEEPS);
    let Release::Released { replayed: false, boundary: Some(boundary) } = release_through(&mut f, 10).unwrap() else {
        panic!("released");
    };
    assert_eq!(boundary.terminal_receipt.as_ref(), Some(&covered));
    assert_eq!(boundary.event_count, 1);
    let stored: (i64, i64, String, String) = f
        .store
        .read_with(|conn| {
            conn.query_row(
                "SELECT released_restore_generation,released_accepted_cursor,released_boundary_json,carried_manifest_json
                 FROM live_owner_activations WHERE activation_id='adoption' AND released_at_ms=30",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
        })
        .unwrap();
    assert_eq!((stored.0, stored.1), (0, 10));
    assert_eq!(serde_json::from_str::<RetainedPrefixBody>(&stored.2).unwrap(), boundary);
    assert_eq!(
        serde_json::from_str::<Vec<CarriedDelivery>>(&stored.3).unwrap(),
        vec![CarriedDelivery { receipt: carried, native_sequence: sequence }]
    );
    assert_eq!(f.store.table_row_count("live_device_application_bindings").unwrap(), 0);
    assert_eq!(rows(&f, &RELEASE_KEEPS), kept, "sources, history, settlements and input stay");
    assert!(!f
        .store
        .read_with(|conn| settlement_pending(conn, "namespace", &f.key, &f.binding.lineage_claim_id, None))
        .unwrap());
    assert_eq!(f.store.read_with(|conn| park_pending(conn, "workspace", "object")).unwrap(), None);
    let released = rows(&f, &RELEASE_WRITES);
    assert_eq!(
        release_through(&mut f, 10).unwrap(),
        Release::Released { replayed: true, boundary: Some(boundary) }
    );
    let Reconciliation::Reconciled { adoption, applications, has_more_applications: false, settle: false } =
        reconcile(&mut f, 10, None, None).unwrap()
    else {
        panic!("a released reconciliation replays");
    };
    assert!(adoption.is_some());
    assert_eq!(applications.iter().map(|ack| ack.journal_cursor).collect::<Vec<_>>(), [3]);
    assert_eq!(rows(&f, &RELEASE_WRITES), released);
}

/// Each class needs its own evidence. Covered: accepted history keeps the
/// exact receipt. Carried: the receipt names the entry's own delivery.
/// Abandoned: the strict seed representation. One failing condition each
/// refuses the release with no writes; intact, an abandoned seed releases
/// at its origin with no settlement.
#[test]
fn each_release_class_needs_its_own_evidence() {
    for (class, damage) in [
        (
            "covered",
            "UPDATE owner_ydoc_outbox_entries SET accepted_receipt_json=json_set(accepted_receipt_json,'$.acceptingHostEpoch',2)
             WHERE json_extract(accepted_receipt_json,'$.journalCursor')=3",
        ),
        (
            "carried",
            "UPDATE owner_ydoc_outbox_entries SET accepted_receipt_json=json_set(accepted_receipt_json,'$.deliveryId','another')
             WHERE json_extract(accepted_receipt_json,'$.journalCursor')=5",
        ),
    ] {
        let (mut f, covered, _, _) = covered_and_carried();
        host_document(&mut f, true, true);
        retirement_settle(&mut f, 10, Some(covered)).unwrap();
        write(&mut f, damage);
        let before = rows(&f, &RELEASE_WRITES);
        assert!(matches!(release_through(&mut f, 10), Err(ApplicationError::Conflict)), "{class}");
        assert_eq!(rows(&f, &RELEASE_WRITES), before, "{class}");
    }
    for intact in [false, true] {
        let (mut f, seed, _) = seeded();
        let absent = JournalEvidence { receipts: vec![], absent: vec![seed] };
        reconcile(&mut f, 10, None, Some(&absent)).unwrap();
        host_document(&mut f, true, true);
        if !intact {
            write(&mut f, "UPDATE owner_ydoc_outbox_entries SET terminal_blob_digest=update_digest");
        }
        let before = rows(&f, &RELEASE_WRITES);
        let released = release_through(&mut f, 10);
        if intact {
            let Release::Released { boundary: Some(boundary), .. } = released.unwrap() else {
                panic!("an abandoned seed releases");
            };
            assert_eq!((boundary.terminal_receipt, boundary.event_count), (None, 0));
            assert_eq!(f.store.table_row_count("live_device_settlements").unwrap(), 0);
        } else {
            assert!(released.is_err());
            assert_eq!(rows(&f, &RELEASE_WRITES), before);
        }
    }
}

#[test]
fn a_released_replay_answers_from_its_release_after_a_successor() {
    let (mut f, covered, carried, _) = covered_and_carried();
    host_document(&mut f, true, true);
    retirement_settle(&mut f, 10, Some(covered.clone())).unwrap();
    let released = release_through(&mut f, 10).unwrap();
    let reconciled = reconcile(&mut f, 10, None, None).unwrap();
    add_activation(&mut f, "successor", "adoption", false, 3);
    host_document(&mut f, true, false);
    let successor = f
        ._owner
        .register_activation(&mut f.store, "namespace".into(), retirement_host(), f.binding.clone(), "successor".into())
        .unwrap();
    let entry = entry_update(&f, &carried.delivery_id);
    let event = native_tail_event(&f, entry, carried.delivery_id.clone(), 5);
    assert!(matches!(
        apply_committed(&mut f.store, &mut WriterDocCache::new(), &successor, event, &NoFaults, 100_000_000, |_, _, _, _| Ok(())).unwrap(),
        ApplicationResult::Applied(..)
    ));
    let before = rows(&f, &RELEASE_WRITES);
    assert_eq!(
        release_through(&mut f, 10).unwrap(),
        match released {
            Release::Released { boundary, .. } => Release::Released { replayed: true, boundary },
            pending => panic!("{pending:?}"),
        }
    );
    assert_eq!(reconcile(&mut f, 10, None, None).unwrap(), reconciled);
    assert_eq!(reconcile(&mut f, 10, Some(&covered), None).unwrap(), Reconciliation::Reconciled {
        adoption: match &reconciled { Reconciliation::Reconciled { adoption, .. } => adoption.clone(), _ => None },
        applications: vec![],
        has_more_applications: false,
        settle: false,
    });
    assert_eq!(rows(&f, &RELEASE_WRITES), before);
}

fn begin(f: &mut Fixture, through: i64) -> Result<RetirementTarget, ApplicationError> {
    let key = retirement_key(f, through);
    begin_retirement(&mut f.store, &retirement_scope(), &key, false, &NoFaults)
}

fn intents(f: &Fixture) -> Vec<(String, i64)> {
    f.store
        .read_with(|conn| {
            conn.prepare("SELECT activation_id,restore_fence_generation FROM live_owner_retirements ORDER BY 1")?
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
                .collect::<rusqlite::Result<Vec<_>>>()
        })
        .unwrap()
}

#[test]
fn a_restore_waits_while_its_activation_retires() {
    let fence = |f: &mut Fixture| {
        let terminal = f.cut.terminal_receipt.clone();
        let sequence = f.cut.expected_local_sequence;
        let coordinate = f.handle.registration.lock().unwrap().coordinate.clone();
        f._owner.fence_restore(
            &mut f.store,
            None,
            NativeRestoreFence {
                point: crate::live_update_application::NativeRestoreSelection {
                    journal_cursor: terminal.as_ref().map_or(0, |r| r.journal_cursor),
                    receipt_digest: terminal.as_ref().map_or_else(
                        || f.binding.lineage_claim_id.clone(),
                        |r| r.update_digest.clone(),
                    ),
                },
                operation_id: "restore".into(),
                relay_database_namespace: "namespace".into(),
                old_binding: f.binding.clone(),
                host_id: "host".into(),
                new_fence: 1,
                origin: RestoreDeliveryOrigin::Owner { id: f.cut.adoption_id.clone() },
                terminal,
                applied_sequence: sequence,
            },
            coordinate,
            40,
            &NoFaults,
            |_, _| Ok(()),
        )
    };
    let mut f = Fixture::new();
    f.adopt().unwrap();
    let mut wrong = retirement_key(&f, 10);
    wrong.restore_fence_generation = 1;
    assert!(matches!(
        begin_retirement(&mut f.store, &retirement_scope(), &wrong, false, &NoFaults),
        Err(ApplicationError::Conflict)
    ));
    assert!(intents(&f).is_empty(), "an invalid key records nothing");
    assert!(!begin(&mut f, 10).unwrap().released);
    assert!(!begin(&mut f, 10).unwrap().released, "Phase A runs again on its own intent");
    assert_eq!(intents(&f), [("adoption".to_owned(), 0)]);
    drop(f.store);
    f.store = EngineStore::open(&f._scratch.join("engine.db"), 31).unwrap();
    f._owner = ApplicationOwner::new("workspace".into()).unwrap();
    assert_eq!(intents(&f), [("adoption".to_owned(), 0)], "the intent survives the restart");
    assert!(f
        .store
        .read_with(|conn| super::super::seed_hold(conn, "namespace", &f.binding))
        .unwrap()
        .is_none());
    assert!(matches!(fence(&mut f), Err(ApplicationError::Conflict)));
    assert_eq!(f.store.table_row_count("live_restore_fences").unwrap(), 0);
    host_document(&mut f, true, true);
    assert!(matches!(release_through(&mut f, 10).unwrap(), Release::Released { replayed: false, .. }));
    assert!(intents(&f).is_empty());
    assert!(begin(&mut f, 10).unwrap().released);
    assert!(intents(&f).is_empty(), "a released replay records nothing");
    let mut f = never_adopted();
    begin(&mut f, 10).unwrap();
    assert_eq!(intents(&f), [("captured".to_owned(), 0)]);
    host_document(&mut f, true, false);
    release_through(&mut f, 10).unwrap();
    assert!(intents(&f).is_empty());
    let mut f = Fixture::new();
    f.adopt().unwrap();
    fence(&mut f).unwrap();
}

fn restore_fence(f: &mut Fixture, operation: &str) -> Result<NativeRestoreFenceReceipt, ApplicationError> {
    let coordinate = f.handle.registration.lock().unwrap().coordinate.clone();
    f._owner.fence_restore(
        &mut f.store,
        None,
        NativeRestoreFence {
            point: crate::live_update_application::NativeRestoreSelection {
                journal_cursor: 0,
                receipt_digest: f.binding.lineage_claim_id.clone(),
            },
            operation_id: operation.into(),
            relay_database_namespace: "namespace".into(),
            old_binding: f.binding.clone(),
            host_id: "host".into(),
            new_fence: 1,
            origin: RestoreDeliveryOrigin::Owner { id: f.cut.adoption_id.clone() },
            terminal: f.cut.terminal_receipt.clone(),
            applied_sequence: f.cut.expected_local_sequence,
        },
        coordinate,
        40,
        &NoFaults,
        |_, _| Ok(()),
    )
}

fn cancellation(f: &Fixture, operation: &str) -> RestoreFenceCancellation {
    RestoreFenceCancellation {
        operation_id: operation.into(),
        object_id: f.binding.object_id.clone(),
        lineage_claim_id: f.binding.lineage_claim_id.clone(),
        host_id: "host".into(),
        new_fence: f.binding.restore_fence_generation + 1,
    }
}

fn cancel(
    f: &mut Fixture,
    input: &RestoreFenceCancellation,
) -> Result<RestoreFenceCancellationOutcome, ApplicationError> {
    cancel_restore_fence(&mut f.store, "namespace", "workspace", "host", input, 50, &NoFaults)
}

fn bound(f: &Fixture) -> (i64, bool) {
    f.store
        .read_with(|conn| {
            conn.query_row(
                "SELECT restore_fence_generation,available FROM live_device_application_bindings
                 WHERE relay_database_namespace='namespace'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
        })
        .unwrap()
}

#[test]
fn a_restore_fence_that_never_landed_is_cancelled_for_good() {
    let mut f = Fixture::new();
    f.adopt().unwrap();
    let input = cancellation(&f, "restore");
    let cancelled = RestoreFenceCancellationOutcome::Cancelled {
        generation: 0,
        binding: Some(f.binding.clone()),
    };
    assert_eq!(cancel(&mut f, &input).unwrap(), cancelled);
    assert_eq!(cancel(&mut f, &input).unwrap(), cancelled, "a duplicate answers the same");
    assert_eq!(f.store.table_row_count("live_restore_cancellations").unwrap(), 1);
    for _ in 0..2 {
        assert!(matches!(restore_fence(&mut f, "restore"), Err(ApplicationError::Conflict)));
    }
    assert_eq!(f.store.table_row_count("live_restore_fences").unwrap(), 0);
    assert_eq!(bound(&f), (0, true));
    let mut later = input.clone();
    later.new_fence = 2;
    let mut lineage = input.clone();
    lineage.lineage_claim_id = "f".repeat(64);
    let mut object = input.clone();
    object.object_id = "other".into();
    for wrong in [later, lineage, object] {
        assert!(matches!(cancel(&mut f, &wrong), Err(ApplicationError::Conflict)), "{wrong:?}");
    }
    assert_eq!(f.store.table_row_count("live_restore_cancellations").unwrap(), 1);
    assert!(!begin(&mut f, 10).unwrap().released);
    assert_eq!(intents(&f), [("adoption".to_owned(), 0)]);
    drop(f.store);
    f.store = EngineStore::open(&f._scratch.join("engine.db"), 31).unwrap();
    assert_eq!(cancel(&mut f, &input).unwrap(), cancelled);
}

#[test]
fn a_committed_restore_fence_ends_in_its_terminal_cancellation_until_admission() {
    let mut f = Fixture::new();
    f.adopt().unwrap();
    let receipt = restore_fence(&mut f, "restore").unwrap();
    let input = cancellation(&f, "restore");
    let mut lineage = input.clone();
    lineage.lineage_claim_id = "f".repeat(64);
    let mut later = input.clone();
    later.new_fence = 2;
    let mut elsewhere = input.clone();
    elsewhere.host_id = "elsewhere".into();
    for wrong in [lineage, later, elsewhere, cancellation(&f, "other")] {
        assert!(matches!(cancel(&mut f, &wrong), Err(ApplicationError::Conflict)), "{wrong:?}");
    }
    assert!(
        matches!(
            cancel_restore_fence(&mut f.store, "namespace", "workspace", "elsewhere", &input, 50, &NoFaults),
            Err(ApplicationError::Conflict)
        ),
        "another host's engine"
    );
    let RestoreFenceCancellationOutcome::FenceCancelled(cancelled) = cancel(&mut f, &input).unwrap() else {
        panic!("the committed fence ends in its cancellation");
    };
    let mut stopped = f.binding.clone();
    stopped.restore_fence_generation = 1;
    assert_eq!(cancelled.fence, receipt);
    assert_eq!(cancelled.binding, stopped);
    assert_eq!(cancelled.endpoint.terminal_receipt, f.cut.terminal_receipt);
    assert_eq!(cancelled.endpoint.event_count, 0);
    assert_eq!(
        cancel(&mut f, &input).unwrap(),
        RestoreFenceCancellationOutcome::FenceCancelled(cancelled.clone()),
        "a duplicate answers the committed receipt"
    );
    assert_eq!(bound(&f), (1, false));
    assert_eq!(f.store.table_row_count("live_restore_cancellations").unwrap(), 0);
    assert!(matches!(restore_fence(&mut f, "restore"), Err(ApplicationError::Conflict)), "the fence never replays");
    let mut f = Fixture::new();
    f.adopt().unwrap();
    restore_fence(&mut f, "restore").unwrap();
    let input = cancellation(&f, "restore");
    let conn = rusqlite::Connection::open(f._scratch.join("engine.db")).unwrap();
    conn.execute_batch(
        "PRAGMA foreign_keys=OFF;
         UPDATE live_restore_fences SET proposal_json='{}',proposal_candidate_sha256='a',
           proposal_frozen_sha256='a',proposal_point_sha256='a',application_json='{}',
           application_delivery_id='admitted'",
    )
    .unwrap();
    drop(conn);
    assert!(matches!(cancel(&mut f, &input), Err(ApplicationError::Conflict)));
    assert_eq!(f.store.table_row_count("live_restore_cancellations").unwrap(), 0);
}

#[test]
fn a_released_activation_never_regains_live_authority() {
    for adopted in [true, false] {
        let mut f = if adopted {
            let mut f = Fixture::new();
            f.adopt().unwrap();
            f
        } else {
            never_adopted()
        };
        host_document(&mut f, true, true);
        assert!(matches!(release_through(&mut f, 10).unwrap(), Release::Released { .. }), "adopted={adopted}");
        host_document(&mut f, true, false);
        drop(f.store);
        f.store = EngineStore::open(&f._scratch.join("engine.db"), 31).unwrap();
        let mut owner = ApplicationOwner::new("workspace".into()).unwrap();
        let id = f.cut.adoption_id.clone();
        assert!(matches!(
            owner.register_activation(&mut f.store, "namespace".into(), retirement_host(), f.binding.clone(), id),
            Err(ApplicationError::Conflict)
        ), "adopted={adopted}");
        let unnamed = owner.register(&mut f.store, "namespace".into(), retirement_host(), f.binding.clone());
        if adopted {
            assert!(matches!(unnamed, Err(ApplicationError::Conflict)));
            assert_eq!(f.store.table_row_count("live_device_application_bindings").unwrap(), 0);
        } else {
            assert_eq!(unnamed.unwrap().activation_id(), None);
        }
    }
}

#[test]
fn a_retiring_activation_never_serves_again_after_a_restart() {
    let writes = [&RELEASE_WRITES[..], &["binary_blobs", "live_owner_retirements"]].concat();
    for adopted in [true, false] {
        let mut f = imported_fixture();
        let other = other_document(&mut f);
        let payload = serde_json::json!({
            "versionId":"main", "objectId":"other", "contentKind":"richdoc", "isBaseState":true,
            "lineageClaimId":other.lineage_claim_id, "updateBlobSha256":other.lineage_claim_id,
        });
        write(&mut f, &format!(
            "UPDATE ydoc_docs SET path='other.md',base_origin_id='remote',base_origin_seq=8,base_relay_seq=9
               WHERE object_id='other';
             INSERT INTO replication_log(workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms,imported)
               VALUES('workspace','remote',8,'ydoc.update','{payload}',1,1)"
        ));
        let other_key = DocKey::new("workspace", "main", "other").unwrap();
        let id = capture_imported(&mut f, 1_000_000).unwrap().activation_id;
        f.cut.adoption_id = id.clone();
        if adopted {
            f.adopt().unwrap();
        }
        begin(&mut f, 10).unwrap();
        let before = rows(&f, &writes);
        assert!(matches!(f.adopt(), Err(ApplicationError::Conflict)), "adopted={adopted}");
        assert_eq!(rows(&f, &writes), before, "adopted={adopted}");
        drop(f.store);
        f.store = EngineStore::open(&f._scratch.join("engine.db"), 31).unwrap();
        f._owner = ApplicationOwner::new("workspace".into()).unwrap();
        let unrelated =
            capture_imported_owner_activation(&mut f.store, "namespace", &other_key, "other.md", 1_000_000, &NoFaults, None)
                .unwrap()
                .activation_id;
        resume_imported_owner_activation(&mut f.store, "namespace", &other_key, "other.md", &unrelated, 1_000_000, None)
            .unwrap();
        let unrelated_handle = f
            ._owner
            .register_activation(&mut f.store, "namespace".into(), retirement_host(), other, unrelated.clone())
            .unwrap();
        let live = || unrelated_handle.registration.lock().unwrap().live;
        // On another connection, a registration that went on would first
        // retire the unrelated one.
        let before = rows(&f, &writes);
        let elsewhere = ApplicationHostCoordinate { connection_id: "elsewhere".into(), ..retirement_host() };
        for coordinate in [retirement_host(), elsewhere] {
            let named = f._owner.register_activation(&mut f.store, "namespace".into(), coordinate, f.binding.clone(), id.clone());
            assert!(matches!(named, Err(ApplicationError::Conflict)), "adopted={adopted}");
            assert!(live(), "adopted={adopted}");
        }
        assert!(matches!(capture_imported(&mut f, 1_000_000), Err(ApplicationError::Conflict)), "adopted={adopted}");
        assert!(matches!(resume_imported(&mut f, &id, 1_000_000), Err(ApplicationError::Conflict)), "adopted={adopted}");
        assert_eq!(rows(&f, &writes), before, "adopted={adopted}");
        // Unnamed, an adopted activation's registration would serve it; a
        // never-adopted one's serves nothing, and adopts nothing.
        let unnamed = f._owner.register(&mut f.store, "namespace".into(), retirement_host(), f.binding.clone());
        if adopted {
            assert!(matches!(unnamed, Err(ApplicationError::Conflict)));
        } else {
            f.handle = unnamed.unwrap();
            assert_eq!(f.handle.activation_id(), None);
            assert!(matches!(f.adopt(), Err(ApplicationError::Conflict)));
        }
        assert_eq!(rows(&f, &writes), before, "adopted={adopted}");
        let cut = OwnerAdoptionCut {
            adoption_id: unrelated.clone(),
            source_moment_id: "other-original".into(),
            ..f.cut.clone()
        };
        adopt_owner_committed(&mut f.store, &unrelated_handle, cut, 1_000_000, 100, 10, &NoFaults, None, |_, _, _, _| Ok(()))
            .unwrap();
        host_document(&mut f, true, adopted);
        assert!(
            matches!(release_through(&mut f, 10).unwrap(), Release::Released { replayed: false, .. }),
            "adopted={adopted}"
        );
        assert!(intents(&f).is_empty());
        assert!(live(), "adopted={adopted}");
        assert_eq!(unrelated_handle.activation_id().as_deref(), Some(unrelated.as_str()));
    }
}

#[test]
fn readers_after_a_release() {
    let (mut f, covered, carried, _) = covered_and_carried();
    host_document(&mut f, true, true);
    retirement_settle(&mut f, 10, Some(covered)).unwrap();
    let key = f.key.clone();
    let binding = f.binding.clone();
    let bootstrap_tip = |f: &Fixture| {
        let held = f.handle.registration.lock().unwrap();
        let input = NativeRestoreFence {
            point: crate::live_update_application::NativeRestoreSelection {
                journal_cursor: 0,
                receipt_digest: f.binding.lineage_claim_id.clone(),
            },
            operation_id: "restore".into(),
            relay_database_namespace: "namespace".into(),
            old_binding: f.binding.clone(),
            host_id: "host".into(),
            new_fence: 1,
            origin: RestoreDeliveryOrigin::Bootstrap { id: "bootstrap".into() },
            terminal: None,
            applied_sequence: 0,
        };
        f.store.read_with(|conn| super::super::restore_fence::applied_tip(conn, &held, &input))
    };
    let append = |f: &mut Fixture, max_pending_bytes: i64| {
        owner_outbox::append(
            &mut f.store,
            "workspace",
            owner_outbox::OwnerOutboxAppendInput {
                binding: f.binding.clone(),
                base_update: f.cut.baseline_bytes.clone(),
                append_key: "after-release".into(),
                update: f.doc.encode_full_state(),
                limits: owner_outbox::OwnerOutboxLimits { max_pending_bytes, max_pending_age_ms: 100_000 },
                created_at_ms: 40,
            },
        )
    };
    let refuse = |f: &mut Fixture| {
        let outbox: String = f
            .store
            .read_with(|conn| conn.query_row("SELECT outbox_id FROM owner_ydoc_outbox_entries WHERE delivery_id=?1", [&carried.delivery_id], |r| r.get(0)))
            .unwrap();
        let input = owner_outbox::OwnerOutboxRefuseInput {
            outbox_id: outbox,
            delivery_id: carried.delivery_id.clone(),
            update_digest: carried.update_digest.clone(),
            reason: "refused".into(),
        };
        f.store.write_with(&NoFaults, |tx| owner_outbox::refuse_entry_in_tx(tx, "workspace", &input, 40).map(|_| ()))
    };
    let held = |f: &Fixture| {
        f.store
            .read_with(|conn| {
                Ok::<_, ApplicationError>((
                    crate::author_coverage::accepted_only_in(conn, &key).map_err(ApplicationError::Collab)?,
                    owner_outbox::has_adopted_owner_in(conn, &key).map_err(ApplicationError::Collab)?,
                    owner_outbox::enrollment::capture_in(conn, &binding).is_ok(),
                    owner_activations::retained_limits_exceed(conn, "workspace", 999_999, 100_000)?,
                ))
            })
            .unwrap()
    };
    assert!(matches!(bootstrap_tip(&f), Err(ApplicationError::Conflict)));
    assert_eq!(held(&f), (true, true, false, true));
    assert!(matches!(append(&mut f, 1), Err(owner_outbox::OwnerOutboxError::InvalidInput(_))));
    assert!(refuse(&mut f).is_err());
    assert!(matches!(observe(&mut f), Err(owner_outbox::OwnerOutboxError::ParentMismatch)));
    release_through(&mut f, 10).unwrap();
    let (binding_json, host) = (
        serde_json::to_string(&f.binding).unwrap(),
        serde_json::to_string(&retirement_host()).unwrap(),
    );
    f.store
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT INTO live_device_bootstraps(relay_database_namespace,workspace_id,main_version_id,object_id,
                    lineage_claim_id,bootstrap_id,bootstrap_moment_id,baseline_moment_relay_sequence,
                    baseline_registered_at_ms,baseline_digest,baseline_byte_length,projected_markdown_digest,
                    projected_markdown_byte_length,binding_json,host_coordinate_json,local_ydoc_sequence)
                 VALUES ('namespace','workspace','main','object',?1,'bootstrap','original',1,3,?1,?2,?3,?4,?5,?6,0)",
                params![
                    f.binding.lineage_claim_id,
                    f.cut.baseline_bytes.len() as i64,
                    f.cut.source_digest,
                    f.cut.source_byte_length,
                    binding_json,
                    host
                ],
            )
            .map_err(write_sql)
        })
        .unwrap();
    assert!(matches!(bootstrap_tip(&f), Err(ApplicationError::Conflict)));
    write(&mut f, "DELETE FROM live_device_bootstraps");
    // Its carried delivery keeps coverage accepted-only and its budget
    // retained. Ordinary ownership sees no current owner, and enrollment
    // still refuses the lineage its owner adopted.
    assert_eq!(held(&f), (true, false, false, true));
    write(&mut f, "UPDATE live_owner_activations SET carried_manifest_json='[]'");
    assert_eq!(held(&f), (false, false, false, false), "with nothing carried, nothing is retained");
    let entries = f.store.table_row_count("owner_ydoc_outbox_entries").unwrap();
    assert!(matches!(append(&mut f, 1_000_000), Err(owner_outbox::OwnerOutboxError::Frozen)));
    assert!(refuse(&mut f).is_err());
    assert_eq!(f.store.table_row_count("owner_ydoc_outbox_entries").unwrap(), entries);
    let observed = f.store.table_row_count("ydoc_owner_bindings").unwrap();
    assert!(matches!(observe(&mut f), Err(owner_outbox::OwnerOutboxError::ParentMismatch)));
    assert_eq!(f.store.table_row_count("ydoc_owner_bindings").unwrap(), observed);
}

#[test]
fn carried_deliveries_keep_the_limits_they_were_accepted_under() {
    let exceeds = |f: &Fixture, bytes: i64| {
        f.store
            .read_with(|conn| owner_activations::retained_limits_exceed(conn, "workspace", bytes, 100_000))
            .unwrap()
    };
    let another_source = |f: &mut Fixture| {
        write(
            f,
            "INSERT INTO ydoc_owner_activation_sources SELECT 'second',relay_database_namespace,workspace_id,
                version_id,object_id,lineage_claim_id,source_moment_id,source_digest,full_state_digest,descriptor_json
             FROM ydoc_owner_activation_sources WHERE activation_id='captured'",
        )
    };
    let (mut f, covered, _, _) = covered_and_carried();
    host_document(&mut f, true, true);
    retirement_settle(&mut f, 10, Some(covered)).unwrap();
    release_through(&mut f, 10).unwrap();
    assert_eq!((exceeds(&f, 999_999), exceeds(&f, 1_000_000)), (true, false), "the adopted tail");
    another_source(&mut f);
    for (id, through) in [("captured", 12), ("second", 14)] {
        f.cut.adoption_id = id.into();
        release_through(&mut f, through).unwrap();
        let (limits, adopted, manifest): (Option<i64>, Option<String>, String) = f
            .store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT max_pending_bytes,evidence_digest,carried_manifest_json FROM live_owner_activations
                     WHERE activation_id=?1",
                    [id],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
            })
            .unwrap();
        assert_eq!((limits, adopted), (None, None), "{id} records no adoption fact");
        assert_eq!(serde_json::from_str::<Vec<CarriedDelivery>>(&manifest).unwrap().len(), 1, "{id}");
        assert_eq!((exceeds(&f, 999_999), exceeds(&f, 1_000_000)), (true, false), "{id}");
    }
    // Two never-adopted releases with no adopted ancestor carry nothing;
    // shaped to carry anyway, the chain has no limits to exceed.
    let mut f = never_adopted();
    host_document(&mut f, true, false);
    release_through(&mut f, 10).unwrap();
    another_source(&mut f);
    f.cut.adoption_id = "second".into();
    release_through(&mut f, 12).unwrap();
    write(&mut f, "UPDATE live_owner_activations SET carried_manifest_json='[{}]' WHERE activation_id='second'");
    assert!(!exceeds(&f, 1));
}

fn observe(f: &mut Fixture) -> Result<(), owner_outbox::OwnerOutboxError> {
    let key = f.key.clone();
    let (head, local) = f
        .store
        .read_with(|conn| {
            let head: i64 = conn
                .query_row("SELECT head_update_seq FROM ydoc_docs WHERE object_id='object'", [], |r| r.get(0))
                .map_err(read_sql)?;
            Ok::<_, ApplicationError>((head, durable::load_doc_in(conn, &key)?.encode_full_state()))
        })
        .unwrap();
    let observed = owner_outbox::draft::ObservedOwnerBinding {
        binding: f.binding.clone(),
        relay_database_namespace: "namespace".into(),
        revision: 1,
        accepted_cursor: 0,
        native_head_sequence: head,
        checkpoint_digest: hex_sha256(&local),
        limits: owner_outbox::OwnerOutboxLimits { max_pending_bytes: 1_000_000, max_pending_age_ms: 100_000 },
    };
    match f.store.write_with(&NoFaults, |tx| {
        owner_outbox::draft::install_observed_binding_in_tx(tx, "workspace", &observed, &local)
    })? {
        TxnOutcome::Committed(()) => Ok(()),
        TxnOutcome::Crashed { .. } => panic!("observed binding crash"),
    }
}

fn preparation_key(f: &Fixture) -> PreparationKey {
    PreparationKey {
        object_id: "object".into(),
        lineage_claim_id: f.binding.lineage_claim_id.clone(),
        activation_id: f.cut.adoption_id.clone(),
        restore_fence_generation: 0,
    }
}

fn prepare(
    f: &Fixture,
    preparations: &RetirementPreparations,
    owner: &std::sync::Arc<std::sync::atomic::AtomicBool>,
) -> Result<Option<PreparationPending>, ApplicationError> {
    prepare_retirement(&f.store, &retirement_scope(), &preparation_key(f), preparations, owner)
}

fn owner() -> std::sync::Arc<std::sync::atomic::AtomicBool> {
    std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true))
}

fn prepared_append(
    f: &mut Fixture,
    update: &[u8],
    now: i64,
    preparations: &RetirementPreparations,
) -> Result<owner_outbox::OwnerOutboxEntry, crate::CollabError> {
    let key = f.key.clone();
    let path = f.binding.current_path.clone();
    let attribution = dohc_engine_domain::ChangeAttribution {
        actor_kind: dohc_engine_domain::ChangeActorKind::Agent,
        on_behalf_of: Some("owner".into()),
        depth: 1,
        run: None,
        agent_run_id: None,
    };
    crate::record_local_update(
        &mut f.store,
        &mut WriterDocCache::new(),
        &f.key,
        update,
        crate::LocalAppend {
            actor_origin_id: Some("native-agent"),
            attribution: Some(&attribution),
            ..Default::default()
        },
        &NoFaults,
        now,
        |tx, outcome, _| {
            owner_outbox::append_adopted_local_update_in_tx(tx, &key, &path, outcome.seq, update, preparations, now)
        },
    )?;
    let delivery = native_entries(f).last().unwrap().0.clone();
    let outbox = outbox_of(f, &delivery);
    Ok(owner_outbox::read_pending(&f.store, "workspace", &outbox).unwrap().entries.last().unwrap().clone())
}

fn appended(f: &Fixture) -> (Vec<u8>, i64, Vec<EntryState>) {
    (full_state(f), f.store.table_row_count("ydoc_updates").unwrap(), native_entries(f))
}

#[test]
fn a_local_append_and_a_stop_preparation_never_interleave() {
    // The gap without a block: the check passed, the edit landed, and the
    // journal never accepted it.
    let mut f = Fixture::new();
    f.adopt().unwrap();
    let (preparations, owner) = (RetirementPreparations::default(), owner());
    assert_eq!(prepare(&f, &preparations, &owner).unwrap(), None);
    assert!(preparations.release(&preparation_key(&f), &owner));
    let late = native_tail_edit(&mut f, "# Late\n", 11);
    let absent = JournalEvidence { receipts: vec![], absent: vec![late.delivery_id] };
    assert!(matches!(reconcile(&mut f, 10, None, Some(&absent)), Err(ApplicationError::Conflict)));

    let mut f = Fixture::new();
    f.adopt().unwrap();
    let first = native_tail_edit(&mut f, "# First\n", 11);
    assert_eq!(prepare(&f, &preparations, &owner).unwrap(), Some(PreparationPending::NativePending));
    assert!(!preparations.blocks(&f.cut.adoption_id, 0));
    let update = f.doc.rewrite_content_to_markdown_preserving_source(ContentKind::Richdoc, "# Second\n").unwrap();
    let second = prepared_append(&mut f, &update, 12, &preparations).unwrap();
    assert_eq!(prepare(&f, &preparations, &owner).unwrap(), Some(PreparationPending::NativePending));
    acknowledge_entry(&mut f, &receipt_of(&first.delivery_id, &first.update_digest, 3));
    acknowledge_entry(&mut f, &receipt_of(&second.delivery_id, &second.update_digest, 4));

    assert_eq!(prepare(&f, &preparations, &owner).unwrap(), None);
    let before = appended(&f);
    let third = f.doc.rewrite_content_to_markdown_preserving_source(ContentKind::Richdoc, "# Third\n").unwrap();
    assert!(matches!(prepared_append(&mut f, &third, 13, &preparations), Err(crate::CollabError::OwnerOutboxFrozen)));
    assert_eq!(appended(&f), before);
    assert_eq!(prepare(&f, &preparations, &owner).unwrap(), None);

    begin(&mut f, 10).unwrap();
    preparations.end(&f.cut.adoption_id);
    assert!(!preparations.blocks(&f.cut.adoption_id, 0));
    assert!(matches!(
        prepared_append(&mut f, &third, 13, &preparations),
        Err(crate::CollabError::OwnerOutboxFrozen)
    ), "the intent refuses it from here");
    assert_eq!(appended(&f), before);
    assert!(matches!(prepare(&f, &preparations, &owner), Err(ApplicationError::Conflict)));
    assert!(matches!(reconcile(&mut f, 10, None, None).unwrap(), Reconciliation::Reconciled { .. }));
}

/// A preparation lasts only while the owner that made it does. Another
/// owner neither releases it nor inherits it, and the owner's end reopens
/// appends.
#[test]
fn a_preparation_lasts_only_while_its_owner_does() {
    let mut f = Fixture::new();
    f.adopt().unwrap();
    let (preparations, first, other) = (RetirementPreparations::default(), owner(), owner());
    assert_eq!(prepare(&f, &preparations, &first).unwrap(), None);
    assert!(!preparations.release(&preparation_key(&f), &other));
    let mut later = preparation_key(&f);
    later.restore_fence_generation = 1;
    assert!(!preparations.release(&later, &first), "a release names its exact generation");
    assert!(!preparations.blocks(&f.cut.adoption_id, 1));
    assert!(preparations.blocks(&f.cut.adoption_id, 0));
    first.store(false, std::sync::atomic::Ordering::Release);
    assert!(!preparations.blocks(&f.cut.adoption_id, 0));
    let update = f.doc.rewrite_content_to_markdown_preserving_source(ContentKind::Richdoc, "# Reopened\n").unwrap();
    prepared_append(&mut f, &update, 11, &preparations).unwrap();
    assert!(!preparations.release(&preparation_key(&f), &first), "an ended owner's preparation was not in force");
    assert_eq!(prepare(&f, &preparations, &other).unwrap(), Some(PreparationPending::NativePending));
    assert!(!preparations.blocks(&f.cut.adoption_id, 0));
}