/// Each agent `[agentId, onBehalfOf]` that coverage names.
fn agents(authors: &crate::author_coverage::Authors) -> Vec<Value> {
    let authors: Value = serde_json::from_str(&authors.json()).unwrap();
    authors
        .as_array()
        .unwrap()
        .iter()
        .filter(|author| author["kind"] == "agent")
        .map(|author| serde_json::json!([author["agentId"], author["onBehalfOf"]]))
        .collect()
}

#[test]
fn adopted_agent_edit_accepted_into_a_full_interval_settles_before_its_agent_enters() {
    let person = LiveAuthorEntry::Human {
        human_id: "owner".into(),
        human_name: "Owner".into(),
    };
    let mut f = Fixture::new();
    f.adopt().unwrap();
    // The agent edits privately, then the accepted interval fills. The
    // delivery's snapshot names only a person it already holds.
    let accepted = accepted_copy(&f.doc);
    let edit = native_tail_edit_for(&mut f, "agent edit", 11, Some("installation-person"));
    let full: Vec<Value> = std::iter::once(serde_json::to_value(&person).unwrap())
        .chain((1..crate::author_coverage::MAX_INTERVAL_AUTHORS).map(
            |index| serde_json::json!({"kind": "human", "humanId": format!("person-{index}")}),
        ))
        .collect();
    let key = f.key.clone();
    f.store
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "UPDATE ydoc_docs SET pending_authors_json=?1 \
                 WHERE workspace_id=?2 AND version_id=?3 AND object_id=?4",
                rusqlite::params![
                    Value::Array(full).to_string(),
                    key.workspace_id,
                    key.version_id,
                    key.object_id
                ],
            )
            .map_err(write_sql)
        })
        .unwrap();
    let mut event = native_tail_event(&f, edit.update, edit.delivery_id, 7);
    event.metadata.author_snapshot = Some(vec![person]);
    relay_sees(&mut event, &accepted);
    let interval = |f: &Fixture| {
        f.store
            .read_with(|conn| crate::author_coverage::interval_in(conn, &f.key, i64::MAX))
            .unwrap()
    };
    let apply = |f: &mut Fixture, event: AdmittedLiveUpdate| {
        apply_committed(
            &mut f.store,
            &mut WriterDocCache::new(),
            &f.handle,
            event,
            &NoFaults,
            100_000_000,
            |_, _, _, _| Ok(()),
        )
        .unwrap()
    };
    // Acceptance would move the agent into the interval, where it has no
    // room. The relay settles and offers the same delivery again.
    let refused = apply(&mut f, event.clone());
    assert!(
        matches!(
            refused,
            ApplicationResult::Pending(ApplicationPending::SettlementRequired)
        ),
        "{refused:?}"
    );
    let held = interval(&f);
    assert_eq!(held.len(), crate::author_coverage::MAX_INTERVAL_AUTHORS);
    assert!(agents(&held).is_empty());
    f.store
        .write_with(&NoFaults, |tx| {
            crate::author_coverage::advance_accepted_prefix_in(tx, &f.key, false)
        })
        .unwrap();
    let applied = apply(&mut f, event);
    assert!(
        matches!(applied, ApplicationResult::Applied(..)),
        "{applied:?}"
    );
    let settled = interval(&f);
    assert_eq!(
        agents(&settled),
        [serde_json::json!(["native-agent", "installation-person"])]
    );
    assert_eq!(settled.len(), 2);
}

/// One private edit by its own run of one agent.
fn agent_run_edit(
    f: &mut Fixture,
    cache: &mut WriterDocCache,
    run: usize,
) -> Result<(), crate::CollabError> {
    agent_edit(f, cache, run, &agent_run(format!("run-{run}"), None))
}

/// One run of the agent `agent`, for a person when it names one.
fn agent_run(
    agent_run_id: String,
    on_behalf_of: Option<String>,
) -> dohc_engine_domain::ChangeAttribution {
    dohc_engine_domain::ChangeAttribution {
        actor_kind: dohc_engine_domain::ChangeActorKind::Agent,
        on_behalf_of,
        depth: 0,
        run: None,
        agent_run_id: Some(agent_run_id),
    }
}

/// The `edit`th private edit of the agent `agent`.
fn agent_edit(
    f: &mut Fixture,
    cache: &mut WriterDocCache,
    edit: usize,
    attribution: &dohc_engine_domain::ChangeAttribution,
) -> Result<(), crate::CollabError> {
    let key = f.key.clone();
    let path = f.binding.current_path.clone();
    let update = f
        .doc
        .richdoc_append_paragraph(&format!("Private run {edit}."));
    let now = 20 + edit as i64;
    crate::record_local_update(
        &mut f.store,
        cache,
        &key,
        &update,
        crate::LocalAppend {
            actor_origin_id: Some("agent"),
            attribution: Some(attribution),
            ..Default::default()
        },
        &NoFaults,
        now,
        |tx, outcome, _| {
            owner_outbox::append_adopted_local_update_in_tx(
                tx,
                &key,
                &path,
                outcome.seq,
                &update,
                &Default::default(),
                now,
            )
        },
    )
    .map(|_| ())
}

/// The agent runs an author list names, in order.
fn agent_runs(json: &str) -> Vec<String> {
    let authors: Value = serde_json::from_str(json).unwrap();
    let mut runs: Vec<String> = authors
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|author| author["agentRunId"].as_str().map(str::to_owned))
        .collect();
    runs.sort();
    runs
}

/// Adopts the document, and the relay accepts and settles one edit, so a
/// release has an accepted state to return the Y.Doc to. No author is
/// reserved.
fn adopt_with_settled_edit(f: &mut Fixture) {
    f.adopt().unwrap();
    let covered = native_tail_edit(f, "# Covered\n", 11);
    native_tail_apply(f, covered.update.clone(), covered.delivery_id.clone(), 3);
    let covered = receipt_of(&covered.delivery_id, &covered.update_digest, 3);
    acknowledge_entry(f, &covered);
    settled(f, Some(covered), "covered").unwrap();
    assert!(f
        .store
        .read_with(|conn| crate::author_coverage::reserved_in(conn, &f.key))
        .unwrap()
        .is_empty());
}

/// The relay's settlement of what it accepted while the lineage is held.
fn settle_accepted_prefix(f: &mut Fixture) {
    f.store
        .write_with(&NoFaults, |tx| {
            crate::author_coverage::advance_accepted_prefix_in(tx, &f.key, false)
        })
        .unwrap();
}

/// Every table a private edit writes.
const PRIVATE_EDIT_WRITES: [&str; 4] = [
    "ydoc_docs",
    "ydoc_updates",
    "ydoc_native_authors",
    "owner_ydoc_outbox_entries",
];

/// Agent runs with the longest identifiers each make a private edit on a
/// held lineage. The run whose author would pass the bytes one moment can
/// hold is refused and writes nothing, while a run with a private edit keeps
/// editing.
#[test]
fn a_held_lineage_refuses_the_agent_run_one_moment_has_no_bytes_for() {
    let mut f = Fixture::new();
    adopt_with_settled_edit(&mut f);
    // Each quote doubles when escaped.
    let long_run = |index: usize| {
        let id = dohc_engine_storage::MAX_IDENTIFIER_BYTES;
        agent_run(
            format!("{index:04}{}", "\"".repeat(id - 4)),
            Some("\"".repeat(id)),
        )
    };
    let entry = dohc_engine_domain::moment_author_json(Some("agent"), Some(&long_run(0)))
        .unwrap()
        .len()
        - "[]".len()
        + r#","depth":64"#.len();
    // The list adds its brackets and a comma between entries, and the
    // release reserves the unknown-author marker.
    let marker = r#"{"kind":"unattributed"}"#.len() + 1;
    let list = |runs: usize| 1 + runs * (entry + 1) + marker;
    let admitted = (crate::author_coverage::MAX_INTERVAL_AUTHOR_BYTES - 1 - marker) / (entry + 1);
    assert!(admitted < crate::author_coverage::MAX_INTERVAL_AUTHORS);
    assert!(list(admitted) <= crate::author_coverage::MAX_INTERVAL_AUTHOR_BYTES);
    assert!(list(admitted + 1) > crate::author_coverage::MAX_INTERVAL_AUTHOR_BYTES);
    let mut cache = WriterDocCache::new();
    for index in 0..admitted {
        agent_edit(&mut f, &mut cache, index, &long_run(index)).unwrap();
    }
    agent_edit(&mut f, &mut cache, admitted, &long_run(0)).unwrap();
    let before = rows(&f, &PRIVATE_EDIT_WRITES);
    let refused = agent_edit(
        &mut f,
        &mut WriterDocCache::new(),
        admitted + 1,
        &long_run(admitted),
    );
    assert!(
        matches!(refused, Err(crate::CollabError::AuthorCapacity)),
        "the run past one moment's bytes is refused"
    );
    assert_eq!(
        rows(&f, &PRIVATE_EDIT_WRITES),
        before,
        "a refused edit writes nothing"
    );
}

/// `count` people the relay accepted edits from, as their interval names
/// them.
fn people(count: usize) -> String {
    Value::Array(
        (0..count)
            .map(|index| serde_json::json!({"kind": "human", "humanId": format!("person-{index}")}))
            .collect(),
    )
    .to_string()
}

/// Puts these authors in the interval, as accepted deliveries leave them.
fn set_pending(f: &mut Fixture, authors: &str) {
    let key = f.key.clone();
    f.store
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "UPDATE ydoc_docs SET pending_authors_json=?1 \
                 WHERE workspace_id=?2 AND version_id=?3 AND object_id=?4",
                rusqlite::params![authors, key.workspace_id, key.version_id, key.object_id],
            )
            .map_err(write_sql)
        })
        .unwrap();
}

/// The interval's authors, as a settlement would name them.
fn interval_of(f: &Fixture) -> crate::author_coverage::Authors {
    f.store
        .read_with(|conn| crate::author_coverage::interval_in(conn, &f.key, i64::MAX))
        .unwrap()
}

