use super::super::prefix;

#[test]
fn drain2b_nonempty_prefix_requires_publication_frontier() {
    let (_dir, mut store, observed, _, _, _) = prefix_queue(1);
    let before = store.table_row_count("owner_ydoc_outbox_entries").unwrap();
    let result = prefix::commit_prefix(
        &mut store, &mut Default::default(), &observed.binding, &"c".repeat(64),
        6, &NoFaults, |_, _, _, _| Ok(None),
    );
    assert!(matches!(result, Err(OwnerOutboxError::Corrupt)), "{result:?}");
    assert_eq!(store.table_row_count("owner_ydoc_outbox_entries").unwrap(), before);
}

#[test]
fn drain2b_closed_session_cannot_reinsert_after_consumed_cleanup() {
    let (_dir, mut store, observed, _, inputs, outbox) = prefix_queue(1);
    let key = key(&observed.binding).unwrap();
    prefix_turn(&mut store, &mut Default::default(), &observed);
    store.write_with(&NoFaults, |tx| {
        prefix::close_consumed_in_tx(tx, &key, &outbox, 9)?;
        prefix::cleanup_consumed_in_tx(tx, &key, &outbox)?;
        Ok::<_,OwnerOutboxError>(())
    }).unwrap();
    let result = append_draft_cached(
        &mut store, &mut Default::default(), "workspace", inputs[0].clone(), &NoFaults,
    );
    assert!(matches!(result, Err(OwnerOutboxError::ParentMismatch)), "{result:?}");
    assert_eq!(store.table_row_count("owner_ydoc_outbox_entries").unwrap(), 0);
}

#[test]
fn drain2b_expected_commit_blockers_preserve_cache() {
    let (_dir, mut store, observed, _, _, _) = prefix_queue(40);
    let key = key(&observed.binding).unwrap();
    let mut cache = crate::WriterDocCache::new();
    prefix_turn(&mut store, &mut cache, &observed);
    for (digest, boundary, pending, blocker) in [
        ("d", false, false, prefix::CommitBlocker::DifferentRelease),
        ("c", true, false, prefix::CommitBlocker::HistoryBoundaryOwed),
        ("c", false, true, prefix::CommitBlocker::HistorySavePending),
    ] {
        store.write_with(&NoFaults, |tx| {
            tx.execute("UPDATE owner_live_stops SET binding_json=json_set(binding_json,'$.prefix.settlementOwed',json(?1))",[if boundary {"true"} else {"false"}]).map_err(write_sql)?;
            tx.execute("UPDATE ydoc_docs SET settle_prior_update_seq=?1",[pending.then_some(0)]).map_err(write_sql)?;
            Ok::<_,OwnerOutboxError>(())
        }).unwrap();
        assert_eq!(store.read_with(|c|prefix::commit_blocker_in(c,&observed.binding,&digest.repeat(64))).unwrap(),Some(blocker));
        assert!(prefix::commit_prefix(&mut store,&mut cache,&observed.binding,&digest.repeat(64),10,&NoFaults,|_,_,_,_|panic!("blocked fold")).is_err());
        assert!(cache.contains_for_test(&key));
    }
}

#[test]
fn prefix_folded_append_retry_keeps_the_tail_moving() {
    let (_dir, mut store, observed, _, inputs, _) = prefix_queue(40);
    let mut cache = crate::WriterDocCache::new();
    assert_eq!(
        prefix_turn(&mut store, &mut cache, &observed).consumed_entries,
        32
    );
    let before = store.table_row_count("owner_ydoc_outbox_entries").unwrap();
    append_draft_cached(
        &mut store,
        &mut cache,
        "workspace",
        inputs[0].clone(),
        &NoFaults,
    )
    .unwrap();
    assert_eq!(
        store.table_row_count("owner_ydoc_outbox_entries").unwrap(),
        before
    );
    let mut changed = inputs[0].clone();
    changed.update = inputs[1].update.clone();
    assert!(matches!(
        append_draft_cached(&mut store, &mut cache, "workspace", changed, &NoFaults),
        Err(OwnerOutboxError::AppendKeyMismatch)
    ));
    assert_eq!(
        prefix_turn(&mut store, &mut cache, &observed).consumed_entries,
        40
    );
}

#[test]
fn prefix_folded_retry_keeps_the_saved_reply_after_the_whole_outbox_is_removed() {
    let (_dir, mut store, observed, _, inputs, outbox) = prefix_queue(1);
    let expected = store
        .read_with(|c| {
            c.query_row(
                "SELECT delivery_id,sequence,result_pending_bytes,result_oldest_entry_at_ms,result_state FROM owner_ydoc_outbox_entries WHERE outbox_id=?1 AND append_key=?2",
                params![outbox, inputs[0].append_key],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?, r.get::<_, i64>(3)?, r.get::<_, String>(4)?)),
            )
            .map_err(read_sql)
        })
        .unwrap();
    prefix_turn(&mut store, &mut Default::default(), &observed);
    store
        .write_with(&NoFaults, |tx| {
            tx.execute("DELETE FROM ydoc_owner_bindings", [])
                .map_err(write_sql)?;
            tx.execute("UPDATE owner_live_stops SET state='released'", [])
                .map_err(write_sql)?;
            prefix::cleanup_session_page_in_tx(tx, &observed.binding)
        })
        .unwrap();
    assert_eq!(store.table_row_count("owner_ydoc_outboxes").unwrap(), 0);
    let result = match store
        .write_with(&NoFaults, |tx| {
            super::super::append_with_retained_base(
                tx,
                "workspace",
                super::super::OwnerOutboxAppendInput {
                    binding: observed.binding.clone(),
                    base_update: Vec::new(),
                    append_key: inputs[0].append_key.clone(),
                    update: inputs[0].update.clone(),
                    limits: observed.limits.clone(),
                    created_at_ms: 20,
                },
                Some((observed.binding.lineage_claim_id.clone(), 1)),
                Some(observed.revision),
                None,
                None,
                inputs[0].person_edit,
            )
        })
        .unwrap()
    {
        TxnOutcome::Committed(result) => result,
        _ => panic!("unexpected crash"),
    };
    assert_eq!(result.outbox_id, outbox);
    assert_eq!(result.delivery_id, expected.0);
    assert_eq!(result.sequence, expected.1);
    assert_eq!(result.pending_bytes, expected.2);
    assert_eq!(result.oldest_entry_at_ms, expected.3);
    assert_eq!(result.state.as_str(), expected.4);
    assert_eq!(
        store.table_row_count("owner_ydoc_outbox_entries").unwrap(),
        0,
        "a folded retry must not reinsert a new entry"
    );
}

