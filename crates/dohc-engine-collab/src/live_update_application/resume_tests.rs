/// Record the settlement as `moment`, its file holding what the host's
/// settlement writes: the settled Markdown source over the file's current
/// snapshot, as capture reads it too.
fn record_settled(
    store: &mut EngineStore,
    audit: &LiveSettlementAudit,
    doc_key: &DocKey,
    moment: &str,
) -> Result<LiveSettlementResult, ApplicationError> {
    let local;
    let doc = match audit.accepted_prefix() {
        Some(doc) => doc,
        None => {
            local = store.read_with(|conn| durable::load_doc_in(conn, doc_key))?;
            &local
        }
    };
    let projection = doc.project(ContentKind::Richdoc)?.content;
    let snapshot: Option<String> = store.read_with(|conn| {
        conn.query_row(
            "SELECT b.text FROM snapshots s JOIN blobs b ON b.sha256=s.blob_sha256 WHERE s.path='owner.md'",
            [],
            |r| r.get(0),
        )
        .optional()
        .map(Option::flatten)
        .map_err(read_sql)
    })?;
    let text = doc
        .settled_markdown_source(&projection, || Ok::<_, ApplicationError>(snapshot))?
        .unwrap_or(projection);
    let vector = hex_sha256(&doc.encode_state_vector());
    record_text(store, audit, moment, &text, &vector)
}

/// The retirement form of settlement at `terminal`, through F=10, as the
/// host records it.
fn retire_settled(f: &mut Fixture, terminal: Option<LiveUpdateReceipt>, moment: &str) -> Result<LiveSettlementResult, ApplicationError> {
    let key = retirement_key(f, 10);
    let doc_key = f.key.clone();
    let reconstruction = NativeHistoryReconstruction { working_reserve_bytes: 8 * 1024 * 1024 };
    with_retirement_settlement(&mut f.store, &retirement_scope(), &key, &retirement_host(), terminal, 128, reconstruction, |store, audit| {
        record_settled(store, audit, &doc_key, moment)
    })
}

/// The ordinary form of settlement at `terminal`, as the host records it.
fn settled(f: &mut Fixture, terminal: Option<LiveUpdateReceipt>, moment: &str) -> Result<LiveSettlementResult, ApplicationError> {
    let doc_key = f.key.clone();
    let reconstruction = NativeHistoryReconstruction { working_reserve_bytes: 8 * 1024 * 1024 };
    with_settlement(&mut f.store, &f.handle, terminal, 128, reconstruction, |store, audit| {
        record_settled(store, audit, &doc_key, moment)
    })
}

/// A root that applied its native update at 3, and whose updates C1 and C2
/// the relay accepted at 5 and 6 without the host applying them, settled at
/// B=3 through F and released, its document back in the scope. Its file holds
/// what it settled at B, while its Y.Doc also holds C1 and C2. Nothing aligns
/// the file with the Y.Doc. Returns the covered receipt and C1 and C2.
fn released_at_b() -> (Fixture, LiveUpdateReceipt, CarriedDelivery, CarriedDelivery) {
    let (mut f, covered, c1, _) = covered_and_carried();
    let second = native_tail_edit(&mut f, "# Carried again\n", 13);
    let c2 = receipt_of(&second.delivery_id, &second.update_digest, 6);
    acknowledge_entry(&mut f, &c2);
    host_document(&mut f, true, true);
    retire_settled(&mut f, Some(covered.clone()), "retired").unwrap();
    release_parked(&mut f);
    let (c1, c2) = (carried_delivery(&f, &c1), carried_delivery(&f, &c2));
    assert_eq!(manifest(&f, "adoption"), vec![c1.clone(), c2.clone()]);
    write(&mut f, "DELETE FROM ydoc_deferred_updates");
    importable(&mut f);
    returned(&mut f);
    (f, covered, c1, c2)
}

/// The local Y.Doc, as the store holds it.
fn local_doc(f: &Fixture) -> Ydoc {
    f.store.read_with(|conn| durable::load_doc_in(conn, &f.key)).unwrap()
}