/// The relay's settlement of a held lineage, as the host makes it: it
/// projects the accepted prefix, names the interval and takes it in. The
/// first attempt writes its moment and waits for the file write. A later one
/// finds the file holds that moment, so it takes in the interval at once.
fn relay_settlement(
    store: &mut EngineStore,
    audit: &LiveSettlementAudit,
    key: &DocKey,
    first: bool,
) -> Result<String, ApplicationError> {
    let doc = audit.accepted_prefix().ok_or(ApplicationError::Corrupt)?;
    let text = doc.project(ContentKind::Richdoc)?.content;
    let vector = hex_sha256(&doc.encode_state_vector());
    let TxnOutcome::Committed(id) =
        store.write_with(&NoFaults, |tx| -> Result<_, ApplicationError> {
            let authors = crate::author_coverage::interval_in(tx, key, i64::MAX)?;
            let written = dohc_engine_domain::write_projected_text_in_tx(
                tx,
                dohc_engine_domain::ProjectedWriteText {
                    workspace_id: "workspace",
                    version_id: "main",
                    object_id: "object",
                    path: std::borrow::Cow::Borrowed("owner.md"),
                    text: std::borrow::Cow::Borrowed(&text),
                    moment_id: "relay-settlement",
                    metadata_origin: "ydoc",
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: authors.moment_json().as_deref(),
                    now_ms: 20,
                    request_id: None,
                },
            )
            .map_err(|_| ApplicationError::Corrupt)?;
            crate::author_coverage::advance_accepted_prefix_in(tx, key, first)?;
            tx.execute(
                "UPDATE ydoc_docs SET settle_seq=?1, last_settled_sha=?2 WHERE object_id='object'",
                rusqlite::params![written.moment.moment_order, written.snapshot.blob_sha256],
            )
            .map_err(write_sql)?;
            audit.record_in_tx(
                tx,
                "relay-settlement",
                &written.snapshot.blob_sha256,
                &vector,
                20,
            )
        })?
    else {
        return Err(ApplicationError::Interrupted);
    };
    Ok(id)
}

/// The relay's settlement of a held lineage names the people it accepted.
/// New agent runs edit privately while its file write is unresolved. The
/// write fails, so those people return to the interval, and the document
/// parks only once a settlement takes them in again. However few they are,
/// reconciling the retirement asks the relay to settle, and its settlement
/// replays the failed one. Then the document parks, and the release brings
/// in only the runs.
#[test]
fn a_held_release_waits_while_a_failed_settlement_returns_its_authors() {
    for (returned, runs) in [(10, 10)] {
        let case = format!("{returned} returned authors and {runs} runs");
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
        set_pending(&mut f, &people(returned));
        let named = interval_of(&f);
        // A private edit makes the settlement project the accepted prefix,
        // as its replay does.
        let mut cache = WriterDocCache::new();
        agent_run_edit(&mut f, &mut cache, 0).unwrap();
        let key = f.key.clone();
        let reconstruction = NativeHistoryReconstruction {
            working_reserve_bytes: 8 * 1024 * 1024,
        };
        with_settlement(
            &mut f.store,
            &f.handle,
            Some(covered.clone()),
            128,
            reconstruction,
            |store, audit| relay_settlement(store, audit, &key, true),
        )
        .unwrap();
        assert!(interval_of(&f).is_empty(), "{case}");
        for run in 1..runs {
            agent_run_edit(&mut f, &mut cache, run).unwrap();
        }
        f.store
            .write_with(&NoFaults, |tx| {
                crate::author_coverage::compensate_in(tx, &key, Some("relay-settlement"), 30)
            })
            .unwrap();
        assert_eq!(interval_of(&f).json(), named.json(), "{case}");
        let deliveries: Vec<String> = f
            .store
            .read_with(|conn| {
                conn.prepare(
                    "SELECT delivery_id FROM owner_ydoc_outbox_entries WHERE pending=1 ORDER BY sequence",
                )?
                .query_map([], |row| row.get(0))?
                .collect::<rusqlite::Result<Vec<_>>>()
            })
            .unwrap();
        refuse_head(&mut f, &deliveries[0], "delivery-conflict");
        let absent = JournalEvidence {
            receipts: vec![],
            absent: deliveries.clone(),
        };
        let scope = RetirementScope {
            max_deliveries: deliveries.len(),
            ..retirement_scope()
        };
        let retiring = retirement_key(&f, 10);
        let reconciled = reconcile_activation(
            &mut f.store,
            &scope,
            &retiring,
            None,
            Some(&absent),
            &NoFaults,
        )
        .unwrap();
        assert!(
            matches!(reconciled, Reconciliation::Reconciled { settle: true, .. }),
            "{case}: the relay settles the returned authors first: {reconciled:?}"
        );
        with_retirement_settlement(
            &mut f.store,
            &scope,
            &retiring,
            &retirement_host(),
            Some(covered),
            128,
            reconstruction,
            |store, audit| relay_settlement(store, audit, &key, false),
        )
        .unwrap();
        // With its interval empty and no attempt unresolved, the document
        // parks.
        assert!(interval_of(&f).is_empty(), "{case}");
        assert!(
            !f.store
                .read_with(|conn| crate::author_coverage::unresolved_in(conn, &key))
                .unwrap(),
            "{case}"
        );
        release_parked(&mut f);
        let released = interval_of(&f);
        assert_eq!(released.len(), runs, "{case}");
        let mut expected: Vec<String> = (0..runs).map(|run| format!("run-{run}")).collect();
        expected.sort();
        assert_eq!(agent_runs(&released.json()), expected, "{case}");
        let moment_authors: String = f
            .store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT author_json FROM moments WHERE moment_id='relay-settlement'",
                    [],
                    |row| row.get(0),
                )
            })
            .unwrap();
        assert_eq!(moment_authors, named.json(), "{case}");
    }
}

fn native_tail_edit(f: &mut Fixture, source: &str, now: i64) -> owner_outbox::OwnerOutboxEntry {
    native_tail_edit_for(f, source, now, Some("owner"))
}

fn native_tail_edit_for(
    f: &mut Fixture,
    source: &str,
    now: i64,
    local_person: Option<&str>,
) -> owner_outbox::OwnerOutboxEntry {
    let update = f
        .doc
        .rewrite_content_to_markdown_preserving_source(ContentKind::Richdoc, source)
        .unwrap();
    native_tail_record_at_depth(f, update, now, local_person, 1)
}

fn native_tail_record_at_depth(
    f: &mut Fixture,
    update: Vec<u8>,
    now: i64,
    local_person: Option<&str>,
    depth: u32,
) -> owner_outbox::OwnerOutboxEntry {
    let key = f.key.clone();
    let path = f.binding.current_path.clone();
    let attribution = dohc_engine_domain::ChangeAttribution {
        actor_kind: dohc_engine_domain::ChangeActorKind::Agent,
        on_behalf_of: local_person.map(str::to_owned),
        depth,
        run: None,
        agent_run_id: None,
    };
    crate::record_local_update(
        &mut f.store,
        &mut WriterDocCache::new(),
        &f.key,
        &update,
        crate::LocalAppend {
            restore_generation: (f.binding.restore_fence_generation > 0)
                .then_some(f.binding.restore_fence_generation),
            actor_origin_id: Some("native-agent"),
            attribution: Some(&attribution),
            ..Default::default()
        },
        &NoFaults,
        now,
        |tx, outcome, _| {
            owner_outbox::append_adopted_local_update_in_tx(
                tx,
                &key,
                &path,
                outcome.seq,
                &update,
                &Default::default(),
                now,
            )
        },
    )
    .unwrap();
    let outbox: String = f
        .store
        .read_with(|conn| {
            conn.query_row(
                "SELECT outbox_id FROM owner_ydoc_outboxes WHERE restore_fence_generation=?1 AND current_path=?2",
                rusqlite::params![f.binding.restore_fence_generation, f.binding.current_path],
                |r| r.get(0),
            )
        })
        .unwrap();
    owner_outbox::read_pending(&f.store, "workspace", &outbox)
        .unwrap()
        .entries
        .last()
        .unwrap()
        .clone()
}

fn native_tail_event(
    f: &Fixture,
    bytes: Vec<u8>,
    delivery: String,
    cursor: i64,
) -> AdmittedLiveUpdate {
    // The relay binds the declared agent to the authenticated owner.
    let declared: Option<Option<String>> = f
        .store
        .read_with(|conn| {
            conn.query_row(
                "SELECT agent_declaration_json FROM owner_ydoc_outbox_entries WHERE delivery_id=?1",
                [&delivery],
                |r| r.get(0),
            )
            .optional()
        })
        .unwrap();
    let agent_declaration: Option<AgentDeclaration> = declared
        .flatten()
        .map(|json| serde_json::from_str(&json).unwrap());
    AdmittedLiveUpdate {
        metadata: AdmittedLiveUpdateMetadata {
            accepted: RelayAcceptedLiveUpdate {
                receipt: LiveUpdateReceipt {
                    delivery_id: delivery,
                    update_digest: hex_sha256(&bytes),
                    journal_cursor: cursor,
                    accepting_host_epoch: 1,
                },
                binding: f.binding.clone(),
                authority: ServerDerivedLiveUpdateAuthority::Owner {
                    principal_id: "owner".into(),
                },
                received_at_ms: cursor,
            },
            first_seen: vec![],
            canonical_version: Some(2),
            author_snapshot: Some(
                (agent_declaration)
                    .into_iter()
                    .map(|declaration| {
                        crate::live_update_application::LiveAuthorEntry::from(AgentDeclaration {
                            on_behalf_of: Some("owner".into()),
                            ..declaration
                        })
                    })
                    .collect(),
            ),
            first_seen_deletes: Some(vec![]),
            checkpoint_coverage: None,
        },
        update_bytes: bytes.clone(),
    }
}

/// A copy of the state the relay had accepted, for `relay_sees`.
fn accepted_copy(doc: &Ydoc) -> Ydoc {
    let copy = Ydoc::wire();
    copy.apply(&doc.encode_full_state()).unwrap();
    copy
}

/// Names the ranges the relay finds new in `event` against `accepted`.
fn relay_sees(event: &mut AdmittedLiveUpdate, accepted: &Ydoc) {
    let (structs, deletes) =
        crate::live_update_application::first_seen_for_test(accepted, &event.update_bytes);
    event.metadata.first_seen = structs;
    event.metadata.first_seen_deletes = Some(deletes);
}