#[test]
fn prefix_folded_retry_keeps_the_saved_reply_for_a_quarantined_outbox() {
    let (_dir, mut store, observed, _, inputs, outbox) = prefix_queue(1);
    let expected = store
        .read_with(|c| {
            c.query_row(
                "SELECT delivery_id,sequence,result_pending_bytes,result_oldest_entry_at_ms,result_state FROM owner_ydoc_outbox_entries WHERE outbox_id=?1 AND append_key=?2",
                params![outbox, inputs[0].append_key],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?, r.get::<_, i64>(3)?, r.get::<_, String>(4)?)),
            )
            .map_err(read_sql)
        })
        .unwrap();
    super::super::quarantine(
        &mut store,
        "workspace",
        super::super::OwnerOutboxQuarantineInput {
            outbox_id: outbox.clone(),
            reason: "binding-changed".into(),
            observed_binding: None,
        },
        8,
    )
    .unwrap();
    prefix_turn(&mut store, &mut Default::default(), &observed);
    let result = match store
        .write_with(&NoFaults, |tx| {
            super::super::append_with_retained_base(
                tx,
                "workspace",
                super::super::OwnerOutboxAppendInput {
                    binding: observed.binding.clone(),
                    base_update: Vec::new(),
                    append_key: inputs[0].append_key.clone(),
                    update: inputs[0].update.clone(),
                    limits: observed.limits.clone(),
                    created_at_ms: 20,
                },
                Some((observed.binding.lineage_claim_id.clone(), 1)),
                Some(observed.revision),
                None,
                None,
                inputs[0].person_edit,
            )
        })
        .unwrap()
    {
        TxnOutcome::Committed(result) => result,
        _ => panic!("unexpected crash"),
    };
    assert_eq!(result.outbox_id, outbox);
    assert_eq!(result.delivery_id, expected.0);
    assert_eq!(result.sequence, expected.1);
    assert_eq!(result.pending_bytes, expected.2);
    assert_eq!(result.oldest_entry_at_ms, expected.3);
    assert_eq!(result.state.as_str(), expected.4);
}

#[test]
fn prefix_retry_between_consumed_cleanup_pages_cannot_append_twice() {
    let (_dir, mut store, observed, _, inputs, outbox) = prefix_queue(130);
    let key = key(&observed.binding).unwrap();
    let mut cache = crate::WriterDocCache::new();
    while prefix_turn(&mut store, &mut cache, &observed).consumed_entries < 130 {}
    store
        .write_with(&NoFaults, |tx| {
            tx.execute("DELETE FROM ydoc_owner_bindings", [])
                .map_err(write_sql)?;
            tx.execute("UPDATE owner_live_stops SET state='released'", [])
                .map_err(write_sql)?;
            {
                prefix::close_consumed_in_tx(tx, &key, &outbox, 9)?;
                prefix::cleanup_consumed_in_tx(tx, &key, &outbox)
            }
        })
        .unwrap();
    let missing = store.read_with(|c| {
        inputs.iter().find(|input| !c.query_row("SELECT EXISTS(SELECT 1 FROM owner_prefix_consumed WHERE outbox_id=?1 AND append_key=?2)", params![outbox,input.append_key], |r| r.get::<_, bool>(0)).unwrap()).cloned().ok_or(OwnerOutboxError::Corrupt)
    }).unwrap();
    let mut appended = false;
    let result = store.write_with(&NoFaults, |tx| {
        prefix::append_old_session_in_tx(tx, &outbox, &missing, |_, _, _, _, _| {
            appended = true;
            Ok(999)
        })
    });
    assert!(
        !appended,
        "closed session replayed an original after its consumed key was reclaimed"
    );
    assert!(result.is_err());
}