/// The file, the local Y.Doc and accepted history through `through` agree:
/// the settlement recorded as `moment` projects the local Y.Doc, which is
/// structurally the accepted state.
fn converged(f: &Fixture, moment: &str, through: i64) {
    let local = local_doc(f);
    let file = moment_text(f, moment);
    let projection = local.project(ContentKind::Richdoc).unwrap().content;
    let expected = local
        .settled_markdown_source(&projection, || Ok::<_, ApplicationError>(Some(file.clone())))
        .unwrap()
        .unwrap_or(projection);
    assert_eq!(file, expected);
    let held = f.handle.registration.lock().unwrap();
    let accepted = f
        .store
        .read_with(|conn| {
            accepted_history::read_state(conn, &held, through, NativeHistoryReconstruction { working_reserve_bytes: 8 * 1024 * 1024 })
        })
        .unwrap();
    assert!(crate::replay_parity::structurally_equal_v2(&accepted, &local).unwrap());
}

/// Sol's round 4b ruling, capture source rule: Release, a fresh capture and
/// adoption, Carried application, the first settlement and a restart, with
/// no rewrite aligning the file and the Y.Doc. The file holds what the
/// released root settled at B and the Y.Doc also holds C1 and C2, so only
/// the settled-B proof explains the capture. Resume finds that capture still
/// current. A fresh registration holds every delivery until its activation
/// adopts. Its seed's receipt is saved before anything applies. Each
/// settlement holds only what applied, each Carried delivery applies once, a
/// replay after a restart writes nothing, and the file, the Y.Doc and
/// accepted history converge.
#[test]
fn resume_after_carried_edits_keeps_the_file_its_predecessor_settled() {
    let (mut f, covered, c1, c2) = released_at_b();
    let file = moment_text(&f, "retired");
    assert!(file.contains("Covered") && !file.contains("Carried"), "{file}");
    let id = successor(&mut f);
    assert_eq!(f.cut.source_moment_id, "retired", "the capture's source is the settlement at B");
    for restart in [false, true] {
        if restart {
            reopen(&mut f);
        }
        let before = rows(&f, &SUCCESSION_WRITES);
        resume_imported(&mut f, &id, 1_000_000).expect("its source is still current");
        assert_eq!(rows(&f, &SUCCESSION_WRITES), before, "restart={restart}");
    }
    let early = carried_event(&f, &c1);
    held(&mut f, early.clone());
    f.adopt().unwrap();
    assert_eq!(seeds(&f).last().map(|(seed, _)| seed.as_str()), Some(id.as_str()), "the local state differs from B");
    let seed = accept_seed(&mut f, 11);
    applies(&mut f, early);
    let first = settled(&mut f, Some(c1.receipt.clone()), "resumed").unwrap();
    assert_eq!((first.previous_cursor, first.terminal_cursor), (3, 5));
    let text = moment_text(&f, "resumed");
    assert!(text.contains("Carried") && !text.contains("again"), "{text}");
    replays(&mut f, &first, |f| settled(f, Some(c1.receipt.clone()), "resumed"));
    apply_carried(&mut f, &c2);
    settled(&mut f, Some(c2.receipt.clone()), "drained").unwrap();
    assert!(moment_text(&f, "drained").contains("Carried again"));
    let own = own_seed_event(&f, 11);
    let delivery = own.metadata.accepted.receipt.delivery_id.clone();
    applies(&mut f, own);
    let last = settled(&mut f, Some(seed.clone()), "converged").unwrap();
    applied_in_order(&f, &[&covered.delivery_id, &c1.receipt.delivery_id, &c2.receipt.delivery_id, &delivery]);
    converged(&f, "converged", 11);
    replays(&mut f, &last, |f| settled(f, Some(seed.clone()), "converged"));
}