fn native_tail_apply(
    f: &mut Fixture,
    bytes: Vec<u8>,
    delivery: String,
    cursor: i64,
) -> LiveUpdateHostApplicationAck {
    let event = native_tail_event(f, bytes.clone(), delivery, cursor);
    let ApplicationResult::Applied(ack, _) = apply_committed(
        &mut f.store,
        &mut WriterDocCache::new(),
        &f.handle,
        event,
        &NoFaults,
        100_000_000,
        |_, _, _, _| Ok(()),
    )
    .unwrap() else {
        panic!("application refused")
    };
    f.doc.apply(&bytes).unwrap();
    ack
}

fn native_tail_input(
    f: &mut Fixture,
    terminal: Option<LiveUpdateReceipt>,
    applied_sequence: i64,
) -> NativeRestorePreparation {
    native_tail_input_at(f, terminal, applied_sequence, 0)
}

fn native_tail_input_at(
    f: &mut Fixture,
    terminal: Option<LiveUpdateReceipt>,
    applied_sequence: i64,
    point_cursor: i64,
) -> NativeRestorePreparation {
    let receipt_digest = if point_cursor == 0 {
        f.binding.lineage_claim_id.clone()
    } else {
        terminal.as_ref().unwrap().update_digest.clone()
    };
    let coordinate = f.handle.registration.lock().unwrap().coordinate.clone();
    let fence = f
        ._owner
        .fence_restore(
            &mut f.store, None,
            NativeRestoreFence {
                point: crate::live_update_application::NativeRestoreSelection {
                    journal_cursor: point_cursor,
                    receipt_digest: receipt_digest.clone(),
                },
                operation_id: if f.binding.restore_fence_generation == 0 {
                    "tail-restore".into()
                } else {
                    format!("tail-restore-{}", f.binding.restore_fence_generation + 1)
                },
                relay_database_namespace: "namespace".into(),
                old_binding: f.binding.clone(),
                host_id: "host".into(),
                new_fence: f.binding.restore_fence_generation + 1,
                origin: RestoreDeliveryOrigin::Owner {
                    id: f.cut.adoption_id.clone(),
                },
                terminal,
                applied_sequence,
            },
            coordinate,
            40,
            &NoFaults,
            |_, _| Ok(()),
        )
        .unwrap();
    let point = Ydoc::wire();
    point.apply(&f.cut.baseline_bytes).unwrap();
    let projection = point.project(ContentKind::Richdoc).unwrap().content;
    let source = point
        .preserved_markdown_source(&projection)
        .unwrap_or_else(|| projection.clone());
    NativeRestorePreparation {
        fence,
        point: NativeRestorePoint {
            journal_cursor: point_cursor,
            receipt_digest,
            markdown_digest: hex_sha256(source.as_bytes()),
            projection_digest: hex_sha256(projection.as_bytes()),
        },
    }
}

fn native_tail_prepare(
    f: &mut Fixture,
    input: NativeRestorePreparation,
) -> Result<NativeRestoreProposal, ApplicationError> {
    let coordinate = f.handle.registration.lock().unwrap().coordinate.clone();
    f._owner
        .prepare_restore(&mut f.store, None, input, coordinate, 2_000_000, 100, &NoFaults)
}

fn native_tail_inventory(store: &EngineStore) -> Value {
    store.read_with(|conn| {
        let mut q=conn.prepare("SELECT outbox_id,sequence,append_key,delivery_id,update_digest,update_blob_digest,byte_length,created_at_ms,pending,native_source_json FROM owner_ydoc_outbox_entries ORDER BY outbox_id,sequence").unwrap();
        let entries=q.query_map([],|r|Ok(serde_json::json!([r.get::<_,String>(0)?,r.get::<_,i64>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?,r.get::<_,String>(4)?,r.get::<_,Option<String>>(5)?,r.get::<_,i64>(6)?,r.get::<_,i64>(7)?,r.get::<_,i64>(8)?,r.get::<_,Option<String>>(9)?]))).unwrap().collect::<Result<Vec<_>,_>>()?;
        Ok::<_,rusqlite::Error>(serde_json::json!(entries))
    }).unwrap()
}

#[test]
fn relay_bound_owner_agent_draft_applies_and_restores_after_same_client_depth_change() {
    let mut f = Fixture::new();
    f.adopt().unwrap();
    let baseline = f.doc.state_vector();
    let update = f.doc.richdoc_append_paragraph("first agent edit");
    let first = native_tail_record_at_depth(&mut f, update, 11, Some("owner"), 1);
    let first_vector = f.doc.state_vector();
    let clients: Vec<_> = first_vector
        .iter()
        .filter_map(|(&client, &clock)| (clock > baseline.get(&client)).then_some(client))
        .collect();
    assert_eq!(clients.len(), 1);
    let client = clients[0];
    let first_event = native_tail_event(&f, first.update, first.delivery_id, 7);
    let stored_snapshot = first_event.metadata.author_snapshot.clone();
    assert!(matches!(
        apply_committed(
            &mut f.store,
            &mut WriterDocCache::new(),
            &f.handle,
            first_event,
            &NoFaults,
            100_000_000,
            |_, _, _, _| Ok(())
        ),
        Ok(ApplicationResult::Applied(..))
    ));

    let update = f.doc.richdoc_append_paragraph("next agent edit");
    let second = native_tail_record_at_depth(&mut f, update, 12, Some("owner"), 2);
    let second_vector = f.doc.state_vector();
    assert_eq!(second_vector.len(), first_vector.len());
    assert!(second_vector.get(&client) > first_vector.get(&client));
    assert!(second_vector
        .iter()
        .all(|(&id, &clock)| id == client || clock == first_vector.get(&id)));
    let mut event = native_tail_event(&f, second.update, second.delivery_id, 8);
    assert_eq!(event.metadata.admitted_declaration().unwrap().depth, 2);
    // The relay keeps the first snapshot for this client's unchanged identity.
    event.metadata.author_snapshot = stored_snapshot;
    assert_eq!(event.metadata.admitted_declaration().unwrap().depth, 1);
    let before = native_tail_inventory(&f.store);
    for authority in [
        ServerDerivedLiveUpdateAuthority::Named {
            principal_id: "recipient".into(),
            grant_id: "grant".into(),
            grant_generation: 1,
        },
        ServerDerivedLiveUpdateAuthority::Link {
            principal_id: "recipient-link".into(),
            grant_id: "grant".into(),
            grant_generation: 1,
        },
    ] {
        let mut other = event.clone();
        other.metadata.accepted.authority = authority;
        let LiveAuthorEntry::Agent { on_behalf_of, .. } =
            &mut other.metadata.author_snapshot.as_mut().unwrap()[0]
        else {
            panic!("expected agent")
        };
        *on_behalf_of = Some("recipient".into());
        assert!(matches!(
            apply_committed(
                &mut f.store,
                &mut WriterDocCache::new(),
                &f.handle,
                other,
                &NoFaults,
                100_000_000,
                |_, _, _, _| Ok(())
            ),
            Err(ApplicationError::Conflict)
        ));
        assert_eq!(native_tail_inventory(&f.store), before);
        assert_eq!(
            f.store
                .table_row_count("live_device_update_applications")
                .unwrap(),
            1
        );
    }
    let ApplicationResult::Applied(ack, _) = apply_committed(
        &mut f.store,
        &mut WriterDocCache::new(),
        &f.handle,
        event,
        &NoFaults,
        100_000_000,
        |_, _, _, _| Ok(()),
    )
    .unwrap() else {
        panic!("application refused")
    };
    assert_eq!(ack.local_ydoc_sequence, 2);
    let terminal = LiveUpdateReceipt {
        delivery_id: ack.delivery_id,
        update_digest: ack.update_digest,
        journal_cursor: ack.journal_cursor,
        accepting_host_epoch: ack.accepting_host_epoch,
    };
    let input = native_tail_input(&mut f, Some(terminal), ack.local_ydoc_sequence);
    let proposal = native_tail_prepare(&mut f, input).unwrap();
    let sources = &proposal.receipt().native_sources;
    assert_eq!(sources.len(), 2);
    for (source, depth) in sources.iter().zip([1, 2]) {
        assert!(source.accepted_receipt.is_some());
        assert_eq!(
            source
                .source
                .native()
                .unwrap()
                .agent_declaration()
                .unwrap()
                .unwrap()
                .depth,
            depth
        );
    }
}

#[test]
fn relay_bound_owner_agent_draft_refuses_other_principals_and_changed_agents() {
    let mut f = Fixture::new();
    f.adopt().unwrap();
    let source = native_tail_edit_for(&mut f, "agent edit", 11, Some("installation-person"));
    let original = native_tail_event(&f, source.update, source.delivery_id, 7);
    let before = native_tail_inventory(&f.store);
    for variant in ["named", "link", "wrong-person", "missing-person", "agent"] {
        let mut event = original.clone();
        let LiveAuthorEntry::Agent {
            agent_id,
            on_behalf_of,
            ..
        } = &mut event.metadata.author_snapshot.as_mut().unwrap()[0]
        else {
            panic!("expected agent")
        };
        match variant {
            "named" => {
                event.metadata.accepted.authority = ServerDerivedLiveUpdateAuthority::Named {
                    principal_id: "recipient".into(),
                    grant_id: "grant".into(),
                    grant_generation: 1,
                };
                *on_behalf_of = Some("recipient".into());
            }
            "link" => {
                event.metadata.accepted.authority = ServerDerivedLiveUpdateAuthority::Link {
                    principal_id: "private-link".into(),
                    grant_id: "grant".into(),
                    grant_generation: 1,
                };
                *on_behalf_of = Some("public-link".into());
            }
            "wrong-person" => *on_behalf_of = Some("recipient".into()),
            "missing-person" => *on_behalf_of = None,
            "agent" => *agent_id = "other-agent".into(),
            _ => unreachable!(),
        }
        assert!(
            matches!(
                apply_committed(
                    &mut f.store,
                    &mut WriterDocCache::new(),
                    &f.handle,
                    event,
                    &NoFaults,
                    100_000_000,
                    |_, _, _, _| Ok(())
                ),
                Err(ApplicationError::Conflict)
            ),
            "{variant}"
        );
        assert_eq!(native_tail_inventory(&f.store), before);
        assert_eq!(
            f.store
                .table_row_count("live_device_update_applications")
                .unwrap(),
            0
        );
    }
}