#[test]
fn prefix_chunk_has_a_bounded_sql_instruction_cost() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let (_dir, mut store, observed, _, inputs, outbox) = prefix_queue(1);
    let digest = hex_sha256(&inputs[0].update);
    store.write_with(&NoFaults, |tx| {
        for sequence in 2..=10_000 {
            tx.execute("INSERT INTO owner_ydoc_outbox_entries(outbox_id,sequence,append_key,delivery_id,update_digest,update_blob_digest,byte_length,pending,created_at_ms,result_pending_bytes,result_oldest_entry_at_ms,result_state,draft_binding_revision,person_edit) VALUES(?1,?2,?3,?3,?4,?4,?5,1,3,?5,3,'active',1,1)", params![outbox,sequence,format!("seed-{sequence}"),digest,inputs[0].update.len() as i64]).map_err(write_sql)?;
        }
        tx.execute("UPDATE owner_ydoc_outboxes SET pending_bytes=?2 WHERE outbox_id=?1",params![outbox,inputs[0].update.len() as i64*10_000]).map_err(write_sql)?;
        Ok::<_,OwnerOutboxError>(())
    }).unwrap();
    let steps = std::sync::Arc::new(AtomicUsize::new(0));
    let counter = steps.clone();
    store
        .read_with(|c| {
            c.progress_handler(
                100,
                Some(move || {
                    counter.fetch_add(100, Ordering::Relaxed);
                    false
                }),
            )
            .map_err(read_sql)?;
            Ok::<_, OwnerOutboxError>(())
        })
        .unwrap();
    let result = prefix::commit_prefix(
        &mut store,
        &mut Default::default(),
        &observed.binding,
        &"c".repeat(64),
        6,
        &NoFaults,
        |tx, _, _, _| prefix::test_publication(tx, &observed.binding),
    );
    store
        .read_with(|c| {
            c.progress_handler(0, None::<fn() -> bool>)
                .map_err(read_sql)?;
            Ok::<_, OwnerOutboxError>(())
        })
        .unwrap();
    assert!(matches!(result.unwrap(), TxnOutcome::Committed(p) if p.consumed_entries == 32));
    let steps = steps.load(Ordering::Relaxed);
    println!("prefix-chunk pending=10000 vm-steps={steps}");
    assert!(
        steps < 30_000,
        "one chunk scanned the remaining queue: {steps} VM steps"
    );
    let oldest: Option<i64> = store
        .read_with(|c| {
            c.query_row(
                "SELECT oldest_entry_at_ms FROM owner_ydoc_outboxes WHERE outbox_id=?1",
                [&outbox],
                |r| r.get(0),
            )
        })
        .unwrap();
    assert_eq!(oldest, Some(3));
}

#[test]
fn prefix_small_cache_keeps_the_native_entry_instead_of_the_draft() {
    let (_dir, mut store, observed, _, _, _) = prefix_queue(40);
    let key = key(&observed.binding).unwrap();
    let native_bytes = store.read_with(|c| {
        let log: i64 = c.query_row("SELECT SUM(byte_length) FROM (SELECT byte_length FROM owner_ydoc_outbox_entries ORDER BY sequence LIMIT 32)", [], |r| r.get(0)).map_err(read_sql)?;
        Ok::<_,OwnerOutboxError>((crate::load_doc_in(c,&key).map_err(collab)?.encode_full_state().len() + log as usize) * 2)
    }).unwrap();
    let mut cache = crate::WriterDocCache::with_limits_for_test(16, native_bytes);
    open_draft_cached(&store, &mut cache, &observed.binding, 1).unwrap();
    prefix_turn(&mut store, &mut cache, &observed);
    assert!(
        cache.contains_for_test(&key),
        "the draft evicted the native replay frontier"
    );
}

#[test]
fn prefix_session_cleanup_reports_removed_parents() {
    let (_dir, mut store, observed, _, _, _) = prefix_queue(1);
    prefix_turn(&mut store, &mut Default::default(), &observed);
    store
        .write_with(&NoFaults, |tx| {
            tx.execute("DELETE FROM ydoc_owner_bindings", [])
                .map_err(write_sql)?;
            tx.execute("UPDATE owner_live_stops SET state='released'", [])
                .map_err(write_sql)?;
            Ok::<_, OwnerOutboxError>(())
        })
        .unwrap();
    let removed = store
        .write_with(&NoFaults, |tx| {
            prefix::cleanup_session_page_in_tx(tx, &observed.binding)
        })
        .unwrap();
    assert!(matches!(removed, TxnOutcome::Committed(1)));
    assert!(matches!(
        store
            .write_with(&NoFaults, |tx| prefix::cleanup_session_page_in_tx(
                tx,
                &observed.binding
            ))
            .unwrap(),
        TxnOutcome::Committed(0)
    ));
}

fn seal_prefix(store: &mut EngineStore, observed: &ObservedOwnerBinding) {
    store
        .write_with(&NoFaults, |tx| {
            super::super::release::request_in_tx(tx, &key(&observed.binding)?, 4)?;
            prefix::seal_in_tx(tx, &observed.binding, &"c".repeat(64), 0, 5)
        })
        .unwrap();
}

fn prefix_queue(
    count: usize,
) -> (
    ScratchDir,
    EngineStore,
    ObservedOwnerBinding,
    Ydoc,
    Vec<OwnerDraftAppendInput>,
    String,
) {
    let (dir, mut store, observed, checkpoint) = fixture();
    install(&mut store, &observed, &checkpoint);
    let doc = Ydoc::wire();
    doc.apply(&checkpoint).unwrap();
    let mut cache = crate::WriterDocCache::default();
    let mut inputs = Vec::new();
    let mut outbox = String::new();
    for i in 0..count {
        let input = OwnerDraftAppendInput {
            person_edit: i % 2 == 0,
            binding: observed.binding.clone(),
            expected_revision: 1,
            append_key: format!("prefix-{i}"),
            update: if count > 1 && i == count / 2 {
                doc.rewrite_content_to_markdown(crate::ContentKind::Richdoc, "a credited delete")
                    .unwrap()
            } else {
                doc.richdoc_append_paragraph(&format!("entry {i}"))
            },
            now_ms: 3,
            agent_declaration: (i % 2 == 1).then(|| AgentDeclaration {
                agent_id: format!("agent-{i}"),
                on_behalf_of: Some("person".into()),
                depth: 2,
            }),
            automation_declaration: None,
        };
        outbox = append_draft_cached(
            &mut store,
            &mut cache,
            "workspace",
            input.clone(),
            &NoFaults,
        )
        .unwrap()
        .outbox_id;
        inputs.push(input);
    }
    seal_prefix(&mut store, &observed);
    (dir, store, observed, doc, inputs, outbox)
}