/// Partial application, then a further Stop and Resume. S1 applies C1 alone,
/// its seed accepted and never applied, settles at C1 and releases with C2
/// and its seed Carried. S2 captures over the file S1 settled, with C2 and
/// S1's seed explaining the rest of its Y.Doc, holds C2 until it adopts, and
/// drains both before its own seed. Each applies once, and the file, the
/// Y.Doc and accepted history converge, replayed after a restart with no
/// writes.
#[test]
fn a_partly_applied_suffix_resumes_again_from_its_new_boundary() {
    let (mut f, covered, c1, c2) = released_at_b();
    let first = successor(&mut f);
    f.adopt().unwrap();
    let accepted = accept_seed(&mut f, 7);
    apply_carried(&mut f, &c1);
    host_document(&mut f, true, true);
    retire_settled(&mut f, Some(c1.receipt.clone()), "first-retired").unwrap();
    release_parked(&mut f);
    let s1_seed = carried_delivery(&f, &accepted);
    assert_eq!(manifest(&f, &first), vec![c2.clone(), s1_seed.clone()]);
    returned(&mut f);
    successor(&mut f);
    assert_eq!(f.cut.source_moment_id, "first-retired");
    let early = carried_event(&f, &c2);
    held(&mut f, early.clone());
    f.adopt().unwrap();
    let seed = accept_seed(&mut f, 11);
    applies(&mut f, early);
    apply_carried(&mut f, &s1_seed);
    let own = own_seed_event(&f, 11);
    let delivery = own.metadata.accepted.receipt.delivery_id.clone();
    applies(&mut f, own);
    let last = settled(&mut f, Some(seed.clone()), "second-resumed").unwrap();
    applied_in_order(&f, &[
        &covered.delivery_id,
        &c1.receipt.delivery_id,
        &c2.receipt.delivery_id,
        &s1_seed.receipt.delivery_id,
        &delivery,
    ]);
    converged(&f, "second-resumed", 11);
    replays(&mut f, &last, |f| settled(f, Some(seed.clone()), "second-resumed"));
}

/// Sol's merge-review finding 3: a note the reader built stops and resumes
/// with its file settled at B while its Y.Doc also holds a Carried edit. The
/// reader cannot prove that file shows the whole Y.Doc, so capture, resume
/// and adoption each prove accepted state at B and replay the Carried edit
/// onto it. Sol's merge-fix finding 1: once adopted, the successor proves
/// that source again at B, by an adoption replay after a lost
/// acknowledgement and by resume, after a restart and after it settles past
/// B, with no writes.
#[test]
#[ignore = "the Rust gate's reader phase runs it with DOHC_ENGINE_READER_CONFIG"]
fn a_reader_built_note_resumes_over_the_file_its_predecessor_settled() {
    let mut f = reader_fixture_case("valid");
    let resolver = reader_resolver();
    let root = prove_activation(&mut f, &resolver).unwrap().activation_id;
    f.cut.adoption_id = root.clone();
    reader_adopt(&mut f, &resolver);
    let update = f.doc.richdoc_append_paragraph("Covered");
    let covered = native_tail_record_at_depth(&mut f, update, 11, Some("owner"), 1);
    native_tail_apply(&mut f, covered.update.clone(), covered.delivery_id.clone(), 3);
    let covered = receipt_of(&covered.delivery_id, &covered.update_digest, 3);
    acknowledge_entry(&mut f, &covered);
    let update = f.doc.richdoc_append_paragraph("Carried");
    let carried = native_tail_record_at_depth(&mut f, update, 12, Some("owner"), 1);
    let carried = receipt_of(&carried.delivery_id, &carried.update_digest, 5);
    acknowledge_entry(&mut f, &carried);
    host_document(&mut f, true, true);
    retire_settled(&mut f, Some(covered), "retired").unwrap();
    release_parked(&mut f);
    let carried = carried_delivery(&f, &carried);
    assert_eq!(manifest(&f, &root), vec![carried.clone()]);
    returned(&mut f);
    let file = moment_text(&f, "retired");
    assert!(file.contains("Covered") && !file.contains("Carried"), "{file}");
    let id = reader_successor(&mut f, &resolver);
    assert_eq!(f.cut.source_moment_id, "retired", "the capture's source is the settlement at B");
    let resumed = reader_application_result(|| {
        resume_imported_owner_activation(&mut f.store, "namespace", &f.key, "owner.md", &id, 1_000_000, Some(&resolver))
    })
    .expect("its source is still current");
    assert_eq!(resumed.activation_id, id);
    let ack = reader_adopt(&mut f, &resolver);
    assert!(!ack.adoption_replayed);
    assert_eq!(ack.adoption_id, id);
    for case in ["replay", "restart", "settled past B"] {
        match case {
            "restart" => reopen(&mut f),
            "settled past B" => {
                accept_seed(&mut f, 7);
                apply_carried(&mut f, &carried);
                settled(&mut f, Some(carried.receipt.clone()), "resumed").unwrap();
            }
            _ => {}
        }
        let before = rows(&f, &SUCCESSION_WRITES);
        assert!(reader_adopt(&mut f, &resolver).adoption_replayed, "{case}");
        let resumed = reader_application_result(|| {
            resume_imported_owner_activation(&mut f.store, "namespace", &f.key, "owner.md", &id, 1_000_000, Some(&resolver))
        })
        .expect(case);
        assert_eq!(resumed.activation_id, id, "{case}");
        assert_eq!(rows(&f, &SUCCESSION_WRITES), before, "{case}");
    }
}