#[test]
fn native_restore_tail_retains_interleaved_pending_context_with_descending_terminal_ack() {
    for compact in [false, true] {
        let mut f = Fixture::new();
        f.adopt().unwrap();
        let peer = Ydoc::wire();
        peer.apply(&f.cut.baseline_bytes).unwrap();
        let remote = peer
            .rewrite_content_to_markdown_preserving_source(
                ContentKind::Richdoc,
                "# Accepted collaborator\n",
            )
            .unwrap();
        let first = native_tail_edit(&mut f, "# Owner admission\n", 11);
        native_tail_edit(
            &mut f,
            "---\ntitle: 'Unsent été 😀'\n---\n\n# Pending before\n",
            12,
        );
        let earlier = native_tail_apply(&mut f, remote, "remote".into(), 7);
        assert_eq!(earlier.local_ydoc_sequence, 3);
        native_tail_edit(&mut f, "# Pending after 🐱\n", 13);
        let terminal =
            native_tail_apply(&mut f, first.update.clone(), first.delivery_id.clone(), 11);
        assert_eq!(terminal.local_ydoc_sequence, 1);
        let before = native_tail_inventory(&f.store);
        if compact {
            durable::maybe_compact(&mut f.store, &f.key, 0, &NoFaults, 30).unwrap();
            assert_eq!(f.store.table_row_count("ydoc_updates").unwrap(), 0);
        }
        let input = native_tail_input(
            &mut f,
            Some(LiveUpdateReceipt {
                delivery_id: terminal.delivery_id,
                update_digest: terminal.update_digest,
                journal_cursor: terminal.journal_cursor,
                accepting_host_epoch: terminal.accepting_host_epoch,
            }),
            terminal.local_ydoc_sequence,
        );
        assert_eq!(input.fence.local_head_sequence, 4);
        let proposal = native_tail_prepare(&mut f, input.clone()).unwrap();
        assert_eq!(proposal.receipt().native_sources.len(), 3);
        assert_eq!(
            proposal
                .receipt()
                .native_sources
                .iter()
                .map(|s| s.source.native().unwrap().native_sequence)
                .collect::<Vec<_>>(),
            vec![1, 2, 4]
        );
        assert_eq!(
            proposal
                .receipt()
                .native_sources
                .iter()
                .filter(|s| s.accepted_receipt.is_some())
                .count(),
            1
        );
        assert_eq!(proposal.receipt().accepted_history.suffix.len(), 2);
        assert_eq!(before, native_tail_inventory(&f.store));
        let queued = owner_outbox::read_pending(
            &f.store,
            "workspace",
            &proposal.receipt().native_sources[0].outbox_id,
        )
        .unwrap();
        assert_eq!(queued.state, owner_outbox::OwnerOutboxState::Quarantined);
        assert_eq!(
            queued
                .entries
                .iter()
                .map(|entry| entry.update.clone())
                .collect::<Vec<_>>(),
            proposal.native_source_bytes()
        );
        let admitted = proposal.receipt().native_sources[0]
            .accepted_receipt
            .as_ref()
            .unwrap();
        assert!(matches!(
            owner_outbox::acknowledge(
                &mut f.store,
                "workspace",
                &queued.outbox_id,
                &[owner_outbox::OwnerDeliveryReceipt {
                    delivery_id: admitted.delivery_id.clone(),
                    update_digest: admitted.update_digest.clone(),
                    journal_cursor: admitted.journal_cursor,
                    accepting_host_epoch: admitted.accepting_host_epoch
                }]
            ),
            Err(owner_outbox::OwnerOutboxError::Frozen)
        ));
        assert_eq!(before, native_tail_inventory(&f.store));
        let point = Ydoc::wire();
        point.apply(proposal.point_state_bytes()).unwrap();
        let restored = Ydoc::wire();
        restored.apply(proposal.frozen_state_bytes()).unwrap();
        restored.apply(proposal.candidate_bytes()).unwrap();
        assert_eq!(
            restored.project(ContentKind::Richdoc).unwrap().content,
            point.project(ContentKind::Richdoc).unwrap().content
        );
        assert_eq!(
            hex_sha256(
                restored
                    .preserved_markdown_source(
                        &restored.project(ContentKind::Richdoc).unwrap().content
                    )
                    .unwrap()
                    .as_bytes()
            ),
            input.point.markdown_digest
        );
        let expected = serde_json::to_vec(&proposal).unwrap();
        assert_eq!(
            expected,
            serde_json::to_vec(&native_tail_prepare(&mut f, input.clone()).unwrap()).unwrap()
        );
        use dohc_engine_storage::backup::{create_verified_backup, BackupOutcome, RealFreeSpace};
        let BackupOutcome::Verified(backup) = create_verified_backup(
            &f.store,
            &f._scratch.join("recovery"),
            "tail",
            "test",
            50,
            &RealFreeSpace,
            &NoFaults,
        )
        .unwrap() else {
            panic!("backup interrupted")
        };
        let mut restored_store = EngineStore::open(&backup.backup_path, 60).unwrap();
        let mut owner = ApplicationOwner::new("workspace".into()).unwrap();
        let coordinate = f.handle.registration.lock().unwrap().coordinate.clone();
        assert_eq!(
            expected,
            serde_json::to_vec(
                &owner
                    .prepare_restore(
                        &mut restored_store, None,
                        input.clone(),
                        coordinate,
                        2_000_000,
                        100,
                        &NoFaults
                    )
                    .unwrap()
            )
            .unwrap()
        );
        assert_eq!(before, native_tail_inventory(&restored_store));
        drop(f.store);
        f.store = EngineStore::open(&f._scratch.join("engine.db"), 70).unwrap();
        assert_eq!(
            expected,
            serde_json::to_vec(&native_tail_prepare(&mut f, input).unwrap()).unwrap()
        );
        assert_eq!(before, native_tail_inventory(&f.store));
        assert_eq!(
            f.store
                .table_row_count("live_device_update_applications")
                .unwrap(),
            2
        );
        assert_eq!(f.store.table_row_count("moments").unwrap(), 1);
    }
}

#[test]
fn native_restore_tail_refuses_missing_or_changed_provenance_without_mutating_canonical_state() {
    let mutations = [
        "UPDATE owner_ydoc_outbox_entries SET native_source_json=NULL",
        "UPDATE owner_ydoc_outbox_entries SET native_source_json=json_set(native_source_json,'$.binding.objectId','other')",
        "UPDATE owner_ydoc_outbox_entries SET native_source_json=json_set(native_source_json,'$.adoptionId','other')",
        "UPDATE owner_ydoc_outbox_entries SET native_source_json=json_set(native_source_json,'$.nativeSequence',0)",
        "UPDATE owner_ydoc_outbox_entries SET native_source_json=json_set(native_source_json,'$.updateDigest',printf('%064d',0))",
        "UPDATE owner_ydoc_outbox_entries SET native_source_json=json_set(native_source_json,'$.origin.actorOriginId','other')",
        "UPDATE owner_ydoc_outbox_entries SET native_source_json=json_set(native_source_json,'$.origin.kind','foreign')",
        "UPDATE owner_ydoc_outbox_entries SET native_source_json=json_set(native_source_json,'$.unknown',1)",
        "UPDATE owner_ydoc_outbox_entries SET native_source_json=json_set(native_source_json,'$.origin.unknown',1)",
        "UPDATE owner_ydoc_outbox_entries SET delivery_id='foreign'",
        "UPDATE owner_ydoc_outbox_entries SET append_key='generic'",
        "DELETE FROM owner_ydoc_outbox_entries",
        "DELETE FROM ydoc_updates",
        "UPDATE binary_blobs SET bytes=zeroblob(byte_length) WHERE sha256 IN (SELECT update_digest FROM owner_ydoc_outbox_entries)",
        "UPDATE binary_blobs SET bytes=zeroblob(byte_length+1) WHERE sha256 IN (SELECT update_digest FROM owner_ydoc_outbox_entries)",
    ];
    for persisted in [false, true] {
        for mutation in mutations {
            let mut f = Fixture::new();
            f.adopt().unwrap();
            native_tail_edit(&mut f, "Pending", 11);
            let input = native_tail_input(&mut f, None, 0);
            if persisted {
                native_tail_prepare(&mut f, input.clone()).unwrap();
            }
            f.store
                .write_with(&NoFaults, |tx| tx.execute(mutation, []).map_err(write_sql))
                .unwrap();
            let inventory = native_tail_inventory(&f.store);
            assert!(
                native_tail_prepare(&mut f, input).is_err(),
                "accepted {mutation}; persisted={persisted}"
            );
            assert_eq!(native_tail_inventory(&f.store), inventory);
            assert_eq!(f.store.table_row_count("moments").unwrap(), 1);
            assert_eq!(
                f.store
                    .table_row_count("live_device_update_applications")
                    .unwrap(),
                0
            );
        }
    }
}