fn prefix_turn(
    store: &mut EngineStore,
    cache: &mut crate::WriterDocCache,
    observed: &ObservedOwnerBinding,
) -> prefix::PrefixProgress {
    match prefix::commit_prefix(
        store,
        cache,
        &observed.binding,
        &"c".repeat(64),
        6,
        &NoFaults,
        |tx, _, _, _| prefix::test_publication(tx, &observed.binding),
    )
    .unwrap()
    {
        TxnOutcome::Committed(p) => p,
        _ => panic!("unexpected crash"),
    }
}

#[test]
fn prefix_oversized_original_runs_alone_and_keeps_consumed_write_status() {
    let (_dir, mut store, observed, checkpoint) = fixture();
    install(&mut store, &observed, &checkpoint);
    let doc = Ydoc::wire();
    doc.apply(&checkpoint).unwrap();
    let mut cache = crate::WriterDocCache::new();
    let mut writes = Vec::new();
    for (i, text) in ["x".repeat(8192), "small".into()].into_iter().enumerate() {
        let input = OwnerDraftAppendInput {
            person_edit: true,
            binding: observed.binding.clone(),
            expected_revision: 1,
            append_key: format!("large-{i}"),
            update: doc.richdoc_append_paragraph(&text),
            now_ms: 3,
            agent_declaration: None,
            automation_declaration: None,
        };
        let append = append_draft_cached(
            &mut store,
            &mut cache,
            "workspace",
            input.clone(),
            &NoFaults,
        )
        .unwrap();
        writes.push(OwnerDraftWrite {
            outbox_id: Some(append.outbox_id),
            binding: observed.binding.clone(),
            native_head_sequence: observed.native_head_sequence,
            append_key: input.append_key,
        });
    }
    seal_prefix(&mut store, &observed);
    assert_eq!(
        prefix_turn(&mut store, &mut cache, &observed).consumed_entries,
        1
    );
    assert_eq!(
        store
            .read_with(|c| write_states_in(c, "workspace", &writes))
            .unwrap(),
        ["settled", "pending"]
    );
    assert_eq!(
        prefix_turn(&mut store, &mut cache, &observed).consumed_entries,
        2
    );
}

#[test]
fn prefix_draining_recomputes_capacity_and_ignores_only_the_age_seal() {
    let (_dir, mut store, observed, doc, _, outbox) = prefix_queue(2);
    store
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "UPDATE owner_ydoc_outboxes SET state='sealed' WHERE outbox_id=?1",
                [&outbox],
            )
            .map_err(write_sql)?;
            Ok::<_, OwnerOutboxError>(())
        })
        .unwrap();
    let mut cache = crate::WriterDocCache::new();
    prefix_turn(&mut store, &mut cache, &observed);
    let remaining:(String,Option<i64>,i64) = store.read_with(|c|c.query_row("SELECT state,oldest_entry_at_ms,pending_bytes FROM owner_ydoc_outboxes WHERE outbox_id=?1",[&outbox],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?)))).unwrap();
    assert_eq!(remaining, ("active".into(), None, 0));
    let input = OwnerDraftAppendInput {
        person_edit: true,
        binding: observed.binding.clone(),
        expected_revision: 1,
        append_key: "after-drain".into(),
        update: doc.richdoc_append_paragraph("late append"),
        now_ms: 100_000,
        agent_declaration: None,
        automation_declaration: None,
    };
    append_draft_cached(&mut store, &mut cache, "workspace", input, &NoFaults).unwrap();
    let input = OwnerDraftAppendInput {
        person_edit: true,
        binding: observed.binding.clone(),
        expected_revision: 1,
        append_key: "after-age".into(),
        update: doc.richdoc_append_paragraph("after age"),
        now_ms: 200_000,
        agent_declaration: None,
        automation_declaration: None,
    };
    append_draft_cached(&mut store, &mut cache, "workspace", input, &NoFaults).unwrap();
    assert_eq!(
        store
            .read_with(|c| read_parent(c, &outbox))
            .unwrap()
            .unwrap()
            .state,
        OwnerOutboxState::Active
    );
}

#[test]
fn prefix_restarts_preserve_every_chunk_union_credit_and_warm_compaction() {
    let (dir, mut store, observed, expected, inputs, _) = prefix_queue(97);
    let key = key(&observed.binding).unwrap();
    let mut cache = crate::WriterDocCache::default();
    let mut consumed = 0;
    while consumed < inputs.len() {
        let before = consumed;
        consumed = prefix_turn(&mut store, &mut cache, &observed).consumed_entries as usize;
        assert!(consumed > before && consumed - before <= 32);
        assert_eq!(
            store
                .read_with(|c| open_draft_in(c, &observed.binding, 1).map(|d| d
                    .doc
                    .project(crate::ContentKind::Richdoc)
                    .unwrap()
                    .content))
                .unwrap(),
            expected
                .project(crate::ContentKind::Richdoc)
                .unwrap()
                .content
        );
        assert!(
            store
                .read_with(|c| super::super::accepted::read_state_in(c, &observed.binding, "relay"))
                .is_err()
        );
        prefix::compact_prefix(&mut store, &mut cache, &observed.binding, &NoFaults, 7).unwrap();
        assert_eq!(store.table_row_count("ydoc_updates").unwrap(), 0);
        drop(store);
        store = EngineStore::open(&dir.join("engine.db"), 8).unwrap();
        cache = Default::default();
        let progress = store
            .read_with(|c| prefix::progress_in(c, &key))
            .unwrap()
            .unwrap();
        assert_eq!(progress.consumed_entries, consumed as i64);
        assert_eq!(
            store.table_row_count("owner_prefix_consumed").unwrap(),
            consumed as i64
        );
    }
    let authors = store
        .read_with(|c| crate::author_coverage::interval_in(c, &key, i64::MAX))
        .unwrap()
        .json();
    assert!(authors.contains("local-person") && authors.contains("agent-95"));
    let native = crate::load_persisted(&store, &key).unwrap().unwrap();
    assert_eq!(
        native
            .doc
            .project(crate::ContentKind::Richdoc)
            .unwrap()
            .content,
        expected
            .project(crate::ContentKind::Richdoc)
            .unwrap()
            .content
    );
}