/// A damage the settled-B proof must refuse, and the refusal it gives.
type SourceDamage = (&'static str, fn(&ApplicationError) -> bool, fn(&mut Fixture));

fn unexplained(error: &ApplicationError) -> bool {
    matches!(error, ApplicationError::InvalidInput("ordinary activation source does not match imported document"))
}

fn conflict(error: &ApplicationError) -> bool {
    matches!(error, ApplicationError::Conflict)
}

/// Write `text` as the file at the document's path, recorded as `moment`.
fn write_file(f: &mut Fixture, text: &str, moment: &str) {
    VersionedTextStore::new(&mut f.store)
        .write_text(
            &WriteText {
                workspace_id: "workspace".into(),
                version_id: "main".into(),
                object_id: "object".into(),
                path: "owner.md".into(),
                text: text.into(),
                moment_id: moment.into(),
                metadata_origin: "sync".into(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 40,
                request_id: None,
            },
            &NoFaults,
        )
        .unwrap();
}

/// Each condition of the settled-B proof, failing alone, refuses the capture
/// with no writes: a moment name without its settlement, a settlement at
/// another terminal or another boundary, a state vector or file that is not
/// accepted state at B, a local edit or catch-up row the Carried updates do
/// not explain, a Carried update whose dependency is missing, and a Carried
/// update from outside the chain.
#[test]
fn the_settled_source_proof_refuses_any_unexplained_difference() {
    let damages: [SourceDamage; 9] = [
        ("moment without its settlement", unexplained, |f| {
            write(f, "UPDATE live_device_settlements SET moment_id='settlement-shaped'")
        }),
        ("settlement at another terminal", unexplained, |f| {
            write(f, "UPDATE live_device_settlements SET terminal_cursor=terminal_cursor+1")
        }),
        ("another boundary", unexplained, |f| {
            write(f, "UPDATE live_owner_activations SET released_boundary_json=json_set(released_boundary_json,'$.eventCount',5)
                WHERE activation_id='adoption'")
        }),
        ("state vector", unexplained, |f| {
            write(f, &format!("UPDATE live_device_settlements SET source_state_vector_digest='{}'", "f".repeat(64)))
        }),
        ("file not the projection", unexplained, |f| {
            // A settlement record naming a file that is not accepted state at B.
            write_file(f, "# Forged\n", "forged");
            write(f, &format!(
                "UPDATE live_device_settlements SET moment_id='forged',markdown_digest='{}'",
                hex_sha256(b"# Forged\n")
            ));
        }),
        ("an unexplained local edit", unexplained, |f| {
            let update = f.doc.richdoc_append_paragraph("Unexplained");
            f.store
                .write_with(&NoFaults, |tx| durable::record_update_in_tx(tx, &f.key, &update, None, None, 40))
                .unwrap();
        }),
        ("catch-up the file never projected", unexplained, |f| catch_up_row(f, 1)),
        ("missing dependency", conflict, |f| {
            // C2 builds on C1, which the manifest no longer lists.
            write(f, "UPDATE live_owner_activations SET carried_manifest_json=json_remove(carried_manifest_json,'$[0]')
                WHERE activation_id='adoption'")
        }),
        ("outside the chain", conflict, |f| {
            release_unadopted(f, "namespace", "object", "stray", None);
            release_unadopted(f, "namespace", "object", "stray-back", Some("stray"));
            write(f, "UPDATE live_owner_activations SET predecessor_activation_id='stray-back' WHERE activation_id='stray'");
            let json: String = f
                .store
                .read_with(|conn| {
                    conn.query_row("SELECT native_source_json FROM owner_ydoc_outbox_entries WHERE sequence=3", [], |r| r.get(0))
                })
                .unwrap();
            let mut source: owner_outbox::OwnerOutboxNativeSource = serde_json::from_str(&json).unwrap();
            source.adoption_id = "stray".into();
            write_source(f, 3, &source);
        }),
    ];
    for (case, expected, damage) in damages {
        let (mut f, _, _, _) = released_at_b();
        damage(&mut f);
        let before = rows(&f, &SUCCESSION_WRITES);
        let captured = capture_imported(&mut f, 1_000_000);
        assert!(captured.as_ref().is_err_and(expected), "{case}: {:?}", captured.map(|captured| captured.activation_id));
        assert_eq!(rows(&f, &SUCCESSION_WRITES), before, "{case}");
    }
}

/// Opus's review of the 4b1c fixes: seeds may share a native sequence with
/// each other and one native update, never two native updates. The current
/// activation's pending native update, its journal row compacted so that any
/// recorded time passes, settles; a second native update at its sequence
/// leaves the settlement Corrupt, with no writes.
#[test]
fn a_second_native_update_at_one_sequence_is_corrupt() {
    let mut f = Fixture::new();
    f.adopt().unwrap();
    native_tail_edit(&mut f, "# Own edit\n", 11);
    let (sequence, json): (i64, String) = f
        .store
        .read_with(|conn| {
            conn.query_row(
                "SELECT json_extract(native_source_json,'$.nativeSequence'),native_source_json FROM owner_ydoc_outbox_entries WHERE sequence=1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
        })
        .unwrap();
    write_unchecked(&mut f, &format!(
        "DELETE FROM ydoc_updates WHERE seq={sequence}; UPDATE ydoc_docs SET head_snapshot_seq={sequence}"
    ));
    assert!(audited(&mut f, false, None).unwrap().is_some(), "one compacted update settles");
    let mut copy: owner_outbox::OwnerOutboxNativeSource = serde_json::from_str(&json).unwrap();
    let owner_outbox::OwnerOutboxNativeOrigin::NativeUpdate { recorded_at_ms, .. } = &mut copy.origin else {
        panic!("a native update");
    };
    *recorded_at_ms += 1;
    let (key, json) = (native_append_key(&copy), serde_json::to_string(&copy).unwrap());
    audit_is_corrupt(&mut f, None, |f| write_unchecked(f, &format!(
        "CREATE TEMP TABLE copied AS SELECT * FROM owner_ydoc_outbox_entries WHERE sequence=1;
         UPDATE copied SET sequence=2,delivery_id='copied',append_key='{key}',native_source_json='{json}';
         INSERT INTO owner_ydoc_outbox_entries SELECT * FROM copied;
         DROP TABLE copied"
    )), "a second native update");
}

/// Whether a settlement recorded its attribution as unavailable.
fn attribution_unavailable(f: &Fixture) -> bool {
    f.store.table_row_count("live_settlement_attribution_unavailable").unwrap() > 0
}

/// Opus's review of the 4b1c fixes: only the current adoption's own refusal
/// leaves a new settlement without attribution. A root whose own refused
/// seed sits at its coverage floor settles with attribution unavailable. A
/// successor whose predecessor's refused seed sits at that floor settles with
/// its attribution, the refusal still keeping that settlement at accepted
/// state.
#[test]
fn only_the_current_adoptions_refusal_makes_attribution_unavailable() {
    let mut f = refused_seed();
    // A collaborator's paragraph on accepted state, which never held the
    // refused seed's content.
    let accepted = Ydoc::wire();
    accepted.apply(&f.cut.baseline_bytes).unwrap();
    let bytes = accepted.richdoc_append_paragraph("Remote paragraph 3");
    let remote = native_tail_event(&f, bytes, "remote-3".into(), 3);
    let terminal = remote.metadata.accepted.receipt.clone();
    applies(&mut f, remote);
    settle_as(&mut f, Some(terminal), "own-refusal").unwrap();
    assert!(attribution_unavailable(&f), "its own refused seed");

    let mut f = refused_seed();
    release_and_return(&mut f);
    successor(&mut f);
    f.adopt().unwrap();
    let seed = accept_seed(&mut f, 11);
    let own = own_seed_event(&f, 11);
    applies(&mut f, own);
    settle_as(&mut f, Some(seed), "successor").unwrap();
    assert!(!attribution_unavailable(&f), "a predecessor's refusal its chain already covered");
}

/// Sol's N1 on round 2: the relay refused the owner's edit X, the owner saved
/// the copy, and retirement kept X with its bytes. Settled at B and released
/// with nothing Carried, the Y.Doc returns to accepted state at B, so Resume
/// captures from that state with no seed and nothing delivers X again. The
/// kept entry keeps X's bytes, and the reopened outbox keeps no refusal.
#[test]
fn resume_starts_from_the_accepted_state_after_a_kept_refusal() {
    let mut f = Fixture::new();
    f.adopt().unwrap();
    let covered = native_tail_edit(&mut f, "# Covered\n", 11);
    native_tail_apply(
        &mut f,
        covered.update.clone(),
        covered.delivery_id.clone(),
        3,
    );
    let covered = receipt_of(&covered.delivery_id, &covered.update_digest, 3);
    acknowledge_entry(&mut f, &covered);
    let refused = native_tail_edit(&mut f, "# Refused\n", 12);
    let outbox = refuse_head(&mut f, &refused.delivery_id, "delivery-conflict");
    let owner_outbox::OwnerOutboxPageResult::Page(copy) =
        owner_outbox::read_pending_page(&f.store, "workspace", &outbox, None, 1 << 20).unwrap()
    else {
        panic!("the owner's copy reads the queue");
    };
    let header: Value = serde_json::from_slice(&copy.bytes).unwrap();
    assert_eq!(
        (
            header["state"].as_str(),
            header["pendingEntryCount"].as_i64()
        ),
        (Some("quarantined"), Some(1))
    );
    let absent = JournalEvidence {
        receipts: vec![],
        absent: vec![refused.delivery_id.clone()],
    };
    assert!(matches!(
        reconcile(&mut f, 10, None, Some(&absent)).unwrap(),
        Reconciliation::Reconciled { .. }
    ));
    host_document(&mut f, true, true);
    retire_settled(&mut f, Some(covered), "retired").unwrap();
    let file = moment_text(&f, "retired");
    assert!(
        file.contains("Covered") && !file.contains("Refused"),
        "{file}"
    );
    let text = |f: &Fixture| local_doc(f).project(ContentKind::Richdoc).unwrap().content;
    assert!(
        text(&f).contains("Refused"),
        "the Y.Doc holds X until the release"
    );
    release_parked(&mut f);
    assert!(manifest(&f, "adoption").is_empty(), "nothing Carried");
    let local = text(&f);
    assert!(
        local.contains("Covered") && !local.contains("Refused"),
        "{local}"
    );
    converged(&f, "retired", 3);
    importable(&mut f);
    returned(&mut f);
    let id = successor(&mut f);
    assert_eq!(f.cut.source_moment_id, "retired");
    f.adopt().unwrap();
    assert!(succession_row(&f, &id).3, "the successor is current");
    assert!(
        seeds(&f).is_empty(),
        "its local state is accepted state at B"
    );
    assert_eq!(
        query_rows(
            &f,
            "SELECT COUNT(*) FROM owner_ydoc_outbox_entries WHERE pending=1"
        ),
        query_rows(&f, "SELECT 0"),
        "nothing delivers X again"
    );
    assert_eq!(quarantine_state(&f, &outbox), ("active".to_owned(), 0));
    assert_eq!(
        query_rows(
            &f,
            &format!(
                "SELECT terminal_reason FROM owner_ydoc_outbox_entries WHERE delivery_id='{}'",
                refused.delivery_id
            )
        ),
        query_rows(&f, "SELECT 'retirement-kept'")
    );
    assert_eq!(entry_update(&f, &refused.delivery_id), refused.update);
}