/// An adopted owner's native agent edit declares the agent its journal row
/// recorded, as an editor's draft declares it, with no draft proof. A retry
/// reads back the same entry. Restore verifies that native source declaration.
/// A person's or an automation's edit declares none.
#[test]
fn adopted_native_agent_edit_declares_its_recorded_agent() {
    let mut f = Fixture::new();
    f.adopt().unwrap();
    let entry = native_tail_edit(&mut f, "Agent pending", 11);
    let expected = dohc_engine_domain::AgentDeclaration {
        agent_id: "native-agent".into(),
        on_behalf_of: Some("owner".into()),
        depth: 1,
    };
    assert_eq!(entry.agent_declaration, Some(expected.clone()));
    let stored = |f: &Fixture| -> (Option<String>, Option<i64>, i64) {
        f.store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT agent_declaration_json,draft_binding_revision,json_extract(native_source_json,'$.nativeSequence') FROM owner_ydoc_outbox_entries WHERE delivery_id=?1",
                    [&entry.delivery_id],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
            })
            .unwrap()
    };
    let (declaration, revision, native_sequence) = stored(&f);
    assert_eq!(declaration, Some(serde_json::to_string(&expected).unwrap()));
    assert_eq!(revision, None);
    // The source derives the declaration, so a retry of the same native
    // update finds its entry unchanged.
    let key = f.key.clone();
    f.store
        .write_with(&NoFaults, |tx| {
            owner_outbox::append_adopted_local_update_in_tx(
                tx,
                &key,
                "owner.md",
                native_sequence,
                &entry.update,
                &Default::default(),
                99,
            )
        })
        .unwrap();
    assert_eq!(stored(&f), (declaration, None, native_sequence));
    assert_eq!(
        f.store
            .table_row_count("owner_ydoc_outbox_entries")
            .unwrap(),
        1
    );
    // Restore classifies the native source with its derived declaration, and
    // refuses a stored one the source does not derive.
    let input = native_tail_input(&mut f, None, 0);
    let proposal = native_tail_prepare(&mut f, input.clone()).unwrap();
    assert_eq!(
        proposal.receipt().native_sources[0]
            .source
            .native()
            .unwrap()
            .agent_declaration()
            .unwrap(),
        Some(expected)
    );
    f.store
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "UPDATE owner_ydoc_outbox_entries SET agent_declaration_json=json_set(agent_declaration_json,'$.agentId','other-agent')",
                [],
            )
            .map_err(write_sql)
        })
        .unwrap();
    assert!(native_tail_prepare(&mut f, input).is_err());

    for kind in [
        dohc_engine_domain::ChangeActorKind::Human,
        dohc_engine_domain::ChangeActorKind::Automation,
    ] {
        let mut f = Fixture::new();
        f.adopt().unwrap();
        let update = f
            .doc
            .rewrite_content_to_markdown_preserving_source(ContentKind::Richdoc, "Not an agent")
            .unwrap();
        let key = f.key.clone();
        let attribution = dohc_engine_domain::ChangeAttribution {
            actor_kind: kind,
            on_behalf_of: Some("owner".into()),
            depth: 0,
            run: None,
            agent_run_id: None,
        };
        crate::record_local_update(
            &mut f.store,
            &mut WriterDocCache::new(),
            &f.key,
            &update,
            crate::LocalAppend {
                actor_origin_id: Some("someone"),
                attribution: Some(&attribution),
                ..Default::default()
            },
            &NoFaults,
            11,
            |tx, outcome, _| {
                owner_outbox::append_adopted_local_update_in_tx(
                    tx,
                    &key,
                    "owner.md",
                    outcome.seq,
                    &update,
                    &Default::default(),
                    11,
                )
            },
        )
        .unwrap();
        let declared: Option<String> = f
            .store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT agent_declaration_json FROM owner_ydoc_outbox_entries",
                    [],
                    |r| r.get(0),
                )
            })
            .unwrap();
        assert_eq!(declared, None);
    }
}

/// An enrolled owner's pending draft names no native journal update. Restore
/// keeps it as an owner draft source with its delivery identity and declared
/// agent; an accepted draft also carries its own receipt, whose declaration
/// must be the draft's.
#[test]
fn native_restore_keeps_enrolled_owner_drafts_as_truthful_sources() {
    let declaration = dohc_engine_domain::AgentDeclaration {
        agent_id: "trip-agent 旅行".into(),
        on_behalf_of: Some("owner".into()),
        depth: 1,
    };
    for accepted in [false, true] {
        let mut f = Fixture::new();
        f.adopt().unwrap();
        let update = f
            .doc
            .rewrite_content_to_markdown_preserving_source(ContentKind::Richdoc, "Agent draft")
            .unwrap();
        let entry = owner_outbox::append(
            &mut f.store,
            "workspace",
            owner_outbox::OwnerOutboxAppendInput {
                binding: f.binding.clone(),
                base_update: f.cut.baseline_bytes.clone(),
                append_key: "agent-draft".into(),
                update: update.clone(),
                limits: f.cut.outbox_limits.clone(),
                created_at_ms: 11,
            },
        )
        .unwrap();
        let (terminal, applied_sequence) = if accepted {
            let receipt = LiveUpdateReceipt {
                delivery_id: entry.delivery_id.clone(),
                update_digest: entry.update_digest.clone(),
                journal_cursor: 7,
                accepting_host_epoch: 1,
            };
            let event = AdmittedLiveUpdate {
                metadata: AdmittedLiveUpdateMetadata {
                    accepted: RelayAcceptedLiveUpdate {
                        receipt: receipt.clone(),
                        binding: f.binding.clone(),
                        authority: ServerDerivedLiveUpdateAuthority::Owner {
                            principal_id: "owner".into(),
                        },
                        received_at_ms: 7,
                    },
                    first_seen: vec![],

                    canonical_version: Some(2),

                    author_snapshot: Some(
                        (Some(declaration.clone()))
                            .into_iter()
                            .map(crate::live_update_application::LiveAuthorEntry::from)
                            .collect(),
                    ),

                    first_seen_deletes: Some(vec![]),

                    checkpoint_coverage: None,
                },
                update_bytes: update.clone(),
            };
            let ApplicationResult::Applied(ack, _) = apply_committed(
                &mut f.store,
                &mut WriterDocCache::new(),
                &f.handle,
                event,
                &NoFaults,
                100_000_000,
                |_, _, _, _| Ok(()),
            )
            .unwrap() else {
                panic!("application refused")
            };
            (Some(receipt), ack.local_ydoc_sequence)
        } else {
            let key = f.key.clone();
            f.store
                .write_with(&NoFaults, |tx| {
                    durable::record_authorized_update_in_tx(
                        tx, &key, &update, true, None, None, false, 11,
                    )
                })
                .unwrap();
            (None, 0)
        };
        // An enrollment observes this binding, and the entry keeps the agent
        // its editor declared. Its draft proof is set below.
        let namespace = f.handle.registration.lock().unwrap().namespace.clone();
        let binding_json = serde_json::to_string(&f.binding).unwrap();
        let declaration_json = serde_json::to_string(&declaration).unwrap();
        let b = f.binding.clone();
        f.store
            .write_with(&NoFaults, |tx| {
                tx.execute(
                    "UPDATE owner_ydoc_outbox_entries SET agent_declaration_json=?1 WHERE delivery_id=?2",
                    params![declaration_json, entry.delivery_id],
                )
                .map_err(write_sql)?;
                tx.execute(
                    "INSERT INTO ydoc_owner_bindings (workspace_id,main_version_id,object_id,lineage_claim_id,binding_json,relay_database_namespace,binding_revision,accepted_cursor,native_head_sequence,checkpoint_digest,max_pending_bytes,max_pending_age_ms) VALUES (?1,?2,?3,?4,?5,?6,1,0,0,?4,1000000,60000)",
                    params![b.workspace_id, b.main_version_id, b.object_id, b.lineage_claim_id, binding_json, namespace],
                )
                .map_err(write_sql)?;
                Ok::<_, ApplicationError>(())
            })
            .unwrap();
        let input = native_tail_input(&mut f, terminal.clone(), applied_sequence);
        let inventory = native_tail_inventory(&f.store);
        // A generic entry queued before enrollment carries no draft proof.
        // Neither does a revision the enrollment never reached, another
        // relay's enrollment, or an enrollment observing another binding.
        let path = f.binding.current_path.clone();
        for mutation in [
            String::new(),
            "UPDATE owner_ydoc_outbox_entries SET draft_binding_revision=2".into(),
            "UPDATE owner_ydoc_outbox_entries SET draft_binding_revision=1; \
             UPDATE ydoc_owner_bindings SET relay_database_namespace='other-relay'"
                .into(),
            format!(
                "UPDATE ydoc_owner_bindings SET relay_database_namespace='{namespace}', \
                 binding_json=json_set(binding_json,'$.currentPath','elsewhere.md')"
            ),
        ] {
            f.store
                .write_with(&NoFaults, |tx| {
                    tx.execute_batch(&mutation).map_err(write_sql)
                })
                .unwrap();
            assert!(
                native_tail_prepare(&mut f, input.clone()).is_err(),
                "accepted {mutation:?}"
            );
            assert_eq!(inventory, native_tail_inventory(&f.store));
        }
        f.store
            .write_with(&NoFaults, |tx| {
                tx.execute(
                    "UPDATE ydoc_owner_bindings SET binding_json=json_set(binding_json,'$.currentPath',?1)",
                    [&path],
                )
                .map_err(write_sql)
            })
            .unwrap();
        let proposal = native_tail_prepare(&mut f, input.clone()).unwrap();
        let sources = &proposal.receipt().native_sources;
        assert_eq!(sources.len(), 1);
        assert_eq!(sources[0].delivery_id, entry.delivery_id);
        assert_eq!(sources[0].append_key, "agent-draft");
        assert_eq!(sources[0].accepted_receipt, terminal);
        assert!(sources[0].source.native().is_none());
        assert_eq!(
            serde_json::to_value(&sources[0].source).unwrap(),
            serde_json::json!({
                "binding": f.binding,
                "updateDigest": entry.update_digest,
                "origin": {
                    "kind": "ownerDraft",
                    "agentDeclaration": {"agentId": "trip-agent 旅行", "onBehalfOf": "owner", "depth": 1},
                },
            })
        );
        assert_eq!(inventory, native_tail_inventory(&f.store));
        // The draft's declaration is part of its identity: a changed one
        // no longer matches its accepted receipt or the saved proposal.
        f.store
            .write_with(&NoFaults, |tx| {
                tx.execute(
                    "UPDATE owner_ydoc_outbox_entries SET agent_declaration_json=json_set(agent_declaration_json,'$.agentId','other-agent')",
                    [],
                )
                .map_err(write_sql)
            })
            .unwrap();
        assert!(native_tail_prepare(&mut f, input).is_err());
    }
}

/// Another person's edit on `other`, which the relay accepted at `cursor`
/// after the adoption, applied as committed.
fn apply_recipient_edit(f: &mut Fixture, other: &Ydoc, cursor: i64, text: &str) -> ApplicationResult {
    apply_recipient_update(f, other, cursor, text, false)
}

/// [`apply_recipient_edit`], sending `other`'s full state with the edit when
/// `full_state` is set, as a client that resends what the host already has.
fn apply_recipient_update(
    f: &mut Fixture,
    other: &Ydoc,
    cursor: i64,
    text: &str,
    full_state: bool,
) -> ApplicationResult {
    let event = recipient_update(f, other, cursor, text, full_state);
    apply_committed(
        &mut f.store,
        &mut WriterDocCache::new(),
        &f.handle,
        event,
        &NoFaults,
        100_000_000,
        |_, _, _, _| Ok(()),
    )
    .unwrap()
}