#[test]
fn prefix_cache_commit_keeps_the_union_and_refreshes_its_effective_head() {
    let (_dir, mut store, observed, expected, _, _) = prefix_queue(65);
    let mut cache = crate::WriterDocCache::new();
    let initial = open_draft_cached(&store, &mut cache, &observed.binding, 1).unwrap();
    let progress = prefix_turn(&mut store, &mut cache, &observed);
    let warm = open_draft_cached(&store, &mut cache, &observed.binding, 1).unwrap();
    assert_eq!(warm.initial_update, initial.initial_update);
    assert_eq!(
        warm.descriptor.native_head_sequence,
        observed.native_head_sequence + progress.consumed_entries
    );
    assert!(
        prefix::commit_prefix(
            &mut store,
            &mut cache,
            &observed.binding,
            &"c".repeat(64),
            7,
            &NoFaults,
            |_, _, _, _| Err(CollabError::MissingDependencies)
        )
        .is_err()
    );
    let recovered = open_draft_cached(&store, &mut cache, &observed.binding, 1).unwrap();
    let doc = Ydoc::wire();
    doc.apply(&recovered.initial_update).unwrap();
    assert_eq!(
        doc.project(crate::ContentKind::Richdoc).unwrap().content,
        expected
            .project(crate::ContentKind::Richdoc)
            .unwrap()
            .content
    );
    assert_eq!(
        recovered.descriptor.native_head_sequence,
        observed.native_head_sequence + progress.consumed_entries
    );
}

#[test]
fn prefix_transaction_refusal_discards_mutated_cache_and_retries_exactly() {
    let (_dir, mut store, observed, _, _, _) = prefix_queue(70);
    let key = key(&observed.binding).unwrap();
    let mut cache = crate::WriterDocCache::default();
    let first = prefix_turn(&mut store, &mut cache, &observed);
    let failure = prefix::commit_prefix(
        &mut store,
        &mut cache,
        &observed.binding,
        &"c".repeat(64),
        6,
        &NoFaults,
        |_, _, _, _| Err(CollabError::MissingDependencies),
    );
    assert!(failure.is_err());
    assert!(
        store
            .read_with(|c| cache.doc_for_consumer(c, &key))
            .unwrap()
            .is_none()
    );
    assert_eq!(
        store
            .read_with(|c| prefix::progress_in(c, &key))
            .unwrap()
            .unwrap()
            .consumed_entries,
        first.consumed_entries
    );
    let retry = prefix_turn(&mut store, &mut cache, &observed);
    assert_eq!(retry.consumed_entries, first.consumed_entries + 32);
}

#[test]
fn prefix_bad_credit_leaves_original_rows_and_native_head_unchanged() {
    let (_dir, mut store, observed, _, _, _) = prefix_queue(2);
    let key = key(&observed.binding).unwrap();
    store.write_with(&NoFaults,|tx| {
        tx.execute("UPDATE owner_ydoc_outbox_entries SET agent_declaration_json='{\"agentId\":\"\",\"onBehalfOf\":null,\"depth\":2}' WHERE sequence=1",[]).map_err(write_sql)?;
        Ok::<_,OwnerOutboxError>(())
    }).unwrap();
    assert!(
        prefix::commit_prefix(
            &mut store,
            &mut Default::default(),
            &observed.binding,
            &"c".repeat(64),
            6,
            &NoFaults,
            |_, _, _, _| panic!("invalid credit must precede journal")
        )
        .is_err()
    );
    assert_eq!(
        crate::read_marker(&store, &key)
            .unwrap()
            .unwrap()
            .head_update_seq,
        observed.native_head_sequence
    );
    assert_eq!(store.table_row_count("owner_prefix_consumed").unwrap(), 0);
    assert_eq!(
        store.table_row_count("owner_ydoc_outbox_entries").unwrap(),
        2
    );
}

#[test]
fn prefix_keeps_automation_and_unattributed_original_credit() {
    let (_dir, mut store, observed, checkpoint) = fixture();
    install(&mut store, &observed, &checkpoint);
    let doc = Ydoc::wire();
    doc.apply(&checkpoint).unwrap();
    let automation = dohc_engine_domain::AutomationDeclaration {
        automation_id: "collection:Tasks#mark".into(),
        attribution: dohc_engine_domain::ChangeAttribution {
            actor_kind: dohc_engine_domain::ChangeActorKind::Automation,
            on_behalf_of: Some("presser".into()),
            depth: 1,
            run: Some(dohc_engine_domain::AutomationRunAttribution {
                claim_id: "claim".into(),
                automation_name: "Mark done".into(),
            }),
        },
    };
    let mut cache = crate::WriterDocCache::new();
    for i in 0..2 {
        append_draft_cached(
            &mut store,
            &mut cache,
            "workspace",
            OwnerDraftAppendInput {
                binding: observed.binding.clone(),
                expected_revision: 1,
                append_key: format!("credit-{i}"),
                update: doc.richdoc_append_paragraph(&format!("credit {i}")),
                now_ms: 3,
                person_edit: false,
                agent_declaration: None,
                automation_declaration: (i == 0).then(|| automation.clone()),
            },
            &NoFaults,
        )
        .unwrap();
    }
    seal_prefix(&mut store, &observed);
    let mut credits = Vec::new();
    prefix::commit_prefix(
        &mut store,
        &mut cache,
        &observed.binding,
        &"c".repeat(64),
        6,
        &NoFaults,
        |tx, _, actor, attribution| {
            credits.push((actor.map(str::to_owned), attribution.cloned()));
            prefix::test_publication(tx, &observed.binding)
        },
    )
    .unwrap();
    assert_eq!(
        credits,
        [
            (Some(automation.automation_id), Some(automation.attribution)),
            (None, None)
        ]
    );
}

#[test]
fn prefix_native_source_rejects_partial_credit_before_append() {
    let (_dir, mut store, observed, _, inputs, _) = prefix_queue(1);
    let source = super::super::OwnerOutboxNativeSource {
        binding: observed.binding.clone(),
        adoption_id: "credit".into(),
        native_sequence: 1,
        update_digest: hex_sha256(&inputs[0].update),
        origin: super::super::OwnerOutboxNativeOrigin::NativeUpdate {
            actor_origin_id: Some("agent".into()),
            actor_kind: None,
            on_behalf_of: Some("person".into()),
            chain_depth: Some(2),
            recorded_at_ms: 3,
        },
    };
    store
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "UPDATE owner_ydoc_outbox_entries SET native_source_json=?1,draft_binding_revision=NULL",
                [serde_json::to_string(&source).unwrap()],
            )
            .map_err(write_sql)?;
            Ok::<_, OwnerOutboxError>(())
        })
        .unwrap();
    assert!(
        prefix::commit_prefix(
            &mut store,
            &mut Default::default(),
            &observed.binding,
            &"c".repeat(64),
            6,
            &NoFaults,
            |_, _, _, _| panic!("partial native credit must precede journal")
        )
        .is_err()
    );
    assert_eq!(store.table_row_count("owner_prefix_consumed").unwrap(), 0);
}

#[test]
fn prefix_seal_accepts_an_authenticated_successor_and_refuses_restore_fenced_work() {
    for generation in [0, 1] {
        let (_dir, mut store, mut observed, checkpoint) = fixture();
        observed.binding.restore_fence_generation = generation;
        install(&mut store, &observed, &checkpoint);
        let doc = Ydoc::wire();
        doc.apply(&checkpoint).unwrap();
        let input = OwnerDraftAppendInput {
            person_edit: true,
            binding: observed.binding.clone(),
            expected_revision: 1,
            append_key: "generation-edit".into(),
            update: doc.richdoc_append_paragraph("generation edit"),
            now_ms: 3,
            agent_declaration: None,
            automation_declaration: None,
        };
        append_draft_cached(
            &mut store,
            &mut Default::default(),
            "workspace",
            input.clone(),
            &NoFaults,
        )
        .unwrap();
        seal_prefix(&mut store, &observed);
        assert_eq!(
            prefix_turn(&mut store, &mut Default::default(), &observed).consumed_entries,
            1
        );
        let mut stale = input;
        stale.binding.restore_fence_generation = generation + 1;
        let outbox = store
            .read_with(|c| find_parent_for_binding(c, &observed.binding))
            .unwrap()
            .unwrap()
            .outbox_id;
        assert!(
            store
                .write_with(&NoFaults, |tx| prefix::append_old_session_in_tx(
                    tx,
                    &outbox,
                    &stale,
                    |_, _, _, _, _| panic!()
                ))
                .is_err()
        );
    }
    let (_dir, mut store, observed, _, _, _) = prefix_queue(1);
    let key = key(&observed.binding).unwrap();
    store.write_with(&NoFaults,|tx|{
        super::super::release::clear_in_tx(tx,&key)?;
        tx.execute("UPDATE owner_ydoc_outboxes SET state='quarantined',quarantine_reason='restore-fenced'",[]).map_err(write_sql)?;
        super::super::release::request_in_tx(tx,&key,9)
    }).unwrap();
    assert!(matches!(
        store.write_with(&NoFaults, |tx| prefix::seal_in_tx(
            tx,
            &observed.binding,
            &"c".repeat(64),
            0,
            10
        )),
        Err(OwnerOutboxError::RestorePending)
    ));
}

#[test]
fn prefix_warm_compaction_crashes_resume_the_exact_committed_union() {
    for point in [
        dohc_engine_storage::FaultPoint::StorageBeforePersist,
        dohc_engine_storage::FaultPoint::StorageAfterCommitBeforeAck,
    ] {
        let (dir, mut store, observed, expected, _, _) = prefix_queue(40);
        let mut cache = crate::WriterDocCache::new();
        prefix_turn(&mut store, &mut cache, &observed);
        let faults = dohc_engine_testkit::ScriptedFaults::crash_at(point);
        assert!(matches!(
            prefix::compact_prefix(
                &mut store,
                &mut cache,
                &observed.binding,
                faults.as_ref(),
                7
            )
            .unwrap(),
            TxnOutcome::Crashed { .. }
        ));
        drop(store);
        store = EngineStore::open(&dir.join("engine.db"), 8).unwrap();
        cache = Default::default();
        assert_eq!(
            prefix_turn(&mut store, &mut cache, &observed).consumed_entries,
            40
        );
        assert_eq!(
            store
                .read_with(|c| open_draft_in(c, &observed.binding, 1).map(|d| d
                    .doc
                    .project(crate::ContentKind::Richdoc)
                    .unwrap()
                    .content))
                .unwrap(),
            expected
                .project(crate::ContentKind::Richdoc)
                .unwrap()
                .content
        );
    }
}