/// The recipient's edit of `other` as the relay accepted it at `cursor`.
fn recipient_update(
    f: &Fixture,
    other: &Ydoc,
    cursor: i64,
    text: &str,
    full_state: bool,
) -> AdmittedLiveUpdate {
    let before = other.state_vector();
    let edit = other.richdoc_append_paragraph(text);
    let bytes = if full_state { other.encode_full_state() } else { edit };
    let mut first_seen: Vec<_> = other
        .state_vector()
        .iter()
        .filter_map(|(client, clock)| {
            let start = before.get(client);
            (*clock > start).then_some(LiveUpdateStructRange {
                client_id: client.get() as i64,
                start_clock: i64::from(start),
                end_clock: i64::from(*clock),
            })
        })
        .collect();
    first_seen.sort_by_key(|range| range.client_id);
    AdmittedLiveUpdate {
        metadata: AdmittedLiveUpdateMetadata {
            accepted: RelayAcceptedLiveUpdate {
                receipt: LiveUpdateReceipt {
                    delivery_id: if cursor == 1 {
                        "recipient-edit".into()
                    } else {
                        format!("recipient-edit-{cursor}")
                    },
                    update_digest: hex_sha256(&bytes),
                    journal_cursor: cursor,
                    accepting_host_epoch: 1,
                },
                binding: f.binding.clone(),
                authority: ServerDerivedLiveUpdateAuthority::Named {
                    principal_id: "recipient".into(),
                    grant_id: "grant".into(),
                    grant_generation: 1,
                },
                received_at_ms: cursor,
            },
            first_seen,
            canonical_version: Some(2),
            author_snapshot: Some(vec![LiveAuthorEntry::Human {
                human_id: "recipient".into(),
                human_name: "Recipient".into(),
            }]),
            first_seen_deletes: Some(vec![]),
            checkpoint_coverage: None,
        },
        update_bytes: bytes,
    }
}

/// The adopted fixture's one queue, holding the owner's adoption seed.
fn seed_outbox(f: &Fixture) -> String {
    f.store
        .read_with(|conn| conn.query_row("SELECT outbox_id FROM owner_ydoc_outboxes", [], |r| r.get(0)))
        .unwrap()
}

fn refuse_seed(f: &mut Fixture, outbox: &str) {
    owner_outbox::quarantine(
        &mut f.store,
        "workspace",
        owner_outbox::OwnerOutboxQuarantineInput {
            outbox_id: outbox.to_owned(),
            reason: "invalid-update".into(),
            observed_binding: None,
        },
        8,
    )
    .unwrap();
}

/// The header and the checkpoint a recovery read of `outbox` names, paged in
/// `page` bytes. None once a part changed under it.
fn read_recovery_checkpoint(
    f: &Fixture,
    outbox: &str,
    page: usize,
) -> Option<(serde_json::Value, Vec<u8>)> {
    let read = |cursor| {
        owner_outbox::read_pending_page(&f.store, "workspace", outbox, cursor, page)
            .unwrap_or_else(|error| panic!("recovery read failed: {error}"))
    };
    let mut header = Vec::new();
    let mut cursor = None;
    loop {
        let owner_outbox::OwnerOutboxPageResult::Page(part) = read(cursor) else {
            return None;
        };
        header.extend(part.bytes);
        match part.next_cursor {
            Some(next) if next.part == owner_outbox::OwnerOutboxReadPart::Header => cursor = Some(next),
            next => {
                cursor = next;
                break;
            }
        }
    }
    let header: serde_json::Value = serde_json::from_slice(&header).unwrap();
    let mut checkpoint = Vec::new();
    let mut cursor = Some(owner_outbox::OwnerOutboxReadCursor {
        snapshot: cursor.unwrap().snapshot,
        part: owner_outbox::OwnerOutboxReadPart::Checkpoint,
        sequence: 0,
        offset: 0,
    });
    while let Some(at) = cursor {
        let owner_outbox::OwnerOutboxPageResult::Page(part) = read(Some(at)) else {
            return None;
        };
        assert_eq!(Some(part.digest.as_str()), header["checkpointDigest"].as_str());
        checkpoint.extend(part.bytes);
        cursor = part.next_cursor;
    }
    assert_eq!(Some(hex_sha256(&checkpoint).as_str()), header["checkpointDigest"].as_str());
    Some((header, checkpoint))
}

fn checkpoint_text(bytes: &[u8]) -> String {
    let doc = Ydoc::wire();
    doc.apply(bytes).unwrap();
    doc.project(ContentKind::Richdoc).unwrap().content
}

#[test]
fn a_recovery_copy_of_a_refused_seed_holds_every_accepted_edit_after_it() {
    let mut f = Fixture::new();
    f.local_edit_before_adoption();
    f.adopt().unwrap();
    let outbox = seed_outbox(&f);
    let other = Ydoc::wire();
    other.apply(&f.cut.baseline_bytes).unwrap();
    assert!(matches!(
        apply_recipient_edit(&mut f, &other, 1, "Recipient text"),
        ApplicationResult::Applied(..)
    ));
    refuse_seed(&mut f, &outbox);
    let prepare = |f: &mut Fixture| owner_outbox::prepare_recovery_checkpoint(&mut f.store, "workspace", &outbox);
    let recorded = |f: &Fixture| -> (Option<String>, Option<i64>) {
        f.store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT recovery_checkpoint_digest,recovery_checkpoint_cursor FROM owner_ydoc_outboxes WHERE outbox_id=?1",
                    [&outbox],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
            })
            .unwrap()
    };
    // Only the writer builds it, so a read before then names nothing.
    assert!(matches!(
        owner_outbox::read_pending_page(&f.store, "workspace", &outbox, None, 4096),
        Err(owner_outbox::OwnerOutboxError::RecoveryCheckpointOutdated)
    ));
    prepare(&mut f).unwrap();
    let (header, checkpoint) = read_recovery_checkpoint(&f, &outbox, 16).unwrap();
    // Accepted frames only: the recipient's edit, never the refused seed.
    let text = checkpoint_text(&checkpoint);
    assert!(text.contains("Recipient text"), "{text}");
    assert!(!text.contains("edited before connecting"), "{text}");
    assert_eq!(header["frozenAtRefusedSeed"], serde_json::json!(true));
    assert!(checkpoint.len() > 16, "the checkpoint spans pages");
    let first = recorded(&f);
    assert_eq!(first.1, Some(1));
    assert_eq!(first.0.as_deref(), header["checkpointDigest"].as_str());
    // Building again at the same cursor keeps the same bytes.
    prepare(&mut f).unwrap();
    assert_eq!(recorded(&f), first);
    // A further accepted edit moves the cursor: a read under way restarts,
    // and the next build names new bytes holding both edits.
    let header_cursor = owner_outbox::OwnerOutboxReadCursor {
        snapshot: {
            let owner_outbox::OwnerOutboxPageResult::Page(page) =
                owner_outbox::read_pending_page(&f.store, "workspace", &outbox, None, 4096).unwrap()
            else {
                panic!("unchanged queue");
            };
            page.cursor.snapshot
        },
        part: owner_outbox::OwnerOutboxReadPart::Checkpoint,
        sequence: 0,
        offset: 0,
    };
    assert!(matches!(
        apply_recipient_edit(&mut f, &other, 2, "Second recipient text"),
        ApplicationResult::Applied(..)
    ));
    assert!(matches!(
        owner_outbox::read_pending_page(&f.store, "workspace", &outbox, Some(header_cursor), 4096),
        Ok(owner_outbox::OwnerOutboxPageResult::ReadChanged)
    ));
    assert!(matches!(
        owner_outbox::read_pending_page(&f.store, "workspace", &outbox, None, 4096),
        Err(owner_outbox::OwnerOutboxError::RecoveryCheckpointOutdated)
    ));
    prepare(&mut f).unwrap();
    let (header, checkpoint) = read_recovery_checkpoint(&f, &outbox, 4096).unwrap();
    let second = recorded(&f);
    assert_eq!(second.1, Some(2));
    assert_ne!(second.0, first.0);
    assert_eq!(second.0.as_deref(), header["checkpointDigest"].as_str());
    let text = checkpoint_text(&checkpoint);
    assert!(text.contains("Recipient text") && text.contains("Second recipient text"), "{text}");
    let replaced: i64 = f
        .store
        .read_with(|conn| {
            conn.query_row("SELECT count(*) FROM binary_blobs WHERE sha256=?1", [first.0.as_deref().unwrap()], |r| r.get(0))
        })
        .unwrap();
    assert_eq!(replaced, 0, "the older checkpoint's bytes go once nothing names them");
    // An accepted update still waiting on a missing dependency refuses the copy.
    f.store
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT INTO ydoc_deferred_updates(workspace_id,version_id,object_id,origin_id,origin_seq,recorded_at_ms) \
                 VALUES('workspace','main','object','recipient-origin',1,30)",
                [],
            )
            .map_err(write_sql)
        })
        .unwrap();
    assert!(matches!(
        owner_outbox::read_pending_page(&f.store, "workspace", &outbox, None, 4096),
        Err(owner_outbox::OwnerOutboxError::AcceptedStateIncomplete)
    ));
    assert!(matches!(prepare(&mut f), Err(owner_outbox::OwnerOutboxError::AcceptedStateIncomplete)));
    assert_eq!(recorded(&f), second);
    // An update the owner holds for its service host is never applied, so the
    // copy proceeds past it and the row stays held for the binding's end.
    f.store
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "UPDATE ydoc_deferred_updates SET origin_id='service-host:host',deferred_while_bound=1",
                [],
            )
            .map_err(write_sql)
        })
        .unwrap();
    prepare(&mut f).unwrap();
    let (header, checkpoint) = read_recovery_checkpoint(&f, &outbox, 4096).unwrap();
    assert_eq!(second.0.as_deref(), header["checkpointDigest"].as_str());
    assert!(checkpoint_text(&checkpoint).contains("Second recipient text"));
    let held: i64 = f
        .store
        .read_with(|conn| conn.query_row("SELECT count(*) FROM ydoc_deferred_updates WHERE deferred_while_bound=1", [], |r| r.get(0)))
        .unwrap();
    assert_eq!(held, 1);
}