#[test]
fn prefix_late_session_keys_are_scoped_idempotent_and_expire_with_cleanup() {
    let (_dir, mut store, observed, doc, inputs, outbox) = prefix_queue(1);
    let key = key(&observed.binding).unwrap();
    let mut cache = Default::default();
    prefix_turn(&mut store, &mut cache, &observed);
    let duplicate = store
        .write_with(&NoFaults, |tx| {
            prefix::append_old_session_in_tx(tx, &outbox, &inputs[0], |_, _, _, _, _| {
                panic!("duplicate must not append")
            })
        })
        .unwrap();
    assert!(matches!(duplicate, TxnOutcome::Committed(Some(_))));
    store
        .write_with(&NoFaults, |tx| {
            tx.execute("DELETE FROM ydoc_owner_bindings", [])
                .map_err(write_sql)?;
            tx.execute("UPDATE owner_live_stops SET state='released'", [])
                .map_err(write_sql)?;
            Ok::<_, OwnerOutboxError>(())
        })
        .unwrap();
    let mut late = inputs[0].clone();
    late.append_key = "late".into();
    late.update = doc.richdoc_append_paragraph("late person edit");
    let apply = |tx: &rusqlite::Transaction<'_>,
                 bytes: &[u8],
                 actor: Option<&str>,
                 attribution: Option<&dohc_engine_domain::ChangeAttribution>,
                 _: &str| {
        crate::record_update_in_tx(tx, &key, bytes, actor, attribution, 8).map(|a| a.seq)
    };
    let first = store
        .write_with(&NoFaults, |tx| {
            prefix::append_old_session_in_tx(tx, &outbox, &late, apply)
        })
        .unwrap();
    let retry = store
        .write_with(&NoFaults, |tx| {
            prefix::append_old_session_in_tx(tx, &outbox, &late, |_, _, _, _, _| {
                panic!("retry must not append")
            })
        })
        .unwrap();
    assert_eq!(format!("{first:?}"), format!("{retry:?}"));
    store
        .write_with(&NoFaults, |tx| {
            prefix::cleanup_session_page_in_tx(tx, &observed.binding)
        })
        .unwrap();
    assert_eq!(store.table_row_count("owner_ydoc_outboxes").unwrap(), 0);
    let write = OwnerDraftWrite {
        outbox_id: Some(outbox.clone()),
        binding: observed.binding.clone(),
        native_head_sequence: observed.native_head_sequence,
        append_key: inputs[0].append_key.clone(),
    };
    assert_eq!(
        store
            .read_with(|c| write_states_in(c, "workspace", &[write]))
            .unwrap(),
        ["settled"]
    );
    late.append_key = "after-session-cleanup".into();
    late.update = doc.richdoc_append_paragraph("after session cleanup");
    store
        .write_with(&NoFaults, |tx| {
            prefix::append_old_session_in_tx(tx, &outbox, &late, apply)
        })
        .unwrap();
    store
        .write_with(&NoFaults, |tx| {
            prefix::close_consumed_in_tx(tx, &key, &outbox, 9)?;
            prefix::cleanup_consumed_in_tx(tx, &key, &outbox)
        })
        .unwrap();
    assert!(
        store
            .write_with(&NoFaults, |tx| prefix::append_old_session_in_tx(
                tx,
                &outbox,
                &late,
                |_, _, _, _, _| panic!("closed session must refuse")
            ))
            .is_err()
    );
}

#[test]
fn prefix_narrow_delivery_results_leave_the_tail_pending() {
    let (_dir, mut store, observed, _, inputs, outbox) = prefix_queue(40);
    let before = store.table_row_count("owner_ydoc_outbox_entries").unwrap();
    let receipt = OwnerDeliveryReceipt {
        delivery_id: "unknown".into(),
        update_digest: hex_sha256(&inputs[0].update),
        journal_cursor: 1,
        accepting_host_epoch: 1,
    };
    assert!(matches!(
        store
            .read_with(|c| super::super::accepted::receipt_state_in(
                c,
                &observed.binding,
                "relay",
                &receipt
            ))
            .unwrap(),
        super::super::accepted::ReceiptState::Stopping
    ));
    assert!(matches!(
        store.read_with(|c| super::super::enrollment::prepare_in(
            c,
            &observed.binding,
            "relay",
            false
        )),
        Err(OwnerOutboxError::Stopping)
    ));
    let frame = super::super::accepted::OwnerAcceptedFrameInput {
        binding: observed.binding.clone(),
        relay_database_namespace: "relay".into(),
        expected_revision: 1,
        expected_native_head_sequence: observed.native_head_sequence,
        previous_accepted_cursor: 0,
        journal_cursor: 1,
        update_bytes: inputs[0].update.clone(),
    };
    assert!(matches!(
        store.write_with(&NoFaults, |tx| super::super::accepted::apply_frame_in_tx(
            tx,
            "workspace",
            &frame,
            8
        )),
        Err(OwnerOutboxError::Stopping)
    ));
    assert!(matches!(
        store.write_with(&NoFaults, |tx| super::super::accepted::apply_sync_in_tx(
            tx,
            "workspace",
            &frame,
            &[0],
            8
        )),
        Err(OwnerOutboxError::Stopping)
    ));
    let refusal = OwnerOutboxRefuseInput {
        outbox_id: outbox,
        delivery_id: receipt.delivery_id,
        update_digest: receipt.update_digest,
        reason: "Not accepted".into(),
    };
    assert!(matches!(
        store.write_with(&NoFaults, |tx| super::super::refuse_entry_in_tx(
            tx,
            "workspace",
            &refusal,
            8
        )),
        Err(OwnerOutboxError::Stopping)
    ));
    assert_eq!(
        store.table_row_count("owner_ydoc_outbox_entries").unwrap(),
        before
    );
    let enrollment = super::super::enrollment::OwnerEnrollmentInput {
        binding: observed.binding.clone(),
        relay_database_namespace: "relay".into(),
        captured: super::super::enrollment::OwnerEnrollmentCapture {
            native_head_sequence: observed.native_head_sequence,
            local_state_digest: observed.checkpoint_digest.clone(),
        },
        journal_cursor: 1,
        checkpoint: vec![0, 0],
        host_vector: vec![0],
        recovery: false,
    };
    assert!(matches!(
        store.write_with(&NoFaults, |tx| super::super::enrollment::enroll_in_tx(
            tx,
            "workspace",
            &enrollment,
            &observed.limits,
            8
        )),
        Err(OwnerOutboxError::Stopping)
    ));
}