#[test]
fn a_recovery_copy_rebuilds_an_accepted_history_longer_than_one_update() {
    let mut f = Fixture::new();
    f.local_edit_before_adoption();
    f.adopt().unwrap();
    let outbox = seed_outbox(&f);
    let other = Ydoc::wire();
    other.apply(&f.cut.baseline_bytes).unwrap();
    let large = "x".repeat(1_800_000);
    assert!(matches!(
        apply_recipient_edit(&mut f, &other, 1, &large),
        ApplicationResult::Applied(..)
    ));
    let history = |f: &Fixture| -> (i64, i64, i64) {
        f.store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT (SELECT count(*) FROM live_accepted_checkpoints),
                        (SELECT b.byte_length FROM live_accepted_checkpoints c JOIN binary_blobs b ON b.sha256=c.state_sha256 ORDER BY c.event_count DESC LIMIT 1),
                        coalesce((SELECT u.suffix_bytes FROM live_accepted_updates u WHERE u.event_count>(SELECT max(event_count) FROM live_accepted_checkpoints) ORDER BY u.event_count DESC LIMIT 1),0)",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
            })
            .unwrap()
    };
    let (adopted, _, _) = history(&f);
    let mut cursor = 1;
    loop {
        cursor += 1;
        assert!(cursor < 64, "the history never outgrew one update");
        assert!(matches!(
            apply_recipient_update(&mut f, &other, cursor, &format!("Edit {cursor}"), true),
            ApplicationResult::Applied(..)
        ));
        let (checkpoints, state, suffix) = history(&f);
        if checkpoints > adopted && state + suffix > crate::limits::MAX_YDOC_UPDATE_BYTES as i64 {
            break;
        }
    }
    refuse_seed(&mut f, &outbox);
    let (_, checkpoint) = prepare_and_read_recovery(&mut f, &outbox, 1 << 20);
    assert!(checkpoint.len() < crate::limits::MAX_YDOC_UPDATE_BYTES);
    let text = checkpoint_text(&checkpoint);
    assert!(text.contains(&large) && text.contains(&format!("Edit {cursor}")));
}

fn try_fence_next_generation(f: &mut Fixture, operation: &str) -> Result<(), ApplicationError> {
    let adoption_id: String = f
        .store
        .read_with(|conn| conn.query_row("SELECT adoption_id FROM live_owner_adoptions", [], |r| r.get(0)))
        .unwrap();
    let held = f.handle.registration.lock().unwrap();
    let mut input = NativeRestoreFence {
        point: crate::live_update_application::NativeRestoreSelection {
            journal_cursor: 0,
            receipt_digest: f.binding.lineage_claim_id.clone(),
        },
        operation_id: operation.into(),
        relay_database_namespace: held.namespace.clone(),
        old_binding: f.binding.clone(),
        host_id: held.coordinate.host_id.clone(),
        new_fence: f.binding.restore_fence_generation + 1,
        origin: RestoreDeliveryOrigin::Owner { id: adoption_id },
        terminal: None,
        applied_sequence: 0,
    };
    (input.terminal, input.applied_sequence) = f
        .store
        .read_with(|conn| crate::live_update_application::restore_fence::applied_tip(conn, &held, &input))
        .unwrap();
    let coordinate = held.coordinate.clone();
    drop(held);
    f._owner
        .fence_restore(&mut f.store, None, input, coordinate, 20, &NoFaults, |_, _| Ok(()))
        .map(|_| ())
}

#[test]
fn a_restore_fence_waits_while_an_accepted_update_lacks_its_dependency() {
    let mut f = Fixture::new();
    f.local_edit_before_adoption();
    f.adopt().unwrap();
    let outbox = seed_outbox(&f);
    let other = Ydoc::wire();
    other.apply(&f.cut.baseline_bytes).unwrap();
    assert!(matches!(
        apply_recipient_edit(&mut f, &other, 1, "Recipient text"),
        ApplicationResult::Applied(..)
    ));
    refuse_seed(&mut f, &outbox);
    f.store
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT INTO ydoc_deferred_updates(workspace_id,version_id,object_id,origin_id,origin_seq,recorded_at_ms) \
                 VALUES('workspace','main','object','recipient-origin',1,30)",
                [],
            )
            .map_err(write_sql)
        })
        .unwrap();
    let fenced = try_fence_next_generation(&mut f, "restore-while-deferred");
    assert!(matches!(fenced, Err(ApplicationError::AcceptedStateIncomplete)), "{fenced:?}");
    // Nothing moved: the restore can ask again once the dependency arrives.
    let fences: i64 = f
        .store
        .read_with(|conn| conn.query_row("SELECT count(*) FROM live_restore_fences", [], |r| r.get(0)))
        .unwrap();
    assert_eq!(fences, 0);
}

#[test]
fn a_storage_failure_keeps_the_binding_until_the_earlier_seeds_final_state_is_kept() {
    let mut f = Fixture::new();
    f.local_edit_before_adoption();
    f.adopt().unwrap();
    let outbox = seed_outbox(&f);
    let other = Ydoc::wire();
    other.apply(&f.cut.baseline_bytes).unwrap();
    assert!(matches!(
        apply_recipient_edit(&mut f, &other, 1, "Recipient text"),
        ApplicationResult::Applied(..)
    ));
    refuse_seed(&mut f, &outbox);
    // The accepted checkpoint the rebuild starts from fails its integrity check.
    let digest: String = f
        .store
        .read_with(|conn| {
            conn.query_row(
                "SELECT state_sha256 FROM live_accepted_checkpoints ORDER BY event_count DESC LIMIT 1",
                [],
                |r| r.get(0),
            )
        })
        .unwrap();
    let kept = f.store.get_binary_blob(&digest).unwrap().unwrap();
    let store_bytes = |f: &mut Fixture, bytes: &[u8]| {
        f.store
            .write_with(&NoFaults, |tx| {
                tx.execute("UPDATE binary_blobs SET bytes=?1 WHERE sha256=?2", params![bytes, digest])
                    .map_err(write_sql)
            })
            .unwrap();
    };
    store_bytes(&mut f, &vec![0; kept.len()]);
    let (namespace, coordinate) = {
        let held = f.handle.registration.lock().unwrap();
        (held.namespace.clone(), held.coordinate.clone())
    };
    let mut moved = f.binding.clone();
    moved.lineage_claim_id = "c".repeat(64);
    let lineage = |f: &Fixture| -> String {
        f.store
            .read_with(|conn| {
                conn.query_row("SELECT lineage_claim_id FROM live_device_application_bindings", [], |r| r.get(0))
            })
            .unwrap()
    };
    let refused = f
        ._owner
        .register(&mut f.store, namespace.clone(), coordinate.clone(), moved.clone())
        .err();
    assert!(
        matches!(
            refused,
            Some(ApplicationError::Storage(dohc_engine_storage::StorageError::BlobIntegrity { .. }))
        ),
        "{refused:?}"
    );
    assert_eq!(lineage(&f), f.binding.lineage_claim_id);
    // Once the blob is repaired, the registration keeps the final accepted
    // state as the queue's recovery checkpoint and moves the binding.
    store_bytes(&mut f, &kept);
    f._owner
        .register(&mut f.store, namespace, coordinate, moved)
        .unwrap();
    assert_eq!(lineage(&f), "c".repeat(64));
    let (header, checkpoint) = read_recovery_checkpoint(&f, &outbox, 4096).unwrap();
    assert_eq!(header["frozenAtRefusedSeed"], serde_json::json!(false));
    assert_eq!(header["recoveryCheckpointDigest"], header["checkpointDigest"]);
    let text = checkpoint_text(&checkpoint);
    assert!(text.contains("Recipient text"), "{text}");
    assert!(!text.contains("edited before connecting"), "{text}");
}