#[test]
fn prefix_consumed_cleanup_is_bounded_and_generation_changes_refuse_late_edits() {
    let (_dir, mut store, observed, _, inputs, outbox) = prefix_queue(130);
    let key = key(&observed.binding).unwrap();
    let mut cache = Default::default();
    while store.table_row_count("owner_prefix_consumed").unwrap() < 130 {
        prefix_turn(&mut store, &mut cache, &observed);
    }
    store
        .write_with(&NoFaults, |tx| {
            tx.execute("UPDATE ydoc_docs SET lineage_claim_status='unclaimed',lineage_claim_id=NULL,lineage_parent_claim_id=NULL,lineage_epoch_tag=NULL", [])
                .map_err(write_sql)?;
            Ok::<_, OwnerOutboxError>(())
        })
        .unwrap();
    assert!(
        store
            .write_with(&NoFaults, |tx| prefix::append_old_session_in_tx(
                tx,
                &outbox,
                &inputs[0],
                |_, _, _, _, _| panic!()
            ))
            .is_err()
    );
    for remaining in [66, 2, 0] {
        store
            .write_with(&NoFaults, |tx| {
                prefix::close_consumed_in_tx(tx, &key, &outbox, 9)?;
                prefix::cleanup_consumed_in_tx(tx, &key, &outbox)
            })
            .unwrap();
        assert_eq!(
            store.table_row_count("owner_prefix_consumed").unwrap(),
            remaining
        );
    }
}

#[test]
fn prefix_union_includes_quarantined_non_parent_work_and_bumps_revision_only_for_pending_work() {
    for pending in [false, true] {
        let (_dir, mut store, observed, expected, _, outbox) = prefix_queue(1);
        let key = key(&observed.binding).unwrap();
        store.write_with(&NoFaults,|tx|{
            super::super::release::clear_in_tx(tx,&key)?;
            if !pending {tx.execute("DELETE FROM owner_ydoc_outbox_entries",[]).map_err(write_sql)?;tx.execute("UPDATE owner_ydoc_outboxes SET pending_bytes=0,oldest_entry_at_ms=NULL",[]).map_err(write_sql)?;}
            tx.execute("UPDATE owner_ydoc_outboxes SET current_path='old.md',selector_paths_json='[\"old.md\"]',state='quarantined',quarantine_reason='binding-changed' WHERE outbox_id=?1",[outbox]).map_err(write_sql)?;
            super::super::release::request_in_tx(tx,&key,9)?;
            prefix::seal_in_tx(tx,&observed.binding,&"d".repeat(64),0,10)
        }).unwrap();
        let revision = store
            .read_with(|c| prefix::effective_in(c, &observed.binding))
            .unwrap()
            .revision;
        assert_eq!(revision, if pending { 2 } else { 1 });
        if pending {
            assert!(
                store
                    .read_with(|c| open_draft_in(c, &observed.binding, 1))
                    .is_err()
            );
            let before = store
                .read_with(|c| open_draft_in(c, &observed.binding, 2))
                .unwrap();
            assert_eq!(
                before
                    .doc
                    .project(crate::ContentKind::Richdoc)
                    .unwrap()
                    .content,
                expected
                    .project(crate::ContentKind::Richdoc)
                    .unwrap()
                    .content
            );
            prefix::commit_prefix(
                &mut store,
                &mut Default::default(),
                &observed.binding,
                &"d".repeat(64),
                11,
                &NoFaults,
                |tx, _, _, _| prefix::test_publication(tx, &observed.binding),
            )
            .unwrap();
            let after = store
                .read_with(|c| open_draft_in(c, &observed.binding, 2))
                .unwrap();
            assert_eq!(
                after
                    .doc
                    .project(crate::ContentKind::Richdoc)
                    .unwrap()
                    .content,
                before
                    .doc
                    .project(crate::ContentKind::Richdoc)
                    .unwrap()
                    .content
            );
        }
    }
}

#[test]
fn prefix_folded_retry_cannot_change_its_base() {
    let (_dir, mut store, observed, _, inputs, _) = prefix_queue(40);
    let mut cache = crate::WriterDocCache::new();
    prefix_turn(&mut store, &mut cache, &observed);
    let before = store.table_row_count("owner_ydoc_outbox_entries").unwrap();
    let result = store.write_with(&NoFaults, |tx| {
        super::super::append_with_retained_base(
            tx,
            "workspace",
            super::super::OwnerOutboxAppendInput {
                binding: observed.binding.clone(),
                base_update: vec![1, 2, 3],
                append_key: inputs[0].append_key.clone(),
                update: inputs[0].update.clone(),
                limits: observed.limits.clone(),
                created_at_ms: 20,
            },
            None,
            Some(observed.revision),
            None,
            None,
            true,
        )
    });
    assert!(
        matches!(result, Err(OwnerOutboxError::ParentMismatch)),
        "{result:?}"
    );
    assert_eq!(
        store.table_row_count("owner_ydoc_outbox_entries").unwrap(),
        before
    );
    assert_eq!(
        prefix_turn(&mut store, &mut cache, &observed).consumed_entries,
        40
    );
}