#[test]
fn native_restore_apply_preserves_quarantined_tail_and_survives_compaction_and_backup() {
    let mut f = Fixture::new();
    f.adopt().unwrap();
    native_tail_edit(&mut f, "Pending before", 11);
    native_tail_edit(&mut f, "Pending after", 12);
    let prep = native_tail_input(&mut f, None, 0);
    let proposal = native_tail_prepare(&mut f, prep.clone()).unwrap();
    let mut binding = f.binding.clone();
    binding.restore_fence_generation = 1;
    let input = NativeRestoreApplication {
        preparation: prep.clone(),
        candidate_digest: proposal.receipt().candidate_digest.clone(),
        native_source_manifest_digest: proposal.receipt().native_source_manifest_digest.clone(),
        admitted: AdmittedLiveUpdateMetadata {
            accepted: RelayAcceptedLiveUpdate {
                receipt: LiveUpdateReceipt {
                    delivery_id: "restore-tail".into(),
                    update_digest: proposal.receipt().candidate_digest.clone(),
                    journal_cursor: 71,
                    accepting_host_epoch: 2,
                },
                binding,
                authority: ServerDerivedLiveUpdateAuthority::Owner {
                    principal_id: "restoring-owner".into(),
                },
                received_at_ms: 80,
            },
            first_seen: proposal.receipt().replacement_ranges.clone(),
            canonical_version: Some(2),
            author_snapshot: Some(vec![]),
            first_seen_deletes: Some(vec![]),
            checkpoint_coverage: None,
        },
    };
    let inventory = native_tail_inventory(&f.store);
    let coordinate = f.handle.registration.lock().unwrap().coordinate.clone();
    let receipt = f
        ._owner
        .apply_restore(
            &mut f.store, None,
            &mut WriterDocCache::new(),
            input.clone(),
            coordinate.clone(),
            2_000_000,
            100,
            90,
            &NoFaults,
            |_, _, _, _| Ok(()),
        )
        .unwrap();
    assert_eq!(receipt.local_head_sequence, 3);
    assert_eq!(inventory, native_tail_inventory(&f.store));
    assert_eq!(
        f.store
            .table_row_count("live_device_update_applications")
            .unwrap(),
        1
    );
    assert!(matches!(
        f.store
            .write_with(&NoFaults, |tx| durable::record_update_in_tx(
                tx,
                &f.key,
                proposal.candidate_bytes(),
                None,
                None,
                100
            )),
        Err(CollabError::RestoreFenced)
    ));
    durable::maybe_compact(&mut f.store, &f.key, 0, &NoFaults, 100).unwrap();
    assert_eq!(f.store.table_row_count("ydoc_updates").unwrap(), 0);
    assert_eq!(
        receipt,
        f._owner
            .apply_restore(
                &mut f.store, None,
                &mut WriterDocCache::new(),
                input.clone(),
                coordinate.clone(),
                2_000_000,
                100,
                110,
                &NoFaults,
                |_, _, _, _| Ok(()),
            )
            .unwrap()
    );
    assert_eq!(
        f._owner
            .fence_restore(
                &mut f.store, None,
                prep.fence.operation.clone(),
                coordinate.clone(),
                110,
                &NoFaults,
                |_, _| Ok(()),
            )
            .unwrap(),
        prep.fence
    );
    use dohc_engine_storage::backup::{create_verified_backup, BackupOutcome, RealFreeSpace};
    let BackupOutcome::Verified(backup) = create_verified_backup(
        &f.store,
        &f._scratch.join("applied-recovery"),
        "apply",
        "test",
        120,
        &RealFreeSpace,
        &NoFaults,
    )
    .unwrap() else {
        panic!("backup interrupted")
    };
    let mut store = EngineStore::open(&backup.backup_path, 130).unwrap();
    let mut owner = ApplicationOwner::new("workspace".into()).unwrap();
    assert_eq!(
        receipt,
        owner
            .apply_restore(
                &mut store, None,
                &mut WriterDocCache::new(),
                input.clone(),
                coordinate.clone(),
                2_000_000,
                100,
                140,
                &NoFaults,
                |_, _, _, _| Ok(()),
            )
            .unwrap()
    );
    assert_eq!(inventory, native_tail_inventory(&store));
    assert_eq!(store.table_row_count("moments").unwrap(), 1);
    let settled = owner
        .with_restore_settlement(
            &mut store, None,
            input.clone(),
            coordinate.clone(),
            2_000_000,
            100,
            |store, audit| {
                restore_content::tests::record_test_projection(store, audit, "restored-tail-moment")
            },
        )
        .unwrap();
    assert!(!settled.materialized);
    assert_eq!(
        settled.markdown_digest,
        input.preparation.point.markdown_digest
    );
    assert_eq!(settled.application_count, 1);
    assert_eq!(settled.local_ydoc_sequence, 3);
    assert_eq!(inventory, native_tail_inventory(&store));
    assert_eq!(store.table_row_count("moments").unwrap(), 2);
    drop(store);
    let mut store = EngineStore::open(&backup.backup_path, 150).unwrap();
    let replay = owner
        .with_restore_settlement(
            &mut store, None,
            input,
            coordinate,
            2_000_000,
            100,
            |store, audit| {
                restore_content::tests::record_test_projection(store, audit, "restored-tail-moment")
            },
        )
        .unwrap();
    assert_eq!(settled.settlement_id, replay.settlement_id);
    assert_eq!(inventory, native_tail_inventory(&store));
    assert_eq!(store.table_row_count("moments").unwrap(), 2);
}

#[test]
fn resumed_owner_retains_old_pending_sources_and_creates_an_independent_generation_queue() {
    let mut f = Fixture::new();
    f.adopt().unwrap();
    let old = native_tail_edit(&mut f, "Unaccepted owner edit", 11);
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
                authority: ServerDerivedLiveUpdateAuthority::Owner {
                    principal_id: "restoring-owner".into(),
                },
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
        .apply_restore(
            &mut f.store, None,
            &mut WriterDocCache::new(),
            input.clone(),
            coordinate.clone(),
            2_000_000,
            100,
            90,
            &NoFaults,
            |_, _, _, _| Ok(()),
        )
        .unwrap();
    let canonical = f
        .store
        .read_with(|conn| durable::load_doc_in(conn, &f.key))
        .unwrap();
    let without_native = Ydoc::wire();
    without_native.apply(&f.cut.baseline_bytes).unwrap();
    without_native.apply(proposal.candidate_bytes()).unwrap();
    assert!(!crate::replay_parity::structurally_equal_v2(&without_native, &canonical).unwrap());
    let held = f.handle.registration.lock().unwrap();
    f.store
        .read_with(|conn| -> Result<(), ApplicationError> {
            let history = accepted_history::read(
                conn,
                &held,
                71,
                &mut restore_content::Budget {
                    remaining: 2_000_000,
                },
                100,
            )?;
            assert_eq!(history.proof.event_count, 1);
            assert_eq!(
                history.proof.checkpoint.restore_operation_id.as_deref(),
                Some("tail-restore")
            );
            assert!(crate::replay_parity::structurally_equal_v2(
                &history.doc,
                &canonical
            )?);
            Ok(())
        })
        .unwrap();
    drop(held);
    let settlement = f
        ._owner
        .with_restore_settlement(
            &mut f.store, None,
            input.clone(),
            coordinate.clone(),
            2_000_000,
            100,
            |store, audit| {
                restore_content::tests::record_test_projection(store, audit, "resumed-owner")
            },
        )
        .unwrap();
    let resume = NativeRestoreResume {
        application: input,
        settlement_id: settlement.settlement_id.unwrap(),
    };
    f._owner
        .resume_restore(
            &mut f.store, None,
            resume.clone(),
            coordinate.clone(),
            2_000_000,
            100,
            100,
            &NoFaults,
            |_, _, _, _| Ok(()),
        )
        .unwrap();
    f.binding = binding;
    f.doc = canonical;
    f.handle = f
        ._owner
        .register(
            &mut f.store,
            "namespace".into(),
            coordinate.clone(),
            f.binding.clone(),
        )
        .unwrap();
    let old_inventory = native_tail_inventory(&f.store);
    let stale = f.doc.richdoc_append_paragraph("stale writer");
    assert!(matches!(
        crate::record_local_update(
            &mut f.store,
            &mut WriterDocCache::new(),
            &f.key,
            &stale,
            crate::LocalAppend::default(),
            &NoFaults,
            110,
            |_, _, _| Ok(())
        ),
        Err(CollabError::RestoreFenced)
    ));
    f.doc = f
        .store
        .read_with(|conn| durable::load_doc_in(conn, &f.key))
        .unwrap();
    let fresh = native_tail_edit(&mut f, "New generation pending", 120);
    assert_ne!(fresh.delivery_id, old.delivery_id);
    assert_eq!(fresh.sequence, 1);
    let ack = native_tail_apply(&mut f, fresh.update.clone(), fresh.delivery_id.clone(), 82);
    let terminal = LiveUpdateReceipt {
        delivery_id: ack.delivery_id,
        update_digest: ack.update_digest,
        journal_cursor: ack.journal_cursor,
        accepting_host_epoch: ack.accepting_host_epoch,
    };
    let second = native_tail_input(&mut f, Some(terminal), ack.local_ydoc_sequence);
    let next = native_tail_prepare(&mut f, second).unwrap();
    assert_eq!(next.receipt().accepted_history.event_count, 2);
    assert_eq!(next.receipt().native_sources.len(), 1);
    assert_eq!(
        next.receipt().native_sources[0]
            .binding
            .restore_fence_generation,
        1
    );
    let inventory = native_tail_inventory(&f.store);
    for entry in old_inventory.as_array().unwrap() {
        assert!(inventory.as_array().unwrap().contains(entry));
    }
    let historic = f
        ._owner
        .resume_restore(
            &mut f.store, None,
            resume,
            coordinate,
            2_000_000,
            100,
            130,
            &NoFaults,
            |_, _, _, _| panic!("old retry must not resume new fence"),
        )
        .unwrap();
    assert_eq!(historic.binding.restore_fence_generation, 1);
}

#[test]
fn a_new_settlement_refuses_an_equal_cursor_interval() {
    let mut f = Fixture::new();
    f.adopt().unwrap();
    let result = with_settlement(
        &mut f.store,
        &f.handle,
        None,
        128,
        NativeHistoryReconstruction {
            working_reserve_bytes: 8 * 1024 * 1024,
        },
        |store, audit| {
            assert!(audit.is_empty());
            let doc = store.read_with(|conn| durable::load_doc_in(conn, &f.key))?;
            let text = doc.project(ContentKind::Richdoc)?.content;
            let vector = hex_sha256(&doc.encode_state_vector());
            store.write_with(&NoFaults, |tx| -> Result<_, ApplicationError> {
                let written = dohc_engine_domain::write_projected_text_in_tx(
                    tx,
                    dohc_engine_domain::ProjectedWriteText {
                        workspace_id: "workspace", version_id: "main", object_id: "object",
                        path: std::borrow::Cow::Borrowed("owner.md"),
                        text: std::borrow::Cow::Borrowed(&text), moment_id: "empty-settlement",
                        metadata_origin: "ydoc", metadata_summary: None,
                        metadata_correlation_id: None, author_json: None, now_ms: 30, request_id: None,
                    },
                ).map_err(|_| ApplicationError::Corrupt)?;
                tx.execute("UPDATE ydoc_docs SET last_settled_sha=?1 WHERE workspace_id='workspace' AND version_id='main' AND object_id='object'", [&written.snapshot.blob_sha256]).map_err(write_sql)?;
                audit.record_in_tx(tx, "empty-settlement", &written.snapshot.blob_sha256, &vector, 30)
            })
        },
    );
    assert!(
        matches!(result, Err(ApplicationError::InvalidInput(message)) if message == "a new settlement must cover an accepted edit")
    );
    assert_eq!(
        f.store.table_row_count("live_device_settlements").unwrap(),
        0
    );
    assert_eq!(f.store.table_row_count("moments").unwrap(), 1);
}

/// A read of `outbox`'s recovery checkpoint, built first by the writer
/// whenever the read names an older one, as `ydoc.ownerOutbox.readPending` does.
fn prepare_and_read_recovery(f: &mut Fixture, outbox: &str, page: usize) -> (serde_json::Value, Vec<u8>) {
    owner_outbox::prepare_recovery_checkpoint(&mut f.store, "workspace", outbox).unwrap();
    read_recovery_checkpoint(f, outbox, page).expect("unchanged queue")
}
